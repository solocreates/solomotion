import { runAgent, type AgentEvent, type RunOptions, type ToolExecContext } from "./runtime";
import type { ToolCallPart, ToolDef, ToolOutput } from "./types";

/**
 * SUB-AGENTS — the main agent hands a self-contained job to a fresh one with
 * its own context window, and gets back a report instead of the whole trail.
 *
 * Why it earns a place in a motion tool: "audit every caption in this project
 * against the style guide", "draft three alternative title animations and
 * describe them", "check each comp for layers outside the safe area" — jobs
 * that read a great deal and conclude a little. Run in the main thread, they
 * fill its context with reading; delegated, the main thread keeps a paragraph.
 *
 * A sub-agent streams its events up (so the chat can show it working, nested),
 * cannot delegate further, and is READ-ONLY unless the parent asks for writes —
 * two agents editing one document at once is a race, and reading is what
 * delegation is for.
 */

export const DELEGATE_TOOL_NAME = "agent_delegate";

export const DELEGATE_TOOL: ToolDef = {
  name: DELEGATE_TOOL_NAME,
  description:
    "Hand a self-contained job to a sub-agent with a fresh context. It can use the same tools (read-only unless `write` is true), works on its own, and returns only its final report. Use it for broad audits, research across many layers or comps, or drafting alternatives — work that reads a lot and concludes a little. Several delegate calls in one turn run in parallel when all are read-only. Give it everything it needs in `task`: it cannot see this conversation.",
  inputSchema: {
    type: "object",
    properties: {
      label: { type: "string", description: "A few words shown in the chat, e.g. \"Audit captions\"." },
      task: { type: "string", description: "The full brief: goal, scope, what to return." },
      write: { type: "boolean", description: "Allow it to edit the project. Default false." },
    },
    required: ["label", "task"],
  },
  effect: "read",
};

export interface DelegateConfig {
  /** The parent run's options — connection, model, tools, execute. */
  parent: Omit<RunOptions, "history" | "onEvent" | "signal" | "drainSteering">;
  /** System prompt for sub-agents (usually the parent's plus a short preface). */
  system: string;
  /** Optionally a cheaper/faster model for delegated work. */
  model?: string;
  maxSteps?: number;
}

let seq = 0;

export async function runDelegate(call: ToolCallPart, ctx: ToolExecContext, config: DelegateConfig): Promise<ToolOutput> {
  const input = (call.input ?? {}) as { label?: string; task?: string; write?: boolean };
  if (!input.task) return { content: [{ type: "text", text: "A delegate call needs a `task`." }], isError: true };
  const agentId = `sub_${Date.now().toString(36)}_${seq++}`;
  const label = input.label || "Sub-agent";
  const tools = config.parent.tools.filter((t) => t.name !== DELEGATE_TOOL_NAME && (input.write || t.effect === "read"));
  const result = await runAgent({
    ...config.parent,
    model: config.model ?? config.parent.model,
    system: `${config.system}\n\nYou are a sub-agent working on one delegated job. Work autonomously, then end with a concise report of what you found or did — it is the only thing the main agent will read.${input.write ? "" : " You are read-only: report, do not edit."}`,
    tools,
    history: [{ id: `${agentId}_task`, role: "user", parts: [{ type: "text", text: input.task }], createdAt: Date.now() }],
    signal: ctx.signal,
    maxSteps: config.maxSteps ?? 30,
    onEvent: (event: AgentEvent) => ctx.emit({ type: "subagent", agentId, label, event }),
  });
  const last = [...result.messages].reverse().find((m) => m.role === "assistant");
  const report = last?.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n").trim();
  if (result.reason === "error") return { content: [{ type: "text", text: `The sub-agent failed: ${result.error}` }], isError: true };
  return {
    content: [
      {
        type: "text",
        text: `${report || "(no report)"}\n\n[sub-agent: ${result.reason}, ${result.usage.inputTokens + result.usage.outputTokens} tokens]`,
      },
    ],
  };
}
