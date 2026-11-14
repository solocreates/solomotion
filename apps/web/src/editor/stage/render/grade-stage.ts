"use client";

import {
  clipByIdIn,
  compileGrade,
  isVisualClip,
  gradePath,
  isNeutralKey,
  layerEffectPath,
  resolveWindows,
  invert as matInvert,
  nearnessAt,
  type ResolvedWindow,
  type GradeKey,
  type GradePlan,
  type KeyframeValue,
  type LayerEffect,
  type Modulator,
  type Contour,
  type MotionDocument,
} from "@solomotion/core";
import type { LfxStage } from "./draw-frame";

/**
 * COMPILING A GRADE GRAPH FOR THE RENDERER.
 *
 * The plan (`grade/plan.ts`) says WHAT runs in WHICH ORDER and into which slot.
 * This resolves each step's numbers at this instant — keyframes sampled,
 * modulators applied, colours looked up — and turns the geometry into device
 * pixels. The result is a `GradeProgram`: a flat list the runner executes with
 * no document, no clock and no graph knowledge, which is the same contract
 * every other pass here honours and the reason preview and export cannot
 * disagree.
 *
 * WINDOW SPACE IS THE LAYER, NOT THE FRAME. A window drawn on a clip should
 * move with the clip — that is what makes it a correction ON that shot rather
 * than a hole punched in the viewport. So contours are stored centred on the
 * layer's own box in natural pixels, and become device pixels by scaling about
 * the buffer's centre. A tracked window maps the same way, through the tracked
 * clip's own source dimensions rather than through its pose: the pose is
 * already carried by the buffer the grade is running inside.
 */

/** Frame-scoped facts the stage builder cannot reach from its own arguments. */
export interface GradeFrameEnv {
  /** The document being drawn — tracked windows read their tracker through it. */
  doc: MotionDocument;
}

let frameEnv: GradeFrameEnv | null = null;

/**
 * What the Color page wants to SEE, as opposed to what the document says.
 *
 * Published by the page rather than read from its store, so the dependency runs
 * editor/color → stage/render and never back. It is view state in the most
 * literal sense: which node's matte you are inspecting changes the picture on
 * the canvas and changes nothing in the file.
 */
let preview: { matteOf: string | null } = { matteOf: null };

const previewListeners = new Set<() => void>();

export function setGradePreview(next: { matteOf: string | null }): void {
  if (preview.matteOf === next.matteOf) return;
  preview = next;
  // The picture changes without the document changing, so the stage's own
  // dirty flag will never fire — the same contract a lazily-loaded pass uses
  // when its chunk lands.
  for (const fn of previewListeners) fn();
}

/** Repaint when what the page wants to SEE changes. */
export function onGradePreviewChange(cb: () => void): () => void {
  previewListeners.add(cb);
  return () => previewListeners.delete(cb);
}

/**
 * Publish the frame's document facts. Ambient rather than threaded because the
 * alternative is four new parameters on five functions that have nothing to do
 * with colour — and it is honest ambient state: set once per `drawFrame`, read
 * only during that synchronous walk, never retained.
 */
export function setGradeFrameEnv(env: GradeFrameEnv | null): void {
  frameEnv = env;
}

/** One window, flattened into device-space polygons. */
export interface DeviceWindow {
  rings: Array<Array<{ x: number; y: number }>>;
  /** A raster matte instead of rings (a depth band): 0..255 per device pixel. */
  plane?: (w: number, h: number) => Uint8ClampedArray;
  featherPx: number;
  expandPx: number;
  invert: boolean;
  combine: "union" | "intersect" | "subtract";
}

