import type { CommandContext } from "../api/command";
import type { CommandRegistry } from "../api/registry";
import { scriptCallable } from "./brief";
import type { ScriptHere } from "./here";

/**
 * A script run IN-PROCESS, with the worker's exact `ac` contract — for tests,
 * the exporter and anything headless. `ac.layer.create(x)` is
 * `registry.call("layer.create", x)`; `ac.call(id, x)` reaches any verb; a
 * refusal throws `Error("<id>: <message>")` with `hint` and `command`, as the
 * worker's does; `here` is frozen; `console` is captured. Same names, same
 * semantics — a script that passes here runs the same in the Scripts panel.
 */

export interface InProcessRun {
  value: unknown;
  logs: string[];
}

type Callable = (input?: unknown) => Promise<unknown>;

export interface InProcessOptions {
  /**
   * Hand the thread back to the host once this many ms of commands have run
   * without a break. A command resolves in a microtask, so an awaited chain of
   * two thousand of them is ONE task to the browser — the Playground's build
   * froze the Home screen for five seconds and tripped "page unresponsive".
   * Absent: run straight through (tests, the exporter).
   */
  yieldEveryMs?: number;
}

export function inProcessAc(registry: CommandRegistry, ctx: CommandContext, opts: InProcessOptions = {}): Record<string, unknown> {
  const budget = opts.yieldEveryMs;
  let sliceStart = budget !== undefined ? now() : 0;
  const call = async (id: string, input: unknown) => {
    if (budget !== undefined && now() - sliceStart > budget) {
      await yieldToHost();
      sliceStart = now();
    }
    const res = await registry.call(id, input === undefined ? {} : input, ctx);
    if (res.ok) return res.value;
    const err = new Error(`${id}: ${res.error}`) as Error & { hint?: string; command?: string };
    err.name = res.kind === "input" ? "InputError" : res.kind === "api" ? "CommandError" : "InternalError";
    err.hint = res.hint;
    err.command = id;
    throw err;
  };
  const ac: Record<string, unknown> = {};
  for (const def of registry.list().filter(scriptCallable)) {
    const parts = def.id.split(".");
    let node = ac;
    for (const p of parts.slice(0, -1)) {
      if (!node[p] || typeof node[p] !== "object") node[p] = {};
      node = node[p] as Record<string, unknown>;
    }
    const fn: Callable = (input) => call(def.id, input);
    node[parts.at(-1)!] = fn;
  }
  ac.call = (id: string, input?: unknown) => call(id, input);
  return ac;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * One trip through the host's task queue: `scheduler.yield` where it exists
 * (Chrome, Electron — it keeps the continuation's priority), else a timer.
 */
function yieldToHost(): Promise<void> {
  const scheduler: { yield?: () => Promise<void> } | undefined = Reflect.get(globalThis, "scheduler");
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function runScriptInProcess(
  registry: CommandRegistry,
  ctx: CommandContext,
  code: string,
  here: ScriptHere | null = null,
  opts: InProcessOptions = {},
): Promise<InProcessRun> {
  const logs: string[] = [];
  const log = (...args: unknown[]) => void logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  const console = { log, info: log, warn: log, error: log, debug: log };
  const pinned: CommandContext = here ? { ...ctx, session: { ...ctx.session, focusFrameId: () => here.frameId } } : ctx;
  const fn = new AsyncFunction("ac", "console", "here", code);
  const value = await fn(inProcessAc(registry, pinned, opts), console, here ? Object.freeze({ ...here }) : null);
  return { value, logs };
}
