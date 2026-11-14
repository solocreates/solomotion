import { COLOR_GRADE_PRESETS } from "../animation/color-grade-presets";
import { LFX } from "../animation/layer-effects";
import { BUILTIN_TEXT_EFFECT_PRESETS } from "./builtin-text-effects";
import { builtinStackPreset, type StackPresetEntry } from "./stacks";
import { AUDIO_EFFECT_TYPES } from "../audio/effects/registry";
import { createLayerEffect } from "../animation/layer-effects";
import type { GlassEffect } from "../schema/layer-effects";
import { motionBlurSettingsSchema, type MotionBlurSettings } from "../schema/motion-blur";
import { effectPresetKind, type Preset } from "./library";
import { EMITTER, EMITTER_LOOKS, emittersFromLook } from "../physics/emitters";
import { effectPresetKindFor } from "../animation/effect-base";
import { addOutsideOf, addParallelTo, createGrade, insertCorrectorAfter, makeCorrector, makeWindow } from "../grade/ops";
import type { GradeGraph, GradeNode } from "../schema/grade";
import { STROKE_SETS, STROKE_STACKS } from "./stroke-sets";
import { SOUND_SET_PRESET_KIND, SOUND_SETS } from "../audio/sound-sets";

/**
 * Built-in effect presets — the read-only scope of the shared preset library.
 *
 * A preset is a complete value patch, never a sparse one: switching looks has
 * to be predictable, and a patch that omits `frost` would silently inherit the
 * previous look's frost and make "Crystal" muddy on one card and clear on the
 * next. So each entry spreads the effect's own defaults and overrides from
 * there — the defaults stay the single source of truth for the field list.
 *
 * The color-grade looks are ADAPTED here rather than re-authored: they were the
 * app's first (bespoke) preset list, and this makes the unified library their
 * one home, so the grade card and the glass card use the same picker, the same
 * "save as preset" and the same project/app scopes.
 */

/** The glass defaults, as a plain patch base (identity keys stripped). */
function glassBase(): Omit<GlassEffect, "id" | "type" | "enabled"> {
  const { id: _id, type: _type, enabled: _enabled, ...rest } = createLayerEffect("glass") as GlassEffect;
  return rest;
}

function glass(
  id: string,
  name: string,
  group: string,
  chip: [string, string],
  over: Partial<Omit<GlassEffect, "id" | "type" | "enabled">>,
  tags: string[] = [],
): Preset {
  return {
    id: `builtin:${id}`,
    kind: effectPresetKind("glass"),
    name,
    scope: "builtin",
    data: { ...glassBase(), ...over },
    chip,
    group,
    tags: ["glass", ...tags],
    createdAt: 0,
  };
}

const GLASS_PRESETS: Preset[] = [
  // The house look — what the card ships as, named so it can be come back to.
  glass("liquid", "Liquid Glass", "Apple", ["#dfe9f5", "#9fb6cc"], {
    refraction: 0.85, depth: 40, dispersion: 0.4, frost: 8, light: 0.9, splay: 0.3,
  }, ["ios", "apple", "hig", "default"]),
  glass("clear", "Clear", "Apple", ["#f4f8fc", "#b8c6d6"], {
    refraction: 0.8, depth: 30, dispersion: 0.5, frost: 2, light: 0.8, splay: 0,
    saturation: 1.02,
  }, ["figma", "sharp", "window"]),
  glass("frosted", "Frosted panel", "Apple", ["#e8ecf1", "#c3ccd6"], {
    refraction: 0.35, depth: 24, dispersion: 0.08, frost: 28, light: 0.5, splay: 0.6,
    tint: 0.12, brightness: 1.06, paint: 0.15,
  }, ["blur", "ui", "card", "sidebar"]),
  glass("thin", "Thin sheet", "Apple", ["#ffffff", "#d5dde6"], {
    refraction: 0.6, depth: 14, dispersion: 0.2, frost: 4, light: 1, splay: 0.15,
    paint: 0.1,
  }, ["hairline", "subtle", "toolbar"]),
  glass("crystal", "Crystal", "Optical", ["#f3fbff", "#7fd7ff"], {
    refraction: 1, depth: 60, dispersion: 1, frost: 0, light: 1.1, splay: 0.15,
    profile: "circle", ior: 2, saturation: 1.3, paint: 0.08,
  }, ["prism", "diamond", "sharp"]),
  glass("lens", "Magnifier", "Optical", ["#eef4ff", "#b9c9e8"], {
    refraction: 1, depth: 600, dispersion: 0.1, frost: 0, light: 0.6, splay: 0.3,
    profile: "circle", ior: 1.7, paint: 0.02,
  }, ["zoom", "dome", "loupe"]),
  glass("dish", "Dish", "Optical", ["#e4ecf4", "#7f93a8"], {
    refraction: 0.8, depth: 44, dispersion: 0.3, frost: 3, light: 0.8, splay: 0.4,
    profile: "concave",
  }, ["concave", "inset", "recessed"]),
  glass("bubble", "Soap bubble", "Playful", ["#ffd9f2", "#b9f0ff"], {
    refraction: 0.55, depth: 26, dispersion: 1, frost: 0, light: 1.2, splay: 0.9,
    lightColor: "#dff4ff", profile: "lip", paint: 0.04,
    ripple: 0.25, rippleScale: 3, rippleSpeed: 0.25,
  }, ["iridescent", "rainbow", "animated"]),
  glass("water", "Water drop", "Playful", ["#cfeaff", "#6fb6e8"], {
    refraction: 1, depth: 220, dispersion: 0.15, frost: 0, light: 1, splay: 0.35,
    profile: "circle", ior: 1.33, paint: 0.05,
    ripple: 0.45, rippleScale: 4, rippleSpeed: 0.6,
  }, ["liquid", "wave", "animated"]),
  glass("ice", "Ice", "Frost", ["#dff2ff", "#9dc4d8"], {
    refraction: 0.5, depth: 30, dispersion: 0.25, frost: 18, light: 0.7, splay: 0.5,
    tintColor: "#cfe9ff", tint: 0.25, saturation: 0.95, brightness: 1.05,
    noise: 0.3, noiseScale: 2.2,
  }, ["cold", "winter"]),
  glass("smoked", "Smoked glass", "Frost", ["#3a3f47", "#15181c"], {
    refraction: 0.6, depth: 26, dispersion: 0.1, frost: 6, light: 0.6, splay: 0.3,
    tintColor: "#0b0d10", tint: 0.45, saturation: 0.9, brightness: 0.85,
  }, ["dark", "tinted"]),
  glass("gel", "Gel button", "Playful", ["#ffe9a8", "#ff9ec4"], {
    refraction: 0.9, depth: 80, dispersion: 0.15, frost: 2, light: 1.2, splay: 0.5,
    profile: "circle", saturation: 1.3, brightness: 1.08, paint: 0.6,
  }, ["glossy", "candy", "button"]),
  glass("outline", "Glass edge", "Apple", ["#ffffff", "#8fa3b8"], {
    edgeOnly: true, depth: 16, light: 1.3, splay: 0.3, paint: 1,
  }, ["cheap", "stroke", "rim"]),
];

/**
 * Color-grade looks, adapted from the original bespoke registry. Their params
 * are sparse (a look only states what it changes), so they are completed with
 * the neutral grade — otherwise switching from a heavy look to a light one
 * would leave the heavy one's untouched trims behind, which is exactly the
 * "looks smear into each other" bug the grade card used to reset around.
 */
const gradeNeutral = () => {
  const { id: _id, type: _type, enabled: _enabled, ...rest } = createLayerEffect("colorGrade") as Record<string, unknown>;
  return rest;
};
const GRADE_PRESETS: Preset[] = COLOR_GRADE_PRESETS.map((p) => ({
  id: `builtin:grade:${p.id}`,
  kind: effectPresetKind("colorGrade"),
  name: p.label,
  scope: "builtin" as const,
  data: { ...gradeNeutral(), ...p.params } as unknown,
  chip: p.chip,
  group: p.group,
  tags: ["grade", "look"],
  createdAt: 0,
}));

/**
 * GRADE GRAPHS — presets for the node-based colour card.
 *
 * These are a different KIND of preset from the flat looks above: the payload is
 * a whole node tree, so one click can bring a qualifier, a window and three
 * chained correctors, not just a bag of numbers. That is the point of shipping
 * them — a node graph is a format people have to be TAUGHT, and the fastest
 * teacher is a working example they can take apart.
 *
 * Every entry spreads a `colorGrade` look into a corrector rather than
 * re-authoring the maths, so the flat card's library and this one stay one list
 * of looks with two ways to apply it.
 */
function corrector(name: string, look: Record<string, unknown>, x: number): GradeNode {
  const node = makeCorrector(x, 0, name) as Extract<GradeNode, { kind: "corrector" }>;
  node.effects = [{ ...(createLayerEffect("colorGrade") as Record<string, unknown>), ...look } as never];
  return node;
}

function gradeGraphPreset(
  id: string,
  name: string,
  group: string,
  chip: [string, string],
  build: (graph: GradeGraph) => void,
  tags: string[] = [],
): Preset {
  const graph = createGrade(name);
  build(graph);
  return {
    id: `builtin:gradegraph:${id}`,
    kind: effectPresetKind("grade"),
    name,
    scope: "builtin" as const,
    data: { graph, mix: 1 } as unknown,
    chip,
    group,
    tags: ["grade", "colour", ...tags],
    createdAt: 0,
  };
}

/** Replace the starter corrector's effects with a look, keeping the wiring. */
function seedFirst(graph: GradeGraph, name: string, look: Record<string, unknown>): GradeNode {
  const first = graph.nodes.find((n) => n.kind === "corrector")!;
  (first as Extract<GradeNode, { kind: "corrector" }>).effects = [
    { ...(createLayerEffect("colorGrade") as Record<string, unknown>), ...look } as never,
  ];
  first.name = name;
  return first;
}

const LOOK = (id: string): Record<string, unknown> =>
  (COLOR_GRADE_PRESETS.find((p) => p.id === id)?.params ?? {}) as Record<string, unknown>;

