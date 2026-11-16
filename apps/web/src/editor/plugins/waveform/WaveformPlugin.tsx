"use client";

import * as React from "react";
import {
  createId,
  createTrack,
  createWaveformClip,
  defaultWaveformStyle,
  fitsInTrack,
  locateClip,
  resolveColor,
  styleBinCount,
  visualizerBars,
  type Clip,
  type WaveformStyle,
  type WaveformTemplate,
} from "@solomotion/core";
import {
  Activity,
  AudioLines,
  BarChart3,
  Circle,
  Disc3,
  FlipHorizontal2,
  FlipVertical2,
  Gauge,
  Grid3x3,
  Link2,
  MousePointerClick,
  Mountain,
  Palette,
  RotateCcw,
  RotateCw,
  Search,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  Waves,
  type LucideIcon,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DocColorInput } from "../../inspector/DocColorInput";
import { ensureSoundAnalysis, useSoundAnalysis } from "../../audio/sound-host";
import {
  demoPeaks,
  paintWaveform,
  WAVEFORM_PRESETS,
  WAVEFORM_PRESET_CATEGORIES,
  type WaveformPreset,
} from "../../audio/waveform-visuals";
import { waveformAudioSource } from "../../stage/render/draw-frame";
import { useDoc, useDocStore } from "../../state/document-context";
import { useSession, useParkedPlayhead } from "../../state/session";

/**
 * The Waveform Studio — the app's flagship audio-reactive plugin. Two panes:
 * a scrollable control sidebar on the left, a big live preview + searchable
 * preset browser on the right. ONE `<WaveformStudio>` drives both flows —
 * creating from an audio clip, and live-editing a generated waveform clip —
 * because the difference is only *where the style is written* (`patch`). The
 * clip is procedural (style + target reference, drawn per frame), so edits
 * apply instantly and can never fall out of sync with the sound.
 */
export default function WaveformPlugin() {
  const doc = useDoc();
  const selectedIds = useSession((s) => s.selectedClipIds);

  // Mode: editing a selected waveform clip beats creating from an audio clip.
  let editing: (Clip & { kind: "waveform" }) | null = null;
  let target: Clip | null = null;
  for (const id of selectedIds) {
    const clip = locateClip(doc, id)?.clip;
    if (!clip) continue;
    if (clip.kind === "waveform" && !editing) editing = clip;
    else if (!target && audioCapable(clip)) target = clip;
  }
  if (editing) {
    const t = locateClip(doc, editing.targetClipId)?.clip;
    return <EditView clip={editing} target={t ?? null} retargetTo={target} />;
  }
  if (target) return <CreateView key={target.id} target={target} />;
  return <EmptyState />;
}

/** Clips a visualizer can listen to: asset audio, or video (its audio track). */
function audioCapable(clip: Clip): boolean {
  return (clip.kind === "audio" && clip.source.type === "asset") || clip.kind === "video";
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-56 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
        <MousePointerClick className="size-6" />
      </div>
      <div className="text-sm font-semibold">Select an audio or video clip</div>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
        Pick the clip to visualize in the timeline, then choose a template. Generated
        waveforms stay linked to their audio and re-shape live when its speed, trim or
        loop changes.
      </p>
    </div>
  );
}

// ── Create ────────────────────────────────────────────────────────────────────

