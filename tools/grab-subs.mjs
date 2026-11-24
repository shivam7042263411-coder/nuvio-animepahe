// Extracts a typeset group's subtitles out of an AnimeTosho release page into
// subs/, where the plugin attaches them to other groups' releases of the same
// episode. AnimeTosho ships them xz-compressed and QuickJS has no xz decoder, so
// they have to be unpacked once and committed.
//
// They are committed as SRT, not ASS. Nuvio restyles SRT with the user's
// subtitle appearance on every platform, while ASS is drawn by a different
// renderer per platform (Android libass, mpv on desktop and iOS) with its own
// font lookup and rasterisation, so one file looks different on each device.
// Converting drops the typesetting and keeps the track consistent.
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

/** Lowercase, punctuation-free form, same as the plugin's normTitle. */
function normTitle(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Release words that are packaging, not the show's name. */
const NOISE = new Set([
  'mkv', 'mp4', 'avi', 'web', 'webrip', 'webdl', 'bd', 'bluray', 'bdr', 'aac', 'flac', 'opus',
  'h264', 'h265', 'x264', 'x265', 'hevc', 'av1', '10bit', '8bit', 'aac2', 'dual', 'audio',
  'multi', 'sub', 'subs', 'subtitle', 'subtitles', 'eng', 'jpn', 'hard', 'soft', 'repack',
]);

/** The group's single-episode rows for one episode, best first, from the search
 *  page. Relevance is whole-phrase containment, the plugin's proven rule: word
 *  overlap would accept a spin-off of the same show ("Shingeki! Kyojin
 *  Chuugakkou" for "Shingeki no Kyojin" shares two words but is a different
 *  series, and the phrase is not in its name). Rows that add words before the
 *  episode number - an OVA's own subtitle - are ranked last, so the plain "- 01"
 *  wins; AnimeTosho's `serieslink` cannot do that job because it truncates long
 *  titles. `titles` is every name the show is known by, English and romaji. */
export function pickRelease(html, episode, group = 'SubsPlease', titles = []) {
  const ep = String(episode).replace(/^0+(?=\d)/, '');
  const tag = new RegExp(`^\\s*\\[${group.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'i');
  const variants = (Array.isArray(titles) ? titles : [titles]).map(normTitle).filter(Boolean);
  const rows = String(html).split('class="home_list_entry').slice(1);
  const candidates = [];
  for (const row of rows) {
    const raw = (row.match(/<div class="link">\s*<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '';
    const view = (row.match(/\/view\/(\d+)/) || [])[1];
    if (!view || !tag.test(raw)) continue;
    // Decode first: AnimeTosho writes apostrophes as &#39;, so a filter on the
    // raw text misses "Director&#39;s Cut".
    const clean = decodeEntities(raw.replace(/<[^>]+>/g, '').trim());
    if (/batch|complete|\b\d{1,4}\s*[-~]\s*\d{1,4}\b/i.test(clean)) continue;
    // A re-cut, a sidestory, or a season pack is a different timeline.
    if (/\b(?:ova|oad)s?\b|\b(?:special|specials|recap|picture drama|chibi|junior high)\b|director'?s cut|kanketsu|\bseason\s*\d|\bpart\s*\d/i.test(clean)) continue;
    if (!new RegExp(`(^|[\\s_-])0*${ep}(?!\\d)`).test(clean)) continue;
    const padded = ' ' + normTitle(clean) + ' ';
    // Longest variant wins, so the most specific name is the one that matched.
    const hit = variants.filter((v) => padded.indexOf(' ' + v + ' ') !== -1).sort((a, b) => b.length - a.length)[0];
    if (variants.length && !hit) continue;
    // Words between the show name and the episode number: 0 for "[Show] - 01 [1080p]".
    const rest = (hit ? padded.replace(' ' + hit + ' ', ' ') : padded).trim();
    const extra = rest
      .split(' ')
      .filter((w) => w && !NOISE.has(w) && !/^0*\d+$/.test(w) && !/^\d+[pP]$/.test(w)).length;
    candidates.push({ view, title: clean, extra });
  }
  if (!candidates.length) return null;
  // Stable sort: equal-shape releases keep AnimeTosho's own (seeder) order.
  return candidates.slice().sort((a, b) => a.extra - b.extra);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** The English .ass attachment id on a release page, or null. */
export function pickAttachment(html) {
  const links = [...String(html).matchAll(/href="\/download\/(\d+)\/subs\/file\/(\d+)"[^>]*>([^<]*)</gi)];
  const ass = links.find((m) => /english/i.test(m[3]) && /ass/i.test(m[3]));
  const pick = ass || links.find((m) => /ass/i.test(m[3]));
  return pick ? pick[2] : null;
}

/** Downloads one release's subtitles into subs/<group>/<view>.srt. */
async function fetchSubtitles(view) {
  const page = await (await get(`https://animetosho.xyz/view/${view}`)).text();
  const file = pickAttachment(page);
  if (!file) return null;
  const packed = Buffer.from(
    await (await get(`https://animetosho.xyz/download/${view}/subs/file/${file}`)).arrayBuffer()
  );
  const ass = xzDecode(packed);
  if (!/\[Script Info\]|\[Events\]/.test(ass.toString('utf8', 0, 400))) {
    throw new Error(`view/${view}: decoded file is not an .ass script`);
  }
  return ass;
}

function save(view, ass, group) {
  const slug = group.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const srt = assToSrt(ass);
  if (!srt) throw new Error(`view/${view}: no dialogue left after converting to SRT`);
  mkdirSync(join(SUBS, slug), { recursive: true });
  const rel = `subs/${slug}/${view}.srt`;
  writeFileSync(join(ROOT, rel), srt);
  const total = saveIndex(view, rel);
  console.log(`  ${rel}  (${srt.length} bytes)`);
  console.log(`  ${BASE}${rel}`);
  console.log(`  index: ${total} episode(s)`);
}

/** ASS script -> SRT. Only the dialogue text survives: override blocks
 *  (`{\pos..}`, `{\fs..}`, `{\p1}` drawings) and the style table are dropped,
 *  so Nuvio's subtitle appearance decides how the track looks on every
 *  platform instead of each platform's libass. */
export function assToSrt(ass) {
  const cues = [];
  let inEvents = false;
  let fields = null;
  for (const raw of String(ass).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      fields = line.slice(line.indexOf(':') + 1).split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    const textAt = fields ? fields.indexOf('text') : -1;
    if (textAt < 0 || !/^dialogue\s*:/i.test(line)) continue;
    const values = line.slice(line.indexOf(':') + 1).split(',');
    const field = (name) => {
      const i = fields.indexOf(name);
      return i < 0 ? '' : (values[i] || '').trim();
    };
    const start = srtTime(field('start'));
    const end = srtTime(field('end'));
    const body = srtText(values.slice(textAt).join(','));
    if (start && end && body) cues.push({ start, end, body });
  }
  cues.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  return cues.map((cue, i) => `${i + 1}\n${cue.start} --> ${cue.end}\n${cue.body}\n`).join('\n');
}

/** `0:01:02.50` -> `00:01:02,500`, or null when the field is not a timestamp. */
function srtTime(value) {
  const m = String(value).match(/^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/);
  if (!m) return null;
  const pad = (n) => String(Number(n)).padStart(2, '0');
  return `${pad(m[1])}:${pad(m[2])}:${pad(m[3])},${(m[4] + '00').slice(0, 3)}`;
}

/** Dialogue text without ASS markup. Drawings (`\p1`..`\p9`) are shapes, not
 *  text, so their cue is dropped rather than committed as garbage. */
function srtText(value) {
  if (/\\p[1-9]/.test(value)) return '';
  return value
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/gi, '\n')
    .replace(/\\h/gi, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

async function grab(view, label, group = 'subsplease') {
  const ass = await fetchSubtitles(view);
  if (!ass) throw new Error(`no ASS attachment on view/${view}`);
  console.log(label);
  save(view, ass, group);
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

async function selfTest() {
  const row = (view, title, series) =>
    '<div class="home_list_entry"><div class="link"><a href="/view/' +
    view +
    '">' +
    title +
    '</a></div>' +
    (series ? '<span class="serieslink"><a href="/series/1" title="' + series + '">' + series + '</a></span>' : '') +
    '</div>';
  const search =
    row('393802', '[SubsPlease] Bocchi the Rock! - 01 (480p) [3B0E348C].mkv', 'Bocchi the Rock! (2022)') +
    row('1', '[SubsPlease] Bocchi the Rock! (01-12) (480p) [Batch]', 'Bocchi the Rock! (2022)') +
    row('2', '[Erai-raws] Bocchi the Rock! - 01 [480p]', 'Bocchi the Rock! (2022)') +
    row('168587', '[HorribleSubs] Black Clover - 01 [1080p].mkv', 'Black Clover (2017)');
  const page =
    '<a href="/download/393802/subs/all">All Attachments</a>' +
    '<a href="/download/393802/subs/file/2038171">English subs [eng, ASS]</a>' +
    '<a href="/download/393802/subs/file/2038170">Japanese subs [jpn, ASS]</a>' +
    '<a href="/download/168587/subs/file/653201">eng [ASS]</a>';
  // Real rows for the traps. AnimeTosho files the spin-off and the OVA under
  // their own series titles, which is what lets the matcher tell them apart.
  const traps =
    row('135157', '[HorribleSubs] Shingeki! Kyojin Chuugakkou - 01 [1080p].mkv', 'Shingeki! Kyojin Chuugakkou') +
    row('32116', '[HorribleSubs] Shingeki no Kyojin - 01 [720p].mkv', 'Shingeki no Kyojin') +
    row('82452', '[HorribleSubs] Shingeki no Kyojin - Season 1 [480p]', 'Shingeki no Kyojin') +
    row('125374', '[HorribleSubs] Kono Subarashii Sekai ni Shukufuku wo! - 01 [480p].mkv', 'Kono Subarashii Sekai ni Shukufuku o! (2016)') +
    row('253188', '[HorribleSubs] Re Zero kara Hajimeru Isekai Seikatsu - Director&#39;s Cut - 01 [1080p].mkv', 'Re Zero kara Hajimeru Isekai Seikatsu') +
    row('258605', '[HorribleSubs] Boku no Hero Academia - Ikinokore! Kesshi no Survival Kunren - 01 [480p].mkv', 'Boku no Hero Academia: Ikinokore! Kesshi no Survival Kunren') +
    row('155855', '[HorribleSubs] Boku no Hero Academia - 01 [480p].mkv', 'Boku no Hero Academia');
  const best = (html, ep, group, titles) => {
    const views = (pickRelease(html, ep, group, titles) || []).map((c) => c.view);
    return views.length ? views : null;
  };
  const first = (html, ep, group, titles) => best(html, ep, group, titles)?.[0] ?? null;
  const checks = [
    ['SubsPlease single skipped the batch', best(search, 1, 'SubsPlease', 'Bocchi the Rock'), ['393802']],
    // The pre-2021 group has to be selectable, or every old show is unreachable.
    ['HorribleSubs single found', best(search, 1, 'HorribleSubs', 'Black Clover'), ['168587']],
    ['a group with no row returns null', pickRelease(search, 1, 'AnoZu', 'Bocchi'), null],
    ['group match is exact, not substring', pickRelease(search, 1, 'Horrible'), null],
    ['english ASS attachment', pickAttachment(page), '2038171'],
    // The spin-off and the OVA are different shows; the phrase rule and the
    // "extra words before the episode" ranking reject them.
    ['spin-off is not the show', best(traps, 1, 'HorribleSubs', 'Shingeki no Kyojin'), ['32116']],
    ['english name finds no series here', best(traps, 1, 'HorribleSubs', 'Attack on Titan'), null],
    ['plain episode beats the OVA title', first(traps, 1, 'HorribleSubs', 'Boku no Hero Academia'), '155855'],
    // English query, romaji release: Kitsu supplies the variant that matches.
    ['romaji variant resolves the English query', best(traps, 1, 'HorribleSubs', ['Konosuba', 'Kono Subarashii Sekai ni Shukufuku wo!']), ['125374']],
    // A re-cut and a season pack are different timelines, never episode N.
    ['re-cut is not the episode', best(traps, 1, 'HorribleSubs', ['Re:Zero', 'Re Zero kara Hajimeru Isekai Seikatsu']), null],
    ['season pack is not the episode', first(traps, 1, 'HorribleSubs', 'Shingeki no Kyojin'), '32116'],
    // The committed track is SRT so Nuvio's own subtitle style draws it on every
    // platform; override blocks, drawings and the style table must not leak in.
    [
      'ASS dialogue converts to plain SRT',
      assToSrt(
        [
          '[Script Info]',
          'ScriptType: v4.00+',
          '[V4+ Styles]',
          'Format: Name, Fontname, Fontsize',
          'Style: Default,Roboto Medium,26',
          '[Events]',
          'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
          'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\pos(320,300)\\fs26}Hello, world',
          'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,line one\\Nline two',
          'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0{\\p0}',
          'Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,not a cue',
        ].join('\n')
      ),
      '1\n00:00:01,000 --> 00:00:02,500\nHello, world\n\n2\n00:00:03,000 --> 00:00:04,000\nline one\nline two\n',
    ],
  ];
  for (const [name, actual, expected] of checks) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} (${JSON.stringify(actual)})`);
    if (!ok) process.exitCode = 1;
  }
}

/** Every name Kitsu knows the show by, so an English query reaches the romaji a
 *  release actually prints ("Konosuba" -> "Kono Subarashii Sekai ni Shukufuku
 *  wo!"). Falls back to the query alone if Kitsu has nothing. */
async function titlesFor(title) {
  try {
    const res = await get(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`);
    const first = (await res.json()).data?.[0]?.attributes;
    if (!first) return [title];
    const t = first.titles || {};
    return [t.en_jp, t.en, first.canonicalTitle, title].filter(Boolean);
  } catch (e) {
    console.error(`  (Kitsu lookup failed: ${e.message}; matching on "${title}" only)`);
    return [title];
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
  const candidates = pickRelease(search, episode, group, await titlesFor(title));
  if (!candidates) {
    // Better a clear stop than the wrong show's script silently indexed.
    throw new Error(`no ${group} release for "${query}" (not the show, or only a spin-off/re-cut/season pack?)`);
  }
  // Only step down between equally-shaped candidates. A candidate that adds
  // words before the episode number is a different thing (an OVA's own title),
  // so falling back to it would file the wrong script under the episode.
  const sameShape = candidates.filter((c) => c.extra === candidates[0].extra);
  let saved = false;
  for (const [i, c] of sameShape.entries()) {
    const ass = await fetchSubtitles(c.view);
    if (!ass) {
      console.error(`  skipping ${c.title} (no extracted subtitles)`);
      continue;
    }
    if (i) console.error(`  picked candidate #${i + 1} of ${sameShape.length}`);
    console.log(c.title);
    save(c.view, ass, group);
    saved = true;
    break;
  }
  if (!saved) throw new Error(`no ${group} subtitles extracted for "${query}"`);
} else {
  console.error('usage: node tools/grab-subs.mjs <Group> "<show title>" <episode> | --view <id> | --self-test');
  process.exitCode = 1;
}
