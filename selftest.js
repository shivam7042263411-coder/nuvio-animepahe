// Offline self-check for the SeaDex torrent plugin: TMDB title/season lookup,
// AniList entry ranking (arc-titled seasons), SeaDex file matching, the
// 1080p+ rule, and the exact result shape Nuvio's plugin bridge accepts
// (non-blank url + 40-hex infoHash; batch index carried in torrent://hash/idx).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "anime-torrent.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));

const H = {
    batch: "1111111111111111111111111111111111111111",
    uhd: "2222222222222222222222222222222222222222",
    private: "<redacted>",
    sd: "3333333333333333333333333333333333333333",
    inferred: "4444444444444444444444444444444444444444",
    unbest: "5555555555555555555555555555555555555555",
    dvd: "6666666666666666666666666666666666666666",
    hdr: "7777777777777777777777777777777777777777",
    s2: "8888888888888888888888888888888888888888",
    movie: "9999999999999999999999999999999999999999",
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

function media(id, romaji, english, format, year, episodes) {
    return { id, idMal: null, format, seasonYear: year, episodes, title: { romaji, english, native: null }, synonyms: [] };
}

const ANILIST = {
    "sousou no frieren": [
        media(154587, "Sousou no Frieren", "Frieren: Beyond Journey's End", "TV", 2023, 28),
        media(182255, "Sousou no Frieren 2nd Season", "Frieren: Beyond Journey's End Season 2", "TV", 2026, 10),
        media(999001, "Koisuru Sousou no Frieren", "Frieren in Love", "ONA", 2025, 5),
    ],
    "koe no katachi": [media(20954, "Koe no Katachi", "A Silent Voice", "MOVIE", 2016, 1)],
};

function torrent(infoHash, group, isBest, files, extra) {
    return Object.assign(
        { infoHash, releaseGroup: group, isBest, dualAudio: false, tracker: "Nyaa", tags: [], files: files.map(([name, length]) => ({ name, length })) },
        extra || {}
    );
}

const SEADEX = {
    // Season 1 entry.
    154587: [
        torrent(H.batch, "PMR", true, [
            ["Frieren - S01E01 (BD Remux 1080p AVC FLAC) [Dual Audio].mkv", 7000000000],
            ["Frieren - S01E02 (BD Remux 1080p AVC FLAC) [Dual Audio].mkv", 7000000000],
        ]),
        torrent(H.uhd, "UHDGroup", true, [["Frieren - S01E01 (2160p).mkv", 12000000000]]),
        torrent(H.private, "Private", true, [["Frieren - S01E01 (BD 1080p).mkv", 7000000000]]),
        torrent(H.sd, "SDGroup", false, [["Frieren - S01E01 (720p).mkv", 400000000]]),
        torrent(H.inferred, "JySzE", true, [["Frieren - 01.mkv", 3000000000]]),
        torrent(H.unbest, "Nobody", false, [["Frieren - 01.mkv", 3000000000]]),
        torrent(H.dvd, "DVDGroup", true, [["Frieren - 01 [DVDrip].mkv", 300000000]]),
        torrent(H.hdr, "HDRGroup", false, [["Frieren - S01E01 (BD1080p HDR10).mkv", 4000000000]]),
    ],
    // Season 2 entry: its files must never leak into a season-1 request.
    182255: [
        torrent(H.s2, "S2Group", true, [
            ["Sousou no Frieren 2nd Season - 01 (BD 1080p).mkv", 3000000000],
            ["Sousou no Frieren 2nd Season - 02 (BD 1080p).mkv", 3000000000],
        ]),
    ],
    20954: [torrent(H.movie, "MovieGroup", true, [["A Silent Voice (BD 1080p).mkv", 9500000000]])],
};

// --- sandbox ---------------------------------------------------------------

function makeSandbox(overrides) {
    const sb = {
        console: { log() {}, error() {} },
        Promise, Object, Array, String, Number, Math, JSON, RegExp, isNaN, parseInt,
        encodeURIComponent, setTimeout, clearTimeout, TMDB_API_KEY: "test",
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
            if (u.indexOf("graphql.anilist.co") !== -1) {
                const body = JSON.parse(options.body);
                const key = String(body.variables.s).toLowerCase();
                return json({ data: { Page: { media: ANILIST[key] || [] } } });
            }
            if (u.indexOf("seadex.moe") !== -1) {
                const id = Number(decodeURIComponent(u).match(/alID=(\d+)/)[1]);
                return json({ items: [{ expand: { trs: SEADEX[id] || [] } }] });
            }
            return json({});
        },
    };
    return Object.assign(sb, overrides || {});
}

