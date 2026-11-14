import { z } from "zod";
import {
  animationUnitSchema,
  keyframeValueSchema,
  type MotionDocument,
  type Clip,
  type Easing,
  type KeyframeRange,
  type KeyframeValue,
} from "../../schema";
import { setKeyframe } from "../../animation/keyframes";
import { arcTangents, setMotionTangent } from "../../animation/motion-path";
import { bounceKeys } from "../../animation/bounce";
import { isBakedTrack, keyDigest, simplifyKeyframes } from "../../animation/key-hygiene";
import { compFps, frameStepMs } from "../../timeline/fps";
import { linear } from "../../easing";
import { clearClipKeyframes } from "../../animation/paths";
import { ANIMATION_PRESETS, getPreset, retargetAnimSpec } from "../../animation/presets";
import { layerPresetsFor, retargetLayerSpec } from "../../animation/layer-animation";
import { LFX } from "../../animation/layer-effects";
import { TFX } from "../../animation/text-effects";
import { AFX } from "../../audio/effects/registry";
import { EFFECT_CATEGORIES, type EffectFieldDef, type EffectRegistry, type EffectTypeDefBase, type BaseEffect } from "../../animation/effect-base";
import { TEXT_TEMPLATES } from "../../templates/catalog";
import { TRANSITION_PRESETS } from "../../animation/transitions";
import { EASING_PRESET_LABELS } from "../../easing";
import { ENVIRONMENT_PRESETS, LIGHT_TYPES, blendModeSchema } from "../../schema";
import { PRIMITIVES } from "../../world/primitives";
import { MDF, MODIFIERS } from "../../world/modifiers";
import { FORCE } from "../../physics/forces";
import { EMITTER, EMITTER_LOOKS } from "../../physics/emitters";
import { SOUND_SETS } from "../../audio/sound-sets";
import { isBodyKind } from "../../world/body";
import { isWorldFrame } from "../../world/evaluate";
import { MATERIAL_PRESETS } from "../../world/material-presets";
import { LIGHT_DEFAULTS } from "../../world/ops";
import { ApiError, defineCommand } from "../command";
import { requireClip, resolveTargetFrame } from "../lookup";
import { locateFrame } from "../../timeline/ops";
import { ensureFrameEffectClipIn } from "../../timeline/frame-effect-edit";
import { allLooks, applyLookAsGroup, findLook, lookCards, lookRow, lookShortId, type LookDomain } from "../../presets/looks";
import { groupMembers, isEffectGroup, type GroupableEffect } from "../../animation/effect-groups";
import { SURFACE_MATERIALS, SURFACE_MORPH_STYLES } from "../../schema/layer-effects";
import { easingInputSchema, parseEasing } from "../values";
import { assertPath, canonicalInputWrite, canonicalPath, knownPaths, storedValue, validClip, withLengthUnit } from "./edit";

/**
 * MOTION — keyframes, in/out animations, effect stacks, and the catalogues
 * that say what exists to choose from.
 */

// ── Keyframes ────────────────────────────────────────────────────────────────

type BounceInput = true | { count?: number; decay?: number };
type KeyInput = { at: number; value: KeyframeValue; easing?: z.infer<typeof easingInputSchema>; bounce?: BounceInput };

/** Keys with `bounce` become their impacts and apexes (`bounceKeys`), already eased. */
function expandBounces(keys: KeyInput[]): Array<KeyInput | { at: number; value: KeyframeValue; parsed: Easing }> {
  const sorted = [...keys].sort((a, b) => a.at - b.at);
  return sorted.flatMap((k, i) => {
    if (!k.bounce) return [k];
    const next = sorted[i + 1];
    if (!next || typeof k.value !== "number" || typeof next.value !== "number") {
      throw new ApiError(`Key at ${k.at} bounces, but it needs a number value and a later key to land on.`);
    }
    return bounceKeys(k.at, k.value, next.at, next.value, k.bounce === true ? {} : k.bounce).map((b) => ({ at: b.at, value: b.value, parsed: b.easing }));
  });
}

const vec2Input = z.tuple([z.number(), z.number()]);

