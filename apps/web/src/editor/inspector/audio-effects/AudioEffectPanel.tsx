"use client";

import * as React from "react";
import {
  AFX,
  biquadMagnitudeDb,
  bitcrushCurve,
  effectFieldVisible,
  lfoValue,
  saturationCurve,
  type AudioEffect,
  type Clip,
  type EffectFieldDef,
  type BiquadShape,
  type KeyframeValue,
  type LfoShape,
  type SaturatorCharacter,
} from "@solomotion/core";
import { ChevronRight } from "lucide-react";
import { PanelColumn, PanelColumns } from "@/components/ui/panel-columns";
import { Switch } from "@/components/ui/switch";
import { Knob } from "@/components/ui/knob";
import { cn } from "@/lib/utils";
import { useEffectiveValue } from "./../animatable";
import { PropertyBindingMenu } from "./../property-binding";
import { EqEditor } from "./../EqEditor";
import { ReverbRoom } from "./ReverbRoom";

/**
 * THE SOUND CARD — one layout for every audio effect: a picture of what the
 * effect is DOING on the left, the controls that shape it on the right.
 *
 * The pictures are not decoration and they are not illustrations drawn to
 * resemble the effect. Each one plots the SAME maths the audio runs through:
 * the saturator's curve is literally the lookup table in the WaveShaperNode,
 * the compressor's is its transfer function, the echo's taps are its real
 * delay times and feedback levels, the reverb's rays are the reflections that
 * reach the convolver. So when a control moves, the picture moves because the
 * SOUND changed — not because something was animated to suggest it did.
 *
 * That is what makes a plugin feel like an instrument instead of a form. It is
 * also, usefully, free: the functions already existed for the audio path.
 *
 * Controls are knobs, never bare sliders or number rows. A row of inputs is a
 * spreadsheet; a mixing surface is knobs, and the muscle memory a sound person
 * already has is worth more than the pixels a slider saves.
 */

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

export interface AudioPanelProps {
  clip: Clip;
  effect: AudioEffect;
  onCommit: (e: AudioEffect, f: EffectFieldDef, v: KeyframeValue, label: string) => void;
  onToggle: (key: string, value: boolean, label: string) => void;
  /** Raw path write — the EQ's band paths nest deeper than registry fields. */
  onCommitPath: (label: string, path: string, v: KeyframeValue, mergeKey?: string) => void;
}

export function AudioEffectPanel(props: AudioPanelProps) {
  const { clip, effect } = props;
  const def = AFX.def(effect.type);
  // Whether there is a settings column at all is DERIVED, not decided per
  // effect. The equaliser declares no registry fields — its bands are a list
  // and the curve is the whole editor — so it was rendering an empty half of a
  // window. An effect whose entire UI is its picture gets the whole width.
  const hasControls = (def?.fields.length ?? 0) > 0 || (def?.toggles?.length ?? 0) > 0;

  if (!hasControls) {
    // NO SCROLLER. An effect whose whole UI is its picture (the equaliser) wants
    // the height, not a box to grow inside one: a percentage height inside a
    // Radix viewport resolves to auto — the viewport is not a definite-height
    // ancestor — so `h-full` there silently became "as tall as my content" and
    // the column overflowed the window by exactly its own overshoot. Handing it
    // the box directly is both simpler and the only version that can be right.
    return (
      <div className="h-full min-h-0 min-w-0">
        <Hero {...props} />
      </div>
    );
  }

  return (
    // THE WINDOW SETS THE HEIGHT. Both columns are 100% of it, and each scrolls
    // on its own.
    //
    // This used to be the other way round: the picture column defined the
    // height and the settings column was pinned to it with `absolute inset-0`
    // plus a raw `overflow-y-auto`. Two things followed from that, and they are
    // the two complaints. The panel could not answer a window RESIZE, because
    // its height was already decided by its own content before the window was
    // consulted — so dragging the window taller left grey below the picture and
    // dragging it shorter clipped the picture off. And the raw overflow drew a
    // native scrollbar inside a window whose every other scroller is the styled
    // one, which is exactly the "still has an overflow-y" the panel looked like.
    //
    // A grid row of `min-h-0` columns inside a `h-full` box is the whole fix:
    // the row is as tall as the window, each column is as tall as the row, and
    // each hands its overflow to a real `ScrollArea`. Fourteen knobs or four,
    // 300px of window or 900, it is the same layout and it tracks the drag live.
    //
    // Below the breakpoint there is no second column, so the grid collapses to
    // one and the single scroller carries picture and knobs together.
    // The container decides the height and each column scrolls inside it —
    // `PanelColumns` owns that rule now, including the three ways it kept
    // getting broken by hand. Below the breakpoint there is no second column,
    // so the grid collapses to one and the single scroller carries the picture
    // and the knobs together.
    <PanelColumns className="grid-cols-1 gap-x-4 @[560px]:grid-cols-[minmax(0,1fr)_minmax(226px,0.8fr)]">
      <PanelColumn viewportClassName="pr-1">
        <div className="min-w-0 space-y-2 pb-2">
          <Hero {...props} />
          <EffectToggles effect={effect} onToggle={props.onToggle} />
          {/* Under the breakpoint the knobs ride in this same scroller, because
              there is no second column for them to live in. */}
          <div className="@[560px]:hidden">
            <KnobGrid clip={clip} effect={effect} onCommit={props.onCommit} />
          </div>
        </div>
      </PanelColumn>
      <PanelColumn hideBelow="hidden @[560px]:flex" viewportClassName="pr-1">
        <KnobGrid clip={clip} effect={effect} onCommit={props.onCommit} />
      </PanelColumn>
    </PanelColumns>
  );
}

