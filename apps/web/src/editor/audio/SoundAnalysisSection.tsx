"use client";

import * as React from "react";
import { SOUND_FEATURES, mediaSourceAt, soundBandsAt, type Clip, type SoundAnalysis, type SoundFeature } from "@solomotion/core";
import { AudioWaveform, Braces, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/lib/toast";
import { PanelSection, PropRow } from "../inspector/controls";
import { usePluginWindows } from "../plugins/plugin-windows";
import { useSession } from "../state/session";
import { useDoc } from "../state/document-context";
import { ensureSoundAnalysis, useSoundAnalysis } from "./sound-host";

/**
 * "Analysis" on a sound: what the recording is made of, and the ways in.
 *
 * Opening it is the ask — the analysis starts (or loads from cache) the moment
 * a sound is selected, so by the time you reach for it, it is there. The meter
 * is the analysis itself at the playhead, not a second listener, so what moves
 * here is exactly what `sound()`, the Sound node and a visualizer read.
 */

const METER_BARS = 40;

export function SoundAnalysisSection({ clip, assetId }: { clip: Clip; assetId: string }) {
  const { status, analysis } = useSoundAnalysis(assetId);
  React.useEffect(() => {
    void ensureSoundAnalysis(assetId);
  }, [assetId]);

  const copy = (feature: SoundFeature) => {
    const expr = feature === "level" ? `sound("${clip.name}")` : `sound("${clip.name}", "${feature}")`;
    void navigator.clipboard?.writeText(expr);
    toast(`Copied ${expr}`, { description: "Paste it into any field's expression. It reads 0 to 1." });
  };

  return (
    <PanelSection id="sound-analysis" title="Analysis">
      {analysis ? (
        <>
          <PropRow wide>
            <Meter clip={clip} analysis={analysis} />
          </PropRow>
          <PropRow label="Tempo" hint={'Beats per minute. sound(…, "beat") pulses on each one.'}>
            <span className="text-xs tabular-nums">{analysis.tempo ? `${Math.round(analysis.tempo)} BPM` : "No steady beat"}</span>
          </PropRow>
          <PropRow label="Hits" hint={'Drums, plucks, consonants. sound(…, "onset") spikes on each.'}>
            <span className="text-xs tabular-nums">
              {analysis.onsets.length} · peak {analysis.peakDb} dB
            </span>
          </PropRow>
          <PropRow wide>
            <div className="flex w-full gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 flex-1 text-xs"
                onClick={() => {
                  useSession.getState().select([clip.id]);
                  usePluginWindows.getState().open("waveform");
                }}
              >
                <AudioWaveform /> Visualizer
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 flex-1 text-xs">
                    <Braces /> Drive with…
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Copy an expression</DropdownMenuLabel>
                  {SOUND_FEATURES.map((f) => (
                    <DropdownMenuItem key={f.id} onSelect={() => copy(f.id)} title={f.describe} className="text-xs">
                      {f.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </PropRow>
        </>
      ) : status?.state === "failed" ? (
        <PropRow wide>
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-[11px] text-warning">{status.message}</span>
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => void ensureSoundAnalysis(assetId, { force: true })}>
              <RotateCcw /> Retry
            </Button>
          </div>
        </PropRow>
      ) : (
        <PropRow wide>
          <span className="text-[11px] text-muted-foreground">
            Listening…{status?.state === "analyzing" ? ` ${Math.round(status.progress * 100)}%` : ""}
          </span>
        </PropRow>
      )}
    </PanelSection>
  );
}

/** The spectrum at the playhead, bass to treble, through the clip's own time map. */
function Meter({ clip, analysis }: { clip: Clip; analysis: SoundAnalysis }) {
  const doc = useDoc();
  const playheadMs = useSession((s) => s.playheadMs);
  const ref = React.useRef<HTMLCanvasElement>(null);
  const sourceMs = React.useMemo(() => mediaSourceAt(doc, clip, playheadMs)?.sourceMs ?? null, [doc, clip, playheadMs]);
  React.useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bars = sourceMs === null ? new Float32Array(METER_BARS) : soundBandsAt(analysis, sourceMs, METER_BARS);
    const slot = w / METER_BARS;
    ctx.fillStyle = getComputedStyle(canvas).color;
    for (let i = 0; i < METER_BARS; i++) {
      const bh = Math.max(1, bars[i]! * h);
      ctx.globalAlpha = 0.35 + 0.65 * bars[i]!;
      ctx.fillRect(i * slot + 0.5, h - bh, Math.max(1, slot - 1.5), bh);
    }
  }, [analysis, sourceMs]);
  return <canvas ref={ref} className="h-9 w-full text-primary" aria-label="Spectrum at the playhead" />;
}
