import { z } from "zod";
import { lengthSpecSchema } from "./units";
import { modulatorSchema } from "./modulators";
import { blendModeSchema, easingSchema, millisecondsSchema, transformSchema } from "./common";
import {
  animationSpecSchema,
  clipPlaybackSchema,
  keyframeTrackSchema,
  layerAnimationSpecSchema,
} from "./animation";
import { partialTextStyleSchema, textStyleSchema } from "./text-style";
import { emptyOverlay, scopeOverlaySchema } from "./scope";
import { rangeSoundOverridesSchema, soundPackIdSchema, soundStackSchema } from "./sound";
import { layerEffectListSchema } from "./layer-effects";
import { audioEffectSchema } from "./audio-effects";
import { duckRuleSchema } from "./sound-mix";
import { clipMotionBlurSchema } from "./motion-blur";
import { traceSpecSchema } from "./trace";
import { trackBindingSchema } from "./tracking";
import { DEFAULT_LAYOUT_ITEM, layoutItemSchema, layoutSpecSchema, textPathSpecSchema, type TextPathSpec } from "./relations";
import { clipOriginSchema } from "./provenance";
import { bindSchema, rigSchema } from "./rig";
import { inputValuesSchema } from "./inputs";
import { shapeKeysSchema } from "./shape-keys";
import { poseSetSchema } from "./poses";
import { behaviorSchema } from "./behaviors";
import { linkSchema } from "./links";
import { emitterSchema, forceSchema, jointSchema, physicsSchema } from "./physics";
import {
  cameraSpecSchema,
  constraintSchema,
  extrudeSchema,
  lightSpecSchema,
  materialSchema,
  meshLinesSchema,
  lineArtSchema,
  latticeSpecSchema,
  meshPartSchema,
  meshSourceSchema,
  modifierSchema,
} from "./world";
import {
  cornerRadiusSchema,
  fillRuleSchema,
  paintSchema,
  shapeKindSchema,
  strokeStyleSchema,
  subpathSchema,
} from "./vector";

/**
 * The universal sound trim (v31). EVERY clip carries it — the ONE headless
 * fader the audio inventory multiplies into whatever sound the clip produces:
 * text typing cues, an audio clip's envelope, a video's volume, or the WHOLE
 * sub-mix of a nested comp. `muted` drops the clip's sound entirely. It's a
 * master on TOP of any kind-specific level (video `volume`, audio `gain`), so a
 * new sound-bearing clip kind gets mute + a keyframable volume for free, with
 * no per-kind code. `audioMix.volume` is a keyframe path like any other.
 */
export const audioMixSchema = z.object({
  /** Linear master multiplier. 1 = unity; up to 4 = +12 dB. */
  volume: z.number().min(0).max(4).default(1),
  muted: z.boolean().default(false),
});
export type AudioMix = z.infer<typeof audioMixSchema>;

/**
 * Universal CROP insets (v40) — per-side, in the layer's own (unscaled) box px.
 * All 0 = uncropped. Shared by every visual clip via `visualClipBase.crop`; the
 * render seam, the on-stage crop gesture and the inspector all read/write it.
 *
 * This is THE WINDOW and nothing else: where the visible rectangle is, in the
 * layer's own box. Where the PICTURE sits inside that window is `content`
 * (below) — see its comment for why the two are separate facts.
 */
export const cropSchema = z.object({
  top: z.number().min(0).default(0),
  right: z.number().min(0).default(0),
  bottom: z.number().min(0).default(0),
  left: z.number().min(0).default(0),
});
export type CropInsets = z.infer<typeof cropSchema>;

/** The uncropped framing — the one literal every factory reuses. */
export const NO_CROP: CropInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * The CONTENT TRANSFORM (v68) — where the picture sits INSIDE the layer's
 * window, as opposed to where the window sits in the comp.
 *
 * ## Why this exists
 *
 * A layer has always had one transform, and a crop window measured in that
 * layer's own box. So the window is carried by the transform: scale the layer
 * and the window scales with it. That is right for "make this bigger" and
 * exactly wrong for the thing people spend their time doing — *hold this
 * framing still and move the footage behind it*. Doing that with one transform
 * means writing the layer's scale, then re-deriving all four insets to undo it,
 * then re-deriving the position so the window has not drifted; under keyframes
 * it means doing that at every key, and the window visibly swims between them
 * because three animated quantities are cancelling to a constant that nothing
 * in the document states.
 *
 * Panning already had a version of this — the layer moved one way while the
 * insets absorbed the same amount the other — and it has the same defect in
 * miniature: it writes the layer's `x`/`y`, so reframing a picture fought any
 * animation the LAYER had, and the cancellation had to be clamped in one place
 * or the window crept.
 *
 * ## The shape
 *
 * Two transforms, two jobs, and neither has to cancel the other:
 *
 *   `transform`   places the WINDOW in the comp. Move it, scale it, rotate it —
 *                 the picture goes with it, rigidly, the way it always did.
 *   `content`     places the PICTURE inside the window. Pan, zoom and rotate
 *                 the footage with the framing nailed down.
 *
 * It is the split every finishing tool has: Resolve's input sizing beside its
 * output sizing, Premiere's Motion beside its crop, Figma's crop-mode image
 * fill. Identity (the default) costs nothing and renders byte for byte as
 * before, so every document made before v68 is untouched.
 *
 * The pivot is the layer's OWN BOX CENTRE — never the window's — and that is
 * the load-bearing decision, because the window's centre is a function of the
 * insets. Pivot about it and the two facts are coupled again through the
 * pivot: dragging a crop edge would move every non-identity picture by
 * `(1 − zoom)` times however far the window travelled, which is the exact
 * coupling this field exists to remove. Nothing in the map reads the crop, so
 * reframing the window changes what you SEE and never what the picture is
 * doing — under a keyframe as much as under the pointer. `transform-map.ts`
 * carries the full account.
 *
 * A gesture that wants some other point held still (a corner drag, a typed
 * zoom) writes the pan that holds it. That is a property of the gesture, not of
 * the stored transform, and keeping it there is what stops a second pivot from
 * appearing that every reader would then have to know about.
 *
 * Non-identity content implies a CLIP to the window — the layer's box becomes a
 * window onto its content — so scaling the picture up never spills past the
 * frame you cropped, with or without insets.
 *
 * `scaleY: null` mirrors `scale` (uniform), exactly as `transform.scaleY` does.
 */
export const contentTransformSchema = z.object({
  /**
   * Pan, in the layer's own box px, applied OUTSIDE the zoom (the CSS/After
   * Effects order) — so a drag moves the picture 1:1 with the pointer however
   * far in you are, with nothing to divide by.
   */
  x: z.number().default(0),
  y: z.number().default(0),
  /** Zoom about the box centre. Signed — a negative scale mirrors the art. */
  scale: z.number().default(1),
  /** null = uniform (mirrors `scale`); a number breaks the link. */
  scaleY: z.number().nullable().default(null),
  /** Degrees, about the box centre. */
  rotation: z.number().default(0),
});
export type ContentTransform = z.infer<typeof contentTransformSchema>;

/** The picture sitting square in its window — the one literal factories reuse. */
export const NO_CONTENT: ContentTransform = { x: 0, y: 0, scale: 1, scaleY: null, rotation: 0 };

/**
 * Fields EVERY clip has, regardless of kind. This is the "base clip": a span on
 * the timeline (start + duration) with an identity and its own keyframe tracks.
 * Selection, snapping, keyframes, the clipboard and the shared right-click
 * vocabulary all operate on these fields alone, so they never get re-implemented
 * per kind — a new clip kind extends this and gets them for free.
 */
