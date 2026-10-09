"use strict";
// Shared lfg test fixtures: a two-category config, data builders and (from the
// Discord-glue task on) a recording fake Discord client. `node --test` also
// runs this file as a test file: 0 tests, one "ok" line.
const { shape, emptyData } = require("../../modules/lfg/state");

const T0 = Date.UTC(2026, 9, 9, 18, 0, 0); // 2026-10-09 18:00 UTC
const MIN = 60_000;

function config() {
  return {
    channelId: "ch1",
    guildId: "g1",
    layout: [{ type: "board" }],
    gmPingRoleId: "r-gm",
    categories: [
      {
        id: "basic",
        name: "BASIC",
        emoji: "💥",
        buttons: [
          { id: "sup", label: "SUP", emoji: "💥", pingRoleIds: ["r-sup"], subscribeRoleId: "r-sup" },
          { id: "dps", label: "DPS", emoji: "💥", pingRoleIds: ["r-dps"], subscribeRoleId: "r-dps" },
          { id: "gm", label: "GM", emoji: "⚔\uFE0F", pingRoleIds: ["r-gm"], subscribeRoleId: null },
        ],
      },
      {
        id: "ddps",
        name: "DDPS",
        emoji: "🧬",
        buttons: [
          { id: "radar", label: "RADAR", emoji: "🧬", pingRoleIds: ["r-radar"], subscribeRoleId: "r-radar" },
          { id: "hack", label: "HACK", emoji: "🧬", pingRoleIds: ["r-hack"], subscribeRoleId: "r-hack" },
          { id: "any", label: "ANY", emoji: "🧬", pingRoleIds: ["r-radar", "r-hack"], subscribeRoleId: null },
        ],
      },
    ],
  };
}

// A shaped lfg.json with the fixture config; `mutate(d)` adjusts it.
function dataWith(mutate) {
  const d = shape({ ...emptyData(), config: config() });
  if (mutate) mutate(d);
  return d;
}

// A listing as createListing would store it, with overrides.
function listing(id, posterId, extra = {}) {
  return shape({
    listings: [
      {
        id,
        posterId,
        posterName: posterId.toUpperCase(),
        categoryId: "basic",
        buttonId: "sup",
        note: "",
        createdAt: T0,
        startAt: null,
        expiresAt: T0 + 30 * MIN,
        state: "open",
        threadId: `th-${id}`,
        panelMessageId: `pm-${id}`,
        ...extra,
      },
    ],
  }).listings[0];
}

const request = (userId, createdAt = T0, extra = {}) => ({
  userId,
  userName: userId.toUpperCase(),
  createdAt,
  status: "pending",
  onHold: false,
  closedAt: null,
  reason: null,
  ...extra,
});

module.exports = { T0, MIN, config, dataWith, listing, request };

