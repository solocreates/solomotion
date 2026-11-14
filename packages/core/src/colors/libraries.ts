import { createId } from "../ids";
import type { MotionDocument, Paint, PatternKind, PatternSpec, Variable, VariableFolder } from "../schema";
import { defaultPatternSpec, gradientPaint, patternPaint, solidPaint, type GradientType } from "../schema/vector";
import { uniqueVariableName } from "../variables";

/**
 * PALETTE LIBRARIES — a named set of colours, gradients and patterns that
 * imports into a document as an ordinary folder of ordinary variables.
 *
 * That last clause is the entire design. A library is not a parallel system
 * with its own storage, its own picker, its own rename and its own export
 * format; it is a FOLDER (`variableFolder.source` records where it came from)
 * full of variables. So a palette colour keyframes, binds, modulates, renames,
 * counts its usages, drags into a personal folder and shows up in the picker's
 * rail because every one of those already works for variables. The day this
 * becomes a downloadable plugin, the plugin's job is to produce one of these
 * objects — nothing downstream of `importLibrary` has to learn anything.
 *
 * Libraries are DATA, defined once here, and each one derives its patterns from
 * the shared designs below rather than restating ten specs per palette. That is
 * why every library's patterns already look like they belong to its colours.
 */

export interface PaletteSwatch {
  name: string;
  value: string;
}

export interface PaletteGradient {
  name: string;
  type: GradientType;
  /** Stops as [offset, color] — terser than the id-carrying document shape,
   *  and ids are minted on import so two documents never share stop identity. */
  stops: Array<[number, string]>;
  /** Axis angle in degrees, 0 = left→right. Radial/angular read it as the sweep. */
  angleDeg?: number;
}

export interface PaletteLibrary {
  id: string;
  name: string;
  /** One line. What this palette is FOR, not what it contains. */
  blurb: string;
  /** The library's own identity colour — the folder chip and the card's wash. */
  accent: string;
  colors: PaletteSwatch[];
  gradients: PaletteGradient[];
  /** Which shared designs this library ships, and the two tones it wears them
   *  in. Omitted = the whole set in the library's first and last colour. */
  patterns?: Array<{ design: string; color: string; background: string }>;
}

/**
 * The ten pattern DESIGNS — form only, no colour.
 *
 * Colour is the library's contribution and form is the design's, so a palette
 * ships "Pinstripe" in its own two tones instead of carrying a tenth copy of
 * the numbers. Ten specs times seven libraries would have been seventy places
 * for a spacing to be wrong in one of them.
 */
export interface PatternDesign {
  id: string;
  name: string;
  spec: Partial<PatternSpec> & { kind: PatternKind };
}

export const PATTERN_DESIGNS: PatternDesign[] = [
  {
    id: "pinstripe",
    name: "Pinstripe",
    spec: { kind: "stripes", spacing: 14, thickness: 2, angleDeg: 90 },
  },
  {
    id: "awning",
    name: "Awning",
    spec: { kind: "stripes", spacing: 48, thickness: 24, angleDeg: 0 },
  },
  {
    id: "diagonal",
    name: "Diagonal",
    spec: { kind: "stripes", spacing: 18, thickness: 9, angleDeg: 45 },
  },
  {
    id: "halftone",
    name: "Halftone",
    spec: { kind: "dots", spacing: 22, thickness: 9, stagger: 0.5, angleDeg: 15 },
  },
  {
    id: "polka",
    name: "Polka",
    spec: { kind: "dots", spacing: 40, thickness: 12, stagger: 0.5, angleDeg: 0 },
  },
  {
    id: "graph",
    name: "Graph",
    spec: { kind: "grid", spacing: 24, thickness: 1, angleDeg: 0 },
  },
  {
    id: "checkerboard",
    name: "Checkerboard",
    spec: { kind: "checks", spacing: 36, angleDeg: 0 },
  },
  {
    id: "hatch",
    name: "Hatch",
    spec: { kind: "cross", spacing: 16, thickness: 1.5, angleDeg: 0 },
  },
  {
    id: "chevron",
    name: "Chevron",
    spec: { kind: "zigzag", spacing: 32, thickness: 6, amplitude: 20, angleDeg: 0, roundness: 1 },
  },
  {
    id: "swell",
    name: "Swell",
    spec: { kind: "waves", spacing: 60, thickness: 4, amplitude: 22, angleDeg: 0 },
  },
  {
    id: "scales",
    name: "Scales",
    spec: { kind: "triangles", spacing: 30, aspect: 0.8, angleDeg: 180 },
  },
  {
    id: "grain",
    name: "Grain",
    spec: { kind: "noise", spacing: 64, thickness: 2, amplitude: 0.55, seed: 7 },
  },
];

