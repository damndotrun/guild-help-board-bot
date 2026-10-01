"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("../web/session");
const { TRUST_PROXY, httpError, sameOriginGuard, fixedWindowLimiter, perClientLimiter, field } = require("../web/security");

const ORIGIN = "https://bb.example.com";
const SECRET = "x".repeat(32);
const DAY = 24 * 60 * 60 * 1000;

// A throwaway app wired like web/server.js (trust proxy, session, CSRF guard,
// form parser) with a few probe routes. `clock.t` is the injected "now".
async function probeApp({ secure = true } = {}) {
  const clock = { t: Date.UTC(2026, 8, 30, 12, 0, 0) };
  const app = express();
  app.set("trust proxy", TRUST_PROXY);
  app.use(session.sessionMiddleware({ secret: SECRET, secure }));
  app.use(sameOriginGuard(ORIGIN));
  app.use(express.urlencoded({ extended: false, limit: "10kb", parameterLimit: 50 }));
  app.get("/in", (req, res) => { session.signIn(req, "u1", clock.t); res.send("in"); });
  app.get("/who", (req, res) => res.json({ userId: session.currentUserId(req, clock.t), secure: req.secure }));
  app.post("/echo", (req, res) => res.json({ a: field(req, "a"), b: field(req, "b") }));
  app.use((err, req, res, next) => res.status(err.status || 500).send(err.publicMessage || "error"));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, clock, close: () => new Promise((r) => server.close(r)) };
}

const cookieOf = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

test("sign-in cookie: set over HTTPS-behind-a-loopback-proxy, HttpOnly + SameSite=Lax + Secure", async () => {
  const p = await probeApp();
  try {
    const res = await fetch(`${p.base}/in`, { headers: { "x-forwarded-proto": "https" } });
    const set = res.headers.getSetCookie();
    assert.equal(set.length, 2, "cookie + signature"); // bb_session + bb_session.sig
    for (const c of set) {
      assert.match(c, /; httponly/i);
      assert.match(c, /; samesite=lax/i);
      assert.match(c, /; secure/i);
    }
  } finally {
    await p.close();
  }
});

// The failure the research measured: with 'uniquelocal' alone this is a 200
// with NO Set-Cookie and no error. Plain http never gets the Secure cookie.
test("Secure cookie over plain http: silently not set (why web/server.js refuses to start a sign-in there)", async () => {
  const p = await probeApp();
  try {
    const res = await fetch(`${p.base}/in`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.getSetCookie().length, 0);
  } finally {
    await p.close();
  }
});

test("trust proxy: the loopback proxy's X-Forwarded-Proto is believed (req.secure), plain http is not", async () => {
  const p = await probeApp();
  try {
    const proxied = await fetch(`${p.base}/who`, { headers: { "x-forwarded-proto": "https" } });
    assert.equal((await proxied.json()).secure, true);
    const direct = await fetch(`${p.base}/who`);
    assert.equal((await direct.json()).secure, false);
  } finally {
    await p.close();
  }
});

test("session: rolling 30 days — used within 30 days it stays; idle for 30 days it is gone", async () => {
  const p = await probeApp();
  const H = { "x-forwarded-proto": "https" };
  try {
    let cookie = cookieOf(await fetch(`${p.base}/in`, { headers: H }));
    p.clock.t += 29 * DAY;
    let res = await fetch(`${p.base}/who`, { headers: { ...H, cookie } });
    assert.equal((await res.json()).userId, "u1");
    cookie = cookieOf(res); // exp moved: a new cookie
    assert.ok(cookie.includes("bb_session="));
    p.clock.t += 29 * DAY; // 58 days after sign-in, 29 after last use
    res = await fetch(`${p.base}/who`, { headers: { ...H, cookie } });
    assert.equal((await res.json()).userId, "u1");
    const stale = cookie;
    p.clock.t += 31 * DAY;
    res = await fetch(`${p.base}/who`, { headers: { ...H, cookie: stale } });
    assert.equal((await res.json()).userId, null);
  } finally {
    await p.close();
  }
});

test("session: the cookie is re-issued at most once a minute", async () => {
  const p = await probeApp();
  const H = { "x-forwarded-proto": "https" };
  try {
    const cookie = cookieOf(await fetch(`${p.base}/in`, { headers: H }));
    const same = await fetch(`${p.base}/who`, { headers: { ...H, cookie } });
    assert.equal(same.headers.getSetCookie().length, 0);
    p.clock.t += 60_000;
    const later = await fetch(`${p.base}/who`, { headers: { ...H, cookie } });
    assert.equal(later.headers.getSetCookie().length, 2);
  } finally {
    await p.close();
  }
});

