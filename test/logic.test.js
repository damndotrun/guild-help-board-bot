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

test("catOf: known + unknown fallback", () => {
  assert.equal(bot.catOf("seasonrun5k").label, "Season Run 5K");
  assert.deepEqual(bot.catOf("weird"), { label: "weird", emoji: "❓" });
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
