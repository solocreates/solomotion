import { cueIndexAt } from "./cues";
import type { VisemeCue } from "./types";
import { VISEME_FALLBACKS, VISEME_IDS, type VisemeId } from "./visemes";

/**
 * THE EVALUATION HARNESS — score any engine's cues against ground truth
 * (the Test Voice's exact cues, a hand-timed take), frame by frame.
 *
 *  accuracy          exact viseme match per frame
 *  tolerantAccuracy  a frame within ±toleranceMs of a truth boundary also
 *                    counts if the prediction matches either side (a swap one
 *                    frame early/late is invisible)
 *  nearAccuracy      exact, or the truth's first visual fallback (E for AI…)
 *  speechAccuracy    exact, over frames where the truth is speaking
 *  speaking          precision/recall of "mouth not at rest"
 *  changesPerSecond  how busy the prediction is (flicker)
 */
export interface CueScore {
  frames: number;
  accuracy: number;
  tolerantAccuracy: number;
  nearAccuracy: number;
  speechAccuracy: number;
  speaking: { precision: number; recall: number };
  changesPerSecond: number;
  /** confusion[truth][predicted] = frames. */
  confusion: Record<VisemeId, Record<VisemeId, number>>;
}

export interface EvaluateOptions {
  stepMs?: number;
  toleranceMs?: number;
  /** Scored span (default: the truth's). */
  fromMs?: number;
  toMs?: number;
}

const at = (cues: readonly VisemeCue[], t: number): VisemeId => {
  const i = cueIndexAt(cues, t);
  return i < 0 ? "X" : cues[i]!.viseme;
};

export function evaluateCues(predicted: readonly VisemeCue[], truth: readonly VisemeCue[], opts: EvaluateOptions = {}): CueScore {
  const step = opts.stepMs ?? 10;
  const tol = opts.toleranceMs ?? 0;
  const from = opts.fromMs ?? truth[0]?.startMs ?? 0;
  const to = opts.toMs ?? truth[truth.length - 1]?.endMs ?? 0;
  const confusion = Object.fromEntries(VISEME_IDS.map((v) => [v, Object.fromEntries(VISEME_IDS.map((w) => [w, 0]))])) as Record<VisemeId, Record<VisemeId, number>>;
  let frames = 0, exact = 0, tolerant = 0, near = 0, speech = 0, speechOk = 0, predSpeak = 0, bothSpeak = 0;
  for (let t = from + step / 2; t < to; t += step) {
    const p = at(predicted, t);
    const g = at(truth, t);
    frames++;
    confusion[g][p]++;
    if (p === g) exact++;
    if (p === g || (tol > 0 && (at(truth, t - tol) === p || at(truth, t + tol) === p))) tolerant++;
    if (p === g || VISEME_FALLBACKS[g][0] === p) near++;
    if (g !== "X") { speech++; if (p === g) speechOk++; }
    if (p !== "X") { predSpeak++; if (g !== "X") bothSpeak++; }
  }
  let changes = 0;
  for (let i = 1; i < predicted.length; i++) {
    const c = predicted[i]!;
    if (c.startMs >= from && c.startMs < to && c.viseme !== predicted[i - 1]!.viseme) changes++;
  }
  const r = (a: number, b: number) => (b > 0 ? a / b : 0);
  return {
    frames,
    accuracy: r(exact, frames),
    tolerantAccuracy: r(tolerant, frames),
    nearAccuracy: r(near, frames),
    speechAccuracy: r(speechOk, speech),
    speaking: { precision: r(bothSpeak, predSpeak), recall: r(bothSpeak, speech) },
    changesPerSecond: r(changes, (to - from) / 1000),
    confusion,
  };
}
