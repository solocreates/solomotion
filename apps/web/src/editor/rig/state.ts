"use client";

import { create } from "zustand";
import type { WeightStroke } from "@solomotion/core";

/**
 * THE RIG UI — what is selected INSIDE a rig, and the weight brush.
 *
 * Bones are not layers, so they are not in the clip selection; the rig's group
 * is (it is the layer you selected, and its inspector hosts the bone's). This
 * holds which of its bones are picked. View state: never in the document,
 * never in history.
 */
export type WeightMode = WeightStroke["mode"];

/**
 * POSE or SETUP — Spine's Animate / Setup, Blender's Pose / Edit. In POSE the
 * art is grabbed by its bone: dragging a piece turns the bone it rides (the
 * joint stays put, the relation holds), dragging the piece a root hangs from
 * moves the whole rig. In SETUP the rig shows at rest and bones and art are
 * adjusted apart: drag a joint and the art stays, drag a piece and its bone
 * stays. The Bone tool (J) is setup with drawing.
 */
export type RigMode = "pose" | "setup";

/**
 * HOW A DRAG POSES (Characters 3.0) — the two grammars every rigging app has:
 *
 *   rotate  FK. A bone turns about its head; its children ride along.
 *   reach   IK on the fly (Blender's Auto IK, Moho's bone drag). Grab any
 *           bone and pull: its tip follows the pointer and the chain above it
 *           bends to let it — up to `chain` bones, stopping at a PINNED one,
 *           which holds its place. A leg follows its foot.
 */
export type PoseGrammar = "rotate" | "reach";

export interface RigUi {
  mode: RigMode;
  setMode(mode: RigMode): void;
  /** The rig whose bones are picked (its group id). */
  rigId: string | null;
  /** Picked bones, the ACTIVE one last. */
  bones: string[];
  /** Painting weights: the layer being painted and the bone it paints. */
  paint: { clipId: string; bone: string } | null;
  brush: { mode: WeightMode; radius: number; strength: number };
  selectBones(rigId: string | null, ids: string[], additive?: boolean): void;
  startPaint(clipId: string, bone: string): void;
  stopPaint(): void;
  setBrush(patch: Partial<RigUi["brush"]>): void;
  /** How a drag poses (see `PoseGrammar`). */
  grammar: PoseGrammar;
  setGrammar(g: PoseGrammar): void;
  /** How many bones a reach bends, the grabbed one included ([ and ] change it). */
  chain: number;
  setChain(n: number): void;
  /** Pinned bones per rig: a reach stops below them; they hold. */
  pins: Record<string, string[]>;
  togglePins(rigId: string, ids: string[]): void;
}

export const useRigUi = create<RigUi>((set) => ({
  mode: "pose",
  setMode: (mode) => set({ mode }),
  rigId: null,
  bones: [],
  paint: null,
  brush: { mode: "add", radius: 40, strength: 0.5 },
  selectBones: (rigId, ids, additive = false) =>
    set((s) => {
      if (!additive || s.rigId !== rigId) return { rigId, bones: ids };
      const next = s.bones.slice();
      for (const id of ids) {
        const at = next.indexOf(id);
        // ⇧ on the active bone drops it; on another, makes it active.
        if (at >= 0 && at === next.length - 1) next.splice(at, 1);
        else {
          if (at >= 0) next.splice(at, 1);
          next.push(id);
        }
      }
      return { rigId, bones: next };
    }),
  startPaint: (clipId, bone) => set({ paint: { clipId, bone } }),
  stopPaint: () => set({ paint: null }),
  setBrush: (patch) => set((s) => ({ brush: { ...s.brush, ...patch } })),
  grammar: "reach",
  setGrammar: (grammar) => set({ grammar }),
  chain: 3,
  setChain: (n) => set({ chain: Math.max(1, Math.min(16, Math.round(n))) }),
  pins: {},
  togglePins: (rigId, ids) =>
    set((s) => {
      const now = new Set(s.pins[rigId] ?? []);
      const allPinned = ids.every((id) => now.has(id));
      for (const id of ids) {
        if (allPinned) now.delete(id);
        else now.add(id);
      }
      return { pins: { ...s.pins, [rigId]: [...now] } };
    }),
}));
