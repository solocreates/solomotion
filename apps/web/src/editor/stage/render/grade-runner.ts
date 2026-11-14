"use client";

import { combineMatte, invertMatte, refineMatte, writeQualifierMatte } from "@solomotion/core";
import { beginThumbPass, captureThumb, endThumbPass } from "./grade-thumbs";
import type { DeviceWindow, GradeProgram, GradeStep } from "./grade-stage";

/**
 * THE GRADE RUNNER — a register machine over canvases.
 *
 * It knows nothing about graphs, nodes or wires: the plan already turned those
 * into numbered slots and an order. So this is a loop, and that is the point —
 * the expensive thing in a grading pipeline is buffer traffic, and a loop with
 * an explicit slot table is the only shape where you can see all of it.
 *
 * Slots are pooled canvases, reused across frames. The plan's liveness pass
 * already keeps the count at the graph's true concurrency rather than one per
 * node, so a ten-node grade on a 4K plate holds three buffers instead of ten.
 */

interface Slot {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

const rgbPool: Slot[] = [];
const keyPool: Slot[] = [];
let matteScratch: Uint8ClampedArray | null = null;

function slot(pool: Slot[], i: number, w: number, h: number): Slot {
  let s = pool[i];
  if (!s) {
    const canvas = document.createElement("canvas");
    s = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true })! };
    pool[i] = s;
  }
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w;
    s.canvas.height = h;
  }
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.clearRect(0, 0, w, h);
  return s;
}

/**
 * Run a program over a source image. Returns the graded picture, or the source
 * unchanged when the program produced nothing usable — a grade that fails must
 * leave the shot alone rather than blank it.
 */
