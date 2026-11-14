#!/usr/bin/env node
/**
 * The MCP server (stdio) that forwards tool calls to a running editor tab.
 * One source serves every product on the engine: who it serves (name, port,
 * token file, env prefix, origins, resource scheme, status verb) comes from
 * `identity.json` beside this file, or `--identity <file>` — see identity.mjs.
 *
 *   1. Run it from your MCP client's config, e.g. Claude Code:
 *        claude mcp add -s user <ns> -- npx -y @<ns>/mcp@latest
 *      (or `node packages/mcp/src/cli.mjs [--identity <file>]` from the repo).
 *      `@latest` matters: without it npx keeps serving whichever copy it
 *      cached first.
 *   2. In the editor: Agents ▸ Use your agent app ▸ Link. The tab keeps the
 *      link and reconnects whenever a session starts.
 *
 * Pairing: a tab served from the product's own origins is trusted by its
 * Origin header — a browser stamps it and no other site can forge it, which
 * is the standard defence for a localhost socket. Any other origin (a
 * self-hosted build) must send the token printed on stderr and kept in
 * ~/.<ns>-mcp.
 *
 * The editor exposes the same command registry its own agent uses, so an
 * external agent gets every verb, the live schema, and the renders. The skill
 * ships as MCP resources (<ns>://skill/…) — point the agent at them.
 *
 * WHICH skill: the linked editor's. It hands its own build's skill over in
 * `hello`, so the knowledge always matches the tools (and a new app release
 * teaches the agent without a new npm release). The copy bundled here only
 * answers before a tab has ever linked. Publish this package when the BRIDGE
 * changes.
 *
 * Several agent sessions SHARE the link — see "One link, every session".
 *
 * Local only: the socket binds 127.0.0.1 and refuses any other tab without the token.
 */
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, readdirSync, statSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { mcpIdentity, skillVars } from "./identity.mjs";

// Who this bridge serves: `--identity <file>`, else identity.json beside it.
const identityArg = process.argv.indexOf("--identity");
const PRODUCT = JSON.parse(
  readFileSync(identityArg > 0 ? resolve(process.argv[identityArg + 1]) : join(dirname(fileURLToPath(import.meta.url)), "identity.json"), "utf8"),
);
const ID = mcpIdentity(PRODUCT);
const env = (name) => process.env[`${ID.envPrefix}_${name}`];
/** "an the app", "a SoloMotion": the name with its article. */
const A_NAME = `${/^[aeiou]/i.test(ID.name) ? "an" : "a"} ${ID.name}`;

const PORT = Number(env("PORT") ?? ID.port);
const TOKEN_FILE = join(homedir(), ID.home);
const CACHE_FILE = join(homedir(), `${ID.home}-cache.json`);
const token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : randomBytes(12).toString("base64url");
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
const log = (...a) => process.stderr.write(`[${ID.bin}] ${a.join(" ")}\n`);

/** The product's own origins: its web app, the desktop shell, and a dev server on this machine. */
const LOCAL_ORIGIN = /^(app:\/\/local|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const extra = (env("ORIGINS") ?? "").split(",").map((o) => o.trim()).filter(Boolean);
const trusted = (origin) => !!origin && (LOCAL_ORIGIN.test(origin) || ID.origins.includes(origin) || extra.includes(origin));

// ── The skill, as resources ──────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
// Published: the skill is copied beside the CLI at pack time (scripts/pack-skill.mjs).
// In the monorepo: read the source directly, so an edit shows up without a copy.
const VERSION = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")).version;
const skillRoot = existsSync(join(here, "../skill/skills")) ? join(here, "../skill") : join(here, "../../skill");
/** The skill's Markdown names no product; this fills in this product's words (packages/skill `stampSkill`). */
const VARS = skillVars(ID, PRODUCT.sliceExt ?? ".motion");
const stamp = (text) => text.replace(/\{\{(name|ns|status_tool|project_exts)\}\}/g, (_, k) => VARS[k]);
/** name (`skill/SKILL.md`) → text. The bundled copy, until an editor hands over its own. */
const bundled = new Map();
const walk = (dir, prefix) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
    else if (name.endsWith(".md")) bundled.set(`${prefix}${name}`, stamp(readFileSync(p, "utf8")));
  }
};
walk(join(skillRoot, "skills/solomotion"), "skill/");
walk(join(skillRoot, "design-systems/default"), "design/");
const skillVersionOf = (files) => /^version:\s*(\S+)/m.exec(files.get("skill/SKILL.md") ?? "")?.[1] ?? "unknown";
let knowledge = { files: bundled, version: skillVersionOf(bundled), source: "bundled" };

// ── What the last linked editor offered ──────────────────────────────────────
//
// A session starts before its tab answers, and an agent app reads the tool list
// once at start. Listing only the status verb until then made every session
// spend turns on "is it linked yet?" before it could see a single verb. The
// last editor's tools and skill are kept on disk, so a new session lists the
// real verbs at once; a call made before the tab answers waits for it (see
// `ready`), and the list is refreshed when the live one arrives.
let cached = { app: null, tools: [], knowledge: null };
try {
  if (existsSync(CACHE_FILE)) cached = { ...cached, ...JSON.parse(readFileSync(CACHE_FILE, "utf8")) };
} catch {
  /* a torn cache is only a slower first list */
}
if (cached.knowledge?.files) adoptKnowledge(cached.knowledge, "cache", false);

function remember(app, tools, k) {
  cached = { app, tools, knowledge: k ?? cached.knowledge };
  try {
    // Several bridges write it at once: write aside, then swap, so no reader sees half a file.
    const tmp = `${CACHE_FILE}.${session.id}`;
    writeFileSync(tmp, JSON.stringify(cached), { mode: 0o600 });
    renameSync(tmp, CACHE_FILE);
  } catch {
    /* read-only home: the cache is an optimisation */
  }
}

/** Adopt the linked editor's knowledge; tell the client when the list changed. */
function adoptKnowledge(k, source = "editor", announce = true) {
  const next = k?.files && Object.keys(k.files).length
    ? { files: new Map(Object.entries(k.files)), version: String(k.version ?? "unknown"), source }
    : { files: bundled, version: skillVersionOf(bundled), source: "bundled" };
  const changed = next.version !== knowledge.version || next.files.size !== knowledge.files.size;
  knowledge = next;
  if (changed && announce) notify("notifications/resources/list_changed");
}

