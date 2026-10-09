# Developer notes — what changed & where

Hey Bogdan — this is your Guild Help Board bot, reviewed, hardened, extended,
and deployed. The help board is one file (`modules/help/help.js` — formerly
`index.js`, see the M1 note below; discord.js v14). This
doc is a map of what changed and where to look, plus a few invariants so the
tricky bits don't get re-broken.

---

## 2026-10-09 — M4 teammate finder (`lfg` module)

- **What:** the looking-for-game channel as a module (`MODULES=help,lfg`):
  bot-only channel blocks (banner · start panel with **Pick your roles…** ·
  live board · a 60-second ping), a one-modal search start, a private thread
  per search (auto-archive 3 days) with an in-order request panel and
  **Accept**, a live DM card per requester, a two-sided **I'm here** check-in
  (reminders, deadline, reopen), `/menu › Teammates`, and an append-only
  journal. Spec: `docs/superpowers/specs/2026-10-08-m4-teammate-finder-design.md`
  (local).
- **`modules/lfg/` code map:** `state.js` (pure state machine; every change
  pushes `out.events` + `out.log`; `advance(data, now)` is the tick),
  `store.js` (`lfg.json` via `ctx.store`, `lfg-log.jsonl` journal),
  `actions.js` (every write, help's contract; `join` refuses a search whose
  thread is not open yet), `effects.js` (plays the events after a save: thread
  lines, welcome/confirm, panel, DM cards, board; `afterCreate`; `tick`),
  `render.js` (pure V2 payloads, `fitRows`; the Just started / Fixed boxes and
  the accepted DM card are cut with "+N more"), `channel.js` (blocks, tail
  check, ping — one writer; an empty or foreign-only history skips the tail
  check instead of looping reposts; `repost` persists the block ids one by
  one), `discord.js` (REST glue, `deliverCard` — one queue per member, and
  `deleteStaleCard` on the same queue; `openThread` deletes the thread again
  if adding a member fails; the DM card is replaced only on 10008 = deleted by
  hand — any other edit error leaves the state untouched; the new-search DM
  role check is a forced REST member fetch; `ManageRoles` is read from the
  guild permissions, the rest from the channel; `ReadMessageHistory` is needed
  for the tail check), `menu.js` / `buttons.js` (role screens show the state
  from the action result — with the Guilds-only intent the member cache is
  stale; news is consumed only once its screen is ready; the role picker
  answers with a plain fallback if the screen cannot be built), `seed.js`
  (MEE6 layout by name, permission check), `texts.js` (all copy, `textOf` for
  the M5 overrides). Core: `core/text.js` (shared `hasUnprintable`),
  `core/panel.js` `messageErrors` (the V2 limits for module messages).
