// Self-check for the torrent plugin: release matching (episode token, season
// guard, batch rejection), base32 hash decoding, AnimeTosho parsing, and the
// shape Nuvio's plugin bridge accepts (non-blank url + 40-hex infoHash).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "anime-torrent.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));

const TMDB_TV = JSON.stringify({
    name: "Attack on Titan",
    original_name: "進撃の巨人",
    first_air_date: "2013-04-07",
    number_of_seasons: 4,
    seasons: [{ season_number: 1 }, { season_number: 2 }, { season_number: 3 }, { season_number: 4 }],
});
const TMDB_ALT = JSON.stringify({
    results: [
        { title: "Shingeki no Kyojin", iso_3166_1: "JP" },
        { title: "AoT", iso_3166_1: "US" },
    ],
});
const TMDB_OTHER = JSON.stringify({
    name: "Bleach",
    original_name: "BLEACH",
    first_air_date: "2004-10-05",
    number_of_seasons: 1,
    seasons: [{ season_number: 1 }],
});
// IMDb ids resolve to a TMDB id before the normal titles path.
const TMDB_FIND = JSON.stringify({
    tv_results: [{ id: 1429, name: "Attack on Titan" }],
    movie_results: [],
});
// Kitsu entries are per-season; en_jp is the romaji release groups use.
const KITSU_AOT = JSON.stringify({
    data: {
        attributes: {
            canonicalTitle: "Attack on Titan",
            titles: { en: "Attack on Titan", en_jp: "Shingeki no Kyojin", ja_jp: "進撃の巨人" },
            startDate: "2013-04-07",
        },
    },
});

const HASH = {
    a: "1111111111111111111111111111111111111111",
    b: "2222222222222222222222222222222222222222",
    c: "3333333333333333333333333333333333333333",
    d: "4444444444444444444444444444444444444444",
    e: "5555555555555555555555555555555555555555",
    f: "6666666666666666666666666666666666666666",
    g: "7777777777777777777777777777777777777777",
    h: "8888888888888888888888888888888888888888",
    i: "9999999999999999999999999999999999999999",
};

// AnimeTosho mirrors Nyaa (plus TokyoTosho/AniDex/nekoBT) and is the only
// source; the fixture carries a real release plus the rows the matcher must
// reject, like the site does.
const ATS_MAIN = "3cdae471c4ceb28cb30b4067954ad9cc8c0066f9";
function toshoEntry(title, hash, seeders, size) {
    return (
        '<div class="home_list_entry">' +
        '<div class="size" title="Total file size: 1">' + size + "</div>" +
        '<div class="link"><a href="https://animetosho.org/view/x">' + title + "</a></div>" +
        '<div class="links"><a href="magnet:?xt=urn:btih:' + hash + '&amp;dn=x">Magnet</a>' +
        '<span title="Seeders: ' + seeders + ' / Leechers: 1">[' + seeders + "]</span></div>" +
        "</div>"
    );
}

const ANIMETOSHO_HTML =
    "<html><body>" +
    toshoEntry("[Group] Attack on Titan - S01E01 [1080p]", ATS_MAIN, 7, "1.4 GB") +
    toshoEntry("[Group] Attack on Titan S01E01 [720p] [Dubbed]", HASH.b, 5, "700 MB") +
    toshoEntry("[Group] Attack on Titan - S01E01 [1080p]", ATS_MAIN, 7, "1.4 GB") +
    toshoEntry("[SubsPlease] Attack on Titan - S01E01 (720p)", HASH.e, 3, "500 MB") +
    toshoEntry("[Group] Attack on Titan S02E05 [1080p]", HASH.c, 99, "1 GB") +
    toshoEntry("[Erai-raws] Attack on Titan Season 1 (01-25) [1080p] Complete", HASH.d, 80, "20 GB") +
    toshoEntry("[Group] Attack on Titan OVA - 01 [1080p]", HASH.f, 50, "1 GB") +
    "</body></html>";

// Empty so an id with no releases returns nothing without touching Nyaa.
const ANIMETOSHO_BLEACH = "<html><body></body></html>";

