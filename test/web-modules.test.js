"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bbwebmod-"));
process.env.DATA_DIR = TMP;

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startWeb, fakeGuild } = require("./fixtures/web-harness");
const { normalizeModule } = require("../core/loader");
const { defaultRunAfter } = require("../web/server");
const { CONFIRM_TTL_MS } = require("../web/context");

const OFFICER = "100000000000000001";
const OWNER = "100000000000000002";
const MEMBER = "100000000000000003";
const STRANGER = "100000000000000009"; // not in the guild
const MGR = "200000000000000001";

const FRAG = path.join(TMP, "demo.ejs");
fs.writeFileSync(FRAG, '<p class="demo"><%= page.text %></p>');

const state = { calls: [], effects: 0, gen: 0, order: [], gate: null };

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// A demo module: one officer page, owner pages (guarded by the route itself
// AND by the nav's minLevel alone), a plain POST, a confirmed POST with a
// state guard, a route that throws, and a manager-role provider so an
// officer exists without the help module.
function demoModule(name = "demo", title = "Demo board") {
  return normalizeModule({
    name,
    managerRoles: name === "demo" ? () => [MGR] : undefined,
    web: {
      title,
      nav: [
        { label: "Home", path: "/" },
        { label: "Secret", path: "/secret", minLevel: "owner" },
        { label: "Vault", path: "/vault", minLevel: "owner" },
      ],
      routes(router, web) {
        router.get("/", (req, res) => web.render(req, res, { title: "Demo", file: FRAG, page: { text: `hello ${web.actor(req).displayName}` } }));
        router.get("/secret", web.requireLevel("owner"), (req, res) => web.render(req, res, { title: "Secret", file: FRAG, page: { text: "secret" } }));
        // No requireLevel here: only the nav's minLevel protects these.
        router.get("/vault", (req, res) => web.render(req, res, { title: "Vault", file: FRAG, page: { text: "vault-page" } }));
        router.post("/vault/edit", (req, res) => {
          state.calls.push("vault-edit");
          web.done(req, res, `/${name}`, { ok: true, text: "Vault edited." });
        });
        router.post("/do", (req, res) => {
          state.calls.push({ actor: web.actor(req), x: web.field(req, "x") });
          web.done(req, res, `/${name}`, { ok: true, text: "Done <it>." }, async () => {
            state.effects += 1;
          });
        });
        router.post("/slow", (req, res) => {
          web.done(req, res, `/${name}`, { ok: true, text: "Queued." }, async () => {
            state.order.push(`effect-start:ended=${res.writableEnded}`);
            await state.gate.promise;
            state.order.push("effect-end");
          });
        });
        router.post("/danger", async (req, res) => {
          const x = web.field(req, "x");
          const ok = await web.confirmed(req, res, {
            title: "Really?",
            lines: ["It <b>goes</b>."],
            action: `/${name}/danger`,
            fields: { x },
            confirmLabel: "Do it",
            cancelHref: `/${name}`,
            guard: state.gen,
          });
          if (!ok) return;
          state.gen += 1; // the action changed the state the confirmation was issued for
          state.calls.push(`danger:${x}`);
          web.done(req, res, `/${name}`, { ok: false, text: "Gone." });
        });
        router.post("/clash", async (req, res) => {
          const ok = await web.confirmed(req, res, { title: "T", lines: [], action: "/x", fields: { guard: "1" }, confirmLabel: "Go", cancelHref: "/" });
          if (ok) web.done(req, res, "/", { ok: true, text: "x" });
        });
        router.post("/roles", (req, res) => {
          web.forgetLevels();
          web.done(req, res, `/${name}`, { ok: true, text: "Roles changed." });
        });
        router.post("/noguard", async (req, res) => {
          // A forgotten `guard`: confirmed() must refuse loudly.
          const ok = await web.confirmed(req, res, { title: "T", lines: [], action: "/x", fields: {}, confirmLabel: "Go", cancelHref: "/" });
          if (ok) web.done(req, res, "/", { ok: true, text: "x" });
        });
        router.get("/boom", () => {
          throw new Error("kaboom");
        });
        // Last, and unguarded: a one-segment param route, so percent-encoded
        // spellings ("/%76ault") reach a handler and only the nav gate decides.
        router.get("/:page", (req, res) => web.render(req, res, { title: "Param", file: FRAG, page: { text: `param:${req.params.page}` } }));
      },
    },
  });
}