const GRADE_GRAPH_PRESETS: Preset[] = [
  gradeGraphPreset("balance", "Balance", "Start here", ["#2b2f3a", "#e8e2d4"], (g) => {
    seedFirst(g, "Primary", { contrast: 1.06, saturation: 1.04 });
  }),

  // A two-node chain: the shape most grades actually take — set the base, then
  // put the look on top, so the look can be swapped without redoing the base.
  gradeGraphPreset("primary-look", "Primary + look", "Start here", ["#1b2430", "#ffb27a"], (g) => {
    const first = seedFirst(g, "Primary", { contrast: 1.08, exposure: 0.08 });
    const look = insertCorrectorAfter(g, first.id, "Look");
    if (look?.kind === "corrector")
      look.effects = [{ ...(createLayerEffect("colorGrade") as Record<string, unknown>), ...LOOK("teal-orange") } as never];
  }),

  // The move the node graph exists for: key one thing, grade it, then grade
  // everything else through the SAME key inverted.
  gradeGraphPreset("sky-and-rest", "Sky, and everything else", "Qualified", ["#2f6fb0", "#f2d9a8"], (g) => {
    const sky = seedFirst(g, "Sky", { saturation: 1.35, exposure: -0.15, temperature: -18 });
    if (sky.kind === "corrector") {
      sky.key.qualifier.enabled = true;
      sky.key.qualifier.hue = { enabled: true, center: 210, width: 60, softLow: 25, softHigh: 25 };
      sky.key.qualifier.sat = { enabled: true, center: 0.6, width: 0.8, softLow: 0.2, softHigh: 0.2 };
      sky.key.qualifier.lum = { enabled: true, center: 0.6, width: 0.8, softLow: 0.2, softHigh: 0.2 };
      sky.key.blurPx = 2;
    }
    const outside = addOutsideOf(g, sky.id);
    if (outside?.kind === "corrector") {
      outside.name = "Everything else";
      outside.effects = [
        { ...(createLayerEffect("colorGrade") as Record<string, unknown>), temperature: 12, saturation: 1.05 } as never,
      ];
    }
  }, ["qualifier", "outside"]),

  gradeGraphPreset("skin", "Skin tones", "Qualified", ["#f0c8a8", "#7a4a34"], (g) => {
    const skin = seedFirst(g, "Skin", { saturation: 0.94, exposure: 0.06, tint: 4 });
    if (skin.kind === "corrector") {
      skin.key.qualifier.enabled = true;
      skin.key.qualifier.hue = { enabled: true, center: 22, width: 26, softLow: 14, softHigh: 14 };
      skin.key.qualifier.sat = { enabled: true, center: 0.42, width: 0.5, softLow: 0.18, softHigh: 0.18 };
      skin.key.qualifier.lum = { enabled: true, center: 0.58, width: 0.55, softLow: 0.2, softHigh: 0.2 };
      skin.key.blurPx = 3;
    }
  }, ["qualifier", "skin"]),

  // Parallel rather than serial: two corrections that must not multiply each
  // other. Serial shadows-then-highlights compounds the contrast; parallel does
  // not, which is the whole reason the mixer node exists.
  gradeGraphPreset("split-tone", "Split tone", "Parallel", ["#2b3f66", "#f0b070"], (g) => {
    const shadows = seedFirst(g, "Shadows", { liftB: 0.08, liftR: -0.03, saturation: 1.02 });
    const highs = addParallelTo(g, shadows.id);
    if (highs?.kind === "corrector") {
      highs.name = "Highlights";
      highs.effects = [
        { ...(createLayerEffect("colorGrade") as Record<string, unknown>), gainR: 0.08, gainB: -0.05 } as never,
      ];
    }
  }, ["mixer", "parallel"]),

  gradeGraphPreset("bleach", "Bleach bypass", "Looks", ["#8d8f88", "#e6e6e0"], (g) => {
    seedFirst(g, "Bleach", { saturation: 0.45, contrast: 1.34, exposure: 0.1, gammaM: -0.06 });
  }, ["look"]),

  gradeGraphPreset("noir", "Film noir", "Looks", ["#0b0b0d", "#d8d8dc"], (g) => {
    const base = seedFirst(g, "Desaturate", { saturation: 0, contrast: 1.3 });
    const crush = insertCorrectorAfter(g, base.id, "Crush");
    if (crush?.kind === "corrector")
      crush.effects = [
        { ...(createLayerEffect("colorGrade") as Record<string, unknown>), liftM: -0.07, gainM: 0.04 } as never,
      ];
  }, ["look", "mono"]),

  // A window instead of a qualifier: the other half of "choosing pixels", and
  // the one that needs no colour to isolate on.
  gradeGraphPreset("vignette-grade", "Darken the edges", "Windows", ["#0a0a0c", "#6a6a72"], (g) => {
    const node = seedFirst(g, "Edges", { exposure: -0.55, saturation: 0.9 });
    if (node.kind === "corrector") {
      const win = makeWindow("ellipse", 1920, 1080, "Centre");
      win.invert = true;
      win.feather = 260;
      node.key.windows = [win];
    }
  }, ["window", "vignette"]),
];

/**
 * Looks for the remaining cards, so no effect opens as a blank slider panel.
 *
 * Every family gets at least two, and the two are chosen to be OPPOSITE rather
 * than adjacent — "Ambient" and "Hard offset", "Halo" and "Neon" — because two
 * presets that differ slightly teach nothing about a card's range, while two
 * that bracket it show you where the dial goes in one click each.
 */
const SIMPLE_PRESETS: Preset[] = [
  // ── Shadow ────────────────────────────────────────────────────────────────
  preset("shadow", "Ambient", "Soft", ["#00000000", "#00000066"], { color: "#00000055", x: 0, y: 12, blur: 34 }),
  preset("shadow", "Elevated", "Soft", ["#00000000", "#00000088"], { color: "#00000066", x: 0, y: 28, blur: 64 }),
  preset("shadow", "Hard offset", "Graphic", ["#00000000", "#000000ff"], { color: "#000000", x: 8, y: 8, blur: 0 }),
  preset("shadow", "Contact", "Soft", ["#00000000", "#00000044"], { color: "#00000070", x: 0, y: 3, blur: 8 }),

  // ── Inner shadow ──────────────────────────────────────────────────────────
  preset("innerShadow", "Letterpress", "Depth", ["#00000088", "#ffffff22"], { color: "#000000aa", x: 0, y: 2, blur: 4 }),
  preset("innerShadow", "Deep inset", "Depth", ["#000000bb", "#00000033"], { color: "#000000bb", x: 0, y: 14, blur: 30 }),

  // ── Glow — auto is the default, so the presets lead with it ───────────────
  preset("glow", "Halo", "Light", ["#ffffff", "#ffe9a8"], { mode: "auto", size: 42, intensity: 0.55, saturation: 1.3, brightness: 1.15 }),
  preset("glow", "Neon sign", "Light", ["#ff2e88", "#4cc3e0"], { mode: "auto", size: 26, intensity: 1.6, saturation: 2.2, brightness: 1.25 }),
  preset("glow", "Bloom", "Light", ["#ffffff", "#dfe9f5"], { mode: "auto", size: 90, intensity: 0.45, saturation: 1.1, brightness: 1.3 }),
  preset("glow", "Ember", "Light", ["#ff7a18", "#ffcf5c"], { mode: "solid", color: "#ff7a18", size: 34, intensity: 1.1 }),
  preset("glow", "Inner light", "Light", ["#ffe9a8", "#ffffff"], { mode: "auto", size: 30, intensity: 0.9, saturation: 1.4, brightness: 1.2, inner: true }),

  // ── Stroke ────────────────────────────────────────────────────────────────
  preset("stroke", "Sticker", "Outline", ["#ffffff", "#000000"], { color: "#ffffff", width: 12, placement: "outside", softness: 0 }),
  preset("stroke", "Subtitle", "Outline", ["#000000", "#ffffff"], { color: "#000000", width: 6, placement: "outside", softness: 0 }),
  preset("stroke", "Hairline", "Outline", ["#00000000", "#000000"], { color: "#000000", width: 1.5, placement: "center", softness: 0 }),
  preset("stroke", "Soft edge", "Outline", ["#ffffff88", "#ffffff00"], { color: "#ffffff", width: 16, placement: "outside", softness: 0.85 }),

  // ── Long shadow ───────────────────────────────────────────────────────────
  preset("longShadow", "Flat poster", "Graphic", ["#00000055", "#00000000"], { color: "#00000055", angle: 45, length: 160, fade: 0 }),
  preset("longShadow", "Into the distance", "Graphic", ["#00000066", "#00000000"], { color: "#00000066", angle: 45, length: 400, fade: 0.85 }),

  // ── Blur family ───────────────────────────────────────────────────────────
  preset("blur", "Soft focus", "Focus", ["#dfe9f5", "#9fb6cc"], { radius: 6 }),
  preset("blur", "Out of focus", "Focus", ["#c8d4e0", "#6f8298"], { radius: 40 }),
  preset("directionalBlur", "Speed", "Motion", ["#ffffff", "#8fa3b8"], { angle: 0, distance: 48 }),
  preset("directionalBlur", "Vertical fall", "Motion", ["#ffffff", "#8fa3b8"], { angle: 90, distance: 30 }),
  preset("zoomBlur", "Punch in", "Motion", ["#ffffff", "#5a6b7d"], { strength: 0.45, centerX: 0, centerY: 0 }),
  preset("zoomBlur", "Warp speed", "Motion", ["#ffffff", "#20304a"], { strength: 0.9, centerX: 0, centerY: 0 }),
  preset("spinBlur", "Wheel", "Motion", ["#ffffff", "#5a6b7d"], { angle: 18 }),
  preset("spinBlur", "Record", "Motion", ["#e0e8f0", "#202830"], { angle: 45 }),
  preset("sharpen", "Crisp", "Detail", ["#ffffff", "#404850"], { amount: 1, radius: 1.6 }),
  preset("sharpen", "Punchy", "Detail", ["#ffffff", "#202830"], { amount: 2.4, radius: 3 }),

  // ── Colour ────────────────────────────────────────────────────────────────
  preset("adjust", "Punch", "Quick", ["#ff9e5c", "#2b4a7a"], { brightness: 1.04, contrast: 1.28, saturate: 1.3 }),
  preset("adjust", "Faded", "Quick", ["#d8cfc4", "#8a8078"], { brightness: 1.08, contrast: 0.82, saturate: 0.72 }),
  preset("adjust", "Mono", "Quick", ["#ffffff", "#101010"], { grayscale: 1, contrast: 1.1 }),
  preset("adjust", "Sepia", "Quick", ["#f0dcc0", "#6b4f34"], { sepia: 0.85, brightness: 1.02, saturate: 0.9 }),
  preset("vignette", "Cinema", "Film", ["#00000000", "#000000cc"], { amount: 0.5, softness: 0.55, roundness: 0.4, color: "#000000" }),
  preset("vignette", "Spotlight", "Film", ["#00000000", "#000000ff"], { amount: 0.85, softness: 0.25, roundness: 1, color: "#000000" }),
  preset("vignette", "Lifted corners", "Film", ["#ffffff66", "#ffffff00"], { amount: -0.35, softness: 0.6, roundness: 0.5, color: "#ffffff" }),

  // ── Distort ───────────────────────────────────────────────────────────────
  preset("rgbSplit", "VHS", "Glitch", ["#ff0040", "#00d4ff"], { angle: 0, distance: 9 }),
  preset("rgbSplit", "Lens fringe", "Optical", ["#ff4060", "#40a0ff"], { angle: 0, distance: 2 }),
  preset("rgbSplit", "Hard glitch", "Glitch", ["#ff0040", "#00ffa0"], { angle: 12, distance: 26 }),

  // ── Chroma key (media only, but its presets are the usual screens) ────────
  preset("chromaKey", "Green screen", "Keying", ["#00d463", "#00000000"], { color: "#00d463", tolerance: 30, softness: 16, spill: 45 }),
  preset("chromaKey", "Blue screen", "Keying", ["#1f4fd8", "#00000000"], { color: "#1f4fd8", tolerance: 30, softness: 16, spill: 45 }),
  preset("chromaKey", "White backdrop", "Keying", ["#ffffff", "#00000000"], { color: "#ffffff", tolerance: 18, softness: 10, spill: 0, edgesOnly: true }),
];

/**
 * The analog looks (v46). Each is a real stock or a real screen, and each is a
 * COMPLETE patch like everything else here — see `preset()` below.
 *
 * `rate` is doing quiet work in all of these: it is the difference between a
 * texture that reads as film (24, holding each frame) and one that reads as
 * digital noise (60+, re-rolling faster than the eye resolves). Getting that
 * one number right is most of what separates the presets from each other.
 */
