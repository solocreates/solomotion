import type { ClipKind, KeyframeValue } from "../schema";
import { LFX } from "./layer-effects";
import { AFX } from "../audio/effects/registry";
import { TFX } from "./text-effects";
import { isReferenceField, type EffectFieldDef } from "./effect-base";
import { MAX_SCALE_ABS } from "../resize";
import { STROKE_FIELDS, strokeField } from "../vector/stroke-fields";
import { PATTERN_COLOR_FIELDS, PATTERN_FIELDS } from "../vector/pattern-fields";
import { defaultPatternSpec, solidPaint, strokeStyle } from "../schema/vector";
import { ENABLED_FIELD } from "./activeness";
import { MODULATOR_FIELDS } from "./modulators";
import { MAX_SPEED, MIN_SPEED, SPEED_PROPERTY } from "./speed";
import { WORLD_PROPERTY_DEFS, worldPropertyDef } from "../world/fields";
import { bonePropertyDef } from "../rig/fields";
import { inputPropertyDef } from "../components/inputs-fields";
import { shapeKeyPropertyDef } from "../shape-keys/fields";
import { soundPropertyDef } from "../audio/sound-fields";
import { posePropertyDef } from "../rig/pose-fields";
import { FORCE } from "../physics/forces";
import { EMITTER } from "../physics/emitters";
import { BEHAVIOR } from "../behaviors/registry";
import { TRACE_PROPERTY_DEFS } from "../trace/fields";

/**
 * The animatable-property registry — the single contract for "what can hold a
 * keyframe and how it behaves". The web inspector renders keyframe controls
 * from this table; native adapters (Premiere / Resolve / Blender) read the
 * same table to map properties onto their own animation systems.
 *
 * Interpolation kinds:
 *  - number:   lerp through the segment easing
 *  - color:    per-channel rgba lerp through the segment easing
 *  - discrete: hold the previous key's value (no interpolation)
 */

export type PropertyKind = "number" | "color" | "discrete" | "geometry";

export type PropertyGroup =
  | "transform"
  | "typography"
  | "audio"
  | "vector"
  | "video"
  | "waveform"
  /** A trace's look (v109): `trace.<field>`. */
  | "trace"
  | "capture"
  | "caption"
  | "effects"
  /** The shutter (v56) — motion blur's animatable look fields. */
  | "motion"
  /** Auto layout (v73) — a container's gap, padding and box. */
  | "layout"
  /** The 3D kinds (v89): a camera's lens, a light, a surface, a mesh's shape. */
  | "camera"
  | "light"
  | "material"
  | "geometry"
  /** A rig's bones (v90): `bone.<id>.<channel>`, the pose of each bone. */
  | "rig"
  /** A switch group (v91): which member shows. */
  | "switch"
  /** A group's pose sets (Characters 2.0): `pose.<setId>`, which named pose shows. */
  | "pose"
  /** A force field a layer carries (v92). */
  | "field"
  /** A character's behaviors (Characters 3.0): `bhv.<id>.<field>`. */
  | "behavior"
  /** A component instance's inputs: `input.<id>` (Characters 2.0). */
  | "inputs";

export interface AnimatablePropertyDef {
  key: string;
  label: string;
  kind: PropertyKind;
  group: PropertyGroup;
  /** Value when neither keys nor a base value apply. */
  identity: KeyframeValue;
  /**
   * How the sampled value relates to the clip's base value. Everything is
   * `replace` — a keyframed value IS the value you see (After Effects
   * semantics: once a property has keys, the keys own it; without keys the
   * base value applies). Kept in the table so future layer kinds can opt into
   * additive composition without a schema change.
   */
  compose: "replace";
  appliesTo: ClipKind[];
  min?: number;
  max?: number;
  step?: number;
  /**
   * The number is a DISTANCE in px — so it may be written in any relational
   * unit (`spx`, `fw`, `%`…; `schema/units.ts`). Declared, never guessed: the
   * base table names its lengths (`LENGTH_KEYS`), and every registry-built
   * field (strokes, effects, patterns, glyph effects) is one when its field def
   * says `unit: "px"` — so a new effect's radius takes units with nothing
   * written here.
   */
  length?: boolean;
}

/**
 * Every clip kind that carries a transform (the registry's visual kinds).
 *
 * `adjustment` is one of them. A processor paints no ink, but it has a pose (the
 * DaVinci sizing node), a wet/dry mix, and — since it grades a REGION rather
 * than a silhouette — a crop window, corner radii and a feather that soften that
 * window's edge. Leaving it out was why none of those could be keyframed, hold a
 * driver, or appear on the node board, while the inspector edited them anyway.
 * What a processor does NOT read is narrowed per instance below.
 */
const VISUAL: ClipKind[] = ["text", "nested", "image", "video", "shape", "path", "waveform", "trace", "adjustment"];
/**
 * Kinds with a POSE: the visual kinds and the GROUP. A group's transform is a
 * delta applied to everything it holds (`groupPoseAt` samples its keys), and
 * its opacity and feather apply to its composited whole — the renderer and the
 * inspector did both while this registry left groups out, so the API, the
 * graph panel and the node board could not key what the Transform section
 * edited. The rest of the visual set (crop, content, shutter…) is not read off
 * a group.
 */
