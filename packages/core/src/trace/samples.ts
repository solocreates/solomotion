import type { MotionDocument, TraceClip, Vec2 } from "../schema";
import { storedDocumentOf } from "../timeline/settled";
import { TRACE_PATH } from "./fields";

/**
 * THE TRACES' SAMPLE STORE — every grid point any trace has sampled, per raw
 * document. A point is a pure function of the raw document, the trace's comp,
 * its instance scope and its instant, so it is computed once and kept.
 *
 * This store is ALSO what a trace's picture is made of: a trace draws its
 * source's history, which no field of the trace clip describes. So the layer
 * cache keys a trace on this store's identity (`layerContentRefs`), and the
 * two cannot disagree — the cache drops a trace's pixels exactly when its
 * points are re-sampled. Keyed on the trace clip alone, a trace made before
 * its source's clock was keyed kept its old picture until one of its own
 * fields changed.
 *
 * An edit that cannot move any source — a trace's own colour, width, cooling
 * or ghosts — carries the store over (`sameSources`), which is what lets a
 * head-width slider scrub at frame rate over a minute of orbit.
 */
export type TraceSamples = Map<string, Map<number, Vec2 | null>>;

const memo = new WeakMap<MotionDocument, TraceSamples>();
/** The last raw document sampled, and its store — what a look-only edit carries over. */
let last: { raw: MotionDocument; points: TraceSamples } | null = null;

/** The sample store of a document (a bake reads its raw document's). */
export function traceSamplesOf(doc: MotionDocument): TraceSamples {
  const raw = storedDocumentOf(doc);
  let points = memo.get(raw);
  if (!points) {
    points = last && sameSources(last.raw, raw) ? last.points : new Map();
    memo.set(raw, points);
  }
  last = { raw, points };
  return points;
}

/**
 * Could an edit from `a` to `b` have moved any trace's source? False negatives
 * only cost a re-sample; so this says "same" only when every lane is the same
 * object or differs in nothing but a trace's LOOK.
 */
function sameSources(a: MotionDocument, b: MotionDocument): boolean {
  for (const k of Object.keys(b) as (keyof MotionDocument)[]) {
    if (k !== "tracks" && a[k] !== b[k]) return false;
  }
  if (a.tracks.length !== b.tracks.length) return false;
  for (let i = 0; i < a.tracks.length; i++) {
    const ta = a.tracks[i]!;
    const tb = b.tracks[i]!;
    if (ta === tb) continue;
    if (ta.clips.length !== tb.clips.length) return false;
    for (const k of Object.keys(tb) as (keyof typeof tb)[]) {
      if (k !== "clips" && ta[k] !== tb[k]) return false;
    }
    for (let j = 0; j < ta.clips.length; j++) {
      const ca = ta.clips[j]!;
      const cb = tb.clips[j]!;
      if (ca === cb) continue;
      if (ca.kind !== "trace" || cb.kind !== "trace" || sourceSide(ca) !== sourceSide(cb)) return false;
    }
  }
  return true;
}

/** What of a trace can move a point: its span, its pen (position, keys, drivers), what and where it follows. */
function sourceSide(c: TraceClip): string {
  return JSON.stringify([
    c.id,
    c.frameId,
    c.startMs,
    c.durationMs,
    c.transform,
    c.drivers ?? null,
    c.keyframes.filter((k) => !TRACE_PATH.test(k.property) || k.property.startsWith("trace.point.")),
    c.trace.source,
    c.trace.rate,
  ]);
}
