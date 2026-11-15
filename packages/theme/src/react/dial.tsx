"use client";

import * as React from "react";
import { DEFAULT_O, DIAL_DIRECTIONS, moonAt, oMetricsFrom, orbitRest, stepOrbit, wedgePath, WORDMARK_PARTS, type OMetrics } from "../dial";

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
 * The loader: the same dial, its quarter clicking round a beat at a time
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

/** Within a hundredth of an em: the same o, so no re-render and no jump. */
function sameO(a: OMetrics, b: OMetrics): boolean {
  return (Object.keys(a) as (keyof OMetrics)[]).every((k) => Math.abs(a[k] - b[k]) < 1);
}

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
  if (!document.fonts || document.fonts.check(`${cs.fontWeight} 100px ${cs.fontFamily}`)) oCache.set(key, o);
  return o;
}

/** One o. The quarter is drawn pointing up and TURNED, so a change of turn is
 *  a CSS transition (`parts.css`), not a new path. */
function DialO({ o, index, turn, onPoint }: { o: OMetrics; index: number; turn: number; onPoint?: () => void }) {
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
        style={
          {
            transform: `rotate(${turn * 90}deg)`,
            transformOrigin: `${o.cx}px ${o.cy}px`,
            "--o-turn": `${turn * 90}deg`,
            "--o-i": index,
          } as React.CSSProperties
        }
      />
    </svg>
  );
}

/**
 * Below this size the theme's quiet disc sinks into the ground and only the
 * bright quarter survives ("s•l•m•ti•n" at 16px). So a SMALL wordmark keeps
 * its dials but wears a denser disc (`parts.css` → `[data-size="small"]`):
 * the lockup stays the logo in a top bar, never the name in plain type.
 */
export const DIAL_WORDMARK_MIN_PX = 28;
/** Under this the o's are a few pixels across: the name is set plainly. */
export const DIAL_WORDMARK_FLOOR_PX = 12;

/**
 * The wordmark: "solomotion" set in the display face, each o replaced by a
 * dial placed over the font's REAL o — measured from the face that rendered,
 * so it is right in any theme's display font. Below `DIAL_WORDMARK_MIN_PX`
 * it is the small lockup (denser discs); only under the floor is it plain.
 */
export function DialWordmark({
  className,
  style,
  turns = [0, 1, 2, 3],
  onTurn,
  turning = false,
  beat = 400,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & {
  /**
   * The wordmark IS the loader: every o clicks round a quarter per beat,
   * together. A splash shows this instead of the name plus a spinner.
   */
  turning?: boolean;
  /** One quarter, in ms, while `turning`. */
  beat?: number;
  /** Each o's quarter, in quarter-turns from up (may exceed 3 to keep turning). */
  turns?: readonly number[];
  /** A pointer reached o `i` — a page can turn it. */
  onTurn?: (i: number) => void;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [o, setO] = React.useState<OMetrics>(DEFAULT_O);
  const [size, setSize] = React.useState<"plain" | "small" | "display">("display");
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const px = parseFloat(getComputedStyle(el).fontSize);
    setSize(px < DIAL_WORDMARK_FLOOR_PX ? "plain" : px < DIAL_WORDMARK_MIN_PX ? "small" : "display");
    // ONE placement, from the REAL face. Placing the o's from the fallback
    // face and again when the webfont lands moved them twice on every boot
    // (the splash's "double reload"); until the face is real the default
    // metrics stand, and a measurement that matches them changes nothing.
    const place = () => {
      if (!live) return;
      const m = measureO(el);
      if (m) setO((prev) => (sameO(prev, m) ? prev : m));
    };
    const cs = getComputedStyle(el);
    const font = `${cs.fontWeight} 100px ${cs.fontFamily}`;
    if (!document.fonts || document.fonts.check(font)) place();
    else document.fonts.load(font).then(place, place);
    return () => {
      live = false;
    };
  }, []);
  return (
    <span
      ref={ref}
      role="img"
      aria-label={turning ? "solomotion, loading" : "solomotion"}
      aria-busy={turning || undefined}
      data-part="wordmark"
      data-turning={turning ? "" : undefined}
      data-size={size === "small" ? "small" : undefined}
      className={className}
      style={{ fontFamily: "var(--font-display)", whiteSpace: "nowrap", lineHeight: 1, display: "inline-block", "--dial-beat": `${beat * 4}ms`, ...style } as React.CSSProperties}
      {...rest}
    >
      {size === "plain" ? <span aria-hidden>solomotion</span> : WORDMARK_PARTS.map((p, i) =>
        "text" in p ? (
          <span key={i} aria-hidden>
            {p.text}
          </span>
        ) : (
          <DialO key={i} o={o} index={p.o} turn={turns[p.o] ?? p.o} onPoint={onTurn ? () => onTurn(p.o) : undefined} />
        ),
      )}
    </span>
  );
}

