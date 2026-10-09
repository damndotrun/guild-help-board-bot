// The board channel (M4 spec §5.3): ONE bot message at the bottom of the
// channel holding the blocks in config.layout order (banner · panel · board —
// live test 2026-10-09: separate messages each showed "(edited)" and read as a
// pile), the 60-second ping under it. ONE writer: every channel write runs on
// one promise chain, so two searches posted at once can never leave two boards.
const { MessageType } = require("discord.js");
const S = require("./state");
const R = require("./render");
const D = require("./discord");
const store = require("./store");

let chain = Promise.resolve();
function enqueue(ctx, fn) {
  const job = chain.then(() => fn()).catch((err) => ctx.log.error("channel write failed:", err));
  chain = job;
  return job;
}

// Log-once flags: a persistent condition is reported when it starts, not on
// every 30-second tick (reset when it clears).
let hiddenLogged = false;
let tailSkipLogged = false;
let fitLogged = false; // "does not fit one message"
let editFailLogged = false; // an edit refused with anything but 10008
let deleteFailLogged = false; // an old message we could not delete

// The last payload sent per message id: an unchanged message is never re-sent.
// The role picker's tag (render.renderTag) is left out of the hash, so a tag
// minted after a restart is no change by itself.
const lastSent = new Map();
// The role picker's custom_id tag on the live message. STABLE across
// board-driven edits (a member's open pick survives a board change); a fresh
// one only from resetPanel — right after a pick, where an identical custom_id
// would freeze in the client (invariant 17) — and on a repost (a new message).
// In memory: after a restart the first render mints one.
let pickerTag = null;
const stableTag = () => pickerTag || (pickerTag = R.renderTag());
const hashOf = (payload) =>
  JSON.stringify(payload, (key, value) => (key === "custom_id" && typeof value === "string" && value.startsWith("lfg:roles:") ? "lfg:roles:" : value));

// The blocks that render: a banner without an image is skipped (§3.1); one
// block per type, the first (renderable) one wins — a second panel or board
// would repeat its custom_ids.
function activeBlocks(config) {
  const seen = new Set();
  return (config.layout || [])
    .map((block, index) => ({ ...block, index }))
    .filter((b) => (b.type === "banner" ? !!b.imageUrl : b.type === "panel" || b.type === "board"))
    .filter((b) => !seen.has(b.type) && seen.add(b.type));
}

// Pure: is the bottom of the channel exactly our message (+ the live ping)?
// `recent` is newest first ({ id, type, authorId }). `junk` = the bot's OWN
// messages in the window that are deleted, not a reason to repost: the "X
// started a thread" system lines (private threads normally post none in the
// parent channel, so this branch is a guard; Task 13's live measurement shows
// whether it ever fires) and orphans — a plain bot message that is neither
// ours nor the ping, left by a crash between a send and its save.
function tailCheck(recent, mainId, pingId, botId) {
  const isJunk = (m) =>
    m.authorId === botId && (m.type === MessageType.ThreadCreated || (m.type === MessageType.Default && m.id !== mainId && m.id !== pingId));
  const junk = recent.filter(isJunk).map((m) => m.id);
  const rest = recent.filter((m) => !junk.includes(m.id));
  let i = 0;
  if (pingId && rest[0] && rest[0].id === pingId) i = 1;
  return { ok: !!mainId && !!rest[i] && rest[i].id === mainId, junk };
}

const hasRoleIn = (guild) => (id) => !guild || !guild.roles || guild.roles.cache.has(id);
const hasEmojiIn = D.hasEmojiIn; // a custom emoji still in the guild? unknown cache = present

// Every message id the store still points at: the one message, the old
// per-block ids of a store from before the one-message build (migration), and
// the old messages whose delete failed earlier (staleIds).
const knownIds = (channelData) => [
  ...new Set([channelData.mainMessageId, ...Object.values(channelData.messageIds || {}), ...(channelData.staleIds || [])].filter(Boolean)),
];

// Delete these of our messages; returns the ids still there (a failure other
// than 10008 = already gone) — the caller keeps them in staleIds.
async function deleteAll(ctx, channel, ids) {
  const left = [];
  for (const id of ids) {
    try {
      await channel.messages.delete(id);
    } catch (err) {
      if (err.code !== D.UNKNOWN_MESSAGE) {
        left.push(id);
        if (!deleteFailLogged) ctx.log.warn(`could not delete old message ${id} (kept, retried every sync): ${err.message}`);
        deleteFailLogged = true;
      }
    }
    if (!left.includes(id)) lastSent.delete(id);
  }
  if (left.length === 0) deleteFailLogged = false;
  return left;
}

function fitFailed(ctx, what) {
  if (!fitLogged) ctx.log.error(`the channel blocks do not fit one message — ${what}`);
  fitLogged = true;
}