// ── One link, every session ──────────────────────────────────────────────────
//
// The tab knocks on ONE port, and every agent session runs its own bridge. The
// first bridge to bind the port is the HUB: the tab connects to it, and every
// other session's bridge JOINS it over the same port. A call from any session
// travels hub → tab tagged with that session, and its answer comes back the
// same way — so every session works at once.
//
//   session A ─ bridge A (hub, holds the port) ─────── editor tab
//   session B ─ bridge B ─┘ joined         files for B ↓ relayed to B, written by B
//   session C ─ bridge C ─┘ joined
//
// THE HUB ONLY RELAYS. Every bridge does its own file IO: it reads its own
// `localPath`s (anywhere in a call, `api_batch` included) and writes its own
// `saveTo` files — the tab addresses each file to the SESSION that asked, and
// the hub forwards the chunks to that session's bridge. So one old or odd hub
// cannot take file IO away from every session (it did, 2026-11-01). The hub
// writes a file itself only for a bridge that cannot (before 3.8) or has gone.
//
// EVERY BRIDGE SAYS WHAT IT IS (`session.bridge`: version, protocol, pid,
// start, source, owner), so any session can list them all and spot a stale
// copy or a harness nobody uses. The tab says where it runs (origin, dev
// build, visible), the two things that make an export crawl.
//
// THE HUB IS A LEASE (`LEASE_IDLE_MS`): one whose own session stopped calling
// hands the role to a member that is working.
//
// THE HUB ROLE MOVES WITHOUT DROPPING ANYONE (protocol 3):
//
//   newer → hub   takeover { force }   on join when this bridge is newer (soft), or <ns>_status {takeOver} (hard)
//   hub → newer   takeover-go          the hub has let go of the port — but kept every socket
//   newer → hub   takeover-bound       it holds the port now (or takeover-failed: the hub binds again)
//   hub → all     moved { to }         rejoin through the port; the tab opens a second socket
//
// A hub the user put somewhere by hand is PINNED: a newer bridge joins it and
// waits (status says it could lead) instead of taking it back a second later.
//
// Calls already in flight finish on the old sockets (the old hub DRAINS), so a
// handover never cuts a call — the tab, the joined bridges and the old hub
// each keep the old path open until its last answer. The old hub then joins
// the new one like anyone else. A bridge before 3.8 cannot hand over; a hard
// takeover stops that process (the only lever left) and says so.
//
//   bridge → hub   join    { token, session, protocol }       first message
//   hub → bridge   link    { linked, app, tools, knowledge, features, hub, bridges, latest }  on join, and when the tab links or leaves
//   hub → bridge   bridges { bridges }                        every session's bridge, when one joins or leaves
//   bridge → hub   session { session }                        its agent app said who it is
//   bridge → hub   call    { id, name, input }
//   hub → bridge   progress { id, text }                      the tab says the call is alive
//   bridge → hub   cancel  { id }                             the session gave up on it
//   hub → bridge   result  { id, content, isError }
//   hub → bridge   file    { id, session, path, name, seq, data, last }  a file the tab made for this session
//   bridge → hub   filed   { id, path?, error? }              it is on disk (relayed to the tab)
//
// A 3.x port-lock bridge (before 3.5) cannot join; it asks for a HAND OVER
// instead, and the hub declines (it would cut every joined session off). A 3.x
// HUB is detected by its refusal of `join` and asked to hand over the old way.

const PROTOCOL = 3;
/** Where this copy runs from — what tells a stale npx cache from a fresh one. */
function sourceOf(p) {
  const npx = /[\\/]_npx[\\/]([0-9a-f]+)[\\/]/.exec(p);
  if (npx) return `npx cache ${npx[1].slice(0, 6)}`;
  return /[\\/]node_modules[\\/]/.test(p) ? "installed" : "repo";
}
/**
 * What started this bridge: the first ancestor that is not npm/npx/a shell —
 * "Claude", "Cursor", or a harness like "node drv.mjs" (the 2026-11-01 hub
 * was a debug harness nobody was using, holding the port for two days).
 */
function ownerOf(pid) {
  try {
    for (let i = 0; i < 4 && pid > 1; i++) {
      const [ppid, ...cmd] = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim().split(/\s+/);
      const exe = basename(cmd[0] ?? "");
      if (!/^(npm|npx|node|sh|bash|zsh|disclaimer)$/.test(exe) || (exe === "node" && cmd[1] && !/npm|npx/.test(cmd[1]))) {
        return exe === "node" && cmd[1] ? `node ${basename(cmd[1])}` : exe.replace(/\.app$/, "");
      }
      pid = Number(ppid);
    }
  } catch {
    /* no ps (Windows): the owner is simply not named */
  }
  return "unknown";
}
/** What THIS bridge is. Every session on the link carries its own. */
const BRIDGE = { version: VERSION, protocol: PROTOCOL, pid: process.pid, startedAt: Date.now(), source: sourceOf(here), owner: ownerOf(process.ppid), features: ["files"] };
/**
 * THE HUB IS A LEASE, kept by use. A hub whose own session has made no call
 * for this long hands the role to any member that asks (members ask when they
 * call, at most every `LEASE_ASK_MS`). A forgotten session, a harness wrapping
 * a bridge, a process whose agent app went away without closing its stdin —
 * none of them can sit on the link for days again.
 */
const LEASE_IDLE_MS = Number(env("LEASE_MS") ?? 10 * 60_000);
const LEASE_ASK_MS = 5 * 60_000;
/** When this session last asked its bridge for anything. */
let lastActive = Date.now();
const session = { id: randomBytes(6).toString("base64url"), client: "an MCP client", label: basename(process.cwd()), bridge: BRIDGE };
/** How long a call waits for the tab before it says how to link. The tab knocks every 2–15 s. */
const LINK_WAIT_MS = 17_000;
/**
 * A call the tab has gone QUIET on for this long is cancelled — no answer and
 * no progress. Not a deadline: an export that keeps reporting runs as long as
 * it needs (a 136-body reel took 10 minutes and used to be cut off at exactly
 * that, while the page rendered on, unseen, holding the next export hostage).
 */
const CALL_QUIET_MS = Number(env("QUIET_MS") ?? 600_000);
/**
 * A WAIT MUST NEVER OUTLIVE ITS CLIENT. MCP clients drop a request at 60 s
 * (unless they reset on progress, which most do not), and a tab deep in a
 * heavy render can be mid-frame for many seconds — one glass-and-materials
 * frame took 8 s, and `export_wait`'s own 25 s answered at 53. The client then
 * reported a timeout and the agent concluded the link was gone. `export_wait`
 * only READS, so past `SOFT_DEADLINE_MS` this bridge answers it itself with
 * the truth: still running, call again. The tab's late answer is dropped.
 */
const SOFT_DEADLINE = new Set(["export_wait"]);
const SOFT_DEADLINE_MS = Number(env("SOFT_WAIT_MS") ?? 45_000);
function beforeTheClientGivesUp(answer, args) {
  let timer;
  const soft = new Promise((resolve) => {
    timer = setTimeout(() => {
      const ids = Array.isArray(args.jobIds) ? args.jobIds.map(String) : [];
      const next = `export.wait {jobIds: ${JSON.stringify(ids)}}`;
      const body = {
        jobs: ids.map((jobId) => ({ jobId, state: "running", next: `export.wait {jobIds: ["${jobId}"]}` })),
        pending: ids.length || undefined,
        note: `The editor is busy rendering (a heavy frame can take seconds) and has not answered in ${SOFT_DEADLINE_MS / 1000} s. The export is still running and the link is fine: call ${ids.length ? next : "export_wait"} again.`,
      };
      resolve({ content: [{ type: "text", text: JSON.stringify(body) }] });
    }, SOFT_DEADLINE_MS);
  });
  return Promise.race([answer, soft]).finally(() => clearTimeout(timer));
}

/** Close code for a socket left behind by a handover: rejoin at once, no backoff. */
const MOVED = 4010;

/** `a` is a later release than `b` ("3.10.0" > "3.9.2"). An unknown version is never newer. */
function newer(a, b) {
  if (!a || !b) return false;
  const pa = String(a).split(/[.-]/).map(Number);
  const pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/**
 * A call's watchdog: fires after `CALL_QUIET_MS` without a `poke`. Every
 * progress message pokes it.
 */
function watchdog(onQuiet) {
  let timer = setTimeout(onQuiet, CALL_QUIET_MS);
  return {
    poke() {
      clearTimeout(timer);
      timer = setTimeout(onQuiet, CALL_QUIET_MS);
    },
    stop: () => clearTimeout(timer),
  };
}

const quietText = () =>
  `The editor went quiet for ${Math.round(CALL_QUIET_MS / 60_000)} minutes, so the call was cancelled (an export stops rendering). Check the project before retrying.`;

/** `hub`: this bridge holds the port. `joined`: it relays through the hub. `null`: electing. */
let role = null;
/** The hub's view of the tab, mirrored to every joined bridge. */
let link = { linked: false, app: null, tools: [] };
/** A 3.x bridge holds the port and refuses to share it. */
let legacyHolder = false;

const text = (t, isError = true) => ({ content: [{ type: "text", text: t }], isError });
const sendTo = (ws, msg) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
};

