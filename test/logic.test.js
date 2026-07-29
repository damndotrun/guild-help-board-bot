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

// The .bak/corruption-recovery block below all shares the one TMP dir created
// at module load. Every test here calls resetDataFiles() FIRST so it starts
// from a known-empty filesystem state instead of relying on whatever the
// previous test happened to leave behind — each test is independently
// runnable (e.g. via --test-name-pattern) regardless of declaration order.
function resetDataFiles() {
  fs.rmSync(path.join(TMP, "data.json"), { force: true });
  fs.rmSync(path.join(TMP, "data.json.bak"), { force: true });
  fs.rmSync(path.join(TMP, "data.json.bak.tmp"), { force: true });
  fs.rmSync(path.join(TMP, "data.json.tmp"), { force: true });
}

test("saveData keeps last-known-good in data.json.bak", () => {
  resetDataFiles();
  // With a clean slate, the FIRST save finds no prior file and writes no
  // .bak; the SECOND save backs up the first.
  bot.saveData({ entries: [{ id: "A" }] });
  bot.saveData({ entries: [{ id: "A" }, { id: "B" }] });
  const bak = JSON.parse(fs.readFileSync(path.join(TMP, "data.json.bak"), "utf8"));
  assert.equal(bak.entries.length, 1); // previous good state
  const live = JSON.parse(fs.readFileSync(path.join(TMP, "data.json"), "utf8"));
  assert.equal(live.entries.length, 2);
});

test("saveData writes .bak atomically: correct round-trip, no .bak.tmp left behind", () => {
  resetDataFiles();
  bot.saveData({ entries: [{ id: "A" }] });
  bot.saveData({ entries: [{ id: "A" }, { id: "B" }] });
  // The .bak must be the previous good state, fully written (not truncated) and
  // round-trippable as valid JSON via the shaped loader.
  const bak = JSON.parse(fs.readFileSync(path.join(TMP, "data.json.bak"), "utf8"));
  assert.equal(bak.entries.length, 1);
  assert.equal(bak.entries[0].id, "A");
  // The atomic-rename step must leave no leftover .bak.tmp on disk.
  assert.equal(fs.existsSync(path.join(TMP, "data.json.bak.tmp")), false);
});

test("loadData restores from .bak when data.json is corrupt", () => {
  resetDataFiles();
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
  resetDataFiles();
  fs.writeFileSync(path.join(TMP, "data.json.bak"), "also broken {");
  fs.writeFileSync(path.join(TMP, "data.json"), "broken {");
  const loaded = bot.loadData();
  assert.deepEqual(loaded.entries, []);
  assert.equal(loaded.boardChannelId, null);
});

test("saveData skips backup when current data.json is corrupt, but still saves", () => {
  resetDataFiles();
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
  resetDataFiles();
  fs.writeFileSync(path.join(TMP, "data.json"), "not json {");
  const loaded = bot.loadData();
  assert.deepEqual(loaded.entries, []);
  assert.equal(loaded.boardChannelId, null);
});

test("loadData seeds categories when the field is absent (live-data migration)", () => {
  resetDataFiles();
  fs.writeFileSync(path.join(TMP, "data.json"), JSON.stringify({ entries: [] })); // no categories field
  const d = bot.loadData();
  assert.deepEqual(d.categories.map((c) => c.id).sort(), ["mvp5k", "seasonrun5k"]);
});

test("loadData seeds categories when the array is empty", () => {
  resetDataFiles();
  fs.writeFileSync(path.join(TMP, "data.json"), JSON.stringify({ entries: [], categories: [] }));
  assert.equal(bot.loadData().categories.length, 2);
});

test("loadData preserves a non-empty categories array as-is", () => {
  resetDataFiles();
  const custom = [{ id: "boss", label: "Boss", emoji: "👹", archived: false }];
  fs.writeFileSync(path.join(TMP, "data.json"), JSON.stringify({ entries: [], categories: custom }));
  assert.deepEqual(bot.loadData().categories, custom);
});

test("loadData cleans malformed category items, defaulting emoji/archived and dropping shapeless ones", () => {
  resetDataFiles();
  const malformed = [
    { id: "boss", label: "Boss" }, // missing emoji/archived — should default, not drop
    { id: "", label: "No id" }, // empty id — dropped
    { label: "No id field" }, // missing id — dropped
    { id: "no-label" }, // missing label — dropped
    { id: 5, label: "Numeric id" }, // non-string id — dropped
    "not-an-object", // dropped
    null, // dropped
  ];
  fs.writeFileSync(path.join(TMP, "data.json"), JSON.stringify({ entries: [], categories: malformed }));
  const cats = bot.loadData().categories;
  assert.deepEqual(cats, [{ id: "boss", label: "Boss", emoji: "📌", archived: false }]);
});

test("loadData coerces a string archived flag to boolean (only real-true/\"true\" archive; \"false\" stays active)", () => {
  resetDataFiles();
  const custom = [
    { id: "boss", label: "Boss", emoji: "👹", archived: "true" },
    { id: "boss2", label: "Boss2", emoji: "👹", archived: "false" },
  ];
  fs.writeFileSync(path.join(TMP, "data.json"), JSON.stringify({ entries: [], categories: custom }));
  const cats = bot.loadData().categories;
  assert.equal(cats.length, 2);
  assert.strictEqual(cats[0].archived, true); // "true" string still archives
  assert.strictEqual(cats[1].archived, false); // "false" string must NOT archive (Fix 4)
});

