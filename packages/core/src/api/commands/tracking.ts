import { z } from "zod";
import type { MotionDocument, Tracker } from "../../schema";
import type { CameraTracker, DepthTracker } from "../../schema/tracking";
import { trackerConsumers } from "../../tracking/usage";
import { SENSOR_MM } from "../../tracking/camera/solve";
import { depthModelSchema, trackChannelSchema, trackMethodSchema, trackShapeSchema } from "../../schema/tracking";
import { createCameraTracker, setCameraGround, setCameraOrigin, setCameraScale } from "../../tracking/camera/ops-camera";
import { catchShadowsOnGround, makeCameraScene, placeTextOnSolvedPoints, solvedPointsNear, worldsFollowing } from "../../tracking/camera/scene";
import { createDepthTracker } from "../../tracking/depth/ops-depth";
import { isVisualClip } from "../../clip-registry";
import {
  clipsBoundToTracker,
  correctTrackerAt,
  createTrackerAt,
  flattenTrackBinding,
  followTracker,
  qualityOf,
  removeTracker,
  setTrackerRegion,
  setTrackerSolve,
  TRACK_QUALITIES,
  unbindClip,
  type TrackQuality,
} from "../../tracking/ops";
import { footageClips } from "../../tracking/footage";
import { readTrack, trackReadings } from "../../tracking/read";
import { trackHealth } from "../../tracking/samples";
import { trackersUsedByGrades } from "../../grade/ops";
import { clipLocalTime } from "../../animation/evaluate";
import { clipLocalTimeAtSource } from "../../timeline/ops";
import { ApiError, defineCommand } from "../command";
import { requireClip } from "../lookup";

/**
 * TRACKING — what footage knows, for agents.
 *
 * Everything an agent gives or gets is in COMP space and COMP time — the space
 * `view.render` shows and `transform.x/y` is written in — so a region drawn
 * around a face in a rendered frame is the region that gets tracked, and a
 * position read back is a position a layer can be set to. Trackers store the
 * footage's own pixels and time underneath (they belong to the media, so a
 * split or retimed clip keeps its track); none of that leaks into the API.
 *
 * `track.analyze` (the solve) is a host verb — it needs decoded frames — and
 * lives beside the editor's frame pipeline; everything else is here.
 */

const qualitySchema = z.enum(["fast", "balanced", "precise", "exact"]);

function requireTracker(doc: MotionDocument, id: string): Tracker {
  const t = doc.trackers.find((x) => x.id === id) ?? doc.trackers.filter((x) => x.name === id)[0];
  if (t) return t;
  throw new ApiError(`No tracker "${id}".`, "track.inspect with no tracker lists them all.");
}

/** The comp time a tracker's footage is first on screen — the default instant to read or draw at. */
function firstShown(doc: MotionDocument, t: Tracker): { compId: string; compMs: number } | null {
  const clip = footageClips(doc, t).find((c) => c.id === t.via) ?? footageClips(doc, t)[0];
  return clip ? { compId: clip.frameId, compMs: clip.startMs } : null;
}

function summary(doc: MotionDocument, t: Tracker) {
  if (t.kind === "camera") return cameraSummary(doc, t);
  if (t.kind === "depth") return depthSummary(doc, t);
  const health = trackHealth(t);
  const followers = clipsBoundToTracker(doc, t.id);
  const grades = trackersUsedByGrades(doc).has(t.id);
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    footage: t.source.assetId,
    drawnOn: t.via,
    method: t.solve.method,
    channels: t.solve.channels,
    quality: qualityOf(t.solve),
    measured: t.samples.length,
    coverage: t.analysis?.coverage ?? [],
    stale: t.dirty,
    confidence: Math.round(health.average * 100) / 100,
    corrections: health.anchors,
    followers,
    usedByGrade: grades,
  };
}

