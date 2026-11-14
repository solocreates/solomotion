"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * THE CLIP SURFACE CONTRACT — what may be drawn on a clip, and when it is
 * allowed to answer a pointer.
 *
 * A clip accumulates chrome. It already carries in/out animation chips, caption
 * cue bars, keyframe diamonds, an audio envelope, a loop-cycle handle, a cache
 * hairline and a poster strip; speed ramps, freeze holds and repeat groups are
 * next, and after those something nobody has thought of yet. Each one was added
 * as an absolutely-positioned box that took pointer events the moment it
 * existed, which produced two failures that get worse with every addition:
 *
 *   1. THE CLIP STOPPED BEING DRAGGABLE. Press a caption clip anywhere near a
 *      cue tick, or a text clip over its animation chip, and the chrome ate the
 *      press — so the everyday gesture (pick the clip up and move it) failed on
 *      exactly the clips that have the most to say. Nothing had gone wrong in
 *      the drag code; there was simply something on top of it.
 *   2. Chrome sized for a 56px lane was drawn identically into a 24px one,
 *      where it is illegible, and into a 120px one, where it is lost.
 *
 * Both are one missing idea, so this file is that idea:
 *
 *   ── A clip is ONE OBJECT until it is selected. ──
 *
 * Everything drawn on it is INERT before then — it paints, it informs, it
 * cannot be grabbed. Selecting the clip is what promotes its chrome to
 * interactive, and selection is a gesture every pointer has (a mouse click, a
 * finger tap, ↑/↓ in the layers list), which is why it is the right gate and
 * hover is not. It is also the convention: Figma, After Effects and Resolve all
 * make you own a thing before you can pull its handles.
 *
 * The rule is enforced STRUCTURALLY rather than by each overlay remembering it.
 * `ClipChromeLayer` sets `pointer-events: none` on the whole layer when the
 * clip is unselected, and `pointer-events` inherits — so an overlay added next
 * year obeys without its author knowing this file exists. That is the whole
 * point: a list of places that have remembered is a bug waiting for its
 * fortieth entry.
 *
 * DETAIL is the same shape of answer. A tier is derived from the lane's
 * rendered height, published once, and read by every overlay — so "how much fits
 * here" is decided in one place instead of by a dozen magic numbers that
 * disagree about what "small" means.
 */

/** How much a clip can legibly say at this row height. */
export type ClipDetail = "micro" | "compact" | "full";

/**
 * Thresholds, and why these numbers:
 *
 *  · below 30px there is room for ONE line of 11px type and nothing else — the
 *    title. Every band, ribbon and diamond becomes a hairline or disappears.
 *  · below 46px a second line does not fit, but a 4px band does.
 *  · above that the clip can afford labelled bars and stacked chips.
 */
export function clipDetail(laneHeightPx: number): ClipDetail {
  if (laneHeightPx < 30) return "micro";
  if (laneHeightPx < 46) return "compact";
  return "full";
}

/**
 * THE EDGE GRIPS SHRINK BEFORE THE BODY DOES.
 *
 * Zoom the timeline out and a one-second clip is 20px wide, but its two trim
 * grips were still `--hit-grip` each — 16px on a mouse, 30px on a finger — so
 * the part you could pick the clip UP by was a sliver or nothing, and every
 * press trimmed. The body is the everyday gesture; the edges are the
 * occasional one, so it is the edges that give way.
 *
 * One CSS formula, evaluated by the browser against the clip's own width, so
 * no clip measures itself and no JS runs per zoom step: a grip is the hit
 * size, or half of whatever the clip has left after reserving `CLIP_BODY_MIN`
 * for the body — down to nothing. A clip too small to trim is trimmed zoomed
 * in, which is what you were about to do anyway.
 */
export const CLIP_BODY_MIN_PX = 18;
export const EDGE_GRIP_WIDTH = `min(var(--hit-grip), max(0px, (100% - ${CLIP_BODY_MIN_PX}px) / 2))`;

/**
 * Does a clip this wide have room for handles INSIDE it — fade knobs, gain
 * points, a loop grip? Below this the handles sit on top of each other and on
 * top of the grips, and a press means whichever won the stacking order. The
 * clip keeps its line and its label; it just stops offering things to grab.
 */
export function clipHasRoomForHandles(widthPx: number): boolean {
  return widthPx >= 44;
}

