import type { Clip, EmitterSpec, EmitterType, KeyframeValue } from "../schema";
import { emitterSchema } from "../schema/physics";
import { createId } from "../ids";
import { createEffectRegistry, type EffectFieldDef, type EffectFieldGroupDef, type EffectToggleDef, type EffectTypeDefBase } from "../animation/effect-base";

/**
 * THE EMITTER STACK — particles a layer gives off (v102).
 *
 * The sixth domain of the one effect registry, beside forces: an emitter is an
 * instance with a stable id, a type and its numbers, in an ordered list on the
 * layer (`clip.emitters`). So the Physics tab's Particles section IS the effect
 * stack — drag, duplicate, mute, presets and looks, the floating editor with
 * keyframe diamonds — and every number keys at `emit.<id>.<field>` through the
 * same property registry, curve editor, drivers and agents as everything else.
 *
 * Four types, because there are four ways particles start: a STREAM flows
 * while its layer is on (a keyed `rate` swells and stops it), a BURST throws
 * `count` at once as its layer starts (move the layer on the timeline to move
 * the pop), a HIT throws a burst wherever its body — or, on a layer that is
 * not one, any body — meets something: sparks where the ball lands, and a SUB
 * throws from another card's particles as each dies or hits: a firework
 * shell's burst, a raindrop's splash. What it
 * looks like — sparks, confetti, rain, snow, smoke — is a LOOK
 * (`EMITTER_LOOKS`), a preset of the same fields, never another type.
 */

export interface EmitterTypeDef extends EffectTypeDefBase<EmitterSpec> {
  type: EmitterType;
}

const groups: EffectFieldGroupDef[] = [
  { id: "emit", label: "Emit" },
  { id: "look", label: "Look" },
  { id: "motion", label: "Motion" },
  { id: "view", label: "View", advanced: true },
  { id: "advanced", label: "Advanced", advanced: true },
];

const emitFields = (first: EffectFieldDef): EffectFieldDef[] => [
  first,
  {
    key: "source",
    label: "From",
    kind: "select",
    group: "emit",
    options: [
      { value: "point", label: "Point" },
      { value: "area", label: "Area", hint: "Anywhere in the layer's box" },
      { value: "outline", label: "Outline", hint: "Along the layer's edge" },
      { value: "ring", label: "Ring", hint: "In a ring about the layer — a disk, a halo, a shell" },
    ],
  },
  { key: "inner", label: "Inner", kind: "number", min: 0, max: 10000, step: 1, group: "emit", showIf: { key: "source", equals: ["ring"] }, hint: "The ring's hole, units from the layer." },
  { key: "outer", label: "Outer", kind: "number", min: 0, max: 10000, step: 1, group: "emit", showIf: { key: "source", equals: ["ring"] } },
  {
    key: "launch",
    label: "Launch",
    kind: "select",
    group: "emit",
    options: [
      { value: "aim", label: "Aim", hint: "Along the layer's X" },
      { value: "orbit", label: "Orbit", hint: "Sideways, at the speed that circles the nearest gravity well" },
      { value: "inward", label: "Inward", hint: "Toward the layer — a collapse" },
      { value: "outward", label: "Outward", hint: "Away from the layer — a shell, a blast" },
    ],
  },
  { key: "orbit", label: "Orbit", kind: "number", min: -2, max: 2, step: 0.01, unit: "×", bipolar: true, group: "emit", showIf: { key: "launch", equals: ["orbit"] }, hint: "× the speed that holds a circle. Under 1 dips toward the well; the sign is the way round." },
  { key: "speed", label: "Speed", kind: "number", min: 0, max: 10000, step: 10, group: "emit", hint: "Units per second as they leave. Turn the layer to aim them." },
  { key: "spread", label: "Spread", kind: "number", min: 0, max: 360, step: 1, unit: "°", group: "emit", hint: "The cone they leave in. 360 goes every way." },
  { key: "life", label: "Life", kind: "number", min: 0.05, max: 30, step: 0.05, unit: "s", group: "emit" },
];

