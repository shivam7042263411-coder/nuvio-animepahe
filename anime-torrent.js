// =============================================================================
// Anime Torrents - NuvioTV plugin (QuickJS / PluginRuntime)
//
// Pipeline:
//   content id (Kitsu / IMDb / TMDB) -> titles (+ season count)
//     -> AnimeTosho HTML search (Nyaa only when AnimeTosho finds nothing)
//     -> strict release matcher (episode token, season guard, batch rejection)
//     -> one magnet per release -> Nuvio's P2P engine or a debrid provider
//
// AnimeTosho carries Nyaa's releases under a base32 info hash (decoded to the
// 40-hex form Nuvio expects) and stays reachable on networks that block Nyaa.
//
// Only single-episode releases are returned. Nuvio's plugin bridge hardcodes
// fileIdx = null, so a batch cannot be resolved to the requested episode.
// =============================================================================

var TMDB_BASE = "https://api.themoviedb.org/3";
var KITSU_BASE = "https://kitsu.io/api/edge";
var NYAA_URL = "https://nyaa.si/";
var ANIMETOSHO_URL = "https://animetosho.org/search";
var MAX_RESULTS = 10;

// Nuvio kills a plugin after 60s. A blocked host (ISP blackhole, firewall)
// never settles a fetch, so every request needs its own ceiling or the whole
// lookup dies before any source answers.
var REQUEST_TIMEOUT_MS = 8000;

var UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTags(value) {
    return String(value == null ? "" : value).replace(/<[^>]*>/g, "");
}

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

function tagText(block, tag) {
    var re = new RegExp(
        "<" + escapeRegExp(tag) + "[^>]*>([\\s\\S]*?)</" + escapeRegExp(tag) + ">",
        "i"
    );
    var m = String(block).match(re);
    return m ? decodeEntities(stripTags(m[1])).trim() : null;
}

function normTitle(value) {
    return String(value == null ? "" : value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isAscii(value) {
    return /^[\x20-\x7e]+$/.test(String(value == null ? "" : value));
}

function tokenList(value) {
    var n = normTitle(value);
    return n ? n.split(" ") : [];
}

/** Keep a release only when its cleaned name contains one of the show's
 *  titles. Release names lead with a group tag ("[SubsPlease] ..."), so a
 *  prefix comparison would reject every real result. */
function isRelevant(title, variants) {
    var t = normTitle(String(title).replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " "));
    if (!t) return false;
    var padded = " " + t + " ";
    for (var i = 0; i < variants.length; i++) {
        var v = normTitle(variants[i]);
        if (v && padded.indexOf(" " + v + " ") !== -1) return true;
    }
    return false;
}

function isCloudflareBlock(text) {
    if (!text) return false;
    var t = String(text);
    return (
        t.indexOf("Just a moment") !== -1 ||
        t.indexOf("Sorry, you have been blocked") !== -1 ||
        t.indexOf("Attention Required! | Cloudflare") !== -1 ||
        t.indexOf("cf-error-details") !== -1
    );
}

function pad2(n) {
    return n < 10 ? "0" + n : String(n);
}

function toInt(value, fallback) {
    var n = parseInt(value, 10);
    return isNaN(n) ? fallback : n;
}

/** Nyaa/AnimeTosho magnets use base32 in 32 chars; Nuvio needs 40-hex btih. */
function base32ToHex(value) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    var s = String(value == null ? "" : value).toUpperCase();
    var bits = "";
    for (var i = 0; i < s.length; i++) {
        var v = alphabet.indexOf(s.charAt(i));
        if (v < 0) return null;
        var bin = v.toString(2);
        while (bin.length < 5) bin = "0" + bin;
        bits += bin;
    }
    var hex = "";
    for (var j = 0; j + 4 <= bits.length; j += 4) {
        hex += parseInt(bits.substr(j, 4), 2).toString(16);
    }
    return hex.length >= 40 ? hex.slice(0, 40) : null;
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
    // TMDB resets a connection now and then on this class of network. Retries
    // turn that into a working lookup instead of "no streams".
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
    if (!res.ok) {
        var why = res.status === 0 && res.statusText ? " (" + res.statusText + ")" : "";
        throw new Error("TMDB HTTP " + res.status + why + " for " + path);
    }
    return await res.json();
}

