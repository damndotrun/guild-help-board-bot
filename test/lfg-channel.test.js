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
  assert.deepEqual(C.tailCheck([m("b"), m("old", 0, "u1")], "b", null, "bot"), { ok: true, junk: [] });
  assert.deepEqual(C.tailCheck([m("p"), m("b")], "b", "p", "bot"), { ok: true, junk: [] });
  assert.equal(C.tailCheck([m("b")], "b", "gone", "bot").ok, true); // ping already deleted
  assert.equal(C.tailCheck([m("x", 0, "u1"), m("b")], "b", null, "bot").ok, false);
  assert.equal(C.tailCheck([m("x", 0, "u1"), m("p"), m("b")], "b", "p", "bot").ok, false); // under the ping too
  assert.equal(C.tailCheck([m("old", 0, "u1")], "b", null, "bot").ok, false); // buried out of the window
  assert.deepEqual(C.tailCheck([m("t", MessageType.ThreadCreated), m("b")], "b", null, "bot"), { ok: true, junk: ["t"] });
  assert.deepEqual(C.tailCheck([m("p"), m("t", MessageType.ThreadCreated), m("b")], "b", "p", "bot"), { ok: true, junk: ["t"] });
  assert.equal(C.tailCheck([m("t", MessageType.ThreadCreated, "u1"), m("b")], "b", null, "bot").ok, false);
});

test("tailCheck: a plain bot message that is neither ours nor the ping is an orphan — junk, wherever it sits; a stranger's is not", () => {
  const m = (id, type = 0, authorId = "bot") => ({ id, type, authorId });
  assert.deepEqual(C.tailCheck([m("b"), m("orphan"), m("u", 0, "u1")], "b", null, "bot"), { ok: true, junk: ["orphan"] }); // above ours: a crash before the save
  assert.deepEqual(C.tailCheck([m("orphan"), m("p"), m("b")], "b", "p", "bot"), { ok: true, junk: ["orphan"] }); // under the ping
  assert.deepEqual(C.tailCheck([m("p"), m("b")], "b", "p", "bot").junk, []); // ours and the ping are never junk
  assert.deepEqual(C.tailCheck([m("x", 0, "u1"), m("b")], "b", null, "bot"), { ok: false, junk: [] });
  assert.deepEqual(C.tailCheck([m("r", MessageType.Reply), m("b")], "b", null, "bot"), { ok: false, junk: [] }); // only plain (Default) bot messages
});

test("sync with checkTail: an orphan of ours (crash between send and save) is deleted, no repost", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  const id = mainId(ctx);
  const list = fake.messagesIn("ch1");
  list.unshift({ id: "orphan-above", payload: {} }); // the bot's own, older
  list.push({ id: "orphan-below", payload: {} }); // the bot's own, newer
  fake.ops.length = 0;
  assert.equal(await C.sync(ctx, { checkTail: true }), "unchanged");
  assert.deepEqual(fake.ops.map((o) => [o.op, o.messageId]).sort(), [["delete", "orphan-above"], ["delete", "orphan-below"]]);
  assert.deepEqual(fake.messagesIn("ch1").map((m) => m.id), [id]);
});

test("activeBlocks: a banner without an image is skipped, indexes stay the layout's", () => {
  const blocks = C.activeBlocks({ layout: [{ type: "banner" }, { type: "panel" }, { type: "board" }, { type: "nope" }] });
  assert.deepEqual(blocks.map((b) => [b.type, b.index]), [["panel", 1], ["board", 2]]);
});

test("activeBlocks: a duplicate block type is dropped — the first (renderable) one wins; the stack stays valid", () => {
  const layout = [{ type: "banner" }, { type: "panel" }, { type: "board" }, { type: "panel" }, { type: "banner", imageUrl: "https://example.com/2.png" }, { type: "board" }];
  const blocks = C.activeBlocks({ layout });
  assert.deepEqual(blocks.map((b) => [b.type, b.index]), [["panel", 1], ["board", 2], ["banner", 4]]);
  const d = dataWith((x) => { x.config.layout = layout; });
  const stack = R.renderStack(d, C.activeBlocks(d.config), T0);
  assert.deepEqual(messageErrors(stack, { prefixes: R.PREFIXES }), []);
  assert.equal(ids(stack).filter((id) => id === "lfg:start").length, 1);
  // renderStack itself also keeps one per type, even when handed duplicates
  const raw = R.renderStack(d, layout.map((b, index) => ({ ...b, index })).filter((b) => b.type !== "banner"), T0);
  assert.deepEqual(messageErrors(raw, { prefixes: R.PREFIXES }), []);
});

