"use client";

import * as React from "react";
import { DEFAULT_O, DIAL_DIRECTIONS, oMetricsFrom, wedgePath, WORDMARK_PARTS, type OMetrics } from "../dial";

/**
 * THE DIAL, drawn. One filled disc with a brighter quarter: the mark, the
 * loader (the quarter turning one step per beat), and the four o's of the
 * wordmark (up, right, down, left — one turn, read clockwise).
 *
 * Colours are tokens: the disc is the accent mixed into the ground it sits on,
 * the quarter is the accent itself, so dark and light each get their own tones
 * and any theme recolours the mark without touching it.
 */

const DISC = "var(--dial-disc, color-mix(in oklab, var(--primary) 26%, var(--background)))";
const WEDGE = "var(--dial-wedge, var(--primary))";

export interface DialMarkProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  /** Which quarter is lit: 0 up, 1 right, 2 down, 3 left. */
  turn?: 0 | 1 | 2 | 3;
  title?: string;
}

/** The small mark: one dial, quarter up. */
export function DialMark({ size = 24, turn = 0, title, ...rest }: DialMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} {...rest}>
      {title && <title>{title}</title>}
      <circle cx="32" cy="32" r="26" fill={DISC} />
      <path d={wedgePath(32, 32, 26, 26, DIAL_DIRECTIONS[turn])} fill={WEDGE} />
    </svg>
  );
}

/**
 * The loader: the same dial, its quarter stepping round a beat at a time
 * (`parts.css` → `[data-part="dial-loader"]`). Holds still under reduced
 * motion. `beat` is one quarter, in ms.
 */
export function DialLoader({ size = 24, beat = 400, label = "Loading", ...rest }: React.SVGProps<SVGSVGElement> & { size?: number | string; beat?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={label}
      data-part="dial-loader"
      style={{ "--dial-beat": `${beat * 4}ms` } as React.CSSProperties}
      {...rest}
    >
      <circle cx="32" cy="32" r="26" fill={DISC} />
      <path data-el="wedge" d={wedgePath(32, 32, 26, 26, 0)} fill={WEDGE} />
    </svg>
  );
}

const oCache = new Map<string, OMetrics>();

/** Measure the "o" of the font this element actually renders in. */
function measureO(el: HTMLElement): OMetrics | null {
  const cs = getComputedStyle(el);
  const key = `${cs.fontWeight} ${cs.fontFamily}`;
  const hit = oCache.get(key);
  if (hit) return hit;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.font = `${cs.fontWeight} 100px ${cs.fontFamily}`;
  const m = ctx.measureText("o");
  if (!m.width || !m.fontBoundingBoxAscent) return null;
  const o = oMetricsFrom(m);
  // Only a measurement of the REAL face is worth keeping: before the webfont
  // loads, the canvas measures the fallback, and caching that would pin every
  // later wordmark to the wrong o.
  if (document.fonts?.status === "loaded" && document.fonts.check(`${cs.fontWeight} 100px ${cs.fontFamily}`)) oCache.set(key, o);
  return o;
}

/** One o. The quarter is drawn pointing up and TURNED, so a change of turn is
 *  a CSS transition (`parts.css`), not a new path. */
function DialO({ o, turn, onPoint }: { o: OMetrics; turn: number; onPoint?: () => void }) {
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${o.adv.toFixed(2)} 100`}
      onPointerEnter={onPoint}
      // inline-block: CSS resets (Tailwind's preflight) make every svg a block,
      // which would put each o on a line of its own.
      style={{ display: "inline-block", width: `${(o.adv / 100).toFixed(4)}em`, height: "1em", verticalAlign: `${(-(100 - o.base) / 100).toFixed(4)}em`, overflow: "visible" }}
    >
      <ellipse cx={o.cx} cy={o.cy} rx={o.rx} ry={o.ry} fill={DISC} />
      <path
        data-el="quarter"
        d={wedgePath(o.cx, o.cy, o.rx, o.ry, 0)}
        fill={WEDGE}
        style={{ transform: `rotate(${turn * 90}deg)`, transformOrigin: `${o.cx}px ${o.cy}px` }}
      />
    </svg>
  );
}

/**
 * Below this size the dials stop reading as o's: the disc sinks into the
 * ground and only the bright quarter survives, so 16px read "s•l•m•ti•n".
 */
export const DIAL_WORDMARK_MIN_PX = 28;

/**
 * The wordmark: "solomotion" set in the display face, each o replaced by a
 * dial placed over the font's REAL o — measured from the face that rendered,
 * so it is right in any theme's display font. It is a DISPLAY lockup: set
 * below `DIAL_WORDMARK_MIN_PX` it renders the name plainly in the same face,
 * and the dial mark beside it carries the brand.
 */
export function DialWordmark({
  className,
  style,
  turns = [0, 1, 2, 3],
  onTurn,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & {
  /** Each o's quarter, in quarter-turns from up (may exceed 3 to keep turning). */
  turns?: readonly number[];
  /** A pointer reached o `i` — a page can turn it. */
  onTurn?: (i: number) => void;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [o, setO] = React.useState<OMetrics>(DEFAULT_O);
  const [plain, setPlain] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const run = () => {
      if (!live) return;
      setPlain(parseFloat(getComputedStyle(el).fontSize) < DIAL_WORDMARK_MIN_PX);
      const m = measureO(el);
      if (m) setO(m);
    };
    run();
    document.fonts?.ready.then(run);
    return () => {
      live = false;
    };
  }, []);
  return (
    <span
      ref={ref}
      role="img"
      aria-label="solomotion"
      data-part="wordmark"
      className={className}
      style={{ fontFamily: "var(--font-display)", whiteSpace: "nowrap", lineHeight: 1, display: "inline-block", ...style }}
      {...rest}
    >
      {plain ? <span aria-hidden>solomotion</span> : WORDMARK_PARTS.map((p, i) =>
        "text" in p ? (
          <span key={i} aria-hidden>
            {p.text}
          </span>
        ) : (
          <DialO key={i} o={o} turn={turns[p.o] ?? p.o} onPoint={onTurn ? () => onTurn(p.o) : undefined} />
        ),
      )}
    </span>
  );
}
