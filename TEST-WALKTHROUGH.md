# ✅ Guild Help Board — Manual Test Walkthrough

A click-through checklist to verify the live bot end to end. The code has unit
tests for the pure logic, but every **interactive** path (buttons, panels,
modals, role/user pickers, DMs) can only be checked by hand — that's what this is.

Work top to bottom; each phase leaves the board in a state the next one uses.
Each item is **Do → Expect**. Tick the box when it matches.

---

## Before you start

- **Bot online:** `/help` responds.
- **You have Manage Server** (or a manager role) — so you can use officer actions.
- **A test channel** you don't mind posting in.
- **A second account helps** (an alt, or a friend) for the member side and to
  confirm DMs — a few checks need someone *other than an officer*. Where one is
  needed it's marked **(2nd account)**.
- **⚠️ marks irreversible steps** (they close the season / wipe the board). The
  current season's totals are archived into `/stats`, not lost — but pending
  requests are closed. Do the season phase when you're okay resetting, or on a
  fresh test season.

> Tip: keep the pinned **board** message and one **request card** visible on
> screen — most checks are "did the board/card update?".

---

## Phase 0 — Setup & permissions

- [ ] **`/help`** → private (ephemeral) reply listing commands and who can use what.
- [ ] **`/config addrole @Officers`** (and `@LEADER` if used) → confirms the role
      can now use officer actions.
- [ ] **(2nd account, non-officer) `/helped @someone`** → refused / "you can't use
      this" — confirms non-officers are blocked.
- [ ] **`/board`** in your test channel → an embed is posted **and pinned**; it
      shows empty/near-empty lists.

---

## Phase 1 — A member gets on the board

- [ ] **`/needhelp`** → start typing the **category**: an autocomplete list appears
      (`Season Run 5K` / `MVP 5K` by default). Pick one, add a **note** like
      `3 more hammers`. → private confirmation.
- [ ] **The board updates**: your name appears under **Waiting** with a "how long
      ago" timestamp, and the note/category is shown.
- [ ] **A request card** is posted (a message with **🙌 Claim / ✅ Sorted /
      🗑️ Remove** buttons).
- [ ] **If you set a notify role** (`/config notify @Officers`): the card ping
      mentions that role. (Set it now if you haven't, then post another request to
      check.)
- [ ] **The board button:** click **🙋 Need help** on the pinned board → a private
      category menu appears → pick one → you're added **instantly** (no typing),
      same as `/needhelp` without a note.

---

## Phase 2 — Officer actions on the card

Use a request card from Phase 1.

- [ ] **🙌 Claim** → your name shows on the card *and* next to the member on the
      board. → click **🙌 Claim again** → the claim clears.
- [ ] **(2nd officer, optional)** while you hold a claim, have another officer click
      **Claim** → it should **not** steal yours (claim is protected).
- [ ] **✅ Sorted** → the card updates to "sorted by <you>", the **board** drops
      them from Waiting (or moves to Sorted), and **the member gets a DM**
      *(2nd account to confirm the DM)*.
- [ ] **🗑️ Remove** (on a *different* test request) → the entry disappears from the
      board and the card reflects removal. It does **not** count as "helped".

---

## Phase 3 — Officer commands (the typed way)

- [ ] **`/helped`** with **no options** → a picker: choose the member, then a second
      menu shows **only the requests they're actually waiting on**. Pick one → they're
      marked sorted + DM'd.
- [ ] **`/helped @member category:…`** (direct) → same result without the picker.
- [ ] **`/remove`** with **no options** → same two-step picker (member → their open
      request) → removes it (no "helped" credit).
- [ ] **`/remove @member category:…`** (direct) → same.

---

## Phase 4 — Self-service removal (member side)

- [ ] **(2nd account)** add two requests, then run **`/imsorted`** with **no
      options** → a private picker lists **your own** open requests. Tick one →
      it closes.
- [ ] **`/imsorted`** again → hit **Close all** → all your open requests close at
      once.
- [ ] **`/imsorted category:…`** (direct) → closes just that one.

---

