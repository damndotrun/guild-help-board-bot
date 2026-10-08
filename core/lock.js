// Single-instance advisory lock (guild-bot D8): LOG-ONLY. A fresh heartbeat
// from another process only warns — a stale lock must never wedge the
// "restart = update" deploy path.
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");

const LOCK_FILE = path.join(DATA_DIR, "bot.lock");
// Named in the fresh-heartbeat warning exactly as before the platform split, so
// existing ops-log greps keep matching.
const DATA_FILE = path.join(DATA_DIR, "data.json");
const LOCK_STALE_MS = 90_000; // treat a lock older than this as abandoned
const LOCK_REFRESH_MS = 30_000; // heartbeat cadence (well under the stale window)

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return null; // no lock, or unreadable — treat as absent
  }
}

// Advisory only: a fresh heartbeat means another instance is probably alive.
function isLockFresh(lock, now) {
  return (
    !!lock &&
    typeof lock.heartbeat === "number" &&
    now - lock.heartbeat < LOCK_STALE_MS
  );
}

// What this process wrote — releaseLock removes the lock only while it is still ours.
let ownLock = null;

function acquireLock() {
  const now = Date.now();
  const existing = readLock();
  if (isLockFresh(existing, now)) {
    console.warn(
      `WARNING: bot.lock heartbeat is fresh (pid ${existing.pid}); another ` +
        `instance may be running against ${DATA_FILE}. Starting anyway.`
    );
  }
  const write = (ts) =>
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, startedTs: now, heartbeat: ts })
    );
  ownLock = { pid: process.pid, startedTs: now };
  try {
    write(now);
  } catch (err) {
    console.error("Could not write bot.lock:", err.message);
  }
  const timer = setInterval(() => {
    try {
      write(Date.now());
    } catch {
      // transient FS error — the next tick will retry
    }
  }, LOCK_REFRESH_MS);
  timer.unref(); // never keep the process alive for the heartbeat alone
  return timer;
}

// Remove the lock on graceful shutdown (Docker sends SIGTERM on stop) so a
// fast redeploy doesn't see our own stale heartbeat and false-warn. Only our
// own: during an overlapping swap the file may already be the new instance's
// (pid alone is not enough — in a container both can be pid 1). Unreadable →
// removed, as before.
function releaseLock() {
  if (!ownLock) return;
  const current = readLock();
  if (current && (current.pid !== ownLock.pid || current.startedTs !== ownLock.startedTs)) return;
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // already gone or unremovable — nothing to do
  }
}

module.exports = { LOCK_FILE, isLockFresh, acquireLock, releaseLock };
