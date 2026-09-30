// Help-board actions, independent of any Discord interaction (M2 spec §5):
//   action(ctx, actor, args) → { ok: true, …result, effects? } | { ok: false, code, error }
// The slash commands, the /menu screens and (from M3) the web admin all call
// these, so the three surfaces cannot drift apart.
//
// ctx:   the platform ctx — only ctx.client is used (by `effects`).
// actor: { userId, displayName, level: "member" | "officer" | "owner" }.
// codes: forbidden | invalid | duplicate | not_found | rest.
//
// Concurrency invariant (CHANGES.md #1): every action runs loadData() → mutate
// → saveData() synchronously. Slow REST (request card, board refresh, DM) is
// returned as `effects`, which the caller awaits AFTER acknowledging the
// interaction (the 3-second window). repostBoard is the one async action: it
// is REST by nature, so the caller defers first; it re-loads before saving.
const help = require("./help");
const { atLeast } = require("../../core/perms");

const MAX_NOTE = 200;

const NEED = {
  member: "You can't do that.",
  officer: "You need the Manage Server permission or a manager role to do that.",
  owner: "Only members with Manage Server can change bot settings.",
};

function fail(code, error) {
  return { ok: false, code, error };
}

// The action's own permission check — menu/button filtering is only a convenience.
function gate(actor, min) {
  return atLeast(actor && actor.level, min) ? null : fail("forbidden", NEED[min]);
}

function needHelp(ctx, actor, { categoryId, note = "", channelId = null } = {}) {
  const denied = gate(actor, "member");
  if (denied) return denied;
  const data = help.loadData();
  const cat = help.categoryMap(data)[categoryId];
  if (!cat || cat.archived) return fail("invalid", "That isn't an active category. Pick one from the list.");
  const category = help.catOf(data, categoryId);
  if (help.hasOpenEntry(data, actor.userId, categoryId)) {
    return fail("duplicate", `You're already on the board for ${category.label}.`);
  }
  const entry = help.newHelpEntry(actor.userId, actor.displayName, categoryId, note);
  data.entries.push(entry);
  help.saveData(data);
  return { ok: true, entry, category, effects: () => help.announceEntry(ctx.client, entry, channelId) };
}

function closeOwn(ctx, data, mine) {
  help.closeEntries(data, mine, "self", Date.now());
  help.saveData(data);
  return {
    ok: true,
    closed: mine,
    effects: async () => {
      for (const e of mine) await help.resolveCard(ctx.client, e, `✅ ${e.username} marked themselves sorted`);
      await help.refreshBoard(ctx.client, data);
    },
  };
}

// Self-service close ("I'm sorted"): only ever the actor's OWN open entries —
// ids coming from a select are never trusted on their own.
function sorted(ctx, actor, { entryIds, categoryId } = {}) {
  const denied = gate(actor, "member");
  if (denied) return denied;
  const data = help.loadData();
  let mine;
  if (categoryId !== undefined) {
    if (!help.categoryMap(data)[categoryId]) return fail("invalid", "That isn't a known category. Pick one from the list.");
    mine = data.entries.filter((e) => e.userId === actor.userId && !e.done && e.category === categoryId);
  } else {
    const ids = new Set(entryIds || []);
    mine = data.entries.filter((e) => ids.has(e.id) && e.userId === actor.userId && !e.done);
  }
  if (mine.length === 0) return fail("not_found", "Those requests are already closed.");
  return closeOwn(ctx, data, mine);
}

function closeAll(ctx, actor) {
  const denied = gate(actor, "member");
  if (denied) return denied;
  const data = help.loadData();
  const mine = help.openEntriesFor(data, actor.userId);
  if (mine.length === 0) return fail("not_found", "You have no open requests.");
  return closeOwn(ctx, data, mine);
}

// "Add note" after a tap-first request: the actor's own open entry only.
function setNote(ctx, actor, { entryId, note } = {}) {
  const denied = gate(actor, "member");
  if (denied) return denied;
  const text = String(note ?? "").trim();
  if (text.length > MAX_NOTE) return fail("invalid", `Keep the note to ${MAX_NOTE} characters or fewer.`);
  const data = help.loadData();
  const entry = data.entries.find((e) => e.id === entryId && e.userId === actor.userId && !e.done);
  if (!entry) return fail("not_found", "That request was already closed.");
  entry.note = text;
  help.saveData(data);
  return {
    ok: true,
    entry,
    effects: async () => {
      await help.rerenderCard(ctx.client, data, entry);
      await help.refreshBoard(ctx.client, data);
    },
  };
}