export const trackCreate = defineCommand({
  id: "track.create",
  summary: "Add a tracker to a video/image layer: a region to follow, the camera that shot it, or its depth.",
  details:
    "kind region (default): a region around the thing to follow, needs atMs + region. kind camera: solves the camera move and lens from the whole plate (mode auto/free/tripod; lens in mm if known) — then track.analyze, then track.scene. kind depth: how far each pixel is from the lens (model auto/video/still; the first run downloads the model) — then track.analyze, then effects.add fog / lensBlur on the footage, depthMatte (\"Behind\") on a layer above it with source = the footage, a grade window with source depth, or a geometry displace with source depth for a relief. Region is in COMP space (what view.render shows; x/y = centre, like transform.x/y) at `atMs` comp time — draw it on a frame where the subject is clearly visible. channels: position (a point), + scale/rotation (an object), + skew/perspective (a flat surface: a screen, a sign, a wall — needed for a corner pin). Then track.analyze. method auto picks features (textured things) or luma (small, plain targets); color keys a flat colour (set colors).",
  effect: "write",
  input: z.object({
    layer: z.string().describe("The footage layer (video or image)."),
    kind: z.enum(["region", "camera", "depth"]).default("region"),
    atMs: z.number().min(0).optional().describe("Region: comp time the region is drawn at."),
    region: z.object({
      shape: trackShapeSchema.default("rect"),
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
      rotation: z.number().default(0),
    }).optional(),
    mode: z.enum(["auto", "free", "tripod"]).optional().describe("Camera: a travelling camera (free), one that only turns (tripod), or let it tell."),
    lens: z.number().min(1).max(5000).optional().describe("Camera: the lens in mm (full-frame) when known; else it is found."),
    model: depthModelSchema.optional().describe("Depth: video (steady across a shot), still (sharper on one picture), auto."),
    channels: z.array(trackChannelSchema).default(["position", "scale", "rotation"]),
    method: trackMethodSchema.default("auto"),
    colors: z.array(z.string()).optional().describe("Hex colours, for method color."),
    quality: qualitySchema.default("balanced"),
    name: z.string().optional(),
  }),
  run(input, rt) {
    const clip = requireClip(rt.doc(), input.layer).clip;
    if (clip.kind !== "video" && clip.kind !== "image") throw new ApiError("Trackers watch a video or image layer.", "Pass the footage layer's id.");
    if (input.kind !== "region") {
      if (input.kind === "camera" && clip.kind !== "video") throw new ApiError("A camera solve needs moving footage.", "Use kind depth on a still.");
      let id = "";
      rt.write(input.kind === "camera" ? "Track camera" : "Find depth", (d) => {
        const made =
          input.kind === "camera"
            ? createCameraTracker(d, { clipId: clip.id, name: input.name, solve: { ...(input.mode && { mode: input.mode }), ...(input.lens && { focalLength: input.lens }) } })
            : createDepthTracker(d, { clipId: clip.id, name: input.name, solve: input.model ? { model: input.model } : {} });
        id = made?.id ?? "";
      });
      if (!id) throw new ApiError("Could not add a tracker there.");
      return {
        id,
        kind: input.kind,
        next:
          input.kind === "depth"
            ? "track.analyze. The first depth run on a device downloads its engine (~60–130 MB, once — kept across app updates, offline after); tell the user before starting it."
            : "track.analyze",
      };
    }
    if (input.atMs === undefined || !input.region) throw new ApiError("A region tracker needs atMs and region.", "Draw it around the subject on a frame where it is clearly visible.");
    if (clipLocalTime(clip, input.atMs) === null) throw new ApiError(`The layer is not on screen at ${input.atMs} ms.`, `It runs ${clip.startMs}–${clip.startMs + clip.durationMs} ms.`);
    let made: Tracker | null = null;
    rt.write("Track", (d) => {
      made = createTrackerAt(d, {
        clipId: clip.id,
        compMs: input.atMs!,
        region: input.region!,
        name: input.name,
        solve: {
          ...TRACK_QUALITIES[input.quality as TrackQuality],
          method: input.method,
          channels: input.channels,
          colors: (input.colors ?? []).map((color) => ({ color, tolerance: 28, softness: 14 })),
        },
      });
    });
    const t = made as Tracker | null;
    if (!t) throw new ApiError("Could not place a tracker there.");
    return { id: t.id, name: t.name, next: "track.analyze" };
  },
});

