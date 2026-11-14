import { describe, expect, it } from "vitest";
import type { MotionDocument, RegionTracker, TrackSample } from "../schema";
import { createEmptyDocument, createShapeClip, createVideoClip } from "../factories";
import { parseDocument } from "../io";
import { resolvedDocAt } from "../evaluate/resolved-doc";
import { lumaFromRgba, type AnalysisFrame, type FrameProvider } from "./engine";
import {
  applyHomography,
  homographyFromQuads,
  invertHomography,
  multiplyHomography,
  poseFromHomography,
  poseHomography,
  posePoint,
  unposePoint,
  type Homography,
  type RegionPose,
} from "./pose";
import { regionFromShape, toSubpaths } from "./contour";
import { createTracker, commitTrackerRun, bindClipToTracker } from "./ops";
import { planRun, runTracker, type RunScope } from "./run";
import { readTrack, trackContour } from "./read";
import { createTrackerAt } from "./ops";
import { trackerConsumers } from "./usage";
import { trackStrip } from "./strip";
import { fxToken } from "../schema";
import { linkPropertyToTrack } from "./expressions";
import { pickAccepts, pickCandidates, resolvePick } from "../query/pick";
import "./pick";

// ── Synthetic footage with known ground truth ────────────────────────────────

function hash(x: number, y: number, seed = 0): number {
  const t = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return t - Math.floor(t);
}

/** A non-repeating texture: smooth value noise plus a random dot per cell — corners everywhere, no period to alias on. */
function texture(u: number, v: number): number {
  const cell = 10;
  const cx = Math.floor(u / cell);
  const cy = Math.floor(v / cell);
  const fx = u / cell - cx;
  const fy = v / cell - cy;
  const s = (t: number) => t * t * (3 - 2 * t);
  const n00 = hash(cx, cy), n10 = hash(cx + 1, cy), n01 = hash(cx, cy + 1), n11 = hash(cx + 1, cy + 1);
  const noise = n00 + (n10 - n00) * s(fx) + (n01 - n00) * s(fy) + (n00 - n10 - n01 + n11) * s(fx) * s(fy);
  const dx = fx - (0.25 + 0.5 * hash(cx, cy, 1));
  const dy = fy - (0.25 + 0.5 * hash(cx, cy, 2));
  const dot = dx * dx + dy * dy < 0.04 ? (hash(cx, cy, 3) > 0.5 ? 90 : -90) : 0;
  return Math.max(0, Math.min(255, 60 + noise * 130 + dot));
}

const W = 320;
const H = 240;

/**
 * Render the textured plane through `G` (texture coords → frame px). With
 * `object`, only a 130×100 card at the centre is textured and the rest is black
 * — an icon on a plain background, the case where a subject can leave.
 */
function render(G: Homography, object = false): AnalysisFrame {
  const inv = invertHomography(G)!;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = applyHomography(inv, { x: x + 0.5, y: y + 0.5 });
      const l = object && (Math.abs(u.x - W / 2) > 65 || Math.abs(u.y - H / 2) > 50) ? 0 : texture(u.x, u.y);
      const i = (y * W + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = l;
      rgba[i + 3] = 255;
    }
  return { width: W, height: H, luma: lumaFromRgba(rgba, W, H) };
}

/** A 30 fps provider over `frames` frames whose motion is `motion(i)`. */
function provider(frames: number, motion: (i: number) => Homography, object = false): FrameProvider & { decodes: number } {
  const times = Array.from({ length: frames }, (_, i) => Math.round((i * 1000) / 30));
  const cache = new Map<number, AnalysisFrame>();
  const p = {
    sourceWidth: W,
    sourceHeight: H,
    scale: 1,
    times,
    still: false,
    decodes: 0,
    async getFrame(ms: number) {
      const i = times.indexOf(ms);
      let f = cache.get(i);
      if (!f) {
        p.decodes++;
        f = render(motion(i), object);
        cache.set(i, f);
      }
      return f;
    },
  };
  return p;
}

