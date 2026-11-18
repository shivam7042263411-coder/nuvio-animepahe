// Build a curated harvest list from TMDB: Japanese animation, quality-gated,
// grouped by genre. Output is the same format the harvester reads
// (term | maxEpisodes | appSeason | episodeOffset | resultIndex | appTitle).
//
// The gate is audience size plus rating, never popularity alone:
//   200+ votes at 6.5, or 50+ votes at 7.0.
// Below that the list turns into obscure filler, so the tail is opt-in.
//
// usage: node tools/build-show-list.mjs [maxShows] [outFile] [--include-tail]
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmdbKey } from './tmdb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const INCLUDE_TAIL = args.includes('--include-tail');
const nums = args.filter((a) => !a.startsWith('--'));
const LIMIT = Number(nums[0] || 2000);
const OUT = nums[1] || join(HERE, 'shows-curated.txt');
const KEY = tmdbKey();
if (!KEY) {
  console.error('no TMDB key: put one in tools/.tmdb-key or set TMDB_API_KEY');
  process.exit(1);
}

const HOSTS = ['https://api.tmdb.org/3', 'https://api.themoviedb.org/3'];
let host = null;
async function get(path) {
  const order = host ? [host, ...HOSTS.filter((h) => h !== host)] : HOSTS;
  for (const h of order) {
    try {
      const res = await fetch(h + path + (path.includes('?') ? '&' : '?') + 'api_key=' + KEY);
      if (!res.ok) continue;
      host = h;
      return await res.json();
    } catch {}
  }
  throw new Error('TMDB unreachable: ' + path);
}

async function discover(kind, params, maxPages) {
  const out = [];
  for (let p = 1; p <= maxPages; p++) {
    const j = await get('/discover/' + kind + '?' + params + '&page=' + p);
    const rows = j.results || [];
    if (!rows.length) break;
    out.push(...rows);
    if (p >= (j.total_pages || 1)) break;
  }
  return out;
}

const flag = 'with_original_language=ja&with_genres=16&include_adult=false';
const QUALITY = [
  ['tv', `${flag}&vote_count.gte=200&vote_average.gte=6.5&sort_by=popularity.desc`, 20],
  ['tv', `${flag}&vote_count.gte=50&vote_average.gte=7.0&sort_by=popularity.desc`, 50],
  ['movie', `${flag}&vote_count.gte=200&vote_average.gte=6.5&sort_by=popularity.desc`, 15],
  ['movie', `${flag}&vote_count.gte=50&vote_average.gte=7.0&sort_by=popularity.desc`, 25],
];
const TAIL = [
  ['tv', `${flag}&vote_count.gte=20&vote_average.gte=6.5&sort_by=popularity.desc`, 70],
  ['movie', `${flag}&vote_count.gte=20&vote_average.gte=6.5&sort_by=popularity.desc`, 30],
];

const folded = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const seen = new Map();
const nameOf = (r) => String(r.name || r.title || '').trim();
async function collect(passes) {
  for (const [kind, params, pages] of passes) {
    for (const r of await discover(kind, params, pages)) {
      if (!r || !r.id || !nameOf(r)) continue;
      const key = kind + '|' + folded(nameOf(r));
      if (!seen.has(key)) seen.set(key, { ...r, kind, label: nameOf(r) });
    }
  }
}
await collect(QUALITY);
const qualityCount = seen.size;
if (INCLUDE_TAIL) await collect(TAIL);

// Isekai is a keyword, not a genre; ask TMDB for its id so those shows land in
// one group instead of being scattered through fantasy.
let isekaiIds = new Set();
try {
  const kw = await get('/search/keyword?query=isekai');
  const id = ((kw.results || [])[0] || {}).id;
  if (id) {
    const rows = await discover(
      'tv',
      `with_keywords=${id}&${flag}&vote_count.gte=50&sort_by=popularity.desc`,
      6
    );
    isekaiIds = new Set(rows.map((r) => r.id));
  }
} catch {}

const all = [...seen.values()];
const series = all.filter((r) => r.kind === 'tv');
const films = all.filter((r) => r.kind === 'movie');
// A film sharing a series' name would overwrite that series' catalogue file.
const seriesNames = new Set(series.map((r) => folded(r.label)));
const keptFilms = films.filter((r) => !seriesNames.has(folded(r.label)));

const GROUPS = [
  ['Isekai', null],
  ['Action & Adventure', 10759],
  ['Sci-Fi & Fantasy', 10765],
  // TMDB has no Romance genre for TV (only for films), so romance anime are
  // already inside Comedy and Drama; adding 10749 here would be a dead section.
  ['Comedy', 35],
  ['Drama', 18],
  ['Mystery', 9648],
];
const genreName = Object.fromEntries(GROUPS.filter(([, id]) => id).map(([n, id]) => [id, n]));

const qualitySet = new Set(
  [...seen.values()].slice(0, qualityCount).map((r) => r.kind + '|' + r.id)
);
// The first group in GROUPS order that fits, so a romance comedy is filed as
// romance and an isekai is never lost among the action shows.
const groupOf = (r) => {
  if (isekaiIds.has(r.id)) return 'Isekai';
  const has = new Set(r.genre_ids || []);
  for (const [name, id] of GROUPS) {
    if (id != null && has.has(id)) return name;
  }
  return 'Other';
};

const buckets = new Map(GROUPS.map(([n]) => [n, []]).concat([['Other', []], ['Films', []]]));
const tail = new Map();
for (const r of [...series, ...keptFilms]) {
  const target = r.kind === 'movie' ? 'Films' : groupOf(r);
  const bucket = qualitySet.has(r.kind + '|' + r.id) ? buckets : tail;
  if (!bucket.has(target)) bucket.set(target, []);
  bucket.get(target).push(r);
}

const lines = [];
let total = 0;
const write = (title, rows) => {
  if (!rows.length) return;
  const room = LIMIT - total;
  if (room <= 0) return;
  const take = rows.slice(0, room);
  total += take.length;
  lines.push('', '## ' + title + ' (' + take.length + ')');
  for (const r of take) {
    // Films are one row (S1E1); series get every episode, every season.
    lines.push(`${r.label} | ${r.kind === 'movie' ? 1 : 0} | 1 | 0`);
  }
};
for (const [name] of GROUPS) write(name, buckets.get(name));
write('Other', buckets.get('Other'));
write('Films', buckets.get('Films'));
if (INCLUDE_TAIL) {
  for (const [name] of GROUPS) write('More: ' + name, tail.get(name) || []);
  write('More: Other', tail.get('Other') || []);
  write('More: Films', tail.get('Films') || []);
}

if (total < LIMIT) {
  console.error(
    `only ${total} passed the gate (asked for ${LIMIT})` +
      (INCLUDE_TAIL ? '' : ' - pass --include-tail to add the lower-rated ones')
  );
}
writeFileSync(
  OUT,
  [
    '# Curated from TMDB: Japanese animation, 200+ votes at 6.5 or 50+ at 7.0.',
    '# Grouped by genre. Delete any line you do not want.',
    '# term | maxEpisodes | appSeason | episodeOffset | resultIndex | appTitle',
    ...lines,
    '',
  ].join('\n')
);
const filmsWritten = lines.filter((l) => / \| 1 \| 1 \| 0$/.test(l)).length;
console.log(
  `wrote ${total} entries to ${OUT} (${filmsWritten} films, ${total - filmsWritten} series)` +
    (INCLUDE_TAIL ? ' including the lower-rated tail' : '')
);