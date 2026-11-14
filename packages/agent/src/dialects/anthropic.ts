import type Anthropic from "@anthropic-ai/sdk";
import { baseUrlOf, type Connection, type ModelDef } from "../providers";
import type { Message, Part } from "../types";
import { attachmentAsText, fileAsText, parseToolInput, type DialectAdapter, type StopReason, type TurnEvent, type TurnRequest, type TurnResult } from "./dialect";

/**
 * Claude, through the official SDK. Loaded on first use so the editor's bundle
 * does not carry it until someone opens a chat.
 *
 * Decisions that are Claude-specific and live only here:
 *  - thinking is ADAPTIVE with a summarized display, so the chat can show it;
 *    Haiku 4.5 predates adaptive and takes a budget instead;
 *  - effort maps to `output_config.effort`;
 *  - Opus 5 and Fable 5.1 opt into server-side refusal FALLBACKS, so a turn a
 *    safety classifier declines is re-served rather than dead-ended;
 *  - the system prompt and the tool list carry cache breakpoints — they are
 *    identical on every turn of a chat, so each turn after the first reads
 *    them from cache at a fraction of the price;
 *  - an assistant turn is replayed byte-for-byte (`native`) to the model that
 *    wrote it, because signed thinking blocks must come back unchanged.
 */

type SDK = typeof import("@anthropic-ai/sdk");
let sdk: Promise<SDK> | null = null;
const loadSdk = () => (sdk ??= import("@anthropic-ai/sdk"));

async function client(c: Connection): Promise<Anthropic> {
  const { default: AnthropicClient } = await loadSdk();
  return new AnthropicClient({
    apiKey: c.values.apiKey ?? "",
    baseURL: baseUrlOf(c) || undefined,
    dangerouslyAllowBrowser: true,
    // One retry policy for every provider lives in the loop (retry.ts), so the
    // UI can show each wait. The SDK's own would retry silently underneath it.
    maxRetries: 0,
  });
}

const PROVIDER = "anthropic";

/** Models that predate adaptive thinking and take a token budget instead. */
const BUDGET_THINKING = /claude-haiku-4-5|claude-(sonnet|opus)-4-5|claude-3/;
/** Models that support server-side refusal fallbacks. */
const FALLBACKS = /^claude-(opus-5|fable-5-1)$/;

/** Claude takes `[a-zA-Z0-9_-]+` ids; one written by another model is mapped, the same way at both ends. */
const toolId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_") || "call";

type BetaParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaBlock = Anthropic.Beta.Messages.BetaContentBlockParam;

function userBlocks(parts: Part[]): BetaBlock[] {
  const results: BetaBlock[] = [];
  const rest: BetaBlock[] = [];
  for (const p of parts) {
    if (p.type === "tool_result") {
      results.push({
        type: "tool_result",
        tool_use_id: toolId(p.callId),
        is_error: p.isError || undefined,
        content: p.content.map((c) =>
          c.type === "text"
            ? { type: "text" as const, text: c.text || "(empty)" }
            : { type: "image" as const, source: { type: "base64" as const, media_type: c.mediaType as "image/png", data: c.data } },
        ),
      });
    } else if (p.type === "text") {
      if (p.text) rest.push({ type: "text", text: p.text });
    } else if (p.type === "image") {
      rest.push({ type: "image", source: { type: "base64", media_type: p.mediaType as "image/png", data: p.data } });
      if (p.attachmentId) rest.push({ type: "text", text: attachmentAsText({ id: p.attachmentId, name: p.name ?? "image", mediaType: p.mediaType, size: p.size ?? p.data.length * 0.75 }) });
    } else if (p.type === "file") {
      rest.push({ type: "text", text: fileAsText(p) });
    } else if (p.type === "attachment") {
      rest.push({ type: "text", text: attachmentAsText(p) });
    }
  }
  // Every tool result first, in ONE message: splitting them teaches the model
  // to stop calling tools in parallel.
  return [...results, ...rest];
}

function assistantBlocks(m: Message, model: string): BetaBlock[] {
  if (m.native?.provider === PROVIDER && m.native.model === model && Array.isArray(m.native.content)) {
    return m.native.content as BetaBlock[];
  }
  const out: BetaBlock[] = [];
  for (const p of m.parts) {
    if (p.type === "text" && p.text) out.push({ type: "text", text: p.text });
    if (p.type === "tool_call") out.push({ type: "tool_use", id: toolId(p.id), name: p.name, input: (p.input ?? {}) as Record<string, unknown> });
    // Thinking written by another model carries no signature and cannot be
    // replayed; the text and calls around it are the durable record.
  }
  return out.length ? out : [{ type: "text", text: "…" }];
}

