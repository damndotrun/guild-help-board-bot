// Guild Help Board — Discord bot, platform core entry.
// Loads the enabled modules (MODULES env, default "help"), routes every
// interaction to its module, registers all module commands in one guild-scoped
// PUT, and logs in. Module logic lives under modules/<name>/.

require("dotenv").config(); // before anything reads process.env

const { Client, GatewayIntentBits } = require("discord.js");
const config = require("./core/config");
const lock = require("./core/lock");
const { loadModules } = require("./core/loader");
const { createRouter } = require("./core/router");
const { registerCommands, collectCommands } = require("./core/registry");
const { createCtxFor, runReady } = require("./core/runtime");
const help = require("./modules/help/help");

// test/logic.test.js requires this file: keep re-exporting the help logic and
// the lock predicate so the existing tests run unchanged.
module.exports = { ...help, isLockFresh: lock.isLockFresh };

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

  // Build everything that can fail on config/wiring alone BEFORE the first side
  // effect (bot.lock), so a bad MODULES / colliding module exits cleanly.
  // parse: [] by default means no message ever pings anyone unless a specific
  // call opts in. This neutralises mention injection via nicknames in replies.
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [] },
  });
  const ctxFor = createCtxFor({ client, dataDir: config.DATA_DIR });
  const route = createRouter({ modules, ctxFor }); // throws on customId-prefix collisions
  collectCommands(modules); // throws on duplicate command names

  lock.acquireLock();
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      lock.releaseLock();
      process.exit(0);
    });
  }

  for (const mod of modules) if (mod.bind) mod.bind(client);
  client.on("interactionCreate", route);
  client.once("clientReady", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await runReady(modules, ctxFor);
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
