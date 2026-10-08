"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bbhelpweb-"));
process.env.DATA_DIR = TMP;

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");
const help = require("../modules/help/help");
const helpWeb = require("../modules/help/web");
const { normalizeModule } = require("../core/loader");
const { startWeb, fakeGuild, GUILD_ID } = require("./fixtures/web-harness");
const { CHANGED, NEED, withDeadline } = require("../web/context");

const OFFICER = "100000000000000001";
const OWNER = "100000000000000002";
const KOVI = "100000000000000003";
const ZED = "100000000000000004";
const GONE = "100000000000000009"; // left the server
const MGR = "200000000000000001";
const DATA = path.join(TMP, "data.json");
const HOUR = 60 * 60 * 1000;

const helpModule = () => normalizeModule(require("../modules/help"));

function seed(mutate) {
  const d = help.emptyData();
  d.managerRoleIds = [MGR];
  if (mutate) mutate(d);
  help.saveData(d);
  return d;
}
function entry(id, userId, category, extra = {}) {
  return { id, userId, username: "stored-name", category, note: "", done: false, ts: 1000, ...extra };
}
function record(category, resolution, extra = {}) {
  return { reqId: "r", requesterId: KOVI, category, resolution, requestedTs: 1000, resolvedTs: 2000, seasonStartedTs: 500, ...extra };
}
const readData = () => fs.readFileSync(DATA, "utf8");

const guild = () =>
  fakeGuild({
    name: "BB Test",
    users: {
      [OFFICER]: { name: "Offi", roles: [MGR] },
      [OWNER]: { name: "Boss", owner: true },
      [KOVI]: { name: "Kovi <3" },
      [ZED]: { name: "Zed" },
    },
    roles: [{ id: MGR, name: "Officers", position: 5 }],
  });

async function withWeb(fn, opts = {}) {
  const w = await startWeb({ guild: guild(), modules: [helpModule()], ...opts });
  try {
    await fn(w);
  } finally {
    await w.close();
  }
}

const primaries = (html) => (html.match(/btn-primary/g) || []).length;

// ---------- dateOf ----------

test("dateOf: a timestamp becomes YYYY-MM-DD", () => {
  assert.equal(helpWeb.dateOf(Date.UTC(2026, 8, 30, 23, 59)), "2026-09-30");
  assert.equal(helpWeb.dateOf(0), "1970-01-01");
});

test("dateOf never throws: missing, non-finite and out-of-range input all give the dash", () => {
  for (const bad of [undefined, null, NaN, Infinity, "2026-01-01", 9e15, -9e15, 8.64e15 + 1]) {
    assert.equal(helpWeb.dateOf(bad), "—", String(bad));
  }
  // A valid Date whose ISO string carries a signed 6-digit year ("+010000-…").
  assert.equal(helpWeb.dateOf(253402300800000), "—");
});

test("pastSeasons: only seasons with a finite endedTs, newest first; no seasons array → []", () => {
  const s = (name, endedTs) => ({ name, startedTs: 1, endedTs });
  const data = { seasons: [s("A", 100), { name: "open", startedTs: 1 }, s("C", 300), s("B", 200), s("bad", NaN)] };
  assert.deepEqual(helpWeb.pastSeasons(data).map((x) => x.name), ["C", "B", "A"]);
  assert.deepEqual(helpWeb.pastSeasons({}), []);
  assert.deepEqual(helpWeb.pastSeasons({ seasons: [] }), []);
  assert.equal(data.seasons.length, 5, "the stored list is not reordered");
});

// ---------- Overview ----------

test("overviewModel: open requests oldest first, live names (stored name if they left), claim, waiting time", async () => {
  const now = 1000 + 3 * HOUR;
  const data = seed((d) => {
    d.currentSeason = { name: "S5", startedTs: Date.UTC(2026, 8, 1) };
    d.entries = [
      entry("b", ZED, "mvp5k", { ts: 2000, claimedBy: KOVI }),
      entry("a", KOVI, "seasonrun5k", { ts: 1000, note: "tower 3" }),
      entry("c", GONE, "mvp5k", { ts: 3000 }),
      entry("d", KOVI, "mvp5k", { done: true, helpedBy: ZED, doneTs: 5000 }),
    ];
  });
  const m = await helpWeb.overviewModel(guild(), data, now);
  assert.deepEqual(m.season, { name: "S5", started: "2026-09-01", sorted: 1 });
  assert.deepEqual(
    m.open.map((e) => [e.who, e.category, e.note, e.claimedBy]),
    [
      ["Kovi <3", "🏃 Season Run 5K", "tower 3", null],
      ["Zed", "⭐ MVP 5K", "", "Kovi <3"],
      ["stored-name", "⭐ MVP 5K", "", null],
    ]
  );
  assert.equal(m.open[0].waiting, "3h 0m");
  assert.deepEqual(m.topHelpers, [{ name: "Zed", count: 1 }]);
});

// F-M4 / O-M2: name lookups are Discord REST that discord.js may retry and
// sleep through; under a deadline they fall back instead of hanging the page.
// A guild whose name lookups (fetch(userId)) never answer — while the viewer's
// own forced lookup (fetch({ user, force })) still does.
function hangingNamesGuild() {
  const g = guild();
  const real = g.members.fetch;
  g.nameFetches = 0;
  g.members.fetch = (arg) => {
    if (typeof arg === "string") {
      g.nameFetches += 1;
      return new Promise(() => {});
    }
    return real(arg);
  };
  return g;
}
const recordingLog = () => {
  const warns = [];
  return { warns, log: () => {}, warn: (...a) => warns.push(a.map(String).join(" ")), error: () => {} };
};
const fastDeadline = (p) => withDeadline(p, 20, "name lookup");

test("overviewModel / statsModel: name lookups past the deadline fall back to stored names / '—', one warning each", async () => {
  const data = seed((d) => {
    d.entries = [
      entry("a", KOVI, "seasonrun5k", { claimedBy: ZED }),
      entry("d", KOVI, "mvp5k", { done: true, helpedBy: ZED, doneTs: 5000 }),
    ];
  });
  const log = recordingLog();
  const g = hangingNamesGuild();
  const m = await helpWeb.overviewModel(g, data, 5000, { deadline: fastDeadline, log });
  assert.deepEqual(m.open.map((e) => [e.who, e.claimedBy]), [["stored-name", null]]);
  assert.deepEqual(m.topHelpers, [{ name: "—", count: 1 }]);
  assert.equal(log.warns.length, 1, "one warning for the page, not one per name");
  assert.match(log.warns[0], /name lookup timed out/);
  const s = await helpWeb.statsModel(g, data, "current", { deadline: fastDeadline, log });
  assert.deepEqual(s.helpers, [{ rank: 1, name: "—", count: 1 }]);
  assert.equal(log.warns.length, 2);
  assert.ok(g.nameFetches > 0, "the lookups were really attempted");
  // without a deadline (the models' default) live names still resolve
  assert.deepEqual((await helpWeb.overviewModel(guild(), data, 5000)).topHelpers, [{ name: "Zed", count: 1 }]);
});

