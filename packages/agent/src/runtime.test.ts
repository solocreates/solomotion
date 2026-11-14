import { describe, expect, it } from "vitest";
import { runAgent, type AgentEvent } from "./runtime";
import type { DialectAdapter, TurnRequest, TurnResult } from "./dialects/dialect";
import { toAnthropicMessages } from "./dialects/anthropic";
import { toOpenAIMessages } from "./dialects/openai";
import { buildSystemPrompt, packFromFiles, parseFrontmatter, readPackFile } from "./knowledge";
import type { Connection } from "./providers";
import type { Message, ToolDef } from "./types";

const connection: Connection = { id: "c1", providerId: "anthropic", label: "Test", values: { apiKey: "x" }, createdAt: 0 };

/** A scripted model: each call returns the next turn. */
function scripted(turns: Array<Partial<TurnResult> | Error>): DialectAdapter & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  let i = 0;
  return {
    requests,
    async run(req, onEvent) {
      requests.push({ ...req, messages: [...req.messages] });
      const next = turns[i++];
      if (!next) throw new Error("script ran out");
      if (next instanceof Error) throw next;
      for (const p of next.parts ?? []) if (p.type === "text") onEvent({ type: "text", delta: p.text });
      return { parts: [], stop: "end", usage: { inputTokens: 10, outputTokens: 5 }, ...next };
    },
    async listModels() {
      return [];
    },
  };
}

const tools: ToolDef[] = [
  { name: "look", description: "", inputSchema: { type: "object" }, effect: "read" },
  { name: "edit", description: "", inputSchema: { type: "object" }, effect: "write" },
];

const user = (text: string): Message => ({ id: `u_${text}`, role: "user", parts: [{ type: "text", text }], createdAt: 0 });

describe("agent loop", () => {
  it("runs reads together and writes in order, then finishes", async () => {
    const log: string[] = [];
    const dialect = scripted([
      {
        stop: "tool_use",
        parts: [
          { type: "tool_call", id: "a", name: "look", input: {} },
          { type: "tool_call", id: "b", name: "look", input: {} },
          { type: "tool_call", id: "c", name: "edit", input: {} },
        ],
      },
      { stop: "end", parts: [{ type: "text", text: "Done." }] },
    ]);
    const res = await runAgent({
      connection,
      model: "m",
      system: "s",
      history: [user("go")],
      tools,
      dialect,
      signal: new AbortController().signal,
      onEvent: () => {},
      execute: async (call) => {
        log.push(`start ${call.id}`);
        await new Promise((r) => setTimeout(r, call.name === "look" ? 20 : 1));
        log.push(`end ${call.id}`);
        return { content: [{ type: "text", text: `ok ${call.id}` }] };
      },
    });
    expect(res.reason).toBe("end");
    // Both reads start before either ends; the write starts after them.
    expect(log.slice(0, 2)).toEqual(["start a", "start b"]);
    expect(log.indexOf("start c")).toBeGreaterThan(log.indexOf("end b"));
    const results = res.messages[1]!;
    expect(results.parts.map((p) => (p.type === "tool_result" ? p.callId : ""))).toEqual(["a", "b", "c"]);
  });

  it("lets the user steer mid-task", async () => {
    const queue: Message[] = [];
    const dialect = scripted([
      { stop: "tool_use", parts: [{ type: "tool_call", id: "a", name: "edit", input: {} }] },
      { stop: "end", parts: [{ type: "text", text: "Made it blue." }] },
    ]);
    await runAgent({
      connection,
      model: "m",
      system: "s",
      history: [user("make it red")],
      tools,
      dialect,
      signal: new AbortController().signal,
      drainSteering: () => queue.splice(0),
      onEvent: () => {},
      execute: async () => {
        queue.push(user("actually blue"));
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const second = dialect.requests[1]!.messages;
    expect(second[second.length - 1]!.parts[0]).toMatchObject({ type: "text", text: "actually blue" });
  });

  it("retries an overloaded provider and discards the failed attempt", async () => {
    const events: AgentEvent["type"][] = [];
    const overloaded = Object.assign(new Error("Overloaded"), { status: 529 });
    const dialect = scripted([overloaded, { stop: "end", parts: [{ type: "text", text: "hi" }] }]);
    const res = await runAgent({
      connection,
      model: "m",
      system: "s",
      history: [user("hi")],
      tools,
      dialect,
      retry: { maxAttempts: 3, baseMs: 1, capMs: 2 },
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e.type),
      execute: async () => ({ content: [] }),
    });
    expect(res.reason).toBe("end");
    expect(events).toContain("retry");
    expect(events).toContain("attempt_reset");
  });

  it("fails fast on a bad key", async () => {
    const dialect = scripted([Object.assign(new Error("invalid x-api-key"), { status: 401 })]);
    const res = await runAgent({
      connection,
      model: "m",
      system: "s",
      history: [user("hi")],
      tools,
      dialect,
      signal: new AbortController().signal,
      onEvent: () => {},
      execute: async () => ({ content: [] }),
    });
    expect(res.reason).toBe("error");
    expect(res.error).toMatch(/rejected the key/);
    expect(dialect.requests).toHaveLength(1);
  });

  it("answers every started call when stopped mid-tool", async () => {
    const ctrl = new AbortController();
    const dialect = scripted([
      {
        stop: "tool_use",
        parts: [
          { type: "tool_call", id: "a", name: "edit", input: {} },
          { type: "tool_call", id: "b", name: "edit", input: {} },
        ],
      },
    ]);
    const res = await runAgent({
      connection,
      model: "m",
      system: "s",
      history: [user("go")],
      tools,
      dialect,
      signal: ctrl.signal,
      onEvent: () => {},
      execute: async () => {
        ctrl.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    expect(res.reason).toBe("stopped");
    const last = res.messages[res.messages.length - 1]!;
    expect(last.parts.map((p) => (p.type === "tool_result" ? p.callId : ""))).toEqual(["a", "b"]);
  });
});

describe("dialects", () => {
  const history: Message[] = [
    user("hi"),
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "thinking", text: "hmm" },
        { type: "tool_call", id: "t1", name: "look", input: { q: 1 } },
      ],
      createdAt: 0,
      native: { provider: "anthropic", model: "claude-opus-5", content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "tool_use", id: "t1", name: "look", input: { q: 1 } }] },
    },
    {
      id: "r1",
      role: "user",
      parts: [{ type: "tool_result", callId: "t1", content: [{ type: "text", text: "seen" }, { type: "image", mediaType: "image/png", data: "AAAA" }] }],
      createdAt: 0,
    },
    user("steer"),
  ];

  it("Anthropic: replays signed thinking to its own model only, tool results first", () => {
    const same = toAnthropicMessages(history, "claude-opus-5");
    expect(JSON.stringify(same[1]!.content)).toContain("sig");
    const other = toAnthropicMessages(history, "claude-sonnet-5");
    expect(JSON.stringify(other[1]!.content)).not.toContain("sig");
    const last = same[2]!;
    expect(last.role).toBe("user");
    const blocks = last.content as Array<{ type: string }>;
    expect(blocks[0]!.type).toBe("tool_result");
    expect(blocks[blocks.length - 1]!.type).toBe("text");
  });

  it("OpenAI: tool images follow as a user message", () => {
    const out = toOpenAIMessages("sys", history);
    const toolIdx = out.findIndex((m) => m.role === "tool");
    expect(out[toolIdx + 1]!.role).toBe("user");
    expect(JSON.stringify(out[toolIdx + 1]!.content)).toContain("data:image/png;base64,AAAA");
  });
});

