import type { KeyframeValue, StrokeStyle } from "@solomotion/core";
import type { PaintableClip } from "./PaintPopover";
import type { PaintHost } from "./paint-host";

/**
 * A headless handle onto anything that OWNS a stroke stack.
 *
 * A layer owns one. A vector brush owns one. They are the same list of the same
 * objects, so the editors that read it take this and never a clip — which is
 * the whole reason the Brush Studio and the inspector can render the identical
 * panel over two completely different stores.
 *
 * `keyframeClip` is the ONLY difference between them, and it is present or it
 * is not: a clip's stroke keyframes, binds and modulates; a brush's line is a
 * design that has no timeline to move along. Every surface reads that one field
 * rather than carrying a `canKey` flag someone has to remember to pass.
 *
 * This is deliberately a narrower view than `PaintHost` (which also carries
 * fills). A brush has no fills, and widening the interface to give it an empty
 * array would have been the modelling lie that eventually grows a branch.
 */
export interface StrokeCarrierDraft {
  strokes: StrokeStyle[];
}

export interface StrokeHost {
  /** Stable id for dnd + window identity (clip id / brush id). */
  key: string;
  strokes: StrokeStyle[];
  /** Structural/base edit of the list (add/remove/reorder, enum fields). */
  update: (label: string, fn: (c: StrokeCarrierDraft) => void, mergeKey?: string) => void;
  /** Write a stroke property — keyframe-aware for clips, base for brushes. */
  commit: (path: string, value: KeyframeValue, label: string, mergeKey?: string) => void;
  /** Current base value of a stroke path (feeds ◆ + inline readouts). */
  read: (path: string) => KeyframeValue | undefined;
  /** Present only when the host keyframes — gates ◆, bindings and modulators. */
  keyframeClip?: PaintableClip;
}

/** A paint host (a clip or a frame) narrowed to its stroke stack. The list is
 *  the same array either way; this only drops the half a stroke editor has no
 *  business touching. */
export function strokeHostOf(host: PaintHost): StrokeHost {
  return {
    key: host.key,
    strokes: host.strokes,
    update: (label, fn, mk) => host.update(label, (c) => fn(c), mk),
    commit: host.commit,
    read: host.read,
    keyframeClip: host.keyframeClip,
  };
}
