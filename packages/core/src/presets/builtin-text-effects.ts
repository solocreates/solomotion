import { TFX } from "../animation/text-effects";
import type { TextEffect, TextEffectType } from "../schema/text-style";
import type { Preset } from "./library";
import { builtinStackPreset, type StackPresetEntry } from "./stacks";

/**
 * Built-in TEXT effect presets — one card's look, and whole looks (stacks).
 *
 * Same rule as the layer presets: a preset is a COMPLETE value patch, spread
 * over the kind's own defaults, so switching from "Neon" to "Halo" cannot leave
 * Neon's strength behind. Names are what a designer would call the result, not
 * what the sliders are set to; groups are how you would browse for it.
 *
 * Colours: a `text` source follows the letter and is the right default for
 * light; a `custom` colour is for shade (black at some alpha) or for a look
 * that IS a colour (a riso pink). The chip shows the look's two colours so the
 * picker scans without reading.
 */

type Patch<T extends TextEffectType> = Partial<Omit<Extract<TextEffect, { type: T }>, "id" | "type" | "enabled">>;

const FOLLOW = "#ffffff";

function single<T extends TextEffectType>(
  type: T,
  id: string,
  name: string,
  group: string,
  chip: [string, string],
  over: Patch<T>,
  tags: string[] = [],
): Preset {
  return {
    id: `builtin:tfx:${type}:${id}`,
    kind: TFX.presetKind(type),
    name,
    scope: "builtin",
    data: { ...TFX.defaults(type), ...over },
    chip,
    group,
    tags,
    createdAt: 0,
  };
}

/** A stack entry: a kind's defaults with the look's values over them. */
function card<T extends TextEffectType>(type: T, over: Patch<T>): StackPresetEntry {
  return { type, ...TFX.defaults(type), ...over };
}

const INK: [string, string] = ["#2b2b2b", "#0a0a0a"];
const SOFT: [string, string] = ["#6b6b6b", "#1a1a1a"];
const LIGHT: [string, string] = ["#ffffff", "#bfe7ff"];

// ── Shadow ───────────────────────────────────────────────────────────────────

const SHADOW_PRESETS: Preset[] = [
  single("shadow", "soft", "Soft drop", "Soft", SOFT, { source: "custom", color: "#00000099", x: 0, y: 4, blur: 10 }, ["default", "subtle"]),
  single("shadow", "ambient", "Ambient", "Soft", SOFT, { source: "custom", color: "#00000066", x: 0, y: 2, blur: 6 }, ["subtle", "contact"]),
  single("shadow", "lifted", "Lifted", "Soft", SOFT, { source: "custom", color: "#00000088", x: 0, y: 12, blur: 26 }, ["floating", "elevation"]),
  single("shadow", "deep", "Deep", "Soft", INK, { source: "custom", color: "#000000aa", x: 0, y: 20, blur: 40 }, ["cinematic", "dramatic"]),
  single("shadow", "low-sun", "Low sun", "Soft", SOFT, { source: "custom", color: "#00000077", x: 16, y: 8, blur: 14 }, ["angled", "evening"]),

  single("shadow", "offset", "Offset print", "Hard", INK, { source: "custom", color: "#000000ff", x: 4, y: 4, blur: 0 }, ["print", "hard", "retro"]),
  single("shadow", "stamp", "Stamp", "Hard", INK, { source: "custom", color: "#000000ff", x: 2, y: 2, blur: 0 }, ["hard", "tight"]),
  single("shadow", "cut-paper", "Cut paper", "Hard", SOFT, { source: "custom", color: "#00000066", x: 6, y: 6, blur: 0 }, ["paper", "collage"]),
  single("shadow", "long", "Long shadow", "Hard", SOFT, { source: "custom", color: "#00000055", x: 14, y: 14, blur: 0 }, ["flat", "material"]),

  single("shadow", "riso-pink", "Riso pink", "Colour", ["#ff5fa2", "#ff2a6d"], { source: "custom", color: "#ff2a6dee", x: 4, y: 4, blur: 0 }, ["riso", "print"]),
  single("shadow", "riso-blue", "Riso blue", "Colour", ["#5aa9ff", "#2f6bff"], { source: "custom", color: "#2f6bffee", x: -4, y: 4, blur: 0 }, ["riso", "print"]),
  single("shadow", "sunset", "Sunset", "Colour", ["#ffb347", "#ff6a3d"], { source: "custom", color: "#ff6a3dcc", x: 6, y: 6, blur: 0 }, ["warm"]),
  single("shadow", "mint", "Mint", "Colour", ["#b8ffd9", "#3ddc97"], { source: "custom", color: "#3ddc97cc", x: 5, y: 5, blur: 0 }, ["cool"]),
  single("shadow", "self", "Self shade", "Colour", LIGHT, { source: "text", opacity: 0.45, x: 0, y: 6, blur: 12 }, ["tint", "follow"]),
];

