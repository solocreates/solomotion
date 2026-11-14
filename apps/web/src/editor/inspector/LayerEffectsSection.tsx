"use client";

import * as React from "react";
import {
  CLIP_KINDS,
  LFX,
  effectIsSpecificTo,
  type LayerEffect,
  type LayerEffectType,
  type VisualClip,
} from "@solomotion/core";
import {
  AlignJustify,
  Antenna,
  Aperture,
  AudioWaveform,
  Blend,
  Box,
  Bug,
  CircleDot,
  Combine,
  Disc3,
  Droplets,
  Film,
  Flame,
  Flashlight,
  Focus,
  Frame,
  Grid3x3,
  Grip,
  Layers2,
  MoveUpRight,
  Orbit,
  PaintBucket,
  Palette,
  Workflow,
  Plus,
  ScanSearch,
  SlidersHorizontal,
  Sparkles,
  Spline,
  PencilLine,
  SplitSquareHorizontal,
  Sun,
  SunMedium,
  Tornado,
  Tv,
  Wand2,
  Waves,
  Wind,
  Zap,
  ZoomIn,
  type LucideIcon,
  CloudFog,
  Mountain,
  SunDim,
  Stars,
  Cloudy,
  Radio,
  Scroll,
} from "lucide-react";
import { ensureEffectPasses } from "../stage/render/passes/registry";
import { ColorGradeBody } from "./ColorGradeCard";
import { DepthNeeded } from "../tracking/DepthTrackCard";
import { GradeCardBody } from "../color/GradeCardBody";
import type { EffectMenuItem } from "./effect-add-menu";
import { EffectStackSection } from "./effect-stack/EffectStackSection";
import type { EffectStackHost } from "./effect-stack/host";
import { useStackFan } from "./effect-stack/use-stack-fan";
import { usePresets } from "./effect-editor/use-presets";

/**
 * The layer-effect stack — one section EVERY visual layer shows (text, images,
 * video, shapes, paths, nested comps). Cards render from the core registry and
 * apply strictly top-to-bottom (AE-style: the stack IS the node graph), so
 * they drag-sort and EVERY type can repeat — e.g. one Chroma key card per
 * color, or stacked Color grade nodes. Every field keyframes through
 * `lfx.<id>.<field>`. The section itself is the shared `EffectStackSection`;
 * this file is the layer HOST for it plus the icon table.
 */

/**
 * One glyph per effect kind. `Record<LayerEffectType, …>` rather than a partial
 * map on purpose: it is the ONLY thing that makes adding an effect to the core
 * registry fail the web build until this file has been told what it looks like.
 * A partial map compiles, then renders `undefined` as a component and takes the
 * whole panel down at runtime — which is exactly what it did once.
 *
 * The icons live here and not on the registry because `packages/core` is
 * headless: a lucide icon is a React component, and shipping one from core
 * would put React in the file the exporter and the tests import.
 */
const LFX_ICON: Record<LayerEffectType, LucideIcon> = {
  fog: CloudFog,
  lensBlur: Aperture,
  depthMatte: Mountain,
  shadow: Layers2,
  stroke: Spline,
  group: Layers2,
  longShadow: MoveUpRight,
  innerShadow: Frame,
  glow: Sparkles,
  rgbSplit: SplitSquareHorizontal,
  blur: Droplets,
  adjust: SlidersHorizontal,
  chromaKey: Wand2,
  colorGrade: Palette,
  grade: Workflow,
  vignette: Aperture,
  sharpen: Focus,
  grain: Grip,
  directionalBlur: Wind,
  zoomBlur: ScanSearch,
  glass: Waves,
  filmDamage: Film,
  scanlines: Tv,
  noise: Antenna,
  spinBlur: Disc3,
  gradientMap: Blend,
  posterize: AlignJustify,
  overlay: PaintBucket,
  shine: Flashlight,
  lightRays: SunMedium,
  lensFlare: Sun,
  lens: Orbit,
  shockwave: Radio,
  star: SunDim,
  starfield: Stars,
  nebula: Cloudy,
  surface: Scroll,
  lightning: Zap,
  bulge: ZoomIn,
  wave: AudioWaveform,
  twirl: Tornado,
  lensDistort: Orbit,
  roughenEdges: Flame,
  boil: PencilLine,
  goo: Combine,
  glitch: Bug,
  halftone: CircleDot,
  pixelate: Grid3x3,
  bevel: Box,
};

/**
 * The lookup, with a floor under it. The Record above is exhaustive at compile
 * time, but a DOCUMENT is not type-checked: an effect kind from a newer build,
 * or one a migration has not reached yet, must render as a generic card rather
 * than crash the inspector.
 */
export function effectIcon(type: LayerEffectType): LucideIcon {
  return LFX_ICON[type] ?? Sparkles;
}

/**
 * The layer-effect stack: one HOST for the generic `EffectStackSection` —
 * the list is `clip.effects`, writes fan across every selected visual layer,
 * and the palette is the registry filtered to what every selected kind may
 * carry. `flush` renders it as a tab body. Same component, same writes, two
 * homes: the Effects tab, and (collapsed) any panel that wants it inline.
 */
