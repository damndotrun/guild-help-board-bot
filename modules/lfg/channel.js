// The board channel (M4 spec §5.3): the bot's messages in config.layout order
// (banner · panel · board) at the bottom of the channel, the 60-second ping
// under them. ONE writer: every channel write runs on one promise chain, so
// two searches posted at once can never leave two boards.
const { MessageType } = require("discord.js");
const S = require("./state");
const R = require("./render");
const D = require("./discord");
const store = require("./store");

let chain = Promise.resolve();
function enqueue(ctx, fn) {
  const job = chain.then(fn).catch((err) => ctx.log.error("channel write failed:", err));
  chain = job;
  return job;
}

// The last payload sent per message id: an unchanged board is never re-sent.
const lastSent = new Map();
const hashOf = (payload) => JSON.stringify(payload);

// The blocks that render: a banner without an image is skipped (§3.1).
function activeBlocks(config) {
  return (config.layout || [])
    .map((block, index) => ({ ...block, index }))
    .filter((b) => (b.type === "banner" ? !!b.imageUrl : b.type === "panel" || b.type === "board"));
}

function renderBlock(data, block, now, look, hasRole) {
  if (block.type === "banner") return R.renderBanner(block);
  if (block.type === "panel") return R.renderPanel(data.config, hasRole);
  return R.renderBoard(data, now, look);
}

// Pure: is the bottom of the channel exactly our blocks (+ the live ping)?
// `recent` is newest first ({ id, type, authorId }). The "X started a thread"
// system lines the bot itself leaves are `junk` — deleted, not a reason to repost.
function tailCheck(recent, blockIds, pingId, botId) {
  const junk = recent.filter((m) => m.type === MessageType.ThreadCreated && m.authorId === botId).map((m) => m.id);
  const rest = recent.filter((m) => !junk.includes(m.id));
  let i = 0;
  if (pingId && rest[0] && rest[0].id === pingId) i = 1;
  const ok = [...blockIds].reverse().every((id) => rest[i] && rest[i++].id === id);
  return { ok, junk };
}

const hasRoleIn = (guild) => (id) => !guild || !guild.roles || guild.roles.cache.has(id);

// Delete our blocks and post them again in order (no ping) — after a restart
// with a block gone, or when something got between / under them.
async function repost(ctx, channel, data, blocks, now) {
  for (const id of Object.values(data.channel.messageIds)) {
    await channel.messages.delete(id).catch(() => {});
    lastSent.delete(id);
  }
  const guild = await D.getGuild(ctx, data.config);
  const look = D.lookFor(ctx, guild);
  const ids = {};
  for (const block of blocks) {
    let payload = renderBlock(data, block, now, look, hasRoleIn(guild));
    if (!payload) {
      // Never skip a block: a missing id would repost every tick. The empty
      // board stands in; the next edit brings the real one once it fits.
      ctx.log.error(`block ${block.index} (${block.type}) does not fit a message — posting a placeholder`);
      payload = R.renderEmptyBoard(data.config);
    }
    const msg = await channel.send({ ...payload, allowedMentions: { parse: [] } });
    ids[block.index] = msg.id;
    lastSent.set(msg.id, hashOf(payload));
  }
  const fresh = store.load(ctx);
  fresh.channel.messageIds = ids;
  store.save(ctx, fresh);
  return ids;
}

// Bring the channel in line with lfg.json. checkTail (the tick): also verify
// that nothing sits between or under the blocks. Without it (after an
// action) only a missing block forces a repost; the board is edited in place
// when its payload changed.
function sync(ctx, { checkTail = false } = {}) {
  return enqueue(ctx, async () => {
    const now = D.nowOf(ctx);
    const data = store.load(ctx);
    if (!data.config) return "unconfigured";
    const channel = await D.getChannel(ctx, data.config.channelId);
    if (!channel || D.isObfuscated(channel)) {
      ctx.log.error("I can't see the looking-for-game channel — not posting.");
      return "hidden";
    }
    const blocks = activeBlocks(data.config);
    const ids = blocks.map((b) => data.channel.messageIds[b.index]);
    if (ids.some((id) => !id) || Object.keys(data.channel.messageIds).length !== blocks.length) {
      await repost(ctx, channel, data, blocks, now);
      return "reposted";
    }
    if (checkTail) {
      let recent = null;
      try {
        // + ping + room for a few junk/system lines (2nd-round review), so two searches in one tick don't force a repost
        const fetched = await channel.messages.fetch({ limit: blocks.length + 4 });
        recent = [...fetched.values()].map((m) => ({ id: m.id, type: m.type, authorId: m.author && m.author.id }));
      } catch (err) {
        // e.g. no Read Message History: skip the position check, still edit the board
        ctx.log.warn(`tail check skipped: ${err.message}`);
      }
      if (recent) {
        const botId = ctx.client && ctx.client.user ? ctx.client.user.id : "bot";
        const { ok, junk } = tailCheck(recent, ids, data.channel.pingMessageId, botId);
        for (const id of junk) await channel.messages.delete(id).catch(() => {});
        if (!ok) {
          await repost(ctx, channel, data, blocks, now);
          return "reposted";
        }
      }
    }
    const board = blocks.find((b) => b.type === "board");
    if (!board) return "ok";
    const guild = await D.getGuild(ctx, data.config);
    const payload = R.renderBoard(data, now, D.lookFor(ctx, guild));
    if (!payload) {
      ctx.log.error("the board does not fit a message — keeping the last one");
      return "invalid";
    }
    const id = data.channel.messageIds[board.index];
    if (lastSent.get(id) === hashOf(payload)) return "unchanged";
    try {
      await channel.messages.edit(id, payload);
      lastSent.set(id, hashOf(payload));
      return "edited";
    } catch (err) {
      if (err.code !== D.UNKNOWN_MESSAGE) throw err;
      await repost(ctx, channel, store.load(ctx), blocks, now);
      return "reposted";
    }
  });
}

// The role picker keeps the member's pick on screen until its message is
// re-rendered — editing the static panel resets it for everyone (§3.1).
function resetPanel(ctx) {
  return enqueue(ctx, async () => {
    const data = store.load(ctx);
    if (!data.config) return;
    const block = activeBlocks(data.config).find((b) => b.type === "panel");
    const id = block && data.channel.messageIds[block.index];
    if (!id) return;
    const guild = await D.getGuild(ctx, data.config);
    await D.edit(ctx, data.config.channelId, id, R.renderPanel(data.config, hasRoleIn(guild)));
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
  chain = Promise.resolve();
}

module.exports = { enqueue, activeBlocks, tailCheck, sync, resetPanel, postPing, expirePing, _reset };
