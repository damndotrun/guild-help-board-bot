"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bbweb-"));
process.env.DATA_DIR = TMP;

const { test } = require("node:test");
const assert = require("node:assert/strict");
const ejs = require("ejs");
const { startWeb, fakeGuild, ORIGIN, WEB } = require("./fixtures/web-harness");
const { HTMX } = require("../web/vendor");
const { RENDER_OPTIONS } = require("../web/render");
const { CALLBACKS_PER_MINUTE, CLIENT_CALLBACKS_PER_MINUTE } = require("../web/server");

const OFFICER = "100000000000000001";
const OWNER = "100000000000000002";
const MEMBER = "100000000000000003";
const STRANGER = "100000000000000004";
const MGR = "200000000000000001";

// help is not loaded here, so the manager-role list is empty: officer = Manage
// Server only. OFFICER therefore is an owner-level user in this file.
const guild = () =>
  fakeGuild({
    users: {
      [OFFICER]: { name: "Offi", owner: true },
      [OWNER]: { name: "Boss <b>", owner: true },
      [MEMBER]: { name: "Kovi" },
    },
    roles: [{ id: MGR, name: "Officers" }],
  });

async function withWeb(opts, fn) {
  const w = await startWeb({ guild: guild(), ...opts });
  try {
    await fn(w);
  } finally {
    await w.close();
  }
}

test("sign-in: /auth/login → Discord authorize URL with state + prompt=none; the callback sets the session cookie", async () => {
  await withWeb({}, async (w) => {
    const start = await w.request("/auth/login");
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get("location"));
    assert.equal(to.origin + to.pathname, "https://discord.com/oauth2/authorize");
    assert.equal(to.searchParams.get("prompt"), "none");
    assert.equal(to.searchParams.get("redirect_uri"), `${ORIGIN}/auth/callback`);
    w.discord.who.userId = OWNER;
    const cb = await w.request(`/auth/callback?code=abc&state=${encodeURIComponent(to.searchParams.get("state"))}`);
    assert.equal(cb.status, 303);
    assert.equal(cb.headers.get("location"), "/");
    // The failure mode is silent (200/303 without a cookie) — so assert the cookie itself.
    const set = cb.headers.getSetCookie().join("\n");
    assert.match(set, /bb_session=/);
    assert.match(set, /secure/i);
    assert.match(set, /httponly/i);
    assert.match(set, /samesite=lax/i);
    const token = w.discord.calls.find((c) => c.url.endsWith("/oauth2/token"));
    assert.equal(new URLSearchParams(token.init.body).get("redirect_uri"), `${ORIGIN}/auth/callback`);
  });
});

test("sign-in over plain http is refused with a page naming X-Forwarded-Proto (never a silent cookie-less loop)", async () => {
  await withWeb({}, async (w) => {
    const res = await w.request("/auth/login", { headers: { "x-forwarded-proto": "http" } });
    assert.equal(res.status, 500);
    assert.match(await res.text(), /X-Forwarded-Proto: https/);
    assert.ok(w.log.lines.some((l) => /not HTTPS/.test(l)));
  });
});

test("callback: wrong, missing, reused or expired state → 400, no Discord call, no session", async () => {
  let t = Date.now();
  await withWeb({ now: () => t }, async (w) => {
    w.discord.who.userId = OWNER;
    const start = await w.request("/auth/login");
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    assert.equal((await w.request(`/auth/callback?code=x&state=nope`)).status, 400);
    t += 10 * 60 * 1000 + 1;
    assert.equal((await w.request(`/auth/callback?code=x&state=${state}`)).status, 400, "expired");
    assert.equal((await w.request(`/auth/callback?code=x&state=${state}`)).status, 400, "an expired state was cleared — reuse fails too");
    assert.equal((await w.request(`/auth/callback?code=x`)).status, 400);
    assert.equal(w.discord.calls.length, 0);
    assert.equal((await w.request("/")).headers.get("location"), "/login");
  });
});