const lookFields: EffectFieldDef[] = [
  {
    key: "shape",
    label: "Shape",
    kind: "select",
    group: "look",
    options: [
      { value: "dot", label: "Dot" },
      { value: "square", label: "Square" },
      { value: "spark", label: "Spark", hint: "Stretched along its motion" },
      { value: "layer", label: "Layer", hint: "Any layer's picture, once per particle" },
    ],
  },
  { key: "instance", label: "Layer", kind: "layer", group: "look", showIf: { key: "shape", equals: ["layer"] }, hint: "Hide it where it stands; each particle draws it." },
  { key: "size", label: "Size", kind: "number", min: 0.5, max: 500, step: 0.5, group: "look" },
  { key: "grow", label: "End size", kind: "number", min: 0, max: 4, step: 0.05, unit: "×", group: "look", hint: "Its size as it dies. 0 shrinks away." },
  {
    key: "colorBy",
    label: "Colour by",
    kind: "select",
    group: "look",
    options: [
      { value: "life", label: "Life", hint: "From its colour to its end colour as it ages" },
      { value: "speed", label: "Speed", hint: "Still is its colour, fast is its end colour" },
      { value: "temperature", label: "Temperature", hint: "Glows like hot gas: the faster, the hotter" },
    ],
  },
  { key: "color", label: "Colour", kind: "color", group: "look", showIf: { key: "colorBy", equals: ["life", "speed"] } },
  { key: "colorEnd", label: "End colour", kind: "color", group: "look", showIf: { key: "colorBy", equals: ["life", "speed"] } },
  { key: "hot", label: "Hot at", kind: "number", min: 1, max: 20000, step: 10, unit: "/s", group: "look", showIf: { key: "colorBy", equals: ["speed", "temperature"] }, hint: "The speed that reads as the end colour, or as the full temperature." },
  { key: "kelvin", label: "Temperature", kind: "number", min: 1000, max: 50000, step: 100, unit: "K", group: "look", showIf: { key: "colorBy", equals: ["temperature"] }, hint: "How hot the fastest ones burn. 3,000 K is ember, 6,500 K white, 20,000 K blue." },
  { key: "hue", label: "Hue range", kind: "number", min: 0, max: 180, step: 1, unit: "°", group: "look", hint: "How far each one's hue wanders. 180 is every colour." },
  { key: "fade", label: "Fade out", kind: "number", min: 0, max: 1, step: 0.01, group: "look" },
  { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, step: 0.01, group: "look", hint: "Key it to fade the particles. The layer's own opacity doesn't reach them." },
  { key: "soft", label: "Softness", kind: "number", min: 0, max: 1, step: 0.01, group: "look", showIf: { key: "shape", equals: ["dot"] }, hint: "1 is a puff with no edge — smoke, dust, bokeh." },
  { key: "glow", label: "Glow", kind: "number", min: 0, max: 1, step: 0.01, group: "look", hint: "Adds light instead of paint, with a halo. Sparks, fire, fireworks." },
];

/** How the plane is seen: tilted away, its light bent by a well, beamed. */
const viewFields: EffectFieldDef[] = [
  { key: "tilt", label: "Tilt", kind: "number", min: 0, max: 89, step: 1, unit: "°", group: "view", hint: "Leans the plane away, top edge far. A disk seen from the side." },
  { key: "lensing", label: "Lensing", kind: "number", min: 0, max: 1, step: 0.01, group: "view", hint: "A gravity well with a horizon bends the light from behind it: the far side arches over the hole." },
  { key: "beaming", label: "Beaming", kind: "number", min: 0, max: 1, step: 0.01, group: "view", hint: "Gas coming toward you brighter and bluer, going away dimmer." },
];

const motionFields: EffectFieldDef[] = [
  { key: "weight", label: "Weight", kind: "number", min: -4, max: 4, step: 0.05, unit: "×", bipolar: true, group: "motion", hint: "× gravity. 0 floats, negative rises." },
  { key: "drag", label: "Air", kind: "number", min: 0, max: 1, step: 0.01, group: "motion", hint: "How much speed they lose each second." },
  { key: "bounce", label: "Bounce", kind: "number", min: 0, max: 1, step: 0.01, group: "motion", showIf: { key: "collide", equals: [true] } },
  { key: "friction", label: "Friction", kind: "number", min: 0, max: 1, step: 0.01, group: "motion", showIf: { key: "collide", equals: [true] } },
  { key: "spin", label: "Spin", kind: "number", min: 0, max: 3600, step: 10, unit: "°/s", group: "motion" },
];

