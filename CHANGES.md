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
      "requestChannelId": "…",      // the button card message…
      "requestMessageId": "…"       // …so we can update it later
    }
  ],
  "managerRoleIds": [],        // roles that can run officer actions (set via /config)
  "notifyRoleId": null,        // pinged on new request cards (/config notify)
  "seasons": [],               // archived summaries pushed by /reset (byCategory now generic)
  "categories": [              // configurable categories (seeded with the two defaults)
    { "id": "seasonrun5k", "label": "Season Run 5K", "emoji": "🏃", "archived": false }
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

## Updating

Push to `main`, then restart the TrueNAS app (it re-clones). `data.json` on the
volume is untouched. To change categories, roles, or the notify role, use the
in-Discord commands — no redeploy needed.
