// The part of the harvester that runs INSIDE the AnimePahe page, so every
// request carries the page's own Cloudflare clearance. Returns JSON only.
//
// Kept in its own module because it is browser code: it can be syntax-checked
// and unit-tested from Node without launching Chrome.

/** Search-hit ranking. The site's own order is relevance order, so it is kept;
 *  a folded exact-title match wins over it. Episode count is never used: it
 *  picked "Naruto Shippuden" (500) for "Naruto" and a spin-off for "KonoSuba". */
export function rankHits(term, pool) {
  const key = (v) =>
    String(v || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/(.)\1+/g, '$1');
  const tk = key(term);
  return pool
    .map((h, i) => ({ h, i, exact: key(h.title) === tk ? 1 : 0 }))
    .sort((a, b) => b.exact - a.exact || a.i - b.i)
    .map((x) => x.h);
}

/** Which app season(s) a search hit belongs to.
 *
 *  The app asks by season, so every row must be filed under the season the app
 *  will ask for. The site names seasons in the title ("2nd Season", "Season 2")
 *  and split cours as parts ("Part 2"). A hit that only *starts* with the show
 *  name and carries no season or part marker is a sequel or spin-off whose
 *  season cannot be known ("X: will+Dress", "X The Final Season") - it is
 *  skipped, because a wrong season is worse than a miss.
 *
 *  Entries of one season are returned in part order, so their episodes can be
 *  numbered consecutively (the app's own split-cour behaviour).
 */
export const fold = (v) =>
  String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/(.)\1+/g, '$1');

export function classifyHits(term, pool) {
  const base = fold(term);
  const label = (title) => {
    const n = fold(title);
    let m = n.match(/\b(\d+)(?:st|nd|rd|th) season\b/) || n.match(/\bseason (\d+)\b/);
    const season = m ? parseInt(m[1], 10) : null;
    m =
      n.match(/\b(\d+)(?:st|nd|rd|th) (?:part|cour)\b/) ||
      n.match(/\b(?:part|cour) (\d+)\b/);
    return { season, part: m ? parseInt(m[1], 10) : 1 };
  };

  const plans = [];
  let current = 0;
  for (const h of pool) {
    const hk = fold(h.title);
    if (!hk) continue;
    const { season, part } = label(h.title);
    const isBase = hk === base;
    if (!isBase && hk.indexOf(base + ' ') !== 0) continue;
    if (season) {
      current = season;
      plans.push({ session: h.session, title: h.title, year: h.year, episodes: h.episodes, season, part });
    } else if (isBase) {
      // The plain show is season 1 even when a sequel appeared earlier in the
      // pool; a marker on its own title wins (handled above).
      current = 1;
      plans.push({ session: h.session, title: h.title, year: h.year, episodes: h.episodes, season: 1, part });
    } else if (part > 1 && current) {
      // "Spy x Family Part 2" continues the season of the entry before it.
      plans.push({ session: h.session, title: h.title, year: h.year, episodes: h.episodes, season: current, part });
    }
  }
  // Part order inside a season, seasons ascending. Sorting is stable, so equal
  // entries keep the site's relevance order.
  return plans.sort((a, b) => a.season - b.season || a.part - b.part);
}

/** File site entries into seasons the way the app counts them, using TMDB as
 *  the oracle instead of the entry's name. A season can be called anything
 *  ("Culling Game", "The Final Season", "Mugen Train Arc"), so a name is only
 *  a hint; the size of the season decides.
 *
 *  Entries are consumed in release order, filling TMDB's seasons in ascending
 *  order. A season is accepted only when whole entries cover it exactly (a
 *  split cour is two entries that add up), because a misfiled season plays the
 *  wrong episode forever while a miss costs one scrape.
 *
 *  `entries` must already be the franchise's own entries, sorted by year then
 *  part. Returns [{season, year, parts: [{...entry, part}]}]. */
export function planSeasons(entries, seasons) {
  const plans = [];
  let i = 0;

  for (const season of seasons) {
    let room = Number(season.episodes) || 0;
    if (!room) continue;
    const parts = [];
    const from = i;

    while (i < entries.length && room > 0) {
      const e = entries[i];
      if (isSpecialTitle(e.title)) {
        i++;
        continue;
      }
      // The entry's own season word is not a boundary: TMDB decides where the
      // app's seasons split, and the two disagree ("Season 3 Part 2" episodes
      // live in TMDB's season 4, and all of JJK sits in one season there).
      const count = Number(e.episodes) || 0;
      if (!count || count > room) break;
      parts.push({ ...e, part: partOf(e.title) });
      room -= count;
      i++;
    }

    if (room === 0 && parts.length) {
      plans.push({ season: Number(season.n), year: season.year, parts });
    } else {
      // Wrong shape: leave these entries for the next season to try. Nothing is
      // guessed, and the caller reports them as not filed.
      i = from;
    }
  }
  return plans;
}

