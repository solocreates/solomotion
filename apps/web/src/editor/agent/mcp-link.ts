"use client";

import { identity } from "@/editor/identity";
import { product } from "@/editor/product";
import { create } from "zustand";
import { FILE_CHUNK_BYTES, type BridgeContent, type BridgeKnowledge, type BridgeSession, type BridgeToEditor, type EditorToBridge } from "@solomotion/mcp/protocol";
import mcpPackage from "@solomotion/mcp/package.json";
import type { DeliveredFile } from "@solomotion/core";
import { BRIDGE, SKILL_FILES, DEFAULT_DESIGN_SYSTEM_FILES, SKILL_VERSION } from "./bridge";
import { getDocStore } from "../state/document-context";
import { editorApiSession } from "../state/session";
import { APP_VERSION } from "../version";
import { callCommand } from "./call";
import { useAppShell } from "../state/app-shell";
import { dbGet, dbPut } from "./db";
import { AUTO_LINK_KEY } from "./mcp-boot";
import { agentApi, toOutput } from "./runner";
import { recordFeedback, REPORT_TOOL } from "./feedback";
import type { ReportBody } from "@solomotion/agent";
import { requireFeature } from "../entitlements";
import { renderJobs, renderLineBusy } from "../export/render-queue";
import { NAMES } from "@/editor/names";


/** This build's skill and default design system, as the bridge's resource names. */
function bridgeKnowledge(): BridgeKnowledge {
  const files: Record<string, string> = {};
  for (const [p, text] of Object.entries(SKILL_FILES)) if (p.endsWith(".md")) files[`skill/${p}`] = text;
  for (const [p, text] of Object.entries(DEFAULT_DESIGN_SYSTEM_FILES)) if (p.endsWith(".md")) files[`design/${p}`] = text;
  return { version: SKILL_VERSION, files };
}

/**
 * THE EXTERNAL-AGENT LINK — this tab, driven by an agent running elsewhere
 * (Claude Code, Codex, Gemini CLI, Cursor, VS Code, Claude Desktop — any MCP
 * client) through the product's MCP bridge (packages/mcp).
 *
 * The tab connects OUT to the bridge on 127.0.0.1 — a web page cannot listen.
 * The bridge trusts the app's own origins (the browser stamps `Origin`, and no
 * other site can forge it), so pairing is one click; a tab served from
 * anywhere else proves itself with the token the bridge printed.
 *
 * Once switched on, the link WAITS: it keeps knocking with a backoff, so
 * starting a session in your agent later links on its own. From then on every
 * MCP tool call runs through the same registry the built-in agent uses,
 * labelled with the client's name in the Undo menu. Nothing new to maintain:
 * a verb added to the registry reaches external agents the day it lands.
 *
 * The hub can MOVE (a newer bridge, or the user's takeover): the bridge says
 * `moved`, and the tab links again through the port on a NEW socket while
 * the old one stays open until the calls still running on it have answered.
 * So a handover never cuts a call short.
 */

const PORT = BRIDGE.port;
/** The bridge left this socket behind after a handover: link again at once. */
const MOVED = 4010;
/** Another tab holds the link, and this one only resumed: the person decides. */
const HELD = 4002;
const TOKEN_KEY = NAMES.storage.mcpToken;
/** Knock again after this long, doubling to the cap while nobody answers. */
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 15_000;

/** One tool call the external agent made — what the Agents panel shows while linked. */
export interface McpCall {
  id: string;
  name: string;
  input: unknown;
  status: "running" | "done" | "error";
  output?: { content: ToolOutputPart[]; isError: boolean };
  ms?: number;
  at: number;
}

/**
 * A TURN — a burst of calls from ONE agent session with no long pause in it,
 * which is what one request in the agent app looks like from here. Its writes
 * share one history key, so the whole turn is ONE undo step, the way the
 * built-in agent's replies are. Sessions sharing the link never share a turn.
 */