const guild = () =>
  fakeGuild({
    users: {
      [OFFICER]: { name: "Offi", roles: [MGR] },
      [OWNER]: { name: "Boss", owner: true },
      [MEMBER]: { name: "Mem" },
    },
  });

async function withWeb(opts, fn) {
  state.calls = [];
  state.effects = 0;
  state.gen = 0;
  state.order = [];
  state.gate = deferred();
  const w = await startWeb({ guild: guild(), modules: [demoModule()], ...opts });
  try {
    await fn(w);
  } finally {
    state.gate.resolve();
    await w.close();
  }
}

const issuedOf = (html) => html.match(/name="issued" value="(\d+)"/)[1];
const guardOf = (html) => html.match(/name="guard" value="([^"]*)"/)[1];

test("loader: web is validated — routes, title, nav path, minLevel, reserved names", () => {
  const base = { title: "T", nav: [{ label: "A", path: "/" }], routes: () => {} };
  assert.equal(normalizeModule({ name: "x" }).web, null);
  assert.deepEqual(normalizeModule({ name: "x", web: base }).web.nav, [{ label: "A", path: "/", minLevel: "officer" }]);
  const bad = [
    [{ ...base, routes: null }, /routes must be a function/],
    [{ ...base, title: " " }, /title/],
    [{ ...base, nav: [] }, /nav must be a non-empty array/],
    [{ ...base, nav: [{ label: "A", path: "seasons" }] }, /path/],
    [{ ...base, nav: [{ label: "A", path: "/../x?" }] }, /path/],
    [{ ...base, nav: [{ label: "A", path: "/", minLevel: "member" }] }, /minLevel/],
    [{ ...base, nav: [{ label: "", path: "/" }] }, /label/],
    // "//" would never match the gate's collapsed request path (fails open)
    [{ ...base, nav: [{ label: "A", path: "/a//b", minLevel: "owner" }] }, /path/],
    [{ ...base, nav: [{ label: "A", path: "//", minLevel: "owner" }] }, /path/],
  ];
  for (const [web, re] of bad) assert.throws(() => normalizeModule({ name: "x", web }), re);
  for (const name of ["auth", "static", "login", "teammates"]) {
    assert.throws(() => normalizeModule({ name, web: base }), /reserved web path/, name);
  }
});

test("sidebar is role-adaptive: an officer does not see owner pages; module order, then Teammates", async () => {
  const two = [demoModule(), demoModule("zeta", "Zeta board")];
  await withWeb({ modules: two }, async (w) => {
    await w.signIn(OFFICER);
    const { text } = await w.page("/demo");
    const sidebar = text.slice(text.indexOf('class="sidebar"'));
    assert.match(sidebar, /Demo board[\s\S]*Home[\s\S]*Zeta board[\s\S]*Teammates[\s\S]*Coming soon/);
    assert.doesNotMatch(sidebar, /Secret|Vault/);
    assert.match(sidebar, /href="\/demo" aria-current="page">Home/);
  });
  await withWeb({ modules: two }, async (w) => {
    await w.signIn(OWNER);
    const { text } = await w.page("/demo/secret");
    assert.match(text, /href="\/demo\/secret" aria-current="page">Secret/);
    assert.doesNotMatch(text, /href="\/demo" aria-current/, "the module root is not active on its sub-pages");
  });
});

test("/ goes to the first page of the first module", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OFFICER);
    const res = await w.request("/");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/demo");
  });
});

