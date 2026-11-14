"use client";

import { create } from "zustand";

/**
 * The headless status bus — one place every app message lands, shown by the
 * sticky bottom StatusBar (Blender-style) instead of floating toast popups.
 *
 * It is DELIBERATELY the same shape a toast library exposes (`kind` + `text` +
 * `description` + an optional stable `id`), so the `@/lib/toast` shim can route
 * every existing `toast(...)` / `toast.success(...)` call site here untouched —
 * only the presentation changes, never the call sites. Passing a known `id`
 * UPDATES that entry in place (a "loading" → "success"/"error" transition), the
 * one thing async flows rely on.
 *
 * A message may carry ONE `action`. That is what makes the bar able to OFFER
 * something rather than only announce it — "started a new part · Keep as one",
 * "that mark is far away · Split into parts" — without a modal interrupting
 * whatever the person is doing with a pen in their hand. One button, no menus:
 * a status line is not a dialog, and a second choice belongs in a dialog.
 *
 * Every line EXPIRES, by kind (`SHOW_MS`): the bar shows what is happening
 * now, and a two-minute-old "Cache full" reads as a live fault. Loading never
 * expires — its own success/error replaces it. Expiry clears the bar, never
 * the log, and a dismissed line never resurrects the one before it.
 */

export type StatusKind = "info" | "success" | "error" | "warning" | "loading";

/** A single offer attached to a message. Runs, then clears the message. */
export interface StatusAction {
  label: string;
  onClick: () => void;
}

export interface StatusEntry {
  id: string;
  kind: StatusKind;
  text: string;
  description?: string;
  action?: StatusAction;
  ts: number;
}

interface NotifyInput {
  kind: StatusKind;
  text: string;
  description?: string;
  action?: StatusAction;
  id?: string;
}

interface StatusBarState {
  /** Oldest → newest, capped — the history behind the latest line. */
  log: StatusEntry[];
  /** The message the bar currently shows (newest, or an in-place update). */
  latest: StatusEntry | null;
  notify: (input: NotifyInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const MAX_LOG = 100;
let seq = 0;

/** How long each kind holds the bar. An offer gets longer — it asks for a decision. */
const SHOW_MS: Record<StatusKind, number | null> = {
  success: 5000,
  info: 6000,
  warning: 8000,
  error: 10_000,
  loading: null,
};
const ACTION_MS = 10_000;

export function statusShowMs(e: Pick<StatusEntry, "kind" | "action">): number | null {
  const base = SHOW_MS[e.kind];
  return base === null ? null : e.action ? Math.max(base, ACTION_MS) : base;
}

let expiry: ReturnType<typeof setTimeout> | undefined;

export const useStatusBar = create<StatusBarState>((set, get) => ({
  log: [],
  latest: null,
  notify: (input) => {
    const id = input.id ?? `st_${++seq}`;
    set((s) => {
      const entry: StatusEntry = {
        id,
        kind: input.kind,
        text: input.text,
        description: input.description,
        action: input.action,
        ts: Date.now(),
      };
      const existing = s.log.findIndex((e) => e.id === id);
      let log: StatusEntry[];
      if (existing >= 0) {
        // In-place update (e.g. loading → success): keep position, refresh it.
        log = s.log.slice();
        log[existing] = entry;
      } else {
        log = [...s.log, entry];
        if (log.length > MAX_LOG) log = log.slice(log.length - MAX_LOG);
      }
      return { log, latest: entry };
    });
    clearTimeout(expiry);
    const ms = statusShowMs(get().latest!);
    if (ms !== null) {
      const shown = get().latest;
      expiry = setTimeout(() => {
        if (get().latest === shown) set({ latest: null });
      }, ms);
    }
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ log: s.log.filter((e) => e.id !== id), latest: s.latest?.id === id ? null : s.latest })),
  clear: () => {
    clearTimeout(expiry);
    set({ log: [], latest: null });
  },
}));
