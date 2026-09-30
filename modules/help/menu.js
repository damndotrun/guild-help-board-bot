// The help board's /menu section (M2 spec §3.1): the home-screen row, the
// "How it works" text and every "menu:help:<screen>[:<arg>]" screen. Screens
// are rebuilt from fresh data on every tap; every write goes through ./actions
// (the same functions the slash commands call), and its slow REST is returned
// as `after`, which the core runs once the tap is acknowledged.
const { ButtonStyle, LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const help = require("./help");
const actions = require("./actions");
const { atLeast, LEVEL_LABEL } = require("../../core/perms");
const { MENU_TEXT, HOME_ID } = require("../../core/menu");
const { button, row, select, textFromEmbed, ok, err } = require("../../core/panel");

const MAIN_ID = "menu:help:main";
const crumbs = (step) => (step ? ["Menu", "Help board", step] : ["Menu", "Help board"]);

// The actor the shared actions receive, from the core-computed viewer.
function actorOf(interaction, viewer) {
  return {
    userId: viewer.userId,
    displayName: interaction.member?.displayName || interaction.user.username,
    level: viewer.level,
  };
}

function openCount(data) {
  return data.entries.filter((e) => !e.done).length;
}

function section() {
  return { label: "Help board", counter: `${openCount(help.loadData())} open` };
}

function guide() {
  return textFromEmbed(help.howItWorksEmbed());
}

// The Help board screen. `noteFor` adds the one-tap "Add note" button for the
// request the viewer just posted.
function mainScreen(viewer, { notice, noteFor } = {}) {
  const data = help.loadData();
  const body = [
    row(
      button("menu:help:needhelp", "Need help", ButtonStyle.Primary),
      button("menu:help:sorted", "I'm sorted"),
      button("menu:help:stats", "Stats")
    ),
  ];
  if (noteFor) body.push(row(button(`menu:help:note:${noteFor}`, "Add note")));
  return {
    crumbs: crumbs(),
    status: `Season: ${help.seasonLabel(data.currentSeason)} · ${openCount(data)} open · ${LEVEL_LABEL[viewer.level]}`,
    notice,
    body,
    back: HOME_ID,
  };
}

// The action already wrote to data.json, so its `after` (request card, board
// refresh) must run no matter what: if the result screen cannot be built, a
// bare confirmation takes its place instead of the core's "went wrong" home.
function committed(ctx, build, notice, after) {
  let screen;
  try {
    screen = build();
  } catch (e) {
    ctx.log.error("[menu] could not build the screen after a saved change:", e);
    screen = { crumbs: crumbs(), notice, body: [], back: HOME_ID };
  }
  return { ...screen, after };
}

function categoryPicker(notice) {
  const options = help.categorySelectOptions(help.loadData());
  if (options.length === 0) return null;
  return {
    crumbs: crumbs("Need help"),
    status: "Pick what you need help with — your request is posted right away.",
    notice,
    body: [row(select("menu:help:needhelp", "What do you need help with?", options))],
    back: MAIN_ID,
  };
}

// Tap-first: picking the category creates the request; the note is optional, after.
function needhelp({ interaction, viewer, ctx }) {
  if (interaction.isStringSelectMenu()) {
    const r = actions.needHelp(ctx, actorOf(interaction, viewer), {
      categoryId: interaction.values[0],
      channelId: interaction.channelId,
    });
    if (r.ok) {
      const notice = ok(`Request posted: ${r.category.emoji} ${r.category.label}`);
      return committed(ctx, () => mainScreen(viewer, { notice, noteFor: r.entry.id }), notice, r.effects);
    }
    if (r.code === "invalid") {
      // The category was archived since the list was drawn — show the current list.
      const picker = categoryPicker(err("That category isn't available anymore. Here's the current list."));
      if (picker) return picker;
    }
    return mainScreen(viewer, { notice: err(r.error) });
  }
  return categoryPicker() || mainScreen(viewer, { notice: err("No categories are set up yet — ask an admin.") });
}

function ownOpenEntry(viewer, entryId) {
  return help.loadData().entries.find((e) => e.id === entryId && e.userId === viewer.userId && !e.done);
}

function note({ viewer, arg }) {
  const entry = ownOpenEntry(viewer, arg);
  if (!entry) return mainScreen(viewer, { notice: err("That request was already closed.") });
  const input = new TextInputBuilder()
    .setCustomId("note")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(actions.MAX_NOTE)
    .setRequired(true)
    .setPlaceholder("e.g. 3 more hammers needed");
  // An older /needhelp note can be longer than the modal allows — Discord would
  // reject the whole modal, so only prefill what fits.
  if (entry.note && entry.note.length <= actions.MAX_NOTE) input.setValue(entry.note);
  return {
    modal: new ModalBuilder()
      .setCustomId(`menu:help:notesave:${entry.id}`)
      .setTitle("Add a note")
      .addLabelComponents(new LabelBuilder().setLabel("Note for the officers").setTextInputComponent(input)),
  };
}

function notesave({ interaction, viewer, ctx, arg }) {
  const r = actions.setNote(ctx, actorOf(interaction, viewer), {
    entryId: arg,
    note: interaction.fields.getTextInputValue("note"),
  });
  if (!r.ok) return mainScreen(viewer, { notice: err(r.error) });
  const notice = ok("Note added.");
  return committed(ctx, () => mainScreen(viewer, { notice }), notice, r.effects);
}

const SCREENS = {
  main: ({ viewer }) => mainScreen(viewer),
  needhelp,
  note,
  notesave,
};

// Screens only officers (and owners) may open — re-checked on every tap.
const OFFICER_ONLY = new Set([]);

async function render(interaction, ctx, viewer, screen, arg) {
  if (!Object.hasOwn(SCREENS, screen)) return null;
  if (OFFICER_ONLY.has(screen) && !atLeast(viewer.level, "officer")) return { home: MENU_TEXT.noAccess };
  return SCREENS[screen]({ interaction, ctx, viewer, arg });
}

module.exports = { section, guide, render, mainScreen };
