// The /menu "Teammates" section (M4 spec §3.2, §6): every
// "menu:lfg:<screen>[:<arg>]" screen. Rebuilt from fresh data on every tap;
// every write goes through ./actions, its slow REST returned as `after`
// (the core runs it once the tap is acknowledged). Waiting news (closed /
// switched-off DMs) is shown on top of any screen and consumed (§6.4).
const { ButtonStyle, SectionBuilder } = require("discord.js");
const A = require("./actions");
const S = require("./state");
const R = require("./render");
const D = require("./discord");
const store = require("./store");
const { health } = require("./seed");
const { textOf } = require("./texts");
const { atLeast, LEVEL_LABEL } = require("../../core/perms");
const { MENU_TEXT, HOME_ID } = require("../../core/menu");
const { text, button, row, select, ok, err, screenErrors } = require("../../core/panel");

const MAIN_ID = "menu:lfg:main";
// The lists (browse, roles, remove) carry a per-render tag in their custom_id
// (render.renderTag — a re-sent identical select freezes in the client); the
// core passes it as `arg`, which these screens ignore.
const MAX_LISTED = 5;
const crumbs = (step) => (step ? ["Menu", "Teammates", step] : ["Menu", "Teammates"]);

function actorOf(interaction, viewer) {
  return { userId: viewer.userId, displayName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username, level: viewer.level };
}

// The tapper's GuildMember (role changes need one); the interaction's own when cached.
async function memberOf(interaction, userId) {
  if (interaction.member && interaction.member.roles && interaction.member.roles.cache) return interaction.member;
  if (!interaction.guild) return null;
  return interaction.guild.members.fetch(userId).catch(() => null);
}

const sectionRow = (lines, accessory) => new SectionBuilder().addTextDisplayComponents(text(lines)).setButtonAccessory(accessory);

function section(ctx) {
  const data = store.load(ctx);
  if (!data.config) return { label: "Teammates", counter: "not set up" };
  return { label: "Teammates", counter: `${S.joinable(data, D.nowOf(ctx)).length} open` };
}

function guide() {
  return [
    "### Teammates",
    "Tap **Start my own search** in the looking-for-game channel (or **New search** here) to post a search — you get a private thread where requests line up.",
    "Tap **Join** on someone's search to ask for a spot; your requests live on one DM card.",
    "When you're picked, both players tap **I'm here** — the game is set only then.",
    "**Pick your roles…** in the channel (or **My roles** here) decides which searches ping you.",
  ].join("\n");
}

const stateWord = { open: "open", fixed: "set — starts later", confirming: "confirming", started: "in the game" };

function mainScreen(ctx, viewer, notice) {
  const data = store.load(ctx);
  const config = data.config;
  const body = [];
  if (!config) {
    const lines = ["Teammates isn't set up yet."];
    if (atLeast(viewer.level, "owner")) lines.push(`⚠\uFE0F No visible #looking-for-game channel was found. Create one the bot can see, then restart the bot.`);
    return { crumbs: crumbs(), status: "not set up", notice, body: [text(lines.join("\n"))], back: HOME_ID };
  }
  const own = S.ownListing(data, viewer.userId);
  if (own) {
    const { label, emoji } = S.labelOf(config, own);
    const url = R.threadUrl(config, own.threadId);
    const line = `**Your search** · ${emoji} ${label} · ${stateWord[own.state]}${url ? ` · [thread](<${url}>)` : ""}`;
    body.push(own.state === "started" ? text(line) : sectionRow(line, button(`menu:lfg:cancel:${own.id}`, textOf(config, "cancelMySearch"), ButtonStyle.Danger)));
  }
  const mine = data.listings.filter((l) => S.activeRequest(l, viewer.userId));
  if (mine.length) {
    body.push(text(`**Your requests** · ${mine.length}`));
    for (const l of mine.slice(0, MAX_LISTED)) {
      const { label, emoji } = S.labelOf(config, l);
      const r = S.activeRequest(l, viewer.userId);
      const where = r.status === "accepted" ? "you're in" : r.onHold ? "on hold" : `#${S.queuePosition(l, viewer.userId)}`;
      body.push(sectionRow(`${emoji} ${label} · ${l.posterName} · ${where}`, button(`menu:lfg:withdraw:${l.id}`, textOf(config, "cancelRequest"))));
    }
    if (mine.length > MAX_LISTED) body.push(text(`-# +${mine.length - MAX_LISTED} more on your DM card`));
  }
  body.push(row(button("menu:lfg:new", "New search", ButtonStyle.Primary), button("menu:lfg:browse", "Browse"), button("menu:lfg:roles", "My roles")));
  body.push(row(button("menu:lfg:notify", "Notifications")));
  if (atLeast(viewer.level, "officer")) {
    body.push(text("**Officer**"));
    body.push(row(button("menu:lfg:remove", "Remove a search")));
  }
  if (atLeast(viewer.level, "owner") && health.missing.length) {
    body.push(text(`⚠\uFE0F I'm missing permissions in the board channel: ${health.missing.join(", ")}`));
  }
  return {
    crumbs: crumbs(),
    status: `${S.joinable(data, D.nowOf(ctx)).length} open · You: ${LEVEL_LABEL[viewer.level] || LEVEL_LABEL.member}`,
    notice,
    body,
    back: HOME_ID,
  };
}

