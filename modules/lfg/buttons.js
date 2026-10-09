// The lfg: button, select and modal handlers (M4 spec §5.1): the channel
// panel (Start a search, Pick your roles…), the board (Join), the thread
// (Accept, I'm here, Cancel search), the DM card (Cancel, Join, Cancel all,
// I'm here, Start a search) and the start modal's submit.
// Pattern: run the synchronous action FIRST (it decides), then acknowledge
// (reply / update / defer — inside the 3-second window), then await the
// action's effects (REST) — also when the acknowledgement failed (ackThen).
// customId = "lfg:<action>:<param>".
const { ButtonStyle, ComponentType, MessageFlags } = require("discord.js");
const A = require("./actions");
const C = require("./channel");
const D = require("./discord");
const R = require("./render");
const S = require("./state");
const store = require("./store");
const lfgMenu = require("./menu");
const { textOf } = require("./texts");
const { buildScreenPayload, screenErrors, text } = require("../../core/panel");

const EPHEMERAL = MessageFlags.Ephemeral;

function actorOf(interaction, ctx) {
  return {
    userId: interaction.user.id,
    displayName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
    level: ctx.perms ? ctx.perms.levelOfInteraction(interaction) : "member",
  };
}

const button = (customId, label, style = ButtonStyle.Secondary) => ({ type: ComponentType.Button, style, custom_id: customId, label });

// A plain ephemeral answer, optionally with one row of buttons.
function answer(content, buttons = []) {
  return {
    content,
    flags: EPHEMERAL,
    components: buttons.length ? [{ type: ComponentType.ActionRow, components: buttons }] : [],
    allowedMentions: { parse: [] },
  };
}

async function runEffects(ctx, r) {
  if (!r || typeof r.effects !== "function") return undefined;
  try {
    return await r.effects();
  } catch (err) {
    ctx.log.error("follow-up work failed:", err);
    return undefined;
  }
}

// Acknowledge, then the effects — which run even if the acknowledgement
// fails (the action is already saved; core/menu.js runAfter does the same).
async function ackThen(ctx, ack, r) {
  let result;
  try {
    await ack();
  } catch (err) {
    ctx.log.error("could not answer the interaction:", err);
  } finally {
    result = await runEffects(ctx, r);
  }
  return result;
}

// Waiting news (closed / switched-off DMs) as lines to put above an answer.
function newsFor(ctx, interaction) {
  const r = A.consumeNotices(ctx, actorOf(interaction, ctx));
  return r.notices.length ? R.noticeText(store.load(ctx).config, r.notices) : "";
}
const withNews = (news, line) => [news, line].filter(Boolean).join("\n");

const fromEphemeral = (interaction) => !!(interaction.message && interaction.message.flags && typeof interaction.message.flags.has === "function" && interaction.message.flags.has(EPHEMERAL));
const inDm = (interaction) => !interaction.guildId;

// Answer a write that came from a message the member owns a view of: an
// ephemeral answer is replaced in place, the DM card just acknowledges (the
// card re-renders itself), anything else gets a fresh ephemeral line.
async function ackWrite(interaction, line) {
  if (fromEphemeral(interaction)) return interaction.update({ content: line, components: [], allowedMentions: { parse: [] } });
  if (inDm(interaction)) return interaction.deferUpdate();
  return interaction.reply(answer(line));
}

// ── handlers ───────────────────────────────────────────────────────────────

async function start(interaction, ctx) {
  const data = store.load(ctx);
  if (!data.config) return interaction.reply(answer(textOf(null, "notSetUp")));
  // busy first: a started own search is busy, and its Cancel would only fail
  if (S.isBusy(data, interaction.user.id)) return interaction.reply(answer(textOf(data.config, "busy")));
  const own = S.ownListing(data, interaction.user.id);
  if (own) return interaction.reply(answer(textOf(data.config, "hasSearch"), [button(`lfg:cancel:${own.id}`, textOf(data.config, "cancelMySearch"), ButtonStyle.Danger)]));
  // the guild from the cache only (a DM card's Start has no interaction.guild); a modal cannot wait
  const guild = interaction.guild || D.cachedGuild(ctx, data.config);
  return interaction.showModal(R.startModal(data, interaction.user.id, D.hasEmojiIn(guild)));
}

