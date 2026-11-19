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

  // A film or a special in the pool is one episode and belongs to no season:
  // counted, it throws off the sum for that season and every season after it
  // (Mushoku Tensei loses S2 and S3 to an "Episode 0" prologue). It is kept
  // when its name says which season it belongs to - that is a season which has
  // only just started airing - and when the season being filled is itself one
  // episode long.
  const lone = (e) => isLoneEntry(e.title, e.episodes);
  // The site labels every entry TV, Movie or Special. Only a TV entry can be a
  // season: "Re:ZERO ~Starting Break Time From Zero~ Season 2" is a 25-episode
  // spin-off short of the same franchise, and it used to fill season 2.
  const offSeason = (e) =>
    isSpecialTitle(e.title) || (Boolean(e.type) && e.type !== 'TV') || lone(e);

  // A long show is one site entry covering many seasons, and the site numbers
  // those episodes in order (One Piece: one entry, 1180 episodes, and TMDB's 23
  // sagas add up to the same 1180). When the TV entries in the pool add up to
  // exactly what TMDB describes, each season is a slice of them in release order
  // and nothing has to be guessed. Returns null when that cannot be verified.
  const sliceSeasons = () => {
    let line = entries.filter((e) => !offSeason(e));
    if (!line.length) return null;
    // An entry with no episode count is still airing, and every episode of the
    // show lives in it. A later entry that starts over ("One Piece Log:
    // Fish-Man Island Saga", one arc re-cut) is not a continuation: put into
    // the run, it shifts every season after it, so the ongoing entry is used
    // alone.
    if (!Number(line[0].episodes)) line = [line[0]];
    const known = line.every((e) => Number(e.episodes) > 0);
    // One entry of unknown length (a show still airing says "0 episodes") can
    // still be sliced: it just takes whatever each season asks for, in order.
    if (!known && line.length !== 1) return null;
    const total = line.reduce((n, e) => n + (Number(e.episodes) || 0), 0);
    const wanted = seasons.reduce((n, s) => n + (Number(s.episodes) || 0), 0);
    if (known && total !== wanted) return null;

    const out = [];
    let ci = 0;
    let used = 0;
    for (const season of seasons) {
      const n = Number(season.n);
      const size = Number(season.episodes) || 0;
      if (!size) continue;
      const parts = [];
      let room = size;
      while (ci < line.length && room > 0) {
        const e = line[ci];
        const count = Number(e.episodes) || 0;
        const take = count ? Math.min(count - used, room) : room;
        parts.push({ ...e, part: partOf(e.title), from: used + 1, to: used + take });
        used += take;
        room -= take;
        if (count && used >= count) {
          ci++;
          used = 0;
        }
      }
      // The site ran out before the season was filled: still airing.
      if (!parts.length) continue;
      out.push({ season: n, year: season.year, size, parts, ...(room > 0 ? { partial: true } : {}) });
    }
    if (!out.length) return null;
    // A season that has a number in TMDB cannot be filled by an entry that names
    // a different one: that is how a spin-off gets in.
    const knownSeasons = new Set(seasons.map((s) => Number(s.n)));
    for (const plan of out) {
      for (const part of plan.parts) {
        const m = seasonMarkerOf(part.title);
        if (m != null && knownSeasons.has(m) && m !== plan.season) return null;
      }
    }
    return out;
  };

  const sliced = sliceSeasons();
  if (sliced) return sliced;

  // Consume entries from `from` until the season's episodes are met. Returns
  // the parts and where the list got to, or null when this season cannot be
  // built from there.
  const scan = (from, season) => {
    let room = Number(season.episodes) || 0;
    if (!room) return null;
    const parts = [];
    let idx = from;
    while (idx < entries.length && room > 0) {
      const e = entries[idx];
      if (offSeason(e) || (room > 1 && lone(e))) {
        idx++;
        continue;
      }
      // The entry's own season word is not a boundary: TMDB decides where the
      // app's seasons split, and the two disagree ("Season 3 Part 2" episodes
      // live in TMDB's season 4, and all of JJK sits in one season there).
      const count = Number(e.episodes) || 0;
      if (!count || count > room) break;
      parts.push({ ...e, part: partOf(e.title) });
      room -= count;
      idx++;
    }
    if (room === 0 && parts.length) return { parts, end: idx };
    // The site's list ends inside this season: it is still airing. File what
    // exists and top it up next run. Only safe because the entries ran out - a
    // season skipped in the middle still leaves entries after it.
    if (parts.length && idx >= entries.length) return { parts, end: idx, partial: true };
    return null;
  };

  for (const season of seasons) {
    const n = Number(season.n);
    // An entry that names this season wins over one that does not: "Attack on
    // Titan: Junior High" fits season 2's twelve episodes as well as "Attack on
    // Titan Season 2" does, and only the name says which one the app means.
    let picked = null;
    for (let j = i; j < entries.length && !picked; j++) {
      if (seasonMarkerOf(entries[j].title) !== n) continue;
      picked = scan(j, season);
    }
    if (!picked) picked = scan(i, season);
    if (!picked) {
      // Wrong shape: leave these entries for the next season to try. Nothing is
      // guessed, and the caller reports them as not filed.
      continue;
    }
    plans.push({
      season: n,
      year: season.year,
      parts: picked.parts,
      size: Number(season.episodes),
      ...(picked.partial ? { partial: true } : {}),
    });
    i = picked.end;
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
  // An entry with no episode count is a show still airing; it is the show
  // itself, not a one-off film, so it stays in the franchise.
  const ongoing = (h) => h.episodes != null && Number(h.episodes) === 0;
  const hasEpisodes = own.some((h) => ongoing(h) || Number(h.episodes) > 1);
  return hasEpisodes
    ? own.filter(
        (h) => ongoing(h) || Number(h.episodes) > 1 || seasonMarkerOf(h.title) != null
      )
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
    .filter((h) => !used.has(fold(h.title)) && !isLoneEntry(h.title, h.episodes))
    .filter((h) => !h.type || h.type === 'TV')
    .map((h) => ({ title: h.title, year: h.year, episodes: h.episodes }));
}

