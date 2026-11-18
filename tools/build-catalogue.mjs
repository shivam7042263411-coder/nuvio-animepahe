// Import probe/ids-*.json into catalogue/. Idempotent: rows merge by s/e/q/a,
// so re-running after a new harvest only adds what changed.
//
// usage: node tools/build-catalogue.mjs [ids.json ...]
//        (default: ../probe/ids-*.json)
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CATALOGUE_DIR,
  findShow,
  mergeRows,
  readJson,
  rebuildIndex,
  slug,
  writeShow,
} from './catalogue-lib.mjs';

const args = process.argv.slice(2);
// The probes live one level above the plugin repo in this workspace, but a
// checkout that carries its own probe/ folder wins.
const probeDir = [join(CATALOGUE_DIR, '..', 'probe'), join(CATALOGUE_DIR, '..', '..', 'probe')].find(
  (dir) => existsSync(dir)
);
const files = args.length
  ? args
  : (probeDir ? readdirSync(probeDir).filter((f) => /^ids-.*\.json$/.test(f)).map((f) => join(probeDir, f)) : []);

if (!files.length) {
  console.error('no ids-*.json files found; pass paths explicitly');
  process.exit(1);
}

for (const file of files) {
  const probe = readJson(file);
  if (!probe || !probe.show || !Array.isArray(probe.rows)) {
    console.error(`skip ${file}: not a harvest file`);
    continue;
  }
  const existing = findShow(probe.show.title);
  const name = existing ? existing.file : `${slug(probe.show.title)}.json`;
  const show = existing
    ? existing.data
    : {
        title: probe.show.title,
        aliases: [],
        season: probe.rows[0] ? probe.rows[0].s : 1,
        year: probe.show.year || null,
      };

  show.title = show.title || probe.show.title;
  show.year = probe.show.year || show.year || null;
  show.source = 'animepahe';
  if (probe.show.session) show.session = probe.show.session;
  if (probe.show.episodes != null) show.episodes = probe.show.episodes;

  mergeRows(show, probe.rows);
  console.log(`${writeShow(name, show)}  ${show.rows.length} row(s)`);
}

const { path, shows } = rebuildIndex();
console.log(`\n${path}  ${shows.length} show(s)`);