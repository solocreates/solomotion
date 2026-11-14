import { cloneLayerEffects } from "../animation/layer-effects";
import { createId } from "../ids";
import {
  createTextClip,
  defaultTextStyle,
  makeSoundLayer,
  type CreateTextClipInput,
} from "../factories";
import { TEXT_TEMPLATES } from "./catalog";
import { emptyOverlay } from "../schema/scope";
import type {
  AnimationSpec,
  CaptionStateStyle,
  KeyframeValue,
  LayerEffect,
  SoundAnchor,
  SoundVoice,
  TextClip,
  TextStyle,
} from "../schema";
import {
  INHERIT_PREFS,
  effectivePalette,
  substituteRoles,
  type TemplatePalette,
  type TextLookPrefs,
} from "./prefs";

/**
 * TEXT LOOKS — one level above animation presets. A look bundles the whole
 * thing: typography, per-glyph passes, layer passes, in/out choreography and a
 * typing voice. Applying one restyles a layer in a single undoable step;
 * dropping one on the canvas creates a ready-made layer. Pure data, so a native
 * adapter, the exporter and a downloaded pack all ship the same object.
 *
 * Two rules the catalogue is built on, both of them load-bearing:
 *
 * COLOURS ARE ROLES, NEVER HEX (see `prefs.ts`). A look writes `"@ink"`, and
 * one preference recolours its type, its halo, its outline and its pill
 * together. Written as literals, "make this brand-pink" would be a hundred
 * looks × four fields of find-and-replace that nobody would do, so the feature
 * would not exist.
 *
 * TEXT EFFECTS BEFORE LAYER EFFECTS. A shadow, a glow or an extrude drawn PER
 * GLYPH reads as typography — it survives per-range colour, a caption's focused
 * word gets its own, and it staggers with the letters instead of sliding around
 * as one silhouette. So a look reaches for `style.textEffects` first, and drops
 * to `effects` only for what is genuinely a pass over the finished layer: an
 * outline, a blur, grain, chromatic split, a scanline mask.
 */

/**
 * The shelves. Fourteen, because a hundred looks in six families is six
 * scrolling walls — and because these are the words someone actually browses
 * with. A family is a JOB ("I need a caption", "I need a title card"), never a
 * technique: nobody has ever gone looking for "things with a stroke on them".
 *
 * Order is by how often you reach for it, not by loudness. The first four
 * cover most of what a motion project ever needs.
 */
export type TemplateCategory =
  | "Titles"
  | "Captions"
  | "Kinetic"
  | "Minimal"
  | "Editorial"
  | "Cinematic"
  | "Impact"
  | "Luxury"
  | "Handwritten"
  | "Playful"
  | "Retro"
  | "Neon"
  | "Glitch"
  | "Terminal";

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  "Titles",
  "Captions",
  "Kinetic",
  "Minimal",
  "Editorial",
  "Cinematic",
  "Impact",
  "Luxury",
  "Handwritten",
  "Playful",
  "Retro",
  "Neon",
  "Glitch",
  "Terminal",
];

/** A per-unit voice a look ships with, plus where the hit lands. */
export interface TemplateSound extends Partial<SoundVoice> {
  anchor?: SoundAnchor;
  offsetMs?: number;
}

/**
 * How a look dresses THE WORD BEING SPOKEN when it lands on a caption.
 *
 * `props` are overlay paths (`color`, `fontWeight`, `highlight.color`…) with
 * role tokens where a colour goes — the same paths the Focus scope writes, so
 * a look's opinion and a hand edit are one kind of thing. A highlight must be
 * stated whole (all four `highlight.*` fields) or the overlay ignores it; see
 * `overlayStyle`. `scale` is the karaoke pop, a pose rather than a style.
 */
export interface TemplateFocus {
  props: Record<string, KeyframeValue>;
  scale?: number;
  animation?: AnimationSpec | null;
}

