"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const S = require("../modules/lfg/state");
const { textOf, DEFAULTS } = require("../modules/lfg/texts");
const { T0, MIN, dataWith, listing, request } = require("./fixtures/lfg-fakes");

const types = (out) => out.events.map((e) => e.type);
const cardKinds = (out) => out.events.filter((e) => e.type === "card").map((e) => [e.userId, e.event.kind]);

// ── texts ──────────────────────────────────────────────────────────────────

test("texts: defaults, {placeholders}, config overrides and unknown keys", () => {
  assert.equal(textOf(null, "boardMore", { n: 3 }), "+3 more — open /menu › Browse");
  assert.equal(textOf({ texts: { panelTitle: "Fancy a game?" } }, "panelTitle"), "Fancy a game?");
  assert.equal(textOf({ texts: { panelTitle: 42 } }, "panelTitle"), DEFAULTS.panelTitle); // non-string override ignored
  assert.equal(textOf(null, "requestSent", { poster: "Dani" }), "Request sent to **Dani** — you're #{n} in line. Updates come in your DMs.");
  assert.throws(() => textOf(null, "nope"), /unknown text key "nope"/);
});

// ── shape ──────────────────────────────────────────────────────────────────

test("shape: garbage becomes an empty store; unknown fields and listings survive with defaults", () => {
  assert.deepEqual(S.shape(null), S.emptyData());
  assert.deepEqual(S.shape([1, 2]), S.emptyData());
  const d = S.shape({
    future: { x: 1 },
    config: { channelId: "c", categories: [{ id: "a", name: "A", buttons: [{ id: "b", label: "B" }] }], times: { nowTtlMin: 10 } },
    listings: [{ id: "L1", posterId: "u1", createdAt: T0 }, "junk"],
    prefs: "bad",
  });
  assert.deepEqual(d.future, { x: 1 });
  assert.deepEqual(d.config.times, { ...S.DEFAULT_TIMES, nowTtlMin: 10 });
  assert.deepEqual(d.config.layout, [{ type: "board" }]);
  assert.deepEqual(d.config.categories[0].buttons[0], { id: "b", label: "B", pingRoleIds: [], subscribeRoleId: null });
  assert.equal(d.listings.length, 1);
  const L = d.listings[0];
  assert.deepEqual([L.state, L.startAt, L.joinerId, L.checkIn, L.requests, L.expiresAt], ["open", null, null, null, [], T0 + 30 * MIN]);
  assert.deepEqual(d.prefs, {});
});

test("shape: the channel holds one message id; the old per-block map survives only while non-empty (migration)", () => {
  const empty = { mainMessageId: null, staleIds: [], pingMessageId: null, pingUntil: null };
  assert.deepEqual(S.emptyData().channel, empty);
  assert.deepEqual(S.shape({ channel: { mainMessageId: 5, messageIds: {} } }).channel, empty);
  assert.deepEqual(S.shape({ channel: { messageIds: "bad", pingMessageId: "p", staleIds: "x" } }).channel, { ...empty, pingMessageId: "p" });
  const old = S.shape({ channel: { messageIds: { 0: "a", 2: "b" }, pingMessageId: null, pingUntil: null } }).channel;
  assert.deepEqual(old, { ...empty, messageIds: { 0: "a", 2: "b" } });
  assert.equal(S.shape({ channel: { mainMessageId: "m1" } }).channel.mainMessageId, "m1");
  assert.deepEqual(S.shape({ channel: { staleIds: ["s1", 3, "", null, "s2"] } }).channel.staleIds, ["s1", "s2"]);
});

// ── input──────────────────────────────────────────────────────────────────

test("parseMinutes: empty / 0 = now; whole 1–1440; everything else refused", () => {
  const cases = [["", 0], ["0", 0], [" 15 ", 15], ["1", 1], ["01", 1], ["1440", 1440], [undefined, 0]];
  for (const [raw, minutes] of cases) assert.deepEqual(S.parseMinutes(raw), { ok: true, minutes }, String(raw));
  for (const raw of ["1441", "-1", "1.5", "abc", "+5", "1e3", "5 min", "１"]) assert.deepEqual(S.parseMinutes(raw), { ok: false }, raw);
});

test("noteError: ≤ 100 characters, no control or bidi characters", () => {
  assert.equal(S.noteError(null, "x".repeat(100)), null);
  assert.equal(S.noteError(null, `  ${"x".repeat(100)}  `), null); // trimmed first
  assert.equal(S.noteError(null, "x".repeat(101)), DEFAULTS.noteTooLong);
  assert.equal(S.noteError(null, "two\nlines"), "Use letters, numbers and punctuation only.");
  assert.equal(S.noteError(null, `spoof${String.fromCodePoint(0x202e)}`), "Use letters, numbers and punctuation only.");
});

