// Pure Components V2 renderers for every lfg message (M4 spec §3): channel
// blocks (banner, panel, board), the ping, the searcher's thread (ONE message:
// request panel + Confirm / Game on!), the DM card and the start modal.
// Raw API JSON (no builders) except the modal, so tests read it directly.
// Visual rules (§3.0): colour only on the container stripe; Secondary buttons
// except I'm here (Success) and Cancel search (Danger); a segment's count is a
// disabled grey button in its header Section; event boxes carry an avatar.
// Every payload a renderer returns passes core/panel messageErrors() — a list
// that would not fit is cut back with a "+N more" line (fitRows).
const {
  ButtonStyle,
  ComponentType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  parseEmoji,
} = require("discord.js");
const { messageErrors } = require("../../core/panel");
const S = require("./state");
const { textOf } = require("./texts");

const COLORS = Object.freeze({ teal: 0x4f9e88, amber: 0xc9a24b, slate: 0x6b7bd1, grey: 0x6d7480, red: 0xc25b5b });
const V2 = MessageFlags.IsComponentsV2;
const PREFIXES = ["lfg:", "menu:"];

const td = (content) => ({ type: ComponentType.TextDisplay, content });
const btn = (customId, label, style = ButtonStyle.Secondary, extra = {}) => ({ type: ComponentType.Button, style, custom_id: customId, label, ...extra });
const linkBtn = (url, label) => ({ type: ComponentType.Button, style: ButtonStyle.Link, url, label });
const row = (...components) => ({ type: ComponentType.ActionRow, components });
const box = (accent, components) => ({ type: ComponentType.Container, accent_color: accent, components });
const section = (lines, accessory) => ({ type: ComponentType.Section, components: [td(lines.join("\n"))], accessory });
const thumb = (url) => ({ type: ComponentType.Thumbnail, media: { url } });
const badge = (segment, label) => btn(`lfg:badge:${segment}`, String(label), ButtonStyle.Secondary, { disabled: true });
const header = (title, segment, count) => section([`### ${title}`], badge(segment, count));
const when = (ts) => (ts ? `<t:${Math.floor(ts / 1000)}:R>` : "now");
// Every user / display name that goes into message text: markdown AND a
// masked link ("[x](https://…)") are escaped.
const esc = (s) => escapeMarkdown(String(s ?? ""), { maskedLink: true });
const v2 = (components, extra = {}) => ({ flags: V2, components, ...extra });

// Discord's default avatar for a user id (new username system: (id >> 22) % 6).
function defaultAvatar(userId) {
  let n = 0;
  try {
    n = Number((BigInt(userId) >> 22n) % 6n);
  } catch {
    n = 0;
  }
  return `https://cdn.discordapp.com/embed/avatars/${n}.png`;
}

// Names and avatars: the Discord side passes live lookups (D6: live name,
// stored name as fallback); tests and the fallback use the stored data only.
const PLAIN_LOOK = Object.freeze({ nameOf: (userId, fallback) => fallback || "someone", avatarOf: (userId) => defaultAvatar(userId) });
const nameOf = (look, userId, fallback) => esc(look.nameOf(userId, fallback) || fallback || "someone");

const threadUrl = (config, threadId) => (config && config.guildId && threadId ? `https://discord.com/channels/${config.guildId}/${threadId}` : null);

// Per-render suffix for a select that gets re-rendered (the panel's role
// picker, the menu's lists) — help's rolesRenderTag, live bug 2026-10-08: a
// select re-sent with the very same custom_id stays in the client's loading
// state for ~15 s and swallows the next pick. The handlers ignore the tag.
let renderSeq = 0;
function renderTag() {
  renderSeq = (renderSeq + 1) % 1296;
  return Date.now().toString(36) + renderSeq.toString(36);
}

// The largest n ≤ total rows for which build(n) is a valid message; null if
// not even build(0) is (the caller logs it and keeps the last good message).
function fitRows(total, build) {
  for (let n = total; n >= 0; n--) {
    const payload = build(n);
    if (messageErrors(payload, { prefixes: PREFIXES }).length === 0) return payload;
  }
  return null;
}