/**
 * The tool list as the client will see it, for "did it change?". It was the
 * COUNT: an app release that added an enum value (`catalog_list` gaining
 * `looks`) or a field kept the same number of tools, so the client was never
 * told and kept calling with the old schema. The whole list is compared —
 * a few hundred KB of JSON, once per link change.
 */
const toolsKey = (tools) => JSON.stringify(tools);

function setLink(next) {
  const toolsChanged = next.linked !== link.linked || toolsKey(next.tools) !== toolsKey(link.tools);
  link = next;
  if (next.linked) remember(next.app, next.tools, next.knowledge);
  if (next.knowledge) adoptKnowledge(next.knowledge);
  if (toolsChanged) notify("notifications/tools/list_changed");
}

// ── Electing ─────────────────────────────────────────────────────────────────

let electing = false;
let electTimer = 0;
/** A hard takeover is binding the port itself: a closed hub socket must not start an election. */
let seizing = false;
async function elect() {
  if (role || electing || seizing) return;
  electing = true;
  clearTimeout(electTimer);
  try {
    if (await becomeHub()) return;
    if (await joinHub()) return;
  } finally {
    electing = false;
  }
  // Neither: the port is mid-change, or a 3.x bridge holds it — that one is
  // asked to hand over only when this session wants to call (`ready`).
  electTimer = setTimeout(elect, legacyHolder ? 3_000 : 250);
}

/** Bind the port, retrying while another process lets go of it. */
async function bindPort(withinMs) {
  const until = Date.now() + withinMs;
  do {
    if (await becomeHub()) return true;
    await new Promise((r) => setTimeout(r, 40));
  } while (Date.now() < until);
  return false;
}

// ── The hub ──────────────────────────────────────────────────────────────────

let wss = null;
let editor = null;
/** What the tab can do (`hello.features`): "moved" = it follows a handover on a second socket. */
let editorFeatures = [];
/** The bridge release the linked app ships with (`hello.bridge`) — what "stale" is measured against. */
let latestBridge = null;
/** Where the linked tab runs: { app, origin, dev, visible } — a hidden dev-build tab renders many times slower. */
let editorInfo = null;
/**
 * WHOSE LINK IT IS. The tab that holds it (`hello.tab`, an id that survives a
 * reload of that tab and no other), and when it last let go.
 *
 * The rule used to be "the newest tab wins", and a tab knocking on its own —
 * resuming the link at load, or retrying after a drop — counted as newest.
 * So a dev hot reload of the linked tab (its socket closes, it knocks again a
 * second later) was a window for ANY other linked tab's retry to take the link,
 * and the agent's next calls wrote into a different project. Now only a
 * deliberate Link (`claim: "user"`) moves the link to another tab; a resume
 * takes it only from nobody, and not while its holder may be reloading.
 */
let holderTab = null;
let holderLeftAt = 0;
/** How long a closed holder keeps its link for its own reload. */
const RELOAD_GRACE_MS = 15_000;
/** Close code for a tab that resumed while another tab holds the link. */
const HELD = 4002;

/** Why a tab's hello may not take the link, or null when it may. */
function claimRefused(msg) {
  // A tab before this rule sends no claim: it keeps the old behaviour.
  if (msg.claim !== "resume") return null;
  if (typeof msg.tab === "string" && msg.tab === holderTab) return null;
  if (editor && !draining) return `another ${ID.name} tab holds the link`;
  if (holderTab && Date.now() - holderLeftAt < RELOAD_GRACE_MS) return "the tab that holds the link is reloading";
  return null;
}
/** Joined bridges: socket → their session. */
const members = new Map();
/** Calls out to the tab: id → { done, progress, from }. `from` is the member socket, or null for this session. */
const tabCalls = new Map();
let tabSeq = 0;
/** A handover under way: the member it goes to. */
let handingTo = null;
let handTimer = 0;
/** After a handover: this hub let go of the port and finishes what is in flight. */
let draining = false;
/**
 * The user put the hub HERE (a hard takeover): a newer bridge does not take it
 * back on its own — the user's choice outranks the version handshake. Lasts
 * until this hub ends, or another hard takeover.
 */
let pinned = false;

function becomeHub() {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: PORT });
    server.once("listening", () => {
      wss = server;
      role = "hub";
      legacyHolder = false;
      // A new hub has no tab until it knocks: calls wait for it rather than fail.
      link = { ...link, linked: !!editor };
      log(`holding ws://127.0.0.1:${PORT} for every session — in ${ID.name}: Agents ▸ Use your agent app ▸ Link (pairing token, if asked: ${token})`);
      resolve(true);
    });
    server.once("error", (e) => {
      if (e.code !== "EADDRINUSE") log(e.message);
      server.close();
      resolve(false);
    });
    server.on("connection", onConnection);
  });
}

const sessions = () => [session, ...members.values()];
function announceSessions() {
  sendTo(editor, { kind: "sessions", sessions: sessions() });
  // Every member keeps the list, so any session can say who is on the link (a hub before 3.8 never sends it).
  const msg = JSON.stringify({ kind: "bridges", bridges: sessions() });
  for (const s of members.keys()) sendTo(s, msg);
}

function linkState() {
  return {
    linked: !!editor,
    app: link.app,
    tools: link.tools,
    knowledge: editorKnowledge,
    features: ["files", "takeover"],
    hub: session,
    pinned,
    editor: editor ? editorInfo : null,
    bridges: sessions(),
    latest: latestBridge,
  };
}
let editorKnowledge = null;
function broadcastLink() {
  const msg = JSON.stringify({ kind: "link", ...linkState() });
  for (const s of members.keys()) sendTo(s, msg);
}

const memberBySession = (id) => [...members].find(([, s]) => s.id === id)?.[0] ?? null;
const writesOwnFiles = (s) => !!s?.bridge?.features?.includes("files");

/** File transfers relayed to the session that asked: id → { member, tab }. */
const relaying = new Map();

