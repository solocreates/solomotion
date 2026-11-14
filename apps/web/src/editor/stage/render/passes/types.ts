"use client";

import type {
  FilmDamageParams,
  GlassParams,
  GrainParams,
  LightningParams,
  NoiseParams,
  ScanlineParams,
  SurfaceParams,
} from "@solomotion/core";

/**
 * WHAT A PASS IS — a finished description of ONE instant, in device pixels.
 *
 * Every field here has already been through the resolver in core: keyframes
 * sampled, colour variables looked up, modulators applied, px scaled by the
 * render scale, and (for the time-driven cards) the clock stepped. That is the
 * contract that makes preview, scrub, export and re-export the same pixels by
 * construction: nothing downstream of this type reaches for a clock, a random
 * number or a document.
 *
 * The union lives apart from the implementations on purpose. `draw-frame` needs
 * to NAME a pass to build the stage list, but the code that draws it is a lazy
 * chunk — so the type has to be importable without dragging the engine in.
 */
export type LfxPass =
  // ── Basics: cheap, near-universal, and the one family that stays eager ────
  | { kind: "vignette"; amount: number; softness: number; roundness: number; color: string }
  | { kind: "sharpen"; amount: number; radius: number }
  | { kind: "directionalBlur"; angle: number; distance: number }
  | { kind: "zoomBlur"; strength: number; cx: number; cy: number }
  | { kind: "spinBlur"; angle: number; cx: number; cy: number }
  | { kind: "innerShadow"; color: string; x: number; y: number; blur: number }
  | {
      kind: "glow";
      /** `auto` blooms the layer's own pixels; `solid` blooms in `color`. */
      mode: "auto" | "solid";
      color: string;
      size: number;
      intensity: number;
      saturation: number;
      brightness: number;
      inner: boolean;
      glowFalloff: "even" | "light";
    }
  | { kind: "stroke"; color: string; width: number; placement: "outside" | "center" | "inside"; softness: number }
  | { kind: "longShadow"; color: string; angle: number; length: number; fade: number }
  | { kind: "rgbSplit"; angle: number; distance: number }
  // ── Material: the only family that reads the scene BEHIND the layer ──────
  | { kind: "glass"; params: GlassParams }
  // ── Analog: everything on the temporal clock ─────────────────────────────
  | { kind: "grain"; params: GrainParams }
  | { kind: "filmDamage"; params: FilmDamageParams }
  | { kind: "scanlines"; params: ScanlineParams }
  | { kind: "noise"; params: NoiseParams }
  // ── Light & optics ───────────────────────────────────────────────────────
  | {
      kind: "shine";
      /** Sweep position in travel space; 0 is just off one side, 1 the other. */
      position: number;
      angle: number;
      width: number;
      softness: number;
      count: number;
      gap: number;
      falloff: number;
      color: string;
      intensity: number;
      bloom: number;
      blend: string;
      inside: boolean;
    }
  | {
      kind: "lightRays";
      cx: number;
      cy: number;
      length: number;
      intensity: number;
      decay: number;
      threshold: number;
      mode: "auto" | "solid";
      color: string;
      saturation: number;
      samples: number;
      blend: string;
      behind: boolean;
    }
  | {
      kind: "lensFlare";
      cx: number;
      cy: number;
      brightness: number;
      size: number;
      color: string;
      streak: number;
      streakColor: string;
      streakAngle: number;
      halo: number;
      ghosts: number;
      ghostSpread: number;
      ghostChroma: number;
      blend: string;
      inside: boolean;
    }
  // The arc geometry is resolved in core, like glass and the analog family —
  // the pass carries finished polylines and never rolls a die of its own.
  | { kind: "lightning"; params: LightningParams }
  // ── Distort ──────────────────────────────────────────────────────────────
  | { kind: "bulge"; cx: number; cy: number; radius: number; strength: number; softness: number; aspect: number; refract: number }
  | {
      kind: "wave";
      shape: "sine" | "triangle" | "square" | "noise";
      angle: number;
      wavelength: number;
      amplitude: number;
      phase: number;
      cross: number;
      anchor: number;
      seed: number;
    }
  | { kind: "twirl"; cx: number; cy: number; radius: number; angle: number; softness: number }
  | { kind: "lensDistort"; amount: number; cubic: number; chroma: number; scale: number; cx: number; cy: number }
  | { kind: "goo"; blur: number; threshold: number; softness: number; mix: number }
  | {
      kind: "boil";
      style: "boil" | "wobble" | "jitter";
      amount: number;
      scale: number;
      complexity: number;
      /** Which drawing of the loop this instant shows — already stepped. */
      drawing: number;
      seed: number;
      shake: number;
      rotate: number;
      mix: number;
    }
  | {
      kind: "roughenEdges";
      style: "rough" | "spiky" | "torn" | "melt" | "rusty";
      amount: number;
      scale: number;
      complexity: number;
      sharpness: number;
      /** The noise field's third axis at this instant — already stepped. */
      evolve: number;
      seed: number;
      color: string;
      tint: number;
    }
  | {
      kind: "glitch";
      mix: number;
      amount: number;
      blocks: number;
      displace: number;
      chroma: number;
      scramble: number;
      colorShift: number;
      direction: "horizontal" | "vertical" | "both";
      inside: boolean;
      /** The stepped clock state — the same bands hold for a whole gate open. */
      seed: number;
    }
  // ── Pattern & surface ────────────────────────────────────────────────────
  | {
      kind: "halftone";
      shape: "dot" | "line" | "square" | "cross" | "diamond";
      size: number;
      angle: number;
      softness: number;
      contrast: number;
      mode: "mono" | "duotone" | "color" | "cmyk" | "riso";
      inkColor: string;
      paperColor: string;
      jitter: number;
      spread: number;
      mix: number;
      invert: boolean;
      inside: boolean;
      /** Lay `paperColor` under the marks (always true in duotone and riso). */
      paper: boolean;
      /** Riso's second ink, and how far its drum lands off the first (device px). */
      ink2Color: string;
      misregister: number;
    }
  | { kind: "pixelate"; size: number; aspect: number; shape: "square" | "dot" | "diamond" | "cross"; gap: number; softness: number; mix: number; board: string }
  | {
      kind: "bevel";
      style: "inner" | "outer" | "pillow" | "emboss";
      depth: number;
      strength: number;
      angle: number;
      elevation: number;
      softness: number;
      highlightColor: string;
      highlightOpacity: number;
      shadowColor: string;
      shadowOpacity: number;
      highlightBlend: string;
      shadowBlend: string;
    }
  // ── Colour (the per-pixel remaps; the grading node has its own stage) ────
  | {
      kind: "gradientMap";
      shadowColor: string;
      midColor: string;
      highColor: string;
      midpoint: number;
      contrast: number;
      brightness: number;
      mix: number;
      invert: boolean;
    }
  | { kind: "posterize"; levels: number; dither: number; gamma: number; mix: number; luminanceOnly: boolean }
  | {
      kind: "overlay";
      mode: "solid" | "linear" | "radial" | "conic" | "image";
      /** `image` mode: the decoded picture, or null while it loads (draws nothing). */
      image: (CanvasImageSource & { width: number; height: number }) | null;
      colorA: string;
      colorB: string;
      angle: number;
      scale: number;
      offsetX: number;
      offsetY: number;
      midpoint: number;
      repeat: number;
      opacity: number;
      blend: string;
      mirror: boolean;
      inside: boolean;
    }
  // ── Depth: read a footage's depth maps through `PassEnv.depth` ───────────
  // Depth is 0 at the nearest thing in the shot, 1 at the farthest. `source`
  // is the footage layer whose depth is read ("" = this layer's own).
  | { kind: "fog"; source: string; color: string; density: number; start: number; end: number; mix: number }
  | { kind: "lensBlur"; source: string; focus: number; range: number; amount: number; mix: number }
  | { kind: "depthMatte"; source: string; depth: number; softness: number; invert: boolean }
  // ── Space: bend the backdrop as gravity does, or paint a sky ─────────────
  | { kind: "lens"; radius: number; strength: number; shadow: number; ring: number; ringWidth: number; ringColor: string; glow: number; reach: number }
  | { kind: "shockwave"; radius: number; width: number; strength: number; chroma: number; light: number; color: string }
  /** `time` is the boil's own clock × its speed, already stepped. */
  | { kind: "star"; temperature: number; brightness: number; granulation: number; contrast: number; limb: number; corona: number; coronaSize: number; time: number; seed: number }
  /** `step` is the twinkle's step now; `scale` is buffer px per document px (density is per document px). */
  | { kind: "starfield"; density: number; brightness: number; size: number; spectral: number; twinkle: number; step: number; spikes: number; spikeAngle: number; band: number; bandAngle: number; driftX: number; driftY: number; seed: number; scale: number }
  // ── Texture: the material, resolved in core like glass and the analog family
  | {
      kind: "surface";
      params: SurfaceParams;
      /**
       * A custom texture's decoded picture (`params.texture`), read by the
       * host; null while it decodes — the pass draws the material meanwhile.
       */
      texture?: (CanvasImageSource & { width: number; height: number }) | null;
    }
  /** `evolve` already carries its own-clock speed. */
  | { kind: "nebula"; scale: number; detail: number; warp: number; coverage: number; brightness: number; colorA: string; colorB: string; colorC: string; dust: number; evolve: number; driftX: number; driftY: number; seed: number };

