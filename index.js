// Guild Help Board — Discord bot
// Tracks who needs help with Season Run 5K / MVP 5K for season rewards,
// and lets officers mark them as sorted once helped.

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Data lives next to the code by default; set DATA_DIR to keep data.json on a
// persistent volume when the code itself is ephemeral (e.g. re-cloned on boot).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const TMP_FILE = path.join(DATA_DIR, "data.json.tmp");
const BAK_FILE = path.join(DATA_DIR, "data.json.bak");

// ---------- storage ----------
const EMPTY_DATA = {
  boardChannelId: null,
  boardMessageId: null,
  entries: [],
  managerRoleIds: [],
  notifyRoleId: null,
  seasons: [],
};

function readAndShape(raw) {
  const parsed = JSON.parse(raw);
  return {
    boardChannelId: parsed.boardChannelId ?? null,
    boardMessageId: parsed.boardMessageId ?? null,
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    managerRoleIds: Array.isArray(parsed.managerRoleIds) ? parsed.managerRoleIds : [],
    notifyRoleId: parsed.notifyRoleId ?? null,
    seasons: Array.isArray(parsed.seasons) ? parsed.seasons : [],
  };
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { ...EMPTY_DATA };
  try {
    return readAndShape(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    // data.json is unreadable — try the last-known-good backup before giving up.
    try {
      if (fs.existsSync(BAK_FILE)) {
        const restored = readAndShape(fs.readFileSync(BAK_FILE, "utf8"));
        console.error(
          `data.json unreadable (${err.message}); restored from data.json.bak.`
        );
        return restored;
      }
    } catch (bakErr) {
      console.error(`data.json.bak also unreadable (${bakErr.message}).`);
    }
    console.error(
      `data.json is unreadable (${err.message}); starting from an empty board. ` +
        "The old files are left in place for manual inspection."
    );
    return { ...EMPTY_DATA };
  }
}

// Atomic write: write to a temp file, then rename over the target so a crash
// mid-write can never leave a truncated / corrupt data.json.
function saveData(data) {
  fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2));
  // Keep one last-known-good copy: back up the current file before replacing it.
  // Best-effort — a backup failure must never block the actual save.
  try {
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BAK_FILE);
  } catch (err) {
    console.error("Could not write data.json.bak:", err.message);
  }
  fs.renameSync(TMP_FILE, DATA_FILE);
}

// ---------- lock (single-instance advisory) ----------
const LOCK_FILE = path.join(DATA_DIR, "bot.lock");
const LOCK_STALE_MS = 90_000; // treat a lock older than this as abandoned
const LOCK_REFRESH_MS = 30_000; // heartbeat cadence (well under the stale window)

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return null; // no lock, or unreadable — treat as absent
  }
}

// Advisory only: a fresh heartbeat means another instance is probably alive.
function isLockFresh(lock, now) {
  return (
    !!lock &&
    typeof lock.heartbeat === "number" &&
    now - lock.heartbeat < LOCK_STALE_MS
  );
}

// Write the lock and keep a heartbeat. NEVER blocks startup: on a fresh lock we
// only warn (the deploy model is a clean swap, so a real double-run is a local
// accident, and a stale lock must never wedge the "restart = update" path).
function acquireLock() {
  const now = Date.now();
  const existing = readLock();
  if (isLockFresh(existing, now)) {
    console.warn(
      `WARNING: bot.lock heartbeat is fresh (pid ${existing.pid}); another ` +
        `instance may be running against ${DATA_FILE}. Starting anyway.`
    );
  }
  const write = (ts) =>
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, startedTs: now, heartbeat: ts })
    );
  try {
    write(now);
  } catch (err) {
    console.error("Could not write bot.lock:", err.message);
  }
  const timer = setInterval(() => {
    try {
      write(Date.now());
    } catch {
      // transient FS error — the next tick will retry
    }
  }, LOCK_REFRESH_MS);
  timer.unref(); // never keep the process alive for the heartbeat alone
  return timer;
}

