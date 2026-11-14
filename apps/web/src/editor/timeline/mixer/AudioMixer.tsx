"use client";

import * as React from "react";
import { Settings2, Sparkles, X } from "lucide-react";
import { dbToGain, gainToDb, mixLevelsAt, type MixPlan, type PlannedBus } from "@solomotion/core";
import { Range } from "@/components/ui/range";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../../state/document-context";
import { useSession } from "../../state/session";
import { usePanels } from "../../state/panels";
import { soundEngine } from "../../audio/sound-engine";
import { livePlan } from "../../audio/mix-state";
import { loudnessSource, useLoudnessVersion } from "../../audio/loudness-cache";
import { FrameSoundSections } from "../../inspector/mix/FrameSoundSections";
import { useBusUpdater } from "../../inspector/mix/use-mix";
import { clipLit, newMeter, paintBar, readLevel, stepMeter, type MeterState } from "./meter";

/**
 * THE AUDIO MIXER — every category of the comp you are in as a channel strip,
 * docked at the timeline's right edge the way Premiere's and Resolve's are.
 *
 * Strips come from the mix PLAN, so a category shows up the moment something
 * routes into it and a fader here is the category's own fader — the same
 * number the category panel edits. Meters are painted on a canvas by one
 * animation loop that reads the live graph's analysers; nothing re-renders
 * React while it plays.
 *
 * Parked, the meters do not go dark: each shows a hollow mark at the loudness
 * of the moment under the playhead (`mixLevelsAt`), so scrubbing is also
 * listening with your eyes.
 */

const FADER_FLOOR_DB = -60;
const FADER_MAX_DB = 12;

function faderDb(volume: number): number {
  return volume <= 0 ? FADER_FLOOR_DB : Math.max(FADER_FLOOR_DB, Math.min(FADER_MAX_DB, gainToDb(volume)));
}

