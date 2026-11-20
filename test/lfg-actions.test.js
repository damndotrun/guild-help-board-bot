"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const A = require("../modules/lfg/actions");
const C = require("../modules/lfg/channel");
const store = require("../modules/lfg/store");
const { DEFAULTS } = require("../modules/lfg/texts");
const { T0, MIN, dataWith, listing, request, fakeDiscord, fakeCtx } = require("./fixtures/lfg-fakes");

beforeEach(() => C._reset());

const MEMBER = { userId: "u1", displayName: "Dani", level: "member" };
const OTHER = { userId: "u2", displayName: "Marci", level: "member" };
const THIRD = { userId: "u3", displayName: "Ann", level: "member" };
const OFFICER = { userId: "o1", displayName: "Offi", level: "officer" };

function setup(mutate, fakeOpts) {
  const fake = fakeDiscord(fakeOpts);
  for (const r of ["r-sup", "r-dps", "r-radar", "r-hack", "r-gm"]) fake.roles.set(r, { id: r, mentionable: true });
  const ctx = fakeCtx(fake);
  if (mutate !== false) store.save(ctx, dataWith(mutate));
  return { fake, ctx };
}
const journal = (ctx) => store.readLog(path.join(ctx.config.DATA_DIR, store.LOG_FILE));
const live = (ctx) => store.load(ctx).listings;

// ── createListing ──────────────────────────────────────────────────────────

test("createListing: not set up → refused; a valid search is saved before any REST", () => {
  const bare = setup(false);
  assert.deepEqual(A.createListing(bare.ctx, MEMBER, { lookingFor: "basic/sup" }), { ok: false, code: "unconfigured", error: DEFAULTS.notSetUp });
  const { fake, ctx } = setup();
  const r = A.createListing(ctx, MEMBER, { lookingFor: "basic/sup", minutes: "15", note: "gg" });
  assert.equal(r.ok, true);
  assert.equal(typeof r.effects, "function");
  assert.deepEqual(live(ctx).map((l) => [l.posterId, l.posterName, l.startAt, l.note]), [["u1", "Dani", T0 + 15 * MIN, "gg"]]);
  assert.equal(fake.ops.length, 0);
});

test("createListing: one open search per member (with its id for Cancel my search), busy members can't post, bad input writes nothing", () => {
  const { ctx } = setup((x) => {
    x.listings.push(listing("MINE", "u1"));
    x.listings.push(listing("GAME", "p9", { state: "started", joinerId: "u2", startedAt: T0 }));
  });
  assert.deepEqual(A.createListing(ctx, MEMBER, { lookingFor: "basic/sup" }), { ok: false, code: "duplicate", error: DEFAULTS.hasSearch, listingId: "MINE" });
  assert.deepEqual(A.createListing(ctx, OTHER, { lookingFor: "basic/sup" }), { ok: false, code: "busy", error: DEFAULTS.busy });
  assert.deepEqual(A.createListing(ctx, THIRD, { lookingFor: "basic/sup", minutes: "abc" }), { ok: false, code: "invalid", error: DEFAULTS.badMinutes });
  assert.equal(live(ctx).length, 2);
});

test("createListing → effects: the thread link comes back for the ephemeral confirmation", async () => {
  const { ctx } = setup();
  const r = A.createListing(ctx, MEMBER, { lookingFor: "basic/sup" });
  const after = await r.effects();
  assert.equal(after.ok, true);
  assert.match(after.threadUrl, /^https:\/\/discord\.com\/channels\/g1\/th\d+$/);
  assert.equal(live(ctx)[0].threadId, after.threadId);
});

// ── join ───────────────────────────────────────────────────────────────────