const advancedFields: EffectFieldDef[] = [
  { key: "variance", label: "Variety", kind: "number", min: 0, max: 1, step: 0.01, group: "advanced", hint: "How much speed, life and size wander." },
  { key: "seed", label: "Seed", kind: "number", min: 0, max: 9999, step: 1, group: "advanced" },
];

const toggles: EffectToggleDef[] = [
  { key: "sphere", label: "Sphere", group: "emit", hint: "Thrown in 3D, seen flat — a full spread fills a ball of light instead of a ring. Fireworks." },
  { key: "collide", label: "Collide", group: "motion", hint: "Bounce off bodies, walls and the floor." },
  { key: "behind", label: "Behind layer", group: "look", hint: "Drawn under its layer — a trail stays behind the ball." },
];

const make = (type: EmitterType, extra: Partial<EmitterSpec> = {}): EmitterSpec => emitterSchema.parse({ id: createId("emit"), type, ...extra });

export const EMITTER_TYPE_DEFS: EmitterTypeDef[] = [
  {
    type: "stream",
    label: "Stream",
    blurb: "A steady flow along the layer's X — sparks, a fountain, smoke.",
    tags: ["particles", "emitter", "fountain", "sparks", "smoke", "rain", "snow", "flow", "spray"],
    category: "emission",
    groups,
    toggles,
    fields: [
      ...emitFields({ key: "rate", label: "Rate", kind: "number", min: 0, max: 2000, step: 0.1, unit: "/s", group: "emit", hint: "Particles per second. Key it to swell and stop." }),
      ...lookFields,
      ...viewFields,
      ...motionFields,
      ...advancedFields,
    ],
    create: () => make("stream"),
  },
  {
    type: "burst",
    label: "Burst",
    blurb: "All at once as its layer starts — confetti, a firework, a pop.",
    tags: ["particles", "emitter", "confetti", "explosion", "firework", "pop", "burst"],
    category: "emission",
    groups,
    toggles,
    fields: [
      ...emitFields({ key: "count", label: "Count", kind: "number", min: 1, max: 4000, step: 1, group: "emit", hint: "How many, all at once as the layer starts. Move the layer to move the pop." }),
      ...lookFields,
      ...viewFields,
      ...motionFields,
      ...advancedFields,
    ],
    create: () => make("burst", { spread: 360, speed: 900, life: 1.6 }),
  },
  {
    type: "hit",
    label: "On hit",
    blurb: "A burst wherever it hits — on a body, its own hits; on anything else, every hit in the comp.",
    tags: ["particles", "emitter", "impact", "collision", "hit", "sparks", "dust", "debris", "land"],
    category: "emission",
    groups,
    toggles,
    fields: [
      { key: "count", label: "Per hit", kind: "number", min: 1, max: 4000, step: 1, group: "emit", hint: "How many a hard hit throws. Softer hits throw fewer, slower." },
      { key: "threshold", label: "Softest", kind: "number", min: 0, max: 5000, step: 10, unit: "/s", group: "emit", hint: "Hits closing slower than this throw nothing — a ball settling stays quiet." },
      { key: "speed", label: "Speed", kind: "number", min: 0, max: 10000, step: 10, group: "emit", hint: "Units per second off a hard hit, out of the surface." },
      { key: "spread", label: "Spread", kind: "number", min: 0, max: 360, step: 1, unit: "°", group: "emit", hint: "The fan off the surface. 180 skims along it." },
      { key: "life", label: "Life", kind: "number", min: 0.05, max: 30, step: 0.05, unit: "s", group: "emit" },
      ...lookFields,
      ...viewFields,
      ...motionFields,
      ...advancedFields,
    ],
    create: () => make("hit", { count: 24, spread: 150, speed: 700, life: 0.6 }),
  },
  {
    type: "sub",
    label: "Sub-emitter",
    blurb: "From another card's particles — as each one dies or hits. A firework shell's burst, a splash.",
    tags: ["particles", "emitter", "sub", "child", "secondary", "firework", "shell", "splash", "crackle", "pop", "death"],
    category: "emission",
    groups,
    toggles,
    fields: [
      { key: "parent", label: "From", kind: "ref", ref: "emitter", empty: "The card above", group: "emit", hint: "Whose particles throw these." },
      {
        key: "on",
        label: "When",
        kind: "select",
        group: "emit",
        options: [
          { value: "death", label: "As each dies" },
          { value: "hit", label: "Each time one hits", hint: "Its parent must collide" },
        ],
      },
      { key: "count", label: "Per particle", kind: "number", min: 1, max: 4000, step: 1, group: "emit", hint: "How many each parent particle throws." },
      { key: "speed", label: "Speed", kind: "number", min: 0, max: 10000, step: 10, group: "emit", hint: "Units per second as they leave." },
      { key: "spread", label: "Spread", kind: "number", min: 0, max: 360, step: 1, unit: "°", group: "emit", hint: "The cone about the way the parent was going (off the surface, on a hit). 360 is a sphere." },
      { key: "inherit", label: "Carry", kind: "number", min: 0, max: 1, step: 0.01, group: "emit", hint: "How much of the parent's motion they keep. 0 bursts in place." },
      { key: "life", label: "Life", kind: "number", min: 0.05, max: 30, step: 0.05, unit: "s", group: "emit" },
      ...lookFields,
      ...viewFields,
      ...motionFields,
      ...advancedFields,
    ],
    create: () => make("sub", { count: 12, spread: 360, speed: 300, life: 0.8 }),
  },
];