test("resolveSearch: a custom search — now, timed, and each refused field", () => {
  const d = dataWith();
  assert.deepEqual(S.resolveSearch(d, "u1", { lookingFor: "basic/sup", minutes: "", note: " gg " }, T0), {
    ok: true, categoryId: "basic", buttonId: "sup", startAt: null, note: "gg",
  });
  assert.equal(S.resolveSearch(d, "u1", { lookingFor: "ddps/any", minutes: "20" }, T0).startAt, T0 + 20 * MIN);
  const refused = [
    [{ minutes: "5" }, DEFAULTS.needLookingFor],
    [{ lookingFor: "basic/nope" }, DEFAULTS.badOption],
    [{ lookingFor: "garbage" }, DEFAULTS.badOption],
    [{ lookingFor: "basic/sup", minutes: "1441" }, DEFAULTS.badMinutes],
    [{ lookingFor: "basic/sup", note: "x".repeat(101) }, DEFAULTS.noteTooLong],
  ];
  for (const [input, error] of refused) assert.deepEqual(S.resolveSearch(d, "u1", input, T0), { ok: false, error }, JSON.stringify(input));
});

test("resolveSearch: a favorite wins over filled fields; stale or someone else's favorite is refused", () => {
  const d = dataWith((x) => {
    x.favorites.u1 = [
      { id: "f1", categoryId: "ddps", buttonId: "radar", minutes: 10, note: "fav" },
      { id: "f2", categoryId: "ddps", buttonId: "gone", minutes: 0, note: "" },
    ];
    x.favorites.u2 = [{ id: "f3", categoryId: "basic", buttonId: "sup", minutes: 0, note: "" }];
  });
  assert.deepEqual(S.resolveSearch(d, "u1", { favoriteId: "f1", lookingFor: "basic/sup", minutes: "999", note: "ignored" }, T0), {
    ok: true, categoryId: "ddps", buttonId: "radar", startAt: T0 + 10 * MIN, note: "fav",
  });
  assert.deepEqual(S.resolveSearch(d, "u1", { favoriteId: "f2" }, T0), { ok: false, error: DEFAULTS.favoriteStale });
  assert.deepEqual(S.resolveSearch(d, "u1", { favoriteId: "f3" }, T0), { ok: false, error: DEFAULTS.favoriteStale });
});

test("lookingForOptions, subscribable and subscriptionDiff", () => {
  const d = dataWith();
  assert.deepEqual(S.lookingForOptions(d.config).map((o) => o.value), ["basic/sup", "basic/dps", "basic/gm", "ddps/radar", "ddps/hack", "ddps/any"]);
  assert.equal(S.lookingForOptions(d.config)[0].label, "BASIC · SUP");
  assert.deepEqual(S.subscribable(d.config).map((s) => s.roleId), ["r-sup", "r-dps", "r-radar", "r-hack"]);
  const sub = ["r-sup", "r-dps", "r-radar"];
  // toggle: picked + held → removed, picked + missing → added, a non-subscribable pick is ignored
  assert.deepEqual(S.subscriptionDiff(sub, ["r-sup", "x"], ["r-sup", "r-dps", "r-gm"], "toggle"), { add: ["r-dps"], remove: ["r-sup"] });
  // set: the pick is the whole wanted list
  assert.deepEqual(S.subscriptionDiff(sub, ["r-sup", "r-radar", "x"], ["r-dps", "r-radar"], "set"), { add: ["r-dps"], remove: ["r-sup"] });
  assert.deepEqual(S.subscriptionDiff(sub, ["r-sup"], [], "set"), { add: [], remove: ["r-sup"] });
});

// ── create / join / accept ─────────────────────────────────────────────────

test("createListing: a now-search lapses after nowTtlMin, a timed one at its start", () => {
  const d = dataWith();
  const now = S.createListing(d, { posterId: "u1", posterName: "Dani", categoryId: "basic", buttonId: "sup", note: "", startAt: null }, T0);
  const timed = S.createListing(d, { posterId: "u2", posterName: "Marci", categoryId: "basic", buttonId: "dps", note: "x", startAt: T0 + 60 * MIN }, T0);
  assert.equal(now.expiresAt, T0 + 30 * MIN);
  assert.equal(timed.expiresAt, T0 + 60 * MIN);
  assert.match(now.id, /^[0-9a-f]{10}$/);
  assert.notEqual(now.id, timed.id);
  assert.equal(S.ownListing(d, "u2"), timed);
  // B7: a search whose thread is still opening is neither shown nor counted
  assert.deepEqual(S.joinable(d), []);
  now.threadId = "th-a";
  timed.threadId = "th-b";
  assert.deepEqual(S.joinable(d).map((l) => l.posterId), ["u1", "u2"]);
});

test("addRequest: line position, the panel event and a request log line", () => {
  const L = listing("L1", "u1");
  const out = S.newOut();
  S.addRequest(L, { userId: "u2", userName: "Zed" }, T0 + 1, out);
  S.addRequest(L, { userId: "u3", userName: "Ann" }, T0 + 2, out);
  assert.deepEqual([S.queuePosition(L, "u2"), S.queuePosition(L, "u3"), S.queuePosition(L, "u9")], [1, 2, 0]);
  assert.deepEqual(out.log[0], { type: "request", ts: T0 + 1, listingId: "L1", userId: "u2", event: "created" });
  assert.deepEqual(types(out), ["panel", "panel"]);
});

