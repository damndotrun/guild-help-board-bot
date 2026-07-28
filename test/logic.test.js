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
