// Discord OAuth2, authorization-code flow, by hand with fetch (platform spec
// §5: Arctic is deprecated, passport-discord archived). Scope `identify` only.
// The access token is used once, for /users/@me, and then dropped: the web
// keeps nothing but the user id. `fetch` is injectable so tests never touch
// the network. Errors carry only the HTTP status — never the client secret,
// the code or a token.
const crypto = require("node:crypto");
const { version } = require("../package.json");

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const API = "https://discord.com/api/v10";
// Discord requires a "DiscordBot (url, version)" User-Agent on API requests.
const USER_AGENT = `DiscordBot (https://github.com/damndotrun/guild-help-board-bot, ${version})`;
const TIMEOUT_MS = 10_000;
const SNOWFLAKE = /^\d{17,20}$/;

class OAuthError extends Error {
  constructor(message, status = null, code = null) {
    super(message);
    this.name = "OAuthError";
    this.status = status;
    this.code = code; // Discord's OAuth error code (invalid_grant, …) or "other"; null when none
  }
}

// The standard OAuth `error` field of a failed token response, for the log
// only: a plain lower-case code or "other". The body itself is never kept,
// quoted or logged — it can echo the authorization code.
async function oauthErrorCode(res) {
  try {
    const body = await res.json();
    const raw = body && body.error;
    return typeof raw === "string" && /^[a-z_]{1,40}$/.test(raw) ? raw : "other";
  } catch {
    return "other";
  }
}

// 32 random bytes, URL-safe — the CSRF `state` of one sign-in attempt.
function newState() {
  return crypto.randomBytes(32).toString("base64url");
}

// prompt "none" skips Discord's consent screen for a user who already
// authorized the app; "consent" always shows it.
function authorizeUrl({ clientId, redirectUri, state, prompt = "none" }) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "identify",
    state,
    prompt,
  });
  return `${AUTHORIZE_URL}?${q}`;
}

async function exchangeCode({ code, clientId, clientSecret, redirectUri, fetch = globalThis.fetch }) {
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new OAuthError(`token exchange failed (HTTP ${res.status})`, res.status, await oauthErrorCode(res));
  const body = await res.json();
  if (!body || typeof body.access_token !== "string" || body.access_token === "") {
    throw new OAuthError("token exchange returned no access_token");
  }
  return body.access_token;
}

async function fetchUserId({ accessToken, fetch = globalThis.fetch }) {
  const res = await fetch(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new OAuthError(`user lookup failed (HTTP ${res.status})`, res.status);
  const body = await res.json();
  if (!body || typeof body.id !== "string" || !SNOWFLAKE.test(body.id)) {
    throw new OAuthError("user lookup returned no valid user id");
  }
  return body.id;
}

module.exports = { AUTHORIZE_URL, API, USER_AGENT, OAuthError, newState, authorizeUrl, exchangeCode, fetchUserId };
