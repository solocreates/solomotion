"use client";

import { identity } from "@/editor/identity";
import {
  createCommandApi,
  frameDurationMs,
  locateClip,
  type CommandContext,
  type CommandRegistry,
} from "@solomotion/core";
import {
  buildSystemPrompt,
  DELEGATE_TOOL,
  DELEGATE_TOOL_NAME,
  packFromFiles,
  readPackFile,
  runAgent,
  runDelegate,
  SKILL_READ_TOOL,
  chatModels,
  contextWindowOf,
  providerDef,
  type AgentEvent,
  type MediaCapability,
  connectionModels,
  type Connection,
  type ImagePart,
  type KnowledgePack,
  type Message,
  type Part,
  type ReportBody,
  type TextPart,
  type ToolCallPart,
  type ToolDef,
  type ToolOutput,
  type DialectAdapter,
  type ScriptedTurn,
  scriptedDialect,
} from "@solomotion/agent";
import { SKILL_FILES, DEFAULT_DESIGN_SYSTEM_FILES, SKILL_VERSION } from "./bridge";
import { getDocStore } from "../state/document-context";
import { callCommand } from "./call";
import { editorApiSession, useSession } from "../state/session";
import { useAppShell } from "../state/app-shell";
import { hostCommands, isApiImage } from "./host-commands";
import { scriptRunCommands } from "../scripts/host";
import { worldImportModel } from "../world/import-command";
import { AGENT_IDENTITY } from "./identity";
import { recordFeedback, REPORT_TOOL } from "./feedback";
import { requireFeature } from "../entitlements";
import { connectionOf, useAgent, type Chat, type LiveRun } from "./store";
import { ENGINE, NAMES } from "@/editor/names";

/**
 * THE RUNNER — where a chat meets the runtime and the registry.
 *
 * It owns the pieces only the editor has: the document store and session the
 * commands act on, the knowledge packs the prompt is built from, the live
 * view the chat renders, and the signals the feedback loop needs (a failed
 * command, a stopped run, an AI turn the user undid). Everything else —
 * streaming, retries, parallel reads, steering, sub-agents — is `runAgent`'s.
 */

// ── The API, once ────────────────────────────────────────────────────────────

let api: CommandRegistry | null = null;

export function agentApi(): CommandRegistry {
  if (api) return api;
  api = createCommandApi(ENGINE);
  api.register(...hostCommands({ connectionFor, modelFor }), ...scriptRunCommands(agentApi), worldImportModel);
  return api;
}

/** The connection that serves a media job: the user's route, else the first capable one. */
export function connectionFor(capability: MediaCapability): Connection | null {
  const { connections, settings } = useAgent.getState();
  const routed = settings.routes[capability];
  const capable = (c: Connection) => providerDef(c.providerId)?.capabilities.includes(capability);
  return connections.find((c) => c.id === routed && capable(c)) ?? connections.find(capable) ?? null;
}

/** A model the user pinned for a media job, when it belongs to the connection serving it. */
function modelFor(capability: MediaCapability): string | undefined {
  const pinned = useAgent.getState().settings.routeModels?.[capability];
  const c = connectionFor(capability);
  return pinned && c && connectionModels(c).some((m) => m.id === pinned) ? pinned : undefined;
}

// ── Knowledge ────────────────────────────────────────────────────────────────

export const BUILTIN_SKILL_ID = NAMES.ids.builtinSkill;
export const BUILTIN_DESIGN_ID = NAMES.ids.builtinDesign;

let builtins: KnowledgePack[] | null = null;

