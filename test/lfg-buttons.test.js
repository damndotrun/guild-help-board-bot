"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bblfgbtn-"));
process.env.DATA_DIR = TMP;
process.env.GUILD_ID = "g1";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { ButtonStyle, ComponentType, MessageFlags } = require("discord.js");
const { loadModules } = require("../core/loader");
const { createRouter } = require("../core/router");
const { createCtxFor } = require("../core/runtime");
const { createPerms } = require("../core/perms");
const { createMenuModule } = require("../core/menu");
const { walk } = require("../core/panel");
const C = require("../modules/lfg/channel");
const store = require("../modules/lfg/store");
const lfgModule = require("../modules/lfg");
const { T0, MIN, dataWith, listing, request, fakeDiscord, tap } = require("./fixtures/lfg-fakes");

const quiet = { log() {}, warn() {}, error() {} };
const DANI = { id: "u1", name: "Dani" };
const MARCI = { id: "u2", name: "Marci" };
const ANN = { id: "u3", name: "Ann" };

let fake;
let ctx;
let route;
beforeEach(() => {
  C._reset();
  fake = fakeDiscord();
  for (const r of ["r-sup", "r-dps", "r-radar", "r-hack", "r-gm"]) fake.roles.set(r, { id: r, name: r.toUpperCase(), mentionable: true });
  const modules = loadModules(["lfg"]);
  const perms = createPerms({ getManagerRoleIds: () => [] });
  const ctxFor = createCtxFor({ client: fake.client, dataDir: fs.mkdtempSync(path.join(TMP, "case-")), perms });
  ctx = ctxFor(modules[0]);
  ctx.log = quiet;
  ctx.now = () => T0;
  route = createRouter({ modules: [...modules, createMenuModule({ modules, ctxFor, perms, log: quiet })], ctxFor, log: quiet });
});
const seedData = (mutate) => store.save(ctx, dataWith(mutate));
const last = (i) => i.calls.filter(([k]) => k !== "deferUpdate" && k !== "deferReply").at(-1);
const btnTap = (id, who, opts = {}) => tap(id, who, { guild: fake.guild, ...opts });
function buttonsOf(payload) {
  const out = [];
  walk(payload, (c) => { if (c.type === ComponentType.Button) out.push(c); });
  return out;
}

test("module contract: lfg.json, no slash command, the 30-second tick, a menu section, handler tables", () => {
  const [m] = loadModules(["help", "lfg"]).filter((x) => x.name === "lfg");
  assert.deepEqual([m.dataFile, m.commands, m.jobs.map((j) => [j.name, j.intervalMs])], ["lfg.json", [], [["tick", 30000]]]);
  assert.ok(m.menu && m.onReady);
  assert.deepEqual(Object.keys(lfgModule.components).sort(), ["accept", "badge", "cancel", "here", "join", "roles", "start", "withdraw", "withdrawall"]);
  assert.deepEqual(Object.keys(lfgModule.modals), ["modal"]);
});

test("every lfg: customId in the module source has a handler", () => {
  const dir = path.join(__dirname, "..", "modules", "lfg");
  const actions = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/["'`]lfg:([a-z]+)/g)) actions.add(m[1]);
  }
  const handled = new Set([...Object.keys(lfgModule.components), ...Object.keys(lfgModule.modals)]);
  assert.ok(actions.size >= 9, [...actions].join());
  for (const a of actions) assert.ok(handled.has(a), `lfg:${a} has no handler`);
});

