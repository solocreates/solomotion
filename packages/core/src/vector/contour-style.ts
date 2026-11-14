import type { KeyframeValue } from "../schema/animation";
import type { LayerEffect } from "../schema/layer-effects";
import type { ScopeOverlay } from "../schema/scope";
import { emptyOverlay } from "../schema/scope";
import type { PathClip } from "../schema/clips";
import type { FillRule, Paint, StrokeStyle } from "../schema/vector";
import { setClipProperty } from "../animation/paths";
import { detach, entryOfPath, overlayIsEmpty, resolveLook, writeOverlayPath } from "../scope";

export { detach };

/**
 * CONTOUR STYLE — "like my layer, except…", for one piece of a vector.
 *
 * ## Why an overlay and not a style block
 *
 * A per-contour style block that inherits from its layer sounds smaller than
 * this and is much bigger. The first field is `fill`; then `stroke`, because a
 * recoloured petal wants its own outline; then `opacity`; then `blendMode`;
 * then a transform, because the petal has to rotate; then effects; then
 * keyframes for all of it; then a `part.<id>.…` keyframe path family; then a
 * resolver at every read site. At the end it is `Clip` rewritten one level
 * down, and every feature the app grows afterwards is built twice.
 *
 * So a contour overrides by the same mechanism a text RANGE and a caption's
 * FOCUS already do — a `ScopeOverlay`, a sparse map from property PATH to
 * value, whose own header (schema/scope.ts) anticipated exactly this caller.
 * The contract comes with it, unchanged:
 *
 *   presence IS an override · absence IS inheritance
 *
 * Nothing is snapshotted. An untouched contour has no entry at all and follows
 * its layer forever; editing the layer still reaches every contour that has not
 * opted out; and "inherited AND overridden" is not a representable state, so
 * there is no flag to keep in sync with a value. Un-linking a field is writing
 * its path, re-linking it is `delete`. That is the whole parent/child contract
 * and it is two operations.
 *
 * ## Why it survives separation
 *
 * The paths are `getClipProperty`/`setClipProperty` paths, the same vocabulary
 * the keyframe engine speaks. So promoting a contour into its own layer does
 * not TRANSLATE anything — `bakeContourStyle` writes each entry to the new
 * clip's real field and the override simply becomes a value. Overrides made
 * before a split are the overrides you have after it, by construction rather
 * than by a migration somebody has to remember.
 */

/** The look of one contour, with its layer's style as the parent. */
export interface ContourStyle {
  fills: Paint[];
  strokes: StrokeStyle[];
  effects: LayerEffect[];
  fillRule: FillRule;
  opacity: number;
  /** False when this contour is inheriting everything (the common case). */
  overridden: boolean;
}

/** The overlay for a contour, or undefined when it inherits everything. */
export function contourOverlay(clip: PathClip, contourId: string): ScopeOverlay | undefined {
  const ov = clip.contourStyles[contourId];
  return overlayIsEmpty(ov) ? undefined : ov;
}

/** Does ANY contour in this layer override something? The renderer's fast path. */
export function hasContourOverrides(clip: PathClip): boolean {
  for (const id of Object.keys(clip.contourStyles)) {
    if (!overlayIsEmpty(clip.contourStyles[id])) return true;
  }
  return false;
}

/**
 * Resolve one contour's look against its layer — through the ONE overlay
 * resolver a text range and a caption's focus use. The layer's own arrays
 * come back by reference when the contour inherits everything, which is what
 * makes this safe to call per contour per frame.
 */
