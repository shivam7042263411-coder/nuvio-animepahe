// The part of the harvester that runs INSIDE the AnimePahe page, so every
// request carries the page's own Cloudflare clearance. Returns JSON only.
//
// Kept in its own module because it is browser code: it can be syntax-checked
// and unit-tested from Node without launching Chrome.

/** Search-hit ranking. Relevance first, episode count second: sorting by
 *  episodes alone picked "Naruto Shippuden" (500) for the term "Naruto", while
 *  sorting by index alone picked a 1-episode special for "Haikyuu". */
export function rankHits(term, pool) {
  const key = (v) =>
    String(v || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/(.)\1+/g, '$1');
  const tk = key(term);
  return pool
    .map((h) => {
      const hk = key(h.title);
      const relevance = hk === tk ? 2 : hk.indexOf(tk + ' ') === 0 ? 1 : 0;
      return { h, relevance, eps: Number(h.episodes) || 0 };
    })
    .sort((a, b) => b.relevance - a.relevance || b.eps - a.eps)
    .map((x) => x.h);
}

export function harvestScript(show) {
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const term = ${JSON.stringify(show.term)};
  const maxEps = ${show.maxEps};
  const resultIndex = ${show.resultIndex};
  const season = ${show.season};
  const offset = ${show.offset};
  const rank = ${rankHits.toString()};

  const s = await fetch('/api?m=search&l=8&q=' + encodeURIComponent(term))
    .then((r) => r.json())
    .catch(() => null);
  if (!s) return { error: 'challenge' };
  const pool = s.data || [];
  const hit = resultIndex >= 0 ? pool[resultIndex] : rank(term, pool)[0];
  if (!hit) return { error: 'no search result for ' + term };

  const rows = [];
  const seenEps = new Set();
  for (let page = 1; page <= 20; page++) {
    const j = await fetch('/api?m=release&id=' + hit.session + '&sort=episode_asc&page=' + page)
      .then((r) => r.json())
      .catch(() => null);
    if (!j) return { error: 'challenge' };
    for (const e of j.data || []) {
      const ep = Number(e.episode);
      if (!Number.isFinite(ep) || seenEps.has(ep)) continue;
      if (seenEps.size >= maxEps) break;
      seenEps.add(ep);
      const html = await fetch('/play/' + hit.session + '/' + e.session).then((r) => r.text());
      // One challenge is the signal to stop the whole batch, not skip a show.
      if (/just a moment|attention required|cf-error-details/i.test(html)) return { error: 'challenge' };
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('#resolutionMenu button').forEach((b) => {
        const id = (b.dataset.src || '').match(/\\/e\\/([A-Za-z0-9]+)/);
        if (!id) return;
        const q = Number((b.textContent.match(/(\\d{3,4})p/) || [])[1] || 0);
        const a = /eng|dub/i.test((b.dataset.audio || '') + b.textContent) ? 'dub' : 'sub';
        rows.push({ s: season, e: ep - offset, q, a, id: id[1] });
      });
      await sleep(600);
    }
    if (seenEps.size >= maxEps || page >= (j.last_page || 1)) break;
  }
  return {
    show: { title: hit.title, session: hit.session, year: hit.year, episodes: hit.episodes },
    rows,
  };
})()`;
}