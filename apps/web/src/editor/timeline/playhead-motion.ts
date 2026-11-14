/**
 * WHILE THE TRANSPORT RUNS, THE COMPOSITOR MOVES A PLAYHEAD.
 *
 * Writing a playhead's transform every frame re-layerized the whole page each
 * time — ~5 ms a frame with a timeline of filmstrips (measured on the
 * Playground cover: hiding the one element took layerization from ~450 ms to
 * ~15 ms per 3 s of playback; moving it to the end of <body> did not help).
 * So a running playhead is a linear Web Animation at its own measured speed,
 * and the main thread touches it again only when the real playhead leaves the
 * animation by more than `DRIFT_PX` — a seek, a loop's wrap, a scroll, a speed
 * change, an exact run's uneven steps — each of which re-anchors it. Parked,
 * it is placed directly, exactly as before.
 *
 * The speed is measured over the whole stretch since the last discontinuity,
 * not one frame pair: a pair is a frame's jitter, a stretch is the rate.
 */

/** How far the real playhead may be from its running animation before it is re-anchored. */
const DRIFT_PX = 1.5;
/** How far ahead an animation runs before it would need re-anchoring anyway. */
const HORIZON_MS = 60_000;

export interface PlayheadMover {
  /** Put the playhead at `left` px; `running` lets the compositor carry it. */
  place(el: HTMLElement, left: number, running: boolean): void;
  dispose(): void;
}

export function createPlayheadMover(): PlayheadMover {
  let anim: { a: Animation; from: number; pxPerMs: number } | null = null;
  /** Where this stretch of running began: its speed is measured over all of it. */
  let since: { left: number; at: number } | null = null;
  /** The last place asked for: a running playhead that did not move (clamped at the end) is parked. */
  let lastLeft = NaN;

  const park = (el: HTMLElement, left: number) => {
    el.style.transform = `translateX(${left}px)`;
    anim?.a.cancel();
    anim = null;
  };

  return {
    place(el, left, running) {
      const still = left === lastLeft;
      lastLeft = left;
      if (!running || (still && !anim)) {
        since = null;
        park(el, left);
        return;
      }
      const now = performance.now();
      // Where the animation actually has it — its own clock, not a model of it.
      const shown = anim ? anim.from + Number(anim.a.currentTime ?? 0) * anim.pxPerMs : NaN;
      if (Math.abs(shown - left) <= DRIFT_PX) return;
      if (still) {
        since = null;
        park(el, left);
        return;
      }
      // Backwards, or a jump (a seek, a wrap, a scroll): a new stretch.
      if (!since || left < since.left || (anim && Math.abs(shown - left) > DRIFT_PX * 8)) since = { left, at: now };
      const pxPerMs = now - since.at > 50 ? (left - since.left) / (now - since.at) : 0;
      park(el, left);
      if (!(pxPerMs > 0) || typeof el.animate !== "function") return;
      const to = left + pxPerMs * HORIZON_MS;
      const a = el.animate([{ transform: `translateX(${left}px)` }, { transform: `translateX(${to}px)` }], {
        duration: HORIZON_MS,
        easing: "linear",
        fill: "forwards",
      });
      // From NOW, not from the next frame it would otherwise wait for.
      a.startTime = now;
      anim = { a, from: left, pxPerMs };
    },
    dispose() {
      anim?.a.cancel();
      anim = null;
      since = null;
      lastLeft = NaN;
    },
  };
}