export const EMITTER = createEffectRegistry<EmitterSpec, EmitterTypeDef>("emitter", "emit", EMITTER_TYPE_DEFS);

// ── Looks ────────────────────────────────────────────────────────────────────

/**
 * What people ask for, as presets of the types. One list: the card's preset
 * picker, the + menu and `physics.emit {look}` all read it. `aim` is the
 * carrier's rotation a new emitter of this look is made with (−90 = up).
 * A look that is more than one card (a firework shell and its burst) lists
 * the rest in `then`: sub-emitters, each thrown by the card above it.
 */
export interface EmitterLook {
  id: string;
  name: string;
  type: EmitterType;
  aim: number;
  chip: [string, string];
  tags: string[];
  /** Made for a layer that moves (a trail, sparks on hit): the + menu puts it on the selected layer when there is one. */
  carried?: boolean;
  patch: LookPatch;
  /**
   * Thrown to a height (shells): its first card's speed and life are tuned
   * for a comp 1080 tall and fitted to the comp it lands in, so a portrait
   * show bursts as high up the frame as a square one.
   */
  reach?: boolean;
  /** The cards after the first — sub-emitters of the card above each. */
  then?: Array<{ type: EmitterType; patch: LookPatch }>;
}

type LookPatch = Partial<Omit<EmitterSpec, "id" | "type" | "enabled">>;

/** Glitter where each spark dies — the crackle at a firework's edge. */
const CRACKLE: LookPatch = { on: "death", count: 2, spread: 360, speed: 90, inherit: 0.1, variance: 0.6, life: 0.3, weight: 0.2, drag: 0.5, collide: false, shape: "dot", size: 3, grow: 0, color: "#FFF6D8", colorEnd: "#FFC24F", fade: 1, glow: 1 };
/** A firework's sphere: each shell's own colour (hue wanders per shell), crackling at its edge. */
const PEONY: LookPatch = { on: "death", count: 160, spread: 360, sphere: true, speed: 420, inherit: 0.2, variance: 0.15, life: 1.6, weight: 0.3, drag: 0.85, collide: false, shape: "spark", size: 2.5, grow: 0.25, color: "#FF8FC8", colorEnd: "#D81B60", hue: 180, fade: 1, glow: 0.85 };
/** Droplets thrown up where each drop lands. */
const SPLASH: LookPatch = { on: "hit", count: 3, spread: 110, speed: 240, inherit: 0, variance: 0.5, life: 0.35, weight: 1, collide: false, shape: "dot", size: 3, grow: 0.5, color: "#DCE6FF", colorEnd: "#8FA4D8", fade: 1 };

