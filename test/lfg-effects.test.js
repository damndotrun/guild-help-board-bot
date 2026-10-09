"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const E = require("../modules/lfg/effects");
const C = require("../modules/lfg/channel");
const D = require("../modules/lfg/discord");
const S = require("../modules/lfg/state");
const store = require("../modules/lfg/store");
const { T0, MIN, dataWith, listing, request, fakeDiscord, fakeCtx } = require("./fixtures/lfg-fakes");

beforeEach(() => C._reset());

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
});

// ── afterCreate ────────────────────────────────────────────────────────────

test("afterCreate: thread + intro + request panel, ids saved; the followUp then pings, posts the board, DMs", async () => {
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
  assert.match(inThread[0].payload.content, /^Your search is live\./);
  assert.equal(inThread[1].payload.components[0].components[0].components[0].content, "### Requests");
  const saved = store.load(ctx).listings[0];
  assert.deepEqual([saved.threadId, saved.panelMessageId], [thread.threadId, inThread[1].messageId]);
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

// ── runEvents ──────────────────────────────────────────────────────────────

function confirming(extra = {}) {
  return listing("L1", "u1", {
    posterName: "Dani",
    state: "confirming",
    joinerId: "u2",
    acceptedAt: T0,
    checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: null, at: {}, nags: {} },
    requests: [request("u2", T0, { status: "accepted", userName: "Marci" })],
    ...extra,
  });
}

test("accepted: the joiner joins the thread, the WAKEY message pings only the searcher, its id is kept", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(confirming()));
  withThread(fake, "L1");
  await E.runEvents(ctx, [{ type: "accepted", listingId: "L1" }], { sync: false });
  assert.deepEqual(opsOf(fake, "threadAdd"), [{ op: "threadAdd", threadId: "th-L1", userId: "u2" }]);
  const welcome = opsOf(fake, "send").find((o) => o.channelId === "th-L1");
  assert.deepEqual(welcome.payload.allowedMentions, { users: ["u1"] });
  assert.equal(store.load(ctx).listings[0].welcomeMessageId, welcome.messageId);
});

test("accepted: a joiner without a reachable DM card — or one the bot couldn't add — is pinged in the WAKEY message", async () => {
  const { fake, ctx } = setup((x) => { x.listings.push(confirming()); x.dmCards.u2 = { blocked: true, since: T0 }; });
  withThread(fake, "L1");
  await E.runEvents(ctx, [{ type: "accepted", listingId: "L1" }], { sync: false });
  assert.deepEqual(opsOf(fake, "send")[0].payload.allowedMentions, { users: ["u1", "u2"] });
  const b = setup((x) => x.listings.push(confirming()));
  b.fake.textChannel("th-L1", { members: { add: async () => { throw new Error("Missing Access"); } } });
  await E.runEvents(b.ctx, [{ type: "accepted", listingId: "L1" }], { sync: false });
  assert.deepEqual(opsOf(b.fake, "send")[0].payload.allowedMentions, { users: ["u1", "u2"] });
});

test("joined: one notification line in the thread — the previous one is deleted, only the searcher is pinged, the name escaped", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2", T0, { userName: "Z_ed*" }), request("u3", T0 + 1, { userName: "Ann" })] })));
  withThread(fake, "L1");
  await E.runEvents(ctx, [{ type: "joined", listingId: "L1", userId: "u2" }], { sync: false });
  await E.runEvents(ctx, [{ type: "joined", listingId: "L1", userId: "u3" }], { sync: false });
  const lines = opsOf(fake, "send").filter((o) => o.channelId === "th-L1");
  // the joiner's name is escaped like on every other surface
  assert.deepEqual(lines.map((o) => o.payload.content), ["<@u1> **Z\\_ed\\*** wants to join · 2 waiting", "<@u1> **Ann** wants to join · 2 waiting"]);
  assert.deepEqual(lines[1].payload.allowedMentions, { users: ["u1"] });
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), [lines[0].messageId]);
  assert.equal(store.load(ctx).listings[0].notifyMessageId, lines[1].messageId);
});