function onConnection(socket, req) {
  const originTrusted = trusted(req.headers.origin);
  let kind = null; // "tab" | "member"
  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!kind) {
      if (msg.kind === "handover") {
        // A 3.x bridge. Yielding would cut off every session joined here.
        if (msg.token !== token) return socket.close(4001, "bad token");
        return socket.send(JSON.stringify({ kind: "busy", client: `a newer ${ID.name} bridge that every session shares — restart this session's ${ID.name} MCP server (in Claude Code: /mcp) to join it`, idleMs: 0, inFlight: false }));
      }
      if (msg.kind === "join") {
        if (msg.token !== token) return socket.close(4001, "bad token");
        kind = "member";
        members.set(socket, { ...msg.session });
        socket.send(JSON.stringify({ kind: "link", ...linkState() }));
        announceSessions();
        return;
      }
      if (msg.kind !== "hello" || (!originTrusted && msg.token !== token)) return socket.close(4001, "bad token");
      const refused = claimRefused(msg);
      if (refused) return socket.close(HELD, refused);
      kind = "tab";
      // A tab that follows a handover reconnects while its old socket drains: that is not a second tab.
      // Nor is the SAME tab's new socket (a hot reload re-runs the link while the old socket lingers).
      if (editor && !draining) editor.close(4000, typeof msg.tab === "string" && msg.tab === holderTab ? "replaced by this tab's new link" : "replaced by a newer tab");
      editor = socket;
      holderTab = typeof msg.tab === "string" ? msg.tab : null;
      editorFeatures = Array.isArray(msg.features) ? msg.features : [];
      latestBridge = typeof msg.bridge === "string" ? msg.bridge : latestBridge;
      editorInfo = { app: msg.app, origin: msg.origin ?? req.headers.origin ?? null, dev: msg.dev ?? null, visible: msg.visible ?? null };
      editorKnowledge = msg.knowledge ?? null;
      socket.send(JSON.stringify({ kind: "welcome", client: session.client, features: ["files", "acks"] }));
      setLink({ linked: true, app: msg.app, tools: msg.tools ?? [], knowledge: editorKnowledge });
      broadcastLink();
      announceSessions();
      log(`editor connected (${msg.app}), ${link.tools.length} tools, skill ${knowledge.version}, ${members.size + 1} session(s)`);
      return;
    }
    if (kind === "tab") return fromTab(socket, msg, raw);
    if (kind === "member") return fromMember(socket, msg);
  });
  socket.on("close", () => {
    if (kind === "member") {
      members.delete(socket);
      if (handingTo === socket) abortHandover();
      // A file on its way to a session that left: tell the tab, so its delivery does not wait forever.
      for (const [id, r] of relaying) {
        if (r.member !== socket) continue;
        relaying.delete(id);
        sendTo(r.tab, { kind: "filed", id, error: "The agent session that asked for this file ended before it arrived." });
      }
      if (!draining) announceSessions();
      drainCheck();
    }
    if (kind === "tab" && editor === socket) {
      editor = null;
      holderLeftAt = Date.now();
      // A call the tab will never answer fails now, not in ten minutes.
      for (const c of tabCalls.values()) c.done(text(`The ${ID.name} tab closed or reloaded during this call. Check the project before retrying.`));
      if (draining) return drainCheck();
      setLink({ linked: false, app: link.app, tools: link.tools, knowledge: null });
      broadcastLink();
      log("editor disconnected");
    }
  });
}

function fromTab(socket, msg, raw) {
  if (msg.kind === "state") {
    if (socket === editor && editorInfo) editorInfo = { ...editorInfo, visible: !!msg.visible, rendering: !!msg.rendering };
    const note = JSON.stringify({ kind: "editor", editor: editorInfo });
    for (const s of members.keys()) sendTo(s, note);
    return;
  }
  if (msg.kind === "result") {
    tabCalls.get(msg.id)?.done({ content: msg.content, isError: !!msg.isError });
    return drainCheck();
  }
  if (msg.kind === "progress") return tabCalls.get(msg.id)?.progress(String(msg.text ?? ""));
  if (msg.kind === "file") {
    tabCalls.get(msg.id)?.progress(`Saving ${msg.name}`);
    // To the bridge of the session that asked — by the file's own address, or the call's.
    let to = relaying.get(msg.id)?.member ?? null;
    if (!to && msg.seq === 0) {
      const asked = typeof msg.session === "string" ? memberBySession(msg.session) : (tabCalls.get(msg.id)?.from ?? null);
      if (asked && writesOwnFiles(members.get(asked))) to = asked;
      if (to) relaying.set(msg.id, { member: to, tab: socket });
    }
    if (to) sendTo(to, String(raw));
    const filed = to ? null : receiveFile(msg);
    // PACE THE TAB BY MESSAGES. It used to pace itself by polling its socket's
    // `bufferedAmount` on a 20 ms timer, and a hidden tab throttles timers — to
    // one a minute after five minutes hidden — so a render handed over from a
    // background pane sat at exactly 32 MB (the socket's buffer) for minutes.
    // A message is never throttled. The hub acks once a chunk is written or on
    // the member's local socket, which works whatever the member's version.
    sendTo(socket, { kind: "ack", id: msg.id, seq: msg.seq });
    if (filed) {
      sendTo(socket, { kind: "filed", id: msg.id, ...filed });
      drainCheck();
    }
  }
}

function fromMember(socket, msg) {
  if (msg.kind === "session") {
    members.set(socket, { ...msg.session });
    return announceSessions();
  }
  if (msg.kind === "call") {
    const who = members.get(socket);
    const call = toTab(msg.name, msg.input, who, socket, (t) => sendTo(socket, { kind: "progress", id: msg.id, text: t }));
    memberCalls.set(`${who?.id}:${msg.id}`, call.cancel);
    void call.result.then((r) => {
      memberCalls.delete(`${who?.id}:${msg.id}`);
      sendTo(socket, { kind: "result", id: msg.id, ...r });
      drainCheck();
    });
    return;
  }
  if (msg.kind === "cancel") return memberCalls.get(`${members.get(socket)?.id}:${msg.id}`)?.();
  if (msg.kind === "filed") {
    const r = relaying.get(msg.id);
    if (!r || r.member !== socket) return;
    relaying.delete(msg.id);
    sendTo(r.tab, { kind: "filed", id: msg.id, path: msg.path, error: msg.error });
    return drainCheck();
  }
  if (msg.kind === "takeover") return handOver(socket, !!msg.force);
  if (msg.kind === "takeover-bound" && handingTo === socket) return finishHandover(socket);
  if (msg.kind === "takeover-failed" && handingTo === socket) return abortHandover();
}

// ── Handing the hub over ─────────────────────────────────────────────────────

/** A member asks for the hub: always when forced (the user said so), otherwise only a newer bridge. */
function handOver(to, force) {
  const asker = members.get(to);
  const idle = Date.now() - lastActive > LEASE_IDLE_MS;
  if (!force && !idle && pinned) return sendTo(to, { kind: "takeover-refused", why: "The user moved the link to this hub." });
  if (!force && !idle && !newer(asker?.bridge?.version, VERSION)) return sendTo(to, { kind: "takeover-refused", why: "This hub is in use and not older than yours." });
  // NEVER UNDER A RENDER. Moving the hub makes the tab re-link, and a tab deep
  // in an export is the one tab that cannot do that promptly: the agent that
  // started the job was told no tab was linked, a third of the way into its
  // render, three times in one day. The lease is about a forgotten hub, not a
  // working one; the asker asks again later (`LEASE_ASK_MS`), and the user can
  // still force it.
  if (!force && editorInfo?.rendering) return sendTo(to, { kind: "takeover-refused", why: "The tab is rendering; the hub moves when it is done." });
  if (handingTo || draining || role !== "hub") return sendTo(to, { kind: "takeover-refused", why: "The hub is already handing over." });
  handingTo = to;
  // Let go of the port, keep every socket: the calls in flight still need them.
  wss?.close();
  wss = null;
  // WHOSE LINK IT IS travels with the role: the new hub starts with no memory,
  // and for the moment until the holder follows, any other tab's resume would
  // find an empty link and take it. Handed over as "leaving now", so the
  // holder gets its link back and everyone else waits out the grace.
  sendTo(to, { kind: "takeover-go", holder: holderTab ? { tab: holderTab, leftAgoMs: editor ? 0 : Date.now() - holderLeftAt } : null });
  handTimer = setTimeout(abortHandover, 4_000);
  log(`handing the hub to ${asker?.client ?? "a session"} (${asker?.bridge?.version ?? "?"})${force ? ", forced" : idle ? ", this session is idle" : ""}`);
}

