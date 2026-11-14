import type { MotionDocument } from "../schema";
import { clipAnimatableProperties } from "../animation/clip-properties";
import { getClipProperty } from "../animation/paths";
import { sampleKeyframes } from "../animation/keyframes";
import { variableValueAt, variableValueNow } from "../variables";
import { compFps } from "../timeline/fps";
import { clipLookup } from "../timeline/frame-index";
import { defaultNodeRegistry } from "../nodes/builtin";
import type { DriverEnv } from "../nodes/drivers";
import { withEffectiveTargets } from "../nodes/effective-target";
import { mediaLayerApi } from "../speech/source";
import { makeTrackApi } from "../tracking/expressions";

/**
 * Builds the DriverEnv for a document at a comp time — the facts
 * `resolveClipDrivers` needs to turn a token into a value. `readProperty`
 * samples any clip's keyframed/base value
 * (deliberately WITHOUT re-applying drivers, so a driver reading a driven
 * property can't recurse — see `nodes/drivers.ts`), and `describeClip` projects
 * a clip's live property list for Object-node sockets. One cheap object per
 * frame, built at the ONE resolution site (`evaluate/resolved-doc.ts`).
 */
export function makeDriverEnv(
  doc: MotionDocument,
  timeMs: number,
  /**
   * The comp this env is being built for. Its rate is what the `frame` node
   * counts in, so a graph driving a 12fps sheet reports frame 12 at t=1s — not
   * the 30 a project-wide rate used to report. Omitted (or unknown) falls back
   * to the core default; every real call site has the comp in hand.
   */
  frameId?: string | null,
): DriverEnv & { timeMs: number } {
  const clipOf = clipLookup(doc);
  const readProperty = makeClipPropertyReader(doc);
  const media = mediaLayerApi(doc, timeMs, clipOf);
  const tracks = makeTrackApi(doc, frameId ?? null, timeMs);

  return {
    timeMs,
    // Bake each hub-fed operator's effective target (from its Layer wire) into
    // params BEFORE the driver evaluates — otherwise a source operator like AAA's
    // Typography still reads target="" at render (its real target lives on the
    // Layer wire, baked only in the board/render memo) and returns its default, so
    // driving BBB.text from it pushed an empty/stale value instead of AAA's content.
    graphs: doc.graphs.map(withEffectiveTargets),
    registry: defaultNodeRegistry,
    fps: compFps(doc, frameId ?? null),
    readProperty,
    describeClip: (id) => {
      const clip = clipOf(id);
      return clip ? clipAnimatableProperties(clip) : [];
    },
    // Variables are doc-global — read at the SAME render time so a Variables node
    // inside a driver graph sees the variable's keyframed value at this frame.
    readVariable: (id) => {
      const v = doc.variables.find((x) => x.id === id);
      // A paint variable carries an object, and a socket carries a scalar — the
      // board offers no row for one, so reading it here is a no-answer rather
      // than a shape the graph would choke on.
      if (!v || v.type === "paint") return undefined;
      return variableValueAt(v, timeMs) as string | number;
    },
    // The Sound node's ears: a layer picked by id (or named, in this comp),
    // heard through the one source-time map at this comp time.
    mediaAt: (layer, offsetMs) => {
      const id = clipOf(layer)
        ? layer
        : doc.tracks.flatMap((t) => t.clips).find((c) => c.frameId === frameId && c.name.trim().toLowerCase() === layer.trim().toLowerCase())?.id;
      return id ? media.sourceOf?.(id, offsetMs) : undefined;
    },
    // The Track node's eyes: core's one tracking reader, in this comp, now.
    trackAt: (tracker, reading) => {
      const id = tracks.idFor(tracker);
      return id ? tracks.read(id, reading) : undefined;
    },
    // Written EXPRESSIONS ride this map too (`fx:<id>`), so a property path can
    // be driven by a sentence exactly as it can by a graph. The sampler is
    // `variableValueNow` — the ambient-clock reader every other resolver uses —
    // so a keyframed variable named inside an expression animates here as well.
    expressions: {
      table: doc.expressions,
      variables: doc.variables,
      sample: (v) => variableValueNow(v) as string | number,
    },
  };
}

/**
 * THE ONE CLIP READER — "what is layer X's property P at time T?", without
 * re-applying drivers (see `nodes/drivers.ts` on why that would recurse).
 *
 * Shared deliberately. The node engine reads the document through this, and so
 * does the expression language's `layer()` function: two authoring surfaces, one
 * world model. If they each grew their own reader, the same question would start
 * returning two answers depending on which one you asked — and the whole promise
 * that a graph and a sentence are interchangeable would quietly stop being true.
 */
export function makeClipPropertyReader(
  doc: MotionDocument,
): (clipId: string, path: string, timeMs: number) => number | string | boolean | undefined {
  // Core's per-document index: this reader is built per bake, and a bake runs
  // per comp per instant — rebuilding a map of every clip each time was most
  // of a heavy film's resolve cost.
  const clipOf = clipLookup(doc);
  return (clipId, path, t) => {
    const clip = clipOf(clipId);
    if (!clip) return undefined;
    const local = t - clip.startMs;
    const sampled = sampleKeyframes(clip.keyframes, local);
    if (path in sampled) {
      const v = sampled[path];
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
    }
    // The un-keyframed base falls back to the ONE source-of-truth accessor, so
    // EVERY property reads correctly at driver time — text content, paint colors,
    // effect fields, geometry scalars — not just the transform/opacity subset a
    // hand-rolled reader used to cover (that silently null'd everything else).
    const base = getClipProperty(clip, path);
    return typeof base === "number" || typeof base === "string" || typeof base === "boolean" ? base : undefined;
  };
}
