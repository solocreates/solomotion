import { RULER_HEIGHT } from "./timeline-utils";

/**
 * Headless handle to the timeline's scrollable lanes viewport. The Timeline
 * registers its scroll element here on mount; keyboard-nav (and any future
 * headless caller) reads it to scroll lanes vertically without prop-drilling a
 * ref or standing up a React context. Same pattern as `space-pan.ts`.
 */
let scrollEl: HTMLElement | null = null;

/** The sticky time ruler inside the lanes scroller covers its top edge; clear it, plus a breath. */
const RULER_INSET = RULER_HEIGHT + 4;

export const timelineViewport = {
  /** Timeline calls this in an effect; the returned fn clears the registration. */
  register(el: HTMLElement | null): () => void {
    scrollEl = el;
    return () => {
      if (scrollEl === el) scrollEl = null;
    };
  },
  get el(): HTMLElement | null {
    return scrollEl;
  },
  /** Scroll the lanes vertically by `dy` px (positive = down). No-op if unmounted. */
  scrollByY(dy: number): void {
    scrollEl?.scrollBy({ top: dy });
  },
  /**
   * Bring a clip's ROW into view — the vertical half of
   * `timelineView.focusRange`, which only ever moved time. Selecting a layer
   * forty rows down scrolled the ruler to it and left the lane off-screen.
   *
   * Same rule as the horizontal half: a row you can see at all is left
   * alone; one that is entirely out of view comes to the middle. The top
   * inset clears the sticky ruler that sits inside this scroller.
   */
  revealClipRow(clipId: string): void {
    const el = scrollEl;
    if (!el) return;
    const clip = el.querySelector<HTMLElement>(`[data-clip-drop-id="${CSS.escape(clipId)}"]`);
    if (!clip) return;
    const view = el.getBoundingClientRect();
    const row = clip.getBoundingClientRect();
    const top = view.top + RULER_INSET;
    if (row.bottom > top && row.top < view.bottom) return;
    const centre = (top + view.bottom) / 2;
    el.scrollBy({ top: row.top + row.height / 2 - centre });
  },
};
