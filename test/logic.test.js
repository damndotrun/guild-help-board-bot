"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// Point storage at a throwaway dir BEFORE requiring index.js (DATA_DIR is read
// at module load). Each run gets its own dir so tests never touch real data.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "guildbot-"));
process.env.DATA_DIR = TMP;
// Dummy env so nothing downstream complains; index.js won't log in under test.
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
process.env.GUILD_ID = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const bot = require("../index.js");

test("formatDuration covers day/hour/minute/sub-minute", () => {
  assert.equal(bot.formatDuration(30 * 1000), "under a minute");
  assert.equal(bot.formatDuration(8 * 60 * 1000), "8m");
  assert.equal(bot.formatDuration((3 * 3600 + 12 * 60) * 1000), "3h 12m");
  assert.equal(bot.formatDuration((2 * 86400 + 3 * 3600) * 1000), "2d 3h");
});

test("renderField: empty, passthrough, truncation", () => {
  assert.equal(bot.renderField([]), "—");
  assert.equal(bot.renderField(["a", "b"]), "a\nb");
  const many = Array.from({ length: 200 }, (_, i) => `line ${i} xxxxxxxxxxxxxx`);
  const out = bot.renderField(many);
  assert.ok(out.length <= 1024);
  assert.match(out, /_…and \d+ more_$/);
});

test("catOf: known/archived/unknown, fresh object", () => {
  const data = { categories: [
    { id: "seasonrun5k", label: "Season Run 5K", emoji: "🏃", archived: false },
    { id: "old", label: "Old Event", emoji: "🎯", archived: true },
  ] };
  assert.equal(bot.catOf(data, "seasonrun5k").label, "Season Run 5K");
  assert.equal(bot.catOf(data, "old").emoji, "🎯");          // archived still resolves
  assert.deepEqual(bot.catOf(data, "weird"), { label: "weird", emoji: "❓" });
  const r = bot.catOf(data, "seasonrun5k");
  r.label = "MUTATED";
  assert.equal(data.categories[0].label, "Season Run 5K");   // fresh object, no aliasing
});

test("defaultCategories: deep copy, has the two legacy ids", () => {
  const a = bot.defaultCategories();
  const b = bot.defaultCategories();
  assert.deepEqual(a.map((c) => c.id).sort(), ["mvp5k", "seasonrun5k"]);
  a[0].label = "X";
  assert.notEqual(b[0].label, "X");                          // independent copies
});

test("emptyData seeds the default categories", () => {
  const d = bot.emptyData();
  assert.equal(d.categories.length, 2);
  assert.deepEqual(d.entries, []);
  assert.equal(d.boardChannelId, null);
});

test("countByCategory counts per id", () => {
  const entries = [
    { category: "a", done: true }, { category: "a", done: false }, { category: "b", done: true },
  ];
  assert.deepEqual(bot.countByCategory(entries), { a: 2, b: 1 });
});

test("activeCategories filters archived", () => {
  const data = { categories: [
    { id: "a", label: "A", emoji: "🅰", archived: false },
    { id: "b", label: "B", emoji: "🅱", archived: true },
  ] };
  assert.deepEqual(bot.activeCategories(data).map((c) => c.id), ["a"]);
});

test("isManager: manage-guild, role match, safe default", () => {
  const manage = { memberPermissions: { has: () => true } };
  assert.equal(bot.isManager(manage, { managerRoleIds: [] }), true);
  const roled = {
    memberPermissions: { has: () => false },
    member: { roles: { cache: new Map([["r1", true]]) } },
  };
  assert.equal(bot.isManager(roled, { managerRoleIds: ["r1"] }), true);
  const none = {
    memberPermissions: { has: () => false },
    member: { roles: { cache: new Map() } },
  };
  assert.equal(bot.isManager(none, { managerRoleIds: [] }), false);
});