test("an owner-only page typed in by an officer → 403 page, not the content", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OFFICER);
    const { res, text } = await w.page("/demo/secret");
    assert.equal(res.status, 403);
    assert.match(text, /Only members with Manage Server can change bot settings\./);
    assert.doesNotMatch(text, /class="demo">secret/);
  });
});

test("a module's nav minLevel is enforced server-side even when the route has no guard of its own (GET and POST, any spelling)", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OFFICER);
    for (const p of ["/demo/vault", "/demo/VAULT", "/demo/vault/", "/demo/vault/x"]) {
      const { res, text } = await w.page(p);
      assert.notEqual(res.status, 200, p);
      assert.doesNotMatch(text, /vault-page/, p);
    }
    for (const p of ["/demo/vault", "/demo/VAULT", "/demo/vault/"]) {
      assert.equal((await w.page(p)).res.status, 403, p);
    }
    for (const p of ["//demo//vault", "/demo//vault"]) {
      const { res, text } = await w.page(p);
      assert.notEqual(res.status, 200, p);
      assert.doesNotMatch(text, /vault-page|param:/, p);
    }
    // Percent-encoded spellings reach the unguarded `/:page` route — proved by
    // an innocent page — so it is the gate's decoded comparison that refuses them.
    const innocent = await w.page("/demo/%6Fther");
    assert.equal(innocent.res.status, 200);
    assert.match(innocent.text, /param:other/);
    for (const p of ["/demo/%76ault", "/demo/%56AULT", "/demo/vault%2F", "/demo/%73ecret"]) {
      const { res, text } = await w.page(p);
      assert.equal(res.status, 403, p);
      assert.doesNotMatch(text, /param:|vault-page/, p);
    }
    const post = await w.post("/demo/vault/edit");
    assert.equal(post.status, 403);
    assert.deepEqual(state.calls, [], "the guarded POST handler never ran");
    // The root page (minLevel officer) is not affected by a sibling's guard.
    assert.equal((await w.page("/demo")).res.status, 200);
  });
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    assert.match((await w.page("/demo/vault")).text, /vault-page/);
    assert.equal((await w.post("/demo/vault/edit")).status, 303);
    assert.deepEqual(state.calls, ["vault-edit"]);
  });
});

test("an owner-level nav item with path '/' guards the whole module (fail closed), not just its root page", async () => {
  const locked = normalizeModule({
    name: "locked",
    web: {
      title: "Locked",
      nav: [{ label: "Root", path: "/", minLevel: "owner" }],
      routes(router, web) {
        router.get("/", (req, res) => web.render(req, res, { title: "L", file: FRAG, page: { text: "locked-root" } }));
        router.get("/sub", (req, res) => web.render(req, res, { title: "L", file: FRAG, page: { text: "locked-sub" } }));
        router.post("/sub/edit", (req, res) => {
          state.calls.push("locked-edit");
          web.done(req, res, "/locked", { ok: true, text: "ok" });
        });
      },
    },
  });
  await withWeb({ modules: [demoModule(), locked] }, async (w) => {
    await w.signIn(OFFICER);
    for (const p of ["/locked", "/locked/sub", "/locked/SUB/"]) {
      const { res, text } = await w.page(p);
      assert.equal(res.status, 403, p);
      assert.doesNotMatch(text, /locked-(root|sub)/, p);
    }
    assert.equal((await w.post("/locked/sub/edit")).status, 403);
    assert.deepEqual(state.calls, []);
  });
  await withWeb({ modules: [demoModule(), locked] }, async (w) => {
    await w.signIn(OWNER);
    assert.match((await w.page("/locked/sub")).text, /locked-sub/);
    assert.equal((await w.post("/locked/sub/edit")).status, 303);
  });
});

