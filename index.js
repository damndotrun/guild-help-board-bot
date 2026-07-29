// Guild Help Board — Discord bot
// Tracks who needs help with Season Run 5K / MVP 5K for season rewards,
// and lets officers mark them as sorted once helped.

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
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

// Data lives next to the code by default; set DATA_DIR to keep data.json on a
// persistent volume when the code itself is ephemeral (e.g. re-cloned on boot).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const TMP_FILE = path.join(DATA_DIR, "data.json.tmp");
const BAK_FILE = path.join(DATA_DIR, "data.json.bak");

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

function categorySuggestions(data, typed) {
  const q = (typed || "").toLowerCase();
  return activeCategories(data)
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
    nudgeThresholdHours: Number.isInteger(parsed.nudgeThresholdHours) ? parsed.nudgeThresholdHours : 48,
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
    categories:
      Array.isArray(parsed.categories) && parsed.categories.length
        ? parsed.categories
        : defaultCategories(),
  };
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
      fs.copyFileSync(DATA_FILE, BAK_FILE);
    }
  } catch (err) {
    console.error(
      "Skipped data.json.bak (current data.json unreadable or copy failed):",
      err.message
    );
  }
  fs.renameSync(TMP_FILE, DATA_FILE);
}

// ---------- lock (single-instance advisory) ----------
const LOCK_FILE = path.join(DATA_DIR, "bot.lock");
const LOCK_STALE_MS = 90_000; // treat a lock older than this as abandoned
const LOCK_REFRESH_MS = 30_000; // heartbeat cadence (well under the stale window)

const NUDGE_TICK_MS = 60 * 60 * 1000;      // hourly tick
const NUDGE_CADENCE_MS = 24 * 60 * 60 * 1000; // at most one digest per day
const NUDGE_MAX_HOURS = 8760;              // 1 year — sane upper bound for the threshold

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return null; // no lock, or unreadable — treat as absent
  }
}

// Advisory only: a fresh heartbeat means another instance is probably alive.
function isLockFresh(lock, now) {
  return (
    !!lock &&
    typeof lock.heartbeat === "number" &&
    now - lock.heartbeat < LOCK_STALE_MS
  );
}

// Write the lock and keep a heartbeat. NEVER blocks startup: on a fresh lock we
// only warn (the deploy model is a clean swap, so a real double-run is a local
// accident, and a stale lock must never wedge the "restart = update" path).
function acquireLock() {
  const now = Date.now();
  const existing = readLock();
  if (isLockFresh(existing, now)) {
    console.warn(
      `WARNING: bot.lock heartbeat is fresh (pid ${existing.pid}); another ` +
        `instance may be running against ${DATA_FILE}. Starting anyway.`
    );
  }
  const write = (ts) =>
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, startedTs: now, heartbeat: ts })
    );
  try {
    write(now);
  } catch (err) {
    console.error("Could not write bot.lock:", err.message);
  }
  const timer = setInterval(() => {
    try {
      write(Date.now());
    } catch {
      // transient FS error — the next tick will retry
    }
  }, LOCK_REFRESH_MS);
  timer.unref(); // never keep the process alive for the heartbeat alone
  return timer;
}

// Who may run the officer commands: anyone with Manage Server, OR anyone holding
// a role that an admin added via /config. With no manager roles set, it falls
// back to Manage Server only — so you can never lock yourself out.
function isManager(interaction, data) {
  const perms = interaction.memberPermissions;
  if (perms && perms.has(PermissionFlagsBits.ManageGuild)) return true;
  const roleIds = data.managerRoleIds || [];
  if (roleIds.length === 0) return false;
  const cache = interaction.member?.roles?.cache;
  if (cache) return roleIds.some((id) => cache.has(id));
  return false;
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
  return now - (data.lastNudgeTs || 0) >= cadenceMs;
}