// ── channel blocks ─────────────────────────────────────────────────────────
// The blocks are ONE channel message (renderStack): each block's components
// concatenated in config.layout order. renderBanner / renderPanel /
// renderBoard still render a block on its own (tests, the budget check).

const bannerParts = (block) => [{ type: ComponentType.MediaGallery, items: [{ media: { url: block.imageUrl } }] }];
const renderBanner = (block) => v2(bannerParts(block));

// A select option's emoji, or nothing: a custom emoji the guild no longer has
// (hasEmoji false) makes Discord refuse the WHOLE message (50035 Invalid
// emoji) — and the panel rides in the board's message — so only the emoji is
// dropped, the option stays. Unparsable text is dropped too.
function optionEmoji(raw, hasEmoji = () => true) {
  const e = raw ? parseEmoji(raw) : null;
  if (!e || !e.name || (e.id && !hasEmoji(e.id))) return {};
  return { emoji: e };
}

// The static start panel; the role picker lists the subscribable roles that
// still exist (hasRole: a deleted role drops out, §8.1).
function panelParts(config, hasRole = () => true, tag = renderTag(), hasEmoji = () => true) {
  const options = S.subscribable(config)
    .filter((s) => hasRole(s.roleId))
    .map((s) => ({ label: s.label, value: s.roleId, ...optionEmoji(s.emoji, hasEmoji) }));
  const components = [section([`### ${textOf(config, "panelTitle")}`, `-# ${textOf(config, "panelSub")}`], btn("lfg:start", textOf(config, "startButton")))];
  if (options.length > 0) {
    components.push(row({ type: ComponentType.StringSelect, custom_id: `lfg:roles:${tag}`, placeholder: textOf(config, "rolesPlaceholder"), min_values: 1, max_values: options.length, options }));
  }
  return [box(COLORS.grey, components)];
}
const renderPanel = (config, hasRole, tag, hasEmoji) => v2(panelParts(config, hasRole, tag, hasEmoji));

function joinRow(config, listing, look) {
  const { label, emoji } = S.labelOf(config, listing);
  const pending = S.pendingRequests(listing).length;
  const detail = [when(listing.startAt)];
  if (pending > 0) detail.push(textOf(config, "interested", { n: pending }));
  if (listing.note) detail.push(esc(listing.note));
  return section([`${emoji} **${label}** · **${nameOf(look, listing.posterId, listing.posterName)}**`, `-# ${detail.join(" · ")}`], btn(`lfg:join:${listing.id}`, textOf(config, "joinButton")));
}

function pairLine(config, listing, look) {
  const { label } = S.labelOf(config, listing);
  const pair = `**${nameOf(look, listing.posterId, listing.posterName)}** + **${nameOf(look, listing.joinerId, joinerName(listing))}**`;
  let sub;
  if (listing.state === "started") sub = `-# started ${when(listing.startedAt)}`;
  else if (listing.state === "confirming") sub = `-# ${textOf(config, "waitingBoth")}`;
  else sub = `-# starts ${when(listing.startAt)}`;
  return `**${label}** · ${pair}\n${sub}`;
}

const joinerName = (listing) => (listing.requests.find((r) => r.userId === listing.joinerId) || {}).userName;

