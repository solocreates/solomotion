import type { MotionDocument, Clip, KeyframeTrack, KeyframeValue } from "../schema";
import { setKeyframe } from "../animation/keyframes";
import { getClipProperty, setClipProperty } from "../animation/paths";
import { documentHasRelations, resolveDocumentRelations } from "./resolve";

/**
 * RELATIONS → KEYFRAMES, for the exporters that translate structure rather
 * than paint pixels (Lottie, and any native adapter after it).
 *
 * The renderer resolves a relation per instant and never needs this. A
 * translator that emits a Lottie layer per clip cannot: it reads a clip's
 * transform track, not a document at an instant, so a member placed by a row
 * or a text driven by its host would export where its stored numbers say — a
 * place nobody has looked at since the relation was made.
 *
 * So the relations are baked into the one vocabulary every translator already
 * speaks: a key per frame on the derived properties, linear between samples
 * (the samples are a frame apart, so nothing can drift between them). A
 * property that never changes is written as a plain value. The relation is then
 * removed from the copy, and the exporter reports what it could not carry (a
 * text's glyphs on a curve; a container's own box) so nothing goes missing
 * silently. Property paths are the registry's, so the same bake serves the
 * SVG snapshot (one instant, no keys) and a per-frame translator alike.
 */

/** The derived properties a relation writes, per clip kind. */
const DERIVED: Record<string, readonly string[]> = {
  text: ["x", "y", "scale", "scaleY", "rotation", "skewX", "skewY", "anchor.x", "anchor.y", "maxWidth", "maxHeight"],
  shape: ["x", "y", "width", "height"],
  group: ["x", "y", "layout.width", "layout.height"],
  other: ["x", "y"],
};

function derivedPaths(clip: Clip): readonly string[] {
  return DERIVED[clip.kind] ?? DERIVED.other!;
}

/**
 * A copy of `doc` where every clip of `frameId` that a relation places carries
 * that placement as keyframes from `startMs` to `endMs` at `fps`, and the
 * relations are gone. Returns `doc` itself when nothing relates.
 */
export function bakeRelationsToKeys(
  doc: MotionDocument,
  frameId: string,
  fps: number,
  startMs: number,
  endMs: number,
): MotionDocument {
  if (!documentHasRelations(doc)) return doc;
  const frameMs = 1000 / Math.max(1, fps);
  const steps = Math.max(1, Math.round((endMs - startMs) / frameMs));

  // Which clips a relation touches: compare the resolved document at one
  // instant with the raw — a clip whose identity changed was written.
  const probe = resolveDocumentRelations(doc, startMs, frameId);
  const related = new Set<string>();
  const rawById = new Map<string, Clip>();
  for (const t of doc.tracks) for (const c of t.clips) rawById.set(c.id, c);
  for (const t of probe.tracks) for (const c of t.clips) if (rawById.get(c.id) !== c) related.add(c.id);
  if (related.size === 0) return doc;

  // Sample every related clip's derived properties at every frame.
  const samples = new Map<string, Map<string, KeyframeValue[]>>();
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(endMs, startMs + i * frameMs);
    const at = resolveDocumentRelations(doc, t, frameId);
    for (const track of at.tracks) {
      for (const clip of track.clips) {
        if (!related.has(clip.id)) continue;
        let per = samples.get(clip.id);
        if (!per) samples.set(clip.id, (per = new Map()));
        for (const path of derivedPaths(clip)) {
          const v = getClipProperty(clip, path);
          if (v === undefined) continue;
          let list = per.get(path);
          if (!list) per.set(path, (list = []));
          list[i] = v;
        }
      }
    }
  }

  const tracks = doc.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((raw) => {
      const per = samples.get(raw.id);
      if (!per) return raw;
      const clip = structuredClone(raw) as Clip;
      for (const [path, values] of per) {
        const first = values.find((v) => v !== undefined);
        if (first === undefined) continue;
        const constant = values.every((v) => v === undefined || v === first);
        // Drop the clip's own track on this path — the relation owned it.
        clip.keyframes = clip.keyframes.filter((k: KeyframeTrack) => k.range || k.property !== path);
        if (constant) {
          setClipProperty(clip, path, first);
          continue;
        }
        values.forEach((v, i) => {
          if (v === undefined) return;
          const t = Math.min(endMs, startMs + i * frameMs) - raw.startMs;
          setKeyframe(clip.keyframes, path, t, v, { kind: "linear" });
        });
      }
      if (clip.kind === "text") clip.path = null;
      if (clip.kind === "group") clip.layout = null;
      return clip;
    }),
  }));
  return { ...doc, tracks };
}
