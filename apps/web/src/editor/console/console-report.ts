"use client";

import { identity } from "@/editor/identity";
import {
  buildBugReport,
  errors,
  isEngineError,
  subjectLabel,
  supervisor,
  watchdog,
  type EngineError,
} from "@solomotion/core";
import * as React from "react";
import { getLogEntries, osKind, type LogEntry } from "@solomotion/platform";
import { platform } from "@/editor/platform";
import { APP_VERSION } from "../version";
import { useStatusBar } from "../state/status-bar";

/**
 * What the Console can put on the clipboard — the three shapes that actually
 * get pasted somewhere.
 *
 * Split out of the window because none of it is about rendering, and because
 * the bug report in particular is the feature: the difference between a report
 * we can act on and one we cannot is whether it carries the version, the
 * platform and the last sixty lines, and nobody types those in by hand. One
 * menu item collects them.
 */

/**
 * The structured error a row is about, if it has one. `detail` first — that is
 * where the funnel puts it — then the args, so a bare `console.error(err)` from
 * anywhere in the app still expands.
 */
export function entryError(entry: LogEntry): EngineError | null {
  if (isEngineError(entry.detail)) return entry.detail;
  for (const arg of entry.args) if (isEngineError(arg)) return arg;
  return null;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** One line each: what you want when pasting into a chat. */
export function toPlainText(entries: LogEntry[]): string {
  return entries
    .map((e) => `${formatTime(e.ts)} ${e.level.padEnd(5)} ${e.text}${e.count > 1 ? ` (×${e.count})` : ""}`)
    .join("\n");
}

/** Everything we know: stack, context, subject, causes. For an issue. */
export function toDetailedText(entries: LogEntry[]): string {
  return entries
    .map((e) => {
      const err = entryError(e);
      const head = `${formatTime(e.ts)} ${e.level.toUpperCase()} ${e.text}`;
      if (!err) return head;
      return `${head}\n${err.toText()}`;
    })
    .join("\n\n");
}

/** One-line "where" for a row, when the error knows. */
export function entryWhere(entry: LogEntry): string | null {
  const err = entryError(entry);
  if (!err) return null;
  return err.subjects.length > 0 ? err.subjects.map(subjectLabel).join(" → ") : null;
}

/**
 * The whole session, as a markdown issue. The environment is assembled HERE —
 * core never sniffs a user agent — and everything else comes from the buses
 * that were already collecting it.
 */
export function copyableBugReport(note?: string): string {
  const nav = typeof navigator === "undefined" ? null : navigator;
  return buildBugReport({
    appName: identity.name,
    appVersion: APP_VERSION,
    environment: {
      Platform: platform.app.kind,
      OS: osKind(),
      Agent: nav?.userAgent ?? "unknown",
      Screen:
        typeof window === "undefined"
          ? "unknown"
          : `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}×`,
      Cores: String(nav?.hardwareConcurrency ?? "?"),
      Memory: String((nav as { deviceMemory?: number } | null)?.deviceMemory ?? "?") + " GB",
    },
    errors: errors.reports(),
    tasks: supervisor.tasks().map((t) => ({
      kind: t.kind,
      label: t.label,
      state: t.state,
      ms: (t.endedAt ?? performance.now()) - t.startedAt,
    })),
    freezes: watchdog.freezes().map((f) => ({
      durationMs: f.durationMs,
      label: f.tasks[0]?.label ?? null,
    })),
    logs: getLogEntries().map((e) => ({ ts: e.ts, level: e.level, text: e.text })),
    note,
  });
}

/** Fire-and-forget clipboard write; the caller reports the outcome. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A copy action's outcome goes to the status bar — it is feedback, not news. */
export async function copyWithStatus(text: string, what: string): Promise<boolean> {
  const ok = await copyText(text);
  useStatusBar.getState().notify({
    kind: ok ? "success" : "error",
    text: ok ? `Copied ${what}` : "Couldn’t reach the clipboard",
  });
  return ok;
}

export function useCopier() {
  return React.useCallback(async (text: string, what: string): Promise<void> => {
    await copyWithStatus(text, what);
  }, []);
}

/**
 * A copy button's own confirmation — `copied` is true for a moment after a
 * copy that actually landed, so the icon can turn into a check where the
 * person is looking. A failed write says so in the status bar instead of
 * pretending.
 */
export function useCopied(ms = 1500) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef(0);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = React.useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      if (!ok) {
        useStatusBar.getState().notify({ kind: "error", text: "Couldn’t reach the clipboard" });
        return false;
      }
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), ms);
      return true;
    },
    [ms],
  );
  return { copied, copy };
}
