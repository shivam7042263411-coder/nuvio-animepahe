// Cut the next daily batch: the first N titles from a list that are not stored
// yet and are not deferred for size, written as its own list file. TMDB only -
// nothing here touches AnimePahe, so it costs no site budget.
//
// usage: node tools/next-batch.mjs [--size 100] [--file shows-auto-tail.txt]
//        [--out shows-day-NN.txt] [--episodes-per-second 1.1]
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
const PER_SECOND = Number(opt('--episodes-per-second', 1.1));
const MAX_SHOW_EPISODES = 500;

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
  .filter((l) => l && !l.startsWith('#'));

const key = tmdbKey();
const picked = [];
let skippedStored = 0;
let skippedBig = 0;
let episodes = 0;
let unsized = 0;

for (const line of lines) {
  if (picked.length >= SIZE) break;
  const term = line.split('|')[0].trim();
  if (!term) continue;
  if (findShow(term)) {
    skippedStored++;
    continue;
  }
  const info = await tmdbShow(term, key);
  const total = info ? totalEpisodes(info) : 0;
  // 500 counts as out: Naruto Shippuden is exactly 500 and is deliberately not
  // fetched, so the cap is "500 or more", not "more than 500".
  if (info && total >= MAX_SHOW_EPISODES) {
    skippedBig++;
    continue;
  }
  if (!info) unsized++;
  episodes += total || 0;
  picked.push(line);
}

const OUT = nextOut();
writeFileSync(OUT, picked.join('\n') + '\n');

// One request per episode plus one search and one release page per season.
const requests = episodes + picked.length * 3;
const minutes = Math.round((requests / PER_SECOND) / 60);
console.log(`${picked.length} shows, ${episodes} episodes (~${requests} site requests)`);
console.log(`skipped: ${skippedStored} already stored, ${skippedBig} over ${MAX_SHOW_EPISODES} episodes`);
if (unsized) console.log(`note: ${unsized} had no TMDB match, so their episodes are not in the count`);
console.log(`-> ${OUT}`);
console.log(`estimate: ~${minutes} min of clean fetching at the current pace (add ~15 min per 429 wait)`);