// Build the reminder digest: stale requests grouped by category, each showing
// the requester's live name and how long they've waited. now injected.
function nudgeDigestEmbed(data, stale, names, now) {
  const byCat = {};
  for (const e of stale) (byCat[e.category] || (byCat[e.category] = [])).push(e);
  const fields = [];
  for (const id of Object.keys(byCat)) {
    const c = catOf(data, id);
    const lines = byCat[id]
      .slice()
      .sort((a, b) => a.ts - b.ts) // longest-waiting first
      .map((e) => `• ${names[e.userId] || "(left the server)"} — waiting **${formatDuration(now - e.ts)}**`);
    fields.push({ name: `${c.emoji} ${c.label}`, value: renderField(lines) });
  }
  return new EmbedBuilder()
    .setColor(0xd9822b)
    .setTitle(`⏰ ${stale.length} request(s) still waiting`)
    .setDescription(`These have waited longer than **${data.nudgeThresholdHours ?? 48}h**. Anyone free to help?`)
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
      { name: "Past seasons", value: pastLines.length ? renderField(pastLines) : "None yet." }
    );
}

function seasonPanelComponents(data) {
  const select = new StringSelectMenuBuilder()
    .setCustomId("season:view")
    .setPlaceholder("View a season…")
    .addOptions(seasonSelectOptions(data));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("season:new").setLabel("New season").setEmoji("▶️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("season:rename").setLabel("Rename current").setEmoji("✏️").setStyle(ButtonStyle.Secondary)
  );
  return [new ActionRowBuilder().addComponents(select), buttons];
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
      opt.setName("member").setDescription("Who got helped").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("Which category")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a member's entry without marking it done")
    .addUserOption((opt) =>
      opt.setName("member").setDescription("Who to remove").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("Which category")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("board")
    .setDescription("Post the help board in this channel (becomes the live board)"),

  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Clear the board for a new season"),

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
      sub.setName("roles").setDescription("List roles and notification settings")
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
            .addStringOption((o) => o.setName("label").setDescription("Category name").setRequired(true))
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

// ---------- register commands ----------
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log("Slash commands registered.");
}

// ---------- client ----------
// parse: [] by default means no message ever pings anyone unless a specific call
// opts in (the request card explicitly allows the notify role). This neutralises
// mention injection via user-controlled nicknames in replies.
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [] },
});

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

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
    const r = toggleClaim(entry, interaction.user.id, Date.now());
    if (r.action === "blocked") {
      const holder = await memberName(interaction.guild, r.by);
      await respond(interaction, { content: `🙌 **${holder || "Another officer"}** is already on this.`, flags: MessageFlags.Ephemeral });
      return;
    }
    saveData(data);
    const cat = catOf(data, entry.category);
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x5ac9a1).setDescription(cardDescription(cat, entry, r.action === "claimed" ? byName : null)).setFooter({ text: "Officers: use the buttons below when it's handled" }).setTimestamp(entry.ts ? new Date(entry.ts) : null)],
      components: [requestButtons(entry.id)],
      allowedMentions: { parse: [] },
    });
    await refreshBoard(client, data);
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
  const category = interaction.values[0];
  const cats = categoryMap(data);
  if (!cats[category] || cats[category].archived) {
    await interaction.update({ content: "That category isn't available anymore.", components: [] });
    return;
  }
  if (hasOpenEntry(data, interaction.user.id, category)) {
    await interaction.update({ content: `You're already on the board for **${catOf(data, category).label}**.`, components: [] });
    return;
  }
  const entry = newHelpEntry(
    interaction.user.id,
    interaction.member?.displayName || interaction.user.username,
    category,
    ""
  );
  data.entries.push(entry);
  saveData(data);
  await interaction.update({ content: `Added you to the board for **${catOf(data, category).label}** ${catOf(data, category).emoji} ✅`, components: [] });
  await announceEntry(client, entry, interaction.channelId);
}

async function handleStatsCommand(interaction, data) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const top = tallyHelpers(data.entries).slice(0, 15);
  const names = await resolveIds(interaction.guild, top.map(([id]) => id));
  await interaction.editReply({ embeds: [currentStatsEmbed(data, names)], components: statsPanelComponents(data, "current") });
}

