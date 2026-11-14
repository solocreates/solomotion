import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgent, type AgentEvent } from "./runtime";
import type { Connection } from "./providers";
import type { Message, ToolDef } from "./types";

/**
 * The real SDKs against a local server that speaks each wire protocol — what
 * a provider would send, byte for byte in shape. Everything from the HTTP
 * request down is the production path: the SDK, the stream parser, the
 * dialect, the loop, the tool round trip, the second request.
 */

type Handler = (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base = "";
let handler: Handler = () => {};
const bodies: Array<Record<string, unknown>> = [];
const paths: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      bodies.push(body);
      paths.push(req.url ?? "");
      handler(body, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function sse(res: ServerResponse, frames: Array<{ event?: string; data: unknown }>) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of frames) res.write(`${f.event ? `event: ${f.event}\n` : ""}data: ${typeof f.data === "string" ? f.data : JSON.stringify(f.data)}\n\n`);
  res.end();
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const tools: ToolDef[] = [{ name: "view_render", description: "Render the comp.", inputSchema: { type: "object", properties: { detail: { type: "string" } } }, effect: "read" }];
const user: Message = { id: "u1", role: "user", parts: [{ type: "text", text: "Make a title." }], createdAt: 0 };

async function drive(connection: Connection, model: string) {
  bodies.length = 0;
  paths.length = 0;
  const calls: unknown[] = [];
  const events: AgentEvent[] = [];
  const res = await runAgent({
    connection,
    model,
    system: "You are the studio's agent.",
    history: [user],
    tools,
    maxOutputTokens: 4096,
    signal: new AbortController().signal,
    retry: { maxAttempts: 1, baseMs: 1, capMs: 1 },
    onEvent: (e) => events.push(e),
    execute: async (call) => {
      calls.push(call.input);
      return { content: [{ type: "text", text: "rendered" }, { type: "image", mediaType: "image/png", data: PNG }] };
    },
  });
  return { res, calls, events, text: res.messages.at(-1)?.parts.find((p) => p.type === "text") };
}

// ─── OpenAI Chat Completions and its mirrors ────────────────────────────────

function openaiServer(opts: { reasoningField?: "reasoning_content" | "reasoning"; callId?: string; extra?: unknown } = {}) {
  let turn = 0;
  handler = (_body, req, res) => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const chunk = (delta: unknown, finish: string | null = null) => ({
      data: { id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] },
    });
    if (turn++ === 0) {
      sse(res, [
        ...(opts.reasoningField ? [chunk({ role: "assistant", [opts.reasoningField]: "Plan: look first." })] : []),
        chunk({
          role: "assistant",
          tool_calls: [{ index: 0, id: opts.callId ?? "call_abc123", type: "function", function: { name: "view_render", arguments: "" }, ...(opts.extra ? { extra_content: opts.extra } : {}) }],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"deta' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'il":"look"}' } }] }),
        chunk({}, "tool_calls"),
        { data: { id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } } },
        { data: "[DONE]" },
      ]);
    } else {
      sse(res, [chunk({ role: "assistant", content: "Title " }), chunk({ content: "is ready." }), chunk({}, "stop"), { data: "[DONE]" }]);
    }
  };
}

const conn = (providerId: string, baseUrl: string): Connection => ({ id: providerId, providerId, label: providerId, values: { apiKey: "k", baseUrl }, createdAt: 0 });