const POSED: ClipKind[] = [...VISUAL, "group"];
/** The 3D-only kinds (v89) — posed in a world, by origin rather than a pivot fraction. */
const SPATIAL: ClipKind[] = ["mesh", "camera", "light", "empty"];
/** Everything with a position, rotation and scale — the 2D posed set and the 3D kinds. */
const PLACED: ClipKind[] = [...POSED, ...SPATIAL];
const VECTOR: ClipKind[] = ["shape", "path"];
/** Every clip kind — for the universal base properties (the sound fader). */
const ALL_KINDS: ClipKind[] = ["text", "audio", "nested", "image", "video", "shape", "path", "waveform", "trace", ...SPATIAL];

export const PROPERTY_DEFS: AnimatablePropertyDef[] = [
  // Transform — absolute values; keys own the property once present.
  { key: "x", label: "X", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: PLACED, step: 1 },
  { key: "y", label: "Y", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: PLACED, step: 1 },
  // Scale bounds are SIGNED: a negative scale mirrors the layer (see resize.ts),
  // so the field must let you scrub or type straight through zero into -100%.
  { key: "scale", label: "Scale X", kind: "number", group: "transform", identity: 1, compose: "replace", appliesTo: PLACED, min: -MAX_SCALE_ABS, max: MAX_SCALE_ABS, step: 0.01 },
  { key: "scaleY", label: "Scale Y", kind: "number", group: "transform", identity: 1, compose: "replace", appliesTo: PLACED, min: -MAX_SCALE_ABS, max: MAX_SCALE_ABS, step: 0.01 },
  { key: "rotation", label: "Rotation", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: PLACED, step: 1 },
  // THE THIRD AXIS (v89). In a world Z is height; in a flat comp it is depth
  // (away from the viewer). The three rotations key as ONE property — see
  // `LINKED_CHANNELS` — and Euler order is Blender's XYZ.
  { key: "z", label: "Z", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: PLACED, step: 1 },
  { key: "rotationX", label: "Rotation X", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: PLACED, step: 1 },
  { key: "rotationY", label: "Rotation Y", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: PLACED, step: 1 },
  { key: "scaleZ", label: "Scale Z", kind: "number", group: "transform", identity: 1, compose: "replace", appliesTo: [...SPATIAL, "group"], min: -MAX_SCALE_ABS, max: MAX_SCALE_ABS, step: 0.01 },
  // Pivot — normalized (0.5 = center), keyframable because a moving pivot is a
  // legitimate animation (a limb's joint travelling, an orbit centre drifting).
  { key: "anchor.x", label: "Pivot X", kind: "number", group: "transform", identity: 0.5, compose: "replace", appliesTo: POSED, step: 0.01 },
  { key: "anchor.y", label: "Pivot Y", kind: "number", group: "transform", identity: 0.5, compose: "replace", appliesTo: POSED, step: 0.01 },
  { key: "skewX", label: "Skew X", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: POSED, min: -85, max: 85, step: 1 },
  { key: "skewY", label: "Skew Y", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: POSED, min: -85, max: 85, step: 1 },

  // ── The shutter (v56) ──────────────────────────────────────────────────────
  // Motion blur's LOOK fields are keyframable; its plumbing is not. Ramping
  // shutter angle up into a whip pan and back down is a shot people actually
  // make, and `strength` animates a subject from smeared to crisp as it lands.
  // `sampling`, `combine`, `weighting` and `maxSamples` are deliberately absent:
  // the first three are enums (a discrete key would silently pop the look
  // mid-motion) and the last is a frame budget, not something you perform.
  { key: "mblur.shutterAngle", label: "Shutter", kind: "number", group: "motion", identity: 180, compose: "replace", appliesTo: [...VISUAL, "camera"], min: 0, max: 3600, step: 1 },
  { key: "mblur.shutterPhase", label: "Phase", kind: "number", group: "motion", identity: -90, compose: "replace", appliesTo: VISUAL, min: -3600, max: 360, step: 1 },
  { key: "mblur.strength", label: "Strength", kind: "number", group: "motion", identity: 1, compose: "replace", appliesTo: [...VISUAL, "camera"], min: 0, max: 1, step: 0.01 },
  { key: "mblur.amount", label: "Amount", kind: "number", group: "motion", identity: 1, compose: "replace", appliesTo: VISUAL, min: 0, max: 4, step: 0.05 },
  { key: "opacity", label: "Opacity", kind: "number", group: "transform", identity: 1, compose: "replace", appliesTo: [...POSED, "mesh"], min: 0, max: 1, step: 0.01 },
  { key: "feather", label: "Feather", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: POSED, min: 0, step: 1 },
  { key: "borderRadius", label: "Corner radius", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: VISUAL, min: 0, step: 1 },
  { key: "borderRadius.tl", label: "Corner TL", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: VISUAL, min: 0, step: 1 },
  { key: "borderRadius.tr", label: "Corner TR", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: VISUAL, min: 0, step: 1 },
  { key: "borderRadius.br", label: "Corner BR", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: VISUAL, min: 0, step: 1 },
  { key: "borderRadius.bl", label: "Corner BL", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: VISUAL, min: 0, step: 1 },
  { key: "crop.top", label: "Crop top", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: VISUAL, min: 0, step: 1 },
  { key: "crop.right", label: "Crop right", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: VISUAL, min: 0, step: 1 },
  { key: "crop.bottom", label: "Crop bottom", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: VISUAL, min: 0, step: 1 },
  { key: "crop.left", label: "Crop left", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: VISUAL, min: 0, step: 1 },
  // The picture inside the window (v68). Keyframable like everything else, and
  // the reason it had to be: holding a crop steady while the footage zooms is a
  // SHOT, and expressing it as the layer's own scale cancelled against four
  // insets made the window swim between keys.
  { key: "content.x", label: "Content X", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: VISUAL, step: 1 },
  { key: "content.y", label: "Content Y", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: VISUAL, step: 1 },
  { key: "content.scale", label: "Content zoom", kind: "number", group: "transform", identity: 1, compose: "replace", appliesTo: VISUAL, min: -MAX_SCALE_ABS, max: MAX_SCALE_ABS, step: 0.01 },
  { key: "content.scaleY", label: "Content zoom Y", kind: "number", group: "transform", identity: 1, compose: "replace", appliesTo: VISUAL, min: -MAX_SCALE_ABS, max: MAX_SCALE_ABS, step: 0.01 },
  { key: "content.rotation", label: "Content rotation", kind: "number", group: "transform", identity: 0, compose: "replace", appliesTo: VISUAL, step: 1 },

  // Vector geometry + paint — corner radius, size, star maths, fill, stroke.
  { key: "width", label: "Width", kind: "number", group: "vector", identity: 100, compose: "replace", appliesTo: VECTOR.filter((k) => k === "shape"), min: 1, step: 1 },
  { key: "height", label: "Height", kind: "number", group: "vector", identity: 100, compose: "replace", appliesTo: ["shape"], min: 1, step: 1 },
  { key: "radius", label: "Corner radius", kind: "number", group: "vector", identity: 0, compose: "replace", appliesTo: ["shape"], min: 0, step: 1 },
  { key: "radius.tl", label: "Radius TL", kind: "number", group: "vector", identity: 0, compose: "replace", appliesTo: ["shape"], min: 0, step: 1 },
  { key: "radius.tr", label: "Radius TR", kind: "number", group: "vector", identity: 0, compose: "replace", appliesTo: ["shape"], min: 0, step: 1 },
  { key: "radius.br", label: "Radius BR", kind: "number", group: "vector", identity: 0, compose: "replace", appliesTo: ["shape"], min: 0, step: 1 },
  { key: "radius.bl", label: "Radius BL", kind: "number", group: "vector", identity: 0, compose: "replace", appliesTo: ["shape"], min: 0, step: 1 },
  { key: "pointCount", label: "Points", kind: "discrete", group: "vector", identity: 3, compose: "replace", appliesTo: ["shape"] },
  { key: "innerRatio", label: "Inner ratio", kind: "number", group: "vector", identity: 0.5, compose: "replace", appliesTo: ["shape"], min: 0.01, max: 1, step: 0.01 },
  { key: "arcStartDeg", label: "Arc start", kind: "number", group: "vector", identity: 0, compose: "replace", appliesTo: ["shape"], step: 1 },
  { key: "arcSweepDeg", label: "Arc sweep", kind: "number", group: "vector", identity: 360, compose: "replace", appliesTo: ["shape"], min: 0, max: 360, step: 1 },
  { key: "arcRatio", label: "Arc ratio", kind: "number", group: "vector", identity: 0, compose: "replace", appliesTo: ["shape"], min: 0, max: 0.99, step: 0.01 },
  // Fills & strokes are LISTS: every entry's values are addressed per-id
  // (`fill.<id>.color`, `stroke.<id>.width`, …) and their defs are synthesized
  // on demand in `paintPropertyDef` — so N paints all keyframe with no table growth.
  // Path geometry — vector MORPHING: keys hold whole geometries; matching
  // structures interpolate point-to-point, mismatches hold.
  { key: "geometry", label: "Path", kind: "geometry", group: "vector", identity: 0, compose: "replace", appliesTo: ["path"] },
  // Trim paths live on each STROKE now (`stroke.<id>.trim.…`), synthesized in
  // `paintPropertyDef` like every other per-entry value — see `strokeStyleSchema`.

  // Capture — recordable pixel/vector state over time. Discrete string values
  // name a snapshot surface (drawing/capture); held per frame like FBF, and the
  // renderer optionally crossfades between snapshots. Applies to any paintable
  // surface: the raster/vector layer itself, or a media clip's paint overlay.
  { key: "capture", label: "Capture", kind: "discrete", group: "capture", identity: "", compose: "replace", appliesTo: ["raster", "image", "video", "shape", "path"] },

  // ── SPEED (v70) ───────────────────────────────────────────────────────────
  // The clip's playback rate, and an ordinary animatable number like any other
  // — which is the whole design. A speed RAMP is two keys with an easing; a
  // FREEZE FRAME is a stretch at rate 0; the curve editor, the dope sheet, `E`,
  // record mode, drivers and expressions all work on it because nothing here
  // is special. `retime.ts` integrates the curve into source time; everything
  // downstream reads that through the one seam it already used.
  //
  // The range is signed: a negative rate runs the source backwards, which is
  // what a local reverse IS. `playback.reverse` remains the cheaper whole-clip
  // switch.
  { key: SPEED_PROPERTY, label: "Speed", kind: "number", group: "video", identity: 1, compose: "replace", appliesTo: ["video", "nested", "image", "audio"], min: MIN_SPEED, max: MAX_SPEED, step: 0.05 },

  // Video sound.
  { key: "volume", label: "Volume", kind: "number", group: "video", identity: 1, compose: "replace", appliesTo: ["video"], min: 0, max: 1, step: 0.01 },
  { key: "pitch", label: "Pitch", kind: "number", group: "video", identity: 0, compose: "replace", appliesTo: ["video"], min: -24, max: 24, step: 0.5 },

  // Typography — absolute overrides of the clip's base style.
  { key: "fontSize", label: "Font size", kind: "number", group: "typography", identity: 0, compose: "replace", appliesTo: ["text"], min: 1, step: 1 },
  { key: "letterSpacing", label: "Letter spacing", kind: "number", group: "typography", identity: 0, compose: "replace", appliesTo: ["text"], step: 0.5 },
  { key: "lineHeight", label: "Line height", kind: "number", group: "typography", identity: 1.15, compose: "replace", appliesTo: ["text"], min: 0.5, max: 3, step: 0.05 },
  { key: "color", label: "Color", kind: "color", group: "typography", identity: "#ffffff", compose: "replace", appliesTo: ["text"] },
  // Font family — a discrete string (holds between keys, no tween). Exposed so the
  // Typography node offers the reusable font picker and can be driven/bound.
  { key: "fontFamily", label: "Font", kind: "discrete", group: "typography", identity: "Inter", compose: "replace", appliesTo: ["text"] },
  // Weight TWEENS. It used to be discrete, which was right while a weight
  // could only name a face — but most of the catalogue is variable now, and a
  // variable face draws 437 as readily as 400. A static family simply snaps to
  // its nearest face as the value passes, which is what CSS matching does.
  { key: "fontWeight", label: "Weight", kind: "number", group: "typography", identity: 400, compose: "replace", appliesTo: ["text"], min: 1, max: 1000, step: 1 },
  { key: "fauxBold", label: "Faux bold", kind: "number", group: "typography", identity: 0, compose: "replace", appliesTo: ["text"], min: 0, max: 0.25, step: 0.005 },
  { key: "italic", label: "Italic", kind: "discrete", group: "typography", identity: false, compose: "replace", appliesTo: ["text"] },
  // The text BOX. Not typography — it is the frame the type flows in — but it
  // lives beside it because it is the other half of "how does this read": a box
  // that grows re-wraps the lines, so animating it is a layout animation, not a
  // scale. Keying either axis pins that axis (auto → fixed), which is exactly
  // what "I want this width at this moment" means.
  { key: "maxWidth", label: "Box width", kind: "number", group: "typography", identity: 0, compose: "replace", appliesTo: ["text"], min: 1, step: 1 },
  { key: "maxHeight", label: "Box height", kind: "number", group: "typography", identity: 0, compose: "replace", appliesTo: ["text"], min: 1, step: 1 },
  // The text string itself — keyframable (holds between keys, no tween).
  { key: "text", label: "Content", kind: "discrete", group: "typography", identity: "", compose: "replace", appliesTo: ["text"] },

  // TEXT ON A PATH (v73). `offset` is in laps — 0→3 is three times round — so
  // a spin is one key on one number; `rise` lifts off the outline in px.
  // Kind-gated like `focusScale`: a text with no path reads undefined.
  { key: "path.offset", label: "Path offset", kind: "number", group: "typography", identity: 0, compose: "replace", appliesTo: ["text"], step: 0.01 },
  { key: "path.rise", label: "Path rise", kind: "number", group: "typography", identity: 0, compose: "replace", appliesTo: ["text"], step: 1 },

  // AUTO LAYOUT (v73) — the container's numbers. Animating a gap makes a row
  // breathe; animating a width re-breaks a wrap; both are layout animations
  // nothing else in the app can fake.
  // A SWITCH group's one choice (v91): a member's name, or its place from the
  // top. Discrete — a blink cuts, it does not cross-fade.
  { key: "switch", label: "Show", kind: "discrete", group: "switch", identity: "", compose: "replace", appliesTo: ["group"] },
  { key: "layout.gap", label: "Gap", kind: "number", group: "layout", identity: 0, compose: "replace", appliesTo: ["group"], min: 0, step: 1 },
  { key: "layout.lineGap", label: "Line gap", kind: "number", group: "layout", identity: 0, compose: "replace", appliesTo: ["group"], min: 0, step: 1 },
  { key: "layout.padding.top", label: "Padding top", kind: "number", group: "layout", identity: 0, compose: "replace", appliesTo: ["group"], min: 0, step: 1 },
  { key: "layout.padding.right", label: "Padding right", kind: "number", group: "layout", identity: 0, compose: "replace", appliesTo: ["group"], min: 0, step: 1 },
  { key: "layout.padding.bottom", label: "Padding bottom", kind: "number", group: "layout", identity: 0, compose: "replace", appliesTo: ["group"], min: 0, step: 1 },
  { key: "layout.padding.left", label: "Padding left", kind: "number", group: "layout", identity: 0, compose: "replace", appliesTo: ["group"], min: 0, step: 1 },
  { key: "layout.width", label: "Width", kind: "number", group: "layout", identity: 0, compose: "replace", appliesTo: ["group"], min: 1, step: 1 },
  { key: "layout.height", label: "Height", kind: "number", group: "layout", identity: 0, compose: "replace", appliesTo: ["group"], min: 1, step: 1 },
  { key: "layout.x", label: "Box X", kind: "number", group: "layout", identity: 0, compose: "replace", appliesTo: ["group"], step: 1 },
  { key: "layout.y", label: "Box Y", kind: "number", group: "layout", identity: 0, compose: "replace", appliesTo: ["group"], step: 1 },

  // The caption FOCUS pop. `appliesTo` is a kind gate, not an availability
  // one — `getClipProperty` returns undefined on a text layer with no caption
  // module, which is what every surface already treats as "this layer has no
  // such property".
  { key: "focusScale", label: "Focus pop", kind: "number", group: "caption", identity: 1, compose: "replace", appliesTo: ["text"], min: 1, max: 2, step: 0.02 },

  // Universal sound trim — the master fader on EVERY clip (mute + volume). The
  // headless audio inventory multiplies it into whatever sound the clip makes.
  { key: "audioMix.volume", label: "Volume", kind: "number", group: "audio", identity: 1, compose: "replace", appliesTo: ALL_KINDS, min: 0, max: 4, step: 0.01 },

  // Audio. `gain` is the volume envelope (linear; the UI speaks dB). Up to 4 = +12 dB.
  { key: "gain", label: "Volume", kind: "number", group: "audio", identity: 1, compose: "replace", appliesTo: ["audio"], min: 0, max: 4, step: 0.01 },
  { key: "pitch", label: "Pitch", kind: "number", group: "audio", identity: 0, compose: "replace", appliesTo: ["audio"], min: -24, max: 24, step: 0.5 },
  // Parametric EQ bands are addressed by id (`eq.<id>.gain|freq|q`); their defs
  // are synthesized on demand (see `eqBandPropertyDef`) so the registry never
  // grows with the band count.

  // Waveform style — sampled by the renderer over the clip's static style, so
  // reactivity itself can be animated (build-ups, drops, color sweeps).
  { key: "wave.amplitude", label: "Amplitude", kind: "number", group: "waveform", identity: 1, compose: "replace", appliesTo: ["waveform"], min: 0, max: 4, step: 0.01 },
  { key: "wave.glow", label: "Glow", kind: "number", group: "waveform", identity: 0, compose: "replace", appliesTo: ["waveform"], min: 0, max: 120, step: 1 },
  { key: "wave.thickness", label: "Thickness", kind: "number", group: "waveform", identity: 3, compose: "replace", appliesTo: ["waveform"], min: 0.5, max: 60, step: 0.5 },
  { key: "wave.color", label: "Wave color", kind: "color", group: "waveform", identity: "#ffffff", compose: "replace", appliesTo: ["waveform"] },
  // A trace's look — rows owned by `trace/fields.ts`, read by the renderer at
  // the instant, so a head can swell or a tail cool faster as the shot goes on.
  ...TRACE_PROPERTY_DEFS,
  // Camera, light, material and mesh fields — rows owned by the 3D registry.
  ...WORLD_PROPERTY_DEFS,
];

