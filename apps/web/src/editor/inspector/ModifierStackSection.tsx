"use client";

import {
  Blend,
  Bomb,
  Box,
  Check,
  Combine,
  Copy,
  Droplet,
  FlipHorizontal2,
  Globe,
  Grid3x3,
  Layers,
  ListOrdered,
  Rotate3d,
  Shrink,
  Sparkles,
  Spline,
  Squircle,
  Triangle,
  TriangleRight,
  Waves,
  Route,
  Magnet,
  Anchor,
  Mountain,
  RefreshCcw,
  Boxes,
  Cuboid,
  Sprout,
  MonitorOff,
  Monitor,
  type LucideIcon,
} from "lucide-react";
import { MDF, addLattice, applyModifier, locateClip, type Modifier, type VisualClip } from "@solomotion/core";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { measuredBounds } from "../world/state";
import type { EffectMenuItem } from "./effect-add-menu";
import { EffectStackSection } from "./effect-stack/EffectStackSection";
import type { EffectStackHost } from "./effect-stack/host";
import { useStackFan } from "./effect-stack/use-stack-fan";

/**
 * An object's MODIFIER stack — a mesh's, or a 2D layer's body in a world — the `geometry` domain of the one effect registry,
 * so it is the Effects panel's own section with a different host: the same
 * cards, drag-sort, floating editor with sliders and keyframes, presets and
 * looks, copy/paste and multi-selection. Only the list it edits and the icons
 * differ.
 */

/** One glyph per modifier kind. Icons live in the web; core stays headless. */
const MDF_ICON: Record<string, LucideIcon> = {
  subdivision: Blend,
  mirror: FlipHorizontal2,
  array: Copy,
  solidify: Layers,
  bevel: Squircle,
  triangulate: TriangleRight,
  twist: Rotate3d,
  bend: Spline,
  taper: Triangle,
  wave: Waves,
  noise: Sparkles,
  smooth: Droplet,
  spherify: Globe,
  particles: Sparkles,
  weld: Combine,
  decimate: Shrink,
  wireframe: Grid3x3,
  build: ListOrdered,
  explode: Bomb,
  curve: Route,
  shrinkwrap: Magnet,
  hook: Anchor,
  displace: Mountain,
  screw: RefreshCcw,
  remesh: Boxes,
  lattice: Cuboid,
  scatter: Sprout,
};

/** A kind from a newer build renders as a generic card, never a crash. */
export function modifierIcon(type: string): LucideIcon {
  return MDF_ICON[type] ?? Box;
}

export function ModifierStackSection({ clips }: { clips: VisualClip[] }) {
  const host = useModifierHost(clips);
  return <EffectStackSection host={host} />;
}

function useModifierHost(clips: VisualClip[]): EffectStackHost<Modifier> {
  const store = useDocStore();
  const clip = clips[0]!;
  // APPLY bakes the stack through a card into a mesh's polygons, at the
  // playhead (core `applyModifier`). A layer's body is rebuilt from the layer
  // every frame, so it has nothing to bake into; a file model neither.
  const apply = (m: Modifier) =>
    store.update(`Apply ${MDF.def(m.type)?.label ?? "modifier"}`, (d) => {
      const at = useSession.getState().playheadMs;
      for (const { id } of clips) {
        const c = locateClip(d, id)?.clip;
        if (c?.kind === "mesh") applyModifier(c, m.id, Math.max(0, at - c.startMs));
      }
    });
  const applyBlocked = clips.some((c) => c.kind !== "mesh")
    ? "Apply bakes into a mesh's polygons — a layer's body is rebuilt from the layer"
    : clips.some((c) => c.kind === "mesh" && c.geometry.type === "asset")
      ? "An imported model's polygons stay the file's"
      : undefined;
  const fan = useStackFan<Modifier>({
    clips,
    registry: MDF,
    read: (c) => (c as VisualClip).modifiers ?? [],
    write: (c, list) => {
      if (c.kind !== "audio") (c as VisualClip).modifiers = list.length ? list : c.kind === "mesh" ? [] : undefined;
    },
  });
  const items: EffectMenuItem[] = MDF.types.map((def) => ({
    type: def.type,
    label: def.label,
    blurb: def.blurb,
    keywords: def.tags,
    category: def.category,
    icon: modifierIcon(def.type),
  }));
  return {
    registry: MDF,
    domain: "geometry",
    icon: modifierIcon,
    key: clip.id,
    clip,
    canKey: true,
    effects: fan.effects,
    shared: fan.shared,
    palette: { items, heading: clip.kind === "mesh" ? "For this mesh" : "For this layer" },
    kinds: clips.map((c) => c.kind),
    update: fan.update,
    // A Lattice brings its cage: fitted round each object, riding it, read by the card.
    add: (type) => {
      if (type !== "lattice") return null;
      let first: string | null = null;
      store.update("Add Lattice", (d) => {
        for (const { id } of clips) {
          const made = addLattice(d, id, { bounds: measuredBounds(id) });
          first ??= made?.modifierId ?? null;
        }
      });
      return first;
    },
    commit: fan.commit,
    setToggle: fan.setToggle,
    transfer: { domain: "modifiers", clipIds: clips.map((c) => c.id) },
    title: "Modifiers",
    sectionId: "modifiers",
    addLabel: "Add modifier",
    noun: "modifier",
    cardActions: (m) => [
      // Blender's monitor toggle: a heavy card (a high subdivision, a remesh)
      // can sit out of the viewport while you work and still render.
      {
        id: "viewport",
        label: m.viewport === false ? "Show in viewport" : "Hide in viewport (still renders)",
        icon: m.viewport === false ? Monitor : MonitorOff,
        run: () =>
          fan.update(m.viewport === false ? "Show modifier in viewport" : "Hide modifier in viewport", (list) =>
          list.map((x) => {
            if (x.id !== m.id) return x;
            // Shown is the absence of the flag — never an `undefined` left in the file.
            const { viewport: was, ...rest } = x;
            return (was === false ? rest : { ...rest, viewport: false }) as Modifier;
          }),
        ),
      },
      {
        id: "apply",
        label: clip.kind === "mesh" && (clip.modifiers[0]?.id ?? m.id) !== m.id ? "Apply (with the ones above)" : "Apply",
        icon: Check,
        disabledReason: applyBlocked,
        run: () => apply(m),
      },
    ],
  };
}