async function renderNow(ctx, data, blocks, now, tag) {
  const guild = await D.getGuild(ctx, data.config);
  return R.renderStack(data, blocks, now, D.lookFor(ctx, guild), hasRoleIn(guild), tag, hasEmojiIn(guild));
}

// Delete our message(s) and post the stack again (no ping) — after a restart
// with the message gone, when something got under it, or to migrate a store
// with the old per-block ids.
async function repost(ctx, channel, data, blocks, now) {
  const left = await deleteAll(ctx, channel, knownIds(data.channel));
  // The old ids are gone — or kept in staleIds, never untracked (an old
  // message is a second live Start button). The new id is saved the moment
  // its send succeeds; a failing send leaves no id → the next sync reposts.
  const cleared = store.load(ctx);
  cleared.channel.mainMessageId = null;
  delete cleared.channel.messageIds;
  cleared.channel.staleIds = left;
  store.save(ctx, cleared);
  const tag = R.renderTag(); // a new message: a new picker tag
  let payload = await renderNow(ctx, data, blocks, now, tag);
  if (payload) fitLogged = false;
  else {
    // Never skip the message: a missing id would repost every tick. The panel
    // and the empty board stand in; the next edit brings the real board once it fits.
    fitFailed(ctx, "posting the panel and an empty board");
    const guild = await D.getGuild(ctx, data.config);
    payload = R.renderStackFallback(data.config, blocks, hasRoleIn(guild), tag, hasEmojiIn(guild));
  }
  const msg = await channel.send(payload);
  pickerTag = tag;
  lastSent.set(msg.id, hashOf(payload));
  const fresh = store.load(ctx); // no await between this load and the save
  fresh.channel.mainMessageId = msg.id;
  store.save(ctx, fresh);
  return msg.id;
}

// Bring the channel in line with lfg.json. checkTail (the tick): also verify
// that nothing sits under the message. Without it (after an action) only a
// missing id forces a repost; the message is edited in place when its
// payload changed.
function sync(ctx, { checkTail = false } = {}) {
  return enqueue(ctx, async () => {
    const now = D.nowOf(ctx);
    const data = store.load(ctx);
    if (!data.config) return "unconfigured";
    const channel = await D.getChannel(ctx, data.config.channelId);
    if (!channel || D.isObfuscated(channel)) {
      if (!hiddenLogged) ctx.log.error("I can't see the looking-for-game channel — not posting.");
      hiddenLogged = true;
      return "hidden";
    }
    hiddenLogged = false;
    const blocks = activeBlocks(data.config);
    const id = data.channel.mainMessageId;
    if (blocks.length === 0) {
      // Nothing to show (an empty layout, or only a banner without an image):
      // an empty V2 message would be refused every tick — take ours down instead.
      // A delete that fails (not 10008) keeps its id in staleIds → retried next tick.
      if (knownIds(data.channel).length === 0) return "empty";
      const left = await deleteAll(ctx, channel, knownIds(data.channel));
      const fresh = store.load(ctx); // no await between this load and the save
      fresh.channel.mainMessageId = null;
      delete fresh.channel.messageIds;
      fresh.channel.staleIds = left;
      store.save(ctx, fresh);
      return "empty";
    }
    if (!id || data.channel.messageIds) {
      await repost(ctx, channel, data, blocks, now);
      return "reposted";
    }
    if (checkTail) {
      let recent = null;
      try {
        // our message + the ping + room for a few junk/system lines (2nd-round
        // review), so two searches in one tick don't force a repost
        const fetched = await channel.messages.fetch({ limit: 6 });
        recent = [...fetched.values()].map((m) => ({ id: m.id, type: m.type, authorId: m.author && m.author.id }));
      } catch (err) {
        // Some failures throw: skip the position check, still edit the message
        if (!tailSkipLogged) ctx.log.warn(`tail check skipped: ${err.message}`);
        tailSkipLogged = true;
      }
      // Without Read Message History Discord does NOT throw — it returns an
      // empty list: treating that as "something is in the way" would repost
      // every tick. Only an EMPTY window is skipped; a non-empty one without
      // our id means the message is buried under newer ones → repost (after
      // it ours is the newest, so this cannot loop).
      if (recent && recent.length === 0) {
        if (!tailSkipLogged) ctx.log.warn("tail check skipped: the channel history came back empty (Read Message History?)");
        tailSkipLogged = true;
        recent = null;
      }
      if (recent) {
        tailSkipLogged = false;
        const botId = ctx.client && ctx.client.user ? ctx.client.user.id : "bot";
        const { ok, junk } = tailCheck(recent, id, data.channel.pingMessageId, botId);
        for (const j of junk) await channel.messages.delete(j).catch(() => {});
        if (!ok) {
          await repost(ctx, channel, data, blocks, now);
          return "reposted";
        }
      }
    }
    if (data.channel.staleIds.length) {
      const left = await deleteAll(ctx, channel, data.channel.staleIds);
      const fresh = store.load(ctx); // no await between this load and the save
      fresh.channel.staleIds = left;
      store.save(ctx, fresh);
    }
    const payload = await renderNow(ctx, data, blocks, now, stableTag()); // a board edit keeps the picker's custom_id
    if (!payload) {
      fitFailed(ctx, "keeping the last one");
      return "invalid";
    }
    fitLogged = false;
    if (lastSent.get(id) === hashOf(payload)) return "unchanged";
    try {
      await channel.messages.edit(id, payload);
      lastSent.set(id, hashOf(payload));
      editFailLogged = false;
      return "edited";
    } catch (err) {
      if (err.code === D.UNKNOWN_MESSAGE) {
        await repost(ctx, channel, store.load(ctx), blocks, now);
        return "reposted";
      }
      // e.g. 50035: refused payload — logged once, retried every tick (the
      // hash is not stored), re-armed by the next edit that goes through.
      if (!editFailLogged) ctx.log.error(`could not edit the channel message ${id}: ${err.message}`);
      editFailLogged = true;
      return "failed";
    }
  });
}

