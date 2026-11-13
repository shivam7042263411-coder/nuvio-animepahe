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

function route(url, options) {
    for (const key of Object.keys(routes)) {
        if (url.indexOf(key) !== -1) return routes[key](url, options);
    }
    return { status: 404, body: "{}" };
}

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

    // --- kwik download: the only source (HLS is not offered) ----------------
    // The /e/ embed URL maps to the /f/ file page, whose form POSTs to /d/ and
    // answers 302 with the media file in Location.
    check(
        "kwik file url swaps /e/ for /f/",
        sandbox.kwikDownloadUrl("https://kwik.cx/e/abc123"),
        "https://kwik.cx/f/abc123"
    );

    const filePage =
        '<form method="POST" action="https://kwik.cx/d/abc123">' +
        '<input type="hidden" name="_token" value="tok123"></form>';

    let postBody = null;
    let postRedirect = null;
    routes = {
        "kwik.cx/f/": () => ({ status: 200, body: filePage }),
        "kwik.cx/d/": (url, options) => {
            postBody = options && options.body;
            postRedirect = options && options.redirect;
            return { status: 302, body: "", headers: { location: "https://cdn.example/ep1.mp4" } };
        },
    };
    const dl = await sandbox.resolveKwikDownload("https://kwik.cx/e/abc123");
    check("kwik download yields a direct mp4", [dl && dl.url, dl && dl.type], ["https://cdn.example/ep1.mp4", "mp4"]);
    check("kwik download posts its token", postBody, "_token=tok123");
    check("kwik download does not auto-follow the redirect", postRedirect, "manual");

    // A JSON body answer is also accepted (older kwik builds).
    routes = {
        "kwik.cx/f/": () => ({ status: 200, body: filePage }),
        "kwik.cx/d/": () => ({ status: 200, body: JSON.stringify({ url: "https://cdn.example/ep1.mp4" }) }),
    };
    check(
        "kwik download accepts a JSON body",
        (await sandbox.resolveKwikDownload("https://kwik.cx/e/abc123"))?.url,
        "https://cdn.example/ep1.mp4"
    );

    // No form (no download offered, or the page changed) -> null, so the
    // episode is reported as having no stream rather than downgraded to HLS.
    routes = { "kwik.cx/f/": () => ({ status: 200, body: "<html>no form</html>" }) };
    check("missing download form returns null", await sandbox.resolveKwikDownload("https://kwik.cx/e/abc123"), null);

    // --- kwik 429 retry (the file page is the first request) -----------------
    let attempt = 0;
    routes = {
        "kwik.cx/f/": () => {
            attempt++;
            return attempt < 3 ? { status: 429, body: "" } : { status: 200, body: filePage };
        },
        "kwik.cx/d/": () => ({ status: 302, body: "", headers: { location: "https://cdn.example/ep1.mp4" } }),
    };
    const dl429 = await sandbox.resolveKwikDownload("https://kwik.cx/e/rate");
    check("429 retried twice then succeeds", [dl429 && dl429.url, attempt], ["https://cdn.example/ep1.mp4", 3]);

    attempt = 0;
    routes = { "kwik.cx/f/": () => { attempt++; return { status: 429, body: "" }; } };
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
        "kwik.cx/f/ep1": () => ({
            status: 200,
            body: '<form action="https://kwik.cx/d/ep1"><input name="_token" value="t1"></form>',
        }),
        "kwik.cx/d/ep1": () => ({ status: 302, body: "", headers: { location: "https://cdn.example/ep1.mp4" } }),
    });
    let out = await sandbox.getStreams(900, "tv", 1, 1, 1);
    check(
        "getStreams returns the seekable download mp4",
        [out.length, out[0] && out[0].url, out[0] && out[0].type],
        [1, "https://cdn.example/ep1.mp4", "mp4"]
    );

    // Download unavailable -> no stream at all; HLS is never returned.
    routes = Object.assign({}, playable, {
        "kwik.cx/f/ep1": () => ({ status: 200, body: "<html>no form</html>" }),
    });
    out = await sandbox.getStreams(900, "tv", 1, 1, 1);
    check("getStreams never returns HLS", [out.length], [0]);

    console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASS");
    console.log(`fetch calls: ${fetchCalls}`);
    process.exit(failures.length ? 1 : 0);
})();
