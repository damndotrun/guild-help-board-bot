// Teammate-finder actions, independent of any Discord interaction (M4 spec
// §5.1, the help actions.js contract):
//   action(ctx, actor, args) → { ok: true, …result, effects? } | { ok: false, code, error }
// The channel buttons, the DM card, the thread and the /menu screens all call
// these, so the surfaces cannot drift apart.
//
// ctx:   the platform ctx (store, client, log; ctx.now() in tests).
// actor: { userId, displayName, level: "member" | "officer" | "owner" }.
// codes: forbidden | unconfigured | invalid | duplicate | busy | own | closed |
//        taken | not_found | started | early.
//
// Invariant (§5.2/1): every write is load() → mutate → save() with no await
// in between. Slow REST is the returned `effects` (effects.js), which the
// caller awaits AFTER acknowledging the interaction. setSubscriptions and
// setGmPings are REST by nature: they write no lfg.json, only the journal.
const S = require("./state");
const store = require("./store");
const E = require("./effects");
const { nowOf, setRoles, dmReachable } = require("./discord");
const { textOf } = require("./texts");
const { atLeast } = require("../../core/perms");

const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

function gate(actor, min, config) {
  if (atLeast(actor && actor.level, min)) return null;
  return fail("forbidden", textOf(config, min === "officer" ? "officerOnly" : "forbidden"));
}

// Load, or the "not set up" failure when the module has no config yet.
function loadConfigured(ctx) {
  const data = store.load(ctx);
  return data.config ? { data } : { error: fail("unconfigured", textOf(null, "notSetUp")) };
}

// Save + journal, and hand the collected events to effects.js.
function committed(ctx, data, out, result = {}) {
  store.commit(ctx, data, out);
  const events = out.events;
  return { ok: true, ...result, effects: () => E.runEvents(ctx, events) };
}

// ── searching ──────────────────────────────────────────────────────────────

// The start modal's submit (§3.2). One open search per member; a busy member
// cannot post. The thread, ping and DMs are the effects (afterCreate).
function createListing(ctx, actor, args = {}) {
  const { data, error } = loadConfigured(ctx);
  if (error) return error;
  const denied = gate(actor, "member", data.config);
  if (denied) return denied;
  const now = nowOf(ctx);
  const own = S.ownListing(data, actor.userId);
  if (own) return fail("duplicate", textOf(data.config, "hasSearch"), { listingId: own.id });
  if (S.isBusy(data, actor.userId)) return fail("busy", textOf(data.config, "busy"));
  const input = S.resolveSearch(data, actor.userId, args, now);
  if (!input.ok) return fail("invalid", input.error);
  const listing = S.createListing(data, { posterId: actor.userId, posterName: actor.displayName, ...input }, now);
  store.save(ctx, data);
  return { ok: true, listing, effects: () => E.afterCreate(ctx, listing.id) };
}

// Join (§3.3/2): open, not your own, no request there yet, not busy. A repeat
// tap reports the request that already exists.
function join(ctx, actor, { listingId } = {}) {
  const { data, error } = loadConfigured(ctx);
  if (error) return error;
  const now = nowOf(ctx);
  const listing = S.findListing(data, listingId);
  if (!listing) return fail("closed", textOf(data.config, "notOpen"));
  const mine = S.activeRequest(listing, actor.userId);
  if (mine) return { ok: true, already: true, listing, status: mine.status, position: S.queuePosition(listing, actor.userId) };
  // lapsed but not yet dropped by the tick counts as closed; so does a search
  // whose thread is still opening (or failed) — the request panel lives there
  if (listing.state !== "open" || now >= listing.expiresAt || !listing.threadId) return fail("closed", textOf(data.config, "notOpen"));
  if (listing.posterId === actor.userId) return fail("own", textOf(data.config, "ownSearch"));
  if (S.isBusy(data, actor.userId)) return fail("busy", textOf(data.config, "busy"));
  const out = S.newOut();
  S.addRequest(listing, { userId: actor.userId, userName: actor.displayName }, now, out);
  out.events.push({ type: "joined", listingId, userId: actor.userId }, { type: "cardRefresh", userId: actor.userId });
  return committed(ctx, data, out, {
    listing,
    position: S.queuePosition(listing, actor.userId),
    dmOk: dmReachable(data, actor.userId, now),
  });
}

