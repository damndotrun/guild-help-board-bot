# Guild Help Board Bot

Tracks members who need help hitting **Season Run 5K** or **MVP 5K**, and
lets officers mark them as sorted once helped. Posts a live, auto-updating
board message in a channel of your choice.

## Commands

| Command | Who can use it | What it does |
|---|---|---|
| `/needhelp category:[seasonrun5k/mvp5k] note:optional` | Anyone | Adds you to the board |
| `/helped member:@user category:[seasonrun5k/mvp5k]` | Officers (Manage Server perm) | Marks that member as sorted |
| `/remove member:@user category:[seasonrun5k/mvp5k]` | Officers | Removes an entry without marking it done (fixes mistakes) |
| `/board` | Officers | Posts the live board in the current channel and pins it |
| `/reset` | Officers | Clears the whole board for a new season |

By default, `/helped`, `/remove`, `/board`, and `/reset` require the
**Manage Server** permission. Anyone with that permission on your server can
run them (typically your officers). `/needhelp` is open to everyone.

## 1. Create the Discord application

1. Go to https://discord.com/developers/applications → **New Application**
2. Name it (e.g. "Guild Help Board"), create it
3. Left sidebar → **Bot** → **Add Bot**
4. Under **Privileged Gateway Intents**, you don't need to enable any of them
   for this bot (it doesn't read messages)
5. Click **Reset Token** → copy the token → this is your `DISCORD_TOKEN`
6. Left sidebar → **General Information** → copy the **Application ID** →
   this is your `CLIENT_ID`

## 2. Get your server (guild) ID

In Discord, enable Developer Mode (User Settings → Advanced → Developer
Mode), then right-click your server icon → **Copy Server ID**. This is your
`GUILD_ID`.

## 3. Invite the bot to your server

Go to **OAuth2 → URL Generator** in the developer portal:
- Scopes: `bot`, `applications.commands`
- Bot permissions: `Send Messages`, `Embed Links`, `Read Message History`,
  `Manage Messages` (needed to pin the board)

Copy the generated URL, open it in your browser, and add the bot to your
server.

## 4. Configure and run

```bash
cd guild-bot
cp .env.example .env
# paste your DISCORD_TOKEN, CLIENT_ID, GUILD_ID into .env
npm install
npm start
```

You should see `Slash commands registered.` and `Logged in as ...` in the
console.

## 5. Set up the board

In the Discord channel you want the board in, run `/board`. The bot posts
and pins an embed there — this message updates automatically every time
someone runs `/needhelp`, `/helped`, `/remove`, or `/reset`.

## Keep your token safe

Your `DISCORD_TOKEN` is a password for the bot — anyone who has it can take it
over. The included `.gitignore` keeps `.env` (your token) and `data.json` out
of Git, so following the GitHub-based hosting steps below is safe. Do **not**
remove those lines from `.gitignore`, and never paste your token into a
message, issue, or commit. If it ever leaks, click **Reset Token** in the
Discord developer portal immediately.

## Hosting it 24/7

Running `npm start` on your own computer only works while that computer is
on. To keep the bot running all the time, deploy it to a small always-on
host:

- **Railway** (https://railway.app) — connect this folder as a GitHub repo,
  set the same environment variables in its dashboard, deploy. Free tier
  covers a bot this size.
- **Render** (https://render.com) — similar flow, "Background Worker" service.
- A cheap VPS with `pm2` (`npm i -g pm2 && pm2 start index.js`) also works if
  you're comfortable with that.

## Data

Entries are stored in `data.json` next to `index.js`. If you redeploy on a
host with an ephemeral filesystem (some free tiers wipe disk on restart),
back that file up or switch to a small database — happy to help adapt this
if you hit that.
