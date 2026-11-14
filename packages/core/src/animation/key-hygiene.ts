import type { Easing, Keyframe, KeyframeTrack, KeyframeValue, Transform } from "../schema";
import { reduceSamplesToKeys, type PerformSample } from "../perform/reduce";
import { sampleKeyframes, sampleKeyframeTrack, setKeyframe } from "./keyframes";

/**
 * KEYS A PERSON CAN EDIT — the one place that answers "is this track designed,
 * or was it sampled?", prints a track short enough to read, and turns a
 * sampled track back into a design.
 *
 * A designed track holds POSES: a handful of keys, each eased into the next. A
 * baked track holds a key on (nearly) every frame because something computed
 * the motion and wrote down every answer — a script's physics, a pasted
 * capture, an exporter's fallback. It plays identically and edits terribly:
 * nobody can retime a hop that is thirty keys, and two hundred thousand of them
 * make a project heavy to open, save and read. Agents fall into this most,
 * because sampling a formula is easier than choosing its poses.
 *
 * Simplify reuses the Perform reducer (`perform/reduce.ts`) — the same RDP →
 * eased monotone keys → verify-against-every-sample pass that turns a hand's
 * take into keys — so "fewest keys whose EASED playback stays within
 * tolerance" means one thing everywhere.
 */

/** A track keyed on nearly every frame: ≥ 12 keys whose typical gap is ≤ 1.5 frames. */
export function isBakedTrack(track: KeyframeTrack, stepMs: number): boolean {
  const n = track.keys.length;
  if (n < 12) return false;
  const times = track.keys.map((k) => k.timeMs).sort((a, b) => a - b);
  const gaps = times.slice(1).map((t, i) => t - times[i]!).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]! <= stepMs * 1.5;
}

/** An easing as the API writes it, so a digest can be pasted back into keyframes.set. */
export function easingWord(e: Easing): string {
  if (e.kind === "linear" || e.kind === "hold") return e.kind;
  if (e.kind === "preset") return e.name;
  return `cubic-bezier(${e.values.map((v) => Math.round(v * 1000) / 1000).join(",")})`;
}

function valueWord(v: KeyframeValue): string {
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  if (typeof v === "string") return v.length > 24 ? `${v.slice(0, 21)}…` : v;
  if (typeof v === "boolean") return String(v);
  if (v.length && typeof v[0] === "object") return "‹shape›";
  return `[${v.length}]`;
}

const curved = (k: Keyframe) => !!(k.spatial && (k.spatial.in || k.spatial.out));

/**
 * One track in one line: `time value easing` per key, `·` between, times on
 * the COMP clock (`startMs` = the layer's start). `↷` marks a key whose motion
 * path curves. The last key prints no easing — nothing leaves it.
 */
export function keyDigest(track: KeyframeTrack, startMs: number, maxKeys = 40): string {
  const keys = [...track.keys].sort((a, b) => a.timeMs - b.timeMs);
  const shown = keys.slice(0, maxKeys).map((k, i) => {
    const t = Math.round((startMs + k.timeMs) * 10) / 10;
    const tail = i < keys.length - 1 ? ` ${easingWord(k.easing)}` : "";
    return `${t} ${valueWord(k.value)}${curved(k) ? "↷" : ""}${tail}`;
  });
  return keys.length > maxKeys ? `${shown.join(" · ")} · … +${keys.length - maxKeys}` : shown.join(" · ");
}

// ── Simplify ─────────────────────────────────────────────────────────────────

const PIXEL_PROPS = new Set(["x", "y", "z", "width", "height"]);

/** The error a person cannot see, in the property's own units. */
export function simplifyTolerance(property: string, values: readonly number[]): number {
  if (PIXEL_PROPS.has(property)) return 0.5;
  if (/rotation|skew/i.test(property)) return 0.25;
  const range = Math.max(...values) - Math.min(...values);
  return Math.max(1e-4, range * 0.003);
}

export interface SimplifyOptions {
  /** The comp's frame step: samples are taken, and keys land, on its frames. */
  stepMs: number;
  /** A clip-local time on the frame grid (−clip.startMs puts frames on the comp's grid). */
  originMs: number;
  /** Max error of the played-back curve; omitted = `simplifyTolerance` per track. */
  tolerance?: number;
  /** Which tracks to simplify. */
  select: (track: KeyframeTrack) => boolean;
}

export interface SimplifyReport {
  property: string;
  before: number;
  after: number;
}

interface KeyHost {
  keyframes: KeyframeTrack[];
  transform: Transform;
}

/**
 * Re-key selected numeric tracks as the fewest eased keys that replay within
 * tolerance of what they play now, sampled on the comp's frames. Position x/y
 * are reduced TOGETHER from the true on-screen path (motion-path curves
 * included), so they stay aligned motion keys. Non-numeric tracks (colours,
 * shapes, switches) are left alone and reported. Mutates; call inside one
 * document update.
 */
export function simplifyKeyframes(host: KeyHost, opts: SimplifyOptions): { done: SimplifyReport[]; skipped: string[] } {
  const chosen = host.keyframes.filter((t) => t.keys.length >= 3 && opts.select(t));
  const done: SimplifyReport[] = [];
  const skipped: string[] = [];
  const numeric = (t: KeyframeTrack) => t.keys.every((k) => typeof k.value === "number");

  const xt = chosen.find((t) => !t.range && t.property === "x");
  const yt = chosen.find((t) => !t.range && t.property === "y");
  const groups: KeyframeTrack[][] = [];
  if (xt && yt) groups.push([xt, yt]);
  for (const t of chosen) if (!(xt && yt && (t === xt || t === yt))) groups.push([t]);

  for (const tracks of groups) {
    if (!tracks.every(numeric)) {
      skipped.push(...tracks.map((t) => t.property));
      continue;
    }
    const times = tracks.flatMap((t) => t.keys.map((k) => k.timeMs));
    const t0 = Math.min(...times);
    const t1 = Math.max(...times);
    const grid: number[] = [t0];
    const first = opts.originMs + Math.ceil((t0 - opts.originMs) / opts.stepMs + 1e-9) * opts.stepMs;
    for (let t = first; t < t1; t += opts.stepMs) if (t > t0) grid.push(t);
    grid.push(t1);

    const pair = tracks.length === 2;
    const samples: PerformSample[] = grid.map((t) => {
      if (pair) {
        const s = sampleKeyframes(host.keyframes, t); // applies the motion-path curve
        return { t, v: [Number(s["x"] ?? host.transform.x), Number(s["y"] ?? host.transform.y)] };
      }
      return { t, v: [Number(sampleKeyframeTrack(tracks[0]!, t))] };
    });
    const tol = tracks.map((tr, c) => opts.tolerance ?? simplifyTolerance(tr.property, samples.map((s) => s.v[c]!)));
    const keys = reduceSamplesToKeys(samples, tol);
    tracks.forEach((track, c) => {
      const before = track.keys.length;
      track.keys = [];
      for (const k of keys) setKeyframe(host.keyframes, track.property, k.t, k.v[c]!, k.easing[c]!, track.range);
      done.push({ property: track.property, before, after: track.keys.length });
    });
  }
  return { done, skipped };
}