export const trackInspect = defineCommand({
  id: "track.inspect",
  summary: "List trackers, or read one: coverage, confidence, weak spans, followers, and its readings at comp times.",
  details:
    "No tracker: every one (optionally only those on `layer`'s footage). With tracker + `at` (comp ms, ≤ 60): each instant's readings in comp space — position, corners (topLeft…), rotation/scale since the drawn frame, confidence, solved (measured vs interpolated). Weak spans (confidence < 0.5) are where a correction helps most.",
  effect: "read",
  input: z.object({
    tracker: z.string().optional().describe("Tracker id or name; omit to list them."),
    layer: z.string().optional(),
    at: z.array(z.number()).max(60).optional(),
  }),
  run(input, rt) {
    const doc = rt.doc();
    if (!input.tracker) {
      const asset = input.layer ? requireClip(doc, input.layer).clip : null;
      const wanted = asset && (asset.kind === "video" || asset.kind === "image") ? asset.assetId : null;
      return { trackers: doc.trackers.filter((t) => !wanted || t.source.assetId === wanted).map((t) => summary(doc, t)) };
    }
    const t = requireTracker(doc, input.tracker);
    const where = firstShown(doc, t);
    const clip = footageClips(doc, t)[0];
    // Weak spans in COMP time, on the first clip showing the footage — through its own inverse time map.
    const toComp = (sourceMs: number) => (clip ? Math.round(clip.startMs + clipLocalTimeAtSource(doc, clip, sourceMs)) : sourceMs);
    const readings = trackReadings(t).map((r) => r.id);
    return {
      ...summary(doc, t),
      readings,
      weakSpans: weakSpansOf(t).map((s) => [toComp(s.fromMs), toComp(s.toMs)]),
      at: where
        ? (input.at ?? []).map((ms) => ({
            ms,
            ...Object.fromEntries(readings.map((r) => [r, roundValue(readTrack(doc, t, r, { compId: where.compId, compMs: ms }))])),
          }))
        : [],
    };
  },
});

/** Where a tracker is unsure, source ms: a region's weak confidence, a camera solve's frames that agree badly. */
function weakSpansOf(t: Tracker): Array<{ fromMs: number; toMs: number }> {
  if (t.kind === "region") return trackHealth(t).weakSpans;
  if (t.kind === "depth") return [];
  const s = t.solution;
  if (!s) return [];
  const out: Array<{ fromMs: number; toMs: number }> = [];
  s.times.forEach((ms, i) => {
    if ((s.frameError[i] ?? 0) <= 1.5) return;
    const last = out[out.length - 1];
    if (last && i > 0 && last.toMs === s.times[i - 1]) last.toMs = ms;
    else out.push({ fromMs: ms, toMs: ms });
  });
  return out;
}

function depthSummary(doc: MotionDocument, t: DepthTracker) {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    footage: t.source.assetId,
    model: t.maps?.model ?? t.solve.model,
    solved: !!t.maps,
    frames: t.maps?.times.length ?? 0,
    mapSize: t.maps ? [t.maps.width, t.maps.height] : null,
    coverage: t.analysis?.coverage ?? [],
    stale: t.dirty,
    usedBy: trackerConsumers(doc, t.id).length,
  };
}

