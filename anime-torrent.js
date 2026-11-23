// =============================================================================
// Anime Torrents - NuvioTV plugin (QuickJS / PluginRuntime)
//
// Pipeline:
//   content id (Kitsu / IMDb / TMDB) -> titles (+ season count)
//     -> AnimeTosho HTML search
//     -> strict release matcher (episode token, season guard, batch rejection)
//     -> one magnet per release -> Nuvio's P2P engine or a debrid provider
//
// AnimeTosho mirrors Nyaa (plus TokyoTosho/AniDex/nekoBT) and stays reachable
// on networks that block Nyaa, so it is the only source. Magnets arrive in
// base32 and are decoded to the 40-hex btih Nuvio expects.
//
// Only single-episode releases are returned. Nuvio's plugin bridge hardcodes
// fileIdx = null, so a batch cannot be resolved to the requested episode.
// =============================================================================

var TMDB_BASE = "https://api.themoviedb.org/3";
var KITSU_BASE = "https://kitsu.io/api/edge";
// AnimeTosho.org was frozen on 2026-05-09 (no releases added since) and is
// end-of-life, so it returns nothing for anything that aired after that date.
// The community successor animetosho.xyz uses the same markup and carries
// current releases. Query both in parallel: the successor for fresh episodes,
// the original for back-catalogue depth and as a mirror if either host stalls.
var ANIMETOSHO_HOSTS = ["animetosho.xyz", "animetosho.org"];
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
    // Episode counts per season, for absolute-episode numbering. Same payload, no
    // extra request.
    var seasons = [];
    if (Array.isArray(data.seasons)) {
        for (var s = 0; s < data.seasons.length; s++) {
            var row = data.seasons[s] || {};
            seasons.push({
                n: toInt(row.season_number, 0),
                c: toInt(row.episode_count, 0)
            });
        }
    }

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

    return { kind: kind, titles: titles, jpTitles: jpTitles, year: year || null, lastSeason: lastSeason || null, seasons: seasons };
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

/** HDR markers, kept as whole tokens so "HDRip"/"DVDRip" do not match. */
function isHdr(title) {
    return /\b(?:hdr10\+?|hdr|hlg|dolby[\s.]?vision|dovi)\b/i.test(String(title));
}

// Release groups ranked first, most wanted first. The user's priority here is
// SUBTITLE STYLING: SubsPlease (and its predecessor HorribleSubs) do their own
// typesetting with embedded fonts, while groups like Erai-raws just mux the raw
// Crunchyroll subs, which looks plain. Styling lives inside the MKV, so the only
// lever the plugin has is which release it offers — hence a tier of groups known
// for typeset subs. Ranking is tiered (not just scored) because these groups name
// episodes "- 08" rather than "S01E08" and so miss the +60 exact-season bonus.
var TRUSTED_GROUPS = [
    "SubsPlease",
    "HorribleSubs",
    "AnoZu",
    "EMBER",
    "Judas",
    "DKB",
    "Yameii",
    "Anime Time"
];

/** Release group: the leading [Tag], else a trailing -Tag. */
function groupOf(title) {
    var t = String(title);
    var m = t.match(/^\s*\[([^\]]{1,30})\]/);
    if (m) return m[1].trim();
    m = t.match(/-([A-Za-z0-9]{2,20})(?:\.[a-z0-9]{2,4})?\s*$/);
    return m ? m[1] : "";
}

/** Sort tier: a trusted group's list index, else one past the list. */
function trustedRank(title) {
    var g = groupOf(title).toLowerCase();
    if (g) {
        for (var i = 0; i < TRUSTED_GROUPS.length; i++) {
            if (g === TRUSTED_GROUPS[i].toLowerCase()) return i;
        }
    }
    return TRUSTED_GROUPS.length;
}

