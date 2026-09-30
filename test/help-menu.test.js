"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bbhelpmenu-"));
process.env.DATA_DIR = TMP;
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
process.env.GUILD_ID = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ButtonStyle, ComponentType, MessageFlags, MessageFlagsBitField } = require("discord.js");
const help = require("../modules/help/help");
const helpMenu = require("../modules/help/menu");
const { loadModules } = require("../core/loader");
const { createCtxFor } = require("../core/runtime");
const { createPerms, managerRolesFrom } = require("../core/perms");
const { createMenuModule } = require("../core/menu");
const { screenErrors, walk } = require("../core/panel");

const quiet = { log() {}, warn() {}, error() {} };
const modules = loadModules(["help"]);
const perms = createPerms({ getManagerRoleIds: managerRolesFrom(modules) });
const ctxFor = createCtxFor({ client: null, dataDir: TMP, perms });
const ctx = { ...ctxFor(modules[0]), log: quiet };
const menu = createMenuModule({ modules, ctxFor, perms, log: quiet });

const MEMBER = { id: "u1", name: "Kovi" };
const OFFICER = { id: "o1", name: "Offi", roles: ["mgr"] };

function seed(mutate) {
  const d = help.emptyData();
  d.managerRoleIds = ["mgr"];
  if (mutate) mutate(d);
  help.saveData(d);
}
function entry(id, userId, category, extra = {}) {
  return { id, userId, username: userId === "u1" ? "Kovi" : "Zed", category, note: "", done: false, ts: 1000, ...extra };
}

// A tap on the ephemeral menu message (onMenu: false = a tap on a public message).
function tap(customId, who = MEMBER, { kind = "button", values = [], fields = {}, onMenu = true, channel = null } = {}) {
  const calls = [];
  const i = {
    customId,
    values,
    calls,
    deferred: false,
    replied: false,
    user: { id: who.id, username: who.name },
    member: { displayName: who.name, roles: { cache: new Map((who.roles || []).map((r) => [r, true])) } },
    memberPermissions: { has: () => !!who.manageGuild },
    message: { flags: new MessageFlagsBitField(onMenu ? MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 : 0) },
    guild: null,
    channelId: "c1",
    channel,
    fields: { getTextInputValue: (n) => fields[n] ?? "" },
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isRepliable: () => true,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "string",
    isUserSelectMenu: () => kind === "user",
    isModalSubmit: () => kind === "modal",
    deferUpdate: async () => { i.deferred = true; calls.push(["deferUpdate"]); },
    reply: async (p) => { i.replied = true; calls.push(["reply", p]); },
    update: async (p) => { i.replied = true; calls.push(["update", p]); },
    editReply: async (p) => calls.push(["editReply", p]),
    showModal: async (m) => calls.push(["showModal", m]),
  };
  return i;
}
async function run(i) {
  await menu.handle(i);
  return i.calls.filter(([k]) => k !== "deferUpdate").at(-1);
}
function textOf(payload) {
  const out = [];
  walk(payload, (c) => { if (c.type === ComponentType.TextDisplay) out.push(c.content); });
  return out.join("\n");
}
function idsOf(payload) {
  const out = [];
  walk(payload, (c) => { if (c.custom_id) out.push(c.custom_id); });
  return out;
}
const viewerOf = (who) => ({ userId: who.id, level: perms.levelOfInteraction(tap("x", who)) });
async function direct(screen, who, opts = {}, arg = "") {
  return helpMenu.render(tap(`menu:help:${screen}`, who, opts), ctx, viewerOf(who), screen, arg);
}
function assertValid(screen, what) {
  assert.deepEqual(screenErrors(screen), [], what);
}

