"use client";

import { formatBytes } from "@/lib/format-bytes";
import * as React from "react";
import { Loader2, Play, RotateCcw, Trash2 } from "lucide-react";
import { compFps } from "@solomotion/core";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CACHE_SETTINGS,
  cacheProducers,
  purgeAllCaches,
  resetCacheSettings,
  setCacheSettings,
  type CacheSettings,
  type PlaybackCacheMode,
} from "./cache-status";
import { CACHE_BUDGET_CHOICES, cacheBudgetMb, onCacheBudgetChange, setCacheBudgetMb } from "./memory-budget";
import { useCacheSettings, useCacheStatusVersion } from "./use-cache-status";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cancelPrerender, isPrerendering, prerenderRange } from "../preview/prerender";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { effectiveWorkRange } from "../timeline/work-range";
import { timelineEndMs } from "../timeline/timeline-utils";

/**
 * THE CACHE — one panel, wherever it is opened from.
 *
 * The stage's preview popover shows it as its Cache tab; right-clicking the
 * timeline's cache icon opens it in place. Same component, same state, because
 * two copies of a settings surface are two answers to "is caching on" — which
 * is exactly the bug the old pair had (the stage flipped a switch the timeline
 * icon did not know about).
 *
 * Every row is read off the orchestra (`cache-status.ts`): the switch, the one
 * memory ceiling, and a usage line per producer in stack order, bottom up — so
 * a cache added tomorrow appears here by registering, not by editing this file.
 */


/** One switch row with its explanation in a tooltip, never a paragraph. */
/** Render-time thresholds for keeping a layer per instant. */
const LAYER_MIN_MS_CHOICES = [1, 2, 4, 8, 16, 33] as const;

function SettingRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-1 transition-colors hover:bg-accent/50">
          <span className="flex-1 text-xs">{label}</span>
          <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
        </label>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-56">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

/** What one cache holds against its allowance — shown under the control it belongs to. */
function Usage({ row }: { row: { label: string; bytes: number; budget: number } | undefined }) {
  if (!row || (row.budget <= 0 && row.bytes <= 0)) return null;
  const full = row.budget > 0 && row.bytes >= row.budget * 0.97;
  return (
    <div className="px-1 pb-1.5">
      <div className="flex items-center gap-2 text-2xs">
        <span className="flex-1 text-muted-foreground">{row.label}</span>
        <span className="font-mono tabular-nums text-foreground/80">
          {formatBytes(row.bytes)}
          <span className="text-muted-foreground"> / {formatBytes(row.budget)}</span>
        </span>
      </div>
      {/* The allowance, visibly. A cache that stops keeping at its ceiling
          looks broken unless the ceiling is on screen. */}
      <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", full ? "bg-warning" : "bg-success/80")}
          style={{ width: `${Math.min(100, (row.bytes / Math.max(1, row.budget)) * 100)}%` }}
        />
      </div>
    </div>
  );
}

const MODE_HINT: Record<PlaybackCacheMode, string> = {
  layers: "Keeps each slow layer or group; editing one rebuilds only that one",
  frames: "Keeps finished frames, nested comps' too; the fastest replay",
};