test("Overview and Stats pages: a Discord that never answers name lookups → the page still renders (stored names), within the deadline", async () => {
  seed((d) => {
    d.entries = [entry("a", KOVI, "seasonrun5k"), entry("d", KOVI, "mvp5k", { done: true, helpedBy: ZED, doneTs: 5000 })];
  });
  const before = readData();
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.map(String).join(" "));
  try {
    await withWeb(
      async (w) => {
        await w.signIn(OFFICER);
        const t0 = Date.now();
        const o = await w.page("/help");
        assert.equal(o.res.status, 200);
        assert.match(o.text, /stored-name/);
        const s = await w.page("/help/stats");
        assert.equal(s.res.status, 200);
        assert.match(s.text, /—/);
        assert.ok(Date.now() - t0 < 5000, "answered at the deadline, not after Discord");
      },
      { guild: hangingNamesGuild(), lookupTimeoutMs: 50 }
    );
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.filter((l) => /name lookup timed out/.test(l)).length, 2);
  assert.equal(readData(), before, "resolveNames stays read-only — nothing saved");
});

test("Overview page: officer sees it, names and notes escaped, at most one Primary button", async () => {
  seed((d) => {
    d.entries = [entry("a", KOVI, "seasonrun5k", { note: "<script>alert(1)</script>" })];
  });
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const { res, text } = await w.page("/help");
    assert.equal(res.status, 200);
    assert.match(text, /Kovi &lt;3/);
    assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(text, /<script>alert/);
    assert.ok(primaries(text) <= 1);
    assert.match(text, /href="\/help" aria-current="page">Overview/);
  });
});

test("/ sends an officer to the Help board overview", async () => {
  seed();
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    assert.equal((await w.request("/")).headers.get("location"), "/help");
  });
});

// ---------- Stats ----------

test("statsModel: current season — per-category waiting/sorted, top helpers by live name", async () => {
  const data = seed((d) => {
    d.entries = [
      entry("a", KOVI, "mvp5k"),
      entry("b", ZED, "mvp5k", { done: true, helpedBy: OFFICER }),
      entry("c", KOVI, "seasonrun5k", { done: true, helpedBy: OFFICER }),
    ];
  });
  const m = await helpWeb.statsModel(guild(), data, "current");
  assert.equal(m.view, "current");
  assert.equal(m.notice, null);
  assert.equal(m.summary, "1 waiting · 2 sorted");
  assert.deepEqual(m.categories, [
    { label: "🏃 Season Run 5K", waiting: 0, sorted: 1 },
    { label: "⭐ MVP 5K", waiting: 1, sorted: 1 },
  ]);
  assert.deepEqual(m.helpers, [{ rank: 1, name: "Offi", count: 2 }]);
  assert.equal(m.showWaiting, true);
});

test("statsModel: all-time and a past season come from the records; a pre-records season shows its totals", async () => {
  const data = seed((d) => {
    d.seasons = [
      { name: "S4", startedTs: 500, endedTs: 9000, sortedTotal: 2, byCategory: { mvp5k: 2 } },
      { name: "S1", startedTs: 1, endedTs: 400, sortedTotal: 7, byCategory: { seasonrun5k: 7 } },
    ];
    d.records = [
      record("mvp5k", "sorted", { helperId: ZED }),
      record("mvp5k", "sorted", { helperId: ZED }),
      record("seasonrun5k", "self"),
      record("mvp5k", "unresolved", { seasonStartedTs: 9000 }),
    ];
  });
  const all = await helpWeb.statsModel(guild(), data, "alltime");
  assert.equal(all.title, "All-time");
  assert.equal(all.summary, "2 sorted · 1 self-sorted · 0 removed · 1 unresolved");
  assert.deepEqual(all.helpers, [{ rank: 1, name: "Zed", count: 2 }]);
  const s4 = await helpWeb.statsModel(guild(), data, "9000");
  assert.equal(s4.title, "S4 (ended 1970-01-01)");
  assert.equal(s4.summary, "2 sorted · 1 self-sorted · 0 removed · 0 unresolved");
  assert.deepEqual(s4.categories, [{ label: "⭐ MVP 5K", waiting: null, sorted: 2 }]);
  const s1 = await helpWeb.statsModel(guild(), data, "400");
  assert.equal(s1.empty, "No per-request data for this season — only its totals.");
  assert.deepEqual(s1.categories, [{ label: "🏃 Season Run 5K", waiting: null, sorted: 7 }]);
  assert.deepEqual(helpWeb.statsViews(data).map((v) => v.value), ["current", "alltime", "9000", "400"]);
});

test("statsModel: an unknown view (gone season, typed URL) → current season + one explaining line", async () => {
  const data = seed();
  const m = await helpWeb.statsModel(guild(), data, "12345");
  assert.equal(m.view, "current");
  assert.equal(m.notice, "That season isn't available anymore. Showing the current season.");
  assert.equal((await helpWeb.statsModel(guild(), data, "")).notice, null);
});

test("Stats page: the picker, ?view= honoured, a repeated ?view= is ignored (current, no crash)", async () => {
  seed((d) => {
    d.seasons = [{ name: "S4 <b>", startedTs: 500, endedTs: 9000, sortedTotal: 1, byCategory: {} }];
  });
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const cur = await w.page("/help/stats");
    assert.equal(cur.res.status, 200);
    assert.match(cur.text, /<option value="current" selected>/);
    assert.match(cur.text, /S4 &lt;b&gt; \(ended 1970-01-01\)/);
    assert.equal(primaries(cur.text), 1);
    const past = await w.page("/help/stats?view=9000");
    assert.match(past.text, /<option value="9000" selected>/);
    const twice = await w.page("/help/stats?view=9000&view=alltime");
    assert.equal(twice.res.status, 200);
    assert.match(twice.text, /<option value="current" selected>/);
  });
});

