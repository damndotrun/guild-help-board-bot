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
const { CALLBACKS_PER_MINUTE } = require("../web/server");

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
    // the wrong guess consumed the attempt: the real state no longer works either
    assert.equal((await w.request(`/auth/callback?code=x&state=${state}`)).status, 400);
    const again = new URL((await w.request("/auth/login")).headers.get("location")).searchParams.get("state");
    t += 10 * 60 * 1000 + 1;
    assert.equal((await w.request(`/auth/callback?code=x&state=${again}`)).status, 400);
    assert.equal((await w.request(`/auth/callback?code=x`)).status, 400);
    assert.equal(w.discord.calls.length, 0);
    assert.equal((await w.request("/")).headers.get("location"), "/login");
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

test("callback: Discord failing the token exchange → 502 page, logged, no session", async () => {
  await withWeb({}, async (w) => {
    w.discord.who.userId = "not-a-snowflake"; // /users/@me answers an invalid id
    const state = new URL((await w.request("/auth/login")).headers.get("location")).searchParams.get("state");
    const res = await w.request(`/auth/callback?code=x&state=${state}`);
    assert.equal(res.status, 502);
    assert.ok(w.log.lines.some((l) => /Discord sign-in failed/.test(l)));
    assert.equal((await w.request("/")).headers.get("location"), "/login");
  });
});

// Ruling: ANY failure of the exchange is a failed sign-in with a generic page;
// neither the log nor the page ever carries err.message (a SyntaxError quotes
// the response body, a network error the host).
test("callback: ANY error (bad JSON body, network failure, timeout) → generic 502; err.message is never logged or rendered", async () => {
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
      const text = await res.text();
      assert.equal(res.status, 502, name);
      assert.match(text, /Discord sign-in failed\./, name);
      assert.doesNotMatch(text, /SECRET/, `${name}: page`);
      const logged = w.log.lines.join("\n");
      assert.match(logged, /Discord sign-in failed/, name);
      assert.ok(logged.includes(name), `${name}: the error name is logged`);
      assert.doesNotMatch(logged, /SECRET/, `${name}: log`);
      assert.equal((await w.request("/")).headers.get("location"), "/login", `${name}: no session`);
    });
  }
});

test(`callback: more than ${CALLBACKS_PER_MINUTE} token exchanges a minute → 429 (logged as a warning), Discord not called`, async () => {
  let t = Date.now();
  await withWeb({ now: () => t }, async (w) => {
    w.discord.who.userId = OWNER;
    for (let i = 0; i < CALLBACKS_PER_MINUTE; i += 1) await w.signIn(OWNER);
    const calls = w.discord.calls.length;
    const before = w.log.lines.length;
    const state = new URL((await w.request("/auth/login")).headers.get("location")).searchParams.get("state");
    const res = await w.request(`/auth/callback?code=x&state=${state}`);
    assert.equal(res.status, 429);
    assert.equal(w.discord.calls.length, calls);
    assert.ok(w.log.lines.slice(before).some((l) => /rate limit/i.test(l)), "the limiter hit is logged");
    t += 60_000;
    await w.signIn(OWNER);
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
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
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
test("templates: no inline <script>, style= attribute, on*= handler or hx-on anywhere", () => {
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
