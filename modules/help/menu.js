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
const { text, button, row, select, userSelect, textFromEmbed, ok, err } = require("../../core/panel");

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

// The Help board screen: the member row, then (officers and owners only) the
// "Officer" row. `noteFor` adds the one-tap "Add note" button for the request
// the viewer just posted. In Discord an owner is an officer; owner-only
// settings live on the web (M2 spec U3).
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
  if (atLeast(viewer.level, "officer")) {
    body.push(text("**Officer**"));
    body.push(
      row(
        button("menu:help:helped", "Mark helped"),
        button("menu:help:remove", "Remove"),
        button("menu:help:repost", "Repost board")
      )
    );
  }
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

const NO_CATEGORIES = "No categories are set up yet — ask an admin.";

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
      return picker || mainScreen(viewer, { notice: err(NO_CATEGORIES) }); // every category archived meanwhile
    }
    return mainScreen(viewer, { notice: err(r.error) });
  }
  return categoryPicker() || mainScreen(viewer, { notice: err(NO_CATEGORIES) });
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

function closedNotice(r) {
  const n = r.closed.length;
  return ok(`Marked ${n} request${n === 1 ? "" : "s"} sorted.`);
}

function sortedPicker(mine, notice) {
  const options = help.imsortedSelectOptions(help.loadData(), mine, Date.now());
  return {
    crumbs: crumbs("I'm sorted"),
    status: `You have ${mine.length} open requests. Pick the ones you got help with.`,
    notice,
    body: [
      row(select("menu:help:sorted", "Choose which to mark sorted…", options, { max: options.length })),
      row(button("menu:help:closeall", "Close all")),
    ],
    back: MAIN_ID,
  };
}

// After a stale pick: the picker again if there is still a choice, else the Help board.
function sortedOrMain(viewer, notice) {
  const mine = help.openEntriesFor(help.loadData(), viewer.userId);
  return mine.length > 1 ? sortedPicker(mine, notice) : mainScreen(viewer, { notice });
}

// One open request closes right away; several → a multi-select + Close all.
function sorted({ interaction, viewer, ctx }) {
  const actor = actorOf(interaction, viewer);
  if (interaction.isStringSelectMenu()) {
    const r = actions.sorted(ctx, actor, { entryIds: interaction.values });
    if (!r.ok) return sortedOrMain(viewer, err("Those requests were already closed. Showing your current list."));
    return committed(ctx, () => mainScreen(viewer, { notice: closedNotice(r) }), closedNotice(r), r.effects);
  }
  const mine = help.openEntriesFor(help.loadData(), viewer.userId);
  if (mine.length === 0) return mainScreen(viewer, { notice: err("You have no open requests.") });
  if (mine.length > 1) return sortedPicker(mine);
  const r = actions.sorted(ctx, actor, { entryIds: [mine[0].id] });
  if (!r.ok) return mainScreen(viewer, { notice: err(r.error) });
  return committed(ctx, () => mainScreen(viewer, { notice: closedNotice(r) }), closedNotice(r), r.effects);
}

// Confirmations carry their render time (like reset:confirm); older than the
// TTL → re-issued instead of executed.
const EXPIRED = "That confirmation expired — check and confirm again.";
function isStale(issuedTs) {
  return !Number.isFinite(issuedTs) || help.resetConfirmStale(issuedTs, Date.now(), help.RESET_CONFIRM_TTL_MS);
}

function closeAllConfirm(viewer, notice) {
  const mine = help.openEntriesFor(help.loadData(), viewer.userId);
  if (mine.length === 0) return mainScreen(viewer, { notice: err("You have no open requests.") });
  return {
    crumbs: crumbs("I'm sorted"),
    status: mine.length === 1 ? "Close your open request?" : `Close all ${mine.length} of your open requests?`,
    notice,
    // Cancel is the way back and goes to the Help board — never to a screen
    // that closes anything (the I'm sorted screen closes a lone request on open).
    body: [row(button(`menu:help:closeallok:${Date.now()}`, "Close all", ButtonStyle.Danger), button(MAIN_ID, "Cancel"))],
  };
}

