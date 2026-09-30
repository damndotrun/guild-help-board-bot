// Platform configuration shared by the core and the modules.
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");

// Data lives next to the code by default; set DATA_DIR to keep the data files
// on a persistent volume when the code itself is ephemeral (re-cloned on boot).
// Read at require time — index.js loads dotenv before requiring anything here.
const DATA_DIR = process.env.DATA_DIR || REPO_ROOT;

const REQUIRED_ENV = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID"];

// The web admin's public address (M3). Unset → the menu shows no Web admin link.
const PUBLIC_URL = process.env.PUBLIC_URL || null;

// MODULES="help,lfg" → ["help", "lfg"]. Unset/blank → ["help"], so an existing
// deployment without the variable keeps running exactly the help board.
function parseModules(raw) {
  const names = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return ["help"];
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`MODULES lists "${dup}" twice`);
  return names;
}

module.exports = { REPO_ROOT, DATA_DIR, REQUIRED_ENV, PUBLIC_URL, parseModules };