// F-M2: a stale or crafted callback (an older tab's state, a /auth/callback?state=x
// link) must not wipe the sign-in in progress — only a match or an expiry clears it.
test("callback: a mismatching state (older tab, crafted link) does not kill the fresh sign-in; a used state is one-shot", async () => {
  await withWeb({}, async (w) => {
    w.discord.who.userId = OWNER;
    const stateOf = async () => new URL((await w.request("/auth/login")).headers.get("location")).searchParams.get("state");
    const tabA = await stateOf();
    const tabB = await stateOf(); // the same cookie: B's state replaces A's
    assert.equal((await w.request(`/auth/callback?code=x&state=${tabA}`)).status, 400, "tab A is stale");
    assert.equal((await w.request(`/auth/callback?code=x&state=x`)).status, 400, "crafted link");
    assert.equal(w.discord.calls.length, 0, "no Discord call on a mismatch");
    const ok = await w.request(`/auth/callback?code=x&state=${tabB}`);
    assert.equal(ok.status, 303, "tab B still signs in");
    assert.match(ok.headers.getSetCookie().join("\n"), /bb_session=/);
    assert.equal((await w.request(`/auth/callback?code=x&state=${tabB}`)).status, 400, "one-shot");
  });
});

test("callback: an error with prompt=none retries once with the consent screen; with consent it is 'cancelled'", async () => {
  await withWeb({}, async (w) => {
    let state = new URL((await w.request("/auth/login")).headers.get("location")).searchParams.get("state");
    const retry = await w.request(`/auth/callback?error=consent_required&state=${state}`);
    assert.equal(retry.status, 302);
    assert.equal(retry.headers.get("location"), "/auth/login?prompt=consent");
    const consent = await w.request("/auth/login?prompt=consent");
    const to = new URL(consent.headers.get("location"));
    assert.equal(to.searchParams.get("prompt"), "consent");
    state = to.searchParams.get("state");
    const cancelled = await w.request(`/auth/callback?error=access_denied&state=${state}`);
    assert.equal(cancelled.status, 401);
    assert.match(await cancelled.text(), /Sign-in was cancelled/);
  });
});

test("callback: Discord's error code is logged at warn level, sanitized (anything odd → 'other'); the retry is unchanged", async () => {
  await withWeb({}, async (w) => {
    const stateOf = async (q = "") => new URL((await w.request(`/auth/login${q}`)).headers.get("location")).searchParams.get("state");
    let res = await w.request(`/auth/callback?error=consent_required&state=${await stateOf()}`);
    assert.equal(res.headers.get("location"), "/auth/login?prompt=consent");
    assert.ok(w.log.warns.some((l) => /error code: consent_required/.test(l)), w.log.warns.join("\n"));
    res = await w.request(`/auth/callback?error=${encodeURIComponent("<b>EVIL\nINJECTED")}&state=${await stateOf("?prompt=consent")}`);
    assert.equal(res.status, 401);
    assert.ok(w.log.warns.some((l) => /error code: other/.test(l)));
    assert.ok(!w.log.lines.some((l) => /EVIL|INJECTED|<b>/.test(l)), "the raw value is never logged");
    res = await w.request(`/auth/callback?error=a&error=b&state=${await stateOf("?prompt=consent")}`);
    assert.equal(res.status, 401);
    assert.equal(w.log.warns.filter((l) => /error code: other/.test(l)).length, 2, "a repeated param → other");
  });
});

// A failed sign-in must never answer 5xx: Cloudflare swaps an origin 502 for its
// own "Bad gateway" page, so the person would never see our text. It is a red
// notice on the sign-in page (303 /login), no session.

test("callback: Discord refusing the token exchange (400 invalid_grant) → 303 /login with a red notice; the OAuth error code is logged, the code never", async () => {
  await withWeb({}, async (w) => {
    const CODE = "fake-auth-code-DO-NOT-LOG";
    w.discord.handler = (url) => {
      if (url.endsWith("/oauth2/token")) return { ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: `bad ${CODE}` }) };
      throw new Error(`unexpected fetch ${url}`);
    };
    const state = new URL((await w.request("/auth/login")).headers.get("location")).searchParams.get("state");
    const res = await w.request(`/auth/callback?code=${CODE}&state=${state}`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/login");
    const login = await w.page("/login");
    assert.equal(login.res.status, 200);
    assert.match(login.text, /notice-error[^>]*>✕ Discord sign-in didn&#39;t complete\. Try again\./);
    assert.match(login.text, /Sign in with Discord/);
    assert.ok(w.log.errors.some((l) => /Discord sign-in failed: OAuthError 400 invalid_grant/.test(l)), w.log.errors.join("\n"));
    assert.ok(!w.log.lines.some((l) => l.includes("DO-NOT-LOG") || l.includes("error_description")), "neither the code nor the raw body is logged");
    assert.equal((await w.request("/")).headers.get("location"), "/login", "no session");
  });
});