test("buildBoardEmbed: split, footer, empty state", () => {
  const data = {
    entries: [
      { userId: "u1", username: "Ann", category: "mvp5k", done: false, ts: 1 },
      { userId: "u2", username: "Bo", category: "seasonrun5k", done: true },
    ],
  };
  const embed = bot.buildBoardEmbed(data, { u1: "Ann", u2: "Bo" });
  assert.match(embed.data.footer.text, /1 waiting/);
  assert.match(embed.data.footer.text, /1 sorted/);
  const empty = bot.buildBoardEmbed({ entries: [] });
  assert.ok(empty.data.fields.some((f) => /Nobody's waiting/.test(f.value)));
});

test("tallyHelpers: counts done+helpedBy, sorted desc", () => {
  const entries = [
    { done: true, helpedBy: "a" },
    { done: true, helpedBy: "a" },
    { done: true, helpedBy: "b" },
    { done: false, helpedBy: "c" }, // ignored: not done
    { done: true }, // ignored: no helpedBy
  ];
  assert.deepEqual(bot.tallyHelpers(entries), [["a", 2], ["b", 1]]);
});

test("saveData keeps last-known-good in data.json.bak", () => {
  // saveData/loadData bind to DATA_DIR captured at module load (= TMP, set at
  // the top of this file). No earlier test writes data.json, so the FIRST save
  // finds no prior file and writes no .bak; the SECOND save backs up the first.
  bot.saveData({ entries: [{ id: "A" }] });
  bot.saveData({ entries: [{ id: "A" }, { id: "B" }] });
  const bak = JSON.parse(fs.readFileSync(path.join(TMP, "data.json.bak"), "utf8"));
  assert.equal(bak.entries.length, 1); // previous good state
  const live = JSON.parse(fs.readFileSync(path.join(TMP, "data.json"), "utf8"));
  assert.equal(live.entries.length, 2);
});

test("loadData restores from .bak when data.json is corrupt", () => {
  const good = { boardChannelId: "c", boardMessageId: "m", entries: [{ id: "X" }],
    managerRoleIds: [], notifyRoleId: null, seasons: [] };
  fs.writeFileSync(path.join(TMP, "data.json.bak"), JSON.stringify(good));
  fs.writeFileSync(path.join(TMP, "data.json"), "{ this is not json");
  const loaded = bot.loadData();
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0].id, "X");
  assert.equal(loaded.boardChannelId, "c");
});

test("loadData falls back to empty when both files are corrupt", () => {
  fs.writeFileSync(path.join(TMP, "data.json.bak"), "also broken {");
  fs.writeFileSync(path.join(TMP, "data.json"), "broken {");
  const loaded = bot.loadData();
  assert.deepEqual(loaded.entries, []);
  assert.equal(loaded.boardChannelId, null);
});

test("saveData skips backup when current data.json is corrupt, but still saves", () => {
  fs.rmSync(path.join(TMP, "data.json"), { force: true });
  fs.rmSync(path.join(TMP, "data.json.bak"), { force: true });
  // Seed a GOOD backup and a CORRUPT primary (the post-restore situation).
  fs.writeFileSync(path.join(TMP, "data.json.bak"), JSON.stringify({ entries: [{ id: "GOOD" }] }));
  fs.writeFileSync(path.join(TMP, "data.json"), "{ corrupt");
  bot.saveData({ entries: [{ id: "NEW" }] });
  // The good .bak must be preserved (NOT overwritten by the corrupt primary)...
  const bak = JSON.parse(fs.readFileSync(path.join(TMP, "data.json.bak"), "utf8"));
  assert.equal(bak.entries[0].id, "GOOD");
  // ...and the save still happened.
  const live = JSON.parse(fs.readFileSync(path.join(TMP, "data.json"), "utf8"));
  assert.equal(live.entries[0].id, "NEW");
});

test("loadData falls back to empty when data.json is corrupt and no .bak exists", () => {
  fs.rmSync(path.join(TMP, "data.json.bak"), { force: true });
  fs.writeFileSync(path.join(TMP, "data.json"), "not json {");
  const loaded = bot.loadData();
  assert.deepEqual(loaded.entries, []);
  assert.equal(loaded.boardChannelId, null);
});

