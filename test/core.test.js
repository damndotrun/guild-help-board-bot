const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseModules } = require("../core/config");
const { createStore } = require("../core/store");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bbcore-"));

test("parseModules: missing or blank → [help]", () => {
  assert.deepEqual(parseModules(undefined), ["help"]);
  assert.deepEqual(parseModules(""), ["help"]);
  assert.deepEqual(parseModules("   "), ["help"]);
  assert.deepEqual(parseModules(" , "), ["help"]);
});

test("parseModules: trims and drops empty items", () => {
  assert.deepEqual(parseModules("help, "), ["help"]);
  assert.deepEqual(parseModules(" help ,lfg"), ["help", "lfg"]);
});

test("parseModules: duplicate is a hard error", () => {
  assert.throws(() => parseModules("help,help"), /twice/);
});

test("store: load on a missing file returns a fresh copy of defaults", () => {
  const s = createStore(path.join(tmpDir(), "x.json"));
  const defaults = { items: [] };
  const a = s.load(defaults);
  a.items.push(1);
  assert.deepEqual(s.load(defaults), { items: [] });
});

test("store: createStore touches nothing on disk", () => {
  const dir = tmpDir();
  createStore(path.join(dir, "x.json"));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("store: save/load round-trip, no temp files left", () => {
  const dir = tmpDir();
  const s = createStore(path.join(dir, "x.json"));
  s.save({ a: 1 });
  s.save({ a: 2 });
  assert.deepEqual(s.load({}), { a: 2 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ["x.json", "x.json.bak"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "x.json.bak"), "utf8")), { a: 1 });
});

test("store: corrupt main file restores from .bak", () => {
  const dir = tmpDir();
  const s = createStore(path.join(dir, "x.json"));
  s.save({ a: 1 });
  s.save({ a: 2 });
  fs.writeFileSync(path.join(dir, "x.json"), "{broken");
  assert.deepEqual(s.load({}), { a: 1 });
});

test("store: corrupt main and .bak → defaults", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "x.json"), "{broken");
  fs.writeFileSync(path.join(dir, "x.json.bak"), "{broken");
  assert.deepEqual(createStore(path.join(dir, "x.json")).load({ z: 0 }), { z: 0 });
});

test("store: a corrupt main file is never copied over a good .bak", () => {
  const dir = tmpDir();
  const s = createStore(path.join(dir, "x.json"));
  s.save({ a: 1 });
  s.save({ a: 2 }); // .bak = {a:1}
  fs.writeFileSync(path.join(dir, "x.json"), "{broken");
  s.save({ a: 3 }); // must not back up the broken file
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "x.json.bak"), "utf8")), { a: 1 });
});

const { normalizeModule, loadModules } = require("../core/loader");
const { createRouter, buildPrefixMap, buildCommandMap, EXPIRED_TEXT } = require("../core/router");
const { MessageFlags } = require("discord.js");

function fakeInteraction({ type, commandName, customId, deferred = false, replied = false }) {
  const calls = [];
  return {
    commandName,
    customId,
    deferred,
    replied,
    calls,
    isAutocomplete: () => type === "autocomplete",
    isChatInputCommand: () => type === "command",
    isModalSubmit: () => type === "modal",
    isRepliable: () => type !== "autocomplete",
    reply: async (p) => calls.push(["reply", p]),
    editReply: async (p) => calls.push(["editReply", p]),
    followUp: async (p) => calls.push(["followUp", p]),
    respond: async (p) => calls.push(["respond", p]),
  };
}

const quietLog = { log() {}, warn() {}, error() {} };

function testModules(seen) {
  return [
    normalizeModule({
      name: "alpha",
      aliases: ["legacy"],
      commands: [{ name: "alpha" }],
      handle: async (i) => seen.push(["alpha", i.commandName || i.customId]),
    }),
    normalizeModule({
      name: "beta",
      commands: [{ name: "beta" }],
      onCommand: { beta: async () => seen.push(["beta", "cmd"]) },
      components: { go: async (i, ctx, param) => seen.push(["beta", `go(${param})`]) },
      modals: { save: async (i, ctx, param) => seen.push(["beta", `save(${param})`]) },
    }),
  ];
}

test("loader: defaults for aliases, dataFile, jobs; toJSON on builders", () => {
  const m = normalizeModule({ name: "lfg", commands: [{ toJSON: () => ({ name: "x" }) }], handle: async () => {} });
  assert.deepEqual(m.aliases, []);
  assert.equal(m.dataFile, "lfg.json");
  assert.deepEqual(m.jobs, []);
  assert.deepEqual(m.commands, [{ name: "x" }]);
});

test("loader: invalid name and unknown module are hard errors", () => {
  assert.throws(() => normalizeModule({ name: "Bad Name" }), /Invalid module name/);
  assert.throws(() => loadModules(["nope"], { help: () => ({}) }), /Unknown module "nope"/);
});

test("router: command → module by name; component → module by prefix and alias", async () => {
  const seen = [];
  const route = createRouter({ modules: testModules(seen), ctxFor: () => ({}), log: quietLog });
  await route(fakeInteraction({ type: "command", commandName: "alpha" }));
  await route(fakeInteraction({ type: "button", customId: "alpha:x" }));
  await route(fakeInteraction({ type: "button", customId: "legacy:y:z" }));
  await route(fakeInteraction({ type: "command", commandName: "beta" }));
  assert.deepEqual(seen, [
    ["alpha", "alpha"],
    ["alpha", "alpha:x"],
    ["alpha", "legacy:y:z"],
    ["beta", "cmd"],
  ]);
});

