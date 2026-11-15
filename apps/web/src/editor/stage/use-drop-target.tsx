"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import type { ClipHitRect } from "./render/draw-frame";
import { useSession, useStageView, type LibraryDrag } from "../state/session";

/**
 * WHICH LAYER am I about to drop this on — one hook, one highlight, one answer.
 *
 * Some library items CREATE (a template, a media asset) and some MODIFY (an
 * animation applied to an existing layer). A modifier needs a target, and until
 * now the only feedback that it had found one was the edit landing — or, worse,
 * not landing and inventing a layer instead. This is that feedback: while a
 * modifier drag is over the canvas, the layer under the cursor is outlined, and
 * a drop over nothing is visibly a no-op before you let go rather than a
 * surprise after.
 *
 * Cost, because a stage can hold hundreds of nested layers:
 *
 *  • It hit-tests at most ONCE PER FRAME. Pointer moves are coalesced into a
 *    single rAF, so a fast drag across the canvas costs one test per repaint,
 *    not one per event — strictly cheaper than the hover behaviour the stage
 *    already has.
 *  • It runs the SAME resolver the drop runs, so a drop can never target
 *    something different from what was outlined. A second, "cheaper" hit-test
 *    would be a second answer.
 *  • It does nothing at all unless a modifier drag is live, and it unsubscribes
 *    the moment one ends. Idle cost is zero.
 *  • The highlight is one absolutely-positioned div with a CSS transform — no
 *    canvas repaint, so the stage does not redraw while you hover.
 *
 * THE FLICKER, and why it was structural. `resolve` is a closure rebuilt on
 * every Stage render. It used to sit in this effect's dependency array, so the
 * loop was: move → setHit → Stage re-renders → new closure identity → effect
 * tears down → its cleanup calls setHit(null) → the outline vanishes → Stage
 * re-renders again. The highlight appeared for a frame and left, over and over,
 * which is exactly what "jumpy, mostly not there" looks like. A live resolver
 * is not a dependency — it is the LATEST value of one — so it lives in a ref
 * and the subscription's lifetime is now the drag's lifetime, nothing else.
 */

/**
 * Drags that need an existing layer. Creators are absent by construction, and
 * so are transitions: a transition attaches to a CUT, which only exists on a
 * time axis, so the canvas can never honour one and must not outline as if it
 * could.
 */
const MODIFIERS: ReadonlySet<NonNullable<LibraryDrag>["kind"]> = new Set(["anim"]);

export function isModifierDrag(drag: LibraryDrag): boolean {
  return Boolean(drag && MODIFIERS.has(drag.kind));
}

export interface StageDropTarget {
  /** The clip a drop would land on right now, or null over empty canvas. */
  hit: ClipHitRect | null;
  /** The outline to render. Mount it anywhere; it portals to the body. */
  overlay: React.ReactNode;
}

export function useStageDropTarget(
  containerRef: React.RefObject<HTMLElement | null>,
  /** The drop's own resolver — client px in, the layer it would land on out. */
  resolve: (client: { x: number; y: number }, drag: NonNullable<LibraryDrag>) => ClipHitRect | null,
): StageDropTarget {
  const drag = useSession((s) => s.libraryDrag);
  const over = useSession((s) => s.libraryDragPos?.over ?? null);
  const active = isModifierDrag(drag) && over === "stage";
  const [hit, setHit] = React.useState<ClipHitRect | null>(null);

  // Latest-value refs: read inside the subscription, never a dependency of it.
  const resolveRef = React.useRef(resolve);
  resolveRef.current = resolve;
  const dragRef = React.useRef(drag);
  dragRef.current = drag;

  React.useEffect(() => {
    if (!active) {
      setHit(null);
      return;
    }
    const el = containerRef.current;
    if (!el) return;

    let raf = 0;
    let pending: { x: number; y: number } | null = null;

    const test = (client: { x: number; y: number }) => {
      const d = dragRef.current;
      if (!d) return null;
      return resolveRef.current(client, d);
    };
    const commit = (next: ClipHitRect | null) =>
      // Identity-stable when nothing changed, so an unchanged target does not
      // re-render the overlay sixty times a second.
      setHit((prev) => (prev?.clipId === next?.clipId ? prev : next));

    const flush = () => {
      raf = 0;
      if (!pending) return;
      commit(test(pending));
      pending = null;
    };

    // Seed from the position the drag controller has already published. A drag
    // that crosses onto the canvas and stops would otherwise show nothing at
    // all until the next pointer move — and a drag that entered slowly showed
    // nothing for the frame in which this effect was still mounting.
    const seed = useSession.getState().libraryDragPos;
    if (seed) commit(test(seed));

    const onMove = (e: PointerEvent) => {
      pending = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(flush);
    };

    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, containerRef]);

  return { hit, overlay: active ? <DropHighlight hit={hit} containerRef={containerRef} /> : null };
}

/**
 * The outline. World → screen through the SAME camera the canvas uses, so it
 * sits exactly on the layer at any zoom, rotation or shear.
 */
function DropHighlight({
  hit,
  containerRef,
}: {
  hit: ClipHitRect | null;
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const scale = useStageView((v) => v.scale);
  const tx = useStageView((v) => v.tx);
  const ty = useStageView((v) => v.ty);
  const el = containerRef.current;
  if (!el || typeof document === "undefined") return null;
  const rect = el.getBoundingClientRect();

  if (!hit) {
    return createPortal(
      <div
        className="pointer-events-none fixed z-90 flex items-end justify-center pb-6"
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      >
        <span className="rounded-(--r-xs) bg-background/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-lg backdrop-blur">
          Drop on a layer
        </span>
      </div>,
      document.body,
    );
  }

  const w = Math.abs(hit.width) * scale;
  const h = Math.abs(hit.height) * scale;
  const left = rect.left + tx + hit.cx * scale;
  const top = rect.top + ty + hit.cy * scale;

  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-90 rounded-[3px] border-2 border-primary bg-primary/10"
      style={{
        left,
        top,
        width: w,
        height: h,
        transform: `translate(-50%, -50%) rotate(${hit.rotation}deg) skew(${hit.skewX}deg, ${hit.skewY}deg)`,
        // A slow pulse reads as "armed" without competing with the cursor.
        animation: "tm-drop-pulse 1.1s ease-in-out infinite",
      }}
    >
      <style>{"@keyframes tm-drop-pulse{0%,100%{opacity:1}50%{opacity:.55}}"}</style>
    </div>,
    document.body,
  );
}