const ANALOG_PRESETS: Preset[] = [
  preset("grain", "35 mm", "Film", ["#7a7a7a", "#2a2a2a"], { animate: true, amount: 0.22, size: 1, rate: 24, chroma: 0.1, blend: "overlay" }),
  preset("grain", "16 mm", "Film", ["#8a8272", "#2a2620"], { animate: true, amount: 0.36, size: 1.8, rate: 24, chroma: 0.2, softness: 0.4, blend: "overlay" }),
  preset("grain", "Super 8", "Film", ["#8a7a5a", "#2a2418"], { animate: true, amount: 0.5, size: 2.6, rate: 18, jitter: 0.15, chroma: 0.35, softness: 0.6, blend: "overlay" }),
  preset("grain", "Sensor noise", "Digital", ["#5a5f6a", "#1a1c20"], { animate: true, amount: 0.18, size: 0.6, rate: 60, chroma: 0.75, blend: "soft-light" }),

  preset("filmDamage", "Old projector", "Film", ["#e8dcc0", "#2a2418"], {
    dust: 0.4, dustSize: 5, dustBias: 0.5, scratches: 4, scratchOpacity: 0.5,
    flicker: 0.22, flickerSmooth: 0.35, weaveX: 3, weaveY: 4, weaveRotate: 0.2, weaveSmooth: 0.4, rate: 18, jitter: 0.12,
  }),
  preset("filmDamage", "Archive reel", "Film", ["#d8d0bc", "#33302a"], {
    dust: 0.7, dustSize: 7, dustBias: 0.7, dustSoftness: 0.3, scratches: 9, scratchWidth: 2, scratchOpacity: 0.65,
    hairs: 2, flicker: 0.35, weaveX: 6, weaveY: 8, weaveRotate: 0.5, weaveSmooth: 0.25,
    jump: 0.06, jumpAmount: 0.35, splice: 0.7, rate: 16, jitter: 0.25, stutter: 0.1,
  }),
  preset("filmDamage", "Clean vintage", "Film", ["#f0e8d8", "#4a453a"], {
    dust: 0.12, dustSize: 2.5, scratches: 1, scratchOpacity: 0.3,
    flicker: 0.08, flickerSmooth: 0.8, weaveX: 1, weaveY: 1.5, weaveRotate: 0.06, weaveSmooth: 0.85, rate: 24,
  }),

  preset("scanlines", "CRT monitor", "Screen", ["#0a1a10", "#5affa0"], {
    shape: "line", pitch: 4, thickness: 0.5, softness: 0.7, amount: 0.45, blend: "multiply",
    boost: 0.35, bleed: 1.5, curvature: 0.35, flicker: 0.06, rate: 60,
  }),
  preset("scanlines", "Broadcast", "Screen", ["#101418", "#c8d4e0"], {
    shape: "line", pitch: 3, thickness: 0.55, softness: 0.85, amount: 0.3, blend: "multiply",
    interlace: 0.45, rate: 60,
  }),
  preset("scanlines", "Trinitron", "Screen", ["#140a14", "#ff5a8a"], {
    shape: "grille", pitch: 3, thickness: 0.45, softness: 0.4, amount: 0.5, blend: "multiply",
    boost: 0.5, bleed: 2.5, curvature: 0.2, rate: 60,
  }),
  preset("scanlines", "Shadow mask", "Screen", ["#0a0a14", "#8a9aff"], {
    shape: "dot", pitch: 5, aspect: 0.87, thickness: 0.6, softness: 0.55, amount: 0.55, blend: "multiply",
    boost: 0.6, curvature: 0.3, rate: 60,
  }),
  preset("scanlines", "LCD pixels", "Screen", ["#141820", "#a0b0c0"], {
    shape: "slot", pitch: 6, aspect: 0.34, thickness: 0.25, softness: 0.1, amount: 0.35, blend: "multiply", rate: 60,
  }),

  preset("noise", "TV static", "Video", ["#ffffff", "#000000"], { animate: true,
    shape: "value", scale: 3, octaves: 1, amount: 0.85, blend: "source-over", chroma: 0,
    evolve: 20, rate: 30, contrast: 2.5,
  }),
  preset("noise", "Colour static", "Video", ["#ff4040", "#4060ff"], { animate: true,
    shape: "value", scale: 4, octaves: 1, amount: 0.7, blend: "source-over", chroma: 1,
    evolve: 20, rate: 30, contrast: 2,
  }),
  preset("noise", "Heat haze", "Distort", ["#ffd8a0", "#a06030"], { animate: true,
    shape: "fractal", scale: 180, octaves: 3, roughness: 0.55, amount: 0, displace: 9,
    evolve: 0.4, rate: 24, driftY: -30,
  }),
  preset("noise", "Tape wobble", "Distort", ["#c0d0e0", "#203040"], { animate: true,
    shape: "value", scale: 220, aspect: 6, octaves: 2, amount: 0.08, blend: "overlay",
    displace: 14, evolve: 3, rate: 30, driftY: -140,
  }),
  preset("noise", "Drifting cloud", "Texture", ["#e8f0ff", "#20304a"], { animate: true,
    shape: "fractal", scale: 320, octaves: 5, roughness: 0.55, amount: 0.35, blend: "soft-light",
    evolve: 0.25, rate: 12, driftX: 12,
  }),
  preset("noise", "Smoke", "Texture", ["#d0d0d0", "#101010"], { animate: true,
    shape: "turbulence", scale: 200, octaves: 5, roughness: 0.62, amount: 0.5, blend: "overlay",
    evolve: 0.5, rate: 18, driftY: -24,
  }),
  preset("noise", "Cracked emulsion", "Texture", ["#f0e0c0", "#403020"], {
    shape: "ridged", scale: 90, octaves: 4, roughness: 0.45, contrast: 2.2, amount: 0.4, blend: "multiply",
    evolve: 0, rate: 6,
  }),
];


/**
 * THE v57 FAMILIES — light, distort, pattern and the colour lookups.
 *
 * Two rules run through all of them and both were learned the hard way.
 *
 * ONE: a preset that ships a DURATION ships an animation. `shine` and
 * `lightning` carry the sweep clock, so "Chrome sweep" and "Storm" arrive
 * already moving, retime when you drag the clip's edge, and still compare by
 * value — which is what lets `activePreset` name the look you are on after you
 * nudge a slider. Keyframe-bearing presets would have failed all three.
 *
 * TWO: the DEFAULT is the most important preset, and it is `create()`, not an
 * entry in this list. Someone who adds Halftone and sees a grey mess decides
 * the card is broken, not that they should go looking for a preset — so every
 * `create()` in the registry is tuned to be the look you would have picked.
 * The entries below are the interesting departures from it.
 */
const LIGHT_PRESETS: Preset[] = [
  // ── Shine ─────────────────────────────────────────────────────────────────
  preset("shine", "Chrome sweep", "Metal", ["#ffffff", "#8fa3b8"], {
    position: 0, angle: -18, width: 130, softness: 0.35, bloom: 10, intensity: 1.15, duration: 1.4, blend: "screen",
  }),
  preset("shine", "Gold bar", "Metal", ["#ffe9a8", "#b8860b"], {
    position: 0, color: "#ffe9a8", angle: -12, width: 200, softness: 0.55, bloom: 22, intensity: 1.4, duration: 2, blend: "lighter",
  }),
  preset("shine", "Double glint", "Metal", ["#ffffff", "#c8d4e0"], {
    position: 0, angle: -25, width: 70, softness: 0.25, count: 2, gap: 0.12, falloff: 0.5, bloom: 6, intensity: 1.5, duration: 1.1,
  }),
  preset("shine", "Glass swipe", "Screen", ["#ffffff", "#dfe9f5"], {
    position: 0, angle: -30, width: 260, softness: 0.9, bloom: 34, intensity: 0.6, duration: 2.4, blend: "screen",
  }),
  preset("shine", "Hologram", "Screen", ["#7fffe0", "#7f9dff"], {
    position: 0, color: "#8ff5ff", angle: 90, width: 40, softness: 0.4, count: 5, gap: 0.09, falloff: 0.9,
    bloom: 8, intensity: 0.9, duration: 3, blend: "lighter",
  }),
  preset("shine", "Slow shimmer", "Screen", ["#fff4d6", "#e0d0a8"], {
    position: 0, angle: -8, width: 320, softness: 1, bloom: 48, intensity: 0.45, duration: 5, delay: 1.5, blend: "soft-light",
  }),
  preset("shine", "Hold still", "Manual", ["#ffffff", "#9fb6cc"], {
    duration: 0, position: 0.5, width: 160, softness: 0.5, bloom: 16,
  }),

  // ── Light rays ────────────────────────────────────────────────────────────
  preset("lightRays", "God rays", "Volumetric", ["#ffe9a8", "#7a6030"], {
    length: 0.55, intensity: 1.1, decay: 1.4, threshold: 0.55, saturation: 1.4, samples: 32,
  }),
  preset("lightRays", "Backlit", "Volumetric", ["#fff6e0", "#3a3020"], {
    length: 0.3, intensity: 0.8, decay: 2, threshold: 0.7, behind: true, samples: 24,
  }),
  preset("lightRays", "Star burst", "Graphic", ["#ffffff", "#4cc3e0"], {
    length: 0.85, intensity: 1.6, decay: 0.7, threshold: 0.75, saturation: 2, samples: 48,
  }),
  preset("lightRays", "Sun through", "Volumetric", ["#ffd28a", "#8a5a20"], {
    mode: "solid", color: "#ffcf5c", length: 0.65, intensity: 1.2, decay: 1.1, threshold: 0.45, samples: 36,
  }),

  // ── Lens flare ────────────────────────────────────────────────────────────
  preset("lensFlare", "Anamorphic", "Cinema", ["#6fb6ff", "#0a1830"], {
    streak: 1, streakColor: "#6fb6ff", halo: 0.3, ghosts: 3, ghostChroma: 0.35, size: 320, brightness: 1.1,
  }),
  preset("lensFlare", "50 mm prime", "Cinema", ["#ffe9c0", "#3a2a10"], {
    streak: 0.25, halo: 0.6, ghosts: 6, ghostSpread: 0.9, ghostChroma: 0.7, size: 240, brightness: 0.9,
  }),
  preset("lensFlare", "Sun hit", "Cinema", ["#fff6e0", "#ffb03a"], {
    color: "#fff2cc", streak: 0.5, streakColor: "#ffd9a0", halo: 1, ghosts: 7, ghostSpread: 1.1,
    ghostChroma: 0.5, size: 520, brightness: 1.5,
  }),
  preset("lensFlare", "Sparkle", "Graphic", ["#ffffff", "#c0e8ff"], {
    color: "#ffffff", streak: 0.9, streakColor: "#ffffff", streakAngle: 45, halo: 0.2,
    ghosts: 0, size: 120, brightness: 1.3,
  }),

  // ── Lightning ─────────────────────────────────────────────────────────────
  preset("lightning", "Thunder", "Storm", ["#dceaff", "#1a2440"], {
    mode: "bolt", chaos: 0.62, detail: 7, branches: 7, branchLength: 0.45, width: 3.5,
    color: "#a8c8ff", coreColor: "#ffffff", glow: 28, intensity: 1.2, rate: 10, jitter: 0.3, flicker: 0.4,
  }),
  preset("lightning", "Strike once", "Storm", ["#ffffff", "#20304a"], {
    mode: "bolt", chaos: 0.7, detail: 7, branches: 9, width: 4, glow: 34, intensity: 1.5,
    duration: 0.45, loop: false, position: 0, rate: 24, jitter: 0.4, flicker: 0.5,
  }),
  preset("lightning", "Tesla coil", "Electric", ["#c8f0ff", "#0a2030"], {
    mode: "burst", chaos: 0.55, detail: 5, count: 9, branches: 0, branchLength: 0.8, width: 2,
    color: "#7fe8ff", glow: 18, intensity: 1.3, rate: 20, jitter: 0.5, flicker: 0.35,
  }),
  preset("lightning", "Electric outline", "Electric", ["#8ff5ff", "#0a1828"], {
    mode: "outline", count: 1, span: 1, chaos: 0.35, detail: 6, branches: 4, width: 2, color: "#8ff5ff",
    coreColor: "#ffffff", glow: 16, intensity: 1.1, inside: false, rate: 18, jitter: 0.4, flicker: 0.3,
  }),
  preset("lightning", "Saber", "Electric", ["#ff6a5a", "#2a0a0a"], {
    mode: "outline", count: 2, span: 1, chaos: 0.12, detail: 4, branches: 0, width: 4, taper: 0,
    color: "#ff5a3c", coreColor: "#fff4f0", glow: 40, intensity: 1.4, rate: 30, jitter: 0.1, flicker: 0.15,
  }),
  preset("lightning", "Plasma crawl", "Electric", ["#ff9ef0", "#2a0a30"], {
    mode: "outline", count: 4, span: 0.22, offset: 0, drift: 0.35, chaos: 0.3, detail: 5, branches: 5,
    width: 1.4, color: "#ff8fe0", coreColor: "#ffe0ff", glow: 24, intensity: 0.9, rate: 8, jitter: 0.2, flicker: 0.4,
  }),
  preset("lightning", "Plasma ball", "Electric", ["#c9a0ff", "#180a30"], {
    mode: "fill", count: 6, chaos: 0.5, detail: 6, branches: 2, branchLength: 0.3, width: 1.6,
    color: "#b58cff", coreColor: "#ffffff", glow: 20, intensity: 1.1, rate: 16, jitter: 0.5, flicker: 0.5,
  }),
  preset("lightning", "Neon arc", "Electric", ["#7fffb0", "#0a2418"], {
    mode: "bolt", chaos: 0.25, detail: 4, branches: 0, width: 5, taper: 0.2,
    color: "#7fffb0", coreColor: "#e8ffe8", glow: 30, intensity: 1.1, rate: 2, flicker: 0.1,
  }),
];

