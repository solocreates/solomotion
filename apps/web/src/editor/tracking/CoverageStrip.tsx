"use client";

import * as React from "react";
import { clipLocalTimeAtSource, trackStrip, type MotionDocument, type Clip, type Tracker } from "@solomotion/core";
import { cn } from "@/lib/utils";
import { useTrackRun } from "./track-runs";

/**
 * WHAT A TRACK KNOWS, DRAWN ALONG A CLIP — one component for the Track panel's
 * rows and the timeline's clip bars, over core's `trackStrip` (which reads
 * through the clip's time map, so a retimed or split clip shows its own frames).
 *
 *   solved   the tracker's colour     weak   amber — where to look
 *   none     a faint groove           anchor a bright tick — a frame you fixed
 *
 * While a run is going, its latest frame is a moving head on the strip.
 */
export const CoverageStrip = React.memo(function CoverageStrip({
  doc,
  tracker,
  clip,
  cells = 96,
  className,
}: {
  doc: MotionDocument;
  tracker: Tracker;
  clip: Clip;
  /** How finely to sample the bar — about one cell per 3 px is plenty. */
  cells?: number;
  className?: string;
}) {
  // Keyed on the tracker and clip OBJECTS: an edit elsewhere in the document
  // leaves both identical, so the strip is not recomputed per keystroke.
  const runs = React.useMemo(() => trackStrip(doc, tracker, clip, cells), [tracker, clip, cells]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = useTrackRun(tracker.id);
  const head = run?.live ? headFraction(doc, clip, run.live.timeMs) : null;
  return (
    <svg aria-hidden className={cn("block h-1 w-full overflow-visible", className)} viewBox="0 0 1000 4" preserveAspectRatio="none">
      <rect x="0" y="0" width="1000" height="4" rx="2" fill="currentColor" opacity={0.1} />
      {runs.map((r, i) =>
        r.state === "none" ? null : r.state === "anchor" ? (
          <rect key={i} x={r.from * 1000} y="-1" width={Math.max(3, (r.to - r.from) * 1000)} height="6" fill="var(--foreground)" />
        ) : (
          <rect key={i} x={r.from * 1000} y="0" width={(r.to - r.from) * 1000 + 0.5} height="4" fill={r.state === "weak" ? "#FBBF24" : tracker.color} opacity={0.9} />
        ),
      )}
      {head !== null && <rect x={head * 1000 - 2} y="-1.5" width="4" height="7" rx="1" fill="var(--foreground)" className="animate-pulse" />}
    </svg>
  );
});

/** Where a source time sits along the clip, 0..1 — core's inverse time map. */
const headFraction = (doc: MotionDocument, clip: Clip, sourceMs: number): number =>
  clip.durationMs > 0 ? clipLocalTimeAtSource(doc, clip, sourceMs) / clip.durationMs : 0;