function cameraSummary(doc: MotionDocument, t: CameraTracker) {
  const s = t.solution;
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    footage: t.source.assetId,
    mode: s?.mode ?? t.solve.mode,
    solved: !!s,
    lens: s ? Math.round(((s.focalPx * SENSOR_MM) / Math.max(s.width, s.height)) * 10) / 10 : t.solve.focalLength,
    errorPx: s?.error ?? null,
    frames: s?.times.length ?? 0,
    points: s ? s.points.length / 3 : 0,
    coverage: t.analysis?.coverage ?? [],
    stale: t.dirty,
    followers: clipsBoundToTracker(doc, t.id),
  };
}

function roundValue(v: unknown): unknown {
  if (typeof v === "number") return Math.round(v * 100) / 100;
  if (v && typeof v === "object" && "x" in v && "y" in v) {
    const p = v as { x: number; y: number };
    return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
  }
  return v;
}

export const trackCorrect = defineCommand({
  id: "track.correct",
  summary: "Fix a tracker by hand at one comp time: where the point really is, or the surface's four corners.",
  details:
    "Comp space, like everything here. Pins only what you give; the solver keeps the rest. Then run track.analyze with scope \"around\" and the same atMs — it re-solves the stretch between this correction and its neighbours, landing on each, so one fix repairs the frames around it. Corrections survive every later re-solve.",
  effect: "write",
  input: z.object({
    tracker: z.string().describe("Tracker id or name."),
    atMs: z.number().min(0),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    corners: z.array(z.object({ x: z.number(), y: z.number() })).length(4).optional().describe("topLeft, topRight, bottomRight, bottomLeft."),
    rotation: z.number().optional().describe("Degrees since the drawn frame."),
    scale: z.number().positive().optional().describe("Size since the drawn frame, 1 = same."),
  }),
  run(input, rt) {
    const doc = rt.doc();
    const t = requireTracker(doc, input.tracker);
    const where = firstShown(doc, t);
    if (!where) throw new ApiError("Nothing shows this tracker's footage.");
    let pinned: number | null = null;
    rt.write("Correct track", (d) => {
      pinned = correctTrackerAt(d, t.id, where.compId, input.atMs, {
        position: input.position,
        corners: input.corners as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] | undefined,
        rotation: input.rotation,
        scale: input.scale,
      });
    });
    if (pinned === null) throw new ApiError("The footage is not on screen then, or nothing was given to pin.");
    return { pinned: true, next: { command: "track.analyze", tracker: t.id, scope: "around", atMs: input.atMs } };
  },
});

export const trackUpdate = defineCommand({
  id: "track.update",
  summary: "Change a tracker: name, what it solves (channels), how (method, colours), speed vs accuracy, matte edge.",
  details: "Changing channels, method or quality makes the track stale: run track.analyze again (corrections are kept).",
  effect: "write",
  input: z.object({
    tracker: z.string().describe("Tracker id or name."),
    name: z.string().optional(),
    channels: z.array(trackChannelSchema).optional(),
    method: trackMethodSchema.optional(),
    colors: z.array(z.string()).optional(),
    quality: qualitySchema.optional(),
    feather: z.number().min(0).optional(),
    expand: z.number().optional(),
    invert: z.boolean().optional(),
  }),
  run(input, rt) {
    const t = requireTracker(rt.doc(), input.tracker);
    rt.write("Update track", (d) => {
      const live = d.trackers.find((x) => x.id === t.id);
      if (!live) return;
      if (input.name) live.name = input.name;
      const solve = {
        ...(input.quality ? TRACK_QUALITIES[input.quality as TrackQuality] : {}),
        ...(input.channels ? { channels: input.channels } : {}),
        ...(input.method ? { method: input.method } : {}),
        ...(input.colors ? { colors: input.colors.map((color) => ({ color, tolerance: 28, softness: 14 })) } : {}),
      };
      if (Object.keys(solve).length) setTrackerSolve(d, t.id, solve);
      const region = {
        ...(input.feather != null ? { feather: input.feather } : {}),
        ...(input.expand != null ? { expand: input.expand } : {}),
        ...(input.invert != null ? { invert: input.invert } : {}),
      };
      if (Object.keys(region).length) setTrackerRegion(d, t.id, region);
    });
    return summary(rt.doc(), requireTracker(rt.doc(), t.id));
  },
});