// Officer resolve target: by entry id (panels, menu) or by member + category
// (the /helped and /remove fast path). Only OPEN entries count, so a double
// tap on an already-closed entry finds nothing and writes no second record.
function findOpen(data, { entryId, userId, categoryId }) {
  if (entryId !== undefined) return { entry: data.entries.find((e) => e.id === entryId && !e.done) };
  if (!help.categoryMap(data)[categoryId]) {
    return { error: fail("invalid", "That isn't a known category. Pick one from the list.") };
  }
  return { entry: data.entries.find((e) => e.userId === userId && e.category === categoryId && !e.done) };
}

// Shared shape of helped/remove: gate → find the open entry → `resolve` (logs
// the record, then saveData — no await in between) → the REST `effects`.
function officerResolve(ctx, actor, args, resolve, effects) {
  const denied = gate(actor, "officer");
  if (denied) return denied;
  const data = help.loadData();
  const { entry, error } = findOpen(data, args);
  if (error) return error;
  if (!entry) return fail("not_found", "That request was already closed.");
  resolve(data, entry);
  help.saveData(data);
  return { ok: true, entry, category: help.catOf(data, entry.category), effects: () => effects(data, entry) };
}

function helped(ctx, actor, args = {}) {
  return officerResolve(
    ctx,
    actor,
    args,
    (data, entry) => help.resolveEntryAsSorted(data, entry, actor.userId, Date.now()),
    async (data, entry) => {
      await help.resolveCard(ctx.client, entry, `✅ Sorted by ${actor.displayName}`);
      await help.dmSorted(ctx.client, data, entry.userId, entry.category);
      await help.refreshBoard(ctx.client, data);
    }
  );
}

function remove(ctx, actor, args = {}) {
  return officerResolve(
    ctx,
    actor,
    args,
    (data, entry) => help.resolveEntryAsRemoved(data, entry, Date.now()),
    async (data, entry) => {
      await help.resolveCard(ctx.client, entry, `🗑️ Removed by ${actor.displayName}`);
      await help.refreshBoard(ctx.client, data);
    }
  );
}

// Post the live board in `channel`, pin it and retire the previous one. REST
// by nature, so it is async and the caller defers first; the rendering
// snapshot is read-only and the board ids are saved on a FRESH load
// (invariant #1).
async function repostBoard(ctx, actor, { channel } = {}) {
  const denied = gate(actor, "officer");
  if (denied) return denied;
  if (!channel || typeof channel.send !== "function") return fail("invalid", "I can't post the board in this channel.");
  const data = help.loadData();
  const names = await help.resolveNames(channel.guild, data);
  let message;
  try {
    message = await channel.send({ embeds: [help.buildBoardEmbed(data, names)], components: [help.needHelpRow()] });
  } catch (err) {
    console.error("Could not post the board:", err?.message ?? err);
    return fail("rest", "I couldn't post the board here — check my permissions in this channel.");
  }
  // Pinning needs the separate "Pin Messages" permission. Non-fatal, but never
  // claim a pin we didn't get.
  let pinned = true;
  try {
    await message.pin();
  } catch (e) {
    pinned = false;
    console.error("Could not pin the board (bot needs Pin Messages):", e?.message ?? e);
  }
  // Retire the previous board, if any, so we don't leave a stale pinned copy.
  if (data.boardChannelId && data.boardMessageId && data.boardMessageId !== message.id) {
    try {
      const oldChannel = await ctx.client.channels.fetch(data.boardChannelId);
      const oldMessage = await oldChannel.messages.fetch(data.boardMessageId);
      await oldMessage.unpin().catch(() => {});
      await oldMessage
        .edit({ content: "_This board has been retired; a newer one was posted._", embeds: [], components: [] })
        .catch(() => {});
    } catch {
      // old message already gone — nothing to retire
    }
  }
  const fresh = help.loadData();
  fresh.boardChannelId = channel.id;
  fresh.boardMessageId = message.id;
  help.saveData(fresh);
  return { ok: true, pinned, message };
}

module.exports = { MAX_NOTE, needHelp, sorted, closeAll, setNote, helped, remove, repostBoard };
