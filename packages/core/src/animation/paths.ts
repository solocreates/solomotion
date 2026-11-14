import type { Clip, KeyframeValue, LayoutSpec, Paint, ShapeClip, StrokeStyle, Subpath, VisualClip } from "../schema";
import { isGeometryValue } from "../schema";
import { setPathGeometry } from "../pivot";
import { copySubpaths, shapeCornerBasis, type ShapeGeometryInput } from "../vector/geometry";
import { lendIdentity } from "../vector/contour-id";
import { clampScale, MIN_EVAL_SCALE_ABS } from "../resize";
import { paintProperty, setPaintProperty } from "./paint";
import { setStrokeScalar, strokeScalar } from "../vector/stroke";
import { removeKeyframesKeepingValue } from "./keyframes";
import { CAPTURE_PROPERTY } from "../drawing/capture";
import { clipPlaybackOf, setClipPlayback } from "../clip-registry";
import { MAX_SPEED, MIN_SPEED, SPEED_PROPERTY } from "./retime";
import type { KeyframeTrack } from "../schema";
import { parseGradePath, readGradeValue, writeGradeValue } from "../grade/paths";
import { motionBlurSettingsSchema } from "../schema/motion-blur";
import { getWorldProperty, isWorldPath, setWorldProperty } from "../world/fields";
import { getBoneProperty, isBonePath, setBoneProperty } from "../rig/fields";
import { getInputProperty, isInputPath, setInputProperty } from "../components/inputs-fields";
import { getPoseProperty, isPosePath, setPoseProperty } from "../rig/pose-fields";
import { getShapeKeyProperty, isShapeKeyPath, setShapeKeyProperty } from "../shape-keys/fields";
import { getForceProperty, isForcePath, setForceProperty } from "../physics/forces";
import { getEmitterProperty, isEmitterPath, setEmitterProperty } from "../physics/emitters";
import { getSoundProperty, isSoundPath, setSoundProperty } from "../audio/sound-fields";
import { getBehaviorProperty, isBehaviorPath, setBehaviorProperty } from "../behaviors/fields";
import { getTraceProperty, isTracePath, setTraceProperty } from "../trace/fields";

/** `mblur.<field>` — the numeric shutter fields a layer can set and key. */
const MBLUR_PATH = /^mblur\.(shutterAngle|shutterPhase|strength|amount)$/;
type MblurField = "shutterAngle" | "shutterPhase" | "strength" | "amount";
const SHUTTER_DEFAULTS = motionBlurSettingsSchema.parse({});

/**
 * Anything that carries the unified paint lists — a visual clip OR a frame
 * (artboard background). The paint get/set logic only ever touches these two
 * arrays, so it works on any carrier: one code path for clips and frames.
 */
export interface PaintCarrier {
  fills: Paint[];
  strokes: StrokeStyle[];
}

/** `corner.<i>.x|y` — a per-vertex nudge, keyframable like any number. */
const CORNER_PATH = /^corner\.(\d+)\.(x|y)$/;

/**
 * Effective per-corner offsets = base nudges with sampled `corner.<i>.x|y`
 * keyframes layered on top. THE shared read used by both the renderer (drawn
 * geometry) and the editor (node placement), so a keyframed corner's node sits
 * exactly on the shape it draws. Returns the base array (maybe null) when
 * nothing is keyed — preserving the pure-parametric fast path.
 */
export function effectiveCornerOffsets(
  base: Array<{ x: number; y: number }> | null,
  sampled: Record<string, KeyframeValue>,
): Array<{ x: number; y: number }> | null {
  let maxI = base ? base.length - 1 : -1;
  for (const k in sampled) {
    const m = CORNER_PATH.exec(k);
    if (m) maxI = Math.max(maxI, Number(m[1]));
  }
  if (maxI < 0) return base;
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= maxI; i++) {
    const sx = sampled[`corner.${i}.x`];
    const sy = sampled[`corner.${i}.y`];
    out.push({
      x: typeof sx === "number" ? sx : (base?.[i]?.x ?? 0),
      y: typeof sy === "number" ? sy : (base?.[i]?.y ?? 0),
    });
  }
  return out;
}

/** A shape's geometry with every animatable field resolved (never undefined). */
export interface ResolvedShapeGeometry extends ShapeGeometryInput {
  arcStartDeg: number;
  arcSweepDeg: number;
  arcRatio: number;
  cornerOffsets: Array<{ x: number; y: number }> | null;
}

/**
 * A shape's smallest box: positive (the schema's rule), and far below a pixel.
 * Not 1 px — a marker written in screen px inside a ×13 000 zoom is 0.0005
 * comp px wide, and flooring it at 1 drew it 13 000 px across.
 */
export const MIN_SHAPE_EXTENT = 1e-9;

/**
 * A shape clip's geometry resolved at a moment in time: its base parametric
 * fields with any keyframed value (width/height, per-corner radii, polygon
 * radius, star/arc params, per-corner nudges) layered on top. THE one seam both
 * the renderer AND every on-stage edit affordance (corner nodes, radius/arc/star
 * handles, their hit-tests and drags) read from — so the handles always ride the
 * animated shape instead of its static base state. `sampled` is the shape's
 * already-sampled keyframe map at the local time.
 */