test("nag: the searcher in the thread (previous nag deleted); the joiner by DM card, or in the thread when DMs are closed", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(confirming({ welcomeMessageId: "w1" })));
  withThread(fake, "L1");
  await E.runEvents(ctx, [{ type: "nag", listingId: "L1", userId: "u1" }, { type: "nag", listingId: "L1", userId: "u2" }], { sync: false });
  let lines = opsOf(fake, "send").filter((o) => o.channelId === "th-L1");
  assert.deepEqual(lines.map((o) => [o.payload.content, o.payload.allowedMentions.users]), [["<@u1> — tap I'm here when you're ready.", ["u1"]]]);
  const d = store.load(ctx);
  d.dmCards.u2 = { blocked: true, since: T0 };
  store.save(ctx, d);
  await E.runEvents(ctx, [{ type: "nag", listingId: "L1", userId: "u2" }], { sync: false });
  lines = opsOf(fake, "send").filter((o) => o.channelId === "th-L1");
  assert.equal(lines.at(-1).payload.content, "<@u2> — tap I'm here when you're ready.");
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), [lines[0].messageId]);
});

test("started: the welcome turns to ✓ Game on and a Game on! box is posted; reopened: closed welcome, joiner removed", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(confirming({ state: "started", startedAt: T0, welcomeMessageId: "w1" })));
  withThread(fake, "L1");
  fake.messagesIn("th-L1").push({ id: "w1", payload: {} });
  await E.runEvents(ctx, [{ type: "started", listingId: "L1" }], { sync: false });
  assert.equal(opsOf(fake, "edit")[0].messageId, "w1");
  assert.match(JSON.stringify(opsOf(fake, "send")[0].payload), /### Game on!/);
  await E.runEvents(ctx, [{ type: "reopened", listingId: "L1", joinerId: "u2", welcomeMessageId: "w1", threadId: "th-L1", reason: "no_confirm" }], { sync: false });
  assert.match(JSON.stringify(opsOf(fake, "edit")[1].payload), /Marci\*\* didn't confirm — your search is open again/);
  assert.deepEqual(opsOf(fake, "threadRemove"), [{ op: "threadRemove", threadId: "th-L1", userId: "u2" }]);
});

test("dropped: a closing line and a lock — except a played (matched) game, whose thread stays open", async () => {
  const { fake, ctx } = setup();
  withThread(fake, "L1");
  withThread(fake, "L2");
  await E.runEvents(ctx, [
    { type: "dropped", listing: listing("L1", "u1"), outcome: "expired", reason: null },
    { type: "dropped", listing: listing("L2", "u2"), outcome: "matched", reason: null },
  ], { sync: false });
  assert.deepEqual(fake.ops.map((o) => [o.op, o.channelId || o.threadId]), [["send", "th-L1"], ["lock", "th-L1"]]);
  assert.equal(opsOf(fake, "send")[0].payload.content, "Search expired.");
  assert.equal(E.closingLine(null, "cancelled", "no_confirm"), "Search closed — not confirmed in time.");
  assert.equal(E.closingLine(null, "removed", null), "Search removed by an officer.");
  assert.equal(E.closingLine(null, "cancelled", "self"), "Search cancelled.");
});

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
    { type: "dropped", listing: listing("L1", "u1"), outcome: "cancelled", reason: "matched_elsewhere" },
    { type: "reopened", listingId: "L1", joinerId: "u2", welcomeMessageId: "w1", threadId: "th-L1", reason: "matched_elsewhere" },
    { type: "accepted", listingId: "L1" },
    { type: "joined", listingId: "L1", userId: "u3" },
    { type: "checkInOpen", listingId: "L1" },
    { type: "welcome", listingId: "L1" },
    { type: "nag", listingId: "L1", userId: "u2" },
    { type: "started", listingId: "L1" },
    { type: "panel", listingId: "L1" },
  ], { sync: false });
  assert.deepEqual(opsOf(fake, "threadRemove"), [{ op: "threadRemove", threadId: "th-L1", userId: "u2" }]);
  assert.match(JSON.stringify(opsOf(fake, "edit")[0].payload), /Your partner/);
  assert.equal(ctx.errors.length, 0);
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

