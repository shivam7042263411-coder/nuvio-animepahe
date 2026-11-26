# Nuvio SeaDex Torrents plugin

A torrent scraper for the Nuvio app (plugin format, QuickJS) backed by
[SeaDex](https://seadex.moe). It turns an anime episode or movie into the
curated best releases SeaDex indexes, as magnets that Nuvio plays through its
built-in P2P engine.

This replaces the earlier AnimeTosho provider. The install URL is unchanged.

## Install in the app

Settings → Plugins → add repository:

```
https://raw.githubusercontent.com/shivam7042263411-coder/nuvio-animepahe/main/manifest.json
```

The manifest is reloaded every 6 hours, or immediately via **Refresh** in
Plugins settings.

## Enable playback

**P2P (no account):** Settings → Playback → P2P Streaming → toggle on and accept
the consent dialog. The defaults (Balanced profile, 2 GB cache) are fine to
start. Seeding is on by default.

Torrent results are labelled **SeaDex Torrents**. Select one and Nuvio starts
`TorrentState.Connecting → Streaming`. Debrid is not used for plugin streams;
they always play over P2P.

## How it works

```
content id (TMDB / IMDb / Kitsu)
  -> TMDB title, romaji alternative titles, per-season episode counts
  -> AniList search -> every entry for this show (each season is its own id)
  -> SeaDex entry per AniList id (https://seadex.moe)
  -> the file inside each release that is the requested episode
  -> magnet (single file) or torrent://<hash>/<index> (season batch)
```

SeaDex is keyed by **AniList id**, not by title. A season of a show is often a
separate, arc-titled AniList entry ("Kimetsu no Yaiba: Katanakaji no Sato-hen",
not "Season 4"), so the plugin does not guess one entry. It fetches SeaDex for
every strong same-title candidate and lets the **file name's `SxxExx` or
absolute episode number** decide which torrent holds the episode. That is why
Demon Slayer S2–S5, Attack on Titan S3 Part 2, and similar split seasons resolve
without a hardcoded arc table.

The matcher:

- Accepts `S01E01`, `S1 - 01`, `Season 3 - 01`, `2nd Season - 01`,
  `Episode 45`, `- 60`, and the absolute number in `(0337)`.
- Rejects a different season. A season-less file (`Show - 01`) only counts when
  the AniList entry it came from is the requested season, and a season-1 request
  can never take a "Season 3 - 01" or "2nd Season - 01" file.
- Rejects OVAs, OADs, specials, recaps, NCOP/NCED, and other extras.
- Uses TMDB's per-season episode counts to derive the absolute episode, so
  continuously numbered releases (`[MTBB] Shingeki no Kyojin - 60` for TMDB
  S4E1) are found.
- Returns **1080p and above only**: `1080p`, `1440p`, `2160p`, `4K`/`UHD`,
  `1920x1080`-style dimensions, and glued tokens such as `BD1080p`. Anything
  explicitly `720p`/`480p`/`576p`/`DVDrip` is dropped.
- When a file name says nothing about resolution, a SeaDex **best** release is
  included and labelled `HD` (SeaDex only lists curated HD releases); a
  non-best resolution-silent file, or one with an SD marker, is dropped rather
  than guessed.

### Season batches

SeaDex entries are often multi-file season batches. Nuvio's plugin bridge drops
a JSON `fileIdx` field, but it reads the index from the URL scheme
`torrent://<40-hex>/<index>` (`StreamItem.p2pFileIdx`), and its P2P engine
selects that file (`P2pStreamRequest.fileIdx`). The plugin therefore emits:

- a plain `magnet:?xt=urn:btih:<40-hex>` for a single-file release, and
- `torrent://<40-hex>/<index>` plus `infoHash` for a batch, so playback starts
  on the exact episode file instead of the largest one.

### Private-tracker copies

SeaDex redacts the info hash of private-tracker copies (AnimeBytes returns
`"<redacted>"`). Without a hash there is no magnet, so those are skipped; only
public-tracker (Nyaa) copies are returned.

## Content ids

Nuvio usually converts the active meta provider's id to a TMDB number first. The
plugin also resolves the raw forms:

| Id | Resolved via |
|----|--------------|
| `209867`, `tmdb:209867` | TMDB directly |
| `tt22248376` (IMDb) | TMDB `/find` |
| `kitsu:46474:1` (anime) | Kitsu API for the title |

The Kitsu path carries the romaji title and the season number in the title,
which is what AniList indexes.

## What Nuvio accepts

Each result is:

```js
{
  title: "Release name",                         // parsed for badges, not the row label
  name: "01 · Best · Frieren - S01E01 (BD 1080p)", // row label; leading rank keeps our order
  url: "torrent://<40-hex>/3",                   // or a magnet; required non-blank
  infoHash: "<40-hex>",
  quality: "1080p",                              // "1080p HDR", "2160p", or "HD"
  size: "7.0 GiB",
  language: "Dual Audio",                        // or "Sub"
  provider: "SeaDex",
  type: "torrent",
  seeders: null,
  peers: null,
  subtitles: []
}
```

SeaDex carries no seeder count, so `seeders` is `null`.

Nuvio renders `name` as the bold row label and builds the subtitle from
`quality • size • language`. It then **re-sorts every plugin row** with
`sortedForGroupedDisplay()` — a plain case-insensitive alphabetical sort on the
label. The label therefore carries a zero-padded `NN · ` rank prefix so the
plugin's order (best release first, then resolution, then the most relevant
season entry, then dual audio) survives that sort.