// A slash-command fake for the parity test (the same data through help.dispatch).
function slash(commandName, opts, who) {
  const calls = [];
  const i = {
    commandName,
    calls,
    deferred: false,
    replied: false,
    channelId: "c1",
    channel: null,
    guildId: "g1",
    guild: null,
    user: { id: who.id, username: who.name },
    member: { displayName: who.name, roles: { cache: new Map((who.roles || []).map((r) => [r, true])) } },
    memberPermissions: { has: () => !!who.manageGuild },
    options: { getString: (n) => opts[n] ?? null, getUser: (n) => opts[n] ?? null, getMember: () => null },
    isAutocomplete: () => false,
    isButton: () => false,
    isRoleSelectMenu: () => false,
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => true,
    reply: async (p) => { i.replied = true; calls.push(["reply", p]); },
    editReply: async (p) => calls.push(["editReply", p]),
    followUp: async (p) => calls.push(["followUp", p]),
  };
  return i;
}
// What an action wrote, minus ids and clocks.
function snapshot() {
  const d = help.loadData();
  const strip = ({ id, ts, doneTs, reqId, requestedTs, resolvedTs, ...rest }) => rest;
  return { entries: d.entries.map(strip), records: d.records.map(strip) };
}
// Exactly MAX_LABEL (60) characters each.
const LONG_CATEGORIES = () =>
  Array.from({ length: 25 }, (_, n) => ({ id: `c${n}`, label: `${"C".repeat(57)}${String(n).padStart(3, "0")}`, emoji: "📌", archived: false }));

test("section: 'Help board' with the live open count", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k"), entry("e2", "u2", "mvp5k", { done: true })); });
  assert.deepEqual(helpMenu.section(ctx, viewerOf(MEMBER)), { label: "Help board", counter: "1 open" });
});

test("guide: today's /help text as V2 markdown", () => {
  const g = helpMenu.guide();
  assert.match(g, /^### 🛡️ Guild Help Board — how it works/);
  assert.match(g, /\*\*🟢 Everyone\*\*/);
  assert.ok(g.length < 4000);
});

test("/menu lists the Help board with its counter", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  const i = tap(undefined, MEMBER);
  i.isChatInputCommand = () => true;
  const [kind, p] = await run(i);
  assert.equal(kind, "reply");
  assert.match(textOf(p), /\*\*Help board\*\* · 1 open/);
  assert.deepEqual(idsOf(p), ["menu:help:main", "menu:home:how"]);
});

test("How it works shows the help guide", async () => {
  seed();
  const [, p] = await run(tap("menu:home:how", MEMBER));
  assert.ok(textOf(p).includes("Guild Help Board — how it works"));
});

test("main: member row with one Primary, Back to home, valid", async () => {
  seed();
  assertValid(await direct("main", MEMBER), "main/member");
  const [kind, p] = await run(tap("menu:help:main", MEMBER));
  assert.equal(kind, "update");
  assert.deepEqual(idsOf(p), ["menu:help:needhelp", "menu:help:sorted", "menu:help:stats", "menu:home"]);
  assert.match(textOf(p), /^\*\*Menu › Help board\*\*\nSeason: \(unnamed\) · 0 open · Member/);
});

test("an unknown Help board screen falls back to the home screen", async () => {
  seed();
  const [, p] = await run(tap("menu:help:nosuchscreen", MEMBER));
  assert.ok(textOf(p).includes("⚠️ That screen isn't available anymore. Here's the menu."));
});

test("need help is tap-first: pick a category → posted, back on the Help board with Add note", async () => {
  seed();
  const [, picker] = await run(tap("menu:help:needhelp", MEMBER));
  assert.deepEqual(idsOf(picker), ["menu:help:needhelp", "menu:help:main"]);
  assertValid(await direct("needhelp", MEMBER), "needhelp picker");
  const [kind, p] = await run(tap("menu:help:needhelp", MEMBER, { kind: "string", values: ["mvp5k"] }));
  assert.equal(kind, "update");
  const [e] = help.loadData().entries;
  assert.deepEqual([e.userId, e.username, e.category], ["u1", "Kovi", "mvp5k"]);
  assert.ok(textOf(p).includes("✅ Request posted: ⭐ MVP 5K"));
  assert.ok(idsOf(p).includes(`menu:help:note:${e.id}`));
});

