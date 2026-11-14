import { z } from "zod";

/**
 * RELATIONS — a layer whose placement is DERIVED from another layer (v73).
 *
 * Two of them ship here, and they are one concept, which is why they share a
 * file and a resolver (`relations/resolve.ts`):
 *
 *   text on a path    a text layer rides the OUTLINE of a shape or path layer
 *   auto layout       a group ARRANGES its members and sizes itself from them
 *
 * In both the document stores a small SPEC and nothing else. Where the glyphs
 * land, where a member sits, how wide a hugging container is — all of that is
 * computed per instant from the other layer's live geometry, through the same
 * seam a node driver uses: the resolved document (`resolveClipDrivers` states
 * why baking once beats reading through at every draw site). So a shape you
 * morph, resize or keyframe re-lays its text on the same frame; a text you type
 * into reflows every sibling in its row; and there is no snapshot anywhere to
 * go stale, because there is no snapshot.
 *
 * The one irreversible decision in this file: a relation points at a layer BY
 * ID, never by copying its geometry. Figma copies the path into the text layer,
 * which is why a Figma text-on-path stops following its shape the moment it is
 * made. Ours never stops, and the cost is that a dangling id has to resolve to
 * "no relation" everywhere (`hostOf` returns null; the text draws plain) rather
 * than to a crash — which the resolver guarantees.
 */

/** Which way the glyphs turn as they follow the curve. */
export const textPathFollowSchema = z.enum(["tangent", "upright"]);
export type TextPathFollow = z.infer<typeof textPathFollowSchema>;

/**
 * A text layer's RIDE on another layer's outline.
 *
 * `offset` is in LAPS — a fraction of the outline's total length, so `1` is
 * once around and a keyframe from `0` to `3` spins the text three times. Laps
 * rather than pixels because a shape that grows keeps its text at the same
 * fraction of the way round, which is what "the word on the top of the circle"
 * means; a pixel offset would slide it toward the start every time the circle
 * was resized. Any real number is legal and wraps (see `loop`).
 *
 * `rise` is perpendicular to the path in frame px: the baseline sits ON the
 * outline at 0, positive lifts the glyphs to the left of the direction of
 * travel (outside a clockwise shape), negative sinks them to the right.
 *
 * `flip` reverses the direction of travel AND mirrors the up-vector, so the
 * text reads the other way round on the other side of the line — Figma's flip,
 * Illustrator's "flip across path". Two facts in one switch on purpose: the
 * state where the text reads backwards but sits on the same side is not a
 * thing anyone asks for.
 *
 * `loop` says what a glyph past the END does: wrap to the start (a closed shape
 * — and an open one, so a line becomes a ticker) or hide, which is what a
 * caption clipped by its box does and the reading Figma gives an open path.
 */
export const textPathSpecSchema = z.object({
  /** The shape or path layer whose outline the text rides. Same comp, always. */
  hostClipId: z.string(),
  /**
   * Which CONTOUR of the host carries the text, by index into its outline in
   * paint order — a donut has two, a star one. Out of range reads as 0.
   */
  contour: z.number().int().min(0).default(0),
  offset: z.number().default(0),
  rise: z.number().default(0),
  flip: z.boolean().default(false),
  follow: textPathFollowSchema.default("tangent"),
  loop: z.boolean().default(true),
});
export type TextPathSpec = z.infer<typeof textPathSpecSchema>;

// ── Auto layout ──────────────────────────────────────────────────────────────

/**
 * How a container flows its members.
 *
 *   row · column   one line, along one axis
 *   wrap           rows that break when the line is full (a fixed width, or a
 *                  hugging one that still gets a `wrapAt`)
 *   grid           N columns, items flowing row-major; every column is as wide
 *                  as its widest item, every row as tall as its tallest
 */
export const layoutFlowSchema = z.enum(["row", "column", "wrap", "grid"]);
export type LayoutFlow = z.infer<typeof layoutFlowSchema>;

export const layoutAlignSchema = z.enum(["start", "center", "end"]);
export type LayoutAlign = z.infer<typeof layoutAlignSchema>;

/**
 * Padding in frame px. Four numbers rather than one-or-four so a keyframe path
 * (`layout.padding.top`) always has one home; the inspector links them when
 * they agree, which is the Figma control.
 */
export const layoutPaddingSchema = z.object({
  top: z.number().min(0).default(0),
  right: z.number().min(0).default(0),
  bottom: z.number().min(0).default(0),
  left: z.number().min(0).default(0),
});
export type LayoutPadding = z.infer<typeof layoutPaddingSchema>;

