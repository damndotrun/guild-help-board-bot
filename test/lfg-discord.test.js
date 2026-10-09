"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ChannelType, MessageFlags, PermissionFlagsBits } = require("discord.js");
const D = require("../modules/lfg/discord");
const store = require("../modules/lfg/store");
const { T0, dataWith, listing, request, fakeDiscord, fakeCtx } = require("./fixtures/lfg-fakes");

const ops = (fake, op) => fake.ops.filter((o) => o.op === op);
function seeded(fake, mutate) {
  const ctx = fakeCtx(fake);
  store.save(ctx, dataWith(mutate));
  return ctx;
}

test("missingPermissions: none, some by name, a hidden channel, an unmentionable ping role", () => {
  const fake = fakeDiscord();
  const ch = fake.channels.get("ch1");
  assert.deepEqual(D.missingPermissions(fake.guild, ch), []);
  const without = (bits) => ({ has: (b) => !bits.includes(b) });
  const limited = fakeDiscord({ perms: without([PermissionFlagsBits.ManageThreads, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.MentionEveryone]) });
  assert.deepEqual(D.missingPermissions(limited.guild, limited.channels.get("ch1")), ["ManageThreads", "ManageRoles"]);
  limited.roles.set("r-gm", { id: "r-gm", mentionable: false });
  assert.deepEqual(D.missingPermissions(limited.guild, limited.channels.get("ch1"), ["r-gm"]), ["ManageThreads", "ManageRoles", "MentionEveryone"]);
  const noHistory = fakeDiscord({ perms: without([PermissionFlagsBits.ReadMessageHistory]) });
  assert.deepEqual(D.missingPermissions(noHistory.guild, noHistory.channels.get("ch1")), ["ReadMessageHistory"]);
  assert.deepEqual(D.missingPermissions(fake.guild, { ...ch, flags: D.CHANNEL_OBFUSCATED }), ["ViewChannel"]);
  assert.deepEqual(D.missingPermissions(fake.guild, null), ["ViewChannel"]);
});

test("missingPermissions: ManageRoles is read from the bot's guild permissions, not the channel's", () => {
  const without = (bits) => ({ has: (b) => !bits.includes(b) });
  const fake = fakeDiscord();
  fake.channels.get("ch1").permissionsFor = () => without([PermissionFlagsBits.ManageRoles]);
  assert.deepEqual(D.missingPermissions(fake.guild, fake.channels.get("ch1")), []);
  fake.guild.members.me.permissions = without([PermissionFlagsBits.ManageRoles]);
  assert.deepEqual(D.missingPermissions(fake.guild, fake.channels.get("ch1")), ["ManageRoles"]);
});

test("openThread: if the searcher cannot be added, the half-opened thread is deleted and the search fails", async () => {
  const fake = fakeDiscord();
  const ctx = fakeCtx(fake);
  const ch = fake.channels.get("ch1");
  const create = ch.threads.create;
  ch.threads.create = async (opts) => {
    const th = await create(opts);
    th.members.add = async () => { throw new Error("Unknown Member"); };
    return th;
  };
  await assert.rejects(D.openThread(ctx, dataWith().config, listing("L1", "u1")), /Unknown Member/);
  const [created] = ops(fake, "thread");
  assert.deepEqual(ops(fake, "threadDelete"), [{ op: "threadDelete", threadId: created.threadId }]);
});

test("openThread: a private, non-invitable thread named after the search, with the searcher added", async () => {
  const fake = fakeDiscord();
  const ctx = fakeCtx(fake);
  const d = dataWith();
  const L = listing("L1", "u1", { posterName: "Dani", categoryId: "ddps", buttonId: "hack" });
  const thread = await D.openThread(ctx, d.config, L);
  const [created] = ops(fake, "thread");
  assert.deepEqual(created.opts, { name: "DDPS · HACK · Dani's search", type: ChannelType.PrivateThread, invitable: false, autoArchiveDuration: 4320 });
  assert.deepEqual(ops(fake, "threadAdd"), [{ op: "threadAdd", threadId: thread.id, userId: "u1" }]);
  assert.equal(D.threadName(d.config, { ...L, posterName: "x".repeat(200) }).length, 100);
  fake.channels.get("ch1").flags = D.CHANNEL_OBFUSCATED;
  await assert.rejects(D.openThread(ctx, d.config, L), /not visible/);
});

