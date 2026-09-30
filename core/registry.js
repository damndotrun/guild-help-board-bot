// Central slash-command registration: ONE guild-scoped bulk PUT with the union
// of every enabled module's commands. (A bulk overwrite deletes whatever is not
// in the body, so per-module registration would erase each other.) Runs once
// per start, like the original bot; updating existing commands does not count
// against the 200-creates-per-day limit.
const { REST, Routes } = require("discord.js");
const { buildCommandMap } = require("./router");

function collectCommands(modules) {
  buildCommandMap(modules); // throws on a duplicate name
  return modules.flatMap((m) => m.commands);
}

async function registerCommands(modules, { rest, env = process.env, log = console } = {}) {
  const body = collectCommands(modules);
  const client = rest || new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
  await client.put(Routes.applicationGuildCommands(env.CLIENT_ID, env.GUILD_ID), { body });
  log.log("Slash commands registered.");
  return body;
}

module.exports = { collectCommands, registerCommands };
