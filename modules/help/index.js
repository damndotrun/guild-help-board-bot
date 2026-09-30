// The help board as a platform module. Its logic lives in help.js; this file
// is only the contract the core loads.
// NOTE: help keeps data.json with its own loadData()/saveData() — it must never
// use ctx.store (same file, different shaping rules).
const help = require("./help");

module.exports = {
  name: "help",
  // Legacy customId prefixes carried by board/card/panel messages already
  // posted on the live server — they can never be renamed.
  aliases: ["board", "season", "stats", "imsorted", "reset", "resolve", "roles", "catadd"],
  dataFile: "data.json",
  commands: help.commands,
  handle: (interaction) => help.dispatch(interaction),
  bind: help.bind,
  onReady: () => help.onReady(),
};
