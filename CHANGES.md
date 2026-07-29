# Developer notes — what changed & where

Hey Bogdan — this is your Guild Help Board bot, reviewed, hardened, extended,
and deployed. Everything is still one file (`index.js`, discord.js v14). This
doc is a map of what changed and where to look, plus a few invariants so the
tricky bits don't get re-broken.

---

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

## Commands (all handled in the `interactionCreate` listener, switched on `commandName`)

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
- `isManager(interaction, data)` — permission gate for officer actions.
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

## ⚠️ Invariants — please keep these to avoid re-introducing bugs

1. **No `await` between `loadData()` and `saveData()` in a handler.** The whole
   read-modify-write must be synchronous, or a concurrent interaction's write
   gets clobbered. Where an await is unavoidable before persisting (e.g.
   `/needhelp` saving the card message id), re-`loadData()`, patch the entry by
   `id`, and save that fresh copy — see `/needhelp`.
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

## Updating

Push to `main`, then restart the TrueNAS app (it re-clones). `data.json` on the
volume is untouched. To change categories, roles, or the notify role, use the
in-Discord commands — no redeploy needed.