describe("OpenAI-compatible providers over the wire", () => {
  for (const [providerId, model] of [
    ["openai", "gpt-5"],
    ["google", "gemini-2.5-pro"],
    ["xai", "grok-4"],
    ["openrouter", "anthropic/claude-opus-5"],
    ["groq", "openai/gpt-oss-120b"],
    ["together", "some/model"],
    ["ollama", "qwen3"],
    ["lmstudio", "local-model"],
    ["custom", "my-model"],
  ] as const) {
    it(`${providerId}: streams a tool call, runs it, sends the result, finishes`, async () => {
      openaiServer({ reasoningField: "reasoning" });
      const { res, calls, events, text } = await drive(conn(providerId, `${base}/v1`), model);
      expect(res.reason).toBe("end");
      expect(calls).toEqual([{ detail: "look" }]);
      expect(text).toEqual({ type: "text", text: "Title is ready." });
      expect(events.some((e) => e.type === "usage")).toBe(true);
      expect(bodies).toHaveLength(2);
      const [first, second] = bodies as Array<{ messages: Array<Record<string, unknown>>; tools: unknown[]; stream: boolean }>;
      expect(first!.stream).toBe(true);
      expect(first!.tools).toHaveLength(1);
      // The tool result answers the call by id; the image rides in a user message after it.
      const toolMsg = second!.messages.find((m) => m.role === "tool")!;
      expect(toolMsg.tool_call_id).toBe("call_abc123");
      const sees = providerId !== "groq" && providerId !== "ollama";
      const imageMsg = second!.messages.find((m) => m.role === "user" && JSON.stringify(m.content).includes("image_url"));
      expect(!!imageMsg).toBe(sees);
      // Only OpenAI takes max_completion_tokens.
      expect(providerId === "openai" ? "max_completion_tokens" in first! : "max_tokens" in first!).toBe(true);
    });
  }

  it("mistral: tool-call ids are mapped to its 9-character form at both ends", async () => {
    openaiServer({ callId: "toolu_01XYZ-claude" });
    await drive(conn("mistral", `${base}/v1`), "mistral-large-latest");
    const msgs = (bodies[1] as { messages: Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }> }).messages;
    const callId = msgs.find((m) => m.role === "assistant")!.tool_calls![0]!.id;
    expect(callId).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(msgs.find((m) => m.role === "tool")!.tool_call_id).toBe(callId);
  });

  it("deepseek: reasoning goes back inside the tool loop; a text-only model is never sent an image", async () => {
    openaiServer({ reasoningField: "reasoning_content" });
    const { res, events } = await drive(conn("deepseek", `${base}/v1`), "deepseek-reasoner");
    expect(res.reason).toBe("end");
    expect(events.some((e) => e.type === "thinking")).toBe(true);
    const msgs = (bodies[1] as { messages: Array<Record<string, unknown>> }).messages;
    expect(msgs.find((m) => m.role === "assistant")!.reasoning_content).toBe("Plan: look first.");
    expect(JSON.stringify(msgs)).not.toContain("image_url");
    expect(JSON.stringify(msgs)).toContain("cannot see images");
  });

  it("gemini: thought signatures on a call are replayed to the model that wrote them", async () => {
    const extra = { google: { thought_signature: "sig-123" } };
    openaiServer({ extra });
    await drive(conn("google", `${base}/v1`), "gemini-2.5-pro");
    const msgs = (bodies[1] as { messages: Array<{ role: string; tool_calls?: Array<Record<string, unknown>> }> }).messages;
    expect(msgs.find((m) => m.role === "assistant")!.tool_calls![0]!.extra_content).toEqual(extra);
  });

  it("a provider error surfaces as a readable failure, not a crash", async () => {
    handler = (_b, _r, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }));
    };
    const { res } = await drive(conn("openai", `${base}/v1`), "gpt-5");
    expect(res.reason).toBe("error");
    expect(res.error).toBeTruthy();
  });
});

// ─── Anthropic Messages ─────────────────────────────────────────────────────

describe("Anthropic over the wire", () => {
  it("streams thinking and a tool call, replays signed thinking, finishes", async () => {
    let turn = 0;
    handler = (_body, req, res) => {
      if (!req.url?.includes("/v1/messages")) return res.writeHead(404).end();
      const start = (id: string) => ({
        event: "message_start",
        data: { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 200, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      });
      if (turn++ === 0) {
        sse(res, [
          start("msg_1"),
          { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Look before building." } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } } },
          { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
          { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "view_render", input: {} } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"detail":' } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"look"}' } } },
          { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
          { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } } },
          { event: "message_stop", data: { type: "message_stop" } },
        ]);
      } else {
        sse(res, [
          start("msg_2"),
          { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Title is ready." } } },
          { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
          { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } } },
          { event: "message_stop", data: { type: "message_stop" } },
        ]);
      }
    };
    const { res, calls, events, text } = await drive(conn("anthropic", base), "claude-opus-5");
    expect(res.reason).toBe("end");
    expect(calls).toEqual([{ detail: "look" }]);
    expect(text).toEqual({ type: "text", text: "Title is ready." });
    expect(events.filter((e) => e.type === "thinking").length).toBeGreaterThan(0);

    const [first, second] = bodies as Array<Record<string, any>>;
    expect(first!.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(first!.tools[0].eager_input_streaming).toBe(true);
    expect(first!.system[0].cache_control).toEqual({ type: "ephemeral" });
    // Signed thinking goes back exactly; the tool result carries the image.
    const assistant = second!.messages[1];
    expect(assistant.content[0]).toMatchObject({ type: "thinking", signature: "SIG" });
    const result = second!.messages[2].content[0];
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "toolu_01" });
    expect(result.content.map((c: { type: string }) => c.type)).toEqual(["text", "image"]);
  });
});
