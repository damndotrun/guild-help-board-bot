"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bbperms-"));
process.env.DATA_DIR = TMP;
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
process.env.GUILD_ID = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");
const { computeLevel, atLeast, createPerms, managerRolesFrom, LEVEL_LABEL } = require("../core/perms");
const { normalizeModule } = require("../core/loader");
const { createCtxFor } = require("../core/runtime");
const help = require("../modules/help/help");
const helpModule = require("../modules/help");

// The permission gate as it was before M2b — the oracle for parity — plus
// one deliberate change (review 2026-10-08): a raw API member (guild not
// cached yet, roles = an array of ids) is read by its roles instead of being
// treated as having none.
function legacyIsManager(interaction, data) {
  const perms = interaction.memberPermissions;
  if (perms && perms.has(PermissionFlagsBits.ManageGuild)) return true;
  const roleIds = data.managerRoleIds || [];
  if (roleIds.length === 0) return false;
  const raw = interaction.member?.roles;
  const cache = Array.isArray(raw) ? new Set(raw) : raw?.cache;
  if (cache) return roleIds.some((id) => cache.has(id));
  return false;
}

const PERMISSIONS = [{ has: (f) => f === PermissionFlagsBits.ManageGuild }, { has: () => false }, null, undefined];
const MEMBERS = [
  { roles: { cache: new Map([["r1", true]]) } },
  { roles: { cache: new Map() } },
  { roles: ["r1"] }, // raw API member (not cached) — roles is an array of ids
  undefined,
];
const ROLE_SETS = [[], ["r1"], ["r2", "r1"], ["r2"]];

test("computeLevel: Manage Server → owner, a manager role → officer, else member", () => {
  const manage = { has: (f) => f === PermissionFlagsBits.ManageGuild };
  assert.equal(computeLevel({ permissions: manage, roleCache: undefined, managerRoleIds: [] }), "owner");
  assert.equal(computeLevel({ permissions: null, roleCache: new Map([["r1", true]]), managerRoleIds: ["r1"] }), "officer");
  assert.equal(computeLevel({ permissions: null, roleCache: new Map([["r1", true]]), managerRoleIds: [] }), "member");
  assert.equal(computeLevel({ permissions: undefined, roleCache: undefined, managerRoleIds: ["r1"] }), "member");
});

test("atLeast: cumulative levels; unknown levels never pass", () => {
  assert.equal(atLeast("owner", "officer"), true);
  assert.equal(atLeast("officer", "officer"), true);
  assert.equal(atLeast("member", "officer"), false);
  assert.equal(atLeast("owner", "member"), true);
  assert.equal(atLeast("guest", "member"), false);
  assert.equal(atLeast(undefined, "member"), false);
  assert.equal(atLeast("owner", "admin"), false);
  assert.deepEqual(Object.keys(LEVEL_LABEL), ["member", "officer", "owner"]);
});

test("parity: levelOfInteraction ≥ officer ⇔ the pre-M2b isManager; help.isManager unchanged", () => {
  let cases = 0;
  for (const memberPermissions of PERMISSIONS) {
    for (const member of MEMBERS) {
      for (const managerRoleIds of ROLE_SETS) {
        const interaction = { memberPermissions, member };
        const data = { managerRoleIds };
        const perms = createPerms({ getManagerRoleIds: () => managerRoleIds });
        const level = perms.levelOfInteraction(interaction);
        const expected = legacyIsManager(interaction, data);
        const manage = !!memberPermissions?.has?.(PermissionFlagsBits.ManageGuild);
        const what = JSON.stringify({ manage, member, managerRoleIds });
        assert.equal(atLeast(level, "officer"), expected, what);
        assert.equal(help.isManager(interaction, data), expected, what);
        assert.equal(level === "owner", manage, what);
        cases += 1;
      }
    }
  }
  assert.equal(cases, 64);
});

test("levelOf(member): reads GuildMember.permissions by default", () => {
  const perms = createPerms({ getManagerRoleIds: () => ["r1"] });
  assert.equal(perms.levelOf({ permissions: { has: () => true }, roles: { cache: new Map() } }), "owner");
  assert.equal(perms.levelOf({ permissions: { has: () => false }, roles: { cache: new Map([["r1", true]]) } }), "officer");
  assert.equal(perms.levelOf(undefined), "member");
});

test("managerRolesFrom: one provider; none → []; junk → []; two → hard error", () => {
  const a = { name: "a", managerRoles: () => ["r1"] };
  const b = { name: "b", managerRoles: () => ["r2"] };
  const none = { name: "c", managerRoles: null };
  assert.deepEqual(managerRolesFrom([none, a])(), ["r1"]);
  assert.deepEqual(managerRolesFrom([none])(), []);
  assert.deepEqual(managerRolesFrom([{ name: "d", managerRoles: () => "nope" }])(), []);
  assert.throws(() => managerRolesFrom([a, b]), /more than one module: a, b/);
});

test("help module provides managerRoleIds from data.json, read-only", () => {
  const d = help.emptyData();
  d.managerRoleIds = ["r9"];
  help.saveData(d);
  const mod = normalizeModule(helpModule);
  assert.deepEqual(mod.managerRoles(), ["r9"]);
  assert.deepEqual(managerRolesFrom([mod])(), ["r9"]);
});

test("ctx.perms: every module ctx carries the one shared perms object", () => {
  const perms = createPerms();
  const ctxFor = createCtxFor({ client: {}, dataDir: TMP, perms });
  assert.equal(ctxFor(normalizeModule({ name: "a", handle: async () => {} })).perms, perms);
  assert.equal(ctxFor(normalizeModule({ name: "b", dataFile: null, handle: async () => {} })).perms, perms);
});

test("actorOf: user id, display name and the level from the same rule", () => {
  const data = { managerRoleIds: ["r1"] };
  const officer = {
    user: { id: "u1", username: "kovi" },
    member: { displayName: "Kovi", roles: { cache: new Map([["r1", true]]) } },
    memberPermissions: { has: () => false },
  };
  assert.deepEqual(help.actorOf(officer, data), { userId: "u1", displayName: "Kovi", level: "officer" });
  const bare = { user: { id: "u2", username: "zed" }, member: null, memberPermissions: null };
  assert.deepEqual(help.actorOf(bare, data), { userId: "u2", displayName: "zed", level: "member" });
});

test("a raw API member (roles = array of ids, guild not cached yet) gets the same level", () => {
  const { createPerms, memberRoles } = require("../core/perms");
  const perms = createPerms({ getManagerRoleIds: () => ["r-off"] });
  const none = { has: () => false };
  assert.equal(perms.levelOf({ roles: ["r-off"] }, none), "officer");
  assert.equal(perms.levelOf({ roles: ["r-x"] }, none), "member");
  assert.equal(perms.levelOf({ roles: { cache: new Map([["r-off", {}]]) } }, none), "officer");
  assert.equal(memberRoles(null), undefined);
});
