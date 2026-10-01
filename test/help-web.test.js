"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bbhelpweb-"));
process.env.DATA_DIR = TMP;

const { test } = require("node:test");
const assert = require("node:assert/strict");
const help = require("../modules/help/help");
const helpWeb = require("../modules/help/web");
const { normalizeModule } = require("../core/loader");
const { startWeb, fakeGuild } = require("./fixtures/web-harness");

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
    for (const p of ["/help", "/help/stats", "/help/stats?view=alltime"]) {
      assert.equal((await w.page(p)).res.status, 200, p);
    }
  });
  assert.equal(readData(), before);
});
