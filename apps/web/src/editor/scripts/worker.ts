import type { FromWorker, ScriptFault, ToWorker } from "./protocol";
import { NAMES } from "@/editor/names";

/**
 * THE SCRIPT WORKER — where a script's JavaScript actually executes.
 *
 * A dedicated Worker rather than the page, for three reasons that are the
 * whole design: a `while (true)` is stopped by `terminate()` instead of
 * freezing the editor; a script cannot reach the editor's globals, so the
 * command registry is its ONLY door into the document (the same trust boundary
 * the plugins, the agent and MCP sit behind); and closing the panel terminates
 * it, which hands every byte the script allocated back at once.
 *
 * The body is serialised with `toString()` into a Blob, so it needs no bundler
 * support and runs identically under Next, the static export and Electron. That
 * is also its one rule: `workerMain` must be SELF-CONTAINED — no imports, no
 * outer names — and written in plain ES2017 (no `?.`, `??`, `for…of`, spread)
 * so no transpiler helper is ever injected that the Blob would not carry.
 */

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  command: string;
  origin: string;
}

/** The slice of a worker's global the body touches — typed here so the app needs no `webworker` lib. */
interface WorkerScope {
  postMessage(msg: FromWorker): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
  addEventListener(type: "unhandledrejection", fn: (e: PromiseRejectionEvent) => void): void;
  addEventListener(type: "error", fn: (e: ErrorEvent) => void): void;
}