export function runGradeProgram(
  program: GradeProgram,
  src: CanvasImageSource,
  w: number,
  h: number,
  /**
   * Run one node's compiled effect stack. Injected rather than imported: the
   * executor lives in `draw-frame`, which already imports this module, and a
   * corrector must run the SAME one a layer does or the two would drift. The
   * result is handed to `consume` synchronously so the executor keeps its
   * buffer lifetimes — it pools them, and a canvas borrowed past the callback
   * would be somebody else's by the next step.
   */
  runStack: (stages: GradeStep["stages"], src: CanvasImageSource, consume: (img: CanvasImageSource) => void) => void,
): CanvasImageSource {
  if (w <= 0 || h <= 0) return src;

  // One gate, once per run. When nothing is showing thumbnails this is a
  // boolean read and the per-step calls below compile down to nothing.
  const capturing = beginThumbPass();
  let matteView: HTMLCanvasElement | null = null;

  for (const step of program.steps) {
    const out = slot(rgbPool, step.out, w, h);

    if (step.kind === "source") {
      out.ctx.drawImage(src, 0, 0, w, h);
      if (capturing) captureThumb(step.nodeId, out.canvas, w, h);
      continue;
    }

    if (step.kind === "mixer") {
      // `layer` composites its inputs in order honouring what each brought with
      // it; `parallel` averages them, which is what you want when two keys each
      // took part of the frame and neither should win where they overlap.
      const inputs = step.rgbIn.map((i) => rgbPool[i]?.canvas).filter(Boolean) as HTMLCanvasElement[];
      if (inputs.length === 0) continue;
      if (step.mix === "parallel") {
        out.ctx.globalAlpha = 1;
        out.ctx.drawImage(inputs[0]!, 0, 0);
        for (let i = 1; i < inputs.length; i++) {
          out.ctx.globalAlpha = 1 / (i + 1);
          out.ctx.drawImage(inputs[i]!, 0, 0);
        }
        out.ctx.globalAlpha = 1;
      } else {
        for (const c of inputs) out.ctx.drawImage(c, 0, 0);
      }
      if (capturing) captureThumb(step.nodeId, out.canvas, w, h);
      continue;
    }

    const base = rgbPool[step.rgbIn[0] ?? -1]?.canvas;
    if (!base) continue;

    if (step.kind === "output") {
      out.ctx.drawImage(base, 0, 0);
      if (capturing) captureThumb(step.nodeId, out.canvas, w, h);
      continue;
    }

    // ── A corrector ────────────────────────────────────────────────────────
    if (!step.enabled || (step.stages.length === 0 && step.keyOut == null)) {
      out.ctx.drawImage(base, 0, 0);
      if (capturing) captureThumb(step.nodeId, out.canvas, w, h);
      continue;
    }

    // The matte. Built into its own slot when anything downstream needs it, and
    // skipped entirely when the node selects everything — which is most nodes
    // in most grades and the single biggest saving here.
    let matte: Slot | null = null;
    if (step.key || step.keyIn != null) {
      matte = buildMatte(step, base, w, h);
      if (matte && program.matteOf === step.nodeId) matteView = matte.canvas;
    }

    // The node's corrected picture, landed in a scratch INSIDE the callback so
    // the executor's pooled buffers are still valid while we copy.
    const cut = slot(rgbPool, program.rgbSlots, w, h);
    if (step.stages.length > 0) {
      runStack(step.stages, base, (img) => cut.ctx.drawImage(img, 0, 0));
    } else {
      cut.ctx.drawImage(base, 0, 0);
    }
    if (matte) {
      // Punch the corrected picture through the matte, then lay the result over
      // the plate. Masking the OUTPUT instead would erase the pixels the node
      // did not select.
      cut.ctx.globalCompositeOperation = "destination-in";
      cut.ctx.drawImage(matte.canvas, 0, 0);
      cut.ctx.globalCompositeOperation = "source-over";
    }

    out.ctx.drawImage(base, 0, 0);
    out.ctx.globalAlpha = Math.max(0, Math.min(1, step.opacity));
    out.ctx.globalCompositeOperation = step.blend as GlobalCompositeOperation;
    out.ctx.drawImage(cut.canvas, 0, 0);
    out.ctx.globalAlpha = 1;
    out.ctx.globalCompositeOperation = "source-over";
    if (capturing) captureThumb(step.nodeId, out.canvas, w, h);
  }

  endThumbPass();

  // SHOW MATTE short-circuits the whole tail: you are inspecting a selection,
  // so neither the master mix nor the rest of the chain is what you asked to
  // look at. Drawn white-on-black rather than as alpha, because a matte read
  // against the checkerboard is unreadable exactly where it matters — the edge.
  if (matteView) {
    const view = slot(rgbPool, program.rgbSlots + 2, w, h);
    view.ctx.fillStyle = "#000";
    view.ctx.fillRect(0, 0, w, h);
    view.ctx.drawImage(matteView, 0, 0);
    return view.canvas;
  }

  const result = rgbPool[program.result]?.canvas;
  if (!result) return src;
  if (program.mix >= 1) return result;

  // Master wet/dry: the card's own mix, over the untouched plate.
  const wet = slot(rgbPool, program.rgbSlots + 1, w, h);
  wet.ctx.drawImage(src, 0, 0, w, h);
  wet.ctx.globalAlpha = program.mix;
  wet.ctx.drawImage(result, 0, 0);
  wet.ctx.globalAlpha = 1;
  return wet.canvas;
}

/**
 * Build the node's matte: the qualifier over the incoming picture, the windows
 * over it, the wired key folded in, then refinement and invert. The ORDER is
 * the model's (`grade/key.ts` does the maths); this only supplies pixels.
 */