const DISTORT_PRESETS: Preset[] = [
  // ── Bulge ─────────────────────────────────────────────────────────────────
  preset("bulge", "Magnifier", "Lens", ["#eef4ff", "#b9c9e8"], { radius: 0.3, strength: 0.7, softness: 0.15, refract: 0.4 }),
  preset("bulge", "Fisheye", "Lens", ["#dfe9f5", "#5a6b7d"], { radius: 1.1, strength: 0.85, softness: 1, refract: 0.1 }),
  preset("bulge", "Pinch", "Lens", ["#f0e0d0", "#7a5a40"], { radius: 0.55, strength: -0.6, softness: 0.7 }),
  preset("bulge", "Water drop", "Lens", ["#cfeaff", "#6fb6e8"], { radius: 0.22, strength: 0.9, softness: 0.05, refract: 0.9 }),
  preset("bulge", "Wide squeeze", "Lens", ["#e8e0f0", "#6a5a80"], { radius: 0.8, strength: 0.4, softness: 0.8, aspect: 2.4 }),

  // ── Wave warp ─────────────────────────────────────────────────────────────
  preset("wave", "Flag", "Cloth", ["#ff6b6b", "#4ecdc4"], { shape: "sine", wavelength: 320, amplitude: 34, cross: 0.35, anchor: 0.8, speed: 0.6 }),
  preset("wave", "Jelly", "Cloth", ["#ffd166", "#ef476f"], { shape: "sine", wavelength: 140, amplitude: 18, cross: 0.6, speed: 1.4 }),
  preset("wave", "Heat haze", "Air", ["#ffd8a0", "#a06030"], { shape: "noise", wavelength: 60, amplitude: 7, speed: 0.35, angle: 90 }),
  preset("wave", "Underwater", "Air", ["#7fd7ff", "#0a3a55"], { shape: "sine", wavelength: 90, amplitude: 12, cross: 0.8, speed: 0.5 }),
  preset("wave", "Corrugated", "Graphic", ["#e0e0e0", "#404040"], { shape: "triangle", wavelength: 48, amplitude: 14, speed: 0 }),
  preset("wave", "Sliced", "Graphic", ["#ffffff", "#101010"], { shape: "square", wavelength: 80, amplitude: 22, speed: 0 }),

  // ── Twirl ─────────────────────────────────────────────────────────────────
  preset("twirl", "Vortex", "Spin", ["#7a4fd0", "#12162e"], { radius: 0.8, angle: 420, softness: 0.85 }),
  preset("twirl", "Gentle swirl", "Spin", ["#ffd28a", "#7a4fd0"], { radius: 0.6, angle: 120, softness: 1 }),
  preset("twirl", "Unwind", "Spin", ["#ffffff", "#5a6b7d"], { radius: 1.2, angle: 900, softness: 0.6 }),

  // ── Lens distortion ───────────────────────────────────────────────────────
  preset("lensDistort", "Action cam", "Optics", ["#dfe9f5", "#20304a"], { amount: 0.55, cubic: 0.15, chroma: 0.3, scale: 1.12 }),
  preset("lensDistort", "Vintage glass", "Optics", ["#f0e0c0", "#6b4f34"], { amount: 0.18, cubic: 0.05, chroma: 0.45, scale: 1.03 }),
  preset("lensDistort", "Pincushion", "Optics", ["#e0e8f0", "#404850"], { amount: -0.35, chroma: 0.12, scale: 0.94 }),
  preset("lensDistort", "Fringe only", "Optics", ["#ff4060", "#40a0ff"], { amount: 0, cubic: 0, chroma: 0.75, scale: 1 }),

  // ── Goo ───────────────────────────────────────────────────────────────────
  // The threshold does the character work: 0.5 holds every silhouette exactly
  // where it was and merges only on contact, lower fattens everything and
  // merges from further off. Softness is the surface — dry, wet, or molten.
  preset("goo", "Metaball", "Merge", ["#8fd0ff", "#1a3a5a"], { blur: 24, threshold: 0.5, softness: 0.02 }),
  preset("goo", "Droplets", "Merge", ["#cfeaff", "#4a8fc0"], { blur: 14, threshold: 0.62, softness: 0.05 }),
  preset("goo", "Molten", "Merge", ["#ffb070", "#6a2010"], { blur: 48, threshold: 0.42, softness: 0.12 }),
  preset("goo", "Soft union", "Merge", ["#e8e8f0", "#50506a"], { blur: 34, threshold: 0.4, softness: 0.2 }),
  preset("goo", "Tighten", "Merge", ["#ffffff", "#303040"], { blur: 10, threshold: 0.72, softness: 0.01 }),

  // ── Roughen edges ─────────────────────────────────────────────────────────
  preset("boil", "Line boil", "Hand", ["#ffffff", "#2a2a32"], { style: "boil", amount: 2.5, scale: 22, complexity: 2, variants: 3, rate: 12 }),
  preset("boil", "Sketchy", "Hand", ["#f4f0e6", "#3a3a44"], { style: "jitter", amount: 4, scale: 14, complexity: 3, variants: 4, rate: 8, shake: 1.5 }),
  preset("boil", "Jelly wobble", "Soft", ["#b9f", "#315"], { style: "wobble", amount: 8, scale: 90, complexity: 1, variants: 0, rate: 24 }),
  preset("boil", "Hand-held", "Hand", ["#fff", "#445"], { style: "boil", amount: 1.5, scale: 30, complexity: 2, variants: 3, rate: 12, shake: 3, rotate: 0.6 }),
  preset("roughenEdges", "Torn paper", "Paper", ["#f4f0e6", "#8a8272"], { style: "torn", amount: 26, scale: 90, complexity: 2, sharpness: 0.8 }),
  preset("roughenEdges", "Chalk", "Hand", ["#ffffff", "#404850"], { style: "rough", amount: 6, scale: 12, complexity: 4, sharpness: 0.4 }),
  preset("roughenEdges", "Burnt", "Fire", ["#3a2010", "#ff7a18"], { style: "melt", amount: 34, scale: 40, complexity: 4, sharpness: 0.55 }),
  preset("roughenEdges", "Shattered", "Hard", ["#e8f0ff", "#20304a"], { style: "spiky", amount: 28, scale: 26, complexity: 2, sharpness: 1 }),
  preset("roughenEdges", "Rusted", "Grunge", ["#8a5a2a", "#3a2010"], { style: "rusty", amount: 18, scale: 30, complexity: 5, sharpness: 0.6, tint: 0.75 }),
  preset("roughenEdges", "Crawling", "Hand", ["#ffffff", "#606870"], { animate: true, style: "rough", amount: 9, scale: 18, complexity: 3, sharpness: 0.5, evolve: 2.5, rate: 12 }),

  // ── Glitch ────────────────────────────────────────────────────────────────
  preset("glitch", "Signal loss", "Broadcast", ["#00ffd0", "#ff0040"], { amount: 0.55, blocks: 18, displace: 60, chroma: 14, colorShift: 0.35, rate: 12 }),
  preset("glitch", "Datamosh", "Digital", ["#7a4fd0", "#12162e"], { amount: 0.8, blocks: 40, displace: 90, chroma: 4, scramble: 0.55, colorShift: 0.15, rate: 18 }),
  preset("glitch", "VHS tear", "Broadcast", ["#c0d0e0", "#203040"], { amount: 0.3, blocks: 8, displace: 30, chroma: 22, colorShift: 0.5, rate: 8, jitter: 0.5 }),
  preset("glitch", "Cyber", "Digital", ["#8ff5ff", "#ff2e88"], { amount: 0.65, blocks: 26, displace: 44, chroma: 26, scramble: 0.3, colorShift: 0.7, rate: 24 }),
  preset("glitch", "Barely there", "Broadcast", ["#e0e8f0", "#606870"], { amount: 0.12, blocks: 6, displace: 16, chroma: 5, colorShift: 0.1, rate: 4, stutter: 0.5 }),
  preset("glitch", "Full corruption", "Digital", ["#ff0040", "#00ffa0"], { amount: 1, blocks: 60, displace: 140, chroma: 30, scramble: 0.8, colorShift: 0.6, direction: "both", rate: 30 }),
];

/**
 * SPACE — looks for the cosmos family. A lens's numbers are px of a 1080-wide
 * comp; the shadow is 2.6× a horizon, the Einstein radius about 2.5× the shadow.
 */
