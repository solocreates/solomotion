"use client";

import { createWorld } from "@solomotion/core";
import { useWorldUi } from "../world/state";
import {
  closeAllGaps,
  closeGap,
  gapAt,
  applyCompositeMode,
  cellPaintTargetId,
  clipSchema,
  contourSchema,
  createPathClip,
  editPathGeometry,
  toSubpath,
  type Contour,
  clipsAtTime,
  COMPOSITE_MODES,
  selectionCompositeInfo,
  type GroupMode,
  createAdjustmentClip,
  frameDurationMs,
  frameEffectClip,
  ensureFrameEffectClipIn,
  createAudioClip,
  createCaptionClip,
  createComponentInstanceClip,
  createDrawing,
  createFlipbook,
  createFrame,
  createId,
  createTextClip,
  createClipFromTemplate,
  getTemplate,
  createCarrierTrack,
  addClipToTrack,
  insertTrackAtEdge,
  type CreatedDrawing,
  type CreatedFlipbook,
  deleteClip,
  deleteFlipbookCell,
  deleteFrame,
  detachInstance,
  makeUnique,
  duplicateClipInPlace,
  fitsInTrack,
  frameSchema,
  gcOrphanNestedSources,
  pruneEmptiedTracks,
  groupClips,
  placeSnapshot as placeSnapshotIn,
  carryClips,
  pasteCarry,
  type InstantiateTarget,
  type LibrarySnapshot,
  isComponentFrame,
  isInstanceClip,
  locateClip,
  makeComponent,
  makeComponentFromFrame,
  addVariant,
  renameVariant,
  switchInstanceVariant,
  deleteVariant,
  detachInstanceFrame,
  duplicateClips,
  expandToDescendants,
  remapClipRefsAfterCopy,
  scopeEdgeIndex,
  groupOfClip,
  splitClip,
  ungroupClips,
  applicableDomains,
  applyProperties,
  captureProperties,
  compRenderTimeMs,
  propertyDomain,
  type CapturedProperties,
  parseAnimationCapture,
  toLayerAnimation,
  layerPresetsFor,
  type AnimationCapture,
  type Clip,
  type DocumentStore,
  type Frame,
  type Track,
  type MotionDocument,
  flipScalePair,
  sampleKeyframes,
  addAutoLayout,
  autoLayoutVerb,
  removeAutoLayout,
  wrapTextInShape,
  placeClip,
  type PlaceClipOptions,
  deleteLayers,
  type TextStyle,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { clipLocalClamped, commitProperty, effectiveValue, writeAnimatable } from "../inspector/animatable";
import { deleteSurfaces } from "../drawing/raster-store";
import { focusFlipbookCell } from "../drawing/flipbook-focus";
import { useSession, useStageView, type LibraryDrag } from "./session";
import { insertFrame } from "../frames/frame-modes";
import { syncEnteredGroup } from "./use-group-focus";
import { flattenSelectionToPath } from "../vector/flatten-selection";
import { textLookPrefs, useWorkspace } from "./workspace";
import { resolveDragSnapshot } from "./snapshot-drag";
import { useAppShell } from "./app-shell";
import { getLastFont } from "./font-prefs";
import { type AppFile } from "@solomotion/platform";
import { platform } from "@/editor/platform";
import { getStagePasteAnchor } from "../stage/paste-anchor";
import { appFilesToFiles } from "../assets/app-file";
import type { ImportTarget } from "../assets/import";
import { NAMES } from "@/editor/names";

/** Selection-aware clip commands, shared by the inspector, topbar and shortcuts. */

/**
 * THE unified "where does a new layer land" rule — canvas creation, paste,
 * library drops, plugins. Where you ARE is the selection, read in this order:
 *  - a selected layer that OVERLAPS in time  → just above it (same group)
 *  - a selected group you have ENTERED       → inside it, on its surface: you
 *    are in there, so that is where the thing you make belongs
 *  - a selected group you have not entered   → just above the whole group
 *  - a LANE SPOT (you pressed empty lane space) → that track — Premiere's
 *    targeted track; no room there at this time → a lane right above it
 *  - nothing, or a selection ELSEWHERE in time → the surface of the scope you
 *    are in (`placeClip`'s default): on top of everything on screen at this
 *    time, never buried under the layer you were looking at.
 * One anchor pick — the topmost-z selected clip that overlaps in the target
 * frame — plus group inheritance in `placeClip`. A lane spot and a clip
 * selection never coexist (each clears the other), so there is no tie.
 */
export function placeAboveSelection(d: MotionDocument, clip: Clip): PlaceClipOptions {
  const { selectedClipIds: sel, enteredGroupId, laneSpot } = useSession.getState();
  if (laneSpot && laneSpot.frameId === clip.frameId && d.tracks.some((t) => t.id === laneSpot.trackId)) {
    return { preferredTrackId: laneSpot.trackId };
  }
  if (clip.kind === "audio") return {};
  const end = clip.startMs + clip.durationMs;
  const overlaps = (c: Clip) => c.startMs < end && clip.startMs < c.startMs + c.durationMs;
  // Inside a group with nothing in particular picked: its surface.
  const entered = enteredGroupId ? locateClip(d, enteredGroupId) : null;
  const inside = entered && entered.clip.frameId === clip.frameId && overlaps(entered.clip) ? entered.clip.id : null;
  let anchor: { id: string; trackIndex: number } | null = null;
  for (const id of sel) {
    const loc = locateClip(d, id);
    if (!loc || loc.clip.kind === "audio" || loc.clip.frameId !== clip.frameId) continue;
    // Only stack above a layer that's actually present at this time — otherwise
    // there's nothing here to sit on top of, so let placeClip take the surface.
    if (!overlaps(loc.clip)) continue;
    // Smaller trackIndex = higher z; anchor on the topmost selected layer.
    if (!anchor || loc.trackIndex < anchor.trackIndex) anchor = { id, trackIndex: loc.trackIndex };
  }
  if (anchor && anchor.id === inside) return { groupId: inside };
  if (anchor) return { aboveClipId: anchor.id };
  return inside ? { groupId: inside } : {};
}

/**
 * The single clip a TEXT-TEMPLATE library drag would create at `ctx`. ONE source
 * of truth shared by every drop surface (stage, timeline, left-panel click) AND
 * the live drag ghost, so the preview outline is EXACTLY what drops — the same
 * unification media already has via `clipForAsset`. Returns null for anything
 * that is not a whole text layer.
 *
 * An ANIMATION deliberately returns null. A template is a THING — a styled,
 * animated layer you can point at — but an animation is a MODIFIER, and a
 * modifier with nothing to modify used to spawn a layer reading "New text" that
 * nobody asked for, on every stray drop onto empty canvas. A preset that
 * invents its own subject is not a preset; it is a guess.
 */
export function textPresetClip(
  drag: NonNullable<LibraryDrag>,
  ctx: { frameId: string; startMs: number; x?: number; y?: number },
): Clip | null {
  if (drag.kind !== "template") return null;
  const t = getTemplate(drag.id);
  // Resolved through the browser's live dials — the same ones the card that
  // started this drag previewed itself with, so the ghost, the preview and the
  // layer that lands are one picture.
  return t ? createClipFromTemplate(t, ctx, textLookPrefs()) : null;
}

/**
 * Drop a new frame of the given size, centered in the current viewport, on the
 * active page — what the frame-tool preset sidebar and any "New frame" affordance
 * call. Selecting it opens its timeline (Figma parity with the inspector's own
 * size dropdown). Reads the live stage view so the frame lands where you're looking.
 */
export function addFrameFromPreset(
  store: DocumentStore,
  preset: { name: string; width: number; height: number },
): string {
  const session = useSession.getState();
  const frame = frameAtViewportCenter(store.getState(), preset);
  store.update("Add frame", (d) => {
    frame.pageId = session.activePageId;
    insertFrame(d, frame);
  });
  session.selectFrame(frame.id);
  return frame.id;
}

/**
 * A new 3D WORLD of the given size where you are looking, opened straight into
 * its viewport, with the scene a 3D artist expects (camera, light, studio, a
 * cube). The size is the camera's output, exactly as a frame's is.
 */
export function addWorldFromPreset(store: DocumentStore, preset: { name: string; width: number; height: number }): string {
  const session = useSession.getState();
  const at = frameAtViewportCenter(store.getState(), preset);
  let id = "";
  store.update("Add 3D world", (d) => {
    const { frame } = createWorld(d, {
      name: preset.name && preset.name !== "Frame 1" ? preset.name : `World ${d.frames.filter((f) => f.world).length + 1}`,
      x: at.x,
      y: at.y,
      width: preset.width,
      height: preset.height,
      pageId: session.activePageId,
    });
    id = frame.id;
  });
  session.selectFrame(id);
  useWorldUi.getState().set({ openId: id });
  return id;
}

/** A new (not yet inserted) frame centred where you are looking. */
function frameAtViewportCenter(doc: MotionDocument, preset: { name?: string; width: number; height: number }): Frame {
  const view = useStageView.getState();
  const el = typeof document !== "undefined" ? document.querySelector("[data-stage-drop]") : null;
  const rect = el?.getBoundingClientRect();
  // Container-local screen center → world (screen = tx + world·scale).
  const cxScreen = rect ? rect.width / 2 : 600;
  const cyScreen = rect ? rect.height / 2 : 400;
  const worldCx = (cxScreen - view.tx) / view.scale;
  const worldCy = (cyScreen - view.ty) / view.scale;
  return createFrame({
    name: preset.name || `Frame ${doc.frames.length + 1}`,
    x: Math.round(worldCx - preset.width / 2),
    y: Math.round(worldCy - preset.height / 2),
    width: preset.width,
    height: preset.height,
  });
}

/**
 * THE FRAME NEW CONTENT LANDS IN — the one you name, else the one you are in,
 * else the first; and when the project has NO frames (a legal, ordinary state),
 * one is made where you are looking, in the frame tool's mode. Call it INSIDE
 * the update that adds the content, so "add text to an empty canvas" is one
 * undo step, not two.
 */
export function contentFrameIn(d: MotionDocument, preferredId?: string | null): Frame {
  const session = useSession.getState();
  const found =
    (preferredId ? d.frames.find((f) => f.id === preferredId) : undefined) ??
    (session.activeFrameId ? d.frames.find((f) => f.id === session.activeFrameId) : undefined) ??
    d.frames[0];
  if (found) return found;
  const frame = frameAtViewportCenter(d, { name: "Frame 1", width: 1080, height: 1920 });
  frame.pageId = session.activePageId;
  insertFrame(d, frame);
  // Stand in it once the update lands, so the timeline and inspector follow.
  queueMicrotask(() => {
    if (!useSession.getState().activeFrameId) useSession.getState().openTimeline(frame.id);
  });
  return d.frames.find((f) => f.id === frame.id) ?? frame;
}

/** `contentFrameIn` for callers that resolve the frame BEFORE their own update. */
export function ensureContentFrame(store: DocumentStore, preferredId?: string | null): Frame {
  const doc = store.getState();
  const existing =
    (preferredId ? doc.frames.find((f) => f.id === preferredId) : undefined) ??
    doc.frames.find((f) => f.id === useSession.getState().activeFrameId) ??
    doc.frames[0];
  if (existing) return existing;
  let id = "";
  store.update("Add frame", (d) => void (id = contentFrameIn(d, preferredId).id));
  return store.getState().frames.find((f) => f.id === id)!;
}

/**
 * Delete frames — every surface's one path (Delete key, inspector, context
 * menu, cut). The last frame goes too: an empty canvas is a project, not an
 * error. Private comps only those frames nested are collected with them.
 */
export function deleteFrames(store: DocumentStore, ids: readonly string[], label?: string): void {
  if (ids.length === 0) return;
  store.update(label ?? (ids.length > 1 ? "Delete frames" : "Delete frame"), (d) => {
    for (const id of ids) deleteFrame(d, id);
    gcOrphanNestedSources(d);
  });
  useSession.getState().selectFrame(null);
}

/**
 * THE way a snapshot becomes layers — a saved component, an icon from the
 * icons plugin, anything a panel hands over as `LibrarySnapshot`. New ids
 * throughout, the group recreated and its members moved onto its rows, every
 * clip routed through `placeClip` so it lands where the drop said (a lane, a
 * group's band, above the selection, on top). Selection lands on the group,
 * or on the visual clips when there is none. Returns the new clip ids.
 *
 * One seam, because the previous three copies (library click, stage drop,
 * timeline drop) each instantiated the snapshot and each forgot the same
 * thing: containment is the ROW, so a recreated group whose members were never
 * moved onto its rows was a group holding nothing.
 */
export function placeSnapshot(
  store: DocumentStore,
  name: string,
  snapshot: LibrarySnapshot,
  target: InstantiateTarget,
  placement: PlaceClipOptions = {},
): string[] {
  let placed: ReturnType<typeof placeSnapshotIn> = { ids: [], group: null, visual: [] };
  store.update(`Add ${name}`, (d) => void (placed = placeSnapshotIn(d, snapshot, target, placement)));
  if (placed.ids.length === 0) return [];
  // A grouped snapshot lands as ONE thing, so that is what gets selected.
  useSession.getState().select(placed.group ? [placed.group.id] : placed.visual.length ? placed.visual : placed.ids);
  return placed.ids;
}

/**
 * Place the clips behind a `snapshot` drag id — a saved library component or a
 * transient snapshot a panel registered for the gesture (`snapshot-drag.ts`).
 */
export function placeLibraryItem(
  store: DocumentStore,
  itemId: string,
  target: InstantiateTarget,
  placement: PlaceClipOptions = {},
): void {
  const hit = resolveDragSnapshot(itemId);
  if (!hit) return;
  placeSnapshot(store, hit.name, hit.snapshot, target, placement);
}

/**
 * Add a fresh clip of the given kind at the playhead, on the first unlocked
 * track (or a new one), dodging collisions. Timeline "+ Clip" and ⌘K both
 * land here.
 */
export function addClipAtPlayhead(
  store: DocumentStore,
  kind: "text" | "caption" | "audio",
  /** A text layer's own words and look — the Fonts window starts one set in the font you chose. */
  text?: { text?: string; style?: Partial<TextStyle> },
): void {
  const session = useSession.getState();
  let created: string | null = null;
  store.update(`Add ${kind} clip`, (d) => {
    const frameId = contentFrameIn(d).id;
    // This path picks its own lane instead of going through `placeClip`, so it
    // applies the grid rule itself — same seam, same reason (see `placeClip`).
    const at = compRenderTimeMs(d, frameId, session.playheadMs);
    let track = d.tracks.find((t) => !t.locked);
    if (!track) {
      track = createCarrierTrack();
      if (kind === "audio") d.tracks.push(track);
      else d.tracks.unshift(track);
    }
    const lastFont = getLastFont(useAppShell.getState().currentProjectId);
    const clip =
      kind === "text"
        ? createTextClip({
            frameId,
            text: text?.text || "New text",
            startMs: at,
            style: { ...(lastFont ? { fontFamily: lastFont } : {}), ...text?.style },
          })
        : kind === "caption"
          ? createCaptionClip({ frameId, text: "new caption words here", startMs: at, y: 520 })
          : createAudioClip({ frameId, startMs: at });
    const neighbors = track.clips.filter((c) => c.frameId === frameId);
    const collides = neighbors.some(
      (c) => clip.startMs < c.startMs + c.durationMs && clip.startMs + clip.durationMs > c.startMs,
    );
    if (collides) {
      clip.startMs = Math.max(...neighbors.map((c) => c.startMs + c.durationMs), 0);
    }
    addClipToTrack(track, clip);
    track.clips.sort((a, b) => a.startMs - b.startMs);
    created = clip.id;
  });
  if (created) useSession.getState().select([created]);
}

/**
 * Add a FLIPBOOK at the playhead: a frame-by-frame comp with one row and one
 * blank drawing cell, sized to the parent comp. Selecting it, not entering it —
 * adding a layer shouldn't yank navigation into its timeline (same stance as
 * `addDrawingAtPlayhead`); double-click when you're ready to draw. One undo step.
 */
export function addFlipbookAtPlayhead(store: DocumentStore): void {
  const session = useSession.getState();
  let result: CreatedFlipbook | null = null;
  store.update("Add flipbook", (d) => {
    const frameId = contentFrameIn(d).id;
    const parent = d.frames.find((f) => f.id === frameId)!;
    result = createFlipbook(d, {
      parentFrameId: frameId,
      startMs: session.playheadMs,
      width: parent.width,
      height: parent.height,
    });
    placeClip(d, result.clip);
  });
  const r = result as CreatedFlipbook | null;
  if (r) {
    session.select([r.clip.id]);
    toast("Flipbook added — double-click to open the sheet");
  }
}

/**
 * Add a DRAWING at the playhead: a paint comp with one pixel layer, shown as
 * one clip in the parent (static by default — extend or animate it like any
 * clip). Selecting it, not entering it: a quick sketch layer shouldn't yank
 * navigation.
 */
export function addDrawingAtPlayhead(store: DocumentStore): void {
  const session = useSession.getState();
  let result: CreatedDrawing | null = null;
  store.update("Add drawing", (d) => {
    const frameId = contentFrameIn(d).id;
    const parent = d.frames.find((f) => f.id === frameId)!;
    result = createDrawing(d, {
      parentFrameId: frameId,
      startMs: session.playheadMs,
      durationMs: 5000,
      width: parent.width,
      height: parent.height,
    });
    placeClip(d, result.clip);
  });
  const r = result as CreatedDrawing | null;
  if (r) session.select([r.clip.id]);
}

/**
 * Add an ADJUSTMENT layer: a processor that grades the layers beneath it
 * through the shared effect stack. Lands TOPMOST so its default "below" reach
 * covers the whole stack the moment it's created, and is selected (not entered)
 * so the inspector opens ready to add effects + tune scope.
 *
 * It spans the WHOLE comp and keeps spanning it (`fillDuration`, born true in
 * `createAdjustmentClip`) rather than starting at the playhead: a grade that
 * silently stops two thirds of the way through is not a shorter version of a
 * grade, it is a bug you find at export. Trim it and it stays trimmed; Timing's
 * Fill switch puts it back.
 */
export function addAdjustmentLayer(store: DocumentStore): void {
  const session = useSession.getState();
  let created: string | null = null;
  store.update("Add adjustment layer", (d) => {
    const frameId = contentFrameIn(d).id;
    const frame = d.frames.find((f) => f.id === frameId)!;
    const clip = createAdjustmentClip({ frameId, startMs: 0, durationMs: frameDurationMs(d, frame) });
    placeClip(d, clip);
    created = clip.id;
  });
  if (created) {
    session.select([created]);
    toast("Adjustment layer added — it grades everything below");
  }
}

/**
 * The clip carrying a frame's OWN effects, creating it the first time — one
 * undo step. The brain is core's `ensureFrameEffectClipIn`, shared with the
 * API, so the clip an agent makes is the one this panel finds.
 */
export function ensureFrameEffectClip(store: DocumentStore, frameId: string): string | null {
  const existing = frameEffectClip(store.getState(), frameId);
  if (existing) return existing.id;
  let created: string | null = null;
  store.update("Add frame effects", (d) => {
    created = ensureFrameEffectClipIn(d, frameId)?.id ?? null;
  });
  return created;
}

/**
 * Combine the selection under a composite mode (union / subtract / intersect /
 * exclude / mask) — or back to a plain group with "pass". One action for the
 * inspector's Combine row, the right-click menu and the ⌘⌥M shortcut; the
 * eligibility condition lives in core (`selectionCompositeInfo`), so every
 * surface shows and does exactly the same thing. Reuses the selection's group
 * when it IS one (no zombie wrappers), otherwise groups first.
 */
export function applyCompositeToSelection(store: DocumentStore, mode: GroupMode): void {
  const ids = useSession.getState().selectedClipIds;
  const info = selectionCompositeInfo(store.getState(), ids);
  if (!info.eligible) {
    toast("Select 2+ layers in the same frame to combine");
    return;
  }
  const label = COMPOSITE_MODES.find((m) => m.mode === mode)?.label ?? "Group";
  let gid: string | null = null;
  store.update(label, (d) => void (gid = applyCompositeMode(d, ids, mode)));
  if (!gid) return;
  // A combine that wrapped the selection leaves you holding the RESULT: the
  // group, one layer. Re-moding a group you already had keeps that selection.
  if (!info.groupId) useSession.getState().select([gid]);
  if (mode === "mask" && !info.groupId) {
    toast("Masked — the top layer is the stencil. Tap a layer's badge to swap sides.");
  } else if (mode !== "pass" && !info.groupId) {
    toast(`${label} — it's a group; change the mode anytime in the sidebar`);
  }
}

/** ⌘G — group the selected layers. One layer wraps, as in Figma. */
/**
 * ⇧H / ⇧V — mirror the selection across one axis. A mirror is a NEGATIVE
 * SCALE and nothing else (transform-map.ts), so this writes the sign through
 * `flipScalePair`, which materialises the uniform pair when the two axes'
 * signs part ways. Each layer flips about its own pivot; keyed scale writes a
 * key at the playhead through the same seam a field would.
 */
export function flipSelection(store: DocumentStore, axis: "x" | "y"): void {
  const ids = useSession.getState().selectedClipIds;
  if (ids.length === 0) return;
  const playhead = useSession.getState().playheadMs;
  store.update(axis === "x" ? "Flip horizontal" : "Flip vertical", (d) => {
    for (const id of ids) {
      const clip = locateClip(d, id)?.clip;
      if (!clip || clip.kind === "audio") continue;
      const local = clipLocalClamped(clip, playhead);
      const kf = sampleKeyframes(clip.keyframes, local);
      const cur = {
        scale: typeof kf["scale"] === "number" ? (kf["scale"] as number) : clip.transform.scale,
        scaleY: typeof kf["scaleY"] === "number" ? (kf["scaleY"] as number) : clip.transform.scaleY,
      };
      const next = flipScalePair(cur, axis);
      writeAnimatable(clip, "scale", next.scale, playhead, (c) => {
        if (c.kind !== "audio") c.transform.scale = next.scale;
      });
      if (next.scaleY !== null) {
        writeAnimatable(clip, "scaleY", next.scaleY, playhead, (c) => {
          if (c.kind !== "audio") c.transform.scaleY = next.scaleY;
        });
      } else if (clip.transform.scaleY !== null) {
        clip.transform.scaleY = null;
      }
    }
  });
}

/**
 * ⇧A — AUTO LAYOUT, from whatever is selected:
 *
 *   a laid-out group          → the layout comes off, members stay where they are
 *   a text and a rectangle    → the rect becomes the box and the text sits in it
 *   a plain group             → it gains a layout describing its current arrangement
 *   several other layers      → they are grouped, then that
 *   one plain layer           → nothing (see `autoLayoutVerb`)
 *
 * One key, because Figma taught everyone that ⇧A means "make this a row", and
 * the four cases are what "this" can be.
 */
export function toggleAutoLayout(store: DocumentStore): void {
  const session = useSession.getState();
  const ids = session.selectedClipIds;
  if (ids.length === 0) {
    toast("Select layers to lay out");
    return;
  }
  const doc = store.getState();
  const verb = autoLayoutVerb(doc, ids);
  if (!verb) {
    toast("Auto layout needs a group or several layers");
    return;
  }
  const clips = ids.map((id) => locateClip(doc, id)?.clip).filter((c): c is Clip => !!c);
  const single = clips.length === 1 ? clips[0]! : null;

  if (verb === "remove" && single) {
    store.update("Remove auto layout", (d) => void removeAutoLayout(d, single.id, session.playheadMs));
    toast("Auto layout removed");
    return;
  }
  const text = clips.find((c) => c.kind === "text");
  const rect = clips.find((c) => c.kind === "shape" && c.shape === "rect");
  if (clips.length === 2 && text && rect) {
    let gid: string | null = null;
    store.update("Put text in shape", (d) => void (gid = wrapTextInShape(d, text.id, rect.id)));
    if (gid) {
      session.select([gid]);
      toast("Text in a box — the rectangle is now the container");
    }
    return;
  }
  let gid: string | null = single?.kind === "group" ? single.id : null;
  store.update("Add auto layout", (d) => {
    if (!gid) gid = groupClips(d, ids);
    if (gid) addAutoLayout(d, gid);
  });
  if (gid) {
    session.setCollapsed(gid, true);
    session.select([gid]);
    toast("Auto layout on — drag the pink handles for gap and padding");
  }
}

export function groupSelection(store: DocumentStore): void {
  const ids = useSession.getState().selectedClipIds;
  if (ids.length === 0) {
    toast("Select a layer to group");
    return;
  }
  let gid: string | null = null;
  store.update("Group layers", (d) => void (gid = groupClips(d, ids)));
  // The group is now the thing you have — one layer, selected as one — and it
  // starts folded: grouping should tidy the timeline, not just tag the clips.
  // The chevron on its bar opens it.
  if (gid) {
    useSession.getState().setCollapsed(gid, true);
    useSession.getState().select([gid]);
  }
  toast("Grouped — click ▸ on the bar to open it, ⇧⌘G to ungroup");
}

/**
 * ⌘E — flatten the selection into ONE editable path. A shape, a text run, a
 * boolean/combine group, or any depth of them collapses to a single vector
 * outline (curves preserved where no boolean forces a merge).
 */
export async function flattenSelection(store: DocumentStore): Promise<void> {
  const ids = useSession.getState().selectedClipIds;
  if (ids.length === 0) return;
  const newId = await flattenSelectionToPath(store, ids);
  if (!newId) {
    toast.error("Nothing to flatten", {
      description: "The selection has no vector geometry (or a font couldn't be outlined).",
    });
    return;
  }
  useSession.getState().select([newId]);
  toast("Flattened to one path — double-click to edit points");
}

/** ⇧⌘G — dissolve any groups the selection touches. */
export function ungroupSelection(store: DocumentStore): void {
  const ids = useSession.getState().selectedClipIds;
  if (ids.length === 0) return;
  store.update("Ungroup", (d) => ungroupClips(d, ids));
  syncEnteredGroup(store.getState());
  toast("Ungrouped");
}

export function deleteSelectedClips(store: DocumentStore): void {
  // Deleting a GROUP deletes what is in it — the selection is the group clip
  // alone, so the contents are widened in here rather than at every call site
  // that can start a delete.
  const ids = selectionContentIds(store);
  if (ids.length === 0) return;
  const autoPrune = useSession.getState().autoDeleteEmptyTracks;
  let orphanSurfaces: string[] = [];
  store.update(ids.length > 1 ? "Delete clips" : "Delete clip", (d) => {
    orphanSurfaces = deleteLayers(d, ids, { pruneEmptiedTracks: autoPrune }).orphanSurfaces;
  });
  if (orphanSurfaces.length > 0) deleteSurfaces(orphanSurfaces);
  useSession.getState().clearSelection();
}

/**
 * After deleting flipbook cells, reveal a surviving one — same gesture a
 * plain click already uses (revealFrame + select its paint target). Deleting
 * a cell (or a whole row) can remove a drawing FRAME entirely (the last-
 * instance cleanup in deleteFlipbookCell); if that was the frame the session
 * had drilled into, `activeFrameId` points at nothing afterward and the
 * sheet falls back out to the root timeline. `preferredId` (a same-row
 * neighbor, when the caller has one) wins; otherwise the flipbook's first
 * remaining cell in ANY row — always something IN the sheet, never nothing.
 */
function focusSurvivingFlipbookCell(
  after: MotionDocument,
  flipbookId: string,
  preferredId: string | null,
): void {
  const session = useSession.getState();
  let landLoc = preferredId ? locateClip(after, preferredId) : null;
  if (!landLoc) {
    const anyCell = after.tracks
      .flatMap((t) => t.clips)
      .filter((c) => c.kind === "nested" && c.frameId === flipbookId)
      .sort((a, b) => a.startMs - b.startMs)[0];
    landLoc = anyCell ? locateClip(after, anyCell.id) : null;
  }
  if (landLoc && landLoc.clip.kind === "nested") focusFlipbookCell(after, landLoc.clip);
}

/**
 * Remove whole flipbook cells by id — the ONE place that does it, so ⌫ (once
 * routed to a cell selection instead of whatever's painted inside it), the
 * cell context menu, and any future caller can never disagree on what
 * "delete this frame" means.
 */
export function deleteFlipbookCells(store: DocumentStore, cellIds: string[]): void {
  if (cellIds.length === 0) return;
  const deleted = new Set(cellIds);
  const before = store.getState();
  const firstLoc = locateClip(before, cellIds[0]!);
  let focusAfterId: string | null = null;
  if (firstLoc) {
    const siblings = firstLoc.track.clips
      .filter((c) => c.frameId === firstLoc.clip.frameId)
      .sort((a, b) => a.startMs - b.startMs);
    const firstDeletedIdx = siblings.findIndex((c) => deleted.has(c.id));
    for (let i = firstDeletedIdx - 1; i >= 0; i--) {
      if (!deleted.has(siblings[i]!.id)) {
        focusAfterId = siblings[i]!.id;
        break;
      }
    }
    if (!focusAfterId) focusAfterId = siblings.find((c) => !deleted.has(c.id))?.id ?? null;
  }
  const flipbookId = firstLoc?.clip.frameId ?? null;

  const orphanSurfaces: string[] = [];
  store.update(cellIds.length > 1 ? "Delete frames" : "Delete frame", (d) => {
    for (const id of cellIds) orphanSurfaces.push(...(deleteFlipbookCell(d, id) ?? []));
  });
  if (orphanSurfaces.length > 0) deleteSurfaces(orphanSurfaces);

  useSession.getState().clearSelection();
  if (flipbookId) focusSurvivingFlipbookCell(store.getState(), flipbookId, focusAfterId);
}

/** Remove an entire flipbook row (track) — the sheet's "Delete row". */
export function deleteFlipbookRow(store: DocumentStore, trackId: string, flipbookId: string): void {
  const orphanSurfaces: string[] = [];
  store.update("Delete row", (d) => {
    const t = d.tracks.find((x) => x.id === trackId);
    if (!t) return;
    for (const cell of [...t.clips]) {
      if (cell.frameId !== flipbookId) continue;
      orphanSurfaces.push(...(deleteFlipbookCell(d, cell.id) ?? []));
    }
    if (t.clips.length === 0) {
      const i = d.tracks.indexOf(t);
      if (i >= 0) d.tracks.splice(i, 1);
    }
  });
  if (orphanSurfaces.length > 0) deleteSurfaces(orphanSurfaces);

  useSession.getState().clearSelection();
  focusSurvivingFlipbookCell(store.getState(), flipbookId, null);
}

/**
 * Unified delete: whatever is selected — layers or a frame — goes. This is
 * what ⌫ and every context menu call.
 */
export function deleteSelection(store: DocumentStore): void {
  const session = useSession.getState();
  if (session.selectedClipIds.length > 0) {
    deleteSelectedClips(store);
    return;
  }
  // A lane spot inside a GAP deletes as a gap: the hole closes and the lane
  // falls back into it. Same key, and it comes first for the same reason the
  // clip branch does — one selection is live at a time, and this is the one
  // you can see. A spot on open lane has nothing to delete.
  if (session.laneSpot) {
    closeSelectedGap(store);
    return;
  }
  if (session.selectedFrameIds.length > 0) deleteFrames(store, session.selectedFrameIds);
}

/**
 * ⇧⌘L — toggle lock on the selected clips (Figma-style: locked if ANY are
 * unlocked, unlocked only once every one already is). Locking a clip
 * immediately drops it out of the selection — a locked layer can't stay
 * selected, matching every other lock entry point (context menu, layers
 * panel, timeline).
 */
export function toggleLockSelection(store: DocumentStore): void {
  const ids = useSession.getState().selectedClipIds;
  if (ids.length === 0) return;
  const doc = store.getState();
  const clips = ids.map((id) => locateClip(doc, id)?.clip).filter((c): c is Clip => c !== undefined);
  const nextLocked = !clips.every((c) => c.locked);
  store.update(nextLocked ? "Lock layers" : "Unlock layers", (d) => {
    for (const id of ids) {
      const loc = locateClip(d, id);
      if (loc) loc.clip.locked = nextLocked;
    }
  });
  if (nextLocked) useSession.getState().clearSelection();
}

/** ⇧⌘H — toggle visibility on the selected clips, same all-locked-style semantics as `toggleLockSelection`. */
export function toggleHiddenSelection(store: DocumentStore): void {
  const ids = useSession.getState().selectedClipIds;
  if (ids.length === 0) return;
  const doc = store.getState();
  const clips = ids.map((id) => locateClip(doc, id)?.clip).filter((c): c is Clip => c !== undefined);
  const nextHidden = !clips.every((c) => c.hidden);
  store.update(nextHidden ? "Hide layers" : "Show layers", (d) => {
    for (const id of ids) {
      const loc = locateClip(d, id);
      if (loc) loc.clip.hidden = nextHidden;
    }
  });
}

export function duplicateSelectedClips(store: DocumentStore): void {
  // ONE headless op (`duplicateClips`): it widens a selected group to its
  // contents, places each copy on a fresh lane above its source, and re-points
  // the copies' membership at the COPIED group. ⌥-drag calls the same thing, so
  // the two gestures cannot drift apart about what duplicating a group means.
  const selection = useSession.getState().selectedClipIds;
  if (selection.length === 0) return;
  let tops: string[] = [];
  store.update(selection.length > 1 ? "Duplicate clips" : "Duplicate clip", (d) => {
    // A duplicated nested clip SHARES its source comp (no frame duplication) —
    // edit-in-place stays in sync; diverge via Detach / Create component.
    tops = duplicateClips(d, selection).tops;
  });
  // The copies of what you SELECTED become the new selection — a duplicated
  // group is one thing selected, exactly as the original was.
  if (tops.length > 0) useSession.getState().select(tops);
}

// ── Components (Figma) ───────────────────────────────────────────────────────

/**
 * Turn the selection into a reusable COMPONENT (Figma "create component"). The
 * selection becomes the first instance; the definition lands in the Components
 * page + library. Works for ANY selection (text, shape, media, mixed…).
 */
export function createComponentFromSelection(store: DocumentStore): void {
  const ids = useSession.getState().selectedClipIds;
  if (ids.length === 0) return;
  let instanceId: string | null = null;
  store.update("Create component", (d) => void (instanceId = makeComponent(d, ids)?.clipId ?? null));
  if (instanceId) {
    useSession.getState().select([instanceId]);
    toast("Created component — find it in the library’s Components");
  }
}

/**
 * Turn a whole FRAME into a reusable component (right-click a frame → Create
 * component). The frame becomes the definition in place and lands in the
 * Components page + library, ready to instance.
 */
export function createComponentFromFrame(store: DocumentStore, frameId: string): void {
  const already = store.getState().frames.find((f) => f.id === frameId);
  if (already && isComponentFrame(already)) {
    toast("Already a component");
    return;
  }
  let ok = false;
  store.update("Create component", (d) => void (ok = makeComponentFromFrame(d, frameId) != null));
  if (ok) toast("Created component — find it in the library’s Components");
}

/**
 * Detach the selected instances from their component so each becomes an
 * independent nested clip (its content + animation can now diverge).
 */
export function detachSelectedInstances(store: DocumentStore): void {
  const ids = useSession.getState().selectedClipIds;
  if (ids.length === 0) return;
  let n = 0;
  store.update("Detach instance", (d) => {
    for (const id of ids) if (detachInstance(d, id)) n++;
  });
  if (n > 0) toast(`Detached ${n} instance${n > 1 ? "s" : ""}`);
}

/**
 * Make the selected nested layers unique: each linked one gets its own copy of
 * the comp it showed, so editing it stops changing the original.
 */
export function makeNestedUnique(store: DocumentStore): void {
  const ids = useSession.getState().selectedClipIds;
  let n = 0;
  store.update("Make unique", (d) => {
    for (const id of ids) if (makeUnique(d, id)) n++;
  });
  if (n > 0) toast(n > 1 ? `${n} layers made unique` : "Made unique");
}

/** Detach a LINKED INSTANCE FRAME (`instanceOf`) into an independent frame. */
export function detachInstanceFrameAction(store: DocumentStore, frameId: string): void {
  let ok = false;
  store.update("Detach instance", (d) => void (ok = detachInstanceFrame(d, frameId)));
  if (ok) toast("Detached instance");
}

// ── Variants (named alternates) ──────────────────────────────────────────────
// All wire to the ONE headless brain in @solomotion/core; `id` is a frame OR clip.

/** The component frame to clone a new variant FROM, given a frame/clip id. */
function variantSourceFrameId(d: ReturnType<DocumentStore["getState"]>, id: string): string | null {
  const frame = d.frames.find((f) => f.id === id);
  if (frame) return frame.instanceOf ?? (isComponentFrame(frame) ? frame.id : null);
  const loc = locateClip(d, id);
  if (loc && loc.clip.kind === "nested") {
    const srcId = loc.clip.sourceFrameId;
    const src = d.frames.find((f) => f.id === srcId);
    if (src && isComponentFrame(src)) return src.id;
  }
  return null;
}

export function addVariantFor(store: DocumentStore, id: string): void {
  let newId: string | null = null;
  store.update("Add variant", (d) => {
    const from = variantSourceFrameId(d, id);
    if (from) newId = addVariant(d, from);
  });
  if (newId) toast("Added variant");
}

export function switchVariantFor(store: DocumentStore, instanceId: string, variantFrameId: string): void {
  store.update("Switch variant", (d) => void switchInstanceVariant(d, instanceId, variantFrameId));
}

export function renameVariantFor(store: DocumentStore, frameId: string, name: string): void {
  store.update("Rename variant", (d) => void renameVariant(d, frameId, name));
}

export function deleteVariantFor(store: DocumentStore, frameId: string): void {
  let ok = false;
  store.update("Delete variant", (d) => void (ok = deleteVariant(d, frameId)));
  if (ok) toast("Deleted variant");
}

/** True if any selected clip is a component instance (drives menu/inspector). */
export function selectionHasInstance(store: DocumentStore): boolean {
  const doc = store.getState();
  return useSession
    .getState()
    .selectedClipIds.some((id) => {
      const c = locateClip(doc, id)?.clip;
      return c ? isInstanceClip(doc, c) : false;
    });
}

/**
 * Drop an INSTANCE of a component onto a frame at a time (library drag,
 * copy/paste of a component, alt-drop). Returns the new clip id.
 */
export function placeComponentInstance(
  store: DocumentStore,
  componentFrameId: string,
  opts: {
    frameId: string;
    startMs: number;
    x?: number;
    y?: number;
    preferredTrackId?: string;
    newLaneEdge?: "top" | "bottom";
  },
): string | null {
  let id: string | null = null;
  store.update("Place instance", (d) => {
    const clip = createComponentInstanceClip(d, componentFrameId, {
      frameId: opts.frameId,
      startMs: opts.startMs,
      x: opts.x,
      y: opts.y,
    });
    if (!clip) return;
    placeClip(d, clip, opts.newLaneEdge ? { newLaneEdge: opts.newLaneEdge } : opts.preferredTrackId);
    id = clip.id;
  });
  if (id) useSession.getState().select([id]);
  return id;
}

/**
 * ⌘B — razor at the playhead, NLE-style: cuts the selected clips (or every
 * clip under the playhead when nothing is selected) and leaves the right-hand
 * halves selected, ready for ripple edits.
 */
export function splitAtPlayhead(store: DocumentStore): void {
  const session = useSession.getState();
  const doc = store.getState();
  const compId =
    session.activeFrameId && doc.frames.some((f) => f.id === session.activeFrameId)
      ? session.activeFrameId
      : doc.frames[0]?.id;
  if (!compId) return;
  const targets =
    session.selectedClipIds.length > 0
      ? session.selectedClipIds
      : clipsAtTime(doc, session.playheadMs)
          .filter((l) => l.clip.frameId === compId)
          .map((l) => l.clip.id);
  if (targets.length === 0) return;
  const rightIds: string[] = [];
  store.update("Split clip", (d) => {
    const idMap = new Map<string, string>();
    for (const id of targets) {
      const rightId = splitClip(d, id, session.playheadMs);
      if (rightId) {
        rightIds.push(rightId);
        idMap.set(id, rightId);
      }
    }
    // The right halves are one coherent batch: they form their OWN link
    // groups (left pair stays linked, right pair links to each other — never
    // all four chained together), and a split waveform retargets to the
    // split-off audio half so it CONTINUES visualizing the sound beside it.
    const rights = rightIds
      .map((id) => locateClip(d, id)?.clip)
      .filter((c): c is Clip => c !== undefined);
    remapClipRefsAfterCopy(d, rights, idMap);
  });
  if (rightIds.length > 0) session.select(rightIds);
}

/** Nudge selected layers on the canvas (arrow keys) — keyframe-aware. */
export function nudgeSelected(store: DocumentStore, dx: number, dy: number): void {
  const ids = useSession.getState().selectedClipIds;
  if (ids.length === 0) return;
  const playhead = useSession.getState().playheadMs;
  store.update(
    "Nudge layer",
    (d) => {
      for (const track of d.tracks) {
        for (const clip of track.clips) {
          if (clip.kind === "audio" || !ids.includes(clip.id)) continue;
          // Nudge from the value you can SEE, not from the resting one. Reading
          // `transform.x` straight off the clip is right only while the property
          // is un-keyed: once x/y have keys (or record mode is arming them), the
          // base is whatever it happened to be when the first key was planted,
          // so `base + 1` wrote the same key value on every press — the layer
          // hopped once and then looked dead. `effectiveValue` is the same
          // sampled-else-base rule the inspector and every canvas drag read.
          const pose = {
            x: effectiveValue(clip, "x", clip.transform.x, playhead),
            y: effectiveValue(clip, "y", clip.transform.y, playhead),
          };
          if (dx !== 0) {
            const nx = pose.x + dx;
            writeAnimatable(clip, "x", nx, playhead, (c) => {
              if (c.kind !== "audio") c.transform.x = nx;
            });
          }
          if (dy !== 0) {
            const ny = pose.y + dy;
            writeAnimatable(clip, "y", ny, playhead, (c) => {
              if (c.kind !== "audio") c.transform.y = ny;
            });
          }
        }
      }
    },
    { mergeKey: "nudge" },
  );
}

/**
 * Set the whole selection's opacity, as a percentage. The digit gesture's one
 * write: it goes through `commitProperty`, so a keyed or record-armed layer
 * keys at the playhead exactly as the inspector field would, and every layer in
 * the selection lands in ONE undo entry. The merge key coalesces a two-digit
 * run ("5" then "2") into a single undo step — otherwise refining 50% to 52%
 * would cost two ⌘Z to take back.
 */
export function setSelectionOpacity(store: DocumentStore, percent: number): number {
  const ids = useSession.getState().selectedClipIds;
  if (ids.length === 0) return 0;
  const value = Math.min(1, Math.max(0, percent / 100));
  const playhead = useSession.getState().playheadMs;
  let touched = 0;
  store.update(
    "Opacity",
    (d) => {
      for (const id of ids) {
        const loc = locateClip(d, id);
        if (!loc || loc.clip.kind === "audio") continue;
        commitProperty(loc.clip, "opacity", value, playhead);
        touched++;
      }
    },
    { mergeKey: "opacity-digits" },
  );
  return touched;
}

// ── Clipboard (⌘C/⌘X/⌘V) — clips or a whole frame ───────────────────────────

const CLIPBOARD_TYPE = NAMES.wire.clipboard("clips");
const CLIPBOARD_FRAME_TYPE = NAMES.wire.clipboard("frame");
const CLIPBOARD_PROPS_TYPE = NAMES.wire.clipboard("properties");
const CLIPBOARD_CONTOURS_TYPE = NAMES.wire.clipboard("contours");
const CLIPBOARD_ANIM_TYPE = NAMES.wire.clipboard("animation");

/**
 * Membership is the ROW's, and a clipboard carries clips — so the group each
 * clip sat in travels beside it, by source id. Paste seats every copy by this
 * and `remapClipRefsAfterCopy` re-points it at the copied group (or drops it
 * when the group stayed behind and the copy crossed comps).
 */
type ClipScopes = Record<string, string>;

/**
 * The LANE each clip sat on, by source id — the other half of "where was this".
 * A paste is a restore, so a copy goes back to its own lane when that lane
 * still exists and is free at the paste time (`PlaceClipOptions.homeTrackId`);
 * a clipboard from another comp or another document simply names lanes that
 * are not here, and the rule falls through.
 */
type ClipLanes = Record<string, string>;

type ClipboardPayload =
  | { kind: "clips"; clips: Clip[]; scopes: ClipScopes; lanes: ClipLanes }
  | { kind: "frame"; frame: Frame; clips: Clip[]; scopes: ClipScopes; lanes: ClipLanes }
  | { kind: "properties"; captured: CapturedProperties }
  | { kind: "contours"; contours: Contour[] }
  | { kind: "animation"; animation: AnimationCapture };

/**
 * WHAT A COPIED THING IS AS PLAIN TEXT — the one answer for every text field.
 *
 * Layers, frames, contours, keyframes and modulators go on the system clipboard
 * as the app's JSON (so they cross tabs and documents). A text field that pasted
 * that string verbatim filled itself with a wall of JSON — copy a text layer,
 * paste into another layer's words, get `{"type":"<ns>/clips",…}`. Pasting
 * into text means the WORDS: the copied text layers' content in stack order,
 * one per line, and nothing at all for a payload that has no words (a shape, a
 * curve). Anything that is not ours comes back exactly as it was.
 */
export function clipboardPlainText(raw: string): string {
  const head = raw.trimStart();
  if (!head.startsWith("{")) return raw;
  let data: { type?: unknown; kind?: unknown; clips?: unknown };
  try {
    data = JSON.parse(head) as typeof data;
  } catch {
    return raw;
  }
  const tag = typeof data.type === "string" ? data.type : typeof data.kind === "string" ? data.kind : "";
  if (!tag.startsWith(NAMES.wire.clipboardPrefix)) return raw;
  const payload = parseClipboardPayload(head);
  const clips = payload && (payload.kind === "clips" || payload.kind === "frame") ? payload.clips : [];
  return clips.flatMap((c) => (c.kind === "text" && c.text ? [c.text] : [])).join("\n");
}

/** Validate clipboard text via the core schemas (no drift possible). */
function parseClipboardPayload(raw: string): ClipboardPayload | null {
  try {
    const data = JSON.parse(raw) as {
      type?: unknown;
      clips?: unknown;
      scopes?: unknown;
      lanes?: unknown;
      contours?: unknown;
      frame?: unknown;
      captured?: unknown;
      animation?: unknown;
    };
    if (data.type === CLIPBOARD_ANIM_TYPE) {
      const animation = parseAnimationCapture(data.animation);
      return animation ? { kind: "animation", animation } : null;
    }
    if (data.type === CLIPBOARD_PROPS_TYPE) {
      const cap = data.captured as CapturedProperties | undefined;
      return cap &&
        typeof cap === "object" &&
        cap.kind === "properties" &&
        typeof cap.domains === "object" &&
        cap.domains !== null
        ? { kind: "properties", captured: cap }
        : null;
    }
    if (data.type === CLIPBOARD_CONTOURS_TYPE) {
      // Contours travel WITHOUT identity — that is the whole reason they can
      // cross layers, documents and tabs. Ids are minted where they land.
      if (!Array.isArray(data.contours)) return null;
      const contours: Contour[] = [];
      for (const item of data.contours) {
        const parsed = contourSchema.safeParse(item);
        if (!parsed.success) return null;
        contours.push(parsed.data);
      }
      return contours.length > 0 ? { kind: "contours", contours } : null;
    }
    if (!Array.isArray(data.clips)) return null;
    const clips: Clip[] = [];
    for (const item of data.clips) {
      const parsed = clipSchema.safeParse(item);
      if (!parsed.success) return null;
      clips.push(parsed.data);
    }
    // `scopes` and `lanes` are the same shape — a clip id to a container id —
    // so they read the same way, and a clipboard written before either existed
    // simply arrives empty.
    const idMapOf = (raw: unknown): Record<string, string> => {
      const out: Record<string, string> = {};
      if (raw && typeof raw === "object") {
        for (const [id, to] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof to === "string") out[id] = to;
        }
      }
      return out;
    };
    const scopes: ClipScopes = idMapOf(data.scopes);
    const lanes: ClipLanes = idMapOf(data.lanes);
    if (data.type === CLIPBOARD_TYPE) {
      return clips.length > 0 ? { kind: "clips", clips, scopes, lanes } : null;
    }
    if (data.type === CLIPBOARD_FRAME_TYPE) {
      const frame = frameSchema.safeParse(data.frame);
      // Groups ride in `clips` — one schema validates the whole payload.
      return frame.success ? { kind: "frame", frame: frame.data, clips, scopes, lanes } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** In-memory fallback for browsers that gate clipboard read access. */
let memoryClipboard: string | null = null;

async function writeClipboard(payload: string): Promise<void> {
  memoryClipboard = payload;
  try {
    await navigator.clipboard.writeText(payload);
  } catch {
    // Memory clipboard still works within this tab.
  }
}

/**
 * Put contours on the REAL clipboard, so a copy in the node editor competes for
 * recency with every other copy instead of living in a private variable that
 * a later ⌘C could never override. It also makes them cross documents and tabs,
 * which a module-scoped array never could.
 */
export async function copyContours(contours: ReadonlyArray<Contour>): Promise<void> {
  if (contours.length === 0) return;
  await writeClipboard(JSON.stringify({ type: CLIPBOARD_CONTOURS_TYPE, contours }));
}

/**
 * Paste contours into whatever vector layer the context names, or into a new
 * one when it names none.
 *
 * The three cases are one rule — "the most specific vector target available":
 * the layer whose nodes you are editing, else a single selected path layer,
 * else a NEW path layer at the paste anchor (where the cursor is, matching the
 * drop-import convention every other paste already follows).
 *
 * Geometry goes in through `editPathGeometry`, the one write seam: it keeps the
 * pivot through the box change and mints ids for the bare contours. Assigning
 * `subpaths` directly is the bug it exists to prevent.
 */
function pasteContours(
  store: DocumentStore,
  contours: Contour[],
  opts: { frameId?: string },
): string | null {
  const session = useSession.getState();
  const doc = store.getState();
  const targetId = session.vectorEditClipId ?? (session.selectedClipIds.length === 1 ? session.selectedClipIds[0]! : null);
  const into = targetId ? locateClip(doc, targetId) : null;
  const label = `${contours.length} contour${contours.length > 1 ? "s" : ""}`;

  if (into?.clip.kind === "path") {
    store.update("Paste contours", (d) => {
      const clip = locateClip(d, into.clip.id)?.clip;
      if (clip?.kind !== "path") return;
      editPathGeometry(clip, (subs) => {
        for (const c of contours) subs.push(toSubpath(c));
      });
    });
    return label;
  }

  const anchor = getStagePasteAnchor();
  const frameId = opts.frameId ?? anchor?.frameId ?? session.activeFrameId;
  if (!frameId) return null;
  const clip = createPathClip({
    frameId,
    subpaths: contours,
    startMs: session.playheadMs,
    x: anchor?.x ?? 0,
    y: anchor?.y ?? 0,
    name: "Path",
  });
  store.update("Paste contours", (d) => placeClip(d, clip));
  session.select([clip.id]);
  return label;
}

/**
 * THE SELECTION AS CONTENT — what an operation that copies, deletes or moves
 * "what is selected" actually has to act on.
 *
 * Selecting a group selects the group CLIP, alone: that is what makes a group
 * one layer in the inspector, one transform on the stage, one bar on the
 * timeline, and what lets it carry a fill without touching its children. But a
 * copy of a group that brought no children is a copy of an empty container, and
 * a delete that removed only the carrier would strand its contents.
 *
 * So the widening happens HERE, once, at the boundary between "what is
 * selected" and "what this operation touches" — rather than being re-decided by
 * every op, which is how copy, cut, duplicate and ⌥-drag ended up with four
 * different answers between them.
 */
export function selectionContentIds(store: DocumentStore): string[] {
  return expandToDescendants(store.getState(), useSession.getState().selectedClipIds);
}

export async function copySelectedClips(store: DocumentStore, cut = false): Promise<number> {
  const selected = useSession.getState().selectedClipIds;
  if (selected.length === 0) return 0;
  // Stack order, top first, with each clip's lane and group row (`carryClips`):
  // a paste rebuilds the stack instead of landing clips in click order.
  const { clips, scopes, lanes } = carryClips(store.getState(), selected);
  if (clips.length === 0) return 0;

  await writeClipboard(JSON.stringify({ type: CLIPBOARD_TYPE, clips, scopes, lanes }));
  if (cut) deleteSelectedClips(store);
  // The COUNT is what the user selected, not what travelled with it — "3
  // layers" when you copied one group would be a lie about your own selection.
  return useSession.getState().selectedClipIds.length || clips.length;
}

/**
 * Unified copy/cut: layers when layers are selected, the whole frame (with
 * its layers) when a frame is. Returns a human description for the toast.
 */
export async function copySelection(store: DocumentStore, cut = false): Promise<string | null> {
  const session = useSession.getState();
  if (session.selectedClipIds.length > 0) {
    const n = await copySelectedClips(store, cut);
    return n > 0 ? `${n} layer${n > 1 ? "s" : ""}` : null;
  }
  if (session.selectedFrameIds.length > 0) {
    const doc = store.getState();
    // Clipboard carries one frame — copy the primary (last-selected) one.
    const primaryFrameId = session.selectedFrameIds[session.selectedFrameIds.length - 1];
    const frame = doc.frames.find((f) => f.id === primaryFrameId);
    if (!frame) return null;
    const clips = doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === frame.id);
    const scopes: ClipScopes = {};
    for (const track of doc.tracks) {
      if (!track.groupId) continue;
      for (const c of track.clips) if (c.frameId === frame.id) scopes[c.id] = track.groupId;
    }
    await writeClipboard(
      JSON.stringify({ type: CLIPBOARD_FRAME_TYPE, frame, clips, scopes }),
    );
    if (cut) deleteFrames(store, [frame.id], "Cut frame");
    return `frame “${frame.name}”`;
  }
  return null;
}

async function readClipboardText(): Promise<string | null> {
  let raw = memoryClipboard;
  try {
    const fromSystem = await navigator.clipboard.readText();
    if (
      [CLIPBOARD_TYPE, CLIPBOARD_FRAME_TYPE, CLIPBOARD_PROPS_TYPE, CLIPBOARD_ANIM_TYPE].some((t) =>
        fromSystem.includes(t),
      )
    ) {
      raw = fromSystem;
    }
  } catch {
    // Clipboard read blocked — use the in-memory copy.
  }
  return raw;
}

// ── Property transfer (copy/paste properties) ────────────────────────────────

/**
 * Copy a selection of property domains from a clip (see core property-transfer
 * — the ONE brain shared by the dialog, section menus and per-effect copy).
 * Returns the copied domain labels for the toast, or null when nothing landed.
 */
export async function copyProperties(
  store: DocumentStore,
  clipId: string,
  selection?: Record<string, true | string[]>,
  includeKeyframes = true,
  appendEffects = false,
): Promise<string[] | null> {
  const loc = locateClip(store.getState(), clipId);
  if (!loc) return null;
  const captured = captureProperties(
    loc.clip,
    { localMs: clipLocalClamped(loc.clip, useSession.getState().playheadMs), includeKeyframes },
    selection,
  );
  // A single-card copy pastes as APPEND on whichever stack it came from.
  if (appendEffects) {
    for (const id of ["effects", "textEffects"]) {
      const d = captured.domains[id];
      if (d) d.mode = "append";
    }
  }
  const labels = Object.keys(captured.domains).map((id) => propertyDomain(id)?.label ?? id);
  if (labels.length === 0) return null;
  await writeClipboard(JSON.stringify({ type: CLIPBOARD_PROPS_TYPE, captured }));
  return labels;
}

// ── Animation transfer (one edge's animation, copied) ────────────────────────

/**
 * Put ONE animation on the clipboard — a layer edge's or a text phase's — as
 * the grain-free capture core defines, so it can land on any edge that takes
 * the preset. Same transport as clips and properties: the system clipboard
 * when allowed, this tab's memory otherwise.
 */
export async function copyAnimation(animation: AnimationCapture): Promise<void> {
  await writeClipboard(JSON.stringify({ type: CLIPBOARD_ANIM_TYPE, animation }));
}

/** The animation on the clipboard, if that is what it holds. */
export async function readAnimation(): Promise<AnimationCapture | null> {
  const raw = await readClipboardText();
  const payload = raw ? parseClipboardPayload(raw) : null;
  return payload?.kind === "animation" ? payload.animation : null;
}

/** What the clipboard offers as a property source: a capture, or a whole clip. */
export type PropertySource =
  | { kind: "captured"; captured: CapturedProperties }
  | { kind: "clip"; clip: Clip };

export async function readPropertySource(): Promise<PropertySource | null> {
  const raw = await readClipboardText();
  const payload = raw ? parseClipboardPayload(raw) : null;
  if (!payload) return null;
  if (payload.kind === "properties") return { kind: "captured", captured: payload.captured };
  // Contours and a lone animation carry no clip to read properties off.
  if (payload.kind === "contours" || payload.kind === "animation") return null;
  const clip = payload.clips[0];
  return clip ? { kind: "clip", clip } : null;
}

/**
 * Apply captured domains to the selected clips (or `clipIds`). One undo step;
 * returns a toast description or null when nothing matched.
 */
export function applyCapturedToSelection(
  store: DocumentStore,
  captured: CapturedProperties,
  domainIds?: string[],
  clipIds?: string[],
): string | null {
  const ids = clipIds ?? useSession.getState().selectedClipIds;
  const doc = store.getState();
  const targets = ids.map((id) => locateClip(doc, id)?.clip).filter((c) => c !== undefined);
  if (!targets.some((c) => applicableDomains(captured, c).length > 0)) return null;

  const labels = new Set<string>();
  store.update("Paste properties", (d) => {
    for (const id of ids) {
      const loc = locateClip(d, id);
      if (!loc) continue;
      for (const label of applyProperties(loc.clip, captured, domainIds)) labels.add(label);
    }
  });
  return labels.size > 0 ? `properties (${[...labels].join(", ")})` : null;
}

/**
 * Section-scoped paste: apply ONLY the given domain from the clipboard (a
 * property capture or a whole copied layer) to one clip — or to every clip of
 * a multi-selection, which is the same paste landing N times in one step.
 */
export async function pastePropertiesDomain(
  store: DocumentStore,
  clipId: string | string[],
  domainIds: string[],
): Promise<string | null> {
  const source = await readPropertySource();
  if (!source) return null;
  const captured =
    source.kind === "captured"
      ? source.captured
      : captureProperties(source.clip, {
          localMs: clipLocalClamped(source.clip, useSession.getState().playheadMs),
          includeKeyframes: true,
        });
  return applyCapturedToSelection(store, captured, domainIds, Array.isArray(clipId) ? clipId : [clipId]);
}

/**
 * Where a paste of NEW media lands: under the cursor when it's over the stage
 * (the same anchor a drop would use), otherwise the centre of the frame you're
 * focused on. Mirrors the drop-import target so paste and drop are identical.
 */
function resolveMediaPasteTarget(store: DocumentStore, opts: { frameId?: string }): ImportTarget {
  const doc = store.getState();
  const session = useSession.getState();
  const frameIds = new Set(doc.frames.map((f) => f.id));
  const anchor = getStagePasteAnchor();
  if (anchor && frameIds.has(anchor.frameId)) {
    return { frameId: anchor.frameId, startMs: session.playheadMs, x: anchor.x, y: anchor.y, placement: {} };
  }
  const frameId =
    (opts.frameId && frameIds.has(opts.frameId) && opts.frameId) ||
    (session.activeFrameId && frameIds.has(session.activeFrameId) && session.activeFrameId) ||
    ensureContentFrame(store).id;
  return { frameId, startMs: session.playheadMs, x: 0, y: 0, placement: {} };
}

/**
 * The media half of paste: if the clipboard holds importable files (a copied
 * image / screenshot, or — on the desktop shell — OS file copies), import them
 * at the cursor exactly like a drop and report how many landed. Returns 0 when
 * there's no media, so ⌘V falls through to the JSON-clip / properties paste.
 * Never throws — a blocked or empty clipboard just yields 0.
 */
async function pasteClipboardMedia(store: DocumentStore, opts: { frameId?: string }): Promise<number> {
  let appFiles: AppFile[];
  try {
    appFiles = await platform.clipboard.readFiles();
  } catch {
    return 0;
  }
  if (appFiles.length === 0) return 0;

  const files = await appFilesToFiles(appFiles);
  // Dynamic imports keep clip-actions ⇄ assets/import free of an eval-time cycle.
  const [{ importDroppedFiles, isSliceFile }, { assetKindForFile }] = await Promise.all([
    import("../io/slice-file"),
    import("../assets/import"),
  ]);
  // Only claim the paste when there's something we can actually import; anything
  // else (a copied .txt, etc.) falls through to the JSON-clip / text paste.
  const importable = files.filter((f) => assetKindForFile(f) !== null || isSliceFile(f));
  if (importable.length === 0) return 0;

  const target = resolveMediaPasteTarget(store, opts);

  // importDroppedFiles routes slice files too, so pasting a copied
  // project file behaves like dropping one — a superset of plain media import.
  // Data frames land on the target frame's page, at the same anchor point.
  const doc = store.getState();
  const frame = doc.frames.find((f) => f.id === target.frameId);
  const pageId = frame?.pageId ?? doc.pages[0]?.id ?? null;
  const world = frame
    ? { x: frame.x + frame.width / 2 + (target.x ?? 0), y: frame.y + frame.height / 2 + (target.y ?? 0) }
    : null;

  await importDroppedFiles(store, importable, {
    media: target,
    data: pageId && world ? { onPage: { pageId, world } } : undefined,
  });
  return importable.length;
}

export async function pasteClipboard(
  store: DocumentStore,
  opts: { frameId?: string } = {},
): Promise<string | null> {
  // Media on the clipboard wins when present: a copied image / screenshot / OS
  // file imports at the cursor and short-circuits the text-payload path below.
  // importDroppedFiles toasts its own "Imported N" so we return null (no double
  // toast) while still signalling the caller that paste did something.
  const pastedMedia = await pasteClipboardMedia(store, opts);
  if (pastedMedia > 0) return null;

  const raw = await readClipboardText();
  if (!raw) return null;

  const payload = parseClipboardPayload(raw);
  if (!payload) return null;
  const session = useSession.getState();

  // ⌘V with copied PROPERTIES lands them on whatever is selected.
  if (payload.kind === "properties") {
    return applyCapturedToSelection(store, payload.captured);
  }

  if (payload.kind === "contours") {
    return pasteContours(store, payload.contours, opts);
  }

  // ⌘V with a copied ANIMATION lands it as the ENTRANCE of every selected
  // layer that takes the preset. The Animate tab's own paste (per edge, per
  // text phase) is the precise door; this is the broad one.
  if (payload.kind === "animation") {
    const ids = session.selectedClipIds;
    let landed = 0;
    store.update("Paste animation", (d) => {
      for (const id of ids) {
        const loc = locateClip(d, id);
        if (!loc || loc.clip.kind === "audio") continue;
        const spec = toLayerAnimation(payload.animation, layerPresetsFor(d, loc.clip));
        if (!spec) continue;
        loc.clip.animIn = spec;
        landed++;
      }
    });
    return landed ? `animation onto ${landed} layer${landed > 1 ? "s" : ""}` : null;
  }

  if (payload.kind === "frame") {
    // A COMPONENT frame pastes as a LINKED INSTANCE FRAME — the same top-level
    // linked copy you get from duplicate / alt-drag (frame-level instancing), so
    // every way of copying a component behaves identically and stays in sync.
    // Falls through to a plain frame paste only if the definition is gone (cut,
    // or a cross-document paste).
    const docNow = store.getState();
    if (
      payload.frame.component &&
      docNow.frames.some((f) => f.id === payload.frame.id && isComponentFrame(f))
    ) {
      const linkedId = createId("frame");
      const rightEdge = Math.max(...docNow.frames.map((f) => f.x + f.width));
      store.update("Paste instance", (d) => {
        d.frames.push({
          ...payload.frame,
          id: linkedId,
          x: rightEdge + 120,
          component: null,
          instanceOf: payload.frame.id,
        });
      });
      session.selectFrame(linkedId);
      return `instance of “${payload.frame.name}”`;
    }

    const newFrameId = createId("frame");
    const rightEdge = Math.max(...store.getState().frames.map((f) => f.x + f.width));
    store.update("Paste frame", (d) => {
      d.frames.push({ ...payload.frame, id: newFrameId, x: rightEdge + 120 });
      // The artboard's whole contents, at their own times, on fresh lanes.
      const earliest = Math.min(...payload.clips.map((c) => c.startMs));
      pasteCarry(d, payload, { frameId: newFrameId, startMs: earliest, place: () => ({}) });
    });
    session.selectFrame(newFrameId);
    return `frame “${payload.frame.name}”`;
  }

  const clips = payload.clips;
  const doc = store.getState();
  const frameIds = new Set(doc.frames.map((f) => f.id));
  // Paste follows focus: the selected clip's track is where you "are".
  const focusLoc = session.selectedClipIds[0] ? locateClip(doc, session.selectedClipIds[0]) : null;
  // Paste lands in the frame you're FOCUSED on, in priority: an explicit target
  // (right-click a frame) → the selected layer's frame ("where you clicked") →
  // the active frame → the first frame. Clips always re-base onto it, so copying
  // from one frame and pasting into another drops them where you are, not back
  // in the origin frame.
  const target =
    (opts.frameId && frameIds.has(opts.frameId) && opts.frameId) ||
    (focusLoc && focusLoc.clip.frameId) ||
    (session.laneSpot && frameIds.has(session.laneSpot.frameId) && session.laneSpot.frameId) ||
    (session.activeFrameId && frameIds.has(session.activeFrameId) && session.activeFrameId) ||
    ensureContentFrame(store).id;

  // Keep relative timing; land the earliest clip at the playhead.
  const created: string[] = [];

  store.update(clips.length > 1 ? "Paste clips" : "Paste clip", (d) => {
    /*
     * WHERE A PASTE LANDS: above the selected layer (in front), on the lane
     * you pressed — the same unified rule new layers use — but falling back
     * to a RESTORE rather than a birth.
     *
     * Two facts make a paste different from a new layer. It has a home: it
     * came off a lane, and putting it back there is what "paste beside it"
     * plainly means. And when that home is gone or busy, it wants any lane
     * with room, not a fresh one — a birth mints a lane so the thing you
     * just made is on top of everything, and a paste has nothing to reveal.
     * Minting was why copying a clip, moving the playhead along and pasting
     * built a new track every single time on a project whose top lane was
     * busy.
     */
    created.push(
      ...pasteCarry(d, payload, {
        frameId: target,
        startMs: session.playheadMs,
        place: (dd, copy, source) => ({ ...placeAboveSelection(dd, copy), homeTrackId: payload.lanes[source.id], landing: "reuse" }),
      }).created,
    );
  });
  if (created.length > 0) session.select(created);
  return created.length > 0 ? `${created.length} layer${created.length > 1 ? "s" : ""}` : null;
}


/**
 * Close the selected gap — Premiere's click-the-hole-and-press-Delete.
 *
 * The gap's times are re-read from the document here rather than trusted from
 * the selection, because a gap is derived: an undo, a trim or a drag elsewhere
 * can have changed its size since it was picked, and shifting the lane by a
 * stale delta would tear the edit apart. If the hole is gone, so is the edit.
 */
export function closeSelectedGap(store: DocumentStore): void {
  const session = useSession.getState();
  const picked = session.laneSpot;
  if (!picked) return;
  const live = gapAt(store.getState(), picked.trackId, picked.frameId, picked.startMs);
  if (!live) {
    session.setLaneSpot(null);
    return;
  }
  let ok = false;
  store.update("Close gap", (d) => {
    ok = closeGap(d, live);
  });
  if (!ok) toast("Nothing to pull back — a locked clip is holding the lane");
  session.setLaneSpot(null);
}

/** Pack a whole lane up against the start — every hole on it, in one step. */
export function closeAllGapsOnTrack(store: DocumentStore, trackId: string, frameId: string): void {
  let ok = false;
  store.update("Close gaps", (d) => {
    ok = closeAllGaps(d, trackId, frameId);
  });
  if (!ok) toast("No gaps on this track");
  useSession.getState().setLaneSpot(null);
}