test("loadData seeds categories when the field is absent (live-data migration)", () => {
  fs.rmSync(path.join(TMP, "data.json.bak"), { force: true });
  fs.writeFileSync(path.join(TMP, "data.json"), JSON.stringify({ entries: [] })); // no categories field
  const d = bot.loadData();
  assert.deepEqual(d.categories.map((c) => c.id).sort(), ["mvp5k", "seasonrun5k"]);
});

test("loadData seeds categories when the array is empty", () => {
  fs.rmSync(path.join(TMP, "data.json.bak"), { force: true });
  fs.writeFileSync(path.join(TMP, "data.json"), JSON.stringify({ entries: [], categories: [] }));
  assert.equal(bot.loadData().categories.length, 2);
});

test("loadData preserves a non-empty categories array as-is", () => {
  fs.rmSync(path.join(TMP, "data.json.bak"), { force: true });
  const custom = [{ id: "boss", label: "Boss", emoji: "👹", archived: false }];
  fs.writeFileSync(path.join(TMP, "data.json"), JSON.stringify({ entries: [], categories: custom }));
  assert.deepEqual(bot.loadData().categories, custom);
});

test("isLockFresh: fresh, stale, and missing", () => {
  const now = 1_000_000;
  assert.equal(bot.isLockFresh({ heartbeat: now - 1000 }, now), true);
  assert.equal(bot.isLockFresh({ heartbeat: now - 100_000 }, now), false);
  assert.equal(bot.isLockFresh(null, now), false);
  assert.equal(bot.isLockFresh({}, now), false);
});

test("slugify: spaces, case, symbols, collapse, empty", () => {
  assert.equal(bot.slugify("Guild Boss"), "guild-boss");
  assert.equal(bot.slugify("  Trophy   Push!! "), "trophy-push");
  assert.equal(bot.slugify("MVP 5K"), "mvp-5k");
  assert.equal(bot.slugify("💥✨"), "");
});

test("addCategory: new, upsert-on-seeded-default, revive, guards", () => {
  const data = { categories: bot.defaultCategories() };
  // new
  let r = bot.addCategory(data, "Guild Boss", "👹");
  assert.equal(r.ok, true);
  assert.ok(data.categories.find((c) => c.id === "guild-boss" && c.emoji === "👹"));
  // upsert a SEEDED default by normalized label (id stays "seasonrun5k", no dup)
  r = bot.addCategory(data, "Season Run 5K", "🎯");
  assert.equal(r.ok, true);
  const runs = data.categories.filter((c) => c.label === "Season Run 5K");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, "seasonrun5k");
  assert.equal(runs[0].emoji, "🎯");
  // revive an archived one
  data.categories.push({ id: "old", label: "Old", emoji: "🎯", archived: true });
  r = bot.addCategory(data, "Old", "🎯");
  assert.equal(data.categories.find((c) => c.id === "old").archived, false);
  // empty slug rejected
  assert.equal(bot.addCategory(data, "💥", "x").ok, false);
  // label too long rejected
  assert.equal(bot.addCategory(data, "x".repeat(61), "x").ok, false);
});

test("addCategory: 25-active cap", () => {
  const cats = [];
  for (let i = 0; i < 25; i++) cats.push({ id: `c${i}`, label: `C${i}`, emoji: "•", archived: false });
  const data = { categories: cats };
  assert.equal(bot.addCategory(data, "One More", "•").ok, false);
});