export function resolveShapeGeometry(
  clip: ShapeClip,
  sampled: Record<string, KeyframeValue>,
): ResolvedShapeGeometry {
  const n = (key: string, base: number) =>
    typeof sampled[key] === "number" ? (sampled[key] as number) : base;
  return {
    shape: clip.shape,
    width: Math.max(MIN_SHAPE_EXTENT, n("width", clip.width)),
    height: Math.max(MIN_SHAPE_EXTENT, n("height", clip.height)),
    cornerRadius: {
      tl: n("radius.tl", clip.cornerRadius.tl),
      tr: n("radius.tr", clip.cornerRadius.tr),
      br: n("radius.br", clip.cornerRadius.br),
      bl: n("radius.bl", clip.cornerRadius.bl),
    },
    radius: n("radius", clip.radius),
    pointCount: n("pointCount", clip.pointCount),
    innerRatio: n("innerRatio", clip.innerRatio),
    arcStartDeg: n("arcStartDeg", clip.arcStartDeg),
    arcSweepDeg: n("arcSweepDeg", clip.arcSweepDeg),
    arcRatio: n("arcRatio", clip.arcRatio),
    cornerOffsets: effectiveCornerOffsets(clip.cornerOffsets, sampled),
  };
}

/**
 * Property paths — the address space for "keyframe anything". A path is a plain
 * string identifying one animatable value on a clip:
 *
 *   x, y, scale, rotation, opacity            transform / layer
 *   fontSize, letterSpacing, lineHeight,
 *   color, fontWeight, fauxBold, italic, text typography
 *   focusScale, gain                          caption / audio
 *   lfx.<effectId>.<field>                    a layer-effect field
 *   mod.<modulatorId>.<field>                 a modulator's own field
 *   afx.<effectId>.<field>                    an audio-effect field
 *   afx.<effectId>.band.<bandId>.<field>      one parametric EQ band's value
 *   highlight.<field>                         the highlight pill
 *
 * `getClipProperty` / `setClipProperty` are the ONE place these paths bind to
 * the clip. Every base write goes through `setClipProperty`, so no call site
 * hand-writes a setter — record mode and keyframing wrap this uniformly.
 */

const LFX = /^lfx\.([^.]+)\.([^.]+)$/;
/**
 * `lfx.<card>.n.<node>.…` — a value INSIDE a grade card's node graph. A grade
 * lives on its card (see `schema/grade`), so its whole address space is a suffix
 * under the card's existing namespace and nothing new had to be registered:
 * `LFX` keeps answering for flat fields, this answers for the tree. See
 * `grade/paths.ts` for the grammar.
 */
const LFX_GRADE = /^lfx\.([^.]+)\.(n\..+)$/;
/**
 * A MODULATOR's own field. Modulators were already keyframable at SAMPLE time
 * (`evaluateModulator` reads `mod.<id>.<field>` out of the sampled bag), but
 * the generic base setter did not know the grammar — so `commitProperty` could
 * write a key and never the underlying value, and record mode could not plant
 * the first one. Same three lines as `lfx`, and the same payoff: every field of
 * a modulator, including its own on/off switch, animates like anything else.
 */
const MOD = /^mod\.([^.]+)\.([^.]+)$/;
const AFX = /^afx\.([^.]+)\.([^.]+)$/;
/** `afx.<fx>.band.<band>.<gain|freq|q>` — the EQ card's per-band values. */
const AFX_BAND = /^afx\.([^.]+)\.band\.([^.]+)\.(gain|freq|q)$/;

/** The schema field a band path's short name addresses. */
const BAND_FIELD = { gain: "gainDb", freq: "freqHz", q: "q" } as const;
const HIGHLIGHT = /^highlight\.([^.]+)$/;
/** `layout.<field>` or `layout.padding.<side>` — a container's own numbers (v73). */
const LAYOUT = /^layout\.(.+)$/;

function readLayoutField(layout: LayoutSpec, field: string): number | undefined {
  const side = field.startsWith("padding.") ? field.slice(8) : null;
  if (side) return side in layout.padding ? layout.padding[side as keyof LayoutSpec["padding"]] : undefined;
  switch (field) {
    case "x": return layout.x;
    case "y": return layout.y;
    case "gap": return layout.gap;
    case "lineGap": return layout.lineGap;
    case "width": return layout.width ?? undefined;
    case "height": return layout.height ?? undefined;
  }
  return undefined;
}

function writeLayoutField(layout: LayoutSpec, field: string, value: number): void {
  const side = field.startsWith("padding.") ? field.slice(8) : null;
  if (side) {
    if (side in layout.padding) layout.padding[side as keyof LayoutSpec["padding"]] = Math.max(0, value);
    return;
  }
  switch (field) {
    case "x": layout.x = value; return;
    case "y": layout.y = value; return;
    case "gap": layout.gap = Math.max(0, value); return;
    case "lineGap": layout.lineGap = Math.max(0, value); return;
    case "width": layout.width = Math.max(1, value); return;
    case "height": layout.height = Math.max(1, value); return;
  }
}
/** `tfx.<id>.<field>` — one field of one PER-GLYPH text effect. Deliberately a
 *  different prefix from `lfx.` because they are different passes at different
 *  grains, and one prefix for both is how the v54 confusion started. */