export const keyframesSet = defineCommand({
  id: "keyframes.set",
  summary: "Key a property over time: a list of {at, value, easing} on one property path.",
  details:
    "`at` is ms from the LAYER'S START by default (clock: layer), or comp time (clock: comp). Easing on a key shapes the segment LEAVING it; `hold` keeps the value until the next key, then cuts. `replace` (default true) clears the property's existing keys first. Any path from layer.properties can be keyed — transform, opacity, colours, effect fields, typography, trim. `position` keys x and y together as `[x, y]` motion keys: `arc` on a key makes the segment leaving it a thrown arc peaking that many px above the higher end (negative sags below) — with the default linear easing that is real gravity, one key per landing; `in`/`out` set curve handles (relative px) for any other path shape. `bounce` on a number key (`y`, `scale`…) drops to the next key and bounces, as ordinary keys; key `x` and `y` separately to ease each its own way. For a slice of text, pass `range` {start,end} in graphemes. A size keys in a unit by text (`2spx`, `50fw`; see layer.set) — one unit per track. MORPH a path layer by keying `geometry` with SVG `d` strings; shapes morph point-to-point when they have the same number of contours and points (write both with the same command sequence).",
  effect: "write",
  input: z.object({
    id: z.string(),
    property: z.string(),
    keys: z
      .array(
        z.object({
          at: z.number(),
          value: keyframeValueSchema,
          easing: easingInputSchema.optional(),
          arc: z.number().optional().describe("position only: the segment leaving this key is a thrown arc peaking this many px above the higher end (negative: sags below). Easing defaults to linear = gravity."),
          in: vec2Input.nullable().optional().describe("position only: the curve handle arriving at this key, px relative to it."),
          out: vec2Input.nullable().optional().describe("position only: the curve handle leaving this key, px relative to it."),
          bounce: z
            .union([z.literal(true), z.object({ count: z.number().int().min(1).max(12).optional(), decay: z.number().min(0.01).max(0.95).optional() })])
            .optional()
            .describe("number properties: the segment leaving this key drops to the next key's value and bounces (`count` rebounds, default 3; each `decay` × the last, default 0.35). Becomes real keys."),
        }),
      )
      .min(1),
    clock: z.enum(["layer", "comp"]).default("layer"),
    replace: z.boolean().default(true),
    range: z.object({ start: z.number().int().min(0), end: z.number().int().min(1) }).optional(),
  }),
  run(input, rt) {
    const position = input.property === "position";
    if (!position && input.keys.some((k) => k.arc !== undefined || k.in !== undefined || k.out !== undefined)) {
      throw new ApiError("`arc`, `in` and `out` shape a motion path.", 'Key property "position" with [x, y] values to use them.');
    }
    if (position && input.keys.some((k) => k.bounce)) {
      throw new ApiError("`bounce` keys one number.", "Key `y` with the bounce and `x` on its own keys — each dimension takes its own easing.");
    }
    let outside: { span: [number, number]; at: number[] } | null = null;
    let keyed = input.property;
    rt.write(`Keyframe ${input.property}`, (d) => {
      const clip = requireClip(d, input.id).clip;
      const local = (at: number) => (input.clock === "comp" ? at - clip.startMs : at);
      // A key the layer never reaches plays nothing — an emitter keyed past
      // its null's end never fired, silently. Written anyway (the layer may be
      // trimmed longer later), and said.
      const late = input.keys.map((k) => local(k.at)).filter((t) => t < 0 || t > clip.durationMs);
      if (late.length) outside = { span: [clip.startMs, clip.startMs + clip.durationMs], at: late.map((t) => t + clip.startMs) };
      if (position) {
        writePositionKeys(clip, d, input.keys, local, input.replace, input.range);
        return;
      }
      const property = canonicalPath(clip, input.property, d);
      keyed = property;
      assertPath(clip, property, knownPaths(clip, d));
      const range: KeyframeRange | null = input.range ?? null;
      if (input.replace) {
        clip.keyframes = clip.keyframes.filter(
          (t) => !(t.property === property && JSON.stringify(t.range ?? null) === JSON.stringify(range)),
        );
      }
      for (const key of expandBounces(input.keys)) {
        const easing = "parsed" in key ? key.parsed : parseEasing(key.easing);
        const value = canonicalInputWrite(clip, property, key.value, d).value;
        const k = setKeyframe(clip.keyframes, property, local(key.at), storedValue(property, withLengthUnit(clip, property, value, d)), easing, range);
        if (easing) k.easing = easing; // a key that already stood here keeps its value's place, not its old curve
      }
      validClip(clip, `Keying ${property}`);
    });
    const off = outside as { span: [number, number]; at: number[] } | null;
    return {
      property: keyed,
      keys: input.keys.length,
      ...(off
        ? { warning: `${off.at.length} key(s) at comp ${off.at.map(Math.round).join(", ")} ms fall outside the layer, which lives ${Math.round(off.span[0])}–${Math.round(off.span[1])} ms: the layer is never there to reach them (an emitter keyed there never fires). timeline.trim the layer to cover them.` }
        : {}),
    };
  },
});

type PositionKeyInput = {
  at: number;
  value: unknown;
  easing?: z.infer<typeof easingInputSchema>;
  arc?: number;
  in?: [number, number] | null;
  out?: [number, number] | null;
};

/** `position` keys → aligned x/y motion keys with their curve handles (motion-path.ts does the writing). */
function writePositionKeys(
  clip: Clip,
  doc: MotionDocument,
  keys: readonly PositionKeyInput[],
  local: (at: number) => number,
  replace: boolean,
  range: unknown,
): void {
  if (range) throw new ApiError("`position` animates the whole layer; it takes no text `range`.");
  if (!("transform" in clip)) throw new ApiError(`"${clip.name}" has no position.`);
  const paths = knownPaths(clip, doc);
  assertPath(clip, "x", paths);
  assertPath(clip, "y", paths);
  const sorted = [...keys].sort((a, b) => a.at - b.at);
  const pts = sorted.map((k, i) => {
    const v = k.value;
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new ApiError(`position key ${i} needs a value [x, y]; got ${JSON.stringify(v)}.`);
    }
    return { x: v[0] as number, y: v[1] as number };
  });
  sorted.forEach((k, i) => {
    if (k.arc && sorted[i + 1]?.in) {
      throw new ApiError(`position key ${i} throws an \`arc\` into key ${i + 1}, which also sets its own \`in\` handle.`, "One curve per segment: keep the arc or the handle.");
    }
  });
  if (replace) clip.keyframes = clip.keyframes.filter((t) => t.range || (t.property !== "x" && t.property !== "y"));
  sorted.forEach((k, i) => {
    const t = local(k.at);
    const easing = parseEasing(k.easing) ?? (k.arc ? linear : undefined);
    const xk = setKeyframe(clip.keyframes, "x", t, pts[i]!.x, easing);
    const yk = setKeyframe(clip.keyframes, "y", t, pts[i]!.y, easing);
    if (easing) xk.easing = yk.easing = easing;
  });
  sorted.forEach((k, i) => {
    const t = local(k.at);
    if (k.in !== undefined) setMotionTangent(clip, t, "in", k.in && { x: k.in[0], y: k.in[1] });
    if (k.out !== undefined) setMotionTangent(clip, t, "out", k.out && { x: k.out[0], y: k.out[1] });
    const next = sorted[i + 1];
    const arc = next && k.arc ? arcTangents(pts[i]!, pts[i + 1]!, k.arc) : null;
    if (arc && next) {
      setMotionTangent(clip, t, "out", arc.aOut);
      setMotionTangent(clip, local(next.at), "in", arc.bIn);
    }
  });
  validClip(clip, "Keying position");
}

export const keyframesClear = defineCommand({
  id: "keyframes.clear",
  summary: "Remove keyframes from properties, freezing each at its value at `atMs` (so nothing jumps).",
  effect: "write",
  input: z.object({
    id: z.string(),
    properties: z.array(z.string()).optional().describe("Omitted = every keyed property."),
    atMs: z.number().optional().describe("Comp time to freeze at; default the playhead."),
  }),
  run(input, rt) {
    let removed = 0;
    rt.write("Clear keyframes", (d) => {
      const clip = requireClip(d, input.id).clip;
      const props = input.properties?.map((p) => canonicalPath(clip, p, d)) ?? [...new Set(clip.keyframes.map((t) => t.property))];
      const local = (input.atMs ?? rt.session.playheadMs()) - clip.startMs;
      removed = clearClipKeyframes(clip, props, Math.max(0, Math.min(clip.durationMs, local)));
    });
    return { removed };
  },
});