/** Trusted groups first (SubsPlease highest), then score, then seeders. */
function rankReleases(list) {
    list.sort(function (a, b) {
        var tier = trustedRank(a.title) - trustedRank(b.title);
        if (tier) return tier;
        if (b.score !== a.score) return b.score - a.score;
        return toInt(b.seeders, 0) - toInt(a.seeders, 0);
    });
    return list;
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

/** Absolute episode from TMDB's per-season episode counts. Fansub groups number
 *  long-running anime continuously ("[HorribleSubs] Black Clover - 58"), while
 *  TMDB/the app report a season-local number (S2E7), so the query needs both. */
function absoluteEpisodeFrom(seasons, season, episode) {
    if (!seasons || !seasons.length || !(season > 1)) return null;
    var sum = 0;
    for (var i = 0; i < seasons.length; i++) {
        var s = seasons[i] || {};
        if (s.n >= 1 && s.n < season) sum += toInt(s.c, 0);
    }
    return sum > 0 ? sum + episode : null;
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
        m =
            t.match(/\bSeason\s*(\d{1,2})\s*(?:Episode|Ep\.?|E)\s*(\d{1,4})(?!\.\d)(?:v\d)?\b/i) ||
            t.match(/\bSeason\s*(\d{1,2})\s*[-–—:]\s*(\d{1,4})(?!\.\d)(?:v\d)?\b/i);
        if (m) {
            info.season = toInt(m[1], null);
            info.episode = toInt(m[2], null);
        }
    }
    if (info.episode == null) {
        m = t.match(/\b(?:Episode|Ep\.?|E)\s*(\d{1,4})(?!\.\d)(?:v\d)?\b/i);
        if (m) info.episode = toInt(m[1], null);
    }
    if (info.episode == null) {
        // A bare season marker ("Season 01 (S01)") is a season pack, not an
        // episode: strip it first so its number is not read as episode 1
        // (found live on "[SubsMix] Bocchi the Rock! - Season 01 (S01) V4").
        var rest = t
            .replace(/\bSeason\s*\d{1,2}\b/gi, " ")
            .replace(/\(\s*S\d{1,2}\s*\)/gi, " ")
            .replace(/\bS\d{1,2}\b/gi, " ");
        m =
            // "(?!\.\d)" keeps "11.5" (an OVA/recap) from parsing as episode 11.
            rest.match(/(?:^|[\s_])-[\s_]*(\d{1,4})(?!\.\d)(?:v\d)?(?=[\s_\]]|[\[\(\.]|$)/i) ||
            rest.match(/[\[\(](\d{1,3})(?!\.\d)(?:v\d)?[\]\)]/) ||
            rest.match(/(?:^|[\s_])(\d{1,3})(?!\.\d)(?:v\d)?(?=[\s_]*[\[\(])/);
        if (m) info.episode = toInt(m[1], null);
    }
    var abs = t.match(/\((\d{1,4})\)/);
    if (abs) info.absolute = toInt(abs[1], null);
    if (info.absolute != null && (info.absolute < 1 || info.absolute > 2000)) info.absolute = null;
    return info;
}

function matchesRequest(title, req) {
    if (isBatch(title)) return false;
    // "OADs"/"OVAs" are plural in many release names, so the noun needs its own
    // boundary: \boad\b does not match "OADs", which let specials through.
    if (/\b(?:ova|oad)s?\b/i.test(title)) return false;
    if (/\b(?:special|specials|recap|picture drama|chibi|junior high)\b/i.test(title)) return false;
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

    // "The Final Season" carries no number. Map it to TMDB's last season, and
    // otherwise reject it: Kitsu-resolved anime never report a last season, so
    // a season-1 request was accepting "The Final Season Part 2 - E01".
    if (/\bfinal season\b/i.test(title)) {
        var asksFinal = false;
        for (var f = 0; f < req.titles.length; f++) {
            if (/\bfinal season\b/i.test(req.titles[f])) { asksFinal = true; break; }
        }
        if (!asksFinal && !(req.lastSeason != null && req.season === req.lastSeason)) return false;
    }

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
    // A dub is a different audio track, not a subtitle. Push it below every sub
    // so a high-seeder dub cannot outrank the English-subbed releases.
    if (isDub(title)) score -= 40;
    else score += 10;
    // A release with no seeders has nobody to hand over the torrent metadata, so
    // Nuvio's P2P engine sits on "loading" (peers=0) until the user gives up --
    // observed as a 27s stall on a dead 1080p while a live 720p sat below it.
    // Liveness therefore outranks quality: a live release always sorts first.
    var seeders = toInt(candidate.seeders, 0);
    if (seeders <= 0) score -= 100;
    else score += Math.min(seeders, 50) * 0.2;
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

/** Short wait, used to back off when the index rate-limits a burst. */
function delay(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

async function animetoshoSearch(host, query) {
    var url =
        "https://" + host + "/search?q=" + encodeURIComponent(query) + "&type=torrent&order=seeders";
    for (var attempt = 0; ; attempt++) {
        var res = await withTimeout(
            fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } }),
            "AnimeTosho " + host
        );
        // A burst of queries gets 429s, which would silently empty the list, so
        // one retry after a pause keeps the lookup whole. Nuvio allows 60s.
        if (res.status === 429 && attempt < 1) {
            await delay(1500);
            continue;
        }
        if (!res.ok) throw new Error("AnimeTosho " + host + " HTTP " + res.status);
        return parseAnimeTosho(await res.text());
    }
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

/** Brackets/punctuation an index search can't tokenize, for the group query. */
function cleanTitle(t) {
    return String(t).replace(/[\[\](){}]/g, " ").replace(/\s+/g, " ").trim();
}

// Each query is one request per host, sent in waves, so this bounds the fan-out.
var QUERY_LIMIT = 12;

// Only the tier's leaders are queried by name. Each named query is one request
// per host, and the index answers 429 when too many hit it at once — the generic
// searches must fit in that budget too, and they already surface the lower
// groups (DKB, Judas, Yameii) when they rank.
var QUERY_GROUPS = TRUSTED_GROUPS.slice(0, 4);

function buildQueries(titles, req, year) {
    if (!titles.length) return [];
    var seen = {};
    function add(list, q) {
        q = String(q || "").replace(/\s+/g, " ").trim();
        if (!q || seen[q]) return;
        seen[q] = true;
        list.push(q);
    }
    // A generic "<title> <episode>" search returns a capped, relevance-ranked
    // page that omits the trusted groups' per-episode singles (seen live:
    // Jujutsu Kaisen 75 rows with zero SubsPlease; Re:Zero with zero
    // HorribleSubs). Querying each group by name surfaces them directly.
    var groups = [];
    // Groups that number long-running anime continuously (HorribleSubs, SubsPlease)
    // use the absolute episode, not the season-local one, so their query uses it.
    var groupEp =
        req.absoluteEpisode != null && req.absoluteEpisode !== req.episode
            ? String(req.absoluteEpisode)
            : pad2(req.episode);
    for (var g = 0; g < QUERY_GROUPS.length; g++) {
        add(
            groups,
            QUERY_GROUPS[g] +
                " " +
                cleanTitle(titles[0]) +
                (req.isMovie ? (year ? " " + year : "") : " " + groupEp)
        );
    }
    var generic = [];
    if (req.isMovie) {
        for (var i = 0; i < titles.length; i++) {
            if (year) add(generic, titles[i] + " " + year);
            add(generic, titles[i]);
        }
    } else {
        add(generic, titles[0] + " S" + pad2(req.season) + "E" + pad2(req.episode));
        add(generic, titles[0] + " " + pad2(req.episode));
        if (req.absoluteEpisode != null && req.absoluteEpisode !== req.episode) {
            add(generic, titles[0] + " " + req.absoluteEpisode);
        }
        if (titles[1]) add(generic, titles[1] + " " + pad2(req.episode));
    }
    // The generic searches are the only source for everything outside the
    // trusted tier (Hyouka: the group queries matched nothing, and when they
    // filled the cap the generic ones were dropped, emptying the list), so the
    // groups are the ones trimmed.
    var room = Math.max(2, QUERY_LIMIT - generic.length);
    return groups.slice(0, room).concat(generic);
}

function addCandidates(list, out, seen) {
    for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || !/^[0-9a-f]{40}$/.test(c.hash) || seen[c.hash]) continue;
        seen[c.hash] = true;
        out.push(c);
    }
}

/**
 * Drops releases with no seeders when a live alternative exists. A dead torrent
 * never fetches metadata, so the player sits on "fetching torrent metadata"
 * until the engine gives up.
 */
function dropDeadReleases(list) {
    var live = [];
    for (var i = 0; i < list.length; i++) {
        if (toInt(list[i].seeders, 0) > 0) live.push(list[i]);
    }
    return live.length ? live : list;
}

/** A group that numbered this show continuously (an absolute-episode release of
 *  it is present) must not also offer its bare "- 07" for a season-2 episode 7 —
 *  that file is season 1. Groups that restart numbering each season have no
 *  absolute release here, so their "- 07" is kept.
 *  shortcut: inferred per group from the candidates; a very long season whose
 *  local episode equals the absolute one could tip it the wrong way. Revisit if a
 *  show is reported as missing an episode. */
function dropSeasonAmbiguity(list, req) {
    if (req.absoluteEpisode == null || req.absoluteEpisode === req.episode) return list;
    var usesAbsolute = {};
    var i;
    for (i = 0; i < list.length; i++) {
        var e = episodeInfo(list[i].title);
        if (e.episode === req.absoluteEpisode || e.absolute === req.absoluteEpisode) {
            usesAbsolute[groupOf(list[i].title)] = true;
        }
    }
    var out = [];
    for (i = 0; i < list.length; i++) {
        var t = episodeInfo(list[i].title);
        var bare = t.season == null && t.absolute == null && t.episode === req.episode;
        if (bare && usesAbsolute[groupOf(list[i].title)]) continue;
        out.push(list[i]);
    }
    return out;
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

/** The user wants 1080p only (including 1080p HDR). Falls back to the full set
 *  when a show has no 1080p release, so the list is never emptied. */
function prefer1080p(list) {
    var hd = [];
    for (var i = 0; i < list.length; i++) {
        if (parseQuality(list[i].title) === "1080p") hd.push(list[i]);
    }
    return hd.length ? hd : list;
}

function makeResult(candidate, rank) {
    var quality = parseQuality(candidate.title) || "";
    var hdr = isHdr(candidate.title);
    var language = isDub(candidate.title) ? "Dub" : "Sub";
    var title = candidate.title.replace(/\.(mkv|mp4|avi|m4v)$/i, "").trim();
    if (title.length > 140) title = title.slice(0, 137) + "...";
    var seeders = toInt(candidate.seeders, 0);
    return {
        // Nuvio's plugin bridge renders `name` as the bold row label (subtitle
        // comes from quality/size/language; `title` is never shown) and then
        // re-sorts every plugin row with `List<StreamItem>.sortedForGroupedDisplay()`,
        // which is a plain case-insensitive alphabetical sort on this label. Our
        // ranking therefore has to be baked into the label's sort order, or Nuvio
        // throws it away (a seeder-prefixed label sorted "30↑" before "852↑").
        // The zero-padded rank prefix keeps our order intact through that sort.
        name: pad2(rank) + " · " + (seeders ? seeders + "↑ · " : "") + title,
        title: title,
        url: "magnet:?xt=urn:btih:" + candidate.hash,
        infoHash: candidate.hash,
        quality: quality ? quality + (hdr ? " HDR" : "") : null,
        size: candidate.size || null,
        language: language,
        provider: "AnimeTorrents",
        type: "torrent",
        seeders: seeders,
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
        // TMDB reports season-local episodes, but most fansub groups number
        // long-running anime continuously: Black Clover S2E7 is released as
        // "[HorribleSubs] Black Clover - 58". Derive that absolute number from
        // the season episode counts so both numbering schemes are searched.
        if (req.absoluteEpisode == null && !req.isMovie) {
            req.absoluteEpisode = absoluteEpisodeFrom(info.seasons, req.season, req.episode);
        }
        var queries = buildQueries(titles, req, info.year);

        var candidates = [];
        var seen = {};

        // A blocked or dead host never settles its fetch and the QuickJS runtime
        // keeps the evaluation alive while that async job is outstanding, so every
        // request is bounded by withTimeout. The two hosts mirror the same index,
        // so a slow one cannot stall the lookup or hide the results the other
        // already produced.
        // The index answers 429 when every query hits it at once (seen live with
        // 10 parallel requests, which silently emptied the result list), so each
        // host is queried in small waves. Nuvio allows 60s per plugin call.
        var CONCURRENCY = 3;
        async function querySource(search, label) {
            for (var i = 0; i < queries.length; i += CONCURRENCY) {
                var jobs = [];
                for (var j = i; j < Math.min(queries.length, i + CONCURRENCY); j++) {
                    jobs.push(searchSource(search, label, queries[j]));
                }
                var batches = await Promise.all(jobs);
                for (var b = 0; b < batches.length; b++) {
                    addCandidates(batches[b], candidates, seen);
                }
            }
        }

        await Promise.all(
            ANIMETOSHO_HOSTS.map(function (host) {
                return querySource(function (query) {
                    return animetoshoSearch(host, query);
                }, "animetosho:" + host);
            })
        );
        var matched = matchCandidates(candidates, req);
        matched = dropSeasonAmbiguity(matched, req);
        matched = prefer1080p(matched);
        matched = rankReleases(matched);
        matched = dropDeadReleases(matched);

        for (var n = 0; n < matched.length && results.length < MAX_RESULTS; n++) {
            results.push(makeResult(matched[n], n + 1));
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