"use client";

import * as React from "react";
import {
  lookGround,
  lookPoseAt,
  lookSpanMs,
  lookUnitCount,
  lookUnits,
  type ResolvedTemplate,
  type TextEffect,
  type TextStyle,
} from "@solomotion/core";
import { cn } from "@/lib/utils";
import { ensureFont, fontsVersion } from "../stage/render/fonts";
import { layerEffectStyle } from "../stage/render/layer-effect-css";

/**
 * A TEXT LOOK, PREVIEWED AS THE REAL THING.
 *
 * The card this replaced posed one `<span>` reading "Aa" through a generic
 * animation proxy, which described neither the typography nor the choreography
 * — a hundred looks whose whole difference is those two things all previewed
 * identically, and the browser degenerated into a list of names. A preview that
 * cannot tell two presets apart is not a preview.
 *
 * So this renders the look: its own words, its own face and weight and
 * tracking, its own colours, its per-glyph passes, its outline, its pill — and
 * animates them through `lookPoseAt`, which is `evalSpecAtUnit`, which is the
 * function the stage and the exporter call. Same units, same stagger, same
 * jitter, same scatter. What you hover is what you get.
 *
 * TWO DECISIONS CARRY IT:
 *
 * It renders at CANVAS SCALE and then CSS-scales the whole block down to fit.
 * A 140px headline is laid out at 140px, so an 8px shadow offset, a 3px
 * outline and a 26px glow keep their true relationship to the glyph — which is
 * most of what makes one look different from another. Re-authoring each of
 * those against a 100px tile would be a second set of numbers to keep in step,
 * and they would be wrong on the first look anyone tuned.
 *
 * And it is IDLE UNTIL HOVERED. `playing` gates the frame loop entirely; at
 * rest the block is parked on its settled pose, which is a static DOM tree with
 * no timers. A shelf of a hundred cards costs a hundred spans, and that is the
 * only budget that matters at library size.
 */

/** Leaves the specimen a little air inside the tile. */
const FIT_PADDING = 0.9;
/**
 * How much of a look's sample text a tile shows.
 *
 * A card is ~104px wide. A whole headline scaled to fit it is a grey smear —
 * you can see that something moved and nothing about the typeface, which is
 * half of what a look IS. Trimming to whole words keeps the letterforms at a
 * size the eye can actually read them, and the motion is unchanged: the same
 * stagger over fewer units is still the real choreography, not an impression
 * of one. A surface with room passes its own `text` and gets the lot.
 */
const SPECIMEN_CHARS = 16;
/** Beat held at the end of each loop so the eye can read the resting state. */
const HOLD_MS = 700;