test("acceptRequest: a now-search confirms at once (5-minute window); the rest are on hold", () => {
  const d = dataWith((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2"), request("u3", T0 + 1)] })));
  const L = d.listings[0];
  const out = S.newOut();
  assert.equal(S.acceptRequest(d, L, L.requests[0], T0 + 2 * MIN, out), "confirming");
  assert.deepEqual([L.joinerId, L.acceptedAt, L.requests[0].status, L.requests[1].onHold], ["u2", T0 + 2 * MIN, "accepted", true]);
  assert.deepEqual(L.checkIn, { openedAt: T0 + 2 * MIN, deadline: T0 + 7 * MIN, nagMessageId: null, at: {}, nags: {} });
  assert.deepEqual(cardKinds(out), [["u2", "accepted"]]);
  assert.ok(out.events.some((e) => e.type === "cardRefresh" && e.userId === "u3"));
  assert.equal(S.isBusy(d, "u2"), false); // confirming does not make anyone busy (U9)
});

test("acceptRequest: a timed search is fixed until startAt − lead; within the lead it confirms, deadline = start", () => {
  const far = dataWith((x) => x.listings.push(listing("L1", "u1", { startAt: T0 + 60 * MIN, expiresAt: T0 + 60 * MIN, requests: [request("u2")] })));
  assert.equal(S.acceptRequest(far, far.listings[0], far.listings[0].requests[0], T0, S.newOut()), "fixed");
  assert.equal(far.listings[0].checkIn, null);
  const near = dataWith((x) => x.listings.push(listing("L1", "u1", { startAt: T0 + 4 * MIN, expiresAt: T0 + 4 * MIN, requests: [request("u2")] })));
  assert.equal(S.acceptRequest(near, near.listings[0], near.listings[0].requests[0], T0, S.newOut()), "confirming");
  assert.equal(near.listings[0].checkIn.deadline, T0 + 5 * MIN); // max(start, now + 5)
  const late = dataWith((x) => x.listings.push(listing("L1", "u1", { startAt: T0 + 3 * MIN, expiresAt: T0 + 3 * MIN, requests: [request("u2")] })));
  S.acceptRequest(late, late.listings[0], late.listings[0].requests[0], T0 + 2 * MIN, S.newOut());
  assert.equal(late.listings[0].checkIn.deadline, T0 + 7 * MIN);
});

test("advance: a fixed game opens its confirm window exactly at startAt − reminderLeadMin", () => {
  const d = dataWith((x) => x.listings.push(listing("L1", "u1", { state: "fixed", startAt: T0 + 60 * MIN, expiresAt: T0 + 60 * MIN, joinerId: "u2", acceptedAt: T0, requests: [request("u2", T0, { status: "accepted" })] })));
  assert.deepEqual(S.advance(d, T0 + 55 * MIN - 1).events, []);
  const r = S.advance(d, T0 + 55 * MIN);
  assert.equal(d.listings[0].state, "confirming");
  assert.equal(d.listings[0].checkIn.deadline, T0 + 60 * MIN);
  assert.deepEqual(r.events.map((e) => e.type), ["checkInOpen", "panel", "card"]);
  assert.equal(r.events[2].event.kind, "checkInOpen");
});

// ── confirm / start / busy ─────────────────────────────────────────────────

function confirming(extra = {}) {
  return listing("L1", "u1", {
    state: "confirming",
    joinerId: "u2",
    acceptedAt: T0,
    checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: null, at: {}, nags: {} },
    requests: [request("u2", T0, { status: "accepted" }), request("u3", T0 + 1, { onHold: true })],
    ...extra,
  });
}

test("confirmPresence: early while fixed, noted once, already on a second tap, started on the second player", () => {
  const fixed = dataWith((x) => x.listings.push(listing("L1", "u1", { state: "fixed", joinerId: "u2" })));
  assert.equal(S.confirmPresence(fixed, fixed.listings[0], "u1", T0, S.newOut()), "early");
  const d = dataWith((x) => x.listings.push(confirming()));
  const L = d.listings[0];
  const noted = S.newOut();
  assert.equal(S.confirmPresence(d, L, "u1", T0 + 1000, noted), "noted");
  assert.deepEqual(types(noted), ["cardRefresh", "welcome", "panel"]); // the ✓ shows in the thread and on the card
  assert.equal(S.confirmPresence(d, L, "u1", T0 + 2000, S.newOut()), "already");
  assert.equal(L.state, "confirming");
  assert.equal(S.isBusy(d, "u1"), false);
  const out = S.newOut();
  assert.equal(S.confirmPresence(d, L, "u2", T0 + 3000, out), "started");
  assert.deepEqual([L.state, L.startedAt, L.checkIn.at], ["started", T0 + 3000, { u1: T0 + 1000, u2: T0 + 3000 }]);
  assert.equal(S.isBusy(d, "u1"), true);
  assert.equal(S.isBusy(d, "u2"), true);
  assert.deepEqual([L.requests[1].status, L.requests[1].reason], ["closed", "filled"]);
  assert.deepEqual(cardKinds(out), [["u3", "full"]]);
});

test("startGame: the busy rule — other requests withdrawn, own search cancelled, an accept elsewhere reopens", () => {
  const d = dataWith((x) => {
    x.listings.push(confirming({ checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: null, at: { u1: T0 }, nags: {} } }));
    // u2 (the joiner) has his own search with a requester…
    x.listings.push(listing("OWN", "u2", { categoryId: "ddps", buttonId: "radar", requests: [request("u7")] }));
    // …a pending request on someone else's search…
    x.listings.push(listing("ELSE", "u5", { requests: [request("u2"), request("u8", T0 + 5)] }));
    // …and u1 (the poster) was accepted on another one meanwhile.
    x.listings.push(listing("ACC", "u6", { state: "confirming", joinerId: "u1", acceptedAt: T0, checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: null, at: {}, nags: {} }, requests: [request("u1", T0, { status: "accepted" }), request("u9", T0 + 1, { onHold: true })] }));
  });
  const out = S.newOut();
  assert.equal(S.confirmPresence(d, d.listings[0], "u2", T0 + MIN, out), "started");
  assert.equal(S.findListing(d, "OWN"), null);
  const ownLine = out.log.find((l) => l.type === "listing" && l.id === "OWN");
  assert.deepEqual([ownLine.outcome, ownLine.reason], ["cancelled", "matched_elsewhere"]);
  assert.ok(cardKinds(out).some(([u, k]) => u === "u7" && k === "cancelled"));
  const ELSE = S.findListing(d, "ELSE");
  assert.deepEqual([ELSE.requests[0].status, ELSE.requests[0].reason], ["withdrawn", "matched_elsewhere"]);
  assert.equal(S.queuePosition(ELSE, "u8"), 1);
  const ACC = S.findListing(d, "ACC");
  assert.deepEqual([ACC.state, ACC.joinerId, ACC.requests[0].status, ACC.requests[0].reason, ACC.requests[1].onHold], ["open", null, "withdrawn", "matched_elsewhere", false]);
  assert.deepEqual(d.listings[0].cancelledOthers.sort(), ["u1", "u2"]);
  assert.ok(out.events.some((e) => e.type === "reopened" && e.listingId === "ACC" && e.reason === "matched_elsewhere"));
});

