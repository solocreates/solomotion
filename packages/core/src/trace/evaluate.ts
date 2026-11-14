import type { MotionDocument, Clip, TraceClip, TraceSpec, Vec2 } from "../schema";
import { sampleKeyframes } from "../animation/keyframes";
import { lerpColor } from "../animation/properties";
import { clipLocalTime } from "../animation/evaluate";
import { sampledTransform } from "../relations/resolve";
import { basisOfTransform, mapLocal } from "../transform-map";
import { clipBox } from "../timeline/ops";
import { clipByIdIn } from "../timeline/frame-index";
import { storedDocumentOf } from "../timeline/settled";
import { groupChainMatrix } from "../timeline/group-space";
import { apply } from "../navigation/matrix";
import { bakeAskedOf, bakeOfCompAt, clipAtInstant } from "../evaluate/resolved-doc";
import { scopeCacheKey } from "../components/inputs";
import { traceSamplesOf } from "./samples";
import { setTraceProperty, TRACE_PATH } from "./fields";

/**
 * TRACE EVALUATION — `(document, trace, instant) → the polyline it has drawn`.
 *
 * The source is SAMPLED, never recorded: every vertex is the source's point at
 * one instant, read through the same bake the canvas draws (`clipAtInstant` —
 * a body's own pose from the run, a driven layer's own drivers, a keyed one's
 * keys), so a trace sits exactly on what it follows.
 *
 * ── Why scrubbing and export agree ─────────────────────────────────────────
 *
 * Vertices sit on a GRID anchored at the trace's start (`start + k/rate`), never
 * at the playhead. Only the two ends are off the grid, and both are exact: the
 * head is the source now, the tail (when `lengthMs` cuts the history) is the
 * source at `now − length`. So the polyline at an instant is one fact no matter
 * how you arrived there — scrubbed, played or rendered frame by frame.
 *
 * ── Why it is cheap ───────────────────────────────────────────────────────
 *
 * A grid point is a pure function of the raw document and its instant, so it is
 * computed once per document and kept (`traceSamplesOf`). Playing forward adds a vertex or
 * two per frame; scrubbing back costs nothing. An edit that cannot move any
 * source — the trace's own colour, width, cooling or ghosts — keeps every point
 * (`sameSources`), which is what lets a head-width slider scrub at frame rate
 * over a minute of orbit.
 */

/** One vertex of the trace: where the source was, and when (comp ms). */
export interface TraceVertex {
  x: number;
  y: number;
  t: number;
}

/** What a trace shows at an instant. */
export interface TraceState {
  /** The look at this instant (`trace.*` keys and drivers applied). */
  spec: TraceSpec;
  /** Unbroken stretches, oldest vertex first. A source that left the timeline breaks the line. */
  runs: TraceVertex[][];
  /** Strobe instants with the source's point there, newest first. */
  ghosts: TraceVertex[];
  /** The instant evaluated (comp ms). */
  nowMs: number;
  /** The age over which a vertex cools from head to tail (ms, ≥ 1). */
  coolMs: number;
}

/** The look a vertex of age `ageMs` has: `u` 0 = head, 1 = fully cooled. */
export interface TraceLook {
  u: number;
  width: number;
  opacity: number;
}

/** Most grid vertices one evaluation walks — a ceiling, not a target (10 min at 120/s). */
export const MAX_TRACE_SAMPLES = 72_000;

/**
 * The trace's look at a clip-local instant: the stored spec with its `trace.*`
 * keys sampled over it. Drivers need no step here — the bake already wrote
 * them into the clip's slots and dropped their keys.
 */
export function traceSpecAt(clip: TraceClip, localMs: number): TraceSpec {
  const tracks = clip.keyframes.filter((k) => TRACE_PATH.test(k.property));
  if (!tracks.length) return clip.trace;
  const kf = sampleKeyframes(tracks, localMs);
  const scratch = { ...clip, trace: structuredClone(clip.trace) } as TraceClip;
  for (const [path, value] of Object.entries(kf)) setTraceProperty(scratch, path, value);
  return scratch.trace;
}

/** Where a vertex of age `ageMs` sits on the head → tail ramp, and its width and opacity. */
export function traceLookAt(spec: TraceSpec, ageMs: number, coolMs: number): TraceLook {
  const u = Math.pow(Math.min(1, Math.max(0, ageMs / coolMs)), spec.falloff);
  return {
    u,
    width: spec.head.width + (spec.tail.width - spec.head.width) * u,
    opacity: spec.head.opacity + (spec.tail.opacity - spec.head.opacity) * u,
  };
}

/** The colour at `u`, once the caller has resolved any `var:` tokens of the two ends. */
export function traceColorAt(head: string, tail: string, u: number): string {
  return u <= 0 ? head : u >= 1 ? tail : lerpColor(head, tail, u);
}

/**
 * THE TRACE AT AN INSTANT. `doc` is the bake of the trace's comp at `compMs`
 * (what the renderer holds; a raw document works too), `clip` the trace as
 * that bake has it. Empty runs before the trace starts or when its source is
 * gone — never a throw: a dangling source id is "nothing to draw".
 */
