// Bulk kwik-id harvester: one real Chrome window, one Cloudflare solve, then a
// paced pass over a title list. Writes catalogue/*.json directly.
//
// usage: node tools/harvest-batch.mjs [--file tools/shows.txt] [--max-eps 12|0]
//                                     [--all-seasons] [--force] [--port 9334]
//                                     [--profile tools/.chrome-profile]
//
// --dry-run plans and counts only: no play pages, no ids, nothing written.
// Shows over 500 TMDB episodes are deferred for a later run.
// A show whose every season is already stored is skipped (one TMDB lookup, no
// site request), so a bulk list resumes at the first unfinished title; --force
// re-reads one.
// --airing-only keeps just the shows TMDB has a next episode for: the weekly
// top-up. Costs one TMDB lookup per show, no site request for the rest.
// --audit prints the site's whole search pool and the season plan, writes
// nothing. Use it when a season lands somewhere unexpected.
// --profile keeps Chrome's session, so a Cloudflare solve covers many runs.
// --max-eps 0 means "every episode the entry has".
// --all-seasons fills every season the site labels ("2nd Season", "Part 2")
// instead of the single entry a line names. A sequel with no season label
// ("X: will+Dress", "X The Final Season") is skipped: a miss is safe, a wrong
// season is not.
//
// shows.txt, one per line:
//   term | maxEpisodes | appSeason | episodeOffset | resultIndex | appTitle
//   Horimiya | 12 | 1 | 0 | 0 | Horimiya
// Anything after `|` is optional. `episodeOffset` is for shows whose AnimePahe
// numbering continues across seasons (S2E1 stored as pahe ep 13 -> offset 12);
// it is worked out automatically from the entry's first episode, so only set it
// to override a wrong guess.
// `appTitle` files a season-specific entry into the app's show, so one file can
// hold every season: "Attack on Titan 2nd Season | 12 | 2 | 0 | -1 | Attack on Titan".
//
// cost: ~1 request per episode (~0.6s each) plus one search. 200 shows x 12 eps
// is roughly 30-45 minutes in one sitting; stop whenever, re-run to resume.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOGUE_DIR,
  findShow,
  isPlayableRow,
  bestRows,
  mergeRows,
  nextGap,
  readCatalogue,
  rebuildIndex,
  seasonsComplete,
  slug,
  titleKey,
  writeShow,
} from './catalogue-lib.mjs';
import { harvestScript, isSpecialTitle, seasonMarkerOf } from './harvest-page.mjs';
import { tmdbKey, tmdbShow, totalEpisodes } from './tmdb.mjs';

const TMDB_KEY = tmdbKey();
if (!TMDB_KEY) {
  console.error(
    'no TMDB key: seasons are matched by name only.\n' +
      'put one in tools/.tmdb-key (or export TMDB_API_KEY) and a season called\n' +
      '"Culling Game" is filed by its size instead of being skipped.'
  );
}
const showCache = new Map();
/** The TMDB show behind a term, or null when it cannot be identified. Cached
 *  per run: several lines can name the same show. */
async function showFor(term) {
  if (!TMDB_KEY) return undefined;
  if (showCache.has(term)) return showCache.get(term);
  let show = null;
  try {
    show = await tmdbShow(term, TMDB_KEY);
    if (!show) console.error(`  tmdb: no exact show for "${term}" - matching by name`);
  } catch (e) {
    console.error(`  tmdb: ${e.message} - matching by name`);
  }
  showCache.set(term, show);
  return show;
}
async function seasonsFor(term) {
  const show = await showFor(term);
  return show ? show.seasons : null;
}
/** A weekly run only wants shows TMDB has a next episode for. Without a key it
 *  cannot tell, so it keeps them all rather than skipping the whole list. */
async function airingFor(term) {
  const show = await showFor(term);
  // No key, or a term TMDB cannot place: harvest it anyway. Skipping a show
  // because it could not be looked up is how a week of episodes goes missing.
  return !show || show.airing;
}
/** One TMDB lookup per show takes ~0.5s, so 1,400 of them in the harvest loop
 *  would cost ten minutes of waiting. Six at a time brings it to about two. */
