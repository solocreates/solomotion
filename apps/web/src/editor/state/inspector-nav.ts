"use client";

import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ScopeAddress } from "@solomotion/core";
import { useSession, type InspectorTabId } from "./session";
import { usePanels } from "./panels";
import { NAMES } from "@/editor/names";

/**
 * INSPECTOR NAVIGATION — one way to say "show them THAT".
 *
 * The editor is full of gestures whose whole point is to land you somewhere in
 * the sidebar: clicking an animation badge on a clip edge, the stage's "Remove
 * background" pill, selecting the exact words a caption cue covers. Each one
 * used to reach in and set whatever piece of state it happened to know about —
 * `setInspectorTab` here, an `lfxFocusId` channel there, a `forceOpen` prop
 * somewhere else — so a gesture could open the right tab and still leave the
 * section it meant collapsed 900px down the scroll.
 *
 * A reveal is ONE value with four optional parts, and any surface can ask for
 * as much of it as it knows:
 *
 *     tab      which panel                     (the right rail's business)
 *     scope    which style target              (base / focus / a span)
 *     section  which section, by its stable id (scroll to it, pop it open)
 *     entry    which card inside it            (flash it once)
 *
 * `seq` is what makes it repeatable: asking for the same place twice must work
 * the second time, and an object that compares equal would not fire. Sections
 * subscribe by id, so ADDING an anchor is giving a section an id — there is no
 * registry of destinations to keep in sync with the panels that are actually
 * mounted.
 */
export interface RevealRequest {
  seq: number;
  tab?: InspectorTabId;
  scope?: ScopeAddress;
  /** `PanelSection`'s `id` — the anchor. */
  section?: string;
  /** An effect / paint / cue id within the section, to flash. */
  entry?: string;
}

interface NavStore {
  reveal: RevealRequest;
  request: (r: Omit<RevealRequest, "seq">) => void;
}

export const useInspectorNav = create<NavStore>((set, get) => ({
  reveal: { seq: 0 },
  request: (r) => set({ reveal: { ...r, seq: get().reveal.seq + 1 } }),
}));

/**
 * THE door. Sets the tab and the scope directly (they are session state that
 * other surfaces read), and publishes the section/entry for the panels to pick
 * up as they mount — a section that is not on screen yet cannot be scrolled to,
 * so the request outlives the frame that made it.
 */
export function revealInInspector(target: Omit<RevealRequest, "seq">): void {
  // A reveal is "show me", so a hidden sidebar comes back — otherwise every
  // door into the inspector silently does nothing in focus mode.
  const panels = usePanels.getState();
  if (!panels.isShown("inspector")) {
    if (panels.focusMode) panels.toggleFocusMode();
    panels.setVisible("inspector", true);
  }
  if (target.tab) useSession.getState().setInspectorTab(target.tab);
  if (target.scope) useSession.getState().setScopeAddress(target.scope);
  useInspectorNav.getState().request(target);
}

/**
 * "Am I the thing that was just revealed?" — for a ROW inside a section.
 *
 * `PanelSection` handles the section half (open it, scroll it in, flash the
 * header). This is the other grain: a specific fill, stroke or effect card that
 * the request named. Any row can become a navigation target by calling this and
 * painting the returned flag; there is no registry of targets to keep in step
 * with the rows that actually exist.
 */
export function useRevealFlash(id: string | undefined, ms = 1200): boolean {
  const reveal = useInspectorNav((s) => s.reveal);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!id || reveal.entry !== id) return;
    setOn(true);
    const el = document.querySelector<HTMLElement>(`[data-reveal-id="${CSS.escape(id)}"]`);
    const raf = requestAnimationFrame(() => el?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    const t = setTimeout(() => setOn(false), ms);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal.seq, id]);
  return on;
}

/**
 * Which sections are OPEN, remembered across sessions.
 *
 * Per SECTION, on the device — not per project and not per layer. A habit
 * ("I never touch Transform, I live in Effects") belongs to the person, not to
 * a document; and per-layer memory means the panel re-shuffles every time you
 * click a different layer, which is strictly worse than a stable one. The
 * section's own `defaultOpen` is the answer until you disagree with it once.
 */
interface SectionPrefs {
  open: Record<string, boolean>;
  setOpen: (id: string, open: boolean) => void;
}

export const useSectionPrefs = create<SectionPrefs>()(
  persist(
    (set) => ({
      open: {},
      setOpen: (id, open) => set((s) => ({ open: { ...s.open, [id]: open } })),
    }),
    { name: NAMES.storage.inspectorSections },
  ),
);
