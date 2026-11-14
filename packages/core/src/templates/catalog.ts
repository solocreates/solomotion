import { createLayerEffect } from "../animation/layer-effects";
import { specFromPreset } from "../animation/presets";
import type {
  AnimationSpec,
  EasingPresetName,
  LayerEffect,
  LayerEffectType,
  TextEffect,
} from "../schema";
import type { TemplatePalette } from "./prefs";
import type { TextTemplate } from "./model";

/**
 * THE CATALOGUE — every text look the app ships with.
 *
 * Data only. The model, the role substitution and the apply path all live in
 * `model.ts`; nothing here does anything but describe a look, which is what
 * lets a downloaded pack be exactly this shape and go through exactly the same
 * code. If you want a helper that BEHAVES, it belongs there.
 *
 * How to add one, in the order the decisions actually matter:
 *
 *   1. Name it for the JOB, not the technique. "Lower Third", not "Slide with
 *      a bar". A browser is scanned, not read.
 *   2. Write the palette in roles. `ink` is whatever the eye reads as the
 *      colour of this look — the type on most of them, the PILL on the ones
 *      whose type is near-black. Get that wrong and the recolour dial does
 *      nothing on your preset while working on every other one.
 *   3. Reach for `textEffects` before `effects` — per glyph beats per layer;
 *      see the note in `model.ts`.
 *   4. `sampleText` is the specimen the card renders. Two or three real words,
 *      never the look's own name, never lorem.
 */

const spec = (preset: string, patch: Partial<AnimationSpec> = {}): AnimationSpec => ({
  ...specFromPreset(preset),
  ...patch,
});

const ease = (name: EasingPresetName) => ({ kind: "preset", name }) as const;

const P = (ink: string, accent: string, shade: string): TemplatePalette => ({ ink, accent, shade });

/** Per-glyph passes. Ids are local to the look; the apply re-keys them. */
let seq = 0;
/** `null` = follow the glyph's own colour (`source: "text"`). The inert tint
 *  is still a role, so the dial reaches it if the source is ever switched. */
const tint = (color: string | null) =>
  color === null ? ({ source: "text", color: "@ink" } as const) : ({ source: "custom", color } as const);
const tShadow = (color: string, x: number, y: number, blur: number, opacity = 1): TextEffect => ({
  id: `tfx${seq++}`, type: "shadow", enabled: true, ...tint(color), opacity, x, y, blur,
});
const tGlow = (color: string | null, radius: number, intensity = 1.2, opacity = 1): TextEffect => ({
  id: `tfx${seq++}`, type: "glow", enabled: true, ...tint(color), opacity, radius, intensity,
});
const tExtrude = (color: string, angle: number, length: number, opacity = 1): TextEffect => ({
  id: `tfx${seq++}`, type: "extrude", enabled: true, ...tint(color), opacity, angle, length,
});

/** A layer pass, built from the registry's own defaults — so a new field on an
 *  effect reaches a hundred looks without one of them being edited. */
const lfx = <T extends LayerEffectType>(
  type: T,
  patch: Partial<Extract<LayerEffect, { type: T }>>,
): LayerEffect => ({ ...createLayerEffect(type), ...patch }) as LayerEffect;

const stroke = (color: string, width: number, placement: "outside" | "center" | "inside" = "outside") =>
  lfx("stroke", { color, width, placement, softness: 0 });

const pill = (color: string, radius: number, paddingX = 14, paddingY = 6) => ({
  color, radius, paddingX, paddingY,
});
/** The same pill as overlay paths, for a focus — stated whole, as `overlayStyle` demands. */
const focusPill = (color: string, radius: number, paddingX = 14, paddingY = 6) => ({
  "highlight.color": color, "highlight.radius": radius, "highlight.paddingX": paddingX, "highlight.paddingY": paddingY,
});