async function handleStatsView(interaction) {
  await interaction.deferUpdate();
  const data = loadData();
  const value = interaction.values[0];
  if (value === "current") {
    const top = tallyHelpers(data.entries).slice(0, 15);
    const names = await resolveIds(interaction.guild, top.map(([id]) => id));
    await interaction.editReply({ embeds: [currentStatsEmbed(data, names)], components: statsPanelComponents(data, "current") });
    return;
  }
  if (value === "alltime") {
    const top = helperTotals(data.records || []).slice(0, 15);
    const names = await resolveIds(interaction.guild, top.map(([id]) => id));
    await interaction.editReply({ embeds: [allTimeEmbed(data, names)], components: statsPanelComponents(data, "alltime") });
    return;
  }
  const endedTs = Number(value);
  const season = (data.seasons || []).find((s) => s.endedTs === endedTs);
  if (!season) { await interaction.editReply({ content: "That season is gone.", embeds: [], components: statsPanelComponents(data, "current") }); return; }
  const top = helperTotals(recordsForSeason(data.records || [], season.startedTs)).slice(0, 15);
  const names = await resolveIds(interaction.guild, top.map(([id]) => id));
  await interaction.editReply({ embeds: [seasonHelperEmbed(data, season, names)], components: statsPanelComponents(data, value) });
}

