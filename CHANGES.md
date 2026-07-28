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
  env vars on the NAS, `.env` locally). `.gitignore` keeps `.env` + `data.json`
  out of git.

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
  "seasons": []                // archived summaries pushed by /reset
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

"Officers" = Manage Server **or** a role in `managerRoleIds` → see `isManager()`.
`/config` is admin-only (`setDefaultMemberPermissions` **and** an in-code
Manage-Server check).

## Where to look (key functions)

- `loadData()` / `saveData()` — storage. `saveData` writes a temp file then
  `renameSync`s over the target (**atomic** — a crash mid-write can't corrupt it).
  `loadData` normalises shape and recovers from a corrupt file instead of throwing.
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
   overwrite each other (no file locking).

## Updating

Push to `main`, then restart the TrueNAS app (it re-clones). `data.json` on the
volume is untouched. To change categories, roles, or the notify role, use the
in-Discord commands — no redeploy needed.
