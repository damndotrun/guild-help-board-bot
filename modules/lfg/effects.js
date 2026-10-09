// What happens on Discord after a saved change (M4 spec §3.3–§3.6, §5.4): the
// events state.js collected (out.events) are played here, in order, against
// the state as saved — the thread's ONE live message (the request panel:
// intro, Requests, Removed, the reopen notice, Confirm with I'm here, Game
// on!), the transient ping lines, DM cards, the board. Called as an action's
// `effects` (after the interaction is acknowledged) and by the 30-second tick.
//
// Transient lines (live test round 2, item A): Discord notifies at send time,
// so a ping line is deleted transientSec after it was sent. Its id is
// recorded on the listing (listing.lines) until the delete succeeds (10008 =
// done): an in-process timer deletes it, and the tick (sweepLines) takes what
// a restart left behind.
const S = require("./state");
const R = require("./render");
const D = require("./discord");
const C = require("./channel");
const store = require("./store");
const { textOf } = require("./texts");

function patch(ctx, fn) {
  const fresh = store.load(ctx);
  fn(fresh);
  store.save(ctx, fresh);
}

function closingLine(config, outcome, reason) {
  if (outcome === "expired") return textOf(config, "closedExpired");
  if (outcome === "removed") return textOf(config, "closedRemoved");
  if (reason === "no_confirm") return textOf(config, "closedNoConfirm");
  return textOf(config, "closedCancelled");
}

// The joiner's DM card can carry the news (else the thread pings them).
const joinerHasDm = (data, listing, now) => D.dmReachable(data, listing.joinerId, now);

const transientMs = (config) => Math.max(0, Number(S.times(config).transientSec) || 0) * 1000;

// ── transient thread lines ─────────────────────────────────────────────────

// In-process registry of the transient lines per listing (A2, Fable review):
// `pending` = sends still in flight, `ids` = lines sent and not deleted yet.
// A line whose send was in flight when the search was dropped is NOT in the
// dropped event's listing (that snapshot was saved before the send returned)
// and its record patch finds no listing — so the `dropped` handler awaits the
// in-flight sends and deletes the registry's ids too, before the thread is
// locked and archived (a delete in an archived thread would fail).
const transient = new Map();
const entryOf = (listingId) => {
  if (!transient.has(listingId)) transient.set(listingId, { pending: new Set(), ids: new Map() });
  return transient.get(listingId);
};
function forgetLine(listingId, messageId) {
  const e = transient.get(listingId);
  if (!e) return;
  e.ids.delete(messageId);
  if (e.ids.size === 0 && e.pending.size === 0) transient.delete(listingId);
}

// Delete one recorded line; once it is gone (deleted or 10008) its record goes
// too (re-load, patch by listing id, save). A failed delete keeps the record
// for the next try (timer or tick).
async function dropLine(ctx, listingId, threadId, messageId) {
  if (!(await D.remove(ctx, threadId, messageId))) return false;
  forgetLine(listingId, messageId);
  patch(ctx, (d) => {
    const l = S.findListing(d, listingId);
    if (l) l.lines = l.lines.filter((x) => x.id !== messageId);
  });
  return true;
}

// The dropped handler's sweep: wait for the listing's in-flight sends, then
// delete every line it knows of — the event's snapshot plus the registry.
async function dropAllLines(ctx, gone) {
  const e = transient.get(gone.id);
  if (e && e.pending.size) await Promise.allSettled([...e.pending]);
  const ids = new Set([...(gone.lines || []).map((x) => x.id), ...(e ? e.ids.keys() : [])]);
  for (const id of ids) {
    await D.remove(ctx, gone.threadId, id);
    forgetLine(gone.id, id);
  }
  transient.delete(gone.id);
}

// Delete the listing's recorded lines of these kinds now (a nag replacing the
// last nag, a join notification replacing the last one, a reopen).
async function dropLines(ctx, listingId, kinds) {
  const L = S.findListing(store.load(ctx), listingId);
  if (!L) return;
  for (const line of L.lines.filter((x) => kinds.includes(x.kind))) await dropLine(ctx, L.id, L.threadId, line.id);
}

// Send a ping line into the thread, record it, and delete it transientSec
// later. A search already gone from the store gets no new line (its thread is
// being closed); the check and the registration are synchronous, so a drop
// saved after them finds this send in the registry (dropAllLines).
function sendTransient(ctx, L, kind, payload) {
  if (!S.findListing(store.load(ctx), L.id)) return Promise.resolve(null);
  const e = entryOf(L.id);
  const job = sendTransientNow(ctx, L, kind, payload);
  e.pending.add(job);
  job.finally(() => {
    e.pending.delete(job);
    if (e.ids.size === 0 && e.pending.size === 0 && transient.get(L.id) === e) transient.delete(L.id);
  }).catch(() => {});
  return job;
}

