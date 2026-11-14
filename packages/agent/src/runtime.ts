import { anthropicDialect } from "./dialects/anthropic";
import { openaiDialect } from "./dialects/openai";
import type { DialectAdapter, StopReason, TurnEvent } from "./dialects/dialect";
import { contextWindowOf, providerDef, seesImages, type Connection } from "./providers";
import { AbortedError, classify, isAbort, withRetry, type RetryInfo, type RetryPolicy } from "./retry";
import { addUsage, type Effort, type Message, type Part, type ToolCallPart, type ToolDef, type ToolOutput, type ToolResultPart, type Usage } from "./types";

/**
 * THE AGENT LOOP — ask the model, run what it calls, hand the results back,
 * until it is done. Provider-agnostic, UI-agnostic, product-agnostic: tools
 * arrive as definitions plus one `execute` function, and everything the loop
 * learns leaves as events.
 *
 * What makes it an agent rather than a request:
 *  - STEERING. The user can type while it works. Queued messages join the
 *    conversation at the next step boundary (after the current tool results),
 *    so a correction lands mid-task instead of after it — no need to stop.
 *  - PARALLEL READS. Consecutive read-only calls in one turn run together;
 *    writes run one at a time, in the order the model wrote them.
 *  - RETRIES that the user can see, and a transcript that stays valid through
 *    anything: an abort mid-tool still answers every call it started, because
 *    a dangling call poisons every later request of the chat.
 *  - SUB-AGENTS, as an ordinary tool (see `subagents.ts`), streaming their own
 *    events up through this one.
 */

export type AgentEvent =
  | { type: "step"; step: number }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; partialJson: string }
  | { type: "tool_running"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: ToolOutput; ms: number }
  /** A long tool saying how it is doing ("Generating · 40%"). */
  | { type: "tool_progress"; id: string; text: string }
  /** A message committed to the transcript. */
  | { type: "message"; message: Message }
  /** A failed attempt's partial output should be discarded (a retry follows). */
  | { type: "attempt_reset" }
  | { type: "usage"; request: Usage; total: Usage; contextTokens: number; contextWindow: number }
  | { type: "retry"; info: RetryInfo }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  | { type: "subagent"; agentId: string; label: string; event: AgentEvent }
  | { type: "done"; reason: DoneReason; error?: string };

export type DoneReason = "end" | "stopped" | "error" | "max_steps" | "refusal";

export interface ToolExecContext {
  signal: AbortSignal;
  /** Stream progress from inside a tool (a sub-agent's events). */
  emit: (event: AgentEvent) => void;
}

export interface RunOptions {
  connection: Connection;
  model: string;
  system: string;
  /** The conversation so far, oldest first. Not mutated. */
  history: Message[];
  tools: ToolDef[];
  execute: (call: ToolCallPart, ctx: ToolExecContext) => Promise<ToolOutput>;
  onEvent: (event: AgentEvent) => void;
  signal: AbortSignal;
  /** Messages the user queued while the agent worked; drained at each step. */
  drainSteering?: () => Message[];
  effort?: Effort;
  maxSteps?: number;
  maxOutputTokens?: number;
  retry?: RetryPolicy;
  newId?: () => string;
  /** Speak through this adapter instead of the provider's — tests, and a hosted relay. */
  dialect?: DialectAdapter;
}

export interface RunResult {
  /** Every message this run added, in order. */
  messages: Message[];
  usage: Usage;
  reason: DoneReason;
  error?: string;
}

const DIALECTS: Record<string, DialectAdapter> = { anthropic: anthropicDialect, openai: openaiDialect };

export function dialectFor(connection: Connection): DialectAdapter {
  const dialect = providerDef(connection.providerId)?.dialect;
  const adapter = dialect ? DIALECTS[dialect] : undefined;
  if (!adapter) throw new Error(`${connection.label} cannot chat — it is a generation-only service.`);
  return adapter;
}

