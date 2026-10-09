"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../core/store");
const store = require("../modules/lfg/store");
const { emptyData } = require("../modules/lfg/state");

function tmpCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bblfgstore-"));
  const errors = [];
  return { dir, errors, ctx: { store: createStore(path.join(dir, "lfg.json")), config: { DATA_DIR: dir }, log: { log() {}, warn() {}, error: (m) => errors.push(m) } } };
}

test("store: a missing lfg.json loads as the empty store; a saved one round-trips shaped", () => {
  const { ctx } = tmpCtx();
  assert.deepEqual(store.load(ctx), emptyData());
  const d = store.load(ctx);
  d.listings.push({ id: "L1", posterId: "u1", createdAt: 5 });
  d.extra = "kept";
  store.save(ctx, d);
  const again = store.load(ctx);
  assert.equal(again.extra, "kept");
  assert.deepEqual([again.listings[0].state, again.listings[0].requests], ["open", []]);
});

test("store: commit saves and appends one journal line per entry", () => {
  const { ctx, dir } = tmpCtx();
  const d = store.load(ctx);
  store.commit(ctx, d, { log: [{ type: "prefs", ts: 1, userId: "u1", dm: true, requestDm: true }, { type: "gmPing", ts: 2, userId: "u1", on: false }] });
  store.commit(ctx, d, { log: [] });
  assert.ok(fs.existsSync(path.join(dir, "lfg.json")));
  assert.deepEqual(store.readLog(path.join(dir, store.LOG_FILE)).map((l) => l.type), ["prefs", "gmPing"]);
});

test("store: readLog skips a half-written last line; a missing journal reads as empty", () => {
  const { dir } = tmpCtx();
  const file = path.join(dir, store.LOG_FILE);
  assert.deepEqual(store.readLog(file), []);
  fs.writeFileSync(file, '{"type":"request","ts":1}\n{"type":"listing","ts":2}\n{"type":"req');
  assert.deepEqual(store.readLog(file).map((l) => l.ts), [1, 2]);
});

test("store: a journal that cannot be written is logged, not thrown", () => {
  const { ctx, errors } = tmpCtx();
  ctx.config.DATA_DIR = path.join(ctx.config.DATA_DIR, "missing", "dir");
  assert.doesNotThrow(() => store.appendLog(ctx, [{ type: "dm", ts: 1 }]));
  assert.match(errors[0], /could not write lfg-log\.jsonl/);
});
