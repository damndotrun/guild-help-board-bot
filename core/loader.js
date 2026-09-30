// Module loading and normalisation. Every module exports a plain object:
//   { name, aliases?, dataFile? (null = no ctx.store), commands?, handle? | onCommand?/components?/
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

const MAX_TIMER_MS = 2 ** 31 - 1; // setInterval overflows (fires every 1 ms) above this

function normalizeJobs(mod) {
  const jobs = mod.jobs === undefined ? [] : mod.jobs;
  if (!Array.isArray(jobs)) throw new Error(`[${mod.name}] jobs must be an array`);
  return jobs.map((job, i) => {
    const label = `[${mod.name}] job ${job && job.name ? job.name : `#${i}`}`;
    if (!job || typeof job !== "object") throw new Error(`${label} must be an object`);
    if (!Number.isFinite(job.intervalMs) || job.intervalMs <= 0 || job.intervalMs > MAX_TIMER_MS) {
      throw new Error(`${label}: intervalMs must be a positive finite number (got ${String(job.intervalMs)})`);
    }
    if (typeof job.run !== "function") throw new Error(`${label}: run must be a function`);
    return { name: job.name || `#${i}`, intervalMs: job.intervalMs, run: job.run };
  });
}

function normalizeModule(mod) {
  if (!mod || typeof mod.name !== "string" || !NAME_RE.test(mod.name)) {
    throw new Error(`Invalid module name: ${mod && mod.name}`);
  }
  return {
    name: mod.name,
    aliases: mod.aliases || [],
    // dataFile: null = the module keeps its own persistence and gets no ctx.store.
    dataFile: mod.dataFile === null ? null : mod.dataFile || `${mod.name}.json`,
    commands: (mod.commands || []).map((c) => (typeof c.toJSON === "function" ? c.toJSON() : c)),
    handle: mod.handle || buildHandle(mod),
    bind: mod.bind || null,
    onReady: mod.onReady || null,
    jobs: normalizeJobs(mod),
  };
}

function loadModules(names, available = AVAILABLE) {
  return names.map((n) => {
    // hasOwn: MODULES=constructor / toString must not resolve to an inherited member.
    if (!Object.hasOwn(available, n)) {
      throw new Error(`Unknown module "${n}" in MODULES (known: ${Object.keys(available).join(", ")})`);
    }
    const mod = normalizeModule(available[n]());
    if (mod.name !== n) {
      throw new Error(`Module "${n}" exports the name "${mod.name}" — MODULES key and module name must match`);
    }
    return mod;
  });
}

module.exports = { AVAILABLE, buildHandle, normalizeModule, loadModules };