test("callback: a token-exchange error body that is not JSON (or has an odd error value) logs 'other', still 303 /login", async () => {
  const bodies = [
    async () => { throw new SyntaxError("Unexpected token '<' SECRET-BODY"); },
    async () => ({ error: "<b>EVIL\nINJECTED" }),
    async () => ({ error: ["invalid_grant"] }),
    async () => null,
  ];
  for (const json of bodies) {
    await withWeb({}, async (w) => {
      w.discord.handler = () => ({ ok: false, status: 400, json });
      const state = new URL((await w.request("/auth/login")).headers.get("location")).searchParams.get("state");
      const res = await w.request(`/auth/callback?code=x&state=${state}`);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), "/login");
      assert.ok(w.log.errors.some((l) => /Discord sign-in failed: OAuthError 400 other$/.test(l)), w.log.errors.join("\n"));
      assert.ok(!w.log.lines.some((l) => /SECRET|EVIL|INJECTED|<b>/.test(l)), "the raw body is never logged");
    });
  }
});

test("callback: a real timeout (DOMException TimeoutError, legacy .code 23) logs the error name only, not the numeric DOM code", async () => {
  await withWeb({}, async (w) => {
    w.discord.handler = () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
    const state = new URL((await w.request("/auth/login")).headers.get("location")).searchParams.get("state");
    const res = await w.request(`/auth/callback?code=x&state=${state}`);
    assert.equal(res.status, 303);
    const line = w.log.errors.find((l) => /Discord sign-in failed/.test(l));
    assert.ok(line, w.log.errors.join("\n"));
    assert.match(line, /Discord sign-in failed: TimeoutError$/);
    assert.ok(!/23/.test(line), line);
  });
});

