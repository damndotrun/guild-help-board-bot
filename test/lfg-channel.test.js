"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { ComponentType, MessageFlags, MessageType } = require("discord.js");
const { messageErrors, walk } = require("../core/panel");
const C = require("../modules/lfg/channel");
const R = require("../modules/lfg/render");
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
const mainId = (ctx) => store.load(ctx).channel.mainMessageId;
const pickerId = (p) => p.components[1].components[1].components[0].custom_id; // banner, then the panel box
const ids = (payload) => { const out = []; walk(payload, (c) => { if (c.custom_id) out.push(c.custom_id); }); return out; };

test("tailCheck: our message at the bottom (+ the live ping) passes; anything under it does not", () => {
  const m = (id, type = 0, authorId = "bot") => ({ id, type, authorId });
  assert.deepEqual(C.tailCheck([m("b"), m("old")], "b", null, "bot"), { ok: true, junk: [] });
  assert.deepEqual(C.tailCheck([m("p"), m("b")], "b", "p", "bot"), { ok: true, junk: [] });
  assert.equal(C.tailCheck([m("b")], "b", "gone", "bot").ok, true); // ping already deleted
  assert.equal(C.tailCheck([m("x", 0, "u1"), m("b")], "b", null, "bot").ok, false);
  assert.equal(C.tailCheck([m("x", 0, "u1"), m("p"), m("b")], "b", "p", "bot").ok, false); // under the ping too
  assert.equal(C.tailCheck([m("old")], "b", null, "bot").ok, false); // buried out of the window
  assert.deepEqual(C.tailCheck([m("t", MessageType.ThreadCreated), m("b")], "b", null, "bot"), { ok: true, junk: ["t"] });
  assert.deepEqual(C.tailCheck([m("p"), m("t", MessageType.ThreadCreated), m("b")], "b", "p", "bot"), { ok: true, junk: ["t"] });
  assert.equal(C.tailCheck([m("t", MessageType.ThreadCreated, "u1"), m("b")], "b", null, "bot").ok, false);
});

test("activeBlocks: a banner without an image is skipped, indexes stay the layout's", () => {
  const blocks = C.activeBlocks({ layout: [{ type: "banner" }, { type: "panel" }, { type: "board" }, { type: "nope" }] });
  assert.deepEqual(blocks.map((b) => [b.type, b.index]), [["panel", 1], ["board", 2]]);
});

test("sync: the first run posts exactly ONE message — banner · panel · board stacked — and stores its id; an unchanged one is not re-sent", async () => {
  const { fake, ctx } = setup();
  assert.equal(await C.sync(ctx), "reposted");
  assert.deepEqual(fake.ops.map((o) => o.op), ["send"]); // nothing else
  const [posted] = sends(fake);
  const p = posted.payload;
  assert.equal(p.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(p.allowedMentions, { parse: [] });
  assert.equal(p.components[0].type, ComponentType.MediaGallery);
  assert.equal(p.components[1].components[0].accessory.custom_id, "lfg:start");
  assert.match(JSON.stringify(p.components[2]), /No one is looking right now/);
  assert.equal(p.components.length, 3);
  assert.deepEqual(messageErrors(p, { prefixes: R.PREFIXES }), []);
  assert.equal(mainId(ctx), posted.messageId);
  assert.equal(store.load(ctx).channel.messageIds, undefined);
  assert.equal(await C.sync(ctx), "unchanged"); // the picker's fresh tag alone is no change
  assert.equal(await C.sync(ctx, { checkTail: true }), "unchanged");
  assert.equal(fake.messagesIn("ch1").length, 1);
});

test("sync: a board change edits only the one message, in place", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  const id = mainId(ctx);
  const d = store.load(ctx);
  d.listings.push(listing("L1", "u1"));
  store.save(ctx, d);
  fake.ops.length = 0;
  assert.equal(await C.sync(ctx), "edited");
  assert.deepEqual(fake.ops.map((o) => [o.op, o.messageId]), [["edit", id]]);
  const p = fake.ops[0].payload;
  assert.ok(ids(p).includes("lfg:start") && ids(p).includes("lfg:join:L1"), "the panel and the board are in the same message");
  assert.equal(p.components[0].type, ComponentType.MediaGallery);
  assert.equal(await C.sync(ctx), "unchanged");
});

test("sync with checkTail: a stranger's message under ours → delete it and repost once", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  const old = mainId(ctx);
  fake.messagesIn("ch1").push({ id: "x1", payload: {}, authorId: "u1" });
  fake.ops.length = 0;
  assert.equal(await C.sync(ctx, { checkTail: true }), "reposted");
  assert.deepEqual(fake.ops.map((o) => [o.op, o.op === "delete" ? o.messageId : "new"]), [["delete", old], ["send", "new"]]);
  assert.notEqual(mainId(ctx), old);
  assert.equal(await C.sync(ctx, { checkTail: true }), "unchanged");
});

