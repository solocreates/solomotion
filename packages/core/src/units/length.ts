import type { Clip } from "../schema";
import { LENGTH_UNITS, type Length, type LengthSpec, type LengthUnit } from "../schema/units";
import { propertyDef } from "../animation/properties";

/**
 * RELATIONAL LENGTHS — the maths of `schema/units.ts`, pure.
 *
 * A field's number is written in its unit (`clip.units[path]`); this file says
 * how many comp px one of that unit is, for one layer, in one render. The bake
 * (`units/resolve.ts`) is the only caller that writes the answer back, so the
 * renderer, bounds, hit tests, layout, the SVG exporter and the inspector all
 * read plain px and never learn units exist.
 */

/** Which way a length runs: across, down, or neither (a stroke, a radius, a font). */
export type LengthAxis = "x" | "y" | "d";

/** Output px per px of one space, per axis — `d` is the area scale √|det|. */
export interface ScreenScale {
  x: number;
  y: number;
  d: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * EVERYTHING A LENGTH CAN BE RELATIVE TO, for one layer in one render.
 * `screen` maps the layer's OWN local px to output px (its scale, its groups',
 * every nest above); `parentScreen` stops short of the layer's own scale —
 * what a placement (`x`, `y`) is measured in.
 */
export interface LengthFrame {
  comp: Size;
  parent: Size;
  output: Size;
  screen: ScreenScale;
  parentScreen: ScreenScale;
}

/**
 * WHERE A COMP IS SEEN — output px per comp px, and the output frame's size.
 * The renderer knows it (the root is `{ scale: 1 }` over itself; a nest
 * multiplies in its layer's scale); a reader with no render in hand (the
 * inspector, a headless verb) passes none and the comp is its own output.
 */
export interface LengthView {
  /** Output px per comp px across (and down, when `scaleY` differs). */
  scale: number;
  scaleY?: number;
  width: number;
  height: number;
}

export const LENGTH_UNIT_META: Record<LengthUnit, { label: string; screen: boolean; describe: string }> = {
  px: { label: "px", screen: false, describe: "Comp pixels — scales with everything above it." },
  spx: { label: "spx", screen: true, describe: "Screen pixels — the same size on the output at any zoom or scale." },
  fw: { label: "fw", screen: false, describe: "1% of the comp's width." },
  fh: { label: "fh", screen: false, describe: "1% of the comp's height." },
  vw: { label: "vw", screen: true, describe: "1% of the output's width, at any zoom." },
  vh: { label: "vh", screen: true, describe: "1% of the output's height, at any zoom." },
  vmin: { label: "vmin", screen: true, describe: "1% of the output's shorter side, at any zoom." },
  vmax: { label: "vmax", screen: true, describe: "1% of the output's longer side, at any zoom." },
  "%": { label: "%", screen: false, describe: "Percent of the parent — its auto-layout box, else the comp — along the field's axis." },
};

export function isLengthUnit(v: unknown): v is LengthUnit {
  return typeof v === "string" && (LENGTH_UNITS as readonly string[]).includes(v);
}

/** Does the value stay put on screen (so it depends on how the comp is seen)? */
export function isScreenUnit(unit: LengthUnit): boolean {
  return LENGTH_UNIT_META[unit].screen;
}

/** A layer's fields that sit in its PARENT's space rather than its own. */
const PLACEMENT: ReadonlySet<string> = new Set(["x", "y", "z", "layout.x", "layout.y"]);

const PAINT_OR_EFFECT = /^(fill|stroke|lfx|tfx|afx|grade|mod|force|emit|bhv)\./;
const X_END = /^(x|offsetX|width|maxWidth|left|right|letterSpacing|padding\.left|padding\.right)$/;
const Y_END = /^(y|offsetY|height|maxHeight|top|bottom|padding\.top|padding\.bottom)$/;

/**
 * THE AXIS A FIELD RUNS ALONG — what `fw` vs `fh` means nothing to, and what
 * `%` and the screen units need. By the field's own name (the last segment, or
 * the padding pair), so an effect's `offsetX` is across with nothing declared;
 * a layout gap runs along its flow. Everything else is `d`: SVG's rule for a
 * length with no direction, √((w² + h²) / 2) of the box.
 */
export function lengthAxisOf(clip: Clip, path: string): LengthAxis {
  if (path === "layout.gap" || path === "layout.lineGap") {
    const flow = clip.kind === "group" ? clip.layout?.flow : undefined;
    const across = flow === "column" ? path === "layout.lineGap" : path === "layout.gap";
    return flow ? (across ? "x" : "y") : "d";
  }
  const tail = /padding\.(left|right|top|bottom)$/.exec(path)?.[0] ?? path.slice(path.lastIndexOf(".") + 1);
  // Inside a paint or an effect a `width` is a thickness, not an extent: only
  // a named offset runs along an axis there.
  if (PAINT_OR_EFFECT.test(path)) return /^(x|offsetX|dx)$/.test(tail) ? "x" : /^(y|offsetY|dy)$/.test(tail) ? "y" : "d";
  if (X_END.test(tail) || path === "content.x" || path === "crop.left" || path === "crop.right") return "x";
  if (Y_END.test(tail) || path === "content.y" || path === "crop.top" || path === "crop.bottom") return "y";
  return "d";
}