function Hero({ clip, effect, onCommit, onCommitPath }: AudioPanelProps) {
  if (effect.type === "eq") return <EqEditor clip={clip} effect={effect} commit={onCommitPath} />;
  if (effect.type === "reverb") return <ReverbRoom clip={clip} effect={effect} onCommit={onCommit} />;
  return <Simulation clip={clip} effect={effect} />;
}

// ── The simulations ──────────────────────────────────────────────────────────

/** Read a field's value the way the renderer will — keyframes included. */
function useField(clip: Clip, effect: AudioEffect, key: string): number {
  const base = (effect as unknown as Record<string, unknown>)[key];
  return useEffectiveValue(clip, AFX.path(effect.id, key), typeof base === "number" ? base : 0) as number;
}

function Simulation({ clip, effect }: { clip: Clip; effect: AudioEffect }) {
  switch (effect.type) {
    case "echo":
      return <EchoTaps clip={clip} effect={effect} />;
    case "compressor":
      return <CompressorCurve clip={clip} effect={effect} />;
    case "filter":
      return <FilterResponse clip={clip} effect={effect} />;
    case "chorus":
      return <ChorusScope clip={clip} effect={effect} />;
    case "phaser":
      return <PhaserScope clip={clip} effect={effect} />;
    case "tremolo":
      return <TremoloScope clip={clip} effect={effect} />;
    case "ringMod":
      return <RingScope clip={clip} effect={effect} />;
    case "bitcrush":
      return <CrushCurve clip={clip} effect={effect} />;
    case "stereo":
      return <StereoImage clip={clip} effect={effect} />;
    default:
      return <SaturatorCurve clip={clip} effect={effect} />;
  }
}

/** A select field's value straight off the instance (modes never keyframe). */
function modeOf(effect: AudioEffect, key: string, fallback: string): string {
  const v = (effect as unknown as Record<string, unknown>)[key];
  return typeof v === "string" ? v : fallback;
}

const shapeOf = (v: string): LfoShape => (v === "triangle" || v === "square" || v === "sawtooth" ? v : "sine");

/**
 * The scope frame. It fills the picture column, and the picture column is what
 * sets the window's height — so this is the one thing in the panel allowed to
 * be exactly as big as it wants to be.
 */
const FRAME =
  "relative w-full overflow-hidden rounded-lg border border-border/60 bg-gradient-to-b from-primary/[0.05] via-background/40 to-black/50";

/**
 * ECHO — the actual repeats, on a real time axis.
 *
 * Tap n lands at n × time with amplitude feedbackⁿ, which is exactly what the
 * delay line does. Ping-pong splits them across two lanes because that is what
 * ping-pong IS. The pulse that runs along the taps is on a CSS animation with a
 * staggered delay per tap, so it costs no React renders during playback.
 */