test("every module route is behind the gate: a plain member and a non-member get 403, a signed-out visitor goes to /login; nothing runs", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(MEMBER);
    for (const p of ["/demo", "/demo/secret", "/demo/boom"]) {
      const { res, text } = await w.page(p);
      assert.equal(res.status, 403, p);
      assert.match(text, /This page is for officers and owners\./);
    }
    for (const p of ["/demo/do", "/demo/danger", "/demo/roles"]) assert.equal((await w.post(p, { x: "1" })).status, 403, p);
    assert.deepEqual(state.calls, []);
    assert.equal(state.effects, 0);
  });
  await withWeb({}, async (w) => {
    await w.signIn(STRANGER);
    assert.equal((await w.page("/demo")).res.status, 403);
    assert.equal((await w.post("/demo/do", { x: "1" })).status, 403);
    assert.deepEqual(state.calls, []);
  });
  await withWeb({}, async (w) => {
    const get = await w.request("/demo");
    assert.equal(get.status, 303);
    assert.equal(get.headers.get("location"), "/login");
    const post = await w.post("/demo/do", { x: "1" });
    assert.equal(post.status, 303);
    assert.equal(post.headers.get("location"), "/login");
    assert.deepEqual(state.calls, []);
  });
});

test("a POST: the actor comes from the live viewer; 303 back; one notice line, once; effects run after the response", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OFFICER);
    const r = await w.post("/demo/do", { x: "1" });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/demo");
    await w.settle();
    assert.equal(state.effects, 1);
    assert.deepEqual(state.calls[0], { actor: { userId: OFFICER, displayName: "Offi", level: "officer" }, x: "1" });
    const first = await w.page("/demo");
    assert.match(first.text, /class="notice notice-ok" role="status">✓ Done &lt;it&gt;\./);
    const second = await w.page("/demo");
    assert.doesNotMatch(second.text, /Done &lt;it&gt;/);
  });
});

test("effects run AFTER the response: it is complete while a slow effect is still pending", { timeout: 15_000 }, async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OFFICER);
    const r = await w.post("/demo/slow");
    await r.text(); // the whole response has arrived — the effect is gated and still running
    assert.equal(r.status, 303);
    state.order.push("response-complete");
    assert.deepEqual(state.order, ["effect-start:ended=true", "response-complete"], "the response was already ended when the effect started, and the effect is still pending");
    state.gate.resolve();
    await w.settle();
    assert.deepEqual(state.order, ["effect-start:ended=true", "response-complete", "effect-end"]);
  });
});

test("a repeated form field reaches the module as '' (never an array)", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OFFICER);
    const r = await w.post("/demo/do", [["x", "1"], ["x", "2"]]); // x=1&x=2
    assert.equal(r.status, 303);
    assert.equal(state.calls.at(-1).x, "");
  });
});

test("confirmation: first POST shows the page (nothing happens); a fresh confirm goes through", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    const ask = await w.post("/demo/danger", { x: "a" });
    assert.equal(ask.status, 200);
    const html = await ask.text();
    assert.match(html, /It &lt;b&gt;goes&lt;\/b&gt;\./);
    assert.match(html, /class="btn btn-danger">Do it</);
    assert.doesNotMatch(html, /btn-primary/);
    assert.deepEqual(state.calls, []);
    const go = await w.post("/demo/danger", { x: "a", confirm: "yes", issued: issuedOf(html), guard: guardOf(html) });
    assert.equal(go.status, 303);
    assert.deepEqual(state.calls, ["danger:a"]);
  });
});

test("confirmation replay (C1): the same confirm form twice → the second is a no-op with a notice", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    const html = await (await w.post("/demo/danger", { x: "a" })).text();
    const form = { x: "a", confirm: "yes", issued: issuedOf(html), guard: guardOf(html) };
    const first = await w.post("/demo/danger", form);
    assert.equal(first.status, 303);
    assert.deepEqual(state.calls, ["danger:a"]);
    // Back button / second tab: same form, still well inside the 5 minutes.
    const replay = await w.post("/demo/danger", form);
    assert.equal(replay.status, 303);
    assert.equal(replay.headers.get("location"), "/demo", "to the cancel page");
    assert.deepEqual(state.calls, ["danger:a"], "nothing ran the second time");
    assert.equal(state.gen, 1);
    const { text } = await w.page("/demo");
    assert.match(text, /class="notice notice-error" role="status">✕ Already done or changed — nothing happened\./);
  });
});

