// Cut the next daily batch: the cheapest N titles from a list that are not
// stored yet and are not deferred for size, written as its own list file.
// TMDB only - nothing here touches AnimePahe, so it costs no site budget.
//
// Cheapest first, because a sitting is bounded by requests, not titles: one
// request is one episode, so a 300-episode show costs 300 of them. Sorting by
// cost buys the most shows for the minutes available.
//
// usage: node tools/next-batch.mjs [--size 100] [--file shows-auto-tail.txt]
//        [--out shows-day-NN.txt] [--requests-per-second 0.75] [--scan 600]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findShow } from './catalogue-lib.mjs';
import { tmdbKey, tmdbShow, totalEpisodes } from './tmdb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const SIZE = Number(opt('--size', 100));
const SRC = join(HERE, opt('--file', 'shows-auto-tail.txt'));
const PER_SECOND = Number(opt('--requests-per-second', 0.75));
const MAX_SHOW_EPISODES = 500;
// How deep down the list to look for cheap candidates. Each title costs two
// TMDB calls, which are cheap but not free, so the scan is bounded and parallel.
const SCAN = Number(opt('--scan', 600));
const CONCURRENCY = 8;
// A show with no TMDB match is sorted as a median one: unknown is not a licence
// to jump the queue in front of shows we know are one film long.
const UNSIZED_COST = 26;

/** Run `fn` over `items` with a fixed number in flight. TMDB lookups are pure
 *  network waits, so the serial version spent minutes doing nothing. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const at = next++;
        out[at] = await fn(items[at]);
      }
    })
  );
  return out;
}

// The next unused number, so day 1, day 2, ... without having to remember.
function nextOut() {
  const given = opt('--out', null);
  if (given) return join(HERE, given);
  const used = readdirSync(HERE)
    .map((f) => (f.match(/^shows-day-(\d+)\.txt$/) || [])[1])
    .filter(Boolean)
    .map(Number);
  return join(HERE, `shows-day-${String(used.length ? Math.max(...used) + 1 : 1).padStart(2, '0')}.txt`);
}

const lines = readFileSync(SRC, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .slice(0, SCAN);

const key = tmdbKey();
const scanned = await mapPool(lines, CONCURRENCY, async (line) => {
  const term = line.split('|')[0].trim();
  if (!term) return null;
  if (findShow(term)) return { skip: 'stored' };
  const info = await tmdbShow(term, key);
  const total = info ? totalEpisodes(info) : 0;
  // 500 counts as out: Naruto Shippuden is exactly 500 and is deliberately not
  // fetched, so the cap is "500 or more", not "more than 500".
  if (info && total >= MAX_SHOW_EPISODES) return { skip: 'big', cost: total };
  return { line, cost: total || UNSIZED_COST, sized: Boolean(info) };
});

const found = scanned.filter(Boolean);
const pool = found.filter((r) => r.line);
pool.sort((a, b) => a.cost - b.cost);
const picked = pool.slice(0, SIZE);
const unsized = picked.filter((p) => !p.sized).length;
const episodes = picked.reduce((sum, p) => sum + (p.sized ? p.cost : 0), 0);

const OUT = nextOut();
writeFileSync(OUT, picked.map((p) => p.line).join('\n') + '\n');

// One request per episode plus one search and one release page per season.
const requests = episodes + picked.length * 3;
const perShow = requests / Math.max(picked.length, 1);
const minutes = Math.round(requests / PER_SECOND / 60);
// A sitting is bounded by requests, so this is what the cheapest-first sort buys.
const in40 = Math.floor((40 * 60 * PER_SECOND) / perShow);
console.log(`${picked.length} shows, ${episodes} episodes (~${requests} site requests, ~${perShow.toFixed(0)} per show)`);
console.log(
  `scanned ${lines.length}: ${found.filter((r) => r.skip === 'stored').length} already stored, ` +
    `${found.filter((r) => r.skip === 'big').length} of 500+ episodes dropped`
);
if (unsized) console.log(`note: ${unsized} had no TMDB match (costed as a median show)`);
console.log(`-> ${OUT}`);
console.log(`estimate: ~${minutes} min clean; a 40-minute sitting fits ~${in40} shows this size`);
