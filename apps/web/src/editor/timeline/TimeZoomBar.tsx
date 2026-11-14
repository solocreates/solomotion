"use client";

import * as React from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Maximize2, ZoomIn } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Range } from "@/components/ui/range";
import { Switch } from "@/components/ui/switch";
import { useSession } from "../state/session";
import type { ViewAxis } from "../workspace/view-axis";
import { useLaneZoom } from "./use-time-axes";
import { LANE_ZOOM_MAX, LANE_ZOOM_MIN } from "./time-axes";
import { clipFillClass } from "./ClipView";
import type { TimelineRow } from "./timeline-utils";

/** Device-local view preferences of the time surfaces' zoom bars. */
export const useZoomPrefs = create<{ minimap: boolean; setMinimap: (on: boolean) => void }>()(
  persist((set) => ({ minimap: false, setMinimap: (minimap) => set({ minimap }) }), { name: "tm-zoom-prefs" }),
);

/**
 * THE MAGNIFIER — the rest of a time surface's zoom, one click away instead of
 * always open: fit everything, a few spans to jump to, the second axis
 * (rows, or a curve's values) and, on the lanes, the minimap. Row height and
 * value zoom are set-and-forget, and ⌥-scroll still changes them directly.
 */
export function TimeZoomMenu({
  time,
  rows,
  values,
  minimap,
}: {
  time: ViewAxis;
  /** Offer row height (the lanes, the sheet). */
  rows?: boolean;
  /** Offer a value axis instead (the curve editor). */
  values?: { value: number; min: number; max: number; onChange: (v: number) => void };
  /** Offer the minimap switch (the lanes). */
  minimap?: boolean;
}) {
  const laneZoom = useLaneZoom();
  const mapOn = useZoomPrefs((s) => s.minimap);
  const fit = () => {
    const w = time.read();
    if (w) time.show(0, Math.min(w.maxSize, Math.max(w.minSize, w.extent)), "start");
  };
  const span = (ms: number) => {
    const w = time.read();
    if (w) time.show(Math.max(0, w.start + w.size / 2 - ms / 2), ms, "start");
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Zoom"
          title="Zoom"
          className="flex size-5 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:material-glass-raised data-[state=open]:text-primary [&_svg]:size-3.5"
        >
          <ZoomIn />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-60 p-2">
        <div className="flex flex-col gap-2">
          <div className="flex gap-1">
            <button
              type="button"
              onClick={fit}
              className="flex h-(--control-h) flex-1 items-center justify-center gap-1.5 rounded-md bg-raised text-body text-fg hover:bg-hover [&_svg]:size-3.5"
            >
              <Maximize2 /> Fit all
            </button>
            {[1000, 5000, 30000].map((ms) => (
              <button
                key={ms}
                type="button"
                onClick={() => span(ms)}
                className="h-(--control-h) rounded-md px-2 text-body tabular-nums text-fg-muted hover:bg-hover hover:text-fg"
              >
                {ms / 1000}s
              </button>
            ))}
          </div>
          {rows && (
            <Range
              label="Rows"
              value={laneZoom}
              min={LANE_ZOOM_MIN}
              max={LANE_ZOOM_MAX}
              scale="log"
              defaultValue={1}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => useSession.getState().setLaneZoom(v)}
            />
          )}
          {values && (
            <Range
              label="Values"
              value={values.value}
              min={values.min}
              max={values.max}
              scale="log"
              defaultValue={1}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={values.onChange}
            />
          )}
          {minimap && (
            <label className="flex h-(--control-h) items-center justify-between px-1 text-body text-fg">
              Minimap
              <Switch checked={mapOn} onCheckedChange={(on) => useZoomPrefs.getState().setMinimap(on)} />
            </label>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * THE LANES MINIMAP — the rows bar's background when the minimap is on: every
 * lane's clips at their real time and track, in the lanes' own fills, so the
 * shape of the whole edit is one glance and the thumb over it is "where I am".
 * Laid out in percent of the bar's extent (unzoomed px down, the span across),
 * so it re-renders on an edit, never on a scroll.
 */
export const LanesMinimap = React.memo(function LanesMinimap({
  rows,
  extent,
  laneZoom,
  spanMs,
}: {
  rows: readonly TimelineRow[];
  extent: number;
  laneZoom: number;
  spanMs: number;
}) {
  const pct = (v: number, of: number) => `${of > 0 ? (v / of) * 100 : 0}%`;
  return (
    <>
      {rows.map((r) =>
        r.kind !== "lane"
          ? null
          : r.track.clips.map((c) => (
              <div
                key={c.id}
                className={`absolute rounded-[1px] ${clipFillClass(c)}`}
                style={{
                  top: pct(r.top / laneZoom + 1, extent),
                  height: `max(1px, ${pct(Math.max(1, r.height / laneZoom - 2), extent)})`,
                  left: pct(c.startMs, spanMs),
                  width: `max(1px, ${pct(c.durationMs, spanMs)})`,
                }}
              />
            )),
      )}
    </>
  );
});
