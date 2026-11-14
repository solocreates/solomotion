import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Inspector glyphs — the tiny diagrammatic icons that say *which corner* or
 * *which edge* a field addresses. Figma's per-corner radius and per-side inset
 * fields work because the icon shows the geometry; four fields labelled
 * "TL/TR/BL/BR" make you translate letters into a picture every time.
 *
 * Both glyphs are ONE path drawn in the top-left / top orientation and rotated,
 * so the four variants can never drift out of alignment with each other.
 */

const ROTATE: Record<string, string> = {
  tl: "rotate(0)",
  tr: "rotate(90 8 8)",
  br: "rotate(180 8 8)",
  bl: "rotate(270 8 8)",
  top: "rotate(0)",
  right: "rotate(90 8 8)",
  bottom: "rotate(180 8 8)",
  left: "rotate(270 8 8)",
};

export type Corner = "tl" | "tr" | "br" | "bl";
export type Side = "top" | "right" | "bottom" | "left";

/** An L with one rounded corner — the corner this field rounds. */
export function CornerGlyph({ corner, className }: { corner: Corner; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-3.5", className)} aria-hidden>
      <path
        d="M3.5 13.5V8a4.5 4.5 0 0 1 4.5-4.5h5.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        transform={ROTATE[corner]}
      />
    </svg>
  );
}

/** A box with one edge inked — the side this field insets. */
export function EdgeGlyph({ side, className }: { side: Side; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-3.5", className)} aria-hidden>
      <g transform={ROTATE[side]}>
        <rect x="3" y="3" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.25" opacity="0.35" />
        <path d="M3.6 3.5h8.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </g>
    </svg>
  );
}
