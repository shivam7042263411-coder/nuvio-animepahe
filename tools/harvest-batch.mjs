// Bulk kwik-id harvester: one real Chrome window, one Cloudflare solve, then a
// paced pass over a title list. Writes catalogue/*.json directly.
//
// usage: node tools/harvest-batch.mjs [--file tools/shows.txt] [--max-eps 12|0]
//                                     [--all-seasons] [--force] [--port 9334]
//                                     [--profile tools/.chrome-profile]
//
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
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOGUE_DIR,
  findShow,
  is1080Sub,
  mergeRows,
  readCatalogue,
  rebuildIndex,
  slug,
  titleKey,
  writeShow,
} from './catalogue-lib.mjs';
import { harvestScript } from './harvest-page.mjs';
import { tmdbKey, tmdbShow } from './tmdb.mjs';

const TMDB_KEY = tmdbKey();
if (!TMDB_KEY) {
  console.error(
    'no TMDB key: seasons are matched by name only.\n' +
      'put one in tools/.tmdb-key (or export TMDB_API_KEY) and a season called\n' +
      '"Culling Game" is filed by its size instead of being skipped.'
  );
}
const showCache = new Map();
/** TMDB's seasons for a show, or null when it cannot be identified. Cached per
 *  run: several lines can name the same show. */
async function seasonsFor(term) {
  if (!TMDB_KEY) return null;
  if (showCache.has(term)) return showCache.get(term);
  let seasons = null;
  try {
    const show = await tmdbShow(term, TMDB_KEY);
    seasons = show ? show.seasons : null;
    if (!show) console.error(`  tmdb: no exact show for "${term}" - matching by name`);
  } catch (e) {
    console.error(`  tmdb: ${e.message} - matching by name`);
  }
  showCache.set(term, seasons);
  return seasons;
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
        offset: Number(offset) || null,
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

// Files written before the 1080p-sub-only rule are rewritten on the way in;
// a show with nothing left to store is removed, not left as an empty entry.
for (const { file, data } of readCatalogue()) {
  if (!data.rows.some((row) => !is1080Sub(row))) continue;
  const before = data.rows.length;
  writeShow(file, data);
  if (!data.rows.length) {
    unlinkSync(join(CATALOGUE_DIR, file));
    console.log(`drop   ${file}: no 1080p sub (was ${before} row(s))`);
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
  return r.result?.result?.value;
}

await send('Page.enable');
await send('Runtime.enable');

console.log('waiting for the challenge to clear (finish it in the window if it asks)...');
let solved = false;
for (let i = 0; i < 90; i++) {
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
  console.error('challenge did not clear within 180s');
  chrome.kill();
  process.exit(2);
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
  const already = FORCE ? null : findShow(target);
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
    // Every stored row, no matter the season: an all-seasons run revisits each.
    haveEps: (already ? already.data.rows : []).map((r) => `${r.s}/${r.e}`),
    force: FORCE,
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
  // caller asked for that, and only give up when it never clears.
  const waitUntil = Date.now() + WAIT_CHALLENGE;
  while (result && result.error === 'challenge' && Date.now() < waitUntil) {
    console.log('  challenge: finish it in the Chrome window, retrying in 30s...');
    await sleep(30_000);
    try {
      result = await evaluate(harvestScript(plan));
    } catch {}
  }
  if (!result || result.error) {
    if (result && result.error === 'challenge') {
      console.error('  challenge appeared mid-run: stopping so the clearance is not burned');
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
  if (!result.rows.length) {
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
  if (result.plans) {
    console.log(`  ${result.plans.map((p) => 'S' + p.season + ' ' + p.title).join(' | ')}`);
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
  if ((show.maxEps === 0 || show.maxEps > 1) && Number(result.show.episodes) === 1) {
    console.error(`  warning: "${result.show.title}" reports 1 episode - likely a movie/special`);
  }
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
  data.search = data.search || show.term;
  const rows1080 = result.rows.filter((r) => Number(r.q) === 1080 && r.a === 'sub' && r.e >= 1);
  if (!rows1080.length) {
    console.error('  no 1080p sub for this show');
    failed++;
    continue;
  }
  mergeRows(data, rows1080);
  writeShow(file, data);
  // Rebuild every time: an interrupted run must still leave a matching index.
  rebuildIndex();
  const episodes = new Set(data.rows.map((r) => `${r.s}/${r.e}`)).size;
  console.log(`  ${file}: ${data.rows.length} row(s), ${episodes} episode(s)`);
  done++;
  await sleep(1500);
}

const { path, shows: indexed } = rebuildIndex();
console.log(`\n${done} harvested, ${failed} failed -> ${path} (${indexed.length} show(s))`);
console.log('push catalogue/ to GitHub for the TV to see it.');
ws.close();
chrome.kill();
process.exit(failed && !done ? 1 : 0);