function closeallok({ interaction, viewer, ctx, arg }) {
  if (isStale(Number(arg))) return closeAllConfirm(viewer, err(EXPIRED));
  const r = actions.closeAll(ctx, actorOf(interaction, viewer));
  if (!r.ok) {
    const notice = r.code === "not_found" ? "Those requests were already closed." : r.error;
    return mainScreen(viewer, { notice: err(notice) });
  }
  return committed(ctx, () => mainScreen(viewer, { notice: closedNotice(r) }), closedNotice(r), r.effects);
}

function statsScreen(data, view, embed, notice) {
  const options = help.statsViewOptions(data).map((o) => ({ ...o, default: o.value === view }));
  return {
    crumbs: crumbs("Stats"),
    notice,
    body: [
      text(textFromEmbed(embed)),
      row(select("menu:help:stats", "Choose a view…", options)),
      row(userSelect(`menu:help:statsmember:${view}`, "Look up a member's help…")),
    ],
    back: MAIN_ID,
  };
}

// Name lookups are REST → defer first (the 3-second window).
async function stats({ interaction }) {
  let view = interaction.isStringSelectMenu() ? interaction.values[0] : "current";
  await interaction.deferUpdate();
  const data = help.loadData();
  let embed = await help.statsEmbedFor(interaction.guild, data, view);
  let notice;
  if (!embed) {
    notice = err("That season is gone. Showing the current season.");
    view = "current";
    embed = await help.statsEmbedFor(interaction.guild, data, view);
  }
  return statsScreen(data, view, embed, notice);
}

// The view the member lookup was made from rides in the customId — no session state.
async function statsmember({ interaction, arg }) {
  await interaction.deferUpdate();
  const data = help.loadData();
  const helperId = interaction.values[0];
  const name = (await help.memberName(interaction.guild, helperId)) || "(left the server)";
  return statsScreen(data, arg || "current", help.memberEmbed(data, helperId, name));
}

const GONE = "That request was already closed. Pick a member again.";
const STEP = {
  helped: { label: "Mark helped", pick: "Pick the member you helped…" },
  remove: { label: "Remove", pick: "Pick the member to remove…" },
};

// The name of a member picked in a UserSelect — from the resolved payload, no REST.
function pickedName(interaction, userId) {
  const m = interaction.members?.get(userId);
  const u = interaction.users?.get(userId);
  return m?.displayName || m?.nick || u?.globalName || u?.username || "That member";
}

function memberPicker(action, notice) {
  return {
    crumbs: crumbs(STEP[action].label),
    status: "Pick a member — you'll see their open requests.",
    notice,
    body: [row(userSelect(`menu:help:${action}`, STEP[action].pick))],
    back: MAIN_ID,
  };
}

function entryPicker(action, memberId, name, entries) {
  const options = help.imsortedSelectOptions(help.loadData(), entries, Date.now());
  return {
    crumbs: crumbs(STEP[action].label),
    status: `${name} has ${entries.length} open requests. Pick which one.`,
    body: [row(select(`menu:help:${action}pick:${memberId}`, "Pick which request…", options))],
    back: `menu:help:${action}`,
  };
}

// First step shared by Mark helped and Remove: what the picked member has open.
function pickMember(action, interaction) {
  const memberId = interaction.values[0];
  const mine = help.openEntriesFor(help.loadData(), memberId);
  const name = pickedName(interaction, memberId);
  if (mine.length === 0) return { screen: memberPicker(action, err(`${name} has no open requests.`)) };
  if (mine.length > 1) return { screen: entryPicker(action, memberId, name, mine) };
  return { entryId: mine[0].id };
}

function finishHelped(ctx, viewer, r) {
  if (!r.ok) return memberPicker("helped", err(r.code === "not_found" ? GONE : r.error));
  const notice = ok(`${r.entry.username} marked as helped.`);
  return committed(ctx, () => mainScreen(viewer, { notice }), notice, r.effects);
}