test("removeCategory: archive when empty; reassign+dedup; guards", () => {
  const base = () => ({
    categories: [
      { id: "a", label: "A", emoji: "🅰", archived: false },
      { id: "b", label: "B", emoji: "🅱", archived: false },
    ],
    entries: [],
  });
  // no open entries -> archived
  let d = base();
  let r = bot.removeCategory(d, "a", undefined);
  assert.equal(r.ok, true);
  assert.equal(d.categories.find((c) => c.id === "a").archived, true);
  // open entries + valid moveto -> reassigned + archived
  d = base();
  d.entries = [{ id: "e1", userId: "u1", category: "a", done: false }];
  r = bot.removeCategory(d, "a", "b");
  assert.equal(r.ok, true);
  assert.equal(d.entries[0].category, "b");
  assert.equal(d.categories.find((c) => c.id === "a").archived, true);
  assert.deepEqual(r.moved.map((e) => e.id), ["e1"]);
  // dedup: user already open in moveto -> moved entry DROPPED
  d = base();
  d.entries = [
    { id: "e1", userId: "u1", category: "a", done: false },
    { id: "e2", userId: "u1", category: "b", done: false },
  ];
  r = bot.removeCategory(d, "a", "b");
  assert.equal(d.entries.find((e) => e.id === "e1"), undefined); // dropped
  assert.deepEqual(r.dropped.map((e) => e.id), ["e1"]);
  assert.ok(d.entries.find((e) => e.id === "e2"));
  // last active category -> error, nothing mutated
  d = { categories: [{ id: "a", label: "A", emoji: "🅰", archived: false }], entries: [] };
  r = bot.removeCategory(d, "a", undefined);
  assert.equal(r.ok, false);
  assert.equal(d.categories[0].archived, false);
  // open entries, missing moveto -> error
  d = base();
  d.entries = [{ id: "e1", userId: "u1", category: "a", done: false }];
  assert.equal(bot.removeCategory(d, "a", undefined).ok, false);
  // moveto not active / equal to category -> error
  assert.equal(bot.removeCategory(base(), "a", "a").ok, false);
});

test("categorySuggestions: active only, substring, ≤25, {name,value}", () => {
  const data = { categories: [
    { id: "guild-boss", label: "Guild Boss", emoji: "👹", archived: false },
    { id: "mvp5k", label: "MVP 5K", emoji: "⭐", archived: false },
    { id: "old", label: "Old Boss", emoji: "🎯", archived: true },
  ] };
  const all = bot.categorySuggestions(data, "");
  assert.deepEqual(all.map((c) => c.value).sort(), ["guild-boss", "mvp5k"]); // no archived
  const boss = bot.categorySuggestions(data, "boss");
  assert.deepEqual(boss.map((c) => c.value), ["guild-boss"]);                // substring, active
  assert.equal(all.find((c) => c.value === "mvp5k").name, "⭐ MVP 5K");       // emoji + label
});

test("stats aggregation is category-agnostic and back-compatible", () => {
  const done = [
    { category: "seasonrun5k", done: true }, { category: "guild-boss", done: true },
    { category: "guild-boss", done: true },
  ];
  const by = bot.countByCategory(done);
  assert.deepEqual(by, { seasonrun5k: 1, "guild-boss": 2 });
  // an OLD season archive uses fixed keys — catOf still labels them:
  const data = { categories: bot.defaultCategories() };
  assert.equal(bot.catOf(data, "seasonrun5k").label, "Season Run 5K");
  assert.equal(bot.catOf(data, "mvp5k").label, "MVP 5K");
});

test("hasOpenEntry: matches pending same user+category only", () => {
  const data = { entries: [
    { userId: "u1", category: "a", done: false },
    { userId: "u1", category: "b", done: false },
    { userId: "u2", category: "a", done: false },
    { userId: "u1", category: "a", done: true },
  ] };
  assert.equal(bot.hasOpenEntry(data, "u1", "a"), true);
  assert.equal(bot.hasOpenEntry(data, "u1", "c"), false);
  assert.equal(bot.hasOpenEntry(data, "u3", "a"), false);
});

test("newHelpEntry: shape", () => {
  const e = bot.newHelpEntry("u1", "Ann", "a", "note");
  assert.equal(e.userId, "u1");
  assert.equal(e.username, "Ann");
  assert.equal(e.category, "a");
  assert.equal(e.note, "note");
  assert.equal(e.done, false);
  assert.equal(typeof e.ts, "number");
  assert.ok(e.id);
  assert.equal(bot.newHelpEntry("u1", "Ann", "a").note, ""); // note defaults to ""
});

