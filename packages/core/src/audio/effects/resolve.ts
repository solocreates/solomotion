import { sampleKeyframes, sampleNumber } from "../../animation/keyframes";
import { switchedOn, ENABLED_FIELD } from "../../animation/activeness";
import { resolveEffectValues } from "../../animation/effect-values";
import type { KeyframeValue, KeyframeTrack } from "../../schema";
import type { Modulator } from "../../schema/modulators";
import type { AudioEffect, AudioEffectType, AudioEqBand } from "../../schema/audio-effects";
import { AFX } from "./registry";

/**
 * WHAT DOES THIS CHAIN SOUND LIKE, RIGHT NOW?
 *
 * THE headless contract behind every audio surface: the live conductor, the
 * offline bake, the exporter, the A/B preview and the drawn EQ curve all call
 * this and get the same answer. Without it each would sample keyframes its own
 * way and a rendered file would quietly disagree with what was auditioned —
 * which is the single most expensive class of bug an editor can ship, because
 * you only find it after the export.
 *
 * Every numeric field funnels through `resolveEffectValues`, the same resolver
 * the visual effects use, so audio fields get keyframes, modulators and drivers
 * with no code of their own. Toggles (`pingPong`) and enum fields are modes, not
 * values, and are read straight off the instance.
 */

/** One effect with every field resolved to a concrete value at an instant. */
export interface ResolvedAudioEffect {
  id: string;
  type: AudioEffectType;
  /** Resolved numeric + enum fields, keyed by the registry's field keys. */
  values: Record<string, number | string>;
  /** Toggle states, read from the instance (modes never keyframe). */
  flags: Record<string, boolean>;
  /** Enabled bands with sampled gain/freq/Q — EQ only, empty otherwise. */
  bands: AudioEqBand[];
  /**
   * The clip-local instant these values were resolved at. A card with an LFO
   * starts its oscillator in phase with THIS, so a chain built mid-clip (a
   * preview) and one built at the start (an export) wobble in step.
   */
  localMs: number;
}

/** The keyframe path for one EQ band's value: `afx.<fxId>.band.<bandId>.<field>`. */
export function eqBandPath(effectId: string, bandId: string, field: "gain" | "freq" | "q"): string {
  return `${AFX.path(effectId, "band")}.${bandId}.${field}`;
}

/** Matches an EQ band path and pulls out its three ids. */
const EQ_BAND_PATH = /^afx\.([^.]+)\.band\.([^.]+)\.(gain|freq|q)$/;

export function parseEqBandPath(
  path: string,
): { effectId: string; bandId: string; field: "gain" | "freq" | "q" } | null {
  const m = EQ_BAND_PATH.exec(path);
  if (!m) return null;
  return { effectId: m[1]!, bandId: m[2]!, field: m[3]! as "gain" | "freq" | "q" };
}

/**
 * EVERY band of an EQ card, each value sampled through its own keyframe path —
 * so a whole curve can sweep over time (a filter opening across a drop).
 *
 * Disabled bands are KEPT here, because the two readers want different halves
 * of the same answer and only one of them is the signal path: the DSP chain
 * wants the audible bands (`resolveBands` below filters), while the curve editor
 * has to draw every handle including the muted ones. Splitting that into two
 * samplers is how the editor ended up drawing raw base values while the audio
 * played the keyframed ones — the curve and the sound disagreeing about the same
 * document, which is the exact bug this function exists to make impossible.
 */
export function sampleEqBands(
  effect: Extract<AudioEffect, { type: "eq" }>,
  sampled: Record<string, KeyframeValue>,
): AudioEqBand[] {
  return effect.bands.map((b) => ({
    ...b,
    gainDb: sampleNumber(sampled, eqBandPath(effect.id, b.id, "gain")) ?? b.gainDb,
    freqHz: sampleNumber(sampled, eqBandPath(effect.id, b.id, "freq")) ?? b.freqHz,
    q: sampleNumber(sampled, eqBandPath(effect.id, b.id, "q")) ?? b.q,
  }));
}

/**
 * The same bands at a clip-local instant, straight from a keyframe list — what
 * a UI has (tracks + a playhead) rather than what the chain resolver has (an
 * already-sampled record). Thin on purpose: one sampler, two entry points.
 */
