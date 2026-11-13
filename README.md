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

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Repository manifest read by the app |
| `animepahe.js` | The scraper plugin |
| `selftest.js` | Node self-check for the non-trivial logic (`node selftest.js`) |

## Notes

- The plugin reads `TMDB_API_KEY` from the host app at runtime; no key is
  stored in this repository.
- Season/episode matching uses the app's own absolute episode number when
  available, falls back to cumulative TMDB season counting, and skips
  OVAs/movies/specials so they cannot shift the offset.
- At most two AnimePahe searches (English title + shortest JP romaji title) and
  at most two release pages per probe, cached per run, because AnimePahe
  rate-limits hard. A single 429 is retried once.