test("session: a forged (unsigned) cookie is no session", async () => {
  const p = await probeApp();
  try {
    const forged = `bb_session=${Buffer.from(JSON.stringify({ userId: "u1", exp: 9e9 })).toString("base64")}`;
    const res = await fetch(`${p.base}/who`, { headers: { "x-forwarded-proto": "https", cookie: forged } });
    assert.equal((await res.json()).userId, null);
  } finally {
    await p.close();
  }
});

test("session: a tampered cookie (valid signature of the OLD value) is no session", async () => {
  const p = await probeApp();
  const H = { "x-forwarded-proto": "https" };
  try {
    const set = (await fetch(`${p.base}/in`, { headers: H })).headers.getSetCookie().map((c) => c.split(";")[0]);
    const sig = set.find((c) => c.startsWith("bb_session.sig="));
    const forgedBody = `bb_session=${Buffer.from(JSON.stringify({ userId: "admin", exp: 9e9 })).toString("base64")}`;
    const res = await fetch(`${p.base}/who`, { headers: { ...H, cookie: `${forgedBody}; ${sig}` } });
    assert.equal((await res.json()).userId, null);
  } finally {
    await p.close();
  }
});

test("session: the cookie carries only { userId, exp } — no tokens, no level", async () => {
  const p = await probeApp();
  try {
    const res = await fetch(`${p.base}/in`, { headers: { "x-forwarded-proto": "https" } });
    const body = res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("bb_session="));
    const data = JSON.parse(Buffer.from(body.slice("bb_session=".length), "base64").toString("utf8"));
    assert.deepEqual(Object.keys(data).sort(), ["exp", "userId"]);
    assert.equal(data.userId, "u1");
    assert.ok(Number.isInteger(data.exp));
  } finally {
    await p.close();
  }
});

test("takeState: matching, unexpired and one-shot; the prompt mode comes back", () => {
  const t = 1_000_000;
  const req = { session: {} };
  session.issueState(req, "abc", "consent", t);
  assert.equal(session.takeState(req, "abc", t + 1000), "consent");
  assert.equal(session.takeState(req, "abc", t + 1000), null, "one-shot");
  session.issueState(req, "abc", "none", t);
  assert.equal(session.takeState(req, "abd", t), null, "mismatch");
  session.issueState(req, "abc", "none", t);
  assert.equal(session.takeState(req, "abc", t + session.STATE_TTL_MS + 1), null, "expired");
  session.issueState(req, "abc", "none", t);
  assert.equal(session.takeState(req, ["abc"], t), null, "array from a repeated query param");
  assert.equal(session.takeState({ session: null }, "abc", t), null, "no session");
  session.issueState(req, "abc", "none", t);
  assert.equal(session.takeState(req, "ábc", t), null, "same length in chars, different in bytes");
});

test("takeState: a mismatching state leaves the stored one in place; a match or an expiry clears it", () => {
  const t = 1_000_000;
  const req = { session: {} };
  session.issueState(req, "abc", "consent", t);
  for (const wrong of ["abd", "x", ["abc"], undefined]) {
    assert.equal(session.takeState(req, wrong, t), null, String(wrong));
    assert.equal(req.session.oauthState, "abc", `kept after ${String(wrong)}`);
  }
  assert.equal(session.takeState(req, "abc", t + 1000), "consent", "the real callback still signs in");
  assert.equal(req.session.oauthState, undefined, "cleared on the match");
  assert.equal(req.session.oauthStateExp, undefined);
  assert.equal(req.session.oauthPrompt, undefined);
  session.issueState(req, "abc", "none", t);
  assert.equal(session.takeState(req, "zzz", t + session.STATE_TTL_MS + 1), null);
  assert.equal(req.session.oauthState, undefined, "an expired state is cleared even on a mismatch");
});

test("notice: one-shot", () => {
  const req = { session: {} };
  session.setNotice(req, { ok: true, text: "Saved." });
  assert.deepEqual(session.takeNotice(req), { ok: true, text: "Saved." });
  assert.equal(session.takeNotice(req), null);
});

const POST_OK = { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };

test("CSRF: a same-origin POST passes; wrong / missing Origin, cross-site Sec-Fetch-Site → 403", async () => {
  const p = await probeApp();
  try {
    assert.equal((await fetch(`${p.base}/echo`, { method: "POST", headers: POST_OK, body: "a=1" })).status, 200);
    const cases = [
      { ...POST_OK, origin: "https://evil.example" },
      { ...POST_OK, origin: "null" },
      { "content-type": POST_OK["content-type"] },
      { ...POST_OK, "sec-fetch-site": "cross-site" },
      { ...POST_OK, "sec-fetch-site": "same-site" },
      { ...POST_OK, "sec-fetch-site": "none" },
    ];
    for (const headers of cases) {
      const res = await fetch(`${p.base}/echo`, { method: "POST", headers, body: "a=1" });
      assert.equal(res.status, 403, JSON.stringify(headers));
    }
    // Origin alone (a browser without Fetch Metadata) is enough.
    const { "sec-fetch-site": _drop, ...originOnly } = POST_OK;
    assert.equal((await fetch(`${p.base}/echo`, { method: "POST", headers: originOnly, body: "a=1" })).status, 200);
  } finally {
    await p.close();
  }
});