/** The season an entry's own title names, if it names one. */
export function isSpecialTitle(title) {
  const n = fold(title);
  if (!n) return false;
  return /\b(?:ova|oad|specials?|recap|movie|pilot|picture drama)\b/.test(n) || /\bshort\b/.test(n);
}

/** The season an entry's own title names, if it names one. */
/** A film or a single special: one episode, and its name does not name a
 *  season. A one-episode season that has just started airing is named as a
 *  season, so it is not this. */
export function isLoneEntry(title, episodes) {
  return (
    Number(episodes) === 1 &&
    (seasonMarkerOf(title) == null || /\bepisode\b/.test(fold(title)))
  );
}
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

/** Films and one-episode specials in the franchise that the season plan dropped.
 *  A film is not a season: TMDB has it as its own title and the app asks for it
 *  at S1E1, so it needs its own catalogue file and its own list line. Silently
 *  dropping it is how a sequel film goes missing. */
export function filmsOf(term, pool, plans) {
  const used = new Set();
  for (const plan of plans) {
    for (const part of plan.parts || [plan]) used.add(fold(part.title));
  }
  const base = fold(term);
  return pool
    .filter((h) => {
      const hk = fold(h.title);
      return (
        hk &&
        !used.has(hk) &&
        (hk === base || hk.indexOf(base + ' ') === 0) &&
        (h.type === 'Movie' || isLoneEntry(h.title, h.episodes)) &&
        // "Show Season 2 - Episode 0": a prologue inside a season's numbering,
        // not a title the app can ask for on its own.
        !/\bepisode\b/.test(hk)
      );
    })
    .map((h) => ({ title: h.title, year: h.year }));
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
  // The site rate-limits by IP (HTTP 429). A limited page is not an empty
  // season: wait for the limit to lift, then give up loudly so the run stops
  // instead of writing a show that is missing episodes.
  const fetchLimited = async (url) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url);
      if (r.status !== 429) return r;
      if (attempt >= 2) return null;
      await sleep(15000);
    }
  };
  // Every non-JSON reply used to be reported as "challenge" alone, which hid
  // whether the site sent a Cloudflare page, a 403 or a 5xx. Keep the status,
  // the content type and the first line of the body so a block names itself.
  const said = async (r, copy) => {
    const body = copy ? await copy.text().catch(() => '') : '';
    const type = r.headers && r.headers.get ? r.headers.get('content-type') || '' : '';
    return (r.status + ' ' + type + ' ' + body).replace(/\\s+/g, ' ').trim().slice(0, 200);
  };
  const term = ${JSON.stringify(show.term)};
  const maxEps = ${show.maxEps};
  const resultIndex = ${show.resultIndex};
  const season = ${show.season};
  const offset = ${show.offset == null ? 'null' : Number(show.offset)};
  const allSeasons = ${show.allSeasons ? 'true' : 'false'};
  // Test mode: plan the seasons and count episodes, but never fetch a play
  // page and never keep a row, so nothing can be saved.
  const dryRun = ${show.dryRun ? 'true' : 'false'};
  // Audit: list what the site's search actually returned, including entries the
  // season plan threw away, and how each entry's episodes are numbered.
  const audit = ${show.audit ? 'true' : 'false'};
  const have = ${JSON.stringify(show.haveEps || [])};
  const force = ${show.force ? 'true' : 'false'};
  const rank = ${rankHits.toString()};
  const fold = ${fold.toString()};
  const classifyHits = ${classifyHits.toString()};
  const classify = classifyHits;
  const isSpecialTitle = ${isSpecialTitle.toString()};
  const isLoneEntry = ${isLoneEntry.toString()};
  const seasonMarkerOf = ${seasonMarkerOf.toString()};
  const partOf = ${partOf.toString()};
  const planSeasons = ${planSeasons.toString()};
  const franchiseOf = ${franchiseOf.toString()};
  const unfiledHits = ${unfiledHits.toString()};
  const filmsOf = ${filmsOf.toString()};
  const inferOffset = ${inferOffset.toString()};
  // The app counts episodes by TMDB's seasons; when the caller supplied them,
  // size decides which season an entry is, not the entry's name.
  const tmdbSeasons = ${JSON.stringify(show.seasons || null)};

  // The search returns eight hits and cannot page: "&page=2" is ignored (the
  // same page comes back) and the next_page_url it advertises answers 403, so
  // following it breaks a show outright. A franchise with more than eight
  // entries then hides its later seasons - Attack on Titan's Final Season, and
  // Re:Zero's, are past the first eight. /anime is one plain HTML page listing
  // every show, so it is used to find what the search left out, and only those
  // titles are looked up by name for their details.
  const base = fold(term);
  const searchOnce = async (q) => {
    const sr = await fetchLimited('/api?m=search&l=15&q=' + encodeURIComponent(q) + '&page=1');
    if (!sr) return { error: 'throttled' };
    const copy = sr.clone ? sr.clone() : null;
    const j = sr.ok ? await sr.json().catch(() => null) : null;
    if (!j) return { error: 'challenge', detail: await said(sr, copy) };
    return { hits: (j.data || []).filter((h) => h && h.session), meta: j };
  };
  // One fetch per Chrome session, not per show: cached on the page itself, so
  // the whole batch reuses it. (No window object outside a browser, as in the
  // self-test, so the cache is then per call.)
  const store = typeof window === 'undefined' ? {} : window;
  const siteIndex = () => {
    store.__paheIndex = store.__paheIndex || (async () => {
      const r = await fetchLimited('/anime');
      const html = r && r.ok ? await r.text() : '';
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const rows = [];
      doc.querySelectorAll('a[href^="/anime/"]').forEach((a) => {
        const title = (a.getAttribute('title') || a.textContent || '').trim().replace(/\\s+/g, ' ');
        const session = (a.getAttribute('href') || '').split('/anime/')[1];
        if (title && session) rows.push({ title, session });
      });
      return rows;
    })();
    return store.__paheIndex;
  };

  const firstSearch = await searchOnce(term);
  if (firstSearch.error) return firstSearch;
  const searchMeta = { ...firstSearch.meta };
  delete searchMeta.data;
  const pool = firstSearch.hits.slice();
  // Only the title family, and only what the search did not already return.
  const missed = (await siteIndex()).filter((e) => {
    const k = fold(e.title);
    return (
      (k === base || k.indexOf(base + ' ') === 0) && !pool.some((p) => p.session === e.session)
    );
  });
  for (const entry of missed) {
    // One request every so often, not a burst: a flood is what makes the site
    // answer with a challenge part way through a show.
    await sleep(200);
    const again = await searchOnce(entry.title);
    if (again.error) return again;
    const hit = again.hits.find((h) => h.session === entry.session);
    // A title the search still will not return stays out: no details, no guess.
    if (hit) pool.push(hit);
  }

  let plans;
  let fallback = false;
  let sized = false;
  if (allSeasons) {
    plans = [];
    if (tmdbSeasons && tmdbSeasons.length) {
      // File by season size. An entry whose title never says "season 3" lands
      // there anyway when the episodes add up.
      for (const p of planSeasons(franchiseOf(term, pool), tmdbSeasons)) {
        for (const part of p.parts) {
          plans.push({ ...part, season: p.season, size: p.size, partial: !!p.partial });
        }
      }
      // Seasons ascending; inside a season the entries keep the release order
      // the planner consumed them in. Sorting by the entry's own "Part 2"
      // marker filed Re:ZERO's Season 3 before Season 2 Part 2, so S1E39-50
      // played season 3's episodes. Release order is the only safe order.
      plans.sort((a, b) => a.season - b.season);
      sized = plans.length > 0;
    }
    // TMDB's seasons and the site's entries disagree: fall back to the label in
    // the entry's name, the way a keyless run does. The caller says so in the
    // log, because here the names are the only thing left to trust.
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
  const films = allSeasons ? filmsOf(term, pool, plans) : [];

  if (audit) {
    const audited = [];
    for (const h of pool) {
      const row = { title: h.title, year: h.year, type: h.type || null, episodes: h.episodes, session: h.session };
      const rr = await fetchLimited('/api?m=release&id=' + h.session + '&sort=episode_asc&page=1');
      if (rr && rr.ok) {
        const j = await rr.json().catch(() => null);
        const eps = ((j && j.data) || []).map((e) => Number(e.episode)).filter(Number.isFinite);
        row.firstEp = eps.length ? Math.min(...eps) : null;
        row.lastEp = eps.length ? Math.max(...eps) : null;
        row.pages = (j && j.last_page) || 1;
      }
      audited.push(row);
      await sleep(200);
    }
    return {
      show: { title: term, episodes: null },
      seasons: {},
      plans: plans.map((p) => ({ season: p.season, title: p.title, episodes: p.episodes })),
      fallback,
      sized,
      dryRun: true,
      skipped: 0,
      ignored,
      films,
      audited,
      meta: searchMeta,
      raw: pool.slice(0, 2),
      rows: [],
    };
  }

  let skipped = 0;
  // One request per entry, not per season: a long show's single entry is cut
  // into seasons, and re-fetching its episode list 23 times would be 23x the
  // traffic for the same pages.
  const bySession = new Map();
  for (const plan of plans) {
    if (!bySession.has(plan.session)) bySession.set(plan.session, []);
    bySession.get(plan.session).push(plan);
  }
  for (const [session, parts] of bySession) {
    const eps = [];
    const seen = new Set();
    for (let page = 1; page <= 60; page++) {
      const rr = await fetchLimited('/api?m=release&id=' + session + '&sort=episode_asc&page=' + page);
      if (!rr) return { error: 'throttled' };
      const rCopy = rr.clone ? rr.clone() : null;
      const j = rr.ok ? await rr.json().catch(() => null) : null;
      if (!j) return { error: 'challenge', detail: await said(rr, rCopy) };
      for (const e of j.data || []) {
        const ep = Number(e.episode);
        if (!Number.isFinite(ep) || seen.has(ep)) continue;
        seen.add(ep);
        eps.push(e);
      }
      if (page >= (j.last_page || 1)) break;
    }
    // A sliced entry is walked by position: its nth listed episode becomes the
    // app's nth episode of the season. That is only sound when the list has no
    // holes - a missing episode would shift every later one. One Piece is 1180
    // episodes in a single entry, so this is exactly where a hole would hurt
    // most. Refuse to slice a list with a gap rather than store wrong episodes.
    if (parts.some((p) => p.from != null)) {
      const nums = eps.map((e) => Number(e.episode));
      const hole = nums.findIndex((n, i) => i > 0 && n !== nums[i - 1] + 1);
      if (hole !== -1) {
        return {
          error:
            'hole in the release list for "' + (parts[0].title || session) +
            '" at episode ' + nums[hole] + '; refusing to slice it',
        };
      }
    }
    for (const plan of parts) {
      // Single-entry mode keeps the site's own numbering (gaps stay gaps).
      let off = offset;
      if (!allSeasons && off === null) {
        off = inferOffset(null, eps.map((e) => Number(e.episode)).filter((n) => n >= 1 && Number.isFinite(n)));
      }
      const from = plan.from != null ? Math.max(1, plan.from) : 1;
      const to = plan.to != null ? plan.to : Infinity;
      let taken = 0;
      for (let pos = 1; pos <= eps.length; pos++) {
        if (pos < from || pos > to) continue;
        if (maxEps > 0 && taken >= maxEps) break;
        taken++;
        const appEp = allSeasons
          ? (seasonBase[plan.season] || 0) + (pos - from + 1)
          : Number(eps[pos - 1].episode) - off;
        // Already stored: count it, but do not spend a request.
        if (!force && have.indexOf(plan.season + '/' + appEp) !== -1) {
          skipped++;
          continue;
        }
        if (!dryRun) {
          const pr = await fetchLimited('/play/' + session + '/' + eps[pos - 1].session);
          if (!pr) return { error: 'throttled' };
          const html = await pr.text();
          // One challenge is the signal to stop the whole batch, not skip a show.
          if (/just a moment|attention required|cf-error-details/i.test(html)) {
            return {
              error: 'challenge',
              detail: (pr.status + ' ' + html).replace(/\\s+/g, ' ').slice(0, 200),
            };
          }
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
      }
      if (allSeasons) {
        seasonBase[plan.season] = (seasonBase[plan.season] || 0) + taken;
        seasonCounts[plan.season] = (seasonCounts[plan.season] || 0) + taken;
      } else {
        // The site's total, not what this run stored: a top-up needs the target.
        seasonCounts[plan.season] = Math.max(taken, Number(plan.episodes) || 0);
      }
    }
  }

  const first = plans[0];
  return {
    show: { title: first.title, session: first.session, year: first.year, episodes: first.episodes },
    seasons: seasonCounts,
    plans: plans.map((p) => ({
      season: p.season,
      title: p.title,
      episodes: p.episodes,
      // A sliced part is one season's worth of a much longer entry: its own
      // episode count is the whole entry's (0 when the show is still airing).
      slice: p.to != null ? p.to - p.from + 1 : null,
      size: p.size,
      partial: !!p.partial,
    })),
    fallback,
    sized,
    dryRun,
    skipped,
    ignored,
    films,
    pool: pool.map((h) => ({
      title: h.title,
      year: h.year,
      type: h.type || null,
      episodes: h.episodes,
      marker: seasonMarkerOf(h.title),
    })),
    rows,
  };
})()`;
}
