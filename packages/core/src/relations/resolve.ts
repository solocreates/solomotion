import type { MotionDocument, Clip, Transform, TextClip, KeyframeTrack } from "../schema";
import { sampledScaleY } from "../animation/uniform-scale";
import { isPathText } from "../schema";
import { sampleKeyframes } from "../animation/keyframes";
import { isPathHost, type PathHostClip } from "../text/on-path";
import { locateClip } from "../timeline/ops";
import { resolveLayoutInDocument, documentHasLayout } from "./layout";

/**
 * THE RELATION RESOLVER — a related layer's derived values become REAL values
 * on the clip, once per instant, in the resolved document.
 *
 * This is the driver-baking pattern (`nodes/resolve-clip.ts`) applied to the
 * two relations `schema/relations.ts` defines, and for the same reason it
 * gives: a value that is only visible to code that reads through a special
 * seam is invisible to the hit test, the handles, the inspector and the
 * exporter the day after it ships. Baked into the clip's own slots, a text on a
 * path has a transform every surface already knows how to read, and a member
 * of a laid-out group has an `x/y` the selection box, the pivot crosshair and
 * the snap engine all agree on.
 *
 * Order matters and is fixed here: LAYOUT first, then PATH BINDINGS. A shape
 * that is a member of a row is placed by the row, and the text riding that
 * shape must follow the placed shape — the reverse order would bind the text
 * to where the shape used to be. A text that is itself a member of a row AND
 * on a path is placed by the path (its transform is the host's); the row
 * treats it as absent, which is what a layer with no box of its own is.
 *
 * Clips without a relation keep their identity, and a document with none is
 * returned as-is, so memoisation downstream survives.
 */
export function resolveDocumentRelations(
  doc: MotionDocument,
  timeMs: number,
  frameId?: string | null,
): MotionDocument {
  if (!documentHasRelations(doc)) return doc;
  let out = documentHasLayout(doc) ? resolveLayoutInDocument(doc, timeMs, frameId) : doc;
  out = resolvePathBindings(out, timeMs, frameId);
  return out;
}

// ── Does this document relate anything at all? ───────────────────────────────

const relationsMemo = new WeakMap<MotionDocument, boolean>();

/** True when any clip carries a relation. Memoised per document identity. */
export function documentHasRelations(doc: MotionDocument): boolean {
  let hit = relationsMemo.get(doc);
  if (hit === undefined) {
    hit = false;
    scan: for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if ((clip.kind === "text" && clip.path !== null) || (clip.kind === "group" && clip.layout !== null)) {
          hit = true;
          break scan;
        }
      }
    }
    relationsMemo.set(doc, hit);
  }
  return hit;
}

// ── Text on a path ───────────────────────────────────────────────────────────

/**
 * The host a text rides, or null when the relation cannot resolve — a deleted
 * host, a host that is not a shape or path, a host in another comp. Null means
 * "draw this text as plain text": the relation is kept on the clip so it comes
 * back if the host does (undo), but nothing downstream ever sees a half state.
 */
export function pathHostOf(doc: MotionDocument, text: TextClip): PathHostClip | null {
  if (!text.path) return null;
  const host = locateClip(doc, text.path.hostClipId)?.clip;
  if (!isPathHost(host) || host.frameId !== text.frameId) return null;
  return host;
}

/** The host's local time for a comp instant, held inside its span. */
export function hostLocalTime(host: Clip, compMs: number): number {
  return Math.max(0, Math.min(host.durationMs - 1e-3, compMs - host.startMs));
}

const TRANSFORM_PATHS = new Set(["x", "y", "scale", "scaleY", "rotation", "skewX", "skewY", "anchor.x", "anchor.y"]);

/** The host's transform at its local time, keys and base folded together. */
export function sampledTransform(clip: Exclude<Clip, { kind: "audio" }>, localMs: number): Transform {
  const kf = sampleKeyframes(clip.keyframes, localMs);
  const n = (k: string, d: number) => (typeof kf[k] === "number" ? (kf[k] as number) : d);
  const t = clip.transform;
  return {
    x: n("x", t.x),
    y: n("y", t.y),
    scale: n("scale", t.scale),
    scaleY: sampledScaleY(kf, t.scaleY),
    rotation: n("rotation", t.rotation),
    skewX: n("skewX", t.skewX),
    skewY: n("skewY", t.skewY),
    anchor: { x: n("anchor.x", t.anchor.x), y: n("anchor.y", t.anchor.y) },
  };
}

function resolvePathBindings(doc: MotionDocument, timeMs: number, frameId?: string | null): MotionDocument {
  let changedAny = false;
  const tracks = doc.tracks.map((track) => {
    let changed = false;
    const clips = track.clips.map((clip) => {
      if (!isPathText(clip) || (frameId && clip.frameId !== frameId)) return clip;
      const host = pathHostOf(doc, clip);
      if (!host) return clip;
      const driven = sampledTransform(host, hostLocalTime(host, timeMs));
      // The host OWNS the text's transform now — a surviving key would overwrite it.
      const keyframes: KeyframeTrack[] = clip.keyframes.filter((t) => t.range || !TRANSFORM_PATHS.has(t.property));
      changed = true;
      return { ...clip, transform: driven, keyframes };
    });
    if (!changed) return track;
    changedAny = true;
    return { ...track, clips };
  });
  return changedAny ? { ...doc, tracks } : doc;
}

/** Every text riding `hostId` — what a delete has to detach, what a morph re-lays. */
export function textsOnHost(doc: MotionDocument, hostId: string): TextClip[] {
  const out: TextClip[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "text" && clip.path?.hostClipId === hostId) out.push(clip);
    }
  }
  return out;
}