test("tick: a lapsed search is closed and logged, the board posted; the confirm window opens with a heads-up", async () => {
  const { fake, ctx } = setup((x) => {
    x.listings.push(listing("OLD", "u1", { requests: [request("u3")] }));
    x.listings.push(listing("FIX", "u5", { posterName: "Ed", state: "fixed", joinerId: "u6", startAt: T0 + 40 * MIN, expiresAt: T0 + 40 * MIN, welcomeMessageId: "w9", requests: [request("u6", T0, { status: "accepted" })] }));
  });
  withThread(fake, "OLD");
  withThread(fake, "FIX");
  fake.messagesIn("th-FIX").push({ id: "w9", payload: {} });
  ctx.clock = T0 + 35 * MIN;
  assert.equal(await E.tick(ctx), "ran");
  const d = store.load(ctx);
  assert.deepEqual(d.listings.map((l) => [l.id, l.state]), [["FIX", "confirming"]]);
  assert.deepEqual(journal(ctx).filter((l) => l.type === "listing").map((l) => [l.id, l.outcome]), [["OLD", "expired"]]);
  assert.ok(fake.ops.some((o) => o.op === "lock" && o.threadId === "th-OLD"));
  const headsUp = opsOf(fake, "send").find((o) => o.channelId === "th-FIX");
  assert.equal(headsUp.payload.content, `Heads up <@u5> — your game starts <t:${Math.floor((T0 + 40 * MIN) / 1000)}:R>!`);
  assert.ok(opsOf(fake, "edit").some((o) => o.messageId === "w9"));
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

test("tick: expires the ping and runs the board sync with the tail check", async () => {
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
});

test("tick: a search that never got a thread is dropped (thread_failed) without a ping or a DM", async () => {
  const { fake, ctx } = setup((x) => { x.listings.push(listing("NT", "u1", { threadId: null, panelMessageId: null, createdAt: T0 - 5 * MIN })); });
  assert.equal(await E.tick(ctx), "ran");
  assert.equal(store.load(ctx).listings.length, 0);
  assert.deepEqual(journal(ctx).filter((l) => l.type === "listing").map((l) => [l.outcome, l.reason]), [["cancelled", "thread_failed"]]);
  assert.equal(fake.ops.some((o) => o.payload && o.payload.content && o.payload.content.startsWith("<@&")), false);
  assert.equal(opsOf(fake, "dm").length, 0);
});

// ── final-review fixes ─────────────────────────────────────────────────────

test("A1: an event whose renderer throws is logged and does not stop a later event, the panels or the cards", async () => {
  const R = require("../modules/lfg/render");
  const { fake, ctx } = setup((x) => {
    x.listings.push(confirming({ welcomeMessageId: "w1" }));
    x.listings.push(listing("L2", "u5", { requests: [request("u6")] }));
  });
  withThread(fake, "L1");
  withThread(fake, "L2");
  fake.messagesIn("th-L2").push({ id: "pm-L2", payload: {} });
  const real = R.buildWelcome;
  R.buildWelcome = () => { throw new Error("render boom"); };
  try {
    await E.runEvents(ctx, [
      { type: "welcome", listingId: "L1" },
      { type: "joined", listingId: "L2", userId: "u6" },
      { type: "panel", listingId: "L2" },
      { type: "cardRefresh", userId: "u6" },
    ], { sync: false });
  } finally {
    R.buildWelcome = real;
  }
  assert.match(ctx.errors.join("\n"), /event welcome for L1 failed:.*render boom/);
  assert.ok(opsOf(fake, "send").some((o) => o.channelId === "th-L2" && /wants to join/.test(o.payload.content)));
  assert.ok(opsOf(fake, "edit").some((o) => o.messageId === "pm-L2"));
  assert.ok(opsOf(fake, "dm").some((o) => o.channelId === "dm-u6"));
});

test("A2: checkInOpen for a listing no longer confirming (or without a checkIn) does nothing", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2")] })));
  withThread(fake, "L1");
  await E.runEvents(ctx, [{ type: "checkInOpen", listingId: "L1" }], { sync: false });
  assert.deepEqual(fake.ops, []);
  assert.deepEqual(ctx.errors, []);
});

test("B1: the welcome failed to send → checkInOpen and a thread nag send it again and keep its id (once)", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(confirming({ startAt: T0 + 5 * MIN })));
  withThread(fake, "L1");
  await E.runEvents(ctx, [{ type: "checkInOpen", listingId: "L1" }], { sync: false });
  const welcome = opsOf(fake, "send").find((o) => o.payload.components && /WAKEY-WAKEY/.test(JSON.stringify(o.payload)));
  assert.ok(welcome, "the welcome was sent again");
  assert.ok(JSON.stringify(welcome.payload).includes("lfg:here:L1"));
  assert.equal(store.load(ctx).listings[0].welcomeMessageId, welcome.messageId);
  // a searcher-side nag with the welcome missing again
  const b = setup((x) => x.listings.push(confirming()));
  withThread(b.fake, "L1");
  await E.runEvents(b.ctx, [{ type: "nag", listingId: "L1", userId: "u1" }, { type: "nag", listingId: "L1", userId: "u1" }], { sync: false });
  const sent = opsOf(b.fake, "send").filter((o) => /WAKEY-WAKEY/.test(JSON.stringify(o.payload)));
  assert.equal(sent.length, 1);
  assert.equal(store.load(b.ctx).listings[0].welcomeMessageId, sent[0].messageId);
});