test("big data: 25 categories, 150 open requests, 5000 records — Overview and Stats render", async () => {
  seed((d) => {
    d.categories = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, label: `Category ${"x".repeat(50)} ${i}`, emoji: "📌", archived: false }));
    d.entries = Array.from({ length: 150 }, (_, i) => entry(`e${i}`, i % 2 ? KOVI : ZED, `c${i % 25}`, { ts: 1000 + i }));
    d.records = Array.from({ length: 5000 }, (_, i) => record(`c${i % 25}`, "sorted", { helperId: i % 3 ? ZED : KOVI }));
  });
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const o = await w.page("/help");
    assert.equal(o.res.status, 200);
    assert.equal((o.text.match(/data-label="Member"/g) || []).length, 150);
    const s = await w.page("/help/stats?view=alltime");
    assert.equal(s.res.status, 200);
    assert.match(s.text, /5000 sorted/);
  });
});

test("GET pages never write data.json", async () => {
  seed((d) => {
    d.entries = [entry("a", KOVI, "mvp5k")];
  });
  const before = readData();
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    for (const p of ["/help", "/help/stats", "/help/stats?view=alltime", "/help/seasons"]) {
      assert.equal((await w.page(p)).res.status, 200, p);
    }
  });
  assert.equal(readData(), before);
});

// ---------- Seasons ----------

// A recording Discord client for the action effects (board refresh, cards).
function fakeClient() {
  const log = [];
  return {
    log,
    channels: {
      fetch: async (channelId) => ({
        id: channelId,
        guild: null,
        messages: {
          fetch: async (messageId) => ({
            edit: async (payload) => {
              log.push({ op: "edit", channelId, messageId, payload });
            },
          }),
        },
      }),
    },
  };
}

const issuedOf = (html) => html.match(/name="issued" value="(\d+)"/)[1];
const guardOf = (html) => html.match(/name="guard" value="([^"]*)"/)[1];
// The hidden fields a confirmation page carries back, as a browser would send them.
const confirmForm = (html, fields) => ({ ...fields, confirm: "yes", issued: issuedOf(html), guard: guardOf(html) });

test("seasonsModel: current counts; past seasons newest first with requests · helped (totals only before records)", () => {
  const data = seed((d) => {
    d.currentSeason = { name: null, startedTs: Date.UTC(2026, 8, 1) };
    d.entries = [entry("a", KOVI, "mvp5k"), entry("b", ZED, "mvp5k", { done: true })];
    d.seasons = [
      { name: "S1", startedTs: 1, endedTs: 400, sortedTotal: 7, byCategory: {} },
      { name: "S4", startedTs: 500, endedTs: 9000, sortedTotal: 2, byCategory: {} },
    ];
    d.records = [record("mvp5k", "sorted", { helperId: ZED }), record("mvp5k", "self"), record("mvp5k", "unresolved")];
  });
  const m = helpWeb.seasonsModel(data);
  assert.deepEqual(m.current, { name: "(unnamed)", named: false, started: "2026-09-01", sorted: 1, waiting: 1 });
  assert.deepEqual(m.past, [
    { target: "9000", name: "S4", ended: "1970-01-01", requests: 3, helped: 1 },
    { target: "400", name: "S1", ended: "1970-01-01", requests: null, helped: 7 },
  ]);
  assert.equal(m.maxName, 80);
});

test("Seasons: rename the current and a past season; notice line; the board refresh runs after the response", async () => {
  seed((d) => {
    d.currentSeason = { name: "Old", startedTs: 1 };
    d.seasons = [{ name: "S4", startedTs: 500, endedTs: 9000, sortedTotal: 2, byCategory: {} }];
    d.boardChannelId = "c1";
    d.boardMessageId = "m1";
  });
  const client = fakeClient();
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const r = await w.submit("/help/seasons/rename", { target: "current", name: "  Winter  " });
    assert.equal(r.res.status, 303);
    assert.match(r.next.text, /✓ Renamed to Winter\./);
    assert.equal(help.loadData().currentSeason.name, "Winter");
    await w.settle();
    assert.equal(client.log.filter((l) => l.op === "edit" && l.messageId === "m1").length, 1);
    const p = await w.submit("/help/seasons/rename", { target: "9000", name: "Autumn" });
    assert.match(p.next.text, /✓ Renamed to Autumn\./);
    assert.equal(help.loadData().seasons[0].name, "Autumn");
    // every Rename input (current and past seasons) has a placeholder
    const { text } = await w.page("/help/seasons");
    const inputs = text.match(/<input[^>]*name="name"[^>]*>/g).filter((i) => !/id="new-season"/.test(i));
    assert.equal(inputs.length, 2);
    for (const i of inputs) assert.match(i, /placeholder="New name"/);
  }, { client });
});