/** The base table's distances (see `AnimatablePropertyDef.length`). */
const LENGTH_KEYS: ReadonlySet<string> = new Set([
  "x", "y", "z", "feather",
  "borderRadius", "borderRadius.tl", "borderRadius.tr", "borderRadius.br", "borderRadius.bl",
  "crop.top", "crop.right", "crop.bottom", "crop.left", "content.x", "content.y",
  "width", "height", "radius", "radius.tl", "radius.tr", "radius.br", "radius.bl",
  "fontSize", "letterSpacing", "maxWidth", "maxHeight", "path.rise",
  "layout.gap", "layout.lineGap", "layout.padding.top", "layout.padding.right", "layout.padding.bottom", "layout.padding.left",
  "layout.width", "layout.height", "layout.x", "layout.y",
  "wave.thickness",
]);
for (const d of PROPERTY_DEFS) if (LENGTH_KEYS.has(d.key)) d.length = true;

const byKey = new Map(PROPERTY_DEFS.map((d) => [d.key, d]));

// Paint paths carry ENTRY ids (`fill.<id>…`, `stroke.<id>…`), so every def is
// synthesized on demand — the registry never grows with the paint count. The
// sub-path after the id is what selects the def (color / opacity / stop / …).
// Paint now belongs to EVERY visual clip (unified fills/strokes), so the defs
// apply across all of them, not just vectors.
const def = (key: string, label: string, kind: PropertyKind, identity: KeyframeValue, extra: Partial<AnimatablePropertyDef> = {}): AnimatablePropertyDef => ({
  key,
  label,
  kind,
  group: "vector",
  identity,
  compose: "replace",
  appliesTo: VISUAL,
  ...extra,
});

