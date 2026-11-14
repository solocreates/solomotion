/**
 * HEX COLOUR MATH — parse, format, blend.
 *
 * A leaf on purpose: no imports. It used to live in `animation/properties.ts`,
 * which pulls in the whole property registry (world, rig, expressions); any
 * render-path module that only needed to read a colour imported that graph
 * and could close an init cycle (an effect importing it once left
 * `DEFAULT_FPS` read before initialisation and took the editor down).
 * `properties.ts` re-exports these, so existing callers are unchanged.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa. Returns null for anything else. */
export function parseHexColor(input: string): Rgba | null {
  const hex = input.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length === 3 || hex.length === 4) {
    const [r, g, b, a] = hex.split("").map((c) => parseInt(c + c, 16));
    return { r: r!, g: g!, b: b!, a: hex.length === 4 ? a! / 255 : 1 };
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  return null;
}

export function formatHexColor({ r, g, b, a }: Rgba): string {
  const to2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  const base = `#${to2(r)}${to2(g)}${to2(b)}`;
  return a >= 1 ? base : `${base}${to2(a * 255)}`;
}

/** Blend two colors; falls back to a hold when either side isn't parseable. */
export function lerpColor(from: string, to: string, t: number): string {
  const a = parseHexColor(from);
  const b = parseHexColor(to);
  if (!a || !b) return t < 1 ? from : to;
  return formatHexColor({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  });
}