// Just started / Fixed are one Text Display each (≤ 4000 chars for the whole
// message): entries are cut to this budget with a "+N more" line, so the box
// can never make the board unrenderable. Two boxes plus the Join rows' share
// stay well inside the limit.
const PAIR_BOX_CHARS = 1500;
function pairBox(config, color, titleKey, segment, listings, look) {
  const lines = [];
  let used = 0;
  for (const l of listings) {
    const line = pairLine(config, l, look);
    if (used + line.length + 1 > PAIR_BOX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  const inner = [header(textOf(config, titleKey), segment, listings.length)];
  if (lines.length) inner.push(td(lines.join("\n")));
  if (lines.length < listings.length) inner.push(td(`-# +${listings.length - lines.length} more`));
  return box(color, inner);
}

// "No one is looking right now." — only for a board that is the whole message
// (a layout without a panel or banner: a V2 message cannot be empty) and for
// the fallback of a board-only layout (renderStackFallback). Beside a panel or
// banner an empty board renders NOTHING (live test round 2, item G).
const emptyBoardParts = (config) => [box(COLORS.grey, [td(textOf(config, "boardEmpty"))])];
const renderEmptyBoard = (config) => v2(emptyBoardParts(config));

// The live board (§3.1): Just started · Fixed · Timed · Now, each only when
// not empty; Now and Timed rows fill the room left, the rest is "+N more".
// `wrap(parts)` builds the whole message around the board's components
// (renderStack puts the banner and the panel around them), so the rows get
// only the 40-component / 4000-character budget LEFT after the other blocks.
// `hideEmpty`: no search to show → no board component at all (renderStack,
// when another block carries the message).
function renderBoard(data, now, look = PLAIN_LOOK, wrap = (parts) => v2(parts), { hideEmpty = false } = {}) {
  const config = data.config;
  const started = data.listings.filter((l) => l.state === "started").sort((a, b) => a.startedAt - b.startedAt);
  const fixed = data.listings.filter((l) => l.state === "fixed" || l.state === "confirming").sort((a, b) => (a.startAt ?? a.acceptedAt) - (b.startAt ?? b.acceptedAt));
  const open = S.joinable(data, now); // a lapsed search is gone even before the tick drops it
  const nowRows = open.filter((l) => l.startAt === null);
  const timedRows = open.filter((l) => l.startAt !== null);
  if (started.length + fixed.length + open.length === 0) return fitRows(0, () => wrap(hideEmpty ? [] : emptyBoardParts(config)));
  const priority = [...nowRows, ...timedRows];
  return fitRows(priority.length, (n) => {
    const shown = new Set(priority.slice(0, n));
    const parts = [];
    if (started.length) parts.push(pairBox(config, COLORS.grey, "segStarted", "started", started, look));
    if (fixed.length) parts.push(pairBox(config, COLORS.slate, "segFixed", "fixed", fixed, look));
    for (const [rows, segment, title, color] of [[timedRows, "timed", "segTimed", COLORS.amber], [nowRows, "now", "segNow", COLORS.teal]]) {
      if (!rows.length) continue;
      const visible = rows.filter((l) => shown.has(l));
      const inner = [header(textOf(config, title), segment, rows.length), ...visible.map((l) => joinRow(config, l, look))];
      if (visible.length < rows.length) inner.push(td(`-# ${textOf(config, "boardMore", { n: rows.length - visible.length })}`));
      parts.push(box(color, inner));
    }
    return wrap(parts);
  });
}

// The channel's ONE bot message (§3.1/§5.3, live test 2026-10-09: separate
// messages each showed "(edited)"): the active blocks' components in layout
// order. With no search to show the board adds nothing (no "No one is
// looking" box beside the panel / banner — item G); a search appearing later
// brings the board's boxes into the same message (an edit). Null when the
// blocks do not fit — the caller keeps the last message, or posts
// renderStackFallback.
function renderStack(data, blocks, now, look = PLAIN_LOOK, hasRole = () => true, tag = renderTag(), hasEmoji = () => true) {
  const config = data.config;
  // One block per type, the first wins (channel.activeBlocks does the same):
  // a second panel or board would repeat its custom_ids.
  const once = blocks.filter((b, i) => blocks.findIndex((x) => x.type === b.type) === i);
  const pieces = once.map((b) => (b.type === "banner" ? bannerParts(b) : b.type === "panel" ? panelParts(config, hasRole, tag, hasEmoji) : null));
  const wrap = (boardParts) => v2(pieces.flatMap((p) => p || boardParts), { allowedMentions: { parse: [] } });
  if (!once.some((b) => b.type === "board")) return fitRows(0, () => wrap([]));
  return renderBoard(data, now, look, wrap, { hideEmpty: once.length > 1 });
}

// What repost sends when renderStack gives null: the panel alone when the
// layout has one (an empty board shows nothing beside it, item G), else the
// "No one is looking" box — never no message, or every tick would repost. The
// next edit brings the real board once it fits.
function renderStackFallback(config, blocks, hasRole = () => true, tag = renderTag(), hasEmoji = () => true) {
  const parts = blocks.some((b) => b.type === "panel") ? panelParts(config, hasRole, tag, hasEmoji) : emptyBoardParts(config);
  return v2(parts, { allowedMentions: { parse: [] } });
}

// The new-search ping under the board (U7): the only message that pings roles.
function renderPing(config, listing, roleIds, look = PLAIN_LOOK) {
  const { label } = S.labelOf(config, listing);
  const content = textOf(config, "ping", {
    roles: roleIds.map((id) => `<@&${id}>`).join(" "),
    poster: nameOf(look, listing.posterId, listing.posterName),
    label,
    when: when(listing.startAt),
  }).trim();
  return { content, allowedMentions: { roles: [...roleIds] } };
}

// ── the searcher's thread ──────────────────────────────────────────────────

const REASON_KEY = {
  matched_elsewhere: "reason_matched_elsewhere",
  self: "reason_self",
  no_confirm: "reason_no_confirm",
  filled: "reason_filled",
  expired: "reason_expired",
  cancelled: "reason_cancelled",
  removed: "reason_removed",
};
const reasonText = (config, reason) => textOf(config, REASON_KEY[reason] || "reason_cancelled");

// The searcher's thread is ONE live message (live test round 2, item D),
// edited as the search goes (panelMessageId):
//   - the intro line while the search is open; "You picked X…" once accepted;
//   - the reopen notice (red) — "X didn't confirm / left — open again";
//   - Requests (in arrival order, Accept while open; accepted / on-hold rows
//     after) and Removed (with the reason);
//   - fixed / confirming: the Confirm box (counter badge, per-player status,
//     deadline, I'm here as a Section accessory INSIDE the box — a fixed game
//     before its window says when they will be asked, no I'm here yet);
//   - started: the Game on! box (the joiner's avatar) in its place;
//   - Cancel search only while the search is open (none once accepted).
// `closedLine`: the search has left the list — the terminal message, grey,
// with that line and nothing left to tap. The whole message shares one
// 40-component / 4000-character budget: fitRows cuts the request rows.
function renderRequestPanel(data, listing, now, look = PLAIN_LOOK, { closedLine = null } = {}) {
  const config = data.config;
  const closed = closedLine !== null;
  const open = listing.state === "open" && !closed;
  const rows = S.activeRequests(listing).sort((a, b) => a.createdAt - b.createdAt);
  const removed = listing.requests.filter((r) => r.status === "closed" || r.status === "withdrawn");
  let top = null;
  if (open) top = textOf(config, "threadIntro");
  else if (!closed && (listing.state === "fixed" || listing.state === "confirming")) {
    top = textOf(config, "threadPicked", { joiner: nameOf(look, listing.joinerId, joinerName(listing)), label: S.labelOf(config, listing).label });
  }
  const notice = open && listing.notice ? noticeBox(config, listing.notice, look) : null;
  let game = [];
  if (!closed && listing.state === "started") game = [gameOnBox(data, listing, look)];
  else if (!closed && (listing.state === "fixed" || listing.state === "confirming")) game = confirmBox(config, listing, look, { card: false });
  return fitRows(rows.length, (n) => {
    const inner = [header(textOf(config, "requestsTitle"), "requests", rows.length)];
    rows.slice(0, n).forEach((r, i) => {
      const who = `**${i + 1} · ${nameOf(look, r.userId, r.userName)}**`;
      if (r.status === "accepted") {
        const sub = listing.state === "started" ? "in the game" : listing.state === "fixed" ? `accepted — starts ${when(listing.startAt)}` : "accepted — confirming";
        inner.push(td(`${who}\n-# ${sub}`));
      } else if (listing.state === "open" && !closed) {
        inner.push(section([who, `-# asked ${when(r.createdAt)}`], btn(`lfg:accept:${listing.id}:${r.userId}`, textOf(config, "acceptButton"))));
      } else if (listing.state === "open") {
        inner.push(td(`${who}\n-# asked ${when(r.createdAt)}`));
      } else {
        inner.push(td(`${who}\n-# on hold`));
      }
    });
    if (rows.length === 0 && !closed) inner.push(td(textOf(config, "panelEmpty")));
    if (n < rows.length) inner.push(td(textOf(config, "moreRequests", { n: rows.length - n })));
    if (closed) inner.push(td(`-# ${closedLine}`));
    const parts = [];
    if (top) parts.push(td(top));
    if (notice) parts.push(notice);
    parts.push(box(closed ? COLORS.grey : COLORS.teal, inner));
    if (removed.length) {
      const lines = removed.slice(-10).map((r) => `${nameOf(look, r.userId, r.userName)} — ${reasonText(config, r.reason)}`);
      parts.push(box(COLORS.grey, [header(textOf(config, "removedTitle"), "removed", removed.length), td(lines.join("\n"))]));
    }
    parts.push(...game);
    if (open) parts.push(row(btn(`lfg:cancel:${listing.id}`, textOf(config, "cancelSearch"), ButtonStyle.Danger)));
    return v2(parts, { allowedMentions: { parse: [] } });
  });
}

// The red box after a reopen (listing.notice): "X didn't confirm — your
// search is open again…" / "X left — …". Shown while the search is open; the
// next Accept clears it.
function noticeBox(config, notice, look) {
  const key = notice.kind === "reopened" ? "reopened" : "reopenedLeft";
  const name = nameOf(look, notice.userId, notice.name || "Your partner");
  return box(COLORS.red, [td(textOf(config, key, { joiner: name }))]);
}

// "Dani ✓ · Marci — not yet"
function confirmStatus(listing, look) {
  const at = (listing.checkIn && listing.checkIn.at) || {};
  return [[listing.posterId, listing.posterName], [listing.joinerId, joinerName(listing)]]
    .map(([id, fallback]) => `**${nameOf(look, id, fallback)}** ${at[id] ? "✓" : "— not yet"}`)
    .join(" · ");
}

const confirmedCount = (listing) => Object.keys((listing.checkIn && listing.checkIn.at) || {}).length;

// The thread Confirm box's on-hold line names at most this many, then "+N
// more" — the box itself is not cut by fitRows (the request rows are).
const MAX_ON_HOLD_NAMES = 10;

// The Confirm box (§3.4), in the thread message (card false) and on the DM
// card (card true). A fixed game before its window: when they will be asked,
// no I'm here yet. Confirming: the per-player status and the deadline; in the
// thread I'm here is the Section accessory INSIDE the box (no extra row —
// live test round 2), on the card it stays a row with Open the thread.
function confirmBox(config, listing, look, { card }) {
  const t = S.times(config);
  const title = header(textOf(config, "confirmTitle"), "confirm", `${confirmedCount(listing)} / 2`);
  if (listing.state === "fixed") return [box(COLORS.amber, [title, td(textOf(config, "confirmWaitTimed", { lead: t.reminderLeadMin, when: when(listing.startAt) }))])];
  const pending = S.pendingRequests(listing);
  const onHold = pending.slice(0, MAX_ON_HOLD_NAMES).map((r) => `**${nameOf(look, r.userId, r.userName)}**`);
  if (pending.length > MAX_ON_HOLD_NAMES) onHold.push(`+${pending.length - MAX_ON_HOLD_NAMES} more`);
  const lines = [confirmStatus(listing, look)];
  if (card) lines.push(`-# ${textOf(config, "confirmCardHint")}`);
  else if (onHold.length) lines.push(textOf(config, "confirmOnHold", { names: onHold.join(", "), when: when(listing.checkIn.deadline) }));
  else lines.push(textOf(config, "confirmEnds", { when: when(listing.checkIn.deadline) }));
  const here = btn(`lfg:here:${listing.id}`, textOf(config, "hereButton"), ButtonStyle.Success);
  if (!card) return [box(COLORS.amber, [title, section(lines, here)])];
  const buttons = [here];
  const url = threadUrl(config, listing.threadId);
  if (url) buttons.push(linkBtn(url, textOf(config, "openThread")));
  return [box(COLORS.amber, [title, td(lines.join("\n"))]), row(...buttons)];
}

// The "Game on!" box in the thread message, with the partner's avatar (U15).
function gameOnBox(data, listing, look = PLAIN_LOOK) {
  const config = data.config;
  const { label } = S.labelOf(config, listing);
  const sub = textOf(config, "gameOnSub", { poster: nameOf(look, listing.posterId, listing.posterName), partner: nameOf(look, listing.joinerId, joinerName(listing)), label });
  return box(COLORS.teal, [section([`### ${textOf(config, "gameOn")}`, sub], thumb(look.avatarOf(listing.joinerId)))]);
}

// Plain thread lines: who to ping is always explicit (allowedMentions.users).
const threadLine = (content, users = []) => ({ content, allowedMentions: { users } });

// ── the DM card (§3.6) ─────────────────────────────────────────────────────

function eventBox(config, event, look) {
  const name = esc(event.aboutName || "");
  const title = textOf(config, `event_${event.kind}`, { name });
  const sub = textOf(config, `event_${event.kind}_sub`);
  return box(COLORS.red, [section([`### ${title}`, `-# ${event.emoji} ${event.label} · ${when(event.startAt)} — ${sub}`], thumb(look.avatarOf(event.aboutId)))]);
}

function acceptedParts(data, view, look, shownOthers = Infinity) {
  const config = data.config;
  const L = view.accepted;
  const { label, emoji } = S.labelOf(config, L);
  const poster = nameOf(look, L.posterId, L.posterName);
  const url = threadUrl(config, L.threadId);
  if (L.state === "started") {
    const lines = [`### ${textOf(config, "gameOnCard")}`, `-# ${emoji} ${label} — with **${poster}**`];
    if (view.otherCancelled) lines.push(`-# ${textOf(config, "otherCancelled")}`);
    const parts = [box(COLORS.teal, [section(lines, thumb(look.avatarOf(L.posterId)))])];
    if (url) parts.push(row(linkBtn(url, textOf(config, "openThread"))));
    return parts;
  }
  const parts = [box(COLORS.teal, [section([`### ${textOf(config, "youreIn")}`, textOf(config, "youreInSub", { emoji, label, when: when(L.startAt), poster })], thumb(look.avatarOf(L.posterId)))])];
  parts.push(...confirmBox(config, L, look, { card: true }));
  if (L.state === "fixed" && url) parts.push(row(linkBtn(url, textOf(config, "openThread"))));
  if (view.otherAccepted && view.otherAccepted.length) {
    const rows = view.otherAccepted.slice(0, shownOthers).map((o) => {
      const other = S.labelOf(config, o);
      return section([`${other.emoji} **${other.label}** · **${nameOf(look, o.posterId, o.posterName)}**`, textOf(config, "acceptedRow", { when: when(o.startAt) })], btn(`lfg:withdraw:${o.id}`, textOf(config, "cancelButton")));
    });
    if (rows.length < view.otherAccepted.length) rows.push(td(`-# +${view.otherAccepted.length - rows.length} more`));
    parts.push(box(COLORS.slate, [header(textOf(config, "alsoAccepted"), "accepted", view.otherAccepted.length), ...rows]));
  }
  return parts;
}

// The card's message payload for cardView(); null only when not even the
// smallest version fits. With nothing left to show it is the empty state (the
// tick deletes it 24 h later, §3.6).
function renderCard(data, userId, view, look = PLAIN_LOOK) {
  const config = data.config;
  if (view.accepted) {
    return fitRows((view.otherAccepted || []).length, (n) => v2(acceptedParts(data, view, look, n), { allowedMentions: { parse: [] } }));
  }
  const total = view.requests.length;
  return fitRows(total, (n) => {
    const parts = [];
    if (view.event) parts.push(eventBox(config, view.event, look));
    if (total) {
      const inner = [header(textOf(config, total === 1 ? "yourRequest" : "yourRequests"), "requests", total)];
      for (const { listing, onHold, position } of view.requests.slice(0, n)) {
        const { label, emoji } = S.labelOf(config, listing);
        const sub = onHold ? textOf(config, "onHoldLine") : textOf(config, "waitingLine", { n: position, when: when(listing.startAt) });
        inner.push(section([`${emoji} **${label}** · **${nameOf(look, listing.posterId, listing.posterName)}**`, sub], btn(`lfg:withdraw:${listing.id}`, textOf(config, "cancelButton"))));
      }
      if (n < total) inner.push(td(`-# +${total - n} more`));
      parts.push(box(COLORS.slate, inner));
    }
    if (total === 0 && !view.event) parts.push(box(COLORS.grey, [td(textOf(config, "cardEmpty"))]));
    if (view.stillOpen.length) {
      parts.push(box(COLORS.teal, [header(textOf(config, "stillOpen"), "open", view.stillOpen.length), ...view.stillOpen.map((l) => joinRow(config, l, look))]));
    }
    const bottom = [btn("lfg:start", textOf(config, "startButton"))];
    if (total >= 2) bottom.push(btn("lfg:withdrawall", textOf(config, "cancelAll")));
    parts.push(row(...bottom));
    return v2(parts, { allowedMentions: { parse: [] } });
  });
}

// What an old card becomes when a replace could not delete it: one line, no
// buttons left to tap (the old id is retried later — dmCards[].staleIds).
const renderCardReplaced = (config) => v2([td(textOf(config, "cardReplaced"))], { allowedMentions: { parse: [] } });

// News kept for a member whose DMs are closed or off (§3.6), one line each.
function noticeText(config, notices) {
  return notices
    .map((n) => `📬 ${textOf(config, n.outcome === "accepted" ? "youreIn" : `event_${n.outcome}`, { name: esc(n.name) })} · ${n.label}`)
    .join("\n");
}

// ── the start modal (§3.2) ─────────────────────────────────────────────────

function favoriteLabel(config, fav) {
  const found = S.findButton(config, fav.categoryId, fav.buttonId);
  const parts = [`${found.category.name} · ${found.button.label}`, fav.minutes > 0 ? `in ${fav.minutes} min` : "now"];
  if (fav.note) parts.push(`“${fav.note}”`);
  return parts.join(" · ").slice(0, 100);
}

// Favorites (only when the member has one — M5 creates them) · "or a custom
// search" · Looking for · Starts in (minutes) · Note. ≤ 5 top-level parts.
// hasEmoji: a custom emoji the guild lost is left off its option (optionEmoji).
function startModal(data, userId, hasEmoji = () => true) {
  const config = data.config;
  const favs = (Array.isArray(data.favorites[userId]) ? data.favorites[userId] : []).filter((f) => f && S.findButton(config, f.categoryId, f.buttonId)).slice(0, 25);
  const modal = new ModalBuilder().setCustomId("lfg:modal").setTitle("Start a search");
  if (favs.length > 0) {
    modal.addLabelComponents(
      new LabelBuilder().setLabel("Favorites").setStringSelectMenuComponent(
        new StringSelectMenuBuilder().setCustomId("favorite").setPlaceholder("Pick a favorite…").setRequired(false)
          .addOptions(favs.map((f) => ({ label: favoriteLabel(config, f), value: f.id })))
      )
    );
    modal.addTextDisplayComponents(new TextDisplayBuilder().setContent("-# or a custom search"));
  }
  const options = S.lookingForOptions(config).map((o) => ({ label: o.label, value: o.value, ...optionEmoji(o.emoji, hasEmoji) }));
  modal.addLabelComponents(
    new LabelBuilder().setLabel("Looking for").setStringSelectMenuComponent(
      new StringSelectMenuBuilder().setCustomId("lookingfor").setPlaceholder("Pick one…").setRequired(favs.length === 0).addOptions(options)
    ),
    new LabelBuilder().setLabel("Starts in (minutes)").setDescription("Empty or 0 = now. Up to 1440.").setTextInputComponent(
      new TextInputBuilder().setCustomId("minutes").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder("0")
    ),
    new LabelBuilder().setLabel("Note (optional)").setTextInputComponent(
      new TextInputBuilder().setCustomId("note").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(S.MAX_NOTE)
    )
  );
  return modal;
}

module.exports = {
  COLORS,
  PREFIXES,
  PLAIN_LOOK,
  MAX_ON_HOLD_NAMES,
  esc,
  when,
  defaultAvatar,
  threadUrl,
  renderTag,
  optionEmoji,
  fitRows,
  renderBanner,
  renderEmptyBoard,
  renderPanel,
  renderBoard,
  renderStack,
  renderStackFallback,
  renderPing,
  renderRequestPanel,
  threadLine,
  renderCard,
  renderCardReplaced,
  noticeText,
  startModal,
};