/** The comp-clock frame step a layer's keys live on. */
const stepOf = (doc: MotionDocument, clip: Clip) => frameStepMs(compFps(doc, clip.frameId));

export const keyframesInspect = defineCommand({
  id: "keyframes.inspect",
  summary: "Keys at a glance: one layer's tracks, each in one line — or a comp's key budget with its baked tracks flagged.",
  details:
    "With `id`: every track as `time value easing` per key (comp ms; `↷` = a curved motion-path key; the last key has no easing). Paste a line's easings straight back into keyframes.set. Without `id`: the comp's totals and its heaviest tracks. A track keyed on nearly every frame is `baked` — a sampled formula, not a design: it plays fine and edits terribly. Rewrite it as poses + easing, or run keyframes.simplify.",
  effect: "read",
  input: z.object({
    id: z.string().optional().describe("A layer: list its tracks key by key."),
    frameId: z.string().optional().describe("A comp to audit (default: the focused one) when no `id` is given."),
    properties: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(200).default(20).describe("Comp audit: how many of the heaviest tracks to list."),
  }),
  run(input, rt) {
    const d = rt.doc();
    let wanted = input.properties;
    const pick = (p: string) => !wanted || wanted.includes(p);
    if (input.id) {
      const clip = requireClip(d, input.id).clip;
      wanted = wanted?.map((p) => canonicalPath(clip, p, d));
      const step = stepOf(d, clip);
      return {
        layer: clip.name,
        clock: "comp",
        tracks: clip.keyframes
          .filter((t) => t.keys.length && pick(t.property))
          .map((t) => ({
            property: t.property,
            ...(t.range ? { range: t.range } : {}),
            n: t.keys.length,
            ...(isBakedTrack(t, step) ? { baked: true } : {}),
            keys: keyDigest(t, clip.startMs),
          })),
      };
    }
    const frame = resolveTargetFrame(rt, input.frameId);
    const step = frameStepMs(compFps(d, frame.id));
    let layers = 0, tracks = 0, keys = 0, bakedTracks = 0, bakedKeys = 0;
    const rows: Array<{ n: number; row: string }> = [];
    for (const clip of d.tracks.flatMap((t) => t.clips)) {
      if (clip.frameId !== frame.id || !clip.keyframes.length) continue;
      layers++;
      for (const t of clip.keyframes) {
        if (!t.keys.length || !pick(t.property)) continue;
        const baked = isBakedTrack(t, step);
        tracks++;
        keys += t.keys.length;
        if (baked) (bakedTracks++, (bakedKeys += t.keys.length));
        rows.push({ n: t.keys.length, row: `${clip.name} · ${t.property}: ${t.keys.length}${baked ? " baked" : ""} (${clip.id})` });
      }
    }
    rows.sort((a, b) => b.n - a.n);
    return {
      comp: frame.name,
      layers,
      tracks,
      keys,
      baked: { tracks: bakedTracks, keys: bakedKeys },
      heaviest: rows.slice(0, input.limit).map((r) => r.row),
    };
  },
});

export const keyframesSimplify = defineCommand({
  id: "keyframes.simplify",
  summary: "Turn sampled, frame-by-frame keys into the fewest eased keys that play the same (within a tolerance).",
  details:
    "The Perform reducer, run on keys that already exist: it samples what plays on every frame, keeps the fewest keys whose EASED playback stays within `tolerance` of it, and writes them on frames. Position x/y are reduced together from the true path, so they stay motion keys. Default tolerance: 0.5 px for position and size, 0.25° for rotation, 0.3% of the range otherwise. `id` = one layer (every numeric track with 3+ keys, or `properties`); `frameId` alone = every BAKED track in that comp. Colours, shapes and switches are left as they are. Simplify repairs; for new motion, write poses with easing in the first place.",
  effect: "write",
  input: z.object({
    id: z.string().optional(),
    frameId: z.string().optional(),
    properties: z.array(z.string()).optional(),
    tolerance: z.number().positive().optional().describe("Max error in the property's own units (px, degrees, 0–1)."),
  }),
  run(input, rt) {
    const out: Array<{ layer: string; property: string; before: number; after: number }> = [];
    const skipped: string[] = [];
    rt.write("Simplify keyframes", (d) => {
      const clips = input.id
        ? [requireClip(d, input.id).clip]
        : d.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === resolveTargetFrame(rt, input.frameId).id);
      for (const clip of clips) {
        if (!("transform" in clip) || !clip.keyframes.length) continue;
        const step = stepOf(d, clip);
        const r = simplifyKeyframes(clip, {
          stepMs: step,
          originMs: -clip.startMs,
          tolerance: input.tolerance,
          select: (t) => (input.properties ? input.properties.includes(t.property) : input.id ? true : isBakedTrack(t, step)),
        });
        for (const x of r.done) out.push({ layer: clip.name, ...x });
        skipped.push(...r.skipped.map((p) => `${clip.name} · ${p}`));
        validClip(clip, "Simplifying keys");
      }
    });
    const before = out.reduce((a, r) => a + r.before, 0);
    const after = out.reduce((a, r) => a + r.after, 0);
    return { before, after, tracks: out.slice(0, 40), ...(skipped.length ? { skipped: skipped.slice(0, 20) } : {}) };
  },
});

// ── In / out animation ───────────────────────────────────────────────────────

