import {
  addClipToTrack,
  apply,
  clearTrackerSamples,
  commitTrackerRun,
  compRenderTimeMs,
  compToSource,
  createAdjustmentClip,
  createCarrierTrack,
  createId,
  createTextClip,
  createTrackerAt,
  TRACK_QUALITIES,
  updateClipBinding,
  findVisualClip,
  clipLocalTimeAtSource,
  flattenTrackBinding,
  footageAt,
  footageClips,
  footageMatrix,
  footageTimeAt,
  followTracker,
  pinTrackSample,
  removeTracker,
  setTrackerReference,
  setTrackerRegion,
  setTrackerSolve,
  unbindClip,
  unpinTrackSample,
  regionFromShape,
  resampleContour,
  toSubpaths,
  entityRef,
  isTaskAborted,
  supervise,
  type MotionDocument,
  type DocumentStore,
  type FootageView,
  type LayerEffect,
  type AnalysisJob,
  type CameraRunResult,
  commitCameraSolve,
  commitDepthRun,
  type RunScope,
  type TrackChannel,
  type TrackSample,
  type TrackShape,
  type TrackSolve,
  type TrackBinding,
  type TrackQuality,
  type TrackRegion,
  type Tracker,
  type VisualClip,
} from "@solomotion/core";
import { useSession } from "../state/session";
import { useTrackRuns } from "./track-runs";
import { toast } from "@/lib/toast";
import { analyze } from "./analysis-client";
import { saveDepthRun } from "./depth-store";
import { abortSignalFor } from "../runtime/abort-bridge";

/**
 * Store-integrated tracking actions — each one composes the core ops into a
 * single labelled update, so "Track object", "Attach", "Re-solve" and "Bake" are
 * each ONE undo step. Analysis runs async between two updates.
 *
 * What creating a track NO LONGER does, and it is the whole point of v77: it
 * does not make a shape clip, does not claim a lane, does not touch the
 * timeline. A tracker owns its own region. "Cancel" is therefore just "delete
 * the tracker" and there is nothing left behind to find and remove by hand.
 */

/**
 * The clip a tracker is seen through for editing — the one it was drawn on, or
 * any clip still showing its footage. Null when the footage left the project.
 */
export function trackedClipOf(doc: MotionDocument, tracker: Tracker): VisualClip | null {
  const all = footageClips(doc, tracker);
  return all.find((c) => c.id === tracker.via) ?? all[0] ?? null;
}

/** The footage's SOURCE time on screen at a comp-time playhead (through the clip's time map). */
export function sourceMsFor(doc: MotionDocument, clip: VisualClip, compMs: number): number {
  return footageTimeAt(doc, clip, compMs) ?? 0;
}

/** Where a tracker's footage is on screen at a comp instant — the overlay's and the gestures' map. */
export function trackViewAt(doc: MotionDocument, tracker: Tracker, compMs: number): FootageView | null {
  const clip = trackedClipOf(doc, tracker);
  return clip ? footageAt(doc, tracker, clip.frameId, compMs) : null;
}

/**
 * Create a track on a clip, with the region centred where the user is looking
 * and the reference set to the frame they are paused on.
 *
 * Both of those are the v77 fix in one line each: the region belongs to the
 * tracker rather than to a lane, and the frame you can see is the frame the
 * template is lifted from.
 */
export function createTrack(
  store: DocumentStore,
  sourceClipId: string,
  shape: TrackShape,
  compMs: number,
  solve?: Partial<TrackSolve>,
): string | null {
  const doc = store.getState();
  const source = findVisualClip(doc, sourceClipId);
  if (!source || (source.kind !== "video" && source.kind !== "image")) return null;
  // Centred on the footage as it sits on screen, a quarter of its size.
  const asset = doc.assets.find((a) => a.id === source.assetId);
  const w = asset?.width ?? 640;
  const h = asset?.height ?? 360;
  const M = footageMatrix(doc, source, compMs);
  const centre = apply(M, { x: w / 2, y: h / 2 });
  const k = Math.sqrt(Math.abs(M.a * M.d - M.b * M.c)) || 1;
  let trackerId = "";
  store.update("Track object", (d) => {
    const tracker = createTrackerAt(d, {
      clipId: sourceClipId,
      compMs,
      region: { shape, x: centre.x, y: centre.y, width: (w * k) / 4, height: (h * k) / 4, rotation: (Math.atan2(M.b, M.a) * 180) / Math.PI },
      solve,
    });
    trackerId = tracker?.id ?? "";
  });
  if (trackerId) useSession.getState().setActiveTracker(trackerId);
  return trackerId || null;
}