// Accept (§3.3/3): only the searcher, only an open search, only a pending
// request. Synchronous, so of two Accepts only the first wins (invariant 3).
function accept(ctx, actor, { listingId, userId } = {}) {
  const { data, error } = loadConfigured(ctx);
  if (error) return error;
  const now = nowOf(ctx);
  const listing = S.findListing(data, listingId);
  if (!listing) return fail("closed", textOf(data.config, "notOpen"));
  if (listing.posterId !== actor.userId) return fail("forbidden", textOf(data.config, "notYours"));
  if (listing.state !== "open") return fail("taken", textOf(data.config, "spotTaken"));
  if (now >= listing.expiresAt) return fail("closed", textOf(data.config, "notOpen"));
  const r = listing.requests.find((x) => x.userId === userId && x.status === "pending");
  if (!r) return fail("not_found", textOf(data.config, "requestGone"));
  const out = S.newOut();
  const state = S.acceptRequest(data, listing, r, now, out);
  return committed(ctx, data, out, { listing, state, joinerName: r.userName });
}

// I'm here (§3.4): only the two players; the second tap starts the game and
// applies the busy rule in the same save (invariant 3). Only a fixed or
// confirming search has a check-in to tick — an open one is "closed" here.
function checkIn(ctx, actor, { listingId } = {}) {
  const { data, error } = loadConfigured(ctx);
  if (error) return error;
  const now = nowOf(ctx);
  const listing = S.findListing(data, listingId);
  if (!listing || !["fixed", "confirming", "started"].includes(listing.state)) return fail("closed", textOf(data.config, "notOpen"));
  if (actor.userId !== listing.posterId && actor.userId !== listing.joinerId) return fail("forbidden", textOf(data.config, "notInGame"));
  if (listing.state === "started") return { ok: true, result: "already", listing };
  const out = S.newOut();
  const result = S.confirmPresence(data, listing, actor.userId, now, out);
  if (result === "early") return fail("early", textOf(data.config, "hereTooEarly", { lead: S.times(data.config).reminderLeadMin }));
  if (result === "already") return { ok: true, result, listing };
  return committed(ctx, data, out, { result, listing });
}

// Cancel request (§3.3/5): the member's own request; an accepted one reopens
// the search for the line. A started game cannot be left this way.
function withdraw(ctx, actor, { listingId } = {}) {
  const { data, error } = loadConfigured(ctx);
  if (error) return error;
  const listing = S.findListing(data, listingId);
  const r = listing && S.activeRequest(listing, actor.userId);
  if (!r) return fail("not_found", textOf(data.config, "noRequest"));
  if (listing.state === "started" && r.status === "accepted") return fail("started", textOf(data.config, "gameStarted"));
  const out = S.newOut();
  S.withdrawRequest(data, listing, actor.userId, nowOf(ctx), out);
  return committed(ctx, data, out, { listing });
}

// Cancel all: every pending (not accepted) request of the member.
function withdrawAll(ctx, actor) {
  const { data, error } = loadConfigured(ctx);
  if (error) return error;
  const now = nowOf(ctx);
  const mine = data.listings.filter((l) => l.requests.some((r) => r.userId === actor.userId && r.status === "pending"));
  if (mine.length === 0) return fail("not_found", textOf(data.config, "noRequests"));
  const out = S.newOut();
  for (const listing of mine) S.withdrawRequest(data, listing, actor.userId, now, out);
  return committed(ctx, data, out, { count: mine.length });
}

// Cancel search (§3.3/5): the searcher's own, not once the game started.
function cancelListing(ctx, actor, { listingId } = {}) {
  const { data, error } = loadConfigured(ctx);
  if (error) return error;
  const listing = S.findListing(data, listingId);
  if (!listing) return fail("closed", textOf(data.config, "notOpen"));
  if (listing.posterId !== actor.userId) return fail("forbidden", textOf(data.config, "notYours"));
  if (listing.state === "started") return fail("started", textOf(data.config, "gameStarted"));
  const out = S.newOut();
  S.dropListing(data, listing, { outcome: "cancelled", reason: "self" }, nowOf(ctx), out);
  return committed(ctx, data, out, { listing });
}