const COSMOS_PRESETS: Preset[] = [
  preset("lens", "Black hole", "Lens", ["#000000", "#ffe2bd"], { radius: 230, strength: 1, shadow: 92, ring: 1, ringWidth: 3, ringColor: "#ffe2bd", glow: 0.35, reach: 4 }),
  preset("lens", "Gargantua", "Lens", ["#000000", "#ffb36b"], { radius: 300, strength: 1, shadow: 120, ring: 1.6, ringWidth: 4, ringColor: "#ffc98a", glow: 0.8, reach: 4.5 }),
  preset("lens", "Quiet hole", "Lens", ["#000000", "#9fb6ff"], { radius: 200, strength: 1, shadow: 80, ring: 0.45, ringWidth: 2, ringColor: "#dfe6ff", glow: 0.1, reach: 3.5 }),
  preset("lens", "Dark matter", "Lens", ["#10141f", "#5a6b8d"], { radius: 260, strength: 0.8, shadow: 0, ring: 0, glow: 0, reach: 5 }),
  preset("lens", "Einstein ring", "Lens", ["#000000", "#ffffff"], { radius: 260, strength: 1, shadow: 0, ring: 0, glow: 0, reach: 6 }),

  // ── Shockwave: key radius to travel; these are its shapes ──────────────────
  preset("shockwave", "Blast", "Shock", ["#cfe3ff", "#20304a"], { radius: 300, width: 60, strength: 36, chroma: 0.35, light: 0.25, color: "#cfe3ff" }),
  preset("shockwave", "Supernova", "Shock", ["#fff1d6", "#ff7a3c"], { radius: 420, width: 110, strength: 60, chroma: 0.6, light: 0.8, color: "#ffd9a8" }),
  preset("shockwave", "Ripple", "Shock", ["#e8f0ff", "#5a6b8d"], { radius: 260, width: 24, strength: 12, chroma: 0.1, light: 0, color: "#ffffff" }),
  preset("shockwave", "Gravitational wave", "Shock", ["#dfe6ff", "#3a3a6a"], { radius: 500, width: 220, strength: 22, chroma: 0, light: 0, color: "#ffffff" }),

  // ── Star: temperature is the look; cells and corona follow the kind of star ─
  preset("star", "Sun", "Stars", ["#fff1c8", "#ff9a3c"], { temperature: 5800, brightness: 1.2, granulation: 0.03, contrast: 0.6, limb: 0.65, corona: 0.6, coronaSize: 0.9, boil: 0.35 }),
  preset("star", "Blue giant", "Stars", ["#eaf2ff", "#6f9dff"], { temperature: 26000, brightness: 1.35, granulation: 0.02, contrast: 0.45, limb: 0.5, corona: 1.1, coronaSize: 1.4, boil: 0.6 }),
  preset("star", "Red supergiant", "Stars", ["#ffb35a", "#a8321c"], { temperature: 3300, brightness: 1.05, granulation: 0.22, contrast: 0.85, limb: 0.8, corona: 0.45, coronaSize: 0.7, boil: 0.18 }),
  preset("star", "White dwarf", "Stars", ["#ffffff", "#bcd2ff"], { temperature: 14000, brightness: 1.6, granulation: 0.01, contrast: 0.15, limb: 0.3, corona: 1.6, coronaSize: 0.6, boil: 1.2 }),

  // ── Starfield ───────────────────────────────────────────────────────────────
  preset("starfield", "Deep sky", "Sky", ["#020309", "#cfd8ff"], { density: 1800, brightness: 1, size: 1.1, spectral: 0.65, twinkle: 0.25, spikes: 0.6, band: 0.35 }),
  preset("starfield", "Milky Way", "Sky", ["#0a0814", "#e8dcff"], { density: 4200, brightness: 0.9, size: 0.9, spectral: 0.55, twinkle: 0.2, spikes: 0.5, band: 0.95, bandAngle: -32 }),
  preset("starfield", "Sparse", "Sky", ["#000000", "#ffffff"], { density: 500, brightness: 1.3, size: 1.3, spectral: 0.5, twinkle: 0.3, spikes: 1, band: 0 }),
  preset("starfield", "Still", "Sky", ["#020309", "#ffffff"], { density: 1800, twinkle: 0, spikes: 0.4, band: 0.3 }),

  // ── Nebula: palettes of real ones ─────────────────────────────────────────
  preset("nebula", "Rose", "Nebula", ["#2a1366", "#c23a78"], { colorA: "#2a1366", colorB: "#c23a78", colorC: "#ffd2a1" }),
  preset("nebula", "Orion", "Nebula", ["#14234d", "#d24f7a"], { colorA: "#14234d", colorB: "#d24f7a", colorC: "#ffe6c7", warp: 1.2, dust: 0.65 }),
  preset("nebula", "Carina", "Nebula", ["#0f3a4a", "#d9813b"], { colorA: "#0f3a4a", colorB: "#d9813b", colorC: "#ffe9b0", warp: 1.4, dust: 0.75, coverage: 0.6 }),
  preset("nebula", "Deep violet", "Nebula", ["#1a0f4d", "#6a3fd0"], { colorA: "#1a0f4d", colorB: "#6a3fd0", colorC: "#9fd6ff", warp: 0.9, dust: 0.4 }),
  preset("nebula", "Faint veil", "Nebula", ["#120c26", "#5a3a7a"], { colorA: "#120c26", colorB: "#5a3a7a", colorC: "#c9a6e0", coverage: 0.35, brightness: 0.8, dust: 0.3 }),
];

const PATTERN_PRESETS: Preset[] = [
  // ── Halftone ──────────────────────────────────────────────────────────────
  preset("halftone", "Newsprint", "Print", ["#f4f0e6", "#101010"], { shape: "dot", size: 8, angle: 45, contrast: 1.1, mode: "duotone" }),
  preset("halftone", "Comic", "Print", ["#ffe9a8", "#101010"], { shape: "dot", size: 14, angle: 15, contrast: 1.9, mode: "duotone", paperColor: "#ffe9a8" }),
  preset("halftone", "CMYK press", "Print", ["#00ffff", "#ff00ff"], { shape: "dot", size: 7, contrast: 1.2, mode: "cmyk" }),
  preset("halftone", "Engraved", "Print", ["#f0ece0", "#202020"], { shape: "line", size: 6, angle: 30, contrast: 1.4, mode: "mono" }),
  preset("halftone", "Crosshatch", "Hand", ["#ffffff", "#303030"], { shape: "cross", size: 12, angle: 20, softness: 0.2, contrast: 1.3 }),
  preset("halftone", "LED wall", "Screen", ["#101418", "#5affa0"], { shape: "dot", size: 16, angle: 0, mode: "color", inside: true, softness: 0.3, paper: true, paperColor: "#0b0d10" }),
  preset("halftone", "Cross-stitch", "Hand", ["#ddd5c4", "#c2453a"], { shape: "cross", size: 9, angle: 45, mode: "color", contrast: 4, softness: 0.12, paper: true, paperColor: "#ddd5c4" }),
  preset("halftone", "Loose ink", "Hand", ["#f4f0e6", "#202020"], { shape: "dot", size: 11, angle: 45, jitter: 4, contrast: 1.2, mode: "duotone" }),
  preset("halftone", "Disintegrate", "Motion", ["#ffffff", "#7a4fd0"], { shape: "dot", size: 9, mode: "color", spread: 140, jitter: 10, inside: false, contrast: 1.4 }),

  // ── Pixelate ──────────────────────────────────────────────────────────────
  preset("pixelate", "Mosaic", "Block", ["#c8d4e0", "#5a6b7d"], { size: 24, shape: "square" }),
  preset("pixelate", "Censor", "Block", ["#909aa4", "#404850"], { size: 44, shape: "square" }),
  preset("pixelate", "8-bit", "Retro", ["#ff6b6b", "#4ecdc4"], { size: 10, shape: "square" }),
  preset("pixelate", "LED sign", "Screen", ["#101418", "#ffb03a"], { size: 20, shape: "dot", gap: 0.25, board: "#0b0d10" }),
  preset("pixelate", "Bead curtain", "Screen", ["#ffd166", "#ef476f"], { size: 26, shape: "dot", gap: 0.35, softness: 0.3 }),
  preset("pixelate", "Scanline blocks", "Retro", ["#e0e8f0", "#202830"], { size: 18, aspect: 3.2, shape: "square", gap: 0.12 }),

  // ── Bevel ─────────────────────────────────────────────────────────────────
  preset("bevel", "Chisel", "Hard", ["#ffffff", "#404850"], { style: "inner", depth: 8, strength: 1.6, softness: 0.05, highlightOpacity: 0.95, shadowOpacity: 0.75 }),
  preset("bevel", "Soft pillow", "Soft", ["#f0f4f8", "#a8b4c0"], { style: "pillow", depth: 22, strength: 0.7, softness: 0.9, highlightOpacity: 0.6, shadowOpacity: 0.45 }),
  preset("bevel", "Polished metal", "Hard", ["#e8eef4", "#3a4650"], { style: "inner", depth: 16, strength: 2.2, softness: 0.25, elevation: 28, highlightOpacity: 1, shadowOpacity: 0.85 }),
  preset("bevel", "Plastic", "Soft", ["#ffd166", "#a06a10"], { style: "inner", depth: 20, strength: 1.1, softness: 0.65, elevation: 60, highlightOpacity: 0.85, shadowOpacity: 0.4 }),
  preset("bevel", "Letterpress", "Print", ["#f4f0e6", "#8a8272"], { style: "pillow", depth: 5, strength: 1.4, softness: 0.3, highlightOpacity: 0.7, shadowOpacity: 0.55 }),
  preset("bevel", "Stamped", "Print", ["#d8d0bc", "#6a6250"], { style: "emboss", depth: 10, strength: 1.5, softness: 0.35, highlightOpacity: 0.9, shadowOpacity: 0.7 }),
  preset("bevel", "Raised lip", "Soft", ["#ffffff", "#909aa4"], { style: "outer", depth: 14, strength: 1, softness: 0.5 }),
];

const DEPTH_PRESETS: Preset[] = [
  // ── Fog (depth) ───────────────────────────────────────────────────────────
  preset("fog", "Morning haze", "Air", ["#e6ecf2", "#8a96a3"], { color: "#e6ecf2", density: 0.6, start: 0.3, end: 1 }),
  preset("fog", "Thick fog", "Air", ["#c8d0d9", "#5a6470"], { color: "#c8d0d9", density: 0.92, start: 0.1, end: 0.75 }),
  preset("fog", "Dusk", "Colour", ["#f2a65a", "#3a2a40"], { color: "#e89a6a", density: 0.55, start: 0.35, end: 1 }),
  preset("fog", "Night smoke", "Colour", ["#2a3040", "#0a0c12"], { color: "#20242e", density: 0.8, start: 0.2, end: 0.9 }),
  preset("fog", "Underwater", "Colour", ["#1a6a7a", "#0a2a30"], { color: "#1f6f80", density: 0.85, start: 0, end: 0.8 }),

  // ── Lens blur (depth) ─────────────────────────────────────────────────────
  preset("lensBlur", "Portrait", "Focus", ["#f0e0d0", "#5a4a40"], { focus: 0.08, range: 0.08, amount: 22 }),
  preset("lensBlur", "Background soft", "Focus", ["#e0e8f0", "#808890"], { focus: 0.15, range: 0.2, amount: 10 }),
  preset("lensBlur", "Far focus", "Focus", ["#606870", "#e0e8f0"], { focus: 0.85, range: 0.12, amount: 18 }),
  preset("lensBlur", "Miniature", "Look", ["#ffd28a", "#3a6ac0"], { focus: 0.5, range: 0.06, amount: 28 }),

  // ── Behind (depth) ────────────────────────────────────────────────────────
  preset("depthMatte", "Behind the subject", "Place", ["#ffffff", "#303030"], { depth: 0.35, softness: 0.03 }),
  preset("depthMatte", "Deep in the shot", "Place", ["#c0c8d0", "#202428"], { depth: 0.7, softness: 0.05 }),
  preset("depthMatte", "Through the subject", "Place", ["#303030", "#ffffff"], { depth: 0.35, softness: 0.03, invert: true }),
];

