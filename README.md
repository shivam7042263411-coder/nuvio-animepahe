# Nuvio Anime Torrents plugin (SeaDex + NekoBT)

Two **independent** torrent providers for the Nuvio app (plugin format,
QuickJS):

- **SeaDex Torrents** (`anime-torrent.js`) — curated best releases from
  [seadex.moe](https://seadex.moe), keyed by AniList id.
- **NekoBT Torrents** (`nekobt-torrent.js`) — the releases on
  [nekobt.to](https://nekobt.to).

They are separate scrapers on purpose: each loads and returns on its own, so a
slow or blocked nekobt.to can never hold up the SeaDex lookup (or the other way
round). Both return **1080p and above only**, and everything plays through
Nuvio's built-in P2P engine.

This replaces the earlier AnimeTosho provider. The install URL is unchanged.

## Install in the app

Settings → Plugins → add repository:

```
https://raw.githubusercontent.com/shivam7042263411-coder/nuvio-animepahe/main/manifest.json
```

The manifest is reloaded every 6 hours, or immediately via **Refresh** in
Plugins settings. Both providers appear as separate sources.

## Enable playback

**P2P (no account):** Settings → Playback → P2P Streaming → toggle on and accept
the consent dialog. The defaults (Balanced profile, 2 GB cache) are fine to
start. Seeding is on by default.

Torrent results are labelled **SeaDex Torrents** and **NekoBT Torrents**. Select
one and Nuvio starts `TorrentState.Connecting → Streaming`. Debrid is not used
for plugin streams; they always play over P2P.

## How it works

Each provider resolves the same content id, then runs its own pipeline:

```
content id (TMDB / IMDb / Kitsu)
  -> TMDB title, romaji alternative titles, per-season episode counts

  SeaDex Torrents (anime-torrent.js)
    -> AniList search -> every entry for this show (each season is its own id)
    -> SeaDex entry per AniList id (https://seadex.moe)
    -> the file inside each release that is the requested episode
    -> magnet (single file) or torrent://<hash>/<index> (season batch)

  NekoBT Torrents (nekobt-torrent.js)
    -> NekoBT media id for this show (exact TMDB id)
    -> every torrent NekoBT lists for it (Torznab feed, paged)
    -> 1080p+ releases with at least one seeder; a season pack is resolved to
       the requested episode's file and aimed at it with torrent://hash/index
    -> magnet (name + public trackers)
```

The two do not merge or wait on each other.

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

## NekoBT (nekobt.to)

NekoBT is the broad index; it catches the releases every fansub and scene group
uploads, including shows SeaDex has no entry for. It exposes a public **Torznab**
feed (`https://nekobt.to/api/torznab/api`, no API key), whose items carry the
release name, info hash, seeder count and size — everything a magnet needs.

The feed also accepts a `media_id`, which lists **every** torrent NekoBT has for
one show rather than a fuzzy, most-recent-first page. So the plugin first asks
NekoBT's media search for this show, matches the **exact TMDB id** (so a spin-off
such as "One Piece: Heroines" cannot stand in for "One Piece"), then pages that
media id's feed. If the media lookup fails or finds nothing, it falls back to two
plain title searches, the romaji title plus `SxxExx` (scene-style groups such as
VARYG/ToonsHub) and the romaji title plus `- NN` (SubsPlease, Erai-raws,
`S2 - NN`). Every result is client-side filtered, because NekoBT's search is
fuzzy. The provider never talks to AniList or SeaDex.

A NekoBT release is kept only when **all** of these hold:

- The name names the show, matched on the whole title phrase (so "One Piece of
  Cake" is not accepted for "One Piece"), and a spin-off subtitle is rejected
  (so "One Piece: Heroines" is not accepted for "One Piece"). A single-word
  title also matches its spaced form ("Dandadan" → "Dan Da Dan").
- The name matches the requested episode and season, using the same
  `SxxExx` / `Season N` / absolute-number matcher as the SeaDex path.
- The name states `1080p` or higher. NekoBT has no curated "best" flag, so a
  resolution-silent name is dropped rather than guessed.
- The torrent has **at least one seeder**. A torrent with zero seeders never
  starts, so it is never returned — that is the "no dead links" rule.
- A **season pack** is not offered as-is: its magnet would open the pack's
  largest file, not the episode. The plugin reads the pack's file list from
  NekoBT's per-torrent endpoint, picks the file that is the requested episode,
  and aims playback at it with `torrent://<hash>/<index>` — the same scheme the
  SeaDex provider uses. Batches (`(01-12)`, `S01E01-E12`, `S01-S03`,
  `Batch`/`Complete`, or a bare `S01`) are handled this way and never returned
  as a plain magnet. Packs add sources alongside single-episode releases until
  the result list is full, and a pack naming another season is never used.

Each NekoBT result is a self-contained magnet carrying the release name and four
public trackers, so it also plays in an external client on a phone, tablet or
desktop, not only inside Nuvio.

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
  provider: "SeaDex",                            // or "NekoBT"
  type: "torrent",
  seeders: null,                                 // NekoBT rows carry the live count
  peers: null,
  subtitles: []
}
```

SeaDex carries no seeder count, so its `seeders` is `null`; NekoBT rows report
the live seeder count and append it to the language line.

Nuvio renders `name` as the bold row label and builds the subtitle from
`quality • size • language`. It then **re-sorts every plugin row** with
`sortedForGroupedDisplay()` — a plain case-insensitive alphabetical sort on the
label. The label therefore carries a zero-padded `NN · ` rank prefix so each
provider's order (best release first, then resolution, then seeders, then the
most relevant season entry, then dual audio) survives that sort.

### Plugin hosts differ (the Android TV sandbox has no timers)

The Nuvio plugin sandbox (QuickJS) does not provide `setTimeout`/`clearTimeout`,
and the **Android TV** runtime (`NuvioTV`) is the strictest case. Both scrapers
detect timer support once (`typeof setTimeout === "function" &&
typeof clearTimeout === "function"`) and, when either is missing, skip their
per-request deadline instead of calling a timer that throws `ReferenceError`.
Requiring both halves matters: a host that bridges `setTimeout` but not
`clearTimeout` would otherwise throw when the deadline clears. The host's own
60 s plugin cap still bounds each call, so a slow host costs that provider's
results, never a stuck lookup.

Both scrapers are plain ES5-style code (`var`/`function`, `async`/`await`, no
`?.`, `??`, arrow functions or template literals) and read responses with
`res.text()`/`res.json()`, so nothing else depends on a mobile-only bridge
function.

## Rate limits and request budget

Each provider is bounded on its own; the two never wait on each other.

- **SeaDex Torrents:** two TMDB requests, one AniList search (the romaji title;
  the English title only if that yields no strong match), then up to eight SeaDex
  entry requests in parallel. The common case is one AniList request, which
  matters because AniList rate-limits. A `429` gets one retry after a short pause
  when timers exist.
- **NekoBT Torrents:** two TMDB requests, then up to three media lookups
  (NekoBT splits some shows into one entry per season and renames others), then
  up to four feed pages of 100 for a show, or up to two for a movie. If the feed
  yields nothing, two title-search feed requests run as a fallback. Up to five
  per-torrent file-list lookups then aim packs at the episode; they run in
  parallel and stop once the result list is full. NekoBT does not rate-limit the
  feed the way AniList does, but it drops connections now and then, so each
  request is retried up to three times. NekoBT calls nothing else — no AniList,
  no SeaDex.

## Limits

- SeaDex is a **curated "best release" database, not a full torrent index**.
  Shows or episodes with no entry, or with only private-tracker copies, return
  no SeaDex rows — NekoBT covers those.
- NekoBT lists what its users uploaded; a show or episode nobody uploaded has no
  row. A season pack is aimed at the exact episode file, so batch-only shows such
  as Undead Unluck still play even when the pack is the only source.
- Later seasons are matched through their own AniList entries on the SeaDex
  path, and through the season in the release name on the NekoBT path. A season
  that neither indexes may be missed; the file's own `SxxExx` still prevents a
  wrong episode from being returned.
- Most releases are **softsub MKV** (subtitles as a track inside the file).
  Playback depends on Media3/ExoPlayer supporting the codec (HEVC/x265 is
  common) and rendering the subtitle track.
- A low-seed release buffers on a TV stick; NekoBT rows show their seeder count,
  and zero-seeder rows are never offered.
- Long-running anime are numbered two ways; the absolute episode is derived from
  TMDB's season counts, so a release that restarts numbering inside a batch is
  still matched by its `SxxExx`.

## Files

| File | Purpose |
|------|---------|
| `anime-torrent.js` | SeaDex provider (`getStreams`): TMDB/Kitsu resolve, AniList, SeaDex, file matching |
| `nekobt-torrent.js` | NekoBT provider (`getStreams`): TMDB/Kitsu resolve, NekoBT media id + Torznab feed, release matching |
| `manifest.json` | Repository manifest read by Nuvio; registers both scrapers |
| `selftest.js` | Offline checks for the SeaDex provider |
| `selftest-nekobt.js` | Offline checks for the NekoBT provider |

Run the self-checks:

```
node selftest.js
node selftest-nekobt.js
```

`tools/` is leftover AnimePahe harvesting tooling and is not used by the
installed plugin. `subs/` is left over from the AnimeTosho subtitle-index
feature; neither provider uses it (the SeaDex MKVs already carry their group's
subtitles).

## Rollback

The previous providers are in git history:

```
git log --oneline -- anime-torrent.js
```

Restore one with `git checkout <commit> -- anime-torrent.js manifest.json README.md`,
or reset the branch to the tagged AnimePahe backup if you need the older scraper.
