"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const E = require("../modules/lfg/effects");
const C = require("../modules/lfg/channel");
const D = require("../modules/lfg/discord");
const S = require("../modules/lfg/state");
const A = require("../modules/lfg/actions");
const store = require("../modules/lfg/store");
const { T0, MIN, dataWith, listing, request, fakeDiscord, fakeCtx } = require("./fixtures/lfg-fakes");

beforeEach(() => { C._reset(); E._reset(); });

function setup(mutate, fakeOpts) {
  const fake = fakeDiscord(fakeOpts);
  for (const r of ["r-sup", "r-dps", "r-radar", "r-hack", "r-gm"]) fake.roles.set(r, { id: r, mentionable: true });
  const ctx = fakeCtx(fake);
  store.save(ctx, dataWith(mutate));
  return { fake, ctx };
}
const opsOf = (fake, op) => fake.ops.filter((o) => o.op === op);
const journal = (ctx) => store.readLog(path.join(ctx.config.DATA_DIR, store.LOG_FILE));
// A thread that exists in the fake, for a listing seeded with threadId "th-<id>".
const withThread = (fake, id) => fake.textChannel(`th-${id}`, {
  members: { add: async (u) => fake.ops.push({ op: "threadAdd", threadId: `th-${id}`, userId: u }), remove: async (u) => fake.ops.push({ op: "threadRemove", threadId: `th-${id}`, userId: u }) },
  setLocked: async (v) => fake.ops.push({ op: "lock", threadId: `th-${id}`, locked: v }),
  setArchived: async (v) => fake.ops.push({ op: "archive", threadId: `th-${id}`, archived: v }),
});
const threadSends = (fake, id) => opsOf(fake, "send").filter((o) => o.channelId === `th-${id}`);
const linesOf = (ctx, id = "L1") => S.findListing(store.load(ctx), id).lines;

// ── afterCreate ────────────────────────────────────────────────────────────

test("afterCreate: thread + ONE message (intro inside the request panel), ids saved; the followUp then pings, posts the board, DMs", async () => {
  const { fake, ctx } = setup();
  fake.member("u2", { roleIds: ["r-sup"] });
  const d = store.load(ctx);
  d.prefs.u2 = { dm: true };
  const L = S.createListing(d, { posterId: "u1", posterName: "Dani", categoryId: "basic", buttonId: "sup", note: "", startAt: null }, T0);
  store.save(ctx, d);
  const r = await E.afterCreate(ctx, L.id);
  const [thread] = opsOf(fake, "thread");
  assert.deepEqual([r.ok, r.threadId, r.threadUrl, typeof r.followUp], [true, thread.threadId, `https://discord.com/channels/g1/${thread.threadId}`, "function"]);
  const inThread = fake.ops.filter((o) => o.op === "send" && o.channelId === thread.threadId);
  assert.equal(inThread.length, 1, "one message in the thread");
  assert.match(inThread[0].payload.components[0].content, /^Your search is live\./);
  assert.match(JSON.stringify(inThread[0].payload), /### Requests/);
  // besides Discord's own "added A to the thread" system line (undeletable), only ours
  assert.deepEqual(fake.messagesIn(thread.threadId).map((m) => m.type ?? 0), [1, 0]);
  const saved = store.load(ctx).listings[0];
  assert.deepEqual([saved.threadId, saved.panelMessageId], [thread.threadId, inThread[0].messageId]);
  // nothing in the channel and no DM before the followUp — the answer does not wait for them
  assert.equal(fake.ops.some((o) => (o.op === "send" && o.channelId === "ch1") || o.op === "dm"), false);
  await r.followUp();
  const ping = fake.ops.find((o) => o.op === "send" && o.channelId === "ch1" && o.payload.content);
  assert.match(ping.payload.content, /^<@&r-sup> \*\*Dani\*\* is looking for/);
  assert.equal(opsOf(fake, "dm").length, 1);
  assert.equal(store.load(ctx).listings[0].dmCount, 1);
});

test("afterCreate: no thread → the search is cancelled (thread_failed), logged, and no ping or DM goes out", async () => {
  const { fake, ctx } = setup(null, { failThreads: true });
  const d = store.load(ctx);
  const L = S.createListing(d, { posterId: "u1", posterName: "Dani", categoryId: "basic", buttonId: "sup", note: "", startAt: null }, T0);
  store.save(ctx, d);
  const r = await E.afterCreate(ctx, L.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /couldn't open your search thread/);
  assert.equal(store.load(ctx).listings.length, 0);
  const line = journal(ctx).find((l) => l.type === "listing");
  assert.deepEqual([line.outcome, line.reason], ["cancelled", "thread_failed"]);
  assert.equal(fake.ops.some((o) => o.payload && o.payload.content && o.payload.content.startsWith("<@&")), false);
  assert.equal(opsOf(fake, "dm").length, 0);
  assert.match(ctx.errors.join("\n"), /could not open the thread/);
});

// ── A: transient pings ─────────────────────────────────────────────────────

test("A: the new-search ping is deleted transientSec after the send by a timer on the channel chain; the record stays until the delete succeeds", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1")));
  const id = await C.postPing(ctx, "L1");
  assert.deepEqual([store.load(ctx).channel.pingMessageId, store.load(ctx).channel.pingUntil], [id, T0 + 5000]);
  assert.deepEqual(ctx.timers.map((t) => t.ms), [5000]);
  await ctx.runTimers();
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), [id]);
  assert.deepEqual([store.load(ctx).channel.pingMessageId, store.load(ctx).channel.pingUntil], [null, null]);
  // a newer ping replaced it: the old timer does nothing
  const a = await C.postPing(ctx, "L1");
  const b = await C.postPing(ctx, "L1");
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), [id, a]); // the replace deleted a
  await ctx.runTimers();
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), [id, a, b]);
  assert.equal(store.load(ctx).channel.pingMessageId, null);
});

