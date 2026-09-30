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

## Phase 10 — `/menu` on a phone (M2b, test server)

Run this on the **BB Bot Test** server against the `dev` bot, **on the Discord
mobile app** — most members use a phone, and there is no documentation of how
Components V2 menus look there. You need your officer account **and a 2nd
account without a manager role** (every step marked **(2nd account)** needs
it, and the officer steps need a request the 2nd account has posted).

**Entry and layout**
- [ ] **`/menu`** → one message only you can see: **Menu**, "You: Owner"
      (you have Manage Server; an account that only holds the manager role
      shows "You: Officer"), a **Help board · N open** row with **Open**, and **How it works**. No
      "Web admin" button yet (no `PUBLIC_URL`).
- [ ] **Edits in place (engine check):** tap **Open**, then **← Back**, then
      **How it works** — the screen must change **in the same message** (no new
      message appears per tap, the old screen is gone). If every tap opens a
      new message instead, record it as a **finding**.
- [ ] **Board Menu button:** on the pinned board tap **Menu** (an existing
      board gains the button on its next refresh — post or sort a request if it
      is missing) → your own private menu appears; **the public board itself
      does not change** (ask the 2nd account to confirm it still looks the same
      for them, and that they see no menu of yours).
- [ ] **Mobile layout:** on the home, Help board, Officer, picker and
      confirmation screens — buttons readable and easy to tap, **no button row
      wraps or overflows**, no label is cut ("Repost board", "Mark helped",
      "How it works"), **← Back** is always the last row. Anything truncated or
      awkward → note the screen and a screenshot.
- [ ] **How it works** → the `/help` text; **← Back** → home.

**Member side (2nd account)**
- [ ] **Open** → Help board shows **Need help / I'm sorted / Stats** and Back —
      **no Officer row**.
- [ ] **Need help** → pick a category → back on the Help board with
      "✅ Request posted: …" and an **Add note** button; the card and the
      board update in the channel.
- [ ] **Add note** → a form → type a note → "✅ Note added."; the card and the
      board show the note.
- [ ] **Need help** the same category again → "⚠️ You're already on the board…".
- [ ] **I'm sorted** with one request → it closes at once ("✅ Marked 1 request
      sorted."), the card says "marked themselves sorted".
- [ ] Post two requests → **I'm sorted** → a picker + **Close all** → pick one →
      only that one closes.
- [ ] **Close all** → a confirmation (red **Close all** + **Cancel**) →
      **Cancel** returns to the **Help board** and closes nothing; **Close all**
      closes the rest.
- [ ] **Expired confirmation:** open the Close all confirmation, wait **6
      minutes**, tap it → "⚠️ That confirmation expired…" and a fresh
      confirmation; nothing closed.
- [ ] **Stats** → today's stats; switch the view in the select; look up a
      member → their stats, the view stays.
- [ ] **Forbidden officer action (2nd account):** there is no Officer row — the
      2nd account cannot reach Mark helped / Remove / Repost at all.

**Officer side**
- [ ] **Open** → the **Officer** row: Mark helped / Remove / Repost board.
- [ ] **Mark helped** — first have the **2nd account post a request** (Need
      help → a category). Then pick that account (one request) → "✅ <name>
      marked as helped." at once; the 2nd account gets the DM; the card is
      finalised. With two open requests → a request picker ("Pick which
      request…") comes first.
- [ ] **Remove** — have the **2nd account post a request** again first. Pick
      the account → a confirmation (red **Remove** + **Cancel**) → **Cancel**
      returns to the member picker and removes nothing; repeat and tap
      **Remove** → "✅ Removed <name>'s request."; the card says "Removed by".
- [ ] **Repost board** from a *different* channel → the board is posted and
      pinned there; the old one is retired.

**Role change while a menu is open (2nd account + officer)**
- [ ] Use an **officer account that does NOT have Manage Server** (the
      manager role only — with Manage Server the account stays Owner and is
      never demoted). With its menu open on the Help board, have the admin
      **remove that manager role** (it is now an ordinary member, like the 2nd
      account), then tap **Mark helped** (or any Officer button) → **refused**:
      it lands on home with "⚠️ You don't have access to that anymore…", the
      Officer row is gone, and **nothing was changed** (no request closed, no
      DM sent). Give the role back afterwards.

**Old menus and the legacy paths**
- [ ] **15+ minutes old:** open `/menu`, leave it on screen (don't dismiss) for
      **16+ minutes**, then tap a button (e.g. **Open**). Record what happens:
      it should still work (each tap has its own token); if Discord says
      "interaction failed", note it — `/menu` or the board's Menu button always
      gives a fresh one.
- [ ] Dismiss the menu, run `/menu` again → a fresh menu.
- [ ] The old paths still work: `/needhelp`, `/imsorted`, `/stats`, `/helped`,
      `/remove`, `/board`, the board's **Need help** button, the card buttons.
- [ ] `/config addrole @everyone` → refused ("You can't add @everyone…").

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