test("cardDescription: claim line only when claimed AND name given", () => {
  const cat = { label: "Season Run 5K", emoji: "🏃" };
  assert.match(bot.cardDescription(cat, { username: "Ann", note: "" }, null), /needs help with \*\*Season Run 5K\*\*/);
  assert.doesNotMatch(bot.cardDescription(cat, { username: "Ann" }, null), /Claimed by/);
  assert.match(bot.cardDescription(cat, { username: "Ann", claimedBy: "o1" }, "Bob"), /🙌 Claimed by Bob/);
  assert.match(bot.cardDescription(cat, { username: "Ann", note: "3 hammers" }, null), /📝 _3 hammers_/);
});

test("categorySelectOptions: active only, ≤25, emoji-in-label", () => {
  const data = { categories: [
    { id: "a", label: "Alpha", emoji: "🅰", archived: false },
    { id: "b", label: "Beta", emoji: "🅱", archived: true },
  ] };
  const opts = bot.categorySelectOptions(data);
  assert.deepEqual(opts.map((o) => o.value), ["a"]);      // active only
  assert.equal(opts[0].label, "🅰 Alpha");                 // emoji folded into label text
});

test("toggleClaim: claim, release, blocked", () => {
  const e = {};
  assert.deepEqual(bot.toggleClaim(e, "o1"), { action: "claimed", by: "o1" });
  assert.equal(e.claimedBy, "o1");
  assert.deepEqual(bot.toggleClaim(e, "o1"), { action: "released", by: "o1" });
  assert.equal(e.claimedBy, null);
  e.claimedBy = "o2";
  assert.deepEqual(bot.toggleClaim(e, "o1"), { action: "blocked", by: "o2" });
  assert.equal(e.claimedBy, "o2"); // unchanged
});

test("buildBoardEmbed: claim marker when name resolvable, no raw id otherwise", () => {
  const data = { entries: [
    { userId: "u1", username: "Ann", category: "a", done: false, ts: 1, claimedBy: "o1" },
  ], categories: [{ id: "a", label: "A", emoji: "🅰", archived: false }] };
  const withName = bot.buildBoardEmbed(data, { u1: "Ann", o1: "Bob" });
  assert.match(JSON.stringify(withName.data.fields), /🙌 Bob/);
  const noName = bot.buildBoardEmbed(data, { u1: "Ann" }); // o1 unresolved
  assert.doesNotMatch(JSON.stringify(noName.data.fields), /o1/); // no raw id leak
});

test("buildBoardEmbed: claim marker still renders for a user's second open entry", () => {
  // Same user waiting in two different categories (allowed — dup-check is per-category).
  // Regression guard for the resolveNames `continue`-before-claim-resolution bug.
  const data = { entries: [
    { userId: "u1", username: "Ann", category: "a", done: false, ts: 1 },
    { userId: "u1", username: "Ann", category: "b", done: false, ts: 2, claimedBy: "o1" },
  ], categories: [
    { id: "a", label: "A", emoji: "🅰", archived: false },
    { id: "b", label: "B", emoji: "🅱", archived: false },
  ] };
  const embed = bot.buildBoardEmbed(data, { u1: "Ann", o1: "Bob" });
  assert.match(JSON.stringify(embed.data.fields), /🙌 Bob/);
});

test("resolveNames: resolves the claimer on a user's second open entry (not skipped by the userId cache)", async () => {
  // Reproduces the exact state that hid the original bug: a `continue` guarding
  // the userId-cache lookup used to sit ABOVE the claimedBy-resolution block, so
  // once u1's name was cached from entry 1, entry 2 (same user, different
  // category, claimed) never reached the claimedBy lookup at all. Calling
  // resolveNames directly — not buildBoardEmbed with a pre-built names map —
  // is what actually exercises that code path.
  const data = { entries: [
    { userId: "u1", username: "Ann", category: "a", done: false, ts: 1 },
    { userId: "u1", username: "Ann", category: "b", done: false, ts: 2, claimedBy: "o1" },
  ] };
  const fetched = new Set();
  const displayNames = { u1: "Ann Fresh", o1: "Bob Fresh" };
  const guild = {
    members: {
      cache: { get: () => undefined }, // force every lookup through fetch()
      fetch: async (id) => {
        fetched.add(id);
        return { displayName: displayNames[id] };
      },
    },
  };
  const names = await bot.resolveNames(guild, data);
  assert.equal(names.u1, "Ann Fresh");
  assert.equal(names.o1, "Bob Fresh"); // the claimer — absent under the old buggy code
  assert.ok(fetched.has("u1") && fetched.has("o1"));
});