## Phase 5 — Seasons ⚠️

- [ ] **`/reset`** → a **confirm** dialog appears (Confirm / Cancel). Click
      **Cancel** → nothing happens, board unchanged.
- [ ] **`/reset` → Confirm** ⚠️ → all pending requests close, the board resets, the
      season's totals are archived for `/stats`. The new season is **unnamed**.
- [ ] **`/season` → Start a new season** → shows a **destructive warning**, then asks
      you to **type a name** (e.g. `Test Season 2`) → board resets, new season named.
- [ ] **`/season` → Rename current** → type a new name → the running season is
      renamed, nothing closed.
- [ ] **`/season` → View a past season** → pick an archived season from the dropdown
      → its totals show; **rename it from there** and confirm it sticks.

---

## Phase 6 — Stats

Open **`/stats`** (private) and switch views from the dropdowns — no need to
re-run the command:

- [ ] **📊 Current season** → waiting vs sorted per category, **average wait**, top
      helpers.
- [ ] **🏆 All-time** → top helpers across seasons, per-category counts, demand
      summary (sorted · self-sorted · removed · unresolved).
- [ ] **📅 A past season** → pick one from Phase 5 → its helpers/demand show.
- [ ] **🙌 A member** → use the member picker → that person's helper contribution,
      broken down by category.

---

## Phase 7 — Config: roles & categories

- [ ] **`/config roles`** → panel lists current manager roles + notify role, with
      pickers. Use it to **add** a manager role, **remove** one, and **set then
      clear** the notify role → the panel updates live each time.
- [ ] **`/config category add`** with **no options** → a **form (modal)** opens →
      enter a label + emoji → the category is added.
- [ ] **`/config category add Guild Boss 👹`** (direct) → added without the form.
- [ ] **`/config category add`** with an **existing** name + a new emoji → updates
      the emoji (doesn't duplicate).
- [ ] **`/config category remove <category>`** on a category **with no open
      requests** → archived.
- [ ] **`/config category remove <category>`** on one **with open requests** →
      blocked until you pass **`moveto:<other>`** → then it reassigns the requests
      and archives.
- [ ] **Try to remove the last active category** → refused ("can't remove the last
      one").
- [ ] **`/config category list`** → shows active and archived categories.

---

## Phase 8 — Stale nudges

The daily digest timing can't be forced by hand, but the switch and status can:

- [ ] **`/config nudge set #some-channel 24`** → confirms nudges on, channel + 24h
      threshold.
- [ ] **`/config nudge status`** → shows **on**, the channel, threshold, and when the
      next digest is eligible.
- [ ] **`/config nudge off`** → confirms off; **`/config nudge status`** now shows off
      (threshold remembered).

---

## Phase 9 — Edge cases (optional, advanced)

- [ ] **Board re-post:** run **`/board`** in a *different* channel → a new pinned
      board appears there and the **old one is retired** (no longer updates).
- [ ] **Member left fallback:** if a test account leaves the server while it has an
      entry, its name should still render (stored fallback), not crash.
- [ ] **Claim takeover:** if the officer who claimed a request leaves the server,
      the next officer to click **Claim** takes it over.
- [ ] **Mention safety:** set a nickname containing `@everyone`, then `/needhelp` →
      the board/card must **not** actually ping everyone (mentions are neutralised).
- [ ] **Long board:** add many requests (10+) → the board truncates gracefully with
      a "…and N more" line rather than breaking.

---

## What this can't cover by hand

These are verified in code / at the host, not clickable here — listed so you know
they're intentionally skipped:

- **Daily nudge tick** actually firing on schedule (only the on/off/status is
  checkable manually).
- **Corrupt-file recovery** and the **`data.json.bak`** restore (host-level; the
  bot recovers automatically).
- **Single-instance lock** (only relevant if two copies run against one file —
  don't).

---

### If something fails

Note the **step**, what you saw vs. **Expect**, and any error message the bot
showed. That's enough to reproduce and fix. Most "nothing happened" cases are
either a **permission** issue (see Phase 0) or the **board was moved** (re-run
`/board`).