async function prefetchShows() {
  const terms = [...new Set(shows.map((s) => s.term))];
  let next = 0;
  const worker = async () => {
    while (next < terms.length) await showFor(terms[next++]);
  };
  await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
  const airing = terms.filter((t) => {
    const show = showCache.get(t);
    return !show || show.airing;
  }).length;
  console.log(`airing: ${airing} of ${terms.length} shows have a next episode (TMDB)`);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
}

const SHOWS = resolve(option('--file', join(HERE, 'shows.txt')));
const MAX_EPS = Number(option('--max-eps', 12));
const FORCE = args.includes('--force');
// Fill every season the site labels ("2nd Season", "Part 2") instead of the
// one entry a line names. Unlabelled sequels are skipped, never guessed.
const ALL_SEASONS = args.includes('--all-seasons');
// Oversized series are deferred by default so they cannot consume a bulk run.
const MAX_SHOW_EPISODES = 500;
const INCLUDE_OVER_500 = args.includes('--include-over-500');
// Weekly top-up: leave out every show TMDB has no next episode for. Finished
// shows then cost one TMDB lookup and no site request.
const AIRING_ONLY = args.includes('--airing-only');
// Audit: print the site's whole search pool for each show and the season plan.
// Nothing is fetched from play pages and nothing is written.
const AUDIT = args.includes('--audit');
// Plan and count only: no play pages, no ids, nothing written. Needs no TMDB
// key and touches the site far less, so it is the safe way to check a list.
const DRY_RUN = args.includes('--dry-run');
const PORT = Number(option('--port', 9334));
// A kept profile reuses the Cloudflare clearance between runs, so one solve
// covers many runs instead of one. Omitted: a fresh temp profile per run.
const PROFILE = option('--profile', null);
// A CI job dies hard at its own timeout and never reaches the commit step, so
// the run stops itself first and leaves a clean catalogue behind.
const MAX_MINUTES = Number(option('--max-minutes', 0));
const STARTED = Date.now();
// At the laptop a challenge is a checkbox to click; the run can wait for it
// instead of ending. CI has nobody to click, so it stays 0 there.
const WAIT_CHALLENGE = Number(option('--wait-challenge', 0)) * 1000;
// A 429 lifts on its own after a few minutes. With nobody at the laptop there is
// no point ending the run, so --wait-429 <minutes> sleeps the limit out and
// retries; 0 keeps the old behaviour of stopping. Minutes, unlike
// --wait-challenge: a rate limit is measured in minutes, a checkbox in seconds.
const WAIT_429 = Number(option('--wait-429', 0)) * 60_000;
// The pace is learned, not guessed: the page reports the gap it ended on and the
// rate it hit a 429 at, and the batch keeps the result between runs so a fresh
// run starts at the fastest rate that has actually been proven safe. --min-gap-ms
// overrides the seed for one run.
const RATE_STATE = join(HERE, '.rate-state.json');
const readGap = () => {
  try {
    return Number(JSON.parse(readFileSync(RATE_STATE, 'utf8')).minGapMs) || null;
  } catch {
    return null;
  }
};
const writeGap = (ms) => {
  try {
    writeFileSync(RATE_STATE, JSON.stringify({ minGapMs: ms, updated: new Date().toISOString() }) + '\n');
  } catch {}
};
const gapFlag = option('--min-gap-ms', null);
let minGap = gapFlag != null ? Number(gapFlag) : readGap() ?? 1200;
const MIN_GAP_FLOOR = 600;
const CHROME = option(
  '--chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
);
// A container has no user-namespace sandbox and a tiny /dev/shm; a desktop
// browser needs neither flag.
const NO_SANDBOX = args.includes('--no-sandbox');
const BASE = 'https://animepahe.pw';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseShows(path) {
  const hasMaxEps = args.includes('--max-eps');
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const [term, eps, season, offset, result, catTitle] = line
        .split('|')
        .map((s) => (s || '').trim());
      return {
        term,
        // 0 = every episode the entry has; blank = the --max-eps default.
        // A --max-eps on the command line wins over the column, so one flag
        // can lift a whole list to "everything" without editing 150 lines.
        maxEps: hasMaxEps
          ? MAX_EPS
          : eps === '0'
            ? 0
            : Number(eps) || MAX_EPS,
        season: Number(season) || 1,
        // A season column that the human wrote outranks the name-based guess:
        // one line per site entry is how "Tokyo Ghoul √A" becomes S2.
        seasonExplicit: Boolean(season),
        // An explicit 0 is a real offset ("keep the site's numbering"): a part
        // listed as episode 11 must not be renumbered to 1. Blank = infer.
        offset: String(offset || '').trim() === '' ? null : Number(offset),
        // -1 = pick the series automatically (see harvestScript); >= 0 = force.
        resultIndex: result ? Number(result) : -1,
        // The app's show name, when the site's entry is season-specific
        // ("Attack on Titan 2nd Season" -> "Attack on Titan"). Rows still land
        // in the one file for that show, keyed by season.
        catalogueTitle: catTitle || null,
      };
    });
}

