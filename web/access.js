// Who is this signed-in user in the guild, right now? Platform spec §5 / D20:
// the BOT decides, from the member's live roles — never from the user's own
// token. `force: true` is required: the bot only has the Guilds intent, so its
// member cache never hears about a role change, and without a forced fetch a
// demoted officer would stay an admin. One lookup per user per TTL (60 s).
// The level comes from the same rule as Discord (ctx.perms.levelOf →
// computeLevel with the help module's manager roles) — no second copy here.
const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;
// Unknown Member / Unknown User: not (or no longer) in the guild → no access.
const NOT_A_MEMBER = new Set([10007, 10013]);

// → { lookup(guild, userId) → Promise<Viewer | null>, forget(userId), clear() }
// Viewer = { userId, displayName, level }. null = not a member of the guild
// (cached like a hit). Any other failure (Discord unreachable) throws and is
// NOT cached — the caller answers 503 and the next request tries again.
function createAccess({ perms, ttlMs = TTL_MS, now = Date.now }) {
  const cache = new Map(); // userId → { at, viewer }

  function prune(t) {
    if (cache.size < MAX_ENTRIES) return;
    for (const [id, hit] of cache) if (t - hit.at >= ttlMs) cache.delete(id);
  }

  async function lookup(guild, userId) {
    const t = now();
    const hit = cache.get(userId);
    if (hit && t - hit.at < ttlMs) return hit.viewer;
    let viewer;
    try {
      const member = await guild.members.fetch({ user: userId, force: true });
      viewer = {
        userId,
        displayName: member.displayName || member.user?.username || "Unknown member",
        level: perms.levelOf(member),
      };
    } catch (err) {
      if (!NOT_A_MEMBER.has(err?.code)) throw err;
      viewer = null;
    }
    prune(t);
    cache.set(userId, { at: t, viewer });
    return viewer;
  }

  return {
    lookup,
    forget: (userId) => cache.delete(userId),
    clear: () => cache.clear(),
  };
}

module.exports = { TTL_MS, createAccess };
