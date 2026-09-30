const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseModules, parsePublicUrl, parseWebConfig } = require("../core/config");
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

test("parsePublicUrl: unset/blank → null (no link); an http(s) origin comes back canonical", () => {
  assert.equal(parsePublicUrl(undefined), null);
  assert.equal(parsePublicUrl(""), null);
  assert.equal(parsePublicUrl("   "), null);
  assert.equal(parsePublicUrl("https://bb.example.com"), "https://bb.example.com");
  assert.equal(parsePublicUrl("https://BB.Example.com/"), "https://bb.example.com");
  assert.equal(parsePublicUrl(" http://localhost:3000 "), "http://localhost:3000");
  assert.equal(parsePublicUrl("https://bot-test.damndot.run:443"), "https://bot-test.damndot.run");
});

test("parsePublicUrl: scheme-less, non-http(s), spaced or over-long values fail fast and name PUBLIC_URL", () => {
  for (const bad of ["nas.local:3000", "admin.example.com", "https://a b", "ftp://example.com", "javascript:alert(1)", `https://example.com/${"x".repeat(520)}`]) {
    assert.throws(() => parsePublicUrl(bad), /PUBLIC_URL/, bad);
  }
});

// Polish backlog (M2b): an odd-but-valid URL such as "http:foo" passed new URL()
// but Discord rejects it in a Link button (400) — officers got no /menu reply.
test("parsePublicUrl: only the literal http(s)://host[:port] shape — no path, query, fragment or credentials", () => {
  for (const bad of ["http:foo", "https:/bb.example.com", "https://", "https://bb.example.com/admin", "https://bb.example.com?x=1", "https://bb.example.com/#top", "https://user:pw@bb.example.com"]) {
    assert.throws(() => parsePublicUrl(bad), /PUBLIC_URL/, bad);
  }
});

// Controller ruling C4: a PUBLIC_URL may carry credentials (https://user:pw@host);
// no error message may ever echo the raw value.
test("parsePublicUrl: no error message echoes the raw value (credentials in a rejected URL stay out of the log)", () => {
  for (const bad of [
    "https://admin:hunter2-fake-pw@bb.example.com",
    "https://admin:hunter2-fake-pw@bb.example.com/path",
    "https://admin:hunter2-fake-pw@",
    "ftp://admin:hunter2-fake-pw@bb.example.com",
    `https://admin:hunter2-fake-pw@bb.example.com/${"x".repeat(520)}`,
    "https://admin:hunter2-fake-pw@bb .example.com",
  ]) {
    assert.throws(
      () => parsePublicUrl(bad),
      (e) => /PUBLIC_URL/.test(e.message) && !/hunter2|admin:|@/.test(e.message),
      bad
    );
  }
});

test("parseWebConfig: none of WEB_PORT / DISCORD_CLIENT_SECRET / SESSION_SECRET → null (web off, even with PUBLIC_URL)", () => {
  assert.equal(parseWebConfig({}, null), null);
  assert.equal(parseWebConfig({ PUBLIC_URL: "https://bb.example.com", WEB_PORT: " " }, "https://bb.example.com"), null);
});

const SECRET = "s".repeat(32);
const FULL = { CLIENT_ID: "123", WEB_PORT: "3000", DISCORD_CLIENT_SECRET: "cs", SESSION_SECRET: SECRET };

test("parseWebConfig: a complete https config", () => {
  assert.deepEqual(parseWebConfig(FULL, "https://bb.example.com"), {
    origin: "https://bb.example.com",
    redirectUri: "https://bb.example.com/auth/callback",
    secure: true,
    port: 3000,
    clientId: "123",
    clientSecret: "cs",
    sessionSecret: SECRET,
  });
  assert.equal(parseWebConfig(FULL, "http://localhost:3000").secure, false);
});

test("parseWebConfig: partly configured is a hard error naming what is missing, never echoing a secret", () => {
  assert.throws(() => parseWebConfig({ WEB_PORT: "3000" }, "https://bb.example.com"), /DISCORD_CLIENT_SECRET, SESSION_SECRET are missing/);
  assert.throws(() => parseWebConfig(FULL, null), /PUBLIC_URL is missing/);
  assert.throws(
    () => parseWebConfig({ ...FULL, SESSION_SECRET: "short-secret-value" }, "https://bb.example.com"),
    (e) => /SESSION_SECRET must be at least 32 characters/.test(e.message) && !e.message.includes("short-secret-value")
  );
});

test("parseWebConfig: no error message contains the client secret or the session secret", () => {
  const env = { ...FULL, DISCORD_CLIENT_SECRET: "fake-client-secret-xyz", SESSION_SECRET: "fake-short-session-secret" };
  const leaks = (e) => !e.message.includes("fake-client-secret-xyz") && !e.message.includes("fake-short-session-secret");
  // too-short session secret
  assert.throws(() => parseWebConfig(env, "https://bb.example.com"), leaks);
  // bad port with both secrets present
  assert.throws(() => parseWebConfig({ ...env, SESSION_SECRET: SECRET, WEB_PORT: "0" }, "https://bb.example.com"), (e) => leaks(e) && !e.message.includes(SECRET));
  // missing PUBLIC_URL with both secrets present
  assert.throws(() => parseWebConfig({ ...env, SESSION_SECRET: SECRET }, null), (e) => leaks(e) && !e.message.includes(SECRET));
  // missing SESSION_SECRET while the client secret is set
  assert.throws(() => parseWebConfig({ WEB_PORT: "3000", DISCORD_CLIENT_SECRET: "fake-client-secret-xyz" }, "https://bb.example.com"), leaks);
});

