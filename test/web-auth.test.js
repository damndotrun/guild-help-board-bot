"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");
const oauth = require("../web/oauth");
const { createAccess, TTL_MS } = require("../web/access");
const { createPerms } = require("../core/perms");

const USER_ID = "123456789012345678";

// A recording fake of the global fetch: `routes` maps a URL to a Response-like.
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return { fetch, calls };
}

test("authorizeUrl: identify scope, code flow, state, redirect and prompt", () => {
  const u = new URL(oauth.authorizeUrl({ clientId: "42", redirectUri: "https://bb.example.com/auth/callback", state: "st", prompt: "none" }));
  assert.equal(u.origin + u.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(u.searchParams.get("client_id"), "42");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("scope"), "identify");
  assert.equal(u.searchParams.get("state"), "st");
  assert.equal(u.searchParams.get("prompt"), "none");
  assert.equal(u.searchParams.get("redirect_uri"), "https://bb.example.com/auth/callback");
});

test("newState: 32 random bytes, URL-safe, different every time", () => {
  const a = oauth.newState();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, oauth.newState());
});

test("exchangeCode: form-encoded POST to the v10 token endpoint with a DiscordBot User-Agent", async () => {
  const f = fakeFetch({ "https://discord.com/api/v10/oauth2/token": { status: 200, body: { access_token: "tok", token_type: "Bearer" } } });
  const token = await oauth.exchangeCode({ code: "c0de", clientId: "42", clientSecret: "sec", redirectUri: "https://bb.example.com/auth/callback", fetch: f.fetch });
  assert.equal(token, "tok");
  const { init } = f.calls[0];
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.match(init.headers["User-Agent"], /^DiscordBot \(https:\/\/github\.com\/damndotrun\/guild-help-board-bot, \d+\.\d+\.\d+\)$/);
  const body = new URLSearchParams(init.body);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "c0de");
  assert.equal(body.get("redirect_uri"), "https://bb.example.com/auth/callback");
  assert.equal(body.get("client_id"), "42");
  assert.equal(body.get("client_secret"), "sec");
  assert.ok(init.signal, "every Discord call has a timeout signal");
});

test("exchangeCode: a non-2xx answer or a body without access_token is an OAuthError", async () => {
  const bad = fakeFetch({ "https://discord.com/api/v10/oauth2/token": { status: 400, body: { error: "invalid_grant" } } });
  await assert.rejects(oauth.exchangeCode({ code: "x", clientId: "1", clientSecret: "s", redirectUri: "r", fetch: bad.fetch }), (e) => e instanceof oauth.OAuthError && e.status === 400);
  const empty = fakeFetch({ "https://discord.com/api/v10/oauth2/token": { status: 200, body: {} } });
  await assert.rejects(oauth.exchangeCode({ code: "x", clientId: "1", clientSecret: "s", redirectUri: "r", fetch: empty.fetch }), oauth.OAuthError);
});

test("exchangeCode: a failed exchange never leaks the client secret or the code into the error", async () => {
  const SECRET = "fake-client-secret-DO-NOT-LEAK";
  const CODE = "fake-auth-code-DO-NOT-LEAK";
  const routes = { "https://discord.com/api/v10/oauth2/token": { status: 400, body: { error: "invalid_grant", error_description: `bad ${CODE}` } } };
  const cases = [
    fakeFetch(routes), // non-2xx
    fakeFetch({ "https://discord.com/api/v10/oauth2/token": { status: 200, body: {} } }), // no token
  ];
  for (const f of cases) {
    const err = await oauth.exchangeCode({ code: CODE, clientId: "1", clientSecret: SECRET, redirectUri: "r", fetch: f.fetch }).then(
      () => assert.fail("should have rejected"),
      (e) => e,
    );
    assert.ok(err instanceof oauth.OAuthError);
    for (const text of [err.message, err.stack, String(err)]) {
      assert.ok(!text.includes(SECRET), "client secret must not appear in the error");
      assert.ok(!text.includes(CODE), "auth code must not appear in the error");
    }
  }
});

test("fetchUserId: Bearer token to /users/@me; only a snowflake id is accepted", async () => {
  const f = fakeFetch({ "https://discord.com/api/v10/users/@me": { status: 200, body: { id: USER_ID, username: "kovi" } } });
  assert.equal(await oauth.fetchUserId({ accessToken: "tok", fetch: f.fetch }), USER_ID);
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer tok");
  assert.match(f.calls[0].init.headers["User-Agent"], /^DiscordBot /);
  assert.ok(f.calls[0].init.signal, "every Discord call has a timeout signal");
  for (const body of [{}, { id: 5 }, { id: "../x" }]) {
    const g = fakeFetch({ "https://discord.com/api/v10/users/@me": { status: 200, body } });
    await assert.rejects(oauth.fetchUserId({ accessToken: "t", fetch: g.fetch }), oauth.OAuthError);
  }
  const h = fakeFetch({ "https://discord.com/api/v10/users/@me": { status: 401, body: {} } });
  await assert.rejects(oauth.fetchUserId({ accessToken: "t", fetch: h.fetch }), (e) => e.status === 401);
});

