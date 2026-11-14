/**
 * Headless log bus — a Figma/DevTools-style console that works EVERYWHERE.
 *
 * It wraps `console.*` so every existing `console.log/warn/error` in the app is
 * teed into a ring buffer AND still forwarded to the real console (so the browser
 * DevTools and the Electron devtools keep working untouched). It also grabs
 * uncaught errors and promise rejections. The in-app Console panel is just a
 * `useSyncExternalStore` view over this buffer — no framework here, so the same
 * bus drives web, Electron, and a future React-Native LogBox.
 *
 * Install once at app boot via `installConsoleCapture()`. Idempotent.
 */

import type { LogLevel } from "../ports";

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  /** Rendered single-line preview (what the row shows collapsed). */
  text: string;
  /** Original console args, kept for expandable object inspection in the UI. */
  args: unknown[];
  /**
   * A structured payload for this line that is NOT part of its text.
   *
   * The distinction earns its place: a caller that wants a rich, expandable row
   * has to attach the object somewhere, and putting it in `args` means the
   * preview renders it — so a line that already says "TypeError: x is undefined"
   * says it a second time in the same row. `detail` is what the row expands
   * INTO; `args` is what it reads AS.
   */
  detail?: unknown;
  /** How many identical consecutive lines collapsed into this one (DevTools style). */
  count: number;
}

const MAX = 2000; // ring buffer cap — plenty for a session, bounded memory.

let buffer: LogEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();
type NativeSink = (level: LogLevel, message: string) => void;
let nativeSink: NativeSink | null = null;
type ErrorSink = (value: unknown, source: "uncaught" | "unhandled-rejection") => void;
let errorSink: ErrorSink | null = null;

function emit() {
  for (const l of listeners) l();
}

/** Subscribe to buffer changes (for React's useSyncExternalStore). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current snapshot — stable reference between mutations so React can bail out. */
export function getEntries(): readonly LogEntry[] {
  return buffer;
}

export function clearLog(): void {
  buffer = [];
  emit();
}

/**
 * Point the bus at a native sink (e.g. a desktop main-process log file). Every
 * subsequent line is also forwarded there. Unused today; kept for a future
 * native adapter to wire in without touching call sites.
 */
export function setNativeSink(sink: NativeSink | null): void {
  nativeSink = sink;
}

/**
 * Hand uncaught errors and rejections to the app's own error funnel instead of
 * logging them raw.
 *
 * The bus catches them because it must — something has to, and at boot it is
 * the only thing installed. But an app with a real error taxonomy wants them
 * NORMALISED, deduplicated and attributed, and it must not get two lines for
 * one failure. So it claims them: set a sink and the bus stops writing them
 * itself, leaving exactly one path from any thrown value to the console.
 *
 * `null` restores the raw logging, which is still the right behaviour for a
 * host that has no funnel of its own.
 */
export function setErrorSink(sink: ErrorSink | null): void {
  errorSink = sink;
}

function preview(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export function pushLog(level: LogLevel, args: unknown[], detail?: unknown): void {
  const text = preview(args);
  const last = buffer[buffer.length - 1];
  // Collapse identical consecutive lines like DevTools' occurrence counter.
  if (last && last.level === level && last.text === text) {
    // The NEWEST payload wins: a repeat of the same failure is worth expanding
    // into its latest occurrence, not the one from four minutes ago.
    buffer = buffer.slice(0, -1).concat({ ...last, count: last.count + 1, ts: Date.now(), detail });
  } else {
    const entry: LogEntry = { id: ++seq, ts: Date.now(), level, text, args, detail, count: 1 };
    buffer = buffer.length >= MAX ? buffer.slice(1).concat(entry) : buffer.concat(entry);
  }
  nativeSink?.(level, text);
  emit();
}

const CONSOLE_METHODS: Array<[keyof Console, LogLevel]> = [
  ["log", "info"],
  ["info", "info"],
  ["debug", "debug"],
  ["warn", "warn"],
  ["error", "error"],
];

let installed = false;

/**
 * Patch console.* and window error handlers to tee into the bus. Idempotent and
 * SSR-safe (no-op without a window). Returns a restore fn (mainly for tests).
 */
export function installConsoleCapture(): () => void {
  if (installed || typeof window === "undefined") return () => {};
  installed = true;

  const original = new Map<keyof Console, (...a: unknown[]) => void>();
  for (const [method, level] of CONSOLE_METHODS) {
    const prev = console[method] as (...a: unknown[]) => void;
    original.set(method, prev);
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      pushLog(level, args);
      prev.apply(console, args); // keep the real console fully intact
    };
  }

  const onError = (e: ErrorEvent) => {
    if (errorSink) errorSink(e.error ?? e.message, "uncaught");
    else pushLog("error", [e.error ?? e.message]);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    if (errorSink) errorSink(e.reason, "unhandled-rejection");
    else pushLog("error", ["Unhandled rejection:", e.reason]);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    for (const [method, prev] of original) (console as unknown as Record<string, unknown>)[method] = prev;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    installed = false;
  };
}
