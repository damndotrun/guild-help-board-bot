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
const { MessageFlags } = require("discord.js");

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
    users: {
      fetch: async (userId) => ({
        send: async (payload) => { log.push({ op: "dm", userId, payload }); },
      }),
    },
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

test("final F-M6: a note added while the request card is still being posted reaches the card", async () => {
  seed((d) => { d.boardChannelId = "b1"; d.boardMessageId = "bm1"; });
  const log = [];
  let release;
  const held = new Promise((r) => { release = r; });
  const client = {
    channels: {
      fetch: async (cid) => ({
        id: cid,
        guild: null,
        send: async (payload) => { log.push(["send", cid, payload]); await held; return { id: "card1" }; },
        messages: { fetch: async (mid) => ({ edit: async (payload) => { log.push(["edit", cid, mid, payload]); } }) },
      }),
    },
  };
  const a = actions.needHelp({ client }, MEMBER, { categoryId: "mvp5k" });
  const posting = a.effects(); // the card POST is now in flight
  await new Promise((r) => setImmediate(r));
  const n = actions.setNote({ client }, MEMBER, { entryId: a.entry.id, note: "3 hammers" });
  await n.effects(); // rerenderCard finds no message id yet and does nothing
  release();
  await posting;
  const cardEdits = log.filter((x) => x[0] === "edit" && x[1] === "b1" && x[2] === "card1");
  assert.ok(
    cardEdits.some((x) => /3 hammers/.test(x[3].embeds[0].data.description)),
    "the posted card is re-rendered with the note saved meanwhile"
  );
  assert.equal(help.loadData().entries[0].requestMessageId, "card1");
});

test("final F-M6: with no concurrent note the card is posted once and not edited", async () => {
  seed((d) => { d.boardChannelId = "b1"; d.boardMessageId = "bm1"; });
  const client = fakeClient();
  const a = actions.needHelp({ client }, MEMBER, { categoryId: "mvp5k", note: "hi" });
  await a.effects();
  assert.equal(client.log.filter((x) => x.op === "send").length, 1);
  assert.deepEqual(client.log.filter((x) => x.op === "edit").map((x) => x.messageId), ["bm1"], "only the board refresh edits");
});

test("final T2-b: sorted with categoryId null (a web caller) falls back to entryIds instead of 'unknown category'", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  const r = actions.sorted(CTX, MEMBER, { categoryId: null, entryIds: ["e1"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.closed.map((e) => e.id), ["e1"]);
});

test("final T4-b: manager / notify role assignment fails CLOSED when the guild id is missing", () => {
  seed();
  const role = { id: "g1", managed: false }; // would be @everyone if the guild were known
  assert.equal(actions.addManagerRole(CTX, OWNER, { role }).code, "invalid");
  assert.equal(actions.addManagerRole(CTX, OWNER, { role, guildId: undefined }).code, "invalid");
  assert.equal(actions.setNotifyRole(CTX, OWNER, { role }).code, "invalid");
  assert.deepEqual(help.loadData().managerRoleIds, []);
  assert.equal(help.loadData().notifyRoleId, null);
  // turning the notify role off needs no guild id
  assert.equal(actions.setNotifyRole(CTX, OWNER, { role: null }).ok, true);
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

// ---- officer actions (Task 3) ----

function fakeChannel({ sendFails = false, pinFails = false } = {}) {
  const sent = [];
  return {
    id: "c9",
    guild: null,
    sent,
    send: async (p) => {
      if (sendFails) throw new Error("Missing Access");
      sent.push(p);
      return { id: "m9", pin: async () => { if (pinFails) throw new Error("Missing Permissions"); } };
    },
  };
}

test("helped: an officer marks an open entry sorted — by id or by member + category", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k"), entry("e2", "u2", "seasonrun5k")); });
  const byId = actions.helped(CTX, OFFICER, { entryId: "e1" });
  assert.deepEqual([byId.ok, byId.entry.id, byId.category.label], [true, "e1", "MVP 5K"]);
  assert.equal(actions.helped(CTX, OWNER, { userId: "u2", categoryId: "seasonrun5k" }).entry.id, "e2");
  const d = help.loadData();
  assert.deepEqual(d.entries.map((e) => [e.id, e.done, e.helpedBy]), [["e1", true, "o1"], ["e2", true, "w1"]]);
  assert.deepEqual(d.records.map((x) => [x.reqId, x.resolution, x.helperId]), [["e1", "sorted", "o1"], ["e2", "sorted", "w1"]]);
});

test("helped/remove: unknown category → invalid; no open entry → not_found", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k", { done: true })); });
  for (const act of [actions.helped, actions.remove]) {
    assert.equal(act(CTX, OFFICER, { userId: "u1", categoryId: "nope" }).code, "invalid");
    assert.equal(act(CTX, OFFICER, { userId: "u1", categoryId: "mvp5k" }).code, "not_found");
    assert.equal(act(CTX, OFFICER, { entryId: "e1" }).code, "not_found");
  }
});

test("helped/remove: a member — e.g. a demoted officer — is refused and nothing changes", () => {
  seed((d) => { d.entries.push(entry("e1", "u2", "mvp5k")); });
  assert.equal(actions.helped(CTX, MEMBER, { entryId: "e1" }).code, "forbidden");
  assert.equal(actions.remove(CTX, MEMBER, { entryId: "e1" }).code, "forbidden");
  const d = help.loadData();
  assert.deepEqual([d.entries[0].done, d.records.length], [false, 0]);
});

test("remove: one removed record; removing the same entry again → not_found, still one record", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  assert.equal(actions.remove(CTX, OFFICER, { entryId: "e1" }).ok, true);
  assert.equal(actions.remove(CTX, OFFICER, { entryId: "e1" }).code, "not_found");
  const d = help.loadData();
  assert.deepEqual(d.entries, []);
  assert.deepEqual(d.records.map((x) => x.resolution), ["removed"]);
});