function CreateView({ target }: { target: Clip }) {
  const doc = useDoc();
  const store = useDocStore();
  const frame = doc.frames.find((f) => f.id === target.frameId) ?? doc.frames[0]!;
  const [style, setStyle] = React.useState<WaveformStyle>(() =>
    defaultWaveformStyle({
      width: Math.round(frame.width * 0.85),
      height: Math.round(frame.height * 0.3),
    }),
  );
  const patch = (p: Partial<WaveformStyle>) => setStyle((s) => ({ ...s, ...p }));
  const applyPreset = (preset: WaveformPreset) => setStyle((s) => ({ ...s, ...preset.style }));

  const generate = () => {
    let createdId: string | null = null;
    store.update("Generate waveform", (d) => {
      const loc = locateClip(d, target.id);
      if (!loc) return;
      const clip = createWaveformClip({
        frameId: target.frameId,
        targetClipId: target.id,
        startMs: target.startMs,
        durationMs: target.durationMs,
        name: `${target.name} · Waves`,
        style,
      });
      // Land on the nearest track ABOVE the audio with room — right beside it —
      // or insert a fresh track directly above.
      let track = null;
      for (let i = loc.trackIndex - 1; i >= 0; i--) {
        const t = d.tracks[i]!;
        if (!t.locked && fitsInTrack(t, null, clip.startMs, clip.durationMs, clip.frameId)) {
          track = t;
          break;
        }
      }
      if (!track) {
        track = createTrack("Waves");
        d.tracks.splice(loc.trackIndex, 0, track);
      }
      // Link the pair so they select (and so move/split/delete) together.
      const group = loc.clip.linkGroupId ?? createId("link");
      loc.clip.linkGroupId = group;
      clip.linkGroupId = group;
      track.clips.push(clip);
      track.clips.sort((a, b) => a.startMs - b.startMs);
      createdId = clip.id;
    });
    if (createdId) {
      useSession.getState().select([createdId]);
      toast("Waveform generated — linked to its audio");
    }
  };

  return (
    <WaveformStudio
      style={style}
      patch={patch}
      applyPreset={applyPreset}
      target={target}
      linked={false}
      footer={
        <Button className="w-full gap-2" size="sm" onClick={generate}>
          <Sparkles className="size-4" /> Generate waveform
        </Button>
      }
    />
  );
}

// ── Edit ─────────────────────────────────────────────────────────────────────

function EditView({
  clip,
  target,
  retargetTo,
}: {
  clip: Clip & { kind: "waveform" };
  target: Clip | null;
  retargetTo: Clip | null;
}) {
  const store = useDocStore();
  const patch = (p: Partial<WaveformStyle>) =>
    store.update(
      "Edit waveform",
      (d) => {
        const loc = locateClip(d, clip.id);
        if (loc?.clip.kind === "waveform") Object.assign(loc.clip.style, p);
      },
      { mergeKey: `wave-style-${clip.id}` },
    );
  const applyPreset = (preset: WaveformPreset) => {
    store.update("Apply waveform preset", (d) => {
      const loc = locateClip(d, clip.id);
      if (loc?.clip.kind === "waveform") Object.assign(loc.clip.style, preset.style);
    });
    toast(`Preset “${preset.name}” applied`);
  };

  return (
    <WaveformStudio
      style={clip.style}
      patch={patch}
      applyPreset={applyPreset}
      target={target}
      linked={!!clip.linkGroupId}
      banner={
        !target ? (
          <div className="flex items-center gap-2 bg-destructive/10 px-3 py-2">
            <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 text-[11px] text-destructive">
              Its audio clip is gone — the wave draws silence.
            </span>
            {retargetTo && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[10px]"
                onClick={() =>
                  store.update("Retarget waveform", (d) => {
                    const loc = locateClip(d, clip.id);
                    if (loc?.clip.kind === "waveform") loc.clip.targetClipId = retargetTo.id;
                  })
                }
              >
                Use “{retargetTo.name}”
              </Button>
            )}
          </div>
        ) : null
      }
      footer={
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-success" />
          Live — edits apply instantly and stay in sync with the audio.
        </div>
      }
    />
  );
}

// ── The studio shell (unifies create + edit) ─────────────────────────────────

