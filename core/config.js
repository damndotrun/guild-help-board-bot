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

// PUBLIC_URL must be a full http(s) URL: a Discord Link button rejects anything
// else, and a bad value would break the menu for every officer. Unset/blank →
// null (no link). Returns the trimmed value; throws a message naming PUBLIC_URL.
const PUBLIC_URL_MAX = 512;
function parsePublicUrl(raw) {
  const value = String(raw ?? "").trim();
  if (value === "") return null;
  const bad = (why) => new Error(`PUBLIC_URL ${why} — set it to a full https://… address (or leave it unset).`);
  if (value.length > PUBLIC_URL_MAX) throw bad(`is longer than ${PUBLIC_URL_MAX} characters`);
  if (/\s/.test(value)) throw bad("must not contain spaces");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw bad(`"${value}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw bad(`"${value}" must start with http:// or https://`);
  return value;
}

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

module.exports = { REPO_ROOT, DATA_DIR, REQUIRED_ENV, PUBLIC_URL, parsePublicUrl, parseModules };