test("A: a ping a restart left behind (timer lost) is deleted by the tick once pingUntil passed; a failing delete keeps the record", async () => {
  const { fake, ctx } = setup((x) => { x.channel.pingMessageId = "ping1"; x.channel.pingUntil = T0 - 1; });
  fake.messagesIn("ch1").push({ id: "ping1", payload: {} });
  const realSync = C.sync;
  const seen = [];
  C.sync = (c, opts) => { seen.push(opts); return realSync(c, opts); };
  try {
    assert.equal(await E.tick(ctx), "ran");
  } finally {
    C.sync = realSync;
  }
  assert.deepEqual(seen, [{ checkTail: true }]);
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), ["ping1"]);
  assert.equal(store.load(ctx).channel.pingMessageId, null);
  // a delete refused (not 10008) → kept for the next tick
  const b = setup((x) => { x.channel.pingMessageId = "ping2"; x.channel.pingUntil = T0 - 1; });
  b.fake.messagesIn("ch1").push({ id: "ping2", payload: {} });
  b.fake.channels.get("ch1").messages.delete = async () => { throw Object.assign(new Error("boom"), { code: 50001 }); };
  assert.equal(await C.expirePing(b.ctx), false);
  assert.equal(store.load(b.ctx).channel.pingMessageId, "ping2");
});

test("A: the join notification is transient — recorded on the listing, deleted by the timer; only the searcher pinged, the name escaped", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2", T0, { userName: "Z_ed*" }), request("u3", T0 + 1, { userName: "Ann" })] })));
  withThread(fake, "L1");
  await E.runEvents(ctx, [{ type: "joined", listingId: "L1", userId: "u2" }], { sync: false });
  const [line] = threadSends(fake, "L1");
  assert.equal(line.payload.content, "<@u1> **Z\\_ed\\*** wants to join · 2 waiting");
  assert.deepEqual(line.payload.allowedMentions, { users: ["u1"] });
  assert.deepEqual(linesOf(ctx), [{ id: line.messageId, kind: "notify", until: T0 + 5000 }]);
  assert.deepEqual(ctx.timers.map((t) => t.ms), [5000]);
  await ctx.runTimers();
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), [line.messageId]);
  assert.deepEqual(linesOf(ctx), []);
  // a leftover (timer lost) is replaced by the next notification
  await E.runEvents(ctx, [{ type: "joined", listingId: "L1", userId: "u2" }], { sync: false });
  await E.runEvents(ctx, [{ type: "joined", listingId: "L1", userId: "u3" }], { sync: false });
  const sends = threadSends(fake, "L1");
  assert.equal(sends.at(-1).payload.content, "<@u1> **Ann** wants to join · 2 waiting");
  assert.ok(opsOf(fake, "delete").some((o) => o.messageId === sends[1].messageId));
  assert.deepEqual(linesOf(ctx).map((x) => x.id), [sends[2].messageId]);
});

