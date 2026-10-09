// The lfg module's REST glue (M4 spec §5.1): threads, plain messages, roles,
// the bot's permissions and the live DM card. Every call is best-effort — a
// REST error is logged and reported as a falsy result, never thrown into an
// action (the state is already saved). The DM card runs on a per-member
// promise queue (§5.2/7), so two events can never leave two cards.
const { ChannelType, MessageFlags, PermissionFlagsBits, ButtonStyle, ComponentType } = require("discord.js");
const S = require("./state");
const R = require("./render");
const store = require("./store");
const { textOf } = require("./texts");

// Discord's CHANNEL_OBFUSCATED flag (changelog 2026-08-12, enforced
// 2026-11-16): a channel the bot cannot view arrives named "___hidden___".
const CHANNEL_OBFUSCATED = 1 << 17;
const DM_CLOSED = 50007; // "Cannot send messages to this user"
const UNKNOWN_MESSAGE = 10008;
const MAX_NEW_SEARCH_DMS = 50;

// What the board channel needs from the bot (§8.2), by name for the log.
const NEEDED = Object.freeze({
  ViewChannel: PermissionFlagsBits.ViewChannel,
  SendMessages: PermissionFlagsBits.SendMessages,
  EmbedLinks: PermissionFlagsBits.EmbedLinks,
  AttachFiles: PermissionFlagsBits.AttachFiles,
  ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory, // the tick's tail check reads the last messages
  CreatePrivateThreads: PermissionFlagsBits.CreatePrivateThreads,
  SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
  ManageThreads: PermissionFlagsBits.ManageThreads,
  ManageRoles: PermissionFlagsBits.ManageRoles,
});

const nowOf = (ctx) => (typeof ctx.now === "function" ? ctx.now() : Date.now());

const isObfuscated = (channel) => (Number(channel?.flags?.bitfield ?? channel?.flags ?? 0) & CHANNEL_OBFUSCATED) !== 0;

async function getGuild(ctx, config) {
  const id = (config && config.guildId) || process.env.GUILD_ID;
  if (!ctx.client || !id) return null;
  try {
    return ctx.client.guilds.cache.get(id) || (await ctx.client.guilds.fetch(id));
  } catch (err) {
    ctx.log.error(`could not fetch the guild: ${err.message}`);
    return null;
  }
}

async function getChannel(ctx, channelId) {
  if (!ctx.client || !channelId) return null;
  try {
    return await ctx.client.channels.fetch(channelId);
  } catch (err) {
    ctx.log.warn(`could not fetch channel ${channelId}: ${err.message}`);
    return null;
  }
}

// The names of the permissions the bot lacks in the board channel; a hidden
// (obfuscated) channel lacks everything. MentionEveryone only when a ping role
// is not mentionable (then only that permission lets the bot ping it).
function missingPermissions(guild, channel, pingRoleIds = []) {
  if (!channel || isObfuscated(channel)) return ["ViewChannel"];
  const me = guild && guild.members && guild.members.me;
  const have = me && typeof channel.permissionsFor === "function" ? channel.permissionsFor(me) : null;
  if (!have) return Object.keys(NEEDED);
  const missing = Object.entries(NEEDED).filter(([, bit]) => !have.has(bit)).map(([name]) => name);
  const unmentionable = pingRoleIds.some((id) => {
    const role = guild.roles && guild.roles.cache.get(id);
    return role && role.mentionable === false;
  });
  if (unmentionable && !have.has(PermissionFlagsBits.MentionEveryone)) missing.push("MentionEveryone");
  return missing;
}

// Live names and avatars from the caches (D6), stored names as fallback.
function lookFor(ctx, guild) {
  return {
    nameOf: (userId, fallback) => {
      const m = guild && guild.members && guild.members.cache.get(userId);
      return (m && m.displayName) || fallback;
    },
    avatarOf: (userId) => {
      const u = ctx.client && ctx.client.users && ctx.client.users.cache.get(userId);
      return (u && typeof u.displayAvatarURL === "function" && u.displayAvatarURL({ size: 128 })) || R.defaultAvatar(userId);
    },
  };
}

// "BASIC · SUP · Dani's search" (≤ 100, Discord's thread-name cap).
function threadName(config, listing) {
  const { label } = S.labelOf(config, listing);
  return `${label} · ${listing.posterName}'s search`.slice(0, 100);
}

// A private thread under the board, with the searcher in it (§3.3/1).
async function openThread(ctx, config, listing) {
  const channel = await getChannel(ctx, config.channelId);
  if (!channel || isObfuscated(channel)) throw new Error("the board channel is not visible to the bot");
  const thread = await channel.threads.create({
    name: threadName(config, listing),
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: 4320, // 3 days: a fixed game may be a day ahead
  });
  await thread.members.add(listing.posterId);
  return thread;
}

