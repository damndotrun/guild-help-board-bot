// The help board's web admin pages (M2 spec §6), mounted at /help by the web
// core. GET handlers only read (loadData + read-only name lookups); every
// POST goes through ./actions — the same functions the slash commands and
// /menu call — and the web core runs the action's `effects` after the
// response. Each page is a view model (a pure-ish function, tested on its
// own) plus an EJS fragment in ./views that sees only `page`.
const path = require("node:path");
const help = require("./help");

const BASE = "/help";
const V = (name) => path.join(__dirname, "views", `${name}.ejs`);

const nav = [
  { label: "Overview", path: "/", minLevel: "officer" },
  { label: "Stats", path: "/stats", minLevel: "officer" },
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

function catLabel(data, id) {
  const c = help.catOf(data, id);
  return `${c.emoji} ${c.label}`;
}

// ---------- Overview ----------

async function overviewModel(guild, data, now) {
  const open = data.entries.filter((e) => !e.done).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const names = await help.resolveNames(guild, data); // read-only
  const top = help.tallyHelpers(data.entries).slice(0, 5);
  const helperNames = await help.resolveIds(guild, top.map(([id]) => id));
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
    topHelpers: top.map(([id, n]) => ({ name: helperNames[id], count: n })),
  };
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
async function statsModel(guild, data, requested) {
  const views = statsViews(data);
  const known = views.some((v) => v.value === requested);
  const view = known ? requested : "current";
  const notice = requested && !known ? "That season isn't available anymore. Showing the current season." : null;
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
  const names = await help.resolveIds(guild, helpers.map(([id]) => id));
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
    helpers: helpers.map(([id, n], i) => ({ rank: i + 1, name: names[id], count: n })),
  };
}

// ---------- routes ----------

function routes(router, web) {
  router.get("/", async (req, res) => {
    const page = await overviewModel(req.guild, help.loadData(), web.now());
    return web.render(req, res, { title: "Overview", file: V("overview"), page });
  });

  router.get("/stats", async (req, res) => {
    const requested = typeof req.query.view === "string" ? req.query.view : "";
    const page = await statsModel(req.guild, help.loadData(), requested);
    return web.render(req, res, { title: "Stats", file: V("stats"), page });
  });
}

module.exports = { BASE, title: "Help board", nav, routes, dateOf, pastSeasons, overviewModel, statsViews, statsModel };
