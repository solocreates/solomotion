"use client";

import * as React from "react";
import {
  TFX,
  sharedList,
  type TextClip,
  type TextEffect,
  type TextEffectType,
} from "@solomotion/core";
import { Box, Layers2, Repeat, Sparkles, type LucideIcon } from "lucide-react";
import { useBuiltinPresetNames } from "./LayerEffectsSection";
import type { EffectMenuItem } from "./effect-add-menu";
import { EffectStackSection } from "./effect-stack/EffectStackSection";
import type { EffectStackHost } from "./effect-stack/host";
import { useStackFan } from "./effect-stack/use-stack-fan";
import { DomainRevert, useScope, type ScopeTarget } from "./scope";

/**
 * TEXT EFFECTS — the per-glyph passes, as a HOST for the one effect stack.
 *
 * They sit under Design as well as under Effects because they belong in both:
 * they are typography (they follow the glyph, the font size, the per-letter
 * animation), and they are effects (cards, keyframes, modulators, presets,
 * looks — the identical section the layer stack renders). What differs is
 * where the list lives — the text STYLE, so a range or a caption's focused
 * word can carry its own — and that is entirely this file's business.
 *
 * Two hosts, one component:
 *
 *   base    the clip's own stack (one clip, or every selected text clip —
 *           writes fan through the same index-parallel replay the layer stack
 *           uses, so a multi-selection of titles edits as one)
 *   scoped  a focus or range: the RESOLVED stack, written back through the
 *           scope seam, which turns it into added / removed / overridden
 *           entries. Nothing keys here — a scope has no timeline of its own.
 */

/** One glyph per kind — exhaustive so a new kind fails the build here. */
const TFX_ICON: Record<TextEffectType, LucideIcon> = {
  shadow: Layers2,
  glow: Sparkles,
  extrude: Box,
  echo: Repeat,
};

function textEffectIcon(type: string): LucideIcon {
  return TFX_ICON[type as TextEffectType] ?? Sparkles;
}

/**
 * The per-glyph stack, pointed at whatever the scope strip is pointed at.
 *
 * A one-line wrapper because the registry renders sections, not hooks, and
 * `useScope` has to be called inside a component. Several texts at once have
 * no single scope to speak for them, so that case edits the layer — which is
 * also the only thing the strip offers there.
 */
export function TextEffectsForScope({ clips }: { clips: TextClip[] }) {
  const scope = useScope();
  return <TextEffectsSection clips={clips} scope={clips.length === 1 ? scope : null} defaultOpen />;
}

export function TextEffectsSection({
  clips,
  scope,
  defaultOpen,
}: {
  clips: TextClip[];
  /** Where writes land; null edits the layer (a multi-selection has no scope). */
  scope: ScopeTarget | null;
  defaultOpen?: boolean;
}) {
  const scoped = scope && !scope.isBase ? scope : null;
  const base = useTextEffectHost(clips);
  const host = scoped ? scopedHost(scoped, base) : base;
  return <EffectStackSection host={host} defaultOpen={defaultOpen} />;
}

function useTextEffectHost(clips: TextClip[]): EffectStackHost<TextEffect> {
  const clip = clips[0]!;
  const fan = useStackFan<TextEffect>({
    clips,
    registry: TFX,
    read: (c) => (c.kind === "text" ? c.style.textEffects : []),
    write: (c, list) => {
      if (c.kind === "text") c.style.textEffects = list;
    },
  });
  const presetNames = useBuiltinPresetNames(TFX);
  const items: EffectMenuItem[] = TFX.types.map((def) => ({
    type: def.type,
    label: def.label,
    blurb: def.blurb,
    keywords: [...(def.tags ?? []), ...(presetNames.get(def.type) ?? [])],
    category: def.category,
    icon: textEffectIcon(def.type),
  }));
  return {
    registry: TFX,
    domain: "text",
    icon: textEffectIcon,
    key: clip.id,
    clip,
    canKey: true,
    effects: fan.effects,
    shared: fan.shared,
    palette: { items, heading: "For this text" },
    kinds: ["text"],
    update: fan.update,
    commit: fan.commit,
    setToggle: fan.setToggle,
    transfer: { domain: "textEffects", clipIds: clips.map((c) => c.id) },
    title: "Text effects",
    sectionId: "text-effects",
    addLabel: "Add text effect",
    noun: "text effect",
  };
}

/**
 * The same host pointed at an OVERRIDE scope. The list is what the scope
 * resolves to; every write goes through the scope seam, which already knows
 * how to express "this focus has its own glow" and "this range removes the
 * layer's shadow". The base host supplies everything that does not depend on
 * where the list lives (icons, palette, copy).
 */
function scopedHost(scope: ScopeTarget, base: EffectStackHost<TextEffect>): EffectStackHost<TextEffect> {
  const effects = scope.resolved.style.textEffects;
  return {
    ...base,
    key: `${base.clip.id}:scope`,
    canKey: false,
    effects,
    shared: sharedList([effects]),
    update: (label, fn, mk) => scope.writeStyle({ textEffects: fn([...effects]) }, label, mk),
    commit: (effect, field, value, label, mk) => scope.write(TFX.path(effect.id, field), value, label, mk),
    setToggle: (effect, key, value, label) =>
      scope.writeStyle(
        { textEffects: effects.map((e) => (e.id === effect.id ? { ...e, [key]: value } : e)) },
        label,
      ),
    transfer: undefined,
    headerExtra: <DomainRevert domain="textEffects" title="Text effects" />,
  };
}