export function AudioMixer() {
  const doc = useDoc();
  const store = useDocStore();
  const rootId = useSession((s) => s.nav.path.rootFrameId);
  const version = useLoudnessVersion((s) => s.version);
  const measuring = useLoudnessVersion((s) => s.queued);
  const frame = doc.frames.find((f) => f.id === rootId) ?? doc.frames[0]!;
  // `version` rebuilds the plan as measurements land (livePlan keys on it).
  const plan = React.useMemo(() => livePlan(doc, frame.id), [doc, frame.id, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const strips = [...plan.buses.values()].filter((b) => b.used);
  const leveler = frame.soundMix.leveler;

  const setMix = (label: string, fn: (m: typeof frame.soundMix) => void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        const f = d.frames.find((x) => x.id === frame.id);
        if (f) fn(f.soundMix);
      },
      mergeKey ? { mergeKey: `${mergeKey}-${frame.id}` } : undefined,
    );

  return (
    // THE LANES COME FIRST. The mixer takes what the region has left after
    // 20rem of lanes (never more than 60vw), and its strips scroll inside
    // that: on a 390 phone it is the master meter, not half the timeline.
    // `cqw` is the time region's width (`@container` there), so a mixer in a
    // narrow region and a mixer on a narrow screen obey the same rule.
    <div className="flex h-full min-h-0 w-fit max-w-[min(60vw,max(4.5rem,100cqw-20rem))] shrink-0 flex-col overflow-hidden border-l bg-background/60">
      {/* The header never sizes the mixer: it is a container (no intrinsic
          width), so the strips decide the width and the header folds to
          three icons when that is narrow (master-only, or a 390 phone). */}
      <div className="@container h-8 shrink-0 border-b">
      <div className="flex h-full items-center justify-center gap-0.5 px-0.5 @[9rem]:justify-start @[9rem]:gap-1 @[9rem]:px-2">
        <span className="hidden text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground @[9rem]:inline">Mix</span>
        <span className="hidden flex-1 @[9rem]:block" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-pressed={leveler.enabled}
              aria-label="Level"
              onClick={() => setMix(leveler.enabled ? "Leveler off" : "Leveler on", (m) => void (m.leveler.enabled = !m.leveler.enabled))}
              className={cn(
                "flex size-5 items-center justify-center gap-1 rounded-md text-[11px] transition-colors @[9rem]:h-(--control-h-sm) @[9rem]:w-auto @[9rem]:px-1.5",
                leveler.enabled ? "material-glass-raised text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Sparkles className={cn("size-3", measuring > 0 && leveler.enabled && "animate-pulse")} />
              <span className="hidden @[9rem]:inline">Level</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {leveler.enabled ? (measuring > 0 ? `Leveler on — measuring ${measuring}` : "Leveler on") : "Leveler off"}
          </TooltipContent>
        </Tooltip>
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label="Mix settings" className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground @[9rem]:size-(--control-h-sm) [&_svg]:size-3.5">
              <Settings2 />
            </button>
          </PopoverTrigger>
          <PopoverContent side="left" align="start" className="max-h-[70vh] w-80 overflow-y-auto p-0">
            <FrameSoundSections frame={frame} />
          </PopoverContent>
        </Popover>
        <button
          type="button"
          aria-label="Hide mixer"
          onClick={() => usePanels.getState().setVisible("mixer", false)}
          className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground @[9rem]:size-(--control-h-sm) [&_svg]:size-3.5"
        >
          <X />
        </button>
      </div>
      </div>
      <MeterBank plan={plan} strips={strips} masterVolume={frame.soundMix.volume} onMaster={(v) => setMix("Master level", (m) => void (m.volume = v), "master-vol")} />
    </div>
  );
}

/** Frames a stopped mixer keeps painting — the fall and the peak hold — before its loop parks. */
const PARK_AFTER_FRAMES = 300;

/** The strips + the loop that paints them. */
function MeterBank({
  plan,
  strips,
  masterVolume,
  onMaster,
}: {
  plan: MixPlan;
  strips: PlannedBus[];
  masterVolume: number;
  onMaster: (v: number) => void;
}) {
  const doc = useDoc();
  const canvases = React.useRef(new Map<string, HTMLCanvasElement>());
  const clipLights = React.useRef(new Map<string, HTMLSpanElement>());
  const planRef = React.useRef(plan);
  planRef.current = plan;
  const docRef = React.useRef(doc);
  docRef.current = doc;
  const wakeRef = React.useRef<() => void>(() => {});
  // A different mix reads differently: paint it, even parked.
  React.useEffect(() => wakeRef.current(), [doc, plan, strips]);

  React.useEffect(() => {
    const meters = new Map<string, MeterState[]>();
    const scratch = new Float32Array(2048);
    let raf = 0;
    let last = performance.now();
    let ghostAt = NaN;
    let ghost = new Map<string, number>();
    // PARKED WHEN STILL. Stopped, the meters fall and their peaks hold for a
    // moment; after that every frame paints the same picture. So the loop
    // stops asking for frames, and the transport, the playhead or the mix
    // waking it is what starts it again.
    let still = 0;
    let parked = false;
    const wake = () => {
      still = 0;
      if (!parked) return;
      parked = false;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    wakeRef.current = wake;
    const unsub = useSession.subscribe((s, prev) => {
      if (s.playing !== prev.playing || s.playheadMs !== prev.playheadMs) wake();
    });
    window.addEventListener("resize", wake);
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const graph = soundEngine.peekGraph();
      const { playing, playheadMs } = useSession.getState();
      // Parked: what this moment WOULD read. Recomputed only when the playhead moves.
      if (!playing && playheadMs !== ghostAt) {
        ghostAt = playheadMs;
        ghost = mixLevelsAt(docRef.current, planRef.current, loudnessSource, playheadMs);
      }
      for (const [id, canvas] of canvases.current) {
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const master = id === "master";
        const analysers = master ? graph?.masterMeters ?? null : graph?.meter(id) ? [graph.meter(id)!] : null;
        const count = master ? 2 : 1;
        let states = meters.get(id);
        if (!states) meters.set(id, (states = Array.from({ length: count }, newMeter)));
        const gap = 2;
        const bw = (w - gap * (count - 1)) / count;
        for (let i = 0; i < count; i++) {
          const a = analysers?.[i];
          const lvl = a && playing ? readLevel(a, scratch) : { peakDb: -Infinity, rmsDb: -Infinity };
          stepMeter(states[i]!, lvl.peakDb, lvl.rmsDb, now, dt);
          paintBar(ctx, i * (bw + gap), bw, h, states[i]!, playing ? null : ghost.get(id) ?? null);
        }
        const light = clipLights.current.get(id);
        if (light) light.dataset.lit = states.some((s) => clipLit(s, now)) ? "1" : "0";
      }
      if (playing) still = 0;
      else if (++still > PARK_AFTER_FRAMES) {
        cancelAnimationFrame(raf);
        parked = true;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
      window.removeEventListener("resize", wake);
      wakeRef.current = () => {};
    };
  }, []);

  const bind = (id: string) => (el: HTMLCanvasElement | null) => {
    if (el) canvases.current.set(id, el);
    else canvases.current.delete(id);
  };
  const bindLight = (id: string) => (el: HTMLSpanElement | null) => {
    if (el) clipLights.current.set(id, el);
    else clipLights.current.delete(id);
  };

  return (
    <div className="flex min-h-0 flex-1 gap-1 overflow-x-auto p-1.5">
      {strips.map((s) => (
        <BusStrip key={s.bus.id} planned={s} canvas={bind(s.bus.id)} light={bindLight(s.bus.id)} />
      ))}
      <Strip
        name="Master"
        color="var(--foreground)"
        wide
        canvas={bind("master")}
        light={bindLight("master")}
        volume={masterVolume}
        onVolume={onMaster}
      />
    </div>
  );
}

function BusStrip({
  planned,
  canvas,
  light,
}: {
  planned: PlannedBus;
  canvas: (el: HTMLCanvasElement | null) => void;
  light: (el: HTMLSpanElement | null) => void;
}) {
  const update = useBusUpdater();
  const { bus } = planned;
  return (
    <Strip
      name={bus.name}
      color={bus.color}
      canvas={canvas}
      light={light}
      volume={bus.volume}
      onVolume={(v) => update(bus.id, "Category level", (b) => void (b.volume = v), "bus-vol")}
      onName={() => {
        useSession.getState().inspectSoundBus(bus.id);
        usePanels.getState().setVisible("inspector", true);
      }}
      muted={bus.muted}
      solo={bus.solo}
      dimmed={planned.gain === 0}
      onMute={() => update(bus.id, bus.muted ? "Unmute category" : "Mute category", (b) => void (b.muted = !b.muted))}
      onSolo={() => update(bus.id, bus.solo ? "Unsolo category" : "Solo category", (b) => void (b.solo = !b.solo))}
    />
  );
}

/** One channel strip: name, meter + fader, readout, M/S. */
function Strip({
  name,
  color,
  wide,
  canvas,
  light,
  volume,
  onVolume,
  onName,
  muted,
  solo,
  dimmed,
  onMute,
  onSolo,
}: {
  name: string;
  color: string;
  wide?: boolean;
  canvas: (el: HTMLCanvasElement | null) => void;
  light: (el: HTMLSpanElement | null) => void;
  volume: number;
  onVolume: (v: number) => void;
  onName?: () => void;
  muted?: boolean;
  solo?: boolean;
  dimmed?: boolean;
  onMute?: () => void;
  onSolo?: () => void;
}) {
  const db = faderDb(volume);
  return (
    <div className={cn("flex min-h-0 shrink-0 flex-col items-center gap-1 rounded-md bg-muted/30 px-1 py-1", wide ? "w-16" : "w-12", dimmed && "opacity-50")}>
      <button
        type="button"
        onClick={onName}
        disabled={!onName}
        title={name}
        className="flex w-full min-w-0 items-center justify-center gap-1 rounded px-0.5 text-[10px] font-medium enabled:hover:bg-accent"
      >
        <span aria-hidden className="h-2 w-1 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate">{name}</span>
      </button>
      <span ref={light} data-lit="0" aria-label="Clip" className="h-1 w-full rounded-full bg-muted data-[lit=1]:bg-[#ff4d4d]" />
      <div className="flex min-h-0 w-full flex-1 justify-center gap-1">
        <canvas ref={canvas} className={cn("h-full", wide ? "w-5" : "w-2.5")} />
        <Range
          value={db}
          min={FADER_FLOOR_DB}
          max={FADER_MAX_DB}
          step={0.5}
          precision={1}
          orientation="vertical"
          length="100%"
          thickness={10}
          defaultValue={0}
          ticks={[0]}
          format={(v) => (v <= FADER_FLOOR_DB ? "−∞" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`)}
          onChange={(v) => onVolume(v <= FADER_FLOOR_DB ? 0 : dbToGain(v))}
        />
      </div>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        {db <= FADER_FLOOR_DB ? "−∞" : `${db > 0 ? "+" : ""}${db.toFixed(1)}`}
      </span>
      {onMute && onSolo && (
        <div className="flex gap-0.5">
          <button
            type="button"
            aria-pressed={muted}
            aria-label={muted ? "Unmute" : "Mute"}
            onClick={onMute}
            className={cn("size-4 rounded text-[9px] font-bold", muted ? "bg-[#ff4d4d] text-white" : "bg-muted text-muted-foreground hover:text-foreground")}
          >
            M
          </button>
          <button
            type="button"
            aria-pressed={solo}
            aria-label={solo ? "Unsolo" : "Solo"}
            onClick={onSolo}
            className={cn("size-4 rounded text-[9px] font-bold", solo ? "bg-[#f5c542] text-black" : "bg-muted text-muted-foreground hover:text-foreground")}
          >
            S
          </button>
        </div>
      )}
    </div>
  );
}
