import { cueIndexAt, energyAt, type VisemeCue } from "@solomotion/lipsync";
import { registerExprFunction } from "../expressions/functions";
import type { ExprContext } from "../expressions/globals";
import type { ExprValue } from "../expressions/types";
import { resolveScopedLayer } from "../components/inputs";
import { resolvePoseName } from "../rig/vocabulary";
import { actedCues, energyGain } from "./feel";
import { readSpeechTrack } from "./reader";
import { REST_VISEME, type MediaPosition, type SpeechTrack } from "./types";

/**
 * `lipsync()`, `speaking()`, `loudness()` — LIP SYNC AS A VALUE SOURCE.
 *
 * Nothing writes keys: a mouth's channel (a switch's `switch`, a pose set's
 * `pose.<set>`) is driven by `lipsync("Voice")`, which answers the shape at
 * the instant — through the voice clip's own time map (trim, speed, loop,
 * reverse), the voice's Feel and hand fixes, and the mouth's kind. Retime,
 * trim, move or replace the audio and the mouth follows; there is nothing to
 * regenerate.
 *
 * The voice is a layer name or id, resolved in the current comp and then up
 * the instance chain (`resolveScopedLayer`), so `lipsync(input("Voice"))`
 * inside a character speaks the clip beside the instance.
 *
 * Every read is rest (`X`, 0) until the track exists; asking for it is what
 * queues the analysis (`readSpeechTrack`).
 */

interface Heard {
  src: MediaPosition;
  track: SpeechTrack;
  fps: number;
}

function heard(ctx: ExprContext, ref: ExprValue | undefined): Heard | null {
  const name = typeof ref === "string" ? ref : "";
  const at = name ? resolveScopedLayer(ctx, name) : null;
  const src = at?.layers.sourceOf?.(at.clipId);
  if (!src) return null;
  const track = readSpeechTrack(src.assetId);
  return track ? { src, track, fps: ctx.fps } : null;
}

/** The mouth this expression drives — the layer it is attached to. */
function drivenMouth(ctx: ExprContext) {
  return ctx.layer ? ctx.layers?.mouth?.(ctx.layer.id) : undefined;
}

function actedCueAt(h: Heard, ctx: ExprContext): VisemeCue | null {
  const kind = drivenMouth(ctx)?.kind ?? "drawings";
  const cues = actedCues(h.track, { kind, fps: h.fps, speech: h.src.asset?.speech });
  const i = cueIndexAt(cues, h.src.sourceMs);
  return i < 0 ? null : cues[i]!;
}

/** A viseme as THIS mouth can show it: its own member of that name, else the nearest drawn shape. */
function asShown(viseme: string, ctx: ExprContext): string {
  const choices = drivenMouth(ctx)?.choices;
  if (!choices?.length) return viseme;
  return resolvePoseName("visemes", viseme, choices) ?? choices[0]!;
}

const voiceParam = { name: "voice", type: "string" as const, describe: "The voice layer’s name as the timeline shows it — or input(\"Voice\") inside a character." };

registerExprFunction({
  name: "lipsync",
  category: "character",
  params: [voiceParam],
  returns: "string",
  describe:
    "The mouth shape the voice is making now — Rest, MBP, AI, E, O, U, FV, L or S — through its trim and speed, its Feel and your hand fixes. Drive a mouth switch or pose set with it; a mouth missing a shape shows its nearest one.",
  example: 'lipsync("Voice")',
  call: (args, ctx) => {
    const h = heard(ctx, args[0]);
    const cue = h ? actedCueAt(h, ctx) : null;
    return asShown(cue?.viseme ?? REST_VISEME, ctx);
  },
});

registerExprFunction({
  name: "speaking",
  category: "character",
  params: [voiceParam],
  returns: "float",
  describe: "1 while the voice is saying something, 0 in its pauses — breaths and room noise don’t count.",
  example: 'if(speaking("Voice") > 0, "Talk", "Idle")',
  call: (args, ctx) => {
    const h = heard(ctx, args[0]);
    const v = h ? actedCueAt(h, ctx)?.viseme : undefined;
    return v && v !== REST_VISEME ? 1 : 0;
  },
});

registerExprFunction({
  name: "loudness",
  category: "character",
  params: [voiceParam],
  returns: "float",
  describe: "How loud the voice is now, 0 to 1, smoothed and scaled by its Energy — open a jaw with it, or nod a head.",
  example: 'map(loudness("Voice"), 0, 1, 0, 18)',
  call: (args, ctx) => {
    const h = heard(ctx, args[0]);
    if (!h) return 0;
    const v = energyAt(h.track.energy, h.src.sourceMs) * energyGain(h.src.asset?.speech);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  },
});
