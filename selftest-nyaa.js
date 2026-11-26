// Offline self-check for the standalone Nyaa torrent plugin: RSS parsing,
// release-to-show and release-to-episode matching, batch/zero-seeder rejection,
// the 1080p+ rule, the exact result shape Nuvio's plugin bridge accepts
// (non-blank magnet + 40-hex infoHash), and the Android TV host (no timers).
//
// It runs the Nyaa scraper with AniList and SeaDex unreachable on purpose, to
// prove the provider is independent of them.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "nyaa-torrent.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));

const H = {
    n1080: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    n2160: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    n720: "cccccccccccccccccccccccccccccccccccccccc",
    nzero: "dddddddddddddddddddddddddddddddddddddddd",
    nbatch: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    nwrongep: "ffffffffffffffffffffffffffffffffffffffff",
    nwrongshow: "4545454545454545454545454545454545454545",
    n1080b: "5656565656565656565656565656565656565656",
    nseason2: "6767676767676767676767676767676767676767",
    nmovie: "abababababababababababababababababababab",
    nmovie720: "bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc",
    nbadhash: "not-a-hash",
};

// --- fixtures --------------------------------------------------------------

const TMDB_SHOW = {
    name: "Frieren: Beyond Journey's End",
    original_name: "葬送のフリーレン",
    first_air_date: "2023-09-29",
    number_of_seasons: 2,
    seasons: [
        { season_number: 1, episode_count: 28 },
        { season_number: 2, episode_count: 10 },
    ],
};
const TMDB_SHOW_ALT = { results: [{ title: "Sousou no Frieren", iso_3166_1: "JP" }] };
const TMDB_MOVIE = {
    title: "A Silent Voice",
    original_title: "聲の形",
    release_date: "2016-09-17",
    seasons: [],
};
const TMDB_MOVIE_ALT = { titles: [{ title: "Koe no Katachi", iso_3166_1: "JP" }] };
const TMDB_FIND = { tv_results: [{ id: 209867, name: "Frieren" }], movie_results: [] };

function esc(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function nyaaItem(row) {
    return (
        "<item>" +
        "<title>" + esc(row.title) + "</title>" +
        "<nyaa:infoHash>" + row.hash + "</nyaa:infoHash>" +
        "<nyaa:seeders>" + (row.seeders || 0) + "</nyaa:seeders>" +
        "<nyaa:trusted>" + (row.trusted ? "Yes" : "No") + "</nyaa:trusted>" +
        "<nyaa:size>" + (row.size || "1.4 GiB") + "</nyaa:size>" +
        "</item>"
    );
}
function rss(rows) {
    return (
        '<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>' +
        rows.map(nyaaItem).join("") +
        "</channel></rss>"
    );
}

const NYAA_FRIEREN = rss([
    { title: "[SubsPlease] Sousou no Frieren - 01 (1080p) [ABCD1234]", hash: H.n1080, seeders: 120, size: "1.4 GiB", trusted: true },
    { title: "[Feibanyama] Frieren Beyond Journeys End S01E01 [2160p HEVC]", hash: H.n2160, seeders: 30, size: "1.8 GiB" },
    { title: "[Erai-raws] Sousou no Frieren - 01 [1080p][HEVC][Multiple Subtitle]", hash: H.n1080b, seeders: 60, size: "1.3 GiB" },
    { title: "[Group] Sousou no Frieren - 01 (720p)", hash: H.n720, seeders: 40 },
    { title: "[Group] Sousou no Frieren - 01 (1080p) [DEAD]", hash: H.nzero, seeders: 0 },
    { title: "[SubsPlease] Sousou no Frieren (01-28) (1080p) [Batch]", hash: H.nbatch, seeders: 200 },
    { title: "[Group] Sousou no Frieren - 02 (1080p)", hash: H.nwrongep, seeders: 50 },
    { title: "[Group] Some Other Show - 01 (1080p)", hash: H.nwrongshow, seeders: 50 },
    { title: "[Judas] Sousou no Frieren (Frieren Beyond Journey`s End) - S02E09 [1080p]", hash: H.nseason2, seeders: 80 },
    { title: "[X] Sousou no Frieren - 01 (1080p)", hash: H.nbadhash, seeders: 500 },
]);
const NYAA_MOVIE = rss([
    { title: "[Judas] Koe no Katachi (A Silent Voice) [BD 1080p][Dual-Audio]", hash: H.nmovie, seeders: 207, size: "2.2 GiB" },
    { title: "[Group] Koe no Katachi (720p)", hash: H.nmovie720, seeders: 10 },
]);
const NYAA = {
    "sousou no frieren s01e01": NYAA_FRIEREN,
    "sousou no frieren - 01": NYAA_FRIEREN,
    "koe no katachi": NYAA_MOVIE,
    "a silent voice": NYAA_MOVIE,
};
const EMPTY_RSS = '<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel></channel></rss>';

// --- sandbox ---------------------------------------------------------------

function json(body) {
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => JSON.parse(JSON.stringify(body)), headers: { get: () => null } };
}
function raw(text) {
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text), headers: { get: () => null } };
}
function nyaaQueryOf(url) {
    const m = String(url).match(/[?&]q=([^&]+)/);
    return decodeURIComponent(m ? m[1] : "").replace(/\+/g, " ").toLowerCase();
}