const TFX = /^tfx\.([^.]+)\.([^.]+)$/;

/** Clamp an EQ band field to its schema range. */
function clampEqField(field: "gain" | "freq" | "q", value: number): number {
  if (field === "gain") return Math.min(24, Math.max(-24, value));
  if (field === "freq") return Math.min(20000, Math.max(20, value));
  return Math.min(18, Math.max(0.05, value));
}

/**
 * A per-entry paint path: `fill.<id>` / `fill.<id>.<sub>` (a fill in
 * `clip.fills`) or `stroke.<id>.<sub>` (a stroke in `clip.strokes`). `sub` is
 * "" for a solid fill's bare color; otherwise a paint sub-property
 * (`opacity`, `stop.<id>.color`, `angleDeg`, …) or a stroke scalar
 * (`width`, `dashLength`, `dashGap`).
 */
const PAINT_PATH = /^(fill|stroke)\.([^.]+)(?:\.(.+))?$/;
interface PaintPathRef {
  list: "fill" | "stroke";
  id: string;
  sub: string;
}
function parsePaintPath(path: string): PaintPathRef | null {
  const m = PAINT_PATH.exec(path);
  if (!m) return null;
  return { list: m[1] as "fill" | "stroke", id: m[2]!, sub: m[3] ?? "" };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The `stroke.<id>.…` suffix naming a measured width curve. */
export const PROFILE_SAMPLES = "profile.samples";

/** Read a `fill.<id>.…`/`stroke.<id>.…` path off any paint carrier (clip or frame). */
export function getCarrierPaintProperty(carrier: PaintCarrier, path: string): KeyframeValue | undefined {
  const ref = parsePaintPath(path);
  return ref ? getPaintProperty(carrier, ref) : undefined;
}

/** Write a `fill.<id>.…`/`stroke.<id>.…` path onto any paint carrier (clip or frame). */
export function setCarrierPaintProperty(carrier: PaintCarrier, path: string, value: KeyframeValue): void {
  const ref = parsePaintPath(path);
  if (ref) setPaintPropertyOnClip(carrier, ref, value);
}

function getPaintProperty(clip: PaintCarrier, ref: PaintPathRef): KeyframeValue | undefined {
  if (ref.list === "fill") {
    const paint = clip.fills.find((p) => p.id === ref.id);
    if (!paint) return undefined;
    if (ref.sub === "opacity") return paint.opacity;
    return paintProperty(paint, ref.sub === "" ? "color" : ref.sub);
  }
  const s = clip.strokes.find((x) => x.id === ref.id);
  if (!s) return undefined;
  if (ref.sub === "") return undefined;
  // The one stroke property that is a CURVE rather than a scalar: a measured
  // width profile (see `StrokeProfile.samples`). It is addressable by path so a
  // contour can override it — which is how a drawn stroke keeps the pressure it
  // was drawn with while inheriting every other thing about its layer's ink.
  if (ref.sub === PROFILE_SAMPLES) return s.profile.samples ?? undefined;
  // Every animatable scalar of the stroke PIPELINE (width, dash, trim, profile,
  // wave, marker sizes) is answered by one table in `vector/stroke`; anything
  // else is a property of the stroke's inner paint.
  const scalar = strokeScalar(s, ref.sub);
  if (scalar !== undefined) return scalar;
  return paintProperty(s.paint, ref.sub === "color" ? "color" : ref.sub);
}

function setPaintPropertyOnClip(clip: PaintCarrier, ref: PaintPathRef, value: KeyframeValue): void {
  const num = typeof value === "number" ? value : undefined;
  if (ref.list === "fill") {
    const paint = clip.fills.find((p) => p.id === ref.id);
    if (!paint) return;
    if (ref.sub === "opacity") {
      if (num !== undefined) paint.opacity = clamp01(num);
      return;
    }
    setPaintProperty(paint, ref.sub === "" ? "color" : ref.sub, value);
    return;
  }
  const s = clip.strokes.find((x) => x.id === ref.id);
  if (!s) return;
  if (ref.sub === "") return;
  if (ref.sub === PROFILE_SAMPLES) {
    // `null` and `[]` both mean "no measured curve"; storing one shape for it
    // keeps `isUniformProfile` a single check rather than two.
    const next = Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
    s.profile.samples = next.length > 0 ? next : null;
    return;
  }
  if (num !== undefined && strokeScalar(s, ref.sub) !== undefined) {
    setStrokeScalar(s, ref.sub, num);
    return;
  }
  setPaintProperty(s.paint, ref.sub === "color" ? "color" : ref.sub, value);
}

/** Read a path's base value from the clip (undefined when it doesn't apply). */
export function getClipProperty(clip: Clip, path: string): KeyframeValue | undefined {
  // Universal sound trim — every clip carries `audioMix` (mute + master volume).
  if (path === "audioMix.volume") return clip.audioMix.volume;
  // The layer's own shutter: its override when it has one, else the defaults
  // an override would start from (a layer that inherits has no number of its own).
  const shutter = MBLUR_PATH.exec(path);
  if (shutter) return (clip.motionBlur.override ?? SHUTTER_DEFAULTS)[shutter[1] as MblurField];

  // SPEED lives on `playback`, and only source-backed clips have one — so the
  // registry gate (`appliesTo`) narrows the kind and this narrows the instance,
  // exactly like `focusScale` on a text layer with no caption module. A static
  // image has no playback and therefore no speed, which every surface already
  // reads as "this layer has no such property".
  if (path === SPEED_PROPERTY) return clipPlaybackOf(clip)?.speed;

  // Modulators ride `clipBase`, so this resolves on any clip kind.
  const modGet = MOD.exec(path);
  if (modGet) {
    const m = clip.modulators?.find((x) => x.id === modGet[1]);
    if (!m) return undefined;
    const v = (m as unknown as Record<string, unknown>)[modGet[2]!];
    return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : undefined;
  }

  // Audio effects — the chain rides `clipBase`, so this resolves on an audio
  // clip, a video's dialogue and a nested comp's mix alike. Bands are checked
  // FIRST: `afx.<fx>.band.<b>.q` also matches nothing in the flat pattern, but
  // ordering it first keeps the intent obvious rather than incidental.
  const bandGet = AFX_BAND.exec(path);
  if (bandGet) {
    const effect = clip.audioEffects.find((e) => e.id === bandGet[1]);
    if (effect?.type !== "eq") return undefined;
    const band = effect.bands.find((b) => b.id === bandGet[2]);
    return band?.[BAND_FIELD[bandGet[3] as keyof typeof BAND_FIELD]];
  }
  const afxGet = AFX.exec(path);
  if (afxGet) {
    const effect = clip.audioEffects.find((e) => e.id === afxGet[1]);
    if (!effect) return undefined;
    const v = (effect as Record<string, unknown>)[afxGet[2]!];
    return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : undefined;
  }

  if (clip.kind === "audio") {
    if (path === "gain") return clip.gain;
    if (path === "pitch") return clip.pitchSemitones;
    return undefined;
  }

  // Transform + layer paths apply to every visual clip (text, caption, nested…).
  switch (path) {
    case "x": return clip.transform.x;
    case "y": return clip.transform.y;
    case "scale": return clip.transform.scale;
    // `scaleY` mirrors `scale` when unset (uniform) — resolve it so the effective
    // value is always concrete for multi-select merging and keyframing.
    case "scaleY": return clip.transform.scaleY ?? clip.transform.scale;
    case "rotation": return clip.transform.rotation;
    // The third axis (v89): absent is identity, `scaleZ` null mirrors `scale`.
    case "z": return clip.transform.z ?? 0;
    case "rotationX": return clip.transform.rotationX ?? 0;
    case "rotationY": return clip.transform.rotationY ?? 0;
    case "scaleZ": return clip.transform.scaleZ ?? clip.transform.scale;
    case "skewX": return clip.transform.skewX;
    case "skewY": return clip.transform.skewY;
    case "anchor.x": return clip.transform.anchor.x;
    case "anchor.y": return clip.transform.anchor.y;
    case "opacity": return clip.opacity;
    case "feather": return clip.feather;
    // Uniform read = TL (the section shows "mixed" when corners differ anyway).
    case "borderRadius": return clip.borderRadius.tl;
    case "borderRadius.tl": return clip.borderRadius.tl;
    case "borderRadius.tr": return clip.borderRadius.tr;
    case "borderRadius.br": return clip.borderRadius.br;
    case "borderRadius.bl": return clip.borderRadius.bl;
    case "crop.top": return clip.crop.top;
    case "crop.right": return clip.crop.right;
    case "crop.bottom": return clip.crop.bottom;
    case "crop.left": return clip.crop.left;
    case "content.x": return clip.content.x;
    case "content.y": return clip.content.y;
    case "content.scale": return clip.content.scale;
    case "content.scaleY": return clip.content.scaleY ?? clip.content.scale;
    case "content.rotation": return clip.content.rotation;
  }
  // Camera, light, material, primitive and modifier fields (v89) — one registry.
  if (isWorldPath(clip, path)) {
    const w = getWorldProperty(clip, path);
    if (w !== undefined) return w;
  }
  // A rig's bones (v90): `bone.<id>.<channel>` on the group that holds them.
  if (isBonePath(clip, path)) return getBoneProperty(clip, path);
  // A component instance's inputs: `input.<id>` (its override; absent = the default).
  if (isInputPath(clip, path)) return getInputProperty(clip, path);
  // A group's pose sets (Characters 2.0): `pose.<setId>`, the pose's name.
  if (isPosePath(clip, path)) return getPoseProperty(clip, path);
  // A path or mesh's shape-key weights (Characters 2.0): `key.<id>`.
  if (isShapeKeyPath(clip, path)) return getShapeKeyProperty(clip, path);
  // A switch group's choice (v91).
  if (path === "switch" && clip.kind === "group") return clip.switch ? clip.switch.show : undefined;
  // A force in the layer's stack (v93).
  if (isForcePath(path)) return getForceProperty(clip, path);
  // An emitter in the layer's stack (v102).
  if (isEmitterPath(path)) return getEmitterProperty(clip, path);
  // A sound entry's climax (v103): `snd.<id>.intensity`.
  if (isSoundPath(path)) return getSoundProperty(clip, path);
  // A character's behaviors (Characters 3.0): `bhv.<id>.<field>`.
  if (isBehaviorPath(path)) return getBehaviorProperty(clip, path);
  // A trace's look (v109): `trace.<field>`.
  if (isTracePath(clip, path)) return getTraceProperty(clip, path);
  if (clip.kind === "video" && path === "volume") return clip.volume;
  if (clip.kind === "video" && path === "pitch") return clip.pitchSemitones;

  // Layer effects — every visual clip carries the stack.
  const gradeGet = LFX_GRADE.exec(path);
  if (gradeGet) {
    const card = clip.effects.find((e) => e.id === gradeGet[1]);
    if (card?.type !== "grade") return undefined;
    const target = parseGradePath(gradeGet[2]!);
    return target ? readGradeValue(card.graph, target) : undefined;
  }

  const lfxGet = LFX.exec(path);
  if (lfxGet) {
    const effect = clip.effects.find((e) => e.id === lfxGet[1]);
    if (!effect) return undefined;
    const v = (effect as Record<string, unknown>)[lfxGet[2]!];
    return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : undefined;
  }


  // Unified paint paths — every visual clip carries `fills`/`strokes`, so
  // `fill.<id>.…` / `stroke.<id>.…` resolve the same way on a shape, a text
  // layer or an image. One place, no per-kind duplication.
  const paint = parsePaintPath(path);
  if (paint) return getPaintProperty(clip, paint);

  // A container's layout numbers — `layout.gap`, `layout.padding.left`, `layout.width`…
  const layoutGet = LAYOUT.exec(path);
  if (layoutGet) return clip.kind === "group" && clip.layout ? readLayoutField(clip.layout, layoutGet[1]!) : undefined;

  // Vector clips: geometry.
  if (clip.kind === "shape" || clip.kind === "path") {
    // Path geometry — the morphing value. Copied so a stored key can never
    // share references with the live clip.
    if (path === "geometry" && clip.kind === "path") return copySubpaths(clip.subpaths);
    if (clip.kind === "shape") {
      switch (path) {
        case "width": return clip.width;
        case "height": return clip.height;
        case "radius": return clip.radius;
        case "radius.tl": return clip.cornerRadius.tl;
        case "radius.tr": return clip.cornerRadius.tr;
        case "radius.br": return clip.cornerRadius.br;
        case "radius.bl": return clip.cornerRadius.bl;
        case "pointCount": return clip.pointCount;
        case "innerRatio": return clip.innerRatio;
        case "arcStartDeg": return clip.arcStartDeg;
        case "arcSweepDeg": return clip.arcSweepDeg;
        case "arcRatio": return clip.arcRatio;
      }
      const cm = CORNER_PATH.exec(path);
      if (cm) {
        const i = Number(cm[1]);
        const o = clip.cornerOffsets?.[i];
        return o ? o[cm[2] as "x" | "y"] : 0;
      }
    }
    return undefined;
  }

  // The rest are typography/effects — only text carries a style.
  if (clip.kind !== "text") return undefined;

  switch (path) {
    case "opacity": return clip.style.opacity;
    case "fontSize": return clip.style.fontSize;
    case "letterSpacing": return clip.style.letterSpacing;
    case "lineHeight": return clip.style.lineHeight;
    case "color": return clip.style.color;
    case "fontFamily": return clip.style.fontFamily;
    case "fontWeight": return clip.style.fontWeight;
    case "fauxBold": return clip.style.fauxBold;
    case "italic": return clip.style.italic;
    case "text": return clip.text;
    case "focusScale": return clip.caption?.states.focus.scale;
    case "maxWidth": return clip.maxWidth ?? undefined;
    case "maxHeight": return clip.maxHeight ?? undefined;
    case "path.offset": return clip.path?.offset;
    case "path.rise": return clip.path?.rise;
  }

  const hl = HIGHLIGHT.exec(path);
  if (hl && clip.style.highlight) {
    const v = (clip.style.highlight as Record<string, unknown>)[hl[1]!];
    return typeof v === "number" || typeof v === "string" ? v : undefined;
  }

  const tfxGet = TFX.exec(path);
  if (tfxGet) {
    const fx = clip.style.textEffects.find((e) => e.id === tfxGet[1]);
    if (!fx) return undefined;
    const v = (fx as unknown as Record<string, unknown>)[tfxGet[2]!];
    return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : undefined;
  }

  return undefined;
}

/** Write a path's base value onto the clip (mutates — call inside an update). */
export function setClipProperty(clip: Clip, path: string, value: KeyframeValue): void {
  // Universal sound trim — applies to every clip kind.
  if (path === "audioMix.volume") {
    if (typeof value === "number") clip.audioMix.volume = Math.min(4, Math.max(0, value));
    return;
  }
  // Setting a shutter number is choosing this layer's own shutter: an override
  // is made from the defaults on first write, then the field is set.
  const shutter = MBLUR_PATH.exec(path);
  if (shutter) {
    if (typeof value !== "number") return;
    clip.motionBlur.override ??= { ...SHUTTER_DEFAULTS };
    clip.motionBlur.override[shutter[1] as MblurField] = value;
    return;
  }

  if (path === SPEED_PROPERTY) {
    // `setClipPlayback` is the ONE writer of a playback patch — it is what
    // seeds an animated image's lazily-created `playback` object — so the
    // base-value write goes through it rather than around it.
    if (typeof value === "number" && clipPlaybackOf(clip)) {
      setClipPlayback(clip, { speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, value)) });
    }
    return;
  }

  const modSet = MOD.exec(path);
  if (modSet) {
    const m = clip.modulators?.find((x) => x.id === modSet[1]);
    if (m) (m as unknown as Record<string, unknown>)[modSet[2]!] = value;
    return;
  }

  const bandSet = AFX_BAND.exec(path);
  if (bandSet) {
    const effect = clip.audioEffects.find((e) => e.id === bandSet[1]);
    if (effect?.type === "eq" && typeof value === "number") {
      const band = effect.bands.find((b) => b.id === bandSet[2]);
      const field = bandSet[3] as "gain" | "freq" | "q";
      if (band) band[BAND_FIELD[field]] = clampEqField(field, value);
    }
    return;
  }
  const afxSet = AFX.exec(path);
  if (afxSet) {
    const effect = clip.audioEffects.find((e) => e.id === afxSet[1]);
    if (effect) (effect as Record<string, unknown>)[afxSet[2]!] = value;
    return;
  }

  if (clip.kind === "audio") {
    if (typeof value !== "number") return;
    if (path === "gain") {
      clip.gain = Math.min(4, Math.max(0, value));
      return;
    }
    if (path === "pitch") {
      clip.pitchSemitones = Math.min(24, Math.max(-24, value));
      return;
    }
    return;
  }
  // Camera, light, material, primitive and modifier fields (v89) — one registry.
  if (isWorldPath(clip, path) && setWorldProperty(clip, path, value)) return;
  if (isBonePath(clip, path) && setBoneProperty(clip, path, value)) return;
  if (isInputPath(clip, path) && setInputProperty(clip, path, value)) return;
  if (isPosePath(clip, path) && setPoseProperty(clip, path, value)) return;
  if (isShapeKeyPath(clip, path) && setShapeKeyProperty(clip, path, value)) return;
  if (isForcePath(path) && setForceProperty(clip, path, value)) return;
  if (isEmitterPath(path) && setEmitterProperty(clip, path, value)) return;
  if (isSoundPath(path) && setSoundProperty(clip, path, value)) return;
  if (isBehaviorPath(path) && setBehaviorProperty(clip, path, value)) return;
  if (isTracePath(clip, path) && setTraceProperty(clip, path, value)) return;
  if (path === "switch" && clip.kind === "group") {
    // A flag from an expression counts too: false = the top member, true = the next.
    const show = typeof value === "boolean" ? (value ? 1 : 0) : value;
    if (clip.switch && (typeof show === "string" || typeof show === "number")) clip.switch = { ...clip.switch, show };
    return;
  }

  const num = typeof value === "number" ? value : undefined;

  // Transform + layer paths apply to every visual clip (text, caption, nested…).
  switch (path) {
    case "x": if (num !== undefined) clip.transform.x = num; return;
    case "y": if (num !== undefined) clip.transform.y = num; return;
    // Magnitude-clamped, SIGN-PRESERVING: a negative scale is a mirrored layer
    // (see resize.ts), so clamping to a positive floor here would silently
    // un-flip anything typed, scrubbed or keyframed through the inspector.
    // The floor is the EVALUATION one (resize.ts › MIN_EVAL_SCALE_ABS): an
    // animated scale may pass through 1% on its way to 0.
    case "scale": if (num !== undefined) clip.transform.scale = clampScale(num, MIN_EVAL_SCALE_ABS); return;
    case "scaleY": if (num !== undefined) clip.transform.scaleY = clampScale(num, MIN_EVAL_SCALE_ABS); return;
    case "rotation": if (num !== undefined) clip.transform.rotation = num; return;
    case "z": if (num !== undefined) clip.transform.z = num; return;
    case "rotationX": if (num !== undefined) clip.transform.rotationX = num; return;
    case "rotationY": if (num !== undefined) clip.transform.rotationY = num; return;
    case "scaleZ": if (num !== undefined) clip.transform.scaleZ = clampScale(num, MIN_EVAL_SCALE_ABS); return;
    case "skewX": if (num !== undefined) clip.transform.skewX = num; return;
    case "skewY": if (num !== undefined) clip.transform.skewY = num; return;
    // Pivot: normalized to the layer's box and deliberately UNCLAMPED — a pivot
    // outside 0..1 (an off-layer orbit center) is a supported thing to want.
    case "anchor.x": if (num !== undefined) clip.transform.anchor.x = num; return;
    case "anchor.y": if (num !== undefined) clip.transform.anchor.y = num; return;
    case "opacity": if (num !== undefined) clip.opacity = clamp01(num); return;
    case "feather": if (num !== undefined) clip.feather = Math.max(0, num); return;
    // Uniform write sets all four corners (Figma linked-radius edit).
    case "borderRadius": if (num !== undefined) { const r = Math.max(0, num); clip.borderRadius = { tl: r, tr: r, br: r, bl: r }; } return;
    case "borderRadius.tl": if (num !== undefined) clip.borderRadius.tl = Math.max(0, num); return;
    case "borderRadius.tr": if (num !== undefined) clip.borderRadius.tr = Math.max(0, num); return;
    case "borderRadius.br": if (num !== undefined) clip.borderRadius.br = Math.max(0, num); return;
    case "borderRadius.bl": if (num !== undefined) clip.borderRadius.bl = Math.max(0, num); return;
    case "crop.top": if (num !== undefined) clip.crop.top = Math.max(0, num); return;
    case "crop.right": if (num !== undefined) clip.crop.right = Math.max(0, num); return;
    case "crop.bottom": if (num !== undefined) clip.crop.bottom = Math.max(0, num); return;
    case "crop.left": if (num !== undefined) clip.crop.left = Math.max(0, num); return;
    case "content.x": if (num !== undefined) clip.content.x = num; return;
    case "content.y": if (num !== undefined) clip.content.y = num; return;
    // Signed, like the layer's own scale: a negative content zoom mirrors the
    // picture inside a window that does not move.
    case "content.scale": if (num !== undefined) clip.content.scale = num; return;
    case "content.scaleY": if (num !== undefined) clip.content.scaleY = num; return;
    case "content.rotation": if (num !== undefined) clip.content.rotation = num; return;
  }
  if (clip.kind === "video" && path === "volume") {
    if (num !== undefined) clip.volume = Math.min(1, Math.max(0, num));
    return;
  }
  if (clip.kind === "video" && path === "pitch") {
    if (num !== undefined) clip.pitchSemitones = Math.min(24, Math.max(-24, num));
    return;
  }

  // Capture (recorded drawing over time): the track's values ARE snapshot
  // surface ids, so this path's base slot is the layer's own surface. Writing
  // it — which is what un-keying a recording does — freezes the snapshot you
  // were looking at, pixels and paint revision together (the snapshot carries
  // its own rev in `captureRevs`; adopting it keeps the undo seam honest).
  // Raster only: a vector layer records through `geometry`, not through this.
  if (clip.kind === "raster" && path === CAPTURE_PROPERTY) {
    if (typeof value === "string" && value) {
      clip.surfaceId = value;
      const rev = clip.captureRevs?.[value];
      if (rev !== undefined) clip.rev = rev;
    }
    return;
  }

  const gradeSet = LFX_GRADE.exec(path);
  if (gradeSet) {
    const card = clip.effects.find((e) => e.id === gradeSet[1]);
    if (card?.type !== "grade") return;
    const target = parseGradePath(gradeSet[2]!);
    if (target) writeGradeValue(card.graph, target, value as number | string | boolean);
    return;
  }

  const lfxSet = LFX.exec(path);
  if (lfxSet) {
    const effect = clip.effects.find((e) => e.id === lfxSet[1]);
    if (effect) (effect as Record<string, unknown>)[lfxSet[2]!] = value;
    return;
  }

  // Unified paint paths (see getClipProperty) — any visual clip.
  const paint = parsePaintPath(path);
  if (paint) {
    setPaintPropertyOnClip(clip, paint, value);
    return;
  }

  const layoutSet = LAYOUT.exec(path);
  if (layoutSet) {
    if (clip.kind === "group" && clip.layout && num !== undefined) writeLayoutField(clip.layout, layoutSet[1]!, num);
    return;
  }

  if (clip.kind === "shape" || clip.kind === "path") {
    if (path === "geometry" && clip.kind === "path") {
      // Baking an outline into the base slot resizes the clip's box, so it owes
      // the pivot the same correction a node drag does (see pivot.ts) — without
      // it, un-keying a vector morph makes the layer jump.
      if (isGeometryValue(value)) setPathGeometry(clip, lendIdentity(clip.subpaths, copySubpaths(value)));
      return;
    }
    if (clip.kind === "shape" && num !== undefined) {
      switch (path) {
        case "width": clip.width = Math.max(MIN_SHAPE_EXTENT, num); return;
        case "height": clip.height = Math.max(MIN_SHAPE_EXTENT, num); return;
        case "radius": clip.radius = Math.max(0, num); return;
        case "radius.tl": clip.cornerRadius.tl = Math.max(0, num); return;
        case "radius.tr": clip.cornerRadius.tr = Math.max(0, num); return;
        case "radius.br": clip.cornerRadius.br = Math.max(0, num); return;
        case "radius.bl": clip.cornerRadius.bl = Math.max(0, num); return;
        case "pointCount": clip.pointCount = Math.max(3, Math.round(num)); return;
        case "innerRatio": clip.innerRatio = Math.min(1, Math.max(0.01, num)); return;
        case "arcStartDeg": clip.arcStartDeg = num; return;
        case "arcSweepDeg": clip.arcSweepDeg = Math.min(360, Math.max(0, num)); return;
        case "arcRatio": clip.arcRatio = Math.min(0.99, Math.max(0, num)); return;
      }
      const cm = CORNER_PATH.exec(path);
      if (cm && num !== undefined) {
        const i = Number(cm[1]);
        const len = shapeCornerBasis(clip).length;
        if (i >= len) return;
        if (!clip.cornerOffsets || clip.cornerOffsets.length !== len) {
          clip.cornerOffsets = Array.from({ length: len }, () => ({ x: 0, y: 0 }));
        }
        clip.cornerOffsets[i]![cm[2] as "x" | "y"] = num;
        return;
      }
    }
    return;
  }

  if (clip.kind !== "text") return;

  switch (path) {
    case "opacity": if (num !== undefined) clip.style.opacity = num; return;
    case "fontSize": if (num !== undefined) clip.style.fontSize = num; return;
    case "letterSpacing": if (num !== undefined) clip.style.letterSpacing = num; return;
    case "lineHeight": if (num !== undefined) clip.style.lineHeight = num; return;
    case "color": if (typeof value === "string") clip.style.color = value; return;
    case "fontFamily": if (typeof value === "string") clip.style.fontFamily = value; return;
    case "fontWeight": if (num !== undefined) clip.style.fontWeight = Math.round(num); return;
    case "fauxBold": if (num !== undefined) clip.style.fauxBold = Math.max(0, num); return;
    case "italic": if (typeof value === "boolean") clip.style.italic = value; return;
    case "text": if (typeof value === "string") clip.text = value; return;
    case "focusScale": if (clip.caption && num !== undefined) clip.caption.states.focus.scale = num; return;
    case "maxWidth": if (num !== undefined) clip.maxWidth = Math.max(1, num); return;
    case "maxHeight": if (num !== undefined) clip.maxHeight = Math.max(1, num); return;
    case "path.offset": if (clip.path && num !== undefined) clip.path.offset = num; return;
    case "path.rise": if (clip.path && num !== undefined) clip.path.rise = num; return;
  }

  const hl = HIGHLIGHT.exec(path);
  if (hl && clip.style.highlight) {
    (clip.style.highlight as Record<string, unknown>)[hl[1]!] = value;
    return;
  }

  const tfxSet = TFX.exec(path);
  if (tfxSet) {
    const fx = clip.style.textEffects.find((e) => e.id === tfxSet[1]);
    if (fx) (fx as unknown as Record<string, unknown>)[tfxSet[2]!] = value;
  }
}

