// Guild Help Board — Discord bot
// Tracks who needs help with Season Run 5K / MVP 5K for season rewards,
// and lets officers mark them as sorted once helped.
// Platform module "help" (modules/help/index.js is its contract). The platform
// core (../../index.js) owns the Client, the router and command registration.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  RoleSelectMenuBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// data.json lives in the platform DATA_DIR (default: the repo root, as before
// the move into modules/help/) — see core/config.js.
const { DATA_DIR } = require("../../core/config");
const { computeLevel } = require("../../core/perms");

// ./actions requires this file, so it is loaded lazily (at call time) to keep
// the require graph acyclic.
function actions() {
  return require("./actions");
}
const DATA_FILE = path.join(DATA_DIR, "data.json");
const TMP_FILE = path.join(DATA_DIR, "data.json.tmp");
const BAK_FILE = path.join(DATA_DIR, "data.json.bak");
const BAK_TMP_FILE = path.join(DATA_DIR, "data.json.bak.tmp");

// ---------- storage ----------
// The two categories the bot shipped with. Private — always handed out as a
// deep copy so a later add/archive never mutates this const.
const DEFAULT_CATEGORIES = [
  { id: "seasonrun5k", label: "Season Run 5K", emoji: "🏃", archived: false },
  { id: "mvp5k", label: "MVP 5K", emoji: "⭐", archived: false },
];
function defaultCategories() {
  return DEFAULT_CATEGORIES.map((c) => ({ ...c }));
}

function categoryMap(data) {
  const map = {};
  for (const c of data.categories || []) map[c.id] = c;
  return map;
}
function activeCategories(data) {
  return (data.categories || []).filter((c) => !c.archived);
}
function countByCategory(entries) {
  const out = {};
  for (const e of entries) out[e.category] = (out[e.category] || 0) + 1;
  return out;
}

// ---------- category CRUD ----------

function slugify(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

const MAX_LABEL = 60;
const MAX_ACTIVE_CATEGORIES = 25;

// Upsert by NORMALIZED LABEL (seeded ids like "seasonrun5k" are not slugify of
// their labels, so matching on computed id alone would append a duplicate).
function addCategory(data, label, emoji) {
  const id = slugify(label);
  if (!id) return { ok: false, error: "Give the category a name with letters or numbers." };
  if (label.length > MAX_LABEL)
    return { ok: false, error: `Category name must be ${MAX_LABEL} characters or fewer.` };
  if (emoji && emoji.length > 32)
    return { ok: false, error: "Emoji must be 32 characters or fewer." };
  const cats = data.categories || (data.categories = []);
  const existing = cats.find((c) => c.id === id || slugify(c.label) === id);
  if (existing) {
    if (existing.archived && cats.filter((c) => !c.archived).length >= MAX_ACTIVE_CATEGORIES)
      return { ok: false, error: `You can have at most ${MAX_ACTIVE_CATEGORIES} active categories.` };
    existing.label = label;
    existing.emoji = emoji || existing.emoji || "📌";
    existing.archived = false;
    return { ok: true, category: existing };
  }
  const activeCount = cats.filter((c) => !c.archived).length;
  if (activeCount >= MAX_ACTIVE_CATEGORIES)
    return { ok: false, error: `You can have at most ${MAX_ACTIVE_CATEGORIES} active categories.` };
  const category = { id, label, emoji: emoji || "📌", archived: false };
  cats.push(category);
  return { ok: true, category };
}

// Archive a category. If it has open (pending) entries, moveto is required and
// must be a different active category: reassign those entries, but DROP any that
// would duplicate a user's existing open entry in moveto. Never removes the last
// active category. Mutates data; returns which entries moved vs were dropped.
function removeCategory(data, id, moveto) {
  const cats = data.categories || [];
  const target = cats.find((c) => c.id === id);
  if (!target) return { ok: false, error: "No such category." };
  if (target.archived) return { ok: false, error: "That category is already archived." };
  const active = cats.filter((c) => !c.archived);
  if (active.length <= 1)
    return { ok: false, error: "That's the only active category — add a replacement first." };

  if (moveto === id) return { ok: false, error: "`moveto` must be a different category." };

  const open = (data.entries || []).filter((e) => e.category === id && !e.done);
  const moved = [];
  const dropped = [];
  if (open.length > 0) {
    const dest = cats.find((c) => c.id === moveto && !c.archived);
    if (!moveto) return { ok: false, error: "That category has open requests — pass `moveto` to move them." };
    if (!dest) return { ok: false, error: "`moveto` must be an active category." };
    for (const e of open) {
      const dup = (data.entries || []).some(
        (o) => o !== e && o.userId === e.userId && o.category === moveto && !o.done
      );
      if (dup) {
        data.entries = data.entries.filter((o) => o !== e);
        dropped.push(e);
      } else {
        e.category = moveto;
        moved.push(e);
      }
    }
  }
  target.archived = true;
  return { ok: true, moved, dropped };
}

// Enable/adjust stale nudges. Sets the digest channel (the on/off switch); if
// `hours` is provided, validates and sets the stale threshold. Pure — mutates data.
function setNudgeConfig(data, channelId, hours) {
  if (hours != null) {
    if (!Number.isInteger(hours) || hours < 1 || hours > NUDGE_MAX_HOURS) {
      return { ok: false, error: `Threshold must be a whole number of hours between 1 and ${NUDGE_MAX_HOURS}.` };
    }
    data.nudgeThresholdHours = hours;
  }
  data.nudgeChannelId = channelId;
  return { ok: true };
}

// Turn nudges off (keep the threshold for next time). Pure — mutates data.
function clearNudge(data) {
  data.nudgeChannelId = null;
  return { ok: true };
}

function categorySuggestions(data, typed, excludeId) {
  const q = (typed || "").toLowerCase();
  return activeCategories(data)
    .filter((c) => c.id !== excludeId)
    .filter((c) => c.label.toLowerCase().includes(q))
    .slice(0, 25)
    .map((c) => ({ name: `${c.emoji} ${c.label}`.slice(0, 100), value: c.id }));
}

function emptyData() {
  return {
    boardChannelId: null,
    boardMessageId: null,
    entries: [],
    managerRoleIds: [],
    notifyRoleId: null,
    nudgeChannelId: null,
    nudgeThresholdHours: 48,
    lastNudgeTs: null,
    seasons: [],
    records: [],
    currentSeason: { name: null, startedTs: null },
    categories: defaultCategories(),
  };
}

function readAndShape(raw) {
  const parsed = JSON.parse(raw);
  return {
    boardChannelId: parsed.boardChannelId ?? null,
    boardMessageId: parsed.boardMessageId ?? null,
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    managerRoleIds: Array.isArray(parsed.managerRoleIds) ? parsed.managerRoleIds : [],
    notifyRoleId: parsed.notifyRoleId ?? null,
    nudgeChannelId: parsed.nudgeChannelId ?? null,
    nudgeThresholdHours:
      Number.isInteger(parsed.nudgeThresholdHours) &&
      parsed.nudgeThresholdHours >= 1 &&
      parsed.nudgeThresholdHours <= NUDGE_MAX_HOURS
        ? parsed.nudgeThresholdHours
        : 48,
    lastNudgeTs: typeof parsed.lastNudgeTs === "number" ? parsed.lastNudgeTs : null,
    seasons: Array.isArray(parsed.seasons) ? parsed.seasons : [],
    records: Array.isArray(parsed.records) ? parsed.records : [],
    currentSeason:
      parsed.currentSeason && typeof parsed.currentSeason === "object"
        ? {
            name: parsed.currentSeason.name ?? null,
            startedTs: parsed.currentSeason.startedTs ?? null,
          }
        : { name: null, startedTs: null },
    categories: shapeCategories(parsed.categories),
  };
}

function shapeCategories(rawCategories) {
  const cleaned = (Array.isArray(rawCategories) ? rawCategories : [])
    .filter((item) => item && typeof item.id === "string" && item.id && typeof item.label === "string")
    .map((item) => ({
      id: item.id,
      label: item.label,
      emoji: typeof item.emoji === "string" && item.emoji ? item.emoji : "📌",
      // Only a real `true` or the string "true" archives — Boolean(item.archived)
      // would also coerce the STRING "false" to true, silently archiving a
      // hand-edited category that a person wrote as "archived":"false" (B2
      // exists precisely to survive hand-edited files).
      archived: item.archived === true || item.archived === "true",
    }));
  return cleaned.length ? cleaned : defaultCategories();
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return emptyData();
  try {
    return readAndShape(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    // data.json is unreadable — try the last-known-good backup before giving up.
    try {
      if (fs.existsSync(BAK_FILE)) {
        const restored = readAndShape(fs.readFileSync(BAK_FILE, "utf8"));
        console.error(
          `data.json unreadable (${err.message}); restored from data.json.bak.`
        );
        return restored;
      }
    } catch (bakErr) {
      console.error(`data.json.bak also unreadable (${bakErr.message}).`);
    }
    console.error(
      `data.json is unreadable (${err.message}); starting from an empty board. ` +
        "The old files are left in place for manual inspection."
    );
    return emptyData();
  }
}

// Atomic write: write to a temp file, then rename over the target so a crash
// mid-write can never leave a truncated / corrupt data.json.
function saveData(data) {
  fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2));
  // Keep one last-known-good copy: back up the current file before replacing it —
  // but ONLY if it's valid JSON. Never overwrite a good .bak with a corrupt
  // data.json (which would otherwise happen on the first save after a restore).
  // Best-effort: a backup failure must never block the actual save.
  try {
    if (fs.existsSync(DATA_FILE)) {
      readAndShape(fs.readFileSync(DATA_FILE, "utf8")); // throws if corrupt or mis-shaped → skip backup
      // Atomic like the primary write: copy to a temp file, then rename over
      // BAK_FILE — a crash mid-copy can't leave a truncated/corrupt .bak.
      fs.copyFileSync(DATA_FILE, BAK_TMP_FILE);
      fs.renameSync(BAK_TMP_FILE, BAK_FILE);
    }
  } catch (err) {
    console.error(
      "Skipped data.json.bak (current data.json unreadable or copy failed):",
      err.message
    );
  }
  fs.renameSync(TMP_FILE, DATA_FILE);
}

const NUDGE_TICK_MS = 60 * 60 * 1000;      // hourly tick
const NUDGE_CADENCE_MS = 24 * 60 * 60 * 1000; // at most one digest per day
const NUDGE_MAX_HOURS = 8760;              // 1 year — sane upper bound for the threshold

// In-memory-only guard against re-posting (with the role ping) within the same
// process if persistence fails after a successful send — see nudgeTick. Not
// persisted: a single extra digest after an actual restart is acceptable; the
// persisted data.lastNudgeTs remains the cross-restart source of truth.
let lastNudgePostTs = 0;

// Who may run the officer commands: anyone with Manage Server, OR anyone holding
// a role that an admin added via /config. With no manager roles set, it falls
// back to Manage Server only — so you can never lock yourself out.
function isManager(interaction, data) {
  return levelOfInteraction(interaction, data) !== "member";
}

// The one place help feeds an interaction into the shared core/perms rule.
function levelOfInteraction(interaction, data) {
  return computeLevel({
    permissions: interaction.memberPermissions,
    roleCache: interaction.member?.roles?.cache,
    managerRoleIds: data.managerRoleIds,
  });
}

// The actor the shared actions (./actions) receive: who is acting, the name
// cards show, and the level from the same rule as isManager.
function actorOf(interaction, data) {
  return {
    userId: interaction.user.id,
    displayName: interaction.member?.displayName || interaction.user.username,
    level: levelOfInteraction(interaction, data),
  };
}

// Resolve a category id to its current {label, emoji}. Returns a FRESH object
// (never a reference into data.categories / DEFAULT_CATEGORIES). Falls back to
// the shipped defaults, then to a generic label so rendering never throws.
function catOf(data, id) {
  const found =
    (data.categories || []).find((c) => c.id === id) ||
    DEFAULT_CATEGORIES.find((c) => c.id === id);
  if (found) return { label: found.label, emoji: found.emoji };
  return { label: id, emoji: "❓" };
}

const NO_PERM = {
  content:
    "You need the **Manage Server** permission or a manager role to do that.",
  flags: MessageFlags.Ephemeral,
};

// Human-friendly duration, e.g. "2d 3h", "3h 12m", "8m".
function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return "under a minute";
}