test("need help: the same category twice → one line, no second entry", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  const [, p] = await run(tap("menu:help:needhelp", MEMBER, { kind: "string", values: ["mvp5k"] }));
  assert.ok(textOf(p).includes("⚠️ You're already on the board for MVP 5K."));
  assert.equal(help.loadData().entries.length, 1);
});

test("add note: the modal pre-checks the request; saving writes the note", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  const open = tap("menu:help:note:e1", MEMBER);
  await menu.handle(open);
  assert.equal(open.calls.length, 1);
  assert.equal(open.calls[0][0], "showModal");
  const modal = open.calls[0][1].toJSON();
  assert.equal(modal.custom_id, "menu:help:notesave:e1");
  assert.equal(modal.components[0].component.custom_id, "note");
  const [kind, p] = await run(tap("menu:help:notesave:e1", MEMBER, { kind: "modal", fields: { note: "3 hammers" } }));
  assert.equal(kind, "update");
  assert.ok(textOf(p).includes("✅ Note added."));
  assert.equal(help.loadData().entries[0].note, "3 hammers");
});

test("add note: an older over-long /needhelp note is not prefilled (Discord would reject the modal)", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k", { note: "x".repeat(250) })); });
  const s = await direct("note", MEMBER, {}, "e1");
  assert.equal(s.modal.toJSON().components[0].component.value, undefined);
});

test("Review focus: a stale screen — note on a closed/foreign request, a category archived meanwhile — one line + a fresh screen, no write", async () => {
  seed((d) => { d.entries.push(entry("e2", "u2", "mvp5k")); d.categories[0].archived = true; });
  const [, foreign] = await run(tap("menu:help:note:e2", MEMBER));
  assert.ok(textOf(foreign).includes("⚠️ That request was already closed."));
  const [, late] = await run(tap("menu:help:notesave:e2", MEMBER, { kind: "modal", fields: { note: "hijack" } }));
  assert.ok(textOf(late).includes("⚠️ That request was already closed."));
  assert.equal(help.loadData().entries[0].note, "");
  const [, archived] = await run(tap("menu:help:needhelp", MEMBER, { kind: "string", values: ["seasonrun5k"] }));
  assert.ok(textOf(archived).includes("⚠️ That category isn't available anymore. Here's the current list."));
  assert.ok(idsOf(archived).includes("menu:help:needhelp"));
  assert.equal(help.loadData().entries.length, 1);
});

test("Review focus: note on a request that was closed meanwhile — one line + the Help board, nothing written", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k", { done: true })); });
  const open = tap("menu:help:note:e1", MEMBER);
  await menu.handle(open);
  assert.equal(open.calls.at(-1)[0], "update"); // no modal for a closed request
  assert.ok(textOf(open.calls.at(-1)[1]).includes("⚠️ That request was already closed."));
  const [, late] = await run(tap("menu:help:notesave:e1", MEMBER, { kind: "modal", fields: { note: "too late" } }));
  assert.ok(textOf(late).includes("⚠️ That request was already closed."));
  assert.equal(help.loadData().entries[0].note, "");
});

test("need help with every category archived → one line on the Help board", async () => {
  seed((d) => { for (const c of d.categories) c.archived = true; });
  const [, p] = await run(tap("menu:help:needhelp", MEMBER));
  assert.ok(textOf(p).includes("⚠️ No categories are set up yet — ask an admin."));
});

test("a saved request always gets its effects, even when the screen cannot be built", async () => {
  seed();
  const real = help.seasonLabel;
  help.seasonLabel = () => { throw new Error("boom"); };
  let out;
  try {
    out = await direct("needhelp", MEMBER, { kind: "string", values: ["mvp5k"] });
  } finally {
    help.seasonLabel = real;
  }
  assert.equal(help.loadData().entries.length, 1, "the request was saved");
  assert.equal(typeof out.after, "function", "the effects survive the build failure");
  assertValid(out, "the fallback screen");
  assert.ok(textOf(require("../core/panel").buildScreenPayload(out)).includes("✅ Request posted: ⭐ MVP 5K"));
});

