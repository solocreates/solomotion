import type OpenAI from "openai";
import { appAttribution, baseUrlOf, classifyModelId, providerDef, type Connection, type ModelDef } from "../providers";
import type { Message, Part, Usage } from "../types";
import { attachmentAsText, fileAsText, parseToolInput, type DialectAdapter, type StopReason, type TurnEvent, type TurnRequest, type TurnResult } from "./dialect";

/**
 * The OpenAI Chat Completions dialect — spoken natively by OpenAI and mirrored
 * by Gemini, Grok, DeepSeek, Mistral, Groq, OpenRouter, Together, Ollama, LM
 * Studio and every gateway that wants to be a drop-in. One adapter, a dozen
 * providers, through the official SDK pointed at each base URL.
 *
 * The mirrors disagree at the edges, and those disagreements live here:
 *  - reasoning streams as `reasoning_content` (DeepSeek) or `reasoning`
 *    (OpenRouter, Groq) — both are read;
 *  - a tool message cannot carry an image, so a tool that returns one (the
 *    agent LOOKING at the canvas) is followed by a user message holding it;
 *  - `stream_options.include_usage` is refused by a few servers, so a 400 on
 *    it retries once without, and usage falls back to an estimate;
 *  - Mistral accepts only 9-character alphanumeric tool-call ids, so ids
 *    written by another model are mapped (deterministically, both ends);
 *  - DeepSeek's thinking mode wants its `reasoning_content` back inside a tool
 *    loop, and Gemini 3 its `extra_content` thought signatures on each call —
 *    both ride in `Message.native` and go back only to the model that wrote them;
 *  - only OpenAI takes `max_completion_tokens`; the mirrors take `max_tokens`.
 */

type SDK = typeof import("openai");
let sdk: Promise<SDK> | null = null;
const loadSdk = () => (sdk ??= import("openai"));

async function client(c: Connection): Promise<OpenAI> {
  const app = appAttribution();
  const { default: OpenAIClient } = await loadSdk();
  return new OpenAIClient({
    apiKey: c.values.apiKey || "not-needed",
    baseURL: baseUrlOf(c),
    organization: c.values.organization || undefined,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    // OpenRouter asks callers to identify themselves; harmless elsewhere.
    defaultHeaders: c.providerId === "openrouter" && app ? { "HTTP-Referer": app.url, "X-Title": app.name } : undefined,
  });
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type UserContent = OpenAI.Chat.Completions.ChatCompletionContentPart;

const dataUrl = (p: { mediaType: string; data: string }) => `data:${p.mediaType};base64,${p.data}`;

/** What a mirror wrote that must go back to it verbatim (see `Message.native`). */
interface OpenAINative {
  reasoning?: string;
  /** Per tool-call id: the provider's `extra_content` (Gemini thought signatures). */
  extras?: Record<string, unknown>;
}

export interface OpenAIWireOptions {
  /** The connection's provider — decides the quirks above. */
  providerId?: string;
  /** The model being called — native content is replayed only to its author. */
  model?: string;
}

/** Mistral: `[a-zA-Z0-9]{9}`. The same id always maps to the same string. */
function mistralId(id: string): string {
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id;
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  let x = (h >>> 0).toString(36) + Math.abs(Math.imul(h, 31)).toString(36);
  x = x.replace(/[^a-z0-9]/g, "");
  return (x + "000000000").slice(0, 9);
}

export function toOpenAIMessages(system: string, messages: Message[], wire: OpenAIWireOptions = {}): ChatMessage[] {
  const idOf = wire.providerId === "mistral" ? mistralId : (id: string) => id;
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.parts.filter((p) => p.type === "text").map((p) => p.text).join("");
      const calls = m.parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call");
      const native =
        m.native && m.native.provider === wire.providerId && m.native.model === wire.model ? (m.native.content as OpenAINative) : undefined;
      out.push({
        role: "assistant",
        content: text || (calls.length ? null : "…"),
        ...(native?.reasoning && wire.providerId === "deepseek" ? { reasoning_content: native.reasoning } : {}),
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: idOf(c.id),
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
                ...(native?.extras?.[c.id] ? { extra_content: native.extras[c.id] } : {}),
              })),
            }
          : {}),
      } as ChatMessage);
      continue;
    }
    const pendingImages: UserContent[] = [];
    const content: UserContent[] = [];
    for (const p of m.parts) {
      if (p.type === "tool_result") {
        const text = p.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        const images = p.content.filter((c): c is Extract<typeof c, { type: "image" }> => c.type === "image");
        out.push({ role: "tool", tool_call_id: idOf(p.callId), content: (p.isError ? "ERROR: " : "") + (text || (images.length ? "(image attached below)" : "(empty)")) });
        for (const img of images) pendingImages.push({ type: "image_url", image_url: { url: dataUrl(img) } });
      } else if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
      else if (p.type === "image") {
        content.push({ type: "image_url", image_url: { url: dataUrl(p) } });
        if (p.attachmentId) content.push({ type: "text", text: attachmentAsText({ id: p.attachmentId, name: p.name ?? "image", mediaType: p.mediaType, size: p.size ?? p.data.length * 0.75 }) });
      }
      else if (p.type === "file") content.push({ type: "text", text: fileAsText(p) });
      else if (p.type === "attachment") content.push({ type: "text", text: attachmentAsText(p) });
    }
    if (pendingImages.length) out.push({ role: "user", content: [{ type: "text", text: "Images returned by the tool calls above:" }, ...pendingImages] });
    if (content.length) out.push({ role: "user", content });
  }
  return out;
}

