import type { ClipKind } from "../schema/clips";

/**
 * THE BASE EFFECT — the one vocabulary every effect in the app speaks.
 *
 * The app used to grow effects in silos: a per-glyph text stack with its own
 * registry, its own schema union, its own inspector and its own five duplicate
 * cards (two Glows, two Shadows, two Blurs, two Inner shadows that could not
 * agree what "size" meant). A sound stack was about to become a third. Three
 * silos is three answers to every question a surface has to ask — what fields
 * does this thing have, where do its keyframes live, which layers may carry it,
 * what does its preset look like — and a surface that asks three times is a
 * surface that will eventually get three different answers.
 *
 * So there is now exactly one answer, here, and each DOMAIN (pixels, sound…)
 * specialises it rather than restating it:
 *
 *   BaseEffect          what an effect INSTANCE is:  { id, type, enabled }
 *   EffectTypeDefBase   what an effect KIND declares: fields, groups, toggles,
 *                       category, targets, presets, create()
 *   createEffectRegistry  the lookup + the keyframe path convention + clone +
 *                       stack summary — written once, handed to every domain
 *
 * Everything downstream is generic over this: `resolveEffectValues` (keyframes,
 * colours, modulators, px scaling), the floating effect editor (which renders
 * ANY effect from its field metadata alone), the preset library, the node board
 * (one card type per registry entry), the property registry, the add palette.
 * A domain that registers here gets all of it on the day it registers — which
 * is the whole point, and the contract the audio stack is being built against.
 */

// ── An instance ──────────────────────────────────────────────────────────────

/**
 * Every effect instance in every domain. `id` is stable so keyframe tracks
 * (`<prefix>.<id>.<field>`) address it and survive reordering; `enabled` is the
 * mute the stack UI toggles. Domains add their own discriminated `type` arms on
 * top of this — the union is the schema's job, this is the shared floor.
 */
export interface BaseEffect {
  id: string;
  type: string;
  enabled: boolean;
  /**
   * A self-moving card's motion switch (`ownMotion` in the layer schema).
   * Absent on cards that never move by themselves.
   */
  animate?: boolean;
}

/**
 * THE CARD'S OWN CLOCK — the time a self-moving card reads for the motion it
 * makes by itself: grain re-rolling, a shine travelling, a wave rolling, noise
 * drifting. With its `animate` switch off that clock stops at 0, so the card
 * holds one look (its seed's, or wherever its position sits) for the whole
 * clip. Keyframes and modulators read real time regardless: holding a card
 * still never takes hand animation away.
 *
 * Every card brain calls this rather than reading `animate` itself, so a card
 * added later cannot forget the switch exists.
 */
export function ownClockSec(effect: Pick<BaseEffect, "type" | "animate">, timeSec: number): number {
  return effect.animate === false ? 0 : timeSec;
}

/**
 * What an effect PROCESSES. Not a UI grouping — a pipeline: a layer effect is a
 * function of pixels, an audio effect a function of samples, and no surface
 * that consumes one can consume the other. The domain is therefore what
 * partitions the registry, the add palette and the keyframe namespace.
 */
export type EffectDomain = "layer" | "audio" | "text" | "geometry" | "force" | "emitter" | "behavior";

/**
 * Does a card of this domain change a PICTURE you could preview flat? Layer and
 * glyph effects do; sound has no picture, and a modifier's picture is the 3D
 * viewport itself, live — so the editor's before/after block is for these two.
 */
export function effectDomainHasPicture(domain: EffectDomain): boolean {
  return domain === "layer" || domain === "text";
}

// ── Taxonomy ─────────────────────────────────────────────────────────────────

/**
 * The ONE effect taxonomy, across every domain. Ordered as the palette renders
 * them, scoped by domain so a sound card can never land under "Blur & Sharpen".
 */
export type EffectCategory =
  // layer
  | "material"
  | "analog"
  | "shadow-glow"
  | "blur"
  | "color"
  | "stylize"
  | "distort"
  | "light"
  | "cosmos"
  | "texture"
  // audio
  | "dynamics"
  | "eq"
  | "space"
  | "modulation"
  | "character"
  // text — per glyph
  | "glyph-light"
  | "glyph-depth"
  // geometry — a mesh's modifier stack (3D worlds)
  | "generate"
  | "deform"
  | "simulate"
  // force — what a layer does to the bodies around it (physics)
  | "push"
  | "air"
  // emitter — particles a layer gives off (physics)
  | "emission"
  // behavior — what a character does on its own (Characters 3.0)
  | "speech"
  | "eyes"
  | "body"
  | "logic";