export interface McpTurn {
  key: string;
  label: string;
  /** The agent session that made it (a 3.x bridge does not say). */
  session?: string;
  /** Where that session runs — its folder — when several share the link. */
  where?: string;
  /** The project it worked on — the feed shows each project its own history. */
  projectId: string | null;
  calls: McpCall[];
  /** Calls dropped off the front of this turn by `MAX_CALLS_PER_TURN`. */
  earlier?: number;
}

/** A pause this long between calls starts a new turn. */
const TURN_GAP_MS = 20_000;
/**
 * THE FEED IS BOUNDED BY SIZE, not just by turns. A scripted session is ONE
 * turn of thousands of calls, so a turn cap alone bounded nothing: every call
 * kept its full payload and every render its base64 pixels, and each write
 * re-copied and re-saved the lot — a feed that cost more per call the longer
 * an agent worked. The document is the real record; the feed is a glance at
 * it, so it keeps what a glance needs:
 *  - the newest `MAX_CALLS_PER_TURN` calls of a turn (older ones counted);
 *  - inputs reduced to their labelling fields (`feedInput`);
 *  - output text capped, and render pixels only on the newest few calls.
 */
const MAX_TURNS = 40;
const MAX_CALLS_PER_TURN = 300;
const MAX_INPUT_CHARS = 2_000;
const MAX_TEXT_CHARS = 4_000;
const MAX_IMAGE_CALLS = 6;

interface McpState {
  /** `waiting` = switched on, knocking, no bridge answering yet. */
  status: "off" | "waiting" | "connecting" | "connected" | "error";
  client: string | null;
  error: string | null;
  calls: number;
  turns: McpTurn[];
  /** Every agent session sharing the link (empty from a 3.x bridge). */
  sessions: BridgeSession[];
}

export const useMcp = create<McpState>(() => ({ status: "off", client: null, error: null, calls: 0, turns: [], sessions: [] }));

type ToolOutputPart = { type: "text"; text: string } | { type: "image"; data: string; mediaType: string };

/** The turn a call starting now belongs to — its session's last one, unless that session paused. */
function turnFor(now: number, client: string, session: BridgeSession | undefined): McpTurn {
  const turns = useMcp.getState().turns;
  const last = turns.findLast((t) => t.session === session?.id);
  // A turn with no calls yet was opened a moment ago by a call still landing
  // — an agent's PARALLEL calls arrive in the same millisecond. Treating it
  // as over opened a second turn under the same time-based key.
  if (last && last.calls.length === 0) return last;
  const lastAt = last?.calls[last.calls.length - 1]?.at ?? 0;
  if (last && now - lastAt < TURN_GAP_MS) return last;
  const turn: McpTurn = {
    key: `mcp:${now.toString(36)}${session ? `:${session.id}` : ""}`,
    label: client,
    session: session?.id,
    where: session?.label || undefined,
    projectId: useAppShell.getState().currentProjectId,
    calls: [],
  };
  // A turn that is over keeps its record, not its pixels.
  useMcp.setState({ turns: [...turns.map(withoutImages), turn].slice(-MAX_TURNS) });
  return turn;
}

function patchCall(turnKey: string, callId: string, patch: Partial<McpCall> | McpCall) {
  const slim: Partial<McpCall> = { ...patch };
  if ("input" in patch) slim.input = feedInput(patch.input);
  if (patch.output) slim.output = { ...patch.output, content: patch.output.content.map(capText) };
  useMcp.setState((s) => {
    // Calls land on the newest turn; look there first rather than mapping all.
    const i = s.turns.findLastIndex((t) => t.key === turnKey);
    if (i < 0) return s;
    const t = s.turns[i]!;
    const at = t.calls.findLastIndex((c) => c.id === callId);
    let calls = at >= 0 ? t.calls.with(at, { ...t.calls[at]!, ...slim }) : [...t.calls, slim as McpCall];
    let earlier = t.earlier ?? 0;
    if (calls.length > MAX_CALLS_PER_TURN) {
      earlier += calls.length - MAX_CALLS_PER_TURN;
      calls = calls.slice(-MAX_CALLS_PER_TURN);
    }
    if (slim.output?.content.some((p) => p.type === "image")) calls = keepNewestImages(calls);
    const turns = s.turns.slice();
    turns[i] = { ...t, calls, earlier };
    return { turns };
  });
}

