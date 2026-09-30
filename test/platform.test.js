const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bbplatform-"));
process.env.DATA_DIR = TMP;
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
process.env.GUILD_ID = "test";

const bot = require("../index.js");
const helpModule = require("../modules/help");
const { normalizeModule } = require("../core/loader");

const LEGACY_PREFIXES = ["help", "board", "season", "stats", "imsorted", "reset", "resolve", "roles", "catadd"];

test("help module: owns exactly the 9 legacy customId prefixes", () => {
  const m = normalizeModule(helpModule);
  assert.deepEqual([m.name, ...m.aliases].sort(), [...LEGACY_PREFIXES].sort());
  assert.equal(m.dataFile, "data.json");
});

test("help module: every customId in help.js starts with an owned prefix", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "modules", "help", "help.js"), "utf8");
  const re = /(?:setCustomId\(\s*|customId\s*===\s*)[`"']([a-z]+):/g;
  const found = new Set([...src.matchAll(re)].map((x) => x[1]));
  assert.ok(found.size >= 8, `expected to find the legacy prefixes, found: ${[...found]}`);
  for (const p of found) assert.ok(LEGACY_PREFIXES.includes(p), `unowned customId prefix "${p}"`);
});

test("help module: registers the same 10 slash commands as before", () => {
  const names = normalizeModule(helpModule).commands.map((c) => c.name).sort();
  assert.deepEqual(names, ["board", "config", "help", "helped", "imsorted", "needhelp", "remove", "reset", "season", "stats"]);
});

test("compat: an existing data.json in DATA_DIR is read as-is", () => {
  const d = bot.emptyData();
  d.boardChannelId = "111111111111111111";
  d.boardMessageId = "222222222222222222";
  fs.writeFileSync(path.join(TMP, "data.json"), JSON.stringify(d, null, 2));
  const loaded = bot.loadData();
  assert.equal(loaded.boardChannelId, "111111111111111111");
  assert.equal(loaded.boardMessageId, "222222222222222222");
});

test("compat: nothing is written under modules/help/ and no help.json appears", () => {
  bot.saveData(bot.loadData());
  const helpDir = path.join(__dirname, "..", "modules", "help");
  assert.deepEqual(fs.readdirSync(helpDir).filter((f) => f.endsWith(".json")), []);
  assert.equal(fs.existsSync(path.join(TMP, "help.json")), false);
  assert.equal(fs.existsSync(path.join(TMP, "data.json")), true);
});

test("compat: save → load → save keeps data.json byte-identical", () => {
  bot.saveData(bot.loadData());
  const first = fs.readFileSync(path.join(TMP, "data.json"), "utf8");
  bot.saveData(bot.loadData());
  assert.equal(fs.readFileSync(path.join(TMP, "data.json"), "utf8"), first);
});

test("index re-exports the help logic and the lock predicate", () => {
  assert.equal(typeof bot.loadData, "function");
  assert.equal(typeof bot.buildBoardEmbed, "function");
  assert.equal(typeof bot.isLockFresh, "function");
});