// Tally sorts-per-helper for the /stats leaderboard. Sorted desc by count.
function tallyHelpers(entries) {
  const tally = {};
  for (const e of entries) {
    if (e.done && e.helpedBy) tally[e.helpedBy] = (tally[e.helpedBy] || 0) + 1;
  }
  return Object.entries(tally).sort((a, b) => b[1] - a[1]);
}

// The display name of a season (archived or current). Never a raw null.
function seasonLabel(season) {
  return (season && season.name) || "(unnamed)";
}

const RECORD_CAP = 5000;

// Build an immutable log record for a resolved request. `now` is injected
// (the resolving handler passes Date.now()). helperId only for "sorted";
// claim info carried whenever present. seasonStartedTs is the season's
// immutable identity (survives a later rename).
function makeRecord(data, entry, resolution, now) {
  const rec = {
    reqId: entry.id,
    requesterId: entry.userId,
    category: entry.category,
    resolution,
    requestedTs: entry.ts ?? null,
    resolvedTs: now,
    seasonStartedTs: data.currentSeason?.startedTs ?? null,
  };
  if (resolution === "sorted" && entry.helpedBy) rec.helperId = entry.helpedBy;
  if (entry.claimedBy) {
    rec.claimedById = entry.claimedBy;
    rec.claimedTs = entry.claimedTs ?? null;
  }
  return rec;
}

// Append a record and keep the log under RECORD_CAP (drop oldest). Mutates data.
// The prune warning fires at most once per process lifetime (past the cap,
// every future append would otherwise re-enter the branch and warn again).
let recordCapWarned = false;
function logRecord(data, record) {
  if (!Array.isArray(data.records)) data.records = [];
  data.records.push(record);
  if (data.records.length > RECORD_CAP) {
    data.records = data.records.slice(-RECORD_CAP);
    if (!recordCapWarned) {
      console.warn(`[records] pruned to RECORD_CAP=${RECORD_CAP}`);
      recordCapWarned = true;
    }
  }
}

// Close a batch of entries: logs one `resolution` record per entry (invariant
// #6 — MUST happen before saveData) and then drops them from data.entries.
// Pure — no REST, no Date.now side effect beyond the passed-in `now`. This is
// the exact close-and-log logic /imsorted has always used (both the direct
// category fast-path and the M13 select panel), pulled out so it's covered by
// a unit test instead of only by hand.
function closeEntries(data, entries, resolution, now) {
  for (const e of entries) logRecord(data, makeRecord(data, e, resolution, now));
  const ids = new Set(entries.map((e) => e.id));
  data.entries = data.entries.filter((e) => !ids.has(e.id));
}

// Mark a single entry sorted: sets done/doneTs/helpedBy and logs the "sorted"
// record BEFORE the caller's saveData (invariant #6). Pure — no REST, no
// saveData. This is the exact /helped close logic, pulled out so both the
// @member+category fast-path AND the resolve:helped panel (M13-T3) call the
// same tested core.
function resolveEntryAsSorted(data, entry, helperId, now) {
  entry.done = true;
  entry.doneTs = now;
  entry.helpedBy = helperId;
  logRecord(data, makeRecord(data, entry, "sorted", now));
}

// Remove a single entry (no "done" mark) and log the "removed" record BEFORE
// the caller's saveData (invariant #6). Pure — no REST, no saveData. This is
// the exact /remove logic, pulled out so both the @member+category fast-path
// AND the resolve:remove panel (M13-T3) call the same tested core.
function resolveEntryAsRemoved(data, entry, now) {
  logRecord(data, makeRecord(data, entry, "removed", now));
  data.entries = data.entries.filter((e) => e !== entry);
}

// ---------- pure query helpers (read-only, derived from records) ----------

function recordsForSeason(records, seasonStartedTs) {
  return (records || []).filter((r) => r.seasonStartedTs === seasonStartedTs);
}

function helperTotals(records) {
  const t = {};
  for (const r of records || []) {
    if (r.resolution === "sorted" && r.helperId) t[r.helperId] = (t[r.helperId] || 0) + 1;
  }
  return Object.entries(t).sort((a, b) => b[1] - a[1]);
}

function requesterTotals(records) {
  const t = {};
  for (const r of records || []) {
    if ((r.resolution === "sorted" || r.resolution === "self") && r.requesterId) {
      t[r.requesterId] = (t[r.requesterId] || 0) + 1;
    }
  }
  return Object.entries(t).sort((a, b) => b[1] - a[1]);
}

// Valid timing = both stamps present and end >= start.
function validWait(start, end) {
  return start != null && end != null && end >= start;
}

function categoryWait(records) {
  const out = {};
  for (const r of records || []) {
    if (r.resolution !== "sorted" || !validWait(r.requestedTs, r.resolvedTs)) continue;
    const c = out[r.category] || (out[r.category] = { waitMs: 0, waitN: 0 });
    c.waitMs += r.resolvedTs - r.requestedTs;
    c.waitN += 1;
  }
  return out;
}

function helperBreakdown(records, helperId) {
  const byCat = {};
  let total = 0;
  for (const r of records || []) {
    if (r.resolution !== "sorted" || r.helperId !== helperId) continue;
    total += 1;
    const c = byCat[r.category] || (byCat[r.category] = { n: 0, waitMs: 0, waitN: 0, claimMs: 0, claimN: 0 });
    c.n += 1;
    if (validWait(r.requestedTs, r.resolvedTs)) { c.waitMs += r.resolvedTs - r.requestedTs; c.waitN += 1; }
    // Claim timing only when the sorter is the claimer (C1): otherwise misattributed.
    if (r.claimedById === helperId && validWait(r.claimedTs, r.resolvedTs)) { c.claimMs += r.resolvedTs - r.claimedTs; c.claimN += 1; }
  }
  return { byCat, total };
}

function demandSummary(records) {
  const s = { sorted: 0, self: 0, removed: 0, unresolved: 0 };
  for (const r of records || []) if (r.resolution in s) s[r.resolution] += 1;
  return s;
}

// ---------- stale nudges (pure helpers, now-injected) ----------

// Open requests that have waited at least thresholdMs. now injected.
function staleEntries(entries, now, thresholdMs) {
  return (entries || []).filter((e) => !e.done && e.ts != null && now - e.ts >= thresholdMs);
}

// Has a full cadence elapsed since the last digest? now injected.
function dueForNudge(data, now, cadenceMs) {
  if (data.lastNudgeTs > now) return true; // clock stepped backward / corrupt future stamp ⇒ due
  return now - (data.lastNudgeTs || 0) >= cadenceMs;
}

// Build the reminder digest: stale requests grouped by category, each showing
// the requester's live name and how long they've waited. now injected.
//
// Budgeted so the embed can never exceed Discord's limits (25 fields, ~6000
// aggregate chars): an overloaded board must still post a (truncated) digest
// every day rather than fail channel.send identically hour after hour. When
// categories/chars don't all fit, the true total (stale.length) still shows in
// the title, and one final field summarizes what got dropped.
function nudgeDigestEmbed(data, stale, names, now) {
  const byCat = {};
  for (const e of stale) (byCat[e.category] || (byCat[e.category] = [])).push(e);
  const catIds = Object.keys(byCat);

  const title = `⏰ ${stale.length} request(s) still waiting`;
  const description = `These have waited longer than **${data.nudgeThresholdHours ?? 48}h**. Anyone free to help?`;

  const MAX_FIELDS = 25;
  const MAX_CHARS = 5500;
  let runningChars = title.length + description.length;

  const fields = [];
  let cutIndex = catIds.length; // index of the first category NOT included

  for (let i = 0; i < catIds.length; i++) {
    const id = catIds[i];
    const c = catOf(data, id);
    const lines = byCat[id]
      .slice()
      .sort((a, b) => a.ts - b.ts) // longest-waiting first
      .map((e) => `• ${names[e.userId] || "(left the server)"} — waiting **${formatDuration(now - e.ts)}**`);
    const name = `${c.emoji} ${c.label}`;
    const value = renderField(lines);
    const addedChars = name.length + value.length;

    if (fields.length >= MAX_FIELDS || runningChars + addedChars > MAX_CHARS) {
      cutIndex = i;
      break;
    }
    fields.push({ name, value });
    runningChars += addedChars;
  }

  if (cutIndex < catIds.length) {
    // Truncated. Make room for one overflow field if every slot is already used.
    if (fields.length >= MAX_FIELDS) {
      const evicted = fields.pop();
      runningChars -= evicted.name.length + evicted.value.length;
      cutIndex -= 1; // the evicted category is now also dropped
    }

    const buildOverflow = () => {
      let droppedReqCount = 0;
      for (let j = cutIndex; j < catIds.length; j++) droppedReqCount += byCat[catIds[j]].length;
      const droppedCatCount = catIds.length - cutIndex;
      return {
        name: "…",
        value: `_…and ${droppedReqCount} more request(s) across ${droppedCatCount} more categor${droppedCatCount === 1 ? "y" : "ies"}_`,
      };
    };

    let overflow = buildOverflow();
    let overflowLen = overflow.name.length + overflow.value.length;
    // The overflow field's own size was never counted against the budget above —
    // guard the TRUE total (all fields incl. this one) against Discord's hard
    // 6000-char embed ceiling by evicting more regular fields if needed, folding
    // their drop into the overflow message.
    while (runningChars + overflowLen >= 6000 && fields.length) {
      const evicted = fields.pop();
      runningChars -= evicted.name.length + evicted.value.length;
      cutIndex -= 1;
      overflow = buildOverflow();
      overflowLen = overflow.name.length + overflow.value.length;
    }

    fields.push(overflow);
    runningChars += overflowLen;
  }

  return new EmbedBuilder()
    .setColor(0xd9822b)
    .setTitle(title)
    .setDescription(description)
    .addFields(fields.length ? fields : [{ name: "—", value: "None." }]);
}

// ---------- /stats panel ----------

function statsViewOptions(data) {
  const opts = [
    { label: "📊 Current season", value: "current", default: true },
    { label: "🏆 All-time", value: "alltime" },
  ];
  const past = [...(data.seasons || [])].sort((a, b) => (b.endedTs || 0) - (a.endedTs || 0));
  for (const s of past.slice(0, 12)) {
    opts.push({ label: `${seasonLabel(s)} — ${s.sortedTotal || 0} sorted`.slice(0, 100), value: String(s.endedTs) });
  }
  return opts;
}

function statsPanelComponents(data, selected = "current") {
  const view = new StringSelectMenuBuilder()
    .setCustomId("stats:view")
    .setPlaceholder("Choose a view…")
    .addOptions(statsViewOptions(data).map((o) => ({ ...o, default: o.value === selected })));
  const member = new UserSelectMenuBuilder()
    .setCustomId("stats:member")
    .setPlaceholder("Look up a member's help…")
    .setMinValues(1)
    .setMaxValues(1);
  return [new ActionRowBuilder().addComponents(view), new ActionRowBuilder().addComponents(member)];
}

// Recover the currently-selected value of the "stats:view" string-select menu
// from a message's components array, so a follow-up interaction (e.g. the
// stats:member UserSelect) can preserve it instead of snapping back to a
// default. Pure/read-only. `components` may be discord.js Message component
// instances (getters: .customId/.options), raw API objects (.custom_id/
// .options), or builder instances (nested under .data) — handled defensively
// since the exact shape depends on where the caller got the message from.
// Returns the selected option's value, or null if not found.
function selectedViewFrom(components) {
  for (const row of components || []) {
    const rowComponents = row?.components || row?.data?.components || [];
    for (const comp of rowComponents) {
      const customId = comp?.customId ?? comp?.custom_id ?? comp?.data?.custom_id ?? comp?.data?.customId;
      if (customId !== "stats:view") continue;
      const options = comp?.options ?? comp?.data?.options ?? [];
      const picked = options.find((o) => o?.default);
      return picked ? picked.value ?? null : null;
    }
  }
  return null;
}

// Medal-prefixed leaderboard lines from [[id, n], …], names resolved.
function leaderboardLines(rows, names) {
  const medals = ["🥇", "🥈", "🥉"];
  return rows.map(([id, n], i) => `${medals[i] || "•"} ${names[id] || "(left the server)"} — **${n}**`);
}

