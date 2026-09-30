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

// PUBLIC_URL is the web admin's ORIGIN: scheme + host (+ port), nothing else.
// It is the base of the OAuth redirect URI and the target of the officers'
// "Web admin" link button in /menu. Discord's API rejects odd-but-valid URLs
// such as "http:foo" in a Link button (400 → every officer's /menu would fail),
// so only the literal shape http(s)://host[:port][/] is accepted, and the
// returned value is the canonical origin ("https://bot.example.com" — lower-case
// host, no trailing slash). Unset/blank → null. Throws a message naming PUBLIC_URL.
// The message NEVER echoes the value: it may carry credentials (https://user:pw@host).
const PUBLIC_URL_MAX = 512;
const ORIGIN_SHAPE = /^https?:\/\/[^/?#@\s]+\/?$/i;
function parsePublicUrl(raw) {
  const value = String(raw ?? "").trim();
  if (value === "") return null;
  const bad = (why) =>
    new Error(`PUBLIC_URL ${why} — set it to the web admin's address, like https://admin.example.com (or leave it unset).`);
  if (value.length > PUBLIC_URL_MAX) throw bad(`is longer than ${PUBLIC_URL_MAX} characters`);
  if (/\s/.test(value)) throw bad("must not contain spaces");
  if (!ORIGIN_SHAPE.test(value)) {
    throw bad("must be just http:// or https:// and a host (no path, query, #fragment or user name)");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw bad("is not a valid URL");
  }
  return url.origin;
}

// The web admin (M3) runs only when it is configured. Any of these set turns
// it on — and then all of them (plus PUBLIC_URL) are required. None set → the
// web admin is off and the bot runs exactly as before M3.
const WEB_ENV = ["WEB_PORT", "DISCORD_CLIENT_SECRET", "SESSION_SECRET"];
const SESSION_SECRET_MIN = 32;

// → null (web admin off) | { origin, redirectUri, secure, port, clientId,
// clientSecret, sessionSecret }. `publicUrl` is parsePublicUrl's result.
// Throws a message naming the variable; never echoes a secret (or any env value).
function parseWebConfig(env, publicUrl) {
  const has = (k) => String(env[k] ?? "").trim() !== "";
  const set = WEB_ENV.filter(has);
  if (set.length === 0) return null;
  const missing = [...(publicUrl ? [] : ["PUBLIC_URL"]), ...WEB_ENV.filter((k) => !has(k))];
  if (missing.length > 0) {
    throw new Error(
      `The web admin is on because ${set.join(", ")} ${set.length === 1 ? "is" : "are"} set, ` +
        `but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing — set them (see README "Web admin") or unset ${set.join(", ")}.`
    );
  }
  const portRaw = String(env.WEB_PORT).trim();
  const port = /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new Error("WEB_PORT must be a port number from 1 to 65535.");
  const sessionSecret = String(env.SESSION_SECRET).trim();
  if (sessionSecret.length < SESSION_SECRET_MIN) {
    throw new Error(
      `SESSION_SECRET must be at least ${SESSION_SECRET_MIN} characters. Generate one with: ` +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return {
    origin: publicUrl,
    redirectUri: `${publicUrl}/auth/callback`,
    secure: publicUrl.startsWith("https:"),
    port,
    clientId: String(env.CLIENT_ID ?? "").trim(),
    clientSecret: String(env.DISCORD_CLIENT_SECRET).trim(),
    sessionSecret,
  };
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

module.exports = { REPO_ROOT, DATA_DIR, REQUIRED_ENV, PUBLIC_URL, WEB_ENV, parsePublicUrl, parseWebConfig, parseModules };
