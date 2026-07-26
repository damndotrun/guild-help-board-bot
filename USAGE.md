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

You'll get a private confirmation, and your name appears in the **Waiting**
list on the board. You can only be on the board once per category at a time.

### `/help`
Shows the command list and who can use what. The reply is private (only you
see it).

---

## For officers
Usable by anyone with the **Manage Server** permission, **or** any role an
admin has added as a manager role (see `/config` below).

### `/helped @member <category>`
Marks that member as **sorted** for the category. Their name moves to the
**Sorted** section (struck through) and the waiting count drops.

### `/remove @member <category>`
Removes a member's waiting entry **without** marking it sorted — use this to
fix mistakes (wrong category, added by accident, etc.).

### `/board`
Posts the live board in the **current channel** and pins it. From then on,
that message updates automatically whenever anyone uses `/needhelp`,
`/helped`, `/remove`, or `/reset`. Running `/board` again in another channel
moves the board there and retires the old one.

### `/reset`
Clears the whole board for a new season. (Removes all entries.)

---

## For admins — set up who counts as an "officer"
`/config` is only available to members with the **Manage Server** permission.

### `/config addrole @role`
Lets everyone with that role use the officer commands above — no Manage Server
permission needed. Add your `Officers` and `LEADER` roles here.

### `/config removerole @role`
Stops a role from managing the board.

### `/config roles`
Lists the roles that currently count as managers.

> If no manager roles are set, only members with **Manage Server** can manage
> the board — so you can never lock yourself out.

---

## Typical setup (once)
1. An admin runs `/config addrole @Officers` and `/config addrole @LEADER`.
2. An admin (or officer) runs `/board` in the channel you want the board in.
3. Members use `/needhelp` when they need help; officers use `/helped` once
   they've sorted someone.

That's it — the board takes care of the rest.