test("Seasons: rename refusals — unknown/garbage target, blank or 81-char name — one error line, nothing written", async () => {
  seed((d) => {
    d.currentSeason = { name: "Old", startedTs: 1 };
  });
  const before = readData();
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const cases = [
      [{ target: "abc", name: "X" }, /That season isn&#39;t available anymore\./],
      [{ target: "", name: "X" }, /That season isn&#39;t available anymore\./],
      [[["target", "current"], ["target", "9000"], ["name", "X"]], /That season isn&#39;t available anymore\./],
      [{ target: "12345", name: "X" }, /Couldn&#39;t rename that season/],
      [{ target: "current", name: "   " }, /Couldn&#39;t rename that season/],
      [{ target: "current", name: "x".repeat(81) }, /80 characters or fewer/],
      [{ target: "current", name: "Win\u0000ter" }, /Use letters, numbers and punctuation only\./],
      [{ target: "current", name: `Win${String.fromCodePoint(0x2066)}ter` }, /Use letters, numbers and punctuation only\./],
    ];
    for (const [form, re] of cases) {
      const r = await w.submit("/help/seasons/rename", form);
      assert.equal(r.res.status, 303, JSON.stringify(form));
      assert.match(r.next.text, re, JSON.stringify(form));
      assert.match(r.next.text, /notice-error/);
    }
  });
  assert.equal(readData(), before);
});

test("Seasons: Start new season asks first (waiting count shown, nothing written), then starts it and closes the pending requests", async () => {
  seed((d) => {
    d.currentSeason = { name: "Old", startedTs: 1 };
    d.entries = [entry("a", KOVI, "mvp5k"), entry("b", ZED, "mvp5k"), entry("c", KOVI, "seasonrun5k", { done: true })];
  });
  const before = readData();
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const ask = await w.post("/help/seasons/new", { name: "S6 <new>" });
    assert.equal(ask.status, 200);
    const html = await ask.text();
    assert.match(html, /New season: S6 &lt;new&gt;/);
    assert.match(html, /2 requests are waiting right now/);
    assert.match(html, /name="name" value="S6 &lt;new&gt;"/);
    assert.equal(readData(), before, "the confirmation page writes nothing");
    const go = await w.submit("/help/seasons/new", confirmForm(html, { name: "S6 <new>" }));
    assert.equal(go.res.status, 303);
    assert.match(go.next.text, /✓ Started season S6 &lt;new&gt;\. Previous season archived, board cleared\./);
    const d = help.loadData();
    assert.equal(d.currentSeason.name, "S6 <new>");
    assert.equal(d.entries.length, 0);
    assert.equal(d.records.filter((r) => r.resolution === "unresolved").length, 2);
    assert.equal(d.seasons.at(-1).name, "Old");
    await w.settle();
  });
});

test("Seasons: Start new season — blank or too long is refused before the confirmation; a stale confirmation writes nothing", async () => {
  let t = Date.now();
  seed((d) => {
    d.entries = [entry("a", KOVI, "mvp5k")];
  });
  const before = readData();
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    assert.match((await w.submit("/help/seasons/new", { name: "  " })).next.text, /Give the new season a name\./);
    assert.match((await w.submit("/help/seasons/new", { name: "x".repeat(81) })).next.text, /80 characters or fewer/);
    const html = await (await w.post("/help/seasons/new", { name: "S6" })).text();
    t += 5 * 60 * 1000 + 1;
    const late = await w.post("/help/seasons/new", confirmForm(html, { name: "S6" }));
    assert.equal(late.status, 200);
    assert.match(await late.text(), /This confirmation expired/);
  }, { now: () => t });
  assert.equal(readData(), before);
});

test("Seasons: replaying the Start-new-season confirm form is a no-op with the 'changed' notice (C1)", async () => {
  seed((d) => {
    d.currentSeason = { name: "Old", startedTs: 1 };
    d.entries = [entry("a", KOVI, "mvp5k"), entry("c", KOVI, "seasonrun5k", { done: true })];
  });
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const html = await (await w.post("/help/seasons/new", { name: "S6" })).text();
    const form = confirmForm(html, { name: "S6" });
    const first = await w.post("/help/seasons/new", form);
    assert.equal(first.status, 303);
    assert.equal(help.loadData().seasons.length, 1);
    const after = readData();
    // Back button / second tab: the very same form, well inside the 5 minutes.
    const replay = await w.post("/help/seasons/new", form);
    assert.equal(replay.status, 303);
    assert.equal(replay.headers.get("location"), "/help/seasons");
    assert.equal(readData(), after, "nothing was written the second time");
    assert.equal(help.loadData().seasons.length, 1);
    const { text } = await w.page("/help/seasons");
    assert.match(text, new RegExp(`notice-error[^>]*>✕ ${CHANGED.replace(".", "\\.")}`));
  });
});

test("Seasons: the Reset and Start-new-season confirmations with nobody waiting say so (one shared wording, no '0 requests')", async () => {
  seed((d) => {
    d.currentSeason = { name: "Old", startedTs: 1 };
    d.entries = [];
  });
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const reset = await (await w.post("/help/seasons/reset", {})).text();
    const start = await (await w.post("/help/seasons/new", { name: "S6" })).text();
    for (const html of [reset, start]) {
      assert.match(html, /Nobody is waiting right now\./);
      assert.doesNotMatch(html, /0 requests/);
    }
  });
});

test("Seasons: Reset season asks first, then clears the board (unnamed season)", async () => {
  seed((d) => {
    d.currentSeason = { name: "Old", startedTs: 1 };
    d.entries = [entry("a", KOVI, "mvp5k")];
  });
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const html = await (await w.post("/help/seasons/reset", {})).text();
    assert.match(html, /1 request is waiting right now\./);
    assert.match(html, /class="btn btn-danger">Reset season</);
    assert.equal(help.loadData().entries.length, 1);
    const go = await w.submit("/help/seasons/reset", confirmForm(html, {}));
    assert.match(go.next.text, /✓ Season reset — the board is cleared\./);
    const d = help.loadData();
    assert.equal(d.entries.length, 0);
    assert.equal(d.currentSeason.name, null);
  });
});

test("Seasons: replaying the Reset confirm form is a no-op with the 'changed' notice (C1; nothing was archived, so the guard rides on startedTs)", async () => {
  seed((d) => {
    d.currentSeason = { name: "Old", startedTs: 1 };
    d.entries = [entry("a", KOVI, "mvp5k")];
  });
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const html = await (await w.post("/help/seasons/reset", {})).text();
    const form = confirmForm(html, {});
    assert.equal((await w.post("/help/seasons/reset", form)).status, 303);
    assert.equal(help.loadData().seasons.length, 0, "no done entries, so nothing archived: only startedTs moved");
    // A request made after the reset must survive the replay.
    const d = help.loadData();
    d.entries = [entry("n", ZED, "mvp5k")];
    help.saveData(d);
    const mid = readData();
    const replay = await w.post("/help/seasons/reset", form);
    assert.equal(replay.status, 303);
    assert.equal(replay.headers.get("location"), "/help/seasons");
    assert.equal(readData(), mid, "the new request is still there, nothing else written");
    const { text } = await w.page("/help/seasons");
    assert.match(text, new RegExp(`notice-error[^>]*>✕ ${CHANGED.replace(".", "\\.")}`));
  });
});

test("Seasons page: one Primary (Start new season), Reset is Danger, 80-char inputs", async () => {
  seed((d) => {
    d.seasons = [{ name: "S4", startedTs: 500, endedTs: 9000, sortedTotal: 2, byCategory: {} }];
  });
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const { text } = await w.page("/help/seasons");
    assert.equal(primaries(text), 1);
    assert.match(text, /class="btn btn-primary">Start new season</);
    assert.match(text, /class="btn btn-danger">Reset season</);
    assert.equal((text.match(/maxlength="80"/g) || []).length, 3);
  });
});

