// The web admin (platform spec §5, M2 spec §6): an Express 5 app inside the
// bot's own process. Server-rendered EJS pages + vendored htmx; sign-in with
// Discord OAuth; the viewer's level is decided by the BOT from the live guild
// member on every request (60 s cache); modules add pages through their
// `web: { title, nav, routes }` field and write only through their own action
// functions — the web never writes data itself.
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const { atLeast, LEVEL_LABEL } = require("../core/perms");
const oauth = require("./oauth");
const { createAccess } = require("./access");
const { TRUST_PROXY, httpError, sameOriginGuard, fixedWindowLimiter, perClientLimiter } = require("./security");
const session = require("./session");
const { renderView } = require("./render");
const { HTMX, HTMX_CONFIG } = require("./vendor");
const { createWebCtx, NEED } = require("./context");

const VIEWS = path.join(__dirname, "views");
const PUBLIC = path.join(__dirname, "public");
const view = (name) => path.join(VIEWS, `${name}.ejs`);

// Sign-in callbacks (each = one Discord token exchange) allowed per minute,
// process-wide — see fixedWindowLimiter.
const CALLBACKS_PER_MINUTE = 30;
// ...and per client (req.ip), checked first so one client cannot drain the
// process-wide budget — see perClientLimiter. At most CLIENTS_TRACKED clients
// are remembered at once (oldest evicted).
const CLIENT_CALLBACKS_PER_MINUTE = 10;
const CLIENTS_TRACKED = 10_000;

// Overall deadline of the per-request member lookup. discord.js REST can retry
// and sleep for a minute or more on a rate limit; the page must not hang with it.
const LOOKUP_TIMEOUT_MS = 10_000;

// Sidebar entries for modules that do not have web pages yet (M2 spec §6:
// Teammates is a "Coming soon" placeholder until M5).
const COMING_SOON = Object.freeze([{ title: "Teammates", label: "Coming soon", href: "/teammates" }]);

const TEXT = Object.freeze({
  officersOnly: "This page is for officers and owners.",
  notReady: "The bot isn't connected to Discord yet — try again in a minute.",
  lookupFailed: "Couldn't check your role on Discord right now — try again in a minute.",
  notFound: "There's no page here.",
  stateBad: "That sign-in link has expired or was already used. Start again from the sign-in page.",
  noCode: "Discord didn't send a sign-in code. Start again from the sign-in page.",
  cancelled: "Sign-in was cancelled.",
  busy: "Too many sign-ins right now — wait a minute and try again.",
  discordFailed: "Discord sign-in failed. Try again in a moment.",
  notHttps:
    "This address isn't being reached over HTTPS, so the sign-in cookie can't be set. " +
    "(For the operator: the proxy must send X-Forwarded-Proto: https.)",
  tooLarge: "That form was too large.",
  badRequest: "That request couldn't be processed.",
  broken: "Something went wrong on our side.",
});

// Enforces a module's nav `minLevel` on the paths behind it, server-side: an
// owner-level nav item guards its page AND everything below it (a nav item
// "/config" also guards POST /config/roles/add), whatever the module's routes
// do. The nav hiding the link is convenience; this is the protection. The
// comparison is on a normalised path (lower-case, slashes collapsed, both the
// raw and the percent-decoded form) so spelling variants cannot slip past a
// router that matches case-insensitively. A "/" item guards the WHOLE module
// (plain prefix, fail closed).
function navGate(mod) {
  const guarded = mod.web.nav.filter((item) => item.minLevel !== "officer");
  if (guarded.length === 0) return null;
  const normalise = (p) => p.toLowerCase().replace(/\/{2,}/g, "/");
  return (req, res, next) => {
    const forms = new Set([normalise(req.path)]);
    try {
      forms.add(normalise(decodeURIComponent(req.path)));
    } catch {
      // a malformed escape: the raw form alone is checked (the router will 400/404 it)
    }
    for (const item of guarded) {
      // "/" → base "" → every path below the module is under it (fail closed).
      const base = normalise(item.path).replace(/\/+$/, "");
      const hit = [...forms].some((p) => p === base || p.startsWith(`${base}/`));
      if (hit && !atLeast(req.viewer.level, item.minLevel)) return next(httpError(403, NEED[item.minLevel]));
    }
    return next();
  };
}