/** The franchise's own entries, in release order: the plain title plus anything
 *  that starts with it ("Jujutsu Kaisen: Culling Game"). One-episode entries are
 *  movies/specials when the franchise has real episodes, and would otherwise be
 *  counted as part of a season. */
export function franchiseOf(term, pool) {
  const base = fold(term);
  const own = pool.filter((h) => {
    const hk = fold(h.title);
    return hk && (hk === base || hk.indexOf(base + ' ') === 0);
  });
  own.sort((a, b) => {
    const ya = Number(a.year) || 9999;
    const yb = Number(b.year) || 9999;
    return ya - yb || partOf(a.title) - partOf(b.title);
  });
  const hasEpisodes = own.some((h) => Number(h.episodes) > 1);
  return hasEpisodes
    ? own.filter((h) => Number(h.episodes) > 1 || seasonMarkerOf(h.title) != null)
    : own;
}

/** Entries that share the show's name but were not filed into any season, so a
 *  missing season is visible in the log instead of silent. */
export function unfiledHits(term, pool, plans) {
  const used = new Set();
  for (const plan of plans) {
    for (const part of plan.parts || [plan]) used.add(fold(part.title));
  }
  return franchiseOf(term, pool)
    .filter((h) => !used.has(fold(h.title)))
    .map((h) => ({ title: h.title, year: h.year, episodes: h.episodes }));
}

/** The season an entry's own title names, if it names one. */
export function isSpecialTitle(title) {
  const n = fold(title);
  if (!n) return false;
  return /\b(?:ova|oad|specials?|recap|movie|pilot|picture drama)\b/.test(n) || /\bshort\b/.test(n);
}

/** The season an entry's own title names, if it names one. */
export function seasonMarkerOf(title) {
  const n = fold(title);
  const m = n.match(/\b(\d+)(?:st|nd|rd|th) season\b/) || n.match(/\bseason (\d+)\b/);
  return m ? parseInt(m[1], 10) : null;
}

/** Order inside a season: "Part 2" after "Part 1", "Final Season" last. */
export function partOf(title) {
  const n = fold(title);
  const m = n.match(/\b(?:part|cour) (\d+)\b/);
  if (m) return parseInt(m[1], 10);
  if (n.includes('final season') || n.includes('final chapter')) return 90;
  return 1;
}

/** The site may number a later season continuously: S2E1 listed as episode 26.
 *  An explicit offset always wins; otherwise an entry whose lowest episode is
 *  above 1 is treated as continuous, so its first episode becomes e=1. */
export function inferOffset(offset, episodes) {
  if (offset != null) return Number(offset);
  const first = Math.min(...episodes);
  return Number.isFinite(first) && first > 1 ? first - 1 : 0;
}

