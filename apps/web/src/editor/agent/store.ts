"use client";

import { create } from "zustand";
import {
  setAppAttribution,
  defaultChatModel,
  type MediaCapability,
  providerDef,
  type Connection,
  type Effort,
  type FeedbackEvent,
  type KnowledgePack,
  type Message,
  type RetryInfo,
  type ToolOutput,
  type Usage,
} from "@solomotion/agent";
import { dbAll, dbDelete, dbGet, dbPut } from "./db";
import { NAMES } from "@/editor/names";
import { identity } from "@/editor/identity";

/**
 * THE AGENT'S STATE — two halves with different lifetimes.
 *
 *   durable   connections, knowledge packs, settings, chats. Persisted to the
 *             agent IndexedDB on every change; loaded once when the panel
 *             first opens.
 *   live      the run in flight: streamed text and thinking, tool calls as
 *             they happen, token counts, retries. Never persisted — it is a
 *             view of `runAgent`'s events, and it folds into the chat's
 *             messages when each message commits.
 *
 * The live half is what the chat renders at 60fps while streaming, so it is
 * kept flat and appended to, never rebuilt.
 */

export interface AgentSettings {
  connectionId: string | null;
  model: string | null;
  effort: Effort;
  instructions: string;
  /** Upload feedback (reports, ratings, signals) to improve the skill. */
  shareFeedback: boolean;
  /**
   * Agents may read the user's OTHER projects on this device and copy comps
   * and media from them into the open one (`project.list` / `project.import`).
   * Off by default: a linked agent sees the project in front of the person and
   * nothing else until they say so.
   */
  projectAccess?: boolean;
  /** Connections to use for generation/transcription; null = first capable. */
  /** Which connection serves each media job. */
  routes: Partial<Record<MediaCapability, string>>;
  /** A model the user pinned for a media job (else the router's first fit). */
  routeModels?: Partial<Record<MediaCapability, string>>;
  /** Knowledge packs switched off — built-ins included (they cannot be deleted). */
  disabledPacks: string[];
}

export interface ChatMeta {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  connectionId: string | null;
  model: string | null;
  usage: Usage;
  /** Last context size — the meter's reading when the chat is reopened. */
  contextTokens: number;
}

export interface Chat extends ChatMeta {
  messages: Message[];
  /**
   * Each request that changed the document, keyed by the reply that ended it:
   * the history merge key its writes carry, so the chat can rewind exactly that
   * request (and redo it) — see `DocumentStore.undoDepthOf`.
   */
  checkpoints?: Record<string, { key: string; label: string }>;
}

export interface LiveToolCall {
  id: string;
  name: string;
  partialJson: string;
  input?: unknown;
  status: "streaming" | "running" | "done" | "error";
  output?: ToolOutput;
  ms?: number;
  /** A sub-agent's own trail, when this call is a delegation. */
  sub?: { label: string; text: string; tools: Array<{ id: string; name: string; status: LiveToolCall["status"] }> };
  /** Progress text from a long job (video generation). */
  progress?: string;
}

export interface LiveRun {
  chatId: string;
  startedAt: number;
  status: "running" | "stopping";
  /** Streamed-but-uncommitted assistant output of the current step. */
  text: string;
  thinking: string;
  thinkingStartedAt: number | null;
  thinkingMs: number;
  calls: Record<string, LiveToolCall>;
  callOrder: string[];
  /** Tokens this run so far: exact after each step, estimated while streaming. */
  inputTokens: number;
  outputTokens: number;
  streamedChars: number;
  contextTokens: number;
  contextWindow: number;
  retry: (RetryInfo & { until: number }) | null;
  notice: { level: "info" | "warning" | "error"; text: string } | null;
  /** Messages typed while it works; they join at the next step. */
  queued: Message[];
  /** History key for undo grouping. */
  historyKey: string;
}

// Providers that ask callers to say who they are (OpenRouter) hear the product.
setAppAttribution({ name: identity.name, url: identity.siteUrl });

const DEFAULT_SETTINGS: AgentSettings = {
  connectionId: null,
  model: null,
  effort: "high",
  instructions: "",
  shareFeedback: true,
  routes: {},
  disabledPacks: [],
};

interface AgentState {
  loaded: boolean;
  connections: Connection[];
  packs: KnowledgePack[];
  settings: AgentSettings;
  chats: ChatMeta[];
  /** The open chat, loaded in full. */
  chat: Chat | null;
  live: LiveRun | null;
  view: "chat" | "history";
  setupOpen: boolean;
  knowledgeOpen: boolean;
  feedback: FeedbackEvent[];
  /** Why the last run in a chat ended badly — shown under its transcript until the next send. */
  lastError: { chatId: string; text: string } | null;

  load(): Promise<void>;
  saveConnection(c: Connection): Promise<void>;
  removeConnection(id: string): Promise<void>;
  savePack(p: KnowledgePack): Promise<void>;
  removePack(id: string): Promise<void>;
  setSettings(patch: Partial<AgentSettings>): Promise<void>;
  newChat(projectId: string | null): Chat;
  openChat(id: string): Promise<void>;
  saveChat(chat: Chat): Promise<void>;
  deleteChat(id: string): Promise<void>;
  setView(view: AgentState["view"]): void;
  setSetupOpen(open: boolean): void;
  setKnowledgeOpen(open: boolean): void;
  setLive(live: LiveRun | null | ((prev: LiveRun | null) => LiveRun | null)): void;
  setLastError(e: AgentState["lastError"]): void;
  addFeedback(e: FeedbackEvent): Promise<void>;
}