export const TEXT_TEMPLATES: TextTemplate[] = [
  // ── Titles ────────────────────────────────────────────────────────────────
  {
    id: "hero-pop", name: "Hero Pop", category: "Titles", tags: ["bold", "opener"],
    tagline: "Big, bold, lands with weight", sampleText: "BIG MOMENT",
    palette: P("#FFFFFF", "#F5B843", "#131316"),
    style: { fontFamily: "Archivo Black", fontSize: 140, fontWeight: 800, letterSpacing: 2, color: "@ink" },
    animations: { in: spec("pop-in", { unit: "word", staggerMs: 120 }), out: null },
    sound: { pack: "thock", volume: 0.4 },
  },
  {
    id: "title-card", name: "Title Card", category: "Titles", tags: ["opener", "clean"],
    tagline: "Centred, spaced, settles once", sampleText: "Chapter One",
    palette: P("#F4F2ED", "#C9A227", "#0E0E10"),
    style: { fontFamily: "Cormorant Garamond", fontSize: 128, fontWeight: 300, letterSpacing: 10, align: "center", color: "@ink" },
    animations: { in: spec("settle", { unit: "line", durationMs: 1100, easing: ease("ease-out-quart") }), out: null },
  },
  {
    id: "lower-third", name: "Lower Third", category: "Titles", tags: ["broadcast", "name"],
    tagline: "Name bar that slides in from the left", sampleText: "Ada Lovelace",
    palette: P("#0B0B0D", "#37D399", "#FFFFFF"),
    style: { fontFamily: "Barlow Condensed", fontSize: 76, fontWeight: 600, letterSpacing: 1, align: "left", color: "@shade", highlight: pill("@ink", 4, 18, 10) },
    animations: { in: spec("slide-right", { unit: "line", durationMs: 520, easing: ease("ease-out-expo") }), out: null },
  },
  {
    id: "stacked-headline", name: "Stacked", category: "Titles", tags: ["editorial", "poster"],
    tagline: "Line after line, each one landing", sampleText: "BUILT\nTO MOVE",
    palette: P("#FFFFFF", "#FF5A36", "#0C0C0E"),
    style: { fontFamily: "Anton", fontSize: 116, fontWeight: 400, lineHeight: 0.92, letterSpacing: 1, color: "@ink" },
    animations: { in: spec("slide-down", { unit: "line", staggerMs: 130, easing: ease("ease-out-back") }), out: null },
    sound: { pack: "thock", volume: 0.35 },
  },
  {
    id: "underline-title", name: "Underline", category: "Titles", tags: ["clean", "rule"],
    tagline: "A rule draws itself under the words", sampleText: "The Brief",
    palette: P("#F4F2ED", "#4CC3E0", "#101013"),
    style: { fontFamily: "Sora", fontSize: 96, fontWeight: 600, decoration: "underline", color: "@ink" },
    animations: { in: spec("trace", { unit: "line", durationMs: 780 }), out: null },
  },
  {
    id: "badge-title", name: "Badge", category: "Titles", tags: ["pill", "tag"],
    tagline: "Caps in a rounded chip", sampleText: "EPISODE 04",
    palette: P("#FF5A36", "#FFFFFF", "#FFFFFF"),
    style: { fontFamily: "Inter", fontSize: 46, fontWeight: 700, letterSpacing: 4, textCase: "upper", color: "@shade", highlight: pill("@ink", 999, 20, 10) },
    animations: { in: spec("scale-in", { unit: "line", durationMs: 420, easing: ease("ease-out-back") }), out: null },
    sound: { pack: "pop", volume: 0.3 },
  },
  {
    id: "split-title", name: "Split", category: "Titles", tags: ["duotone", "two-colour"],
    tagline: "Heavy caps with a colour shadow behind", sampleText: "DOUBLE UP",
    palette: P("#FFFFFF", "#B18CFF", "#0C0C0E"),
    style: {
      fontFamily: "Archivo Black", fontSize: 124, fontWeight: 800, color: "@ink",
      textEffects: [tShadow("@accent", 8, 8, 0)],
    },
    animations: { in: spec("slide-through", { unit: "word", staggerMs: 90 }), out: null },
  },
  {
    id: "title-reveal", name: "Curtain", category: "Titles", tags: ["reveal", "mask"],
    tagline: "Wipes open a line at a time", sampleText: "Now Showing",
    palette: P("#F4F2ED", "#C9A227", "#0E0E10"),
    style: { fontFamily: "Playfair Display", fontSize: 108, fontWeight: 600, color: "@ink" },
    animations: { in: spec("shutter", { unit: "line", staggerMs: 140, durationMs: 640 }), out: null },
  },
  {
    id: "hero-blur", name: "Arrival", category: "Titles", tags: ["blur", "soft"],
    tagline: "Sharpens into place, word by word", sampleText: "clarity first",
    palette: P("#FFFFFF", "#4CC3E0", "#0C0C0E"),
    style: { fontFamily: "Inter", fontSize: 112, fontWeight: 700, letterSpacing: -1, color: "@ink" },
    animations: { in: spec("unblur-up", { unit: "word", staggerMs: 80, durationMs: 720 }), out: null },
  },

  // ── Captions ──────────────────────────────────────────────────────────────
  {
    id: "social-caption", name: "Subtitle", category: "Captions", tags: ["social", "subtitle"],
    tagline: "Bold captions with a pop per word", sampleText: "wait for it",
    palette: P("#FFFFFF", "#F5B843", "#000000"),
    style: { fontFamily: "Montserrat", fontSize: 84, fontWeight: 800, color: "@ink" },
    effects: [stroke("@shade", 6)],
    animations: { in: spec("pop-in", { unit: "word", staggerMs: 90 }), out: null },
    focus: { props: { color: "@accent" }, scale: 1.1 },
  },
  {
    id: "tiktok-punch", name: "Punch", category: "Captions", tags: ["social", "vertical"],
    tagline: "Word-by-word slam with a hard shadow", sampleText: "READ THIS NOW",
    palette: P("#F5B843", "#FFFFFF", "#000000"),
    style: {
      fontFamily: "Anton", fontSize: 110, fontWeight: 400, letterSpacing: 1, color: "@ink",
      textEffects: [tShadow("@shade/80", 0, 6, 0)],
    },
    animations: { in: spec("pop-in", { unit: "word", staggerMs: 130, easing: ease("ease-out-back") }), out: null },
    sound: { pack: "thock", volume: 0.35 },
    focus: { props: { color: "@accent" }, scale: 1.12 },
  },
  {
    id: "karaoke-pill", name: "Karaoke", category: "Captions", tags: ["highlight", "lyrics"],
    tagline: "Each word lights its own pill", sampleText: "sing it back",
    palette: P("#37D399", "#FFFFFF", "#0B0B0D"),
    style: { fontFamily: "Poppins", fontSize: 78, fontWeight: 700, color: "@shade", highlight: pill("@ink", 12, 14, 6) },
    animations: { in: spec("scale-in", { unit: "word", staggerMs: 150, durationMs: 260 }), out: null },
    sound: { pack: "pop", volume: 0.28 },
    // The lit word's pill is the band's own shape in the second colour, so it
    // reads as a segment of the band switching on rather than a box dropped in.
    focus: { props: { ...focusPill("@accent", 12, 14, 6) }, scale: 1.06 },
  },
  {
    id: "clean-sub", name: "Clean Sub", category: "Captions", tags: ["subtitle", "quiet"],
    tagline: "Legible, understated, no drama", sampleText: "and then she said",
    palette: P("#FFFFFF", "#B9B5AC", "#000000"),
    style: {
      fontFamily: "Inter", fontSize: 62, fontWeight: 500, align: "center", color: "@ink",
      textEffects: [tShadow("@shade/70", 0, 2, 8)],
    },
    animations: { in: spec("fade", { unit: "line", durationMs: 240 }), out: null },
    focus: { props: { fontWeight: 700 } },
  },
  {
    id: "boxed-caption", name: "Boxed", category: "Captions", tags: ["subtitle", "solid"],
    tagline: "Solid block behind every line", sampleText: "on the record",
    palette: P("#0B0B0D", "#F5B843", "#FFFFFF"),
    style: { fontFamily: "Inter", fontSize: 64, fontWeight: 600, align: "center", color: "@shade", highlight: pill("@ink", 2, 16, 8) },
    animations: { in: spec("fade-up", { unit: "line", durationMs: 300 }), out: null },
    focus: { props: { color: "@accent" } },
  },
  {
    id: "shout-caption", name: "Shout", category: "Captions", tags: ["social", "loud"],
    tagline: "Every word arrives bigger than it should", sampleText: "NO WAY",
    palette: P("#FF3B6B", "#FFFFFF", "#000000"),
    style: { fontFamily: "Luckiest Guy", fontSize: 104, fontWeight: 400, color: "@ink" },
    effects: [stroke("@shade", 8)],
    animations: { in: spec("punch", { unit: "word", staggerMs: 110 }), out: null },
    sound: { pack: "pop", volume: 0.4 },
    focus: { props: { color: "@accent" }, scale: 1.15 },
  },
  {
    id: "ticker-caption", name: "Ticker", category: "Captions", tags: ["news", "band"],
    tagline: "News band, one word at a time", sampleText: "BREAKING · LIVE",
    palette: P("#E5484D", "#FFFFFF", "#0B0B0D"),
    style: { fontFamily: "Barlow Condensed", fontSize: 58, fontWeight: 600, letterSpacing: 2, textCase: "upper", color: "@shade", highlight: pill("@ink", 0, 14, 8) },
    animations: { in: spec("slide-right", { unit: "word", staggerMs: 60, durationMs: 320 }), out: null },
    focus: { props: { color: "@accent" } },
  },
  {
    id: "whisper-caption", name: "Whisper", category: "Captions", tags: ["quiet", "soft"],
    tagline: "Light type that breathes in", sampleText: "barely there",
    palette: P("#F4F2ED", "#B9B5AC", "#000000"),
    style: { fontFamily: "Lexend", fontSize: 60, fontWeight: 300, letterSpacing: 1, color: "@ink", opacity: 0.92 },
    animations: { in: spec("soft-focus", { unit: "word", staggerMs: 70, durationMs: 520 }), out: null },
    sound: { pack: "soft", volume: 0.2 },
    focus: { props: { fontWeight: 500, opacity: 1 } },
  },

  // ── Kinetic ───────────────────────────────────────────────────────────────
  {
    id: "soft-wave", name: "Wave", category: "Kinetic", tags: ["letters", "flow"],
    tagline: "Gentle rise, letter by letter", sampleText: "flow with it",
    palette: P("#B9B5AC", "#4CC3E0", "#0C0C0E"),
    style: { fontFamily: "Space Grotesk", fontSize: 96, fontWeight: 400, color: "@ink" },
    animations: { in: spec("wave", { unit: "letter", staggerMs: 40 }), out: null },
    sound: { pack: "soft", volume: 0.26 },
  },
  {
    id: "cascade-drop", name: "Cascade", category: "Kinetic", tags: ["letters", "fall"],
    tagline: "Letters fall in like dominoes", sampleText: "one by one",
    palette: P("#FFFFFF", "#F5B843", "#0C0C0E"),
    style: { fontFamily: "Montserrat", fontSize: 92, fontWeight: 700, color: "@ink" },
    animations: { in: spec("cascade", { unit: "letter", staggerMs: 45 }), out: null },
    sound: { pack: "mechanical", volume: 0.24 },
  },
  {
    id: "ripple-text", name: "Ripple", category: "Kinetic", tags: ["letters", "wave"],
    tagline: "A pulse travels through the line", sampleText: "pass it on",
    palette: P("#4CC3E0", "#FFFFFF", "#0B0B0D"),
    style: { fontFamily: "Outfit", fontSize: 96, fontWeight: 600, color: "@ink" },
    animations: { in: spec("ripple", { unit: "letter", staggerMs: 38 }), out: null },
  },
  {
    id: "swing-in", name: "Swing", category: "Kinetic", tags: ["letters", "pendulum"],
    tagline: "Each letter swings down and settles", sampleText: "hang on",
    palette: P("#F5B843", "#FFFFFF", "#0C0C0E"),
    style: { fontFamily: "Fredoka", fontSize: 104, fontWeight: 600, color: "@ink" },
    animations: { in: spec("swing", { unit: "letter", staggerMs: 65 }), out: null },
    sound: { pack: "pop", volume: 0.24 },
  },
  {
    id: "roll-letters", name: "Roll", category: "Kinetic", tags: ["letters", "spin"],
    tagline: "Rolls in on its own baseline", sampleText: "keep rolling",
    palette: P("#FFFFFF", "#B18CFF", "#0C0C0E"),
    style: { fontFamily: "Rubik", fontSize: 92, fontWeight: 700, color: "@ink" },
    animations: { in: spec("roll-in", { unit: "letter", staggerMs: 50 }), out: null },
  },
  {
    id: "rubber-band", name: "Rubber", category: "Kinetic", tags: ["letters", "elastic"],
    tagline: "Stretches past and snaps back", sampleText: "boing",
    palette: P("#37D399", "#FFFFFF", "#0B0B0D"),
    style: { fontFamily: "Baloo 2", fontSize: 112, fontWeight: 700, color: "@ink" },
    animations: { in: spec("rubber", { unit: "letter", staggerMs: 55, easing: ease("ease-out-elastic") }), out: null },
    sound: { pack: "pop", volume: 0.3 },
  },
  {
    id: "flip-letters", name: "Flip", category: "Kinetic", tags: ["letters", "3d"],
    tagline: "Letters flip up on their edge", sampleText: "turn it over",
    palette: P("#FFFFFF", "#4CC3E0", "#0C0C0E"),
    style: { fontFamily: "Manrope", fontSize: 92, fontWeight: 700, color: "@ink" },
    animations: { in: spec("flip-up", { unit: "letter", staggerMs: 55 }), out: null },
  },
  {
    id: "scatter-in", name: "Scatter", category: "Kinetic", tags: ["letters", "chaos"],
    tagline: "Thrown in from everywhere, lands exact", sampleText: "gather round",
    palette: P("#FFFFFF", "#FF5A36", "#0C0C0E"),
    style: { fontFamily: "Space Grotesk", fontSize: 88, fontWeight: 600, color: "@ink" },
    animations: { in: spec("fly-in", { unit: "letter", staggerMs: 30, scatterPx: 120, scatterDeg: 24 }), out: null },
  },
  {
    id: "pendulum-words", name: "Pendulum", category: "Kinetic", tags: ["words", "swing"],
    tagline: "Words sway into rest", sampleText: "back and forth",
    palette: P("#F4F2ED", "#C9A227", "#0E0E10"),
    style: { fontFamily: "Josefin Sans", fontSize: 96, fontWeight: 500, color: "@ink" },
    animations: { in: spec("pendulum", { unit: "word", staggerMs: 120 }), out: null },
  },
  {
    id: "breathe-loop", name: "Breathe", category: "Kinetic", tags: ["loop", "calm"],
    tagline: "Slow in, slow settle", sampleText: "in · out",
    palette: P("#B9B5AC", "#4CC3E0", "#0B0B0D"),
    style: { fontFamily: "Lexend", fontSize: 88, fontWeight: 300, letterSpacing: 6, color: "@ink" },
    animations: { in: spec("breathe", { unit: "line", durationMs: 1400 }), out: null },
  },

  // ── Minimal ───────────────────────────────────────────────────────────────
  {
    id: "minimal-kicker", name: "Kicker", category: "Minimal", tags: ["caps", "tracking"],
    tagline: "Tiny caps, wide track, clean fade", sampleText: "NOW STREAMING",
    palette: P("#F4F2ED", "#4CC3E0", "#0C0C0E"),
    style: { fontFamily: "Inter", fontSize: 52, fontWeight: 600, letterSpacing: 8, color: "@ink" },
    animations: { in: spec("fade-up", { unit: "line", durationMs: 600 }), out: null },
  },
  {
    id: "clean-blur", name: "Focus", category: "Minimal", tags: ["blur", "clean"],
    tagline: "Sharpens into focus from blur", sampleText: "clarity",
    palette: P("#FFFFFF", "#4CC3E0", "#0C0C0E"),
    style: { fontFamily: "Inter", fontSize: 112, fontWeight: 700, color: "@ink" },
    animations: { in: spec("blur-in", { unit: "word", staggerMs: 80 }), out: null },
  },
  {
    id: "hairline", name: "Hairline", category: "Minimal", tags: ["thin", "quiet"],
    tagline: "The thinnest weight the face has", sampleText: "less, but better",
    palette: P("#F4F2ED", "#B9B5AC", "#0B0B0D"),
    style: { fontFamily: "Raleway", fontSize: 92, fontWeight: 200, letterSpacing: 2, color: "@ink" },
    animations: { in: spec("fade", { unit: "line", durationMs: 800 }), out: null },
  },
  {
    id: "label-tag", name: "Label", category: "Minimal", tags: ["ui", "mono"],
    tagline: "Interface-sized, mono, matter-of-fact", sampleText: "STATUS · OK",
    palette: P("#37D399", "#B9B5AC", "#0B0B0D"),
    style: { fontFamily: "IBM Plex Mono", fontSize: 40, fontWeight: 500, letterSpacing: 3, textCase: "upper", color: "@ink" },
    animations: { in: spec("fade", { unit: "line", durationMs: 200 }), out: null },
  },
  {
    id: "nudge-note", name: "Nudge", category: "Minimal", tags: ["subtle", "small"],
    tagline: "Barely moves — and that is the point", sampleText: "a small note",
    palette: P("#B9B5AC", "#F4F2ED", "#0B0B0D"),
    style: { fontFamily: "Inter", fontSize: 56, fontWeight: 400, color: "@ink" },
    animations: { in: spec("nudge", { unit: "line", durationMs: 340 }), out: null },
  },
  {
    id: "wide-caps", name: "Wide", category: "Minimal", tags: ["tracking", "caps"],
    tagline: "Caps opened right out", sampleText: "S P A C E",
    palette: P("#FFFFFF", "#C9A227", "#0C0C0E"),
    style: { fontFamily: "Figtree", fontSize: 64, fontWeight: 500, letterSpacing: 18, textCase: "upper", color: "@ink" },
    animations: { in: spec("fade-through", { unit: "letter", staggerMs: 55 }), out: null },
  },
  {
    id: "rule-above", name: "Rule", category: "Minimal", tags: ["line", "editorial"],
    tagline: "Struck through, then cleared", sampleText: "revised",
    palette: P("#F4F2ED", "#E5484D", "#0B0B0D"),
    style: { fontFamily: "Inter", fontSize: 76, fontWeight: 500, decoration: "strikethrough", color: "@ink" },
    animations: { in: spec("trace", { unit: "line", durationMs: 620 }), out: null },
  },

  // ── Editorial ─────────────────────────────────────────────────────────────
  {
    id: "elegant-serif", name: "Editorial", category: "Editorial", tags: ["serif", "magazine"],
    tagline: "Slow serif fade, magazine calm", sampleText: "A quiet headline",
    palette: P("#F4F2ED", "#C9A227", "#0E0E10"),
    style: { fontFamily: "Playfair Display", fontSize: 110, fontWeight: 500, italic: true, color: "@ink" },
    animations: { in: spec("fade-up", { unit: "line", durationMs: 900, easing: ease("ease-out-quart") }), out: null },
  },
  {
    id: "elegant-flip", name: "Reveal", category: "Editorial", tags: ["serif", "flip"],
    tagline: "Serif flips up line by line", sampleText: "The Grand Reveal",
    palette: P("#F4F2ED", "#C9A227", "#0E0E10"),
    style: { fontFamily: "Playfair Display", fontSize: 104, fontWeight: 600, color: "@ink" },
    animations: { in: spec("flip-up", { unit: "line", staggerMs: 120 }), out: null },
  },
  {
    id: "pull-quote", name: "Pull Quote", category: "Editorial", tags: ["serif", "quote"],
    tagline: "Italic serif that drifts up", sampleText: "“it changed everything”",
    palette: P("#F4F2ED", "#B9B5AC", "#0E0E10"),
    style: { fontFamily: "Crimson Pro", fontSize: 92, fontWeight: 400, italic: true, lineHeight: 1.25, color: "@ink" },
    animations: { in: spec("drift", { unit: "line", durationMs: 900 }), out: null },
  },
  {
    id: "masthead", name: "Masthead", category: "Editorial", tags: ["serif", "display"],
    tagline: "Big display serif, one clean move", sampleText: "The Review",
    palette: P("#0E0E10", "#C9A227", "#F4F2ED"),
    style: { fontFamily: "DM Serif Display", fontSize: 132, fontWeight: 400, color: "@shade", highlight: pill("@ink", 0, 22, 12) },
    animations: { in: spec("slide-down", { unit: "line", durationMs: 640, easing: ease("ease-out-expo") }), out: null },
  },
  {
    id: "byline", name: "Byline", category: "Editorial", tags: ["small", "credit"],
    tagline: "Small caps credit line", sampleText: "WORDS BY ADA L.",
    palette: P("#B9B5AC", "#C9A227", "#0E0E10"),
    style: { fontFamily: "Libre Baskerville", fontSize: 38, fontWeight: 400, letterSpacing: 4, textCase: "upper", color: "@ink" },
    animations: { in: spec("fade", { unit: "line", durationMs: 500, delayMs: 200 }), out: null },
  },
  {
    id: "deck-serif", name: "Deck", category: "Editorial", tags: ["serif", "sub"],
    tagline: "The line under the headline", sampleText: "and what it means for you",
    palette: P("#B9B5AC", "#F4F2ED", "#0E0E10"),
    style: { fontFamily: "Newsreader", fontSize: 62, fontWeight: 300, italic: true, lineHeight: 1.3, color: "@ink" },
    animations: { in: spec("fade-up", { unit: "word", staggerMs: 45, durationMs: 520 }), out: null },
  },
  {
    id: "column-drop", name: "Drop Cap", category: "Editorial", tags: ["serif", "print"],
    tagline: "Lands like ink on paper", sampleText: "Once upon a time",
    palette: P("#0E0E10", "#8C3B2E", "#F4F2ED"),
    style: { fontFamily: "EB Garamond", fontSize: 96, fontWeight: 500, color: "@ink" },
    animations: { in: spec("drop", { unit: "word", staggerMs: 90 }), out: null },
    sound: { pack: "vintage", volume: 0.22 },
  },

  // ── Cinematic ─────────────────────────────────────────────────────────────
  {
    id: "film-title", name: "Feature", category: "Cinematic", tags: ["credits", "film"],
    tagline: "Wide-tracked caps that simply appear", sampleText: "THE LONG WAY",
    palette: P("#EFEBE3", "#8C7B5A", "#08080A"),
    style: { fontFamily: "Cinzel", fontSize: 96, fontWeight: 400, letterSpacing: 14, textCase: "upper", align: "center", color: "@ink" },
    animations: { in: spec("fade", { unit: "line", durationMs: 1600, easing: ease("ease-in-out") }), out: null },
  },
  {
    id: "end-credits", name: "Credits", category: "Cinematic", tags: ["credits", "roll"],
    tagline: "Names rising through the dark", sampleText: "Directed by",
    palette: P("#DFDBD3", "#8C7B5A", "#08080A"),
    style: { fontFamily: "Marcellus", fontSize: 56, fontWeight: 400, letterSpacing: 4, align: "center", color: "@ink" },
    animations: { in: spec("slide-up", { unit: "line", staggerMs: 220, durationMs: 900 }), out: null },
  },
  {
    id: "cold-open", name: "Cold Open", category: "Cinematic", tags: ["mono", "stamp"],
    tagline: "Location stamp, hard cut", sampleText: "BERLIN — 04:12",
    palette: P("#FFFFFF", "#E5484D", "#08080A"),
    style: {
      fontFamily: "Share Tech Mono", fontSize: 52, fontWeight: 400, letterSpacing: 3, color: "@ink",
      textEffects: [tShadow("@shade/70", 0, 2, 6)],
    },
    animations: { in: spec("fade", { unit: "line", durationMs: 120 }), out: null },
  },
  {
    id: "trailer-slam", name: "Trailer", category: "Cinematic", tags: ["slam", "loud"],
    tagline: "One line, all at once, no mercy", sampleText: "THIS SUMMER",
    palette: P("#FFFFFF", "#E5484D", "#08080A"),
    style: { fontFamily: "Oswald", fontSize: 132, fontWeight: 700, letterSpacing: 6, textCase: "upper", align: "center", color: "@ink" },
    animations: { in: spec("punch", { unit: "line", durationMs: 260 }), out: null },
    sound: { pack: "thock", volume: 0.5 },
  },
  {
    id: "letterbox-note", name: "Interstitial", category: "Cinematic", tags: ["quiet", "serif"],
    tagline: "A held beat between scenes", sampleText: "three days later",
    palette: P("#DFDBD3", "#8C7B5A", "#08080A"),
    style: { fontFamily: "Cormorant Garamond", fontSize: 82, fontWeight: 300, italic: true, align: "center", color: "@ink" },
    animations: { in: spec("fade-through", { unit: "line", durationMs: 1200 }), out: null },
  },
  {
    id: "doc-lower", name: "Documentary", category: "Cinematic", tags: ["name", "broadcast"],
    tagline: "Interview name and role", sampleText: "Ada Lovelace\nMathematician",
    palette: P("#FFFFFF", "#C9A227", "#08080A"),
    style: {
      fontFamily: "Barlow Condensed", fontSize: 62, fontWeight: 500, lineHeight: 1.15, align: "left", color: "@ink",
      textEffects: [tShadow("@shade/60", 0, 2, 10)],
    },
    animations: { in: spec("fade-up", { unit: "line", staggerMs: 120, durationMs: 480 }), out: null },
  },
  {
    id: "widescreen", name: "Widescreen", category: "Cinematic", tags: ["grain", "warm"],
    tagline: "Grainy, warm, projected", sampleText: "reel one",
    palette: P("#E8DCC3", "#8C7B5A", "#08080A"),
    style: { fontFamily: "Vollkorn", fontSize: 92, fontWeight: 500, color: "@ink" },
    effects: [lfx("grain", { animate: true, amount: 0.3, size: 1.4, chroma: 0.1 })],
    animations: { in: spec("soft-focus", { unit: "line", durationMs: 1000 }), out: null },
  },

  // ── Impact ────────────────────────────────────────────────────────────────
  {
    id: "impact-stack", name: "Impact", category: "Impact", tags: ["condensed", "slam"],
    tagline: "Condensed caps, slams per word", sampleText: "EVERY WORD HITS",
    palette: P("#F5B843", "#FFFFFF", "#0C0C0E"),
    style: { fontFamily: "Anton", fontSize: 120, fontWeight: 400, letterSpacing: 1, color: "@ink" },
    animations: { in: spec("slide-down", { unit: "word", staggerMs: 160, easing: ease("ease-out-back") }), out: null },
    sound: { pack: "thock", volume: 0.45 },
  },
  {
    id: "outline-stroke", name: "Outline", category: "Impact", tags: ["hollow", "stroke"],
    tagline: "Hollow stroke, bounces in", sampleText: "HOLLOW",
    palette: P("#FFFFFF", "#F5B843", "#131316"),
    style: { fontFamily: "Montserrat", fontSize: 132, fontWeight: 800, color: "@shade" },
    effects: [stroke("@ink", 3)],
    animations: { in: spec("bounce-in", { unit: "letter", staggerMs: 60 }), out: null },
  },
  {
    id: "bold-slam", name: "Headline", category: "Impact", tags: ["news", "pill"],
    tagline: "Heavy grotesk on a hard band", sampleText: "BREAKING NEWS",
    palette: P("#F5B843", "#FFFFFF", "#131316"),
    style: { fontFamily: "Archivo Black", fontSize: 116, fontWeight: 800, color: "@shade", highlight: pill("@ink", 0, 14, 6) },
    animations: { in: spec("slide-down", { unit: "word", staggerMs: 100, easing: ease("ease-out-back") }), out: null },
  },
  {
    id: "sport-score", name: "Scoreboard", category: "Impact", tags: ["sport", "numbers"],
    tagline: "Italic condensed, built for numbers", sampleText: "72 — 68",
    palette: P("#FFFFFF", "#37D399", "#0B0B0D"),
    style: { fontFamily: "Teko", fontSize: 148, fontWeight: 600, italic: true, letterSpacing: 2, color: "@ink" },
    animations: { in: spec("whip", { unit: "word", staggerMs: 80 }), out: null },
    sound: { pack: "digital", volume: 0.32 },
  },
  {
    id: "extrude-block", name: "Extrude", category: "Impact", tags: ["3d", "poster"],
    tagline: "Blocks pushed back into depth", sampleText: "DEPTH",
    palette: P("#FF5A36", "#B18CFF", "#0C0C0E"),
    style: {
      fontFamily: "Archivo Black", fontSize: 128, fontWeight: 800, color: "@ink",
      textEffects: [tExtrude("@accent", 45, 26)],
    },
    animations: { in: spec("scale-in", { unit: "letter", staggerMs: 60, easing: ease("ease-out-back") }), out: null },
  },
  {
    id: "long-shadow", name: "Long Shadow", category: "Impact", tags: ["flat", "poster"],
    tagline: "One light source, one long trail", sampleText: "FLAT OUT",
    palette: P("#FFFFFF", "#4CC3E0", "#0B0B0D"),
    style: { fontFamily: "Bebas Neue", fontSize: 140, fontWeight: 400, letterSpacing: 4, color: "@ink" },
    effects: [lfx("longShadow", { color: "@accent", angle: 45, length: 180, fade: 0.4 })],
    animations: { in: spec("slide-left", { unit: "line", durationMs: 560, easing: ease("ease-out-expo") }), out: null },
  },
  {
    id: "sticker-slab", name: "Slab", category: "Impact", tags: ["slab", "poster"],
    tagline: "Fat slab serif, one heavy landing", sampleText: "HEAVY",
    palette: P("#0B0B0D", "#F5B843", "#FFFFFF"),
    style: { fontFamily: "Alfa Slab One", fontSize: 124, fontWeight: 400, color: "@shade", highlight: pill("@ink", 8, 20, 10) },
    animations: { in: spec("drop", { unit: "line", durationMs: 480 }), out: null },
    sound: { pack: "thock", volume: 0.5 },
  },
  {
    id: "grow-shout", name: "Grow", category: "Impact", tags: ["scale", "loud"],
    tagline: "Comes at you from nothing", sampleText: "LOUDER",
    palette: P("#E5484D", "#FFFFFF", "#0B0B0D"),
    style: { fontFamily: "Passion One", fontSize: 138, fontWeight: 700, color: "@ink" },
    animations: { in: spec("grow", { unit: "line", durationMs: 420, easing: ease("ease-out-back") }), out: null },
  },

  // ── Luxury ────────────────────────────────────────────────────────────────
  {
    id: "fashion-caps", name: "Fashion", category: "Luxury", tags: ["tracking", "caps"],
    tagline: "Thin caps, opened right up", sampleText: "MAISON",
    palette: P("#F4F2ED", "#C9A227", "#0A0A0B"),
    style: { fontFamily: "Italiana", fontSize: 108, fontWeight: 400, letterSpacing: 22, textCase: "upper", align: "center", color: "@ink" },
    animations: { in: spec("fade-through", { unit: "letter", staggerMs: 90, durationMs: 900 }), out: null },
  },
  {
    id: "gold-foil", name: "Foil", category: "Luxury", tags: ["gold", "glow"],
    tagline: "Warm metal catching a light", sampleText: "Reserve",
    palette: P("#C9A227", "#FFF3C4", "#0A0A0B"),
    style: {
      fontFamily: "Bodoni Moda", fontSize: 116, fontWeight: 500, color: "@ink",
      textEffects: [tGlow("@accent", 16, 0.9, 0.7)],
    },
    animations: { in: spec("soft-focus", { unit: "word", staggerMs: 120, durationMs: 900 }), out: null },
  },
  {
    id: "boutique", name: "Boutique", category: "Luxury", tags: ["serif", "quiet"],
    tagline: "Quiet high serif, no hurry", sampleText: "Atelier No. 9",
    palette: P("#EFEBE3", "#A88C4A", "#0A0A0B"),
    style: { fontFamily: "Cormorant Garamond", fontSize: 104, fontWeight: 300, letterSpacing: 4, color: "@ink" },
    animations: { in: spec("drift", { unit: "line", durationMs: 1100 }), out: null },
  },
  {
    id: "monogram", name: "Monogram", category: "Luxury", tags: ["initials", "mark"],
    tagline: "Initials, framed by space", sampleText: "A · C",
    palette: P("#C9A227", "#F4F2ED", "#0A0A0B"),
    style: { fontFamily: "Cinzel", fontSize: 152, fontWeight: 600, letterSpacing: 12, align: "center", color: "@ink" },
    animations: { in: spec("scale-in", { unit: "letter", staggerMs: 220, durationMs: 700 }), out: null },
  },
  {
    id: "invite", name: "Invitation", category: "Luxury", tags: ["script", "formal"],
    tagline: "Copperplate script, written on", sampleText: "You are invited",
    palette: P("#EFEBE3", "#C9A227", "#0A0A0B"),
    style: { fontFamily: "Pinyon Script", fontSize: 118, fontWeight: 400, color: "@ink" },
    animations: { in: spec("typewriter", { unit: "letter", staggerMs: 70, durationMs: 180 }), out: null },
    sound: { pack: "soft", volume: 0.18 },
  },
  {
    id: "champagne", name: "Champagne", category: "Luxury", tags: ["glow", "soft"],
    tagline: "Pale gold with a soft bloom", sampleText: "Sparkle",
    palette: P("#E8D7A8", "#FFFFFF", "#0A0A0B"),
    style: {
      fontFamily: "Gloock", fontSize: 118, fontWeight: 400, color: "@ink",
      textEffects: [tGlow(null, 22, 0.8, 0.6)],
    },
    animations: { in: spec("blur-in", { unit: "letter", staggerMs: 60, durationMs: 700 }), out: null },
  },

  // ── Handwritten ───────────────────────────────────────────────────────────
  {
    id: "marker-highlight", name: "Marker", category: "Handwritten", tags: ["highlight", "hand"],
    tagline: "Hand-drawn highlight sweep", sampleText: "the important part",
    palette: P("#F5B843", "#FF5A36", "#191307"),
    style: { fontFamily: "Caveat", fontSize: 96, fontWeight: 700, color: "@shade", highlight: pill("@ink", 6, 12, 2) },
    animations: { in: spec("fade-up", { unit: "word", staggerMs: 90 }), out: null },
  },
  {
    id: "lobster-love", name: "Script", category: "Handwritten", tags: ["script", "warm"],
    tagline: "Warm script, drifts up softly", sampleText: "hello there",
    palette: P("#F58F43", "#FFFFFF", "#0C0C0E"),
    style: { fontFamily: "Lobster", fontSize: 120, fontWeight: 400, color: "@ink" },
    animations: { in: spec("fade-up", { unit: "word", staggerMs: 110 }), out: null },
  },
  {
    id: "notebook", name: "Notebook", category: "Handwritten", tags: ["pen", "casual"],
    tagline: "Biro on the back of a page", sampleText: "don't forget",
    palette: P("#2B3A67", "#E5484D", "#F4F2ED"),
    style: { fontFamily: "Patrick Hand", fontSize: 86, fontWeight: 400, color: "@ink" },
    animations: { in: spec("typewriter", { unit: "letter", staggerMs: 42, durationMs: 90, jitterMs: 28 }), out: null },
    sound: { pack: "soft", volume: 0.2 },
  },
  {
    id: "brush-script", name: "Brush", category: "Handwritten", tags: ["script", "signature"],
    tagline: "Signed in one stroke", sampleText: "with love",
    palette: P("#F4F2ED", "#E5484D", "#0C0C0E"),
    style: { fontFamily: "Great Vibes", fontSize: 132, fontWeight: 400, color: "@ink" },
    animations: { in: spec("trace", { unit: "line", durationMs: 1400 }), out: null },
  },
  {
    id: "sharpie", name: "Sharpie", category: "Handwritten", tags: ["marker", "loud"],
    tagline: "Thick marker, written fast", sampleText: "SOLD OUT",
    palette: P("#131316", "#E5484D", "#F4F2ED"),
    style: { fontFamily: "Permanent Marker", fontSize: 106, fontWeight: 400, color: "@ink" },
    animations: { in: spec("whip", { unit: "word", staggerMs: 100 }), out: null },
  },
  {
    id: "chalk", name: "Chalk", category: "Handwritten", tags: ["board", "casual"],
    tagline: "Scratched onto a board", sampleText: "today's special",
    palette: P("#F4F2ED", "#8FBF9F", "#1B2420"),
    style: {
      fontFamily: "Gochi Hand", fontSize: 98, fontWeight: 400, color: "@ink",
      textEffects: [tGlow("@ink", 4, 0.5, 0.35)],
    },
    animations: { in: spec("fade", { unit: "word", staggerMs: 110, durationMs: 300 }), out: null },
  },
  {
    id: "postcard", name: "Postcard", category: "Handwritten", tags: ["script", "travel"],
    tagline: "Sent from somewhere warm", sampleText: "greetings from",
    palette: P("#8C3B2E", "#E8DCC3", "#F4F2ED"),
    style: { fontFamily: "Sacramento", fontSize: 124, fontWeight: 400, color: "@ink" },
    animations: { in: spec("drift", { unit: "word", staggerMs: 140, durationMs: 800 }), out: null },
  },

  // ── Playful ───────────────────────────────────────────────────────────────
  {
    id: "playful-bounce", name: "Bubbly", category: "Playful", tags: ["round", "bounce"],
    tagline: "Rounded, colourful, bounces per letter", sampleText: "yay!!",
    palette: P("#B18CFF", "#FFFFFF", "#0C0C0E"),
    style: { fontFamily: "Pacifico", fontSize: 128, fontWeight: 400, color: "@ink" },
    animations: { in: spec("bounce-in", { unit: "letter", staggerMs: 70 }), out: null },
    sound: { pack: "pop", volume: 0.3 },
  },
  {
    id: "comic-pow", name: "Comic", category: "Playful", tags: ["comic", "outline"],
    tagline: "Panel lettering with a hard outline", sampleText: "POW!",
    palette: P("#F5B843", "#E5484D", "#0B0B0D"),
    style: { fontFamily: "Bangers", fontSize: 148, fontWeight: 400, letterSpacing: 2, color: "@ink" },
    effects: [stroke("@shade", 7)],
    animations: { in: spec("punch", { unit: "word", staggerMs: 120 }), out: null },
    sound: { pack: "pop", volume: 0.42 },
  },
  {
    id: "sticker", name: "Sticker", category: "Playful", tags: ["pill", "cute"],
    tagline: "Peeled off and stuck on", sampleText: "new!",
    palette: P("#37D399", "#FFFFFF", "#0B0B0D"),
    style: { fontFamily: "Fredoka", fontSize: 96, fontWeight: 600, color: "@shade", highlight: pill("@ink", 999, 24, 12) },
    effects: [stroke("@shade", 4)],
    animations: { in: spec("rubber", { unit: "line", durationMs: 520, easing: ease("ease-out-elastic") }), out: null },
    sound: { pack: "pop", volume: 0.35 },
  },
  {
    id: "candy", name: "Candy", category: "Playful", tags: ["sweet", "round"],
    tagline: "Soft, round and sugary", sampleText: "sweet stuff",
    palette: P("#FF6FB5", "#FFE066", "#0C0C0E"),
    style: {
      fontFamily: "Baloo 2", fontSize: 112, fontWeight: 700, color: "@ink",
      textEffects: [tShadow("@accent", 0, 6, 0)],
    },
    animations: { in: spec("bounce-in", { unit: "letter", staggerMs: 60 }), out: null },
  },
  {
    id: "cartoon-title", name: "Cartoon", category: "Playful", tags: ["kids", "bold"],
    tagline: "Saturday morning title card", sampleText: "ADVENTURE",
    palette: P("#4CC3E0", "#FFE066", "#0B0B0D"),
    style: {
      fontFamily: "Titan One", fontSize: 116, fontWeight: 400, color: "@ink",
      textEffects: [tExtrude("@accent", 90, 14)],
    },
    effects: [stroke("@shade", 6)],
    animations: { in: spec("swing", { unit: "letter", staggerMs: 55 }), out: null },
  },
  {
    id: "wobble", name: "Wobble", category: "Playful", tags: ["silly", "loop"],
    tagline: "Never quite sits still", sampleText: "wibble wobble",
    palette: P("#FFE066", "#FF6FB5", "#0C0C0E"),
    style: { fontFamily: "Chewy", fontSize: 106, fontWeight: 400, color: "@ink" },
    animations: { in: spec("wave", { unit: "letter", staggerMs: 36, scatterDeg: 8 }), out: null },
  },
  {
    id: "party", name: "Party", category: "Playful", tags: ["confetti", "loud"],
    tagline: "Thrown in from every direction", sampleText: "surprise!",
    palette: P("#FF6FB5", "#4CC3E0", "#0C0C0E"),
    style: { fontFamily: "Sigmar One", fontSize: 108, fontWeight: 400, color: "@ink" },
    animations: { in: spec("fly-in", { unit: "letter", staggerMs: 42, scatterPx: 160, scatterDeg: 40 }), out: null },
    sound: { pack: "pop", volume: 0.34 },
  },
  {
    id: "kids-blocks", name: "Blocks", category: "Playful", tags: ["kids", "chunky"],
    tagline: "Chunky letters dropping into place", sampleText: "A B C",
    palette: P("#FF5A36", "#4CC3E0", "#FFFFFF"),
    style: { fontFamily: "Rowdies", fontSize: 124, fontWeight: 700, letterSpacing: 6, color: "@ink" },
    animations: { in: spec("drop", { unit: "letter", staggerMs: 110 }), out: null },
    sound: { pack: "thock", volume: 0.3 },
  },

  // ── Retro ─────────────────────────────────────────────────────────────────
  {
    id: "retro-chrome", name: "Chrome", category: "Retro", tags: ["80s", "miami"],
    tagline: "80s condensed caps, slides in", sampleText: "MIAMI NIGHTS",
    palette: P("#E5484D", "#4CC3E0", "#0B0B0D"),
    style: {
      fontFamily: "Oswald", fontSize: 128, fontWeight: 600, letterSpacing: 3, color: "@ink",
      textEffects: [tShadow("@accent", 4, 4, 0)],
    },
    animations: { in: spec("slide-down", { unit: "line", durationMs: 700 }), out: null },
  },
  {
    id: "vhs-tape", name: "VHS", category: "Retro", tags: ["tape", "90s"],
    tagline: "Tracking error and all", sampleText: "PLAY ▶",
    palette: P("#F4F2ED", "#4CC3E0", "#0B0B0D"),
    style: { fontFamily: "VT323", fontSize: 92, fontWeight: 400, letterSpacing: 2, color: "@ink" },
    effects: [lfx("rgbSplit", { angle: 0, distance: 4 }), lfx("scanlines", { pitch: 5, amount: 0.35, boost: 0.3 })],
    animations: { in: spec("flicker-on", { unit: "line", durationMs: 620 }), out: null },
    sound: { pack: "vintage", volume: 0.24 },
  },
  {
    id: "arcade", name: "Arcade", category: "Retro", tags: ["pixel", "game"],
    tagline: "Insert coin", sampleText: "HIGH SCORE",
    palette: P("#FFE066", "#FF3B6B", "#0B0B0D"),
    style: { fontFamily: "Press Start 2P", fontSize: 56, fontWeight: 400, letterSpacing: 2, color: "@ink" },
    animations: { in: spec("typewriter", { unit: "letter", staggerMs: 70, durationMs: 0 }), out: null },
    sound: { pack: "digital", volume: 0.3 },
  },
  {
    id: "sunset-grid", name: "Synthwave", category: "Retro", tags: ["80s", "neon"],
    tagline: "Sunset gradient energy, glowing", sampleText: "OUTRUN",
    palette: P("#FF3B6B", "#4CC3E0", "#0B0B0D"),
    style: {
      fontFamily: "Monoton", fontSize: 118, fontWeight: 400, letterSpacing: 4, color: "@ink",
      textEffects: [tGlow("@accent", 26, 1.4)],
    },
    animations: { in: spec("zoom-out", { unit: "line", durationMs: 900, easing: ease("ease-out-expo") }), out: null },
  },
  {
    id: "typewriter-page", name: "Typed", category: "Retro", tags: ["paper", "mono"],
    tagline: "Struck onto the page, key by key", sampleText: "Dear reader,",
    palette: P("#2B2620", "#8C3B2E", "#F4F2ED"),
    style: { fontFamily: "Special Elite", fontSize: 76, fontWeight: 400, color: "@ink" },
    animations: { in: spec("typewriter", { unit: "letter", staggerMs: 62, durationMs: 0, jitterMs: 45 }), out: null },
    sound: { pack: "mechanical", volume: 0.34 },
  },
  {
    id: "diner", name: "Diner", category: "Retro", tags: ["50s", "sign"],
    tagline: "Roadside sign lettering", sampleText: "OPEN 24H",
    palette: P("#E5484D", "#FFE066", "#F4F2ED"),
    style: {
      fontFamily: "Bungee", fontSize: 104, fontWeight: 400, color: "@ink",
      textEffects: [tShadow("@accent", 3, 3, 0)],
    },
    animations: { in: spec("swing", { unit: "line", durationMs: 700 }), out: null },
  },
  {
    id: "polaroid", name: "Polaroid", category: "Retro", tags: ["faded", "warm"],
    tagline: "Faded ink on an old print", sampleText: "summer '94",
    palette: P("#8C7B5A", "#E8DCC3", "#F4F2ED"),
    style: { fontFamily: "Homemade Apple", fontSize: 84, fontWeight: 400, color: "@ink" },
    effects: [lfx("grain", { amount: 0.22, size: 1.2 })],
    animations: { in: spec("fade", { unit: "line", durationMs: 900 }), out: null },
  },
  {
    id: "bulletin", name: "Bulletin", category: "Retro", tags: ["news", "mono"],
    tagline: "Wire service, straight off the printer", sampleText: "-- BULLETIN --",
    palette: P("#37D399", "#B9B5AC", "#0B0B0D"),
    style: { fontFamily: "Share Tech Mono", fontSize: 62, fontWeight: 400, letterSpacing: 2, color: "@ink" },
    animations: { in: spec("typewriter", { unit: "letter", staggerMs: 34, durationMs: 0 }), out: null },
    sound: { pack: "mechanical", volume: 0.26 },
  },

  // ── Neon ──────────────────────────────────────────────────────────────────
  {
    id: "neon-sign", name: "Neon", category: "Neon", tags: ["sign", "glow"],
    tagline: "Glowing tube, flickers alive", sampleText: "OPEN LATE",
    palette: P("#4CC3E0", "#FF3B6B", "#08080A"),
    style: {
      fontFamily: "Bebas Neue", fontSize: 150, fontWeight: 400, letterSpacing: 6, color: "@ink",
      textEffects: [tGlow(null, 30, 1.6)],
    },
    animations: { in: spec("flicker-on", { unit: "letter", staggerMs: 60 }), out: null },
  },
  {
    id: "neon-script", name: "Neon Script", category: "Neon", tags: ["sign", "script"],
    tagline: "Bar sign in cursive tube", sampleText: "cocktails",
    palette: P("#FF6FB5", "#B18CFF", "#08080A"),
    style: {
      fontFamily: "Yellowtail", fontSize: 128, fontWeight: 400, color: "@ink",
      textEffects: [tGlow(null, 26, 1.5)],
    },
    animations: { in: spec("trace", { unit: "line", durationMs: 1500 }), out: null },
  },
  {
    id: "laser", name: "Laser", category: "Neon", tags: ["glow", "tech"],
    tagline: "Cut out of light", sampleText: "PRECISION",
    palette: P("#37D399", "#FFFFFF", "#08080A"),
    style: {
      fontFamily: "Michroma", fontSize: 82, fontWeight: 400, letterSpacing: 8, color: "@ink",
      textEffects: [tGlow(null, 18, 1.8)],
    },
    animations: { in: spec("slide-through", { unit: "letter", staggerMs: 45 }), out: null },
    sound: { pack: "digital", volume: 0.26 },
  },
  {
    id: "hologram", name: "Hologram", category: "Neon", tags: ["scifi", "split"],
    tagline: "Projected, and not quite stable", sampleText: "TRANSMISSION",
    palette: P("#4CC3E0", "#B18CFF", "#08080A"),
    style: {
      fontFamily: "Orbitron", fontSize: 78, fontWeight: 600, letterSpacing: 6, color: "@ink", opacity: 0.9,
      textEffects: [tGlow(null, 20, 1.3)],
    },
    effects: [lfx("scanlines", { pitch: 3, amount: 0.4, softness: 0.9 }), lfx("rgbSplit", { distance: 3 })],
    animations: { in: spec("strobe", { unit: "line", durationMs: 800 }), out: null },
  },
  {
    id: "ember", name: "Ember", category: "Neon", tags: ["warm", "glow"],
    tagline: "Still hot from the fire", sampleText: "burning",
    palette: P("#FF7A2F", "#FFE066", "#08080A"),
    style: {
      fontFamily: "Anybody", fontSize: 116, fontWeight: 700, color: "@ink",
      textEffects: [tGlow("@accent", 28, 1.4)],
    },
    animations: { in: spec("unblur-up", { unit: "letter", staggerMs: 55, durationMs: 700 }), out: null },
  },
  {
    id: "ice", name: "Ice", category: "Neon", tags: ["cold", "glow"],
    tagline: "Cold light through glass", sampleText: "SUB ZERO",
    palette: P("#BFEFFF", "#FFFFFF", "#08080A"),
    style: {
      fontFamily: "Chakra Petch", fontSize: 106, fontWeight: 600, letterSpacing: 5, color: "@ink",
      textEffects: [tGlow(null, 22, 1.1, 0.85)],
    },
    animations: { in: spec("blur-in", { unit: "letter", staggerMs: 50, durationMs: 640 }), out: null },
  },

  // ── Glitch ────────────────────────────────────────────────────────────────
  {
    id: "glitch-split", name: "Glitch", category: "Glitch", tags: ["digital", "rgb"],
    tagline: "Channels tearing apart", sampleText: "CORRUPTED",
    palette: P("#FFFFFF", "#FF3B6B", "#08080A"),
    style: { fontFamily: "Chakra Petch", fontSize: 108, fontWeight: 700, letterSpacing: 3, color: "@ink" },
    effects: [lfx("rgbSplit", { angle: 0, distance: 9 })],
    animations: { in: spec("glitch", { unit: "letter", staggerMs: 40 }), out: null },
    sound: { pack: "digital", volume: 0.3 },
  },
  {
    id: "datamosh", name: "Datamosh", category: "Glitch", tags: ["smear", "digital"],
    tagline: "Frames dragged into each other", sampleText: "ERROR 404",
    palette: P("#37D399", "#FF3B6B", "#08080A"),
    style: { fontFamily: "Major Mono Display", fontSize: 88, fontWeight: 400, color: "@ink" },
    effects: [lfx("rgbSplit", { angle: 90, distance: 6 })],
    animations: { in: spec("smear", { unit: "word", staggerMs: 70 }), out: null },
  },
  {
    id: "strobe-cut", name: "Strobe", category: "Glitch", tags: ["flash", "hard"],
    tagline: "On, off, on — then it stays", sampleText: "SIGNAL",
    palette: P("#FFFFFF", "#FFE066", "#08080A"),
    style: { fontFamily: "Anybody", fontSize: 112, fontWeight: 800, letterSpacing: 2, color: "@ink" },
    animations: { in: spec("strobe", { unit: "line", durationMs: 640 }), out: null },
    sound: { pack: "digital", volume: 0.34 },
  },
  {
    id: "static-noise", name: "Static", category: "Glitch", tags: ["noise", "tv"],
    tagline: "Pulled out of the snow", sampleText: "NO SIGNAL",
    palette: P("#F4F2ED", "#B9B5AC", "#08080A"),
    style: { fontFamily: "Silkscreen", fontSize: 76, fontWeight: 400, letterSpacing: 3, color: "@ink" },
    effects: [lfx("noise", { scale: 24, mix: 0.4 }), lfx("scanlines", { pitch: 3, amount: 0.45 })],
    animations: { in: spec("flicker-on", { unit: "line", durationMs: 700 }), out: null },
  },
  {
    id: "shift-slice", name: "Slice", category: "Glitch", tags: ["cut", "offset"],
    tagline: "Cut into bands and offset", sampleText: "DISPLACED",
    palette: P("#4CC3E0", "#FF3B6B", "#08080A"),
    style: {
      fontFamily: "Tourney", fontSize: 104, fontWeight: 700, color: "@ink",
      textEffects: [tShadow("@accent", -6, 0, 0, 0.8)],
    },
    animations: { in: spec("glitch", { unit: "word", staggerMs: 80 }), out: null },
  },
  {
    id: "terminal-crash", name: "Crash", category: "Glitch", tags: ["error", "mono"],
    tagline: "Something went very wrong", sampleText: "FATAL: 0x00",
    palette: P("#FF3B6B", "#FFFFFF", "#08080A"),
    style: { fontFamily: "Roboto Mono", fontSize: 72, fontWeight: 700, color: "@ink" },
    effects: [lfx("rgbSplit", { distance: 5 })],
    animations: { in: spec("glitch", { unit: "letter", staggerMs: 26 }), out: null },
    sound: { pack: "digital", volume: 0.36 },
  },

  // ── Terminal ──────────────────────────────────────────────────────────────
  {
    id: "typewriter-terminal", name: "Terminal", category: "Terminal", tags: ["code", "mono"],
    tagline: "Monospace typewriter with clicks", sampleText: "> npm run ship",
    palette: P("#7BD88F", "#4CC3E0", "#0B0B0D"),
    style: { fontFamily: "JetBrains Mono", fontSize: 64, fontWeight: 500, align: "left", color: "@ink" },
    animations: { in: spec("typewriter", { unit: "letter", staggerMs: 55, durationMs: 0 }), out: null },
    sound: { pack: "mechanical", volume: 0.3 },
  },
  {
    id: "code-comment", name: "Comment", category: "Terminal", tags: ["code", "quiet"],
    tagline: "The line above the function", sampleText: "// TODO: ship it",
    palette: P("#7A8290", "#7BD88F", "#0B0B0D"),
    style: { fontFamily: "JetBrains Mono", fontSize: 52, fontWeight: 400, italic: true, align: "left", color: "@ink" },
    animations: { in: spec("typewriter", { unit: "letter", staggerMs: 30, durationMs: 0, jitterMs: 20 }), out: null },
    sound: { pack: "soft", volume: 0.18 },
  },
  {
    id: "boot-log", name: "Boot", category: "Terminal", tags: ["log", "lines"],
    tagline: "System coming up, line by line", sampleText: "loading modules…",
    palette: P("#B9B5AC", "#37D399", "#08080A"),
    style: { fontFamily: "IBM Plex Mono", fontSize: 48, fontWeight: 400, align: "left", lineHeight: 1.5, color: "@ink" },
    animations: { in: spec("fade", { unit: "line", staggerMs: 240, durationMs: 100 }), out: null },
    sound: { pack: "digital", volume: 0.22 },
  },
  {
    id: "prompt-blink", name: "Prompt", category: "Terminal", tags: ["shell", "green"],
    tagline: "Green on black, nothing else", sampleText: "$ whoami",
    palette: P("#37D399", "#FFFFFF", "#08080A"),
    style: {
      fontFamily: "Share Tech Mono", fontSize: 68, fontWeight: 400, align: "left", color: "@ink",
      textEffects: [tGlow(null, 10, 0.8, 0.6)],
    },
    animations: { in: spec("typewriter", { unit: "letter", staggerMs: 48, durationMs: 0 }), out: null },
    sound: { pack: "mechanical", volume: 0.28 },
  },
  {
    id: "hex-dump", name: "Hex", category: "Terminal", tags: ["data", "mono"],
    tagline: "Raw bytes, arriving fast", sampleText: "4F 4B 20 47 4F",
    palette: P("#4CC3E0", "#B9B5AC", "#08080A"),
    style: { fontFamily: "Roboto Mono", fontSize: 56, fontWeight: 500, letterSpacing: 2, align: "left", color: "@ink" },
    animations: { in: spec("fade", { unit: "letter", staggerMs: 18, durationMs: 80 }), out: null },
    sound: { pack: "digital", volume: 0.2 },
  },
  {
    id: "matrix-rain", name: "Matrix", category: "Terminal", tags: ["scifi", "green"],
    tagline: "Falls in out of the dark", sampleText: "wake up",
    palette: P("#37D399", "#7BD88F", "#08080A"),
    style: {
      fontFamily: "Share Tech Mono", fontSize: 82, fontWeight: 400, color: "@ink",
      textEffects: [tGlow(null, 14, 1.2, 0.75)],
    },
    animations: { in: spec("cascade", { unit: "letter", staggerMs: 55, durationMs: 520 }), out: null },
  },
];
