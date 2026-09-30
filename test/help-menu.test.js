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
const { ComponentType, MessageFlags, MessageFlagsBitField } = require("discord.js");
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

test("the I'm sorted / Stats taps fall back to the home screen until task 8 fills them", async () => {
  seed();
  const [, p] = await run(tap("menu:help:sorted", MEMBER));
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
