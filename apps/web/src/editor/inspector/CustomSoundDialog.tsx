"use client";

import * as React from "react";
import { createId, type CustomSoundRef } from "@solomotion/core";
import { Play, Upload } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { putAssetBlob } from "../assets/asset-store";
import { saveAppSound } from "../audio/app-sounds";
import { soundEngine } from "../audio/sound-engine";
import { drawWaveform, ensureAudioBuffer, waveformPeaks } from "../audio/waveform";
import { useDocStore } from "../state/document-context";
import { capturePointer } from "../input/capture-pointer";

/**
 * The custom-sound importer: pick an audio file, see its REAL waveform (same
 * painter as the timeline), and drag the HIT POINT — the moment in the file
 * where the action lands. Typing cues align that moment to each letter's
 * appearance, so the file's attack leads in naturally. The hit point is
 * auto-suggested at the loudest peak. Saving asks where the sound lives:
 * this project (travels with the file) or all projects on this device.
 *
 * `fromAsset` points it at audio ALREADY in the media library instead of the
 * file picker. Choosing a hit point is the same decision either way, so it is
 * the same dialog — an imported track and a dropped file must never diverge
 * into two flows that ask the same question differently.
 */

/** The loudest moment — the obvious default for "when does this strike?". */
function suggestHitMs(buffer: AudioBuffer): number {
  const peaks = waveformPeaks(buffer, 200);
  let best = 0;
  for (let i = 1; i < peaks.length; i++) if (peaks[i]! > peaks[best]!) best = i;
  return Math.round(((best + 0.5) / peaks.length) * buffer.duration * 1000);
}