- **Invariants (keep them):**
  10. lfg: no `await` between `store.load()` and `store.save()` in an action;
      REST only in the returned `effects`, after the interaction is answered.
  11. lfg: the thread is part of a search — no thread → `cancelled`
      (`thread_failed`); the ping and the new-search DMs only after a thread.
  12. lfg: Accept and the second **I'm here** are synchronous single saves —
      two Accepts: the first wins; `started` and the busy rule (other requests
      withdrawn, own search cancelled, an accept elsewhere reopened) land in
      ONE save. Nobody is busy before `started`.
  13. lfg: every way a search leaves `listings` writes one `listing` journal
      line; every request change writes a `request` line.
  14. lfg: one channel writer (`channel.enqueue`) and one DM-card queue per
      member (`deliverCard`, `deleteStaleCard`) — never call
      `channel.send`/`user.send` for these around them.
  15. lfg: pings are explicit — the ping message `{ roles }`, thread lines
      `{ users }`; everything else `{ parse: [] }`.
  16. lfg: what is NOT crash-safe — the state is saved first, the Discord
      side (`effects`) runs after, and nothing replays the events. A restart
      between the two loses that batch: thread closing lines and locks, the
      WAKEY / Game on! messages, DM-card news. Only the board (tick `sync`) and
      a search left without a thread (dropped after 2 min, `thread_failed`)
      heal themselves; the rest stays as it was until the next event touches
      it.
  17. lfg: every re-rendered select gets a fresh `custom_id`
      (`render.renderTag()`, like help's `rolesRenderTag`) — an identical
      one freezes in the client.
  18. lfg: every public/DM payload goes through `render.fitRows` →
      `messageErrors(..., { prefixes: ["lfg:", "menu:"] })`; colours only on
      container stripes; buttons Secondary except I'm here (Success) and
      Cancel search (Danger).

## 2026-10-09 — `/config roles` select no longer freezes after a refusal

- Live bug: after a refused pick (e.g. a bot-managed role) the panel came back
  with the very same select (same `custom_id`); the Discord client kept it in
  its loading state for ~15 s and the next valid pick never reached the bot.
  The panel's three selects now carry a per-render tag
  (`roles:add|remove|notify:<tag>`, `rolesRenderTag()` in `help.js`), so every
  re-render is a new select for the client. The dispatcher routes on the part
  after `roles:`, so panels still open with the old bare ids keep working. The
  `roles:notifyclear` button is unchanged (a button holds no picked value).

## 2026-10-08 — Review fixes (M0–M3 review)

- **Data files:** an unreadable `data.json` (help `loadData`) or module file
  (`core/store.js`) is copied to `<file>.corrupt-<mtime>` once, before the next
  save renames over it; a missing primary next to a valid `.bak` loads the
  `.bak` (it used to be overwritten two saves later). `index.js` exits before
  any side effect when `DATA_DIR` is not a writable directory, and releases
  `bot.lock` when the start fails later; `releaseLock` only removes a lock that
  is still this process's (pid + `startedTs`). `core/loader.js`: `dataFile` is
  a plain `<name>.json`, never `data.json` / `web-sessions.json` /
  `package*.json`, and never shared by two modules. `PUBLIC_URL` with a
  backslash is refused (URL parsing reads `\` as `/` — a path in disguise).
  The `.corrupt-*` copies are never deleted by the bot: remove them by hand
  once looked at.
- **Board refresh:** `refreshBoard` reads `data.json` again right before
  `message.edit` (the argument is ignored) — an older snapshot from a slow
  effect could otherwise drop a newer request from the public board.
- **Discord interactions:** the request card's Claim button calls
  `deferUpdate()` before the claimer's member lookup (it can wait on a rate
  limit past the 3-second window) and then edits with `editReply` and tells
  privately with `followUp`; unknown help buttons / selects / modals answer
  "Unknown action."; the roles panel and `/stats` views send `content: ""` so
  an earlier refusal line doesn't stay; `core/perms` `memberRoles()` reads a
  raw API member's role-id array (an interaction before the guild is cached).
- **Web sign-out is server-side:** the session carries `iat`;
  `web/session.js` `createSignOuts` keeps each user's last sign-out time in
  `DATA_DIR/web-sessions.json` (`core/store`), and `server.js` `signedInUser`
  treats any session issued before it as signed out — every browser and any
  copied cookie, not only the one that pressed Sign out.

## 2026-10-08 — Discord platform changes (obfuscated channels, modal Labels)

- **Hidden channels in the web admin:** from 2026-11-16 Discord sends the
  channels a bot cannot view *obfuscated* (channel flag `CHANNEL_OBFUSCATED`,
  `1 << 17`; name `___hidden___`, most fields stripped). `help.botCanSee` /
  `help.botCanPostDigest` (`modules/help/help.js`) check the flag, then the
  bot's own permissions (View Channel; + Send Messages and Embed Links for the
  digest). The web Settings nudge list offers only channels the digest can be
  posted in (so the POST refuses the rest), and `/config nudge set` refuses
  them too. If the configured channel is lost, the page names it
  "(hidden channel)" / "(deleted channel)" (never `___hidden___`), shows a
  red notice, and the picker starts on "Pick a channel" instead of silently
  pre-selecting another one.
- **Modals use Label components:** the three legacy modals in
  `modules/help/help.js` (new season, rename season, `/config category add`)
  wrap each text input in a `LabelBuilder` (`addLabelComponents`) instead of
  an `ActionRow` holding a labelled `TextInput` — the pattern `/menu`'s note
  modal already uses. Custom ids and `fields.getTextInputValue` are unchanged.

## 2026-10-01 — M3 web admin

- **What:** officers and owners manage the help board in a browser —
  Overview, Seasons, Stats (officers) and Categories, Settings (owners).
  Sign-in with Discord (OAuth `identify`); the bot decides the level from the
  member's live roles on every request (`guild.members.fetch({ user, force: true })`,
  60 s cache). **Off unless configured** (`PUBLIC_URL`, `WEB_PORT`,
  `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`; any of `WEB_PORT` /
  `DISCORD_CLIENT_SECRET` / `SESSION_SECRET` set → all four required,
  `PUBLIC_URL` alone only adds the `/menu` button; `core/config.js`
  `parseWebConfig`): without them the bot runs exactly as before and never
  loads Express. A `SESSION_SECRET` containing whitespace is refused (a
  pasted placeholder or example line, not a generated secret); `.env.example`
  ships it empty.
- **`web/` code map:** `server.js` (Express 5 app: helmet CSP, sessions, CSRF
  guard, sign-in routes, officer gate, layout, error pages, module mounting;
  `startWeb`), `oauth.js`, `access.js` (live level + cache), `session.js`
  (cookie-session, server-side rolling expiry, OAuth state, notice),
  `security.js` (`TRUST_PROXY`, `sameOriginGuard`, token-exchange limiters:
  `perClientLimiter` keyed on `req.ip`, 10/min, bounded map, checked before
  the process-wide `fixedWindowLimiter`, 30/min;
  `field`), `context.js` (what a module's `web.routes(router, web)` gets:
  `render`, `done`, `confirmed`, `changed`, `requireLevel`, `actor`, `field`,
  `forgetLevels`, `withDeadline` + its ctx; the exported `withDeadline` is the
  web's ONE deadline helper — the member lookup and the Overview/Stats name
  lookups share it, `LOOKUP_TIMEOUT_MS` = 10 s; past it those pages show the
  stored names / "—" and warn once), `render.js` (the only EJS entry point),
  `vendor.js` (htmx pin), `views/`, `public/` (`app.css`, vendored htmx).
- **Help pages — `modules/help/web.js` + `modules/help/views/`:** view models
  (`overviewModel`, `seasonsModel`, `statsModel`, `categoriesModel`,
  `settingsModel`) and routes under `/help`; every POST calls
  `modules/help/actions.js`, answers 303 with one notice line, and runs the
  action's `effects` after the response. Helpers there: `dateOf` (a timestamp →
  the date shown on the pages), `pastSeasons` (the ended seasons, newest first,
  that the Stats picker and the rename form can address), `failTo` (a POST's
  refusal: one red line on the given page, nothing written).
- **Confirmations (Start new season, Reset season, Archive category):**
  `web.confirmed(req, res, spec)` is stateless two-step. The first POST
  answers the confirmation page (200, nothing written) with hidden fields plus
  `issued` (now) and `guard`; the confirming POST (`confirm=yes`) must carry an
  `issued` that is at most 5 minutes old (`CONFIRM_TTL_MS`) and not in the
  future, otherwise the page is shown again with "This confirmation expired".
  `spec.guard` is **required** (`confirmed()` throws without it): the handler
  computes it from fresh data on every call (`seasonGuard` = archived-season
  count + the current season's `startedTs`; `categoryGuard` = the category's
  active/archived state, the ids of its open requests, the duplicates the
  archive would drop, and whether the move-to target is still active), and a confirming POST whose
  guard no longer matches — back button, second tab, double click, after the
  action already ran — is refused by `web.changed`: one red "Already done or
  changed" line, nothing runs twice. Call the action right after `confirmed`
  returns true, with no `await` in between.
- **Settings page (owner):** the notify role's **Off** is an explicit choice
  (`roleId=off`); a missing or repeated form field reads as `""` and is
  refused with a red line — never taken for Off or for a no-op remove. A
  manager-role change calls `web.forgetLevels()` (drops the 60 s level cache),
  so it applies on the affected user's next request.
- **htmx history:** `<main>` is boosted and boosted GET links push the URL;
  every POST `<form>` in a page carries `hx-push-url="false"` (a confirmation
  page's URL is the POST action — refreshing it would 404). A test scans the
  templates for it, so a new POST form must carry it too.
- **Module contract:** `web: { title, nav: [{ label, path, minLevel }], routes(router, web) }`,
  mounted at `/<module>`; `minLevel` is `officer` (default) or `owner`;
  `auth`, `static`, `login`, `teammates` are reserved module names.
- **Behaviour changes:** `PUBLIC_URL` must be a bare `http(s)://host[:port]`
  origin — a path, `http:foo` or credentials stop the bot at startup (Discord
  rejected such values in the menu's link button); season names over 80
  characters are refused by the action (the Discord modals already capped them);
  season names and category labels with control characters (`\p{Cc}`) or bidi
  controls (U+202A–U+202E, U+2066–U+2069) are refused on every surface with
  `help.PLAIN_TEXT_ERROR` (`help.hasUnprintable`, used by
  `actions.seasonNameError` and `help.addCategory`); archiving a category with
  a `moveto` that is not an active category is refused even when nothing moves
  (`help.removeCategory`).
- **Sessions & revocation:** the cookie is signed, not encrypted, and carries
  only `{ userId, exp }` (plus transient OAuth state / notice); `exp` is a
  rolling 30 days checked server-side. There is no server-side session store,
  so Sign out only clears that browser; rotating `SESSION_SECRET` is the global
  revoke. Access is re-derived from Discord every request (60 s cache), so a
  demotion bites within about a minute.
- **Upgrading htmx:** replace `web/public/vendor/htmx-<version>.min.js` with the
  npm package's `dist/htmx.min.js`, then update `web/vendor.js` together:
  `sha256` (`sha256sum <file>`) and `integrity`
  (`sha384-` + `openssl dgst -sha384 -binary <file> | openssl base64 -A`).
- **Dependencies:** express 5.2.1, ejs 6.0.1, cookie-session 2.1.1, helmet
  8.3.0; undici 6.29.0 (`npm audit fix`). CI now fails on a high-severity
  production advisory (`npm audit --omit=dev --audit-level=high`).

---

## 2026-09-30 — M2b `/menu` core

- **`/menu`** (and a **Menu** button on the pinned board, next to Need help)
  opens one ephemeral, self-editing **Components V2** message: a home screen
  with one row per module ("Help board · N open"), **How it works** (today's
  `/help` text) and, on the Help board, Need help / I'm sorted / Stats for
  everyone plus an **Officer** row (Mark helped / Remove / Repost board).
  Settings stay off the Discord menu — they go to the web admin (M3). The old
  slash commands keep working until M6.
- **Actions layer — `modules/help/actions.js`:** every help-board write is an
  `action(ctx, actor, args) → { ok, …, effects } | { ok: false, code, error }`
  (`needHelp`, `sorted`, `closeAll`, `setNote`, `helped`, `remove`,
  `repostBoard`, `newSeason`, `renameSeason`, `reset`, `addCategory`,
  `archiveCategory`, `addManagerRole`, `removeManagerRole`, `setNotifyRole`,
  `setNudge`, `nudgeOff`). The slash commands, their panels, the menu and (M3)
  the web call these, so they can't drift. Each action checks the actor's
  level itself; slow REST comes back as `effects` and runs after the ack. (The
  request-card buttons `help:claim/sorted/remove` keep their inline logic.)
- **Permissions — `core/perms.js`:** `computeLevel()` is the one rule (Manage
  Server → owner, a manager role → officer, else member); help's `isManager()`
  delegates to it. `ctx.perms.levelOf(member)` / `levelOfInteraction(i)`. The
  manager roles come from the help module's `managerRoles()` provider — the
  core never reads `data.json`.
- **Menu engine — `core/menu.js` + `core/panel.js`:** `menu` is a core
  pseudo-module (owns `/menu` and the `menu:` prefix; no module may be named
  `menu`). customIds: `menu:<module>:<screen>[:<arg>]`. Every tap re-checks the
  level — an officer screen tapped after losing the role falls back to home
  with one line. A `menu:` button on a non-menu message (the public board)
  always opens a *new* ephemeral menu; it never edits that message. Every
  screen goes through a mobile-limit validator (≤ 3 buttons/row, ≤ 4 button
  rows, labels ≤ 20, ≤ 40 components, depth ≤ 3, one Primary); an invalid
  screen is logged and replaced by home.
- **Behaviour changes:** `/config addrole` and `/config notify` now refuse
  @everyone and bot-managed roles (the `/config roles` panel already did);
  `/board` answers with an explicit error when it can't post in the channel.
- **Cost of a tap:** 3–5 `data.json` reads per menu tap (≈ 22–40 ms at the
  5000-record cap, dev machine) — far inside Discord's 3 s ack window.
- `PUBLIC_URL` (unset until M3) turns on the **Web admin** link for officers;
  it must be a full `http(s)://…` URL, otherwise the bot refuses to start.

---

## 2026-09-30 — M1 platform skeleton

- **Layout:** `index.js` is now a thin core entry; the help board's code moved
  (`git mv`) to `modules/help/help.js`, changed only at its seams. `core/` holds
  `config`, `store`, `loader`, `router`, `registry`, `lock` and `runtime`
  (per-module ctx, `onReady`, jobs); `modules/help/index.js` is the help
  module's contract. Wherever the older notes below say `index.js` /
  "the `interactionCreate` listener" for help-board logic, read
  `modules/help/help.js` / its exported `dispatch()`.
- **Pinning:** `/board` needs the separate **Pin Messages** permission (Discord
  split it off Manage Messages). A failed pin is now logged and the reply says
  so, instead of claiming "pinned".
- **`MODULES` env** (comma-separated, default `help`) picks the modules to run.
  Blank/whitespace/trailing commas fall back to `help`; unknown or duplicate
  names fail loudly at startup.
- **Routing:** slash commands go to the module by command name, components and
  modals by customId prefix. The 9 legacy prefixes (`help board season stats
  imsorted reset resolve roles catadd`) belong to help, so buttons on already
  posted messages keep working. A prefix nobody owns now gets an ephemeral
  "no longer active" notice instead of a silent failure.
- **Registration:** one guild-scoped PUT with the union of all module commands;
  a name clash between modules is a hard error.
- **CI:** Node 20 + 24 matrix on `main` and `dev`; `engines` is `node >=24`.
- **Data:** the `data.json` schema and location (`DATA_DIR` root) are unchanged.
  `test/logic.test.js` runs unchanged through `index.js` re-exports.

## How it runs now

- **Host:** a Docker "custom app" on a TrueNAS SCALE box.
- **Deploy model:** the container `git clone`s this repo on every start and runs
  `node index.js`. So **restarting the app = pulling the latest `main`**. No
  build step, no image to push.
- **Data:** `data.json`, written atomically. Its location is `DATA_DIR` (an env
  var) so it can live on a persistent volume while the code stays ephemeral. On
  the NAS `DATA_DIR=/data` → a mounted dataset, so data survives restarts.
- **Config lives in `data.json`** (no database): manager roles, notify role,
  board location, season history.
- **Secrets:** `DISCORD_TOKEN` / `CLIENT_ID` / `GUILD_ID` come from env (compose
  env vars on the NAS, `.env` locally). `.gitignore` keeps `.env`, `data.json`
  (and its `.bak`/`.tmp`) and `bot.lock` out of git — the repo is public.

## Data model (`data.json`)

```jsonc
{
  "boardChannelId": null,      // the pinned live board
  "boardMessageId": null,
  "entries": [                 // one per open/closed help request
    {
      "id": "1690000000000-ab12c",  // stable key (used in button customIds)
      "userId": "…",
      "username": "…",              // snapshot; only a FALLBACK now (see resolveNames)
      "category": "seasonrun5k",    // or "mvp5k"
      "note": "",
      "done": false,
      "ts": 1690000000000,          // asked-at
      "doneTs": 1690000001000,      // sorted-at (when done)
      "helpedBy": "…",              // officer userId who sorted (for the leaderboard)
      "claimedBy": "…",             // officer userId who claimed it (🙌), or null
      "claimedTs": 1690000000500,   // claimed-at (set/cleared by toggleClaim), or null
      "requestChannelId": "…",      // the button card message…
      "requestMessageId": "…"       // …so we can update it later
    }
  ],
  "managerRoleIds": [],        // roles that can run officer actions (set via /config)
  "notifyRoleId": null,        // pinged on new request cards (/config notify)
  "nudgeChannelId": null,      // stale-nudge digest channel — the on/off switch (/config nudge)
  "nudgeThresholdHours": 48,   // a request older than this is "stale"
  "lastNudgeTs": null,         // when the last daily digest posted (the daily gate)
  "seasons": [],               // archived summaries pushed by /reset (byCategory now generic)
  "categories": [              // configurable categories (seeded with the two defaults)
    { "id": "seasonrun5k", "label": "Season Run 5K", "emoji": "🏃", "archived": false }
  ],
  "records": [                 // append-only log — one per RESOLVED request (see below)
    {
      "reqId": "1690000000000-ab12c",  // the entry's id at resolution
      "requesterId": "…",
      "category": "seasonrun5k",
      "resolution": "sorted",          // "sorted" | "self" | "removed" | "unresolved"
      "requestedTs": 1690000000000,    // entry.ts
      "resolvedTs": 1690000001000,     // when the record was written
      "seasonStartedTs": 1690000000000,// closing/current season's startedTs (immutable identity)
      "helperId": "…",                 // only on "sorted"
      "claimedById": "…",              // only if the entry was claimed
      "claimedTs": 1690000000500       // paired with claimedById
    }
  ]
}
```

## Commands (all handled in help's `dispatch()` — formerly the `interactionCreate` listener — switched on `commandName`)

| Command | Access | Notes |
|---|---|---|
| `/needhelp` | everyone | adds an entry, posts a **request card** with buttons |
| `/imsorted` | everyone | self-removal of the caller's own pending entries |
| `/stats` | everyone | counts, average wait, helper leaderboard, last season |
| `/help` | everyone | embed command list |
| `/helped` | officers | mark sorted (+ DM + close card) |
| `/remove` | officers | remove an entry (+ close card) |
| `/board` | officers | post & pin the live board |
| `/reset` | officers | archive season → clear → close open cards |
| `/config addrole/removerole/roles/notify` | admins | roles + ping settings |
| `/config category add/remove/list` | admins | manage categories (add/update, archive+reassign, list) |

"Officers" = Manage Server **or** a role in `managerRoleIds` → see `isManager()`.
`/config` is admin-only (`setDefaultMemberPermissions` **and** an in-code
Manage-Server check).

## Where to look (key functions)

- `loadData()` / `saveData()` — storage. `saveData` writes a temp file then
  `renameSync`s over the target (**atomic** — a crash mid-write can't corrupt it),
  and first copies the current file to `data.json.bak` **only if it's still valid**
  (a last-known-good copy that a corrupt primary can't clobber). `loadData`
  normalises shape (`readAndShape`) and, on a corrupt `data.json`, **restores from
  `data.json.bak`** before falling back to an empty board instead of throwing.
- `acquireLock()` / `readLock()` / `isLockFresh(lock, now)` — a **log-only**
  single-instance advisory: on startup it writes a `bot.lock` heartbeat and warns
  (never blocks) if a fresh one already exists; a `SIGTERM`/`SIGINT` handler removes
  the lock on graceful shutdown so a fast redeploy doesn't false-warn.
- `isManager(interaction, data)` — permission gate for officer actions; a thin
  wrapper over `core/perms.js` `computeLevel()` (the one level rule).
- `modules/help/actions.js` — every help-board write (see the M2b note). New
  write path for slash, menu or web = a new action here.
- `core/menu.js` (`createMenuModule`, `homeScreen`, `parseMenuId`,
  `isMenuMessage`), `core/panel.js` (`buildScreenPayload`, `screenErrors`,
  `textFromEmbed`) and `modules/help/menu.js` (`section`, `render`, the
  Help board screens) — the `/menu`.
- `buildBoardEmbed(data, names)` / `renderField(lines)` / `catOf(category)` —
  board rendering. `renderField` keeps each field ≤1024 chars and appends
  "…and N more". `catOf` is a safe category lookup (won't throw on unknown data).
- `resolveNames(guild, data)` — resolves each shown entry's **current** display
  name from its `userId` at render time (falls back to stored name if the member
  left). ⚠️ **Read-only on purpose — see invariants.**
- `refreshBoard(client, data)` — re-renders the pinned board message.
- Request cards: `requestButtons(entryId)`, `postRequestCard(...)`,
  `resolveCard(client, entry, statusLine)`.
- `dmSorted(client, userId, category)` — DMs the helped member (failures ignored).
- `handleButton(interaction)` — the ✅/🗑️ button flow (customId
  `help:<action>:<entryId>`).
- `formatDuration(ms)`, `memberName(guild, id)` — stats helpers.
- `registerCommands()` — runs on startup, so new/changed commands register on
  the next restart.

## New features (this round)

- **One-click request cards.** Every `/needhelp` posts a card in the board
  channel with **✅ Sorted** / **🗑️ Remove** buttons. Officers resolve in one
  click; the card edits to show who did it, the board refreshes, the member gets
  a DM. Buttons are gated by `isManager`.
- **`/stats`** — waiting/sorted per category, average wait (`doneTs - ts`), a
  top-helpers leaderboard (from `helpedBy`), and last season's totals.
- **`/imsorted`** — members take themselves off the board.
- **DMs on sorted**, **`/config notify @role`** (ping a role on new requests),
  **season history** (archived by `/reset`), and **"waiting since"** live
  timestamps on the board.

## Review fixes / hardening (why the code looks the way it does)

- **3-second ack window:** every handler acknowledges the interaction *before*
  any slow REST work (board refresh, card posting). `/board` and `/stats` use
  `deferReply`. Don't reorder these.
- **Atomic writes + corrupt-file recovery** (above).
- **No accidental pings:** the client is created with
  `allowedMentions: { parse: [] }`, so user-controlled nicknames can't inject an
  `@everyone`. The request card explicitly opts back in for the notify role only.
- **Live names, never raw IDs:** the board resolves names from `userId` at render
  time and falls back to the last-seen name — so mentions never render as a raw
  `<@id>` for members the viewer can't resolve.
- **Startup validation:** missing env vars fail fast with a clear message; the
  login IIFE is wrapped so failures exit cleanly instead of an unhandled
  rejection. Uses the `clientReady` event (v14 renamed `ready`).

## Ops safety net (latest round)

Operational hardening for the file-based storage and the clone-to-deploy repo —
no command or board behaviour changed.

- **`data.json.bak` backup + auto-restore.** `saveData` keeps one last-known-good
  copy; `loadData` restores from it when `data.json` is corrupt (previously it
  silently started from an empty board — i.e. lost everything). The backup is only
  taken when the current file is valid, so a corrupt primary never overwrites a
  good `.bak`.
- **Log-only single-instance advisory.** A `bot.lock` heartbeat warns (never blocks
  startup) if another instance looks alive, and is cleaned up on `SIGTERM`/`SIGINT`.
  Chosen over a hard lock because the deploy model is a clean container swap — a
  hard lock could wedge the "restart = update" path for no real gain.
- **Tests + CI.** `index.js` is now importable (its startup is guarded by
  `require.main === module`, and the pure helpers are `module.exports`ed), so
  `test/logic.test.js` (Node's built-in `node --test`, zero deps) can exercise the
  storage/lock/render logic. `npm test` runs the suite; a GitHub Actions workflow
  (`.github/workflows/ci.yml`) runs `node --check` + `npm test` on every push/PR to
  `main`. The bot is still one file — `test/` and `.github/` are the only additions.

## Configurable categories (latest round)

The two hardcoded categories are now a data-driven, admin-managed list — the bot
adapts to any guild goal without a code change.

- **`data.categories`** = `[{id,label,emoji,archived}]`. Seeded with the two
  defaults (`seasonrun5k`, `mvp5k`) when the field is absent **or** empty
  (`readAndShape`), always deep-copied — so the live `data.json` (which had no
  `categories`) and old season archives keep working untouched.
- **`/config category add/remove/list`** (admin). `add` upserts by *normalized
  label* (so re-adding "Season Run 5K" updates the seeded `seasonrun5k`, never a
  duplicate); emoji ≤32 chars, label ≤60, max 25 active. `remove` archives (never
  hard-deletes); if the category has open requests you must pass `moveto` — those
  entries are reassigned (dropping any that would duplicate a user's existing open
  entry in the target), then the category is archived. Can't remove the last
  active category.
- **Autocomplete, not static choices.** `/needhelp`/`/imsorted`/`/helped`/`/remove`
  and the `category`/`moveto` options use `.setAutocomplete(true)`, served by one
  read-only autocomplete handler — so **category edits need no command
  re-registration**. Handlers still validate the submitted id (an autocomplete
  value is only a hint).
- **`catOf(data, id)`** replaced the old const lookup — data-driven, returns a
  fresh `{label,emoji}`, falls back to the shipped defaults then a generic label.
  `/stats` and `/reset` iterate categories generically (`countByCategory`); old
  archives with fixed `byCategory` keys still render.
- Key helpers: `slugify`, `addCategory`, `removeCategory`, `categorySuggestions`,
  `activeCategories`, `categoryMap`, `countByCategory`, `defaultCategories`,
  `emptyData`, `rerenderCard` (re-renders a moved entry's card keeping its buttons).

## Self-service & claim UX (latest round)

- **`🙋 Need help` board button** — the pinned board now carries a button. It
  opens an ephemeral category picker (a `StringSelectMenu` — v14 modals can't
  hold a select) and picking a category adds you instantly, no note, same result
  as `/needhelp`. Existing boards gain the button on their next refresh.
- **`🙌 Claim` button on request cards** — an officer can flag that they're
  handling a request. It's **informational**: it shows who claimed it on the card
  and in the board's waiting line, but never blocks Sorted/Remove. Clicking again
  releases it; another officer can't steal an active claim. `toggleClaim` is the
  pure toggle; state is one optional field `entry.claimedBy` (additive, no
  migration — absent on existing entries).
- **Shared entry-creation path** — `/needhelp` and the board button now run
  through the same helpers: `hasOpenEntry`, `newHelpEntry`, `cardDescription`
  (the single source of a card's text — used by both card builders and the claim
  re-render), and `async announceEntry` (posts the card, reload-patches its
  message ids by `id`, refreshes the board).
- `resolveNames` now also resolves `claimedBy` for pending entries — still
  strictly read-only, never leaks a raw id (an unresolvable claimer just shows no
  marker), and it resolves per-entry so a user waiting in two categories still
  gets the claimer resolved on the second one.
- New `board:` `customId` namespace (`board:needhelp`, `board:pick`) routed ahead
  of `help:`; claim is `help:claim:<id>`. Select-option labels fold the emoji into
  the text (never the option `emoji` field), so an admin's free-text emoji can't
  throw a builder validation error.
- Key helpers: `hasOpenEntry`, `newHelpEntry`, `cardDescription`, `announceEntry`,
  `categorySelectOptions`, `needHelpRow`, `handleBoardButton`, `handleBoardSelect`,
  `toggleClaim`.

## Named seasons + `/season` panel (latest round)

- **Seasons have names.** `data.currentSeason = { name, startedTs }` (additive,
  migration-free — absent → `{ name: null, startedTs: null }`, coerced defensively
  in `readAndShape`), and archived seasons carry a `name` + `startedTs`. Anything
  without a name renders as **`(unnamed)`** — never a raw `null` — via `seasonLabel`.
- **Four pure, `now`-injected lifecycle helpers** (deterministic, exported,
  unit-tested): `seasonLabel(season)`, `closeSeason(data, now)` (archive current
  if it has sorted entries, cap history at 12, clear the board, **reset
  `currentSeason` to unnamed/`now`**), `beginSeason(data, name, now)`,
  `renameSeason(data, target, newName)` (`target` = `"current"` or a numeric
  `endedTs`). Both `/reset` and the `/season` panel route through these.
- **`/reset` is now name-aware** but otherwise unchanged: it captures `pending`
  before `closeSeason` clears entries, archives with the season's name, and starts
  a fresh **unnamed** season (so the panel never shows the archived name + a stale
  start date as "current").
- **`/season` panel** — an ephemeral, manager-only embed + `StringSelectMenu` +
  buttons. `seasonPanelEmbed` / `seasonSelectOptions` / `seasonPanelComponents`
  build it; the select (`season:view`) re-renders a season's detail via
  `interaction.update()`. The "Past seasons" field is capped through the shared
  `renderField` 1024-char helper (long names can't brick the panel).
- **First modal usage.** `season:new` / `season:rename` / `season:renamepick:<target>`
  buttons open a `ModalBuilder` (text-only — v14 modals can't hold a select) for
  the name; `isModalSubmit()` is routed ahead of the chat-command guard to
  `handleSeasonModal`, which acks with `interaction.reply()` (a modal submit is
  **not** a component `update()`), saves **before** the slow card-close/board REST,
  and keeps the no-`await`-between-load/save rule. Rename prefills the current
  name, and skips an empty `setValue` (day-one unnamed state).
- **Known follow-up (D12):** after a modal submit the originating panel is left as
  its prior render (a separate ephemeral reply confirms the change); stale select
  values resolve to a graceful "that season is gone". Live in-place panel refresh
  on submit is deferred (see `DECISIONS.md`).
- Key helpers/handlers: `seasonLabel`, `closeSeason`, `beginSeason`, `renameSeason`,
  `seasonPanelEmbed`, `seasonSelectOptions`, `seasonPanelComponents`,
  `handleSeasonCommand`, `handleSeasonButton`, `handleSeasonSelect`,
  `handleSeasonModal`. Namespace: `season:*` buttons/select + `season:newmodal` /
  `season:renamemodal:<target>` modals.

## Helper stats + `/stats` panel (latest round)

- **Append-only record log (`data.records`).** The pivot: instead of deriving
  stats from the season archive, every request that reaches a *terminal moment*
  writes an immutable record, and **every report is a query over the log.**
  Additive/migration-free (`readAndShape` coerces `records` to `[]`;
  `emptyData` seeds it). `RECORD_CAP = 5000` — on append the oldest are pruned
  with a **once-per-process** `console.warn` (module-level `recordCapWarned`
  flag, not once-per-prune).
- **`makeRecord(data, entry, resolution, now)` / `logRecord(data, record)`** —
  `makeRecord` is pure (`now` injected, never `Date.now()` inside); `helperId`
  only for `"sorted"`, claim info carried when present, `seasonStartedTs` is the
  season's immutable identity (survives a later rename). `logRecord` appends +
  prunes. `resolution ∈ "sorted" | "self" | "removed" | "unresolved"`.
- **Five terminal sites log synchronously before `saveData`** (no intervening
  `await`): card **✅ Sorted** and **🗑️ Remove**, `/helped`, `/remove`,
  `/imsorted` (all `mine` in one `now` snapshot), plus **`removeCategory`'s
  dropped-duplicate path** (a `/config category remove …moveto:…` that dedups a
  user's entry into the destination — logged `"removed"`, its own terminal
  moment). `closeSeason` logs `"unresolved"` for still-pending entries *before*
  clearing, stamping the closing season (done entries were already logged
  `"sorted"`, never re-logged).
- **`toggleClaim(entry, officerId, now)`** now captures `entry.claimedTs` on
  claim, clears it on release, overwrites on re-claim — so a record can carry
  claim→resolve timing.
- **Pure query helpers** (read-only, exported, unit-tested): `recordsForSeason`,
  `helperTotals`, `requesterTotals` (help *received* = sorted + self),
  `categoryWait` (mean-ready sums over valid-timing sorted only),
  `helperBreakdown` (per-category counts + wait + claim timing), `demandSummary`
  (counts by resolution). **C1 claim-validity rule:** claim timing counts only
  when `claimedById === helperId` (the sorter *is* the claimer) — otherwise it'd
  be misattributed. `validWait(start,end)` guards null + out-of-order stamps.
- **`/stats` is now an ephemeral, navigable panel** (was a single embed). A view
  `StringSelectMenu` (`stats:view` — current / all-time / any past season) + a
  `UserSelectMenu` (`stats:member` — the first in the bot) re-render via
  `deferUpdate()` → resolve names → `editReply()`. **Read-only — the panel never
  `saveData`s.** Builders: `statsViewOptions`, `currentStatsEmbed` (reads live
  `data.entries`, *not* records), `allTimeEmbed`, `memberEmbed`,
  `seasonHelperEmbed` (graceful "no per-request data" for pre-M10 seasons).
  Plumbing (not exported): `statsPanelComponents`, `leaderboardLines`,
  `resolveIds` (dedupes ids before REST, left-guild → "(left the server)").
  Leaderboards cap at 15 rows; multi-line fields go through `renderField` (1024).
- **Recording landed before the panel** (deployable on its own — it starts
  capturing immediately; the panel just displays). The rich per-helper timings
  (`waitMs`/`claimMs`) are captured but not yet surfaced — a future report is a
  query away.
- **⚠️ Deploy caveat (no rollback past this release):** once live, `data.json`
  carries `records`; an older build's `readAndShape` whitelist drops it on the
  first save. `.bak` is the only recovery. (Documented in `README.md`.)
- Key helpers/handlers: `makeRecord`, `logRecord`, `RECORD_CAP`, `toggleClaim`,
  `recordsForSeason`, `helperTotals`, `requesterTotals`, `categoryWait`,
  `helperBreakdown`, `demandSummary`, `statsViewOptions`, `currentStatsEmbed`,
  `allTimeEmbed`, `memberEmbed`, `seasonHelperEmbed`, `handleStatsCommand`,
  `handleStatsView`, `handleStatsMember`, `resolveIds`. Namespace: `stats:view`
  (StringSelect) + `stats:member` (UserSelect).

## Stale nudges + `/config nudge` (latest round)

- **Three additive `data` fields** — `nudgeChannelId` (the on/off switch),
  `nudgeThresholdHours` (default 48), `lastNudgeTs` (the daily gate). Defaulted
  in both `readAndShape` and `emptyData`; migration-free. `readAndShape` also
  **clamps** `nudgeThresholdHours` to `1..NUDGE_MAX_HOURS` (a hand-edited `0`/
  negative would make every request instantly "stale").
- **`/config nudge set|off|status`** (a subcommand group beside `category`).
  `set` restricts the channel option to text/announcement types and validates
  `hours` at both the slash-command layer *and* in `setNudgeConfig`
  (`Number.isInteger && 1..8760`) — the float/zero/absurd crash-class this
  project has hit before (cf. M7). `set` is the on switch; `off` nulls the
  channel but keeps the threshold; `status` shows channel/threshold/next-eligible.
- **Pure helpers (exported, `now`-injected, unit-tested):**
  `setNudgeConfig`/`clearNudge` (config mutation), `staleEntries(entries, now,
  thresholdMs)` (open + past-threshold), `dueForNudge(data, now, cadenceMs)`
  (daily gate; treats a **future `lastNudgeTs`** as due, guarding a
  backward clock step), `nudgeDigestEmbed(data, stale, names, now)` (category-
  grouped reminder). None call `Date.now()` — the tick passes it.
- **`nudgeTick(client)` + hourly interval.** A `.unref()`'d
  `setInterval(NUDGE_TICK_MS = 1h)` plus one `setTimeout(…, 60s).unref()`
  startup-kick, both armed in `clientReady` (inside the `require.main` guard, so
  inert under tests). The tick: off-by-default guard → daily gate
  (`NUDGE_CADENCE_MS = 24h`) → `staleEntries` → post one digest (pinging
  `notifyRoleId` once via a **narrow `allowedMentions` override** — `{roles:[id]}`
  or `{parse:[]}`, the global `{parse:[]}` untouched) → **re-load-patch-save**
  `lastNudgeTs` (invariant #1: an await happened since load). A **failed post
  does not stamp** `lastNudgeTs` (retry preserved). The whole body is
  try/catch'd (`err?.message ?? err`) so a transient error never crashes or
  blocks the next tick.
- **Two hardening fixes from the opus+Fable final review (both "silent-failure"
  class):** (1) **embed budget** — the digest is the first surface that builds a
  1024-capped field *per category*, so it can blow Discord's 6000-char / 25-field
  embed limit → `send` rejects → the digest silently never posts and re-fails
  hourly. `nudgeDigestEmbed` now budgets (≤25 fields **and** ~5500 chars) and
  appends one "…and N more" overflow field; the title still shows the *true*
  total. (2) **post-send persist guard** — if `saveData` throws *after* a
  successful `send` (corrupt file, ENOSPC on the NAS), `lastNudgeTs` never
  persists → the next tick re-posts *with the role ping*, hourly. A module-level
  in-memory `lastNudgePostTs` (set *before* `send`) is folded into the due gate:
  persisted `lastNudgeTs` stays the cross-restart source of truth; the in-memory
  guard stops the *same process* from re-pinging when persistence fails.
- Key helpers/handlers: `setNudgeConfig`, `clearNudge`, `staleEntries`,
  `dueForNudge`, `nudgeDigestEmbed`, `nudgeTick`, constants `NUDGE_TICK_MS`/
  `NUDGE_CADENCE_MS`/`NUDGE_MAX_HOURS`, `lastNudgePostTs`. The `/config` handler
  gained a `group === "nudge"` branch; `clientReady` starts the timers.
- **Invariant #6 (record log) is N/A here** — a nudge resolves nothing and
  writes no record; it only reads open entries and reminds.

## Polish sweep (M12) (latest round)

A batch of deferred polish, chosen by the user (clusters A/B/C/D). Two behavior
changes (M8, M9); the rest is hardening + test hygiene.

- **Test hygiene (A):** the `.bak`/corruption-recovery test block is now
  order-independent — each test resets its files via `resetDataFiles()` (was an
  implicit chain where one test reused the corrupt `data.json` a prior test
  left). Added the revive-at-cap test (revive an archived category while 25 are
  already active → rejected, stays archived).
- **`.bak` write is now atomic (B1):** `saveData` copies to `data.json.bak.tmp`
  then `renameSync` over `data.json.bak` (was a direct `copyFileSync` a crash
  mid-copy could truncate — the very file `loadData` falls back to). The
  valid-primary guard + try/catch are unchanged; a `.bak` failure still never
  blocks the primary save.
- **`readAndShape` validates category item-shape (B2):** `shapeCategories`
  rebuilds each `{id,label,emoji,archived}` field-by-field (like `currentSeason`)
  — keeps only items with a string `id`+`label`, defaults emoji, coerces
  `archived` (`=== true || === "true"`, so a hand-edited `"false"` stays
  **active**, not silently archived). Well-formed arrays round-trip unchanged;
  empty-after-clean → defaults. Hand-edited/foreign `data.json` files no longer
  smuggle a malformed category through to a later crash.
- **Nudge digest overflow field counted in the budget (B3):** `nudgeDigestEmbed`
  now includes the "…and N more" overflow field's own length in the `< 6000`
  accounting (was inconsistent; safe today only via the ~500-char margin).
- **`moveto` autocomplete excludes the category being removed (C1):**
  `categorySuggestions(data, typed, excludeId)` — the `moveto` suggestions no
  longer offer the category you're deleting (server-side `moveto===id` reject
  stays as the backstop).
- **`/stats` member view keeps the prior view selected (C3):** a new pure
  `selectedViewFrom(components)` recovers the active `stats:view` option from the
  panel message, so a member lookup no longer snaps the dropdown back to
  "Current season". Falls back to `"current"` if unrecoverable.
- **Board refreshes sooner on category remove (C2):** `refreshBoard` moved before
  the per-card re-render loop (it rebuilds purely from saved `data`). The
  per-card lag is inherent to ack-before-REST and left as-is.
- **M8 — a claim held by a member who LEFT the guild auto-releases (behavior).**
  The claim marker was already hidden at every render site; the gap was the
  claim-button `"blocked"` branch never clearing `entry.claimedBy`, so the
  request stayed permanently unclaimable. Now: when blocked, the branch checks
  the holder's membership (`members.fetch`) and, **only on a genuine "Unknown
  Member/User" (`isGoneError` → codes 10007/10013)**, releases the stale claim
  (`releaseClaim`) and lets the clicker take it — via **re-load-patch-save** with
  a **TOCTOU recheck** (`applyStaleClaimRelease`: release only if the fresh claim
  is still the departed holder's, else treat as a live claim). A transient API
  error does **not** release (avoids stealing a present officer's claim). No
  record is written (a claim change is not a terminal moment — invariant #6).
- **M9 — the `/season` panel refreshes in place after a modal submit
  (behavior).** Both `handleSeasonModal` branches now
  `ModalMessageModalSubmitInteraction.update()` the source panel (rebuilding
  `seasonPanelEmbed`+`seasonPanelComponents`) instead of posting a separate
  ephemeral reply. `update()` is the first ack; it's wrapped in try/catch with an
  ephemeral-reply fallback so the post-ack `resolveCard`/`refreshBoard` always
  run.
- Key helpers/handlers: `resetDataFiles` (test), `shapeCategories`,
  `selectedViewFrom`, `releaseClaim`, `applyStaleClaimRelease`, `isGoneError`,
  `categorySuggestions(…, excludeId)`. New path constant `BAK_TMP_FILE`.

## Interactive UI/UX upgrade (M13) (latest round)

Five old-style command surfaces upgraded to the interactive patterns proven in
M8–M12 (embed + buttons / native pickers / select menus / modals, refreshed in
place), with helper text and a confirm/warning on the destructive season-wipe.
**No new `data.json` field** — every panel is a pure READ over existing state (a
recording audit confirmed nothing is stored redundantly; reports render
already-recorded data). Each typed command keeps its args as an OPTIONAL
fast-path; the no-arg form opens the panel. New customId namespaces: `reset:`,
`imsorted:`, `resolve:`, `catadd:`, `roles:`.

- **`/reset` now confirms (was an immediate irreversible wipe).** `/reset` posts
  an ephemeral warning (live waiting-count) + `Confirm`/`Cancel` buttons; the wipe
  body moved into the `reset:confirm` handler (own `isManager` check). The confirm
  customId carries an **`issuedTs` freshness token** — a stale panel (>5 min, via
  `resetConfirmStale`) refuses and re-warns with the CURRENT count instead of
  wiping newer requests. The `/season` "New season" flow (same `closeSeason`
  effect) gained a matching destructive warning (embed + button label + modal).
- **`/imsorted` self-service panel.** No-arg → an ephemeral multi-`StringSelect`
  of the caller's OWN open entries (+ a `Close all` button). Ownership is
  re-derived server-side, so a crafted/stale id can't close someone else's entry.
  Extracted `openEntriesFor(data, userId)` + `closeEntries(...)` (the shared
  log-then-remove core — invariant #6 is now unit-tested directly).
- **`/helped` + `/remove` shared member-picker.** No-arg → `UserSelectMenu` →
  the picked member's open entries as a `StringSelect` (only categories they're
  actually waiting in — the old "no pending entry" dead-end is gone) → resolve.
  Shared cores `resolveEntryAsSorted`/`resolveEntryAsRemoved`/`finishResolveEntry`
  (used by both the fast-path and the panel; helped DMs + logs `"sorted"`, remove
  logs `"removed"`, no cross-wire). A member-but-no-category invocation skips
  straight to that member's entry step.
- **`/config category add` modal.** No-arg → a two-field modal (label + emoji),
  mirroring the `/season` name modal; `catadd:submit` runs `addCategory` verbatim.
- **`/config roles` panel.** A live-updating panel: `RoleSelectMenuBuilder`
  (`roles:add`, **first RoleSelectMenu in the repo**) to add a manager role
  (rejects `@everyone`/managed roles), a `StringSelect` (`roles:remove`) of only
  the current manager roles, and a notify-role picker + clear button. New router
  branch: `interaction.isRoleSelectMenu()`.
- **Cross-cutting:** every new close path logs its record synchronously before
  `saveData` (invariant #6); handlers that `await` before persisting use
  re-load-patch-save (invariant #1); `interaction.update()` is the first ack and
  is **try/catch-wrapped** (the M12-F3 pattern) so the post-save
  `resolveCard`/`refreshBoard`/DM always run even if the ack throws. The
  `/config`-owned panels (`catadd:`, `roles:*`) gate on **ManageGuild** (not the
  weaker `isManager`), matching `/config` itself.
- Key helpers: `openEntriesFor`, `closeEntries`, `imsortedSelectOptions`,
  `resolveEntryAsSorted`, `resolveEntryAsRemoved`, `finishResolveEntry`,
  `entryStepPanelPayload`, `resetWarningEmbed`, `resetConfirmStale`,
  `rolesPanelEmbed`, `rolesRemoveSelectOptions`, `rolesPanelComponents`.

## ⚠️ Invariants — please keep these to avoid re-introducing bugs

1. **No `await` between `loadData()` and `saveData()` in a handler.** The whole
   read-modify-write must be synchronous, or a concurrent interaction's write
   gets clobbered. Where an await is unavoidable before persisting (e.g.
   `/needhelp` saving the card message id), re-`loadData()`, patch the entry by
   `id`, and save that fresh copy — see `announceEntry()`.
2. **`resolveNames()` must never call `saveData()`.** It runs after other awaits
   with a possibly-stale snapshot; persisting it would clobber concurrent writes.
   It only builds a `{ userId: name }` map.
3. **Button `customId` format is `help:<action>:<entryId>`.** `entryId` has no
   colon, so `split(":")` is safe.
4. **Run only one instance.** Multiple processes on one `data.json` will
   overwrite each other (no file locking). The `bot.lock` heartbeat is a
   **log-only advisory** — it warns but does not enforce, so this still holds.
5. **Requiring `index.js` must stay inert.** The startup side effects (env
   validation, `acquireLock`, `registerCommands`, `login`, signal handlers) live
   inside `if (require.main === module)`, so `node --test` can `require` the module
   without connecting to Discord or exiting. Keep new startup code inside that guard.
6. **Every terminal site logs a record.** When a request leaves the board for
   good — sorted, self-sorted, removed, dropped-as-duplicate on category merge,
   or unresolved at season close — append `logRecord(data, makeRecord(...))`
   *synchronously, before that site's `saveData`* (no `await` between). The
   append-only `data.records` log is the substrate for all of `/stats`; a new
   deletion path that forgets to log silently undercounts every report. If you
   add a way for an entry to leave `data.entries`, add its record too.
7. **`menu:` is the core's prefix; menu messages are V2-only.** First reply
   `Ephemeral | IsComponentsV2`, edits `IsComponentsV2`, never `content` /
   `embeds`. `update()` only on the ephemeral menu message itself
   (`isMenuMessage`) — the public board and the request cards stay V1, and a
   V2 flag can never be taken off a message again.
8. **Writes go through `modules/help/actions.js`.** Every action checks the
   actor's level itself (menu filtering is a convenience), runs
   `loadData()` → `saveData()` without an `await`, and returns its slow REST
   as `effects` for the caller to run after the ack.
9. **The web never writes data itself and never trusts the page.** Every POST
   calls a module action (which checks the level itself); the level comes from
   the bot's live member fetch, never from the session or the form; only POST
   changes anything, and `sameOriginGuard` refuses a POST whose `Origin` is not
   `PUBLIC_URL`. Templates get exactly `{ layout, page }` through `renderView`
   (never `res.render`, never request data as a top-level local); `<%-` only
   for HTML our own code rendered; no inline script or style (CSP). A
   destructive POST goes through `web.confirmed` with a `guard` computed from
   fresh data, so a stale or replayed confirmation writes nothing. Keep
   `Referrer-Policy: same-origin` — `no-referrer` makes browsers send
   `Origin: null` on form POSTs and the CSRF guard would refuse every one.

10.–18. The `lfg` module's invariants are listed in the M4 entry at the top
    of this file.

## Updating

Push to `main`, then restart the TrueNAS app (it re-clones). `data.json` on the
volume is untouched. To change categories, roles, or the notify role, use the
in-Discord commands — no redeploy needed.