function trackerOn(doc: MotionDocument, channels: RegionTracker["solve"]["channels"], extra: Partial<RegionTracker["solve"]> = {}): RegionTracker {
  const t = createTracker(doc, {
    source: { kind: "asset", assetId: "plate" },
    region: { shape: "rect", subpaths: toSubpaths(regionFromShape("rect", 110, 80)), feather: 0, expand: 0, invert: false },
    referenceMs: 0,
    solve: { method: "features", channels, accuracy: 0.6, cadence: { mode: "every", maxStride: 4, doubtPx: 0.75 }, ...extra },
  }) as RegionTracker;
  t.samples = [sample(0, W / 2, H / 2)];
  return t;
}

function sample(timeMs: number, x: number, y: number): TrackSample {
  return { timeMs, x, y, scale: 1, scaleY: null, rotation: 0, skew: 0, perspective: null, warp: null, confidence: 1, pinned: ["position"] };
}

/** Region corners (region-local) — what a corner pin reads. */
const CORNERS = [
  { x: -55, y: -40 },
  { x: 55, y: -40 },
  { x: 55, y: 40 },
  { x: -55, y: 40 },
];

/** Worst corner error over a run, against the ground-truth plane motion. */
function worstCornerError(samples: TrackSample[], times: number[], motion: (i: number) => Homography): number {
  const G0inv = invertHomography(motion(0))!;
  let worst = 0;
  for (const s of samples) {
    const i = times.indexOf(s.timeMs);
    if (i < 0) continue;
    // Rendered at pixel CENTRES (x + 0.5); the tracker measures in pixel INDICES.
    const toIndex: Homography = [1, 0, -0.5, 0, 1, -0.5, 0, 0, 1];
    const toCentre: Homography = [1, 0, 0.5, 0, 1, 0.5, 0, 0, 1];
    const truth = multiplyHomography(toIndex, multiplyHomography(multiplyHomography(motion(i), G0inv), toCentre));
    for (const c of CORNERS) {
      const want = applyHomography(truth, { x: W / 2 + c.x, y: H / 2 + c.y });
      const got = posePoint(c, { ...s, perspective: s.perspective });
      worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y));
    }
  }
  return worst;
}

function similarity(tx: number, ty: number, deg: number, k: number): Homography {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r) * k;
  const s = Math.sin(r) * k;
  // About the frame centre, then moved.
  const cx = W / 2, cy = H / 2;
  return [c, -s, cx + tx - (c * cx - s * cy), s, c, cy + ty - (s * cx + c * cy), 0, 0, 1];
}

const run = (p: FrameProvider, t: RegionTracker, scope: RunScope = { kind: "all" }) => runTracker(p, t, scope, { signal: new AbortController().signal });

// ── Pose maths ───────────────────────────────────────────────────────────────

describe("tracking pose", () => {
  it("decomposes every homography back into the pose that made it", () => {
    const poses: RegionPose[] = [
      { x: 10, y: -4, scale: 1.3, scaleY: null, rotation: 25, skew: 0, perspective: null },
      { x: 200, y: 90, scale: 0.7, scaleY: 1.1, rotation: -140, skew: 12, perspective: null },
      { x: -30, y: 55, scale: 2, scaleY: 1.5, rotation: 80, skew: -20, perspective: { x: 0.002, y: -0.0015 } },
    ];
    for (const p of poses) {
      const back = poseFromHomography(poseHomography(p))!;
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
      expect(back.scale).toBeCloseTo(p.scale, 6);
      expect(back.scaleY ?? back.scale).toBeCloseTo(p.scaleY ?? p.scale, 6);
      expect(back.rotation).toBeCloseTo(p.rotation, 6);
      expect(back.skew ?? 0).toBeCloseTo(p.skew ?? 0, 6);
      expect(back.perspective?.x ?? 0).toBeCloseTo(p.perspective?.x ?? 0, 9);
      // And the point maps agree, both ways.
      const q = posePoint({ x: 7, y: -3 }, p);
      expect(applyHomography(poseHomography(p), { x: 7, y: -3 }).x).toBeCloseTo(q.x, 6);
      const u = unposePoint(q, p);
      expect(u.x).toBeCloseTo(7, 6);
      expect(u.y).toBeCloseTo(-3, 6);
    }
  });

  it("solves the homography between two quads (a corner pin)", () => {
    const from = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
    const to = [{ x: 10, y: 5 }, { x: 120, y: 20 }, { x: 105, y: 90 }, { x: 2, y: 60 }];
    const Hq = homographyFromQuads(from, to)!;
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(Hq, from[i]!);
      expect(p.x).toBeCloseTo(to[i]!.x, 6);
      expect(p.y).toBeCloseTo(to[i]!.y, 6);
    }
  });
});

