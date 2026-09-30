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
  assert.equal(m.dataFile, null); // help owns data.json itself; no ctx.store
});

// Text-input field ids inside modals: never routed (only the modal's own
// customId is), so they carry no prefix.
const MODAL_FIELD_IDS = ["name", "label", "emoji"];
// Core-owned customIds help.js may carry: the board's Menu button (M2b).
const CORE_IDS = ["menu:home"];

test("help module: every setCustomId in help.js starts with an owned literal prefix", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "modules", "help", "help.js"), "utf8");
  const total = [...src.matchAll(/setCustomId\(/g)].length;
  const literal = [...src.matchAll(/setCustomId\(\s*([`"'])([^`"']*)\1/g)].map((x) => x[2]);
  const prefixed = literal.filter((v) => /^[a-z]+:/.test(v));
  const fields = literal.filter((v) => MODAL_FIELD_IDS.includes(v));
  // A setCustomId(variable) or an unknown literal would slip past a prefix
  // scan, so require that every single call is accounted for.
  assert.ok(total >= 20, `expected to find the setCustomId calls, found ${total}`);
  assert.equal(prefixed.length + fields.length, total, "a setCustomId call is neither a literal owned prefix nor a known modal field id");
  for (const v of prefixed) {
    assert.ok(LEGACY_PREFIXES.includes(v.split(":")[0]) || CORE_IDS.includes(v), `unowned customId prefix in "${v}"`);
  }
  // ...and the customId comparisons in dispatch
  const cmp = [...src.matchAll(/customId\s*===\s*[`"']([a-z]+):/g)].map((x) => x[1]);
  assert.ok(cmp.length > 0);
  for (const p of cmp) assert.ok(LEGACY_PREFIXES.includes(p), `unowned customId prefix "${p}" in a comparison`);
});

test("help module via the real router: every legacy prefix, command and autocomplete reaches help.dispatch", async () => {
  const helpLogic = require("../modules/help/help");
  const { loadModules } = require("../core/loader");
  const { createRouter, EXPIRED_TEXT } = require("../core/router");
  const { createCtxFor } = require("../core/runtime");
  const modules = loadModules(["help"]);
  const ctxFor = createCtxFor({ client: {}, dataDir: TMP });
  assert.equal("store" in ctxFor(modules[0]), false, "help must not get a ctx.store");
  const route = createRouter({ modules, ctxFor, log: { log() {}, warn() {}, error() {} } });

  const mk = (kind, key) => {
    const calls = [];
    const routed = kind === "command" || kind === "autocomplete";
    return {
      kind,
      commandName: routed ? key : undefined,
      customId: routed ? undefined : key,
      calls,
      isAutocomplete: () => kind === "autocomplete",
      isChatInputCommand: () => kind === "command",
      isModalSubmit: () => kind === "modal",
      isRepliable: () => kind !== "autocomplete",
      reply: async (p) => calls.push(["reply", p]),
      editReply: async (p) => calls.push(["editReply", p]),
      followUp: async (p) => calls.push(["followUp", p]),
      respond: async (p) => calls.push(["respond", p]),
    };
  };

  const cases = [
    ["button", "help:claim:123"], ["button", "help:sorted:123"], ["button", "help:remove:123"],
    ["button", "board:needhelp"], ["string-select", "board:pick"],
    ["button", "season:new"], ["button", "season:rename"], ["button", "season:renamepick:5"],
    ["string-select", "season:view"], ["modal", "season:newmodal"], ["modal", "season:renamemodal:5"],
    ["string-select", "stats:view"], ["user-select", "stats:member"],
    ["button", "imsorted:all"], ["string-select", "imsorted:pick"],
    ["button", "reset:confirm:1700000000000"], ["button", "reset:cancel"],
    ["string-select", "resolve:helped:entry"], ["string-select", "resolve:remove:entry"],
    ["user-select", "resolve:helped:member"], ["user-select", "resolve:remove:member"],
    ["role-select", "roles:add"], ["role-select", "roles:notify"],
    ["string-select", "roles:remove"], ["button", "roles:notifyclear"],
    ["modal", "catadd:submit"],
    ...normalizeModule(helpModule).commands.flatMap((c) => [["command", c.name], ["autocomplete", c.name]]),
  ];
  // all 9 legacy prefixes are exercised by at least one component/modal case
  const covered = new Set(cases.filter(([k]) => k !== "command" && k !== "autocomplete").map(([, id]) => id.split(":")[0]));
  for (const p of LEGACY_PREFIXES) assert.ok(covered.has(p), `no routing case for prefix "${p}"`);

  const original = helpLogic.dispatch;
  const dispatched = [];
  helpLogic.dispatch = async (interaction) => void dispatched.push(interaction);
  try {
    const sent = [];
    for (const [kind, key] of cases) {
      const i = mk(kind, key);
      sent.push(i);
      await route(i);
    }
    assert.equal(dispatched.length, cases.length);
    sent.forEach((i, n) => {
      const what = `${i.kind} ${i.customId || i.commandName}`;
      assert.equal(dispatched[n], i, `${what} was not dispatched to help`);
      assert.equal(i.calls.some(([, p]) => p && p.content === EXPIRED_TEXT), false, `${what} got the expired reply`);
      assert.deepEqual(i.calls, [], `the router itself must not answer a routed ${what}`);
    });
  } finally {
    helpLogic.dispatch = original;
  }
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
