"use client";

import {
  locateClip,
  mergeCoincidentKeyframes,
  moveKeyframe,
  type Clip,
  type DocumentStore,
} from "@solomotion/core";
import { useSession } from "../state/session";
import { pxToTime, timeToPx } from "./timeline-utils";
import { createKeyframeSnapper } from "./keyframe-snap";
import { capturePointer } from "../input/capture-pointer";

/**
 * The animation "clip" transform — the headless brain behind the draggable
 * bar that sits over a layer's keyframes in both the dope sheet and the curve
 * panel. Grab its body to SLIDE the whole animation in time; grab an edge to
 * SCALE it (stretch = slower, squash = faster) about the opposite edge, every
 * key repositioned proportionally. It reuses the keyframe snapper (same
 * magnets as any clip), so the moving edge sticks to clip edges, the playhead,
 * markers and other keys.
 *
 * Group vs single is driven by the keyframe selection, matching every other
 * surface: with a selection, one gesture transforms the SELECTED keys across
 * every clip that owns some, about their shared span — exactly like trimming
 * several timeline clips together. With no selection, the bar you grabbed
 * transforms only that clip's whole animation.
 */

export type AnimTransformMode = "move" | "scale-start" | "scale-end";

interface ClipKeySet {
  clipId: string;
  keyIds: string[];
}

interface AnimTransform {
  parts: ClipKeySet[];
  spanStartAbs: number;
  spanEndAbs: number;
}

/** Absolute time span (ms) of a clip's animation, honouring the selection. */
export function clipAnimSpan(
  clip: Clip,
  selected: ReadonlySet<string>,
): { startMs: number; endMs: number } | null {
  const useSel = selected.size > 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const tr of clip.keyframes) {
    for (const k of tr.keys) {
      if (useSel && !selected.has(k.id)) continue;
      const abs = clip.startMs + k.timeMs;
      if (abs < lo) lo = abs;
      if (abs > hi) hi = abs;
    }
  }
  return Number.isFinite(lo) ? { startMs: lo, endMs: hi } : null;
}

/** Resolve which keys a gesture on `grabbedClipId`'s bar transforms, + the span. */
function resolveTransform(clips: Clip[], grabbedClipId: string): AnimTransform | null {
  const selected = new Set(useSession.getState().selectedKeyframeIds);
  const useSel = selected.size > 0;
  const parts: ClipKeySet[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const clip of clips) {
    if (!useSel && clip.id !== grabbedClipId) continue; // single: only the grabbed clip
    const keyIds: string[] = [];
    for (const tr of clip.keyframes) {
      for (const k of tr.keys) {
        if (useSel && !selected.has(k.id)) continue;
        keyIds.push(k.id);
        const abs = clip.startMs + k.timeMs;
        if (abs < lo) lo = abs;
        if (abs > hi) hi = abs;
      }
    }
    if (keyIds.length) parts.push({ clipId: clip.id, keyIds });
  }
  if (parts.length === 0 || !Number.isFinite(lo)) return null;
  return { parts, spanStartAbs: lo, spanEndAbs: hi };
}

/** Absolute-ms → px in the shared timeline scale (identical to both surfaces). */
export function animAbsToPx(absMs: number, pxPerSec: number): number {
  return timeToPx(absMs, pxPerSec);
}

const MIN_SCALE = 0.02;

export function beginKeyframeTransform(opts: {
  e: React.PointerEvent;
  store: DocumentStore;
  pxPerSec: number;
  clips: Clip[];
  grabbedClipId: string;
  mode: AnimTransformMode;
}): void {
  const { e, store, pxPerSec, clips, grabbedClipId, mode } = opts;
  if (e.button !== 0) return;
  e.stopPropagation();
  capturePointer((e.currentTarget as Element), e.pointerId);

  const resolved = resolveTransform(clips, grabbedClipId);
  if (!resolved) return;
  const { parts, spanStartAbs, spanEndAbs } = resolved;
  const span = spanEndAbs - spanStartAbs;
  if ((mode === "scale-start" || mode === "scale-end") && span <= 0) return;

  const clipStartOf = (id: string) => clips.find((c) => c.id === id)?.startMs ?? 0;

  // Freeze origins (relative times) — the doc mutates under us as we drag.
  const origins = new Map<string, { clipId: string; t: number }>();
  const d0 = store.getState();
  for (const p of parts) {
    const loc = locateClip(d0, p.clipId);
    if (!loc) continue;
    const ids = new Set(p.keyIds);
    for (const tr of loc.clip.keyframes) {
      for (const k of tr.keys) if (ids.has(k.id)) origins.set(k.id, { clipId: p.clipId, t: k.timeMs });
    }
  }
  if (origins.size === 0) return;

  const anchorAbs = mode === "scale-start" ? spanStartAbs : spanEndAbs;
  const selfAbs = [...origins.values()].map((o) => clipStartOf(o.clipId) + o.t);
  const snapper = createKeyframeSnapper(store, pxPerSec, selfAbs);
  const startX = e.clientX;
  const mergeKey = `kf-anim-${mode}-${e.pointerId}`;
  const label = mode === "move" ? "Move animation" : "Scale animation";
  let moved = false;

  const apply = (rawDelta: number, bypass: boolean) => {
    const anchor = mode === "move" ? spanStartAbs : anchorAbs;
    const dAbs = snapper.snapDelta(anchor, rawDelta, bypass);
    store.update(
      label,
      (d) => {
        for (const [id, o] of origins) {
          const loc = locateClip(d, o.clipId);
          if (!loc) continue;
          const absOrig = clipStartOf(o.clipId) + o.t;
          let newAbs: number;
          if (mode === "move") {
            newAbs = absOrig + dAbs;
          } else if (mode === "scale-end") {
            const factor = Math.max(MIN_SCALE, (span + dAbs) / span);
            newAbs = spanStartAbs + (absOrig - spanStartAbs) * factor;
          } else {
            const factor = Math.max(MIN_SCALE, (span - dAbs) / span);
            newAbs = spanEndAbs + (absOrig - spanEndAbs) * factor;
          }
          // NOT clamped to the clip's window. A key's time is the key's own
          // (see `keyframeSchema.timeMs`), and clamping it here reintroduced
          // exactly the collapse a head trim used to cause: every key outside
          // the window — including ones a trim legitimately put there — piled
          // onto the edge the moment you dragged any part of the selection.
          // merge:false — keys crossing each other coalesce once on drop.
          moveKeyframe(loc.clip.keyframes, id, newAbs - clipStartOf(o.clipId), { merge: false });
        }
      },
      { mergeKey },
    );
  };

  const onMove = (ev: PointerEvent) => {
    if (!moved && Math.abs(ev.clientX - startX) < 3) return;
    moved = true;
    apply(pxToTime(ev.clientX - startX, pxPerSec), ev.metaKey || ev.ctrlKey);
  };
  const onUp = () => {
    snapper.end();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (!moved) return;
    // Collapse coincident keys per clip, in the same undo step.
    const byClip = new Map<string, Set<string>>();
    for (const [id, o] of origins) {
      let s = byClip.get(o.clipId);
      if (!s) byClip.set(o.clipId, (s = new Set()));
      s.add(id);
    }
    store.update(
      label,
      (d) => {
        for (const [clipId, ids] of byClip) {
          const loc = locateClip(d, clipId);
          if (loc) mergeCoincidentKeyframes(loc.clip.keyframes, ids);
        }
      },
      { mergeKey },
    );
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
