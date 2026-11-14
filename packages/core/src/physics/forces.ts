import type { Clip, ForceSpec, ForceType, KeyframeValue } from "../schema";
import { forceSchema } from "../schema/physics";
import { createId } from "../ids";
import { createEffectRegistry, type EffectFieldDef, type EffectTypeDefBase } from "../animation/effect-base";

/**
 * THE FORCE STACK — what a layer does to the bodies around it (v93).
 *
 * The fifth domain of the one effect registry (`effect-base.ts`), after
 * pixels, sound, glyphs and geometry: a force is an instance with a stable id,
 * a type and its numbers, in an ordered list on the layer (`clip.forces`). So
 * the Physics tab's Forces section IS the effect stack — drag to reorder,
 * duplicate, mute, presets and looks, the floating editor with keyframe
 * diamonds — and every number keys at `force.<id>.<field>` through the same
 * property registry, curve editor, drivers and agents as everything else.
 *
 * Order: forces ADD UP (superposition — a wind and a vortex on one null push
 * the same whichever is first), so the order is how the stack reads, never a
 * different result. Repeats are meaningful: two winds at different angles on
 * one carrier, two turbulences at different eddy sizes.
 */

export interface ForceTypeDef extends EffectTypeDefBase<ForceSpec> {
  type: ForceType;
}

const reach: EffectFieldDef[] = [
  { key: "radius", label: "Reach", kind: "number", min: 0, max: 4000, step: 1, hint: "How far it reaches from the layer. 0 reaches everywhere." },
  {
    key: "falloff",
    label: "Falloff",
    kind: "select",
    options: [
      { value: "smooth", label: "Smooth" },
      { value: "linear", label: "Linear" },
      { value: "none", label: "None" },
    ],
    hint: "How it fades toward the edge of its reach.",
  },
];

const make = (type: ForceType, strength: number, extra: Partial<ForceSpec> = {}): ForceSpec => forceSchema.parse({ id: createId("force"), type, strength, ...extra });

export const FORCE_TYPE_DEFS: ForceTypeDef[] = [
  {
    type: "wind",
    label: "Wind",
    blurb: "Blows along the layer's X. Turn the layer to aim it.",
    tags: ["blow", "push", "gust", "breeze", "direction"],
    category: "push",
    fields: [{ key: "strength", label: "Strength", kind: "number", min: -4000, max: 4000, step: 10, bipolar: true, hint: "Acceleration along the layer's X. Gravity is 981." }, ...reach],
    create: () => make("wind", 600),
  },
  {
    type: "point",
    label: "Attract",
    blurb: "Pulls toward the layer. Negative pushes away.",
    tags: ["magnet", "gravity well", "repel", "point", "pull"],
    category: "push",
    fields: [{ key: "strength", label: "Pull", kind: "number", min: -4000, max: 4000, step: 10, bipolar: true, hint: "Negative repels." }, ...reach],
    create: () => make("point", 400, { radius: 600 }),
  },
  {
    type: "vortex",
    label: "Vortex",
    blurb: "Swirls bodies around the layer.",
    tags: ["swirl", "spin", "tornado", "whirlpool", "orbit"],
    category: "push",
    fields: [{ key: "strength", label: "Swirl", kind: "number", min: -4000, max: 4000, step: 10, bipolar: true, hint: "Positive turns clockwise on screen." }, ...reach],
    create: () => make("vortex", 600, { radius: 600 }),
  },
  {
    type: "turbulence",
    label: "Turbulence",
    blurb: "Gusts that change from place to place.",
    tags: ["noise", "gust", "chaos", "random", "flutter"],
    category: "air",
    fields: [
      { key: "strength", label: "Strength", kind: "number", min: 0, max: 4000, step: 10 },
      { key: "scale", label: "Eddies", kind: "number", min: 10, max: 2000, step: 1, hint: "The size of its gusts." },
      { key: "seed", label: "Seed", kind: "number", min: 0, max: 9999, step: 1 },
      ...reach,
    ],
    create: () => make("turbulence", 500),
  },
  {
    // A WELL: real inverse-square gravity, a horizon that swallows, space that turns.
    type: "gravity",
    label: "Gravity well",
    blurb: "A mass that pulls by inverse square — orbits, slingshots, a black hole's horizon.",
    tags: ["gravity", "black hole", "orbit", "planet", "star", "mass", "horizon", "accretion", "space", "well", "kepler"],
    category: "push",
    fields: [
      { key: "mass", label: "Mass", kind: "number", min: 0, max: 100000, step: 50, hint: "Its pull 100 units out (units/s²; gravity is 981). An orbit at r needs √(mass × 10⁴ / r) units/s." },
      { key: "horizon", label: "Horizon", kind: "number", min: 0, max: 2000, step: 1, hint: "Whatever crosses it is gone. 0 is a mass with no hole." },
      { key: "spin", label: "Spin", kind: "number", min: -1, max: 1, step: 0.01, bipolar: true, hint: "Space turns with the well, hardest at the horizon. Orbits faster than it spiral in." },
      { key: "core", label: "Core", kind: "number", min: 0, max: 1000, step: 1, hint: "Inside it the pull eases off, so a close pass slingshots instead of exploding." },
      ...reach,
    ],
    create: () => make("gravity", 0, { mass: 8000, horizon: 60, core: 12 }),
  },
  {
    type: "drag",
    label: "Drag",
    blurb: "Thick air. Slows everything it reaches.",
    tags: ["air", "water", "resistance", "slow", "thick"],
    category: "air",
    fields: [{ key: "strength", label: "Drag", kind: "number", min: 0, max: 100, step: 1, hint: "The share of a body's speed it takes each second." }, ...reach],
    create: () => make("drag", 40),
  },
];

