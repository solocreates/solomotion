/**
 * THE FONT TABLE — the families a theme may name by id.
 *
 * Each one is loaded by the app that hosts the theme (`next/font`, self-hosted,
 * so the studio works offline) and published as a CSS variable. A theme names
 * the id; the stack below is what reaches `font-family`, ending in faces every
 * device has, so a family that has not loaded yet never falls back to
 * something ugly. A theme may also give a raw stack for a font it ships itself.
 *
 * The variable names are the contract with the host: an app that loads Geist
 * must publish it as `--font-geist`.
 */
export interface FontDef {
  id: string;
  label: string;
  /** The CSS variable the host publishes the loaded family under. Absent for
   *  families the platform already has. */
  cssVar?: string;
  fallback: string;
  kind: "sans" | "mono" | "display";
  /** Dot-matrix faces stop reading below this size, and give way to the
   *  theme's mono face there (see `--font-num-small`). */
  minPx?: number;
  /** OpenType features this family is tuned with at UI sizes. */
  features?: string;
  /**
   * How the family must be set to read as NUMERALS in a field. A dot-matrix
   * face at the body weight is a scatter of dust; it wants its heavy cut and a
   * little more size than the text beside it.
   */
  numerals?: { weight: number; scale: number };
}

const SANS = "ui-sans-serif, system-ui, sans-serif";
const MONO = "ui-monospace, 'SF Mono', monospace";

export const FONTS: FontDef[] = [
  { id: "geist", label: "Geist", cssVar: "--font-geist", fallback: SANS, kind: "sans" },
  // Inter's tuned alternates: a straight-tailed l and a clearer 1/i, which
  // matter at 11px in a column of numeric fields.
  { id: "inter", label: "Inter", cssVar: "--font-inter", fallback: SANS, kind: "sans", features: '"cv05" 1, "cv08" 1, "cv11" 1, "ss03" 1' },
  { id: "space-grotesk", label: "Space Grotesk", cssVar: "--font-space-grotesk", fallback: SANS, kind: "display" },
  { id: "geist-mono", label: "Geist Mono", cssVar: "--font-geist-mono", fallback: MONO, kind: "mono" },
  { id: "martian-mono", label: "Martian Mono", cssVar: "--font-martian-mono", fallback: MONO, kind: "mono" },
  { id: "ibm-plex-mono", label: "IBM Plex Mono", cssVar: "--font-ibm-plex-mono", fallback: MONO, kind: "mono" },
  { id: "jetbrains-mono", label: "JetBrains Mono", cssVar: "--font-jetbrains-mono", fallback: MONO, kind: "mono" },
  { id: "doto", label: "Doto", cssVar: "--font-doto", fallback: MONO, kind: "mono", minPx: 12, numerals: { weight: 800, scale: 1.18 } },
  { id: "system", label: "System UI", fallback: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", kind: "sans" },
  { id: "rounded", label: "Rounded", fallback: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', system-ui, sans-serif", kind: "sans" },
  { id: "serif", label: "Serif", fallback: "ui-serif, Georgia, 'Times New Roman', serif", kind: "sans" },
];

const byId = new Map(FONTS.map((f) => [f.id, f]));

export function fontDef(id: string): FontDef | undefined {
  return byId.get(id);
}

/** A theme's font value → a `font-family` stack. An unknown id is a raw stack. */
export function fontStack(idOrStack: string): string {
  const f = byId.get(idOrStack);
  if (!f) return idOrStack;
  return f.cssVar ? `var(${f.cssVar}), ${f.fallback}` : f.fallback;
}
