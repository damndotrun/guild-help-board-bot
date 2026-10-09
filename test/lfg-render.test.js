"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ButtonStyle, ComponentType, MessageFlags } = require("discord.js");
const { messageErrors, walk } = require("../core/panel");
const R = require("../modules/lfg/render");
const S = require("../modules/lfg/state");
const { T0, MIN, dataWith, listing, request } = require("./fixtures/lfg-fakes");

const valid = (payload) => assert.deepEqual(messageErrors(payload, { prefixes: R.PREFIXES }), []);
function all(payload, type) {
  const out = [];
  walk(payload, (c) => { if (c.type === type) out.push(c); });
  return out;
}
const textOf = (payload) => all(payload, ComponentType.TextDisplay).map((c) => c.content).join("\n");
const ids = (payload) => { const out = []; walk(payload, (c) => { if (c.custom_id) out.push(c.custom_id); }); return out; };
const accents = (payload) => payload.components.filter((c) => c.type === ComponentType.Container).map((c) => c.accent_color);
const ts = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

// ── board ──────────────────────────────────────────────────────────────────

test("board: empty → one grey box", () => {
  const p = R.renderBoard(dataWith(), T0);
  valid(p);
  assert.equal(p.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(accents(p), [R.COLORS.grey]);
  assert.equal(textOf(p), "No one is looking right now.");
});

test("board: Just started · Fixed · Timed · Now in that order and colour, badges, Join rows", () => {
  const d = dataWith((x) => {
    x.listings.push(listing("NOW", "u1", { posterName: "Dani *bold*", note: "need 1 _fast_", requests: [request("u9"), request("u8")] }));
    x.listings.push(listing("TIM", "u2", { posterName: "Marci", startAt: T0 + 20 * MIN, expiresAt: T0 + 20 * MIN, categoryId: "ddps", buttonId: "radar" }));
    x.listings.push(listing("FIX", "u3", { posterName: "Ann", state: "fixed", joinerId: "u4", startAt: T0 + 60 * MIN, requests: [request("u4", T0, { status: "accepted", userName: "Bob" })] }));
    x.listings.push(listing("CON", "u5", { posterName: "Cy", state: "confirming", joinerId: "u6", acceptedAt: T0, requests: [request("u6", T0, { status: "accepted", userName: "Di" })], checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, at: {}, nags: {} } }));
    x.listings.push(listing("STA", "u7", { posterName: "Ed", state: "started", joinerId: "u0", startedAt: T0, requests: [request("u0", T0, { status: "accepted", userName: "Flo" })] }));
  });
  const p = R.renderBoard(d, T0);
  valid(p);
  assert.deepEqual(accents(p), [R.COLORS.grey, R.COLORS.slate, R.COLORS.amber, R.COLORS.teal]);
  const badges = all(p, ComponentType.Button).filter((b) => b.disabled).map((b) => [b.custom_id, b.label, b.style]);
  assert.deepEqual(badges, [["lfg:badge:started", "1", ButtonStyle.Secondary], ["lfg:badge:fixed", "2", ButtonStyle.Secondary], ["lfg:badge:timed", "1", ButtonStyle.Secondary], ["lfg:badge:now", "1", ButtonStyle.Secondary]]);
  assert.deepEqual(ids(p).filter((id) => id.startsWith("lfg:join:")), ["lfg:join:TIM", "lfg:join:NOW"]);
  const t = textOf(p);
  assert.match(t, /### Just started/);
  assert.match(t, new RegExp(`\\*\\*BASIC · SUP\\*\\* · \\*\\*Ed\\*\\* \\+ \\*\\*Flo\\*\\*\\n-# started ${ts(T0)}`));
  assert.match(t, new RegExp(`\\*\\*Ann\\*\\* \\+ \\*\\*Bob\\*\\*\\n-# starts ${ts(T0 + 60 * MIN)}`));
  assert.match(t, /\*\*Cy\*\* \+ \*\*Di\*\*\n-# waiting for both to confirm/);
  assert.match(t, new RegExp(`🧬 \\*\\*DDPS · RADAR\\*\\* · \\*\\*Marci\\*\\*\\n-# ${ts(T0 + 20 * MIN)}`));
  assert.ok(t.includes("💥 **BASIC · SUP** · **Dani \\*bold\\***\n-# now · 2 interested · need 1 \\_fast\\_"), t);
  for (const b of all(p, ComponentType.Button)) assert.equal(b.style, ButtonStyle.Secondary);
});

test("board: too many open searches → as many Join rows as fit, then “+N more”; ≤ 40 components", () => {
  const d = dataWith((x) => {
    for (let i = 0; i < 20; i++) x.listings.push(listing(`N${i}`, `p${i}`, { createdAt: T0 + i }));
    for (let i = 0; i < 5; i++) x.listings.push(listing(`T${i}`, `q${i}`, { startAt: T0 + (i + 1) * MIN, expiresAt: T0 + (i + 1) * MIN }));
    x.listings.push(listing("F", "f1", { state: "fixed", joinerId: "f2", startAt: T0 + 60 * MIN }));
    x.listings.push(listing("S", "s1", { state: "started", joinerId: "s2", startedAt: T0 }));
  });
  const p = R.renderBoard(d, T0);
  valid(p);
  // Now rows fill the room first (they start soonest), the rest is counted per box.
  assert.deepEqual(ids(p).filter((id) => id.startsWith("lfg:join:")), ["lfg:join:N0", "lfg:join:N1", "lfg:join:N2", "lfg:join:N3", "lfg:join:N4", "lfg:join:N5"]);
  assert.ok(textOf(p).includes("-# +5 more — open /menu › Browse")); // Timed
  assert.ok(textOf(p).includes("-# +14 more — open /menu › Browse")); // Now
  let count = 0;
  walk(p, () => { count += 1; });
  assert.ok(count <= 40, String(count));
});

test("panel: grey box, Start my own search beside the text, a toggle role picker of the roles that still exist", () => {
  const d = dataWith();
  const p = R.renderPanel(d.config, (id) => id !== "r-dps");
  valid(p);
  assert.deepEqual(accents(p), [R.COLORS.grey]);
  const [sec, picker] = p.components[0].components;
  assert.equal(sec.accessory.custom_id, "lfg:start");
  assert.equal(sec.accessory.label, "Start my own search");
  assert.equal(textOf(p), "### Want a game?\n-# Start a search, or pick roles to get pinged.");
  const select = picker.components[0];
  assert.match(select.custom_id, /^lfg:roles:[0-9a-z]+$/);
  assert.deepEqual([select.min_values, select.max_values], [1, 3]);
  // a fresh custom_id on every render (PR #5 bug class: a re-sent identical select freezes)
  const again = R.renderPanel(d.config, (id) => id !== "r-dps").components[0].components[1].components[0];
  assert.notEqual(again.custom_id, select.custom_id);
  assert.match(R.renderPanel(d.config, () => true, "fixed1").components[0].components[1].components[0].custom_id, /^lfg:roles:fixed1$/);
  assert.deepEqual(select.options.map((o) => [o.label, o.value, o.emoji.name]), [["BASIC · SUP", "r-sup", "💥"], ["DDPS · RADAR", "r-radar", "🧬"], ["DDPS · HACK", "r-hack", "🧬"]]);
  assert.equal(R.renderPanel(d.config, () => false).components[0].components.length, 1); // nothing to pick → no picker
});

test("banner and ping", () => {
  const b = R.renderBanner({ type: "banner", imageUrl: "https://example.com/b.png" });
  valid(b);
  assert.deepEqual(b.components, [{ type: ComponentType.MediaGallery, items: [{ media: { url: "https://example.com/b.png" } }] }]);
  const d = dataWith();
  const now = R.renderPing(d.config, listing("L1", "u1", { posterName: "Dani", buttonId: "sup" }), ["r-sup"]);
  assert.deepEqual(now, { content: "<@&r-sup> **Dani** is looking for **BASIC · SUP** · now", allowedMentions: { roles: ["r-sup"] } });
  const timed = R.renderPing(d.config, listing("L2", "u1", { posterName: "Dani", categoryId: "ddps", buttonId: "any", startAt: T0 + 5 * MIN }), ["r-radar", "r-hack"]);
  assert.equal(timed.content, `<@&r-radar> <@&r-hack> **Dani** is looking for **DDPS · ANY** · ${ts(T0 + 5 * MIN)}`);
});

// ── thread ─────────────────────────────────────────────────────────────────

test("request panel: Requests with Accept while open, Removed with reasons, red Cancel search", () => {
  const L = listing("L1", "u1", {
    requests: [
      request("u2", T0 + 1, { userName: "Zed" }),
      request("u3", T0 + 2, { userName: "Ann", status: "withdrawn", reason: "matched_elsewhere" }),
      request("u4", T0 + 3, { userName: "Bob" }),
      request("u5", T0 + 4, { userName: "Cy", status: "closed", reason: "no_confirm" }),
    ],
  });
  const p = R.renderRequestPanel(dataWith(), L, T0);
  valid(p);
  assert.deepEqual(accents(p), [R.COLORS.teal, R.COLORS.grey]);
  assert.deepEqual(ids(p), ["lfg:badge:requests", "lfg:accept:L1:u2", "lfg:accept:L1:u4", "lfg:badge:removed", "lfg:cancel:L1"]);
  const t = textOf(p);
  assert.match(t, new RegExp(`\\*\\*1 · Zed\\*\\*\\n-# asked ${ts(T0 + 1)}`));
  assert.match(t, /\*\*2 · Bob\*\*/);
  assert.match(t, /Ann — joined another game\nCy — didn't confirm/);
  const cancel = p.components.at(-1).components[0];
  assert.deepEqual([cancel.label, cancel.style], ["Cancel search", ButtonStyle.Danger]);
});

test("request panel: confirming → accepted row + on-hold rows, no Accept; started → no Cancel search; empty → a hint", () => {
  const L = listing("L1", "u1", { state: "confirming", joinerId: "u2", requests: [request("u2", T0, { status: "accepted", userName: "Zed" }), request("u3", T0 + 1, { onHold: true, userName: "Ann" })] });
  const p = R.renderRequestPanel(dataWith(), L, T0);
  valid(p);
  assert.match(textOf(p), /\*\*1 · Zed\*\*\n-# accepted — confirming\n\*\*2 · Ann\*\*\n-# on hold/);
  assert.equal(ids(p).some((id) => id.startsWith("lfg:accept:")), false);
  L.state = "started";
  assert.equal(ids(R.renderRequestPanel(dataWith(), L, T0)).includes("lfg:cancel:L1"), false);
  const empty = R.renderRequestPanel(dataWith(), listing("L2", "u1"), T0);
  assert.match(textOf(empty), /No requests yet/);
});

test("request panel: a long line is cut to fit with “+N more waiting”", () => {
  const L = listing("L1", "u1", { requests: Array.from({ length: 20 }, (_, i) => request(`u${i}`, T0 + i)) });
  const p = R.renderRequestPanel(dataWith(), L, T0);
  valid(p);
  const accepts = ids(p).filter((id) => id.startsWith("lfg:accept:")).length;
  assert.ok(accepts >= 8 && accepts < 20, String(accepts));
  assert.ok(textOf(p).includes(`+${20 - accepts} more waiting`));
});

function confirmingListing(at = {}) {
  return listing("L1", "u1", {
    posterName: "Dani",
    state: "confirming",
    joinerId: "u2",
    acceptedAt: T0,
    threadId: "th1",
    checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: null, at, nags: {} },
    requests: [request("u2", T0, { status: "accepted", userName: "Marci" }), request("u3", T0 + 1, { onHold: true, userName: "Ann" })],
  });
}

test("welcome: WAKEY pings only the searcher; the amber Confirm box shows who tapped and I'm here (green)", () => {
  const d = dataWith();
  const p = R.buildWelcome(d, confirmingListing({ u1: T0 }));
  valid(p);
  assert.deepEqual(p.allowedMentions, { users: ["u1"] });
  const t = textOf(p);
  assert.match(t, /^WAKEY-WAKEY! <@u1> you accepted \*\*Marci\*\* for \*\*BASIC · SUP\*\*\./);
  assert.match(t, /\*\*Dani\*\* ✓ · \*\*Marci\*\* — not yet/);
  assert.match(t, new RegExp(`On hold until you both confirm: \\*\\*Ann\\*\\* · ends ${ts(T0 + 5 * MIN)}`));
  assert.deepEqual(all(p, ComponentType.Button).filter((b) => !b.disabled).map((b) => [b.custom_id, b.label, b.style]), [["lfg:here:L1", "I'm here", ButtonStyle.Success]]);
  assert.equal(all(p, ComponentType.Button).find((b) => b.disabled).label, "1 / 2");
  assert.deepEqual(accents(p), [R.COLORS.amber]);
  const ping = R.buildWelcome(d, confirmingListing(), undefined, { pingJoiner: true });
  assert.deepEqual(ping.allowedMentions, { users: ["u1", "u2"] });
  assert.match(textOf(ping), /you accepted <@u2>/);
});

test("welcome: fixed → wait text without a button; started → ✓ Game on in teal", () => {
  const d = dataWith();
  const fixed = confirmingListing();
  fixed.state = "fixed";
  fixed.startAt = T0 + 60 * MIN;
  const p = R.buildWelcome(d, fixed);
  valid(p);
  assert.match(textOf(p), new RegExp(`asked to confirm 5 minutes before the start \\(${ts(T0 + 60 * MIN)}\\)`));
  assert.equal(ids(p).some((id) => id.startsWith("lfg:here:")), false);
  const started = confirmingListing({ u1: T0, u2: T0 });
  started.state = "started";
  const s = R.buildWelcome(d, started);
  assert.match(textOf(s), /✓ Game on/);
  assert.equal(all(s, ComponentType.Button).find((b) => b.disabled).label, "2 / 2");
  assert.deepEqual(accents(s), [R.COLORS.teal]);
});

test("Game on! event box carries the partner's avatar; defaultAvatar follows the id", () => {
  const p = R.renderGameOn(dataWith(), confirmingListing(), { nameOf: (id, fb) => fb, avatarOf: (id) => `https://cdn/${id}.png` });
  valid(p);
  const sec = p.components[0].components[0];
  assert.deepEqual(sec.accessory, { type: ComponentType.Thumbnail, media: { url: "https://cdn/u2.png" } });
  assert.match(textOf(p), /### Game on!\n-# \*\*Dani\*\* \+ \*\*Marci\*\* · BASIC · SUP · good luck/);
  assert.equal(R.defaultAvatar("175928847299117063"), `https://cdn.discordapp.com/embed/avatars/${Number((175928847299117063n >> 22n) % 6n)}.png`);
  assert.equal(R.defaultAvatar("not-a-number"), "https://cdn.discordapp.com/embed/avatars/0.png");
});

// ── DM card ────────────────────────────────────────────────────────────────

function cardFor(d, userId) {
  const view = S.cardView(d, userId, T0);
  const p = R.renderCard(d, userId, view);
  if (p) valid(p);
  return p;
}

test("card: one request → “Your request” with its own Cancel, no Cancel all, no event box; Still open joins", () => {
  const d = dataWith((x) => {
    x.listings.push(listing("A", "p1", { posterName: "Marci", requests: [request("u9"), request("u1", T0 + 1)] }));
    x.listings.push(listing("B", "p2", { posterName: "Dani" }));
  });
  const p = cardFor(d, "u1");
  assert.deepEqual(accents(p), [R.COLORS.slate, R.COLORS.teal]);
  assert.match(textOf(p), new RegExp(`### Your request\\n💥 \\*\\*BASIC · SUP\\*\\* · \\*\\*Marci\\*\\*\\n-# waiting · you're #2 · now`));
  assert.deepEqual(ids(p), ["lfg:badge:requests", "lfg:withdraw:A", "lfg:badge:open", "lfg:join:B", "lfg:start"]);
});

test("card: 2+ requests → Cancel all; on hold line; a bad-news event box in red with the searcher's avatar", () => {
  const d = dataWith((x) => {
    x.listings.push(listing("A", "p1", { requests: [request("u1")] }));
    x.listings.push(listing("B", "p2", { state: "fixed", joinerId: "u8", requests: [request("u8", T0, { status: "accepted" }), request("u1", T0 + 1, { onHold: true })] }));
    x.dmCards.u1 = { messageId: "m", sentAt: T0, lastEventAt: T0, event: { kind: "full", listingId: "Z", aboutId: "p3", aboutName: "Marci", label: "DDPS · HACK", emoji: "🧬", startAt: null, at: T0 } };
  });
  const p = cardFor(d, "u1");
  assert.deepEqual(accents(p), [R.COLORS.red, R.COLORS.slate]);
  const t = textOf(p);
  assert.match(t, /### Marci's game is full\n-# 🧬 DDPS · HACK · now — someone else got the spot\./);
  assert.match(t, /### Your requests/);
  assert.match(t, /on hold — you're next if it falls through/);
  assert.equal(p.components[0].components[0].accessory.type, ComponentType.Thumbnail);
  assert.deepEqual(ids(p).slice(-2), ["lfg:start", "lfg:withdrawall"]);
});

test("card: accepted and confirming → You're in! + Confirm box with I'm here and Open the thread", () => {
  const d = dataWith((x) => x.listings.push(confirmingListing({ u1: T0 })));
  const p = cardFor(d, "u2");
  assert.deepEqual(accents(p), [R.COLORS.teal, R.COLORS.amber]);
  const t = textOf(p);
  assert.match(t, /### You're in!\n-# 💥 BASIC · SUP · now — \*\*Dani\*\* picked you\./);
  assert.match(t, /The game is set once you both tap I'm here/);
  const buttons = all(p, ComponentType.Button).filter((b) => !b.disabled);
  assert.deepEqual(buttons.map((b) => [b.label, b.style, b.custom_id ?? b.url]), [
    ["I'm here", ButtonStyle.Success, "lfg:here:L1"],
    ["Open the thread", ButtonStyle.Link, "https://discord.com/channels/g1/th1"],
  ]);
});

test("card: fixed → wait text + thread link; started → Game on! (+ other requests cancelled); nothing left → the empty state", () => {
  const d = dataWith((x) => x.listings.push(confirmingListing()));
  d.listings[0].state = "fixed";
  d.listings[0].startAt = T0 + 60 * MIN;
  const f = cardFor(d, "u2");
  assert.match(textOf(f), /asked to confirm 5 minutes before the start/);
  assert.deepEqual(all(f, ComponentType.Button).filter((b) => !b.disabled).map((b) => b.label), ["Open the thread"]);
  d.listings[0].state = "started";
  d.listings[0].cancelledOthers = ["u2"];
  const s = cardFor(d, "u2");
  assert.match(textOf(s), /### ✓ Game on!\n-# 💥 BASIC · SUP — with \*\*Dani\*\*\n-# Your other requests were cancelled\./);
  // B5: an emptied card is edited to its empty state (the tick deletes it 24 h later)
  const view = S.cardView(d, "u5", T0);
  assert.equal(view.empty, true);
  const e = R.renderCard(d, "u5", view);
  valid(e);
  assert.deepEqual(accents(e), [R.COLORS.grey]);
  assert.equal(textOf(e), "-# You have no open requests right now.");
  assert.deepEqual(ids(e), ["lfg:start"]);
});

test("card replaced: one line, no buttons left (A3)", () => {
  const p = R.renderCardReplaced(null);
  valid(p);
  assert.equal(p.flags, MessageFlags.IsComponentsV2);
  assert.equal(textOf(p), "This card was replaced by a newer one.");
  assert.deepEqual(all(p, ComponentType.Button), []);
});

test("request panel, closed (B2): grey, the closing line, no Accept and no Cancel search", () => {
  const L = listing("L1", "u1", { requests: [request("u2", T0, { status: "closed", reason: "expired", userName: "Zed" }), request("u3", T0 + 1, { userName: "Ann" })] });
  const p = R.renderRequestPanel(dataWith(), L, T0, undefined, { closedLine: "Search expired." });
  valid(p);
  assert.deepEqual(accents(p), [R.COLORS.grey, R.COLORS.grey]);
  assert.deepEqual(ids(p), ["lfg:badge:requests", "lfg:badge:removed"]);
  assert.match(textOf(p), /\*\*1 · Ann\*\*\n-# asked .*\n-# Search expired\./);
  assert.doesNotMatch(textOf(p), /No requests yet/);
});

test("names are escaped incl. masked links (D1); the welcome's on-hold list stops at 10 names + “+N more” (D2)", () => {
  assert.equal(R.esc("[x](https://e.com)"), "\\[x](https://e.com)");
  assert.equal(R.esc("Z_ed*"), "Z\\_ed\\*");
  const L = confirmingListing();
  L.requests = [L.requests[0], ...Array.from({ length: 13 }, (_, i) => request(`h${i}`, T0 + 1 + i, { onHold: true, userName: i === 0 ? "[x](https://e.com)" : `Held ${i}` }))];
  const p = R.buildWelcome(dataWith(), L);
  valid(p);
  const t = textOf(p);
  assert.match(t, /On hold until you both confirm: \*\*\\\[x\]\(https:\/\/e\.com\)\*\*, \*\*Held 1\*\*/);
  assert.match(t, /\*\*Held 9\*\*, \+3 more · ends/);
  assert.doesNotMatch(t, /Held 10/);
});

test("start modal: favorites that are not a list are ignored (B10)", () => {
  const d = dataWith((x) => { x.favorites.u1 = { id: "f1" }; });
  const m = R.startModal(d, "u1").toJSON();
  assert.deepEqual(m.components.map((c) => c.label), ["Looking for", "Starts in (minutes)", "Note (optional)"]);
});

// ── modal ──────────────────────────────────────────────────────────────────

test("start modal: without favorites three Labels (Looking for required); with one, Favorites + a hint line first", () => {
  const plain = R.startModal(dataWith(), "u1").toJSON();
  assert.equal(plain.custom_id, "lfg:modal");
  assert.deepEqual(plain.components.map((c) => c.type === ComponentType.Label ? c.label : c.content), ["Looking for", "Starts in (minutes)", "Note (optional)"]);
  assert.deepEqual([plain.components[0].component.custom_id, plain.components[0].component.required, plain.components[0].component.options.length], ["lookingfor", true, 6]);
  assert.deepEqual([plain.components[1].component.custom_id, plain.components[1].component.required, plain.components[2].component.max_length], ["minutes", false, 100]);
  const d = dataWith((x) => { x.favorites.u1 = [{ id: "f1", categoryId: "ddps", buttonId: "radar", minutes: 10, note: "gg" }, { id: "f2", categoryId: "x", buttonId: "y", minutes: 0, note: "" }]; });
  const fav = R.startModal(d, "u1").toJSON();
  assert.equal(fav.components.length, 5);
  assert.deepEqual(fav.components.map((c) => c.type === ComponentType.Label ? c.label : c.content), ["Favorites", "-# or a custom search", "Looking for", "Starts in (minutes)", "Note (optional)"]);
  assert.deepEqual(fav.components[0].component.options.map((o) => [o.label, o.value]), [["DDPS · RADAR · in 10 min · “gg”", "f1"]]);
  assert.equal(fav.components[0].component.required, false);
  assert.equal(fav.components[2].component.required, false);
});

test("noticeText: one 📬 line per waiting news item, names escaped", () => {
  const t = R.noticeText(null, [
    { outcome: "full", name: "Mar*ci", label: "DDPS · HACK" },
    { outcome: "accepted", name: "Dani", label: "BASIC · SUP" },
    { outcome: "noConfirm", name: "Dani", label: "BASIC · SUP" },
  ]);
  assert.equal(t, "📬 Mar\\*ci's game is full · DDPS · HACK\n📬 You're in! · BASIC · SUP\n📬 You didn't confirm in time · BASIC · SUP");
});

test("board: a search past its expiry disappears before the tick drops it", () => {
  const d = dataWith((x) => x.listings.push(listing("OLD", "u1"), listing("NEW", "u2", { expiresAt: T0 + 60 * MIN })));
  assert.deepEqual(ids(R.renderBoard(d, T0 + 30 * MIN)).filter((id) => id.startsWith("lfg:join:")), ["lfg:join:NEW"]);
  assert.equal(textOf(R.renderBoard(d, T0 + 60 * MIN)), "No one is looking right now.");
});

test("card: picked by two → the confirming game's Confirm box and I'm here; the fixed one listed below with Cancel", () => {
  const d = dataWith((x) => {
    x.listings.push(listing("A", "p1", { posterName: "Ann", state: "fixed", joinerId: "u1", acceptedAt: T0, startAt: T0 + 90 * MIN, expiresAt: T0 + 90 * MIN, requests: [request("u1", T0, { status: "accepted" })] }));
    x.listings.push(listing("B", "p2", { posterName: "Bob", state: "confirming", joinerId: "u1", acceptedAt: T0, threadId: "thB", checkIn: { openedAt: T0, deadline: T0 + 5 * MIN, nagMessageId: null, at: {}, nags: {} }, requests: [request("u1", T0, { status: "accepted" })] }));
  });
  const p = cardFor(d, "u1");
  assert.deepEqual(accents(p), [R.COLORS.teal, R.COLORS.amber, R.COLORS.slate]);
  assert.match(textOf(p), /\*\*Bob\*\* picked you/);
  assert.ok(ids(p).includes("lfg:here:B"));
  assert.match(textOf(p), new RegExp(`### Also picked you\\n💥 \\*\\*BASIC · SUP\\*\\* · \\*\\*Ann\\*\\*\\n-# accepted — starts ${ts(T0 + 90 * MIN)}`));
  assert.ok(ids(p).includes("lfg:withdraw:A"));
});

test("card: ten accepted games → the Also-picked-you list is cut to fit with “+N more”", () => {
  const d = dataWith((x) => {
    for (let i = 0; i < 10; i++) {
      x.listings.push(listing(`G${i}`, `p${i}`, { posterName: `Poster ${i}`, state: "fixed", joinerId: "u1", acceptedAt: T0 + i, startAt: T0 + (60 + i) * MIN, expiresAt: T0 + (60 + i) * MIN, threadId: `th${i}`, requests: [request("u1", T0, { status: "accepted" })] }));
    }
  });
  const view = S.cardView(d, "u1", T0);
  assert.equal(view.otherAccepted.length, 9);
  const p = cardFor(d, "u1");
  const withdraws = ids(p).filter((id) => id.startsWith("lfg:withdraw:")).length;
  assert.ok(withdraws >= 1 && withdraws < 9, String(withdraws));
  assert.ok(textOf(p).includes(`-# +${9 - withdraws} more`));
  assert.ok(ids(p).includes("lfg:badge:accepted"));
});

test("board: 40 fixed + 40 started entries → each box is cut with “+N more”, the board stays valid", () => {
  const d = dataWith((x) => {
    for (let i = 0; i < 40; i++) {
      x.listings.push(listing(`F${i}`, `f${i}`, { posterName: `Fixed poster ${i}`, state: "fixed", joinerId: `fj${i}`, startAt: T0 + (60 + i) * MIN, requests: [request(`fj${i}`, T0, { status: "accepted", userName: `Fixed joiner ${i}` })] }));
      x.listings.push(listing(`S${i}`, `s${i}`, { posterName: `Started poster ${i}`, state: "started", joinerId: `sj${i}`, startedAt: T0 - i, requests: [request(`sj${i}`, T0, { status: "accepted", userName: `Started joiner ${i}` })] }));
    }
    x.listings.push(listing("OPEN", "o1"));
  });
  const p = R.renderBoard(d, T0);
  valid(p);
  const t = textOf(p);
  assert.match(t, /-# \+\d+ more\n/);
  assert.equal(t.match(/-# \+\d+ more/g).length >= 2, true);
  assert.deepEqual(ids(p).filter((id) => id.startsWith("lfg:badge:") && id !== "lfg:badge:now"), ["lfg:badge:started", "lfg:badge:fixed"]);
  assert.deepEqual(all(p, ComponentType.Button).filter((b) => b.custom_id === "lfg:badge:started" || b.custom_id === "lfg:badge:fixed").map((b) => b.label), ["40", "40"]);
  assert.ok(ids(p).includes("lfg:join:OPEN")); // the open search is still joinable
});
