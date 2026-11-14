import { clipAnimatableProperties } from "../animation/clip-properties";
import { createLayerEffect } from "../animation/layer-effects";
import type { LayerEffectType } from "../schema/layer-effects";
import { gradientColorAt } from "../animation/paint";
import { formatHexColor, parseHexColor } from "../animation/properties";
import { createId } from "../ids";
import type { KeyframeTrack } from "../schema/animation";
import type { Clip } from "../schema/clips";
import type { GradientStop, GradientType, Paint, StrokeStyle } from "../schema/vector";
import {
  isGradientPaint,
  mediaPaint,
  paintColors,
  patternPaint,
  solidPaint,
  strokeStyle,
} from "../schema/vector";

/**
 * STRUCTURAL OPS — the one pure module that RESHAPES a clip's data structure:
 * switch a paint's type (solid↔gradient↔media↔pattern), add/remove a fill,
 * stroke, effect or gradient stop. This is the deliberate counterpart to the
 * DRIVER system ([[drivers]]): drivers overlay VALUES onto an already-sampled
 * property map and can never change a discriminant or a list's length; structure
 * is an AUTHORING mutation — you *set* it, you don't keyframe it — so it lives
 * here as pure `(clip, …) => clip` and flows through the normal undo stack.
 *
 * ONE source of truth: both the inspector (Paint/Effects sections) and the node
 * board's structural affordances call these, so there is never a second, drifting
 * copy of "add a fill". Every op that drops a fill/effect/stop also PRUNES the now
 * orphaned keyframe tracks, and a type switch prunes tracks whose sub-property no
 * longer exists — decided headlessly by re-projecting the clip through
 * `clipAnimatableProperties`, so nothing is hand-listed and it stays correct as
 * the schema grows.
 */

/** Which paint list an op targets. */
export type PaintKind = "fill" | "stroke";
/** The paint discriminants a fill can be switched between. */
export type PaintType = Paint["type"];

// ── keyframe pruning ────────────────────────────────────────────────────────

/** True when a keyframe path belongs to the given paint entry (its own value
 *  track `fill.<id>` or any sub-property `fill.<id>.…`). */
function belongsToPaint(property: string, kind: PaintKind, id: string): boolean {
  const root = `${kind}.${id}`;
  return property === root || property.startsWith(`${root}.`);
}

/** True when a keyframe path belongs to the given effect (`lfx.<id>.…`). */
function belongsToEffect(property: string, id: string): boolean {
  return property.startsWith(`lfx.${id}.`);
}

/** Filter a clip's keyframe tracks, keeping identity if nothing changed. */
function pruneKeyframes(clip: Clip, keep: (t: KeyframeTrack) => boolean): Clip {
  if (!("keyframes" in clip) || !Array.isArray(clip.keyframes)) return clip;
  const keyframes = clip.keyframes.filter(keep);
  if (keyframes.length === clip.keyframes.length) return clip;
  return { ...clip, keyframes } as Clip;
}

// ── paint list: add / remove ────────────────────────────────────────────────

/** Append a fill or stroke (default: a neutral solid), returning a new clip. */
export function addPaint(clip: Clip, kind: PaintKind, paint?: Paint): Clip {
  if (kind === "fill") {
    if (!("fills" in clip) || !Array.isArray(clip.fills)) return clip;
    return { ...clip, fills: [...clip.fills, paint ?? solidPaint("#B0B4BB")] } as Clip;
  }
  if (!("strokes" in clip) || !Array.isArray(clip.strokes)) return clip;
  const stroke = strokeStyle(paint ?? solidPaint("#1E1E1E"), { width: 2 });
  return { ...clip, strokes: [...clip.strokes, stroke] } as Clip;
}

/** Remove a fill/stroke by id, pruning its orphaned keyframe tracks. */
export function removePaint(clip: Clip, kind: PaintKind, id: string): Clip {
  let next = clip;
  if (kind === "fill" && "fills" in clip && Array.isArray(clip.fills)) {
    next = { ...clip, fills: clip.fills.filter((f) => f.id !== id) } as Clip;
  } else if (kind === "stroke" && "strokes" in clip && Array.isArray(clip.strokes)) {
    next = { ...clip, strokes: clip.strokes.filter((s) => s.id !== id) } as Clip;
  } else {
    return clip;
  }
  return pruneKeyframes(next, (t) => !belongsToPaint(t.property, kind, id));
}

// ── paint type switch (solid ↔ gradient ↔ media ↔ pattern) ───────────────────

/** A hex color with its alpha zeroed — the far stop of a seeded gradient, so a
 *  freshly-converted gradient reads as a real fade rather than a flat block. */
function toTransparent(hex: string): string {
  const rgba = parseHexColor(hex);
  return rgba ? formatHexColor({ ...rgba, a: 0 }) : "#00000000";
}

/** Two stops seeded from a base color (opaque → transparent). */
function seedStops(color: string): GradientStop[] {
  return [
    { id: createId("stop"), offset: 0, color },
    { id: createId("stop"), offset: 1, color: toTransparent(color) },
  ];
}