/** The skill and design system that ship with the app. Always present; the user can switch them off. */
export function builtinPacks(): KnowledgePack[] {
  if (builtins) return builtins;
  // A built-in that failed to bundle must not take the chat down with it.
  const make = (id: string, kind: "skill" | "design-system", files: Record<string, string>, name: string, version?: string) => {
    if (!Object.keys(files).length) return [];
    return [{ ...packFromFiles(kind, files, { type: "builtin" }, name), id, ...(version ? { version } : {}) }];
  };
  builtins = [
    ...make(BUILTIN_SKILL_ID, "skill", SKILL_FILES, identity.name, SKILL_VERSION),
    ...make(BUILTIN_DESIGN_ID, "design-system", DEFAULT_DESIGN_SYSTEM_FILES, `${identity.name} Default`),
  ];
  return builtins;
}

/**
 * Every pack the agent knows, with the user's on/off choices applied. A view
 * passes the `packs` and `disabledPacks` it subscribed to; everyone else gets
 * the live store's.
 */
export function allPacks(
  packs: KnowledgePack[] = useAgent.getState().packs,
  disabledPacks: string[] = useAgent.getState().settings.disabledPacks,
): KnowledgePack[] {
  const off = new Set(disabledPacks);
  return [...builtinPacks(), ...packs].map((p) => ({ ...p, enabled: p.enabled && !off.has(p.id) }));
}

// ── Tools ────────────────────────────────────────────────────────────────────

function toolDefs(): ToolDef[] {
  const commands = agentApi()
    .toolSpecs()
    .map<ToolDef>((s) => ({ name: s.name, description: s.description, inputSchema: s.inputSchema, effect: s.effect }));
  return [...commands, SKILL_READ_TOOL, REPORT_TOOL, DELEGATE_TOOL];
}

const MAX_RESULT_CHARS = 24_000;