export interface TextTemplate {
  id: string;
  name: string;
  tagline: string;
  category: TemplateCategory;
  /** Free-form words the library's facet rail and search read. */
  tags?: string[];
  /** Placeholder text used when the look creates a new layer, and the words
   *  its card previews itself with — so a card is a specimen, not a label. */
  sampleText: string;
  /** The look's own three colours. Overridable; see `TextLookColorPref`. */
  palette: TemplatePalette;
  /** Typography, including the per-glyph `textEffects` stack. Colour fields
   *  hold ROLE TOKENS (`"@ink"`, `"@shade/40"`), never hex. */
  style: Partial<TextStyle>;
  /** Passes over the finished layer — outline, blur, grain, split, mask. */
  effects?: LayerEffect[];
  animations: { in: AnimationSpec | null; out: AnimationSpec | null };
  sound?: TemplateSound;
  /**
   * The spoken word, for looks that know what one is. A caption look without
   * this is half a look: it restyles the line and leaves the lit word wearing
   * whatever focus the layer had before, which is how a green Karaoke band
   * ended up with an orphan amber box from the caption's seed defaults.
   */
  focus?: TemplateFocus;
}

/**
 * A look with every role token replaced and every preference folded in — what
 * the renderer, the apply path and the preview card all consume. Nothing
 * downstream of `resolveTemplate` knows that roles or preferences exist, which
 * is what keeps the preview and the result honest with each other: a card that
 * resolved differently from the apply would be a lie you can see.
 */
export interface ResolvedTemplate {
  id: string;
  name: string;
  tagline: string;
  category: TemplateCategory;
  sampleText: string;
  palette: TemplatePalette;
  style: Partial<TextStyle>;
  effects: LayerEffect[];
  animations: { in: AnimationSpec | null; out: AnimationSpec | null };
  sound: TemplateSound | null;
  /** Ready to be written to `clip.caption.states.focus`; null when the look has no opinion. */
  focus: CaptionStateStyle | null;
}

export function resolveTemplate(
  template: TextTemplate,
  prefs: TextLookPrefs = INHERIT_PREFS,
): ResolvedTemplate {
  const palette = effectivePalette(template.palette, prefs.color);
  return {
    id: template.id,
    name: template.name,
    tagline: template.tagline,
    category: template.category,
    sampleText: template.sampleText,
    palette,
    style: substituteRoles(template.style, palette),
    effects: substituteRoles(template.effects ?? [], palette),
    animations: {
      in: template.animations.in ? structuredClone(template.animations.in) : null,
      out: template.animations.out ? structuredClone(template.animations.out) : null,
    },
    sound: resolveSound(template, prefs),
    focus: template.focus
      ? {
          overlay: { ...emptyOverlay(), props: substituteRoles(template.focus.props, palette) },
          animation: template.focus.animation ? structuredClone(template.focus.animation) : null,
          scale: template.focus.scale ?? 1,
        }
      : null,
  };
}

/**
 * Which voice this look types in. `inherit` keeps what it shipped with, `off`
 * silences it, and `custom` overrides EVERY look — including the ones authored
 * silent, because "my text clicks like this" is one preference and not a
 * property any typeface has an opinion about.
 */
function resolveSound(template: TextTemplate, prefs: TextLookPrefs): TemplateSound | null {
  switch (prefs.sound.mode) {
    case "inherit":
      return template.sound ?? null;
    case "off":
      return null;
    case "custom":
      return { ...prefs.sound.voice, anchor: prefs.sound.anchor, offsetMs: prefs.sound.offsetMs };
  }
}

// ── The catalogue's lookup ───────────────────────────────────────────────────

const INDEX = new Map(TEXT_TEMPLATES.map((t) => [t.id, t]));

export function getTemplate(id: string): TextTemplate | undefined {
  return INDEX.get(id);
}

/**
 * Every look, resolved under `prefs`. What a browser renders — cards included,
 * so the grid you scroll IS the palette you chose.
 */
export function resolvedTemplates(prefs: TextLookPrefs = INHERIT_PREFS): ResolvedTemplate[] {
  return TEXT_TEMPLATES.map((t) => resolveTemplate(t, prefs));
}

// ── Applying one ─────────────────────────────────────────────────────────────