// ── deadlines (§3.4) ───────────────────────────────────────────────────────

test("deadline: the joiner didn't confirm → the search reopens with its line; a passed start becomes now", () => {
  const d = dataWith((x) => x.listings.push(confirming({
    startAt: T0 + 3 * MIN,
    expiresAt: T0 + 3 * MIN,
    welcomeMessageId: "wm1",
    checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: "nag1", at: { u1: T0 }, nags: { u2: 4 } },
  })));
  assert.deepEqual(S.advance(d, T0 + 5 * MIN - 1).events.filter((e) => e.type !== "nag" && e.type !== "card"), []);
  const r = S.advance(d, T0 + 5 * MIN);
  const L = d.listings[0];
  assert.deepEqual([L.state, L.joinerId, L.checkIn, L.startAt, L.expiresAt, L.welcomeMessageId], ["open", null, null, null, T0 + 35 * MIN, null]);
  assert.deepEqual([L.requests[0].status, L.requests[0].reason, L.requests[1].onHold], ["closed", "no_confirm", false]);
  assert.deepEqual(r.log.find((l) => l.event === "closed"), { type: "request", ts: T0 + 5 * MIN, listingId: "L1", userId: "u2", event: "closed", reason: "no_confirm", nags: 4 });
  // B3: the last nag line travels with the event, so the handler can delete it
  assert.deepEqual(r.events.find((e) => e.type === "reopened"), { type: "reopened", listingId: "L1", joinerId: "u2", welcomeMessageId: "wm1", nagMessageId: "nag1", threadId: "th-L1", reason: "no_confirm" });
  assert.deepEqual(r.events.filter((e) => e.type === "card").map((e) => [e.userId, e.event.kind]), [["u2", "noConfirm"]]);
});

test("deadline: the searcher didn't confirm (or neither did) → cancelled, everyone in line hears it", () => {
  for (const at of [{ u2: T0 }, {}]) {
    const d = dataWith((x) => x.listings.push(confirming({ checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: null, at, nags: {} } })));
    const r = S.advance(d, T0 + 5 * MIN);
    assert.equal(d.listings.length, 0, JSON.stringify(at));
    const line = r.log.find((l) => l.type === "listing");
    assert.deepEqual([line.outcome, line.reason, line.joinerId], ["cancelled", "no_confirm", "u2"]);
    assert.deepEqual(r.events.filter((e) => e.type === "card").map((e) => [e.userId, e.event.kind]), [["u2", "posterNoConfirm"], ["u3", "posterNoConfirm"]]);
  }
});