export function evaluateTrace(doc: MotionDocument, clip: TraceClip, compMs: number): TraceState {
  // The samples read the source AS THE TRACE'S OWN COMP RESOLVES IT, at that
  // comp's own time — whatever document the caller holds. A raw document, or a
  // bake of another comp (a parent drawing its nest, a bounds query from the
  // parent), has the source unresolved: its expressions and bodies unapplied.
  // Read through one of those, a trace in a nested room sampled the ball at its
  // stored base (the room's origin) and kept those points for the real draw.
  const baked = bakeOfCompAt(doc, clip.frameId, compMs);
  if (baked !== doc) {
    const mine = clipByIdIn(baked, clip.id);
    doc = baked;
    if (mine?.kind === "trace") clip = mine;
  }
  const local = Math.max(0, Math.min(clip.durationMs, compMs - clip.startMs));
  const spec = traceSpecAt(clip, local);
  const now = clip.startMs + local;
  const origin = clip.startMs;
  const length = spec.lengthMs;
  const lo = length == null ? origin : Math.max(origin, now - length);
  const coolMs = Math.max(1, spec.coolMs ?? now - lo);
  const out: TraceState = { spec, runs: [], ghosts: [], nowMs: now, coolMs };
  const source = traceSourceOf(doc, clip);
  if (!source) return out;

  const step = 1000 / spec.rate;
  const pointAt = samplerFor(doc, clip, spec);
  // The grid indices strictly inside (lo, now); the two ends are exact.
  const first = Math.max(0, Math.floor((lo - origin) / step) + 1);
  const last = Math.min(Math.ceil((now - origin) / step) - 1, first + MAX_TRACE_SAMPLES);
  let run: TraceVertex[] = [];
  const push = (t: number, p: Vec2 | null) => {
    if (p) run.push({ x: p.x, y: p.y, t });
    else if (run.length) {
      out.runs.push(run);
      run = [];
    }
  };
  push(lo, pointAt(lo, false));
  for (let k = first; k <= last; k++) {
    const t = origin + k * step;
    if (t > lo && t < now) push(t, pointAt(t, true));
  }
  if (now > lo) push(now, pointAt(now, false));
  if (run.length) out.runs.push(run);

  const g = spec.ghosts;
  if (g.enabled) {
    const newest = Math.floor((now - origin) / g.everyMs + 1e-9);
    const oldest = Math.ceil((lo - origin) / g.everyMs - 1e-9);
    const limit = g.count ?? Number.POSITIVE_INFINITY;
    for (let k = newest; k >= oldest && out.ghosts.length < limit; k--) {
      const t = origin + k * g.everyMs;
      const p = pointAt(t, true);
      if (p) out.ghosts.push({ x: p.x, y: p.y, t });
    }
  }
  return out;
}

/** The layer a trace follows, as the bake has it — the trace itself for a pen. Null = nothing to follow. */
export function traceSourceOf(doc: MotionDocument, clip: TraceClip): Clip | null {
  const id = clip.trace.source.clipId;
  if (!id) return clip;
  const src = clipByIdIn(doc, id);
  if (!src || src.kind === "audio" || src.frameId !== clip.frameId) return null;
  return src;
}

/** Every vertex of a trace state, for bounds. */
export function traceBounds(state: TraceState): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (v: TraceVertex) => {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  };
  for (const r of state.runs) r.forEach(add);
  state.ghosts.forEach(add);
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// ── Sampling ────────────────────────────────────────────────────────────────

/** The source's point at a comp instant; `keep` = a grid instant worth remembering. */
type Sampler = (t: number, keep: boolean) => Vec2 | null;

function samplerFor(doc: MotionDocument, clip: TraceClip, spec: TraceSpec): Sampler {
  const points = traceSamplesOf(doc);
  // Everything a point depends on beyond the document's sources: which point of
  // which layer (the trace's own position for a pen), on which comp, through
  // which instance (a component's inputs can steer its source).
  const asked = bakeAskedOf(doc);
  const scope = asked?.scope ? scopeCacheKey(storedDocumentOf(doc), clip.frameId, asked.scope) : "";
  const key = `${clip.id}|${clip.trace.source.clipId ?? ""}|${spec.source.point.x},${spec.source.point.y}|${clip.frameId}|${scope}`;
  let known = points.get(key);
  if (!known) points.set(key, (known = new Map()));
  const cache = known;
  return (t, keep) => {
    if (keep && cache.has(t)) return cache.get(t)!;
    const p = sourcePointAt(doc, clip, spec, t);
    if (keep) cache.set(t, p);
    return p;
  };
}

/**
 * The traced point at comp instant `t`, in comp (frame-centre) space: the
 * source as the bake has it then, its `point` carried through its own pose and
 * every group around it. Null while the source is not on the timeline.
 */
function sourcePointAt(doc: MotionDocument, trace: TraceClip, spec: TraceSpec, t: number): Vec2 | null {
  const now = traceSourceOf(doc, trace);
  if (!now || clipLocalTime(now, t) === null) return null;
  const at = clipAtInstant(doc, now, t);
  const src = at.clip;
  if (src.kind === "audio") return null;
  const local = t - src.startMs;
  const tr = sampledTransform(src, local);
  const box = clipBox(at.doc, src);
  const d = mapLocal(box.cx + spec.source.point.x, box.cy + spec.source.point.y, basisOfTransform({ ...tr, scaleY: tr.scaleY ?? tr.scale }, box));
  const p = { x: tr.x + d.x, y: tr.y + d.y };
  const chain = groupChainMatrix(at.doc, src.id, (g) => t - g.startMs);
  return apply(chain, p);
}