// ── Glow ─────────────────────────────────────────────────────────────────────

const GLOW_PRESETS: Preset[] = [
  single("glow", "halo", "Halo", "Soft", LIGHT, { source: "text", radius: 14, intensity: 1, opacity: 1 }, ["default", "light"]),
  single("glow", "wide", "Wide halo", "Soft", LIGHT, { source: "text", radius: 32, intensity: 0.8, opacity: 0.9 }, ["soft", "bloom"]),
  single("glow", "aura", "Aura", "Soft", LIGHT, { source: "text", radius: 52, intensity: 0.6, opacity: 0.8 }, ["ambient", "bloom"]),
  single("glow", "whisper", "Whisper", "Soft", LIGHT, { source: "text", radius: 6, intensity: 0.6, opacity: 0.7 }, ["subtle"]),

  single("glow", "neon", "Neon", "Neon", ["#ffffff", "#ff2a6d"], { source: "text", radius: 18, intensity: 2.2, opacity: 1 }, ["sign", "tube"]),
  single("glow", "tube", "Neon tube", "Neon", ["#ffffff", "#5aa9ff"], { source: "text", radius: 10, intensity: 3, opacity: 1 }, ["sign", "tight"]),
  single("glow", "hot-core", "Hot core", "Neon", ["#ffffff", "#ffb347"], { source: "text", radius: 5, intensity: 4, opacity: 1 }, ["blown", "bright"]),

  single("glow", "warm", "Warm", "Colour", ["#ffe1a8", "#ffb347"], { source: "custom", color: "#ffb347", radius: 20, intensity: 1.6 }, ["amber", "candle"]),
  single("glow", "cool", "Cool", "Colour", ["#bfe7ff", "#66ccff"], { source: "custom", color: "#66ccff", radius: 20, intensity: 1.6 }, ["ice", "blue"]),
  single("glow", "toxic", "Toxic", "Colour", ["#d9ff8a", "#7dff5a"], { source: "custom", color: "#7dff5a", radius: 22, intensity: 2 }, ["acid", "green"]),
  single("glow", "ultraviolet", "Ultraviolet", "Colour", ["#d7b8ff", "#a56bff"], { source: "custom", color: "#a56bff", radius: 24, intensity: 2 }, ["purple", "uv"]),
  single("glow", "ember", "Ember", "Colour", ["#ff9a5c", "#ff4d1a"], { source: "custom", color: "#ff4d1a", radius: 16, intensity: 2.4 }, ["fire", "red"]),
  single("glow", "candy", "Candy", "Colour", ["#ffc2e0", "#ff5fa2"], { source: "custom", color: "#ff5fa2", radius: 18, intensity: 1.8 }, ["pink"]),

  single("glow", "shade", "Shade", "Legibility", INK, { source: "custom", color: "#000000", radius: 12, intensity: 1.6, opacity: 0.85 }, ["caption", "readable", "dark"]),
  single("glow", "backplate", "Backplate", "Legibility", INK, { source: "custom", color: "#000000", radius: 26, intensity: 2, opacity: 0.7 }, ["caption", "video"]),
  single("glow", "soft-outline", "Soft outline", "Legibility", INK, { source: "custom", color: "#000000", radius: 3, intensity: 4, opacity: 1 }, ["outline", "edge"]),
];

// ── Extrude ──────────────────────────────────────────────────────────────────

const EXTRUDE_PRESETS: Preset[] = [
  single("extrude", "block", "Block", "Solid", SOFT, { source: "custom", color: "#00000066", angle: 45, length: 16 }, ["default", "3d"]),
  single("extrude", "deep", "Deep block", "Solid", INK, { source: "custom", color: "#00000088", angle: 45, length: 40 }, ["3d", "heavy"]),
  single("extrude", "tall", "Tall", "Solid", SOFT, { source: "custom", color: "#00000066", angle: 90, length: 24 }, ["down", "3d"]),
  single("extrude", "flat", "Flat side", "Solid", SOFT, { source: "custom", color: "#00000066", angle: 0, length: 12 }, ["right", "3d"]),
  single("extrude", "isometric", "Isometric", "Solid", SOFT, { source: "custom", color: "#00000077", angle: 30, length: 24 }, ["iso", "3d"]),

  single("extrude", "candy", "Candy", "Colour", ["#ffc2e0", "#ff5fa2"], { source: "custom", color: "#ff5fa2", angle: 45, length: 20 }, ["pink", "3d"]),
  single("extrude", "sky", "Sky", "Colour", ["#bfe7ff", "#2f6bff"], { source: "custom", color: "#2f6bff", angle: 45, length: 20 }, ["blue", "3d"]),
  single("extrude", "gold", "Gold", "Colour", ["#ffe1a8", "#c99a2e"], { source: "custom", color: "#c99a2e", angle: 60, length: 14 }, ["metal", "3d"]),
  single("extrude", "self", "Self", "Colour", LIGHT, { source: "text", opacity: 0.4, angle: 45, length: 14 }, ["tint", "follow"]),
];

