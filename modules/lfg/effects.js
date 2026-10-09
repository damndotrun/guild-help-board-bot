// What happens on Discord after a saved change (M4 spec §3.3–§3.6, §5.4): the
// events state.js collected (out.events) are played here, in order, against
// the state as saved — thread lines, the welcome / confirm message, the
// request panel, DM cards, the board. Called as an action's `effects` (after
// the interaction is acknowledged) and by the 30-second tick.
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

async function onAccepted(ctx, data, L, look, now) {
  // Not added (§8.1) → the welcome mentions the joiner, which also lets them
  // into the private thread; so does a joiner the DM card cannot reach.
  const added = await D.threadMember(ctx, L.threadId, L.joinerId, "add");
  if (!added) ctx.log.warn(`could not add ${L.joinerId} to the thread of ${L.id} — the welcome mentions them`);
  const msg = await D.send(ctx, L.threadId, R.buildWelcome(data, L, look, { pingJoiner: !added || !joinerHasDm(data, L, now) }));
  if (msg) patch(ctx, (d) => { const l = S.findListing(d, L.id); if (l) l.welcomeMessageId = msg.id; });
}

async function onJoined(ctx, data, L, userId) {
  if (!L.threadId) return;
  if (L.notifyMessageId) await D.remove(ctx, L.threadId, L.notifyMessageId);
  const r = S.activeRequest(L, userId);
  const content = textOf(data.config, "joinNotify", { poster: L.posterId, joiner: R.esc((r && r.userName) || "Someone"), n: S.pendingRequests(L).length });
  const msg = await D.send(ctx, L.threadId, R.threadLine(content, [L.posterId]));
  patch(ctx, (d) => { const l = S.findListing(d, L.id); if (l) l.notifyMessageId = msg ? msg.id : null; });
}

// The welcome carries the thread's I'm here button: if its send failed
// (welcomeMessageId null) nobody in the thread could ever confirm — send it
// again and keep its id (re-load, patch by listing id, save); else redraw it.
async function ensureWelcome(ctx, data, L, look, now) {
  if (L.welcomeMessageId) return D.edit(ctx, L.threadId, L.welcomeMessageId, R.buildWelcome(data, L, look));
  const msg = await D.send(ctx, L.threadId, R.buildWelcome(data, L, look, { pingJoiner: !joinerHasDm(data, L, now) }));
  if (msg) patch(ctx, (d) => { const l = S.findListing(d, L.id); if (l && !l.welcomeMessageId) l.welcomeMessageId = msg.id; });
  return !!msg;
}

async function onNag(ctx, data, L, userId, look, now) {
  if (userId === L.joinerId && joinerHasDm(data, L, now)) return; // the DM card carries it
  if (!L.welcomeMessageId) await ensureWelcome(ctx, data, L, look, now);
  if (L.checkIn.nagMessageId) await D.remove(ctx, L.threadId, L.checkIn.nagMessageId);
  const msg = await D.send(ctx, L.threadId, R.threadLine(textOf(data.config, "nag", { user: userId }), [userId]));
  patch(ctx, (d) => { const l = S.findListing(d, L.id); if (l && l.checkIn) l.checkIn.nagMessageId = msg ? msg.id : null; });
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
      if (payload) await D.edit(ctx, L.threadId, L.panelMessageId, payload);
      else ctx.log.error(`the request panel of ${listingId} does not fit a message`);
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

const eventSubject = (ev) => ev.listingId || (ev.listing && ev.listing.id) || ev.userId || "?";

async function runEvent(ctx, data, ev, L, look, now, { panels, cards, refresh }) {
  switch (ev.type) {
    case "dropped": {
      if (ev.outcome === "matched") break; // a played game's thread stays open
      const line = closingLine(data.config, ev.outcome, ev.reason);
      const gone = ev.listing;
      // the request panel goes terminal first: no Accept, no Cancel search left to tap
      const payload = gone.panelMessageId ? R.renderRequestPanel(data, gone, now, look, { closedLine: line }) : null;
      if (payload) await D.edit(ctx, gone.threadId, gone.panelMessageId, payload);
      await D.closeThread(ctx, gone.threadId, line);
      break;
    }
    case "accepted":
      if (L) await onAccepted(ctx, data, L, look, now);
      break;
    case "joined":
      if (L) await onJoined(ctx, data, L, ev.userId);
      break;
    case "checkInOpen":
      if (L && L.state === "confirming" && L.checkIn) {
        await ensureWelcome(ctx, data, L, look, now);
        // the joiner hears it on the DM card — unless the card can't reach them
        const both = !joinerHasDm(data, L, now);
        const vars = { poster: L.posterId, joiner: L.joinerId, when: `<t:${Math.floor(L.startAt / 1000)}:R>` };
        await D.send(ctx, L.threadId, R.threadLine(textOf(data.config, both ? "headsUpBoth" : "headsUp", vars), both ? [L.posterId, L.joinerId] : [L.posterId]));
      }
      break;
    case "welcome":
      if (L && L.welcomeMessageId) await D.edit(ctx, L.threadId, L.welcomeMessageId, R.buildWelcome(data, L, look));
      break;
    case "nag":
      if (L && L.state === "confirming" && L.checkIn) await onNag(ctx, data, L, ev.userId, look, now);
      break;
    case "started":
      if (L) {
        await D.edit(ctx, L.threadId, L.welcomeMessageId, R.buildWelcome(data, L, look));
        if (L.checkIn && L.checkIn.nagMessageId) await D.remove(ctx, L.threadId, L.checkIn.nagMessageId);
        await D.send(ctx, L.threadId, R.renderGameOn(data, L, look));
      }
      break;
    case "reopened": {
      const name = R.esc((L && (L.requests.find((r) => r.userId === ev.joinerId) || {}).userName) || "Your partner");
      const key = ev.reason === "no_confirm" ? "reopened" : "reopenedLeft";
      await D.edit(ctx, ev.threadId, ev.welcomeMessageId, R.renderWelcomeClosed(textOf(data.config, key, { joiner: name })));
      // the last "tap I'm here" line has nothing left to confirm
      if (ev.nagMessageId) await D.remove(ctx, ev.threadId, ev.nagMessageId);
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
  await D.send(ctx, thread.id, { content: textOf(data.config, "threadIntro"), allowedMentions: { parse: [] } });
  let current = store.load(ctx);
  let live = S.findListing(current, listingId);
  const panel = live ? await D.send(ctx, thread.id, R.renderRequestPanel(current, { ...live, threadId: thread.id }, now)) : null;
  current = store.load(ctx);
  live = S.findListing(current, listingId);
  if (!live) {
    // cancelled while the thread was opening
    await D.closeThread(ctx, thread.id, textOf(data.config, "closedCancelled"));
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
// one still running is skipped. Idempotent — lfg.json is the truth.
let ticking = false;
async function tick(ctx) {
  if (ticking) return "skipped";
  ticking = true;
  try {
    const data = store.load(ctx);
    if (!data.config) return "idle";
    const before = JSON.stringify(data);
    const { events, log } = S.advance(data, D.nowOf(ctx));
    if (JSON.stringify(data) !== before) store.commit(ctx, data, { log });
    await runEvents(ctx, events, { sync: false });
    await C.expirePing(ctx);
    await C.sync(ctx, { checkTail: true });
    return "ran";
  } finally {
    ticking = false;
  }
}

module.exports = { closingLine, runEvents, afterCreate, tick };
