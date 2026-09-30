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

module.exports = { MAX_NOTE, needHelp, sorted, closeAll, setNote };
