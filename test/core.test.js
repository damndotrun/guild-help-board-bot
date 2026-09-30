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
