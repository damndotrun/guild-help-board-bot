// Request-level protections of the web admin.

// Proxies whose X-Forwarded-* headers Express believes. The Cloudflare Tunnel
// connector reaches the container from a Docker network (172.16/12 — covered by
// "uniquelocal"); "loopback" is for a local reverse proxy and the tests.
// Deviation from the platform spec's 'uniquelocal' (research 2026-09-30):
// without loopback, a request over 127.0.0.1 carrying X-Forwarded-Proto: https
// is treated as plain http, and cookie-session then SILENTLY drops the Secure
// session cookie (200, no Set-Cookie, no error). A LAN client is "uniquelocal"
// too, so the forwarded client IP is for logging only — never for auth.
const TRUST_PROXY = "loopback, uniquelocal";

// An error whose `publicMessage` is safe to show on the error page.
function httpError(status, publicMessage) {
  return Object.assign(new Error(publicMessage), { status, publicMessage });
}

// CSRF (platform spec §5): only POST may change anything, and a POST must come
// from our own pages. `Origin` must equal the PUBLIC_URL origin, and
// `Sec-Fetch-Site` — set by the browser itself, page scripts cannot forge it —
// must be "same-origin" when present. A POST with no Origin is refused.
// SameSite=Lax on the session cookie is the third layer. Every other method is 405.
function sameOriginGuard(origin) {
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    if (req.method !== "POST") {
      res.set("Allow", "GET, HEAD, POST");
      return next(httpError(405, "That kind of request isn't supported here."));
    }
    const site = req.get("sec-fetch-site");
    if (site !== undefined && site !== "same-origin") {
      return next(httpError(403, "That form didn't come from this site, so nothing was changed."));
    }
    if (req.get("origin") !== origin) {
      return next(httpError(403, "That form didn't come from this site, so nothing was changed."));
    }
    return next();
  };
}

// A process-wide fixed-window counter: take() → true while under `max` per
// `windowMs`. Guards the Discord token exchange: the bot and the web share
// one IP, and a flood of bogus sign-in callbacks must not get that IP
// rate-limited or banned by Discord. Per-client limits would have to trust a
// forwarded IP header; this one trusts nothing (Cloudflare's WAF is the
// per-client layer, in front of the tunnel).
function fixedWindowLimiter({ max, windowMs, now = Date.now }) {
  let start = -Infinity;
  let count = 0;
  return function take() {
    const t = now();
    if (t - start >= windowMs) {
      start = t;
      count = 0;
    }
    count += 1;
    return count <= max;
  };
}

// A form field as a string. Repeated fields (a=1&a=2 → an array under
// extended:false) and missing ones both come back as "" — never an array or
// an object reaching an action.
function field(req, name) {
  const v = req.body && Object.hasOwn(req.body, name) ? req.body[name] : undefined;
  return typeof v === "string" ? v : "";
}

module.exports = { TRUST_PROXY, httpError, sameOriginGuard, fixedWindowLimiter, field };
