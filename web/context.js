// What a module's web.routes(router, web) receives: its own platform ctx
// (client, log, perms, config, store?) plus the web helpers every page needs.
// Patterns (M2 spec §6): a GET only reads; a POST calls the module's action
// function, then answers with a 303 redirect to a page that shows ONE notice
// line (success or the action's own error text), and runs the action's
// `effects` after the response — the same order as the Discord paths.
const path = require("node:path");
const { atLeast } = require("../core/perms");
const { httpError, field } = require("./security");
const session = require("./session");

const CONFIRM_VIEW = path.join(__dirname, "views", "confirm.ejs");
// A confirmation page older than this is refused and shown again — the same
// window as the Discord /reset confirmation (help RESET_CONFIRM_TTL_MS).
const CONFIRM_TTL_MS = 5 * 60 * 1000;

const NEED = Object.freeze({
  officer: "This page is for officers and owners.",
  owner: "Only members with Manage Server can change bot settings.",
});

const CHANGED = "Already done or changed — nothing happened.";

// Form fields the confirmation page adds itself; a spec's own `fields` must
// not reuse them (a duplicate name would reach the server as an array, which
// field() reads as "" — the confirmation could then never succeed).
const CONTROL_FIELDS = Object.freeze(["confirm", "issued", "guard"]);

function createWebCtx({ ctx, sendPage, access, now, runAfter }) {
  // Fresh = issued by this server within the TTL, not in the future.
  function fresh(issuedRaw) {
    if (!/^\d{1,16}$/.test(issuedRaw)) return false;
    const issued = Number(issuedRaw);
    const t = now();
    return issued <= t && t - issued <= CONFIRM_TTL_MS;
  }

  return {
    ...ctx,
    now,
    field,

    // Router middleware: 403 page below `min` (the nav hides the link too, and
    // the server mounts each nav item's minLevel as a gate on its path — this
    // is for a route that needs more than its path implies).
    requireLevel(min) {
      return (req, res, next) => (atLeast(req.viewer.level, min) ? next() : next(httpError(403, NEED[min] || NEED.officer)));
    },

    // The actor the module's action functions take.
    actor(req) {
      return { userId: req.viewer.userId, displayName: req.viewer.displayName, level: req.viewer.level };
    },

    // Render a page fragment (it sees only `page`) inside the layout.
    render(req, res, { title, file, page = {}, status = 200 }) {
      return sendPage(req, res, { title, file, page, status });
    },

    // Finish a POST: remember the notice, 303 to `to`, then run `effects`
    // (after the response has been handed to the socket, never before).
    done(req, res, to, notice, effects = null) {
      session.setNotice(req, notice);
      res.redirect(303, to);
      if (typeof effects === "function") runAfter(effects);
    },

    // Confirmation step of a dangerous POST (Start new season, Reset season,
    // Archive). true = confirmed on a fresh confirmation page: go ahead.
    // Otherwise a response has been sent (the confirmation page on the first
    // time or when it was too old; a notice + redirect when the state moved
    // on) and nothing may change: return.
    // spec = { title, lines: [string], action, fields: { name: value },
    //          confirmLabel, cancelHref, guard? }
    // `guard` is a string (or number) describing the state the confirmation
    // is about — e.g. the season id + startedTs, or a category's state. The
    // handler computes it from FRESH data on every call; it rides along in
    // the form, and on the confirming POST it must equal the value computed
    // again just now. So a replay (back button, second tab, double click)
    // after the destructive action has already changed that state is refused
    // instead of running twice. The check and the action need no `await`
    // between them: call the action right after `confirmed` returns true.
    async confirmed(req, res, spec) {
      const extra = Object.keys(spec.fields || {}).find((name) => CONTROL_FIELDS.includes(name));
      if (extra) throw new Error(`web.confirmed: "${extra}" is a reserved confirmation field name`);
      const guard = spec.guard == null ? "" : String(spec.guard);
      const asked = field(req, "confirm") === "yes";
      if (asked && fresh(field(req, "issued"))) {
        if (field(req, "guard") === guard) return true;
        session.setNotice(req, { ok: false, text: CHANGED });
        res.redirect(303, spec.cancelHref);
        return false;
      }
      await sendPage(req, res, {
        title: spec.title,
        file: CONFIRM_VIEW,
        page: { ...spec, guard, expired: asked, issued: String(now()) },
      });
      return false;
    },

    // Levels are cached for 60 s; after a manager-role change, drop them so
    // the change applies on everyone's next request.
    forgetLevels() {
      access.clear();
    },
  };
}

module.exports = { CONFIRM_TTL_MS, CHANGED, createWebCtx };
