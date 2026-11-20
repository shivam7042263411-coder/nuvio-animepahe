// What is airing this week: the catalogue says what we have, AniList says what
// is still running and when the next episode lands. Read-only, writes nothing.
//
// usage: node tools/weekly.mjs [--self-test]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold } from './harvest-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, '..', 'catalogue', 'index.json');
const PER_PAGE = 50;
const MAX_PAGES = 12; // bound the run; ~300 airing titles today
const PICK_SCORE = 70; // "good" for the suggestion list
const PICK_LIMIT = 15;
const PICK_WINDOW_DAYS = 7; // a suggestion must air this week, not just "still running"

// AniList is keyless and carries the airing schedule TMDB does not.
const QUERY = `query($page:Int){Page(page:$page,perPage:${PER_PAGE}){pageInfo{hasNextPage} media(type:ANIME,status:RELEASING,isAdult:false,sort:POPULARITY_DESC){id title{romaji english} synonyms format genres averageScore popularity nextAiringEpisode{episode airingAt}}}}`;

export async function airingNow() {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { page } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error('AniList HTTP ' + res.status);
    const json = await res.json();
    const media = (json.data && json.data.Page && json.data.Page.media) || [];
    out.push(...media);
    if (!(json.data.Page.pageInfo || {}).hasNextPage) break;
  }
  return out;
}

/** Every folded key a catalogue show answers to. The aliases the catalogue
 *  already carries are hand-added for exactly this mismatch, so they count. */
export function catalogueKeys(show) {
  return [show.title, ...(show.aliases || [])].map(fold).filter(Boolean);
}

/** Folded keys an AniList entry answers to (romaji, English, synonyms). */
export function mediaKeys(media) {
  return [media.title && media.title.romaji, media.title && media.title.english, ...(media.synonyms || [])]
    .map(fold)
    .filter(Boolean);
}

/** Split airing media into the ones we already have and the new ones worth a
 *  look. An exact folded name wins; failing that a continuation ("Blue Box
 *  Season 2" for "Blue Box") matches, but only when a single catalogue show
 *  owns the prefix, so a spin-off cannot be mislabelled (the rule tmdb.mjs
 *  already uses). */
export function split(shows, media) {
  const byKey = new Map();
  const keys = [];
  for (const s of shows) {
    for (const k of catalogueKeys(s)) {
      keys.push([k, s]);
      if (!byKey.has(k)) byKey.set(k, s);
    }
  }
  const byTitle = new Map(shows.map((s) => [s.title, s]));

  const matchOf = (m) => {
    const mk = mediaKeys(m);
    for (const k of mk) {
      const s = byKey.get(k);
      if (s) return { show: s, exact: true };
    }
    const owners = new Set();
    for (const [k, s] of keys) {
      if (owners.size > 1) break;
      if (mk.some((n) => n.startsWith(k + ' '))) owners.add(s.title);
    }
    return owners.size === 1 ? { show: byTitle.get([...owners][0]), exact: false } : null;
  };

  const have = new Map(); // catalogue title -> { show, exact, media }
  const picks = [];
  for (const m of media) {
    if (!m || !m.nextAiringEpisode || !m.nextAiringEpisode.airingAt) continue;
    const hit = matchOf(m);
    if (hit) {
      const prev = have.get(hit.show.title);
      if (!prev || m.nextAiringEpisode.airingAt < prev.media.nextAiringEpisode.airingAt) {
        have.set(hit.show.title, { ...hit, media: m });
      }
    } else if (
      (m.format === 'TV' || m.format === 'TV_SHORT') &&
      (m.averageScore || 0) >= PICK_SCORE
    ) {
      picks.push(m);
    }
  }
  picks.sort((a, b) => b.averageScore - a.averageScore || b.popularity - a.popularity);
  const airing = [...have.values()].sort(
    (a, b) => a.media.nextAiringEpisode.airingAt - b.media.nextAiringEpisode.airingAt
  );
  return { airing, picks };
}

const when = (t) =>
  new Date(t * 1000).toLocaleString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