test("the core runs `after` for a posted request (effects reach the card/board code)", async () => {
  seed();
  const i = tap("menu:help:needhelp", MEMBER, { kind: "string", values: ["mvp5k"] });
  let ran = 0;
  const orig = help.announceEntry;
  help.announceEntry = async () => { ran += 1; };
  try {
    await menu.handle(i);
  } finally {
    help.announceEntry = orig;
  }
  assert.equal(ran, 1);
});

test("Review focus: 25 active 60-character categories, long archived seasons, 5000 records and an 80-character season name still fit", async () => {
  seed((d) => {
    d.categories = LONG_CATEGORIES();
    d.currentSeason = { name: "S".repeat(80), startedTs: 1 };
    d.seasons = Array.from({ length: 12 }, (_, n) => ({ name: `Old season ${n} ${"L".repeat(60)}`, startedTs: n, endedTs: n + 1 }));
    d.records = Array.from({ length: 5000 }, (_, n) => ({ reqId: `r${n}`, userId: "u9", category: `c${n % 25}`, ts: n }));
  });
  assert.equal(help.loadData().categories[0].label.length, 60);
  assertValid(await direct("needhelp", MEMBER), "needhelp/25");
  assertValid(await direct("main", MEMBER), "main/long season");
  const [, p] = await run(tap("menu:help:needhelp", MEMBER, { kind: "string", values: ["c24"] }));
  assert.ok(textOf(p).includes("✅ Request posted:"));
  const after = await direct("needhelp", MEMBER, { kind: "string", values: ["c3"] });
  assertValid(after, "main after posting / Add note");
});

test("parity: /needhelp and Menu › Need help write the same entry", async () => {
  seed();
  await help.dispatch(slash("needhelp", { category: "mvp5k" }, MEMBER));
  const viaSlash = snapshot();
  seed();
  await run(tap("menu:help:needhelp", MEMBER, { kind: "string", values: ["mvp5k"] }));
  assert.deepEqual(snapshot(), viaSlash);
  assert.equal(viaSlash.entries.length, 1);
});

test("I'm sorted: nothing open → one line on the Help board", async () => {
  seed();
  const [, p] = await run(tap("menu:help:sorted", MEMBER));
  assert.ok(textOf(p).includes("⚠️ You have no open requests."));
});

test("I'm sorted: exactly one open request closes right away", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  const [, p] = await run(tap("menu:help:sorted", MEMBER));
  assert.ok(textOf(p).includes("✅ Marked 1 request sorted."));
  const d = help.loadData();
  assert.deepEqual(d.entries, []);
  assert.equal(d.records[0].resolution, "self");
});

test("I'm sorted: several → multi-select + Close all; the select closes only the picked own ones", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k"), entry("e3", "u1", "seasonrun5k"), entry("e2", "u2", "mvp5k")); });
  assertValid(await direct("sorted", MEMBER), "sorted picker");
  const [, p] = await run(tap("menu:help:sorted", MEMBER));
  assert.deepEqual(idsOf(p), ["menu:help:sorted", "menu:help:closeall", "menu:help:main"]);
  const [, done] = await run(tap("menu:help:sorted", MEMBER, { kind: "string", values: ["e1", "e2"] }));
  assert.ok(textOf(done).includes("✅ Marked 1 request sorted."));
  assert.deepEqual(help.loadData().entries.map((e) => e.id), ["e3", "e2"]);
});

test("I'm sorted: a pick whose requests were all closed meanwhile → one line, nothing logged", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k", { done: true }), entry("e3", "u1", "seasonrun5k")); });
  const [, p] = await run(tap("menu:help:sorted", MEMBER, { kind: "string", values: ["e1"] }));
  assert.ok(textOf(p).includes("⚠️ Those requests were already closed."));
  assert.equal(help.loadData().records.length, 0);
});