test("callback: a failing user lookup (/users/@me) takes the same 303 /login path, no session", async () => {
  await withWeb({}, async (w) => {
    w.discord.who.userId = "not-a-snowflake"; // /users/@me answers an invalid id
    const state = new URL((await w.request("/auth/login")).headers.get("location")).searchParams.get("state");
    const res = await w.request(`/auth/callback?code=x&state=${state}`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/login");
    assert.ok(w.log.errors.some((l) => /Discord sign-in failed/.test(l)));
    assert.match((await w.page("/login")).text, /Discord sign-in didn&#39;t complete\. Try again\./);
    assert.equal((await w.request("/")).headers.get("location"), "/login");
  });
  await withWeb({}, async (w) => {
    w.discord.handler = (url) => {
      if (url.endsWith("/oauth2/token")) return { ok: true, status: 200, json: async () => ({ access_token: "tok" }) };
      return { ok: false, status: 401, json: async () => ({ message: "401: Unauthorized" }) };
    };
    const state = new URL((await w.request("/auth/login")).headers.get("location")).searchParams.get("state");
    const res = await w.request(`/auth/callback?code=x&state=${state}`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/login");
    assert.ok(w.log.errors.some((l) => /Discord sign-in failed: OAuthError 401$/.test(l)), w.log.errors.join("\n"));
  });
});

// Ruling: ANY failure of the exchange is a failed sign-in with a generic page;
// neither the log nor the page ever carries err.message (a SyntaxError quotes
// the response body, a network error the host).
test("callback: ANY error (bad JSON body, network failure, timeout) → 303 /login with the generic notice; err.message is never logged or rendered", async () => {
  const cases = [
    ["SyntaxError", () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token 'SECRET-BODY' in JSON"); } })],
    ["TypeError", () => { throw Object.assign(new TypeError("fetch failed to SECRET-HOST"), { cause: new Error("ECONNREFUSED SECRET-HOST") }); }],
    ["TimeoutError", () => { throw Object.assign(new Error("The operation was aborted due to timeout SECRET-HOST"), { name: "TimeoutError" }); }],
  ];
  for (const [name, handler] of cases) {
    await withWeb({}, async (w) => {
      w.discord.handler = handler;
      const state = new URL((await w.request("/auth/login")).headers.get("location")).searchParams.get("state");
      const res = await w.request(`/auth/callback?code=x&state=${state}`);
      assert.equal(res.status, 303, name);
      assert.equal(res.headers.get("location"), "/login", name);
      const text = (await w.page("/login")).text;
      assert.match(text, /Discord sign-in didn&#39;t complete\. Try again\./, name);
      assert.doesNotMatch(text, /SECRET/, `${name}: page`);
      const logged = w.log.lines.join("\n");
      assert.match(logged, /Discord sign-in failed/, name);
      assert.ok(logged.includes(name), `${name}: the error name is logged`);
      assert.doesNotMatch(logged, /SECRET/, `${name}: log`);
      assert.equal((await w.request("/")).headers.get("location"), "/login", `${name}: no session`);
    });
  }
});

test(`callback: more than ${CALLBACKS_PER_MINUTE} token exchanges a minute (from many clients) → 429 (logged as a warning), Discord not called`, async () => {
  let t = Date.now();
  await withWeb({ now: () => t }, async (w) => {
    w.discord.who.userId = OWNER;
    // a different client each time: the per-client limit never bites here
    for (let i = 0; i < CALLBACKS_PER_MINUTE; i += 1) await w.signIn(OWNER, { ip: `198.51.100.${i + 1}` });
    const calls = w.discord.calls.length;
    const before = w.log.lines.length;
    const ip = "198.51.100.200";
    const state = new URL((await w.request("/auth/login", { ip })).headers.get("location")).searchParams.get("state");
    const res = await w.request(`/auth/callback?code=x&state=${state}`, { ip });
    assert.equal(res.status, 429);
    assert.equal(w.discord.calls.length, calls);
    assert.ok(w.log.lines.length > before);
    assert.ok(w.log.warns.some((l) => /rate limit/i.test(l)), "the limiter hit is logged at warn level");
    assert.ok(!w.log.errors.some((l) => /rate limit/i.test(l)), "...and not as an error");
    t += 60_000;
    await w.signIn(OWNER, { ip });
  });
});

test(`callback: one client over ${CLIENT_CALLBACKS_PER_MINUTE} token exchanges a minute gets its own 429; another client still signs in`, async () => {
  let t = Date.now();
  await withWeb({ now: () => t }, async (w) => {
    const A = "203.0.113.1";
    const B = "203.0.113.2";
    for (let i = 0; i < CLIENT_CALLBACKS_PER_MINUTE; i += 1) await w.signIn(OWNER, { ip: A });
    const calls = w.discord.calls.length;
    const state = new URL((await w.request("/auth/login", { ip: A })).headers.get("location")).searchParams.get("state");
    const res = await w.request(`/auth/callback?code=x&state=${state}`, { ip: A });
    assert.equal(res.status, 429);
    assert.match(await res.text(), /Too many sign-ins/);
    assert.equal(w.discord.calls.length, calls, "no token exchange for the limited client");
    assert.ok(w.log.warns.some((l) => /per-client rate limit/i.test(l)), "the per-client hit is logged at warn level");
    assert.ok(!w.log.lines.some((l) => l.includes(A)), "the client address is not logged");
    const ok = await w.signIn(OWNER, { ip: B });
    assert.equal(ok.status, 303);
    t += 60_000;
    assert.equal((await w.signIn(OWNER, { ip: A })).status, 303, "a fresh window for A");
  });
});

// F-I1: 30 junk callbacks from ONE anonymous client used to drain the
// process-wide budget, locking every real sign-in out for the minute.
test("callback: one anonymous client looping login → callback(junk code) cannot lock out a real sign-in", async () => {
  await withWeb({}, async (w) => {
    const EVIL = "203.0.113.66";
    w.discord.handler = (url) => {
      if (url.endsWith("/oauth2/token")) return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) };
      throw new Error(`unexpected fetch ${url}`);
    };
    const statuses = [];
    for (let i = 0; i < CALLBACKS_PER_MINUTE; i += 1) {
      w.jar.clear(); // cookie-less: a new session each round
      const state = new URL((await w.request("/auth/login", { ip: EVIL })).headers.get("location")).searchParams.get("state");
      statuses.push((await w.request(`/auth/callback?code=junk&state=${state}`, { ip: EVIL })).status);
    }
    assert.equal(statuses.filter((s) => s === 303).length, CLIENT_CALLBACKS_PER_MINUTE);
    assert.ok(!statuses.some((s) => s >= 500), "a failed sign-in is never a 5xx");
    assert.equal(statuses.filter((s) => s === 429).length, CALLBACKS_PER_MINUTE - CLIENT_CALLBACKS_PER_MINUTE);
    w.discord.handler = null;
    w.jar.clear();
    assert.equal((await w.signIn(OWNER, { ip: "198.51.100.7" })).status, 303, "a real officer still gets in");
  });
});

test("signed out: every page redirects to /login; /login shows the Discord button", async () => {
  await withWeb({}, async (w) => {
    for (const p of ["/", "/teammates", "/nope"]) {
      const res = await w.request(p);
      assert.equal(res.status, 303, p);
      assert.equal(res.headers.get("location"), "/login");
    }
    const login = await w.page("/login");
    assert.equal(login.res.status, 200);
    assert.match(login.text, /Sign in with Discord/);
    assert.match(login.text, /href="\/auth\/login"/);
  });
});

test("a member without an officer role, or someone not in the server, gets the 403 page (with Sign out)", async () => {
  for (const who of [MEMBER, STRANGER]) {
    await withWeb({}, async (w) => {
      await w.signIn(who);
      const { res, text } = await w.page("/");
      assert.equal(res.status, 403, who);
      assert.match(text, /This page is for officers and owners\./);
      assert.match(text, /action="\/auth\/logout"/);
      assert.doesNotMatch(text, /class="sidebar"/);
    });
  }
});

test("an owner: / → the first page (Teammates, Coming soon while no module has pages); header shows server, level badge, name (escaped)", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    const { res, text } = await w.page("/");
    assert.equal(res.status, 200);
    assert.match(text, /Coming soon/);
    assert.match(text, /BB Test/);
    assert.match(text, /<span class="badge">Owner<\/span>/);
    assert.match(text, /Boss &lt;b&gt;/);
    assert.doesNotMatch(text, /Boss <b>/);
    assert.match(text, /aria-current="page">Coming soon/);
  });
});

