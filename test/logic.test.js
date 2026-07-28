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
