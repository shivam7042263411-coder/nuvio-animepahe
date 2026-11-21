// Will these play? The plugin matches the app's title to a catalogue file by an
// exact folded key, so a file whose title is not the name the app asks with is
// skipped (the plugin then scrapes, which is slow and fails when the site is
// blocked). This compares each title against TMDB, which is what the app uses.
//
//   node tools/audit-playback.mjs              # every stored show
//   node tools/audit-playback.mjs list.txt     # a shows list, before fetching
import { readdirSync, readFileSync } from 'node:fs';
import { tmdbShow, tmdbKey } from './tmdb.mjs';

// Keep in step with catalogueKey() in animepahe.js.
const key = (v) =>
  String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/(.)\1+/g, '$1');

const path = process.argv[2];
const rows = path
  ? readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const [term, , , , , catTitle] = l.split('|').map((s) => (s || '').trim());
        return { title: catTitle || term, search: term };
      })
  : readdirSync('catalogue')
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => JSON.parse(readFileSync('catalogue/' + f, 'utf8')));

const withRetry = async (t) => {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await tmdbShow(t, tmdbKey());
      if (r) return r;
    } catch {}
    await new Promise((s) => setTimeout(s, 600));
  }
  return null;
};

let i = 0;
const out = new Array(rows.length);
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (i < rows.length) {
      const n = i++;
      out[n] = { row: rows[n], info: await withRetry(rows[n].search) };
    }
  })
);

let bad = 0;
let films = 0;
for (const { row, info } of out) {
  if (!info) {
    // TMDB's TV search cannot see films (Your Name, A Silent Voice), so this is
    // not a verdict on them: only the app's own metadata can settle those.
    films++;
    console.log('  unverified (no TV match): ' + row.title);
    continue;
  }
  const names = [row.title, ...(row.aliases || [])].map(key);
  if (names.includes(key(info.name))) continue;
  bad++;
  console.log(`  MISMATCH  ${row.title}   -> the app asks for "${info.name}"`);
}
console.log(
  `\n  ${rows.length} titles | ${bad} would miss the catalogue | ${films} unverified (films/odd entries)`
);