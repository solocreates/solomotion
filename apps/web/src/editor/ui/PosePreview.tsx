"use client";

import * as React from "react";
import {
  GLYPH_IDENTITY,
  evaluateEasing,
  getPreset,
  getTransitionPreset,
  strandWindows,
  transitionMixAt,
  type AnimationPresetDef,
  type Easing,
  type GlyphVisual,
  type Reveal,
} from "@solomotion/core";
import { cn } from "@/lib/utils";

/**
 * THE preview for anything that animates a layer — the inspector's preset
 * gallery, the library's animation cards and the transition cards all render
 * this one component.
 *
 * It is driven by the HEADLESS evaluator, never by hand-written CSS: the pose
 * on screen is the literal output of `evalIn`/`evalOut`/`transitionMixAt` at
 * that instant, sampled per frame. That is the whole point — a preview built
 * from a parallel set of keyframes is a second implementation that drifts the
 * moment anyone tunes a preset, and it is also what had the library's cards
 * animating a text glyph for animations that are in fact layer-agnostic.
 *
 * The proxy being posed is deliberately generic (a chip), because a layer
 * animation applies to a shape, an image, a video or a nested comp just as
 * readily as to text. `sample="text"` exists only for the text animator, where
 * per-glyph motion genuinely needs glyphs to read.
 */

/** Preset distances are authored in canvas px; preview tiles are tiny. */
const PREVIEW_SCALE = 0.4;
/** Settle time at the end of each loop, so the eye can read the resting state. */
const HOLD_MS = 600;

function defaultParams(def: AnimationPresetDef): Record<string, number> {
  return Object.fromEntries(def.params.map((p) => [p.key, p.defaultValue]));
}

/** Write a pose onto an element. The one place a GlyphVisual becomes CSS. */
export function applyPose(el: HTMLElement, pose: GlyphVisual, scale = PREVIEW_SCALE): void {
  el.style.opacity = String(pose.opacity);
  el.style.transform = `translate(${pose.dx * scale}px, ${pose.dy * scale}px) rotate(${pose.rotation}deg) scale(${pose.scale})`;
  el.style.filter = pose.blur > 0.2 ? `blur(${pose.blur * scale}px)` : "";
}

interface PoseFrame {
  a: GlyphVisual;
  b?: GlyphVisual;
  veil?: number;
  /** The reveal channel, when the preset has one — drives the strand chip. */
  reveal?: Reveal | null;
}

/**
 * The strands the draw-on chip previews: three lines of different lengths, so
 * "together", "one by one" and "staggered" read differently at a glance. Each
 * carries `pathLength="1"`, which makes a window a dash in unit space.
 */
const STRAND_LENGTHS = [16, 10, 20];

/** Everything in an SVG that has a length to dash along. */
const STRAND_SELECTOR = "path, line, polyline, polygon, circle, ellipse, rect";

/**
 * Write a reveal onto an SVG's strands. The one place a window becomes SVG.
 * Every strand is normalised to unit length (`pathLength="1"`), so a window is
 * a dash in unit space whatever the geometry; the chip's three strands carry
 * authored lengths, any other artwork (an icon tile) is read as equal strands.
 */
export function applyReveal(strands: ArrayLike<SVGElement>, reveal: Reveal | null, lengths?: readonly number[]): void {
  const n = strands.length;
  const ls = lengths && lengths.length === n ? lengths : Array.from({ length: n }, () => 1);
  const windows = strandWindows(
    ls,
    reveal ?? { progress: 1, order: "together", stagger: 0, topFirst: false, origin: 0, direction: "forward", fill: "keep", pen: 2 },
  );
  for (let i = 0; i < n; i++) {
    const el = strands[i]!;
    if (!el.hasAttribute("pathLength")) el.setAttribute("pathLength", "1");
    const [a, b, offset] = windows[i] ?? [0, 1, 0];
    // A dash of the inked span in a unit-length pattern; the offset rotates it
    // the way the trim stage does, and the pattern repeating is the wrap.
    el.style.strokeDasharray = `${Math.max(0, b - a)} 1`;
    el.style.strokeDashoffset = String(-(a + offset));
  }
}

/**
 * Drive one or two elements from a pose function on a loop. Shared by the
 * single-layer previews and the two-panel transition previews, which differ
 * only in how many elements the same clock poses.
 */