/** English name, romaji alternatives (Nyaa's release names), and season count. */
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

    // JP-region alternative titles are the romaji Nyaa groups actually use
    // ("Shingeki no Kyojin"), so they lead the search. Non-fatal on failure.
    var jpTitles = [];
    try {
        var alt = await tmdbJson("/" + kind + "/" + encodeURIComponent(tmdbId) + "/alternative_titles");
        var rows = (alt && alt.results) || [];
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i] || {};
            if (!isAscii(row.title)) continue;
            add(row.title);
            if (String(row.iso_3166_1 || "").toUpperCase() === "JP" && jpTitles.indexOf(row.title) === -1) {
                jpTitles.push(row.title);
            }
        }
    } catch (e) {
        console.error("[AnimeTorrents] alternative titles unavailable: " + (e && e.message));
    }
    jpTitles.sort(function (a, b) {
        return tokenList(a).length - tokenList(b).length;
    });

    return { kind: kind, titles: titles, jpTitles: jpTitles, year: year || null, lastSeason: lastSeason || null };
}

// ---------------------------------------------------------------------------
// Content ids
//
// Nuvio hands the plugin whatever id the active meta provider uses, not a bare
// TMDB number: "209867" / "tmdb:209867" (TMDB), "tt22248376" (IMDb), and for
// anime "kitsu:46474:1" (Kitsu id + episode). Each namespace has to resolve to
// the same title/season shape or every lookup 404s against TMDB.
// ---------------------------------------------------------------------------

function asciiTitles(values) {
    var out = [];
    for (var i = 0; i < values.length; i++) {
        var v = values[i] && String(values[i]).trim();
        if (v && isAscii(v) && out.indexOf(v) === -1) out.push(v);
    }
    return out;
}

