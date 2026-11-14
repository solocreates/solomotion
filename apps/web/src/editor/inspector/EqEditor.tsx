"use client";

import * as React from "react";
import {
  createId,
  eqMagnitudeDb,
  eqTypeUsesGain,
  EQ_BAND_TYPES,
  eqBandPath,
  eqBandsAt,
  type AudioEffect,
  type AudioEqBand,
  type Clip,
  type EqBandType,
  type KeyframeValue,
} from "@solomotion/core";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { KeyControl } from "./keyframe-controls";
import { clipLocalClamped, useEffectiveValue } from "./animatable";
import { PropertyBindingMenu } from "./property-binding";
import { useSession } from "../state/session";
import { useClipUpdater } from "./use-clip-updater";
import { capturePointer } from "../input/capture-pointer";

/**
 * The visual parametric EQ — a draggable frequency-response curve (DaVinci /
 * Premiere style). The canvas plots the SUMMED magnitude of the band list
 * (`eqMagnitudeDb`, core), with one draggable node per band: horizontal = freq,
 * vertical = gain (or Q for pass/notch types), wheel = Q. Every value write goes
 * through `commit` (the keyframe-aware path writer), so the whole curve is
 * keyframable; structural edits (add / remove / retype / enable) go through
 * `update`. There is no EQ-specific state — the CARD's band list is the single
 * source of truth the canvas and the numeric rows both render.
 *
 * THE CURVE IS SAMPLED AT THE PLAYHEAD, never read off the base values. That
 * distinction is the whole reason this editor was broken the moment you animated
 * it: the writes went through the keyframe-aware `commit`, so the automation was
 * real and audible, but the canvas kept drawing `effect.bands` — the values the
 * keys animate AROUND. So a keyed band froze its handle at whatever the base
 * happened to be, the curve stopped answering the timeline, and dragging a node
 * looked like it did nothing because the node was already somewhere else.
 * `eqBandsAt` (core) is the same sampler the DSP chain uses, so the drawn curve
 * and the rendered sound cannot disagree.
 *
 * It is the body of the EQ card in the audio effect stack, hosted by the shared
 * floating editor exactly the way the colour grade's wheels are: a bespoke UI
 * costs one `customBody` prop, not a parallel window. A response curve you drag
 * is the only honest control for an equaliser, which is why this one earns the
 * exception — everything else in the audio stack renders from field metadata.
 */

const F_MIN = 20;
const F_MAX = 20000;
const DB_RANGE = 18; // ± dB shown on the y axis
/**
 * The curve TAKES THE HEIGHT IT IS GIVEN.
 *
 * It was a fixed 210px, which meant the window's height and the editor's height
 * were two unrelated numbers: drag the window taller and you got 210px of curve
 * over a growing field of grey. An equaliser is the one control in the stack
 * where extra height is directly extra precision — a dB is a bigger target — so
 * the curve fills the column and the window's height finally means something.
 * Paint and hit-testing both read the MEASURED height, so they agree at every
 * size and the curve can simply shrink with the window rather than needing a
 * floor that would overflow the column it lives in.
 */
const GRID_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

function freqToNorm(f: number): number {
  return (Math.log10(f) - Math.log10(F_MIN)) / (Math.log10(F_MAX) - Math.log10(F_MIN));
}
function normToFreq(n: number): number {
  return Math.pow(10, Math.log10(F_MIN) + n * (Math.log10(F_MAX) - Math.log10(F_MIN)));
}

