// Runtime wiring shared by index.js: per-module context, background jobs and
// the on-ready sequence. Kept out of index.js so it can be tested without a
// Discord client.
const path = require("path");
const { createStore } = require("./store");

function prefixedLog(name) {
  return {
    log: (...a) => console.log(`[${name}]`, ...a),
    warn: (...a) => console.warn(`[${name}]`, ...a),
    error: (...a) => console.error(`[${name}]`, ...a),
  };
}

// ctx = { client, log, config, store? }. A module that declares dataFile: null
// (help: it owns data.json through its own loadData/saveData) gets no store at
// all, so it cannot reach the file through the platform's .bak rules by accident.
function createCtxFor({ client, dataDir }) {
  const contexts = new Map();
  return (mod) => {
    if (!contexts.has(mod.name)) {
      const ctx = { client, log: prefixedLog(mod.name), config: { DATA_DIR: dataDir } };
      if (mod.dataFile) ctx.store = createStore(path.join(dataDir, mod.dataFile));
      contexts.set(mod.name, ctx);
    }
    return contexts.get(mod.name);
  };
}

function startJobs(mod, ctx, log = console) {
  return mod.jobs.map((job) => {
    const timer = setInterval(() => {
      Promise.resolve()
        .then(() => job.run(ctx))
        .catch((err) => log.error(`[${mod.name}] job ${job.name} failed:`, err));
    }, job.intervalMs);
    timer.unref();
    return timer;
  });
}

// onReady of every module, then its jobs. A failing onReady is logged but must
// not silently skip that module's jobs (or the next module).
async function runReady(modules, ctxFor, { log = console } = {}) {
  const timers = [];
  for (const mod of modules) {
    const ctx = ctxFor(mod);
    try {
      if (mod.onReady) await mod.onReady(ctx);
    } catch (err) {
      log.error(`[${mod.name}] onReady failed:`, err);
    }
    try {
      timers.push(...startJobs(mod, ctx, log));
    } catch (err) {
      log.error(`[${mod.name}] starting jobs failed:`, err);
    }
  }
  return timers;
}

module.exports = { prefixedLog, createCtxFor, startJobs, runReady };