async function abortHandover() {
  clearTimeout(handTimer);
  handingTo = null;
  if (draining) return;
  // Take the port back; if someone else got it first, the tab is theirs to have.
  if (!(await becomeHub())) finishHandover(null);
}

function finishHandover(to) {
  clearTimeout(handTimer);
  handingTo = null;
  draining = true;
  role = null;
  pinned = false;
  const moved = JSON.stringify({ kind: "moved", to: to ? members.get(to) : null });
  for (const s of members.keys()) if (s !== to) sendTo(s, moved);
  if (editorFeatures.includes("moved")) sendTo(editor, moved);
  // This session joins the new hub like anyone else.
  setTimeout(elect, 30);
  drainCheck();
}

/** A member with a call still in flight here. */
const busyMember = (s) => [...memberCalls.keys()].some((k) => k.startsWith(`${members.get(s)?.id}:`));

/** After a handover: close each old path once nothing is in flight on it. */
function drainCheck() {
  if (!draining) return;
  for (const s of members.keys()) {
    if (!busyMember(s) && ![...relaying.values()].some((r) => r.member === s)) s.close(MOVED, "the hub moved");
  }
  if (tabCalls.size || relaying.size || incoming.size) return;
  // A tab that follows `moved` closes its old socket itself; an older one is told to come back now.
  if (editor) editor.close(editorFeatures.includes("moved") ? 1000 : MOVED, "the hub moved");
  editor = null;
  if (!members.size) {
    draining = false;
    log("handed the hub over; this session joined it");
  }
}

/** A member's call in flight at the tab: `${session}:${its id}` → cancel. */
const memberCalls = new Map();

/**
 * Send one call to the tab, tagged with the session that made it. `cancel`
 * tells the tab to stop (an export aborts its render) and answers the call
 * at once; a call the tab goes quiet on is cancelled the same way.
 */
function toTab(name, input, who, from, onProgress) {
  if (!editor) return { result: Promise.resolve(text(notLinked())), cancel: () => {} };
  const id = `t${++tabSeq}`;
  const tab = editor;
  let finish;
  const result = new Promise((resolve) => {
    finish = (r) => {
      dog.stop();
      if (tabCalls.delete(id)) resolve(r);
    };
  });
  const cancel = (why = "The call was cancelled; the editor stopped working on it.") => {
    if (!tabCalls.has(id)) return;
    sendTo(tab, { kind: "cancel", id });
    finish(text(why));
  };
  const dog = watchdog(() => cancel(quietText()));
  tabCalls.set(id, {
    from,
    done: finish,
    progress: (t) => {
      dog.poke();
      onProgress?.(t);
    },
  });
  tab.send(JSON.stringify({ kind: "call", id, name, input, session: who }));
  return { result, cancel: () => cancel() };
}

// ── Files the tab hands back ─────────────────────────────────────────────────
//
// `saveTo` was resolved to an absolute path by the bridge of the session that
// asked (see `withSaveTo`), and that bridge writes it: the hub relays the
// chunks. Chunks land in `<file>.part`, renamed into place on the last one, so
// an interrupted transfer never leaves a file that looks finished.

/** Partial files: transfer id → { part, final, error }. */
const incoming = new Map();

/**
 * Where a file named `name` lands for `saveTo` = `dest`: inside it when it is a
 * folder (a trailing slash, or one that exists), else at that path — with the
 * file's own extension when the path has none, so `render/cut` is a
 * `render/cut.mp4` and never an extensionless file nothing opens.
 */
function fileDestination(dest, name) {
  let folder = /[\\/]$/.test(dest);
  if (!folder) {
    try {
      folder = statSync(dest).isDirectory();
    } catch {}
  }
  if (folder) return join(dest, name);
  return extname(dest) ? dest : `${dest}${extname(name)}`;
}

function receiveFile(msg) {
  let f = incoming.get(msg.id);
  try {
    if (msg.seq === 0 || !f) {
      const final = fileDestination(String(msg.path), basename(String(msg.name)));
      f = { final, part: `${final}.part`, error: null };
      incoming.set(msg.id, f);
      mkdirSync(dirname(final), { recursive: true });
      writeFileSync(f.part, Buffer.from(msg.data, "base64"));
    } else if (!f.error) {
      appendFileSync(f.part, Buffer.from(msg.data, "base64"));
    }
  } catch (err) {
    if (f) f.error = err instanceof Error ? err.message : String(err);
  }
  if (!msg.last) return null;
  incoming.delete(msg.id);
  if (!f.error) {
    try {
      renameSync(f.part, f.final);
      log(`saved ${f.final}`);
      return { path: f.final };
    } catch (err) {
      f.error = err instanceof Error ? err.message : String(err);
    }
  }
  rmSync(f.part, { force: true });
  return { error: `Could not write ${f.final}: ${f.error}` };
}

// ── A joined bridge ──────────────────────────────────────────────────────────

let hub = null;
/** What the hub can do. A hub before 3.7 sends no `features` and writes no files. */
let hubFeatures = [];
/** The hub's session, with its bridge. Null from a hub before 3.8, which does not say. */
let hubSession = null;
/** Every bridge on the link, as the hub last listed them (3.8+ hubs). */
let peers = [];
/** Calls through a hub: id → { done, progress, via }. */
const hubCalls = new Map();
let hubSeq = 0;
/** Waiting for the hub's answer to `takeover`: resolve, and whether the user forced it. */
let takeoverReply = null;
let takeoverForced = false;

function joinHub() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    let joined = false;
    const timer = setTimeout(() => ws.terminate(), 2_500);
    ws.on("open", () => ws.send(JSON.stringify({ kind: "join", token, session, protocol: PROTOCOL })));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.kind === "file") {
        // A file this session asked for: written here, by this session's own bridge.
        const filed = receiveFile(msg);
        if (filed) sendTo(ws, { kind: "filed", id: msg.id, ...filed });
        return;
      }
      if (hub !== ws && joined) {
        // An old hub's socket, draining after a handover: only answers still count.
        if (msg.kind === "result") hubCalls.get(msg.id)?.done({ content: msg.content, isError: !!msg.isError });
        if (msg.kind === "progress") hubCalls.get(msg.id)?.progress(String(msg.text ?? ""));
        return;
      }
      if (msg.kind === "link") {
        if (!joined) {
          joined = true;
          clearTimeout(timer);
          hub = ws;
          role = "joined";
          legacyHolder = false;
          log(`joined the session hub on ${PORT}`);
          resolve(true);
        }
        hubFeatures = Array.isArray(msg.features) ? msg.features : [];
        hubSession = msg.hub ?? null;
        peers = Array.isArray(msg.bridges) ? msg.bridges : [];
        if (typeof msg.latest === "string") latestBridge = msg.latest;
        if (msg.editor !== undefined) editorInfo = msg.editor;
        setLink({ linked: msg.linked, app: msg.app, tools: msg.tools ?? [], knowledge: msg.knowledge });
        // The version handshake: a newer bridge takes the hub, so the newest wire is the one in charge.
        if (hubSession?.bridge?.protocol >= 3 && !msg.pinned && newer(VERSION, hubSession.bridge.version) && !softAsked) {
          softAsked = true;
          void requestTakeover(false);
        }
        return;
      }
      if (msg.kind === "result") hubCalls.get(msg.id)?.done({ content: msg.content, isError: !!msg.isError });
      if (msg.kind === "progress") hubCalls.get(msg.id)?.progress(String(msg.text ?? ""));
      if (msg.kind === "bridges" && Array.isArray(msg.bridges)) peers = msg.bridges;
      if (msg.kind === "editor") editorInfo = msg.editor ?? null;
      if (msg.kind === "takeover-go") void takeHub(ws, msg.holder);
      if (msg.kind === "takeover-refused") takeoverReply?.({ ok: false, why: String(msg.why ?? "refused") });
      if (msg.kind === "moved") {
        // The hub moved: rejoin through the port. This socket stays open for the calls still on it.
        hub = null;
        role = null;
        softAsked = false;
        setTimeout(elect, 30);
      }
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      if (!joined) {
        // A 3.x bridge closes an unknown first message as a bad token.
        legacyHolder = code === 4001;
        return resolve(false);
      }
      // Calls still on this socket were not answered and will not be.
      for (const c of hubCalls.values()) {
        if (c.via === ws) c.done(text(`The ${ID.name} link moved to another session during this call. Check the project before retrying.`));
      }
      if (hub !== ws) return;
      hub = null;
      role = null;
      link = { ...link, linked: false };
      if (seizing) return;
      log(code === MOVED ? "the hub moved — rejoining" : "the hub's session ended — electing a new one");
      setTimeout(elect, code === MOVED ? 30 : Math.random() * 120);
    });
    ws.on("error", () => {});
  });
}
let softAsked = false;