test("loadData falls back to defaults when every category item is malformed", () => {
  resetDataFiles();
  const allBad = [{ label: "No id" }, { id: "" , label: "Empty id" }];
  fs.writeFileSync(path.join(TMP, "data.json"), JSON.stringify({ entries: [], categories: allBad }));
  assert.deepEqual(bot.loadData().categories.map((c) => c.id).sort(), ["mvp5k", "seasonrun5k"]);
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

test("addCategory: reviving an archived category is rejected at the 25-active cap", () => {
  const cats = [];
  for (let i = 0; i < 25; i++) cats.push({ id: `c${i}`, label: `C${i}`, emoji: "•", archived: false });
  cats.push({ id: "old", label: "Old", emoji: "🎯", archived: true });
  const data = { categories: cats };
  const r = bot.addCategory(data, "Old", "🎯");
  assert.equal(r.ok, false);
  assert.match(r.error, /at most 25 active/);
  assert.equal(data.categories.find((c) => c.id === "old").archived, true); // NOT revived
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

test("removeCategory + logRecord: dropped duplicates get a \"removed\" record, moved entries don't", () => {
  const data = {
    categories: [
      { id: "a", label: "A", emoji: "🅰", archived: false },
      { id: "b", label: "B", emoji: "🅱", archived: false },
    ],
    entries: [
      { id: "e1", userId: "u1", category: "a", ts: 10, done: false }, // dup -> dropped
      { id: "e1b", userId: "u1", category: "b", ts: 5, done: false }, // pre-existing open in moveto
      { id: "e2", userId: "u2", category: "a", ts: 20, done: false }, // no dup -> moved
    ],
    records: [],
    currentSeason: { name: null, startedTs: null },
  };
  const r = bot.removeCategory(data, "a", "b");
  assert.equal(r.ok, true);
  assert.deepEqual(r.dropped.map((e) => e.id), ["e1"]);
  assert.deepEqual(r.moved.map((e) => e.id), ["e2"]);

  // Mirror the handler's logging step: a "removed" record for every dropped entry.
  const nowTs = 999;
  for (const e of r.dropped || []) bot.logRecord(data, bot.makeRecord(data, e, "removed", nowTs));

  const removedRecs = data.records.filter((rec) => rec.resolution === "removed");
  assert.equal(removedRecs.length, 1);
  assert.equal(removedRecs[0].reqId, "e1");
  assert.equal(removedRecs[0].requesterId, "u1");
  assert.equal(removedRecs[0].category, "a");
  assert.equal(removedRecs[0].resolvedTs, 999);

  // The moved (non-duplicate) entry must NOT get a record.
  assert.equal(data.records.find((rec) => rec.reqId === "e2"), undefined);
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

test("categorySuggestions: excludeId omits that id, keeps the rest", () => {
  const data = { categories: [
    { id: "guild-boss", label: "Guild Boss", emoji: "👹", archived: false },
    { id: "mvp5k", label: "MVP 5K", emoji: "⭐", archived: false },
  ] };
  const excluded = bot.categorySuggestions(data, "", "guild-boss");
  assert.deepEqual(excluded.map((c) => c.value), ["mvp5k"]);
  // no excludeId -> unchanged behavior
  const all = bot.categorySuggestions(data, "");
  assert.deepEqual(all.map((c) => c.value).sort(), ["guild-boss", "mvp5k"]);
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
  // The current season's identity is history now; a fresh unnamed cycle begins
  // (prevents /reset from showing the archived name + stale start date).
  assert.deepEqual(data.currentSeason, { name: null, startedTs: 999 });
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

test("seasonSelectOptions: current first then past (newest first), value = current|endedTs", () => {
  const data = {
    currentSeason: { name: "Now", startedTs: 1 },
    seasons: [
      { name: "S1", endedTs: 100, sortedTotal: 3 },
      { name: null, endedTs: 200, sortedTotal: 1 },
    ],
  };
  const opts = bot.seasonSelectOptions(data);
  assert.equal(opts[0].value, "current");
  assert.match(opts[0].label, /Now/);
  assert.deepEqual(opts.slice(1).map((o) => o.value), ["200", "100"]); // newest past first
  assert.match(opts[1].label, /\(unnamed\)/);                          // null name rendered
});

test("seasonPanelEmbed: shows current season label and past count, no raw null", () => {
  const data = {
    currentSeason: { name: null, startedTs: 1 },
    seasons: [{ name: "S1", endedTs: 100, sortedTotal: 3, byCategory: { a: 3 } }],
    categories: [{ id: "a", label: "A", emoji: "🅰", archived: false }],
    entries: [{ userId: "u1", category: "a", done: true }],
  };
  const embed = bot.seasonPanelEmbed(data, 1);
  const json = JSON.stringify(embed.data);
  assert.match(json, /\(unnamed\)/);   // current unnamed
  assert.match(json, /S1/);            // past season listed
  assert.doesNotMatch(json, /null/);   // no raw null leaked
});

test("seasonPanelEmbed: past-seasons field stays under Discord's 1024 limit with many long names", () => {
  const longName = "x".repeat(80); // the rename modal's max length
  const data = {
    currentSeason: { name: "Now", startedTs: 1 },
    seasons: Array.from({ length: 12 }, (_, i) => ({ name: longName, endedTs: 1000 + i, sortedTotal: 5 })),
    categories: [],
    entries: [],
  };
  const embed = bot.seasonPanelEmbed(data, 0);
  const pastField = embed.data.fields.find((f) => f.name === "Past seasons");
  assert.ok(pastField.value.length <= 1024, `field is ${pastField.value.length} chars`);
});

test("seasonPanelEmbed: warns that a new season closes pending requests", () => {
  const data = {
    currentSeason: { name: "Now", startedTs: 1 },
    seasons: [],
    categories: [],
    entries: [],
  };
  const embed = bot.seasonPanelEmbed(data, 0);
  const json = JSON.stringify(embed.data);
  assert.match(json, /new season/i);
  assert.match(json, /closes every pending request/i);
});

test("resetWarningEmbed: reports the waiting (not-done) count, singular vs plural", () => {
  const data = {
    entries: [
      { id: "e1", done: false },
      { id: "e2", done: false },
      { id: "e3", done: true },
    ],
  };
  const embed = bot.resetWarningEmbed(data);
  const json = JSON.stringify(embed.data);
  assert.match(json, /2 members are still waiting/);

  const one = bot.resetWarningEmbed({ entries: [{ id: "e1", done: false }] });
  assert.match(JSON.stringify(one.data), /1 member is still waiting/);

  const none = bot.resetWarningEmbed({ entries: [{ id: "e1", done: true }] });
  assert.match(JSON.stringify(none.data), /0 members are still waiting/);
});

test("resetConfirmStale (F1): stale past the TTL, fresh within it", () => {
  const now = 10_000_000;
  const ttl = 5 * 60_000;
  assert.equal(bot.resetConfirmStale(now - 6 * 60_000, now, ttl), true);
  assert.equal(bot.resetConfirmStale(now - 4 * 60_000, now, ttl), false);
  // exactly at the boundary is not stale (strictly greater-than only)
  assert.equal(bot.resetConfirmStale(now - ttl, now, ttl), false);
  assert.equal(bot.resetConfirmStale(now - ttl - 1, now, ttl), true);
});

test("resetWarningComponents (F1): confirm customId carries the issuedTs freshness token", () => {
  const issuedTs = 123456789;
  const rows = bot.resetWarningComponents(issuedTs);
  const json = JSON.stringify(rows.map((r) => r.toJSON()));
  assert.match(json, new RegExp(`reset:confirm:${issuedTs}`));
});

test("makeRecord: sorted carries helper + claim + season identity", () => {
  const data = { currentSeason: { name: "S5", startedTs: 100 } };
  const entry = { id: "e1", userId: "u1", category: "a", ts: 10, helpedBy: "h1", claimedBy: "h1", claimedTs: 20 };
  const r = bot.makeRecord(data, entry, "sorted", 50);
  assert.equal(r.reqId, "e1");
  assert.equal(r.requesterId, "u1");
  assert.equal(r.category, "a");
  assert.equal(r.resolution, "sorted");
  assert.equal(r.helperId, "h1");
  assert.equal(r.requestedTs, 10);
  assert.equal(r.resolvedTs, 50);
  assert.equal(r.claimedById, "h1");
  assert.equal(r.claimedTs, 20);
  assert.equal(r.seasonStartedTs, 100);
});

test("makeRecord: self/removed/unresolved carry no helperId", () => {
  const data = { currentSeason: { name: null, startedTs: 1 } };
  const entry = { id: "e2", userId: "u2", category: "b", ts: 5 };
  for (const res of ["self", "removed", "unresolved"]) {
    const r = bot.makeRecord(data, entry, res, 9);
    assert.equal(r.resolution, res);
    assert.equal(r.helperId, undefined);
    assert.equal(r.requesterId, "u2");
  }
});

test("logRecord: appends and prunes oldest beyond RECORD_CAP", () => {
  const data = { records: [] };
  for (let i = 0; i < bot.RECORD_CAP + 5; i++) bot.logRecord(data, { reqId: "r" + i });
  assert.equal(data.records.length, bot.RECORD_CAP);
  assert.equal(data.records[data.records.length - 1].reqId, "r" + (bot.RECORD_CAP + 4)); // newest kept
  assert.equal(data.records[0].reqId, "r5");                                             // oldest dropped

  // Well past the cap now (this loop already re-entered the prune branch 5
  // times). One more append must keep pruning correctly without throwing —
  // covers the "warn only once, prune every time" behavior.
  bot.logRecord(data, { reqId: "extra" });
  assert.equal(data.records.length, bot.RECORD_CAP);
  assert.equal(data.records[data.records.length - 1].reqId, "extra");
  assert.equal(data.records[0].reqId, "r6");
});

test("logRecord: initializes records when absent", () => {
  const data = {};
  bot.logRecord(data, { reqId: "x" });
  assert.deepEqual(data.records, [{ reqId: "x" }]);
});

test("toggleClaim: sets claimedTs on claim, clears on release, overwrites on re-claim", () => {
  const e = {};
  assert.deepEqual(bot.toggleClaim(e, "o1", 100), { action: "claimed", by: "o1" });
  assert.equal(e.claimedBy, "o1"); assert.equal(e.claimedTs, 100);
  assert.deepEqual(bot.toggleClaim(e, "o1", 200), { action: "released", by: "o1" });
  assert.equal(e.claimedBy, null); assert.equal(e.claimedTs, null);       // cleared
  bot.toggleClaim(e, "o2", 300);
  assert.equal(e.claimedBy, "o2"); assert.equal(e.claimedTs, 300);        // re-claim overwrites
  assert.equal(bot.toggleClaim(e, "o3", 400).action, "blocked");
  assert.equal(e.claimedTs, 300);                                         // blocked leaves it
});

test("releaseClaim: clears claimedBy/claimedTs and returns the entry", () => {
  const e = { claimedBy: "o1", claimedTs: 100 };
  const result = bot.releaseClaim(e);
  assert.equal(e.claimedBy, null);
  assert.equal(e.claimedTs, null);
  assert.equal(result, e); // returns the same entry, mutated
});

test("releaseClaim then toggleClaim: a new officer can claim after the stale holder is released", () => {
  // Regression guard for M8: the claim button's "blocked" branch used to leave
  // entry.claimedBy set forever once the holder left the guild. releaseClaim
  // is the pure seam the handler uses to clear it before re-running toggleClaim.
  const e = { claimedBy: "o1", claimedTs: 100 };
  bot.releaseClaim(e);
  const r = bot.toggleClaim(e, "o2", 200);
  assert.notEqual(r.action, "blocked");
  assert.deepEqual(r, { action: "claimed", by: "o2" });
  assert.equal(e.claimedBy, "o2");
  assert.equal(e.claimedTs, 200);
});

test("applyStaleClaimRelease: TOCTOU guard — a claim that changed hands during the membership-check await must not be stolen", () => {
  // Regression guard for the M8 auto-release TOCTOU (Fix 1). Interleave:
  //   1. Officer B clicks claim on an entry stale-held by X. toggleClaim
  //      returns blocked with r.by = "X".
  //   2. B awaits a membership check on X (REST) — this is the window.
  //   3. Meanwhile officer C also clicks: C's own membership check on X
  //      resolves first, C releases X's claim and claims it for itself. This
  //      is "saved" as the entry's live state.
  //   4. B's check resolves (X really is gone) and B re-loads fresh data —
  //      landing on the state C just saved — then runs the release-guard +
  //      toggle step.
  // B must see C's claim as LIVE (blocked), not steal it by blindly releasing
  // whatever the fresh entry holds.
  const savedState = { id: "e1", claimedBy: "X", claimedTs: 100 };
  // Step 3: C's full transaction against a copy of the pre-interleave state.
  bot.releaseClaim(savedState);
  bot.toggleClaim(savedState, "C", 150);
  assert.equal(savedState.claimedBy, "C"); // sanity: C now holds it live

  // Step 4: B's patch step runs against the state C just saved. B's stale
  // holder id (captured before its own await) is still "X".
  const result = bot.applyStaleClaimRelease(savedState, "X", "B", 200);

  assert.deepEqual(result, { action: "blocked", by: "C" });
  assert.equal(savedState.claimedBy, "C"); // C's live claim survives untouched
  assert.equal(savedState.claimedTs, 150);
});

test("applyStaleClaimRelease: releases and claims when the fresh entry still holds the stale claim", () => {
  // No interleave — the fresh reload shows the same stale holder still on it,
  // so B's release + claim should proceed normally.
  const freshEntry = { id: "e1", claimedBy: "X", claimedTs: 100 };
  const result = bot.applyStaleClaimRelease(freshEntry, "X", "B", 200);
  assert.deepEqual(result, { action: "claimed", by: "B" });
  assert.equal(freshEntry.claimedBy, "B");
  assert.equal(freshEntry.claimedTs, 200);
});

test("applyStaleClaimRelease: claims cleanly when the fresh entry was already released (no interleaved claim)", () => {
  const freshEntry = { id: "e1", claimedBy: null, claimedTs: null };
  const result = bot.applyStaleClaimRelease(freshEntry, "X", "B", 200);
  assert.deepEqual(result, { action: "claimed", by: "B" });
  assert.equal(freshEntry.claimedBy, "B");
});

test("isGoneError: true only for DiscordAPIError 10007/10013, false for anything else", () => {
  assert.equal(bot.isGoneError({ code: 10007 }), true); // Unknown Member
  assert.equal(bot.isGoneError({ code: 10013 }), true); // Unknown User
  assert.equal(bot.isGoneError({ code: 50013 }), false); // Missing Permissions
  assert.equal(bot.isGoneError({ code: 429 }), false); // rate limit
  assert.equal(bot.isGoneError(new Error("network blip")), false);
  assert.equal(bot.isGoneError(null), false);
  assert.equal(bot.isGoneError(undefined), false);
});

test("closeSeason: logs unresolved records for pending, not for done", () => {
  const data = {
    entries: [
      { id: "d1", userId: "u1", category: "a", ts: 1, done: true },
      { id: "p1", userId: "u2", category: "a", ts: 2, done: false },
      { id: "p2", userId: "u3", category: "b", ts: 3, done: false },
    ],
    seasons: [], records: [],
    currentSeason: { name: "S1", startedTs: 100 },
    categories: [{ id: "a", label: "A", emoji: "🅰", archived: false }, { id: "b", label: "B", emoji: "🅱", archived: false }],
  };
  bot.closeSeason(data, 999);
  const unresolved = data.records.filter((r) => r.resolution === "unresolved");
  assert.equal(unresolved.length, 2);                                  // p1, p2 only
  assert.deepEqual(unresolved.map((r) => r.reqId).sort(), ["p1", "p2"]);
  assert.equal(unresolved[0].seasonStartedTs, 100);                    // closing season's identity
});

const RECS = [
  { resolution: "sorted", helperId: "h1", requesterId: "u1", category: "a", requestedTs: 0,  resolvedTs: 100, seasonStartedTs: 1 },
  { resolution: "sorted", helperId: "h1", requesterId: "u2", category: "a", requestedTs: 0,  resolvedTs: 300, seasonStartedTs: 1, claimedById: "h1", claimedTs: 100 },
  { resolution: "sorted", helperId: "h2", requesterId: "u1", category: "b", requestedTs: 50, resolvedTs: 60,  seasonStartedTs: 2 },
  { resolution: "self",   requesterId: "u3", category: "a", requestedTs: 0, resolvedTs: 10,  seasonStartedTs: 2 },
  { resolution: "removed", requesterId: "u4", category: "b", requestedTs: 0, resolvedTs: 5,  seasonStartedTs: 2 },
  { resolution: "unresolved", requesterId: "u5", category: "a", requestedTs: 0, resolvedTs: 9, seasonStartedTs: 2 },
];

test("recordsForSeason: filters by immutable season identity", () => {
  assert.equal(bot.recordsForSeason(RECS, 1).length, 2);
  assert.equal(bot.recordsForSeason(RECS, 2).length, 4);
  assert.equal(bot.recordsForSeason(RECS, 999).length, 0);
});

test("helperTotals: counts sorted per helper, desc", () => {
  assert.deepEqual(bot.helperTotals(RECS), [["h1", 2], ["h2", 1]]);
  assert.deepEqual(bot.helperTotals([]), []);
});

test("requesterTotals: counts help received (sorted + self), desc", () => {
  // u1 sorted x2, u2 sorted x1, u3 self x1 ; removed/unresolved excluded
  assert.deepEqual(bot.requesterTotals(RECS), [["u1", 2], ["u2", 1], ["u3", 1]]);
});

test("categoryWait: mean-ready sums over valid sorted only", () => {
  const cw = bot.categoryWait(RECS);
  assert.deepEqual(cw.a, { waitMs: 400, waitN: 2 }); // 100 + 300
  assert.deepEqual(cw.b, { waitMs: 10, waitN: 1 });  // 60 - 50
});

test("helperBreakdown: per-category counts, wait, and claim-validity rule", () => {
  const h1 = bot.helperBreakdown(RECS, "h1");
  assert.equal(h1.total, 2);
  assert.equal(h1.byCat.a.n, 2);
  assert.equal(h1.byCat.a.waitMs, 400);
  assert.equal(h1.byCat.a.waitN, 2);
  assert.equal(h1.byCat.a.claimN, 1);         // only the record where claimedById === h1
  assert.equal(h1.byCat.a.claimMs, 200);      // 300 - 100
  const h2 = bot.helperBreakdown(RECS, "h2");
  assert.equal(h2.byCat.b.claimN, 0);         // no claim on that record
  assert.deepEqual(bot.helperBreakdown(RECS, "nobody"), { byCat: {}, total: 0 });
});

test("helperBreakdown: claim by a different helper is excluded (C1 rule)", () => {
  const recs = [{ resolution: "sorted", helperId: "B", requesterId: "u", category: "a", requestedTs: 0, resolvedTs: 100, claimedById: "A", claimedTs: 10 }];
  const b = bot.helperBreakdown(recs, "B");
  assert.equal(b.byCat.a.n, 1);
  assert.equal(b.byCat.a.claimN, 0);          // claim belonged to A, not the sorter B
});

test("demandSummary: counts by resolution", () => {
  assert.deepEqual(bot.demandSummary(RECS), { sorted: 3, self: 1, removed: 1, unresolved: 1 });
});

test("statsViewOptions: current (default) + all-time + past newest-first", () => {
  const data = { seasons: [{ name: "S1", endedTs: 100, sortedTotal: 3 }, { name: "S2", endedTs: 200, sortedTotal: 1 }] };
  const opts = bot.statsViewOptions(data);
  assert.equal(opts[0].value, "current");
  assert.equal(opts[0].default, true);
  assert.equal(opts[1].value, "alltime");
  assert.deepEqual(opts.slice(2).map((o) => o.value), ["200", "100"]); // newest past first
});

test("selectedViewFrom: recovers the stats:view menu's selected option", () => {
  const components = [
    {
      components: [
        {
          customId: "stats:view",
          options: [
            { label: "Current season", value: "current", default: false },
            { label: "All-time", value: "alltime", default: true },
          ],
        },
      ],
    },
    { components: [{ customId: "stats:member" }] },
  ];
  assert.equal(bot.selectedViewFrom(components), "alltime");
});

test("selectedViewFrom: missing stats:view select -> null", () => {
  assert.equal(bot.selectedViewFrom([{ components: [{ customId: "stats:member" }] }]), null);
  assert.equal(bot.selectedViewFrom([]), null);
  assert.equal(bot.selectedViewFrom(undefined), null);
});

test("allTimeEmbed: shows leaderboard names, no raw null/id leak", () => {
  const data = {
    records: [
      { resolution: "sorted", helperId: "h1", requesterId: "u1", category: "a", requestedTs: 0, resolvedTs: 100 },
      { resolution: "self", requesterId: "u2", category: "a", requestedTs: 0, resolvedTs: 5 },
    ],
    categories: [{ id: "a", label: "A", emoji: "🅰", archived: false }],
    seasons: [],
  };
  const embed = bot.allTimeEmbed(data, { h1: "Helper One" });
  const json = JSON.stringify(embed.data);
  assert.match(json, /Helper One/);
  assert.doesNotMatch(json, /"h1"/);   // raw id not leaked
});

test("allTimeEmbed: By category counts ALL sorted (agrees with demandSummary), not just valid-timing ones", () => {
  const data = {
    records: [
      // valid timing -> counted by categoryWait too
      { resolution: "sorted", helperId: "h1", requesterId: "u1", category: "a", requestedTs: 0, resolvedTs: 100 },
      // invalid timing (no requestedTs) -> categoryWait excludes it, but it's still a sorted record
      { resolution: "sorted", helperId: "h2", requesterId: "u2", category: "a", requestedTs: null, resolvedTs: 50 },
      // invalid timing (resolved before requested) -> also excluded by categoryWait
      { resolution: "sorted", helperId: "h1", requesterId: "u3", category: "a", requestedTs: 200, resolvedTs: 150 },
    ],
    categories: [{ id: "a", label: "A", emoji: "🅰", archived: false }],
    seasons: [],
  };
  const embed = bot.allTimeEmbed(data, {});
  const d = bot.demandSummary(data.records);
  assert.equal(d.sorted, 3);

  const catField = embed.data.fields.find((f) => f.name === "By category");
  assert.match(catField.value, /3 sorted/);      // matches demandSummary total, not categoryWait's 1
  assert.doesNotMatch(catField.value, /1 sorted/);

  const requestsField = embed.data.fields.find((f) => f.name === "Requests");
  assert.match(requestsField.value, /3 sorted/); // the two lines agree
});

test("memberEmbed: one member's per-category contribution", () => {
  const data = {
    records: [{ resolution: "sorted", helperId: "h1", requesterId: "u1", category: "a", requestedTs: 0, resolvedTs: 100 }],
    categories: [{ id: "a", label: "A", emoji: "🅰", archived: false }],
  };
  const embed = bot.memberEmbed(data, "h1", "Helper One");
  const json = JSON.stringify(embed.data);
  assert.match(json, /Helper One/);
  assert.match(json, /A/);             // category label present
});

test("seasonHelperEmbed: pre-M10 season (no records) renders a graceful note", () => {
  const data = { records: [], categories: [] };
  const season = { name: "Old", startedTs: 5, endedTs: 9, sortedTotal: 4 };
  const embed = bot.seasonHelperEmbed(data, season, {});
  assert.match(JSON.stringify(embed.data), /no per-request data/i);
});

test("setNudgeConfig: sets channel, keeps threshold when hours omitted", () => {
  const data = { nudgeThresholdHours: 48 };
  const r = bot.setNudgeConfig(data, "chan1", undefined);
  assert.deepEqual(r, { ok: true });
  assert.equal(data.nudgeChannelId, "chan1");
  assert.equal(data.nudgeThresholdHours, 48); // unchanged
});

test("setNudgeConfig: sets threshold when hours given", () => {
  const data = {};
  bot.setNudgeConfig(data, "chan1", 24);
  assert.equal(data.nudgeChannelId, "chan1");
  assert.equal(data.nudgeThresholdHours, 24);
});

test("setNudgeConfig: rejects non-positive / non-integer / absurd hours", () => {
  for (const bad of [0, -5, 2.5, 99999]) {
    const data = { nudgeThresholdHours: 48 };
    const r = bot.setNudgeConfig(data, "chan1", bad);
    assert.equal(r.ok, false);
    assert.match(r.error, /hours|whole number|between/i);
    assert.equal(data.nudgeChannelId, undefined); // not set on failure
    assert.equal(data.nudgeThresholdHours, 48);   // unchanged
  }
});

test("clearNudge: disables by nulling the channel", () => {
  const data = { nudgeChannelId: "chan1", nudgeThresholdHours: 24 };
  assert.deepEqual(bot.clearNudge(data), { ok: true });
  assert.equal(data.nudgeChannelId, null);
  assert.equal(data.nudgeThresholdHours, 24); // threshold retained
});

test("emptyData/readAndShape: nudge fields default safely", () => {
  const empty = bot.emptyData ? bot.emptyData() : null;
  if (empty) {
    assert.equal(empty.nudgeChannelId, null);
    assert.equal(empty.nudgeThresholdHours, 48);
    assert.equal(empty.lastNudgeTs, null);
  }
  // readAndShape via a minimal raw object
  const shaped = bot.readAndShape(JSON.stringify({}));
  assert.equal(shaped.nudgeChannelId, null);
  assert.equal(shaped.nudgeThresholdHours, 48);
  assert.equal(shaped.lastNudgeTs, null);
  const shaped2 = bot.readAndShape(JSON.stringify({ nudgeChannelId: "c", nudgeThresholdHours: 12, lastNudgeTs: 5 }));
  assert.equal(shaped2.nudgeChannelId, "c");
  assert.equal(shaped2.nudgeThresholdHours, 12);
  assert.equal(shaped2.lastNudgeTs, 5);
});

test("readAndShape: clamps nudgeThresholdHours (0/negative → 48; valid passes through)", () => {
  assert.equal(bot.readAndShape(JSON.stringify({ nudgeThresholdHours: 0 })).nudgeThresholdHours, 48);
  assert.equal(bot.readAndShape(JSON.stringify({ nudgeThresholdHours: -5 })).nudgeThresholdHours, 48);
  assert.equal(bot.readAndShape(JSON.stringify({ nudgeThresholdHours: 12 })).nudgeThresholdHours, 12);
});

test("staleEntries: open + past threshold only; excludes done and null ts", () => {
  const now = 1_000_000;
  const th = 100;
  const entries = [
    { id: "a", userId: "u1", category: "c", ts: now - 200, done: false }, // stale
    { id: "b", userId: "u2", category: "c", ts: now - 100, done: false }, // exactly at threshold → stale
    { id: "c", userId: "u3", category: "c", ts: now - 50, done: false },  // too fresh
    { id: "d", userId: "u4", category: "c", ts: now - 999, done: true },  // done → excluded
    { id: "e", userId: "u5", category: "c", ts: null, done: false },      // no ts → excluded
  ];
  const stale = bot.staleEntries(entries, now, th);
  assert.deepEqual(stale.map((e) => e.id), ["a", "b"]);
  assert.deepEqual(bot.staleEntries([], now, th), []);
  assert.deepEqual(bot.staleEntries(undefined, now, th), []);
});

test("dueForNudge: null lastNudgeTs is due; respects the cadence boundary", () => {
  const cad = 1000;
  assert.equal(bot.dueForNudge({}, 5000, cad), true);                      // never nudged → due
  assert.equal(bot.dueForNudge({ lastNudgeTs: 4000 }, 5000, cad), true);   // exactly cadence → due
  assert.equal(bot.dueForNudge({ lastNudgeTs: 4001 }, 5000, cad), false);  // just under → not due
});

test("dueForNudge: a future lastNudgeTs (clock stepped backward) is treated as due", () => {
  const now = 1_000_000;
  const cad = 86_400_000;
  assert.equal(bot.dueForNudge({ lastNudgeTs: now + 3 * 86_400_000 }, now, cad), true);
});

test("nudgeDigestEmbed: groups by category, shows names + waits, no id leak", () => {
  const now = 1_000_000;
  const data = {
    nudgeThresholdHours: 48,
    categories: [
      { id: "a", label: "Alpha", emoji: "🅰", archived: false },
      { id: "b", label: "Beta", emoji: "🅱", archived: false },
    ],
  };
  const stale = [
    { userId: "u1", category: "a", ts: now - 200_000 },
    { userId: "u2", category: "a", ts: now - 100_000 },
    { userId: "u3", category: "b", ts: now - 300_000 },
  ];
  const embed = bot.nudgeDigestEmbed(data, stale, { u1: "Ann", u2: "Bob", u3: "Cyd" }, now);
  const json = JSON.stringify(embed.data);
  assert.match(json, /Ann/);
  assert.match(json, /Alpha/);
  assert.match(json, /Beta/);
  assert.doesNotMatch(json, /"u1"/);       // raw id not leaked
  assert.match(json, /3 request/i);        // count in title
});

test("nudgeDigestEmbed: left-guild requester falls back, not raw id/null", () => {
  const now = 1_000_000;
  const data = { nudgeThresholdHours: 48, categories: [{ id: "a", label: "Alpha", emoji: "🅰", archived: false }] };
  const embed = bot.nudgeDigestEmbed(data, [{ userId: "gone", category: "a", ts: now - 500_000 }], {}, now);
  const json = JSON.stringify(embed.data);
  assert.match(json, /left the server/i);
  assert.doesNotMatch(json, /null/);
});

test("nudgeDigestEmbed: budgets total embed size under heavy load (8 cats x 30 stale)", () => {
  const now = 1_000_000;
  const categories = [];
  for (let i = 0; i < 8; i++) categories.push({ id: `cat${i}`, label: `Category${i}`, emoji: "🔥", archived: false });
  const data = { nudgeThresholdHours: 48, categories };
  const names = {};
  const stale = [];
  for (let c = 0; c < 8; c++) {
    for (let n = 0; n < 30; n++) {
      const uid = `u${c}_${n}`;
      names[uid] = "x".repeat(20);
      stale.push({ userId: uid, category: `cat${c}`, ts: now - 500_000 });
    }
  }
  const embed = bot.nudgeDigestEmbed(data, stale, names, now);
  // This load actually exceeds the internal MAX_CHARS budget (8 x ~1024-char
  // fields), so the truncation path — and its appended overflow field — is
  // genuinely exercised here, not just field-count capping.
  const last = embed.data.fields[embed.data.fields.length - 1];
  assert.equal(last.name, "…", "expected an overflow field to be appended");
  const totalFieldChars = embed.data.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  // TRUE total incl. the overflow field's own size — this is the exact
  // accounting the overflow-budget fix guarantees, not just an accident of
  // the ~500-char margin between MAX_CHARS (5500) and Discord's hard 6000.
  assert.ok(totalFieldChars < 6000, `expected total field chars (incl. overflow) < 6000, got ${totalFieldChars}`);
  assert.ok(embed.data.fields.length <= 25, `expected <= 25 fields, got ${embed.data.fields.length}`);
  assert.match(embed.data.title, /240/); // true total, not the shown subset
});

test("nudgeDigestEmbed: 26 distinct categories does not throw and caps fields at 25", () => {
  const now = 1_000_000;
  const categories = [];
  for (let i = 0; i < 26; i++) categories.push({ id: `cat${i}`, label: `C${i}`, emoji: "⭐", archived: false });
  const data = { nudgeThresholdHours: 48, categories };
  const stale = categories.map((c, i) => ({ userId: `u${i}`, category: c.id, ts: now - 100_000 }));
  assert.doesNotThrow(() => {
    const embed = bot.nudgeDigestEmbed(data, stale, {}, now);
    assert.ok(embed.data.fields.length <= 25, `expected <= 25 fields, got ${embed.data.fields.length}`);
  });
});

// ---------- M13-T2: /imsorted self-service select panel ----------

test("openEntriesFor: only this user's open entries — excludes done and other users", () => {
  const data = {
    entries: [
      { id: "1", userId: "u1", category: "a", done: false },
      { id: "2", userId: "u1", category: "b", done: true }, // done — excluded
      { id: "3", userId: "u2", category: "a", done: false }, // other user — excluded
      { id: "4", userId: "u1", category: "b", done: false },
    ],
  };
  const mine = bot.openEntriesFor(data, "u1");
  assert.deepEqual(mine.map((e) => e.id).sort(), ["1", "4"]);
});

test("openEntriesFor: empty when entries missing or user has none", () => {
  assert.deepEqual(bot.openEntriesFor({}, "u1"), []);
  assert.deepEqual(bot.openEntriesFor({ entries: [] }, "u1"), []);
});

test("imsortedSelectOptions: label emoji+category, description waiting-duration, value=id, ≤25", () => {
  const data = { categories: [{ id: "a", label: "Season Run 5K", emoji: "🏃", archived: false }] };
  const now = 1_000_000;
  const entries = [
    { id: "e1", category: "a", ts: now - 8 * 60 * 1000 }, // 8m ago
  ];
  const opts = bot.imsortedSelectOptions(data, entries, now);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].value, "e1");
  assert.equal(opts[0].label, "🏃 Season Run 5K");
  assert.equal(opts[0].description, "waiting 8m");
});

test("imsortedSelectOptions: caps at 25 options even with more entries", () => {
  const data = { categories: [{ id: "a", label: "A", emoji: "🅰", archived: false }] };
  const entries = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, category: "a", ts: 0 }));
  const opts = bot.imsortedSelectOptions(data, entries, 100);
  assert.equal(opts.length, 25);
});

test("closeEntries: logs one \"self\" record per entry BEFORE removing it from data.entries", () => {
  const data = {
    entries: [
      { id: "1", userId: "u1", category: "a", done: false, ts: 10 },
      { id: "2", userId: "u1", category: "b", done: false, ts: 20 },
      { id: "3", userId: "u1", category: "a", done: false, ts: 30 }, // not picked
    ],
  };
  const mine = data.entries.filter((e) => e.id !== "3");
  bot.closeEntries(data, mine, "self", 999);
  // Every picked entry logged exactly one "self" record — invariant #6.
  assert.equal(data.records.length, 2);
  assert.deepEqual(data.records.map((r) => r.reqId).sort(), ["1", "2"]);
  for (const r of data.records) {
    assert.equal(r.resolution, "self");
    assert.equal(r.resolvedTs, 999);
  }
  // Picked entries are gone; the untouched one survives.
  assert.deepEqual(data.entries.map((e) => e.id), ["3"]);
});

test("closeEntries: no-op on an empty selection (no record, nothing removed)", () => {
  const data = { entries: [{ id: "1", userId: "u1", done: false }] };
  bot.closeEntries(data, [], "self", 1);
  assert.deepEqual(data.entries.map((e) => e.id), ["1"]);
  assert.equal((data.records || []).length, 0);
});

// ---------- M13-T3: /helped + /remove shared "resolve:" picker panel ----------

test("resolveEntryAsSorted: sets done/doneTs/helpedBy and logs one \"sorted\" record BEFORE the caller saves", () => {
  const entry = { id: "1", userId: "u1", username: "Alice", category: "a", done: false, ts: 5 };
  const data = { entries: [entry] };
  bot.resolveEntryAsSorted(data, entry, "manager1", 999);
  assert.equal(entry.done, true);
  assert.equal(entry.doneTs, 999);
  assert.equal(entry.helpedBy, "manager1");
  // invariant #6 — exactly one record, logged for this entry.
  assert.equal(data.records.length, 1);
  assert.equal(data.records[0].reqId, "1");
  assert.equal(data.records[0].resolution, "sorted");
  assert.equal(data.records[0].helperId, "manager1");
  assert.equal(data.records[0].resolvedTs, 999);
  // Entry stays in data.entries (helped never removes it — just marks done).
  assert.deepEqual(data.entries.map((e) => e.id), ["1"]);
});

test("resolveEntryAsRemoved: logs one \"removed\" record BEFORE dropping the entry, no DM/done fields set", () => {
  const entry = { id: "1", userId: "u1", username: "Alice", category: "a", done: false, ts: 5 };
  const other = { id: "2", userId: "u2", username: "Bob", category: "b", done: false };
  const data = { entries: [entry, other] };
  bot.resolveEntryAsRemoved(data, entry, 777);
  assert.equal(data.records.length, 1);
  assert.equal(data.records[0].reqId, "1");
  assert.equal(data.records[0].resolution, "removed");
  assert.equal(data.records[0].resolvedTs, 777);
  // helped-only fields never touched (remove never marks done).
  assert.equal(entry.done, false);
  assert.equal(entry.helpedBy, undefined);
  // Entry gone, the other one untouched.
  assert.deepEqual(data.entries.map((e) => e.id), ["2"]);
});

test("resolveEntryPanelEmbed: shows the no-dead-end message when the member has zero open entries", () => {
  const embed = bot.resolveEntryPanelEmbed("helped", "Alice", 0);
  const json = JSON.stringify(embed.data);
  assert.match(json, /Alice/);
  assert.match(json, /no open requests/i);
});

test("resolveEntryPanelEmbed: shows the open-request count for helped and remove", () => {
  const helpedEmbed = bot.resolveEntryPanelEmbed("helped", "Alice", 2);
  assert.match(JSON.stringify(helpedEmbed.data), /Alice.*2.*open request/is);
  const removeEmbed = bot.resolveEntryPanelEmbed("remove", "Bob", 1);
  assert.match(JSON.stringify(removeEmbed.data), /Bob.*1.*open request/is);
});

test("resolveMemberPanelComponents: wires the resolve:<action>:member UserSelect customId", () => {
  const helped = JSON.stringify(bot.resolveMemberPanelComponents("helped"));
  assert.match(helped, /resolve:helped:member/);
  const remove = JSON.stringify(bot.resolveMemberPanelComponents("remove"));
  assert.match(remove, /resolve:remove:member/);
});

test("resolveEntryPanelComponents: wires the resolve:<action>:entry StringSelect customId and options", () => {
  const options = bot.imsortedSelectOptions({ categories: [{ id: "a", label: "A", emoji: "🅰", archived: false }] }, [
    { id: "e1", category: "a", ts: 0 },
  ], 0);
  const helped = JSON.stringify(bot.resolveEntryPanelComponents("helped", options));
  assert.match(helped, /resolve:helped:entry/);
  assert.match(helped, /"value":"e1"/);
  const remove = JSON.stringify(bot.resolveEntryPanelComponents("remove", options));
  assert.match(remove, /resolve:remove:entry/);
});

test("openEntriesFor: only the picked member's open entries appear as select options (M13-T3 reuse)", () => {
  const data = {
    categories: [
      { id: "a", label: "Season Run 5K", emoji: "🏃", archived: false },
      { id: "b", label: "MVP 5K", emoji: "🏆", archived: false },
    ],
    entries: [
      { id: "1", userId: "member1", category: "a", done: false, ts: 0 },
      { id: "2", userId: "member1", category: "b", done: true, ts: 0 }, // done — excluded
      { id: "3", userId: "member2", category: "a", done: false, ts: 0 }, // other member — excluded
    ],
  };
  const mine = bot.openEntriesFor(data, "member1");
  const options = bot.imsortedSelectOptions(data, mine, 0);
  assert.equal(options.length, 1);
  assert.equal(options[0].value, "1");
  assert.equal(options[0].label, "🏃 Season Run 5K");
});

test("entryStepPanelPayload (F5): no-dead-end panel when the member has zero open entries", () => {
  const data = { categories: [], entries: [] };
  const payload = bot.entryStepPanelPayload(data, "helped", "member1", "Alice");
  assert.deepEqual(payload.components, []);
  assert.match(JSON.stringify(payload.embeds[0].data), /Alice/);
  assert.match(JSON.stringify(payload.embeds[0].data), /no open requests/i);
});

test("entryStepPanelPayload (F5): entry-step select for the member's open requests, skipping the UserSelect step", () => {
  const data = {
    categories: [{ id: "a", label: "Season Run 5K", emoji: "🏃", archived: false }],
    entries: [
      { id: "1", userId: "member1", category: "a", done: false, ts: 0 },
      { id: "2", userId: "member2", category: "a", done: false, ts: 0 }, // other member — excluded
    ],
  };
  const payload = bot.entryStepPanelPayload(data, "remove", "member1", "Bob");
  assert.match(JSON.stringify(payload.embeds[0].data), /Bob.*1.*open request/is);
  const json = JSON.stringify(payload.components);
  assert.match(json, /resolve:remove:entry/);
  assert.match(json, /"value":"1"/);
});

// ---------- /config roles panel (M13-T5) ----------

test("rolesPanelEmbed: lists manager roles as mentions and the notify role, with none/off fallbacks", () => {
  const withRoles = bot.rolesPanelEmbed({ managerRoleIds: ["r1", "r2"], notifyRoleId: "n1" });
  const json = JSON.stringify(withRoles.data);
  assert.match(json, /<@&r1>/);
  assert.match(json, /<@&r2>/);
  assert.match(json, /<@&n1>/);

  const empty = bot.rolesPanelEmbed({ managerRoleIds: [], notifyRoleId: null });
  const emptyJson = JSON.stringify(empty.data);
  assert.match(emptyJson, /none/i);
  assert.match(emptyJson, /off/i);
});

test("rolesRemoveSelectOptions: only offers the current manager roles, label via nameOf, value=id", () => {
  const nameOf = (id) => ({ r1: "Officers", r2: "Helpers" }[id]);
  const options = bot.rolesRemoveSelectOptions(["r1", "r2"], nameOf);
  assert.deepEqual(options, [
    { label: "Officers", value: "r1" },
    { label: "Helpers", value: "r2" },
  ]);
});

test("rolesRemoveSelectOptions: falls back to a placeholder label when nameOf can't resolve (role left the guild)", () => {
  const options = bot.rolesRemoveSelectOptions(["r1"], () => undefined);
  assert.equal(options.length, 1);
  assert.equal(options[0].value, "r1");
  assert.match(options[0].label, /r1/);
});

test("rolesRemoveSelectOptions: no manager roles yields an empty array (caller must omit the select)", () => {
  assert.deepEqual(bot.rolesRemoveSelectOptions([], () => "x"), []);
  assert.deepEqual(bot.rolesRemoveSelectOptions(undefined, () => "x"), []);
});

test("rolesPanelComponents: wires roles:add / roles:notify RoleSelects and the roles:notifyclear button", () => {
  const json = JSON.stringify(bot.rolesPanelComponents({ managerRoleIds: [], notifyRoleId: null }, () => undefined));
  assert.match(json, /roles:add/);
  assert.match(json, /roles:notify"/);
  assert.match(json, /roles:notifyclear/);
});

test("rolesPanelComponents: omits the roles:remove select when there are no manager roles (no 0-option select)", () => {
  const json = JSON.stringify(bot.rolesPanelComponents({ managerRoleIds: [], notifyRoleId: null }, () => undefined));
  assert.doesNotMatch(json, /roles:remove/);
});

test("rolesPanelComponents: includes the roles:remove select, populated with only current managers, when present", () => {
  const nameOf = (id) => ({ r1: "Officers" }[id]);
  const json = JSON.stringify(bot.rolesPanelComponents({ managerRoleIds: ["r1"], notifyRoleId: null }, nameOf));
  assert.match(json, /roles:remove/);
  assert.match(json, /"label":"Officers"/);
  assert.match(json, /"value":"r1"/);
});
