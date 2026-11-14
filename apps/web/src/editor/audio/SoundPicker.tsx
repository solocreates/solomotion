"use client";

import * as React from "react";
import { guardTrimDb, type CustomSoundRef, type LibraryItem, type SoundVoice } from "@solomotion/core";
import { ChevronDown, Download, Import, Loader2, Play, Volume2 } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { CustomSoundDialog } from "../inspector/CustomSoundDialog";
import {
  adoptDeviceSound,
  SOUND_GROUP_LABELS,
  soundCatalog,
  soundOptionId,
  type SoundGroup,
  type SoundOption,
} from "./sound-catalog";
import {
  audibleSeconds,
  packBufferSync,
  renderPackBuffer,
  soundEngine,
} from "./sound-engine";
import {
  drawWaveform,
  ensureAudioBuffer,
  getAudioBufferForAsset,
  onAudioBufferReady,
  waveformPeaks,
} from "./waveform";
import { listAppSounds } from "./app-sounds";
import { PeaksWave } from "../library/PeaksWave";
import { auditionItem } from "../library/audition";
import { useAuditionPrefs } from "../library/audition-prefs";
import { downloadWithToast } from "../library/downloads";
import { useOnlineSounds } from "../library/use-online-sounds";

/**
 * THE sound picker — one searchable panel that offers every sound the project
 * can play (synth packs, its own saved sounds, this device's, and any audio in
 * the media library), draws each one's REAL waveform, and lets you audition it
 * before you commit.
 *
 * It replaces a bare `<Select>` of names, which had three problems worth naming:
 * you could not hear a sound without applying it first, the media library was
 * invisible to it, and every audition fired at the clip's own volume — so the
 * first click was routinely a jump-scare. The audition volume lives on the
 * DOCUMENT (`soundPreviewVolume`), so it is set once per project and also seeds
 * the volume of whatever you pick: what you auditioned is what you get.
 *
 * Same shape as the variable picker — a `PopoverContent` full of cmdk — so it
 * inherits search, ↑↓/⏎ and every edge case the primitive already solves, and
 * any future surface (a sound library, a preset browser) drops into the same
 * groups by extending `soundCatalog`, not this file.
 */

/* -------------------------------------------------------------------------- */
/* Buffers — one hook, whichever kind of sound it is                          */
/* -------------------------------------------------------------------------- */

/**
 * The decoded audio behind an option. Packs are SYNTHESIZED, so they are
 * rendered offline into a buffer on first sight; files decode through the same
 * cache the timeline uses. Callers never learn which is which — that is the
 * whole point of the catalogue.
 */
export function useSoundBuffer(option: SoundOption | null): AudioBuffer | null {
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!option) return;
    if (option.pack) {
      if (!packBufferSync(option.pack))
        void renderPackBuffer(option.pack).then(bump);
      return;
    }
    if (option.assetId && !getAudioBufferForAsset(option.assetId)) {
      void ensureAudioBuffer(option.assetId).then(bump);
    }
    return onAudioBufferReady(bump);
  }, [option?.id, option?.pack, option?.assetId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!option) return null;
  return option.pack
    ? packBufferSync(option.pack)
    : option.assetId
      ? getAudioBufferForAsset(option.assetId)
      : null;
}

/* -------------------------------------------------------------------------- */
/* Waveform                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A sound's waveform, painted with the SAME painter as the timeline so a
 * built-in pack and an imported file are drawn by one piece of code.
 *
 * While auditioning, a playhead sweeps across it and the part already heard is
 * drawn at full strength — the bit of motion that makes a row read as *sounding*
 * rather than merely selected. It sweeps over the AUDIBLE span, not the buffer
 * length: packs render into a fixed 300 ms canvas of which ~40 ms is sound, and
 * a sweep that spends the rest of its run over silence looks broken.
 *
 * Colour comes from the element's own `color`, so it is theme-correct for free.
 */