// The action already saved, so its `after` must run even if the next screen fails to build.
function committed(ctx, viewer, notice, after) {
  let screen;
  try {
    screen = mainScreen(ctx, viewer, notice);
  } catch (e) {
    ctx.log.error("[menu] could not build the screen after a saved change:", e);
    screen = { crumbs: crumbs(), notice, body: [], back: HOME_ID };
  }
  return { ...screen, after };
}

function newSearch({ ctx, viewer }) {
  const data = store.load(ctx);
  if (!data.config) return mainScreen(ctx, viewer, err(textOf(null, "notSetUp")));
  if (S.ownListing(data, viewer.userId)) return mainScreen(ctx, viewer, err(textOf(data.config, "hasSearch")));
  if (S.isBusy(data, viewer.userId)) return mainScreen(ctx, viewer, err(textOf(data.config, "busy")));
  return { modal: R.startModal(data, viewer.userId) };
}

function minutesFrom(listing, now) {
  if (!listing.startAt) return "now";
  const m = Math.max(0, Math.round((listing.startAt - now) / 60_000));
  return m === 0 ? "starting" : `in ${m} min`;
}

function browseScreen(ctx, viewer, notice) {
  const data = store.load(ctx);
  const now = D.nowOf(ctx);
  const open = S.joinable(data, now).filter((l) => l.posterId !== viewer.userId).slice(0, 25);
  if (open.length === 0) return mainScreen(ctx, viewer, notice || err("No open searches right now."));
  const options = open.map((l) => {
    const { label } = S.labelOf(data.config, l);
    return { label: `${label} · ${l.posterName}`.slice(0, 100), value: l.id, description: [minutesFrom(l, now), l.note].filter(Boolean).join(" · ").slice(0, 100) };
  });
  return { crumbs: crumbs("Browse"), status: `${open.length} open — pick one to ask for a spot.`, notice, body: [row(select(`menu:lfg:browse:${R.renderTag()}`, "Pick a search to join…", options))], back: MAIN_ID };
}

function browse({ interaction, ctx, viewer }) {
  if (!interaction.isStringSelectMenu()) return browseScreen(ctx, viewer);
  const r = A.join(ctx, actorOf(interaction, viewer), { listingId: interaction.values[0] });
  if (!r.ok) return browseScreen(ctx, viewer, err(r.error));
  const poster = r.listing.posterName;
  if (r.already) return mainScreen(ctx, viewer, ok(textOf(store.load(ctx).config, "alreadyRequested", { poster, n: r.position })));
  const key = r.dmOk ? "requestSent" : "requestSentNoDm";
  return committed(ctx, viewer, ok(textOf(store.load(ctx).config, key, { poster, n: r.position })), r.effects);
}

