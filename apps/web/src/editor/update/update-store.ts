"use client";

import { create } from "zustand";
import { type UpdateApplyKind, type UpdateManifest } from "@solomotion/platform";
import { platform } from "@/editor/platform";
import { isNewer } from "@solomotion/core";

/**
 * The app-wide update state machine. ONE source of truth the pill, the dialog,
 * and the first-detect notification all read. It owns no UI and no timers —
 * <UpdateChecker> drives the cadence (start + focus), this just fetches, compares
 * (via a product's releases reader), and applies (via the platform UpdatePort).
 *
 * Host-agnostic by construction: on the browser / remote desktop shell "apply"
 * reloads to the fresh build; on a native binary host it installs on relaunch —
 * the port hides that difference, we only read `applyKind` for the button label.
 */

export type UpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "applying"
  | "error";

interface UpdateState {
  phase: UpdatePhase;
  /** Running build; filled from the platform port on first check (client-only). */
  current: string;
  latest?: string;
  manifest?: UpdateManifest;
  applyKind: UpdateApplyKind;
  /** Native install download progress, 0‥1. Always 0 on reload hosts. */
  progress: number;
  dialogOpen: boolean;
  lastCheckedAt: number;
  /** True once an update is available and worth surfacing. */
  hasUpdate: () => boolean;
  check: () => Promise<void>;
  apply: () => Promise<void>;
  setProgress: (fraction: number) => void;
  setDialogOpen: (open: boolean) => void;
}

export const useUpdate = create<UpdateState>((set, get) => ({
  phase: "idle",
  current: "",
  latest: undefined,
  manifest: undefined,
  applyKind: "reload",
  progress: 0,
  dialogOpen: false,
  lastCheckedAt: 0,

  hasUpdate: () => {
    const { current, latest } = get();
    return Boolean(current && latest && isNewer(latest, current));
  },

  check: async () => {
    // Lazy, client-only reads — never touch the platform facade at module eval.
    const current = platform.update.current;
    const applyKind = platform.update.applyKind;
    if (get().phase !== "available") set({ phase: "checking", current, applyKind });
    else set({ current, applyKind });

    let manifest: UpdateManifest | null = null;
    try {
      manifest = await platform.update.checkLatest();
    } catch {
      manifest = null;
    }
    // A failed/absent check stays quiet: keep any prior "available", else current.
    if (!manifest) {
      set((s) => ({
        phase: s.phase === "available" ? "available" : "current",
        lastCheckedAt: Date.now(),
      }));
      return;
    }
    const available = isNewer(manifest.version, current);
    set({
      phase: available ? "available" : "current",
      latest: manifest.version,
      manifest,
      lastCheckedAt: Date.now(),
    });
  },

  apply: async () => {
    set({ phase: "applying" });
    try {
      // Reload never returns; install resolves once the binary is staged.
      await platform.update.apply();
    } catch {
      set({ phase: "available" });
    }
  },

  setProgress: (fraction) => set({ progress: Math.max(0, Math.min(1, fraction)) }),
  setDialogOpen: (open) => set({ dialogOpen: open }),
}));