/** What reveals a clip's trim grips. */
export type EdgeReveal = "hover" | "select";

/**
 * A SHORT CLIP IS ALL EDGE, so hover stops revealing its grips.
 *
 * `EDGE_GRIP_WIDTH` above keeps 18px of body no matter how narrow the clip
 * gets, which is enough for the press to LAND on the body — and not nearly
 * enough for it to be the obvious target. On a 40px clip the reader sees two
 * bars with a sliver between them, aims at the clip, and trims it. That is the
 * everyday gesture (pick it up and move it) failing on exactly the clips a
 * person is fiddling with most, and it is the same failure `clip-chrome`'s
 * whole premise exists to prevent — something on top of the clip ate the press
 * that picks the clip up.
 *
 * The grips were the ONE affordance that had opted out of that premise, on the
 * reasoning that hover is free for a mouse. It is free when the body is
 * plainly the larger target. It is not free when the grips ARE the clip.
 *
 * So the rule is the same rule, scaled: a clip wide enough to read as a body
 * with two ends keeps hover-to-trim; a clip that is mostly ends waits to be
 * SELECTED, which is what every other piece of chrome on it already does and
 * which every pointer can do. Trimming a short clip is then two gestures
 * instead of one, and moving it is one instead of impossible — the right way
 * round, because you move clips constantly and trim a 40px clip by zooming in.
 *
 * The number: two `--hit-grip` zones (8px each on a mouse — coarse pointers
 * never hover-reveal at all, see `grip-needs-select`) plus a body that is
 * clearly the dominant half of the clip rather than merely present.
 */
export const CLIP_HOVER_EDGES_MIN_PX = 64;

export function clipEdgeReveal(widthPx: number): EdgeReveal {
  return widthPx >= CLIP_HOVER_EDGES_MIN_PX ? "hover" : "select";
}

export interface ClipChromeState {
  /** The clip owns the pointer: selected, unlocked. Chrome may be grabbed. */
  active: boolean;
  detail: ClipDetail;
  /** The lane's rendered height, for chrome that sizes itself continuously. */
  laneHeightPx: number;
  /** The clip's rendered width — the other axis of "how much fits here". */
  widthPx: number;
  /** Room for handles INSIDE the clip (`clipHasRoomForHandles`). */
  handles: boolean;
  /** What reveals the trim grips at this width (`clipEdgeReveal`). */
  edges: EdgeReveal;
}

const ClipChromeContext = React.createContext<ClipChromeState>({
  active: false,
  detail: "full",
  laneHeightPx: 56,
  widthPx: 0,
  handles: false,
  edges: "hover",
});

/** What may I draw here, and may it be touched? Read by every clip overlay. */
export function useClipChrome(): ClipChromeState {
  return React.useContext(ClipChromeContext);
}

export function ClipChromeProvider({
  active,
  laneHeightPx,
  widthPx,
  children,
}: {
  active: boolean;
  laneHeightPx: number;
  widthPx: number;
  children: React.ReactNode;
}) {
  // Both "how much fits here" answers are DERIVED from the clip's box, in one
  // place, so no overlay re-decides what "small" means with its own number.
  const value = React.useMemo<ClipChromeState>(
    () => ({
      active,
      laneHeightPx,
      widthPx,
      detail: clipDetail(laneHeightPx),
      handles: clipHasRoomForHandles(widthPx),
      edges: clipEdgeReveal(widthPx),
    }),
    [active, laneHeightPx, widthPx],
  );
  return <ClipChromeContext.Provider value={value}>{children}</ClipChromeContext.Provider>;
}

/**
 * A layer of clip chrome. Fills the clip, and answers a pointer only while the
 * clip is selected.
 *
 * Use it for ANY overlay on a clip. Nothing inside needs to know the rule, and
 * nothing inside may set `pointer-events` back on — that would be re-opening
 * the hole this closes.
 */
export function ClipChromeLayer({
  children,
  className,
  clipped,
}: {
  children: React.ReactNode;
  className?: string;
  /** Round and clip to the clip's own box — for bands that paint edge to edge. */
  clipped?: boolean;
}) {
  const { active } = useClipChrome();
  return (
    <div
      className={cn(
        "absolute inset-0",
        clipped && "overflow-hidden rounded-md",
        !active && "pointer-events-none",
        className,
      )}
    >
      {children}
    </div>
  );
}
