import { z } from "zod";
import { vec2Schema } from "./common";
import { subpathSchema } from "./vector";

/**
 * MOTION TRACKING (v39, rebuilt v77, re-founded v101) — what the footage
 * KNOWS, and the matte that knowledge carries with it.
 *
 * A `Tracker` is a DATA SOURCE, never an effect. It bakes its answer into
 * `samples`, and any number of consumers read that bake through ONE reader
 * (`tracking/read.ts`): a layer that follows it, a grade window that isolates
 * it, an expression, a node, an agent. Re-track once and everything downstream
 * updates. See docs/adr/ADR-tracking.md.
 *
 * ── v101: A TRACKER BELONGS TO FOOTAGE, NOT TO A CLIP ──────────────────────
 *
 * Samples used to be keyed to one clip's LOCAL time (`sourceClipId`). Split
 * that clip and the second half lost its track; change its speed and the track
 * slid off the object. A track is a fact about the MEDIA — the face is where it
 * is in frame 212 of that file however the file is cut — so it is stored the
 * way Blender stores tracks on a MovieClip: by the asset, in the asset's own
 * time and pixels. Every reader goes through the viewing clip's time map
 * (trim, speed, reverse, loop), the same door sound analysis uses.
 *
 * ── v77, still true ────────────────────────────────────────────────────────
 *
 * 1. THE REGION IS THE TRACKER'S OWN GEOMETRY, NOT A TIMELINE CLIP. It paints
 *    nothing, exports nothing and has no z-order.
 * 2. ONE GEOMETRY, FOUR AUTHORING TOOLS. Rect, ellipse, polygon and pen path
 *    are one closed contour; `shape` is provenance, never a code path.
 * 3. WHAT YOU TRACK (the region) AND HOW IT IS MATCHED (`solve.method`) ARE
 *    TWO AXES, so every pairing is reachable.
 * 4. THE POSE LIVES ON THE SAMPLES, one channel per degree of freedom, each
 *    separately solvable, pinnable and readable.
 *
 * COORDINATE SPACE: samples live in the source's PIXEL space (top-left origin,
 * +x right / +y down — what `getImageData` returns), keyed by SOURCE time (ms
 * into the media file).
 */

/** A box in source pixels — a search area, a bounds readout, a colour window. */
export const trackRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export type TrackRect = z.infer<typeof trackRectSchema>;

// ── The source ───────────────────────────────────────────────────────────────

/**
 * WHAT IS BEING WATCHED. A union with one arm today: a media asset (video,
 * image, animated image). Tracking a nested comp's rendered frames is one more
 * arm and one more frame provider — no migration, which is why this is a union
 * from the start rather than a bare `assetId`.
 */
export const trackSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), assetId: z.string() }),
]);
export type TrackSource = z.infer<typeof trackSourceSchema>;

// ── The region ───────────────────────────────────────────────────────────────

/**
 * Which tool drew the region. PROVENANCE, not a code path: all four are stored
 * as the same contour and solved by the same engine. It decides which on-stage
 * rig you get and whether a size edit stays parametric.
 */
export const trackShapeSchema = z.enum(["rect", "ellipse", "polygon", "path"]);
export type TrackShape = z.infer<typeof trackShapeSchema>;

/**
 * The thing being tracked, and the matte it produces.
 *
 * `subpaths` are in REGION-LOCAL space: centred on the origin, unrotated, at the
 * scale the reference frame saw. Multiply by a sample's pose to get the contour
 * in source pixels at that time. Compound paths are allowed (a donut).
 */
export const trackRegionSchema = z.object({
  shape: trackShapeSchema.default("ellipse"),
  subpaths: z.array(subpathSchema).min(1),
  /** Matte edge softness in source px — the edge belongs to the thing isolated. */
  feather: z.number().min(0).default(0),
  /** Grow (+) or choke (−) the matte in source px, applied before the feather. */
  expand: z.number().default(0),
  /** Matte the OUTSIDE of the contour — Resolve's inverted window. */
  invert: z.boolean().default(false),
});
export type TrackRegion = z.infer<typeof trackRegionSchema>;

// ── The solve ────────────────────────────────────────────────────────────────

