import { shutterExposure, shutterSubsteps, velocityOffsetAt, type ShutterPlan } from "@solomotion/core";
import { beginIntegration } from "./integrator";

/**
 * THE RENDERER — a `ShutterPlan` becomes pixels.
 *
 * Everything above this file decided WHAT the shutter sees (`core/animation/
 * shutter.ts`) and HOW FAR the layer travelled (`core/animation/motion.ts`).
 * This one only knows how to integrate: accumulate the samples the plan names,
 * weighted, and composite the result once.
 *
 * ── Why the accumulation buffer is not optional ─────────────────────────────
 *
 * The obvious implementation — draw the layer N times straight onto the
 * composite at `globalAlpha = weight` — is wrong, and wrong in a way that looks
 * almost right, which is worse. Canvas compositing is sequential OVER, so N
 * draws give `cₙwₙ + cₙ₋₁wₙ₋₁(1-wₙ) + …`: the last sample dominates and the
 * smear has a hard bright end. A weighted SUM needs the samples added in a
 * buffer of their own, premultiplied colour AND alpha, which — because the
 * plan guarantees the weights sum to 1 — comes out as the exact weighted
 * average, and then composites onto the scene once, through the layer's real
 * blend mode. That buffer is the integrator's (`integrator.ts`): a FLOAT sum,
 * because an 8-bit one rounds each fractional sample and rings every soft edge.
 *
 * Swapping the combine is the whole difference between a physical average and
 * long-exposure light painting (core `shutterExposure`).
 *
 * ── The tiers ───────────────────────────────────────────────────────────────
 *
 * `velocity` and `transform` share this code path exactly. They differ only in
 * where each sample's placement comes from: a translation along the measured
 * vector, or the layer's real pose re-evaluated at that instant. That is the
 * cheap tier's actual saving — not fewer draws, but no keyframe sampling, no
 * modulator evaluation and no pose rebuild per step.
 *
 * `content` re-renders the layer per sample. It is the only tier that costs N
 * renders and the only one that catches change which is not a pose: typing
 * glyphs, a video's frames, an animating effect field.
 */

export interface ShutterScratch {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  busy: boolean;
}

export interface ShutterPaint {
  /** The composite being painted into. Its CTM is frame→device. */
  ctx: CanvasRenderingContext2D;
  /**
   * THE REGION the shutter integrates in: a buffer bounded by the layer and its
   * excursion, and `matrix`, which maps frame space into it.
   *
   * This used to be the composite canvas, and that made the STAGE part of the
   * render. A layer wider than the viewport was cut off at the viewport's edge
   * before it was smeared, so the shutter faithfully integrated a hard cut and
   * painted a blurred band down the middle of a shape whose real edge was a
   * screen away; and the buffer's pixel grid was the stage zoom, so the smear
   * you were judging was not the smear that would export. The region is the
   * layer's own, so neither the stage's edges nor its zoom reach the result.
   */
  region: { width: number; height: number; matrix: DOMMatrix };
  plan: ShutterPlan;
  /** Clip-local time of the frame itself — the crisp reference. */
  localMs: number;
  /**
   * Paint the finished layer (effects, feather, blend, in/out pose and all) at
   * one instant into a target whose CTM the caller has already aligned. This is
   * `withLayer`, handed over rather than imported, so this module never has to
   * know what a clip kind is — and so there is no import cycle with the 3,500
   * line renderer it is called from.
   */
  renderLayer: (target: CanvasRenderingContext2D, atLocalMs: number) => void;
  /**
   * The layer's local→FRAME affine at one instant, including its in/out pose.
   * Only the `transform` tier asks, and only per sample.
   */
  placementAt: (atLocalMs: number) => DOMMatrix;
  acquire: (w: number, h: number) => ShutterScratch;
}

/**
 * The placement at a fractional sample index: linear between the two evaluated
 * neighbours, carried on past the first and last (half a bin) along theirs.
 */
export function placementBetween(posed: readonly DOMMatrix[], at: number): DOMMatrix {
  if (posed.length === 1) return posed[0]!;
  const i = Math.min(posed.length - 2, Math.max(0, Math.floor(at)));
  const f = at - i;
  const a = posed[i]!;
  const b = posed[i + 1]!;
  const mix = (x: number, y: number) => x + (y - x) * f;
  return new DOMMatrix([mix(a.a, b.a), mix(a.b, b.b), mix(a.c, b.c), mix(a.d, b.d), mix(a.e, b.e), mix(a.f, b.f)]);
}

/**
 * Each sample's FRAME-space displacement of the banked picture: the layer's
 * real pose at the sample relative to the frame's (`transform`), or a straight
 * move along the measured vector (`velocity`). The `content` tier banks
 * nothing — every sample is rendered where it is — so it has none.
 *
 * One answer, asked by the painter below and by the region that sizes its
 * buffer (`shutterSeenRect`), so the region is never measured for a smear that
 * is not the one drawn.
 */
