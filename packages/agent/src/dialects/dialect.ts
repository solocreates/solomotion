import type { Connection, ModelDef } from "../providers";
import type { Effort, Message, Part, ToolDef, Usage } from "../types";

/**
 * A DIALECT is how one family of APIs is spoken: the neutral transcript in, a
 * stream of neutral events out. The loop above never knows which one it is
 * talking to — that is what lets a chat switch models mid-conversation.
 */

export interface TurnRequest {
  connection: Connection;
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDef[];
  effort?: Effort;
  maxOutputTokens?: number;
  signal: AbortSignal;
}

export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; partialJson: string }
  /** Running totals for THIS request; the last one wins. */
  | { type: "usage"; usage: Usage };

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "context_full" | "other";

export interface TurnResult {
  parts: Part[];
  stop: StopReason;
  usage: Usage;
  /** For exact replay on the same model (see `Message.native`). */
  native?: unknown;
  /** Explanation when the model declined (refusal). */
  stopDetail?: string;
  /** The model that actually answered, when a provider fell back to another. */
  servedBy?: string;
}

export interface DialectAdapter {
  run(req: TurnRequest, onEvent: (e: TurnEvent) => void): Promise<TurnResult>;
  /** The provider's live model list, where it has one. */
  listModels(connection: Connection, signal?: AbortSignal): Promise<ModelDef[]>;
}

/** Render an attached text file as a tagged block — how every dialect inlines one. */
export function fileAsText(part: { name: string; text: string }): string {
  return `<attached_file name="${part.name.replace(/"/g, "'")}">\n${part.text}\n</attached_file>`;
}

/** Describe a binary attachment in words — the model acts on it by id through tools. */
export function attachmentAsText(part: { id: string; name: string; mediaType: string; size: number; meta?: Record<string, string | number> }): string {
  const kb = part.size >= 1e6 ? `${(part.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(part.size / 1e3))} KB`;
  const meta = part.meta ? Object.entries(part.meta).map(([k, v]) => ` ${k}="${v}"`).join("") : "";
  return `<attachment id="${part.id}" name="${part.name.replace(/"/g, "'")}" type="${part.mediaType}" size="${kb}"${meta} />`;
}

/** Parse the JSON a model streamed as a tool input — tolerant of an empty body. */
export function parseToolInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { __invalid_json: trimmed.slice(0, 2000) };
  }
}
