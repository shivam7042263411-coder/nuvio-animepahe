// =============================================================================
// Anime Torrents - NuvioTV plugin (QuickJS / PluginRuntime)
//
// Pipeline:
//   TMDB (titles + season count)
//     -> Nyaa RSS search (Anime / English-translated, seeders first)
//     -> strict release matcher (episode token, season guard, batch rejection)
//     -> one magnet per release -> Nuvio's P2P engine or a debrid provider
//
// AnimeTosho's HTML search is the fallback when Nyaa returns nothing (or is
// unreachable). It carries the same releases under a base32 info hash, which
// is decoded to the 40-hex form Nuvio expects.
//
// Only single-episode releases are returned. Nuvio's plugin bridge hardcodes
// fileIdx = null, so a batch cannot be resolved to the requested episode.
// =============================================================================

var TMDB_BASE = "https://api.themoviedb.org/3";
var NYAA_URL = "https://nyaa.si/";
var ANIMETOSHO_URL = "https://animetosho.org/search";
var MAX_RESULTS = 10;

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
    var res = await fetch(url, { headers: { Accept: "application/json" } });
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
    var res = await fetch(url, {
        headers: {
            "User-Agent": UA,
            Accept: "application/rss+xml, application/xml, text/xml, */*"
        }
    });
    if (!res.ok) throw new Error("Nyaa HTTP " + res.status);
    var xml = await res.text();
    if (isCloudflareBlock(xml)) throw new Error("Nyaa blocked by Cloudflare");
    return parseNyaaRss(xml);
}

async function animetoshoSearch(query) {
    var url =
        ANIMETOSHO_URL + "?q=" + encodeURIComponent(query) + "&type=torrent&order=seeders";
    var res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
    if (!res.ok) throw new Error("AnimeTosho HTTP " + res.status);
    return parseAnimeTosho(await res.text());
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
        var info = await getTmdbInfo(tmdbId, mediaType);
        var titles = queryTitles(info);
        if (!titles.length) {
            console.error("[AnimeTorrents] TMDB returned no searchable title for " + mediaType + " " + tmdbId);
            return results;
        }

        var req = {
            titles: info.titles,
            isMovie: isMovie,
            season: toInt(season, 1),
            episode: toInt(episode, 1),
            absoluteEpisode: absoluteEpisode == null ? null : toInt(absoluteEpisode, null),
            lastSeason: info.lastSeason
        };
        var queries = buildQueries(titles, req, info.year);

        var candidates = [];
        var seen = {};
        for (var i = 0; i < queries.length; i++) {
            try {
                var found = await nyaaSearch(queries[i]);
                console.log("[AnimeTorrents] nyaa '" + queries[i] + "' -> " + found.length);
                addCandidates(found, candidates, seen);
            } catch (e) {
                console.error("[AnimeTorrents] nyaa '" + queries[i] + "' failed: " + (e && e.message));
            }
        }

        // Fallback only when Nyaa produced no matching release: AnimeTosho
        // mirrors the same torrents and costs one extra request.
        var matched = matchCandidates(candidates, req);
        if (!matched.length) {
            for (var j = 0; j < Math.min(queries.length, 2); j++) {
                try {
                    var extra = await animetoshoSearch(queries[j]);
                    console.log("[AnimeTorrents] animetosho '" + queries[j] + "' -> " + extra.length);
                    addCandidates(extra, candidates, seen);
                } catch (e) {
                    console.error("[AnimeTorrents] animetosho '" + queries[j] + "' failed: " + (e && e.message));
                }
            }
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