export function CachePanel() {
  const settings = useCacheSettings();
  const set = (patch: Partial<CacheSettings>) => setCacheSettings(patch);
  const version = useCacheStatusVersion();
  const budgetMb = React.useSyncExternalStore(onCacheBudgetChange, cacheBudgetMb, () => 0);
  // Only the caches that are ON — a switched-off cache has no allowance.
  const rows = React.useMemo(
    () => new Map(cacheProducers().map((p) => [p.id, { label: p.label, ...p.stats() }])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, budgetMb, settings],
  );
  const playbackRow = rows.get(settings.mode === "frames" ? "comp" : "layer");
  // Under Frames the layer cache still holds the parked editing buffers.
  const editingRow = settings.mode === "frames" ? rows.get("layer") : undefined;
  const held = [...rows.values()].reduce((n, r) => n + r.bytes, 0);
  const isDefault = JSON.stringify(settings) === JSON.stringify(DEFAULT_CACHE_SETTINGS);

  return (
    // Scrolls rather than overflowing — the popover sits under a toolbar and
    // above a timeline, and a short window must still reach Reset.
    <div className="-mx-1 max-h-[min(32rem,70vh)] space-y-0.5 overflow-y-auto px-1">
      <label className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-1 transition-colors hover:bg-accent/50">
        <span className="flex-1 text-xs">Cache</span>
        <Switch checked={settings.enabled} onCheckedChange={(on) => set({ enabled: on })} aria-label="Cache" />
      </label>

      <div className={cn("space-y-0.5 transition-opacity", !settings.enabled && "pointer-events-none opacity-40")}>
        {/* ONE playback cache — layers or frames, never both copies. */}
        <div className="flex h-7 items-center gap-2 px-1">
          <span className="flex-1 text-xs">Keep</span>
          <div className="track flex bg-muted" role="radiogroup" aria-label="Keep">
            {(["layers", "frames"] as const).map((mode) => (
              <Tooltip key={mode}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={settings.mode === mode}
                    onClick={() => set({ mode })}
                    className={cn(
                      "h-5 rounded px-2 text-2xs capitalize transition-colors",
                      settings.mode === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {mode}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-56">
                  {MODE_HINT[mode]}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
        {settings.mode === "layers" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex h-7 items-center gap-2 px-1">
                <span className="flex-1 text-xs">Keep layers slower than</span>
                <Select value={String(settings.layerMinMs)} onValueChange={(v) => set({ layerMinMs: Number(v) })}>
                  <SelectTrigger className="h-6 w-24 px-2 text-xs tabular-nums" aria-label="Keep layers slower than">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LAYER_MIN_MS_CHOICES.map((ms) => (
                      <SelectItem key={ms} value={String(ms)} className="text-xs tabular-nums">
                        {ms} ms
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-56">
              Faster layers are drawn each frame instead of kept. Still layers are always kept once.
            </TooltipContent>
          </Tooltip>
        )}
        <Usage row={playbackRow} />
        <Usage row={editingRow} />
        <SettingRow
          label="Real-time playback"
          hint={
            settings.realtime
              ? "Plays at speed; footage runs live and may skip frames"
              : "Shows every frame exactly, footage included, and keeps them all"
          }
          checked={settings.realtime}
          onChange={(on) => set({ realtime: on })}
        />
        <SettingRow
          label="Rolling cache"
          hint={
            settings.rolling
              ? "When full, lets go of what's furthest behind the playhead"
              : "When full, keeps what it has and stops adding"
          }
          checked={settings.rolling}
          onChange={(on) => set({ rolling: on })}
        />

        <div className="pt-1">
          <Usage row={rows.get("posters")} />
        </div>

        <div className="flex h-7 items-center gap-2 px-1">
          <span className="flex-1 text-xs">Memory</span>
          <Select value={String(budgetMb)} onValueChange={(v) => setCacheBudgetMb(Number(v))}>
            <SelectTrigger className="h-6 w-24 px-2 text-xs tabular-nums" aria-label="Cache memory">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CACHE_BUDGET_CHOICES.map((mb) => (
                <SelectItem key={mb} value={String(mb)} className="text-xs tabular-nums">
                  {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <CacheRangeButton />
        <button
          type="button"
          onClick={purgeAllCaches}
          disabled={held === 0}
          className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
        >
          <Trash2 className="size-3.5 shrink-0" />
          <span className="flex-1 text-left">Purge</span>
        </button>
      </div>
      {/* Its own thing: decoded video, kept whether or not rendered work is,
          and left alone by Purge. */}
      <div className="border-t pt-1">
        <SettingRow
          label="Decoded footage"
          hint="Keeps decoded video frames for filmstrips and scrubbing, even with the cache off"
          checked={settings.media}
          onChange={(on) => set({ media: on })}
        />
        {settings.media && <Usage row={rows.get("media")} />}
      </div>
      {!isDefault && (
        <button
          type="button"
          onClick={resetCacheSettings}
          className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <RotateCcw className="size-3.5 shrink-0" />
          <span className="flex-1 text-left">Reset to defaults</span>
        </button>
      )}
    </div>
  );
}

/** Build the work range into the cache — the range if one is set, else the comp. */
function CacheRangeButton() {
  const doc = useDoc();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const progress = useSession((s) => s.prerenderProgress);
  const building = progress !== null;

  const run = () => {
    if (building || isPrerendering()) {
      cancelPrerender();
      return;
    }
    const frame = doc.frames.find((f) => f.id === activeFrameId) ?? doc.frames[0];
    if (!frame) return;
    const range = effectiveWorkRange(frame.id);
    void prerenderRange({
      compId: frame.id,
      fromMs: range ? range.startMs : 0,
      toMs: range ? range.endMs : timelineEndMs(doc, frame.id),
      fps: compFps(doc, frame.id),
    });
  };

  return (
    <button
      type="button"
      onClick={run}
      className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {building ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <Play className="size-3.5 shrink-0" />}
      <span className="flex-1 text-left">{building ? "Stop" : "Cache work range"}</span>
      {building && <span className="font-mono text-2xs tabular-nums">{Math.round((progress ?? 0) * 100)}%</span>}
    </button>
  );
}
