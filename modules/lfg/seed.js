// Startup (M4 spec §7, §8.2): the first configuration from the MEE6 layout,
// by channel and role NAME, and the bot's permission check in the board
// channel. The seed runs only while lfg.json has no config — it never
// overwrites a hand-made or (M5) web-made one.
const { ChannelType, PermissionFlagsBits } = require("discord.js");
const S = require("./state");
const D = require("./discord");
const store = require("./store");

const CHANNEL_NAME = "looking-for-game";
const GM_PING = "⚔\uFE0F GM-PING";

// The MEE6 finder (discord/BBDC/docs/mee6-current-state.md): every button's
// ping roles and its subscribable role, by exact name. `partial`: keep the
// button with the roles that exist (ANY pings all three DDPS roles).
const SEED = Object.freeze([
  { id: "basic", name: "BASIC", emoji: "💥", buttons: [
    { id: "sup", label: "SUP", ping: ["💥 SUP"], subscribe: "💥 SUP" },
    { id: "dps", label: "DPS", ping: ["💥 DPS"], subscribe: "💥 DPS" },
    { id: "gm", label: "GM", emoji: "⚔\uFE0F", ping: [GM_PING], subscribe: null },
  ] },
  { id: "ddps", name: "DDPS", emoji: "🧬", buttons: [
    { id: "radar", label: "RADAR", ping: ["🧬 RADAR"], subscribe: "🧬 RADAR" },
    { id: "hack", label: "HACK", ping: ["🧬 HACK"], subscribe: "🧬 HACK" },
    { id: "hackship", label: "HACK+SHIP", ping: ["🧬 HACK+SHIP"], subscribe: "🧬 HACK+SHIP" },
    { id: "any", label: "ANY", ping: ["🧬 RADAR", "🧬 HACK", "🧬 HACK+SHIP"], subscribe: null, partial: true },
  ] },
  { id: "zombie", name: "ZOMBIE", emoji: "🦠", buttons: [
    { id: "sup", label: "SUP", ping: ["🦠 SUP"], subscribe: "🦠 SUP" },
    { id: "dps", label: "DPS", ping: ["🦠 DPS"], subscribe: "🦠 DPS" },
    { id: "ddps", label: "DDPS", ping: ["🦠 DDPS"], subscribe: "🦠 DDPS" },
    { id: "p300", label: "300+", ping: ["🦠 300+"], subscribe: "🦠 300+" },
  ] },
]);

// Role names compare without the emoji variation selector (U+FE0F): "⚔\uFE0F"
// and "⚔" are the same role name to a person.
const norm = (s) => String(s ?? "").replace(/\uFE0F/g, "").trim();

// Pure: { guildId, channels: [{ id, name, type, visible }], roles: [{ id, name }] }
// → { config | null, missing: [name] }.
function buildSeed({ guildId, channels, roles }) {
  const channel = channels.find(
    (c) => c.type === ChannelType.GuildText && c.visible && c.name.includes(CHANNEL_NAME) && !c.name.startsWith("arch")
  );
  if (!channel) return { config: null, missing: [`#${CHANNEL_NAME}`] };
  const byName = new Map(roles.map((r) => [norm(r.name), r.id]));
  const missing = [];
  const categories = [];
  for (const cat of SEED) {
    const buttons = [];
    for (const b of cat.buttons) {
      const found = b.ping.map((n) => byName.get(norm(n)));
      const lost = b.ping.filter((n, i) => !found[i]);
      missing.push(...lost);
      const pingRoleIds = found.filter(Boolean);
      if (pingRoleIds.length === 0 || (lost.length > 0 && !b.partial)) continue;
      buttons.push({
        id: b.id,
        label: b.label,
        emoji: b.emoji || cat.emoji,
        pingRoleIds,
        subscribeRoleId: b.subscribe ? byName.get(norm(b.subscribe)) || null : null,
      });
    }
    if (buttons.length) categories.push({ id: cat.id, name: cat.name, emoji: cat.emoji, buttons });
  }
  const config = {
    channelId: channel.id,
    guildId,
    // §7: the start panel above the board; no banner (M5 web sets one).
    layout: [{ type: "panel" }, { type: "board" }],
    gmPingRoleId: byName.get(norm(GM_PING)) || null,
    categories,
    times: { ...S.DEFAULT_TIMES },
    texts: {},
  };
  return { config, missing: [...new Set(missing)] };
}

const canView = (guild, channel) => {
  if (D.isObfuscated(channel)) return false;
  const me = guild.members && guild.members.me;
  const perms = me && typeof channel.permissionsFor === "function" ? channel.permissionsFor(me) : null;
  return !perms || perms.has(PermissionFlagsBits.ViewChannel);
};

// onReady: seed when there is no config. → "kept" | "seeded" | "no-channel" | "no-guild".
async function seedIfNeeded(ctx) {
  if (store.load(ctx).config) return "kept";
  const guild = await D.getGuild(ctx, null);
  if (!guild) return "no-guild";
  const channels = [...(await guild.channels.fetch()).values()].filter(Boolean).map((c) => ({
    id: c.id,
    name: String(c.name || ""),
    type: c.type,
    visible: canView(guild, c),
  }));
  const roles = [...(await guild.roles.fetch()).values()].map((r) => ({ id: r.id, name: r.name }));
  const { config, missing } = buildSeed({ guildId: guild.id, channels, roles });
  if (missing.length) ctx.log.warn(`seed: not found on the server: ${missing.join(", ")}`);
  if (!config) {
    ctx.log.error(`seed: no visible #${CHANNEL_NAME} channel — the teammate finder stays off until one exists`);
    return "no-channel";
  }
  const fresh = store.load(ctx);
  if (fresh.config) return "kept";
  fresh.config = S.shape({ config }).config;
  store.save(ctx, fresh);
  ctx.log.log(`seed: board channel ${config.channelId}, ${config.categories.reduce((n, c) => n + c.buttons.length, 0)} buttons`);
  return "seeded";
}

// The bot's missing permissions in the board channel, for the log and the
// owner's line in Menu › Teammates (§8.2). Refreshed on every start.
const health = { missing: [], checkedAt: null };

async function checkPermissions(ctx) {
  const data = store.load(ctx);
  health.checkedAt = D.nowOf(ctx);
  if (!data.config) {
    health.missing = [];
    return health;
  }
  const guild = await D.getGuild(ctx, data.config);
  const channel = await D.getChannel(ctx, data.config.channelId);
  const pingRoleIds = [...new Set(data.config.categories.flatMap((c) => c.buttons.flatMap((b) => b.pingRoleIds)))];
  health.missing = D.missingPermissions(guild, channel, pingRoleIds);
  if (health.missing.length) ctx.log.error(`missing permissions in the board channel: ${health.missing.join(", ")}`);
  return health;
}

module.exports = { SEED, CHANNEL_NAME, GM_PING, buildSeed, seedIfNeeded, checkPermissions, health };
