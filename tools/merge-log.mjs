// Merge the plugin's `kwik-id {json}` log lines into catalogue/.
// The box is read-only; this is the only writer.
//
// usage: node tools/merge-log.mjs <logfile> [...]
//    or: adb logcat -d | node tools/merge-log.mjs -      (reads stdin)
import { readFileSync } from 'node:fs';
import {
  findShow,
  mergeRows,
  rebuildIndex,
  slug,
  titleKey,
  writeShow,
} from './catalogue-lib.mjs';

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('usage: node tools/merge-log.mjs <logfile> [...]  (or - for stdin)');
  process.exit(1);
}

const lines = inputs.flatMap((path) =>
  (path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8')).split('\n')
);

const groups = new Map();
let seen = 0;
for (const line of lines) {
  const m = line.match(/kwik-id (\{.*\})\s*$/);
  if (!m) continue;
  let row;
  try {
    row = JSON.parse(m[1]);
  } catch {
    continue;
  }
  if (!row || !row.id || !row.title) continue;
  if (!/^[A-Za-z0-9]{8,16}$/.test(row.id)) {
    console.error(`skip odd id ${JSON.stringify(row.id)} (${row.title})`);
    continue;
  }
  seen++;
  const key = titleKey(row.title);
  if (!groups.has(key)) groups.set(key, { title: row.title, rows: [] });
  groups.get(key).rows.push({
    s: Number(row.s) || 1,
    e: Number(row.e) || 1,
    q: Number(row.q) || 0,
    a: row.a === 'dub' ? 'dub' : 'sub',
    id: row.id,
  });
}

if (!groups.size) {
  console.error('no kwik-id lines found');
  process.exit(1);
}

for (const { title, rows } of groups.values()) {
  const existing = findShow(title);
  const name = existing ? existing.file : `${slug(title)}.json`;
  const show = existing
    ? existing.data
    : { title, aliases: [], season: rows[0].s, year: null, source: 'animepahe' };
  const before = (show.rows || []).length;
  mergeRows(show, rows);
  writeShow(name, show);
  const episodes = new Set(show.rows.map((r) => `${r.s}/${r.e}`)).size;
  console.log(
    `${existing ? 'updated' : 'created'} ${name}: ${before} -> ${show.rows.length} row(s), ${episodes} episode(s)`
  );
}

const { path, shows } = rebuildIndex();
console.log(`\n${seen} id line(s) in ${groups.size} show(s) -> ${path} (${shows.length} show(s))`);
console.log('push catalogue/ to GitHub for the TV to see it.');