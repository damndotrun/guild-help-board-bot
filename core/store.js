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

  function load(defaults = {}) {
    if (!fs.existsSync(file)) return structuredClone(defaults);
    try {
      return read(file);
    } catch (err) {
      console.error(`[store] ${file} unreadable (${err.message}); restoring from ${bak}`);
      try {
        return read(bak);
      } catch {
        console.error(`[store] ${bak} unreadable too; starting from defaults`);
        return structuredClone(defaults);
      }
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
