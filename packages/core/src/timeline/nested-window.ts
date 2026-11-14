import type { Frame, NestedClip } from "../schema";

/**
 * DOES A NESTED CLIP SHOW ITS COMP THROUGH A WINDOW — cropped to the comp's box?
 *
 * One answer for every renderer path (stage, comp-picture store, export, hit
 * rects). The clip says so itself when it can: `clipContent` true/false is the
 * "Clip content" switch on the nested layer. Left `null` (Auto) the comp
 * decides by what it IS:
 *
 *   - `overflow: 0` — the comp crops its own content; its window crops too;
 *   - `overflow: 1` — a precompose, drawing, SVG or mouth that must never crop;
 *   - otherwise a comp with a VISIBLE box (a background or a fill) is a SCENE
 *     and windows, and a TRANSPARENT comp is a PART (a logo, a character, a
 *     cursor) whose box nobody can see — cropping it cut a shockwave into a
 *     square at an edge that is not there.
 *
 * Before this, windowing read `overflow < 1` alone, so every new comp
 * (default 0.25 — a stage SPILL preview, a different question) cropped when
 * nested and there was no switch on the clip to say otherwise.
 */
export function nestedClipsContent(clip: Pick<NestedClip, "clipContent">, source: Pick<Frame, "overflow" | "background" | "fills">): boolean {
  if (clip.clipContent != null) return clip.clipContent;
  if (source.overflow <= 0) return true;
  if (source.overflow >= 1) return false;
  return frameHasVisibleBox(source);
}

/** Does the comp paint its own box — a background, or any live fill? */
export function frameHasVisibleBox(frame: Pick<Frame, "background" | "fills">): boolean {
  if (frame.fills.length > 0) {
    return frame.fills.some((f) => f.enabled !== false && f.opacity > 0.001 && !(f.type === "solid" && isTransparentColor(f.color)));
  }
  return !isTransparentColor(frame.background);
}

/**
 * DOES THE COMP PAINT AN OPAQUE PAPER under everything it holds — a solid,
 * normal-blend fill at full opacity (or, with no fills, an opaque background)?
 *
 * Then nothing inside it can reach what lies beneath it in a parent: every
 * blend mode is a W3C blend, and over a backdrop of alpha 1 the result is
 * opaque and made of the comp's own pixels alone. Seen through a window
 * (`nestedClipsContent`) such a comp is one picture whatever blends inside it.
 * Conservative where it cannot read the colour (a variable, a gradient): no.
 */
export function frameHasOpaquePaper(frame: Pick<Frame, "background" | "fills">): boolean {
  if (frame.fills.length > 0) {
    return frame.fills.some(
      (f) => f.enabled !== false && f.opacity >= 0.999 && f.blendMode === "normal" && f.type === "solid" && isOpaqueColor(f.color),
    );
  }
  return isOpaqueColor(frame.background);
}

/** `#RGB`, `#RRGGBB`, `#RGBF`, `#RRGGBBFF`, or rgb()/hsl() without a partial alpha. Anything else: not known to be opaque. */
export function isOpaqueColor(c: string): boolean {
  const v = c.trim().toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) return true;
  if (/^#[0-9a-f]{8}$/.test(v)) return v.slice(7) === "ff";
  if (/^#[0-9a-f]{4}$/.test(v)) return v[4] === "f";
  const m = /^(rgb|hsl)a?\(([^)]*)\)$/.exec(v);
  if (!m) return false;
  const parts = m[2]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length === 3) return true;
  if (parts.length !== 4) return false;
  const a = parts[3]!;
  return a.endsWith("%") ? parseFloat(a) >= 100 : parseFloat(a) >= 1;
}

/** `#RRGGBB00`, `#RGB0`, `transparent`, or an rgba()/hsla() with alpha 0. */
export function isTransparentColor(c: string): boolean {
  const v = c.trim().toLowerCase();
  if (v === "transparent") return true;
  if (/^#[0-9a-f]{8}$/.test(v)) return v.slice(7) === "00";
  if (/^#[0-9a-f]{4}$/.test(v)) return v[4] === "0";
  const m = /^(?:rgba|hsla)\(.*,\s*([\d.]+%?)\s*\)$/.exec(v);
  return !!m && parseFloat(m[1]!) === 0;
}
