import type { Behavior, KeyframeValue } from "../schema";
import { createId } from "../ids";
import { createEffectRegistry, type EffectFieldDef, type EffectTypeDefBase } from "../animation/effect-base";

/**
 * THE BEHAVIOR STACK — what a character does on its own (Characters 3.0,
 * docs/adr/ADR-characters-3.md).
 *
 * The sixth domain of the one effect registry (`effect-base.ts`), after
 * pixels, sound, glyphs, geometry and forces: a behavior is an instance with a
 * stable id, a type and its fields, in an ordered list on the character group
 * (`group.behaviors`). So the Character tab's Behaviors section IS the effect
 * stack — drag to reorder, duplicate, mute, presets and looks, the floating
 * editor with keyframe diamonds — and every number keys at `bhv.<id>.<field>`
 * like any other channel: key Blink's `every` down to blink faster when the
 * character is nervous.
 *
 * Two shapes, declared by `drives`:
 *
 *  - `set`: it answers which POSE a set shows, only while it is ACTIVE (Blink
 *    while shut, Lip sync while a voice plays). Order is priority: a later
 *    behavior wins where two are active; where none is, your keys show.
 *  - `channel`: it ADDS onto a channel (a bone's stretch, a layer's turn), so
 *    your keys and hand moves stay underneath — order never changes the sum.
 *
 * The registry is DATA (fields, defaults, copy). What a kind does at an
 * instant lives in `evaluate.ts`, keyed by the same `type`.
 */

export type BehaviorType = "lipSync" | "blink" | "glance" | "breathe" | "sway" | "nod" | "cycle" | "machine";

export interface BehaviorTypeDef extends EffectTypeDefBase<Behavior> {
  type: BehaviorType;
  /** A pose set (`set` field) or channels (`layer` + `channel` fields). */
  drives: "set" | "channel";
  /** The vocabulary a set behavior is FOR — how `behaviors.add` picks its set when none is named. */
  wants?: "visemes" | "eyes" | "brows" | "hands" | "emotions";
  /** The channel a channel behavior starts on, in preference order (`bone:<name pattern>` or a layer path). */
  defaultChannel?: string;
}

const pick = (key: string, label: string, ref: NonNullable<EffectFieldDef["ref"]>, hint: string, extra: Partial<EffectFieldDef> = {}): EffectFieldDef => ({
  key,
  label,
  kind: "ref",
  ref,
  hint,
  ...extra,
});

const SET = (hint: string) => pick("set", "Part", "poseSet", hint);
const LAYER = pick("layer", "On", "part", "The layer it moves — the character itself, or one of its parts.");
const CHANNEL = pick("channel", "Channel", "channel", "What it moves: a bone's turn or stretch, a layer's position, turn or scale.", { refOf: "layer" });
const SEED: EffectFieldDef = { key: "seed", label: "Seed", kind: "number", min: 0, max: 9999, step: 1, hint: "Another seed, another take of the same behavior." };

const base = (type: BehaviorType, extra: Record<string, KeyframeValue | undefined>): Behavior =>
  ({ id: createId("bhv"), type, enabled: true, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)) }) as Behavior;

