import { createId } from "../../ids";
import { glassMoves } from "../glass";
import { WHILE_MOVING, animateToggle, type LayerEffectTypeDef } from "./shared";

/**
 * Materials — the cards that read the pixels BEHIND the layer.
 */
export const MATERIAL_EFFECT_TYPES: LayerEffectTypeDef[] = [
  {
    // Liquid glass — the material card. Seven controls decide the look and
    // sit up front (the Figma/Apple set); the rest is one Advanced disclosure.
    type: "glass",
    label: "Liquid glass",
    editor: { width: 420 },
    blurb: "Refracts what is behind the layer — a real glass material.",
    tags: ["frosted", "refraction", "apple", "material", "blur", "ios", "figma", "liquid"],
    category: "material",
    // Moves only while its ripple is being driven — see `glassMoves`.
    timeDriven: (fx) => fx.type === "glass" && glassMoves(fx),
    // It refracts. Everything under the layer has to be rendered for it.
    readsBackdrop: true,
    groups: [
      { id: "glass", label: "Glass" },
      { id: "light", label: "Light" },
      { id: "shape", label: "Shape", advanced: true },
      { id: "tint", label: "Tint", advanced: true },
      { id: "surface", label: "Surface", advanced: true },
      { id: "liquid", label: "Liquid", advanced: true },
      { id: "quality", label: "Performance", advanced: true },
    ],
    fields: [
      { key: "refraction", label: "Refraction", kind: "number", min: 0, max: 1, step: 0.01, group: "glass", hint: "How hard the rim bends what is behind it. 0 is a frosted pane, 1 a lens." },
      { key: "depth", label: "Depth", kind: "number", min: 0, max: 600, step: 1, unit: "px", group: "glass", scaled: true, hint: "How far in from the edge the curved bezel reaches. The middle stays flat." },
      { key: "dispersion", label: "Dispersion", kind: "number", min: 0, max: 1, step: 0.01, group: "glass", hint: "Splits red and blue along the bezel — the prism fringe." },
      { key: "frost", label: "Frost", kind: "number", min: 0, max: 200, step: 0.5, unit: "px", group: "glass", scaled: true, hint: "Blurs what you see through the glass." },

      { key: "lightAngle", label: "Angle", kind: "number", min: -180, max: 180, step: 1, unit: "°", group: "light", bipolar: true, hint: "Where the light comes from. −90° is straight above, −45° top-left." },
      { key: "light", label: "Intensity", kind: "number", min: 0, max: 2, step: 0.01, group: "light", hint: "Brightness of the rim highlight — on the lit side, and fainter opposite." },
      { key: "splay", label: "Splay", kind: "number", min: 0, max: 1, step: 0.01, group: "light", hint: "How far the highlight spreads round the rim and into the pane." },
      { key: "lightColor", label: "Colour", kind: "color", group: "light" },

      {
        key: "profile",
        label: "Bezel",
        kind: "select",
        group: "shape",
        options: [
          { value: "squircle", label: "Squircle", hint: "Flat, then curves — Apple's profile. Smoothest stretch." },
          { value: "circle", label: "Round", hint: "A true quarter-round. Harder, more like a lens." },
          { value: "lip", label: "Lip", hint: "A raised rim with a shallow dish behind it." },
          { value: "concave", label: "Concave", hint: "A dish — pushes the backdrop outward instead of pulling it in." },
        ],
      },
      { key: "ior", label: "Refractive index", kind: "number", min: 1, max: 2.5, step: 0.01, group: "shape", hint: "1.0 is air, 1.5 glass, 2.4 diamond. Shapes how fast the bend grows toward the edge." },
      { key: "inset", label: "Inset", kind: "number", min: -200, max: 200, step: 1, unit: "px", group: "shape", bipolar: true, scaled: true, hint: "Shrink (+) or grow (−) the pane relative to the layer." },
      { key: "coverage", label: "Coverage", kind: "number", min: 0.02, max: 1, step: 0.01, group: "shape", hint: "Alpha counted as a whole pane. Lower it so a faint fill still reads as solid glass." },
      { key: "mix", label: "Mix", kind: "number", min: 0, max: 1, step: 0.01, group: "shape", hint: "Blends the whole material over the untouched layer." },

      { key: "paint", label: "Paint", kind: "number", min: 0, max: 1, step: 0.01, group: "tint", hint: "How much of the layer's own fill shows over the glass. 0.2 turns an opaque fill into a 20% tint." },
      { key: "tintColor", label: "Tint", kind: "color", group: "tint" },
      { key: "tint", label: "Tint amount", kind: "number", min: 0, max: 1, step: 0.01, group: "tint" },
      { key: "saturation", label: "Saturation", kind: "number", min: 0, max: 3, step: 0.01, unit: "×", group: "tint", hint: "Colour punch of the transmitted light." },
      { key: "brightness", label: "Brightness", kind: "number", min: 0, max: 3, step: 0.01, unit: "×", group: "tint" },

      { key: "noise", label: "Grain", kind: "number", min: 0, max: 1, step: 0.01, group: "surface", hint: "Micro-frost scattering on the surface." },
      { key: "noiseScale", label: "Grain size", kind: "number", min: 0.1, max: 16, step: 0.05, unit: "×", group: "surface" },

      { key: "ripple", label: "Ripple", kind: "number", min: 0, max: 1, step: 0.01, group: "liquid", hint: "A travelling wave folded into the surface — the “liquid” in liquid glass." },
      { key: "rippleScale", label: "Ripple size", kind: "number", min: 0.1, max: 16, step: 0.05, unit: "×", group: "liquid" },
      { key: "ripplePhase", label: "Phase", kind: "number", min: -3600, max: 3600, step: 1, unit: "°", group: "liquid", bipolar: true, hint: "Keyframe this to animate the wave by hand." },
      { key: "rippleSpeed", label: "Speed", kind: "number", min: -8, max: 8, step: 0.05, unit: "hz", group: "liquid", bipolar: true, showIf: WHILE_MOVING, hint: "Advances the phase from the clip's own time — animate without a single keyframe." },

      { key: "quality", label: "Detail", kind: "number", min: 0.25, max: 1, step: 0.05, group: "quality", hint: "Render scale of the material pass. 0.5 costs a quarter as much and is usually indistinguishable under frost." },
    ],
    toggles: [
      animateToggle("liquid"),
      { key: "edgeOnly", label: "Edge only", group: "quality", hint: "Rim highlight without the backdrop refraction — much cheaper." },
    ],
    // What playback may drop, tier by tier, when the frame budget is blown:
    // half-res first (frost hides it), then the prism and the pane's texture.
    fidelity: [
      { quality: 0.5 },
      { quality: 0.35, dispersion: 0, noise: 0 },
      { quality: 0.25, dispersion: 0, noise: 0, frost: 0, ripple: 0 },
    ],
    create: () => ({
      id: createId("lfx"),
      type: "glass",
      enabled: true,
      animate: true,
      refraction: 0.8,
      depth: 36,
      dispersion: 0.35,
      frost: 6,
      lightAngle: -45,
      light: 0.8,
      splay: 0.35,
      lightColor: "#ffffff",
      profile: "squircle",
      ior: 1.5,
      inset: 0,
      coverage: 0.1,
      mix: 1,
      paint: 0.2,
      tintColor: "#ffffff",
      tint: 0,
      saturation: 1.08,
      brightness: 1,
      noise: 0,
      noiseScale: 1,
      ripple: 0,
      rippleScale: 2,
      ripplePhase: 0,
      rippleSpeed: 0,
      quality: 1,
      edgeOnly: false,
    }),
  },
];