test("router: buildHandle passes the full remainder after the 2nd colon as param", async () => {
  const seen = [];
  const route = createRouter({ modules: testModules(seen), ctxFor: () => ({}), log: quietLog });
  await route(fakeInteraction({ type: "button", customId: "beta:go:a:b:c" }));
  await route(fakeInteraction({ type: "modal", customId: "beta:save:42" }));
  await route(fakeInteraction({ type: "button", customId: "beta:go" }));
  assert.deepEqual(seen, [
    ["beta", "go(a:b:c)"],
    ["beta", "save(42)"],
    ["beta", "go()"],
  ]);
});

test("router: unknown prefix or command → ephemeral expired notice", async () => {
  const route = createRouter({ modules: testModules([]), ctxFor: () => ({}), log: quietLog });
  const a = fakeInteraction({ type: "button", customId: "gone:x" });
  const b = fakeInteraction({ type: "command", commandName: "gone" });
  await route(a);
  await route(b);
  for (const i of [a, b]) {
    assert.equal(i.calls.length, 1);
    assert.equal(i.calls[0][0], "reply");
    assert.equal(i.calls[0][1].content, EXPIRED_TEXT);
    assert.equal(i.calls[0][1].flags, MessageFlags.Ephemeral);
  }
});

test("router: unknown autocomplete → empty list", async () => {
  const route = createRouter({ modules: testModules([]), ctxFor: () => ({}), log: quietLog });
  const i = fakeInteraction({ type: "autocomplete", commandName: "gone" });
  await route(i);
  assert.deepEqual(i.calls, [["respond", []]]);
});

test("router: a throwing module answers with an error and the next interaction still routes", async () => {
  const seen = [];
  const boom = normalizeModule({
    name: "boom",
    commands: [{ name: "boom" }],
    handle: async () => {
      throw new Error("kaput");
    },
  });
  const route = createRouter({ modules: [boom, ...testModules(seen)], ctxFor: () => ({}), log: quietLog });
  const fresh = fakeInteraction({ type: "command", commandName: "boom" });
  const deferred = fakeInteraction({ type: "command", commandName: "boom", deferred: true });
  await route(fresh);
  await route(deferred);
  assert.equal(fresh.calls[0][0], "reply");
  assert.equal(fresh.calls[0][1].flags, MessageFlags.Ephemeral);
  assert.equal(deferred.calls[0][0], "editReply");
  await route(fakeInteraction({ type: "command", commandName: "beta" }));
  assert.deepEqual(seen, [["beta", "cmd"]]);
});

test("router: a throwing autocomplete answers with an empty list", async () => {
  const boom = normalizeModule({
    name: "boom",
    commands: [{ name: "boom" }],
    handle: async () => {
      throw new Error("kaput");
    },
  });
  const route = createRouter({ modules: [boom], ctxFor: () => ({}), log: quietLog });
  const i = fakeInteraction({ type: "autocomplete", commandName: "boom" });
  await route(i);
  assert.deepEqual(i.calls, [["respond", []]]);
});

test("router: prefix or command collisions are hard errors", () => {
  const a = normalizeModule({ name: "a", aliases: ["x"], commands: [{ name: "same" }], handle: async () => {} });
  const b = normalizeModule({ name: "b", aliases: ["x"], commands: [], handle: async () => {} });
  const c = normalizeModule({ name: "c", commands: [{ name: "same" }], handle: async () => {} });
  assert.throws(() => buildPrefixMap([a, b]), /prefix "x"/);
  assert.throws(() => buildCommandMap([a, c]), /command "\/same"/);
});

const { collectCommands, registerCommands } = require("../core/registry");
const { Routes } = require("discord.js");

test("registry: one guild-scoped PUT with the union of all module commands", async () => {
  const mods = [
    normalizeModule({ name: "a", commands: [{ name: "one" }, { name: "two" }], handle: async () => {} }),
    normalizeModule({ name: "b", commands: [{ name: "three" }], handle: async () => {} }),
  ];
  const puts = [];
  const lines = [];
  const rest = { put: async (route, opts) => puts.push([route, opts]) };
  const env = { CLIENT_ID: "app", GUILD_ID: "guild", DISCORD_TOKEN: "t" };
  await registerCommands(mods, { rest, env, log: { log: (l) => lines.push(l) } });
  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], Routes.applicationGuildCommands("app", "guild"));
  assert.deepEqual(puts[0][1].body.map((c) => c.name), ["one", "two", "three"]);
  assert.deepEqual(lines, ["Slash commands registered."]);
});

test("registry: a duplicate command name fails before any PUT", async () => {
  const mods = [
    normalizeModule({ name: "a", commands: [{ name: "dup" }], handle: async () => {} }),
    normalizeModule({ name: "b", commands: [{ name: "dup" }], handle: async () => {} }),
  ];
  let called = false;
  const rest = { put: async () => (called = true) };
  assert.throws(() => collectCommands(mods), /dup/);
  await assert.rejects(registerCommands(mods, { rest, env: {}, log: quietLog }), /dup/);
  assert.equal(called, false);
});
