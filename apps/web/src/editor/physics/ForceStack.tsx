"use client";

import { Magnet, Snail, Tornado, Waves, Wind, Zap, type LucideIcon } from "lucide-react";
import { FORCE, type ForceSpec, type VisualClip } from "@solomotion/core";
import type { EffectMenuItem } from "../inspector/effect-add-menu";
import { EffectStackSection } from "../inspector/effect-stack/EffectStackSection";
import type { EffectStackHost } from "../inspector/effect-stack/host";
import { useStackFan } from "../inspector/effect-stack/use-stack-fan";

/**
 * A layer's FORCES — the `force` domain of the one effect registry, so it is
 * the Effects panel's own section with a different host: cards you drag to
 * reorder, duplicate, mute and key, the floating editor, presets and looks,
 * the same across a multi-selection. Forces add up, so the order is how the
 * stack reads; repeats are welcome (two winds at different angles).
 */

const ICON: Record<string, LucideIcon> = { wind: Wind, point: Magnet, vortex: Tornado, turbulence: Waves, drag: Snail };

export function forceIcon(type: string): LucideIcon {
  return ICON[type] ?? Zap;
}

export function ForceStackSection({ clips }: { clips: VisualClip[] }) {
  const host = useForceHost(clips);
  return <EffectStackSection host={host} />;
}

function useForceHost(clips: VisualClip[]): EffectStackHost<ForceSpec> {
  const clip = clips[0]!;
  const fan = useStackFan<ForceSpec>({
    clips,
    registry: FORCE,
    read: (c) => (c.kind === "audio" ? [] : (c.forces ?? [])),
    write: (c, list) => {
      if (c.kind !== "audio") c.forces = list.length ? list : undefined;
    },
  });
  const items: EffectMenuItem[] = FORCE.types.map((def) => ({
    type: def.type,
    label: def.label,
    blurb: def.blurb,
    keywords: def.tags,
    category: def.category,
    icon: forceIcon(def.type),
  }));
  return {
    registry: FORCE,
    domain: "force",
    icon: forceIcon,
    key: clip.id,
    clip,
    canKey: true,
    effects: fan.effects,
    shared: fan.shared,
    palette: { items, heading: "Forces" },
    kinds: clips.map((c) => c.kind),
    update: fan.update,
    commit: fan.commit,
    setToggle: fan.setToggle,
    transfer: { domain: "forces", clipIds: clips.map((c) => c.id) },
    title: "Forces",
    sectionId: "physics-forces",
    addLabel: "Add force",
    noun: "force",
  };
}