/** A design as a complete spec in two tones. One builder, so a preset card, an
 *  import and a "reset to the design" all produce the identical pattern. */
export function patternFromDesign(design: PatternDesign, color: string, background: string): PatternSpec {
  return { ...defaultPatternSpec(design.spec.kind), ...design.spec, color, background };
}

// ── The shipped libraries ────────────────────────────────────────────────────

const ATOM: PaletteLibrary = {
  id: "atom",
  name: "Atom",
  blurb: "The logo's gradient, flattened into a working palette.",
  accent: "#FF4E6A",
  colors: [
    { name: "Atom", value: "#FF4E6A" },
    { name: "Ember", value: "#FF8732" },
    { name: "Rose", value: "#FF87A0" },
    { name: "Plum", value: "#7A2E48" },
    { name: "Ink", value: "#08060A" },
    { name: "Slate", value: "#241C24" },
    { name: "Ash", value: "#8C818A" },
    { name: "Bone", value: "#F1EAEE" },
    { name: "Paper", value: "#FFFFFF" },
  ],
  gradients: [
    { name: "Logo", type: "linear", stops: [[0, "#FF8732"], [1, "#FF4E6A"]], angleDeg: 45 },
    { name: "Ember glow", type: "radial", stops: [[0, "#FF8732"], [1, "#7A2E4800"]] },
    { name: "Night", type: "linear", stops: [[0, "#241C24"], [1, "#08060A"]], angleDeg: 90 },
    { name: "Spin", type: "angular", stops: [[0, "#FF4E6A"], [0.5, "#FF8732"], [1, "#FF4E6A"]] },
  ],
};

const MATERIAL: PaletteLibrary = {
  id: "material",
  name: "Material",
  blurb: "Saturated primaries at a readable weight. Product UI.",
  accent: "#6750A4",
  colors: [
    { name: "Purple", value: "#6750A4" },
    { name: "Blue", value: "#1A73E8" },
    { name: "Teal", value: "#009688" },
    { name: "Green", value: "#188038" },
    { name: "Yellow", value: "#F9AB00" },
    { name: "Orange", value: "#E8710A" },
    { name: "Red", value: "#D93025" },
    { name: "Grey", value: "#5F6368" },
    { name: "Surface", value: "#FEF7FF" },
  ],
  gradients: [
    { name: "Primary", type: "linear", stops: [[0, "#6750A4"], [1, "#1A73E8"]], angleDeg: 45 },
    { name: "Warm", type: "linear", stops: [[0, "#F9AB00"], [1, "#D93025"]], angleDeg: 0 },
    { name: "Cool sweep", type: "angular", stops: [[0, "#1A73E8"], [0.5, "#009688"], [1, "#1A73E8"]] },
  ],
};

const IOS: PaletteLibrary = {
  id: "ios",
  name: "System",
  blurb: "Bright, high-contrast system hues. App chrome.",
  accent: "#0A84FF",
  colors: [
    { name: "Blue", value: "#0A84FF" },
    { name: "Indigo", value: "#5E5CE6" },
    { name: "Purple", value: "#BF5AF2" },
    { name: "Pink", value: "#FF375F" },
    { name: "Red", value: "#FF453A" },
    { name: "Orange", value: "#FF9F0A" },
    { name: "Yellow", value: "#FFD60A" },
    { name: "Green", value: "#30D158" },
    { name: "Teal", value: "#40C8E0" },
    { name: "Graphite", value: "#1C1C1E" },
  ],
  gradients: [
    { name: "Sunset", type: "linear", stops: [[0, "#FF9F0A"], [1, "#FF375F"]], angleDeg: 60 },
    { name: "Deep", type: "linear", stops: [[0, "#5E5CE6"], [1, "#0A84FF"]], angleDeg: 90 },
    { name: "Aurora", type: "angular", stops: [[0, "#30D158"], [0.35, "#40C8E0"], [0.7, "#BF5AF2"], [1, "#30D158"]] },
  ],
};

const NORD: PaletteLibrary = {
  id: "nord",
  name: "Arctic",
  blurb: "Desaturated blues and frost. Calm, long-session work.",
  accent: "#88C0D0",
  colors: [
    { name: "Night", value: "#2E3440" },
    { name: "Slate", value: "#3B4252" },
    { name: "Steel", value: "#4C566A" },
    { name: "Frost", value: "#88C0D0" },
    { name: "Ice", value: "#8FBCBB" },
    { name: "Sky", value: "#5E81AC" },
    { name: "Snow", value: "#ECEFF4" },
    { name: "Rust", value: "#BF616A" },
    { name: "Sand", value: "#EBCB8B" },
    { name: "Moss", value: "#A3BE8C" },
  ],
  gradients: [
    { name: "Glacier", type: "linear", stops: [[0, "#88C0D0"], [1, "#5E81AC"]], angleDeg: 45 },
    { name: "Dusk", type: "linear", stops: [[0, "#4C566A"], [1, "#2E3440"]], angleDeg: 90 },
    { name: "Thaw", type: "radial", stops: [[0, "#ECEFF4"], [1, "#8FBCBB00"]] },
  ],
};

