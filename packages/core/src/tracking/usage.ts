import type { MotionDocument } from "../schema";
import { parseFxToken } from "../schema";
import { isVisualClip } from "../clip-registry";
import { TRACK_NODE_TYPE } from "./track-node";
import { depthTrackerFor } from "./depth/frame";

/**
 * WHO READS A TRACKER — every consumer, from every door it can be read by.
 *
 * A tracker is a data source with four kinds of reader, and "what breaks if I
 * delete this / what moves if I re-solve it" has to name all of them or it is
 * a guess: a layer that FOLLOWS it, a grade WINDOW keyed to it, an EXPRESSION
 * that reads it (by key or by name), and a Track NODE on a board. The Track
 * panel's "Used by", `track.inspect` and the delete warning are this list.
 */
export type TrackerConsumer =
  | { kind: "follow"; clipId: string }
  | { kind: "window"; clipId: string; windowId: string }
  | { kind: "expression"; clipId: string; path: string; expressionId: string }
  | { kind: "node"; graphId: string; nodeId: string; ownerId: string | null }
  /** A depth card (Fog, Lens blur, Behind) reading a depth tracker's maps. */
  | { kind: "effect"; clipId: string; effectId: string; effect: string };

/** Does an expression's source name this tracker — `track("tracker:<id>")` or `track("Face")`? */
function sourceReads(source: string, id: string, name: string): boolean {
  if (!source.includes("track(")) return false;
  if (source.includes(`"tracker:${id}"`)) return true;
  const wanted = name.trim().toLowerCase();
  for (const m of source.matchAll(/track\(\s*"([^"]*)"/g)) {
    const ref = m[1]!.trim();
    if (ref === id || ref.toLowerCase() === wanted) return true;
  }
  return false;
}

export function trackerConsumers(doc: MotionDocument, trackerId: string): TrackerConsumer[] {
  const tracker = doc.trackers.find((t) => t.id === trackerId);
  if (!tracker) return [];
  const out: TrackerConsumer[] = [];
  const reading = new Set(doc.expressions.filter((e) => sourceReads(e.source, tracker.id, tracker.name)).map((e) => e.id));
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (!isVisualClip(clip)) continue;
      if (clip.trackBinding?.trackerId === trackerId) out.push({ kind: "follow", clipId: clip.id });
      for (const e of clip.effects) {
        // The depth family reads the depth of a footage layer (its `source`, else the layer itself).
        if (tracker.kind === "depth" && (e.type === "fog" || e.type === "lensBlur" || e.type === "depthMatte")) {
          const reads = e.source ? doc.tracks.flatMap((t) => t.clips).find((c) => c.id === e.source) : clip;
          if (reads && (reads.kind === "video" || reads.kind === "image") && depthTrackerFor(doc, reads.assetId)?.id === trackerId) out.push({ kind: "effect", clipId: clip.id, effectId: e.id, effect: e.type });
          continue;
        }
        if (e.type !== "grade") continue;
        for (const node of e.graph.nodes) {
          if (node.kind !== "corrector") continue;
          for (const w of node.key.windows)
            if ((w.source.type === "tracker" || w.source.type === "depth") && w.source.trackerId === trackerId) out.push({ kind: "window", clipId: clip.id, windowId: w.id });
        }
      }
    }
    for (const clip of track.clips) {
      if (!reading.size) break;
      for (const [path, token] of Object.entries(clip.drivers ?? {})) {
        const id = parseFxToken(token);
        if (id && reading.has(id)) out.push({ kind: "expression", clipId: clip.id, path, expressionId: id });
      }
    }
  }
  for (const graph of doc.graphs) {
    for (const node of graph.nodes) {
      if (node.type !== TRACK_NODE_TYPE) continue;
      const ref = node.params.tracker;
      if (typeof ref === "string" && (ref === trackerId || ref === `tracker:${trackerId}` || ref.trim().toLowerCase() === tracker.name.trim().toLowerCase()))
        out.push({ kind: "node", graphId: graph.id, nodeId: node.id, ownerId: graph.ownerId });
    }
  }
  return out;
}
