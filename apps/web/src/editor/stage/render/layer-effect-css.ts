import type { LayerEffect } from "@solomotion/core";

/**
 * A LAYER EFFECT STACK, IN CSS — the one translation, for every DOM surface
 * that has to stand in for the canvas.
 *
 * There were two: the inline text editor's and the library preview card's. They
 * disagreed with each other and both disagreed with the renderer, and the
 * disagreement was visible — a stroked look was one weight on the stage, a
 * lighter one on its preview card, and a third when you double-clicked into it.
 * Which is the whole complaint: "why is the unfocused text so much bolder".
 *
 * THE STROKE IS THE ONE THAT MATTERS AND IT IS EASY TO GET WRONG. The canvas
 * draws an OUTSIDE stroke: `width` px of outline sitting entirely outside the
 * silhouette. `-webkit-text-stroke` is CENTRED — half in, half out — so it
 * needs DOUBLE the width to cover the same ground, and it needs
 * `paint-order: stroke fill` or the inner half paints over the glyph and eats
 * it. One copy doubled without the paint order, the other set the paint order
 * without doubling; each was half right, so neither matched.
 *
 * Returns kebab-case declaration pairs — the two callers need a style string
 * and a React style object respectively, and a pair list converts to either
 * without a second list of property names to keep in step.
 */
export function layerEffectDecls(
  effects: readonly LayerEffect[],
  resolve: (c: string) => string,
): Array<[string, string]> {
  const shadows: string[] = [];
  const filters: string[] = [];
  const out: Array<[string, string]> = [];

  for (const e of effects) {
    if (!e.enabled) continue;
    switch (e.type) {
      case "stroke": {
        if (e.width <= 0) break;
        // `inside` has no CSS equivalent at all — a centred stroke at the
        // declared width is the closest thing that does not change the glyph's
        // outer silhouette, which is what `inside` promises.
        const width = e.placement === "outside" ? e.width * 2 : e.width;
        out.push(["-webkit-text-stroke", `${width}px ${resolve(e.color)}`]);
        out.push(["paint-order", "stroke fill"]);
        break;
      }
      case "shadow":
        shadows.push(`${e.x}px ${e.y}px ${e.blur}px ${resolve(e.color)}`);
        break;
      case "glow":
        // `auto` blooms the layer's own pixels, which CSS cannot sample. The
        // layer's own colour is the closest honest stand-in, and it is what the
        // bloom is made of anyway.
        if (!e.inner) {
          const c = e.mode === "solid" ? resolve(e.color) : "currentColor";
          // `light` hugs the source: a tight core under the wide halo.
          if (e.glowFalloff === "light") shadows.push(`0 0 ${e.size / 6}px ${c}`);
          shadows.push(`0 0 ${e.size}px ${c}`);
        }
        break;
      case "blur":
        if (e.radius > 0) filters.push(`blur(${e.radius}px)`);
        break;
      case "longShadow": {
        const rad = (e.angle * Math.PI) / 180;
        filters.push(
          `drop-shadow(${(Math.cos(rad) * e.length * 0.5).toFixed(0)}px ${(Math.sin(rad) * e.length * 0.5).toFixed(0)}px 0 ${resolve(e.color)})`,
        );
        break;
      }
      case "rgbSplit": {
        const rad = (e.angle * Math.PI) / 180;
        const x = Math.cos(rad) * e.distance;
        const y = Math.sin(rad) * e.distance;
        filters.push(
          `drop-shadow(${x.toFixed(1)}px ${y.toFixed(1)}px 0 rgba(255,0,60,0.55))`,
          `drop-shadow(${(-x).toFixed(1)}px ${(-y).toFixed(1)}px 0 rgba(0,200,255,0.55))`,
        );
        break;
      }
      default:
        // Per-pixel passes (grain, scanlines, noise, grading, glass) have no
        // honest CSS stand-in. Nothing beats something wrong: a fake texture
        // teaches the eye a look the render will not produce.
        break;
    }
  }

  if (shadows.length) out.push(["text-shadow", shadows.join(", ")]);
  if (filters.length) out.push(["filter", filters.join(" ")]);
  return out;
}

/** The stack as an inline-style string (the editor builds HTML). */
export function layerEffectCssText(
  effects: readonly LayerEffect[],
  resolve: (c: string) => string,
): string {
  return layerEffectDecls(effects, resolve)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

/** The stack as a React style object (the preview card renders JSX). */
export function layerEffectStyle(
  effects: readonly LayerEffect[],
  resolve: (c: string) => string = (c) => c,
): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const [k, v] of layerEffectDecls(effects, resolve)) {
    // React passes any hyphenated key straight through to the CSS declaration,
    // which is exactly what the vendor-prefixed and `paint-order` entries need.
    style[k] = v;
  }
  return style as React.CSSProperties;
}