export interface EffectCategoryDef {
  id: EffectCategory;
  label: string;
  domain: EffectDomain;
}

export const EFFECT_CATEGORIES: readonly EffectCategoryDef[] = [
  // Materials read the pixels BEHIND the layer (glass refracts its backdrop) —
  // a different class of effect from the ones that only restyle their own
  // silhouette, so they get their own heading rather than hiding in Stylize.
  { id: "material", label: "Material", domain: "layer" },
  // Analog cards are the TIME-VARYING ones: their output changes from frame to
  // frame off a seeded clock rather than only when you move a slider. That is a
  // real behavioural difference (they need a seed, they animate a parked
  // playhead in the preview), so they read as their own family.
  { id: "analog", label: "Film & Video", domain: "layer" },
  { id: "shadow-glow", label: "Shadow & Glow", domain: "layer" },
  // Light cards ADD light rather than restyling what is already painted: a
  // sweep, a god ray, a flare, an arc. They are their own heading because they
  // are the reason people install plugins, and burying a lightning generator
  // under "Stylize" is how nobody finds it.
  { id: "light", label: "Light & Optics", domain: "layer" },
  { id: "blur", label: "Blur & Sharpen", domain: "layer" },
  { id: "color", label: "Color", domain: "layer" },
  { id: "stylize", label: "Stylize", domain: "layer" },
  { id: "distort", label: "Distort", domain: "layer" },
  // Space: cards that bend the backdrop as gravity does, and cards that paint
  // a sky — the subject is the reason to look, so it is one heading.
  { id: "cosmos", label: "Space", domain: "layer" },
  // Texture: the MATERIAL the picture is printed on or made of — paper,
  // cloth, card. Its own heading because "make it look made" is a goal people
  // arrive with, and none of Stylize's cards answer it.
  { id: "texture", label: "Texture", domain: "layer" },
  // Audio, ordered the way a channel strip reads top to bottom.
  { id: "eq", label: "EQ & Filter", domain: "audio" },
  { id: "dynamics", label: "Dynamics", domain: "audio" },
  { id: "space", label: "Space", domain: "audio" },
  { id: "modulation", label: "Modulation", domain: "audio" },
  { id: "character", label: "Character", domain: "audio" },
  // Text passes are drawn PER GLYPH, from the letter's own resolved style —
  // which is what lets a caption's focused word carry its own glow. Two
  // headings: what casts light or shade around a letter, and what gives it
  // depth behind it.
  { id: "glyph-light", label: "Shadow & Glow", domain: "text" },
  { id: "glyph-depth", label: "Depth & Trails", domain: "text" },
  // Modifiers process GEOMETRY, so they are their own domain (ADR-3d). Blender's
  // own three headings: what adds or rebuilds polygons, what bends the ones
  // there are, and what turns a shape into something that moves on its own.
  { id: "generate", label: "Generate", domain: "geometry" },
  { id: "deform", label: "Deform", domain: "geometry" },
  { id: "simulate", label: "Simulate", domain: "geometry" },
  // Forces act on BODIES (ADR-physics): what moves them, and the air they move through.
  { id: "push", label: "Push & Pull", domain: "force" },
  { id: "air", label: "Air", domain: "force" },
  // Emitters give off PARTICLES that live in the same simulation.
  { id: "emission", label: "Particles", domain: "emitter" },
  // Behaviors are read by the part they bring to life, the way an animator
  // asks for them: what talks, what looks, what moves, and what decides.
  { id: "speech", label: "Voice", domain: "behavior" },
  { id: "eyes", label: "Eyes", domain: "behavior" },
  { id: "body", label: "Body", domain: "behavior" },
  { id: "logic", label: "Loops & logic", domain: "behavior" },
];

export function effectCategories(domain: EffectDomain): readonly EffectCategoryDef[] {
  return EFFECT_CATEGORIES.filter((c) => c.domain === domain);
}

// ── Fields ───────────────────────────────────────────────────────────────────

/** One choice in a `select` field. */
export interface EffectFieldOption {
  value: string;
  label: string;
  /** Optional one-liner shown under the label in the picker. */
  hint?: string;
}

/**
 * A field is shown only when another field of the same effect holds one of
 * these values. DATA, not a predicate, on purpose: the editor, a native adapter
 * and a future web-component renderer all have to evaluate it, and a closure
 * only the TypeScript build can call would make the metadata un-portable — the
 * one property that makes this registry worth having.
 */
