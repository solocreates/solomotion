import type { MotionDocument } from "../schema";
import { registerExprFunction } from "../expressions/functions";
import { driveWith } from "../expressions/link";
import type { ExprTrackApi } from "../expressions/globals";
import type { ExprValue } from "../expressions/types";
import { readTrack, TRACK_KINDS } from "./read";

/**
 * `track("Face")` — ANY VALUE CAN READ WHAT THE FOOTAGE KNOWS.
 *
 * A tracker is a handle, the twin of `layer("Title")`: read a value off it
 * with a dot — `track("Face").position`, `.rotation`, `.topLeft`,
 * `.confidence` — and the dot completes from its readings table, the same
 * list the Track node's outputs are. Positions come back in THIS comp's
 * space, so `track("Face").position + [0, -80]` puts a caption above a head
 * however the plate is placed. Everything reads through core's one tracking
 * reader, so an expression, a node and a follower cannot disagree.
 */

registerExprFunction({
  name: "track",
  category: "track",
  params: [
    { name: "name", type: "string", describe: "The tracker’s name, as the Track panel shows it." },
    { name: "reading", type: "string", optional: true, describe: "Optional — read one value directly instead of with a dot." },
  ],
  returns: (args) => (args.length > 1 ? null : "track"),
  describe: "A tracker, by name. Read where the tracked thing is, how it turned and scaled, or a corner of a tracked surface off it with a dot.",
  example: 'track("Face").position + vec(0, -80)',
  call: (args, ctx) => {
    const name = typeof args[0] === "string" ? args[0] : "";
    const id = name ? (ctx.tracks?.idFor(name) ?? "") : "";
    if (args.length < 2) return id;
    const reading = typeof args[1] === "string" ? args[1] : "";
    return (id && reading ? ctx.tracks?.read(id, reading) : undefined) ?? 0;
  },
});

/** The tracker API an expression context carries, for one comp at one instant. */
export function makeTrackApi(doc: MotionDocument, compId: string | null, timeMs: number): ExprTrackApi {
  const byId = (id: string) => doc.trackers.find((t) => t.id === id);
  return {
    // A KEY (`tracker:<id>`) is exact and rename-proof — what a pick writes;
    // a name is what a person types. The same two doors `layer()` has.
    idFor: (name) => trackerIdFor(doc, name),
    nameOf: (id) => byId(id)?.name,
    readingsOf: (id) => {
      const t = byId(id);
      return t ? TRACK_KINDS[t.kind].readings.map((r) => ({ id: r.id, type: r.type, describe: r.describe })) : [];
    },
    read: (id, reading): ExprValue | undefined => {
      const t = byId(id);
      if (!t || !compId) return undefined;
      return readTrack(doc, t, reading, { compId, compMs: timeMs }) ?? undefined;
    },
    all: () => doc.trackers.map((t) => ({ id: t.id, name: t.name })),
  };
}

/** A tracker by key (`tracker:<id>`), id or name — `track()`'s lookup. */
export function trackerIdFor(doc: MotionDocument, ref: string): string | undefined {
  const trimmed = ref.trim();
  const keyed = /^tracker:(\S+)$/.exec(trimmed);
  if (keyed) return doc.trackers.find((t) => t.id === keyed[1])?.id;
  const wanted = trimmed.toLowerCase();
  return doc.trackers.find((t) => t.id === trimmed || t.name.trim().toLowerCase() === wanted)?.id;
}

/** The source text that names a tracker: `track("tracker:<id>")`. */
export function trackReference(trackerId: string): string {
  return `track(${JSON.stringify(`tracker:${trackerId}`)})`;
}

/** The source text that reads one of a tracker's readings. */
export function trackReadingSource(trackerId: string, reading: string): string {
  return `${trackReference(trackerId)}.${reading}`;
}

/**
 * Drive `clipId`'s `path` from a tracker reading — a pick-whip landing on a
 * tracker. An ordinary expression, exactly as a layer link is (`driveWith`).
 */
export function linkPropertyToTrack(doc: MotionDocument, clipId: string, path: string, trackerId: string, reading: string): string | null {
  if (!doc.trackers.some((t) => t.id === trackerId)) return null;
  return driveWith(doc, clipId, path, trackReadingSource(trackerId, reading));
}