async function send(ctx, channelId, payload) {
  const channel = await getChannel(ctx, channelId);
  if (!channel) return null;
  try {
    return await channel.send(payload);
  } catch (err) {
    ctx.log.warn(`could not post in ${channelId}: ${err.message}`);
    return null;
  }
}

async function edit(ctx, channelId, messageId, payload) {
  if (!messageId) return false;
  const channel = await getChannel(ctx, channelId);
  if (!channel) return false;
  try {
    await channel.messages.edit(messageId, payload);
    return true;
  } catch (err) {
    ctx.log.warn(`could not edit ${messageId} in ${channelId}: ${err.message}`);
    return false;
  }
}

async function remove(ctx, channelId, messageId) {
  if (!messageId) return false;
  const channel = await getChannel(ctx, channelId);
  if (!channel) return false;
  try {
    await channel.messages.delete(messageId);
    return true;
  } catch (err) {
    if (err.code !== UNKNOWN_MESSAGE) ctx.log.warn(`could not delete ${messageId} in ${channelId}: ${err.message}`);
    return err.code === UNKNOWN_MESSAGE;
  }
}

async function threadMember(ctx, threadId, userId, op) {
  const thread = await getChannel(ctx, threadId);
  if (!thread || !thread.members) return false;
  try {
    await thread.members[op](userId);
    return true;
  } catch (err) {
    ctx.log.warn(`could not ${op} ${userId} in thread ${threadId}: ${err.message}`);
    return false;
  }
}

// The closing line, then the lock (§3.3/7). The 3-day auto-archive files it.
async function closeThread(ctx, threadId, line) {
  if (!threadId) return;
  await send(ctx, threadId, { content: line, allowedMentions: { parse: [] } });
  const thread = await getChannel(ctx, threadId);
  if (!thread || typeof thread.setLocked !== "function") return;
  try {
    await thread.setLocked(true);
  } catch (err) {
    ctx.log.warn(`could not lock thread ${threadId}: ${err.message}`);
  }
}

// Add / remove roles one by one: one refused role must not stop the others (§8.1).
async function setRoles(ctx, member, { add = [], remove: drop = [] }) {
  const result = { added: [], removed: [], failed: [] };
  for (const [ids, op, bucket] of [[add, "add", "added"], [drop, "remove", "removed"]]) {
    for (const roleId of ids) {
      try {
        await member.roles[op](roleId);
        result[bucket].push(roleId);
      } catch (err) {
        ctx.log.warn(`could not ${op} role ${roleId} for ${member.id}: ${err.message}`);
        result.failed.push(roleId);
      }
    }
  }
  return result;
}

// ── the DM card (§3.6) ─────────────────────────────────────────────────────

// Can the card reach this member right now? (On, and not blocked in the last 24 h.)
function dmReachable(data, userId, now) {
  if (data.prefs[userId] && data.prefs[userId].requestDm === false) return false;
  const card = data.dmCards[userId];
  return !(card && card.blocked && now - (card.since || 0) < S.BLOCK_RETRY_MS);
}

const NOTICE_KINDS = new Set(["accepted", "full", "expired", "cancelled", "posterNoConfirm", "noConfirm"]);

function patch(ctx, fn, log = []) {
  const fresh = store.load(ctx);
  fn(fresh);
  store.commit(ctx, fresh, { log });
}

const cardQueues = new Map();

// Refresh one member's card: `event` = an important event (notifies), null = a
// silent refresh. Runs after every earlier card job of the same member.
function deliverCard(ctx, userId, event = null) {
  const prev = cardQueues.get(userId) || Promise.resolve();
  const job = prev.then(() => deliverNow(ctx, userId, event)).catch((err) => ctx.log.error(`DM card for ${userId} failed:`, err));
  cardQueues.set(userId, job);
  job.finally(() => { if (cardQueues.get(userId) === job) cardQueues.delete(userId); });
  return job;
}

