"use client";

import {
  applyLayerAnimToClips,
  applyTransitionAtTime,
  applyTransitionToClips,
  libraryFocus,
  locateClip,
  previewStartMs,
  retargetTransition,
  type DocumentStore,
  type LibraryItem,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { placeAssetClips } from "../assets/import";
import { placeAboveSelection, placeSnapshot, textPresetClip } from "../state/clip-actions";
import { placeClip } from "@solomotion/core";
import { goToFrameDefinition } from "../state/frame-nav";
import { useSession, type LibraryDrag } from "../state/session";
import { activeCompId } from "../timeline/timeline-utils";
import { applyLibraryItemToClip, libraryDropAppliesTo } from "./apply-to-clip";
import { downloadWithToast, ensureLibraryAsset } from "./downloads";
import { openCommunityItem } from "./community";
import { newProjectFromTemplate } from "./templates";

/**
 * USING a library item — the one place a `LibraryAction` becomes an edit.
 *
 * Every arm routes into a seam that already existed and is already the single
 * writer for that kind of change (`applyLayerAnimToClips`, the transition ops,
 * `placeAssetClips`, `placeSnapshot`). Nothing here re-implements
 * an edit; it decides WHICH edit, which is the only thing the browser knows
 * that those functions don't.
 *
 * The `null` action — an online item nobody has downloaded — is not an error
 * case here. It is the ordinary first click: download, then use, in one gesture.
 */

/**
 * The DRAG payload for an item.
 *
 * `LibraryDrag` predates the library model and encodes something the catalogue
 * genuinely does not know: how a drop ROUTES. A transition claims the nearest
 * cut, an animation claims the half of a clip you aimed at, media may not
 * restyle a clip at all. So identity lives on the item and routing is DERIVED
 * here — one projection, one place, rather than a second switch per surface.
 *
 * ANYTHING with bytes drags as `media`, whether you own it or not: an item you
 * have not downloaded is turned into a document asset on the spot (see
 * `ensureLibraryAsset`) and the bytes stream in behind the gesture. That is
 * what lets a sound, a video and a footage clip you have never fetched all drop
 * onto the stage and the timeline through the SAME two handlers that already
 * knew how to place media — no second drop path, no async drag, no waiting.
 */
export function libraryDragFor(store: DocumentStore, item: LibraryItem): LibraryDrag {
  const label = item.name;
  switch (item.action?.type) {
    case "preset":
      return {
        kind: item.action.domain === "text" ? "template" : item.action.domain === "animation" ? "anim" : "transition",
        id: item.action.presetId,
        label,
      };
    case "instance":
      return { kind: "component", id: item.action.frameId, label };
    case "snapshot":
      return { kind: "snapshot", id: item.id.split(":").pop() ?? item.id, label };
    case "template":
      // A whole project has nowhere to land inside another one.
      return null;
    default: {
      if (item.kind === "template") return null;
      // Local asset, adopted sound, or something still online — one path.
      const assetId = ensureLibraryAsset(store, item);
      return assetId ? { kind: "media", id: assetId, label } : null;
    }
  }
}

/**
 * Can this be dropped at all? Pure — it must not fetch anything, because the
 * card asks on every render to decide whether it is grabbable.
 */
export function isDraggable(item: LibraryItem): boolean {
  switch (item.action?.type) {
    case "preset":
    case "instance":
    case "snapshot":
    case "asset":
      return true;
    case "sound":
      // Packs included: dragging one bakes it into a real file (see `bakePack`),
      // because a lane takes clips, not voices.
      return true;
    case "template":
      return false;
    default:
      return item.kind !== "template" && item.blob !== null;
  }
}

/**
 * Apply an item where the user is. Downloads first if it has to, so a single
 * click on an online card does the whole thing — a browser that makes you
 * download, find the download, then apply it is three gestures for one intent.
 */
export async function applyLibraryItem(store: DocumentStore, input: LibraryItem): Promise<void> {
  let item: LibraryItem = input;
  // A template makes a NEW project; fetching an online one is using it.
  if (item.action?.type === "template") return newProjectFromTemplate(store, item.action.templateId);
  // Online: the same clone-or-continue as Home's Community, so a second open
  // offers your copy instead of quietly making another.
  if (item.kind === "template") return openCommunityItem(store, item);
  // Not here yet? Adopt it into the document — the same call the drag makes —
  // and then fall through and PLACE it. "Get it" and "use it" were never two
  // intents; they were one gesture split apart by a download button.
  if (!item.action) {
    const assetId = ensureLibraryAsset(store, item);
    if (!assetId) {
      await downloadWithToast(item);
      return;
    }
    item = { ...item, action: { type: "asset", assetId } };
  }

  const session = useSession.getState();
  const doc = store.getState();
  const frameId = activeCompId(doc, session.activeFrameId);
  const action = item.action;
  if (!action) return;

  switch (action.type) {
    case "instance":
      goToFrameDefinition(doc, action.frameId);
      return;

    case "snapshot":
      placeSnapshot(store, item.name, action.snapshot, { frameId, startMs: session.playheadMs });
      return;

    case "asset": {
      const asset = doc.assets.find((a) => a.id === action.assetId);
      const frame = doc.frames.find((f) => f.id === frameId);
      if (!asset || !frame) return;
      void placeAssetClips(
        store,
        asset,
        { frameId: frame.id, startMs: session.playheadMs },
        { width: frame.width, height: frame.height },
        (d, primary) => placeAboveSelection(d, primary),
      );
      return;
    }

    case "sound": {
      // Clicked, not dragged: place it on a lane at the playhead — the same
      // thing dropping it there does, through the same seam.
      const assetId = ensureLibraryAsset(store, item);
      const asset = assetId ? store.getState().assets.find((a) => a.id === assetId) : null;
      const soundFrame = doc.frames.find((f) => f.id === frameId);
      if (!asset || !soundFrame) return;
      void placeAssetClips(
        store,
        asset,
        { frameId: soundFrame.id, startMs: session.playheadMs },
        { width: soundFrame.width, height: soundFrame.height },
        (d, primary) => placeAboveSelection(d, primary),
      );
      return;
    }

    case "preset":
      applyPreset(store, item, action.domain, action.presetId);
  }
}

/**
 * Park the playhead a beat BEFORE a decoration and roll, so the motion is read
 * rather than missed. A preset that begins on the playhead starts in the same
 * instant playback does, and the part that makes it recognisable is already
 * over by the time the eye arrives.
 */
function previewSlot(store: DocumentStore, clipIds: readonly string[], side: "in" | "out"): void {
  const doc = store.getState();
  const session = useSession.getState();
  const starts = clipIds
    .map((id) => locateClip(doc, id))
    .filter((l): l is NonNullable<typeof l> => l !== null)
    .map((l) => (side === "in" ? l.clip.startMs : l.clip.startMs + l.clip.durationMs - (l.clip.kind !== "audio" ? (l.clip.animOut?.durationMs ?? 0) : 0)));
  if (!starts.length) return;
  session.setPlayhead(Math.max(0, Math.min(...starts) - 1000));
  session.setPlaying(true);
}

/** The same run-up, for a transition addressed by its own id. */
function previewDecor(store: DocumentStore, transitionId: string): void {
  const doc = store.getState();
  const session = useSession.getState();
  const focus = libraryFocus(doc, { selectedClipIds: [], selectedEdgeDecor: { kind: "transition", id: transitionId } });
  const decor = focus.decors[0];
  if (!decor) return;
  session.setPlayhead(previewStartMs(decor));
  session.setPlaying(true);
}

/**
 * Presets, applied the way the left panel already applied them: an ANIMATION is
 * a modifier that needs a selection, a TRANSITION claims the cuts the selection
 * touches (or the one at the playhead), a TEMPLATE restyles a text layer or
 * creates one. Same three rules, one implementation.
 */
function applyPreset(
  store: DocumentStore,
  item: LibraryItem,
  domain: "text" | "animation" | "transition",
  presetId: string,
): void {
  const session = useSession.getState();
  const doc = store.getState();
  const frameId = activeCompId(doc, session.activeFrameId);

  /**
   * SWAP IN PLACE when the library is aimed at something.
   *
   * Both retarget seams (`retargetLayerSpec`, `retargetTransition`) already
   * promise "change the effect, keep my timing", so a swap keeps the duration,
   * the easing and every knob the new preset also declares. That promise is the
   * whole reason trying six animations in a row is pleasant rather than a
   * six-step undo: the thing you tuned survives the audition.
   */
  const focus = libraryFocus(doc, {
    selectedClipIds: session.selectedClipIds,
    selectedEdgeDecor: session.selectedEdgeDecor,
  });
  const slot = focus.slot;

  if (slot?.kind === "transition" && domain === "transition") {
    store.update(`Swap to ${item.name}`, (d) => {
      for (const track of d.tracks) {
        const tr = track.transitions?.find((t) => t.id === slot.id);
        if (!tr) continue;
        Object.assign(tr, retargetTransition(tr, presetId));
        return;
      }
    });
    previewDecor(store, slot.id);
    return;
  }

  if (slot?.kind === "layer" && domain === "animation") {
    store.update(`Animate — ${item.name}`, (d) =>
      applyLayerAnimToClips(d, slot.clipIds, presetId, slot.side),
    );
    previewSlot(store, slot.clipIds, slot.side);
    return;
  }

  if (domain === "transition") {
    let applied = 0;
    store.update(`Add ${item.name}`, (d) => {
      applied = session.selectedClipIds.length
        ? applyTransitionToClips(d, session.selectedClipIds, presetId)
        : applyTransitionAtTime(d, frameId, session.playheadMs, presetId, 500);
    });
    toast(
      applied
        ? `${item.name} added to ${applied} cut${applied > 1 ? "s" : ""}`
        : "Select clips or park the playhead on a cut",
    );
    return;
  }

  const targets = session.selectedClipIds
    .map((id) => locateClip(doc, id))
    .filter((l): l is NonNullable<typeof l> => l !== null && l.clip.kind !== "audio");

  if (domain === "animation") {
    if (!targets.length) {
      toast("Select a layer to animate");
      return;
    }
    const ids = targets.map((l) => l.clip.id);
    store.update(`Animate — ${item.name}`, (d) => applyLayerAnimToClips(d, ids, presetId, "in"));
    toast(
      ids.length === 1
        ? `${item.name} → “${targets[0]!.clip.name}”`
        : `${item.name} → ${ids.length} layers`,
    );
    session.setPlayhead(Math.min(...targets.map((l) => l.clip.startMs)));
    session.setPlaying(true);
    return;
  }

  const drag = libraryDragFor(store, item);
  if (!drag) return;
  // THE WHOLE SELECTION, not its first member. Selecting four titles and
  // clicking a look has one obvious meaning, and restyling one of them is not
  // a smaller version of it. Same rule the animation branch above already uses.
  //
  // Only claim the selection when the item can actually change it — otherwise
  // this toasted "applied" over a layer it had silently refused, and the
  // create path below (which is what the user wanted) never ran.
  const hits = targets.filter((l) => libraryDropAppliesTo(store.getState(), drag, l.clip.id));
  if (hits.length > 0) {
    applyLibraryItemToClip(store, drag, hits.map((l) => l.clip.id));
    toast(
      hits.length === 1
        ? `${item.name} → “${hits[0]!.clip.name}”`
        : `${item.name} → ${hits.length} layers`,
    );
    session.setPlayhead(Math.min(...hits.map((l) => l.clip.startMs)));
    session.setPlaying(true);
    return;
  }
  const clip = textPresetClip(drag, { frameId, startMs: session.playheadMs });
  if (!clip) return;
  store.update("Add template", (d) => placeClip(d, clip));
  session.select([clip.id]);
}