const shows = parseShows(SHOWS);
if (!shows.length) {
  console.error(`no titles in ${SHOWS}`);
  process.exit(1);
}

// Files written before the best-sub rule are rewritten on the way in (one row
// per episode, highest resolution); a show with nothing left is removed.
for (const { file, data } of readCatalogue()) {
  if (!data.rows.some((row) => !isPlayableRow(row))) continue;
  const before = data.rows.length;
  writeShow(file, data);
  if (!data.rows.length) {
    unlinkSync(join(CATALOGUE_DIR, file));
    console.log(`drop   ${file}: no playable row (was ${before} row(s))`);
  } else {
    console.log(`prune  ${file}: ${before} -> ${data.rows.length} row(s)`);
  }
}

const profile = PROFILE ? resolve(PROFILE) : mkdtempSync(join(tmpdir(), 'kwik-batch-'));
if (PROFILE) mkdirSync(profile, { recursive: true });
console.log(
  `chrome profile: ${profile}${PROFILE ? ' (session kept between runs)' : ' (fresh)'}`
);
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    ...(NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    `${BASE}/`,
  ],
  { stdio: 'ignore' }
);

let page = null;
let anyPage = null;
for (let i = 0; i < 80; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const pages = (await res.json()).filter((t) => t.type === 'page');
    // A kept profile may restore old tabs; the harvester must drive its own.
    anyPage = anyPage || pages[0] || null;
    page = pages.find((t) => String(t.url || '').startsWith(BASE)) || null;
  } catch {}
  if (page) break;
  await sleep(500);
}
page = page || anyPage;
if (!page) {
  console.error('chrome did not expose a debug target');
  chrome.kill();
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('debugger websocket failed'));
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
// The tab or window closing used to leave the run waiting on a promise that
// never settles. Say what happened and stop; finished shows are already saved.
ws.onclose = () => {
  console.error('chrome window closed: stopping (re-run resumes where this left off)');
  process.exit(3);
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 300_000,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  }
  const value = r.result?.result?.value;
  // A detached page (navigation, crashed tab) answers with no value at all;
  // naming the reply beats the old bare "failed: no result".
  if (value === undefined) {
    throw new Error('no value from the page: ' + JSON.stringify(r.result?.result || null).slice(0, 200));
  }
  return value;
}

await send('Page.enable');
await send('Runtime.enable');

console.log('waiting for the challenge to clear (finish it in the window if it asks)...');
// A rate-limited site serves the Cloudflare 429 page as the document too, so the
// title never clears. Keep trying as long as --wait-429 allows, not a fixed 180s.
const clearUntil = Date.now() + Math.max(180_000, WAIT_429);
let solved = false;
for (let i = 0; Date.now() < clearUntil; i++) {
  let title = '';
  try {
    title = (await evaluate('document.title')) || '';
  } catch {}
  if (title && !/just a moment|attention required|checking/i.test(title)) {
    console.log(`solved: "${title}"\n`);
    solved = true;
    break;
  }
  if (i % 5 === 0 && i) console.log(`  still challenging (${i * 2}s)...`);
  await sleep(2000);
}
if (!solved) {
  console.error('challenge did not clear; stopping.');
  chrome.kill();
  process.exit(2);
}