function EchoTaps({ clip, effect }: { clip: Clip; effect: AudioEffect }) {
  const timeMs = useField(clip, effect, "timeMs");
  const feedback = useField(clip, effect, "feedback");
  const toneHz = useField(clip, effect, "toneHz");
  const mix = useField(clip, effect, "mix");
  const pingPong = (effect as unknown as { pingPong?: boolean }).pingPong === true;

  const W = 340;
  const H = 150;
  const span = Math.max(timeMs * 6, 600);
  const taps: Array<{ t: number; a: number; lane: number; i: number }> = [];
  for (let i = 0; i < 24; i++) {
    const t = i * timeMs;
    if (t > span) break;
    const a = i === 0 ? 1 : Math.pow(clamp(feedback, 0, 0.95), i);
    if (a < 0.012) break;
    taps.push({ t, a, lane: pingPong ? i % 2 : 0, i });
  }
  const laneY = (lane: number) => (pingPong ? (lane === 0 ? H * 0.36 : H * 0.72) : H * 0.56);
  const cycle = Math.max(1.2, (span / 1000) * 0.9);

  return (
    <div className={FRAME}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ aspectRatio: `${W} / ${H}` }}>
        {/* Lane baselines. */}
        {(pingPong ? [0, 1] : [0]).map((lane) => (
          <line key={lane} x1={10} y1={laneY(lane)} x2={W - 10} y2={laneY(lane)} className="stroke-muted-foreground/20" strokeWidth={1} />
        ))}
        {pingPong && (
          <>
            <text x={12} y={laneY(0) - 8} className="fill-muted-foreground/60" style={{ fontSize: 8 }}>L</text>
            <text x={12} y={laneY(1) - 8} className="fill-muted-foreground/60" style={{ fontSize: 8 }}>R</text>
          </>
        )}
        {taps.map(({ t, a, lane, i }) => {
          const x = 12 + (t / span) * (W - 26);
          const y = laneY(lane);
          const h = a * (H * 0.3) * (i === 0 ? 1 : clamp(mix * 1.6, 0.25, 1));
          // Repeats darken as they fade, which is what the tone filter does.
          const warmth = clamp(toneHz / 20000, 0.06, 1);
          return (
            <g key={i}>
              <line
                x1={x} y1={y - h} x2={x} y2={y + h}
                strokeWidth={i === 0 ? 2.5 : 2} strokeLinecap="round"
                className={i === 0 ? "stroke-foreground/85" : "stroke-primary"}
                opacity={i === 0 ? 1 : clamp(a * (0.35 + warmth * 0.65), 0.12, 0.95)}
              />
              <circle cx={x} cy={y} r={i === 0 ? 3 : 2.2} className={i === 0 ? "fill-foreground/85" : "fill-primary"} opacity={i === 0 ? 1 : clamp(a, 0.15, 1)}>
                {/* The travelling pulse — CSS-driven, so playback never re-renders. */}
                <animate
                  attributeName="r"
                  values={`${i === 0 ? 3 : 2.2};${(i === 0 ? 3 : 2.2) * 2.2};${i === 0 ? 3 : 2.2}`}
                  dur={`${cycle}s`}
                  begin={`${(t / span) * cycle}s`}
                  repeatCount="indefinite"
                />
              </circle>
            </g>
          );
        })}
        <text x={12} y={14} className="fill-muted-foreground" style={{ fontSize: 8.5 }}>
          {taps.length - 1} repeat{taps.length === 2 ? "" : "s"} · {(timeMs / 1000).toFixed(2)}s apart
        </text>
        <text x={W - 12} y={14} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 8.5 }}>
          {pingPong ? "ping-pong" : "mono tap"}
        </text>
      </svg>
    </div>
  );
}

/**
 * COMPRESSOR — its transfer function, which is the whole story of a compressor.
 *
 * Below the threshold the line is 1:1 (in equals out); above it the slope
 * flattens to 1/ratio, and the knee rounds the corner between them. Seeing that
 * corner is how "threshold", "ratio" and "knee" stop being three words and
 * become one shape you are bending.
 */
function CompressorCurve({ clip, effect }: { clip: Clip; effect: AudioEffect }) {
  const threshold = useField(clip, effect, "thresholdDb");
  const ratio = useField(clip, effect, "ratio");
  const knee = useField(clip, effect, "kneeDb");
  const makeup = useField(clip, effect, "makeupDb");

  const W = 340;
  const H = 190;
  const LO = -60;
  const pad = 18;
  const xOf = (db: number) => pad + ((db - LO) / -LO) * (W - pad * 2);
  const yOf = (db: number) => H - pad - ((db - LO) / -LO) * (H - pad * 2);

  /** The WebAudio compressor's own curve: soft knee, then 1/ratio slope. */
  const outFor = (inDb: number): number => {
    const r = Math.max(1, ratio);
    const k = Math.max(0, knee);
    if (k > 0 && inDb > threshold - k / 2 && inDb < threshold + k / 2) {
      const x = inDb - threshold + k / 2;
      return inDb + ((1 / r - 1) * x * x) / (2 * k) + makeup;
    }
    return (inDb <= threshold ? inDb : threshold + (inDb - threshold) / r) + makeup;
  };

  const pts: string[] = [];
  for (let i = 0; i <= 90; i++) {
    const inDb = LO + (i / 90) * -LO;
    pts.push(`${xOf(inDb)},${yOf(clamp(outFor(inDb), LO, 6))}`);
  }
  const reduction = Math.max(0, -6 - outFor(-6) + makeup);

  return (
    <div className={FRAME}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ aspectRatio: `${W} / ${H}` }}>
        {[-48, -36, -24, -12, 0].map((db) => (
          <g key={db}>
            <line x1={xOf(db)} y1={pad} x2={xOf(db)} y2={H - pad} className="stroke-muted-foreground/10" strokeWidth={1} />
            <line x1={pad} y1={yOf(db)} x2={W - pad} y2={yOf(db)} className="stroke-muted-foreground/10" strokeWidth={1} />
          </g>
        ))}
        {/* 1:1 — what an untouched signal would do. */}
        <line x1={xOf(LO)} y1={yOf(LO)} x2={xOf(0)} y2={yOf(0)} className="stroke-muted-foreground/35" strokeWidth={1} strokeDasharray="3 3" />
        {/* Threshold. */}
        <line x1={xOf(threshold)} y1={pad} x2={xOf(threshold)} y2={H - pad} className="stroke-primary/50" strokeWidth={1} strokeDasharray="2 3" />
        <text x={xOf(threshold) + 3} y={pad + 9} className="fill-primary/70" style={{ fontSize: 8 }}>
          {threshold.toFixed(0)} dB
        </text>
        <polyline points={pts.join(" ")} fill="none" className="stroke-primary" strokeWidth={2} strokeLinecap="round" />
        <text x={pad} y={H - 5} className="fill-muted-foreground/70" style={{ fontSize: 8 }}>in</text>
        <text x={4} y={pad + 4} className="fill-muted-foreground/70" style={{ fontSize: 8 }}>out</text>
        <text x={W - pad} y={pad + 9} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 8.5 }}>
          {ratio.toFixed(1)}:1 · −{reduction.toFixed(1)} dB @ −6
        </text>
      </svg>
    </div>
  );
}