// The role picker keeps the member's pick on screen until its message is
// re-rendered — editing the message resets it for everyone (§3.1). Always
// sent, even when nothing else changed: clearing the picker is the point. The
// ONE place a live message gets a fresh picker tag (right after a pick, so the
// client does not freeze the select — invariant 17).
function resetPanel(ctx) {
  return enqueue(ctx, async () => {
    const now = D.nowOf(ctx);
    const data = store.load(ctx);
    if (!data.config) return;
    const blocks = activeBlocks(data.config);
    const id = data.channel.mainMessageId;
    if (!id || data.channel.messageIds || !blocks.some((b) => b.type === "panel")) return;
    const tag = R.renderTag();
    const payload = await renderNow(ctx, data, blocks, now, tag);
    if (!payload) return; // logged by the next sync, which keeps the last message
    if (await D.edit(ctx, data.config.channelId, id, payload)) {
      pickerTag = tag; // a failed edit leaves the old tag on the message — and here
      lastSent.set(id, hashOf(payload));
    }
  });
}

// The new-search ping under the board (U7): one at a time; a deleted ping
// role is left out (and logged); no role left → no ping.
function postPing(ctx, listingId) {
  return enqueue(ctx, async () => {
    const now = D.nowOf(ctx);
    const data = store.load(ctx);
    const listing = data.config && S.findListing(data, listingId);
    if (!listing) return null;
    const guild = await D.getGuild(ctx, data.config);
    const wanted = S.pingTargets(data.config, listing);
    const roleIds = wanted.filter(hasRoleIn(guild));
    if (roleIds.length < wanted.length) ctx.log.warn(`ping role(s) gone: ${wanted.filter((id) => !roleIds.includes(id)).join(", ")}`);
    if (roleIds.length === 0) return null;
    if (data.channel.pingMessageId) await D.remove(ctx, data.config.channelId, data.channel.pingMessageId);
    const msg = await D.send(ctx, data.config.channelId, R.renderPing(data.config, listing, roleIds, D.lookFor(ctx, guild)));
    const fresh = store.load(ctx);
    fresh.channel.pingMessageId = msg ? msg.id : null;
    fresh.channel.pingUntil = msg ? now + S.times(fresh.config).pingSec * 1000 : null;
    store.save(ctx, fresh);
    return msg ? msg.id : null;
  });
}

// The tick deletes a ping whose 60 seconds are up.
function expirePing(ctx) {
  return enqueue(ctx, async () => {
    const now = D.nowOf(ctx);
    const data = store.load(ctx);
    if (!data.config || !data.channel.pingMessageId || now < (data.channel.pingUntil || 0)) return false;
    await D.remove(ctx, data.config.channelId, data.channel.pingMessageId);
    const fresh = store.load(ctx);
    fresh.channel.pingMessageId = null;
    fresh.channel.pingUntil = null;
    store.save(ctx, fresh);
    return true;
  });
}

// Tests only: forget the sent-payload cache and start a fresh chain.
function _reset() {
  lastSent.clear();
  pickerTag = null;
  fitLogged = false;
  editFailLogged = false;
  deleteFailLogged = false;
  hiddenLogged = false;
  tailSkipLogged = false;
  chain = Promise.resolve();
}

module.exports = { enqueue, activeBlocks, tailCheck, sync, resetPanel, postPing, expirePing, _reset };