function currentStatsEmbed(data, names) {
  const pending = data.entries.filter((e) => !e.done);
  const done = data.entries.filter((e) => e.done);
  const waits = done.filter((e) => e.ts && e.doneTs && e.doneTs >= e.ts).map((e) => e.doneTs - e.ts);
  const avg = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null;
  const pend = countByCategory(pending), don = countByCategory(done);
  const ids = new Set([...activeCategories(data).map((c) => c.id), ...Object.keys(pend), ...Object.keys(don)]);
  const catLines = [...ids].map((id) => { const c = catOf(data, id); return `${c.emoji} **${c.label}** — ${pend[id] || 0} waiting · ${don[id] || 0} sorted`; });
  const top = tallyHelpers(data.entries).slice(0, 15);
  return new EmbedBuilder()
    .setColor(0x5ac9a1)
    .setTitle(`📊 ${seasonLabel(data.currentSeason)} — current season`)
    .addFields(
      { name: "By category", value: renderField(catLines.length ? catLines : ["No categories configured."]) },
      { name: "Average wait", value: avg != null ? formatDuration(avg) : "—" },
      { name: "Top helpers", value: renderField(leaderboardLines(top, names).length ? leaderboardLines(top, names) : ["No sorts recorded yet."]) }
    );
}

function allTimeEmbed(data, names) {
  const recs = data.records || [];
  const top = helperTotals(recs).slice(0, 15);
  const cw = categoryWait(recs);
  // Per-category sorted count uses ALL sorted records (not just valid-timing
  // ones from categoryWait), so it agrees with the "Requests" line below.
  const sortedByCat = {};
  for (const r of recs) {
    if (r.resolution === "sorted") sortedByCat[r.category] = (sortedByCat[r.category] || 0) + 1;
  }
  const catLines = Object.keys(cw).map((id) => { const c = catOf(data, id); return `${c.emoji} **${c.label}** — ${sortedByCat[id] || 0} sorted`; });
  const d = demandSummary(recs);
  return new EmbedBuilder()
    .setColor(0x5ac9a1)
    .setTitle("🏆 All-time helper stats")
    .addFields(
      { name: "Top helpers (all-time)", value: renderField(leaderboardLines(top, names).length ? leaderboardLines(top, names) : ["No records yet."]) },
      { name: "By category", value: renderField(catLines.length ? catLines : ["—"]) },
      { name: "Requests", value: `${d.sorted} sorted · ${d.self} self-sorted · ${d.removed} removed · ${d.unresolved} unresolved` }
    );
}

function memberEmbed(data, helperId, name) {
  const { byCat, total } = helperBreakdown(data.records || [], helperId);
  const lines = Object.keys(byCat).map((id) => { const c = catOf(data, id); return `${c.emoji} **${c.label}** — ${byCat[id].n}`; });
  return new EmbedBuilder()
    .setColor(0x5ac9a1)
    .setTitle(`🙌 ${name} — helper stats`)
    .setDescription(`**${total}** sorted all-time`)
    .addFields({ name: "By category", value: renderField(lines.length ? lines : ["No sorts recorded for this member."]) });
}

function seasonHelperEmbed(data, season, names) {
  const recs = recordsForSeason(data.records || [], season.startedTs);
  if (recs.length === 0) {
    return new EmbedBuilder().setColor(0x5ac9a1).setTitle(`📅 ${seasonLabel(season)}`).setDescription("_no per-request data for this season_");
  }
  const top = helperTotals(recs).slice(0, 15);
  const d = demandSummary(recs);
  return new EmbedBuilder()
    .setColor(0x5ac9a1)
    .setTitle(`📅 ${seasonLabel(season)} — helpers`)
    .addFields(
      { name: "Top helpers", value: renderField(leaderboardLines(top, names).length ? leaderboardLines(top, names) : ["No sorts recorded."]) },
      { name: "Requests", value: `${d.sorted} sorted · ${d.self} self-sorted · ${d.removed} removed · ${d.unresolved} unresolved` }
    );
}

// Archive the current season (only if it has sorted entries) and clear the
// board. Mutates data. `now` is injected for determinism. Returns the archived
// season object, or null when there was nothing to archive.
function closeSeason(data, now) {
  const done = (data.entries || []).filter((e) => e.done);
  let archived = null;
  if (done.length > 0) {
    const cur = data.currentSeason || { name: null, startedTs: null };
    archived = {
      name: cur.name ?? null,
      startedTs: cur.startedTs ?? null,
      endedTs: now,
      sortedTotal: done.length,
      byCategory: countByCategory(done),
    };
    data.seasons.push(archived);
    if (data.seasons.length > 12) data.seasons = data.seasons.slice(-12);
  }
  const pending = (data.entries || []).filter((e) => !e.done);
  for (const e of pending) logRecord(data, makeRecord(data, e, "unresolved", now));
  data.entries = [];
  // The archived season's identity is now history; the board is a fresh cycle.
  // Reset to an unnamed current season (name it via /season, or /season "New
  // season" immediately overwrites this via beginSeason). Prevents /reset from
  // leaving the old name + a stale start date showing as "current".
  data.currentSeason = { name: null, startedTs: now };
  return archived;
}

// Begin a new current season with a name (trimmed; blank → null). Mutates data.
function beginSeason(data, name, now) {
  const trimmed = (name || "").trim();
  data.currentSeason = { name: trimmed || null, startedTs: now };
}

// Rename the current season ("current") or a past one (its endedTs). Mutates
// data. Blank name or unknown target → { ok: false }.
function renameSeason(data, target, newName) {
  const trimmed = (newName || "").trim();
  if (!trimmed) return { ok: false };
  if (target === "current") {
    const oldName = data.currentSeason?.name ?? null;
    data.currentSeason = { ...(data.currentSeason || { startedTs: null }), name: trimmed };
    return { ok: true, oldName };
  }
  const season = (data.seasons || []).find((s) => s.endedTs === target);
  if (!season) return { ok: false };
  const oldName = season.name ?? null;
  season.name = trimmed;
  return { ok: true, oldName };
}

// Options for the season picker: current first, then past seasons newest-first.
function seasonSelectOptions(data) {
  const opts = [{ label: `▶ ${seasonLabel(data.currentSeason)} (current)`.slice(0, 100), value: "current" }];
  const past = [...(data.seasons || [])].sort((a, b) => (b.endedTs || 0) - (a.endedTs || 0));
  for (const s of past.slice(0, 24)) {
    opts.push({ label: `${seasonLabel(s)} — ${s.sortedTotal || 0} sorted`.slice(0, 100), value: String(s.endedTs) });
  }
  return opts;
}

// The panel embed: current season summary + a compact past-seasons list.
function seasonPanelEmbed(data, sortedNow) {
  const cur = data.currentSeason || { name: null, startedTs: null };
  const since = cur.startedTs ? ` · started ${new Date(cur.startedTs).toISOString().slice(0, 10)}` : "";
  const past = [...(data.seasons || [])].sort((a, b) => (b.endedTs || 0) - (a.endedTs || 0));
  const pastLines = past.slice(0, 10).map((s) => {
    const ended = s.endedTs ? new Date(s.endedTs).toISOString().slice(0, 10) : "—";
    return `• **${seasonLabel(s)}** — ${s.sortedTotal || 0} sorted · ${ended}`;
  });
  return new EmbedBuilder()
    .setColor(0x5ac9a1)
    .setTitle("📅 Seasons")
    .addFields(
      { name: "Current season", value: `**${seasonLabel(cur)}**${since}\n${sortedNow} sorted so far` },
      { name: "Past seasons", value: pastLines.length ? renderField(pastLines) : "None yet." },
      { name: "⚠️ Before you start a new season", value: "**Starting a new season closes every pending request** — anyone still waiting gets moved to history as unresolved. This can't be undone." }
    );
}

function seasonPanelComponents(data) {
  const select = new StringSelectMenuBuilder()
    .setCustomId("season:view")
    .setPlaceholder("View a season…")
    .addOptions(seasonSelectOptions(data));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("season:new").setLabel("New season (closes pending)").setEmoji("▶️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("season:rename").setLabel("Rename current").setEmoji("✏️").setStyle(ButtonStyle.Secondary)
  );
  return [new ActionRowBuilder().addComponents(select), buttons];
}

// The /reset confirmation panel: warns how many members are still waiting
// before the destructive season wipe (closeSeason). Pure — no discord.js
// interaction state, so it's directly unit-testable.
function resetWarningEmbed(data) {
  const waiting = data.entries.filter((e) => !e.done).length;
  const who = waiting === 1 ? "member is" : "members are";
  return new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle("⚠️ Reset the season?")
    .setDescription(
      `This archives the current season and clears the board. **${waiting} ${who} still waiting** and their requests will be closed.\nThis can't be undone.`
    );
}

// Freshness window for a reset warning panel's Confirm button (F1): a panel
// older than this is refused instead of wiped, so a minutes-old (or a second
// officer's) panel can't close requests filed after the officer last saw the
// waiting count.
const RESET_CONFIRM_TTL_MS = 5 * 60 * 1000;

// Pure staleness check for the reset:confirm freshness token — no discord.js
// state, directly unit-testable. `issuedTs` is the Date.now() encoded in the
// customId when the warning panel was (re-)rendered.
function resetConfirmStale(issuedTs, now, ttlMs) {
  return now - issuedTs > ttlMs;
}

// issuedTs is Date.now() at render time — encoded into the confirm button's
// customId (F1) so handleResetButton can refuse a stale panel instead of
// wiping against whatever is current.
function resetWarningComponents(issuedTs) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`reset:confirm:${issuedTs}`).setLabel("Confirm reset").setEmoji("⚠️").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("reset:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    ),
  ];
}

// ---------- board rendering ----------
// Join lines into a single embed-field value, staying under Discord's 1024-char
// limit and clearly flagging any entries that had to be hidden.
function renderField(lines) {
  if (lines.length === 0) return "—";
  const LIMIT = 1024;
  const full = lines.join("\n");
  if (full.length <= LIMIT) return full;

  const RESERVE = 24; // room for the "…and N more" suffix
  const out = [];
  let len = 0;
  for (const line of lines) {
    const add = (out.length ? 1 : 0) + line.length;
    if (len + add > LIMIT - RESERVE) break;
    out.push(line);
    len += add;
  }
  const hidden = lines.length - out.length;
  return `${out.join("\n")}\n_…and ${hidden} more_`;
}

function buildBoardEmbed(data, names = {}) {
  const nameOf = (e) => names[e.userId] || e.username || "someone";
  const pending = data.entries.filter((e) => !e.done);
  const done = data.entries.filter((e) => e.done);

  const active = activeCategories(data).map((c) => c.label);
  const desc = active.length
    ? `Need help with ${active.slice(0, 6).join(", ")}${active.length > 6 ? ", …" : ""}? Use \`/needhelp\`.`
    : "Use `/needhelp` to ask for help.";

  const embed = new EmbedBuilder()
    .setColor(0x5ac9a1)
    .setTitle("🛡️ Guild Help Board")
    .setDescription(desc)
    .setFooter({ text: `${pending.length} waiting · ${done.length} sorted this season` })
    .setTimestamp();

  if (pending.length === 0) {
    embed.addFields({ name: "Waiting", value: "Nobody's waiting right now 🎉" });
  } else {
    const lines = pending.map((e) => {
      const cat = catOf(data, e.category);
      const note = e.note ? ` — _${e.note}_` : "";
      const since = e.ts ? ` · <t:${Math.floor(e.ts / 1000)}:R>` : "";
      const claim = e.claimedBy && names[e.claimedBy] ? ` · 🙌 ${names[e.claimedBy]}` : "";
      return `${cat.emoji} **${nameOf(e)}** (${cat.label})${note}${since}${claim}`;
    });
    embed.addFields({ name: "Waiting", value: renderField(lines) });
  }

  if (done.length > 0) {
    const lines = done.slice(-10).map((e) => {
      const cat = catOf(data, e.category);
      return `${cat.emoji} ~~${nameOf(e)}~~ (${cat.label})`;
    });
    embed.addFields({ name: "Sorted (last 10)", value: renderField(lines) });
  }

  return embed;
}

// Resolve each entry's CURRENT display name from its stored user id. A single
// member fetch needs no privileged intent and is cached by discord.js. If a
// member can't be fetched (e.g. they left the guild), we fall back to the last
// stored name — so the board never shows a raw id. READ-ONLY on purpose: it must
// never write data.json, or it could clobber a concurrent write with the stale
// snapshot it was handed (this runs after other awaits in every handler).
async function resolveNames(guild, data) {
  const names = {};
  // Only resolve what the board actually shows: all pending + the last 10 sorted.
  const pending = data.entries.filter((e) => !e.done);
  const done = data.entries.filter((e) => e.done).slice(-10);
  for (const e of [...pending, ...done]) {
    if (!names[e.userId]) {
      let name = e.username || "someone";
      if (guild) {
        try {
          const member =
            guild.members.cache.get(e.userId) ||
            (await guild.members.fetch(e.userId));
          name = member.displayName;
        } catch {
          // member left the guild or couldn't be fetched — keep the stored name
        }
      }
      names[e.userId] = name;
    }
    if (e.claimedBy && !names[e.claimedBy] && guild) {
      try {
        const m = guild.members.cache.get(e.claimedBy) || (await guild.members.fetch(e.claimedBy));
        names[e.claimedBy] = m.displayName;
      } catch {
        // unresolvable claimer — leave it out so the board shows no marker (never a raw id)
      }
    }
  }
  return names;
}

