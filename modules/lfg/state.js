// The teammate finder's state machine (M4 spec §4.2) — pure: no Discord, no
// file, no clock (every function takes `now`). Functions that change a listing
// take an `out` collector (newOut()) and push into it:
//   out.log    — journal lines for lfg-log.jsonl (§4.3), appended after save;
//   out.events — what the Discord side must do afterwards (effects.js):
//     { type: "dropped", listing, outcome, reason }   listing left the list
//     { type: "panel", listingId }                     redraw the request panel
//     { type: "accepted", listingId }                  joiner added: welcome, cards
//     { type: "checkInOpen", listingId }               the confirm window opened
//     { type: "nag", listingId, userId }               a reminder is due
//     { type: "welcome", listingId }                   redraw the welcome / confirm box
//     { type: "started", listingId }                   both tapped I'm here
//     { type: "reopened", listingId, joinerId, welcomeMessageId, nagMessageId, threadId, reason }
//     { type: "card", userId, event }                  an important DM-card event (notifies)
//     { type: "cardRefresh", userId }                  a silent DM-card refresh
//     { type: "cardDelete", userId, messageId, staleIds? }  the card is stale (24 h)
// Listing states: open → (accept) fixed | confirming → (2× I'm here) started.
const crypto = require("crypto");
const { hasUnprintable, PLAIN_TEXT_ERROR } = require("../../core/text");
const { textOf } = require("./texts");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DEFAULT_TIMES = Object.freeze({ reminderLeadMin: 5, checkInWindowMin: 5, startedVisibleMin: 5, nowTtlMin: 30, pingSec: 60 });
const MAX_NOTE = 100;
const MAX_MINUTES = 1440;
const MAX_NOTICES = 5;
const NOTICE_TTL_MS = 24 * HOUR;
const CARD_TTL_MS = 24 * HOUR;
const BLOCK_RETRY_MS = 24 * HOUR;
const COALESCE_MS = 30_000;
const THREAD_GRACE_MS = 2 * MIN; // a search still without a thread after this is dropped
const STILL_OPEN = 3;
const ACTIVE = new Set(["pending", "accepted"]);
const IN_GAME = new Set(["fixed", "confirming", "started"]);
// The DM-card event kinds that draw a (bad-news) event box. "accepted",
// "checkInOpen" and "nag" notify too, but the accepted view shows them.
const BOX_KINDS = new Set(["full", "expired", "cancelled", "posterNoConfirm", "noConfirm"]);

const newOut = () => ({ log: [], events: [] });
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

