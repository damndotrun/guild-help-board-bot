// The teammate finder (M4) as a platform module: the contract the core loads.
// Logic: state.js (pure), actions.js (every write), effects.js (REST after a
// write, the tick), render.js, channel.js, discord.js, menu.js, buttons.js,
// seed.js. No slash command (D24): the entries are the channel panel, the DM
// card and /menu › Teammates.
const buttons = require("./buttons");
const lfgMenu = require("./menu");
const effects = require("./effects");
const channel = require("./channel");
const seed = require("./seed");

// seed (first config) → permission check (the menu's owner line) → the channel.
async function onReady(ctx) {
  await seed.seedIfNeeded(ctx);
  await seed.checkPermissions(ctx);
  await channel.sync(ctx, { checkTail: true });
}

module.exports = {
  name: "lfg",
  dataFile: "lfg.json",
  commands: [],
  components: buttons.components,
  modals: buttons.modals,
  onReady,
  jobs: [{ name: "tick", intervalMs: 30_000, run: (ctx) => effects.tick(ctx) }],
  menu: { section: lfgMenu.section, render: lfgMenu.render, guide: lfgMenu.guide },
};