test("C: openThread deletes the \"added X to the thread\" system line the searcher's add posted", async () => {
  D._reset();
  const fake = fakeDiscord();
  const ctx = fakeCtx(fake);
  const thread = await D.openThread(ctx, dataWith().config, listing("L1", "u1"));
  const sys = fake.ops.find((o) => o.op === "delete" && o.channelId === thread.id);
  assert.ok(sys, "the system line was deleted");
  assert.deepEqual(fake.messagesIn(thread.id), []);
  assert.deepEqual(ctx.timers, [], "found at once: no retry scheduled");
});

test("C: threadMember add / remove tidy the RecipientAdd / RecipientRemove line — only the bot's, not a member's message", async () => {
  D._reset();
  const fake = fakeDiscord();
  const ctx = fakeCtx(fake);
  const thread = await D.openThread(ctx, dataWith().config, listing("L1", "u1"));
  fake.messagesIn(thread.id).push({ id: "chat1", type: 0, authorId: "u1", payload: {} }, { id: "foreign", type: 1, authorId: "u1", payload: {} });
  assert.equal(await D.threadMember(ctx, thread.id, "u2", "add"), true);
  assert.equal(await D.threadMember(ctx, thread.id, "u2", "remove"), true);
  assert.deepEqual(fake.messagesIn(thread.id).map((m) => m.id), ["chat1", "foreign"]);
});

test("C: nothing found yet → one retry later (the timer); 50013 → the line stays, logged ONCE, nothing breaks", async () => {
  D._reset();
  const fake = fakeDiscord({ noManageMessages: true });
  const ctx = fakeCtx(fake);
  const warnings = [];
  ctx.log.warn = (m) => warnings.push(String(m));
  const thread = await D.openThread(ctx, dataWith().config, listing("L1", "u1"));
  assert.equal(await D.threadMember(ctx, thread.id, "u2", "add"), true);
  assert.equal(fake.messagesIn(thread.id).length, 2, "both system lines stay");
  assert.equal(warnings.filter((w) => w === "Manage Messages needed in the board channel to tidy thread system lines").length, 1);
  // a thread where the line shows up only a moment later
  const late = fakeDiscord();
  const lctx = fakeCtx(late);
  const th = late.textChannel("th-x", { members: { add: async () => {} } });
  assert.equal(await D.threadMember(lctx, "th-x", "u2", "add"), true);
  assert.equal(lctx.timers.length, 1);
  late.messagesIn("th-x").push({ id: "sys-late", type: 1, authorId: "bot", payload: {} });
  await lctx.runTimers();
  assert.deepEqual(late.messagesIn(th.id), []);
  assert.deepEqual(lctx.timers, [], "the retry does not retry again");
});

test("missingOptional: Manage Messages is a SOFT permission — named apart, never in missingPermissions", () => {
  const without = (bits) => ({ has: (b) => !bits.includes(b) });
  const fake = fakeDiscord({ perms: without([PermissionFlagsBits.ManageMessages]) });
  const ch = fake.channels.get("ch1");
  assert.deepEqual(D.missingPermissions(fake.guild, ch), []);
  assert.deepEqual(D.missingOptional(fake.guild, ch), ["ManageMessages"]);
  const full = fakeDiscord();
  assert.deepEqual(D.missingOptional(full.guild, full.channels.get("ch1")), []);
  assert.deepEqual(D.missingOptional(fake.guild, null), []);
});

test("closeThread: lock, then archive (E); archiveThread archives without locking; send / edit / remove report failure instead of throwing", async () => {
  const fake = fakeDiscord();
  const ctx = fakeCtx(fake);
  const th = fake.textChannel("th9", {
    setLocked: async (v) => fake.ops.push({ op: "lock", threadId: "th9", locked: v }),
    setArchived: async (v) => fake.ops.push({ op: "archive", threadId: "th9", archived: v }),
  });
  assert.equal(await D.closeThread(ctx, th.id), true);
  assert.deepEqual(fake.ops.map((o) => [o.op, o.locked ?? o.archived]), [["lock", true], ["archive", true]]);
  fake.ops.length = 0;
  assert.equal(await D.archiveThread(ctx, th.id), true);
  assert.deepEqual(fake.ops.map((o) => o.op), ["archive"]);
  th.setArchived = async () => { throw new Error("Missing Permissions"); };
  assert.equal(await D.archiveThread(ctx, th.id), false);
  assert.equal(await D.closeThread(ctx, null), false);
  assert.equal(await D.archiveThread(ctx, "gone"), false);
  assert.equal(await D.send(ctx, "nope", { content: "x" }), null);
  assert.equal(await D.edit(ctx, "ch1", "missing", { content: "x" }), false);
  assert.equal(await D.remove(ctx, "ch1", "missing"), true); // already gone counts as removed
});

