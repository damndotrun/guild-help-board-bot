"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ButtonStyle, ComponentType, EmbedBuilder, MessageFlags, SectionBuilder } = require("discord.js");
const { text, button, row, select, ok, err, headerText, buildScreenPayload, screenErrors, textFromEmbed, walk } = require("../core/panel");

const good = () => ({
  crumbs: ["Menu", "Help board"],
  status: "Season: S5 · 2 open",
  notice: ok("Kovi marked as helped."),
  body: [row(button("menu:help:needhelp", "Need help", ButtonStyle.Primary), button("menu:help:sorted", "I'm sorted"), button("menu:help:stats", "Stats"))],
  back: "menu:home",
});

test("buildScreenPayload: one accent Container — header, body, Back as the last row", () => {
  const p = buildScreenPayload(good());
  assert.equal(p.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  assert.equal("content" in p, false);
  assert.equal("embeds" in p, false);
  assert.equal(p.components.length, 1);
  const [container] = p.components;
  assert.equal(container.type, ComponentType.Container);
  const [header, ...rest] = container.components;
  assert.equal(header.type, ComponentType.TextDisplay);
  assert.equal(header.content, "**Menu › Help board**\nSeason: S5 · 2 open\n✅ Kovi marked as helped.");
  const back = rest.at(-1);
  assert.equal(back.type, ComponentType.ActionRow);
  assert.deepEqual(back.components.map((b) => [b.custom_id, b.label]), [["menu:home", "← Back"]]);
});

test("header: an error notice uses ⚠️; no status → two lines; no back → no Back row", () => {
  const p = buildScreenPayload({ crumbs: ["Menu"], notice: err("That request was already closed."), body: [text("x")] });
  const parts = p.components[0].components;
  assert.equal(parts[0].content, "**Menu**\n⚠️ That request was already closed.");
  assert.equal(parts.length, 2);
});

test("screenErrors: a well-formed screen has none; Section accessories do not count as button rows", () => {
  assert.deepEqual(screenErrors(good()), []);
  const sections = [1, 2, 3].map((n) => new SectionBuilder().addTextDisplayComponents(text(`S${n}`)).setButtonAccessory(button(`menu:s${n}:main`, "Open")));
  const rows = [1, 2, 3].map((n) => row(button(`menu:r${n}`, `R${n}`)));
  assert.deepEqual(screenErrors({ crumbs: ["Menu"], body: [...sections, ...rows], back: "menu:x" }), []);
});

test("screenErrors: every mobile limit is enforced", () => {
  const rawButton = (custom_id, label) => ({ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id, label }] });
  const cases = [
    [{ body: [row(button("menu:a", "A"), button("menu:b", "B"), button("menu:c", "C"), button("menu:d", "D"))] }, /row has 4 buttons/],
    [{ body: [1, 2, 3, 4].map((n) => row(button(`menu:r${n}`, `R${n}`))) }, /5 button rows/], // + Back = 5
    [{ body: [row(button("menu:long", "x".repeat(21)))] }, /over 20 characters/],
    [{ body: [row(button("menu:p1", "P1", ButtonStyle.Primary), button("menu:p2", "P2", ButtonStyle.Primary))] }, /2 Primary/],
    [{ body: [row(button("help:claim:1", "Claim"))] }, /does not start with "menu:"/],
    [{ body: [rawButton(`menu:${"x".repeat(96)}`, "Long")] }, /over 100 characters/],
    [{ body: Array.from({ length: 37 }, (_, n) => text(`t${n}`)) }, /41 components/],
    [{ crumbs: ["Menu", "A", "B", "C"] }, /depth/],
    [{ body: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.StringSelect, custom_id: "menu:s", options: Array.from({ length: 26 }, (_, n) => ({ label: `o${n}`, value: `v${n}` })) }] }] }, /26 options/],
    [{ body: [row(button("menu:dup", "A")), row(button("menu:dup", "B"))] }, /duplicate customId "menu:dup"/],
  ];
  for (const [patch, re] of cases) {
    const errors = screenErrors({ crumbs: ["Menu", "Test"], body: [], back: "menu:home", ...patch });
    assert.ok(errors.some((e) => re.test(e)), `${re} not reported: ${JSON.stringify(errors)}`);
  }
});