test("the bot not connected yet → 503 page; a failing member lookup → 503 page (not cached)", async () => {
  await withWeb({ ready: false }, async (w) => {
    await w.signIn(OWNER);
    const { res, text } = await w.page("/teammates");
    assert.equal(res.status, 503);
    assert.match(text, /connected to Discord yet/);
  });
  const g = guild();
  const realFetch = g.members.fetch;
  let fail = true;
  g.members.fetch = async (arg) => {
    if (fail) throw Object.assign(new Error("gateway timeout"), { code: "ETIMEDOUT" });
    return realFetch(arg);
  };
  await withWeb({ guild: g }, async (w) => {
    await w.signIn(OWNER);
    assert.equal((await w.page("/teammates")).res.status, 503);
    fail = false;
    assert.equal((await w.page("/teammates")).res.status, 200);
  });
});

// Ruling: discord.js REST can retry/sleep for a minute or more; the lookup has an
// overall deadline, and the deadline itself never writes the level cache.
test("the member lookup has an overall deadline → 503 page; the timeout is not cached", async () => {
  const g = guild();
  const realFetch = g.members.fetch;
  let hang = true;
  g.members.fetch = (arg) => (hang ? new Promise(() => {}) : realFetch(arg));
  await withWeb({ guild: g, lookupTimeoutMs: 50 }, async (w) => {
    await w.signIn(OWNER);
    const started = Date.now();
    const slow = await w.page("/teammates");
    assert.equal(slow.res.status, 503);
    assert.match(slow.text, /check your role on Discord/);
    assert.ok(Date.now() - started < 5000, "answered at the deadline, not after the hung lookup");
    assert.ok(w.log.lines.some((l) => /timed out/.test(l)));
    hang = false;
    assert.equal((await w.page("/teammates")).res.status, 200, "the next request looks again");
  });
});

