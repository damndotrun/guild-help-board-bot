"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bbactions-"));
process.env.DATA_DIR = TMP;
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
process.env.GUILD_ID = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const help = require("../modules/help/help");
const actions = require("../modules/help/actions");

const CTX = { client: null }; // effects must survive without a Discord client
const MEMBER = { userId: "u1", displayName: "Kovi", level: "member" };
const OTHER = { userId: "u2", displayName: "Zed", level: "member" };
const OFFICER = { userId: "o1", displayName: "Offi", level: "officer" };
const OWNER = { userId: "w1", displayName: "Boss", level: "owner" };

function seed(mutate) {
  const d = help.emptyData();
  if (mutate) mutate(d);
  help.saveData(d);
}
function entry(id, userId, category, extra = {}) {
  return { id, userId, username: userId === "u1" ? "Kovi" : "Zed", category, note: "", done: false, ts: 1000, ...extra };
}

// A recording fake Discord client: every channel.send / message.edit lands in `log`.
function fakeClient() {
  const log = [];
  let nextId = 1;
  const client = {
    log,
    channels: {
      fetch: async (channelId) => ({
        id: channelId,
        guild: null,
        send: async (payload) => {
          const id = `m${nextId++}`;
          log.push({ op: "send", channelId, messageId: id, payload });
          return { id };
        },
        messages: {
          fetch: async (messageId) => ({
            edit: async (payload) => { log.push({ op: "edit", channelId, messageId, payload }); },
          }),
        },
      }),
    },
  };
  return client;
}

// Minimal discord.js interaction fakes for driving help.dispatch().
function base(kind, u, rights = {}, extra = {}) {
  const calls = [];
  const i = {
    calls,
    deferred: false,
    replied: false,
    channelId: null,
    channel: null,
    guildId: "g1",
    guild: { id: "g1", roles: { cache: new Map() } },
    user: { id: u.userId, username: u.displayName },
    member: { displayName: u.displayName, roles: { cache: new Map((rights.roles || []).map((r) => [r, true])) } },
    memberPermissions: { has: () => !!rights.manageGuild },
    isAutocomplete: () => false,
    isButton: () => kind === "button",
    isRoleSelectMenu: () => kind === "role",
    isStringSelectMenu: () => kind === "string",
    isUserSelectMenu: () => kind === "user",
    isModalSubmit: () => kind === "modal",
    isChatInputCommand: () => kind === "command",
    isFromMessage: () => kind === "modal",
    reply: async (p) => { i.replied = true; calls.push(["reply", p]); },
    editReply: async (p) => calls.push(["editReply", p]),
    followUp: async (p) => calls.push(["followUp", p]),
    update: async (p) => { i.replied = true; calls.push(["update", p]); },
    deferReply: async () => { i.deferred = true; calls.push(["deferReply"]); },
    deferUpdate: async () => { i.deferred = true; calls.push(["deferUpdate"]); },
    showModal: async (m) => calls.push(["showModal", m]),
    ...extra,
  };
  return i;
}
function slash(commandName, opts, u, rights) {
  return base("command", u, rights, {
    commandName,
    options: {
      getString: (n) => opts[n] ?? null,
      getUser: (n) => opts[n] ?? null,
      getMember: () => null,
      getRole: (n) => opts[n] ?? null,
      getInteger: (n) => opts[n] ?? null,
      getChannel: (n) => opts[n] ?? null,
      getSubcommand: () => opts.sub ?? null,
      getSubcommandGroup: () => opts.group ?? null,
    },
  });
}
function component(kind, customId, u, { values = [], rights, fields = {} } = {}) {
  return base(kind, u, rights, { customId, values, fields: { getTextInputValue: (n) => fields[n] ?? "" } });
}
function contentOf(i) {
  const last = i.calls.filter(([k]) => k !== "deferReply" && k !== "deferUpdate").at(-1);
  return typeof last[1] === "string" ? last[1] : last[1].content;
}

test("needHelp: creates the actor's open entry and returns the category", () => {
  seed();
  const r = actions.needHelp(CTX, MEMBER, { categoryId: "mvp5k", note: "3 hammers" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.category, { label: "MVP 5K", emoji: "⭐" });
  const [e] = help.loadData().entries;
  assert.deepEqual({ ...e, id: "x", ts: 0 }, { id: "x", userId: "u1", username: "Kovi", category: "mvp5k", note: "3 hammers", done: false, ts: 0 });
  assert.equal(r.entry.id, e.id);
  assert.equal(typeof r.effects, "function");
});

test("needHelp: archived / unknown category → invalid, nothing saved", () => {
  seed((d) => { d.categories[1].archived = true; });
  for (const categoryId of ["mvp5k", "nope", undefined]) {
    const r = actions.needHelp(CTX, MEMBER, { categoryId });
    assert.deepEqual([r.ok, r.code], [false, "invalid"], String(categoryId));
  }
  assert.deepEqual(help.loadData().entries, []);
});

test("needHelp: a second open request in the same category → duplicate", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  const r = actions.needHelp(CTX, MEMBER, { categoryId: "mvp5k" });
  assert.deepEqual([r.ok, r.code, r.error], [false, "duplicate", "You're already on the board for MVP 5K."]);
  assert.equal(help.loadData().entries.length, 1);
});

