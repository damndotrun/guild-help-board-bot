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
const { CHANGED } = require("../web/context");

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

test("Seasons: Reset season asks first, then clears the board (unnamed season)", async () => {
  seed((d) => {
    d.currentSeason = { name: "Old", startedTs: 1 };
    d.entries = [entry("a", KOVI, "mvp5k")];
  });
  await withWeb(async (w) => {
    await w.signIn(OFFICER);
    const html = await (await w.post("/help/seasons/reset", {})).text();
    assert.match(html, /1 request is still waiting/);
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
