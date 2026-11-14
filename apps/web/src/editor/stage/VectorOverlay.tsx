"use client";

import { cursors, resizeCursor } from "@solomotion/ui/cursors";
import { applyBend, beginBend, type BendGrab } from "@solomotion/core";
import { currentMods, gestureMods, subscribeMods } from "../input/modifiers";
import * as React from "react";
import { createPortal } from "react-dom";
import {
  NODE_VERBS,
  runNodeVerb,
  type NodeVerbId,
  type NodeVerbResult,
  alignNodes,
  anchorAtSite,
  breakAtNode,
  copySubpaths,
  lendIdentity,
  newContourId,
  nodeKey,
  resolveNode,
  type Contour,
  segmentOf,
  knifeSubpaths,
  mirrorHandles,
  translateNodes,
  reflowAroundNodes,
  pageOfFrame,
  createPathClip,
  solidPaint,
  strokeStyle,
  editPointHandlesFromAnchor,
  beginTangentDrag,
  resolveTangentDrag,
  type TangentDragStart,
  constrainDragToAngle,
  deleteClip,
  insertPointOnSegment,
  isOpenEnd,
  locateClip,
  mergeSnapCandidates,
  nodeSnapLines,
  openEndpoints,
  pathCommands,
  cornerBearing,
  edgeBearing,
  penMark,
  type PenMark,
  penIntent,
  penIntentHint,
  penIntentLanding,
  deleteNodes as deletePathNodes,
  weldGroup,
  weldIdAt,
  pickPenLanding,
  reverseSubpaths,
  weldRun,
  snapPoint,
  snapPointOnRay,
  subpathBounds,
  type NodeAlign,
  type NodeRef,
  type PenCandidate,
  type PenIntent,
  type PenLanding,
  type PenSite,
  type SnapLine,
  propertyHasKeys,
  sampleKeyframes,
  clipBox,
  editPathGeometry,
  isGeometryValue,
  promotePathClip,
  scopeKey,
  type ScopeAddress,
  pathBox,
  setKeyframe,
  setPathGeometry,
  anchorLocal,
  mapLinear,
  mapLocal,
  unmapLinear,
  type LayerBasis,
  translateSubpaths,
  type MotionDocument,
  type Frame,
  type PathClip,
  type PathPoint,
  type Subpath,
} from "@solomotion/core";
import { animWriteMode, commitProperty } from "../inspector/animatable";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useDocStore } from "../state/document-context";
import { nudgeTargets } from "./nudge-target";
import { stageHitRects } from "./stage-geometry";
import { frameSpace, layerPlacement, layerSpace, standingFrameId } from "./edit-space";
import { copyContours, placeAboveSelection } from "../state/clip-actions";
import { placeClip } from "@solomotion/core";
import { useSession, useStageView, type UndoScope } from "../state/session";
import { consumeRegionDraw } from "./region-draw";
import "../color/window-draw";
import "../tracking/track-draw";
import { useToolDefaults } from "../state/tool-defaults";
import { commandsToPath2D } from "./render/draw-frame";
import { frameSnapCandidates, frameVectorNodesWorld } from "./stage-snap";
import { drawSnapLines } from "./scene-chrome";
import { usePenBar, usePublishPenBar, type PenAction, type PenToolbarCtx } from "./pen-bar";
import { PenJunctionPrompt } from "./PenJunctionPrompt";
import { TOOL_ACCENT } from "./Toolbar";
import {
  PATH_HIT,
  cubicAt,
  paintAnchor,
  paintDirectionChevrons,
  paintCursorHint,
  paintInsertBadge,
  paintPenTarget,
  paintTangent,
  passedDragLatch,
} from "./path-chrome";
import { capturePointer } from "../input/capture-pointer";
import { actForTool } from "../input/pointer-authority";
import { subscribePointerEnd } from "../input/pointer-gestures";
import { useTouchIntent } from "../input/use-touch-intent";
import { eventKey } from "../state/shortcut-registry";
import { isTypingTarget } from "../input/typing-target";

/**
 * The vector interaction layer: pen-tool drafting and path node editing.
 * A transparent canvas above the stage that owns the pointer only while the
 * pen tool is armed or a path is in node-edit mode — the rest of the time it
 * doesn't exist. Wheel events fall through to the stage's pan/zoom.
 *
 * Conventions (Figma):
 *  pen     click = corner · drag = smooth (mirrored handles) · ⌥ while
 *          dragging breaks the mirror · click the first point closes ·
 *          ↵ / double-click commits open · esc cancels
 *  edit    drag anchors to move · drag a handle to steer BOTH mirrored
 *          handles · ⌥ moves one side alone · ⌥-drag an anchor pulls fresh
 *          handles out of a corner · double-click an anchor toggles
 *          corner/smooth · ⌫ deletes selected anchors · esc exits
 */

// Grab radii come from the shared path-chrome kit, so the pen and motion paths
// cannot drift into feeling different from each other.
const ANCHOR_HIT = PATH_HIT.anchor;
const CLOSE_HIT = PATH_HIT.closeTarget;
const BOX_HANDLE_HIT = 8;

/** The mark the pen wears for what a click would do. */
const PEN_CURSOR: Record<PenMark, string> = {
  none: cursors.pen,
  add: cursors.penAdd,
  join: cursors.penJoin,
  close: cursors.penClose,
  continue: cursors.penContinue,
};

type Pt = { x: number; y: number };

/** Bend is the latched mode, or ⌘ held momentarily (keyboard or touch puck). */
const bendArmed = (): boolean => usePenBar.getState().mode === "bend" || currentMods().meta;
/** The 8 resize grips of a selection box (Figma order). */
type BoxHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
/** The grip that stays FIXED while dragging its counterpart (the resize anchor). */
const OPPOSITE_HANDLE: Record<BoxHandle, BoxHandle> = {
  nw: "se",
  n: "s",
  ne: "sw",
  e: "w",
  se: "nw",
  s: "n",
  sw: "ne",
  w: "e",
};
/** Which axes a handle drives (corners = both; edges = one). */
const HANDLE_AXES: Record<BoxHandle, { x: boolean; y: boolean }> = {
  nw: { x: true, y: true },
  n: { x: false, y: true },
  ne: { x: true, y: true },
  e: { x: true, y: false },
  se: { x: true, y: true },
  s: { x: false, y: true },
  sw: { x: true, y: true },
  w: { x: true, y: false },
};

/**
 * The point clipboard (module-level, like the app clipboard): copied anchors
 * grouped into subpaths. A subpath stays closed only when ALL its points were
 * copied; partial selections paste as open runs.
 */
// The node clipboard carries GEOMETRY, not layer membership: a copied run
// survives a paste into a DIFFERENT vector layer, where the part it came from
// means nothing. Paste mints a part of its own on arrival.
let pointClipboard: Contour[] | null = null;

interface DraftState {
  frame: Frame;
  points: PathPoint[];
}

type EditDrag =
  // `start` (anchor + pointer in local space, captured on press) lets a ⇧-drag
  // constrain the move to a snapped axis via the shared constrainDragToAngle.
  | { kind: "anchor"; sub: number; index: number; start: { ax: number; ay: number; px: number; py: number } }
  // `drag` is what the shared tangent brain froze on press — whether the pair was
  // balanced. Re-reading it mid-drag would be circular: the drag is the thing
  // changing it, so ⌥-balancing a broken pair would flip the answer instantly.
  | { kind: "handle"; sub: number; index: number; side: "hIn" | "hOut"; drag: TangentDragStart }
  // ⌘-drag on a segment (D12): the curve bends through the pointer. `grab` is
  // the segment frozen at press — the solver always works from it, never from
  // the previous move, so a long drag cannot drift.
  | { kind: "bend"; sub: number; index: number; grab: BendGrab }
  | null;

/**
 * A pen stroke resolved onto existing geometry, with every coordinate already
 * frozen in the space the mutation needs — so answering "connect?" later cannot
 * be affected by the cursor having moved on, and the two answers stay two
 * branches of one function rather than two features.
 */
interface LandingPlan {
  /** The clip the stroke landed on. */
  targetClipId: string;
  /** Where on that clip — an existing anchor, or a curve that becomes one. */
  site: PenSite;
  /** WORLD position of the site: where the node goes when NOT connecting. */
  world: Pt;
  /** VIEWPORT position of the site — where the prompt and its chrome sit. */
  client: Pt;
  /** Where the stroke being drawn currently lives — the three states of one
   *  machine: not a clip yet, appending to a run, or seeded on a node whose
   *  branch has not been spawned. */
  from:
    | { kind: "draft" }
    | { kind: "extend"; clipId: string; sub: number; end: "head" | "tail" }
    | { kind: "branch"; clipId: string; seedLocal: Pt; seedRef: NodeRef };
}

/** What the pen resolved under the cursor: the intent, and the geometry it names. */
interface PenResolution {
  intent: PenIntent;
  /** The clip the landing belongs to — null when the intent names no geometry. */
  target: { clip: PathClip; frame: Frame } | null;
  /** Screen position of the landing site (chrome anchors here, not at the cursor). */
  screen: Pt | null;
}

