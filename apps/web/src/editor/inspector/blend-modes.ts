import type { BlendMode } from "@solomotion/core";

/**
 * Blend-mode menu — Figma's list, in Figma's order and grouping. Shared by the
 * layer composite row and every per-paint control so the vocabulary is written
 * once. The values are the core `BlendMode` enum; the renderer maps them to
 * canvas composite ops.
 */
export interface BlendOption {
  value: BlendMode;
  label: string;
}

export const BLEND_GROUPS: { label: string; options: BlendOption[] }[] = [
  { label: "", options: [{ value: "normal", label: "Normal" }] },
  {
    label: "Darken",
    options: [
      { value: "darken", label: "Darken" },
      { value: "multiply", label: "Multiply" },
      { value: "color-burn", label: "Color burn" },
    ],
  },
  {
    label: "Lighten",
    options: [
      { value: "lighten", label: "Lighten" },
      { value: "screen", label: "Screen" },
      { value: "color-dodge", label: "Color dodge" },
    ],
  },
  {
    label: "Contrast",
    options: [
      { value: "overlay", label: "Overlay" },
      { value: "soft-light", label: "Soft light" },
      { value: "hard-light", label: "Hard light" },
    ],
  },
  {
    label: "Inversion",
    options: [
      { value: "difference", label: "Difference" },
      { value: "exclusion", label: "Exclusion" },
    ],
  },
  {
    label: "Component",
    options: [
      { value: "hue", label: "Hue" },
      { value: "saturation", label: "Saturation" },
      { value: "color", label: "Color" },
      { value: "luminosity", label: "Luminosity" },
    ],
  },
];

const LABELS = new Map(BLEND_GROUPS.flatMap((g) => g.options).map((o) => [o.value, o.label]));
export function blendLabel(mode: BlendMode): string {
  return LABELS.get(mode) ?? "Normal";
}
