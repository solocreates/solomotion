import { createId } from "../../ids";
import { mixField, type LayerEffectTypeDef } from "./shared";

/**
 * The depth family's cards: fog that thickens with distance, a lens that
 * focuses at a depth, and "behind" — a layer cut where the footage stands in
 * front of it. All read a depth tracker's maps; none does anything until the
 * footage has one (Track tab › Depth).
 */

const sourceField = {
  key: "source",
  label: "Depth of",
  kind: "layer" as const,
  empty: "This layer",
  hint: "The footage whose depth is read.",
};

export const DEPTH_EFFECT_TYPES: LayerEffectTypeDef[] = [
  {
    type: "fog",
    label: "Fog",
    blurb: "Haze that thickens with distance, from the footage's depth.",
    category: "light",
    tags: ["fog", "haze", "mist", "atmosphere", "depth", "aerial perspective", "smoke"],
    fields: [
      { key: "color", label: "Colour", kind: "color" },
      { key: "density", label: "Density", kind: "number", min: 0, max: 1, step: 0.01, hint: "How thick it gets at full depth." },
      { key: "start", label: "Starts", kind: "number", min: 0, max: 1, step: 0.01, hint: "The depth it begins at — 0 is the nearest thing in the shot, 1 the farthest." },
      { key: "end", label: "Full at", kind: "number", min: 0, max: 1, step: 0.01, hint: "The depth it is at full density." },
      sourceField,
      mixField(),
    ],
    create: () => ({ id: createId("lfx"), type: "fog", enabled: true, source: "", color: "#c8d0d9", density: 0.75, start: 0.25, end: 1, mix: 1 }),
  },
  {
    type: "lensBlur",
    label: "Lens blur",
    blurb: "Focus at a depth: what is nearer or farther goes soft, as a real lens would.",
    category: "blur",
    tags: ["lens blur", "depth of field", "dof", "bokeh", "focus", "rack focus", "tilt shift", "depth"],
    fields: [
      { key: "focus", label: "Focus", kind: "number", min: 0, max: 1, step: 0.005, hint: "The depth in focus — 0 the nearest thing, 1 the farthest. Key it to rack focus." },
      { key: "range", label: "Sharp", kind: "number", min: 0, max: 1, step: 0.005, hint: "How far either side of the focus stays sharp." },
      { key: "amount", label: "Blur", kind: "number", min: 0, max: 200, step: 0.5, unit: "px", hint: "The blur at the most out-of-focus depth." },
      sourceField,
      mixField(),
    ],
    create: () => ({ id: createId("lfx"), type: "lensBlur", enabled: true, source: "", focus: 0.15, range: 0.08, amount: 16, mix: 1 }),
  },
  {
    type: "depthMatte",
    carves: true,
    label: "Behind",
    blurb: "Puts this layer behind what stands in front of it in the footage.",
    category: "stylize",
    tags: ["occlusion", "behind", "depth matte", "z matte", "behind the subject", "depth", "matte", "cutout"],
    fields: [
      { ...sourceField, empty: "Pick the footage", hint: "The footage whose depth decides what is in front." },
      { key: "depth", label: "Depth", kind: "number", min: 0, max: 1, step: 0.005, hint: "How deep this layer stands in the shot: wherever the footage is nearer, it hides the layer." },
      { key: "softness", label: "Softness", kind: "number", min: 0, max: 0.5, step: 0.005, hint: "How soft the cut is." },
    ],
    toggles: [{ key: "invert", label: "In front only", hint: "Keep only where the footage is nearer — the layer shows through the subject." }],
    create: () => ({ id: createId("lfx"), type: "depthMatte", enabled: true, source: "", depth: 0.5, softness: 0.03, invert: false }),
  },
];
