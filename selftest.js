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
    let catFetches = 0;
    const catRoutes = {
        "catalogue/index.json": () => {
            catFetches++;
            return {
                status: 200,
                body: JSON.stringify({ shows: [{ file: "show.json", title: "Show", season: 1 }] }),
            };
        },
        "catalogue/show.json": () => {
            catFetches++;
            return {
                status: 200,
                body: JSON.stringify({ title: "Show", rows: [{ s: 1, e: 1, q: 1080, a: "sub", id: "cat1" }] }),
            };
        },
    };
    let searchHits = 0;
    const countSearch = () => {
        searchHits++;
        return { status: 200, body: JSON.stringify({ data: [] }) };
    };

    sandbox.catalogueCache = null;
    catFetches = 0;
    let tmdbBaseHits = 0;
    let tmdbAltHits = 0;
    routes = Object.assign({}, catRoutes, {
        "api.themoviedb.org/3/tv/901": (url) => {
            if (url.indexOf("alternative_titles") !== -1) {
                tmdbAltHits++;
                return { status: 200, body: JSON.stringify({ results: [] }) };
            }
            tmdbBaseHits++;
            return {
                status: 200,
                body: JSON.stringify({
                    name: "Show",
                    seasons: [{ season_number: 1, episode_count: 12 }],
                }),
            };
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
    // Speed is the point: one TMDB request, no alternative titles, and the
    // second play of the same show refetches no catalogue file.
    check("catalogue hit skips alternative titles", [tmdbBaseHits, tmdbAltHits], [1, 0]);
    out = await sandbox.getStreams(901, "tv", 1, 1, 1);
    check("repeat catalogue hit reuses the cached files", [out.length, catFetches], [1, 2]);

    // A catalogue entry stored under a short name ("Frieren") must still hit
    // when TMDB only knows that name as an alternative title: one extra TMDB
    // request, no scrape.
    sandbox.catalogueCache = null;
    let shortAltHits = 0;
    let shortScrapeHits = 0;
    routes = {
        "catalogue/index.json": () => ({
            status: 200,
            body: JSON.stringify({ shows: [{ file: "short.json", title: "Short", season: 1 }] }),
        }),
        "catalogue/short.json": () => ({
            status: 200,
            body: JSON.stringify({ title: "Short", rows: [{ s: 1, e: 1, q: 1080, a: "sub", id: "cat1" }] }),
        }),
        "api.themoviedb.org/3/tv/902": (url) =>
            url.indexOf("alternative_titles") !== -1
                ? (shortAltHits++, {
                      status: 200,
                      body: JSON.stringify({ results: [{ iso_3166_1: "US", title: "Short" }] }),
                  })
                : {
                      status: 200,
                      body: JSON.stringify({
                          name: "Long Show",
                          seasons: [{ season_number: 1, episode_count: 12 }],
                      }),
                  },
        "kwik.cx/e/cat1": () => ({ status: 200, body: embedPage(KWIK_M3U8) }),
        "m=search": () => {
            shortScrapeHits++;
            return { status: 200, body: JSON.stringify({ data: [] }) };
        },
    };
    out = await sandbox.getStreams(902, "tv", 1, 1, 1);
    check(
        "short catalogue name hits via alternative titles",
        [out.length, shortAltHits, shortScrapeHits],
        [1, 1, 0]
    );

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
    const lib = await import("./tools/catalogue-lib.mjs");
    // A temp file whose title differs from the list term: this is the filename
    // fallback, and it must hold whether or not the catalogue has been filled.
    const tempFile = path.join(__dirname, "catalogue", "selftest-show.json");
    fs.writeFileSync(tempFile, JSON.stringify({ title: "Selftest Show: The Real Title", rows: [] }));
    try {
        check(
            "a list term finds the file the harvester would write",
            lib.findShow("Selftest Show") && lib.findShow("Selftest Show").file,
            "selftest-show.json"
        );
    } finally {
        fs.unlinkSync(tempFile);
    }
    check(
        "an arc-named season is filed by size, not by name",
        pageMod
            .planSeasons(
                [
                    { title: "Jujutsu Kaisen", episodes: 24, year: 2020 },
                    { title: "Jujutsu Kaisen Season 2", episodes: 23, year: 2023 },
                    { title: "Jujutsu Kaisen: Culling Game", episodes: 12, year: 2026 },
                ],
                [{ n: 1, episodes: 59, year: "2020" }]
            )
            .map((p) => "S" + p.season + ":" + p.parts.map((x) => x.title).join("+"))
            .join(" "),
        "S1:Jujutsu Kaisen+Jujutsu Kaisen Season 2+Jujutsu Kaisen: Culling Game"
    );
    check(
        "labelled seasons still split where TMDB splits them",
        pageMod
            .planSeasons(
                [
                    { title: "Attack on Titan", episodes: 25, year: 2013 },
                    { title: "Attack on Titan Season 2", episodes: 12, year: 2017 },
                ],
                [
                    { n: 1, episodes: 25, year: "2013" },
                    { n: 2, episodes: 12, year: "2017" },
                ]
            )
            .map((p) => "S" + p.season + ":" + p.parts.map((x) => x.title).join("+"))
            .join(" "),
        "S1:Attack on Titan S2:Attack on Titan Season 2"
    );
    // Real output, 2026-11-19: Re:Zero's site entries are typed, and the
    // 25-episode Break Time spin-off is a Special that used to fill season 2.
    check(
        "a Special-typed spin-off is never a season",
        pageMod
            .planSeasons(
                [
                    { title: "Re:ZERO -Starting Life in Another World-", type: "TV", episodes: 25, year: 2016 },
                    { title: "Re:ZERO ~Starting Break Time From Zero~", type: "Special", episodes: 11, year: 2016 },
                    { title: "Re:ZERO -Starting Life in Another World- Season 2", type: "TV", episodes: 13, year: 2020 },
                    { title: "Re:ZERO ~Starting Break Time From Zero~ Season 2", type: "Special", episodes: 25, year: 2020 },
                    { title: "Re:ZERO -Starting Life in Another World- Season 2 Part 2", type: "TV", episodes: 12, year: 2021 },
                    { title: "Re:ZERO -Starting Life in Another World- Season 3", type: "TV", episodes: 16, year: 2024 },
                ],
                [{ n: 1, episodes: 85, year: "2016" }]
            )
            .map((p) => "S" + p.season + ":" + p.parts.map((x) => x.episodes).join("+") +
                (p.partial ? "/" + p.size : ""))
            .join(" "),
        "S1:25+13+12+16/85"
    );
    // Real output, 2026-11-19: Junior High fits season 2's twelve episodes
    // exactly, so sizing alone filed the spin-off as Attack on Titan season 2.
    check(
        "a spin-off of the same length is not taken for the named season",
        pageMod
            .planSeasons(
                [
                    { title: "Attack on Titan", episodes: 25, year: 2013 },
                    { title: "Attack on Titan OAD", episodes: 3, year: 2014 },
                    { title: "Attack on Titan: No Regrets", episodes: 2, year: 2015 },
                    { title: "Attack on Titan: Junior High", episodes: 12, year: 2015 },
                    { title: "Attack on Titan Season 2", episodes: 12, year: 2017 },
                    { title: "Attack on Titan: Lost Girls", episodes: 3, year: 2018 },
                    { title: "Attack on Titan Season 3", episodes: 12, year: 2018 },
                    { title: "Attack on Titan Season 3 Part 2", episodes: 10, year: 2019 },
                ],
                [
                    { n: 1, episodes: 25, year: "2013" },
                    { n: 2, episodes: 12, year: "2017" },
                    { n: 3, episodes: 22, year: "2018" },
                    { n: 4, episodes: 28, year: "2020" },
                ]
            )
            .map((p) => "S" + p.season + ":" + p.parts.map((x) => x.title).join("+"))
            .join(" "),
        "S1:Attack on Titan S2:Attack on Titan Season 2 S3:Attack on Titan Season 3+Attack on Titan Season 3 Part 2"
    );
    // Real output, 2026-11-19: the 2022 film and the "Episode 0" prologue both
    // sit inside the pool, and both used to make S2 and S3 unfillable.
    check(
        "a film and a prologue in the pool do not break the seasons they sit in",
        pageMod
            .planSeasons(
                [
                    "Mushoku Tensei: Jobless Reincarnation|11|2021",
                    "Mushoku Tensei: Jobless Reincarnation Part 2|12|2021",
                    "Mushoku Tensei: Jobless Reincarnation - Eris the Goblin Slayer|1|2022",
                    "Mushoku Tensei: Jobless Reincarnation Season 2|12|2023",
                    'Mushoku Tensei: Jobless Reincarnation Season 2 - Episode 0 "Guardian Fitz"|1|2023',
                    "Mushoku Tensei: Jobless Reincarnation Season 2 Part 2|12|2024",
                    "Mushoku Tensei: Jobless Reincarnation Season 3|14|2026",
                ].map((l) => {
                    const [title, episodes, year] = l.split("|");
                    return { title, episodes: Number(episodes), year: Number(year) };
                }),
                [
                    { n: 1, episodes: 23, year: "2021" },
                    { n: 2, episodes: 24, year: "2023" },
                    { n: 3, episodes: 14, year: "2026" },
                ]
            )
            .map((p) => "S" + p.season + ":" + p.parts.map((x) => x.episodes).join("+"))
            .join(" "),
        "S1:11+12 S2:12+12 S3:14"
    );
    check(
        "a one-episode entry named as a season still starts that season",
        pageMod
            .planSeasons(
                [
                    { title: "Some Show", episodes: 12, year: 2024 },
                    { title: "Some Show Season 2", episodes: 1, year: 2026 },
                ],
                [
                    { n: 1, episodes: 12, year: "2024" },
                    { n: 2, episodes: 12, year: "2026" },
                ]
            )
            .map((p) => "S" + p.season + ":" + p.parts.length + (p.partial ? "!" : ""))
            .join(" "),
        "S1:1 S2:1!"
    );
    check(
        "a season whose site list ends early is filed as still airing",
        pageMod
            .planSeasons(
                [
                    { title: "Some Show", episodes: 12, year: 2024 },
                    { title: "Some Show Season 2", episodes: 5, year: 2026 },
                ],
                [
                    { n: 1, episodes: 12, year: "2024" },
                    { n: 2, episodes: 12, year: "2026" },
                ]
            )
            .map((p) => "S" + p.season + ":" + p.parts.map((x) => x.title).join("+") +
                (p.partial ? "!" + p.size : ""))
            .join(" "),
        "S1:Some Show S2:Some Show Season 2!12"
    );
    check(
        "entries left over after a short season are not filed at all",
        pageMod.planSeasons(
            [
                { title: "Some Show", episodes: 5, year: 2024 },
                { title: "Some Show Season 2", episodes: 12, year: 2026 },
            ],
            [{ n: 1, episodes: 12, year: "2024" }]
        ).length,
        0
    );
    check(
        "a season that does not add up is reported, not guessed",
        pageMod.unfiledHits(
            "Jujutsu Kaisen",
            [
                { title: "Jujutsu Kaisen", episodes: 24, year: 2020 },
                { title: "Jujutsu Kaisen: Culling Game", episodes: 12, year: 2026 },
            ],
            []
        ).map((h) => h.title).join(" | "),
        "Jujutsu Kaisen | Jujutsu Kaisen: Culling Game"
    );
    // The harvester's sizing path, end to end: an entry whose name never says
    // "season 3" is filed by TMDB's sizes, and a season that does not add up
    // falls back to names with the flag set so the log can say so.
    const fakePool = [
        { title: "Jujutsu Kaisen", session: "a", year: 2020, episodes: 24 },
        { title: "Jujutsu Kaisen Season 2", session: "b", year: 2023, episodes: 23 },
        { title: "Jujutsu Kaisen: Culling Game", session: "c", year: 2026, episodes: 12 },
        { title: "Jujutsu Kaisen 0", session: "m", year: 2021, episodes: 1 },
    ];
    const fakeFetch = async (url) => {
        if (url.includes("m=search")) return { status: 200, ok: true, json: async () => ({ data: fakePool }) };
        if (url.includes("m=release")) {
            const n = { a: 24, b: 23, c: 12, long: 30 }[url.match(/id=([a-z]+)/)?.[1]] || 0;
            const data = [];
            for (let i = 1; i <= n; i++) data.push({ episode: String(i), session: "s" + i });
            return { status: 200, ok: true, json: async () => ({ data, last_page: 1 }) };
        }
        return {
            status: 200,
            ok: true,
            text: async () => '<button data-src="/e/AA1080" data-audio="jpn">1080p</button>',
        };
    };
    let siteRows = [];
    class FakeDom {
        parseFromString() {
            return {
                querySelectorAll: (sel) =>
                    sel === 'a[href^="/anime/"]'
                        ? siteRows.map((r) => ({
                              getAttribute: (n) => (n === "title" ? r.title : "/anime/" + r.session),
                              textContent: r.title,
                          }))
                        : [{ dataset: { src: "/e/AA1080", audio: "jpn" }, textContent: "1080p" }],
            };
        }
    }
    const run = (seasons) =>
        new Function("fetch", "DOMParser", "setTimeout", "return " + pageMod.harvestScript({
            term: "Jujutsu Kaisen", maxEps: 0, season: 1, offset: null, resultIndex: -1,
            allSeasons: true, haveEps: [], force: false, seasons,
        }))(fakeFetch, FakeDom, (fn) => fn());
    const sized = await run([{ n: 1, episodes: 59, year: "2020" }]);
    check(
        "an arc-named season is filed by size, every row under the app's season",
        [sized.sized, sized.rows.length, sized.rows[58].s + "/" + sized.rows[58].e, sized.ignored.length],
        [true, 59, "1/59", 0]
    );
    check(
        "a film in the pool is named, not planned as a season",
        [sized.plans.length, sized.films.map((f) => f.title)],
        [3, ["Jujutsu Kaisen 0"]]
    );
    const mismatched = await run([{ n: 1, episodes: 30, year: "2020" }]);
    check(
        "a TMDB season that does not add up falls back to names, flagged",
        [mismatched.sized, mismatched.plans.length > 0, mismatched.ignored.length],
        [false, true, 1]
    );
    const throttled = await new Function("fetch", "DOMParser", "setTimeout", "return " + pageMod.harvestScript({
        term: "Jujutsu Kaisen", maxEps: 0, season: 1, offset: null, resultIndex: -1,
        allSeasons: true, haveEps: [], force: false, seasons: [{ n: 1, episodes: 59, year: "2020" }],
    }))(async () => ({ status: 429, ok: false }), FakeDom, (fn) => fn());
    check(
        "a rate-limited page stops the run instead of writing a short file",
        throttled.error,
        "throttled"
    );
    // A stop mid-show (a 429 on a play page) must hand back the episodes it did
    // read, so the next run tops the show up instead of starting it over.
    let playsRead = 0;
    const stopMidway = await new Function("fetch", "DOMParser", "setTimeout", "return " + pageMod.harvestScript({
        term: "Jujutsu Kaisen", maxEps: 0, season: 1, offset: null, resultIndex: -1,
        allSeasons: true, haveEps: [], force: false, seasons: [{ n: 1, episodes: 59, year: "2020" }],
    }))(
        async (url) => {
            if (url.includes("/play/") && ++playsRead > 3) return { status: 429, ok: false };
            return fakeFetch(url);
        },
        FakeDom,
        (fn) => fn()
    );
    check(
        "a stop mid-show keeps the episodes already read",
        [stopMidway.error, (stopMidway.rows || []).length, stopMidway.show && stopMidway.show.title],
        ["throttled", 3, "Jujutsu Kaisen"]
    );
    let playFetches = 0;
    const countingFetch = async (url) => {
        if (url.includes("/play/")) playFetches++;
        return fakeFetch(url);
    };
    const dry = await new Function("fetch", "DOMParser", "setTimeout", "return " + pageMod.harvestScript({
        term: "Jujutsu Kaisen", maxEps: 0, season: 1, offset: null, resultIndex: -1,
        allSeasons: true, haveEps: [], force: false, seasons: [{ n: 1, episodes: 59, year: "2020" }],
        dryRun: true,
    }))(countingFetch, FakeDom, (fn) => fn());
    const audited = await new Function("fetch", "DOMParser", "setTimeout", "return " + pageMod.harvestScript({
        term: "Jujutsu Kaisen", maxEps: 0, season: 1, offset: null, resultIndex: -1,
        allSeasons: true, haveEps: [], force: false, seasons: [{ n: 1, episodes: 59, year: "2020" }],
        audit: true,
    }))(countingFetch, FakeDom, (fn) => fn());
    check(
        "an audit reports the whole pool and writes nothing",
        [audited.audited.length, audited.rows.length, audited.plans.length],
        [fakePool.length, 0, 3]
    );
    check(
        "a dry run counts episodes without fetching a play page",
        [dry.rows.length, dry.seasons["1"], playFetches],
        [0, 59, 0]
    );
    // One Piece in miniature: one entry of thirty episodes, TMDB splitting it
    // into two seasons of twelve and eighteen.
    const longPool = [{ title: "One Piece", session: "long", year: 1999, episodes: 0, type: "TV" }];
    const longFetch = async (url) => {
        if (url.includes("m=search")) return { status: 200, ok: true, json: async () => ({ data: longPool }) };
        return fakeFetch(url);
    };
    const sliced = await new Function("fetch", "DOMParser", "setTimeout", "return " + pageMod.harvestScript({
        term: "One Piece", maxEps: 0, season: 1, offset: null, resultIndex: -1,
        allSeasons: true, haveEps: [], force: false, dryRun: true,
        seasons: [{ n: 1, episodes: 12, year: "1999" }, { n: 2, episodes: 18, year: null }],
    }))(longFetch, FakeDom, (fn) => fn());
    check(
        "one long entry is sliced across the seasons that add up to it",
        [
            sliced.plans.map((p) => "S" + p.season + ":" + p.slice).join(" "),
            sliced.seasons["1"],
            sliced.seasons["2"],
        ],
        ["S1:12 S2:18", 12, 18]
    );
    // Real pool, 2026-11-19: the ongoing entry has no episode count and a
    // re-cut of one arc sits beside it ("One Piece Log: Fish-Man Island Saga",
    // 21 episodes). Filed as a season it would play the wrong episodes, so the
    // ongoing entry is sliced on its own.
    const recutPool = [
        { title: "One Piece", session: "long", year: 1999, episodes: 0, type: "TV" },
        { title: "One Piece Log: Fish-Man Island Saga", session: "recut", year: 2024, episodes: 21, type: "TV" },
    ];
    const recutFetch = async (url) => {
        if (url.includes("m=search")) return { status: 200, ok: true, json: async () => ({ data: recutPool }) };
        return longFetch(url);
    };
    const recut = await new Function("fetch", "DOMParser", "setTimeout", "return " + pageMod.harvestScript({
        term: "One Piece", maxEps: 0, season: 1, offset: null, resultIndex: -1,
        allSeasons: true, haveEps: [], force: false, dryRun: true,
        seasons: [{ n: 1, episodes: 12, year: "1999" }, { n: 2, episodes: 18, year: null }],
    }))(recutFetch, FakeDom, (fn) => fn());
    check(
        "a re-cut beside an ongoing entry is not filed as a season",
        [recut.plans.map((p) => p.title).join("|"), recut.seasons["1"], recut.seasons["2"]],
        ["One Piece|One Piece", 12, 18]
    );
    const slicedRows = await new Function("fetch", "DOMParser", "setTimeout", "return " + pageMod.harvestScript({
        term: "One Piece", maxEps: 0, season: 1, offset: null, resultIndex: -1,
        allSeasons: true, haveEps: [], force: false,
        seasons: [{ n: 1, episodes: 12, year: "1999" }, { n: 2, episodes: 18, year: null }],
    }))(longFetch, FakeDom, (fn) => fn());
    check(
        "every sliced episode keeps the app's season and episode",
        [
            slicedRows.rows.length,
            slicedRows.rows.filter((r) => r.s === 1).map((r) => r.e).join(","),
            slicedRows.rows.filter((r) => r.s === 2).map((r) => r.e).join(","),
        ],
        [30, "1,2,3,4,5,6,7,8,9,10,11,12", Array.from({ length: 18 }, (_, i) => i + 1).join(",")]
    );
    // Real output, 2026-11-19: Re:ZERO is one TMDB season of 85 episodes, but
    // the site splits it into S1 + Season 2 + Season 2 Part 2 + Season 3, and
    // the entries carry continuous site numbering (Season 2 is eps 26-38).
    // Sorting parts by their own "Part 2" marker filed Season 3 before Season 2
    // Part 2, so S1E39-50 played season 3's episodes. Release order must hold.
    const rzPool = [
        { title: "Re:ZERO -Starting Life in Another World-", session: "z1", year: 2016, episodes: 25, type: "TV" },
        { title: "Re:ZERO ~Starting Break Time From Zero~", session: "z2", year: 2016, episodes: 11, type: "Special" },
        { title: "Re:ZERO -Starting Life in Another World- Season 2", session: "z3", year: 2020, episodes: 13, type: "TV" },
        { title: "Re:ZERO -Starting Life in Another World- Season 2 Part 2", session: "z4", year: 2021, episodes: 12, type: "TV" },
        { title: "Re:ZERO -Starting Life in Another World- Season 3", session: "z5", year: 2024, episodes: 16, type: "TV" },
    ];
    const rzRanges = { z1: [1, 25], z2: [1, 11], z3: [26, 38], z4: [39, 50], z5: [51, 66] };
    const rzFetch = async (url) => {
        if (url.includes("m=search")) return { status: 200, ok: true, json: async () => ({ data: rzPool }) };
        if (url.includes("m=release")) {
            const id = (url.match(/id=([a-z0-9]+)/) || [])[1];
            const [a, b] = rzRanges[id] || [1, 0];
            const data = [];
            for (let i = a; i <= b; i++) data.push({ episode: String(i), session: id + ":" + i });
            return { status: 200, ok: true, json: async () => ({ data, last_page: 1 }) };
        }
        return fakeFetch(url);
    };
    const rz = await new Function("fetch", "DOMParser", "setTimeout", "return " + pageMod.harvestScript({
        term: "Re:Zero", maxEps: 0, season: 1, offset: null, resultIndex: -1,
        allSeasons: true, haveEps: [], force: false, dryRun: true,
        seasons: [{ n: 1, episodes: 85, year: "2016" }],
    }))(rzFetch, FakeDom, (fn) => fn());
    check(
        "parts are filed in release order, not by their Part marker",
        [
            rz.plans.map((p) => p.title.replace(/^Re:ZERO -Starting Life in Another World- ?/, "") || "S1"),
            rz.seasons["1"],
        ],
        [["S1", "Season 2", "Season 2 Part 2", "Season 3"], 66]
    );
    // Real output risk: One Piece is 1180 episodes in one entry, sliced by
    // position. A hole anywhere shifts every later episode, so a list with a
    // hole must be refused rather than filed shifted.
    const holeFetch = async (url) => {
        if (url.includes("m=search")) return { status: 200, ok: true, json: async () => ({ data: longPool }) };
        if (url.includes("m=release")) {
            const data = [];
            for (let i = 1; i <= 30; i++) {
                if (i === 15) continue;
                data.push({ episode: String(i), session: "x" + i });
            }
            return { status: 200, ok: true, json: async () => ({ data, last_page: 1 }) };
        }
        return fakeFetch(url);
    };
    const holed = await new Function("fetch", "DOMParser", "setTimeout", "return " + pageMod.harvestScript({
        term: "One Piece", maxEps: 0, season: 1, offset: null, resultIndex: -1,
        allSeasons: true, haveEps: [], force: false, dryRun: true,
        seasons: [{ n: 1, episodes: 12, year: "1999" }, { n: 2, episodes: 18, year: null }],
    }))(holeFetch, FakeDom, (fn) => fn());
    check(
        "a sliced list with a hole is refused, not filed shifted",
        [holed.error ? "refused" : "filed", (holed.rows || []).length],
        ["refused", 0]
    );
    // A blocked search must say what came back: "challenge" alone cannot tell a
    // Cloudflare page from a 403, and both looked like a command that hangs.
    const blockedFetch = async (url) => {
        if (url.includes("m=search")) {
            return {
                status: 403,
                ok: false,
                clone: () => ({ text: async () => "<html><body>Access denied</body></html>" }),
                headers: { get: () => "text/html" },
                json: async () => { throw new Error("not json"); },
            };
        }
        return fakeFetch(url);
    };
    const blocked = await new Function("fetch", "DOMParser", "setTimeout", "return " + pageMod.harvestScript({
        term: "Re:Zero", maxEps: 0, season: 1, offset: null, resultIndex: -1,
        allSeasons: true, haveEps: [], force: false, dryRun: true,
        seasons: [{ n: 1, episodes: 25, year: "2016" }],
    }))(blockedFetch, FakeDom, (fn) => fn());
    check(
        "a blocked search reports the reply it got, not just \"challenge\"",
        [blocked.error, /^403 text\/html .*Access denied/.test(blocked.detail || "")],
        ["challenge", true]
    );
    // Real output, 2026-11-19: the search returns eight hits and cannot page -
    // "&page=2" returns page 1 again and the advertised next_page_url answers
    // 403. /anime lists every show, so the entries past the first eight are
    // found there and looked up by name. Attack on Titan's Final Season is the
    // case: without it, a whole season (TMDB's 28 episodes) is a miss.
    const aotPage1 = [
        { title: "Attack on Titan", session: "t1", year: 2013, episodes: 25, type: "TV" },
        { title: "Attack on Titan: Junior High", session: "t2", year: 2015, episodes: 12, type: "TV" },
        { title: "Attack on Titan Season 2", session: "t3", year: 2017, episodes: 12, type: "TV" },
        { title: "Attack on Titan OAD", session: "t4", year: 2014, episodes: 3, type: "OVA" },
        { title: "Attack on Titan Season 3", session: "t5", year: 2018, episodes: 12, type: "TV" },
        { title: "Attack on Titan Season 3 Part 2", session: "t6", year: 2019, episodes: 10, type: "TV" },
    ];
    const aotLater = [
        { title: "Attack on Titan: Final Season", session: "t7", year: 2021, episodes: 16, type: "TV" },
        { title: "Attack on Titan: Final Season Part 2", session: "t8", year: 2022, episodes: 12, type: "TV" },
        { title: "Attack on Titan: Final Season - The Final Chapters", session: "t9", year: 2023, episodes: 2, type: "Special" },
    ];
    siteRows = aotLater.map((e) => ({ title: e.title, session: e.session }));
    const aotRanges = {
        t1: [1, 25], t2: [1, 12], t3: [26, 37], t4: [1, 3], t5: [38, 49],
        t6: [50, 59], t7: [60, 75], t8: [76, 87], t9: [88, 89],
    };
    const aotFetch = async (url) => {
        if (url.includes("m=search")) {
            const q = decodeURIComponent((url.match(/q=([^&]*)/) || [])[1] || "");
            const data = q === "Attack on Titan" ? aotPage1 : aotLater.filter((e) => e.title === q);
            return { status: 200, ok: true, json: async () => ({ data }) };
        }
        if (url.includes("m=release")) {
            const id = (url.match(/id=([a-z0-9]+)/) || [])[1];
            const [a, b] = aotRanges[id] || [1, 0];
            const data = [];
            for (let i = a; i <= b; i++) data.push({ episode: String(i), session: id + ":" + i });
            return { status: 200, ok: true, json: async () => ({ data, last_page: 1 }) };
        }
        return fakeFetch(url);
    };
    const aot = await new Function("fetch", "DOMParser", "setTimeout", "return " + pageMod.harvestScript({
        term: "Attack on Titan", maxEps: 0, season: 1, offset: null, resultIndex: -1,
        allSeasons: true, haveEps: [], force: false, dryRun: true,
        seasons: [{ n: 1, episodes: 25, year: "2013" }, { n: 2, episodes: 12, year: "2017" },
            { n: 3, episodes: 22, year: "2018" }, { n: 4, episodes: 28, year: "2020" }],
    }))(aotFetch, FakeDom, (fn) => fn());
    check(
        "a season past the search's eight hits is found in the site index",
        [aot.pool.length, aot.seasons["4"]],
        [aotPage1.length + aotLater.length, 28]
    );
    siteRows = [];
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
