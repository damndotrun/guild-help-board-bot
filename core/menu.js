// Core /menu hub (M2 spec §3–§5). A pseudo-module named "menu" that the core
// appends to the routed modules: it owns the /menu command and the "menu:"
// customId prefix (the router's collision check keeps every other module off
// it). Home and "How it works" are core screens; "menu:<module>:<screen>[:<arg>]"
// goes to that module's menu.render. Stateless: every tap rebuilds its screen
// from fresh data and the tapper's live level.
//
// Module contract (M2 spec §5, extended):
//   menu: {
//     section(ctx, viewer) → { label, counter?, minLevel? } | null      // home row; null = hidden
//     render(interaction, ctx, viewer, screen, arg)
//       → Screen | { home: text } | { modal: ModalBuilder } | null (unknown screen)
//     guide?(viewer) → string                                           // "How it works" text
//   }
//   Screen = { crumbs, status?, notice?: { ok, text }, body, back?, after?: async () => void }
//   viewer = { userId, level }. A module's entry screen is "main". `after` is
//   the slow REST of an action the screen already committed (card, board, DM):
//   the core runs it once the tap is acknowledged — even if the ack failed or
//   the screen had to be replaced by the home screen.
const { ButtonBuilder, ButtonStyle, MessageFlags, SectionBuilder, SlashCommandBuilder } = require("discord.js");
const { buildScreenPayload, screenErrors, text, button, row, err } = require("./panel");
const { atLeast, LEVEL_LABEL } = require("./perms");

const MENU_PREFIX = "menu";
const HOME_ID = "menu:home";
const HOW_ID = "menu:home:how";
const MENU_TEXT = Object.freeze({
  unknown: "That screen isn't available anymore. Here's the menu.",
  noAccess: "You don't have access to that anymore. Here's the menu for your current role.",
  broken: "Something went wrong showing that screen. Here's the menu.",
});

const menuCommand = new SlashCommandBuilder()
  .setName("menu")
  .setDescription("Open the menu: help board, stats and more");

// "menu:home" | "menu:home:how" | "menu:<module>:<screen>[:<arg…>]" → parts; otherwise null.
function parseMenuId(customId) {
  const parts = String(customId ?? "").split(":");
  if (parts[0] !== MENU_PREFIX) return null;
  const [, target = "home", screen = "", ...rest] = parts;
  return { target, screen, arg: rest.join(":") };
}

// Only the ephemeral V2 menu message itself may be edited in place. A menu:
// button anywhere else (the public board) must open a fresh ephemeral menu —
// an update() there would turn the public message into a V2 menu for everyone,
// and the V2 flag can never be removed again.
function isMenuMessage(message) {
  const flags = message && message.flags;
  return !!(
    flags &&
    typeof flags.has === "function" &&
    flags.has(MessageFlags.Ephemeral) &&
    flags.has(MessageFlags.IsComponentsV2)
  );
}

function visibleSection(mod, ctx, viewer, log) {
  try {
    const s = mod.menu.section(ctx, viewer);
    return s && atLeast(viewer.level, s.minLevel || "member") ? s : null;
  } catch (e) {
    log.error(`[menu] ${mod.name} section failed:`, e);
    return null;
  }
}

function homeScreen({ modules, ctxFor, viewer, publicUrl, notice, log = console }) {
  const body = [];
  for (const mod of modules) {
    const s = visibleSection(mod, ctxFor(mod), viewer, log);
    if (!s) continue;
    const line = s.counter ? `**${s.label}** · ${s.counter}` : `**${s.label}**`;
    body.push(new SectionBuilder().addTextDisplayComponents(text(line)).setButtonAccessory(button(`menu:${mod.name}:main`, "Open")));
  }
  if (body.length === 0) body.push(text("Nothing here yet."));
  const links = row(button(HOW_ID, "How it works"));
  if (publicUrl && atLeast(viewer.level, "officer")) {
    links.addComponents(new ButtonBuilder().setURL(publicUrl).setLabel("Web admin").setStyle(ButtonStyle.Link));
  }
  body.push(links);
  return { crumbs: ["Menu"], status: `You: ${LEVEL_LABEL[viewer.level] || LEVEL_LABEL.member}`, notice, body };
}