async function sendTransientNow(ctx, L, kind, payload) {
  const msg = await D.send(ctx, L.threadId, payload);
  if (!msg) return null;
  entryOf(L.id).ids.set(msg.id, L.threadId);
  const ms = transientMs(store.load(ctx).config);
  patch(ctx, (d) => {
    const l = S.findListing(d, L.id);
    if (l) l.lines.push({ id: msg.id, kind, until: D.nowOf(ctx) + ms });
  });
  D.later(ctx, ms, () => dropLine(ctx, L.id, L.threadId, msg.id));
  return msg;
}

// The tick's backstop: lines whose time is up (a timer a restart lost, or a
// delete that failed) are deleted now.
async function sweepLines(ctx, now) {
  const data = store.load(ctx);
  for (const L of data.listings) {
    for (const line of L.lines.filter((x) => now >= x.until)) {
      try {
        await dropLine(ctx, L.id, L.threadId, line.id);
      } catch (err) {
        ctx.log.error(`could not delete thread line ${line.id} of ${L.id}:`, err);
      }
    }
  }
}

// ── the events ─────────────────────────────────────────────────────────────

async function onAccepted(ctx, data, L, now) {
  // No WAKEY message (live test round 2): the searcher just tapped Accept, the
  // thread message turns into the Confirm box (the panel event). The joiner
  // hears it on the DM card; one without a reachable card — or one the bot
  // could not add (the mention lets them in) — gets ONE transient ping line.
  const added = await D.threadMember(ctx, L.threadId, L.joinerId, "add");
  if (!added) ctx.log.warn(`could not add ${L.joinerId} to the thread of ${L.id} — the thread pings them`);
  if (added && joinerHasDm(data, L, now)) return;
  const vars = { joiner: L.joinerId, poster: R.esc(L.posterName), when: R.when(L.startAt) };
  const key = L.state === "fixed" ? "pickedPingTimed" : "pickedPing";
  await sendTransient(ctx, L, "picked", R.threadLine(textOf(data.config, key, vars), [L.joinerId]));
}

async function onJoined(ctx, data, L, userId) {
  if (!L.threadId) return;
  await dropLines(ctx, L.id, ["notify"]); // normally already gone (transient)
  const r = S.activeRequest(L, userId);
  const content = textOf(data.config, "joinNotify", { poster: L.posterId, joiner: R.esc((r && r.userName) || "Someone"), n: S.pendingRequests(L).length });
  await sendTransient(ctx, L, "notify", R.threadLine(content, [L.posterId]));
}

async function onNag(ctx, data, L, userId, now) {
  if (userId === L.joinerId && joinerHasDm(data, L, now)) return; // the DM card carries it
  await dropLines(ctx, L.id, ["nag"]); // each nag replaces the previous one
  await sendTransient(ctx, L, "nag", R.threadLine(textOf(data.config, "nag", { user: userId }), [userId]));
}

// The old separate welcome message (a store from before the one-message
// thread): deleted once the panel message carries the Confirm box; the id is
// kept until the delete succeeds (10008 = gone).
async function dropLegacyWelcome(ctx, L) {
  if (!L.welcomeMessageId) return;
  const id = L.welcomeMessageId;
  if (!(await D.remove(ctx, L.threadId, id))) return;
  patch(ctx, (d) => {
    const l = S.findListing(d, L.id);
    if (l && l.welcomeMessageId === id) delete l.welcomeMessageId;
  });
}

async function runEvents(ctx, events, { sync = true } = {}) {
  const now = D.nowOf(ctx);
  let data = store.load(ctx);
  const guild = await D.getGuild(ctx, data.config);
  const look = D.lookFor(ctx, guild);
  const panels = new Set();
  const cards = [];
  const refresh = new Set();
  for (const ev of events) {
    // one event that throws (a renderer, a REST quirk) never drops the rest of
    // the batch, the panels, the cards or the board sync
    try {
      data = store.load(ctx);
      // a listing an earlier event of this batch (or a later save) dropped is gone: L is null
      const L = ev.listingId ? S.findListing(data, ev.listingId) : null;
      await runEvent(ctx, data, ev, L, look, now, { panels, cards, refresh });
    } catch (err) {
      ctx.log.error(`event ${ev.type} for ${eventSubject(ev)} failed:`, err);
    }
  }
  data = store.load(ctx);
  for (const listingId of panels) {
    try {
      const L = S.findListing(data, listingId);
      if (!L || !L.panelMessageId) continue;
      const payload = R.renderRequestPanel(data, L, now, look);
      if (!payload) {
        ctx.log.error(`the request panel of ${listingId} does not fit a message`);
        continue;
      }
      if (await D.edit(ctx, L.threadId, L.panelMessageId, payload)) await dropLegacyWelcome(ctx, L);
    } catch (err) {
      ctx.log.error(`event panel for ${listingId} failed:`, err);
    }
  }
  for (const ev of cards) {
    refresh.delete(ev.userId);
    try {
      await D.deliverCard(ctx, ev.userId, ev.event);
    } catch (err) {
      ctx.log.error(`event card for ${ev.userId} failed:`, err);
    }
  }
  for (const userId of refresh) {
    try {
      await D.deliverCard(ctx, userId, null);
    } catch (err) {
      ctx.log.error(`event cardRefresh for ${userId} failed:`, err);
    }
  }
  if (sync) await C.sync(ctx);
}

