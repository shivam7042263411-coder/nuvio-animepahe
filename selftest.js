// Self-check for the plugin's non-trivial logic: play-button picking,
// episode dedupe/positional matching, kwik 429 retry, and the season matcher.
// Loads animepahe.js into a vm with stubbed fetch/timers and asserts behaviour.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs
    .readFileSync(path.join(__dirname, "animepahe.js"), "utf8")
    .replace(/module\.exports\s*=\s*\{[^}]*\};?\s*$/, "");

let routes = {};
let fetchCalls = 0;
const logs = [];

function route(url, options) {
    for (const key of Object.keys(routes)) {
        if (url.indexOf(key) !== -1) return routes[key](url, options);
    }
    return { status: 404, body: "{}" };
}

const sandbox = {
    console: {
        log: (...args) => logs.push(args.map(String).join(" ")),
        error() {},
    },
    Promise,
    Object,
    Array,
    String,
    Number,
    Math,
    JSON,
    RegExp,
    isNaN,
    parseFloat,
    parseInt,
    encodeURIComponent,
    setTimeout: (fn) => { fn(); return 0; }, // timers fire immediately
    clearTimeout() {},
    TMDB_API_KEY: "test",
    fetch: async (url, options) => {
        fetchCalls++;
        const r = route(url, options);
        const headerMap = r.headers || {};
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            text: async () => r.body,
            json: async () => JSON.parse(r.body),
            headers: {
                get: (name) => headerMap[String(name).toLowerCase()] ?? null,
            },
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

const release = (from, to) => {
    const data = [];
    for (let e = from; e <= to; e++) data.push({ episode: String(e), session: `s${e}` });
    return { status: 200, body: JSON.stringify({ data, per_page: 30, last_page: 1 }) };
};
const search = (list) => () => ({ status: 200, body: JSON.stringify({ data: list }) });

// Minimal Dean Edwards packer, matching the exact shape kwik ships
// (`}('...',62,N,'a|b|...'.split('|'))`), so the unpacker is tested for real.
const pack = (payload, radix = 62) => {
    const words = [];
    const index = {};
    const enc = (n) => {
        let out = "";
        do {
            const d = n % radix;
            out = (d > 35 ? String.fromCharCode(d + 29) : d.toString(36)) + out;
            n = Math.floor(n / radix);
        } while (n > 0);
        return out;
    };
    const body = payload.replace(/\b\w+\b/g, (w) => {
        if (!(w in index)) index[w] = words.push(w) - 1;
        return enc(index[w]);
    });
    return (
        "eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+" +
        "((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};while(c--){d[e(c)]=k[c]||e(c)}" +
        "k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){" +
        "p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('" + body + "'," +
        radix + "," + words.length + ",'" + words.join("|") + "'.split('|'),0,{}))"
    );
};

// --- pickPlayButtons: 1080p sub wins, one result only -----------------------
const buttons = [
    { url: "u1", quality: "360p", audio: "jpn" },
    { url: "u2", quality: "720p", audio: "jpn" },
    { url: "u3", quality: "1080p", audio: "eng" },
    { url: "u4", quality: "1080p", audio: "jpn" },
    { url: "u5", quality: "720p", audio: "eng" },
    { url: "u6", quality: "1080p", audio: "jpn" },
];
check("picks one 1080p sub link", sandbox.pickPlayButtons(buttons).map((b) => b.url), ["u4"]);
check(
    "falls back to 1080p when no sub",
    sandbox.pickPlayButtons([{ url: "a", quality: "1080p", audio: "eng" }]).map((b) => b.url),
    ["a"]
);
check(
    "falls back to any button when nothing matches",
    sandbox.pickPlayButtons([{ url: "z", quality: "720p", audio: "eng" }]).map((b) => b.url),
    ["z"]
);

// --- uniqueAscendingEpisodes -------------------------------------------------
const deduped = sandbox.uniqueAscendingEpisodes([
    { episode: "26" }, { episode: "25" }, { episode: "26", alt: true }, { episode: "27" },
]);
check("episodes deduped and sorted", deduped.numbers, [25, 26, 27]);
check("first release kept per episode", deduped.byNumber[26].alt, undefined);

// --- seasonMarker / episodesOf ----------------------------------------------
check("2nd Season marker", sandbox.seasonMarker("Jujutsu Kaisen 2nd Season"), 2);
check("Season 2 marker", sandbox.seasonMarker("Jujutsu Kaisen Season 2"), 2);
check("Part 2 marker", sandbox.seasonMarker("Attack on Titan 2nd Part"), 2);
check("no marker", sandbox.seasonMarker("Jujutsu Kaisen: Shimetsu Kaiyuu"), null);
check("episodesOf missing -> 0", sandbox.episodesOf({ title: "x" }), 0);

(async () => {
    // --- findEpisode: exact match, then positional ---------------------------
    const continuous = [];
    for (let e = 25; e <= 47; e++) continuous.push({ episode: String(e), session: `s${e}` });

    routes = { "m=release": () => ({ status: 200, body: JSON.stringify({ data: continuous, per_page: 30, last_page: 1 }) }) };
    check("relative ep 1 -> listed 25", (await sandbox.findEpisode("anime", 1))?.session, "s25");
    check("relative ep 23 -> listed 47", (await sandbox.findEpisode("anime", 23))?.session, "s47");
    check("exact episode number still matches", (await sandbox.findEpisode("anime", 25))?.session, "s25");
    check("out-of-range episode returns null", await sandbox.findEpisode("anime", 99), null);
    check("probe mode refuses positional match", await sandbox.findEpisode("anime", 1, false), null);
    check("probe mode still matches exactly", (await sandbox.findEpisode("anime", 25, false))?.session, "s25");

    // --- findEpisode: page scanning + per-run cache --------------------------
    // Franchise numbering starting at 25: the target sits on page 1 even though
    // per-page math points at page 2, so page 1 must still be scanned.
    const franchise = [];
    for (let e = 25; e <= 60; e++) franchise.push({ episode: String(e), session: `s${e}` });
    routes = {
        "m=release": () => ({ status: 200, body: JSON.stringify({ data: franchise, per_page: 30, last_page: 2 }) }),
    };
    sandbox.responseCache = {};
    const before = fetchCalls;
    const r1 = await sandbox.findEpisode("anime", 42, false);
    const afterFirst = fetchCalls;
    const r2 = await sandbox.findEpisode("anime", 42, false);
    check("probe scans page 1 with franchise numbering", [r1?.session, r2?.session], ["s42", "s42"]);
    check("release pages fetched once, then cached", [afterFirst - before, fetchCalls - afterFirst], [2, 0]);
    sandbox.responseCache = null;

    // --- kwik /e/ embed page: unpack the packed source, derive the MP4 ------
    // The embed page hides the signed stream URL inside a packed script; the
    // sibling MP4 (same path under /mp4/, minus the last segment) is one
    // progressive, seekable file and is the only source offered.
    const KWIK_M3U8 = "https://vault-9.owocdn.top/stream/aa/bb/hash123/uwu.m3u8";
    const KWIK_MP4 =
        "https://vault-9.owocdn.top/mp4/aa/bb/hash123?file=Show_-_01_BD_1080p.mp4";
    const embedPage = (src) =>
        "<html><head><title>Show_-_01_BD_1080p</title></head><body>" +
        "<script>" + pack("var app=1") + "</script>" +
        "<script>" + pack("player.setup({source='" + src + "'})") + "</script>" +
        "</body></html>";

    check("unpacks a packed kwik source", sandbox.findKwikSource(embedPage(KWIK_M3U8)).m3u8, KWIK_M3U8);

    let getUrl = null;
    routes = {
        "kwik.cx/e/ep1": (url) => {
            getUrl = url;
            return { status: 200, body: embedPage(KWIK_M3U8) };
        },
    };
    const dl = await sandbox.resolveKwikDownload("https://kwik.cx/e/ep1");
    check("kwik embed yields the sibling mp4", [dl && dl.url, dl && dl.type], [KWIK_MP4, "mp4"]);
    check("kwik embed is fetched directly (no /f/ swap)", getUrl, "https://kwik.cx/e/ep1");
    check("mp4 keeps the kwik referer", dl && dl.headers && dl.headers.Referer, "https://kwik.cx/");

    // No packed source (no download offered, or the page changed) -> null, so
    // the episode is reported as having no stream rather than downgraded.
    routes = { "kwik.cx/e/ep1": () => ({ status: 200, body: "<html>no script</html>" }) };
    check("page without a packed source returns null", await sandbox.resolveKwikDownload("https://kwik.cx/e/ep1"), null);

    // --- kwik 429 retry (the embed page is the first request) ---------------
    let attempt = 0;
    routes = {
        "kwik.cx/e/rate": () => {
            attempt++;
            return attempt < 3 ? { status: 429, body: "" } : { status: 200, body: embedPage(KWIK_M3U8) };
        },
    };
    const dl429 = await sandbox.resolveKwikDownload("https://kwik.cx/e/rate");
    check("429 retried twice then succeeds", [dl429 && dl429.url, attempt], [KWIK_MP4, 3]);

    attempt = 0;
    routes = { "kwik.cx/e/dead": () => { attempt++; return { status: 429, body: "" }; } };
    check("gives up after 3 attempts", [await sandbox.resolveKwikDownload("https://kwik.cx/e/dead"), attempt], [null, 3]);

    // --- apGet: one retry after the host rate-limits (429) -------------------
    let apAttempt = 0;
    routes = {
        "api?m=search": () => (++apAttempt < 2 ? { status: 429, body: "slow down" } : { status: 200, body: '{"ok":true}' }),
    };
    check("apGet retries once on 429", [await sandbox.apGet("https://animepahe.pw/api?m=search&q=x"), apAttempt], ['{"ok":true}', 2]);

    // --- resolveEpisode: an entry that names the season ----------------------
    routes = {
        "m=search": search([
            { session: "k1", title: "Kaguya-sama wa Kokurasetai", episodes: 12, year: 2019 },
            { session: "k2", title: "Kaguya-sama wa Kokurasetai 2nd Season", episodes: 12, year: 2020 },
            { session: "k3", title: "Kaguya-sama wa Kokurasetai Ultra Romantic", episodes: 13, year: 2022 },
        ]),
        "m=release": () => release(1, 12),
    };
    let plan = await sandbox.resolveEpisode(
        { titles: ["Kaguya-sama: Love is War"], seasons: [{ season_number: 1, episode_count: 12, name: "Season 1" }] },
        2, 1, 13
    );
    check("season-named entry wins", [plan?.animeTitle, plan?.episode], ["Kaguya-sama wa Kokurasetai 2nd Season", 1]);

    // --- resolveEpisode: absolute numbering across split seasons (JJK S3) -----
    routes = {
        "m=search": search([
            { session: "jjk1", title: "Jujutsu Kaisen", episodes: 24, year: 2020 },
            { session: "jjk2", title: "Jujutsu Kaisen Season 2", episodes: 23, year: 2023 },
            { session: "jjk3", title: "Jujutsu Kaisen: Shimetsu Kaiyuu", episodes: 12, year: 2026 },
        ]),
        "m=release&id=jjk1": () => release(1, 24),
        "m=release&id=jjk2": () => release(25, 47),
        "m=release&id=jjk3": () => release(48, 59),
    };
    plan = await sandbox.resolveEpisode(
        { titles: ["Jujutsu Kaisen"], seasons: [{ season_number: 1, episode_count: 59, name: "Season 1" }] },
        3, 1, 48
    );
    check("absolute match across split seasons", [plan?.animeTitle, plan?.episode], ["Jujutsu Kaisen: Shimetsu Kaiyuu", 48]);

    // --- resolveEpisode: entries that restart numbering each season ----------
    routes = {
        "m=search": search([
            { session: "r1", title: "Show", episodes: 12, year: 2019 },
            { session: "r2", title: "Show 2nd Season", episodes: 12, year: 2020 },
            { session: "r3", title: "Show 3rd Season", episodes: 13, year: 2022 },
        ]),
        "m=release&id=r1": () => release(1, 12),
        "m=release&id=r2": () => release(1, 12),
        "m=release&id=r3": () => release(1, 13),
    };
    plan = await sandbox.resolveEpisode(
        { titles: ["Show"], seasons: [{ season_number: 1, episode_count: 40, name: "Season 1" }] },
        1, 25, 25
    );
    check("cumulative match when seasons restart", [plan?.animeTitle, plan?.episode], ["Show 3rd Season", 1]);

    // --- resolveEpisode: split cour, entries restart numbering per part ------
    routes = {
        "m=search": search([
            { session: "sc1", title: "Show", episodes: 25, year: 2016 },
            { session: "sc2", title: "Show 2nd Season", episodes: 13, year: 2020 },
            { session: "sc3", title: "Show 2nd Season Part 2", episodes: 12, year: 2021 },
        ]),
        "m=release&id=sc2": () => release(1, 13),
        "m=release&id=sc3": () => release(1, 12),
    };
    plan = await sandbox.resolveEpisode(
        {
            titles: ["Show"],
            seasons: [
                { season_number: 1, episode_count: 25, name: "Season 1" },
                { season_number: 2, episode_count: 25, name: "Season 2" },
            ],
        },
        2, 14, 39
    );
    check("split cour past part 1 picks part 2", [plan?.animeTitle, plan?.episode], ["Show 2nd Season Part 2", 1]);
    check(
        "split cour part 2 (restart numbering) resolves ep 1",
        (await sandbox.findEpisode(plan.animeSession, plan.episode))?.session,
        "s1"
    );

    // --- resolveEpisode: split cour with franchise numbering -----------------
    routes = {
        "m=search": search([
            { session: "sd1", title: "Show", episodes: 25, year: 2016 },
            { session: "sd2", title: "Show 2nd Season", episodes: 13, year: 2020 },
            { session: "sd3", title: "Show 2nd Season Part 2", episodes: 12, year: 2021 },
        ]),
        "m=release&id=sd2": () => release(1, 13),
        "m=release&id=sd3": () => release(14, 25),
    };
    plan = await sandbox.resolveEpisode(
        {
            titles: ["Show"],
            seasons: [
                { season_number: 1, episode_count: 25, name: "Season 1" },
                { season_number: 2, episode_count: 25, name: "Season 2" },
            ],
        },
        2, 14, 39
    );
    check("split cour past part 1 picks part 2 (franchise numbering)", plan?.animeTitle, "Show 2nd Season Part 2");
    check(
        "split cour part 2 (franchise numbering) resolves ep 14",
        (await sandbox.findEpisode(plan.animeSession, plan.episode))?.session,
        "s14"
    );

    // --- resolveEpisode: OVA must not shift the cumulative offset (Kaguya) ---
    // S1 12 + S2 12 = 24, so S3E1 is absolute 25 and lands on "Ultra Romantic"
    // ep 1. The 1-episode OVA aired between S2 and S3 would otherwise take the
    // offset to 25 and steal the request.
    routes = {
        "m=search": search([
            { session: "kg1", title: "Kaguya-sama: Love is War", episodes: 12, year: 2019 },
            { session: "kg2", title: "Kaguya-sama: Love is War?", episodes: 12, year: 2020 },
            { session: "kg3", title: "Kaguya-sama: Love is War OVA", episodes: 1, year: 2021 },
            { session: "kg4", title: "Kaguya-sama: Love is War -Ultra Romantic-", episodes: 13, year: 2022 },
            { session: "kg5", title: "Kaguya-sama: Love is War -The First Kiss That Never Ends-", episodes: 1, year: 2023 },
            { session: "kg6", title: "Kaguya-sama: Love Is War - Stairway to Adulthood", episodes: 1, year: 2026 },
        ]),
        "m=release&id=kg4": () => release(1, 13),
    };
    plan = await sandbox.resolveEpisode(
        {
            titles: ["Kaguya-sama: Love is War"],
            seasons: [
                { season_number: 1, episode_count: 12, name: "Season 1" },
                { season_number: 2, episode_count: 12, name: "Season 2" },
                { season_number: 3, episode_count: 13, name: "Season 3" },
            ],
        },
        3, 1, 25
    );
    check("Kaguya S3E1 skips the OVA to Ultra Romantic", [plan?.animeTitle, plan?.episode], ["Kaguya-sama: Love is War -Ultra Romantic-", 1]);
    check("isSpecialEntry flags OVA but not the series", [sandbox.isSpecialEntry("Kaguya-sama: Love is War OVA"), sandbox.isSpecialEntry("Kaguya-sama: Love is War")], [true, false]);

    // --- resolveEpisode: alt titles + title filter drop fuzzy-search noise --
    // AnimePahe's search for "Re:ZERO -Starting Life in Another World-" returns
    // unrelated shows and the "Break Time" specials; only the romaji entry
    // (found through TMDB alternative titles) is the real one.
    // A full page of fuzzy-search noise: the English-title query alone returns
    // this many, which used to stop the loop before the romaji query ran.
    const garbage = [
        { session: "g1", title: "Zipang", episodes: 26, year: 2004 },
        { session: "g2", title: "Mangirl!", episodes: 13, year: 2013 },
        { session: "g3", title: "Re:ZERO ~Starting Break Time From Zero~", episodes: 11, year: 2016 },
        { session: "g4", title: "IDOLiSH7 Second BEAT!", episodes: 15, year: 2020 },
        { session: "g5", title: "Another World", episodes: 12, year: 2019 },
        { session: "g6", title: "Starting Life", episodes: 12, year: 2018 },
        { session: "g7", title: "Zero no Tsukaima", episodes: 13, year: 2006 },
        { session: "g8", title: "World Trigger", episodes: 48, year: 2014 },
        { session: "g9", title: "Life in Another World", episodes: 12, year: 2017 },
        { session: "g10", title: "Re:Creators", episodes: 22, year: 2017 },
        { session: "g11", title: "Re:Life", episodes: 13, year: 2016 },
        { session: "g12", title: "Break Time", episodes: 11, year: 2016 },
        { session: "g13", title: "Reunion", episodes: 12, year: 2015 },
        { session: "g14", title: "Zero", episodes: 12, year: 2014 },
        { session: "g15", title: "Natsuki", episodes: 12, year: 2013 },
    ];
    const rezeroEntry = { session: "rz1", title: "Re:Zero kara Hajimeru Isekai Seikatsu", episodes: 25, year: 2016 };
    routes = {
        "m=search": (url) =>
            search(url.indexOf("kara%20Hajimeru") !== -1 ? [rezeroEntry] : garbage)(),
        "m=release&id=rz1": () => release(1, 25),
        "m=release&id=g1": () => release(1, 26),
        "m=release&id=g3": () => release(1, 11),
    };
    plan = await sandbox.resolveEpisode(
        {
            titles: [
                "Re:ZERO -Starting Life in Another World-",
                "\u30ea\u30bc\u30ed\u304b\u3089\u59cb\u3081\u308b",
                "Re:Zero kara Hajimeru Isekai Seikatsu",
                "Re:Zero",
                "ReZERO - Starting Life in Another World",
            ],
            jpTitles: ["Re:Zero kara Hajimeru Isekai Seikatsu"],
            seasons: [{ season_number: 1, episode_count: 25, name: "Season 1" }],
        },
        1, 1, 1
    );
    check(
        "alt-title query + filter rejects fuzzy-search noise",
        [plan?.animeTitle, plan?.episode],
        ["Re:Zero kara Hajimeru Isekai Seikatsu", 1]
    );

    // --- getTmdbInfo merges ascii alternative titles ------------------------
    routes = {
        "/alternative_titles": () => ({
            status: 200,
            body: JSON.stringify({
                results: [
                    { iso_3166_1: "US", title: "Re:ZERO -Starting Life in Another World- Director's Cut" },
                    { iso_3166_1: "JP", title: "Re:Zero kara Hajimeru Isekai Seikatsu" },
                    { iso_3166_1: "MX", title: "Re:Zero" },
                ],
            }),
        }),
        "/tv/65942": () => ({
            status: 200,
            body: JSON.stringify({
                name: "Re:ZERO -Starting Life in Another World-",
                original_name: "\u30ea\u30bc\u30ed",
                seasons: [],
            }),
        }),
    };
    const info = await sandbox.getTmdbInfo(65942, "tv");
    check("getTmdbInfo merges ascii alternative titles", info.titles, [
        "Re:ZERO -Starting Life in Another World-",
        "\u30ea\u30bc\u30ed",
        "Re:ZERO -Starting Life in Another World- Director's Cut",
        "Re:Zero kara Hajimeru Isekai Seikatsu",
        "Re:Zero",
    ]);
    check("getTmdbInfo keeps JP romaji, shortest first", info.jpTitles, [
        "Re:Zero kara Hajimeru Isekai Seikatsu",
    ]);

    // --- resolveEpisode: single entry, unknown episode count (One Piece) -----
    routes = {
        "m=search": search([{ session: "op", title: "One Piece", year: 1999 }]),
        "m=release&id=op": () => release(1, 1100),
    };
    plan = await sandbox.resolveEpisode(
        { titles: ["One Piece"], seasons: [{ season_number: 1, episode_count: 1100, name: "Season 1" }] },
        1, 1, 1
    );
    check("single entry with unknown count still resolves", [plan?.animeTitle, plan?.episode], ["One Piece", 1]);

    // --- resolveEpisode: nothing found --------------------------------------
    routes = { "m=search": search([]) };
    check("no candidates returns null", await sandbox.resolveEpisode({ titles: ["Nope"], seasons: [] }, 1, 1, 1), null);

    // --- getStreams: the seekable download wins over the HLS playlist --------
    const playable = {
        "api.themoviedb.org/3/tv/900": (url) =>
            url.indexOf("alternative_titles") !== -1
                ? { status: 200, body: JSON.stringify({ results: [] }) }
                : {
                      status: 200,
                      body: JSON.stringify({
                          name: "Show",
                          seasons: [{ season_number: 1, episode_count: 12 }],
                      }),
                  },
        "m=search": search([{ session: "a1", title: "Show", episodes: 12, year: 2019 }]),
        "m=release": () => release(1, 12),
        "/play/a1/": () => ({
            status: 200,
            body:
                '<div id="resolutionMenu"><button data-src="https://kwik.cx/e/ep1" ' +
                'data-resolution="1080" data-audio="jpn"></button></div>',
        }),
    };
    routes = Object.assign({}, playable, {
        "kwik.cx/e/ep1": () => ({ status: 200, body: embedPage(KWIK_M3U8) }),
    });
    let out = await sandbox.getStreams(900, "tv", 1, 1, 1);
    check(
        "getStreams returns the seekable download mp4",
        [out.length, out[0] && out[0].url, out[0] && out[0].type],
        [1, KWIK_MP4, "mp4"]
    );

    // Download unavailable -> no stream at all; HLS is never returned.
    routes = Object.assign({}, playable, {
        "kwik.cx/e/ep1": () => ({ status: 200, body: "<html>no script</html>" }),
    });
    out = await sandbox.getStreams(900, "tv", 1, 1, 1);
    check("getStreams never returns HLS", [out.length], [0]);

    // --- catalogue: folded titles, season tie-break, tier choice ------------
    check(
        "catalogue folds doubled letters",
        sandbox.catalogueKey("Haikyu!!"),
        sandbox.catalogueKey("Haikyuu!!")
    );
    check(
        "catalogue does not prefix-match",
        sandbox.catalogueKey("One Piece") === sandbox.catalogueKey("One Piece Film: Red"),
        false
    );

    const catIndex = {
        shows: [
            { file: "a.json", title: "Horimiya", season: 1 },
            { file: "b.json", title: "Horimiya", season: 2 },
            { file: "c.json", title: "One Piece", season: 1 },
        ],
    };
    check("catalogue picks the exact title", sandbox.cataloguePick(catIndex, ["Horimiya"], 1).file, "a.json");
    check("catalogue season breaks a title tie", sandbox.cataloguePick(catIndex, ["Horimiya"], 2).file, "b.json");
    check(
        "catalogue ignores a longer title",
        sandbox.cataloguePick(catIndex, ["One Piece Film: Red"], 1),
        null
    );

    const catFile = {
        rows: [
            { s: 1, e: 1, q: 1080, a: "dub", id: "dub1080" },
            { s: 1, e: 1, q: 720, a: "sub", id: "sub720" },
            { s: 1, e: 1, q: 1080, a: "sub", id: "sub1080" },
            { s: 1, e: 2, q: 1080, a: "sub", id: "ep2" },
        ],
    };
    check("catalogue serves 1080p sub", sandbox.catalogueRow(catFile, 1, 1).id, "sub1080");
    check(
        "catalogue refuses 720p",
        sandbox.catalogueRow({ rows: [{ s: 1, e: 1, q: 720, a: "sub", id: "x" }] }, 1, 1),
        null
    );
    check(
        "catalogue refuses dub",
        sandbox.catalogueRow({ rows: [{ s: 1, e: 1, q: 1080, a: "dub", id: "x" }] }, 1, 1),
        null
    );
    check("catalogue never crosses episodes", sandbox.catalogueRow(catFile, 1, 3), null);
    // One file holds every season: S2E1 and S1E1 must never be confused.
    const multiSeason = {
        rows: [
            { s: 1, e: 1, q: 1080, a: "sub", id: "s1e1" },
            { s: 2, e: 1, q: 1080, a: "sub", id: "s2e1" },
        ],
    };
    check("catalogue serves S1 from a multi-season file", sandbox.catalogueRow(multiSeason, 1, 1).id, "s1e1");
    check("catalogue serves S2 from the same file", sandbox.catalogueRow(multiSeason, 2, 1).id, "s2e1");
    check("catalogue keeps seasons apart", sandbox.catalogueRow(multiSeason, 2, 3), null);

    // --- getStreams: a catalogue hit skips AnimePahe entirely ---------------
    const catRoutes = {
        "catalogue/index.json": () => ({
            status: 200,
            body: JSON.stringify({ shows: [{ file: "show.json", title: "Show", season: 1 }] }),
        }),
        "catalogue/show.json": () => ({
            status: 200,
            body: JSON.stringify({ title: "Show", rows: [{ s: 1, e: 1, q: 1080, a: "sub", id: "cat1" }] }),
        }),
    };
    let searchHits = 0;
    const countSearch = () => {
        searchHits++;
        return { status: 200, body: JSON.stringify({ data: [] }) };
    };

    sandbox.catalogueCache = null;
    routes = Object.assign({}, catRoutes, {
        "api.themoviedb.org/3/tv/901": (url) =>
            url.indexOf("alternative_titles") !== -1
                ? { status: 200, body: JSON.stringify({ results: [] }) }
                : {
                      status: 200,
                      body: JSON.stringify({
                          name: "Show",
                          seasons: [{ season_number: 1, episode_count: 12 }],
                      }),
                  },
        "kwik.cx/e/cat1": () => ({ status: 200, body: embedPage(KWIK_M3U8) }),
        "m=search": countSearch,
        "m=release": countSearch,
        "/play/": countSearch,
    });
    out = await sandbox.getStreams(901, "tv", 1, 1, 1);
    check("catalogue hit returns the mp4", [out.length, out[0] && out[0].url], [1, KWIK_MP4]);
    check("catalogue hit never contacts AnimePahe", searchHits, 0);
    check("catalogue hit keeps the kwik referer", out[0] && out[0].headers.Referer, "https://kwik.cx/");
    check("catalogue hit labels the episode", out[0] && out[0].title, "Show - S1E1");

    // A dead id (re-upload/takedown) must fall through to the scrape, not fail.
    sandbox.catalogueCache = null;
    routes = Object.assign({}, playable, catRoutes, {
        "catalogue/show.json": () => ({
            status: 200,
            body: JSON.stringify({ title: "Show", rows: [{ s: 1, e: 1, q: 1080, a: "sub", id: "dead" }] }),
        }),
        "kwik.cx/e/dead": () => ({ status: 200, body: "<html>no script</html>" }),
        "kwik.cx/e/ep1": () => ({ status: 200, body: embedPage(KWIK_M3U8) }),
    });
    out = await sandbox.getStreams(900, "tv", 1, 1, 1);
    check(
        "dead catalogue id falls back to the scrape",
        [out.length, out[0] && out[0].url],
        [1, KWIK_MP4]
    );

// A blocked catalogue host is cached too, so it costs one timeout, not one per play.
    sandbox.catalogueCache = null;
    let blockedFetches = 0;
    routes = {
        "catalogue/index.json": () => {
            blockedFetches++;
            throw new Error("blocked");
        },
    };
    const blockedFirst = await sandbox.catalogueLookup({ titles: ["Show"] }, 1, 1).catch(() => "threw");
    const blockedSecond = await sandbox.catalogueLookup({ titles: ["Show"] }, 1, 1);
    check(
        "blocked catalogue host is retried only once per window",
        [blockedFirst, blockedSecond, blockedFetches],
        ["threw", null, 1]
    );

    // --- the scrape hands the laptop one machine-readable line per tier -----
    // The page carries 720p and a dub too; neither may reach the catalogue.
    sandbox.catalogueCache = null;
    logs.length = 0;
    routes = Object.assign({}, playable, {
        "/play/a1/": () => ({
            status: 200,
            body:
                '<div id="resolutionMenu">' +
                '<button data-src="https://kwik.cx/e/ep1" data-resolution="1080" data-audio="jpn"></button>' +
                '<button data-src="https://kwik.cx/e/lower" data-resolution="720" data-audio="jpn"></button>' +
                '<button data-src="https://kwik.cx/e/dub" data-resolution="1080" data-audio="eng"></button>' +
                "</div>",
        }),
        "kwik.cx/e/ep1": () => ({ status: 200, body: embedPage(KWIK_M3U8) }),
    });
    await sandbox.getStreams(900, "tv", 1, 1, 1);
    const idLines = logs.filter((l) => l.indexOf("kwik-id ") === 0);
    check("scrape logs only the 1080p sub id", idLines.length, 1);
    const logged = JSON.parse(idLines[0].slice("kwik-id ".length));
    check(
        "kwik-id line carries s/e/q/a/id",
        [logged.s, logged.e, logged.q, logged.a, logged.id],
        [1, 1, 1080, "sub", "ep1"]
    );

    // --- the bulk harvester's search-hit ranking ----------------------------
    // Both failure modes seen in the real run: episode-count sorting picked a
    // 500-episode sequel, index sorting picked a one-episode special.
    const pageMod = await import("./tools/harvest-page.mjs");
    const ranked = pageMod.rankHits("Naruto", [
        { title: "Naruto Shippuden", episodes: 500, session: "a" },
        { title: "Naruto", episodes: 220, session: "b" },
        { title: "Naruto the Movie", episodes: 1, session: "c" },
    ]);
    check("harvester prefers the exact title", ranked[0].session, "b");
    check(
        "harvester prefers the series over a special",
        pageMod.rankHits("Haikyuu", [
            { title: "Haikyuu!! Special Feature! The Spring Tournament", episodes: 1, session: "s" },
            { title: "Haikyuu!!", episodes: 25, session: "t" },
        ])[0].session,
        "t"
    );
    check(
        "offset inferred when the site numbers continuously",
        pageMod.inferOffset(null, [26, 27, 28]),
        25
    );
    check("no offset when the entry starts at episode 1", pageMod.inferOffset(null, [1, 2]), 0);
    check("explicit offset wins over inference", pageMod.inferOffset(12, [26]), 12);

    // --- which app season a search hit belongs to --------------------------
    const show = (title, episodes = 10) => ({ title, episodes, session: title });
    const filed = (term, titles) =>
        pageMod.classifyHits(term, titles.map((t) => show(t))).map((p) => p.season + ":" + p.title);
    check(
        "a labelled sequel is filed under its own season",
        filed("My Hero Academia", ["My Hero Academia Season 2", "My Hero Academia"]),
        ["1:My Hero Academia", "2:My Hero Academia Season 2"]
    );
    check(
        "split cours stay in one season, in part order",
        pageMod.classifyHits("Attack on Titan", [
            show("Attack on Titan 3rd Season Part 2"),
            show("Attack on Titan 3rd Season"),
        ]).map((p) => p.season + "p" + p.part),
        ["3p1", "3p2"]
    );
    check(
        "a markerless part joins the season before it",
        filed("Spy x Family", ["Spy x Family", "Spy x Family Part 2"]),
        ["1:Spy x Family", "1:Spy x Family Part 2"]
    );
    check(
        "an unlabelled sequel is skipped, never filed as season 1",
        filed("Attack on Titan", ["Attack on Titan", "Attack on Titan The Final Season"]),
        ["1:Attack on Titan"]
    );
    check(
        "a spin-off is skipped",
        filed("KonoSuba", ["KonoSuba: An Explosion on This Wonderful World!"]),
        []
    );
    check(
        "the site's order breaks a relevance tie",
        pageMod.rankHits("KonoSuba", [
            show("KonoSuba: God's Blessing on This Wonderful World!"),
            show("KonoSuba: An Explosion on This Wonderful World!"),
        ])[0].title,
        "KonoSuba: God's Blessing on This Wonderful World!"
    );
    check(
        "harvester script is valid browser JS",
        typeof new Function("return " + pageMod.harvestScript({
            term: "Naruto",
            maxEps: 12,
            season: 1,
            offset: null,
            resultIndex: -1,
        })),
        "function"
    );

    console.log(failures.length ? `\n${failures.join("\n")}\n\n${failures.length} FAILED` : "\nALL PASS");
    console.log(`fetch calls: ${fetchCalls}`);
    process.exit(failures.length ? 1 : 0);
})();
