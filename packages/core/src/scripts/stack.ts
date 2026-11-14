/**
 * WHERE A SCRIPT FAILED — the line and column in the person's file, read from
 * an engine's stack trace.
 *
 * A script runs as a `Function` body tagged with `//# sourceURL=<file>`, so
 * every engine names the file in its frames — but each prepends its own wrapper
 * lines first. The runtime measures that offset once, by throwing from line 1
 * of a probe built the same way, and this reads every later stack with it.
 * Measured, not assumed: the offset is 2 in V8 today and nobody promised it.
 */

export interface ScriptLocation {
  /** 1-based, in the person's source. */
  line: number;
  /** 1-based. */
  column: number;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The first frame of `stack` inside `sourceUrl`, shifted by the wrapper's
 * `lineOffset`. Null when the stack never enters the file (an error raised by
 * the runtime itself, or a syntax error the engine reports without a frame).
 */
export function scriptLocation(stack: string | undefined, sourceUrl: string, lineOffset: number): ScriptLocation | null {
  if (!stack) return null;
  const m = new RegExp(`${escape(sourceUrl)}:(\\d+):(\\d+)`).exec(stack);
  if (!m) return null;
  const line = Number(m[1]) - lineOffset;
  return line >= 1 ? { line, column: Number(m[2]) } : null;
}