/**
 * One preset per material, each the recipe at its tuned defaults — the card's
 * select already IS that, so these exist for the picker's chips and search —
 * plus the two uses that need more than a material: a cut-out and a board.
 */
const SURFACE_PRESETS: Preset[] = [
  preset("surface", "Paper", "Material", ["#f2ecde", "#cfc6b2"], { material: "paper" }),
  preset("surface", "Kraft", "Material", ["#bc9264", "#7d5a36"], { material: "kraft" }),
  preset("surface", "Black card", "Material", ["#2a2826", "#111010"], { material: "blackCard" }),
  preset("surface", "Linen", "Material", ["#ded6c5", "#a89f8c"], { material: "linen" }),
  preset("surface", "Canvas", "Material", ["#e8e1d1", "#b3a98f"], { material: "canvas" }),
  preset("surface", "Felt", "Material", ["#d6d0c8", "#9a938a"], { material: "felt", lift: 4, edge: 0.55, shadow: 0.4 }),
  preset("surface", "Cardboard", "Material", ["#c6a072", "#86643c"], { material: "cardboard" }),
  preset("surface", "Crumpled paper", "Material", ["#f0ede6", "#b9b4aa"], { material: "crumpled", relief: 1.3 }),
  preset("surface", "Cut paper", "Craft", ["#f2ecde", "#8a8272"], { material: "paper", lift: 8, edge: 0.3, shadow: 0.55 }),
  preset("surface", "Chalkboard", "Craft", ["#1a1918", "#e8e4dc"], { material: "blackCard", colorMode: "under", breakup: 0.4, edge: 0.3, tooth: 1.2 }),
];

const LOOKUP_PRESETS: Preset[] = [
  // ── Gradient map ──────────────────────────────────────────────────────────
  preset("gradientMap", "Duotone", "Tone", ["#12162e", "#ffd28a"], { shadowColor: "#12162e", midColor: "#5a4a8a", highColor: "#ffd28a" }),
  preset("gradientMap", "Teal & orange", "Cinema", ["#0a3a45", "#ff9e5c"], { shadowColor: "#0a3a45", midColor: "#7a8a80", highColor: "#ffb070", midpoint: 0.45 }),
  preset("gradientMap", "Cyberpunk", "Neon", ["#12002a", "#00ffd0"], { shadowColor: "#12002a", midColor: "#ff2e88", highColor: "#00ffd0", contrast: 1.3 }),
  preset("gradientMap", "Infrared", "Neon", ["#2a0040", "#ffe9a8"], { shadowColor: "#2a0040", midColor: "#ff2e00", highColor: "#ffe9a8", midpoint: 0.6 }),
  preset("gradientMap", "Sepia", "Tone", ["#2a1a0a", "#f0dcc0"], { shadowColor: "#2a1a0a", midColor: "#8a6a44", highColor: "#f0dcc0" }),
  preset("gradientMap", "Blueprint", "Tone", ["#0a2a6a", "#e8f0ff"], { shadowColor: "#0a2a6a", midColor: "#3a6ac0", highColor: "#e8f0ff", contrast: 1.5 }),
  preset("gradientMap", "Sunset", "Neon", ["#2a0a40", "#ffd166"], { shadowColor: "#2a0a40", midColor: "#ef476f", highColor: "#ffd166" }),

  // ── Posterize ─────────────────────────────────────────────────────────────
  preset("posterize", "Screenprint", "Print", ["#ffffff", "#101010"], { levels: 4, dither: 0, gamma: 1.1 }),
  preset("posterize", "Riso", "Print", ["#ff6b6b", "#4ecdc4"], { levels: 3, dither: 0.6, gamma: 1.2 }),
  preset("posterize", "8-bit palette", "Retro", ["#ff6b6b", "#20304a"], { levels: 3, dither: 1 }),
  preset("posterize", "Soft steps", "Tone", ["#e0e8f0", "#606870"], { levels: 12, dither: 0.25 }),
  preset("posterize", "Tone bands", "Tone", ["#ffffff", "#303030"], { levels: 5, luminanceOnly: true, dither: 0.15 }),

  // ── Fill & gradient ───────────────────────────────────────────────────────
  preset("overlay", "Gold", "Metal", ["#fff0b8", "#a06a10"], {
    mode: "linear", colorA: "#fff4cc", colorB: "#a06a10", angle: 90, repeat: 3, mirror: true,
  }),
  preset("overlay", "Chrome", "Metal", ["#ffffff", "#5a6b7d"], {
    mode: "linear", colorA: "#ffffff", colorB: "#3a4650", angle: 90, repeat: 4, mirror: true,
  }),
  preset("overlay", "Brushed steel", "Metal", ["#e8eef4", "#7a8894"], {
    mode: "conic", colorA: "#f0f4f8", colorB: "#6a7884", repeat: 6, mirror: true,
  }),
  preset("overlay", "Sunset", "Colour", ["#ffd166", "#ef476f"], { mode: "linear", colorA: "#ffd166", colorB: "#ef476f", angle: 90 }),
  preset("overlay", "Vaporwave", "Colour", ["#ff2e88", "#4cc3e0"], { mode: "linear", colorA: "#ff2e88", colorB: "#4cc3e0", angle: 45 }),
  preset("overlay", "Rainbow", "Colour", ["#ff2e88", "#00ffd0"], { mode: "conic", colorA: "#ff2e88", colorB: "#00ffd0", repeat: 1 }),
  preset("overlay", "Spotlight", "Colour", ["#ffffff", "#20304a"], { mode: "radial", colorA: "#ffffff", colorB: "#20304a", scale: 1.4 }),
  preset("overlay", "Solid recolor", "Colour", ["#7a4fd0", "#7a4fd0"], { mode: "solid", colorA: "#7a4fd0" }),
  preset("overlay", "Tint wash", "Colour", ["#4cc3e0", "#00000000"], {
    mode: "solid", colorA: "#4cc3e0", opacity: 0.35, blend: "overlay",
  }),
];

/**
 * A preset is a COMPLETE value patch, never a sparse one — the same rule the
 * glass and grade families follow, applied here at the helper so no caller can
 * forget it. A sparse patch inherits whatever the previous look left behind, so
 * switching from "Archive reel" to "Clean vintage" would keep the archive's
 * scratches and quietly make one preset render differently depending on which
 * one you tried first. Spreading the type's own defaults also means a field
 * added to an effect tomorrow is automatically neutral in every existing
 * preset, instead of being undefined in all of them.
 */
function preset(
  effectType: string,
  name: string,
  group: string,
  chip: [string, string],
  data: Record<string, unknown>,
): Preset {
  const { id: _id, type: _type, enabled: _enabled, ...defaults } = createLayerEffect(
    effectType as Parameters<typeof createLayerEffect>[0],
  ) as unknown as Record<string, unknown>;
  return {
    id: `builtin:${effectType}:${name.toLowerCase().replace(/\s+/g, "-")}`,
    kind: effectPresetKind(effectType),
    name,
    scope: "builtin",
    data: { ...defaults, ...data },
    chip,
    group,
    tags: [effectType],
    createdAt: 0,
  };
}

/**
 * The sound cards' presets, lifted out of the audio registry into the ONE
 * preset library. They are declared next to the effects they belong to (a
 * Cathedral is a fact about the reverb, not about this file), and adapted here
 * so the shared picker, `activePreset` and the save-to-library flow treat them
 * exactly like every visual preset. Without this the Presets button on a sound
 * card opened an empty menu.
 */
const AUDIO_PRESETS: Preset[] = AUDIO_EFFECT_TYPES.flatMap((def) => {
  const { id: _id, type: _type, enabled: _enabled, ...defaults } =
    def.create() as unknown as Record<string, unknown>;
  return (def.presets ?? []).map((p) => ({
    id: `builtin:${def.type}:${p.id}`,
    kind: effectPresetKind(def.type),
    name: p.label,
    scope: "builtin" as const,
    // A preset is a COMPLETE patch — `activePreset` compares values, so a
    // partial one would never match the card it just wrote.
    data: { ...defaults, ...p.patch },
    chip: ["", p.hint] as [string, string],
    group: def.label,
    tags: [def.type, ...(def.tags ?? [])],
    createdAt: 0,
  }));
});

/**
 * SHUTTER LOOKS (v56) — motion blur presets.
 *
 * Motion blur is not an effect, so these do not go through `effectPresetKind`;
 * they carry the plain kind `motion-blur` and land in the same three-scope
 * library as everything else, which is the point of the library being keyed by
 * a string rather than by an effect registry.
 *
 * The list is deliberately look-led rather than parameter-led. "Comet trail"
 * and "Long exposure" are the same machinery as "Film 180°" — a weighting and
 * a sample-combining operator — but nobody arrives wanting `weighting: "trail",
 * combine: "add"`. They arrive wanting a comet.
 */
function shutter(
  id: string,
  name: string,
  hint: string,
  over: Partial<MotionBlurSettings>,
  tags: string[] = [],
): Preset {
  return {
    id: `builtin:mblur:${id}`,
    kind: "motion-blur",
    name,
    scope: "builtin",
    // A COMPLETE patch — see the note on `glass` above; `activePreset` compares
    // values, so a sparse one could never match the layer it just wrote.
    data: { ...motionBlurSettingsSchema.parse({}), ...over },
    chip: ["", hint] as [string, string],
    group: "Shutter",
    tags: ["motion blur", ...tags],
    createdAt: 0,
  };
}

const SHUTTER_PRESETS: Preset[] = [
  shutter("film", "Film 180°", "The standard cinema shutter", {}, ["film", "default"]),
  shutter("crisp", "Crisp 90°", "Half the exposure — sharper, snappier", { shutterAngle: 90, shutterPhase: -45 }, ["sharp"]),
  shutter("long", "Long exposure", "A full frame of light, added rather than averaged", {
    shutterAngle: 360, shutterPhase: -180, combine: "add", weighting: "ease",
  }, ["light", "trail"]),
  shutter("comet", "Comet trail", "Weighted into the past — the layer drags a tail", {
    shutterAngle: 540, shutterPhase: -540, weighting: "trail", combine: "screen", strength: 0.85,
  }, ["trail", "echo"]),
  shutter("anticipate", "Anticipation", "Weighted ahead — the smear arrives before the layer", {
    shutterAngle: 360, shutterPhase: 0, weighting: "lead", strength: 0.8,
  }, ["lead"]),
  shutter("whip", "Whip pan", "Exaggerated far past physical, for fast cuts", {
    shutterAngle: 720, shutterPhase: -360, amount: 2, weighting: "ease", maxSamples: 32,
  }, ["fast", "pan"]),
  shutter("ghost", "Ghosting", "Deliberately under-sampled — discrete echoes, not a smear", {
    shutterAngle: 360, shutterPhase: -180, maxSamples: 5, combine: "screen", strength: 0.9,
  }, ["echo", "stutter"]),
];

// ── Layer looks: whole stacks ────────────────────────────────────────────────

/** A stack entry: the kind's defaults with the look's values over them. */
function lcard(type: string, over: Record<string, unknown>): StackPresetEntry {
  return { type, ...LFX.defaults(type as never), ...over };
}
const llook = (id: string, name: string, group: string, chip: [string, string], stack: StackPresetEntry[], tags: string[] = [], fps?: number) =>
  builtinStackPreset(LFX.stackPresetKind, id, name, group, chip, stack, tags, fps);