test("screenErrors: limits work correctly at exact boundary values (not just overages)", () => {
  // 20-char button label (exactly at limit)
  assert.deepEqual(screenErrors({ crumbs: ["Menu"], body: [row(button("menu:x", "x".repeat(20)))], back: "menu:y" }), []);

  // 3 crumbs (exactly at limit)
  assert.deepEqual(screenErrors({ crumbs: ["Menu", "A", "B"], body: [row(button("menu:x", "X"))], back: "menu:y" }), []);

  // 100-char customId (exactly at limit): "menu:" (5) + "x" (95) = 100
  const customIdAt100 = `menu:${"x".repeat(95)}`;
  assert.equal(customIdAt100.length, 100);
  assert.deepEqual(screenErrors({ crumbs: ["Menu"], body: [row(button(customIdAt100, "X"))], back: "menu:y" }), []);

  // 25 options (exactly at limit)
  const selectAt25 = { type: ComponentType.ActionRow, components: [{ type: ComponentType.StringSelect, custom_id: "menu:s", options: Array.from({ length: 25 }, (_, n) => ({ label: `o${n}`, value: `v${n}` })) }] };
  assert.deepEqual(screenErrors({ crumbs: ["Menu"], body: [selectAt25], back: "menu:y" }), []);

  // 40 components (exactly at limit):
  // Container (1) + Header TextDisplay (1) + 36 body TextDisplays (36) + Back ActionRow (1) + Back Button (1) = 40
  assert.deepEqual(screenErrors({ crumbs: ["Menu"], body: Array.from({ length: 36 }, (_, n) => text(`t${n}`)), back: "menu:y" }), []);

  // 4000 text characters (exactly at limit):
  // Compute body length from actual header text
  const screenAt4000 = { crumbs: ["Menu"], notice: ok("ok"), body: [], back: "menu:y" };
  const headerLen = headerText(screenAt4000).length;
  const bodyLenAt4000 = 4000 - headerLen;
  const screenAt4000Full = { ...screenAt4000, body: [text("x".repeat(bodyLenAt4000))] };
  const p = buildScreenPayload(screenAt4000Full);
  // Verify total text is exactly 4000
  assert.equal(headerLen + bodyLenAt4000, 4000, `header ${headerLen} + body ${bodyLenAt4000} should equal 4000`);
  assert.deepEqual(screenErrors(screenAt4000Full, p), []);

  // 4001 text characters (over limit):
  // Compute body length from actual header text to get exactly 4001 total
  const screenAt4001 = { crumbs: ["Menu"], notice: ok("ok"), body: [], back: "menu:y" };
  const headerLen4001 = headerText(screenAt4001).length;
  const bodyLenAt4001 = 4001 - headerLen4001;
  const screenAt4001Full = { ...screenAt4001, body: [text("x".repeat(bodyLenAt4001))] };
  const p4001 = buildScreenPayload(screenAt4001Full);
  // Verify total text is exactly 4001
  assert.equal(headerLen4001 + bodyLenAt4001, 4001, `header ${headerLen4001} + body ${bodyLenAt4001} should equal 4001`);
  const errors4001 = screenErrors(screenAt4001Full, p4001);
  assert.ok(errors4001.some((e) => /text characters/.test(e)), `text limit error not reported for 4001 chars: ${JSON.stringify(errors4001)}`);
});

test("screenErrors: content / embeds / a missing V2 flag on a payload are reported", () => {
  const p = { ...buildScreenPayload(good()), content: "hi", embeds: [], flags: MessageFlags.Ephemeral };
  const errors = screenErrors(good(), p);
  assert.ok(errors.some((e) => /content/.test(e)));
  assert.ok(errors.some((e) => /embeds/.test(e)));
  assert.ok(errors.some((e) => /IsComponentsV2/.test(e)));
});

test("walk: visits nested components and Section accessories", () => {
  const p = buildScreenPayload({ crumbs: ["Menu"], body: [new SectionBuilder().addTextDisplayComponents(text("a")).setButtonAccessory(button("menu:x:main", "Open"))] });
  const ids = [];
  walk(p, (c) => { if (c.custom_id) ids.push(c.custom_id); });
  assert.deepEqual(ids, ["menu:x:main"]);
});

test("select: min/max values and options pass through", () => {
  const s = select("menu:help:sorted", "Pick…", [{ label: "A", value: "a" }, { label: "B", value: "b" }], { max: 2 }).toJSON();
  assert.deepEqual([s.custom_id, s.min_values, s.max_values, s.options.length], ["menu:help:sorted", 1, 2, 2]);
});

