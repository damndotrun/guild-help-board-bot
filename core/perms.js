// Permission levels (M2 spec §5; platform spec §4.1 ctx.perms). Three
// cumulative levels: member (everyone) < officer (a manager role) < owner
// (Manage Server). The manager roles live in ONE place — the help module's
// data.managerRoleIds — and the core reads them only through a module's
// `managerRoles()` provider: it never learns help's file layout, and with help
// disabled the fallback is "Manage Server only", exactly like an empty
// manager-role list today.
const { PermissionFlagsBits } = require("discord.js");

const LEVELS = ["member", "officer", "owner"];
const LEVEL_LABEL = Object.freeze({ member: "Member", officer: "Officer", owner: "Owner" });

// The single implementation of the rule; help's isManager() delegates here.
function computeLevel({ permissions, roleCache, managerRoleIds }) {
  if (permissions && typeof permissions.has === "function" && permissions.has(PermissionFlagsBits.ManageGuild)) {
    return "owner";
  }
  const ids = Array.isArray(managerRoleIds) ? managerRoleIds : [];
  if (ids.length > 0 && roleCache && typeof roleCache.has === "function" && ids.some((id) => roleCache.has(id))) {
    return "officer";
  }
  return "member";
}

// A member's role ids as something with .has(id). discord.js hands an
// interaction the raw API member (roles = an array of ids) when the guild is
// not cached yet — e.g. right after login; a GuildMember has roles.cache.
function memberRoles(member) {
  if (Array.isArray(member?.roles)) return new Set(member.roles);
  return member?.roles?.cache;
}

function atLeast(level, min) {
  const have = LEVELS.indexOf(level);
  const need = LEVELS.indexOf(min);
  return have !== -1 && need !== -1 && have >= need;
}

// At most one enabled module may own the manager-role list.
function managerRolesFrom(modules) {
  const providers = modules.filter((m) => typeof m.managerRoles === "function");
  if (providers.length > 1) {
    throw new Error(`manager roles are provided by more than one module: ${providers.map((m) => m.name).join(", ")}`);
  }
  if (providers.length === 0) return () => [];
  const provider = providers[0];
  return () => {
    const ids = provider.managerRoles();
    return Array.isArray(ids) ? ids : [];
  };
}

function createPerms({ getManagerRoleIds = () => [] } = {}) {
  function levelOf(member, permissions = member?.permissions) {
    return computeLevel({ permissions, roleCache: memberRoles(member), managerRoleIds: getManagerRoleIds() });
  }
  // An interaction carries the resolved permissions separately (memberPermissions).
  function levelOfInteraction(interaction) {
    return levelOf(interaction.member, interaction.memberPermissions);
  }
  return { levelOf, levelOfInteraction, atLeast };
}

module.exports = { LEVELS, LEVEL_LABEL, computeLevel, memberRoles, atLeast, managerRolesFrom, createPerms };