function workerMain(scope: WorkerScope): void {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
  var pending: Record<number, PendingCall> = {};
  var seq = 0;
  var currentRun = "";
  var lineOffset = 2;
  var ac: Record<string, unknown> = {};
  var summaries: Record<string, string> = {};

  function post(msg: FromWorker) {
    scope.postMessage(msg);
  }

  function clone(v: unknown, depth: number, seen: unknown[]): unknown {
    if (v === null || v === undefined) return v;
    var t = typeof v;
    if (t === "bigint") return String(v) + "n";
    if (t === "symbol") return String(v);
    if (t === "function") return { $fn: (v as { name?: string }).name || "anonymous" };
    if (t !== "object") return v;
    if (seen.indexOf(v) >= 0) return "[Circular]";
    if (v instanceof Error) return { $error: { name: v.name, message: v.message } };
    if (v instanceof Date) return v.toISOString();
    if (depth > 8) return Array.isArray(v) ? "[Array]" : "[Object]";
    seen.push(v);
    var out: unknown;
    if (v instanceof Map) {
      var entries: Record<string, unknown> = {};
      v.forEach(function (val, key) {
        entries[String(key)] = clone(val, depth + 1, seen);
      });
      out = entries;
    } else if (v instanceof Set) {
      var items: unknown[] = [];
      v.forEach(function (val) {
        items.push(clone(val, depth + 1, seen));
      });
      out = items;
    } else if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      var arr = Array.prototype.slice.call(v, 0, 5000) as unknown[];
      out = arr.map(function (x) {
        return clone(x, depth + 1, seen);
      });
    } else {
      var obj: Record<string, unknown> = {};
      var keys = Object.keys(v as object);
      for (var i = 0; i < keys.length; i++) obj[keys[i]!] = clone((v as Record<string, unknown>)[keys[i]!], depth + 1, seen);
      out = obj;
    }
    seen.pop();
    return out;
  }

  function fault(e: unknown): ScriptFault {
    if (e && typeof e === "object") {
      var err = e as { name?: string; message?: string; hint?: string; command?: string; stack?: string };
      return { name: err.name || "Error", message: String(err.message || e), hint: err.hint, command: err.command, stack: err.stack };
    }
    return { name: "Error", message: String(e) };
  }

  /**
   * One `ac.*` call. The stack is captured HERE, synchronously, because this is
   * the only moment the person's line is on it — a rejection built later in a
   * `.then` would point at the runtime instead of at their code.
   */
  function call(command: string, input: unknown): Promise<unknown> {
    var origin = new Error().stack || "";
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject, command: command, origin: origin };
      post({ t: "call", runId: currentRun, callId: id, command: command, input: clone(input, 0, []) });
    });
  }

  function buildApi(commands: Array<{ id: string; summary: string }>) {
    ac = {};
    summaries = {};
    commands.forEach(function (c) {
      summaries[c.id] = c.summary;
      var parts = c.id.split(".");
      var node = ac as Record<string, unknown>;
      for (var i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]!] || typeof node[parts[i]!] !== "object") node[parts[i]!] = {};
        node = node[parts[i]!] as Record<string, unknown>;
      }
      var fn = function (input?: unknown) {
        return call(c.id, input === undefined ? {} : input);
      };
      Object.defineProperty(fn, "name", { value: c.id });
      node[parts[parts.length - 1]!] = fn;
    });
    ac.call = function (id: string, input?: unknown) {
      return call(id, input === undefined ? {} : input);
    };
    ac.help = function (id?: string) {
      return call("$help", { id: id || "" });
    };
  }

  function consoleFor(): Record<string, unknown> {
    var out: Record<string, unknown> = {};
    ["log", "info", "warn", "error", "debug"].forEach(function (level) {
      out[level] = function () {
        var args = Array.prototype.slice.call(arguments).map(function (a: unknown) {
          return clone(a, 0, []);
        });
        post({ t: "log", runId: currentRun, level: level as "log", args: args, stack: new Error().stack });
      };
    });
    return out;
  }

  /**
   * The console prompt keeps what you declare, like DevTools: a top-level
   * `const x = …` becomes a global for the next line. A file run is a fresh
   * function scope every time.
   */
  function compile(code: string, file: string, repl: boolean) {
    var tail = "\n//# sourceURL=" + file;
    if (repl) {
      try {
        return new AsyncFunction("ac", "console", "here", "return (" + code + "\n)" + tail);
      } catch (e) {
        code = code
          .replace(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, "globalThis.$1 =")
          .replace(/^(async\s+)?function\s*(\*?)\s*([A-Za-z_$][\w$]*)/gm, "globalThis.$3 = $1function$2 $3");
      }
    }
    return new AsyncFunction("ac", "console", "here", code + tail);
  }

  async function run(m: Extract<ToWorker, { t: "run" }>) {
    currentRun = m.runId;
    try {
      var fn = compile(m.code, m.file, m.repl);
      // Before the first call it makes, so the host has replaced the last run's output by then.
      post({ t: "compiled", runId: m.runId });
      var value = await fn(ac, consoleFor(), m.here ? Object.freeze(m.here) : null);
      post({ t: "done", runId: m.runId, ok: true, value: clone(value, 0, []) });
    } catch (e) {
      post({ t: "done", runId: m.runId, ok: false, error: fault(e) });
    }
  }

  function late(level: "error", value: unknown) {
    post({ t: "log", runId: currentRun, level: level, args: [clone(value, 0, [])], stack: value instanceof Error ? value.stack : undefined });
  }
  scope.addEventListener("unhandledrejection", function (e) {
    e.preventDefault();
    late("error", e.reason);
  });
  scope.addEventListener("error", function (e) {
    e.preventDefault();
    late("error", e.error || e.message);
  });

  scope.onmessage = function (ev: MessageEvent<ToWorker>) {
    var m = ev.data;
    if (m.t === "init") buildApi(m.commands);
    else if (m.t === "run") void run(m);
    else if (m.t === "ret") {
      var p = pending[m.callId];
      if (!p) return;
      delete pending[m.callId];
      var r = m.result;
      if (r.ok) p.resolve(r.value);
      else {
        var err = new Error(p.command + ": " + r.error) as Error & { hint?: string; command?: string };
        err.name = r.kind === "input" ? "InputError" : r.kind === "api" ? "CommandError" : "InternalError";
        err.hint = r.hint;
        err.command = p.command;
        err.stack = err.name + ": " + err.message + "\n" + p.origin.split("\n").slice(1).join("\n");
        p.reject(err);
      }
    }
  };

  // Measure the engine's Function-wrapper offset once: line 1 of a probe.
  new AsyncFunction("ac", "console", "here", "throw new Error('probe')\n//# sourceURL=__probe.js")().catch(function (e: Error) {
    var m = /__probe\.js:(\d+):\d+/.exec(e.stack || "");
    lineOffset = m ? Number(m[1]) - 1 : 2;
    post({ t: "ready", lineOffset: lineOffset });
  });
}

let workerUrl: string | null = null;

/**
 * Spawn a script worker. The Blob URL is made once and kept: it is a few
 * kilobytes, a re-spawn after Stop reuses it, and revoking it while a worker
 * is still being fetched is a race some engines lose.
 */
export function spawnScriptWorker(): Worker {
  workerUrl ??= URL.createObjectURL(new Blob([`(${workerMain.toString()})(self);`], { type: "text/javascript" }));
  return new Worker(workerUrl, { name: NAMES.wire.worker("scripts") });
}