function WaveformStudio({
  style,
  patch,
  applyPreset,
  target,
  linked,
  banner,
  footer,
}: {
  style: WaveformStyle;
  patch: (p: Partial<WaveformStyle>) => void;
  applyPreset: (preset: WaveformPreset) => void;
  target: Clip | null;
  linked: boolean;
  banner?: React.ReactNode;
  footer: React.ReactNode;
}) {
  const [pickedId, setPickedId] = React.useState<string | null>(null);
  const pick = (p: WaveformPreset) => {
    setPickedId(p.id);
    applyPreset(p);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <TargetChip target={target} linked={linked} />
      {banner}
      <div className="flex min-h-0 flex-1">
        {/* LEFT — scrollable controls sidebar */}
        <aside className="flex w-75 shrink-0 flex-col border-r border-border/70">
          <ScrollArea className="min-h-0 flex-1">
            <StyleFields style={style} patch={patch} />
          </ScrollArea>
        </aside>
        {/* RIGHT — hero preview + preset browser */}
        <section className="flex min-w-0 flex-1 flex-col">
          <PreviewHero style={style} target={target} />
          <PresetBrowser pickedId={pickedId} onPick={pick} />
        </section>
      </div>
      <div className="shrink-0 border-t border-border/70 p-2.5">{footer}</div>
    </div>
  );
}

function TargetChip({ target, linked }: { target: Clip | null; linked: boolean }) {
  return (
    <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
      <div className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
        <AudioLines className="size-3.5" />
      </div>
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {target ? target.name : "No audio"}
      </span>
      {linked && (
        <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
          <Link2 className="size-2.5" /> linked
        </span>
      )}
    </div>
  );
}

// ── Live preview ─────────────────────────────────────────────────────────────

/**
 * Peaks for previews: the target's REAL sound around the playhead, read through
 * the same dispatch the renderer uses (spectrum or waveform), or demo peaks
 * until the decode lands / when there is no target.
 */
function usePreviewPeaks(target: Clip | null, style: WaveformStyle): Float32Array {
  const doc = useDoc();
  const playheadMs = useParkedPlayhead();
  const src = target ? waveformAudioSource(doc, target.id) : null;
  React.useEffect(() => {
    if (src) void ensureSoundAnalysis(src.assetId);
  }, [src?.assetId]); // eslint-disable-line react-hooks/exhaustive-deps
  const bins = styleBinCount(style);
  const { analysis } = useSoundAnalysis(src?.assetId ?? null);
  // MEMOIZED on exactly what the peaks depend on — so re-renders that change
  // none of it (dragging the plugin window, hovering) reuse the SAME array and
  // never re-run the spectrum/window read. Playback moves `playheadMs`, so the
  // preview still tracks the sound frame-for-frame.
  return React.useMemo(() => {
    if (!src || !analysis) return demoPeaks(bins);
    // Center on the playhead when it's inside the clip, else land inside it — a
    // spot with actual sound, so the preview never shows a dead flat line.
    const margin = Math.min(style.windowMs / 2, src.durationMs / 2);
    const local = Math.min(Math.max(playheadMs - src.startMs, margin), src.durationMs - margin);
    return visualizerBars(analysis, style, src, local);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, bins, style.mode, style.windowMs, style.decay, playheadMs, src?.startMs, src?.durationMs, src?.trimInMs]);
}

/**
 * The LIVE hero canvas — repaints only when its inputs change (style, peaks,
 * doc colors). The dependency array is the whole point: without it this
 * repainted on every render, so dragging the window or a playhead tick redrew it
 * needlessly. Static preset portraits use `PresetThumb` (paint once) instead.
 */
function WaveCanvas({
  style,
  peaks,
  className,
  dark = true,
}: {
  style: WaveformStyle;
  peaks: Float32Array;
  className?: string;
  dark?: boolean;
}) {
  const doc = useDoc();
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);
    paintWaveform(ctx, style, peaks, rect.width, rect.height, (c) => resolveColor(doc, c));
  }, [doc, style, peaks]);
  return (
    <canvas ref={ref} className={cn("block size-full", dark && "rounded-lg", className)} />
  );
}

