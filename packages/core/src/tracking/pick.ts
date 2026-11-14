import type { MotionDocument } from "../schema";
import type { Tracker } from "../schema/tracking";
import { registerPickProvider, type PickCandidate } from "../query/pick";
import { footageClips } from "./footage";
import { trackReadings } from "./read";

/**
 * TRACKERS ARE PICKABLE — the `tracker:` family the pick registry reserved,
 * and the readings under it.
 *
 *   tracker        `tracker:<id>` — the thing itself: a Follow field, a Track
 *                  node, a grade window's source.
 *   track-reading  `track-reading:<trackerId>/<reading>` — one value off it,
 *                  typed from the kind's readings table, so a pick-whip can land
 *                  `track("Face").position` in a position field and refuses to
 *                  land a corner in an opacity.
 *
 * A tracker lives in the comp its footage is placed in (the clip it was drawn
 * through, else the first that shows its source), which is what `frameId`
 * filters on — a field in another comp could not read it anyway.
 */

const memoFor = <T>(project: (doc: MotionDocument) => T) => {
  const cache = new WeakMap<MotionDocument, T>();
  return (doc: MotionDocument): T => {
    let hit = cache.get(doc);
    if (hit === undefined) cache.set(doc, (hit = project(doc)));
    return hit;
  };
};

function trackerHome(doc: MotionDocument, t: Tracker): string | null {
  const clips = footageClips(doc, t);
  return (clips.find((c) => c.id === t.via) ?? clips[0])?.frameId ?? null;
}

const footageName = (doc: MotionDocument, t: Tracker) => doc.assets.find((a) => a.id === t.source.assetId)?.name ?? "Footage";

const trackers = memoFor((doc) => {
  const list: PickCandidate[] = doc.trackers.map((t) => {
    const where = footageName(doc, t);
    return {
      key: `tracker:${t.id}`,
      kind: "tracker",
      id: t.id,
      name: t.name,
      where,
      // The kind, what it solves and whose footage it is are facets:
      // "surfaces only" and "this plate's trackers" are filters, not code.
      tags: [
        t.kind,
        `asset:${t.source.assetId}`,
        ...(t.kind === "region"
          ? [...t.solve.channels, ...(t.samples.length ? ["solved"] : [])]
          : t.kind === "camera"
            ? t.solution ? ["solved", "3d"] : ["3d"]
            : t.maps ? ["solved", "depth"] : ["depth"]),
      ],
      hay: `${t.name} ${where} tracker`.toLowerCase(),
      frameId: trackerHome(doc, t),
      pageId: null,
      type: "track",
      glyph: "tracker",
    };
  });
  return { list, byId: new Map(list.map((c) => [c.id, c])) };
});

const readings = memoFor((doc) => {
  const list: PickCandidate[] = [];
  for (const t of doc.trackers) {
    const home = trackers(doc).byId.get(t.id);
    for (const r of trackReadings(t)) {
      list.push({
        key: `track-reading:${t.id}/${r.id}`,
        kind: "track-reading",
        id: `${t.id}/${r.id}`,
        name: r.label,
        where: t.name,
        tags: [r.type],
        hay: `${r.label} ${r.id} ${t.name}`.toLowerCase(),
        frameId: home?.frameId ?? null,
        pageId: null,
        ownerId: t.id,
        type: r.type,
        path: r.id,
        group: t.name,
        glyph: "tracker",
      });
    }
  }
  return { list, byId: new Map(list.map((c) => [c.id, c])) };
});

registerPickProvider({
  kind: "tracker",
  prefix: "tracker",
  noun: "tracker",
  candidates: (doc) => trackers(doc).list,
  resolve: (doc, id) => trackers(doc).byId.get(id) ?? null,
});

registerPickProvider({
  kind: "track-reading",
  prefix: "track-reading",
  noun: "tracked value",
  candidates: (doc) => readings(doc).list,
  resolve: (doc, id) => readings(doc).byId.get(id) ?? null,
});

/** The key of one reading — the pick-whip's preferred row. */
export const trackReadingPickKey = (trackerId: string, reading: string): string => `track-reading:${trackerId}/${reading}`;
