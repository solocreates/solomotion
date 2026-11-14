import { z } from "zod";

/**
 * TRACE (v109) — the path a point has drawn over the WHOLE shot.
 *
 * Motion blur's `trail` weighting is a shutter: it can only look back as far as
 * the shutter is open, about ten frames at 3600°. A trace is the other tool, the
 * one a physics demo needs: where has this thing BEEN since the shot began — an
 * orbit closing on itself, a Lissajous figure filling in, a ball's arc with a
 * ghost every 1/10 s. It is a layer of its own (z-order, effects, glow, opacity
 * and blend are a layer's), and it stores no points at all.
 *
 * ── Evaluated, never baked ─────────────────────────────────────────────────
 *
 * A trace is a pure function of the document and the instant: it SAMPLES its
 * source at fixed steps from its own start to now (`trace/evaluate.ts`), through
 * the same bake every surface reads (`resolvedDocAt`, `clipAtInstant`). Steps
 * are on a grid anchored at the trace's start, never at the playhead, so a frame
 * scrubbed to, played into and exported is the same polyline. Edit the source —
 * its keys, its expression, its body's mass — and the trace re-draws; there is
 * nothing to re-record.
 *
 * ── What it follows ───────────────────────────────────────────────────────
 *
 *   source.clipId = a layer's id   that layer's point (`point`, local px from its
 *                                  box centre, so a rim point of a rolling wheel
 *                                  draws a cycloid) — keyed, driven by an
 *                                  expression, a body in the comp's simulation,
 *                                  a tracker, anything that moves a layer
 *   source.clipId = null           the trace's OWN position: a pen. Key it, or
 *                                  put an expression on its `x`/`y` and it
 *                                  draws the curve with no other layer at all
 *
 * The polyline is in COMP space, so the trace's own transform places nothing
 * but the pen (a sourced trace ignores it).
 *
 * ── How it looks: HEAD → TAIL by age ──────────────────────────────────────
 *
 * Every vertex has an age (now − when it was drawn). `coolMs` is how long the
 * head takes to cool: colour, width and opacity run from `head` to `tail` over
 * that age (shaped by `falloff`) and stay at `tail` after. Null = cool across
 * the whole visible trace, so the oldest point is always fully the tail. That is
 * ScientificMotion's brand rule in one field: the present is ember, the past is
 * chalk.
 */

/** One end of the age ramp. */
export const traceEndSchema = z.object({
  /** Hex or `var:` token, like every colour slot. */
  color: z.string(),
  /** Stroke width in frame px. */
  width: z.number().min(0).max(400),
  opacity: z.number().min(0).max(1),
});
export type TraceEnd = z.infer<typeof traceEndSchema>;

/**
 * STROBOSCOPIC GHOSTS — the source drawn again at equal time steps, the way a
 * strobe photograph shows a falling ball. Instants sit on the grid `start +
 * k·everyMs`, so they never swim as the playhead moves.
 */
export const traceGhostsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Δt between ghosts, ms. */
  everyMs: z.number().min(10).max(60_000).default(100),
  /**
   * `source`: the followed layer itself as it looked at that instant (its
   * rotation, its colour, its squash). `dot`: a disc of `size` px in the age
   * colour — what a pen (no source layer) shows.
   */
  style: z.enum(["source", "dot"]).default("source"),
  /** Dot diameter, frame px. */
  size: z.number().min(0.5).max(400).default(12),
  /** Opacity of the newest ghost. */
  opacity: z.number().min(0).max(1).default(0.5),
  /** Ghosts cool like the line: older ones take the tail's opacity (× `opacity`). */
  fade: z.boolean().default(true),
  /** Most ghosts shown, newest first. Null = every one in the visible trace. */
  count: z.number().int().min(1).max(1000).nullable().default(null),
});
export type TraceGhosts = z.infer<typeof traceGhostsSchema>;

export const traceSpecSchema = z.object({
  source: z.object({
    /** The layer followed; null = the trace's own position (a pen). */
    clipId: z.string().nullable().default(null),
    /** The traced point, local px from the source's box centre (rotates and scales with it). */
    point: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  }),
  /**
   * How much history is drawn, ms. Null = everything since the trace began.
   * Keyable (`trace.lengthMs`) — a trace may grow, then shorten into a comet.
   */
  lengthMs: z.number().min(0).nullable().default(null),
  /** Samples per second of the source. The head is always exact; this is how finely the past bends. */
  rate: z.number().min(1).max(2000).default(120),
  head: traceEndSchema,
  tail: traceEndSchema,
  /** Age (ms) at which a vertex has fully cooled to `tail`. Null = across the visible trace. */
  coolMs: z.number().min(1).nullable().default(null),
  /** Shape of the cooling: 1 = linear in age, >1 = holds its heat then drops, <1 = cools fast. */
  falloff: z.number().min(0.05).max(20).default(1),
  /** End caps (joins are always round: a trace bends smoothly). */
  cap: z.enum(["round", "butt"]).default("round"),
  ghosts: traceGhostsSchema.default({}),
});
export type TraceSpec = z.infer<typeof traceSpecSchema>;

/** The pen's box, frame px: what a trace's position names and its gizmo grabs. */
export const TRACE_PEN_BOX = 24;
