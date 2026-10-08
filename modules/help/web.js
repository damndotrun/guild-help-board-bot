// The help board's web admin pages (M2 spec §6), mounted at /help by the web
// core. GET handlers only read (loadData + read-only name lookups); every
// POST goes through ./actions — the same functions the slash commands and
// /menu call — and the web core runs the action's `effects` after the
// response. Each page is a view model (a pure-ish function, tested on its
// own) plus an EJS fragment in ./views that sees only `page`.
const path = require("node:path");
const { ChannelType } = require("discord.js");
const help = require("./help");
const actions = require("./actions");

const BASE = "/help";
const V = (name) => path.join(__dirname, "views", `${name}.ejs`);

const nav = [
  { label: "Overview", path: "/", minLevel: "officer" },
  { label: "Seasons", path: "/seasons", minLevel: "officer" },
  { label: "Stats", path: "/stats", minLevel: "officer" },
  { label: "Categories", path: "/categories", minLevel: "owner" },
  { label: "Settings", path: "/settings", minLevel: "owner" },
];

// "2026-09-30", or "—" for anything that is not a usable timestamp (missing,
// non-finite, or a finite number outside the Date range). Never throws.
function dateOf(ts) {
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const day = d.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "—"; // years beyond 9999 print with a sign
}

// Shown by Stats (unknown ?view=) and Seasons (unknown rename target).
const SEASON_GONE = "That season isn't available anymore.";

function catLabel(data, id) {
  const c = help.catOf(data, id);
  return `${c.emoji} ${c.label}`;
}

// Name lookups are Discord REST, which discord.js may retry and sleep through
// on a rate limit. A page runs them under `lookup.deadline` (the routes pass
// web.withDeadline); past it the page shows `fallback` — the stored names /
// "—" — and logs ONE warning, instead of hanging. No deadline (the models'
// default, used by tests) = wait for the lookups.
async function namesWithin(lookup, promise, fallback) {
  if (!lookup.deadline) return promise;
  try {
    return await lookup.deadline(promise);
  } catch (err) {
    lookup.log?.warn(`[web] ${err?.message ?? err} — showing stored names`);
    return fallback;
  }
}

// ---------- Overview ----------

// lookup = { deadline?, log? } — see namesWithin.
async function overviewModel(guild, data, now, lookup = {}) {
  const open = data.entries.filter((e) => !e.done).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const top = help.tallyHelpers(data.entries).slice(0, 5);
  // Both lookups under ONE deadline (the page waits at most once). resolveNames is read-only.
  const [names, helperNames] = await namesWithin(
    lookup,
    Promise.all([help.resolveNames(guild, data), help.resolveIds(guild, top.map(([id]) => id))]),
    [{}, {}]
  );
  const cur = data.currentSeason || {};
  return {
    base: BASE,
    season: {
      name: help.seasonLabel(cur),
      started: dateOf(cur.startedTs),
      sorted: data.entries.filter((e) => e.done).length,
    },
    open: open.map((e) => ({
      who: names[e.userId] || e.username || "someone",
      category: catLabel(data, e.category),
      waiting: Number.isFinite(e.ts) && now >= e.ts ? help.formatDuration(now - e.ts) : "—",
      note: e.note || "",
      claimedBy: e.claimedBy ? names[e.claimedBy] || null : null,
    })),
    topHelpers: top.map(([id, n]) => ({ name: helperNames[id] || "—", count: n })),
  };
}

// ---------- Seasons ----------

// Past seasons: "requests · helped" from the per-request records; a season
// from before the records existed shows only its archived sorted total.
function seasonsModel(data) {
  const cur = data.currentSeason || {};
  const past = pastSeasons(data).map((s) => {
    const recs = help.recordsForSeason(data.records, s.startedTs);
    return {
      target: String(s.endedTs),
      name: help.seasonLabel(s),
      ended: dateOf(s.endedTs),
      requests: recs.length > 0 ? recs.length : null,
      helped: recs.length > 0 ? recs.filter((r) => r.resolution === "sorted").length : s.sortedTotal || 0,
    };
  });
  return {
    base: BASE,
    maxName: actions.MAX_SEASON_NAME,
    current: {
      name: help.seasonLabel(cur),
      named: !!cur.name,
      started: dateOf(cur.startedTs),
      sorted: data.entries.filter((e) => e.done).length,
      waiting: data.entries.filter((e) => !e.done).length,
    },
    past,
  };
}

// One sentence for both season confirmations (Start new season, Reset): how
// many requests are waiting right now, with a real zero case.
const waitingNow = (n) => {
  if (n === 0) return "Nobody is waiting right now.";
  return `${n === 1 ? "1 request is" : `${n} requests are`} waiting right now.`;
};

