"use client";

import * as React from "react";
import {
  MIN_CUE_MS,
  buildCues,
  cueTextOf,
  cuesMisfitClip,
  cuesOverflowClip,
  distributeCues,
  dragCueEdge,
  fitCuesToClip,
  locateClip,
  mergeCueWithNext,
  normalizeCues,
  slipCue,
  snapTime,
  splitCue,
  type CaptionCue,
  type CaptionTextClip,
} from "@solomotion/core";
import { ChevronsRight, Merge, Scissors, Redo2, MoveHorizontal } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { beginScrubDrag } from "./scrub";
import { collectSnapCandidates, pxToTime, timeToPx } from "./timeline-utils";
import { useClipChrome } from "./clip-chrome";

/**
 * THE CUE RIBBON — a caption's cues as what they actually are: segments.
 *
 * They used to be hairline TICKS, one per cue start, and the shape was the bug.
 * A tick is a boundary, so only boundaries could be edited: the first cue's
 * start and the last cue's end had no mark at all and were therefore
 * unreachable, and a caption seeded on a short clip that was later trimmed out
 * stayed stranded in the head of its own layer with no gesture able to free it.
 * You also could not see what you were editing — four hairlines say nothing
 * about which words are on screen when.
 *
 * A segment shows both facts at once (when a cue starts AND how long it holds),
 * gives every edge a handle by construction, and makes the third gesture
 * obvious: drag the BODY to slip a cue without changing its length. It is the
 * same object a clip is, one level down, which is the point — the timeline
 * already teaches trim-the-edge / drag-the-middle, and this inherits it.
 *
 * The push semantics are core's (`dragCueEdge`), shared with the cue list's
 * number fields, so the panel and the ribbon cannot disagree about what an edge
 * may do. Everything here is DRAWING and GESTURE; no timing rule lives in this
 * file.
 *
 * Inert until the clip is selected — it sits inside `ClipChromeLayer` and
 * inherits that, which is what stopped it eating the press that moves the clip.
 */

/** Ribbon height per detail tier — see `clipDetail`. */
const BAND_H = { micro: 3, compact: 6, full: 13 } as const;
/** Below this a bar has no room for a word, so it doesn't pretend to. */
const LABEL_MIN_PX = 26;