test("join: own, closed, gone and busy are refused; a repeat tap reports the existing request", () => {
  const { ctx } = setup((x) => {
    x.listings.push(listing("L1", "u1"));
    x.listings.push(listing("FIX", "p2", { state: "fixed", joinerId: "p3", requests: [request("p3", T0, { status: "accepted" }), request("u3", T0 + 1, { onHold: true })] }));
    x.listings.push(listing("GAME", "p9", { state: "started", joinerId: "u4", startedAt: T0 }));
  });
  assert.equal(A.join(ctx, MEMBER, { listingId: "L1" }).code, "own");
  assert.equal(A.join(ctx, OTHER, { listingId: "FIX" }).code, "closed");
  assert.equal(A.join(ctx, OTHER, { listingId: "nope" }).code, "closed");
  assert.equal(A.join(ctx, { userId: "u4", displayName: "Busy", level: "member" }, { listingId: "L1" }).code, "busy");
  assert.deepEqual(pick(A.join(ctx, THIRD, { listingId: "FIX" })), { ok: true, already: true, status: "pending", position: 1 });
  const first = A.join(ctx, OTHER, { listingId: "L1" });
  assert.deepEqual([first.ok, first.position, first.dmOk], [true, 1, true]);
  assert.deepEqual(pick(A.join(ctx, OTHER, { listingId: "L1" })), { ok: true, already: true, status: "pending", position: 1 });
  assert.equal(live(ctx)[0].requests.length, 1);
  assert.deepEqual(journal(ctx).map((l) => [l.type, l.event]), [["request", "created"]]);
});
const pick = (r) => ({ ok: r.ok, already: r.already, status: r.status, position: r.position });

test("join → effects: the thread notification, the request panel, and the first DM card (silent)", async () => {
  const { fake, ctx } = setup();
  const created = A.createListing(ctx, MEMBER, { lookingFor: "basic/sup" });
  await created.effects();
  fake.ops.length = 0;
  const r = A.join(ctx, OTHER, { listingId: created.listing.id });
  await r.effects();
  const threadId = live(ctx)[0].threadId;
  assert.ok(fake.ops.some((o) => o.op === "send" && o.channelId === threadId && /^<@u1> \*\*Marci\*\* wants to join · 1 waiting$/.test(o.payload.content)));
  assert.ok(fake.ops.some((o) => o.op === "edit" && o.messageId === live(ctx)[0].panelMessageId));
  const dm = fake.ops.find((o) => o.op === "dm");
  assert.equal(dm.channelId, "dm-u2");
  assert.notEqual(dm.payload.flags & (1 << 12), 0); // SuppressNotifications: the first card is silent
});

test("join: dmOk is false when the member's DMs are known closed", () => {
  const { ctx } = setup((x) => { x.listings.push(listing("L1", "u1")); x.dmCards.u2 = { blocked: true, since: T0 }; });
  assert.equal(A.join(ctx, OTHER, { listingId: "L1" }).dmOk, false);
});

test("join: a search whose thread isn't open yet (or failed) is closed — nothing is written", () => {
  const { ctx } = setup((x) => x.listings.push(listing("L1", "u1", { threadId: null, panelMessageId: null })));
  assert.deepEqual(A.join(ctx, OTHER, { listingId: "L1" }), { ok: false, code: "closed", error: DEFAULTS.notOpen });
  assert.equal(live(ctx)[0].requests.length, 0);
  assert.deepEqual(journal(ctx), []);
});

// ── accept / checkIn ───────────────────────────────────────────────────────

