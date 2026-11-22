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
  // An exact name wins. Failing that, a unique title that starts with the term:
  // the list says "Demon Slayer", TMDB says "Demon Slayer: Kimetsu no Yaiba".
  // Two candidates means a spin-off is in play, so refuse rather than pick.
  let hit = hits.find(
    (h) =>
      fold(h.name) === want ||
      (latinOnly(h.original_name) && fold(h.original_name) === want)
  );
  if (!hit) {
    const prefixed = hits.filter((h) => {
      const n = fold(h.name);
      return (
        n.indexOf(want + ' ') === 0 ||
        (latinOnly(h.original_name) && fold(h.original_name).indexOf(want + ' ') === 0)
      );
    });
    if (prefixed.length === 1) hit = prefixed[0];
  }
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
  const exact = (h) =>
    fold(h.title) === want ||
    (latinOnly(h.original_title) && fold(h.original_title) === want);
  let hit = hits.find(exact);
  if (!hit) {
    const prefixed = hits.filter((h) => {
      const n = fold(h.title);
      return (
        n.indexOf(want + ' ') === 0 ||
        (latinOnly(h.original_title) && fold(h.original_title).indexOf(want + ' ') === 0)
      );
    });
    if (prefixed.length === 1) hit = prefixed[0];
  }
  if (!hit) return null;
  const released = Number(String(hit.release_date || '').slice(0, 4)) || null;
  if (year && released && Math.abs(released - Number(year)) > 2) return null;
  return { id: hit.id, title: hit.title, year: released };
}
