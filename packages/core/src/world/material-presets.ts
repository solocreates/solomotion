import type { Material } from "../schema/world";
import type { VisualClip } from "../schema";
import { solidPaint } from "../schema/vector";
import { layerMaterial } from "./body";

/**
 * MATERIAL PRESETS — looks as data. A preset sets the surface response and,
 * where the look depends on it (gold, neon), the base colour; picking one is a
 * single undo step and every field stays editable after. The picker, the API
 * catalog and the agent skill all read this list.
 */
export interface MaterialPreset {
  id: string;
  label: string;
  /** The base colour (written to the layer's top fill), or null to keep the current one. */
  color: string | null;
  material: Partial<Material>;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  { id: "plastic", label: "Glossy plastic", color: null, material: { model: "pbr", roughness: 0.25, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.1, transmission: 0, sheen: 0, iridescence: 0, emissionStrength: 1, emission: "#000000" } },
  { id: "matte", label: "Matte", color: null, material: { model: "pbr", roughness: 0.85, metalness: 0, clearcoat: 0, transmission: 0, sheen: 0, iridescence: 0, emission: "#000000" } },
  { id: "clay", label: "Clay", color: "#c9a48a", material: { model: "pbr", roughness: 0.95, metalness: 0, clearcoat: 0, transmission: 0, sheen: 0.2, iridescence: 0, emission: "#000000" } },
  { id: "ceramic", label: "Ceramic", color: "#f2f0ea", material: { model: "pbr", roughness: 0.15, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, transmission: 0, sheen: 0, iridescence: 0, emission: "#000000" } },
  { id: "rubber", label: "Rubber", color: "#2a2a2c", material: { model: "pbr", roughness: 0.75, metalness: 0, clearcoat: 0, transmission: 0, sheen: 0.4, iridescence: 0, emission: "#000000" } },
  { id: "metal", label: "Brushed metal", color: "#b8bcc4", material: { model: "pbr", roughness: 0.35, metalness: 1, clearcoat: 0, transmission: 0, sheen: 0, iridescence: 0, emission: "#000000" } },
  { id: "chrome", label: "Chrome", color: "#e8ebf0", material: { model: "pbr", roughness: 0.04, metalness: 1, clearcoat: 0, transmission: 0, sheen: 0, iridescence: 0, emission: "#000000" } },
  { id: "gold", label: "Gold", color: "#f5c46b", material: { model: "pbr", roughness: 0.18, metalness: 1, clearcoat: 0, transmission: 0, sheen: 0, iridescence: 0, emission: "#000000" } },
  { id: "copper", label: "Copper", color: "#e0916b", material: { model: "pbr", roughness: 0.25, metalness: 1, clearcoat: 0, transmission: 0, sheen: 0, iridescence: 0, emission: "#000000" } },
  { id: "carpaint", label: "Car paint", color: "#c4202f", material: { model: "pbr", roughness: 0.45, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.03, transmission: 0, sheen: 0, iridescence: 0, emission: "#000000" } },
  { id: "glass", label: "Glass", color: "#ffffff", material: { model: "pbr", roughness: 0.02, metalness: 0, transmission: 1, ior: 1.5, thickness: 20, clearcoat: 0, sheen: 0, iridescence: 0, emission: "#000000" } },
  { id: "frosted", label: "Frosted glass", color: "#ffffff", material: { model: "pbr", roughness: 0.4, metalness: 0, transmission: 1, ior: 1.5, thickness: 20, clearcoat: 0, sheen: 0, iridescence: 0, emission: "#000000" } },
  { id: "velvet", label: "Velvet", color: "#5b2a86", material: { model: "pbr", roughness: 0.9, metalness: 0, sheen: 1, clearcoat: 0, transmission: 0, iridescence: 0, emission: "#000000" } },
  { id: "pearl", label: "Pearl", color: "#f4efe8", material: { model: "pbr", roughness: 0.2, metalness: 0.1, iridescence: 1, clearcoat: 0.6, transmission: 0, sheen: 0, emission: "#000000" } },
  { id: "neon", label: "Neon", color: "#ff2fb1", material: { model: "pbr", roughness: 0.4, metalness: 0, emission: "#ff2fb1", emissionStrength: 4, clearcoat: 0, transmission: 0, sheen: 0, iridescence: 0 } },
  { id: "toon", label: "Toon", color: null, material: { model: "toon", toonSteps: 3, emission: "#000000" } },
  { id: "flat", label: "Flat colour", color: null, material: { model: "unlit" } },
];

export function materialPreset(id: string): MaterialPreset | undefined {
  return MATERIAL_PRESETS.find((p) => p.id === id);
}

/** Kinds whose colour IS their fills — a picture's colour is its pixels, and a preset leaves them be. */
const COLOURED_BY_FILLS: ReadonlySet<string> = new Set(["mesh", "text", "shape", "path"]);

/**
 * Put a preset on anything with a surface — a mesh or a 2D layer in a world:
 * the response always, the colour where the layer's colour is a fill (gold
 * letters are gold; a gold photo is still the photo, lit like metal).
 */
export function applyMaterialPreset(clip: VisualClip, preset: MaterialPreset): void {
  clip.material = { ...layerMaterial(clip), ...preset.material, preset: preset.id };
  if (!preset.color || !COLOURED_BY_FILLS.has(clip.kind)) return;
  // A path drawn by its stroke alone (a line, an orbit, a tube in a world) is
  // coloured by that stroke: pushing a fill turned a neon loop into a filled
  // disc. Recolour the stroke it is made of instead.
  const visibleFill = clip.fills.some((f) => f.enabled !== false);
  const stroke = "strokes" in clip ? clip.strokes?.[clip.strokes.length - 1] : undefined;
  if (clip.kind === "path" && !visibleFill && stroke) {
    if (stroke.paint.type === "solid") stroke.paint.color = preset.color;
    return;
  }
  const top = clip.fills[clip.fills.length - 1];
  if (top && top.type === "solid") top.color = preset.color;
  else clip.fills.push(solidPaint(preset.color));
}
