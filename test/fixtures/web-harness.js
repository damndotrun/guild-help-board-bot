"use strict";
// Shared harness for the web admin tests: a real Express app on 127.0.0.1:0,
// a fake Discord (OAuth endpoints + guild), a cookie jar and form helpers.
// Node's built-in fetch sends no Origin / Sec-Fetch-Site and keeps no
// cookies, so the helpers set those by hand. The web origin is https, so
// every request carries X-Forwarded-Proto: https from loopback (a trusted
// proxy) — without it the Secure session cookie would never be set.
// (node --test also runs this file as a test file; it defines no tests.)
const { PermissionFlagsBits } = require("discord.js");
const { createWebApp } = require("../../web/server");
const { createPerms, managerRolesFrom } = require("../../core/perms");
const { createCtxFor } = require("../../core/runtime");

const ORIGIN = "https://bot.example.test";
const GUILD_ID = "900000000000000001";
const WEB = Object.freeze({
  origin: ORIGIN,
  redirectUri: `${ORIGIN}/auth/callback`,
  secure: true,
  port: 0,
  clientId: "700000000000000001",
  clientSecret: "client-secret",
  sessionSecret: "s".repeat(32),
});

// users: { userId: { name, owner?: bool, roles?: [roleId] } } — the guild's members.
// roles: [{ id, name, managed?, position? }]; channels: [{ id, name, type }].
function fakeGuild({ name = "BB Test", users = {}, roles = [], channels = [] } = {}) {
  const fetchCalls = [];
  const memberOf = (id) => {
    const u = users[id];
    if (!u) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
    return {
      id,
      displayName: u.name,
      user: { username: u.name },
      permissions: { has: (flag) => u.owner === true && flag === PermissionFlagsBits.ManageGuild },
      roles: { cache: new Map((u.roles || []).map((r) => [r, { id: r }])) },
    };
  };
  const roleList = [{ id: GUILD_ID, name: "@everyone", managed: false, position: 0 }, ...roles];
  return {
    id: GUILD_ID,
    name,
    fetchCalls,
    members: {
      cache: new Map(),
      // Both call shapes the code uses: fetch({ user, force }) and fetch(userId).
      fetch: async (arg) => {
        fetchCalls.push(arg);
        return memberOf(typeof arg === "string" ? arg : arg.user);
      },
    },
    roles: { cache: new Map(roleList.map((r) => [r.id, { managed: false, position: 1, ...r }])) },
    channels: { cache: new Map(channels.map((c) => [c.id, c])) },
  };
}

// Discord's OAuth endpoints: any code → a token for `who.userId`.
// `discord.handler`, when set, answers first — a test sets it to make Discord
// misbehave (a throwing fetch, a body that is not JSON, …).
function fakeDiscord() {
  const who = { userId: null };
  const calls = [];
  const discord = { who, calls, handler: null };
  discord.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (discord.handler) return discord.handler(url, init);
    if (url === "https://discord.com/api/v10/oauth2/token") {
      return { ok: true, status: 200, json: async () => ({ access_token: `tok-${who.userId}`, token_type: "Bearer" }) };
    }
    if (url === "https://discord.com/api/v10/users/@me") {
      return { ok: true, status: 200, json: async () => ({ id: who.userId, username: "someone" }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return discord;
}

function logSink() {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(" "));
  return { lines, log: push, warn: push, error: push };
}

// startWeb({ modules?, guild?, now?, client?, ready?, lookupTimeoutMs? }) → harness
//   modules: normalized modules (core/loader normalizeModule); default none.
async function startWeb({ modules = [], guild = fakeGuild(), now = Date.now, client = null, ready = true, lookupTimeoutMs } = {}) {
  const discord = fakeDiscord();
  const log = logSink();
  const pending = [];
  const perms = createPerms({ getManagerRoleIds: managerRolesFrom(modules) });
  const ctxFor = createCtxFor({ client, dataDir: process.env.DATA_DIR, perms });
  const app = createWebApp({
    web: WEB,
    modules,
    ctxFor,
    perms,
    getGuild: async () => (ready ? guild : null),
    fetch: discord.fetch,
    now,
    log,
    lookupTimeoutMs,
    runAfter: (fn) => {
      const p = Promise.resolve().then(fn);
      pending.push(p);
      return p;
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();

  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  function remember(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (expired) jar.delete(name);
      else jar.set(name, pair.slice(i + 1));
    }
  }

  // Raw request; never follows redirects. opts: { method, form, headers, cookies: false }
  // form: an object, or [[name, value], …] pairs for a repeated field.
  async function request(path, { method = "GET", form = null, headers = {}, cookies = true } = {}) {
    const h = { "x-forwarded-proto": "https", ...headers };
    if (cookies && jar.size > 0) h.cookie = cookieHeader();
    let body;
    if (form) {
      h["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(base + path, { method, headers: h, body, redirect: "manual" });
    if (cookies) remember(res);
    return res;
  }

  // A same-origin form POST, as a browser sends it.
  function post(path, form = {}, headers = {}) {
    return request(path, { method: "POST", form, headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", ...headers } });
  }

  // GET, following redirects inside the app → { res, text }.
  async function page(path) {
    let res = await request(path);
    for (let i = 0; i < 5 && res.status >= 300 && res.status < 400; i += 1) {
      const to = new URL(res.headers.get("location"), base);
      if (to.origin !== base) break;
      res = await request(to.pathname + to.search);
    }
    return { res, text: await res.text() };
  }

  // POST then follow the 303 → { res (the POST), next: { res, text } | null }
  async function submit(path, form = {}) {
    const res = await post(path, form);
    if (res.status !== 303) return { res, text: await res.text(), next: null };
    return { res, text: "", next: await page(res.headers.get("location")) };
  }

  // Full OAuth round trip as `userId`; leaves the session cookie in the jar.
  async function signIn(userId) {
    discord.who.userId = userId;
    const start = await request("/auth/login");
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cb = await request(`/auth/callback?code=test-code&state=${encodeURIComponent(state)}`);
    if (cb.status !== 303) throw new Error(`sign-in failed: ${cb.status} ${await cb.text()}`);
    return cb;
  }

  return {
    base,
    guild,
    discord,
    log,
    jar,
    request,
    post,
    page,
    submit,
    signIn,
    // Wait for every effects run started so far.
    settle: () => Promise.all(pending.splice(0)),
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { ORIGIN, GUILD_ID, WEB, fakeGuild, fakeDiscord, startWeb };