async function main() {
  const index = JSON.parse(readFileSync(INDEX, 'utf8'));
  const media = await airingNow();
  const { airing, picks } = split(index.shows, media);

  console.log(`Airing now — ${airing.length} of your ${index.shows.length} catalogue shows`);
  for (const { media: m, exact } of airing) {
    const name = (m.title && (m.title.english || m.title.romaji)) || '?';
    console.log(
      `  ep ${String(m.nextAiringEpisode.episode).padStart(3)}  ${when(m.nextAiringEpisode.airingAt)}  ` +
        `${name}${exact ? '' : '  [new season]'}${m.averageScore ? '  (score ' + m.averageScore + ')' : ''}`
    );
  }

  // A suggestion is something to start now, so it must have an episode inside
  // the coming week - a show "still running" whose next episode is a month out
  // is not worth a slot here.
  const weekEnd = Date.now() / 1000 + PICK_WINDOW_DAYS * 86400;
  const thisWeek = picks.filter((m) => m.nextAiringEpisode.airingAt <= weekEnd);

  console.log(
    `\nNew airing picks — airing in the next ${PICK_WINDOW_DAYS} days ` +
      `(score ${PICK_SCORE}+, not in your catalogue)`
  );
  for (const m of thisWeek.slice(0, PICK_LIMIT)) {
    const name = (m.title && (m.title.english || m.title.romaji)) || '?';
    console.log(
      `  ep ${String(m.nextAiringEpisode.episode).padStart(3)}  ${when(m.nextAiringEpisode.airingAt)}  ` +
        `${name}  —  ${m.averageScore}  ${(m.genres || []).join(', ')}`
    );
  }
  const later = picks.length - thisWeek.length;
  if (later) {
    console.log(`  note: ${later} more scored ${PICK_SCORE}+ but their next episode is later than this week`);
  }
  console.log(`\n${media.length} airing titles scanned via AniList. [new season] = a season not in the catalogue yet.`);
}

function selfTest() {
  const shows = [
    { title: 'Re:Zero', aliases: ['Re:ZERO -Starting Life in Another World- Season 4'] },
    { title: 'Black Clover', aliases: ['Black Clover Season 2'] },
    { title: 'Blue Box', aliases: [] },
    { title: 'Naruto', aliases: [] },
    { title: 'Naruto Shippuden', aliases: [] },
  ];
  const media = [
    { title: { romaji: 'Re:Zero kara Hajimeru Isekai Seikatsu', english: 'Re:ZERO -Starting Life in Another World- Season 4' }, synonyms: [], nextAiringEpisode: { episode: 3, airingAt: 100 }, averageScore: 84, format: 'TV' },
    { title: { romaji: 'Black Clover 2nd Season', english: 'Black Clover Season 2' }, synonyms: [], nextAiringEpisode: { episode: 8, airingAt: 200 }, averageScore: 88, format: 'TV' },
    { title: { romaji: 'Ao no Hako 2nd Season', english: 'Blue Box Season 2' }, synonyms: [], nextAiringEpisode: { episode: 7, airingAt: 150 }, averageScore: 81, format: 'TV' },
    { title: { romaji: 'Naruto Shippuden Gaiden', english: 'Naruto Shippuden Gaiden' }, synonyms: [], nextAiringEpisode: { episode: 1, airingAt: 160 }, averageScore: 90, format: 'TV' },
    { title: { romaji: 'Kusuriya no Hitorigoto 3rd Season', english: 'The Apothecary Diaries Season 3' }, synonyms: [], nextAiringEpisode: { episode: 9, airingAt: 300 }, averageScore: 85, format: 'TV', genres: ['Drama'] },
    { title: { romaji: 'Weak Show', english: 'Weak Show' }, synonyms: [], nextAiringEpisode: { episode: 1, airingAt: 400 }, averageScore: 55, format: 'TV' },
    { title: { romaji: 'Finished', english: 'Finished' }, synonyms: [], nextAiringEpisode: null, averageScore: 90, format: 'TV' },
  ];
  const { airing, picks } = split(shows, media);
  const ok = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } };
  const names = airing.map((a) => a.show.title);
  ok(airing.length === 3, 'three catalogue shows air, got ' + names.join(', '));
  ok(names[0] === 'Re:Zero', 'nearest episode first, got ' + names[0]);
  ok(names.includes('Black Clover'), 'exact alias matched, got ' + names.join(', '));
  ok(names.includes('Blue Box'), 'continuation matched by prefix, got ' + names.join(', '));
  ok(airing.find((a) => a.show.title === 'Blue Box').exact === false, 'continuation is flagged not-exact');
  ok(airing.find((a) => a.show.title === 'Black Clover').exact === true, 'exact match is flagged exact');
  // "Naruto Shippuden Gaiden" prefixes both Naruto shows, so it stays a suggestion.
  ok(!names.includes('Naruto') && !names.includes('Naruto Shippuden'), 'ambiguous prefix is not matched');
  const pick = picks.map((p) => p.title.english);
  ok(pick.length === 2 && pick.includes('The Apothecary Diaries Season 3') && pick.includes('Naruto Shippuden Gaiden'), 'picks = new+good, got ' + pick.join(', '));
  console.log('weekly self-test ok');
}

process.argv.includes('--self-test') ? selfTest() : await main();