test("sync with checkTail: our message, the ping above it and a bot thread line are fine — the line is deleted, no repost", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1")));
  await C.sync(ctx);
  const ping = await C.postPing(ctx, "L1");
  fake.messagesIn("ch1").push({ id: "t1", payload: {}, type: MessageType.ThreadCreated, authorId: "bot" });
  fake.ops.length = 0;
  assert.equal(await C.sync(ctx, { checkTail: true }), "unchanged");
  assert.deepEqual(fake.ops.map((o) => [o.op, o.messageId]), [["delete", "t1"]]);
  assert.ok(fake.messagesIn("ch1").some((m) => m.id === ping));
});

test("sync: the message deleted by hand is put back; a hidden channel is never posted to", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  const old = mainId(ctx);
  fake.messagesIn("ch1").splice(fake.messagesIn("ch1").findIndex((m) => m.id === old), 1);
  const d = store.load(ctx);
  d.listings.push(listing("L1", "u1"));
  store.save(ctx, d);
  assert.equal(await C.sync(ctx), "reposted"); // the edit hit 10008
  assert.notEqual(mainId(ctx), old);
  assert.equal(fake.messagesIn("ch1").length, 1);
  const hidden = setup();
  hidden.fake.channels.get("ch1").flags = 1 << 17;
  assert.equal(await C.sync(hidden.ctx), "hidden");
  assert.equal(hidden.fake.ops.length, 0);
  assert.match(hidden.ctx.errors[0], /can't see the looking-for-game channel/);
});

test("sync: one writer — three syncs at once still post one message", async () => {
  const { fake, ctx } = setup();
  await Promise.all([C.sync(ctx), C.sync(ctx), C.sync(ctx)]);
  assert.equal(sends(fake).length, 1);
});

test("sync: a store with the old per-block ids → one repost that deletes them all and stores one id", async () => {
  const { fake, ctx } = setup();
  for (const id of ["old0", "old1"]) fake.messagesIn("ch1").push({ id, payload: {} });
  const d = store.load(ctx);
  d.channel.messageIds = { 0: "old0", 1: "old1", 2: "old2" }; // old2 is already gone (10008 = fine)
  store.save(ctx, d);
  assert.deepEqual(store.load(ctx).channel.messageIds, { 0: "old0", 1: "old1", 2: "old2" }); // shape keeps it until the repost
  assert.equal(await C.sync(ctx), "reposted");
  assert.deepEqual(fake.ops.map((o) => [o.op, o.messageId]), [["delete", "old0"], ["delete", "old1"], ["send", fake.ops[2].messageId]]);
  assert.equal(mainId(ctx), fake.ops[2].messageId);
  assert.equal(store.load(ctx).channel.messageIds, undefined);
  assert.deepEqual(fake.messagesIn("ch1").map((m) => m.id), [mainId(ctx)]);
  assert.equal(ctx.errors.length, 0);
  assert.equal(await C.sync(ctx, { checkTail: true }), "unchanged");
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

test("postPing: no ping role left → no ping", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1", { buttonId: "gm" })));
  await C.sync(ctx);
  fake.roles.delete("r-gm");
  fake.ops.length = 0;
  assert.equal(await C.postPing(ctx, "L1"), null);
  assert.deepEqual(fake.ops, []);
});

test("resetPanel: edits the one message even when the board is unchanged — the picker gets a new custom_id; the hash cache follows", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1")));
  await C.sync(ctx);
  const id = mainId(ctx);
  const posted = sends(fake)[0];
  assert.equal(await C.sync(ctx), "unchanged");
  fake.ops.length = 0;
  await C.resetPanel(ctx);
  assert.deepEqual(fake.ops.map((o) => [o.op, o.messageId]), [["edit", id]]);
  const edited = fake.ops[0].payload;
  assert.notEqual(pickerId(edited), pickerId(posted.payload)); // the client does not freeze it
  assert.ok(ids(edited).includes("lfg:join:L1"), "the board rides along in the same message");
  assert.deepEqual(edited.allowedMentions, { parse: [] });
  assert.equal(await C.sync(ctx), "unchanged"); // nothing changed since the reset
  assert.equal(fake.ops.length, 1);
});