test("an officer demoted on Discord: within 60 s the POST is refused (403 page) and nothing is written", async () => {
  let t = Date.now();
  seed((d) => {
    d.entries = [entry("a", KOVI, "mvp5k")];
  });
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    await w.page("/help/seasons"); // level cached as officer
    const d = help.loadData();
    d.managerRoleIds = []; // the owner took the officer role away
    help.saveData(d);
    const before = readData();
    t += 60_000;
    const res = await w.post("/help/seasons/reset", { confirm: "yes", issued: String(t - 1000), guard: "0:-" });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /This page is for officers and owners\./);
    assert.equal(readData(), before);
  }, { now: () => t });
});

test("a cross-site POST (CSRF) to a dangerous action is refused before the handler: 403, nothing written", async () => {
  seed((d) => {
    d.entries = [entry("a", KOVI, "mvp5k")];
  });
  const before = readData();
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const res = await w.post("/help/seasons/reset", { confirm: "yes", issued: String(Date.now()), guard: "0:-" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    assert.equal(res.status, 403);
  });
  assert.equal(readData(), before);
});

// ---------- Categories (owner) ----------

test("categoriesModel: active with open counts and move targets; archived; the add/last-one limits", () => {
  const data = seed((d) => {
    d.categories.push({ id: "old", label: "Old", emoji: "🗄️", archived: true });
    d.entries = [entry("a", KOVI, "mvp5k"), entry("b", ZED, "mvp5k"), entry("c", KOVI, "mvp5k", { done: true })];
  });
  const m = helpWeb.categoriesModel(data);
  assert.deepEqual(
    m.active.map((c) => [c.id, c.open, c.moveOptions.map((o) => o.id)]),
    [
      ["seasonrun5k", 0, ["mvp5k"]],
      ["mvp5k", 2, ["seasonrun5k"]],
    ]
  );
  assert.deepEqual(m.archived, [{ id: "old", label: "Old", emoji: "🗄️" }]);
  assert.equal(m.canAdd, true);
  assert.equal(m.lastOne, false);
  assert.equal(m.maxLabel, 60);
  const full = helpWeb.categoriesModel(seed((d) => {
    d.categories = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, label: `C${i}`, emoji: "📌", archived: false }));
  }));
  assert.equal(full.canAdd, false);
});

test("Categories is owner-only: an officer gets no sidebar link, a 403 page by URL, and a 403 on POST (nothing written)", async () => {
  seed();
  const before = readData();
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const home = await w.page("/help");
    assert.doesNotMatch(home.text, />Categories</);
    const { res, text } = await w.page("/help/categories");
    assert.equal(res.status, 403);
    assert.match(text, /Only members with Manage Server can change bot settings\./);
    assert.equal((await w.post("/help/categories/add", { label: "Raid" })).status, 403);
    assert.equal((await w.post("/help/categories/archive", { categoryId: "mvp5k", moveto: "seasonrun5k", confirm: "yes", issued: String(Date.now()), guard: "x" })).status, 403);
  });
  assert.equal(readData(), before);
});

test("Categories: add (escaped on the page), refusals as one error line, an archived name comes back", async () => {
  seed((d) => {
    d.categories.push({ id: "raid", label: "Raid", emoji: "⚔️", archived: true });
  });
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const page = await w.page("/help/categories");
    assert.match(page.text, />Categories</);
    assert.equal(primaries(page.text), 1);
    const ok = await w.submit("/help/categories/add", { label: "Tower <3>", emoji: "<img>" });
    assert.match(ok.next.text, /✓ &lt;img&gt; Tower &lt;3&gt; is ready\./);
    assert.ok(help.loadData().categories.some((c) => c.id === "tower-3" && !c.archived));
    const blank = await w.submit("/help/categories/add", { label: "   ", emoji: "" });
    assert.match(blank.next.text, /Give the category a name with letters or numbers\./);
    const long = await w.submit("/help/categories/add", { label: "x".repeat(61) });
    assert.match(long.next.text, /60 characters or fewer/);
    const before = help.loadData().categories.length;
    const bidi = await w.submit("/help/categories/add", { label: `Tower${String.fromCodePoint(0x202e)}evil` });
    assert.match(bidi.next.text, /Use letters, numbers and punctuation only\./);
    assert.equal(help.loadData().categories.length, before, "nothing written");
    const back = await w.submit("/help/categories/add", { label: "raid", emoji: "" });
    assert.match(back.next.text, /✓ ⚔️ raid is ready\./);
    assert.equal(help.loadData().categories.find((c) => c.id === "raid").archived, false);
  });
});

test("Categories: archive without open requests — confirm, then archived", async () => {
  seed((d) => {
    d.categories.push({ id: "raid", label: "Raid", emoji: "⚔️", archived: false });
  });
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const ask = await w.post("/help/categories/archive", { categoryId: "raid" });
    assert.equal(ask.status, 200);
    const html = await ask.text();
    assert.match(html, /Archive Raid\?/);
    assert.match(html, /Members can&#39;t pick Raid anymore/);
    assert.equal(help.loadData().categories.find((c) => c.id === "raid").archived, false);
    const go = await w.submit("/help/categories/archive", confirmForm(html, { categoryId: "raid", moveto: "" }));
    assert.match(go.next.text, /✓ Archived Raid\./);
    assert.equal(help.loadData().categories.find((c) => c.id === "raid").archived, true);
  });
});

// F-M5: with 0 open requests a bogus moveto used to be accepted (and printed raw).
test("Categories: archive with no open requests refuses a moveto that is unknown, archived or the category itself — one red line, nothing written", async () => {
  seed((d) => {
    d.categories.push({ id: "raid", label: "Raid", emoji: "⚔️", archived: false }, { id: "old", label: "Old", emoji: "🗃️", archived: true });
  });
  const before = readData();
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    for (const moveto of ["bogus<id>", "old", "raid"]) {
      const r = await w.submit("/help/categories/archive", { categoryId: "raid", moveto });
      assert.equal(r.res.status, 303, moveto);
      assert.match(r.next.text, /notice-error/, moveto);
      assert.match(r.next.text, /must be (an active|a different) category/, moveto);
      assert.doesNotMatch(r.next.text, /Archive Raid\?/, `${moveto}: no confirmation page`);
    }
  });
  assert.equal(readData(), before);
});