describe("knowledge packs", () => {
  it("reads frontmatter, keeps entries in the prompt and references on demand", () => {
    const pack = packFromFiles(
      "skill",
      { "SKILL.md": "---\nname: studio\ndescription: Motion design in the studio\n---\n# Studio\nBe great.", "references/text.md": "Text rules" },
      { type: "builtin" },
    );
    expect(parseFrontmatter(pack.files["SKILL.md"]!).meta.name).toBe("studio");
    const prompt = buildSystemPrompt({ identity: "You are the agent.", packs: [pack], instructions: "Use British spelling." });
    expect(prompt).toContain("Be great.");
    expect(prompt).toContain("references/text.md");
    expect(prompt).not.toContain("Text rules");
    expect(prompt.indexOf("You are the agent.")).toBeLessThan(prompt.indexOf("Be great."));
    expect(readPackFile([pack], "studio", "references/text.md")).toBe("Text rules");
  });
});

import { clusterFeedback, fingerprintOf, type FeedbackEvent } from "./feedback";

describe("feedback", () => {
  const ctx = (installId: string) => ({ appVersion: "2.36.0", apiVersion: 1, skillVersion: "1.0.0", provider: "anthropic", model: "claude-opus-5", installId });
  const report = (installId: string, error: string, severity: 1 | 2 | 3 | 4 | 5, at = Date.now()): FeedbackEvent => {
    const body = { kind: "report" as const, category: "api-gap" as const, fault: "ours-api" as const, severity, title: "No verb", tried: "", happened: "", expected: "", command: "layer.create", error };
    return { ...body, id: Math.random().toString(36), at, context: ctx(installId), fingerprint: fingerprintOf(body) };
  };

  it("clusters the same problem across instances and ranks breadth over repetition", () => {
    const events = [
      report("a", 'No layer with id "clip_1".', 3),
      report("b", 'No layer with id "clip_99".', 3),
      report("c", 'No layer with id "clip_7".', 3),
      ...Array.from({ length: 6 }, () => report("z", "Something else entirely 42", 3)),
    ];
    const clusters = clusterFeedback(events);
    expect(clusters).toHaveLength(2);
    const spread = clusters.find((c) => c.installs === 3)!;
    const repeated = clusters.find((c) => c.installs === 1)!;
    expect(spread.count).toBe(3);
    expect(spread.priority).toBeGreaterThan(repeated.priority);
  });

  it("lets severity dominate and old problems sink", () => {
    const now = Date.now();
    const fresh = clusterFeedback([report("a", "x", 5, now)], now)[0]!;
    const stale = clusterFeedback([report("a", "x", 5, now - 60 * 86_400_000)], now)[0]!;
    const mild = clusterFeedback([report("a", "y", 1, now)], now)[0]!;
    expect(fresh.priority).toBeGreaterThan(stale.priority);
    expect(fresh.priority).toBeGreaterThan(mild.priority);
  });
});
