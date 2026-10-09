"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bblfgmenu-"));
process.env.DATA_DIR = TMP;
process.env.GUILD_ID = "g1";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { ButtonStyle, ComponentType } = require("discord.js");
const { normalizeModule } = require("../core/loader");
const { createCtxFor } = require("../core/runtime");
const { createPerms } = require("../core/perms");
const { createMenuModule, MENU_TEXT } = require("../core/menu");
const { walk, screenErrors, buildScreenPayload } = require("../core/panel");
const C = require("../modules/lfg/channel");
const lfgMenu = require("../modules/lfg/menu");
const seed = require("../modules/lfg/seed");
const store = require("../modules/lfg/store");
const { T0, dataWith, listing, request, fakeDiscord, tap } = require("./fixtures/lfg-fakes");

const quiet = { log() {}, warn() {}, error() {} };
const MEMBER = { id: "u1", name: "Dani" };
const OFFICER = { id: "o1", name: "Offi", roles: ["mgr"] };
const OWNER = { id: "w1", name: "Owna", manageGuild: true };
// The lfg module as the core sees it — only its menu part (index.js wires the rest).
const lfgMod = () => normalizeModule({ name: "lfg", dataFile: "lfg.json", menu: { section: lfgMenu.section, render: lfgMenu.render, guide: lfgMenu.guide } });

let fake;
let ctx;
let menu;
beforeEach(() => {
  C._reset();
  fake = fakeDiscord();
  for (const r of ["r-sup", "r-dps", "r-radar", "r-hack", "r-gm"]) fake.roles.set(r, { id: r, name: r.toUpperCase(), mentionable: true });
  const modules = [lfgMod()];
  const perms = createPerms({ getManagerRoleIds: () => ["mgr"] });
  const dir = fs.mkdtempSync(path.join(TMP, "case-"));
  const ctxFor = createCtxFor({ client: fake.client, dataDir: dir, perms });
  ctx = ctxFor(modules[0]);
  ctx.log = quiet;
  ctx.now = () => T0;
  menu = createMenuModule({ modules, ctxFor, perms, log: quiet });
  seed.health.missing = [];
});

function seedData(mutate) {
  store.save(ctx, dataWith(mutate));
}
async function run(i) {
  await menu.handle(i);
  return i.calls.filter(([k]) => k !== "deferUpdate").at(-1);
}
const menuTap = (id, who, opts = {}) => tap(id, who, { ephemeral: true, v2: true, guild: fake.guild, ...opts });
function textIn(payload) {
  const out = [];
  walk(payload, (c) => { if (c.type === ComponentType.TextDisplay) out.push(c.content); });
  return out.join("\n");
}
function idsIn(payload) {
  const out = [];
  walk(payload, (c) => { if (c.custom_id) out.push(c.custom_id); });
  return out;
}

test("section: “not set up” without a config, else the open count", () => {
  const lfg = lfgMod();
  assert.deepEqual(lfg.menu.section(ctx, { userId: "u1", level: "member" }), { label: "Teammates", counter: "not set up" });
  seedData((x) => { x.listings.push(listing("A", "p1"), listing("B", "p2", { state: "fixed", joinerId: "p3" })); });
  assert.deepEqual(lfg.menu.section(ctx, { userId: "u1", level: "member" }), { label: "Teammates", counter: "1 open" });
});

