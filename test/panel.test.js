"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ButtonStyle, ComponentType, EmbedBuilder, MessageFlags, SectionBuilder } = require("discord.js");
const { text, button, row, select, ok, err, buildScreenPayload, screenErrors, textFromEmbed, walk } = require("../core/panel");

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
    [{ body: [{ type: ComponentType.TextDisplay, content: "x".repeat(4001) }] }, /text characters/],
    [{ body: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.StringSelect, custom_id: "menu:s", options: Array.from({ length: 26 }, (_, n) => ({ label: `o${n}`, value: `v${n}` })) }] }] }, /26 options/],
    [{ body: [row(button("menu:dup", "A")), row(button("menu:dup", "B"))] }, /duplicate customId "menu:dup"/],
  ];
  for (const [patch, re] of cases) {
    const errors = screenErrors({ crumbs: ["Menu", "Test"], body: [], back: "menu:home", ...patch });
    assert.ok(errors.some((e) => re.test(e)), `${re} not reported: ${JSON.stringify(errors)}`);
  }
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