test("nags: one a minute to whoever hasn't confirmed, at most checkInWindowMin, none after confirming", () => {
  const d = dataWith((x) => x.listings.push(confirming({ checkIn: { openedAt: T0, deadline: T0 + 20 * MIN, nagMessageId: null, at: {}, nags: {} } })));
  const L = d.listings[0];
  const nags = (now) => S.advance(d, now).events.filter((e) => e.type === "nag").map((e) => e.userId);
  assert.deepEqual(nags(T0 + MIN - 1), []);
  assert.deepEqual(nags(T0 + MIN), ["u1", "u2"]);
  assert.deepEqual(nags(T0 + MIN + 30_000), []); // the 30-second tick does not double up
  L.checkIn.at.u1 = T0 + MIN + 40_000;
  assert.deepEqual(nags(T0 + 2 * MIN), ["u2"]);
  for (const m of [3, 4, 5]) assert.deepEqual(nags(T0 + m * MIN), ["u2"]);
  assert.deepEqual(nags(T0 + 6 * MIN), []); // 5 = checkInWindowMin reached
  assert.deepEqual(L.checkIn.nags, { u1: 1, u2: 5 });
});

// ── lapse / drop / withdraw ────────────────────────────────────────────────

test("advance: a now-search lapses after 30 min, a timed one at its start; requesters hear it; one listing line each", () => {
  const d = dataWith((x) => {
    x.listings.push(listing("NOW", "u1", { note: "abc", requests: [request("u2")] }));
    x.listings.push(listing("TIMED", "u3", { startAt: T0 + 10 * MIN, expiresAt: T0 + 10 * MIN }));
  });
  assert.equal(S.advance(d, T0 + 10 * MIN - 1).events.length, 0);
  assert.deepEqual(S.advance(d, T0 + 10 * MIN).log.map((l) => [l.type, l.id, l.outcome]), [["listing", "TIMED", "expired"]]);
  const r = S.advance(d, T0 + 30 * MIN);
  assert.deepEqual(d.listings, []);
  const line = r.log.find((l) => l.type === "listing");
  assert.deepEqual(line, {
    type: "listing", ts: T0 + 30 * MIN, id: "NOW", posterId: "u1", categoryId: "basic", buttonId: "sup", noteLength: 3,
    createdAt: T0, startAt: null, outcome: "expired", acceptedAt: null, joinerId: null, startedAt: null, endedAt: T0 + 30 * MIN,
    pingRoleIds: ["r-sup"], dmCount: 0, requests: [{ userId: "u2", createdAt: T0, status: "closed", closedAt: T0 + 30 * MIN, reason: "expired" }], checkIn: null,
  });
  assert.deepEqual(r.events.filter((e) => e.type === "card").map((e) => [e.userId, e.event.kind, e.event.aboutName, e.event.label]), [["u2", "expired", "U1", "BASIC · SUP"]]);
  assert.deepEqual(r.events.find((e) => e.type === "dropped").outcome, "expired");
});

test("advance: a started game leaves the board after startedVisibleMin as matched, without card news", () => {
  const d = dataWith((x) => x.listings.push(listing("L1", "u1", { state: "started", joinerId: "u2", startedAt: T0, requests: [request("u2", T0, { status: "accepted" })] })));
  assert.equal(S.advance(d, T0 + 5 * MIN - 1).events.length, 0);
  const r = S.advance(d, T0 + 5 * MIN);
  assert.equal(d.listings.length, 0);
  // the winner's request is recorded as played, not as a closed / filled one
  assert.deepEqual(r.log.map((l) => l.type), ["listing"]);
  assert.equal(r.log[0].outcome, "matched");
  assert.deepEqual(r.log[0].requests, [{ userId: "u2", createdAt: T0, status: "accepted", closedAt: T0 + 5 * MIN, reason: "played" }]);
  assert.equal(r.events.filter((e) => e.type === "card").length, 0);
});

test("advance: a search that never got its thread is dropped after 2 minutes (thread_failed)", () => {
  const d = dataWith((x) => x.listings.push(listing("GHOST", "u1", { threadId: null, panelMessageId: null, requests: [request("u2")] })));
  assert.deepEqual(S.advance(d, T0 + S.THREAD_GRACE_MS).events, []);
  const r = S.advance(d, T0 + S.THREAD_GRACE_MS + 1);
  assert.deepEqual(d.listings, []);
  const line = r.log.find((l) => l.type === "listing");
  assert.deepEqual([line.outcome, line.reason], ["cancelled", "thread_failed"]);
  assert.deepEqual(r.events.filter((e) => e.type === "card").map((e) => [e.userId, e.event.kind]), [["u2", "cancelled"]]);
});

