import type { MotionDocument } from "../schema";
import { locateClip } from "../timeline/ops";
import {
  clipEdgeDecors,
  trackEdgeDecors,
  type ClipEdgeSide,
  type EdgeDecor,
  type EdgeRef,
} from "../timeline/clip-edges";
import { libraryItemId } from "./item";

/**
 * WHAT THE LIBRARY IS AIMED AT — the one answer, derived, never stored.
 *
 * The browser used to be a vending machine: it knew what you clicked and
 * nothing about what you had selected, so every click ADDED. Click three
 * animations trying them out and you had applied three, each replacing the
 * last only by accident of `retargetLayerSpec`, with no card anywhere saying
 * which one was on the layer. The panel could not answer the first question
 * anybody asks of a preset browser — *which of these am I using?*
 *
 * This is that answer, and it is a projection over state that already exists:
 * the clip selection, and the clip-edge decoration the timeline may have
 * pinned. Nothing new is written to the document or the session. That matters
 * because a stored "currently active preset" would be a second copy of a fact
 * the clips already hold, and the two would disagree the first time anyone
 * edited a clip by any other route.
 *
 * `slot` is the load-bearing part. It is where a click LANDS, and it follows
 * one rule the user can hold in their head:
 *
 *   Pin an animation or a transition on the timeline → clicks replace THAT.
 *   Otherwise → clicks replace the layer's IN animation.
 *
 * Not "replace whichever end it feels like", and not "replace both". A browser
 * whose target you cannot predict before clicking is a browser you stop
 * trusting after the first surprise, and both ends are one pin away.
 */

/** Where a library click lands. Null = nothing selected; a click CREATES. */
export type LibrarySlot =
  /** A whole-layer in/out animation, on every focused clip. */
  | { kind: "layer"; clipIds: string[]; side: ClipEdgeSide }
  /** A glyph animation on a text layer's edge. */
  | { kind: "text"; clipIds: string[]; side: ClipEdgeSide }
  /** One existing transition, addressed by its own id. */
  | { kind: "transition"; id: string };

export interface LibraryFocus {
  /** The clips in play, minus anything that cannot carry a decoration. */
  clipIds: string[];
  /** The decoration pinned on the timeline, if any. */
  pinned: EdgeRef | null;
  /** Every decoration currently on the focused clips, for the active marks. */
  decors: EdgeDecor[];
  /** Where an animation or transition click lands. */
  slot: LibrarySlot | null;
  /**
   * Library item ids currently applied — exactly what a card draws as ON.
   *
   * Built with `libraryItemId` rather than a hand-written template string, so
   * a card and this set can never disagree about what an id looks like.
   */
  activeIds: ReadonlySet<string>;
}

export interface LibraryFocusInput {
  selectedClipIds: readonly string[];
  /** The timeline's pinned clip-edge decoration (`session.selectedEdgeDecor`). */
  selectedEdgeDecor?: EdgeRef | null;
}

const EMPTY: LibraryFocus = {
  clipIds: [],
  pinned: null,
  decors: [],
  slot: null,
  activeIds: new Set(),
};

export function libraryFocus(doc: MotionDocument, input: LibraryFocusInput): LibraryFocus {
  const pinned = input.selectedEdgeDecor ?? null;

  // A pinned TRANSITION is self-addressing: it can straddle two clips, so it
  // does not belong to the clip selection and must not be narrowed by it.
  if (pinned?.kind === "transition") {
    const found = findTransition(doc, pinned.id);
    if (found) {
      return {
        clipIds: [],
        pinned,
        decors: [found],
        slot: { kind: "transition", id: pinned.id },
        activeIds: new Set([libraryItemId("builtin", "transition", found.presetId)]),
      };
    }
  }

  // Audio has no in/out to animate, and a locked layer is not a target for
  // anything anywhere — the same rule `libraryDropAppliesTo` enforces on drop.
  const clipIds: string[] = [];
  const decors: EdgeDecor[] = [];
  for (const id of input.selectedClipIds) {
    const loc = locateClip(doc, id);
    if (!loc || loc.track.locked) continue;
    if (loc.clip.kind === "audio") continue;
    clipIds.push(id);
    decors.push(...clipEdgeDecors(loc.clip));
  }
  if (!clipIds.length) return { ...EMPTY, pinned };

  const activeIds = new Set<string>();
  for (const d of decors) {
    if (d.kind === "transition") activeIds.add(libraryItemId("builtin", "transition", d.presetId));
    else activeIds.add(libraryItemId("builtin", "animation", d.presetId));
  }
  // NOT MARKED: which text LOOK a layer is wearing. `applyTemplateToClip`
  // copies a template's style, effects and animations into the clip and keeps
  // nothing that says where they came from, so after the fact a styled text
  // layer is indistinguishable from one someone styled by hand. Marking the
  // card would need the clip to record its template id — a schema field and a
  // migration — and guessing by comparing styles would light up the wrong card
  // the moment anyone nudged a weight.

  const slot: LibrarySlot =
    pinned && pinned.kind !== "transition" && clipIds.includes(pinned.clipId)
      ? { kind: pinned.kind, clipIds: [pinned.clipId], side: pinned.side }
      : { kind: "layer", clipIds, side: "in" };

  return { clipIds, pinned, decors, slot, activeIds };
}

function findTransition(doc: MotionDocument, id: string): EdgeDecor | null {
  for (const frame of doc.frames) {
    for (const track of doc.tracks) {
      for (const decor of trackEdgeDecors(doc, track, frame.id)) {
        if (decor.ref.kind === "transition" && decor.ref.id === id) return decor;
      }
    }
  }
  return null;
}

/**
 * How far before a decoration to park the playhead when previewing it.
 *
 * A preset that starts exactly at the playhead is one you never see start —
 * playback and the first frame of the animation arrive together, and the eye
 * misses the part that makes a preset recognisable. A short run-up costs
 * nothing and is the difference between "did that do anything?" and reading
 * the motion.
 */
export const PREVIEW_LEAD_MS = 1000;

/** Where playback should start to show `decor` from a beat before it begins. */
export function previewStartMs(decor: EdgeDecor): number {
  return Math.max(0, decor.startMs - PREVIEW_LEAD_MS);
}