function helmetFor(web) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        // Only behind HTTPS; on a plain-http local run it would break the page.
        "upgrade-insecure-requests": web.secure ? [] : null,
      },
    },
    // "same-origin", NOT "no-referrer": under the Fetch spec a no-referrer page
    // sends `Origin: null` on a non-CORS form POST, and sameOriginGuard would
    // refuse every plain form (Sign out, all no-JS forms). same-origin still
    // sends no referrer to Discord or any other outside site.
    referrerPolicy: { policy: "same-origin" },
  });
}

// Slow REST after a saved change (request cards, board refresh) runs after
// the response has gone out — like the Discord paths run `effects` after the ack.
function defaultRunAfter(log) {
  return (fn) =>
    Promise.resolve()
      .then(fn)
      .catch((err) => log.error("[web] follow-up after a saved change failed:", err));
}

// createWebApp({ web, modules, ctxFor, perms, getGuild, fetch?, now?, log?, runAfter?, lookupTimeoutMs? }) → express app
//   web      = core/config parseWebConfig() result
//   modules  = the loaded (normalized) modules; those with `web` get pages
//   getGuild = async () → the bot's Guild, or null while it is not ready
function createWebApp({
  web,
  modules,
  ctxFor,
  perms,
  getGuild,
  fetch = globalThis.fetch,
  now = Date.now,
  log = console,
  runAfter,
  lookupTimeoutMs = LOOKUP_TIMEOUT_MS,
}) {
  const after = runAfter || defaultRunAfter(log);
  const access = createAccess({ perms, now });
  const callbackAllowed = fixedWindowLimiter({ max: CALLBACKS_PER_MINUTE, windowMs: 60_000, now });
  const clientCallbackAllowed = perClientLimiter({
    max: CLIENT_CALLBACKS_PER_MINUTE,
    windowMs: 60_000,
    maxClients: CLIENTS_TRACKED,
    now,
  });
  const webModules = modules.filter((m) => m.web);

  // access.lookup under an overall deadline. The deadline only ends the wait:
  // it writes nothing to the level cache (a lookup that finishes late still
  // caches its own real answer, and one that fails late is ignored).
  async function lookupWithDeadline(guild, userId) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`member lookup timed out after ${lookupTimeoutMs} ms`)), lookupTimeoutMs);
    });
    try {
      return await Promise.race([access.lookup(guild, userId), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  function navFor(viewer, currentPath) {
    if (!viewer) return null;
    const mark = (href) => ({ href, active: currentPath === href || currentPath.startsWith(`${href}/`) });
    const groups = [];
    for (const mod of webModules) {
      const base = `/${mod.name}`;
      const items = mod.web.nav
        .filter((item) => atLeast(viewer.level, item.minLevel))
        .map((item) => {
          const href = item.path === "/" ? base : `${base}${item.path}`;
          // The module root is "active" only on itself, not on its sub-pages.
          const m = mark(href);
          return { label: item.label, href, active: href === base ? currentPath === base : m.active };
        });
      if (items.length > 0) groups.push({ title: mod.web.title, items });
    }
    for (const s of COMING_SOON) {
      groups.push({ title: s.title, items: [{ label: s.label, ...mark(s.href) }] });
    }
    return groups;
  }

  // Render `file` (a page fragment: it sees only `page`) inside the layout.
  async function sendPage(req, res, { status = 200, title, file, page = {} }) {
    const html = await renderView(file, { page });
    const viewer = req.viewer || null;
    // exp-checked (a session past its server-side expiry is not "signed in"),
    // not the raw cookie contents.
    const signedIn = session.currentUserId(req, now()) !== null;
    const layout = {
      title,
      serverName: req.guild ? req.guild.name : null,
      viewer: viewer ? { name: viewer.displayName, level: LEVEL_LABEL[viewer.level] || viewer.level } : null,
      signedIn,
      nav: navFor(viewer, req.originalUrl.split("?")[0]),
      notice: req.session ? session.takeNotice(req) : null,
      htmxSrc: `/static/${HTMX.file}`,
      htmxIntegrity: HTMX.integrity,
      htmxConfig: HTMX_CONFIG,
    };
    const doc = await renderView(view("layout"), { layout, page: { html } });
    res.status(status).type("html").send(doc);
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", TRUST_PROXY);
  app.use(helmetFor(web));
  app.use("/static", express.static(PUBLIC, { index: false, fallthrough: false, maxAge: "1h" }));
  // Everything below /static is dynamic and may be a signed-in admin page,
  // redirect or error page: never cacheable by a shared cache or replayed by
  // the back button (C5). Set before anything can respond, and again in the
  // error handler.
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(session.sessionMiddleware({ secret: web.sessionSecret, secure: web.secure }));
  app.use(sameOriginGuard(web.origin));
  app.use(express.urlencoded({ extended: false, limit: "10kb", parameterLimit: 50 }));

  // ---------- sign-in / sign-out (public) ----------

  app.get("/login", async (req, res) => {
    if (session.currentUserId(req, now())) return res.redirect(303, "/");
    return sendPage(req, res, { title: "Sign in", file: view("login") });
  });

  app.get("/auth/login", (req, res, next) => {
    if (web.secure && !req.secure) {
      log.error("[web] sign-in refused: the request is not HTTPS — check that the proxy sends X-Forwarded-Proto: https");
      return next(httpError(500, TEXT.notHttps));
    }
    const prompt = req.query.prompt === "consent" ? "consent" : "none";
    const state = session.issueState(req, oauth.newState(), prompt, now());
    return res.redirect(302, oauth.authorizeUrl({ clientId: web.clientId, redirectUri: web.redirectUri, state, prompt }));
  });

  app.get("/auth/callback", async (req, res, next) => {
    const prompt = session.takeState(req, req.query.state, now());
    if (!prompt) return next(httpError(400, TEXT.stateBad));
    if (req.query.error !== undefined) {
      // Discord's OAuth error code (access_denied, consent_required, …) — only
      // a plain code is logged; anything else (repeated, odd characters) is "other".
      const raw = req.query.error;
      const errorCode = typeof raw === "string" && /^[a-z_]{1,40}$/.test(raw) ? raw : "other";
      log.warn(`[web] Discord sign-in returned an error (prompt=${prompt}), error code: ${errorCode}`);
      // prompt=none only works for someone who already authorized the app —
      // ask once more, this time with Discord's consent screen.
      if (prompt === "none") return res.redirect(302, "/auth/login?prompt=consent");
      return next(httpError(401, TEXT.cancelled));
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) return next(httpError(400, TEXT.noCode));
    // Per client first: a refused client does not use up the shared budget.
    // req.ip honours TRUST_PROXY; it is a limiter key only, never logged here.
    if (!clientCallbackAllowed(req.ip || "unknown")) {
      log.warn(`[web] sign-in refused: one client made more than ${CLIENT_CALLBACKS_PER_MINUTE} token exchanges in a minute (per-client rate limit)`);
      return next(httpError(429, TEXT.busy));
    }
    if (!callbackAllowed()) {
      log.warn(`[web] sign-in refused: more than ${CALLBACKS_PER_MINUTE} token exchanges in a minute (rate limit)`);
      return next(httpError(429, TEXT.busy));
    }
    let userId;
    try {
      const accessToken = await oauth.exchangeCode({
        code,
        clientId: web.clientId,
        clientSecret: web.clientSecret,
        redirectUri: web.redirectUri,
        fetch,
      });
      userId = await oauth.fetchUserId({ accessToken, fetch });
    } catch (err) {
      // ANY failure (OAuthError, timeout, bad JSON, network) is a failed
      // sign-in. Only the error's name and HTTP status are logged, never its
      // message: a SyntaxError quotes the response body, a network error the host.
      log.error("[web] Discord sign-in failed:", err?.name ?? "Error", err?.status ?? "");
      return next(httpError(502, TEXT.discordFailed));
    }
    session.signIn(req, userId, now());
    return res.redirect(303, "/");
  });

  app.post("/auth/logout", (req, res) => {
    session.signOut(req);
    res.redirect(303, "/login");
  });

  // ---------- everything below: a signed-in officer or owner ----------

  app.use(async (req, res, next) => {
    const userId = session.currentUserId(req, now());
    if (!userId) return res.redirect(303, "/login");
    const guild = await getGuild();
    if (!guild) return next(httpError(503, TEXT.notReady));
    req.guild = guild;
    let viewer;
    try {
      viewer = await lookupWithDeadline(guild, userId);
    } catch (err) {
      log.error("[web] member lookup failed:", err?.message ?? err);
      return next(httpError(503, TEXT.lookupFailed));
    }
    if (!viewer || !atLeast(viewer.level, "officer")) return next(httpError(403, TEXT.officersOnly));
    req.viewer = viewer;
    return next();
  });

  app.get("/", async (req, res) => {
    const first = navFor(req.viewer, "/")[0];
    return res.redirect(302, first ? first.items[0].href : "/teammates");
  });

  app.get("/teammates", (req, res) => sendPage(req, res, { title: "Teammates", file: view("soon") }));

  // Module pages at /<name>, behind the gate above (req.viewer is an officer
  // or owner) and each nav item's own minLevel.
  for (const mod of webModules) {
    const router = express.Router();
    const gate = navGate(mod);
    if (gate) router.use(gate);
    mod.web.routes(router, createWebCtx({ ctx: ctxFor(mod), sendPage, access, now, runAfter: after }));
    app.use(`/${mod.name}`, router);
  }

  app.use((req, res, next) => next(httpError(404, TEXT.notFound)));

  // eslint-disable-next-line no-unused-vars
  app.use(async (err, req, res, next) => {
    let status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    let text = err.publicMessage;
    if (!text) {
      if (status === 413) text = TEXT.tooLarge;
      else if (status < 500) text = TEXT.badRequest;
      else text = TEXT.broken;
    }
    if (status >= 500 && !err.publicMessage) log.error("[web] request failed:", err);
    if (res.headersSent) return;
    res.set("Cache-Control", "no-store");
    try {
      await sendPage(req, res, { status, title: status === 404 ? "Not found" : "Error", file: view("error"), page: { status, text } });
    } catch (renderErr) {
      log.error("[web] error page failed:", renderErr);
      status = 500;
      res.status(status).type("text").send(TEXT.broken);
    }
  });

  return app;
}

// Listen on web.port. Resolves with the http.Server once listening; rejects
// (e.g. EADDRINUSE) so the caller can stop the bot before its first side effect.
// After that a server error is logged (code/name only), never thrown: an
// 'error' event without a listener would crash the bot.
function startWeb(options) {
  const app = createWebApp(options);
  const log = options.log || console;
  return new Promise((resolve, reject) => {
    const server = app.listen(options.web.port);
    server.once("error", reject);
    server.once("listening", () => {
      server.removeListener("error", reject);
      server.on("error", (e) => log.error("[web] server error:", e?.code || e?.name || "Error"));
      resolve(server);
    });
  });
}

module.exports = { COMING_SOON, CALLBACKS_PER_MINUTE, CLIENT_CALLBACKS_PER_MINUTE, LOOKUP_TIMEOUT_MS, TEXT, defaultRunAfter, createWebApp, startWeb };