async function handleStatsMember(interaction) {
  await interaction.deferUpdate();
  const data = loadData();
  const helperId = interaction.values[0];
  const name = (await memberName(interaction.guild, helperId)) || "(left the server)";
  await interaction.editReply({ embeds: [memberEmbed(data, helperId, name)], components: statsPanelComponents(data, "current") });
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
    const modal = new ModalBuilder().setCustomId("season:newmodal").setTitle("Start a new season").addComponents(new ActionRowBuilder().addComponents(input));
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
    const pending = data.entries.filter((e) => !e.done);
    const archived = closeSeason(data, Date.now());
    beginSeason(data, name, Date.now());
    saveData(data);                 // persist BEFORE slow REST
    const archivedNote = archived ? "Previous season archived, board cleared." : "Board cleared.";
    await interaction.reply({ content: `Started season **${seasonLabel(data.currentSeason)}**. ${archivedNote} 🌱`, flags: MessageFlags.Ephemeral });
    for (const e of pending) await resolveCard(client, e, "Season reset — this request is closed.");
    await refreshBoard(client, data);
    return;
  }

  if (interaction.customId.startsWith("season:renamemodal:")) {
    const rawTarget = interaction.customId.slice("season:renamemodal:".length);
    const target = rawTarget === "current" ? "current" : Number(rawTarget);
    const r = renameSeason(data, target, name);
    if (!r.ok) { await respond(interaction, { content: "Couldn't rename that season (it may be gone, or the name was blank).", flags: MessageFlags.Ephemeral }); return; }
    saveData(data);
    await interaction.reply({ content: `Renamed to **${seasonLabel(target === "current" ? data.currentSeason : data.seasons.find((s) => s.endedTs === target))}**.`, flags: MessageFlags.Ephemeral });
    if (target === "current") await refreshBoard(client, data); // board may show the season name later; safe no-op otherwise
    return;
  }
}

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      try {
        const focused = interaction.options.getFocused(true);
        if (focused.name === "category" || focused.name === "moveto") {
          const data = loadData();
          await interaction.respond(categorySuggestions(data, focused.value));
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
      await handleButton(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === "board:pick") {
      await handleBoardSelect(interaction);
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
    if (interaction.isUserSelectMenu() && interaction.customId === "stats:member") {
      await handleStatsMember(interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("season:")) { await handleSeasonModal(interaction); return; }
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    const data = loadData();

    if (interaction.commandName === "needhelp") {
      const category = interaction.options.getString("category");
      const note = interaction.options.getString("note") || "";
      const cats = categoryMap(data);
      if (!cats[category] || cats[category].archived) {
        await respond(interaction, {
          content: "That isn't an active category. Pick one from the list.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (hasOpenEntry(data, interaction.user.id, category)) {
        await respond(interaction, {
          content: `You're already on the board for ${catOf(data, category).label}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const entry = newHelpEntry(
        interaction.user.id,
        interaction.member?.displayName || interaction.user.username,
        category,
        note
      );
      data.entries.push(entry);
      saveData(data);
      await respond(interaction, {
        content: `Added you to the board for **${catOf(data, category).label}**. ${catOf(data, category).emoji}`,
        flags: MessageFlags.Ephemeral,
      });
      await announceEntry(client, entry, interaction.channelId);
    }

    if (interaction.commandName === "imsorted") {
      const category = interaction.options.getString("category");
      if (category && !categoryMap(data)[category]) {
        await respond(interaction, {
          content: "That isn't a known category. Pick one from the list.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const mine = data.entries.filter(
        (e) =>
          e.userId === interaction.user.id &&
          !e.done &&
          (!category || e.category === category)
      );
      if (mine.length === 0) {
        await respond(interaction, {
          content: "You're not on the board right now.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const ids = new Set(mine.map((e) => e.id));
      const nowTs = Date.now();
      for (const e of mine) logRecord(data, makeRecord(data, e, "self", nowTs));
      data.entries = data.entries.filter((e) => !ids.has(e.id));
      saveData(data);
      await respond(interaction, {
        content: "Took you off the board. Glad you got sorted! 🎉",
        flags: MessageFlags.Ephemeral,
      });
      for (const e of mine) {
        await resolveCard(client, e, `✅ ${e.username} marked themselves sorted`);
      }
      await refreshBoard(client, data);
    }

    if (interaction.commandName === "stats") {
      await handleStatsCommand(interaction, data);
    }

    if (interaction.commandName === "season") {
      await handleSeasonCommand(interaction, data);
    }

    if (interaction.commandName === "help") {
      const embed = new EmbedBuilder()
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
              "`/config roles` — show current settings\n" +
              "`/config category add <label> [emoji]` — add/update a category\n" +
              "`/config category remove <category> [moveto]` — archive (move open requests first)\n" +
              "`/config category list` — list categories\n" +
              "`/config nudge set #channel [hours]` — daily digest for long-waiting requests\n" +
              "`/config nudge off` — turn nudges off\n" +
              "`/config nudge status` — show nudge settings",
          }
        );
      await respond(interaction, {
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.commandName === "helped") {
      if (!isManager(interaction, data)) {
        await respond(interaction, NO_PERM);
        return;
      }
      const member = interaction.options.getUser("member");
      const category = interaction.options.getString("category");
      if (!categoryMap(data)[category]) {
        await respond(interaction, {
          content: "That isn't a known category. Pick one from the list.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const entry = data.entries.find(
        (e) => e.userId === member.id && e.category === category && !e.done
      );
      if (!entry) {
        await respond(interaction, {
          content: `No pending entry found for ${member.username} in ${catOf(data, category).label}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      entry.done = true;
      entry.doneTs = Date.now();
      entry.helpedBy = interaction.user.id;
      logRecord(data, makeRecord(data, entry, "sorted", Date.now()));
      saveData(data);
      await respond(
        interaction,
        `✅ Marked **${entry.username}** as sorted for ${catOf(data, category).label}.`
      );
      const byName = interaction.member?.displayName || interaction.user.username;
      await resolveCard(client, entry, `✅ Sorted by ${byName}`);
      await dmSorted(client, data, entry.userId, entry.category);
      await refreshBoard(client, data);
    }

    if (interaction.commandName === "remove") {
      if (!isManager(interaction, data)) {
        await respond(interaction, NO_PERM);
        return;
      }
      const member = interaction.options.getUser("member");
      const category = interaction.options.getString("category");
      if (!categoryMap(data)[category]) {
        await respond(interaction, {
          content: "That isn't a known category. Pick one from the list.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const target = data.entries.find(
        (e) => e.userId === member.id && e.category === category && !e.done
      );
      if (!target) {
        await respond(interaction, {
          content: `No pending entry found for ${member.username} in ${catOf(data, category).label}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      logRecord(data, makeRecord(data, target, "removed", Date.now()));
      data.entries = data.entries.filter((e) => e !== target);
      saveData(data);
      await respond(interaction, {
        content: `Removed ${member.username}'s entry.`,
        flags: MessageFlags.Ephemeral,
      });
      const byName = interaction.member?.displayName || interaction.user.username;
      await resolveCard(client, target, `🗑️ Removed by ${byName}`);
      await refreshBoard(client, data);
    }

    if (interaction.commandName === "board") {
      if (!isManager(interaction, data)) {
        await respond(interaction, NO_PERM);
        return;
      }
      // Multiple REST calls follow — defer so we never miss the 3-second window.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const names = await resolveNames(interaction.guild, data);
      const embed = buildBoardEmbed(data, names);
      const message = await interaction.channel.send({ embeds: [embed], components: [needHelpRow()] });
      try {
        await message.pin();
      } catch (e) {
        // missing perms to pin is non-fatal
      }

      // Retire the previous board, if any, so we don't leave a stale pinned copy.
      if (
        data.boardChannelId &&
        data.boardMessageId &&
        data.boardMessageId !== message.id
      ) {
        try {
          const oldChannel = await client.channels.fetch(data.boardChannelId);
          const oldMessage = await oldChannel.messages.fetch(data.boardMessageId);
          await oldMessage.unpin().catch(() => {});
          await oldMessage
            .edit({
              content: "_This board has been retired; a newer one was posted._",
              embeds: [],
              components: [],
            })
            .catch(() => {});
        } catch (e) {
          // old message already gone — nothing to retire
        }
      }

      // Re-load fresh before saving: entries may have been added during the
      // awaits above, and we must not clobber them with our stale snapshot.
      const fresh = loadData();
      fresh.boardChannelId = interaction.channel.id;
      fresh.boardMessageId = message.id;
      saveData(fresh);

      await respond(interaction, {
        content: "Board posted and pinned. It'll update live from now on.",
      });
    }

    if (interaction.commandName === "reset") {
      if (!isManager(interaction, data)) {
        await respond(interaction, NO_PERM);
        return;
      }
      const pending = data.entries.filter((e) => !e.done);
      closeSeason(data, Date.now());
      saveData(data);
      await respond(interaction, "Board cleared for the new season. 🌱");
      // Close any open request cards so they don't linger looking actionable.
      for (const e of pending) {
        await resolveCard(client, e, "Season reset — this request is closed.");
      }
      await refreshBoard(client, data);
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
          const emoji = interaction.options.getString("emoji") || "";
          const r = addCategory(data, label, emoji);
          if (!r.ok) { await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral }); return; }
          saveData(data);
          await respond(interaction, {
            content: `Category **${r.category.label}** ${r.category.emoji} is ready.`,
            flags: MessageFlags.Ephemeral,
          });
          await refreshBoard(client, data);
          return;
        }

        if (catSub === "remove") {
          const id = interaction.options.getString("category");
          const moveto = interaction.options.getString("moveto") || undefined;
          const r = removeCategory(data, id, moveto);
          if (!r.ok) { await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral }); return; }
          const nowTs = Date.now();
          for (const e of r.dropped || []) logRecord(data, makeRecord(data, e, "removed", nowTs));
          saveData(data);
          const label = catOf(data, id).label;
          const extra = r.moved?.length
            ? ` Moved ${r.moved.length} open request(s) to **${catOf(data, moveto).label}**.`
            : "";
          const merged = r.dropped?.length ? ` Merged ${r.dropped.length} duplicate(s).` : "";
          await respond(interaction, {
            content: `Archived **${label}**.${extra}${merged}`,
            flags: MessageFlags.Ephemeral,
          });
          // Slow REST after the ack: finalize dropped cards, re-render moved ones, refresh board.
          for (const e of r.dropped || []) await resolveCard(client, e, `Merged into ${catOf(data, moveto).label}.`);
          for (const e of r.moved || []) await rerenderCard(client, data, e);
          await refreshBoard(client, data);
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
          const r = setNudgeConfig(data, channel.id, hours ?? undefined);
          if (!r.ok) { await respond(interaction, { content: r.error, flags: MessageFlags.Ephemeral }); return; }
          saveData(data);
          await respond(interaction, {
            content: `Stale nudges **on** — daily digest to <#${channel.id}> for requests older than **${data.nudgeThresholdHours}h**.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (nSub === "off") {
          clearNudge(data);
          saveData(data);
          await respond(interaction, { content: "Stale nudges **off**.", flags: MessageFlags.Ephemeral });
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
        if (data.managerRoleIds.includes(role.id)) {
          await respond(interaction, {
            content: `**${role.name}** is already a manager role.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        data.managerRoleIds.push(role.id);
        saveData(data);
        await respond(interaction, {
          content: `Added **${role.name}** as a manager role. Members with it can now run the officer commands.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "removerole") {
        const role = interaction.options.getRole("role");
        const before = data.managerRoleIds.length;
        data.managerRoleIds = data.managerRoleIds.filter((id) => id !== role.id);
        if (data.managerRoleIds.length === before) {
          await respond(interaction, {
            content: `**${role.name}** isn't a manager role.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        saveData(data);
        await respond(interaction, {
          content: `Removed **${role.name}** from manager roles.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "notify") {
        const role = interaction.options.getRole("role");
        data.notifyRoleId = role ? role.id : null;
        saveData(data);
        await respond(interaction, {
          content: role
            ? `New requests will now ping **${role.name}**.`
            : "Turned off request pings.",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "roles") {
        const roles =
          data.managerRoleIds.length > 0
            ? data.managerRoleIds.map((id) => `<@&${id}>`).join(", ")
            : "_none_ (only Manage Server can manage)";
        const notify = data.notifyRoleId
          ? `<@&${data.notifyRoleId}>`
          : "_off_";
        await respond(interaction, {
          content: `**Manager roles:** ${roles}\n**Request pings:** ${notify}`,
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
});

module.exports = {
  formatDuration,
  renderField,
  catOf,
  isManager,
  buildBoardEmbed,
  loadData,
  saveData,
  tallyHelpers,
  isLockFresh,
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
  newHelpEntry,
  cardDescription,
  categorySelectOptions,
  toggleClaim,
  resolveNames,
  seasonLabel,
  closeSeason,
  beginSeason,
  renameSeason,
  seasonPanelEmbed,
  seasonSelectOptions,
  makeRecord,
  logRecord,
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
  currentStatsEmbed,
  allTimeEmbed,
  memberEmbed,
  seasonHelperEmbed,
};

if (require.main === module) {
  const REQUIRED_ENV = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID"];
  const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missingEnv.length > 0) {
    console.error(
      `Missing required environment variable(s): ${missingEnv.join(", ")}.\n` +
        "Copy .env.example to .env and fill them in (see README)."
    );
    process.exit(1);
  }
  acquireLock();

  // Remove the advisory lock on graceful shutdown (Docker sends SIGTERM on stop)
  // so a fast redeploy doesn't see our own stale heartbeat and false-warn.
  const releaseLock = () => {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      // already gone or unremovable — nothing to do
    }
  };
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      releaseLock();
      process.exit(0);
    });
  }

  (async () => {
    try {
      await registerCommands();
      await client.login(process.env.DISCORD_TOKEN);
    } catch (err) {
      console.error("Failed to start the bot:", err);
      process.exit(1);
    }
  })();
}

// Last-resort safety net so a stray rejection is logged, not silently fatal.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
