/** Color math for the unified picker: hex ⇄ rgb ⇄ hsv, with alpha. */

export interface Hsva {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
  a: number; // 0..1
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(input: string): Rgba | null {
  const hex = input.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length === 3 || hex.length === 4) {
    const [r, g, b, a] = hex.split("").map((c) => parseInt(c + c, 16));
    return { r: r!, g: g!, b: b!, a: hex.length === 4 ? a! / 255 : 1 };
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  return null;
}

export function formatHex({ r, g, b, a }: Rgba): string {
  const to2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  const base = `#${to2(r)}${to2(g)}${to2(b)}`;
  return a >= 1 ? base : `${base}${to2(a * 255)}`;
}

export function rgbaToHsva({ r, g, b, a }: Rgba): Hsva {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max, a };
}

export function hsvaToRgba({ h, s, v, a }: Hsva): Rgba {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rn = 0;
  let gn = 0;
  let bn = 0;
  if (h < 60) [rn, gn, bn] = [c, x, 0];
  else if (h < 120) [rn, gn, bn] = [x, c, 0];
  else if (h < 180) [rn, gn, bn] = [0, c, x];
  else if (h < 240) [rn, gn, bn] = [0, x, c];
  else if (h < 300) [rn, gn, bn] = [x, 0, c];
  else [rn, gn, bn] = [c, 0, x];
  return { r: (rn + m) * 255, g: (gn + m) * 255, b: (bn + m) * 255, a };
}

export function hsvaToHex(hsva: Hsva): string {
  return formatHex(hsvaToRgba(hsva));
}

export function hexToHsva(hex: string): Hsva | null {
  const rgba = parseColor(hex);
  return rgba ? rgbaToHsva(rgba) : null;
}

/** CSS string for previews (checkerboard shows through alpha). */
export function toCss(color: string): string {
  const rgba = parseColor(color);
  if (!rgba) return color; // pass through css named colors etc.
  return `rgba(${Math.round(rgba.r)}, ${Math.round(rgba.g)}, ${Math.round(rgba.b)}, ${rgba.a.toFixed(3)})`;
}