const clipBase = {
  id: z.string(),
  name: z.string(),
  /**
   * The composition (frame) whose timeline this clip lives in. Every clip —
   * audio included — belongs to exactly one comp; the timeline view is scoped
   * by this, and nesting a frame plays that comp's clips (v9).
   */
  frameId: z.string(),
  /** Absolute position on the timeline. */
  startMs: millisecondsSchema,
  durationMs: z.number().positive(),
  /** Path-addressed keyframe tracks (headless engine — any property animates). */
  keyframes: z.array(keyframeTrackSchema),
  /**
   * Node-graph DRIVERS (v42) — the property-path → expression-token map that
   * lets the node system take over any value. Keyed by the SAME path grammar as
   * `keyframes` (`x`, `opacity`, `fill.<id>.color`, `lfx.<id>.blur`, …); the
   * value is an `expr:<graphId>` token (or `expr:<graphId>@<node>.<socket>` for
   * a specific Object-node sink). When a path has a driver, the sampler
   * evaluates the graph and OVERRIDES the sampled value — one local check, no
   * per-field plumbing, works for every path `propertyDef` understands. Empty
   * for docs that never touched nodes, so old files migrate for free (absent =
   * no drivers; the sampler treats missing and empty identically).
   */
  drivers: z.record(z.string(), z.string()).optional(),
  /**
   * RELATIONAL UNITS (v114) — the unit (and optional min/max) each field's
   * number is written in, keyed by the SAME path grammar as `keyframes` and
   * `drivers` (`width`, `fontSize`, `stroke.<id>.width`, `lfx.<id>.radius`,
   * `layout.gap`). Keys, base value and a driver's result are all in that unit;
   * the bake turns them into comp px and applies the bounds
   * (`units/resolve.ts`), so nothing downstream knows units exist. Absent = px.
   */
  units: z.record(z.string(), lengthSpecSchema).optional(),
  /**
   * MODULATORS (v46) — generated signals bound to property paths, using the
   * SAME path grammar as `keyframes` and `drivers`. They sit one step further
   * down the chain than either: keys and drivers decide what a value IS, a
   * modulator then wobbles, pulses or scales that result.
   *
   * Optional, like `drivers` and for the same two reasons: absent means none,
   * so every existing document migrates for free; and a clip that never touched
   * modulators does not carry an empty array in every saved file.
   */
  modulators: z.array(modulatorSchema).optional(),
  /**
   * DaVinci-style link group (v19). Clips sharing a group id select (and so
   * move, split, delete) together while linked selection is on — audio + its
   * waveform visualizer, a/v pairs, anything. Null = not linked. The link is
   * data; the timeline's link toggle only mutes the SELECTION behavior.
   */
  linkGroupId: z.string().nullable().default(null),
  /**
   * Fill-duration mode (v21). When true, the clip's duration AUTO-tracks its
   * comp's duration — it spans from `startMs` to the comp end and stays synced
   * as the comp grows/shrinks. This is the default for content INSIDE a nested
   * comp, so paths/media in a nested clip always fill it (and follow when the
   * parent clip is resized). A manual trim/resize LOCKS it (fillDuration=false)
   * and keeps the explicit value thereafter. Speed still bends children via the
   * time-remap. (Named `fillDuration`, not `fill`, because vector clips already
   * use `fill` for their paint.)
   */
  fillDuration: z.boolean().default(false),
  /**
   * Per-clip playback-cache override (v22). Absent = follow the timeline's
   * global caching switch; "always"/"never" beat the switch in both
   * directions. Status bars render wherever caching is in effect.
   */
  cachePolicy: z.enum(["always", "never"]).optional(),
  /**
   * Per-layer lock (v29). Independent of the track's own `locked` — a clip is
   * effectively locked if either it or its track is locked (see
   * `isClipLocked` in timeline/lock.ts, the one place that combines them).
   * Locked clips can't be selected, dragged, trimmed, split or deleted.
   */
  locked: z.boolean().default(false),
  /**
   * Universal sound trim (v31) — mute + a keyframable master volume applied to
   * whatever sound this clip makes. Schema-defaulted so old docs are silent
   * about it (unity, unmuted). See `audioMixSchema`.
   */
  audioMix: audioMixSchema.default({ volume: 1, muted: false }),
  /**
   * The CATEGORY this clip's sound routes into (v86) — a `doc.soundBuses` id.
   * Absent = inherit: the nearest nested ancestor's, else the kind's default
   * (see `routeOf` in audio/cues). On a nested clip it routes the whole
   * sub-mix, which is how one tag covers a scene's worth of sounds.
   */
  soundBus: z.string().optional(),
  /** Ducking rules this clip obeys (v86) — see `duckRuleSchema`. Absent = none. */
  ducking: z.array(duckRuleSchema).optional(),
  /**
   * THE SHUTTER (v56) — this layer's motion blur switch, and optionally its own
   * settings. `override: null` inherits the comp's; see `schema/motion-blur.ts`
   * for why motion blur is a property of the LAYER and not an effect.
   *
   * On `clipBase` for the same reason `audioMix` is: an audio clip carrying an
   * inert `{ enabled: true, override: null }` costs nothing and can never be
   * asked for a shutter, while scoping this to the visual union would have
   * bought one `switch` in every surface that reads it. Defaulted (not
   * optional) so the resolver never carries a fallback — the comp master is
   * what old documents are migrated to `false`, in ONE place, so nothing a
   * layer says can change how an existing project renders.
   */
  motionBlur: clipMotionBlurSchema.default({ enabled: true, override: null }),
  /**
   * THE AUDIO EFFECT STACK (v55) — ordered, and the order IS the signal chain.
   *
   * Universal for the same reason `audioMix` is: a video's dialogue, a nested
   * comp's mix and an audio clip all make sound and all deserve an EQ. Scoping
   * it to `audioClipSchema` would have meant a second code path in three
   * engines the first time someone wanted to de-ess a talking head.
   *
   * Every field keyframes at `afx.<id>.<field>`, so the whole chain animates
   * like anything else. See `schema/audio-effects.ts` and `audio/effects/`.
   */
  audioEffects: z.array(audioEffectSchema).default([]),
  /**
   * THE SOUND STACK (v51) — every sound this clip fires, as an ordered list of
   * instances, exactly like `effects`. Each entry binds one voice to one
   * animation event (a text unit, the layer's own in/out, the cut transition
   * at its edge) on one phase.
   *
   * Universal on purpose. Which triggers a given clip can actually offer is a
   * CAPABILITY question — answered once by `availableTriggers` in audio/cues —
   * not a reason for a per-kind field. That is what keeps the Sound tab one
   * component instead of one per clip kind, and what makes a new sound-bearing
   * event a single arm of `SoundTrigger` rather than a schema change.
   */
  sounds: soundStackSchema,
  /**
   * Per-layer visibility (v29). Same OR-with-track relationship as `locked`
   * (`isClipHidden`). Hidden clips stay in the timeline/layers list (so they
   * can be found and un-hidden) but don't render or hit-test on stage.
   */
  hidden: z.boolean().default(false),
  /**
   * Layer-lineage id (v32). When a drawing / flipbook cell is duplicated, each
   * copied layer keeps the SAME mirrorId as its original — so "select matching
   * layers" (mirror selection across frame-by-frame cells) and future synced
   * edits find a layer's twins structurally, never by guessing from names.
   * Stamped on first duplication (original + copy share it). Null = no lineage.
   */
  mirrorId: z.string().nullable().default(null),
  /**
   * PROVENANCE (v75) — where this clip's artwork came from, when it came from
   * somewhere: an icon out of the catalogue today. Stamped on the leaves a
   * source produced, derived for the groups around them. See
   * `schema/provenance.ts` for why it rides the clip and not a table.
   */
  origin: clipOriginSchema.nullable().default(null),
};

/**
 * Everything a VISUAL clip adds on top of the base: it renders into a frame at a
 * transform and may wrap. Text, captions and nested comps all extend this;
 * future image / video / vector layers will too.
 */
