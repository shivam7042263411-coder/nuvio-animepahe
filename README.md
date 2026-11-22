# Nuvio Anime Torrents plugin

A torrent scraper for the Nuvio app (plugin format, QuickJS). It turns a show or
anime episode into per-episode magnets that Nuvio plays through its built-in P2P
engine or resolves instantly through a debrid provider.

This replaces the earlier AnimePahe scraper. The install URL is unchanged.

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

**Debrid (recommended):** Settings → Debrid → connect Torbox or Premiumize. A
cached magnet becomes a direct HTTP stream with no peer wait.

Torrent results are labelled **AnimeTorrents**. Select one and Nuvio either
starts `TorrentState.Connecting → Streaming` or asks debrid for a link.

## Content ids

Nuvio passes the plugin whatever id the active metadata provider uses, not just
a TMDB number, so all three namespaces are resolved before searching:

| Id | Resolved via |
|----|--------------|
| `209867`, `tmdb:209867` | TMDB directly |
| `tt22248376` (IMDb) | TMDB `/find` |
| `kitsu:46474:1` (anime) | Kitsu API for the title |

The Kitsu path is the one that matters for anime: anime metadata is per-season,
so the season number lives in the title ("Attack on Titan Season 2") while the
app always reports season 1. Those titles also carry the romaji name (`Sousou no
Frieren`) that Nyaa releases actually use.

## How it works

```
content id -> titles + season count
  -> Nyaa RSS + AnimeTosho HTML, queried in parallel (8s cap per request)
  -> strict release matcher
  -> magnet (40-hex infoHash)
```

Queries (max 3 per episode):

```
<romaji title> S01E01
<romaji title> 01
<english title> 01        (and the absolute episode when the app provides one)
```

The matcher is deliberately strict:

- The release must actually contain the show title (group tags are stripped
  first, so `[SubsPlease] Frieren - 01` still matches).
- The episode token must match: `S01E01`, `S1 - 01`, `Episode 01`, `- 01`,
  `01v2`, `[01]`, or the absolute number in `(60)`.
- A different season is rejected (`S02E05` for a season 1 request).
- Season packs and batches are rejected: `Batch`, `Complete`, `01-12`,
  `01 ~ 12`, `S1-S4`, `(01-25)`.
- OVAs, OADs, specials, recaps, chibi shorts, "Junior High" spin-offs, and the
  "Kanketsu-hen" finale specials are rejected.
- "The Final Season" is mapped to TMDB's last season.
- `1080p` ranks first, then `720p`; sub ranks above dub; seeders break ties.

AnimeTosho's HTML search runs alongside Nyaa and carries the same releases; its
base32 info hashes are decoded to the 40-hex form Nuvio requires. Running both
together is what keeps lookups working on networks that block `nyaa.si`.

## Why only single episodes

Nuvio's plugin bridge hardcodes `fileIdx = null` for scraper results, so a batch
torrent cannot be pointed at the requested file. The scraper therefore returns
only single-episode releases. Debrid's own file selector is not used for these
results either.

## What Nuvio accepts

Each result is:

```js
{
  title: "Release name",
  name: "AnimeTorrents · 1080p · Sub",
  url: "magnet:?xt=urn:btih:<40-hex>",   // required non-blank
  infoHash: "<40-hex>",
  quality: "1080p",
  size: "1.4 GiB",
  language: "Sub",
  provider: "AnimeTorrents",
  type: "torrent",
  seeders: 26,
  peers: null,
  subtitles: []
}
```

Nuvio adds its own tracker list; the scraper does not need to.

## Limits

- Most anime torrents are **softsub MKV** (subtitles as a track inside the
  file), not hardsubbed MP4. Playback depends on Media3/ExoPlayer supporting the
  codec (HEVC/x265 is common) and rendering the subtitle track.
- A low-seed release buffers on a TV stick. Debrid is the smooth path.
- Nyaa's RSS is open, but an ISP/network that blocks `nyaa.si` (connection
  hangs, or the host resolves to a block page) has no effect here: AnimeTosho is
  queried in parallel, and every request is capped at 8 seconds.
- Only English-translated releases are searched (`c=1_2`).

## Files

| File | Purpose |
|------|---------|
| `anime-torrent.js` | The scraper (`getStreams`) |
| `manifest.json` | Repository manifest read by Nuvio |
| `selftest.js` | Offline checks: matching, hash decoding, result shape |

Run the self-check:

```
node selftest.js
```

`tools/` is leftover AnimePahe harvesting tooling and is not used by the
installed plugin. It is kept only so nothing is lost.

## Rollback

The AnimePahe scraper was archived before removal:

```
git branch -a                    # backup/animepahe-20261122-203337
git tag -l                       # animepahe-20261122-203337
ls ../backups/                   # nuvio-animepahe-*.zip
```

Restore it with:

```
git checkout main
git reset --hard animepahe-20261122-203337
```

or unpack `../backups/nuvio-animepahe-worktree-20261122-203337.zip` (includes
untracked files) / `../backups/nuvio-animepahe-20261122-203337.zip` (committed
HEAD only).