async function deliverNow(ctx, userId, event) {
  const now = nowOf(ctx);
  const data = store.load(ctx);
  const card = data.dmCards[userId];
  const boxEvent = event && S.BOX_KINDS.has(event.kind) ? event : null;
  const toNotice = event && NOTICE_KINDS.has(event.kind);
  if (data.prefs[userId] && data.prefs[userId].requestDm === false) {
    // switched off (Notifications) — the news waits for the next tap
    if (toNotice) patch(ctx, (d) => S.addNotice(d, userId, event, now));
    return "off";
  }
  if (boxEvent) data.dmCards[userId] = { ...(card || {}), event: boxEvent };
  const view = S.cardView(data, userId, now);
  const plan = S.cardPlan(card, { important: !!event, empty: view.empty, now });
  if (plan === "blocked") {
    if (toNotice) patch(ctx, (d) => S.addNotice(d, userId, event, now));
    return "blocked";
  }
  if (plan === "none") return "none";
  const user = ctx.client ? await ctx.client.users.fetch(userId).catch(() => null) : null;
  if (!user) return "nouser";
  const dm = await user.createDM().catch(() => null);
  if (plan === "delete") {
    if (dm) await dm.messages.delete(card.messageId).catch(() => {});
    patch(ctx, (d) => { delete d.dmCards[userId]; }, [{ type: "dm", ts: now, userId, event: "deleted" }]);
    return "deleted";
  }
  const guild = await getGuild(ctx, data.config);
  const payload = R.renderCard(data, userId, view, lookFor(ctx, guild));
  if (!payload) {
    ctx.log.error(`DM card for ${userId} does not fit a message`);
    return "invalid";
  }
  let messageId = card && !card.blocked ? card.messageId : null;
  let outcome = plan === "replace" ? "replaced" : plan === "edit" ? "edited" : "sent";
  if (plan === "edit") {
    try {
      await dm.messages.edit(messageId, { ...payload, flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
      if (err.code !== UNKNOWN_MESSAGE) ctx.log.warn(`could not edit the DM card of ${userId}: ${err.message}`);
      messageId = null; // deleted by hand → a new card (§8.1)
      outcome = "sent";
    }
  }
  if (outcome !== "edited") {
    const silent = plan === "sendSilent" || (plan === "edit" && !event);
    let msg;
    try {
      msg = await user.send({ ...payload, flags: MessageFlags.IsComponentsV2 | (silent ? MessageFlags.SuppressNotifications : 0) });
    } catch (err) {
      if (err.code === DM_CLOSED) {
        patch(ctx, (d) => {
          d.dmCards[userId] = { blocked: true, since: now };
          if (toNotice) S.addNotice(d, userId, event, now);
        }, [{ type: "dm", ts: now, userId, event: "blocked" }]);
        return "blocked";
      }
      ctx.log.warn(`could not send the DM card to ${userId}: ${err.message}`);
      return "failed";
    }
    if (plan === "replace" && messageId && dm) await dm.messages.delete(messageId).catch(() => {});
    messageId = msg.id;
  }
  const notified = outcome !== "edited" && !!event;
  patch(ctx, (d) => {
    const prev = d.dmCards[userId] && !d.dmCards[userId].blocked ? d.dmCards[userId] : {};
    d.dmCards[userId] = {
      messageId,
      sentAt: outcome === "edited" ? prev.sentAt ?? now : now,
      lastEventAt: notified ? now : prev.lastEventAt ?? 0,
      event: boxEvent || prev.event || null,
    };
  }, [{ type: "dm", ts: now, userId, event: outcome }]);
  return outcome;
}

// ── new-search DMs (§5.5) ──────────────────────────────────────────────────

// Opted-in members who hold one of the button's ping roles, ≤ 50, in order;
// a closed DM is skipped. Returns how many went out.
async function dmNewSearch(ctx, listingId) {
  const data = store.load(ctx);
  const listing = S.findListing(data, listingId);
  if (!listing) return 0;
  const targets = new Set(S.pingTargets(data.config, listing));
  const guild = await getGuild(ctx, data.config);
  if (!guild || targets.size === 0) return 0;
  const { label } = S.labelOf(data.config, listing);
  const link = data.config.guildId ? `https://discord.com/channels/${data.config.guildId}/${data.config.channelId}` : "";
  const payload = {
    content: textOf(data.config, "newSearchDm", { poster: listing.posterName, label, when: listing.startAt ? `<t:${Math.floor(listing.startAt / 1000)}:R>` : "now", link }),
    components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: `lfg:join:${listing.id}`, label: textOf(data.config, "joinButton") }] }],
    allowedMentions: { parse: [] },
  };
  let sent = 0;
  for (const userId of S.dmCandidates(data, listing)) {
    if (sent >= MAX_NEW_SEARCH_DMS) break;
    try {
      const member = guild.members.cache.get(userId) || (await guild.members.fetch(userId));
      if (![...member.roles.cache.keys()].some((id) => targets.has(id))) continue;
      await member.send(payload);
      sent += 1;
    } catch {
      // left the server, or DMs closed — skip (§5.5)
    }
  }
  if (sent > 0) patch(ctx, (d) => { const l = S.findListing(d, listingId); if (l) l.dmCount += sent; });
  return sent;
}

module.exports = {
  CHANNEL_OBFUSCATED,
  DM_CLOSED,
  UNKNOWN_MESSAGE,
  NEEDED,
  nowOf,
  isObfuscated,
  getGuild,
  getChannel,
  missingPermissions,
  lookFor,
  threadName,
  openThread,
  send,
  edit,
  remove,
  threadMember,
  closeThread,
  setRoles,
  dmReachable,
  deliverCard,
  dmNewSearch,
};