/**
 * A degree of freedom. These are the axes a sample carries, the axes a solver
 * measures, the axes a correction pins and the axes a follower takes — one
 * closed vocabulary for all four (Mocha's Translation / Scale / Rotation /
 * Shear / Perspective toggles, plus a deforming outline).
 *
 *   position     where the region's centre is
 *   scale        how big, relative to where it was drawn (and its aspect)
 *   rotation     how turned
 *   skew         sheared — a plane seen obliquely, before perspective
 *   perspective  the projective part: a plane going away from the lens
 *   shape        per-vertex warp — the outline itself deforms
 *   lens         the focal length — what a camera following a camera solve
 *                takes along with its position and rotation (3D only)
 *
 * Solving every one of the first five is a homography: a tracked PLANE.
 */
export const trackChannelSchema = z.enum(["position", "scale", "rotation", "skew", "perspective", "shape", "lens"]);
export type TrackChannel = z.infer<typeof trackChannelSchema>;

/** One colour the `color` method keys, with its own tolerance and ramp. */
export const colorTargetSchema = z.object({
  color: z.string(),
  /** Chroma distance below which a pixel fully counts (0..100). */
  tolerance: z.number().min(0).max(100).default(28),
  /** Ramp past tolerance where the weight fades to 0 (0..100). */
  softness: z.number().min(0).max(100).default(14),
});
export type ColorTarget = z.infer<typeof colorTargetSchema>;

/**
 * HOW the region is matched from frame to frame.
 *
 *   auto      features when the region has enough texture to hold them, luma
 *             when it does not (a dot, a small flat logo). The default.
 *   features  many corners inside the region, followed with pyramidal
 *             Lucas–Kanade, the motion fit by RANSAC so an occluding hand or a
 *             reflection is voted out instead of dragging the answer. The
 *             planar workhorse — the only method that solves perspective well.
 *   luma      normalised cross-correlation of the region's masked pixels.
 *             Small, low-texture targets; survives lighting changes.
 *   color     the weighted centroid + spread of pixels matching `colors`. Flat,
 *             saturated, deforming subjects (a ball, a jersey) and the only one
 *             that copes with the subject leaving and re-entering.
 */
export const trackMethodSchema = z.enum(["auto", "features", "luma", "color"]);
export type TrackMethod = z.infer<typeof trackMethodSchema>;

/**
 * WHICH FRAMES ARE MEASURED.
 *
 *   every  every frame, in order.
 *   auto   strides up to `maxStride` frames and checks itself with a
 *          FORWARD–BACKWARD round trip: track ahead, track back, see whether it
 *          lands where it started. A step that misses by more than `doubtPx`
 *          (analysis px), whose match weakens, or whose motion outruns the
 *          search window is DOUBTED and split until it is trusted or one frame
 *          wide. Calm footage costs a fraction; a whip pan costs what it needs.
 *          Frames between measured ones are read by interpolation.
 */
export const trackCadenceSchema = z.object({
  mode: z.enum(["auto", "every"]).default("auto"),
  maxStride: z.number().int().min(1).max(16).default(4),
  doubtPx: z.number().min(0.05).max(16).default(0.75),
});
export type TrackCadence = z.infer<typeof trackCadenceSchema>;

export const trackSolveSchema = z.object({
  method: trackMethodSchema.default("auto"),
  /** Colours for `method: "color"`. Ignored (and kept) by the others. */
  colors: z.array(colorTargetSchema).default([]),
  /** Which channels the engine measures. */
  channels: z.array(trackChannelSchema).default(["position", "scale"]),
  /**
   * Precision of each match, 0..1: patch size, search reach, iterations and
   * sub-pixel refinement together — "more careful, slower" as one number.
   */
  accuracy: z.number().min(0).max(1).default(0.5),
  cadence: trackCadenceSchema.default({}),
  /**
   * The long edge frames are analysed at, px; 0 = the source's own size. A 4K
   * plate tracked at 1280 is three times faster and, for anything bigger than a
   * few pixels, exactly as accurate — positions are scaled back to source px.
   */
  analysisEdge: z.number().int().min(0).max(8192).default(1280),
  /**
   * How many vertices the warp solver works with (the contour is resampled to
   * this count). Only read when `channels` includes `shape`.
   */
  detail: z.number().int().min(4).max(64).default(16),
  /**
   * Re-seed the template from well-matched frames, so a subject that turns or
   * is lit differently keeps lock. Drift-guarded: a weak frame never becomes
   * the template.
   */
  adaptive: z.boolean().default(true),
});
export type TrackSolve = z.infer<typeof trackSolveSchema>;