test("helped: a double tap on an already-sorted entry → not_found and no second record", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  assert.equal(actions.helped(CTX, OFFICER, { entryId: "e1" }).ok, true);
  const again = actions.helped(CTX, OWNER, { entryId: "e1" });
  assert.deepEqual([again.ok, again.code], [false, "not_found"]);
  assert.equal(actions.helped(CTX, OWNER, { userId: "u1", categoryId: "mvp5k" }).code, "not_found");
  const d = help.loadData();
  assert.deepEqual(d.records.map((x) => [x.reqId, x.resolution, x.helperId]), [["e1", "sorted", "o1"]]);
  assert.equal(d.entries[0].helpedBy, "o1");
});

test("officer effects run to completion without a Discord client", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k"), entry("e2", "u2", "mvp5k")); });
  await actions.helped(CTX, OFFICER, { entryId: "e1" }).effects();
  await actions.remove(CTX, OFFICER, { entryId: "e2" }).effects();
  assert.deepEqual(help.loadData().entries.map((e) => e.id), ["e1"]);
});

test("helped effects finalise the card, DM the requester and refresh the board", async () => {
  seed((d) => {
    d.boardChannelId = "b1";
    d.boardMessageId = "bm1";
    d.entries.push(entry("e1", "u1", "mvp5k", { requestChannelId: "c9", requestMessageId: "card1" }));
  });
  const client = fakeClient();
  const r = actions.helped({ client }, OFFICER, { entryId: "e1" });
  assert.deepEqual(client.log, []);
  await r.effects();
  assert.deepEqual(
    client.log.map((x) => [x.op, x.channelId ?? x.userId, x.messageId ?? null]),
    [["edit", "c9", "card1"], ["dm", "u1", null], ["edit", "b1", "bm1"]]
  );
  assert.equal(client.log[0].payload.content, "✅ Sorted by Offi");
  assert.deepEqual(client.log[0].payload.components, []);
  assert.match(client.log[1].payload, /^✅ You've been sorted for \*\*MVP 5K\*\*/);
});

test("remove effects finalise the card and refresh the board — no DM", async () => {
  seed((d) => {
    d.boardChannelId = "b1";
    d.boardMessageId = "bm1";
    d.entries.push(entry("e1", "u1", "mvp5k", { requestChannelId: "c9", requestMessageId: "card1" }));
  });
  const client = fakeClient();
  await actions.remove({ client }, OFFICER, { entryId: "e1" }).effects();
  assert.deepEqual(
    client.log.map((x) => [x.op, x.channelId, x.messageId]),
    [["edit", "c9", "card1"], ["edit", "b1", "bm1"]]
  );
  assert.equal(client.log[0].payload.content, "🗑️ Removed by Offi");
  assert.deepEqual(client.log[0].payload.components, []);
});

test("repostBoard: posts + pins in the channel and saves the ids on a fresh load", async () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  const ch = fakeChannel();
  const r = await actions.repostBoard(CTX, OFFICER, { channel: ch });
  assert.deepEqual([r.ok, r.pinned], [true, true]);
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].components[0].toJSON().components[0].custom_id, "board:needhelp");
  const d = help.loadData();
  assert.deepEqual([d.boardChannelId, d.boardMessageId], ["c9", "m9"]);
});

test("repostBoard: the previous board is unpinned and retired", async () => {
  seed((d) => { d.boardChannelId = "old1"; d.boardMessageId = "oldm"; });
  const ops = [];
  const client = {
    channels: {
      fetch: async (channelId) => ({
        messages: {
          fetch: async (messageId) => ({
            unpin: async () => { ops.push(["unpin", channelId, messageId]); },
            edit: async (p) => { ops.push(["edit", channelId, messageId, p.content]); },
          }),
        },
      }),
    },
  };
  await actions.repostBoard({ client }, OFFICER, { channel: fakeChannel() });
  assert.deepEqual(ops, [
    ["unpin", "old1", "oldm"],
    ["edit", "old1", "oldm", "_This board has been retired; a newer one was posted._"],
  ]);
  const d = help.loadData();
  assert.deepEqual([d.boardChannelId, d.boardMessageId], ["c9", "m9"]);
});

