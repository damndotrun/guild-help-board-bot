// Interaction router: slash commands and autocomplete go to the module that
// registered the command name; buttons, selects and modals go to the module
// that owns the customId prefix (the part before the first ":").
const { MessageFlags } = require("discord.js");

const EXPIRED_TEXT = "This panel or command is no longer active — please open it again.";
const ERROR_TEXT = "Something went wrong running that command.";

function buildPrefixMap(modules) {
  const map = new Map();
  for (const mod of modules) {
    for (const prefix of [mod.name, ...mod.aliases]) {
      if (map.has(prefix)) {
        throw new Error(`customId prefix "${prefix}" is claimed by both "${map.get(prefix).name}" and "${mod.name}"`);
      }
      map.set(prefix, mod);
    }
  }
  return map;
}

function buildCommandMap(modules) {
  const map = new Map();
  for (const mod of modules) {
    for (const cmd of mod.commands) {
      if (map.has(cmd.name)) {
        throw new Error(`command "/${cmd.name}" is registered by both "${map.get(cmd.name).name}" and "${mod.name}"`);
      }
      map.set(cmd.name, mod);
    }
  }
  return map;
}

function prefixOf(customId) {
  const i = customId.indexOf(":");
  return i === -1 ? customId : customId.slice(0, i);
}

async function safeRespond(interaction, payload, log) {
  try {
    if (interaction.deferred) return await interaction.editReply(payload);
    if (interaction.replied) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (err) {
    log.error("[router] could not answer the interaction:", err);
  }
}

async function safeAutocompleteEmpty(interaction, log) {
  try {
    await interaction.respond([]);
  } catch (err) {
    log.error("[router] could not answer autocomplete:", err);
  }
}

function createRouter({ modules, ctxFor, log = console }) {
  const commandMap = buildCommandMap(modules);
  const prefixMap = buildPrefixMap(modules);

  return async function route(interaction) {
    const byCommand = interaction.isChatInputCommand() || interaction.isAutocomplete();
    const mod = byCommand
      ? commandMap.get(interaction.commandName)
      : typeof interaction.customId === "string"
        ? prefixMap.get(prefixOf(interaction.customId))
        : undefined;

    if (!mod) {
      if (interaction.isAutocomplete()) return safeAutocompleteEmpty(interaction, log);
      if (interaction.isRepliable()) {
        return safeRespond(interaction, { content: EXPIRED_TEXT, flags: MessageFlags.Ephemeral }, log);
      }
      return;
    }

    try {
      await mod.handle(interaction, ctxFor(mod));
    } catch (err) {
      log.error(`[${mod.name}]`, err);
      if (interaction.isAutocomplete()) return safeAutocompleteEmpty(interaction, log);
      await safeRespond(interaction, { content: ERROR_TEXT, flags: MessageFlags.Ephemeral }, log);
    }
  };
}

module.exports = { EXPIRED_TEXT, ERROR_TEXT, buildPrefixMap, buildCommandMap, prefixOf, createRouter };