test("B2: dropped → the request panel turns terminal (no Accept, no Cancel search) before the thread closes", async () => {
  const { fake, ctx } = setup();
  withThread(fake, "L1");
  fake.messagesIn("th-L1").push({ id: "pm-L1", payload: {} });
  const gone = listing("L1", "u1", { requests: [request("u2", T0, { status: "closed", reason: "expired" })] });
  await E.runEvents(ctx, [{ type: "dropped", listing: gone, outcome: "expired", reason: null }], { sync: false });
  assert.deepEqual(fake.ops.map((o) => o.op), ["edit", "send", "lock"]);
  const panel = JSON.stringify(opsOf(fake, "edit")[0].payload);
  assert.doesNotMatch(panel, /lfg:accept:|lfg:cancel:/);
  assert.match(panel, /Search expired\./);
});

test("B3 + D1: reopened deletes the last nag line; the joiner's name is escaped (masked links too)", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2", T0, { status: "withdrawn", userName: "[x](https://e.com)" })] })));
  withThread(fake, "L1");
  fake.messagesIn("th-L1").push({ id: "w1", payload: {} }, { id: "nag1", payload: {} });
  await E.runEvents(ctx, [{ type: "reopened", listingId: "L1", joinerId: "u2", welcomeMessageId: "w1", nagMessageId: "nag1", threadId: "th-L1", reason: "self" }], { sync: false });
  assert.deepEqual(opsOf(fake, "delete").map((o) => o.messageId), ["nag1"]);
  assert.match(JSON.stringify(opsOf(fake, "edit")[0].payload), /\*\*\\\\\[x\]\(https:\/\/e\.com\)\*\* left/);
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

test("checkInOpen: the heads-up also mentions the joiner when their DM card can't reach them", async () => {
  for (const [label, mutate] of [["blocked", (x) => { x.dmCards.u2 = { blocked: true, since: T0 }; }], ["off", (x) => { x.prefs.u2 = { dm: false, requestDm: false }; }]]) {
    const { fake, ctx } = setup((x) => { x.listings.push(confirming({ startAt: T0 + 5 * MIN, welcomeMessageId: "w1" })); mutate(x); });
    withThread(fake, "L1");
    await E.runEvents(ctx, [{ type: "checkInOpen", listingId: "L1" }], { sync: false });
    const line = opsOf(fake, "send").find((o) => o.channelId === "th-L1");
    assert.equal(line.payload.content, `Heads up <@u1> <@u2> — your game starts <t:${Math.floor((T0 + 5 * MIN) / 1000)}:R>!`, label);
    assert.deepEqual(line.payload.allowedMentions, { users: ["u1", "u2"] }, label);
  }
});