export const EMITTER_LOOKS: EmitterLook[] = [
  {
    id: "sparks", name: "Sparks", type: "stream", aim: -90, chip: ["#fff3c4", "#ff8a1f"], tags: ["fire", "weld", "grinder", "embers"],
    patch: { rate: 120, spread: 50, speed: 900, variance: 0.5, life: 0.9, weight: 1, drag: 0.1, bounce: 0.35, friction: 0.3, shape: "spark", size: 3, grow: 0.4, color: "#FFF3C4", colorEnd: "#FF5A1F", fade: 1, glow: 0.6 },
  },
  {
    id: "fountain", name: "Fountain", type: "stream", aim: -90, chip: ["#bfe6ff", "#3a8fd8"], tags: ["water", "spray", "jet"],
    patch: { rate: 160, spread: 14, speed: 1100, variance: 0.25, life: 2.2, weight: 1, bounce: 0.2, friction: 0.4, shape: "dot", size: 7, grow: 0.6, color: "#DDF2FF", colorEnd: "#3A8FD8", fade: 0.8, soft: 0.35 },
  },
  {
    id: "smoke", name: "Smoke", type: "stream", aim: -90, chip: ["#9a9aa3", "#2b2b30"], tags: ["steam", "fog", "mist", "puff"],
    patch: { rate: 30, spread: 24, speed: 140, variance: 0.6, life: 3.5, weight: -0.08, drag: 0.4, collide: false, shape: "dot", size: 40, grow: 3, color: "#B9B9C2", colorEnd: "#3A3A40", fade: 1, soft: 1 },
  },
  {
    id: "rain", name: "Rain", type: "stream", aim: 90, chip: ["#c8d8ff", "#5b6f9a"], tags: ["storm", "drops", "weather", "splash"],
    patch: { rate: 260, source: "area", spread: 2, speed: 1400, variance: 0.2, life: 2.5, weight: 1, bounce: 0.15, friction: 0.6, shape: "spark", size: 2, grow: 1, color: "#C8D8FF", colorEnd: "#8FA4D8", fade: 0.3 },
    then: [{ type: "sub", patch: SPLASH }],
  },
  {
    id: "snow", name: "Snow", type: "stream", aim: 90, chip: ["#ffffff", "#cfe3ff"], tags: ["winter", "flakes", "dust", "float"],
    patch: { rate: 50, source: "area", spread: 40, speed: 60, variance: 0.6, life: 9, weight: 0.06, drag: 0.5, bounce: 0, friction: 1, shape: "dot", size: 7, grow: 1, color: "#FFFFFF", colorEnd: "#DCEBFF", fade: 0.6, soft: 0.5 },
  },
  {
    id: "confetti", name: "Confetti", type: "burst", aim: -90, chip: ["#ff3d7f", "#3dd6ff"], tags: ["party", "celebrate", "win", "launch"],
    patch: { count: 240, spread: 70, speed: 1500, variance: 0.5, life: 4, weight: 0.5, drag: 0.6, bounce: 0.2, friction: 0.8, spin: 720, shape: "square", size: 14, grow: 1, color: "#FF3D7F", colorEnd: "#FF3D7F", hue: 180, fade: 0.4 },
  },
  {
    // A sphere where it stands, crackling at its edge as the sparks die.
    id: "firework", name: "Firework", type: "burst", aim: 0, chip: ["#fff6d8", "#ff4fa8"], tags: ["explosion", "pop", "night", "celebrate", "sphere"],
    patch: { count: 220, spread: 360, sphere: true, speed: 460, variance: 0.15, life: 1.7, weight: 0.3, drag: 0.85, collide: false, shape: "spark", size: 2.5, grow: 0.3, color: "#FFE7F3", colorEnd: "#FF2E88", fade: 1, glow: 0.8 },
    then: [{ type: "sub", patch: CRACKLE }],
  },
  {
    // A show: shells rise from a strip along the bottom and burst near the top, each its own colour.
    id: "shell", name: "Firework shell", type: "stream", aim: -90, reach: true, chip: ["#ffb04f", "#7a5cff"], tags: ["firework", "rocket", "show", "night", "celebrate", "launch", "new year"],
    patch: { rate: 1.2, source: "area", spread: 14, speed: 1250, variance: 0.12, life: 1.1, weight: 1, drag: 0.05, collide: false, shape: "spark", size: 4, grow: 0.6, color: "#FFF3D6", colorEnd: "#FFB04F", fade: 0.2, glow: 0.7 },
    then: [
      { type: "sub", patch: PEONY },
      { type: "sub", patch: CRACKLE },
    ],
  },
  {
    // Left behind where it was: on a body that flies, a comet's tail. Born still, so it is the ball's path.
    id: "trail", name: "Trail", type: "stream", aim: 0, chip: ["#ffffff", "#4fc3ff"], tags: ["comet", "tail", "streak", "path", "satisfying"], carried: true,
    patch: { rate: 120, spread: 360, speed: 12, variance: 0.3, life: 0.6, weight: 0, drag: 0.5, collide: false, shape: "dot", size: 22, grow: 0, color: "#FFFFFF", colorEnd: "#4FC3FF", fade: 0.6, soft: 0.6, glow: 0.4, behind: true },
  },
  {
    id: "impact", name: "Impact sparks", type: "hit", aim: 0, chip: ["#fff3c4", "#ff6a1f"], tags: ["collision", "hit", "land", "metal", "satisfying"], carried: true,
    patch: { count: 26, threshold: 180, spread: 150, speed: 800, variance: 0.5, life: 0.55, weight: 1, drag: 0.15, bounce: 0.3, friction: 0.4, shape: "spark", size: 2.5, grow: 0.3, color: "#FFF3C4", colorEnd: "#FF5A1F", fade: 1, glow: 0.55 },
  },
  {
    id: "dust", name: "Dust", type: "hit", aim: 0, chip: ["#d9cfc0", "#7a705f"], tags: ["landing", "puff", "debris", "ground", "thud"], carried: true,
    // See-through, so the puffs pile into a cloud instead of beads.
    patch: { count: 10, threshold: 220, spread: 170, speed: 220, variance: 0.6, life: 0.9, weight: -0.05, drag: 0.9, collide: false, shape: "dot", size: 26, grow: 2.2, color: "#D9CFC05C", colorEnd: "#8A806F", fade: 1, soft: 1 },
  },
  // ── Space: what gravity does to gas. Made for a Gravity well (physics_force
  // gravity, comp gravity 0); without one an orbit circles the null at `speed`.
  {
    // Spirals in: born in orbit, a little drag bleeds the orbit away, white-hot where it is fast.
    id: "accretion", name: "Accretion disk", type: "stream", aim: 0, chip: ["#fff3dc", "#ff6a1f"], tags: ["black hole", "disk", "orbit", "spiral", "gravity", "space", "galaxy", "swirl"],
    patch: { rate: 520, source: "ring", inner: 130, outer: 360, launch: "orbit", orbit: 1, spread: 3, speed: 600, variance: 0.04, life: 8, weight: 0, drag: 0.03, collide: false, shape: "spark", size: 2.5, grow: 0.8, colorBy: "temperature", hot: 1100, kelvin: 7500, fade: 0.4, glow: 0.7 },
  },
  {
    // Gas falling in from far out, brightening as it speeds up.
    id: "infall", name: "Infall", type: "stream", aim: 0, chip: ["#8d9bc8", "#ffd9a8"], tags: ["collapse", "fall", "gravity", "black hole", "implode", "suck", "space"],
    patch: { rate: 220, source: "ring", inner: 520, outer: 900, launch: "inward", speed: 120, spread: 12, variance: 0.3, life: 6, weight: 0, drag: 0, collide: false, shape: "dot", size: 5, grow: 0.6, colorBy: "speed", hot: 900, color: "#7D8BB866", colorEnd: "#FFD9A8", fade: 0.2, soft: 0.6, glow: 0.5 },
  },
  {
    // Blown off a star's surface: put it on the star, its ring at the star's radius.
    id: "wind", name: "Stellar wind", type: "stream", aim: 0, chip: ["#ffd9a8", "#ff6a3c"], tags: ["star", "sun", "corona", "solar wind", "flare", "plasma", "space"],
    patch: { rate: 160, source: "ring", inner: 290, outer: 310, launch: "outward", speed: 220, spread: 20, variance: 0.5, life: 3, weight: 0, drag: 0.2, collide: false, shape: "dot", size: 14, grow: 2.5, color: "#FFD9A8", colorEnd: "#FF6A3C", fade: 1, soft: 1, glow: 0.3 },
  },
  {
    // A shell thrown in 3D and seen flat: a disc with a bright rim, cooling from blue-white to ember as drag slows it.
    id: "supernova", name: "Supernova shell", type: "burst", aim: 0, chip: ["#eaf2ff", "#ff7a3c"], tags: ["explosion", "supernova", "nova", "blast", "shell", "star", "death", "space"],
    patch: { count: 1600, source: "ring", inner: 30, outer: 60, launch: "outward", speed: 900, spread: 0, sphere: true, variance: 0.25, life: 3.2, weight: 0, drag: 0.45, collide: false, shape: "spark", size: 3, grow: 0.5, colorBy: "temperature", hot: 1000, kelvin: 16000, fade: 0.7, glow: 0.9 },
  },
  {
    id: "peony", name: "Peony", type: "sub", aim: 0, chip: ["#ff8fc8", "#4fd8ff"], tags: ["firework", "sphere", "burst", "shell", "death", "colour"],
    patch: PEONY,
  },
  {
    id: "crackle", name: "Crackle", type: "sub", aim: 0, chip: ["#fff6d8", "#ffc24f"], tags: ["glitter", "firework", "pop", "sparkle", "death"],
    patch: CRACKLE,
  },
  {
    id: "splash", name: "Splash", type: "sub", aim: 0, chip: ["#dce6ff", "#8fa4d8"], tags: ["rain", "drops", "water", "land", "hit"],
    patch: SPLASH,
  },
];