// Who may run the officer commands: anyone with Manage Server, OR anyone holding
// a role that an admin added via /config. With no manager roles set, it falls
// back to Manage Server only — so you can never lock yourself out.
function isManager(interaction, data) {
  const perms = interaction.memberPermissions;
  if (perms && perms.has(PermissionFlagsBits.ManageGuild)) return true;
  const roleIds = data.managerRoleIds || [];
  if (roleIds.length === 0) return false;
  const cache = interaction.member?.roles?.cache;
  if (cache) return roleIds.some((id) => cache.has(id));
  return false;
}

const CATEGORIES = {
  seasonrun5k: { label: "Season Run 5K", emoji: "🏃" },
  mvp5k: { label: "MVP 5K", emoji: "⭐" },
};

// Never throw while rendering a stored entry whose category we no longer know.
const catOf = (c) => CATEGORIES[c] || { label: c, emoji: "❓" };

const NO_PERM = {
  content:
    "You need the **Manage Server** permission or a manager role to do that.",
  flags: MessageFlags.Ephemeral,
};

// Human-friendly duration, e.g. "2d 3h", "3h 12m", "8m".
function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return "under a minute";
}

// Tally sorts-per-helper for the /stats leaderboard. Sorted desc by count.
function tallyHelpers(entries) {
  const tally = {};
  for (const e of entries) {
    if (e.done && e.helpedBy) tally[e.helpedBy] = (tally[e.helpedBy] || 0) + 1;
  }
  return Object.entries(tally).sort((a, b) => b[1] - a[1]);
}

// ---------- board rendering ----------
// Join lines into a single embed-field value, staying under Discord's 1024-char
// limit and clearly flagging any entries that had to be hidden.
function renderField(lines) {
  if (lines.length === 0) return "—";
  const LIMIT = 1024;
  const full = lines.join("\n");
  if (full.length <= LIMIT) return full;

  const RESERVE = 24; // room for the "…and N more" suffix
  const out = [];
  let len = 0;
  for (const line of lines) {
    const add = (out.length ? 1 : 0) + line.length;
    if (len + add > LIMIT - RESERVE) break;
    out.push(line);
    len += add;
  }
  const hidden = lines.length - out.length;
  return `${out.join("\n")}\n_…and ${hidden} more_`;
}

function buildBoardEmbed(data, names = {}) {
  const nameOf = (e) => names[e.userId] || e.username || "someone";
  const pending = data.entries.filter((e) => !e.done);
  const done = data.entries.filter((e) => e.done);

  const embed = new EmbedBuilder()
    .setColor(0x5ac9a1)
    .setTitle("🛡️ Guild Help Board")
    .setDescription(
      "Need help hitting Season Run 5K or MVP 5K? Use `/needhelp`."
    )
    .setFooter({ text: `${pending.length} waiting · ${done.length} sorted this season` })
    .setTimestamp();

  if (pending.length === 0) {
    embed.addFields({ name: "Waiting", value: "Nobody's waiting right now 🎉" });
  } else {
    const lines = pending.map((e) => {
      const cat = catOf(e.category);
      const note = e.note ? ` — _${e.note}_` : "";
      const since = e.ts ? ` · <t:${Math.floor(e.ts / 1000)}:R>` : "";
      return `${cat.emoji} **${nameOf(e)}** (${cat.label})${note}${since}`;
    });
    embed.addFields({ name: "Waiting", value: renderField(lines) });
  }

  if (done.length > 0) {
    const lines = done.slice(-10).map((e) => {
      const cat = catOf(e.category);
      return `${cat.emoji} ~~${nameOf(e)}~~ (${cat.label})`;
    });
    embed.addFields({ name: "Sorted (last 10)", value: renderField(lines) });
  }

  return embed;
}