// The state a Start-new-season / Reset confirmation is about. Every close or
// begin re-stamps currentSeason.startedTs, so a replayed confirmation no
// longer matches. That stamp is what protects: the archive count alone would
// stop moving once closeSeason's 12-season cap is reached.
const seasonGuard = (data) => `${(data.seasons || []).length}:${data.currentSeason?.startedTs ?? "-"}`;

// A POST handler's refusal: one error line on `to`, nothing written.
const failTo = (web, to) => (req, res, text) => web.done(req, res, to, { ok: false, text });

function seasonRoutes(router, web) {
  const back = `${BASE}/seasons`;
  const fail = failTo(web, back);

  router.get("/seasons", (req, res) =>
    web.render(req, res, { title: "Seasons", file: V("seasons"), page: seasonsModel(help.loadData()) })
  );

  // target: "current" or a past season's endedTs.
  router.post("/seasons/rename", (req, res) => {
    const raw = web.field(req, "target");
    const target = raw === "current" ? "current" : /^\d{1,16}$/.test(raw) ? Number(raw) : null;
    if (target === null) return fail(req, res, SEASON_GONE);
    const name = web.field(req, "name");
    const r = actions.renameSeason(web, web.actor(req), { target, name });
    if (!r.ok) return fail(req, res, r.error);
    return web.done(req, res, back, { ok: true, text: `Renamed to ${name.trim()}.` }, r.effects);
  });

  router.post("/seasons/new", async (req, res) => {
    const name = web.field(req, "name").trim();
    if (!name) return fail(req, res, "Give the new season a name.");
    const tooLong = actions.seasonNameError(name);
    if (tooLong) return fail(req, res, tooLong);
    const data = help.loadData();
    const waiting = data.entries.filter((e) => !e.done).length;
    const ok = await web.confirmed(req, res, {
      title: "Start a new season?",
      lines: [
        `New season: ${name}`,
        `Starting a new season closes every pending request; they move to history as unresolved. ${waitingNow(waiting)} This can't be undone.`,
      ],
      action: `${BASE}/seasons/new`,
      fields: { name },
      confirmLabel: "Start new season",
      cancelHref: back,
      guard: seasonGuard(data),
    });
    if (!ok) return undefined;
    const r = actions.newSeason(web, web.actor(req), { name });
    if (!r.ok) return fail(req, res, r.error);
    const archived = r.archived ? "Previous season archived, board cleared." : "Board cleared.";
    return web.done(req, res, back, { ok: true, text: `Started season ${help.seasonLabel(r.data.currentSeason)}. ${archived}` }, r.effects);
  });

  router.post("/seasons/reset", async (req, res) => {
    const data = help.loadData();
    const waiting = data.entries.filter((e) => !e.done).length;
    const ok = await web.confirmed(req, res, {
      title: "Reset the season?",
      lines: [
        `This archives the current season and clears the board; any pending request is closed. ${waitingNow(waiting)}`,
        "This can't be undone.",
      ],
      action: `${BASE}/seasons/reset`,
      fields: {},
      confirmLabel: "Reset season",
      cancelHref: back,
      guard: seasonGuard(data),
    });
    if (!ok) return undefined;
    const r = actions.reset(web, web.actor(req));
    if (!r.ok) return fail(req, res, r.error);
    return web.done(req, res, back, { ok: true, text: "Season reset — the board is cleared." }, r.effects);
  });
}

// ---------- Stats ----------

// The ended seasons, newest first (those without a usable endedTs can't be
// addressed by the picker and are left out).
function pastSeasons(data) {
  return (data.seasons || []).filter((s) => Number.isFinite(s.endedTs)).sort((a, b) => b.endedTs - a.endedTs);
}

// The view picker: current season, all-time, then past seasons newest first.
function statsViews(data) {
  return [
    { value: "current", label: `Current season — ${help.seasonLabel(data.currentSeason)}` },
    { value: "alltime", label: "All-time" },
    ...pastSeasons(data).map((s) => ({ value: String(s.endedTs), label: `${help.seasonLabel(s)} (ended ${dateOf(s.endedTs)})` })),
  ];
}

function sortedByCategory(records) {
  const out = {};
  for (const r of records) if (r.resolution === "sorted") out[r.category] = (out[r.category] || 0) + 1;
  return out;
}

