/**
 * STAGE CHROME — the headless half. Where a floating thing sits, what that
 * implies, and nothing about how it is painted.
 *
 * The stage overlay is a SAFE AREA with four edges, and every capsule on it
 * (tool rail, tabs, breadcrumb, view cluster, tool options, brush handle) names
 * one placement: an EDGE and an ALIGNMENT along it. Twelve positions, and no
 * capsule may name anything else.
 *
 *              start ── top ── center ── top ── end
 *          ┌────────────────────────────────────────┐
 *    start │                                        │ start
 *     left │              (the canvas)              │ right
 *   center │                                        │ center
 *      end │                                        │ end
 *          └────────────────────────────────────────┘
 *           start ─ bottom ─ center ─ bottom ─ end
 *
 * WHY A PLACEMENT AND NOT A SLOT NAME. The old model had seven ad-hoc slots —
 * `top`, `top-right`, `left`, `right`, `bottom-left`, `bottom`, `bottom-right`
 * — which is the same twelve with five missing and no rule for which five. It
 * could not express "the rail, docked bottom, centred like Figma's" without a
 * new slot name and a new branch in the layout, and moving the brush handle to
 * the left would have needed both again. An edge and an alignment are two
 * closed unions: every combination already exists, and adding a direction to a
 * control is now a value, never a layout change.
 *
 * EVERYTHING ELSE ABOUT DIRECTION IS DERIVED FROM THE EDGE. A capsule on a
 * horizontal edge is a row; on a vertical edge it is a column. Its flyouts open
 * toward the canvas. Its tooltips do the same. None of that is stored anywhere,
 * so a control cannot be laid out one way and pop its menu the other — which is
 * exactly what happened every time the rail moved, because `placement ===
 * "left"` was re-derived at four call sites and only three of them knew about
 * the tooltip side.
 *
 * The React half (`StageChrome.tsx`) publishes the placement through context,
 * so a capsule asks what it is INSIDE rather than being told twice.
 */

export type ChromeEdge = "top" | "right" | "bottom" | "left";
export type ChromeAlign = "start" | "center" | "end";
export type ChromeAxis = "horizontal" | "vertical";

export interface ChromePlacement {
  edge: ChromeEdge;
  align: ChromeAlign;
}

/** The key a slot map is written with — `"bottom:center"`. */
export type ChromeSlotKey = `${ChromeEdge}:${ChromeAlign}`;

export const CHROME_EDGES: readonly ChromeEdge[] = ["top", "left", "right", "bottom"];
export const CHROME_ALIGNS: readonly ChromeAlign[] = ["start", "center", "end"];

export function slotKey(p: ChromePlacement): ChromeSlotKey {
  return `${p.edge}:${p.align}`;
}

/**
 * Which way a capsule on this edge RUNS. The top and bottom edges are bands
 * across the stage, so their occupants are rows; the sides are columns.
 */
export function axisOfEdge(edge: ChromeEdge): ChromeAxis {
  return edge === "top" || edge === "bottom" ? "horizontal" : "vertical";
}

/**
 * Which side a flyout, tooltip or popover opens from a capsule on this edge:
 * INTO the canvas, which is the only direction with room in it. A rail on the
 * left opens right; a bar docked at the bottom opens up.
 */
export function flyoutSide(edge: ChromeEdge): "top" | "right" | "bottom" | "left" {
  return edge === "left" ? "right" : edge === "right" ? "left" : edge === "top" ? "bottom" : "top";
}

/**
 * The alignment a control gets when it names only an edge.
 *
 * A rail docked to a SIDE hangs from the top — it is a list you read down, and
 * a vertically centred list of eight tools that becomes nine jumps. A bar
 * docked to the BOTTOM centres, because that is what a bottom bar is
 * everywhere: Figma, Illustrator, Procreate. Two conventions, one table, so a
 * third edge is one row rather than an argument at the call site.
 */
const DEFAULT_ALIGN: Record<ChromeEdge, ChromeAlign> = {
  top: "start",
  left: "start",
  right: "start",
  bottom: "center",
};

export function placementOf(edge: ChromeEdge, align?: ChromeAlign): ChromePlacement {
  return { edge, align: align ?? DEFAULT_ALIGN[edge] };
}

/*
 * THE ZONED BAND: a horizontal edge with a `center` occupant.
 *
 *     it fits           [ start ]      [ ···· centre ···· ]      [ end ]
 *
 *     no start, tight   [ ···· centre, slides left, then scrolls ···· ][ end ]
 *
 *     start, too tight  [ start ]                                    [ end ]
 *                       [ ············ centre, full row ············ ]
 *
 * On the top edge that is nav (where you are) on the left, stage settings
 * (zoom, quality, view) ALWAYS on the right, and the armed tool's options in
 * the middle — three zones of ONE grid (`chrome-zones` in globals.css).
 *
 * - The sides are `minmax(max-content, 1fr)` and the centre
 *   `minmax(0, max-content)`. Grid's own flex resolution then centres the
 *   centre while the two `1fr`s are equal, and the moment the end needs more
 *   than half the leftover it keeps its content and the START gives — so an
 *   empty start lets the bar slide left beside the stage settings instead of
 *   leaving a hole where the nav would be. Nothing is measured for that.
 * - Whether the centre needs a ROW OF ITS OWN is the one thing CSS cannot
 *   answer: it depends on whether three natural widths add up to more than
 *   the band. It used to be a container query at a guessed 40rem, which
 *   stacked a 550px bar under an EMPTY nav on a 700px stage and kept three
 *   capsules crammed together on a 680px one. `fitZonedBand` asks the actual
 *   question, from natural widths (content, not the squeezed box, so the
 *   answer cannot feed back into itself).
 * - Only a present START stacks the centre. Without one the centre already
 *   has the whole row beside the end; it shrinks and scrolls inside itself
 *   (`BarCapsule`, edge fades) rather than leaving the row half empty.
 *
 * The bottom edge mirrors it (the centre hugs the bottom). Vertical edges
 * keep their three flex groups: a column has nothing to collide with.
 */

export type ZonedBandFit = "row" | "stacked";

export interface ZoneWidths {
  /** The band's own width. */
  band: number;
  /** Each zone's NATURAL width — 0 when the zone rendered nothing. */
  start: number;
  center: number;
  end: number;
  /** Space between two occupied zones. */
  gap: number;
}

/** One row while every zone fits at its natural width, or while there is no start to make room for. */
export function fitZonedBand(w: ZoneWidths): ZonedBandFit {
  if (w.start <= 0 || w.center <= 0) return "row";
  const zones = [w.start, w.center, w.end].filter((n) => n > 0);
  const need = zones.reduce((a, b) => a + b, 0) + w.gap * (zones.length - 1);
  return need <= w.band ? "row" : "stacked";
}