/** The hub said go: bind the port it let go of, and tell it how that went. */
async function takeHub(via, holder) {
  const bound = await bindPort(1_500);
  if (bound) pinned = takeoverForced;
  // The tab that held the link at the old hub is the one that may resume it here (see `claimRefused`).
  if (bound && holder && typeof holder.tab === "string") {
    holderTab = holder.tab;
    holderLeftAt = Date.now() - Math.max(0, Number(holder.leftAgoMs) || 0);
  }
  sendTo(via, { kind: bound ? "takeover-bound" : "takeover-failed" });
  if (bound) hub = null; // the old hub's socket drains and closes on its own
  takeoverReply?.(bound ? { ok: true } : { ok: false, why: "Another process took the port first." });
}

/** Ask the (3.8+) hub for its role. Resolves once this bridge holds the port, or why not. One ask at a time. */
let takeoverChain = Promise.resolve();
function requestTakeover(force) {
  const next = takeoverChain.then(() => (role === "joined" ? askTakeover(force) : { ok: role === "hub", why: "Not joined to a hub." }));
  takeoverChain = next.catch(() => {});
  return next;
}
function askTakeover(force) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done({ ok: false, why: "The hub did not answer." }), 6_000);
    const done = (r) => {
      clearTimeout(timer);
      takeoverReply = null;
      resolve(r);
    };
    takeoverReply = done;
    takeoverForced = force;
    sendTo(hub, { kind: "takeover", force });
  });
}

/** `toTab`, from a joined bridge: the hub relays the call, its progress, and a cancel. */
function viaHub(name, input, onProgress) {
  const id = `j${++hubSeq}`;
  const via = hub;
  let finish;
  const result = new Promise((resolve) => {
    finish = (r) => {
      dog.stop();
      if (hubCalls.delete(id)) resolve(r);
    };
  });
  const cancel = (why = "The call was cancelled; the editor stopped working on it.") => {
    if (!hubCalls.has(id)) return;
    sendTo(via, { kind: "cancel", id });
    finish(text(why));
  };
  const dog = watchdog(() => cancel(quietText()));
  hubCalls.set(id, {
    via,
    done: finish,
    progress: (t) => {
      dog.poke();
      onProgress?.(t);
    },
  });
  via.send(JSON.stringify({ kind: "call", id, name, input }));
  return { result, cancel: () => cancel() };
}

/** The 3.x way: ask its holder to yield. It does once its own session is idle 20 s (or at once when forced). */
function askLegacyHandover(force) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const finish = async (msg) => {
      clearTimeout(timer);
      ws.terminate();
      // Bind straight away: 3.x bridges on standby re-try the port every 1.5 s.
      if (msg?.kind === "yielding") await new Promise((r) => setTimeout(r, 60)).then(becomeHub);
      resolve(msg);
    };
    const timer = setTimeout(() => finish(null), 2_000);
    ws.on("open", () => ws.send(JSON.stringify({ kind: "handover", token, client: `${session.client} (${session.label})`, force })));
    ws.on("message", (raw) => {
      try {
        finish(JSON.parse(String(raw)));
      } catch {
        finish(null);
      }
    });
    ws.on("error", () => finish(null));
  });
}

// ── Who holds the port ───────────────────────────────────────────────────────
//
// A bridge before 3.8 does not say what it is, and cannot hand the hub over.
// The OS can say who it is: the process listening on the port.

const BRIDGE_COMMAND = new RegExp(`${ID.bin}|@${ID.ns}[\\\\/]mcp|packages[\\\\/]mcp[\\\\/]src[\\\\/]cli\\.mjs`);

/** The process listening on the port: { pid, command, uptime }, or null when unknown (or no lsof). */
function portHolder() {
  try {
    const pid = Number(execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 3_000 }).trim().split("\n")[0]);
    if (!pid) return null;
    const [etime, ...cmd] = execFileSync("ps", ["-o", "etime=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 3_000 }).trim().split(/\s+/);
    return { pid, command: cmd.join(" "), uptime: uptimeOf(etime) };
  } catch {
    return null;
  }
}