// A select inside a modal Label; absent (no favorites) or empty → null.
function selected(fields, customId) {
  try {
    const values = fields.getStringSelectValues(customId);
    return values && values.length ? values[0] : null;
  } catch {
    return null;
  }
}
function typed(fields, customId) {
  try {
    return fields.getTextInputValue(customId);
  } catch {
    return "";
  }
}

async function modal(interaction, ctx) {
  const f = interaction.fields;
  const r = A.createListing(ctx, actorOf(interaction, ctx), {
    favoriteId: selected(f, "favorite"),
    lookingFor: selected(f, "lookingfor"),
    minutes: typed(f, "minutes"),
    note: typed(f, "note"),
  });
  if (!r.ok) {
    const buttons = r.code === "duplicate" ? [button(`lfg:cancel:${r.listingId}`, textOf(store.load(ctx).config, "cancelMySearch"), ButtonStyle.Danger)] : [];
    return interaction.reply(answer(r.error, buttons));
  }
  // No "your search is live" answer (live test round 2): the new thread is the
  // answer. Every start modal comes from a component (the channel panel, the
  // DM card, /menu New search), so the submit is acknowledged with
  // deferUpdate — the message it came from stays as it is. Then the thread
  // (afterCreate), and only a failure gets a line (followUp, ephemeral); then
  // the followUp work (ping, board, new-search DMs) — a failed answer never
  // skips the thread or the ping. A modal not from a message (none today)
  // falls back to a deferred ephemeral reply that is deleted on success.
  const fromMessage = typeof interaction.isFromMessage === "function" ? interaction.isFromMessage() : true;
  const ack = fromMessage ? () => interaction.deferUpdate() : () => interaction.deferReply({ flags: EPHEMERAL });
  const after = await ackThen(ctx, ack, r);
  try {
    if (!after || !after.ok) {
      const line = (after && after.error) || textOf(store.load(ctx).config, "threadFailed");
      const payload = { content: withNews(newsFor(ctx, interaction), line), allowedMentions: { parse: [] } };
      if (fromMessage) await interaction.followUp({ ...payload, flags: EPHEMERAL });
      else await interaction.editReply(payload);
    } else if (!fromMessage) {
      await interaction.deleteReply();
    }
  } catch (err) {
    ctx.log.error("could not answer the interaction:", err);
  } finally {
    if (after && typeof after.followUp === "function") {
      try {
        await after.followUp();
      } catch (err) {
        ctx.log.error("follow-up work failed:", err);
      }
    }
  }
}

async function join(interaction, ctx, listingId) {
  const r = A.join(ctx, actorOf(interaction, ctx), { listingId });
  const config = store.load(ctx).config;
  const news = newsFor(ctx, interaction);
  if (!r.ok) return interaction.reply(answer(withNews(news, r.error)));
  const poster = R.esc(r.listing.posterName);
  if (r.already) {
    const line = r.status === "accepted" ? textOf(config, "alreadyAccepted", { poster }) : textOf(config, "alreadyRequested", { poster, n: r.position });
    return interaction.reply(answer(withNews(news, line), r.status === "pending" ? [button(`lfg:withdraw:${listingId}`, textOf(config, "cancelRequest"))] : []));
  }
  const line = textOf(config, r.dmOk ? "requestSent" : "requestSentNoDm", { poster, n: r.position });
  return ackThen(ctx, () => interaction.reply(answer(withNews(news, line), [button(`lfg:withdraw:${listingId}`, textOf(config, "cancelRequest"))])), r);
}

async function accept(interaction, ctx, param) {
  const [listingId, userId] = String(param).split(":");
  const r = A.accept(ctx, actorOf(interaction, ctx), { listingId, userId });
  if (!r.ok) return interaction.reply(answer(r.error));
  return ackThen(ctx, () => interaction.deferUpdate(), r); // the panel re-renders itself (effects)
}

async function here(interaction, ctx, listingId) {
  const r = A.checkIn(ctx, actorOf(interaction, ctx), { listingId });
  const config = store.load(ctx).config;
  if (!r.ok) return interaction.reply(answer(r.error));
  if (r.result === "already") return interaction.reply(answer(textOf(config, "hereAlready")));
  return ackThen(ctx, () => interaction.deferUpdate(), r); // the confirm box re-renders where it was tapped
}

