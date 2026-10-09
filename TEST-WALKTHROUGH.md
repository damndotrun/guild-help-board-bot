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

## Phase 11 — Web admin in a browser (M3, test server)

Against the `dev` bot at **https://bot-test.damndot.run**. You need your owner
account, an account that only holds a manager role (**officer account**) and
the **2nd account** without one. Use a phone for the last block.

**Sign-in**
- [ ] Open the address → **Sign in with Discord** → Discord asks to authorize
      **BB Bot Test** (first time only) → back on **Help board › Overview**; the
      header shows **BB Test**, **Owner** and your name.
- [ ] **Sign out** → the sign-in page. Sign in again → straight back, no
      consent screen this time.
- [ ] **(2nd account)** sign in → "This page is for officers and owners." with a
      **Sign out** button and no sidebar.
- [ ] In Discord, `/menu` as an officer → a **Web admin** button that opens the
      address; the 2nd account has no such button.

**Officer account**
- [ ] Sidebar: Overview, Seasons, Stats, Teammates › Coming soon — **no**
      Categories / Settings. Typing `/help/settings` in the address bar →
      "Only members with Manage Server can change bot settings."
- [ ] Overview lists the open requests (have the 2nd account post one first)
      with waiting time and note.
- [ ] Stats: switch the view (current / all-time / a past season) — the page
      content changes while the header and sidebar stay in place.
- [ ] Seasons → rename the current season → "✓ Renamed to …"; the board in
      Discord shows it after its next refresh.