export const trackFollow = defineCommand({
  id: "track.follow",
  summary: "Make a layer ride a tracker (stick text or a sticker to a moving thing), stabilise footage, or stop.",
  details:
    "The layer keeps its place at `atMs` and moves with the tracker from there (snap: true puts it ON the point). channels: position, scale, rotation, skew; perspective pins the layer onto a tracked surface (corner pin — the tracker must solve perspective). stabilize: true on the FOOTAGE layer with its own tracker counter-moves the plate. tracker: null stops following. bake: true turns the follow into ordinary keyframes. For anything else (opacity from confidence, a value from two trackers) use an expression: track(\"Name\").position.",
  effect: "write",
  input: z.object({
    layer: z.string(),
    tracker: z.string().nullable(),
    atMs: z.number().min(0).optional().describe("The instant the layer keeps its place at; default its start."),
    channels: z.array(trackChannelSchema).default(["position"]),
    offset: z.object({ x: z.number(), y: z.number() }).optional(),
    smooth: z.number().min(0).max(1).default(0),
    snap: z.boolean().default(false),
    stabilize: z.boolean().default(false),
    bake: z.boolean().default(false),
  }),
  run(input, rt) {
    const doc = rt.doc();
    const clip = requireClip(doc, input.layer).clip;
    if (!isVisualClip(clip)) throw new ApiError("Only a visual layer can follow a tracker.");
    if (input.bake) {
      if (!clip.trackBinding) throw new ApiError("That layer is not following anything.");
      rt.write("Bake follow", (d) => void flattenTrackBinding(d, clip.id));
      return { baked: true };
    }
    if (input.tracker === null) {
      rt.write("Stop following", (d) => unbindClip(d, clip.id));
      return { following: null };
    }
    const t = requireTracker(doc, input.tracker);
    if (t.kind === "region" && input.channels.includes("perspective") && !t.solve.channels.includes("perspective"))
      throw new ApiError("That tracker does not solve perspective.", 'track.update it with channels including "skew" and "perspective", re-run track.analyze, then pin.');
    rt.write(input.stabilize ? "Stabilize" : "Follow track", (d) => {
      followTracker(d, clip.id, t.id, input.atMs ?? clip.startMs, {
        channels: input.channels,
        offset: input.offset,
        smooth: input.smooth,
        invert: input.stabilize,
        snap: input.snap,
      });
    });
    return { following: t.id, channels: input.channels };
  },
});

const compPoint = z.object({ x: z.number(), y: z.number() });