test("accept: only the searcher, only once — the second Accept finds the spot taken", () => {
  const { ctx } = setup((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2"), request("u3", T0 + 1)] })));
  assert.equal(A.accept(ctx, OTHER, { listingId: "L1", userId: "u3" }).code, "forbidden");
  assert.equal(A.accept(ctx, MEMBER, { listingId: "L1", userId: "u9" }).code, "not_found");
  const r = A.accept(ctx, MEMBER, { listingId: "L1", userId: "u2" });
  assert.deepEqual([r.ok, r.state, r.joinerName], [true, "confirming", "U2"]);
  assert.deepEqual(A.accept(ctx, MEMBER, { listingId: "L1", userId: "u3" }), { ok: false, code: "taken", error: DEFAULTS.spotTaken });
  assert.deepEqual(journal(ctx).map((l) => l.event), ["accepted"]);
});

test("checkIn: only the two players; early while fixed; the second tap starts the game", async () => {
  const { fake, ctx } = setup((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2", T0, { userName: "Marci" })] })));
  A.accept(ctx, MEMBER, { listingId: "L1", userId: "u2" });
  assert.equal(A.checkIn(ctx, THIRD, { listingId: "L1" }).code, "forbidden");
  assert.equal(A.checkIn(ctx, MEMBER, { listingId: "L1" }).result, "noted");
  assert.equal(A.checkIn(ctx, MEMBER, { listingId: "L1" }).result, "already");
  const r = A.checkIn(ctx, OTHER, { listingId: "L1" });
  assert.equal(r.result, "started");
  await r.effects();
  assert.equal(live(ctx)[0].state, "started");
  assert.ok(fake.ops.some((o) => o.op === "dm" && o.channelId === "dm-u2"));
  assert.equal(A.checkIn(ctx, OTHER, { listingId: "L1" }).result, "already");
  const fixed = setup((x) => x.listings.push(listing("F", "u1", { startAt: T0 + 60 * MIN, expiresAt: T0 + 60 * MIN, requests: [request("u2")] })));
  A.accept(fixed.ctx, MEMBER, { listingId: "F", userId: "u2" });
  assert.deepEqual(A.checkIn(fixed.ctx, OTHER, { listingId: "F" }), { ok: false, code: "early", error: "Not yet — you'll be asked to confirm 5 minutes before the start." });
});

test("checkIn: an open search has nothing to confirm — closed, not a crash, nothing written", () => {
  const { ctx } = setup((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2")] })));
  assert.deepEqual(A.checkIn(ctx, MEMBER, { listingId: "L1" }), { ok: false, code: "closed", error: DEFAULTS.notOpen });
  assert.deepEqual(A.checkIn(ctx, OTHER, { listingId: "L1" }), { ok: false, code: "closed", error: DEFAULTS.notOpen });
  assert.equal(live(ctx)[0].state, "open");
  assert.deepEqual(journal(ctx), []);
});

// ── withdraw / cancel / remove ─────────────────────────────────────────────

test("join and accept: a search past its expiry is closed even before the tick drops it", () => {
  const { ctx } = setup((x) => x.listings.push(listing("L1", "u1", { requests: [request("u3")] })));
  ctx.clock = T0 + 30 * MIN; // expiresAt = T0 + 30 min
  assert.deepEqual(A.join(ctx, OTHER, { listingId: "L1" }), { ok: false, code: "closed", error: DEFAULTS.notOpen });
  assert.deepEqual(A.accept(ctx, MEMBER, { listingId: "L1", userId: "u3" }), { ok: false, code: "closed", error: DEFAULTS.notOpen });
  assert.equal(live(ctx)[0].state, "open");
});

test("withdraw: an accepted request in a started game is refused", () => {
  const { ctx } = setup((x) => x.listings.push(listing("G", "u1", { state: "started", joinerId: "u2", startedAt: T0, requests: [request("u2", T0, { status: "accepted" })] })));
  assert.deepEqual(A.withdraw(ctx, OTHER, { listingId: "G" }), { ok: false, code: "started", error: DEFAULTS.gameStarted });
  assert.equal(live(ctx)[0].requests[0].status, "accepted");
});

test("withdraw and withdrawAll: only own pending requests; nothing to cancel is reported", () => {
  const { ctx } = setup((x) => {
    x.listings.push(listing("A", "p1", { requests: [request("u2")] }));
    x.listings.push(listing("B", "p2", { requests: [request("u2"), request("u3")] }));
  });
  assert.equal(A.withdraw(ctx, THIRD, { listingId: "A" }).code, "not_found");
  assert.equal(A.withdraw(ctx, OTHER, { listingId: "A" }).ok, true);
  assert.equal(A.withdrawAll(ctx, OTHER).count, 1);
  assert.equal(A.withdrawAll(ctx, OTHER).code, "not_found");
  assert.deepEqual(live(ctx).map((l) => l.requests.map((r) => [r.userId, r.status])), [[["u2", "withdrawn"]], [["u2", "withdrawn"], ["u3", "pending"]]]);
});

test("cancelListing: only the searcher, not once started; removeListing: officers only, recorded with who", () => {
  const { ctx } = setup((x) => {
    x.listings.push(listing("A", "u1", { requests: [request("u2")] }));
    x.listings.push(listing("B", "u2"));
    x.listings.push(listing("G", "u3", { state: "started", joinerId: "u4", startedAt: T0 }));
  });
  assert.equal(A.cancelListing(ctx, OTHER, { listingId: "A" }).code, "forbidden");
  assert.equal(A.cancelListing(ctx, THIRD, { listingId: "G" }).code, "started");
  assert.equal(A.cancelListing(ctx, MEMBER, { listingId: "A" }).ok, true);
  assert.deepEqual(A.removeListing(ctx, OTHER, { listingId: "B" }), { ok: false, code: "forbidden", error: DEFAULTS.officerOnly });
  assert.equal(A.removeListing(ctx, OFFICER, { listingId: "B" }).ok, true);
  assert.deepEqual(live(ctx).map((l) => l.id), ["G"]);
  const lines = journal(ctx).filter((l) => l.type === "listing").map((l) => [l.id, l.outcome, l.reason ?? null, l.removedBy ?? null]);
  assert.deepEqual(lines, [["A", "cancelled", "self", null], ["B", "removed", null, "o1"]]);
});

// ── roles and settings ─────────────────────────────────────────────────────

test("setSubscriptions: toggle and set, a refused role reported, a subscription journal line", async () => {
  const { fake, ctx } = setup(undefined, { roleFail: ["r-hack"] });
  const m = fake.member("u1", { roleIds: ["r-sup"] });
  const t = await A.setSubscriptions(ctx, MEMBER, { member: m, picked: ["r-sup", "r-dps", "r-hack"], mode: "toggle" });
  assert.deepEqual(t, { ok: true, added: ["r-dps"], removed: ["r-sup"], failed: ["r-hack"] });
  const s = await A.setSubscriptions(ctx, MEMBER, { member: m, picked: ["r-radar"], mode: "set" });
  assert.deepEqual(s, { ok: true, added: ["r-radar"], removed: ["r-dps"], failed: [] });
  assert.equal((await A.setSubscriptions(ctx, MEMBER, { member: fake.member("u9") })).code, "forbidden");
  assert.deepEqual(journal(ctx).map((l) => [l.type, l.added, l.removed, l.failed]), [["subscription", ["r-dps"], ["r-sup"], ["r-hack"]], ["subscription", ["r-radar"], ["r-dps"], []]]);
});

test("setDm and setGmPings: prefs saved with defaults, GM-PING role on/off, both journaled", async () => {
  const { fake, ctx } = setup();
  assert.deepEqual(A.setDm(ctx, MEMBER, { kind: "dm", on: true }).prefs, { dm: true, requestDm: true });
  assert.deepEqual(A.setDm(ctx, MEMBER, { kind: "requestDm", on: false }).prefs, { dm: true, requestDm: false });
  assert.equal(A.setDm(ctx, MEMBER, { kind: "evil", on: true }).code, "invalid");
  const m = fake.member("u1");
  assert.deepEqual(await A.setGmPings(ctx, MEMBER, { member: m, on: true }), { ok: true, on: true });
  assert.ok(m.roles.cache.has("r-gm"));
  assert.deepEqual(await A.setGmPings(ctx, MEMBER, { member: m, on: false }), { ok: true, on: false });
  assert.deepEqual(journal(ctx).map((l) => [l.type, l.dm ?? l.on]), [["prefs", true], ["prefs", true], ["gmPing", true], ["gmPing", false]]);
  const noGm = setup((x) => { x.config.gmPingRoleId = null; });
  assert.equal((await A.setGmPings(noGm.ctx, MEMBER, { member: m, on: true })).code, "unconfigured");
});

test("consumeNotices: read once, then gone", () => {
  const { ctx } = setup((x) => { x.notices.u1 = [{ listingId: "A", outcome: "expired", ts: T0, name: "Dani", label: "BASIC · SUP" }]; });
  assert.deepEqual(A.consumeNotices(ctx, MEMBER).notices.map((n) => n.outcome), ["expired"]);
  assert.deepEqual(A.consumeNotices(ctx, MEMBER).notices, []);
  assert.equal(store.load(ctx).notices.u1, undefined);
});