const visualClipBase = {
  ...clipBase,
  transform: transformSchema,
  /**
   * UNIFIED PAINT (v30) — the ONE fill/stroke model, shared by every visual
   * layer (shapes, text, images, frames-via-the-same-Paint…). Ordered Paint
   * lists painted bottom→top: multiple fills merge (per-entry opacity/blend),
   * each is solid OR a gradient (linear/radial/angular) with the same keyframe
   * paths (`fill.<id>.…`, `stroke.<id>.…`) and the same on-stage handles. Empty
   * = the layer's own default look (a shape draws nothing, text falls back to
   * `style.color`). No per-kind fill code — one headless painter serves all.
   */
  fills: z.array(paintSchema).default([]),
  strokes: z.array(strokeStyleSchema).default([]),
  /** Wrap/box width in frame px; null = no wrapping (auto width). */
  maxWidth: z.number().positive().nullable(),
  /** Layer effects — shadow/blur/adjust compositing the whole layer (v14). */
  effects: layerEffectListSchema,
  /**
   * THE LAYER'S OWN FRAME RATE (v80). Null follows the comp. A number makes
   * the layer's time advance in steps of 1/fps from its start — its keyframes,
   * its footage, the comp it nests — holding each picture until the next, at
   * any rate (12 for animation on twos, 0.5 for a slide every two seconds),
   * whatever the comp runs at. See `clipFrameTime`.
   */
  fps: z.number().positive().max(240).nullable().default(null),
  /**
   * Layer opacity (v25) — the whole composited layer's alpha, keyframable via
   * the `opacity` path. Every visual clip carries it (audio has no visuals);
   * before v25 only vectors did, and text/media faded through other means.
   */
  opacity: z.number().min(0).max(1).default(1),
  /**
   * Layer FEATHER (v39) — softens the layer's own alpha EDGE by this many frame
   * px, keyframable via the `feather` path. A universal, headless matte modifier:
   * it acts on the layer's rendered alpha at the one composite seam, so it softens
   * a plain layer's edge, a mask-group stencil, AND an adjustment's scope matte
   * (the tracked blur region) through the exact same code — one control, every
   * masking scenario. 0 = a hard edge (the default, zero cost).
   */
  feather: z.number().min(0).default(0),
  /**
   * Universal BORDER RADIUS (v40; per-corner v42) — rounds the layer's own
   * rendered box, PER CORNER (Figma), keyframable via `borderRadius.tl|tr|br|bl`
   * (a uniform edit writes all four). Applied at the ONE box-clip seam, so
   * images, videos, drawings and nested comps round exactly like a rectangle —
   * composing with `crop` + `feather` for free. All 0 = square (default, zero
   * cost). Shares the SAME `cornerRadius` shape as a rect shape's corners, so the
   * ONE Corner-radius section + on-stage handles serve boxes AND shapes.
   */
  borderRadius: cornerRadiusSchema.default({ tl: 0, tr: 0, br: 0, bl: 0 }),
  /**
   * Universal CROP (v40) — inset the layer's visible box from each side by this
   * many frame px. Off (all 0) by default; a non-zero inset hides that strip,
   * DaVinci/Figma style, and is keyframable via `crop.top` … `crop.left`. Applied
   * at the same box seam as `borderRadius`, so crop + radius + feather all combine
   * through one clip — the on-stage crop gesture and the inspector both write here.
   */
  crop: cropSchema.default({ top: 0, right: 0, bottom: 0, left: 0 }),
  /**
   * Universal CONTENT TRANSFORM (v68) — where the PICTURE sits inside the crop
   * window, keyframable via `content.x` … `content.rotation`. Identity by
   * default and free when it is; see `contentTransformSchema` for why moving
   * the footage and moving the layer are two facts and not one.
   */
  content: contentTransformSchema.default({ x: 0, y: 0, scale: 1, scaleY: null, rotation: 0 }),
  /**
   * CAPTURE crossfade (v41) — when this layer records a drawing over time (a
   * `capture` keyframe track of snapshot surfaces), dissolve between consecutive
   * snapshots instead of the default crisp FBF hold. Off = hold (predictable,
   * cheap); on = the "just fade" look. Read by drawing/capture's `captureStateAt`
   * and the raster renderer; harmless on clips without a capture track. Optional
   * (absent = hold) so no existing clip/factory needs to set it.
   */
  captureCrossfade: z.boolean().optional(),
  /**
   * LINK (v98) — where clicking this layer goes: a URL, a place in this
   * project, or an app route. Null = not a link. A text run's own link
   * (`StyleRange.link`) wins over this one under it. See `schema/links.ts`.
   * Optional, like `drivers`: absent = not a link, and a layer that never had
   * one carries nothing in the saved file.
   */
  link: linkSchema.optional(),
  /**
   * Layer blend mode (v25) — how the whole layer composites over what's beneath
   * it in the frame (Figma "blend mode", beside opacity). `normal` = the usual
   * source-over paint; anything else isolates the layer and blends it as a unit.
   */
  blendMode: blendModeSchema.default("normal"),
  /**
   * COMPOSITE ROLE (v26 as `isMask`, generalised in v66). Read whenever the
   * clip's group has a mode other than `pass`/`union`: true = this layer is
   * part of the group's STENCIL — the shape that does the operating; false =
   * it is CONTENT, the thing being operated on.
   *
   * One role, every mode, and any number of layers on each side:
   *   mask      content ∩ stencil        subtract  content − stencil
   *   intersect content ∩ stencil        exclude   content ⊻ stencil
   * All the stencil layers union into one alpha first, exactly as mask's always
   * did, so "several cutters" needs no extra concept.
   *
   * Before v66 only `mask` read this and the booleans used an IMPLICIT rule —
   * the bottom member was the base and everything above it was an operand.
   * That rule was invisible (nothing on screen said which layer was the base),
   * it could not express two bases or a cutter that was not on top, and it made
   * mask the odd one out for no reason a person could see. Migration marks
   * every non-bottom member of an existing boolean group as a stencil, which
   * reproduces the old picture exactly.
   *
   * Meaningless (and ignored) in a `pass` or `union` group, so switching a
   * group's mode back and forth never loses the roles.
   */
  isStencil: z.boolean().default(false),
  /**
   * THIS LAYER GIVES OFF LIGHT (v4.26) — an ember, a lamp, a neon word, a laser.
   * Light is a fact about what emits it, not a guess from its colour: a
   * white-hot core is as much a light as its orange halo. A material over the
   * picture (Surface's Spare lights) leaves a light layer's pixels — its
   * effects and glow included — clean instead of printing them on the card.
   * A group or a nested comp that emits makes everything inside it a light.
   *
   * Optional, like `link`: absent = not a light, and nothing in the saved file.
   */
  emitsLight: z.boolean().optional(),
  /**
   * Whole-layer in/out animations (v27) — ANY visual clip animates as a unit
   * with the same preset library text uses (fade, slide, pop, blur…). `in`
   * plays over the clip's first `durationMs`, `out` over its last. Composes
   * WITH text/caption glyph animations (layer pose × glyph pose). Null = none.
   */
  animIn: layerAnimationSpecSchema.nullable().default(null),
  animOut: layerAnimationSpecSchema.nullable().default(null),
  /**
   * Motion-track binding (v39) — a live link to a `doc.trackers` tracker whose
   * baked motion drives this clip's transform (attach a sticker/text to a moving
   * object, or drive a mask shape that follows a face). Null = not tracked. The
   * link stays live so a re-track updates the clip for free; "Flatten to
   * keyframes" (`flattenTrackBinding`) converts it to editable x/y/scale/rotation
   * keys. Resolved by `resolveTrackBinding` into the transform the renderer reads.
   */
  trackBinding: trackBindingSchema.nullable().default(null),
  /**
   * THE CAMERA'S BACKPLATE (v101, Tracking 3) — in a WORLD, this layer is not
   * an object in the scene: it is drawn flat, behind everything, exactly as
   * it would be in a flat comp (its own transform, effects and time map), and
   * the 3D render is laid over it. What a match-moved shot needs: the footage
   * whose camera was solved, so the scene's objects sit IN it, and shadows
   * caught on the floor fall on it. Ignored in a flat comp (every layer there
   * already is one).
   */
  backplate: z.boolean().optional(),
  /**
   * How this layer takes part in an AUTO LAYOUT (v73) — read only while it sits
   * on a row of a group that carries `layout`; ignored and kept otherwise, so
   * moving a layer out of a container and back does not lose its fill flags.
   * See `schema/relations.ts`.
   */
  layoutItem: layoutItemSchema.default(DEFAULT_LAYOUT_ITEM),
  /**
   * CONSTRAINTS (v89) — look at / follow another layer, by id. Optional and
   * absent = none, so a flat layer carries nothing. See `schema/world.ts`.
   */
  constraints: z.array(constraintSchema).optional(),
  /**
   * THICKNESS in a world (v89) — any 2D layer standing as a real 3D object
   * rather than a picture plane. Absent = a flat picture. See `extrudeSchema`.
   */
  extrude: extrudeSchema.optional(),
  /**
   * HOW LIGHT TREATS the layer in a world (v89) — the same surface a mesh has.
   * Absent = the layer's own default (`layerMaterial`): a flat picture shows
   * its exact colours (unlit), a thick one is lit like an object.
   */
  material: materialSchema.optional(),
  /**
   * GEOMETRY MODIFIERS in a world (v89) — bend, twist, wave, array… on any
   * layer, the stack a mesh has (`world/modifiers.ts`). Absent = none.
   */
  modifiers: z.array(modifierSchema).optional(),
  /**
   * LINE ART on the layer's body in a world — silhouette, creases and borders
   * drawn as lines, the look a mesh gets from its strokes. Absent = none.
   */
  lineArt: lineArtSchema.optional(),
  /**
   * HOW THIS LAYER FOLLOWS ITS RIG'S BONES (v90) — read only while it is a
   * member of a group that carries a `rig`; ignored and kept otherwise, like
   * `layoutItem`. Absent = automatic. See `schema/rig.ts`.
   */
  bind: bindSchema.optional(),
  /**
   * PHYSICS (v92; meshes since v89) — a RIGID BODY: any layer, in a flat comp
   * or a world, falls, collides and tumbles from the comp's physics start.
   * Absent = not simulated. See `schema/physics.ts`.
   */
  physics: physicsSchema.optional(),
  /**
   * The FORCES this layer carries (v93; one `field` in v92) — a stack, like its
   * effects: wind, vortex, attract, turbulence, drag, any number, repeats
   * allowed, each keyed at `force.<id>.<field>`. Placed by the layer. Absent = none.
   */
  forces: z.array(forceSchema).optional(),
  /**
   * The PARTICLE EMITTERS this layer carries (v102) — a stack like its forces:
   * streams and bursts, each keyed at `emit.<id>.<field>`. Placed by the layer;
   * the particles live in the comp's simulation. Absent = none.
   */
  emitters: z.array(emitterSchema).optional(),
  /** JOINTS from this body to others or to the comp (v92). */
  joints: z.array(jointSchema).optional(),
};