// Resolve each entry's CURRENT display name from its stored user id. A single
// member fetch needs no privileged intent and is cached by discord.js. If a
// member can't be fetched (e.g. they left the guild), we fall back to the last
// stored name — so the board never shows a raw id. READ-ONLY on purpose: it must
// never write data.json, or it could clobber a concurrent write with the stale
// snapshot it was handed (this runs after other awaits in every handler).
async function resolveNames(guild, data) {
  const names = {};
  // Only resolve what the board actually shows: all pending + the last 10 sorted.
  const pending = data.entries.filter((e) => !e.done);
  const done = data.entries.filter((e) => e.done).slice(-10);
  for (const e of [...pending, ...done]) {
    if (names[e.userId]) continue; // already resolved this user
    let name = e.username || "someone";
    if (guild) {
      try {
        const member =
          guild.members.cache.get(e.userId) ||
          (await guild.members.fetch(e.userId));
        name = member.displayName;
      } catch {
        // member left the guild or couldn't be fetched — keep the stored name
      }
    }
    names[e.userId] = name;
  }
  return names;
}

// Look up one member's current display name (for the /stats leaderboard).
async function memberName(guild, userId) {
  if (!guild) return null;
  try {
    const member =
      guild.members.cache.get(userId) || (await guild.members.fetch(userId));
    return member.displayName;
  } catch {
    return null;
  }
}

async function refreshBoard(client, data) {
  if (!data.boardChannelId || !data.boardMessageId) return;
  try {
    const channel = await client.channels.fetch(data.boardChannelId);
    const names = await resolveNames(channel.guild, data);
    const message = await channel.messages.fetch(data.boardMessageId);
    await message.edit({ embeds: [buildBoardEmbed(data, names)] });
  } catch (err) {
    console.error("Could not refresh board message:", err.message);
  }
}

// ---------- help-request cards (one-click officer actions) ----------
function requestButtons(entryId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`help:sorted:${entryId}`)
      .setLabel("Sorted")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`help:remove:${entryId}`)
      .setLabel("Remove")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Secondary)
  );
}

// Post a request card so officers can resolve it with one click. Goes to the
// board channel if set, otherwise the channel the command was used in.
async function postRequestCard(client, data, entry, fallbackChannelId) {
  const channelId = data.boardChannelId || fallbackChannelId;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    const cat = catOf(entry.category);
    const note = entry.note ? `\n📝 _${entry.note}_` : "";
    const embed = new EmbedBuilder()
      .setColor(0x5ac9a1)
      .setDescription(
        `🙋 **${entry.username}** needs help with **${cat.label}** ${cat.emoji}${note}`
      )
      .setFooter({ text: "Officers: use the buttons below when it's handled" })
      .setTimestamp();
    const message = await channel.send({
      content: data.notifyRoleId ? `<@&${data.notifyRoleId}>` : undefined,
      embeds: [embed],
      components: [requestButtons(entry.id)],
      allowedMentions: data.notifyRoleId
        ? { roles: [data.notifyRoleId] }
        : { parse: [] },
    });
    entry.requestChannelId = channel.id;
    entry.requestMessageId = message.id;
  } catch (err) {
    console.error("Could not post request card:", err.message);
  }
}