export const trackScene = defineCommand({
  id: "track.scene",
  summary: "Turn a solved camera into a 3D world over the footage; set its floor, origin and scale; stand text in the shot.",
  details:
    "Points are COMP positions at `atMs` (what view.render shows there), each snapped to the nearest solved feature — report says how far (missPx; over ~20 means nothing solved was there). ground: 3+ points on the floor (it levels the world and catches shadows). origin: one point that becomes (0,0,0). scale: two points and the real distance between them in cm. text: words standing on the points (3+ lie on their surface, 1–2 face the camera). Makes the world on first use (the footage becomes its backplate, nested where it was); later calls reuse it. Add more with layer.create in the returned world; check with view.render on the comp.",
  effect: "write",
  input: z.object({
    tracker: z.string().describe("A solved camera tracker."),
    atMs: z.number().min(0).optional().describe("Comp time the points are read at; default where the footage starts."),
    ground: z.array(compPoint).min(3).optional(),
    origin: compPoint.optional(),
    scale: z.object({ from: compPoint, to: compPoint, cm: z.number().positive() }).optional(),
    text: z.object({ text: z.string().min(1), at: z.array(compPoint).min(1) }).optional(),
  }),
  run(input, rt) {
    const doc = rt.doc();
    const t = requireTracker(doc, input.tracker);
    if (t.kind !== "camera") throw new ApiError("track.scene needs a camera tracker.", 'track.create {kind: "camera"} on the footage, then track.analyze.');
    if (!t.solution) throw new ApiError("The camera is not solved yet.", "track.analyze it first.");
    const where = firstShown(doc, t);
    if (!where) throw new ApiError("The footage is not in any comp.");
    const atMs = input.atMs ?? where.compMs;
    // Every pick is resolved on the plate BEFORE the scene moves the footage into a world.
    const snap = (pts: Array<{ x: number; y: number }>) => solvedPointsNear(doc, t.id, where.compId, atMs, pts);
    const ground = input.ground ? snap(input.ground) : null;
    const [origin] = input.origin ? snap([input.origin]) : [null];
    const scale = input.scale ? snap([input.scale.from, input.scale.to]) : null;
    const text = input.text ? snap(input.text.at) : null;
    const missing = [ground, origin ? [origin] : null, scale, text].some((g) => g?.some((p) => !p));
    if (missing) throw new ApiError("No solved points are on the plate there.", "Pick positions inside the footage at a time it is on screen.");
    const idx = (ps: Array<{ index: number } | null> | null) => (ps ?? []).map((p) => p!.index);
    let groundRms: number | null = null;
    let made: ReturnType<typeof makeCameraScene> = null;
    let textId: string | null = null;
    let worldId: string | null = worldsFollowing(doc, t.id)[0] ?? null;
    rt.write("Camera scene", (d) => {
      if (ground) {
        groundRms = setCameraGround(d, t.id, idx(ground));
        if (groundRms !== null) catchShadowsOnGround(d, t.id);
      }
      if (origin) setCameraOrigin(d, t.id, origin.index);
      if (scale) setCameraScale(d, t.id, scale[0]!.index, scale[1]!.index, input.scale!.cm);
      if (!worldId) {
        made = makeCameraScene(d, t.id);
        worldId = (made as ReturnType<typeof makeCameraScene>)?.worldId ?? null;
      }
      if (text && worldId) {
        // The world keeps its own clock: it starts where the footage did.
        const host = d.tracks.flatMap((x) => x.clips).find((c) => c.kind === "nested" && c.sourceFrameId === worldId);
        textId = placeTextOnSolvedPoints(d, t.id, worldId, idx(text), Math.max(0, atMs - (host?.startMs ?? 0)), input.text!.text);
      }
    });
    if (!worldId) throw new ApiError("Could not build the scene.", "A camera solve makes a world from video footage.");
    const miss = (ps: Array<{ missPx: number } | null> | null) => (ps ? ps.map((p) => Math.round(p!.missPx)) : undefined);
    if (ground && groundRms === null) throw new ApiError("Those ground points do not span a floor.", "Pick three or more points spread across the floor, not in a line.");
    return {
      world: worldId,
      layer: (made as ReturnType<typeof makeCameraScene>)?.nestedId ?? null,
      groundFitCm: groundRms === null ? undefined : Math.round((groundRms as number) * 10) / 10,
      missPx: { ground: miss(ground), origin: miss(origin ? [origin] : null), scale: miss(scale), text: miss(text) },
      text: textId,
      next: "view.render the comp to check it sits in the shot.",
    };
  },
});

export const trackRemove = defineCommand({
  id: "track.remove",
  summary: "Delete a tracker; its followers stop following and grade windows drawn from it go away.",
  effect: "write",
  input: z.object({ tracker: z.string().describe("Tracker id or name.") }),
  run(input, rt) {
    const t = requireTracker(rt.doc(), input.tracker);
    rt.write("Delete track", (d) => removeTracker(d, t.id));
    return { removed: t.id };
  },
});

export const TRACK_COMMANDS = [trackCreate, trackInspect, trackCorrect, trackUpdate, trackFollow, trackScene, trackRemove];