export function LayerEffectsSection({ clips, flush, looks }: { clips: VisualClip[]; flush?: boolean; looks?: boolean }) {
  const host = useLayerEffectHost(clips);
  return <EffectStackSection host={host} flush={flush} looks={looks} />;
}

/**
 * Effects are a pass over the WHOLE LAYER — `withLayer` rasterises the layer
 * once and runs the stack over those pixels — so unlike typography, fill,
 * stroke and the highlight pill, they cannot currently differ per scope. The
 * DOCUMENT can express a scoped stack (`ScopeOverlay.added` / `removed` /
 * `lfx.<id>.<field>`, and `resolveOverlay` resolves one); the RENDERER cannot
 * yet, because per-scope effects mean drawing the layer once per distinct
 * stack and compositing the results.
 *
 * So this host is honest rather than clever: it always edits the layer, and
 * the scope bar hides on the Effects tab instead of offering a switch that
 * would change the document without changing the picture.
 */
function useLayerEffectHost(clips: VisualClip[]): EffectStackHost<LayerEffect> {
  const clip = clips[0]!;
  const fan = useStackFan<LayerEffect>({
    clips,
    registry: LFX,
    read: (c) => (c.kind === "audio" ? [] : c.effects),
    write: (c, list) => {
      if (c.kind !== "audio") c.effects = list;
    },
  });

  // `addableTo` is the registry's own answer, so "which effects may this
  // selection carry" is asked in one place instead of re-derived per surface.
  // A mixed selection narrows to the intersection: an effect has to be legal
  // for every layer in it, or adding would silently skip some.
  const kinds = clips.map((c) => c.kind);
  // A built-in preset is not a row — it is a LOOK OF an effect, and listing all
  // of them turned one Liquid glass into ten near-identical entries that made
  // the palette read like sixty effects. They live in the card's own preset
  // picker, one click after adding, which is where you can actually compare
  // them. What survives here is their NAMES as search synonyms, so typing
  // "neon" or "frosted" still lands you on Glow or Liquid glass.
  const presetNames = useBuiltinPresetNames(LFX);
  const items: EffectMenuItem[] = LFX.addableTo(kinds).map((def) => ({
    type: def.type,
    label: def.label,
    blurb: def.blurb,
    keywords: [...(def.tags ?? []), ...(presetNames.get(def.type) ?? [])],
    category: def.category,
    icon: effectIcon(def.type),
    specific: effectIsSpecificTo(def, kinds),
  }));
  // "For this image" reads better than "For this layer" when the selection is
  // one kind, and a mixed selection has no one noun to use.
  const uniqueKind = kinds.every((k) => k === kinds[0]) ? kinds[0] : undefined;
  const heading = uniqueKind ? `For this ${CLIP_KINDS[uniqueKind].label.toLowerCase()}` : "For this selection";

  return {
    registry: LFX,
    domain: "layer",
    icon: (t) => effectIcon(t as LayerEffectType),
    key: clip.id,
    clip,
    canKey: true,
    effects: fan.effects,
    shared: fan.shared,
    palette: { items, heading },
    kinds,
    update: fan.update,
    commit: fan.commit,
    setToggle: fan.setToggle,
    prepare: (type) => void ensureEffectPasses([type as LayerEffectType]).catch(() => {}),
    transfer: { domain: "effects", clipIds: clips.map((c) => c.id) },
    // The grade card keeps its wheels — the editor hosts them instead of the
    // generated rows, so a bespoke UI costs one prop, not a parallel window.
    customBody: (effect) => {
      if (effect.type === "colorGrade") return <ColorGradeBody clip={clip} effect={effect} />;
      // The grade card is a DOORWAY, not a slider panel — its generated rows
      // would be one ("Mix") and would say nothing about the chain behind it.
      if (effect.type === "grade") return <GradeCardBody clip={clip} effect={effect} />;
      return undefined;
    },
    bodyLead: (effect) => (effect.type === "fog" || effect.type === "lensBlur" || effect.type === "depthMatte" ? <DepthNeeded clip={clip} source={effect.source} /> : undefined),
    title: "Effects",
    sectionId: "effects",
    addLabel: "Add layer effect",
    noun: "effect",
  };
}

/** Built-in preset names per effect type — search synonyms for the palette. */
export function useBuiltinPresetNames(registry: { types: Array<{ type: string }>; presetKind: (t: string) => string }): Map<string, string[]> {
  const { presets } = usePresets("");
  return React.useMemo(() => {
    const byKind = new Map(registry.types.map((d) => [registry.presetKind(d.type), d.type]));
    const out = new Map<string, string[]>();
    for (const p of presets) {
      if (p.scope !== "builtin") continue;
      const type = byKind.get(p.kind);
      if (!type) continue;
      (out.get(type) ?? out.set(type, []).get(type)!).push(p.name);
    }
    return out;
  }, [presets, registry]);
}