/**
 * SATURATOR — the transfer curve, and a sine being bent by it.
 *
 * The curve IS `saturationCurve()`, the exact Float32Array handed to the
 * WaveShaperNode. The wave underneath is that function applied to a sine, so
 * you can watch tape round the peaks while hard clip shears them flat — which
 * is the difference between the four characters, made visible.
 */
function SaturatorCurve({ clip, effect }: { clip: Clip; effect: AudioEffect }) {
  const drive = useField(clip, effect, "driveDb");
  const mix = useField(clip, effect, "mix");
  const character = ((effect as unknown as { character?: string }).character ?? "tape") as SaturatorCharacter;

  const W = 340;
  const H = 190;
  const curve = React.useMemo(() => saturationCurve(character, drive, 256), [character, drive]);
  const shape = (x: number): number => {
    const i = clamp(Math.round(((x + 1) / 2) * (curve.length - 1)), 0, curve.length - 1);
    return curve[i]!;
  };

  const box = { x: 14, y: 12, w: W - 28, h: 96 };
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const transfer: string[] = [];
  for (let i = 0; i <= 120; i++) {
    const x = (i / 120) * 2 - 1;
    transfer.push(`${cx + (x * box.w) / 2},${cy - (shape(x) * box.h) / 2}`);
  }

  const waveY = H - 40;
  const dry: string[] = [];
  const wet: string[] = [];
  for (let i = 0; i <= 160; i++) {
    const t = i / 160;
    const s = Math.sin(t * Math.PI * 4);
    const x = box.x + t * box.w;
    dry.push(`${x},${waveY - s * 22}`);
    wet.push(`${x},${waveY - (s * (1 - mix) + shape(s) * mix) * 22}`);
  }

  return (
    <div className={FRAME}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ aspectRatio: `${W} / ${H}` }}>
        <rect {...{ x: box.x, y: box.y, width: box.w, height: box.h }} rx={4} className="fill-black/20 stroke-border/50" strokeWidth={1} />
        {/* The identity — where an untouched signal would sit. */}
        <line x1={box.x} y1={box.y + box.h} x2={box.x + box.w} y2={box.y} className="stroke-muted-foreground/25" strokeWidth={1} strokeDasharray="3 3" />
        <line x1={box.x} y1={cy} x2={box.x + box.w} y2={cy} className="stroke-muted-foreground/15" strokeWidth={1} />
        <line x1={cx} y1={box.y} x2={cx} y2={box.y + box.h} className="stroke-muted-foreground/15" strokeWidth={1} />
        <polyline points={transfer.join(" ")} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" />
        <text x={box.x + 4} y={box.y + 10} className="fill-muted-foreground" style={{ fontSize: 8.5 }}>
          {character} · {drive.toFixed(1)} dB
        </text>

        {/* The same function, applied to a wave. */}
        <polyline points={dry.join(" ")} fill="none" className="stroke-muted-foreground/35" strokeWidth={1} strokeDasharray="2 2" />
        <polyline points={wet.join(" ")} fill="none" className="stroke-primary" strokeWidth={1.75} strokeLinejoin="round" />
        <text x={box.x} y={H - 6} className="fill-muted-foreground/70" style={{ fontSize: 8 }}>
          dashed = untouched
        </text>
      </svg>
    </div>
  );
}

