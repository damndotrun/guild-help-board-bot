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
const DM_RATE_LIMITED = 40003; // "You are opening direct messages too fast"
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

// A best-effort job some time later (a transient line's delete). The
// seam: ctx.setTimer(fn, ms) when the ctx has one (tests); else an unref'd
// setTimeout (it never keeps the process alive). Errors are logged. A restart
// loses the timer — every such job has a tick-side backstop.
function later(ctx, ms, fn) {
  const run = () => Promise.resolve().then(fn).catch((err) => ctx.log.error("timer job failed:", err));
  if (typeof ctx.setTimer === "function") return ctx.setTimer(run, ms);
  const t = setTimeout(run, ms);
  if (t && typeof t.unref === "function") t.unref();
  return t;
}

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

// The guild from the cache only — for a tap that must answer at once (a
// modal cannot wait for a fetch); null when it is not cached.
function cachedGuild(ctx, config) {
  const id = (config && config.guildId) || process.env.GUILD_ID;
  return (ctx.client && id && ctx.client.guilds.cache.get(id)) || null;
}

// Is this custom emoji still in the guild? A configured custom emoji the guild
// lost makes Discord refuse the whole message / modal (50035 Invalid emoji),
// so render.optionEmoji drops it. No guild / no emoji cache = present.
const hasEmojiIn = (guild) => (id) => !guild || !guild.emojis || !guild.emojis.cache || guild.emojis.cache.has(id);

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
  // ManageRoles is a guild-level permission: a channel overwrite can neither
  // grant nor deny it, so it is read from the bot's guild permissions.
  const guildHas = (bit) => !!(me.permissions && me.permissions.has(bit));
  const missing = Object.entries(NEEDED)
    .filter(([, bit]) => !(bit === PermissionFlagsBits.ManageRoles ? guildHas(bit) : have.has(bit)))
    .map(([name]) => name);
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
  try {
    await thread.members.add(listing.posterId);
  } catch (err) {
    // an empty thread nobody can see would linger: take it down, then fail the search
    await thread.delete().catch((delErr) => ctx.log.warn(`could not delete the half-opened thread ${thread.id}: ${delErr.message}`));
    throw err;
  }
  // The "BB Bot added X to the thread" system line (RecipientAdd) stays:
  // Discord refuses to delete system messages (50021 — live test round 2).
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

// A finished search's thread (§3.3/7): locked, then archived right away (live
// test round 2, item E — needs Manage Threads, already required). The closing
// line is in the thread message (effects). → true when it was archived.
async function closeThread(ctx, threadId) {
  if (!threadId) return false;
  const thread = await getChannel(ctx, threadId);
  if (!thread) return false;
  if (typeof thread.setLocked === "function") {
    try {
      await thread.setLocked(true);
    } catch (err) {
      ctx.log.warn(`could not lock thread ${threadId}: ${err.message}`);
    }
  }
  return archive(ctx, thread);
}

// A played game's thread, archiveAfterMin after the start: archived, NOT
// locked (a new message unarchives it). → true when it was archived.
async function archiveThread(ctx, threadId) {
  if (!threadId) return false;
  const thread = await getChannel(ctx, threadId);
  return thread ? archive(ctx, thread) : false;
}