test("sync: the first run posts exactly ONE message — banner · panel (· board) stacked — and stores its id; an unchanged one is not re-sent", async () => {
  const { fake, ctx } = setup();
  assert.equal(await C.sync(ctx), "reposted");
  assert.deepEqual(fake.ops.map((o) => o.op), ["send"]); // nothing else
  const [posted] = sends(fake);
  const p = posted.payload;
  assert.equal(p.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(p.allowedMentions, { parse: [] });
  assert.equal(p.components[0].type, ComponentType.MediaGallery);
  assert.equal(p.components[1].components[0].accessory.custom_id, "lfg:start");
  // item G: an empty board adds NO component beside the banner and the panel
  assert.doesNotMatch(JSON.stringify(p), /No one is looking right now/);
  assert.equal(p.components.length, 2);
  assert.deepEqual(messageErrors(p, { prefixes: R.PREFIXES }), []);
  assert.equal(mainId(ctx), posted.messageId);
  assert.equal(store.load(ctx).channel.messageIds, undefined);
  assert.equal(await C.sync(ctx), "unchanged"); // the picker's fresh tag alone is no change
  assert.equal(await C.sync(ctx, { checkTail: true }), "unchanged");
  assert.equal(fake.messagesIn("ch1").length, 1);
});

test("item G: no search → only the banner and the panel; a search appears → its board box joins the SAME message (an edit); it leaves → the box goes again", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  const id = mainId(ctx);
  const d = store.load(ctx);
  d.listings.push(listing("L1", "u1"));
  store.save(ctx, d);
  assert.equal(await C.sync(ctx, { checkTail: true }), "edited");
  const edit = fake.ops.filter((o) => o.op === "edit").at(-1);
  assert.equal(edit.messageId, id);
  assert.equal(edit.payload.components.length, 3);
  assert.ok(ids(edit.payload).includes("lfg:join:L1"));
  assert.equal(sends(fake).length, 1, "no repost");
  const e = store.load(ctx);
  e.listings = [];
  store.save(ctx, e);
  assert.equal(await C.sync(ctx), "edited");
  assert.equal(fake.ops.filter((o) => o.op === "edit").at(-1).payload.components.length, 2);
  assert.equal(mainId(ctx), id);
});

test("item G: a board-only layout still shows the No one is looking box (a V2 message cannot be empty); banner + board shows the banner alone", () => {
  const boardOnly = dataWith();
  assert.match(JSON.stringify(R.renderStack(boardOnly, C.activeBlocks(boardOnly.config), T0)), /No one is looking right now/);
  const bannerBoard = dataWith((x) => { x.config.layout = [LAYOUT[0], { type: "board" }]; });
  const p = R.renderStack(bannerBoard, C.activeBlocks(bannerBoard.config), T0);
  assert.deepEqual(p.components.map((c) => c.type), [ComponentType.MediaGallery]);
  assert.deepEqual(messageErrors(p, { prefixes: R.PREFIXES }), []);
});

test("picker tag: a board-only edit keeps the select's custom_id; resetPanel changes it; the next board edit keeps the new one", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  const posted = pickerId(sends(fake)[0].payload);
  const addListing = (id) => { const d = store.load(ctx); d.listings.push(listing(id, `u-${id}`)); store.save(ctx, d); };
  addListing("L1");
  assert.equal(await C.sync(ctx), "edited");
  const edits = () => fake.ops.filter((o) => o.op === "edit");
  assert.equal(pickerId(edits()[0].payload), posted, "a board edit keeps the picker as it was");
  await C.resetPanel(ctx);
  const reset = pickerId(edits()[1].payload);
  assert.notEqual(reset, posted, "resetPanel mints a fresh one");
  addListing("L2");
  assert.equal(await C.sync(ctx), "edited");
  assert.equal(pickerId(edits()[2].payload), reset, "and later board edits keep that one");
});