test("textFromEmbed: title, description and fields as V2 markdown", () => {
  const e = new EmbedBuilder().setTitle("📊 S5 — current season").setDescription("desc").addFields({ name: "By category", value: "a\nb" }, { name: "Average wait", value: "3h" });
  assert.equal(textFromEmbed(e), "### 📊 S5 — current season\ndesc\n**By category**\na\nb\n**Average wait**\n3h");
});

// ── messageErrors: the same limits for a module's own V2 message (M4) ──
const { messageErrors } = require("../core/panel");
const V2 = MessageFlags.IsComponentsV2;
const box = (...components) => ({ type: ComponentType.Container, accent_color: 0x4f9e88, components });
const badge = (id, n) => ({ type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: id, label: String(n), disabled: true });
const header = (title, id, n) => ({ type: ComponentType.Section, components: [{ type: ComponentType.TextDisplay, content: `### ${title}` }], accessory: badge(id, n) });

test("messageErrors: a public board with lfg: and menu: ids, a badge and a thumbnail passes", () => {
  const payload = {
    flags: V2,
    components: [
      box(header("Now", "lfg:badge:now", 1), {
        type: ComponentType.Section,
        components: [{ type: ComponentType.TextDisplay, content: "**BASIC · SUP** · Dani" }],
        accessory: { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: "lfg:join:abc", label: "Join" },
      }),
      box({ type: ComponentType.Section, components: [{ type: ComponentType.TextDisplay, content: "### You're in!" }], accessory: { type: ComponentType.Thumbnail, media: { url: "https://cdn.discordapp.com/embed/avatars/0.png" } } }),
      { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: "menu:lfg:main", label: "Menu" }] },
    ],
  };
  assert.deepEqual(messageErrors(payload, { prefixes: ["lfg:", "menu:"] }), []);
});

test("messageErrors: foreign prefixes, a Primary button, content and the missing flag are reported", () => {
  const payload = {
    content: "hi",
    flags: 0,
    components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: "help:claim:1", label: "Claim" }] }],
  };
  const errors = messageErrors(payload, { prefixes: ["lfg:", "menu:"] });
  assert.ok(errors.some((e) => /does not start with "lfg:" or "menu:"/.test(e)), JSON.stringify(errors));
  assert.ok(errors.some((e) => /1 Primary buttons \(max 0\)/.test(e)), JSON.stringify(errors));
  assert.ok(errors.some((e) => /content must not be set on a V2 message/.test(e)), JSON.stringify(errors));
  assert.ok(errors.some((e) => /IsComponentsV2/.test(e)), JSON.stringify(errors));
  assert.deepEqual(messageErrors({ ...payload, content: undefined, flags: V2 }, { prefixes: ["help:"], maxPrimary: 1 }), []);
});

test("messageErrors: 41 components, 4001 characters and a duplicate id are over the limit; 40 / 4000 are not", () => {
  const texts = (n, len = 1) => Array.from({ length: n }, () => ({ type: ComponentType.TextDisplay, content: "x".repeat(len) }));
  assert.deepEqual(messageErrors({ flags: V2, components: [box(...texts(39))] }, { prefixes: ["lfg:"] }), []);
  assert.ok(messageErrors({ flags: V2, components: [box(...texts(40))] }, { prefixes: ["lfg:"] }).some((e) => /41 components/.test(e)));
  assert.deepEqual(messageErrors({ flags: V2, components: [box(...texts(4, 1000))] }, { prefixes: ["lfg:"] }), []);
  assert.ok(messageErrors({ flags: V2, components: [box(...texts(4, 1000), ...texts(1))] }, { prefixes: ["lfg:"] }).some((e) => /4001 text characters/.test(e)));
  const dup = box(header("A", "lfg:badge:x", 1), header("B", "lfg:badge:x", 2));
  assert.ok(messageErrors({ flags: V2, components: [dup] }, { prefixes: ["lfg:"] }).some((e) => /duplicate customId "lfg:badge:x"/.test(e)));
});

test("messageErrors: refuses to run without the allowed prefixes", () => {
  assert.throws(() => messageErrors({ flags: V2, components: [] }, { prefixes: [] }), /prefixes/);
});