// ── Samples ──────────────────────────────────────────────────────────────────

/**
 * One measurement: the region's POSE at one source time.
 *
 * The pose is a homography about the region's centre, decomposed so each
 * degree of freedom is its own field: `H = T(x,y) · R(rotation) · K(skew) ·
 * S(scale, scaleY) · P(perspective)`. The decomposition is unique, so every
 * plane the solver can see is representable, and pinning "the rotation here"
 * means exactly one field.
 *
 * `scaleY: null` means the aspect is locked to `scale` — a real distinction
 * from `scaleY: 1`, which says the axes were measured and happened to agree.
 *
 * `pinned` is the correction model: the channels the user fixed by hand here.
 * The solver may not overwrite them, re-seeds from them, and spreads the error
 * it accumulates between two of them across the span between.
 *
 * Only MEASURED frames are stored. A frame the cadence skipped has no sample;
 * the reader interpolates it, and `solved` says which is which.
 */
export const trackSampleSchema = z.object({
  /** Source time, ms into the media. */
  timeMs: z.number().min(0),
  /** Region centre in source px. */
  x: z.number(),
  y: z.number(),
  scale: z.number().positive().default(1),
  /** Vertical scale; null = locked to `scale` (uniform). */
  scaleY: z.number().positive().nullable().default(null),
  /** Degrees. */
  rotation: z.number().default(0),
  /** Shear, degrees (x leans as y grows). */
  skew: z.number().default(0),
  /**
   * The projective row `[g, h]` in region-local units (×1, typically ~1e-4):
   * a local point p maps to p / (1 + g·p.x + h·p.y) before the affine part.
   * Null = no perspective, the common case, and free to store.
   */
  perspective: vec2Schema.nullable().default(null),
  /**
   * Per-vertex offsets in region-local space, parallel to the resampled
   * contour (`solve.detail` entries). Null = a rigid pose.
   */
  warp: z.array(vec2Schema).nullable().default(null),
  confidence: z.number().min(0).max(1).default(1),
  /** Channels the user fixed by hand here. Non-empty ⇒ this sample is an ANCHOR. */
  pinned: z.array(trackChannelSchema).default([]),
});
export type TrackSample = z.infer<typeof trackSampleSchema>;

/** True when the user has pinned anything here — the solver treats it as truth. */
export function isTrackAnchor(s: TrackSample): boolean {
  return s.pinned.length > 0;
}

/** A closed source-ms interval, `[from, to]`. */
export const trackSpanSchema = z.tuple([z.number(), z.number()]);
export type TrackSpan = z.infer<typeof trackSpanSchema>;

/**
 * Freshness and COVERAGE. Coverage is what makes analysis resumable: pause,
 * stop, close the app — the next run solves only what is missing, and a
 * correction re-solves only the spans it touches.
 */
export const trackAnalysisSchema = z.object({
  /** Bumped whenever region/solve changes; older samples are stale. */
  version: z.number().int().min(0).default(0),
  engine: z.string().default("cpu"),
  /** Source-ms spans already solved, sorted, non-overlapping. */
  coverage: z.array(trackSpanSchema).default([]),
  at: z.number().default(0),
});
export type TrackAnalysis = z.infer<typeof trackAnalysisSchema>;

/** Fields every tracker kind carries. */
const trackerBase = {
  id: z.string(),
  name: z.string(),
  /** Overlay colour — tells several trackers on one plate apart. */
  color: z.string().default("#4ade80"),
  source: trackSourceSchema,
  /**
   * The clip it was drawn on — a HINT for which placement maps source pixels
   * into a comp, never an owner (see `tracking/footage.ts`). Null or stale is
   * fine: the reader falls back to whatever clip shows the source.
   */
  via: z.string().nullable().default(null),
};

/**
 * A REGION tracker — 2D: a point, a patch, a plane, a deforming outline. Which
 * of those it is is a matter of channels, not of kind.
 *
 * `referenceMs` (source ms) is where the region was DRAWN, and it is the origin
 * of the solve: analysis radiates forward AND backward from that frame.
 */