test("parseWebConfig: WEB_PORT must be 1–65535 digits", () => {
  for (const bad of ["0", "65536", "30x", "-1", "3000.5"]) {
    assert.throws(() => parseWebConfig({ ...FULL, WEB_PORT: bad }, "https://bb.example.com"), /WEB_PORT/, bad);
  }
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

test("loader: inherited Object.prototype names are unknown modules, not loaded", () => {
  for (const n of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    assert.throws(() => loadModules([n], { help: () => ({ name: "help", handle: async () => {} }) }), /Unknown module/, n);
  }
});

test("loader: a module whose exported name differs from its MODULES key is a hard error", () => {
  assert.throws(
    () => loadModules(["help"], { help: () => ({ name: "other", handle: async () => {} }) }),
    /"help".*"other"|"other".*"help"/
  );
});

test("loader: dataFile null means the module has no store", () => {
  const m = normalizeModule({ name: "raw", dataFile: null, handle: async () => {} });
  assert.equal(m.dataFile, null);
  assert.equal(normalizeModule({ name: "raw", handle: async () => {} }).dataFile, "raw.json");
});

test("loader: jobs are validated (positive finite intervalMs, function run)", () => {
  const mk = (jobs) => () => normalizeModule({ name: "j", handle: async () => {}, jobs });
  const ok = { name: "tick", intervalMs: 1000, run: async () => {} };
  assert.equal(mk([ok])().jobs.length, 1);
  for (const bad of [
    { ...ok, intervalMs: 0 },
    { ...ok, intervalMs: -5 },
    { ...ok, intervalMs: NaN },
    { ...ok, intervalMs: Infinity },
    { ...ok, intervalMs: "1000" },
    { ...ok, intervalMs: undefined },
    { ...ok, intervalMs: 2 ** 31 },
    { ...ok, run: undefined },
    { ...ok, run: "nope" },
    null,
  ]) {
    assert.throws(mk([bad]), /job/i, JSON.stringify(bad));
  }
  assert.throws(mk("nope"), /jobs/);
});

const { createCtxFor, startJobs, runReady } = require("../core/runtime");

test("runtime: ctxFor gives a store for a module with a dataFile and none for dataFile null", () => {
  const dir = tmpDir();
  const ctxFor = createCtxFor({ client: {}, dataDir: dir, log: quietLog });
  const withStore = normalizeModule({ name: "a", handle: async () => {} });
  const noStore = normalizeModule({ name: "b", dataFile: null, handle: async () => {} });
  const ca = ctxFor(withStore);
  assert.equal(ca.store.file, path.join(dir, "a.json"));
  assert.equal(ctxFor(withStore), ca); // cached
  const cb = ctxFor(noStore);
  assert.equal("store" in cb, false);
  assert.equal(cb.config.DATA_DIR, dir);
});

test("runtime: a throwing onReady is logged and the module's jobs still start", { timeout: 2000 }, async () => {
  const errors = [];
  let ran;
  const done = new Promise((r) => (ran = r));
  const mod = normalizeModule({
    name: "r",
    handle: async () => {},
    onReady: async () => {
      throw new Error("ready-boom");
    },
    jobs: [{ name: "tick", intervalMs: 5, run: async () => ran("ran") }],
  });
  const keep = setInterval(() => {}, 50); // job timers are unref'd; keep the loop alive while we wait
  let timers = [];
  try {
    timers = await runReady([mod], () => ({}), { log: { error: (...a) => errors.push(a) } });
    assert.equal(await done, "ran");
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /\[r\] onReady failed/);
  } finally {
    timers.forEach(clearInterval);
    clearInterval(keep);
  }
});

test("runtime: a failing job run is logged and does not stop the interval", { timeout: 2000 }, async () => {
  const errors = [];
  let n = 0;
  let third;
  const done = new Promise((r) => (third = r));
  const mod = normalizeModule({
    name: "r",
    handle: async () => {},
    jobs: [
      {
        name: "flaky",
        intervalMs: 5,
        run: async () => {
          if (++n === 3) third();
          throw new Error("job-boom");
        },
      },
    ],
  });
  const keep = setInterval(() => {}, 50); // job timers are unref'd; keep the loop alive while we wait
  const timers = startJobs(mod, {}, { error: (...a) => errors.push(a) });
  try {
    await done;
    assert.ok(errors.length >= 2);
    assert.match(String(errors[0][0]), /\[r\] job flaky failed/);
  } finally {
    timers.forEach(clearInterval);
    clearInterval(keep);
  }
});