/** A command's JSON result as model-facing content: images become image parts, the rest compact JSON. */
export function toOutput(value: unknown): ToolOutput["content"] {
  const images: ImagePart[] = [];
  const strip = (v: unknown): unknown => {
    if (isApiImage(v)) {
      images.push({ type: "image", mediaType: v.$image.mediaType, data: v.$image.data });
      const { $image, ...rest } = v as unknown as Record<string, unknown> & { $image: { width: number; height: number } };
      return { ...rest, image: `${$image.width}×${$image.height} (attached)` };
    }
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]));
    return v;
  };
  const json = typeof value === "string" ? value : JSON.stringify(strip(value));
  const text = json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS)}… [truncated ${json.length - MAX_RESULT_CHARS} chars — narrow the request]` : json;
  return [{ type: "text", text }, ...images];
}

// ── Editor context ───────────────────────────────────────────────────────────

/** A few lines of where the user is, attached to each message they send. Never in the system prompt (it would break the cache). */
function editorContext(): TextPart | null {
  const store = getDocStore();
  if (!store) return null;
  const doc = store.getState();
  const s = useSession.getState();
  const frame = doc.frames.find((f) => f.id === s.activeFrameId) ?? doc.frames[0];
  const sel = s.selectedClipIds
    .map((id) => locateClip(doc, id)?.clip)
    .filter(Boolean)
    .slice(0, 12)
    .map((c) => `${c!.id} "${c!.name}" (${c!.kind})`);
  const lines = [
    `project: "${doc.name}"`,
    frame
      ? `comp: ${frame.id} "${frame.name}" ${frame.width}×${frame.height} @${frame.fps}fps, ${Math.round(frameDurationMs(doc, frame))}ms`
      : "no comps",
    `playhead: ${Math.round(s.playheadMs)}ms`,
    `selected: ${sel.length ? sel.join(", ") : "nothing"}`,
  ];
  return { type: "text", text: `<editor>\n${lines.join("\n")}\n</editor>`, synthetic: true };
}

// ── Running ──────────────────────────────────────────────────────────────────

let controller: AbortController | null = null;
/** Set only by a rehearsal (dev): the model is a script, everything else is real. */
let dialectOverride: DialectAdapter | null = null;
let flushHandle = 0;
let pending: Array<(live: LiveRun) => void> = [];

/** Apply live mutations at most once per frame — streaming tokens arrive far faster than a screen can show them. */
function mutateLive(fn: (live: LiveRun) => void) {
  pending.push(fn);
  if (flushHandle) return;
  flushHandle = requestAnimationFrame(() => {
    flushHandle = 0;
    const batch = pending;
    pending = [];
    useAgent.getState().setLive((prev) => {
      if (!prev) return prev;
      const next: LiveRun = { ...prev, calls: { ...prev.calls }, callOrder: [...prev.callOrder] };
      for (const f of batch) f(next);
      return next;
    });
  });
}

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 48 ? `${line.slice(0, 46)}…` : line || "New chat";
}

export function isRunning(): boolean {
  return useAgent.getState().live?.status === "running";
}

/**
 * Send a message. While a run is in flight it is QUEUED instead — the runtime
 * folds it in at the next step, so the user can steer without stopping.
 */
export async function sendMessage(parts: Part[]): Promise<void> {
  const state = useAgent.getState();
  const text = parts.filter((p): p is TextPart => p.type === "text").map((p) => p.text).join(" ");
  const message: Message = { id: `m_${Date.now().toString(36)}u`, role: "user", parts, createdAt: Date.now() };

  if (state.live && state.live.status === "running") {
    const ctx = editorContext();
    const queued = { ...message, parts: ctx ? [ctx, ...parts] : parts };
    useAgent.getState().setLive((prev) => (prev ? { ...prev, queued: [...prev.queued, queued] } : prev));
    return;
  }

  // AI is a Pro feature. The panel, setup and history stay browsable on the
  // free tier; sending is the one seam that asks. A rehearsal is not a sale.
  if (!dialectOverride && !requireFeature("agents")) return;

  let chat: Chat = state.chat ?? state.newChat(useAppShell.getState().currentProjectId);
  const connection = connectionOf(state, chat);
  if (!connection) {
    useAgent.getState().setSetupOpen(true);
    return;
  }
  const model = chat.model && chatModels(connection).some((m) => m.id === chat.model) ? chat.model : (chat.model ?? connection.defaultModel ?? chatModels(connection)[0]?.id);
  if (!model) {
    useAgent.getState().setSetupOpen(true);
    return;
  }

  useAgent.getState().setLastError(null);
  const ctx = editorContext();
  const sent: Message = { ...message, parts: ctx ? [ctx, ...parts] : parts };
  chat = {
    ...chat,
    connectionId: connection.id,
    model,
    title: chat.messages.length ? chat.title : titleFrom(text),
    messages: [...chat.messages, sent],
    updatedAt: Date.now(),
  };
  await useAgent.getState().saveChat(chat);
  await run(chat, connection, model, titleFrom(text));
}

export function stopRun(): void {
  if (!controller) return;
  useAgent.getState().setLive((prev) => (prev ? { ...prev, status: "stopping" } : prev));
  controller.abort();
}

async function run(chat: Chat, connection: Connection, model: string, label: string): Promise<void> {
  const store = getDocStore();
  if (!store) return;
  controller = new AbortController();
  const signal = controller.signal;
  const historyKey = `agent:${chat.id}:${Date.now().toString(36)}`;
  const historyLabel = label.length > 32 ? `${label.slice(0, 30)}…` : label;
  const packs = allPacks();
  const system = buildSystemPrompt({ identity: AGENT_IDENTITY, packs, instructions: useAgent.getState().settings.instructions });
  const tools = toolDefs();
  const byName = new Map(agentApi().toolSpecs().map((s) => [s.name, s.commandId] as const));

  useAgent.getState().setLive({
    chatId: chat.id,
    startedAt: Date.now(),
    status: "running",
    text: "",
    thinking: "",
    thinkingStartedAt: null,
    thinkingMs: 0,
    calls: {},
    callOrder: [],
    inputTokens: 0,
    outputTokens: 0,
    streamedChars: 0,
    contextTokens: chat.contextTokens,
    contextWindow: contextWindowOf(connection, model),
    retry: null,
    notice: null,
    queued: [],
    historyKey,
  });

  const commandContext: CommandContext = {
    store,
    actor: "AI",
    historyKey,
    historyLabel,
    signal,
    session: editorApiSession(),
  };
  const feedbackContext = { provider: connection.providerId, model };
  const effort = useAgent.getState().settings.effort;

  const execute = async (call: ToolCallPart, execCtx: { signal: AbortSignal; emit: (e: AgentEvent) => void }): Promise<ToolOutput> => {
    if (call.name === SKILL_READ_TOOL.name) {
      const input = (call.input ?? {}) as { pack?: string; path?: string };
      try {
        return { content: [{ type: "text", text: readPackFile(packs, input.pack ?? "", input.path ?? "") }] };
      } catch (err) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    }
    if (call.name === REPORT_TOOL.name) {
      const body = { ...(call.input as Omit<ReportBody, "kind">), kind: "report" as const };
      recordFeedback(body, feedbackContext);
      return { content: [{ type: "text", text: "Reported. Thank you — carry on with what you can do." }] };
    }
    if (call.name === DELEGATE_TOOL_NAME) {
      return runDelegate(call, execCtx, {
        parent: { connection, model, system, tools, execute, effort: "medium" },
        system,
      });
    }
    const commandId = byName.get(call.name) ?? call.name;
    const res = await callCommand(commandId, call.input, {
      ...commandContext,
      progress: (text) => execCtx.emit({ type: "tool_progress", id: call.id, text }),
    });
    if (res.ok) return { content: toOutput(res.value) };
    if (res.kind !== "input") recordFeedback({ kind: "implicit", signal: "command-failed", command: commandId, error: res.error }, feedbackContext);
    return { content: [{ type: "text", text: `Error: ${res.error}${res.hint ? `\nHint: ${res.hint}` : ""}` }], isError: true };
  };

  let messages = chat.messages;
  const result = await runAgent({
    connection,
    model,
    system,
    dialect: dialectOverride ?? undefined,
    history: chat.messages,
    tools,
    execute,
    signal,
    effort,
    drainSteering: () => {
      const live = useAgent.getState().live;
      if (!live?.queued.length) return [];
      const q = live.queued;
      useAgent.getState().setLive((prev) => (prev ? { ...prev, queued: [] } : prev));
      return q;
    },
    onEvent: (e) => onEvent(e, (m) => {
      messages = [...messages, m];
      const current = useAgent.getState().chat;
      const next: Chat = { ...(current?.id === chat.id ? current : chat), messages, updatedAt: Date.now() };
      void useAgent.getState().saveChat(next);
    }),
  });

  if (result.reason === "stopped") recordFeedback({ kind: "implicit", signal: "stopped" }, feedbackContext);
  if (result.reason === "refusal") recordFeedback({ kind: "implicit", signal: "refusal" }, feedbackContext);
  if (result.reason === "error" && /busy after 10 tries/.test(result.error ?? "")) {
    recordFeedback({ kind: "implicit", signal: "retries-exhausted", error: result.error }, feedbackContext);
  }

  const live = useAgent.getState().live;
  const current = useAgent.getState().chat;
  const base = current?.id === chat.id ? current : chat;
  // A request that changed the document gets a checkpoint on its last reply.
  const lastReply = [...messages].reverse().find((m) => m.role === "assistant");
  const wrote = store.undoDepthOf(historyKey) !== null;
  const finalChat: Chat = {
    ...base,
    ...(wrote && lastReply ? { checkpoints: { ...base.checkpoints, [lastReply.id]: { key: historyKey, label: historyLabel } } } : {}),
    messages,
    usage: {
      inputTokens: chat.usage.inputTokens + result.usage.inputTokens,
      outputTokens: chat.usage.outputTokens + result.usage.outputTokens,
      cacheReadTokens: (chat.usage.cacheReadTokens ?? 0) + (result.usage.cacheReadTokens ?? 0),
    },
    contextTokens: live?.contextTokens ?? chat.contextTokens,
    updatedAt: Date.now(),
  };
  await useAgent.getState().saveChat(finalChat);
  controller = null;
  if (armed) {
    armed = false;
    dialectOverride = null;
  }
  const leftover = live?.queued ?? [];
  useAgent.getState().setLive(null);
  if (result.reason === "error" && result.error) useAgent.getState().setLastError({ chatId: chat.id, text: result.error });
  if (result.reason === "max_steps" && result.error) useAgent.getState().setLastError({ chatId: chat.id, text: result.error });
  watchForUndo(historyLabel, feedbackContext);
  // Messages queued after the model's final step still deserve an answer.
  if (leftover.length && result.reason === "end") {
    const again = { ...finalChat, messages: [...finalChat.messages, ...leftover] };
    await useAgent.getState().saveChat(again);
    await run(again, connection, model, label);
  }
}

function onEvent(e: AgentEvent, commit: (m: Message) => void): void {
  switch (e.type) {
    case "text":
      mutateLive((l) => {
        if (l.thinkingStartedAt) {
          l.thinkingMs += Date.now() - l.thinkingStartedAt;
          l.thinkingStartedAt = null;
        }
        l.text += e.delta;
        l.streamedChars += e.delta.length;
        l.retry = null;
      });
      break;
    case "thinking":
      mutateLive((l) => {
        l.thinkingStartedAt ??= Date.now();
        l.thinking += e.delta;
        l.streamedChars += e.delta.length;
        l.retry = null;
      });
      break;
    case "tool_call_start":
      mutateLive((l) => {
        l.calls[e.id] = { id: e.id, name: e.name, partialJson: "", status: "streaming" };
        if (!l.callOrder.includes(e.id)) l.callOrder.push(e.id);
      });
      break;
    case "tool_call_delta":
      mutateLive((l) => {
        const c = l.calls[e.id];
        if (c) l.calls[e.id] = { ...c, partialJson: c.partialJson + e.partialJson };
        l.streamedChars += e.partialJson.length;
      });
      break;
    case "tool_running":
      mutateLive((l) => {
        const c = l.calls[e.id] ?? { id: e.id, name: e.name, partialJson: "", status: "running" as const };
        l.calls[e.id] = { ...c, input: e.input, status: "running" };
        if (!l.callOrder.includes(e.id)) l.callOrder.push(e.id);
      });
      break;
    case "tool_progress":
      mutateLive((l) => {
        const c = l.calls[e.id];
        if (c) l.calls[e.id] = { ...c, progress: e.text };
      });
      break;
    case "tool_result":
      mutateLive((l) => {
        const c = l.calls[e.id];
        if (c) l.calls[e.id] = { ...c, status: e.output.isError ? "error" : "done", output: e.output, ms: e.ms };
      });
      break;
    case "subagent":
      mutateLive((l) => {
        // Nest the sub-agent's trail under the delegate call that spawned it (the running one).
        const host = [...l.callOrder].reverse().map((id) => l.calls[id]).find((c) => c?.name === DELEGATE_TOOL_NAME && c.status === "running");
        if (!host) return;
        const sub = host.sub ?? { label: e.label, text: "", tools: [] };
        const inner = e.event;
        if (inner.type === "text") sub.text += inner.delta;
        if (inner.type === "tool_running") sub.tools = [...sub.tools, { id: inner.id, name: inner.name, status: "running" }];
        if (inner.type === "tool_result") sub.tools = sub.tools.map((t) => (t.id === inner.id ? { ...t, status: inner.output.isError ? "error" : "done" } : t));
        l.calls[host.id] = { ...host, sub: { ...sub } };
      });
      break;
    case "message":
      commit(e.message);
      if (e.message.role === "assistant") {
        mutateLive((l) => {
          if (l.thinkingStartedAt) {
            l.thinkingMs += Date.now() - l.thinkingStartedAt;
            l.thinkingStartedAt = null;
          }
          // Stamp the measured thinking time onto the committed message.
          const think = e.message.parts.find((p) => p.type === "thinking");
          if (think && think.type === "thinking") think.durationMs = l.thinkingMs;
          l.text = "";
          l.thinking = "";
          l.thinkingMs = 0;
          l.streamedChars = 0;
        });
      } else if (e.message.parts.some((p) => p.type === "tool_result")) {
        mutateLive((l) => {
          l.calls = {};
          l.callOrder = [];
        });
      }
      break;
    case "attempt_reset":
      mutateLive((l) => {
        l.text = "";
        l.thinking = "";
        l.calls = {};
        l.callOrder = [];
        l.streamedChars = 0;
      });
      break;
    case "usage":
      mutateLive((l) => {
        l.inputTokens = e.total.inputTokens;
        l.outputTokens = e.total.outputTokens;
        l.contextTokens = e.contextTokens;
        l.contextWindow = e.contextWindow;
      });
      break;
    case "retry":
      mutateLive((l) => (l.retry = { ...e.info, until: Date.now() + e.info.delayMs }));
      break;
    case "notice":
      mutateLive((l) => (l.notice = { level: e.level, text: e.text }));
      break;
    case "done":
      if (e.error) mutateLive((l) => (l.notice = { level: "error", text: e.error! }));
      break;
  }
}

/**
 * If the user undoes the AI's turn, that is the strongest signal there is. The
 * store tells us through its redo label: the moment the top redo entry is this
 * turn, it was undone.
 */
function watchForUndo(label: string, context: { provider: string; model: string }): void {
  const store = getDocStore();
  if (!store) return;
  const full = `AI · ${label}`;
  if (store.peekUndoLabel() !== full) return;
  const unsub = store.subscribe(() => {
    if (store.peekRedoLabel() === full) {
      recordFeedback({ kind: "implicit", signal: "undo-turn" }, context);
      unsub();
    } else if (store.peekUndoLabel() !== full && store.peekRedoLabel() !== full) unsub();
  });
}

/**
 * Arm a rehearsal: the NEXT message the user sends — typed in the composer,
 * like any other — runs on this script. Development only; used to record the
 * product doing real work.
 */
export async function armRehearsal(turns: Array<ScriptedTurn | ((req: Parameters<DialectAdapter["run"]>[0]) => ScriptedTurn)>): Promise<void> {
  const state = useAgent.getState();
  await state.load();
  if (!state.connections.length) {
    await state.saveConnection({ id: "conn_rehearsal", providerId: "anthropic", label: "Claude", values: { apiKey: "rehearsal" }, defaultModel: "claude-opus-5", createdAt: Date.now(), verifiedAt: Date.now() });
  }
  dialectOverride = scriptedDialect(turns);
  armed = true;
}
let armed = false;

/**
 * REHEARSAL (development only) — run a chat whose model is a script. The turns
 * are exactly what a model would send; the loop, the tools, the registry, the
 * renders and the chat UI are all real. It is how the product is exercised end
 * to end without a provider, and how a build is demonstrated.
 */
export async function rehearse(prompt: string, turns: Array<ScriptedTurn | ((req: Parameters<DialectAdapter["run"]>[0]) => ScriptedTurn)>): Promise<void> {
  const state = useAgent.getState();
  await state.load();
  if (!state.connections.length) {
    await state.saveConnection({ id: "conn_rehearsal", providerId: "anthropic", label: "Claude", values: { apiKey: "rehearsal" }, defaultModel: "claude-opus-5", createdAt: Date.now(), verifiedAt: Date.now() });
  }
  dialectOverride = scriptedDialect(turns);
  try {
    await sendMessage([{ type: "text", text: prompt }]);
  } finally {
    dialectOverride = null;
  }
}