test("Categories: archive with open requests — moveto required; moved and duplicate counts shown, then applied", async () => {
  seed((d) => {
    d.entries = [entry("a", KOVI, "mvp5k"), entry("b", ZED, "mvp5k"), entry("c", KOVI, "seasonrun5k")];
  });
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const none = await w.submit("/help/categories/archive", { categoryId: "mvp5k" });
    assert.match(none.next.text, /It still has open requests — pick a category to move them to\./);
    const ask = await w.post("/help/categories/archive", { categoryId: "mvp5k", moveto: "seasonrun5k" });
    const html = await ask.text();
    assert.match(html, /1 open request moves to Season Run 5K\./);
    assert.match(html, /1 request is already open in Season Run 5K for the same member — closed as removed\./);
    assert.match(html, /name="moveto" value="seasonrun5k"/);
    const go = await w.submit("/help/categories/archive", confirmForm(html, { categoryId: "mvp5k", moveto: "seasonrun5k" }));
    assert.match(go.next.text, /✓ Archived MVP 5K\. 1 open request moved to Season Run 5K\. 1 duplicate closed\./);
    const d = help.loadData();
    assert.deepEqual(d.entries.map((e) => [e.id, e.category]).sort(), [["b", "seasonrun5k"], ["c", "seasonrun5k"]]);
    assert.equal(d.records.filter((r) => r.resolution === "removed").length, 1);
    await w.settle();
  });
});

// M2b hardening, checked for web callers: a missing / repeated / empty
// categoryId never reaches an action as null or an array.
test("Categories: archive refusals — unknown, empty or repeated id, the last active one — nothing written", async () => {
  seed((d) => {
    d.categories = [{ id: "solo", label: "Solo", emoji: "📌", archived: false }, { id: "gone", label: "Gone", emoji: "📌", archived: true }];
  });
  const before = readData();
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const cases = [
      [{ categoryId: "nope" }, /No such category\./],
      [{ categoryId: "" }, /No such category\./],
      [[["categoryId", "solo"], ["categoryId", "gone"]], /No such category\./],
      [{ categoryId: "gone" }, /That category is already archived\./],
      [{ categoryId: "solo" }, /That&#39;s the only active category — add a replacement first\./],
    ];
    for (const [form, re] of cases) {
      const r = await w.submit("/help/categories/archive", form);
      assert.equal(r.res.status, 303, JSON.stringify(form));
      assert.match(r.next.text, re, JSON.stringify(form));
    }
  });
  assert.equal(readData(), before);
});

const changedRe = new RegExp(`notice-error[^>]*>✕ ${CHANGED.replace(".", "\\.")}`);

test("Categories: replaying the Archive confirm form is a no-op with the 'changed' notice (C1)", async () => {
  seed((d) => {
    d.entries = [entry("a", KOVI, "mvp5k"), entry("b", ZED, "mvp5k"), entry("c", KOVI, "seasonrun5k")];
  });
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const html = await (await w.post("/help/categories/archive", { categoryId: "mvp5k", moveto: "seasonrun5k" })).text();
    const form = confirmForm(html, { categoryId: "mvp5k", moveto: "seasonrun5k" });
    const first = await w.post("/help/categories/archive", form);
    assert.equal(first.status, 303);
    assert.equal(help.loadData().categories.find((c) => c.id === "mvp5k").archived, true);
    await w.settle();
    const after = readData();
    // Back button / second tab: the very same form, well inside the 5 minutes.
    const replay = await w.post("/help/categories/archive", form);
    assert.equal(replay.status, 303);
    assert.equal(replay.headers.get("location"), "/help/categories");
    assert.equal(readData(), after, "nothing was written the second time");
    const { text } = await w.page("/help/categories");
    assert.match(text, changedRe);
  });
});

test("Categories: the confirmed state moved on — a new open request, or the move-to target archived — writes nothing", async () => {
  seed((d) => {
    d.categories.push({ id: "raid", label: "Raid", emoji: "⚔️", archived: false });
    d.entries = [entry("a", KOVI, "mvp5k")];
  });
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const fields = { categoryId: "mvp5k", moveto: "seasonrun5k" };
    const form = confirmForm(await (await w.post("/help/categories/archive", fields)).text(), fields);
    // A second member asks for MVP 5K after the preview was shown.
    const d = help.loadData();
    d.entries.push(entry("b", ZED, "mvp5k"));
    help.saveData(d);
    let before = readData();
    let r = await w.post("/help/categories/archive", form);
    assert.equal(r.status, 303);
    assert.equal(readData(), before, "the preview counts were stale: nothing archived");
    assert.match((await w.page("/help/categories")).text, changedRe);

    // The target is archived between the preview and the click.
    const form2 = confirmForm(await (await w.post("/help/categories/archive", fields)).text(), fields);
    const d2 = help.loadData();
    d2.categories.find((c) => c.id === "seasonrun5k").archived = true;
    help.saveData(d2);
    before = readData();
    r = await w.post("/help/categories/archive", form2);
    assert.equal(r.status, 303);
    assert.equal(readData(), before);
    assert.match((await w.page("/help/categories")).text, changedRe);
  });
});

test("Categories: a duplicate that appears in the target after the preview invalidates the confirmation", async () => {
  seed((d) => {
    d.entries = [entry("a", KOVI, "mvp5k")];
  });
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const fields = { categoryId: "mvp5k", moveto: "seasonrun5k" };
    const html = await (await w.post("/help/categories/archive", fields)).text();
    assert.match(html, /1 open request moves to Season Run 5K\./);
    const d = help.loadData();
    d.entries.push(entry("c", KOVI, "seasonrun5k")); // same member now also waits in the target
    help.saveData(d);
    const before = readData();
    const r = await w.post("/help/categories/archive", confirmForm(html, fields));
    assert.equal(r.status, 303);
    assert.equal(readData(), before, "request 'a' would have been dropped, not moved, as the preview said");
    assert.match((await w.page("/help/categories")).text, changedRe);
  });
});

// ---------- Settings (owner) ----------

const PINGS = "200000000000000002";
const BOTROLE = "200000000000000003";
const GENERAL = "300000000000000001";
const VOICE = "300000000000000002";
const NEWS = "300000000000000003";

const settingsGuild = () =>
  fakeGuild({
    users: {
      [OFFICER]: { name: "Offi", roles: [MGR] },
      [OWNER]: { name: "Boss", owner: true },
      [KOVI]: { name: "Kovi" },
    },
    roles: [
      { id: MGR, name: "Officers", position: 5 },
      { id: PINGS, name: "Helpers <b>", position: 3 },
      { id: BOTROLE, name: "BB Bot", managed: true, position: 9 },
    ],
    channels: [
      { id: GENERAL, name: "general", type: 0 },
      { id: VOICE, name: "Lounge", type: 2 },
      { id: NEWS, name: "news", type: 5 },
    ],
  });