test("CSRF: Origin must equal the configured origin exactly (scheme, host, port, no trailing slash)", async () => {
  const p = await probeApp();
  try {
    const { "sec-fetch-site": _drop, ...base } = POST_OK; // Origin is the only signal
    for (const origin of ["http://bb.example.com", "https://bb.example.com:8443", "https://bb.example.com/", "https://BB.example.com", "https://bb.example.com.evil.example", ""]) {
      const res = await fetch(`${p.base}/echo`, { method: "POST", headers: { ...base, origin }, body: "a=1" });
      assert.equal(res.status, 403, JSON.stringify(origin));
    }
  } finally {
    await p.close();
  }
});

test("CSRF: a POST with neither Origin nor Sec-Fetch-Site is refused, and nothing is parsed or routed", async () => {
  const p = await probeApp();
  try {
    const res = await fetch(`${p.base}/echo`, { method: "POST", headers: { "content-type": POST_OK["content-type"] }, body: "a=1" });
    assert.equal(res.status, 403);
    assert.doesNotMatch(await res.text(), /"a"/);
  } finally {
    await p.close();
  }
});

test("CSRF: GET and HEAD pass the guard without Origin", async () => {
  const p = await probeApp();
  try {
    assert.equal((await fetch(`${p.base}/who`)).status, 200);
    assert.equal((await fetch(`${p.base}/who`, { method: "HEAD" })).status, 200);
  } finally {
    await p.close();
  }
});

test("CSRF: PUT/DELETE/PATCH are 405, never routed", async () => {
  const p = await probeApp();
  try {
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`${p.base}/echo`, { method, headers: POST_OK, body: "a=1" });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get("allow"), "GET, HEAD, POST");
    }
  } finally {
    await p.close();
  }
});

test("field(): repeated or missing fields are '' — never an array", async () => {
  const p = await probeApp();
  try {
    const res = await fetch(`${p.base}/echo`, { method: "POST", headers: POST_OK, body: "a=1&a=2&c=3" });
    assert.deepEqual(await res.json(), { a: "", b: "" });
    const ok = await fetch(`${p.base}/echo`, { method: "POST", headers: POST_OK, body: "a=x%20y&b=" });
    assert.deepEqual(await ok.json(), { a: "x y", b: "" });
  } finally {
    await p.close();
  }
});

test("fixedWindowLimiter: max per window, then a fresh window", () => {
  let t = 0;
  const take = fixedWindowLimiter({ max: 2, windowMs: 1000, now: () => t });
  assert.deepEqual([take(), take(), take()], [true, true, false]);
  t = 999;
  assert.equal(take(), false);
  t = 1000;
  assert.equal(take(), true);
});

test("perClientLimiter: max per window per key; another key has its own budget; a fresh window after windowMs", () => {
  let t = 0;
  const take = perClientLimiter({ max: 2, windowMs: 1000, maxClients: 100, now: () => t });
  assert.deepEqual([take("a"), take("a"), take("a")], [true, true, false]);
  assert.deepEqual([take("b"), take("b"), take("b")], [true, true, false]);
  t = 999;
  assert.equal(take("a"), false);
  t = 1000;
  assert.equal(take("a"), true);
});

test("perClientLimiter: expired windows are evicted; when full, the OLDEST entry goes (never 'everyone limited')", () => {
  let t = 0;
  const take = perClientLimiter({ max: 1, windowMs: 1000, maxClients: 3, now: () => t });
  take("a");
  t = 10;
  take("b");
  t = 20;
  take("c");
  assert.equal(take.size(), 3);
  assert.equal(take("a"), false, "a is still in its window");
  t = 30;
  assert.equal(take("d"), true, "full: a new client is admitted, not refused");
  assert.equal(take.size(), 3, "...and the map stays bounded");
  assert.equal(take("a"), true, "the oldest entry (a) was the one evicted");
  t = 2000;
  take("e");
  assert.equal(take.size(), 1, "every expired window is dropped");
});

test("httpError carries a status and a public message", () => {
  const e = httpError(403, "No.");
  assert.equal(e.status, 403);
  assert.equal(e.publicMessage, "No.");
});