// Officer: remove any search (§6.2) — recorded with who removed it.
function removeListing(ctx, actor, { listingId } = {}) {
  const { data, error } = loadConfigured(ctx);
  if (error) return error;
  const denied = gate(actor, "officer", data.config);
  if (denied) return denied;
  const listing = S.findListing(data, listingId);
  if (!listing) return fail("closed", textOf(data.config, "notOpen"));
  const out = S.newOut();
  S.dropListing(data, listing, { outcome: "removed", removedBy: actor.userId }, nowOf(ctx), out);
  return committed(ctx, data, out, { listing });
}

// ── roles and settings ─────────────────────────────────────────────────────

// My roles (§3.1/3.2): `member` is the GuildMember; mode "toggle" (the
// channel picker) or "set" (Menu › My roles). Async — role REST; the caller
// defers first. Only subscribable roles that still exist are touched.
async function setSubscriptions(ctx, actor, { member, picked = [], mode = "set", roleExists = () => true } = {}) {
  const { data, error } = loadConfigured(ctx);
  if (error) return error;
  if (!member || member.id !== actor.userId) return fail("forbidden", textOf(data.config, "forbidden"));
  const sub = S.subscribable(data.config).map((s) => s.roleId).filter(roleExists);
  const diff = S.subscriptionDiff(sub, [...member.roles.cache.keys()], picked, mode);
  const result = await setRoles(ctx, member, { add: diff.add, remove: diff.remove });
  store.appendLog(ctx, [{ type: "subscription", ts: nowOf(ctx), userId: actor.userId, ...result }]);
  return { ok: true, ...result };
}

// Notifications › "Request updates by DM" (requestDm) / "New searches by DM" (dm).
function setDm(ctx, actor, { kind, on } = {}) {
  const { data, error } = loadConfigured(ctx);
  if (error) return error;
  if (kind !== "dm" && kind !== "requestDm") return fail("invalid", textOf(data.config, "forbidden"));
  const prefs = { dm: false, requestDm: true, ...(data.prefs[actor.userId] || {}), [kind]: !!on };
  data.prefs[actor.userId] = prefs;
  store.commit(ctx, data, { log: [{ type: "prefs", ts: nowOf(ctx), userId: actor.userId, dm: prefs.dm, requestDm: prefs.requestDm }] });
  return { ok: true, prefs };
}

// GM pings = holding the GM-PING role (§3.2). Async — role REST.
async function setGmPings(ctx, actor, { member, on } = {}) {
  const { data, error } = loadConfigured(ctx);
  if (error) return error;
  const roleId = data.config.gmPingRoleId;
  if (!roleId) return fail("unconfigured", textOf(data.config, "notSetUp"));
  if (!member || member.id !== actor.userId) return fail("forbidden", textOf(data.config, "forbidden"));
  const result = await setRoles(ctx, member, on ? { add: [roleId] } : { remove: [roleId] });
  if (result.failed.length) return fail("rest", textOf(data.config, "roleFailed"));
  store.appendLog(ctx, [{ type: "gmPing", ts: nowOf(ctx), userId: actor.userId, on: !!on }]);
  return { ok: true, on: !!on };
}

// The member's waiting news (blocked / switched-off DMs) — read once, then gone (§6.4).
function consumeNotices(ctx, actor) {
  const data = store.load(ctx);
  if (!data.notices[actor.userId]) return { ok: true, notices: [] };
  const notices = S.takeNotices(data, actor.userId, nowOf(ctx));
  store.save(ctx, data);
  return { ok: true, notices };
}

module.exports = {
  createListing,
  join,
  accept,
  checkIn,
  withdraw,
  withdrawAll,
  cancelListing,
  removeListing,
  setSubscriptions,
  setDm,
  setGmPings,
  consumeNotices,
};
