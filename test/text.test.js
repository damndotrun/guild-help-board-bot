"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hasUnprintable, PLAIN_TEXT_ERROR, BIDI_CONTROLS } = require("../core/text");
const help = require("../modules/help/help");

test("core/text: control and bidi-control characters are unprintable; ordinary text, emoji and accents are not", () => {
  // control and bidi characters built from code points (test/actions.test.js pattern) — never literal in source
  const cp = (n) => String.fromCodePoint(n);
  for (const bad of ["a\nb", "tab\there", `nul${cp(0)}`, `del${cp(0x7f)}`, `c1${cp(0x85)}`, `rlo${cp(0x202e)}`, `lri${cp(0x2066)}`, `pdi${cp(0x2069)}`]) {
    assert.equal(hasUnprintable(bad), true, JSON.stringify(bad));
  }
  for (const good of ["", "Dani's search", "BASIC · SUP 💥", "árvíztűrő tükörfúrógép", "300+ #1 (now)", null, undefined]) {
    assert.equal(hasUnprintable(good), false, JSON.stringify(good));
  }
  assert.deepEqual(BIDI_CONTROLS, [[0x202a, 0x202e], [0x2066, 0x2069]]);
});

test("core/text: help keeps exporting the very same guard and error text", () => {
  assert.equal(help.hasUnprintable, hasUnprintable);
  assert.equal(help.PLAIN_TEXT_ERROR, PLAIN_TEXT_ERROR);
  assert.equal(PLAIN_TEXT_ERROR, "Use letters, numbers and punctuation only.");
});
