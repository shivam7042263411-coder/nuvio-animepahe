// =============================================================================
// Nyaa Torrents - NuvioTV plugin (QuickJS / PluginRuntime)
//
// A separate scraper from the SeaDex one, so the two load independently: a
// slow or blocked nyaa.si can never hold up the SeaDex provider (or the other
// way round).
//
// Pipeline:
//   content id (TMDB / IMDb / Kitsu) -> titles (+ season count)
//     -> nyaa.si RSS (category "Anime - English-translated", no JSON API)
//     -> the release that is this show and this episode, 1080p+, with seeders
//     -> a self-contained magnet (name + public trackers)
//
// Nyaa's RSS carries no file list, so a multi-episode batch cannot be aimed at
// one episode (Nuvio would open its largest file). Batches are skipped here;
// the SeaDex provider covers those, because SeaDex does carry file lists.
// A torrent with no seeder never starts, so zero-seeder releases are dropped:
// that is the "no dead links" rule.
// =============================================================================

var TMDB_BASE = "https://api.themoviedb.org/3";
var KITSU_BASE = "https://kitsu.io/api/edge";
var NYAA_RSS = "https://nyaa.si/?page=rss";
// "Anime - English-translated": carries subbed and dual-audio releases. Raw
// (Japanese, no subs) and non-English dubs are left out.
var NYAA_CATEGORY = "1_2";
// "No dead links": a torrent with no seeder never starts, so it is dropped.
var NYAA_MIN_SEEDERS = 1;
// Public trackers put in every magnet so playback can start on any client
// (Nuvio adds its own set too; external players on other devices need these).
var MAGNET_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce"
];
var MAX_RESULTS = 10;

