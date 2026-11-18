# Nuvio AnimePahe plugin

AnimePahe scraper plugin for the Nuvio app (plugin format, QuickJS).
1080p Sub streams only.

## Install in the app

Settings → Plugins → add repository:

```
https://raw.githubusercontent.com/shivam7042263411-coder/nuvio-animepahe/main/manifest.json
```

The manifest is reloaded every 6 hours, or immediately via **Refresh** in
Plugins settings.

## The kwik-id catalogue (no Cloudflare on repeat plays)

Every episode's stream lives on a kwik id (`https://kwik.cx/e/<id>`). That id
does not expire with AnimePahe's front end, and the CDN is not behind
Cloudflare — it only wants the kwik referer. So a play that already knows the
id never touches `animepahe.pw`: no search, no season matching, no challenge.

```
catalogue/index.json          title -> file
catalogue/<show>.json         rows: s, e, q, a, id
```

The plugin fetches the index first, matches a TMDB title exactly (punctuation
and doubled letters folded), then serves `1080p sub` from the show file. Only
that tier is stored - one row per episode, nothing else. A miss, a dead id, or
an unreachable catalogue falls back to today's scrape - silently.

The app is not involved: no new repository in Settings, no storage binding,
no app change. Only the plugin reads these files.

### Filling it

Two writers, both on a laptop. The TV is read-only.

```bash
# 1. from the probe harvests already in ../probe
node tools/build-catalogue.mjs

# 2. bulk: one Chrome window, one Cloudflare solve, a list of shows
node tools/harvest-batch.mjs                            # tools/shows.txt (4 shows)
node tools/harvest-batch.mjs --file tools/shows-bulk.txt # 156 shows/films
node tools/harvest-batch.mjs --all-seasons --max-eps 0   # every season, every episode
node tools/harvest-batch.mjs --force                    # redo shows already stored

# 3. from a device log (the scrape prints one `kwik-id {...}` per tier)
adb logcat -d | node tools/merge-log.mjs -
```

Then commit `catalogue/`. `index.json` is generated - never hand-edit it.

Season names are not what decides a season. With a TMDB key present the
harvester asks TMDB how many episodes each season has - the same numbering the
app shows - and files entries by their size, in release order:

- `Jujutsu Kaisen: Culling Game` has no "season" in its name, but 24 + 23 + 12
  episodes add up to TMDB's one 59-episode season, so all of it lands in S1 and
  every episode is playable.
- `Demon Slayer: Mugen Train Arc`, `Entertainment District Arc` and the rest
  fill S2–S5 the same way.
- A season whose episodes do not add up exactly is **left out and named in the
  log**, never guessed - a misfiled season plays the wrong episode forever.

The key is read from `tools/.tmdb-key` (one line, gitignored) or the
`TMDB_API_KEY` environment variable. Without it, seasons are matched by name
only, which is why an arc-named season used to go missing.

Harvest behaviour worth knowing:

- The search hit is picked by **title relevance first, episode count second**:
  an exact (case/punctuation/doubled-letter folded) title wins, then a title
  that starts with the term, then the longest run. Sorting by episode count
  alone once picked *Naruto Shippuden* for "Naruto". Force a hit with
  `resultIndex` in the list.
- **One line = one season** by default: the harvester takes one AnimePahe entry
  and its first `maxEpisodes`. `--all-seasons` instead fills every season TMDB
  defines, all in the one file, each keyed by the app's season. `--max-eps 0`
  takes every episode, and a `--max-eps` on the command line overrides the
  list's `maxEpisodes` column.
- An entry **named after an arc** ("X: Culling Game", "X: Mugen Train Arc") is
  filed by size, so it no longer needs a line of its own. A sequel that is a
  different TMDB show (a spin-off) is not - it has its own `appTitle` line or
  it is skipped.
- A mis-picked entry is safe: the index is keyed on the **site's** title, so
  rows that belong to another show never match and play falls back to a scrape.
- `--max-eps` above what is stored **tops up only the missing episodes**; it
  does not re-fetch what is already there. No `--force` needed.
- The first Cloudflare challenge **stops the whole run** instead of retrying;
  shows already written stay written, and re-running resumes.
  `--wait-challenge 300` instead waits up to five minutes for you to tick the
  box, which is the difference between ten shows a sitting and all of them.
- Measured pacing: ~0.7s per episode (600ms sleep + one play page). Four
  12-episode shows take ~45s; 156 shows are ~25-30 minutes. `kwik.cx` is never
  touched, so the page throttle does not apply.

### Why there is no daily job on GitHub

A `catalogue.yml` workflow was tried on 2026-11-18 and deleted again: on a
GitHub runner its Chromium sat on Cloudflare's interstitial for the full 180s
wait, then quit with `challenge did not clear within 180s`. Datacenter ranges
(Azure, where runners live) are refused outright, so this is not a scripting
problem — only a connection Cloudflare trusts gets in, which means a residential
one.

Ways to fill it unattended that are actually viable:

- `--wait-challenge 300` on the laptop: a challenge pauses the run for up to
  five minutes while you tick the box, then finishes the whole list.
- An always-on machine on your own internet (an old PC, a Pi, a spare phone):
  the same command on a cron, and the catalogue is then never stale.
- Nothing at all, if you only watch on the TV: a missed episode still plays
  because the plugin scrapes it live. The catalogue removes the Cloudflare step
  from repeat plays; it is not what makes playback work.

Either way it maintains the shows in `tools/shows-bulk.txt`; it does not
discover new anime.

### Limits worth knowing

- **Numbering.** Rows are keyed by the app's own season/episode, because that
  is the only numbering available without resolving the episode. A season the
  site numbers continuously (S2E1 listed as episode 26) is shifted
  automatically: `inferOffset` maps the entry's first episode to e=1. An
  explicit `episodeOffset` in the list overrides it. A wrong key is a miss,
  never a wrong episode.
- **`kwik.cx/e/<id>` throttles**, ~10 page loads in a couple of minutes, then
  ~1 minute of 403. The CDN does not throttle (8 rapid range requests: all
  206). Normal watching is far below the limit; a burst reveal is not.
- **A re-upload kills an id.** That episode scrapes once, and the scrape's
  `kwik-id` line is the replacement.
- **Reachability.** The catalogue is read over `raw.githubusercontent.com`.
  On a network that blocks it, every play is a miss and behaves exactly like
  the plugin without a catalogue.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Repository manifest read by the app |
| `animepahe.js` | The scraper plugin |
| `selftest.js` | Node self-check for the non-trivial logic (`node selftest.js`) |
| `catalogue/` | Static kwik-id data (see `catalogue/README.md`) |
| `tools/` | Laptop-side writers for `catalogue/` |

## Notes

- The plugin reads `TMDB_API_KEY` from the host app at runtime; no key is
  stored in this repository.
- Season/episode matching uses the app's own absolute episode number when
  available, falls back to cumulative TMDB season counting, and skips
  OVAs/movies/specials so they cannot shift the offset.
- **Returns the direct MP4 download** and nothing else: the kwik `/e/` page is
  unpacked to its signed playlist, and the sibling `/mp4/` path (same hash,
  minus the last segment) is the one progressive, seekable file. The HLS
  playlist is never offered: it cannot seek or resume in the player. A release
  with no download is reported as no stream.
- At most two AnimePahe searches (English title + shortest JP romaji title) and
  at most two release pages per probe, cached per run, because AnimePahe
  rate-limits hard. A single 429 is retried once.
- A catalogue lookup is at most two HTTPS requests (index + show), cached for
  10 minutes; a failure is cached the same way so a blocked host costs one
  timeout, not one per play.