// requested: "current" | "alltime" | a past season's endedTs (string). An
// unknown value (a season that is gone, a hand-typed URL) falls back to the
// current season with one explaining line.
async function statsModel(guild, data, requested, lookup = {}) {
  const views = statsViews(data);
  const known = views.some((v) => v.value === requested);
  const view = known ? requested : "current";
  const notice = requested && !known ? `${SEASON_GONE} Showing the current season.` : null;
  let title;
  let helpers;
  let categories;
  let summary;
  let empty = null;
  if (view === "current") {
    const pending = data.entries.filter((e) => !e.done);
    const done = data.entries.filter((e) => e.done);
    const pend = help.countByCategory(pending);
    const don = help.countByCategory(done);
    const ids = [...new Set([...help.activeCategories(data).map((c) => c.id), ...Object.keys(pend), ...Object.keys(don)])];
    categories = ids.map((id) => ({ label: catLabel(data, id), waiting: pend[id] || 0, sorted: don[id] || 0 }));
    helpers = help.tallyHelpers(data.entries).slice(0, 15);
    title = `${help.seasonLabel(data.currentSeason)} — current season`;
    summary = `${pending.length} waiting · ${done.length} sorted`;
  } else {
    const season = view === "alltime" ? null : pastSeasons(data).find((s) => String(s.endedTs) === view);
    const recs = season ? help.recordsForSeason(data.records, season.startedTs) : data.records || [];
    helpers = help.helperTotals(recs).slice(0, 15);
    if (season && recs.length === 0) {
      // A season from before per-request records: only its archived totals exist.
      categories = Object.entries(season.byCategory || {}).map(([id, n]) => ({ label: catLabel(data, id), waiting: null, sorted: n }));
      summary = `${season.sortedTotal || 0} sorted`;
      empty = "No per-request data for this season — only its totals.";
    } else {
      categories = Object.entries(sortedByCategory(recs)).map(([id, n]) => ({ label: catLabel(data, id), waiting: null, sorted: n }));
      const d = help.demandSummary(recs);
      summary = `${d.sorted} sorted · ${d.self} self-sorted · ${d.removed} removed · ${d.unresolved} unresolved`;
    }
    title = season ? `${help.seasonLabel(season)} (ended ${dateOf(season.endedTs)})` : "All-time";
  }
  const names = await namesWithin(lookup, help.resolveIds(guild, helpers.map(([id]) => id)), {});
  return {
    base: BASE,
    view,
    views: views.map((v) => ({ ...v, selected: v.value === view })),
    notice,
    title,
    summary,
    empty,
    showWaiting: view === "current",
    categories,
    helpers: helpers.map(([id, n], i) => ({ rank: i + 1, name: names[id] || "—", count: n })),
  };
}

// ---------- Categories (owner) ----------

function categoriesModel(data) {
  const active = help.activeCategories(data);
  const openBy = help.countByCategory(data.entries.filter((e) => !e.done));
  return {
    base: BASE,
    maxLabel: help.MAX_LABEL,
    maxActive: help.MAX_ACTIVE_CATEGORIES,
    canAdd: active.length < help.MAX_ACTIVE_CATEGORIES,
    lastOne: active.length <= 1,
    active: active.map((c) => ({
      id: c.id,
      label: c.label,
      emoji: c.emoji,
      open: openBy[c.id] || 0,
      moveOptions: active.filter((o) => o.id !== c.id).map((o) => ({ id: o.id, label: `${o.emoji} ${o.label}` })),
    })),
    archived: (data.categories || []).filter((c) => c.archived).map((c) => ({ id: c.id, label: c.label, emoji: c.emoji })),
  };
}

const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

// The state an Archive confirmation is about: whether the category is still
// active, which requests are open in it (by id), which of those the archive
// would drop as duplicates in the move-to category (the preview's moved and
// dropped counts), and whether the chosen move-to is still an active category.
// Any change makes a replayed or stale confirmation fail the guard.
function categoryGuard(data, categoryId, moveto) {
  const cat = help.categoryMap(data)[categoryId];
  const state = !cat ? "gone" : cat.archived ? "archived" : "active";
  const ids = (list) => list.map((e) => e.id).sort().join(",");
  const open = data.entries.filter((e) => !e.done && e.category === categoryId);
  const preview = help.removeCategory(structuredClone(data), categoryId, moveto);
  const target = moveto && help.activeCategories(data).some((c) => c.id === moveto) ? moveto : "-";
  return [state, ids(open), preview.ok ? ids(preview.dropped) : "-", target].join("|");
}