test("setRoles: one refused role does not stop the others", async () => {
  const fake = fakeDiscord({ roleFail: ["r-dps"] });
  const m = fake.member("u1", { roleIds: ["r-radar"] });
  const r = await D.setRoles(fakeCtx(fake), m, { add: ["r-sup", "r-dps"], remove: ["r-radar"] });
  assert.deepEqual(r, { added: ["r-sup"], removed: ["r-radar"], failed: ["r-dps"] });
  assert.deepEqual([...m.roles.cache.keys()], ["r-sup"]);
});

test("lookFor: live display name and avatar from the caches, stored name and default avatar otherwise", () => {
  const fake = fakeDiscord();
  fake.member("u1", { displayName: "Dani (live)" });
  fake.user("u1");
  const look = D.lookFor({ client: fake.client }, fake.guild);
  assert.equal(look.nameOf("u1", "Dani"), "Dani (live)");
  assert.equal(look.nameOf("u2", "Marci"), "Marci");
  assert.equal(look.avatarOf("u1"), "https://cdn.example/u1.png");
  assert.equal(look.avatarOf("u2"), "https://cdn.discordapp.com/embed/avatars/0.png");
});

// ── DM card ────────────────────────────────────────────────────────────────

const oneRequest = (x) => x.listings.push(listing("A", "p1", { posterName: "Marci", requests: [request("u1")] }));

test("deliverCard: the first card is silent; a quiet refresh edits it in place", async () => {
  const fake = fakeDiscord();
  const ctx = seeded(fake, oneRequest);
  assert.equal(await D.deliverCard(ctx, "u1"), "sent");
  const [dm] = ops(fake, "dm");
  assert.equal(dm.payload.flags, MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications);
  assert.deepEqual(store.load(ctx).dmCards.u1, { messageId: dm.messageId, sentAt: T0, lastEventAt: 0, event: null });
  ctx.clock = T0 + 5000;
  assert.equal(await D.deliverCard(ctx, "u1"), "edited");
  assert.deepEqual(ops(fake, "edit").map((o) => o.messageId), [dm.messageId]);
  const lines = store.readLog(path.join(ctx.config.DATA_DIR, store.LOG_FILE)).map((l) => [l.type, l.event]);
  assert.deepEqual(lines, [["dm", "sent"], ["dm", "edited"]]);
});

test("deliverCard: important news replaces the card (notifies, old one deleted); within 30 s it only edits", async () => {
  const fake = fakeDiscord();
  const ctx = seeded(fake, oneRequest);
  await D.deliverCard(ctx, "u1");
  const first = ops(fake, "dm")[0].messageId;
  ctx.clock = T0 + 60_000;
  const event = { kind: "full", listingId: "Z", aboutId: "p3", aboutName: "Dani", label: "DDPS · HACK", emoji: "🧬", startAt: null, at: T0 + 60_000 };
  assert.equal(await D.deliverCard(ctx, "u1", event), "replaced");
  const second = ops(fake, "dm")[1];
  assert.equal(second.payload.flags, MessageFlags.IsComponentsV2); // no SuppressNotifications → it notifies
  assert.deepEqual(ops(fake, "delete").map((o) => o.messageId), [first]);
  const card = store.load(ctx).dmCards.u1;
  assert.deepEqual([card.messageId, card.lastEventAt, card.event.kind], [second.messageId, T0 + 60_000, "full"]);
  ctx.clock = T0 + 80_000;
  assert.equal(await D.deliverCard(ctx, "u1", { ...event, kind: "expired", at: T0 + 80_000 }), "edited");
  assert.equal(store.load(ctx).dmCards.u1.event.kind, "expired");
});