export function CueRibbon({ clip, pxPerSec }: { clip: CaptionTextClip; pxPerSec: number }) {
  const store = useDocStore();
  const { active, detail } = useClipChrome();
  const cues = clip.caption.cues;

  // The cue under the playhead, as a clip-local question — the ribbon's one
  // live reading, and the same `activeCueIndexAt` rule the renderer uses is not
  // needed here: an id comparison keeps this to a string per frame.
  const activeId = useSession((s) => {
    const local = s.playheadMs - clip.startMs;
    for (let i = cues.length - 1; i >= 0; i--) {
      const c = cues[i]!;
      if (local >= c.startMs && local < c.endMs) return c.id;
    }
    return "";
  });

  if (cues.length === 0) return null;
  const height = BAND_H[detail];

  const write = (label: string, fn: (cues: CaptionCue[]) => CaptionCue[] | void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        const c = locateClip(d, clip.id)?.clip;
        if (c?.kind !== "text" || !c.caption) return;
        const result = fn(c.caption.cues);
        c.caption.cues = normalizeCues(result ?? c.caption.cues, Infinity, c.durationMs);
      },
      mergeKey ? { mergeKey } : undefined,
    );

  /**
   * One gesture for all three edits. `apply` is the only thing that differs
   * between trimming an edge and slipping a body, so it is the only thing
   * passed in — the snapping, the merge key, the lifecycle and the
   * pointercancel safety are shared and written once.
   */
  const startDrag = (
    e: React.PointerEvent,
    cue: CaptionCue,
    what: "start" | "end" | "body",
  ) => {
    if (!active || e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX;
    const origin = what === "end" ? cue.endMs : cue.startMs;
    const mergeKey = `cue-${what}-${cue.id}-${e.pointerId}`;
    const session = useSession.getState();
    // Cue edges snap to the same candidates clip edges do — the playhead above
    // all, which is how a caption gets synced to a beat you can hear.
    const candidates = collectSnapCandidates(
      store.getState(),
      clip.frameId,
      new Set([clip.id]),
      session.playheadMs,
      session.snapSettings,
    );
    const threshold = pxToTime(session.snapSettings.thresholdPx, pxPerSec);

    beginScrubDrag(
      e,
      (clientX) => {
        const raw = origin + pxToTime(clientX - startX, pxPerSec);
        let local = raw;
        let snapped: number | null = null;
        if (useSession.getState().snapping) {
          const abs = snapTime(clip.startMs + raw, candidates, threshold);
          if (Math.abs(abs - (clip.startMs + raw)) > 0.001) {
            local = abs - clip.startMs;
            snapped = abs;
          }
        }
        useSession.getState().setSnapIndicator(snapped);
        write(
          what === "body" ? "Move cue" : "Cue timing",
          (cs, ) => {
            if (what === "body") slipCue(cs, cue.id, local, clip.durationMs);
            else dragCueEdge(cs, cue.id, what, local, clip.durationMs);
          },
          mergeKey,
        );
      },
      () => useSession.getState().setSnapIndicator(null),
    );
  };

  const misfit = cuesMisfitClip(cues, clip.durationMs);
  const overflows = cuesOverflowClip(cues, clip.durationMs);

  return (
    /*
     * CLIPPED TO THE CLIP'S OWN BOX. A cue can legitimately end past the clip's
     * end — trimming a caption IN does not re-time its words, because clamping
     * them would destroy timing that trimming back out could never restore — so
     * the model is allowed to hold cues the clip cannot reach, and the VIEW is
     * where that gets resolved. Without this the ribbon painted straight out of
     * the clip's rounded box and across the lane, which read as a rendering
     * bug rather than as the honest "there is more here than fits" it is.
     * `cuesOverflowClip` puts a mark at the edge to say so.
     */
    <div className="absolute inset-x-0 top-0 overflow-hidden rounded-t-md" style={{ height }}>
      {cues.map((cue, i) => {
        const left = timeToPx(cue.startMs, pxPerSec);
        const width = Math.max(1, timeToPx(cue.endMs - cue.startMs, pxPerSec));
        const isActive = cue.id === activeId;
        const label = cueTextOf(clip.text, cue);
        return (
          <ContextMenu key={cue.id}>
            <ContextMenuTrigger asChild>
              <div
                className={cn(
                  "group/cue absolute top-0 overflow-hidden rounded-[3px] transition-colors",
                  active ? "cursor-slip" : "cursor-default",
                  isActive
                    ? "bg-primary/85"
                    : "bg-(--clip-caption-border)/45 group-hover/clip:bg-(--clip-caption-border)/70",
                  active && !isActive && "hover:bg-(--clip-caption-border)/90",
                )}
                style={{ left, width, height }}
                title={
                  detail === "full"
                    ? undefined
                    : `“${label}” · ${(cue.startMs / 1000).toFixed(2)}–${(cue.endMs / 1000).toFixed(2)}s`
                }
                onPointerDown={(e) => startDrag(e, cue, "body")}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  const s = useSession.getState();
                  s.setPlaying(false);
                  s.setPlayhead(clip.startMs + cue.startMs + 1);
                }}
              >
                {detail === "full" && width >= LABEL_MIN_PX && (
                  <span
                    className={cn(
                      "pointer-events-none absolute inset-0 flex items-center justify-center truncate px-1 text-[8px] font-medium leading-none",
                      isActive ? "text-primary-foreground" : "text-foreground/70",
                    )}
                  >
                    {label}
                  </span>
                )}
              </div>
            </ContextMenuTrigger>
            <CueMenu
              clip={clip}
              cue={cue}
              index={i}
              last={i === cues.length - 1}
              write={write}
            />
          </ContextMenu>
        );
      })}

      {/* The GRIPS, above the bars so a boundary shared by two cues resolves to
          one target. A finger-sized zone with a 1px mark inside it — the rule
          the trim handles on the clip itself already follow. */}
      {active &&
        detail !== "micro" &&
        cues.map((cue) => (
          <React.Fragment key={`g-${cue.id}`}>
            <CueGrip
              at={cue.startMs}
              pxPerSec={pxPerSec}
              height={height}
              onPointerDown={(e) => startDrag(e, cue, "start")}
              title={`“${cueTextOf(clip.text, cue)}” starts at ${((clip.startMs + cue.startMs) / 1000).toFixed(2)}s`}
            />
            <CueGrip
              at={cue.endMs}
              pxPerSec={pxPerSec}
              height={height}
              onPointerDown={(e) => startDrag(e, cue, "end")}
              title={`“${cueTextOf(clip.text, cue)}” ends at ${((clip.startMs + cue.endMs) / 1000).toFixed(2)}s`}
            />
          </React.Fragment>
        ))}

      {/*
       * THE STRANDED CAPTION, and its one-click way out.
       *
       * Trimming a clip out deliberately does not re-time its words, so a
       * caption seeded over two seconds and later stretched to twelve ends up
       * in the first sixth of its own layer. The fix existed (`fitCuesToClip`)
       * but lived in a panel; the problem is visible HERE, so the offer is too,
       * sitting exactly in the empty stretch it is about.
       */}
      {/* The cues run past the clip's end: they exist and can never be spoken.
          A hard mark at the edge, so this reads as a fact about the caption
          rather than as the ribbon having been drawn wrong. */}
      {overflows && detail !== "micro" && (
        <div
          title="Some cues run past the end of this clip and will never be spoken — fit them back in"
          className="pointer-events-none absolute right-0 top-0 flex items-center bg-gradient-to-l from-background/80 to-transparent pl-2 pr-0.5"
          style={{ height }}
        >
          <ChevronsRight className="size-2.5 text-[#FBBF24]" />
        </div>
      )}

      {/* Anchored to the clip's RIGHT EDGE, not to where the cues happen to
          stop. It is the clip that is being filled, the tail is where the
          problem is visible in the under-filled case, and in the over-filled
          case the cues' own end is off-screen entirely. */}
      {active && detail === "full" && misfit && (
        <button
          type="button"
          title="Fit the cues to this clip, keeping their rhythm"
          className="absolute right-0 top-0 z-20 flex items-center gap-1 rounded-[3px] border border-dashed border-primary/50 bg-background/80 px-1.5 text-[8px] font-medium text-primary/90 transition-colors hover:bg-primary/20"
          style={{ height }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            write("Fit cues to clip", (cs) => fitCuesToClip(cs, clip.durationMs));
          }}
        >
          <MoveHorizontal className="size-2" /> fit
        </button>
      )}
    </div>
  );
}