// My roles: the full list, the member's roles pre-selected; Save = the pick.
// `heldIds` (optional) overrides the member's cached roles: discord.js does not refresh the cache after a
// single-role add/remove (no GuildMembers intent), so a re-render after Save passes the derived set.
function rolesScreen(data, member, guild, notice, heldIds) {
  const held = new Set(heldIds || (member ? [...member.roles.cache.keys()] : []));
  const options = S.subscribable(data.config)
    .filter((s) => !guild || guild.roles.cache.has(s.roleId))
    .map((s) => ({ label: s.label, value: s.roleId, ...(s.emoji ? { emoji: { name: s.emoji } } : {}), default: held.has(s.roleId) }));
  const body = options.length
    ? [row(select(`menu:lfg:roles:${R.renderTag()}`, "Pick the searches that ping you…", options, { min: 0, max: options.length }))]
    : [text("No roles to pick yet — ask an admin.")];
  body.push(row(button("menu:lfg:notify", "Notifications")));
  return { crumbs: crumbs("My roles"), status: "Pick every role you want — the ones you leave out are removed.", notice, body, back: MAIN_ID };
}

const roleNames = (guild, ids) => ids.map((id) => (guild && guild.roles.cache.get(id) ? guild.roles.cache.get(id).name : id)).join(", ");

// "Added: … · Removed: … · Couldn't change: …"
function subscriptionNotice(guild, r) {
  const parts = [];
  if (r.added.length) parts.push(`Added: ${roleNames(guild, r.added)}`);
  if (r.removed.length) parts.push(`Removed: ${roleNames(guild, r.removed)}`);
  if (r.failed.length) parts.push(`Couldn't change: ${roleNames(guild, r.failed)}`);
  if (parts.length === 0) return ok("No change.");
  return r.failed.length ? err(parts.join(" · ")) : ok(parts.join(" · "));
}

async function roles({ interaction, ctx, viewer }) {
  const data = store.load(ctx);
  if (!data.config) return mainScreen(ctx, viewer, err(textOf(null, "notSetUp")));
  const guild = interaction.guild;
  if (!interaction.isStringSelectMenu()) return rolesScreen(data, await memberOf(interaction, viewer.userId), guild);
  await interaction.deferUpdate();
  const member = await memberOf(interaction, viewer.userId);
  const r = await A.setSubscriptions(ctx, actorOf(interaction, viewer), {
    member,
    picked: interaction.values,
    mode: "set",
    roleExists: (id) => !guild || guild.roles.cache.has(id),
  });
  if (!r.ok) return rolesScreen(data, member, guild, err(r.error));
  const held = new Set(member ? member.roles.cache.keys() : []);
  for (const id of r.added) held.add(id);
  for (const id of r.removed) held.delete(id);
  return rolesScreen(store.load(ctx), member, guild, subscriptionNotice(guild, r), held);
}

// `gmOn` (optional) overrides the cached GM-PING state (see rolesScreen).
function notifyScreen(data, viewer, member, notice, gmOn) {
  const prefs = { dm: false, requestDm: true, ...(data.prefs[viewer.userId] || {}) };
  const toggle = (on, arg) => button(`menu:lfg:notify:${arg}`, on ? "Turn off" : "Turn on");
  const body = [
    sectionRow(`**Request updates by DM** · ${prefs.requestDm ? "On" : "Off"}\n-# Your requests and games on one DM card.`, toggle(prefs.requestDm, "requestDm")),
    sectionRow(`**New searches by DM** · ${prefs.dm ? "On" : "Off"}\n-# A DM when a search pings one of your roles.`, toggle(prefs.dm, "dm")),
  ];
  const gm = data.config.gmPingRoleId;
  if (gm) {
    const on = gmOn !== undefined ? gmOn : !!member && member.roles.cache.has(gm);
    body.push(sectionRow(`**GM pings** · ${on ? "On" : "Off"}\n-# Guild-match calls ping the GM-PING role.`, toggle(on, "gm")));
  }
  return { crumbs: crumbs("Notifications"), notice, body, back: MAIN_ID };
}

async function notify({ interaction, ctx, viewer, arg }) {
  const data = store.load(ctx);
  if (!data.config) return mainScreen(ctx, viewer, err(textOf(null, "notSetUp")));
  const actor = actorOf(interaction, viewer);
  if (arg === "dm" || arg === "requestDm") {
    const current = { dm: false, requestDm: true, ...(data.prefs[viewer.userId] || {}) }[arg];
    const r = A.setDm(ctx, actor, { kind: arg, on: !current });
    return notifyScreen(store.load(ctx), viewer, await memberOf(interaction, viewer.userId), r.ok ? ok("Saved.") : err(r.error));
  }
  if (arg === "gm") {
    await interaction.deferUpdate();
    const member = await memberOf(interaction, viewer.userId);
    const on = !(member && member.roles.cache.has(data.config.gmPingRoleId));
    const r = await A.setGmPings(ctx, actor, { member, on });
    return notifyScreen(store.load(ctx), viewer, member, r.ok ? ok(on ? "GM pings on." : "GM pings off.") : err(r.error), r.ok ? on : undefined);
  }
  return notifyScreen(data, viewer, await memberOf(interaction, viewer.userId));
}

