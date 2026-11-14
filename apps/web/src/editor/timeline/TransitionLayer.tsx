"use client";

import * as React from "react";
import {
  MIN_TRANSITION_MS,
  findTransition,
  resizeTransition,
  trackEdgeDecors,
  type EdgeDecor,
  type Track,
  compFps,
} from "@solomotion/core";
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu";
import { useDocStore, useDocWhen } from "../state/document-context";
import { useSession } from "../state/session";
import { timeToPx } from "./timeline-utils";
import {
  EdgeChip,
  durationLabel,
  presetsFor,
  retargetEdgeDecor,
  setEdgeDecorDuration,
} from "./edge-decor";
import {
  alignmentOf,
  editTransition,
  splitForAlignment,
  useTransitionPrefs,
  type TransitionAlignment,
} from "./transition-actions";

/**
 * The cut transitions on one lane.
 *
 * They render at LANE level rather than inside a clip because a transition
 * straddles two of them — owning it from either side would mean drawing half a
 * chip twice and keeping the halves in sync. One absolutely-positioned layer
 * over the lane is both simpler and the only way the shared-cut interactions
 * (one drag resizing both sides) can be a single gesture.
 *
 * The chip itself is the SHARED `EdgeChip` every clip-edge decoration uses —
 * transitions just ask for the taller "raised" dialect, because they sit on top
 * of the clips rather than inside one.
 */
export function TransitionLayer({
  track,
  frameId,
  pxPerSec,
}: {
  track: Track;
  frameId: string;
  pxPerSec: number;
}) {
  // A lane with no transitions reads nothing; one with transitions reads the media they span.
  const doc = useDocWhen((d) => (track.transitions.length ? [d.assets, d.frames] : []));
  const decors = trackEdgeDecors(doc, track, frameId);
  if (!decors.length) return null;
  return (
    <>
      {decors.map((decor) => (
        <TransitionChip
          key={decor.ref.kind === "transition" ? decor.ref.id : ""}
          track={track}
          frameId={frameId}
          decor={decor}
          pxPerSec={pxPerSec}
        />
      ))}
    </>
  );
}

function TransitionChip({
  track,
  frameId,
  decor,
  pxPerSec,
}: {
  track: Track;
  /** The comp this lane is being drawn for — and whose frame grid the chip reads. */
  frameId: string;
  decor: EdgeDecor;
  pxPerSec: number;
}) {
  const store = useDocStore();
  const doc = useDocWhen((d) => [d.tracks, d.frames]);
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  const [hint, setHint] = React.useState<string | null>(null);
  const id = decor.ref.kind === "transition" ? decor.ref.id : "";
  const fps = compFps(doc, frameId);

  const startSpan = React.useRef<{ startMs: number; endMs: number } | null>(null);

  const onResize = (edge: "start" | "end", deltaMs: number, mods: { alt: boolean }) => {
    // The gesture's ANCHOR is the span it began from — reading the live span
    // each frame would compound the clamp and make the handle crawl.
    if (!startSpan.current) startSpan.current = { startMs: decor.startMs, endMs: decor.endMs };
    const from = startSpan.current;
    const timeMs = (edge === "start" ? from.startMs : from.endMs) + deltaMs;
    editTransition(
      store,
      id,
      "Transition duration",
      (_, d) => {
        resizeTransition(d, id, edge, timeMs, !mods.alt);
      },
      `transition-resize-${id}`,
    );
    const live = findTransition(store.getState(), id);
    setHint(
      `${live ? durationLabel(live.transition.durationMs, fps) : "removed"} · ${mods.alt ? "one side" : "both sides"}`,
    );
  };

  React.useEffect(() => {
    if (!hint) return;
    const done = () => {
      startSpan.current = null;
      setHint(null);
    };
    window.addEventListener("pointerup", done);
    return () => window.removeEventListener("pointerup", done);
  }, [hint]);

  const alignment = React.useMemo(() => {
    const found = findTransition(doc, id);
    return found ? alignmentOf(found.transition) : "center";
  }, [doc, id]);

  const setAlignment = (next: TransitionAlignment) =>
    editTransition(store, id, "Transition alignment", (t) => {
      t.splitMs = splitForAlignment(t.durationMs, next);
    });

  return (
    <EdgeChip
      decor={decor}
      left={timeToPx(decor.startMs, pxPerSec)}
      width={Math.max(12, timeToPx(decor.durationMs, pxPerSec))}
      fps={fps}
      emphasis="raised"
      // A LONE edge only offers its inner handle: the outer one sits exactly on
      // the clip's own start or end, where dragging it means nothing (the cut
      // IS the clip edge) and where it used to steal the clip's trim handle.
      handles={decor.side === "cut" ? ["start", "end"] : decor.side === "in" ? ["end"] : ["start"]}
      onResize={onResize}
      resizeHint={hint}
      presets={presetsFor("transition", false)}
      onRetarget={(presetId) =>
        store.update("Change transition", (d) => {
          retargetEdgeDecor(d, decor.ref, presetId);
        })
      }
      onSetDuration={(ms) =>
        store.update("Transition duration", (d) => {
          setEdgeDecorDuration(d, decor.ref, ms);
        })
      }
      store={store}
      pasteTargets={selectedClipIds}
      extraMenu={
        <>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Align to cut</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {(
                [
                  ["center", "Centred on cut"],
                  ["start", "Start at cut"],
                  ["end", "End at cut"],
                ] as const
              ).map(([value, label]) => (
                <ContextMenuItem key={value} onClick={() => setAlignment(value)}>
                  {label}
                  {alignment === value && <span className="ml-auto text-primary">•</span>}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => useTransitionPrefs.getState().setDefaultPreset(decor.presetId)}
          >
            Set as default transition
          </ContextMenuItem>
        </>
      }
    />
  );
}

export { MIN_TRANSITION_MS };