export function harvestScript(show) {
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const term = ${JSON.stringify(show.term)};
  const maxEps = ${show.maxEps};
  const resultIndex = ${show.resultIndex};
  const season = ${show.season};
  const offset = ${show.offset == null ? 'null' : Number(show.offset)};
  const allSeasons = ${show.allSeasons ? 'true' : 'false'};
  const have = ${JSON.stringify(show.haveEps || [])};
  const force = ${show.force ? 'true' : 'false'};
  const rank = ${rankHits.toString()};
  const fold = ${fold.toString()};
  const classifyHits = ${classifyHits.toString()};
  const classify = classifyHits;
  const isSpecialTitle = ${isSpecialTitle.toString()};
  const seasonMarkerOf = ${seasonMarkerOf.toString()};
  const partOf = ${partOf.toString()};
  const planSeasons = ${planSeasons.toString()};
  const franchiseOf = ${franchiseOf.toString()};
  const unfiledHits = ${unfiledHits.toString()};
  const inferOffset = ${inferOffset.toString()};
  // The app counts episodes by TMDB's seasons; when the caller supplied them,
  // size decides which season an entry is, not the entry's name.
  const tmdbSeasons = ${JSON.stringify(show.seasons || null)};

  const s = await fetch('/api?m=search&l=8&q=' + encodeURIComponent(term))
    .then((r) => r.json())
    .catch(() => null);
  if (!s) return { error: 'challenge' };
  const pool = s.data || [];

  let plans;
  let fallback = false;
  if (allSeasons) {
    plans = [];
    if (tmdbSeasons && tmdbSeasons.length) {
      // File by season size. An entry whose title never says "season 3" lands
      // there anyway when the episodes add up.
      for (const p of planSeasons(franchiseOf(term, pool), tmdbSeasons)) {
        for (const part of p.parts) plans.push({ ...part, season: p.season });
      }
      plans.sort((a, b) => a.season - b.season || a.part - b.part);
    }
    if (!plans.length) plans = classify(term, pool);
    // No labelled entry: fall back to the best hit as season 1, the same guess
    // a one-line harvest makes. Warn so a wrong guess is visible in the log.
    if (!plans.length) {
      const hit = resultIndex >= 0 ? pool[resultIndex] : rank(term, pool)[0];
      if (!hit) return { error: 'no search result for ' + term };
      fallback = true;
      plans = [{ session: hit.session, title: hit.title, year: hit.year, episodes: hit.episodes, season, part: 1 }];
    }
  } else {
    const hit = resultIndex >= 0 ? pool[resultIndex] : rank(term, pool)[0];
    if (!hit) return { error: 'no search result for ' + term };
    const lab = classify(term, [hit])[0];
    plans = [{ session: hit.session, title: hit.title, year: hit.year, episodes: hit.episodes, season: lab ? lab.season : season, part: 1 }];
  }

  const rows = [];
  const seasonBase = {};
  const seasonCounts = {};
  const ignored = allSeasons ? unfiledHits(term, pool, plans) : [];
  let skipped = 0;
  for (const plan of plans) {
    const seenHere = new Set();
    let off = offset;
    for (let page = 1; page <= 60; page++) {
      const j = await fetch('/api?m=release&id=' + plan.session + '&sort=episode_asc&page=' + page)
        .then((r) => r.json())
        .catch(() => null);
      if (!j) return { error: 'challenge' };
      const list = j.data || [];
      // Single-entry mode keeps the site's own numbering (gaps stay gaps);
      // all-seasons mode numbers a season's parts consecutively, because a
      // "Part 2" list may restart at 1 or continue at 50.
      if (!allSeasons && off === null) {
        off = inferOffset(null, list
          .map((e) => Number(e.episode))
          .filter((n) => Number.isFinite(n) && n >= 1));
      }
      for (const e of list) {
        const ep = Number(e.episode);
        if (!Number.isFinite(ep) || seenHere.has(ep)) continue;
        if (maxEps > 0 && seenHere.size >= maxEps) break;
        seenHere.add(ep);
        const appEp = allSeasons ? (seasonBase[plan.season] || 0) + seenHere.size : ep - off;
        // Already stored: count it, but do not spend a request.
        if (!force && have.indexOf(plan.season + '/' + appEp) !== -1) {
          skipped++;
          continue;
        }
        const html = await fetch('/play/' + plan.session + '/' + e.session).then((r) => r.text());
        // One challenge is the signal to stop the whole batch, not skip a show.
        if (/just a moment|attention required|cf-error-details/i.test(html)) return { error: 'challenge' };
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('#resolutionMenu button').forEach((b) => {
          const id = (b.dataset.src || '').match(/\\/e\\/([A-Za-z0-9]+)/);
          if (!id) return;
          const q = Number((b.textContent.match(/(\\d{3,4})p/) || [])[1] || 0);
          const a = /eng|dub/i.test((b.dataset.audio || '') + b.textContent) ? 'dub' : 'sub';
          rows.push({ s: plan.season, e: appEp, q, a, id: id[1] });
        });
        await sleep(600);
      }
      if (maxEps > 0 && seenHere.size >= maxEps) break;
      if (page >= (j.last_page || 1)) break;
    }
    if (allSeasons) {
      seasonBase[plan.season] = (seasonBase[plan.season] || 0) + seenHere.size;
      seasonCounts[plan.season] = (seasonCounts[plan.season] || 0) + seenHere.size;
    } else {
      // The site's total, not what this run stored: a top-up needs the target.
      seasonCounts[plan.season] = Math.max(seenHere.size, Number(plan.episodes) || 0);
    }
  }

  const first = plans[0];
  return {
    show: { title: first.title, session: first.session, year: first.year, episodes: first.episodes },
    seasons: seasonCounts,
    plans: plans.map((p) => ({ season: p.season, title: p.title })),
    fallback,
    skipped,
    ignored,
    rows,
  };
})()`;
}
