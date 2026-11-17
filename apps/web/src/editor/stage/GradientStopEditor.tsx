"use client";

import * as React from "react";
import { isGradientPaint, locateClip, paintWithSampled, sampleKeyframes, type Paint } from "@solomotion/core";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { clipLocalClamped, commitProperty } from "../inspector/animatable";
import { DocPicker } from "../inspector/PaintPopover";
import { useDocSelector, useDocStore } from "../state/document-context";
import { useSession, useStageCamera, useParkedPlayhead, useTransportRunning } from "../state/session";
import { paintNormToWorld } from "./gradient-handles";
import { stageHitRects } from "./stage-geometry";

/**
 * The on-canvas color editor that pops up "right there" at a gradient stop when
 * you click its knob (Figma). It reuses the app's `Popover` — which PORTALS to
 * document.body — so it escapes the stage's `overflow-hidden` and always sits
 * above the timeline/panels (the root "popover trapped under the stage" bug),
 * anchored to the stop's live screen position as the view pans/zooms.
 *
 * It resolves the active gradient the same way the Stage overlay does (active
 * paint → base paint → sampled geometry over the clip's hit rect).
 */
export function GradientStopEditor() {
  // The handle sits on the clip's hit rect, which the stage's draw loop writes
  // imperatively every frame (`stageHitRects`), outside React. Memoising this
  // component would pin the handle where the layer was, so it stays plain.
  "use no memo";
  const ref = useSession((s) => s.activePaint);
  const stopId = useSession((s) => s.activeGradientStopId);
  const playhead = useParkedPlayhead();
  // An editing overlay is for a still frame: the canvas draws the motion.
  const running = useTransportRunning();
  const view = useStageCamera();
  const store = useDocStore();
  const setStop = useSession((s) => s.setActiveGradientStop);
  const paintClipId = ref?.clipId;
  const clip = useDocSelector((d) => (paintClipId ? locateClip(d, paintClipId)?.clip : undefined));

  if (running || !ref || !stopId) return null;
  if (!clip || clip.kind === "audio") return null;

  const prefix = `${ref.target}.${ref.id}`;
  const base: Paint | undefined =
    ref.target === "fill" ? clip.fills.find((f) => f.id === ref.id) : clip.strokes.find((s) => s.id === ref.id)?.paint;
  if (!base || !isGradientPaint(base)) return null;

  const sampled = sampleKeyframes(clip.keyframes, clipLocalClamped(clip, playhead));
  const eff = paintWithSampled(base, prefix, sampled);
  if (!isGradientPaint(eff)) return null;
  const stop = eff.stops.find((s) => s.id === stopId);
  const hit = stageHitRects.current.find((h) => h.clipId === ref.clipId);
  if (!stop || !hit) return null;

  const start = paintNormToWorld(eff.start.x, eff.start.y, hit);
  const end = paintNormToWorld(eff.end.x, eff.end.y, hit);
  const world = {
    x: start.x + (end.x - start.x) * stop.offset,
    y: start.y + (end.y - start.y) * stop.offset,
  };
  const sx = view.tx + world.x * view.scale;
  const sy = view.ty + world.y * view.scale;

  const commit = (color: string) =>
    store.update(
      "Stop color",
      (d) => {
        const l = locateClip(d, ref.clipId);
        if (l) commitProperty(l.clip, `${prefix}.stop.${stop.id}.color`, color, playhead);
      },
      { mergeKey: `grad-stopc-${stop.id}` },
    );

  return (
    <Popover open onOpenChange={(o) => !o && setStop(null)}>
      {/* A zero-size anchor pinned to the knob; the content portals to body. */}
      <PopoverAnchor asChild>
        <div className="pointer-events-none absolute size-0" style={{ left: sx, top: sy }} />
      </PopoverAnchor>
      <PopoverContent
        align="center"
        side="bottom"
        sideOffset={12}
        className="w-60 p-2.5"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DocPicker value={stop.color} onChange={commit} />
      </PopoverContent>
    </Popover>
  );
}