function emptyData() {
  return {
    version: 1,
    config: null,
    channel: { messageIds: {}, pingMessageId: null, pingUntil: null },
    listings: [],
    dmCards: {},
    notices: {},
    prefs: {},
    favorites: {},
  };
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// readAndShape (§4.1): defaults for missing fields, unknown fields kept (M5
// may add some before this build learns them).
function shape(raw) {
  const d = isObj(raw) ? raw : {};
  const base = emptyData();
  if (typeof d.version !== "number") d.version = base.version;
  d.config = isObj(d.config) ? shapeConfig(d.config) : null;
  d.channel = isObj(d.channel) ? { ...base.channel, ...d.channel } : base.channel;
  if (!isObj(d.channel.messageIds)) d.channel.messageIds = {};
  d.listings = Array.isArray(d.listings) ? d.listings.filter(isObj).map(shapeListing) : [];
  for (const key of ["dmCards", "notices", "prefs", "favorites"]) if (!isObj(d[key])) d[key] = {};
  return d;
}

function shapeConfig(c) {
  c.channelId = c.channelId ?? null;
  c.guildId = c.guildId ?? null;
  c.layout = Array.isArray(c.layout) ? c.layout.filter(isObj) : [{ type: "board" }];
  c.gmPingRoleId = c.gmPingRoleId ?? null;
  c.categories = Array.isArray(c.categories) ? c.categories.filter(isObj) : [];
  for (const cat of c.categories) {
    cat.buttons = Array.isArray(cat.buttons) ? cat.buttons.filter(isObj) : [];
    for (const b of cat.buttons) {
      b.pingRoleIds = Array.isArray(b.pingRoleIds) ? b.pingRoleIds : [];
      b.subscribeRoleId = b.subscribeRoleId ?? null;
    }
  }
  c.times = { ...DEFAULT_TIMES, ...(isObj(c.times) ? c.times : {}) };
  c.texts = isObj(c.texts) ? c.texts : {};
  return c;
}

function shapeListing(l) {
  const defaults = {
    note: "",
    startAt: null,
    state: "open",
    threadId: null,
    panelMessageId: null,
    notifyMessageId: null,
    welcomeMessageId: null,
    joinerId: null,
    acceptedAt: null,
    startedAt: null,
    checkIn: null,
    dmCount: 0,
    cancelledOthers: [],
  };
  // `== null`: a hand-edited null is as missing as an absent field
  for (const [k, v] of Object.entries(defaults)) if (l[k] == null) l[k] = v;
  if (typeof l.note !== "string") l.note = String(l.note);
  if (!Array.isArray(l.cancelledOthers)) l.cancelledOthers = [];
  l.requests = Array.isArray(l.requests) ? l.requests.filter(isObj) : [];
  if (typeof l.expiresAt !== "number") l.expiresAt = l.startAt ?? (l.createdAt ?? 0) + DEFAULT_TIMES.nowTtlMin * MIN;
  repairGame(l);
  return l;
}

// A hand-edited or half-written file must not leave advance() throwing on
// every tick: a game without a joiner is open again; a confirming game
// without a checkIn gets one whose deadline is already past (the next tick
// decides it as a missed check-in).
function repairGame(l) {
  // a checkIn whose deadline is not a number is dropped: the state's default applies
  if (l.checkIn != null && (!isObj(l.checkIn) || !Number.isFinite(l.checkIn.deadline))) l.checkIn = null;
  if (IN_GAME.has(l.state) && !l.joinerId) {
    l.state = "open";
    l.checkIn = null;
    l.acceptedAt = null;
    l.welcomeMessageId = null;
    return;
  }
  if (l.state === "confirming" && !isObj(l.checkIn)) {
    const openedAt = l.acceptedAt ?? l.createdAt ?? 0;
    l.checkIn = { openedAt, deadline: openedAt + DEFAULT_TIMES.checkInWindowMin * MIN, nagMessageId: null, at: {}, nags: {} };
  }
  if (isObj(l.checkIn)) {
    if (!isObj(l.checkIn.at)) l.checkIn.at = {};
    if (!isObj(l.checkIn.nags)) l.checkIn.nags = {};
  }
}

const times = (config) => ({ ...DEFAULT_TIMES, ...((config && config.times) || {}) });

// ── config lookups ──────────────────────────────────────────────────────────

function findButton(config, categoryId, buttonId) {
  const category = ((config && config.categories) || []).find((c) => c.id === categoryId);
  const button = category && category.buttons.find((b) => b.id === buttonId);
  return category && button ? { category, button } : null;
}

// "BASIC · SUP" and its emoji; a button removed since (M5 editor) still has a name.
function labelOf(config, listing) {
  const found = findButton(config, listing.categoryId, listing.buttonId);
  if (!found) return { label: `${listing.categoryId} · ${listing.buttonId}`.toUpperCase(), emoji: "🎮" };
  return { label: `${found.category.name} · ${found.button.label}`, emoji: found.button.emoji || found.category.emoji || "🎮" };
}

// The modal's "Looking for" list: every category · button, at most 25.
function lookingForOptions(config) {
  const out = [];
  for (const cat of (config && config.categories) || []) {
    for (const b of cat.buttons) {
      out.push({ value: `${cat.id}/${b.id}`, label: `${cat.name} · ${b.label}`, emoji: b.emoji || cat.emoji || undefined });
    }
  }
  return out.slice(0, 25);
}

// The roles a member may subscribe to: { roleId, label, emoji }, unique by role.
function subscribable(config) {
  const out = [];
  const seen = new Set();
  for (const cat of (config && config.categories) || []) {
    for (const b of cat.buttons) {
      if (!b.subscribeRoleId || seen.has(b.subscribeRoleId)) continue;
      seen.add(b.subscribeRoleId);
      out.push({ roleId: b.subscribeRoleId, label: `${cat.name} · ${b.label}`, emoji: b.emoji || cat.emoji || undefined });
    }
  }
  return out.slice(0, 25);
}

// What a role pick changes. mode "toggle" (the public panel: a picked role is
// added if missing, removed if held) or "set" (Menu › My roles: the pick is the
// whole wanted list). Only subscribable roles are ever touched.
function subscriptionDiff(subRoleIds, heldRoleIds, picked, mode) {
  const sub = new Set(subRoleIds);
  const held = new Set(heldRoleIds.filter((id) => sub.has(id)));
  const pick = new Set(picked.filter((id) => sub.has(id)));
  if (mode === "toggle") {
    return { add: [...pick].filter((id) => !held.has(id)), remove: [...pick].filter((id) => held.has(id)) };
  }
  return { add: [...pick].filter((id) => !held.has(id)), remove: [...held].filter((id) => !pick.has(id)) };
}

// ── input (§6.3) ────────────────────────────────────────────────────────────

// "" / "0" → 0 (now); otherwise a whole number 1–1440. Spaces are trimmed.
function parseMinutes(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return { ok: true, minutes: 0 };
  if (!/^\d+$/.test(s)) return { ok: false };
  const n = Number(s);
  return n <= MAX_MINUTES ? { ok: true, minutes: n } : { ok: false };
}

function noteError(config, note) {
  const s = String(note ?? "").trim();
  if (s.length > MAX_NOTE) return textOf(config, "noteTooLong");
  if (hasUnprintable(s)) return PLAIN_TEXT_ERROR;
  return null;
}

// The modal's fields → what to post. A picked favorite wins over the other fields.
function resolveSearch(data, userId, input, now) {
  const config = data.config;
  const fail = (key) => ({ ok: false, error: textOf(config, key) });
  if (input.favoriteId) {
    const favs = Array.isArray(data.favorites[userId]) ? data.favorites[userId] : [];
    const fav = favs.find((f) => f && f.id === input.favoriteId);
    if (!fav || !findButton(config, fav.categoryId, fav.buttonId)) return fail("favoriteStale");
    const minutes = Number.isInteger(fav.minutes) && fav.minutes > 0 && fav.minutes <= MAX_MINUTES ? fav.minutes : 0;
    const note = String(fav.note ?? "").trim();
    if (noteError(config, note)) return fail("favoriteStale");
    return { ok: true, categoryId: fav.categoryId, buttonId: fav.buttonId, startAt: minutes ? now + minutes * MIN : null, note };
  }
  if (!input.lookingFor) return fail("needLookingFor");
  const [categoryId, buttonId] = String(input.lookingFor).split("/");
  if (!findButton(config, categoryId, buttonId)) return fail("badOption");
  const m = parseMinutes(input.minutes);
  if (!m.ok) return fail("badMinutes");
  const bad = noteError(config, input.note);
  if (bad) return { ok: false, error: bad };
  return { ok: true, categoryId, buttonId, startAt: m.minutes ? now + m.minutes * MIN : null, note: String(input.note ?? "").trim() };
}

// ── queries ─────────────────────────────────────────────────────────────────

const findListing = (data, id) => data.listings.find((l) => l.id === id) || null;
const ownListing = (data, userId) => data.listings.find((l) => l.posterId === userId) || null;

// Busy (§4.1): a player of a started game, until it leaves the board.
const isBusy = (data, userId) => data.listings.some((l) => l.state === "started" && (l.posterId === userId || l.joinerId === userId));

const activeRequest = (listing, userId) => listing.requests.find((r) => r.userId === userId && ACTIVE.has(r.status)) || null;
const pendingRequests = (listing) => listing.requests.filter((r) => r.status === "pending");
const activeRequests = (listing) => listing.requests.filter((r) => ACTIVE.has(r.status));

// 1-based place in the line among the pending (incl. on-hold) requests; 0 = none.
function queuePosition(listing, userId) {
  return pendingRequests(listing).findIndex((r) => r.userId === userId) + 1;
}

const startKey = (l) => l.startAt ?? l.createdAt;

// Board / Browse order: soonest first.
// With `now`, a search whose time ran out but that no tick has dropped yet
// is not joinable any more either; nor is one whose thread is still opening.
function joinable(data, now = null) {
  return data.listings
    .filter((l) => l.state === "open" && !!l.threadId && (now === null || now < l.expiresAt))
    .sort((a, b) => startKey(a) - startKey(b));
}

// "Still open" on a DM card (§3.6): up to 3 open searches the member could
// still join — the categories they already asked for first, soonest first.
function recommend(data, userId, n = STILL_OPEN, now = null) {
  if (isBusy(data, userId)) return [];
  const mine = new Set(data.listings.filter((l) => activeRequest(l, userId)).map((l) => l.categoryId));
  return joinable(data, now)
    .filter((l) => l.posterId !== userId && !activeRequest(l, userId))
    .sort((a, b) => Number(mine.has(b.categoryId)) - Number(mine.has(a.categoryId)) || startKey(a) - startKey(b))
    .slice(0, n);
}

// Who the new-search ping goes to: the button's roles (§5.3).
function pingTargets(config, listing) {
  const found = findButton(config, listing.categoryId, listing.buttonId);
  return found ? [...found.button.pingRoleIds] : [];
}

// New-search DM candidates (§5.5) before the role check: opted in, not the
// poster, not busy. The caller keeps those who hold one of pingTargets().
function dmCandidates(data, listing) {
  return Object.entries(data.prefs)
    .filter(([userId, p]) => p && p.dm === true && userId !== listing.posterId && !isBusy(data, userId))
    .map(([userId]) => userId);
}

// ── listing lifecycle ──────────────────────────────────────────────────────

function createListing(data, { posterId, posterName, categoryId, buttonId, note, startAt }, now) {
  const t = times(data.config);
  const listing = shapeListing({
    id: newId(),
    posterId,
    posterName,
    categoryId,
    buttonId,
    note: note || "",
    createdAt: now,
    startAt: startAt ?? null,
    expiresAt: startAt ?? now + t.nowTtlMin * MIN,
  });
  data.listings.push(listing);
  return listing;
}

function requestLog(out, listing, r, event, now, extra = {}) {
  out.log.push({ type: "request", ts: now, listingId: listing.id, userId: r.userId, event, ...(r.reason ? { reason: r.reason } : {}), ...extra });
}

function addRequest(listing, { userId, userName }, now, out) {
  const r = { userId, userName, createdAt: now, status: "pending", onHold: false, closedAt: null, reason: null };
  listing.requests.push(r);
  requestLog(out, listing, r, "created", now);
  out.events.push({ type: "panel", listingId: listing.id });
  return r;
}

function closeRequest(listing, r, status, reason, now, out, extra) {
  r.status = status;
  r.closedAt = now;
  r.reason = reason;
  r.onHold = false;
  requestLog(out, listing, r, status, now, extra);
}

// A self-contained DM-card event — it must render after the listing is gone.
function cardEvent(config, listing, kind, aboutId, aboutName, now) {
  const { label, emoji } = labelOf(config, listing);
  return { kind, listingId: listing.id, aboutId, aboutName, label, emoji, startAt: listing.startAt, at: now };
}

function openCheckIn(listing, now, t) {
  listing.state = "confirming";
  listing.checkIn = {
    openedAt: now,
    deadline: Math.max(listing.startAt ?? 0, now + t.checkInWindowMin * MIN),
    nagMessageId: null,
    at: {},
    nags: {},
  };
}

// Accept (§3.3/3): the picked request → accepted, the rest on hold. A search
// starting within reminderLeadMin (or now) confirms at once, a later one is fixed.
function acceptRequest(data, listing, r, now, out) {
  const t = times(data.config);
  r.status = "accepted";
  requestLog(out, listing, r, "accepted", now);
  listing.joinerId = r.userId;
  listing.acceptedAt = now;
  for (const other of pendingRequests(listing)) other.onHold = true;
  if (listing.startAt === null || listing.startAt - now <= t.reminderLeadMin * MIN) openCheckIn(listing, now, t);
  else listing.state = "fixed";
  out.events.push({ type: "accepted", listingId: listing.id }, { type: "panel", listingId: listing.id });
  out.events.push({ type: "card", userId: r.userId, event: cardEvent(data.config, listing, "accepted", listing.posterId, listing.posterName, now) });
  for (const other of pendingRequests(listing)) out.events.push({ type: "cardRefresh", userId: other.userId });
  return listing.state;
}

// The accepted joiner is out (no confirm, withdrew, or started another game):
// the search opens again with its line; a start that has passed becomes "now".
function reopenListing(data, listing, reason, now, out) {
  const t = times(data.config);
  const joinerId = listing.joinerId;
  const r = listing.requests.find((x) => x.userId === joinerId && x.status === "accepted");
  const nags = listing.checkIn ? listing.checkIn.nags[joinerId] || 0 : 0;
  if (r) closeRequest(listing, r, reason === "no_confirm" ? "closed" : "withdrawn", reason, now, out, { nags });
  const nagMessageId = listing.checkIn ? listing.checkIn.nagMessageId || null : null;
  out.events.push({ type: "reopened", listingId: listing.id, joinerId, welcomeMessageId: listing.welcomeMessageId, nagMessageId, threadId: listing.threadId, reason });
  listing.state = "open";
  listing.joinerId = null;
  listing.acceptedAt = null;
  listing.checkIn = null;
  listing.welcomeMessageId = null;
  if (listing.startAt === null || listing.startAt <= now) {
    listing.startAt = null;
    listing.expiresAt = now + t.nowTtlMin * MIN;
  }
  for (const other of pendingRequests(listing)) {
    other.onHold = false;
    out.events.push({ type: "cardRefresh", userId: other.userId });
  }
  if (reason === "no_confirm") {
    out.events.push({ type: "card", userId: joinerId, event: cardEvent(data.config, listing, "noConfirm", listing.posterId, listing.posterName, now) });
  } else {
    out.events.push({ type: "cardRefresh", userId: joinerId });
  }
  out.events.push({ type: "panel", listingId: listing.id });
}

const REQUEST_REASON = { expired: "expired", removed: "removed", cancelled: "cancelled", matched: "filled" };
const KIND_FOR = { expired: "expired", removed: "cancelled", cancelled: "cancelled" };

// The listing leaves the list (§3.5) — every path writes one "listing" line.
function dropListing(data, listing, { outcome, reason = null, removedBy = null }, now, out) {
  const kind = outcome === "cancelled" && reason === "no_confirm" ? "posterNoConfirm" : KIND_FOR[outcome];
  for (const r of activeRequests(listing)) {
    if (outcome === "matched" && r.status === "accepted") {
      // the winner: the request stays "accepted" — it was played, not closed
      r.closedAt = now;
      r.reason = "played";
      continue;
    }
    closeRequest(listing, r, "closed", REQUEST_REASON[outcome], now, out);
    if (kind) out.events.push({ type: "card", userId: r.userId, event: cardEvent(data.config, listing, kind, listing.posterId, listing.posterName, now) });
  }
  data.listings = data.listings.filter((l) => l !== listing);
  const ci = listing.checkIn;
  out.log.push({
    type: "listing",
    ts: now,
    id: listing.id,
    posterId: listing.posterId,
    categoryId: listing.categoryId,
    buttonId: listing.buttonId,
    noteLength: listing.note.length,
    createdAt: listing.createdAt,
    startAt: listing.startAt,
    outcome,
    ...(reason ? { reason } : {}),
    ...(removedBy ? { removedBy } : {}),
    acceptedAt: listing.acceptedAt,
    joinerId: listing.joinerId,
    startedAt: listing.startedAt,
    endedAt: now,
    pingRoleIds: pingTargets(data.config, listing),
    dmCount: listing.dmCount,
    requests: listing.requests.map((r) => ({ userId: r.userId, createdAt: r.createdAt, status: r.status, closedAt: r.closedAt, reason: r.reason })),
    checkIn: ci ? { openedAt: ci.openedAt, at: ci.at, nags: ci.nags } : null,
  });
  out.events.push({ type: "dropped", listing, outcome, reason });
}

// Both tapped I'm here (§3.3/4): started, and the busy rule in the same save —
// the rest of this line is full, both players' other requests are withdrawn,
// a search either of them accepted elsewhere opens again, their own other
// search is cancelled.
function startGame(data, listing, now, out) {
  listing.state = "started";
  listing.startedAt = now;
  for (const r of pendingRequests(listing)) {
    closeRequest(listing, r, "closed", "filled", now, out);
    out.events.push({ type: "card", userId: r.userId, event: cardEvent(data.config, listing, "full", listing.posterId, listing.posterName, now) });
  }
  out.events.push({ type: "started", listingId: listing.id }, { type: "panel", listingId: listing.id });
  for (const userId of [listing.posterId, listing.joinerId]) {
    let cancelled = 0;
    for (const other of [...data.listings]) {
      if (other === listing || !data.listings.includes(other)) continue;
      if (other.posterId === userId && other.state !== "started") {
        dropListing(data, other, { outcome: "cancelled", reason: "matched_elsewhere" }, now, out);
        cancelled += 1;
      } else if (other.joinerId === userId && other.state !== "started") {
        reopenListing(data, other, "matched_elsewhere", now, out);
        cancelled += 1;
      } else {
        const r = other.requests.find((x) => x.userId === userId && x.status === "pending");
        if (r) {
          closeRequest(other, r, "withdrawn", "matched_elsewhere", now, out);
          out.events.push({ type: "panel", listingId: other.id });
          for (const rest of pendingRequests(other)) out.events.push({ type: "cardRefresh", userId: rest.userId });
          cancelled += 1;
        }
      }
    }
    if (cancelled > 0) listing.cancelledOthers.push(userId);
    out.events.push({ type: "cardRefresh", userId });
  }
}

// One I'm here. → "noted" | "started" | "already" | "early".
function confirmPresence(data, listing, userId, now, out) {
  if (listing.state === "fixed") return "early";
  if (listing.checkIn.at[userId]) return "already";
  listing.checkIn.at[userId] = now;
  out.events.push({ type: "cardRefresh", userId: listing.joinerId });
  if (listing.checkIn.at[listing.posterId] && listing.checkIn.at[listing.joinerId]) {
    startGame(data, listing, now, out);
    return "started";
  }
  out.events.push({ type: "welcome", listingId: listing.id }, { type: "panel", listingId: listing.id });
  return "noted";
}

// A member's own request goes (§3.3/5). An accepted one reopens the search.
function withdrawRequest(data, listing, userId, now, out) {
  const r = activeRequest(listing, userId);
  if (!r) return false;
  if (r.status === "accepted") {
    reopenListing(data, listing, "self", now, out);
    return true;
  }
  closeRequest(listing, r, "withdrawn", "self", now, out);
  out.events.push({ type: "panel", listingId: listing.id }, { type: "cardRefresh", userId });
  for (const other of pendingRequests(listing)) out.events.push({ type: "cardRefresh", userId: other.userId });
  return true;
}

// ── time (§3.4, §3.5, §5.4) ────────────────────────────────────────────────

// One tick: lapsed searches leave, confirm windows open, reminders fall due,
// deadlines decide, finished games leave the board, old notices and cards go.
function advance(data, now) {
  const out = newOut();
  const t = times(data.config);
  for (const listing of [...data.listings]) {
    if (!data.listings.includes(listing)) continue; // dropped by an earlier one this tick
    if (!listing.threadId && now - listing.createdAt > THREAD_GRACE_MS) {
      // afterCreate never finished (crash, lost effects): no thread, no search (invariant 2)
      dropListing(data, listing, { outcome: "cancelled", reason: "thread_failed" }, now, out);
    } else if (listing.state === "open" && now >= listing.expiresAt) {
      dropListing(data, listing, { outcome: "expired" }, now, out);
    } else if (listing.state === "fixed" && now >= listing.startAt - t.reminderLeadMin * MIN) {
      openCheckIn(listing, now, t);
      out.events.push({ type: "checkInOpen", listingId: listing.id }, { type: "panel", listingId: listing.id });
      out.events.push({ type: "card", userId: listing.joinerId, event: cardEvent(data.config, listing, "checkInOpen", listing.posterId, listing.posterName, now) });
    } else if (listing.state === "confirming") {
      const ci = listing.checkIn;
      if (now >= ci.deadline) {
        if (!ci.at[listing.posterId]) dropListing(data, listing, { outcome: "cancelled", reason: "no_confirm" }, now, out);
        else reopenListing(data, listing, "no_confirm", now, out);
        continue;
      }
      for (const userId of [listing.posterId, listing.joinerId]) {
        if (ci.at[userId]) continue;
        const n = ci.nags[userId] || 0;
        if (n < t.checkInWindowMin && now >= ci.openedAt + (n + 1) * MIN) {
          ci.nags[userId] = n + 1;
          out.events.push({ type: "nag", listingId: listing.id, userId });
          if (userId === listing.joinerId) {
            out.events.push({ type: "card", userId, event: cardEvent(data.config, listing, "nag", listing.posterId, listing.posterName, now) });
          }
        }
      }
    } else if (listing.state === "started" && now >= listing.startedAt + t.startedVisibleMin * MIN) {
      dropListing(data, listing, { outcome: "matched" }, now, out);
    }
  }
  pruneNotices(data, now);
  // §3.6: a card goes once its member has no pending request and 24 h passed
  // since the last event (activeAt: the card turned empty, e.g. a self-withdraw)
  for (const [userId, card] of Object.entries(data.dmCards)) {
    if (!card || card.blocked || hasActivity(data, userId)) continue;
    if (now - Math.max(card.sentAt || 0, card.lastEventAt || 0, card.activeAt || 0) >= CARD_TTL_MS) {
      const staleIds = Array.isArray(card.staleIds) ? card.staleIds : [];
      out.events.push({ type: "cardDelete", userId, messageId: card.messageId, ...(staleIds.length ? { staleIds } : {}) });
      out.log.push({ type: "dm", ts: now, userId, event: "deleted" });
      delete data.dmCards[userId];
    }
  }
  return { data, events: out.events, log: out.log };
}

// ── DM cards and notices (§3.6) ────────────────────────────────────────────

const hasActivity = (data, userId) => data.listings.some((l) => activeRequest(l, userId));

// What one member's card shows right now.
// Which accepted game the card is about when there are several (a member can
// be picked by two searchers before either game starts): the one waiting for
// I'm here, then the soonest fixed one, then a started one.
const GAME_RANK = { confirming: 0, fixed: 1, started: 2 };

// A bad-news box belongs to its listing (event.listingId): it shows for 24 h,
// and no longer once the member is back on that listing (asked again after a
// reopen, or picked there) — then the news is out of date. The card clears it
// for good when it renders the accepted ("You're in") state (discord.js).
function boxStillNews(data, userId, event, now) {
  if (!isObj(event) || !BOX_KINDS.has(event.kind) || !(now - event.at < CARD_TTL_MS)) return false;
  if (!event.listingId) return true;
  const L = data.listings.find((l) => l.id === event.listingId);
  return !(L && activeRequest(L, userId));
}

function cardView(data, userId, now) {
  const games = data.listings
    .filter((l) => l.joinerId === userId && IN_GAME.has(l.state))
    .sort((a, b) => GAME_RANK[a.state] - GAME_RANK[b.state] || (a.startAt ?? a.acceptedAt ?? 0) - (b.startAt ?? b.acceptedAt ?? 0));
  const accepted = games[0] || null;
  const otherAccepted = games.slice(1);
  const card = data.dmCards[userId];
  const event = card && boxStillNews(data, userId, card.event, now) ? card.event : null;
  const requests = data.listings
    .map((listing) => ({ listing, request: listing.requests.find((r) => r.userId === userId && r.status === "pending") }))
    .filter((x) => x.request)
    .map(({ listing, request }) => ({ listing, onHold: request.onHold, position: queuePosition(listing, userId) }));
  const stillOpen = accepted ? [] : recommend(data, userId, STILL_OPEN, now);
  const otherCancelled = !!accepted && accepted.state === "started" && accepted.cancelledOthers.includes(userId);
  return { accepted, otherAccepted, event, requests, stillOpen, otherCancelled, empty: !accepted && requests.length === 0 && !event };
}

// send | sendSilent | replace | edit | none | blocked. An existing card with
// nothing left to show is edited to its empty state, never deleted here: it
// goes 24 h later with the tick's prune (§3.6).
function cardPlan(card, { important, empty, now }) {
  if (card && card.blocked && now - (card.since || 0) < BLOCK_RETRY_MS) return "blocked";
  const messageId = card && !card.blocked ? card.messageId : null;
  if (empty) return messageId ? "edit" : "none";
  if (!messageId) return important ? "send" : "sendSilent";
  if (important && now - (card.lastEventAt || 0) >= COALESCE_MS) return "replace";
  return "edit";
}

// Blocked / switched-off DMs: the news waits for the next tap (≤ 5, 24 h).
function addNotice(data, userId, event, now) {
  const list = (data.notices[userId] || []).filter((n) => now - n.ts < NOTICE_TTL_MS);
  list.push({ listingId: event.listingId, outcome: event.kind, ts: now, name: event.aboutName || "", label: event.label || "" });
  data.notices[userId] = list.slice(-MAX_NOTICES);
}

function pruneNotices(data, now) {
  for (const [userId, list] of Object.entries(data.notices)) {
    const fresh = (Array.isArray(list) ? list : []).filter((n) => n && now - n.ts < NOTICE_TTL_MS);
    if (fresh.length) data.notices[userId] = fresh;
    else delete data.notices[userId];
  }
}

function takeNotices(data, userId, now) {
  const fresh = (data.notices[userId] || []).filter((n) => now - n.ts < NOTICE_TTL_MS);
  delete data.notices[userId];
  return fresh;
}

module.exports = {
  MIN,
  DEFAULT_TIMES,
  MAX_NOTE,
  MAX_MINUTES,
  MAX_NOTICES,
  NOTICE_TTL_MS,
  CARD_TTL_MS,
  BLOCK_RETRY_MS,
  COALESCE_MS,
  THREAD_GRACE_MS,
  BOX_KINDS,
  newOut,
  newId,
  emptyData,
  shape,
  times,
  findButton,
  labelOf,
  lookingForOptions,
  subscribable,
  subscriptionDiff,
  parseMinutes,
  noteError,
  resolveSearch,
  findListing,
  ownListing,
  isBusy,
  activeRequest,
  pendingRequests,
  activeRequests,
  queuePosition,
  joinable,
  recommend,
  pingTargets,
  dmCandidates,
  createListing,
  addRequest,
  acceptRequest,
  confirmPresence,
  withdrawRequest,
  reopenListing,
  dropListing,
  startGame,
  advance,
  hasActivity,
  cardView,
  cardPlan,
  addNotice,
  takeNotices,
};
