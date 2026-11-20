// lfg.json through the platform store (core/store.js: atomic write + .bak),
// shaped on every load, and the append-only journal lfg-log.jsonl next to it
// (M4 spec §4.3): one JSON object per line, never trimmed, kept out of
// lfg.json so a big journal never slows the saves. Synchronous on purpose —
// an action must never await between load() and save().
const fs = require("fs");
const path = require("path");
const { emptyData, shape } = require("./state");

const LOG_FILE = "lfg-log.jsonl";

const load = (ctx) => shape(ctx.store.load(emptyData()));
const save = (ctx, data) => ctx.store.save(data);
const logPath = (ctx) => path.join(ctx.config.DATA_DIR, LOG_FILE);

// A journal write that fails is logged, never thrown: the action already happened.
function appendLog(ctx, lines) {
  if (!lines || lines.length === 0) return;
  try {
    fs.appendFileSync(logPath(ctx), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  } catch (err) {
    ctx.log.error(`could not write ${LOG_FILE}: ${err.message}`);
  }
}

// save + journal: the one way an action or the tick persists its outcome.
function commit(ctx, data, out) {
  save(ctx, data);
  appendLog(ctx, out.log);
}

// Every journal line; a half-written (unparsable) line is skipped.
function readLog(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // the last line of a crash mid-append — ignore it
    }
  }
  return out;
}

module.exports = { LOG_FILE, load, save, logPath, appendLog, commit, readLog };