/** A fresh emitter in a look (the look's patch over its type's defaults) — its first card. */
export function emitterFromLook(look: EmitterLook): EmitterSpec {
  return { ...EMITTER.create(look.type), ...look.patch };
}

/**
 * The look a card still IS — its type and every field the look sets — or
 * undefined once it has been changed away from it. What a card is called:
 * "Peony" says more than a second "Sub-emitter".
 */
export function emitterLookOf(e: EmitterSpec): EmitterLook | undefined {
  const rec = e as unknown as Record<string, unknown>;
  // A look fitted to its comp's height (`reach`) is still itself at any speed and life.
  return EMITTER_LOOKS.find((l) => l.type === e.type && Object.entries(l.patch).every(([k, v]) => rec[k] === v || (l.reach && (k === "speed" || k === "life"))));
}

/**
 * Every card a look is, in stack order: its first, then its sub-emitters
 * (each thrown by the card above). Given the comp, a look thrown to a height
 * is fitted to it: rising h under gravity takes v ∝ √h and t ∝ √h.
 */
export function emittersFromLook(look: EmitterLook, frame?: { height: number }): EmitterSpec[] {
  const first = emitterFromLook(look);
  if (look.reach && frame) {
    const k = Math.sqrt(Math.max(0.25, frame.height / 1080));
    first.speed = Math.min(10000, first.speed * k);
    first.life = Math.min(30, first.life * k);
  }
  return [first, ...(look.then ?? []).map((c) => ({ ...EMITTER.create(c.type), ...c.patch }))];
}