export interface GradeStep {
  nodeId: string;
  out: number;
  rgbIn: number[];
  keyIn: number | null;
  keyOut: number | null;
  kind: "source" | "corrector" | "mixer" | "output";
  enabled: boolean;
  /**
   * The node's OWN effect stack, compiled. Not "the colour grades in it" — the
   * whole list, so a blur, a glow, a gradient map or a halftone inside a
   * corrector does exactly what it does on a layer. The first draft read only
   * `colorGrade` cards, which made every other effect a control that changed
   * nothing and looked broken.
   */
  stages: LfxStage[];
  /** Null when the node selects everything (the fast path). */
  key: GradeKey | null;
  windows: DeviceWindow[];
  blend: string;
  opacity: number;
  mix: "layer" | "parallel";
}

export interface GradeProgram {
  steps: GradeStep[];
  rgbSlots: number;
  keySlots: number;
  result: number;
  /** Master wet/dry from the card. */
  mix: number;
  /**
   * Draw this node's MATTE instead of the picture. A key you cannot see is a
   * key you tune by guessing, and every grading application has this switch for
   * that reason. Null in an export — it is an inspection mode, not a look.
   */
  matteOf: string | null;
}

/** Does this compiled stack actually paint anything different? */
function hasWork(stages: LfxStage[]): boolean {
  return stages.some((st) =>
    st.kind === "css" ? st.ops.length > 0 || st.shadow != null : true,
  );
}

const BLEND_NAMES: Record<string, string> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  "hard-light": "hard-light",
  "soft-light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

/**
 * Resolve a `grade` card into a program, or null when it would be a no-op —
 * which is the common case for a card somebody added and has not dialled yet,
 * and skipping it entirely is worth more than any amount of shader tuning.
 */
export function resolveGradeProgram(
  card: Extract<LayerEffect, { type: "grade" }>,
  sampled: Record<string, KeyframeValue>,
  /**
   * Compile one node's effect list, addressed through the grade path grammar.
   * Injected by `draw-frame` rather than imported, because the compiler lives
   * there and importing it here would close a cycle — this module is already
   * one of its dependencies.
   */
  buildStages: (effects: LayerEffect[], pathOf: (id: string, field: string) => string) => LfxStage[],
  resolveColor: (c: string) => string,
  scale: number,
  timeSec: number,
  modulators: readonly Modulator[] | undefined,
  /** The buffer's size in device px, and where the layer's centre sits in it. */
  device: { width: number; height: number; cx: number; cy: number },
  /** Clip-local time, for tracked windows. */
  localMs: number,
  /** The clip being graded — a tracker on it maps through its own source size. */
  clipId: string,
): GradeProgram | null {
  const plan: GradePlan = compileGrade(card.graph);
  if (plan.steps.length === 0) return null;

  const steps: GradeStep[] = [];
  let anyWork = false;

  for (const step of plan.steps) {
    const node = step.node;
    const corrector = node.kind === "corrector" ? node : null;
    const enabled = readBool(sampled, layerEffectPath(card.id, gradePath.node(node.id, "enabled")), node.enabled);

    const stages =
      corrector && enabled && corrector.effects.length > 0
        ? buildStages(corrector.effects, (fxId, field) =>
            layerEffectPath(card.id, gradePath.effect(node.id, fxId, field)),
          )
        : [];

    // The previewed node needs a matte even when its key is neutral, or
    // "show matte" on a node that selects everything would show nothing.
    const inspecting = preview.matteOf === node.id;
    const key = corrector && enabled && (inspecting || !isNeutralKey(corrector.key)) ? corrector.key : null;
    const windows = key ? deviceWindows(corrector!.key, scale, device, localMs, clipId) : [];
    const opacity = readNumber(sampled, layerEffectPath(card.id, gradePath.node(node.id, "opacity")), corrector?.opacity ?? 1);

    if (hasWork(stages) || inspecting) anyWork = true;

    steps.push({
      nodeId: node.id,
      out: step.out,
      rgbIn: step.rgbIn,
      keyIn: step.keyIn,
      keyOut: step.keyOut,
      kind: node.kind,
      enabled,
      stages,
      key,
      windows,
      blend: BLEND_NAMES[corrector?.blend ?? "normal"] ?? "source-over",
      opacity,
      mix: node.kind === "mixer" ? node.mix : "layer",
    });
  }

  const mix = readNumber(sampled, layerEffectPath(card.id, "mix"), card.mix);
  if (!anyWork || mix <= 0) return null;
  const matteOf = plan.steps.some((s) => s.nodeId === preview.matteOf) ? preview.matteOf : null;
  return { steps, rgbSlots: plan.rgbSlots, keySlots: plan.keySlots, result: plan.result, mix, matteOf };
}