// ── Un-keying (the delete side of the same seam) ─────────────────────────────
//
// `setClipProperty` is where a path's base value is written, so it is also
// where "delete these keys and DON'T let the layer jump" belongs: the bake
// writer is literally the base setter. Every clip-facing delete — the diamond
// toggle, the timeline lane, the curve editor, Reset keyframes — routes here,
// so the behaviour cannot drift between surfaces.

/**
 * The base-value writer for a clip, refusing range-scoped tracks: those animate
 * a text SLICE whose resting value lives in the style range, not in the
 * clip-level slot — there is nothing for `setClipProperty` to write.
 */
function bakeOntoClip(clip: Clip) {
  return (property: string, value: KeyframeValue, track: KeyframeTrack) => {
    if (track.range) return;
    setClipProperty(clip, property, value);
  };
}

/**
 * Delete keyframes by id, leaving the clip exactly as it renders at
 * `atLocalMs` (clip-relative). Removing the last key of a property bakes the
 * value you can SEE into the base slot; properties that keep keys stay
 * animated. Returns keys removed. Mutates — call inside a document update.
 */
export function removeClipKeyframes(
  clip: Clip,
  keyIds: Iterable<string>,
  atLocalMs: number,
): number {
  const ids = keyIds instanceof Set ? (keyIds as Set<string>) : new Set(keyIds);
  if (ids.size === 0) return 0;
  return removeKeyframesKeepingValue(
    clip.keyframes,
    atLocalMs,
    (k) => ids.has(k.id),
    bakeOntoClip(clip),
  );
}

/**
 * "Reset keyframes" for whole properties (the per-property right-click): drop
 * every key of those tracks and freeze the pose at `atLocalMs`. Same rule as
 * `removeClipKeyframes` — one brain, two entry shapes.
 */
export function clearClipKeyframes(
  clip: Clip,
  properties: Iterable<string>,
  atLocalMs: number,
): number {
  const props = new Set(properties);
  if (props.size === 0) return 0;
  return removeKeyframesKeepingValue(
    clip.keyframes,
    atLocalMs,
    (_k, t) => props.has(t.property),
    bakeOntoClip(clip),
  );
}
