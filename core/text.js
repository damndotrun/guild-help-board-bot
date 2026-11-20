// Text guards every module shares (moved out of modules/help/help.js in M4).
// Names and notes shown in Discord-rendered text: control characters (\p{Cc}:
// NUL, newline, tab, DEL, C1) and the bidi embedding/override/isolate controls
// (U+202A–U+202E, U+2066–U+2069) could garble a board or spoof the text around
// them, so they are refused. One error text for every surface (slash, /menu,
// modal, web).
// The bidi controls as code-point ranges — never as literal characters in this
// source (an invisible bidi character in source is itself a Trojan-Source hazard).
const BIDI_CONTROLS = [[0x202a, 0x202e], [0x2066, 0x2069]];
const PLAIN_TEXT_ERROR = "Use letters, numbers and punctuation only.";

function hasUnprintable(text) {
  for (const ch of String(text ?? "")) {
    const c = ch.codePointAt(0);
    if (/\p{Cc}/u.test(ch) || BIDI_CONTROLS.some(([lo, hi]) => c >= lo && c <= hi)) return true;
  }
  return false;
}

module.exports = { BIDI_CONTROLS, PLAIN_TEXT_ERROR, hasUnprintable };