export function shutterDisplacements(plan: ShutterPlan, localMs: number, placementAt: (atLocalMs: number) => DOMMatrix): DOMMatrix[] {
  if (plan.tier === "content") return [];
  const base = plan.tier === "transform" ? placementAt(localMs) : null;
  const baseInv = base?.inverse() ?? null;
  return plan.samples.map((s) => {
    if (baseInv) return placementAt(s.timeMs).multiply(baseInv);
    // VELOCITY tier: a straight-line smear along the measured vector, taken
    // from `velocityOffsetAt` rather than recomputed here — the shutter
    // REGION is sized from that same function, and the instant the two
    // disagree the region is measured for a smear that is not the one
    // drawn, which shows up as a clipped end on the streak.
    const d = velocityOffsetAt(plan, s.timeMs, localMs);
    return new DOMMatrix().translate(d.x, d.y);
  });
}

/**
 * Integrate the layer across its open shutter and composite the result.
 *
 * The sum runs through the integrator (`integrator.ts`), never through
 * `lighter` at fractional alpha on an 8-bit buffer — that rounded every
 * sample before adding it and drew stepped, hue-shifted rings through every
 * soft edge that moved. How much of the crisp frame and of the smear the
 * result holds is core's `shutterExposure`, a lerp that conserves the frame's
 * light at every strength, so a blur fading in with speed never flashes a
 * semi-transparent layer brighter than it is.
 *
 * Returns false when the plan cannot be honoured (no buffer available), so the
 * caller can fall back to an ordinary single draw rather than dropping the
 * layer — a motion blur that fails must degrade to a sharp layer, never to a
 * missing one.
 */
export function paintShutter(p: ShutterPaint): boolean {
  const { ctx, plan } = p;
  // R is frame→REGION. Everything below integrates in region px; only the final
  // composite converts back to the canvas.
  const R = p.region.matrix;
  const w = p.region.width;
  const h = p.region.height;
  if (w <= 0 || h <= 0) return false;

  const exposure = shutterExposure(plan);

  // The layer is rendered ONCE for the two pose tiers and re-used per sample —
  // that is the whole reason `transform` costs one render instead of N. It is
  // also the crisp frame the exposure mixes back in.
  const single = plan.tier !== "content" ? p.acquire(w, h) : null;
  if (single) {
    single.ctx.save();
    single.ctx.setTransform(R);
    p.renderLayer(single.ctx, p.localMs);
    single.ctx.restore();
  }
  // Begun only now: the render above may integrate a child of its own (a
  // group's member with its own blur), and a pooled sum target must not be
  // shared across that nesting. The content tier's per-sample renders cannot
  // nest — it claims its subtree (`_inContentShutter`).
  const sum = beginIntegration(w, h, exposure.combine);
  if (single) {
    const Rinv = R.inverse();
    // A frame-space displacement has to be conjugated into the space of the
    // pixels we banked: R·D·R⁻¹. Applying D directly was the same class of
    // bug `withLayer` documents in its in/out pose — it would scale the
    // smear by the buffer's own scale, so the blur would grow with it and
    // the layer would drift off its own motion path.
    const posed = shutterDisplacements(plan, p.localMs, p.placementAt).map((D) => R.multiply(D).multiply(Rinv));
    // Each bin integrated whole (core `shutterSubsteps`): the banked picture
    // placed at sub-steps between the evaluated poses, so a capped plan on a
    // fast move is a streak and not a row of ghosts.
    const binPx = (plan.motionPx * plan.settings.amount * (Math.hypot(R.a, R.b) + Math.hypot(R.c, R.d))) / 2 / posed.length;
    sum.addPlacements(
      single.canvas,
      shutterSubsteps(exposure.weights, binPx, exposure.combine).map((step) => ({ weight: step.weight, place: placementBetween(posed, step.at) })),
    );
  } else {
    // CONTENT tier: the layer itself is a different picture at each instant.
    const shot = p.acquire(w, h);
    plan.samples.forEach((s, i) => {
      shot.ctx.setTransform(1, 0, 0, 1, 0, 0);
      shot.ctx.clearRect(0, 0, w, h);
      shot.ctx.save();
      shot.ctx.setTransform(R);
      p.renderLayer(shot.ctx, s.timeMs);
      shot.ctx.restore();
      sum.addPicture(shot.canvas, exposure.weights[i]!);
    });
    shot.busy = false;
  }

  // The crisp share fades out as the smear fades in. The content tier has no
  // banked render to reuse, so it makes one only when the share is non-zero.
  let crisp = single;
  if (!crisp && exposure.crisp > 0) {
    crisp = p.acquire(w, h);
    crisp.ctx.save();
    crisp.ctx.setTransform(R);
    p.renderLayer(crisp.ctx, p.localMs);
    crisp.ctx.restore();
  }

  ctx.save();
  // Region px → frame px → the canvas.
  const place = ctx.getTransform().multiply(R.inverse());
  ctx.setTransform(place.a, place.b, place.c, place.d, place.e, place.f);
  sum.resolveInto(ctx, crisp?.canvas ?? null, exposure);
  ctx.restore();

  if (crisp) crisp.busy = false;
  return true;
}
