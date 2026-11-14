"use client";

import { Gauge, RotateCcw } from "lucide-react";
import {
  PREVIEW_RESOLUTIONS,
  PREVIEW_RESOLUTION_LABEL,
  cacheBytesPerMinute,
  compFps,
  type PreviewResolution,
  type PreviewResolutionSetting,
} from "@solomotion/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CachePanel } from "../cache/CachePanel";
import { useCachingEnabled } from "../cache/use-cache-status";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { activeCompId } from "../timeline/timeline-utils";

/**
 * PREVIEW QUALITY, ON THE CANVAS — because a degraded preview that does not
 * say so is a lie you are making decisions against.
 *
 * Every serious tool puts this control on the viewer, and they all put it there
 * for the same reason: the one failure mode that matters is judging a soft
 * frame as if it were the final one. So the chip is not a neutral readout. At
 * Full it is quiet chrome like everything else in this capsule; below Full it
 * takes the accent and states the fraction, and it does that whether the
 * governor chose the tier or you did — because the picture is equally
 * untrustworthy either way and the distinction belongs in the popover, not in
 * whether you are warned.
 *
 * The control lives here rather than replacing something. There was an offer to
 * remove focus mode to make room; removing a feature to place a control is a
 * trade that is never worth taking, and `chrome-layout.ts` already docks this
 * cluster without collisions.
 */

/** A fraction reads instantly; "Quarter" has to be parsed. */
const SHORT: Record<PreviewResolution, string> = {
  full: "Full",
  half: "½",
  quarter: "¼",
  eighth: "⅛",
};

/** "1.9 GB" / "480 MB" — the cost of a minute of cache, at a glance. */
function perMinute(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

const HINT: Record<PreviewResolutionSetting, string> = {
  auto: "The sharpest resolution that plays in time and whose range fits in the cache",
  full: "Every pixel, whatever it costs",
  half: "A quarter of the pixels",
  quarter: "A sixteenth of the pixels",
  eighth: "A sixty-fourth of the pixels",
};

export function PreviewQualityControl() {
  const setting = useSession((s) => s.previewResolution);
  const hold = useSession((s) => s.holdPreviewQuality);
  // What the stage is rendering at, published by the one place that decides it.
  const live = useSession((s) => s.previewTier);
  const reduced = live !== "full";
  // WHAT EACH CHOICE COSTS TO KEEP — per minute of cache, for this comp. Only
  // while caching is on: with it off, a resolution costs nothing to keep.
  const caching = useCachingEnabled();
  const doc = useDoc();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const comp = doc.frames.find((f) => f.id === activeCompId(doc, activeFrameId));
  const costOf = (tier: PreviewResolution): string | null =>
    caching && comp ? `${perMinute(cacheBytesPerMinute(comp.width, comp.height, compFps(doc, comp.id), tier))}/min` : null;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Preview quality"
              style={{ height: "var(--control-h)" }}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-lg px-1.5 text-xs transition-colors",
                reduced
                  ? "material-glass-raised text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Gauge className="size-3.5 shrink-0" />
              <span className="tabular-nums">{SHORT[live]}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          {reduced ? `Preview at ${PREVIEW_RESOLUTION_LABEL[live].toLowerCase()} resolution` : "Preview quality"}
        </TooltipContent>
      </Tooltip>

      {/* TWO THINGS, TWO TABS. Resolution is how the preview is DRAWN; the
          cache is what it KEEPS. They share a popover because both answer "why
          does playback look and feel like this", not because they are one
          setting — and the Cache tab is the very panel the timeline's cache
          icon opens, not a copy of it. */}
      <PopoverContent side="top" align="end" sideOffset={8} className="w-64 p-0">
        <Tabs defaultValue="resolution">
          <div className="border-b p-2">
            <TabsList className="w-full">
              <TabsTrigger value="resolution" className="flex-1">
                Resolution
              </TabsTrigger>
              <TabsTrigger value="cache" className="flex-1">
                Cache
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="p-2">
            <TabsContent value="resolution" className="space-y-0.5">
              {(["auto", ...[...PREVIEW_RESOLUTIONS].reverse()] as PreviewResolutionSetting[]).map((value) => {
                const on = setting === value;
                return (
                  <Tooltip key={value}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => useSession.getState().setPreviewResolution(value)}
                        className={cn(
                          "flex h-7 w-full items-center gap-2 rounded-md px-1 text-left text-xs transition-colors",
                          on ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                        )}
                      >
                        <span className="w-5 shrink-0 text-center tabular-nums">
                          {value === "auto" ? "" : SHORT[value]}
                        </span>
                        <span className="flex-1">{value === "auto" ? "Auto" : PREVIEW_RESOLUTION_LABEL[value]}</span>
                        {on && value === "auto" && reduced && (
                          <span className="text-2xs text-primary">now {SHORT[live]}</span>
                        )}
                        {value !== "auto" && costOf(value) && (
                          <span className="font-mono text-2xs tabular-nums text-muted-foreground">{costOf(value)}</span>
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left">{HINT[value]}</TooltipContent>
                  </Tooltip>
                );
              })}
              <label className="mt-1 flex h-7 cursor-pointer items-center gap-2 rounded-md px-1 transition-colors hover:bg-accent/50">
                <span className="size-3.5 shrink-0" />
                <span className="flex-1 text-xs">Hold quality when paused</span>
                <Switch checked={hold} onCheckedChange={(v) => useSession.getState().setHoldPreviewQuality(v)} />
              </label>
              {(setting !== "auto" || hold) && (
                <button
                  type="button"
                  onClick={() => {
                    useSession.getState().setPreviewResolution("auto");
                    useSession.getState().setHoldPreviewQuality(false);
                  }}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <RotateCcw className="size-3.5 shrink-0" />
                  <span className="flex-1 text-left">Reset to Auto</span>
                </button>
              )}
            </TabsContent>
            <TabsContent value="cache">
              <CachePanel />
            </TabsContent>
          </div>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
