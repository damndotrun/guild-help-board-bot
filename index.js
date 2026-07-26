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

// ---------- env validation ----------
const REQUIRED_ENV = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID"];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(
    `Missing required environment variable(s): ${missingEnv.join(", ")}.\n` +
      "Copy .env.example to .env and fill them in (see README)."
  );
  process.exit(1);
}

// ---------- storage ----------
const EMPTY_DATA = { boardChannelId: null, boardMessageId: null, entries: [] };

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { ...EMPTY_DATA };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    // Guard against a partially-shaped file.
    return {
      boardChannelId: parsed.boardChannelId ?? null,
      boardMessageId: parsed.boardMessageId ?? null,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch (err) {
    console.error(
      `data.json is unreadable (${err.message}); starting from an empty board. ` +
        "The old file is left in place for manual inspection."
    );
    return { ...EMPTY_DATA };
  }
}

// Atomic write: write to a temp file, then rename over the target so a crash
// mid-write can never leave a truncated / corrupt data.json.
function saveData(data) {
  fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2));
  fs.renameSync(TMP_FILE, DATA_FILE);
}

const CATEGORIES = {
  seasonrun5k: { label: "Season Run 5K", emoji: "🏃" },
  mvp5k: { label: "MVP 5K", emoji: "⭐" },
};

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

function buildBoardEmbed(data) {
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
      const cat = CATEGORIES[e.category];
      const note = e.note ? ` — _${e.note}_` : "";
      // Mentions render as the member's CURRENT name and do not ping inside an embed.
      return `${cat.emoji} <@${e.userId}> (${cat.label})${note}`;
    });
    embed.addFields({ name: "Waiting", value: renderField(lines) });
  }

  if (done.length > 0) {
    const lines = done.slice(-10).map((e) => {
      const cat = CATEGORIES[e.category];
      return `${cat.emoji} ~~<@${e.userId}>~~ (${cat.label})`;
    });
    embed.addFields({ name: "Sorted (last 10)", value: renderField(lines) });
  }

  return embed;
}

async function refreshBoard(client, data) {
  if (!data.boardChannelId || !data.boardMessageId) return;
  try {
    const channel = await client.channels.fetch(data.boardChannelId);
    const message = await channel.messages.fetch(data.boardMessageId);
    await message.edit({ embeds: [buildBoardEmbed(data)] });
  } catch (err) {
    console.error("Could not refresh board message:", err.message);
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
        .addChoices(
          { name: "Season Run 5K", value: "seasonrun5k" },
          { name: "MVP 5K", value: "mvp5k" }
        )
    )
    .addStringOption((opt) =>
      opt.setName("note").setDescription("Optional note (e.g. '3 more hammers needed')")
    ),

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
        .addChoices(
          { name: "Season Run 5K", value: "seasonrun5k" },
          { name: "MVP 5K", value: "mvp5k" }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

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
        .addChoices(
          { name: "Season Run 5K", value: "seasonrun5k" },
          { name: "MVP 5K", value: "mvp5k" }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("board")
    .setDescription("Post the help board in this channel (becomes the live board)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Clear the board for a new season")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
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
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
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
      data.entries.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        userId: interaction.user.id,
        username: interaction.member?.displayName || interaction.user.username,
        category,
        note,
        done: false,
        ts: Date.now(),
      });
      saveData(data);
      // Acknowledge the user FIRST (3-second window), refresh the board after.
      await respond(interaction, {
        content: `Added you to the board for **${CATEGORIES[category].label}**. ${CATEGORIES[category].emoji}`,
        flags: MessageFlags.Ephemeral,
      });
      await refreshBoard(client, data);
    }

    if (interaction.commandName === "helped") {
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
      saveData(data);
      await respond(
        interaction,
        `✅ Marked **${entry.username}** as sorted for ${CATEGORIES[category].label}.`
      );
      await refreshBoard(client, data);
    }

    if (interaction.commandName === "remove") {
      const member = interaction.options.getUser("member");
      const category = interaction.options.getString("category");
      const before = data.entries.length;
      data.entries = data.entries.filter(
        (e) => !(e.userId === member.id && e.category === category && !e.done)
      );
      if (data.entries.length === before) {
        await respond(interaction, {
          content: `No pending entry found for ${member.username} in ${CATEGORIES[category].label}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      saveData(data);
      await respond(interaction, {
        content: `Removed ${member.username}'s entry.`,
        flags: MessageFlags.Ephemeral,
      });
      await refreshBoard(client, data);
    }

    if (interaction.commandName === "board") {
      // Multiple REST calls follow — defer so we never miss the 3-second window.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const embed = buildBoardEmbed(data);
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
      data.entries = [];
      saveData(data);
      await respond(interaction, "Board cleared for the new season. 🌱");
      await refreshBoard(client, data);
    }
  } catch (err) {
    console.error(err);
    await respond(interaction, {
      content: "Something went wrong running that command.",
      flags: MessageFlags.Ephemeral,
    });
  }
});

// Last-resort safety net so a stray rejection is logged, not silently fatal.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

(async () => {
  try {
    await registerCommands();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    console.error("Failed to start the bot:", err);
    process.exit(1);
  }
})();