export const animationSet = defineCommand({
  id: "animation.set",
  summary: "Give a layer an entrance or exit animation from the preset library (fade, slide, pop, typewriter, draw-on…), or remove one.",
  details:
    "`target` text animates per letter/word/line (text layers; `unit`, `staggerMs` apply); `layer` animates the whole layer as one piece (any visual layer). `auto` = text for text layers, layer otherwise. A whole-layer animation plays from the layer's start and has no delay — to enter at 1.2 s, give the layer `startMs: 1200`. `preset: null` removes. Omitted fields keep their current value when swapping presets. catalog.list animations shows every preset and its scope.",
  effect: "write",
  input: z.object({
    id: z.string(),
    slot: z.enum(["in", "out"]),
    preset: z.string().nullable(),
    target: z.enum(["auto", "text", "layer"]).default("auto"),
    durationMs: z.number().min(0).optional(),
    delayMs: z.number().min(0).optional().describe("Text only: wait before the first unit starts."),
    staggerMs: z.number().min(0).optional().describe("Text only: gap between units starting."),
    unit: animationUnitSchema.optional().describe("Text only."),
    easing: easingInputSchema.optional(),
    jitterMs: z.number().min(0).optional().describe("Text only: humanised timing."),
    params: z.record(z.string(), z.number()).optional().describe("Preset knobs (catalog.get animations <id>)."),
  }),
  run(input, rt) {
    if (input.preset !== null) {
      const def = getPreset(input.preset);
      if (!def) throw new ApiError(`No animation preset "${input.preset}".`, "catalog.list animations.");
    }
    rt.write(input.preset ? `Animate ${input.slot}` : `Remove ${input.slot} animation`, (d) => {
      const clip = requireClip(d, input.id).clip;
      if (clip.kind === "audio") throw new ApiError("Audio layers have no visual animation — use their fades.");
      const target = input.target === "auto" ? (clip.kind === "text" ? "text" : "layer") : input.target;
      const easing = parseEasing(input.easing);
      if (target === "text") {
        if (clip.kind !== "text") throw new ApiError(`"${clip.name}" is not text; use target "layer".`);
        const prev = clip.animations[input.slot];
        if (input.preset === null) {
          clip.animations[input.slot] = null;
          return;
        }
        const def = getPreset(input.preset)!;
        if (def.scope === "layer") throw new ApiError(`"${def.id}" is a whole-layer preset; use target "layer".`);
        const spec = retargetAnimSpec(prev, input.preset);
        Object.assign(spec, defined({
          durationMs: input.durationMs,
          delayMs: input.delayMs,
          staggerMs: input.staggerMs,
          unit: input.unit,
          easing,
          jitterMs: input.jitterMs,
        }));
        if (input.params) spec.params = { ...spec.params, ...input.params };
        clip.animations[input.slot] = spec;
      } else {
        const slot = input.slot === "in" ? "animIn" : "animOut";
        if (input.preset === null) {
          clip[slot] = null;
          return;
        }
        const allowed = layerPresetsFor(d, clip);
        if (!allowed.some((p) => p.id === input.preset)) {
          throw new ApiError(
            `"${input.preset}" does not apply to a ${clip.kind} layer.`,
            `Layer presets here: ${allowed.map((p) => p.id).join(", ")}.`,
          );
        }
        // A whole-layer spec has no delay field: written here it was stored as
        // a stray key nothing reads, and the animation ran from the layer's
        // first frame while the caller believed it waited.
        if (input.delayMs) {
          throw new ApiError(
            "Whole-layer animations have no delay.",
            "Start the layer when the animation should begin (timeline_trim its start), or key its entrance with keyframes_set.",
          );
        }
        const spec = retargetLayerSpec(clip[slot], input.preset);
        Object.assign(spec, defined({ durationMs: input.durationMs, easing }));
        if (input.params) spec.params = { ...spec.params, ...input.params };
        clip[slot] = spec;
      }
      validClip(clip, "This animation");
    });
    return { id: input.id, slot: input.slot, preset: input.preset };
  },
});

function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ── Effect stacks ────────────────────────────────────────────────────────────

type Domain = "layer" | "text" | "audio" | "geometry" | "force" | "emitter";
const DOMAINS: readonly Domain[] = ["layer", "text", "audio", "geometry", "force", "emitter"];

function registryOf(domain: Domain): EffectRegistry<BaseEffect, EffectTypeDefBase<BaseEffect>> {
  const r = domain === "layer" ? LFX : domain === "text" ? TFX : domain === "geometry" ? MDF : domain === "force" ? FORCE : domain === "emitter" ? EMITTER : AFX;
  return r as unknown as EffectRegistry<BaseEffect, EffectTypeDefBase<BaseEffect>>;
}

/** Where `catalog_list` keeps each domain's kinds. */
const CATALOG_OF: Record<Domain, string> = { layer: "layer-effects", text: "text-effects", audio: "audio-effects", geometry: "modifiers", force: "forces", emitter: "emitters" };

/** The stack an effect of this domain lives in, on this clip. */
function stackOf(clip: Clip, domain: Domain): BaseEffect[] {
  if (domain === "audio") return clip.audioEffects as BaseEffect[];
  if (clip.kind === "audio") throw new ApiError("Audio layers only take audio effects.");
  // Any layer can carry forces (a null is the usual carrier, a fan picture can be the wind).
  if (domain === "force") return (clip.forces ??= []) as BaseEffect[];
  if (domain === "emitter") return (clip.emitters ??= []) as BaseEffect[];
  if (domain === "geometry") {
    // Blender's rule: every object in a world has a modifier stack — a mesh,
    // and a 2D layer standing there (its body bends, twists, arrays…).
    if (clip.kind === "mesh") return clip.modifiers as BaseEffect[];
    if (!isBodyKind(clip.kind)) throw new ApiError(`A ${clip.kind} has no geometry to modify; use domain "layer" for picture effects.`);
    return (clip.modifiers ??= []) as BaseEffect[];
  }
  if (domain === "text") {
    if (clip.kind !== "text") throw new ApiError("Text effects apply to text layers; use domain \"layer\".");
    return clip.style.textEffects as BaseEffect[];
  }
  return clip.effects as BaseEffect[];
}

const domainInput = z
  .enum(["layer", "text", "audio", "geometry", "force", "emitter"])
  .default("layer")
  .describe(
    "layer = the whole layer's pixels (shadow, glow, glass, blur, grade…); text = per-glyph (text layers); audio = the sound chain; geometry = MODIFIERS on anything in a 3D world — a mesh, or a text, image, video or shape standing there (bend, twist, wave, array, subdivision, particles…); force = the FORCES a layer pushes simulated bodies with (wind, attract, vortex, turbulence, drag) — any number, repeats allowed, they add up; emitter = PARTICLES the layer gives off (stream, burst) — physics_emit is the easy way in.",
  );

/**
 * The clip whose stack an effect verb edits. A FRAME id means the frame's own
 * effects (a whole-frame adjustment, made the first time — the clip the frame
 * inspector's Effects section shows), so "texture the whole frame" is the same
 * verb as "texture this layer". Only the picture stack lives there.
 */