export function resolveContourStyle(clip: PathClip, contourId: string): ContourStyle {
  const base: ContourStyle = {
    fills: clip.fills,
    strokes: clip.strokes,
    effects: clip.effects,
    fillRule: clip.fillRule,
    opacity: clip.opacity,
    overridden: false,
  };
  const ov = contourOverlay(clip, contourId);
  if (!ov) return base;
  // The lists resolve through the shared engine; what is left is the layer's
  // own scalars (`opacity`, …), which a path clip carries at the top level
  // where a text scope carries them on its style.
  const carrier = {
    kind: "path" as const,
    ...resolveLook(base, ov),
    // `setClipProperty` reaches for these on a visual clip; a bare carrier is
    // enough because an overlay can only name paths the resolver understands.
    transform: clip.transform,
    modulators: clip.modulators,
    audioEffects: clip.audioEffects,
    audioMix: clip.audioMix,
  };
  for (const [path, value] of Object.entries(ov.props)) {
    if (!entryOfPath(path)) setClipProperty(carrier as never, path, value);
  }
  return {
    fills: carrier.fills,
    strokes: carrier.strokes,
    effects: carrier.effects,
    fillRule: carrier.fillRule,
    opacity: carrier.opacity,
    overridden: true,
  };
}

/* ------------------------------------------------------------------ writing */

/** Override one property on one contour. Allocates the overlay on first use. */
export function setContourOverride(
  clip: PathClip,
  contourId: string,
  path: string,
  value: KeyframeValue,
): void {
  const ov = (clip.contourStyles[contourId] ??= emptyOverlay());
  writeOverlayPath(ov, path, value);
}

/**
 * Give ONE contour its own ink — the whole stack, not a patch of it.
 *
 * `setContourOverride` says "like my layer, except this field". This says "not
 * my layer's at all", which is the other half of the overlay contract and the
 * one a DRAWING TOOL needs: a stroke drawn with a different brush, a different
 * colour or a different pressure is not a variation on the layer's ink, it is
 * different ink. Structural difference cannot be expressed as a value at a
 * path, which is exactly what `removed` + `added` are for.
 *
 * The layer's entries are dropped by id and the given ones added, so the
 * contour stops listening to the layer's stacks entirely while still inheriting
 * everything else about it (opacity, blend, fill rule, effects).
 *
 * ## Ink that matches goes back to inheriting
 *
 * If the stacks it is handed are the same ink the contour would have inherited
 * anyway, the override is DROPPED instead of written. That is not an
 * optimisation, it is the contract: "absence IS inheritance" is only true if
 * the write seam refuses to record a difference that isn't one. It keeps ten
 * strokes of the same brush a layer with no overrides at all — which is the
 * renderer's one-path fast case, and a document that stays small — and it means
 * editing the layer's colour still reaches every stroke that never disagreed
 * with it.
 */
export function setContourInk(
  clip: PathClip,
  contourId: string,
  ink: { strokes: StrokeStyle[]; fills: Paint[] },
): void {
  if (sameInk(ink, { strokes: clip.strokes, fills: clip.fills })) {
    clearContourInk(clip, contourId);
    return;
  }
  const ov = (clip.contourStyles[contourId] ??= emptyOverlay());
  const inherited = new Set([...clip.strokes.map((s) => s.id), ...clip.fills.map((f) => f.id)]);
  ov.removed = [...new Set([...ov.removed.filter((id) => !inherited.has(id)), ...inherited])];
  ov.added.strokes = ink.strokes.map((s) => detach(s));
  ov.added.fills = ink.fills.map((f) => detach(f));
}

/**
 * POUR A FILL into one region of a path layer — the paint bucket's exact path,
 * shared by the flat canvas and a 3D world's fill tool.
 *
 * A layer of ONE contour has nothing to inherit from, so the fill belongs on
 * the layer itself — where the inspector's Fill list edits it, and where the
 * next stroke drawn into it inherits it. Otherwise only the region's contour
 * changes, keeping the strokes it already wears.
 */
export function pourFill(clip: PathClip, contourId: string, paint: Paint): void {
  if (clip.subpaths.length <= 1) {
    clip.fills = [paint];
    return;
  }
  const style = resolveContourStyle(clip, contourId);
  setContourInk(clip, contourId, { strokes: style.strokes, fills: [paint] });
}

/** Hand a contour's stacks back to its layer, leaving its other overrides alone. */
export function clearContourInk(clip: PathClip, contourId: string): void {
  const ov = clip.contourStyles[contourId];
  if (!ov) return;
  const inherited = new Set([...clip.strokes.map((s) => s.id), ...clip.fills.map((f) => f.id)]);
  ov.removed = ov.removed.filter((id) => !inherited.has(id));
  ov.added.strokes = [];
  ov.added.fills = [];
  if (overlayIsEmpty(ov)) delete clip.contourStyles[contourId];
}