/**
 * A typewriter CARET — the blinking cursor that follows the typing head.
 *
 * Only the look lives here. Where it sits and whether it is lit are DERIVED
 * per frame (`caretAt`): the position is "after the last unit that started
 * entering", read from the same schedule the glyphs animate on, and the blink
 * is a function of clip-local time. A stored position would go stale on the
 * next text edit, and a wall-clock blink would render one thing in preview and
 * another on export — so neither is stored.
 */
export const textCaretSchema = z.object({
  /** Off by default. Modelled as a FLAG rather than a nullable caret for the
   *  same reason `TypingSound` is: a null would take the colour, blink and
   *  shape with it every time you flicked the switch. */
  enabled: z.boolean().default(false),
  style: z.enum(["bar", "block", "underline"]).default("bar"),
  /** Thickness as a fraction of the font size, so it scales with the type. */
  width: z.number().min(0.01).max(2).default(0.08),
  /** null = take the text's own colour (the common case, and it follows edits). */
  color: z.string().nullable().default(null),
  /** Full blink period in ms; 0 = solid. 1060ms is the terminal convention. */
  blinkMs: z.number().min(0).max(4000).default(1060),
  /** Keep blinking once the last unit has landed, instead of vanishing. */
  persist: z.boolean().default(false),
});
export type TextCaret = z.infer<typeof textCaretSchema>;

/**
 * A styled span over the clip's text, addressed in grapheme indices
 * (`end` exclusive). Ranges are kept normalized: sorted, non-overlapping.
 * A range can also override the in-animation and any sound-stack entry over its span.
 */
export const styleRangeSchema = z.object({
  id: z.string(),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  /**
   * What this span overrides about the layer — typography, a fill's colour, a
   * stroke's width, one field of one effect, or a whole effect this span alone
   * carries. See `schema/scope.ts`: presence is the override, absence is
   * inheritance, and there is no second place that records which is which.
   */
  overlay: scopeOverlaySchema.default(emptyOverlay),
  animation: animationSpecSchema.nullable(),
  /** Per-entry voice overrides for this span, keyed by `soundLayer.id`.
   *  Keyed (not per-phase) because the stack can hold several entries on one
   *  phase, and a range must say WHICH hit it is re-voicing. */
  sounds: rangeSoundOverridesSchema.default({}),
  /**
   * The span's LINK (v98) — payload like `animation`, so splitting, merging and
   * retyping carry it for free. A link "span" is derived: adjacent ranges with
   * an equal link (`linkSpans`). Absent = not linked.
   */
  link: linkSchema.optional(),
});
export type StyleRange = z.infer<typeof styleRangeSchema>;

// ── Captions: a TEXT clip that knows which of its own words is being said ────

/**
 * One timed CUE: a span of the clip's OWN text (grapheme indices, `end`
 * exclusive) plus when it is spoken.
 *
 * That the span INDEXES the clip's text — rather than carrying a copy of the
 * words, which is what `CaptionWord` did until v52 — is the whole design:
 *
 *  - retyping a caption re-splices ONE string, and every cue's timing survives
 *    it (`remapCuesAfterSplice`) instead of being thrown away and rebuilt;
 *  - moving the split between two rows is two integers changing, so a word
 *    "leaves" one row and "joins" the next with no text moving anywhere;
 *  - the focused cue is just a `StyleRange`, and every text surface — layout,
 *    glyph animation, sound cues, the inline editor — already reads those.
 *
 * A cue is any grain: a word, a phrase, one letter. Nothing here knows the
 * word "word", so a transcript importer and a hand-split line are the same
 * object.
 */
export const captionCueSchema = z.object({
  id: z.string(),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  /**
   * Clip-relative, stored as start/END rather than start + duration: every
   * gesture on a cue moves ONE boundary, and a boundary is an instant. The
   * old pair meant dragging a split wrote three fields and rounded twice,
   * which is where caption timings drifted apart from each other.
   */
  startMs: millisecondsSchema,
  endMs: millisecondsSchema,
});
export type CaptionCue = z.infer<typeof captionCueSchema>;

/**
 * THE THREE STATES every cue passes through — a partition of the cue list at
 * any instant, derived from the playhead and never stored:
 *
 *   unread  the cue has not been spoken yet
 *   focus   the cue being spoken right now
 *   read    the cue has been spoken
 *
 * Until v78 only `focus` existed, so "the words already said" and "the words
 * still coming" were the same thing — the layer — and the karaoke look
 * everybody actually wants (past solid, future faded, present lit) could not
 * be expressed at all. Adding two more *kinds* of scope would have forked the
 * seam three ways; adding two more *instances* of the one scope forks nothing,
 * which is why this is a map keyed by state rather than three fields.
 */
export const CAPTION_STATES = ["unread", "focus", "read"] as const;
export type CaptionState = (typeof CAPTION_STATES)[number];

/**
 * ONE vocabulary for the three states — the chip, the override list, the
 * keyframe row and any future surface all say the same word. A second copy of
 * these strings in the inspector is how "Focus" and "Spoken" end up naming the
 * same thing in two panels.
 */
export const CAPTION_STATE_LABEL: Record<CaptionState, string> = {
  unread: "Unread",
  focus: "Focus",
  read: "Read",
};

/** What each state IS, in one line — the tooltip on its chip. */
export const CAPTION_STATE_HINT: Record<CaptionState, string> = {
  unread: "Words not spoken yet",
  focus: "The word being spoken",
  read: "Words already spoken",
};

/**
 * How ONE state differs from the rest of the text.
 *
 * Deliberately the exact payload of a `StyleRange` (an overlay plus a glyph
 * animation) plus a pop `scale`, because that is what it BECOMES:
 * `effectiveRanges` turns each state into ranges over the cues currently in
 * it, every frame. So "the spoken word" and "the words still to come" are two
 * complete text styles with their own effect stacks and their own glyph
 * animations — edited by the same inspector that edits the first one — and
 * downstream there is no such thing as a caption to branch on.
 *
 * Every field is an OVERRIDE: absent means "same as the rest of the text", so
 * recolouring the whole layer moves every state that hasn't said otherwise.
 */
export const captionStateStyleSchema = z.object({
  /**
   * The SAME overlay a `StyleRange` carries — which is the point: a caption
   * state is not a special kind of styling, it is one more scope over the
   * layer, so it gets fills, strokes, effects and per-glyph passes for free.
   */
  overlay: scopeOverlaySchema.default(emptyOverlay),
  /**
   * Replayed each time a cue ENTERS this state — anchored at `cue.startMs` for
   * `focus` (the karaoke bounce) and at `cue.endMs` for `read` (the settle).
   * Distinct from `animations.in`, which plays once when the glyph arrives —
   * and which IS the unread words' animation, so `unread` leaves this null.
   */
  animation: animationSpecSchema.nullable().default(null),
  /**
   * Extra glyph scale while in this state (1 = none) — the karaoke "pop". A
   * POSE, not a style, because it must not re-wrap the line it lands on; it
   * composes onto the glyph visuals the same way an animation does, and it
   * eases across `CaptionMotion.durationMs` like every other state property.
   */
  scale: z.number().positive().default(1),
});

// A per-cue SOUND deliberately does not live here. "Tick on every word as it
// highlights" is a question about WHEN a voice fires, and the sound stack
// already owns that seam (`SoundLayer.trigger`) — so it is one new trigger arm
// reading these cues, not a second sound model hiding inside a style scope.
export type CaptionStateStyle = z.infer<typeof captionStateStyleSchema>;

/**
 * HOW a cue crosses between states — one curve for the whole caption.
 *
 * A state change used to be a cut: at `cue.startMs` the word simply *was* the
 * focus colour. Every caption anyone ships has a ramp on that, and hand-rolling
 * one per property (a colour track, an opacity track, a scale track, all with
 * the same curve) is four places to keep in sync for one intention.
 *
 * So the crossing is a property of the CAPTION, not of any state: over
 * `durationMs` after a cue changes state, every numeric and colour override it
 * carries eases from the old state's value to the new one — see
 * `captionStateBlend`. Structural overrides (an effect the state adds, a fill
 * it forks) switch at the halfway point, because a list cannot be half itself.
 *
 * `travel` spends that same curve on the highlight pill: instead of the pill
 * cutting to the next word it slides along the line to it, and cuts when the
 * next word is on a different line — sliding diagonally across a paragraph is
 * the thing nobody wants. One duration, one curve, everything moves together.
 */
export const captionMotionSchema = z.object({
  durationMs: z.number().min(0).max(4000).default(160),
  easing: easingSchema.default({ kind: "preset", name: "ease-out" }),
  travel: z.boolean().default(false),
});
export type CaptionMotion = z.infer<typeof captionMotionSchema>;

