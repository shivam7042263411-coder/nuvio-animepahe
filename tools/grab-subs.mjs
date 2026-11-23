// Extracts a typeset group's subtitles out of an AnimeTosho release page into
// subs/, where the plugin attaches the .ass to other groups' releases of the
// same episode. AnimeTosho ships them xz-compressed, and Nuvio only renders a
// subtitle as ASS when its URL ends in ".ass", so they have to be unpacked once
// and committed.
//
// SubsPlease covers 2021+; HorribleSubs is the same pipeline for everything
// before that, so both are searchable. The group is the first argument, in
// brackets, exactly as it appears in release names.
//
// usage: node tools/grab-subs.mjs SubsPlease "Bocchi the Rock" 1
//        node tools/grab-subs.mjs HorribleSubs "Hyouka" 1
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

/** The group's single-episode row for one episode, from the search page. */
export function pickRelease(html, episode, group = 'SubsPlease') {
  const ep = String(episode).replace(/^0+(?=\d)/, '');
  const tag = new RegExp(`^\\s*\\[${group.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'i');
  const rows = String(html).split('class="home_list_entry').slice(1);
  for (const row of rows) {
    const title = (row.match(/<div class="link">\s*<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '';
    const view = (row.match(/\/view\/(\d+)/) || [])[1];
    if (!view || !tag.test(title)) continue;
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

async function grab(view, label, group = 'subsplease') {
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
  const slug = group.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  mkdirSync(join(SUBS, slug), { recursive: true });
  const rel = `subs/${slug}/${view}.ass`;
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
    '<div class="home_list_entry"><div class="link"><a href="/view/2">[Erai-raws] Bocchi the Rock! - 01 [480p]</a></div></div>' +
    '<div class="home_list_entry"><div class="link"><a href="/view/168587">[HorribleSubs] Black Clover - 01 [1080p].mkv</a></div></div>';
  const page =
    '<a href="/download/393802/subs/all">All Attachments</a>' +
    '<a href="/download/393802/subs/file/2038171">English subs [eng, ASS]</a>' +
    '<a href="/download/393802/subs/file/2038170">Japanese subs [jpn, ASS]</a>' +
    '<a href="/download/168587/subs/file/653201">eng [ASS]</a>';
  const checks = [
    ['SubsPlease single skipped the batch', pickRelease(search, 1, 'SubsPlease').view, '393802'],
    // The pre-2021 group has to be selectable, or every old show is unreachable.
    ['HorribleSubs single found', pickRelease(search, 1, 'HorribleSubs').view, '168587'],
    ['a group with no row returns null', pickRelease(search, 1, 'AnoZu'), null],
    ['group match is exact, not substring', pickRelease(search, 1, 'Horrible'), null],
    ['english ASS attachment', pickAttachment(page), '2038171'],
  ];
  for (const [name, actual, expected] of checks) {
    const ok = actual === expected;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} (${JSON.stringify(actual)})`);
    if (!ok) process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
if (args[0] === '--self-test') {
  await selfTest();
} else if (args[0] === '--view') {
  await grab(args[1], `view ${args[1]}`);
} else if (args.length >= 3) {
  const [group, title, episode] = args;
  // AnimeTosho matches tokens, so a bare "1" finds nothing where "01" does.
  const query = `${group} ${title} ${String(episode).padStart(2, '0')}`;
  const search = await (await get(`https://animetosho.xyz/search?q=${encodeURIComponent(query)}&type=torrent&order=seeders`)).text();
  const release = pickRelease(search, episode, group);
  if (!release) throw new Error(`no ${group} release for "${query}"`);
  await grab(release.view, release.title, group);
} else {
  console.error('usage: node tools/grab-subs.mjs <Group> "<show title>" <episode> | --view <id> | --self-test');
  process.exitCode = 1;
}
