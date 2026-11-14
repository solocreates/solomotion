"use client";

import * as React from "react";
import type { Modulator } from "@solomotion/core";
import { NAMES } from "@/editor/names";

/**
 * THE modulator clipboard — one shake, copied onto another field.
 *
 * A modulator minus its identity (`id`) and its address (`target`) is a
 * SETTING: "wiggle ±20 at 2/s, roughened". That is the thing worth moving
 * around, and it is worth moving between windows and between projects, so it
 * goes to the system clipboard as JSON rather than living only in this tab.
 *
 * The in-memory copy is not a cache of that — it is what makes the paste item
 * know whether it has anything to paste WITHOUT an async read on every menu
 * open (the permission prompt that would cause is worse than the feature). The
 * system clipboard is consulted at paste time, and wins when it holds ours,
 * which is what makes copy-here-paste-there work across two editor windows.
 */

/** Everything but identity and address — what a copied modulator is. */
export type ModulatorPatch = Omit<Modulator, "id" | "target">;

/** Our envelope, so a paste can tell our JSON from any other text. */
const ENVELOPE = NAMES.wire.modulators;

interface Envelope {
  kind: typeof ENVELOPE;
  modulators: ModulatorPatch[];
}

let held: ModulatorPatch[] | null = null;
const listeners = new Set<() => void>();

function announce() {
  for (const fn of listeners) fn();
}

/** Strip identity and address; keep the settings. */
export function toPatch(m: Modulator): ModulatorPatch {
  const { id: _id, target: _target, ...patch } = m;
  return patch;
}

export function copyModulators(mods: readonly Modulator[]) {
  held = mods.map(toPatch);
  announce();
  const payload: Envelope = { kind: ENVELOPE, modulators: held };
  void navigator.clipboard?.writeText(JSON.stringify(payload)).catch(() => {
    // Denied or unavailable — the in-memory copy still works in this tab.
  });
}

/** What a paste would produce right now, preferring the system clipboard. */
export async function readModulators(): Promise<ModulatorPatch[] | null> {
  try {
    const text = await navigator.clipboard?.readText();
    if (text) {
      const parsed = JSON.parse(text) as Partial<Envelope>;
      if (parsed?.kind === ENVELOPE && Array.isArray(parsed.modulators) && parsed.modulators.length > 0) {
        return parsed.modulators;
      }
    }
  } catch {
    // Not JSON, not ours, or read denied — fall through to what we hold.
  }
  return held;
}

/** Whether the paste action should be offered at all. */
export function useCanPasteModulator(): boolean {
  return React.useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => held !== null,
    () => false,
  );
}
