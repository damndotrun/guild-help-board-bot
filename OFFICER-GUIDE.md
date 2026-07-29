# 🛡️ Guild Help Board — Officer & Admin Guide

Everything you need to run the help board day to day. This is written for
**officers and admins** — the people who sort requests, manage seasons, and
configure the bot. (Members only need `/help` or the short **[USAGE.md](USAGE.md)**.)

> **In a hurry?** Jump to the [Quick reference](#quick-reference) at the bottom.
> **Something broken?** See [Troubleshooting](#troubleshooting).

---

## What the bot does

Members flag that they need help hitting a season goal (e.g. *Season Run 5K*).
Each request shows up in two places:

1. On the **live board** — one pinned message that updates itself.
2. As a **request card** — a small message with buttons, so you can action it
   in one click.

You (the officer) mark people **sorted** once they've been helped. The bot keeps
the board tidy, DMs the member, and tracks stats. There's no database — it all
lives in one file the host keeps safe.

**Who counts as an officer?** Anyone with the **Manage Server** permission, **or**
anyone holding a role an admin added with `/config addrole`. If no manager role
is set yet, only Manage Server works — you can't lock yourself out.

---

## Daily operations

This is 95% of the job: someone asks for help, you sort them.

### When a request comes in

A **request card** is posted with three buttons:

| Button | What it does | Notes |
|---|---|---|
| **🙌 Claim** | Flags that *you're* handling this one | Optional. Your name shows on the card and next to the member on the board, so two officers don't double up. Click again to un-claim. |
| **✅ Sorted** | Marks the member as sorted | The card updates to show who sorted them, the board updates, and the member gets a DM. |
| **🗑️ Remove** | Removes the entry entirely | Use for mistakes (posted twice, wrong category). Does **not** count as "helped". |

**About Claim (optional but handy):** it's informational only — it never blocks
Sorted or Remove, and another officer **can't steal** your active claim. If the
officer who claimed a request has since **left the server**, the next officer to
click Claim takes it over automatically.

### Sorting someone

- **Easiest:** click **✅ Sorted** on their request card.
- **By command:** `/helped` — run it with **no options** and you get a picker:
  choose the member, then pick from *only the requests they're actually waiting
  on*. One click sorts them and DMs them.
- You can still type it directly: `/helped @member category:…`

### Removing a bad entry

- Click **🗑️ Remove** on the card, **or**
- `/remove` — same picker as `/helped` (choose member → their open request).
  Removes without marking it done. `/remove @member category:…` also works.

Use **Remove** for mistakes; use **Sorted** when the person was actually helped.
Only Sorted counts toward the helper leaderboard.

### Seeing the board

- `/board` — posts the live board in the **current channel** and pins it.
  Running it again moves the board to wherever you run it (the old one is retired).

---

## Seasons

When a season ends, you close the board and start fresh. Past totals are kept for
`/stats`.

### The quick way — `/reset`

Closes every pending request and archives the season's totals. **It asks you to
confirm first** (it's irreversible). The new season starts **unnamed** — name it
afterwards with `/season` if you want.

### The full way — `/season`

Opens a private control panel:

- **Start a new season** — same close-and-reset as `/reset`, but it asks you to
  **type a name** for the fresh season in one step (e.g. `Season 5 — Winter`).
- **Rename current** — name the running season, or fix a typo, without closing
  anything.
- **View a past season** — pick any archived season to see its totals; you can
  rename it from there too.

> **Rule of thumb:** use `/season → Start a new season` when you want to name the
> new season right away; use `/reset` for a quick close you'll name later (or not
> at all).

---

## Stats — `/stats`

A private, navigable panel (anyone can open it; it never clutters a channel).
Switch views from the dropdowns without re-running the command:

- **📊 Current season** — waiting vs sorted per category, average wait time, top
  helpers.
- **🏆 All-time** — top helpers across every season, per-category counts, and a
  demand summary (sorted · self-sorted · removed · unresolved).
- **📅 A past season** — pick any archived season.
- **🙌 A member** — look up one person's helper contribution, by category.

---

## Admin — first-time setup

Do this **once** (needs **Manage Server**):

1. `/config addrole @Officers` and `/config addrole @LEADER` — let those roles use
   the officer actions without Manage Server.
2. *(Optional)* `/config notify @Officers` — ping officers on every new request.
3. `/board` in the channel you want the board in.

That's it — members use `/needhelp`, you hit **✅ Sorted**.

---

## Admin — settings (`/config`)

`/config` needs the **Manage Server** permission.

### Manager & notify roles — `/config roles`

Opens a panel that lists the current manager roles and notify role, with pickers
to **add** a manager role, **remove** one, and **set/clear** the notify role — all
live, in one place. Direct commands still work:

- `/config addrole @role` — lets that role use officer actions.
- `/config removerole @role` — stops a role from managing.
- `/config notify @role` — pings that role on new request cards (empty = off).

### Categories

- `/config category add` — run with **no options** for a form, or pass them
  directly: `/config category add Guild Boss 👹`. Adding an existing name updates
  its emoji; re-adding an archived one brings it back.
- `/config category remove <category> [moveto]` — archives a category. If it still
  has **open requests**, you must pass **moveto** to move them to another active
  category first. You can't remove the last active category. Archived categories
  still show in old stats and on already-sorted cards.
- `/config category list` — shows active and archived categories.

### Stale nudges (off by default)

Reminds officers about requests that have been waiting too long. It only
**reminds** — it never removes anything — and posts **at most once a day**.

- `/config nudge set #channel [hours]` — turns it on. Once a day, if any request
  is older than the threshold, the bot posts a short digest (grouped by category)
  to that channel and pings your notify role once. `hours` is optional (defaults
  to **48**, remembers your last value). Example: `/config nudge set #officer-chat 24`.
- `/config nudge off` — turns it off (your threshold is remembered).
- `/config nudge status` — shows whether it's on, the channel, threshold, and when
  the next digest is eligible.

---

## Troubleshooting

**The board isn't updating / I can't find it.**
Run `/board` in the channel you want it in. This posts a fresh pinned board and
retires the old one. The board updates automatically after that.

**The officer buttons / commands do nothing for someone.**
They're not recognised as an officer. Give them **Manage Server**, or add a role
they hold with `/config addrole @role`. Check `/config roles` to see the current
manager roles.

**A member's name shows as an ID or "unknown".**
They've left the server. The bot falls back to the stored name; there's nothing to
fix. Any claim they held can be taken over by the next officer who clicks **Claim**.

**"You can't remove the last active category."**
Add another category first (`/config category add …`), then remove the old one.

**Removing a category is blocked because it has open requests.**
Pass **moveto**: `/config category remove OldCat moveto:NewCat` — this reassigns
the open requests, then archives the category.

**Nudges aren't posting.**
They're **off until you set a channel** (`/config nudge set #channel`), only fire
if something is older than the threshold, and post **at most once a day**. Check
`/config nudge status` for the channel, threshold, and next-eligible time.

**A member didn't get their "sorted" DM.**
They have DMs from server members turned off. The sort still went through — nothing
to fix on the bot side.

**⚠️ Never roll the bot back to an older version.** Newer builds save fields older
ones don't know about (stats records, nudge settings) — an older build drops them
on its first save. If a rollback is unavoidable, restore `data.json` from the
`data.json.bak` sidecar first.

---

## Quick reference

| I want to… | Do this |
|---|---|
| Sort someone who was helped | **✅ Sorted** on their card, or `/helped` |
| Say I'm handling a request | **🙌 Claim** on the card (optional) |
| Remove a mistaken entry | **🗑️ Remove** on the card, or `/remove` |
| Post / move the live board | `/board` in the target channel |
| End the season (quick) | `/reset` (confirm) |
| End the season (named) | `/season → Start a new season` |
| Rename a season | `/season → Rename current` (or a past one) |
| See stats | `/stats` |
| Let a role act as officer | `/config addrole @role` (or `/config roles`) |
| Ping a role on new requests | `/config notify @role` |
| Add / remove a category | `/config category add` / `… remove <cat> [moveto]` |
| Turn on stale reminders | `/config nudge set #channel [hours]` |

> **Members** only need `/needhelp` (or the **🙋 Need help** board button) and
> `/imsorted`. Point them at `/help` or **[USAGE.md](USAGE.md)**.
