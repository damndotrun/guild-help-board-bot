# 🛡️ Guild Help Board — User Guide

A simple bot that tracks who in the guild needs help hitting the guild's season
goals (**Season Run 5K** and **MVP 5K** by default — admins can add their own
categories), and lets officers mark them as **sorted** once they've been helped.
It keeps a single live board message in a channel that updates automatically.

> Tip: type `/help` in Discord any time to see a short version of this.

---

## For everyone

### 🙋 Need help (button on the board)
The quickest way: click **🙋 Need help** on the pinned board, pick your category
from the menu, and you're added instantly — same as `/needhelp` but without
typing. Use `/needhelp` instead when you want to add a note.

### `/needhelp`
Add yourself to the board when you need help this season.
- **category** (required): start typing and pick from the list your guild has set
  up (`Season Run 5K` / `MVP 5K` by default).
- **note** (optional): a short detail, e.g. `3 more hammers needed`

You'll get a private confirmation, your name appears in the **Waiting** list on
the board (with how long you've been waiting), and a small **request card**
with buttons is posted so officers can sort you with one click.

### `/imsorted`
Take yourself off the board once you've been helped. Run it with no options and
you get a **private picker** listing everything you're currently waiting on —
tick the ones that are done (or hit **Close all**), one click. (You can still
pass **category** directly to close just that one.)

### `/stats`
A private, navigable stats panel. It opens on the **current season** and you can
switch views from the dropdowns without re-running the command:

- **📊 Current season** — how many are waiting and sorted per category, the
  **average wait time**, and the **top helpers** leaderboard.
- **🏆 All-time** — the top helpers across every season, sorted counts per
  category, and a demand summary (sorted · self-sorted · removed · unresolved).
- **📅 A past season** — pick any archived season to see its helpers and demand.
- **🙌 A member** — use the *"Look up a member's help…"* picker to see one
  person's helper contribution, broken down by category.

Anyone can open it; it's always a private reply, so it never clutters a channel.

### `/help`
Shows the command list and who can use what (private reply).

---

## For officers
Usable by anyone with the **Manage Server** permission, **or** any role an
admin added as a manager role (see `/config` below).

### The one-click way (easiest)
Every request posts a **request card** with these buttons:
- **🙌 Claim** — flag that you're handling this one (optional). Your name shows on
  the card and next to the member's name on the board, so two officers don't
  double up. Click again to un-claim. It's informational only — it never blocks
  Sorted or Remove, and another officer can't steal an active claim. (If the
  officer who claimed it has since left the server, the next officer to click
  Claim takes it over automatically.)
- **✅ Sorted** — marks that member sorted. The card updates to show who sorted
  them, the board updates, and the member gets a DM.
- **🗑️ Remove** — removes the entry (e.g. posted by mistake).

### Or use commands
- `/helped` — run it with no options for a **picker**: choose the member, then
  pick from *only the requests they're actually waiting on* (no more "no pending
  entry" dead-ends), one click marks them sorted and DMs them. You can still pass
  `@member <category>` directly.
- `/remove` — same picker (choose member → their open request), removes without
  marking done. Direct `@member <category>` still works.
- `/board` — post the live board in the current channel and pin it.
- `/reset` — quick-close the board for a new season (archives the season's totals
  for `/stats`). It now **asks you to confirm** first (it's irreversible and closes
  every pending request). The new season starts unnamed — name it with `/season`.

---

## For officers — seasons
`/season` opens a private control panel for the seasons your board tracks.

- **Start a new season** — archives the current season (its totals stay in
  `/stats`), clears the board, and asks you to type a name for the fresh season
  (e.g. `Season 5 — Winter`). This is the same close-and-reset as `/reset`, but
  it names the new season in one step.
- **Rename current** — give the running season a name, or fix a typo, without
  closing anything.
- **View a past season** — pick any archived season from the dropdown to see its
  totals; you can rename it from there too.

`/reset` still works as the quick close if you don't need to name the season
right away.

---

## For admins — settings
`/config` is only available to members with the **Manage Server** permission.

### `/config roles`
Opens a **manager-roles panel**: it lists the current manager roles and the notify
role, with a role picker to **add** a manager role, a menu to **remove** one, and a
picker to set (or clear) the **notify** role — all in one place, updating live. The
direct commands still work too:
- `/config addrole @role` — lets everyone with that role use the officer actions
  (no Manage Server needed). Add your `Officers` and `LEADER` roles.
- `/config removerole @role` — stops a role from managing the board.
- `/config notify @role` — pings that role on new request cards (empty = off).

### `/config category add [label] [emoji]`
Add a new help category (or update one — same name updates its emoji, and re-adding
an archived one brings it back). Run it with no options for a **form**, or pass them
directly: `/config category add Guild Boss 👹`.

### `/config category remove <category> [moveto]`
Archive a category. If it still has open requests you must pass **moveto** to move
them to another active category first; the archived category keeps rendering in old
stats and on already-sorted cards. You can't remove the last active category.

### `/config category list`
Shows the active and archived categories.

### `/config nudge set #channel [hours]`
Turns on **stale nudges**: once a day, if any request has been waiting longer
than the threshold, the bot posts a short reminder digest (grouped by category)
to that channel and pings your notify role once. `hours` is optional — the
threshold defaults to **48** and stays whatever you last set. Example:
`/config nudge set #officer-chat 24`.

### `/config nudge off`
Turns stale nudges back off (your threshold is remembered for next time).

### `/config nudge status`
Shows whether nudges are on, which channel, the threshold, and when the next
digest is eligible.

> Nudges are **off until you set a channel**, only **remind** (they never remove
> anything), and post **at most once a day** — so they won't spam officers.

> If no manager roles are set, only members with **Manage Server** can manage
> the board — so you can never lock yourself out.

---

## Typical setup (once)
1. An admin runs `/config addrole @Officers` and `/config addrole @LEADER`.
2. (Optional) `/config notify @Officers` so officers get pinged on new requests.
3. An admin (or officer) runs `/board` in the channel you want the board in.
4. Members use `/needhelp` when they need help; officers hit **✅ Sorted** on the
   card (or use `/helped`) once they've sorted someone.

That's it — the board takes care of the rest.