test("repostBoard: failed pin reported; failed send → rest error, nothing saved; members refused before any REST", async () => {
  seed();
  const noPin = await actions.repostBoard(CTX, OFFICER, { channel: fakeChannel({ pinFails: true }) });
  assert.deepEqual([noPin.ok, noPin.pinned], [true, false]);
  seed();
  const noSend = await actions.repostBoard(CTX, OFFICER, { channel: fakeChannel({ sendFails: true }) });
  assert.deepEqual([noSend.ok, noSend.code], [false, "rest"]);
  assert.equal(help.loadData().boardMessageId, null);
  const ch = fakeChannel();
  assert.equal((await actions.repostBoard(CTX, MEMBER, { channel: ch })).code, "forbidden");
  assert.equal(ch.sent.length, 0);
  assert.equal((await actions.repostBoard(CTX, OFFICER, { channel: null })).code, "invalid");
});

test("/helped, resolve:remove:entry and /board via dispatch keep their legacy texts", async () => {
  const officer = [OFFICER, { roles: ["mgr"] }];
  seed((d) => { d.managerRoleIds = ["mgr"]; d.entries.push(entry("e1", "u1", "mvp5k"), entry("e2", "u1", "seasonrun5k")); });
  const kovi = { id: "u1", username: "kovi" };
  const denied = slash("helped", { member: kovi, category: "mvp5k" }, MEMBER);
  await help.dispatch(denied);
  assert.equal(contentOf(denied), "You need the **Manage Server** permission or a manager role to do that.");
  const done = slash("helped", { member: kovi, category: "mvp5k" }, ...officer);
  await help.dispatch(done);
  assert.equal(contentOf(done), "✅ Marked **Kovi** as sorted for MVP 5K.");
  const again = slash("helped", { member: kovi, category: "mvp5k" }, ...officer);
  await help.dispatch(again);
  assert.equal(contentOf(again), "No pending entry found for kovi in MVP 5K.");
  const pick = component("string", "resolve:remove:entry", OFFICER, { values: ["e2"], rights: { roles: ["mgr"] } });
  await help.dispatch(pick);
  assert.equal(contentOf(pick), "Removed Kovi's entry.");
  const gone = component("string", "resolve:remove:entry", OFFICER, { values: ["e2"], rights: { roles: ["mgr"] } });
  await help.dispatch(gone);
  assert.equal(contentOf(gone), "That request is already gone.");
  const board = slash("board", {}, ...officer);
  board.channel = fakeChannel({ pinFails: true });
  await help.dispatch(board);
  assert.match(contentOf(board), /^Board posted — it'll update live from now on\. I couldn't pin it/);
});

test("newSeason: pending → unresolved, season archived, a new named season; officer only", () => {
  seed((d) => {
    d.currentSeason = { name: "S4", startedTs: 1 };
    d.entries.push(entry("e1", "u1", "mvp5k", { done: true, helpedBy: "o1", doneTs: 5 }), entry("e2", "u2", "mvp5k"));
  });
  assert.equal(actions.newSeason(CTX, MEMBER, { name: "S5" }).code, "forbidden");
  const r = actions.newSeason(CTX, OFFICER, { name: "  S5  " });
  assert.equal(r.archived.name, "S4");
  const d = help.loadData();
  assert.equal(d.currentSeason.name, "S5");
  assert.deepEqual(d.entries, []);
  assert.deepEqual(d.seasons.map((s) => [s.name, s.sortedTotal]), [["S4", 1]]);
  assert.deepEqual(d.records.map((x) => [x.reqId, x.resolution]), [["e2", "unresolved"]]);
});

test("renameSeason: current or past; blank / unknown → invalid", () => {
  seed((d) => { d.seasons.push({ name: "Old", startedTs: 1, endedTs: 50, sortedTotal: 0, byCategory: {} }); });
  assert.equal(actions.renameSeason(CTX, OFFICER, { target: "current", name: "  " }).code, "invalid");
  assert.equal(actions.renameSeason(CTX, OFFICER, { target: 999, name: "X" }).code, "invalid");
  assert.equal(actions.renameSeason(CTX, OFFICER, { target: 50, name: "Older" }).effects, null);
  assert.equal(typeof actions.renameSeason(CTX, OFFICER, { target: "current", name: "S6" }).effects, "function");
  const d = help.loadData();
  assert.deepEqual([d.currentSeason.name, d.seasons[0].name], ["S6", "Older"]);
});

test("reset: pending closed as unresolved, board cleared; member refused", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  assert.equal(actions.reset(CTX, MEMBER).code, "forbidden");
  assert.equal(help.loadData().entries.length, 1);
  assert.equal(actions.reset(CTX, OFFICER).ok, true);
  const d = help.loadData();
  assert.deepEqual(d.entries, []);
  assert.equal(d.records[0].resolution, "unresolved");
});

test("categories are owner-only: add (upsert) and archive with moveto; dropped duplicates logged (invariant #6)", () => {
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k"), entry("e2", "u2", "mvp5k"), entry("e3", "u2", "seasonrun5k")); });
  assert.equal(actions.addCategory(CTX, OFFICER, { label: "Guild Boss" }).code, "forbidden");
  assert.equal(actions.addCategory(CTX, OWNER, { label: "" }).code, "invalid");
  assert.deepEqual(actions.addCategory(CTX, OWNER, { label: "Guild Boss", emoji: "👹" }).category, { id: "guild-boss", label: "Guild Boss", emoji: "👹", archived: false });
  assert.equal(actions.archiveCategory(CTX, OWNER, { categoryId: "mvp5k" }).code, "invalid"); // open requests, no moveto
  const r = actions.archiveCategory(CTX, OWNER, { categoryId: "mvp5k", moveto: "seasonrun5k" });
  assert.deepEqual([r.label, r.movetoLabel, r.moved.map((e) => e.id), r.dropped.map((e) => e.id)], ["MVP 5K", "Season Run 5K", ["e1"], ["e2"]]);
  const d = help.loadData();
  assert.equal(d.categories.find((c) => c.id === "mvp5k").archived, true);
  assert.deepEqual(d.records.map((x) => [x.reqId, x.resolution]), [["e2", "removed"]]);
});