test("A: a nag is transient and replaces the previous one; the joiner's nag goes by DM card, in the thread only when the card can't reach them", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(confirming()));
  withThread(fake, "L1");
  await E.runEvents(ctx, [{ type: "nag", listingId: "L1", userId: "u1" }, { type: "nag", listingId: "L1", userId: "u2" }], { sync: false });
  let lines = threadSends(fake, "L1");
  assert.deepEqual(lines.map((o) => [o.payload.content, o.payload.allowedMentions.users]), [["<@u1> — tap I'm here when you're ready.", ["u1"]]]);
  assert.deepEqual(linesOf(ctx).map((x) => x.kind), ["nag"]);
  const d = store.load(ctx);
  d.dmCards.u2 = { blocked: true, since: T0 };
  store.save(ctx, d);
  await E.runEvents(ctx, [{ type: "nag", listingId: "L1", userId: "u2" }], { sync: false });
  lines = threadSends(fake, "L1");
  assert.equal(lines.at(-1).payload.content, "<@u2> — tap I'm here when you're ready.");
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), [lines[0].messageId], "the previous nag is replaced");
  await ctx.runTimers();
  assert.deepEqual(linesOf(ctx), []);
});

test("A: the tick deletes thread lines whose time is up (a restart lost the timer); a failing delete keeps the record for the next tick", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1", { lines: [{ id: "n1", kind: "notify", until: T0 - 1 }, { id: "n2", kind: "nag", until: T0 + MIN }] })));
  withThread(fake, "L1");
  fake.messagesIn("th-L1").push({ id: "n1", payload: {} }, { id: "n2", payload: {} });
  assert.equal(await E.tick(ctx), "ran");
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), ["n1"]);
  assert.deepEqual(linesOf(ctx).map((x) => x.id), ["n2"]);
  // gone by hand already (10008) = done
  ctx.clock = T0 + 2 * MIN;
  fake.messagesIn("th-L1").length = 0;
  await E.tick(ctx);
  assert.deepEqual(linesOf(ctx), []);
  // refused → kept
  const b = setup((x) => x.listings.push(listing("L1", "u1", { lines: [{ id: "n3", kind: "notify", until: T0 - 1 }] })));
  const th = withThread(b.fake, "L1");
  b.fake.messagesIn("th-L1").push({ id: "n3", payload: {} });
  th.messages.delete = async () => { throw Object.assign(new Error("nope"), { code: 50001 }); };
  await E.tick(b.ctx);
  assert.deepEqual(linesOf(b.ctx).map((x) => x.id), ["n3"]);
});

// ── D: the one-message thread ──────────────────────────────────────────────

function confirming(extra = {}) {
  return listing("L1", "u1", {
    posterName: "Dani",
    state: "confirming",
    joinerId: "u2",
    acceptedAt: T0,
    checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, at: {}, nags: {} },
    requests: [request("u2", T0, { status: "accepted", userName: "Marci" })],
    ...extra,
  });
}

test("D: accepted → the joiner is added, NO WAKEY message; a joiner with a DM card gets no thread line", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(confirming()));
  withThread(fake, "L1");
  await E.runEvents(ctx, [{ type: "accepted", listingId: "L1" }], { sync: false });
  assert.deepEqual(opsOf(fake, "threadAdd"), [{ op: "threadAdd", threadId: "th-L1", userId: "u2" }]);
  assert.deepEqual(threadSends(fake, "L1"), [], "no WAKEY, no ping");
  assert.equal(opsOf(fake, "delete").length, 0);
});

test("D: a joiner without a reachable DM card — or one the bot couldn't add — gets ONE transient ping line (fixed: with the start)", async () => {
  for (const [label, mutate] of [["blocked", (x) => { x.dmCards.u2 = { blocked: true, since: T0 }; }], ["off", (x) => { x.prefs.u2 = { dm: false, requestDm: false }; }]]) {
    const { fake, ctx } = setup((x) => { x.listings.push(confirming()); mutate(x); });
    withThread(fake, "L1");
    await E.runEvents(ctx, [{ type: "accepted", listingId: "L1" }], { sync: false });
    const lines = threadSends(fake, "L1");
    assert.deepEqual(lines.map((o) => [o.payload.content, o.payload.allowedMentions]), [["<@u2> — **Dani** picked you, tap I'm here.", { users: ["u2"] }]], label);
    assert.deepEqual(linesOf(ctx).map((x) => x.kind), ["picked"], label);
    await ctx.runTimers();
    assert.deepEqual(linesOf(ctx), [], label);
  }
  const b = setup((x) => x.listings.push(confirming({ state: "fixed", startAt: T0 + 60 * MIN, checkIn: null })));
  b.fake.textChannel("th-L1", { members: { add: async () => { throw new Error("Missing Access"); } } });
  await E.runEvents(b.ctx, [{ type: "accepted", listingId: "L1" }], { sync: false });
  assert.equal(threadSends(b.fake, "L1")[0].payload.content, `<@u2> — **Dani** picked you · starts <t:${Math.floor((T0 + 60 * MIN) / 1000)}:R>.`);
});