test("the member lookup is forced and cached for 60 s", async () => {
  let t = Date.now();
  await withWeb({ now: () => t }, async (w) => {
    await w.signIn(OWNER);
    await w.page("/teammates");
    await w.page("/teammates");
    const forced = w.guild.fetchCalls.filter((c) => typeof c === "object" && c.user === OWNER);
    assert.equal(forced.length, 1);
    assert.equal(forced[0].force, true);
    t += 60_000;
    await w.page("/teammates");
    assert.equal(w.guild.fetchCalls.filter((c) => typeof c === "object").length, 2);
  });
});

test("sign out: POST only, clears the session", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    assert.equal((await w.request("/auth/logout")).status, 404, "a GET (a link, an <img>) never signs out");
    assert.equal((await w.page("/teammates")).res.status, 200);
    const out = await w.post("/auth/logout");
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), "/login");
    assert.equal((await w.request("/teammates")).headers.get("location"), "/login");
  });
});

test("sign out ends the session server-side: a copy of the cookie (another browser, a stolen copy) stops working too", async () => {
  let t = Date.now();
  await withWeb({ now: () => t }, async (w) => {
    await w.signIn(OWNER);
    const copy = new Map(w.jar); // the same cookie in a second browser
    t += 1000;
    await w.post("/auth/logout");
    const other = await w.request("/teammates", { cookies: false, headers: { cookie: [...copy].map(([k, v]) => `${k}=${v}`).join("; ") } });
    assert.equal(other.status, 303);
    assert.equal(other.headers.get("location"), "/login");
    t += 1000;
    await w.signIn(OWNER); // signing in again afterwards works
    assert.equal((await w.page("/teammates")).res.status, 200);
  });
});

test("sign-outs survive a restart (kept in web-sessions.json via the store)", async () => {
  const { createStore } = require("../core/store");
  const file = path.join(TMP, "web-sessions.json");
  let t = Date.now();
  let copy;
  await withWeb({ now: () => t, signOutStore: createStore(file) }, async (w) => {
    await w.signIn(OWNER);
    copy = [...w.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    t += 1000;
    await w.post("/auth/logout");
  });
  assert.equal(typeof JSON.parse(fs.readFileSync(file, "utf8")).signedOutAt[OWNER], "number");
  await withWeb({ now: () => t, signOutStore: createStore(file) }, async (w) => {
    const res = await w.request("/teammates", { cookies: false, headers: { cookie: copy } });
    assert.equal(res.headers.get("location"), "/login");
  });
});

test("sign out from another site is refused (CSRF): Origin mismatch → 403, still signed in", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    const res = await w.post("/auth/logout", {}, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    assert.equal(res.status, 403);
    assert.equal((await w.page("/teammates")).res.status, 200);
  });
});

// Ruling: the layout's signed-in state (the Sign out button) follows the
// exp-checked session, not the raw cookie contents.
test("an expired session never shows Sign out on an error page (signed-in state is exp-checked)", async () => {
  let t = Date.now();
  await withWeb({ now: () => t }, async (w) => {
    await w.signIn(OWNER);
    // Any page rendered without the officer gate works; the plain-http sign-in refusal is one.
    const live = await w.request("/auth/login", { headers: { "x-forwarded-proto": "http" } });
    assert.match(await live.text(), /action="\/auth\/logout"/, "a live session shows it");
    t += 31 * 24 * 60 * 60 * 1000;
    const expired = await w.request("/auth/login", { headers: { "x-forwarded-proto": "http" } });
    assert.equal(expired.status, 500);
    assert.doesNotMatch(await expired.text(), /action="\/auth\/logout"/, "an expired session does not");
  });
});

// C5: nothing signed-in is cacheable — a shared cache or the back button must
// not replay an admin page.
test("every authenticated response carries Cache-Control: no-store (pages, redirects, error pages, sign-out)", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    for (const p of ["/", "/teammates", "/nope"]) {
      const res = await w.request(p);
      assert.equal(res.headers.get("cache-control"), "no-store", p);
    }
    const big = await w.post("/teammates", { x: "y".repeat(20_000) });
    assert.equal(big.headers.get("cache-control"), "no-store", "413 page");
    const out = await w.post("/auth/logout");
    assert.equal(out.headers.get("cache-control"), "no-store", "sign-out");
  });
  await withWeb({}, async (w) => {
    await w.signIn(MEMBER);
    assert.equal((await w.request("/")).headers.get("cache-control"), "no-store", "403 page");
  });
});

