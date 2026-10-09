"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MessageType } = require("discord.js");
const C = require("../modules/lfg/channel");
const store = require("../modules/lfg/store");
const { T0, dataWith, listing, fakeDiscord, fakeCtx } = require("./fixtures/lfg-fakes");

beforeEach(() => C._reset());

const LAYOUT = [{ type: "banner", imageUrl: "https://example.com/b.png" }, { type: "panel" }, { type: "board" }];
function setup(mutate, fakeOpts) {
  const fake = fakeDiscord(fakeOpts);
  for (const r of ["r-sup", "r-dps", "r-radar", "r-hack", "r-gm"]) fake.roles.set(r, { id: r, mentionable: true });
  const ctx = fakeCtx(fake);
  store.save(ctx, dataWith((x) => { x.config.layout = LAYOUT; if (mutate) mutate(x); }));
  return { fake, ctx };
}
const sends = (fake) => fake.ops.filter((o) => o.op === "send");

test("tailCheck: our blocks at the bottom (+ the live ping) pass; anything under or between them does not", () => {
  const m = (id, type = 0, authorId = "bot") => ({ id, type, authorId });
  const blocks = ["b1", "b2", "b3"];
  assert.deepEqual(C.tailCheck([m("b3"), m("b2"), m("b1"), m("old")], blocks, null, "bot"), { ok: true, junk: [] });
  assert.deepEqual(C.tailCheck([m("p"), m("b3"), m("b2"), m("b1")], blocks, "p", "bot"), { ok: true, junk: [] });
  assert.equal(C.tailCheck([m("b3"), m("b2"), m("b1")], blocks, "gone", "bot").ok, true); // ping already deleted
  assert.equal(C.tailCheck([m("x", 0, "u1"), m("b3"), m("b2"), m("b1")], blocks, null, "bot").ok, false);
  assert.equal(C.tailCheck([m("b3"), m("x", 0, "u1"), m("b2"), m("b1")], blocks, null, "bot").ok, false);
  assert.equal(C.tailCheck([m("b2"), m("b3"), m("b1")], blocks, null, "bot").ok, false);
  assert.deepEqual(C.tailCheck([m("t", MessageType.ThreadCreated), m("b3"), m("b2"), m("b1")], blocks, null, "bot"), { ok: true, junk: ["t"] });
  assert.equal(C.tailCheck([m("t", MessageType.ThreadCreated, "u1"), m("b3"), m("b2"), m("b1")], blocks, null, "bot").ok, false);
});

test("activeBlocks: a banner without an image is skipped, indexes stay the layout's", () => {
  const blocks = C.activeBlocks({ layout: [{ type: "banner" }, { type: "panel" }, { type: "board" }, { type: "nope" }] });
  assert.deepEqual(blocks.map((b) => [b.type, b.index]), [["panel", 1], ["board", 2]]);
});

test("sync: the first run posts banner · panel · board in order and stores their ids; an unchanged board is not re-sent", async () => {
  const { fake, ctx } = setup();
  assert.equal(await C.sync(ctx), "reposted");
  const posted = sends(fake);
  assert.equal(posted.length, 3);
  assert.equal(posted[0].payload.components[0].type, 12); // MediaGallery
  assert.equal(posted[1].payload.components[0].components[0].accessory.custom_id, "lfg:start");
  assert.deepEqual(posted.map((p) => p.payload.allowedMentions), [{ parse: [] }, { parse: [] }, { parse: [] }]);
  assert.deepEqual(store.load(ctx).channel.messageIds, { 0: posted[0].messageId, 1: posted[1].messageId, 2: posted[2].messageId });
  assert.equal(await C.sync(ctx), "unchanged");
  const d = store.load(ctx);
  d.listings.push(listing("L1", "u1"));
  store.save(ctx, d);
  assert.equal(await C.sync(ctx), "edited");
  assert.deepEqual(fake.ops.filter((o) => o.op === "edit").map((o) => o.messageId), [posted[2].messageId]);
});