// A clear page title does not prove the API is clear: /api can still answer
// with a Cloudflare page or a 403, and the harvest then reports that as
// "challenge" on the first show it fetches. Ask the endpoint the harvest
// actually uses, and print what came back so a block names itself.
const API_PROBE = `(async () => {
  const r = await fetch('/api?m=search&l=1&q=naruto').catch(() => null);
  if (!r) return { error: 'no reply' };
  const t = await r.text().catch(() => '');
  try { JSON.parse(t); return { ok: true }; } catch {}
  return { status: r.status, type: r.headers.get('content-type') || '', head: t.replace(/\\s+/g, ' ').slice(0, 160) };
})()`;
const apiUntil = Date.now() + Math.max(WAIT_CHALLENGE, WAIT_429, 60_000);
let api = await evaluate(API_PROBE).catch(() => ({ error: 'no reply' }));
while (!(api && api.ok) && Date.now() < apiUntil) {
  console.log(`api not ready: ${JSON.stringify(api)}`);
  await send('Page.reload', {});
  await sleep(15_000);
  api = await evaluate(API_PROBE).catch(() => ({ error: 'no reply' }));
}
if (api && api.ok) console.log('api: clear\n');


if (AIRING_ONLY) await prefetchShows();

/** Write what a run collected for one show. Used for a finished show and for
 *  one stopped mid-way by a 429 or a challenge: those rows are real episodes,
 *  so keeping them lets the next run top up instead of starting a 1180-episode
 *  show over. Returns null when the site had no playable release at all. */
function saveShow(show, target, result, already) {
  const file = already ? already.file : `${slug(target)}.json`;
  // A file that was filled from a mis-picked entry carries that show's name and
  // its ids: renaming it would make the app play the wrong show's episode. When
  // the line finally picks the entry it asked for, the old rows are not this
  // show's, so start the file over under the site's name.
  const retitle =
    already &&
    titleKey(result.show.title) === titleKey(target) &&
    titleKey(already.data.title) !== titleKey(target);
  const data = already && !retitle
    ? already.data
    : {
        title: retitle ? result.show.title : target,
        aliases: [],
        season: show.season,
        year: result.show.year || null,
        source: 'animepahe',
        search: show.term,
      };
  if (retitle) {
    console.log(`  retitle: "${already.data.title}" -> "${result.show.title}" (old rows dropped)`);
  }
  // The site's own name for this entry ("Attack on Titan 2nd Season") must not
  // be lost: a later line for that season looks the file up by it.
  if (titleKey(result.show.title) !== titleKey(target)) {
    data.aliases = data.aliases || [];
    if (!data.aliases.some((a) => titleKey(a) === titleKey(result.show.title))) {
      data.aliases.push(result.show.title);
    }
  }
  // The list term is the user's best guess at the app's title, but it is not a
  // site name: aliasing it would let a fallback guess (a sequel filed as S1)
  // match the app. Keep only names the site itself uses.
  data.session = result.show.session || data.session;
  if (result.show.episodes != null) data.episodes = result.show.episodes;
  if (result.seasons) {
    data.seasonEpisodes = { ...(data.seasonEpisodes || {}), ...result.seasons };
  }
  if (ALL_SEASONS) data.allSeasons = true;
  // One row per episode at the best release the site had: sub over dub, then
  // the higher resolution, so neither a 720p-only nor a dub-only show is lost.
  const keep = bestRows(result.rows);
  if (!keep.length) return null;
  mergeRows(data, keep);
  writeShow(file, data);
  // Rebuild every time: an interrupted run must still leave a matching index.
  rebuildIndex();
  const episodes = new Set(data.rows.map((r) => `${r.s}/${r.e}`)).size;
  return { file, rows: data.rows.length, episodes };
}