function json(body) {
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => JSON.parse(JSON.stringify(body)), headers: { get: () => null } };
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
check("manifest: two scrapers (SeaDex + NekoBT)", manifest.scrapers.length, 2);
check("manifest: SeaDex points at anime-torrent.js", manifest.scrapers[0].filename, "anime-torrent.js");
check("manifest: NekoBT points at nekobt-torrent.js", manifest.scrapers[1].filename, "nekobt-torrent.js");
check("manifest: distinct scraper ids", manifest.scrapers.map((s) => s.id).sort(), ["anime-torrent", "nekobt-torrent"]);
check(
    "manifest: every scraper supports tv and movie",
    manifest.scrapers.every((s) => s.supportedTypes.slice().sort().join() === "movie,tv"),
    true
);
check("manifest: no platform allow-list", manifest.scrapers.every((s) => s.supportedPlatforms === undefined), true);
check("manifest: not disabled on a platform", manifest.scrapers.every((s) => s.disabledPlatforms === undefined), true);

// --- resolution / SD -------------------------------------------------------
check("resolution: plain 1080p", sandbox.resolutionOf("Show S01E01 1080p").height, 1080);
check("resolution: glued BD1080p", sandbox.resolutionOf("Show - 01 [BD1080p HEVC].mkv").height, 1080);
check("resolution: 2160p", sandbox.resolutionOf("Show S01E01 2160p").height, 2160);
check("resolution: 4K", sandbox.resolutionOf("Show 4K HDR").height, 2160);
check("resolution: 1920x1080", sandbox.resolutionOf("Show 1920x1080").height, 1080);
check("resolution: 720p", sandbox.resolutionOf("Show 720p").height, 720);
check("resolution: silent name", sandbox.resolutionOf("Show - 01.mkv"), null);
check("SD: DVDrip is SD", sandbox.isSdName("Show - 01 [DVDrip].mkv"), true);
check("SD: BD release is not SD", sandbox.isSdName("Show - 01 [BD 1080p].mkv"), false);
check("HDR: HDR10 detected", sandbox.isHdr("Show S01E01 1080p HDR10"), true);
check("HDR: HDRip is not HDR", sandbox.isHdr("Show 1080p HDRip"), false);

// --- episode parsing -------------------------------------------------------
check("episode: SxxExx", sandbox.fileEpisode("Show S01E01 [1080p].mkv"), { season: 1, episode: 1, absolute: null });
check("episode: Season 3 - 01 keeps season", sandbox.fileEpisode("Show Season 3 - 01 [1080p].mkv"), { season: 3, episode: 1, absolute: null });
check("episode: 2nd Season - 01 keeps season", sandbox.fileEpisode("Show 2nd Season - 01 [BD 1080p].mkv"), { season: 2, episode: 1, absolute: null });
check("episode: absolute dash", sandbox.fileEpisode("[MTBB] Show - 60 (BD 1080p).mkv"), { season: null, episode: 60, absolute: null });
check("episode: absolute in parens", sandbox.fileEpisode("[A&C] Show S10E01 (0337) (WEB 1080p).mkv").absolute, 337);

