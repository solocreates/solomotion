"use client";

import { snapTime, type DocumentStore } from "@solomotion/core";
import { useSession } from "../state/session";
import { activeCompId, collectSnapCandidates, pxToTime } from "./timeline-utils";

/**
 * The ONE keyframe-drag snapper. Every keyframe surface — the dope sheet, the
 * curve panel, the animation clip bar — snaps through this, so a keyframe
 * lands on the exact same magnets a clip on the ruler does: clip edges, the
 * playhead, markers and other keyframes, gated by the live snap-settings
 * switch, flashed with the same snap indicator. No surface re-implements
 * snapping; they all borrow `collectSnapCandidates` + `snapTime` from here.
 *
 * Freeze one at gesture start (candidates + threshold are captured once), then
 * feed it the anchor's absolute time and the raw drag delta each move; it
 * returns the delta adjusted so the anchor sticks to the nearest magnet. Pass
 * `bypass` (⌘/Ctrl held) to move freely. `selfAbsTimes` are the dragged keys'
 * own positions — removed from the candidate set so a key never snaps to where
 * it began.
 */
export interface KeyframeSnapper {
  snapDelta(anchorAbsMs: number, rawDeltaMs: number, bypass?: boolean): number;
  end(): void;
}

export function createKeyframeSnapper(
  store: DocumentStore,
  pxPerSec: number,
  selfAbsTimes: number[] = [],
): KeyframeSnapper {
  const session = useSession.getState();
  const settings = session.snapSettings;
  const doc = store.getState();
  const compId = activeCompId(doc, session.activeFrameId);
  const candidates = collectSnapCandidates(doc, compId, new Set(), session.playheadMs, settings).filter(
    (c) => !selfAbsTimes.some((s) => Math.abs(s - c) < 0.5),
  );
  const threshold = pxToTime(settings.thresholdPx, pxPerSec);
  return {
    snapDelta(anchorAbsMs, rawDeltaMs, bypass) {
      if (bypass || !useSession.getState().snapping) {
        useSession.getState().setSnapIndicator(null);
        return rawDeltaMs;
      }
      const target = anchorAbsMs + rawDeltaMs;
      const snapped = snapTime(target, candidates, threshold);
      useSession.getState().setSnapIndicator(snapped !== target ? snapped : null);
      return snapped - anchorAbsMs;
    },
    end() {
      useSession.getState().setSnapIndicator(null);
    },
  };
}