export const regionTrackerSchema = z.object({
  kind: z.literal("region"),
  ...trackerBase,
  region: trackRegionSchema,
  solve: trackSolveSchema.default({}),
  /** Measured samples, ascending by `timeMs`. Empty until analysed. */
  samples: z.array(trackSampleSchema).default([]),
  referenceMs: z.number().min(0).default(0),
  analysis: trackAnalysisSchema.nullable().default(null),
  /**
   * Something changed since the last bake (a correction, a colour, a region
   * edit) so the samples are stale — drives the Re-solve affordance.
   */
  dirty: z.boolean().default(false),
});
export type RegionTracker = z.infer<typeof regionTrackerSchema>;

// ── The camera solve ─────────────────────────────────────────────────────────

/**
 * HOW a camera is solved.
 *
 *   auto    a moving camera when the shot has parallax, a tripod when it
 *           only turns (decided by the solve, reported in `solution.mode`)
 *   free    always a moving camera — fails honestly on a pure pan
 *   tripod  rotation only: pans, tilts and zooms on a locked-off head
 *
 * `focalLength` is the lens in mm on a 36 mm sensor across the long edge (the
 * world camera's own units); null = find it. `features` is how many corners
 * are followed at once — more is steadier and slower.
 */
export const cameraSolveSchema = z.object({
  mode: z.enum(["auto", "free", "tripod"]).default("auto"),
  focalLength: z.number().min(1).max(5000).nullable().default(null),
  features: z.number().int().min(50).max(2000).default(400),
  /** Long edge frames are analysed at, px; 0 = native. A solve needs corners, not pixels. */
  analysisEdge: z.number().int().min(0).max(8192).default(960),
});
export type CameraSolve = z.infer<typeof cameraSolveSchema>;

/**
 * WHAT A SOLVE FOUND — in the solve's own frame and units (computer-vision
 * axes: x right, y DOWN, z forward from the first solved camera; arbitrary
 * scale). `scene` places that frame in a world.
 *
 * Stored flat because it is big: a minute of footage is 1 800 poses and a
 * thousand points, which as objects would dominate the document and every
 * undo patch of it. Frames the solve could not place are simply absent from
 * `times`; the reader interpolates across them.
 */
export const cameraSolutionSchema = z.object({
  mode: z.enum(["free", "tripod"]),
  /** Source size the intrinsics are in, px. */
  width: z.number().positive(),
  height: z.number().positive(),
  /** Focal length, source px (the principal point is the frame centre). */
  focalPx: z.number().positive(),
  /** Source ms of each placed frame, ascending. */
  times: z.array(z.number()),
  /** Per time: camera-to-solve rotation as a quaternion (x, y, z, w) and the camera centre — 7 numbers. */
  poses: z.array(z.number()),
  /** Per time: reprojection RMS, px — how well this frame agrees. */
  frameError: z.array(z.number()),
  /** Triangulated points, flat xyz (tripod: unit directions). */
  points: z.array(z.number()),
  /** Grey of each point, 0..255 (what the cloud is drawn in). */
  pointLuma: z.array(z.number()),
  /** Reprojection RMS over the whole shot, px. */
  error: z.number().min(0),
});
export type CameraSolution = z.infer<typeof cameraSolutionSchema>;

/**
 * WHERE THE SOLVE STANDS IN A WORLD — a similarity: `world = scale · R · p +
 * offset` for a point `p` in solve space (R as a quaternion). This is what the
 * ground, origin and scale tools edit; null = the default the reader derives
 * (the first camera where a world's default camera stands, Z up, the scene at
 * the depth that is 1 px per px) — derived, so a re-solve never leaves a
 * stale placement behind.
 */
export const cameraSceneSchema = z.object({
  rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  scale: z.number().positive(),
  offset: z.tuple([z.number(), z.number(), z.number()]),
});
export type CameraScene = z.infer<typeof cameraSceneSchema>;

/**
 * A CAMERA tracker — the shot's camera, solved in 3D: where it was, where it
 * looked and through what lens, frame by frame, with the points it saw. A
 * world camera FOLLOWS it (`trackBinding` on a camera clip), the footage is
 * that camera's backplate, and the points are snap targets — "Make 3D scene".
 */
export const cameraTrackerSchema = z.object({
  kind: z.literal("camera"),
  ...trackerBase,
  solve: cameraSolveSchema.default({}),
  solution: cameraSolutionSchema.nullable().default(null),
  scene: cameraSceneSchema.nullable().default(null),
  analysis: trackAnalysisSchema.nullable().default(null),
  dirty: z.boolean().default(false),
});
export type CameraTracker = z.infer<typeof cameraTrackerSchema>;