/**
 * Whose particles a `sub` card's particles come from, as an index in its
 * stack: the card it names, else (none named, itself, or a card since gone —
 * a look re-applied with fresh ids) the card above it. Null when it has none, or
 * when following parents would come back round to it (two subs naming each
 * other) — a sub never throws from its own descendants, so nothing runs away.
 */
export function subParentIndex(list: readonly Pick<EmitterSpec, "id" | "type" | "parent">[], i: number): number | null {
  const up = (j: number): number | null => {
    const e = list[j];
    if (!e || e.type !== "sub") return null;
    const named = e.parent ? list.findIndex((x) => x.id === e.parent) : -1;
    const k = named >= 0 && named !== j ? named : j - 1;
    return k >= 0 && k !== j ? k : null;
  };
  const first = up(i);
  // Walk the chain: back to `i` is a loop.
  for (let k = first, n = 0; k !== null && n <= list.length; k = up(k), n++) if (k === i) return null;
  return first;
}

export function emitterLook(id: string): EmitterLook | undefined {
  return EMITTER_LOOKS.find((l) => l.id === id);
}

/**
 * Where a NEW carrier for a look stands in a comp — the one placement the +
 * menu and `physics.emit` share. A look born across an area is a null
 * stretched into a strip — rain and snow just above the comp's top edge,
 * shells thrown up along its bottom (a null's box is
 * a nominal 100 square, so its scale IS the strip); the rest stand at
 * `at` (default the comp's centre), aimed by the look.
 */