test("sync with checkTail: a stranger's message under the blocks → delete and repost in order", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  fake.messagesIn("ch1").push({ id: "x1", payload: {}, authorId: "u1" });
  fake.ops.length = 0;
  assert.equal(await C.sync(ctx, { checkTail: true }), "reposted");
  assert.deepEqual(fake.ops.map((o) => o.op), ["delete", "delete", "delete", "send", "send", "send"]);
  assert.equal(await C.sync(ctx, { checkTail: true }), "unchanged");
});

test("sync: a board deleted by hand is put back; a hidden channel is never posted to", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  const boardId = store.load(ctx).channel.messageIds[2];
  fake.messagesIn("ch1").splice(fake.messagesIn("ch1").findIndex((m) => m.id === boardId), 1);
  const d = store.load(ctx);
  d.listings.push(listing("L1", "u1"));
  store.save(ctx, d);
  assert.equal(await C.sync(ctx), "reposted");
  assert.notEqual(store.load(ctx).channel.messageIds[2], boardId);
  const hidden = setup();
  hidden.fake.channels.get("ch1").flags = 1 << 17;
  assert.equal(await C.sync(hidden.ctx), "hidden");
  assert.equal(hidden.fake.ops.length, 0);
  assert.match(hidden.ctx.errors[0], /can't see the looking-for-game channel/);
});

test("sync: one writer — two syncs at once still post one set of blocks", async () => {
  const { fake, ctx } = setup();
  await Promise.all([C.sync(ctx), C.sync(ctx), C.sync(ctx)]);
  assert.equal(sends(fake).length, 3);
});

test("postPing: under the board, pings only the button's roles, replaces the previous ping; expirePing after 60 s", async () => {
  const { fake, ctx } = setup((x) => {
    x.listings.push(listing("L1", "u1", { posterName: "Dani" }));
    x.listings.push(listing("L2", "u2", { posterName: "Marci", categoryId: "ddps", buttonId: "any" }));
  });
  await C.sync(ctx);
  fake.roles.delete("r-hack"); // a deleted ping role is left out
  const first = await C.postPing(ctx, "L1");
  const ping = fake.ops.find((o) => o.messageId === first);
  assert.deepEqual(ping.payload, { content: "<@&r-sup> **Dani** is looking for **BASIC · SUP** · now", allowedMentions: { roles: ["r-sup"] } });
  assert.deepEqual([store.load(ctx).channel.pingMessageId, store.load(ctx).channel.pingUntil], [first, T0 + 60_000]);
  const second = await C.postPing(ctx, "L2");
  assert.ok(fake.ops.some((o) => o.op === "delete" && o.messageId === first));
  assert.equal(fake.ops.find((o) => o.messageId === second && o.op === "send").payload.allowedMentions.roles.join(), "r-radar");
  assert.equal(await C.expirePing(ctx), false);
  ctx.clock = T0 + 60_000;
  assert.equal(await C.expirePing(ctx), true);
  assert.equal(store.load(ctx).channel.pingMessageId, null);
  assert.ok(fake.ops.some((o) => o.op === "delete" && o.messageId === second));
});

test("postPing: no ping role left → no ping; resetPanel re-sends the panel to clear a pick", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1", { buttonId: "gm" })));
  await C.sync(ctx);
  fake.roles.delete("r-gm");
  assert.equal(await C.postPing(ctx, "L1"), null);
  await C.resetPanel(ctx);
  const panelId = store.load(ctx).channel.messageIds[1];
  const edits = fake.ops.filter((o) => o.op === "edit");
  assert.deepEqual(edits.map((o) => o.messageId), [panelId]);
  // the re-sent picker carries a new custom_id, so the client does not freeze it
  const pickerId = (p) => p.components[0].components[1].components[0].custom_id;
  const posted = fake.ops.find((o) => o.op === "send" && o.messageId === panelId);
  assert.notEqual(pickerId(edits[0].payload), pickerId(posted.payload));
});

test("sync with checkTail: unreadable history skips the position check but still edits the board", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  fake.channels.get("ch1").messages.fetch = async () => { throw new Error("Missing Access"); };
  const d = store.load(ctx);
  d.listings.push(listing("L1", "u1"));
  store.save(ctx, d);
  assert.equal(await C.sync(ctx, { checkTail: true }), "edited");
});

