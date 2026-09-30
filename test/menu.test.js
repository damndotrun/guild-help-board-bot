"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// help.js reads its data path at require time (only needed for the C8 parity test).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bbmenu-"));
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
process.env.GUILD_ID = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MessageFlags, MessageFlagsBitField, ComponentType, PermissionFlagsBits } = require("discord.js");
const { normalizeModule } = require("../core/loader");
const { createRouter } = require("../core/router");
const { collectCommands } = require("../core/registry");
const { createMenuModule, parseMenuId, MENU_TEXT, HOME_ID } = require("../core/menu");
const { text, row, button, walk } = require("../core/panel");
const { atLeast, createPerms } = require("../core/perms");
const help = require("../modules/help/help");

const V2 = MessageFlags.IsComponentsV2;
const EPHEMERAL_V2 = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;
const quiet = { log() {}, warn() {}, error() {} };
function recorder() {
  const errors = [];
  return { errors, log: { log() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(" ")) } };
}

let afterRuns = [];
const demo = normalizeModule({
  name: "demo",
  dataFile: null,
  handle: async () => {},
  menu: {
    section: () => ({ label: "Demo", counter: "2 open" }),
    guide: () => "Demo guide.",
    render: async (interaction, ctx, viewer, screen, arg) => {
      if (screen === "main") {
        return { crumbs: ["Menu", "Demo"], status: `arg=${arg}`, body: [text("hello")], back: HOME_ID, after: async () => { afterRuns.push(screen); } };
      }
      if (screen === "officer") {
        return atLeast(viewer.level, "officer")
          ? { crumbs: ["Menu", "Demo", "Officer"], body: [text("secret")], back: "menu:demo:main" }
          : { home: MENU_TEXT.noAccess };
      }
      if (screen === "slow") {
        await interaction.deferUpdate();
        return { crumbs: ["Menu", "Demo"], body: [text("slow")], back: HOME_ID };
      }
      if (screen === "modal") return { modal: { title: "fake modal" } };
      if (screen === "boom") throw new Error("kaput");
      if (screen === "nocrumbs") return { body: [text("x")], after: async () => { afterRuns.push(screen); } };
      if (screen === "wide") {
        return {
          crumbs: ["Menu", "Demo"],
          body: [row(button("menu:demo:a", "A"), button("menu:demo:b", "B"), button("menu:demo:c", "C"), button("menu:demo:d", "D"))],
          after: async () => { afterRuns.push(screen); },
        };
      }
      return null;
    },
  },
});
const vault = normalizeModule({
  name: "vault", dataFile: null, handle: async () => {},
  menu: { section: () => ({ label: "Vault", minLevel: "officer" }), render: async () => ({ crumbs: ["Menu", "Vault"], body: [text("vault")], back: HOME_ID }) },
});
const hidden = normalizeModule({
  name: "hidden", dataFile: null, handle: async () => {},
  menu: { section: () => null, render: async () => ({ crumbs: ["Menu", "Hidden"], body: [text("x")] }) },
});
const broken = normalizeModule({
  name: "broken", dataFile: null, handle: async () => {},
  menu: { section: () => { throw new Error("section kaput"); }, render: async () => null },
});
const plain = normalizeModule({ name: "plain", dataFile: null, handle: async () => {} });

const perms = { levelOfInteraction: (i) => i.level };
const makeMenu = (opts = {}) =>
  createMenuModule({ modules: [demo, vault, hidden, broken, plain], ctxFor: () => ({}), perms, log: quiet, ...opts });