export interface EffectFieldCondition {
  key: string;
  equals: ReadonlyArray<string | number | boolean>;
  /** Show when the sibling holds NONE of `equals` — "only once a texture is picked" is `{ equals: [""], not: true }`. */
  not?: boolean;
}

/**
 * What a field holds. `layer`, `ref` and `image` are REFERENCES — an id the
 * user picks, never keyed or modulated (see `isReferenceField`).
 *
 * `image` is a picture the effect reads — a texture, a pattern, a map — by
 * the id of an image asset in `doc.assets` ("" = none). It is a field and not
 * a bespoke control so every effect that reads a picture gets the same well:
 * the picture shown live, replaced from the media library, dropped in from
 * the desktop, reset to what the effect makes on its own. When the effect
 * GENERATES a picture of its own (Surface's material), an empty field shows
 * that one — what you would be replacing — so the default is never a blank.
 */
export type EffectFieldKind = "number" | "color" | "select" | "layer" | "ref" | "image";

/** A pick, never a key: there is no halfway between two layers or two pictures. */
export function isReferenceField(kind: EffectFieldKind): kind is "layer" | "ref" | "image" {
  return kind === "layer" || kind === "ref" || kind === "image";
}

export interface EffectFieldDef {
  /** Sub-property key, e.g. "blur" — keyframed as `<prefix>.<effectId>.<key>`. */
  key: string;
  label: string;
  /**
   * `select` is an enum-valued field (a mask shape, a blend mode). It rides the
   * same keyframe path as everything else and interpolates as `discrete` — hold
   * until the next key — which is exactly right: there is no halfway between a
   * dot mask and a slot mask, and pretending otherwise would produce a frame
   * that renders neither.
   */
  kind: EffectFieldKind;
  /**
   * What a `ref` field picks — a REFERENCE into the thing the stack lives on,
   * whose choices only the host can list: a pose set of the character, a pose
   * of the set another field names (`refOf`, default `set`), a bone of its
   * rig, a voice layer, a channel, a machine, another card of the same stack
   * (a sub-emitter's parent). Stored as an id (a pose: its name). Never keyed.
   */
  ref?: "poseSet" | "pose" | "bone" | "voice" | "channel" | "machine" | "part" | "emitter";
  /** For `ref: "pose"`: the field holding the set whose poses are offered. */
  refOf?: string;
  min?: number;
  max?: number;
  step?: number;
  /**
   * `layer` is a REFERENCE to another layer by id (a path to follow, a surface
   * to wrap onto, a controller to hook to) — picked from the comp's layers,
   * never keyed. Empty = none.
   */
  /** What an EMPTY `layer` field means, as its picker shows it ("This layer"); default "None". */
  empty?: string;
  /** Required for `kind: "select"`; ignored otherwise. */
  options?: readonly EffectFieldOption[];
  /**
   * Presentation metadata — read by the ONE field renderer in the effect
   * editor, so a rich effect (30 fields) reads like a designed panel instead
   * of a wall of numbers, with zero per-effect UI code.
   */
  /** Section this field belongs to (see `EffectTypeDefBase.groups`). */
  group?: string;
  /** Trailing unit on the number input: "px", "°", "%", "×". */
  unit?: string;
  /** Tooltip — say what the field DOES, not what it is called. */
  hint?: string;
  /** Slider fills outward from 0 instead of from `min` (−1..1 trims). */
  bipolar?: boolean;
  /**
   * The value is authored in FRAME px and must be scaled by the render scale
   * (zoom / export size) to stay correct. Declared here so the renderer and any
   * future adapter read one truth instead of hard-coding a list of keys.
   */
  scaled?: boolean;
  /** Hide this row unless a sibling field holds one of the listed values. */
  showIf?: EffectFieldCondition;
  /**
   * A `select` whose choices are best SEEN: each option shows a swatch the
   * host renders (a material, by its value). Data, so every surface that
   * lists the field can draw the same picker.
   */
  preview?: "material";
}

/** A collapsible section of fields inside the effect editor. */
export interface EffectFieldGroupDef {
  id: string;
  label: string;
  /** Start collapsed — for advanced/rarely-touched blocks. */
  collapsed?: boolean;
  /**
   * An ADVANCED section: rendered under one "Advanced" disclosure after the
   * main sections, closed by default. The main sections are the six or seven
   * controls that decide the look; everything here is for the user who has
   * already got the look and wants to argue with it. Data, not a UI decision,
   * so every surface that lists fields (the editor, the node card, a future
   * panel) makes the same split.
   */
  advanced?: boolean;
}

