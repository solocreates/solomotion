"use client";

import { EMITTER, emitterLookOf, stackPresetFrom, subParentIndex, type EffectFieldOption, type EmitterSpec, type VisualClip } from "@solomotion/core";
import type { EffectMenuItem } from "../inspector/effect-add-menu";
import { EffectStackSection } from "../inspector/effect-stack/EffectStackSection";
import type { EffectStackHost } from "../inspector/effect-stack/host";
import { useStackFan } from "../inspector/effect-stack/use-stack-fan";
import { emitterIcon } from "./emitter-icons";

/**
 * A layer's PARTICLES — the `emitter` domain of the one effect registry, so it
 * is the Forces section's twin: cards you drag, duplicate, mute and key, the
 * floating editor, and the looks (Sparks, Confetti, Rain…) as its presets.
 * A sub-emitter's "From" lists the other cards by their place and kind.
 */

export function EmitterStackSection({ clips }: { clips: VisualClip[] }) {
  const host = useEmitterHost(clips);
  return <EffectStackSection host={host} />;
}

function useEmitterHost(clips: VisualClip[]): EffectStackHost<EmitterSpec> {
  const clip = clips[0]!;
  const fan = useStackFan<EmitterSpec>({
    clips,
    registry: EMITTER,
    read: (c) => (c.kind === "audio" ? [] : (c.emitters ?? [])),
    write: (c, list) => {
      if (c.kind !== "audio") c.emitters = list.length ? list : undefined;
    },
  });
  const items: EffectMenuItem[] = EMITTER.types.map((def) => ({
    type: def.type,
    label: def.label,
    blurb: def.blurb,
    keywords: def.tags,
    category: def.category,
    icon: emitterIcon(def.type),
  }));
  return {
    registry: EMITTER,
    domain: "emitter",
    icon: emitterIcon,
    key: clip.id,
    clip,
    canKey: true,
    effects: fan.effects,
    shared: fan.shared,
    palette: { items, heading: "Particles" },
    kinds: clips.map((c) => c.kind),
    update: fan.update,
    commit: fan.commit,
    setToggle: fan.setToggle,
    // A shell fitted to its comp's height is still the Firework shell.
    lookOf: (list) => stackPresetFrom(list.map((e) => { const look = emitterLookOf(e); return look?.reach ? { ...e, speed: look.patch.speed ?? e.speed, life: look.patch.life ?? e.life } : e; })),
    // A card in a look is called by it; a sub that is not says what sets it off.
    cardLabel: (e) => emitterLookOf(e)?.name ?? (e.type === "sub" ? (e.on === "hit" ? "Sub-emitter · on hit" : "Sub-emitter · on death") : undefined),
    refOptions: (e, field) => (field.ref === "emitter" ? parentOptions(fan.effects, e) : []),
    transfer: { domain: "emitters", clipIds: clips.map((c) => c.id) },
    title: "Particles",
    sectionId: "physics-emitters",
    addLabel: "Add particles",
    noun: "emitter",
  };
}

/** A sub-emitter's possible parents: every other card, numbered as the stack reads, the one it throws from now first-named. */
function parentOptions(list: readonly EmitterSpec[], self: EmitterSpec): EffectFieldOption[] {
  const i = list.findIndex((e) => e.id === self.id);
  const above = i >= 0 ? subParentIndex(list, i) : null;
  const name = (j: number) => `${j + 1} · ${emitterLookOf(list[j]!)?.name ?? EMITTER.def(list[j]!.type)?.label ?? list[j]!.type}`;
  return [
    { value: "", label: "The card above", ...(above !== null && !self.parent && { hint: name(above) }) },
    ...list.flatMap((e, j) => (e.id === self.id ? [] : [{ value: e.id, label: name(j) }])),
  ];
}