function hasOpenEntry(data, userId, categoryId) {
  return (data.entries || []).some(
    (e) => e.userId === userId && e.category === categoryId && !e.done
  );
}

// This user's own still-open entries (any category). Pure — used by the
// /imsorted self-service select panel (and reused by /helped+/remove, M13-T3).
function openEntriesFor(data, userId) {
  return (data.entries || []).filter((e) => e.userId === userId && !e.done);
}

// Build the imsorted:pick select options from a caller's open entries: one
// option per entry, label "<emoji> <label>", description "waiting <duration>".
function imsortedSelectOptions(data, entries, now) {
  return entries.slice(0, 25).map((e) => {
    const cat = catOf(data, e.category);
    return {
      label: `${cat.emoji} ${cat.label}`.slice(0, 100),
      description: `waiting ${formatDuration(now - (e.ts ?? now))}`.slice(0, 100),
      value: e.id,
    };
  });
}

// The /imsorted (no category arg) panel: pick-which-to-close select + a
// "close all" convenience button, mirroring the old omit=all behavior.
function imsortedPanelEmbed(count) {
  return new EmbedBuilder()
    .setColor(0x5ac9a1)
    .setTitle("✅ Mark yourself sorted")
    .setDescription(
      `You have **${count}** open request${count === 1 ? "" : "s"}. Pick which to mark sorted, or close them all.`
    );
}

function imsortedPanelComponents(options) {
  const select = new StringSelectMenuBuilder()
    .setCustomId("imsorted:pick")
    .setPlaceholder("Choose which to mark sorted…")
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(options);
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("imsorted:all").setLabel("Close all").setEmoji("✅").setStyle(ButtonStyle.Secondary)
  );
  return [new ActionRowBuilder().addComponents(select), buttons];
}

// ---------- /helped + /remove shared "resolve:" picker panel (M13-T3) ----------
// One two-step panel (pick member → pick which of their open requests) shared
// by both commands. They differ only in the resolve:<action>: namespace, the
// title/description text, and (in the handler) whether a DM is sent.

function resolveActionCopy(action) {
  return action === "helped"
    ? { title: "✅ Mark a member as sorted", memberDesc: "Pick the member you helped." }
    : { title: "🗑️ Remove a member's entry", memberDesc: "Pick the member to remove." };
}

function resolveMemberPanelEmbed(action) {
  const copy = resolveActionCopy(action);
  return new EmbedBuilder().setColor(0x5ac9a1).setTitle(copy.title).setDescription(copy.memberDesc);
}

function resolveMemberPanelComponents(action) {
  const placeholder = action === "helped" ? "Pick the member you helped…" : "Pick the member to remove…";
  const member = new UserSelectMenuBuilder()
    .setCustomId(`resolve:${action}:member`)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1);
  return [new ActionRowBuilder().addComponents(member)];
}

// The entry-step embed: named member's open-request count, or the no-dead-end
// "no open requests" message when they have none (the whole point of M13-T3).
function resolveEntryPanelEmbed(action, memberDisplayName, count) {
  const copy = resolveActionCopy(action);
  const desc =
    count === 0
      ? `**${memberDisplayName}** has no open requests.`
      : `**${memberDisplayName}** has **${count}** open request${count === 1 ? "" : "s"}. Pick which one.`;
  return new EmbedBuilder().setColor(0x5ac9a1).setTitle(copy.title).setDescription(desc);
}

function resolveEntryPanelComponents(action, options) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`resolve:${action}:entry`)
    .setPlaceholder("Pick which request…")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);
  return [new ActionRowBuilder().addComponents(select)];
}

// Builds the entry-step panel payload (embeds + components) for a given
// member — shared by the resolve:<action>:member select handler and the
// /helped + /remove "member given, category omitted" fast path (F5), so a
// member pick is never discarded just because category was left blank.
function entryStepPanelPayload(data, action, memberId, memberDisplayName) {
  const mine = openEntriesFor(data, memberId);
  if (mine.length === 0) {
    return { embeds: [resolveEntryPanelEmbed(action, memberDisplayName, 0)], components: [] };
  }
  const options = imsortedSelectOptions(data, mine, Date.now());
  return {
    embeds: [resolveEntryPanelEmbed(action, memberDisplayName, mine.length)],
    components: resolveEntryPanelComponents(action, options),
  };
}

// ---------- /config roles panel (M13-T5) ----------
// Pure — reads only data.managerRoleIds/notifyRoleId, no discord.js interaction
// state, so directly unit-testable.
function rolesPanelEmbed(data) {
  const roles =
    (data.managerRoleIds || []).length > 0
      ? data.managerRoleIds.map((id) => `<@&${id}>`).join(", ")
      : "_none_ (only Manage Server can manage)";
  const notify = data.notifyRoleId ? `<@&${data.notifyRoleId}>` : "_off_";
  return new EmbedBuilder()
    .setColor(0x5ac9a1)
    .setTitle("🛡️ Manager roles & notifications")
    .setDescription(
      "**Manager roles** can run the officer commands (`/imsorted`, `/helped`, `/remove`, etc.) in addition to anyone with Manage Server.\n" +
        "**Request ping role** gets @mentioned whenever a new `/needhelp` request comes in — leave it unset for no ping."
    )
    .addFields(
      { name: "Manager roles", value: roles },
      { name: "Request ping role", value: notify }
    );
}

// Options for the roles:remove StringSelect: ONLY the current manager roles,
// so you can only pick a removable one. label = role name (via nameOf — a
// small resolver so this stays pure/testable without a real guild), value =
// role id. Returns [] when there are no manager roles — the caller must omit
// the select in that case (Discord rejects a select with 0 options).
function rolesRemoveSelectOptions(managerRoleIds, nameOf) {
  return (managerRoleIds || []).slice(0, 25).map((id) => ({
    label: (nameOf(id) || `role ${id}`).slice(0, 100),
    value: id,
  }));
}

// nameOf(id) resolves a role id to its current name (e.g. via the guild's
// role cache) — kept separate from rolesRemoveSelectOptions so that helper
// stays pure and unit-testable without discord.js.
function rolesPanelComponents(data, nameOf) {
  const rows = [
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId("roles:add")
        .setPlaceholder("Add a manager role…")
        .setMinValues(1)
        .setMaxValues(1)
    ),
  ];

  const removeOptions = rolesRemoveSelectOptions(data.managerRoleIds, nameOf);
  if (removeOptions.length > 0) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("roles:remove")
          .setPlaceholder("Remove a manager role…")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(removeOptions)
      )
    );
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId("roles:notify")
        .setPlaceholder("Set the request-ping role…")
        .setMinValues(1)
        .setMaxValues(1)
    )
  );
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("roles:notifyclear")
        .setLabel("Clear notify role")
        .setStyle(ButtonStyle.Secondary)
    )
  );
  return rows;
}

function newHelpEntry(userId, username, categoryId, note) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    userId,
    username,
    category: categoryId,
    note: note || "",
    done: false,
    ts: Date.now(),
  };
}

// Shared request-card description (used by postRequestCard, rerenderCard, claim).
function cardDescription(cat, entry, claimerName) {
  const note = entry.note ? `\n📝 _${entry.note}_` : "";
  const claim = entry.claimedBy && claimerName ? `\n🙌 Claimed by ${claimerName}` : "";
  return `🙋 **${entry.username}** needs help with **${cat.label}** ${cat.emoji}${note}${claim}`;
}

// Post the request card, persist its message ids without clobbering concurrent
// writes, and refresh the board. Slow REST — call AFTER acking the user.
async function announceEntry(client, entry, fallbackChannelId) {
  const data = loadData();
  await postRequestCard(client, data, entry, fallbackChannelId);
  const fresh = loadData();
  const target = fresh.entries.find((e) => e.id === entry.id);
  if (target) {
    target.requestChannelId = entry.requestChannelId;
    target.requestMessageId = entry.requestMessageId;
    saveData(fresh);
  }
  await refreshBoard(client, fresh);
}

// Hourly timer body: if nudges are on, a day has passed, and stale requests
// exist, post one digest and stamp lastNudgeTs. Guarded so a transient error
// never crashes the process or blocks the next tick.
async function nudgeTick(client) {
  try {
    const data = loadData();
    if (!data.nudgeChannelId) return;                 // disabled
    const now = Date.now();
    // Persisted lastNudgeTs is the cross-restart source of truth; lastNudgePostTs
    // is an in-memory-only backstop so a persistence failure right after a
    // successful send (corrupt data.json, ENOSPC, process death) can't make THIS
    // process re-post a full digest + role ping again before the day is up.
    if (!dueForNudge(data, now, NUDGE_CADENCE_MS) || now - lastNudgePostTs < NUDGE_CADENCE_MS) return;
    const thresholdMs = (data.nudgeThresholdHours ?? 48) * 60 * 60 * 1000;
    const stale = staleEntries(data.entries, now, thresholdMs);
    if (stale.length === 0) return;

    const channel = await client.channels.fetch(data.nudgeChannelId).catch(() => null);
    if (!channel || typeof channel.send !== "function") return; // gone/unusable → retry next tick (day not claimed)

    const names = await resolveNames(channel.guild, data); // read-only
    const embed = nudgeDigestEmbed(data, stale, names, now);
    lastNudgePostTs = now; // set BEFORE the send so a throw during/after send still blocks a same-process re-post
    await channel.send({
      content: data.notifyRoleId ? `<@&${data.notifyRoleId}>` : undefined,
      embeds: [embed],
      allowedMentions: data.notifyRoleId ? { roles: [data.notifyRoleId] } : { parse: [] },
    });

    // Invariant #1: an await (the post) happened since loadData — re-load, patch
    // the single field, save the fresh copy so concurrent writes aren't clobbered.
    const fresh = loadData();
    fresh.lastNudgeTs = now;
    saveData(fresh);
  } catch (err) {
    console.error("nudgeTick failed:", err?.message ?? err);
  }
}

// Look up one member's current display name (for the /stats leaderboard).
async function memberName(guild, userId) {
  if (!guild) return null;
  try {
    const member =
      guild.members.cache.get(userId) || (await guild.members.fetch(userId));
    return member.displayName;
  } catch {
    return null;
  }
}

// Resolve a set of user ids to display names for a leaderboard. Read-only REST;
// left-guild ids fall back to a fixed label. Dedupe before calling.
async function resolveIds(guild, ids) {
  const names = {};
  for (const id of new Set(ids)) names[id] = (await memberName(guild, id)) || "(left the server)";
  return names;
}

// The embed for one /stats view: "current", "alltime" or a past season's
// endedTs. null = that season is gone. Read-only; the name lookups are REST,
// so callers defer first. Shared by /stats, the stats:view select and the
// /menu Stats screen.
async function statsEmbedFor(guild, data, view) {
  if (view === "current") {
    const top = tallyHelpers(data.entries).slice(0, 15);
    return currentStatsEmbed(data, await resolveIds(guild, top.map(([id]) => id)));
  }
  if (view === "alltime") {
    const top = helperTotals(data.records || []).slice(0, 15);
    return allTimeEmbed(data, await resolveIds(guild, top.map(([id]) => id)));
  }
  const season = (data.seasons || []).find((s) => s.endedTs === Number(view));
  if (!season) return null;
  const top = helperTotals(recordsForSeason(data.records || [], season.startedTs)).slice(0, 15);
  return seasonHelperEmbed(data, season, await resolveIds(guild, top.map(([id]) => id)));
}

async function refreshBoard(client, data) {
  if (!data.boardChannelId || !data.boardMessageId) return;
  try {
    const channel = await client.channels.fetch(data.boardChannelId);
    const names = await resolveNames(channel.guild, data);
    const message = await channel.messages.fetch(data.boardMessageId);
    await message.edit({ embeds: [buildBoardEmbed(data, names)], components: [needHelpRow()] });
  } catch (err) {
    console.error("Could not refresh board message:", err.message);
  }
}

// ---------- self-service board button ----------
function categorySelectOptions(data) {
  return activeCategories(data)
    .slice(0, 25)
    .map((c) => ({ label: `${c.emoji} ${c.label}`.slice(0, 100), value: c.id }));
}

function needHelpRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("board:needhelp")
      .setLabel("Need help")
      .setEmoji("🙋")
      .setStyle(ButtonStyle.Primary)
  );
}

function toggleClaim(entry, officerId, now) {
  if (!entry.claimedBy) { entry.claimedBy = officerId; entry.claimedTs = now; return { action: "claimed", by: officerId }; }
  if (entry.claimedBy === officerId) { entry.claimedBy = null; entry.claimedTs = null; return { action: "released", by: officerId }; }
  return { action: "blocked", by: entry.claimedBy };
}

// Clear a stale claim (the holder is no longer a guild member) so the next
// toggleClaim call lets a new officer take it instead of staying "blocked"
// forever. Pure — no guild access, no Date.now.
function releaseClaim(entry) {
  entry.claimedBy = null;
  entry.claimedTs = null;
  return entry;
}

// True only for a confirmed "member/user is gone" Discord REST error — NOT for
// rate limits, 5xx, or network errors, which can spike exactly when several
// officers are interacting at once (contested claims). Used to gate the M8
// auto-release so a transient fetch failure can't be mistaken for a departure.
function isGoneError(err) {
  return err?.code === 10007 || err?.code === 10013; // Unknown Member / Unknown User
}

// M8 claim auto-release, TOCTOU-guarded: called from the claim button's
// "blocked" branch AFTER a fresh reload, once the ORIGINAL holder
// (staleHolderId) has been confirmed gone. That confirmation awaited a REST
// call, so the claim may have changed hands in the meantime — recheck the
// freshly-loaded entry before releasing. If someone else holds it now, it's a
// live claim; don't steal it. Pure — no guild access, no Date.now side effects
// beyond the passed-in `now`.
function applyStaleClaimRelease(freshEntry, staleHolderId, officerId, now) {
  if (freshEntry.claimedBy && freshEntry.claimedBy !== staleHolderId) {
    // Claim changed hands during the membership check — it's live now.
    return { action: "blocked", by: freshEntry.claimedBy };
  }
  if (freshEntry.claimedBy === staleHolderId) releaseClaim(freshEntry);
  return toggleClaim(freshEntry, officerId, now);
}

// ---------- help-request cards (one-click officer actions) ----------
function requestButtons(entryId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`help:claim:${entryId}`)
      .setLabel("Claim")
      .setEmoji("🙌")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`help:sorted:${entryId}`)
      .setLabel("Sorted")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`help:remove:${entryId}`)
      .setLabel("Remove")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Secondary)
  );
}

// Post a request card so officers can resolve it with one click. Goes to the
// board channel if set, otherwise the channel the command was used in.
async function postRequestCard(client, data, entry, fallbackChannelId) {
  const channelId = data.boardChannelId || fallbackChannelId;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    const cat = catOf(data, entry.category);
    const embed = new EmbedBuilder()
      .setColor(0x5ac9a1)
      .setDescription(cardDescription(cat, entry, null))
      .setFooter({ text: "Officers: use the buttons below when it's handled" })
      .setTimestamp();
    const message = await channel.send({
      content: data.notifyRoleId ? `<@&${data.notifyRoleId}>` : undefined,
      embeds: [embed],
      components: [requestButtons(entry.id)],
      allowedMentions: data.notifyRoleId
        ? { roles: [data.notifyRoleId] }
        : { parse: [] },
    });
    entry.requestChannelId = channel.id;
    entry.requestMessageId = message.id;
  } catch (err) {
    console.error("Could not post request card:", err.message);
  }
}

// Finalise a request card (used by the slash commands; button clicks edit the
// card directly via interaction.update instead).
async function resolveCard(client, entry, statusLine) {
  if (!entry.requestChannelId || !entry.requestMessageId) return;
  try {
    const channel = await client.channels.fetch(entry.requestChannelId);
    const message = await channel.messages.fetch(entry.requestMessageId);
    await message.edit({
      content: statusLine,
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch {
    // card already gone or not editable — nothing to do
  }
}

// Re-render a request card in place, KEEPING its buttons (unlike resolveCard,
// which finalizes and strips them). Used when an entry is reassigned to another
// category. Best-effort REST; failures are ignored like the other card helpers.
async function rerenderCard(client, data, entry) {
  if (!entry.requestChannelId || !entry.requestMessageId) return;
  try {
    const channel = await client.channels.fetch(entry.requestChannelId);
    const message = await channel.messages.fetch(entry.requestMessageId);
    const cat = catOf(data, entry.category);
    const claimer = entry.claimedBy ? await memberName(channel.guild, entry.claimedBy) : null;
    const embed = new EmbedBuilder()
      .setColor(0x5ac9a1)
      .setDescription(cardDescription(cat, entry, claimer))
      .setFooter({ text: "Officers: use the buttons below when it's handled" })
      .setTimestamp(entry.ts ? new Date(entry.ts) : null);
    await message.edit({
      embeds: [embed],
      components: [requestButtons(entry.id)],
      allowedMentions: { parse: [] },
    });
  } catch {
    // card gone / not editable — nothing to do
  }
}

async function dmSorted(client, data, userId, categoryId) {
  try {
    const user = await client.users.fetch(userId);
    const cat = catOf(data, categoryId);
    await user.send(
      `✅ You've been sorted for **${cat.label}** ${cat.emoji} on the Guild Help Board. Thanks for your patience!`
    );
  } catch {
    // the member has DMs closed or has left — not a problem
  }
}

// Reply safely regardless of the interaction's current state, and never let the
// recovery path itself throw an unhandled rejection.
async function respond(interaction, payload) {
  try {
    if (interaction.deferred) return await interaction.editReply(payload);
    if (interaction.replied) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (err) {
    console.error("Failed to respond to interaction:", err?.message ?? err);
  }
}

// The /help text. The /menu "How it works" screen shows the same text as V2 markdown.
function howItWorksEmbed() {
  return new EmbedBuilder()
    .setColor(0x5ac9a1)
    .setTitle("🛡️ Guild Help Board — how it works")
    .setDescription(
      "Tracks who needs help with the guild's help categories this " +
        "season, and lets officers mark them as sorted once helped. The board " +
        "message updates automatically."
    )
    .addFields(
      {
        name: "🟢 Everyone",
        value:
          "`/needhelp` — add yourself (posts a request officers can action)\n" +
          "`/imsorted` — remove yourself once you've been helped\n" +
          "`/stats` — season stats & top helpers\n" +
          "`/help` — show this message",
      },
      {
        name: "🛡️ Officers (Manage Server, or a manager role)",
        value:
          "Click **✅ Sorted** / **🗑️ Remove** on a request card, or:\n" +
          "`/helped @member <category>` — mark them as sorted\n" +
          "`/remove @member <category>` — remove an entry\n" +
          "`/board` — post & pin the live board\n" +
          "`/reset` — clear the board for a new season",
      },
      {
        name: "⚙️ Admins (Manage Server)",
        value:
          "`/config addrole @role` — let a role manage the board\n" +
          "`/config removerole @role` — remove a role\n" +
          "`/config notify @role` — ping a role on new requests\n" +
          "`/config roles` — panel: manage roles & the notify role\n" +
          "`/config category add [label] [emoji]` — add/update a category (opens a form if left blank)\n" +
          "`/config category remove <category> [moveto]` — archive (move open requests first)\n" +
          "`/config category list` — list categories\n" +
          "`/config nudge set #channel [hours]` — daily digest for long-waiting requests\n" +
          "`/config nudge off` — turn nudges off\n" +
          "`/config nudge status` — show nudge settings",
      }
    );
}

// ---------- slash commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName("needhelp")
    .setDescription("Add yourself to the help board for this season")
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("What do you need help with?")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt.setName("note").setDescription("Optional note (e.g. '3 more hammers needed')")
    ),

  new SlashCommandBuilder()
    .setName("imsorted")
    .setDescription("Remove yourself from the board (you got the help you needed)")
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("Which one? Leave empty to remove all of yours")
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Season stats: waiting, sorted, wait time, and top helpers"),

  new SlashCommandBuilder()
    .setName("season")
    .setDescription("Manage seasons: start a new named season, rename current or past ones"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("How to use the Guild Help Board bot"),

  new SlashCommandBuilder()
    .setName("helped")
    .setDescription("Mark a member as sorted / helped")
    .addUserOption((opt) =>
      opt.setName("member").setDescription("Who got helped (leave empty to pick from a panel)")
    )
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("Which category (leave empty to pick from a panel)")
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a member's entry without marking it done")
    .addUserOption((opt) =>
      opt.setName("member").setDescription("Who to remove (leave empty to pick from a panel)")
    )
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("Which category (leave empty to pick from a panel)")
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("board")
    .setDescription("Post the help board in this channel (becomes the live board)"),

  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Archive the season and clear the board (asks you to confirm)"),

  // Admin-only: bootstrap which roles may run the officer commands above.
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configure roles and notifications for the help board")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("addrole")
        .setDescription("Allow a role to manage the board")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to allow").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("removerole")
        .setDescription("Stop a role from managing the board")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to remove").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("roles").setDescription("Open the manager roles & notify-role panel")
    )
    .addSubcommand((sub) =>
      sub
        .setName("notify")
        .setDescription("Ping a role on new requests (leave empty to turn off)")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to ping (empty = off)")
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("category")
        .setDescription("Manage help categories")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("Add or update a category")
            .addStringOption((o) => o.setName("label").setDescription("Category name (leave empty to open a form)"))
            .addStringOption((o) => o.setName("emoji").setDescription("Emoji (optional)"))
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Archive a category (move its open requests first if needed)")
            .addStringOption((o) =>
              o.setName("category").setDescription("Category to archive").setRequired(true).setAutocomplete(true)
            )
            .addStringOption((o) =>
              o.setName("moveto").setDescription("Move open requests here").setAutocomplete(true)
            )
        )
        .addSubcommand((sub) => sub.setName("list").setDescription("List categories"))
    )
    .addSubcommandGroup((g) =>
      g
        .setName("nudge")
        .setDescription("Remind officers about long-waiting requests")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Post a daily digest to a channel (this enables nudges)")
            .addChannelOption((o) =>
              o.setName("channel").setDescription("Where to post the digest").setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            )
            .addIntegerOption((o) =>
              o.setName("hours").setDescription("Stale threshold in hours (default 48)").setMinValue(1).setMaxValue(NUDGE_MAX_HOURS)
            )
        )
        .addSubcommand((sub) => sub.setName("off").setDescription("Turn off stale nudges"))
        .addSubcommand((sub) => sub.setName("status").setDescription("Show current nudge settings"))
    ),
].map((c) => c.toJSON());

// ---------- client ----------
// The platform core creates the Client (Guilds intent, allowedMentions
// parse: [] — no pings unless a call opts in) and binds it here before login.
let client = null;

function bind(c) {
  client = c;
}

// The ctx the help handlers hand to ./actions (only .client is used there).
function helpCtx() {
  return { client };
}

// Called by the core on clientReady.
function onReady() {
  const nudgeTimer = setInterval(() => nudgeTick(client), NUDGE_TICK_MS);
  nudgeTimer.unref(); // never keep the process alive for the nudge timer alone
  // One delayed startup kick: the deploy model is "restart = git pull", so
  // without this the first possible digest is up to an hour after every
  // routine deploy — the daily cadence gate makes the extra call harmless
  // when a digest isn't actually due.
  setTimeout(() => nudgeTick(client), 60_000).unref();
}

