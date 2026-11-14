"use client";

import * as React from "react";

/**
 * THE ICONS LUCIDE DOES NOT HAVE.
 *
 * Drawn to lucide's own metrics — a 24 viewBox, 2px round strokes,
 * `currentColor`, no fills — so they sit in a row beside `PenTool` and `Ruler`
 * without looking like guests.
 *
 * A glyph earns a place here only when the nearest stock icon is actively
 * MISLEADING, which is a real cost: an icon that means the wrong thing is worse
 * than one that means nothing, because the first is learned and then has to be
 * unlearned. Every one below replaced a borrowed glyph that was teaching
 * something false.
 *
 *   onion skin     wore `Layers` — the layer STACK idiom, used everywhere else
 *                  in this app for the thing onion skinning is not
 *   focus mode     wore `Focus` — a camera's autofocus reticle, which reads as
 *                  "focus on the selection", the one thing it does not do
 *   reference      wore `Layers2` — again the layers list, so the control that
 *                  says "read regions FROM this artwork" looked like the panel
 *                  that lists it
 *   edge accuracy  wore `Ruler` — a measuring instrument, for a control about
 *                  how a boundary is FOUND and how hard it lands
 *   merge strokes  wore `Merge` — a VCS merge arrow, two branches into one
 *                  line, which says nothing about outlines joining
 *   close gaps     had a glyph of its own that read as three separate lines
 */

const BASE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * ONION SKIN — the same drawing, three times, fading behind itself.
 *
 * The convention every animation tool shares (TVPaint, Krita, Toon Boom) is
 * ghost REPEATS of one shape, offset and faded — never a stack of layers, which
 * is a different idea entirely: layers sit above each other in space, onion
 * skins sit before and after each other in TIME. Same-shape repeats with a
 * solid present frame say exactly that, and the direction of the fade is the
 * direction of the timeline.
 */
export function OnionSkinIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} className={className} aria-hidden>
      <path d="M4 7.5 C4 5.6 5.3 4.5 7 4.5 C8.7 4.5 10 5.6 10 7.5 L10 16.5 C10 18.4 8.7 19.5 7 19.5 C5.3 19.5 4 18.4 4 16.5 Z" opacity={0.28} />
      <path d="M9 7.5 C9 5.6 10.3 4.5 12 4.5 C13.7 4.5 15 5.6 15 7.5 L15 16.5 C15 18.4 13.7 19.5 12 19.5 C10.3 19.5 9 18.4 9 16.5 Z" opacity={0.55} />
      <path d="M14 7.5 C14 5.6 15.3 4.5 17 4.5 C18.7 4.5 20 5.6 20 7.5 L20 16.5 C20 18.4 18.7 19.5 17 19.5 C15.3 19.5 14 18.4 14 16.5 Z" />
    </svg>
  );
}

/**
 * FOCUS MODE — the canvas keeps the room; the panels step back.
 *
 * A solid centre pane with the two side panes drawn as faint outlines pulling
 * away from it. It is a picture of the LAYOUT changing, which is what the mode
 * does, rather than of a camera focusing, which is what the old reticle showed.
 */
export function FocusModeIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} className={className} aria-hidden>
      <rect x="7.5" y="5" width="9" height="14" rx="2" />
      <path d="M3.5 8 L3.5 16" opacity={0.4} />
      <path d="M20.5 8 L20.5 16" opacity={0.4} />
      <path d="M5.6 12 L3.2 12 M18.4 12 L20.8 12" opacity={0.4} />
    </svg>
  );
}

/**
 * REFERENCE — artwork being READ, not listed.
 *
 * A sheet with scan corners around it: the corners are the universal "this is
 * what I am looking at" mark, and they are what separate it from the layers
 * panel's stack. The dashed contour inside is the region being lifted off it,
 * which is literally what a reference does for the bucket and the confined
 * brush.
 */
export function ReferenceIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} className={className} aria-hidden>
      <path d="M3 7.5 L3 5 A2 2 0 0 1 5 3 L7.5 3" />
      <path d="M16.5 3 L19 3 A2 2 0 0 1 21 5 L21 7.5" />
      <path d="M21 16.5 L21 19 A2 2 0 0 1 19 21 L16.5 21" />
      <path d="M7.5 21 L5 21 A2 2 0 0 1 3 19 L3 16.5" />
      <path d="M8 14 C8 10.5 10 8.5 12 8.5 C14.6 8.5 16 10.6 16 12.5 C16 14.4 14.6 15.5 13 15.5 C11.7 15.5 11 14.7 11 13.8" strokeWidth={1.8} strokeDasharray="2.6 2.2" />
    </svg>
  );
}