async function archive(ctx, thread) {
  if (typeof thread.setArchived !== "function") return false;
  try {
    await thread.setArchived(true);
    return true;
  } catch (err) {
    ctx.log.warn(`could not archive thread ${thread.id}: ${err.message}`);
    return false;
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
function queueCardJob(ctx, userId, run) {
  const prev = cardQueues.get(userId) || Promise.resolve();
  const job = prev.then(run).catch((err) => ctx.log.error(`DM card for ${userId} failed:`, err));
  cardQueues.set(userId, job);
  job.finally(() => { if (cardQueues.get(userId) === job) cardQueues.delete(userId); });
  return job;
}

function deliverCard(ctx, userId, event = null) {
  return queueCardJob(ctx, userId, () => deliverNow(ctx, userId, event));
}

// A stale card (24 h; the tick already dropped its record) goes off the same
// per-member queue, so it never overtakes or interleaves with a live card job.
// Old cards a replace could not delete (staleIds) get their last try here.
function deleteStaleCard(ctx, userId, messageId, staleIds = []) {
  return queueCardJob(ctx, userId, async () => {
    const ids = [...(Array.isArray(staleIds) ? staleIds : []), messageId].filter(Boolean);
    if (!ctx.client || ids.length === 0) return "none";
    const user = await ctx.client.users.fetch(userId).catch(() => null);
    const dm = user && (await user.createDM().catch(() => null));
    if (!dm) return "nodm";
    for (const id of ids) await deleteCardMessage(ctx, dm, userId, id);
    return "deleted";
  });
}

// Delete a card message → true when it is gone (deleted, or already gone:
// 10008); anything else is logged and false.
async function deleteCardMessage(ctx, dm, userId, messageId) {
  try {
    await dm.messages.delete(messageId);
    return true;
  } catch (err) {
    if (err.code === UNKNOWN_MESSAGE) return true;
    ctx.log.warn(`could not delete the old DM card of ${userId}: ${err.message}`);
    return false;
  }
}

// Retry the old cards a replace left behind; returns the ids still there.
async function retryStale(ctx, dm, userId, staleIds) {
  const left = [];
  for (const id of staleIds) if (!(await deleteCardMessage(ctx, dm, userId, id))) left.push(id);
  return left;
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
  const user = ctx.client
    ? await ctx.client.users.fetch(userId).catch((err) => {
      ctx.log.warn(`could not fetch user ${userId} for the DM card: ${err.message}`);
      return null;
    })
    : null;
  if (!user) return "nouser";
  const dm = await user.createDM().catch((err) => {
    ctx.log.warn(`could not open the DM channel of ${userId}: ${err.message}`);
    return null;
  });
  // old cards an earlier replace could not delete: retried first (§5.2/7)
  const hadStale = card && Array.isArray(card.staleIds) ? card.staleIds : [];
  let stale = dm && hadStale.length ? await retryStale(ctx, dm, userId, hadStale) : hadStale;
  const guild = await getGuild(ctx, data.config);
  const payload = R.renderCard(data, userId, view, lookFor(ctx, guild));
  if (!payload) {
    ctx.log.error(`DM card for ${userId} does not fit a message`);
    return "invalid";
  }
  let messageId = card && !card.blocked ? card.messageId : null;
  let outcome = plan === "replace" ? "replaced" : plan === "edit" ? "edited" : "sent";
  // an existing card cannot be touched without the DM channel — and a new one
  // beside it would make two (§5.2/7): already logged, state untouched, retry next time
  if (!dm && messageId && (plan === "edit" || plan === "replace")) return "failed";
  if (plan === "edit") {
    try {
      await dm.messages.edit(messageId, { ...payload, flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
      if (err.code !== UNKNOWN_MESSAGE) {
        // not "deleted by hand": the old card may well still be there — sending a
        // new one now could leave two (§5.2/7). Leave the state, retry next time.
        ctx.log.warn(`could not edit the DM card of ${userId}: ${err.message}`);
        return "failed";
      }
      if (view.empty) {
        // deleted by hand with nothing left to show: no new empty card, just forget it
        patch(ctx, (d) => { delete d.dmCards[userId]; }, [{ type: "dm", ts: now, userId, event: "deleted" }]);
        return "deleted";
      }
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
        // the old card (if any) must not outlive the block record
        if (dm && messageId) await deleteCardMessage(ctx, dm, userId, messageId);
        patch(ctx, (d) => {
          // un-deletable old cards stay on record for a later retry
          d.dmCards[userId] = { blocked: true, since: now, ...(stale.length ? { staleIds: stale } : {}) };
          if (toNotice) S.addNotice(d, userId, event, now);
        }, [{ type: "dm", ts: now, userId, event: "blocked" }]);
        return "blocked";
      }
      ctx.log.warn(`could not send the DM card to ${userId}: ${err.message}`);
      return "failed";
    }
    if (plan === "replace" && messageId && dm && !(await deleteCardMessage(ctx, dm, userId, messageId))) {
      // the old card could not go: keep its id for a retry, and strip its
      // buttons now so two live cards never coexist (§5.2/7)
      stale = [...stale, messageId];
      await dm.messages.edit(messageId, R.renderCardReplaced(data.config))
        .catch((err) => ctx.log.warn(`could not retire the old DM card of ${userId}: ${err.message}`));
    }
    messageId = msg.id;
  }
  const notified = outcome !== "edited" && !!event;
  patch(ctx, (d) => {
    const prev = d.dmCards[userId] && !d.dmCards[userId].blocked ? d.dmCards[userId] : {};
    const activeAt = view.empty ? now : prev.activeAt;
    d.dmCards[userId] = {
      messageId,
      sentAt: outcome === "edited" ? prev.sentAt ?? now : now,
      lastEventAt: notified ? now : prev.lastEventAt ?? 0,
      // the accepted view shows no box — and an old one must not come back after it (B4)
      event: view.accepted ? null : boxEvent || prev.event || null,
      // the empty state counts as activity: the 24 h until the prune start here (§3.6)
      ...(activeAt ? { activeAt } : {}),
      ...(stale.length ? { staleIds: stale } : {}),
    };
    // the accepted view has no box: bad news about another search goes to the menu (📬) instead
    if (view.accepted && boxEvent) S.addNotice(d, userId, boxEvent, now);
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
  const link = `https://discord.com/channels/${guild.id}/${data.config.channelId}`;
  const payload = {
    content: textOf(data.config, "newSearchDm", { poster: R.esc(listing.posterName), label, when: listing.startAt ? `<t:${Math.floor(listing.startAt / 1000)}:R>` : "now", link }),
    components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: `lfg:join:${listing.id}`, label: textOf(data.config, "joinButton") }] }],
    allowedMentions: { parse: [] },
  };
  let sent = 0;
  for (const userId of S.dmCandidates(data, listing)) {
    if (sent >= MAX_NEW_SEARCH_DMS) break;
    try {
      // REST, not the cache: with only the Guilds intent cached roles go stale (§5.5)
      const member = await guild.members.fetch({ user: userId, force: true });
      if (![...member.roles.cache.keys()].some((id) => targets.has(id))) continue;
      await member.send(payload);
      sent += 1;
    } catch (err) {
      // Discord's "opening DMs too fast" (40003): every further DM of this
      // batch would hit it too — stop here, one log line
      if (err && err.code === DM_RATE_LIMITED) {
        ctx.log.warn(`new-search DMs for ${listingId} stopped after ${sent}: opening DMs too fast (40003)`);
        break;
      }
      // left the server, or DMs closed (50007) — skip this member (§5.5)
    }
  }
  if (sent > 0) patch(ctx, (d) => { const l = S.findListing(d, listingId); if (l) l.dmCount += sent; });
  return sent;
}

module.exports = {
  CHANNEL_OBFUSCATED,
  DM_CLOSED,
  DM_RATE_LIMITED,
  UNKNOWN_MESSAGE,
  NEEDED,
  nowOf,
  later,
  isObfuscated,
  getGuild,
  cachedGuild,
  hasEmojiIn,
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
  archiveThread,
  setRoles,
  dmReachable,
  deliverCard,
  deleteStaleCard,
  dmNewSearch,
};