/**
 * How this kind's floating editor OPENS. A hint, not a law — the user's own
 * resize wins and is remembered per kind.
 *
 * `height` defaults to `"auto"`: the window hugs its content. That default is
 * the fix for a whole class of bug this app had — a fixed 560px window opening
 * over a 240px body, so every small effect shipped with a field of dead grey
 * under it that read as a feature that had failed to load. A NUMBER is only
 * right when the body genuinely wants the room (a graph you drag, a curve you
 * want tall); everything else should hug.
 *
 * `width` is the honest per-effect judgement the registry is the only place to
 * make: an equaliser needs three decades of frequency on screen, a Grain card
 * needs four rows. Declaring it here — beside the fields that justify it —
 * is why there is no longer a table of magic sizes in a UI file that nobody
 * updates when an effect gains a group.
 */
export interface EffectEditorHint {
  /** Opening width in px. Omitted = the editor's own default. */
  width?: number;
  /** Opening height in px, or "auto" (default) to hug the content. */
  height?: number | "auto";
}

/** A boolean switch — a mode, not a value, so it never keyframes. */
export interface EffectToggleDef {
  key: string;
  label: string;
  hint?: string;
  group?: string;
  showIf?: EffectFieldCondition;
}

/** True when a conditional row should render against this instance's values. */
export function effectFieldVisible(
  field: { showIf?: EffectFieldCondition },
  effect: Record<string, unknown>,
): boolean {
  if (!field.showIf) return true;
  const actual = effect[field.showIf.key];
  const hit = field.showIf.equals.some((v) => v === actual);
  return field.showIf.not ? !hit : hit;
}

// ── A kind ───────────────────────────────────────────────────────────────────

/**
 * What every effect KIND declares, in every domain. A domain narrows `E` to its
 * own schema union and may add domain-only metadata (the layer registry adds
 * `timeDriven`); it never re-declares any of this.
 */
export interface EffectTypeDefBase<E extends BaseEffect = BaseEffect> {
  type: E["type"];
  label: string;
  /**
   * One line, in the palette, under the name. It is the difference between a
   * list of nouns and a menu you can choose from without trying every item —
   * so it says what the effect DOES, in the user's words, not what it is.
   */
  blurb?: string;
  category: EffectCategory;
  fields: EffectFieldDef[];
  /** Field sections, in render order; ungrouped fields render first. */
  groups?: EffectFieldGroupDef[];
  /** How the floating editor opens for this kind (see `EffectEditorHint`). */
  editor?: EffectEditorHint;
  /** Boolean switches the card renders below the keyframeable fields. */
  toggles?: EffectToggleDef[];
  /**
   * The clip kinds this effect may be added to. ABSENT means "any clip in this
   * domain", which is the honest default for the great majority: a shadow does
   * not care what cast the silhouette. Present means the effect is SPECIFIC —
   * it consumes something only those kinds have (chroma key needs source
   * pixels) — and the palette promotes it into a "For this layer" section,
   * because an effect that exists only for what you selected is the one you are
   * most likely looking for.
   */
  appliesTo?: readonly ClipKind[];
  /** Extra search terms for the palette ("bloom", "neon" → Glow). */
  tags?: readonly string[];
  /**
   * What this kind may GIVE UP under pressure — see `animation/fidelity.ts`.
   *
   * Index k is the field patch applied at fidelity tier k + 1, over the
   * resolved values and before the kind's own brain, so the degraded frame is
   * still rendered by the one true pipeline: nothing downstream knows a tier
   * exists. A tier past the end reuses the last entry; a kind that declares
   * nothing is never touched, which is the right default for anything cheap.
   *
   * Stated per kind, beside the fields it names, because only the kind knows
   * which of its numbers are cost and which are the look — glass can halve
   * its render scale under frost and nobody will see; halving a shadow's blur
   * is a different picture.
   */
  fidelity?: ReadonlyArray<Readonly<Record<string, number | string>>>;
  create: () => E;
  /**
   * Tailor a fresh instance to the layers it is being added to. A lightning
   * card dropped on a path should follow the path, not strike from corner to
   * corner; a card that has no opinion leaves this out. Given the kinds, not
   * the clips, so the decision stays data-shaped and testable.
   */
  adapt?: (effect: E, kinds: readonly ClipKind[]) => E;
}