export type LfxPassKind = LfxPass["kind"];

/**
 * A footage's DEPTH at a pixel of the pass's own buffer — 0 near, 1 far — or
 * null where the footage does not reach (or has no map yet). Built by the
 * draw from the buffer's transform, so a matte on a title reads the plate
 * beneath it exactly where the plate is.
 */
export type DepthSampler = (x: number, y: number) => number | null;

/**
 * What a pass may look at besides its own input image. Today: the BACKDROP —
 * everything painted beneath the layer, in the same device space. Only material
 * passes ask for it, and the draw path only pays for the snapshot when one is
 * in the stack (`passNeedsBackdrop`).
 */
export interface PassEnv {
  backdrop: CanvasImageSource | null;
  /** The depth of a footage layer (`""` = the layer being drawn), for the depth family. */
  depth?: (source: string) => DepthSampler | null;
  /**
   * The LIGHT PICTURE: the same pixels as the pass's input, holding only what
   * gives off light (layers marked `emitsLight`, their effects included). Made
   * before the chain runs, never by a pass (`lightPictureNow`).
   */
  lights?: CanvasImageSource | null;
}

/** Every pass implementation has this shape. One signature, one dispatch. */
export type PassFn<K extends LfxPassKind = LfxPassKind> = (
  pass: Extract<LfxPass, { kind: K }>,
  src: CanvasImageSource,
  w: number,
  h: number,
  env: PassEnv,
) => CanvasImageSource;

/** A lazily-imported family module: its kinds, keyed. */
export type PassModule = Partial<{ [K in LfxPassKind]: PassFn<K> }>;

/**
 * True when the pass reads the scene behind the layer — the precise, post-cull
 * question the buffer allocator asks (a noop or edge-only material must not
 * make the renderer render the whole scene beneath it).
 *
 * The CAPABILITY is declared once, in core, on the effect's type def
 * (`readsBackdrop`); `params.edgeOnly` is that declaration resolved for this
 * instance by the material brain. Nothing here decides it — this is the same
 * answer `layerEffectReadsBackdrop` gives, one resolution step later.
 */
export function passNeedsBackdrop(pass: LfxPass): boolean {
  return (pass.kind === "glass" && !pass.params.edgeOnly) || pass.kind === "lens" || pass.kind === "shockwave";
}