// Finalise a request card (used by the slash commands; button clicks edit the
// card directly via interaction.update instead).
async function resolveCard(client, entry, statusLine) {
  if (!entry.requestChannelId || !entry.requestMessageId) return;
  try {
    const channel = await client.channels.fetch(entry.requestChannelId);
    const message = await channel.messages.fetch(entry.requestMessageId);
    await message.edit({
      content: statusLine,
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch {
    // card already gone or not editable — nothing to do
  }
}

async function dmSorted(client, userId, category) {
  try {
    const user = await client.users.fetch(userId);
    const cat = catOf(category);
    await user.send(
      `✅ You've been sorted for **${cat.label}** ${cat.emoji} on the Guild Help Board. Thanks for your patience!`
    );
  } catch {
    // the member has DMs closed or has left — not a problem
  }
}

// Reply safely regardless of the interaction's current state, and never let the
// recovery path itself throw an unhandled rejection.
async function respond(interaction, payload) {
  try {
    if (interaction.deferred) return await interaction.editReply(payload);
    if (interaction.replied) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (err) {
    console.error("Failed to respond to interaction:", err?.message ?? err);
  }
}

const CATEGORY_CHOICES = [
  { name: "Season Run 5K", value: "seasonrun5k" },
  { name: "MVP 5K", value: "mvp5k" },
];

// ---------- slash commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName("needhelp")
    .setDescription("Add yourself to the help board for this season")
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("What do you need help with?")
        .setRequired(true)
        .addChoices(...CATEGORY_CHOICES)
    )
    .addStringOption((opt) =>
      opt.setName("note").setDescription("Optional note (e.g. '3 more hammers needed')")
    ),

  new SlashCommandBuilder()
    .setName("imsorted")
    .setDescription("Remove yourself from the board (you got the help you needed)")
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("Which one? Leave empty to remove all of yours")
        .addChoices(...CATEGORY_CHOICES)
    ),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Season stats: waiting, sorted, wait time, and top helpers"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("How to use the Guild Help Board bot"),

  new SlashCommandBuilder()
    .setName("helped")
    .setDescription("Mark a member as sorted / helped")
    .addUserOption((opt) =>
      opt.setName("member").setDescription("Who got helped").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("Which category")
        .setRequired(true)
        .addChoices(...CATEGORY_CHOICES)
    ),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a member's entry without marking it done")
    .addUserOption((opt) =>
      opt.setName("member").setDescription("Who to remove").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("Which category")
        .setRequired(true)
        .addChoices(...CATEGORY_CHOICES)
    ),

  new SlashCommandBuilder()
    .setName("board")
    .setDescription("Post the help board in this channel (becomes the live board)"),

  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Clear the board for a new season"),

  // Admin-only: bootstrap which roles may run the officer commands above.
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configure roles and notifications for the help board")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("addrole")
        .setDescription("Allow a role to manage the board")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to allow").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("removerole")
        .setDescription("Stop a role from managing the board")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to remove").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("roles").setDescription("List roles and notification settings")
    )
    .addSubcommand((sub) =>
      sub
        .setName("notify")
        .setDescription("Ping a role on new requests (leave empty to turn off)")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to ping (empty = off)")
        )
    ),
].map((c) => c.toJSON());

// ---------- register commands ----------
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log("Slash commands registered.");
}

