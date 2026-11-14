import { createId } from "../../ids";
import { ownClockSec } from "../effect-base";
import { WHILE_MOVING, animateToggle, type LayerEffectTypeDef } from "./shared";

const seedField = (group: string) => ({ key: "seed", label: "Seed", kind: "number" as const, min: 0, max: 99999, step: 1, group, hint: "Another universe of the same look." });

/**
 * SPACE — the cosmos family's cards (`schema/effects/cosmos.ts` has the model).
 * The lens and the shockwave read the backdrop; the sky cards paint into the
 * layer's silhouette.
 */
export const COSMOS_EFFECT_TYPES: LayerEffectTypeDef[] = [
  {
    type: "lens",
    label: "Gravitational lens",
    blurb: "Bends what is behind it like a black hole — a shadow, a photon ring, an Einstein ring.",
    tags: ["black hole", "gravity", "einstein ring", "lensing", "warp", "space", "interstellar", "event horizon", "photon ring", "spacetime"],
    category: "cosmos",
    readsBackdrop: true,
    placed: true,
    groups: [
      { id: "bend", label: "Bend" },
      { id: "hole", label: "Shadow" },
    ],
    fields: [
      { key: "radius", label: "Einstein radius", kind: "number", min: 0, max: 4000, step: 1, unit: "px", group: "bend", scaled: true, hint: "Where a star straight behind becomes a ring." },
      { key: "strength", label: "Strength", kind: "number", min: 0, max: 1, step: 0.01, group: "bend", hint: "How much space bends. Key it up from 0." },
      { key: "reach", label: "Reach", kind: "number", min: 1.5, max: 10, step: 0.1, unit: "×", group: "bend", hint: "How far the bend reaches before it settles, × the Einstein radius." },
      { key: "shadow", label: "Shadow", kind: "number", min: 0, max: 4000, step: 1, unit: "px", group: "hole", scaled: true, hint: "The black hole itself. A black hole's shadow is 2.6× its horizon; 0 is a lens with no hole." },
      { key: "ring", label: "Photon ring", kind: "number", min: 0, max: 4, step: 0.01, group: "hole" },
      { key: "ringWidth", label: "Ring width", kind: "number", min: 0.5, max: 200, step: 0.5, unit: "px", group: "hole", scaled: true },
      { key: "ringColor", label: "Ring colour", kind: "color", group: "hole" },
      { key: "glow", label: "Glow", kind: "number", min: 0, max: 2, step: 0.01, group: "hole", hint: "Soft light hugging the shadow." },
    ],
    create: () => ({ id: createId("lfx"), type: "lens", enabled: true, radius: 230, strength: 1, shadow: 92, ring: 1, ringWidth: 3, ringColor: "#ffe2bd", glow: 0.35, reach: 4 }),
  },
  {
    type: "shockwave",
    label: "Shockwave",
    blurb: "A travelling ring that bends what is behind it — a blast, a supernova, a gravitational wave. Key its radius.",
    tags: ["shockwave", "shock", "blast", "explosion", "supernova", "ripple", "ring", "distortion", "refraction", "wave"],
    category: "cosmos",
    readsBackdrop: true,
    placed: true,
    fields: [
      { key: "radius", label: "Radius", kind: "number", min: 0, max: 8000, step: 1, unit: "px", scaled: true, hint: "Where the front is. Key it to make it travel." },
      { key: "width", label: "Width", kind: "number", min: 1, max: 2000, step: 1, unit: "px", scaled: true },
      { key: "strength", label: "Strength", kind: "number", min: -400, max: 400, step: 0.5, unit: "px", bipolar: true, scaled: true, hint: "How far it pushes what is behind. Key it down to let it die." },
      { key: "chroma", label: "Chroma", kind: "number", min: 0, max: 1, step: 0.01, hint: "Red and blue bent apart." },
      { key: "light", label: "Front", kind: "number", min: 0, max: 2, step: 0.01, hint: "A thin bright edge on the front." },
      { key: "color", label: "Front colour", kind: "color" },
    ],
    create: () => ({ id: createId("lfx"), type: "shockwave", enabled: true, radius: 300, width: 60, strength: 36, chroma: 0.35, light: 0.25, color: "#cfe3ff" }),
  },
  {
    type: "star",
    label: "Star",
    blurb: "A boiling photosphere with a corona, coloured by its temperature. Put it on a circle.",
    tags: ["sun", "star", "photosphere", "corona", "plasma", "temperature", "kelvin", "supergiant", "space", "solar"],
    category: "cosmos",
    // Boils on its own clock while `boil` runs; continuous, so no stepped picture.
    timeDriven: (fx) => fx.type === "star" && fx.boil > 0,
    groups: [
      { id: "surface", label: "Surface" },
      { id: "corona", label: "Corona" },
      { id: "motion", label: "Motion" },
    ],
    fields: [
      { key: "temperature", label: "Temperature", kind: "number", min: 1000, max: 50000, step: 50, unit: "K", group: "surface", hint: "3,500 K is a red giant, 5,800 K the Sun, 25,000 K a blue giant." },
      { key: "brightness", label: "Brightness", kind: "number", min: 0, max: 4, step: 0.01, group: "surface" },
      { key: "granulation", label: "Cells", kind: "number", min: 0.005, max: 0.6, step: 0.005, unit: "×", group: "surface", hint: "Convection cell size, × the radius. Small and many is the Sun; a few giant ones, a supergiant." },
      { key: "contrast", label: "Contrast", kind: "number", min: 0, max: 1, step: 0.01, group: "surface" },
      { key: "limb", label: "Limb", kind: "number", min: 0, max: 1, step: 0.01, group: "surface", hint: "How much dimmer and redder the edge is." },
      { key: "corona", label: "Corona", kind: "number", min: 0, max: 4, step: 0.01, group: "corona" },
      { key: "coronaSize", label: "Reach", kind: "number", min: 0, max: 6, step: 0.05, unit: "×", group: "corona", hint: "× the star's radius." },
      { key: "boil", label: "Boil", kind: "number", min: 0, max: 8, step: 0.01, group: "motion", showIf: WHILE_MOVING },
      seedField("motion"),
    ],
    toggles: [animateToggle("motion")],
    create: () => ({ id: createId("lfx"), type: "star", enabled: true, animate: true, temperature: 5800, brightness: 1.2, granulation: 0.03, contrast: 0.6, boil: 0.35, limb: 0.65, corona: 0.6, coronaSize: 0.9, seed: 1 }),
  },
  {
    type: "starfield",
    label: "Starfield",
    blurb: "A real night sky — thousands of stars, a few bright ones with spikes, twinkling. Put it on a full-frame rectangle.",
    tags: ["stars", "sky", "space", "night", "galaxy", "milky way", "cosmos", "universe", "parallax", "twinkle"],
    category: "cosmos",
    timeDriven: (fx) => fx.type === "starfield" && fx.twinkle > 0,
    // Twinkle changes in steps: equal steps are identical pictures, so caches keep them.
    picture: (fx, timeSec) => (fx.type === "starfield" ? String(Math.floor(ownClockSec(fx, timeSec) * fx.rate + 1e-6)) : null),
    groups: [
      { id: "sky", label: "Sky" },
      { id: "light", label: "Light" },
      { id: "motion", label: "Motion" },
    ],
    fields: [
      { key: "density", label: "Density", kind: "number", min: 0, max: 20000, step: 10, group: "sky", hint: "Stars per million pixels." },
      { key: "band", label: "Galaxy", kind: "number", min: 0, max: 1, step: 0.01, group: "sky", hint: "A faint band of the Milky Way across it." },
      { key: "bandAngle", label: "Galaxy angle", kind: "number", min: -180, max: 180, step: 1, unit: "°", bipolar: true, group: "sky" },
      { key: "brightness", label: "Brightness", kind: "number", min: 0, max: 4, step: 0.01, group: "light" },
      { key: "size", label: "Size", kind: "number", min: 0.3, max: 12, step: 0.05, unit: "px", group: "light", scaled: true },
      { key: "spectral", label: "Colour", kind: "number", min: 0, max: 1, step: 0.01, group: "light", hint: "Each star's own colour, from red dwarfs to blue giants. 0 is all white." },
      { key: "spikes", label: "Spikes", kind: "number", min: 0, max: 2, step: 0.01, group: "light", hint: "Diffraction spikes on the brightest stars." },
      { key: "spikeAngle", label: "Spike angle", kind: "number", min: -180, max: 180, step: 1, unit: "°", bipolar: true, group: "light" },
      { key: "twinkle", label: "Twinkle", kind: "number", min: 0, max: 1, step: 0.01, group: "motion" },
      { key: "rate", label: "Twinkle rate", kind: "number", min: 1, max: 60, step: 1, unit: "/s", group: "motion", showIf: WHILE_MOVING },
      { key: "driftX", label: "Drift X", kind: "number", min: -100000, max: 100000, step: 1, unit: "px", bipolar: true, group: "motion", scaled: true, hint: "Key it to move through space: near stars travel further than far ones." },
      { key: "driftY", label: "Drift Y", kind: "number", min: -100000, max: 100000, step: 1, unit: "px", bipolar: true, group: "motion", scaled: true },
      seedField("motion"),
    ],
    toggles: [animateToggle("motion")],
    create: () => ({ id: createId("lfx"), type: "starfield", enabled: true, animate: true, density: 1800, brightness: 1, size: 1.1, spectral: 0.65, twinkle: 0.25, rate: 12, spikes: 0.6, spikeAngle: 45, band: 0.35, bandAngle: -28, driftX: 0, driftY: 0, seed: 1 }),
  },
  {
    type: "nebula",
    label: "Nebula",
    blurb: "Glowing clouds of gas with dark dust lanes. Put it on a full-frame rectangle.",
    tags: ["nebula", "gas", "clouds", "space", "galaxy", "cosmos", "orion", "carina", "fbm", "smoke"],
    category: "cosmos",
    timeDriven: (fx) => fx.type === "nebula" && fx.speed !== 0,
    groups: [
      { id: "gas", label: "Gas" },
      { id: "colour", label: "Colour" },
      { id: "motion", label: "Motion" },
    ],
    fields: [
      { key: "scale", label: "Scale", kind: "number", min: 20, max: 6000, step: 1, unit: "px", group: "gas", scaled: true, hint: "The size of its largest clouds." },
      { key: "coverage", label: "Coverage", kind: "number", min: 0, max: 1, step: 0.01, group: "gas", hint: "How much of the sky has gas." },
      { key: "warp", label: "Filaments", kind: "number", min: 0, max: 3, step: 0.01, group: "gas", hint: "How hard the gas folds into itself." },
      { key: "detail", label: "Detail", kind: "number", min: 1, max: 8, step: 1, group: "gas" },
      { key: "dust", label: "Dust", kind: "number", min: 0, max: 1, step: 0.01, group: "gas", hint: "Dark lanes of dust across the glow." },
      { key: "brightness", label: "Glow", kind: "number", min: 0, max: 4, step: 0.01, group: "colour" },
      { key: "colorA", label: "Edge", kind: "color", group: "colour" },
      { key: "colorB", label: "Body", kind: "color", group: "colour" },
      { key: "colorC", label: "Core", kind: "color", group: "colour" },
      { key: "evolve", label: "Evolve", kind: "number", min: -1000, max: 1000, step: 0.01, bipolar: true, group: "motion", hint: "Key it to make the clouds change shape." },
      { key: "speed", label: "Speed", kind: "number", min: -4, max: 4, step: 0.01, bipolar: true, group: "motion", showIf: WHILE_MOVING },
      { key: "driftX", label: "Drift X", kind: "number", min: -100000, max: 100000, step: 1, unit: "px", bipolar: true, group: "motion", scaled: true },
      { key: "driftY", label: "Drift Y", kind: "number", min: -100000, max: 100000, step: 1, unit: "px", bipolar: true, group: "motion", scaled: true },
      seedField("motion"),
    ],
    toggles: [animateToggle("motion")],
    // Detail is the cost; the look survives losing its finest octaves.
    fidelity: [{ detail: 5 }, { detail: 4 }, { detail: 3 }],
    create: () => ({ id: createId("lfx"), type: "nebula", enabled: true, animate: false, scale: 620, detail: 6, warp: 1, coverage: 0.5, brightness: 1.4, colorA: "#2a1366", colorB: "#c23a78", colorC: "#ffd2a1", dust: 0.55, evolve: 0, speed: 0.04, driftX: 0, driftY: 0, seed: 1 }),
  },
];