// ── Echo ─────────────────────────────────────────────────────────────────────

const ECHO_PRESETS: Preset[] = [
  single("echo", "trail", "Trail", "Trails", LIGHT, { source: "text", count: 4, distance: 8, angle: 0, fade: 0.7, opacity: 0.6 }, ["default", "motion"]),
  single("echo", "long-trail", "Long trail", "Trails", LIGHT, { source: "text", count: 6, distance: 12, angle: 0, fade: 0.8, opacity: 0.55 }, ["motion"]),
  single("echo", "ghost", "Ghost", "Trails", LIGHT, { source: "text", count: 5, distance: 4, angle: 0, fade: 0.9, opacity: 0.35 }, ["blur", "afterimage"]),

  single("echo", "speed", "Speed", "Motion", LIGHT, { source: "text", count: 8, distance: 5, angle: 180, fade: 0.85, opacity: 0.5 }, ["dash", "fast"]),
  single("echo", "rise", "Rise", "Motion", LIGHT, { source: "text", count: 4, distance: 10, angle: 270, fade: 0.8, opacity: 0.5 }, ["up"]),
  single("echo", "fall", "Fall", "Motion", LIGHT, { source: "text", count: 4, distance: 10, angle: 90, fade: 0.8, opacity: 0.5 }, ["down"]),

  single("echo", "stack", "Stack", "Retro", SOFT, { source: "custom", color: "#000000", count: 3, distance: 5, angle: 90, fade: 0, opacity: 0.3 }, ["stacked", "layered"]),
  single("echo", "double", "Double vision", "Retro", ["#ff2a6d", "#2f6bff"], { source: "custom", color: "#ff2a6d", count: 1, distance: 4, angle: 0, fade: 0, opacity: 0.8 }, ["misregister", "print"]),
  single("echo", "steps", "Steps", "Retro", SOFT, { source: "text", count: 3, distance: 9, angle: 45, fade: 0.5, opacity: 0.5 }, ["diagonal"]),
];

// ── Looks: whole stacks ──────────────────────────────────────────────────────

const look = (id: string, name: string, group: string, chip: [string, string], stack: StackPresetEntry[], tags: string[] = []) =>
  builtinStackPreset(TFX.stackPresetKind, id, name, group, chip, stack, tags);

/**
 * Whole looks, in the order a stack draws (first entry lands first, so a
 * shadow listed before a glow sits UNDER the glow). Organised by what you are
 * making rather than by which cards are in it.
 */