test("picker tag: a repost (new message) gets a fresh tag; a failed resetPanel edit keeps the old one", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  const first = pickerId(sends(fake)[0].payload);
  fake.messagesIn("ch1").push({ id: "x1", payload: {}, authorId: "u1" });
  assert.equal(await C.sync(ctx, { checkTail: true }), "reposted");
  const second = pickerId(sends(fake)[1].payload);
  assert.notEqual(second, first);
  const ch = fake.channels.get("ch1");
  const realEdit = ch.messages.edit;
  ch.messages.edit = async () => { throw new Error("Missing Access"); };
  await C.resetPanel(ctx); // logged by D.edit, tag not adopted
  ch.messages.edit = realEdit;
  const d = store.load(ctx);
  d.listings.push(listing("L1", "u1"));
  store.save(ctx, d);
  assert.equal(await C.sync(ctx), "edited");
  assert.equal(pickerId(fake.ops.filter((o) => o.op === "edit").pop().payload), second);
});

test("a custom emoji the guild no longer has is dropped from its picker option (the option stays); a known one is kept; no cache = present", async () => {
  const GONE = "<:sup:111111111111111111>";
  const HERE = "<:dps:222222222222222222>";
  const { fake, ctx } = setup((x) => {
    x.config.categories[0].buttons[0].emoji = GONE;
    x.config.categories[0].buttons[1].emoji = HERE;
  });
  fake.guild.emojis = { cache: new Map([["222222222222222222", { id: "222222222222222222" }]]) };
  await C.sync(ctx);
  const options = sends(fake)[0].payload.components[1].components[1].components[0].options;
  const byRole = Object.fromEntries(options.map((o) => [o.value, o]));
  assert.equal(byRole["r-sup"].emoji, undefined, "the gone emoji is dropped");
  assert.equal(byRole["r-sup"].label, "BASIC · SUP", "the option itself stays");
  assert.equal(byRole["r-dps"].emoji.id, "222222222222222222");
  assert.equal(byRole["r-radar"].emoji.name, "🧬"); // unicode emoji: never checked
  // the pure renderer: without a hasEmoji check (unknown cache) every emoji counts as present
  const d = store.load(ctx);
  const plain = R.renderPanel(d.config).components[0].components[1].components[0].options;
  assert.equal(plain.find((o) => o.value === "r-sup").emoji.id, "111111111111111111");
  // unparsable emoji text never yields `emoji: null`
  d.config.categories[0].buttons[0].emoji = "<a:x:1>";
  const odd = R.renderPanel(d.config).components[0].components[1].components[0].options.find((o) => o.value === "r-sup");
  assert.ok(!("emoji" in odd) || (odd.emoji && odd.emoji.name), JSON.stringify(odd));
});

test("sync: an edit Discord refuses (not 10008) is logged ONCE, not thrown every tick; a later good edit re-arms the log", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  const ch = fake.channels.get("ch1");
  const realEdit = ch.messages.edit;
  ch.messages.edit = async () => { throw Object.assign(new Error("Invalid Form Body"), { code: 50035 }); };
  const addListing = (id) => { const d = store.load(ctx); d.listings.push(listing(id, `u-${id}`)); store.save(ctx, d); };
  addListing("L1");
  assert.equal(await C.sync(ctx), "failed");
  assert.equal(await C.sync(ctx, { checkTail: true }), "failed"); // retried (the hash was not stored), no repost
  const editErrors = () => ctx.errors.filter((e) => /could not edit the channel message/.test(e)).length;
  assert.equal(editErrors(), 1);
  assert.ok(!ctx.errors.some((e) => /channel write failed/.test(e)), "no stack trace through the chain");
  ch.messages.edit = realEdit;
  assert.equal(await C.sync(ctx), "edited");
  ch.messages.edit = async () => { throw Object.assign(new Error("Invalid Form Body"), { code: 50035 }); };
  addListing("L2");
  assert.equal(await C.sync(ctx), "failed");
  assert.equal(editErrors(), 2);
});

test("repost: an old message whose delete fails (not 10008) stays tracked in staleIds and is retried until gone", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  const old = mainId(ctx);
  const ch = fake.channels.get("ch1");
  const realDelete = ch.messages.delete;
  ch.messages.delete = async (id) => { if (id === old) throw Object.assign(new Error("Service Unavailable"), { code: 0 }); return realDelete(id); };
  fake.messagesIn("ch1").push({ id: "x1", payload: {}, authorId: "u1" });
  assert.equal(await C.sync(ctx, { checkTail: true }), "reposted");
  const fresh = mainId(ctx);
  assert.notEqual(fresh, old);
  assert.deepEqual(store.load(ctx).channel.staleIds, [old], "never untracked");
  assert.equal(await C.sync(ctx), "unchanged"); // still failing: kept, no repost loop
  assert.deepEqual(store.load(ctx).channel.staleIds, [old]);
  assert.equal(ctx.errors.length, 0);
  ch.messages.delete = realDelete;
  assert.equal(await C.sync(ctx), "unchanged");
  assert.deepEqual(store.load(ctx).channel.staleIds, []);
  assert.ok(!fake.messagesIn("ch1").some((m) => m.id === old));
  assert.equal(mainId(ctx), fresh);
});