// ---------- button handling (one-click officer actions) ----------
async function handleButton(interaction) {
  const [ns, action, entryId] = interaction.customId.split(":");
  if (ns !== "help") return;

  const data = loadData();
  if (!isManager(interaction, data)) {
    await respond(interaction, NO_PERM);
    return;
  }

  const entry = data.entries.find((e) => e.id === entryId);
  if (!entry || entry.done) {
    // Nothing to act on — just clear the stale buttons.
    try {
      await interaction.update({ components: [] });
    } catch {
      await respond(interaction, {
        content: "That request has already been handled.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  const byName = interaction.member?.displayName || interaction.user.username;

  if (action === "sorted") {
    entry.done = true;
    entry.doneTs = Date.now();
    entry.helpedBy = interaction.user.id;
    logRecord(data, makeRecord(data, entry, "sorted", Date.now()));
    saveData(data);
    await interaction.update({
      content: `✅ Sorted by ${byName}`,
      components: [],
      allowedMentions: { parse: [] },
    });
    await dmSorted(client, data, entry.userId, entry.category);
    await refreshBoard(client, data);
  } else if (action === "remove") {
    logRecord(data, makeRecord(data, entry, "removed", Date.now()));
    data.entries = data.entries.filter((e) => e.id !== entryId);
    saveData(data);
    await interaction.update({
      content: `🗑️ Removed by ${byName}`,
      components: [],
      allowedMentions: { parse: [] },
    });
    await refreshBoard(client, data);
  } else if (action === "claim") {
    const byName = interaction.member?.displayName || interaction.user.username;
    let r = toggleClaim(entry, interaction.user.id, Date.now());
    let workingData = data;
    let workingEntry = entry;
    if (r.action === "blocked") {
      // F2: distinguish "definitely gone" (Unknown Member/User) from "couldn't
      // check" (rate limit / 5xx / network) — only the former justifies
      // auto-release. A transient error must NOT be treated as a departure.
      const guild = interaction.guild;
      let member = null;
      let verifyFailed = !guild;
      if (guild) {
        try {
          member = guild.members.cache.get(r.by) || (await guild.members.fetch(r.by));
        } catch (err) {
          if (isGoneError(err)) member = null; // confirmed gone
          else verifyFailed = true;
        }
      }
      if (verifyFailed) {
        await respond(interaction, { content: "Couldn't verify the current claimer — try again.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (member) {
        await respond(interaction, { content: `🙌 **${member.displayName}** is already on this.`, flags: MessageFlags.Ephemeral });
        return;
      }
      // Stale claim — the holder is confirmed gone. Invariant #1: the
      // membership check above was an await since loadData, so re-load fresh,
      // re-find the entry by id, and apply the release+claim to that copy
      // rather than saving our now-possibly-stale snapshot.
      const fresh = loadData();
      const freshEntry = fresh.entries.find((e) => e.id === entryId);
      if (!freshEntry || freshEntry.done) {
        try {
          await interaction.update({ components: [] });
        } catch {
          await respond(interaction, { content: "That request has already been handled.", flags: MessageFlags.Ephemeral });
        }
        return;
      }
      // F1: recheck the fresh claim before releasing — it may have changed
      // hands (to a LIVE claim) during the membership check's await window.
      r = applyStaleClaimRelease(freshEntry, r.by, interaction.user.id, Date.now());
      if (r.action === "blocked") {
        const holder2 = await memberName(interaction.guild, r.by);
        await respond(interaction, { content: `🙌 **${holder2 || "Another officer"}** is already on this.`, flags: MessageFlags.Ephemeral });
        return;
      }
      workingData = fresh;
      workingEntry = freshEntry;
    }
    saveData(workingData);
    const cat = catOf(workingData, workingEntry.category);
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x5ac9a1).setDescription(cardDescription(cat, workingEntry, r.action === "claimed" ? byName : null)).setFooter({ text: "Officers: use the buttons below when it's handled" }).setTimestamp(workingEntry.ts ? new Date(workingEntry.ts) : null)],
      components: [requestButtons(workingEntry.id)],
      allowedMentions: { parse: [] },
    });
    await refreshBoard(client, workingData);
  } else {
    // Unknown / future action — acknowledge so Discord doesn't show "failed".
    await respond(interaction, {
      content: "Unknown action.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleBoardButton(interaction) {
  if (interaction.customId !== "board:needhelp") {
    // Unknown / future board action — acknowledge so Discord doesn't show "failed".
    await respond(interaction, { content: "Unknown action.", flags: MessageFlags.Ephemeral });
    return;
  }
  const data = loadData();
  const opts = categorySelectOptions(data);
  if (opts.length === 0) {
    await respond(interaction, { content: "No categories are set up yet — ask an admin.", flags: MessageFlags.Ephemeral });
    return;
  }
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("board:pick")
      .setPlaceholder("What do you need help with?")
      .addOptions(opts)
  );
  await respond(interaction, { content: "Pick a category:", components: [row], flags: MessageFlags.Ephemeral });
}

async function handleBoardSelect(interaction) {
  const data = loadData();
  const categoryId = interaction.values[0];
  const r = actions().needHelp(helpCtx(), actorOf(interaction, data), { categoryId, channelId: interaction.channelId });
  if (!r.ok) {
    const content =
      r.code === "invalid"
        ? "That category isn't available anymore."
        : r.code === "duplicate"
          ? `You're already on the board for **${catOf(data, categoryId).label}**.`
          : r.error;
    await interaction.update({ content, components: [] });
    return;
  }
  await interaction.update({ content: `Added you to the board for **${r.category.label}** ${r.category.emoji} ✅`, components: [] });
  await r.effects();
}

async function handleStatsCommand(interaction, data) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const embed = await statsEmbedFor(interaction.guild, data, "current");
  await interaction.editReply({ embeds: [embed], components: statsPanelComponents(data, "current") });
}

async function handleStatsView(interaction) {
  await interaction.deferUpdate();
  const data = loadData();
  const value = interaction.values[0];
  const embed = await statsEmbedFor(interaction.guild, data, value);
  if (!embed) {
    await interaction.editReply({ content: "That season is gone.", embeds: [], components: statsPanelComponents(data, "current") });
    return;
  }
  await interaction.editReply({ embeds: [embed], components: statsPanelComponents(data, value) });
}

async function handleStatsMember(interaction) {
  await interaction.deferUpdate();
  const data = loadData();
  const helperId = interaction.values[0];
  const name = (await memberName(interaction.guild, helperId)) || "(left the server)";
  const view = selectedViewFrom(interaction.message?.components) || "current";
  await interaction.editReply({ embeds: [memberEmbed(data, helperId, name)], components: statsPanelComponents(data, view) });
}

async function handleSeasonCommand(interaction, data) {
  if (!isManager(interaction, data)) { await respond(interaction, NO_PERM); return; }
  const sortedNow = data.entries.filter((e) => e.done).length;
  await respond(interaction, {
    embeds: [seasonPanelEmbed(data, sortedNow)],
    components: seasonPanelComponents(data),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSeasonSelect(interaction) {
  const data = loadData();
  if (!isManager(interaction, data)) { await interaction.update({ content: "Managers only.", embeds: [], components: [] }); return; }
  const value = interaction.values[0];
  const target = value === "current" ? "current" : Number(value);
  const season = target === "current"
    ? data.currentSeason
    : (data.seasons || []).find((s) => s.endedTs === target);
  if (!season) { await interaction.update({ content: "That season is gone.", embeds: [], components: [] }); return; }
  const sortedNow = target === "current" ? data.entries.filter((e) => e.done).length : (season.sortedTotal || 0);
  const detail = new EmbedBuilder()
    .setColor(0x5ac9a1)
    .setTitle(`📅 ${seasonLabel(season)}${target === "current" ? " (current)" : ""}`)
    .setDescription(`${sortedNow} sorted${season.byCategory ? " · " + Object.entries(season.byCategory).map(([id, n]) => `${catOf(data, id).emoji} ${n}`).join(" · ") : ""}`);
  const rename = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`season:renamepick:${value}`).setLabel("Rename this season").setEmoji("✏️").setStyle(ButtonStyle.Secondary)
  );
  await interaction.update({ embeds: [detail], components: [seasonPanelComponents(data)[0], rename] });
}

async function handleSeasonButton(interaction) {
  const data = loadData();
  if (!isManager(interaction, data)) { await respond(interaction, { content: "Managers only.", flags: MessageFlags.Ephemeral }); return; }
  const parts = interaction.customId.split(":"); // season:new | season:rename | season:renamepick:<target>
  const action = parts[1];

  if (action === "new") {
    const input = new TextInputBuilder().setCustomId("name").setLabel("New season name").setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true).setPlaceholder("e.g. Season 5 — Winter");
    const modal = new ModalBuilder().setCustomId("season:newmodal").setTitle("Start a new season (closes pending requests)").addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }
  if (action === "rename" || action === "renamepick") {
    const target = action === "rename" ? "current" : parts[2]; // "current" or "<endedTs>"
    const season = target === "current" ? data.currentSeason : (data.seasons || []).find((s) => String(s.endedTs) === String(target));
    const input = new TextInputBuilder().setCustomId("name").setLabel("Season name").setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true);
    // Only prefill when there is a real name — Discord rejects an empty setValue
    // on a text input (unnamed is the day-one state, so this path is common).
    const prefill = seasonLabel(season);
    if (prefill && prefill !== "(unnamed)") input.setValue(prefill);
    const modal = new ModalBuilder().setCustomId(`season:renamemodal:${target}`).setTitle("Rename season").addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }
  await respond(interaction, { content: "That action isn't available.", flags: MessageFlags.Ephemeral });
}

async function handleSeasonModal(interaction) {
  const data = loadData();
  if (!isManager(interaction, data)) { await respond(interaction, { content: "Managers only.", flags: MessageFlags.Ephemeral }); return; }
  const name = interaction.fields.getTextInputValue("name");

  if (interaction.customId === "season:newmodal") {
    const r = actions().newSeason(helpCtx(), actorOf(interaction, data), { name });
    if (!r.ok) { await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral }); return; }
    const archivedNote = r.archived ? "Previous season archived, board cleared." : "Board cleared.";
    await ackSeasonPanel(interaction, r.data, `Started season **${seasonLabel(r.data.currentSeason)}**. ${archivedNote} 🌱`);
    await r.effects(); // close the pending cards, refresh the board
    return;
  }

  if (interaction.customId.startsWith("season:renamemodal:")) {
    const rawTarget = interaction.customId.slice("season:renamemodal:".length);
    const target = rawTarget === "current" ? "current" : Number(rawTarget);
    const r = actions().renameSeason(helpCtx(), actorOf(interaction, data), { target, name });
    if (!r.ok) { await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral }); return; }
    const season = target === "current" ? r.data.currentSeason : r.data.seasons.find((s) => s.endedTs === target);
    await ackSeasonPanel(interaction, r.data, `Renamed to **${seasonLabel(season)}**.`);
    if (r.effects) await r.effects(); // the board may show the season name later; a no-op otherwise
    return;
  }
}

// Acks a season modal by refreshing the season panel it was opened from, in
// place — falls back to a fresh ephemeral ack if the submit somehow didn't come
// from a message component (shouldn't happen: both modals are button-triggered).
// F3: the ack can fail on its own (panel dismissed mid-modal, message-target
// errors) — the fallback reply keeps a throw here from skipping the caller's
// post-ack REST (cards + board), which must always run since the save already
// committed.
async function ackSeasonPanel(interaction, data, doneText) {
  if (typeof interaction.update === "function" && interaction.isFromMessage?.()) {
    const sortedNow = data.entries.filter((e) => e.done).length;
    try {
      await interaction.update({ embeds: [seasonPanelEmbed(data, sortedNow)], components: seasonPanelComponents(data) });
    } catch {
      await respond(interaction, { content: doneText, flags: MessageFlags.Ephemeral });
    }
  } else {
    await interaction.reply({ content: doneText, flags: MessageFlags.Ephemeral });
  }
}

// /config category add's no-arg fallback modal. A plain ModalSubmitInteraction
// (opened straight from the slash command, not a message component) — so ack
// with reply(), never .update(). F3: re-check ManageGuild (not the weaker
// isManager) — this modal is spawned by /config, which is itself gated on
// ManageGuild, so its re-check must match; a modal submit is a fresh
// interaction, and the slash-command check that gated opening it doesn't
// carry over.
async function handleCatAddModal(interaction) {
  const data = loadData();
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) { await respond(interaction, { content: "Manage Server only.", flags: MessageFlags.Ephemeral }); return; }
  const r = actions().addCategory(helpCtx(), actorOf(interaction, data), {
    label: interaction.fields.getTextInputValue("label"),
    emoji: interaction.fields.getTextInputValue("emoji") || undefined,
  });
  if (!r.ok) { await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral }); return; }
  await respond(interaction, {
    content: `Category **${r.category.label}** ${r.category.emoji} is ready.`,
    flags: MessageFlags.Ephemeral,
  });
  await r.effects();
}

// ---------- /config roles panel handlers (M13-T5) ----------
// Resolves a role id to its current name via the guild's role cache — kept
// separate from rolesRemoveSelectOptions so that helper stays pure/testable
// without discord.js.
function roleNameResolver(interaction) {
  return (id) => interaction.guild?.roles.cache.get(id)?.name;
}