function effectTarget(d: MotionDocument, id: string, domain: Domain): Clip {
  const frame = locateFrame(d, id);
  if (frame) {
    if (domain !== "layer") throw new ApiError(`A comp's own effects are picture effects; "${domain}" belongs on a layer.`, `Use domain "layer", or a layer id.`);
    const clip = ensureFrameEffectClipIn(d, frame.id);
    if (!clip) throw new ApiError(`Comp "${frame.name}" has no frame to add effects to.`);
    return clip;
  }
  return requireClip(d, id).clip;
}

/** Said when a comp id was given: the cards went on that comp's own stack, carried by its "Frame effects" layer. */
function onComp(asked: string, clipId: string): { comp?: string } {
  return asked !== clipId ? { comp: asked } : {};
}

export const effectsAdd = defineCommand({
  id: "effects.add",
  summary: "Add an effect card to a layer's stack (drop shadow, glow, liquid glass, blur, colour grade, chroma key, EQ…) — or a modifier to anything in a 3D world (domain geometry).",
  details:
    "Returns the new effect id and the layer that holds it (`id`). Its fields animate at `<lfx|tfx|afx|mdf|force|emit>.<effectId>.<field>` through layer.set / keyframes.set on that layer. `values` sets fields immediately (catalog.get layer-effects <type> lists them with ranges). Stack order is render order: first card applies first. A COMP id puts the card on the comp's own effects (the whole frame): they are carried by its \"Frame effects\" layer, made the first time and returned as `id` (with `comp`). frame.get reads that stack; frame.update {effects} replaces or clears it.",
  effect: "write",
  input: z.object({
    id: z.string().describe("A layer id, or a comp id for the whole frame's own effects."),
    domain: domainInput,
    type: z.string(),
    values: z.record(z.string(), z.unknown()).optional(),
    index: z.number().int().min(0).optional().describe("Position in the stack; omitted = the end."),
  }),
  run(input, rt) {
    const reg = registryOf(input.domain);
    const def = reg.def(input.type);
    if (!def) throw new ApiError(`No ${input.domain} effect "${input.type}".`, `catalog.list ${CATALOG_OF[input.domain]}.`);
    let effectId = "";
    let clipId = input.id;
    rt.write(`Add ${def.label}`, (d) => {
      const clip = effectTarget(d, input.id, input.domain);
      clipId = clip.id;
      if (input.domain === "geometry" && !isWorldFrame(d.frames.find((f) => f.id === clip.frameId))) {
        throw new ApiError(`"${clip.name}" is in a flat comp; modifiers shape objects in a 3D world.`, "world.move_into puts layers in a world.");
      }
      const stack = stackOf(clip, input.domain);
      const effect = reg.createFor(input.type, [clip.kind]);
      if (input.values) Object.assign(effect, input.values, { id: effect.id, type: effect.type });
      stack.splice(input.index ?? stack.length, 0, effect);
      effectId = effect.id;
      validClip(clip, `Adding ${def.label}`);
    });
    return { effectId, id: clipId, path: `${reg.prefix}.${effectId}.<field>`, ...onComp(input.id, clipId) };
  },
});

export const effectsLook = defineCommand({
  id: "effects.look",
  summary: "Apply a whole LOOK — a named stack of effect cards (Paper cut-out, Stop motion, Chalk on card, Neon…) — to a layer or to a whole comp, as ONE group card added after its existing effects. One undo step.",
  details:
    "catalog_list looks lists every look: id, name, group, domain, its cards and (Stop motion) its fps. `look` is the id (`paper-cut-out`) or the name. `id` is a layer id, or a COMP id for the whole frame (its own effects — made the first time, the same clip the frame inspector shows). Layer looks restyle the picture stack; text looks a text layer's per-glyph stack; particle looks a layer's emitters (`domain` picks when a name exists in two). A look with `fps` also sets that rate on the layer: on a comp it holds the whole frame on that rate (stop motion on twos) while the comp still exports at its own rate. A layer look lands as a GROUP card (type \"group\") followed by its member cards, which carry `group: <groupId>`: the stack the layer already had is kept, the look runs after it, and the group's `mix` (0..1, keyframe `lfx.<groupId>.mix`) crossfades the look over the layer as it arrived. `into: <groupId>` swaps the look a group wears and keeps its place and mix (try looks this way, not by stacking them). `replace: true` is the old behaviour — the whole stack replaced by the bare cards. Text and particle looks always replace. Tune any card afterwards with effects_update; the group's mix and eye too.",
  effect: "write",
  input: z.object({
    id: z.string().describe("A layer id, or a comp id for the whole frame."),
    look: z.string().describe("The look's id (catalog_list looks) or its name."),
    domain: z.enum(["layer", "text", "emitter"]).optional().describe("Only when a look name exists in two domains."),
    into: z.string().optional().describe("A group card's id on the target: swap the look it wears, keeping its place and mix."),
    mix: z.number().min(0).max(1).optional().describe("The group's mix, 0..1 (default 1, or the group's own with `into`)."),
    replace: z.boolean().optional().describe("Replace the whole stack with the bare cards (no group). Layer looks only; text and particle looks always replace."),
  }),
  run(input, rt) {
    const found = findLook(input.look, input.domain as LookDomain | undefined, rt.doc());
    if ("error" in found) throw new ApiError(found.error, `Looks: ${found.suggestions.join(", ")} (catalog_list looks).`);
    const { look } = found;
    const domain = look.domain as Domain;
    let clipId = input.id;
    let cards: Array<{ effectId: string; type: string }> = [];
    let groupId: string | null = null;
    const asGroup = domain === "layer" && !input.replace;
    if (input.into && !asGroup) throw new ApiError("`into` is for layer looks (groups).", "Drop `into`, or drop `replace`.");
    rt.write(`Apply ${look.preset.name}`, (d) => {
      const clip = effectTarget(d, input.id, domain);
      clipId = clip.id;
      const stack = stackOf(clip, domain);
      // The cards that leave take their keys with them — a key addressed to a
      // card that is gone is an orphan.
      const dropKeys = (ids: Iterable<string>) => {
        const gone = [...ids];
        if (gone.length) clip.keyframes = clip.keyframes.filter((t) => !gone.some((id) => t.property.includes(`.${id}.`)));
      };
      let next: BaseEffect[];
      if (asGroup) {
        if (input.into && !stack.some((e) => e.id === input.into && isEffectGroup(e))) {
          throw new ApiError(`No group "${input.into}" on ${clip.id}.`, "into takes the id of a card with type \"group\" (layer_get shows the stack).");
        }
        const applied = applyLookAsGroup(stack as GroupableEffect[], look, input.into);
        dropKeys(applied.removed);
        groupId = applied.group;
        next = applied.effects as BaseEffect[];
        if (input.mix !== undefined) next = next.map((e) => (e.id === groupId ? { ...e, mix: input.mix } : e));
        stack.splice(0, stack.length, ...(next as typeof stack));
        next = groupMembers(next as GroupableEffect[], groupId) as BaseEffect[];
      } else {
        dropKeys(stack.map((e) => e.id));
        next = lookCards(look);
        stack.splice(0, stack.length, ...(next as typeof stack));
      }
      if (look.preset.fps && clip.kind !== "audio") clip.fps = look.preset.fps;
      cards = next.map((e) => ({ effectId: e.id, type: e.type }));
      validClip(clip, `Applying ${look.preset.name}`);
    });
    return {
      id: clipId,
      ...onComp(input.id, clipId),
      look: lookShortId(look.preset),
      name: look.preset.name,
      domain,
      ...(groupId ? { groupId, mixPath: `lfx.${groupId}.mix` } : {}),
      cards,
      ...(look.preset.fps ? { fps: look.preset.fps } : {}),
    };
  },
});

