"use client";

import { compDurationMs, type MotionDocument } from "@solomotion/core";
import { useSession } from "../state/session";

/**
 * The working range (DaVinci in/out points), one per active comp. It lives in
 * session state (an editing aid, not document content) but every rule about it
 * — what counts as "active", how the [ / ] bounds toggle — is here, so the
 * session store stays a dumb value holder and the Timeline, playback loop and
 * export dialog all agree by reading the same helpers.
 */

const MIN_SPAN_MS = 100;

/** The active in/out range for a comp, or null (disabled / not set / not this comp). */
export function effectiveWorkRange(compId: string): { startMs: number; endMs: number } | null {
  const s = useSession.getState();
  const r = s.workRange;
  if (!s.workRangeEnabled || !r || r.compId !== compId || r.endMs - r.startMs < MIN_SPAN_MS) return null;
  return { startMs: r.startMs, endMs: r.endMs };
}

/** Reactive version of {@link effectiveWorkRange} for React components. */
export function useWorkRange(compId: string): { startMs: number; endMs: number } | null {
  const enabled = useSession((s) => s.workRangeEnabled);
  const range = useSession((s) => s.workRange);
  if (!enabled || !range || range.compId !== compId || range.endMs - range.startMs < MIN_SPAN_MS) return null;
  return { startMs: range.startMs, endMs: range.endMs };
}

/**
 * Master toggle. Turning it on with no range yet lays down a full-length one
 * (0 → the comp's end bar) so the brackets are immediately visible to drag;
 * turning it off keeps the values for next time.
 */
export function toggleWorkRange(doc: MotionDocument, compId: string): void {
  const s = useSession.getState();
  const next = !s.workRangeEnabled;
  if (next && (!s.workRange || s.workRange.compId !== compId)) {
    s.setWorkRange({ compId, startMs: 0, endMs: Math.round(compDurationMs(doc, compId)) });
  }
  s.setWorkRangeEnabled(next);
}

/**
 * Set the in (`start`) or out (`end`) bound at a time. Toggling a bound that
 * already sits there resets it to the extreme (start→0, end→comp end) — the
 * "[ removes it if already at that time" behaviour. Always leaves a valid,
 * non-inverted span and turns the range on.
 */
export function setWorkRangeBound(
  doc: MotionDocument,
  compId: string,
  bound: "start" | "end",
  ms: number,
): void {
  const s = useSession.getState();
  const compEnd = Math.round(compDurationMs(doc, compId));
  const base =
    s.workRange && s.workRange.compId === compId
      ? { startMs: s.workRange.startMs, endMs: s.workRange.endMs }
      : { startMs: 0, endMs: compEnd };
  const at = Math.max(0, Math.round(ms));

  if (bound === "start") {
    const already = Math.abs(base.startMs - at) < MIN_SPAN_MS / 2;
    base.startMs = already ? 0 : Math.min(at, base.endMs - MIN_SPAN_MS);
  } else {
    const already = Math.abs(base.endMs - at) < MIN_SPAN_MS / 2;
    base.endMs = already ? compEnd : Math.max(at, base.startMs + MIN_SPAN_MS);
  }

  s.setWorkRange({ compId, startMs: base.startMs, endMs: base.endMs });
  s.setWorkRangeEnabled(true);
}