test("deliverCard: closed DMs → blocked for 24 h and the news becomes a notice; switched off → notice, no REST", async () => {
  const fake = fakeDiscord({ blockedDms: ["u1"] });
  const ctx = seeded(fake, oneRequest);
  const event = { kind: "expired", listingId: "A", aboutId: "p1", aboutName: "Marci", label: "BASIC · SUP", emoji: "💥", startAt: null, at: T0 };
  assert.equal(await D.deliverCard(ctx, "u1", event), "blocked");
  let d = store.load(ctx);
  assert.deepEqual(d.dmCards.u1, { blocked: true, since: T0 });
  assert.deepEqual(d.notices.u1.map((n) => n.outcome), ["expired"]);
  assert.equal(await D.deliverCard(ctx, "u1", event), "blocked"); // no retry within 24 h
  assert.equal(ops(fake, "dm").length, 0);
  assert.equal(store.load(ctx).notices.u1.length, 2);
  const off = fakeDiscord();
  const ctx2 = seeded(off, (x) => { oneRequest(x); x.prefs.u1 = { dm: false, requestDm: false }; });
  assert.equal(await D.deliverCard(ctx2, "u1", event), "off");
  assert.equal(off.ops.length, 0);
  assert.equal(store.load(ctx2).notices.u1.length, 1);
  assert.equal(await D.deliverCard(ctx2, "u1", { ...event, kind: "nag" }), "off"); // a nag never becomes a notice
  assert.equal(store.load(ctx2).notices.u1.length, 1);
});

test("deliverCard: nothing left to show edits the card to its empty state (kept, activeAt set); a card deleted by hand is sent again", async () => {
  const fake = fakeDiscord();
  const ctx = seeded(fake, oneRequest);
  await D.deliverCard(ctx, "u1");
  const id = ops(fake, "dm")[0].messageId;
  fake.messagesIn("dm-u1").length = 0; // the member deleted it
  assert.equal(await D.deliverCard(ctx, "u1"), "sent");
  const second = store.load(ctx).dmCards.u1.messageId;
  assert.notEqual(second, id);
  const d = store.load(ctx);
  d.listings = [];
  store.save(ctx, d);
  ctx.clock = T0 + 5000;
  // B5: the card stays, edited to the empty state; the 24 h prune deletes it later
  assert.equal(await D.deliverCard(ctx, "u1"), "edited");
  assert.equal(ops(fake, "delete").length, 0);
  assert.match(JSON.stringify(ops(fake, "edit").at(-1).payload), /You have no open requests right now/);
  const card = store.load(ctx).dmCards.u1;
  assert.deepEqual([card.messageId, card.activeAt], [second, T0 + 5000]);
  // emptied AND deleted by hand: no new empty card is sent, the record goes
  fake.messagesIn("dm-u1").length = 0;
  assert.equal(await D.deliverCard(ctx, "u1"), "deleted");
  assert.equal(store.load(ctx).dmCards.u1, undefined);
  assert.equal(ops(fake, "dm").length, 2);
});

test("deliverCard: a self-withdraw of the last request edits the card; the tick deletes it 24 h later (B5, D4)", async () => {
  const A = require("../modules/lfg/actions");
  const E = require("../modules/lfg/effects");
  const fake = fakeDiscord();
  fake.textChannel("th-A");
  const ctx = seeded(fake, oneRequest);
  await D.deliverCard(ctx, "u1");
  const cardId = ops(fake, "dm")[0].messageId;
  ctx.clock = T0 + 60_000;
  const r = A.withdraw(ctx, { userId: "u1", displayName: "U1", level: "member" }, { listingId: "A" });
  await r.effects();
  assert.equal(fake.messagesIn("dm-u1").length, 1); // still there
  assert.equal(store.load(ctx).dmCards.u1.activeAt, T0 + 60_000);
  ctx.clock = T0 + 60_000 + 24 * 60 * 60_000 - 1;
  await E.tick(ctx);
  assert.equal(fake.messagesIn("dm-u1").length, 1);
  ctx.clock = T0 + 60_000 + 24 * 60 * 60_000;
  await E.tick(ctx);
  assert.deepEqual(ops(fake, "delete").filter((o) => o.channelId === "dm-u1").map((o) => o.messageId), [cardId]);
  assert.equal(store.load(ctx).dmCards.u1, undefined);
  const lines = store.readLog(path.join(ctx.config.DATA_DIR, store.LOG_FILE)).filter((l) => l.type === "dm").map((l) => l.event);
  assert.deepEqual(lines, ["sent", "edited", "deleted"]);
});