function PreviewHero({ style, target }: { style: WaveformStyle; target: Clip | null }) {
  const peaks = usePreviewPeaks(target, style);
  return (
    <div className="shrink-0 p-3">
      <div className="relative overflow-hidden rounded-xl bg-[radial-gradient(120%_120%_at_50%_0%,#141821,#05060a)] ring-1 ring-white/5">
        <div className="h-44 p-3">
          <WaveCanvas style={style} peaks={peaks} className="rounded-none" dark={false} />
        </div>
        <div className="pointer-events-none absolute left-2.5 top-2.5 rounded-md bg-black/40 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white/60 backdrop-blur">
          Live preview
        </div>
      </div>
    </div>
  );
}

// ── Preset browser ───────────────────────────────────────────────────────────

/**
 * Preset thumbnails are STATIC portraits — they show a preset's look, not live
 * audio — so they are computed once at module load and painted once on mount.
 * Deterministic demo peaks + the preset's own hex style (no doc, no playhead)
 * means a thumbnail never needs to repaint. This is what keeps the gallery light:
 * 40 canvases that draw a single time and then sit idle through playback and
 * window drags, instead of 40 live spectrums competing every frame.
 */
const THUMB_PEAKS = demoPeaks(56);
const THUMB_STYLES = new Map(
  WAVEFORM_PRESETS.map((p) => [
    p.id,
    defaultWaveformStyle({ ...p.style, glow: Math.min(8, p.style.glow ?? 0) }),
  ]),
);