// A tap on the ephemeral menu message; onMenu: false = a tap on a public message (the board).
function tap(customId, { level = "member", onMenu = true, command = false, failAck = false, failEdit = false, deferred = false } = {}) {
  const calls = [];
  const i = {
    customId: command ? undefined : customId,
    commandName: command ? "menu" : undefined,
    level,
    calls,
    deferred,
    replied: false,
    user: { id: "u1" },
    message: command ? undefined : { flags: new MessageFlagsBitField(onMenu ? EPHEMERAL_V2 : 0) },
    isChatInputCommand: () => command,
    isAutocomplete: () => false,
    isRepliable: () => true,
    deferUpdate: async () => { i.deferred = true; calls.push(["deferUpdate"]); },
    reply: async (p) => { if (failAck) throw new Error("Unknown Message"); i.replied = true; calls.push(["reply", p]); },
    update: async (p) => { if (failAck) throw new Error("Unknown Message"); i.replied = true; calls.push(["update", p]); },
    editReply: async (p) => { if (failEdit) throw new Error("Unknown Message"); calls.push(["editReply", p]); },
    showModal: async (m) => calls.push(["showModal", m]),
  };
  return i;
}
const answer = (i) => i.calls.filter(([k]) => k !== "deferUpdate").at(-1);
function textOf(payload) {
  const out = [];
  walk(payload, (c) => { if (c.type === ComponentType.TextDisplay) out.push(c.content); });
  return out.join("\n");
}
function idsOf(payload) {
  const out = [];
  walk(payload, (c) => { if (c.custom_id) out.push(c.custom_id); });
  return out;
}
function urlsOf(payload) {
  const out = [];
  walk(payload, (c) => { if (c.url) out.push([c.label, c.url]); });
  return out;
}

test("parseMenuId: home, how, module screens with the full remainder as arg", () => {
  assert.deepEqual(parseMenuId("menu:home"), { target: "home", screen: "", arg: "" });
  assert.deepEqual(parseMenuId("menu"), { target: "home", screen: "", arg: "" });
  assert.deepEqual(parseMenuId("menu:home:how"), { target: "home", screen: "how", arg: "" });
  assert.deepEqual(parseMenuId("menu:help:removeok:e1:123"), { target: "help", screen: "removeok", arg: "e1:123" });
  assert.equal(parseMenuId("help:claim:1"), null);
});

test("/menu → an ephemeral V2 home with one section row per visible module", async () => {
  const i = tap(null, { command: true });
  await makeMenu().handle(i);
  const [kind, payload] = answer(i);
  assert.equal(kind, "reply");
  assert.equal(payload.flags, EPHEMERAL_V2);
  assert.equal("content" in payload, false);
  assert.equal("embeds" in payload, false);
  assert.match(textOf(payload), /^\*\*Menu\*\*\nYou: Member/);
  assert.match(textOf(payload), /\*\*Demo\*\* · 2 open/);
  assert.doesNotMatch(textOf(payload), /Vault|Hidden/);
  assert.deepEqual(idsOf(payload), ["menu:demo:main", "menu:home:how"]);
});

test("home: officer-only sections for officers; the Web admin link needs an officer AND a PUBLIC_URL", async () => {
  const withUrl = makeMenu({ publicUrl: "https://bb.example" });
  const officer = tap(null, { command: true, level: "officer" });
  await withUrl.handle(officer);
  assert.deepEqual(idsOf(answer(officer)[1]), ["menu:demo:main", "menu:vault:main", "menu:home:how"]);
  assert.deepEqual(urlsOf(answer(officer)[1]), [["Web admin", "https://bb.example"]]);
  const member = tap(null, { command: true });
  await withUrl.handle(member);
  assert.deepEqual(urlsOf(answer(member)[1]), []);
  const noUrl = tap(null, { command: true, level: "owner" });
  await makeMenu().handle(noUrl);
  assert.deepEqual(urlsOf(answer(noUrl)[1]), []);
});

test("a tap on the menu message updates it in place (V2 flag only) and runs `after` after the ack", async () => {
  afterRuns = [];
  const i = tap("menu:demo:main:x:y");
  await makeMenu().handle(i);
  const [kind, payload] = answer(i);
  assert.equal(kind, "update");
  assert.equal(payload.flags, V2);
  assert.match(textOf(payload), /^\*\*Menu › Demo\*\*\narg=x:y/);
  assert.equal(idsOf(payload).at(-1), HOME_ID); // Back is the last row
  assert.deepEqual(afterRuns, ["main"]);
});

test("response flags per mode: reply = Ephemeral|V2; update and editReply = V2 only", async () => {
  const reply = tap(null, { command: true });
  await makeMenu().handle(reply);
  assert.deepEqual([answer(reply)[0], answer(reply)[1].flags], ["reply", EPHEMERAL_V2]);
  const update = tap("menu:home:how");
  await makeMenu().handle(update);
  assert.deepEqual([answer(update)[0], answer(update)[1].flags], ["update", V2]);
  const edit = tap(null, { command: true, deferred: true }); // /menu acknowledged earlier → editReply
  await makeMenu().handle(edit);
  assert.deepEqual([answer(edit)[0], answer(edit)[1].flags], ["editReply", V2]);
});