/** Convert a paint to another type, PRESERVING its id/opacity/blend so keyframes
 *  and drivers keyed on the entry survive; gradient→gradient only flips the
 *  sub-type (stops + geometry are kept). */
function convertPaint(old: Paint, type: PaintType): Paint {
  if (old.type === type) return old;
  if (isGradientPaint(old) && (type === "linear" || type === "radial" || type === "angular")) {
    return { ...old, type } as Paint;
  }
  const base = { id: old.id, enabled: old.enabled, opacity: old.opacity, blendMode: old.blendMode };
  const color = paintColors(old)[0] ?? "#FFFFFF";
  switch (type) {
    case "solid":
      return { ...base, type: "solid", color };
    case "linear":
    case "radial":
    case "angular": {
      const stops = isGradientPaint(old) ? old.stops : seedStops(color);
      const geom: GradientType = type;
      return {
        ...base,
        type: geom,
        stops,
        start: geom === "linear" ? { x: 0, y: 0.5 } : { x: 0.5, y: 0.5 },
        end: { x: 1, y: 0.5 },
      };
    }
    case "media":
      return { ...mediaPaint(), ...base };
    case "pattern":
      return { ...patternPaint(), ...base };
    // A reference is not a LOOK you can convert into — binding a fill to a
    // variable is choosing which one, which is the picker's job, not a type
    // switch's. Converting one AWAY works fine, because by then the paint has
    // been resolved to whatever the variable held.
    case "variable":
      return old;
  }
}

/** Map a fill (or a stroke's paint) by id through `fn`, returning a new clip. */
function mapPaint(clip: Clip, kind: PaintKind, id: string, fn: (p: Paint) => Paint): Clip {
  if (kind === "fill") {
    if (!("fills" in clip) || !Array.isArray(clip.fills)) return clip;
    return { ...clip, fills: clip.fills.map((f) => (f.id === id ? fn(f) : f)) } as Clip;
  }
  if (!("strokes" in clip) || !Array.isArray(clip.strokes)) return clip;
  return {
    ...clip,
    strokes: clip.strokes.map((s) => (s.id === id ? ({ ...s, paint: fn(s.paint) } as StrokeStyle) : s)),
  } as Clip;
}

/** Switch a fill/stroke paint's type, then drop keyframe tracks whose sub-property
 *  the new type no longer exposes (decided by re-projecting the clip). */
export function setPaintType(clip: Clip, kind: PaintKind, id: string, type: PaintType): Clip {
  const next = mapPaint(clip, kind, id, (p) => convertPaint(p, type));
  if (next === clip) return clip;
  const valid = new Set(clipAnimatableProperties(next).map((p) => p.path));
  return pruneKeyframes(next, (t) => !belongsToPaint(t.property, kind, id) || valid.has(t.property));
}

// ── layer effects: add / remove ──────────────────────────────────────────────

/** Append a layer effect of `type`, seeded from its registry defaults. */
export function addEffect(clip: Clip, type: LayerEffectType): Clip {
  if (!("effects" in clip) || !Array.isArray(clip.effects)) return clip;
  return { ...clip, effects: [...clip.effects, createLayerEffect(type)] } as Clip;
}

/** Remove a layer effect by id, pruning its orphaned keyframe tracks. */
export function removeEffect(clip: Clip, id: string): Clip {
  if (!("effects" in clip) || !Array.isArray(clip.effects)) return clip;
  const next = { ...clip, effects: clip.effects.filter((e) => e.id !== id) } as Clip;
  return pruneKeyframes(next, (t) => !belongsToEffect(t.property, id));
}

// ── gradient stops: add / remove ─────────────────────────────────────────────

/** Insert a stop into a gradient fill/stroke at `offset`, colored by sampling the
 *  gradient there; a no-op on non-gradient paints. */
export function addGradientStop(clip: Clip, kind: PaintKind, paintId: string, offset = 0.5): Clip {
  return mapPaint(clip, kind, paintId, (p) => {
    if (!isGradientPaint(p)) return p;
    const stop: GradientStop = { id: createId("stop"), offset, color: gradientColorAt(p.stops, offset) };
    return { ...p, stops: [...p.stops, stop].sort((a, b) => a.offset - b.offset) };
  });
}

/** Remove a gradient stop, refusing to drop below the schema minimum of two and
 *  pruning the removed stop's keyframe tracks. */
export function removeGradientStop(clip: Clip, kind: PaintKind, paintId: string, stopId: string): Clip {
  let removed = false;
  const next = mapPaint(clip, kind, paintId, (p) => {
    if (!isGradientPaint(p) || p.stops.length <= 2 || !p.stops.some((s) => s.id === stopId)) return p;
    removed = true;
    return { ...p, stops: p.stops.filter((s) => s.id !== stopId) };
  });
  if (!removed) return clip;
  const prefix = `${kind}.${paintId}.stop.${stopId}.`;
  return pruneKeyframes(next, (t) => !t.property.startsWith(prefix));
}