export function emitterCarrierFor(look: EmitterLook | undefined, frame: { width: number; height: number }, at?: readonly [number, number]): { x: number; y: number; rotation: number; scale: number; scaleY: number | null } {
  const rotation = look?.aim ?? 0;
  if (look?.patch.source === "area") {
    // The strip lies ACROSS the aim (a layer emits along its own +X): its
    // length is its Y scale. Thrown up (shells): along the bottom, inset.
    // Falling (rain): just above the top edge, past both sides.
    const up = Math.sin((rotation * Math.PI) / 180) < 0;
    return { x: at?.[0] ?? 0, y: at?.[1] ?? (up ? frame.height / 2 - 24 : -frame.height / 2 - 24), rotation, scale: 0.08, scaleY: (frame.width * (up ? 0.6 : 1.15)) / 100 };
  }
  return { x: at?.[0] ?? 0, y: at?.[1] ?? 0, rotation, scale: 1, scaleY: null };
}

// ── As property paths (`emit.<id>.<field>`) ─────────────────────────────────

const PATH = /^emit\.([^.]+)\.([^.]+)$/;
/** Every field by the kind of value it holds, read off the schema's own defaults — one list, never a second. */
const DEFAULTS = emitterSchema.parse({ id: "_" }) as Record<string, unknown>;
const OPTIONS: Record<string, readonly string[]> = Object.fromEntries(
  EMITTER_TYPE_DEFS.flatMap((d) => d.fields).filter((f) => f.kind === "select").map((f) => [f.key, f.options!.map((o) => o.value)]),
);
const RANGE: Record<string, { min?: number; max?: number; int?: boolean }> = {
  ...Object.fromEntries(EMITTER_TYPE_DEFS.flatMap((d) => d.fields).filter((f) => f.kind === "number").map((f) => [f.key, { min: f.min, max: f.max }])),
  count: { min: 1, max: 4000, int: true },
  threshold: { min: 0, max: 5000 },
  seed: { int: true },
};

const emitterOf = (clip: Clip, id: string): EmitterSpec | undefined => (clip.kind === "audio" ? undefined : clip.emitters?.find((e) => e.id === id));

export function isEmitterPath(path: string): boolean {
  return path.startsWith("emit.") && PATH.test(path);
}

export function getEmitterProperty(clip: Clip, path: string): KeyframeValue | undefined {
  const m = PATH.exec(path);
  const e = m ? emitterOf(clip, m[1]!) : undefined;
  if (!e) return undefined;
  const v = (e as Record<string, unknown>)[m![2]!];
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : undefined;
}

/** Write one emitter field on a clip (a draft or a baked copy). False when the path is not an emitter's. */
export function setEmitterProperty(clip: Clip, path: string, value: KeyframeValue): boolean {
  const m = PATH.exec(path);
  if (!m || clip.kind === "audio") return false;
  const list = clip.emitters;
  const i = list?.findIndex((e) => e.id === m[1]) ?? -1;
  if (!list || i < 0) return true;
  const k = m[2]!;
  const was = DEFAULTS[k];
  let v: unknown;
  if (typeof was === "number" && typeof value === "number" && Number.isFinite(value)) {
    const r = RANGE[k] ?? {};
    v = Math.min(r.max ?? Infinity, Math.max(r.min ?? -Infinity, r.int ? Math.round(value) : value));
  } else if (typeof was === "boolean" && typeof value === "boolean") v = value;
  else if (typeof value === "string" && (OPTIONS[k] ? OPTIONS[k]!.includes(value) : typeof was === "string")) v = value;
  if (v === undefined) return true;
  clip.emitters = list.map((e, j) => (j === i ? { ...e, [k]: v } : e));
  return true;
}

/** Every keyable emitter path a clip has, card by card — the node board, the curve editor and `layer_properties`. */
export function emitterClipPaths(clip: Clip): Array<{ path: string; emitter: EmitterSpec; label: string }> {
  if (clip.kind === "audio" || !clip.emitters?.length) return [];
  const out: Array<{ path: string; emitter: EmitterSpec; label: string }> = [];
  for (const e of clip.emitters) {
    const def = EMITTER.def(e.type);
    for (const field of def?.fields ?? []) if (field.kind === "number" || field.kind === "color") out.push({ path: EMITTER.path(e.id, field.key), emitter: e, label: def!.label });
  }
  return out;
}

/** Does this layer give off particles — any emitter switched on? */
export function hasEmitters(clip: Clip): boolean {
  return clip.kind !== "audio" && !!clip.emitters?.some((e) => e.enabled);
}