/** Swap the region's shape, keeping its size (rect ⇄ ellipse ⇄ polygon ⇄ path). */
export function setTrackShape(store: DocumentStore, trackerId: string, shape: TrackShape): void {
  store.update("Track shape", (d) => {
    const t = d.trackers.find((x) => x.id === trackerId);
    if (t?.kind !== "region") return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const sub of t.region.subpaths) {
      for (const p of sub.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    const w = Number.isFinite(minX) ? maxX - minX : 120;
    const h = Number.isFinite(minY) ? maxY - minY : 120;
    setTrackerRegion(d, trackerId, { shape, subpaths: toSubpaths(regionFromShape(shape, w, h)) });
  });
}

/**
 * Change how many vertices the outline has, re-derived from the CURVE rather
 * than from the previous vertex list — so raising detail on a four-point
 * rectangle gives a twenty-point outline of the same rectangle, and lowering it
 * again gives the rectangle back.
 */
export function setTrackDetail(store: DocumentStore, trackerId: string, detail: number): void {
  store.update(
    "Track detail",
    (d) => {
      const t = d.trackers.find((x) => x.id === trackerId);
      if (t?.kind !== "region") return;
      setTrackerSolve(d, trackerId, { detail });
      const resampled = t.region.subpaths.map((sub) => ({ ...sub, ...resampleContour(sub, detail) }));
      setTrackerRegion(d, trackerId, { subpaths: resampled, shape: "path" });
    },
    { mergeKey: `track-detail-${trackerId}` },
  );
}

/** Toggle a solved channel (scale, rotation, shape). */
export function setTrackChannel(store: DocumentStore, trackerId: string, channel: TrackChannel, on: boolean): void {
  store.update("Track solve", (d) => {
    const t = d.trackers.find((x) => x.id === trackerId);
    if (t?.kind !== "region") return;
    const next = on
      ? [...new Set([...t.solve.channels, channel])]
      : t.solve.channels.filter((c) => c !== channel);
    setTrackerSolve(d, trackerId, { channels: next.length ? next : ["position"] });
  });
}

/** Switch matching method, seeding the colour list on first use. */
export function setTrackMethod(store: DocumentStore, trackerId: string, method: TrackSolve["method"], seedColor?: string): void {
  store.update("Track method", (d) => {
    const t = d.trackers.find((x) => x.id === trackerId);
    if (t?.kind !== "region") return;
    const colors = method === "color" && t.solve.colors.length === 0 && seedColor
      ? [{ color: seedColor, tolerance: 26, softness: 14 }]
      : t.solve.colors;
    setTrackerSolve(d, trackerId, { method, colors });
  });
}

export function addTrackColor(store: DocumentStore, trackerId: string, color: string): void {
  store.update("Add track colour", (d) => {
    const t = d.trackers.find((x) => x.id === trackerId);
    if (t?.kind === "region") setTrackerSolve(d, trackerId, { colors: [...t.solve.colors, { color, tolerance: 26, softness: 14 }] });
  });
}

export function removeTrackColor(store: DocumentStore, trackerId: string, index: number): void {
  store.update("Remove track colour", (d) => {
    const t = d.trackers.find((x) => x.id === trackerId);
    if (t?.kind === "region" && t.solve.colors.length > 1)
      setTrackerSolve(d, trackerId, { colors: t.solve.colors.filter((_, i) => i !== index) });
  });
}

/** Re-anchor the solve to the frame the playhead is on. */
export function setTrackReferenceToPlayhead(store: DocumentStore, trackerId: string, compMs: number): void {
  const doc = store.getState();
  const tracker = doc.trackers.find((t) => t.id === trackerId);
  const clip = tracker ? trackedClipOf(doc, tracker) : null;
  if (!clip) return;
  store.update("Set reference frame", (d) => setTrackerReference(d, trackerId, sourceMsFor(d, clip, compMs)));
}

// ── Runs ─────────────────────────────────────────────────────────────────────
//
// A run belongs to the app (`track-runs.ts`), so it survives the panel that
// started it, and every surface — the transport, the canvas outline, the
// timeline strip, the activity ring — reads one store.

const controllers = new Map<string, AbortController>();
const gates = new Map<string, Array<() => void>>();

const openGates = (trackerId: string) => {
  for (const go of gates.get(trackerId) ?? []) go();
  gates.delete(trackerId);
};

/**
 * Track — solve what is missing in `scope` (default: both ways from the
 * reference). Already running: a no-op. Errors land in the status bar; a stop
 * keeps everything solved so far.
 */
export async function startTrack(
  store: DocumentStore,
  trackerId: string,
  scope: RunScope = { kind: "all" },
  opts: { quiet?: boolean; write?: CommitWriter } = {},
): Promise<{ ok: boolean; stopped?: boolean; error?: string; stats?: CameraRunResult["stats"] }> {
  if (controllers.has(trackerId)) return { ok: false, error: "Already tracking" };
  const ctrl = new AbortController();
  controllers.set(trackerId, ctrl);
  useTrackRuns.getState().set(trackerId, { scope });
  try {
    const result = await runAnalysis(store, trackerId, { signal: ctrl.signal, write: opts.write }, scope);
    if (!opts.quiet && !result.ok && result.error && result.error !== "Cancelled") toast.error(result.error);
    return result;
  } finally {
    controllers.delete(trackerId);
    gates.delete(trackerId);
    useTrackRuns.getState().end(trackerId);
  }
}

/** Stop — keep what is solved. */
export function stopTrack(trackerId: string): void {
  controllers.get(trackerId)?.abort();
  openGates(trackerId);
}

/** Hold the run at its next step. */
export function pauseTrack(trackerId: string): void {
  useTrackRuns.getState().patch(trackerId, { state: "paused" });
}

export function resumeTrack(trackerId: string): void {
  useTrackRuns.getState().patch(trackerId, { state: "running" });
  openGates(trackerId);
}

/** The run's pause state as a stream — what a worker run is told when the transport pauses it. */
function pauseWatcher(trackerId: string): (onChange: (paused: boolean) => void) => () => void {
  return (onChange) => {
    let was = useTrackRuns.getState().runs[trackerId]?.state === "paused";
    if (was) onChange(true);
    return useTrackRuns.subscribe((s) => {
      const now = s.runs[trackerId]?.state === "paused";
      if (now !== was) onChange((was = now));
    });
  };
}

function gateFor(trackerId: string): () => Promise<void> {
  return () =>
    useTrackRuns.getState().runs[trackerId]?.state === "paused"
      ? new Promise<void>((resolve) => {
          const list = gates.get(trackerId) ?? [];
          list.push(resolve);
          gates.set(trackerId, list);
        })
      : Promise.resolve();
}

/** Who commits the result — an agent's run writes through its own labelled, grouped writer. */
export type CommitWriter = (label: string, recipe: (d: MotionDocument) => void) => unknown;

export interface AnalyzeHandlers {
  signal: AbortSignal;
  write?: CommitWriter;
  onProgress?: (done: number, total: number, sample: TrackSample) => void;
}

/**
 * Solve what is missing. The plan (`core/tracking/run.ts`) decides what that
 * is: everything uncovered, forward or backward from the playhead, or the
 * neighbourhood of a correction (`around`) — so a first track, a resume after
 * a pause, "track forward from here" and a re-solve after a fix are one call.
 *
 * Stopping keeps what was solved; the whole run is ONE undo step.
 */
export async function runAnalysis(
  store: DocumentStore,
  trackerId: string,
  handlers: AnalyzeHandlers,
  scope: RunScope = { kind: "all" },
): Promise<{ ok: boolean; stopped?: boolean; error?: string; stats?: CameraRunResult["stats"] }> {
  const doc = store.getState();
  const tracker = doc.trackers.find((t) => t.id === trackerId);
  if (!tracker) return { ok: false, error: "Track not found" };
  const tracked = trackedClipOf(doc, tracker);
  if (!tracked) return { ok: false, error: "The footage is gone" };
  // Through the clip's own time map (core's one inverse: trim, speed, reverse), not an offset.
  const toComp = (sourceMs: number) => tracked.startMs + clipLocalTimeAtSource(doc, tracked, sourceMs);

  // The run is watched, not just waited for: the outline rides the footage and
  // the playhead follows it. Both at a human rate — every measured frame would
  // re-render the panel and the stage faster than anyone can see, and the
  // stage's 1080p frame is the most expensive thing in the app to redraw.
  let lastUi = 0;
  let lastPlayhead = 0;
  try {
    const outcome = await supervise(
      { kind: "tracking", label: tracker.kind === "camera" ? `Solve camera “${tracker.name}”` : tracker.kind === "depth" ? `Depth of “${tracked.name}”` : `Track “${tracker.name}”`, subject: entityRef("clip", tracked.id, tracked.name) },
      async (task) => {
        const bridge = abortSignalFor(task, handlers.signal);
        try {
          const job: AnalysisJob = tracker.kind === "camera" ? { kind: "camera", tracker } : tracker.kind === "depth" ? { kind: "depth", tracker, temporal: true } : { kind: "region", tracker, scope };
          return await analyze(store.getState(), tracker, tracked, job, { signal: bridge.signal, gate: gateFor(trackerId), watchPause: pauseWatcher(trackerId) }, (p) => {
            task.report({ progress: p.total > 0 ? p.done / p.total : undefined, note: p.note ?? `${p.done} of ${p.total} frames` });
            if (!p.sample) {
              const now = Date.now();
              if (now - lastUi > 100 || p.done === p.total) {
                lastUi = now;
                useTrackRuns.getState().patch(trackerId, { done: p.done, total: p.total, note: p.note ?? null });
              }
              return;
            }
            handlers.onProgress?.(p.done, p.total, p.sample);
            const now = Date.now();
            if (now - lastUi > 100 || p.done === p.total) {
              lastUi = now;
              useTrackRuns.getState().patch(trackerId, { done: p.done, total: p.total, live: p.sample });
            }
            if (now - lastPlayhead > 250) {
              lastPlayhead = now;
              useSession.getState().setPlayhead(toComp(p.sample.timeMs));
            }
          });
        } finally {
          bridge.dispose();
        }
      },
    );
    const write = (label: string, recipe: (d: MotionDocument) => void) => (handlers.write ? handlers.write(label, recipe) : store.update(label, recipe));
    if (outcome.kind === "camera") {
      const r = outcome.result;
      write("Solve camera", (d) => commitCameraSolve(d, trackerId, r.solution, r.solved));
      return { ok: true, stats: r.stats };
    }
    if (outcome.kind === "depth") {
      const r = outcome.result;
      // The maps go beside the document under a fresh key; the document records which.
      const key = createId("depth");
      await saveDepthRun(key, r);
      write("Depth", (d) => commitDepthRun(d, trackerId, { key, model: r.model, network: r.network, width: r.width, height: r.height, times: r.times }, r.solved));
      return { ok: true };
    }
    const result = outcome.result;
    if (result.samples.length || result.solved.length) write("Track", (d) => commitTrackerRun(d, trackerId, result.samples, result.solved, result.stats.method ?? "cpu"));
    return { ok: true, stopped: result.stopped };
  } catch (err) {
    if (isTaskAborted(err) || (err as Error).name === "AbortError") return { ok: false, error: "Cancelled" };
    return { ok: false, error: (err as Error).message };
  }
}

/** Forget every measurement (corrections kept). */
export function clearTrack(store: DocumentStore, trackerId: string): void {
  store.update("Clear track", (d) => clearTrackerSamples(d, trackerId));
}

// ── Corrections ──────────────────────────────────────────────────────────────

/**
 * Pin the region's pose at the current frame — the user dragged, resized or
 * rotated the outline back onto the object.
 *
 * `channels` says WHICH facts are theirs, so nudging the position leaves the
 * scale free for the solver to keep improving. One gesture streams these under
 * a `mergeKey` so the whole drag is one undo step.
 */
export function pinTrackAt(
  store: DocumentStore,
  trackerId: string,
  compMs: number,
  channels: TrackChannel[],
  patch: { x?: number; y?: number; scale?: number; scaleY?: number | null; rotation?: number; skew?: number; perspective?: { x: number; y: number } | null; warp?: Array<{ x: number; y: number }> | null },
  mergeKey?: string,
): void {
  const doc = store.getState();
  const tracker = doc.trackers.find((t) => t.id === trackerId);
  const tracked = tracker ? trackedClipOf(doc, tracker) : null;
  if (!tracker || !tracked) return;
  const sourceMs = sourceMsFor(doc, tracked, compMs);
  store.update(
    "Correct track",
    (d) => pinTrackSample(d, trackerId, sourceMs, channels, patch),
    mergeKey ? { mergeKey } : undefined,
  );
}

/** Drop the correction at this frame and let the solver have it back. */
export function unpinTrackAt(store: DocumentStore, trackerId: string, compMs: number, channels?: TrackChannel[]): void {
  const doc = store.getState();
  const tracker = doc.trackers.find((t) => t.id === trackerId);
  const tracked = tracker ? trackedClipOf(doc, tracker) : null;
  if (!tracker || !tracked) return;
  store.update("Release correction", (d) => unpinTrackSample(d, trackerId, sourceMsFor(d, tracked, compMs), channels));
}

/** A comp-space point into the footage's source pixels at a comp instant. */
export function frameToSourceFor(doc: MotionDocument, tracker: Tracker, compMs: number): ((p: { x: number; y: number }) => { x: number; y: number }) | null {
  const view = trackViewAt(doc, tracker, compMs);
  return view ? (p) => compToSource(view, p) : null;
}

// ── Consumers ────────────────────────────────────────────────────────────────

/** Attach any clip's transform to a tracker so it follows the object. */
export function attachClip(store: DocumentStore, clipId: string, trackerId: string, channels?: TrackChannel[]): void {
  const compMs = useSession.getState().playheadMs;
  // Keeps its place: it rides the track from where it is now, no jump.
  store.update("Attach to track", (d) => void followTracker(d, clipId, trackerId, compMs, { channels: channels ?? ["position"] }));
}

export function detachClip(store: DocumentStore, clipId: string): void {
  store.update("Detach from track", (d) => unbindClip(d, clipId));
}

/** Bake a follow into plain keyframes — the same writes the live follow makes. */
export function bakeClip(store: DocumentStore, clipId: string): void {
  store.update("Bake track to keyframes", (d) => void flattenTrackBinding(d, clipId));
}

/** Delete a tracker. Nothing else to clean up — that is the point. */
export function deleteTrack(store: DocumentStore, trackerId: string): void {
  store.update("Delete track", (d) => removeTracker(d, trackerId));
  if (useSession.getState().activeTrackerId === trackerId) useSession.getState().setActiveTracker(null);
}

// ── Region effect (the "blur a moving face" flow) ────────────────────────────

/** The seed effect a tracked-region grade applies (tune or add more after). */
function seedEffect(kind: "blur" | "bw"): LayerEffect {
  if (kind === "bw")
    return { id: createId("lfx"), type: "adjust", enabled: true, brightness: 1, contrast: 1, saturate: 0, hueDeg: 0, grayscale: 1, sepia: 0 };
  return { id: createId("lfx"), type: "blur", radius: 18, enabled: true };
}

/**
 * Drop a clip onto a lane that paints ABOVE the footage it belongs to and is
 * free across its span. Track index 0 is the TOP of the stack.
 */
function placeAboveFootage(d: MotionDocument, clip: VisualClip, aboveClipId: string, laneName: string): void {
  clip.startMs = compRenderTimeMs(d, clip.frameId, clip.startMs);
  const overlaps = (t: (typeof d.tracks)[number]) =>
    t.clips.some(
      (c) =>
        c.frameId === clip.frameId &&
        clip.startMs < c.startMs + c.durationMs &&
        clip.startMs + clip.durationMs > c.startMs,
    );
  const footageIdx = d.tracks.findIndex((t) => t.clips.some((c) => c.id === aboveClipId));
  const ceiling = footageIdx === -1 ? d.tracks.length : footageIdx;
  let track = d.tracks.find((t, i) => i < ceiling && !t.locked && !overlaps(t));
  if (!track) {
    track = createCarrierTrack(laneName, clip.frameId);
    d.tracks.unshift(track);
  }
  addClipToTrack(track, clip);
  track.clips.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Turn a solved track into a moving region effect, as an adjustment layer
 * scoped to the tracked matte.
 *
 * This is now the SECOND way to use a tracked region, and the lesser one: a
 * grade node's power window (`grade/windows.ts`) does the same job inside the
 * colour page without adding a layer at all. It stays because an adjustment
 * layer reaches BELOW itself — it can blur a face across several stacked clips,
 * which a per-clip grade by definition cannot.
 */
export function makeTrackedRegionEffect(store: DocumentStore, trackerId: string, kind: "blur" | "bw"): void {
  let adjId = "";
  store.update(kind === "blur" ? "Track & blur region" : "Track & desaturate region", (d) => {
    const tracker = d.trackers.find((t) => t.id === trackerId);
    const source = tracker ? trackedClipOf(d, tracker) : null;
    if (!tracker || !source) return;
    const adj = createAdjustmentClip({
      frameId: source.frameId,
      startMs: source.startMs,
      durationMs: source.durationMs,
      fillDuration: false,
    });
    adj.scope = { reach: "below", filter: { mode: "all", targetIds: [] }, source: "over" };
    adj.effects = [seedEffect(kind)];
    adj.name = kind === "blur" ? "Blur region" : "Desaturate region";
    // The matte is the TRACKER's, read through the grade card's window — so the
    // region follows without a stencil layer standing in for it.
    adjId = adj.id;
    placeAboveFootage(d, adj, source.id, "Region effect");
  });
  if (adjId) useSession.getState().select([adjId]);
}

// ── The Track panel's verbs ──────────────────────────────────────────────────

/**
 * WHAT A TRACKER FOLLOWS — four presets over the channel set, the Mocha toggles
 * named by the job instead of by the maths. `custom` is any other set.
 */
export const TRACK_FOLLOWS = {
  point: ["position"],
  object: ["position", "scale", "rotation"],
  surface: ["position", "scale", "rotation", "skew", "perspective"],
  outline: ["position", "scale", "rotation", "shape"],
} as const satisfies Record<string, readonly TrackChannel[]>;
export type TrackFollows = keyof typeof TRACK_FOLLOWS;

export function followsOf(channels: readonly TrackChannel[]): TrackFollows | "custom" {
  const have = new Set(channels);
  for (const [id, set] of Object.entries(TRACK_FOLLOWS) as Array<[TrackFollows, readonly TrackChannel[]]>)
    if (set.length === have.size && set.every((c) => have.has(c))) return id;
  return "custom";
}

export function renameTrack(store: DocumentStore, trackerId: string, name: string): void {
  const clean = name.trim();
  if (!clean) return;
  store.update("Rename track", (d) => {
    const t = d.trackers.find((x) => x.id === trackerId);
    if (t) t.name = clean;
  });
}

export function setTrackChannels(store: DocumentStore, trackerId: string, channels: readonly TrackChannel[]): void {
  store.update("Track follows", (d) => setTrackerSolve(d, trackerId, { channels: channels.length ? [...channels] : ["position"] }));
}

/** One stop of the Speed ↔ Accuracy dial writes every knob it stands for. */
export function setTrackQuality(store: DocumentStore, trackerId: string, quality: TrackQuality): void {
  const q = TRACK_QUALITIES[quality];
  store.update("Track quality", (d) => setTrackerSolve(d, trackerId, { accuracy: q.accuracy, analysisEdge: q.analysisEdge, cadence: { ...q.cadence } }), { mergeKey: `track-quality-${trackerId}` });
}

export function patchTrackSolve(store: DocumentStore, trackerId: string, patch: Partial<TrackSolve>, label = "Track settings"): void {
  store.update(label, (d) => setTrackerSolve(d, trackerId, patch), { mergeKey: `track-solve-${trackerId}-${Object.keys(patch).join(",")}` });
}

/** The matte's edge (feather, expand, invert) — never asks for a re-solve. */
export function patchTrackRegion(store: DocumentStore, trackerId: string, patch: Partial<TrackRegion>): void {
  store.update("Track matte", (d) => setTrackerRegion(d, trackerId, patch), { mergeKey: `track-region-${trackerId}-${Object.keys(patch).join(",")}` });
}

/** Forget the measurements (corrections kept) and solve again, both ways. */
export function retrack(store: DocumentStore, trackerId: string): void {
  clearTrack(store, trackerId);
  void startTrack(store, trackerId, { kind: "all" });
}

/**
 * Make a layer follow. From the tracker's side (`snap`) it lands ON the point —
 * you pointed at a layer and said "stick this on"; from the layer's own Follow
 * field it keeps its place, because you had already put it where you wanted.
 */
export function attachLayer(store: DocumentStore, clipId: string, trackerId: string, opts: { snap?: boolean; channels?: TrackChannel[] } = {}): void {
  const compMs = useSession.getState().playheadMs;
  store.update("Follow track", (d) => void followTracker(d, clipId, trackerId, compMs, { channels: opts.channels ?? ["position"], snap: opts.snap }));
}

export function patchFollow(store: DocumentStore, clipId: string, patch: Partial<TrackBinding>): void {
  store.update("Follow", (d) => updateClipBinding(d, clipId, patch), { mergeKey: `follow-${clipId}-${Object.keys(patch).join(",")}` });
}

/** A text layer riding the track, above the footage, for the footage's span. */
export function addTextOnTrack(store: DocumentStore, trackerId: string): void {
  let id = "";
  store.update("Text on track", (d) => {
    const tracker = d.trackers.find((t) => t.id === trackerId);
    const footage = tracker ? trackedClipOf(d, tracker) : null;
    if (!tracker || !footage) return;
    const text = createTextClip({ frameId: footage.frameId, text: tracker.name, startMs: footage.startMs, durationMs: footage.durationMs });
    placeAboveFootage(d, text, footage.id, "Tracked");
    followTracker(d, text.id, trackerId, useSession.getState().playheadMs, { channels: ["position"], snap: true });
    id = text.id;
  });
  if (id) useSession.getState().select([id]);
}

/** Hold the tracked thing still: the footage counter-moves along its own track. */
export function stabilizeFootage(store: DocumentStore, trackerId: string): void {
  const doc = store.getState();
  const tracker = doc.trackers.find((t) => t.id === trackerId);
  const footage = tracker ? trackedClipOf(doc, tracker) : null;
  if (tracker?.kind !== "region" || !footage) return;
  const channels = tracker.solve.channels.filter((c): c is "position" | "rotation" | "scale" => c === "position" || c === "rotation" || c === "scale");
  store.update("Stabilize", (d) => void followTracker(d, footage.id, trackerId, useSession.getState().playheadMs, { channels, invert: true }));
}
