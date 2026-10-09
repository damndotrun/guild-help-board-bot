"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ChannelType, PermissionFlagsBits } = require("discord.js");
const seed = require("../modules/lfg/seed");
const store = require("../modules/lfg/store");
const { dataWith, fakeDiscord, fakeCtx } = require("./fixtures/lfg-fakes");

process.env.GUILD_ID = "g1"; // the seed finds the guild by the env id (no config yet)

const ROLE_NAMES = ["💥 SUP", "💥 DPS", "⚔\uFE0F GM-PING", "🧬 RADAR", "🧬 HACK", "🧬 HACK+SHIP", "🦠 SUP", "🦠 DPS", "🦠 DDPS", "🦠 300+"];
const roles = (names = ROLE_NAMES) => names.map((name, i) => ({ id: `r${i}`, name }));
const text = (id, name, visible = true) => ({ id, name, type: ChannelType.GuildText, visible });
const CHANNELS = [text("c0", "arch︱looking-for-game"), text("c1", "general"), text("c2", "🔍︱looking-for-game")];

test("buildSeed: the MEE6 layout by exact role name — 3 categories, 11 buttons, GM-PING", () => {
  const { config, missing } = seed.buildSeed({ guildId: "g1", channels: CHANNELS, roles: roles() });
  assert.deepEqual(missing, []);
  assert.deepEqual([config.channelId, config.guildId, config.gmPingRoleId, config.layout], ["c2", "g1", "r2", [{ type: "panel" }, { type: "board" }]]);
  assert.deepEqual(config.categories.map((c) => [c.id, c.name, c.emoji, c.buttons.map((b) => b.label).join(",")]), [
    ["basic", "BASIC", "💥", "SUP,DPS,GM"],
    ["ddps", "DDPS", "🧬", "RADAR,HACK,HACK+SHIP,ANY"],
    ["zombie", "ZOMBIE", "🦠", "SUP,DPS,DDPS,300+"],
  ]);
  const btn = (cat, id) => config.categories.find((c) => c.id === cat).buttons.find((b) => b.id === id);
  assert.deepEqual(btn("basic", "gm"), { id: "gm", label: "GM", emoji: "⚔\uFE0F", pingRoleIds: ["r2"], subscribeRoleId: null });
  assert.deepEqual(btn("ddps", "any").pingRoleIds, ["r3", "r4", "r5"]);
  assert.equal(btn("ddps", "any").subscribeRoleId, null);
  assert.deepEqual(btn("zombie", "p300"), { id: "p300", label: "300+", emoji: "🦠", pingRoleIds: ["r9"], subscribeRoleId: "r9" });
});

test("buildSeed: a missing role drops its button (ANY keeps the roles it finds); names match without the emoji variation selector", () => {
  const names = ROLE_NAMES.filter((n) => n !== "💥 DPS" && n !== "🧬 HACK").map((n) => (n === "⚔\uFE0F GM-PING" ? "⚔ GM-PING" : n));
  const { config, missing } = seed.buildSeed({ guildId: "g1", channels: CHANNELS, roles: roles(names) });
  assert.deepEqual(missing, ["💥 DPS", "🧬 HACK"]);
  const basic = config.categories.find((c) => c.id === "basic");
  assert.deepEqual(basic.buttons.map((b) => b.id), ["sup", "gm"]);
  assert.ok(config.gmPingRoleId);
  const any = config.categories.find((c) => c.id === "ddps").buttons.find((b) => b.id === "any");
  assert.equal(any.pingRoleIds.length, 2);
});

test("buildSeed: no visible looking-for-game channel → no config (hidden and arch channels don't count)", () => {
  const hidden = [text("c0", "arch︱looking-for-game"), text("c2", "🔍︱looking-for-game", false), { id: "v1", name: "looking-for-game", type: ChannelType.GuildVoice, visible: true }];
  assert.deepEqual(seed.buildSeed({ guildId: "g1", channels: hidden, roles: roles() }), { config: null, missing: ["#looking-for-game"] });
});

test("seedIfNeeded: seeds once from the live guild, never over an existing config", async () => {
  const fake = fakeDiscord();
  fake.textChannel("c2", { name: "🔍︱looking-for-game" });
  fake.textChannel("c3", { name: "looking-for-game-hidden", flags: 1 << 17 });
  for (const r of roles()) fake.roles.set(r.id, r);
  const ctx = fakeCtx(fake);
  assert.equal(await seed.seedIfNeeded(ctx), "seeded");
  const cfg = store.load(ctx).config;
  assert.equal(cfg.channelId, "c2");
  assert.deepEqual(cfg.times, { reminderLeadMin: 5, checkInWindowMin: 5, startedVisibleMin: 5, nowTtlMin: 30, pingSec: 60 });
  assert.equal(await seed.seedIfNeeded(ctx), "kept");
  const manual = fakeCtx(fake);
  store.save(manual, dataWith());
  assert.equal(await seed.seedIfNeeded(manual), "kept");
  assert.equal(store.load(manual).config.channelId, "ch1");
  const none = fakeCtx(fakeDiscord());
  assert.equal(await seed.seedIfNeeded(none), "no-channel");
  assert.equal(store.load(none).config, null);
});

test("checkPermissions: the missing ones are logged and kept for the owner's menu line", async () => {
  const fake = fakeDiscord({ perms: { has: (b) => b !== PermissionFlagsBits.ManageRoles } });
  const ctx = fakeCtx(fake);
  store.save(ctx, dataWith());
  const health = await seed.checkPermissions(ctx);
  assert.deepEqual(health.missing, ["ManageRoles"]);
  assert.equal(seed.health.missing, health.missing);
  assert.match(ctx.errors[0], /missing permissions in the board channel: ManageRoles/);
});
