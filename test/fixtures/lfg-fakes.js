"use strict";
// Shared lfg test fixtures: a two-category config, data builders and (from the
// Discord-glue task on) a recording fake Discord client. `node --test` also
// runs this file as a test file: 0 tests, one "ok" line.
const { shape, emptyData } = require("../../modules/lfg/state");

const T0 = Date.UTC(2026, 9, 9, 18, 0, 0); // 2026-10-09 18:00 UTC
const MIN = 60_000;

function config() {
  return {
    channelId: "ch1",
    guildId: "g1",
    layout: [{ type: "board" }],
    gmPingRoleId: "r-gm",
    categories: [
      {
        id: "basic",
        name: "BASIC",
        emoji: "💥",
        buttons: [
          { id: "sup", label: "SUP", emoji: "💥", pingRoleIds: ["r-sup"], subscribeRoleId: "r-sup" },
          { id: "dps", label: "DPS", emoji: "💥", pingRoleIds: ["r-dps"], subscribeRoleId: "r-dps" },
          { id: "gm", label: "GM", emoji: "⚔️", pingRoleIds: ["r-gm"], subscribeRoleId: null },
        ],
      },
      {
        id: "ddps",
        name: "DDPS",
        emoji: "🧬",
        buttons: [
          { id: "radar", label: "RADAR", emoji: "🧬", pingRoleIds: ["r-radar"], subscribeRoleId: "r-radar" },
          { id: "hack", label: "HACK", emoji: "🧬", pingRoleIds: ["r-hack"], subscribeRoleId: "r-hack" },
          { id: "any", label: "ANY", emoji: "🧬", pingRoleIds: ["r-radar", "r-hack"], subscribeRoleId: null },
        ],
      },
    ],
  };
}

// A shaped lfg.json with the fixture config; `mutate(d)` adjusts it.
function dataWith(mutate) {
  const d = shape({ ...emptyData(), config: config() });
  if (mutate) mutate(d);
  return d;
}

// A listing as createListing would store it, with overrides.
function listing(id, posterId, extra = {}) {
  return shape({
    listings: [
      {
        id,
        posterId,
        posterName: posterId.toUpperCase(),
        categoryId: "basic",
        buttonId: "sup",
        note: "",
        createdAt: T0,
        startAt: null,
        expiresAt: T0 + 30 * MIN,
        state: "open",
        threadId: `th-${id}`,
        panelMessageId: `pm-${id}`,
        ...extra,
      },
    ],
  }).listings[0];
}

const request = (userId, createdAt = T0, extra = {}) => ({
  userId,
  userName: userId.toUpperCase(),
  createdAt,
  status: "pending",
  onHold: false,
  closedAt: null,
  reason: null,
  ...extra,
});

module.exports = { T0, MIN, config, dataWith, listing, request };