test("shape: a game without a joiner reopens; confirming without a checkIn gets a past deadline, so advance never throws", () => {
  const d = S.shape({ listings: [
    { id: "A", posterId: "u1", createdAt: T0, threadId: "t", state: "fixed", joinerId: null },
    { id: "B", posterId: "u2", createdAt: T0, threadId: "t", state: "confirming", joinerId: "u3", acceptedAt: T0, requests: [request("u3", T0, { status: "accepted" })] },
    { id: "C", posterId: "u4", createdAt: T0, threadId: "t", state: "confirming", joinerId: "u5", checkIn: { openedAt: T0, deadline: T0 + MIN } },
  ] });
  assert.deepEqual([d.listings[0].state, d.listings[0].checkIn], ["open", null]);
  assert.deepEqual(d.listings[1].checkIn, { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: null, at: {}, nags: {} });
  assert.deepEqual([d.listings[2].checkIn.at, d.listings[2].checkIn.nags], [{}, {}]);
  d.config = dataWith().config;
  assert.doesNotThrow(() => S.advance(d, T0 + 10 * MIN));
  assert.equal(S.findListing(d, "B"), null); // decided as a missed check-in
});

test("shape: null note / cancelledOthers get their defaults; a non-number deadline drops the checkIn (B9)", () => {
  const d = S.shape({ listings: [
    { id: "A", posterId: "u1", createdAt: T0, threadId: "t", note: null, cancelledOthers: null, dmCount: null, state: null },
    { id: "B", posterId: "u2", createdAt: T0, threadId: "t", state: "confirming", joinerId: "u3", acceptedAt: T0, checkIn: { openedAt: T0, deadline: "soon", at: {}, nags: {} }, requests: [request("u3", T0, { status: "accepted" })] },
    { id: "C", posterId: "u4", createdAt: T0, threadId: "t", state: "fixed", joinerId: "u5", startAt: T0 + 60 * MIN, checkIn: { deadline: null } },
  ] });
  const [A, B, C] = d.listings;
  assert.deepEqual([A.note, A.cancelledOthers, A.dmCount, A.state], ["", [], 0, "open"]);
  // confirming: the broken checkIn is replaced by the repair one (deadline already past)
  assert.deepEqual(B.checkIn, { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: null, at: {}, nags: {} });
  assert.equal(C.checkIn, null); // fixed: no checkIn until the window opens
  d.config = dataWith().config;
  const out = S.newOut();
  assert.doesNotThrow(() => S.dropListing(d, A, { outcome: "cancelled", reason: "self" }, T0, out));
  assert.equal(out.log.find((l) => l.type === "listing").noteLength, 0);
  assert.doesNotThrow(() => S.advance(d, T0 + 10 * MIN));
});

test("favorites that are not a list are ignored, not thrown on (B10)", () => {
  const d = dataWith((x) => { x.favorites.u1 = "junk"; x.favorites.u2 = { id: "f1" }; });
  assert.deepEqual(S.resolveSearch(d, "u1", { favoriteId: "f1" }, T0), { ok: false, error: DEFAULTS.favoriteStale });
  assert.deepEqual(S.resolveSearch(d, "u2", { favoriteId: "f1" }, T0), { ok: false, error: DEFAULTS.favoriteStale });
});