/** The node's windows, flattened to device-space rings. */
function deviceWindows(
  key: GradeKey,
  scale: number,
  device: { width: number; height: number; cx: number; cy: number },
  localMs: number,
  clipId: string,
): DeviceWindow[] {
  const doc = frameEnv?.doc;
  const clip = doc ? clipByIdIn(doc, clipId) : undefined;
  // A tracked window is drawn in THIS layer's own space, inside its buffer —
  // core reads the tracker through the layer's time map and content transform.
  const resolved = resolveWindows(key, { doc: doc ?? null, clip: clip && isVisualClip(clip) ? clip : null, localMs });

  return resolved.map((w) => ({
    rings: w.contours.map((c) => flatten(c).map((p) => ({ x: device.cx + p.x * scale, y: device.cy + p.y * scale }))),
    ...(w.depth && { plane: depthPlane(w.depth, scale, device) }),
    featherPx: w.feather * scale,
    expandPx: w.expand * scale,
    invert: w.invert,
    combine: w.combine,
  }));
}

/**
 * A depth band as a matte over this buffer: each device pixel back to the
 * layer's local space, then to the footage's source px (its content transform
 * inverted), then the band's soft ramp on the map's depth there.
 */
function depthPlane(d: NonNullable<ResolvedWindow["depth"]>, scale: number, device: { cx: number; cy: number }): (w: number, h: number) => Uint8ClampedArray {
  return (w, h) => {
    const out = new Uint8ClampedArray(w * h);
    const inv = matInvert(d.toLocal);
    if (!inv) return out;
    const s = Math.max(1e-4, d.softness);
    const ramp = (v: number, a: number) => {
      const t = Math.min(1, Math.max(0, (v - (a - s)) / (2 * s)));
      return t * t * (3 - 2 * t);
    };
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const lx = (x + 0.5 - device.cx) / scale;
        const ly = (y + 0.5 - device.cy) / scale;
        const u = (inv.a * lx + inv.c * ly + inv.e) / d.sourceWidth;
        const v = (inv.b * lx + inv.d * ly + inv.f) / d.sourceHeight;
        if (u < 0 || v < 0 || u > 1 || v > 1) continue;
        const z = 1 - nearnessAt(d.frame, u, v);
        out[y * w + x] = Math.round(255 * ramp(z, d.near) * (1 - ramp(z, d.far)));
      }
    return out;
  };
}

/** Contour → polyline. Cubics are subdivided at a fixed step; a matte edge is
 *  about to be feathered by several pixels, so precision past that is wasted. */
function flatten(c: Contour): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const pts = c.points;
  if (pts.length === 0) return out;
  const segs = c.closed ? pts.length : pts.length - 1;
  out.push({ x: pts[0]!.x, y: pts[0]!.y });
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if (!a.hOut && !b.hIn) {
      out.push({ x: b.x, y: b.y });
      continue;
    }
    const c1 = a.hOut ?? a;
    const c2 = b.hIn ?? b;
    const STEPS = 12;
    for (let s = 1; s <= STEPS; s++) {
      const t = s / STEPS;
      const u = 1 - t;
      out.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      });
    }
  }
  return out;
}

function readNumber(sampled: Record<string, KeyframeValue>, path: string, fallback: number): number {
  const v = sampled[path];
  return typeof v === "number" ? v : fallback;
}

function readBool(sampled: Record<string, KeyframeValue>, path: string, fallback: boolean): boolean {
  const v = sampled[path];
  return typeof v === "boolean" ? v : fallback;
}