/** Kitsu entries are one season each; en_jp is the romaji Nyaa groups use. */
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
    var hints = seasonHints(titles.join(" "));
    return {
        kind: "tv",
        titles: titles,
        jpTitles: asciiTitles([t.en_jp, attrs.canonicalTitle]),
        year: String(attrs.startDate || "").slice(0, 4) || null,
        lastSeason: null,
        // "Attack on Titan Season 2" carries its season in the title while the
        // app always reports season 1 for a per-season anime entry.
        seasonHint: hints.length ? hints[0] : null
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

// ---------------------------------------------------------------------------
// Release matching
// ---------------------------------------------------------------------------

function parseQuality(title) {
    var m = String(title).match(/\b(2160p|1080p|900p|720p|576p|480p|360p)\b/i);
    return m ? m[1].toLowerCase() : null;
}

function isDub(title) {
    var t = String(title);
    if (/\b(dual[\s-]*audio|multi[\s-]*audio)\b/i.test(t)) return false;
    return /\b(dub|dubbed)\b/i.test(t);
}

/** Batch/season packs cannot be resolved without fileIdx, so drop them. */
function isBatch(title) {
    var t = String(title);
    if (/(batch|complete|全集|合集)/i.test(t)) return true;
    if (/\bS\d{1,2}\s*[-~]\s*S?\d{1,2}\b/i.test(t)) return true;
    // Season markers are not episode ranges; strip them before the range test
    // so "Season 4 - 01" survives while "01-13" / "01 ~ 12" does not.
    var rest = t
        .replace(/\bSeason\s*\d{1,2}\b/gi, " ")
        .replace(/\bS\d{1,2}\b/gi, " ");
    if (/(^|[^\d.])\d{1,4}\s*[-~–—]\s*\d{1,4}(?![\d.])/.test(rest)) return true;
    if (/\b\d{1,4}\s*\+\s*(?:ova|specials?|extras?|movies?)\b/i.test(rest)) return true;
    return false;
}

/** Season hints, used to reject a different season's episode 1. */
function seasonHints(title) {
    var t = String(title);
    var out = [];
    var re = /\bS(\d{1,2})(?![0-9])/gi;
    var m;
    while ((m = re.exec(t))) out.push(toInt(m[1], 0));
    re = /\bSeason\s*(\d{1,2})\b/gi;
    while ((m = re.exec(t))) out.push(toInt(m[1], 0));
    re = /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/gi;
    while ((m = re.exec(t))) out.push(toInt(m[1], 0));
    return out;
}

/** Season/episode tokens used by scene and fansub release names. */
function episodeInfo(title) {
    var t = String(title);
    var info = { season: null, episode: null, absolute: null };
    var m = t.match(/\bS(\d{1,2})\s*E(?:P)?\s*(\d{1,4})(?:v\d)?\b/i);
    if (m) {
        info.season = toInt(m[1], null);
        info.episode = toInt(m[2], null);
    }
    if (info.episode == null) {
        m = t.match(/\bS(\d{1,2})\s*[-_ ]\s*(\d{1,4})(?:v\d)?\b/i);
        if (m) {
            info.season = toInt(m[1], null);
            info.episode = toInt(m[2], null);
        }
    }
    if (info.episode == null) {
        m =
            t.match(/\bSeason\s*(\d{1,2})\s*(?:Episode|Ep\.?|E)\s*(\d{1,4})(?:v\d)?\b/i) ||
            t.match(/\bSeason\s*(\d{1,2})\s*[-–—:]\s*(\d{1,4})(?:v\d)?\b/i);
        if (m) {
            info.season = toInt(m[1], null);
            info.episode = toInt(m[2], null);
        }
    }
    if (info.episode == null) {
        m = t.match(/\b(?:Episode|Ep\.?|E)\s*(\d{1,4})(?:v\d)?\b/i);
        if (m) info.episode = toInt(m[1], null);
    }
    if (info.episode == null) {
        m =
            t.match(/(?:^|[\s_])-[\s_]*(\d{1,4})(?:v\d)?(?=[\s_\]]|[\[\(\.]|$)/i) ||
            t.match(/[\[\(](\d{1,3})(?:v\d)?[\]\)]/) ||
            t.match(/(?:^|[\s_])(\d{1,3})(?:v\d)?(?=[\s_]*[\[\(])/);
        if (m) info.episode = toInt(m[1], null);
    }
    var abs = t.match(/\((\d{1,4})\)/);
    if (abs) info.absolute = toInt(abs[1], null);
    if (info.absolute != null && (info.absolute < 1 || info.absolute > 2000)) info.absolute = null;
    return info;
}

function matchesRequest(title, req) {
    if (isBatch(title)) return false;
    if (/\b(ova|oad|special|specials|recap|picture drama|chibi|junior high)\b/i.test(title)) return false;
    if (/\b(kanketsu|final chapter|final chapters)\b/i.test(title) || /完结篇|完結編|前篇|後篇/.test(title)) return false;
    if (!isRelevant(title, req.titles)) return false;

    var ep = episodeInfo(title);
    var hints = seasonHints(title);

    if (req.isMovie) return ep.episode == null || ep.episode === 1;

    if (ep.episode == null) return false;
    var epOk =
        ep.episode === req.episode ||
        (req.absoluteEpisode != null && ep.episode === req.absoluteEpisode) ||
        (ep.absolute != null &&
            (ep.absolute === req.episode ||
                (req.absoluteEpisode != null && ep.absolute === req.absoluteEpisode)));
    if (!epOk) return false;

    // "The Final Season" carries no number; map it to TMDB's last season.
    if (/\bfinal season\b/i.test(title) && req.lastSeason && req.season !== req.lastSeason) return false;

    if (ep.season != null) return ep.season === req.season;
    if (hints.length) return hints.indexOf(req.season) !== -1;
    return true;
}

function scoreOf(candidate, req) {
    var title = candidate.title;
    var ep = episodeInfo(title);
    var score = 0;
    if (ep.season != null && ep.season === req.season) score += 60;
    var quality = parseQuality(title);
    if (quality === "1080p") score += 30;
    else if (quality === "720p") score += 15;
    else if (quality === "480p") score += 5;
    if (/\b(dual[\s-]*audio|multi[\s-]*audio|multi[\s-]*subs?)\b/i.test(title)) score += 5;
    if (!isDub(title)) score += 10;
    score += Math.min(toInt(candidate.seeders, 0), 50) * 0.2;
    return score;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Races a promise against a timer so one dead host cannot stall the request. */
function withTimeout(promise, label) {
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

function parseNyaaRss(xml) {
    var out = [];
    var re = /<item>([\s\S]*?)<\/item>/gi;
    var m;
    while ((m = re.exec(String(xml)))) {
        var block = m[1];
        var title = tagText(block, "title");
        var hash = String(tagText(block, "nyaa:infoHash") || "").toLowerCase();
        if (!title || !/^[0-9a-f]{40}$/.test(hash)) continue;
        out.push({
            title: title,
            hash: hash,
            seeders: toInt(tagText(block, "nyaa:seeders"), 0),
            size: tagText(block, "nyaa:size"),
            source: "Nyaa"
        });
    }
    return out;
}

function parseAnimeTosho(html) {
    var out = [];
    var chunks = String(html).split('class="home_list_entry');
    for (var i = 1; i < chunks.length; i++) {
        var block = chunks[i];
        var titleM = block.match(/<div class="link">\s*<a[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleM) continue;
        var title = decodeEntities(stripTags(titleM[1])).trim();
        var sizeM = block.match(/<div class="size"[^>]*>([^<]*)<\/div>/i);
        var seedM = block.match(/title="Seeders:\s*(\d+)/i);
        var magnetM = block.match(/href="(magnet:\?[^"]+)"/i);
        if (!title || !magnetM) continue;
        var magnet = decodeEntities(magnetM[1]);
        var hashM = magnet.match(/urn:btih:([0-9a-fA-F]{40}|[a-zA-Z2-7]{32})/);
        if (!hashM) continue;
        var hash = hashM[1].length === 40 ? hashM[1].toLowerCase() : base32ToHex(hashM[1]);
        if (!hash || !/^[0-9a-f]{40}$/.test(hash)) continue;
        out.push({
            title: title,
            hash: hash,
            seeders: seedM ? toInt(seedM[1], 0) : 0,
            size: sizeM ? decodeEntities(sizeM[1]).trim() : null,
            source: "AnimeTosho"
        });
    }
    return out;
}

async function nyaaSearch(query) {
    var url =
        NYAA_URL +
        "?page=rss&q=" +
        encodeURIComponent(query) +
        "&c=1_2&f=0&s=seeders&o=desc";
    var res = await withTimeout(
        fetch(url, {
            headers: {
                "User-Agent": UA,
                Accept: "application/rss+xml, application/xml, text/xml, */*"
            }
        }),
        "Nyaa"
    );
    if (!res.ok) throw new Error("Nyaa HTTP " + res.status);
    var xml = await res.text();
    if (isCloudflareBlock(xml)) throw new Error("Nyaa blocked by Cloudflare");
    return parseNyaaRss(xml);
}

async function animetoshoSearch(query) {
    var url =
        ANIMETOSHO_URL + "?q=" + encodeURIComponent(query) + "&type=torrent&order=seeders";
    var res = await withTimeout(
        fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } }),
        "AnimeTosho"
    );
    if (!res.ok) throw new Error("AnimeTosho HTTP " + res.status);
    return parseAnimeTosho(await res.text());
}

/** One source/query pair. A failure returns [] so the other sources still
 *  contribute instead of aborting the lookup. */
async function searchSource(search, label, query) {
    try {
        var found = await search(query);
        console.log("[AnimeTorrents] " + label + " '" + query + "' -> " + found.length);
        return found;
    } catch (e) {
        console.error("[AnimeTorrents] " + label + " '" + query + "' failed: " + (e && e.message));
        return [];
    }
}

// ---------------------------------------------------------------------------
// Query building / results
// ---------------------------------------------------------------------------

/** Romaji first: Nyaa release names use it. */
function queryTitles(info) {
    var out = [];
    function add(value) {
        if (!value || !isAscii(value)) return;
        var t = String(value).trim();
        if (!t || out.indexOf(t) !== -1) return;
        out.push(t);
    }
    var jp = (info.jpTitles || []).slice().sort(function (a, b) {
        return tokenList(a).length - tokenList(b).length;
    });
    for (var i = 0; i < jp.length; i++) add(jp[i]);
    for (var j = 0; j < info.titles.length; j++) add(info.titles[j]);
    return out.slice(0, 2);
}

function buildQueries(titles, req, year) {
    var qs = [];
    function push(q) {
        q = String(q || "").replace(/\s+/g, " ").trim();
        if (q && qs.indexOf(q) === -1) qs.push(q);
    }
    if (!titles.length) return qs;
    if (req.isMovie) {
        for (var i = 0; i < titles.length; i++) {
            if (year) push(titles[i] + " " + year);
            push(titles[i]);
        }
    } else {
        push(titles[0] + " S" + pad2(req.season) + "E" + pad2(req.episode));
        push(titles[0] + " " + pad2(req.episode));
        if (req.absoluteEpisode != null && req.absoluteEpisode !== req.episode) {
            push(titles[0] + " " + req.absoluteEpisode);
        }
        if (titles[1]) push(titles[1] + " " + pad2(req.episode));
    }
    return qs.slice(0, 3);
}

function addCandidates(list, out, seen) {
    for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || !/^[0-9a-f]{40}$/.test(c.hash) || seen[c.hash]) continue;
        seen[c.hash] = true;
        out.push(c);
    }
}

function matchCandidates(candidates, req) {
    var matched = [];
    for (var i = 0; i < candidates.length; i++) {
        if (!matchesRequest(candidates[i].title, req)) continue;
        candidates[i].score = scoreOf(candidates[i], req);
        matched.push(candidates[i]);
    }
    return matched;
}

function makeResult(candidate) {
    var quality = parseQuality(candidate.title) || "";
    var language = isDub(candidate.title) ? "Dub" : "Sub";
    var title = candidate.title.replace(/\.(mkv|mp4|avi|m4v)$/i, "").trim();
    if (title.length > 140) title = title.slice(0, 137) + "...";
    return {
        title: title,
        name: "AnimeTorrents" + (quality ? " · " + quality : "") + " · " + language,
        url: "magnet:?xt=urn:btih:" + candidate.hash,
        infoHash: candidate.hash,
        quality: quality || null,
        size: candidate.size || null,
        language: language,
        provider: "AnimeTorrents",
        type: "torrent",
        seeders: toInt(candidate.seeders, 0),
        peers: null,
        subtitles: []
    };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function getStreams(tmdbId, mediaType, season, episode, absoluteEpisode) {
    var results = [];
    var isMovie = String(mediaType || "").toLowerCase() === "movie";

    try {
        var info = await resolveContent(tmdbId, mediaType);
        var titles = queryTitles(info);
        if (!titles.length) {
            console.error("[AnimeTorrents] no searchable title for " + mediaType + " " + tmdbId);
            return results;
        }

        var req = {
            titles: info.titles,
            isMovie: isMovie,
            // Anime ids are per-season, so the real season number is in the
            // title ("... Season 2") while the app always reports season 1.
            season: info.seasonHint || toInt(season, 1),
            episode: toInt(episode, 1),
            absoluteEpisode: absoluteEpisode == null ? null : toInt(absoluteEpisode, null),
            lastSeason: info.lastSeason
        };
        var queries = buildQueries(titles, req, info.year);

        var candidates = [];
        var seen = {};

        // AnimeTosho first: it mirrors Nyaa (plus TokyoTosho/AniDex/nekoBT) and
        // answers every time. Nyaa is only tried when AnimeTosho matched
        // nothing, because a blocked host never settles its fetch and the
        // QuickJS runtime keeps the evaluation alive while that async job is
        // outstanding -- querying Nyaa up front burned the full 60s plugin
        // budget even though AnimeTosho already had the release.
        async function querySource(search, label, count) {
            var jobs = [];
            for (var i = 0; i < Math.min(queries.length, count); i++) {
                jobs.push(searchSource(search, label, queries[i]));
            }
            var batches = await Promise.all(jobs);
            for (var b = 0; b < batches.length; b++) {
                addCandidates(batches[b], candidates, seen);
            }
        }

        await querySource(animetoshoSearch, "animetosho", 2);
        var matched = matchCandidates(candidates, req);

        if (!matched.length) {
            await querySource(nyaaSearch, "nyaa", queries.length);
            matched = matchCandidates(candidates, req);
        }

        matched.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return toInt(b.seeders, 0) - toInt(a.seeders, 0);
        });

        for (var n = 0; n < matched.length && results.length < MAX_RESULTS; n++) {
            results.push(makeResult(matched[n]));
        }
        console.log(
            "[AnimeTorrents] S" + req.season + "E" + req.episode +
            " matched " + matched.length + ", returning " + results.length
        );
    } catch (e) {
        console.error("[AnimeTorrents] getStreams error:", (e && e.message) || e, (e && e.stack) || "");
    }

    return results;
}

module.exports = { getStreams };