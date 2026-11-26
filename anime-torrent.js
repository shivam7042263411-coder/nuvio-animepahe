// =============================================================================
// SeaDex Torrents - NuvioTV plugin (QuickJS / PluginRuntime)
//
// Pipeline:
//   content id (TMDB / IMDb / Kitsu) -> titles (+ season count)
//     -> AniList search -> the right AniList entry (anime id)
//     -> SeaDex entry (https://seadex.moe, keyed by AniList id)
//     -> the file inside each release that is the requested episode
//     -> magnet for single-file releases, torrent://hash/index for batches
//
// SeaDex is a curated "best release" index: for each anime it lists the
// releases worth watching, with the torrent's file list. Entries are batches
// far more often than single episodes, and Nuvio's plugin bridge drops a
// `fileIdx` field, so a batch would play its largest file instead of the
// episode. The bridge does read a file index out of `torrent://<hash>/<index>`
// (StreamModels.p2pFileIdx), so multi-file releases use that URL form and the
// P2P engine starts on the exact episode file.
//
// Only public-tracker torrents are usable: SeaDex redacts the info hash of
// private-tracker (AnimeBytes) copies, and without a hash there is no magnet.
// =============================================================================

var TMDB_BASE = "https://api.themoviedb.org/3";
var KITSU_BASE = "https://kitsu.io/api/edge";
var ANILIST_API = "https://graphql.anilist.co";
var SEADEX_API = "https://seadex.moe/api/collections/entries/records";
var MAX_RESULTS = 10;
// SeaDex is keyed by AniList id and later seasons are separate entries, so a
// request may touch several. Cap the fan-out so a title with many spin-offs
// stays inside Nuvio's 60s plugin budget.
var MAX_ENTRIES = 8;

// Nuvio kills a plugin after 60s and its fetch cannot be cancelled, so bound
// every request: a blocked host would otherwise hold the whole lookup open.
var REQUEST_TIMEOUT_MS = 8000;

var UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function decodeEntities(value) {
    return String(value == null ? "" : value)
        .replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
            return String.fromCharCode(parseInt(hex, 16));
        })
        .replace(/&#(\d+);/g, function (_, dec) {
            return String.fromCharCode(parseInt(dec, 10));
        })
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