/**
 * EDGE — how hard the boundary lands.
 *
 * One line, sharp at the left and dissolving to the right. The whole control is
 * about the quality of an edge (accuracy, expand, feather), and a gradient from
 * crisp to soft is that fact drawn rather than named. A ruler measures length,
 * which is not a question this control ever asks.
 */
export function EdgeIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} className={className} aria-hidden>
      <path d="M4 4 L4 20" strokeWidth={2.4} />
      <path d="M8.5 4 L8.5 20" strokeWidth={1.8} opacity={0.72} />
      <path d="M13 4 L13 20" strokeWidth={1.5} opacity={0.44} />
      <path d="M17.5 4 L17.5 20" strokeWidth={1.3} opacity={0.22} />
      <path d="M21 4 L21 20" strokeWidth={1.2} opacity={0.1} />
    </svg>
  );
}

/**
 * MERGE STROKES — two outlines becoming one outline.
 *
 * Two overlapping rounded shapes with the seam between them dissolved: the
 * boolean-union idiom, which is exactly the operation. The old `Merge` arrow is
 * a version-control glyph — two branches joining a line — and says nothing
 * about shapes at all.
 */
export function MergeStrokesIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} className={className} aria-hidden>
      <path d="M9.4 5.5 A4.5 4.5 0 0 0 9.4 18.5" />
      <path d="M14.6 5.5 A4.5 4.5 0 0 1 14.6 18.5" />
      <path d="M9.4 5.5 L14.6 5.5 M9.4 18.5 L14.6 18.5" />
      <path d="M12 8.2 L12 15.8" strokeWidth={1.4} strokeDasharray="1.6 2.4" opacity={0.45} />
    </svg>
  );
}

/**
 * CLOSE GAPS — an outline with a hole in it, sealed.
 *
 * A closed contour broken by one visible gap, with a bridge across it. The
 * previous glyph drew two free-floating strokes and a dotted link, which at
 * 14px read as three unrelated lines; putting the gap in an otherwise CLOSED
 * shape is what makes the problem legible — you can see the leak the setting
 * plugs.
 */
export function CloseGapsIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} className={className} aria-hidden>
      <path d="M14.8 4.6 A8 8 0 1 1 9.2 4.6" />
      <path d="M9.2 4.6 L9.2 9.4 M14.8 4.6 L14.8 9.4" strokeWidth={1.6} opacity={0.5} />
      <path d="M9.4 7 L14.6 7" strokeWidth={2.4} />
    </svg>
  );
}

/**
 * PAINT INSIDE — a brush stroke held inside an area.
 *
 * The area is a dashed round-rect and the mark is a solid diagonal that stops
 * at its edge. Kept from the first set of hand-drawn icons: the stock glyph for
 * this was a dashed square, which is the SELECTION idiom in every other part of
 * this app, so the control that confines a brush read as one that makes a
 * selection.
 */
export function PaintInsideIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} className={className} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="4" strokeDasharray="3.2 2.6" opacity={0.75} />
      <path d="M7.5 15.5 L14 9" strokeWidth={2.6} />
      <path d="M14.2 8.8 L16.4 11" strokeWidth={2.6} opacity={0.55} />
    </svg>
  );
}

/**
 * MOTION BLUR — a solid head with echoes trailing behind it.
 *
 * The mark IS the setting: off is a single crisp dot, `fast` picks up a short
 * tail, `full` smears properly. Nobody has to be told what it means, because at
 * every level it is a picture of that level.
 *
 * Lives here rather than in the chip it was drawn for, because that chip is
 * gone — motion blur is a row in the stage's Preview tab now, and the glyph
 * outlived its one host the moment the control found the right room.
 */
export function ShutterIcon({ trail, className }: { trail: 0 | 1 | 2; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" aria-hidden>
      {/* Echoes, furthest and faintest first — drawn behind the head. */}
      {trail >= 2 && <circle cx="2.5" cy="8" r="2.6" fill="currentColor" opacity="0.16" />}
      {trail >= 1 && <circle cx="5.4" cy="8" r="2.9" fill="currentColor" opacity="0.34" />}
      {trail >= 2 && <circle cx="8.2" cy="8" r="3.1" fill="currentColor" opacity="0.55" />}
      <circle cx="11" cy="8" r="3.3" fill="currentColor" />
    </svg>
  );
}