test("D: checkInOpen of a fixed game → the transient Heads up pings BOTH players", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(confirming({ startAt: T0 + 5 * MIN })));
  withThread(fake, "L1");
  await E.runEvents(ctx, [{ type: "checkInOpen", listingId: "L1" }], { sync: false });
  const [line] = threadSends(fake, "L1");
  assert.equal(line.payload.content, `Heads up <@u1> <@u2> — your game starts <t:${Math.floor((T0 + 5 * MIN) / 1000)}:R>!`);
  assert.deepEqual(line.payload.allowedMentions, { users: ["u1", "u2"] });
  assert.deepEqual(linesOf(ctx).map((x) => x.kind), ["headsUp"]);
  await ctx.runTimers();
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), [line.messageId]);
});

test("D: checkInOpen for a listing no longer confirming (or without a checkIn) does nothing", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2")] })));
  withThread(fake, "L1");
  await E.runEvents(ctx, [{ type: "checkInOpen", listingId: "L1" }], { sync: false });
  assert.deepEqual(fake.ops, []);
  assert.deepEqual(ctx.errors, []);
});

test("D: the one message across open → confirming → started — every step an EDIT of panelMessageId, no Cancel search once accepted, Game on! in place of Confirm", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1", { posterName: "Dani", requests: [request("u2", T0, { userName: "Marci" })] })));
  withThread(fake, "L1");
  fake.messagesIn("th-L1").push({ id: "pm-L1", payload: {} });
  const run = async (r) => { assert.ok(r.ok, r.error); await r.effects(); };
  const panel = () => JSON.stringify(opsOf(fake, "edit").filter((o) => o.messageId === "pm-L1").at(-1).payload);
  await run(A.accept(ctx, { userId: "u1", displayName: "Dani", level: "member" }, { listingId: "L1", userId: "u2" }));
  assert.match(panel(), /You picked \*\*Marci\*\*/);
  assert.match(panel(), /lfg:here:L1/);
  assert.doesNotMatch(panel(), /lfg:cancel:L1|Your search is live/);
  await run(A.checkIn(ctx, { userId: "u2", displayName: "Marci", level: "member" }, { listingId: "L1" }));
  assert.match(panel(), /"label":"1 \/ 2"/);
  await run(A.checkIn(ctx, { userId: "u1", displayName: "Dani", level: "member" }, { listingId: "L1" }));
  assert.match(panel(), /### Game on!/);
  assert.doesNotMatch(panel(), /lfg:here:L1|lfg:cancel:L1|lfg:badge:confirm/);
  // every thread write was an edit of the one message (plus nothing sent there)
  assert.deepEqual(threadSends(fake, "L1"), []);
  assert.deepEqual(store.load(ctx).archives.map((a) => a.threadId), ["th-L1"]);
});

test("D: reopened → the red notice is in the thread message (no welcome edit), leftover pings deleted, the joiner removed", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(confirming({ requests: [request("u2", T0, { status: "accepted", userName: "[x](https://e.com)" }), request("u3", T0 + 1, { onHold: true })], lines: [{ id: "nag1", kind: "nag", until: T0 + 5000 }] })));
  withThread(fake, "L1");
  fake.messagesIn("th-L1").push({ id: "pm-L1", payload: {} }, { id: "nag1", payload: {} });
  const r = A.withdraw(ctx, { userId: "u2", displayName: "x", level: "member" }, { listingId: "L1" });
  await r.effects();
  assert.deepEqual(opsOf(fake, "threadRemove"), [{ op: "threadRemove", threadId: "th-L1", userId: "u2" }]);
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), ["nag1"]);
  const edit = opsOf(fake, "edit").find((o) => o.messageId === "pm-L1");
  assert.match(JSON.stringify(edit.payload), /\*\*\\\\\[x\]\(https:\/\/e\.com\)\*\* left — your search is open again/);
  assert.match(JSON.stringify(edit.payload), /lfg:accept:L1:u3/);
  assert.deepEqual(linesOf(ctx), []);
});