/**
 * A MATERIAL CHAIN as keys. The Surface card morphs between two materials
 * (`material` → `to`, by `morph`); a chain is a run of those, each link
 * switching both selects on HOLD keys at the instant the last one finished —
 * where "A fully become B" and "B, about to become C" are the same picture,
 * so the switch is invisible. That invariant is exactly what an agent keying
 * three tracks by hand gets wrong, which is why it is a verb.
 */
export const effectsMorph = defineCommand({
  id: "effects.morph",
  summary: "Turn a layer or a whole comp from one MATERIAL into the next over time — paper → felt → foil → chrome — without a cut.",
  details:
    "Keys the Surface card's material morph. `stops` are the materials in order, each with the time it is FULLY showing (`atMs`, layer clock; comp clock with clock: comp). Each change runs over the `overMs` before its stop (default 700), its front shaped by `style`: spread (patches grow until they meet), sweep (a ragged front from the light's side), fade (all at once). Uses the first Surface card on the target, or adds one. The other dials (lift, edge, colour mode, light) are SHARED by every material in the chain: apply a look first (effects_look), then morph. Replaces earlier keys on the card's material, to and morph. Under the hood: hold keys on `material` and `to`, and `morph` running 0→1 per link.",
  effect: "write",
  input: z.object({
    id: z.string().describe("A layer id, or a comp id for the whole frame."),
    effectId: z.string().optional().describe("The Surface card; omitted = the first (added when there is none)."),
    stops: z
      .array(z.object({ material: z.enum(SURFACE_MATERIALS), atMs: z.number().min(0) }))
      .min(2)
      .describe("Materials in order, each with the time it is fully showing."),
    overMs: z.number().positive().default(700).describe("How long each change takes, ending at its stop."),
    style: z.enum(SURFACE_MORPH_STYLES).optional(),
    clock: z.enum(["layer", "comp"]).default("layer"),
  }),
  run(input, rt) {
    const stops = input.stops;
    for (let k = 1; k < stops.length; k++) {
      if (stops[k]!.atMs <= stops[k - 1]!.atMs) throw new ApiError("Stops must be in time order, each later than the last.", `Stop ${k} (${stops[k]!.material}) is at ${stops[k]!.atMs} ms.`);
    }
    let effectId = "";
    let clipId = input.id;
    rt.write(`Morph ${stops.map((s) => s.material).join(" → ")}`, (d) => {
      const clip = effectTarget(d, input.id, "layer");
      clipId = clip.id;
      const stack = stackOf(clip, "layer");
      let fx = input.effectId ? stack.find((e) => e.id === input.effectId) : stack.find((e) => e.type === "surface");
      if (input.effectId && fx?.type !== "surface") throw new ApiError(`"${input.effectId}" is not a Surface card on "${clip.name}".`, "layer.get lists its effects; omit effectId to use the first Surface card.");
      if (!fx) {
        fx = LFX.createFor("surface", [clip.kind]) as unknown as BaseEffect;
        stack.push(fx);
      }
      effectId = fx.id;
      const path = (k: string) => `${LFX.prefix}.${fx!.id}.${k}`;
      const tracks = new Set([path("material"), path("to"), path("morph")]);
      clip.keyframes = clip.keyframes.filter((t) => !tracks.has(t.property));
      const local = (at: number) => (input.clock === "comp" ? at - clip.startMs : at);
      Object.assign(fx, { material: stops[0]!.material, to: stops[1]!.material, morph: 0, ...(input.style ? { morphStyle: input.style } : {}) });
      const hold = { kind: "hold" } as const;
      const ease = { kind: "preset", name: "ease-in-out" } as const;
      const t0 = local(stops[0]!.atMs);
      setKeyframe(clip.keyframes, path("material"), t0, stops[0]!.material, hold);
      setKeyframe(clip.keyframes, path("to"), t0, stops[1]!.material, hold);
      setKeyframe(clip.keyframes, path("morph"), t0, 0, hold);
      for (let k = 1; k < stops.length; k++) {
        const at = local(stops[k]!.atMs);
        const from = Math.max(local(stops[k - 1]!.atMs), at - input.overMs);
        setKeyframe(clip.keyframes, path("morph"), from, 0, ease);
        if (k === stops.length - 1) {
          setKeyframe(clip.keyframes, path("morph"), at, 1, hold);
          break;
        }
        // Fully the new material a millisecond before the stop; AT the stop
        // the next link starts from it — the same picture, re-addressed.
        setKeyframe(clip.keyframes, path("morph"), at - 1, 1, hold);
        setKeyframe(clip.keyframes, path("morph"), at, 0, hold);
        setKeyframe(clip.keyframes, path("material"), at, stops[k]!.material, hold);
        setKeyframe(clip.keyframes, path("to"), at, stops[k + 1]!.material, hold);
      }
      validClip(clip, "Morphing materials");
    });
    return { id: clipId, effectId, chain: stops.map((s) => s.material), path: `${LFX.prefix}.${effectId}.morph` };
  },
});