function CueGrip({
  at,
  pxPerSec,
  height,
  title,
  onPointerDown,
}: {
  at: number;
  pxPerSec: number;
  height: number;
  title: string;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      title={title}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => e.stopPropagation()}
      className="group/grip absolute top-0 z-10 w-(--hit-grip) -translate-x-1/2 cursor-ew-resize touch-none"
      style={{ left: timeToPx(at, pxPerSec), height }}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-background/70 transition-colors group-hover/grip:w-0.5 group-hover/grip:bg-primary" />
    </div>
  );
}

/** The cue's own verbs — the same set the cue list offers, where the cue is. */
function CueMenu({
  clip,
  cue,
  index,
  last,
  write,
}: {
  clip: CaptionTextClip;
  cue: CaptionCue;
  index: number;
  last: boolean;
  write: (label: string, fn: (cues: CaptionCue[]) => CaptionCue[] | void) => void;
}) {
  return (
    <ContextMenuContent className="w-52">
      <ContextMenuItem
        disabled={cue.end - cue.start < 2}
        onClick={() => write("Split cue", (cs) => splitCue(cs, index, Math.floor((cue.start + cue.end) / 2)))}
      >
        <Scissors /> Split cue
      </ContextMenuItem>
      <ContextMenuItem disabled={last} onClick={() => write("Merge cues", (cs) => mergeCueWithNext(cs, index))}>
        <Merge /> Merge with next
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => write("Fit cues to clip", (cs) => fitCuesToClip(cs, clip.durationMs))}>
        <MoveHorizontal /> Fit cues to clip
      </ContextMenuItem>
      <ContextMenuItem onClick={() => write("Even cues", (cs) => distributeCues(cs, clip.durationMs))}>
        <Redo2 /> Spread evenly
      </ContextMenuItem>
      <ContextMenuItem onClick={() => write("Re-cut by word", () => buildCues(clip.text, clip.durationMs, "word"))}>
        <Scissors /> Re-cut by word
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

export { MIN_CUE_MS };