function removeScreen(ctx, notice) {
  const data = store.load(ctx);
  const listings = data.listings.slice(0, 25);
  if (listings.length === 0) return { crumbs: crumbs("Remove"), notice: notice || err("There are no searches to remove."), body: [], back: MAIN_ID };
  const options = listings.map((l) => ({ label: `${S.labelOf(data.config, l).label} · ${l.posterName}`.slice(0, 100), value: l.id, description: stateWord[l.state] }));
  return { crumbs: crumbs("Remove"), status: "Pick the search to remove. Everyone waiting on it is told.", notice, body: [row(select(`menu:lfg:remove:${R.renderTag()}`, "Pick a search to remove…", options))], back: MAIN_ID };
}

function remove({ interaction, ctx, viewer }) {
  if (!interaction.isStringSelectMenu()) return removeScreen(ctx);
  const r = A.removeListing(ctx, actorOf(interaction, viewer), { listingId: interaction.values[0] });
  if (!r.ok) return removeScreen(ctx, err(r.error));
  return committed(ctx, viewer, ok(textOf(store.load(ctx).config, "searchRemoved", { poster: r.listing.posterName })), r.effects);
}

function cancel({ interaction, ctx, viewer, arg }) {
  const r = A.cancelListing(ctx, actorOf(interaction, viewer), { listingId: arg });
  if (!r.ok) return mainScreen(ctx, viewer, err(r.error));
  return committed(ctx, viewer, ok(textOf(store.load(ctx).config, "searchCancelled")), r.effects);
}

function withdraw({ interaction, ctx, viewer, arg }) {
  const r = A.withdraw(ctx, actorOf(interaction, viewer), { listingId: arg });
  if (!r.ok) return mainScreen(ctx, viewer, err(r.error));
  return committed(ctx, viewer, ok(textOf(store.load(ctx).config, "requestCancelled")), r.effects);
}

const SCREENS = {
  main: ({ ctx, viewer }) => mainScreen(ctx, viewer),
  new: newSearch,
  browse,
  roles,
  notify,
  remove,
  cancel,
  withdraw,
};
const OFFICER_ONLY = new Set(["remove"]);

// News for the tapper goes on top of whatever screen comes back (never into
// a modal — it would be lost; the next screen shows it). The screen with the
// news is built and validated first; the news is consumed (a store write)
// only once that screen is known to be sendable, so a fallback to home never
// eats it.
function withNews(ctx, interaction, viewer, out) {
  if (!out || !Array.isArray(out.body)) return out;
  const data = store.load(ctx);
  const waiting = data.notices[viewer.userId];
  if (!waiting) return out;
  const fresh = S.takeNotices(structuredClone(data), viewer.userId, D.nowOf(ctx));
  if (fresh.length === 0) {
    A.consumeNotices(ctx, actorOf(interaction, viewer)); // only expired news: drop it
    return out;
  }
  let withNotes;
  try {
    withNotes = { ...out, body: [text(R.noticeText(data.config, fresh)), ...out.body] };
    if (screenErrors(withNotes).length) return out; // keep the news for the next screen
  } catch (e) {
    ctx.log.warn("[menu] could not add the waiting news to the screen:", e.message);
    return out;
  }
  A.consumeNotices(ctx, actorOf(interaction, viewer));
  return withNotes;
}

async function render(interaction, ctx, viewer, screen, arg) {
  if (!Object.hasOwn(SCREENS, screen)) return null;
  if (OFFICER_ONLY.has(screen) && !atLeast(viewer.level, "officer")) return { home: MENU_TEXT.noAccess };
  const out = await SCREENS[screen]({ interaction, ctx, viewer, arg });
  return withNews(ctx, interaction, viewer, out);
}

module.exports = { section, guide, render, mainScreen, rolesScreen, subscriptionNotice, memberOf, actorOf };
