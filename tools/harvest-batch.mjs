// Bulk kwik-id harvester: one real Chrome window, one Cloudflare solve, then a
// paced pass over a title list. Writes catalogue/*.json directly.
//
// usage: node tools/harvest-batch.mjs [--file tools/shows.txt] [--max-eps 12]
//                                     [--force] [--port 9334]
//
// shows.txt, one per line:
//   term | maxEpisodes | appSeason | episodeOffset | resultIndex
//   Horimiya | 12 | 1 | 0 | 0
// Anything after `|` is optional. `episodeOffset` is for shows whose AnimePahe
// numbering continues across seasons: S2E1 stored as pahe ep 13 -> offset 12.
//
// cost: ~1 request per episode (~0.6s each) plus one search. 200 shows x 12 eps
// is roughly 30-45 minutes in one sitting; stop whenever, re-run to resume.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
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
  titleKey,
  writeShow,
} from './catalogue-lib.mjs';
import { harvestScript } from './harvest-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
}

const SHOWS = resolve(option('--file', join(HERE, 'shows.txt')));
const MAX_EPS = Number(option('--max-eps', 12));
const FORCE = args.includes('--force');
const PORT = Number(option('--port', 9334));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'https://animepahe.pw';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseShows(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const [term, eps, season, offset, result] = line.split('|').map((s) => (s || '').trim());
      return {
        term,
        maxEps: Number(eps) || MAX_EPS,
        season: Number(season) || 1,
        offset: Number(offset) || 0,
        // -1 = pick the series automatically (see harvestScript); >= 0 = force.
        resultIndex: result ? Number(result) : -1,
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

const profile = mkdtempSync(join(tmpdir(), 'kwik-batch-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    `${BASE}/`,
  ],
  { stdio: 'ignore' }
);

let page = null;
for (let i = 0; i < 80 && !page; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await res.json()).find((t) => t.type === 'page') || null;
  } catch {}
  if (!page) await sleep(500);
}
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
    timeout: 180_000,
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
  if (!FORCE) {
    const already = readCatalogue().find(
      (s) => s.data.search && titleKey(s.data.search) === titleKey(show.term)
    );
    if (already) {
      console.log(`skip   ${show.term} (already in ${already.file}; --force to redo)`);
      continue;
    }
  }
  console.log(`fetch  ${show.term} (up to ${show.maxEps} episode(s))...`);
  let result;
  try {
    result = await evaluate(harvestScript(show));
  } catch (e) {
    console.error(`  failed: ${e.message}`);
    failed++;
    continue;
  }
  if (!result || result.error) {
    if (result && result.error === 'challenge') {
      console.error('  challenge appeared mid-run: stopping so the clearance is not burned');
      break;
    }
    console.error(`  failed: ${result ? result.error : 'no result'}`);
    failed++;
    continue;
  }
  if (!result.rows.length) {
    console.error(`  no ids found (challenge block or empty play pages)`);
    failed++;
    continue;
  }
  if (show.maxEps > 1 && Number(result.show.episodes) === 1) {
    console.error(`  warning: "${result.show.title}" reports 1 episode - likely a movie/special`);
  }
  const existing = findShow(result.show.title);
  const file = existing ? existing.file : `${show.term.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
  const data = existing
    ? existing.data
    : {
        title: result.show.title,
        aliases: [],
        season: show.season,
        year: result.show.year || null,
        source: 'animepahe',
        search: show.term,
      };
  data.session = result.show.session || data.session;
  if (result.show.episodes != null) data.episodes = result.show.episodes;
  data.search = data.search || show.term;
  const wanted = result.rows.filter((r) => Number(r.q) === 1080 && r.a === 'sub' && r.e >= 1);
  if (!wanted.length) {
    console.error('  no 1080p sub for this show');
    failed++;
    continue;
  }
  mergeRows(data, wanted);
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