async function updateRolesPanel(interaction, data) {
  // F2: wrap for consistency with the other panel handlers, even though
  // there's no post-ack slow REST here to protect — a failed ack shouldn't
  // surface as an unhandled throw up to the top-level "Something went wrong".
  try {
    await interaction.update({
      embeds: [rolesPanelEmbed(data)],
      components: rolesPanelComponents(data, roleNameResolver(interaction)),
    });
  } catch {
    await respond(interaction, {
      embeds: [rolesPanelEmbed(data)],
      components: rolesPanelComponents(data, roleNameResolver(interaction)),
      flags: MessageFlags.Ephemeral,
    });
  }
}

// roles:add — RoleSelectMenu pick to add a manager role. F3: re-check
// ManageGuild (not the weaker isManager) — this panel is spawned by
// /config roles, which is itself gated on ManageGuild; the panel's customIds
// aren't bound to the member who ran the command, so a differently-
// permissioned member could click it.
async function handleRolesAddSelect(interaction) {
  // F4: a RoleSelectMenu offers every role including @everyone and
  // integration-managed (bot) roles; the action refuses both (see `unassignable`).
  await rolesPanelAction(interaction, (actor) =>
    actions().addManagerRole(helpCtx(), actor, { role: pickedRole(interaction), guildId: interaction.guild.id })
  );
}

// roles:remove — StringSelect populated with only the CURRENT manager roles
// (rolesRemoveSelectOptions), so the picked id is always a real manager role.
async function handleRolesRemoveSelect(interaction) {
  await rolesPanelAction(interaction, (actor) =>
    actions().removeManagerRole(helpCtx(), actor, { roleId: interaction.values[0] })
  );
}

// roles:notify — RoleSelectMenu pick to set the request-ping role. Same
// @everyone/managed-role guard as roles:add.
async function handleRolesNotifySelect(interaction) {
  await rolesPanelAction(interaction, (actor) =>
    actions().setNotifyRole(helpCtx(), actor, { role: pickedRole(interaction), guildId: interaction.guild.id })
  );
}

// roles:notifyclear — button to turn request pings back off. F3: ManageGuild
// re-check, matching the other /config roles handlers.
async function handleRolesNotifyClear(interaction) {
  await rolesPanelAction(interaction, (actor) =>
    actions().setNotifyRole(helpCtx(), actor, { role: null, guildId: interaction.guild?.id })
  );
}

// The role a RoleSelectMenu pick points at, in the shape the actions take.
function pickedRole(interaction) {
  const id = interaction.values[0];
  return { id, managed: interaction.guild.roles.cache.get(id)?.managed === true };
}

// Shared body of the four /config roles panel handlers. F3: re-check
// ManageGuild (not the weaker isManager) — the panel is spawned by /config
// roles, which is itself gated on ManageGuild, but its customIds aren't bound
// to the member who ran the command, so a differently-permissioned member
// could click it. `run(actor)` calls the action; a refusal re-renders the
// panel with the reason, a success re-renders it from the saved data.
async function rolesPanelAction(interaction, run) {
  const data = loadData();
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.update({ content: "Manage Server only.", embeds: [], components: [] });
    return;
  }
  const r = run(actorOf(interaction, data));
  if (!r.ok) {
    await interaction.update({
      content: r.error,
      embeds: [rolesPanelEmbed(data)],
      components: rolesPanelComponents(data, roleNameResolver(interaction)),
    });
    return;
  }
  await updateRolesPanel(interaction, r.data);
}

// The /reset confirm/cancel buttons. A different member could click these than
// the one who ran /reset (the warning is ephemeral but the customId isn't
// bound to a user), so re-check isManager here — don't trust the slash-command
// check alone.
async function handleResetButton(interaction) {
  const data = loadData();
  if (!isManager(interaction, data)) {
    await interaction.update({ content: "Managers only.", embeds: [], components: [] });
    return;
  }
  const parts = interaction.customId.split(":");
  const action = parts[1]; // confirm | cancel

  if (action === "cancel") {
    await interaction.update({ content: "Cancelled — nothing changed.", embeds: [], components: [] });
    return;
  }
  if (action === "confirm") {
    // F1: the confirm customId carries the issuedTs of the warning panel it
    // came from. A panel left open for minutes (or a second officer's panel)
    // could otherwise wipe against whatever is current, silently closing
    // requests filed after the officer last saw the waiting count. Refuse
    // and re-render a fresh warning instead of wiping when stale.
    const issuedTs = Number(parts[2]);
    if (!Number.isFinite(issuedTs) || resetConfirmStale(issuedTs, Date.now(), RESET_CONFIRM_TTL_MS)) {
      await interaction.update({
        content: "⚠️ This confirmation expired — review and confirm again.",
        embeds: [resetWarningEmbed(data)],
        components: resetWarningComponents(Date.now()),
      });
      return;
    }
    // The wipe itself is the shared action (sync load → closeSeason → save).
    const r = actions().reset(helpCtx(), actorOf(interaction, data));
    if (!r.ok) {
      await interaction.update({ content: r.error, embeds: [], components: [] });
      return;
    }
    // F2: the ack can fail on its own (panel dismissed, transient 5xx,
    // Unknown Message 10008) — wrap it so a throw here can't skip the
    // post-ack REST below (cards + board), which must always run since the
    // save already committed the season wipe.
    try {
      await interaction.update({ content: "Season reset — the board is clear.", embeds: [], components: [] });
    } catch {
      await respond(interaction, { content: "Season reset — the board is clear.", flags: MessageFlags.Ephemeral });
    }
    // Slow REST after the ack + save: close any open request cards so they
    // don't linger looking actionable, then refresh the live board.
    await r.effects();
    return;
  }
  await respond(interaction, { content: "Unknown action.", flags: MessageFlags.Ephemeral });
}

// Acks the imsorted panel for a sorted/closeAll action result, then runs its
// slow REST (cards + board) after the ack. The ack can fail on its own (panel
// dismissed, 5xx, Unknown Message 10008) — the save already happened, so the
// effects must still run.
async function finishImsorted(interaction, r, emptyText) {
  if (!r.ok) {
    await interaction.update({ content: r.code === "not_found" ? emptyText : r.error, embeds: [], components: [] });
    return;
  }
  const n = r.closed.length;
  const confirmText = `Marked ${n} request${n === 1 ? "" : "s"} sorted.`;
  try {
    await interaction.update({ content: confirmText, embeds: [], components: [] });
  } catch {
    await respond(interaction, { content: confirmText, flags: MessageFlags.Ephemeral });
  }
  await r.effects();
}

// imsorted:pick — the caller multi-selected specific entries to close. Never
// trust the select values alone: the action filters to entries actually owned
// by the clicking user (and still open) before closing anything.
async function handleImsortedSelect(interaction) {
  const r = actions().sorted(helpCtx(), actorOf(interaction, loadData()), { entryIds: interaction.values });
  await finishImsorted(interaction, r, "Those requests are already gone.");
}

// imsorted:all — the "close all" convenience button from the panel.
async function handleImsortedButton(interaction) {
  const action = interaction.customId.split(":")[1];
  if (action !== "all") {
    await respond(interaction, { content: "Unknown action.", flags: MessageFlags.Ephemeral });
    return;
  }
  const r = actions().closeAll(helpCtx(), actorOf(interaction, loadData()));
  await finishImsorted(interaction, r, "You have no open requests.");
}

// resolve:<action>:member — the manager picked a member. Re-check isManager
// server-side (a component click doesn't re-run the slash-command permission
// gate). No dead-end: if the member has no open entries, say so instead of
// erroring.
async function handleResolveMemberSelect(interaction) {
  const action = interaction.customId.split(":")[1];
  const data = loadData();
  if (!isManager(interaction, data)) {
    await interaction.update({ content: "Managers only.", embeds: [], components: [] });
    return;
  }
  await interaction.deferUpdate();
  const memberId = interaction.values[0];
  const name = (await memberName(interaction.guild, memberId)) || "(left the server)";
  await interaction.editReply(entryStepPanelPayload(data, action, memberId, name));
}

// resolve:<action>:entry — the manager picked which of the member's open
// requests to resolve. Fresh loadData() + re-find by id here (invariant #1):
// this is a separate interaction from the member-pick step, so nothing
// carried over from it is trusted as still-current.
async function handleResolveEntrySelect(interaction) {
  const action = interaction.customId.split(":")[1];
  const data = loadData();
  if (!isManager(interaction, data)) {
    await interaction.update({ content: "Managers only.", embeds: [], components: [] });
    return;
  }
  const act = action === "helped" ? actions().helped : actions().remove;
  const r = act(helpCtx(), actorOf(interaction, data), { entryId: interaction.values[0] });
  if (!r.ok) {
    await interaction.update({
      content: r.code === "not_found" ? "That request is already gone." : r.error,
      embeds: [],
      components: [],
    });
    return;
  }
  const confirmText =
    action === "helped"
      ? `✅ Marked **${r.entry.username}** as sorted for ${r.category.label}.`
      : `Removed ${r.entry.username}'s entry.`;
  // F2: the ack can fail on its own (panel dismissed, transient 5xx, Unknown
  // Message 10008) — the save already happened, so the effects (card, DM,
  // board) must still run.
  try {
    await interaction.update({ content: confirmText, embeds: [], components: [] });
  } catch {
    await respond(interaction, { content: confirmText, flags: MessageFlags.Ephemeral });
  }
  await r.effects();
}