export function eqBandsAt(
  effect: Extract<AudioEffect, { type: "eq" }>,
  keyframes: readonly KeyframeTrack[],
  localMs: number,
): AudioEqBand[] {
  return sampleEqBands(effect, sampleKeyframes(keyframes as KeyframeTrack[], localMs));
}

/** The AUDIBLE bands — the signal path, so nothing downstream re-checks `enabled`. */
function resolveBands(
  effect: Extract<AudioEffect, { type: "eq" }>,
  sampled: Record<string, KeyframeValue>,
): AudioEqBand[] {
  return sampleEqBands(effect, sampled).filter((b) => b.enabled);
}

export interface ResolveAudioOpts {
  /** The owning clip's modulators — a wiggle on a filter cutoff, for free. */
  modulators?: readonly Modulator[];
}

/**
 * Resolve a whole chain at a clip-local instant. DISABLED CARDS ARE DROPPED —
 * the returned list is the signal path, in order, and nothing downstream has to
 * re-check `enabled`. Order is preserved because order IS the chain.
 */
export function audioEffectsAt(
  effects: readonly AudioEffect[],
  keyframes: KeyframeTrack[],
  localMs: number,
  opts: ResolveAudioOpts = {},
): ResolvedAudioEffect[] {
  if (effects.length === 0) return [];
  const sampled = sampleKeyframes(keyframes, localMs);
  const timeSec = localMs / 1000;
  const out: ResolvedAudioEffect[] = [];

  for (const effect of effects) {
    // The card's eye is keyframable, so an EQ can drop out for a bar. Reading
    // the SAMPLED switch is the whole wiring — see `animation/activeness.ts`.
    if (!switchedOn(effect.enabled, AFX.path(effect.id, ENABLED_FIELD), sampled)) continue;
    const def = AFX.def(effect.type);
    if (!def) continue;

    const values = resolveEffectValues(
      def.fields,
      effect as unknown as Record<string, unknown>,
      sampled,
      (field) => AFX.path(effect.id, field),
      { modulators: opts.modulators, timeSec },
    );

    const flags: Record<string, boolean> = {};
    for (const t of def.toggles ?? []) {
      flags[t.key] = (effect as unknown as Record<string, unknown>)[t.key] === true;
    }

    out.push({
      id: effect.id,
      type: effect.type,
      values,
      flags,
      bands: effect.type === "eq" ? resolveBands(effect, sampled) : [],
      localMs,
    });
  }
  return out;
}

/**
 * A STRUCTURAL signature — which effects, in which order, with the settings
 * that require rebuilding native nodes rather than just re-pointing an
 * AudioParam. The live engine rebuilds its graph when this changes and
 * otherwise just moves values, so a keyframed dry/wet never tears down a
 * convolver sixty times a second.
 *
 * Reverb's room geometry is included because the impulse response is generated
 * from it — moving a wall genuinely is a new filter, not a new gain.
 */
export function audioChainSignature(chain: readonly ResolvedAudioEffect[]): string {
  return chain
    .map((fx) => {
      switch (fx.type) {
        case "eq":
          return `eq:${fx.id}:${fx.bands.map((b) => `${b.id}/${b.type}`).join("+")}`;
        // The room does NOT appear here. Resizing it regenerates the impulse
        // response, but that is the reverb node's own business and it debounces
        // the work — putting the geometry in the structural signature meant a
        // wall-drag tore down and rebuilt a convolver on every animation frame,
        // which is audible as a click and heavy enough to drop frames.
        case "reverb":
          return `reverb:${fx.id}`;
        case "echo":
          return `echo:${fx.id}:${fx.flags.pingPong ? "pp" : "st"}`;
        // The stage count is how many all-pass nodes exist — structure.
        case "phaser":
          return `phaser:${fx.id}:${fx.values.stages ?? ""}`;
        default:
          return `${fx.type}:${fx.id}:${fx.values.character ?? ""}`;
      }
    })
    .join(",");
}

/** Does this chain do anything audible at all? Cheap gate before building nodes. */
export function chainIsActive(effects: readonly AudioEffect[]): boolean {
  return effects.some((e) => e.enabled);
}
