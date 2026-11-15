import * as React from "react";
import { cn } from "@/lib/utils";
import s from "./support.module.css";

const HEART = "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z";

/**
 * THE HEART, as a vessel: an outline whose warm ink rises from the bottom to
 * `level` (0–1). The button fills it on hover and while open (CSS, see
 * `.button`); the popover fills it to the amount chosen. One drawing for both,
 * so the button you pressed is the meter you are filling.
 *
 * `level` is a CSS variable, never per-frame React: the rise is a transition.
 */
export function WarmHeart({ level, className }: { level?: number; className?: string }) {
  const id = React.useId();
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cn(s.heart, className)}
      style={level === undefined ? undefined : ({ "--level": level } as React.CSSProperties)}
    >
      <defs>
        <clipPath id={`${id}c`}>
          <path d={HEART} />
        </clipPath>
        <linearGradient id={`${id}g`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" style={{ stopColor: "var(--heart)" }} />
          <stop offset="1" style={{ stopColor: "var(--heart-hi)" }} />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${id}c)`}>
        <rect className={s.heartFill} x="1" y="2.5" width="22" height="19" fill={`url(#${id}g)`} />
      </g>
      <path className={s.heartInk} d={HEART} />
    </svg>
  );
}