test("settingsModel: managers by name; @everyone and bot roles never offered; text/announcement channels only", () => {
  const data = seed((d) => {
    d.managerRoleIds = [MGR, "299999999999999999"];
    d.notifyRoleId = PINGS;
    d.nudgeChannelId = NEWS;
    d.nudgeThresholdHours = 24;
  });
  const m = helpWeb.settingsModel(settingsGuild(), data);
  assert.deepEqual(m.managers, [{ id: MGR, name: "Officers" }, { id: "299999999999999999", name: "(deleted role)" }]);
  assert.deepEqual(m.addable, [{ id: PINGS, name: "Helpers <b>" }]);
  assert.deepEqual(m.notifyOptions.map((r) => [r.id, r.selected]), [[MGR, false], [PINGS, true]]);
  assert.deepEqual(m.notify, { id: PINGS, name: "Helpers <b>" });
  assert.deepEqual(m.nudge.channels.map((c) => c.id), [GENERAL, NEWS]);
  assert.equal(m.nudge.channelName, "news");
  assert.equal(m.nudge.maxHours, 8760);
});

test("Settings is owner-only: officer → 403 page and 403 on every POST, nothing written", async () => {
  seed();
  const before = readData();
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const got = await w.page("/help/settings");
    assert.equal(got.res.status, 403);
    assert.ok(got.text.includes(NEED.owner), "the owner-only text");
    for (const [p, form] of [
      ["/help/settings/managers/add", { roleId: PINGS }],
      ["/help/settings/managers/remove", { roleId: MGR }],
      ["/help/settings/notify", { roleId: PINGS }],
      ["/help/settings/nudge", { channelId: GENERAL, hours: "5" }],
      ["/help/settings/nudge/off", {}],
    ]) {
      const r = await w.post(p, form);
      assert.equal(r.status, 403, p);
      assert.ok((await r.text()).includes(NEED.owner), p);
    }
  }, { guild: settingsGuild() });
  assert.equal(readData(), before);
});