export function SoundWave({
  option,
  playing = false,
  className,
}: {
  option: SoundOption | null;
  playing?: boolean;
  className?: string;
}) {
  const buffer = useSoundBuffer(option);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [progress, setProgress] = React.useState(1);

  const audible = React.useMemo(
    () => (buffer ? Math.max(0.06, audibleSeconds(buffer)) : 0),
    [buffer],
  );

  // The sweep. A fresh rAF loop per audition; `playing` going false parks it at
  // full so the row settles back to its resting look.
  React.useEffect(() => {
    if (!playing || !audible) {
      setProgress(1);
      return;
    }
    // Floor the sweep at 260 ms: a 40 ms pack is over before the eye can follow,
    // and the point of the animation is to be seen.
    const runMs = Math.max(260, audible * 1000);
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const t = (performance.now() - start) / runMs;
      setProgress(Math.min(1, t));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, audible]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!buffer) return;
    const color = getComputedStyle(canvas).color;
    const bins = Math.max(24, Math.floor(rect.width / 2.5));
    const peaks = waveformPeaks(buffer, bins, 0, audible);
    const box = { x: 0, y: 0, w: rect.width, h: rect.height };
    // Resting bars first, then the heard span repainted opaque over them.
    ctx.globalAlpha = 0.3;
    drawWaveform(ctx, peaks, box, color);
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, rect.width * progress, rect.height);
    ctx.clip();
    drawWaveform(ctx, peaks, box, color);
    ctx.restore();
  }, [buffer, audible, progress]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("h-full w-full", className)}
      aria-hidden
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The picker                                                                  */
/* -------------------------------------------------------------------------- */

const GROUP_ORDER: SoundGroup[] = ["packs", "project", "device", "library"];

export interface SoundPickerProps {
  value: Pick<SoundVoice, "pack" | "custom" | "pitch">;
  /** Patch the voice. `volume` rides along on a fresh pick — see the header. */
  onChange: (patch: Partial<SoundVoice>, label: string) => void;
}

function useAudition(previewVolume: number, pitch: number) {
  const [playingId, setPlayingId] = React.useState<string | null>(null);
  const timer = React.useRef<number | null>(null);
  const play = React.useCallback(
    (option: SoundOption) => {
      if (option.pack) soundEngine.preview(option.pack, previewVolume, pitch);
      else if (option.assetId)
        soundEngine.previewCustom(option.assetId, previewVolume);
      setPlayingId(option.id);
      if (timer.current) window.clearTimeout(timer.current);
      // Long enough to cover the sweep; the sound itself is scheduled and does
      // not care when we stop *looking* at it.
      timer.current = window.setTimeout(
        () => setPlayingId(null),
        Math.max(320, (option.durationMs ?? 300) + 60),
      );
    },
    [previewVolume, pitch],
  );
  React.useEffect(
    () => () => void (timer.current && window.clearTimeout(timer.current)),
    [],
  );
  return { playingId, play };
}