/**
 * Is this the same INK? Compared by what it paints, with ids excluded — two
 * stacks built from one brush mint fresh ids every time, so comparing them
 * would find a difference in every stroke and the "matching ink inherits" rule
 * above would never once fire.
 */
function sameInk(
  a: { strokes: readonly StrokeStyle[]; fills: readonly Paint[] },
  b: { strokes: readonly StrokeStyle[]; fills: readonly Paint[] },
): boolean {
  return inkKey(a) === inkKey(b);
}

function inkKey(ink: { strokes: readonly StrokeStyle[]; fills: readonly Paint[] }): string {
  const strip = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(strip)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([k]) => k !== "id")
              .sort(([x], [y]) => (x < y ? -1 : 1))
              .map(([k, val]) => [k, strip(val)]),
          )
        : v;
  return JSON.stringify(strip({ strokes: detach(ink.strokes as StrokeStyle[]), fills: detach(ink.fills as Paint[]) }));
}

/**
 * Stop overriding one property — the contour goes back to following its layer.
 * The entry is dropped entirely once nothing is left, so "inherits everything"
 * has exactly one representation and `overlayIsEmpty` never has to be trusted
 * twice.
 */
export function clearContourOverride(clip: PathClip, contourId: string, path: string): void {
  const ov = clip.contourStyles[contourId];
  if (!ov) return;
  delete ov.props[path];
  if (overlayIsEmpty(ov)) delete clip.contourStyles[contourId];
}

/** Drop every override on a contour. */
export function clearContourStyle(clip: PathClip, contourId: string): void {
  delete clip.contourStyles[contourId];
}

/**
 * Forget overrides for contours this layer no longer has.
 *
 * Called from `editPathGeometry` — the ONE seam every geometry write goes
 * through — so an orphan is impossible rather than merely unlikely, and no op
 * has to know that contour styles exist. Idempotent: a healthy layer pays one
 * pass over a usually-empty map.
 */
export function pruneContourStyles(clip: PathClip): void {
  const ids = Object.keys(clip.contourStyles);
  if (ids.length === 0) return;
  const alive = new Set(clip.subpaths.map((c) => c.id));
  // A MORPHING layer's contours do not all live in `clip.subpaths`: a geometry
  // key is a whole outline, and the one on screen is whichever key the playhead
  // resolves. Pruning against the resting outline alone therefore deleted the
  // style of every contour that exists only inside a key — which, on a layer
  // that morphs, is every stroke drawn onto it. A contour is alive if ANY
  // outline this layer can show contains it.
  for (const track of clip.keyframes) {
    if (track.property !== "geometry") continue;
    for (const key of track.keys) {
      if (!Array.isArray(key.value)) continue;
      for (const sub of key.value as ReadonlyArray<{ id?: string }>) {
        if (typeof sub?.id === "string") alive.add(sub.id);
      }
    }
  }
  for (const id of ids) if (!alive.has(id)) delete clip.contourStyles[id];
}

/**
 * Write a contour's overrides into a clip's REAL fields — the moment an
 * override stops being a diff and becomes a layer.
 *
 * This is why separation cannot lose an override: the overlay's paths and the
 * clip's property paths are one vocabulary, so there is nothing to translate.
 * The piece keeps looking exactly as it did the instant before it was promoted.
 */
export function bakeContourStyle(target: PathClip, ov: ScopeOverlay | undefined): void {
  if (overlayIsEmpty(ov)) return;
  const o = ov!;
  const drop = new Set(o.removed);
  target.fills = target.fills.filter((f) => !drop.has(f.id)).concat(detach(o.added.fills));
  target.strokes = target.strokes.filter((s) => !drop.has(s.id)).concat(detach(o.added.strokes));
  target.effects = target.effects.filter((e) => !drop.has(e.id)).concat(detach(o.added.effects));
  for (const [path, value] of Object.entries(o.props)) {
    setClipProperty(target as never, path, value);
  }
}