test("empty layout: a failed delete keeps the id (retried next tick); 10008 counts as gone", async () => {
  const { fake, ctx } = setup();
  await C.sync(ctx);
  const old = mainId(ctx);
  const d = store.load(ctx);
  d.config.layout = [];
  d.channel.messageIds = { 0: "legacy-gone" }; // not in the channel: 10008
  store.save(ctx, d);
  const ch = fake.channels.get("ch1");
  const realDelete = ch.messages.delete;
  ch.messages.delete = async (id) => { if (id === old) throw new Error("Missing Access"); return realDelete(id); };
  assert.equal(await C.sync(ctx), "empty");
  let c = store.load(ctx).channel;
  assert.deepEqual([c.mainMessageId, c.messageIds, c.staleIds], [null, undefined, [old]]);
  ch.messages.delete = realDelete;
  assert.equal(await C.sync(ctx), "empty");
  c = store.load(ctx).channel;
  assert.deepEqual(c.staleIds, []);
  assert.equal(fake.messagesIn("ch1").length, 0);
  assert.equal(await C.sync(ctx), "empty");
});

test("does not fit one message: logged once while it lasts (repost and edit path), re-armed once it fits again", async () => {
  const real = R.renderStack;
  R.renderStack = () => null;
  try {
    const { ctx } = setup();
    await C.sync(ctx); // repost → fallback
    await C.sync(ctx); // edit path → invalid
    await C.sync(ctx, { checkTail: true });
    const fitErrors = () => ctx.errors.filter((e) => /do not fit one message/.test(e)).length;
    assert.equal(fitErrors(), 1);
    R.renderStack = real;
    assert.equal(await C.sync(ctx), "edited"); // the real board replaces the fallback
    R.renderStack = () => null;
    assert.equal(await C.sync(ctx), "invalid");
    assert.equal(fitErrors(), 2);
  } finally {
    R.renderStack = real;
  }
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

test("postPing: under the board, pings only the button's roles, replaces the previous ping; transient — expirePing (the tick's backstop) after transientSec", async () => {
  const { fake, ctx } = setup((x) => {
    x.listings.push(listing("L1", "u1", { posterName: "Dani" }));
    x.listings.push(listing("L2", "u2", { posterName: "Marci", categoryId: "ddps", buttonId: "any" }));
  });
  await C.sync(ctx);
  fake.roles.delete("r-hack"); // a deleted ping role is left out
  const first = await C.postPing(ctx, "L1");
  const ping = fake.ops.find((o) => o.messageId === first);
  assert.deepEqual(ping.payload, { content: "<@&r-sup> **Dani** is looking for **BASIC · SUP** · now", allowedMentions: { roles: ["r-sup"] } });
  assert.deepEqual([store.load(ctx).channel.pingMessageId, store.load(ctx).channel.pingUntil], [first, T0 + 5000]);
  const second = await C.postPing(ctx, "L2");
  assert.ok(fake.ops.some((o) => o.op === "delete" && o.messageId === first));
  assert.equal(fake.ops.find((o) => o.messageId === second && o.op === "send").payload.allowedMentions.roles.join(), "r-radar");
  assert.equal(await C.expirePing(ctx), false);
  ctx.clock = T0 + 5000; // the timers were not run (a restart lost them): the tick's expirePing takes it
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

test("repost: blocks that cannot fit one message post the panel alone (board-only layout: the No one is looking box) — the id is kept, no repost loop", async () => {
  const real = R.renderStack;
  R.renderStack = () => null;
  try {
    const { fake, ctx } = setup();
    assert.equal(await C.sync(ctx), "reposted");
    const id = mainId(ctx);
    assert.ok(id);
    const p = fake.ops.find((o) => o.messageId === id).payload;
    assert.ok(ids(p).includes("lfg:start"));
    assert.equal(p.components.length, 1, "the panel box only");
    assert.doesNotMatch(JSON.stringify(p), /No one is looking right now/);
    assert.deepEqual(messageErrors(p, { prefixes: R.PREFIXES }), []);
    const boardOnly = R.renderStackFallback(store.load(ctx).config, [{ type: "board" }]);
    assert.match(JSON.stringify(boardOnly), /No one is looking right now/);
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