/** The group the Texture looks live under — the frame panel's strip lists exactly it. */
export const TEXTURE_LOOK_GROUP = "Texture";
const tlook = (id: string, name: string, chip: [string, string], stack: StackPresetEntry[], tags: string[] = [], fps?: number) =>
  llook(id, name, TEXTURE_LOOK_GROUP, chip, stack, ["texture", "material", ...tags], fps);

/**
 * TEXTURE LOOKS — one click from flat to made. Each is built to work on a
 * single layer AND on a whole frame (a frame effect sees one opaque picture,
 * which is why the cut-out depth lives in the Surface card's `lift` — it finds
 * the illustration's shapes against its ground — rather than in a drop
 * shadow, which an opaque frame cannot cast). No card here needs a
 * silhouette the frame does not have: no inner shadow, no roughen edges.
 *
 * THE NAMES AND IDS ARE A CONTRACT: the gift pack, its prompts and the skill
 * apply these by id (`effects_look {look: "paper-cut-out"}`).
 */
export const TEXTURE_LOOKS: Preset[] = [
  tlook("paper-cut-out", "Paper cut-out", ["#f2ecde", "#c2453a"], [
    lcard("surface", { material: "paper", lift: 8, edge: 0.3, shadow: 0.55 }),
  ], ["cut out", "craft", "paper", "collage", "depth"]),
  tlook("stop-motion", "Stop motion", ["#e9dcc4", "#7d5a36"], [
    lcard("surface", { material: "paper", lift: 5, edge: 0.25, shadow: 0.5, animate: true, rate: 12, jitter: 0.15 }),
    lcard("filmDamage", {
      animate: true, rate: 12, jitter: 0.15, mix: 1,
      dust: 0.08, dustSize: 2.5, dustBias: 0.3, dustSoftness: 0.3,
      scratches: 0, hairs: 0,
      flicker: 0.14, flickerSmooth: 0,
      weaveX: 1.5, weaveY: 1.5, weaveRotate: 0.12, weaveSmooth: 0,
      splices: false, inside: true,
    }),
  ], ["stop motion", "animation", "on twos", "handmade", "claymation", "cut out", "12fps"], 12),
  // The picture becomes CHALK on the card: the ground turns to card, every
  // fill breaks on the card's tooth, and the gradient map turns what is left
  // into chalk by its brightness, keeping only a breath of its colour.
  tlook("chalk-on-card", "Chalk on card", ["#1a1918", "#e8e4dc"], [
    lcard("surface", { material: "blackCard", colorMode: "under", breakup: 0.45, edge: 0.4, tooth: 1.4, scale: 1.2 }),
    lcard("gradientMap", { shadowColor: "#121110", midColor: "#8f8a80", highColor: "#f5f1e8", midpoint: 0.5, contrast: 1.3, brightness: 0, mix: 0.74 }),
    lcard("filmDamage", {
      animate: false, mix: 1,
      dust: 0.3, dustSize: 1.6, dustBias: -0.9, dustSoftness: 0.55,
      scratches: 0, hairs: 0, flicker: 0, weaveX: 0, weaveY: 0, weaveRotate: 0,
      splices: false, inside: true,
    }),
  ], ["chalk", "chalkboard", "blackboard", "school", "dark", "drawn"]),
  // Two loud inks on cream: the picture SEPARATED into fluorescent pink and
  // blue (warm to pink, cool and dark to blue, purples where they overlap),
  // each drum its own screen, the pink one printed 6 px off. A gradient map
  // here painted everything one washed pink by brightness.
  tlook("riso-print", "Riso print", ["#ff48b0", "#0078bf"], [
    lcard("halftone", { shape: "dot", size: 7, angle: 15, mode: "riso", inkColor: "#0078bf", ink2Color: "#ff48b0", paperColor: "#f3ecdb", misregister: 6, contrast: 2, softness: 0.12 }),
    lcard("surface", { material: "paper", relief: 0.6, mix: 0.85 }),
  ], ["riso", "risograph", "print", "zine", "duotone", "halftone", "misregistration"]),
  // One stitch per cell in the cell's colour, the cloth showing between them
  // (the board) and the weave lighting thread and cloth alike. A halftone
  // cross at 45° varies its arms with tone and read as a maze, not thread.
  tlook("cross-stitch", "Cross-stitch", ["#ddd5c4", "#c2453a"], [
    lcard("pixelate", { size: 24, shape: "cross", gap: 0.12, softness: 0.15, board: "#ddd5c4" }),
    lcard("surface", { material: "linen", relief: 1.5 }),
  ], ["embroidery", "stitch", "thread", "needlework", "pixel art", "cloth", "linen"]),
  tlook("led-board", "LED board", ["#0b0d10", "#ffb03a"], [
    lcard("pixelate", { size: 14, shape: "dot", gap: 0.22, softness: 0.15, board: "#0b0d10" }),
    lcard("glow", { mode: "auto", size: 10, intensity: 0.9, glowFalloff: "light" }),
  ], ["led", "sign", "scoreboard", "dot matrix", "pixel", "screen", "stadium"]),
  tlook("felt", "Felt", ["#d6d0c8", "#9e3b3b"], [
    lcard("surface", { material: "felt", lift: 5, edge: 0.6, shadow: 0.45, relief: 1.1 }),
  ], ["felt", "fabric", "wool", "craft", "soft", "puppet"]),
  tlook("cardboard", "Cardboard", ["#c6a072", "#86643c"], [
    lcard("surface", { material: "cardboard", lift: 6, edge: 0.3, shadow: 0.5 }),
  ], ["cardboard", "box", "corrugated", "craft", "diy"]),
  tlook("crumpled-paper", "Crumpled paper", ["#f0ede6", "#b9b4aa"], [
    lcard("surface", { material: "crumpled", relief: 1.3 }),
  ], ["crumpled", "creased", "folds", "wrinkled", "paper"]),
  // v111. Clay is stop motion too: a puppet that only moves between frames.
  tlook("claymation", "Claymation", ["#e9dccb", "#c8643f"], [
    lcard("surface", { material: "clay", lift: 11, edge: 0.15, shadow: 0.6, relief: 0.75, scale: 1.4, animate: true, rate: 12, jitter: 0.1 }),
  ], ["clay", "claymation", "plasticine", "stop motion", "puppet", "fingerprints", "12fps"], 12),
  tlook("blueprint", "Blueprint", ["#183c84", "#e8f0ff"], [
    lcard("surface", { material: "blueprint", colorMode: "under", edge: 0.1 }),
    lcard("gradientMap", { shadowColor: "#0b2563", midColor: "#2456b0", highColor: "#f5f8ff", midpoint: 0.36, contrast: 1.35 }),
  ], ["blueprint", "cyanotype", "technical", "drafting", "grid", "engineering", "science"]),
  tlook("engraving", "Engraving", ["#efe6d2", "#2a2118"], [
    lcard("halftone", { shape: "line", size: 8, angle: 32, mode: "mono", inkColor: "#2a2118", paperColor: "#f3ebd9", contrast: 0.8, softness: 0.08, paper: true }),
    lcard("surface", { material: "paper", relief: 0.8 }),
  ], ["engraving", "etching", "banknote", "woodcut", "line art", "hatching", "vintage", "scientific plate"]),
  tlook("watercolor", "Watercolour", ["#f6f2e9", "#d9775a"], [
    lcard("surface", { material: "watercolor", colorMode: "multiply", edge: 0.6, relief: 1.1 }),
  ], ["watercolour", "watercolor", "paint", "wash", "illustration", "soft", "storybook"]),

  // ── v112: the material engine. Most are ONE Surface card: the material's
  // body, sheen, glow and flow are tuned in its recipe, so the look is the
  // material plus how it meets the picture.
  tlook("holo-foil", "Holographic foil", ["#e9e6f2", "#9b7bd8"], [
    lcard("surface", { material: "foil" }),
  ], ["light", "foil", "holographic", "hologram", "iridescent", "rainbow", "premium", "sticker", "shimmer"]),
  tlook("liquid-chrome", "Liquid chrome", ["#16181e", "#d8dce4"], [
    lcard("surface", { material: "chrome", colorMode: "under" }),
  ], ["light", "chrome", "metal", "mirror", "y2k", "liquid metal", "reflective"]),
  tlook("neon-glass", "Neon glass", ["#1e1b20", "#ff5a7a"], [
    lcard("surface", { material: "neon", colorMode: "under" }),
  ], ["light", "neon", "sign", "tube", "night", "bar", "glow"]),
  tlook("stained-glass", "Stained glass", ["#eee6d2", "#d94a3a"], [
    lcard("surface", { material: "stainedGlass" }),
  ], ["glass", "stained glass", "window", "church", "lead", "mosaic", "light"]),
  tlook("frosted-glass", "Frosted glass", ["#eef2f6", "#9fb2c4"], [
    lcard("surface", { material: "frosted" }),
  ], ["glass", "frosted", "etched", "shower", "privacy", "soft", "winter"]),
  tlook("crystal", "Crystal", ["#141822", "#d9b25a"], [
    lcard("surface", { material: "crystal", colorMode: "under" }),
  ], ["glass", "crystal", "gem", "jewel", "facets", "diamond", "ice", "luxury"]),
  tlook("soap-film", "Soap film", ["#121419", "#9be3d8"], [
    lcard("surface", { material: "soapFilm", colorMode: "under" }),
  ], ["glass", "soap", "bubble", "iridescent", "thin film", "oil slick", "dreamy"]),
  tlook("ferrofluid", "Ferrofluid", ["#e8e6e2", "#0a0a0c"], [
    lcard("surface", { material: "ferrofluid", colorMode: "under", edge: 0.7 }),
  ], ["organic", "ferrofluid", "magnet", "spikes", "black", "liquid", "science", "experimental"]),
  tlook("kintsugi", "Kintsugi", ["#eae2d4", "#d6aa3e"], [
    lcard("surface", { material: "kintsugi", colorMode: "under" }),
  ], ["craft", "kintsugi", "ceramic", "gold", "cracks", "repair", "japanese", "pottery", "wabi sabi"]),
  tlook("tufted-rug", "Tufted rug", ["#d6c8b0", "#c8553d"], [
    lcard("surface", { material: "tufted", edge: 0.5, relief: 1.1 }),
  ], ["craft", "rug", "tufted", "punch needle", "yarn", "textile", "cosy", "carpet"]),
  // A phosphor screen shines on a dark picture: the ground goes to the dark
  // tube ("under"), so the subject is what lights up; the vignette is the
  // tube's falloff, not a frame.
  tlook("crt-phosphor", "CRT phosphor", ["#101210", "#ff6a3a"], [
    lcard("surface", { material: "phosphor", colorMode: "under" }),
    lcard("vignette", { amount: 0.35, softness: 0.7, roundness: 0.6 }),
  ], ["screen", "crt", "phosphor", "rgb", "retro", "tv", "monitor", "arcade"]),
  tlook("ink-bleed", "Ink on rice paper", ["#f1ebdd", "#2a2a33"], [
    lcard("surface", { material: "ricePaper", edge: 0.8, relief: 0.9 }),
  ], ["organic", "ink", "bleed", "diffusion", "rice paper", "xuan", "sumi", "calligraphy", "wet"]),
  tlook("marbling", "Marbling", ["#eee8da", "#2d5fa8"], [
    lcard("surface", { material: "marble" }),
  ], ["organic", "marbling", "suminagashi", "ebru", "swirl", "fluid", "water", "endpaper"]),

  // ── v112: print and press, on the engine's pressed lift and blind mode.
  tlook("letterpress", "Letterpress", ["#efe8da", "#c2453a"], [
    lcard("surface", { material: "paper", lift: -5, shadow: 0.7, edge: 0.15, breakup: 0.06, relief: 1.4, tooth: 1.3 }),
  ], ["print", "letterpress", "deboss", "pressed", "wedding", "stationery", "premium", "cotton"]),
  tlook("embossed-paper", "Embossed paper", ["#f2ede2", "#cfc6b4"], [
    lcard("surface", { material: "paper", colorMode: "blind", lift: 5, shadow: 0.5, relief: 1.2 }),
  ], ["print", "emboss", "blind emboss", "white on white", "seal", "minimal", "premium", "relief"]),
  // A cyanotype is a sun-print: what light reached turns Prussian blue,
  // what was covered stays the white of the paper — so the map runs bright
  // to blue, dark to white.
  tlook("cyanotype", "Cyanotype", ["#123a7a", "#eef3fb"], [
    lcard("gradientMap", { shadowColor: "#f2f5f9", midColor: "#5d84bf", highColor: "#123a7a", midpoint: 0.55, contrast: 1.4 }),
    lcard("surface", { material: "watercolor", edge: 0.4, relief: 1 }),
  ], ["print", "cyanotype", "sun print", "botanical", "blue", "photographic", "vintage"]),
  tlook("newspaper", "Newspaper", ["#e5e0d2", "#141414"], [
    lcard("halftone", { shape: "dot", size: 7, angle: 45, contrast: 1.15, mode: "duotone", inkColor: "#161616", paperColor: "#e5e0d2" }),
    lcard("surface", { material: "newsprint", colorMode: "multiply", relief: 0.8 }),
  ], ["print", "newspaper", "newsprint", "headline", "halftone", "history", "archival"]),
  tlook("woodblock", "Woodblock", ["#caa27a", "#3a2416"], [
    lcard("surface", { material: "wood", breakup: 0.32, relief: 1.2 }),
  ], ["print", "woodblock", "woodcut", "wood", "grain", "ukiyo-e", "relief print"]),
  tlook("graph-paper", "Graph paper", ["#f7f6f1", "#5b8fd6"], [
    lcard("surface", { material: "graph", colorMode: "under" }),
  ], ["print", "graph paper", "grid", "notebook", "school", "explainer", "doodle", "plan"]),
  tlook("photocopy", "Photocopy", ["#f2f2ee", "#141414"], [
    // A copier keeps only what is darker than its threshold — light colours
    // drop out, which is the look — and leaves a few specks of toner.
    lcard("gradientMap", { shadowColor: "#121212", midColor: "#3c3c3c", highColor: "#f2f2ee", midpoint: 0.74, contrast: 2.4 }),
    lcard("grain", { amount: 0.12, size: 1.2, chroma: 0, softness: 0.1, blend: "multiply", animate: false }),
    lcard("surface", { material: "paper", breakup: 0.12, relief: 0.6 }),
  ], ["print", "photocopy", "xerox", "zine", "punk", "flyer", "toner", "black and white"]),

  // ── v112: screens, from cards that were always there.
  tlook("vhs", "VHS", ["#24303c", "#c0d0e0"], [
    lcard("noise", { animate: true, shape: "value", scale: 220, aspect: 6, octaves: 2, amount: 0.08, blend: "overlay", displace: 14, evolve: 3, rate: 30, driftY: -140 }),
    lcard("rgbSplit", { angle: 0, distance: 4 }),
    lcard("scanlines", { shape: "line", pitch: 3, thickness: 0.55, softness: 0.85, amount: 0.3, blend: "multiply", interlace: 0.45, rate: 60 }),
    lcard("grain", { animate: true, amount: 0.36, size: 1.8, rate: 24, chroma: 0.2, softness: 0.4, blend: "overlay" }),
  ], ["screen", "vhs", "tape", "90s", "home video", "found footage", "analog", "retro"]),
  tlook("game-boy", "Game Boy", ["#0f380f", "#9bbc0f"], [
    lcard("pixelate", { size: 8, shape: "square", gap: 0.06, softness: 0.05, board: "#0f380f" }),
    lcard("posterize", { levels: 4, luminanceOnly: true, dither: 0 }),
    lcard("gradientMap", { shadowColor: "#0f380f", midColor: "#4f7a28", highColor: "#9bbc0f", midpoint: 0.5, contrast: 1.2 }),
  ], ["screen", "game boy", "handheld", "8-bit", "green", "pixel", "retro", "games", "4 colours"]),
];