function normTitle(value) {
    return String(value == null ? "" : value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Title with season/cour markers removed, so "Frieren Season 2" compares
 *  equal to "Frieren" when deciding whether an AniList hit is the same show. */
function stripSeasonMarkers(value) {
    return String(value == null ? "" : value)
        .replace(/\b(?:the\s+)?final\s+season\b/gi, " ")
        .replace(/\b(?:season|cour)\s*\d{1,2}\b/gi, " ")
        .replace(/\b\d{1,2}(?:st|nd|rd|th)\s+season\b/gi, " ")
        .replace(/第\s*\d{1,2}\s*期/g, " ")
        .replace(/\bS\d{1,2}\b/gi, " ");
}

/** 1-based season named by the title, 99 for "Final Season", or null. */
function seasonNumberFromTitle(value) {
    var t = String(value == null ? "" : value);
    if (/\bfinal season\b/i.test(t)) return 99;
    var m = t.match(/\bSeason\s*(\d{1,2})\b/i) || t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i);
    if (!m) m = t.match(/第\s*(\d{1,2})\s*期/);
    if (!m) m = t.match(/\bS(\d{1,2})\b/);
    return m ? toInt(m[1], null) : null;
}

function isAscii(value) {
    return /^[\x20-\x7e]+$/.test(String(value == null ? "" : value));
}

function pad2(n) {
    return n < 10 ? "0" + n : String(n);
}

function toInt(value, fallback) {
    var n = parseInt(value, 10);
    return isNaN(n) ? fallback : n;
}

function formatSize(bytes) {
    var n = toInt(bytes, 0);
    if (n <= 0) return null;
    var units = ["B", "KiB", "MiB", "GiB", "TiB"];
    var i = 0;
    var v = n;
    while (v >= 1024 && i < units.length - 1) {
        v = v / 1024;
        i++;
    }
    return (v >= 100 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
}

// Nuvio's plugin sandbox can bridge fewer host functions than expected (the
// Android TV runtime is the usual case). Timer support is detected once, and
// both halves are required: a host with setTimeout but no clearTimeout would
// otherwise throw when the timeout fires. Without timers the host's own 60s cap
// still bounds the call, so a slow host costs results, never a crash.
var HAS_TIMERS = typeof setTimeout === "function" && typeof clearTimeout === "function";

function withTimeout(promise, label) {
    if (!HAS_TIMERS) return promise;
    return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            reject(new Error(label + " timed out after " + REQUEST_TIMEOUT_MS + "ms"));
        }, REQUEST_TIMEOUT_MS);
        promise.then(
            function (value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            function (error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

function delay(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

// ---------------------------------------------------------------------------
// TMDB
// ---------------------------------------------------------------------------

async function tmdbJson(path) {
    var key = typeof TMDB_API_KEY !== "undefined" && TMDB_API_KEY ? TMDB_API_KEY : "";
    if (!key) throw new Error("TMDB_API_KEY is not configured in the Nuvio build");
    var url =
        TMDB_BASE +
        path +
        (path.indexOf("?") === -1 ? "?" : "&") +
        "api_key=" +
        encodeURIComponent(key) +
        "&language=en-US";
    // TMDB resets a connection now and then; retry so a reset does not read as
    // "no streams".
    var res = null;
    var attempts = 3;
    for (var attempt = 0; attempt < attempts; attempt++) {
        try {
            res = await withTimeout(
                fetch(url, { headers: { Accept: "application/json" } }),
                "TMDB " + path
            );
            break;
        } catch (e) {
            if (attempt === attempts - 1) throw e;
        }
    }
    if (!res.ok) throw new Error("TMDB HTTP " + res.status + " for " + path);
    return await res.json();
}

/** English name, romaji alternatives (what AniList indexes), and season count. */
async function getTmdbInfo(tmdbId, mediaType) {
    var kind = String(mediaType || "").toLowerCase() === "movie" ? "movie" : "tv";
    var data = await tmdbJson("/" + kind + "/" + encodeURIComponent(tmdbId));

    var titles = [];
    function add(value) {
        if (value && titles.indexOf(value) === -1) titles.push(value);
    }
    add(data.name || data.title);
    add(data.original_name || data.original_title);

    var year = String(data.release_date || data.first_air_date || "").slice(0, 4);
    var lastSeason = toInt(data.number_of_seasons, 0);
    if (!lastSeason && Array.isArray(data.seasons)) lastSeason = data.seasons.length;
    var seasons = [];
    if (Array.isArray(data.seasons)) {
        for (var s = 0; s < data.seasons.length; s++) {
            var row = data.seasons[s] || {};
            seasons.push({ n: toInt(row.season_number, 0), c: toInt(row.episode_count, 0) });
        }
    }

    // JP-region alternative titles carry the romaji name AniList indexes
    // ("Sousou no Frieren"), so they lead the search. Non-fatal on failure.
    var jpTitles = [];
    try {
        var alt = await tmdbJson("/" + kind + "/" + encodeURIComponent(tmdbId) + "/alternative_titles");
        // TV answers with `results`, movies with `titles`.
        var rows = (alt && (alt.results || alt.titles)) || [];
        for (var i = 0; i < rows.length; i++) {
            var row2 = rows[i] || {};
            if (!isAscii(row2.title)) continue;
            add(row2.title);
            if (String(row2.iso_3166_1 || "").toUpperCase() === "JP" && jpTitles.indexOf(row2.title) === -1) {
                jpTitles.push(row2.title);
            }
        }
    } catch (e) {
        console.error("[SeaDex] alternative titles unavailable: " + (e && e.message));
    }
    jpTitles.sort(function (a, b) {
        return a.length - b.length;
    });

    return {
        kind: kind,
        titles: titles,
        jpTitles: jpTitles,
        year: year || null,
        lastSeason: lastSeason || null,
        seasons: seasons
    };
}

// ---------------------------------------------------------------------------
// Content ids
//
// Nuvio passes whatever id the active meta provider uses. TmdbService usually
// converts it to a TMDB number first, but IMDb and Kitsu ids still arrive when
// that conversion fails.
// ---------------------------------------------------------------------------

function asciiTitles(values) {
    var out = [];
    for (var i = 0; i < values.length; i++) {
        var v = values[i] && String(values[i]).trim();
        if (v && isAscii(v) && out.indexOf(v) === -1) out.push(v);
    }
    return out;
}

async function kitsuInfo(kitsuId) {
    var res = await withTimeout(
        fetch(KITSU_BASE + "/anime/" + encodeURIComponent(kitsuId), {
            headers: { Accept: "application/vnd.api+json" }
        }),
        "Kitsu"
    );
    if (!res.ok) throw new Error("Kitsu HTTP " + res.status);
    var body = await res.json();
    var attrs = (body && body.data && body.data.attributes) || {};
    var t = attrs.titles || {};
    var titles = asciiTitles([t.en_jp, attrs.canonicalTitle, t.en]);
    var hint = seasonNumberFromTitle(titles.join(" "));
    return {
        kind: "tv",
        titles: titles,
        jpTitles: asciiTitles([t.en_jp, attrs.canonicalTitle]),
        year: String(attrs.startDate || "").slice(0, 4) || null,
        lastSeason: null,
        seasons: [],
        // A per-season Kitsu entry carries its season in the title while the
        // app always reports season 1 for an anime entry.
        seasonHint: hint != null && hint !== 99 ? hint : null
    };
}

async function resolveContent(contentId, mediaType) {
    var raw = String(contentId == null ? "" : contentId).trim();
    var kitsu = raw.match(/^kitsu:(\d+)/);
    if (kitsu) return await kitsuInfo(kitsu[1]);

    var imdb = raw.match(/^(tt\d+)/);
    if (imdb) {
        var found = await tmdbJson("/find/" + encodeURIComponent(imdb[1]) + "?external_source=imdb_id");
        var wantMovie = String(mediaType || "").toLowerCase() === "movie";
        var tv = (found && found.tv_results) || [];
        var movies = (found && found.movie_results) || [];
        var pick = wantMovie ? movies[0] || tv[0] : tv[0] || movies[0];
        if (!pick || !pick.id) throw new Error("No TMDB match for " + imdb[1]);
        return await getTmdbInfo(String(pick.id), mediaType);
    }

    var tmdb = raw.match(/^(?:tmdb[\/:])?(\d+)$/);
    if (tmdb) return await getTmdbInfo(tmdb[1], mediaType);

    throw new Error("unsupported content id: " + raw);
}

/** Absolute episode from TMDB's per-season episode counts. Fansub batches
 *  number long-running anime continuously while TMDB reports S2E7. */
function absoluteEpisodeFrom(seasons, season, episode) {
    if (!seasons || !seasons.length || !(season > 1)) return null;
    var sum = 0;
    for (var i = 0; i < seasons.length; i++) {
        var s = seasons[i] || {};
        if (s.n >= 1 && s.n < season) sum += toInt(s.c, 0);
    }
    return sum > 0 ? sum + episode : null;
}

// ---------------------------------------------------------------------------
// AniList: TMDB title -> the AniList entry SeaDex is keyed by
// ---------------------------------------------------------------------------

/** How well one AniList hit's names match the show. 0 means "different show". */
function titleMatchScore(media, wanted) {
    var names = [];
    var t = media && media.title ? media.title : {};
    function add(v) {
        if (v) names.push(v);
    }
    add(t.romaji);
    add(t.english);
    add(t.native);
    var syn = (media && media.synonyms) || [];
    for (var s = 0; s < syn.length; s++) add(syn[s]);

    var best = 0;
    for (var i = 0; i < names.length; i++) {
        var a = normTitle(stripSeasonMarkers(decodeEntities(names[i])));
        if (!a) continue;
        for (var j = 0; j < wanted.length; j++) {
            var b = normTitle(stripSeasonMarkers(wanted[j]));
            if (!b) continue;
            if (a === b) {
                best = Math.max(best, 3);
                continue;
            }
            // A season/arc entry extends the show's name ("Kimetsu no Yaiba:
            // Yuukaku-hen"), so one name being a word-prefix of the other is
            // the same franchise. Matching anywhere would also accept a
            // different show that merely ends in the title ("Koisuru One
            // Piece"), which must stay out.
            if (a.indexOf(b + " ") === 0 || b.indexOf(a + " ") === 0) {
                best = Math.max(best, 2);
                continue;
            }
            // Token overlap catches "86" vs "86 Eighty Six" and subtitle
            // variants without accepting a spin-off with one shared word.
            var aa = a.split(" ");
            var bb = b.split(" ");
            var common = 0;
            for (var k = 0; k < aa.length; k++) if (bb.indexOf(aa[k]) !== -1) common++;
            var ratio = common / Math.min(aa.length, bb.length);
            if (ratio >= 0.75 && Math.min(aa.length, bb.length) >= 2) best = Math.max(best, 1);
        }
    }
    return best;
}

async function searchAniList(title) {
    var query =
        "query($s:String){Page(perPage:20){media(search:$s,type:ANIME)" +
        "{id idMal format seasonYear episodes title{romaji english native} synonyms}}}";
    for (var attempt = 0; attempt < 2; attempt++) {
        try {
            var res = await withTimeout(
                fetch(ANILIST_API, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                        "User-Agent": UA
                    },
                    body: JSON.stringify({ query: query, variables: { s: title } })
                }),
                "AniList"
            );
            // AniList allows a small number of requests per minute; one short
            // retry recovers a burst without turning it into "no streams".
            if (res.status === 429 && attempt === 0 && HAS_TIMERS) {
                await delay(1500);
                continue;
            }
            if (!res.ok) throw new Error("AniList HTTP " + res.status);
            var body = await res.json();
            return (body && body.data && body.data.Page && body.data.Page.media) || [];
        } catch (e) {
            if (attempt === 0 && HAS_TIMERS && /HTTP 429/.test(String(e && e.message))) {
                await delay(1500);
                continue;
            }
            console.error("[SeaDex] AniList '" + title + "' failed: " + (e && e.message));
            return [];
        }
    }
    return [];
}

/** The season an AniList entry represents, from its own names ("Season 2",
 *  "2nd Season", "Final Season"). Arc-titled entries ("Yuukaku-hen") say
 *  nothing, so they default to 1; the file's own SxxExx decides the match. */
function seasonOf(media, req) {
    var t = media && media.title ? media.title : {};
    var names = [t.romaji, t.english, t.native].concat((media && media.synonyms) || []);
    for (var i = 0; i < names.length; i++) {
        var d = seasonNumberFromTitle(names[i]);
        if (d != null) return d === 99 ? req.lastSeason || 1 : d;
    }
    return 1;
}

/** Formats whose releases can hold the requested episode. Specials/OVAs are
 *  separate AniList entries and never carry the episode's SxxExx. */
function formatAllowed(format, isMovie) {
    var f = String(format || "").toUpperCase();
    if (isMovie) return f === "MOVIE" || f === "ONA" || f === "";
    return f === "TV" || f === "TV_SHORT" || f === "ONA" || f === "";
}

function candidateScore(m, match, req) {
    var season = seasonOf(m, req);
    var score = match * 20;
    if (season === req.season) score += 60;
    if (req.isMovie) score += m.format === "MOVIE" ? 20 : 0;
    else if (m.format === "TV") score += 10;
    else if (m.format === "TV_SHORT" || m.format === "ONA") score += 5;
    if (req.year && m.seasonYear) {
        var d = Math.abs(toInt(m.seasonYear, 0) - toInt(req.year, 0));
        if (d === 0) score += 12;
        else if (d === 1) score += 8;
        else if (d <= 2) score += 3;
        else if (d > 6) score -= 8;
    }
    if (!req.isMovie && req.season === 1 && m.episodes && req.episode && m.episodes < req.episode) {
        score -= 10;
    }
    return { media: m, score: score, season: season, match: match };
}

/** Every AniList entry that could be this show's requested season, best
 *  first. SeaDex is keyed by AniList id and later seasons are separate,
 *  often arc-titled entries, so the caller fetches each and lets the file's
 *  SxxExx / absolute number pick the episode. Only exact or word-prefix
 *  title matches are fetched; a loose single match is kept as a fallback. */
function rankCandidates(media, req) {
    var out = [];
    var seen = {};
    for (var i = 0; i < media.length; i++) {
        var m = media[i];
        if (!m || m.id == null || seen[m.id]) continue;
        seen[m.id] = true;
        var match = titleMatchScore(m, req.titles);
        if (!match) continue;
        if (!formatAllowed(m.format, req.isMovie)) continue;
        out.push(candidateScore(m, match, req));
    }
    out.sort(function (a, b) {
        return b.score - a.score;
    });
    var strong = [];
    for (var s = 0; s < out.length; s++) if (out[s].match >= 2) strong.push(out[s]);
    return strong.length ? strong : out.slice(0, 1);
}

async function resolveAniListCandidates(titles, req) {
    var queries = titles.slice(0, 2);
    var seen = {};
    var media = [];
    // Query the romaji name first and stop as soon as it yields strong hits;
    // the second query is the fallback for shows AniList spells differently.
    // This keeps the common lookup to one AniList request (it rate-limits).
    for (var q = 0; q < queries.length; q++) {
        var batch = await searchAniList(queries[q]);
        for (var i = 0; i < batch.length; i++) {
            var m = batch[i];
            if (!m || m.id == null || seen[m.id]) continue;
            seen[m.id] = true;
            media.push(m);
        }
        var found = rankCandidates(media, req);
        if (found.length && found[0].match >= 2) return found;
    }
    return rankCandidates(media, req);
}

// ---------------------------------------------------------------------------
// SeaDex
// ---------------------------------------------------------------------------

async function seadexTorrents(alID) {
    var url =
        SEADEX_API +
        "?perPage=5&filter=" +
        encodeURIComponent("(alID=" + alID + ")") +
        "&expand=trs";
    var res = await withTimeout(fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } }), "SeaDex");
    if (!res.ok) throw new Error("SeaDex HTTP " + res.status);
    var body = await res.json();
    var items = body.items || [];
    var out = [];
    for (var i = 0; i < items.length; i++) {
        var expanded = items[i] && items[i].expand && items[i].expand.trs;
        if (!expanded) continue;
        for (var t = 0; t < expanded.length; t++) out.push(expanded[t]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Release/file matching
// ---------------------------------------------------------------------------

function isVideoName(name) {
    return /\.(mkv|mp4|m4v|avi|webm|ts|m2ts|mov|wmv)$/i.test(String(name || ""));
}

/** 1080p or better, from the file name. Returns null when it does not say.
 *  The token may be glued to letters ("BD1080p"), so no leading \b. */
function resolutionOf(name) {
    var t = String(name || "");
    var m = t.match(/(\d{3,4})\s*[pP]\b/);
    if (m) {
        var h = toInt(m[1], 0);
        if (h >= 2000) return { label: "2160p", height: 2160 };
        if (h >= 1440) return { label: "1440p", height: 1440 };
        if (h >= 1080) return { label: "1080p", height: 1080 };
        if (h >= 900) return { label: "900p", height: 900 };
        if (h >= 720) return { label: "720p", height: 720 };
        if (h >= 576) return { label: "576p", height: 576 };
        if (h >= 480) return { label: "480p", height: 480 };
    }
    if (/\b(?:4k|uhd)\b/i.test(t)) return { label: "2160p", height: 2160 };
    m = t.match(/\b(\d{3,4})\s*[xX]\s*(\d{3,4})\b/);
    if (m) {
        // Width x Height: the short side is the resolution.
        var hh = Math.min(toInt(m[1], 0), toInt(m[2], 0));
        if (hh >= 2000) return { label: "2160p", height: 2160 };
        if (hh >= 1440) return { label: "1440p", height: 1440 };
        if (hh >= 1080) return { label: "1080p", height: 1080 };
        if (hh >= 720) return { label: "720p", height: 720 };
    }
    return null;
}

/** Explicitly sub-1080p sources, so a resolution-silent name is not guessed
 *  into the list as HD. */
function isSdName(name) {
    return /\b(?:dvdrip|dvd|hdtvrip|480p|576p|720p|sd)\b/i.test(String(name || ""));
}

/** HDR markers, kept as whole tokens so "HDRip"/"DVDRip" do not match. */
function isHdr(name) {
    return /\b(?:hdr10\+?|hdr|hlg|dolby[\s.]?vision|dovi)\b/i.test(String(name || ""));
}

/** Episode/absolute tokens used by scene and fansub file names. */
function fileEpisode(name) {
    var t = String(name || "");
    var info = { season: null, episode: null, absolute: null };
    var m = t.match(/\bS(\d{1,2})\s*E(?:P)?\s*(\d{1,4})(?!\.\d)(?:v\d)?\b/i);
    if (m) {
        info.season = toInt(m[1], null);
        info.episode = toInt(m[2], null);
    }
    if (info.episode == null) {
        m = t.match(/\bS(\d{1,2})\s*[-_ ]\s*(\d{1,4})(?!\.\d)(?:v\d)?\b/i);
        if (m) {
            info.season = toInt(m[1], null);
            info.episode = toInt(m[2], null);
        }
    }
    if (info.episode == null) {
        m = t.match(/\bSeason\s*(\d{1,2})\s*(?:Episode|Ep\.?|E)\s*(\d{1,4})(?!\.\d)(?:v\d)?\b/i);
        if (m) {
            info.season = toInt(m[1], null);
            info.episode = toInt(m[2], null);
        }
    }
    // "Season 3 - 01" and "2nd Season - 01" carry the season but not the
    // SxxExx form; keep it so a season-1 request cannot take season 3's file.
    if (info.season == null) {
        m =
            t.match(/\bSeason\s*(\d{1,2})\b/i) ||
            t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i) ||
            t.match(/第\s*(\d{1,2})\s*期/);
        if (m) info.season = toInt(m[1], null);
    }
    if (info.episode == null) {
        m = t.match(/\b(?:Episode|Ep\.?|E)\s*(\d{1,4})(?!\.\d)(?:v\d)?\b/i);
        if (m) info.episode = toInt(m[1], null);
    }
    if (info.episode == null) {
        var rest = t
            .replace(/\bSeason\s*\d{1,2}\b/gi, " ")
            .replace(/\(\s*S\d{1,2}\s*\)/gi, " ")
            .replace(/\bS\d{1,2}\b/gi, " ");
        m =
            rest.match(/(?:^|[\s_])-[\s_]*(\d{1,4})(?!\.\d)(?:v\d)?(?=[\s_\]]|[\[\(\.]|$)/i) ||
            rest.match(/[\[\(](\d{1,3})(?!\.\d)(?:v\d)?[\]\)]/) ||
            rest.match(/(?:^|[\s_])(\d{1,3})(?!\.\d)(?:v\d)?(?=[\s_]*[\[\(])/);
        if (m) info.episode = toInt(m[1], null);
    }
    var abs = t.match(/\((\d{2,4})\)/);
    if (abs) {
        var a = toInt(abs[1], null);
        if (a != null && a >= 1 && a <= 2000) info.absolute = a;
    }
    return info;
}

function isSpecialFile(name) {
    var t = String(name || "");
    if (/\b(?:ova|oad)s?\b/i.test(t)) return true;
    if (/\b(?:special|specials|recap|picture drama|chibi|junior high|ncop|nced|creditless|preview)\b/i.test(t)) return true;
    if (/\b(?:menu|trailer|teaser|interview|making of)\b/i.test(t)) return true;
    return false;
}

/** Does this file inside a release hold the requested episode? */
function nameMatchesEpisode(name, req) {
    if (isSpecialFile(name)) return false;
    var e = fileEpisode(name);
    function absOk(n) {
        return n != null && (n === req.episode || (req.absoluteEpisode != null && n === req.absoluteEpisode));
    }
    if (e.season != null) {
        if (e.season === req.season && e.episode === req.episode) return true;
        if (absOk(e.absolute)) return true;
        // Continuous numbering inside a season-1-labelled batch (S2E7 is the
        // 58th file and named S01E58 by groups that never restart).
        if (
            req.absoluteEpisode != null &&
            req.absoluteEpisode !== req.episode &&
            e.season === 1 &&
            req.season > 1 &&
            e.episode === req.absoluteEpisode
        ) {
            return true;
        }
        return false;
    }
    if (e.absolute != null && absOk(e.absolute)) return true;
    if (e.episode == null) return false;
    // A season-less file ("Show - 01") is numbered inside its own AniList
    // entry, so it only counts when that entry is the requested season.
    if (e.episode === req.episode && req.derivedSeason === req.season) return true;
    // Absolute numbering only when it actually crosses seasons; for season 1
    // it equals the episode number and must not bypass the season guard.
    if (req.absoluteEpisode != null && req.absoluteEpisode !== req.episode && e.episode === req.absoluteEpisode) {
        return true;
    }
    return false;
}

/** The file in this release that is the requested episode, or null. */
function pickEpisodeFile(torrent, req) {
    var files = torrent.files || [];
    var picked = null;
    for (var i = 0; i < files.length; i++) {
        var f = files[i] || {};
        var name = f.name || "";
        if (!isVideoName(name)) continue;
        if (req.isMovie) {
            if (!picked || toInt(f.length, 0) > picked.length) {
                picked = { idx: i, name: name, length: toInt(f.length, 0) };
            }
            continue;
        }
        if (!nameMatchesEpisode(name, req)) continue;
        var r = resolutionOf(name);
        var height = r ? r.height : 0;
        if (!picked || height > picked.height) {
            picked = { idx: i, name: name, length: toInt(f.length, 0), height: height };
        }
    }
    return picked;
}

/** SeaDex's own ordering: best first, then resolution, then the entry most
 *  likely to be the requested season, then dual audio. */
function rankTorrents(list) {
    list.sort(function (a, b) {
        if (a.best !== b.best) return a.best ? -1 : 1;
        if (b.height !== a.height) return b.height - a.height;
        if (a.entryRank !== b.entryRank) return a.entryRank - b.entryRank;
        if (a.dual !== b.dual) return a.dual ? -1 : 1;
        var ag = a.group.toLowerCase();
        var bg = b.group.toLowerCase();
        return ag < bg ? -1 : ag > bg ? 1 : 0;
    });
    return list;
}

function makeResult(item, rank) {
    var quality = item.inferred
        ? "HD"
        : item.height >= 2160
        ? "2160p"
        : item.height >= 1440
        ? "1440p"
        : "1080p";
    var base = item.name.replace(/\.[a-z0-9]{2,4}$/i, "").trim();
    if (base.length > 150) base = base.slice(0, 147) + "...";
    // Nuvio renders `name` as the bold row label, then re-sorts plugin rows
    // alphabetically (sortedForGroupedDisplay). The zero-padded rank prefix
    // preserves this order through that sort.
    var label = pad2(rank) + " · " + (item.best ? "Best · " : "") + base;
    return {
        name: label,
        title: base,
        // A multi-file release must name the episode file or the P2P engine
        // opens the largest file. Nuvio reads the index from this scheme.
        url: item.multi
            ? "torrent://" + item.hash + "/" + item.idx
            : "magnet:?xt=urn:btih:" + item.hash,
        infoHash: item.hash,
        quality: quality + (isHdr(item.name) ? " HDR" : ""),
        size: item.length ? formatSize(item.length) : null,
        language: item.dual ? "Dual Audio" : "Sub",
        provider: "SeaDex",
        type: "torrent",
        seeders: null,
        peers: null,
        subtitles: []
    };
}

/** Romaji first: AniList and release names use it. */
function queryTitles(info) {
    var out = [];
    function add(value) {
        if (!value || !isAscii(value)) return;
        var t = String(value).trim();
        if (!t || out.indexOf(t) !== -1) return;
        out.push(t);
    }
    var jp = (info.jpTitles || []).slice().sort(function (a, b) {
        return a.length - b.length;
    });
    for (var i = 0; i < jp.length; i++) add(jp[i]);
    for (var j = 0; j < info.titles.length; j++) add(info.titles[j]);
    return out.slice(0, 2);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function getStreams(tmdbId, mediaType, season, episode) {
    var results = [];
    var isMovie = String(mediaType || "").toLowerCase() === "movie";

    try {
        var info = await resolveContent(tmdbId, mediaType);
        var titles = queryTitles(info);
        if (!titles.length) {
            console.error("[SeaDex] no searchable title for " + mediaType + " " + tmdbId);
            return results;
        }

        var req = {
            titles: info.titles,
            isMovie: isMovie,
            // Anime ids are per-season, so the real season is in the title
            // ("... Season 2") while the app always reports season 1.
            season: info.seasonHint || toInt(season, 1),
            episode: toInt(episode, 1),
            absoluteEpisode: null,
            derivedSeason: 1,
            lastSeason: info.lastSeason,
            year: info.year
        };
        if (!isMovie) {
            req.absoluteEpisode = absoluteEpisodeFrom(info.seasons, req.season, req.episode);
            // Nuvio's bridge passes only four args, so the absolute episode the
            // app knows is never handed over; TMDB's season counts are the
            // fallback. A single-season request is already absolute.
            if (req.absoluteEpisode == null) req.absoluteEpisode = req.episode;
        }

        var candidates = await resolveAniListCandidates(titles, req);
        if (!candidates.length) {
            console.log("[SeaDex] no AniList match for '" + titles[0] + "'");
            return results;
        }
        candidates = candidates.slice(0, MAX_ENTRIES);

        // Fetch every plausible season entry at once; the file name decides
        // which torrent actually holds the episode. Later seasons are
        // separate, often arc-titled AniList entries, so guessing one entry
        // silently loses those episodes.
        var lists = await Promise.all(
            candidates.map(function (c) {
                return seadexTorrents(c.media.id).catch(function () {
                    return [];
                });
            })
        );

        var found = [];
        var seen = {};
        var torrentCount = 0;
        for (var c = 0; c < candidates.length; c++) {
            // Season-less files ("- 60") only count when the entry is the
            // requested season; set it per entry before matching.
            req.derivedSeason = candidates[c].season;
            var torrents = lists[c];
            torrentCount += torrents.length;
            for (var i = 0; i < torrents.length; i++) {
                var torrent = torrents[i] || {};
                var hash = String(torrent.infoHash || "").toLowerCase();
                // Private-tracker copies have their info hash redacted by
                // SeaDex; without a hash there is no magnet, so they cannot be
                // played.
                if (!/^[0-9a-f]{40}$/.test(hash)) continue;
                if (seen[hash]) continue;

                var file = pickEpisodeFile(torrent, req);
                if (!file) continue;
                var resolution = resolutionOf(file.name);
                var inferred = false;
                if (resolution) {
                    // 1080p or higher only.
                    if (resolution.height < 1080) continue;
                } else if (torrent.isBest && !isSdName(file.name)) {
                    // SeaDex lists curated best releases, which are HD even when
                    // the file name omits the token; anything explicitly SD or
                    // non-best stays out rather than guessing.
                    inferred = true;
                } else {
                    continue;
                }

                seen[hash] = true;
                found.push({
                    hash: hash,
                    idx: file.idx,
                    name: file.name,
                    length: file.length,
                    height: resolution ? resolution.height : 1080,
                    inferred: inferred,
                    best: !!torrent.isBest,
                    dual: !!torrent.dualAudio,
                    group: String(torrent.releaseGroup || ""),
                    multi: (torrent.files || []).length > 1,
                    entryRank: c
                });
            }
        }

        found = rankTorrents(found);
        for (var n = 0; n < found.length && results.length < MAX_RESULTS; n++) {
            results.push(makeResult(found[n], n + 1));
        }
        console.log(
            "[SeaDex] S" + req.season + "E" + req.episode + " entries=" + candidates.length +
            " torrents=" + torrentCount + " playable=" + found.length +
            " returning=" + results.length
        );
    } catch (e) {
        console.error("[SeaDex] getStreams error:", (e && e.message) || e, (e && e.stack) || "");
    }

    return results;
}

module.exports = { getStreams };