### Plugin hosts differ (Android TV has no timers)

The mobile plugin host installs `setTimeout`/`clearTimeout`; the **Android TV**
host (`NuvioTV`) defines neither. The scraper detects once
(`typeof setTimeout`) and, when absent, skips its per-request deadline and the
AniList 429 back-off instead of calling a timer that throws `ReferenceError`.
The host's own 60 s plugin cap still bounds the call, so a slow host costs
results, never a stuck plugin.

## Rate limits and request budget

A lookup makes two TMDB requests, then one AniList search (the romaji title;
the English title is only tried if that yields no strong match), then up to
eight SeaDex entry requests in parallel. The common case is one AniList request,
which matters because AniList rate-limits. A `429` gets one retry after a short
pause when timers exist.

## Limits

- SeaDex is a **curated "best release" database, not a full torrent index**.
  Shows or episodes with no entry, or with only private-tracker copies, return
  an empty list. One Piece episode 1, for example, has no matching file in
  SeaDex's batches.
- Later seasons are matched through their own AniList entries. A season that
  AniList has not indexed, or whose title differs too much from TMDB's, may be
  missed; the file's own `SxxExx` still prevents a wrong episode from being
  returned.
- Most releases are **softsub MKV** (subtitles as a track inside the file).
  Playback depends on Media3/ExoPlayer supporting the codec (HEVC/x265 is
  common) and rendering the subtitle track.
- A low-seed release buffers on a TV stick; SeaDex entries are often large BD
  remuxes.
- Long-running anime are numbered two ways; the absolute episode is derived from
  TMDB's season counts, so a release that restarts numbering inside a batch is
  still matched by its `SxxExx`.

## Files

| File | Purpose |
|------|---------|
| `anime-torrent.js` | The scraper (`getStreams`) |
| `manifest.json` | Repository manifest read by Nuvio |
| `selftest.js` | Offline checks: title/season ranking, file matching, 1080p+ rule, result shape, TV host |

Run the self-check:

```
node selftest.js
```

`tools/` is leftover AnimePahe harvesting tooling and is not used by the
installed plugin. `subs/` is left over from the AnimeTosho subtitle-index
feature; the SeaDex pipeline does not use it (SeaDex MKVs already carry their
group's subtitles).

## Rollback

The previous provider is in git history:

```
git log --oneline -- anime-torrent.js
```

Restore it with `git checkout <commit> -- anime-torrent.js manifest.json README.md`,
or reset the branch to the tagged AnimePahe backup if you need the older scraper.