function usePoseLoop(
  playing: boolean,
  durationMs: number,
  poseAt: (t: number) => PoseFrame,
  /**
   * Where the preview PARKS when it is not playing. The choice matters: an
   * animation rests at 1, its settled state, which is the readable one. A
   * transition rests at its MIDPOINT, because that is the only instant where a
   * wipe shows its edge and an iris its circle — parked at either end, every
   * transition in the gallery would look identical.
   */
  restAt: number,
  refs: {
    a: React.RefObject<HTMLElement | null>;
    b?: React.RefObject<HTMLElement | null>;
    veil?: React.RefObject<HTMLElement | null>;
    /** The element holding the strands (an `<svg>`, or a wrapper around one). */
    strands?: React.RefObject<Element | null>;
    /** Authored strand lengths, when the host knows them. */
    strandLengths?: readonly number[];
  },
  /** Preset offsets are canvas px; each surface says how big its stage is. */
  scale = PREVIEW_SCALE,
  /**
   * The pose held during the beat at the end of each loop. Separate from
   * `restAt` because they answer different questions, and for an EXIT they
   * differ: an exit finishes at t=1 (gone), so holding there parks the loop on
   * an empty frame and the preview reads as a failed load. It has to settle
   * back to the layer being PRESENT, which is t=0.
   */
  holdAt = 1,
): void {
  // The pose function is rebuilt on every render by its caller; holding it in a
  // ref keeps the loop from being torn down and restarted each time.
  const poseRef = React.useRef(poseAt);
  poseRef.current = poseAt;

  React.useEffect(() => {
    const a = refs.a.current;
    if (!a) return;
    const b = refs.b?.current ?? null;
    const veil = refs.veil?.current ?? null;
    const strands = refs.strands?.current?.querySelectorAll<SVGElement>(STRAND_SELECTOR) ?? null;
    const lengths = refs.strandLengths;
    if (!playing) {
      const rest = poseRef.current(restAt);
      applyPose(a, rest.a, scale);
      if (b && rest.b) applyPose(b, rest.b, scale);
      if (veil) veil.style.opacity = String(rest.veil ?? 0);
      if (strands) applyReveal(strands, rest.reveal ?? null, lengths);
      return;
    }
    const dur = Math.max(durationMs, 350);
    const cycle = dur + HOLD_MS;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = (now - start) % cycle;
      const t = elapsed < dur ? elapsed / dur : holdAt;
      const out = poseRef.current(t);
      applyPose(a, out.a, scale);
      if (b && out.b) applyPose(b, out.b, scale);
      if (veil) veil.style.opacity = String(out.veil ?? 0);
      if (strands) applyReveal(strands, out.reveal ?? null, lengths);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // The refs are stable; re-running on them would restart the loop forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, durationMs, restAt, scale, holdAt]);
}

/**
 * Play once on mount, then rest — so a grid of cards introduces itself without
 * a wall of looping motion, and hovering restarts it. Returns whether the
 * caller should be animating right now.
 */
export function useIntroPlay(hovered: boolean, durationMs = 2000): boolean {
  const [intro, setIntro] = React.useState(true);
  React.useEffect(() => {
    const t = window.setTimeout(() => setIntro(false), durationMs);
    return () => window.clearTimeout(t);
  }, [durationMs]);
  return hovered || intro;
}

/** A single layer animating in or out — the animation preset preview. */
export function AnimationPreview({
  presetId,
  phase = "in",
  sample = "layer",
  text = "Aa",
  playing,
  className,
  spec,
  scale,
  chip,
  art,
}: {
  presetId: string;
  phase?: "in" | "out";
  sample?: "layer" | "text";
  /** The glyphs to pose. A text LOOK previews its own words in its own face —
   *  a preview that shows the motion but not the typography is describing half
   *  of what you are about to apply. */
  text?: string;
  playing: boolean;
  className?: string;
  /**
   * The TUNED animation, when one exists. A gallery tile previews the preset's
   * defaults (there is no tuning yet), but the inspector previews the thing the
   * layer will actually do — drag Distance and the proxy moves further, change
   * the easing and it lands differently. Without this the panel's own preview
   * was the one picture in the app guaranteed to disagree with the canvas.
   */
  spec?: { durationMs: number; easing: Easing; params: Record<string, number> };
  /** Canvas-px → stage-px. Bigger stages read the preset's real distances. */
  scale?: number;
  /** Replaces the default proxy chip — a stage draws its own, larger one. */
  chip?: React.ReactNode;
  /**
   * REAL artwork to preview on — an inline SVG (an icon). A pose moves it; a
   * draw-on inks its own strands instead of the sample chip. This is how a
   * tile previews the exact layer it would drop.
   */
  art?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const strandsRef = React.useRef<HTMLDivElement>(null);
  const def = getPreset(presetId);
  const draws = !!def?.reveal;

  usePoseLoop(
    playing && !!def,
    spec?.durationMs ?? def?.defaultDurationMs ?? 450,
    (t) => {
      if (!def) return { a: GLYPH_IDENTITY };
      const params = spec ? { ...defaultParams(def), ...spec.params } : defaultParams(def);
      const easing = spec?.easing ?? def.defaultEasing;
      const eased = evaluateEasing(easing, t);
      // Out follows the same contract the renderer uses: an explicit evalOut
      // when the preset has one, otherwise its in-animation reversed.
      const reversed = evaluateEasing(easing, 1 - t);
      const a =
        phase === "in" ? def.evalIn(eased, params) : def.evalOut ? def.evalOut(eased, params) : def.evalIn(reversed, params);
      const reveal = def.reveal ? def.reveal(phase === "in" ? eased : reversed, params) : undefined;
      return { a, reveal };
    },
    // An entrance settles at 1 (arrived); an exit settles at 0 (not yet gone).
    // Both are "the layer, in place" — the only readable frame to park on.
    phase === "in" ? 1 : 0,
    { a: ref, strands: strandsRef, strandLengths: art ? undefined : STRAND_LENGTHS },
    scale,
    phase === "in" ? 1 : 0,
  );

  return (
    <div className={cn("flex items-center justify-center overflow-hidden", className)}>
      {draws ? (
        // A draw-on has nothing to pose; it has lines to ink. Real artwork
        // inks its own strands; otherwise the sample chip's three.
        <div ref={ref} className="flex items-center justify-center">
          <div ref={strandsRef} className="contents">
            {art ?? <StrandChip large={!!chip} />}
          </div>
        </div>
      ) : art ? (
        <div ref={ref}>{art}</div>
      ) : chip ? (
        <div ref={ref}>{chip}</div>
      ) : sample === "text" ? (
        <span ref={ref} className="whitespace-nowrap text-xs font-semibold text-foreground/85">
          {text}
        </span>
      ) : (
        <div ref={ref} className="size-4 rounded-[4px] bg-primary/75" />
      )}
    </div>
  );
}

/**
 * Three strands the draw-on inks: a squiggle, a short line, a loop. Lengths
 * match `STRAND_LENGTHS` in spirit only — `pathLength="1"` normalises each, so
 * the ratios that matter are the ones the loop computes.
 */
function StrandChip({ large }: { large: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("text-primary/85", large ? "size-9" : "size-5")}
      fill="none"
      stroke="currentColor"
      strokeWidth={large ? 1.75 : 2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path pathLength={1} d="M3 8c3-4 6 4 9 0s6 4 9 0" />
      <path pathLength={1} d="M5 14h14" />
      <path pathLength={1} d="M4 20c4-6 12-6 16 0" />
    </svg>
  );
}

/**
 * Two panels crossing — the transition preview. The poses and the veil come
 * straight from the evaluator; only the stencil is approximated, because a
 * clip-path is all a 100px tile needs to make the shape of a wipe legible.
 */
export function TransitionPreview({
  presetId,
  playing,
  className,
}: {
  presetId: string;
  playing: boolean;
  className?: string;
}) {
  const aRef = React.useRef<HTMLDivElement>(null);
  const bRef = React.useRef<HTMLDivElement>(null);
  const veilRef = React.useRef<HTMLDivElement>(null);
  const wipeRef = React.useRef<HTMLDivElement>(null);
  const def = getTransitionPreset(presetId);

  const draft = React.useMemo(
    () =>
      def
        ? {
            id: "preview",
            preset: def.id,
            frameId: "",
            aClipId: "a",
            bClipId: "b",
            durationMs: def.defaultDurationMs,
            splitMs: def.defaultDurationMs / 2,
            easing: def.defaultEasing,
            params: Object.fromEntries(def.params.map((p) => [p.key, p.defaultValue])),
            color: null,
          }
        : null,
    [def],
  );

  usePoseLoop(
    playing && !!draft,
    def?.defaultDurationMs ?? 500,
    (t) => {
      if (!draft) return { a: GLYPH_IDENTITY };
      const op = transitionMixAt(draft, t);
      const wipe = wipeRef.current;
      if (wipe) wipe.style.clipPath = op.wipe ? previewClipPath(op.wipe.kind, op.wipe.progress) : "";
      return { a: op.a, b: op.b, veil: op.veil };
    },
    0.5,
    { a: aRef, b: bRef, veil: veilRef },
  );

  return (
    <div className={cn("relative overflow-hidden", className)}>
      <div
        ref={aRef}
        className="absolute inset-0 flex items-center justify-center bg-linear-to-br from-slate-500 to-slate-700 text-[10px] font-bold text-white/80"
      >
        A
      </div>
      <div ref={wipeRef} className="absolute inset-0">
        <div
          ref={bRef}
          className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white/90"
          style={{ backgroundImage: "linear-gradient(135deg,#ff8732,#ff2885)" }}
        >
          B
        </div>
      </div>
      <div
        ref={veilRef}
        className="absolute inset-0 opacity-0"
        style={{ background: presetId === "dip-to-white" ? "#fff" : "#000" }}
      />
    </div>
  );
}

/** A tile-sized approximation of each stencil family. */
function previewClipPath(kind: string, progress: number): string {
  const pct = Math.round(progress * 100);
  if (kind === "circle") return `circle(${Math.round(progress * 75)}% at 50% 50%)`;
  if (kind === "barn") return `inset(0 ${50 - pct / 2}% 0 ${50 - pct / 2}%)`;
  if (kind === "clock") {
    const angle = progress * 360;
    const points = ["50% 50%", "50% 0"];
    for (let a = 0; a <= angle; a += 15) points.push(polar(a));
    points.push(polar(angle));
    return `polygon(${points.join(",")})`;
  }
  return `inset(0 ${100 - pct}% 0 0)`;
}

/** A point on the tile's edge at `deg` clockwise from 12 o'clock. */
function polar(deg: number): string {
  const r = (deg * Math.PI) / 180;
  return `${50 + Math.sin(r) * 75}% ${50 - Math.cos(r) * 75}%`;
}