// AniList and SeaDex are deliberately unreachable: the provider must not need
// them, and must never even call them.
const forbidden = [];
function makeSandbox(overrides) {
    const sb = {
        console: { log() {}, error() {} },
        Promise, Object, Array, String, Number, Math, JSON, RegExp, isNaN, parseInt,
        encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, TMDB_API_KEY: "test",
        module: { exports: {} },
        fetch: async (url, options) => {
            const u = String(url);
            if (u.indexOf("api.themoviedb.org") !== -1) {
                if (u.indexOf("/alternative_titles") !== -1) {
                    return json(u.indexOf("/movie/") !== -1 ? TMDB_MOVIE_ALT : TMDB_SHOW_ALT);
                }
                if (u.indexOf("/find/") !== -1) return json(TMDB_FIND);
                return json(u.indexOf("/movie/") !== -1 ? TMDB_MOVIE : TMDB_SHOW);
            }
            if (u.indexOf("nyaa.si") !== -1) return raw(NYAA[nyaaQueryOf(u)] || EMPTY_RSS);
            if (/anilist|seadex/i.test(u)) {
                forbidden.push(u);
                throw new Error("the Nyaa provider must not call " + u);
            }
            return json({});
        },
    };
    return Object.assign(sb, overrides || {});
}

const sandbox = makeSandbox();
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const failures = [];
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures.push(`${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

// --- manifest --------------------------------------------------------------
const nyaa = manifest.scrapers.filter((s) => s.id === "nyaa-torrent")[0];
check("manifest: Nyaa scraper registered", !!nyaa, true);
check("manifest: Nyaa filename", nyaa && nyaa.filename, "nyaa-torrent.js");
check("manifest: Nyaa supports tv and movie", nyaa && nyaa.supportedTypes.slice().sort(), ["movie", "tv"]);
check("manifest: Nyaa enabled", nyaa && nyaa.enabled, true);
check("manifest: Nyaa has no platform allow-list", nyaa && nyaa.supportedPlatforms, undefined);
check("manifest: SeaDex scraper still present", manifest.scrapers.filter((s) => s.id === "anime-torrent").length, 1);

// --- RSS parsing -----------------------------------------------------------
const parsed = sandbox.parseNyaaRss(NYAA_FRIEREN);
check("parse: items found", parsed.length, 9); // bad-hash row dropped
check("parse: every hash is 40-hex", parsed.filter((p) => !/^[0-9a-f]{40}$/.test(p.hash)).length, 0);
check("parse: seeders numeric", parsed.filter((p) => typeof p.seeders !== "number").length, 0);
check("parse: trusted flag read", parsed.filter((p) => p.trusted).length, 1);
check("parse: group extracted", parsed[0].group, "SubsPlease");
check("parse: junk gives no items", sandbox.parseNyaaRss("").length, 0);

// --- batch / title / episode guard -----------------------------------------
check("batch: (01-28) [Batch]", sandbox.isBatchName("[SubsPlease] Sousou no Frieren (01-28) (1080p) [Batch]"), true);
check("batch: S01E01-E04", sandbox.isBatchName("Frieren S01E01-E04 1080p NF WEB-DL x264-VARYG"), true);
check("batch: S01E01-E12", sandbox.isBatchName("Jujutsu Kaisen S02E01-E07.1080p AMZN WEB-DL"), true);
check("batch: S01-S03", sandbox.isBatchName("Show S01-S03 (1080p)"), true);
check("batch: single episode is not a batch", sandbox.isBatchName("[ToonsHub] Frieren S02E10 1080p CR WEB-DL"), false);
check("batch: x265-10bit is not a batch", sandbox.isBatchName("[LYS1TH3A] A Silent Voice (BD 1080p HEVC x265 10-bit Opus)"), false);

check("title: apostrophe variant matches", sandbox.releaseMatchesTitle("[ToonsHub] Frieren Beyond Journeys End S02E10", ["Frieren: Beyond Journey's End", "Sousou no Frieren"]), true);
check("title: romaji matches", sandbox.releaseMatchesTitle("[Erai-raws] Sousou no Frieren 2nd Season - 10", ["Frieren: Beyond Journey's End", "Sousou no Frieren"]), true);
check("title: unrelated release rejected", sandbox.releaseMatchesTitle("Some Other Show S02E10 1080p", ["Sousou no Frieren"]), false);

const REQ = { isMovie: false, season: 1, episode: 1, absoluteEpisode: 1, derivedSeason: 1 };
check("episode: S01E01", sandbox.nameMatchesEpisode("Show S01E01 [1080p].mkv", REQ), true);
check("episode: wrong episode", sandbox.nameMatchesEpisode("Show S01E02 [1080p].mkv", REQ), false);
check("episode: other season rejected", sandbox.nameMatchesEpisode("Show S02E01 [1080p].mkv", REQ), false);
check("episode: OVA rejected", sandbox.nameMatchesEpisode("Show OVA - 01 [1080p].mkv", REQ), false);
check(
    "episode: season-2 label rejected for a season-1 request",
    sandbox.nameMatchesEpisode("Show 2nd Season - 01.mkv", { ...REQ, derivedSeason: 2 }),
    false
);

check("magnet: starts with btih", /^magnet:\?xt=urn:btih:[0-9a-f]{40}&dn=/.test(sandbox.magnetFor({ hash: H.n1080, name: "x" })), true);
check("magnet: carries trackers", /tr=udp%3A/.test(sandbox.magnetFor({ hash: H.n1080, name: "x" })), true);

// --- end to end ------------------------------------------------------------
(async () => {
    // Frieren S1E1: two 1080p and one 2160p pass; the 720p, zero-seeder,
    // batch, wrong-episode, wrong-show and season-2 rows are dropped. The
    // bad-hash row never parsed.
    const rows = await sandbox.module.exports.getStreams(209867, "tv", 1, 1);
    const has = (h) => rows.some((r) => r.infoHash === h);
    check("e2e: three playable releases", rows.length, 3);
    check("e2e: every infoHash 40-hex", rows.filter((r) => !/^[0-9a-f]{40}$/.test(r.infoHash)).length, 0);
    check("e2e: no blank urls", rows.filter((r) => !r.url).length, 0);
    check("e2e: all rows are torrents from Nyaa", rows.every((r) => r.type === "torrent" && r.provider === "Nyaa"), true);
    check("e2e: every url is a magnet", rows.every((r) => /^magnet:\?xt=urn:btih:/.test(r.url)), true);
    check("e2e: 1080p row kept", has(H.n1080), true);
    check("e2e: second 1080p row kept", has(H.n1080b), true);
    check("e2e: 2160p row kept and labelled", (rows.find((r) => r.infoHash === H.n2160) || {}).quality, "2160p");
    check("e2e: 720p row dropped", has(H.n720), false);
    check("e2e: zero-seeder row dropped", has(H.nzero), false);
    check("e2e: batch row dropped", has(H.nbatch), false);
    check("e2e: wrong-episode row dropped", has(H.nwrongep), false);
    check("e2e: wrong-show row dropped", has(H.nwrongshow), false);
    check("e2e: another season's row dropped", has(H.nseason2), false);
    check("e2e: 2160p ranked above 1080p", rows.indexOf(rows.find((r) => r.infoHash === H.n2160)) < rows.indexOf(rows.find((r) => r.infoHash === H.n1080)), true);
    const nrow = rows.find((r) => r.infoHash === H.n1080);
    check("e2e: seeders exposed", nrow && nrow.seeders, 120);
    check("e2e: rank prefix keeps order through Nuvio's sort", rows.map((r) => r.name.slice(0, 2)), rows.map((_, i) => String(i + 1).padStart(2, "0")));
    const sorted = rows.map((r) => r.name).slice().sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    check("e2e: order survives alphabetical sort", sorted, rows.map((r) => r.name));

    // A season-2 request must not take a season-1 release.
    const s2 = await sandbox.module.exports.getStreams(209867, "tv", 2, 10);
    check("e2e: season 2 takes no season-1 row", s2.some((r) => r.infoHash === H.n1080), false);

    // Movies: no season/episode; the 1080p dual-audio row passes, 720p does not.
    const movie = await sandbox.module.exports.getStreams(129999, "movie");
    check("e2e movie: 1080p row kept", movie.some((r) => r.infoHash === H.nmovie), true);
    check("e2e movie: 720p row dropped", movie.some((r) => r.infoHash === H.nmovie720), false);
    check("e2e movie: dual audio labelled", (movie.find((r) => r.infoHash === H.nmovie) || {}).language.indexOf("Dual Audio"), 0);

    // IMDb id resolves through TMDB find first.
    const fromImdb = await sandbox.module.exports.getStreams("tt1234567", "tv", 1, 1);
    check("e2e: imdb id resolves", fromImdb.length, rows.length);

    // Android TV host: no setTimeout. The lookup must still work.
    const tv = makeSandbox();
    delete tv.setTimeout;
    delete tv.clearTimeout;
    vm.createContext(tv);
    vm.runInContext(source, tv);
    const tvRows = await tv.module.exports.getStreams(209867, "tv", 1, 1);
    check("tv (no setTimeout): still yields streams", tvRows.length, rows.length);

    // Nyaa RSS resets on the first try: the fetch retries and still works.
    let calls = 0;
    const flaky = makeSandbox({
        fetch: async (url, options) => {
            if (String(url).indexOf("nyaa.si") !== -1 && ++calls <= 3) throw new Error("connection reset");
            return sandbox.fetch(url, options);
        },
    });
    vm.createContext(flaky);
    vm.runInContext(source, flaky);
    const retried = await flaky.module.exports.getStreams(209867, "tv", 1, 1);
    check("e2e: RSS reset retried, streams still returned", retried.length, rows.length);

    // The provider is independent: nothing ever called AniList or SeaDex.
    check("e2e: AniList/SeaDex never contacted", forbidden.length, 0);

    // A wholly unreachable Nyaa returns nothing rather than throwing.
    const down = makeSandbox({
        fetch: async (url, options) => {
            if (String(url).indexOf("nyaa.si") !== -1) throw new Error("host unreachable");
            return sandbox.fetch(url, options);
        },
    });
    vm.createContext(down);
    vm.runInContext(source, down);
    const empty = await down.module.exports.getStreams(209867, "tv", 1, 1);
    check("e2e: Nyaa down returns empty, no throw", empty.length, 0);

    console.log(failures.length ? `\n${failures.join("\n")}\n\n${failures.length} FAILED` : "\nALL PASS");
    process.exit(failures.length ? 1 : 0);
})();