/**
 * Stroke property defs come from the STROKE FIELD REGISTRY — the same table the
 * editor and the Brush Studio render — so a new animatable stroke field gets
 * curve rows, dope-sheet entries, record mode, drivers and modulators from one
 * line there. This used to be a second copy of the labels and ranges, and the
 * two had already begun to disagree about what "Dash offset" was called.
 */
const STROKE_FIELD_BY_KEY = new Map(STROKE_FIELDS.map((f) => [f.key, f]));

/** A pristine stroke — the IDENTITY every stroke field resets/composes toward,
 *  read from the constructor rather than restated as a second list of numbers. */
const IDENTITY_STROKE = strokeStyle(solidPaint("#000000"));

/** The pattern registry, keyed — and a pristine spec to read identities from,
 *  rather than restating the defaults as a second list of numbers. */
const PATTERN_FIELD_BY_KEY = new Map(PATTERN_FIELDS.map((f) => [f.key, f]));
const IDENTITY_PATTERN = defaultPatternSpec() as unknown as Record<string, number>;

function paintPropertyDef(key: string): AnimatablePropertyDef | undefined {
  const m = /^(fill|stroke)\.([^.]+)(?:\.(.+))?$/.exec(key);
  if (!m) return undefined;
  const list = m[1]!;
  const sub = m[3] ?? "";

  // Gradient stop — `…stop.<id>.color|offset`.
  const stop = /^stop\.[^.]+\.(offset|color)$/.exec(sub);
  if (stop) {
    const isOffset = stop[1] === "offset";
    return isOffset
      ? def(key, "Stop position", "number", 0, { min: 0, max: 1, step: 0.01 })
      : def(key, "Stop color", "color", "#ffffff");
  }
  // Gradient geometry — the unified `start.x|start.y|end.x|end.y` handles.
  if (/^(start|end)\.(x|y)$/.test(sub)) return def(key, "Gradient handle", "number", 0.5, { min: -1, max: 2, step: 0.01 });
  // Pattern fields — `pattern.<field>` — synthesized from the SAME registry the
  // Pattern Studio renders, so a knob added there is animatable, bindable and
  // modulatable with nothing written here.
  const pattern = /^pattern\.(.+)$/.exec(sub);
  if (pattern) {
    const field = pattern[1]!;
    const colour = PATTERN_COLOR_FIELDS.find((c) => c.key === field);
    if (colour) return def(key, `Pattern ${colour.label.toLowerCase()}`, "color", "#000000");
    const spec = PATTERN_FIELD_BY_KEY.get(field);
    if (spec) {
      return def(key, `Pattern ${spec.label.toLowerCase()}`, "number", IDENTITY_PATTERN[field as keyof typeof IDENTITY_PATTERN] ?? 0, {
        min: spec.min,
        max: spec.max,
        step: spec.step,
        length: spec.unit === "px",
      });
    }
  }
  // Entry scalars.
  if (sub === "opacity") return def(key, list === "fill" ? "Fill opacity" : "Stroke opacity", "number", 1, { min: 0, max: 1, step: 0.01 });
  if (list === "stroke") {
    if (sub === "color") return def(key, "Stroke color", "color", "#ffffff");
    // Every field of the stroke PIPELINE — width, dash, trim, profile, wave,
    // ends — comes from ONE registry, so adding an animatable stroke field is a
    // line in `STROKE_FIELDS` and nothing else, anywhere.
    const field = STROKE_FIELD_BY_KEY.get(sub);
    if (field) {
      const identity = strokeField(IDENTITY_STROKE, sub);
      return def(key, field.label, field.kind === "select" ? "discrete" : "number", identity, {
        min: field.min,
        max: field.max,
        step: field.step,
        length: field.unit === "px",
      });
    }
  }
  // Bare `fill.<id>` — a solid fill's color. (`stroke.<id>` alone isn't a value.)
  if (list === "fill" && sub === "") return def(key, "Fill", "color", "#ffffff");
  return undefined;
}