/**
 * A GROUP'S AUTO LAYOUT — the Figma feature, on a group clip.
 *
 * A group already carries fills, strokes, corner radii, effects and a span, so a
 * laid-out group with a fill IS a Figma frame with auto layout; there is no new
 * container kind. What it adds is a declared BOX and a rule for what is inside.
 *
 * THE BOX. A plain group's box is derived from its members; a laid-out group's
 * members are derived from its box, so the box has to come from somewhere: it
 * has its top-left at `x/y` (comp space, the space `transform.x/y` is written
 * in) and is sized by `width`/`height`, where `null` means HUG — as wide as the row of
 * members plus padding. Only `x/y` here is authored by a person; the group's own
 * `transform` stays the DELTA every group has (`group-space.ts`), so dragging,
 * rotating and scaling a laid-out group is dragging, rotating and scaling any
 * group, and the members come along through the same chain.
 *
 * THE MEMBERS. Their order is the group's row order, bottom row first — paint
 * order, which is Figma's `children` order too. Their `transform.x/y` is
 * DERIVED while they are laid out: the resolver writes it, the way it writes a
 * driven value, and every surface reads the result. A member can opt out with
 * `layoutItem.absolute` and keep its own coordinates (Figma "absolute
 * position") — for a badge pinned to a corner.
 *
 * Every number here is keyframable (`layout.gap`, `layout.padding.left`,
 * `layout.width`…), and that is the point of doing this in a motion tool:
 * animate a gap and the row breathes, animate a width and the wrap re-breaks.
 */
export const layoutSpecSchema = z.object({
  flow: layoutFlowSchema.default("row"),
  /**
   * The box's TOP-LEFT corner, comp space. Top-left rather than centre so a
   * hugging box grows the way a card does when you type into it — to the
   * right and down, its corner staying put — which is what Figma and CSS do
   * and what "the box got bigger" means to anyone watching.
   */
  x: z.number().default(0),
  y: z.number().default(0),
  /** `null` = hug the members (plus padding). */
  width: z.number().positive().nullable().default(null),
  height: z.number().positive().nullable().default(null),
  /** Bounds on a HUGGING axis — a card that never gets narrower than 200. `null` = unbounded. */
  minWidth: z.number().min(0).nullable().default(null),
  maxWidth: z.number().positive().nullable().default(null),
  minHeight: z.number().min(0).nullable().default(null),
  maxHeight: z.number().positive().nullable().default(null),
  /** Space between members along the flow, px. */
  gap: z.number().min(0).default(16),
  /** Space between wrapped lines / grid rows, px. */
  lineGap: z.number().min(0).default(16),
  /**
   * Spread the members to the container's edges instead of packing them at
   * `gap` — Figma's "auto" gap. Only meaningful with a fixed main axis; a
   * hugging container has no slack to spread into.
   */
  spaceBetween: z.boolean().default(false),
  padding: layoutPaddingSchema.default({ top: 0, right: 0, bottom: 0, left: 0 }),
  /** Where the members sit inside the box, main axis × cross axis. */
  alignX: layoutAlignSchema.default("center"),
  alignY: layoutAlignSchema.default("center"),
  /** `grid` only: how many columns. */
  columns: z.number().int().min(1).default(2),
  /**
   * Members that turn with the group's own rotation are the ordinary case.
   * This is the Figma "clip content" of the container: the members are
   * masked to the box.
   */
  clipContent: z.boolean().default(false),
});
export type LayoutSpec = z.infer<typeof layoutSpecSchema>;

/**
 * How ONE member takes part in its container's layout. Carried by every visual
 * clip and meaningless — ignored, kept — outside a laid-out group, exactly like
 * `isStencil` outside a boolean group.
 *
 *   fillX / fillY   stretch to the slot the container offers on that axis
 *                   (a shape's width, a text box's wrap width, a nested
 *                   container's own width). Off = the member's natural size.
 *   absolute        opt out: keep my own x/y, take no slot, occupy no space.
 */
export const layoutItemSchema = z.object({
  fillX: z.boolean().default(false),
  fillY: z.boolean().default(false),
  absolute: z.boolean().default(false),
  /** Bounds on the slot this member accepts, px. `null` = unbounded. */
  minWidth: z.number().min(0).nullable().default(null),
  maxWidth: z.number().positive().nullable().default(null),
  minHeight: z.number().min(0).nullable().default(null),
  maxHeight: z.number().positive().nullable().default(null),
});
export type LayoutItem = z.infer<typeof layoutItemSchema>;

export const DEFAULT_LAYOUT_ITEM: LayoutItem = {
  fillX: false,
  fillY: false,
  absolute: false,
  minWidth: null,
  maxWidth: null,
  minHeight: null,
  maxHeight: null,
};