test("manager and notify roles: @everyone and bot-managed refused; dedupe; null clears notify", () => {
  seed();
  const everyone = { id: "g1", managed: false };
  const bot = { id: "b1", managed: true };
  const mgr = { id: "r1", managed: false };
  assert.equal(actions.addManagerRole(CTX, OFFICER, { role: mgr, guildId: "g1" }).code, "forbidden");
  assert.equal(actions.addManagerRole(CTX, OWNER, { role: everyone, guildId: "g1" }).code, "invalid");
  assert.equal(actions.addManagerRole(CTX, OWNER, { role: bot, guildId: "g1" }).code, "invalid");
  assert.equal(actions.addManagerRole(CTX, OWNER, { role: mgr, guildId: "g1" }).added, true);
  assert.equal(actions.addManagerRole(CTX, OWNER, { role: mgr, guildId: "g1" }).added, false);
  assert.deepEqual(help.loadData().managerRoleIds, ["r1"]);
  assert.equal(actions.removeManagerRole(CTX, OWNER, { roleId: "zz" }).removed, false);
  assert.equal(actions.removeManagerRole(CTX, OWNER, { roleId: "r1" }).removed, true);
  assert.equal(actions.setNotifyRole(CTX, OWNER, { role: everyone, guildId: "g1" }).code, "invalid");
  actions.setNotifyRole(CTX, OWNER, { role: mgr, guildId: "g1" });
  assert.equal(help.loadData().notifyRoleId, "r1");
  actions.setNotifyRole(CTX, OWNER, { role: null, guildId: "g1" });
  assert.equal(help.loadData().notifyRoleId, null);
});

test("nudge: owner-only; bad hours → invalid; set then off keeps the threshold", () => {
  seed();
  assert.equal(actions.setNudge(CTX, OFFICER, { channelId: "c1" }).code, "forbidden");
  assert.equal(actions.setNudge(CTX, OWNER, { channelId: "c1", hours: 0 }).code, "invalid");
  assert.equal(actions.setNudge(CTX, OWNER, { channelId: "c1", hours: 12 }).ok, true);
  assert.equal(actions.nudgeOff(CTX, OWNER).ok, true);
  const d = help.loadData();
  assert.deepEqual([d.nudgeChannelId, d.nudgeThresholdHours], [null, 12]);
});

test("every settings action refuses a missing or under-levelled actor and writes nothing", () => {
  seed((d) => { d.currentSeason = { name: "Keep", startedTs: 1 }; });
  const before = JSON.stringify(help.loadData());
  const role = { id: "r1", managed: false };
  for (const who of [undefined, MEMBER]) {
    assert.equal(actions.newSeason(CTX, who, { name: "X" }).code, "forbidden");
    assert.equal(actions.renameSeason(CTX, who, { target: "current", name: "X" }).code, "forbidden");
    assert.equal(actions.reset(CTX, who).code, "forbidden");
    assert.equal(actions.addCategory(CTX, who, { label: "X" }).code, "forbidden");
    assert.equal(actions.archiveCategory(CTX, who, { categoryId: "mvp5k", moveto: "seasonrun5k" }).code, "forbidden");
    assert.equal(actions.addManagerRole(CTX, who, { role, guildId: "g1" }).code, "forbidden");
    assert.equal(actions.removeManagerRole(CTX, who, { roleId: "r1" }).code, "forbidden");
    assert.equal(actions.setNotifyRole(CTX, who, { role, guildId: "g1" }).code, "forbidden");
    assert.equal(actions.setNudge(CTX, who, { channelId: "c1" }).code, "forbidden");
    assert.equal(actions.nudgeOff(CTX, who).code, "forbidden");
  }
  assert.equal(JSON.stringify(help.loadData()), before);
});

test("newSeason/reset effects close every pending request card and refresh the board", async () => {
  const card = (n) => ({ requestChannelId: "c9", requestMessageId: `card${n}` });
  const build = () => seed((d) => {
    d.boardChannelId = "b1";
    d.boardMessageId = "bm1";
    d.entries.push(
      entry("e1", "u1", "mvp5k", { done: true, helpedBy: "o1", doneTs: 5, ...card(1) }),
      entry("e2", "u2", "mvp5k", card(2)),
      entry("e3", "u1", "seasonrun5k", card(3))
    );
  });
  for (const run of [
    (client) => actions.newSeason({ client }, OFFICER, { name: "S9" }),
    (client) => actions.reset({ client }, OFFICER),
  ]) {
    build();
    const client = fakeClient();
    const r = run(client);
    assert.deepEqual(client.log, [], "no REST before effects() is called");
    await r.effects();
    assert.deepEqual(
      client.log.map((x) => [x.op, x.channelId, x.messageId]),
      [["edit", "c9", "card2"], ["edit", "c9", "card3"], ["edit", "b1", "bm1"]]
    );
    assert.equal(client.log[0].payload.content, "Season reset — this request is closed.");
    assert.deepEqual(client.log[0].payload.components, []);
  }
});