export const effectsUpdate = defineCommand({
  id: "effects.update",
  summary: "Change an effect's fields, switch it on/off, move it in the stack, or remove it.",
  effect: "write",
  input: z.object({
    id: z.string(),
    effectId: z.string(),
    values: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    index: z.number().int().min(0).optional(),
    remove: z.boolean().optional(),
  }),
  run(input, rt) {
    rt.write(input.remove ? "Remove effect" : "Edit effect", (d) => {
      const clip = requireClip(d, input.id).clip;
      for (const domain of DOMAINS) {
        let stack: BaseEffect[];
        try {
          stack = stackOf(clip, domain);
        } catch {
          continue;
        }
        const i = stack.findIndex((e) => e.id === input.effectId);
        if (i < 0) continue;
        if (input.remove) {
          stack.splice(i, 1);
          clip.keyframes = clip.keyframes.filter((t) => !t.property.includes(`.${input.effectId}.`));
          return;
        }
        const effect = stack[i]!;
        if (input.values) {
          // An `image` field names a picture in the project: refuse anything
          // else here, where the agent can still fix it, rather than render a
          // texture that silently never arrives.
          const def = registryOf(domain).types.find((t) => t.type === effect.type);
          for (const f of def?.fields ?? []) {
            const v = input.values[f.key];
            if (f.kind !== "image" || v === undefined || v === "") continue;
            const asset = d.assets.find((a) => a.id === v);
            if (!asset || asset.kind !== "image")
              throw new ApiError(`"${String(v)}" is not an image in this project, so ${f.label} cannot use it.`, "media.import the picture (or media.list for one already in), then pass its asset id; \"\" resets it.");
          }
          Object.assign(effect, input.values, { id: effect.id, type: effect.type });
        }
        if (input.enabled !== undefined) effect.enabled = input.enabled;
        if (input.index !== undefined) {
          stack.splice(i, 1);
          stack.splice(Math.min(input.index, stack.length), 0, effect);
        }
        validClip(clip, "This effect change");
        return;
      }
      throw new ApiError(`"${clip.name}" has no effect "${input.effectId}".`, "layer.get shows the stacks (effects, style.textEffects, audioEffects, modifiers).");
    });
    return { updated: input.effectId };
  },
});

// ── Catalogues ───────────────────────────────────────────────────────────────

/** Every catalog `catalog.list` answers — also what a script brief can include. */
export const CATALOGS = [
  "layer-effects",
  "text-effects",
  "audio-effects",
  "animations",
  "text-templates",
  "transitions",
  "easings",
  "blend-modes",
  // The 3D world (v89).
  "primitives",
  "modifiers",
  "materials",
  "lights",
  // Physics (v93).
  "forces",
  "emitters",
  // Sound (v103): voices played as notes.
  "sound-sets",
  // Whole stacks by name (v109): layer, text and particle looks.
  "looks",
] as const;
export type CatalogId = (typeof CATALOGS)[number];

function effectRows(domain: Domain, query?: string) {
  const cats = new Map(EFFECT_CATEGORIES.map((c) => [c.id, c.label] as const));
  return registryOf(domain)
    .types.filter((t) => matches(query, t.type, t.label, t.blurb, ...(t.tags ?? [])))
    .map((t) => ({
      id: t.type,
      label: t.label,
      category: cats.get(t.category) ?? t.category,
      ...(t.blurb ? { does: t.blurb } : {}),
      ...(t.appliesTo ? { only: t.appliesTo } : {}),
    }));
}

function matches(query: string | undefined, ...fields: Array<string | undefined>): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(q));
}

function fieldRow(f: EffectFieldDef) {
  return {
    key: f.key,
    label: f.label,
    kind: f.kind,
    ...(f.min !== undefined || f.max !== undefined ? { range: [f.min ?? null, f.max ?? null] } : {}),
    ...(f.unit ? { unit: f.unit } : {}),
    ...(f.options ? { options: f.options.map((o) => o.value) } : {}),
    ...(f.hint ? { hint: f.hint } : {}),
  };
}

export const catalogList = defineCommand({
  id: "catalog.list",
  summary: "What exists to choose from: effects, animation presets, text templates, transitions, easings, blend modes — and for 3D worlds: primitives, modifiers, materials, lights.",
  effect: "read",
  input: z.object({
    catalog: z.enum(CATALOGS),
    query: z.string().optional().describe("Filter by name, tag or purpose (\"glow\", \"bounce\", \"neon\")."),
  }),
  run(input) {
    return listCatalog(input.catalog, input.query);
  },
});