/**
 * THE apply. One function, called by both entry points — restyling a layer and
 * creating one — because they had drifted into two answers: creating a layer
 * silently dropped the look's effects and its typing sound, so the same card
 * gave you a different result depending on whether you dropped it on a word or
 * on empty canvas. Two implementations of "apply this look" is the bug; the
 * fact that one of them was missing half the look is only how it announced
 * itself.
 *
 * Reference types are REPLACED wholesale, never merged: applying a look truly
 * swaps it, so nothing survives from whatever the layer used to be — no orphan
 * glow, no exit click from a previous look, no aliasing between two clips that
 * share one.
 */
function writeTemplate(clip: TextClip, look: ResolvedTemplate): void {
  // FROM DEFAULTS, NEVER FROM WHAT WAS THERE. A look states the fields it has
  // an opinion about; `Object.assign` onto the live style silently kept every
  // field it does NOT mention, so applying looks in sequence accumulated the
  // union of all of them — a stray `letterSpacing` from three looks ago, an
  // `italic` nothing on screen asked for, a `textCase` you could not find a
  // control to undo. Swapping a look has to mean SWAPPING it.
  clip.style = defaultTextStyle(look.style);
  // Fresh ids, exactly like the layer stack gets: a text effect's id is its
  // keyframe path (`tfx.<id>.*`), so two clips wearing the same look must not
  // be handed the same one.
  clip.style.textEffects = (look.style.textEffects ?? []).map((e) => ({ ...e, id: createId("tfx") }));
  clip.effects = cloneLayerEffects(look.effects);
  clip.animations.in = look.animations.in ? structuredClone(look.animations.in) : null;
  clip.animations.out = look.animations.out ? structuredClone(look.animations.out) : null;
  clip.sounds = look.sound ? [makeSoundLayer({ kind: "text" }, "in", look.sound)] : [];
  // Look typography replaces any range styling — ranges would fight the look.
  clip.ranges = [];
  // A caption's spoken word takes the look's focus when the look has one. A
  // look with no opinion (a title card dropped on a caption) leaves the focus
  // alone: it does not know what a spoken word is, and blanking it would turn
  // the karaoke off as a side effect of changing a font.
  if (clip.caption && look.focus) clip.caption.states.focus = structuredClone(look.focus);
  // The stacks above were replaced with FRESH ids, so every keyframe and
  // modulator addressed to the old ones now names an effect that does not
  // exist. Nothing reads them and nothing can delete them from the UI, so they
  // accumulated on the clip for the rest of its life — one dead track per
  // field per look you ever tried. Drop what the new stacks cannot address.
  dropOrphanedEffectBindings(clip);
}

/**
 * Remove keyframe tracks and modulators bound to an effect this clip no longer
 * carries. `lfx.<id>.*` and `tfx.<id>.*` are the two effect-scoped path
 * families (see `animation/paths.ts`); every other path addresses the clip
 * itself and is none of this function's business.
 */
function dropOrphanedEffectBindings(clip: TextClip): void {
  const live = new Set<string>();
  for (const fx of clip.effects) live.add(`lfx.${fx.id}.`);
  for (const fx of clip.style.textEffects) live.add(`tfx.${fx.id}.`);
  const orphan = (path: string): boolean => {
    if (!path.startsWith("lfx.") && !path.startsWith("tfx.")) return false;
    for (const prefix of live) if (path.startsWith(prefix)) return false;
    return true;
  };
  clip.keyframes = clip.keyframes.filter((track) => !orphan(track.property));
  if (clip.modulators) clip.modulators = clip.modulators.filter((m) => !orphan(m.target));
}

/** Restyle an existing clip with a look (mutating — call inside an update). */
export function applyTemplateToClip(
  clip: TextClip,
  template: TextTemplate,
  prefs: TextLookPrefs = INHERIT_PREFS,
): void {
  writeTemplate(clip, resolveTemplate(template, prefs));
}

/** A ready-made layer from a look. */
export function createClipFromTemplate(
  template: TextTemplate,
  input: Omit<CreateTextClipInput, "style" | "presetId" | "sound" | "text"> & { text?: string },
  prefs: TextLookPrefs = INHERIT_PREFS,
): TextClip {
  const look = resolveTemplate(template, prefs);
  const clip = createTextClip({ ...input, text: input.text ?? look.sampleText, style: look.style });
  writeTemplate(clip, look);
  return clip;
}

export { TEXT_TEMPLATES };
