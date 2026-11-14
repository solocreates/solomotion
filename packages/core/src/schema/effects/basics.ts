import { z } from "zod";

import { layerEffectBase } from "./shared";

/**
 * The cards every layer wants and most documents carry: shadows, blur, glow,
 * stroke, the quick colour block, the two motion blurs, vignette and sharpen.
 *
 * They share one property that earns them a file of their own: each is a few
 * lines of canvas work with no engine behind it, so this family's renderer is
 * the one that stays EAGER in the editor bundle. Everything heavier is a lazy
 * chunk (see `stage/render/passes/registry.ts`).
 */
export const BASIC_EFFECT_ARMS = [
  z.object({
    ...layerEffectBase,
    type: z.literal("shadow"),
    color: z.string(),
    x: z.number(),
    y: z.number(),
    blur: z.number().min(0),
  }),
  /**
   * A LOOK — the parent of the cards that name it in `group`. It paints
   * nothing itself: the renderer runs its members in order over the layer as
   * it arrives, then crossfades that result with the arriving layer by `mix`
   * (`lfx.<id>.mix` keyframes like any field). `look` is the library entry it
   * was made from, so the gallery can light the look a group is wearing.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("group"),
    name: z.string().default("Look"),
    look: z.string().optional(),
    mix: z.number().min(0).max(1).default(1),
  }),
  z.object({
    ...layerEffectBase,
    type: z.literal("blur"),
    radius: z.number().min(0),
  }),
  // Inner shadow — a shadow cast INSIDE the silhouette (recessed / letterpress).
  // Built as a pixel pass: the layer's own alpha is the stencil, so it hugs any
  // shape (a star recesses as a star). x/y/blur keyframe via `lfx.<id>.*`.
  z.object({
    ...layerEffectBase,
    type: z.literal("innerShadow"),
    color: z.string(),
    x: z.number(),
    y: z.number(),
    blur: z.number().min(0),
  }),
  /**
   * Glow — a bloom around (outer) or inside (inner) the silhouette. ONE effect
   * covers the whole family: `inner` flips which side, `intensity` is the bloom
   * strength and `size` the spread, and it composites additively so stacked
   * glows read like neon.
   *
   * `mode` is the field that makes it honest. A glow is not a colour you pick —
   * it is LIGHT LEAVING THE LAYER, and the light a thing emits is the colour it
   * already is. So the default is `auto`: the layer's own pixels, blurred and
   * pushed, which means a multicoloured logo blooms in its own colours, a
   * gradient glows as a gradient, and a recoloured layer's glow follows without
   * anyone remembering to update it. `solid` is the override for when you want
   * a specific light (a sign's neon tube is one colour whatever it illuminates),
   * and only then does `color` do anything.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("glow"),
    /** `auto` blooms the layer's own colours; `solid` blooms in `color`. */
    mode: z.enum(["auto", "solid"]).default("auto"),
    /** The bloom colour — `solid` mode only. */
    color: z.string().default("#4cc3e0"),
    /** Bloom spread in px. */
    size: z.number().min(0).default(24),
    /** Bloom strength. Above 1 the bloom stacks into a blown-out neon core. */
    intensity: z.number().min(0).max(3).default(0.8),
    /** AUTO only — how far the bloom pushes the layer's own colours. */
    saturation: z.number().min(0).max(4).default(1.6),
    /** AUTO only — how much the bloom lifts them. */
    brightness: z.number().min(0).max(4).default(1.1),
    /** Glow inside the silhouette instead of around it. */
    inner: z.boolean().default(false),
    /**
     * How the light falls off (v108). `even` is one Gaussian of radius `size`:
     * a soft, uniform halo, right for a big shape. `light` is a lens bloom —
     * the same light blurred at size/8, /4, /2 and /1 and summed core-heavy,
     * so it falls off like real light: a hot core that hugs the source and a
     * faint wide tail. A small bright thing (a star, a spark, a dot) under
     * `even` spreads its few pixels over the whole radius and all but
     * vanishes — and at 1–3/255 the 8-bit blur bands into rings; under
     * `light` most of its energy stays near it, where it is seen.
     */
    glowFalloff: z.enum(["even", "light"]).default("even"),
  }),
  /**
   * Stroke — an outline traced around the layer's own silhouette (v54).
   *
   * It used to be a per-GLYPH text effect, which meant it existed only on text
   * and drew a separate ring around every letter. As a silhouette pass it is
   * the same picture for text — the glyphs ARE the silhouette — and it now
   * works on a shape, a path, an image cut-out or a nested comp, which is what
   * an outline was always supposed to mean.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("stroke"),
    color: z.string().default("#000000"),
    /** Outline thickness in px. */
    width: z.number().min(0).max(200).default(4),
    /** Which side of the edge the outline occupies. */
    /** Which side of the edge the outline sits (v85: was `position`, which Shine owns). */
    placement: z.enum(["outside", "center", "inside"]).default("outside"),
    /** 0 = a crisp cut, 1 = a feathered edge that reads as a halo. */
    softness: z.number().min(0).max(1).default(0),
  }),
  /**
   * Long shadow — the flat-design solid trail cast off the silhouette (v54).
   * Also promoted from the per-glyph text stack; as a silhouette pass one trail
   * leaves the whole layer instead of one per letter, which is what makes the
   * classic poster look read as a single light source.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("longShadow"),
    color: z.string().default("#00000055"),
    /** Trail direction in degrees (45 = down-right). */
    angle: z.number().min(-180).max(180).default(45),
    /** Trail length in px. */
    length: z.number().min(0).max(2000).default(120),
    /** 0 = a solid slab, 1 = fades to nothing at the far end. */
    fade: z.number().min(0).max(1).default(0.35),
  }),
  // RGB split (chromatic aberration) — offsets the red and blue channels apart
  // along an angle, leaving green fixed. The 2026 glitch / lens-fringe look.
  z.object({
    ...layerEffectBase,
    type: z.literal("rgbSplit"),
    /** Split direction in degrees (0 = horizontal). */
    angle: z.number().min(-180).max(180).default(0),
    /** Channel separation in px. */
    distance: z.number().min(0).max(200).default(6),
  }),
  z.object({
    ...layerEffectBase,
    type: z.literal("adjust"),
    brightness: z.number().min(0).default(1),
    contrast: z.number().min(0).default(1),
    saturate: z.number().min(0).default(1),
    hueDeg: z.number().default(0),
    grayscale: z.number().min(0).max(1).default(0),
    sepia: z.number().min(0).max(1).default(0),
  }),
  // Vignette — a photographic edge darken (or lighten). Multiplies the layer by
  // a radial falloff fitted to the frame; every field keyframes via `lfx.<id>.*`.
  z.object({
    ...layerEffectBase,
    type: z.literal("vignette"),
    /** Edge darkness (0 = none, 1 = full black corners). Negative brightens. */
    amount: z.number().min(-1).max(1).default(0.4),
    /** Falloff spread — how far in from the corners the darkening reaches. */
    softness: z.number().min(0).max(1).default(0.5),
    /** 0 = ellipse matching the frame, 1 = round. */
    roundness: z.number().min(0).max(1).default(0.5),
    /** Vignette color (usually black); `var:` tokens allowed like any color. */
    color: z.string().default("#000000"),
  }),
  // Sharpen — unsharp mask (blur a copy, add back the high-frequency detail).
  z.object({
    ...layerEffectBase,
    type: z.literal("sharpen"),
    /** Detail boost; 0 = off, 1 = normal, up to 4 = heavy. */
    amount: z.number().min(0).max(4).default(1),
    /** Detail radius in px — larger = coarser edges enhanced. */
    radius: z.number().min(0.3).max(12).default(2),
  }),
  // Directional (motion) blur — smears the layer along an angle. Accumulation
  // blur (a running average of shifted copies), so it works on any layer kind.
  z.object({
    ...layerEffectBase,
    type: z.literal("directionalBlur"),
    /** Smear direction in degrees (0 = horizontal). */
    angle: z.number().min(-180).max(180).default(0),
    /** Smear length in px. */
    distance: z.number().min(0).max(200).default(20),
  }),
  // Zoom blur — radial blur from a center point (dolly / speed-in look).
  z.object({
    ...layerEffectBase,
    type: z.literal("zoomBlur"),
    /** Blur strength (0 = off). */
    strength: z.number().min(0).max(1).default(0.3),
    /** Center X as a fraction of half-width (−1..1, 0 = middle). */
    centerX: z.number().min(-1).max(1).default(0),
    /** Center Y as a fraction of half-height (−1..1, 0 = middle). */
    centerY: z.number().min(-1).max(1).default(0),
  }),
  /**
   * Spin blur — zoom blur's other half. Where zoom blur smears along rays out
   * of a centre, this one smears along the circles around it: a wheel turning,
   * a record, a radial wipe's edge.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("spinBlur"),
    /** Smear arc in degrees. */
    angle: z.number().min(0).max(180).default(12),
    /** Centre X as a fraction of half-width (−1..1, 0 = middle). */
    centerX: z.number().min(-1).max(1).default(0),
    /** Centre Y as a fraction of half-height (−1..1, 0 = middle). */
    centerY: z.number().min(-1).max(1).default(0),
  }),
] as const;