async function withdraw(interaction, ctx, listingId) {
  const r = A.withdraw(ctx, actorOf(interaction, ctx), { listingId });
  if (!r.ok) return interaction.reply(answer(r.error));
  return ackThen(ctx, () => ackWrite(interaction, textOf(store.load(ctx).config, "requestCancelled")), r);
}

async function withdrawall(interaction, ctx) {
  const r = A.withdrawAll(ctx, actorOf(interaction, ctx));
  if (!r.ok) return interaction.reply(answer(r.error));
  return ackThen(ctx, () => ackWrite(interaction, textOf(store.load(ctx).config, "requestsCancelled", { n: r.count })), r);
}

async function cancel(interaction, ctx, listingId) {
  const r = A.cancelListing(ctx, actorOf(interaction, ctx), { listingId });
  if (!r.ok) return interaction.reply(answer(r.error));
  return ackThen(ctx, () => ackWrite(interaction, textOf(store.load(ctx).config, "searchCancelled")), r);
}

// "Pick your roles…" on the channel panel (§3.1; custom_id lfg:roles:<render
// tag> — the tag is ignored): a TOGGLE (a public message cannot show anyone's
// current roles), answered with the ephemeral V2 Menu › Teammates › My roles
// screen — its menu:lfg: buttons then work through the core menu like any
// menu screen. The panel is re-sent so the pick does not stay on screen.
// The role REST is slow, so the defer is the acknowledgement and the whole
// change is the "effects" of ackThen: it still runs if the defer failed.
// Only the Guilds intent: the member role CACHE is never refreshed after a
// REST change. The toggle decision therefore uses the interaction's own member
// (fresh per interaction), and the screen shows (held ∪ added) − removed from
// the action result — the same as menu.js.
async function roles(interaction, ctx /* , tag — ignored */) {
  const guild = interaction.guild;
  // The reply is deferred, so it must always be edited: a screen that cannot
  // be built (or does not validate) becomes a plain line instead of leaving
  // "thinking…" on screen (runEffects would only log the throw).
  const FALLBACK = { content: "Something went wrong showing your roles. Open Menu › Teammates › My roles to check them.", components: [], allowedMentions: { parse: [] } };
  const change = async () => {
    try {
      let payload;
      try {
        const member = await lfgMenu.memberOf(interaction, interaction.user.id);
        const r = await A.setSubscriptions(ctx, actorOf(interaction, ctx), {
          member,
          picked: interaction.values,
          mode: "toggle",
          roleExists: (id) => !guild || guild.roles.cache.has(id),
        });
        const data = store.load(ctx);
        const notice = r.ok ? lfgMenu.subscriptionNotice(guild, r) : { ok: false, text: r.error };
        let held;
        if (r.ok && member) {
          held = new Set(member.roles.cache.keys());
          for (const id of r.added) held.add(id);
          for (const id of r.removed) held.delete(id);
        }
        const screen = data.config
          ? lfgMenu.rolesScreen(data, member, guild, notice, held)
          : { crumbs: ["Menu", "Teammates"], notice, body: [], back: "menu:lfg:main" };
        const news = newsFor(ctx, interaction);
        if (news) screen.body = [text(news), ...screen.body];
        const built = buildScreenPayload(screen);
        const errors = screenErrors(screen, built);
        if (errors.length) throw new Error(`invalid My roles screen: ${errors.join("; ")}`);
        payload = { ...built, flags: MessageFlags.IsComponentsV2 };
      } catch (err) {
        ctx.log.error("[lfg] could not build the My roles screen:", err);
        payload = FALLBACK;
      }
      try {
        await interaction.editReply(payload);
      } catch (err) {
        ctx.log.error("could not answer the interaction:", err);
        if (payload !== FALLBACK) await interaction.editReply(FALLBACK).catch(() => {});
      }
    } finally {
      await C.resetPanel(ctx);
    }
  };
  return ackThen(ctx, () => interaction.deferReply({ flags: EPHEMERAL }), { effects: change });
}

// A segment's count badge is a disabled button — it never arrives; if a
// client sends it anyway, acknowledge silently.
const badge = (interaction) => interaction.deferUpdate();

module.exports = {
  actorOf,
  answer,
  components: { start, join, accept, here, withdraw, withdrawall, cancel, roles, badge },
  modals: { modal },
};