test("How it works: every module guide, Back to home", async () => {
  const i = tap("menu:home:how");
  await makeMenu().handle(i);
  const [kind, p] = answer(i);
  assert.equal(kind, "update");
  assert.match(textOf(p), /\*\*Menu › How it works\*\*/);
  assert.match(textOf(p), /Demo guide\./);
  assert.deepEqual(idsOf(p), [HOME_ID]);
});

test("Review focus: a menu: button on a PUBLIC message (the board) opens a fresh ephemeral home — it never edits that message", async () => {
  for (const id of [HOME_ID, "menu:demo:main", "menu:demo:slow"]) {
    const i = tap(id, { onMenu: false });
    await makeMenu().handle(i);
    assert.deepEqual(i.calls.map(([k]) => k), ["reply"], id);
    assert.equal(i.calls[0][1].flags, EPHEMERAL_V2, id);
    assert.match(textOf(i.calls[0][1]), /^\*\*Menu\*\*/, id);
  }
});

test("unknown targets and screens → home with one explanatory line", async () => {
  for (const id of ["menu:nope:main", "menu:demo:zzz", "menu:home:zzz", "menu:plain:main"]) {
    const i = tap(id);
    await makeMenu().handle(i);
    const [kind, p] = answer(i);
    assert.equal(kind, "update", id);
    assert.ok(textOf(p).includes(`⚠️ ${MENU_TEXT.unknown}`), id);
  }
});

test("permission is re-checked on every tap: hidden / officer-only sections and screens fall back to home", async () => {
  for (const [id, level] of [["menu:vault:main", "member"], ["menu:hidden:main", "owner"], ["menu:demo:officer", "member"]]) {
    const i = tap(id, { level });
    await makeMenu().handle(i);
    assert.ok(textOf(answer(i)[1]).includes(`⚠️ ${MENU_TEXT.noAccess}`), id);
  }
  const ok = tap("menu:demo:officer", { level: "officer" });
  await makeMenu().handle(ok);
  assert.match(textOf(answer(ok)[1]), /secret/);
});

test("a throwing render or an over-limit screen → logged, home with the 'went wrong' line", async () => {
  const rec = recorder();
  const menu = makeMenu({ log: rec.log });
  for (const id of ["menu:demo:boom", "menu:demo:wide"]) {
    const i = tap(id);
    await menu.handle(i);
    assert.ok(textOf(answer(i)[1]).includes(`⚠️ ${MENU_TEXT.broken}`), id);
  }
  assert.ok(rec.errors.some((e) => e.includes("kaput")));
  assert.ok(rec.errors.some((e) => e.includes("4 buttons")));
});

test("C9: a committed action's `after` still runs when its screen is invalid or cannot be built", async () => {
  afterRuns = [];
  const rec = recorder();
  const menu = makeMenu({ log: rec.log });
  for (const id of ["menu:demo:wide", "menu:demo:nocrumbs"]) {
    const i = tap(id);
    await menu.handle(i);
    assert.ok(textOf(answer(i)[1]).includes(`⚠️ ${MENU_TEXT.broken}`), id);
  }
  assert.deepEqual(afterRuns, ["wide", "nocrumbs"]);
});

test("a module section that throws is skipped on home and logged", async () => {
  const rec = recorder();
  const i = tap(null, { command: true });
  await makeMenu({ log: rec.log }).handle(i);
  assert.doesNotMatch(textOf(answer(i)[1]), /broken/i);
  assert.ok(rec.errors.some((e) => e.includes("section kaput")));
});

test("slow screens defer first and are answered with editReply; modal screens only show the modal", async () => {
  const slow = tap("menu:demo:slow");
  await makeMenu().handle(slow);
  assert.deepEqual(slow.calls.map(([k]) => k), ["deferUpdate", "editReply"]);
  assert.equal(slow.calls[1][1].flags, V2);
  const modal = tap("menu:demo:modal");
  await makeMenu().handle(modal);
  assert.deepEqual(modal.calls, [["showModal", { title: "fake modal" }]]);
});