// ── Modulation, filter and image pictures ───────────────────────────────────

const SW = 340;
const SH = 170;
const PLOT = { x: 14, y: 22, w: SW - 28, h: SH - 44 };

/** Polyline points for `f(u)` over u ∈ 0..1, y in 0..1 (top = 1). */
function curvePoints(f: (u: number) => number, steps = 220): string {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    pts.push(`${PLOT.x + u * PLOT.w},${PLOT.y + (1 - clamp(f(u), 0, 1)) * PLOT.h}`);
  }
  return pts.join(" ");
}

/** The frame every scope below draws in: a plot box, a caption left and right. */
function Scope({ left, right, children, foot }: { left: string; right?: string; children: React.ReactNode; foot?: string }) {
  return (
    <div className={FRAME}>
      <svg viewBox={`0 0 ${SW} ${SH}`} className="w-full" style={{ aspectRatio: `${SW} / ${SH}` }}>
        <rect x={PLOT.x} y={PLOT.y} width={PLOT.w} height={PLOT.h} rx={4} className="fill-black/20 stroke-border/50" strokeWidth={1} />
        {children}
        <text x={PLOT.x} y={14} className="fill-muted-foreground" style={{ fontSize: 8.5 }}>{left}</text>
        {right && <text x={SW - PLOT.x} y={14} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 8.5 }}>{right}</text>}
        {foot && <text x={PLOT.x} y={SH - 6} className="fill-muted-foreground/70" style={{ fontSize: 8 }}>{foot}</text>}
      </svg>
    </div>
  );
}

/** Two seconds of an LFO, as the oscillator plays it. */
const WINDOW_S = 2;

/**
 * FILTER — its magnitude response (the RBJ biquad the node runs), and when the
 * LFO moves it, the two ends of its sweep with the range between them shaded.
 */
function FilterResponse({ clip, effect }: { clip: Clip; effect: AudioEffect }) {
  const cutoff = useField(clip, effect, "cutoffHz");
  const res = useField(clip, effect, "resonance");
  const rate = useField(clip, effect, "lfoRateHz");
  const depth = useField(clip, effect, "lfoDepth");
  const mode = modeOf(effect, "mode", "lowpass") as BiquadShape;
  const fMin = 20;
  const fMax = 20000;
  const dbAt = (u: number, fc: number) => {
    const f = fMin * Math.pow(fMax / fMin, u);
    return biquadMagnitudeDb({ type: mode, freqHz: clamp(fc, 20, 20000), gainDb: 0, q: Math.max(0.1, res) }, f);
  };
  const y = (db: number) => (clamp(db, -36, 24) + 36) / 60;
  const swing = rate > 0 && depth > 0;
  const lo = cutoff / Math.pow(2, depth);
  const hi = cutoff * Math.pow(2, depth);
  const xOf = (f: number) => PLOT.x + (Math.log(clamp(f, fMin, fMax) / fMin) / Math.log(fMax / fMin)) * PLOT.w;
  return (
    <Scope left={`${mode} · ${Math.round(cutoff)} Hz`} right={swing ? `sweeps ${Math.round(lo)}–${Math.round(hi)} Hz · ${rate.toFixed(2)} Hz` : "still"}>
      <line x1={PLOT.x} x2={PLOT.x + PLOT.w} y1={PLOT.y + (1 - y(0)) * PLOT.h} y2={PLOT.y + (1 - y(0)) * PLOT.h} className="stroke-muted-foreground/20" strokeDasharray="3 3" />
      {swing && <rect x={xOf(lo)} y={PLOT.y} width={Math.max(1, xOf(hi) - xOf(lo))} height={PLOT.h} className="fill-primary/10" />}
      {swing && <polyline points={curvePoints((u) => y(dbAt(u, lo)))} fill="none" className="stroke-primary/35" strokeWidth={1} />}
      {swing && <polyline points={curvePoints((u) => y(dbAt(u, hi)))} fill="none" className="stroke-primary/35" strokeWidth={1} />}
      <polyline points={curvePoints((u) => y(dbAt(u, cutoff)))} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" />
    </Scope>
  );
}