/** The caption module: which spans are spoken when, how each state looks, and how they cross. */
export const captionSpecSchema = z.object({
  /** Sorted and non-overlapping (`normalizeCues`). Gaps are legal — silence. */
  cues: z.array(captionCueSchema).default([]),
  states: z
    .object({
      unread: captionStateStyleSchema.default({}),
      focus: captionStateStyleSchema.default({}),
      read: captionStateStyleSchema.default({}),
    })
    .default({}),
  motion: captionMotionSchema.default({}),
});
export type CaptionSpec = z.infer<typeof captionSpecSchema>;

/**
 * How a GROUP combines its members (v26; a clip field since v66).
 *
 *  - pass:       members paint independently, in z order (the plain group).
 *  - union:      members composite as one unit (source-over).
 *  - subtract:   the bottom member minus everything above it (destination-out).
 *  - intersect:  only where every member overlaps (destination-in).
 *  - exclude:    overlaps knocked out (xor).
 *  - mask:       content shows only inside the stencil.
 *
 * Every mode but `pass` and `union` splits its members into STENCIL and
 * CONTENT by `clip.isStencil` — any number on either side. See that field.
 */
export const groupModeSchema = z.enum(["pass", "union", "subtract", "intersect", "exclude", "mask"]);
export type GroupMode = z.infer<typeof groupModeSchema>;

/**
 * A GROUP — one layer that happens to contain others (v66; rows since v71).
 *
 * It is a `Clip`, and that is the whole design. Before v66 a group was a row in
 * `doc.groups` holding a name and a mode, with membership on the clips; it had
 * no span, so it could not be trimmed, could not take a transition and could
 * not receive anything the timeline knows how to drop on a clip, and it had no
 * transform, fill, stroke, effects or keyframes of its own because none of that
 * machinery is reachable from a bare table row. Every one of those would have
 * had to be re-implemented against a second kind of object.
 *
 * As a clip it inherits all of them at once: `visualClipBase` gives it the
 * transform, the paint lists, the effect stack, opacity/blend/feather/crop, the
 * in/out animations and the lock/hide flags; `clipBase` gives it the identity,
 * the keyframe tracks, the drivers, the modulators, the sound stack and — the
 * one that unlocked the rest — a real `startMs`/`durationMs` SPAN.
 *
 * CONTAINMENT IS THE ROW (v71). A group's interior is a set of tracks that say
 * `track.groupId === group.id` — its own rows, z-ordered among themselves by
 * their place in `doc.tracks` and nothing else. A clip is in a group because it
 * sits on one of that group's rows; there is no `clip.groupId` any more, so
 * "which group is this in" has exactly one answer and moving a clip onto a row
 * IS moving it into that row's group. A group clip itself sits on an ordinary
 * lane of its PARENT scope (the comp, or the enclosing group's rows), which is
 * how groups nest and why a group can be dragged to any lane like any clip.
 *
 * Before v71 the group clip owned a lane and its members had to occupy the
 * lanes directly beneath it, kept contiguous by a compaction pass after every
 * edit. The lane became the group: the bar could not leave its row, a child
 * dragged onto the group's own lane replaced it, and every structural op had
 * to know the rule. Rows scoped by id have no such coupling.
 *
 * TIME: the span is a WINDOW. Children keep absolute times; a descendant
 * outside the group's span does not paint (`withinGroupWindow`), so trimming a
 * group hides and reveals rather than retimes — the nested-clip contract, on
 * the parent's clock. Moving the group carries everything inside it.
 */
/** What a switch group shows: a member's name, or its place counted from the top (0). */
export const switchSchema = z.object({
  show: z.union([z.string(), z.number()]).default(""),
});
export type SwitchSpec = z.infer<typeof switchSchema>;

export const groupClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("group"),
  /** How the members combine. `pass` = a plain group. See `groupModeSchema`. */
  mode: groupModeSchema.default("pass"),
  /**
   * AUTO LAYOUT (v73) — when present, this group ARRANGES its members and owns
   * a declared box. `null` = a plain group whose box is the union of what it
   * holds. See `layoutSpecSchema` for the whole model.
   */
  layout: layoutSpecSchema.nullable().default(null),
  /**
   * A RIG (v90) — bones that bend what this group holds: the character is the
   * group. `null` = a plain group. A rig and an auto layout both place the
   * members, so a group carries one or the other (`rig/ops.ts` refuses both).
   * See `schema/rig.ts`.
   */
  rig: rigSchema.nullable().default(null),
  /**
   * A SWITCH (v91) — exactly ONE member shows at a time: Moho's switch layer,
   * Spine's slot. An eye's open / half / closed, a mouth's shapes, a hand's
   * poses. `show` names the member (its layer name, any case) or counts to it
   * (0 = the top layer); keyed at the path `switch`, so blinks and lip sync are
   * keys, an expression (`blink()`) or a control bone's driver. A name no
   * member has shows the top one — a character is never left without a mouth.
   * `null` = a plain group. See `timeline/switch.ts`.
   */
  switch: switchSchema.nullable().default(null),
  /**
   * POSE SETS (Characters 2.0) — parts with named states this group owns: a
   * mouth's visemes, eyes, hands. Chosen on `pose.<setId>`; blended at
   * evaluation. Absent = none. See `schema/poses.ts`.
   */
  poses: z.array(poseSetSchema).optional(),
  /**
   * BEHAVIORS (Characters 3.0) — what the character does on its own: lip sync,
   * blinking, breathing, idle loops, glances, machines. An ordered stack (the
   * `behavior` effect domain); each drives a pose set or adds onto channels,
   * and keeps a person's changes as override spans. Absent = none. See
   * `schema/behaviors.ts`.
   */
  behaviors: z.array(behaviorSchema).optional(),
});
export type GroupClip = z.infer<typeof groupClipSchema>;

export const textClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("text"),
  text: z.string(),
  /**
   * Fixed box HEIGHT in frame px (Figma "Fixed size"). null = auto height (the
   * box grows to fit content — the default). When set, the box is that tall and
   * the text is clipped to it, aligned per `verticalAlign`. Pairs with
   * `maxWidth`: auto-width (both null) → auto-height (width set) → fixed-size
   * (both set). Additive default, so old docs stay auto-height.
   */
  maxHeight: z.number().positive().nullable().default(null),
  /** Vertical placement of the text block inside a fixed-height box. */
  verticalAlign: z.enum(["top", "middle", "bottom"]).default("top"),
  /**
   * Clip the glyphs (and their effects) to the text box — the Figma "Clip
   * content" toggle, mirroring a frame's own. OFF by default: text, its
   * strokes, shadows and blurs stay fully visible and overflow freely, so a
   * layer animation (or a blur) never trims the edges. ON masks everything to
   * the box (auto → the content box, fixed → the fixed box). Additive default,
   * so old docs keep the untrimmed look.
   */
  clipContent: z.boolean().default(false),
  style: textStyleSchema,
  ranges: z.array(styleRangeSchema),
  animations: z.object({
    in: animationSpecSchema.nullable(),
    out: animationSpecSchema.nullable(),
  }),
  /** Typewriter caret — look only; placement and blink are derived per frame.
   *  Schema-defaulted, so existing documents open with it off. */
  caret: textCaretSchema.default({}),
  /**
   * NUMBER OBJECTS that count between content keys (v83, `text/count-up.ts`).
   * One entry per number slot the user has touched — the nth number in the
   * text. A slot with no entry counts, on its content key's easing; `enabled:
   * false` makes it cut at the key like any other content; `easing` overrides
   * the key's curve for that number alone.
   */
  countUps: z
    .array(
      z.object({
        slot: z.number().int().min(0),
        enabled: z.boolean(),
        easing: easingSchema.nullable(),
        /** Values shown on the way; null/absent = every value. See `CountUpSetting.steps`. */
        steps: z.number().int().min(1).max(1000).nullable().optional(),
      }),
    )
    .default([]),
  /**
   * CAPTION module (v52) — present when this text layer is a caption; null on
   * an ordinary text layer, which is every text layer until cues are added.
   *
   * A caption is not a KIND. It was one until v52, and the price was that
   * everything text could do — double-click editing, per-letter ranges, the
   * dashed box that re-wraps instead of scaling, glyph animation, the caret,
   * templates, variables — either had to be written a second time for captions
   * or (mostly) simply went missing, and every text edit rebuilt the word list
   * from scratch and threw the timings away. As a module, a caption IS a text
   * clip: it inherits all of that by being one, and adds exactly one fact —
   * which of its own words is being spoken right now.
   */
  caption: captionSpecSchema.nullable().default(null),
  /**
   * TEXT ON A PATH (v73) — present when this text rides another layer's
   * outline; null on ordinary text. Like `caption`, a MODULE rather than a
   * kind: a text on a path is a text clip, with every range, animation, caret,
   * effect and template a text clip has, plus one fact about where its glyphs
   * go. While present the layer's own `transform` is DRIVEN by the host's
   * (`relations/resolve.ts`), so its box is the host's box and moving the host
   * moves the words. See `schema/relations.ts`.
   */
  path: textPathSpecSchema.nullable().default(null),
});
export type TextClip = z.infer<typeof textClipSchema>;