/**
 * An input as the feed keeps it: whole when small; otherwise its top-level
 * scalars (what a row's label is made of — a name, an id, a verb) with every
 * large value replaced by its size. The command already ran with the real
 * payload; the feed only has to say what it was.
 */
export function feedInput(input: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(input) ?? "";
  } catch {
    return "‹unserialisable›";
  }
  if (json.length <= MAX_INPUT_CHARS || input === null || typeof input !== "object" || Array.isArray(input)) {
    return json.length <= MAX_INPUT_CHARS ? input : `‹${Math.round(json.length / 1024)} KB›`;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (typeof v === "string" && v.length <= 200) out[k] = v;
    else {
      const size = (() => {
        try {
          return JSON.stringify(v)?.length ?? 0;
        } catch {
          return 0;
        }
      })();
      out[k] = `‹${size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`}›`;
    }
  }
  return out;
}

function capText(part: ToolOutputPart): ToolOutputPart {
  return part.type === "text" && part.text.length > MAX_TEXT_CHARS
    ? { type: "text", text: `${part.text.slice(0, MAX_TEXT_CHARS)}…` }
    : part;
}

/** Render pixels stay on the newest `MAX_IMAGE_CALLS` calls only. */
function keepNewestImages(calls: McpCall[]): McpCall[] {
  let seen = 0;
  let out = calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]!;
    if (!c.output?.content.some((p) => p.type === "image")) continue;
    if (++seen <= MAX_IMAGE_CALLS) continue;
    if (out === calls) out = calls.slice();
    out[i] = stripImages(c);
  }
  return out;
}

function stripImages(c: McpCall): McpCall {
  return c.output ? { ...c, output: { ...c.output, content: c.output.content.filter((p) => p.type === "text") } } : c;
}

function withoutImages(t: McpTurn): McpTurn {
  return t.calls.some((c) => c.output?.content.some((p) => p.type === "image")) ? { ...t, calls: t.calls.map(stripImages) } : t;
}

// ── The feed survives a reload ───────────────────────────────────────────────
//
// It is a record of what an agent did to your projects, and a reload (every
// update is one) used to wipe it. Kept in the agent's own IndexedDB, WITHOUT
// the renders' pixels — a feed of a few dozen requests stays a few KB. The
// per-request undo does not come back with it, and should not: the history it
// rewinds did not survive the reload either.

const FEED_KEY = "mcp-feed";
let saveTimer = 0;

function saveFeed() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const turns = useMcp.getState().turns.map((t) => ({
      ...t,
      calls: t.calls
        .filter((c) => c.status !== "running")
        .map(stripImages),
    }));
    void dbPut("kv", FEED_KEY, turns).catch(() => {});
  }, 800);
}

let feedLoaded = false;
/** Once per session: bring back what agents did before this reload. */
export function loadFeed(): void {
  if (feedLoaded) return;
  feedLoaded = true;
  void dbGet<McpTurn[]>("kv", FEED_KEY)
    .then((saved) => {
      if (!saved?.length) return;
      // Anything that arrived while this was loading goes AFTER the saved past.
      useMcp.setState((s) => ({ turns: [...saved, ...s.turns].slice(-MAX_TURNS) }));
    })
    .catch(() => {});
}

let socket: WebSocket | null = null;

/**
 * Calls running for the bridge: id → their abort and the socket they came on.
 * The bridge cancels a call its agent gave up on (or went too long without
 * hearing from), and a socket that closes takes its calls with it — nobody is
 * left to collect them. An export is a job, not a call, and outlives both.
 */
const running = new Map<string, { abort: AbortController; ws: WebSocket }>();
/** A file sent to the bridge, waiting to hear it is on disk: transfer id → resolve, and the socket it went on. */
const filing = new Map<string, Filing>();
interface Filing {
  done: (r: { path?: string; error?: string }) => void;
  ws: WebSocket;
  /** The highest chunk the bridge has acknowledged. */
  acked: number;
  /** Wakes the sender when an ack (or the end) arrives. */
  wake: (() => void) | null;
}
let fileSeq = 0;
/** Sockets left behind by a handover, open until their running calls answer. */
const draining = new Set<WebSocket>();
/** The bridge writes files to disk (3.7+). An older one would leave a delivery waiting forever, so it is not offered one. */
let bridgeTakesFiles = false;
/** The bridge acknowledges every chunk (3.9+): the sender is paced by messages, not by timers. */
let bridgeAcksChunks = false;
/** Chunks in flight before the sender waits for an ack — enough to keep the socket busy. */
const ACK_WINDOW = 2;

function send(ws: WebSocket, msg: EditorToBridge): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The live link, waiting out a handover or a reconnect (the tab knocks within seconds). */
async function linkedSocket(withinMs = 30_000): Promise<WebSocket> {
  const until = Date.now() + withinMs;
  for (;;) {
    const ws = socket;
    if (ws?.readyState === WebSocket.OPEN && useMcp.getState().status === "connected") return ws;
    if (Date.now() > until || !wanted) throw new Error("The agent's bridge was not linked when the file was ready.");
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Hand a file to the session that asked for it, in chunks; resolves to where
 * it landed on the agent's machine. Addressed to the SESSION, over whichever
 * socket is live when it is ready — an export job finishes long after its
 * call, maybe after the hub moved — and that session's own bridge writes it.
 */
async function deliverToSession(sessionId: string | undefined, file: DeliveredFile): Promise<string> {
  const ws = await linkedSocket();
  if (!bridgeTakesFiles) throw new Error(`The agent's bridge cannot write files (before ${BRIDGE.package} 3.7).`);
  const id = `f${++fileSeq}-${Date.now().toString(36)}`;
  const entry: Filing = { done: () => {}, ws, acked: -1, wake: null };
  const landed = new Promise<{ path?: string; error?: string }>((resolve) => {
    entry.done = (r) => {
      resolve(r);
      entry.wake?.();
    };
  });
  filing.set(id, entry);
  const acks = bridgeAcksChunks;
  const chunks = Math.max(1, Math.ceil(file.bytes.length / FILE_CHUNK_BYTES));
  for (let seq = 0; seq < chunks; seq++) {
    // Answered early (the bridge could not write it): sending the rest would start a stray file.
    if (!filing.has(id)) break;
    if (ws.readyState !== WebSocket.OPEN) throw new Error("The agent's bridge closed before the file arrived.");
    const data = base64(file.bytes.subarray(seq * FILE_CHUNK_BYTES, (seq + 1) * FILE_CHUNK_BYTES));
    send(ws, { kind: "file", id, session: sessionId, path: file.path, name: file.name, seq, data, last: seq === chunks - 1 });
    if (acks) {
      // Paced by the bridge's acks — messages, which a hidden tab never
      // throttles. A timer poll here stalled a background pane's export for
      // minutes at the socket's 32 MB buffer.
      while (seq - entry.acked >= ACK_WINDOW && filing.has(id) && ws.readyState === WebSocket.OPEN) {
        await new Promise<void>((r) => (entry.wake = r));
        entry.wake = null;
      }
    } else {
      // A bridge before 3.9: let the socket drain between chunks.
      while (ws.bufferedAmount > FILE_CHUNK_BYTES) await new Promise((r) => setTimeout(r, 20));
    }
  }
  const r = await landed;
  filing.delete(id);
  if (r.error || !r.path) throw new Error(r.error ?? "The bridge did not save the file.");
  return r.path;
}
let retry = 0;
let retryMs = RETRY_MIN_MS;
/** The link is ON (the user asked for it) — independent of whether a bridge is up. */
let wanted = false;
/**
 * How the next hello asks for the link: "user" = the person pressed Link here
 * (it moves the link to this tab), "resume" = this tab knocking on its own (at
 * load, after a drop), which the hub grants only when no other tab holds it.
 */