test("deliverCard: two events at once still leave exactly one card (per-member queue)", async () => {
  const fake = fakeDiscord();
  const ctx = seeded(fake, oneRequest);
  await Promise.all([D.deliverCard(ctx, "u1"), D.deliverCard(ctx, "u1"), D.deliverCard(ctx, "u1")]);
  assert.equal(ops(fake, "dm").length, 1);
  assert.equal(ops(fake, "edit").length, 2);
});

test("dmNewSearch: opted-in members holding a ping role, never the poster or a busy member; closed DMs skipped", async () => {
  const fake = fakeDiscord({ blockedDms: ["u4"] });
  for (const [id, roles] of [["u1", ["r-sup"]], ["u2", ["r-sup"]], ["u3", ["r-dps"]], ["u4", ["r-sup"]], ["u5", ["r-sup"]]]) fake.member(id, { roleIds: roles });
  const ctx = seeded(fake, (x) => {
    x.prefs = { u1: { dm: true }, u2: { dm: true }, u3: { dm: true }, u4: { dm: true }, u5: { dm: false } };
    x.listings.push(listing("L1", "u1", { posterName: "Dani" }));
  });
  assert.equal(await D.dmNewSearch(ctx, "L1"), 1);
  const [dm] = ops(fake, "dm");
  assert.equal(dm.channelId, "dm-u2");
  assert.match(dm.payload.content, /^\*\*Dani\*\* is looking for \*\*BASIC · SUP\*\* · now — https:\/\/discord\.com\/channels\/g1\/ch1$/);
  assert.equal(dm.payload.components[0].components[0].custom_id, "lfg:join:L1");
  assert.equal(store.load(ctx).listings[0].dmCount, 1);
});

// A DM channel whose messages.edit / messages.delete fail with the given error code.
function breakDm(fake, userId, { edit, del } = {}) {
  const u = fake.user(userId);
  const open = u.createDM;
  u.createDM = async () => {
    const dm = await open();
    if (edit) dm.messages.edit = async () => { throw Object.assign(new Error("boom"), { code: edit }); };
    if (del) dm.messages.delete = async () => { throw Object.assign(new Error("boom"), { code: del }); };
    return dm;
  };
}

test("deliverCard: an edit that fails for any reason but Unknown Message changes nothing and sends no second card", async () => {
  const fake = fakeDiscord();
  const ctx = seeded(fake, oneRequest);
  await D.deliverCard(ctx, "u1");
  const before = store.load(ctx).dmCards.u1;
  breakDm(fake, "u1", { edit: 500 });
  ctx.clock = T0 + 5000;
  assert.equal(await D.deliverCard(ctx, "u1"), "failed");
  assert.deepEqual(store.load(ctx).dmCards.u1, before);
  assert.equal(ops(fake, "dm").length, 1);
  assert.equal(fake.messagesIn("dm-u1").length, 1);
});

test("deliverCard: a replace whose old-card delete fails is logged, the new card still lands, the old one loses its buttons and is kept for a retry (A3)", async () => {
  const fake = fakeDiscord();
  const ctx = seeded(fake, oneRequest);
  const warns = [];
  ctx.log.warn = (...a) => warns.push(a.join(" "));
  await D.deliverCard(ctx, "u1");
  const first = ops(fake, "dm")[0].messageId;
  const u1 = fake.user("u1");
  const open = u1.createDM;
  breakDm(fake, "u1", { del: 500 });
  ctx.clock = T0 + 60_000;
  const event = { kind: "full", listingId: "Z", aboutId: "p3", aboutName: "Dani", label: "DDPS · HACK", emoji: "🧬", startAt: null, at: T0 + 60_000 };
  assert.equal(await D.deliverCard(ctx, "u1", event), "replaced");
  assert.equal(warns.filter((w) => /could not delete the old DM card/.test(w)).length, 1);
  const retired = ops(fake, "edit").find((o) => o.messageId === first);
  assert.match(JSON.stringify(retired.payload), /This card was replaced by a newer one\./);
  assert.doesNotMatch(JSON.stringify(retired.payload), /custom_id/);
  const card = store.load(ctx).dmCards.u1;
  assert.notEqual(card.messageId, first);
  assert.deepEqual(card.staleIds, [first]);
  // the next card job retries the delete first; this time it works
  u1.createDM = open;
  ctx.clock = T0 + 70_000;
  assert.equal(await D.deliverCard(ctx, "u1"), "edited");
  assert.ok(ops(fake, "delete").some((o) => o.messageId === first));
  assert.equal(store.load(ctx).dmCards.u1.staleIds, undefined);
});