const eventSubject = (ev) => ev.listingId || (ev.listing && ev.listing.id) || ev.threadId || ev.userId || "?";

const threadLog = (ctx, now, listingId, threadId, event, extra = {}) =>
  store.appendLog(ctx, [{ type: "thread", ts: now, listingId, threadId, event, ...extra }]);

async function runEvent(ctx, data, ev, L, look, now, { panels, cards, refresh }) {
  switch (ev.type) {
    case "dropped": {
      if (ev.outcome === "matched") break; // a played game's thread stays open (archived by its own timer)
      const gone = ev.listing;
      if (!gone.threadId) break;
      const line = closingLine(data.config, ev.outcome, ev.reason);
      // its ping lines go first (a locked, archived thread keeps no "tap I'm
      // here") — incl. one whose send was still in flight at the drop (A2)
      await dropAllLines(ctx, gone);
      if (gone.welcomeMessageId) await D.remove(ctx, gone.threadId, gone.welcomeMessageId);
      // the thread message goes terminal: no Accept, no Cancel search, no I'm
      // here left to tap, the closing line inside it; a thread without a panel
      // message gets the line as a message instead
      const payload = gone.panelMessageId ? R.renderRequestPanel(data, gone, now, look, { closedLine: line }) : null;
      const shown = payload ? await D.edit(ctx, gone.threadId, gone.panelMessageId, payload) : false;
      if (!shown) await D.send(ctx, gone.threadId, { content: line, allowedMentions: { parse: [] } });
      // locked as before AND archived right away (live test round 2, item E)
      if (await D.closeThread(ctx, gone.threadId)) threadLog(ctx, now, gone.id, gone.threadId, "archived", { outcome: ev.outcome });
      break;
    }
    case "archive":
      // a played game's thread, archiveAfterMin after the start — not locked:
      // people may keep talking (a new message unarchives it)
      if (await D.archiveThread(ctx, ev.threadId)) threadLog(ctx, now, ev.listingId, ev.threadId, "archived", { outcome: "matched" });
      break;
    case "accepted":
      if (L) await onAccepted(ctx, data, L, now);
      break;
    case "joined":
      if (L) await onJoined(ctx, data, L, ev.userId);
      break;
    case "checkInOpen":
      // a fixed game's confirm window opened: the Heads up pings BOTH players
      // (transient); the Confirm box gets its I'm here (the panel event)
      if (L && L.state === "confirming" && L.checkIn) {
        const vars = { poster: L.posterId, joiner: L.joinerId, when: R.when(L.startAt) };
        await sendTransient(ctx, L, "headsUp", R.threadLine(textOf(data.config, "headsUp", vars), [L.posterId, L.joinerId]));
      }
      break;
    case "nag":
      if (L && L.state === "confirming" && L.checkIn) await onNag(ctx, data, L, ev.userId, now);
      break;
    case "started":
      // the Game on! box replaces Confirm in the thread message (the panel
      // event); a "tap I'm here" line has nothing left to ask
      if (L) await dropLines(ctx, L.id, ["nag", "picked", "headsUp"]);
      break;
    case "reopened": {
      // the red "didn't confirm / left — open again" box is in the thread
      // message (listing.notice, the panel event); here: the leftovers
      if (ev.welcomeMessageId) await D.remove(ctx, ev.threadId, ev.welcomeMessageId);
      if (L) await dropLines(ctx, L.id, ["nag", "picked", "headsUp"]);
      await D.threadMember(ctx, ev.threadId, ev.joinerId, "remove");
      break;
    }
    case "panel":
      panels.add(ev.listingId);
      break;
    case "card":
      cards.push(ev);
      break;
    case "cardRefresh":
      refresh.add(ev.userId);
      break;
    case "cardDelete":
      // through the member's card queue, like every other card job (§5.2/7)
      await D.deleteStaleCard(ctx, ev.userId, ev.messageId, ev.staleIds);
      break;
    default:
      ctx.log.warn(`unknown event ${ev.type}`);
  }
}

