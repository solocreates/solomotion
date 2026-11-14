"use client";

import type * as React from "react";
import { create } from "zustand";

/**
 * The headless notification bus — a reusable, positionable card stack that ANY
 * feature can push to (updates, long-running exports, plugin messages…). It is
 * deliberately separate from the bottom StatusBar (`@/lib/toast`): the status
 * bus is for ephemeral one-line status; this is for persistent, ACTIONABLE
 * cards with buttons and a close affordance, anchored to any screen corner.
 *
 * Presentation lives in <NotificationHost>; call sites only touch `notify()` /
 * `dismissNotification()` (imperative, like a toast lib) or this store directly.
 */

export type NotificationTone = "default" | "brand" | "success" | "warning" | "destructive";

/** Any of the six screen anchors a card can dock to. */
export type NotificationCorner =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface NotificationAction {
  label: string;
  onClick: () => void;
  variant?: "default" | "outline" | "ghost" | "secondary";
  /** Keep the card open after the click (default: dismiss it). */
  keepOpen?: boolean;
}

export interface NotificationInput {
  /** Stable id — pass a known one to update a card in place; auto-generated otherwise. */
  id?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  tone?: NotificationTone;
  /** Which corner to dock to. Defaults to bottom-right. */
  corner?: NotificationCorner;
  icon?: React.ReactNode;
  actions?: NotificationAction[];
  /** Auto-dismiss after N ms. Omit / 0 = sticky until the user closes it. */
  duration?: number;
  /** Show the ✕ close button (default true). */
  dismissible?: boolean;
  /** Fired once when the card leaves (user close, auto-dismiss, or programmatic). */
  onDismiss?: () => void;
}

export interface NotificationEntry extends NotificationInput {
  id: string;
  tone: NotificationTone;
  corner: NotificationCorner;
  dismissible: boolean;
  /** True while animating out — the host removes it when the transition ends. */
  leaving: boolean;
  ts: number;
}

interface NotificationState {
  items: NotificationEntry[];
  /** Push (or, with a known id, replace) a card. Returns its id. */
  notify: (input: NotificationInput) => string;
  /** Patch an existing card in place (e.g. progress → done). No-op if unknown. */
  update: (id: string, patch: Partial<Omit<NotificationInput, "id">>) => void;
  /** Begin the exit animation; the host calls {@link remove} when it finishes. */
  dismiss: (id: string) => void;
  /** Hard-remove after the exit animation; fires the entry's onDismiss once. */
  remove: (id: string) => void;
  clear: () => void;
}

let seq = 0;

export const useNotifications = create<NotificationState>((set, get) => ({
  items: [],
  notify: (input) => {
    const id = input.id ?? `nt_${++seq}`;
    set((s) => {
      const entry: NotificationEntry = {
        tone: "default",
        corner: "bottom-right",
        dismissible: true,
        ...input,
        id,
        leaving: false,
        ts: Date.now(),
      };
      const at = s.items.findIndex((e) => e.id === id);
      if (at >= 0) {
        const items = s.items.slice();
        items[at] = { ...entry, ts: items[at]!.ts };
        return { items };
      }
      return { items: [...s.items, entry] };
    });
    return id;
  },
  update: (id, patch) =>
    set((s) => {
      const at = s.items.findIndex((e) => e.id === id);
      if (at < 0) return s;
      const items = s.items.slice();
      items[at] = { ...items[at]!, ...patch };
      return { items };
    }),
  dismiss: (id) =>
    set((s) => ({
      items: s.items.map((e) => (e.id === id ? { ...e, leaving: true } : e)),
    })),
  remove: (id) => {
    const entry = get().items.find((e) => e.id === id);
    entry?.onDismiss?.();
    set((s) => ({ items: s.items.filter((e) => e.id !== id) }));
  },
  clear: () => set((s) => ({ items: s.items.map((e) => ({ ...e, leaving: true })) })),
}));

/** Imperative helper, mirroring the `toast(...)` ergonomics. */
export function notify(input: NotificationInput): string {
  return useNotifications.getState().notify(input);
}

export function dismissNotification(id: string): void {
  useNotifications.getState().dismiss(id);
}