test("deliverCard: a stale id already gone (10008) on the retry is dropped; one still failing is kept (A3)", async () => {
  const fake = fakeDiscord();
  const ctx = seeded(fake, (x) => { oneRequest(x); x.dmCards.u1 = { messageId: "card1", sentAt: T0, lastEventAt: 0, event: null, staleIds: ["gone1"] }; });
  fake.messagesIn("dm-u1").push({ id: "card1", payload: {} });
  assert.equal(await D.deliverCard(ctx, "u1"), "edited");
  assert.equal(store.load(ctx).dmCards.u1.staleIds, undefined); // 10008 = gone
  const d = store.load(ctx);
  d.dmCards.u1.staleIds = ["stuck1"];
  store.save(ctx, d);
  breakDm(fake, "u1", { del: 500 });
  assert.equal(await D.deliverCard(ctx, "u1"), "edited");
  assert.deepEqual(store.load(ctx).dmCards.u1.staleIds, ["stuck1"]);
});

test("deleteStaleCard: the 24 h pass also takes the left-behind old cards (A3)", async () => {
  const fake = fakeDiscord();
  const ctx = seeded(fake);
  for (const id of ["c1", "old1"]) fake.messagesIn("dm-u1").push({ id, payload: {} });
  assert.equal(await D.deleteStaleCard(ctx, "u1", "c1", ["old1", "gone"]), "deleted");
  assert.deepEqual(ops(fake, "delete").map((o) => o.messageId).sort(), ["c1", "old1"]);
  assert.equal(fake.messagesIn("dm-u1").length, 0);
});

test("deliverCard: rendering the accepted state clears an old bad-news box, so it cannot come back (B4)", async () => {
  const fake = fakeDiscord();
  const box = { kind: "full", listingId: "Z", aboutId: "p3", aboutName: "Dani", label: "DDPS · HACK", emoji: "🧬", startAt: null, at: T0 };
  const ctx = seeded(fake, (x) => {
    x.listings.push(listing("B", "p2", { posterName: "Bob", state: "confirming", joinerId: "u1", acceptedAt: T0, checkIn: { openedAt: T0, deadline: T0 + 5 * 60_000, nagMessageId: null, at: {}, nags: {} }, requests: [request("u1", T0, { status: "accepted" })] }));
    x.dmCards.u1 = { messageId: "card1", sentAt: T0, lastEventAt: T0, event: box };
  });
  fake.messagesIn("dm-u1").push({ id: "card1", payload: {} });
  assert.equal(await D.deliverCard(ctx, "u1"), "edited");
  assert.equal(store.load(ctx).dmCards.u1.event, null);
  // the game falls through (B reopens): the old "full" box does not resurface
  const d = store.load(ctx);
  d.listings[0].state = "open";
  d.listings[0].joinerId = null;
  d.listings[0].requests[0].status = "pending";
  store.save(ctx, d);
  await D.deliverCard(ctx, "u1");
  assert.doesNotMatch(JSON.stringify(ops(fake, "edit").at(-1).payload), /game is full/);
});

test("deliverCard: bad news while the card shows the accepted state goes to the menu notices, not lost", async () => {
  const fake = fakeDiscord();
  const ctx = seeded(fake, (x) => {
    x.listings.push(listing("B", "p2", { posterName: "Bob", state: "confirming", joinerId: "u1", acceptedAt: T0, checkIn: { openedAt: T0, deadline: T0 + 5 * 60_000, nagMessageId: null, at: {}, nags: {} }, requests: [request("u1", T0, { status: "accepted" })] }));
    x.dmCards.u1 = { messageId: "card1", sentAt: T0, lastEventAt: T0, event: null };
  });
  fake.messagesIn("dm-u1").push({ id: "card1", payload: {} });
  const event = { kind: "full", listingId: "Z", aboutId: "p3", aboutName: "Dani", label: "DDPS · HACK", emoji: "🧬", startAt: null, at: T0 };
  await D.deliverCard(ctx, "u1", event);
  const d = store.load(ctx);
  assert.equal(d.dmCards.u1.event, null);
  assert.deepEqual(d.notices.u1.map((n) => [n.listingId, n.outcome, n.name]), [["Z", "full", "Dani"]]);
});

