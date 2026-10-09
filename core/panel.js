// Components V2 panel toolkit for /menu screens (M2 spec §4): small builder
// shortcuts, the Screen → message payload wrapper (one accent Container:
// header, body, Back as the last row) and the mobile-limit validator. Pure —
// no interaction state, so every screen is unit-testable.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  UserSelectMenuBuilder,
} = require("discord.js");

const ACCENT = 0x5ac9a1;
const MENU_FLAGS = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;
const LIMITS = Object.freeze({
  components: 40, // per message, nested ones included
  buttonsPerRow: 3,
  buttonRows: 4, // Section accessories don't count
  label: 20,
  depth: 3, // Menu › Section › Step
  primary: 1,
  customId: 100,
  text: 4000, // all TextDisplays together
  options: 25,
});

const text = (content) => new TextDisplayBuilder().setContent(content);
const button = (customId, label, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
function select(customId, placeholder, options, { min = 1, max = 1 } = {}) {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(min)
    .setMaxValues(max)
    .addOptions(options);
}
const userSelect = (customId, placeholder) =>
  new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1);
const ok = (t) => ({ ok: true, text: t });
const err = (t) => ({ ok: false, text: t });

const toJSON = (c) => (c && typeof c.toJSON === "function" ? c.toJSON() : c);

// Line 1: breadcrumbs. Line 2: status. Line 3: the success / error line.
function headerText({ crumbs, status, notice }) {
  const lines = [`**${crumbs.join(" › ")}**`];
  if (status) lines.push(status);
  if (notice) lines.push(`${notice.ok ? "✅" : "⚠️"} ${notice.text}`);
  return lines.join("\n");
}

function buildScreenPayload(screen) {
  const components = [
    { type: ComponentType.TextDisplay, content: headerText(screen) },
    ...(screen.body || []).map(toJSON),
  ];
  if (screen.back) components.push(toJSON(row(button(screen.back, "← Back"))));
  return { flags: MENU_FLAGS, components: [{ type: ComponentType.Container, accent_color: ACCENT, components }] };
}

function walk(payload, fn) {
  const visit = (c) => {
    fn(c);
    for (const child of c.components || []) visit(child);
    if (c.accessory) visit(c.accessory);
  };
  for (const c of payload.components || []) visit(c);
}

// A V2 message carries no content / embeds and must have the V2 flag.
function v2FlagErrors(payload, what) {
  const errors = [];
  if (payload.content != null) errors.push(`content must not be set on a V2 ${what}`);
  if (payload.embeds != null) errors.push(`embeds must not be set on a V2 ${what}`);
  if ((payload.flags & MessageFlags.IsComponentsV2) === 0) errors.push("missing the IsComponentsV2 flag");
  return errors;
}

function screenErrors(screen, payload = buildScreenPayload(screen)) {
  const errors = v2FlagErrors(payload, "menu message");
  const depth = Array.isArray(screen.crumbs) ? screen.crumbs.length : 0;
  if (depth < 1 || depth > LIMITS.depth) errors.push(`depth must be 1..${LIMITS.depth} (crumbs: ${JSON.stringify(screen.crumbs)})`);
  return [...errors, ...componentErrors(payload, { prefixes: ["menu:"], maxPrimary: LIMITS.primary })];
}

// The same limits for a module's own V2 message — a public board, a thread
// panel, a DM card (M4 spec §9): ≤ 40 components, ≤ 4000 text characters,
// ≤ 3 buttons a row, ≤ 4 button rows, labels ≤ 20, unique customIds that start
// with one of `prefixes`. Public messages use no Primary button by default.
function messageErrors(payload, { prefixes, maxPrimary = 0 }) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) throw new Error("messageErrors needs the allowed customId prefixes");
  return [...v2FlagErrors(payload, "message"), ...componentErrors(payload, { prefixes, maxPrimary })];
}

function componentErrors(payload, { prefixes, maxPrimary }) {
  const errors = [];
  const wanted = prefixes.map((p) => `"${p}"`).join(" or ");
  let count = 0;
  let buttonRows = 0;
  let primary = 0;
  let textLength = 0;
  const seen = new Set();
  walk(payload, (c) => {
    count += 1;
    if (c.type === ComponentType.TextDisplay) textLength += String(c.content || "").length;
    if (c.type === ComponentType.ActionRow) {
      const buttons = (c.components || []).filter((x) => x.type === ComponentType.Button).length;
      if (buttons > 0) buttonRows += 1;
      if (buttons > LIMITS.buttonsPerRow) errors.push(`a row has ${buttons} buttons (max ${LIMITS.buttonsPerRow})`);
    }
    if (c.type === ComponentType.Button) {
      if (c.style === ButtonStyle.Primary) primary += 1;
      if (String(c.label || "").length > LIMITS.label) errors.push(`button label "${c.label}" is over ${LIMITS.label} characters`);
    }
    if (c.custom_id !== undefined) {
      if (!prefixes.some((p) => String(c.custom_id).startsWith(p))) errors.push(`customId "${c.custom_id}" does not start with ${wanted}`);
      if (String(c.custom_id).length > LIMITS.customId) errors.push(`customId "${c.custom_id}" is over ${LIMITS.customId} characters`);
      if (seen.has(c.custom_id)) errors.push(`duplicate customId "${c.custom_id}"`);
      seen.add(c.custom_id);
    }
    if (Array.isArray(c.options) && c.options.length > LIMITS.options) {
      errors.push(`a select has ${c.options.length} options (max ${LIMITS.options})`);
    }
  });
  if (count > LIMITS.components) errors.push(`${count} components (max ${LIMITS.components})`);
  if (buttonRows > LIMITS.buttonRows) errors.push(`${buttonRows} button rows (max ${LIMITS.buttonRows})`);
  if (primary > maxPrimary) errors.push(`${primary} Primary buttons (max ${maxPrimary})`);
  if (textLength > LIMITS.text) errors.push(`${textLength} text characters (max ${LIMITS.text})`);
  return errors;
}

// Reuse today's embeds (stats, /help) as V2 markdown.
function textFromEmbed(embed) {
  const e = toJSON(embed);
  const parts = [];
  if (e.title) parts.push(`### ${e.title}`);
  if (e.description) parts.push(e.description);
  for (const f of e.fields || []) parts.push(`**${f.name}**\n${f.value}`);
  return parts.join("\n");
}

module.exports = {
  ACCENT,
  MENU_FLAGS,
  LIMITS,
  text,
  button,
  row,
  select,
  userSelect,
  ok,
  err,
  headerText,
  buildScreenPayload,
  walk,
  screenErrors,
  messageErrors,
  textFromEmbed,
};