// Effect fields — `lfx.<id>.<field>` (pixels) and `afx.<id>.<field>` (sound).
// ONE synthesizer for both, driven by the registry each prefix belongs to, so a
// domain that registers an effect kind gets curve rows, dope-sheet entries and
// record mode with nothing written here.

interface EffectPropertySource {
  registry: { pathPattern: RegExp; types: Array<{ fields: EffectFieldDef[] }> };
  group: AnimatablePropertyDef["group"];
  appliesTo: AnimatablePropertyDef["appliesTo"];
}

/**
 * One row per effect DOMAIN. A domain registers itself with a single line, and
 * every `<prefix>.<id>.<field>` path it owns gets curve rows, dope-sheet
 * entries, record mode, drivers and modulators with nothing else written.
 */
/** Clip kinds that can carry an audio effect chain — everything that makes sound. */
const AUDIBLE: ClipKind[] = ["audio", "video", "nested"];

const EFFECT_PROPERTY_SOURCES: EffectPropertySource[] = [
  { registry: LFX, group: "effects", appliesTo: VISUAL },
  // Sound. `audioEffects` rides `clipBase`, so this is three kinds, not one:
  // a video's dialogue and a nested comp's mix want EQ as much as a music bed.
  { registry: AFX, group: "audio", appliesTo: AUDIBLE },
  // Per glyph. The stack rides the text style, so only a text layer owns the
  // tracks — but a caption is a text layer, so this is one kind, not two.
  { registry: TFX, group: "typography", appliesTo: ["text"] },
  // Forces (v93): a gust is two keys on `force.<id>.strength`.
  { registry: FORCE, group: "field", appliesTo: ALL_KINDS },
  // Particles (v102): a stream swells and stops by keys on `emit.<id>.rate`.
  { registry: EMITTER, group: "field", appliesTo: ALL_KINDS },
  // Behaviors (Characters 3.0): blink faster when nervous is keys on `bhv.<id>.every`.
  { registry: BEHAVIOR, group: "behavior", appliesTo: ["group"] },
];