test("renameSeason effects: the current season refreshes the board, a past one does nothing", async () => {
  seed((d) => {
    d.boardChannelId = "b1";
    d.boardMessageId = "bm1";
    d.seasons.push({ name: "Old", startedTs: 1, endedTs: 50, sortedTotal: 0, byCategory: {} });
  });
  const client = fakeClient();
  await actions.renameSeason({ client }, OFFICER, { target: "current", name: "S6" }).effects();
  assert.deepEqual(client.log.map((x) => [x.op, x.channelId, x.messageId]), [["edit", "b1", "bm1"]]);
  assert.equal(actions.renameSeason({ client }, OFFICER, { target: 50, name: "Older" }).effects, null);
});

test("addCategory effects refresh the board", async () => {
  seed((d) => { d.boardChannelId = "b1"; d.boardMessageId = "bm1"; });
  const client = fakeClient();
  await actions.addCategory({ client }, OWNER, { label: "Guild Boss", emoji: "👹" }).effects();
  assert.deepEqual(client.log.map((x) => [x.op, x.channelId, x.messageId]), [["edit", "b1", "bm1"]]);
  assert.equal(client.log[0].payload.embeds.length, 1);
});

test("archiveCategory effects: board first, then the dropped card is closed and the moved card re-rendered", async () => {
  const card = (n) => ({ requestChannelId: "c9", requestMessageId: `card${n}` });
  seed((d) => {
    d.boardChannelId = "b1";
    d.boardMessageId = "bm1";
    d.entries.push(
      entry("e1", "u1", "mvp5k", card(1)),
      entry("e2", "u2", "mvp5k", card(2)),
      entry("e3", "u2", "seasonrun5k", card(3))
    );
  });
  const client = fakeClient();
  const r = actions.archiveCategory({ client }, OWNER, { categoryId: "mvp5k", moveto: "seasonrun5k" });
  assert.deepEqual(client.log, []);
  await r.effects();
  assert.deepEqual(
    client.log.map((x) => [x.op, x.channelId, x.messageId]),
    [["edit", "b1", "bm1"], ["edit", "c9", "card2"], ["edit", "c9", "card1"]]
  );
  assert.equal(client.log[1].payload.content, "Merged into Season Run 5K.");
  assert.deepEqual(client.log[1].payload.components, []);
  assert.equal(client.log[2].payload.components.length > 0, true); // the moved card keeps its buttons
});

test("settings actions return the saved values for the caller to render", () => {
  seed();
  const a = actions.addManagerRole(CTX, OWNER, { role: { id: "r1", managed: false }, guildId: "g1" });
  assert.deepEqual(a.data.managerRoleIds, ["r1"]);
  const n = actions.setNotifyRole(CTX, OWNER, { role: { id: "r2", managed: false }, guildId: "g1" });
  assert.equal(n.data.notifyRoleId, "r2");
  assert.equal(actions.setNudge(CTX, OWNER, { channelId: "c1", hours: 24 }).data.nudgeThresholdHours, 24);
  assert.equal(actions.removeManagerRole(CTX, OWNER, { roleId: "r1" }).data.managerRoleIds.length, 0);
});

test("reset:confirm, season:newmodal and /config via dispatch go through the actions", async () => {
  const boss = { manageGuild: true };
  seed((d) => { d.entries.push(entry("e1", "u1", "mvp5k")); });
  const confirm = component("button", `reset:confirm:${Date.now()}`, OWNER, { rights: boss });
  await help.dispatch(confirm);
  assert.equal(contentOf(confirm), "Season reset — the board is clear.");
  assert.deepEqual(help.loadData().entries, []);

  const modal = component("modal", "season:newmodal", OWNER, { rights: boss, fields: { name: "S7" } });
  await help.dispatch(modal);
  assert.equal(help.loadData().currentSeason.name, "S7");
  assert.equal(modal.calls[0][0], "update"); // the season panel refreshed in place

  const everyone = slash("config", { sub: "addrole", role: { id: "g1", name: "@everyone", managed: false } }, OWNER, boss);
  await help.dispatch(everyone);
  assert.equal(contentOf(everyone), "You can't add @everyone or a bot-managed role as a manager role.");
  const add = slash("config", { sub: "addrole", role: { id: "r1", name: "Officers", managed: false } }, OWNER, boss);
  await help.dispatch(add);
  assert.equal(contentOf(add), "Added **Officers** as a manager role. Members with it can now run the officer commands.");
  const cat = slash("config", { group: "category", sub: "add", label: "Guild Boss", emoji: "👹" }, OWNER, boss);
  await help.dispatch(cat);
  assert.equal(contentOf(cat), "Category **Guild Boss** 👹 is ready.");
  const nudge = slash("config", { group: "nudge", sub: "set", channel: { id: "c5" }, hours: 24 }, OWNER, boss);
  await help.dispatch(nudge);
  assert.equal(contentOf(nudge), "Stale nudges **on** — daily digest to <#c5> for requests older than **24h**.");
});