/** CHORUS — each side's delay over two seconds: the drift, and how far apart the sides move. */
function ChorusScope({ clip, effect }: { clip: Clip; effect: AudioEffect }) {
  const delay = useField(clip, effect, "delayMs");
  const depthMs = useField(clip, effect, "depthMs");
  const rate = useField(clip, effect, "rateHz");
  const spread = useField(clip, effect, "spread");
  const shape = shapeOf(modeOf(effect, "shape", "sine"));
  const swing = Math.min(depthMs, delay * 0.98);
  const top = Math.max(1, delay + swing) * 1.15;
  const at = (u: number, k: number) => (delay + swing * k * lfoValue(shape, u * WINDOW_S * rate)) / top;
  return (
    <Scope left={`${delay.toFixed(1)} ms ± ${swing.toFixed(1)} ms`} right={`${rate.toFixed(2)} Hz`} foot="solid = left · faint = right">
      <polyline points={curvePoints((u) => at(u, 1))} fill="none" className="stroke-primary" strokeWidth={2} />
      <polyline points={curvePoints((u) => at(u, 1 - 2 * spread))} fill="none" className="stroke-primary/40" strokeWidth={1.5} />
    </Scope>
  );
}

/** PHASER — where the notches sit over two seconds, on a log frequency axis. */
function PhaserScope({ clip, effect }: { clip: Clip; effect: AudioEffect }) {
  const center = useField(clip, effect, "centerHz");
  const rate = useField(clip, effect, "lfoRateHz");
  const depth = useField(clip, effect, "lfoDepth");
  const stages = modeOf(effect, "stages", "6");
  const shape = shapeOf(modeOf(effect, "lfoShape", "sine"));
  const fMin = 40;
  const fMax = 16000;
  const at = (u: number) => {
    const f = center * Math.pow(2, (rate > 0 ? depth : 0) * lfoValue(shape, u * WINDOW_S * rate));
    return Math.log(clamp(f, fMin, fMax) / fMin) / Math.log(fMax / fMin);
  };
  return (
    <Scope left={`${stages} stages · around ${Math.round(center)} Hz`} right={rate > 0 ? `${rate.toFixed(2)} Hz` : "still"} foot="the notch frequency, over two seconds">
      <polyline points={curvePoints(at)} fill="none" className="stroke-primary" strokeWidth={2} />
    </Scope>
  );
}

/** TREMOLO — the level (or the position) it applies, over two seconds. */
function TremoloScope({ clip, effect }: { clip: Clip; effect: AudioEffect }) {
  const rate = useField(clip, effect, "rateHz");
  const depth = useField(clip, effect, "depth");
  const target = modeOf(effect, "target", "volume");
  const shape = shapeOf(modeOf(effect, "shape", "sine"));
  const at = (u: number) => {
    const l = lfoValue(shape, u * WINDOW_S * rate);
    return target === "pan" ? 0.5 + 0.5 * depth * l : 1 - depth / 2 + (depth / 2) * l;
  };
  return (
    <Scope left={target === "pan" ? "pan, left ↔ right" : "volume"} right={`${rate.toFixed(2)} Hz`} foot="two seconds">
      {target === "pan" && <line x1={PLOT.x} x2={PLOT.x + PLOT.w} y1={PLOT.y + PLOT.h / 2} y2={PLOT.y + PLOT.h / 2} className="stroke-muted-foreground/20" strokeDasharray="3 3" />}
      <polyline points={curvePoints(at)} fill="none" className="stroke-primary" strokeWidth={2} />
    </Scope>
  );
}

/** RING MOD — the tone the sound is multiplied by, three of its cycles. */
function RingScope({ clip, effect }: { clip: Clip; effect: AudioEffect }) {
  const freq = useField(clip, effect, "frequencyHz");
  const shape = shapeOf(modeOf(effect, "shape", "sine"));
  return (
    <Scope left={`× ${Math.round(freq)} Hz ${shape}`} right={freq < 120 ? "robot" : freq < 700 ? "metallic" : "alien"} foot="the carrier the sound is multiplied by">
      <polyline points={curvePoints((u) => 0.5 + 0.42 * lfoValue(shape, u * 3))} fill="none" className="stroke-primary" strokeWidth={2} />
    </Scope>
  );
}

/** BITCRUSH — the staircase the waveshaper runs, and a wave through it. */
function CrushCurve({ clip, effect }: { clip: Clip; effect: AudioEffect }) {
  const bits = useField(clip, effect, "bits");
  const drive = useField(clip, effect, "driveDb");
  const curve = React.useMemo(() => bitcrushCurve(bits, drive, 512), [bits, drive]);
  const shape = (x: number) => curve[clamp(Math.round(((x + 1) / 2) * (curve.length - 1)), 0, curve.length - 1)]!;
  return (
    <Scope left={`${bits.toFixed(1)} bits · ${Math.round(Math.pow(2, bits))} levels`} foot="dashed = untouched">
      <polyline points={curvePoints((u) => 0.5 + 0.42 * Math.sin(u * Math.PI * 4))} fill="none" className="stroke-muted-foreground/35" strokeWidth={1} strokeDasharray="2 2" />
      <polyline points={curvePoints((u) => 0.5 + 0.42 * shape(Math.sin(u * Math.PI * 4)), 400)} fill="none" className="stroke-primary" strokeWidth={1.75} />
    </Scope>
  );
}