test("deliverCard: DMs closing under an existing card delete that card before the block is recorded", async () => {
  const closed = [];
  const fake = fakeDiscord({ blockedDms: closed });
  const ctx = seeded(fake, oneRequest);
  await D.deliverCard(ctx, "u1");
  const first = ops(fake, "dm")[0].messageId;
  closed.push("u1");
  ctx.clock = T0 + 60_000;
  const event = { kind: "full", listingId: "Z", aboutId: "p3", aboutName: "Dani", label: "DDPS · HACK", emoji: "🧬", startAt: null, at: T0 + 60_000 };
  assert.equal(await D.deliverCard(ctx, "u1", event), "blocked");
  assert.deepEqual(ops(fake, "delete").map((o) => o.messageId), [first]);
  assert.equal(fake.messagesIn("dm-u1").length, 0);
  assert.deepEqual(store.load(ctx).dmCards.u1, { blocked: true, since: T0 + 60_000 });
  assert.deepEqual(store.load(ctx).notices.u1.map((n) => n.outcome), ["full"]);
});

test("dmNewSearch: the poster's name is escaped, masked links too (D1)", async () => {
  const fake = fakeDiscord();
  fake.member("u2", { roleIds: ["r-sup"] });
  const ctx = seeded(fake, (x) => {
    x.prefs = { u2: { dm: true } };
    x.listings.push(listing("L1", "u1", { posterName: "[x](https://e.com)" }));
  });
  assert.equal(await D.dmNewSearch(ctx, "L1"), 1);
  assert.match(ops(fake, "dm")[0].payload.content, /^\*\*\\\[x\]\(https:\/\/e\.com\)\*\* is looking for/);
});

test("dmNewSearch: 40003 (opening DMs too fast) stops the batch with one log line; 50007 only skips that member (D5)", async () => {
  const fake = fakeDiscord({ blockedDms: ["u2"] });
  for (const id of ["u2", "u3", "u4", "u5"]) fake.member(id, { roleIds: ["r-sup"] });
  const ctx = seeded(fake, (x) => {
    x.prefs = { u2: { dm: true }, u3: { dm: true }, u4: { dm: true }, u5: { dm: true } };
    x.listings.push(listing("L1", "u1", { posterName: "Dani" }));
  });
  const warns = [];
  ctx.log.warn = (...a) => warns.push(a.join(" "));
  const tried = [];
  for (const id of ["u3", "u4", "u5"]) {
    const u = fake.user(id);
    const real = u.send;
    u.send = async (p) => {
      tried.push(id);
      if (id === "u4") throw Object.assign(new Error("You are opening direct messages too fast"), { code: 40003 });
      return real(p);
    };
  }
  assert.equal(await D.dmNewSearch(ctx, "L1"), 1);
  assert.deepEqual(tried, ["u3", "u4"]); // u5 never tried
  assert.deepEqual(ops(fake, "dm").map((o) => o.channelId), ["dm-u3"]);
  assert.equal(warns.filter((w) => /40003/.test(w)).length, 1);
});

test("dmNewSearch: the role check follows REST, not the (stale) member cache", async () => {
  const fake = fakeDiscord();
  fake.member("u2", { roleIds: ["r-dps"], restRoleIds: ["r-sup"] }); // cache stale: now holds the ping role
  fake.member("u3", { roleIds: ["r-sup"], restRoleIds: ["r-dps"] }); // cache stale: lost it
  const ctx = seeded(fake, (x) => {
    x.prefs = { u2: { dm: true }, u3: { dm: true } };
    x.listings.push(listing("L1", "u1", { posterName: "Dani" }));
  });
  assert.equal(await D.dmNewSearch(ctx, "L1"), 1);
  assert.deepEqual(ops(fake, "dm").map((o) => o.channelId), ["dm-u2"]);
});