test("security headers: CSP self-only scripts/styles, no framing, form-action self; no X-Powered-By", async () => {
  await withWeb({}, async (w) => {
    const res = await w.request("/login");
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /style-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    // "same-origin", never "no-referrer": a no-referrer page sends `Origin: null`
    // on a plain (non-CORS) form POST, which sameOriginGuard refuses — Sign out
    // and every no-JS form would break in real browsers. same-origin still
    // sends nothing to Discord or other outside sites.
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
  });
});

// What a browser sends for a plain <form method=post> under the page's referrer
// policy: the page's real origin + Sec-Fetch-Site: same-origin. (The harness's
// post() hard-codes both, so this spells them out on purpose.)
test("a plain form POST as the browser sends it under the page's referrer policy is accepted (Sign out works)", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    const policy = (await w.request("/teammates")).headers.get("referrer-policy");
    assert.equal(policy, "same-origin");
    // Origin is sent for a same-origin POST under same-origin (only `no-referrer` turns it into "null").
    const out = await w.request("/auth/logout", {
      method: "POST",
      form: {},
      headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
    });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), "/login");
  });
});

test("the CSRF guard refuses `Origin: null` (what a no-referrer page would send) — so the referrer policy must stay same-origin", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    const res = await w.request("/auth/logout", {
      method: "POST",
      form: {},
      headers: { origin: "null", "sec-fetch-site": "same-origin" },
    });
    assert.equal(res.status, 403);
    assert.equal((await w.page("/teammates")).res.status, 200, "still signed in");
  });
});