function categoryRoutes(router, web) {
  const back = `${BASE}/categories`;
  const fail = failTo(web, back);
  router.use("/categories", web.requireLevel("owner"));

  router.get("/categories", (req, res) =>
    web.render(req, res, { title: "Categories", file: V("categories"), page: categoriesModel(help.loadData()) })
  );

  router.post("/categories/add", (req, res) => {
    const label = web.field(req, "label").trim();
    const emoji = web.field(req, "emoji").trim();
    const r = actions.addCategory(web, web.actor(req), { label, emoji: emoji || undefined });
    if (!r.ok) return fail(req, res, r.error);
    return web.done(req, res, back, { ok: true, text: `${r.category.emoji} ${r.category.label} is ready.` }, r.effects);
  });

  // Archive with "move open requests to …". The confirmation shows what the
  // archive will do — computed on a throwaway copy, nothing is saved — and
  // the action re-checks everything when it really runs.
  router.post("/categories/archive", async (req, res) => {
    const categoryId = web.field(req, "categoryId");
    const moveto = web.field(req, "moveto") || undefined;
    const data = help.loadData();
    const open = data.entries.filter((e) => !e.done && e.category === categoryId).length;
    // A refusal on a confirming POST means the state moved since the page was
    // shown (already archived, target gone, a request arrived): say so.
    const refuse = (text) => (web.field(req, "confirm") === "yes" ? web.changed(req, res, back) : fail(req, res, text));
    if (open > 0 && !moveto) return refuse("It still has open requests — pick a category to move them to.");
    const preview = help.removeCategory(structuredClone(data), categoryId, moveto);
    if (!preview.ok) return refuse(preview.error);
    const label = help.catOf(data, categoryId).label;
    const movetoLabel = moveto ? help.catOf(data, moveto).label : null;
    const lines = [`Members can't pick ${label} anymore. Its history and stats stay.`];
    if (preview.moved.length > 0) lines.push(`${plural(preview.moved.length, "open request moves", "open requests move")} to ${movetoLabel}.`);
    if (preview.dropped.length > 0) {
      lines.push(`${plural(preview.dropped.length, "request is", "requests are")} already open in ${movetoLabel} for the same member — closed as removed.`);
    }
    const ok = await web.confirmed(req, res, {
      title: `Archive ${label}?`,
      lines,
      action: `${BASE}/categories/archive`,
      fields: { categoryId, moveto: moveto || "" },
      confirmLabel: "Archive",
      cancelHref: back,
      guard: categoryGuard(data, categoryId, moveto),
    });
    if (!ok) return undefined;
    const r = actions.archiveCategory(web, web.actor(req), { categoryId, moveto });
    if (!r.ok) return fail(req, res, r.error);
    const moved = r.moved.length > 0 ? ` ${plural(r.moved.length, "open request", "open requests")} moved to ${r.movetoLabel}.` : "";
    const dropped = r.dropped.length > 0 ? ` ${plural(r.dropped.length, "duplicate", "duplicates")} closed.` : "";
    return web.done(req, res, back, { ok: true, text: `Archived ${r.label}.${moved}${dropped}` }, r.effects);
  });
}

// ---------- Settings (owner) ----------

// The same channel kinds /config nudge set accepts.
const NUDGE_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

function roleName(guild, id) {
  const role = guild.roles.cache.get(id);
  return role ? role.name : "(deleted role)";
}

function channelName(guild, id) {
  const channel = guild.channels.cache.get(id);
  return channel ? channel.name : "(deleted channel)";
}

// Roles an owner can pick: never @everyone (id = guild id) or a bot-managed
// role — the actions refuse both anyway (fail closed); this just keeps them
// out of the list. Highest role first, like Discord.
function pickableRoles(guild) {
  return [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && r.managed !== true)
    .sort((a, b) => (b.position || 0) - (a.position || 0))
    .map((r) => ({ id: r.id, name: r.name }));
}

function nudgeChannels(guild) {
  return [...guild.channels.cache.values()]
    .filter((c) => NUDGE_CHANNEL_TYPES.has(c.type))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ id: c.id, name: c.name }));
}

function settingsModel(guild, data) {
  const roles = pickableRoles(guild);
  return {
    base: BASE,
    managers: data.managerRoleIds.map((id) => ({ id, name: roleName(guild, id) })),
    addable: roles.filter((r) => !data.managerRoleIds.includes(r.id)),
    notify: data.notifyRoleId ? { id: data.notifyRoleId, name: roleName(guild, data.notifyRoleId) } : null,
    notifyOptions: roles.map((r) => ({ ...r, selected: r.id === data.notifyRoleId })),
    nudge: {
      on: !!data.nudgeChannelId,
      channelName: data.nudgeChannelId ? channelName(guild, data.nudgeChannelId) : null,
      hours: data.nudgeThresholdHours,
      maxHours: help.NUDGE_MAX_HOURS,
      channels: nudgeChannels(guild).map((c) => ({ ...c, selected: c.id === data.nudgeChannelId })),
    },
  };
}