function buildMatte(step: GradeStep, base: HTMLCanvasElement, w: number, h: number): Slot | null {
  const key = step.key;
  const dst = slot(keyPool, step.keyOut ?? 0, w, h);
  const size = w * h;
  const plane = new Uint8ClampedArray(size);

  if (key?.qualifier.enabled) {
    const px = base.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, w, h);
    if (px) writeQualifierMatte(px.data, plane, key.qualifier);
  } else {
    plane.fill(255);
  }

  if (key && key.windows.length > 0 && step.windows.length > 0) {
    const winPlane = rasterWindows(step.windows, w, h);
    if (winPlane) combineMatte(plane, winPlane, key.qualifier.enabled ? "intersect" : "replace");
  }

  if (step.keyIn != null && key) {
    const incoming = keyPool[step.keyIn];
    if (incoming) {
      const px = incoming.ctx.getImageData(0, 0, w, h).data;
      const inPlane = new Uint8ClampedArray(size);
      for (let i = 0, p = 0; p < size; i += 4, p++) inPlane[p] = px[i + 3]!;
      combineMatte(plane, inPlane, key.input);
    }
  }

  if (key) {
    matteScratch ??= new Uint8ClampedArray(size);
    if (matteScratch.length < size) matteScratch = new Uint8ClampedArray(size);
    refineMatte(plane, w, h, key.shrinkPx, key.blurPx, matteScratch);
    if (key.invert) invertMatte(plane);
  }

  // The matte becomes an ALPHA image — white where selected — because that is
  // what `destination-in` consumes and what a "show matte" view wants to draw.
  const img = dst.ctx.createImageData(w, h);
  for (let i = 0, p = 0; p < size; i += 4, p++) {
    img.data[i] = 255;
    img.data[i + 1] = 255;
    img.data[i + 2] = 255;
    img.data[i + 3] = plane[p]!;
  }
  dst.ctx.putImageData(img, 0, 0);
  return dst;
}

/** Fill the windows into a one-byte plane, honouring each one's combine mode. */
function rasterWindows(windows: DeviceWindow[], w: number, h: number): Uint8ClampedArray | null {
  const size = w * h;
  const acc = new Uint8ClampedArray(size);
  const scratch = slot(keyPool, 30, w, h); // a high slot: never a step's keyOut
  let any = false;

  for (const win of windows) {
    if (win.plane) {
      const plane = win.plane(w, h);
      if (win.invert) invertMatte(plane);
      if (!any) {
        acc.set(plane);
        any = true;
      } else combineMatte(acc, plane, win.combine);
      continue;
    }
    if (win.rings.length === 0) continue;
    scratch.ctx.setTransform(1, 0, 0, 1, 0, 0);
    scratch.ctx.clearRect(0, 0, w, h);
    scratch.ctx.fillStyle = "#fff";
    // Feather is a blur on the FILL, which is what makes a soft window soft all
    // the way round a concave shape — an inset outline only softens convexly.
    scratch.ctx.filter = win.featherPx > 0 ? `blur(${win.featherPx.toFixed(1)}px)` : "none";
    scratch.ctx.beginPath();
    for (const ring of win.rings) {
      if (ring.length < 3) continue;
      scratch.ctx.moveTo(ring[0]!.x, ring[0]!.y);
      for (let i = 1; i < ring.length; i++) scratch.ctx.lineTo(ring[i]!.x, ring[i]!.y);
      scratch.ctx.closePath();
    }
    if (win.expandPx !== 0) {
      scratch.ctx.lineWidth = Math.abs(win.expandPx) * 2;
      scratch.ctx.strokeStyle = "#fff";
      scratch.ctx.lineJoin = "round";
      if (win.expandPx > 0) scratch.ctx.stroke();
    }
    scratch.ctx.fill("evenodd");
    scratch.ctx.filter = "none";

    const px = scratch.ctx.getImageData(0, 0, w, h).data;
    const plane = new Uint8ClampedArray(size);
    for (let i = 0, p = 0; p < size; i += 4, p++) plane[p] = px[i + 3]!;
    if (win.invert) invertMatte(plane);
    if (!any) {
      acc.set(plane);
      any = true;
    } else {
      combineMatte(acc, plane, win.combine);
    }
  }
  return any ? acc : null;
}