const metaOf = (c: Chat): ChatMeta => {
  const { messages: _messages, ...meta } = c;
  return meta;
};

export const useAgent = create<AgentState>((set, get) => ({
  loaded: false,
  connections: [],
  packs: [],
  settings: DEFAULT_SETTINGS,
  chats: [],
  chat: null,
  live: null,
  view: "chat",
  setupOpen: false,
  knowledgeOpen: false,
  feedback: [],
  lastError: null,

  async load() {
    if (get().loaded) return;
    const [connections, packs, settings, chats, feedback] = await Promise.all([
      dbGet<Connection[]>("kv", "connections"),
      dbGet<KnowledgePack[]>("kv", "packs"),
      dbGet<AgentSettings>("kv", "settings"),
      dbAll<Chat>("chats"),
      dbAll<FeedbackEvent>("feedback"),
    ]);
    set({
      loaded: true,
      connections: connections ?? [],
      packs: packs ?? [],
      settings: { ...DEFAULT_SETTINGS, ...settings },
      chats: chats.map(metaOf).sort((a, b) => b.updatedAt - a.updatedAt),
      feedback: feedback.sort((a, b) => b.at - a.at),
    });
  },

  async saveConnection(c) {
    const connections = [...get().connections.filter((x) => x.id !== c.id), c].sort((a, b) => a.createdAt - b.createdAt);
    set({ connections });
    await dbPut("kv", "connections", connections);
    // The first connection that can CHAT becomes the default, with its default
    // model. A media-only one (fal, ElevenLabs) serves jobs, never the chat.
    const s = get().settings;
    if (canChat(c) && (!s.connectionId || !connections.some((x) => x.id === s.connectionId && canChat(x)))) {
      await get().setSettings({ connectionId: c.id, model: c.defaultModel ?? defaultModelFor(c) });
    }
  },

  async removeConnection(id) {
    const connections = get().connections.filter((c) => c.id !== id);
    set({ connections });
    await dbPut("kv", "connections", connections);
    if (get().settings.connectionId === id) {
      const next = connections.find((c) => providerDef(c.providerId)?.capabilities.includes("chat")) ?? null;
      await get().setSettings({ connectionId: next?.id ?? null, model: next ? defaultModelFor(next) : null });
    }
  },

  async savePack(p) {
    const packs = [...get().packs.filter((x) => x.id !== p.id), p];
    set({ packs });
    await dbPut("kv", "packs", packs);
  },

  async removePack(id) {
    const packs = get().packs.filter((p) => p.id !== id);
    set({ packs });
    await dbPut("kv", "packs", packs);
  },

  async setSettings(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    await dbPut("kv", "settings", settings);
  },

  newChat(projectId) {
    const s = get().settings;
    const now = Date.now();
    const chat: Chat = {
      id: `chat_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: "New chat",
      projectId,
      createdAt: now,
      updatedAt: now,
      connectionId: s.connectionId,
      model: s.model,
      usage: { inputTokens: 0, outputTokens: 0 },
      contextTokens: 0,
      messages: [],
    };
    set({ chat, view: "chat" });
    return chat;
  },

  async openChat(id) {
    const chat = await dbGet<Chat>("chats", id);
    if (chat) set({ chat, view: "chat" });
  },

  async saveChat(chat) {
    const meta = metaOf(chat);
    set((s) => ({
      chat: s.chat?.id === chat.id ? chat : s.chat,
      chats: [meta, ...s.chats.filter((c) => c.id !== chat.id)].sort((a, b) => b.updatedAt - a.updatedAt),
    }));
    await dbPut("chats", chat.id, chat);
  },

  async deleteChat(id) {
    set((s) => ({ chats: s.chats.filter((c) => c.id !== id), chat: s.chat?.id === id ? null : s.chat }));
    await dbDelete("chats", id);
  },

  setView: (view) => set({ view }),
  setSetupOpen: (setupOpen) => set({ setupOpen }),
  setKnowledgeOpen: (knowledgeOpen) => set({ knowledgeOpen }),
  setLive: (live) => set((s) => ({ live: typeof live === "function" ? live(s.live) : live })),
  setLastError: (lastError) => set({ lastError }),

  async addFeedback(e) {
    set((s) => ({ feedback: [e, ...s.feedback].slice(0, 500) }));
    await dbPut("feedback", e.id, e);
  },
}));

export function defaultModelFor(c: Connection): string | null {
  return defaultChatModel(c) ?? null;
}

/** The connection a chat runs on: its own if it still exists, else the default. */
export function connectionOf(state: Pick<AgentState, "connections" | "settings">, chat: ChatMeta | null): Connection | null {
  const id = chat?.connectionId ?? state.settings.connectionId;
  const chatting = state.connections.filter(canChat);
  return chatting.find((c) => c.id === id) ?? chatting.find((c) => c.id === state.settings.connectionId) ?? chatting[0] ?? null;
}

/** Whether a connection can drive the chat (a media-only provider cannot). */
export function canChat(c: Connection): boolean {
  return providerDef(c.providerId)?.capabilities.includes("chat") ?? false;
}

/** A stable anonymous id for this install — counts distinct people in feedback without knowing who. */
export function installId(): string {
  try {
    const k = NAMES.storage.installId;
    let id = localStorage.getItem(k);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(k, id);
    }
    return id;
  } catch {
    return "anonymous";
  }
}
