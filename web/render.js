// Template rendering for the web admin. EJS, `<%= %>` (escaped) everywhere;
// `<%- %>` only for HTML this code rendered itself (a page fragment inside the
// layout, an include).
//
// The rule against EJS option injection: every template gets exactly two
// locals, `layout` and `page`, built by our own code — request data never
// becomes a top-level local — and the options object is ALWAYS passed
// explicitly. With an explicit options argument EJS never reads options
// (delimiter, client, escapeFunction, …) out of the data object; without it,
// it does (test/web-server.test.js pins this). We never use res.render(): it
// merges app.locals/res.locals into the data and calls EJS without options.
const ejs = require("ejs");

const RENDER_OPTIONS = Object.freeze({ cache: true, rmWhitespace: false });

// → Promise<string>
function renderView(file, { layout = null, page = null } = {}) {
  return ejs.renderFile(file, { layout, page }, { ...RENDER_OPTIONS });
}

module.exports = { RENDER_OPTIONS, renderView };