// Nuvio kills a plugin after 60s and its fetch cannot be cancelled, so bound
// every request: a blocked host would otherwise hold this provider open.
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
        // Drop apostrophes so "Journey's End", "Journeys End" and the backtick
        // variant groups use all compare equal to the TMDB title.
        .replace(/['\u2018\u2019\u02bc`\u00b4]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Title with season/cour markers removed, so "Frieren Season 2" compares
 *  equal to "Frieren" when matching a release to the show. */
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

// Nuvio's Android TV runtime traditionally bridged fewer host functions than
// the mobile one. Timer support is detected once; without it the host's own
// 60s cap still bounds the call, so a slow host costs results, never a crash.
var HAS_TIMERS = typeof setTimeout === "function";

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

/** GET text with retries. Nyaa resets the connection now and then, and a
 *  single reset must not read as "no torrents". */
async function fetchText(url, label) {
    var attempts = 3;
    var last = null;
    for (var attempt = 0; attempt < attempts; attempt++) {
        try {
            var res = await withTimeout(
                fetch(url, {
                    headers: { Accept: "application/rss+xml, application/xml, text/xml, */*", "User-Agent": UA }
                }),
                label
            );
            if (res.ok) return await res.text();
            last = new Error(label + " HTTP " + res.status);
            if (res.status >= 400 && res.status < 500) break;
        } catch (e) {
            last = e;
        }
    }
    throw last || new Error(label + " failed");
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

/** English name, romaji alternatives (what the releases use), and season count. */
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

    // JP-region alternative titles carry the romaji name the releases use
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
        console.error("[Nyaa] alternative titles unavailable: " + (e && e.message));
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
// Release name matching
// ---------------------------------------------------------------------------

/** 1080p or better, from the release name. Returns null when it does not say.
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

/** HDR markers, kept as whole tokens so "HDRip"/"DVDRip" do not match. */
function isHdr(name) {
    return /\b(?:hdr10\+?|hdr|hlg|dolby[\s.]?vision|dovi)\b/i.test(String(name || ""));
}

/** Episode/absolute tokens used by scene and fansub release names. */
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

/** Does this release name hold the requested episode? */
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
    // A season-less release ("Show - 01") is numbered inside its own season,
    // so it only counts when that season is the requested one.
    if (e.episode === req.episode && req.derivedSeason === req.season) return true;
    // Absolute numbering only when it actually crosses seasons; for season 1
    // it equals the episode number and must not bypass the season guard.
    if (req.absoluteEpisode != null && req.absoluteEpisode !== req.episode && e.episode === req.absoluteEpisode) {
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Nyaa (nyaa.si)
//
// RSS gives the release name, info hash, size and seeder count; that is
// everything a magnet needs. It gives no file list, so batches are skipped.
// ---------------------------------------------------------------------------

function tagValue(block, name) {
    var open = "<" + name + ">";
    var close = "</" + name + ">";
    var i = block.indexOf(open);
    if (i === -1) return null;
    var j = block.indexOf(close, i + open.length);
    if (j === -1) return null;
    return block.slice(i + open.length, j).trim();
}

function parseNyaaRss(xml) {
    var out = [];
    var parts = String(xml || "").split("<item>");
    for (var i = 1; i < parts.length; i++) {
        var block = parts[i].split("</item>")[0];
        var name = decodeEntities(tagValue(block, "title") || "");
        var hash = String(tagValue(block, "nyaa:infoHash") || "").toLowerCase();
        if (!name || !/^[0-9a-f]{40}$/.test(hash)) continue;
        var group = (name.match(/^\s*\[([^\]]+)\]/) || [])[1] || "";
        out.push({
            name: name,
            hash: hash,
            seeders: toInt(tagValue(block, "nyaa:seeders"), 0),
            trusted: String(tagValue(block, "nyaa:trusted") || "").toLowerCase() === "yes",
            size: tagValue(block, "nyaa:size") || null,
            group: group
        });
    }
    return out;
}

async function nyaaSearch(query) {
    var url = NYAA_RSS + "?c=" + NYAA_CATEGORY + "&q=" + encodeURIComponent(query);
    try {
        return parseNyaaRss(await fetchText(url, "Nyaa"));
    } catch (e) {
        console.error("[Nyaa] '" + query + "' failed: " + (e && e.message));
        return [];
    }
}

/** Multi-episode or season pack: its magnet would open the largest file, not
 *  the requested episode, so it cannot be used. */
function isBatchName(name) {
    var t = String(name || "");
    if (/\b(?:batch|complete|all\s+episodes)\b/i.test(t)) return true;
    // S01E01-E12, S02E01-E07
    if (/\bS\d{1,2}E\d{1,3}\s*[-~]\s*(?:S\d{1,2})?E?\d{1,3}\b/i.test(t)) return true;
    // S01-S03
    if (/\bS\d{1,2}\s*[-~]\s*S\d{1,2}\b/i.test(t)) return true;
    // (01-12), [01~12]
    if (/[\(\[]\s*\d{1,3}\s*[-~]\s*\d{1,3}\s*[\)\]]/.test(t)) return true;
    // Bare "01-12". The <=200 guard keeps codec tokens ("x265-10bit") out.
    var m = t.match(/\b(\d{1,3})\s*[-~]\s*(\d{1,3})\b/);
    if (m && toInt(m[1], 0) <= 200 && toInt(m[2], 0) <= 200) return true;
    return false;
}

/** The release must name this show, not merely share the episode token the
 *  fuzzy RSS search matched. The title has to appear as a whole phrase, so
 *  "One Piece" does not accept "One Piece of Cake". */
function releaseMatchesTitle(release, titles) {
    var a = normTitle(stripSeasonMarkers(decodeEntities(release)));
    if (!a) return false;
    var padded = " " + a + " ";
    for (var i = 0; i < titles.length; i++) {
        var b = normTitle(stripSeasonMarkers(titles[i]));
        if (b && padded.indexOf(" " + b + " ") !== -1) return true;
    }
    return false;
}

function isDualName(name) {
    return /\bdual[\s._-]?audio\b/i.test(String(name || ""));
}

async function nyaaReleases(searchTitles, guardTitles, req) {
    var primary = searchTitles[0];
    if (!primary) return [];
    var queries;
    if (req.isMovie) {
        queries = [];
        var pool = searchTitles.concat(guardTitles || []);
        for (var t = 0; t < pool.length && queries.length < 2; t++) {
            if (pool[t] && isAscii(pool[t]) && queries.indexOf(pool[t]) === -1) queries.push(pool[t]);
        }
    } else {
        var ep = pad2(req.episode);
        // Two searches, merged: scene-style groups name the episode "SxxExx",
        // fansub groups name it "- NN" (or "S2 - NN" / "2nd Season - NN").
        // Nyaa's search is fuzzy, so the results are filtered below anyway.
        queries = [primary + " S" + pad2(req.season) + "E" + ep, primary + " - " + ep];
    }

    var lists = await Promise.all(
        queries.map(function (q) {
            return nyaaSearch(q);
        })
    );

    var seen = {};
    var out = [];
    for (var l = 0; l < lists.length; l++) {
        var list = lists[l] || [];
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            if (seen[r.hash]) continue;
            seen[r.hash] = true;
            if (r.seeders < NYAA_MIN_SEEDERS) continue;
            if (!releaseMatchesTitle(r.name, guardTitles && guardTitles.length ? guardTitles : searchTitles)) continue;
            if (isBatchName(r.name)) continue;
            if (isSpecialFile(r.name)) continue;
            var resolution = resolutionOf(r.name);
            // 1080p or higher only, and the name has to say so.
            if (!resolution || resolution.height < 1080) continue;
            if (!req.isMovie && !nameMatchesEpisode(r.name, req)) continue;
            out.push({
                hash: r.hash,
                idx: 0,
                name: r.name,
                sizeText: r.size,
                height: resolution.height,
                trusted: r.trusted,
                dual: isDualName(r.name),
                group: r.group,
                seeders: r.seeders
            });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Highest resolution first, then the better-seeded (working) release, then
 *  dual audio. */
function rankTorrents(list) {
    list.sort(function (a, b) {
        if (b.height !== a.height) return b.height - a.height;
        if (!!a.trusted !== !!b.trusted) return a.trusted ? -1 : 1;
        var as = a.seeders || 0;
        var bs = b.seeders || 0;
        if (bs !== as) return bs - as;
        if (a.dual !== b.dual) return a.dual ? -1 : 1;
        var ag = a.group.toLowerCase();
        var bg = b.group.toLowerCase();
        return ag < bg ? -1 : ag > bg ? 1 : 0;
    });
    return list;
}

/** Self-contained magnet: name plus public trackers, so it also plays in an
 *  external client on another device, not only in Nuvio's P2P engine. */
function magnetFor(item) {
    var url = "magnet:?xt=urn:btih:" + item.hash;
    if (item.name) url += "&dn=" + encodeURIComponent(item.name);
    for (var i = 0; i < MAGNET_TRACKERS.length; i++) {
        url += "&tr=" + encodeURIComponent(MAGNET_TRACKERS[i]);
    }
    return url;
}

function makeResult(item, rank) {
    var quality = item.height >= 2160 ? "2160p" : item.height >= 1440 ? "1440p" : "1080p";
    var base = String(item.name || "").replace(/\.[a-z0-9]{2,4}$/i, "").trim();
    if (base.length > 150) base = base.slice(0, 147) + "...";
    // Nuvio renders `name` as the bold row label, then re-sorts plugin rows
    // alphabetically (sortedForGroupedDisplay). The zero-padded rank prefix
    // preserves this order through that sort.
    var label = pad2(rank) + " · " + base;
    var language = item.dual ? "Dual Audio" : "Sub";
    if (item.seeders != null) language += " · " + item.seeders + " seeders";
    return {
        name: label,
        title: base,
        url: magnetFor(item),
        infoHash: item.hash,
        quality: quality + (isHdr(item.name) ? " HDR" : ""),
        size: item.sizeText || null,
        language: language,
        provider: "Nyaa",
        type: "torrent",
        seeders: item.seeders,
        peers: null,
        subtitles: []
    };
}

/** Romaji first: the releases use it. */
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
            console.error("[Nyaa] no searchable title for " + mediaType + " " + tmdbId);
            return results;
        }

        var req = {
            isMovie: isMovie,
            // Anime ids are per-season, so the real season is in the title
            // ("... Season 2") while the app always reports season 1.
            season: info.seasonHint || toInt(season, 1),
            episode: toInt(episode, 1),
            absoluteEpisode: null,
            // A season-less release ("- 01") is numbered inside its own season,
            // so it only counts for season 1; the absolute number catches
            // continuously numbered releases.
            derivedSeason: 1
        };
        if (!isMovie) {
            req.absoluteEpisode = absoluteEpisodeFrom(info.seasons, req.season, req.episode);
            // Nuvio's bridge passes only four args, so the absolute episode the
            // app knows is never handed over; TMDB's season counts are the
            // fallback. A single-season request is already absolute.
            if (req.absoluteEpisode == null) req.absoluteEpisode = req.episode;
        }

        var found = await nyaaReleases(titles, info.titles, req);
        found = rankTorrents(found);
        for (var n = 0; n < found.length && results.length < MAX_RESULTS; n++) {
            results.push(makeResult(found[n], n + 1));
        }
        console.log("[nyaa] S" + req.season + "E" + req.episode + " playable=" + found.length + " returning=" + results.length);
    } catch (e) {
        console.error("[nyaa] getStreams error:", (e && e.message) || e, (e && e.stack) || "");
    }

    return results;
}

module.exports = { getStreams };