const PresetThumb = React.memo(function PresetThumb({ presetId }: { presetId: string }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const canvas = ref.current;
    const style = THUMB_STYLES.get(presetId);
    if (!canvas || !style) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    // Preset colors are plain hex, so no document color resolution is needed.
    paintWaveform(ctx, style, THUMB_PEAKS, rect.width, rect.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <canvas ref={ref} className="block size-full" />;
});

function PresetBrowser({
  pickedId,
  onPick,
}: {
  pickedId: string | null;
  onPick: (preset: WaveformPreset) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [cat, setCat] = React.useState<string>("All");

  const q = query.trim().toLowerCase();
  const visible = WAVEFORM_PRESETS.filter(
    (p) =>
      (cat === "All" || p.category === cat) &&
      (q === "" || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border/70">
      {/* Search + category tabs */}
      <div className="shrink-0 space-y-2 px-3 pb-2 pt-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search presets…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div className="scrollbar-none -mx-3 flex gap-1 overflow-x-auto px-3 pb-0.5">
          {["All", ...WAVEFORM_PRESET_CATEGORIES].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className={cn(
                "shrink-0 rounded-(--r-xs) px-2.5 py-1 text-[11px] font-medium transition-colors",
                cat === c
                  ? "material-glass-raised text-primary"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      {/* Thumbnail grid */}
      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-3 pb-3">
        {visible.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-muted-foreground">
            No presets match “{query}”.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {visible.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => onPick(preset)}
                title={preset.name}
                className={cn(
                  "group overflow-hidden rounded-lg text-left ring-1 transition-all",
                  pickedId === preset.id
                    ? "ring-2 ring-primary"
                    : "ring-border/70 hover:ring-primary/60",
                )}
              >
                <div className="h-14 bg-[radial-gradient(120%_120%_at_50%_0%,#141821,#05060a)] p-1.5">
                  <PresetThumb presetId={preset.id} />
                </div>
                <div className="flex items-center justify-between gap-1 px-2 py-1">
                  <span className="truncate text-[10px] font-medium text-foreground/80 group-hover:text-foreground">
                    {preset.name}
                  </span>
                  <span className="shrink-0 text-[9px] text-muted-foreground/70">{preset.category}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ── Style fields (the control sidebar) ───────────────────────────────────────

const TEMPLATES: Array<{ id: WaveformTemplate; label: string; icon: LucideIcon }> = [
  { id: "bars", label: "Bars", icon: BarChart3 },
  { id: "line", label: "Line", icon: Activity },
  { id: "area", label: "Area", icon: Mountain },
  { id: "circular", label: "Radial", icon: Disc3 },
  { id: "dots", label: "Dots", icon: Grid3x3 },
];

const MODES: Array<{ id: WaveformStyle["mode"]; label: string; icon: LucideIcon }> = [
  { id: "spectrum", label: "Spectrum", icon: Gauge },
  { id: "waveform", label: "Wave", icon: Waves },
];

const ROTATIONS = [0, 90, 180, 270];

function StyleFields({
  style,
  patch,
}: {
  style: WaveformStyle;
  patch: (p: Partial<WaveformStyle>) => void;
}) {
  const isBarsOrDots = style.template === "bars" || style.template === "dots";
  return (
    <>
      <Section title="Template" icon={Shapes}>
        <Segmented
          options={MODES}
          value={style.mode}
          onChange={(mode) => patch({ mode })}
          columns={2}
        />
        <Segmented
          options={TEMPLATES}
          value={style.template}
          onChange={(template) => patch({ template })}
          columns={5}
          compact
        />
      </Section>

      <Section title="Orientation" icon={RotateCw}>
        <Field label="Flip">
          <div className="grid grid-cols-2 gap-1.5">
            <IconToggle
              icon={FlipHorizontal2}
              label="Horizontal"
              active={style.flipX}
              onClick={() => patch({ flipX: !style.flipX })}
            />
            <IconToggle
              icon={FlipVertical2}
              label="Vertical"
              active={style.flipY}
              onClick={() => patch({ flipY: !style.flipY })}
            />
          </div>
        </Field>
        <Field label="Rotate" value={`${Math.round(style.rotateDeg)}°`}>
          <div className="grid grid-cols-4 gap-1">
            {ROTATIONS.map((deg) => (
              <button
                key={deg}
                type="button"
                onClick={() => patch({ rotateDeg: deg })}
                className={cn(
                  "rounded-md border py-1.5 text-[10px] font-medium transition-colors",
                  Math.round(style.rotateDeg) % 360 === deg
                    ? "border-primary bg-primary/15 text-foreground"
                    : "border-border/70 text-muted-foreground hover:text-foreground",
                )}
              >
                {deg}°
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Slider
              value={[style.rotateDeg]}
              min={-180}
              max={180}
              step={1}
              onValueChange={(v) => patch({ rotateDeg: v[0]! })}
              className="flex-1"
            />
            <button
              type="button"
              title="Reset rotation"
              onClick={() => patch({ rotateDeg: 0 })}
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RotateCcw className="size-3.5" />
            </button>
          </div>
        </Field>
      </Section>

      <Section title="Color" icon={Palette}>
        <Field label="Fill">
          <DocColorInput value={style.color} onChange={(c) => patch({ color: c })} />
        </Field>
        <Field label="Gradient">
          <div className="flex items-center gap-2">
            <Switch
              checked={style.color2 !== null}
              onCheckedChange={(on) => patch({ color2: on ? "#22d3ee" : null })}
            />
            {style.color2 !== null && (
              <DocColorInput
                value={style.color2}
                onChange={(c) => patch({ color2: c })}
                className="flex-1"
              />
            )}
          </div>
        </Field>
        <RangeField
          label="Glow"
          value={style.glow}
          min={0}
          max={120}
          step={1}
          onChange={(v) => patch({ glow: v })}
        />
      </Section>

      <Section title="Shape" icon={Shapes}>
        <Field label="Size">
          <div className="grid grid-cols-2 gap-1.5">
            <NumberInput label="W" value={style.width} min={16} onChange={(v) => patch({ width: v })} />
            <NumberInput label="H" value={style.height} min={16} onChange={(v) => patch({ height: v })} />
          </div>
        </Field>
        <RangeField
          label="Detail"
          value={style.barCount}
          min={8}
          max={256}
          step={1}
          unit="bars"
          onChange={(v) => patch({ barCount: Math.round(v) })}
        />
        {isBarsOrDots && (
          <RangeField
            label={style.template === "dots" ? "Dot size" : "Bar fill"}
            value={style.barFill}
            min={0.05}
            max={1}
            step={0.01}
            onChange={(v) => patch({ barFill: v })}
          />
        )}
        {style.template === "bars" && (
          <RangeField
            label="Rounding"
            value={style.roundness}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => patch({ roundness: v })}
          />
        )}
        {style.template !== "bars" && style.template !== "area" && (
          <RangeField
            label="Thickness"
            value={style.thickness}
            min={0.5}
            max={60}
            step={0.5}
            unit="px"
            onChange={(v) => patch({ thickness: v })}
          />
        )}
        <Field label="Mirror" hint="Symmetric around the center">
          <Switch checked={style.mirror} onCheckedChange={(v) => patch({ mirror: v })} />
        </Field>
      </Section>

      {style.template === "circular" && (
        <Section title="Ring" icon={Circle}>
          <RangeField
            label="Hole"
            value={style.innerRadius}
            min={0}
            max={0.95}
            step={0.01}
            onChange={(v) => patch({ innerRadius: v })}
          />
          <Field label="Start">
            <NumberInput value={style.startAngleDeg} step={1} unit="°" onChange={(v) => patch({ startAngleDeg: v })} />
          </Field>
          <RangeField
            label="Span"
            value={style.spanDeg}
            min={30}
            max={360}
            step={1}
            unit="°"
            onChange={(v) => patch({ spanDeg: v })}
          />
        </Section>
      )}

      <Section title="Audio response" icon={SlidersHorizontal}>
        <RangeField
          label="Amplitude"
          value={style.amplitude}
          min={0}
          max={4}
          step={0.05}
          onChange={(v) => patch({ amplitude: v })}
        />
        <RangeField
          label="Smoothing"
          value={style.smoothing}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => patch({ smoothing: v })}
        />
        {style.mode === "spectrum" ? (
          <RangeField
            label="Decay"
            value={style.decay}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => patch({ decay: v })}
          />
        ) : (
          <RangeField
            label="Window"
            value={style.windowMs}
            min={50}
            max={20000}
            step={50}
            unit="ms"
            onChange={(v) => patch({ windowMs: v })}
          />
        )}
      </Section>
    </>
  );
}

// ── Field kit ────────────────────────────────────────────────────────────────

/** A titled group with a hairline divider + section icon. */
function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/60 px-3 py-3">
      <div className="mb-2.5 flex items-center gap-1.5">
        <Icon className="size-3 text-muted-foreground/70" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

/** Label (+ optional value chip / hint) stacked over a full-width control. */
function Field({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground/80">{label}</span>
        {value !== undefined && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {value}
          </span>
        )}
        {value === undefined && hint && (
          <span className="text-[10px] text-muted-foreground/70">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/** Slider with a live value chip in the label row. */
function RangeField({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  const shown = step < 0.1 ? value.toFixed(2) : step < 1 ? value.toFixed(1) : Math.round(value).toString();
  return (
    <Field label={label} value={`${shown}${unit ? ` ${unit}` : ""}`}>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0]!)}
      />
    </Field>
  );
}

/** Icon + label segmented control (single-select). */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  columns,
  compact,
}: {
  options: Array<{ id: T; label: string; icon: LucideIcon }>;
  value: T;
  onChange: (v: T) => void;
  columns: number;
  compact?: boolean;
}) {
  return (
    <div
      className="grid gap-1 rounded-lg bg-muted/50 p-1"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            title={opt.label}
            className={cn(
              "flex flex-col items-center justify-center gap-1 rounded-md py-1.5 text-[10px] font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {!compact && <span>{opt.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** A single square icon toggle (flip buttons). */
function IconToggle({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-md border py-1.5 text-[10px] font-medium transition-colors",
        active
          ? "border-primary bg-primary/15 text-foreground"
          : "border-border/70 text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" /> {label}
    </button>
  );
}
