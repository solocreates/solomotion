import { Immer } from "immer";
import { setClipProperty } from "../animation/paths";
import { channelValueAt } from "../animation/channels";
import { withFieldValue } from "../expressions/bind";
import type { MotionDocument, Clip, NodeValue } from "../schema";
import { resolveDriver, type DriverEnv } from "./drivers";

/**
 * DRIVER BAKING — a driven value becomes a REAL value on the clip.
 *
 * The original design overlaid drivers onto the sampled-keyframe map at each
 * draw site. That made a driven property visible only to code that read that
 * particular map: the renderer's transform saw it, and hit rectangles, selection
 * chrome, corner-radius handles, inspector fields and node rows — all of which
 * read `clip.x` or `getClipProperty` — did not. The shape moved and nothing
 * around it followed, because as far as the rest of the app was concerned the
 * value had never changed.
 *
 * So resolution happens ONCE, here, and writes into the clip's own slots through
 * `setClipProperty` — the same setter a person typing in the field uses. After
 * this, nothing downstream needs to know a driver exists: there is no second
 * value to look up, no seam to remember to read through, and no way for one part
 * of the app to disagree with another about where a layer is.
 *
 * Three details that are load-bearing:
 *
 *  - A driven property's KEYFRAME TRACK is dropped, because a driver owns the
 *    value outright. Leaving the track would let `sampleKeyframes` overwrite the
 *    baked value further down and the driver would appear to do nothing.
 *  - Clips without drivers are returned UNCHANGED, by reference. Everything
 *    downstream memoises on clip identity, so cloning unconditionally would
 *    re-render the whole editor every frame.
 *  - A driver that resolves to NOTHING — a broken expression, a deleted graph,
 *    an unwired socket — leaves the stored value in place rather than writing a
 *    zero. Half-typing `#time *` must not fling the layer to the origin; you get
 *    the last thing that made sense, and the field paints its own error state.
 */
export function resolveClipDrivers(clip: Clip, timeMs: number, env: DriverEnv): Clip {
  const drivers = clip.drivers;
  if (!drivers) return clip;
  const paths = Object.keys(drivers);
  if (paths.length === 0) return clip;
  const run = () => bakeClip(clip, paths, drivers, timeMs, env);
  return env.scopeClip ? env.scopeClip(clip, run) : run();
}

function bakeClip(
  clip: Clip,
  paths: string[],
  drivers: Record<string, string>,
  timeMs: number,
  env: DriverEnv,
): Clip {
  // Every value is read against the STORED clip first, then written in one go:
  // `#value` is the field's own keys or base, never a sibling's baked result.
  const writes: Array<[string, string | number | boolean]> = [];
  for (const path of paths) {
    const token = drivers[path];
    if (!token) continue;
    // The bake's memo when it has one: a field another layer already read
    // through `layer()` is not evaluated twice.
    const value = env.driven ? env.driven(clip, path) : resolveClipDriver(clip, path, token, timeMs, env);
    // A vec2 has no single-property home; undefined means "nothing to say", and
    // both fall through to whatever the clip already held.
    if (value === undefined || typeof value === "object") continue;
    writes.push([path, value]);
  }
  return bakeClipValues(clip, writes);
}

/**
 * ONE DRIVEN FIELD'S VALUE — the driver run with `#value` reading the field's
 * own keys or base (what the driver is layered on). Call it inside the clip's
 * scope (`env.scopeClip`): the bake does, and so does a `layer()` read of
 * another layer's driven field.
 */
export function resolveClipDriver(clip: Clip, path: string, token: string, timeMs: number, env: DriverEnv): NodeValue | undefined {
  const own = () => {
    const v = channelValueAt(clip, path, timeMs);
    return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : undefined;
  };
  return withFieldValue(own, () => resolveDriver(token, timeMs, env), path);
}

/**
 * Write resolved values into a clip's own slots for one instant — THE way a
 * derived value becomes a real one (drivers here, a tracker follow in
 * `tracking/follow.ts`). The written properties' keyframe tracks are dropped:
 * whatever resolved them owns the value outright, and a surviving track would
 * overwrite it further down. No writes = the clip itself, by reference.
 */
export function bakeClipValues(clip: Clip, writes: ReadonlyArray<readonly [string, string | number | boolean]>): Clip {
  if (writes.length === 0) return clip;
  const baked = bakeWriter.produce(clip, (draft) => {
    for (const [path, value] of writes) setClipProperty(draft, path, value);
    const driven = new Set(writes.map(([path]) => path));
    draft.keyframes = draft.keyframes.filter((t) => !driven.has(t.property));
  });
  // A bake that only moved its clip keeps its pixels' identity for the layer cache.
  const source = placedFrom.get(clip) ?? clip;
  if (writes.every(([path]) => PLACEMENT_PATHS.has(path))) placedFrom.set(baked, source);
  return baked;
}

/**
 * The properties that PLACE a layer without changing a pixel of it: where its
 * finished picture lands in the frame. Everything else — rotation, scale,
 * opacity, any field of its content or effects — changes the picture itself.
 */
export const PLACEMENT_PATHS: ReadonlySet<string> = new Set(["x", "y"]);

/** A bake that only MOVED its clip, back to the stored clip it moved. */
const placedFrom = new WeakMap<Clip, Clip>();

/**
 * The STORED clip a bake only moved — or the clip itself. A layer whose `x`
 * scrolls by expression is a fresh object at every instant (the bake has to
 * write somewhere), yet its pixels before placement never change; this is the
 * object they belong to, so the layer cache can keep them across instants
 * (see `layerBufferSegment`).
 */
export function placedSourceOf(clip: Clip): Clip {
  return placedFrom.get(clip) ?? clip;
}

/**
 * COPY-ON-WRITE, never a deep clone. The setter mutates nested shapes (paints,
 * effects, transform), so whatever a driven path walks through must be new —
 * and ONLY that: a hill whose `x` scrolls by expression used to structuredClone
 * its whole path, effects and keyframes on every frame of every comp that drew
 * it (1.2 s of one Playground page). Unfrozen, because the bake's output is
 * settled as a whole by `resolvedDocAt`; the untouched branches are the
 * store's own frozen objects, shared.
 */
const bakeWriter = new Immer({ autoFreeze: false });

/** Resolve every driven clip in the document. Untouched clips keep their
 *  identity, and a document with no drivers at all is returned as-is, so the
 *  editor's memoisation survives.
 *
 *  `frameId` narrows the pass to ONE comp, which is both cheaper and more
 *  correct: a clip in another composition is drawn at that composition's own
 *  time (nesting, trims, speed), so baking it at this one's would be an answer
 *  to a question nobody asked. Omitted = the whole document, for callers that
 *  genuinely have no comp in hand. */
export function resolveDocumentDrivers(
  doc: MotionDocument,
  timeMs: number,
  env: DriverEnv,
  frameId?: string | null,
): MotionDocument {
  let changedAny = false;
  const tracks = doc.tracks.map((track) => {
    let changed = false;
    const clips = track.clips.map((clip) => {
      if (frameId && clip.frameId !== frameId) return clip;
      const next = resolveClipDrivers(clip, timeMs, env);
      if (next !== clip) changed = true;
      return next;
    });
    if (!changed) return track;
    changedAny = true;
    return { ...track, clips };
  });
  return changedAny ? { ...doc, tracks } : doc;
}