test("C9: the ack fails (the menu message is gone) → logged, `after` still runs, nothing throws", async () => {
  for (const [label, id, opts] of [
    ["update", "menu:demo:main", { failAck: true }],
    ["editReply", "menu:demo:main", { failEdit: true, deferred: true }],
  ]) {
    afterRuns = [];
    const rec = recorder();
    const i = tap(id, opts);
    await makeMenu({ log: rec.log }).handle(i); // must not reject
    assert.deepEqual(afterRuns, ["main"], label);
    assert.ok(rec.errors.some((e) => e.includes("could not answer")), label);
  }
  // A failed first reply of /menu itself is logged the same way.
  const rec = recorder();
  await makeMenu({ log: rec.log }).handle(tap(null, { command: true, failAck: true }));
  assert.ok(rec.errors.some((e) => e.includes("could not answer")));
});

test("C9: a throwing `after` is logged and does not reject the handler", async () => {
  const rec = recorder();
  const mod = normalizeModule({
    name: "late", dataFile: null, handle: async () => {},
    menu: { section: () => ({ label: "Late" }), render: async () => ({ crumbs: ["Menu", "Late"], body: [text("x")], after: async () => { throw new Error("rest kaput"); } }) },
  });
  const menu = createMenuModule({ modules: [mod], ctxFor: () => ({}), perms, log: rec.log });
  await menu.handle(tap("menu:late:main"));
  assert.ok(rec.errors.some((e) => e.includes("follow-up work failed")));
});

test("C8: the menu level equals the level the slash path (help) derives — no provider, no member, manager role, Manage Server", () => {
  const manage = { has: (f) => f === PermissionFlagsBits.ManageGuild };
  const none = { has: () => false };
  const withRole = { roles: { cache: new Map([["r1", true]]) } };
  const cases = [
    { memberPermissions: undefined, member: undefined }, // no member at all
    { memberPermissions: none, member: withRole },
    { memberPermissions: manage, member: undefined },
    { memberPermissions: none, member: { roles: ["r1"] } }, // raw API member, no role cache
  ];
  for (const managerRoleIds of [undefined, [], ["r1"]]) {
    // undefined = "no provider": the core's fallback, createPerms with no manager-role list at all.
    const corePerms = managerRoleIds === undefined ? createPerms() : createPerms({ getManagerRoleIds: () => managerRoleIds });
    for (const c of cases) {
      const i = { ...c, user: { id: "u1", username: "u" } };
      const slash = help.actorOf(i, { managerRoleIds }).level;
      assert.equal(corePerms.levelOfInteraction(i), slash, JSON.stringify([managerRoleIds, Object.keys(c).map((k) => !!c[k])]));
    }
  }
});

test("C8: the menu asks the shared perms object, so a manager-role holder sees the officer sections", async () => {
  const menu = makeMenu({ perms: createPerms({ getManagerRoleIds: () => ["r1"] }) });
  const i = tap(null, { command: true });
  i.memberPermissions = { has: () => false };
  i.member = { roles: { cache: new Map([["r1", true]]) } };
  await menu.handle(i);
  assert.ok(idsOf(answer(i)[1]).includes("menu:vault:main"));
  assert.match(textOf(answer(i)[1]), /You: Officer/);
});

test("the menu pseudo-module owns /menu and the menu: prefix; a module named menu is refused", async () => {
  const menu = makeMenu();
  assert.equal(menu.name, "menu");
  assert.deepEqual(collectCommands([demo, menu]).map((c) => c.name), ["menu"]);
  assert.throws(() => normalizeModule({ name: "menu", handle: async () => {} }), /reserved for the core/);
  const route = createRouter({ modules: [demo, menu], ctxFor: () => ({}), log: quiet });
  const i = tap("menu:demo:main");
  await route(i);
  assert.equal(answer(i)[0], "update");
});

test("loader: the menu contract is validated and kept", () => {
  assert.throws(() => normalizeModule({ name: "x", handle: async () => {}, menu: { section: () => null } }), /menu needs section\(\) and render\(\)/);
  assert.throws(() => normalizeModule({ name: "y", handle: async () => {}, menu: { section: () => null, render: async () => null, guide: "no" } }), /menu\.guide must be a function/);
  assert.equal(normalizeModule({ name: "z", handle: async () => {} }).menu, null);
  assert.equal(typeof demo.menu.render, "function");
  assert.equal(demo.menu.guide(), "Demo guide.");
});
