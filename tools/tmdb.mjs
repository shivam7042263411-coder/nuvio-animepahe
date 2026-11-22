// TMDB is the season oracle: the app numbers episodes by TMDB's seasons, so a
// site entry can be filed under the right season even when its title names an
// arc instead of a number ("Jujutsu Kaisen: Culling Game").
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold } from './harvest-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Some networks resolve only one of these (the .org host failed on a home
// connection that .tmdb.org answered fine), so both are tried.
const HOSTS = ['https://api.themoviedb.org/3', 'https://api.tmdb.org/3'];
let workingHost = null;

export function tmdbKey() {
  const env = (process.env.TMDB_API_KEY || '').trim();
  if (env) return env;
  try {
    return readFileSync(join(HERE, '.tmdb-key'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function get(path, key) {
  const order = workingHost ? [workingHost, ...HOSTS.filter((h) => h !== workingHost)] : HOSTS;
  let lastError = null;
  for (const host of order) {
    try {
      const url = host + path + (path.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key);
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        lastError = new Error('TMDB HTTP ' + res.status);
        continue;
      }
      workingHost = host;
      return await res.json();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('TMDB unreachable');
}

/** Latin-only, so a Japanese title that happens to contain the English name
 *  ("鋼の錬金術師 FULLMETAL ALCHEMIST") cannot answer a search for the other
 *  show: the 2003 series and Brotherhood are different shows. */
const latinOnly = (v) => {
  const s = String(v || '');
  return s && !/[^\x00-\x7F]/.test(s);
};

/** The one search hit that is the term itself. An exact name wins; failing
 *  that, a title that *starts* with the term ("Demon Slayer" ->
 *  "Demon Slayer: Kimetsu no Yaiba"), but only when it is the sole such hit -
 *  two candidates mean a spin-off is in play, and picking one files the other
 *  show's episodes. */
export function pickHit(hits, want, nameKey, originalKey) {
  const exact = (h) =>
    fold(h[nameKey]) === want ||
    (latinOnly(h[originalKey]) && fold(h[originalKey]) === want);
  const hit = (hits || []).find(exact);
  if (hit) return hit;
  const prefixed = (hits || []).filter((h) => {
    const n = fold(h[nameKey]);
    return (
      n.indexOf(want + ' ') === 0 ||
      (latinOnly(h[originalKey]) && fold(h[originalKey]).indexOf(want + ' ') === 0)
    );
  });
  return prefixed.length === 1 ? prefixed[0] : null;
}

/** The TMDB show behind a list term, or null when nothing matches exactly.
 *  Loose matching would file one show's episodes under another. */
export function totalEpisodes(show) {
  return (show && show.seasons || []).reduce((sum, season) => sum + (Number(season.episodes) || 0), 0);
}

export function underEpisodeLimit(show, limit) {
  return Boolean(show && totalEpisodes(show) <= limit);
}

export async function tmdbShow(term, key) {
  if (!key) return null;
  const want = fold(term);
  const search = await get('/search/tv?query=' + encodeURIComponent(term), key);
  const hits = (search && search.results) || [];
  const hit = pickHit(hits, want, 'name', 'original_name');
  if (!hit) return null;

  const show = await get('/tv/' + hit.id, key);
  const seasons = (show.seasons || [])
    .filter((s) => Number(s.season_number) >= 1 && Number(s.episode_count) > 0)
    .map((s) => ({
      n: Number(s.season_number),
      episodes: Number(s.episode_count),
      year: String(s.air_date || '').slice(0, 4),
    }))
    .sort((a, b) => a.n - b.n);
  if (!seasons.length) return null;
  // next_episode_to_air is the only honest "is this show still running" signal:
  // status alone says "Returning Series" for a show on a year-long break.
  return { id: hit.id, name: hit.name, seasons, airing: Boolean(show.next_episode_to_air) };
}

/** The TMDB movie behind a film entry's name, or null. The app asks for a film
 *  as a movie at S1E1 under its movie title, so a film is only playable when
 *  its catalogue file is named that. A namesake from another decade is a
 *  different film, hence the year window. */
export async function tmdbMovie(name, year, key) {
  if (!key) return null;
  const want = fold(name);
  const search = await get('/search/movie?query=' + encodeURIComponent(name), key);
  const hits = (search && search.results) || [];
  const hit = pickHit(hits, want, 'title', 'original_title');
  if (!hit) return null;
  const released = Number(String(hit.release_date || '').slice(0, 4)) || null;
  if (year && released && Math.abs(released - Number(year)) > 2) return null;
  return { id: hit.id, title: hit.title, year: released };
}

/** The names worth re-searching for a term: TMDB's other titles for it, latin
 *  only (a kana title cannot match the site's index), without the term itself,
 *  deduped by fold. */
export function extraNames(term, candidates, limit = 6) {
  const seen = new Set([fold(term)]);
  const out = [];
  for (const v of candidates || []) {
    const s = String(v || '').trim();
    if (!latinOnly(s)) continue;
    const f = fold(s);
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** Every other name TMDB holds for a term, from both its show and its film
 *  record: the site may file a term that is a TMDB film under its show, or the
 *  reverse. A miss the harvester would otherwise call absent is retried with
 *  these, so a naming difference does not cost a show its entry. */
export async function tmdbAltNames(term, key) {
  if (!key) return [];
  const want = fold(term);
  const candidates = [];
  for (const kind of ['tv', 'movie']) {
    try {
      const search = await get('/search/' + kind + '?query=' + encodeURIComponent(term), key);
      const hit = pickHit(
        (search && search.results) || [],
        want,
        kind === 'tv' ? 'name' : 'title',
        kind === 'tv' ? 'original_name' : 'original_title'
      );
      if (!hit) continue;
      candidates.push(kind === 'tv' ? hit.name : hit.title);
      candidates.push(kind === 'tv' ? hit.original_name : hit.original_title);
      const alt = await get('/' + kind + '/' + hit.id + '/alternative_titles', key);
      for (const t of (alt && (alt.results || alt.titles)) || []) candidates.push(t.title || t.name);
    } catch {
      // TMDB unreachable here: the recheck simply has fewer names to try.
    }
  }
  return extraNames(term, candidates);
}
