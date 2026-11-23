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
  -> AnimeTosho HTML (8s cap per request)
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
- Only `1080p` releases are returned; `1080p HDR` is included and labelled
  `· HDR`. If a show has no 1080p at all, the full set is used as a fallback so
  the list is never empty.
- Ranking is tiered by release group: `SubsPlease` first, then `HorribleSubs`
  (its predecessor; still the only tagged source for pre-2021 back-catalogue),
  then `AnoZu` and `EMBER`, then everything else. Within a tier, score decides
  (1080p > 720p, sub > dub), then seeders break ties. Other groups (`Erai-raws`,
  `DKB`, `Judas`, `ASW`, ...) still appear, just below the trusted tier.
- Each lookup queries **every trusted group by name** first
  (`SubsPlease <title> <ep>`, `HorribleSubs <title> <ep>`, ...). A generic
  `<title> <episode>` search returns a capped, relevance-ranked page that omits
  the trusted groups' per-episode singles (Jujutsu Kaisen: 75 rows, zero
  SubsPlease; Re:Zero: zero HorribleSubs), so the groups are queried directly.
- Long-running anime are numbered two ways. The app reports a season-local
  episode (TMDB `Black Clover` S2E7), but the release names count continuously
  (`[HorribleSubs] Black Clover - 58`). The absolute episode is derived from
  TMDB's per-season episode counts and searched too, so the trusted group is
  found for both schemes. A group proven to number this show continuously also
  has its bare same-numbered release dropped for that request, since `- 07`
  under a continuous scheme is season 1, not season 2.

Two AnimeTosho hosts are queried in parallel and merged by info hash:
`animetosho.xyz` (the community successor, live) and `animetosho.org` (frozen on
2026-05-09, kept for back-catalogue depth and as a mirror). Both render the same
`home_list_entry` markup and list Nyaa/TokyoTosho/AniDex/nekoBT releases; base32
info hashes are decoded to the 40-hex form Nuvio requires. AnimeTosho.org alone
was the "missing latest episodes" cause — it has no releases after May 2026.

Dropping a direct Nyaa query matters. Nuvio's QuickJS runtime keeps a plugin
evaluation alive until every `fetch` it started settles, and its `fetch` cannot
be cancelled. A blackholed host (ISP block) never settles, so one fallback to a
blocked `nyaa.si` burned the whole 60s plugin budget and the results were
discarded — the "no stream found"/timeout bug. Every request is now bounded by
`withTimeout` and hosts run in parallel, so a slow one cannot stall the rest.

## Why only single episodes

Nuvio's plugin bridge hardcodes `fileIdx = null` for scraper results, so a batch
torrent cannot be pointed at the requested file. The scraper therefore returns
only single-episode releases. Debrid's own file selector is not used for these
results either.

## What Nuvio accepts

Each result is:

```js
{
  title: "Release name",                        // parsed for badges, not shown as the row label
  name: "01 · 26↑ · [SubsPlease] Show - 08 (1080p)", // row label; the leading rank keeps our order
  url: "magnet:?xt=urn:btih:<40-hex>",   // required non-blank
  infoHash: "<40-hex>",
  quality: "1080p",                           // "1080p HDR" when HDR; Nuvio shows this in the subtitle
  size: "1.4 GiB",
  language: "Sub",
  provider: "AnimeTorrents",
  type: "torrent",
  seeders: 26,
  peers: null,
  subtitles: []
}
```

Nuvio's plugin bridge renders `name` as the bold row label and builds the row
subtitle from `quality • size • language`. It never shows `title` (only parses it
for badge rules), so every release puts its own name + seeder count in `name`.

Crucially, Nuvio then **re-sorts every plugin row** with
`List<StreamItem>.sortedForGroupedDisplay()` — a plain case-insensitive
alphabetical sort on the label (grouped after `sourceName`). Our ranking would be
thrown away by that sort, so the label carries a zero-padded `NN · ` rank prefix
that reproduces our order under a plain string sort (a `852↑ …`/`30↑ …` label
sorted "30↑" first). SubsPlease therefore always stays at `01 · `.

Nuvio adds its own tracker list; the scraper does not need to.

## Limits

- Most anime torrents are **softsub MKV** (subtitles as a track inside the
  file), not hardsubbed MP4. Playback depends on Media3/ExoPlayer supporting the
  codec (HEVC/x265 is common) and rendering the subtitle track.
- A low-seed release buffers on a TV stick. Debrid is the smooth path.
- A network that blocks `nyaa.si` is unaffected: nothing but AnimeTosho (and
  TMDB/Kitsu for ids) is ever contacted, so a blocked host cannot hold the
  lookup open. When AnimeTosho has no match for an episode, the list is simply
  empty — no timeout.
- Only single-episode English-translated releases are searched.

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