test("D: migration — a listing with the old welcome message: the next render puts Confirm in the panel and deletes the welcome (the tick triggers it); a failed delete keeps the id", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(confirming({ welcomeMessageId: "w1" })));
  withThread(fake, "L1");
  fake.messagesIn("th-L1").push({ id: "pm-L1", payload: {} }, { id: "w1", payload: {} });
  await E.tick(ctx);
  assert.match(JSON.stringify(opsOf(fake, "edit").find((o) => o.messageId === "pm-L1").payload), /lfg:here:L1/);
  assert.ok(opsOf(fake, "delete").some((o) => o.messageId === "w1"));
  assert.equal("welcomeMessageId" in S.findListing(store.load(ctx), "L1"), false);
  const b = setup((x) => x.listings.push(confirming({ welcomeMessageId: "w2" })));
  const th = withThread(b.fake, "L1");
  b.fake.messagesIn("th-L1").push({ id: "pm-L1", payload: {} }, { id: "w2", payload: {} });
  th.messages.delete = async () => { throw Object.assign(new Error("nope"), { code: 50001 }); };
  await E.runEvents(b.ctx, [{ type: "panel", listingId: "L1" }], { sync: false });
  assert.equal(S.findListing(store.load(b.ctx), "L1").welcomeMessageId, "w2");
});

test("D (A3): migration without a panel message — the tick deletes the old welcome directly (no panel to redraw)", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(confirming({ panelMessageId: null, welcomeMessageId: "w1" })));
  withThread(fake, "L1");
  fake.messagesIn("th-L1").push({ id: "w1", payload: {} });
  await E.tick(ctx);
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), ["w1"]);
  assert.equal(opsOf(fake, "edit").some((o) => o.channelId === "th-L1"), false);
  assert.equal("welcomeMessageId" in S.findListing(store.load(ctx), "L1"), false);
  await E.tick(ctx);
  assert.equal(opsOf(fake, "delete").length, 1, "done once");
});

test("A (A2): a ping line whose send was still in flight when the search was dropped is deleted by the dropped handler BEFORE lock + archive; no new line for a dropped search", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(confirming()));
  const th = withThread(fake, "L1");
  fake.messagesIn("th-L1").push({ id: "pm-L1", payload: {} });
  const realSend = th.send;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  th.send = async (payload) => { await gate; return realSend(payload); };
  // the tick's nag starts sending…
  const nag = E.runEvents(ctx, [{ type: "nag", listingId: "L1", userId: "u1" }], { sync: false });
  await new Promise((resolve) => setImmediate(resolve));
  // …the searcher cancels meanwhile (saved before the send returns)
  const r = A.cancelListing(ctx, { userId: "u1", displayName: "Dani", level: "member" }, { listingId: "L1" });
  assert.ok(r.ok);
  const effects = r.effects();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([nag, effects]);
  const sent = threadSends(fake, "L1").find((o) => /tap I'm here/.test(o.payload.content));
  assert.ok(sent, "the nag went out");
  const order = fake.ops.filter((o) => (o.op === "delete" && o.messageId === sent.messageId) || o.op === "lock" || o.op === "archive").map((o) => o.op);
  assert.deepEqual(order, ["delete", "lock", "archive"]);
  // after the drop a new transient line is not even sent
  th.send = realSend;
  const before = threadSends(fake, "L1").length;
  await E.runEvents(ctx, [{ type: "nag", listingId: "L1", userId: "u1" }], { sync: false });
  assert.equal(threadSends(fake, "L1").length, before);
});

// ── E: archive ─────────────────────────────────────────────────────────────