test("the season and category modals wrap each text input in a Label (no legacy action rows)", async () => {
  const boss = { manageGuild: true };
  seed((d) => { d.currentSeason.name = "S6"; });
  const shown = async (i) => {
    await help.dispatch(i);
    assert.equal(i.calls[0][0], "showModal");
    return i.calls[0][1].toJSON();
  };
  const labelled = (modal) => modal.components.map((c) => [c.type, c.label, c.component.type, c.component.custom_id, c.component.label]);

  const fresh = await shown(component("button", "season:new", OWNER, { rights: boss }));
  assert.equal(fresh.custom_id, "season:newmodal");
  assert.deepEqual(labelled(fresh), [[18, "New season name", 4, "name", undefined]]);

  const rename = await shown(component("button", "season:rename", OWNER, { rights: boss }));
  assert.equal(rename.custom_id, "season:renamemodal:current");
  assert.deepEqual(labelled(rename), [[18, "Season name", 4, "name", undefined]]);
  assert.equal(rename.components[0].component.value, "S6");

  const cat = await shown(slash("config", { group: "category", sub: "add" }, OWNER, boss));
  assert.equal(cat.custom_id, "catadd:submit");
  assert.deepEqual(labelled(cat), [[18, "Category name", 4, "label", undefined], [18, "Emoji", 4, "emoji", undefined]]);
});

test("Label-wrapped modal submits parse with discord.js's own field reader", async () => {
  const { ModalSubmitInteraction, ModalSubmitFields } = require("discord.js");
  // The raw MODAL_SUBMIT payload shape Discord sends for Label components.
  const fieldsOf = (inputs) => new ModalSubmitFields(
    inputs.map(([id, value]) => ModalSubmitInteraction.transformComponent({ type: 18, id: 1, component: { type: 4, id: 2, custom_id: id, value } })),
  );
  const boss = { manageGuild: true };
  seed();
  const cat = component("modal", "catadd:submit", OWNER, { rights: boss });
  cat.fields = fieldsOf([["label", "Guild Boss"], ["emoji", ""]]);
  await help.dispatch(cat);
  assert.ok(help.loadData().categories.some((c) => c.label === "Guild Boss" && !c.archived));

  const season = component("modal", "season:newmodal", OWNER, { rights: boss });
  season.fields = fieldsOf([["name", "S8"]]);
  await help.dispatch(season);
  assert.equal(help.loadData().currentSeason.name, "S8");
});