export function SoundPickerContent({
  value,
  onChange,
  onClose,
  onAdopt,
  className,
  ...rest
}: SoundPickerProps &
  Omit<React.ComponentProps<typeof PopoverContent>, "value" | "onChange"> & {
    onClose: () => void;
    /**
     * Hand a sound that still needs a hit point (a library asset, or a fresh
     * import) to the caller. The hit-point dialog CANNOT live in here: opening
     * it takes focus, which closes the popover, which would unmount the dialog
     * mid-open. The owner renders it outside the popover instead.
     */
    onAdopt: (option: SoundOption | null) => void;
  }) {
  const doc = useDoc();
  const store = useDocStore();
  const options = React.useMemo(() => soundCatalog(doc), [doc]);
  const currentId = soundOptionId(value);
  const previewVolume = doc.soundPreviewVolume;
  const { playingId, play } = useAudition(previewVolume, value.pitch);
  // The typed query drives BOTH cmdk's local filtering and the online search,
  // so one search box searches everything — which is the only behaviour anyone
  // would expect of a search box.
  const [search, setSearch] = React.useState("");
  const owned = React.useMemo(
    () => listAppSounds().map((s) => s.originId).filter((x): x is string => Boolean(x)),
    [],
  );
  const online = useOnlineSounds(search, owned);
  // The same guard the sound browser applies — it lives below both of them now,
  // so this row only has to SAY when it is holding something down.
  const guard = useAuditionPrefs((s) => s.guard);
  const [downloading, setDownloading] = React.useState<string | null>(null);

  /**
   * Pick an ONLINE sound: download it, which saves it to this device, then
   * adopt it into the document through the very same path a device sound takes.
   * One gesture, and afterwards the sound is indistinguishable from one you had
   * all along — which is what "the document stays self-contained" means.
   */
  const chooseOnline = async (item: LibraryItem) => {
    setDownloading(item.id);
    const result = await downloadWithToast(item);
    setDownloading(null);
    if (!result) return;
    const ref = adoptDeviceSound(store, {
      id: `asset:${result.localId}`,
      group: "device",
      name: item.name,
      pack: null,
      assetId: result.localId,
      hitMs: item.preview.type === "peaks" ? item.preview.hitMs : 0,
      durationMs: item.preview.type === "peaks" ? item.preview.durationMs : null,
      needsAdoption: true,
    });
    if (!ref) return;
    onChange({ custom: ref, volume: previewVolume }, "Change sound");
    onClose();
  };

  const setPreviewVolume = (v: number) =>
    store.update(
      "Set audition volume",
      (d) => void (d.soundPreviewVolume = v),
      { mergeKey: "sound-preview-volume" },
    );

  const choose = (option: SoundOption) => {
    // Audition on select too — you should always hear what you just chose.
    play(option);
    if (option.pack) {
      onChange(
        { pack: option.pack, custom: null, volume: previewVolume },
        "Change sound pack",
      );
      onClose();
      return;
    }
    // A library asset has no hit point yet — picking one hands off to the same
    // editor an import uses, seeded with that asset.
    if (option.group === "library") {
      onAdopt(option);
      onClose();
      return;
    }
    const ref: CustomSoundRef | null =
      option.group === "device"
        ? adoptDeviceSound(store, option)
        : { assetId: option.assetId!, hitMs: option.hitMs };
    if (!ref) return;
    onChange({ custom: ref, volume: previewVolume }, "Change sound");
    onClose();
  };

  return (
    <PopoverContent
      align="end"
      sideOffset={6}
      className={cn("w-80 p-0", className)}
      {...rest}
    >
      <Command>
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder="Search sounds — and the online library…"
        />
        <CommandList className="max-h-80">
          <CommandEmpty className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            No sound matches. Import one below.
          </CommandEmpty>
          {GROUP_ORDER.map((group) => {
            const rows = options.filter((o) => o.group === group);
            if (rows.length === 0) return null;
            return (
              <CommandGroup key={group} heading={SOUND_GROUP_LABELS[group]}>
                {rows.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={`${option.name} ${SOUND_GROUP_LABELS[group]}`}
                    onSelect={() => choose(option)}
                    className="gap-2"
                  >
                    <button
                      type="button"
                      aria-label={`Audition ${option.name}`}
                      // Audition without choosing — the reason the panel exists.
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        play(option);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground [&_svg]:size-3"
                    >
                      <Play />
                    </button>
                    <span className="min-w-0 flex-1 truncate">
                      {option.name}
                    </span>
                    <span
                      className={cn(
                        "h-5 w-20 shrink-0 transition-colors",
                        currentId === option.id || playingId === option.id
                          ? "text-primary"
                          : "text-muted-foreground",
                      )}
                    >
                      <SoundWave
                        option={option}
                        playing={playingId === option.id}
                      />
                    </span>
                    {currentId === option.id && (
                      <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}
          {(online.items.length > 0 || online.loading) && (
            <CommandGroup
              heading={
                <span className="flex items-center gap-1.5">
                  Online library
                  {online.loading && <Loader2 className="size-2.5 animate-spin" />}
                </span>
              }
            >
              {online.items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  keywords={[item.name, ...item.tags, search]}
                  onSelect={() => void chooseOnline(item)}
                  className="gap-2"
                >
                  <button
                    type="button"
                    aria-label={`Audition ${item.name}`}
                    // Auditioning streams from the public URL — hearing a sound
                    // is not acquiring it, and a picker that downloaded
                    // everything you listened to would fill a disk by lunchtime.
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      auditionItem(item, previewVolume);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground [&_svg]:size-3"
                  >
                    <Play />
                  </button>
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {/* A guard that silently changed what you are judging would
                      be worse than no guard: you would blame the sound. */}
                  {item.preview.type === "peaks" &&
                    guardTrimDb(item.preview.loudnessDb, guard) < -0.5 && (
                      <span
                        title={`Held ${Math.round(-guardTrimDb(item.preview.loudnessDb, guard))} dB down`}
                        className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70"
                      >
                        {Math.round(guardTrimDb(item.preview.loudnessDb, guard))}
                      </span>
                    )}
                  {item.preview.type === "peaks" && (
                    <PeaksWave
                      peaks={item.preview.peaks}
                      durationMs={item.preview.durationMs}
                      hitMs={item.preview.hitMs}
                      className="h-5 w-20 shrink-0 text-muted-foreground"
                    />
                  )}
                  {downloading === item.id ? (
                    <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
                  ) : (
                    <Download className="size-3 shrink-0 text-muted-foreground" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandSeparator />
          <CommandGroup>
            <CommandItem
              value="import add custom sound file"
              onSelect={() => {
                onAdopt(null);
                onClose();
              }}
              className="gap-2"
            >
              <Import className="size-3.5" />
              Import a sound…
            </CommandItem>
          </CommandGroup>
        </CommandList>
        {/* Audition volume: one control for every preview in the project, and
              the starting volume of whatever you pick. Lives at the bottom
              because it is a setting, not a choice. */}
        <div className="flex items-center gap-2 border-t border-border/70 px-3 py-2">
          <Volume2 className="size-3.5 shrink-0 text-muted-foreground" />
          <Slider
            value={[Math.round(previewVolume * 100)]}
            min={0}
            max={100}
            step={1}
            aria-label="Audition volume"
            onValueChange={([v]) => setPreviewVolume((v ?? 70) / 100)}
            className="flex-1"
          />
          <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
            {Math.round(previewVolume * 100)}%
          </span>
        </div>
      </Command>
    </PopoverContent>
  );
}

/**
 * The field: what the voice sounds like right now, its waveform, and a click to
 * change it. Drops into any inspector row — the whole picker travels with it.
 */
export function SoundField({ value, onChange }: SoundPickerProps) {
  const doc = useDoc();
  const [open, setOpen] = React.useState(false);
  // `null` inside the tuple means "import a file"; no tuple means no dialog.
  const [adopting, setAdopting] = React.useState<[SoundOption | null] | null>(
    null,
  );
  const options = React.useMemo(() => soundCatalog(doc), [doc]);
  const current = options.find((o) => o.id === soundOptionId(value)) ?? null;
  const { playingId, play } = useAudition(doc.soundPreviewVolume, value.pitch);
  const adoptingOption = adopting?.[0] ?? null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-transparent bg-input/45 px-2 text-xs outline-none transition-colors hover:border-border focus-visible:border-primary/60 data-[state=open]:border-primary/60"
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {current?.name ?? "Missing sound"}
            </span>
            <span className="h-4 w-14 shrink-0 text-primary">
              <SoundWave option={current} playing={playingId === current?.id} />
            </span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        {open && (
          <SoundPickerContent
            value={value}
            onChange={onChange}
            onClose={() => setOpen(false)}
            onAdopt={(option) => setAdopting([option])}
          />
        )}
      </Popover>
      <CustomSoundDialog
        open={adopting !== null}
        fromAsset={
          adoptingOption
            ? { assetId: adoptingOption.assetId!, name: adoptingOption.name }
            : null
        }
        onOpenChange={(o) => {
          if (!o) setAdopting(null);
        }}
        onSaved={(ref) => {
          onChange(
            { custom: ref, volume: doc.soundPreviewVolume },
            "Change sound",
          );
          setAdopting(null);
        }}
      />
      <button
        type="button"
        aria-label="Audition sound"
        disabled={!current}
        onClick={() => current && play(current)}
        className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 [&_svg]:size-3"
      >
        <Play />
      </button>
    </div>
  );
}