export function TextLookPreview({
  look,
  playing,
  className,
  /** Overrides the look's own specimen — a bigger surface can afford more. */
  text,
}: {
  look: ResolvedTemplate;
  playing: boolean;
  className?: string;
  text?: string;
}) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const fitRef = React.useRef<HTMLDivElement>(null);
  const blockRef = React.useRef<HTMLDivElement>(null);
  const unitRefs = React.useRef<(HTMLSpanElement | null)[]>([]);

  const sample = text ?? specimen(look.sampleText || look.name);
  const spec = look.animations.in;
  const grain = spec?.unit ?? "line";

  const units = React.useMemo(() => lookUnits(sample, grain), [sample, grain]);
  const unitCount = React.useMemo(() => lookUnitCount(sample, grain), [sample, grain]);

  // The face has to be FETCHED before it can be shown, and the version bump is
  // what re-renders the cards that were waiting on it — otherwise every look
  // whose font had not been used yet previews in the fallback, which is the
  // one thing a typography browser must never do.
  const family = look.style.fontFamily;
  const weight = typeof look.style.fontWeight === "number" ? look.style.fontWeight : 400;
  const italic = look.style.italic === true;
  const fv = fontsVersion();
  React.useEffect(() => {
    if (typeof family === "string") ensureFont(family, { text: sample, weight, italic });
  }, [family, sample, weight, italic]);

  const [scale, setScale] = React.useState(0.1);

  // Fit is re-measured when the tile resizes, when the specimen changes and
  // when a font lands — the three moments the natural size can differ. Poses
  // are transforms, which do not affect layout, so a running animation never
  // perturbs the measurement.
  React.useEffect(() => {
    const box = boxRef.current;
    const block = blockRef.current;
    if (!box || !block) return;
    const measure = () => {
      const bw = box.clientWidth;
      const bh = box.clientHeight;
      const nw = block.offsetWidth;
      const nh = block.offsetHeight;
      if (!bw || !bh || !nw || !nh) return;
      setScale(Math.min(bw / nw, bh / nh) * FIT_PADDING);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(block);
    return () => ro.disconnect();
  }, [sample, look.id, fv]);

  // One clock for the whole specimen, sized to what the look actually takes —
  // a fixed loop cuts a slow cascade off mid-flight and holds a fast pop on a
  // still frame, and both read as a broken card rather than as a slow or fast
  // animation.
  const spanMs = React.useMemo(() => lookSpanMs(spec, unitCount), [spec, unitCount]);

  React.useEffect(() => {
    const nodes = unitRefs.current;
    if (!spec) {
      for (const n of nodes) if (n) resetPose(n);
      return;
    }
    if (!playing) {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n) pose(n, lookPoseAt(spec, units[i]!.index, unitCount, spanMs + 1, look.id));
      }
      return;
    }
    const cycle = Math.max(spanMs, 400) + HOLD_MS;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const localMs = (now - start) % cycle;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n) pose(n, lookPoseAt(spec, units[i]!.index, unitCount, localMs, look.id));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, spec, units, unitCount, spanMs, look.id]);

  const { block, span } = useLookCss(look);
  const ground = lookGround(look.palette);

  return (
    <div ref={boxRef} className={cn("relative flex size-full items-center justify-center overflow-hidden", className)}>
      {/* A look drawn for paper is previewed on paper — see `lookGround`. It
          paints only the art area, so the card's own chrome is untouched. */}
      {ground && <div className="absolute inset-0" style={{ background: ground }} />}
      <div
        ref={fitRef}
        className="absolute left-1/2 top-1/2 origin-center"
        // `max-content` is load-bearing: an absolutely-positioned box still
        // takes its containing block's width, so a 140px headline inside a
        // 104px tile SOFT-WRAPPED — one letter per line — and then the fit
        // scaled that column down. The specimen has to lay out at its natural
        // width and be scaled after; only the look's own newlines may break it.
        style={{ width: "max-content", transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        <div ref={blockRef} key={fv} style={block}>
          {units.map((u, i) => (
            <span
              key={u.key}
              ref={(el) => {
                unitRefs.current[i] = el;
              }}
              style={span}
            >
              {u.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Whole words up to the cap, and never fewer than one. */
function specimen(text: string): string {
  const firstLine = text.split("\n")[0] ?? text;
  if (firstLine.length <= SPECIMEN_CHARS) return firstLine;
  const words = firstLine.split(/\s+/);
  let out = words[0] ?? firstLine;
  for (const w of words.slice(1)) {
    if (out.length + 1 + w.length > SPECIMEN_CHARS) break;
    out += ` ${w}`;
  }
  return out;
}

/** The one place a `GlyphVisual` becomes CSS on a preview unit. */
function pose(
  el: HTMLElement,
  v: { opacity: number; dx: number; dy: number; scale: number; rotation: number; blur: number },
): void {
  el.style.opacity = String(v.opacity);
  el.style.transform = `translate(${v.dx}px, ${v.dy}px) rotate(${v.rotation}deg) scale(${v.scale})`;
  el.style.filter = v.blur > 0.2 ? `blur(${v.blur}px)` : "";
}

function resetPose(el: HTMLElement): void {
  el.style.opacity = "1";
  el.style.transform = "";
  el.style.filter = "";
}

/* -------------------------------------------------------------------------- */

/**
 * A resolved look as CSS.
 *
 * Split into the BLOCK (typography, pill, layer passes over the whole thing)
 * and the SPAN (per-glyph passes, which have to ride the units so they move
 * with them). That split is the same one the renderer makes — a glow drawn per
 * glyph and a glow drawn over the finished layer are different pictures — and
 * getting it wrong here is what would make an outline sit still while its
 * letters flew in.
 *
 * The layer passes CSS can honestly stand in for are the ones that are a
 * silhouette operation: a stroke, a shadow, a blur, a bloom, a channel split.
 * Grain, scanlines and noise are per-pixel and are deliberately not faked —
 * a wrong texture on a 100px tile teaches the eye something untrue, and their
 * looks are already distinguishable by everything else they carry.
 */
function useLookCss(look: ResolvedTemplate): { block: React.CSSProperties; span: React.CSSProperties } {
  return React.useMemo(() => {
    const s = look.style as Partial<TextStyle>;
    const glyphShadows = (s.textEffects ?? []).flatMap((fx) => textEffectShadows(fx, s.color ?? "#fff"));

    const block: React.CSSProperties = {
      fontFamily: typeof s.fontFamily === "string" ? `"${s.fontFamily}", system-ui` : undefined,
      fontSize: typeof s.fontSize === "number" ? s.fontSize : 96,
      fontWeight: typeof s.fontWeight === "number" ? s.fontWeight : 500,
      fontStyle: s.italic ? "italic" : undefined,
      letterSpacing: s.letterSpacing ? `${s.letterSpacing}px` : undefined,
      lineHeight: s.lineHeight ?? 1.15,
      textAlign: s.align ?? "left",
      textTransform: cssCase(s.textCase),
      textDecoration: cssDecoration(s.decoration),
      color: s.color,
      opacity: s.opacity ?? 1,
      whiteSpace: "pre-wrap",
      // The pill is sized from the run's own box in the renderer too, so a
      // background on the inline flow is the same picture — and it wraps per
      // line the way the real one does.
      ...(s.highlight
        ? {
            display: "inline",
            background: s.highlight.color,
            borderRadius: s.highlight.radius,
            padding: `${s.highlight.paddingY}px ${s.highlight.paddingX}px`,
            boxDecorationBreak: "clone",
            WebkitBoxDecorationBreak: "clone",
          }
        : null),
      ...layerEffectStyle(look.effects),
    };

    const span: React.CSSProperties = {
      display: "inline-block",
      willChange: "transform, opacity",
      ...(glyphShadows.length ? { textShadow: glyphShadows.join(", ") } : null),
    };

    return { block, span };
  }, [look]);
}

const cssCase = (c: TextStyle["textCase"] | undefined) =>
  c === "upper" ? ("uppercase" as const)
  : c === "lower" ? ("lowercase" as const)
  : c === "title" ? ("capitalize" as const)
  : undefined;

const cssDecoration = (d: TextStyle["decoration"] | undefined) =>
  d === "underline" ? "underline" : d === "strikethrough" ? "line-through" : undefined;

/** A per-glyph pass as one or more `text-shadow` layers. */
function textEffectShadows(fx: TextEffect, glyphColor: string): string[] {
  if (!fx.enabled) return [];
  // A `text` source FOLLOWS THE GLYPH — the same rule the renderer applies,
  // and what makes a halo read as light coming off this letter rather than as
  // a second object behind it.
  const color = withOpacity(fx.source === "text" ? glyphColor : fx.color, fx.opacity);
  switch (fx.type) {
    case "shadow":
      return [`${fx.x}px ${fx.y}px ${fx.blur}px ${color}`];
    case "glow": {
      // Intensity is how many times the halo is laid down — the same trick the
      // renderer uses to get brightness without a second pass.
      const layers = Math.max(1, Math.min(4, Math.round(fx.intensity * 2)));
      return Array.from({ length: layers }, () => `0 0 ${fx.radius}px ${color}`);
    }
    case "extrude": {
      const rad = (fx.angle * Math.PI) / 180;
      const steps = Math.max(2, Math.min(12, Math.round(fx.length / 3)));
      return Array.from({ length: steps }, (_, i) => {
        const d = ((i + 1) / steps) * fx.length;
        return `${(Math.cos(rad) * d).toFixed(1)}px ${(Math.sin(rad) * d).toFixed(1)}px 0 ${color}`;
      }).reverse();
    }
    case "echo": {
      const rad = (fx.angle * Math.PI) / 180;
      const count = Math.max(1, Math.min(12, Math.round(fx.count)));
      return Array.from({ length: count }, (_, i) => {
        const n = i + 1;
        const t = count === 1 ? 1 : i / (count - 1);
        const c = withOpacity(fx.source === "text" ? glyphColor : fx.color, fx.opacity * (1 - fx.fade * t));
        return `${(Math.cos(rad) * fx.distance * n).toFixed(1)}px ${(Math.sin(rad) * fx.distance * n).toFixed(1)}px 0 ${c}`;
      }).reverse();
    }
  }
}

/** Fold an effect's own 0..1 opacity into its colour. */
function withOpacity(color: string, opacity: number): string {
  if (opacity >= 0.999) return color;
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return `${color}${Math.round(opacity * 255).toString(16).padStart(2, "0")}`;
  }
  return color;
}