/** A text clip that rides a path — the narrowing the renderer and stage use. */
export type PathTextClip = TextClip & { path: TextPathSpec };

/** Does this text ride another layer's outline? THE check every surface uses. */
export function isPathText(clip: Clip | null | undefined): clip is PathTextClip {
  return !!clip && clip.kind === "text" && clip.path !== null;
}

/** A text clip that carries the caption module — the one narrowing worth naming. */
export type CaptionTextClip = TextClip & { caption: CaptionSpec };

/** Does this clip carry the caption module? THE check every surface uses. */
export function isCaptionClip(clip: Clip): clip is CaptionTextClip {
  return clip.kind === "text" && clip.caption !== null;
}

/**
 * A DaVinci-style edge fade: a volume ramp over the clip's first/last
 * `durationMs`, shaped by its own easing curve. It MULTIPLIES the gain
 * envelope (base value or keyframes), so fades and volume automation
 * compose instead of fighting — exactly Resolve's model.
 */
export const audioFadeSchema = z.object({
  durationMs: z.number().min(0).default(0),
  /** Shape of the ramp from silence (0) to full level (1). */
  curve: easingSchema.default({ kind: "preset", name: "ease-in-out" }),
});
export type AudioFade = z.infer<typeof audioFadeSchema>;

// The parametric EQ band model lives in `schema/audio-effects.ts`: EQ is an
// ordinary card in the audio effect stack, and a band belongs with the effect
// that owns it. `clip.eq` was retired by the v55 migration.


export const audioClipSchema = z.object({
  ...clipBase,
  kind: z.literal("audio"),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("pack"), pack: soundPackIdSchema }),
    /** An imported audio file (doc.assets holds the metadata, bytes live app-side). */
    z.object({ type: z.literal("asset"), assetId: z.string() }),
  ]),
  /** Linear volume multiplier. 1 = unity (0 dB); up to 4 = +12 dB boost. */
  gain: z.number().min(0).max(4),
  /** Edge fades (fade-in / fade-out handles on the clip). */
  fadeIn: audioFadeSchema.default({ durationMs: 0, curve: { kind: "preset", name: "ease-in-out" } }),
  fadeOut: audioFadeSchema.default({ durationMs: 0, curve: { kind: "preset", name: "ease-in-out" } }),
  /** Re-trigger interval (pack sources); null = single one-shot at clip start. */
  repeatEveryMs: z.number().positive().nullable(),
  /** Source-backed playback (asset sources): speed + loop, same contract as video/nested. */
  playback: clipPlaybackSchema.default({ speed: 1, loop: "none", reverse: false }),
  /** Skip into the source before playing (asset sources), ms. */
  trimInMs: millisecondsSchema.default(0),
  /**
   * Keep the original pitch when the clip's speed changes (v37) — the modern
   * default (Premiere/DaVinci preserve pitch by default). When false, speed
   * shifts pitch tape-style. Forced ON in a voice category (see
   * `audioKeepsPitch`). Live playback honors this via the element's
   * `preservesPitch`; export honors it through the offline bake.
   */
  keepPitch: z.boolean().default(true),
  /**
   * Independent pitch shift in semitones (v37), separate from speed —
   * keyframable via the `pitch` path. Applied through the offline audio bake
   * (a real pitch-shift can't come from a single media element).
   */
  pitchSemitones: z.number().min(-24).max(24).default(0),
});
export type AudioClip = z.infer<typeof audioClipSchema>;

/**
 * An imported still image, placed at a transform. Draws at the asset's
 * intrinsic size — `transform.scale` sizes it, like every other layer.
 *
 * `playback`/`trimInMs` only matter for an ANIMATED source (gif/apng/webp) —
 * same time-remap contract as video/nested (speed, loop/pingpong/reverse,
 * `loopLengthMs`). Deliberately optional (not defaulted): a static PNG/JPG
 * has no use for them, so they stay undefined and every playback-aware
 * surface (`clipPlaybackOf`, `PlaybackSection`) naturally no-ops/hides for
 * ordinary images. The image-import path seeds them only when the asset is
 * detected as animated.
 */
export const imageClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("image"),
  assetId: z.string(),
  playback: clipPlaybackSchema.optional(),
  trimInMs: millisecondsSchema.default(0),
});
export type ImageClip = z.infer<typeof imageClipSchema>;

/**
 * An imported video: a source-backed visual clip, played through `playback`
 * (speed + loop/pingpong via sourceTimeAt) — the exact same time-remap
 * contract as nested comps.
 */
export const videoClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("video"),
  assetId: z.string(),
  playback: clipPlaybackSchema,
  /** Skip into the source before playing, ms. */
  trimInMs: millisecondsSchema.default(0),
  volume: z.number().min(0).max(1).default(1),
  muted: z.boolean().default(false),
  /** Keep pitch when speed changes (v37) — same contract as audio clips. */
  keepPitch: z.boolean().default(true),
  /** Independent pitch shift in semitones (v37), applied via the offline bake. */
  pitchSemitones: z.number().min(-24).max(24).default(0),
});
export type VideoClip = z.infer<typeof videoClipSchema>;

/**
 * A nested clip — a whole other frame's animated content, placed on a track as
 * one clip. It references a source frame and plays it through `playback`
 * (speed + loop/pingpong), so timelines nest and stay in sync. Same shape a
 * video/audio clip will take: a source id + `playback` + a transform.
 */
export const nestedClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("nested"),
  /** The frame whose content is nested here. */
  sourceFrameId: z.string(),
  /**
   * Present this comp as ONE opaque layer (v45): no drill-in on double-click,
   * no expanding in the layers panel — you move, scale and animate it as a
   * single object, exactly the way a placed image behaves.
   *
   * A PRESENTATION flag, deliberately not a conversion. Vectorizing an SVG
   * makes the paths the artwork's only truth; "treat it as an image" must
   * therefore not write a second copy of that artwork (flattened bytes beside
   * live paths would drift apart the moment either is edited, and re-reading
   * the original asset would silently discard the edits). The same pixels are
   * drawn either way — this only decides whether you can get INSIDE them.
   *
   * Universal rather than SVG-specific: "treat this nested comp as one object"
   * is a useful thing to say about any nested clip, so there is no per-kind
   * code and no second answer to the same question.
   */
  flat: z.boolean().default(false),
  /**
   * "Clip content" for this layer: true windows the comp to its box, false lets
   * everything past the box show, null (Auto) asks the comp — a transparent part
   * spills, a comp with a visible box windows. See `nestedClipsContent`.
   */
  clipContent: z.boolean().nullable().default(null),
  playback: clipPlaybackSchema,
  /** Skip into the source comp before playing, ms — same in-point contract as
   * audio/video, so a nested clip CONTINUES (not restarts) when split. */
  trimInMs: millisecondsSchema.default(0),
  /**
   * This instance's overrides of its comp's INPUTS (`frame.inputs`), by input
   * id — the base values of the `input.<id>` channels. Sparse: an input not
   * listed follows the definition's default. See `components/inputs.ts`.
   */
  inputValues: inputValuesSchema.optional(),
});
export type NestedClip = z.infer<typeof nestedClipSchema>;

/**
 * A parametric vector shape (rect/ellipse/polygon/star) with fill + stroke.
 * Width/height/radii/point counts are all keyframe paths — corner radius can
 * animate. Fill and stroke colors take `var:` tokens like every color slot.
 */
export const shapeClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("shape"),
  shape: shapeKindSchema,
  width: z.number().positive(),
  height: z.number().positive(),
  /** Per-corner radii (rect); polygon/star use the uniform `radius`. */
  cornerRadius: cornerRadiusSchema,
  /** Uniform corner rounding for polygon/star vertices. */
  radius: z.number().min(0).default(0),
  /** Polygon/star vertex count. */
  pointCount: z.number().int().min(3).default(3),
  /** Star inner radius as a ratio of the outer (0..1). */
  innerRatio: z.number().min(0.01).max(1).default(0.5),
  /** Ellipse arc (Figma): where the sweep starts, in degrees (0 = 3 o'clock). */
  arcStartDeg: z.number().default(0),
  /** Ellipse arc: how far it sweeps, in degrees. 360 = full circle; <360 = pie/arc. */
  arcSweepDeg: z.number().min(0).max(360).default(360),
  /** Ellipse arc: inner-hole radius as a fraction of the outer (0 = solid, →1 = ring). */
  arcRatio: z.number().min(0).max(0.99).default(0),
  /**
   * Per-corner nudges (Figma-beyond): a local-space offset for each natural
   * vertex (rect: tl,tr,br,bl · polygon: n verts · star: 2n verts). null = the
   * pure parametric shape. Lets you drag a rect/triangle's corners while it
   * stays a shape (never a path).
   */
  cornerOffsets: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .nullable()
    .default(null),
  // fills + strokes are inherited from visualClipBase (the unified paint model),
  // and TRIM now rides each stroke rather than the clip — see `trimSpecSchema`.
});
export type ShapeClip = z.infer<typeof shapeClipSchema>;