/** STEREO — the image between the speakers: how wide, and where its centre sits. */
function StereoImage({ clip, effect }: { clip: Clip; effect: AudioEffect }) {
  const width = useField(clip, effect, "width");
  const pan = useField(clip, effect, "pan");
  const cx = PLOT.x + PLOT.w * (0.5 + pan * 0.45);
  const half = (PLOT.w * 0.45 * Math.min(2, width)) / 2;
  const cy = PLOT.y + PLOT.h / 2;
  return (
    <Scope left={width < 0.05 ? "mono" : width < 0.95 ? "narrower" : width <= 1.05 ? "as recorded" : "wider"} right={Math.abs(pan) < 0.02 ? "centre" : pan < 0 ? `${Math.round(-pan * 100)}% left` : `${Math.round(pan * 100)}% right`}>
      <text x={PLOT.x + 6} y={cy + 3} className="fill-muted-foreground/60" style={{ fontSize: 9 }}>L</text>
      <text x={PLOT.x + PLOT.w - 12} y={cy + 3} className="fill-muted-foreground/60" style={{ fontSize: 9 }}>R</text>
      <rect x={Math.max(PLOT.x + 2, cx - half)} y={cy - 14} width={Math.max(3, Math.min(PLOT.x + PLOT.w - 2, cx + half) - Math.max(PLOT.x + 2, cx - half))} height={28} rx={14} className="fill-primary/30 stroke-primary" strokeWidth={1.5} />
      <line x1={cx} x2={cx} y1={cy - 20} y2={cy + 20} className="stroke-foreground/70" strokeWidth={1.5} />
    </Scope>
  );
}

// ── The controls ─────────────────────────────────────────────────────────────

/**
 * Every registry field, as a knob. Grouped exactly as the registry declares,
 * `showIf` honoured, keyframe-aware — so a new audio effect gets a designed
 * control panel the day it registers, with no UI written for it.
 */
function KnobGrid({
  clip,
  effect,
  onCommit,
}: {
  clip: Clip;
  effect: AudioEffect;
  onCommit: (e: AudioEffect, f: EffectFieldDef, v: KeyframeValue, label: string) => void;
}) {
  const def = AFX.def(effect.type);
  if (!def) return null;
  const raw = effect as unknown as Record<string, unknown>;
  const defaults = AFX.defaults(effect.type) as Record<string, unknown>;

  const visible = def.fields.filter((f) => effectFieldVisible(f, raw));
  const sections: Array<{
    id: string | null;
    label: string | null;
    collapsed?: boolean;
    fields: EffectFieldDef[];
  }> = [
    { id: null, label: null, fields: visible.filter((f) => !f.group) },
    ...(def.groups ?? []).map((g) => ({
      id: g.id,
      label: g.label,
      collapsed: g.collapsed,
      fields: visible.filter((f) => f.group === g.id),
    })),
  ].filter((s) => s.fields.length > 0);

  return (
    <div className="space-y-2.5 pb-1">
      {sections.map((section) => (
        <KnobSection key={section.id ?? "_"} label={section.label} defaultCollapsed={section.collapsed}>
          {/* auto-FILL, not auto-fit. The grid answers "how many fit?" in the
              settings column — three at its narrowest — but it KEEPS the empty
              tracks, so a knob is the same size in every group and a group of
              two sits in the first two slots. auto-fit collapses the empty
              tracks and stretches the survivors, which is what made a lone
              "Dry / wet" span the entire panel and put "Low cut" and "High cut"
              at opposite ends of the window. */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-x-2 gap-y-2">
            {section.fields.map((f) =>
              f.kind === "select" ? (
                <div key={f.key} className="col-span-full">
                  <Segmented
                    field={f}
                    value={String(raw[f.key] ?? "")}
                    onChange={(v) => onCommit(effect, f, v, `${def.label} ${f.label}`)}
                  />
                </div>
              ) : (
                <FieldKnob
                  key={f.key}
                  clip={clip}
                  effect={effect}
                  field={f}
                  fallback={Number(defaults[f.key] ?? 0)}
                  onCommit={(v) => onCommit(effect, f, v, `${def.label} ${f.label}`)}
                />
              ),
            )}
          </div>
        </KnobSection>
      ))}
    </div>
  );
}

/**
 * A group of knobs, collapsible — and collapsed by default when the REGISTRY
 * says so.
 *
 * `EffectFieldGroupDef.collapsed` has always been there and the generated field
 * editor has always honoured it; this panel quietly did not, so the reverb's
 * Tone and Levels — declared as advanced, rarely-touched blocks — were forced
 * open and pushed half the controls below the fold. One flag, two readers, two
 * answers: exactly the disagreement the registry exists to prevent.
 */
function KnobSection({
  label,
  defaultCollapsed,
  children,
}: {
  label: string | null;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(!defaultCollapsed);
  if (!label) return <div className="space-y-1.5">{children}</div>;
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open && children}
    </div>
  );
}

