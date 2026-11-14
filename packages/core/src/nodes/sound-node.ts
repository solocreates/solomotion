import { readSoundAnalysis } from "../sound-analysis/reader";
import { soundFeatureAt, soundRangeAt } from "../sound-analysis/query";
import { SOUND_FEATURES } from "../sound-analysis/types";
import { MAIN_SOCKET_KEY } from "./projection";
import type { NodeTypeDef } from "./registry";

/**
 * THE SOUND NODE — a recording's analysis on the board. Pick a sound layer
 * (or wire a Layer hub into it) and every feature is an output: level, the
 * bands, brightness, hits and the beat, 0 to 1, plus a band of your own and
 * the tempo. Its outputs are the feature registry (`SOUND_FEATURES`), so a
 * feature added there is a socket here with no change.
 *
 * It reads the same analysis as `sound()` through the same source-time map,
 * so a graph and an expression listening to one sound cannot disagree.
 */
export const SOUND_NODE_TYPE = "sound.listen";

export const soundNode: NodeTypeDef = {
  type: SOUND_NODE_TYPE,
  category: "sound",
  title: "Sound",
  description: "Listen to a sound layer: its level, bass, mid, treble, hits and beat as 0–1 values.",
  inputs: [
    { key: MAIN_SOCKET_KEY, label: "Layer", type: "any" },
    { key: "offsetMs", label: "Offset ms", type: "float", default: 0 },
    { key: "fromHz", label: "Band from Hz", type: "float", default: 40 },
    { key: "toHz", label: "Band to Hz", type: "float", default: 120 },
  ],
  outputs: [
    ...SOUND_FEATURES.map((f) => ({ key: f.id, label: f.label, type: "float" as const })),
    { key: "band", label: "Band", type: "float" },
    { key: "tempo", label: "Tempo", type: "float" },
  ],
  options: [{ key: "target", label: "Layer", kind: "string", default: "", pick: { kinds: ["layer"], tags: ["audible"] } }],
  evaluate: ({ inputs, params, ctx }) => {
    const silent = (): Record<string, number> => ({
      ...Object.fromEntries(SOUND_FEATURES.map((f) => [f.id, 0])),
      band: 0,
      tempo: 0,
    });
    const target = typeof params.target === "string" ? params.target : "";
    const offset = typeof inputs.offsetMs === "number" ? inputs.offsetMs : 0;
    const pos = target ? ctx.mediaAt?.(target, offset) : undefined;
    const a = pos ? readSoundAnalysis(pos.assetId) : null;
    if (!pos || !a) return silent();
    const from = typeof inputs.fromHz === "number" ? inputs.fromHz : 40;
    const to = typeof inputs.toHz === "number" ? inputs.toHz : 120;
    return {
      ...Object.fromEntries(SOUND_FEATURES.map((f) => [f.id, soundFeatureAt(a, pos.sourceMs, f.id)])),
      band: soundRangeAt(a, pos.sourceMs, from, to),
      tempo: a.tempo ?? 0,
    };
  },
};