const REQ = {
    titles: ["Frieren: Beyond Journey's End", "Sousou no Frieren"],
    isMovie: false,
    season: 1,
    episode: 1,
    absoluteEpisode: 1,
    derivedSeason: 1,
    lastSeason: 2,
    year: "2023",
};
check("match: correct episode", sandbox.nameMatchesEpisode("Show S01E01 [1080p].mkv", REQ), true);
check("match: wrong episode", sandbox.nameMatchesEpisode("Show S01E02 [1080p].mkv", REQ), false);
check("match: other season rejected", sandbox.nameMatchesEpisode("Show S03E01 [1080p].mkv", REQ), false);
check("match: season-3 label rejected for season 1", sandbox.nameMatchesEpisode("Show Season 3 - 01 [1080p].mkv", REQ), false);
check("match: OVA rejected", sandbox.nameMatchesEpisode("Show OVA - 01 [1080p].mkv", REQ), false);
check(
    "match: absolute accepted across seasons",
    sandbox.nameMatchesEpisode("[MTBB] Show - 60 (BD 1080p).mkv", { ...REQ, season: 4, episode: 1, absoluteEpisode: 60, derivedSeason: 4 }),
    true
);
check(
    "match: season-1 absolute must not bypass season guard",
    sandbox.nameMatchesEpisode("Show 2nd Season - 01.mkv", { ...REQ, season: 1, episode: 1, absoluteEpisode: 1, derivedSeason: 2 }),
    false
);

// --- title / candidate ranking --------------------------------------------
check("title: exact", sandbox.titleMatchScore(ANILIST["sousou no frieren"][0], ["Sousou no Frieren"]), 3);
check(
    "title: arc subtitle is a prefix match",
    sandbox.titleMatchScore({ title: { romaji: "Kimetsu no Yaiba: Yuukaku-hen", english: null, native: null }, synonyms: [] }, ["Kimetsu no Yaiba"]),
    2
);
check(
    "title: a show ending in the title is not the same show",
    sandbox.titleMatchScore({ title: { romaji: "Koisuru One Piece", english: null, native: null }, synonyms: [] }, ["One Piece"]) < 2,
    true
);
check("seasonOf: 2nd Season", sandbox.seasonOf(ANILIST["sousou no frieren"][1], { lastSeason: 2 }), 2);
check("seasonOf: base entry", sandbox.seasonOf(ANILIST["sousou no frieren"][0], { lastSeason: 2 }), 1);
check("format: movie allowed for movie", sandbox.formatAllowed("MOVIE", true), true);
check("format: TV not allowed for movie", sandbox.formatAllowed("TV", true), false);
check("format: OVA excluded for tv", sandbox.formatAllowed("OVA", false), false);
check(
    "candidates: base + 2nd season, not the loose spin-off",
    sandbox.rankCandidates(ANILIST["sousou no frieren"], { ...REQ, titles: ["Sousou no Frieren"] }).map((c) => c.media.id).sort(),
    [154587, 182255]
);