function helped({ interaction, viewer, ctx }) {
  if (!interaction.isUserSelectMenu()) return memberPicker("helped");
  const picked = pickMember("helped", interaction);
  if (picked.screen) return picked.screen;
  return finishHelped(ctx, viewer, actions.helped(ctx, actorOf(interaction, viewer), { entryId: picked.entryId }));
}

function helpedpick({ interaction, viewer, ctx }) {
  return finishHelped(ctx, viewer, actions.helped(ctx, actorOf(interaction, viewer), { entryId: interaction.values[0] }));
}

// Remove closes a request without counting it as helped → it asks first.
// Cancel goes back to the member picker, which never writes.
function removeConfirm(entryId, notice) {
  const data = help.loadData();
  const entry = data.entries.find((e) => e.id === entryId && !e.done);
  if (!entry) return memberPicker("remove", err(GONE));
  const cat = help.catOf(data, entry.category);
  return {
    crumbs: crumbs("Remove"),
    status: `Remove ${entry.username}'s ${cat.emoji} ${cat.label} request? It closes without counting as helped.`,
    notice,
    body: [
      row(
        button(`menu:help:removeok:${entry.id}:${Date.now()}`, "Remove", ButtonStyle.Danger),
        button("menu:help:remove", "Cancel")
      ),
    ],
  };
}

function remove({ interaction }) {
  if (!interaction.isUserSelectMenu()) return memberPicker("remove");
  const picked = pickMember("remove", interaction);
  return picked.screen || removeConfirm(picked.entryId);
}

function removeok({ interaction, viewer, ctx, arg }) {
  const [entryId, ts] = arg.split(":");
  if (isStale(Number(ts))) return removeConfirm(entryId, err(EXPIRED));
  const r = actions.remove(ctx, actorOf(interaction, viewer), { entryId });
  if (!r.ok) return memberPicker("remove", err(r.code === "not_found" ? GONE : r.error));
  const notice = ok(`Removed ${r.entry.username}'s request.`);
  return committed(ctx, () => mainScreen(viewer, { notice }), notice, r.effects);
}

// Posts the board in THIS channel (where the menu was opened). REST → defer first.
async function repost({ interaction, viewer, ctx }) {
  if (!interaction.channel || typeof interaction.channel.send !== "function") {
    return mainScreen(viewer, { notice: err("I can't post the board in this channel.") });
  }
  await interaction.deferUpdate();
  const r = await actions.repostBoard(ctx, actorOf(interaction, viewer), { channel: interaction.channel });
  if (!r.ok) return mainScreen(viewer, { notice: err(r.error) });
  return mainScreen(viewer, {
    notice: r.pinned
      ? ok("Board posted and pinned in this channel.")
      : err("Board posted, but I couldn't pin it — I need Pin Messages here."),
  });
}

const SCREENS = {
  main: ({ viewer }) => mainScreen(viewer),
  needhelp,
  note,
  notesave,
  sorted,
  closeall: ({ viewer }) => closeAllConfirm(viewer),
  closeallok,
  stats,
  statsmember,
  helped,
  helpedpick,
  remove,
  removepick: ({ interaction }) => removeConfirm(interaction.values[0]),
  removeok,
  repost,
};

// Screens only officers (and owners) may open — re-checked on every tap; the
// actions check again (menu filtering is a convenience, not the guard).
const OFFICER_ONLY = new Set(["helped", "helpedpick", "remove", "removepick", "removeok", "repost"]);

async function render(interaction, ctx, viewer, screen, arg) {
  if (!Object.hasOwn(SCREENS, screen)) return null;
  if (OFFICER_ONLY.has(screen) && !atLeast(viewer.level, "officer")) return { home: MENU_TEXT.noAccess };
  return SCREENS[screen]({ interaction, ctx, viewer, arg });
}

module.exports = { section, guide, render, mainScreen };