/**
 * The effect's switches, under its picture.
 *
 * A toggle is a MODE, not a value — it never keyframes, and it usually changes
 * what the picture is showing (ping-pong splits the taps into two lanes; edge
 * only stops the glass refracting). It belongs beside the thing it reshapes,
 * not at the bottom of a scrolling column of knobs where it reads as the last
 * and least of the settings.
 */
function EffectToggles({
  effect,
  onToggle,
}: {
  effect: AudioEffect;
  onToggle: (key: string, value: boolean, label: string) => void;
}) {
  const def = AFX.def(effect.type);
  const raw = effect as unknown as Record<string, unknown>;
  const toggles = (def?.toggles ?? []).filter((t) => effectFieldVisible(t, raw));
  if (!def || toggles.length === 0) return null;

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-3 gap-y-1">
      {toggles.map((t) => (
        <label
          key={t.key}
          className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5"
          title={t.hint}
        >
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{t.label}</span>
          <Switch
            checked={Boolean(raw[t.key])}
            onCheckedChange={(v) => onToggle(t.key, v, `${def.label} ${t.label}`)}
          />
        </label>
      ))}
    </div>
  );
}

/** One field, as a knob — keyframe-aware, with sensible detents. */
function FieldKnob({
  clip,
  effect,
  field,
  fallback,
  onCommit,
}: {
  clip: Clip;
  effect: AudioEffect;
  field: EffectFieldDef;
  fallback: number;
  onCommit: (v: number) => void;
}) {
  const base = (effect as unknown as Record<string, unknown>)[field.key];
  const value = useEffectiveValue(
    clip,
    AFX.path(effect.id, field.key),
    typeof base === "number" ? base : fallback,
  ) as number;

  const min = field.min ?? 0;
  const max = field.max ?? 1;
  // Frequencies span three decades; a linear knob would spend most of its
  // travel above 4 kHz, which is unusable. The unit tells us honestly.
  const scale = field.unit === "Hz" && min > 0 && max / min > 50 ? "log" : "linear";
  const path = AFX.path(effect.id, field.key);

  return (
    // A knob is a field. It sits outside `PropRow` because a mixing surface is
    // a grid of caps rather than a column of labelled rows — but that is a
    // LAYOUT difference, and it should not cost the control its right-click:
    // bind this cutoff to a variable, reset its automation, jump to its next
    // key. Wrapping here is the whole wiring; both menus come from the shared
    // pair of blocks the diamond uses.
    <PropertyBindingMenu
      clip={clip}
      path={path}
      kind="number"
      label={field.label}
      literal={value}
      className="min-w-0"
    >
      <div className="min-w-0">
        <Knob
          label={field.label}
          title={field.hint}
          unit={field.unit}
          value={value}
          min={min}
          max={max}
          step={field.step}
          scale={scale}
          bipolar={field.bipolar}
          defaultValue={fallback}
          detents={detentsFor(field, fallback)}
          precision={field.step && field.step < 1 ? 2 : 0}
          size={42}
          onChange={onCommit}
        />
      </div>
    </PropertyBindingMenu>
  );
}

/**
 * The values ⇧ should snap to: the ends, the factory default, and zero when the
 * range crosses it. Meaningful checkpoints, not an even lattice — `step`
 * already covers the lattice.
 */
function detentsFor(field: EffectFieldDef, fallback: number): number[] {
  const min = field.min ?? 0;
  const max = field.max ?? 1;
  const out = new Set<number>([min, max, fallback]);
  if (min < 0 && max > 0) out.add(0);
  if (min === 0 && max === 1) out.add(0.5);
  return [...out].sort((a, b) => a - b);
}

/** An enum reads as a row of choices, not a dropdown you have to open. */
function Segmented({
  field,
  value,
  onChange,
}: {
  field: EffectFieldDef;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground">{field.label}</div>
      <div className="track flex gap-1 bg-foreground/[0.05]">
        {(field.options ?? []).map((o) => (
          <button
            key={o.value}
            type="button"
            title={o.hint}
            onClick={() => onChange(o.value)}
            className={cn(
              "min-w-0 flex-1 truncate rounded-[5px] px-1.5 py-1 text-[10.5px] transition-colors",
              value === o.value
                ? "bg-primary/15 font-medium text-foreground shadow-[inset_0_0_0_1px] shadow-primary/30"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