const EDITORIAL: PaletteLibrary = {
  id: "editorial",
  name: "Editorial",
  blurb: "Warm paper, real ink, one accent. Typography first.",
  accent: "#C2410C",
  colors: [
    { name: "Ink", value: "#1B1917" },
    { name: "Graphite", value: "#44403C" },
    { name: "Pencil", value: "#78716C" },
    { name: "Newsprint", value: "#D6D3D1" },
    { name: "Paper", value: "#FAF8F5" },
    { name: "Terracotta", value: "#C2410C" },
    { name: "Ochre", value: "#B45309" },
    { name: "Olive", value: "#4D7C0F" },
    { name: "Oxblood", value: "#881337" },
  ],
  gradients: [
    { name: "Foxing", type: "linear", stops: [[0, "#FAF8F5"], [1, "#D6D3D1"]], angleDeg: 90 },
    { name: "Kiln", type: "linear", stops: [[0, "#B45309"], [1, "#881337"]], angleDeg: 30 },
    { name: "Vignette", type: "radial", stops: [[0, "#1B191700"], [1, "#1B1917"]] },
  ],
};

const NEON: PaletteLibrary = {
  id: "neon",
  name: "Neon",
  blurb: "Electric on black. Titles, stings, anything loud.",
  accent: "#00E5FF",
  colors: [
    { name: "Cyan", value: "#00E5FF" },
    { name: "Magenta", value: "#FF00E5" },
    { name: "Lime", value: "#B6FF00" },
    { name: "Violet", value: "#7B2BFF" },
    { name: "Hot", value: "#FF2D55" },
    { name: "Amber", value: "#FFB300" },
    { name: "Void", value: "#050308" },
    { name: "Smoke", value: "#1A1520" },
    { name: "Glare", value: "#FFFFFF" },
  ],
  gradients: [
    { name: "Vapor", type: "linear", stops: [[0, "#00E5FF"], [0.5, "#7B2BFF"], [1, "#FF00E5"]], angleDeg: 45 },
    { name: "Signal", type: "linear", stops: [[0, "#B6FF00"], [1, "#00E5FF"]], angleDeg: 0 },
    { name: "Halo", type: "radial", stops: [[0, "#FF00E5"], [1, "#05030800"]] },
    { name: "Rotor", type: "angular", stops: [[0, "#00E5FF"], [0.33, "#FF00E5"], [0.66, "#B6FF00"], [1, "#00E5FF"]] },
  ],
};

const BOTANIC: PaletteLibrary = {
  id: "botanic",
  name: "Botanic",
  blurb: "Leaf, bark and clay. Organic, unhurried.",
  accent: "#3F6212",
  colors: [
    { name: "Canopy", value: "#1A2E05" },
    { name: "Leaf", value: "#3F6212" },
    { name: "Sage", value: "#84A98C" },
    { name: "Lichen", value: "#CAD2C5" },
    { name: "Bark", value: "#52362B" },
    { name: "Clay", value: "#A9714B" },
    { name: "Sand", value: "#E7D8C9" },
    { name: "Sky", value: "#A8C7DA" },
    { name: "Bloom", value: "#D96C8A" },
  ],
  gradients: [
    { name: "Undergrowth", type: "linear", stops: [[0, "#3F6212"], [1, "#1A2E05"]], angleDeg: 90 },
    { name: "Clay bank", type: "linear", stops: [[0, "#E7D8C9"], [1, "#A9714B"]], angleDeg: 60 },
    { name: "Dapple", type: "radial", stops: [[0, "#CAD2C5"], [1, "#1A2E0500"]] },
  ],
};

/** Every shipped library, in the order the browser lists them. Atom first: it
 *  is the app's own identity and the sane default for a new document. */
export const PALETTE_LIBRARIES: PaletteLibrary[] = [ATOM, MATERIAL, IOS, NORD, EDITORIAL, NEON, BOTANIC];

export function paletteLibrary(id: string): PaletteLibrary | undefined {
  return PALETTE_LIBRARIES.find((l) => l.id === id);
}

/** The two tones a library wears its patterns in — its darkest and its lightest
 *  colour unless it says otherwise, which is what makes them read as a set. */
