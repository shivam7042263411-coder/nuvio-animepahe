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
    seasons: [
        { season_number: 1, episode_count: 25 },
        { season_number: 2, episode_count: 12 },
        { season_number: 3, episode_count: 22 },
        { season_number: 4, episode_count: 28 },
    ],
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
    toshoEntry("[Group] Attack on Titan S01E01 [1080p] [Dubbed]", HASH.b, 5, "1.3 GB") +
    toshoEntry("[Group] Attack on Titan - S01E01 [1080p]", ATS_MAIN, 7, "1.4 GB") +
    toshoEntry("[SubsPlease] Attack on Titan - 01 (1080p) [HDR]", HASH.e, 3, "900 MB") +
    toshoEntry("[Group] Attack on Titan - S01E01 [720p]", HASH.g, 90, "400 MB") +
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
// "11.5" is an OVA/recap, not episode 11 (found live on Hyouka).
check("episode: 11.5 is not episode 11", sandbox.episodeInfo("[Commie] Hyouka - 11.5 [BD 1080p AAC]").episode, null);
// A bare season marker is a season pack, not episode 1 (found live on Bocchi).
check(
    "episode: 'Season 01 (S01)' pack has no episode",
    sandbox.episodeInfo("[SubsMix] Bocchi the Rock! - Season 01 (S01) V4 (BD 1080p HEVC Opus 2.0)").episode,
    null
);
check(
    "match: fractional episode does not satisfy its integer",
    sandbox.matchesRequest("[Commie] Hyouka - 11.5 [BD 1080p AAC]", {
        titles: ["Hyouka"],
        isMovie: false,
        season: 1,
        episode: 11,
        absoluteEpisode: null,
        lastSeason: null,
    }),
    false
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
check("animetosho parse: all rows", tosho.length, 8);
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
// Ranking is tiered: a trusted group (SubsPlease, then HorribleSubs/AnoZu/EMBER)
// sorts above every other release even when it lacks the +60 exact-season bonus
// that SxxExx releases get, and above producing groups like "Group".
function ranked(titles) {
    const list = titles.map((t) => {
        const c = { title: t[0], seeders: t[1] };
        c.score = sandbox.scoreOf(c, att);
        return c;
    });
    return sandbox.rankReleases(list).map((r) => sandbox.groupOf(r.title));
}
check(
    "ranking: SubsPlease, then trusted, then the rest",
    ranked([
        ["[Group] Attack on Titan S01E01 [1080p]", 50],
        ["[SubsPlease] Attack on Titan - 01 (1080p)", 3],
        ["[EMBER] Attack on Titan - 01 [1080p]", 10],
        ["Attack on Titan S01E01 SUBFRENCH 1080p", 1],
    ]),
    ["SubsPlease", "EMBER", "Group", ""]
);
check("trusted: SubsPlease is rank 0", sandbox.trustedRank("[SubsPlease] X - 01"), 0);
check("trusted: HorribleSubs is rank 1", sandbox.trustedRank("[HorribleSubs] X - 01"), 1);
check("trusted: AnoZu is rank 2", sandbox.trustedRank("[AnoZu] X - 01"), 2);
check("trusted: EMBER is rank 3", sandbox.trustedRank("[EMBER] X - 01"), 3);
// Groups added for their typeset (SubsPlease-style) subs.
check("trusted: Judas is rank 4", sandbox.trustedRank("[Judas] X - 01"), 4);
check("trusted: DKB is rank 5", sandbox.trustedRank("[DKB] X - 01"), 5);
check("trusted: Yameii is rank 6", sandbox.trustedRank("[Yameii] X - 01"), 6);
check("trusted: Anime Time is rank 7", sandbox.trustedRank("[Anime Time] X - 01"), 7);
// Erai-raws muxes plain Crunchyroll subs, so it stays below the styling tier.
check("trusted: plain-mux Erai-raws is untrusted", sandbox.trustedRank("[Erai-raws] X - 01"), 8);
check("trusted: unknown group is last", sandbox.trustedRank("[SomeGroup] X - 01") > 7, true);
check("groupOf: leading bracket", sandbox.groupOf("[AnoZu] X - 01"), "AnoZu");
check("groupOf: trailing tag", sandbox.groupOf("X S01E01 1080p WEB-DL H.264-VARYG"), "VARYG");

// --- HDR / 1080p-only filter ----------------------------------------------
check("HDR: HDR10+ detected", sandbox.isHdr("[SubsPlease] Show - 01 (1080p) [HDR10+]"), true);
check("HDR: bare HDR detected", sandbox.isHdr("Show S01E01 1080p HDR"), true);
check("HDR: Dolby Vision detected", sandbox.isHdr("Show 1080p Dolby Vision"), true);
check("HDR: HDRip is not HDR", sandbox.isHdr("Show 1080p HDRip"), false);
check("HDR: plain 1080p is not HDR", sandbox.isHdr("Show S01E01 1080p"), false);
check(
    "prefer1080p: drops 720p when a 1080p exists",
    sandbox.prefer1080p([{ title: "A 1080p" }, { title: "B 720p" }]).map((r) => r.title),
    ["A 1080p"]
);
check(
    "prefer1080p: falls back when there is no 1080p",
    sandbox.prefer1080p([{ title: "B 720p" }]).map((r) => r.title),
    ["B 720p"]
);

// --- end to end ------------------------------------------------------------
(async () => {
    requested.length = 0;
    const results = await sandbox.module.exports.getStreams(1429, "tv", 1, 1, 1);

    check("returns the episode 1 releases from AnimeTosho", results.length, 3);
    check("SubsPlease ranks first", results[0] && results[0].infoHash, HASH.e);
    check("SubsPlease is labelled", results[0] && /SubsPlease/.test(results[0].name), true);
    check("HDR release is labelled", results[0] && /HDR/.test(results[0].name), true);
    // Nuvio shows `name` as the row label and ignores `title`, so the release
    // name must be in `name` (with a seeder count) or every row looks identical.
    check("row labels are distinguishable", new Set(results.map((r) => r.name)).size, results.length);
    check("label carries the release name and seeders", results[0] && /^01 · \d+↑ · \[SubsPlease\]/.test(results[0].name), true);
    check("HDR is in the quality label", results[0] && results[0].quality, "1080p HDR");
    // Nuvio re-sorts every plugin row with sortedForGroupedDisplay(), a plain
    // case-insensitive alphabetical sort on `name`. Our ranking must survive it,
    // so apply the exact same sort and assert the order is unchanged.
    const asNuvioSorts = () =>
        results
            .map((r) => r.name)
            .slice()
            .sort((a, b) => {
                const x = a.toLowerCase();
                const y = b.toLowerCase();
                return x < y ? -1 : x > y ? 1 : 0;
            });
    check("order survives Nuvio's alphabetical sort", asNuvioSorts(), results.map((r) => r.name));
    check("SubsPlease stays first after that sort", /SubsPlease/.test(asNuvioSorts()[0]), true);
    // Only 1080p survives; a 90-seeder 720p must not reach the list.
    check("only 1080p results", results.filter((r) => !/^1080p(?: HDR)?$/.test(r.quality || "")).length, 0);
    check("no 720p leak", results.filter((r) => /720p/.test(r.title)).length, 0);
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
    // No extracted subtitle for this episode, so no extra track anywhere.
    check("no subs index entry: no attached tracks", results.filter((r) => r.subtitles.length).length, 0);

    // tools/grab-subs.mjs extracts a SubsPlease MKV's subtitle into this repo;
    // the plugin attaches that SRT to the other groups' releases of the same
    // episode. SRT is what makes Nuvio apply the user's subtitle appearance
    // instead of handing the file to each platform's own libass.
    const withSubs = (body) => ({
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => JSON.parse(body),
        headers: { get: () => null },
    });
    const subsSandbox = Object.assign({}, sandbox, {
        module: { exports: {} },
        fetch: async (url) => {
            if (url.indexOf("subs/index.json") !== -1) return withSubs('{"393802":"subs/subsplease/393802.srt"}');
            if (url.indexOf("animetosho") !== -1) return withSubs(ANIMETOSHO_HTML.replace(/\/view\/x/g, "/view/393802"));
            return sandbox.fetch(url);
        },
    });
    vm.createContext(subsSandbox);
    vm.runInContext(source, subsSandbox);
    const subbed = await subsSandbox.module.exports.getStreams(1429, "tv", 1, 1, 1);
    const spRow = subbed.find((r) => /SubsPlease/.test(r.name));
    const rawRows = subbed.filter((r) => !/SubsPlease/.test(r.name));
    check("subs: not re-attached to the group that ships it", spRow && spRow.subtitles.length, 0);
    check(
        "subs: other groups get the extracted SRT",
        rawRows.length === 2 && rawRows.every((r) => r.subtitles.length === 1 && /subs\/subsplease\/393802\.srt$/.test(r.subtitles[0].url)),
        true
    );
    check("subs: attached track is labelled", rawRows[0] && rawRows[0].subtitles[0].name, "SubsPlease");

    // Pre-2021 shows have no SubsPlease release; HorribleSubs is the same
    // pipeline and is what the index holds for them, so the track must carry
    // that group's name rather than a hard-coded "SubsPlease".
    check("subs: group is derived from the path", sandbox.subsGroupOf("subs/horriblesubs/168587.srt"), "HorribleSubs");
    check("subs: unknown group falls back to its slug", sandbox.subsGroupOf("subs/anozu/1.srt"), "anozu");

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

    // A TMDB request for a later season must also search the absolute episode the
    // app never passes (S2E1 with 25 season-1 episodes -> episode 26).
    requested.length = 0;
    await sandbox.module.exports.getStreams(1429, "tv", 2, 1);
    check(
        "season 2 derives the absolute episode into the query",
        requested.some((u) => /(?:Titan|Kyojin) 26/.test(decodeURIComponent(u))),
        true
    );

    const kitsuSeason = await sandbox.kitsuInfo("7442");
    check("kitsu: romaji title leads queries", sandbox.queryTitles(kitsuSeason)[0], "Shingeki no Kyojin");

    // A generic "<title> <ep>" query returns a capped page that omits the
    // trusted groups' singles, so each group is queried by name first.
    const groupQueries = sandbox.buildQueries(["Attack on Titan"], REQ);
    check("queries lead with a SubsPlease query", groupQueries[0], "SubsPlease Attack on Titan 01");
    check(
        "the tier's leading groups are queried by name",
        groupQueries.slice(0, 4),
        [
            "SubsPlease Attack on Titan 01",
            "HorribleSubs Attack on Titan 01",
            "AnoZu Attack on Titan 01",
            "EMBER Attack on Titan 01",
        ]
    );
    // Named queries cost a request each per host and the index rate-limits
    // bursts (HTTP 429 emptied the list live), so only the leading tier is
    // named; the rest are found by the generic searches.
    check(
        "named group queries stay within the request budget",
        groupQueries.filter((q) => /^(SubsPlease|HorribleSubs|AnoZu|EMBER|Judas|DKB|Yameii|Anime Time) /.test(q)).length,
        4
    );
    check("cleanTitle strips brackets", sandbox.cleanTitle("[Oshi no Ko]"), "Oshi no Ko");
    // The trusted group queries must never crowd out the generic searches: they
    // are the only source for shows no trusted group released (Hyouka, 2012).
    const hyoukaQueries = sandbox.buildQueries(["Hyouka"], REQ);
    check(
        "generic queries survive a full trusted tier",
        hyoukaQueries.filter((q) => !/^(SubsPlease|HorribleSubs|AnoZu|EMBER|Judas|DKB|Yameii|Anime Time) /.test(q)),
        ["Hyouka S01E01", "Hyouka 01"]
    );

    // Black Clover S2E7 is released as "[HorribleSubs] Black Clover - 58": groups
    // that number long-running anime continuously use the absolute episode, while
    // TMDB/the app report S2E7. The absolute number comes from TMDB's per-season
    // episode counts, so both numbering schemes get searched.
    check(
        "absolute episode: Black Clover S2E7 -> 58",
        sandbox.absoluteEpisodeFrom(
            [{ n: 1, c: 51 }, { n: 2, c: 52 }, { n: 3, c: 51 }, { n: 4, c: 16 }, { n: 0, c: 1 }],
            2,
            7
        ),
        58
    );
    check("absolute episode: specials are skipped", sandbox.absoluteEpisodeFrom([{ n: 0, c: 10 }, { n: 1, c: 12 }], 2, 1), 13);
    check("absolute episode: season 1 needs none", sandbox.absoluteEpisodeFrom([{ n: 1, c: 51 }], 1, 7), null);
    check(
        "trusted-group queries use the absolute episode",
        sandbox.buildQueries(["Black Clover"], { ...REQ, season: 2, episode: 7, absoluteEpisode: 58 })[0],
        "SubsPlease Black Clover 58"
    );
    // A group that numbers continuously must lose its bare "- 07" on an S2E7
    // request (that file is S1E7), while a season-labelled S02E07 stays.
    const bcFiltered = sandbox.dropSeasonAmbiguity(
        [
            { title: "[HorribleSubs] Black Clover - 58 [1080p]" },
            { title: "[HorribleSubs] Black Clover - 07 [1080p]" },
            { title: "[AnoZu] Black Clover S02E07 1080p" },
        ],
        { ...REQ, season: 2, episode: 7, absoluteEpisode: 58 }
    );
    check(
        "absolute numbering drops the same group's bare local episode",
        bcFiltered.map((r) => r.title),
        ["[HorribleSubs] Black Clover - 58 [1080p]", "[AnoZu] Black Clover S02E07 1080p"]
    );
    // A group that restarts numbering has no absolute release, so its "- 07" is
    // the real S2E7 and must survive.
    check(
        "seasonal numbering keeps the bare local episode",
        sandbox
            .dropSeasonAmbiguity(
                [{ title: "[SubsPlease] Show - 07 (1080p)" }],
                { ...REQ, season: 2, episode: 7, absoluteEpisode: 58 }
            )
            .length,
        1
    );

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

    // Nuvio's Android TV plugin host defines no setTimeout (only the mobile host
    // does), and this plugin used to arm a request ceiling with it - so on TV
    // every fetch threw and the list came back empty. Run the whole lookup in a
    // timer-less sandbox and require streams.
    const tvSandbox = Object.assign({}, sandbox, { module: { exports: {} } });
    delete tvSandbox.setTimeout;
    delete tvSandbox.clearTimeout;
    vm.createContext(tvSandbox);
    vm.runInContext(source, tvSandbox);
    const tvRows = await tvSandbox.module.exports.getStreams(1429, "tv", 1, 1, 1);
    check("Android TV (no setTimeout): lookup still yields streams", tvRows.length > 0, true);
    check(
        "Android TV: rows keep the magnet shape Nuvio needs",
        /^magnet:\?xt=urn:btih:[0-9a-f]{40}$/.test(tvRows[0].url) && /^[0-9a-f]{40}$/.test(tvRows[0].infoHash),
        true
    );

    console.log(failures.length ? `\n${failures.join("\n")}\n\n${failures.length} FAILED` : "\nALL PASS");
    console.log(`fetch calls: ${fetchCalls}`);
    process.exit(failures.length ? 1 : 0);
})();