// ── Depth ────────────────────────────────────────────────────────────────────

/**
 * WHICH DEPTH MODEL. Both are Apache-2.0, self-hosted, run in the analysis
 * worker through onnxruntime-web (WebGPU, else WASM):
 *
 *   video  Video Depth Anything Small — temporally consistent across a shot
 *          (a 32-frame head over per-frame features), so fog and a matte do
 *          not flicker. ~59 MB.
 *   still  Depth Anything V3 Small — one picture at a time; the sharper
 *          choice for a still or a single frame. ~29 MB.
 *   auto   video for footage, still for an image.
 */
export const depthModelSchema = z.enum(["auto", "video", "still"]);
export type DepthModel = z.infer<typeof depthModelSchema>;

export const depthSolveSchema = z.object({
  model: depthModelSchema.default("auto"),
  /** Long edge of the stored maps, px. Depth is smooth; a matte needs edges, not detail. */
  mapEdge: z.number().int().min(128).max(1024).default(512),
});
export type DepthSolve = z.infer<typeof depthSolveSchema>;

/**
 * WHAT A DEPTH RUN MADE — the frames that have a map, and the shot's range.
 * The maps themselves are derived data, heavy (a few hundred kB a frame) and
 * kept beside the document (the host's depth store, keyed by `key`), the way
 * a sound's analysis is: a re-run mints a new key, so a stale map can never
 * be read as the new one. Values are NEARNESS, 0 (the far end of the shot)
 * to 1 (its nearest), measured across the whole shot.
 */
export const depthMapsSchema = z.object({
  key: z.string(),
  /** `video`: maps that agree across the shot; `still`: one picture (or frames each on its own). */
  model: z.enum(["video", "still"]),
  /** The network that made them — `vda-small` (the temporal head) or `da3-small` (per frame, steadied for footage). */
  network: z.string().default(""),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Source ms of every frame with a map, ascending. */
  times: z.array(z.number()),
});
export type DepthMaps = z.infer<typeof depthMapsSchema>;

/**
 * A DEPTH tracker — how far every pixel of the footage is from the lens. Read
 * by Fog and Lens Blur on the footage, by "behind the subject" mattes on the
 * layers above it, by a grade window's depth band, and by a still's relief.
 */
export const depthTrackerSchema = z.object({
  kind: z.literal("depth"),
  ...trackerBase,
  solve: depthSolveSchema.default({}),
  maps: depthMapsSchema.nullable().default(null),
  analysis: trackAnalysisSchema.nullable().default(null),
  dirty: z.boolean().default(false),
});
export type DepthTracker = z.infer<typeof depthTrackerSchema>;

/**
 * Every tracker kind — each one union arm and one entry in `TRACK_KINDS`
 * (`tracking/read.ts`), which does not compile until it says what it answers.
 */
export const trackerSchema = z.discriminatedUnion("kind", [regionTrackerSchema, cameraTrackerSchema, depthTrackerSchema]);
export type Tracker = z.infer<typeof trackerSchema>;
export type TrackerKind = Tracker["kind"];

/**
 * A layer FOLLOWING a tracker (lives on `visualClipBase.trackBinding`).
 *
 * Resolved in `resolvedDocAt` like any driver, so every reader — hit tests,
 * gizmos, the inspector, `layer("X").x`, export, agents — sees the followed
 * pose. Position is absolute (+ offset), the other channels relative to the
 * reference frame, composed onto the layer's own keys. `perspective` pins the
 * layer's box onto the tracked plane (corner pin). `invert` on the footage's
 * OWN binding is stabilisation: the plate counter-moves so the tracked point
 * holds still.
 */
export const trackBindingSchema = z.object({
  trackerId: z.string(),
  channels: z.array(trackChannelSchema).default(["position"]),
  /** Constant offset in comp px added after mapping (text sits above the head). */
  offset: vec2Schema.default({ x: 0, y: 0 }),
  /** Path smoothing 0..1 applied to the driven values (0 = raw samples). */
  smooth: z.number().min(0).max(1).default(0),
  /** Counter-move instead of follow — stabilise the footage itself. */
  invert: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type TrackBinding = z.infer<typeof trackBindingSchema>;
