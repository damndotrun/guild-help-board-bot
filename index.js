// Guild Help Board — Discord bot, platform core entry.
// Loads the enabled modules (MODULES env, default "help"), routes every
// interaction to its module, registers all module commands in one guild-scoped
// PUT, and logs in. Module logic lives under modules/<name>/.

require("dotenv").config(); // before anything reads process.env

const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");
const config = require("./core/config");
const lock = require("./core/lock");
const { loadModules } = require("./core/loader");
const { createRouter } = require("./core/router");
const { registerCommands } = require("./core/registry");
const { createStore } = require("./core/store");
const help = require("./modules/help/help");

// test/logic.test.js requires this file: keep re-exporting the help logic and
// the lock predicate so the existing tests run unchanged.
module.exports = { ...help, isLockFresh: lock.isLockFresh };

function prefixedLog(name) {
  return {
    log: (...a) => console.log(`[${name}]`, ...a),
    warn: (...a) => console.warn(`[${name}]`, ...a),
    error: (...a) => console.error(`[${name}]`, ...a),
  };
}

function startJobs(mod, ctx) {
  for (const job of mod.jobs) {
    const timer = setInterval(() => {
      Promise.resolve()
        .then(() => job.run(ctx))
        .catch((err) => console.error(`[${mod.name}] job ${job.name} failed:`, err));
    }, job.intervalMs);
    timer.unref();
  }
}

async function start() {
  const missingEnv = config.REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missingEnv.length > 0) {
    console.error(
      `Missing required environment variable(s): ${missingEnv.join(", ")}.\n` +
        "Copy .env.example to .env and fill them in (see README)."
    );
    process.exit(1);
  }

  const modules = loadModules(config.parseModules(process.env.MODULES));
  console.log(`Modules: ${modules.map((m) => m.name).join(", ")}`);

  lock.acquireLock();
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      lock.releaseLock();
      process.exit(0);
    });
  }

  // parse: [] by default means no message ever pings anyone unless a specific
  // call opts in. This neutralises mention injection via nicknames in replies.
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [] },
  });

  const contexts = new Map();
  const ctxFor = (mod) => {
    if (!contexts.has(mod.name)) {
      contexts.set(mod.name, {
        client,
        log: prefixedLog(mod.name),
        config: { DATA_DIR: config.DATA_DIR },
        store: createStore(path.join(config.DATA_DIR, mod.dataFile)),
      });
    }
    return contexts.get(mod.name);
  };

  for (const mod of modules) if (mod.bind) mod.bind(client);
  client.on("interactionCreate", createRouter({ modules, ctxFor }));
  client.once("clientReady", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    for (const mod of modules) {
      try {
        if (mod.onReady) await mod.onReady(ctxFor(mod));
        startJobs(mod, ctxFor(mod));
      } catch (err) {
        console.error(`[${mod.name}] onReady failed:`, err);
      }
    }
  });

  await registerCommands(modules);
  await client.login(process.env.DISCORD_TOKEN);
}

if (require.main === module) {
  // Last-resort safety net so a stray rejection is logged, not silently fatal.
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });
  start().catch((err) => {
    console.error("Failed to start the bot:", err);
    process.exit(1);
  });
}