test("E: dropped → the thread message turns terminal (closing line inside it), then lock AND archive, journaled; a played (matched) game is left alone", async () => {
  const { fake, ctx } = setup();
  withThread(fake, "L1");
  withThread(fake, "L2");
  fake.messagesIn("th-L1").push({ id: "pm-L1", payload: {} }, { id: "n1", payload: {} });
  const gone = listing("L1", "u1", { lines: [{ id: "n1", kind: "notify", until: T0 + 5000 }], requests: [request("u2", T0, { status: "closed", reason: "expired" })] });
  await E.runEvents(ctx, [
    { type: "dropped", listing: gone, outcome: "expired", reason: null },
    { type: "dropped", listing: listing("L2", "u2"), outcome: "matched", reason: null },
  ], { sync: false });
  assert.deepEqual(fake.ops.map((o) => [o.op, o.messageId || o.threadId]), [["delete", "n1"], ["edit", "pm-L1"], ["lock", "th-L1"], ["archive", "th-L1"]]);
  const panel = JSON.stringify(opsOf(fake, "edit")[0].payload);
  assert.doesNotMatch(panel, /lfg:accept:|lfg:cancel:|lfg:here:/);
  assert.match(panel, /Search expired\./);
  assert.deepEqual(journal(ctx).filter((l) => l.type === "thread").map((l) => [l.listingId, l.threadId, l.event, l.outcome]), [["L1", "th-L1", "archived", "expired"]]);
  assert.equal(E.closingLine(null, "cancelled", "no_confirm"), "Search closed — not confirmed in time.");
  assert.equal(E.closingLine(null, "removed", null), "Search removed by an officer.");
  assert.equal(E.closingLine(null, "cancelled", "self"), "Search cancelled.");
});

test("E: dropped without a panel message → the closing line is sent as a message instead, then lock + archive", async () => {
  const { fake, ctx } = setup();
  withThread(fake, "L1");
  await E.runEvents(ctx, [{ type: "dropped", listing: listing("L1", "u1", { panelMessageId: null }), outcome: "cancelled", reason: "self" }], { sync: false });
  assert.deepEqual(fake.ops.map((o) => o.op), ["send", "lock", "archive"]);
  assert.equal(opsOf(fake, "send")[0].payload.content, "Search cancelled.");
});

test("E: a played game's thread is archived by the tick archiveAfterMin after the start — not locked — and journaled; survives the listing leaving the board", async () => {
  const { fake, ctx } = setup((x) => {
    x.listings.push(confirming({ state: "started", startedAt: T0, checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, at: { u1: T0, u2: T0 }, nags: {} } }));
    x.archives.push({ listingId: "L1", threadId: "th-L1", at: T0 + 15 * MIN });
  });
  withThread(fake, "L1");
  ctx.clock = T0 + 6 * MIN;
  await E.tick(ctx);
  assert.deepEqual(store.load(ctx).listings, [], "left the board after 5 min");
  assert.equal(opsOf(fake, "archive").length, 0);
  assert.equal(opsOf(fake, "lock").length, 0, "a played game's thread is never locked");
  ctx.clock = T0 + 15 * MIN;
  await E.tick(ctx);
  assert.deepEqual(opsOf(fake, "archive"), [{ op: "archive", threadId: "th-L1", archived: true }]);
  assert.equal(opsOf(fake, "lock").length, 0);
  assert.deepEqual(store.load(ctx).archives, []);
  assert.deepEqual(journal(ctx).filter((l) => l.type === "thread").map((l) => [l.event, l.outcome]), [["archived", "matched"]]);
  ctx.clock = T0 + 16 * MIN;
  await E.tick(ctx);
  assert.equal(opsOf(fake, "archive").length, 1, "once");
});

// ── runEvents robustness ───────────────────────────────────────────────────

test("panel and card events: each panel redrawn once; a card event wins over a silent refresh of the same member", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2")] })));
  withThread(fake, "L1");
  fake.messagesIn("th-L1").push({ id: "pm-L1", payload: {} });
  await E.runEvents(ctx, [
    { type: "panel", listingId: "L1" }, { type: "panel", listingId: "L1" },
    { type: "cardRefresh", userId: "u2" },
    { type: "card", userId: "u2", event: { kind: "accepted", listingId: "L1", aboutId: "u1", aboutName: "U1", label: "BASIC · SUP", emoji: "💥", startAt: null, at: T0 } },
  ], { sync: false });
  assert.deepEqual(opsOf(fake, "edit").map((o) => o.messageId), ["pm-L1"]);
  const dms = opsOf(fake, "dm");
  assert.equal(dms.length, 1);
  assert.equal(dms[0].payload.flags & (1 << 12), 0); // important → not silent
});