test("main (member): status, own search with Cancel, requests with Cancel request, New search is the one Primary", async () => {
  seedData((x) => {
    x.listings.push(listing("MINE", "u1", { threadId: "th9" }));
    x.listings.push(listing("A", "p1", { posterName: "Marci", requests: [request("u1")] }));
  });
  const [, payload] = await run(menuTap("menu:lfg:main", MEMBER));
  const t = textIn(payload);
  assert.match(t, /\*\*Menu › Teammates\*\*\n2 open · You: Member/); // the member's own search counts too
  assert.match(t, /\*\*Your search\*\* · 💥 BASIC · SUP · open · \[thread\]\(<https:\/\/discord\.com\/channels\/g1\/th9>\)/);
  assert.match(t, /💥 BASIC · SUP · Marci · #1/);
  assert.deepEqual(idsIn(payload), ["menu:lfg:cancel:MINE", "menu:lfg:withdraw:A", "menu:lfg:new", "menu:lfg:browse", "menu:lfg:roles", "menu:lfg:notify", "menu:home"]);
  const primary = [];
  walk(payload, (c) => { if (c.type === ComponentType.Button && c.style === ButtonStyle.Primary) primary.push(c.label); });
  assert.deepEqual(primary, ["New search"]);
});

test("main: officers get Remove a search; owners see the missing permissions; no config → the owner's warning", async () => {
  seedData();
  const [, officer] = await run(menuTap("menu:lfg:main", OFFICER));
  assert.ok(idsIn(officer).includes("menu:lfg:remove"));
  seed.health.missing = ["ManageRoles"];
  const [, owner] = await run(menuTap("menu:lfg:main", OWNER));
  assert.match(textIn(owner), /missing permissions in the board channel: ManageRoles/);
  const [, member] = await run(menuTap("menu:lfg:main", MEMBER));
  assert.equal(/missing permissions/.test(textIn(member)), false);
  // a SOFT one (Manage Messages): named on the owner's screen only, as optional
  seed.health.missing = [];
  seed.health.optional = ["ManageMessages"];
  const [, soft] = await run(menuTap("menu:lfg:main", OWNER));
  assert.match(textIn(soft), /Optional, missing in the board channel: ManageMessages/);
  assert.doesNotMatch(textIn(soft), /I'm missing permissions/);
  const [, memberSoft] = await run(menuTap("menu:lfg:main", MEMBER));
  assert.doesNotMatch(textIn(memberSoft), /Optional/);
  seed.health.optional = [];
  store.save(ctx, { ...store.load(ctx), config: null });
  const [, bare] = await run(menuTap("menu:lfg:main", OWNER));
  assert.match(textIn(bare), /No visible #looking-for-game channel/);
});

test("New search opens the start modal — unless the member already has a search", async () => {
  seedData();
  const i = menuTap("menu:lfg:new", MEMBER);
  await menu.handle(i);
  assert.equal(i.calls[0][0], "showModal");
  assert.equal(i.calls[0][1].toJSON().custom_id, "lfg:modal");
  seedData((x) => x.listings.push(listing("MINE", "u1")));
  const [, payload] = await run(menuTap("menu:lfg:new", MEMBER));
  assert.match(textIn(payload), /⚠\uFE0F You already have a search open\./);
});

test("a custom emoji the guild lost is left off the New search modal and the My roles list; a kept one is a proper { id, name }", async () => {
  const GONE = "111111111111111111";
  const HERE = "222222222222222222";
  seedData((x) => {
    x.config.categories[0].buttons[0].emoji = `<:sup:${GONE}>`;
    x.config.categories[0].buttons[1].emoji = `<:dps:${HERE}>`;
  });
  fake.guild.emojis = { cache: new Map([[HERE, { id: HERE }]]) };
  const i = menuTap("menu:lfg:new", MEMBER);
  await menu.handle(i);
  assert.equal(i.calls[0][0], "showModal");
  const json = JSON.stringify(i.calls[0][1].toJSON());
  assert.ok(!json.includes(GONE), "the gone emoji is not in the modal");
  assert.ok(json.includes(HERE));
  const m = fake.member("u1", { roleIds: [] });
  const [, screen] = await run(menuTap("menu:lfg:roles", MEMBER, { member: m }));
  let select;
  walk(screen, (c) => { if (c.type === ComponentType.StringSelect) select = c; });
  const byValue = Object.fromEntries(select.options.map((o) => [o.value, o]));
  assert.equal(byValue["r-sup"].emoji, undefined);
  assert.equal(byValue["r-sup"].label, "BASIC · SUP");
  assert.deepEqual([byValue["r-dps"].emoji.id, byValue["r-dps"].emoji.name], [HERE, "dps"]); // not { name: "<:dps:…>" }
  assert.equal(byValue["r-radar"].emoji.name, "🧬");
});

test("Browse: the open searches (not your own); picking one sends the request and runs its follow-up", async () => {
  seedData((x) => {
    x.listings.push(listing("A", "p1", { posterName: "Marci", note: "fast" }));
    x.listings.push(listing("MINE", "u1"));
  });
  const [, list] = await run(menuTap("menu:lfg:browse", MEMBER));
  let select;
  walk(list, (c) => { if (c.type === ComponentType.StringSelect) select = c; });
  assert.deepEqual(select.options.map((o) => [o.label, o.value, o.description]), [["BASIC · SUP · Marci", "A", "now · fast"]]);
  assert.match(select.custom_id, /^menu:lfg:browse:[0-9a-z]+$/);
  const [, done] = await run(menuTap(select.custom_id, MEMBER, { kind: "string", values: ["A"] }));
  assert.match(textIn(done), /✅ Request sent to \*\*Marci\*\* — you're #1 in line/);
  assert.deepEqual(store.load(ctx).listings[0].requests.map((r) => r.userId), ["u1"]);
  assert.ok(fake.ops.some((o) => o.op === "dm" && o.channelId === "dm-u1")); // the after: the first DM card
});

test("My roles: the member's roles pre-selected; Save adds and removes; a refused role is named", async () => {
  seedData();
  const m = fake.member("u1", { roleIds: ["r-sup"] });
  const [, screen] = await run(menuTap("menu:lfg:roles", MEMBER, { member: m }));
  let select;
  walk(screen, (c) => { if (c.type === ComponentType.StringSelect) select = c; });
  assert.deepEqual(select.options.map((o) => [o.value, !!o.default]), [["r-sup", true], ["r-dps", false], ["r-radar", false], ["r-hack", false]]);
  assert.equal(select.min_values, 0);
  const [, saved] = await run(menuTap(select.custom_id, MEMBER, { kind: "string", values: ["r-dps"], member: m }));
  // the re-rendered list has a new custom_id (PR #5 bug class: a re-sent identical select freezes)
  let again;
  walk(saved, (c) => { if (c.type === ComponentType.StringSelect) again = c; });
  assert.match(again.custom_id, /^menu:lfg:roles:[0-9a-z]+$/);
  assert.notEqual(again.custom_id, select.custom_id);
  assert.match(textIn(saved), /✅ Added: R-DPS · Removed: R-SUP/);
  assert.deepEqual([...m.roles.cache.keys()], ["r-dps"]);
});

test("My roles: after Save the list shows the change even though the member cache is stale (no GuildMembers intent)", async () => {
  seedData();
  const m = fake.member("u1", { roleIds: ["r-sup"], staleCache: true });
  const [, screen] = await run(menuTap("menu:lfg:roles", MEMBER, { member: m }));
  let select;
  walk(screen, (c) => { if (c.type === ComponentType.StringSelect) select = c; });
  const [, saved] = await run(menuTap(select.custom_id, MEMBER, { kind: "string", values: ["r-dps"], member: m }));
  assert.deepEqual([...m.roles.cache.keys()], ["r-sup"]); // the fake cache really did not move
  assert.ok(fake.ops.some((o) => o.op === "roleAdd" && o.roleId === "r-dps") && fake.ops.some((o) => o.op === "roleRemove" && o.roleId === "r-sup"));
  let again;
  walk(saved, (c) => { if (c.type === ComponentType.StringSelect) again = c; });
  assert.deepEqual(again.options.map((o) => [o.value, !!o.default]), [["r-sup", false], ["r-dps", true], ["r-radar", false], ["r-hack", false]]);
  assert.match(textIn(saved), /✅ Added: R-DPS · Removed: R-SUP/);
});

test("Notifications: the GM toggle shows the new state even though the member cache is stale", async () => {
  seedData();
  const m = fake.member("u1", { staleCache: true });
  const [, on] = await run(menuTap("menu:lfg:notify:gm", MEMBER, { member: m }));
  assert.equal(m.roles.cache.has("r-gm"), false);
  assert.match(textIn(on), /✅ GM pings on\.[\s\S]*\*\*GM pings\*\* · On/);
  const held = fake.member("u1", { roleIds: ["r-gm"], staleCache: true });
  const [, off] = await run(menuTap("menu:lfg:notify:gm", MEMBER, { member: held }));
  assert.match(textIn(off), /✅ GM pings off\.[\s\S]*\*\*GM pings\*\* · Off/);
});

test("news is not consumed when the screen with the news cannot be sent", async () => {
  seedData((x) => { x.notices.u1 = [{ listingId: "Z", outcome: "full", ts: T0, name: "Marci", label: "X".repeat(4200) }]; });
  const lfg = lfgMod();
  const viewer = { userId: "u1", level: "member" };
  const screen = await lfg.menu.render(menuTap("menu:lfg:main", MEMBER), ctx, viewer, "main", "");
  assert.deepEqual(screenErrors(screen), []);
  assert.equal(/📬/.test(textIn(buildScreenPayload(screen))), false);
  assert.equal(store.load(ctx).notices.u1.length, 1); // still waiting for a screen that fits
});

test("Notifications: DM switches flip and save; GM pings flips the GM-PING role", async () => {
  seedData();
  const m = fake.member("u1");
  const [, first] = await run(menuTap("menu:lfg:notify", MEMBER, { member: m }));
  assert.match(textIn(first), /\*\*Request updates by DM\*\* · On[\s\S]*\*\*New searches by DM\*\* · Off[\s\S]*\*\*GM pings\*\* · Off/);
  await run(menuTap("menu:lfg:notify:dm", MEMBER, { member: m }));
  await run(menuTap("menu:lfg:notify:requestDm", MEMBER, { member: m }));
  assert.deepEqual(store.load(ctx).prefs.u1, { dm: true, requestDm: false });
  const [, gm] = await run(menuTap("menu:lfg:notify:gm", MEMBER, { member: m }));
  assert.ok(m.roles.cache.has("r-gm"));
  assert.match(textIn(gm), /✅ GM pings on\.[\s\S]*\*\*GM pings\*\* · On/);
});

test("Remove a search: officers only; the pick removes it", async () => {
  seedData((x) => x.listings.push(listing("A", "p1", { posterName: "Marci" })));
  const [, denied] = await run(menuTap("menu:lfg:remove", MEMBER));
  assert.match(textIn(denied), new RegExp(MENU_TEXT.noAccess.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const [, done] = await run(menuTap("menu:lfg:remove", OFFICER, { kind: "string", values: ["A"] }));
  assert.match(textIn(done), /✅ Removed \*\*Marci\*\*'s search\./);
  assert.deepEqual(store.load(ctx).listings, []);
});

test("Cancel my search / Cancel request from the main screen", async () => {
  seedData((x) => {
    x.listings.push(listing("MINE", "u1"));
    x.listings.push(listing("A", "p1", { requests: [request("u1")] }));
  });
  const [, a] = await run(menuTap("menu:lfg:withdraw:A", MEMBER));
  assert.match(textIn(a), /✅ Request cancelled\./);
  const [, b] = await run(menuTap("menu:lfg:cancel:MINE", MEMBER));
  assert.match(textIn(b), /✅ Search cancelled\./);
  assert.deepEqual(store.load(ctx).listings.map((l) => l.id), ["A"]);
  const [, again] = await run(menuTap("menu:lfg:cancel:MINE", MEMBER));
  assert.match(textIn(again), /⚠\uFE0F That search isn't open anymore\./);
});

test("news from closed DMs shows on top of the next screen once, then it is gone", async () => {
  seedData((x) => { x.notices.u1 = [{ listingId: "Z", outcome: "full", ts: T0, name: "Marci", label: "DDPS · HACK" }]; });
  const [, first] = await run(menuTap("menu:lfg:main", MEMBER));
  assert.match(textIn(first), /📬 Marci's game is full · DDPS · HACK/);
  const [, second] = await run(menuTap("menu:lfg:main", MEMBER));
  assert.equal(/📬/.test(textIn(second)), false);
});

test("every Teammates screen passes the core screen validator", async () => {
  seedData((x) => {
    x.listings.push(listing("MINE", "u1"));
    for (let i = 0; i < 8; i++) x.listings.push(listing(`L${i}`, `p${i}`, { requests: [request("u1", T0 + i)] }));
  });
  for (const [id, who] of [["menu:lfg:main", MEMBER], ["menu:lfg:main", OWNER], ["menu:lfg:browse", MEMBER], ["menu:lfg:roles", MEMBER], ["menu:lfg:notify", MEMBER], ["menu:lfg:remove", OFFICER]]) {
    const lfg = lfgMod();
    const screen = await lfg.menu.render(menuTap(id, who, { member: fake.member(who.id) }), ctx, { userId: who.id, level: who.manageGuild ? "owner" : who.roles ? "officer" : "member" }, id.split(":")[2], "");
    assert.deepEqual(screenErrors(screen), [], id);
  }
});

test("menu: posterName is escaped in the Browse / Remove answers and the request list (D1); New search answers busy first (B6)", async () => {
  seedData((x) => {
    x.listings.push(listing("A", "p1", { posterName: "[x](https://e.com)" }));
    x.listings.push(listing("B", "p2", { posterName: "[y](https://e.com)" }));
  });
  const [, done] = await run(menuTap("menu:lfg:browse:t", MEMBER, { kind: "string", values: ["A"] }));
  assert.match(textIn(done), /Request sent to \*\*\\\[x\]\(https:\/\/e\.com\)\*\*/);
  assert.match(textIn(done), /BASIC · SUP · \\\[x\]\(https:\/\/e\.com\) · #1/);
  const [, removed] = await run(menuTap("menu:lfg:remove:t", OFFICER, { kind: "string", values: ["B"] }));
  assert.match(textIn(removed), /Removed \*\*\\\[y\]\(https:\/\/e\.com\)\*\*'s search\./);
  seedData((x) => x.listings.push(listing("MINE", "u1", { state: "started", joinerId: "u2", startedAt: T0, requests: [request("u2", T0, { status: "accepted" })] })));
  const [, busy] = await run(menuTap("menu:lfg:new", MEMBER));
  assert.match(textIn(busy), /in a game right now/);
});
