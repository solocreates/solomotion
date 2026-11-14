import type { KeyframeValue } from "../schema";
import type { Modulator } from "../schema/modulators";
import { applyModulators } from "./modulators";
import { isReferenceField, type EffectFieldDef } from "./effect-base";

/**
 * ONE resolver for "what is this effect's field worth, right now, at this
 * render scale?" — the three rules every effect field obeys, in one place:
 *
 *   1. a sampled keyframe (`lfx.<id>.<key>`, `afx.<id>.<key>`) beats the base,
 *   2. colors resolve through the document's variable table,
 *   3. MODULATORS bound to the path wobble/pulse/scale that result — applied
 *      here, before scaling, because a modulator's amplitude is authored in the
 *      field's own units and must not be re-scaled twice,
 *   4. fields flagged `scaled` are authored in FRAME px and multiply by the
 *      render scale, so they read identically at any zoom and in exports.
 *
 * Rule 3 is the reason this function is worth the indirection: because EVERY
 * effect field in the app funnels through here, binding a modulator to any of
 * them — a scanline's pitch, a shadow's blur, a grade's exposure — needs no
 * per-effect code at all. An effect written next year is modulatable the day
 * it ships.
 *
 * Before this, every effect re-implemented (1) and (3) as ad-hoc closures in
 * the draw path and quietly disagreed about which fields were scaled — the
 * defect this kills. Effects with a handful of fields still read fine inline;
 * rich ones (glass has thirty) get the whole bag in a line.
 */
export function resolveEffectValues(
  fields: readonly EffectFieldDef[],
  effect: Record<string, unknown>,
  sampled: Record<string, KeyframeValue>,
  path: (field: string) => string,
  opts: {
    scale?: number;
    resolveColor?: (c: string) => string;
    /** The owning clip's modulator list — only paths it targets pay any cost. */
    modulators?: readonly Modulator[];
    /** The clip's LOCAL time in seconds; modulators are functions of it. */
    timeSec?: number;
  } = {},
): Record<string, number | string> {
  const scale = opts.scale ?? 1;
  const timeSec = opts.timeSec ?? 0;
  const out: Record<string, number | string> = {};
  for (const f of fields) {
    const keyed = sampled[path(f.key)];
    if (f.kind === "color") {
      const raw = typeof keyed === "string" ? keyed : (effect[f.key] as string) ?? "#000000";
      out[f.key] = opts.resolveColor ? opts.resolveColor(raw) : raw;
    } else if (f.kind === "select") {
      // An enum holds its value (no interpolation) and is never a colour or a
      // scaled length, so it takes neither of the other two rules. A sampled
      // key that isn't one of the declared options is ignored rather than
      // trusted — a stale keyframe from a renamed option must not render a
      // shape nothing knows how to draw.
      const keyedOk = typeof keyed === "string" && (f.options?.some((o) => o.value === keyed) ?? false);
      out[f.key] = keyedOk ? (keyed as string) : String(effect[f.key] ?? f.options?.[0]?.value ?? "");
    } else if (isReferenceField(f.kind)) {
      // An id (a layer, a pose, an image asset): passed through, never scaled
      // or modulated — a reference read as a number is NaN.
      out[f.key] = String(effect[f.key] ?? "");
    } else {
      const base = typeof keyed === "number" ? keyed : Number(effect[f.key] ?? 0);
      const v = Number.isFinite(base) ? base : 0;
      const modulated = applyModulators(opts.modulators, path(f.key), v, timeSec, sampled);
      out[f.key] = f.scaled ? modulated * scale : modulated;
    }
  }
  return out;
}