/**
 * The field patch a kind applies at `tier` (0 = none). Tiers past the end of
 * the declared ladder hold at its last rung.
 */
export function effectFidelityPatch(def: Pick<EffectTypeDefBase, "fidelity">, tier: number): Readonly<Record<string, number | string>> | null {
  const ladder = def.fidelity;
  if (!ladder || ladder.length === 0 || tier <= 0) return null;
  return ladder[Math.min(ladder.length, Math.round(tier)) - 1] ?? null;
}

/** Whether `def` may be added to a selection of these clip kinds. */
export function effectAppliesTo(def: Pick<EffectTypeDefBase, "appliesTo">, kinds: readonly ClipKind[]): boolean {
  if (!def.appliesTo) return true;
  const allowed = def.appliesTo;
  return kinds.length > 0 && kinds.every((k) => allowed.includes(k));
}

/** Whether `def` exists *because of* these kinds — the palette's first section. */
export function effectIsSpecificTo(def: Pick<EffectTypeDefBase, "appliesTo">, kinds: readonly ClipKind[]): boolean {
  return def.appliesTo !== undefined && effectAppliesTo(def, kinds);
}

// ── Preset namespaces ────────────────────────────────────────────────────────

/**
 * The library namespace of one card. `effect:<type>` is what layer and audio
 * presets have always been stored under, so it stays; text gets its own so a
 * glyph shadow's "Soft" can never be offered to a layer shadow whose fields it
 * does not have. Formed HERE, once, so a stored preset and the picker that
 * lists it cannot disagree about the string.
 */
export function effectPresetKindFor(domain: EffectDomain, type: string): string {
  return domain === "text"
    ? `textEffect:${type}`
    : domain === "geometry"
      ? `modifier:${type}`
      : domain === "force"
        ? `force:${type}`
        : domain === "emitter"
          ? `emitter:${type}`
        : domain === "behavior"
          ? `behavior:${type}`
          : `effect:${type}`;
}

/** The namespace of a whole stack ("look") for a domain. */
export function effectStackPresetKindFor(domain: EffectDomain): string {
  const kinds: Record<EffectDomain, string> = {
    layer: "effectStack",
    text: "textEffectStack",
    audio: "audioEffectStack",
    geometry: "modifierStack",
    force: "forceStack",
    emitter: "emitterStack",
    behavior: "behaviorStack",
  };
  return kinds[domain];
}

// ── The registry ─────────────────────────────────────────────────────────────

/**
 * What a stack amounts to, for the surfaces that show THAT something is applied
 * without showing the processing (the timeline's `fx` badge and its tooltip; a
 * sound lane's chip). Deriving it separately in each is how a badge and its own
 * tooltip end up counting differently — disabled cards being the classic
 * disagreement. Disabled cards are excluded from `count` on purpose: the badge
 * answers "is this being processed right now", and a switched-off card is not.
 */
export interface EffectStackSummary {
  count: number;
  labels: string[];
  /** Any enabled effect whose output moves on its own (grain, ripple, an LFO). */
  animated: boolean;
}

export interface EffectRegistry<E extends BaseEffect, D extends EffectTypeDefBase<E>> {
  domain: EffectDomain;
  /** Keyframe-path prefix, e.g. `lfx` — `<prefix>.<effectId>.<field>`. */
  prefix: string;
  /** The preset-library namespace of ONE card of this kind (`effect:glass`). */
  presetKind(type: string): string;
  /**
   * The namespace of a WHOLE stack of this domain — a "look". A look is a
   * list of cards applied together (a glow over a shadow over an extrude);
   * saving one is what spares people re-building the same three cards on
   * every title. See `presets/stacks.ts`.
   */
  stackPresetKind: string;
  /** Id prefix for new instances, e.g. `lfx`. */
  types: D[];
  def(type: string): D | undefined;
  fields(effect: E): EffectFieldDef[];
  create(type: E["type"]): E;
  /** A fresh instance tailored to the selection it lands on (see `adapt`). */
  createFor(type: E["type"], kinds: readonly ClipKind[]): E;
  /** `<prefix>.<effectId>.<field>` — the ONE keyframe path convention. */
  path(effectId: string, field: string): string;
  /** Matches any path this domain owns; capture group 1 is the field name. */
  pathPattern: RegExp;
  /** The instance id in a path this registry owns, or null. */
  effectIdOf(path: string): string | null;
  /** Factory defaults as a plain patch (identity keys stripped). */
  defaults(type: E["type"]): Record<string, unknown>;
  /** How this kind's editor window opens — width, and auto-vs-fixed height. */
  editorHint(type: string): EffectEditorHint;
  /** Every kind addable to a selection of these clip kinds. */
  addableTo(kinds: readonly ClipKind[]): D[];
  summary(effects: readonly E[]): EffectStackSummary;
  /** True when this kind's output CAN change with time, not only with its fields. */
  isTimeDriven(type: string): boolean;
  /**
   * True when THIS instance's output is changing with time right now — the
   * question a preview clock, a "still or moving?" badge and a cache key all
   * actually ask. A kind may declare it as a predicate over the instance
   * (glass moves only while its ripple is driven); a plain `true` means every
   * instance moves.
   */
  isMoving(effect: E): boolean;
  /**
   * Which picture a MOVING card shows at `timeSec`, when it changes only in
   * steps — equal answers, identical pixels. Null when it flows continuously
   * (or does not move). Read off the kind's `picture` when it declares one.
   */
  pictureAt(effect: E, timeSec: number): string | null;
}

