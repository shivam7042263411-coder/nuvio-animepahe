// Extracts SubstPlease's subtitles out of an AnimeTosho release page into
// subs/, where the plugin attaches the .ass to other groups' releases of the
// same episode. AnimeTosho ships them xz-compressed, and Nuvio only renders a
// subtitle as ASS when its URL ends in ".ass", so they have to be unpacked once
// and committed.
//
// usage: node tools/grab-subs.mjs "Bocchi the Rock" 1
//        node tools/grab-subs.mjs --view 393802
//        node tools/grab-subs.mjs --self-test
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SUBS = join(ROOT, 'subs');
const INDEX = join(SUBS, 'index.json');
const BASE = 'https://raw.githubusercontent.com/shivam7042263411-coder/nuvio-animepahe/main/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36';

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

/** The SubsPlease row for one episode, from the search page. */
export function pickRelease(html, episode) {
  const ep = String(episode).replace(/^0+(?=\d)/, '');
  const rows = String(html).split('class="home_list_entry').slice(1);
  for (const row of rows) {
    const title = (row.match(/<div class="link">\s*<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '';
    const view = (row.match(/\/view\/(\d+)/) || [])[1];
    if (!view || !/^\s*\[SubsPlease\]/i.test(title)) continue;
    if (/batch|complete|\b\d{1,4}\s*[-~]\s*\d{1,4}\b/i.test(title)) continue;
    if (!new RegExp(`(^|[\\s_-])0*${ep}(?!\\d)`).test(title)) continue;
    return { view, title: title.replace(/<[^>]+>/g, '').trim() };
  }
  return null;
}

/** The English .ass attachment id on a release page. */
export function pickAttachment(html) {
  const links = [...String(html).matchAll(/href="\/download\/(\d+)\/subs\/file\/(\d+)"[^>]*>([^<]*)</gi)];
  const ass = links.find((m) => /english/i.test(m[3]) && /ass/i.test(m[3]));
  const pick = ass || links.find((m) => /ass/i.test(m[3]));
  return pick ? pick[2] : null;
}

function xzDecode(buffer) {
  const out = spawnSync('xz', ['-dc'], { input: buffer });
  if (out.error) throw new Error('xz is required (brew install xz): ' + out.error.message);
  if (out.status !== 0) throw new Error('xz failed: ' + String(out.stderr).trim());
  return out.stdout;
}

function saveIndex(view, relPath) {
  const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : {};
  index[view] = relPath;
  const sorted = Object.fromEntries(Object.keys(index).sort().map((k) => [k, index[k]]));
  writeFileSync(INDEX, JSON.stringify(sorted, null, 2) + '\n');
  return Object.keys(sorted).length;
}

async function grab(view, label) {
  const page = await (await get(`https://animetosho.xyz/view/${view}`)).text();
  const file = pickAttachment(page);
  if (!file) throw new Error(`no ASS attachment on view/${view}`);
  const packed = Buffer.from(
    await (await get(`https://animetosho.xyz/download/${view}/subs/file/${file}`)).arrayBuffer()
  );
  const ass = xzDecode(packed);
  if (!/\[Script Info\]|\[Events\]/.test(ass.toString('utf8', 0, 400))) {
    throw new Error(`view/${view}: decoded file is not an .ass script`);
  }
  mkdirSync(join(SUBS, 'subsplease'), { recursive: true });
  const rel = `subs/subsplease/${view}.ass`;
  writeFileSync(join(ROOT, rel), ass);
  const total = saveIndex(view, rel);
  console.log(`${label}\n  ${rel}  (${ass.length} bytes, from ${packed.length} packed)`);
  console.log(`  ${BASE}${rel}`);
  console.log(`  index: ${total} episode(s)`);
}

async function selfTest() {
  const search =
    '<div class="home_list_entry"><div class="link"><a href="/view/393802">[SubsPlease] Bocchi the Rock! - 01 (480p) [3B0E348C].mkv</a></div></div>' +
    '<div class="home_list_entry"><div class="link"><a href="/view/1">[SubsPlease] Bocchi the Rock! (01-12) (480p) [Batch]</a></div></div>' +
    '<div class="home_list_entry"><div class="link"><a href="/view/2">[Erai-raws] Bocchi the Rock! - 01 [480p]</a></div></div>';
  const release = pickRelease(search, 1);
  console.log('release:', release);
  console.log('batch skipped:', pickRelease(search, 1).view === '393802');
  const page =
    '<a href="/download/393802/subs/all">All Attachments</a>' +
    '<a href="/download/393802/subs/file/2038171">English subs [eng, ASS]</a>' +
    '<a href="/download/393802/subs/file/2038170">Japanese subs [jpn, ASS]</a>';
  console.log('attachment:', pickAttachment(page), pickAttachment(page) === '2038171');
  if (pickAttachment(page) !== '2038171' || release.view !== '393802') process.exitCode = 1;
}

const args = process.argv.slice(2);
if (args[0] === '--self-test') {
  await selfTest();
} else if (args[0] === '--view') {
  await grab(args[1], `view ${args[1]}`);
} else if (args.length >= 2) {
  const [title, episode] = args;
  // AnimeTosho matches tokens, so a bare "1" finds nothing where "01" does.
  const query = `SubsPlease ${title} ${String(episode).padStart(2, '0')}`;
  const search = await (await get(`https://animetosho.xyz/search?q=${encodeURIComponent(query)}&type=torrent&order=seeders`)).text();
  const release = pickRelease(search, episode);
  if (!release) throw new Error(`no SubsPlease release for "${query}"`);
  await grab(release.view, release.title);
} else {
  console.error('usage: node tools/grab-subs.mjs "<show title>" <episode> | --view <id> | --self-test');
  process.exitCode = 1;
}
