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

test("closeThread: the closing line, then the lock; send / edit / remove report failure instead of throwing", async () => {
  const fake = fakeDiscord();
  const ctx = fakeCtx(fake);
  const th = fake.textChannel("th9", { setLocked: async (v) => fake.ops.push({ op: "lock", threadId: "th9", locked: v }) });
  await D.closeThread(ctx, th.id, "Search expired.");
  assert.deepEqual(fake.ops.map((o) => o.op), ["send", "lock"]);
  assert.deepEqual(fake.ops[0].payload, { content: "Search expired.", allowedMentions: { parse: [] } });
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

test("deliverCard: nothing left to show deletes the card; a card deleted by hand is sent again", async () => {
  const fake = fakeDiscord();
  const ctx = seeded(fake, oneRequest);
  await D.deliverCard(ctx, "u1");
  const id = ops(fake, "dm")[0].messageId;
  fake.messagesIn("dm-u1").length = 0; // the member deleted it
  assert.equal(await D.deliverCard(ctx, "u1"), "sent");
  assert.notEqual(store.load(ctx).dmCards.u1.messageId, id);
  const d = store.load(ctx);
  d.listings = [];
  store.save(ctx, d);
  assert.equal(await D.deliverCard(ctx, "u1"), "deleted");
  assert.equal(store.load(ctx).dmCards.u1, undefined);
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