test("Close all asks first (Danger + Cancel); an expired confirmation is re-issued, not executed", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k"), entry("e3", "u1", "seasonrun5k")); });
  assertValid(await direct("closeall", MEMBER), "closeall confirm");
  const [, c] = await run(tap("menu:help:closeall", MEMBER));
  const [okId, cancelId] = idsOf(c);
  assert.match(okId, /^menu:help:closeallok:\d+$/);
  assert.equal(cancelId, "menu:help:main", "Cancel must never be a screen that can mutate");
  assert.equal(idsOf(c).length, 2, "no separate Back row: Cancel is the way back");
  let style;
  walk(c, (x) => { if (x.custom_id === okId) style = x.style; });
  assert.equal(style, ButtonStyle.Danger);
  const old = Date.now() - help.RESET_CONFIRM_TTL_MS - 1000;
  const [, stale] = await run(tap(`menu:help:closeallok:${old}`, MEMBER));
  assert.ok(textOf(stale).includes("⚠️ That confirmation expired — check and confirm again."));
  assert.match(idsOf(stale)[0], /^menu:help:closeallok:\d+$/, "a fresh confirmation was issued");
  assert.equal(help.loadData().entries.length, 2);
  assert.equal(help.loadData().records.length, 0);
});

test("Close all: a confirmation without a timestamp is treated as expired", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k"), entry("e3", "u1", "seasonrun5k")); });
  const [, p] = await run(tap("menu:help:closeallok:", MEMBER));
  assert.ok(textOf(p).includes("⚠️ That confirmation expired — check and confirm again."));
  assert.equal(help.loadData().entries.length, 2);
});

test("Close all: Cancel never mutates — one open request, open the confirmation, press Cancel → still open, nothing written", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  const before = help.loadData();
  const [, c] = await run(tap("menu:help:closeall", MEMBER));
  assert.ok(textOf(c).includes("Close your open request?"));
  const cancelId = idsOf(c).at(-1);
  const [, back] = await run(tap(cancelId, MEMBER));
  assert.ok(textOf(back).startsWith("**Menu › Help board**"));
  assert.ok(!textOf(back).includes("Marked"));
  assert.deepEqual(help.loadData(), before);
  assert.equal(help.loadData().entries.length, 1);
  assert.equal(help.loadData().entries[0].done, false);
  assert.equal(help.loadData().records.length, 0);
});

test("Close all confirmed: closes every own open request, never someone else's", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k"), entry("e3", "u1", "seasonrun5k"), entry("e2", "u2", "mvp5k")); });
  const [, p] = await run(tap(`menu:help:closeallok:${Date.now()}`, MEMBER));
  assert.ok(textOf(p).includes("✅ Marked 2 requests sorted."));
  assert.deepEqual(help.loadData().entries.map((e) => e.id), ["e2"]);
});

test("Close all with nothing open → one line on the Help board", async () => {
  seed();
  const [, p] = await run(tap("menu:help:closeall", MEMBER));
  assert.ok(textOf(p).includes("⚠️ You have no open requests."));
});

test("Review focus: a double tap on Close all → the second tap closes nothing and logs nothing", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k"), entry("e3", "u1", "seasonrun5k")); });
  const id = `menu:help:closeallok:${Date.now()}`;
  const [, first] = await run(tap(id, MEMBER));
  const [, second] = await run(tap(id, MEMBER));
  assert.ok(textOf(first).includes("✅ Marked 2 requests sorted."));
  assert.ok(textOf(second).includes("⚠️ Those requests were already closed."));
  assert.equal(help.loadData().records.length, 2);
});