/**
 * Whole-layer looks — several cards applied together, in stack order. Few and
 * broad on purpose: a single card's presets already cover its own range, so a
 * look earns its place only where the combination IS the idea.
 */
export const LAYER_LOOKS: Preset[] = [
  llook("soft-drop", "Soft drop", "Elevation", ["#6b6b6b", "#1a1a1a"], [lcard("shadow", { color: "#00000077", x: 0, y: 6, blur: 18 })], ["default"]),
  llook("floating", "Floating", "Elevation", ["#6b6b6b", "#1a1a1a"], [
    lcard("shadow", { color: "#00000044", x: 0, y: 2, blur: 4 }),
    lcard("shadow", { color: "#00000066", x: 0, y: 18, blur: 40 }),
  ], ["card", "material"]),
  llook("pinned", "Pinned", "Elevation", ["#6b6b6b", "#1a1a1a"], [lcard("shadow", { color: "#00000099", x: 4, y: 4, blur: 0 })], ["hard", "paper"]),
  llook("neon", "Neon", "Light", ["#ffffff", "#4cc3e0"], [
    lcard("glow", { mode: "auto", size: 48, intensity: 0.7 }),
    lcard("glow", { mode: "auto", size: 14, intensity: 1.6 }),
  ], ["sign", "bloom"]),
  llook("backlit", "Backlit", "Light", ["#ffe1a8", "#ffb347"], [
    lcard("glow", { mode: "solid", color: "#ffb347", size: 36, intensity: 1.2 }),
    lcard("shadow", { color: "#00000088", x: 0, y: 8, blur: 20 }),
  ], ["warm", "rim"]),
  llook("filmic", "Filmic", "Film", ["#3a3f47", "#15181c"], [
    lcard("vignette", { amount: 0.45, softness: 0.6, roundness: 0.5 }),
    lcard("grain", { animate: true, amount: 0.22, size: 1.2, softness: 0.4 }),
  ], ["cinematic", "grain", "vignette"]),
  llook("broadcast-edge", "Broadcast edge", "Legibility", ["#2b2b2b", "#0a0a0a"], [
    lcard("stroke", { color: "#000000", width: 3, placement: "outside" }),
    lcard("shadow", { color: "#000000aa", x: 0, y: 3, blur: 6 }),
  ], ["outline", "caption"]),
  // THE APPLE BLOB. Put this on a GROUP, not on the layers inside it: the group
  // combines its members into one picture first, so they melt into each other
  // and the pane of glass that forms over the result is one pane. On a single
  // layer the same two cards can only melt a shape into itself.
  llook("liquid-merge", "Liquid merge", "Material", ["#f2f7ff", "#9fb6cc"], [
    lcard("goo", { blur: 26, threshold: 0.5, softness: 0.03 }),
    lcard("glass", {
      refraction: 0.9, depth: 52, dispersion: 0.3, frost: 4,
      lightAngle: -45, light: 1.1, splay: 0.25,
      paint: 0.08, saturation: 1.06, brightness: 1.02,
    }),
  ], ["metaball", "apple", "wwdc", "blob", "merge", "glass", "group", "default"]),
  // The same merge without the pane — for shapes that should read as liquid
  // rather than as glass. The inner shadow is what gives a flat blob volume.
  llook("droplets", "Droplets", "Material", ["#cfeaff", "#3a7aa8"], [
    lcard("goo", { blur: 16, threshold: 0.58, softness: 0.05 }),
    lcard("innerShadow", { color: "#00000055", x: 0, y: -4, blur: 14 }),
    lcard("glow", { mode: "solid", color: "#ffffff", size: 10, intensity: 0.5, inner: true }),
  ], ["metaball", "water", "liquid", "merge", "group"]),
  llook("split-shadow", "Split shadow", "Stylize", ["#ff2a6d", "#05d9e8"], [
    lcard("rgbSplit", { angle: 0, distance: 5 }),
    lcard("shadow", { color: "#00000077", x: 0, y: 6, blur: 14 }),
  ], ["glitch", "chromatic"]),
  ...TEXTURE_LOOKS,
];

/**
 * Particle looks on an emitter card's picker — the same list the + menu and
 * `physics.emit {look}` read, so a look is one entry wherever it is offered.
 * Complete patches over the type's defaults, like every preset here. A look
 * that is several cards (a firework shell and its burst) is a STACK look —
 * the Particles section's Looks picker, which replaces the stack — since a
 * card's picker can only reshape its one card.
 */
const EMITTER_PRESETS: Preset[] = EMITTER_LOOKS.map((look) =>
  look.then?.length
    ? builtinStackPreset(EMITTER.stackPresetKind, look.id, look.name, "Particles", look.chip, emittersFromLook(look).map(({ id: _i, enabled: _e, ...rest }) => rest), ["particles", ...look.tags])
    : {
        id: `builtin:emitter-${look.id}`,
        kind: effectPresetKindFor("emitter", look.type),
        name: look.name,
        scope: "builtin",
        data: { ...EMITTER.defaults(look.type), ...look.patch },
        chip: look.chip,
        group: look.type === "burst" ? "Bursts" : look.type === "hit" ? "On hit" : look.type === "sub" ? "From particles" : "Streams",
        tags: ["particles", ...look.tags],
        createdAt: 0,
      },
);

/** Sound sets on the Sound tab's set picker — timbre and notes, never level. */
const SOUND_SET_PRESETS: Preset[] = SOUND_SETS.map((set) => ({
  id: `builtin:sound-set-${set.id}`,
  kind: SOUND_SET_PRESET_KIND,
  name: set.name,
  scope: "builtin",
  data: set.voice,
  chip: set.chip,
  group: set.group,
  tags: ["sound", ...set.tags],
  createdAt: 0,
}));

/** Every built-in preset, across every kind. */
export const BUILTIN_PRESETS: Preset[] = [
  ...LAYER_LOOKS,
  ...BUILTIN_TEXT_EFFECT_PRESETS,
  ...GLASS_PRESETS,
  ...GRADE_PRESETS,
  ...GRADE_GRAPH_PRESETS,
  ...ANALOG_PRESETS,
  ...LIGHT_PRESETS,
  ...DISTORT_PRESETS,
  ...COSMOS_PRESETS,
  ...PATTERN_PRESETS,
  ...SURFACE_PRESETS,
  ...LOOKUP_PRESETS,
  ...DEPTH_PRESETS,
  ...SIMPLE_PRESETS,
  ...AUDIO_PRESETS,
  ...SHUTTER_PRESETS,
  ...EMITTER_PRESETS,
  ...STROKE_SETS,
  ...STROKE_STACKS,
  ...SOUND_SET_PRESETS,
];

/** Built-ins as a library source (the library takes stored-shaped entries). */
export function builtinPresetSource(): { scope: "builtin"; entries: Preset[] } {
  return { scope: "builtin", entries: BUILTIN_PRESETS };
}