test("dropListing: an officer removal records who; requesters get a cancelled event", () => {
  const d = dataWith((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2")] })));
  const out = S.newOut();
  S.dropListing(d, d.listings[0], { outcome: "removed", removedBy: "o1" }, T0 + MIN, out);
  const line = out.log.find((l) => l.type === "listing");
  assert.deepEqual([line.outcome, line.removedBy, line.requests[0].reason], ["removed", "o1", "removed"]);
  assert.deepEqual(cardKinds(out), [["u2", "cancelled"]]);
});

test("withdrawRequest: a pending request is withdrawn (self); an accepted one reopens the search", () => {
  const d = dataWith((x) => x.listings.push(listing("L1", "u1", { requests: [request("u2"), request("u3", T0 + 1)] })));
  const out = S.newOut();
  assert.equal(S.withdrawRequest(d, d.listings[0], "u2", T0 + MIN, out), true);
  assert.deepEqual([d.listings[0].requests[0].status, d.listings[0].requests[0].reason], ["withdrawn", "self"]);
  assert.equal(S.queuePosition(d.listings[0], "u3"), 1);
  assert.ok(out.events.some((e) => e.type === "cardRefresh" && e.userId === "u3")); // their place changed
  assert.equal(S.withdrawRequest(d, d.listings[0], "u2", T0 + MIN, S.newOut()), false);
  const c = dataWith((x) => x.listings.push(confirming()));
  const out2 = S.newOut();
  assert.equal(S.withdrawRequest(c, c.listings[0], "u2", T0 + MIN, out2), true);
  assert.deepEqual([c.listings[0].state, c.listings[0].requests[0].status, c.listings[0].requests[0].reason], ["open", "withdrawn", "self"]);
  assert.equal(out2.events.filter((e) => e.type === "card").length, 0); // no bad news for leaving yourself
});

// ── recommend / DM candidates ──────────────────────────────────────────────

test("recommend: up to 3 open searches — not own, not already asked, same category first, soonest first; none when busy", () => {
  const d = dataWith((x) => {
    x.listings.push(listing("A", "p1", { categoryId: "ddps", buttonId: "radar", createdAt: T0 }));
    x.listings.push(listing("B", "p2", { createdAt: T0 + 1 }));
    x.listings.push(listing("C", "p3", { categoryId: "ddps", buttonId: "hack", createdAt: T0 + 2, requests: [request("u1")] }));
    x.listings.push(listing("D", "p4", { categoryId: "ddps", buttonId: "any", createdAt: T0 + 3 }));
    x.listings.push(listing("E", "u1", { createdAt: T0 + 4 }));
    x.listings.push(listing("F", "p5", { state: "fixed", createdAt: T0 + 5 }));
    x.listings.push(listing("G", "p6", { startAt: T0 + 9, createdAt: T0 + 9 }));
  });
  assert.deepEqual(S.recommend(d, "u1").map((l) => l.id), ["A", "D", "B"]);
  d.listings.push(listing("S", "u1x", { state: "started", joinerId: "u1", startedAt: T0 }));
  assert.deepEqual(S.recommend(d, "u1"), []);
});

test("dmCandidates and pingTargets", () => {
  const d = dataWith((x) => {
    x.prefs = { u1: { dm: true }, u2: { dm: true }, u3: { dm: false }, u4: { dm: true } };
    x.listings.push(listing("L1", "u1", { buttonId: "gm" }));
    x.listings.push(listing("S", "p9", { state: "started", joinerId: "u4", startedAt: T0 }));
  });
  assert.deepEqual(S.dmCandidates(d, d.listings[0]), ["u2"]);
  assert.deepEqual(S.pingTargets(d.config, d.listings[0]), ["r-gm"]);
  assert.deepEqual(S.pingTargets(d.config, { categoryId: "x", buttonId: "y" }), []);
});

// ── DM cards and notices ───────────────────────────────────────────────────

test("cardView: requests with place and on-hold, the accepted game, bad-news events for 24 h only", () => {
  const d = dataWith((x) => {
    x.listings.push(listing("A", "p1", { requests: [request("u9"), request("u1", T0 + 1)] }));
    x.listings.push(listing("B", "p2", { state: "fixed", joinerId: "u8", requests: [request("u8", T0, { status: "accepted" }), request("u1", T0 + 1, { onHold: true })] }));
    x.listings.push(listing("C", "p3"));
  });
  const v = S.cardView(d, "u1", T0);
  assert.deepEqual(v.requests.map((r) => [r.listing.id, r.position, r.onHold]), [["A", 2, false], ["B", 1, true]]);
  assert.deepEqual(v.stillOpen.map((l) => l.id), ["C"]);
  assert.deepEqual([v.accepted, v.event, v.empty], [null, null, false]);
  d.dmCards.u7 = { messageId: "m1", sentAt: T0, lastEventAt: T0, event: { kind: "full", at: T0, aboutName: "P", label: "BASIC · SUP", emoji: "💥" } };
  assert.equal(S.cardView(d, "u7", T0 + 1).event.kind, "full");
  assert.equal(S.cardView(d, "u7", T0 + 1).empty, false);
  assert.equal(S.cardView(d, "u7", T0 + 24 * 60 * MIN).empty, true);
  d.dmCards.u7.event.kind = "accepted"; // not a box kind
  assert.equal(S.cardView(d, "u7", T0 + 1).event, null);
  const a = S.cardView(d, "u8", T0);
  assert.deepEqual([a.accepted.id, a.stillOpen, a.empty], ["B", [], false]);
});

test("cardPlan: first card silent, important news replaces (30 s coalescing), blocked waits 24 h, empty edits (never deletes)", () => {
  const now = T0 + 10 * MIN;
  const cases = [
    [undefined, { important: false }, "sendSilent"],
    [undefined, { important: true }, "send"],
    [{ messageId: "m", lastEventAt: now - 30_000 }, { important: true }, "replace"],
    [{ messageId: "m", lastEventAt: now - 29_999 }, { important: true }, "edit"],
    [{ messageId: "m", lastEventAt: 0 }, { important: false }, "edit"],
    [{ messageId: "m" }, { empty: true }, "edit"], // B5: only the 24 h prune deletes a card
    [undefined, { empty: true }, "none"],
    [{ blocked: true, since: now - 1000 }, { important: true }, "blocked"],
    [{ blocked: true, since: now - 24 * 60 * MIN }, { important: true }, "send"],
  ];
  for (const [card, opts, want] of cases) assert.equal(S.cardPlan(card, { important: false, empty: false, now, ...opts }), want, JSON.stringify([card, opts]));
});

test("notices: ≤ 5 newest, 24-hour expiry, taking empties them; advance prunes", () => {
  const d = dataWith();
  for (let i = 0; i < 7; i++) S.addNotice(d, "u1", { listingId: `L${i}`, kind: "expired", aboutName: "Dani", label: "BASIC · SUP" }, T0 + i);
  assert.deepEqual(d.notices.u1.map((n) => n.listingId), ["L2", "L3", "L4", "L5", "L6"]);
  assert.deepEqual(d.notices.u1[0], { listingId: "L2", outcome: "expired", ts: T0 + 2, name: "Dani", label: "BASIC · SUP" });
  assert.deepEqual(S.takeNotices(d, "u1", T0 + 24 * 60 * MIN + 4).map((n) => n.listingId), ["L5", "L6"]);
  assert.equal(d.notices.u1, undefined);
  S.addNotice(d, "u2", { listingId: "X", kind: "full" }, T0);
  S.advance(d, T0 + 24 * 60 * MIN);
  assert.equal(d.notices.u2, undefined);
});

test("advance: a DM card with nothing left to show goes after 24 h; an active one stays", () => {
  const d = dataWith((x) => {
    x.dmCards = { u1: { messageId: "m1", sentAt: T0, lastEventAt: 0 }, u2: { messageId: "m2", sentAt: T0 }, u3: { blocked: true, since: T0 } };
    x.listings.push(listing("A", "p1", { startAt: T0 + 2 * 24 * 60 * MIN, expiresAt: T0 + 2 * 24 * 60 * MIN, requests: [request("u2")] }));
  });
  assert.deepEqual(S.advance(d, T0 + 24 * 60 * MIN - 1).events, []);
  const r = S.advance(d, T0 + 24 * 60 * MIN);
  assert.deepEqual(r.events, [{ type: "cardDelete", userId: "u1", messageId: "m1" }]);
  assert.deepEqual(Object.keys(d.dmCards).sort(), ["u2", "u3"]);
  // D4: the same dm/deleted journal line a card delete always writes
  assert.deepEqual(r.log, [{ type: "dm", ts: T0 + 24 * 60 * MIN, userId: "u1", event: "deleted" }]);
});

test("advance: an emptied card lives 24 h from when it emptied (activeAt); its staleIds ride along on cardDelete (B5, A3)", () => {
  const d = dataWith((x) => {
    x.dmCards.u1 = { messageId: "m1", sentAt: T0, lastEventAt: T0, activeAt: T0 + 10 * 60 * MIN, staleIds: ["old1"] };
  });
  assert.deepEqual(S.advance(d, T0 + 34 * 60 * MIN - 1).events, []); // 24 h since the self-withdraw, not since the send
  const r = S.advance(d, T0 + 34 * 60 * MIN);
  assert.deepEqual(r.events, [{ type: "cardDelete", userId: "u1", messageId: "m1", staleIds: ["old1"] }]);
  assert.equal(d.dmCards.u1, undefined);
});

test("cardView: a bad-news box is about its listing — gone once the member is back on that listing (B4)", () => {
  const box = { kind: "noConfirm", listingId: "L1", at: T0, aboutName: "P", label: "BASIC · SUP", emoji: "💥" };
  const d = dataWith((x) => {
    x.listings.push(listing("L1", "p1"));
    x.dmCards.u1 = { messageId: "m1", sentAt: T0, lastEventAt: T0, event: box };
  });
  assert.equal(S.cardView(d, "u1", T0 + 1).event.kind, "noConfirm");
  // the search reopened and the member asked again: "you didn't confirm" is out of date
  d.listings[0].requests.push(request("u1", T0 + 1));
  const v = S.cardView(d, "u1", T0 + 2);
  assert.equal(v.event, null);
  assert.equal(v.requests.length, 1);
  // a box whose listing is gone still shows for its 24 h
  d.listings = [];
  assert.equal(S.cardView(d, "u1", T0 + 3).event.kind, "noConfirm");
});

test("cardView: picked by two searchers → the card is about the one to confirm now; the other is listed", () => {
  const d = dataWith((x) => {
    x.listings.push(listing("A", "p1", { state: "fixed", joinerId: "u1", acceptedAt: T0, startAt: T0 + 90 * MIN, expiresAt: T0 + 90 * MIN, requests: [request("u1", T0, { status: "accepted" })] }));
    x.listings.push(listing("B", "p2", { state: "confirming", joinerId: "u1", acceptedAt: T0 + 1, checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: null, at: {}, nags: {} }, requests: [request("u1", T0, { status: "accepted" })] }));
  });
  const v = S.cardView(d, "u1", T0);
  assert.equal(v.accepted.id, "B");
  assert.deepEqual(v.otherAccepted.map((l) => l.id), ["A"]);
  d.listings[1].state = "started";
  assert.equal(S.cardView(d, "u1", T0).accepted.id, "A"); // a fixed game ranks above a started one
});

test("joinable(data, now): a search past its expiry is not joinable even before the tick drops it", () => {
  const d = dataWith((x) => x.listings.push(listing("A", "p1"), listing("B", "p2", { expiresAt: T0 + 60 * MIN })));
  assert.deepEqual(S.joinable(d).map((l) => l.id), ["A", "B"]);
  assert.deepEqual(S.joinable(d, T0 + 30 * MIN).map((l) => l.id), ["B"]);
});