let claim: "user" | "resume" = "resume";

/**
 * This tab, across its own reloads and no other's — sessionStorage is per tab
 * and survives a reload. The hub gives a reloading tab its link back by it.
 */
const TAB_ID_KEY = NAMES.storage.tabId;
function tabId(): string {
  try {
    let id = sessionStorage.getItem(TAB_ID_KEY);
    if (!id) {
      id = `tab_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem(TAB_ID_KEY, id);
    }
    return id;
  } catch {
    return "tab_unstored";
  }
}

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k) ?? "";
    } catch {
      return "";
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* storage blocked — the link still works for this session */
    }
  },
};

export const savedToken = (): string => store.get(TOKEN_KEY);

/** What an MCP client calls itself (`clientInfo.name`) → the app's name a person knows. */
export function agentAppName(client: string | null): string {
  const c = (client ?? "").toLowerCase();
  if (!c) return "your agent app";
  if (c.includes("claude-code") || c === "claude code") return "Claude Code";
  if (c.includes("claude")) return "Claude Desktop";
  if (c.includes("codex")) return "Codex";
  if (c.includes("gemini")) return "Gemini CLI";
  if (c.includes("cursor")) return "Cursor";
  if (c.includes("visual studio code") || c.includes("vscode")) return "VS Code";
  if (c.includes("windsurf")) return "Windsurf";
  return client!;
}

/** The provider mark that stands for an agent app, when it has one. */
export function agentAppMark(client: string | null): string | null {
  const n = agentAppName(client);
  return n.startsWith("Claude") ? "anthropic" : n === "Codex" ? "openai" : n === "Gemini CLI" ? "google" : null;
}

/** Switch the link on and keep it on across reloads. `token` is only needed off the app's own origins. */
export function connectMcp(token = savedToken()): void {
  store.set(TOKEN_KEY, token || null);
  store.set(AUTO_LINK_KEY, "1");
  wanted = true;
  claim = "user";
  retryMs = RETRY_MIN_MS;
  open(token);
}

/** Switch it off, and stop re-linking on the next load. */
export function disconnectMcp(): void {
  store.set(AUTO_LINK_KEY, null);
  wanted = false;
  close();
  useMcp.setState({ status: "off", client: null, error: null, sessions: [] });
}

/** Boot: resume a link the user switched on in an earlier session, quietly. */
export function resumeMcp(): void {
  if (wanted || socket) return;
  wanted = true;
  open(savedToken());
}

function close() {
  window.clearTimeout(retry);
  const ws = socket;
  socket = null;
  ws?.close();
}

function scheduleRetry(token: string) {
  window.clearTimeout(retry);
  if (!wanted) return;
  retry = window.setTimeout(() => open(token), retryMs);
  retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
}

/** A hidden tab renders slowly; the bridge tells the agent so (the bridge's status verb). */
let watchingVisibility = false;
function watchVisibility() {
  if (watchingVisibility) return;
  watchingVisibility = true;
  document.addEventListener("visibilitychange", sendState);
  // An export starting or ending is state too: the hub must not move under one.
  let wasRendering = renderLineBusy();
  renderJobs.subscribe(() => {
    const now = renderLineBusy();
    if (now === wasRendering) return;
    wasRendering = now;
    sendState();
  });
}

function sendState() {
  if (socket) send(socket, { kind: "state", visible: document.visibilityState === "visible", rendering: renderLineBusy() });
}

/** Link again through the port, leaving `ws` open for the calls still running on it. */
function follow(ws: WebSocket, token: string) {
  if (socket !== ws) return;
  socket = null;
  draining.add(ws);
  retireIfIdle(ws);
  open(token);
}

/** A drained socket closes once its last call has answered. */
function retireIfIdle(ws: WebSocket) {
  if (!draining.has(ws)) return;
  if ([...running.values()].some((r) => r.ws === ws) || [...filing.values()].some((f) => f.ws === ws)) return;
  draining.delete(ws);
  ws.close(1000, "moved");
}

function open(token: string): void {
  close();
  watchVisibility();
  if (useMcp.getState().status !== "waiting") useMcp.setState({ status: "connecting", error: null });
  let ws: WebSocket;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  } catch {
    useMcp.setState({ status: "error", error: "This browser refused to reach your computer's agent bridge." });
    return;
  }
  socket = ws;
  let opened = false;
  ws.onopen = () => {
    opened = true;
    // The registry's verbs plus `report_issue`, which the skill tells every
    // agent to use — an agent app's reports land in the same Reports view and
    // collector as the built-in chat's, tagged with the app (`provider: "mcp"`).
    const tools = [
      ...agentApi()
        .toolSpecs()
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      { name: REPORT_TOOL.name, description: REPORT_TOOL.description, inputSchema: REPORT_TOOL.inputSchema },
    ];
    const hello: EditorToBridge = {
      kind: "hello",
      token,
      app: `${identity.name} ${APP_VERSION}`,
      tools,
      knowledge: bridgeKnowledge(),
      bridge: mcpPackage.version,
      features: ["moved"],
      origin: location.origin,
      dev: process.env.NODE_ENV !== "production",
      visible: document.visibilityState === "visible",
      tab: tabId(),
      claim,
    };
    ws.send(JSON.stringify(hello));
  };
  ws.onmessage = async (e) => {
    const msg = JSON.parse(String(e.data)) as BridgeToEditor;
    if (msg.kind === "welcome") {
      retryMs = RETRY_MIN_MS;
      // Held now: from here on this tab only ever RESUMES its own link.
      claim = "resume";
      bridgeTakesFiles = msg.features?.includes("files") ?? false;
      bridgeAcksChunks = msg.features?.includes("acks") ?? false;
      useMcp.setState({ status: "connected", client: msg.client, error: null });
      // A hub only learns what the tab is doing from `state`: a link made
      // mid-export (a re-link after `moved`) says so at once.
      sendState();
      return;
    }
    if (msg.kind === "sessions") {
      useMcp.setState({ sessions: msg.sessions });
      return;
    }
    if (msg.kind === "cancel") {
      running.get(msg.id)?.abort.abort();
      return;
    }
    if (msg.kind === "ack") {
      const f = filing.get(msg.id);
      if (f) {
        f.acked = Math.max(f.acked, msg.seq);
        f.wake?.();
      }
      return;
    }
    if (msg.kind === "filed") {
      const f = filing.get(msg.id);
      filing.delete(msg.id);
      f?.done(msg);
      retireIfIdle(ws);
      return;
    }
    if (msg.kind === "moved") {
      follow(ws, token);
      return;
    }
    if (msg.kind !== "call") return;
    const doc = getDocStore();
    if (!doc) return;
    const client = agentAppName(msg.session?.client ?? useMcp.getState().client);
    const feedbackContext = { provider: "mcp", model: client };
    if (msg.name === REPORT_TOOL.name) {
      recordFeedback({ ...(msg.input as Omit<ReportBody, "kind">), kind: "report" }, feedbackContext);
      const reply: EditorToBridge = { kind: "result", id: msg.id, content: [{ type: "text", text: "Reported. Thank you — carry on with what you can do." }] };
      ws.send(JSON.stringify(reply));
      return;
    }
    // Agent control is Pro — the same seam as the built-in chat.
    if (!requireFeature("agents")) {
      const reply: EditorToBridge = { kind: "result", id: msg.id, content: [{ type: "text", text: product.entitlements.refusal("agents", "Driving the editor from an agent") }], isError: true };
      ws.send(JSON.stringify(reply));
      return;
    }
    const commandId = agentApi().toolSpecs().find((t) => t.name === msg.name)?.commandId ?? msg.name;
    const started = Date.now();
    const turn = turnFor(started, client, msg.session);
    patchCall(turn.key, msg.id, { id: msg.id, name: msg.name, input: msg.input, status: "running", at: started });
    const abort = new AbortController();
    running.set(msg.id, { abort, ws });
    const sessionId = msg.session?.id;
    const res = await callCommand(commandId, msg.input, {
      store: doc,
      actor: client,
      historyKey: turn.key,
      historyLabel: "request",
      session: editorApiSession(),
      signal: abort.signal,
      caller: sessionId,
      progress: (text) => send(ws, { kind: "progress", id: msg.id, text }),
      ...(bridgeTakesFiles ? { deliver: (file: DeliveredFile) => deliverToSession(sessionId, file) } : {}),
    }).finally(() => running.delete(msg.id));
    useMcp.setState((s) => ({ calls: s.calls + 1 }));
    // A cancelled call failed because the agent asked it to — not feedback.
    if (!res.ok && res.kind !== "input" && !abort.signal.aborted) recordFeedback({ kind: "implicit", signal: "command-failed", command: commandId, error: res.error }, feedbackContext);
    const parts: ToolOutputPart[] = res.ok
      ? toOutput(res.value).map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "image", data: c.data, mediaType: c.mediaType }))
      : [{ type: "text", text: `Error: ${res.error}${res.hint ? `\nHint: ${res.hint}` : ""}` }];
    patchCall(turn.key, msg.id, { status: res.ok ? "done" : "error", output: { content: parts, isError: !res.ok }, ms: Date.now() - started });
    saveFeed();
    const content: BridgeContent[] = parts.map((c) => (c.type === "text" ? c : { type: "image", data: c.data, mimeType: c.mediaType }));
    const reply: EditorToBridge = { kind: "result", id: msg.id, content, isError: !res.ok };
    send(ws, reply);
    retireIfIdle(ws);
  };
  ws.onclose = (e) => {
    draining.delete(ws);
    for (const r of running.values()) if (r.ws === ws) r.abort.abort();
    for (const [id, f] of filing) {
      if (f.ws !== ws) continue;
      filing.delete(id);
      f.done({ error: "The agent's bridge closed before the file arrived." });
    }
    if (socket !== ws) return;
    socket = null;
    // 4001: the bridge wants a token this tab does not have — knocking again cannot help.
    if (e.code === 4001) {
      wanted = false;
      useMcp.setState({ status: "error", client: null, error: token ? "The pairing token did not match." : "Your agent's bridge asked for its pairing token." });
      return;
    }
    // 4002: this tab knocked on its own while another holds the link (or is
    // reloading). Only the person's Link moves it — never a background retry.
    if (e.code === HELD) {
      wanted = false;
      useMcp.setState({ status: "off", client: null, error: `Another ${identity.name} tab holds the link. Press Link to use this one.` });
      return;
    }
    // 4000: another tab of the app took the link. Two tabs taking it back from each other forever is worse than one waiting.
    if (e.code === 4000) {
      wanted = false;
      useMcp.setState({ status: "off", client: null, error: `Another ${identity.name} tab took over the link.` });
      return;
    }
    // Nobody listening yet (or the hub's session ended and another takes over): wait for the next one.
    useMcp.setState({ status: "waiting", client: null, sessions: [], error: opened ? null : useMcp.getState().error });
    if (e.code === MOVED) retryMs = 250;
    scheduleRetry(token);
  };
}