// ---------- client ----------
// parse: [] by default means no message ever pings anyone unless a specific call
// opts in (the request card explicitly allows the notify role). This neutralises
// mention injection via user-controlled nicknames in replies.
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [] },
});

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ---------- button handling (one-click officer actions) ----------
async function handleButton(interaction) {
  const [ns, action, entryId] = interaction.customId.split(":");
  if (ns !== "help") return;

  const data = loadData();
  if (!isManager(interaction, data)) {
    await respond(interaction, NO_PERM);
    return;
  }

  const entry = data.entries.find((e) => e.id === entryId);
  if (!entry || entry.done) {
    // Nothing to act on — just clear the stale buttons.
    try {
      await interaction.update({ components: [] });
    } catch {
      await respond(interaction, {
        content: "That request has already been handled.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  const byName = interaction.member?.displayName || interaction.user.username;

  if (action === "sorted") {
    entry.done = true;
    entry.doneTs = Date.now();
    entry.helpedBy = interaction.user.id;
    saveData(data);
    await interaction.update({
      content: `✅ Sorted by ${byName}`,
      components: [],
      allowedMentions: { parse: [] },
    });
    await dmSorted(client, entry.userId, entry.category);
    await refreshBoard(client, data);
  } else if (action === "remove") {
    data.entries = data.entries.filter((e) => e.id !== entryId);
    saveData(data);
    await interaction.update({
      content: `🗑️ Removed by ${byName}`,
      components: [],
      allowedMentions: { parse: [] },
    });
    await refreshBoard(client, data);
  } else {
    // Unknown / future action — acknowledge so Discord doesn't show "failed".
    await respond(interaction, {
      content: "Unknown action.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    const data = loadData();

    if (interaction.commandName === "needhelp") {
      const category = interaction.options.getString("category");
      const note = interaction.options.getString("note") || "";
      const existing = data.entries.find(
        (e) => e.userId === interaction.user.id && e.category === category && !e.done
      );
      if (existing) {
        await respond(interaction, {
          content: `You're already on the board for ${CATEGORIES[category].label}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        userId: interaction.user.id,
        username: interaction.member?.displayName || interaction.user.username,
        category,
        note,
        done: false,
        ts: Date.now(),
      };
      data.entries.push(entry);
      saveData(data);
      // Acknowledge the user FIRST (3-second window), then do the slow work.
      await respond(interaction, {
        content: `Added you to the board for **${CATEGORIES[category].label}**. ${CATEGORIES[category].emoji}`,
        flags: MessageFlags.Ephemeral,
      });
      await postRequestCard(client, data, entry, interaction.channelId);
      // Persist the card ids without clobbering any concurrent write.
      const fresh = loadData();
      const target = fresh.entries.find((e) => e.id === entry.id);
      if (target) {
        target.requestChannelId = entry.requestChannelId;
        target.requestMessageId = entry.requestMessageId;
        saveData(fresh);
      }
      await refreshBoard(client, fresh);
    }

    if (interaction.commandName === "imsorted") {
      const category = interaction.options.getString("category");
      const mine = data.entries.filter(
        (e) =>
          e.userId === interaction.user.id &&
          !e.done &&
          (!category || e.category === category)
      );
      if (mine.length === 0) {
        await respond(interaction, {
          content: "You're not on the board right now.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const ids = new Set(mine.map((e) => e.id));
      data.entries = data.entries.filter((e) => !ids.has(e.id));
      saveData(data);
      await respond(interaction, {
        content: "Took you off the board. Glad you got sorted! 🎉",
        flags: MessageFlags.Ephemeral,
      });
      for (const e of mine) {
        await resolveCard(client, e, `✅ ${e.username} marked themselves sorted`);
      }
      await refreshBoard(client, data);
    }

    if (interaction.commandName === "stats") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const pending = data.entries.filter((e) => !e.done);
      const done = data.entries.filter((e) => e.done);
      const countBy = (arr, c) => arr.filter((e) => e.category === c).length;

      const waits = done
        .filter((e) => e.ts && e.doneTs && e.doneTs >= e.ts)
        .map((e) => e.doneTs - e.ts);
      const avg = waits.length
        ? waits.reduce((a, b) => a + b, 0) / waits.length
        : null;

      const top = tallyHelpers(data.entries).slice(0, 5);
      const medals = ["🥇", "🥈", "🥉"];
      const lbLines = [];
      for (let i = 0; i < top.length; i++) {
        const [id, n] = top[i];
        const nm = (await memberName(interaction.guild, id)) || "(left the server)";
        lbLines.push(`${medals[i] || "•"} ${nm} — **${n}**`);
      }

      const embed = new EmbedBuilder()
        .setColor(0x5ac9a1)
        .setTitle("📊 Guild Help Board — season stats")
        .addFields(
          {
            name: "Waiting",
            value: `🏃 **${countBy(pending, "seasonrun5k")}**  ·  ⭐ **${countBy(pending, "mvp5k")}**`,
            inline: true,
          },
          {
            name: "Sorted this season",
            value: `🏃 **${countBy(done, "seasonrun5k")}**  ·  ⭐ **${countBy(done, "mvp5k")}**  (total **${done.length}**)`,
            inline: true,
          },
          {
            name: "Average wait",
            value: avg != null ? formatDuration(avg) : "—",
          },
          {
            name: "Top helpers",
            value: lbLines.length ? lbLines.join("\n") : "No sorts recorded yet.",
          }
        );
      const last = data.seasons[data.seasons.length - 1];
      if (last) {
        embed.addFields({
          name: "Last season",
          value: `${last.sortedTotal} sorted (🏃 ${last.byCategory.seasonrun5k} · ⭐ ${last.byCategory.mvp5k})`,
        });
      }
      await respond(interaction, {
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.commandName === "help") {
      const embed = new EmbedBuilder()
        .setColor(0x5ac9a1)
        .setTitle("🛡️ Guild Help Board — how it works")
        .setDescription(
          "Tracks who needs help hitting **Season Run 5K** or **MVP 5K** this " +
            "season, and lets officers mark them as sorted once helped. The board " +
            "message updates automatically."
        )
        .addFields(
          {
            name: "🟢 Everyone",
            value:
              "`/needhelp` — add yourself (posts a request officers can action)\n" +
              "`/imsorted` — remove yourself once you've been helped\n" +
              "`/stats` — season stats & top helpers\n" +
              "`/help` — show this message",
          },
          {
            name: "🛡️ Officers (Manage Server, or a manager role)",
            value:
              "Click **✅ Sorted** / **🗑️ Remove** on a request card, or:\n" +
              "`/helped @member <category>` — mark them as sorted\n" +
              "`/remove @member <category>` — remove an entry\n" +
              "`/board` — post & pin the live board\n" +
              "`/reset` — clear the board for a new season",
          },
          {
            name: "⚙️ Admins (Manage Server)",
            value:
              "`/config addrole @role` — let a role manage the board\n" +
              "`/config removerole @role` — remove a role\n" +
              "`/config notify @role` — ping a role on new requests\n" +
              "`/config roles` — show current settings",
          }
        );
      await respond(interaction, {
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.commandName === "helped") {
      if (!isManager(interaction, data)) {
        await respond(interaction, NO_PERM);
        return;
      }
      const member = interaction.options.getUser("member");
      const category = interaction.options.getString("category");
      const entry = data.entries.find(
        (e) => e.userId === member.id && e.category === category && !e.done
      );
      if (!entry) {
        await respond(interaction, {
          content: `No pending entry found for ${member.username} in ${CATEGORIES[category].label}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      entry.done = true;
      entry.doneTs = Date.now();
      entry.helpedBy = interaction.user.id;
      saveData(data);
      await respond(
        interaction,
        `✅ Marked **${entry.username}** as sorted for ${CATEGORIES[category].label}.`
      );
      const byName = interaction.member?.displayName || interaction.user.username;
      await resolveCard(client, entry, `✅ Sorted by ${byName}`);
      await dmSorted(client, entry.userId, entry.category);
      await refreshBoard(client, data);
    }

    if (interaction.commandName === "remove") {
      if (!isManager(interaction, data)) {
        await respond(interaction, NO_PERM);
        return;
      }
      const member = interaction.options.getUser("member");
      const category = interaction.options.getString("category");
      const target = data.entries.find(
        (e) => e.userId === member.id && e.category === category && !e.done
      );
      if (!target) {
        await respond(interaction, {
          content: `No pending entry found for ${member.username} in ${CATEGORIES[category].label}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      data.entries = data.entries.filter((e) => e !== target);
      saveData(data);
      await respond(interaction, {
        content: `Removed ${member.username}'s entry.`,
        flags: MessageFlags.Ephemeral,
      });
      const byName = interaction.member?.displayName || interaction.user.username;
      await resolveCard(client, target, `🗑️ Removed by ${byName}`);
      await refreshBoard(client, data);
    }

    if (interaction.commandName === "board") {
      if (!isManager(interaction, data)) {
        await respond(interaction, NO_PERM);
        return;
      }
      // Multiple REST calls follow — defer so we never miss the 3-second window.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const names = await resolveNames(interaction.guild, data);
      const embed = buildBoardEmbed(data, names);
      const message = await interaction.channel.send({ embeds: [embed] });
      try {
        await message.pin();
      } catch (e) {
        // missing perms to pin is non-fatal
      }

      // Retire the previous board, if any, so we don't leave a stale pinned copy.
      if (
        data.boardChannelId &&
        data.boardMessageId &&
        data.boardMessageId !== message.id
      ) {
        try {
          const oldChannel = await client.channels.fetch(data.boardChannelId);
          const oldMessage = await oldChannel.messages.fetch(data.boardMessageId);
          await oldMessage.unpin().catch(() => {});
          await oldMessage
            .edit({
              content: "_This board has been retired; a newer one was posted._",
              embeds: [],
            })
            .catch(() => {});
        } catch (e) {
          // old message already gone — nothing to retire
        }
      }

      // Re-load fresh before saving: entries may have been added during the
      // awaits above, and we must not clobber them with our stale snapshot.
      const fresh = loadData();
      fresh.boardChannelId = interaction.channel.id;
      fresh.boardMessageId = message.id;
      saveData(fresh);

      await respond(interaction, {
        content: "Board posted and pinned. It'll update live from now on.",
      });
    }

    if (interaction.commandName === "reset") {
      if (!isManager(interaction, data)) {
        await respond(interaction, NO_PERM);
        return;
      }
      const done = data.entries.filter((e) => e.done);
      const pending = data.entries.filter((e) => !e.done);
      if (done.length > 0) {
        data.seasons.push({
          endedTs: Date.now(),
          sortedTotal: done.length,
          byCategory: {
            seasonrun5k: done.filter((e) => e.category === "seasonrun5k").length,
            mvp5k: done.filter((e) => e.category === "mvp5k").length,
          },
        });
        if (data.seasons.length > 12) data.seasons = data.seasons.slice(-12);
      }
      data.entries = [];
      saveData(data);
      await respond(interaction, "Board cleared for the new season. 🌱");
      // Close any open request cards so they don't linger looking actionable.
      for (const e of pending) {
        await resolveCard(client, e, "Season reset — this request is closed.");
      }
      await refreshBoard(client, data);
    }

    if (interaction.commandName === "config") {
      // Defense in depth: setDefaultMemberPermissions can be relaxed by admins in
      // Discord's Integration settings, so re-check Manage Server in code too.
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await respond(interaction, {
          content:
            "Only members with **Manage Server** can change bot settings.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const sub = interaction.options.getSubcommand();

      if (sub === "addrole") {
        const role = interaction.options.getRole("role");
        if (data.managerRoleIds.includes(role.id)) {
          await respond(interaction, {
            content: `**${role.name}** is already a manager role.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        data.managerRoleIds.push(role.id);
        saveData(data);
        await respond(interaction, {
          content: `Added **${role.name}** as a manager role. Members with it can now run the officer commands.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "removerole") {
        const role = interaction.options.getRole("role");
        const before = data.managerRoleIds.length;
        data.managerRoleIds = data.managerRoleIds.filter((id) => id !== role.id);
        if (data.managerRoleIds.length === before) {
          await respond(interaction, {
            content: `**${role.name}** isn't a manager role.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        saveData(data);
        await respond(interaction, {
          content: `Removed **${role.name}** from manager roles.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "notify") {
        const role = interaction.options.getRole("role");
        data.notifyRoleId = role ? role.id : null;
        saveData(data);
        await respond(interaction, {
          content: role
            ? `New requests will now ping **${role.name}**.`
            : "Turned off request pings.",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "roles") {
        const roles =
          data.managerRoleIds.length > 0
            ? data.managerRoleIds.map((id) => `<@&${id}>`).join(", ")
            : "_none_ (only Manage Server can manage)";
        const notify = data.notifyRoleId
          ? `<@&${data.notifyRoleId}>`
          : "_off_";
        await respond(interaction, {
          content: `**Manager roles:** ${roles}\n**Request pings:** ${notify}`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }
    }
  } catch (err) {
    console.error(err);
    await respond(interaction, {
      content: "Something went wrong running that command.",
      flags: MessageFlags.Ephemeral,
    });
  }
});

module.exports = {
  formatDuration,
  renderField,
  catOf,
  isManager,
  buildBoardEmbed,
  loadData,
  saveData,
  tallyHelpers,
  isLockFresh,
};

if (require.main === module) {
  const REQUIRED_ENV = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID"];
  const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missingEnv.length > 0) {
    console.error(
      `Missing required environment variable(s): ${missingEnv.join(", ")}.\n` +
        "Copy .env.example to .env and fill them in (see README)."
    );
    process.exit(1);
  }
  acquireLock();
  (async () => {
    try {
      await registerCommands();
      await client.login(process.env.DISCORD_TOKEN);
    } catch (err) {
      console.error("Failed to start the bot:", err);
      process.exit(1);
    }
  })();
}

// Last-resort safety net so a stray rejection is logged, not silently fatal.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