// The whole legacy dispatch; the core router calls it for every interaction
// whose command or customId prefix belongs to the help module.
async function dispatch(interaction) {
  try {
    if (interaction.isAutocomplete()) {
      try {
        const focused = interaction.options.getFocused(true);
        if (focused.name === "category" || focused.name === "moveto") {
          const data = loadData();
          const excludeId = focused.name === "moveto" ? interaction.options.getString("category") || undefined : undefined;
          await interaction.respond(categorySuggestions(data, focused.value, excludeId));
        } else {
          await interaction.respond([]);
        }
      } catch {
        try { await interaction.respond([]); } catch {}
      }
      return;
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("board:")) { await handleBoardButton(interaction); return; }
      if (interaction.customId.startsWith("season:")) { await handleSeasonButton(interaction); return; }
      if (interaction.customId.startsWith("reset:")) { await handleResetButton(interaction); return; }
      if (interaction.customId.startsWith("imsorted:")) { await handleImsortedButton(interaction); return; }
      if (interaction.customId === "roles:notifyclear") { await handleRolesNotifyClear(interaction); return; }
      await handleButton(interaction);
      return;
    }
    if (interaction.isRoleSelectMenu() && interaction.customId === "roles:add") {
      await handleRolesAddSelect(interaction);
      return;
    }
    if (interaction.isRoleSelectMenu() && interaction.customId === "roles:notify") {
      await handleRolesNotifySelect(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === "roles:remove") {
      await handleRolesRemoveSelect(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === "board:pick") {
      await handleBoardSelect(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === "imsorted:pick") {
      await handleImsortedSelect(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === "season:view") {
      await handleSeasonSelect(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === "stats:view") {
      await handleStatsView(interaction);
      return;
    }
    if (
      interaction.isStringSelectMenu() &&
      (interaction.customId === "resolve:helped:entry" || interaction.customId === "resolve:remove:entry")
    ) {
      await handleResolveEntrySelect(interaction);
      return;
    }
    if (interaction.isUserSelectMenu() && interaction.customId === "stats:member") {
      await handleStatsMember(interaction);
      return;
    }
    if (
      interaction.isUserSelectMenu() &&
      (interaction.customId === "resolve:helped:member" || interaction.customId === "resolve:remove:member")
    ) {
      await handleResolveMemberSelect(interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("season:")) { await handleSeasonModal(interaction); return; }
      if (interaction.customId === "catadd:submit") { await handleCatAddModal(interaction); return; }
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    const data = loadData();

    if (interaction.commandName === "needhelp") {
      const r = actions().needHelp(helpCtx(), actorOf(interaction, data), {
        categoryId: interaction.options.getString("category"),
        note: interaction.options.getString("note") || "",
        channelId: interaction.channelId,
      });
      if (!r.ok) {
        await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral });
        return;
      }
      await respond(interaction, {
        content: `Added you to the board for **${r.category.label}**. ${r.category.emoji}`,
        flags: MessageFlags.Ephemeral,
      });
      await r.effects();
    }

    if (interaction.commandName === "imsorted") {
      const category = interaction.options.getString("category");
      if (category) {
        // Fast path (category given) — the shared action; legacy texts kept.
        const r = actions().sorted(helpCtx(), actorOf(interaction, data), { categoryId: category });
        if (!r.ok) {
          await respond(interaction, {
            content: r.code === "not_found" ? "You're not on the board right now." : r.error,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await respond(interaction, { content: "Took you off the board. Glad you got sorted! 🎉", flags: MessageFlags.Ephemeral });
        await r.effects();
        return;
      }
      // No category — self-service select panel (M13-T2).
      const mine = openEntriesFor(data, interaction.user.id);
      if (mine.length === 0) {
        await respond(interaction, {
          content: "You have no open requests.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const options = imsortedSelectOptions(data, mine, Date.now());
      await respond(interaction, {
        embeds: [imsortedPanelEmbed(mine.length)],
        components: imsortedPanelComponents(options),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.commandName === "stats") {
      await handleStatsCommand(interaction, data);
    }

    if (interaction.commandName === "season") {
      await handleSeasonCommand(interaction, data);
    }

    if (interaction.commandName === "help") {
      await respond(interaction, { embeds: [howItWorksEmbed()], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "helped") {
      if (!isManager(interaction, data)) {
        await respond(interaction, NO_PERM);
        return;
      }
      const member = interaction.options.getUser("member");
      const category = interaction.options.getString("category");
      if (!member) {
        // No member arg at all — resolve:helped picker panel (M13-T3).
        await respond(interaction, {
          embeds: [resolveMemberPanelEmbed("helped")],
          components: resolveMemberPanelComponents("helped"),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!category) {
        // F5: member given, category omitted — skip the UserSelect and go
        // straight to that member's entry-step panel instead of discarding
        // the pick. getMember() reads the GuildMember Discord already
        // resolved into the interaction payload — no extra REST fetch, so
        // there's no slow work before the ack.
        const name = interaction.options.getMember("member")?.displayName || member.username;
        await respond(interaction, {
          ...entryStepPanelPayload(data, "helped", member.id, name),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Fast path (both given) — the shared action; legacy texts kept.
      const r = actions().helped(helpCtx(), actorOf(interaction, data), { userId: member.id, categoryId: category });
      if (!r.ok) {
        await respond(interaction, {
          content:
            r.code === "not_found"
              ? `No pending entry found for ${member.username} in ${catOf(data, category).label}.`
              : r.error,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await respond(interaction, `✅ Marked **${r.entry.username}** as sorted for ${r.category.label}.`);
      await r.effects();
    }

    if (interaction.commandName === "remove") {
      if (!isManager(interaction, data)) {
        await respond(interaction, NO_PERM);
        return;
      }
      const member = interaction.options.getUser("member");
      const category = interaction.options.getString("category");
      if (!member) {
        // No member arg at all — resolve:remove picker panel (M13-T3).
        await respond(interaction, {
          embeds: [resolveMemberPanelEmbed("remove")],
          components: resolveMemberPanelComponents("remove"),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!category) {
        // F5: member given, category omitted — skip the UserSelect and go
        // straight to that member's entry-step panel instead of discarding
        // the pick. getMember() reads the GuildMember Discord already
        // resolved into the interaction payload — no extra REST fetch, so
        // there's no slow work before the ack.
        const name = interaction.options.getMember("member")?.displayName || member.username;
        await respond(interaction, {
          ...entryStepPanelPayload(data, "remove", member.id, name),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Fast path (both given) — the shared action; legacy texts kept.
      const r = actions().remove(helpCtx(), actorOf(interaction, data), { userId: member.id, categoryId: category });
      if (!r.ok) {
        await respond(interaction, {
          content:
            r.code === "not_found"
              ? `No pending entry found for ${member.username} in ${catOf(data, category).label}.`
              : r.error,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await respond(interaction, { content: `Removed ${member.username}'s entry.`, flags: MessageFlags.Ephemeral });
      await r.effects();
    }

    if (interaction.commandName === "board") {
      if (!isManager(interaction, data)) {
        await respond(interaction, NO_PERM);
        return;
      }
      // Multiple REST calls follow — defer so we never miss the 3-second window.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const r = await actions().repostBoard(helpCtx(), actorOf(interaction, data), { channel: interaction.channel });
      await respond(interaction, {
        content: !r.ok
          ? r.error
          : r.pinned
            ? "Board posted and pinned. It'll update live from now on."
            : "Board posted — it'll update live from now on. I couldn't pin it: give me the **Pin Messages** permission in this channel, then run `/board` again.",
      });
    }

    if (interaction.commandName === "reset") {
      if (!isManager(interaction, data)) {
        await respond(interaction, NO_PERM);
        return;
      }
      // The wipe itself now lives behind the reset:confirm button (see
      // handleResetButton) — this just shows the warning + waiting count.
      await respond(interaction, {
        embeds: [resetWarningEmbed(data)],
        components: resetWarningComponents(Date.now()),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.commandName === "config") {
      // Defense in depth: setDefaultMemberPermissions can be relaxed by admins in
      // Discord's Integration settings, so re-check Manage Server in code too.
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await respond(interaction, {
          content:
            "Only members with **Manage Server** can change bot settings.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const sub = interaction.options.getSubcommand();

      const group = interaction.options.getSubcommandGroup(false);
      if (group === "category") {
        const catSub = interaction.options.getSubcommand();

        if (catSub === "add") {
          const label = interaction.options.getString("label");
          if (!label) {
            const labelInput = new TextInputBuilder()
              .setCustomId("label")
              .setLabel("Category name")
              .setStyle(TextInputStyle.Short)
              .setMaxLength(MAX_LABEL)
              .setRequired(true)
              .setPlaceholder("e.g. Guild Boss");
            const emojiInput = new TextInputBuilder()
              .setCustomId("emoji")
              .setLabel("Emoji")
              .setStyle(TextInputStyle.Short)
              .setMaxLength(32)
              .setRequired(false)
              .setPlaceholder("e.g. 👹");
            const modal = new ModalBuilder()
              .setCustomId("catadd:submit")
              .setTitle("Add a category")
              .addComponents(
                new ActionRowBuilder().addComponents(labelInput),
                new ActionRowBuilder().addComponents(emojiInput)
              );
            await interaction.showModal(modal);
            return;
          }
          const r = actions().addCategory(helpCtx(), actorOf(interaction, data), {
            label,
            emoji: interaction.options.getString("emoji") || "",
          });
          if (!r.ok) { await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral }); return; }
          await respond(interaction, {
            content: `Category **${r.category.label}** ${r.category.emoji} is ready.`,
            flags: MessageFlags.Ephemeral,
          });
          await r.effects();
          return;
        }

        if (catSub === "remove") {
          const r = actions().archiveCategory(helpCtx(), actorOf(interaction, data), {
            categoryId: interaction.options.getString("category"),
            moveto: interaction.options.getString("moveto") || undefined,
          });
          if (!r.ok) { await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral }); return; }
          const extra = r.moved.length ? ` Moved ${r.moved.length} open request(s) to **${r.movetoLabel}**.` : "";
          const merged = r.dropped.length ? ` Merged ${r.dropped.length} duplicate(s).` : "";
          await respond(interaction, {
            content: `Archived **${r.label}**.${extra}${merged}`,
            flags: MessageFlags.Ephemeral,
          });
          // Slow REST after the ack: the board first, then the dropped/moved cards.
          await r.effects();
          return;
        }

        if (catSub === "list") {
          const active = activeCategories(data)
            .map((c) => `${c.emoji} **${c.label}** \`${c.id}\``)
            .join("\n") || "_none_";
          const archived = (data.categories || [])
            .filter((c) => c.archived)
            .map((c) => `${c.emoji} ~~${c.label}~~ \`${c.id}\``)
            .join("\n");
          await respond(interaction, {
            content: `**Active categories:**\n${active}${archived ? `\n\n**Archived:**\n${archived}` : ""}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
          return;
        }
      }

      if (group === "nudge") {
        const nSub = interaction.options.getSubcommand();

        if (nSub === "set") {
          const channel = interaction.options.getChannel("channel");
          const hours = interaction.options.getInteger("hours"); // null if omitted
          const r = actions().setNudge(helpCtx(), actorOf(interaction, data), { channelId: channel.id, hours: hours ?? undefined });
          if (!r.ok) { await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral }); return; }
          await respond(interaction, {
            content: `Stale nudges **on** — daily digest to <#${channel.id}> for requests older than **${r.data.nudgeThresholdHours}h**.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (nSub === "off") {
          const r = actions().nudgeOff(helpCtx(), actorOf(interaction, data));
          await respond(interaction, { content: r.ok ? "Stale nudges **off**." : r.error, flags: MessageFlags.Ephemeral });
          return;
        }

        if (nSub === "status") {
          if (!data.nudgeChannelId) {
            await respond(interaction, { content: "Stale nudges **off**. Use `/config nudge set` to enable.", flags: MessageFlags.Ephemeral });
            return;
          }
          const dueTs = (data.lastNudgeTs || 0) + NUDGE_CADENCE_MS;
          const nextLine = data.lastNudgeTs ? `next digest eligible <t:${Math.floor(dueTs / 1000)}:R>` : "next digest eligible on the next hourly check";
          await respond(interaction, {
            content: `Stale nudges **on** → <#${data.nudgeChannelId}>, threshold **${data.nudgeThresholdHours ?? 48}h**, ${nextLine}.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      if (sub === "addrole") {
        const role = interaction.options.getRole("role");
        const r = actions().addManagerRole(helpCtx(), actorOf(interaction, data), { role, guildId: interaction.guildId });
        if (!r.ok) { await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral }); return; }
        await respond(interaction, {
          content: r.added
            ? `Added **${role.name}** as a manager role. Members with it can now run the officer commands.`
            : `**${role.name}** is already a manager role.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "removerole") {
        const role = interaction.options.getRole("role");
        const r = actions().removeManagerRole(helpCtx(), actorOf(interaction, data), { roleId: role.id });
        if (!r.ok) { await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral }); return; }
        await respond(interaction, {
          content: r.removed ? `Removed **${role.name}** from manager roles.` : `**${role.name}** isn't a manager role.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "notify") {
        const role = interaction.options.getRole("role");
        const r = actions().setNotifyRole(helpCtx(), actorOf(interaction, data), { role, guildId: interaction.guildId });
        if (!r.ok) { await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral }); return; }
        await respond(interaction, {
          content: role ? `New requests will now ping **${role.name}**.` : "Turned off request pings.",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "roles") {
        await respond(interaction, {
          embeds: [rolesPanelEmbed(data)],
          components: rolesPanelComponents(data, roleNameResolver(interaction)),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isAutocomplete()) return;
    await respond(interaction, {
      content: "Something went wrong running that command.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

module.exports = {
  formatDuration,
  renderField,
  catOf,
  isManager,
  actorOf,
  buildBoardEmbed,
  loadData,
  saveData,
  tallyHelpers,
  defaultCategories,
  emptyData,
  categoryMap,
  activeCategories,
  countByCategory,
  slugify,
  addCategory,
  removeCategory,
  setNudgeConfig,
  clearNudge,
  readAndShape,
  categorySuggestions,
  hasOpenEntry,
  openEntriesFor,
  imsortedSelectOptions,
  resolveEntryAsSorted,
  resolveEntryAsRemoved,
  resolveMemberPanelEmbed,
  resolveMemberPanelComponents,
  resolveEntryPanelEmbed,
  resolveEntryPanelComponents,
  rolesPanelEmbed,
  rolesRemoveSelectOptions,
  rolesPanelComponents,
  imsortedPanelEmbed,
  newHelpEntry,
  cardDescription,
  categorySelectOptions,
  toggleClaim,
  releaseClaim,
  isGoneError,
  applyStaleClaimRelease,
  resolveNames,
  seasonLabel,
  closeSeason,
  beginSeason,
  renameSeason,
  seasonPanelEmbed,
  seasonSelectOptions,
  resetWarningEmbed,
  resetWarningComponents,
  resetConfirmStale,
  RESET_CONFIRM_TTL_MS,
  entryStepPanelPayload,
  makeRecord,
  logRecord,
  closeEntries,
  RECORD_CAP,
  recordsForSeason,
  helperTotals,
  requesterTotals,
  categoryWait,
  helperBreakdown,
  demandSummary,
  staleEntries,
  dueForNudge,
  nudgeDigestEmbed,
  statsViewOptions,
  selectedViewFrom,
  currentStatsEmbed,
  allTimeEmbed,
  memberEmbed,
  seasonHelperEmbed,
  commands,
  dispatch,
  bind,
  onReady,
  announceEntry,
  resolveCard,
  refreshBoard,
  rerenderCard,
  dmSorted,
  needHelpRow,
  howItWorksEmbed,
  statsEmbedFor,
  memberName,
};
