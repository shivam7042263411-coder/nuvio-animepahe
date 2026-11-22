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

function rssItem(title, hash, seeders, size) {
    return (
        "<item><title>" + title + "</title>" +
        "<link>https://nyaa.si/download/x.torrent</link>" +
        "<nyaa:seeders>" + seeders + "</nyaa:seeders>" +
        "<nyaa:infoHash>" + hash + "</nyaa:infoHash>" +
        "<nyaa:size>" + size + "</nyaa:size></item>"
    );
}

const NYAA_RSS =
    '<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>' +
    rssItem("[TatakaeSubs] Attack on Titan - S01E01 (BD 1080p HEVC OPUS) [AB].mkv", HASH.a, 26, "2.2 GiB") +
    rssItem("[Saizen] Attack on Titan - 01 [720p][AAC].mkv", HASH.b, 10, "300 MiB") +
    rssItem("[Erai-raws] Attack on Titan Season 2 - 01 ~ 12 [1080p][BATCH]", HASH.c, 28, "8 GiB") +
    rssItem("[Group] Attack on Titan S02E05 [1080p]", HASH.d, 99, "1 GiB") +
    rssItem("[Group] Attack on Titan - 01 [480p].mp4", HASH.e, 3, "120 MiB") +
    rssItem("[Group] Attack on Titan OVA - 01 [1080p]", HASH.f, 50, "1 GiB") +
    rssItem("[Group] Attack on Titan S01E02 [1080p]", HASH.g, 40, "1 GiB") +
    rssItem("[Group] Attack on Titan S01E01 [1080p] [Dubbed]", HASH.h, 4, "1 GiB") +
    rssItem("[Group] Attack on Titan Season 1 (01-25) [1080p] Complete", HASH.i, 80, "20 GiB") +
    rssItem("[Other] Attack on Titan S01E01 [1080p]", HASH.a, 1, "1 GiB") +
    "</channel></rss>";

const ANIMETOSHO_HTML =
    '<html><body><div class="home_list_entry">' +
    '<div class="size" title="Total file size: 1">1.4 GB</div>' +
    '<div class="link"><a href="https://animetosho.org/view/x.n1">[Group] Attack on Titan - S01E01 [1080p]</a></div>' +
    '<div class="links"><a href="magnet:?xt=urn:btih:HTNOI4OEZ2ZIZMYLIBTZKSWZZSGAAZXZ&amp;dn=x">Magnet</a>' +
    '<span title="Seeders: 7 / Leechers: 6">[7]</span></div>' +
    "</div></body></html>";

const ANIMETOSHO_BLEACH =
    '<html><body><div class="home_list_entry">' +
    '<div class="size">1.3 GB</div>' +
    '<div class="link"><a href="https://animetosho.org/view/y.n2">[Group] Bleach - 01 [1080p]</a></div>' +
    '<div class="links"><a href="magnet:?xt=urn:btih:HTNOI4OEZ2ZIZMYLIBTZKSWZZSGAAZXZ&amp;dn=y">Magnet</a>' +
    '<span title="Seeders: 9 / Leechers: 1">[9]</span></div>' +
    "</div></body></html>";

let fetchCalls = 0;
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
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
    TMDB_API_KEY: "test",
    module: { exports: {} },
    fetch: async (url) => {
        fetchCalls++;
        let body = "{}";
        const other = url.indexOf("/tv/999") !== -1;
        if (url.indexOf("/alternative_titles") !== -1) body = other ? '{"results":[]}' : TMDB_ALT;
        else if (url.indexOf("api.themoviedb.org") !== -1) body = other ? TMDB_OTHER : TMDB_TV;
        else if (url.indexOf("nyaa.si") !== -1) body = url.indexOf("Bleach") !== -1 ? "<rss><channel></channel></rss>" : NYAA_RSS;
        else if (url.indexOf("animetosho.org") !== -1) body = url.indexOf("Bleach") !== -1 ? ANIMETOSHO_BLEACH : ANIMETOSHO_HTML;
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

// --- hash decoding ---------------------------------------------------------
check(
    "base32 -> hex",
    sandbox.base32ToHex("HTNOI4OEZ2ZIZMYLIBTZKSWZZSGAAZXZ"),
    "3cdae471c4ceb28cb30b4067954ad9cc8c0066f9"
);
const tosho = sandbox.parseAnimeTosho(ANIMETOSHO_HTML);
check("animetosho parse: one row", tosho.length, 1);
check("animetosho parse: hex hash", tosho[0] && tosho[0].hash, "3cdae471c4ceb28cb30b4067954ad9cc8c0066f9");
check("animetosho parse: seeders", tosho[0] && tosho[0].seeders, 7);

// --- end to end ------------------------------------------------------------
(async () => {
    const results = await sandbox.module.exports.getStreams(1429, "tv", 1, 1, 1);

    check("returns the four real episode 1 releases", results.length, 4);
    check("1080p sub ranks first", results[0] && results[0].infoHash, HASH.a);

    const badUrl = results.filter((r) => !/^magnet:\?xt=urn:btih:[0-9a-f]{40}$/.test(r.url));
    check("every url is a bare 40-hex magnet", badUrl.length, 0);
    const badHash = results.filter((r) => !/^[0-9a-f]{40}$/.test(r.infoHash || ""));
    check("every infoHash is 40 lowercase hex", badHash.length, 0);
    check("no blank urls", results.filter((r) => !r.url).length, 0);
    check("no fileIdx is emitted", results.filter((r) => "fileIdx" in r).length, 0);
    check("no batches/OVAs/wrong episodes", results.filter((r) => /batch|ova|S02E05|S01E02|01-25|01 ~ 12/i.test(r.title)).length, 0);
    check("duplicate hash deduped", results.filter((r) => r.infoHash === HASH.a).length, 1);
    check("sub and dub both labelled", [results.some((r) => r.language === "Sub"), results.some((r) => r.language === "Dub")], [true, true]);
    check("results are torrent type", results.every((r) => r.type === "torrent"), true);

    // Nyaa has no Bleach release in the fixture, so this exercises the
    // AnimeTosho fallback and its base32 hash decoding end to end.
    const fallback = await sandbox.module.exports.getStreams(999, "tv", 1, 1, 1);
    check("fallback: AnimeTosho fills a Nyaa miss", fallback.length, 1);
    check("fallback: decoded 40-hex hash", fallback[0] && fallback[0].infoHash, "3cdae471c4ceb28cb30b4067954ad9cc8c0066f9");

    console.log(failures.length ? `\n${failures.join("\n")}\n\n${failures.length} FAILED` : "\nALL PASS");
    console.log(`fetch calls: ${fetchCalls}`);
    process.exit(failures.length ? 1 : 0);
})();