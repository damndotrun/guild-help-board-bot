// The help board as a platform module. Its logic lives in help.js; this file
// is only the contract the core loads.
// help keeps data.json with its own loadData()/saveData() (different .bak rules
// than the platform store), so it declares dataFile: null and gets no ctx.store.
const help = require("./help");

module.exports = {
  name: "help",
  // Legacy customId prefixes carried by board/card/panel messages already
  // posted on the live server — they can never be renamed.
  aliases: ["board", "season", "stats", "imsorted", "reset", "resolve", "roles", "catadd"],
  dataFile: null,
  commands: help.commands,
  handle: (interaction) => help.dispatch(interaction),
  bind: help.bind,
  onReady: () => help.onReady(),
};