let fetchCalls = 0;
const requested = [];
const sandbox = {
    console: { log() {}, error() {} },
    Promise,
    Object,
    Array,
    String,
    Number,
    Math,
    JSON,
    RegExp,
    isNaN,
    parseInt,
    encodeURIComponent,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    TMDB_API_KEY: "test",
    module: { exports: {} },
    fetch: async (url) => {
        fetchCalls++;
        requested.push(String(url));
        let body = "{}";
        const other = url.indexOf("/tv/999") !== -1;
        if (url.indexOf("/alternative_titles") !== -1) body = other ? '{"results":[]}' : TMDB_ALT;
        else if (url.indexOf("/find/") !== -1) body = TMDB_FIND;
        else if (url.indexOf("kitsu.io") !== -1) body = KITSU_AOT;
        else if (url.indexOf("api.themoviedb.org") !== -1) body = other ? TMDB_OTHER : TMDB_TV;
        else if (url.indexOf("animetosho") !== -1) body = url.indexOf("Bleach") !== -1 ? ANIMETOSHO_BLEACH : ANIMETOSHO_HTML;
        return {
            ok: true,
            status: 200,
            text: async () => body,
            json: async () => JSON.parse(body),
            headers: { get: () => null },
        };
    },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const failures = [];
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures.push(`${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

// --- manifest --------------------------------------------------------------
// The Compose Multiplatform app filters scrapers by supportedPlatforms and its
// platform keys are "android"/"ios" only, so any allow-list risks 0 providers.
check("manifest: one scraper", manifest.scrapers.length, 1);
check("manifest: scraper points at anime-torrent.js", manifest.scrapers[0].filename, "anime-torrent.js");
check("manifest: no platform allow-list", manifest.scrapers[0].supportedPlatforms, undefined);
check("manifest: not disabled on a platform", manifest.scrapers[0].disabledPlatforms, undefined);

const REQ = {
    titles: ["Attack on Titan", "Shingeki no Kyojin"],
    isMovie: false,
    season: 1,
    episode: 1,
    absoluteEpisode: null,
    lastSeason: 4,
};

// --- batch detection -------------------------------------------------------
check("batch: 01 ~ 12", sandbox.isBatch("[Erai-raws] Attack on Titan Season 2 - 01 ~ 12 [1080p][BATCH]"), true);
check("batch: Complete range", sandbox.isBatch("Attack on Titan Season 1 (01-25) [1080p] Complete"), true);
check("batch: S1-S4", sandbox.isBatch("Attack on Titan S1-S4 01-75 + OVA"), true);
check("batch: single episode is not a batch", sandbox.isBatch("Attack on Titan S01E01 [1080p]"), false);
check("batch: Season 4 - 01 is not a batch", sandbox.isBatch("Attack on Titan Season 4 - 01 [1080p]"), false);
check("batch: Chinese complete marker", sandbox.isBatch("进击的巨人 全集 [1080p]"), true);
check("batch: audio channels are not a range", sandbox.isBatch("Attack on Titan - 01 [AAC 5.1 - 2.0]"), false);

// --- episode parsing -------------------------------------------------------
const ep1 = sandbox.episodeInfo("[TatakaeSubs] Attack on Titan - S01E01 (BD 1080p) [AB].mkv");
check("episode: SxxExx", [ep1.season, ep1.episode], [1, 1]);
const ep2 = sandbox.episodeInfo("Attack on Titan S4 - 01 (60)");
check("episode: Sx - yy + absolute", [ep2.season, ep2.episode, ep2.absolute], [4, 1, 60]);
check("episode: underscore fansub form", sandbox.episodeInfo("[Saizen]_Attack_on_Titan_-_01_[B61B71D5].mkv").episode, 1);
check("episode: trailing number before bracket", sandbox.episodeInfo("Shingeki no Kyojin S3-P2 (2019) 01 [1080p]").episode, 1);
check("episode: year in parens is not an episode", sandbox.episodeInfo("Attack on Titan (2013) [1080p]").episode, null);
check(
    "episode: season pack 'part 01' is not episode 1",
    sandbox.episodeInfo("[EMBER] Attack on Titan The Final Season (Season 4 | part 01) [1080p]").episode,
    null
);

// --- request matching ------------------------------------------------------
check("match: correct episode", sandbox.matchesRequest("Attack on Titan S01E01 [1080p]", REQ), true);
check("match: wrong episode", sandbox.matchesRequest("Attack on Titan S01E02 [1080p]", REQ), false);
check("match: other season rejected", sandbox.matchesRequest("Attack on Titan S02E05 [1080p]", REQ), false);
check("match: batch rejected", sandbox.matchesRequest("Attack on Titan Season 1 (01-25) [1080p] Complete", REQ), false);
check("match: OVA rejected", sandbox.matchesRequest("Attack on Titan OVA - 01 [1080p]", REQ), false);
check(
    "match: season pack rejected",
    sandbox.matchesRequest("[EMBER] Attack on Titan The Final Season (Season 4 | part 01) [1080p]", Object.assign({}, REQ, { season: 4 })),
    false
);
check(
    "match: finale special rejected",
    sandbox.matchesRequest("Shingeki no Kyojin: The Final Season - Kanketsu-hen - 01 [1080p]", REQ),
    false
);
check(
    "match: final season rejected for season 1",
    sandbox.matchesRequest("Attack on Titan The Final Season - 01 [1080p]", REQ),
    false
);
check(
    "match: final season accepted for season 4",
    sandbox.matchesRequest("Attack on Titan The Final Season - 01 [1080p]", Object.assign({}, REQ, { season: 4 })),
    true
);
check(
    "match: OADs (plural) rejected",
    sandbox.matchesRequest("Shingeki no Kyojin OADs - 01 - ENG 1080p WEB H.264 (FUNi).mkv", REQ),
    false
);
check(
    "match: final season part 2 rejected for season 1",
    sandbox.matchesRequest(
        "Shingeki no Kyojin: The Final Season Part 2 - E01 [1080p x265 HEVC]",
        Object.assign({}, REQ, { lastSeason: null })
    ),
    false
);
// A zero-seeder release never fetches metadata, so it must not sit in the list
// next to a live one; it is kept only when it is all that matched.
check("dead releases: dropped when a live one exists", sandbox.dropDeadReleases([{ seeders: 0 }, { seeders: 5 }]).length, 1);
check("dead releases: kept when every release is dead", sandbox.dropDeadReleases([{ seeders: 0 }]).length, 1);

// --- hash decoding ---------------------------------------------------------
check(
    "base32 -> hex",
    sandbox.base32ToHex("HTNOI4OEZ2ZIZMYLIBTZKSWZZSGAAZXZ"),
    "3cdae471c4ceb28cb30b4067954ad9cc8c0066f9"
);
const tosho = sandbox.parseAnimeTosho(ANIMETOSHO_HTML);
check("animetosho parse: all rows", tosho.length, 7);
check("animetosho parse: hex hash", tosho[0] && tosho[0].hash, ATS_MAIN);
check("animetosho parse: seeders", tosho[0] && tosho[0].seeders, 7);

// A dead release (no peers) stalls the P2P engine on metadata, so a live lower
// -quality release must outrank it; a live 1080p must still outrank a live 720p.
const att = { season: 1, titles: ["Attack on Titan"] };
check(
    "a live 720p outranks a dead 1080p",
    sandbox.scoreOf({ title: "[Group] Attack on Titan - S01E01 [720p]", seeders: 20 }, att) >
        sandbox.scoreOf({ title: "[Group] Attack on Titan - S01E01 [1080p]", seeders: 0 }, att),
    true
);
check(
    "a live 1080p still outranks a live 720p",
    sandbox.scoreOf({ title: "[Group] Attack on Titan - S01E01 [1080p]", seeders: 5 }, att) >
        sandbox.scoreOf({ title: "[Group] Attack on Titan - S01E01 [720p]", seeders: 5 }, att),
    true
);
// SubsPlease is the trusted-sub tier: its low-seeded 720p must beat a
// higher-seeded 1080p from an unknown group, and a [Dubbed] release.
check(
    "SubsPlease 720p outranks a higher-seeded non-SubsPlease 1080p",
    sandbox.scoreOf({ title: "[SubsPlease] Attack on Titan - S01E01 (720p)", seeders: 3 }, att) >
        sandbox.scoreOf({ title: "[Group] Attack on Titan - S01E01 [1080p]", seeders: 50 }, att),
    true
);
check(
    "SubsPlease outranks a [Dubbed] release",
    sandbox.scoreOf({ title: "[SubsPlease] Attack on Titan - S01E01 (720p)", seeders: 3 }, att) >
        sandbox.scoreOf({ title: "[Group] Attack on Titan S01E01 [1080p] [Dubbed]", seeders: 50 }, att),
    true
);
// SubsPlease names episodes "- 01", not "S01E01", so they miss the +60 season
// bonus other releases get; the tier must still win (found live on Kanata kara).
check(
    "SubsPlease beats a season-matched non-SubsPlease 1080p",
    sandbox.scoreOf({ title: "[SubsPlease] Attack on Titan - 01 (1080p)", seeders: 10 }, att) >
        sandbox.scoreOf({ title: "[Group] Attack on Titan S01E01 [1080p] [Multi-Subs]", seeders: 50 }, att),
    true
);

// --- end to end ------------------------------------------------------------
(async () => {
    requested.length = 0;
    const results = await sandbox.module.exports.getStreams(1429, "tv", 1, 1, 1);

    check("returns the episode 1 releases from AnimeTosho", results.length, 3);
    check("SubsPlease ranks first", results[0] && results[0].infoHash, HASH.e);
    check("SubsPlease is labelled", results[0] && /SubsPlease/.test(results[0].name), true);
    // AnimeTosho.org is frozen (no releases after 2026-05-09); the live successor
    // animetosho.xyz is queried alongside it, so both hosts must appear and no
    // dead source (nyaa.si here) may be touched.
    check(
        "both AnimeTosho hosts queried, no Nyaa",
        requested.some((u) => u.indexOf("animetosho.xyz") !== -1) &&
            requested.some((u) => u.indexOf("animetosho.org") !== -1) &&
            !requested.some((u) => u.indexOf("nyaa.si") !== -1),
        true
    );

    const badUrl = results.filter((r) => !/^magnet:\?xt=urn:btih:[0-9a-f]{40}$/.test(r.url));
    check("every url is a bare 40-hex magnet", badUrl.length, 0);
    const badHash = results.filter((r) => !/^[0-9a-f]{40}$/.test(r.infoHash || ""));
    check("every infoHash is 40 lowercase hex", badHash.length, 0);
    check("no blank urls", results.filter((r) => !r.url).length, 0);
    check("no fileIdx is emitted", results.filter((r) => "fileIdx" in r).length, 0);
    check("no batches/OVAs/OADs/wrong episodes", results.filter((r) => /batch|ova|oad|S02E05|01-25|final season/i.test(r.title)).length, 0);
    check("duplicate hash deduped", results.filter((r) => r.infoHash === ATS_MAIN).length, 1);
    check("sub and dub both labelled", [results.some((r) => r.language === "Sub"), results.some((r) => r.language === "Dub")], [true, true]);
    check("results are torrent type", results.every((r) => r.type === "torrent"), true);

    // When AnimeTosho has nothing for the episode the lookup returns empty
    // rather than falling through to a source that never answers.
    requested.length = 0;
    const empty = await sandbox.module.exports.getStreams(999, "tv", 1, 1, 1);
    check("empty AnimeTosho: returns nothing", empty.length, 0);
    check(
        "empty AnimeTosho: only AnimeTosho/TMDB/Kitsu are queried",
        requested.filter(
            (u) => u.indexOf("animetosho") === -1 && u.indexOf("themoviedb.org") === -1 && u.indexOf("kitsu.io") === -1
        ).length,
        0
    );

    // Nuvio passes the meta provider's id, so anime arrives as "kitsu:<id>:<ep>"
    // and other content as "tt<id>". Both must resolve to search titles rather
    // than a TMDB 404.
    const fromKitsu = await sandbox.module.exports.getStreams("kitsu:7442:1", "tv", 1, 1);
    check("kitsu id: resolves and returns streams", fromKitsu.length, results.length);
    check("kitsu id: SubsPlease ranks first", fromKitsu[0] && fromKitsu[0].infoHash, HASH.e);

    const fromImdb = await sandbox.module.exports.getStreams("tt22248376", "tv", 1, 1);
    check("imdb id: resolves via TMDB find", fromImdb.length, results.length);

    const kitsuSeason = await sandbox.kitsuInfo("7442");
    check("kitsu: romaji title leads queries", sandbox.queryTitles(kitsuSeason)[0], "Shingeki no Kyojin");

    // Raising the per-request timeout changes nothing, because AnimeTosho is
    // the only source: a miss costs one AnimeTosho round-trip and returns
    // instead of waiting on a host that never answers.
    const slowSource = source.replace("var REQUEST_TIMEOUT_MS = 8000;", "var REQUEST_TIMEOUT_MS = 60000;");
    const slowSandbox = Object.assign({}, sandbox, {
        module: { exports: {} },
        fetch: async (url) => (url.indexOf("animetosho.org") !== -1 ? ANIMETOSHO_BLEACH : sandbox.fetch(url)),
    });
    vm.createContext(slowSandbox);
    vm.runInContext(slowSource, slowSandbox);
    const slowStart = Date.now();
    const slow = await slowSandbox.module.exports.getStreams(999, "tv", 1, 1, 1);
    check("raised timeout: no-match lookup returns nothing", slow.length, 0);
    check("raised timeout: no-match lookup is quick", Date.now() - slowStart < 2000, true);

    // One reset of the TMDB connection must not empty the stream list.
    const flakySandbox = Object.assign({}, sandbox, {
        module: { exports: {} },
        fetch: (() => {
            let failedOnce = false;
            return async (url) => {
                if (!failedOnce && url.indexOf("api.themoviedb.org") !== -1 && url.indexOf("/tv/1429?") !== -1) {
                    failedOnce = true;
                    throw new Error("connection reset");
                }
                return sandbox.fetch(url);
            };
        })(),
    });
    vm.createContext(flakySandbox);
    vm.runInContext(source, flakySandbox);
    const retried = await flakySandbox.module.exports.getStreams(1429, "tv", 1, 1, 1);
    check("TMDB retry: one reset still yields streams", retried.length > 0, true);

    console.log(failures.length ? `\n${failures.join("\n")}\n\n${failures.length} FAILED` : "\nALL PASS");
    console.log(`fetch calls: ${fetchCalls}`);
    process.exit(failures.length ? 1 : 0);
})();