function effectPropertyDef(key: string): AnimatablePropertyDef | undefined {
  for (const source of EFFECT_PROPERTY_SOURCES) {
    const m = source.registry.pathPattern.exec(key);
    if (!m) continue;
    const field = m[1]!;
    // The card's own SWITCH. A discrete boolean holds between keys (there is no
    // halfway between on and off), which is what makes "this effect is off
    // until 00:04" the same kind of animation as everything else — see
    // `animation/activeness.ts`.
    if (field === ENABLED_FIELD) {
      return {
        key,
        label: "Enabled",
        kind: "discrete",
        group: source.group,
        identity: true,
        compose: "replace",
        appliesTo: source.appliesTo,
      };
    }

    // The path carries the effect INSTANCE id, not its type, so this lookup only
    // has the field name to go on — and several cards legitimately share one
    // (`amount`, `color`, `angle`, `blend`). Rather than trusting whichever card
    // happens to be first in the registry, merge every declaration of the name:
    // the RANGE widens to cover all of them (so the curve editor never clamps a
    // value that is legal on the card you're actually editing), and a field whose
    // interpolation KIND is contested is refused outright, because guessing there
    // would render the wrong control. In practice nothing is contested — this is
    // the guard that keeps it that way as cards are added.
    let kind: EffectFieldDef["kind"] | null = null;
    let label = "";
    let min: number | undefined;
    let max: number | undefined;
    let step: number | undefined;
    let length = false;
    for (const type of source.registry.types) {
      const def = type.fields.find((f) => f.key === field);
      if (!def) continue;
      if (def.unit === "px") length = true;
      if (kind === null) {
        kind = def.kind;
        label = def.label;
      } else if (kind !== def.kind) {
        return undefined;
      }
      if (def.min !== undefined) min = min === undefined ? def.min : Math.min(min, def.min);
      if (def.max !== undefined) max = max === undefined ? def.max : Math.max(max, def.max);
      if (def.step !== undefined) step = step === undefined ? def.step : Math.min(step, def.step);
    }
    if (kind === null) return undefined;
    return {
      key,
      label,
      // An enum HOLDS: there is no halfway between a dot mask and a slot mask.
      kind: kind === "select" || isReferenceField(kind) ? "discrete" : kind,
      group: source.group,
      identity: kind === "number" ? 0 : kind === "color" ? "#000000" : "",
      compose: "replace",
      appliesTo: source.appliesTo,
      min,
      max,
      step,
      ...(length && kind === "number" ? { length: true } : {}),
    };
  }
  return undefined;
}