test("member actions refuse an actor without a known level", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  const ghost = { userId: "u1", displayName: "Kovi", level: "guest" };
  for (const r of [
    actions.needHelp(CTX, ghost, { categoryId: "seasonrun5k" }),
    actions.sorted(CTX, ghost, { entryIds: ["e1"] }),
    actions.closeAll(CTX, ghost),
    actions.setNote(CTX, ghost, { entryId: "e1", note: "x" }),
    actions.needHelp(CTX, null, { categoryId: "seasonrun5k" }),
  ]) assert.equal(r.code, "forbidden");
  assert.equal(help.loadData().entries.length, 1);
});

test("member actions accept every known level", () => {
  seed();
  for (const [actor, categoryId] of [[OFFICER, "mvp5k"], [OWNER, "seasonrun5k"]]) {
    assert.equal(actions.needHelp(CTX, actor, { categoryId }).ok, true, actor.level);
  }
  assert.deepEqual(help.loadData().entries.map((e) => e.userId), ["o1", "w1"]);
});

test("sorted: closes only the actor's own open entries and logs self records", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k"), entry("e2", "u2", "mvp5k"), entry("e3", "u1", "seasonrun5k")); });
  const r = actions.sorted(CTX, MEMBER, { entryIds: ["e1", "e2"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.closed.map((e) => e.id), ["e1"]);
  const d = help.loadData();
  assert.deepEqual(d.entries.map((e) => e.id), ["e2", "e3"]);
  assert.deepEqual(d.records.map((x) => [x.reqId, x.resolution, x.requesterId]), [["e1", "self", "u1"]]);
});

test("sorted: by category; unknown category → invalid; nothing open → not_found", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  assert.equal(actions.sorted(CTX, MEMBER, { categoryId: "nope" }).code, "invalid");
  assert.equal(actions.sorted(CTX, MEMBER, { categoryId: "seasonrun5k" }).code, "not_found");
  assert.equal(actions.sorted(CTX, OTHER, { entryIds: ["e1"] }).code, "not_found");
  assert.deepEqual(actions.sorted(CTX, MEMBER, { categoryId: "mvp5k" }).closed.map((e) => e.id), ["e1"]);
  assert.deepEqual(help.loadData().entries, []);
});

test("closeAll: every open entry of the actor; a second call → not_found, no extra records", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k"), entry("e3", "u1", "seasonrun5k"), entry("e2", "u2", "mvp5k")); });
  assert.deepEqual(actions.closeAll(CTX, MEMBER).closed.map((e) => e.id), ["e1", "e3"]);
  assert.equal(actions.closeAll(CTX, MEMBER).code, "not_found");
  const d = help.loadData();
  assert.deepEqual(d.entries.map((e) => e.id), ["e2"]);
  assert.equal(d.records.length, 2);
});

test("setNote: own open entry only; trimmed; at most 200 characters", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k"), entry("e2", "u2", "mvp5k"), entry("e4", "u1", "seasonrun5k", { done: true })); });
  assert.equal(actions.setNote(CTX, MEMBER, { entryId: "e1", note: "  3 hammers  " }).ok, true);
  assert.equal(actions.setNote(CTX, MEMBER, { entryId: "e2", note: "x" }).code, "not_found");
  assert.equal(actions.setNote(CTX, MEMBER, { entryId: "e4", note: "x" }).code, "not_found");
  assert.equal(actions.setNote(CTX, MEMBER, { entryId: "e1", note: "x".repeat(201) }).code, "invalid");
  const d = help.loadData();
  assert.equal(d.entries.find((e) => e.id === "e1").note, "3 hammers");
  assert.equal(d.entries.find((e) => e.id === "e2").note, "");
});

test("member effects run to completion without a Discord client", async () => {
  seed();
  const a = actions.needHelp(CTX, MEMBER, { categoryId: "mvp5k" });
  await a.effects();
  await actions.setNote(CTX, MEMBER, { entryId: a.entry.id, note: "hi" }).effects();
  await actions.closeAll(CTX, MEMBER).effects();
  assert.deepEqual(help.loadData().entries, []);
});

test("needHelp effects post the request card to the given channel and persist its ids", async () => {
  seed();
  const client = fakeClient();
  const r = actions.needHelp({ client }, MEMBER, { categoryId: "mvp5k", note: "pls", channelId: "c9" });
  assert.deepEqual(client.log, [], "no REST before effects() is called");
  await r.effects();
  assert.equal(client.log.length, 1);
  const [post] = client.log;
  assert.deepEqual([post.op, post.channelId], ["send", "c9"]);
  assert.match(post.payload.embeds[0].data.description, /Kovi/);
  assert.deepEqual(post.payload.components[0].components.map((b) => b.data.custom_id), [
    `help:claim:${r.entry.id}`,
    `help:sorted:${r.entry.id}`,
    `help:remove:${r.entry.id}`,
  ]);
  const [saved] = help.loadData().entries;
  assert.deepEqual([saved.requestChannelId, saved.requestMessageId], ["c9", post.messageId]);
});

