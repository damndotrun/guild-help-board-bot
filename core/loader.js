// Module loading and normalisation. Every module exports a plain object:
//   { name, aliases?, dataFile?, commands?, handle? | onCommand?/components?/
//     modals?/autocomplete?, bind?, onReady?, jobs? }
// The router only ever calls `handle(interaction, ctx)`; modules that prefer
// per-action tables get a `handle` built from them here.

// Known modules. Adding a module = one line here + a MODULES entry to enable it.
const AVAILABLE = {
  help: () => require("../modules/help"),
};

const NAME_RE = /^[a-z][a-z0-9-]*$/;

function buildHandle(mod) {
  const onCommand = mod.onCommand || {};
  const components = mod.components || {};
  const modals = mod.modals || {};
  const autocomplete = mod.autocomplete || {};
  return async function handle(interaction, ctx) {
    if (interaction.isAutocomplete()) {
      const h = autocomplete[interaction.commandName];
      return h ? h(interaction, ctx) : interaction.respond([]);
    }
    if (interaction.isChatInputCommand()) {
      const h = onCommand[interaction.commandName];
      if (!h) throw new Error(`[${mod.name}] no handler for /${interaction.commandName}`);
      return h(interaction, ctx);
    }
    // customId = "<module>:<action>:<param…>" — param is the full remainder.
    const [, action = "", ...rest] = interaction.customId.split(":");
    const table = interaction.isModalSubmit() ? modals : components;
    const h = table[action];
    if (!h) throw new Error(`[${mod.name}] no handler for ${interaction.customId}`);
    return h(interaction, ctx, rest.join(":"));
  };
}

function normalizeModule(mod) {
  if (!mod || typeof mod.name !== "string" || !NAME_RE.test(mod.name)) {
    throw new Error(`Invalid module name: ${mod && mod.name}`);
  }
  return {
    name: mod.name,
    aliases: mod.aliases || [],
    dataFile: mod.dataFile || `${mod.name}.json`,
    commands: (mod.commands || []).map((c) => (typeof c.toJSON === "function" ? c.toJSON() : c)),
    handle: mod.handle || buildHandle(mod),
    bind: mod.bind || null,
    onReady: mod.onReady || null,
    jobs: mod.jobs || [],
  };
}

function loadModules(names, available = AVAILABLE) {
  return names.map((n) => {
    const load = available[n];
    if (!load) {
      throw new Error(`Unknown module "${n}" in MODULES (known: ${Object.keys(available).join(", ")})`);
    }
    return normalizeModule(load());
  });
}

module.exports = { AVAILABLE, buildHandle, normalizeModule, loadModules };