export function listCatalog(catalog: CatalogId, query?: string): unknown {
  switch (catalog) {
    case "layer-effects":
      return effectRows("layer", query);
    case "text-effects":
      return effectRows("text", query);
    case "audio-effects":
      return effectRows("audio", query);
    case "animations":
      return ANIMATION_PRESETS.filter((p) => matches(query, p.id, p.label, p.tagline, p.category)).map((p) => ({
        id: p.id,
        label: p.label,
        category: p.category,
        scope: p.scope,
        feel: p.tagline,
        ...(p.needs ? { needs: p.needs } : {}),
      }));
    case "text-templates":
      return TEXT_TEMPLATES.filter((t) => matches(query, t.id, t.name, t.tagline, t.category, ...(t.tags ?? []))).map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        look: t.tagline,
      }));
    case "transitions":
      return TRANSITION_PRESETS.filter((t) => matches(query, t.id, t.label, t.tagline)).map((t) => ({
        id: t.id,
        label: t.label,
        category: t.category,
        does: t.tagline,
      }));
    case "easings":
      return [
        { id: "linear", label: "Linear" },
        ...Object.entries(EASING_PRESET_LABELS).map(([id, label]) => ({ id, label })),
        { id: "cubic-bezier(x1,y1,x2,y2)", label: "Custom curve" },
      ];
    case "blend-modes":
      return blendModeSchema.options;
    case "primitives":
      return PRIMITIVES.filter((p) => matches(query, p.id, p.label)).map((p) => ({
        id: p.id,
        label: p.label,
        params: Object.fromEntries(p.params.map((x) => [x.key, x.default])),
        keyframePath: "geometry.<param>",
      }));
    case "modifiers":
      return MODIFIERS.filter((m) => matches(query, m.type, m.label, m.blurb ?? "")).map((m) => ({
        id: m.type,
        label: m.label,
        does: m.blurb,
        group: m.category,
        fields: m.fields.map((f) => ({ ...fieldRow(f), default: f.default })),
        toggles: (m.toggles ?? []).map((t) => t.key),
        add: `effects_add {domain: "geometry", type: "${m.type}"}`,
        keyframePath: "mdf.<modifierId>.<field>",
      }));
    case "forces":
      return FORCE.types.filter((t) => matches(query, t.type, t.label, t.blurb ?? "", ...(t.tags ?? []))).map((t) => ({
        id: t.type,
        label: t.label,
        does: t.blurb,
        fields: t.fields.map(fieldRow),
        add: `physics_force {type: "${t.type}"} (a new null) or effects_add {domain: "force", type: "${t.type}", id: <any layer>}`,
        keyframePath: "force.<forceId>.<field>",
      }));
    case "emitters":
      return [
        ...EMITTER.types.filter((t) => matches(query, t.type, t.label, t.blurb ?? "", ...(t.tags ?? []))).map((t) => ({
          id: t.type,
          label: t.label,
          does: t.blurb,
          fields: t.fields.map(fieldRow),
          add: `physics_emit {type: "${t.type}"} (a new null) or effects_add {domain: "emitter", type: "${t.type}", id: <any layer>}`,
          keyframePath: "emit.<emitterId>.<field>",
        })),
        ...EMITTER_LOOKS.filter((l) => matches(query, l.id, l.name, l.type, ...l.tags)).map((l) => ({ id: `look:${l.id}`, label: l.name, type: l.type, add: `physics_emit {look: "${l.id}"}` })),
      ];
    case "sound-sets":
      return SOUND_SETS.filter((t) => matches(query, t.id, t.name, t.group, t.voice.pack, ...t.tags)).map((t) => ({
        id: t.id,
        name: t.name,
        group: t.group,
        voice: t.voice,
        use: "spread `voice` into a `sounds` entry (layer_patch); key `snd.<entryId>.intensity` for the climax",
      }));
    case "looks":
      return allLooks()
        .filter((l) => matches(query, lookShortId(l.preset), l.preset.name, l.preset.group ?? "", l.domain, ...l.preset.tags))
        .map((l) => ({ ...lookRow(l), apply: `effects_look {id: <layer or comp id>, look: "${lookShortId(l.preset)}"}` }));
    case "materials":
      return MATERIAL_PRESETS.filter((m) => matches(query, m.id, m.label)).map((m) => ({ id: m.id, label: m.label, color: m.color, material: m.material }));
    case "lights":
      return LIGHT_TYPES.map((t) => ({
        id: t,
        defaultIntensity: LIGHT_DEFAULTS[t].intensity,
        unit: t === "sun" || t === "environment" || t === "hemisphere" ? "strength" : "watts",
        ...(t === "environment" ? { presets: ENVIRONMENT_PRESETS } : {}),
      }));
  }
}

export const catalogGet = defineCommand({
  id: "catalog.get",
  summary: "One catalogue entry in full — an effect's fields with ranges, a preset's knobs and defaults.",
  effect: "read",
  input: z.object({ catalog: z.enum(CATALOGS), id: z.string() }),
  run(input) {
    switch (input.catalog) {
      case "layer-effects":
      case "text-effects":
      case "audio-effects":
      case "forces":
      case "emitters": {
        const domain = (input.catalog === "forces" ? "force" : input.catalog === "emitters" ? "emitter" : input.catalog.split("-")[0]) as Domain;
        const reg = registryOf(domain);
        const def = reg.def(input.id);
        if (!def) throw new ApiError(`No ${domain} effect "${input.id}".`);
        return {
          id: def.type,
          label: def.label,
          ...(def.blurb ? { does: def.blurb } : {}),
          defaults: reg.defaults(def.type),
          fields: def.fields.map(fieldRow),
          ...(def.toggles?.length ? { toggles: def.toggles.map((t) => ({ key: t.key, label: t.label, ...(t.hint ? { hint: t.hint } : {}) })) } : {}),
          keyframePath: `${reg.prefix}.<effectId>.<field>`,
        };
      }
      case "animations": {
        const p = getPreset(input.id);
        if (!p) throw new ApiError(`No animation preset "${input.id}".`);
        return {
          id: p.id,
          label: p.label,
          scope: p.scope,
          feel: p.tagline,
          defaultUnit: p.defaultUnit,
          defaultDurationMs: p.defaultDurationMs,
          defaultStaggerMs: p.defaultStaggerMs,
          params: p.params.map((k) => ({
            key: k.key,
            label: k.label,
            range: [k.min, k.max],
            default: k.defaultValue,
            ...(k.options ? { options: k.options } : {}),
          })),
        };
      }
      case "looks": {
        const found = findLook(input.id);
        if ("error" in found) throw new ApiError(found.error, `Looks: ${found.suggestions.join(", ")}`);
        return { ...lookRow(found.look), stack: found.look.preset.data, apply: `effects_look {id: <layer or comp id>, look: "${lookShortId(found.look.preset)}"}` };
      }
      case "text-templates": {
        const t = TEXT_TEMPLATES.find((x) => x.id === input.id);
        if (!t) throw new ApiError(`No text template "${input.id}".`);
        return { id: t.id, name: t.name, look: t.tagline, sampleText: t.sampleText, style: t.style, animations: t.animations };
      }
      default: {
        // Every other catalogue (modifiers, primitives, materials, lights…) is a
        // list of entries with ids: return THE entry asked for. Handing back the
        // whole list made an agent wade through every modifier to find one.
        const rows = listCatalog(input.catalog) as unknown;
        const list = Array.isArray(rows) ? (rows as Array<{ id?: string }>) : [];
        const hit = list.find((r) => r.id === input.id);
        if (!hit) {
          const ids = list.map((r) => r.id).filter(Boolean);
          throw new ApiError(`No "${input.id}" in ${input.catalog}.`, ids.length ? `One of: ${ids.join(", ")}` : `catalog_list ${input.catalog}`);
        }
        return hit;
      }
    }
  },
});

export const ANIMATE_COMMANDS = [keyframesSet, keyframesClear, keyframesInspect, keyframesSimplify, animationSet, effectsAdd, effectsLook, effectsMorph, effectsUpdate, catalogList, catalogGet];
