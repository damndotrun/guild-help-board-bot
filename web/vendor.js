// Vendored front-end files: no CDN, no build step (platform spec §5) — the
// deploy stays `git clone` + `npm install --omit=dev`.
//
// htmx 2.0.11 (0BSD): a byte-exact copy of dist/htmx.min.js from the npm
// package htmx.org@2.0.11. test/web-server.test.js checks both hashes; the
// page loads it with Subresource Integrity. To upgrade: replace the file,
// update version/file/sha256/integrity together (commands in CHANGES.md).
const HTMX = Object.freeze({
  version: "2.0.11",
  file: "vendor/htmx-2.0.11.min.js", // under web/public, served at /static/
  sha256: "d6fdc75f204e6bdefa99b69bf1e6d4ac69b8a364f77929f45c13476b4000f717",
  integrity: "sha384-2OatzQy1H+Zd/IIrjr1TcuDGqLXeHhbooAyJY1KdQMKnr4LZ22k31GBLdYKHmVjg",
});

// htmx hardening (research 2026-09-30), read by htmx from
// <meta name="htmx-config">: only same-origin requests, no <script> execution
// from swapped HTML, no eval (hx-on / js: are off — CSP forbids them anyway),
// no history snapshots of admin pages in localStorage, no injected <style>
// (CSP style-src 'self'; the indicator CSS lives in app.css), and swap every
// response — our error pages are full pages with a #content too, so a
// refused or failed form shows its reason instead of silently doing nothing.
const HTMX_CONFIG = JSON.stringify({
  selfRequestsOnly: true,
  allowScriptTags: false,
  allowEval: false,
  historyCacheSize: 0,
  includeIndicatorStyles: false,
  responseHandling: [
    { code: "204", swap: false },
    { code: "...", swap: true },
  ],
});

module.exports = { HTMX, HTMX_CONFIG };