/** `ps` elapsed time ("02-03:04:05", "03:04:05", "04:05") → "2 d 3 h" / "3 h 4 min" / "4 min". */
function uptimeOf(etime = "") {
  const [d, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const p = rest.split(":").map(Number);
  const [h, m] = p.length === 3 ? p : [0, p[0] ?? 0];
  return Number(d) ? `${Number(d)} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

const ago = (ms) => uptimeOf(`${Math.floor(ms / 86_400_000)}-${Math.floor(ms / 3_600_000) % 24}:${Math.floor(ms / 60_000) % 60}:0`);

/** One bridge, as a person reads it: "PID 5817 · 3.8.0 · npx cache 637d88 · up 2 d 1 h". */
function describeBridge(b) {
  if (!b) return "an older bridge (before 3.8; it does not say its version)";
  return `PID ${b.pid} · ${b.version} · ${b.source} · up ${ago(Date.now() - b.startedAt)}${b.owner ? ` · started by ${b.owner}` : ""}`;
}

/** The linked tab, and what will make its renders slow. */
function describeEditor(e) {
  if (!e) return null;
  const where = e.origin ? ` at ${e.origin}` : "";
  const notes = [];
  if (e.dev) notes.push("a DEV build: renders and exports run several times slower than the production app");
  if (e.visible === false) notes.push("HIDDEN: a browser throttles a hidden tab or pane, so renders crawl — bring it to the front while exporting");
  return `Editor: ${e.app ?? ID.name}${where}${e.dev === false ? " (production build)" : ""}${e.visible ? ", visible" : ""}.${notes.map((n) => `\n⚠ The editor is ${n}.`).join("")}`;
}

/** The hub before 3.8, from what the wire and the OS can tell. */
function describeLegacyHub(holder) {
  const version = hubFeatures.includes("files") ? "3.7" : "before 3.7";
  if (!holder) return `an older bridge (${version})`;
  return `PID ${holder.pid} · ${version} · ${sourceOf(holder.command)} · up ${holder.uptime}`;
}

// ── Taking over ──────────────────────────────────────────────────────────────

/**
 * THE HARD TAKEOVER — the user wants THIS session to hold the link, now.
 * Never drops this session's own link: it is a member until the moment it
 * holds the port. A 3.8+ hub hands over and stays on as a member, so nobody
 * loses anything. A hub before 3.8 cannot hand over, so its process is
 * stopped — the one case where another session loses its MCP server, and
 * the answer says so.
 */
async function takeOver() {
  if (role === "hub") {
    if (!editor) await ready();
    return `This session already holds the ${ID.name} link${members.size ? `, shared with ${members.size} other session${members.size === 1 ? "" : "s"}` : ""}. Nothing to take over.`;
  }
  if (!role) await ready(4_000);
  if (role === "joined" && hubSession?.bridge?.protocol >= 3) {
    const from = describeBridge(hubSession.bridge);
    const r = await requestTakeover(true);
    if (r.ok) {
      await ready();
      return `Took over from ${from}. This session now holds the ${ID.name} link; that session stays on it through here.`;
    }
    if (role !== "joined") await ready(4_000);
    if (role === "hub") return `Took over from ${from}.`;
    // An unanswering 3.8+ hub is stuck: fall through to the process.
  }
  if (!role && legacyHolder) {
    await askLegacyHandover(true);
    if (role === "hub") {
      await ready();
      return `Took over from an older 3.x bridge (before 3.5); it yielded. This session now holds the ${ID.name} link.`;
    }
  }
  return seize();
}

/** Stop the process holding the port and bind it. Only for a bridge that cannot hand over. */
async function seize() {
  const holder = portHolder();
  if (!holder) return `Could not tell which process holds port ${PORT} (lsof found nothing). ${statusText()}`;
  if (holder.pid === process.pid) return statusText();
  if (!BRIDGE_COMMAND.test(holder.command)) {
    return `Port ${PORT} is held by PID ${holder.pid} (${holder.command}), which is not ${A_NAME} bridge, so it was left alone. Ask the user to stop it.`;
  }
  const from = role === "joined" && hubSession ? describeBridge(hubSession.bridge) : describeLegacyHub(holder);
  seizing = true;
  try {
    process.kill(holder.pid, "SIGTERM");
    const until = Date.now() + 3_000;
    while (alive(holder.pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    if (alive(holder.pid)) process.kill(holder.pid, "SIGKILL");
    const bound = await bindPort(3_000);
    pinned = bound;
    seizing = false;
    if (!bound) {
      await ready();
      return `Stopped ${from}, but another session's bridge bound the port first; this session joined it. Call ${ID.statusTool} {takeOver: true} again to take it from that one.`;
    }
  } catch (err) {
    seizing = false;
    void elect();
    return `Could not stop PID ${holder.pid}: ${err instanceof Error ? err.message : String(err)}.`;
  } finally {
    seizing = false;
  }
  await ready();
  return `Took over from ${from}. It was too old to hand over (before 3.8), so its process was stopped — that session needs its ${ID.name} server restarted (Claude Code: /mcp ▸ ${ID.serverName} ▸ Reconnect). This session now holds the ${ID.name} link.`;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Calls ────────────────────────────────────────────────────────────────────

const notLinked = () =>
  legacyHolder
    ? `An older ${ID.name} bridge (from an agent session started before ${ID.package} 3.5) holds the link and is in use. Restart that session's ${ID.name} MCP server, or call ${ID.statusTool} {takeOver: true} if the user wants this session to drive now.`
    : `No ${ID.name} tab is linked. Ask the user to open ${ID.name} and click Agents ▸ Use your agent app ▸ Link (a tab it does not trust will ask for the pairing token: ${token}).`;

