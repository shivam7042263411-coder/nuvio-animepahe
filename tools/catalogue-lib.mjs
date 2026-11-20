// Shared read/write for catalogue/*.json. Used by build-catalogue.mjs,
// merge-log.mjs and harvest-batch.mjs. Node 18+, no dependencies.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CATALOGUE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'catalogue');
export const INDEX_FILE = 'index.json';

export const today = () => new Date().toISOString().slice(0, 10);

export function slug(value) {
  return (
    String(value)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'show'
  );
}

/** Mirrors the plugin's title normalizer, plus the repeated-letter fold that
 *  makes "Haikyu!!" and "Haikyuu!!" the same show. Keep the two in step. */
export function titleKey(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(.)\1+/g, '$1');
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function readCatalogue() {
  mkdirSync(CATALOGUE_DIR, { recursive: true });
  return readdirSync(CATALOGUE_DIR)
    .filter((f) => f.endsWith('.json') && f !== INDEX_FILE)
    .map((f) => ({ file: f, data: readJson(join(CATALOGUE_DIR, f)) }))
    .filter((s) => s.data && Array.isArray(s.data.rows));
}

export function findShow(title) {
  const key = titleKey(title);
  // The harvester names a file after the list term, so a show the site titles
  // differently ("Demon Slayer: Kimetsu no Yaiba") is still the same file.
  const file = `${slug(title)}.json`;
  return readCatalogue().find(
    (s) =>
      s.file === file ||
      titleKey(s.data.title) === key ||
      (s.data.aliases || []).some((a) => titleKey(a) === key)
  );
}

/** A row the plugin can serve: sub audio at a real resolution. The harvester
 *  keeps the best resolution each episode has, so a show the site only offers
 *  in 720p still plays instead of being dropped from the catalogue. */
export const isSubRow = (row) =>
  Boolean(row) && Number(row.q) > 0 && row.a === 'sub' && Boolean(row.id);

/** One row per episode: the highest resolution the site offered for it. */
export function bestSubRows(rows) {
  const best = new Map();
  for (const row of rows || []) {
    if (!isSubRow(row) || !(Number(row.e) >= 1)) continue;
    const key = `${row.s}/${row.e}`;
    const held = best.get(key);
    if (!held || Number(row.q) > Number(held.q)) best.set(key, row);
  }
  return [...best.values()];
}

/** Add/replace rows keyed by s/e/q/a. A newer id for the same key wins: the
 *  old one is the one that stopped resolving. */
export function mergeRows(show, rows) {
  const byKey = new Map();
  for (const row of show.rows || []) byKey.set(`${row.s}/${row.e}/${row.q}/${row.a}`, row);
  for (const row of rows) {
    if (!row || !row.id) continue;
    const key = `${row.s}/${row.e}/${row.q}/${row.a}`;
    byKey.set(key, { ...(byKey.get(key) || {}), ...row });
  }
  show.rows = [...byKey.values()].sort(
    (a, b) =>
      a.s - b.s ||
      a.e - b.e ||
      a.q - b.q ||
      String(a.a).localeCompare(String(b.a))
  );
  return show;
}

export function writeShow(file, data) {
  mkdirSync(CATALOGUE_DIR, { recursive: true });
  data.rows = bestSubRows(data.rows);
  data.updated = today();
  writeFileSync(join(CATALOGUE_DIR, file), JSON.stringify(data, null, 2) + '\n');
  return join(CATALOGUE_DIR, file);
}

/** index.json is derived, never hand-edited: rebuild it after every write. */
export function rebuildIndex() {
  const shows = readCatalogue()
    .map(({ file, data }) => ({
      file,
      title: data.title,
      aliases: data.aliases || [],
      season: data.season || 1,
      year: data.year || null,
    }))
    .filter((s) => s.title)
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const path = join(CATALOGUE_DIR, INDEX_FILE);
  writeFileSync(path, JSON.stringify({ version: 1, updated: today(), shows }, null, 2) + '\n');
  return { path, shows };
}