// Per-corner nudges (`corner.<i>.x|y`) — one synthesized numeric def each, so a
// shape with any vertex count keyframes its corners with no table growth. They
// lerp for free (plain numbers), which is what makes edited corners animatable.
const CORNER_PATH = /^corner\.(\d+)\.(x|y)$/;
function shapeCornerPropertyDef(key: string): AnimatablePropertyDef | undefined {
  const m = CORNER_PATH.exec(key);
  if (!m) return undefined;
  return def(key, `Corner ${Number(m[1]) + 1} ${m[2]!.toUpperCase()}`, "number", 0, {
    appliesTo: ["shape"],
    step: 1,
  });
}

// Parametric EQ band fields — `afx.<effectId>.band.<bandId>.<gain|freq|q>`.
// Bands are a LIST inside the EQ card, so their paths carry two ids and cannot
// ride the registry's flat `<prefix>.<id>.<field>` pattern. One synthesized def
// each, so a curve with any number of bands keyframes with no table growth —
// the same per-id trick paints, shape corners and gradient stops already use.
const EQ_BAND_PATH = /^afx\.[^.]+\.band\.[^.]+\.(gain|freq|q)$/;
function eqBandPropertyDef(key: string): AnimatablePropertyDef | undefined {
  const m = EQ_BAND_PATH.exec(key);
  if (!m) return undefined;
  const audio = (label: string, identity: number, min: number, max: number, step: number): AnimatablePropertyDef =>
    ({ key, label, kind: "number", group: "audio", identity, compose: "replace", appliesTo: AUDIBLE, min, max, step });
  if (m[1] === "gain") return audio("EQ gain", 0, -24, 24, 0.5);
  if (m[1] === "freq") return audio("EQ freq", 1000, 20, 20000, 1);
  return audio("EQ Q", 0.707, 0.05, 18, 0.01);
}

// Node-graph parameters (`node.<nodeId>.<paramKey>`) — a layer's node tree drives
// values, and any numeric node value is keyframable on the OWNING clip like any
// other property. One synthesized numeric def, so the curve editor, the timeline
// and the sampler all recognise node keyframes with zero per-node table growth —
// the node board just reuses the whole animation ecosystem.
const NODE_PARAM_PATH = /^node\.[^.]+\.[^.]+$/;
function nodeParamPropertyDef(key: string): AnimatablePropertyDef | undefined {
  if (!NODE_PARAM_PATH.test(key)) return undefined;
  return { key, label: "Node value", kind: "number", group: "effects", identity: 0, compose: "replace", appliesTo: VISUAL };
}

// Modulator fields — `mod.<id>.<field>`. A modulator is edited by the same
// registry-driven machinery an effect is, so its animatable properties come
// from the SAME field table the editor renders (`MODULATOR_FIELDS`) rather than
// a second list of labels and ranges that would drift from it. This is what
// makes "the shake ramps in and then switches off" ordinary keyframing.
const MODULATOR_PATH = /^mod\.[^.]+\.(.+)$/;
const MODULATOR_FIELD_BY_KEY = new Map(MODULATOR_FIELDS.map((f) => [f.key, f]));
function modulatorPropertyDef(key: string): AnimatablePropertyDef | undefined {
  const m = MODULATOR_PATH.exec(key);
  if (!m) return undefined;
  const field = m[1]!;
  if (field === ENABLED_FIELD) {
    return { key, label: "Enabled", kind: "discrete", group: "effects", identity: true, compose: "replace", appliesTo: ALL_KINDS };
  }
  const f = MODULATOR_FIELD_BY_KEY.get(field);
  if (!f) return undefined;
  return {
    key,
    label: f.label,
    kind: f.kind === "select" ? "discrete" : f.kind === "color" ? "color" : "number",
    group: "effects",
    identity: 0,
    compose: "replace",
    appliesTo: ALL_KINDS,
    min: f.min,
    max: f.max,
    step: f.step,
  };
}