test("Stats: deferred; today's stats as V2 text; the view select and a member lookup that keeps the view", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k", { done: true, helpedBy: "o1", doneTs: 2000 })); });
  const i = tap("menu:help:stats", MEMBER);
  const [kind, p] = await run(i);
  assert.equal(i.calls[0][0], "deferUpdate");
  assert.equal(kind, "editReply");
  assert.match(textOf(p), /### 📊 \(unnamed\) — current season/);
  assert.deepEqual(idsOf(p), ["menu:help:stats", "menu:help:statsmember:current", "menu:help:main"]);
  const [, all] = await run(tap("menu:help:stats", MEMBER, { kind: "string", values: ["alltime"] }));
  assert.match(textOf(all), /### 🏆 All-time helper stats/);
  let picked;
  walk(all, (x) => { if (x.custom_id === "menu:help:stats") picked = x.options.find((o) => o.default).value; });
  assert.equal(picked, "alltime");
  const [, who] = await run(tap("menu:help:statsmember:alltime", MEMBER, { kind: "user", values: ["o1"] }));
  assert.match(textOf(who), /### 🙌 \(left the server\) — helper stats/);
  assert.ok(idsOf(who).includes("menu:help:statsmember:alltime"));
});

test("Stats: a season that is gone → one line + the current season", async () => {
  seed();
  const [, p] = await run(tap("menu:help:stats", MEMBER, { kind: "string", values: ["12345"] }));
  assert.ok(textOf(p).includes("⚠️ That season is gone. Showing the current season."));
  assert.match(textOf(p), /current season/);
});

test("Stats: a past season view works and keeps itself selected", async () => {
  seed((d) => { d.seasons = [{ name: "Old", startedTs: 1, endedTs: 99, sortedTotal: 2, byCategory: {} }]; });
  const [, p] = await run(tap("menu:help:stats", MEMBER, { kind: "string", values: ["99"] }));
  assert.match(textOf(p), /### 📅 Old/);
  let picked;
  walk(p, (x) => { if (x.custom_id === "menu:help:stats") picked = x.options.find((o) => o.default).value; });
  assert.equal(picked, "99");
});

test("Review focus: big data — 25 long categories, 12 long-named seasons, 5000 records, an 80-character season name — Stats stays inside the limits", async () => {
  seed((d) => {
    d.categories = LONG_CATEGORIES();
    d.currentSeason = { name: "S".repeat(80), startedTs: 1 };
    d.seasons = Array.from({ length: 12 }, (_, n) => ({ name: `${"Season ".repeat(11)}${n}`.slice(0, 80), startedTs: n * 10, endedTs: n * 10 + 5, sortedTotal: 3, byCategory: {} }));
    d.entries = Array.from({ length: 40 }, (_, n) => entry(`e${n}`, `h${n}`, `c${n % 25}`, { done: n % 2 === 0, helpedBy: `o${n % 15}`, doneTs: 5000 }));
    d.records = Array.from({ length: 5000 }, (_, n) => ({ reqId: `r${n}`, requesterId: `u${n % 50}`, category: `c${n % 25}`, resolution: "sorted", helperId: `o${n % 15}`, requestedTs: 1, resolvedTs: 2, seasonStartedTs: 5 }));
  });
  for (const values of [[], ["current"], ["alltime"], ["5"], ["115"]]) {
    const s = await direct("stats", MEMBER, values.length ? { kind: "string", values } : {});
    assertValid(s, `stats ${values.join(",") || "(button)"}`);
  }
  const member = await helpMenu.render(tap("menu:help:statsmember:alltime", MEMBER, { kind: "user", values: ["o1"] }), ctx, viewerOf(MEMBER), "statsmember", "alltime");
  assertValid(member, "statsmember");
  // and through the real engine: no invalid-screen fallback to the home screen
  const [, p] = await run(tap("menu:help:stats", MEMBER, { kind: "string", values: ["alltime"] }));
  assert.match(textOf(p), /All-time helper stats/);
});

test("parity: /imsorted <category> and Menu › I'm sorted close the same request the same way", async () => {
  const s = (d) => { d.entries.push(entry("e1", "u1", "mvp5k")); };
  seed(s);
  await help.dispatch(slash("imsorted", { category: "mvp5k" }, MEMBER));
  const viaSlash = snapshot();
  seed(s);
  await run(tap("menu:help:sorted", MEMBER));
  assert.deepEqual(snapshot(), viaSlash);
  assert.equal(viaSlash.records.length, 1);
});