export const FORCE = createEffectRegistry<ForceSpec, ForceTypeDef>("force", "force", FORCE_TYPE_DEFS);

// ── As property paths (`force.<id>.<field>`) ────────────────────────────────

const PATH = /^force\.([^.]+)\.([^.]+)$/;
const NUMERIC = new Set(["strength", "radius", "scale", "seed", "mass", "core", "horizon", "spin"]);

const forceOf = (clip: Clip, id: string): ForceSpec | undefined => (clip.kind === "audio" ? undefined : clip.forces?.find((f) => f.id === id));

export function isForcePath(path: string): boolean {
  return path.startsWith("force.") && PATH.test(path);
}

export function getForceProperty(clip: Clip, path: string): KeyframeValue | undefined {
  const m = PATH.exec(path);
  const f = m ? forceOf(clip, m[1]!) : undefined;
  if (!f) return undefined;
  const k = m![2]!;
  if (k === "enabled") return f.enabled;
  if (k === "falloff") return f.falloff;
  return NUMERIC.has(k) ? (f[k as "strength"] as number) : undefined;
}

/** Write one force field's value on a clip (a draft or a baked copy). False when the path is not a force's. */
export function setForceProperty(clip: Clip, path: string, value: KeyframeValue): boolean {
  const m = PATH.exec(path);
  if (!m || clip.kind === "audio") return false;
  const list = clip.forces;
  const i = list?.findIndex((f) => f.id === m[1]) ?? -1;
  if (!list || i < 0) return true;
  const k = m[2]!;
  const f = list[i]!;
  let next: ForceSpec | null = null;
  if (k === "enabled" && typeof value === "boolean") next = { ...f, enabled: value };
  else if (k === "falloff" && (value === "none" || value === "linear" || value === "smooth")) next = { ...f, falloff: value };
  else if (NUMERIC.has(k) && typeof value === "number" && Number.isFinite(value)) {
    const v = k === "radius" || k === "mass" || k === "core" || k === "horizon" ? Math.max(0, value) : k === "scale" ? Math.max(1, value) : k === "seed" ? Math.round(value) : k === "spin" ? Math.max(-1, Math.min(1, value)) : value;
    next = { ...f, [k]: v };
  }
  if (next) clip.forces = list.map((x, j) => (j === i ? next! : x));
  return true;
}

/** Every keyable force path a clip has, card by card — the node board, the curve editor and `layer_properties`. */
export function forceClipPaths(clip: Clip): Array<{ path: string; force: ForceSpec; label: string }> {
  if (clip.kind === "audio" || !clip.forces?.length) return [];
  const out: Array<{ path: string; force: ForceSpec; label: string }> = [];
  for (const f of clip.forces) {
    const def = FORCE.def(f.type);
    for (const field of def?.fields ?? []) if (field.kind === "number") out.push({ path: FORCE.path(f.id, field.key), force: f, label: def!.label });
  }
  return out;
}

/** Does this layer push anything — any force switched on? */
export function hasForces(clip: Clip): boolean {
  return clip.kind !== "audio" && !!clip.forces?.length;
}
