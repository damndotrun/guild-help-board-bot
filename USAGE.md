# 🛡️ Guild Help Board — User Guide

A simple bot that tracks who in the guild needs help hitting **Season Run 5K**
or **MVP 5K** each season, and lets officers mark them as **sorted** once
they've been helped. It keeps a single live board message in a channel that
updates automatically.

> Tip: type `/help` in Discord any time to see a short version of this.

---

## For everyone

### `/needhelp`
Add yourself to the board when you need help this season.
- **category** (required): `Season Run 5K` or `MVP 5K`
- **note** (optional): a short detail, e.g. `3 more hammers needed`

You'll get a private confirmation, your name appears in the **Waiting** list on
the board (with how long you've been waiting), and a small **request card**
with buttons is posted so officers can sort you with one click.

### `/imsorted`
Take yourself off the board once you've been helped.
- **category** (optional): remove just that one, or leave empty to remove all
  of your waiting entries.

### `/stats`
Season dashboard (private reply): how many are waiting and sorted per category,
the **average wait time**, the **top helpers** leaderboard, and last season's
total.

### `/help`
Shows the command list and who can use what (private reply).

---

## For officers
Usable by anyone with the **Manage Server** permission, **or** any role an
admin added as a manager role (see `/config` below).

### The one-click way (easiest)
Every `/needhelp` posts a **request card** with two buttons:
- **✅ Sorted** — marks that member sorted. The card updates to show who sorted
  them, the board updates, and the member gets a DM.
- **🗑️ Remove** — removes the entry (e.g. posted by mistake).

### Or use commands
- `/helped @member <category>` — mark a member as sorted (also DMs them).
- `/remove @member <category>` — remove an entry without marking it done.
- `/board` — post the live board in the current channel and pin it.
- `/reset` — clear the board for a new season (archives the season's totals for
  `/stats`).

---

## For admins — settings
`/config` is only available to members with the **Manage Server** permission.

### `/config addrole @role`
Lets everyone with that role use the officer actions above — no Manage Server
permission needed. Add your `Officers` and `LEADER` roles here.

### `/config removerole @role`
Stops a role from managing the board.

### `/config notify @role`
Pings that role on the request card whenever someone new asks for help. Run it
with no role to turn pings off.

### `/config roles`
Shows the current manager roles and the notify setting.

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