test("fetchUserId: an error never leaks the access token", async () => {
  const TOKEN = "fake-access-token-DO-NOT-LEAK";
  const h = fakeFetch({ "https://discord.com/api/v10/users/@me": { status: 401, body: {} } });
  const err = await oauth.fetchUserId({ accessToken: TOKEN, fetch: h.fetch }).then(() => assert.fail("should have rejected"), (e) => e);
  assert.ok(!err.message.includes(TOKEN) && !err.stack.includes(TOKEN));
});

// ---------- access ----------

const MANAGE = { has: (f) => f === PermissionFlagsBits.ManageGuild };
const NONE = { has: () => false };

function fakeGuild(members) {
  const calls = [];
  return {
    calls,
    members: {
      fetch: async (arg) => {
        calls.push(arg);
        const m = members[arg.user];
        if (m instanceof Error) throw m;
        if (!m) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
        return m;
      },
    },
  };
}
const member = (displayName, { permissions = NONE, roles = [] } = {}) => ({ displayName, permissions, roles: { cache: new Map(roles.map((r) => [r, {}])) } });

test("access: a forced member fetch decides the level with the shared rule", async () => {
  const perms = createPerms({ getManagerRoleIds: () => ["mgr"] });
  const guild = fakeGuild({ o: member("Offi", { roles: ["mgr"] }), w: member("Boss", { permissions: MANAGE }), m: member("Kovi") });
  const access = createAccess({ perms });
  assert.deepEqual(await access.lookup(guild, "o"), { userId: "o", displayName: "Offi", level: "officer" });
  assert.equal((await access.lookup(guild, "w")).level, "owner");
  assert.equal((await access.lookup(guild, "m")).level, "member");
  assert.deepEqual(guild.calls[0], { user: "o", force: true });
});

test("access: cached for the TTL, fetched again after it (a demoted officer loses access within 60 s)", async () => {
  let t = 1_000_000;
  const roles = ["mgr"];
  const perms = createPerms({ getManagerRoleIds: () => ["mgr"] });
  const guild = fakeGuild({ o: { displayName: "Offi", permissions: NONE, roles: { cache: { has: (id) => roles.includes(id) } } } });
  const access = createAccess({ perms, now: () => t });
  assert.equal((await access.lookup(guild, "o")).level, "officer");
  roles.length = 0; // demoted on Discord
  t += TTL_MS - 1;
  assert.equal((await access.lookup(guild, "o")).level, "officer");
  assert.equal(guild.calls.length, 1);
  t += 1;
  assert.equal((await access.lookup(guild, "o")).level, "member");
  assert.equal(guild.calls.length, 2);
});

test("access: an unknown member is null (and cached); any other Discord failure throws and is not cached", async () => {
  const perms = createPerms();
  const flaky = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const guild = fakeGuild({ f: flaky });
  const access = createAccess({ perms });
  assert.equal(await access.lookup(guild, "gone"), null);
  assert.equal(await access.lookup(guild, "gone"), null);
  assert.equal(guild.calls.filter((c) => c.user === "gone").length, 1);
  await assert.rejects(access.lookup(guild, "f"), /socket hang up/);
  await assert.rejects(access.lookup(guild, "f"), /socket hang up/);
  assert.equal(guild.calls.filter((c) => c.user === "f").length, 2);
});

test("access: an officer who left the guild loses access once the TTL expires (null, not member)", async () => {
  let t = 5_000;
  const perms = createPerms({ getManagerRoleIds: () => ["mgr"] });
  const members = { o: member("Offi", { roles: ["mgr"] }) };
  const guild = fakeGuild(members);
  const access = createAccess({ perms, now: () => t });
  assert.equal((await access.lookup(guild, "o")).level, "officer");
  delete members.o; // left the server
  t += TTL_MS;
  assert.equal(await access.lookup(guild, "o"), null);
});

test("access: clear() and forget() drop cached levels", async () => {
  const perms = createPerms();
  const guild = fakeGuild({ m: member("Kovi") });
  const access = createAccess({ perms });
  await access.lookup(guild, "m");
  access.forget("m");
  await access.lookup(guild, "m");
  access.clear();
  await access.lookup(guild, "m");
  assert.equal(guild.calls.length, 3);
});