test("Start my own search: the modal; or a one-line answer (not set up / own search with Cancel / busy)", async () => {
  let i = btnTap("lfg:start", DANI);
  await route(i);
  assert.match(last(i)[1].content, /isn't set up yet/);
  seedData((x) => {
    x.listings.push(listing("MINE", "u1"));
    x.listings.push(listing("G", "p9", { state: "started", joinerId: "u2", startedAt: T0 }));
  });
  i = btnTap("lfg:start", DANI);
  await route(i);
  const [kind, own] = last(i);
  assert.equal(kind, "reply");
  assert.equal(own.flags, MessageFlags.Ephemeral);
  assert.deepEqual(buttonsOf(own).map((b) => [b.custom_id, b.style]), [["lfg:cancel:MINE", ButtonStyle.Danger]]);
  i = btnTap("lfg:start", MARCI);
  await route(i);
  assert.match(last(i)[1].content, /in a game right now/);
  i = btnTap("lfg:start", ANN);
  await route(i);
  assert.equal(last(i)[0], "showModal");
});

test("modal submit: bad input → one ephemeral line, nothing saved; a good one → deferred, then the thread link", async () => {
  seedData();
  let i = btnTap("lfg:modal", DANI, { kind: "modal", fields: { lookingfor: ["basic/sup"], minutes: "2000", note: "" } });
  await route(i);
  assert.match(last(i)[1].content, /whole number of minutes/);
  assert.equal(store.load(ctx).listings.length, 0);
  i = btnTap("lfg:modal", DANI, { kind: "modal", fields: { lookingfor: ["basic/sup"], minutes: " 10 ", note: "gg" } });
  await route(i);
  assert.deepEqual(i.calls[0], ["deferReply", { flags: MessageFlags.Ephemeral }]);
  const [kind, payload] = last(i);
  assert.equal(kind, "editReply");
  const threadId = store.load(ctx).listings[0].threadId;
  assert.equal(payload.content, `Your search is live — your thread: <#${threadId}>`);
  assert.equal(store.load(ctx).listings[0].startAt, T0 + 10 * MIN);
});

test("Join: the ephemeral confirmation with Cancel request; a repeat tap shows the same place; news first", async () => {
  seedData((x) => {
    x.listings.push(listing("A", "u1", { posterName: "Dani" }));
    x.notices.u2 = [{ listingId: "Z", outcome: "expired", ts: T0, name: "Ann", label: "DDPS · HACK" }];
  });
  let i = btnTap("lfg:join:A", MARCI);
  await route(i);
  const [, p] = i.calls.find(([k]) => k === "reply");
  assert.equal(p.content, "📬 Ann's search expired · DDPS · HACK\nRequest sent to **Dani** — you're #1 in line. Updates come in your DMs.");
  assert.deepEqual(buttonsOf(p).map((b) => b.custom_id), ["lfg:withdraw:A"]);
  i = btnTap("lfg:join:A", MARCI);
  await route(i);
  assert.equal(last(i)[1].content, "You already asked to join **Dani**'s search — you're #1 in line.");
  i = btnTap("lfg:join:A", DANI);
  await route(i);
  assert.equal(last(i)[1].content, "That's your own search.");
  // From a DM card's Still open: no guild, no member — the user name is used.
  i = btnTap("lfg:join:A", ANN, { dm: true });
  await route(i);
  assert.match(last(i)[1].content, /^Request sent to \*\*Dani\*\* — you're #2 in line\./);
  assert.deepEqual(store.load(ctx).listings[0].requests.map((r) => r.userName), ["Marci", "Ann"]);
});

test("Accept: only the searcher (others get one line); the searcher's tap is acknowledged and the joiner added", async () => {
  seedData((x) => x.listings.push(listing("A", "u1", { requests: [request("u2", T0, { userName: "Marci" })] })));
  fake.textChannel("th-A", { members: { add: async (u) => fake.ops.push({ op: "threadAdd", userId: u }), remove: async () => {} } });
  let i = btnTap("lfg:accept:A:u2", ANN);
  await route(i);
  assert.equal(last(i)[1].content, "Only the searcher can do that.");
  i = btnTap("lfg:accept:A:u2", DANI);
  await route(i);
  assert.deepEqual(i.calls[0], ["deferUpdate"]);
  assert.ok(fake.ops.some((o) => o.op === "threadAdd" && o.userId === "u2"));
  i = btnTap("lfg:accept:A:u2", DANI);
  await route(i);
  assert.equal(last(i)[1].content, "That spot was already taken.");
});

test("I'm here: from the DM card or the thread; a second tap says so; only the two players", async () => {
  seedData((x) => x.listings.push(listing("A", "u1", {
    state: "confirming", joinerId: "u2", acceptedAt: T0,
    checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: null, at: {}, nags: {} },
    requests: [request("u2", T0, { status: "accepted" })],
  })));
  let i = btnTap("lfg:here:A", ANN);
  await route(i);
  assert.equal(last(i)[1].content, "Only the two players can confirm.");
  i = btnTap("lfg:here:A", MARCI, { dm: true });
  await route(i);
  assert.deepEqual(i.calls[0], ["deferUpdate"]);
  i = btnTap("lfg:here:A", MARCI, { dm: true });
  await route(i);
  assert.equal(last(i)[1].content, "You already tapped I'm here.");
  i = btnTap("lfg:here:A", DANI);
  await route(i);
  assert.equal(store.load(ctx).listings[0].state, "started");
});

test("Cancel request: replaces the ephemeral Join answer in place; on the DM card it only acknowledges", async () => {
  seedData((x) => {
    x.listings.push(listing("A", "p1", { requests: [request("u2")] }));
    x.listings.push(listing("B", "p2", { requests: [request("u2")] }));
    x.listings.push(listing("D", "p3", { requests: [request("u2"), request("u3")] }));
  });
  let i = btnTap("lfg:withdraw:A", MARCI, { ephemeral: true });
  await route(i);
  assert.deepEqual(last(i), ["update", { content: "Request cancelled.", components: [], allowedMentions: { parse: [] } }]);
  i = btnTap("lfg:withdraw:B", MARCI, { dm: true, v2: true });
  await route(i);
  assert.deepEqual(i.calls[0], ["deferUpdate"]);
  i = btnTap("lfg:withdrawall", MARCI, { dm: true, v2: true });
  await route(i);
  assert.deepEqual(store.load(ctx).listings.map((l) => l.requests.filter((r) => r.status === "pending").map((r) => r.userId)), [[], [], ["u3"]]);
  i = btnTap("lfg:withdrawall", MARCI, { dm: true, v2: true });
  await route(i);
  assert.equal(last(i)[1].content, "You have no open requests.");
});

test("Cancel search from the thread: an ephemeral line, the thread closed and locked", async () => {
  seedData((x) => x.listings.push(listing("A", "u1", { threadId: "th-A" })));
  fake.textChannel("th-A", { setLocked: async (v) => fake.ops.push({ op: "lock", locked: v }) });
  const i = btnTap("lfg:cancel:A", DANI);
  await route(i);
  assert.equal(i.calls[0][1].content, "Search cancelled.");
  assert.deepEqual(fake.ops.filter((o) => o.op === "lock"), [{ op: "lock", locked: true }]);
  assert.deepEqual(store.load(ctx).listings, []);
});

test("Pick your roles…: a toggle answered with the ephemeral V2 My roles screen; the panel is re-sent", async () => {
  seedData((x) => { x.config.layout = [{ type: "panel" }]; });
  await C.sync(ctx);
  const m = fake.member("u1", { roleIds: ["r-sup"] });
  const i = btnTap("lfg:roles:k3x9", DANI, { kind: "string", values: ["r-sup", "r-radar"], member: m });
  await route(i);
  assert.deepEqual(i.calls[0], ["deferReply", { flags: MessageFlags.Ephemeral }]);
  const [kind, payload] = last(i);
  assert.equal(kind, "editReply");
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  const header = payload.components[0].components[0].content;
  assert.match(header, /^\*\*Menu › Teammates › My roles\*\*/);
  assert.match(header, /✅ Added: R-RADAR · Removed: R-SUP/);
  assert.deepEqual([...m.roles.cache.keys()], ["r-radar"]);
  assert.ok(fake.ops.some((o) => o.op === "edit" && o.messageId === store.load(ctx).channel.messageIds[0]));
  const ids = [];
  walk(payload, (c) => { if (c.custom_id) ids.push(c.custom_id); });
  assert.ok(ids.every((id) => id.startsWith("menu:")), ids.join());
});

test("Pick your roles… with a stale member cache (Guilds intent only): the toggle uses the tap's roles; the screen shows the result", async () => {
  seedData((x) => { x.config.layout = [{ type: "panel" }]; });
  await C.sync(ctx);
  // The cache never moves after a REST change; the tap's member is fresh per interaction.
  const m = fake.member("u1", { roleIds: ["r-sup"], staleCache: true });
  const i = btnTap("lfg:roles:k3x9", DANI, { kind: "string", values: ["r-sup", "r-radar"], member: m });
  await route(i);
  assert.deepEqual(fake.ops.filter((o) => o.op === "roleAdd" || o.op === "roleRemove").map((o) => [o.op, o.roleId]), [["roleAdd", "r-radar"], ["roleRemove", "r-sup"]]);
  assert.deepEqual([...m.roles.cache.keys()], ["r-sup"], "the fake cache really did not move");
  const [kind, payload] = last(i);
  assert.equal(kind, "editReply");
  assert.match(payload.components[0].components[0].content, /✅ Added: R-RADAR · Removed: R-SUP/);
  const selectMenu = [];
  walk(payload, (c) => { if (c.type === ComponentType.StringSelect) selectMenu.push(c); });
  assert.equal(selectMenu.length, 1);
  const held = selectMenu[0].options.filter((o) => o.default).map((o) => o.value);
  assert.deepEqual(held, ["r-radar"], "the pre-selection is derived from the action result, not the stale cache");
  assert.ok(fake.ops.some((o) => o.op === "edit" && o.messageId === store.load(ctx).channel.messageIds[0]), "the panel was re-sent");
});

test("a failed acknowledgement never loses the effects (Join's reply / the modal's defer throw)", async () => {
  seedData((x) => x.listings.push(listing("A", "u1", { posterName: "Dani", threadId: "th-A" })));
  fake.textChannel("th-A");
  let i = btnTap("lfg:join:A", MARCI);
  i.reply = async () => { throw new Error("Unknown interaction"); };
  await route(i);
  assert.ok(fake.ops.some((o) => o.op === "send" && o.channelId === "th-A" && /wants to join/.test(o.payload.content)));
  assert.ok(fake.ops.some((o) => o.op === "dm" && o.channelId === "dm-u2"));
  i = btnTap("lfg:modal", ANN, { kind: "modal", fields: { lookingfor: ["basic/sup"], minutes: "", note: "" } });
  i.deferReply = async () => { throw new Error("Unknown interaction"); };
  await route(i);
  const mine = store.load(ctx).listings.find((l) => l.posterId === "u3");
  assert.ok(mine.threadId, "the thread was opened anyway");
  assert.ok(fake.ops.some((o) => o.op === "send" && o.channelId === "ch1" && /^<@&r-sup>/.test(o.payload.content || "")), "and the ping went out");
});

test("modal submit: the answer comes before the new-search DMs", async () => {
  seedData((x) => { x.prefs.u9 = { dm: true }; });
  fake.member("u9", { roleIds: ["r-sup"] });
  const i = btnTap("lfg:modal", DANI, { kind: "modal", fields: { lookingfor: ["basic/sup"], minutes: "", note: "" } });
  let dmsAtAnswer = null;
  i.editReply = async (p) => { dmsAtAnswer = fake.ops.filter((o) => o.op === "dm").length; i.calls.push(["editReply", p]); };
  await route(i);
  assert.equal(dmsAtAnswer, 0);
  assert.equal(fake.ops.filter((o) => o.op === "dm").length, 1);
});

test("onReady: seed → permission check → channel sync, in that order", async () => {
  const order = [];
  const seed = require("../modules/lfg/seed");
  const origSeed = seed.seedIfNeeded;
  const origCheck = seed.checkPermissions;
  const origSync = C.sync;
  seed.seedIfNeeded = async () => { order.push("seed"); };
  seed.checkPermissions = async () => { order.push("check"); };
  C.sync = async (_c, opts) => { order.push(["sync", opts]); };
  try {
    await lfgModule.onReady(ctx);
  } finally {
    seed.seedIfNeeded = origSeed;
    seed.checkPermissions = origCheck;
    C.sync = origSync;
  }
  assert.deepEqual(order, ["seed", "check", ["sync", { checkTail: true }]]);
});

test("Pick your roles…: a failed defer still changes the roles and re-sends the panel", async () => {
  seedData((x) => { x.config.layout = [{ type: "panel" }]; });
  await C.sync(ctx);
  const m = fake.member("u1", { roleIds: ["r-sup"] });
  const i = btnTap("lfg:roles:x", DANI, { kind: "string", values: ["r-sup", "r-radar"], member: m });
  i.deferReply = async () => { throw new Error("Unknown interaction"); };
  await route(i);
  assert.deepEqual(fake.ops.filter((o) => o.op === "roleAdd" || o.op === "roleRemove").map((o) => [o.op, o.roleId]), [["roleAdd", "r-radar"], ["roleRemove", "r-sup"]]);
  assert.ok(fake.ops.some((o) => o.op === "edit" && o.messageId === store.load(ctx).channel.messageIds[0]), "the panel was re-sent");
});

test("Pick your roles…: a screen that cannot be built still ends the deferred reply (plain fallback), and the panel is re-sent", async () => {
  seedData((x) => { x.config.layout = [{ type: "panel" }]; });
  await C.sync(ctx);
  const lfgMenu = require("../modules/lfg/menu");
  const orig = lfgMenu.rolesScreen;
  lfgMenu.rolesScreen = () => { throw new Error("boom"); };
  const m = fake.member("u1", { roleIds: [] });
  const i = btnTap("lfg:roles:x", DANI, { kind: "string", values: ["r-sup"], member: m });
  try {
    await route(i);
  } finally {
    lfgMenu.rolesScreen = orig;
  }
  const [kind, payload] = last(i);
  assert.equal(kind, "editReply");
  assert.match(payload.content, /Something went wrong showing your roles/);
  assert.equal(payload.flags, undefined);
  assert.ok(fake.ops.some((o) => o.op === "roleAdd" && o.roleId === "r-sup"), "the change itself went through");
  assert.ok(fake.ops.some((o) => o.op === "edit" && o.messageId === store.load(ctx).channel.messageIds[0]), "the panel was re-sent");
});

test("modal submit: the duplicate-search Cancel button uses the configured label", async () => {
  seedData((x) => {
    x.config.texts = { cancelMySearch: "Drop it" };
    x.listings.push(listing("MINE", "u1"));
  });
  const i = btnTap("lfg:modal", DANI, { kind: "modal", fields: { lookingfor: ["basic/sup"], minutes: "", note: "" } });
  await route(i);
  assert.deepEqual(buttonsOf(last(i)[1]).map((b) => [b.custom_id, b.label]), [["lfg:cancel:MINE", "Drop it"]]);
});

test("Start / modal: a member whose own search has started gets the busy answer, not a Cancel that would fail (B6)", async () => {
  seedData((x) => x.listings.push(listing("MINE", "u1", { state: "started", joinerId: "u2", startedAt: T0, requests: [request("u2", T0, { status: "accepted" })] })));
  let i = btnTap("lfg:start", DANI);
  await route(i);
  assert.match(last(i)[1].content, /in a game right now/);
  assert.deepEqual(buttonsOf(last(i)[1]), []);
  i = btnTap("lfg:modal", DANI, { kind: "modal", fields: { lookingfor: ["basic/sup"], minutes: "", note: "" } });
  await route(i);
  assert.match(last(i)[1].content, /in a game right now/);
  assert.deepEqual(buttonsOf(last(i)[1]), []);
});

test("I'm here after the deadline (no tick yet) is refused as not open; nothing is saved (B8)", async () => {
  seedData((x) => x.listings.push(listing("A", "u1", {
    state: "confirming", joinerId: "u2", acceptedAt: T0,
    checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: null, at: {}, nags: {} },
    requests: [request("u2", T0, { status: "accepted" })],
  })));
  ctx.now = () => T0 + 5 * MIN;
  const i = btnTap("lfg:here:A", MARCI, { dm: true });
  await route(i);
  assert.equal(last(i)[1].content, "That search isn't open anymore.");
  assert.deepEqual(store.load(ctx).listings[0].checkIn.at, {});
});

test("Join answers escape the searcher's name, masked links too (D1)", async () => {
  seedData((x) => x.listings.push(listing("A", "u1", { posterName: "[x](https://e.com)" })));
  let i = btnTap("lfg:join:A", MARCI);
  await route(i);
  assert.match(i.calls.find(([k]) => k === "reply")[1].content, /^Request sent to \*\*\\\[x\]\(https:\/\/e\.com\)\*\*/);
  i = btnTap("lfg:join:A", MARCI);
  await route(i);
  assert.match(last(i)[1].content, /^You already asked to join \*\*\\\[x\]\(https:\/\/e\.com\)\*\*/);
});