test("Settings: add and remove a manager role — the officer's level changes on their very next request (cache dropped)", async () => {
  seed((d) => {
    d.managerRoleIds = [];
  });
  await withWeb(async (w) => {
    // Two signed-in people share the harness's one cookie jar: swap sessions.
    const sessions = {};
    for (const who of [OWNER, OFFICER]) {
      await w.signIn(who);
      sessions[who] = new Map(w.jar);
    }
    const as = async (who, fn) => {
      w.jar.clear();
      for (const [k, v] of sessions[who]) w.jar.set(k, v);
      try {
        return await fn();
      } finally {
        sessions[who] = new Map(w.jar);
      }
    };
    const officerStatus = () => as(OFFICER, async () => (await w.page("/help")).res.status);
    const owner = (fn) => as(OWNER, fn);

    // Holding the Officers role means nothing until it is a manager role (and
    // this lookup is now in the 60 s level cache as "member").
    assert.equal(await officerStatus(), 403);

    const page = await owner(() => w.page("/help/settings"));
    assert.equal(primaries(page.text), 1);
    assert.match(page.text, /Helpers &lt;b&gt;/);
    assert.doesNotMatch(page.text, /@everyone|BB Bot/);

    const add = await owner(() => w.submit("/help/settings/managers/add", { roleId: MGR }));
    assert.match(add.next.text, /✓ Officers is now a manager role\./);
    assert.deepEqual(help.loadData().managerRoleIds, [MGR]);
    assert.equal(await officerStatus(), 200, "no clock advance: the cached 'member' level was dropped");

    const again = await owner(() => w.submit("/help/settings/managers/add", { roleId: MGR }));
    assert.match(again.next.text, /Officers was already a manager role\./);
    assert.deepEqual(help.loadData().managerRoleIds, [MGR]);

    const rm = await owner(() => w.submit("/help/settings/managers/remove", { roleId: MGR }));
    assert.match(rm.next.text, /✓ Officers is no longer a manager role\./);
    assert.deepEqual(help.loadData().managerRoleIds, []);
    assert.equal(await officerStatus(), 403, "the officer was demoted on the very next request");

    const none = await owner(() => w.submit("/help/settings/managers/remove", { roleId: MGR }));
    assert.match(none.next.text, /Officers wasn&#39;t a manager role\./);
    assert.deepEqual(help.loadData().managerRoleIds, []);
  }, { guild: settingsGuild() });
});

// M2b hardening (`unassignable` fails closed), checked for web callers: the
// guild id always comes from the bot's guild, never from the form.
test("Settings: @everyone, a bot-managed role or an unknown role id are refused as manager / notify role — nothing written", async () => {
  seed((d) => {
    d.notifyRoleId = PINGS; // a wrongly accepted "off" would clear it
  });
  const before = readData();
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const cases = [
      ["/help/settings/managers/add", { roleId: GUILD_ID }, /You can&#39;t add @everyone or a bot-managed role as a manager role\./],
      ["/help/settings/managers/add", { roleId: BOTROLE }, /You can&#39;t add @everyone or a bot-managed role as a manager role\./],
      ["/help/settings/managers/add", { roleId: "299999999999999999" }, /That role doesn&#39;t exist anymore/],
      ["/help/settings/managers/add", [["roleId", MGR], ["roleId", PINGS]], /That role doesn&#39;t exist anymore/],
      ["/help/settings/notify", { roleId: GUILD_ID }, /You can&#39;t set @everyone or a bot-managed role as the notify role\./],
      ["/help/settings/notify", { roleId: BOTROLE }, /You can&#39;t set @everyone or a bot-managed role as the notify role\./],
      ["/help/settings/notify", { roleId: "299999999999999999" }, /That role doesn&#39;t exist anymore/],
      // A missing or repeated field reads as "" — never the Off choice.
      ["/help/settings/notify", {}, /That role doesn&#39;t exist anymore/],
      ["/help/settings/notify", [["roleId", PINGS], ["roleId", MGR]], /That role doesn&#39;t exist anymore/],
      ["/help/settings/managers/remove", {}, /That role doesn&#39;t exist anymore/],
      ["/help/settings/managers/remove", [["roleId", MGR], ["roleId", PINGS]], /That role doesn&#39;t exist anymore/],
    ];
    for (const [p, form, re] of cases) {
      const r = await w.submit(p, form);
      assert.match(r.next.text, re, `${p} ${JSON.stringify(form)}`);
    }
  }, { guild: settingsGuild() });
  assert.equal(readData(), before);
});

test("Settings: notify role on and off", async () => {
  seed();
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const on = await w.submit("/help/settings/notify", { roleId: PINGS });
    assert.match(on.next.text, /✓ New requests now ping Helpers &lt;b&gt;\./);
    assert.equal(help.loadData().notifyRoleId, PINGS);
    const off = await w.submit("/help/settings/notify", { roleId: "off" });
    assert.match(off.next.text, /✓ Request pings are off\./);
    assert.equal(help.loadData().notifyRoleId, null);
  }, { guild: settingsGuild() });
});

test("Settings: nudge on (text or announcement channel, whole hours 1–8760) and off; the threshold is kept", async () => {
  seed();
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const on = await w.submit("/help/settings/nudge", { channelId: NEWS, hours: "24" });
    assert.match(on.next.text, /✓ Stale nudges on — a daily digest in #news for requests waiting over 24h\./);
    let d = help.loadData();
    assert.equal(d.nudgeChannelId, NEWS);
    assert.equal(d.nudgeThresholdHours, 24);
    const off = await w.submit("/help/settings/nudge/off", {});
    assert.match(off.next.text, /✓ Stale nudges off\./);
    d = help.loadData();
    assert.equal(d.nudgeChannelId, null);
    assert.equal(d.nudgeThresholdHours, 24);
  }, { guild: settingsGuild() });
});

test("Settings: nudge refusals — a voice / unknown channel, 0, 8761, 1.5, text hours — nothing written", async () => {
  seed();
  const before = readData();
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const cases = [
      [{ channelId: VOICE, hours: "5" }, /Pick a text channel from the list\./],
      [{ channelId: "399999999999999999", hours: "5" }, /Pick a text channel from the list\./],
      [{ channelId: GENERAL, hours: "0" }, /whole number of hours between 1 and 8760/],
      [{ channelId: GENERAL, hours: "8761" }, /whole number of hours between 1 and 8760/],
      [{ channelId: GENERAL, hours: "1.5" }, /whole number of hours between 1 and 8760/],
      [{ channelId: GENERAL, hours: "soon" }, /whole number of hours between 1 and 8760/],
      [{ channelId: GENERAL, hours: "" }, /whole number of hours between 1 and 8760/],
    ];
    for (const [form, re] of cases) {
      const r = await w.submit("/help/settings/nudge", form);
      assert.match(r.next.text, re, JSON.stringify(form));
    }
  }, { guild: settingsGuild() });
  assert.equal(readData(), before);
});

// A guild where the bot is a cached member: one channel Discord sends
// obfuscated (CHANNEL_OBFUSCATED, 1 << 17), one it denies View Channel on.
const SECRET = "300000000000000004";
const STAFF = "300000000000000005";
const hiddenGuild = () => {
  const g = settingsGuild();
  const me = { id: "BOT" };
  g.members.me = me;
  const canView = (ok) => (member) => ({ has: (flag) => member === me && flag === PermissionFlagsBits.ViewChannel && ok });
  for (const c of g.channels.cache.values()) c.permissionsFor = canView(true);
  g.channels.cache.set(SECRET, { id: SECRET, name: "___hidden___", type: 0, flags: { bitfield: 1 << 17 }, permissionsFor: canView(true) });
  g.channels.cache.set(STAFF, { id: STAFF, name: "staff", type: 0, flags: { bitfield: 0 }, permissionsFor: canView(false) });
  return g;
};

test("settingsModel: channels the bot cannot see (obfuscated, or no View Channel) are never offered or named", () => {
  const staff = helpWeb.settingsModel(hiddenGuild(), seed((d) => { d.nudgeChannelId = STAFF; }));
  assert.deepEqual(staff.nudge.channels.map((c) => c.id), [GENERAL, NEWS]);
  assert.equal(staff.nudge.channelName, "(hidden channel)");
  const secret = helpWeb.settingsModel(hiddenGuild(), seed((d) => { d.nudgeChannelId = SECRET; }));
  assert.equal(secret.nudge.channelName, "(hidden channel)");
  // A bare numeric flags field (not a BitField) is read the same way.
  const g = hiddenGuild();
  g.channels.cache.get(GENERAL).flags = 1 << 17;
  assert.deepEqual(helpWeb.settingsModel(g, seed()).nudge.channels.map((c) => c.id), [NEWS]);
});

test("Settings: nudge refuses a channel the bot cannot see — nothing written", async () => {
  seed();
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    for (const channelId of [SECRET, STAFF]) {
      const r = await w.submit("/help/settings/nudge", { channelId, hours: "5" });
      assert.match(r.next.text, /Pick a text channel from the list\./, channelId);
      assert.equal(help.loadData().nudgeChannelId, null);
    }
    const ok = await w.submit("/help/settings/nudge", { channelId: GENERAL, hours: "5" });
    assert.match(ok.next.text, /✓ Stale nudges on — a daily digest in #general/);
  }, { guild: hiddenGuild() });
});

test("an owner's sidebar: Overview, Seasons, Stats, Categories, Settings (M2 spec §6 order), then Teammates", async () => {
  seed();
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    const { text } = await w.page("/help");
    const sidebar = text.slice(text.indexOf('class="sidebar"'));
    assert.match(sidebar, /Help board[\s\S]*>Overview<[\s\S]*>Seasons<[\s\S]*>Stats<[\s\S]*>Categories<[\s\S]*>Settings<[\s\S]*Teammates[\s\S]*Coming soon/);
  }, { guild: settingsGuild() });
});

test("every help page: GET writes nothing and shows at most one Primary button", async () => {
  seed((d) => {
    d.entries = [entry("a", KOVI, "mvp5k")];
    d.seasons = [{ name: "S4", startedTs: 500, endedTs: 9000, sortedTotal: 1, byCategory: {} }];
  });
  const before = readData();
  await withWeb(async (w) => {
    await w.signIn(OWNER);
    for (const p of ["/help", "/help/seasons", "/help/stats", "/help/stats?view=9000", "/help/categories", "/help/settings"]) {
      const { res, text } = await w.page(p);
      assert.equal(res.status, 200, p);
      assert.ok(primaries(text) <= 1, p);
    }
  }, { guild: settingsGuild() });
  assert.equal(readData(), before);
});