/**
 * A free Bézier path (pen tool / SVG import): one or more contours of anchor
 * points with optional handles, plus fill + stroke. Geometry is clip-local;
 * the transform places it in the frame.
 *
 * ONE path clip is ONE piece of artwork. Its contours share a fill rule, which
 * is what makes a compound path — a donut and its hole — expressible, and the
 * reason they are not separately styleable: a hole has no fill of its own.
 * Disjoint pieces that want their own colour, transform, effects or timing are
 * separate path clips, so every one of those capabilities is the one the app
 * already has rather than a second implementation living inside this type.
 */
export const pathClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("path"),
  /** Every contour, in paint order (index 0 = bottom). See `subpathSchema`. */
  subpaths: z.array(subpathSchema),
  fillRule: fillRuleSchema.default("nonzero"),
  // fills + strokes are inherited from visualClipBase (the unified paint model),
  // and TRIM now rides each stroke rather than the clip — see `trimSpecSchema`.
  /**
   * PER-CONTOUR OVERRIDES — "like this layer, except…", keyed by contour id.
   *
   * A vector layer's contours share its fill, stroke and effects, which is
   * right almost always and wrong the moment one petal wants another colour.
   * The override is a `ScopeOverlay` (schema/scope.ts) — the SAME shape a text
   * range and a caption's focus already use, whose header anticipated this
   * caller — so the rule is the one this document already has:
   *
   *   presence IS an override · absence IS inheritance
   *
   * There is no snapshot and no `inherited: true` flag: an untouched contour
   * has no entry here at all and follows the layer forever, editing the layer
   * still reaches every contour that has not opted out, and the illegal state
   * (a value both inherited and overridden) is not representable.
   *
   * It lives on the CLIP rather than on `Subpath` for the reason `StyleRange`
   * lives on the text clip rather than on its graphemes: geometry stays pure
   * geometry (see `subpathSchema`), one place owns "what is overridden here",
   * and `schema/scope.ts` can keep importing the paint schemas without a cycle.
   * Orphaned entries are impossible — `editPathGeometry`, the one seam every
   * geometry write goes through, prunes ids that no longer exist.
   *
   * The paths are `getClipProperty`/`setClipProperty` paths (`fill.<id>.color`,
   * `stroke.<id>.width`, `lfx.<id>.blur`), which is what lets an override
   * SURVIVE separation: promoting a contour to its own layer writes each entry
   * to the new clip's real field, because both sides speak one vocabulary.
   */
  contourStyles: z.record(z.string(), scopeOverlaySchema).default({}),
  /** Shape keys (Characters 2.0): drawn shapes the outline morphs to, weights at `key.<id>`. See `schema/shape-keys`. */
  shapeKeys: shapeKeysSchema.optional(),
});
export type PathClip = z.infer<typeof pathClipSchema>;

/**
 * How a waveform clip LOOKS — one flat, serializable style bag shared by every
 * template. Templates are just painters over the same params; presets are just
 * saved values. All numeric fields may be keyframe-overridden via `wave.*`
 * paths (e.g. `wave.amplitude`), sampled by the renderer.
 */
export const waveformStyleSchema = z.object({
  /** Which painter draws the peaks. */
  template: z.enum(["bars", "line", "area", "circular", "dots"]),
  /**
   * How the sound is READ (any template paints either):
   *  - "spectrum": AE Audio Spectrum style — a fixed EQ. Each bar is a
   *    frequency band (bass left → treble right, log-spaced), pulsing with
   *    the energy at this instant. The default.
   *  - "waveform": a scrolling amplitude window around the playhead.
   */
  mode: z.enum(["spectrum", "waveform"]).default("spectrum"),
  /** Spectrum: how slowly bars fall after a hit (0 = instant, 1 = long tails). */
  decay: z.number().min(0).max(1).default(0.55),
  /** Box size in frame px (transform.scale sizes it further, like any layer). */
  width: z.number().positive(),
  height: z.number().positive(),
  /** Primary color (hex or `var:` token, like every color slot). */
  color: z.string(),
  /** Gradient end color; null = solid. */
  color2: z.string().nullable().default(null),
  /** Peak height multiplier (1 = a full-scale peak fills the box). */
  amplitude: z.number().min(0).max(4).default(1),
  /** Bars / dots / spokes across the box (line/area sample this many bins too). */
  barCount: z.number().int().min(8).max(512).default(64),
  /** Bar width as a fraction of its slot — the rest is gap. */
  barFill: z.number().min(0.05).max(1).default(0.65),
  /** 0 = square bar caps, 1 = fully rounded. */
  roundness: z.number().min(0).max(1).default(1),
  /** Stroke thickness in px (line / circular spokes / dot size). */
  thickness: z.number().min(0.5).max(60).default(3),
  /** The window of SOUND shown, wall ms centered on the playhead. */
  windowMs: z.number().min(50).max(20000).default(1200),
  /** 0..1 neighbor smoothing — calms jitter into flowing motion. */
  smoothing: z.number().min(0).max(1).default(0.25),
  /** Mirror around the horizontal center (false = anchored to the bottom). */
  mirror: z.boolean().default(true),
  /** Circular: hole radius as a fraction of the box's half-size. */
  innerRadius: z.number().min(0).max(0.95).default(0.55),
  /** Circular: where the ring starts, degrees (-90 = 12 o'clock). */
  startAngleDeg: z.number().default(-90),
  /** Circular: arc the spokes cover, degrees. */
  spanDeg: z.number().min(30).max(360).default(360),
  /** Soft glow radius in px (0 = off). */
  glow: z.number().min(0).max(120).default(0),
  /** Flip the whole visualizer horizontally (mirrors left↔right, bass↔treble). */
  flipX: z.boolean().default(false),
  /** Flip the whole visualizer vertically (top↔bottom). */
  flipY: z.boolean().default(false),
  /**
   * Rotate the whole visualizer around the box center, degrees. 90 makes bars
   * grow sideways ("vertical" orientation); applied as one transform seam in the
   * painter so it works for every template and in export alike.
   */
  rotateDeg: z.number().default(0),
});
export type WaveformStyle = z.infer<typeof waveformStyleSchema>;
export type WaveformTemplate = WaveformStyle["template"];

/**
 * An audio-reactive waveform visualizer (v19, the first plugin's clip). It is
 * PROCEDURAL: it stores only a style + the id of the audio-bearing clip it
 * listens to, and the renderer draws the sound audible at each moment through
 * the one shared pipeline — so preview and export are identical by
 * construction, and speed/trim/loop changes on the audio can never desync it.
 * No baking, no caches to invalidate.
 */
export const waveformClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("waveform"),
  /** The audio or video clip being visualized (usually link-grouped with it). */
  targetClipId: z.string(),
  style: waveformStyleSchema,
});
export type WaveformClip = z.infer<typeof waveformClipSchema>;

/**
 * A TRACE (v109): the path a point has drawn over the whole shot — a layer's
 * point, a body's, or its own position as a pen — cooling from `head` to
 * `tail` by age, with optional strobe ghosts. PROCEDURAL like the waveform:
 * it stores only what it follows and how it looks; the polyline is sampled
 * from the document at every instant (`trace/evaluate.ts`). See `schema/trace`.
 */
export const traceClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("trace"),
  trace: traceSpecSchema,
});
export type TraceClip = z.infer<typeof traceClipSchema>;

/**
 * A raster paint layer (v32) — the pixel surface the brush/eraser/fill tools
 * write into. The DOCUMENT stores no pixels: `surfaceId` names an app-side
 * paint surface (bytes live beside asset blobs), and `rev` is a monotonic
 * paint revision bumped INSIDE the same document update as every committed
 * stroke. That one integer is the undo seam: undo/redo replays the doc patch,
 * the surface store sees `rev` change and seeks its tile-delta journal to that
 * revision — raster edits ride the one history with everything else, and the
 * project JSON stays small. Renders like an image at `transform`; all the
 * shared layer machinery (effects, opacity, blend, lock/hide, masks) applies.
 */
export const rasterClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("raster"),
  /** App-side paint surface holding this layer's pixels. */
  surfaceId: z.string(),
  /** Surface size in px, fixed at creation (usually the comp size). */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Paint revision — bumped per committed stroke (see above). */
  rev: z.number().int().min(0).default(0),
  /**
   * CAPTURE snapshot revisions (v41) — when this layer records a drawing over
   * time, each `capture` keyframe names its OWN snapshot surface; this maps that
   * surfaceId → its paint revision, the exact per-frame analogue of `rev`. The
   * history seam (`syncSurfacesToDocument`) seeks each snapshot surface to its
   * revision here, so editing frame 3 then frame 7 undoes each independently.
   * Absent on plain (non-recorded) raster layers.
   */
  captureRevs: z.record(z.string(), z.number().int().min(0)).optional(),
});
export type RasterClip = z.infer<typeof rasterClipSchema>;

