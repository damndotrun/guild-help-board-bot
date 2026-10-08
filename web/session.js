// The web admin's session: a signed (NOT encrypted) cookie via cookie-session.
// It holds only { userId, exp, iat } once signed in — plus, briefly, the OAuth
// state of a sign-in in progress and a one-shot notice line. Never a Discord
// token, never a level: the level is re-checked from the bot on every request.
// Signing out is also recorded server-side (createSignOuts), so a copy of the
// cookie stops working too.
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
// notice) is gone. `iat` (ms) is when it was issued — createSignOuts compares
// it (and createSignOuts.issuedAt picks it; default now).
function signIn(req, userId, now, iat = now) {
  req.session = { userId, exp: minuteOf(now) + SESSION_MINUTES, iat };
}

// Server-side sign-out. The cookie is signed, not stored, so clearing it in
// one browser leaves any copy of it valid for as long as it is used. Signing
// out therefore records the time per user, and every session that user was
// issued until then is no session anymore — in every browser (the safer
// default for an admin login). `store` = a core/store (persisted, so a
// restart forgets nothing) or null (in memory; tests). Entries are never
// pruned: a rolling session can outlive any cut-off, and there is one entry
// per officer who ever signed out.
function createSignOuts(store = null) {
  const loaded = store ? store.load({ signedOutAt: {} }) : null;
  const signedOutAt = Object.create(null);
  const raw = loaded && loaded.signedOutAt && typeof loaded.signedOutAt === "object" ? loaded.signedOutAt : {};
  for (const [id, at] of Object.entries(raw)) if (Number.isFinite(at)) signedOutAt[id] = at;
  return {
    record(userId, at) {
      signedOutAt[userId] = at;
      if (store) store.save({ signedOutAt: { ...signedOutAt } });
    },
    // The `iat` for a new session: now, but always after the user's last
    // sign-out — if the server clock stepped back since, a fresh sign-in
    // would otherwise count as revoked and loop back to /login.
    issuedAt(userId, now) {
      const at = signedOutAt[userId];
      return at === undefined ? now : Math.max(now, at + 1);
    },
    // A session issued at `iat` (ms; missing on cookies from before this
    // check) is revoked when the user signed out at or after it.
    revoked(userId, iat) {
      const at = signedOutAt[userId];
      if (at === undefined) return false;
      return !(Number.isFinite(iat) && iat > at);
    },
  };
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

function clearState(req) {
  delete req.session.oauthState;
  delete req.session.oauthStateExp;
  delete req.session.oauthPrompt;
}

// One-shot: the prompt mode of the matching, unexpired attempt — or null.
// The stored state is cleared when it matched or has expired — NOT on a
// mismatch: a stale callback (an older tab) or a crafted /auth/callback?state=x
// link must not kill the sign-in in progress. Guessing gains nothing: the
// state is 32 random bytes and a mismatch never reaches Discord.
function takeState(req, state, now) {
  if (!req.session) return null;
  const s = req.session;
  const expected = typeof s.oauthState === "string" ? s.oauthState : "";
  const exp = s.oauthStateExp;
  const prompt = s.oauthPrompt;
  if (!Number.isFinite(exp) || now > exp) {
    clearState(req);
    return null;
  }
  if (!expected || typeof state !== "string") return null;
  const a = Buffer.from(state);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  clearState(req);
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
  createSignOuts,
  issueState,
  takeState,
  setNotice,
  takeNotice,
};
