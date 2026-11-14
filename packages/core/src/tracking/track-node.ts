import type { NodeTypeDef } from "../nodes/registry";
import { REGION_READINGS } from "./read";

/**
 * THE TRACK NODE — a tracker on the board. Pick one and every reading is an
 * output: position, the corners of a tracked surface, rotation, scale,
 * confidence. Its outputs ARE the readings table (`REGION_READINGS`), so a
 * reading added there is a socket here with no change, and it reads through
 * the same reader as `track()` — a graph and a sentence cannot disagree.
 */
export const TRACK_NODE_TYPE = "track.read";

export const trackNode: NodeTypeDef = {
  type: TRACK_NODE_TYPE,
  category: "track",
  title: "Track",
  description: "Read a tracker: where the tracked thing is, how it turned and scaled, the corners of a tracked surface, how sure it is.",
  inputs: [],
  outputs: REGION_READINGS.map((r) => ({ key: r.id, label: r.label, type: r.type })),
  // Not `target`: that key is the Layer row's on a card, and a tracker is not a layer.
  options: [{ key: "tracker", label: "Tracker", kind: "string", default: "", pick: { kinds: ["tracker"] } }],
  evaluate: ({ params, ctx }) => {
    const target = typeof params.tracker === "string" ? params.tracker : "";
    const out: Record<string, number | boolean | { x: number; y: number }> = {};
    for (const r of REGION_READINGS) {
      const v = target ? ctx.trackAt?.(target, r.id) : undefined;
      out[r.id] = v !== undefined && typeof v !== "string" ? v : r.type === "vec2" ? { x: 0, y: 0 } : r.type === "bool" ? false : 0;
    }
    return out;
  },
};