test("resetPanel: no message yet / no panel in the layout → nothing is sent", async () => {
  const { fake, ctx } = setup();
  await C.resetPanel(ctx);
  assert.equal(fake.ops.length, 0);
  const other = setup((x) => { x.config.layout = [{ type: "board" }]; });
  await C.sync(other.ctx);
  other.fake.ops.length = 0;
  await C.resetPanel(other.ctx);
  assert.equal(other.fake.ops.length, 0);
});

test("sync: a layout with nothing to show posts no (empty) message and takes ours down", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  const old = mainId(ctx);
  const d = store.load(ctx);
  d.config.layout = [{ type: "banner" }]; // a banner without an image is skipped
  store.save(ctx, d);
  fake.ops.length = 0;
  assert.equal(await C.sync(ctx), "empty");
  assert.deepEqual(fake.ops.map((o) => [o.op, o.messageId]), [["delete", old]]);
  assert.equal(mainId(ctx), null);
  assert.equal(await C.sync(ctx, { checkTail: true }), "empty");
  assert.equal(fake.ops.length, 1);
});

test("sync with checkTail: unreadable history skips the position check but still edits the message", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  fake.channels.get("ch1").messages.fetch = async () => { throw new Error("Missing Access"); };
  const d = store.load(ctx);
  d.listings.push(listing("L1", "u1"));
  store.save(ctx, d);
  assert.equal(await C.sync(ctx, { checkTail: true }), "edited");
});

test("the board's row cap gets only the budget LEFT after the banner and panel: a board that fits alone shows +N more beside them", () => {
  const d = dataWith((x) => {
    x.config.layout = LAYOUT;
    for (let i = 0; i < 12; i++) x.listings.push(listing(`L${i}`, `u${i}`, { createdAt: T0 + i }));
  });
  const joins = (p) => ids(p).filter((id) => id.startsWith("lfg:join:")).length;
  const alone = R.renderBoard(d, T0);
  assert.equal(joins(alone), 12); // 4 + 12×3 = 40 components: fits on its own
  assert.doesNotMatch(JSON.stringify(alone), /more — open/);
  const stack = R.renderStack(d, C.activeBlocks(d.config), T0);
  assert.ok(stack, "the stack renders instead of failing");
  assert.deepEqual(messageErrors(stack, { prefixes: R.PREFIXES }), []);
  const shown = joins(stack);
  assert.ok(shown > 0 && shown < 12, `shown ${shown}`);
  assert.match(JSON.stringify(stack), new RegExp(`\\+${12 - shown} more — open`));
  assert.ok(ids(stack).includes("lfg:start"));
});

test("repost: blocks that cannot fit one message post the panel + the empty board — the id is kept, no repost loop", async () => {
  const real = R.renderStack;
  R.renderStack = () => null;
  try {
    const { fake, ctx } = setup();
    assert.equal(await C.sync(ctx), "reposted");
    const id = mainId(ctx);
    assert.ok(id);
    const p = fake.ops.find((o) => o.messageId === id).payload;
    assert.ok(ids(p).includes("lfg:start"));
    assert.match(JSON.stringify(p), /No one is looking right now/);
    assert.deepEqual(p.allowedMentions, { parse: [] });
    assert.ok(ctx.errors.some((e) => /do not fit one message/.test(e)));
    assert.equal(await C.sync(ctx, { checkTail: true }), "invalid"); // kept, not reposted
    assert.equal(mainId(ctx), id);
  } finally {
    R.renderStack = real;
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

test("sync with checkTail: a NON-empty history without our message means it is buried → repost once, then calm (C1)", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  for (let i = 0; i < 10; i++) fake.messagesIn("ch1").push({ id: `chat${i}`, payload: {}, authorId: "u1" });
  fake.ops.length = 0;
  assert.equal(await C.sync(ctx, { checkTail: true }), "reposted");
  assert.deepEqual(fake.ops.map((o) => o.op), ["delete", "send"]);
  assert.equal(await C.sync(ctx, { checkTail: true }), "unchanged"); // ours is the newest now: no loop
});

test("repost: a failing send leaves no id — the next sync posts again, with no orphan", async () => {
  const { fake, ctx } = setup();
  const ch = fake.channels.get("ch1");
  const realSend = ch.send;
  let calls = 0;
  ch.send = async (payload) => {
    if (++calls === 1) throw new Error("boom");
    return realSend(payload);
  };
  await C.sync(ctx); // the send throws (logged by the chain)
  assert.equal(mainId(ctx), null);
  assert.equal(fake.messagesIn("ch1").length, 0);
  assert.ok(ctx.errors.some((e) => /channel write failed/.test(e)));
  assert.equal(await C.sync(ctx), "reposted");
  assert.equal(fake.messagesIn("ch1").length, 1);
  assert.equal(mainId(ctx), fake.messagesIn("ch1")[0].id);
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
