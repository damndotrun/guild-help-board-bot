// Guild Help Board — Discord bot, platform core entry.
// Loads the enabled modules (MODULES env, default "help"), routes every
// interaction to its module, registers all module commands in one guild-scoped
// PUT, and logs in. Module logic lives under modules/<name>/.

require("dotenv").config(); // before anything reads process.env

const fs = require("fs");
const { Client, GatewayIntentBits } = require("discord.js");
const config = require("./core/config");
const lock = require("./core/lock");
const { loadModules } = require("./core/loader");
const { createRouter } = require("./core/router");
const { registerCommands, collectCommands } = require("./core/registry");
const { createCtxFor, runReady } = require("./core/runtime");
const { createPerms, managerRolesFrom } = require("./core/perms");
const { createMenuModule } = require("./core/menu");
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

  let publicUrl;
  try {
    publicUrl = config.parsePublicUrl(config.PUBLIC_URL);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  let web;
  try {
    web = config.parseWebConfig(process.env, publicUrl);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (!web && publicUrl) {
    console.warn("PUBLIC_URL is set but the web admin is off (no WEB_PORT / DISCORD_CLIENT_SECRET / SESSION_SECRET).");
  }

  // Every write goes to DATA_DIR: a typo or an unmounted volume must stop the
  // start, not leave a bot that answers "Something went wrong" to every write.
  try {
    fs.accessSync(config.DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
    if (!fs.statSync(config.DATA_DIR).isDirectory()) throw new Error("not a directory");
  } catch (e) {
    console.error(`DATA_DIR (${config.DATA_DIR}) is not a writable directory (${e.code || e.message}) — check the path and the volume mount.`);
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
  // One shared permission object; throws if two modules claim the manager roles.
  const perms = createPerms({ getManagerRoleIds: managerRolesFrom(modules) });
  const ctxFor = createCtxFor({ client, dataDir: config.DATA_DIR, perms });
  // The core's /menu hub routes and registers like a module (owns /menu + "menu:").
  const routed = [...modules, createMenuModule({ modules, ctxFor, perms, publicUrl })];
  const route = createRouter({ modules: routed, ctxFor }); // throws on customId-prefix collisions
  collectCommands(routed); // throws on duplicate command names

  // The web admin listens before the first side effect (bot.lock), so a busy
  // port stops the start cleanly. Until the bot has logged in, getGuild() is
  // null and every page answers 503 "not connected yet". Required lazily: a
  // bot without web config never loads Express.
  let webServer = null;
  if (web) {
    const { startWeb } = require("./web/server");
    const getGuild = async () => (client.isReady() ? client.guilds.cache.get(process.env.GUILD_ID) ?? null : null);
    webServer = await startWeb({ web, modules, ctxFor, perms, getGuild });
    console.log(`Web admin listening on port ${web.port} (${web.origin})`);
  }

  lock.acquireLock();
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      if (webServer) webServer.close();
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

  await registerCommands(routed);
  await client.login(process.env.DISCORD_TOKEN);
}

if (require.main === module) {
  // Last-resort safety net so a stray rejection is logged, not silently fatal.
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });
  start().catch((err) => {
    console.error("Failed to start the bot:", err);
    // A start that failed after acquireLock (command registration, login) must
    // not leave a fresh heartbeat that makes the restart warn falsely.
    lock.releaseLock();
    process.exit(1);
  });
}
