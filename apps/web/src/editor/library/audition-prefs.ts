"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_EAR_GUARD, type EarGuard } from "@solomotion/core";
import { NAMES } from "@/editor/names";

/**
 * HOW LOUD A CATALOGUE IS ALLOWED TO BE — wherever you are listening to it.
 *
 * This lived in the Sound Effects plugin's own preferences, which made it a
 * fact about a PANEL. It is not: it is a fact about the person wearing the
 * headphones, and it was wrong in the most consequential way a preference can
 * be wrong — the ear guard ran in the sound browser and nowhere else. The
 * Library browser and the inspector's sound picker played the same online
 * files, from the same catalogue, at raw volume. Somebody who had turned the
 * guard on and trusted it got ambushed by the two surfaces that never asked.
 *
 * So the guard belongs beside `auditionItem`, one layer below any browser, and
 * every surface that can play a sound it does not own reads it from here.
 *
 * Device-local and outside any document, like every monitoring decision: how
 * loud you listen is not an artistic choice and must never be baked into what
 * you export. See `ADR-sound-archive.md` §5 for why this is a CEILING and not
 * a normaliser — equalising two loud sounds would destroy the one thing you
 * are auditioning for.
 */

export const AUDITION_DEFAULTS = {
  volume: 0.8,
  guard: DEFAULT_EAR_GUARD,
};

interface AuditionPrefs {
  volume: number;
  guard: EarGuard;
  setVolume: (volume: number) => void;
  setGuard: (patch: Partial<EarGuard>) => void;
  reset: () => void;
}

export const useAuditionPrefs = create<AuditionPrefs>()(
  persist(
    (set) => ({
      ...AUDITION_DEFAULTS,
      setVolume: (volume) => set({ volume }),
      setGuard: (patch) => set((s) => ({ guard: { ...s.guard, ...patch } })),
      reset: () => set(AUDITION_DEFAULTS),
    }),
    {
      name: NAMES.storage.auditionPrefs,
      version: 1,
      /**
       * Adopt the settings from where they used to live.
       *
       * Read once on first run, never written back — the same shape `marks`
       * uses to fold in the two favourites lists it replaced. Leaving the old
       * key alone means a downgrade still finds its data, and means this is a
       * one-way read rather than two stores that can disagree.
       */
      onRehydrateStorage: () => (state) => {
        if (!state || typeof window === "undefined") return;
        if (window.localStorage.getItem(NAMES.storage.auditionPrefs)) return;
        try {
          const old = JSON.parse(window.localStorage.getItem(NAMES.storage.legacySfxPrefs) ?? "null");
          const held = old?.state;
          if (!held) return;
          if (typeof held.volume === "number") state.setVolume(held.volume);
          if (held.guard) state.setGuard(held.guard);
        } catch {
          /* a preference is not worth failing a boot over */
        }
      },
    },
  ),
);

/** Read the current monitoring settings outside React — what `auditionItem` needs. */
export const auditionPrefs = () => useAuditionPrefs.getState();