// A role id from the form → the { id, managed } shape the actions take, or
// null when the guild has no such role (deleted since the page was shown).
function pickedRole(guild, id) {
  const role = id ? guild.roles.cache.get(id) : null;
  return role ? { id: role.id, managed: role.managed === true } : null;
}

function settingsRoutes(router, web) {
  const back = `${BASE}/settings`;
  const fail = failTo(web, back);
  const gone = "That role doesn't exist anymore. Pick one from the list.";
  router.use("/settings", web.requireLevel("owner"));

  router.get("/settings", (req, res) =>
    web.render(req, res, { title: "Settings", file: V("settings"), page: settingsModel(req.guild, help.loadData()) })
  );

  router.post("/settings/managers/add", (req, res) => {
    const role = pickedRole(req.guild, web.field(req, "roleId"));
    if (!role) return fail(req, res, gone);
    const r = actions.addManagerRole(web, web.actor(req), { role, guildId: req.guild.id });
    if (!r.ok) return fail(req, res, r.error);
    web.forgetLevels(); // after the action saved: who is an officer just changed
    const name = roleName(req.guild, role.id);
    return web.done(req, res, back, { ok: true, text: r.added ? `${name} is now a manager role.` : `${name} was already a manager role.` });
  });

  router.post("/settings/managers/remove", (req, res) => {
    const roleId = web.field(req, "roleId");
    if (roleId === "") return fail(req, res, gone); // missing or repeated field
    const r = actions.removeManagerRole(web, web.actor(req), { roleId });
    if (!r.ok) return fail(req, res, r.error);
    web.forgetLevels(); // after the action saved
    const name = roleName(req.guild, roleId);
    return web.done(req, res, back, { ok: true, text: r.removed ? `${name} is no longer a manager role.` : `${name} wasn't a manager role.` });
  });

  // roleId "off" = request pings off. A missing or repeated field reads as ""
  // and is refused, never taken for Off.
  router.post("/settings/notify", (req, res) => {
    const roleId = web.field(req, "roleId");
    const role = roleId === "off" ? null : pickedRole(req.guild, roleId);
    if (roleId !== "off" && !role) return fail(req, res, gone);
    const r = actions.setNotifyRole(web, web.actor(req), { role, guildId: req.guild.id });
    if (!r.ok) return fail(req, res, r.error);
    return web.done(req, res, back, { ok: true, text: role ? `New requests now ping ${roleName(req.guild, role.id)}.` : "Request pings are off." });
  });

  router.post("/settings/nudge", (req, res) => {
    const channelId = web.field(req, "channelId");
    const channel = nudgeChannels(req.guild).find((c) => c.id === channelId);
    if (!channel) return fail(req, res, "Pick a text channel from the list.");
    const raw = web.field(req, "hours").trim();
    // Not a whole number → NaN, which the action refuses with its own message.
    const hours = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
    const r = actions.setNudge(web, web.actor(req), { channelId, hours });
    if (!r.ok) return fail(req, res, r.error);
    return web.done(req, res, back, {
      ok: true,
      text: `Stale nudges on — a daily digest in #${channel.name} for requests waiting over ${r.data.nudgeThresholdHours}h.`,
    });
  });

  router.post("/settings/nudge/off", (req, res) => {
    const r = actions.nudgeOff(web, web.actor(req));
    if (!r.ok) return fail(req, res, r.error);
    return web.done(req, res, back, { ok: true, text: "Stale nudges off." });
  });
}

// ---------- routes ----------

function routes(router, web) {
  const lookup = { deadline: (p) => web.withDeadline(p, "name lookup"), log: web.log };

  router.get("/", async (req, res) => {
    const page = await overviewModel(req.guild, help.loadData(), web.now(), lookup);
    return web.render(req, res, { title: "Overview", file: V("overview"), page });
  });

  seasonRoutes(router, web);

  router.get("/stats", async (req, res) => {
    const requested = typeof req.query.view === "string" ? req.query.view : "";
    const page = await statsModel(req.guild, help.loadData(), requested, lookup);
    return web.render(req, res, { title: "Stats", file: V("stats"), page });
  });

  categoryRoutes(router, web);
  settingsRoutes(router, web);
}

module.exports = { BASE, title: "Help board", nav, routes, dateOf, pastSeasons, overviewModel, seasonsModel, statsViews, statsModel, categoriesModel, settingsModel };