**Owner**
- [ ] ⚠️ Seasons → type a season name (it is required; an empty one gives "Give
      the new season a name.") → Start new season → a confirmation page with the
      waiting count → **Cancel** changes nothing → again → **Start new season** →
      "✓ Started season …"; the pending request cards in Discord say
      "Season reset — this request is closed."
- [ ] **Replay is refused.** Seasons → type a season name and press Start
      new season in **two tabs** (same name), so both show the confirmation page. Confirm in the first tab →
      "✓ Started season …". Then press **Start new season** in the second tab
      → "✕ Already done or changed — nothing happened." and **no** second
      season was started. (Pressing **Back** to an old confirmation page and
      confirming again, or double-clicking the button, ends the same way.)
- [ ] ⚠️ Seasons → Reset season → confirmation → confirm → "✓ Season reset — the board is cleared."
- [ ] Leave a confirmation page open **6 minutes**, then confirm → "This
      confirmation expired — review and confirm again."; nothing changed.
- [ ] Categories → add "Web test" with an emoji → it appears on the board's
      Need help buttons. Post a request in it (2nd account), then archive it
      with **Move open requests to** → the confirmation says where it moves →
      confirm → the request card shows the new category. Press **Back** to the
      confirmation and confirm again → "Already done or changed — nothing
      happened."
- [ ] Settings → **Manager roles**: remove the manager role the officer account
      holds → on its next click the officer account gets the 403 page. **Add
      that role back** (pick it in the list) → the officer pages return on its
      next click. (The officer must have the role again before the
      "Demotion while signed in" step below.) Notify
      role → pick a role → a new request pings it; set it back to **Off — no
      ping** (an explicit choice in the list). Nudge → a channel + 1 hour →
      "✓ Stale nudges on …"; **Turn off**.
- [ ] Every change shows **one** green line at the top; a refused one (e.g. a
      category named just `!!!`) shows **one** red line and changes nothing.

**Demotion while signed in**
- [ ] Signed in as the officer account, have the owner take the manager role
      away in Discord → within about a minute the next click shows the 403 page.

**Phone**
- [ ] The sidebar is a **Menu** drop-down at the top; tables turn into cards;
      buttons are easy to tap; nothing scrolls sideways.

---

## Phase 12 — Teammate finder (M4, test server)

Against the test bot with `MODULES=help,lfg`, in **🔍︱looking-for-game**. You
need **two accounts** (A = owner, B = `testkaf_`); both hold `⚔ GM-PING` and
B holds `💥 SUP`. Phone block last.

**Channel**
- [ ] The channel shows, bottom to top: the board ("No one is looking right
      now."), above it the grey **Want a game?** panel with **Start my own
      search** and **Pick your roles…**, above that the banner image.
- [ ] **(B)** Type in the channel → not allowed (only the bot posts here).

**Roles**
- [ ] **(B)** **Pick your roles…** → `BASIC · DPS` → an ephemeral **Menu ›
      Teammates › My roles** with "Added: 💥 DPS", the list pre-selected; the
      public picker is empty again. Pick `BASIC · DPS` again → "Removed".
- [ ] **(B)** In that screen pick only `BASIC · SUP` in the list → the screen
      updates with "Removed: …"; pick again right away → it reacts at once (no
      frozen list); **Notifications** opens from there.

**A search, now**
- [ ] **(A)** **Start my own search** → the modal (Looking for · Starts in ·
      Note) → `BASIC · SUP`, empty, "gg" → "Your search is live — your thread:
      #…". A private thread opened with A only: intro line + **Requests** (0).
- [ ] Under the board a ping `@💥 SUP **A** is looking for **BASIC · SUP** ·
      now` → it disappears after about a minute.
- [ ] The board shows a teal **Now** box: `💥 **BASIC · SUP** · **A**`,
      `now · gg`, **Join**.
- [ ] **(B)** **Join** → "Request sent to **A** — you're #1 in line…" +
      **Cancel request**. B gets ONE DM card, silently (no sound): **Your
      request** + Cancel, **Start my own search**.
- [ ] **(A)** The thread: "<@A> **B** wants to join · 1 waiting"; the panel
      lists **1 · B** with **Accept**. The board: "1 interested".
- [ ] **(B)** Join again → "You already asked… #1".

**Accept and confirm**
- [ ] **(A)** **Accept** → B is added to the thread; "WAKEY-WAKEY! @A you
      accepted **B**…" with an amber **Confirm 0 / 2** box and a green **I'm
      here**. B's DM card is replaced by a new one with sound: **You're in!**
      (A's avatar) + the Confirm box + **Open the thread**.
- [ ] **(B)** **I'm here** on the DM card → the box shows "B ✓" in the thread
      and on the card (1 / 2).
- [ ] Wait a minute → A gets "<@A> — tap I'm here when you're ready." in the
      thread (the previous one deleted).
- [ ] **(A)** **I'm here** in the thread → "✓ Game on", a teal **Game on!**
      box with B's avatar; the board moves them to **Just started**; B's card
      shows "✓ Game on!". After 5 minutes they leave the board; the thread
      stays open.

**Deadlines**
- [ ] New search by A, B joins, A accepts, **only A** taps I'm here, wait 5
      minutes → B's card: red "You didn't confirm in time"; the thread's
      welcome turns red "…didn't confirm — your search is open again", B is
      removed from the thread, the search is back in **Now**.
- [ ] Same, but only B taps → after 5 minutes the search is cancelled: B's
      card "A didn't confirm"; the thread gets "Search closed — not confirmed in
      time." and is locked.
- [ ] **(A)** A timed search (Starts in `8`) → the **Timed** box with a
      countdown; B joins, A accepts → **Fixed**, the Confirm box says "You'll be
      asked to confirm 5 minutes before the start". At start − 5 min: "Heads up
      @A — your game starts in 5 minutes!" and B's card notifies again.

**Leaving**
- [ ] **(B)** Cancel on the card → no answer line (the tap is only
      acknowledged); the card itself updates silently to its empty state ("You
      have no open requests right now." + **Start my own search**) and is
      deleted about 24 hours later; the thread's Removed box shows "B —
      cancelled".
- [ ] **(A)** **Cancel search** (red) → "Search cancelled."; the thread gets
      "Search cancelled." and is locked; B's card: "A's search was cancelled".
- [ ] A now-search with no Accept → after 30 minutes: "Search expired.",
      locked; B's card: "…search expired".

**Busy rule**
- [ ] B has his own open search AND a request on A's; A accepts B, both tap
      I'm here → B's own search is cancelled (its thread locked), his other
      requests disappear; his card: "Your other requests were cancelled."

**Closed DMs (notices)**
- [ ] **(B)** Discord → Privacy → turn off DMs from server members. Join A's
      search → still "…Updates come in your DMs." (the bot only learns that the
      DMs are closed when a DM to B fails). A cancels → that card DM fails, so
      B's next **/menu › Teammates** shows "📬 A's search was cancelled · …"
      once; from then on a Join answers "…Your DMs are closed — check Menu ›
      Teammates."
- [ ] **(B)** Notifications → **Request updates by DM** Off → same path,
      news only in the menu. Turn it back On.

**Menu, officer, owner**
- [ ] `/menu` → **Teammates · N open** → Browse lists the open searches →
      pick one → "Request sent…".
- [ ] Notifications: **New searches by DM** On → when A posts a `BASIC · SUP`
      search, B gets a DM with a **Join** button. **GM pings** Off → B loses
      `⚔ GM-PING`.
- [ ] **(officer)** **Remove a search** → pick → removed; its requesters'
      cards say it was cancelled.
- [ ] **(A, owner)** With a permission removed from the bot in the channel and
      the bot restarted → the Teammates screen names the missing permission.

**Self-repair**
- [ ] Delete the board message by hand → within 30 s the blocks are back in
      order. Post as an admin under the board → within 30 s the blocks are
      re-posted below it.

**Phone**
- [ ] Every box is readable at phone width; badges sit at the right of the
      headers; **Join** / **Accept** / **I'm here** are easy to tap; the modal
      fits.

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