// ── The solve against ground truth ───────────────────────────────────────────

describe("tracking solve (synthetic ground truth)", () => {
  it("follows translation + rotation + zoom, and does not drift over a long shot", async () => {
    const doc = createEmptyDocument();
    // 48 frames: 25° of turn and 20% of zoom. Frame-to-frame alone drifts by ~0.01 px a frame;
    // measured against the warped keyframe the error stays flat.
    const motion = (i: number) => similarity(i * 1.4, i * -0.7, i * 0.52, 1 + i * 0.004);
    const p = provider(48, motion);
    const t = trackerOn(doc, ["position", "scale", "rotation"]);
    const res = await run(p, t);
    expect(res.samples.length).toBe(47);
    expect(worstCornerError(res.samples, p.times, motion)).toBeLessThan(0.12);
    expect(res.solved).toEqual([[0, p.times[47]]]);
  });

  it("solves a plane going away in perspective (homography channels)", async () => {
    const doc = createEmptyDocument();
    const motion = (i: number): Homography => {
      const base = similarity(i * 1.5, i * 0.8, i * 0.3, 1);
      const g = i * 0.00002;
      const persp: Homography = [1, 0, 0, 0, 1, 0, g, -g * 0.5, 1];
      // Perspective about the frame centre.
      const c: Homography = [1, 0, -W / 2, 0, 1, -H / 2, 0, 0, 1];
      const ci: Homography = [1, 0, W / 2, 0, 1, H / 2, 0, 0, 1];
      return multiplyHomography(base, multiplyHomography(ci, multiplyHomography(persp, c)));
    };
    const p = provider(20, motion);
    const t = trackerOn(doc, ["position", "scale", "rotation", "skew", "perspective"]);
    const res = await run(p, t);
    expect(worstCornerError(res.samples, p.times, motion)).toBeLessThan(0.2);
    expect(res.samples.at(-1)!.perspective).not.toBeNull();
  });

  it("auto cadence strides over calm motion and stays accurate", async () => {
    const doc = createEmptyDocument();
    const motion = (i: number) => similarity(i * 0.6, i * 0.3, 0, 1);
    const every = provider(32, motion);
    const strided = provider(32, motion);
    const resEvery = await run(every, trackerOn(doc, ["position"]));
    const resAuto = await run(strided, trackerOn(doc, ["position"], { cadence: { mode: "auto", maxStride: 4, doubtPx: 0.75 } }));
    expect(resAuto.stats.measured).toBeLessThan(resEvery.stats.measured * 0.6);
    expect(strided.decodes).toBeLessThan(every.decodes);
    expect(worstCornerError(resAuto.samples, strided.times, motion)).toBeLessThan(0.1);
    expect(resAuto.solved).toEqual(resEvery.solved);
  });

  it("pattern (luma) matching follows a moving patch to within a pixel, quickly", async () => {
    const doc = createEmptyDocument();
    const motion = (i: number) => similarity(i * 2.5, i * -1.5, 0, 1);
    const p = provider(24, motion);
    const t = trackerOn(doc, ["position"], { method: "luma" });
    for (const ms of p.times) await p.getFrame(ms); // time the matching, not the synthetic renders
    const started = performance.now();
    const r = await run(p, t);
    expect(r.stats.method).toBe("luma");
    expect(worstCornerError(r.samples, p.times, motion)).toBeLessThan(1);
    // Was ~1 s a frame on a 1080p plate: a brute-force grid that re-posed
    // every cell for every candidate.
    expect((performance.now() - started) / p.times.length).toBeLessThan(60);
  });

  it("a subject leaving the frame holds at the edge — it never runs away", async () => {
    const doc = createEmptyDocument();
    // A card on black, 14 px a frame to the left: out of a 320 px frame by ~frame 19.
    const motion = (i: number) => similarity(-14 * i, 0, 0, 1);
    const p = provider(30, motion, true);
    const t = trackerOn(doc, ["position", "scale", "rotation"], { cadence: { mode: "auto", maxStride: 4, doubtPx: 0.75 } });
    const r = await run(p, t);
    const xs = r.samples.map((x) => x.x);
    expect(Math.min(...xs)).toBeGreaterThan(-110);
    for (const x of r.samples) expect(x.scale).toBeGreaterThan(0.6);
    // Once it is gone, the frames say so: they are held, at confidence 0.
    expect(r.samples[r.samples.length - 1]!.confidence).toBe(0);
  });

  it("stopping keeps everything solved so far, and resume solves only the rest", async () => {
    const doc = createEmptyDocument();
    const motion = (i: number) => similarity(i * 1.5, 0, 0, 1);
    const p = provider(20, motion);
    const t = trackerOn(doc, ["position"]);
    const ctl = new AbortController();
    let seen = 0;
    const first = await runTracker(p, t, { kind: "all" }, { signal: ctl.signal }, () => {
      if (++seen === 6) ctl.abort();
    });
    expect(first.stopped).toBe(true);
    expect(first.samples.length).toBe(6);
    doc.trackers = [t];
    commitTrackerRun(doc, t.id, first.samples, first.solved);
    const segments = planRun(t, p.times, { kind: "all" });
    expect(segments.reduce((n, s) => n + s.times.length, 0)).toBe(19 - 6);
    const second = await run(p, t);
    expect(second.samples.length).toBe(13);
    commitTrackerRun(doc, t.id, second.samples, second.solved);
    expect(t.analysis!.coverage).toEqual([[0, p.times[19]]]);
    expect(worstCornerError(t.samples, p.times, motion)).toBeLessThan(0.12);
  });

  it("a run through a correction covers the corrected frame — no hole at the anchor", async () => {
    const doc = createEmptyDocument();
    const motion = (i: number) => similarity(i * 1.5, 0, 0, 1);
    const p = provider(12, motion);
    const t = trackerOn(doc, ["position"]);
    // A hand fix at frame 6, exactly where the plane is.
    t.samples.push({ ...sample(p.times[6]!, W / 2 + 9, H / 2), pinned: ["position"] });
    doc.trackers = [t];
    const r = await run(p, t);
    commitTrackerRun(doc, t.id, r.samples, r.solved);
    expect(t.analysis!.coverage).toEqual([[0, p.times[11]]]);
  });

  it("a correction re-solves exactly its neighbourhood and lands on it", () => {
    const doc = createEmptyDocument();
    const t = trackerOn(doc, ["position"]);
    const times = Array.from({ length: 10 }, (_, i) => i * 100);
    t.samples.push({ ...sample(500, 10, 10), pinned: ["position"] }, { ...sample(900, 20, 20), pinned: ["position"] });
    const segs = planRun(t, times, { kind: "around", ms: 500 });
    expect(segs.map((s) => [s.seed.timeMs, s.times, s.target?.timeMs ?? null])).toEqual([
      [0, [100, 200, 300, 400], 500],
      [500, [600, 700, 800], 900],
    ]);
  });

  it("forward from the playhead leaves the past alone", () => {
    const doc = createEmptyDocument();
    const t = trackerOn(doc, ["position"]);
    t.referenceMs = 0;
    const times = Array.from({ length: 10 }, (_, i) => i * 100);
    const segs = planRun(t, times, { kind: "forward", fromMs: 400 });
    expect(segs).toHaveLength(1);
    expect(segs[0]!.seed.timeMs).toBe(400);
    expect(segs[0]!.times).toEqual([500, 600, 700, 800, 900]);
  });
});

