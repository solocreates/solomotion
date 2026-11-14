import type { ColorGradeEffect } from "../schema/layer-effects";

/**
 * Color-grade looks — headless preset registry. A preset is just a bundle of
 * grade parameters applied onto an existing Color grade card (base values;
 * keyframes still win), so every look stays fully editable and can be dialed
 * back with the card's Mix. `chip` is a two-stop gradient the UI renders as
 * the look's swatch.
 */

export type ColorGradeParamsPatch = Partial<
  Omit<ColorGradeEffect, "id" | "type" | "enabled">
>;

export interface ColorGradePreset {
  id: string;
  label: string;
  group: string;
  /** Two-stop swatch gradient [from, to] hinting the look. */
  chip: [string, string];
  params: ColorGradeParamsPatch;
}

export const COLOR_GRADE_PRESETS: ColorGradePreset[] = [
  // ── Cinematic ──────────────────────────────────────────────────────────────
  {
    id: "teal-orange",
    label: "Teal & Orange",
    group: "Cinematic",
    chip: ["#0e7a8a", "#e08a3c"],
    params: {
      liftR: -0.06, liftB: 0.07, gainR: 0.1, gainG: 0.02, gainB: -0.08,
      contrast: 1.08, saturation: 1.08, vibrance: 0.15,
    },
  },
  {
    id: "blockbuster",
    label: "Blockbuster",
    group: "Cinematic",
    chip: ["#123b52", "#d9a05b"],
    params: {
      temperature: 12, liftB: 0.1, liftR: -0.04, gammaM: -0.05,
      gainB: -0.06, contrast: 1.15, saturation: 1.05,
    },
  },
  {
    id: "bleach-bypass",
    label: "Bleach Bypass",
    group: "Cinematic",
    chip: ["#3a3d3f", "#cfd2ce"],
    params: { contrast: 1.35, saturation: 0.45, gammaM: 0.04, gainM: 0.05 },
  },
  {
    id: "noir",
    label: "Film Noir",
    group: "Cinematic",
    chip: ["#101012", "#b9bcc2"],
    params: { saturation: 0, contrast: 1.3, liftM: -0.06, gainM: 0.08 },
  },
  // ── Warm ───────────────────────────────────────────────────────────────────
  {
    id: "golden-hour",
    label: "Golden Hour",
    group: "Warm",
    chip: ["#8a4d1f", "#f2c078"],
    params: {
      temperature: 35, tint: 8, exposure: 0.15, gammaR: 0.05, gammaG: 0.02,
      liftB: -0.04, saturation: 1.08, vibrance: 0.1, contrast: 1.04,
    },
  },
  {
    id: "amber-fade",
    label: "Amber Fade",
    group: "Warm",
    chip: ["#6b4a2a", "#e8c9a0"],
    params: {
      temperature: 22, liftM: 0.08, liftR: 0.04, gainB: -0.05,
      contrast: 0.92, saturation: 0.92,
    },
  },
  {
    id: "candlelight",
    label: "Candlelight",
    group: "Warm",
    chip: ["#3d1f0e", "#e0913c"],
    params: {
      temperature: 45, exposure: -0.2, gammaM: -0.08, liftM: -0.05,
      gainR: 0.06, contrast: 1.1, vibrance: 0.08,
    },
  },
  // ── Cool ───────────────────────────────────────────────────────────────────
  {
    id: "arctic",
    label: "Arctic",
    group: "Cool",
    chip: ["#274a63", "#cfe6f2"],
    params: {
      temperature: -30, exposure: 0.1, liftB: 0.05, gainB: 0.04,
      saturation: 0.9, contrast: 1.05,
    },
  },
  {
    id: "moonlight",
    label: "Moonlight",
    group: "Cool",
    chip: ["#0d1b33", "#7d93c4"],
    params: {
      temperature: -22, exposure: -0.35, gammaB: 0.06, gammaM: -0.06,
      liftB: 0.06, saturation: 0.8, contrast: 1.12,
    },
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk",
    group: "Cool",
    chip: ["#0e0f3d", "#e044b0"],
    params: {
      liftB: 0.12, liftR: 0.03, gainR: 0.08, gainB: 0.06, gammaG: -0.05,
      contrast: 1.2, saturation: 1.25, vibrance: 0.2,
    },
  },
  // ── Vintage ────────────────────────────────────────────────────────────────
  {
    id: "faded-film",
    label: "Faded Film",
    group: "Vintage",
    chip: ["#4d4438", "#d9cbb2"],
    params: {
      liftM: 0.12, gainM: -0.06, contrast: 0.88, saturation: 0.85,
      temperature: 8, gammaR: 0.02,
    },
  },
  {
    id: "kodachrome",
    label: "Kodachrome",
    group: "Vintage",
    chip: ["#7a2c1c", "#e8d06a"],
    params: {
      contrast: 1.18, saturation: 1.15, temperature: 10, gainR: 0.06,
      gammaB: -0.04, liftM: -0.03, vibrance: 0.1,
    },
  },
  // ── Clean ──────────────────────────────────────────────────────────────────
  {
    id: "punch",
    label: "Punch",
    group: "Clean",
    chip: ["#1c2b1e", "#5fd068"],
    params: { contrast: 1.15, saturation: 1.1, vibrance: 0.25, gainM: 0.03 },
  },
  {
    id: "soft-matte",
    label: "Soft Matte",
    group: "Clean",
    chip: ["#3b3b40", "#c9c4bd"],
    params: { liftM: 0.1, contrast: 0.9, saturation: 0.95, vibrance: 0.08 },
  },
];
