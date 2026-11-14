import type { CommandResult, ScriptHere } from "@solomotion/core";

/**
 * The wire between the script worker and the editor. Plain data both ways —
 * the worker holds no document and no registry; every `ac.*` call is a `call`
 * message the editor answers with the registry's own `CommandResult`.
 */

/** A value that crossed the boundary — structured-clone safe, cycles and functions replaced. */
export type Cloned = unknown;

export type LogLevel = "log" | "info" | "warn" | "error" | "debug";

export interface ScriptFault {
  name: string;
  message: string;
  hint?: string;
  /** The `ac.*` verb that refused, when the failure was a command's. */
  command?: string;
  stack?: string;
}

export type ToWorker =
  | { t: "init"; commands: Array<{ id: string; summary: string }> }
  | { t: "run"; runId: string; code: string; file: string; repl: boolean; here: ScriptHere | null }
  | { t: "ret"; callId: number; result: CommandResult };

export type FromWorker =
  | { t: "ready"; lineOffset: number }
  /** The code parsed and is about to run: what a replace run takes back goes now, never before. */
  | { t: "compiled"; runId: string }
  | { t: "call"; runId: string; callId: number; command: string; input: Cloned }
  | { t: "log"; runId: string; level: LogLevel; args: Cloned[]; stack?: string }
  | { t: "done"; runId: string; ok: true; value: Cloned }
  | { t: "done"; runId: string; ok: false; error: ScriptFault };

/** The pseudo-command `ac.help(id)` sends; answered by the host, never the registry. */
export const HELP_COMMAND = "$help";

/** A file path as a `sourceURL` engines will print verbatim in a stack. */
export function sourceUrlOf(path: string): string {
  return path.replace(/[^\w./-]/g, "_");
}