test("a batch that mentions a listing already dropped does not throw: the events about it are skipped, the reopened one uses its own data", async () => {
  // L1 was dropped earlier in the same batch / tick: it is no longer in lfg.json
  const { fake, ctx } = setup();
  withThread(fake, "L1");
  fake.messagesIn("th-L1").push({ id: "w1", payload: {} });
  await E.runEvents(ctx, [
    { type: "dropped", listing: listing("L1", "u1", { panelMessageId: null }), outcome: "cancelled", reason: "matched_elsewhere" },
    { type: "reopened", listingId: "L1", joinerId: "u2", welcomeMessageId: "w1", threadId: "th-L1", reason: "matched_elsewhere" },
    { type: "accepted", listingId: "L1" },
    { type: "joined", listingId: "L1", userId: "u3" },
    { type: "checkInOpen", listingId: "L1" },
    { type: "nag", listingId: "L1", userId: "u2" },
    { type: "started", listingId: "L1" },
    { type: "panel", listingId: "L1" },
  ], { sync: false });
  assert.deepEqual(opsOf(fake, "threadRemove"), [{ op: "threadRemove", threadId: "th-L1", userId: "u2" }]);
  assert.ok(opsOf(fake, "delete").some((o) => o.messageId === "w1"), "the legacy welcome goes");
  assert.equal(ctx.errors.length, 0);
});

test("A1: an event whose handler throws is logged and does not stop a later event, the panels or the cards", async () => {
  const R = require("../modules/lfg/render");
  const { fake, ctx } = setup((x) => {
    x.listings.push(confirming({ startAt: T0 + 5 * MIN }));
    x.listings.push(listing("L2", "u5", { requests: [request("u6")] }));
  });
  withThread(fake, "L1");
  withThread(fake, "L2");
  fake.messagesIn("th-L2").push({ id: "pm-L2", payload: {} });
  const real = R.threadLine;
  let first = true;
  R.threadLine = (...a) => { if (first) { first = false; throw new Error("render boom"); } return real(...a); };
  try {
    await E.runEvents(ctx, [
      { type: "checkInOpen", listingId: "L1" },
      { type: "joined", listingId: "L2", userId: "u6" },
      { type: "panel", listingId: "L2" },
      { type: "cardRefresh", userId: "u6" },
    ], { sync: false });
  } finally {
    R.threadLine = real;
  }
  assert.match(ctx.errors.join("\n"), /event checkInOpen for L1 failed:.*render boom/);
  assert.ok(opsOf(fake, "send").some((o) => o.channelId === "th-L2" && /wants to join/.test(o.payload.content)));
  assert.ok(opsOf(fake, "edit").some((o) => o.messageId === "pm-L2"));
  assert.ok(opsOf(fake, "dm").some((o) => o.channelId === "dm-u6"));
});

// ── cardDelete (the tick's stale cards) ────────────────────────────────────

test("cardDelete goes through the member's card queue: it waits for an earlier card job of the same member", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2")] })));
  fake.messagesIn("dm-u2").push({ id: "old1", payload: {} });
  const u2 = fake.user("u2");
  const realCreateDM = u2.createDM;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  u2.createDM = async () => { if (calls++ === 0) await gate; return realCreateDM(); };
  const first = D.deliverCard(ctx, "u2"); // holds the queue at its createDM
  const run = E.runEvents(ctx, [{ type: "cardDelete", userId: "u2", messageId: "old1" }], { sync: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opsOf(fake, "delete").length, 0, "the delete must not overtake the earlier card job");
  release();
  await Promise.all([first, run]);
  const order = fake.ops.filter((o) => o.op === "dm" || o.op === "delete").map((o) => [o.op, o.messageId === "old1" ? "old1" : "new"]);
  assert.deepEqual(order, [["dm", "new"], ["delete", "old1"]]);
});

test("cardDelete: a card already deleted by hand (Unknown Message) is fine; a user that can't be fetched is skipped", async () => {
  const { fake, ctx } = setup();
  await E.runEvents(ctx, [{ type: "cardDelete", userId: "u2", messageId: "gone" }], { sync: false });
  assert.equal(opsOf(fake, "delete").length, 0);
  assert.equal(ctx.errors.length, 0);
  fake.client.users.fetch = async () => { throw new Error("Unknown User"); };
  await E.runEvents(ctx, [{ type: "cardDelete", userId: "u3", messageId: "x" }], { sync: false });
  assert.equal(ctx.errors.length, 0);
});

// ── tick ───────────────────────────────────────────────────────────────────

