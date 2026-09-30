// The web admin's session: a signed (NOT encrypted) cookie via cookie-session.
// It holds only { userId, exp } once signed in — plus, briefly, the OAuth
// state of a sign-in in progress and a one-shot notice line. Never a Discord
// token, never a level: the level is re-checked from the bot on every request.
const crypto = require("node:crypto");
const cookieSession = require("cookie-session");

const COOKIE = "bb_session";
const MINUTE = 60_000;
const SESSION_DAYS = 30;
const SESSION_MINUTES = SESSION_DAYS * 24 * 60;
const STATE_TTL_MS = 10 * MINUTE;

// SameSite=Lax, not Strict: the OAuth callback is a top-level navigation
// coming back from discord.com, and a Strict cookie would not be sent with it.
function sessionMiddleware({ secret, secure }) {
  return cookieSession({
    name: COOKIE,
    keys: [secret],
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_MINUTES * MINUTE,
  });
}

const minuteOf = (ms) => Math.floor(ms / MINUTE);

// The signed-in user id, or null. `exp` (in minutes) is the SERVER-side
// expiry: cookie-session's maxAge only tells the browser when to forget the
// cookie — a copied cookie value would otherwise stay valid forever. Rolling:
// every request of a live session moves `exp` 30 days ahead; at minute
// granularity, so the cookie is re-issued at most once a minute.
function currentUserId(req, now) {
  const s = req.session;
  if (!s || typeof s.userId !== "string" || !Number.isInteger(s.exp)) return null;
  const nowMin = minuteOf(now);
  if (s.exp <= nowMin) {
    req.session = null;
    return null;
  }
  const exp = nowMin + SESSION_MINUTES;
  if (s.exp !== exp) s.exp = exp;
  return s.userId;
}

// A fresh session object: whatever the old cookie carried (a stale state or
// notice) is gone.
function signIn(req, userId, now) {
  req.session = { userId, exp: minuteOf(now) + SESSION_MINUTES };
}

function signOut(req) {
  req.session = null;
}

// Start a sign-in attempt: a new random state (10 minutes), remembered with
// the prompt mode it was sent with. Returns the state to put in the URL.
function issueState(req, state, prompt, now) {
  req.session.oauthState = state;
  req.session.oauthStateExp = now + STATE_TTL_MS;
  req.session.oauthPrompt = prompt;
  return state;
}

// One-shot: the prompt mode of the matching, unexpired attempt — or null.
// The stored state is cleared whatever the outcome.
function takeState(req, state, now) {
  const s = req.session || {};
  const expected = typeof s.oauthState === "string" ? s.oauthState : "";
  const exp = s.oauthStateExp;
  const prompt = s.oauthPrompt;
  if (req.session) {
    delete req.session.oauthState;
    delete req.session.oauthStateExp;
    delete req.session.oauthPrompt;
  }
  if (!expected || typeof state !== "string") return null;
  const a = Buffer.from(state);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!Number.isFinite(exp) || now > exp) return null;
  return prompt === "consent" ? "consent" : "none";
}

// The one-line success/error notice shown at the top of the next page.
function setNotice(req, notice) {
  req.session.notice = { ok: notice.ok === true, text: String(notice.text) };
}

function takeNotice(req) {
  const n = req.session && req.session.notice;
  if (!n) return null;
  delete req.session.notice;
  return { ok: n.ok === true, text: String(n.text) };
}

module.exports = {
  COOKIE,
  SESSION_DAYS,
  STATE_TTL_MS,
  sessionMiddleware,
  currentUserId,
  signIn,
  signOut,
  issueState,
  takeState,
  setNotice,
  takeNotice,
};