// ── a recording fake Discord (Discord-glue task on) ─────────────────────────
// Every REST call lands in `ops` as { op, … }. Messages live per channel id in
// order (oldest first); a DM channel is "dm-<userId>". Options:
//   blockedDms: user ids whose DMs are closed (send → code 50007)
//   failThreads: thread creation throws
//   perms: the bot's permission set in every channel ({ has(bit) })
//   roleFail: role ids whose add/remove throws
function fakeDiscord({ blockedDms = [], failThreads = false, perms = null, roleFail = [] } = {}) {
  const ops = [];
  let next = 1;
  const nid = (p) => `${p}${next++}`;
  const lists = new Map();
  const listOf = (channelId) => {
    if (!lists.has(channelId)) lists.set(channelId, []);
    return lists.get(channelId);
  };
  const unknown = () => Object.assign(new Error("Unknown Message"), { code: 10008 });
  const wrap = (channelId, m) => ({ id: m.id, type: m.type ?? 0, author: { id: m.authorId ?? "bot" }, channelId });
  function messageManager(channelId) {
    return {
      fetch: async (arg) => {
        const list = listOf(channelId);
        if (typeof arg === "string") {
          const m = list.find((x) => x.id === arg);
          if (!m) throw unknown();
          return wrap(channelId, m);
        }
        const limit = (arg && arg.limit) || 50;
        return new Map(list.slice(-limit).reverse().map((m) => [m.id, wrap(channelId, m)]));
      },
      edit: async (id, payload) => {
        const m = listOf(channelId).find((x) => x.id === id);
        if (!m) throw unknown();
        m.payload = payload;
        ops.push({ op: "edit", channelId, messageId: id, payload });
        return wrap(channelId, m);
      },
      delete: async (id) => {
        const list = listOf(channelId);
        const i = list.findIndex((x) => x.id === id);
        if (i === -1) throw unknown();
        list.splice(i, 1);
        ops.push({ op: "delete", channelId, messageId: id });
      },
    };
  }
  const channels = new Map();
  function post(channelId, payload, op = "send") {
    const m = { id: nid("m"), payload };
    listOf(channelId).push(m);
    ops.push({ op, channelId, messageId: m.id, payload });
    return wrap(channelId, m);
  }
  function textChannel(id, extra = {}) {
    const ch = {
      id,
      type: 0,
      guildId: "g1",
      flags: 0,
      permissionsFor: () => perms || { has: () => true },
      send: async (payload) => post(id, payload),
      messages: messageManager(id),
      threads: {
        create: async (opts) => {
          if (failThreads) throw new Error("Missing Permissions");
          const th = thread(nid("th"), id);
          ops.push({ op: "thread", channelId: id, threadId: th.id, opts });
          return th;
        },
      },
      ...extra,
    };
    channels.set(id, ch);
    return ch;
  }
  function thread(id, parentId) {
    return textChannel(id, {
      parentId,
      members: {
        add: async (userId) => ops.push({ op: "threadAdd", threadId: id, userId }),
        remove: async (userId) => ops.push({ op: "threadRemove", threadId: id, userId }),
      },
      setLocked: async (locked) => ops.push({ op: "lock", threadId: id, locked }),
      delete: async () => {
        channels.delete(id);
        ops.push({ op: "threadDelete", threadId: id });
      },
    });
  }
  const users = new Map();
  function user(id) {
    if (!users.has(id)) {
      users.set(id, {
        id,
        displayAvatarURL: () => `https://cdn.example/${id}.png`,
        send: async (payload) => {
          if (blockedDms.includes(id)) throw Object.assign(new Error("Cannot send messages to this user"), { code: 50007 });
          return post(`dm-${id}`, payload, "dm");
        },
        createDM: async () => ({ id: `dm-${id}`, messages: messageManager(`dm-${id}`) }),
      });
    }
    return users.get(id);
  }
  const roles = new Map();
  const members = new Map();
  function member(id, { displayName = id.toUpperCase(), roleIds = [], restRoleIds = null } = {}) {
    const held = new Map(roleIds.map((r) => [r, { id: r }]));
    const m = {
      id,
      displayName,
      restRoleIds,
      send: (payload) => user(id).send(payload),
      roles: {
        cache: held,
        add: async (r) => {
          if (roleFail.includes(r)) throw new Error("Missing Permissions");
          held.set(r, { id: r });
          ops.push({ op: "roleAdd", userId: id, roleId: r });
        },
        remove: async (r) => {
          if (roleFail.includes(r)) throw new Error("Missing Permissions");
          held.delete(r);
          ops.push({ op: "roleRemove", userId: id, roleId: r });
        },
      },
    };
    members.set(id, m);
    return m;
  }
  const guild = {
    id: "g1",
    members: {
      me: { id: "bot", permissions: perms || { has: () => true } },
      cache: members,
      // fetch(id) → the cached object; fetch({ user, force: true }) → what REST
      // says: a member created with `restRoleIds` shows those roles there.
      fetch: async (arg) => {
        const id = typeof arg === "string" ? arg : arg.user;
        const m = members.get(id);
        if (!m) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
        if (typeof arg === "object" && arg.force && m.restRoleIds) {
          return { ...m, roles: { ...m.roles, cache: new Map(m.restRoleIds.map((r) => [r, { id: r }])) } };
        }
        return m;
      },
    },
    roles: { cache: roles, fetch: async () => roles },
    channels: { cache: channels, fetch: async () => channels },
  };
  const client = {
    guilds: { cache: new Map([["g1", guild]]), fetch: async () => guild },
    channels: {
      fetch: async (id) => {
        if (!channels.has(id)) throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        return channels.get(id);
      },
    },
    users: { cache: users, fetch: async (id) => user(id) },
  };
  textChannel("ch1");
  return { client, ops, guild, channels, lists, textChannel, member, user, roles, messagesIn: (id) => listOf(id) };
}

// A ctx for module code: a temp DATA_DIR store, a quiet log and a settable clock.
function fakeCtx(fake, { now = T0 } = {}) {
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs");
  const { createStore } = require("../../core/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bblfg-"));
  const errors = [];
  const ctx = {
    client: fake ? fake.client : null,
    store: createStore(path.join(dir, "lfg.json")),
    config: { DATA_DIR: dir },
    log: { log() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(" ")) },
    errors,
    clock: now,
    now: () => ctx.clock,
  };
  return ctx;
}

module.exports.fakeDiscord = fakeDiscord;
module.exports.fakeCtx = fakeCtx;