// ── The document: footage-owned trackers, the reader and the follow ──────────

function plateDoc(): { doc: MotionDocument; frameId: string; plateId: string } {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  doc.assets.push({ id: "plate", kind: "video", name: "plate.mp4", mime: "video/mp4", bytes: 1, width: 400, height: 200, durationMs: 10000, fps: 30, folderId: null, origin: null });
  const plate = createVideoClip({ frameId, assetId: "plate", startMs: 1000, durationMs: 4000 });
  plate.trimInMs = 2000;
  plate.transform.x = 50;
  plate.transform.scale = 0.5;
  doc.tracks[0]!.clips.push(plate);
  return { doc, frameId, plateId: plate.id };
}

describe("trackers belong to footage", () => {
  it("reads through the viewing clip's time map and placement", () => {
    const { doc, frameId, plateId } = plateDoc();
    const t = createTracker(doc, {
      source: { kind: "asset", assetId: "plate" },
      via: plateId,
      region: { shape: "rect", subpaths: toSubpaths(regionFromShape("rect", 20, 20)), feather: 0, expand: 0, invert: false },
      referenceMs: 2000,
    });
    // Source time 2000 → the source centre; 3000 → 40 px right of it.
    t.samples = [sample(2000, 200, 100), { ...sample(3000, 240, 100), pinned: [] }];
    // Comp 1000 shows source 2000 (trim 2000, starts at 1000): the plate's centre, at x=50.
    expect(readTrack(doc, t, "position", { compId: frameId, compMs: 1000 })).toEqual({ x: 50, y: 0 });
    // Comp 2000 shows source 3000: 40 source px at 0.5 scale = 20 comp px.
    const p = readTrack(doc, t, "position", { compId: frameId, compMs: 2000 }) as { x: number; y: number };
    expect(p.x).toBeCloseTo(70, 6);
    // Outside the clip there is nothing to say.
    expect(readTrack(doc, t, "position", { compId: frameId, compMs: 6000 })).toBeNull();
  });

  it("is pickable, and a pick-whip onto a reading is a rename-proof expression", () => {
    const { doc, frameId, plateId } = plateDoc();
    const t = createTracker(doc, {
      source: { kind: "asset", assetId: "plate" },
      via: plateId,
      region: { shape: "rect", subpaths: toSubpaths(regionFromShape("rect", 20, 20)), feather: 0, expand: 0, invert: false },
      referenceMs: 2000,
    });
    t.samples = [sample(2000, 200, 100), { ...sample(3000, 240, 100), pinned: [] }];
    const label = createShapeClip({ frameId, startMs: 0, durationMs: 6000, shape: "rect", width: 10, height: 10 });
    doc.tracks[0]!.clips.push(label);

    expect(resolvePick(doc, `tracker:${t.id}`)?.name).toBe(t.name);
    expect(pickAccepts(doc, { kinds: ["tracker"], frameId }, `tracker:${t.id}`)).toBe(true);
    expect(pickAccepts(doc, { kinds: ["tracker"], frameId: "elsewhere" }, `tracker:${t.id}`)).toBe(false);
    // Readings are typed values, filtered by the field's own assignability rule.
    const rows = pickCandidates(doc, { kinds: ["track-reading"], fits: "float", predicate: (c) => c.ownerId === t.id });
    expect(rows.find((c) => c.path === "x")?.type).toBe("float");
    expect(resolvePick(doc, `track-reading:${t.id}/topLeft`)?.type).toBe("vec2");

    linkPropertyToTrack(doc, label.id, "x", t.id, "x");
    t.name = "Renamed";
    const moved = resolvedDocAt(doc, 2000, frameId).tracks[0]!.clips.find((c) => c.id === label.id);
    if (moved?.kind !== "shape") throw new Error("label missing");
    expect(moved.transform.x).toBeCloseTo(70, 6);
  });

  it("a traced outline is tracked exactly as drawn, through the plate's placement", () => {
    const { doc, frameId, plateId } = plateDoc();
    const tri = [{ x: -20, y: -10 }, { x: 30, y: 0 }, { x: -10, y: 25 }];
    const t = createTrackerAt(doc, {
      clipId: plateId,
      compMs: 1000,
      region: { shape: "polygon", x: 60, y: 5, width: 50, height: 35, contours: [{ closed: true, points: tri.map((p) => ({ ...p, hIn: null, hOut: null })) }] },
    })!;
    const back = trackContour(doc, t, { compId: frameId, compMs: 1000 })![0]!.points;
    tri.forEach((p, i) => {
      expect(back[i]!.x).toBeCloseTo(60 + p.x, 6);
      expect(back[i]!.y).toBeCloseTo(5 + p.y, 6);
    });
  });

  it("draws its coverage along the clip bar through the clip's time map", () => {
    const { doc, plateId } = plateDoc();
    const t = createTrackerAt(doc, { clipId: plateId, compMs: 1000, region: { shape: "rect", x: 0, y: 0, width: 20, height: 20 } })!;
    // Solved source 2000–3000 = the first quarter of the bar (trim 2000, 4 s long).
    t.samples.push({ ...sample(3000, 220, 100), pinned: [] });
    t.analysis = { version: 0, engine: "cpu", coverage: [[2000, 3000]], at: 0 };
    const clip = doc.tracks[0]!.clips.find((c) => c.id === plateId)!;
    const runs = trackStrip(doc, t, clip, 40);
    expect(runs[0]).toMatchObject({ state: "anchor", from: 0 });
    expect(runs[1]!.state).toBe("solved");
    expect(runs[1]!.to).toBeCloseTo(0.25, 6);
    expect(runs[2]).toMatchObject({ state: "none", to: 1 });
  });

  it("names every reader of a tracker: follow, expression, node", () => {
    const { doc, frameId, plateId } = plateDoc();
    const t = createTrackerAt(doc, { clipId: plateId, compMs: 1000, region: { shape: "rect", x: 0, y: 0, width: 20, height: 20 } })!;
    const a = createShapeClip({ frameId, startMs: 0, durationMs: 6000, shape: "rect", width: 10, height: 10 });
    const b = createShapeClip({ frameId, startMs: 0, durationMs: 6000, shape: "rect", width: 10, height: 10 });
    doc.tracks[0]!.clips.push(a, b);
    bindClipToTracker(doc, a.id, t.id);
    doc.expressions.push({ id: "e1", source: `track("${t.name}").rotation * 2`, name: "" });
    b.drivers = { rotation: fxToken("e1") };
    doc.graphs.push({ id: "g", name: "G", kind: "board", ownerId: null, nodes: [{ id: "n", type: "track.read", x: 0, y: 0, params: { tracker: t.id } } as never], edges: [], groups: [], view: null });
    expect(trackerConsumers(doc, t.id).map((c) => c.kind).sort()).toEqual(["expression", "follow", "node"]);
  });

  it("a follower is moved in the RESOLVED document, so every reader sees it", () => {
    const { doc, frameId, plateId } = plateDoc();
    const t = createTracker(doc, {
      source: { kind: "asset", assetId: "plate" },
      via: plateId,
      region: { shape: "rect", subpaths: toSubpaths(regionFromShape("rect", 20, 20)), feather: 0, expand: 0, invert: false },
      referenceMs: 2000,
    });
    t.samples = [sample(2000, 200, 100), { ...sample(3000, 240, 120), pinned: [] }];
    const sticker = createShapeClip({ frameId, startMs: 0, durationMs: 6000, shape: "rect", width: 10, height: 10 });
    doc.tracks[0]!.clips.push(sticker);
    bindClipToTracker(doc, sticker.id, t.id, { channels: ["position"], offset: { x: 0, y: -15 } });
    const at = resolvedDocAt(doc, 2000, frameId);
    const moved = at.tracks[0]!.clips.find((c) => c.id === sticker.id);
    if (moved?.kind !== "shape") throw new Error("sticker missing");
    expect(moved.transform.x).toBeCloseTo(70, 6);
    expect(moved.transform.y).toBeCloseTo(10 - 15, 6);
    // The stored document is untouched.
    expect(sticker.transform.x).toBe(0);
  });

  it("migrates v100 trackers to source time through trim and speed", () => {
    const { doc, plateId } = plateDoc();
    const plate = doc.tracks[0]!.clips.find((c) => c.id === plateId)!;
    (plate as { playback: { speed: number } }).playback.speed = 2;
    const raw = JSON.parse(JSON.stringify({ ...doc, version: 100 })) as Record<string, unknown>;
    raw.trackers = [
      {
        id: "tracker_old",
        name: "Old",
        sourceClipId: plateId,
        region: { shape: "rect", subpaths: toSubpaths(regionFromShape("rect", 20, 20)) },
        samples: [{ timeMs: 0, x: 1, y: 1 }, { timeMs: 500, x: 2, y: 2 }],
        referenceMs: 500,
        analysis: { version: 1, engine: "cpu", fromMs: 0, toMs: 500, at: 1 },
      },
    ];
    const migrated = parseDocument(JSON.stringify(raw));
    const t = migrated.trackers[0]!;
    if (t.kind !== "region") throw new Error("a v100 tracker migrates to a region tracker");
    expect(t.source).toEqual({ kind: "asset", assetId: "plate" });
    expect(t.via).toBe(plateId);
    expect(t.samples.map((s) => s.timeMs)).toEqual([2000, 3000]);
    expect(t.referenceMs).toBe(3000);
    expect(t.analysis!.coverage).toEqual([[2000, 3000]]);
  });
});
