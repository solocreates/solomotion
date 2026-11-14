import { registerExprFunction } from "../expressions/functions";
import type { ExprContext } from "../expressions/globals";
import type { ExprValue } from "../expressions/types";
import { resolveScopedLayer } from "../components/inputs";
import { soundFeatureAt, soundRangeAt } from "./query";
import { readSoundAnalysis } from "./reader";
import { SOUND_FEATURES, soundFeatureDef, type SoundAnalysis } from "./types";

/**
 * `sound()`, `soundBand()`, `soundTempo()` — ANY VALUE CAN LISTEN.
 *
 * Nothing is baked into keys: `scale = 1 + 0.2 * sound("Music", "bass")`
 * reads the music's analysis at this instant, through the music clip's own
 * time map (trim, speed, loop, reverse), so moving or retiming the music moves
 * everything that listens to it. The layer is a name or id, resolved in the
 * current comp and then up the instance chain, so `sound(input("Music"))`
 * inside a component listens to whatever plays beside the instance.
 *
 * Every read is 0 until the sound's analysis exists; asking for it is what
 * queues the analysis (`readSoundAnalysis`). Values are the SOUND's own,
 * before the clip's volume — a fade-out does not shrink what listens to it.
 */

interface Heard {
  analysis: SoundAnalysis;
  sourceMs: number;
}

function heard(ctx: ExprContext, ref: ExprValue | undefined, offsetMs: number): Heard | null {
  const name = typeof ref === "string" ? ref : "";
  const at = name ? resolveScopedLayer(ctx, name) : null;
  const src = at?.layers.sourceOf?.(at.clipId, offsetMs);
  if (!src) return null;
  const analysis = readSoundAnalysis(src.assetId);
  return analysis ? { analysis, sourceMs: src.sourceMs } : null;
}

const num = (v: ExprValue | undefined, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

const layerParam = { name: "layer", type: "string" as const, describe: "The sound’s layer name as the timeline shows it (an audio layer, or a video with sound) — or input(\"Music\") inside a component." };
const offsetParam = { name: "offsetMs", type: "float" as const, optional: true, describe: "Listen earlier (negative) or later, in ms — a lead makes motion land with the hit." };

registerExprFunction({
  name: "sound",
  category: "sound",
  params: [
    layerParam,
    {
      name: "feature",
      type: "string",
      optional: true,
      describe: `What to listen for, 0 to 1: ${SOUND_FEATURES.map((f) => `"${f.id}"`).join(", ")}. Default "level".`,
    },
    offsetParam,
  ],
  returns: "float",
  describe: "How much of something a sound has right now, 0 to 1 — its level, a band like the bass, its brightness, its hits or its beat.",
  example: 'map(sound("Music", "bass"), 0, 1, 1, 1.3)',
  call: (args, ctx) => {
    const feature = soundFeatureDef(typeof args[1] === "string" && args[1] ? args[1] : "level");
    const h = feature ? heard(ctx, args[0], num(args[2])) : null;
    return h && feature ? soundFeatureAt(h.analysis, h.sourceMs, feature.id) : 0;
  },
});

registerExprFunction({
  name: "soundBand",
  category: "sound",
  params: [
    layerParam,
    { name: "fromHz", type: "float", describe: "Bottom of the band, Hz." },
    { name: "toHz", type: "float", describe: "Top of the band, Hz." },
    offsetParam,
  ],
  returns: "float",
  describe: "The energy of any stretch of the spectrum right now, 0 to 1 — for when bass, mid and treble are not the band you need.",
  example: 'soundBand("Music", 40, 90)',
  call: (args, ctx) => {
    const h = heard(ctx, args[0], num(args[3]));
    return h ? soundRangeAt(h.analysis, h.sourceMs, num(args[1], 20), num(args[2], 20000)) : 0;
  },
});

registerExprFunction({
  name: "soundTempo",
  category: "sound",
  params: [layerParam],
  returns: "float",
  describe: "The sound’s tempo in beats per minute, or 0 when it has no steady beat.",
  example: 'time * soundTempo("Music") / 60',
  call: (args, ctx) => {
    const h = heard(ctx, args[0], 0);
    return h?.analysis.tempo ?? 0;
  },
});