function stopOf(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return reason ? "other" : "end";
  }
}

/**
 * Reasoning models take `reasoning_effort`; others reject it. OpenAI and
 * Gemini's compat layer accept it; the top rung depends on the generation
 * (GPT-6 has `max`, GPT-5.2+ `xhigh`, older models stop at `high`).
 */
function reasoningEffort(req: TurnRequest): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const { providerId } = req.connection;
  if (!req.effort || (providerId !== "openai" && providerId !== "google")) return undefined;
  const model = providerDef(providerId)?.models.find((m) => m.id === req.model);
  const reasoning = model?.reasoning ?? /^(o\d|gpt-[56]|gemini-(2\.5|[3-9]))/.test(req.model);
  if (!reasoning) return undefined;
  if (req.effort !== "max") return req.effort;
  if (providerId === "openai" && /^gpt-6/.test(req.model)) return "max";
  if (providerId === "openai" && /^gpt-5\.([2-9]|\d\d)/.test(req.model)) return "xhigh";
  return "high";
}

export const openaiDialect: DialectAdapter = {
  async run(req: TurnRequest, onEvent: (e: TurnEvent) => void): Promise<TurnResult> {
    const api = await client(req.connection);
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      model: req.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAIMessages(req.system, req.messages, { providerId: req.connection.providerId, model: req.model }),
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      ...(reasoningEffort(req) ? { reasoning_effort: reasoningEffort(req) } : {}),
      ...(req.maxOutputTokens
        ? req.connection.providerId === "openai"
          ? { max_completion_tokens: req.maxOutputTokens }
          : { max_tokens: req.maxOutputTokens }
        : {}),
    };
    let stream;
    try {
      stream = await api.chat.completions.create(params, { signal: req.signal });
    } catch (err) {
      if ((err as { status?: number }).status !== 400 || !/stream_options|include_usage/i.test(String((err as Error).message))) throw err;
      const { stream_options: _drop, ...rest } = params;
      stream = await api.chat.completions.create(rest, { signal: req.signal });
    }

    let text = "";
    let thinking = "";
    let finish: string | null = null;
    let usage: Usage | null = null;
    const calls = new Map<number, { id: string; name: string; args: string; extra?: unknown }>();
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta as (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string; reasoning?: string }) | undefined;
      if (delta) {
        const r = delta.reasoning_content ?? delta.reasoning;
        if (r) {
          thinking += r;
          onEvent({ type: "thinking", delta: r });
        }
        if (delta.content) {
          text += delta.content;
          onEvent({ type: "text", delta: delta.content });
        }
        for (const tc of delta.tool_calls ?? []) {
          let call = calls.get(tc.index);
          if (!call) {
            call = { id: tc.id ?? `call_${tc.index}_${Date.now().toString(36)}`, name: tc.function?.name ?? "", args: "" };
            calls.set(tc.index, call);
            if (call.name) onEvent({ type: "tool_call_start", id: call.id, name: call.name });
          } else if (tc.function?.name && !call.name) {
            call.name = tc.function.name;
            onEvent({ type: "tool_call_start", id: call.id, name: call.name });
          }
          const extra = (tc as { extra_content?: unknown }).extra_content;
          if (extra) call.extra = extra;
          if (tc.function?.arguments) {
            call.args += tc.function.arguments;
            onEvent({ type: "tool_call_delta", id: call.id, partialJson: tc.function.arguments });
          }
        }
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) {
        const u = chunk.usage as OpenAI.CompletionUsage;
        usage = {
          inputTokens: u.prompt_tokens,
          outputTokens: u.completion_tokens,
          cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
          reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
        };
        onEvent({ type: "usage", usage });
      }
    }
    const parts: Part[] = [];
    if (thinking) parts.push({ type: "thinking", text: thinking });
    if (text) parts.push({ type: "text", text });
    for (const call of [...calls.values()]) {
      parts.push({ type: "tool_call", id: call.id, name: call.name, input: parseToolInput(call.args) });
    }
    const extras = Object.fromEntries([...calls.values()].filter((c) => c.extra).map((c) => [c.id, c.extra]));
    const native: OpenAINative = {
      ...(thinking ? { reasoning: thinking } : {}),
      ...(Object.keys(extras).length ? { extras } : {}),
    };
    return {
      parts,
      native: Object.keys(native).length ? native : undefined,
      stop: calls.size && finish !== "length" ? "tool_use" : stopOf(finish),
      // Some servers never report usage; a character estimate keeps the meter honest.
      usage: usage ?? { inputTokens: 0, outputTokens: Math.ceil((text.length + thinking.length) / 4) },
    };
  },

  async listModels(connection, signal): Promise<ModelDef[]> {
    const api = await client(connection);
    const page = await api.models.list({ signal });
    const out: ModelDef[] = [];
    for (const m of page.data as Array<{ id: string; context_length?: number; context_window?: number; name?: string }>) {
      // Gemini's compat list names models "models/gemini-…"; the bare id is what every endpoint takes.
      const id = m.id.replace(/^models\//, "");
      const kind = classifyModelId(id);
      if (kind.drop) continue;
      out.push({
        id,
        label: m.name && m.name !== m.id ? m.name : id,
        contextWindow: kind.capability ? 0 : (m.context_length ?? m.context_window ?? 128_000),
        ...(kind.capability ? { capability: kind.capability, ...(kind.inputs ? { inputs: kind.inputs } : {}) } : {}),
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  },
};
