import { z } from "zod";
import { easingSchema } from "./common";

/**
 * A TRANSITION (v42) — the BINARY cousin of the layer in/out animation.
 *
 * `clip.animIn/animOut` is unary: a property of ONE clip, a pose over its own
 * first/last stretch. A transition is a relationship BETWEEN two abutted clips
 * across their cut, and during its span BOTH clips are on screen at once. That
 * is the whole reason it is a separate entity and not another clip field:
 *   • one record = one source of truth, so resizing moves both sides together
 *     by construction instead of by two fields kept in sync (the bug farm);
 *   • it owns its own selection, context menu, copy/paste and lifetime.
 *
 * A lone clip edge is the SAME record with one side null — a cut against
 * nothing — so "iris in on this clip" and "iris between these two clips" are
 * one feature, not two. This does not duplicate `animIn`/`animOut`: those
 * carry the GLYPH preset vocabulary (and bake losslessly into Lottie), a
 * transition carries the cut vocabulary, and the two COMPOSE on a clip exactly
 * as the glyph pose and the layer pose already do.
 *
 * Transitions live on the TRACK (both participants are on it by definition)
 * and are comp-scoped by `frameId` exactly like clips.
 */
export const transitionSchema = z.object({
  id: z.string(),
  /** Preset id from the transition registry (animation/transitions.ts). */
  preset: z.string(),
  /** Comp scoping — mirrors `clip.frameId`; a track carries several comps. */
  frameId: z.string(),
  /**
   * Outgoing clip (left of the cut). Null = there is no outgoing side: the
   * transition sits at a lone clip HEAD and the incoming clip arrives over
   * whatever is behind it (an iris opening, a fade up from black).
   */
  aClipId: z.string().nullable(),
  /** Incoming clip (right of the cut). Null = a lone clip TAIL. */
  bClipId: z.string().nullable(),
  /** Total span across the cut. */
  durationMs: z.number().min(0),
  /**
   * How much of the span sits on A's side of the cut. `durationMs / 2` is the
   * centred default; 0 pins the whole transition into B ("start at cut") and
   * `durationMs` pins it into A ("end at cut"). Alt-dragging a handle moves
   * ONE side, which is exactly a splitMs edit — the asymmetric case costs no
   * extra state.
   */
  splitMs: z.number().min(0),
  easing: easingSchema,
  /** Preset-specific numeric knobs, declared by the registry. */
  params: z.record(z.string(), z.number()),
  /**
   * The veil colour for "dip to colour" style presets. Null = the preset's own
   * default (black). Kept off `params` because params are numbers by contract.
   */
  color: z.string().nullable().default(null),
});
export type Transition = z.infer<typeof transitionSchema>;