export function VectorOverlay() {
  // Reads the live stage — drag state, edit spaces, pointer geometry — every
  // render, outside React, by design. Memoising it would freeze the overlay.
  "use no memo";
  const store = useDocStore();
  const tool = useSession((s) => s.tool);
  const editClipId = useSession((s) => s.vectorEditClipId);
  const active = tool === "pen" || tool === "cut" || editClipId !== null;

  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const draftRef = React.useRef<DraftState | null>(null);
  /** Points popped by undo while drawing a NEW path, kept for redo. The
   *  committed clip's edits use the doc store's own history; only the in-flight
   *  draft (not yet in the doc) needs this tiny local stack so undo removes the
   *  LAST PLACED NODE instead of some earlier, unrelated document action. */
  const draftRedoRef = React.useRef<PathPoint[]>([]);
  /**
   * THE DRAFT IS AN UNDO SCOPE while it exists — the same seam the Brush
   * Studio uses, so every entry point history has (⌘Z, the rail, the palette,
   * the app menu, a two-finger tap on the glass) pops the last pen point
   * instead of undoing some earlier document action underneath a half-drawn
   * path. It used to be a private capture-phase ⌘Z in this file, which was one
   * entry point out of five and the only one that knew.
   *
   * `setDraft` is the ONE writer of the draft: the scope is claimed on the
   * first point and released on commit, cancel or unmount, and cannot be
   * forgotten by a site that set the ref directly.
   */
  const draftScope = React.useRef<UndoScope>({
    undo: () => {
      const d = draftRef.current;
      const pt = d?.points.pop();
      if (!d || !pt) return false;
      draftRedoRef.current.push(pt);
      if (d.points.length === 0) setDraft(null);
      penDragRef.current = null;
      dirtyRef.current = true;
      return true;
    },
    redo: () => {
      const d = draftRef.current;
      const pt = draftRedoRef.current.pop();
      if (!d || !pt) return false;
      d.points.push(pt);
      dirtyRef.current = true;
      return true;
    },
  }).current;
  function setDraft(next: DraftState | null): void {
    draftRef.current = next;
    if (!next) draftRedoRef.current = [];
    const session = useSession.getState();
    if (next) {
      if (session.undoScope !== draftScope) session.setUndoScope(draftScope);
    } else if (session.undoScope === draftScope) session.setUndoScope(null);
  }
  React.useEffect(() => () => setDraft(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const hoverRef = React.useRef<{ x: number; y: number } | null>(null);
  const altHeldRef = React.useRef(false);
  /** ⇧ held (tracked live) — constrains the pending pen segment's direction to a
   *  snapped angle from the previous anchor, the SAME rule node/layer drags use. */
  const shiftRef = React.useRef(false);
  /** ⌘/Ctrl held (tracked live) — flips the section box from morph (dashed) to
   *  object-scale (solid), the same native-vs-scale rule shapes use. */
  const modRef = React.useRef(false);
  /** Smart-guide lines (world space) flashed while a point snaps — drawn in the
   *  loop, cleared on release. Same visual the stage layer drag shows. */
  const snapGuidesRef = React.useRef<{ v: SnapLine[]; h: SnapLine[] }>({ v: [], h: [] });
  /**
   * While pressing a fresh pen point: drag pulls handles out of it. Targets
   * either the uncommitted `draft` array or a live point of an extended clip.
   *
   * `startScreen`/`latched` are the CLICK-vs-DRAG latch. Until the pointer has
   * travelled `PATH_HIT.dragLatch` screen px the press writes nothing at all and
   * the point stays the hard corner you asked for; once it has, the drag is
   * committed for the rest of the press and steering stays continuous. The old
   * test — a 1.5 CLIP-LOCAL-unit distance, re-checked every single move — made
   * this twitchy in both directions: at ordinary zoom a 1px tremor was already
   * past it, so points came out faintly curved, and steering back inside the
   * radius silently stopped tracking.
   */
  type PenDrag = { startScreen: Pt; latched: boolean } & (
    | { kind: "draft"; index: number }
    | { kind: "extend"; clipId: string; sub: number; index: number }
  );
  const penDragRef = React.useRef<PenDrag | null>(null);
  /**
   * Continue-drawing an EXISTING open path: the pen is appending to (or
   * prepending to) one subpath of an already-committed clip. `end` picks the
   * live end — `tail` appends, `head` prepends (its live point is always index
   * 0, the run's start is the last index). Stays set across clicks until the
   * path is closed or Esc, so drawing continues indefinitely.
   */
  const extendRef = React.useRef<{ clipId: string; sub: number; end: "head" | "tail" } | null>(null);
  /** The Cut tool's knife stroke while the pointer is held: a straight line from
   *  `start` to the cursor. A plain click (never `moved`) cuts one point; a drag
   *  slices EVERY vector the line crosses on release. `frameId` scopes which
   *  frame's paths get cut. */
  const knifeRef = React.useRef<{ start: Pt; frameId: string | null; moved: boolean } | null>(null);
  /**
   * After the pen adds a point ON a segment (mid-path, so not an endpoint you
   * can extend), the NEXT click should still "keep drawing from that new point."
   * We can't extend a mid node, so we branch a fresh run out of it: this holds
   * the seed (that point's local pos) until the next click spawns the branch.
   */
  const penBranchRef = React.useRef<{ clipId: string; seedLocal: Pt; seedRef: NodeRef } | null>(null);
  /**
   * A stroke that ENDED on another path, frozen until the "connect or keep
   * apart?" question is answered. Nothing has been written to the document while
   * this is set — which is the point: both answers are a single forward
   * operation, so neither needs an inverse and either lands as one undo step.
   */
  const landingRef = React.useRef<LandingPlan | null>(null);
  const [junctionAt, setJunctionAt] = React.useState<Pt | null>(null);
  /**
   * A transform-box gesture on the current node selection (a "section"). Reuses
   * the SAME resize-around-a-fixed-anchor model shapes use — but by default it
   * MORPHS the node positions (native geometry), and with ⌘ held it object-scales
   * the whole clip's transform instead. Snapshotting the start state keeps the
   * scale stable (no compounding).
   */
  const sectionDragRef = React.useRef<{
    mode: "resize" | "move";
    clipId: string;
    handle: BoxHandle | null;
    canObjectScale: boolean;
    boundsLocal: { minX: number; minY: number; maxX: number; maxY: number };
    anchorLocal: Pt;
    startPointerLocal: Pt;
    startNodes: Array<{ key: string; x: number; y: number; hIn: Pt | null; hOut: Pt | null }>;
    startTransform: LayerBasis & { x: number; y: number };
    fixedWorld: Pt;
    moved: boolean;
  } | null>(null);
  const editDragRef = React.useRef<EditDrag>(null);
  /** Empty-space drag in edit mode: rubber-band select points. */
  const marqueeRef = React.useRef<{
    start: { x: number; y: number };
    current: { x: number; y: number };
    additive: boolean;
    base: Set<string>;
  } | null>(null);
  const [selectedNodes, setSelectedNodesRaw] = React.useState<Set<string>>(new Set());
  /** The junction preference, subscribed so the toolbar and the prompt track it. */
  const junction = useToolDefaults((s) => s.penJunction);
  const [pointMenu, setPointMenu] = React.useState<{ x: number; y: number; key: string | null } | null>(null);
  const dirtyRef = React.useRef(true);

  // ── Coordinate helpers ─────────────────────────────────────────────────────

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const toWorld = (p: { x: number; y: number }) => {
    const v = useStageView.getState();
    return { x: (p.x - v.tx) / v.scale, y: (p.y - v.ty) / v.scale };
  };
  const worldToScreen = (w: { x: number; y: number }) => {
    const v = useStageView.getState();
    return { x: v.tx + w.x * v.scale, y: v.ty + w.y * v.scale };
  };

  const editClip = (): { clip: PathClip; frame: Frame } | null => {
    const id = useSession.getState().vectorEditClipId;
    if (!id) return null;
    const doc = store.getState();
    const loc = locateClip(doc, id);
    if (loc?.clip.kind !== "path") return null;
    const frame = doc.frames.find((f) => f.id === loc.clip.frameId);
    return frame ? { clip: loc.clip, frame } : null;
  };

  /**
   * The edited clip's LayerBasis at the playhead — pose keys, resolved scaleY,
   * shear and the normalized PIVOT with the box it is a fraction of.
   *
   * The overlay used to carry a hand-rolled `{scale, scaleY, rotation}` and do
   * its own scale-then-rotate arithmetic. That was a second implementation of
   * the layer map, so it did not know about the pivot (or the shear): move a
   * pivot and every node, handle and hit-target on the pen tool slid off the
   * art it belonged to. It now speaks the one map in core, so a node is where
   * the renderer draws it by construction, not by two files agreeing.
   */
  const editBasis = (clip: PathClip): LayerBasis & { x: number; y: number } => {
    const local = Math.min(
      Math.max(0, useSession.getState().playheadMs - clip.startMs),
      clip.durationMs,
    );
    const kf = sampleKeyframes(clip.keyframes, local);
    const n = (k: string, d: number) => (typeof kf[k] === "number" ? (kf[k] as number) : d);
    const t = clip.transform;
    const scale = Math.max(0.0001, n("scale", t.scale));
    const size = clipBox(store.getState(), clip);
    return {
      x: n("x", t.x),
      y: n("y", t.y),
      scale,
      // scaleY mirrors scale when null (locked aspect) — the SAME rule the
      // renderer and the stage use, so a non-uniformly resized vector's nodes
      // render where they actually are.
      scaleY: Math.max(0.0001, t.scaleY == null ? scale : n("scaleY", t.scaleY)),
      rotation: n("rotation", t.rotation),
      skewX: n("skewX", t.skewX),
      skewY: n("skewY", t.skewY),
      anchor: { x: n("anchor.x", t.anchor.x), y: n("anchor.y", t.anchor.y) },
      size,
    };
  };

  /**
   * The basis a node is DRAWN with: the clip's own pose times everything
   * enclosing it (`layerPlacement` — comp hops and groups alike).
   *
   * `clipOrigin` anchors the node cloud on the renderer's own hit rect, so its
   * CENTRE has always been right at any depth. Its SPREAD came from the clip's
   * bare transform, so inside a scaled or rotated container the nodes sat the
   * right distance apart for a container that was not there — correct centre,
   * wrong shape, which is the hardest version of this bug to describe and the
   * one that reads as "the handles are just wrong".
   */
  const screenBasis = (clip: PathClip) => {
    const b = editBasis(clip);
    const place = layerPlacement(clip.id);
    return {
      ...b,
      scale: b.scale * place.scaleX,
      scaleY: b.scaleY * place.scaleY,
      rotation: b.rotation + place.rotation,
    };
  };
  /** Back-compat shape for the resize gesture, which scales a start snapshot. */
  const editPose = (clip: PathClip) => editBasis(clip);

  /**
   * The world point the clip's geometry hangs off, and the geometry centre that
   * point corresponds to.
   *
   * Read from `stageHitRects` — what the renderer ACTUALLY painted — instead of
   * re-derived from `frame.x/y + pose`. That re-derivation is wrong whenever the
   * content isn't painted at its own frame's coordinates: a nested comp edited
   * in place is drawn through the parent's `worldOffset` while its frame sits
   * off-page on the shelf, so every node landed hundreds of units from the art.
   * Anchoring to the painted box makes the overlay correct for nesting,
   * instances and world offsets by construction — and the PIVOT drops out of the
   * arithmetic entirely, since both sides of the subtraction carry it.
   */
  const clipOrigin = (clip: PathClip, frame: Frame) => {
    // TWO bases, because they answer two questions. `bLocal` is the clip's own
    // pose, which is what places its centre inside its comp; `b` is that pose
    // as SEEN, with every enclosing comp and group folded in, which is what
    // maps a node offset to and from world. Returning the local one for both —
    // as this did — is why nodes inside a scaled container spread wrong.
    const bLocal = editBasis(clip);
    const b = screenBasis(clip);
    // The centre of the outline ON SCREEN — sampled when geometry keys own it,
    // exactly like the renderer's hit rect, which is what `hit.cx/cy` below IS.
    // (The PIVOT box in `b` stays the clip's declared one; these are different
    // questions, and answering both with one box is what made a morphing path's
    // nodes float off its art.)
    const local = Math.min(
      Math.max(0, useSession.getState().playheadMs - clip.startMs),
      clip.durationMs,
    );
    const sampledGeo = sampleKeyframes(clip.keyframes, local)["geometry"];
    const outline = Array.isArray(sampledGeo) ? (sampledGeo as Subpath[]) : clip.subpaths;
    const gb = pathBox(outline);
    const geo = { x: gb.cx, y: gb.cy };
    const hit = stageHitRects.current.find((h) => h.clipId === clip.id);
    if (hit) return { b, geo, wx: hit.cx, wy: hit.cy };
    // Not painted this frame (scrubbed off its range): place it through the
    // frame's own chain — the same answer the renderer would have produced had
    // it drawn, and correct at any nesting depth.
    const o = mapLocal(geo.x, geo.y, bLocal);
    // `layerSpace`, not the frame's: a clip that is not painted this instant is
    // still INSIDE whatever groups hold it, and the fallback has to agree with
    // the hit rect it stands in for.
    const at = { x: bLocal.x + o.x, y: bLocal.y + o.y };
    const w = layerSpace(clip.id)?.toWorld(at) ?? frameLocalToWorld(at, frame);
    return { b, geo, wx: w.x, wy: w.y };
  };

  /**
   * A node key resolved against a clip's CURRENT geometry.
   *
   * Keys name a CONTOUR ID, not a position in `subpaths`, so a selection made
   * before a split/join/cut/paste still names the same anchors afterwards
   * instead of silently pointing at whatever moved into that slot. Resolution
   * returns null once the contour is gone — the honest answer, and the reason
   * every caller stopped having to guess.
   */
  const parseKey = (clip: PathClip | null | undefined, key: string): NodeRef | null => {
    if (!clip) return null;
    const at = resolveNode(clip, key);
    return at ? { sub: at.subIndex, index: at.index } : null;
  };

  /** The stable key for a node ref — the inverse of `parseKey`. */
  const keyOf = (clip: PathClip, ref: { sub: number; index: number }): string =>
    nodeKey(clip.subpaths[ref.sub]?.id ?? "", ref.index);

  /** A set of node keys as core `NodeRef`s against THIS geometry — keys that no
   *  longer resolve (a contour deleted under the selection) simply drop out. */
  const refsOf = (clip: PathClip, keys: Iterable<string>): NodeRef[] =>
    [...keys].map((k) => parseKey(clip, k)).filter((r): r is NodeRef => r !== null);

  /**
   * Selecting one arm of a junction selects the junction.
   *
   * A weld means those points ARE one node, so expanding HERE — once, at the
   * only place a selection is set — is what lets every op that reads the
   * selection (drag, nudge, align, delete, the section box) act on the whole
   * node without any of them knowing welds exist. Teaching each of them
   * separately is how a junction comes apart under the one op somebody forgot.
   */
  // Publish the selection for surfaces outside the canvas (the inspector's
  // Corners row scopes to it). One-way: this is the owner, that is a mirror.
  React.useEffect(() => {
    useSession.getState().setVectorNodeSelection([...selectedNodes].sort());
  }, [selectedNodes]);

  /**
   * Point the SIDEBAR at the contour you have selected.
   *
   * Selecting a piece with the pen is the "go into one of them" step: the
   * inspector shows what that piece currently looks like (inherited from its
   * layer) and any field you touch writes an override for that piece alone —
   * the same contract a text range already has, addressed the same way
   * (`ScopeAddress`), so no paint control learns that contours exist.
   *
   * ONE contour, or nothing. A selection spanning two pieces has no single
   * thing to override, and showing one piece's value while editing both is the
   * lie this refuses to tell — so it falls back to the layer, which is the
   * honest subject of a multi-piece selection.
   */
  React.useEffect(() => {
    const session = useSession.getState();
    const clip = editClip()?.clip;
    const subs = new Set<number>();
    for (const key of selectedNodes) {
      const ref = parseKey(clip, key);
      if (ref) subs.add(ref.sub);
    }
    const only = subs.size === 1 ? clip?.subpaths[[...subs][0]!]?.id : undefined;
    const next: ScopeAddress | null = only ? { kind: "contour", contourId: only } : null;
    const cur = session.scopeAddress;
    if ((cur === null) !== (next === null) || (cur && next && scopeKey(cur) !== scopeKey(next))) {
      session.setScopeAddress(next);
    }
  }, [selectedNodes, editClipId]);

  // Leaving the node editor releases the sidebar. A scope that outlived the
  // selection that set it would silently send the next edit to a piece the
  // user can no longer see.
  React.useEffect(
    () => () => {
      const session = useSession.getState();
      if (session.scopeAddress?.kind === "contour") session.setScopeAddress(null);
    },
    [],
  );

  const setSelectedNodes: React.Dispatch<React.SetStateAction<Set<string>>> = (value) => {
    setSelectedNodesRaw((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      const clip = editClip()?.clip;
      if (!clip || next.size === 0) return next;
      const out = new Set(next);
      for (const key of next) {
        const ref = parseKey(clip, key);
        if (!ref) continue;
        for (const r of weldGroup(clip.subpaths, ref)) out.add(keyOf(clip, r));
      }
      return out;
    });
  };

  const worldToClipLocal = (w: { x: number; y: number }, clip: PathClip, frame: Frame) => {
    const { b, geo, wx, wy } = clipOrigin(clip, frame);
    const l = unmapLinear(w.x - wx, w.y - wy, b);
    return { x: l.x + geo.x, y: l.y + geo.y };
  };
  const clipLocalFromScreen = (p: { x: number; y: number }, clip: PathClip, frame: Frame) =>
    worldToClipLocal(toWorld(p), clip, frame);

  /**
   * Snap a WORLD point to the frame's guides/siblings (the shared stage engine),
   * recording the flashed guide lines. ⌘/Ctrl bypasses; the `guides` switch and
   * the settings' threshold match the layer drag exactly. Returns the (possibly
   * corrected) world point. `frameId` scopes candidates; `exclude` drops the
   * clip being edited so it never snaps to itself.
   */
  const snapWorld = (
    w: { x: number; y: number },
    frameId: string,
    exclude: Set<string>,
    bypass: boolean,
    /** Extra WORLD-space anchor points (this path's own nodes / draft points)
     *  fed in as first-class snap targets — this is what erases the "old vs new"
     *  node distinction: a fresh node snaps to a committed one and vice-versa. */
    nodesWorld: ReadonlyArray<{ x: number; y: number }> = [],
    /** When ⇧ locks the segment to an angle, the WORLD anchor it pivots around.
     *  Present ⇒ `w` is already on the locked ray, so snapping slides it ALONG
     *  that ray (snapPointOnRay) instead of freely — guides still flash and the
     *  angle stays locked. This is the fix that makes ⇧ and smart guides coexist. */
    rayOrigin?: { x: number; y: number },
  ) => {
    if (bypass || !useSession.getState().guides) {
      snapGuidesRef.current = { v: [], h: [] };
      return w;
    }
    const settings = useSession.getState().guideSettings;
    const base = frameSnapCandidates(store.getState(), frameId, exclude, settings, useSession.getState().rulerGuides);
    // Cross-object nodes: every OTHER vector clip's anchors/corners in the frame,
    // so a pen node snaps to a shape's corner (and vice-versa) — one node cloud.
    const siblingNodes = settings.toLayers ? frameVectorNodesWorld(store.getState(), frameId, exclude) : [];
    const cand = mergeSnapCandidates(
      mergeSnapCandidates(base, nodeSnapLines(nodesWorld)),
      nodeSnapLines(siblingNodes),
    );
    if (cand.v.length === 0 && cand.h.length === 0) {
      snapGuidesRef.current = { v: [], h: [] };
      return w;
    }
    const threshold = settings.thresholdPx / useStageView.getState().scale;
    if (rayOrigin) {
      const dx = w.x - rayOrigin.x;
      const dy = w.y - rayOrigin.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) {
        snapGuidesRef.current = { v: [], h: [] };
        return w;
      }
      const s = snapPointOnRay(rayOrigin, { x: dx / len, y: dy / len }, w, cand, threshold);
      snapGuidesRef.current = { v: s.v, h: s.h };
      return { x: s.x, y: s.y };
    }
    const s = snapPoint(w.x, w.y, cand, threshold);
    snapGuidesRef.current = { v: s.v, h: s.h };
    return { x: s.x, y: s.y };
  };

  /**
   * Place a freshly-drawn pen point (extend / draft / branch) — ONE brain for all
   * three so "hold ⇧" and "smart guides" mean the same thing everywhere. Without
   * ⇧ the point snaps freely to guides/siblings. With ⇧ it locks the segment
   * angle from `anchor` (in the object's OWN local axes, Figma-style) and THEN
   * still snaps, sliding the locked point along its ray onto any alignment. The
   * constraint runs in local space but snapping runs in world, so `l2w`/`w2l`
   * bridge the two; guides flash either way. Returns the resolved LOCAL point.
   */
  const resolveDrawPoint = (
    anchor: { x: number; y: number } | null,
    raw: { x: number; y: number },
    shift: boolean,
    frameId: string,
    exclude: Set<string>,
    nodesWorld: ReadonlyArray<{ x: number; y: number }>,
    bypass: boolean,
    l2w: (l: { x: number; y: number }) => { x: number; y: number },
    w2l: (w: { x: number; y: number }) => { x: number; y: number },
  ): { x: number; y: number } => {
    if (shift && anchor) {
      const c = constrainDragToAngle(raw.x - anchor.x, raw.y - anchor.y);
      const locked = { x: anchor.x + c.dx, y: anchor.y + c.dy };
      const w = snapWorld(l2w(locked), frameId, exclude, bypass, nodesWorld, l2w(anchor));
      return w2l(w);
    }
    return w2l(snapWorld(l2w(raw), frameId, exclude, bypass, nodesWorld));
  };

  /** Clip-local → WORLD, through the one layer map. Exposed so node positions
   *  can seed the snap engine. */
  const clipLocalToWorld = (l: { x: number; y: number }, clip: PathClip, frame: Frame) => {
    const { b, geo, wx, wy } = clipOrigin(clip, frame);
    const d = mapLinear(l.x - geo.x, l.y - geo.y, b);
    return { x: wx + d.x, y: wy + d.y };
  };
  const clipLocalToScreen = (l: { x: number; y: number }, clip: PathClip, frame: Frame) =>
    worldToScreen(clipLocalToWorld(l, clip, frame));

  /** World-space positions of an edited clip's anchors, minus `excludeKeys`
   *  ("sub:index") — the nodes a moving anchor/point should snap to. */
  const clipNodesWorld = (clip: PathClip, frame: Frame, excludeKeys: Set<string>) => {
    const out: Array<{ x: number; y: number }> = [];
    clip.subpaths.forEach((sub) =>
      sub.points.forEach((pt, i) => {
        if (excludeKeys.has(nodeKey(sub.id, i))) return;
        out.push(clipLocalToWorld(pt, clip, frame));
      }),
    );
    return out;
  };

  /** World-space positions of the current pen draft's already-placed points. */
  const draftNodesWorld = (draft: DraftState) =>
    draft.points.map((pt) => frameLocalToWorld(pt, draft.frame));

  /** For an active extension: the live end's point index, and the run's start
   *  index (the anchor a click closes onto). Head extension keeps the live point
   *  at 0; tail extension keeps it last. */
  const extendIndices = (sub: Subpath, end: "head" | "tail") =>
    end === "tail"
      ? { live: sub.points.length - 1, start: 0 }
      : { live: 0, start: sub.points.length - 1 };

  /**
   * Which open endpoint a pen click should CONTINUE from when the click isn't on
   * an endpoint or a segment: the currently-selected endpoint if one is picked
   * (so selecting a node chooses the side), else the nearest open end to the
   * cursor. This is what makes continue-drawing "just work" — you don't have to
   * hit the tiny endpoint dot; editing an open path and clicking extends it.
   */
  const pickContinuationEnd = (
    clip: PathClip,
    frame: Frame,
    screen: { x: number; y: number },
  ): { clipId: string; sub: number; end: "head" | "tail" } | null => {
    const ends = openEndpoints(clip.subpaths);
    if (ends.length === 0) return null;
    const sel = ends.find((ep) => selectedNodes.has(keyOf(clip, ep)));
    const chosen =
      sel ??
      ends.reduce<{ ep: (typeof ends)[number]; d: number } | null>((best, ep) => {
        const s = clipLocalToScreen(clip.subpaths[ep.sub]!.points[ep.index]!, clip, frame);
        const d = Math.hypot(screen.x - s.x, screen.y - s.y);
        return !best || d < best.d ? { ep, d } : best;
      }, null)?.ep;
    return chosen ? { clipId: clip.id, sub: chosen.sub, end: chosen.end } : null;
  };

  /**
   * Append a node to (or close) the actively-extended subpath from a pen click.
   * Shared by the explicit-endpoint continuation and the auto-continue path so
   * "add a node, stay anchored, keep drawing" is ONE code path. Returns false
   * only when the clip vanished (caller falls through to a fresh draft).
   */
  const appendOrCloseExtend = (
    ext: { clipId: string; sub: number; end: "head" | "tail" },
    p: { x: number; y: number },
    e: React.PointerEvent,
  ): boolean => {
    const target = editClip();
    if (!target || target.clip.id !== ext.clipId) return false;
    const { clip, frame } = target;
    const sub = clip.subpaths[ext.sub];
    if (!sub) return false;
    const { live, start } = extendIndices(sub, ext.end);
    // Close: land on the run's start.
    if (sub.points.length >= 2) {
      const startS = clipLocalToScreen(sub.points[start]!, clip, frame);
      if (Math.hypot(p.x - startS.x, p.y - startS.y) <= CLOSE_HIT) {
        store.update("Close path", (d) =>
          editPath(d, ext.clipId, (clip) => {
            const s = clip.subpaths[ext.sub];
            if (s) s.closed = true;
          }),
        );
        extendRef.current = null;
        penDragRef.current = null;
        dirtyRef.current = true;
        return true;
      }
    }
    // Append/prepend a new node — ⇧ locks the segment angle, snapping either way.
    const livePt = sub.points[live]!;
    const local = resolveDrawPoint(
      livePt,
      clipLocalFromScreen(p, clip, frame),
      e.shiftKey,
      clip.frameId,
      new Set([clip.id]),
      clipNodesWorld(clip, frame, new Set([keyOf(clip, { sub: ext.sub, index: live })])),
      e.metaKey || e.ctrlKey,
      (l) => clipLocalToWorld(l, clip, frame),
      (w) => worldToClipLocal(w, clip, frame),
    );
    let newIndex = -1;
    store.update("Extend path", (d) =>
      editPath(d, ext.clipId, (clip) => {
        const s = clip.subpaths[ext.sub];
        if (!s) return;
        const np: PathPoint = { x: local.x, y: local.y, hIn: null, hOut: null };
        if (ext.end === "tail") {
          s.points.push(np);
          newIndex = s.points.length - 1;
        } else {
          s.points.unshift(np);
          newIndex = 0;
        }
      }),
    );
    if (newIndex >= 0) {
      penDragRef.current = { kind: "extend", clipId: ext.clipId, sub: ext.sub, index: newIndex, startScreen: p, latched: false };
      setSelectedNodes(new Set([keyOf(clip, { sub: ext.sub, index: newIndex })]));
    }
    dirtyRef.current = true;
    return true;
  };

  /**
   * Nearest spot on the edited path's outline to a screen point — the pen
   * tool's add-point target. Segments are sampled; the returned t is the
   * curve parameter at the nearest sample (the de Casteljau split keeps the
   * outline exact regardless).
   */
  const hitSegment = (
    p: { x: number; y: number },
    clip: PathClip,
    frame: Frame,
    hitPx = 6,
  ): { sub: number; index: number; t: number; sx: number; sy: number } | null => {
    // Screen position of parameter t on segment i of subpath s.
    const atT = (s: number, i: number, t: number) => {
      const sub = clip.subpaths[s]!;
      const a = sub.points[i]!;
      const b = sub.points[(i + 1) % sub.points.length]!;
      const c1 = a.hOut ?? a;
      const c2 = b.hIn ?? b;
      const u = 1 - t;
      return clipLocalToScreen(
        {
          x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
          y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
        },
        clip,
        frame,
      );
    };
    // Coarse pass: nearest sample across every segment (no tolerance gate yet).
    const STEPS = 24;
    let best: { sub: number; index: number; t: number; d: number } | null = null;
    for (let s = 0; s < clip.subpaths.length; s++) {
      const sub = clip.subpaths[s]!;
      const segCount = sub.closed ? sub.points.length : sub.points.length - 1;
      for (let i = 0; i < segCount; i++) {
        for (let k = 0; k <= STEPS; k++) {
          const t = k / STEPS;
          const sp = atT(s, i, t);
          const d = Math.hypot(p.x - sp.x, p.y - sp.y);
          if (!best || d < best.d) best = { sub: s, index: i, t, d };
        }
      }
    }
    if (!best) return null;
    // Refine around the winner so the cut/insert lands EXACTLY under the cursor
    // (a few bisection rounds → sub-pixel), not at the nearest coarse sample.
    let lo = Math.max(0, best.t - 1 / STEPS);
    let hi = Math.min(1, best.t + 1 / STEPS);
    for (let iter = 0; iter < 6; iter++) {
      const mid = (lo + hi) / 2;
      const dLo = Math.hypot(p.x - atT(best.sub, best.index, lo).x, p.y - atT(best.sub, best.index, lo).y);
      const dHi = Math.hypot(p.x - atT(best.sub, best.index, hi).x, p.y - atT(best.sub, best.index, hi).y);
      if (dLo < dHi) hi = mid;
      else lo = mid;
    }
    const t = (lo + hi) / 2;
    const sp = atT(best.sub, best.index, t);
    const d = Math.hypot(p.x - sp.x, p.y - sp.y);
    return d <= hitPx ? { sub: best.sub, index: best.index, t, sx: sp.x, sy: sp.y } : null;
  };

  // ── The pen's one question ─────────────────────────────────────────────────
  //
  // "What would a click here do?" is asked by the paint pass, by the cursor, by
  // the hint, and by the press — so it is answered ONCE, in `resolvePen`, and
  // everything downstream reads the same `PenIntent`. Previously each of those
  // asked its own version against its own subset of the geometry, which is why
  // the badge could promise an insert that the click then didn't perform.

  /** Is a stroke in flight? Draft, extension and seeded branch are three states
   *  of one machine; nothing outside them needs to know which. */
  const isDrawing = () => !!(draftRef.current || extendRef.current || penBranchRef.current);

  /**
   * The frame the pen is working in: the stroke's own frame while one is in
   * flight, then the edited clip's, then whatever is under the cursor.
   */
  const penFrameId = (screen: Pt): string | null => {
    const draft = draftRef.current;
    if (draft) return draft.frame.id;
    const runClip = extendRef.current?.clipId ?? penBranchRef.current?.clipId ?? null;
    if (runClip) {
      const loc = locateClip(store.getState(), runClip);
      if (loc?.clip.kind === "path") return loc.clip.frameId;
    }
    const editing = editClip();
    if (editing) return editing.frame.id;
    return frameAtWorld(toWorld(screen));
  };

  /**
   * Every path the pen can land on right now — all of the working frame's path
   * clips, exactly like the knife. The pen used to see only `vectorEditClipId`,
   * and that single scoping is what made "add a node to this line and keep
   * drawing" fail on any path you hadn't already double-clicked into: the badge
   * drew from one set of geometry and the click tested against another.
   */
  const penTargets = (screen: Pt) => {
    const fid = penFrameId(screen);
    return fid ? framePathClips(fid) : [];
  };

  /** The stroke's own start node, and whether the cursor is on it (= close). */
  const runCloseTarget = (): { screen: Pt } | null => {
    const draft = draftRef.current;
    if (draft) {
      if (draft.points.length < 2) return null;
      return { screen: frameLocalToScreen(draft.points[0]!, draft.frame) };
    }
    const ext = extendRef.current;
    if (!ext) return null;
    const loc = locateClip(store.getState(), ext.clipId);
    if (loc?.clip.kind !== "path") return null;
    const frame = store.getState().frames.find((f) => f.id === loc.clip.frameId);
    const sub = loc.clip.subpaths[ext.sub];
    if (!frame || !sub || sub.points.length < 2) return null;
    const { start } = extendIndices(sub, ext.end);
    return { screen: clipLocalToScreen(sub.points[start]!, loc.clip, frame) };
  };

  /** The node the stroke is standing on — never a landing target for itself. */
  const runLiveKey = (): string | null => {
    const ext = extendRef.current;
    if (!ext) return null;
    const loc = locateClip(store.getState(), ext.clipId);
    if (loc?.clip.kind !== "path") return null;
    const sub = loc.clip.subpaths[ext.sub];
    if (!sub) return null;
    return `${ext.clipId}:${nodeKey(sub.id, extendIndices(sub, ext.end).live)}`;
  };

  /**
   * Does this click BELONG to that node?
   *
   * Two radii used to answer this, and they disagreed. The grab radius (9px)
   * decided whether the pen offered a junction; the SNAP threshold (10px, and
   * the user can raise it) decided whether the magnet placed the new node on
   * the old one's exact coordinates. In the band between them the magnet won
   * alone: the node landed pixel-perfect on the vertex with no join behind it,
   * so the path looked fused until you dragged it and it came apart. That is
   * the whole "it tricks us into thinking it joined" bug.
   *
   * One question, one answer: anywhere the magnet would weld the coordinates,
   * this is a landing and the junction flow owns it. Snapping resolves each axis
   * independently, so coincidence needs BOTH within the threshold — a Chebyshev
   * box, not a circle, or the corners of it leak back into the old behaviour.
   */
  const onNode = (p: Pt, s: Pt) => {
    if (Math.hypot(p.x - s.x, p.y - s.y) <= ANCHOR_HIT) return true;
    const sess = useSession.getState();
    if (!sess.guides) return false;
    const t = sess.guideSettings.thresholdPx;
    return Math.abs(p.x - s.x) <= t && Math.abs(p.y - s.y) <= t;
  };

  /**
   * THE resolver. Hit-tests every reachable path, picks one landing with the
   * shared rule (anchors beat curves), and hands the decision to core.
   */
  const resolvePen = (p: Pt): PenResolution => {
    const drawing = isDrawing();
    const close = runCloseTarget();
    if (close && Math.hypot(p.x - close.screen.x, p.y - close.screen.y) <= CLOSE_HIT) {
      return { intent: { kind: "close" }, target: null, screen: close.screen };
    }
    const live = runLiveKey();
    const hits: Array<PenCandidate & { screen: Pt; clip: PathClip; frame: Frame }> = [];
    for (const { clip, frame } of penTargets(p)) {
      const ends = openEndpoints(clip.subpaths);
      for (let sIdx = 0; sIdx < clip.subpaths.length; sIdx++) {
        const sub = clip.subpaths[sIdx]!;
        for (let i = 0; i < sub.points.length; i++) {
          if (live === `${clip.id}:${nodeKey(sub.id, i)}`) continue;
          const sp = clipLocalToScreen(sub.points[i]!, clip, frame);
          if (!onNode(p, sp)) continue;
          const dist = Math.hypot(p.x - sp.x, p.y - sp.y);
          const landing: PenLanding = {
            clipId: clip.id,
            site: { kind: "anchor", sub: sIdx, index: i },
            end: ends.find((ep) => ep.sub === sIdx && ep.index === i)?.end ?? null,
          };
          hits.push({ landing, dist, screen: sp, clip, frame });
        }
      }
      const seg = hitSegment(p, clip, frame, PATH_HIT.segment);
      if (seg) {
        hits.push({
          landing: { clipId: clip.id, site: { kind: "segment", sub: seg.sub, index: seg.index, t: seg.t }, end: null },
          dist: Math.hypot(p.x - seg.sx, p.y - seg.sy),
          screen: { x: seg.sx, y: seg.sy },
          clip,
          frame,
        });
      }
    }
    const picked = pickPenLanding(hits);
    const hit = picked ? hits.find((h) => h.landing === picked)! : null;
    return {
      intent: penIntent({ drawing, closing: false, landing: picked }),
      target: hit ? { clip: hit.clip, frame: hit.frame } : null,
      screen: hit?.screen ?? null,
    };
  };

  /** Every editable path clip in a frame (the Cut tool works on ANY of them, not
   *  just the one you double-clicked into). */
  const framePathClips = (frameId: string): Array<{ clip: PathClip; frame: Frame }> => {
    const doc = store.getState();
    const frame = doc.frames.find((f) => f.id === frameId);
    if (!frame) return [];
    const out: Array<{ clip: PathClip; frame: Frame }> = [];
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.frameId === frameId && clip.kind === "path") out.push({ clip, frame });
      }
    }
    return out;
  };

  /** The frame a world point falls in — the edited clip's frame if node-editing,
   *  else the frame under the cursor. Scopes the knife to one artboard. */
  const frameAtWorld = (w: Pt): string | null => {
    const editing = editClip();
    if (editing) return editing.frame.id;
    // Drilled in, the level you are standing in IS where new geometry goes —
    // a click past the edge of its box included. See `standingFrameId`.
    const standing = standingFrameId();
    if (standing) return standing;
    const doc = store.getState();
    const pageId = useSession.getState().activePageId ?? doc.pages[0]?.id;
    if (!pageId) return null;
    const onPage = doc.frames.filter((fr) => pageOfFrame(doc, fr) === pageId);
    const f = onPage.find(
      (fr) => w.x >= fr.x && w.x <= fr.x + fr.width && w.y >= fr.y && w.y <= fr.y + fr.height,
    );
    if (f) return f.id;
    // Off every artboard: geometry belongs to the comp you are working in, drawn
    // where you drew it. See `frameForRect` — one rule, two tools.
    const active = useSession.getState().activeFrameId;
    return (onPage.find((fr) => fr.id === active) ?? onPage[0])?.id ?? null;
  };

  /** Point cut (a plain Cut click): sever the nearest frame path under `p`. */
  const pointCut = (p: Pt, frameId: string): number => {
    let best: { clipId: string; hit: { sub: number; index: number; t: number }; d: number } | null = null;
    for (const { clip, frame } of framePathClips(frameId)) {
      const hit = hitSegment(p, clip, frame, 10);
      if (!hit) continue;
      const d = Math.hypot(p.x - hit.sx, p.y - hit.sy);
      if (!best || d < best.d) best = { clipId: clip.id, hit, d };
    }
    if (!best) return 0;
    const target = best;
    const made: string[] = [];
    store.update("Cut path", (d) => {
      editPath(d, target.clipId, (clip) => {
        const sub = clip.subpaths[target.hit.sub];
        if (!sub) return;
        const ni = insertPointOnSegment(sub, target.hit.index, target.hit.t);
        breakAtNode(clip.subpaths, { sub: target.hit.sub, index: ni });
      });
      made.push(...(promotePathClip(d, target.clipId)?.pieceIds ?? []));
    });
    selectPromoted(made);
    setSelectedNodes(new Set());
    dirtyRef.current = true;
    return 1;
  };

  /**
   * AUTO-PROMOTION, in the same undo step as the cut that caused it.
   *
   * The moment a cut leaves two separated paths, they ARE two layers — no
   * command, no dialog, no "convert". `promotePathClip` decides, not this file:
   * a cut that merely opens a contour still leaves one piece and nothing
   * happens, while a cut that severs artwork yields a row per piece, each
   * independently colourable. Selection lands on the pieces so the next thing
   * you do is to the thing you just made.
   */
  const selectPromoted = (ids: string[]): void => {
    if (ids.length > 0) useSession.getState().select(ids);
  };

  /** Knife cut: slice a straight WORLD line through every path in the frame it
   *  crosses (headless knifeSubpaths per clip, in that clip's local space). */
  const knifeCut = (worldA: Pt, worldB: Pt, frameId: string): number => {
    const plan: Array<{ id: string; subs: Subpath[]; cuts: number }> = [];
    for (const { clip, frame } of framePathClips(frameId)) {
      const la = worldToClipLocal(worldA, clip, frame);
      const lb = worldToClipLocal(worldB, clip, frame);
      const res = knifeSubpaths(clip.subpaths, la, lb);
      if (res.cuts > 0) plan.push({ id: clip.id, subs: res.subs, cuts: res.cuts });
    }
    if (plan.length === 0) return 0;
    const made: string[] = [];
    store.update("Knife cut", (d) => {
      for (const p of plan) {
        editPath(d, p.id, (clip) => setPathGeometry(clip, p.subs));
        made.push(...(promotePathClip(d, p.id)?.pieceIds ?? []));
      }
    });
    selectPromoted(made);
    setSelectedNodes(new Set());
    dirtyRef.current = true;
    return plan.reduce((n, p) => n + p.cuts, 0);
  };

  // ── Section selection + transform box ──────────────────────────────────────
  // A "section" is a set of selected nodes (often a whole subpath). It gets the
  // SAME transform chrome as a shape — a box with 8 grips — but the grips MORPH
  // the node positions by default (native geometry) and object-scale the clip
  // only when ⌘ is held. All the math lives in clip-local space so it's
  // rotation-correct, then the drawing folds it to screen.

  /** Keys of every node in a subpath. */
  const subpathKeys = (clip: PathClip, s: number) => {
    const sub = clip.subpaths[s];
    return (sub?.points ?? []).map((_, i) => nodeKey(sub!.id, i));
  };

  const totalNodeCount = (clip: PathClip) =>
    clip.subpaths.reduce((n, sub) => n + sub.points.length, 0);

  const wholeClipSelected = (clip: PathClip) =>
    selectedNodes.size > 0 && selectedNodes.size === totalNodeCount(clip);

  /** Local-space bbox of the selected nodes (anchors only — handles ride along). */
  const selectionBoundsLocal = (
    clip: PathClip,
    keys: ReadonlySet<string> = selectedNodes,
  ): { minX: number; minY: number; maxX: number; maxY: number } | null => {
    let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    clip.subpaths.forEach((sub) =>
      sub.points.forEach((pt, i) => {
        if (!keys.has(nodeKey(sub.id, i))) return;
        if (!b) b = { minX: pt.x, minY: pt.y, maxX: pt.x, maxY: pt.y };
        else {
          b.minX = Math.min(b.minX, pt.x);
          b.minY = Math.min(b.minY, pt.y);
          b.maxX = Math.max(b.maxX, pt.x);
          b.maxY = Math.max(b.maxY, pt.y);
        }
      }),
    );
    return b;
  };

  /**
   * The SEGMENT the selection is, when it is exactly one: two nodes that are
   * neighbours on one subpath. Derived from the node set (a segment IS its two
   * anchors), never stored. A segment is a line, not a region — it gets a lit
   * stroke and drags as itself, never the section box, which made a picked
   * line look like a shape being scaled (D12 follow-up).
   */
  const selectedSegment = (clip: PathClip): { sub: number; index: number } | null => {
    if (selectedNodes.size !== 2) return null;
    for (let s = 0; s < clip.subpaths.length; s++) {
      const sub = clip.subpaths[s]!;
      const n = sub.points.length;
      const segCount = sub.closed ? n : n - 1;
      for (let i = 0; i < segCount; i++) {
        if (selectedNodes.has(nodeKey(sub.id, i)) && selectedNodes.has(nodeKey(sub.id, (i + 1) % n))) return { sub: s, index: i };
      }
    }
    return null;
  };

  /** The section box's bounds, or null when the selection is a point or a segment. */
  const sectionBoxLocal = (clip: PathClip) =>
    selectedNodes.size >= 2 && !selectedSegment(clip) ? selectionBoundsLocal(clip) : null;

  const boxHandleLocal = (b: { minX: number; minY: number; maxX: number; maxY: number }, h: BoxHandle): Pt => {
    const mx = (b.minX + b.maxX) / 2;
    const my = (b.minY + b.maxY) / 2;
    switch (h) {
      case "nw": return { x: b.minX, y: b.minY };
      case "n": return { x: mx, y: b.minY };
      case "ne": return { x: b.maxX, y: b.minY };
      case "e": return { x: b.maxX, y: my };
      case "se": return { x: b.maxX, y: b.maxY };
      case "s": return { x: mx, y: b.maxY };
      case "sw": return { x: b.minX, y: b.maxY };
      case "w": return { x: b.minX, y: my };
    }
  };

  const BOX_HANDLES: BoxHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

  /** Which box grip (if any) the screen point is over. */
  const hitBoxHandle = (
    p: Pt,
    clip: PathClip,
    frame: Frame,
    b: { minX: number; minY: number; maxX: number; maxY: number },
  ): BoxHandle | null => {
    for (const h of BOX_HANDLES) {
      const s = clipLocalToScreen(boxHandleLocal(b, h), clip, frame);
      if (Math.hypot(p.x - s.x, p.y - s.y) <= BOX_HANDLE_HIT) return h;
    }
    return null;
  };

  /** What a press in node-edit mode would do here, in the order the press itself asks. */
  const editCursorAt = (p: Pt): string => {
    const target = editClip();
    if (!target) return cursors.arrow;
    const { clip, frame } = target;
    const sb = sectionBoxLocal(clip);
    if (sb) {
      const handle = hitBoxHandle(p, clip, frame, sb);
      if (handle) {
        const ring = (["nw", "ne", "se", "sw"] as BoxHandle[]).map((h) => clipLocalToScreen(boxHandleLocal(sb, h), clip, frame));
        const corner = (["nw", "ne", "se", "sw"] as BoxHandle[]).indexOf(handle);
        const edge = (["n", "e", "s", "w"] as BoxHandle[]).indexOf(handle);
        return resizeCursor(corner >= 0 ? cornerBearing(ring, corner) : edgeBearing(ring, edge));
      }
    }
    for (const sub of clip.subpaths) {
      for (let i = 0; i < sub.points.length; i++) {
        const pt = sub.points[i]!;
        const near = (q: Pt, r: number) => {
          const s = clipLocalToScreen(q, clip, frame);
          return Math.hypot(p.x - s.x, p.y - s.y) <= r;
        };
        if (selectedNodes.has(nodeKey(sub.id, i)) && ((pt.hIn && near(pt.hIn, ANCHOR_HIT)) || (pt.hOut && near(pt.hOut, ANCHOR_HIT)))) return cursors.move;
        // \u2325 on a node pulls fresh handles out of it, which converts the point.
        if (near(pt, ANCHOR_HIT)) return altHeldRef.current ? cursors.penConvert : cursors.move;
      }
    }
    // ⌘ over a segment previews the bend BEFORE the press (Figma).
    if (bendArmed() && hitSegment(p, clip, frame, PATH_HIT.segment)) return cursors.bend;
    if (sb && insideSelectionBox(p, clip, frame, sb)) return cursors.move;
    if (hitSegment(p, clip, frame, PATH_HIT.segment) || hitSubpath(p, clip, frame) !== null) return cursors.pointer;
    return cursors.arrow;
  };

  /** Even-odd point-in-polygon on a screen-space vertex ring. */
  const pointInPoly = (p: Pt, poly: Pt[]) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const c = poly[j]!;
      if (a.y > p.y !== c.y > p.y && p.x < ((c.x - a.x) * (p.y - a.y)) / (c.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };

  /** Is the screen point inside the (rotated) selection box? */
  const insideSelectionBox = (
    p: Pt,
    clip: PathClip,
    frame: Frame,
    b: { minX: number; minY: number; maxX: number; maxY: number },
  ) => {
    const ring = (["nw", "ne", "se", "sw"] as BoxHandle[]).map((h) => clipLocalToScreen(boxHandleLocal(b, h), clip, frame));
    return pointInPoly(p, ring);
  };

  /** The subpath under a screen point — inside its filled area OR on its
   *  outline. Clicking it selects that whole "section" (all its nodes). */
  const hitSubpath = (p: Pt, clip: PathClip, frame: Frame): number | null => {
    // Fill test first (flatten each subpath to a screen polygon).
    for (let s = clip.subpaths.length - 1; s >= 0; s--) {
      const sub = clip.subpaths[s]!;
      if (sub.points.length < 3) continue;
      const poly: Pt[] = [];
      const segCount = sub.points.length;
      for (let i = 0; i < segCount; i++) {
        const a = sub.points[i]!;
        const b = sub.points[(i + 1) % sub.points.length]!;
        const c1 = a.hOut ?? a;
        const c2 = b.hIn ?? b;
        for (let k = 0; k < 8; k++) {
          const t = k / 8;
          const u = 1 - t;
          poly.push(
            clipLocalToScreen(
              {
                x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
                y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
              },
              clip,
              frame,
            ),
          );
        }
      }
      if (pointInPoly(p, poly)) return s;
    }
    // Otherwise, near an outline segment.
    const seg = hitSegment(p, clip, frame, 6);
    return seg ? seg.sub : null;
  };

  /** Start a section move/resize: snapshot the selected nodes + transform so the
   *  gesture scales the START state (stable, no compounding). */
  const beginSectionDrag = (
    mode: "resize" | "move",
    handle: BoxHandle | null,
    clip: PathClip,
    frame: Frame,
    b: { minX: number; minY: number; maxX: number; maxY: number },
    p: Pt,
    _e: React.PointerEvent,
    keys: ReadonlySet<string> = selectedNodes,
  ) => {
    const startNodes: Array<{ key: string; x: number; y: number; hIn: Pt | null; hOut: Pt | null }> = [];
    clip.subpaths.forEach((sub) =>
      sub.points.forEach((pt, i) => {
        if (!keys.has(nodeKey(sub.id, i))) return;
        startNodes.push({
          key: nodeKey(sub.id, i),
          x: pt.x,
          y: pt.y,
          hIn: pt.hIn ? { ...pt.hIn } : null,
          hOut: pt.hOut ? { ...pt.hOut } : null,
        });
      }),
    );
    const anchorLocal = handle
      ? boxHandleLocal(b, OPPOSITE_HANDLE[handle])
      : { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    const pose = editPose(clip);
    sectionDragRef.current = {
      mode,
      clipId: clip.id,
      handle,
      canObjectScale: wholeClipSelected(clip),
      boundsLocal: b,
      anchorLocal,
      startPointerLocal: clipLocalFromScreen(p, clip, frame),
      startNodes,
      startTransform: pose,
      fixedWorld: clipLocalToWorld(anchorLocal, clip, frame),
      moved: false,
    };
    dirtyRef.current = true;
  };

  /** Apply a live section move/resize from the current pointer. Default = MORPH
   *  the node positions (native geometry); ⌘ (whole clip) = object-scale the
   *  transform instead, pinning the opposite grip in world space. */
  const updateSectionDrag = (p: Pt, e: React.PointerEvent) => {
    const sd = sectionDragRef.current;
    if (!sd) return;
    const target = editClip();
    if (!target || target.clip.id !== sd.clipId) return;
    const { clip, frame } = target;
    const cur = clipLocalFromScreen(p, clip, frame);

    const applyNodes = (
      mutate: (pt: PathPoint, start: { key: string; x: number; y: number; hIn: Pt | null; hOut: Pt | null }) => void,
    ) => {
      store.update(
        sd.mode === "move" ? "Move nodes" : "Resize section",
        (d) =>
          editPath(d, sd.clipId, (clip) => {
            const moved: NodeRef[] = [];
            for (const sn of sd.startNodes) {
              const at = resolveNode(clip, sn.key);
              const pt = at?.sub.points[at.index];
              if (!pt || !at) continue;
              mutate(pt, sn);
              moved.push({ sub: at.subIndex, index: at.index });
            }
            // A section move/resize is a node move like any other, so the curve
            // follows it the same way — the smooth anchors just outside the
            // selection re-aim instead of leaving a kink at its border.
            reflowAroundNodes(clip.subpaths, moved);
          }),
        { mergeKey: `vec-section-${sd.clipId}` },
      );
    };

    if (sd.mode === "move") {
      const dx = cur.x - sd.startPointerLocal.x;
      const dy = cur.y - sd.startPointerLocal.y;
      applyNodes((pt, start) => {
        pt.x = start.x + dx;
        pt.y = start.y + dy;
        pt.hIn = start.hIn ? { x: start.hIn.x + dx, y: start.hIn.y + dy } : null;
        pt.hOut = start.hOut ? { x: start.hOut.x + dx, y: start.hOut.y + dy } : null;
      });
      sd.moved = true;
      dirtyRef.current = true;
      return;
    }

    // resize
    const startHandle = boxHandleLocal(sd.boundsLocal, sd.handle!);
    const axes = HANDLE_AXES[sd.handle!];
    const denomX = startHandle.x - sd.anchorLocal.x;
    const denomY = startHandle.y - sd.anchorLocal.y;
    let fx = axes.x && Math.abs(denomX) > 1e-6 ? (cur.x - sd.anchorLocal.x) / denomX : 1;
    let fy = axes.y && Math.abs(denomY) > 1e-6 ? (cur.y - sd.anchorLocal.y) / denomY : 1;
    if (e.shiftKey) {
      // Uniform: the larger magnitude drives both axes it controls.
      const f = Math.max(axes.x ? Math.abs(fx) : 0, axes.y ? Math.abs(fy) : 0) || 1;
      if (axes.x) fx = Math.sign(fx || 1) * f;
      if (axes.y) fy = Math.sign(fy || 1) * f;
    }
    sd.moved = true;

    const objectScale = (e.metaKey || e.ctrlKey) && sd.canObjectScale;
    if (objectScale) {
      const nScale = Math.max(0.01, sd.startTransform.scale * fx);
      const nScaleY = Math.max(0.01, sd.startTransform.scaleY * fy);
      // Keep the opposite grip pinned in world. The offset from the layer's
      // POSITION to that grip is exactly the one layer map applied to the grip's
      // local point — pivot and shear included — so this stays correct for a
      // pivot that isn't the box center instead of quietly sliding the path.
      const o = mapLocal(sd.anchorLocal.x, sd.anchorLocal.y, {
        ...sd.startTransform,
        scale: nScale,
        scaleY: nScaleY,
      });
      const fixedLocal = frameLocalFromWorld(sd.fixedWorld, frame);
      store.update(
        "Scale vector",
        (d) => {
          const loc = locateClip(d, sd.clipId);
          if (loc?.clip.kind !== "path") return;
          loc.clip.transform.scale = nScale;
          loc.clip.transform.scaleY = nScaleY;
          loc.clip.transform.x = fixedLocal.x - o.x;
          loc.clip.transform.y = fixedLocal.y - o.y;
        },
        { mergeKey: `vec-section-${sd.clipId}` },
      );
      dirtyRef.current = true;
      return;
    }

    applyNodes((pt, start) => {
      const scaleFrom = (q: Pt) => ({
        x: sd.anchorLocal.x + (q.x - sd.anchorLocal.x) * fx,
        y: sd.anchorLocal.y + (q.y - sd.anchorLocal.y) * fy,
      });
      const np = scaleFrom({ x: start.x, y: start.y });
      pt.x = np.x;
      pt.y = np.y;
      pt.hIn = start.hIn ? scaleFrom(start.hIn) : null;
      pt.hOut = start.hOut ? scaleFrom(start.hOut) : null;
    });
    dirtyRef.current = true;
  };

  /** Delete a set of "sub:index" node keys (keyboard ⌫ and the point menu). */
  const deleteNodes = React.useCallback(
    (keys: Set<string>) => {
      const id = useSession.getState().vectorEditClipId;
      if (!id || keys.size === 0) return;
      store.update("Delete points", (d) =>
        editPath(d, id, (clip) => {
          const refs = clip.subpaths.flatMap((sub, s) => sub.points.flatMap((_, i) => (keys.has(nodeKey(sub.id, i)) ? [{ sub: s, index: i }] : [])));
          // Core's one rule (short subpaths go, stale welds are pruned).
          deletePathNodes(clip.subpaths, refs);
        }),
      );
      setSelectedNodes(new Set());
      const still = locateClip(store.getState(), id);
      if (still?.clip.kind === "path" && still.clip.subpaths.length === 0) {
        store.update("Delete path", (d) => {
          const loc = locateClip(d, id);
          if (loc) loc.track.clips.splice(loc.clipIndex, 1);
        });
        useSession.getState().setVectorEdit(null);
      }
    },
    [store],
  );

  /** Copy the selected points into the point clipboard. Returns the count. */
  const copyPoints = React.useCallback((): number => {
    const target = editClip();
    if (!target || selectedNodes.size === 0) return 0;
    const out: Contour[] = [];
    let count = 0;
    target.clip.subpaths.forEach((sub) => {
      const picked: PathPoint[] = [];
      sub.points.forEach((pt, i) => {
        if (!selectedNodes.has(nodeKey(sub.id, i))) return;
        picked.push({
          x: pt.x,
          y: pt.y,
          hIn: pt.hIn ? { ...pt.hIn } : null,
          hOut: pt.hOut ? { ...pt.hOut } : null,
        });
      });
      if (picked.length === 0) return;
      count += picked.length;
      out.push({ closed: sub.closed && picked.length === sub.points.length, points: picked });
    });
    pointClipboard = out.length ? out : null;
    // …and onto the REAL clipboard, which is what lets these contours leave the
    // node editor: paste with another vector layer selected and they land in
    // it, paste with nothing selected and they become a new layer at the
    // cursor. Contours carry no identity precisely so they can travel like
    // this; ids are minted where they land.
    if (out.length) void copyContours(out);
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodes, store]);

  /**
 * Paste into the path being edited — the in-editor fast path, which offsets the
 * copy and leaves it selected so you can keep dragging. Pasting OUTSIDE the
 * node editor goes through `pasteClipboard`, which picks the layer.
 */
  const pastePoints = React.useCallback(() => {
    const id = useSession.getState().vectorEditClipId;
    if (!id || !pointClipboard || pointClipboard.length === 0) return;
    const pasted = pointClipboard;
    const keys: string[] = [];
    store.update("Paste points", (d) =>
      editPath(d, id, (clip) => {
        for (const sub of pasted) {
          const id = newContourId();
          clip.subpaths.push({
            id,
            closed: sub.closed,
            points: sub.points.map((pt, i) => {
              keys.push(nodeKey(id, i));
              return {
                x: pt.x + 12,
                y: pt.y + 12,
                hIn: pt.hIn ? { x: pt.hIn.x + 12, y: pt.hIn.y + 12 } : null,
                hOut: pt.hOut ? { x: pt.hOut.x + 12, y: pt.hOut.y + 12 } : null,
              };
            }),
          });
        }
      }),
    );
    setSelectedNodes(new Set(keys));
  }, [store]);

  /** Toggle corner ↔ smooth on one point (double-click and the point menu) — the shared verb, as 3D's double-click. */
  const togglePoint = React.useCallback(
    (clipId: string, s: number, i: number) => {
      store.update(NODE_VERBS.toggleType.undo, (d) => editPath(d, clipId, (clip) => void runNodeVerb("toggleType", clip.subpaths, [{ sub: s, index: i }])));
    },
    [store],
  );

  /** Mirror the selected points around their shared center. */
  const mirrorSelection = React.useCallback(
    (axis: "x" | "y") => {
      const id = useSession.getState().vectorEditClipId;
      if (!id || selectedNodes.size < 2) return;
      store.update(axis === "x" ? "Mirror horizontally" : "Mirror vertically", (d) =>
        editPath(d, id, (clip) => {
          let sum = 0;
          let count = 0;
          for (const sub of clip.subpaths) {
            const pts = sub.points;
            for (let i = 0; i < pts.length; i++) {
              if (!selectedNodes.has(nodeKey(sub.id, i))) continue;
              sum += axis === "x" ? pts[i]!.x : pts[i]!.y;
              count++;
            }
          }
          if (count === 0) return;
          const center = sum / count;
          const flip = (pt: { x: number; y: number } | null) => {
            if (!pt) return;
            if (axis === "x") pt.x = 2 * center - pt.x;
            else pt.y = 2 * center - pt.y;
          };
          for (const sub of clip.subpaths) {
            const pts = sub.points;
            for (let i = 0; i < pts.length; i++) {
              if (!selectedNodes.has(nodeKey(sub.id, i))) continue;
              flip(pts[i]!);
              flip(pts[i]!.hIn);
              flip(pts[i]!.hOut);
            }
          }
        }),
      );
    },
    [selectedNodes, store],
  );

  /**
   * Bake the outline you can SEE into the clip's base before an edit that is
   * about to touch it. Two ways the visible outline isn't `subpaths`:
   *
   *  - geometry keys own it — the points on screen are interpolated ones;
   *  - the layer is a RECORDED drawing — the points on screen belong to the
   *    capture frame under the playhead.
   *
   * Either way, editing the base would move points you aren't looking at and
   * appear to do nothing. That is exactly what a recorded vector layer did:
   * every frame double-clicked into the drawing it was seeded from. Both cases
   * resolve through `captureSlotAt`, so the node editor is always editing the
   * frame it is showing. Every entry into an edit (a pointer press, an arrow-key
   * nudge, a toolbar op) passes through here first.
   */
  const bakeSampledGeometry = (clip: PathClip, mergeKey?: string): void => {
    if (!propertyHasKeys(clip.keyframes, "geometry")) return;
    const local = Math.min(
      Math.max(0, useSession.getState().playheadMs - clip.startMs),
      clip.durationMs,
    );
    const visible = sampleKeyframes(clip.keyframes, local)["geometry"];
    if (!isGeometryValue(visible)) return;
    store.update(
      "Edit path",
      // The bake swaps the clip's DECLARED box for the sampled one, which is the
      // box the pivot is a fraction of — so it goes through the same seam a node
      // drag does, or grabbing a morphing path would jolt it.
      (d) => editPath(d, clip.id, (c) => setPathGeometry(c, lendIdentity(c.subpaths, copySubpaths(visible)))),
      mergeKey ? { mergeKey } : undefined,
    );
  };

  /**
   * Record a finished outline edit into a geometry key when the clip is keyed
   * (or record mode is armed) — vector morphing records itself. The counterpart
   * of `bakeSampledGeometry`: every edit path that opens with a bake closes
   * here, so a drag, a toolbar op and an arrow nudge all animate identically.
   */
  const keyGeometryIfAnimating = (clipId: string): void => {
    const target = editClipById(clipId);
    if (!target || animWriteMode(target, "geometry") !== "keyframe") return;
    const playhead = useSession.getState().playheadMs;
    store.update("Key path geometry", (d) => {
      const loc = locateClip(d, clipId);
      if (loc?.clip.kind === "path") {
        commitProperty(loc.clip, "geometry", copySubpaths(loc.clip.subpaths), playhead);
      }
    });
  };

  /** The path clip by id, or null — the read half of `editPath`. */
  const editClipById = (clipId: string): PathClip | null => {
    const loc = locateClip(store.getState(), clipId);
    return loc?.clip.kind === "path" ? loc.clip : null;
  };

  /**
   * Arrow-key nudge of the selected NODES — the keyboard half of a node drag.
   *
   * The delta arrives in WORLD units (what the user is aiming on screen) and is
   * folded into the clip's own space through the SAME layer map the pointer path
   * uses, so a nudged node moves in the direction you pressed even when the layer
   * is rotated, mirrored or sheared. Bake-then-key bracket it exactly like a
   * drag, so nudging a morphing path records itself instead of silently editing
   * a base nobody is looking at. Repeated presses coalesce into one undo step.
   */
  const nudgeNodes = React.useCallback(
    (dxWorld: number, dyWorld: number): boolean => {
      const target = editClip();
      if (!target || selectedNodes.size === 0) return false;
      const clipId = target.clip.id;
      bakeSampledGeometry(target.clip, `vec-nudge-${clipId}`);
      const fresh = editClipById(clipId);
      if (!fresh) return false;
      const d = unmapLinear(dxWorld, dyWorld, editBasis(fresh));
      store.update(
        "Nudge nodes",
        (doc) => editPath(doc, clipId, (c) => translateNodes(c.subpaths, refsOf(c, selectedNodes), d.x, d.y)),
        { mergeKey: `vec-nudge-${clipId}` },
      );
      keyGeometryIfAnimating(clipId);
      dirtyRef.current = true;
      return true;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [selectedNodes, store],
  );

  // Register with the one arrow-key seam (see `nudge-target.ts`). The ref keeps
  // the registration stable while the callback tracks the live node selection.
  const nudgeRef = React.useRef(nudgeNodes);
  nudgeRef.current = nudgeNodes;
  React.useEffect(() => nudgeTargets.register({ nudge: (dx, dy) => nudgeRef.current(dx, dy) }), []);

  // ── Vector ops (the contextual pen toolbar's verbs) ────────────────────────
  // Every toolbar/keyboard/menu action funnels through ONE runner: parse the
  // "sub:index" selection into NodeRefs, mutate the edited clip's subpaths with a
  // pure core op, and re-key geometry when the clip is in record/keyframe mode
  // (so structural edits morph like drags do). `select` remaps the selection.

  const selectedRefs = React.useCallback((): NodeRef[] => {
    const clip = editClip()?.clip;
    if (!clip) return [];
    return [...selectedNodes].map((k) => parseKey(clip, k)).filter((r): r is NodeRef => r !== null);
  }, [selectedNodes, editClipId]);

  const runVectorOp = React.useCallback(
    (label: string, mutate: (subs: Subpath[]) => void, select?: Set<string> | null) => {
      const id = useSession.getState().vectorEditClipId;
      if (!id) return;
      store.update(label, (d) =>
        editPath(d, id, (clip) => {
          mutate(clip.subpaths);
          clip.subpaths = clip.subpaths.filter((s) => s.points.length >= 2);
        }),
      );
      // Record structural edits into geometry keys when the clip is keyed.
      keyGeometryIfAnimating(id);
      if (select !== undefined) setSelectedNodes(select ?? new Set());
      dirtyRef.current = true;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [store],
  );

  /**
   * A SHARED POINT VERB (core `node-verbs`) — the 3D edit mode's menus and
   * keys run exactly this one, so a verb cannot mean one thing here and
   * another in a world. The verb says what is selected after it.
   */
  const runVerb = React.useCallback(
    (id: NodeVerbId) => {
      const clipId = useSession.getState().vectorEditClipId;
      if (!clipId) return;
      const refs = selectedRefs();
      let result: NodeVerbResult = { changed: false };
      runVectorOp(NODE_VERBS[id].undo, (s) => void (result = runNodeVerb(id, s, refs)));
      const after = (result as NodeVerbResult).select;
      if (after === undefined) return;
      const clip = editClipById(clipId);
      setSelectedNodes(after && clip ? new Set(after.map((r) => keyOf(clip, r))) : new Set());
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [runVectorOp, selectedRefs],
  );

  /** The single dispatcher every pen verb flows through (toolbar + keyboard +
   *  menu): a shared point verb where there is one, else the canvas's own. */
  const dispatchPen = React.useCallback(
    (a: PenAction) => {
      const shared = PEN_VERB[a];
      if (shared) return runVerb(shared);
      const refs = selectedRefs();
      switch (a) {
        // Aligning to the canvas's x and y is the flat canvas's own verb.
        case "alignL": runVectorOp("Align left", (s) => alignNodes(s, refs, "left")); break;
        case "alignH": runVectorOp("Align center", (s) => alignNodes(s, refs, "hcenter")); break;
        case "alignR": runVectorOp("Align right", (s) => alignNodes(s, refs, "right")); break;
        case "alignT": runVectorOp("Align top", (s) => alignNodes(s, refs, "top")); break;
        case "alignV": runVectorOp("Align middle", (s) => alignNodes(s, refs, "vcenter")); break;
        case "alignB": runVectorOp("Align bottom", (s) => alignNodes(s, refs, "bottom")); break;
        case "deleteNode": deleteNodes(selectedNodes); break;
        case "cut": {
          const cur = useSession.getState().tool;
          useSession.getState().setTool(cur === "cut" ? "pen" : "cut");
          break;
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runVectorOp, runVerb, selectedRefs, deleteNodes, selectedNodes],
  );

  /** What the current selection supports — gates which toolbar/menu actions show.
   *  Armed-but-not-editing is a real state (you have the pen, you have not
   *  picked a path yet), so it returns a ctx rather than nothing: the toolbar is
   *  the pen's home and should not vanish the moment a path is deselected. */
  const penCtx = (): PenToolbarCtx => {
    const t = editClip();
    const cutActive = useSession.getState().tool === "cut";
    if (!t) {
      return {
        editing: false,
        nodeCount: 0,
        singleNode: false,
        adjacentPair: false,
        segment: null,
        endpointPair: false,
        anyClosed: false,
        anyOpen: false,
        cutActive,
      };
    }
    const subs = t.clip.subpaths;
    const refs = selectedRefs();
    const count = refs.length;
    const isEnd = (r: NodeRef) => {
      const sub = subs[r.sub];
      return !!sub && !sub.closed && sub.points.length >= 2 && (r.index === 0 || r.index === sub.points.length - 1);
    };
    let adjacentPair = false;
    let endpointPair = false;
    // Which segment (if any) the selection names, and whether it is already
    // curved — one read of the same brain the verbs use.
    const seg = segmentOf(subs, refs);
    let segment: "line" | "curve" | null = null;
    if (seg) {
      const sub = subs[seg.sub]!;
      const a = sub.points[seg.index]!;
      const b = sub.points[(seg.index + 1) % sub.points.length]!;
      segment = a.hOut || b.hIn ? "curve" : "line";
    }
    if (count === 2) {
      endpointPair = isEnd(refs[0]!) && isEnd(refs[1]!);
      if (refs[0]!.sub === refs[1]!.sub) {
        const sub = subs[refs[0]!.sub];
        if (sub) {
          const a = Math.min(refs[0]!.index, refs[1]!.index);
          const b = Math.max(refs[0]!.index, refs[1]!.index);
          adjacentPair = b - a === 1 || (sub.closed && a === 0 && b === sub.points.length - 1);
        }
      }
    }
    const subIdx = count > 0 ? new Set(refs.map((r) => r.sub)) : new Set(subs.map((_, i) => i));
    let anyClosed = false;
    let anyOpen = false;
    for (const i of subIdx) {
      const sub = subs[i];
      if (!sub) continue;
      if (sub.closed) anyClosed = true;
      else anyOpen = true;
    }
    return {
      editing: true,
      nodeCount: count,
      singleNode: count === 1,
      adjacentPair,
      segment,
      endpointPair,
      anyClosed,
      anyOpen,
      cutActive,
    };
  };

  // Pen drafting works in frame-centre coordinates (no pose yet).
  const frameLocalFromWorld = (w: { x: number; y: number }, frame: Frame) =>
    frameSpace(frame.id)?.fromWorld(w) ?? { x: w.x - frame.x - frame.width / 2, y: w.y - frame.y - frame.height / 2 };
  const frameLocalToWorld = (l: { x: number; y: number }, frame: Frame) =>
    frameSpace(frame.id)?.toWorld(l) ?? { x: frame.x + frame.width / 2 + l.x, y: frame.y + frame.height / 2 + l.y };
  const frameLocalFromScreen = (p: { x: number; y: number }, frame: Frame) =>
    frameLocalFromWorld(toWorld(p), frame);
  const frameLocalToScreen = (l: { x: number; y: number }, frame: Frame) =>
    worldToScreen(frameLocalToWorld(l, frame));

  /**
   * Edit the outline of a path clip inside a document update — THE way this
   * file writes geometry.
   *
   * Core's `editPathGeometry` reads the clip's box either side of the mutation
   * and re-bases the PIVOT across the change, so morphing moves the nodes you
   * grabbed and nothing else. Assigning `clip.subpaths` directly skips that and
   * is exactly the bug this indirection exists to make impossible: with a pivot
   * anywhere but the centre, every node drag used to slide the whole shape.
   */
  const editPath = (d: MotionDocument, clipId: string, fn: (clip: PathClip) => void) => {
    const loc = locateClip(d, clipId);
    if (loc?.clip.kind !== "path") return;
    const clip = loc.clip;
    editPathGeometry(clip, () => fn(clip));
  };

  // ── Pen commit / cancel ────────────────────────────────────────────────────

  /**
   * Turn the in-flight draft into a real clip.
   *
   * The pen STAYS ARMED afterwards — a drawing tool that drops you into the
   * selection arrow after every stroke is a tool you have to re-pick constantly,
   * and it is why "esc shouldn't kick me out of the pen" was the complaint.
   * `handOff` is for the one caller that means it: leaving the tool.
   */
  const commitDraft = React.useCallback(
    (closed: boolean, handOff = false) => {
      const draft = draftRef.current;
      setDraft(null);
      penDragRef.current = null;
      hoverRef.current = null;
      snapGuidesRef.current = { v: [], h: [] };
      dirtyRef.current = true;
      if (!draft || draft.points.length < 2) return;
      const subpaths: Contour[] = [{ closed, points: draft.points }];
      const b = subpathBounds(subpaths)!;
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      translateSubpaths(subpaths, -cx, -cy);
      // A POWER WINDOW was asked for — the outline you just drew IS the
      // window, so no layer is made. Open paths are closed on the way in: a
      // matte is an area, and an unclosed one has no inside.
      if (consumeRegionDraw(store, [{ closed: true, points: subpaths[0]!.points }], { x: cx, y: cy })) {
        useSession.getState().setTool("select");
        return;
      }
      const session = useSession.getState();
      // The pen tool's creation defaults (stroke colour/weight + closed-path
      // fill), edited in the per-tool inspector, applied headlessly.
      const pd = useToolDefaults.getState().pen;
      const clip = createPathClip({
        frameId: draft.frame.id,
        subpaths,
        startMs: session.playheadMs,
        durationMs: 5000,
        x: Math.round(cx),
        y: Math.round(cy),
        // Closed pen paths get a fill to feel solid; open ones stay a stroke.
        fill: closed ? pd.fill : null,
        stroke: strokeStyle(solidPaint(pd.stroke), { width: pd.strokeWidth, cap: "round", join: "round" }),
      });
      // THE SAME RULE EVERY OTHER CREATOR OBEYS. A new layer lands above the
      // layer you had selected — inside its group when a group is selected —
      // and only falls back to reusing a free lane when nothing selected is
      // actually here (see `placeAboveSelection`). The shape tool, the text
      // tool, library drops and media drops all ask it; the pen asked nobody,
      // so a pen stroke was born at the bottom of the stack no matter what you
      // were pointing at, and a path drawn "into" a group landed outside it.
      store.update("Draw path", (d) => placeClip(d, clip, placeAboveSelection(d, clip)));
      session.select([clip.id]);
      session.setActiveComp(draft.frame.id);
      if (handOff) session.setTool("select");
    },
    [store],
  );

  /**
   * End the stroke in flight and stay armed — the ONE exit every path out of
   * drawing goes through (esc, ⏎, double-click, landing on another path).
   *
   * It KEEPS what you drew. "Cancel" used to mean "throw the draft away", which
   * made esc a destructive key on a tool where esc is reflex: five careful
   * points, one keystroke, gone. Ending a path is the reversible reading, ⌘Z
   * still walks the nodes back one at a time, and every other surface here
   * treats esc as "leave this mode", not "undo this work".
   */
  const endRun = React.useCallback(() => {
    landingRef.current = null;
    setJunctionAt(null);
    if (draftRef.current) commitDraft(false);
    extendRef.current = null;
    penBranchRef.current = null;
    penDragRef.current = null;
    snapGuidesRef.current = { v: [], h: [] };
    dirtyRef.current = true;
  }, [commitDraft]);

  // ── Keyboard: commit / cancel / delete nodes ───────────────────────────────

  React.useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === "Enter" && (isDrawing() || landingRef.current)) {
        e.preventDefault();
        e.stopPropagation();
        // ⏎ answers an open junction with the remembered choice, else ends the
        // stroke. It never leaves the tool — that distinction is esc's.
        if (landingRef.current) commitLandingRef.current(useToolDefaults.getState().penJunction.connect);
        else endRun();
        return;
      }
      if (e.key === "Escape") {
        // Esc peels ONE layer, and only the layers that are this overlay's own
        // business: answer an open junction the non-committal way, end the
        // stroke, leave Cut back to Pen. Anything beyond that (closing the node
        // editor, dropping the tool, clearing the selection) falls through to
        // the app's single ladder in `use-shortcuts` rather than being
        // re-implemented here.
        //
        // The fall-through has to be EXPLICIT, because both listeners live on
        // window — this one in capture, that one in bubble. Without stopping
        // propagation on the rungs we handle, every press ran BOTH ladders: esc
        // ended your stroke and then dropped you out of the pen in one keystroke,
        // which is exactly the "it kicks me out of the tool" complaint.
        let handled = true;
        if (landingRef.current) commitLandingRef.current(false);
        else if (isDrawing()) endRun();
        else if (useSession.getState().tool === "cut") useSession.getState().setTool("pen");
        else handled = false;
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      // Undo while drawing a new path is the draft's own scope (`setDraft`)
      // and reaches here through history.ts like every other undo.
      const editing = !!useSession.getState().vectorEditClipId;
      if (editing && (e.key === "Backspace" || e.key === "Delete")) {
        // While editing points, ⌫ NEVER falls through to "delete the layer".
        e.preventDefault();
        e.stopPropagation();
        if (selectedNodes.size > 0) deleteNodes(selectedNodes);
        return;
      }
      // ⌘C/⌘X/⌘V operate on POINTS while node-editing (clip clipboard rests).
      const mod = e.metaKey || e.ctrlKey;
      if (editing && mod && !e.altKey && !e.shiftKey) {
        const k = eventKey(e);
        if (k === "c" && selectedNodes.size > 0) {
          e.preventDefault();
          e.stopPropagation();
          const n = copyPoints();
          if (n) toast(`Copied ${n} point${n > 1 ? "s" : ""}`);
          return;
        }
        if (k === "x" && selectedNodes.size > 0) {
          e.preventDefault();
          e.stopPropagation();
          const n = copyPoints();
          deleteNodes(selectedNodes);
          if (n) toast(`Cut ${n} point${n > 1 ? "s" : ""}`);
          return;
        }
        if (k === "v" && pointClipboard) {
          e.preventDefault();
          e.stopPropagation();
          pastePoints();
          return;
        }
        if (k === "j" && selectedNodes.size === 2) {
          e.preventDefault();
          e.stopPropagation();
          dispatchPen("join");
          return;
        }
      }
      // ⇧S / ⇧C convert selected nodes to smooth / corner; plain C toggles the
      // Cut tool. All gated on node-editing so they never hijack normal typing.
      if (editing && !mod && !e.altKey) {
        const k = eventKey(e);
        if (e.shiftKey && (k === "s" || k === "c") && selectedNodes.size > 0) {
          e.preventDefault();
          e.stopPropagation();
          dispatchPen(k === "s" ? "smooth" : "corner");
          return;
        }
        if (!e.shiftKey && k === "c") {
          e.preventDefault();
          e.stopPropagation();
          dispatchPen("cut");
          return;
        }
      }
    };
    // Capture phase: the app-wide delete shortcut would delete the CLIP.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, commitDraft, copyPoints, deleteNodes, dispatchPen, endRun, pastePoints, selectedNodes, store]);

  // Leaving the pen tool ends the stroke — through the same exit esc uses, so
  // "what happens to what I drew" has one answer and not two.
  React.useEffect(() => {
    if (tool !== "pen" && (isDrawing() || landingRef.current)) endRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // Focus-then-Pen: if a node is selected and you arm the pen, immediately
  // continue the path FROM that node (when it's an open endpoint) — the rubber
  // band leads from it and your next click keeps drawing that path (Figma).
  React.useEffect(() => {
    if (tool !== "pen" || isDrawing() || landingRef.current) return;
    const t = editClip();
    if (!t) return;
    // Arming the pen on a selected node does EXACTLY what clicking that node
    // with the pen does — same landing, same brain, so an open end continues
    // and an interior node branches.
    //
    // It used to scan the open endpoints for any that happened to be selected
    // and take the first one found. With an interior node selected that matched
    // nothing and the next click extended some unrelated end; with two ends
    // selected it picked whichever came first in subpath order. Neither was the
    // node you had in your hand.
    const keys = [...selectedNodes];
    const first = keys[0] ? parseKey(t.clip, keys[0]) : null;
    if (!first) return;
    const group = new Set(weldGroup(t.clip.subpaths, first).map((r) => keyOf(t.clip, r)));
    // One node — itself, or every arm of one junction. Anything wider is a
    // multi-node selection, which names no single place to draw from.
    if (keys.some((k) => !group.has(k))) return;
    if (!t.clip.subpaths[first.sub]?.points[first.index]) return;
    beginRunAt(
      { clipId: t.clip.id, site: { kind: "anchor", sub: first.sub, index: first.index }, end: isOpenEnd(t.clip.subpaths, first) },
      t,
    );
    hoverRef.current = null;
    dirtyRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, selectedNodes]);

  // A node selection belongs to the path being edited, so it dies with it —
  // however you left. Clearing it only on the exits that remembered to is how a
  // stale "2 nodes selected" survived into the next path you opened.
  React.useEffect(() => {
    if (editClipId === null) setSelectedNodes(new Set());
  }, [editClipId]);

  // Track ⇧ live so the pen's rubber-band preview snaps/unsnaps the instant the
  // key toggles, even with the cursor held still (redraw on change). Blur clears
  // it so a tab-switch never leaves the constraint stuck on.
  React.useEffect(() => {
    if (!active) return;
    const sync = (shift: boolean, mod: boolean) => {
      if (shift !== shiftRef.current || mod !== modRef.current) {
        shiftRef.current = shift;
        modRef.current = mod;
        dirtyRef.current = true;
      }
    };
    // The modifier store, not the keyboard: the touch puck latches ⌘/⌥/⇧ too,
    // and the cursor must preview the mode the instant either source changes.
    const unsub = subscribeMods(() => {
      const m = currentMods();
      sync(m.shift, m.meta);
      if (altHeldRef.current !== m.alt) {
        altHeldRef.current = m.alt;
        dirtyRef.current = true;
      }
    });
    const onBlur = () => sync(false, false);
    window.addEventListener("blur", onBlur);
    return () => {
      unsub();
      window.removeEventListener("blur", onBlur);
    };
  }, [active]);

  // ── Landing on existing geometry ───────────────────────────────────────────

  /**
   * Pick the pen up ON existing geometry and keep drawing from there.
   *
   * One path for both halves of the ask: land on a node and you continue from
   * it; land on a curve and the curve GROWS the node first (an exact de
   * Casteljau split, so the outline does not move) and then you continue from
   * THAT node. Inserting mid-line and drawing on is not a special mode with its
   * own rules — it is the ordinary gesture with one extra step, which is why it
   * used to fail: it was written as a separate two-click dance that only ran on
   * the one clip you had double-clicked into.
   *
   * Whether continuing means "extend this run" or "branch a new one" is not a
   * preference either — it is `isOpenEnd`. A node with two neighbours already
   * has both of them, so a third line out of it can only be a second run that
   * meets it there.
   */
  const beginRunAt = (landing: PenLanding, target: { clip: PathClip; frame: Frame }) => {
    const clipId = target.clip.id;
    let ref: NodeRef | null =
      landing.site.kind === "anchor" ? { sub: landing.site.sub, index: landing.site.index } : null;
    if (!ref) {
      let made: NodeRef | null = null;
      store.update("Add point", (d) =>
        editPath(d, clipId, (c) => {
          made = anchorAtSite(c.subpaths, landing.site);
        }),
      );
      ref = made;
    }
    if (!ref) return;
    // Re-read: the split just changed the geometry we are about to reason about.
    const loc = locateClip(store.getState(), clipId);
    if (loc?.clip.kind !== "path") return;
    const pt = loc.clip.subpaths[ref.sub]?.points[ref.index];
    if (!pt) return;
    const end = isOpenEnd(loc.clip.subpaths, ref);
    // Drawing needs the clip in node-edit — so clicking a path with the pen puts
    // it there, instead of silently doing nothing until you found the gesture
    // that does.
    useSession.getState().setVectorEdit(clipId);
    setSelectedNodes(new Set([keyOf(loc.clip, ref)]));
    if (end) {
      extendRef.current = { clipId, sub: ref.sub, end };
      penBranchRef.current = null;
    } else {
      penBranchRef.current = { clipId, seedLocal: { x: pt.x, y: pt.y }, seedRef: ref };
      extendRef.current = null;
    }
    penDragRef.current = null;
    dirtyRef.current = true;
  };

  /** Freeze the stroke in flight as a plan, and either ask or apply. */
  const landOn = (res: PenResolution) => {
    const landing = res.intent.kind === "fuse" || res.intent.kind === "attach" ? res.intent.landing : null;
    if (!landing || !res.target || !res.screen) return false;
    const ext = extendRef.current;
    const branch = penBranchRef.current;
    const from: LandingPlan["from"] | null = draftRef.current
      ? { kind: "draft" }
      : ext
        ? { kind: "extend", clipId: ext.clipId, sub: ext.sub, end: ext.end }
        : branch
          ? { kind: "branch", clipId: branch.clipId, seedLocal: branch.seedLocal, seedRef: branch.seedRef }
          : null;
    if (!from) return false;
    const rect = canvasRef.current!.getBoundingClientRect();
    landingRef.current = {
      targetClipId: landing.clipId,
      site: landing.site,
      world: toWorld(res.screen),
      client: { x: rect.left + res.screen.x, y: rect.top + res.screen.y },
      from,
    };
    const pref = useToolDefaults.getState().penJunction;
    if (pref.ask) {
      setJunctionAt(landingRef.current.client);
      dirtyRef.current = true;
    } else {
      commitLanding(pref.connect);
    }
    return true;
  };

  /**
   * Resolve a landing: the stroke's last node goes on the target, and — when
   * `connect` — the two runs become one path.
   *
   * Both answers are THIS function; only the boolean differs. That is what lets
   * the prompt sit before the mutation rather than after it: "keep apart" never
   * has to un-weld anything, no snapshot has to be kept alive to undo a guess,
   * and either answer lands as exactly one history entry.
   */
  const commitLanding = (connect: boolean) => {
    const plan = landingRef.current;
    landingRef.current = null;
    setJunctionAt(null);
    dirtyRef.current = true;
    if (!plan) return;
    const doc = store.getState();
    const tLoc = locateClip(doc, plan.targetClipId);
    const tClip = tLoc?.clip.kind === "path" ? tLoc.clip : null;
    const tFrame = tClip ? doc.frames.find((f) => f.id === tClip.frameId) : null;
    if (!tClip || !tFrame) {
      endRun();
      return;
    }
    const landLocal = worldToClipLocal(plan.world, tClip, tFrame);
    const from = plan.from;

    // Where the stroke lives now, when it lives in a clip at all.
    const sLoc = from.kind === "draft" ? null : locateClip(doc, from.clipId);
    const sClip = sLoc?.clip.kind === "path" ? sLoc.clip : null;
    const sFrame = sClip ? doc.frames.find((f) => f.id === sClip.frameId) : null;

    // ── Keep apart: the stroke just ends here. The other path is not touched at
    // all — not even a node inserted on it, because "apart" means leave it be.
    if (!connect) {
      if (from.kind === "draft") {
        const d = draftRef.current;
        if (d) {
          const l = frameLocalFromWorld(plan.world, d.frame);
          d.points.push({ x: l.x, y: l.y, hIn: null, hOut: null });
        }
      } else if (sClip && sFrame) {
        const l = worldToClipLocal(plan.world, sClip, sFrame);
        store.update(from.kind === "branch" ? "Branch path" : "Extend path", (d) =>
          editPath(d, from.clipId, (c) => {
            const np: PathPoint = { x: l.x, y: l.y, hIn: null, hOut: null };
            if (from.kind === "branch") {
              // "Keep apart" answers the FAR end. The start of a branch is still
              // the node you branched from.
              const weldId = weldIdAt(c.subpaths, from.seedRef) ?? undefined;
              c.subpaths.push({
                id: newContourId(),
                closed: false,
                points: [{ x: from.seedLocal.x, y: from.seedLocal.y, hIn: null, hOut: null, weldId }, np],
              });
              return;
            }
            const sub = c.subpaths[from.sub];
            if (!sub) return;
            if (from.end === "tail") sub.points.push(np);
            else sub.points.unshift(np);
          }),
        );
      }
      endRun();
      return;
    }

    // ── Connect: hand the whole stroke to the target clip and weld it there.
    // The stroke always moves TO the path it landed on, never the other way —
    // one direction means one set of rules, and it keeps the object you aimed at
    // as the thing that survives.
    const toTarget = (w: Pt) => worldToClipLocal(w, tClip, tFrame);
    const landPoint: PathPoint = { x: landLocal.x, y: landLocal.y, hIn: null, hOut: null };

    if (from.kind === "draft") {
      const d = draftRef.current;
      if (!d) {
        endRun();
        return;
      }
      const conv = (pt: Pt) => toTarget(frameLocalToWorld(pt, d.frame));
      const points = d.points.map((pt) => ({
        ...conv(pt),
        hIn: pt.hIn ? conv(pt.hIn) : null,
        hOut: pt.hOut ? conv(pt.hOut) : null,
      }));
      points.push(landPoint);
      setDraft(null);
      store.update("Connect path", (dd) =>
        editPath(dd, tClip.id, (c) => {
          weldRun(c.subpaths, { closed: false, points }, plan.site);
        }),
      );
      finishAtTarget(tClip.id);
      return;
    }

    if (!sClip || !sFrame) {
      endRun();
      return;
    }
    const sameClip = sClip.id === tClip.id;
    const conv = sameClip ? (pt: Pt) => ({ x: pt.x, y: pt.y }) : (pt: Pt) => toTarget(clipLocalToWorld(pt, sClip, sFrame));
    const mapPoint = (pt: PathPoint): PathPoint => ({
      ...conv(pt),
      hIn: pt.hIn ? conv(pt.hIn) : null,
      hOut: pt.hOut ? conv(pt.hOut) : null,
    });

    if (from.kind === "branch") {
      const points = [mapPoint({ x: from.seedLocal.x, y: from.seedLocal.y, hIn: null, hOut: null }), landPoint];
      store.update("Connect path", (dd) =>
        editPath(dd, tClip.id, (c) => {
          // Both ends are junctions. The start one only survives when the branch
          // stays in the clip it grew from — a weld names a node inside ONE
          // clip's geometry, and moving the run to another clip leaves its seed
          // behind. (Cross-clip branches keep the landing weld and lose this one.)
          if (sameClip) points[0]!.weldId = weldIdAt(c.subpaths, from.seedRef) ?? undefined;
          weldRun(c.subpaths, { closed: false, points }, plan.site);
        }),
      );
      finishAtTarget(tClip.id);
      return;
    }

    // A stroke that came back to touch its OWN run cannot be moved somewhere
    // else — it is already there. It just grows the node it landed on and one
    // more of its own that sits exactly on top.
    if (sameClip && plan.site.sub === from.sub) {
      store.update("Attach path", (dd) =>
        editPath(dd, tClip.id, (c) => {
          const ref = anchorAtSite(c.subpaths, plan.site);
          const at = ref ? c.subpaths[ref.sub]?.points[ref.index] : null;
          const sub = c.subpaths[from.sub];
          if (!at || !sub) return;
          const np: PathPoint = { x: at.x, y: at.y, hIn: null, hOut: null };
          if (from.end === "tail") sub.points.push(np);
          else sub.points.unshift(np);
        }),
      );
      finishAtTarget(tClip.id);
      return;
    }

    // The run, oriented so the end that landed is LAST — weldRun's contract.
    const runSub: Contour = {
      closed: false,
      points: (sClip.subpaths[from.sub]?.points ?? []).map((pt) => ({
        x: pt.x,
        y: pt.y,
        hIn: pt.hIn ? { ...pt.hIn } : null,
        hOut: pt.hOut ? { ...pt.hOut } : null,
      })),
    };
    if (runSub.points.length === 0) {
      endRun();
      return;
    }
    if (from.end === "head") reverseSubpaths([runSub]);
    const points = runSub.points.map(mapPoint);
    points.push(landPoint);

    store.update("Connect paths", (dd) => {
      // Take the stroke out of where it lived...
      editPath(dd, from.clipId, (c) => {
        c.subpaths.splice(from.sub, 1);
      });
      // ...and weld it into the target. Indices shift when both lived in one clip.
      const site: PenSite =
        sameClip && plan.site.sub > from.sub ? { ...plan.site, sub: plan.site.sub - 1 } : plan.site;
      editPath(dd, tClip.id, (c) => {
        weldRun(c.subpaths, { closed: false, points }, site);
      });
      // A clip whose last run just moved away is an empty object nobody can
      // select, reach in the layer tree, or delete. Merging two paths means one
      // path survives.
      const left = locateClip(dd, from.clipId);
      if (!sameClip && left?.clip.kind === "path" && left.clip.subpaths.length === 0) deleteClip(dd, from.clipId);
    });
    finishAtTarget(tClip.id);
  };

  /** The keyboard listener outlives a render, so it reaches the CURRENT landing
   *  resolver through a ref — the same pattern the nudge target uses. */
  const commitLandingRef = React.useRef(commitLanding);
  commitLandingRef.current = commitLanding;

  /** After a connect: the target is now the path you are working on. */
  const finishAtTarget = (clipId: string) => {
    extendRef.current = null;
    penBranchRef.current = null;
    penDragRef.current = null;
    setDraft(null);
    snapGuidesRef.current = { v: [], h: [] };
    useSession.getState().setVectorEdit(clipId);
    setSelectedNodes(new Set());
    dirtyRef.current = true;
  };

  // ── Pointer handlers ───────────────────────────────────────────────────────

  /**
   * ⌘-press on a segment of the edited path arms a BEND (D12) — in node edit,
   * and with the pen when no run is in flight. Returns whether it armed.
   */
  const tryBeginBend = (p: Pt, e: React.PointerEvent): boolean => {
    if (!gestureMods(e).meta && usePenBar.getState().mode !== "bend") return false;
    const target = editClip();
    if (!target) return false;
    const seg = hitSegment(p, target.clip, target.frame, PATH_HIT.segment);
    if (!seg) return false;
    bakeSampledGeometry(target.clip, `vec-edit-${target.clip.id}-${e.pointerId}`);
    const fresh = editClip();
    if (!fresh) return false;
    const grab = beginBend(fresh.clip.subpaths, seg.sub, seg.index, clipLocalFromScreen(p, fresh.clip, fresh.frame));
    if (!grab) return false;
    const sub = fresh.clip.subpaths[seg.sub]!;
    setSelectedNodes(new Set([nodeKey(sub.id, seg.index), nodeKey(sub.id, (seg.index + 1) % sub.points.length)]));
    editDragRef.current = { kind: "bend", sub: seg.sub, index: seg.index, grab };
    dirtyRef.current = true;
    return true;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);
    const p = localPoint(e);

    // ── Cut tool (knife): arm the stroke. A plain click cuts one point on
    // release; a drag draws a straight cut line (dashed preview) and slices
    // every vector it crosses on release. Works on ANY path in the frame and
    // stays armed for repeated cuts (Esc exits Cut → Pen).
    if (useSession.getState().tool === "cut") {
      knifeRef.current = { start: p, frameId: frameAtWorld(toWorld(p)), moved: false };
      hoverRef.current = p;
      dirtyRef.current = true;
      return;
    }

    if (useSession.getState().tool === "pen") {
      const editing = editClip();

      // An open junction owns the next click: answering it IS the click. The
      // remembered choice applies, so a second click never lands a stray node.
      if (landingRef.current) {
        commitLanding(useToolDefaults.getState().penJunction.connect);
        return;
      }

      // One resolution, shared with the paint pass and the cursor: whatever the
      // chrome promised under this pixel is exactly what runs here.
      const res = resolvePen(p);
      if ((res.intent.kind === "start" || res.intent.kind === "resume") && tryBeginBend(p, e)) return;
      if (res.intent.kind === "resume" && res.target) {
        beginRunAt(res.intent.landing, res.target);
        return;
      }
      if ((res.intent.kind === "fuse" || res.intent.kind === "attach") && landOn(res)) return;
      // `close` falls through: closing is the business of whichever run is in
      // flight, and both of those already know how to do it.

      // (0) Branch from a just-inserted mid-path point: the previous click added
      // a point ON a segment; THIS click spawns a fresh run out of it so drawing
      // keeps going from that exact point (not some other endpoint).
      if (penBranchRef.current) {
        const bref = penBranchRef.current;
        penBranchRef.current = null;
        const t = editing?.clip.id === bref.clipId ? editing : null;
        if (t) {
          const local = resolveDrawPoint(
            bref.seedLocal,
            clipLocalFromScreen(p, t.clip, t.frame),
            e.shiftKey,
            t.clip.frameId,
            new Set([t.clip.id]),
            clipNodesWorld(t.clip, t.frame, new Set()),
            e.metaKey || e.ctrlKey,
            (l) => clipLocalToWorld(l, t.clip, t.frame),
            (w) => worldToClipLocal(w, t.clip, t.frame),
          );
          let newSub = -1;
          store.update("Branch path", (d) =>
            editPath(d, bref.clipId, (clip) => {
              // The branch starts AT the node you clicked, not at a copy of its
              // coordinates. Stamping both with one id is what makes the ⊕ add a
              // point the new line is actually attached to — the same junction
              // the far end gets when a stroke lands, and for the same reason.
              const weldId = weldIdAt(clip.subpaths, bref.seedRef) ?? undefined;
              clip.subpaths.push({
                id: newContourId(),
                closed: false,
                points: [
                  { x: bref.seedLocal.x, y: bref.seedLocal.y, hIn: null, hOut: null, weldId },
                  { x: local.x, y: local.y, hIn: null, hOut: null },
                ],
              });
              newSub = clip.subpaths.length - 1;
            }),
          );
          if (newSub >= 0) {
            extendRef.current = { clipId: bref.clipId, sub: newSub, end: "tail" };
            penDragRef.current = { kind: "extend", clipId: bref.clipId, sub: newSub, index: 1, startScreen: p, latched: false };
            setSelectedNodes(new Set([`${newSub}:1`]));
          }
          dirtyRef.current = true;
          return;
        }
      }

      // (A) Already continuing an open path: each click appends/prepends a node
      // (the path stays active) or closes on the run's start — one shared path.
      if (extendRef.current) {
        if (appendOrCloseExtend(extendRef.current, p, e)) return;
        extendRef.current = null; // clip vanished — fall through to a fresh draft
      }

      if (editing && !draftRef.current) {
        // (B) Empty-space click while editing an OPEN path → CONTINUE it from the
        // selected/nearest endpoint instead of starting a disconnected path. This
        // is the fix for "it just drops the point and won't let me keep drawing":
        // you don't have to hit the tiny endpoint — editing + clicking extends.
        // (Clicks ON geometry never reach here; `resolvePen` claimed them above.)
        const chosen = pickContinuationEnd(editing.clip, editing.frame, p);
        if (chosen) {
          extendRef.current = chosen;
          if (appendOrCloseExtend(chosen, p, e)) return;
        }
      }
      // WHERE A NEW PATH IS BORN — one answer, `frameAtWorld`, which knows that
      // being drilled in beats any board hit-test. This used to be a third
      // inline copy of "find the artboard whose rectangle contains the cursor",
      // and inside a flipbook cell it found the PAGE frame painted behind the
      // cell — so the stroke you drew in the cell committed to its grandparent.
      const doc = store.getState();
      const frameId = draftRef.current?.frame.id ?? frameAtWorld(toWorld(p));
      const frame = frameId ? doc.frames.find((f) => f.id === frameId) : undefined;
      if (!frame) {
        toast("Add a frame first");
        return;
      }
      let draft = draftRef.current;
      if (!draft) {
        draft = { frame, points: [] };
        setDraft(draft);
      }
      // Clicking the first point closes the path.
      if (draft.points.length >= 2) {
        const first = frameLocalToScreen(draft.points[0]!, draft.frame);
        if (Math.hypot(p.x - first.x, p.y - first.y) <= CLOSE_HIT) {
          commitDraft(true);
          return;
        }
      }
      // ⇧ locks the segment angle from the previous anchor AND still snaps along
      // that ray; without ⇧ it snaps freely. Frame-local ⇄ world rides the frame's
      // own chain, so drafting inside a nested comp lands where the cursor is.
      const l = resolveDrawPoint(
        draft.points.length > 0 ? draft.points[draft.points.length - 1]! : null,
        frameLocalFromScreen(p, draft.frame),
        e.shiftKey,
        draft.frame.id,
        new Set(),
        draftNodesWorld(draft),
        e.metaKey || e.ctrlKey,
        (loc) => frameLocalToWorld(loc, draft.frame),
        (w) => frameLocalFromWorld(w, draft.frame),
      );
      draft.points.push({ x: l.x, y: l.y, hIn: null, hOut: null });
      draftRedoRef.current = []; // a new node invalidates the redo stack
      penDragRef.current = { kind: "draft", index: draft.points.length - 1, startScreen: p, latched: false };
      dirtyRef.current = true;
      return;
    }

    // Node-edit mode.
    const target = editClip();
    if (!target) return;
    // Morphing: when geometry keys own the outline, bake the SAMPLED geometry
    // into the base first — the points you grab are the points you see, and
    // the release keys exactly what you edited.
    bakeSampledGeometry(target.clip, `vec-edit-${target.clip.id}-${e.pointerId}`);
    const refreshed = editClip();
    if (!refreshed) return;
    const { clip, frame } = refreshed;
    if (tryBeginBend(p, e)) return;

    // Section transform box (≥2 selected nodes): a grip resizes; the interior
    // moves. Checked before the node hit-tests so the box behaves like a shape.
    const sb = sectionBoxLocal(clip);
    if (sb) {
      const handle = hitBoxHandle(p, clip, frame, sb);
      if (handle) {
        beginSectionDrag("resize", handle, clip, frame, sb, p, e);
        return;
      }
    }

    // Handles first (they sit near anchors), then anchors.
    for (let s = 0; s < clip.subpaths.length; s++) {
      const sub = clip.subpaths[s]!;
      for (let i = 0; i < sub.points.length; i++) {
        const pt = sub.points[i]!;
        for (const side of ["hIn", "hOut"] as const) {
          const h = pt[side];
          if (!h || !selectedNodes.has(nodeKey(sub.id, i))) continue;
          const hs = clipLocalToScreen(h, clip, frame);
          if (Math.hypot(p.x - hs.x, p.y - hs.y) <= ANCHOR_HIT) {
            const partner = pt[side === "hIn" ? "hOut" : "hIn"];
            editDragRef.current = {
              kind: "handle",
              sub: s,
              index: i,
              side,
              // A path point stores its arms ABSOLUTE, so they become vectors
              // from the anchor here — the only difference from a motion key.
              drag: beginTangentDrag(
                { x: h.x - pt.x, y: h.y - pt.y },
                partner ? { x: partner.x - pt.x, y: partner.y - pt.y } : null,
              ),
            };
            return;
          }
        }
      }
    }
    for (let s = 0; s < clip.subpaths.length; s++) {
      const sub = clip.subpaths[s]!;
      for (let i = 0; i < sub.points.length; i++) {
        const a = clipLocalToScreen(sub.points[i]!, clip, frame);
        if (Math.hypot(p.x - a.x, p.y - a.y) <= ANCHOR_HIT) {
          const key = nodeKey(sub.id, i);
          setSelectedNodes((prev) => {
            if (e.shiftKey) {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            }
            return prev.has(key) ? prev : new Set([key]);
          });
          const ap = sub.points[i]!;
          const lp = clipLocalFromScreen(p, clip, frame);
          editDragRef.current = {
            kind: "anchor",
            sub: s,
            index: i,
            start: { ax: ap.x, ay: ap.y, px: lp.x, py: lp.y },
          };
          return;
        }
      }
    }
    // Inside the current section box (no node grabbed) → drag MOVES the whole
    // selection (Figma). A plain click without movement keeps the selection.
    if (sb && insideSelectionBox(p, clip, frame, sb)) {
      beginSectionDrag("move", null, clip, frame, sb, p, e);
      return;
    }

    // On the OUTLINE between two anchors: select that SEGMENT.
    //
    // A segment IS its two bounding anchors, so selecting it is selecting them
    // — no second selection dimension to keep in step, and every segment verb
    // reads the same set the node verbs do. Sits between the anchor hit above
    // (more specific) and the fill click below (less), which is the order
    // Illustrator and Figma both resolve in.
    const segHit = hitSegment(p, clip, frame, PATH_HIT.segment);
    if (segHit) {
      const seg = clip.subpaths[segHit.sub]!;
      const ends = [
        nodeKey(seg.id, segHit.index),
        nodeKey(seg.id, (segHit.index + 1) % seg.points.length),
      ];
      if (e.shiftKey) {
        setSelectedNodes((prev) => new Set([...prev, ...ends]));
        return;
      }
      // Press-and-drag moves the segment as itself (Illustrator's direct
      // selection): the keys go in explicitly because the state set above has
      // not landed yet.
      const keys = new Set(ends);
      setSelectedNodes(keys);
      const bounds = selectionBoundsLocal(clip, keys);
      if (bounds) beginSectionDrag("move", null, clip, frame, bounds, p, e, keys);
      return;
    }

    // Clicking a SUBPATH (its fill) selects that whole section — all of its
    // nodes at once — so you can transform it as one object.
    const subHit = hitSubpath(p, clip, frame);
    if (subHit !== null) {
      const keys = subpathKeys(clip, subHit);
      setSelectedNodes((prev) => (e.shiftKey ? new Set([...prev, ...keys]) : new Set(keys)));
      return;
    }

    // Empty space: rubber-band select points (a plain click just deselects;
    // double-click outside exits — Figma).
    marqueeRef.current = { start: p, current: p, additive: e.shiftKey, base: new Set(selectedNodes) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = localPoint(e);
    altHeldRef.current = gestureMods(e).alt;
    dirtyRef.current = true;
    const bend = editDragRef.current;
    if (bend?.kind === "bend") {
      hoverRef.current = p;
      const target = editClip();
      if (!target || e.buttons !== 1) return;
      const to = clipLocalFromScreen(p, target.clip, target.frame);
      store.update(
        "Bend path",
        (d) => editPath(d, target.clip.id, (clip) => void applyBend(clip.subpaths, bend.grab, to)),
        { mergeKey: `vec-edit-${target.clip.id}-${e.pointerId}` },
      );
      return;
    }
    // Every mode tracks the cursor now, not just the pen and the knife: nodes
    // and tangent knobs light up under the pointer in plain node-edit too, so
    // the grab radius is something you feel before you commit to a press.
    hoverRef.current = p;

    // Cut tool: track the cursor (drives the outline hit-marker preview) and, once
    // the pointer has travelled a few px while held, mark the stroke as a knife
    // DRAG so the draw loop shows the dashed cut line. The actual cut happens on
    // release (one clean undo step).
    if (useSession.getState().tool === "cut") {
      hoverRef.current = p;
      const kn = knifeRef.current;
      if (kn && e.buttons === 1 && !kn.moved && Math.hypot(p.x - kn.start.x, p.y - kn.start.y) > 4) {
        kn.moved = true;
      }
      dirtyRef.current = true;
      return;
    }

    if (useSession.getState().tool === "pen") {
      hoverRef.current = p;
      shiftRef.current = e.shiftKey;
      const pd = penDragRef.current;
      if (pd && e.buttons === 1) {
        // Dragging a freshly-placed point pulls smooth handles out of it; ⌥
        // breaks the mirror and steers only the leading handle. Same gesture
        // whether the point lives in the uncommitted draft or an extended clip.
        //
        // The latch is what keeps a CLICK a click: until the pointer has really
        // travelled, this writes nothing and the new point stays the hard corner
        // it was placed as. Once latched it never un-latches, so steering back
        // toward the anchor keeps tracking instead of going numb.
        if (!pd.latched) {
          if (!passedDragLatch(pd.startScreen, p)) return;
          pd.latched = true;
        }
        if (pd.kind === "draft") {
          const draft = draftRef.current;
          const pt = draft?.points[pd.index];
          if (draft && pt) {
            const l = frameLocalFromScreen(p, draft.frame);
            editPointHandlesFromAnchor(pt, { x: l.x, y: l.y }, !e.altKey);
            dirtyRef.current = true;
          }
        } else {
          const refreshed = editClip();
          if (refreshed && refreshed.clip.id === pd.clipId) {
            const { clip, frame } = refreshed;
            const l = clipLocalFromScreen(p, clip, frame);
            store.update(
              "Curve node",
              (d) =>
                editPath(d, pd.clipId, (c) => {
                  const pt = c.subpaths[pd.sub]?.points[pd.index];
                  if (pt) editPointHandlesFromAnchor(pt, { x: l.x, y: l.y }, !e.altKey);
                }),
              { mergeKey: `vec-extend-${pd.clipId}-${e.pointerId}` },
            );
          }
        }
      }
      return;
    }

    // Section transform box drag (move / resize / object-scale).
    if (sectionDragRef.current && e.buttons === 1) {
      updateSectionDrag(p, e);
      return;
    }

    // Marquee point selection.
    const mq = marqueeRef.current;
    if (mq && e.buttons === 1) {
      mq.current = p;
      const t = editClip();
      if (t) {
        const minX = Math.min(mq.start.x, p.x);
        const maxX = Math.max(mq.start.x, p.x);
        const minY = Math.min(mq.start.y, p.y);
        const maxY = Math.max(mq.start.y, p.y);
        const next = new Set(mq.additive ? mq.base : []);
        for (let s = 0; s < t.clip.subpaths.length; s++) {
          const sub = t.clip.subpaths[s]!;
          for (let i = 0; i < sub.points.length; i++) {
            const sp = clipLocalToScreen(sub.points[i]!, t.clip, t.frame);
            if (sp.x >= minX && sp.x <= maxX && sp.y >= minY && sp.y <= maxY) next.add(nodeKey(sub.id, i));
          }
        }
        setSelectedNodes(next);
      }
      return;
    }

    const drag = editDragRef.current;
    if (!drag || e.buttons !== 1) return;
    if (drag.kind === "bend") return; // handled at the top of the move
    const target = editClip();
    if (!target) return;
    const { clip, frame } = target;
    const l = clipLocalFromScreen(p, clip, frame);
    // Plain anchor move (no ⇧/⌥) snaps to guides/siblings — computed HERE, before
    // the doc update, so candidates read the committed doc (not the mid-edit
    // draft) and never let the node snap to its own path. ⇧/⌥ opt out.
    let anchorLocal = l;
    if (drag.kind === "anchor" && !e.shiftKey && !e.altKey) {
      // The moving anchors are excluded so a node never snaps to itself; every
      // OTHER anchor of this path is a candidate (node-to-node).
      const dragKey = keyOf(clip, drag);
      const moving = selectedNodes.has(dragKey) ? selectedNodes : new Set([dragKey]);
      const w = snapWorld(
        toWorld(p),
        clip.frameId,
        new Set([clip.id]),
        e.metaKey || e.ctrlKey,
        clipNodesWorld(clip, frame, moving),
      );
      anchorLocal = worldToClipLocal(w, clip, frame);
    } else {
      snapGuidesRef.current = { v: [], h: [] };
    }

    store.update(
      "Edit path",
      (d) =>
        editPath(d, clip.id, (clip) => {
          const sub = clip.subpaths[drag.sub];
          const pt = sub?.points[drag.index];
          if (!sub || !pt) return;

          if (drag.kind === "anchor") {
            if (e.altKey) {
              // ⌥ on the point pulls a fresh MIRRORED pair out of it and keeps
              // both sides tracking for the whole drag — the same gesture the
              // motion path has always had.
              editPointHandlesFromAnchor(pt, { x: l.x, y: l.y });
              return;
            }
            // ⇧ constrains the anchor to a snapped axis from its press position;
            // otherwise it rides the SNAPPED point (anchorLocal). Same headless
            // rules as the stage layer drag. The primary anchor's delta drives
            // every selected anchor (below), so this governs the whole move.
            let tx = anchorLocal.x;
            let ty = anchorLocal.y;
            if (e.shiftKey) {
              const c = constrainDragToAngle(l.x - drag.start.px, l.y - drag.start.py);
              tx = drag.start.ax + c.dx;
              ty = drag.start.ay + c.dy;
            }
            const dx = tx - pt.x;
            const dy = ty - pt.y;
            // Move every selected anchor by the same delta (multi-select drag).
            const key = keyOf(clip, drag);
            const moving = selectedNodes.has(key) ? selectedNodes : new Set([key]);
            translateNodes(clip.subpaths, refsOf(clip, moving), dx, dy);
          } else {
            // The WHOLE gesture — ⇧ angle lock, the ⌥ toggle, dissolving back
            // into a corner — comes from the shared brain, exactly as the motion
            // path's tangents do. This surface only maps storage: absolute
            // handle coordinates in, vectors from the anchor out.
            const view = useStageView.getState();
            const res = resolveTangentDrag(drag.drag, {
              vector: { x: l.x - pt.x, y: l.y - pt.y },
              alt: e.altKey,
              shift: e.shiftKey,
              dissolveWithin: PATH_HIT.handleDissolve / Math.max(0.001, view.scale),
            });
            if (!res.dragged) {
              pt[drag.side] = null;
            } else {
              // The partner is exactly what the rule says — mirrored, turned
              // at its own length (a smooth node with uneven arms), or left.
              pt[drag.side] = { x: pt.x + res.dragged.x, y: pt.y + res.dragged.y };
              if (res.partner) pt[drag.side === "hIn" ? "hOut" : "hIn"] = { x: pt.x + res.partner.x, y: pt.y + res.partner.y };
            }
          }
        }),
      { mergeKey: `vec-edit-${clip.id}-${e.pointerId}` },
    );
  };

  const onPointerUp = () => {
    // Cut tool: commit the knife on release. A drag slices along its line; a
    // plain click cuts the single point under the cursor. Both stay armed.
    const kn = knifeRef.current;
    if (kn) {
      knifeRef.current = null;
      const end = hoverRef.current ?? kn.start;
      const frameId = kn.frameId ?? frameAtWorld(toWorld(kn.start));
      if (frameId) {
        const n = kn.moved ? knifeCut(toWorld(kn.start), toWorld(end), frameId) : pointCut(kn.start, frameId);
        if (n > 0) toast(`Cut ${n} place${n > 1 ? "s" : ""}`);
      }
      dirtyRef.current = true;
      return;
    }

    const mq = marqueeRef.current;
    if (mq) {
      const moved = Math.hypot(mq.current.x - mq.start.x, mq.current.y - mq.start.y) > 3;
      if (!moved) setSelectedNodes(new Set()); // plain click on empty = deselect points
      marqueeRef.current = null;
    }
    // A finished node/handle/section edit keys the geometry when the outline is
    // keyed (or record mode is on) — vector morphing records itself.
    // A press that never moved (picking a segment) edited nothing — no key.
    if (editDragRef.current || (sectionDragRef.current && sectionDragRef.current.moved)) {
      const target = editClip();
      if (target) keyGeometryIfAnimating(target.clip.id);
    }
    penDragRef.current = null;
    editDragRef.current = null;
    sectionDragRef.current = null;
    snapGuidesRef.current = { v: [], h: [] }; // stop flashing guides on release
    dirtyRef.current = true;
  };

  /**
   * The overlay's door is the SAME `useTouchIntent` the stage and the drawing
   * overlay mount, for the same reasons — and it was the third door, the one
   * nobody had wired. So a finger with "pen only" on drew paths anyway, and a
   * finger that meant to pan the canvas placed a node the instant it landed.
   * A fresh path is a `shape` act, like dragging out a rectangle; moving the
   * nodes of one that exists is a `transform`.
   */
  const onPress = useTouchIntent({
    act: () => {
      const t = useSession.getState().tool;
      return t === "pen" || t === "cut" ? actForTool(t) : "transform";
    },
    onTool: (e) => onPointerDown(e),
    onPan: (dx, dy) => {
      const v = useStageView.getState();
      v.set({ scale: v.scale, tx: v.tx + dx, ty: v.ty + dy });
    },
  });

  /**
   * A press that ends any way but a release ABORTS. A second finger landing
   * (`superseded`), a browser cancel, a lost window — none of them is a
   * decision the user made, so the knife does not cut, the rubber band does
   * not select, and the handle or node being dragged is let go where it is.
   * Without this a two-finger tap for undo also cut, selected or keyed
   * whatever the first finger was resting on.
   */
  React.useEffect(() => {
    if (!active) return;
    return subscribePointerEnd((_id, reason) => {
      if (reason === "up") return;
      if (!knifeRef.current && !marqueeRef.current && !penDragRef.current && !editDragRef.current && !sectionDragRef.current) return;
      knifeRef.current = null;
      marqueeRef.current = null;
      penDragRef.current = null;
      editDragRef.current = null;
      sectionDragRef.current = null;
      snapGuidesRef.current = { v: [], h: [] };
      dirtyRef.current = true;
    });
  }, [active]);

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = localPoint(e);
    if (useSession.getState().tool === "pen") {
      commitDraft(false);
      return;
    }
    const target = editClip();
    if (!target) return;
    const { clip, frame } = target;
    for (let s = 0; s < clip.subpaths.length; s++) {
      const sub = clip.subpaths[s]!;
      for (let i = 0; i < sub.points.length; i++) {
        const a = clipLocalToScreen(sub.points[i]!, clip, frame);
        if (Math.hypot(p.x - a.x, p.y - a.y) <= ANCHOR_HIT) {
          togglePoint(clip.id, s, i); // corner ↔ smooth
          return;
        }
      }
    }
    // Double-click on empty space exits node edit (Figma).
    useSession.getState().setVectorEdit(null);
    setSelectedNodes(new Set());
  };

  /** Right-click: point menu on an anchor, paste/exit menu on empty space. */
  const onContextMenu = (e: React.MouseEvent) => {
    // The overlay owns right-click while it exists — never the browser's menu,
    // never the stage clip menu underneath.
    e.preventDefault();
    e.stopPropagation();
    const target = editClip();
    if (!target) return;
    const p = localPoint(e);
    const { clip, frame } = target;
    for (let s = 0; s < clip.subpaths.length; s++) {
      const sub = clip.subpaths[s]!;
      for (let i = 0; i < sub.points.length; i++) {
        const a = clipLocalToScreen(sub.points[i]!, clip, frame);
        if (Math.hypot(p.x - a.x, p.y - a.y) <= ANCHOR_HIT) {
          const key = nodeKey(sub.id, i);
          if (!selectedNodes.has(key)) setSelectedNodes(new Set([key]));
          // Store VIEWPORT coords — the menu portals to <body>, so it escapes the
          // stage's overflow-clip like every other shadcn context menu.
          setPointMenu({ x: e.clientX, y: e.clientY, key });
          return;
        }
      }
    }
    // On a segment: select it (both anchors) and open the menu there, so the
    // segment verbs are reachable by the same gesture that reaches the node
    // ones — `penCtx` decides which of them apply.
    const segHit = hitSegment(p, clip, frame, PATH_HIT.segment);
    if (segHit) {
      const seg = clip.subpaths[segHit.sub]!;
      const ends = [
        nodeKey(seg.id, segHit.index),
        nodeKey(seg.id, (segHit.index + 1) % seg.points.length),
      ];
      if (!ends.every((k) => selectedNodes.has(k))) setSelectedNodes(new Set(ends));
      setPointMenu({ x: e.clientX, y: e.clientY, key: null });
      return;
    }

    // Empty space in edit mode: paste / exit.
    setPointMenu({ x: e.clientX, y: e.clientY, key: null });
  };

  // ── Drawing ────────────────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const invalidate = () => {
      dirtyRef.current = true;
    };
    const unsubs = [
      store.subscribe(invalidate),
      useSession.subscribe(invalidate),
      useStageView.subscribe(invalidate),
    ];

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!dirtyRef.current) return;
      dirtyRef.current = false;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(rect.width * dpr);
      const ph = Math.round(rect.height * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const accent = TOOL_ACCENT.pen;

      // ONE pen resolution per frame, shared by every preview that needs to know
      // where a click would land. Each rubber band used to answer this for
      // itself; hit-testing every path in the frame three times a frame is the
      // kind of cost that only grows, and three answers is how they drift.
      const penHover =
        useSession.getState().tool === "pen" && hoverRef.current && !penDragRef.current && !editDragRef.current
          ? resolvePen(hoverRef.current)
          : null;
      /** Where the rubber band should END: the landing site, when there is one,
       *  so the line visibly reaches the thing it is about to meet. */
      const bandTarget = penHover && penHover.intent.kind !== "add" && penHover.intent.kind !== "start"
        ? penHover.screen
        : null;

      // Pen draft.
      const draft = draftRef.current;
      if (draft && draft.points.length > 0) {
        const v = useStageView.getState();
        ctx.save();
        // Draw the draft path in screen space via the frame transform.
        const origin = frameLocalToScreen({ x: 0, y: 0 }, draft.frame);
        ctx.translate(origin.x, origin.y);
        ctx.scale(v.scale, v.scale);
        const path = commandsToPath2D(pathCommands([{ closed: false, points: draft.points }]));
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5 / v.scale;
        ctx.stroke(path);
        ctx.restore();

        // Rubber band to the cursor — ⇧ snaps its direction to the same angle
        // the placed point will take, so the preview matches the outcome.
        const last = draft.points[draft.points.length - 1]!;
        const lastS = frameLocalToScreen(last, draft.frame);
        const first = draft.points[0]!;
        const firstS = frameLocalToScreen(first, draft.frame);
        // Self-close: hovering the start node within reach previews the CLOSING
        // segment (curved by both endpoints' handles) and snaps onto the start.
        const closing =
          draft.points.length >= 2 &&
          !!hoverRef.current &&
          Math.hypot(hoverRef.current.x - firstS.x, hoverRef.current.y - firstS.y) <= CLOSE_HIT;
        if (hoverRef.current && !penDragRef.current) {
          let hov = hoverRef.current;
          if (closing) {
            hov = firstS; // land exactly on the start
            snapGuidesRef.current = { v: [], h: [] };
          } else if (bandTarget) {
            // Landing on another path: the band ends ON it, not under the
            // cursor. Feeling the line arrive is what tells you the click will
            // meet something rather than drop a node beside it.
            hov = bandTarget;
            snapGuidesRef.current = { v: [], h: [] };
          } else {
            // Preview resolves EXACTLY as the click will (resolveDrawPoint): ⇧
            // locks the angle AND still flashes/snaps to guides, otherwise free
            // snap. The one brain keeps preview and outcome identical.
            const local = resolveDrawPoint(
              shiftRef.current ? last : null,
              frameLocalFromScreen(hov, draft.frame),
              shiftRef.current,
              draft.frame.id,
              new Set(),
              draftNodesWorld(draft),
              modRef.current,
              (loc) => frameLocalToWorld(loc, draft.frame),
              (w) => frameLocalFromWorld(w, draft.frame),
            );
            hov = frameLocalToScreen(local, draft.frame);
          }
          ctx.save();
          ctx.strokeStyle = `${accent}88`;
          ctx.setLineDash(closing ? [] : [4, 4]);
          ctx.beginPath();
          const c1 = last.hOut ? frameLocalToScreen(last.hOut, draft.frame) : lastS;
          const c2 = closing && first.hIn ? frameLocalToScreen(first.hIn, draft.frame) : hov;
          if (last.hOut || (closing && first.hIn)) {
            ctx.moveTo(lastS.x, lastS.y);
            ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, hov.x, hov.y);
          } else {
            ctx.moveTo(lastS.x, lastS.y);
            ctx.lineTo(hov.x, hov.y);
          }
          ctx.stroke();
          ctx.restore();
          if (closing) drawCloseTarget(ctx, firstS, accent);
        }

        // Anchors + live handles.
        for (let i = 0; i < draft.points.length; i++) {
          const pt = draft.points[i]!;
          const sp = frameLocalToScreen(pt, draft.frame);
          for (const side of ["hIn", "hOut"] as const) {
            const h = pt[side];
            if (!h) continue;
            const hs = frameLocalToScreen(h, draft.frame);
            drawHandle(ctx, sp, hs, accent);
          }
          drawAnchor(ctx, sp, accent, i === 0 && draft.points.length >= 2);
        }
      }

      // Node-edit chrome.
      const target = editClip();
      if (target) {
        const { clip, frame } = target;
        // Path outline (so an unfilled path is still visible while editing).
        ctx.save();
        const v = useStageView.getState();
        const { b, geo, wx, wy } = clipOrigin(clip, frame);
        const so = worldToScreen({ x: wx, y: wy });
        // The SAME origin and matrix the nodes below use, so the outline can
        // never drift off them: columns are the map's own basis vectors, and the
        // leading translate is the geometry centre that origin corresponds to.
        const e1 = mapLinear(1, 0, b);
        const e2 = mapLinear(0, 1, b);
        ctx.translate(so.x, so.y);
        ctx.transform(v.scale * e1.x, v.scale * e1.y, v.scale * e2.x, v.scale * e2.y, 0, 0);
        ctx.translate(-geo.x, -geo.y);
        ctx.strokeStyle = `${accent}aa`;
        ctx.lineWidth = 1 / (v.scale * Math.max(Math.hypot(e1.x, e1.y), Math.hypot(e2.x, e2.y)));
        ctx.stroke(commandsToPath2D(pathCommands(clip.subpaths)));
        ctx.restore();

        // Winding direction, but ONLY on the subpath under the pointer. Direction
        // matters for a vector (it decides fill rule, and it is what Reverse
        // flips), yet arrowing every path all the time would bury the geometry
        // under chrome. Showing it on hover makes it discoverable and quiet.
        if (hoverRef.current && !penDragRef.current && !editDragRef.current && !marqueeRef.current) {
          const hoverSub = hitSubpath(hoverRef.current, clip, frame);
          if (hoverSub !== null) {
            const sub = clip.subpaths[hoverSub];
            if (sub && sub.points.length >= 2) {
              const marks: Array<{ at: Pt; dir: Pt }> = [];
              const last = sub.closed ? sub.points.length : sub.points.length - 1;
              for (let i = 0; i < last; i++) {
                const a = sub.points[i]!;
                const b = sub.points[(i + 1) % sub.points.length]!;
                const sa = clipLocalToScreen(a, clip, frame);
                const sb = clipLocalToScreen(b, clip, frame);
                // Control points ride the anchors, so an unhandled segment
                // degenerates to the straight line for free.
                const c1 = a.hOut ? clipLocalToScreen(a.hOut, clip, frame) : sa;
                const c2 = b.hIn ? clipLocalToScreen(b.hIn, clip, frame) : sb;
                marks.push(cubicAt(sa, c1, c2, sb, 0.5));
              }
              paintDirectionChevrons(ctx, marks, { accent, alpha: 0.85, size: 4 });
            }
          }
        }

        // The node under the pointer lifts and lights its halo. Resolved here,
        // in the same pass that draws, so what glows is exactly what a press
        // would grab — one geometry answer, never two that disagree.
        const hovNode = penDragRef.current || editDragRef.current ? null : hoverRef.current;
        const near = (a: { x: number; y: number }, r: number) =>
          !!hovNode && Math.hypot(hovNode.x - a.x, hovNode.y - a.y) <= r;
        for (let s = 0; s < clip.subpaths.length; s++) {
          const sub = clip.subpaths[s]!;
          for (let i = 0; i < sub.points.length; i++) {
            const pt = sub.points[i]!;
            const sp = clipLocalToScreen(pt, clip, frame);
            const selected = selectedNodes.has(nodeKey(sub.id, i));
            if (selected) {
              for (const side of ["hIn", "hOut"] as const) {
                const h = pt[side];
                if (!h) continue;
                const hs = clipLocalToScreen(h, clip, frame);
                drawHandle(ctx, sp, hs, accent, near(hs, PATH_HIT.handle));
              }
            }
            drawAnchor(ctx, sp, accent, false, selected, near(sp, PATH_HIT.anchor));
            // A junction is one node that several runs pass through, and it is
            // worth seeing: it moves as one, and the ring is the only thing that
            // distinguishes it from two anchors that merely share a pixel.
            if (pt.weldId) {
              ctx.save();
              ctx.beginPath();
              ctx.arc(sp.x, sp.y, 6.5, 0, Math.PI * 2);
              ctx.strokeStyle = accent;
              ctx.lineWidth = 1.25;
              ctx.stroke();
              ctx.restore();
            }
          }
        }

        // Section transform box: ≥2 selected nodes get a shape-style box + grips.
        // Dashed = morph the geometry (default); solid = object-scale (⌘, whole
        // clip). The box hugs the selection in clip-local space so it rotates
        // with the vector.
        const toolNow = useSession.getState().tool;
        const litSeg = selectedSegment(clip);
        if (litSeg && toolNow !== "cut" && !marqueeRef.current) {
          const sub = clip.subpaths[litSeg.sub]!;
          const a = sub.points[litSeg.index]!;
          const z = sub.points[(litSeg.index + 1) % sub.points.length]!;
          const sa = clipLocalToScreen(a, clip, frame);
          const sz = clipLocalToScreen(z, clip, frame);
          const c1 = a.hOut ? clipLocalToScreen(a.hOut, clip, frame) : sa;
          const c2 = z.hIn ? clipLocalToScreen(z.hIn, clip, frame) : sz;
          ctx.save();
          ctx.strokeStyle = accent;
          ctx.lineWidth = 2.5;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(sa.x, sa.y);
          ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, sz.x, sz.y);
          ctx.stroke();
          ctx.restore();
        }
        if (selectedNodes.size >= 2 && !litSeg && toolNow !== "pen" && toolNow !== "cut" && !marqueeRef.current) {
          const bsel = selectionBoundsLocal(clip);
          if (bsel) {
            const corners = (["nw", "ne", "se", "sw"] as BoxHandle[]).map((h) =>
              clipLocalToScreen(boxHandleLocal(bsel, h), clip, frame),
            );
            const solid = modRef.current && wholeClipSelected(clip);
            ctx.save();
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            ctx.setLineDash(solid ? [] : [4, 3]);
            ctx.beginPath();
            ctx.moveTo(corners[0]!.x, corners[0]!.y);
            for (let i = 1; i < 4; i++) ctx.lineTo(corners[i]!.x, corners[i]!.y);
            ctx.closePath();
            ctx.stroke();
            ctx.setLineDash([]);
            for (const h of BOX_HANDLES) {
              const s = clipLocalToScreen(boxHandleLocal(bsel, h), clip, frame);
              ctx.beginPath();
              ctx.rect(s.x - 3, s.y - 3, 6, 6);
              ctx.fillStyle = "#fff";
              ctx.fill();
              ctx.strokeStyle = accent;
              ctx.lineWidth = 1.5;
              ctx.stroke();
            }
            ctx.restore();
          }
        }

        // Branch-seed preview: after inserting a point on a segment, show a
        // rubber band from THAT point to the cursor — the next click branches out.
        const pbr = penBranchRef.current;
        if (pbr && pbr.clipId === clip.id && hoverRef.current && useSession.getState().tool === "pen") {
          const seedS = clipLocalToScreen(pbr.seedLocal, clip, frame);
          drawCloseTarget(ctx, seedS, accent);
          const branchEnd = bandTarget ?? hoverRef.current;
          ctx.save();
          ctx.strokeStyle = `${accent}88`;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(seedS.x, seedS.y);
          ctx.lineTo(branchEnd.x, branchEnd.y);
          ctx.stroke();
          ctx.restore();
        }

        // Continue-drawing preview: a rubber band from the live open endpoint to
        // the cursor (curved by the endpoint's handle), with the run's start
        // lit as a close target when the cursor is near it.
        const ext = extendRef.current;
        if (ext && ext.clipId === clip.id && useSession.getState().tool === "pen") {
          const sub = clip.subpaths[ext.sub];
          if (sub && sub.points.length > 0) {
            const { live, start } = extendIndices(sub, ext.end);
            const livePt = sub.points[live]!;
            const liveS = clipLocalToScreen(livePt, clip, frame);
            drawCloseTarget(ctx, liveS, accent); // the active point
            const hovE = hoverRef.current;
            if (hovE && !penDragRef.current) {
              const startPt = sub.points[start]!;
              const startS = clipLocalToScreen(startPt, clip, frame);
              const closingE =
                sub.points.length >= 2 && Math.hypot(hovE.x - startS.x, hovE.y - startS.y) <= CLOSE_HIT;
              let end = hovE;
              if (closingE) {
                end = startS;
                snapGuidesRef.current = { v: [], h: [] };
              } else if (bandTarget) {
                end = bandTarget;
                snapGuidesRef.current = { v: [], h: [] };
              } else {
                // Same brain as the click (resolveDrawPoint): ⇧ locks the angle
                // yet still snaps to guides; otherwise free snap. Preview == outcome.
                const local = resolveDrawPoint(
                  shiftRef.current ? livePt : null,
                  clipLocalFromScreen(hovE, clip, frame),
                  shiftRef.current,
                  clip.frameId,
                  new Set([clip.id]),
                  clipNodesWorld(clip, frame, new Set([keyOf(clip, { sub: ext.sub, index: live })])),
                  modRef.current,
                  (l) => clipLocalToWorld(l, clip, frame),
                  (w) => worldToClipLocal(w, clip, frame),
                );
                end = clipLocalToScreen(local, clip, frame);
              }
              // The leading handle at the live end (out at the tail, in at the head).
              const lead = ext.end === "tail" ? livePt.hOut : livePt.hIn;
              const leadS = lead ? clipLocalToScreen(lead, clip, frame) : liveS;
              const closeIn = closingE ? (ext.end === "tail" ? startPt.hIn : startPt.hOut) : null;
              const c2 = closeIn ? clipLocalToScreen(closeIn, clip, frame) : end;
              ctx.save();
              ctx.strokeStyle = `${accent}88`;
              ctx.setLineDash(closingE ? [] : [4, 4]);
              ctx.beginPath();
              if (lead || closeIn) {
                ctx.moveTo(liveS.x, liveS.y);
                ctx.bezierCurveTo(leadS.x, leadS.y, c2.x, c2.y, end.x, end.y);
              } else {
                ctx.moveTo(liveS.x, liveS.y);
                ctx.lineTo(end.x, end.y);
              }
              ctx.stroke();
              ctx.restore();
              if (closingE) drawCloseTarget(ctx, startS, accent);
            }
          }
        }

        // Marquee rectangle.
        const mq = marqueeRef.current;
        if (mq) {
          ctx.save();
          ctx.strokeStyle = accent;
          ctx.fillStyle = `${accent}18`;
          ctx.lineWidth = 1;
          const x = Math.min(mq.start.x, mq.current.x);
          const y = Math.min(mq.start.y, mq.current.y);
          const w = Math.abs(mq.current.x - mq.start.x);
          const h = Math.abs(mq.current.y - mq.start.y);
          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(x, y, w, h);
          ctx.restore();
        }
      }

      // ── Pen chrome — every path in the frame, editing or not.
      //
      // Painted from the SAME `resolvePen` the press calls, so the badge under
      // the cursor cannot promise something the click then refuses. It used to
      // be drawn inside the node-edit block against one clip's geometry while
      // the click tested a different set, which is exactly how you get a
      // placeholder node that does nothing when you click it.
      if (penHover && hoverRef.current) {
        const hov = hoverRef.current;
        const res = penHover;
        const drawing = isDrawing();
        // Every open end you could pick up, softly — the pen's reach made
        // visible before you go hunting for it with the cursor.
        if (!drawing && !landingRef.current) {
          for (const { clip: pc, frame: pf } of penTargets(hov)) {
            for (const epn of openEndpoints(pc.subpaths)) {
              const sp = clipLocalToScreen(pc.subpaths[epn.sub]!.points[epn.index]!, pc, pf);
              if (res.screen && Math.hypot(sp.x - res.screen.x, sp.y - res.screen.y) < 1) continue;
              paintPenTarget(ctx, sp, accent, "soft");
            }
          }
        }
        // The live target. A curve about to become a node gets the ⊕ badge and a
        // leader (cursor and curve are rarely the same pixel); a node that is
        // about to be joined gets the ring, so "this is what you are meeting"
        // reads the same whether you are starting there or ending there.
        const landed = penIntentLanding(res.intent);
        if (landed && res.screen) {
          const isSegment = landed.site.kind === "segment";
          // Starting on a curve is an ADD, and the ⊕ says so on its own. Ending
          // on one is a JOIN, so it gets the ring too — the mark that means
          // "this is the thing you are meeting" wherever you meet it.
          if (isSegment && !drawing) paintInsertBadge(ctx, res.screen, hov, accent);
          else {
            paintPenTarget(ctx, res.screen, accent, "live");
            if (isSegment) paintInsertBadge(ctx, res.screen, hov, accent);
          }
        }
        paintCursorHint(ctx, hov, penIntentHint(res.intent), accent);
      }

      // A junction waiting on its answer: hold the mark so the prompt beside it
      // is visibly about THAT spot.
      if (landingRef.current) {
        const rect = canvas.getBoundingClientRect();
        const at = { x: landingRef.current.client.x - rect.left, y: landingRef.current.client.y - rect.top };
        paintPenTarget(ctx, at, accent, "live");
      }

      // ── Cut tool preview — works on ANY path in the frame, editing or not.
      // Dragging: a dashed knife line (the "where it cuts" indicator). Hovering:
      // a red knife tick on the nearest outline where a click will sever.
      if (useSession.getState().tool === "cut") {
        const kn = knifeRef.current;
        const hov = hoverRef.current;
        ctx.save();
        if (kn && kn.moved && hov) {
          ctx.strokeStyle = "#FF5C5C";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(kn.start.x, kn.start.y);
          ctx.lineTo(hov.x, hov.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "#FF5C5C";
          for (const pt of [kn.start, hov]) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (hov) {
          const frameId = kn?.frameId ?? frameAtWorld(toWorld(hov));
          let best: { sx: number; sy: number; d: number } | null = null;
          if (frameId) {
            for (const { clip, frame } of framePathClips(frameId)) {
              const seg = hitSegment(hov, clip, frame, 10);
              if (!seg) continue;
              const d = Math.hypot(hov.x - seg.sx, hov.y - seg.sy);
              if (!best || d < best.d) best = { sx: seg.sx, sy: seg.sy, d };
            }
          }
          if (best) {
            ctx.strokeStyle = "#FF5C5C";
            ctx.fillStyle = "#ffffff";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(best.sx - 6, best.sy - 6);
            ctx.lineTo(best.sx + 6, best.sy + 6);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(best.sx, best.sy, 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // Smart-guide lines flashed while a pen point / node snaps — the SAME
      // chrome the stage layer drag shows, over everything.
      drawSnapLines(ctx, snapGuidesRef.current, useStageView.getState());

      // Cursor feedback, from the same resolution as everything else, so the
      // pointer names the outcome in the one place the eye is already looking,
      // before the hint beside it has been read.
      if (useSession.getState().tool === "pen") {
        const k = penHover?.intent.kind;
        const target = (k === undefined || k === "start" || k === "resume") && bendArmed() && hoverRef.current ? editClip() : null;
        canvas.style.cursor =
          target && hitSegment(hoverRef.current!, target.clip, target.frame, PATH_HIT.segment)
            ? cursors.penBend
            : PEN_CURSOR[penHover ? penMark(penHover.intent) : "none"];
      } else if (useSession.getState().tool === "cut") {
        canvas.style.cursor = cursors.knife;
      } else {
        canvas.style.cursor = hoverRef.current ? editCursorAt(hoverRef.current) : cursors.arrow;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      for (const u of unsubs) u();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, selectedNodes, store]);

  // Publish what the pen knows to the stage's tool options bar. It has to
  // happen ABOVE the early return — it is a hook — and that is fine, because
  // "the pen has nothing to say" is a legal thing to publish.
  const penArmed = tool === "pen" || tool === "cut";
  usePublishPenBar(active && (editClipId !== null || penArmed) ? penCtx() : null, dispatchPen);

  if (!active) return null;

  const menuSel = pointMenu?.key ? parseKey(editClip()?.clip, pointMenu.key) : null;
  // The menu, the toolbar and the keyboard all ask ONE question about what the
  // selection supports, so they can never offer three different answers.
  const menuCtx = penCtx();

  return (
    <>
      <canvas
        ref={canvasRef}
        data-vector-overlay=""
        className="absolute inset-0 h-full w-full touch-none"
        style={{ cursor: tool === "pen" ? cursors.pen : tool === "cut" ? cursors.knife : cursors.arrow }}
        onPointerDown={(e) => {
          setPointMenu(null);
          onPress(e);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      {junctionAt && (
        <PenJunctionPrompt
          at={junctionAt}
          connect={junction.connect}
          onChoose={(connect, always) => {
            if (always || connect !== junction.connect) {
              useToolDefaults.getState().setPenJunction({ connect, ask: !always });
            }
            commitLanding(connect);
          }}
        />
      )}
      {pointMenu &&
        createPortal(
          <>
            {/* Click-away backdrop — the portal escapes the stage clip, so it
                needs its own dismiss surface (esc/right-click still work too). */}
            <div className="fixed inset-0 z-60" onPointerDown={() => setPointMenu(null)} />
            <div
              className="fixed z-61 min-w-44 rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-lg"
              style={{
                left: Math.min(pointMenu.x, window.innerWidth - 200),
                top: Math.min(pointMenu.y, window.innerHeight - 260),
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
          {/* ORGANIZED BY WHAT IS BEING ACTED ON, and nothing that does not
              apply. The stage's layer menu is a flat wall of every verb that
              exists; this one asks `penCtx` what the selection supports and
              shows that. Sections appear only when they have something in them,
              so a plain anchor click gets a short menu and a segment click gets
              a different short one — never one long menu with most of it
              greyed out. */}
          {selectedNodes.size > 0 && (
            <>
              <PointMenuLabel>
                {selectedNodes.size > 1 ? `${selectedNodes.size} points` : "Point"}
              </PointMenuLabel>
              <PointMenuItem
                label="Copy"
                shortcut="⌘C"
                onClick={() => {
                  const n = copyPoints();
                  if (n) toast(`Copied ${n} point${n > 1 ? "s" : ""}`);
                  setPointMenu(null);
                }}
              />
              <PointMenuItem
                label="Cut"
                shortcut="⌘X"
                onClick={() => {
                  const n = copyPoints();
                  deleteNodes(selectedNodes);
                  if (n) toast(`Cut ${n} point${n > 1 ? "s" : ""}`);
                  setPointMenu(null);
                }}
              />
              <PointMenuItem
                label="Delete"
                shortcut="⌫"
                onClick={() => {
                  deleteNodes(selectedNodes);
                  setPointMenu(null);
                }}
              />
              {menuSel && (
                <PointMenuItem
                  label="Toggle corner / smooth"
                  shortcut="dbl-click"
                  onClick={() => {
                    const id = useSession.getState().vectorEditClipId;
                    if (id) togglePoint(id, menuSel.sub, menuSel.index);
                    setPointMenu(null);
                  }}
                />
              )}
              {menuCtx.nodeCount === 1 && (
                <PointMenuItem
                  label="Break path here"
                  onClick={() => {
                    dispatchPen("break");
                    setPointMenu(null);
                  }}
                />
              )}
              {selectedNodes.size >= 2 && (
                <>
                  <PointMenuItem
                    label="Mirror horizontally"
                    onClick={() => {
                      mirrorSelection("x");
                      setPointMenu(null);
                    }}
                  />
                  <PointMenuItem
                    label="Mirror vertically"
                    onClick={() => {
                      mirrorSelection("y");
                      setPointMenu(null);
                    }}
                  />
                  <PointMenuItem
                    label="Average"
                    onClick={() => {
                      dispatchPen("average");
                      setPointMenu(null);
                    }}
                  />
                </>
              )}
              {menuCtx.endpointPair && (
                <PointMenuItem
                  label="Join"
                  onClick={() => {
                    dispatchPen("join");
                    setPointMenu(null);
                  }}
                />
              )}
            </>
          )}
          {menuCtx.segment && (
            <>
              <PointMenuLabel>Segment</PointMenuLabel>
              {/* One conversion, the one that applies — offering both and
                  greying one out says nothing the label does not already. */}
              <PointMenuItem
                label={menuCtx.segment === "line" ? "Convert to curve" : "Convert to line"}
                onClick={() => {
                  dispatchPen(menuCtx.segment === "line" ? "toCurve" : "toLine");
                  setPointMenu(null);
                }}
              />
              <PointMenuItem
                label="Add point"
                onClick={() => {
                  dispatchPen("insertPoint");
                  setPointMenu(null);
                }}
              />
              <PointMenuItem
                label="Duplicate"
                onClick={() => {
                  dispatchPen("duplicateSeg");
                  setPointMenu(null);
                }}
              />
              <PointMenuItem
                label="Delete segment"
                onClick={() => {
                  dispatchPen("deleteSeg");
                  setPointMenu(null);
                }}
              />
            </>
          )}
          <PointMenuLabel>Path</PointMenuLabel>
          <PointMenuItem
            label="Paste points"
            shortcut="⌘V"
            disabled={!pointClipboard}
            onClick={() => {
              pastePoints();
              setPointMenu(null);
            }}
          />
          {menuCtx.anyOpen && (
            <PointMenuItem
              label="Close path"
              onClick={() => {
                dispatchPen("close");
                setPointMenu(null);
              }}
            />
          )}
          <PointMenuItem
            label="Reverse direction"
            onClick={() => {
              dispatchPen("reverse");
              setPointMenu(null);
            }}
          />
          <PointMenuItem
            label="Exit edit mode"
            shortcut="esc"
            onClick={() => {
              useSession.getState().setVectorEdit(null);
              setSelectedNodes(new Set());
              setPointMenu(null);
            }}
          />
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

/** The pen's words for the shared verbs (its toolbar predates them). */
const PEN_VERB: Partial<Record<PenAction, NodeVerbId>> = {
  smooth: "smooth",
  corner: "corner",
  reset: "corner",
  mirror: "mirrorHandles",
  average: "average",
  close: "close",
  open: "open",
  reverse: "reverse",
  simplify: "simplify",
  break: "break",
  deleteSeg: "deleteSeg",
  toLine: "toLine",
  toCurve: "toCurve",
  insertPoint: "subdivide",
  duplicateSeg: "duplicateSeg",
  join: "join",
};

/** A section heading — what the items under it act on. */
function PointMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function PointMenuItem({
  label,
  shortcut,
  disabled,
  onClick,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center justify-between gap-4 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span>{label}</span>
      {shortcut && <span className="text-[10px] text-muted-foreground">{shortcut}</span>}
    </button>
  );
}

/**
 * A vector node. Squares are the pen's own glyph (a node is a corner you can
 * round), and the rest — sizing, halo, hover lift, dark underlay — comes from
 * the shared path-chrome kit, so it matches a motion-path key exactly.
 */
function drawAnchor(
  ctx: CanvasRenderingContext2D,
  p: { x: number; y: number },
  accent: string,
  isFirst: boolean,
  selected = false,
  hovered = false,
) {
  paintAnchor(ctx, p, {
    accent,
    glyph: "square",
    state: hovered ? (selected ? "active" : "hover") : selected ? "selected" : "idle",
    closeRing: isFirst,
  });
}

/** A pulsing accent ring marking a close/active target (the start node you can
 *  click to close, or the live endpoint you're drawing from). */
function drawCloseTarget(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, accent: string) {
  paintAnchor(ctx, p, { accent, glyph: "round", state: "active", closeRing: true });
}

function drawHandle(
  ctx: CanvasRenderingContext2D,
  anchor: { x: number; y: number },
  handle: { x: number; y: number },
  accent: string,
  hovered = false,
) {
  paintTangent(ctx, anchor, handle, { accent, state: hovered ? "active" : "idle" });
}