let done = 0;
let failed = 0;
for (const show of shows) {
  if (MAX_MINUTES && (Date.now() - STARTED) / 60000 > MAX_MINUTES) {
    console.log(`\nstopping: ${MAX_MINUTES} minute budget reached (re-run continues)`);
    break;
  }
  // A season line files into the app's show, not the site's season-specific
  // entry ("Attack on Titan 2nd Season" -> attack-on-titan.json).
  const target = show.catalogueTitle || show.term;
  if (AIRING_ONLY && !(await airingFor(show.term))) continue;
  // The TMDB record is read whatever the limit is: it also proves a show on a
  // later run is already finished (see the skip below).
  const info = await showFor(target);
  // 500 counts as out: Naruto Shippuden is exactly 500 and was excluded on
  // purpose, so the cap is "500 or more", not "more than 500".
  if (!INCLUDE_OVER_500 && info && totalEpisodes(info) >= MAX_SHOW_EPISODES) {
    console.log(`defer  ${show.term} (${totalEpisodes(info)} TMDB episodes; limit ${MAX_SHOW_EPISODES})`);
    continue;
  }
  const already = FORCE ? null : findShow(target);
  // A finished show is not re-read: a 2000-show list rerun daily would otherwise
  // spend its entire site budget on shows already done. "Finished" is TMDB's own
  // season sizes against the stored rows, so a cour that has since aired fails
  // the test and still tops up. --force re-reads one, which is also how a later,
  // higher-resolution upload gets picked up.
  if (already && already.data.allSeasons) {
    const film = !info && Number(already.data.episodes) === 1;
    const layout = info && info.seasons.length ? info.seasons : film ? [] : null;
    if (layout && seasonsComplete(already.data.rows, layout)) {
      console.log(`skip   ${show.term} (every season stored; --force to redo)`);
      continue;
    }
  }
  const storedEps = already
    ? new Set(already.data.rows.filter((r) => Number(r.s) === Number(show.season)).map((r) => Number(r.e)))
    : new Set();
  // Top up rather than skip: a higher --max-eps must reach a show that is
  // already stored, or raising the cap would silently do nothing. The total is
  // per season, so a second season cannot make the first look complete.
  // All-seasons runs never skip: which seasons exist is only known after the
  // search, and stored episodes cost no request anyway.
  // 0 = every episode the site has, which the stored count cannot prove, so it
  // never counts as complete.
  const wanted =
    !already || show.maxEps === 0
      ? Infinity
      : Math.min(
          show.maxEps,
          Number((already.data.seasonEpisodes || {})[show.season]) || Infinity
        );
  if (!ALL_SEASONS && already && storedEps.size >= wanted) {
    console.log(`skip   ${show.term} (${storedEps.size} episode(s) stored; --force to redo)`);
    continue;
  }
  if (storedEps.size) {
    console.log(`top up ${show.term} (${storedEps.size} stored, asking for ${show.maxEps || 'all'})`);
  }
  const plan = {
    ...show,
    allSeasons: ALL_SEASONS,
    // The page paces its own requests; the seed is the gap proven safe so far.
    minGapMs: minGap,
    // Every stored row, no matter the season: an all-seasons run revisits each.
    // A dry run ignores them so it reports what the site has, not what is kept.
    haveEps: DRY_RUN ? [] : (already ? already.data.rows : []).map((r) => `${r.s}/${r.e}`),
    force: FORCE,
    dryRun: DRY_RUN || AUDIT,
    audit: AUDIT,
    // The app counts episodes in TMDB's seasons, so TMDB decides what "season
    // 3" is; a season's name on the site then no longer matters.
    seasons: ALL_SEASONS ? await seasonsFor(show.catalogueTitle || show.term) : null,
  };
  console.log(
    `fetch  ${show.term} (${ALL_SEASONS ? 'all seasons' : 'season ' + show.season}, ` +
      `${show.maxEps ? 'up to ' + show.maxEps : 'all'} episode(s))...`
  );
  let result;
  try {
    result = await evaluate(harvestScript(plan));
  } catch (e) {
    console.error(`  failed: ${e.message}`);
    failed++;
    continue;
  }
  // A challenge mid-show is usually one checkbox away: wait for it when the
  // caller asked for that, and only give up when it never clears. Reload first:
  // a stale clearance re-solves on a fresh load, and a hard block keeps saying
  // the same thing, which the reply line then names.
  // A 429 is the same shape of wait, so --wait-429 handles it in this loop:
  // sleep the limit out and retry the same show instead of ending the run.
  const waitUntil = Date.now() + WAIT_CHALLENGE;
  let why = null;
  let waits = 0;
  while (
    result &&
    ((result.error === 'challenge' && Date.now() < waitUntil) ||
      (result.error === 'throttled' && WAIT_429))
  ) {
    if (result.error === 'throttled') {
      if (waits++ >= 8) {
        console.error('  429: still limited after 8 waits; stopping.');
        break;
      }
      // Keep what the site already gave us: refreshing haveEps then skips those
      // pages on the retry, so the wait is not spent re-reading them.
      if (result.rows && result.rows.length && !DRY_RUN) {
        const kept = saveShow(show, target, result, already);
        if (kept) {
          console.log(`  kept ${kept.episodes} episode(s) in ${kept.file} before waiting`);
        }
      }
      const back = findShow(target);
      if (back) plan.haveEps = back.data.rows.map((r) => `${r.s}/${r.e}`);
      if (MAX_MINUTES && (Date.now() - STARTED) / 60000 + WAIT_429 / 60000 > MAX_MINUTES) {
        console.error('  429: not enough minute budget left to wait; stopping.');
        break;
      }
      console.log(`  429 too many requests: waiting ${WAIT_429 / 60000} min, then retrying...`);
      await sleep(WAIT_429);
      try {
        result = await evaluate(harvestScript(plan));
      } catch {}
      continue;
    }
    if (!why && result.detail) {
      why = result.detail;
      console.log(`  site said: ${why}`);
    }
    console.log('  challenge: reloading the window, retrying in 15s...');
    await send('Page.reload', {});
    await sleep(15_000);
    try {
      result = await evaluate(harvestScript(plan));
    } catch {}
  }
  // Learn the pace: the page doubles its gap on any 429 and reports the gap it
  // ended on, so a clean show means the next one may go slightly faster.
  const pace = await evaluate('globalThis.__apPace || null').catch(() => null);
  if (pace && pace.requests) {
    // The floor is 600ms, not 300: the one stretch that ran at 300ms also saw a
    // 429 and a browser death, so ~100 req/min is as fast as this site is worth
    // pushing without babysitting.
    minGap = nextGap(pace.gap, pace.limited, { floor: MIN_GAP_FLOOR });
    writeGap(minGap);
    if (pace.limited) {
      console.log(`  paced: ${pace.requests} request(s), 429 x${pace.limited} -> gap ${minGap}ms`);
    }
  }
  if (!result || result.error) {
    // A stop mid-show (a 429, a challenge, a refused hole) still leaves real
    // episodes behind: keep them so the next run tops up instead of starting a
    // 1180-episode show over from episode one.
    if (result && result.rows && result.rows.length && !DRY_RUN) {
      const kept = saveShow(show, target, result, already);
      if (kept) {
        console.error(
          `  kept ${kept.episodes} episode(s) in ${kept.file} before stopping - the next run tops it up`
        );
      }
    }
    if (result && result.error === 'challenge') {
      console.error(
        '  challenge appeared mid-run: stopping so the clearance is not burned' +
          (why ? '\n  site said: ' + why : '')
      );
      break;
    }
    if (result && result.error === 'throttled') {
      console.error(
        '  429 too many requests: the site is rate-limiting this connection - stopping.\n' +
          '  wait ~15 minutes, then run the same command again (finished shows are kept)'
      );
      break;
    }
    console.error(`  failed: ${result ? result.error : 'no result'}`);
    failed++;
    continue;
  }
  if (result.audited) {
    console.log(`  audit: ${result.audited.length} entries in the search pool`);
    for (const h of result.audited) {
      console.log(
        `    ${h.title} (${h.year || '?'}, ${h.episodes || '?'} ep) ` +
          `[${h.type || '?'}] ep ${h.firstEp}..${h.lastEp}, ${h.pages} page(s)` +
          (isSpecialTitle(h.title) ? ' [special]' : '') +
          (seasonMarkerOf(h.title) != null ? ' [season ' + seasonMarkerOf(h.title) + ']' : '')
      );
    }
    for (const h of result.raw || []) console.log('    raw: ' + JSON.stringify(h));
    if (result.meta) console.log('    search meta: ' + JSON.stringify(result.meta));
    if (result.plans) {
      console.log(`  plan: ${result.plans.map((p) => 'S' + p.season + ' ' + p.title).join(' | ') || 'nothing'}`);
    }
    done++;
    continue;
  }
  if (!result.rows.length && !DRY_RUN) {
    if (result.skipped) {
      console.log(`  already stored (${result.skipped} episode(s), nothing fetched)`);
      done++;
      continue;
    }
    console.error(`  no ids found (challenge block or empty play pages)`);
    failed++;
    continue;
  }
  if (result.fallback) {
    console.error(`  warning: no season-labelled entry for "${show.term}" - filed the best hit as season 1`);
  }
  if (ALL_SEASONS && (plan.seasons || []).length && !result.sized && (result.plans || []).length) {
    console.error(
      `  warning: TMDB's season sizes do not add up to the site's entries for "${show.term}" - ` +
        `filed by the season in each entry's name instead; check the seasons below`
    );
  }
  // Whatever was left over is the reason to look at the pool: it shows the type
  // and the season marker of every entry the site offered.
  if (DRY_RUN && ((result.ignored || []).length || (result.films || []).length)) {
    for (const h of result.pool || []) {
      console.log(
        `    pool: ${h.title} (${h.year || '?'}, ${h.episodes || '?'} ep)` +
          (h.type ? ' [' + h.type + ']' : '') +
          (h.marker != null ? ' [season ' + h.marker + ']' : '')
      );
    }
  }
  if (result.plans) {
    console.log(`  ${result.plans.map((p) => {
      const n = p.slice != null ? p.slice : p.episodes;
      return 'S' + p.season + ' ' + p.title +
        (DRY_RUN && n != null ? ' (' + n + ')' : '') +
        // A season whose site list ends before the TMDB size: still airing, so
        // the run stores what exists and next week's run tops it up.
        (p.partial ? ' [airing ' + n + '/' + (p.size || '?') + ']' : '');
    }).join(' | ')}`);
  }
  // A season can hide in a differently-named entry ("Jujutsu Kaisen: Culling
  // Game"); naming it here is the difference between a visible gap and a
  // silently missing season.
  for (const h of result.ignored || []) {
    console.log(
      `  not filed: "${h.title}" (${h.year || '?'}, ${h.episodes || '?'} ep) - ` +
        `a season under another name: add "${h.title} | 0 | <season> | 0 | -1 | ${target}"`
    );
  }
  // A film is its own TMDB title and its own catalogue file (the app asks for
  // it at S1E1), so it is never part of the show's seasons. Name it, because a
  // sequel film that quietly goes missing is exactly what nobody notices.
  for (const h of result.films || []) {
    console.log(
      `  film not filed: "${h.title}" (${h.year || '?'}) - add its own line: ` +
        `"${h.title} | 1 | 1 | 0 | -1 | <the app's title for this film>"`
    );
  }
  if ((show.maxEps === 0 || show.maxEps > 1) && Number(result.show.episodes) === 1) {
    console.error(`  warning: "${result.show.title}" reports 1 episode - likely a movie/special`);
  }
  if (DRY_RUN) {
    const counts = Object.keys(result.seasons || {})
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => 'S' + k + ': ' + result.seasons[k] + ' ep')
      .join(', ');
    console.log(`  dry run: ${counts} - would write ${slug(target)}.json, nothing saved`);
    done++;
    continue;
  }
  const saved = saveShow(show, target, result, already);
  if (!saved) {
    // Name what the site does have: a 720p-only release cannot be "improved" by
    // re-harvesting, only replaced by a later 1080p upload.
    const have = [...new Set(result.rows.map((r) => `${r.q || '?'}p ${r.a}`))].join(', ');
    console.error(
      `  no playable release for this show${have ? ` (site has: ${have})` : ' (no episode had a resolution list)'}`
    );
    failed++;
    continue;
  }
  console.log(`  ${saved.file}: ${saved.rows} row(s), ${saved.episodes} episode(s)`);
  done++;
  await sleep(1500);
}

const { path, shows: indexed } = rebuildIndex();
console.log(`\n${done} harvested, ${failed} failed -> ${path} (${indexed.length} show(s))`);
console.log('push catalogue/ to GitHub for the TV to see it.');
ws.close();
chrome.kill();
// A chained run starts a new Chrome on the same profile seconds later. If the
// old one is still listening, the new process takes the handoff and exits, which
// the next run sees as "chrome window closed". Wait for the port to go quiet.
for (let i = 0; i < 40; i++) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`);
    await sleep(250);
  } catch {
    break;
  }
}
process.exit(failed && !done ? 1 : 0);