// --- end to end ------------------------------------------------------------
(async () => {
    const results = await sandbox.module.exports.getStreams(209867, "tv", 1, 1);

    // batch(1080), uhd(2160), inferred(HD), hdr(1080 HDR); private, 720p,
    // non-best silent, and DVDrip are all excluded.
    check("e2e: four playable releases", results.length, 4);
    check("e2e: every infoHash is 40 lowercase hex", results.filter((r) => !/^[0-9a-f]{40}$/.test(r.infoHash)).length, 0);
    check("e2e: no blank urls", results.filter((r) => !r.url).length, 0);
    check("e2e: no fileIdx field", results.filter((r) => "fileIdx" in r).length, 0);
    check("e2e: all torrents", results.every((r) => r.type === "torrent" && r.provider === "SeaDex"), true);
    check("e2e: private hash never used", results.filter((r) => r.infoHash === H.private).length, 0);
    check("e2e: 720p excluded", results.filter((r) => r.infoHash === H.sd).length, 0);
    check("e2e: non-best silent excluded", results.filter((r) => r.infoHash === H.unbest).length, 0);
    check("e2e: DVDrip excluded", results.filter((r) => r.infoHash === H.dvd).length, 0);
    check("e2e: season-2 entry never leaks into season 1", results.filter((r) => r.infoHash === H.s2).length, 0);

    const batch = results.find((r) => r.infoHash === H.batch);
    check("e2e: multi-file uses torrent://hash/index", batch && batch.url, "torrent://" + H.batch + "/0");
    const uhd = results.find((r) => r.infoHash === H.uhd);
    check("e2e: single-file uses a magnet", uhd && /^magnet:\?xt=urn:btih:[0-9a-f]{40}$/.test(uhd.url), true);
    check("e2e: 2160p labelled", uhd && uhd.quality, "2160p");
    check("e2e: 2160p ranked above 1080p", results.indexOf(uhd) < results.indexOf(batch), true);
    check("e2e: inferred release is labelled HD", results.find((r) => r.infoHash === H.inferred).quality, "HD");
    check("e2e: HDR labelled", results.find((r) => r.infoHash === H.hdr).quality, "1080p HDR");
    check("e2e: rank prefix keeps order through Nuvio's sort", results.map((r) => r.name.slice(0, 2)), ["01", "02", "03", "04"]);
    const sorted = results.map((r) => r.name).slice().sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    check("e2e: order survives alphabetical sort", sorted, results.map((r) => r.name));

    // A season-2 request must find the season-2 entry and not season 1.
    const s2 = await sandbox.module.exports.getStreams(209867, "tv", 2, 1);
    check("e2e: season 2 finds its entry", s2.length, 1);
    check("e2e: season 2 hash", s2[0] && s2[0].infoHash, H.s2);
    check("e2e: season 2 batch index 0", s2[0] && s2[0].url, "torrent://" + H.s2 + "/0");

    // Movies: no season/episode; the largest file is the feature.
    const movie = await sandbox.module.exports.getStreams(129999, "movie");
    check("e2e: movie resolves", movie.length, 1);
    check("e2e: movie hash", movie[0] && movie[0].infoHash, H.movie);
    check("e2e: movie uses magnet", movie[0] && /^magnet:\?xt=urn:btih:[0-9a-f]{40}$/.test(movie[0].url), true);

    // IMDb id resolves through TMDB find first.
    const fromImdb = await sandbox.module.exports.getStreams("tt1234567", "tv", 1, 1);
    check("e2e: imdb id resolves", fromImdb.length, results.length);

    // A show with no AniList match returns nothing rather than throwing.
    const none = await makeSandbox({
        fetch: async (url, options) => {
            if (String(url).indexOf("graphql.anilist.co") !== -1) return json({ data: { Page: { media: [] } } });
            return sandbox.fetch(url, options);
        },
    });
    vm.createContext(none);
    vm.runInContext(source, none);
    const empty = await none.module.exports.getStreams(209867, "tv", 1, 1);
    check("e2e: no AniList match returns empty", empty.length, 0);

    // Android TV host: no setTimeout. The whole lookup must still work and
    // must not call delay() (the 429 retry is timer-gated).
    const tv = makeSandbox();
    delete tv.setTimeout;
    delete tv.clearTimeout;
    vm.createContext(tv);
    vm.runInContext(source, tv);
    const tvRows = await tv.module.exports.getStreams(209867, "tv", 1, 1);
    check("tv (no setTimeout): still yields streams", tvRows.length, results.length);
    check("tv: batch row keeps torrent:// shape", tvRows.find((r) => r.infoHash === H.batch).url, "torrent://" + H.batch + "/0");

    // AniList 429 on the first try is retried once, not turned into "no streams".
    let anilistCalls = 0;
    const flaky = makeSandbox({
        fetch: async (url, options) => {
            if (String(url).indexOf("graphql.anilist.co") !== -1) {
                anilistCalls++;
                if (anilistCalls === 1) return { ok: false, status: 429, text: async () => "", json: async () => ({}), headers: { get: () => null } };
            }
            return sandbox.fetch(url, options);
        },
    });
    vm.createContext(flaky);
    vm.runInContext(source, flaky);
    const retried = await flaky.module.exports.getStreams(209867, "tv", 1, 1);
    check("e2e: 429 retried", retried.length, results.length);

    console.log(failures.length ? `\n${failures.join("\n")}\n\n${failures.length} FAILED` : "\nALL PASS");
    process.exit(failures.length ? 1 : 0);
})();