let counter = 0;
const defaultId = () => `m_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const newId = opts.newId ?? defaultId;
  const dialect = opts.dialect ?? dialectFor(opts.connection);
  const window = contextWindowOf(opts.connection, opts.model);
  const added: Message[] = [];
  const transcript = [...opts.history];
  let total: Usage = { inputTokens: 0, outputTokens: 0 };
  const commit = (m: Message) => {
    transcript.push(m);
    added.push(m);
    opts.onEvent({ type: "message", message: m });
  };
  const finish = (reason: DoneReason, error?: string): RunResult => {
    opts.onEvent({ type: "done", reason, error });
    return { messages: added, usage: total, reason, error };
  };

  // A text-only model is told what it cannot see instead of being sent it —
  // most mirrors answer an image to a blind model with a 400.
  const blind = !seesImages(opts.connection, opts.model);

  const maxSteps = opts.maxSteps ?? 80;
  for (let step = 1; step <= maxSteps; step++) {
    for (const m of opts.drainSteering?.() ?? []) commit(m);
    opts.onEvent({ type: "step", step });

    let result;
    try {
      result = await withRetry(
        async (attempt) => {
          if (attempt > 1) opts.onEvent({ type: "attempt_reset" });
          return dialect.run(
            {
              connection: opts.connection,
              model: opts.model,
              system: opts.system,
              messages: blind ? withoutImages(transcript) : transcript,
              tools: opts.tools,
              effort: opts.effort,
              maxOutputTokens: opts.maxOutputTokens,
              signal: opts.signal,
            },
            (e: TurnEvent) => {
              if (e.type === "usage") {
                opts.onEvent({
                  type: "usage",
                  request: e.usage,
                  total: addUsage(total, e.usage),
                  contextTokens: e.usage.inputTokens + e.usage.outputTokens,
                  contextWindow: window,
                });
              } else opts.onEvent(e);
            },
          );
        },
        { policy: opts.retry, signal: opts.signal, onRetry: (info) => opts.onEvent({ type: "retry", info }) },
      );
    } catch (err) {
      if (isAbort(err) || opts.signal.aborted) return finish("stopped");
      const e = classify(err);
      return finish("error", friendlyError(e.code, e.message, opts.connection.label));
    }

    total = addUsage(total, result.usage);
    opts.onEvent({
      type: "usage",
      request: result.usage,
      total,
      contextTokens: result.usage.inputTokens + result.usage.outputTokens,
      contextWindow: window,
    });
    if (result.servedBy) opts.onEvent({ type: "notice", level: "info", text: `Answered by ${result.servedBy} (fallback).` });

    const assistant: Message = {
      id: newId(),
      role: "assistant",
      parts: result.parts,
      createdAt: Date.now(),
      model: { connectionId: opts.connection.id, provider: opts.connection.providerId, model: opts.model },
      usage: result.usage,
      ...(result.native !== undefined ? { native: { provider: opts.connection.providerId, model: opts.model, content: result.native } } : {}),
    };
    commit(assistant);

    const calls = result.parts.filter((p): p is ToolCallPart => p.type === "tool_call");
    if (result.stop === "refusal") {
      if (calls.length) commit(answerAll(calls, "Not run: the model stopped this turn.", newId));
      opts.onEvent({ type: "notice", level: "warning", text: result.stopDetail ?? "The model declined this request." });
      return finish("refusal");
    }
    if (result.stop === "context_full") {
      if (calls.length) commit(answerAll(calls, "Not run: the context window is full.", newId));
      return finish("error", "This chat has filled the model's context window. Start a new chat, or switch to a model with a larger window.");
    }
    if (!calls.length) {
      if (result.stop === "max_tokens") opts.onEvent({ type: "notice", level: "warning", text: "The reply hit the output limit and was cut short." });
      // Done — unless the user queued something while it was answering.
      const queued = opts.drainSteering?.() ?? [];
      if (queued.length) {
        for (const m of queued) commit(m);
        continue;
      }
      return finish("end");
    }
    if (result.stop === "max_tokens") {
      // A tool input cut off at the limit can still parse; never run it.
      commit(answerAll(calls, "Your tool input was cut off at the output limit. Send it again in smaller pieces.", newId, true));
      continue;
    }

    let results: ToolResultPart[];
    try {
      results = await executeCalls(calls, opts);
    } catch (err) {
      if (isAbort(err) || opts.signal.aborted) {
        commit(answerAll(calls, "Stopped by the user before this finished.", newId, true));
        return finish("stopped");
      }
      throw err;
    }
    commit({ id: newId(), role: "user", parts: results, createdAt: Date.now() });
    if (opts.signal.aborted) return finish("stopped");
  }
  return finish("max_steps", `Stopped after ${maxSteps} steps. Say "continue" to let it keep going.`);
}

/** Answer every call with the same text — keeps the transcript valid when calls cannot run. */
function answerAll(calls: ToolCallPart[], text: string, newId: () => string, isError = false): Message {
  return {
    id: newId(),
    role: "user",
    parts: calls.map((c) => ({ type: "tool_result", callId: c.id, content: [{ type: "text", text }], isError })),
    createdAt: Date.now(),
  };
}

/**
 * Run a turn's calls: consecutive reads together, each write alone, results in
 * the order the model asked for them.
 */
async function executeCalls(calls: ToolCallPart[], opts: RunOptions): Promise<ToolResultPart[]> {
  const effectOf = (name: string) => opts.tools.find((t) => t.name === name)?.effect ?? "write";
  const out: ToolResultPart[] = new Array(calls.length);
  let i = 0;
  while (i < calls.length) {
    if (opts.signal.aborted) throw new AbortedError();
    let j = i + 1;
    if (effectOf(calls[i]!.name) === "read") while (j < calls.length && effectOf(calls[j]!.name) === "read") j++;
    const batch = calls.slice(i, j);
    const done = await Promise.all(batch.map((call) => runOne(call, opts)));
    done.forEach((r, k) => (out[i + k] = r));
    i = j;
  }
  return out;
}

async function runOne(call: ToolCallPart, opts: RunOptions): Promise<ToolResultPart> {
  const started = performance.now();
  opts.onEvent({ type: "tool_running", id: call.id, name: call.name, input: call.input });
  let output: ToolOutput;
  const bad = call.input && typeof call.input === "object" && "__invalid_json" in (call.input as object);
  if (bad) {
    output = { content: [{ type: "text", text: "Your input was not valid JSON. Send the call again." }], isError: true };
  } else if (!opts.tools.some((t) => t.name === call.name)) {
    output = { content: [{ type: "text", text: `There is no tool named "${call.name}".` }], isError: true };
  } else {
    try {
      output = await opts.execute(call, { signal: opts.signal, emit: opts.onEvent });
    } catch (err) {
      if (isAbort(err)) throw err;
      output = { content: [{ type: "text", text: `The tool failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
  opts.onEvent({ type: "tool_result", id: call.id, output, ms: Math.round(performance.now() - started) });
  return { type: "tool_result", callId: call.id, content: output.content, isError: output.isError };
}