/**
 * `lfx.<card>.n.<node>.…` — a value inside a grade card's node graph.
 *
 * The path carries instance ids, never types, so — exactly like
 * `effectPropertyDef` — this has only the LEAF field name to go on. That is
 * enough, because a grade's leaf vocabulary is closed and small: the tree
 * structure is what varies, not the names at its ends. A field inside a node's
 * effect stack (`…fx.<id>.<field>`) is handed straight back to the effect
 * resolver, so every grading card keyframes inside a node exactly as it does
 * outside one, with nothing listed twice.
 */
const GRADE_LEAF: Record<string, { label: string; kind: PropertyKind; min?: number; max?: number; step?: number }> = {
  opacity: { label: "Opacity", kind: "number", min: 0, max: 1, step: 0.01 },
  center: { label: "Centre", kind: "number", step: 0.01 },
  width: { label: "Width", kind: "number", min: 0, step: 0.01 },
  softLow: { label: "Soft low", kind: "number", min: 0, step: 0.01 },
  softHigh: { label: "Soft high", kind: "number", min: 0, step: 0.01 },
  near: { label: "Near", kind: "number", min: 0, max: 1, step: 0.01 },
  far: { label: "Far", kind: "number", min: 0, max: 1, step: 0.01 },
  softness: { label: "Softness", kind: "number", min: 0, max: 1, step: 0.01 },
  blurPx: { label: "Matte blur", kind: "number", min: 0, max: 128, step: 1 },
  shrinkPx: { label: "Matte shrink", kind: "number", min: -64, max: 64, step: 1 },
  feather: { label: "Feather", kind: "number", min: 0, max: 400, step: 1 },
  expand: { label: "Expand", kind: "number", min: -200, max: 200, step: 1 },
  x: { label: "X", kind: "number", step: 1 },
  y: { label: "Y", kind: "number", step: 1 },
  scale: { label: "Scale", kind: "number", min: 0.01, step: 0.01 },
  scaleY: { label: "Scale Y", kind: "number", min: 0.01, step: 0.01 },
  rotation: { label: "Rotation", kind: "number", step: 1 },
};

const GRADE_PATH = /^lfx\.[^.]+\.n\.[^.]+\.(.+)$/;

function gradePropertyDef(key: string): AnimatablePropertyDef | undefined {
  const m = GRADE_PATH.exec(key);
  if (!m) return undefined;
  const rest = m[1]!;
  if (rest === ENABLED_FIELD) {
    return { key, label: "Enabled", kind: "discrete", group: "effects", identity: true, compose: "replace", appliesTo: ALL_KINDS };
  }
  // A field of an effect INSIDE the node — reuse the effect resolver wholesale.
  const fx = /^fx\.[^.]+\.(.+)$/.exec(rest);
  if (fx) {
    const inner = effectPropertyDef(`lfx.x.${fx[1]!}`);
    return inner ? { ...inner, key } : undefined;
  }
  // The discrete leaves — a switch, a mode. They HOLD between keys, which is
  // what makes "inverted from 00:04" an ordinary animation rather than a fade
  // through a state that does not exist.
  const tail = rest.split(".").pop()!;
  if (tail === "on" || tail === "invert") {
    return { key, label: tail === "on" ? "Qualifier" : "Invert", kind: "discrete", group: "effects", identity: false, compose: "replace", appliesTo: ALL_KINDS };
  }
  if (tail === "input" || tail === "combine" || tail === "blend") {
    return { key, label: tail === "blend" ? "Blend" : tail === "input" ? "Incoming key" : "Combine", kind: "discrete", group: "effects", identity: "", compose: "replace", appliesTo: ALL_KINDS };
  }
  const leaf = GRADE_LEAF[tail];
  if (!leaf) return undefined;
  return {
    key,
    label: leaf.label,
    kind: leaf.kind,
    group: "effects",
    identity: 0,
    compose: "replace",
    appliesTo: ALL_KINDS,
    min: leaf.min,
    max: leaf.max,
    step: leaf.step,
  };
}

export function propertyDef(key: string): AnimatablePropertyDef | undefined {
  return (
    byKey.get(key) ??
    paintPropertyDef(key) ??
    gradePropertyDef(key) ??
    effectPropertyDef(key) ??
    modulatorPropertyDef(key) ??
    shapeCornerPropertyDef(key) ??
    eqBandPropertyDef(key) ??
    nodeParamPropertyDef(key) ??
    worldPropertyDef(key) ??
    bonePropertyDef(key) ??
    inputPropertyDef(key) ??
    posePropertyDef(key) ??
    shapeKeyPropertyDef(key) ??
    soundPropertyDef(key)
  );
}

export function propertiesFor(kind: ClipKind, group?: PropertyGroup): AnimatablePropertyDef[] {
  return PROPERTY_DEFS.filter(
    (d) => d.appliesTo.includes(kind) && (group === undefined || d.group === group),
  );
}

// ── Color math lives in a leaf (colors/hex.ts); re-exported for existing callers.
export { formatHexColor, lerpColor, parseHexColor, type Rgba } from "../colors/hex";
