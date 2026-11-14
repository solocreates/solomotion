import { BUILT_IN_PRESETS } from "./presets";
import type { Theme } from "./schema";

/**
 * The presets a host offers. The package registers its own four; a product
 * registers its own looks on top (and may hide the built-ins), so the open
 * package never carries another product's name or colours.
 */
export interface PresetEntry {
  theme: Theme;
  /** One line under the swatch: when you would reach for it. */
  blurb: string;
  /** Grouping in a gallery ("Looks", "Colourways"…). */
  group?: string;
}

const entries = new Map<string, PresetEntry>();
const BLURBS: Record<string, string> = {
  solomotion: "Green on ink. The default.",
  "solo/motion": "The terminal. Monospace, square, numbered.",
  paper: "An open-source press. Light first.",
  hardware: "An instrument. Keycaps, rockers, steps.",
};
for (const t of BUILT_IN_PRESETS) entries.set(t.id, { theme: t, blurb: BLURBS[t.id] ?? "" });

export function registerPreset(entry: PresetEntry): void {
  entries.set(entry.theme.id, entry);
}

/** Remove presets from the gallery (a product that offers only its own). */
export function unregisterPresets(ids: readonly string[]): void {
  for (const id of ids) entries.delete(id);
}

export function listPresets(): PresetEntry[] {
  return [...entries.values()];
}

export function presetById(id: string): PresetEntry | undefined {
  return entries.get(id);
}
