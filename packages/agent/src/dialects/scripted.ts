import type { DialectAdapter, TurnEvent, TurnRequest, TurnResult } from "./dialect";
import type { Part } from "../types";

/**
 * A SCRIPTED model — plays back turns written in advance, streaming them the
 * way a real provider would (thinking, then text, then tool calls), through the
 * real loop, the real tools and the real UI. It is how the runtime is tested
 * without a network, and how a build can be REHEARSED: the turns are exactly
 * what a model would send, so everything downstream of the model is exercised
 * for real.
 *
 * A turn may be a function of the transcript so far, so a later step can use
 * what an earlier tool returned (a created layer's id, a render).
 */

export interface ScriptedTurn {
  thinking?: string;
  text?: string;
  calls?: Array<{ name: string; input: unknown }>;
  /** Pace of the stream, ms per chunk. 0 = instant. */
  chunkMs?: number;
}

export function scriptedDialect(turns: Array<ScriptedTurn | ((req: TurnRequest) => ScriptedTurn)>): DialectAdapter {
  let i = 0;
  let seq = 0;
  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (!ms) return resolve();
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    });
  return {
    async run(req: TurnRequest, onEvent: (e: TurnEvent) => void): Promise<TurnResult> {
      const step = turns[i++];
      const turn: ScriptedTurn = typeof step === "function" ? step(req) : (step ?? { text: "(end of script)" });
      const pace = turn.chunkMs ?? 18;
      const stream = async (text: string, type: "text" | "thinking") => {
        for (const chunk of text.match(/.{1,6}/gs) ?? []) {
          onEvent({ type, delta: chunk });
          await wait(pace, req.signal);
        }
      };
      const parts: Part[] = [];
      if (turn.thinking) {
        await stream(turn.thinking, "thinking");
        parts.push({ type: "thinking", text: turn.thinking });
      }
      if (turn.text) {
        await stream(turn.text, "text");
        parts.push({ type: "text", text: turn.text });
      }
      for (const call of turn.calls ?? []) {
        const id = `call_${(seq++).toString(36)}`;
        onEvent({ type: "tool_call_start", id, name: call.name });
        const json = JSON.stringify(call.input);
        for (const chunk of json.match(/.{1,24}/gs) ?? []) {
          onEvent({ type: "tool_call_delta", id, partialJson: chunk });
          await wait(pace / 2, req.signal);
        }
        parts.push({ type: "tool_call", id, name: call.name, input: call.input });
      }
      const inputTokens = Math.round(JSON.stringify(req.messages).length / 4 + req.system.length / 4);
      const outputTokens = Math.round(JSON.stringify(parts).length / 4);
      onEvent({ type: "usage", usage: { inputTokens, outputTokens } });
      return { parts, stop: turn.calls?.length ? "tool_use" : "end", usage: { inputTokens, outputTokens } };
    },
    async listModels() {
      return [];
    },
  };
}