export function toAnthropicMessages(messages: Message[], model: string): BetaParam[] {
  const out: BetaParam[] = [];
  for (const m of messages) {
    const content = m.role === "user" ? userBlocks(m.parts) : assistantBlocks(m, model);
    if (!content.length) continue;
    const last = out[out.length - 1];
    // Consecutive same-role turns merge — the API wants strict alternation.
    if (last && last.role === m.role && Array.isArray(last.content)) (last.content as BetaBlock[]).push(...content);
    else out.push({ role: m.role, content });
  }
  return out;
}

function stopOf(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "model_context_window_exceeded":
      return "context_full";
    default:
      return "other";
  }
}

export const anthropicDialect: DialectAdapter = {
  async run(req: TurnRequest, onEvent: (e: TurnEvent) => void): Promise<TurnResult> {
    const api = await client(req.connection);
    const tools = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema,
      // Large inputs (a batch, a long path) stream as they are written instead
      // of arriving in one burst; the registry re-validates every input.
      eager_input_streaming: true,
      ...(i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const budget = BUDGET_THINKING.test(req.model);
    const betas: string[] = [];
    const extra: Record<string, unknown> = {};
    if (FALLBACKS.test(req.model)) {
      betas.push("server-side-fallback-2026-07-01");
      extra.fallbacks = "default";
    }
    const stream = api.beta.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxOutputTokens ?? 32_000,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: toAnthropicMessages(req.messages, req.model),
        tools,
        thinking: budget ? { type: "enabled", budget_tokens: 6000 } : { type: "adaptive", display: "summarized" },
        ...(req.effort && !budget ? { output_config: { effort: req.effort } } : {}),
        ...(betas.length ? { betas } : {}),
        ...extra,
      },
      { signal: req.signal },
    );

    const toolIds = new Map<number, string>();
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for await (const event of stream) {
      switch (event.type) {
        case "message_start": {
          const u = event.message.usage;
          usage = {
            inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          };
          onEvent({ type: "usage", usage });
          break;
        }
        case "content_block_start":
          if (event.content_block.type === "tool_use") {
            toolIds.set(event.index, event.content_block.id);
            onEvent({ type: "tool_call_start", id: event.content_block.id, name: event.content_block.name });
          }
          break;
        case "content_block_delta":
          if (event.delta.type === "text_delta") onEvent({ type: "text", delta: event.delta.text });
          else if (event.delta.type === "thinking_delta") onEvent({ type: "thinking", delta: event.delta.thinking });
          else if (event.delta.type === "input_json_delta") {
            const id = toolIds.get(event.index);
            if (id) onEvent({ type: "tool_call_delta", id, partialJson: event.delta.partial_json });
          }
          break;
        case "message_delta":
          usage = { ...usage, outputTokens: event.usage.output_tokens ?? usage.outputTokens };
          onEvent({ type: "usage", usage });
          break;
      }
    }
    const final = await stream.finalMessage();
    const parts: Part[] = [];
    for (const block of final.content) {
      if (block.type === "text") parts.push({ type: "text", text: block.text });
      else if (block.type === "thinking" && block.thinking) parts.push({ type: "thinking", text: block.thinking });
      else if (block.type === "tool_use") {
        parts.push({ type: "tool_call", id: block.id, name: block.name, input: typeof block.input === "string" ? parseToolInput(block.input) : block.input });
      }
    }
    const stopDetails = (final as { stop_details?: { explanation?: string } | null }).stop_details;
    return {
      parts,
      stop: stopOf(final.stop_reason),
      usage,
      native: final.content,
      stopDetail: stopDetails?.explanation ?? undefined,
      servedBy: final.model !== req.model ? final.model : undefined,
    };
  },

  async listModels(connection, signal): Promise<ModelDef[]> {
    const api = await client(connection);
    const out: ModelDef[] = [];
    for await (const m of api.models.list({ limit: 100 }, { signal })) {
      const row = m as { id: string; display_name?: string; max_input_tokens?: number; max_tokens?: number };
      out.push({
        id: row.id,
        label: row.display_name ?? row.id,
        contextWindow: row.max_input_tokens ?? 200_000,
        maxOutput: row.max_tokens,
        vision: true,
        reasoning: true,
      });
    }
    return out;
  },
};