test("seasonLabel: name or (unnamed)", () => {
  assert.equal(bot.seasonLabel({ name: "Winter" }), "Winter");
  assert.equal(bot.seasonLabel({ name: null }), "(unnamed)");
  assert.equal(bot.seasonLabel({}), "(unnamed)");
  assert.equal(bot.seasonLabel(undefined), "(unnamed)");
});

test("closeSeason: archives done entries with the current season's name, clears, caps at 12", () => {
  const data = {
    entries: [
      { userId: "u1", category: "a", done: true },
      { userId: "u2", category: "a", done: true },
      { userId: "u3", category: "b", done: false },
    ],
    seasons: [],
    currentSeason: { name: "Season 4", startedTs: 100 },
    categories: [{ id: "a", label: "A", emoji: "🅰", archived: false }, { id: "b", label: "B", emoji: "🅱", archived: false }],
  };
  const archived = bot.closeSeason(data, 999);
  assert.equal(archived.name, "Season 4");
  assert.equal(archived.startedTs, 100);
  assert.equal(archived.endedTs, 999);
  assert.equal(archived.sortedTotal, 2);
  assert.deepEqual(archived.byCategory, { a: 2 });
  assert.equal(data.seasons.length, 1);
  assert.equal(data.entries.length, 0);          // cleared
});

test("closeSeason: no done entries → no archive, still clears pending", () => {
  const data = { entries: [{ userId: "u1", category: "a", done: false }], seasons: [], currentSeason: { name: "X", startedTs: 1 }, categories: [] };
  const archived = bot.closeSeason(data, 5);
  assert.equal(archived, null);
  assert.equal(data.seasons.length, 0);
  assert.equal(data.entries.length, 0);
});

test("closeSeason: caps archive history at 12", () => {
  const data = {
    entries: [{ userId: "u1", category: "a", done: true }],
    seasons: Array.from({ length: 12 }, (_, i) => ({ name: `S${i}`, endedTs: i })),
    currentSeason: { name: "S12", startedTs: 1 },
    categories: [{ id: "a", label: "A", emoji: "🅰", archived: false }],
  };
  bot.closeSeason(data, 100);
  assert.equal(data.seasons.length, 12);          // still 12
  assert.equal(data.seasons[11].name, "S12");     // newest kept
  assert.equal(data.seasons[0].name, "S1");       // oldest dropped
});

test("beginSeason: sets current season name + startedTs, trims, empty → null", () => {
  const data = { currentSeason: { name: null, startedTs: null } };
  bot.beginSeason(data, "  Spring Run  ", 42);
  assert.deepEqual(data.currentSeason, { name: "Spring Run", startedTs: 42 });
  bot.beginSeason(data, "   ", 43);
  assert.deepEqual(data.currentSeason, { name: null, startedTs: 43 });
});

test("renameSeason: current, past by endedTs, and not-found", () => {
  const data = {
    currentSeason: { name: "Old", startedTs: 1 },
    seasons: [{ name: "Past", endedTs: 500 }],
  };
  assert.deepEqual(bot.renameSeason(data, "current", "  New  "), { ok: true, oldName: "Old" });
  assert.equal(data.currentSeason.name, "New");
  assert.deepEqual(bot.renameSeason(data, 500, "Renamed Past"), { ok: true, oldName: "Past" });
  assert.equal(data.seasons[0].name, "Renamed Past");
  assert.deepEqual(bot.renameSeason(data, 999, "Nope"), { ok: false });
  assert.equal(bot.renameSeason(data, "current", "   ").ok, false); // empty name rejected
});
