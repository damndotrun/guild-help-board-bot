// Per-module JSON store: synchronous, atomic write (tmp + rename) and a .bak
// sidecar with auto-restore — the same safety model as the help board's
// data.json (guild-bot D9). Synchronous on purpose: a handler must never
// `await` between load() and save().
const fs = require("fs");

function createStore(file) {
  const tmp = `${file}.tmp`;
  const bak = `${file}.bak`;
  const bakTmp = `${file}.bak.tmp`;
  const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

  // Keep a copy of an unreadable file before the next save replaces it
  // ("<file>.corrupt-<mtime>", once per bad version) — see help's loadData.
  function keepCorruptCopy(p) {
    try {
      const dest = `${p}.corrupt-${Math.floor(fs.statSync(p).mtimeMs)}`;
      if (fs.existsSync(dest)) return;
      fs.copyFileSync(p, dest);
      console.error(`[store] kept a copy of the unreadable ${p} as ${dest}`);
    } catch (err) {
      console.error(`[store] could not keep a copy of the unreadable ${p}: ${err.message}`);
    }
  }

  // The backup, or undefined when there is none or it is unreadable.
  function readBackup() {
    if (!fs.existsSync(bak)) return undefined;
    try {
      return read(bak);
    } catch {
      console.error(`[store] ${bak} unreadable too`);
      keepCorruptCopy(bak);
      return undefined;
    }
  }

  function load(defaults = {}) {
    if (!fs.existsSync(file)) {
      // A missing primary next to a backup: start from the backup, or the
      // second save would back up the near-empty new file over it.
      const restored = readBackup();
      if (restored === undefined) return structuredClone(defaults);
      console.error(`[store] ${file} missing; restored from ${bak}`);
      return restored;
    }
    try {
      return read(file);
    } catch (err) {
      console.error(`[store] ${file} unreadable (${err.message}); restoring from ${bak}`);
      keepCorruptCopy(file);
      const restored = readBackup();
      if (restored !== undefined) return restored;
      console.error("[store] starting from defaults");
      return structuredClone(defaults);
    }
  }

  function save(data) {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    try {
      if (fs.existsSync(file)) {
        read(file); // only back up a file that is itself valid
        fs.copyFileSync(file, bakTmp);
        fs.renameSync(bakTmp, bak);
      }
    } catch (err) {
      console.error(`[store] backup of ${file} skipped: ${err.message}`);
    }
    fs.renameSync(tmp, file);
  }

  return { file, load, save };
}

module.exports = { createStore };