// After createListing (§3.3/1, invariant 2): the thread is part of the search.
// No thread → the search is cancelled (thread_failed) and nothing else runs;
// the ping and the new-search DMs only go out after a thread exists (followUp).
// A search whose afterCreate never ran is dropped by the tick (state.advance).
// The thread gets ONE message: the request panel (its intro line inside).
async function afterCreate(ctx, listingId) {
  const now = D.nowOf(ctx);
  const data = store.load(ctx);
  const L = S.findListing(data, listingId);
  if (!L) return { ok: false, error: textOf(data.config, "notOpen") };
  let thread;
  try {
    thread = await D.openThread(ctx, data.config, L);
  } catch (err) {
    ctx.log.error(`could not open the thread for ${listingId}: ${err.message}`);
    const out = S.newOut();
    const fresh = store.load(ctx);
    const gone = S.findListing(fresh, listingId);
    if (gone) S.dropListing(fresh, gone, { outcome: "cancelled", reason: "thread_failed" }, now, out);
    store.commit(ctx, fresh, out);
    await C.sync(ctx);
    return { ok: false, error: textOf(data.config, "threadFailed") };
  }
  // logged before anything is saved: a crash from here on leaves a thread no
  // store knows — this line is how that orphan is found
  ctx.log.log(`opened thread ${thread.id} for search ${listingId}`);
  let current = store.load(ctx);
  let live = S.findListing(current, listingId);
  const panel = live ? await D.send(ctx, thread.id, R.renderRequestPanel(current, { ...live, threadId: thread.id }, now)) : null;
  current = store.load(ctx);
  live = S.findListing(current, listingId);
  if (!live) {
    // cancelled while the thread was opening: its message goes terminal, then lock + archive
    const line = textOf(data.config, "closedCancelled");
    const closed = panel ? R.renderRequestPanel(current, { ...L, threadId: thread.id }, now, undefined, { closedLine: line }) : null;
    if (!(closed && (await D.edit(ctx, thread.id, panel.id, closed)))) await D.send(ctx, thread.id, { content: line, allowedMentions: { parse: [] } });
    await D.closeThread(ctx, thread.id);
    return { ok: false, error: textOf(data.config, "notOpen") };
  }
  live.threadId = thread.id;
  live.panelMessageId = panel ? panel.id : null;
  store.save(ctx, current);
  // The searcher's answer must not wait for the ping, the board or up to 50
  // DMs: those are the followUp, which the caller runs after its reply.
  const followUp = async () => {
    await C.postPing(ctx, listingId);
    await C.sync(ctx);
    try {
      await D.dmNewSearch(ctx, listingId);
    } catch (err) {
      ctx.log.error(`new-search DMs for ${listingId} failed:`, err);
    }
  };
  return { ok: true, threadId: thread.id, threadUrl: R.threadUrl(current.config, thread.id), followUp };
}

// The 30-second job (§5.4). Re-entrancy guard: a tick that finds the previous
// one still running is skipped. Idempotent — lfg.json is the truth. Besides
// advance(): a listing still carrying the old separate welcome message gets a
// panel redraw (which deletes it — the one-message migration; one without a
// panel message has nothing to redraw: its welcome is deleted directly, A3),
// and the ping lines whose time is up are deleted (a restart's leftovers).
let ticking = false;
async function tick(ctx) {
  if (ticking) return "skipped";
  ticking = true;
  try {
    const data = store.load(ctx);
    if (!data.config) return "idle";
    const now = D.nowOf(ctx);
    const before = JSON.stringify(data);
    const { events, log } = S.advance(data, now);
    if (JSON.stringify(data) !== before) store.commit(ctx, data, { log });
    const panelless = [];
    for (const l of data.listings) {
      if (!l.welcomeMessageId) continue;
      if (l.panelMessageId) events.push({ type: "panel", listingId: l.id });
      else panelless.push(l);
    }
    await runEvents(ctx, events, { sync: false });
    for (const l of panelless) {
      try {
        await dropLegacyWelcome(ctx, l);
      } catch (err) {
        ctx.log.error(`could not delete the old welcome of ${l.id}:`, err);
      }
    }
    await sweepLines(ctx, now);
    await C.expirePing(ctx);
    await C.sync(ctx, { checkTail: true });
    return "ran";
  } finally {
    ticking = false;
  }
}

module.exports = {
  closingLine,
  runEvents,
  afterCreate,
  tick,
  sweepLines,
  // tests only: forget the in-process transient-line registry
  _reset: () => transient.clear(),
};