/**
 * How an adjustment layer chooses the pixels it processes, and what it does to
 * them (v39; `source` added v65). THREE axes, fully independent so the whole
 * matrix is reachable from one compact model:
 *  - `reach`: "below" grades the composite of everything beneath it in z — its
 *    stack position matters (the After Effects model, move it up to reach more);
 *    "all" ignores its own position and grades the WHOLE frame as a final pass.
 *  - `filter`: narrows the reach to a hand-picked set. "all" = the entire reach;
 *    "only" = just the listed layers/groups (the grade shows through THEIR
 *    silhouette, everything else is left untouched); "except" = everything in
 *    reach BUT the listed ones. Ids address clips OR groups — a group id folds in
 *    all of its members, at any depth, resolved through the same layer tree the
 *    renderer walks. The graded result composites back at the adjustment's own
 *    `opacity` (wet/dry mix) and `blendMode`.
 *  - `source`: does the grade CONSUME what it read, or lay over it? "replace"
 *    erases the region from the plate before the graded result lands, so a
 *    sizing pose moves the picture instead of duplicating it; "over" keeps the
 *    original underneath, which is what you want for a grade you are dialling
 *    in against the untouched layer.
 *
 * `source` exists because that decision used to be DERIVED from `filter`: the
 * renderer replaced when there was no matte and laid over when there was, so a
 * transformed grade moved the whole frame but left a picked layer sitting
 * un-moved beneath its own graded copy — and ticking a layer in the scope
 * picker silently changed a second thing nobody had asked it to.
 */
export const adjustmentScopeSchema = z.object({
  reach: z.enum(["below", "all"]).default("below"),
  filter: z
    .object({
      mode: z.enum(["all", "only", "except"]).default("all"),
      /** Clip OR group ids; a group id means every descendant clip. */
      targetIds: z.array(z.string()).default([]),
    })
    .default({ mode: "all", targetIds: [] }),
  /** Consume the pixels graded ("replace") or keep them underneath ("over"). */
  source: z.enum(["replace", "over"]).default("replace"),
});
export type AdjustmentScope = z.infer<typeof adjustmentScopeSchema>;

/**
 * An ADJUSTMENT layer (v39) — a layer that paints nothing of its own and instead
 * re-processes the pixels it reaches through the SAME headless `effects` stack
 * every visual clip already carries (blur / adjust / colorGrade / chromaKey…).
 * It is an effect *node* placed on the timeline: its z-position + `scope` pick
 * which pixels it grades, its `opacity` is the wet/dry mix and `blendMode` how
 * the graded result composites back over the original. Multiple adjustment
 * layers chain like nodes, bottom→top, each grading what the previous produced.
 *
 * It reuses `visualClipBase` wholesale — transform, keyframes, opacity, blend,
 * lock/hide, grouping, the layer tree, the timeline row and the whole layer-
 * effects inspector all apply with no new code; only `scope` is new. `fills`,
 * `strokes`, `maxWidth` etc. stay at their empty defaults (it has no own paint).
 */
export const adjustmentClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("adjustment"),
  scope: adjustmentScopeSchema.default({ reach: "below", filter: { mode: "all", targetIds: [] }, source: "replace" }),
});
export type AdjustmentClip = z.infer<typeof adjustmentClipSchema>;

// ── The 3D kinds (v89) — see docs/adr/ADR-3d.md ──────────────────────────────

/**
 * A 3D OBJECT made of polygons. Its colour is its `fills` (the one paint
 * model), its surface response is `material`, per-face looks are `parts`, and
 * its `strokes` draw the edges `lines` selects. The transform's origin is the
 * object's pivot (Blender); `anchor` is not read.
 */
export const meshClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("mesh"),
  /** How a texture wraps the shape — box, planar (front), cylinder, sphere. */
  uv: z.enum(["box", "planar", "cylinder", "sphere"]).default("box"),
  /**
   * A COMP AS THE SURFACE — any flat frame, painted with the 2D tools you
   * already have (pixel brushes, vectors, text, even animation), wraps the
   * mesh live through `uv`. Null = the fills colour it.
   */
  texture: z.object({ frameId: z.string(), repeat: z.number().positive().default(1) }).nullable().default(null),
  geometry: meshSourceSchema,
  material: materialSchema.default({}),
  parts: z.array(meshPartSchema).default([]),
  modifiers: z.array(modifierSchema).default([]),
  lines: meshLinesSchema.default({}),
  /** `auto` smooths across edges flatter than `smoothAngle` (Blender's auto smooth). */
  shading: z.enum(["smooth", "flat", "auto"]).default("auto"),
  smoothAngle: z.number().min(0).max(180).default(30),
  castShadow: z.boolean().default(true),
  receiveShadow: z.boolean().default(true),
  /** A LATTICE CAGE (its rest grid): drawn as a cage in the viewport, never rendered — what a Lattice modifier deforms by. */
  lattice: latticeSpecSchema.optional(),
  /** Shape keys (Characters 2.0): blendshapes over `geometry.mesh`, weights at `key.<id>`. See `schema/shape-keys`. */
  shapeKeys: shapeKeysSchema.optional(),
});
export type MeshClip = z.infer<typeof meshClipSchema>;

/**
 * A CAMERA. Looks down its local −Z with +Y up (Blender). Visual on purpose:
 * its effect stack is the post-process for everything it sees, and its shutter
 * is the world's motion blur. Which camera is live is DERIVED — the topmost
 * visible camera clip covering the instant (`activeCameraAt`).
 */
export const cameraClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("camera"),
  camera: cameraSpecSchema.default({}),
});
export type CameraClip = z.infer<typeof cameraClipSchema>;

/** A LIGHT — point, sun, spot, area, environment (studio/sky) or hemisphere. Points down its −Z. */
export const lightClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("light"),
  light: lightSpecSchema,
});
export type LightClip = z.infer<typeof lightClipSchema>;

/**
 * A CONTROLLER — Blender's Empty, After Effects' Null: a point in space with
 * axes and nothing to render. Animate it and parent things to it (Child Of),
 * aim cameras at it, drive a rig from it. Drawn in the viewport only.
 */
export const EMPTY_DISPLAYS = ["axes", "cube", "sphere", "arrows"] as const;
export const emptyClipSchema = z.object({
  ...visualClipBase,
  kind: z.literal("empty"),
  display: z.enum(EMPTY_DISPLAYS).default("axes"),
  /** Helper size in units (viewport only). */
  size: z.number().positive().default(80),
});
export type EmptyClip = z.infer<typeof emptyClipSchema>;

/**
 * Every clip, as ONE type — declared from the named arms rather than inferred
 * back off the union schema below.
 *
 * That direction is load-bearing, not stylistic. `z.infer` produces an
 * anonymous structural type, and TypeScript's declaration writer expands one of
 * those in full at EVERY site that mentions it: ten clip arms, each carrying
 * ~50 field schemas and the whole 30-arm effect union, written out again inside
 * `documentSchema`. That is what overflows the serializer (TS7056) — the same
 * wall `layerEffectListSchema` was named to get around one level down, and the
 * wall the effect stack hit the moment it grew past twenty cards.
 *
 * Writing the union by hand makes `Clip` a NAMED symbol, so every downstream
 * type emits a reference to it instead of a copy. `clipSchema` is then
 * annotated with it, which breaks the inference cycle and buys the document
 * schema headroom that scales with the number of effects rather than fighting
 * it.
 */
export type Clip =
  | TextClip
  | GroupClip
  | AudioClip
  | NestedClip
  | ImageClip
  | VideoClip
  | ShapeClip
  | PathClip
  | WaveformClip
  | TraceClip
  | RasterClip
  | AdjustmentClip
  | MeshClip
  | CameraClip
  | LightClip
  | EmptyClip;

export const clipSchema: z.ZodType<Clip, z.ZodTypeDef, unknown> = z.discriminatedUnion("kind", [
  textClipSchema,
  groupClipSchema,
  audioClipSchema,
  nestedClipSchema,
  imageClipSchema,
  videoClipSchema,
  shapeClipSchema,
  pathClipSchema,
  waveformClipSchema,
  traceClipSchema,
  rasterClipSchema,
  adjustmentClipSchema,
  meshClipSchema,
  cameraClipSchema,
  lightClipSchema,
  emptyClipSchema,
]);
export type ClipKind = Clip["kind"];
/** Visual clips carry a transform (everything except audio). */
export type VisualClip =
  | TextClip
  | GroupClip
  | NestedClip
  | ImageClip
  | VideoClip
  | ShapeClip
  | PathClip
  | WaveformClip
  | TraceClip
  | RasterClip
  | AdjustmentClip
  | MeshClip
  | CameraClip
  | LightClip
  | EmptyClip;
