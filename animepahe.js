// =============================================================================
// AnimePahe - NuvioTV plugin (QuickJS / PluginRuntime)
//
// Pipeline:
//   TMDB (title + season layout)
//     -> AnimePahe search
//     -> season/part aware episode selection
//     -> release list (/api?m=release) -> episode session
//     -> play page (/play/<animeSession>/<episodeSession>)
//     -> kwik.cx /d/ download -> direct .mp4 (seeks/resumes); /e/ HLS is the
//        fallback because the m3u8 cannot seek or resume
//
// AnimePahe is reached directly first (that is how the site is meant to be
// used and it works from residential/mobile networks). The configured
// Cloudflare-bypass proxy is only used as a fallback for animepahe URLs,
// because the proxy rejects every host that does not contain "animepahe".
// kwik.cx and uwucdn.top are always fetched directly.
// =============================================================================

var PROXY_URL = "https://animepaheproxy.phisheranimepahe.workers.dev/?url=";
var BASE_URL = "https://animepahe.pw";
var TMDB_BASE = "https://api.themoviedb.org/3";

// Per-run cache of AnimePahe responses (see apGet). Reset by getStreams.
var responseCache = null;

var UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

var AP_HEADERS = {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: BASE_URL + "/"
};

// Headers the kwik/uwucdn player requires. Without Referer kwik.cx the CDN
// answers 403 from Cloudflare.
var PLAYBACK_HEADERS = {
    "User-Agent": UA,
    Referer: "https://kwik.cx/",
    Origin: "https://kwik.cx",
    Accept: "*/*"
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function attr(tag, name) {
    var re = new RegExp(name + '\\s*=\\s*"([^"]*)"', "i");
    var m = tag.match(re);
    if (m) return m[1];
    re = new RegExp(name + "\\s*=\\s*'([^']*)'", "i");
    m = tag.match(re);
    return m ? m[1] : null;
}

function decodeEntities(value) {
    return String(value == null ? "" : value)
        .replace(/&amp;/g, "&")
        .replace(/&#0*38;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;/g, "'");
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

/** Normalized title as a list of tokens. */
function tokenList(value) {
    var n = normTitle(value);
    return n ? n.split(" ") : [];
}

/** Number of leading tokens two titles share ("Show 2nd Season" vs "Show" -> 1). */
function leadingOverlap(a, b) {
    var at = tokenList(a);
    var bt = tokenList(b);
    var i = 0;
    while (i < at.length && i < bt.length && at[i] === bt[i]) i++;
    return i;
}

/** Keep a candidate only when it starts with one of the known titles. This
 *  drops AnimePahe's fuzzy-search noise: a query for "Re:ZERO ..." also returns
 *  "Zipang", "Mangirl!" and the "Re:ZERO ~Starting Break Time~" specials. */
function isRelevant(title, variants) {
    var tt = tokenList(title);
    if (!tt.length) return false;
    for (var i = 0; i < variants.length; i++) {
        var vt = tokenList(variants[i]);
        if (!vt.length) continue;
        if (leadingOverlap(title, variants[i]) >= Math.min(4, vt.length, tt.length)) return true;
    }
    return false;
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** Episode numbers in ascending order, deduped (AnimePahe lists several
 *  releases per episode number). */
function uniqueAscendingEpisodes(list) {
    var byNumber = Object.create(null);
    var numbers = [];
    for (var i = 0; i < list.length; i++) {
        var num = parseFloat(list[i].episode);
        if (isNaN(num) || byNumber[num]) continue;
        byNumber[num] = list[i];
        numbers.push(num);
    }
    numbers.sort(function (a, b) { return a - b; });
    return { numbers: numbers, byNumber: byNumber };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function remember(url, text) {
    if (responseCache) responseCache[url] = text;
    return text;
}

/**
 * Fetch an AnimePahe URL. Direct first, proxy as fallback. Responses are cached
 * for the duration of one getStreams run: episode resolution probes the same
 * release packets repeatedly, and AnimePahe rate-limits hard.
 */
async function apGet(url, extraHeaders) {
    if (responseCache && responseCache[url] != null) return responseCache[url];

    var headers = Object.assign({}, AP_HEADERS, extraHeaders || {});

    var directStatus = 0;
    for (var attempt = 1; attempt <= 2; attempt++) {
        try {
            var res = await fetch(url, { headers: headers });
            var text = await res.text();
            directStatus = res.status;
            if (res.ok && !isCloudflareBlock(text)) return remember(url, text);
            if (res.status === 429 && attempt < 2) {
                console.error("[AnimePahe] rate limited (429), retrying once: " + url);
                await sleep(3000);
                continue;
            }
        } catch (e) {
            console.error("[AnimePahe] direct request failed:", e && e.message);
        }
        break;
    }

    var proxied = PROXY_URL + encodeURIComponent(url);
    try {
        var res2 = await fetch(proxied, { headers: headers });
        var text2 = await res2.text();
        if (res2.ok && !isCloudflareBlock(text2)) return remember(url, text2);
        throw new Error("proxy HTTP " + res2.status);
    } catch (e2) {
        throw new Error(
            "AnimePahe request failed (direct " +
                directStatus +
                ", proxy " +
                ((e2 && e2.message) || "error") +
                "): " +
                url
        );
    }
}

async function apJson(url, extraHeaders) {
    return JSON.parse(await apGet(url, extraHeaders));
}

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
    if (!res.ok) throw new Error("TMDB HTTP " + res.status);
    return await res.json();
}

// ---------------------------------------------------------------------------
// Packed-player unpacker (dean.edwards packer, base-a alphabet)
// ---------------------------------------------------------------------------

/** Read a JS string literal starting at `start`; returns raw (still escaped) value. */
function readJsString(src, start) {
    var quote = src.charAt(start);
    if (quote !== "'" && quote !== '"') return null;
    var i = start + 1;
    while (i < src.length) {
        var ch = src.charAt(i);
        if (ch === "\\") {
            i += 2;
            continue;
        }
        if (ch === quote) return { value: src.substring(start + 1, i), end: i + 1 };
        i++;
    }
    return null;
}

/** Decode the escape sequences of a JS string literal. */
function unescapeJsString(str) {
    var out = "";
    for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        if (ch !== "\\") {
            out += ch;
            continue;
        }
        var next = str.charAt(++i);
        if (next === "n") out += "\n";
        else if (next === "r") out += "\r";
        else if (next === "t") out += "\t";
        else if (next === "b") out += "\b";
        else if (next === "f") out += "\f";
        else if (next === "v") out += "\v";
        else if (next === "0") out += "\0";
        else if (next === "x") {
            out += String.fromCharCode(parseInt(str.substring(i + 1, i + 3), 16));
            i += 2;
        } else if (next === "u") {
            out += String.fromCharCode(parseInt(str.substring(i + 1, i + 5), 16));
            i += 4;
        } else if (next === "\n") {
            // line continuation
        } else {
            out += next;
        }
    }
    return out;
}

/** Packer alphabet: 0-9, a-z, then A-Z for base 62. */
function packerBase(num, base) {
    var prefix = num < base ? "" : packerBase(Math.floor(num / base), base);
    var digit = num % base;
    return prefix + (digit > 35 ? String.fromCharCode(digit + 29) : digit.toString(36));
}

/**
 * Unpack one `eval(function(p,a,c,k,e,d){...}('...',a,c,'...'.split('|'),0,{}))`
 * block into readable JS.
 */
function unpackPackedBlock(block) {
    var marker = block.indexOf("}(");
    if (marker === -1) return null;
    var i = marker + 2;

    var pLit = readJsString(block, i);
    if (!pLit) return null;
    i = pLit.end;

    var nums = block.substring(i).match(/^\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*/);
    if (!nums) return null;
    var base = parseInt(nums[1], 10);
    var count = parseInt(nums[2], 10);
    if (!base || !count) return null;
    i += nums[0].length;

    var kLit = readJsString(block, i);
    if (!kLit) return null;

    var payload = unescapeJsString(pLit.value);
    var words = unescapeJsString(kLit.value).split("|");

    var dict = {};
    for (var n = 0; n < count; n++) {
        var token = packerBase(n, base);
        dict[token] = words[n] || token;
    }

    return payload.replace(/\b\w+\b/g, function (word) {
        return dict[word] !== undefined ? dict[word] : word;
    });
}

/** Collect every packed player block in an HTML page. */
function extractPackedBlocks(html) {
    var blocks = [];
    var markers = [".split('|'),0,{}))", '.split("|"),0,{}))'];
    var pos = 0;

    while (true) {
        var start = html.indexOf("eval(function", pos);
        if (start === -1) break;

        var end = -1;
        var markerLength = 0;
        for (var i = 0; i < markers.length; i++) {
            var candidate = html.indexOf(markers[i], start);
            if (candidate !== -1 && (end === -1 || candidate < end)) {
                end = candidate;
                markerLength = markers[i].length;
            }
        }
        if (end === -1) break;

        blocks.push(html.substring(start, end + markerLength));
        pos = end + markerLength;
    }
    return blocks;
}

/** Extract the HLS playlist from a kwik player page. */
function findM3u8(html) {
    var blocks = extractPackedBlocks(html);

    for (var i = 0; i < blocks.length; i++) {
        var code = unpackPackedBlock(blocks[i]);
        if (!code) continue;

        var m = code.match(/https?:\/\/[^\s'"\\<>]+?\.m3u8[^\s'"\\<>]*/);
        if (m) return m[0];

        var rel = code.match(/\/\/[^\s'"\\<>]+?\.m3u8[^\s'"\\<>]*/);
        if (rel) return "https:" + rel[0];
    }

    // Last resort: the playlist may be present in the raw page.
    var raw = html.match(/https?:\/\/[^\s'"\\<>]+?\.m3u8[^\s'"\\<>]*/);
    return raw ? raw[0] : null;
}

/** Fetch a kwik page. kwik rate-limits hard: back-to-back episodes routinely
 *  answer 429, so wait it out instead of dropping the episode. */
async function kwikGet(url, headers) {
    var res = null;
    for (var attempt = 1; attempt <= 3; attempt++) {
        res = await fetch(url, { headers: headers });
        if (res.status !== 429) break;
        console.error("[AnimePahe] kwik 429 (attempt " + attempt + "/3) " + url);
        if (attempt < 3) await sleep(2000 + attempt * 1000);
    }
    if (!res.ok) {
        console.error("[AnimePahe] kwik HTTP " + res.status + " " + url);
        return null;
    }
    var html = await res.text();
    if (isCloudflareBlock(html)) {
        console.error("[AnimePahe] kwik blocked by Cloudflare: " + url);
        return null;
    }
    return html;
}

function kwikPageHeaders() {
    return Object.assign({}, AP_HEADERS, { Accept: "*/*", Referer: BASE_URL + "/" });
}

/** Resolve a kwik.cx embed page to a playable m3u8 + required headers. */
async function resolveKwik(kwikUrl) {
    var html = await kwikGet(kwikUrl, kwikPageHeaders());
    if (!html) return null;

    var m3u8 = findM3u8(html);
    if (!m3u8) {
        console.error("[AnimePahe] no m3u8 in kwik page: " + kwikUrl);
        return null;
    }
    return { url: m3u8, headers: Object.assign({}, PLAYBACK_HEADERS), type: "m3u8" };
}

/** The kwik "download" page for the same file an /e/ embed URL points at. */
function kwikDownloadUrl(embedUrl) {
    return String(embedUrl).replace("/e/", "/d/");
}

/** The CSRF token kwik's download form posts back. */
function findKwikToken(html) {
    var inputs = html.match(/<input\b[^>]*>/gi) || [];
    for (var i = 0; i < inputs.length; i++) {
        if (!/name\s*=\s*["']?_token["']?/i.test(inputs[i])) continue;
        var value = attr(inputs[i], "value");
        if (value) return decodeEntities(value);
    }
    return null;
}

/** Resolve a kwik embed URL to a direct MP4. Unlike the HLS playlist this is a
 *  plain progressive file, so the player can seek, resume and buffer normally.
 *  kwik's /d/ page carries a _token the download form POSTs back for a
 *  {"url": "..."} answer. */
async function resolveKwikDownload(embedUrl) {
    var dlUrl = kwikDownloadUrl(embedUrl);
    var html = await kwikGet(dlUrl, kwikPageHeaders());
    if (!html) return null;

    var token = findKwikToken(html);
    if (!token) {
        console.error("[AnimePahe] no download token on " + dlUrl);
        return null;
    }

    try {
        var res = await fetch(dlUrl, {
            method: "POST",
            headers: {
                "User-Agent": UA,
                Accept: "application/json, text/plain, */*",
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest",
                Referer: dlUrl,
                Origin: "https://kwik.cx"
            },
            body: "_token=" + encodeURIComponent(token)
        });
        if (!res.ok) {
            console.error("[AnimePahe] kwik download HTTP " + res.status + " " + dlUrl);
            return null;
        }
        var body = await res.text();
        var mp4 = null;
        try {
            var json = JSON.parse(body);
            mp4 = json && json.url;
        } catch (e) {
            var m = body.match(/https?:\/\/[^\s'"]+\.mp4[^\s'"]*/);
            mp4 = m ? m[0] : null;
        }
        if (!mp4) {
            console.error("[AnimePahe] no mp4 in download response for " + dlUrl);
            return null;
        }
        return { url: mp4, headers: Object.assign({}, PLAYBACK_HEADERS), type: "mp4" };
    } catch (e) {
        console.error("[AnimePahe] kwik download failed: " + (e && e.message));
        return null;
    }
}

// ---------------------------------------------------------------------------
// AnimePahe parsing
// ---------------------------------------------------------------------------

async function searchAnime(query) {
    var data = await apJson(BASE_URL + "/api?m=search&l=15&q=" + encodeURIComponent(query));
    return (data && data.data) || [];
}

function parsePlayButtons(html) {
    var menu = html.indexOf('id="resolutionMenu"');
    var scope = menu === -1 ? html : html.substring(menu);
    var buttons = [];
    var re = /<button\b[^>]*>/gi;
    var m;

    while ((m = re.exec(scope))) {
        var tag = m[0];
        var src = attr(tag, "data-src") || attr(tag, "data-url");
        if (!src || src.indexOf("kwik") === -1) continue;

        var quality = attr(tag, "data-resolution");
        if (!quality) {
            var qm = String(tag).match(/(\d{3,4})p/i);
            quality = qm ? qm[1] : "";
        }

        buttons.push({
            url: decodeEntities(src),
            quality: quality ? String(quality) + "p" : "",
            audio: attr(tag, "data-audio") || "",
            fansub: attr(tag, "data-fansub") || ""
        });
    }
    return buttons;
}

function isSubAudio(audio) {
    var a = String(audio || "").toLowerCase();
    return a === "" || a === "jpn" || a === "ja" || a === "japanese" || a === "sub";
}

/** One 1080p sub link per episode: resolving every button is what gets us
 *  kwik 429s, and the other qualities are never watched. */
function pickPlayButtons(buttons) {
    var tiers = [
        function (b) { return b.quality === "1080p" && isSubAudio(b.audio); },
        function (b) { return b.quality === "1080p"; },
        function (b) { return isSubAudio(b.audio); },
        function () { return true; }
    ];
    for (var t = 0; t < tiers.length; t++) {
        var out = buttons.filter(tiers[t]);
        if (out.length) return out.slice(0, 1);
    }
    return [];
}

function audioToLanguage(audio) {
    var a = String(audio || "").toLowerCase();
    if (a === "eng" || a === "en" || a === "english" || a === "dub") return "Dub";
    if (a === "jpn" || a === "ja" || a === "japanese" || a === "sub") return "Sub";
    return "Sub";
}

/** Release lookup that never throws: a rate-limited packet becomes "no match"
 *  so one failed probe cannot abort the whole episode resolution. */
async function findEpisode(animeSession, episodeNumber, allowPositional) {
    try {
        return await findEpisodeInner(animeSession, episodeNumber, allowPositional);
    } catch (e) {
        console.error("[AnimePahe] release lookup failed: " + (e && e.message));
        return null;
    }
}

async function findEpisodeInner(animeSession, episodeNumber, allowPositional) {
    var base =
        BASE_URL +
        "/api?m=release&id=" +
        encodeURIComponent(animeSession) +
        "&sort=episode_asc&page=";

    var first = await apJson(base + "1");
    if (!first || !Array.isArray(first.data)) return null;

    var perPage = parseInt(first.per_page, 10) || 30;
    var lastPage = parseInt(first.last_page, 10) || 1;
    var computed = Math.min(Math.max(Math.ceil(episodeNumber / perPage), 1), lastPage);
    console.log("[AnimePahe] release list pages=" + lastPage + " perPage=" + perPage + " target=" + episodeNumber);

    // Scan only the packet the target should be in, plus the first (split
    // seasons keep franchise numbering, so the target can sit on page 1 even
    // when per-page math points elsewhere). Probes used to walk six pages each,
    // which is what tripped AnimePahe's rate limit.
    var pages = computed === 1 ? [1] : [computed, 1];

    var collected = [];
    for (var i = 0; i < pages.length; i++) {
        var list;
        if (pages[i] === 1) {
            list = first.data;
        } else {
            var page = await apJson(base + pages[i]);
            list = (page && page.data) || [];
        }

        for (var k = 0; k < list.length; k++) {
            var ep = list[k];
            collected.push(ep);
            var num = parseFloat(ep.episode);
            var num2 = parseFloat(ep.episode2);
            if (num === episodeNumber) return ep;
            if (!isNaN(num2) && num2 > 0 && episodeNumber >= num && episodeNumber <= num2) return ep;
        }
    }

    // AnimePahe keeps counting across split seasons (e.g. JJK S2 lists 25-47),
    // so the requested relative episode has to be matched by position.
    // Probe callers opt out so a list that merely restarts at 1 is not matched.
    if (allowPositional === false) return null;
    // shortcut: positional match only for lists up to 12 pages (~360 eps),
    // upgrade if a longer split entry ever needs it.
    if (lastPage > 12) {
        console.error("[AnimePahe] episode " + episodeNumber + " not found (" + lastPage + " pages, positional match skipped)");
        return null;
    }
    for (var q = 1; q <= lastPage; q++) {
        if (pages.indexOf(q) !== -1) continue;
        var extra = q === 1 ? first.data : (((await apJson(base + q)) || {}).data || []);
        for (var e = 0; e < extra.length; e++) collected.push(extra[e]);
    }

    var unique = uniqueAscendingEpisodes(collected);
    if (episodeNumber >= 1 && episodeNumber <= unique.numbers.length) {
        var matched = unique.numbers[episodeNumber - 1];
        console.error(
            "[AnimePahe] episode " + episodeNumber + " matched by position -> animepahe episode " + matched +
            " (listed " + unique.numbers[0] + "-" + unique.numbers[unique.numbers.length - 1] + ")"
        );
        return unique.byNumber[matched];
    }
    return null;
}

// ---------------------------------------------------------------------------
// Season / part mapping
// ---------------------------------------------------------------------------

function ordinal(n) {
    var s = ["th", "st", "nd", "rd"];
    var v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function episodesOf(entry) {
    var n = parseInt(entry && entry.episodes, 10);
    return isNaN(n) ? 0 : n;
}

/** The season an entry title claims: "2nd Season", "Season 2", "Part 2". */
function seasonMarker(title) {
    var n = normTitle(title);
    var m = n.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/);
    if (m) return parseInt(m[1], 10);
    m = n.match(/\bseason\s+(\d+)\b/);
    if (m) return parseInt(m[1], 10);
    m = n.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:part|cour)\b/);
    if (m) return parseInt(m[1], 10);
    return null;
}

/** True for OVAs, movies and specials, which the app's season episode counts
 *  exclude and which therefore must not shift the cumulative offset. */
function isSpecialEntry(title) {
    var n = normTitle(title);
    if (!n) return false;
    return /\b(?:ova|oad|specials?|recap|movie|pilot|picture drama)\b/.test(n) || /\bshort\b/.test(n);
}

/** Order entries that aired in the same year ("Part 2" after "Part 1"). */
function partRank(title) {
    var n = normTitle(title);
    var m = n.match(/\b(?:part|cour)\s*(\d+)\b/);
    if (m) return parseInt(m[1], 10);
    if (n.indexOf("final season") !== -1 || n.indexOf("final chapter") !== -1) return 90;
    return 1;
}

async function resolveEpisode(tmdb, season, episode, absoluteEpisode) {
    var seasonNumber = season == null ? 1 : parseInt(season, 10);
    if (isNaN(seasonNumber) || seasonNumber < 1) seasonNumber = 1;
    var targetEpisode = episode == null ? 1 : parseInt(episode, 10);
    if (isNaN(targetEpisode) || targetEpisode < 1) targetEpisode = 1;

    var baseTitle = tmdb.titles[0];
    if (!baseTitle) return null;

    // TMDB splits seasons differently from the app, so the app's own absolute
    // episode (where available) is the trustworthy number.
    var previousEpisodes = 0;
    for (var j = 0; j < tmdb.seasons.length; j++) {
        var sn = parseInt(tmdb.seasons[j].season_number, 10);
        if (sn >= 1 && sn < seasonNumber) {
            previousEpisodes += parseInt(tmdb.seasons[j].episode_count, 10) || 0;
        }
    }
    var hasAppAbsolute = absoluteEpisode != null && parseInt(absoluteEpisode, 10) > 0;
    var absolute = hasAppAbsolute ? parseInt(absoluteEpisode, 10) : previousEpisodes + targetEpisode;

    // Collect candidates from the English title and the romaji title.
    var entries = [];
    var seen = {};
    function merge(list) {
        for (var x = 0; x < list.length; x++) {
            if (list[x].session && !seen[list[x].session]) {
                seen[list[x].session] = true;
                entries.push(list[x]);
            }
        }
    }

    // Titles a candidate may start with: the English title, the site's romaji
    // (JP) titles, and any long alternative title. Short alternative titles
    // ("Re:Zero") are too generic to validate against.
    var jpTitles = (tmdb.jpTitles || []).filter(function (t) {
        return isAscii(t) && tokenList(t).length >= 2;
    });
    var variants = [baseTitle];
    for (var vj = 0; vj < jpTitles.length; vj++) {
        if (variants.indexOf(jpTitles[vj]) === -1) variants.push(jpTitles[vj]);
    }
    for (var v = 1; v < tmdb.titles.length; v++) {
        var altTitle = tmdb.titles[v];
        if (isAscii(altTitle) && tokenList(altTitle).length >= 4 && variants.indexOf(altTitle) === -1) {
            variants.push(altTitle);
        }
    }

    // AnimePahe rate-limits hard, so search at most twice: the English title,
    // then the shortest romaji title (that is the one the site lists). Falls
    // back to a season-suffixed query only when TMDB gave no romaji.
    var queries = [baseTitle];
    for (var qj = 0; qj < jpTitles.length && qj < 1; qj++) {
        if (normTitle(jpTitles[qj]) !== normTitle(baseTitle)) queries.push(jpTitles[qj]);
    }
    if (queries.length === 1 && seasonNumber > 1) {
        queries.push(baseTitle + " " + ordinal(seasonNumber) + " Season");
    }

    for (var q = 0; q < queries.length; q++) {
        try {
            merge(await searchAnime(queries[q]));
        } catch (e) {
            console.error("[AnimePahe] search failed for '" + queries[q] + "': " + (e && e.message));
        }
    }

    // Drop candidates that do not start with a known title. Only skip the
    // filter when there was no usable alternative title, so a TMDB failure
    // cannot turn a working show into no streams.
    if (variants.length > 1) {
        var relevant = [];
        for (var fr = 0; fr < entries.length; fr++) {
            if (isRelevant(entries[fr].title, variants)) relevant.push(entries[fr]);
        }
        if (relevant.length !== entries.length) {
            console.log("[AnimePahe] title filter kept " + relevant.length + "/" + entries.length);
        }
        entries = relevant;
    }

    // Earliest release of the franchise first, then by season/part marker.
    entries.sort(function (a, b) {
        var ya = parseInt(a.year, 10); if (isNaN(ya)) ya = 9999;
        var yb = parseInt(b.year, 10); if (isNaN(yb)) yb = 9999;
        if (ya !== yb) return ya - yb;
        var ma = seasonMarker(a.title); if (ma == null) ma = 1;
        var mb = seasonMarker(b.title); if (mb == null) mb = 1;
        if (ma !== mb) return ma - mb;
        var pa = partRank(a.title), pb = partRank(b.title);
        if (pa !== pb) return pa - pb;
        return normTitle(a.title).length - normTitle(b.title).length;
    });

    console.log(
        "[AnimePahe] S" + seasonNumber + "E" + targetEpisode + " abs=" + absolute +
        " (" + (hasAppAbsolute ? "app" : "tmdb") + ") candidates=" + entries.length +
        " [" + entries.slice(0, 12).map(function (e) {
            return e.title + "(" + (e.episodes == null ? "?" : e.episodes) + "," + (e.year || "?") + ")";
        }).join(" | ") + "]"
    );

    function planFor(entry, ep, how) {
        console.log("[AnimePahe] " + how + " -> '" + entry.title + "' ep " + ep);
        return {
            animeSession: entry.session,
            episode: ep,
            animeTitle: entry.title,
            season: seasonNumber,
            requestedEpisode: targetEpisode
        };
    }

    // 1. Entries that name this season, including split cours
    //    ("2nd Season", "2nd Season Part 2"), mapped by position across them.
    if (seasonNumber > 1) {
        var seasonEntries = [];
        for (var s = 0; s < entries.length; s++) {
            if (seasonMarker(entries[s].title) === seasonNumber) seasonEntries.push(entries[s]);
        }
        seasonEntries.sort(function (a, b) {
            var pa = partRank(a.title), pb = partRank(b.title);
            if (pa !== pb) return pa - pb;
            var ya = parseInt(a.year, 10); if (isNaN(ya)) ya = 9999;
            var yb = parseInt(b.year, 10); if (isNaN(yb)) yb = 9999;
            return ya - yb;
        });

        var seasonOffset = 0;
        for (var s2 = 0; s2 < seasonEntries.length; s2++) {
            var seasonEps = episodesOf(seasonEntries[s2]);
            if (seasonEps === 0) break;
            if (targetEpisode <= seasonOffset + seasonEps) {
                return planFor(seasonEntries[s2], targetEpisode - seasonOffset, "season part");
            }
            seasonOffset += seasonEps;
        }

        // A named season whose release list already uses franchise numbering.
        for (var s3 = 0; s3 < seasonEntries.length; s3++) {
            if (!(await findEpisode(seasonEntries[s3].session, absolute, false))) continue;
            return planFor(seasonEntries[s3], absolute, "season absolute");
        }

        if (seasonEntries.length === 1) {
            return planFor(seasonEntries[0], targetEpisode, "season entry");
        }
    }

    // 2. The absolute episode, for franchises that keep numbering across
    //    seasons. Only an entry whose own episode count is smaller than the
    //    absolute can hold it (the list must be franchise-numbered); an entry
    //    that merely has that many episodes matches by position in step 3, and
    //    probing it would wrongly steal the request (Kaguya S2 -> S3 ep 13).
    var probeLimit = Math.min(entries.length, 6);
    for (var a = 0; a < probeLimit; a++) {
        if (episodesOf(entries[a]) >= absolute) continue;
        if (!(await findEpisode(entries[a].session, absolute, false))) continue;
        return planFor(entries[a], absolute, "absolute match");
    }

    // 3. Cumulative position, for franchises that restart numbering each
    //    season. OVAs/movies/specials are skipped: the app's season episode
    //    counts do not include them, so counting them shifts every later season.
    var offset = 0;
    for (var c = 0; c < entries.length; c++) {
        if (isSpecialEntry(entries[c].title)) continue;
        var count = episodesOf(entries[c]);
        if (count === 0) break;
        if (absolute > offset && absolute <= offset + count) {
            return planFor(entries[c], absolute - offset, "cumulative match");
        }
        offset += count;
    }

    // 4. A single entry holding the whole show, matched on the relative episode.
    if (entries.length && seasonNumber === 1) {
        var only = episodesOf(entries[0]);
        if (only === 0 || only >= targetEpisode) {
            return planFor(entries[0], targetEpisode, "single entry");
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function getStreams(tmdbId, mediaType, season, episode, absoluteEpisode) {
    var results = [];
    var isMovie = String(mediaType || "").toLowerCase() === "movie";
    responseCache = {};

    try {
        var tmdb = await getTmdbInfo(tmdbId, mediaType);
        if (!tmdb.titles.length) {
            console.error("[AnimePahe] TMDB returned no title for " + mediaType + " " + tmdbId);
            return results;
        }

        var plan = await resolveEpisode(tmdb, isMovie ? 1 : season, isMovie ? 1 : episode, isMovie ? null : absoluteEpisode);
        console.log(
            "[AnimePahe] plan=" + (plan ? "'" + plan.animeTitle + "' ep " + plan.episode : "null") +
            " for S" + season + "E" + episode
        );
        if (!plan) {
            console.error(
                "[AnimePahe] no matching AnimePahe entry for '" +
                    tmdb.titles[0] +
                    "' S" +
                    season +
                    "E" +
                    episode
            );
            return results;
        }

        var ep = await findEpisode(plan.animeSession, plan.episode);
        if (!ep || !ep.session) {
            console.error(
                "[AnimePahe] episode " + plan.episode + " not found for " + plan.animeTitle
            );
            return results;
        }

        var playUrl = BASE_URL + "/play/" + plan.animeSession + "/" + ep.session;
        var playHtml = await apGet(playUrl);
        var buttons = parsePlayButtons(playHtml);

        if (!buttons.length) {
            console.error("[AnimePahe] no kwik buttons on " + playUrl);
            return results;
        }

        var label = isMovie
            ? plan.animeTitle
            : plan.animeTitle + " - S" + plan.season + "E" + plan.requestedEpisode;

        // One request per episode: six parallel kwik resolves is what triggers
        // the 429s, and only 1080p sub is ever watched.
        var chosen = pickPlayButtons(buttons);
        console.log(
            "[AnimePahe] buttons=" + buttons.length + " chosen=" + chosen.length +
            (chosen.length ? " (" + chosen[0].quality + "/" + (chosen[0].audio || "?") + ")" : "")
        );

        var seenUrls = {};

        for (var i = 0; i < chosen.length; i++) {
            if (seenUrls[chosen[i].url]) continue;
            seenUrls[chosen[i].url] = true;

            try {
                // Prefer the direct MP4 download: the HLS playlist cannot seek
                // or resume in the player. HLS is the fallback when kwik has no
                // download for this release (or the download form changed).
                var stream = await resolveKwikDownload(chosen[i].url);
                if (!stream) stream = await resolveKwik(chosen[i].url);
                if (!stream) continue;
                console.log("[AnimePahe] source=" + stream.type + " " + stream.url);

                var language = audioToLanguage(chosen[i].audio);
                var quality = chosen[i].quality || "";
                var nameParts = ["AnimePahe"];
                if (quality) nameParts.push(quality);
                nameParts.push(language);
                if (chosen[i].fansub) nameParts.push(chosen[i].fansub);

                results.push({
                    title: label,
                    name: nameParts.join(" · "),
                    url: stream.url,
                    quality: quality || null,
                    language: language,
                    provider: "AnimePahe",
                    type: stream.type,
                    headers: stream.headers,
                    subtitles: [],
                    size: null,
                    infoHash: null,
                    seeders: null,
                    peers: null
                });
            } catch (e) {
                console.error("[AnimePahe] kwik resolve failed:", e && e.message);
            }
        }
    } catch (e) {
        console.error("[AnimePahe] getStreams error:", (e && e.message) || e, (e && e.stack) || "");
    }

    // Sub first, then higher quality first.
    results.sort(function (a, b) {
        if (a.language !== b.language) return a.language === "Sub" ? -1 : 1;
        return (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0);
    });

    console.log("[AnimePahe] returning " + results.length + " streams");
    return results;
}

async function getTmdbInfo(tmdbId, mediaType) {
    var kind = String(mediaType || "").toLowerCase() === "movie" ? "movie" : "tv";
    var data = await tmdbJson("/" + kind + "/" + encodeURIComponent(tmdbId));

    var titles = [];
    function addTitle(value) {
        if (value && titles.indexOf(value) === -1) titles.push(value);
    }
    addTitle(data.name || data.title);
    addTitle(data.original_name || data.original_title);

    // AnimePahe lists English/romaji titles. TMDB's alternative titles carry a
    // region; the JP ones are the romaji the site actually uses ("Re:Zero kara
    // Hajimeru Isekai Seikatsu"), so they find entries the English title
    // misses. Non-fatal: the English title still works.
    var jpTitles = [];
    try {
        var alt = await tmdbJson("/" + kind + "/" + encodeURIComponent(tmdbId) + "/alternative_titles");
        var rows = (alt && alt.results) || [];
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i] || {};
            if (!isAscii(row.title)) continue;
            addTitle(row.title);
            if (String(row.iso_3166_1 || "").toUpperCase() === "JP" && jpTitles.indexOf(row.title) === -1) {
                jpTitles.push(row.title);
            }
        }
    } catch (e) {
        console.error("[AnimePahe] alternative titles unavailable: " + (e && e.message));
    }
    // Shortest first: the base romaji ("Shingeki no Kyojin") beats the
    // season-specific ones ("Shingeki no Kyojin The Final Season").
    jpTitles.sort(function (a, b) { return tokenList(a).length - tokenList(b).length; });

    return {
        kind: kind,
        titles: titles,
        jpTitles: jpTitles,
        seasons: Array.isArray(data.seasons) ? data.seasons : []
    };
}

module.exports = { getStreams };