function howScreen({ modules, viewer }) {
  const parts = modules.filter((m) => m.menu.guide).map((m) => m.menu.guide(viewer)).filter(Boolean);
  return { crumbs: ["Menu", "How it works"], body: [text(parts.join("\n\n") || "No guide yet.")], back: HOME_ID };
}

function createMenuModule({ modules, ctxFor, perms, publicUrl = null, log = console }) {
  const withMenu = modules.filter((m) => m.menu);
  const byName = new Map(withMenu.map((m) => [m.name, m]));
  const home = (viewer, notice) => homeScreen({ modules: withMenu, ctxFor, viewer, publicUrl, notice, log });

  async function resolve(interaction, viewer) {
    if (interaction.isChatInputCommand()) return home(viewer);
    if (!isMenuMessage(interaction.message)) return home(viewer); // e.g. the board's Menu button
    const id = parseMenuId(interaction.customId);
    if (!id) return home(viewer, err(MENU_TEXT.unknown));
    if (id.target === "home") {
      if (id.screen === "") return home(viewer);
      if (id.screen === "how") return howScreen({ modules: withMenu, viewer });
      return home(viewer, err(MENU_TEXT.unknown));
    }
    const mod = byName.get(id.target);
    if (!mod) return home(viewer, err(MENU_TEXT.unknown));
    const ctx = ctxFor(mod);
    // Permission again on every tap: the role may have changed since the screen was drawn.
    if (!visibleSection(mod, ctx, viewer, log)) return home(viewer, err(MENU_TEXT.noAccess));
    const out = await mod.menu.render(interaction, ctx, viewer, id.screen, id.arg);
    if (!out) return home(viewer, err(MENU_TEXT.unknown));
    if (out.home) return home(viewer, err(out.home));
    return out;
  }

  async function send(interaction, payload) {
    const inPlace = { ...payload, flags: MessageFlags.IsComponentsV2 }; // an edit can't change Ephemeral
    if (interaction.deferred || interaction.replied) return interaction.editReply(inPlace);
    if (!interaction.isChatInputCommand() && isMenuMessage(interaction.message)) return interaction.update(inPlace);
    return interaction.reply(payload);
  }

  // The screen's message payload; a screen that cannot be built or breaks a
  // mobile limit is replaced by the home screen with the "went wrong" line.
  function payloadFor(interaction, out, viewer) {
    try {
      const payload = buildScreenPayload(out);
      const errors = screenErrors(out, payload);
      if (errors.length === 0) return payload;
      log.error(`[menu] invalid screen for ${interaction.customId || "/menu"}: ${errors.join("; ")}`);
    } catch (e) {
      log.error(`[menu] could not build the screen for ${interaction.customId || "/menu"}:`, e);
    }
    return buildScreenPayload(home(viewer, err(MENU_TEXT.broken)));
  }

  async function handle(interaction) {
    const viewer = { userId: interaction.user.id, level: perms.levelOfInteraction(interaction) };
    let out;
    try {
      out = await resolve(interaction, viewer);
    } catch (e) {
      log.error("[menu] render failed:", e);
      out = home(viewer, err(MENU_TEXT.broken));
    }
    if (out.modal) {
      try {
        await interaction.showModal(out.modal);
      } catch (e) {
        log.error("[menu] could not show the modal:", e);
      }
      return;
    }
    try {
      await send(interaction, payloadFor(interaction, out, viewer));
    } catch (e) {
      // e.g. the ephemeral message is gone — the action was already committed, so `after` still runs.
      log.error("[menu] could not answer the interaction:", e);
    }
    if (typeof out.after === "function") {
      try {
        await out.after();
      } catch (e) {
        log.error("[menu] follow-up work failed:", e);
      }
    }
  }

  return {
    name: MENU_PREFIX,
    aliases: [],
    dataFile: null,
    commands: [menuCommand.toJSON()],
    handle,
    bind: null,
    onReady: null,
    jobs: [],
    managerRoles: null,
    menu: null,
  };
}

module.exports = { MENU_PREFIX, HOME_ID, HOW_ID, MENU_TEXT, parseMenuId, isMenuMessage, homeScreen, howScreen, createMenuModule };