test("tick: nothing to do without a config; a second tick while one runs is skipped", async () => {
  const fake = fakeDiscord();
  const ctx = fakeCtx(fake);
  assert.equal(await E.tick(ctx), "idle");
  const s = setup();
  const [a, b] = await Promise.all([E.tick(s.ctx), E.tick(s.ctx)]);
  assert.deepEqual([a, b].sort(), ["ran", "skipped"]);
});

test("tick: a lapsed search is closed (locked + archived) and logged, the board posted; the confirm window opens with a Heads up to both", async () => {
  const { fake, ctx } = setup((x) => {
    x.listings.push(listing("OLD", "u1", { requests: [request("u3")] }));
    x.listings.push(listing("FIX", "u5", { posterName: "Ed", state: "fixed", joinerId: "u6", startAt: T0 + 40 * MIN, expiresAt: T0 + 40 * MIN, requests: [request("u6", T0, { status: "accepted" })] }));
  });
  withThread(fake, "OLD");
  withThread(fake, "FIX");
  fake.messagesIn("th-FIX").push({ id: "pm-FIX", payload: {} });
  ctx.clock = T0 + 35 * MIN;
  assert.equal(await E.tick(ctx), "ran");
  const d = store.load(ctx);
  assert.deepEqual(d.listings.map((l) => [l.id, l.state]), [["FIX", "confirming"]]);
  assert.deepEqual(journal(ctx).filter((l) => l.type === "listing").map((l) => [l.id, l.outcome]), [["OLD", "expired"]]);
  assert.ok(fake.ops.some((o) => o.op === "lock" && o.threadId === "th-OLD"));
  assert.ok(fake.ops.some((o) => o.op === "archive" && o.threadId === "th-OLD"));
  const headsUp = threadSends(fake, "FIX")[0];
  assert.equal(headsUp.payload.content, `Heads up <@u5> <@u6> — your game starts <t:${Math.floor((T0 + 40 * MIN) / 1000)}:R>!`);
  assert.match(JSON.stringify(opsOf(fake, "edit").find((o) => o.messageId === "pm-FIX").payload), /lfg:here:FIX/);
  assert.ok(opsOf(fake, "dm").some((o) => o.channelId === "dm-u3")); // expired news
  assert.ok(opsOf(fake, "dm").some((o) => o.channelId === "dm-u6")); // the window opened
  assert.ok(d.channel.mainMessageId); // the board message was posted
});

test("tick: a stale DM card (24 h, no activity) is deleted and its record dropped", async () => {
  const { fake, ctx } = setup((x) => { x.dmCards.u9 = { messageId: "c1", sentAt: T0 - 25 * 60 * MIN, lastEventAt: 0, event: null }; });
  fake.messagesIn("dm-u9").push({ id: "c1", payload: {} });
  assert.equal(await E.tick(ctx), "ran");
  assert.deepEqual(opsOf(fake, "delete").filter((o) => o.channelId === "dm-u9").map((o) => o.messageId), ["c1"]);
  assert.equal(store.load(ctx).dmCards.u9, undefined);
});

test("tick: a search that never got a thread is dropped (thread_failed) without a ping or a DM", async () => {
  const { fake, ctx } = setup((x) => { x.listings.push(listing("NT", "u1", { threadId: null, panelMessageId: null, createdAt: T0 - 5 * MIN })); });
  assert.equal(await E.tick(ctx), "ran");
  assert.equal(store.load(ctx).listings.length, 0);
  assert.deepEqual(journal(ctx).filter((l) => l.type === "listing").map((l) => [l.outcome, l.reason]), [["cancelled", "thread_failed"]]);
  assert.equal(fake.ops.some((o) => o.payload && o.payload.content && o.payload.content.startsWith("<@&")), false);
  assert.equal(opsOf(fake, "dm").length, 0);
});

test("D6: afterCreate logs the new thread id before anything is saved", async () => {
  const { fake, ctx } = setup();
  const lines = [];
  ctx.log.log = (...a) => lines.push(a.join(" "));
  const d = store.load(ctx);
  const L = S.createListing(d, { posterId: "u1", posterName: "Dani", categoryId: "basic", buttonId: "sup", note: "", startAt: null }, T0);
  store.save(ctx, d);
  const r = await E.afterCreate(ctx, L.id);
  assert.ok(lines.some((l) => l.includes(`opened thread ${r.threadId} for search ${L.id}`)));
  assert.ok(fake.ops.length > 0);
});