test("confirmation guard: a missing or forged `guard` never matches the fresh state", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    const html = await (await w.post("/demo/danger", { x: "a" })).text();
    const issued = issuedOf(html);
    for (const guard of [undefined, "", "99", "0 "]) {
      const form = { x: "a", confirm: "yes", issued };
      if (guard !== undefined) form.guard = guard;
      const res = await w.post("/demo/danger", form);
      assert.equal(res.status, 303, String(guard));
    }
    assert.deepEqual(state.calls, []);
    // The page issued for a state that has since moved on is refused too.
    state.gen = 5;
    const res = await w.post("/demo/danger", { x: "a", confirm: "yes", issued, guard: guardOf(html) });
    assert.equal(res.status, 303);
    assert.deepEqual(state.calls, []);
    // A re-asked confirmation carries the CURRENT guard.
    const again = await (await w.post("/demo/danger", { x: "a" })).text();
    assert.equal(guardOf(again), "5");
  });
});

test("confirmation: stale (> 5 min), future-dated or garbage `issued` → the page again with 'expired', nothing happens", async () => {
  let t = Date.now();
  await withWeb({ now: () => t }, async (w) => {
    await w.signIn(OWNER);
    const html = await (await w.post("/demo/danger", { x: "a" })).text();
    const issued = issuedOf(html);
    const guard = guardOf(html);
    t += CONFIRM_TTL_MS + 1;
    for (const value of [issued, String(t + 60_000), "abc", ""]) {
      const res = await w.post("/demo/danger", { x: "a", confirm: "yes", issued: value, guard });
      assert.equal(res.status, 200, value);
      const reissued = await res.text();
      assert.match(reissued, /This confirmation expired — review and confirm again\./);
      assert.equal(issuedOf(reissued), String(t), "re-issued with a fresh timestamp");
    }
    assert.deepEqual(state.calls, []);
    assert.equal(state.gen, 0);
  });
});

test("confirmation: a spec whose fields clash with the control fields is a programming error (500, nothing runs)", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    const { res } = await w.submit("/demo/clash");
    assert.equal(res.status, 500);
    assert.ok(w.log.errors.some((l) => /reserved confirmation field/.test(l)));
  });
});

test("confirmation: a spec without a guard (missing, null or empty) is a programming error (500, nothing runs) — no silent replay hole", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    const { res } = await w.submit("/demo/noguard");
    assert.equal(res.status, 500);
    assert.ok(w.log.errors.some((l) => /spec\.guard is required/.test(l)));
    // A replayed confirm with the empty field a guard-less form would carry.
    const replay = await w.post("/demo/noguard", { confirm: "yes", issued: String(Date.now()), guard: "" });
    assert.equal(replay.status, 500);
    assert.deepEqual(state.calls, []);
  });
});

test("forgetLevels(): the next request looks the member up again", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    await w.page("/demo");
    const before = w.guild.fetchCalls.length;
    await w.post("/demo/roles");
    await w.page("/demo");
    // The POST itself was served from the cache; the GET after the clear refetches.
    assert.equal(w.guild.fetchCalls.length, before + 1);
  });
});

test("a module route that throws → the 500 page, logged, no stack in the page", async () => {
  await withWeb({}, async (w) => {
    await w.signIn(OWNER);
    const { res, text } = await w.page("/demo/boom");
    assert.equal(res.status, 500);
    assert.match(text, /Something went wrong on our side\./);
    assert.doesNotMatch(text, /kaboom/);
    assert.ok(w.log.lines.some((l) => /kaboom/.test(l)));
  });
});

test("defaultRunAfter: a failing effect is logged, never an unhandled rejection", async () => {
  const lines = [];
  const run = defaultRunAfter({ error: (...a) => lines.push(a.map(String).join(" ")) });
  await run(async () => {
    throw new Error("card REST failed");
  });
  assert.ok(lines.some((l) => /follow-up after a saved change failed/.test(l) && /card REST failed/.test(l)));
});