export const TEXT_LOOKS: Preset[] = [
  look("clean-drop", "Clean drop", "Titles", SOFT, [card("shadow", { source: "custom", color: "#00000099", x: 0, y: 4, blur: 10 })], ["default"]),
  look("lifted", "Lifted", "Titles", SOFT, [
    card("shadow", { source: "custom", color: "#00000055", x: 0, y: 2, blur: 4 }),
    card("shadow", { source: "custom", color: "#00000077", x: 0, y: 14, blur: 28 }),
  ], ["floating"]),
  look("cinematic", "Cinematic", "Titles", INK, [
    card("shadow", { source: "custom", color: "#000000aa", x: 0, y: 22, blur: 44 }),
    card("glow", { source: "custom", color: "#000000", radius: 10, intensity: 1.4, opacity: 0.6 }),
  ], ["film", "trailer"]),
  look("editorial", "Editorial", "Titles", INK, [card("shadow", { source: "custom", color: "#000000ff", x: 3, y: 3, blur: 0 })], ["print", "hard"]),

  look("neon-sign", "Neon sign", "Neon", ["#ffffff", "#ff2a6d"], [
    card("glow", { source: "text", radius: 40, intensity: 1, opacity: 0.7 }),
    card("glow", { source: "text", radius: 14, intensity: 2.4, opacity: 1 }),
    card("shadow", { source: "custom", color: "#00000088", x: 0, y: 6, blur: 16 }),
  ], ["tube", "sign"]),
  look("neon-tube", "Neon tube", "Neon", ["#ffffff", "#5aa9ff"], [
    card("glow", { source: "text", radius: 24, intensity: 1.2, opacity: 0.8 }),
    card("glow", { source: "text", radius: 6, intensity: 4, opacity: 1 }),
  ], ["tight", "bright"]),
  look("cyberpunk", "Cyberpunk", "Neon", ["#ff2a6d", "#05d9e8"], [
    card("echo", { source: "custom", color: "#ff2a6d", count: 1, distance: 4, angle: 180, fade: 0, opacity: 0.9 }),
    card("echo", { source: "custom", color: "#05d9e8", count: 1, distance: 4, angle: 0, fade: 0, opacity: 0.9 }),
    card("glow", { source: "text", radius: 18, intensity: 1.8, opacity: 0.9 }),
  ], ["glitch", "chromatic"]),

  look("block-letters", "Block letters", "3D", SOFT, [
    card("shadow", { source: "custom", color: "#00000066", x: 6, y: 10, blur: 14 }),
    card("extrude", { source: "custom", color: "#00000077", angle: 45, length: 18 }),
  ], ["3d", "solid"]),
  look("isometric", "Isometric", "3D", SOFT, [
    card("extrude", { source: "custom", color: "#00000088", angle: 30, length: 28 }),
    card("shadow", { source: "custom", color: "#000000ff", x: 2, y: 2, blur: 0 }),
  ], ["3d"]),
  look("candy-3d", "Candy", "3D", ["#ffc2e0", "#ff5fa2"], [
    card("extrude", { source: "custom", color: "#ff5fa2", angle: 45, length: 20 }),
    card("glow", { source: "text", radius: 12, intensity: 1, opacity: 0.8 }),
  ], ["pink", "3d", "sweet"]),
  look("gold-leaf", "Gold leaf", "3D", ["#ffe1a8", "#c99a2e"], [
    card("extrude", { source: "custom", color: "#c99a2e", angle: 60, length: 12 }),
    card("shadow", { source: "custom", color: "#00000066", x: 0, y: 8, blur: 18 }),
  ], ["metal"]),

  look("misregister", "Misregistered", "Retro", ["#ff2a6d", "#2f6bff"], [
    card("shadow", { source: "custom", color: "#ff2a6dee", x: 3, y: 3, blur: 0 }),
    card("shadow", { source: "custom", color: "#2f6bffee", x: -3, y: -3, blur: 0 }),
  ], ["riso", "print", "offset"]),
  look("stacked", "Stacked", "Retro", SOFT, [card("echo", { source: "custom", color: "#000000", count: 3, distance: 5, angle: 90, fade: 0, opacity: 0.3 })], ["layers"]),
  look("cut-paper", "Cut paper", "Retro", SOFT, [
    card("shadow", { source: "custom", color: "#00000055", x: 8, y: 8, blur: 0 }),
    card("shadow", { source: "custom", color: "#00000033", x: 0, y: 2, blur: 4 }),
  ], ["collage", "paper"]),

  look("speed-lines", "Speed lines", "Motion", LIGHT, [
    card("echo", { source: "text", count: 8, distance: 5, angle: 180, fade: 0.85, opacity: 0.5 }),
    card("shadow", { source: "custom", color: "#00000077", x: 0, y: 4, blur: 10 }),
  ], ["fast", "trail"]),
  look("ghosted", "Ghosted", "Motion", LIGHT, [card("echo", { source: "text", count: 5, distance: 4, angle: 0, fade: 0.9, opacity: 0.35 })], ["afterimage"]),
  look("rising", "Rising", "Motion", LIGHT, [
    card("echo", { source: "text", count: 4, distance: 10, angle: 270, fade: 0.8, opacity: 0.5 }),
    card("glow", { source: "text", radius: 10, intensity: 1, opacity: 0.6 }),
  ], ["up"]),

  look("caption-shade", "Caption shade", "Legibility", INK, [
    card("glow", { source: "custom", color: "#000000", radius: 12, intensity: 1.6, opacity: 0.85 }),
    card("shadow", { source: "custom", color: "#000000aa", x: 0, y: 3, blur: 6 }),
  ], ["caption", "subtitle", "video"]),
  look("broadcast", "Broadcast", "Legibility", INK, [
    card("shadow", { source: "custom", color: "#000000ff", x: 2, y: 2, blur: 0 }),
    card("glow", { source: "custom", color: "#000000", radius: 4, intensity: 3, opacity: 1 }),
  ], ["caption", "tv", "outline"]),
  look("backplate", "Backplate", "Legibility", INK, [card("glow", { source: "custom", color: "#000000", radius: 28, intensity: 2, opacity: 0.7 })], ["caption", "plate"]),
];

export const BUILTIN_TEXT_EFFECT_PRESETS: Preset[] = [
  ...SHADOW_PRESETS,
  ...GLOW_PRESETS,
  ...EXTRUDE_PRESETS,
  ...ECHO_PRESETS,
  ...TEXT_LOOKS,
];