function patternTones(lib: PaletteLibrary): { color: string; background: string } {
  const first = lib.colors[0]?.value ?? "#1E1E1E";
  const last = lib.colors[lib.colors.length - 1]?.value ?? "#FFFFFF";
  return { color: luminance(first) < luminance(last) ? first : last, background: luminance(first) < luminance(last) ? last : first };
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  if (h.length < 6) return 0.5;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A library's patterns as complete specs — derived, never stored per palette. */
export function libraryPatterns(lib: PaletteLibrary): Array<{ name: string; spec: PatternSpec }> {
  const tones = patternTones(lib);
  if (lib.patterns) {
    return lib.patterns.flatMap((p) => {
      const design = PATTERN_DESIGNS.find((d) => d.id === p.design);
      return design ? [{ name: design.name, spec: patternFromDesign(design, p.color, p.background) }] : [];
    });
  }
  return PATTERN_DESIGNS.map((d) => ({ name: d.name, spec: patternFromDesign(d, tones.color, tones.background) }));
}

// ── Import ───────────────────────────────────────────────────────────────────

/** What a library contributes, as paints — the shape `importLibrary` files away
 *  and the picker's preset shelves render straight from. */
export interface LibraryEntry {
  name: string;
  paint: Paint;
  kind: "solid" | "gradient" | "pattern";
}

/** Every entry a library offers, in shelf order. Pure — the picker can render
 *  presets from a library the document has not imported. */
export function libraryEntries(lib: PaletteLibrary): LibraryEntry[] {
  return [
    ...lib.colors.map((c): LibraryEntry => ({ name: c.name, kind: "solid", paint: solidPaint(c.value) })),
    ...lib.gradients.map((g): LibraryEntry => ({ name: g.name, kind: "gradient", paint: gradientFrom(g) })),
    // NO PATTERNS. A palette contributes COLOUR; a pattern design contributes
    // FORM; and the two are independent, which is the whole reason
    // `PATTERN_DESIGNS` is stored without colours. Multiplying them out gave
    // every palette a tenth of a library's worth of pre-tinted patterns —
    // seventy generated entries whose only content was "this design, in these
    // two tones", and importing a palette minted a VARIABLE for each of them.
    //
    // They were unusable as variables, too: picking one bound the fill to a
    // style, and a bound fill is a link rather than a design, so the pattern
    // controls beneath it had nothing left to edit. The fix is not to make the
    // link editable — it is to stop pretending a tinted pattern is a shared
    // value. Pick a design, then colour it; the colour picker already has the
    // whole palette in it.
  ];
}

/** A palette gradient as a document gradient paint: ids minted, angle turned
 *  into the unified two-point geometry every gradient type shares. */
function gradientFrom(g: PaletteGradient): Paint {
  const rad = ((g.angleDeg ?? 0) * Math.PI) / 180;
  const hx = Math.cos(rad) / 2;
  const hy = Math.sin(rad) / 2;
  const geom =
    g.type === "linear"
      ? { start: { x: 0.5 - hx, y: 0.5 - hy }, end: { x: 0.5 + hx, y: 0.5 + hy } }
      : { start: { x: 0.5, y: 0.5 }, end: { x: 0.5 + hx * 2, y: 0.5 + hy * 2 } };
  return gradientPaint(
    g.type,
    g.stops.map(([offset, color]) => ({ id: createId("stop"), offset, color })),
    geom,
  );
}

/**
 * Import a library into a document: one folder, one paint variable per entry.
 *
 * Re-importing the SAME library updates the folder in place rather than making
 * a second copy — a palette you have already tinted should not fork the moment
 * you press the button again. Entries you renamed keep their names, because the
 * match is by id, and entries you deleted stay deleted for the same reason.
 */
export function importLibrary(doc: MotionDocument, libraryId: string): VariableFolder | null {
  const lib = paletteLibrary(libraryId);
  if (!lib) return null;

  let folder = doc.variableFolders.find((f) => f.source?.libraryId === libraryId);
  if (!folder) {
    folder = {
      id: createId("vfolder"),
      name: lib.name,
      parentId: null,
      accent: lib.accent,
      description: lib.blurb,
      source: { libraryId, version: 1 },
    };
    doc.variableFolders.push(folder);
  }

  const existing = new Set(doc.variables.filter((v) => v.folderId === folder!.id).map((v) => v.name.toLowerCase()));
  for (const entry of libraryEntries(lib)) {
    if (existing.has(entry.name.toLowerCase())) continue;
    const variable: Variable = {
      id: createId("var"),
      name: uniqueVariableName(doc, entry.name),
      type: "paint",
      value: entry.paint,
      folderId: folder.id,
    };
    doc.variables.push(variable);
  }
  return folder;
}