export function CustomSoundDialog({
  open,
  onOpenChange,
  onSaved,
  fromAsset = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (ref: CustomSoundRef) => void;
  /** Start from an asset already in this project instead of picking a file. */
  fromAsset?: { assetId: string; name: string } | null;
}) {
  const store = useDocStore();
  const [file, setFile] = React.useState<File | null>(null);
  const [buffer, setBuffer] = React.useState<AudioBuffer | null>(null);
  const [name, setName] = React.useState("");
  const [hitMs, setHitMs] = React.useState(0);
  const [scope, setScope] = React.useState<"project" | "app">("project");
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const stripRef = React.useRef<HTMLDivElement | null>(null);

  // Library hand-off: decode the existing asset through the shared cache and
  // suggest a hit point exactly as an import would.
  React.useEffect(() => {
    if (!open || !fromAsset) return;
    let live = true;
    void ensureAudioBuffer(fromAsset.assetId).then((decoded) => {
      if (!live || !decoded) return;
      setBuffer(decoded);
      setName(fromAsset.name);
      setHitMs(suggestHitMs(decoded));
    });
    return () => void (live = false);
  }, [open, fromAsset?.assetId, fromAsset?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => {
    setFile(null);
    setBuffer(null);
    setName("");
    setHitMs(0);
  };

  const pickFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const ctx = new AudioContext();
        const decoded = await ctx.decodeAudioData(await f.arrayBuffer());
        void ctx.close();
        setFile(f);
        setBuffer(decoded);
        setName(f.name.replace(/\.[^.]+$/, ""));
        setHitMs(suggestHitMs(decoded));
      } catch {
        toast("Couldn't decode that audio file");
      }
    };
    input.click();
  };

  // Waveform painting (same painter as the timeline).
  React.useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !buffer) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    drawWaveform(
      ctx,
      waveformPeaks(buffer, Math.max(48, Math.floor(rect.width / 2))),
      { x: 0, y: 4, w: rect.width, h: rect.height - 8 },
      "#8FBF9A",
    );
  }, [buffer, open]);

  const dragHit = (e: React.PointerEvent) => {
    if (!buffer) return;
    const strip = stripRef.current;
    if (!strip) return;
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);
    const rect = strip.getBoundingClientRect();
    const apply = (clientX: number) => {
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      setHitMs(Math.round(frac * buffer.duration * 1000));
    };
    apply(e.clientX);
    const onMove = (ev: PointerEvent) => apply(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const save = async () => {
    if (!buffer) return;
    // Adopting a library asset reuses its id and bytes — re-uploading the same
    // audio under a second id is exactly the duplicate this branch prevents.
    if (fromAsset) {
      store.update("Add custom sound", (d) => {
        d.customSounds.push({ id: createId("csnd"), name: name || fromAsset.name, assetId: fromAsset.assetId, hitMs });
      });
      onSaved({ assetId: fromAsset.assetId, hitMs });
      onOpenChange(false);
      reset();
      toast("Saved to this project");
      return;
    }
    if (!file) return;
    const assetId = createId("asset");
    await putAssetBlob(assetId, file);
    const meta = {
      id: assetId,
      kind: "audio" as const,
      name: name || file.name,
      mime: file.type || "audio/mpeg",
      bytes: file.size,
      width: null,
      height: null,
      durationMs: Math.round(buffer.duration * 1000),
      fps: null,
      folderId: null,
      origin: null,
    };
    // The current project always gets the asset + a saved preset entry.
    store.update("Add custom sound", (d) => {
      d.assets.push(meta);
      d.customSounds.push({ id: createId("csnd"), name: meta.name, assetId, hitMs });
    });
    if (scope === "app") {
      saveAppSound({
        id: assetId,
        name: meta.name,
        hitMs,
        mime: meta.mime,
        bytes: meta.bytes,
        durationMs: meta.durationMs,
      });
    }
    onSaved({ assetId, hitMs });
    onOpenChange(false);
    reset();
    toast(scope === "app" ? "Saved for all your projects" : "Saved to this project");
  };

  const hitFrac = buffer ? hitMs / 1000 / buffer.duration : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{fromAsset ? "Set the hit point" : "Custom typing sound"}</DialogTitle>
          <DialogDescription>
            Import a sound and set its <span className="text-foreground">hit point</span> — the
            moment that should land exactly when a letter appears.
          </DialogDescription>
        </DialogHeader>

        {!buffer ? (
          <button
            type="button"
            onClick={pickFile}
            className="flex h-28 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground [&_svg]:size-5"
          >
            <Upload />
            Choose an audio file…
          </button>
        ) : (
          <div className="space-y-3">
            <div
              ref={stripRef}
              onPointerDown={dragHit}
              className="relative h-24 w-full cursor-ew-resize overflow-hidden rounded-lg border border-border/70 bg-secondary/40"
            >
              <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
              {/* The hit point marker. */}
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-primary"
                style={{ left: `${hitFrac * 100}%` }}
              >
                <div className="absolute -top-0 left-1/2 size-2 -translate-x-1/2 rotate-45 bg-primary" />
              </div>
              <span
                className="pointer-events-none absolute bottom-1 rounded bg-background/85 px-1 font-mono text-[10px] text-primary"
                style={{ left: `calc(${Math.min(88, hitFrac * 100)}% + 4px)` }}
              >
                hit {(hitMs / 1000).toFixed(2)}s
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="icon-sm"
                aria-label="Preview"
                onClick={() => {
                  const ctx = new AudioContext();
                  const src = ctx.createBufferSource();
                  src.buffer = buffer;
                  src.connect(ctx.destination);
                  src.onended = () => void ctx.close();
                  src.start();
                }}
              >
                <Play />
              </Button>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Sound name"
                className="h-8 w-full min-w-0 flex-1 rounded-md border border-transparent bg-input/45 px-2 text-xs outline-none transition-colors hover:border-border focus:border-primary/60"
                spellCheck={false}
              />
            </div>
            <div className={cn("track grid grid-cols-2 gap-0.5 bg-muted/60 text-[11px]", fromAsset && "hidden")}>
              {(
                [
                  ["project", "This project"],
                  ["app", "All my projects"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setScope(value)}
                  className={cn(
                    "rounded-md px-2 py-1.5 font-medium transition-colors",
                    scope === value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!buffer} onClick={() => void save()}>
            {fromAsset ? "Use this sound" : "Save sound"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Re-exported so pack pickers can preview a custom ref uniformly.
export function previewCustomSound(ref: CustomSoundRef): void {
  soundEngine.previewCustom(ref.assetId);
}