export function EqEditor({
  clip,
  effect,
  commit,
}: {
  clip: Clip;
  /** The EQ card whose bands this draws. */
  effect: Extract<AudioEffect, { type: "eq" }>;
  /** Keyframe-aware path write — used for freq/gain/Q. */
  commit: (label: string, path: string, v: KeyframeValue, mergeKey?: string) => void;
}) {
  const update = useClipUpdater(clip.id);
  // What the curve DRAWS and what the pointer HITS: the bands as they are at the
  // playhead. Structural edits still address `effect.bands` (ids, order, type) —
  // those are the document, not a value on a timeline.
  const bands = useSampledBands(clip, effect);
  /** This card's bands, wherever the clip is — the ONE structural write. */
  const editBands = (label: string, fn: (bands: AudioEqBand[]) => AudioEqBand[]) =>
    update(label, (c) => {
      const fx = c.audioEffects.find((e) => e.id === effect.id);
      if (fx?.type === "eq") fx.bands = fn(fx.bands);
    });
  const pathFor = (bandId: string, field: "gain" | "freq" | "q") => eqBandPath(effect.id, bandId, field);
  const [selectedId, setSelectedId] = React.useState<string | null>(effect.bands[0]?.id ?? null);
  const selected = bands.find((b) => b.id === selectedId) ?? bands[0] ?? null;

  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const accentRef = React.useRef<HTMLSpanElement>(null);
  const mutedRef = React.useRef<HTMLSpanElement>(null);
  const dragRef = React.useRef<{ id: string; usesGain: boolean } | null>(null);
  /** The canvas's measured height — one number for paint and for hit tests. */
  const heightRef = React.useRef(0);

  // Redraw the response curve whenever the bands change (or on resize).
  const redraw = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // The pointer maths reads the same measurement the paint used, so a hit test
    // can never be a frame behind the size.
    heightRef.current = h;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const accent = accentRef.current ? getComputedStyle(accentRef.current).color : "#6ea8ff";
    const muted = mutedRef.current ? getComputedStyle(mutedRef.current).color : "rgba(255,255,255,.4)";

    const yOfDb = (db: number) => h / 2 - (db / DB_RANGE) * (h / 2 - 8);

    // Grid — vertical freq lines + horizontal 0 dB & ±half lines.
    ctx.lineWidth = 1;
    ctx.font = "9px ui-sans-serif, system-ui";
    ctx.textBaseline = "bottom";
    for (const f of GRID_FREQS) {
      const x = freqToNorm(f) * w;
      ctx.strokeStyle = withAlpha(muted, 0.12);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = withAlpha(muted, 0.55);
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, h - 1);
    }
    for (const db of [-DB_RANGE / 2, 0, DB_RANGE / 2]) {
      const y = yOfDb(db);
      ctx.strokeStyle = withAlpha(muted, db === 0 ? 0.3 : 0.1);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // The summed response curve, filled to the 0 dB line. A DISABLED band is not
    // in the signal path, so it must not bend the picture of the signal path —
    // its handle stays (greyed, still draggable), its contribution does not.
    const audible = bands.filter((b) => b.enabled);
    ctx.beginPath();
    const STEPS = 160;
    for (let i = 0; i <= STEPS; i++) {
      const n = i / STEPS;
      const db = eqMagnitudeDb(audible, normToFreq(n));
      const x = n * w;
      const y = yOfDb(Math.max(-DB_RANGE, Math.min(DB_RANGE, db)));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(w, yOfDb(0));
    ctx.lineTo(0, yOfDb(0));
    ctx.closePath();
    ctx.fillStyle = withAlpha(accent, 0.14);
    ctx.fill();

    // Band handles.
    for (const b of bands) {
      const x = freqToNorm(b.freqHz) * w;
      const y = yOfDb(eqTypeUsesGain(b.type) ? Math.max(-DB_RANGE, Math.min(DB_RANGE, b.gainDb)) : 0);
      const isSel = b.id === selected?.id;
      ctx.beginPath();
      ctx.arc(x, y, isSel ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = b.enabled ? accent : withAlpha(muted, 0.5);
      ctx.fill();
      if (isSel) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }, [bands, selected?.id]);

  React.useEffect(() => {
    redraw();
    const ro = new ResizeObserver(redraw);
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, [redraw]);

  // ── Pointer interaction on the canvas ──────────────────────────────────────
  const nodeAt = (px: number, py: number): AudioEqBand | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const w = canvas.clientWidth;
    const h = heightRef.current;
    const yOfDb = (db: number) => h / 2 - (db / DB_RANGE) * (h / 2 - 8);
    let best: AudioEqBand | null = null;
    let bestD = 16 * 16;
    for (const b of bands) {
      const x = freqToNorm(b.freqHz) * w;
      const y = yOfDb(eqTypeUsesGain(b.type) ? b.gainDb : 0);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  };

  const localPoint = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = localPoint(e);
    const hit = nodeAt(x, y);
    if (!hit) return;
    setSelectedId(hit.id);
    dragRef.current = { id: hit.id, usesGain: eqTypeUsesGain(hit.type) };
    capturePointer(canvasRef.current!, e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y, w } = localPoint(e);
    const b = bands.find((bb) => bb.id === drag.id);
    if (!b) return;
    const freq = Math.round(normToFreq(Math.max(0, Math.min(1, x / w))));
    commit("EQ band", pathFor(drag.id, "freq"), freq, "eq-drag");
    const h = heightRef.current;
    if (drag.usesGain) {
      const db = (h / 2 - y) / (h / 2 - 8) * DB_RANGE;
      commit("EQ band", pathFor(drag.id, "gain"), Math.max(-24, Math.min(24, Math.round(db * 10) / 10)), "eq-drag");
    } else {
      // Pass/notch: vertical drag steepens/loosens Q (up = tighter).
      const q = Math.max(0.1, Math.min(12, ((h - y) / h) * 8));
      commit("EQ band", pathFor(drag.id, "q"), Math.round(q * 100) / 100, "eq-drag");
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    // Only hijack the wheel to tune Q when a band node is directly under the
    // cursor — otherwise let the sidebar scroll normally (no scroll-jacking).
    const { x, y } = localPoint(e as unknown as React.PointerEvent);
    const node = nodeAt(x, y);
    if (!node) return;
    e.preventDefault();
    const next = Math.max(0.1, Math.min(12, node.q * (e.deltaY > 0 ? 0.9 : 1.1)));
    setSelectedId(node.id);
    commit("EQ Q", pathFor(node.id, "q"), Math.round(next * 100) / 100, "eq-q");
  };

  const addBand = (atFreq = 1000, gainDb = 0) => {
    const b: AudioEqBand = { id: createId("eqband"), type: "peaking", freqHz: atFreq, gainDb, q: 1, enabled: true };
    editBands("Add EQ band", (list) => [...list, b]);
    setSelectedId(b.id);
  };

  const removeBand = (id: string) => {
    update("Remove EQ band", (c) => {
      const fx = c.audioEffects.find((e) => e.id === effect.id);
      if (fx?.type !== "eq") return;
      fx.bands = fx.bands.filter((x) => x.id !== id);
      // Drop the band's keyframe tracks so they don't linger as ghost rows.
      const prefix = `${eqBandPath(effect.id, id, "gain").slice(0, -"gain".length)}`;
      c.keyframes = c.keyframes.filter((t) => !t.property.startsWith(prefix));
    });
    if (selectedId === id) setSelectedId(null);
  };

  return (
    // The canvas GROWS, the band rail and the selected band's row do not — so a
    // taller window buys curve, which is the only part of this that scales.
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* Colour probes (theme-aware): the canvas reads these resolved colours. */}
      <span ref={accentRef} className="hidden text-primary" />
      <span ref={mutedRef} className="hidden text-muted-foreground" />

      <canvas
        ref={canvasRef}
        style={{ width: "100%", touchAction: "none" }}
        className="min-h-0 flex-1 cursor-pointer rounded-lg border border-border/60 bg-gradient-to-b from-background/40 to-black/40 shadow-inner"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={(e) => {
          const { x, y, w } = { ...localPoint(e as unknown as React.PointerEvent) };
          if (nodeAt(x, y)) return; // dbl-click a node = no-op (drag to edit)
          const h = heightRef.current;
          const db = (h / 2 - y) / (h / 2 - 8) * DB_RANGE;
          addBand(Math.round(normToFreq(Math.max(0, Math.min(1, x / w)))), Math.max(-24, Math.min(24, Math.round(db))));
        }}
        onWheel={onWheel}
      />

      {/* ONE rail: the bands, and the way to make another. They were two rows —
          a right-aligned "+ Band" orphaned above the chips it belongs to — which
          read as two unrelated controls instead of a list and its add button. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {bands.map((b, i) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setSelectedId(b.id)}
            onDoubleClick={() =>
              editBands("Toggle band", (list) =>
                list.map((x) => (x.id === b.id ? { ...x, enabled: !x.enabled } : x)),
              )
            }
            title={`${b.enabled ? "" : "(off) "}double-click to ${b.enabled ? "disable" : "enable"}`}
            className={cn(
              "rounded px-2 py-1 text-[10.5px] tabular-nums transition-colors",
              b.id === selected?.id
                ? "bg-primary/20 text-foreground ring-1 ring-primary/60"
                : "bg-muted/40 text-muted-foreground hover:text-foreground",
              !b.enabled && "line-through opacity-50",
            )}
          >
            {i + 1}·{b.freqHz >= 1000 ? `${(b.freqHz / 1000).toFixed(1)}k` : Math.round(b.freqHz)}
          </button>
        ))}
        <button
          type="button"
          title="Add a band — or double-click the curve where you want it"
          onClick={() => addBand()}
          className="flex items-center gap-0.5 rounded border border-dashed border-border/70 px-2 py-1 text-[10.5px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          <Plus className="size-3" /> Band
        </button>
      </div>

      {selected && (
        <BandControls
          key={selected.id}
          clip={clip}
          band={selected}
          commit={commit}
          pathFor={pathFor}
          editBands={editBands}
          onRemove={() => removeBand(selected.id)}
        />
      )}
    </div>
  );
}

function BandControls({
  clip,
  band,
  commit,
  pathFor,
  editBands,
  onRemove,
}: {
  clip: Clip;
  band: AudioEqBand;
  commit: (label: string, path: string, v: KeyframeValue, mergeKey?: string) => void;
  pathFor: (bandId: string, field: "gain" | "freq" | "q") => string;
  editBands: (label: string, fn: (bands: AudioEqBand[]) => AudioEqBand[]) => void;
  onRemove: () => void;
}) {
  const usesGain = eqTypeUsesGain(band.type);
  // Sampled through the keyframe path, so a keyed band shows the value it has
  // at the playhead — the rows and the curve can never disagree.
  const freq = useEffectiveValue(clip, pathFor(band.id, "freq"), band.freqHz);
  const gain = useEffectiveValue(clip, pathFor(band.id, "gain"), band.gainDb);
  const q = useEffectiveValue(clip, pathFor(band.id, "q"), band.q);

  return (
    // The selected band's controls read ACROSS, not down. Four stacked PropRows
    // under a curve meant the tallest thing in an equaliser was its footer.
    <div className="@container rounded-md border border-border/50 bg-muted/20 p-2">
      <div
        className={cn(
          "grid grid-cols-1 gap-x-3 gap-y-2 @[420px]:items-end",
          usesGain
            ? "@[420px]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
            : "@[420px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto]",
        )}
      >
        <Field label="Type">
          <Select
            value={band.type}
            onValueChange={(t) =>
              editBands("EQ band type", (list) =>
                list.map((x) => (x.id === band.id ? { ...x, type: t as EqBandType } : x)),
              )
            }
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EQ_BAND_TYPES.map((m) => (
                <SelectItem key={m.type} value={m.type}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Freq"
          bind={{ clip, path: pathFor(band.id, "freq"), label: "EQ freq", value: freq }}
          keyControl={<KeyControl clip={clip} property={pathFor(band.id, "freq")} currentValue={() => freq} label="EQ freq" />}
        >
          <NumberInput
            value={freq}
            min={20}
            max={20000}
            step={freq >= 1000 ? 50 : 5}
            precision={0}
            unit="Hz"
            onChange={(v) => commit("EQ freq", pathFor(band.id, "freq"), v, "eq-freq")}
          />
        </Field>

        {/* A pass filter has no gain, so the slot is simply absent rather than
            a disabled box that invites an argument with the user. */}
        {usesGain && (
          <Field
            label="Gain"
            bind={{ clip, path: pathFor(band.id, "gain"), label: "EQ gain", value: gain }}
            keyControl={<KeyControl clip={clip} property={pathFor(band.id, "gain")} currentValue={() => gain} label="EQ gain" />}
          >
            <NumberInput
              value={gain}
              min={-24}
              max={24}
              step={0.5}
              precision={1}
              unit="dB"
              onChange={(v) => commit("EQ gain", pathFor(band.id, "gain"), v, "eq-gain")}
            />
          </Field>
        )}

        <Field
          label="Q"
          bind={{ clip, path: pathFor(band.id, "q"), label: "EQ Q", value: q }}
          keyControl={<KeyControl clip={clip} property={pathFor(band.id, "q")} currentValue={() => q} label="EQ Q" />}
        >
          <NumberInput
            value={q}
            min={0.05}
            max={18}
            step={0.05}
            precision={2}
            onChange={(v) => commit("EQ Q", pathFor(band.id, "q"), v, "eq-q")}
          />
        </Field>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Remove band"
          title="Remove band"
          className="justify-self-end hover:text-destructive"
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

/**
 * A labelled control in the band row — the label sits above, not beside.
 *
 * `bind` gives the input the same right-click a `PropRow` field has: link a
 * variable, write an expression, reset the automation, jump to the next key.
 * The band rows are a bespoke layout (they read ACROSS, under the curve) but
 * they are ordinary animatable fields, and the menu is the row's, not the
 * layout's.
 */
function Field({
  label,
  bind,
  keyControl,
  children,
}: {
  label: string;
  bind?: { clip: Clip; path: string; label: string; value: number };
  keyControl?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center gap-1">
        <span className="flex-1 truncate text-[10px] uppercase tracking-wide text-muted-foreground/80">{label}</span>
        {keyControl}
      </div>
      {bind ? (
        <PropertyBindingMenu
          clip={bind.clip}
          path={bind.path}
          kind="number"
          label={bind.label}
          literal={bind.value}
        >
          <div className="min-w-0">{children}</div>
        </PropertyBindingMenu>
      ) : (
        children
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * The card's bands AS THEY ARE AT THE PLAYHEAD — the reactive half of the fix
 * described at the top of this file.
 *
 * It subscribes to the session (the playhead moves) and re-derives on every
 * render (the document changed), but hands back a CACHED array whenever the
 * sampled numbers are identical. That matters twice: `useSyncExternalStore`
 * requires a stable snapshot or it loops, and `redraw` is memoised on this
 * array — without the cache the canvas would repaint on every playback frame of
 * an un-animated EQ, which is the majority case.
 */
function useSampledBands(clip: Clip, effect: Extract<AudioEffect, { type: "eq" }>): AudioEqBand[] {
  const live = React.useRef({ clip, effect });
  live.current = { clip, effect };
  const cache = React.useRef<{ sig: string; bands: AudioEqBand[] } | null>(null);

  const subscribe = React.useCallback((cb: () => void) => useSession.subscribe(cb), []);
  const get = React.useCallback((): AudioEqBand[] => {
    const { clip: c, effect: fx } = live.current;
    const bands = eqBandsAt(fx, c.keyframes, clipLocalClamped(c, useSession.getState().playheadMs));
    const sig = bands
      .map((b) => `${b.id}:${b.type}:${b.enabled ? 1 : 0}:${b.freqHz.toFixed(2)}:${b.gainDb.toFixed(3)}:${b.q.toFixed(3)}`)
      .join("|");
    if (!cache.current || cache.current.sig !== sig) cache.current = { sig, bands };
    return cache.current.bands;
  }, []);

  return React.useSyncExternalStore(subscribe, get, get);
}

/** Apply an alpha to a resolved `rgb(...)`/`rgba(...)`/hex colour string. */
function withAlpha(color: string, alpha: number): string {
  const m = /^rgba?\(([^)]+)\)/.exec(color);
  if (m) {
    const [r, g, b] = m[1]!.split(",").map((s) => parseFloat(s));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}