test("repost: a board that cannot be rendered is posted as the empty board — its id is kept, no repost loop", async () => {
  const R = require("../modules/lfg/render");
  const real = R.renderBoard;
  R.renderBoard = () => null;
  try {
    const { fake, ctx } = setup();
    assert.equal(await C.sync(ctx), "reposted");
    const ids = store.load(ctx).channel.messageIds;
    assert.equal(Object.keys(ids).length, 3);
    assert.match(JSON.stringify(fake.ops.find((o) => o.messageId === ids[2]).payload), /No one is looking right now/);
    assert.equal(await C.sync(ctx, { checkTail: true }), "invalid"); // kept, not reposted
    assert.deepEqual(store.load(ctx).channel.messageIds, ids);
  } finally {
    R.renderBoard = real;
  }
});

test("sync with checkTail: an EMPTY history (no Read Message History — Discord does not throw) is not a reason to repost, and is logged once", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  fake.channels.get("ch1").messages.fetch = async () => new Map();
  const d = store.load(ctx);
  d.listings.push(listing("L1", "u1"));
  store.save(ctx, d);
  fake.ops.length = 0;
  ctx.warnings = [];
  const warn = ctx.log.warn;
  ctx.log.warn = (...a) => { ctx.warnings.push(a.join(" ")); return warn && warn(...a); };
  assert.equal(await C.sync(ctx, { checkTail: true }), "edited");
  assert.equal(await C.sync(ctx, { checkTail: true }), "unchanged");
  assert.equal(await C.sync(ctx, { checkTail: true }), "unchanged");
  assert.deepEqual(fake.ops.map((o) => o.op), ["edit"]); // no delete, no send
  assert.equal(ctx.warnings.filter((w) => /tail check skipped/.test(w)).length, 1);
});

test("sync with checkTail: a NON-empty history without our blocks means they are buried → repost once, then calm (C1)", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  for (let i = 0; i < 10; i++) fake.messagesIn("ch1").push({ id: `chat${i}`, payload: {}, authorId: "u1" });
  fake.ops.length = 0;
  assert.equal(await C.sync(ctx, { checkTail: true }), "reposted");
  assert.deepEqual(fake.ops.map((o) => o.op), ["delete", "delete", "delete", "send", "send", "send"]);
  assert.equal(await C.sync(ctx, { checkTail: true }), "unchanged"); // the blocks are the newest now: no loop
});

test("repost: a send failing half-way leaves no orphan — the ids sent so far are stored and deleted by the next sync", async () => {
  const { fake, ctx } = setup();
  const ch = fake.channels.get("ch1");
  const realSend = ch.send;
  let calls = 0;
  ch.send = async (payload) => {
    if (++calls === 2) throw new Error("boom");
    return realSend(payload);
  };
  await C.sync(ctx); // 1st block sent, 2nd throws (logged by the chain)
  const partial = store.load(ctx).channel.messageIds;
  assert.deepEqual(Object.keys(partial), ["0"]);
  assert.equal(fake.messagesIn("ch1").length, 1);
  assert.equal(await C.sync(ctx), "reposted");
  assert.equal(fake.messagesIn("ch1").length, 3); // no orphan of the first attempt
  assert.ok(!fake.messagesIn("ch1").some((m) => m.id === partial[0]));
  assert.equal(Object.keys(store.load(ctx).channel.messageIds).length, 3);
});

test("sync: a hidden channel is logged once, not on every tick; seeing it again re-arms the log", async () => {
  const { fake, ctx } = setup();
  fake.channels.get("ch1").flags = 1 << 17;
  await C.sync(ctx);
  await C.sync(ctx);
  assert.equal(ctx.errors.filter((e) => /can't see the looking-for-game channel/.test(e)).length, 1);
  fake.channels.get("ch1").flags = 0;
  assert.equal(await C.sync(ctx), "reposted");
  fake.channels.get("ch1").flags = 1 << 17;
  await C.sync(ctx);
  assert.equal(ctx.errors.filter((e) => /can't see the looking-for-game channel/.test(e)).length, 2);
});

test("enqueue: the job never receives the previous job's result", async () => {
  const { ctx } = setup();
  await C.enqueue(ctx, async () => "first");
  let seen = "unset";
  await C.enqueue(ctx, async (...args) => { seen = args; });
  assert.deepEqual(seen, []);
});
