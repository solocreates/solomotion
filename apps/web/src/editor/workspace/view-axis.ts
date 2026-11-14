import type { AxisWindow } from "./zoom-bar";

/**
 * A VIEW AXIS — what a zoom bar drives, and the only thing it knows about the
 * panel under it. Each surface supplies one per axis (time, rows, a plain
 * scroll); the bar never holds a copy of scroll or zoom state, so ⌘-scroll, a
 * pinch, a keyboard zoom and the bar can never disagree about where you are.
 */
export interface ViewAxis {
  /** The window now, in the axis's unit — or null before it has been measured. */
  read(): AxisWindow | null;
  /** Show exactly this window. `hold` names the edge a clamped zoom keeps still. */
  show(start: number, size: number, hold: "start" | "end"): void;
  /** Pan only. */
  scrollTo(start: number): void;
  /** Tell the bar something moved (scroll, zoom, resize). Returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** False for a plain scroll axis: no end handles. */
  zoomable: boolean;
  /** The chip shown while an end is dragged ("2.4 s", "140%"). */
  format?(w: AxisWindow): string;
}

/**
 * A native scroller's axis with NO zoom — the dope sheet's rows, any list. The
 * bar is then just a scrollbar that matches the zoomable ones beside it.
 */
export function scrollAxis(getEl: () => HTMLElement | null, dir: "x" | "y"): ViewAxis {
  const pos = (el: HTMLElement) => (dir === "x" ? el.scrollLeft : el.scrollTop);
  const size = (el: HTMLElement) => (dir === "x" ? el.clientWidth : el.clientHeight);
  const extent = (el: HTMLElement) => (dir === "x" ? el.scrollWidth : el.scrollHeight);
  return {
    zoomable: false,
    read() {
      const el = getEl();
      if (!el || size(el) <= 0) return null;
      const s = size(el);
      return { start: pos(el), size: s, extent: extent(el), minSize: s, maxSize: s };
    },
    show(start) {
      this.scrollTo(start);
    },
    scrollTo(start) {
      const el = getEl();
      if (!el) return;
      if (dir === "x") el.scrollLeft = start;
      else el.scrollTop = start;
    },
    subscribe(onChange) {
      return watchScroller(getEl, onChange);
    },
  };
}

/** Scroll + size changes of a scroller (and of its content), as one signal. */
export function watchScroller(getEl: () => HTMLElement | null, onChange: () => void): () => void {
  let el: HTMLElement | null = null;
  let ro: ResizeObserver | null = null;
  let raf = 0;
  // The element can mount after the bar (a panel body that appears with its
  // content), so attach lazily and keep checking until it exists.
  const attach = () => {
    el = getEl();
    if (!el) {
      raf = requestAnimationFrame(attach);
      return;
    }
    el.addEventListener("scroll", onChange, { passive: true });
    ro = new ResizeObserver(onChange);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    onChange();
  };
  attach();
  return () => {
    cancelAnimationFrame(raf);
    el?.removeEventListener("scroll", onChange);
    ro?.disconnect();
  };
}