test("htmx: the vendored file is byte-exact 2.0.11, served from /static, loaded with SRI and the hardened config", async () => {
  const file = fs.readFileSync(path.join(__dirname, "..", "web", "public", HTMX.file));
  assert.equal(crypto.createHash("sha256").update(file).digest("hex"), HTMX.sha256);
  assert.equal(`sha384-${crypto.createHash("sha384").update(file).digest("base64")}`, HTMX.integrity);
  await withWeb({}, async (w) => {
    const js = await w.request(`/static/${HTMX.file}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /javascript/);
    const { text } = await w.page("/login");
    assert.ok(text.includes(`src="/static/${HTMX.file}" integrity="${HTMX.integrity}"`));
    const cfg = JSON.parse(text.match(/name="htmx-config" content="([^"]*)"/)[1].replace(/&#34;/g, '"'));
    assert.equal(cfg.selfRequestsOnly, true);
    assert.equal(cfg.allowScriptTags, false);
    assert.equal(cfg.allowEval, false);
    assert.equal(cfg.historyCacheSize, 0);
    assert.equal(cfg.includeIndicatorStyles, false);
    assert.equal((await w.request("/static/nope.js")).status, 404);
  });
});

// CSP forbids inline script/style: no template may carry one. Scans every
// view the web renders (core + modules).
function templateFiles() {
  const roots = [path.join(__dirname, "..", "web", "views"), path.join(__dirname, "..", "modules")];
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ejs")) files.push(p);
    }
  };
  roots.forEach(walk);
  return files;
}

// O-M4: hx-push-url="false" on <main> also stopped boosted GET links from
// updating the address bar. Only the POST forms keep it off (a confirmation
// page's URL is the POST action — refreshing it would 404).
test("htmx history: boosted links push the URL; every POST form inside the content opts out", () => {
  const layout = fs.readFileSync(path.join(__dirname, "..", "web", "views", "layout.ejs"), "utf8");
  const main = layout.match(/<main\b[^>]*>/)[0];
  assert.match(main, /hx-boost="true"/);
  assert.doesNotMatch(main, /hx-push-url/, "no push-url override on <main>");
  let forms = 0;
  for (const f of templateFiles().filter((p) => path.basename(p) !== "layout.ejs")) {
    for (const tag of fs.readFileSync(f, "utf8").match(/<form\b[^>]*>/g) || []) {
      if (!/method="post"/i.test(tag)) continue;
      forms += 1;
      assert.match(tag, /hx-push-url="false"/, `${path.basename(f)}: ${tag}`);
    }
  }
  assert.ok(forms >= 10, `found ${forms} POST forms`);
});

test("templates: no inline <script>, style= attribute, on*= handler or hx-on anywhere", () => {
  const files = templateFiles();
  assert.ok(files.length >= 5);
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /<script(?![^>]*\bsrc=)[^>]*>/i, `${f}: inline <script>`);
    assert.doesNotMatch(src, /\sstyle\s*=/i, `${f}: style attribute`);
    assert.doesNotMatch(src, /\son[a-z]+\s*=/i, `${f}: inline event handler`);
    assert.doesNotMatch(src, /hx-on/i, `${f}: hx-on`);
    assert.doesNotMatch(src, /<style/i, `${f}: <style>`);
  }
});

// The rule web/render.js relies on: with an explicit options argument EJS
// takes NO options from the data object (without it, `delimiter` here would
// switch the template syntax off — the option-injection class of bugs).
test("EJS: explicit render options ⇒ option-like keys in the data are ignored", async () => {
  const file = path.join(TMP, "probe.ejs");
  fs.writeFileSync(file, "<%= page.x %>");
  const out = await ejs.renderFile(file, { page: { x: "<a>" }, delimiter: "?", client: true, escapeFunction: "x" }, { ...RENDER_OPTIONS });
  assert.equal(out, "&lt;a&gt;");
});

test("startWeb: a busy port rejects (index.js stops before bot.lock) instead of failing later", async () => {
  const net = require("node:net");
  const { startWeb: startServer } = require("../web/server");
  const { createPerms } = require("../core/perms");
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, r));
  const port = blocker.address().port;
  try {
    await assert.rejects(
      startServer({ web: { ...WEB, port }, modules: [], ctxFor: () => ({}), perms: createPerms(), getGuild: async () => null }),
      (e) => e.code === "EADDRINUSE"
    );
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test("startWeb: after listening, a server error is logged (code only), not swallowed once and fatal the second time", async () => {
  const { startWeb: startServer } = require("../web/server");
  const { createPerms } = require("../core/perms");
  const lines = [];
  const log = { log() {}, warn() {}, error: (...a) => lines.push(a.map(String).join(" ")) };
  const server = await startServer({ web: { ...WEB, port: 0 }, modules: [], ctxFor: () => ({}), perms: createPerms(), getGuild: async () => null, log });
  try {
    assert.equal(server.listenerCount("error"), 1, "the startup reject listener is gone, a permanent one is in");
    server.emit("error", Object.assign(new Error("SECRET-DETAIL"), { code: "EIO" }));
    server.emit("error", Object.assign(new Error("SECRET-DETAIL"), { code: "EIO" })); // the second one must not throw either
    assert.equal(lines.length, 2);
    assert.match(lines[0], /\[web\] server error: EIO/);
    assert.doesNotMatch(lines.join("\n"), /SECRET/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("unknown path when signed in → 404 page; a too-large form → 413 page", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    const nf = await w.page("/nope");
    assert.equal(nf.res.status, 404);
    assert.match(nf.text, /no page here\./);
    const big = await w.post("/teammates", { x: "y".repeat(20_000) });
    assert.equal(big.status, 413);
    assert.match(await big.text(), /That form was too large\./);
  });
});

test("the officers-only 403 text has one source (context NEED.officer)", () => {
  const { TEXT } = require("../web/server");
  const { NEED } = require("../web/context");
  assert.equal(TEXT.officersOnly, NEED.officer);
  const src = fs.readFileSync(path.join(__dirname, "..", "web", "server.js"), "utf8");
  assert.equal(src.split(NEED.officer).length - 1, 0, "the literal is not repeated in server.js");
});

test("a missing /static file → the not-found page (not 'couldn't be processed'), signed in or not", async () => {
  await withWeb({}, async (w) => {
    for (const signedIn of [false, true]) {
      if (signedIn) await w.signIn(OWNER);
      const res = await w.request("/static/nope.css");
      assert.equal(res.status, 404);
      const text = await res.text();
      assert.match(text, /There&#39;s no page here\.|There's no page here\./);
      assert.doesNotMatch(text, /couldn.*t be processed/);
    }
  });
});