/** May this field be written in a relational unit? (`AnimatablePropertyDef.length`.) */
export function isLengthPath(path: string): boolean {
  return propertyDef(path)?.length === true;
}

const diag = (s: Size) => Math.sqrt((s.width * s.width + s.height * s.height) / 2);
const along = (s: Size, axis: LengthAxis) => (axis === "x" ? s.width : axis === "y" ? s.height : diag(s));

/**
 * HOW MANY OF THE FIELD'S OWN PX ONE `unit` IS. Comp-relative units are sizes
 * of the container; screen units are an output length divided back through
 * every scale to the field's space. A degenerate scale (a layer at 0) keeps the
 * number as px rather than dividing by zero.
 */
export function pxPerUnit(unit: LengthUnit, axis: LengthAxis, frame: LengthFrame, path: string): number {
  switch (unit) {
    case "px":
      return 1;
    case "fw":
      return frame.comp.width / 100;
    case "fh":
      return frame.comp.height / 100;
    case "%":
      return along(frame.parent, axis) / 100;
    default: {
      const screen = PLACEMENT.has(path) ? frame.parentScreen : frame.screen;
      const s = screen[axis];
      if (!(s > 1e-12) || !Number.isFinite(s)) return 1;
      const o = frame.output;
      const outPx = unit === "spx" ? 1 : unit === "vw" ? o.width / 100 : unit === "vh" ? o.height / 100 : unit === "vmin" ? Math.min(o.width, o.height) / 100 : Math.max(o.width, o.height) / 100;
      return outPx / s;
    }
  }
}

// ── Text form ────────────────────────────────────────────────────────────────

const LENGTH_TEXT = /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(px|spx|fw|fh|vw|vh|vmin|vmax|%)?\s*$/i;

/**
 * `"2spx"`, `"50 %"`, `"-3.5fw"`, `"12"` (px) → value + unit; null if it is not
 * a length.
 */
export function parseLength(text: string): Length | null {
  const m = LENGTH_TEXT.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: (m[2]?.toLowerCase() ?? "px") as LengthUnit };
}

/**
 * A FIELD WRITTEN AS TEXT — a length, or CSS's bounded forms around one:
 * `clamp(1spx, 0.2fw, 6spx)`, `max(1spx, 0.2fw)` (never under 1 spx),
 * `min(0.2fw, 6spx)` (never over 6). What `layer.set`, `keyframes.set` and the
 * inspector's field all accept. `bounds` is absent for a bare length (the
 * field keeps the bounds it has) and present for a bounded form (it replaces
 * them).
 */
export function parseLengthSpec(text: string): { value: number; unit: LengthUnit; bounds?: Pick<LengthSpec, "min" | "max"> } | null {
  const m = /^\s*(clamp|min|max)\s*\((.*)\)\s*$/i.exec(text);
  if (!m) {
    const len = parseLength(text);
    return len ? { value: len.value, unit: len.unit } : null;
  }
  const parts = m[2]!.split(",").map(parseLength);
  if (parts.some((p) => !p)) return null;
  const [a, b, c] = parts as Length[];
  switch (m[1]!.toLowerCase()) {
    case "clamp":
      return parts.length === 3 ? { value: b!.value, unit: b!.unit, bounds: { min: a, max: c } } : null;
    case "max": // max(floor, value): never under the floor
      return parts.length === 2 ? { value: b!.value, unit: b!.unit, bounds: { min: a } } : null;
    default: // min(value, ceiling): never over the ceiling
      return parts.length === 2 ? { value: a!.value, unit: a!.unit, bounds: { max: b } } : null;
  }
}

export function formatLength(value: number, unit: LengthUnit): string {
  const n = Math.abs(value) >= 100 ? Math.round(value * 100) / 100 : Math.round(value * 10000) / 10000;
  return `${n}${unit}`;
}

/** A field as text: `2spx`, or `clamp(1spx, 0.2fw, 6spx)` when bounded. */
export function formatLengthSpec(value: number, spec: LengthSpec | undefined): string {
  const v = formatLength(value, spec?.unit ?? "px");
  if (!spec?.min && !spec?.max) return v;
  const f = (l: Length) => formatLength(l.value, l.unit);
  if (spec.min && spec.max) return `clamp(${f(spec.min)}, ${v}, ${f(spec.max)})`;
  return spec.min ? `max(${f(spec.min)}, ${v})` : `min(${v}, ${f(spec.max!)})`;
}

/** The unit a clip's field is written in — px when none is set. */
export function unitOf(clip: Clip, path: string): LengthUnit {
  return clip.units?.[path]?.unit ?? "px";
}