function friendlyError(code: string, message: string, label: string): string {
  switch (code) {
    case "auth":
      return `${label} rejected the key. Check it in Agents → Connections.`;
    case "not_found":
      return `${label} does not have that model. Pick another in the model menu. (${message})`;
    case "network":
      return `Could not reach ${label}. If it is a local server, make sure it is running and allows this site (Ollama: OLLAMA_ORIGINS).`;
    case "rate_limit":
    case "overloaded":
      return `${label} is still busy after 10 tries. Wait a moment and send again.`;
    default:
      return message;
  }
}

/** A stop reason in words, for the transcript footer. */
export function describeStop(stop: StopReason): string {
  return stop === "end" ? "Done" : stop === "tool_use" ? "Working" : stop === "max_tokens" ? "Cut short" : stop === "refusal" ? "Declined" : "Stopped";
}

export type { Part };

const UNSEEN = "[image not shown — this model cannot see images; judge from layer.get / doc.overview instead]";

/** The transcript with every image replaced by a note (attachments keep their id line). */
export function withoutImages(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (!m.parts.some((p) => p.type === "image" || (p.type === "tool_result" && p.content.some((c) => c.type === "image")))) return m;
    return {
      ...m,
      parts: m.parts.map((p) => {
        if (p.type === "image") {
          return p.attachmentId
            ? { type: "attachment" as const, id: p.attachmentId, name: p.name ?? "image", mediaType: p.mediaType, size: p.size ?? p.data.length * 0.75 }
            : { type: "text" as const, text: UNSEEN };
        }
        if (p.type === "tool_result") return { ...p, content: p.content.map((c) => (c.type === "image" ? { type: "text" as const, text: UNSEEN } : c)) };
        return p;
      }),
    };
  });
}
