/**
 * THE TRANSCRIPT — one message shape for every provider.
 *
 * A chat has to outlive the model it started on: the user switches from Claude
 * to a local model mid-conversation, reopens it next week on a third. So the
 * stored transcript is provider-NEUTRAL, and each dialect adapter translates it
 * on the way out. What a provider needs replayed byte-for-byte (Anthropic's
 * signed thinking blocks) rides along as `native`, tagged with the model that
 * produced it — replayed to that model, dropped for any other.
 */

export type Role = "user" | "assistant";

export interface TextPart {
  type: "text";
  text: string;
  /** Written by the host, not the user (editor context) — sent, never shown. */
  synthetic?: boolean;
}

export interface ImagePart {
  type: "image";
  /** image/png, image/jpeg, image/webp, image/gif */
  mediaType: string;
  /** Base64, no data: prefix. */
  data: string;
  /** Shown in the UI; never sent. */
  name?: string;
  /** When the user attached it: the id tools use to import it as media. */
  attachmentId?: string;
  size?: number;
}

/** A text document the user attached (md, txt, json, csv…), inlined for the model. */
export interface FilePart {
  type: "file";
  name: string;
  mediaType: string;
  text: string;
}

/**
 * Any other file the user handed over — a sound effect, a font, a video, a
 * zip. The model sees a description and the attachment id; the BYTES stay in
 * the chat's local store until a tool (media.import, font.install,
 * media.inspect) moves them where they belong, once.
 */
export interface AttachmentPart {
  type: "attachment";
  id: string;
  name: string;
  mediaType: string;
  size: number;
  /** What the host measured: duration, dimensions, font family… */
  meta?: Record<string, string | number>;
}

export interface ThinkingPart {
  type: "thinking";
  text: string;
  /** Wall-clock the model spent in this block, for "Thought for 12s". */
  durationMs?: number;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPart {
  type: "tool_result";
  callId: string;
  content: Array<TextPart | ImagePart>;
  isError?: boolean;
}

export type Part = TextPart | ImagePart | FilePart | AttachmentPart | ThinkingPart | ToolCallPart | ToolResultPart;

export interface Message {
  id: string;
  role: Role;
  parts: Part[];
  createdAt: number;
  /**
   * Provider-native content for exact replay (signed thinking, compaction
   * blocks). Only ever sent back to `native.model` on `native.provider`.
   */
  native?: { provider: string; model: string; content: unknown };
  /** Which model wrote an assistant message — shown in the chat, stamped on reports. */
  model?: { connectionId: string; provider: string; model: string };
  usage?: Usage;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Part of outputTokens spent thinking, when the provider says. */
  reasoningTokens?: number;
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    cacheReadTokens: (a?.cacheReadTokens ?? 0) + (b?.cacheReadTokens ?? 0),
    cacheWriteTokens: (a?.cacheWriteTokens ?? 0) + (b?.cacheWriteTokens ?? 0),
    reasoningTokens: (a?.reasoningTokens ?? 0) + (b?.reasoningTokens ?? 0),
  };
}

/** A tool the model may call. `inputSchema` is JSON Schema with an object at the top. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Reads never change the project, so the loop may run them in parallel. */
  effect: "read" | "write";
}

export interface ToolOutput {
  content: Array<TextPart | ImagePart>;
  isError?: boolean;
}

/** How hard the model should think — mapped per dialect (effort, reasoning_effort, budgets). */
export type Effort = "low" | "medium" | "high" | "max";