test("sorted/closeAll effects finalise each request card (no buttons) and refresh the board", async () => {
  const cards = { requestChannelId: "c9" };
  seed((d) => {
    d.boardChannelId = "b1";
    d.boardMessageId = "bm1";
    d.entries.push(
      entry("e1", "u1", "mvp5k", { ...cards, requestMessageId: "card1" }),
      entry("e3", "u1", "seasonrun5k", { ...cards, requestMessageId: "card3" }),
      entry("e2", "u2", "mvp5k", { ...cards, requestMessageId: "card2" })
    );
  });
  const client = fakeClient();
  const s = actions.sorted({ client }, MEMBER, { entryIds: ["e1", "e2"] });
  assert.deepEqual(client.log, []);
  await s.effects();
  assert.deepEqual(
    client.log.map((x) => [x.op, x.channelId, x.messageId]),
    [["edit", "c9", "card1"], ["edit", "b1", "bm1"]]
  );
  assert.equal(client.log[0].payload.content, "✅ Kovi marked themselves sorted");
  assert.deepEqual(client.log[0].payload.components, []);

  client.log.length = 0;
  const all = actions.closeAll({ client }, MEMBER);
  await all.effects();
  assert.deepEqual(
    client.log.map((x) => [x.op, x.channelId, x.messageId]),
    [["edit", "c9", "card3"], ["edit", "b1", "bm1"]]
  );
});

test("setNote effects re-render the card with its buttons and refresh the board", async () => {
  seed((d) => {
    d.boardChannelId = "b1";
    d.boardMessageId = "bm1";
    d.entries.push(entry("e1", "u1", "mvp5k", { requestChannelId: "c9", requestMessageId: "card1" }));
  });
  const client = fakeClient();
  const r = actions.setNote({ client }, MEMBER, { entryId: "e1", note: "3 hammers" });
  await r.effects();
  assert.deepEqual(
    client.log.map((x) => [x.op, x.channelId, x.messageId]),
    [["edit", "c9", "card1"], ["edit", "b1", "bm1"]]
  );
  assert.match(client.log[0].payload.embeds[0].data.description, /3 hammers/);
  assert.equal(client.log[0].payload.components[0].components.length, 3);
});

test("/needhelp via dispatch goes through the action and keeps the legacy replies", async () => {
  seed();
  const i = slash("needhelp", { category: "mvp5k", note: "pls" }, MEMBER);
  await help.dispatch(i);
  assert.equal(contentOf(i), "Added you to the board for **MVP 5K**. ⭐");
  const [e] = help.loadData().entries;
  assert.deepEqual([e.userId, e.username, e.category, e.note], ["u1", "Kovi", "mvp5k", "pls"]);
  const again = slash("needhelp", { category: "mvp5k" }, MEMBER);
  await help.dispatch(again);
  assert.equal(contentOf(again), "You're already on the board for MVP 5K.");
});

test("board:pick and the imsorted panel via dispatch go through the actions", async () => {
  seed((d) => { d.categories[0].archived = true; });
  const gone = component("string", "board:pick", MEMBER, { values: ["seasonrun5k"] });
  await help.dispatch(gone);
  assert.equal(contentOf(gone), "That category isn't available anymore.");
  const pick = component("string", "board:pick", MEMBER, { values: ["mvp5k"] });
  await help.dispatch(pick);
  assert.equal(contentOf(pick), "Added you to the board for **MVP 5K** ⭐ ✅");
  const dup = component("string", "board:pick", MEMBER, { values: ["mvp5k"] });
  await help.dispatch(dup);
  assert.equal(contentOf(dup), "You're already on the board for **MVP 5K**.");
  const all = component("button", "imsorted:all", MEMBER);
  await help.dispatch(all);
  assert.equal(contentOf(all), "Marked 1 request sorted.");
  const none = component("button", "imsorted:all", MEMBER);
  await help.dispatch(none);
  assert.equal(contentOf(none), "You have no open requests.");
  const stale = component("string", "imsorted:pick", MEMBER, { values: ["gone"] });
  await help.dispatch(stale);
  assert.equal(contentOf(stale), "Those requests are already gone.");
});

test("/imsorted <category> via dispatch keeps the legacy texts", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  const bad = slash("imsorted", { category: "nope" }, MEMBER);
  await help.dispatch(bad);
  assert.equal(contentOf(bad), "That isn't a known category. Pick one from the list.");
  const empty = slash("imsorted", { category: "seasonrun5k" }, MEMBER);
  await help.dispatch(empty);
  assert.equal(contentOf(empty), "You're not on the board right now.");
  const ok = slash("imsorted", { category: "mvp5k" }, MEMBER);
  await help.dispatch(ok);
  assert.equal(contentOf(ok), "Took you off the board. Glad you got sorted! 🎉");
  assert.deepEqual(help.loadData().entries, []);
});