test("/config nudge set refuses a channel the bot cannot post the digest in; nothing written", async () => {
  const { PermissionFlagsBits } = require("discord.js");
  const boss = { manageGuild: true };
  seed();
  const me = { id: "bot" };
  const chan = (id, extra) => ({ id, type: 0, permissionsFor: () => ({ has: () => true }), ...extra });
  const channels = new Map([
    ["c-obf", chan("c-obf", { flags: { bitfield: 1 << 17 } })],
    ["c-ro", chan("c-ro", { permissionsFor: () => ({ has: (p) => p !== PermissionFlagsBits.EmbedLinks }) })],
    ["c-ok", chan("c-ok")],
  ]);
  const run = async (id) => {
    const i = slash("config", { group: "nudge", sub: "set", channel: { id }, hours: 24 }, OWNER, boss);
    i.guild = { id: "g1", roles: { cache: new Map() }, members: { me }, channels: { cache: channels } };
    await help.dispatch(i);
    return contentOf(i);
  };
  for (const id of ["c-obf", "c-ro"]) {
    assert.match(await run(id), /^I can't post the digest in <#c-[a-z]+> — give me View Channel, Send Messages and Embed Links there/);
    assert.equal(help.loadData().nudgeChannelId, null);
  }
  assert.match(await run("c-ok"), /^Stale nudges \*\*on\*\*/);
  assert.equal(help.loadData().nudgeChannelId, "c-ok");
});

test("the /config roles panel via dispatch goes through the actions (guards unchanged)", async () => {
  const boss = { manageGuild: true };
  seed();
  const bot = component("role", "roles:add", OWNER, { values: ["b1"], rights: boss });
  bot.guild.roles.cache.set("b1", { managed: true, name: "Bot" });
  await help.dispatch(bot);
  assert.equal(contentOf(bot), "You can't add @everyone or a bot-managed role as a manager role.");
  const ok = component("role", "roles:add", OWNER, { values: ["r1"], rights: boss });
  await help.dispatch(ok);
  assert.deepEqual(help.loadData().managerRoleIds, ["r1"]);
  assert.equal(ok.calls[0][1].content, "", "a success clears the refusal line an earlier tap left on the panel");
  await help.dispatch(component("string", "roles:remove", OWNER, { values: ["r1"], rights: boss }));
  assert.deepEqual(help.loadData().managerRoleIds, []);
  await help.dispatch(component("role", "roles:notify", OWNER, { values: ["r2"], rights: boss }));
  assert.equal(help.loadData().notifyRoleId, "r2");
  await help.dispatch(component("button", "roles:notifyclear", OWNER, { rights: boss }));
  assert.equal(help.loadData().notifyRoleId, null);
  const officerTry = component("role", "roles:add", OFFICER, { values: ["r3"] });
  await help.dispatch(officerTry);
  assert.equal(contentOf(officerTry), "Manage Server only.");
});

test("/config notify and the notify panel refuse @everyone and bot-managed roles", async () => {
  const boss = { manageGuild: true };
  seed();
  const slashNotify = slash("config", { sub: "notify", role: { id: "b1", name: "Bot", managed: true } }, OWNER, boss);
  await help.dispatch(slashNotify);
  assert.equal(contentOf(slashNotify), "You can't set @everyone or a bot-managed role as the notify role.");
  assert.equal(help.loadData().notifyRoleId, null);
  const panel = component("role", "roles:notify", OWNER, { values: ["g1"], rights: boss });
  await help.dispatch(panel);
  assert.equal(contentOf(panel), "You can't set @everyone or a bot-managed role as the notify role.");
  const ok = slash("config", { sub: "notify", role: { id: "r2", name: "Helpers", managed: false } }, OWNER, boss);
  await help.dispatch(ok);
  assert.equal(contentOf(ok), "New requests will now ping **Helpers**.");
  assert.equal(help.loadData().notifyRoleId, "r2");
  const off = slash("config", { sub: "notify" }, OWNER, boss);
  await help.dispatch(off);
  assert.equal(contentOf(off), "Turned off request pings.");
  assert.equal(help.loadData().notifyRoleId, null);
});

test("/config category remove and nudge off via dispatch go through the actions", async () => {
  const boss = { manageGuild: true };
  seed((d) => {
    d.nudgeChannelId = "c5";
    d.entries.push(entry("e1", "u1", "mvp5k"), entry("e2", "u2", "mvp5k"), entry("e3", "u2", "seasonrun5k"));
  });
  const rm = slash("config", { group: "category", sub: "remove", category: "mvp5k", moveto: "seasonrun5k" }, OWNER, boss);
  await help.dispatch(rm);
  assert.equal(contentOf(rm), "Archived **MVP 5K**. Moved 1 open request(s) to **Season Run 5K**. Merged 1 duplicate(s).");
  const off = slash("config", { group: "nudge", sub: "off" }, OWNER, boss);
  await help.dispatch(off);
  assert.equal(contentOf(off), "Stale nudges **off**.");
  assert.equal(help.loadData().nudgeChannelId, null);
});

// M3: the web form has no maxLength of its own — the action caps season names
// for every surface (the Discord modals already capped them at 80).
test("season names: over 80 characters → invalid for newSeason and renameSeason; nothing written", () => {
  seed((d) => {
    d.currentSeason = { name: "Old", startedTs: 1 };
  });
  const long = "x".repeat(81);
  assert.equal(actions.newSeason(CTX, OFFICER, { name: long }).code, "invalid");
  assert.equal(actions.renameSeason(CTX, OFFICER, { target: "current", name: long }).code, "invalid");
  assert.equal(help.loadData().currentSeason.name, "Old");
  assert.equal(actions.renameSeason(CTX, OFFICER, { target: "current", name: "y".repeat(80) }).ok, true);
  assert.match(actions.seasonNameError(long), /80 characters or fewer/);
  assert.equal(actions.seasonNameError(`  ${"z".repeat(80)}  `), null);
  assert.equal(actions.newSeason(CTX, MEMBER, { name: long }).code, "forbidden", "the gate still comes first");
});

// F-M3: names reach Discord-rendered text (board/embed titles); a control or
// bidi-override character could garble or spoof them — refused on every surface.
// (bidi controls by code point: a literal one in source is invisible)
const cp = (n) => String.fromCodePoint(n);
const CONTROL_SAMPLES = ["a\u0000b", "a\nb", "a\tb", "a\u007fb", "a\u0085b", `a${cp(0x202e)}b`, `a${cp(0x202a)}b`, `a${cp(0x2066)}b`, `a${cp(0x2069)}b`];

test("season names: control and bidi-control characters → invalid for newSeason and renameSeason; nothing written", () => {
  seed((d) => {
    d.currentSeason = { name: "Old", startedTs: 1 };
  });
  for (const bad of CONTROL_SAMPLES) {
    const label = JSON.stringify(bad);
    assert.equal(actions.seasonNameError(bad), help.PLAIN_TEXT_ERROR, label);
    const r = actions.newSeason(CTX, OFFICER, { name: bad });
    assert.deepEqual([r.code, r.error], ["invalid", help.PLAIN_TEXT_ERROR], label);
    assert.equal(actions.renameSeason(CTX, OFFICER, { target: "current", name: bad }).code, "invalid", label);
  }
  assert.equal(help.loadData().currentSeason.name, "Old");
  assert.equal(help.PLAIN_TEXT_ERROR, "Use letters, numbers and punctuation only.");
  // ordinary text — accents, emoji (ZWJ sequences), RTL letters — is fine
  for (const ok of ["Season 7 — Ünnep", "Spring 🏃‍♀️ run", "موسم ٣"]) assert.equal(actions.seasonNameError(ok), null, ok);
  // surrounding whitespace is trimmed before storing, so it is not refused
  assert.equal(actions.seasonNameError("\tSeason 8\n"), null);
});

test("category labels: control and bidi-control characters → invalid (help.addCategory, every surface); nothing written", () => {
  seed(() => {});
  const before = JSON.stringify(help.loadData().categories);
  for (const bad of CONTROL_SAMPLES) {
    const r = actions.addCategory(CTX, OWNER, { label: `Guild ${bad} Boss` });
    assert.deepEqual([r.code, r.error], ["invalid", help.PLAIN_TEXT_ERROR], JSON.stringify(bad));
  }
  assert.equal(JSON.stringify(help.loadData().categories), before);
  assert.equal(actions.addCategory(CTX, OWNER, { label: "Guild Boss — Ünnep" }).ok, true);
});

test("refreshBoard edits the board from the data on disk, never from an older snapshot", async () => {
  seed((d) => { d.boardChannelId = "b1"; d.boardMessageId = "bm1"; d.entries = [entry("e1", "u1", "mvp5k")]; });
  const stale = help.loadData(); // an effect's snapshot taken before…
  seed((d) => { d.boardChannelId = "b1"; d.boardMessageId = "bm1"; d.entries = [entry("e1", "u1", "mvp5k"), entry("e2", "u2", "mvp5k")]; }); // …a newer request was saved
  const client = fakeClient();
  await help.refreshBoard(client, stale);
  const edit = client.log.find((x) => x.op === "edit" && x.messageId === "bm1");
  const text = JSON.stringify(edit.payload.embeds[0].toJSON());
  assert.match(text, /Kovi/);
  assert.match(text, /Zed/, "the request saved after the snapshot is on the board");
});

// The Claim button when someone else holds the claim (help.js handleButton).
function claimTap(holderLookup) {
  seed((d) => { d.managerRoleIds = ["r-off"]; d.entries = [entry("e1", "u1", "mvp5k", { claimedBy: "o9", claimedTs: 1 })]; });
  const i = component("button", "help:claim:e1", OFFICER, { rights: { roles: ["r-off"] } });
  i.guild = { id: "g1", roles: { cache: new Map() }, members: { cache: new Map(), fetch: holderLookup } };
  return i;
}

test("Claim held by someone not cached: the tap is deferred BEFORE the member lookup; the notice is a private follow-up", async () => {
  let deferredFirst = null;
  const i = claimTap(async () => { deferredFirst = i.deferred; return { displayName: "Nora" }; });
  await help.dispatch(i);
  assert.equal(deferredFirst, true, "acknowledged before waiting on Discord");
  assert.deepEqual(i.calls.map(([k]) => k), ["deferUpdate", "followUp"]);
  assert.equal(i.calls[1][1].content, "🙌 **Nora** is already on this.");
  assert.equal(i.calls[1][1].flags, MessageFlags.Ephemeral);
  assert.equal(help.loadData().entries[0].claimedBy, "o9");
});

test("Claim held by someone who left: released and taken over, the card edited with editReply after the defer", async () => {
  const i = claimTap(async () => { throw Object.assign(new Error("Unknown Member"), { code: 10007 }); });
  await help.dispatch(i);
  assert.deepEqual(i.calls.map(([k]) => k), ["deferUpdate", "editReply"]);
  assert.match(i.calls[1][1].embeds[0].data.description, /Offi/);
  assert.equal(help.loadData().entries[0].claimedBy, "o1");
});

test("Claim held by a cached member: answered at once, no defer", async () => {
  const i = claimTap(async () => { throw new Error("must not fetch"); });
  i.guild.members.cache.set("o9", { displayName: "Nora" });
  await help.dispatch(i);
  assert.deepEqual(i.calls.map(([k]) => k), ["reply"]);
  assert.equal(i.calls[0][1].content, "🙌 **Nora** is already on this.");
});

test("a help button, select or modal nothing handles is still answered (no 'This interaction failed')", async () => {
  seed();
  for (const i of [
    component("button", "stats:nope", MEMBER),
    component("string", "board:nope", MEMBER),
    component("role", "roles:nope", MEMBER),
    component("modal", "catadd:nope", MEMBER),
  ]) {
    await help.dispatch(i);
    assert.deepEqual(i.calls, [["reply", { content: "Unknown action.", flags: MessageFlags.Ephemeral }]], i.customId);
  }
});

test("Claim: a lookup that can't verify after the defer is a private follow-up", async () => {
  const i = claimTap(async () => { throw Object.assign(new Error("rate limited"), { status: 429 }); });
  await help.dispatch(i);
  assert.deepEqual(i.calls.map(([k]) => k), ["deferUpdate", "followUp"]);
  assert.equal(i.calls[1][1].content, "Couldn't verify the current claimer — try again.");
});

test("Claim: a failure after the defer never writes on the public card — a private follow-up instead", async () => {
  const i = claimTap(async () => { throw Object.assign(new Error("Unknown Member"), { code: 10007 }); });
  i.editReply = async () => { throw Object.assign(new Error("Unknown Message"), { code: 10008 }); };
  await help.dispatch(i);
  assert.deepEqual(i.calls.map(([k]) => k), ["deferUpdate", "followUp"]);
  assert.equal(i.calls[1][1].content, "Done, but the request card couldn't be updated.", "the claim was saved before the edit failed");
  assert.equal(i.calls[1][1].flags, MessageFlags.Ephemeral);
  assert.equal(help.loadData().entries[0].claimedBy, "o1");
});