/**
 * Build a domain's registry from its list of kinds. Every helper a stack needs
 * — lookup, creation, the keyframe path, defaults, palette filtering, the
 * summary badge — comes from here, so a new domain writes its `create()`
 * functions and nothing else. `timeDriven` is read off the def when present,
 * which lets the layer registry keep the flag without this file knowing why.
 */
export function createEffectRegistry<E extends BaseEffect, D extends EffectTypeDefBase<E>>(
  domain: EffectDomain,
  prefix: string,
  types: D[],
): EffectRegistry<E, D> {
  const byType = new Map<string, D>(types.map((d) => [d.type as string, d]));
  const pathPattern = new RegExp(`^${prefix}\\.[^.]+\\.([^.]+)$`);
  const idPattern = new RegExp(`^${prefix}\\.([^.]+)\\.[^.]+$`);

  const def = (type: string) => byType.get(type);
  type Driven = boolean | ((effect: E) => boolean) | undefined;
  const drivenOf = (type: string): Driven => (byType.get(type) as { timeDriven?: Driven } | undefined)?.timeDriven;
  const isTimeDriven = (type: string) => !!drivenOf(type);
  const isMoving = (effect: E) => {
    if (effect.animate === false) return false;
    const d = drivenOf(effect.type);
    return typeof d === "function" ? d(effect) : d === true;
  };

  type Picture = ((effect: E, timeSec: number) => string | null) | undefined;
  const pictureAt = (effect: E, timeSec: number) => {
    const p = (byType.get(effect.type) as { picture?: Picture } | undefined)?.picture;
    return p && isMoving(effect) ? p(effect, timeSec) : null;
  };

  return {
    domain,
    prefix,
    types,
    def,
    pictureAt,
    presetKind: (type) => effectPresetKindFor(domain, type),
    stackPresetKind: effectStackPresetKindFor(domain),
    isTimeDriven,
    isMoving,
    fields: (effect) => byType.get(effect.type)?.fields ?? [],
    create: (type) => {
      const d = byType.get(type as string);
      if (!d) throw new Error(`Unknown ${domain} effect type: ${String(type)}`);
      return d.create();
    },
    createFor: (type, kinds) => {
      const d = byType.get(type as string);
      if (!d) throw new Error(`Unknown ${domain} effect type: ${String(type)}`);
      const fresh = d.create();
      return d.adapt ? d.adapt(fresh, kinds) : fresh;
    },
    path: (effectId, field) => `${prefix}.${effectId}.${field}`,
    pathPattern,
    effectIdOf: (p) => idPattern.exec(p)?.[1] ?? null,
    defaults: (type) => {
      const d = byType.get(type as string);
      if (!d) return {};
      const { id: _id, type: _type, enabled: _enabled, ...rest } = d.create() as unknown as Record<string, unknown>;
      return rest;
    },
    editorHint: (type) => byType.get(type)?.editor ?? {},
    addableTo: (kinds) => types.filter((d) => effectAppliesTo(d, kinds)),
    summary: (effects) => {
      const labels: string[] = [];
      let animated = false;
      for (const effect of effects) {
        // A look's header paints nothing itself: its cards are the count.
        if (!effect.enabled || effect.type === "group") continue;
        labels.push(byType.get(effect.type)?.label ?? effect.type);
        animated ||= isMoving(effect);
      }
      return { count: labels.length, labels, animated };
    },
  };
}