export const BEHAVIOR_TYPE_DEFS: BehaviorTypeDef[] = [
  {
    type: "lipSync",
    label: "Lip sync",
    blurb: "The mouth follows whichever voice is playing.",
    tags: ["talk", "speak", "voice", "mouth", "visemes", "dialogue", "lipsync"],
    category: "speech",
    drives: "set",
    wants: "visemes",
    fields: [
      SET("The mouth it moves."),
      pick("voice", "Voice", "voice", "Every voice in reach — whichever is playing — or one layer."),
      pick("rest", "In pauses", "pose", "What the mouth does between words while the voice plays. Empty: rest."),
      { key: "lead", label: "Lead", kind: "number", min: -200, max: 200, step: 5, unit: "ms", bipolar: true, hint: "Arrive this much before the sound (animators lead by a frame or two)." },
    ],
    toggles: [{ key: "pausesShowKeys", label: "Pauses show your poses", hint: "Between words, show what you posed instead of the rest shape." }],
    create: () => base("lipSync", { set: "", voice: "", rest: "", lead: 0, pausesShowKeys: false }),
  },
  {
    type: "blink",
    label: "Blink",
    blurb: "A living, uneven blink, with the odd double.",
    tags: ["eyes", "lids", "close", "shut", "wink", "alive"],
    category: "eyes",
    drives: "set",
    wants: "eyes",
    fields: [
      SET("The eyes that blink."),
      pick("closed", "Shut", "pose", "The pose of a shut eye."),
      pick("half", "Halfway", "pose", "An in-between the lids pass through (top and bottom lids). Empty: none."),
      { key: "every", label: "Every", kind: "number", min: 0.5, max: 30, step: 0.1, unit: "s", hint: "Seconds between blinks, on average." },
      { key: "length", label: "Length", kind: "number", min: 40, max: 800, step: 5, unit: "ms", hint: "How long the eye stays shut." },
      { key: "variance", label: "Unevenness", kind: "number", min: 0, max: 100, step: 1, unit: "%", hint: "How much the gaps vary. 0 is a metronome." },
      { key: "doubles", label: "Doubles", kind: "number", min: 0, max: 100, step: 1, unit: "%", hint: "How often a blink comes twice." },
      SEED,
    ],
    create: () => base("blink", { set: "", closed: "Closed", half: "", every: 4, length: 120, variance: 40, doubles: 17, seed: 0 }),
  },
  {
    type: "glance",
    label: "Glance",
    blurb: "Eyes look around on their own, then settle.",
    tags: ["look", "eyes", "saccade", "gaze", "around", "wander"],
    category: "eyes",
    drives: "channel",
    defaultChannel: "bone:^look$",
    fields: [
      pick("bone", "Control", "bone", "The bone the eyes look through (a Look control). Empty: turn a layer instead."),
      pick("layer", "Or turn", "part", "An eye to turn on its own (a 3D eyeball's group): left–right and up–down, in degrees."),
      { key: "rangeX", label: "Across", kind: "number", min: 0, max: 400, step: 1, hint: "How far it looks left and right (px for a control, ° for a layer)." },
      { key: "rangeY", label: "Up/down", kind: "number", min: 0, max: 400, step: 1, hint: "How far it looks up and down (px for a control, ° for a layer)." },
      { key: "hold", label: "Holds", kind: "number", min: 0.2, max: 10, step: 0.1, unit: "s", hint: "How long a look rests, on average." },
      { key: "move", label: "Move", kind: "number", min: 20, max: 600, step: 5, unit: "ms", hint: "How fast the eyes jump between looks." },
      { key: "centre", label: "Back to centre", kind: "number", min: 0, max: 100, step: 1, unit: "%", hint: "How often a look returns to straight ahead." },
      { ...SEED, hint: "Glances with the same seed look together — one per eye, both eyes at once." },
    ],
    create: () => base("glance", { bone: "", layer: "", rangeX: 24, rangeY: 10, hold: 1.6, move: 90, centre: 40, seed: 0 }),
  },
  {
    type: "breathe",
    label: "Breathe",
    blurb: "A slow breath in the chest.",
    tags: ["breath", "idle", "alive", "chest", "torso", "rise"],
    category: "body",
    drives: "channel",
    defaultChannel: "bone:^(chest|torso|spine|body)",
    fields: [
      LAYER,
      CHANNEL,
      { key: "amount", label: "Depth", kind: "number", min: 0, max: 20, step: 0.1, hint: "On a stretch or scale: percent. Otherwise its own units (px, °)." },
      { key: "rate", label: "Breaths", kind: "number", min: 2, max: 60, step: 1, unit: "/min", hint: "Breaths a minute. 12–18 is calm." },
      { key: "phase", label: "Phase", kind: "number", min: 0, max: 100, step: 1, unit: "%", hint: "Where in a breath it starts." },
    ],
    toggles: [{ key: "keepBottom", label: "Keep the bottom still", hint: "A layer breathes up from its bottom edge instead of about its pivot." }],
    create: () => base("breathe", { layer: "", channel: "", amount: 1.4, rate: 16, phase: 0, keepBottom: true }),
  },
  {
    type: "sway",
    label: "Sway",
    blurb: "An organic drift — a head that never quite stops.",
    tags: ["wiggle", "idle", "drift", "noise", "alive", "float", "bob"],
    category: "body",
    drives: "channel",
    defaultChannel: "bone:^(head|neck)",
    fields: [
      LAYER,
      CHANNEL,
      { key: "amount", label: "Amount", kind: "number", min: 0, max: 90, step: 0.1, hint: "How far it strays either side, in the channel's units (° for a turn)." },
      { key: "speed", label: "Speed", kind: "number", min: 0.02, max: 4, step: 0.01, unit: "Hz", hint: "Wanders a second." },
      SEED,
    ],
    create: () => base("sway", { layer: "", channel: "", amount: 2, speed: 0.25, seed: 0 }),
  },
  {
    type: "nod",
    label: "Nod with voice",
    blurb: "The voice's loudness moves the head as it talks.",
    tags: ["nod", "head", "loudness", "talk", "emphasis", "jaw"],
    category: "speech",
    drives: "channel",
    defaultChannel: "bone:^(head|neck)",
    fields: [
      LAYER,
      CHANNEL,
      pick("voice", "Voice", "voice", "Every voice in reach, or one layer."),
      { key: "amount", label: "Amount", kind: "number", min: -90, max: 90, step: 0.1, bipolar: true, hint: "How far it moves at full voice, in the channel's units." },
    ],
    create: () => base("nod", { layer: "", channel: "", voice: "", amount: 1.5 }),
  },
  {
    type: "cycle",
    label: "Cycle",
    blurb: "Loops through poses on its own — an idle, a fidget, a flicker.",
    tags: ["loop", "idle", "sequence", "repeat", "animation", "flip", "cycle"],
    category: "logic",
    drives: "set",
    fields: [
      SET("The part that cycles."),
      {
        key: "mode",
        label: "Plays",
        kind: "select",
        options: [
          { value: "loop", label: "Loop" },
          { value: "pingpong", label: "Back and forth" },
          { value: "once", label: "Once" },
        ],
      },
      { key: "speed", label: "Speed", kind: "number", min: 10, max: 400, step: 1, unit: "%", hint: "100% plays each step for its own length." },
      { key: "offset", label: "Offset", kind: "number", min: -60000, max: 60000, step: 10, unit: "ms", bipolar: true, hint: "Start this far into the cycle." },
    ],
    create: () => base("cycle", { set: "", mode: "loop", speed: 100, offset: 0 }),
  },
  {
    type: "machine",
    label: "State machine",
    blurb: "A board of states and transitions picks the poses.",
    tags: ["state", "machine", "logic", "rive", "transition", "interactive", "graph"],
    category: "logic",
    drives: "set",
    fields: [pick("machine", "Machine", "machine", "The machine whose states pick this character's poses.")],
    create: () => base("machine", { machine: "" }),
  },
];

export const BEHAVIOR = createEffectRegistry<Behavior, BehaviorTypeDef>("behavior", "bhv", BEHAVIOR_TYPE_DEFS);

export function behaviorDef(type: string): BehaviorTypeDef | undefined {
  return BEHAVIOR.def(type);
}

/** A field or toggle's stored value on an instance, or its default. */
export function behaviorValue(b: Behavior, key: string): KeyframeValue | undefined {
  const own = (b as Record<string, unknown>)[key];
  if (typeof own === "number" || typeof own === "string" || typeof own === "boolean") return own;
  const d = BEHAVIOR.defaults(b.type)[key];
  return typeof d === "number" || typeof d === "string" || typeof d === "boolean" ? d : undefined;
}

/** A behavior's display name: its type's label. */
export function behaviorLabel(b: Behavior): string {
  return behaviorDef(b.type)?.label ?? b.type;
}