/** Wait until this session can reach the tab. Returns why not, or null. */
async function ready(wait = LINK_WAIT_MS) {
  const t0 = Date.now();
  let askedAt = 0;
  while (!(role && link.linked) && Date.now() - t0 < wait) {
    if (!role) void elect();
    // Found while waiting (a call can come before the first election ends): ask the 3.x holder now and then.
    if (!role && legacyHolder && Date.now() - askedAt > 2_500) {
      askedAt = Date.now();
      await askLegacyHandover(false);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return role && link.linked ? null : notLinked();
}

/** MCP request id → cancel, for `notifications/cancelled`. */
const inflight = new Map();

async function callEditor(name, input, rpcId, onProgress) {
  const why = await ready();
  if (why) return text(why);
  let args;
  try {
    const budget = { bytes: 0 };
    args = mapFileArgs(input, budget);
  } catch (err) {
    return text(err instanceof Error ? err.message : String(err));
  }
  // A file the call makes comes HERE, to this session's bridge, unless the agent named a place:
  // a browser download from an agent's tab may never land (6 of 9 did not, 2026-11-01).
  if (args?.saveTo === undefined && link.tools.find((t) => t.name === name)?.inputSchema?.properties?.saveTo && (role === "hub" || hubFeatures.includes("files"))) {
    args = { ...args, saveTo: `${join(homedir(), "Downloads")}/` };
  }
  if (role === "joined" && hasKey(args, "saveTo") && !hubFeatures.includes("files")) {
    const holder = portHolder();
    return text(
      `saveTo cannot reach this session: the hub (${describeLegacyHub(holder)}) is too old to pass files on. Call ${ID.statusTool} {takeOver: true} to move the link to this session (it stops that old bridge), or omit saveTo and the file goes to the browser's downloads.`,
    );
  }
  // Renew the lease where it lapsed: an idle hub hands the link to the session that is working.
  if (role === "joined" && hubSession?.bridge?.protocol >= 3 && !takeoverReply && Date.now() - leaseAskedAt > LEASE_ASK_MS) {
    leaseAskedAt = Date.now();
    void requestTakeover(false);
  }
  const call = role === "hub" ? toTab(name, args, session, null, onProgress) : viaHub(name, args, onProgress);
  if (rpcId !== undefined) inflight.set(rpcId, call.cancel);
  try {
    return withStaleNote(await call.result);
  } finally {
    if (rpcId !== undefined) inflight.delete(rpcId);
  }
}

let leaseAskedAt = 0;

/** What one call may carry from disk: base64 grows it by a third, and the socket takes 100 MB. */
const LOCAL_FILE_MAX = 48 * 1024 * 1024;

const hasKey = (v, key, depth = 0) =>
  !!v && typeof v === "object" && depth < 8 && (Object.hasOwn(v, key) || Object.values(v).some((x) => hasKey(x, key, depth + 1)));

/**
 * The file arguments of a call, anywhere in it — `api_batch` nests a whole
 * call in `calls[].input`, and a top-level-only reading sent its `localPath`
 * to the tab unread ("cannot read local files yet").
 */
function mapFileArgs(v, budget, depth = 0) {
  if (!v || typeof v !== "object" || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => mapFileArgs(x, budget, depth + 1));
  let out = v;
  for (const [k, x] of Object.entries(v)) {
    if (x && typeof x === "object") {
      const m = mapFileArgs(x, budget, depth + 1);
      if (m !== x) out = { ...out, [k]: m };
    }
  }
  return withSaveTo(withLocalFile(out, budget));
}

/**
 * A `localPath` argument names a file on THIS machine — where the agent and its
 * files are, and where the editor tab cannot look. Read it here and hand the
 * tab the bytes as `localFile`; the editor's file-taking commands accept either.
 * Relative paths are the agent's working folder, as in every other tool it has.
 */
function withLocalFile(input, budget) {
  if (typeof input.localPath !== "string" || input.localFile) return input;
  const path = resolve(process.cwd(), input.localPath.replace(/^~(?=\/|$)/, homedir()));
  let size;
  try {
    size = statSync(path).size;
  } catch {
    throw new Error(`No file at ${path}.`);
  }
  budget.bytes += size;
  if (budget.bytes > LOCAL_FILE_MAX) {
    throw new Error(`${basename(path)} brings this call to ${Math.round(budget.bytes / 1e6)} MB; one call can carry up to 48 MB of local files. Import them in separate calls, or serve larger media over http and pass its url.`);
  }
  return { ...input, localFile: { name: basename(path), base64: readFileSync(path).toString("base64") } };
}

/**
 * A `saveTo` argument names where a file the call makes should land on THIS
 * machine. Resolved here, against this session's working folder, so the
 * bridge that writes it puts it where this agent asked. A trailing slash
 * means "into this folder".
 */
function withSaveTo(input) {
  if (typeof input.saveTo !== "string") return input;
  const raw = input.saveTo.replace(/^~(?=\/|$)/, homedir());
  const abs = resolve(process.cwd(), raw);
  return { ...input, saveTo: /[\\/]$/.test(raw) ? `${abs}/` : abs };
}

// ── Status ───────────────────────────────────────────────────────────────────

/** The newest bridge release anyone on the link knows of: the app's, or a peer's. */
function newestKnown() {
  let best = VERSION;
  for (const v of [latestBridge, ...knownBridges().map((s) => s.bridge?.version)]) if (newer(v, best)) best = v;
  return best;
}

const knownBridges = () => (role === "hub" ? sessions() : peers);

/** Why a bridge is stale, and the fix that applies to how it was started. */
function staleWhy(b, newest) {
  if (!b) return `an older bridge (before 3.8) is on the link — restart its session's ${ID.name} server on ${ID.package}@latest.`;
  if (!newer(newest, b.version)) return null;
  const fix = b.source.startsWith("npx cache")
    ? `it is a cached npx copy (${b.source}): the MCP config says \`npx ${ID.package}\` without @latest, so npx keeps serving it. Change it to \`npx -y ${ID.package}@latest\`, then restart that session's ${ID.name} server`
    : b.source === "repo"
      ? `it is a repo bridge started on older code: restart that session's ${ID.name} server`
      : `update it and restart that session's ${ID.name} server`;
  return `PID ${b.pid} runs ${b.version}, ${newest} is out — ${fix}.`;
}

function statusText() {
  if (!role || !link.linked) return notLinked();
  const newest = newestKnown();
  const lines = [`Connected to ${link.app ?? ID.name}, ${link.tools.length} tools, skill ${knowledge.version}.`];
  const ed = describeEditor(editorInfo);
  if (ed) lines.push(ed);
  lines.push(`This session: ${ID.package} ${VERSION} (${BRIDGE.source}, PID ${process.pid}) — ${role === "hub" ? "it holds the link (the hub)" : "joined to the hub"}.`);
  const bridges = role === "hub" ? sessions() : hubSession ? peers : null;
  if (bridges) {
    lines.push(`Bridges on the link (${bridges.length}):`);
    const hubId = role === "hub" ? session.id : hubSession?.id;
    for (const s of bridges) lines.push(`• ${s.id === hubId ? "hub · " : ""}${describeBridge(s.bridge)} · ${s.label ?? "?"} (${s.client})${s.id === session.id ? " · this session" : ""}`);
  } else {
    lines.push(`The hub is ${describeLegacyHub(portHolder())}: it cannot list the other bridges, hand over or pass files on. ${ID.statusTool} {takeOver: true} moves the link here (it stops that bridge).`);
  }
  const stale = (bridges ?? [session]).map((s) => staleWhy(s.bridge, newest)).filter(Boolean);
  if (stale.length) lines.push(...stale.map((s) => `⚠ ${s}`));
  return lines.join("\n");
}

/** Once per session: a stale bridge says so on its first answer, since agents rarely ask. */
let staleNoted = false;
function withStaleNote(result) {
  if (staleNoted || !link.linked) return result;
  const newest = newestKnown();
  if (!newer(newest, VERSION)) return result;
  staleNoted = true;
  return { ...result, content: [...result.content, { type: "text", text: `Note for the user: ${staleWhy(BRIDGE, newest)}` }] };
}

// ── MCP over stdio (JSON-RPC 2.0, newline-delimited) ─────────────────────────
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const notify = (method, params) => send(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method });
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const STATUS_TOOL = {
  name: ID.statusTool,
  description:
    `Check the ${ID.name} link: whether a tab is connected, and every agent session's bridge on it (version, PID, stale copies). When no tab is linked, tell the user: open ${ID.name} (${ID.origins[0]} or the desktop app), then Agents ▸ Use your agent app ▸ Link.`,
  inputSchema: {
    type: "object",
    properties: {
      takeOver: {
        type: "boolean",
        description:
          "Only when the user wants THIS session to hold the link (or a call said the hub is too old): moves the link and the hub here at once and reports what it took over. A bridge before 3.8 cannot hand over, so its process is stopped.",
      },
    },
  },
};

/** The live editor's tools when linked, otherwise the last editor's — calls wait for the tab. */
const listedTools = () => [STATUS_TOOL, ...(link.tools.length ? link.tools : cached.tools)];

void elect();

const rl = createInterface({ input: process.stdin });
// The agent app closed this session: let the others elect a hub now, not when the OS reaps us.
rl.on("close", () => process.exit(0));
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  try {
    switch (method) {
      case "initialize":
        session.client = params?.clientInfo?.name ?? session.client;
        sendTo(hub, { kind: "session", session });
        if (role === "hub") announceSessions();
        return reply(id, {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
          serverInfo: { name: ID.serverName, version: VERSION },
          instructions:
            `${ID.name} is a motion design and video studio. Read ${ID.scheme}://skill/SKILL.md first — it is how to work in the app — and its references only when a task touches them. The skill's \`version\` changes when the app teaches something new; if you remember an older one, re-read. Every change you make is visible live to the user and is one undo step per request.`,
        });
      case "notifications/initialized":
        return;
      case "notifications/cancelled":
        inflight.get(params?.requestId)?.();
        return;
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: listedTools() });
      case "tools/call": {
        lastActive = Date.now();
        if (params?.name === STATUS_TOOL.name) {
          if (params?.arguments?.takeOver === true) return reply(id, { content: [{ type: "text", text: `${await takeOver()}\n\n${statusText()}` }] });
          await ready(4_000);
          return reply(id, { content: [{ type: "text", text: statusText() }] });
        }
        // A client that asked for progress hears the tab's ("Exporting · 40%").
        const token = params?._meta?.progressToken;
        let step = 0;
        const onProgress = token === undefined ? undefined : (message) => notify("notifications/progress", { progressToken: token, progress: ++step, message });
        const answer = callEditor(params?.name, params?.arguments ?? {}, id, onProgress);
        return reply(id, SOFT_DEADLINE.has(params?.name) ? await beforeTheClientGivesUp(answer, params?.arguments ?? {}) : await answer);
      }
      case "resources/list":
        return reply(id, {
          resources: [...knowledge.files.keys()].map((name) => ({
            uri: `${ID.scheme}://${name}`,
            name,
            mimeType: "text/markdown",
            description: name === "skill/SKILL.md" ? `${ID.name} skill ${knowledge.version} — read first` : undefined,
          })),
        });
      case "resources/read": {
        const uri = String(params?.uri ?? "");
        const body = uri.startsWith(`${ID.scheme}://`) ? knowledge.files.get(uri.slice(`${ID.scheme}://`.length)) : undefined;
        if (body === undefined) return fail(id, -32602, "Unknown resource");
        return reply(id, { contents: [{ uri, mimeType: "text/markdown", text: body }] });
      }
      default:
        if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (id !== undefined) fail(id, -32603, err instanceof Error ? err.message : String(err));
  }
});