/**
 * THE ORBIT, drawn (`stepOrbit` in ../dial is the physics): the centre dial
 * turning, a still ring of moons each spinning on its own, caught to face the
 * centre as its quarter sweeps past. `speed` is the centre's turns per second;
 * change it and it eases there. `lit` moons are bright, the rest wait dim. The
 * loop writes transforms straight to the DOM (no React render per frame), runs
 * only while on screen and visible, and under reduced motion every moon simply
 * faces the centre.
 */
export function DialOrbit({ size = "100%", moons = 12, lit = moons, speed = 0.25, className, style, label }: { size?: number | string; moons?: number; lit?: number; speed?: number; className?: string; style?: React.CSSProperties; label?: string }) {
  const root = React.useRef<SVGSVGElement>(null);
  const spinRef = React.useRef<SVGPathElement>(null);
  const faceRefs = React.useRef<(SVGPathElement | null)[]>([]);
  const speedRef = React.useRef(speed);
  React.useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  React.useEffect(() => {
    const svg = root.current;
    if (!svg || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let s = orbitRest(moons);
    let raf = 0;
    let last = 0;
    let visible = true;
    const paint = () => {
      spinRef.current?.setAttribute("transform", `rotate(${s.spin.toFixed(2)} 100 100)`);
      faceRefs.current.forEach((el, i) => {
        const m = s.moons[i];
        if (el && m) el.setAttribute("transform", `rotate(${m.a.toFixed(2)} ${el.dataset.cx} ${el.dataset.cy})`);
      });
    };
    const tick = (now: number) => {
      raf = 0;
      if (!visible || document.hidden) {
        last = 0;
        return;
      }
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      s = stepOrbit(s, speedRef.current, dt);
      paint();
      raf = requestAnimationFrame(tick);
    };
    const wake = () => {
      if (!raf && visible && !document.hidden) raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      wake();
    });
    io.observe(svg);
    document.addEventListener("visibilitychange", wake);
    wake();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", wake);
    };
  }, [moons]);
  const R = 84;
  return (
    <svg ref={root} width={size} height={size} viewBox="0 0 200 200" className={className} style={{ overflow: "visible", ...style }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {Array.from({ length: moons }, (_, i) => {
        const a = (moonAt(i, moons) - 90) * (Math.PI / 180);
        const cx = +(100 + Math.cos(a) * R).toFixed(2);
        const cy = +(100 + Math.sin(a) * R).toFixed(2);
        const on = i < lit;
        return (
          <g key={i} style={{ opacity: on ? 1 : 0.28, transform: `scale(${on ? 1 : 0.72})`, transformOrigin: `${cx}px ${cy}px`, transition: "opacity 300ms, transform 420ms cubic-bezier(0.34, 1.5, 0.5, 1)" }}>
            <circle cx={cx} cy={cy} r="9" fill={DISC} />
            {/* Drawn pointing up and TURNED, so the still pose (reduced motion) faces the centre. */}
            <path ref={(el) => void (faceRefs.current[i] = el)} data-cx={cx} data-cy={cy} d={wedgePath(cx, cy, 9, 9, 0)} transform={`rotate(${moonAt(i, moons) + 180} ${cx} ${cy})`} fill={WEDGE} />
          </g>
        );
      })}
      <circle cx="100" cy="100" r="46" fill={DISC} />
      <path ref={spinRef} d={wedgePath(100, 100, 46, 46, 0)} fill={WEDGE} />
    </svg>
  );
}
