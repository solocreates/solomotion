"use client";

import { cursors } from "@solomotion/ui/cursors";
import * as React from "react";
import {
  type Contour,
  type LayerSpace,
  type StrokeStyle,
  GROW_BLOCK_PX,
  NO_PAD,
  applyCompositeMode,
  padFor,
  isPartGroup,
  partsOf,
  reachableFrameIds,
  type PixelBounds,
  type SurfacePad,
  applyEndTaper,
  clearContourStyle,
  combineMasks,
  convertShapeClipToPath,
  createId,
  copySubpaths,
  createPathClip,
  setPathGeometry,
  createRasterClip,
  cutVectorByRegion,
  deleteClip,
  linkClips,
  resolvePaintTarget,
  resolveStrokeTargets,
  createTrack,
  createStabilizer,
  eraseVectorSubpaths,
  traceRegionContours,
  floodRegion,
  frameDurationMs,
  globalColorMask,
  groupModeOf,
  clipsInGroup,
  groupOfClip,
  isClipLocked,
  locateClip,
  mergeStrokeInto,
  paintKindOf,
  type PaintToolCategory,
  polygonMask,
  referenceTiming,
  regionAtPoint,
  regionIsSubdivided,
  type ResolvedReference,
  reissueClipIds,
  resolveColor,
  pourFill,
  splitPolylineByMask,
  maskContains,
  resolveReference,
  sampleKeyframes,
  scopeNeedsRegion,
  solidPaint,
  stabilizerPush,
  stabilizerRadius,
  StrokeEngine,
  subpathBounds,
  traceRegion,
  translateSubpaths,
  type MotionDocument,
  type BrushPreset,
  type Clip,
  type CutRegion,
  type Dab,
  type EraserPath,
  type Frame,

  type PartBox,  type NestedClip,
  type Paint,
  type PathClip,
  type PenSample,
  type RasterClip,
  type ConfineMode,
  type PaintDepth,
  type PathFidelity,
  type RegionMask,
  type StabilizerState,
  type Subpath,
  type VectorCutResult,
  type VectorStroke,
  type VectorEraseMode,
  mapLocal,
  unmapLocal,
  layerSpace as coreLayerSpace,
  contoursToLayer,
  strokesToLayer,
  setContourInk,
  editPathGeometry,
  toSubpath,
  vectorStroke,
  vectorStrokeInk,
  brushLines,
  type AnchorPoint,
  type LayerBox,
  CENTER_ANCHOR,
  type LayerBasis,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import {
  fillCanvas,
  invalidateReferenceRaster,
  referenceRaster,
  regionAt,
  seedInRaster,
  stencilCanvas,
  stencilCoversPoint,
} from "./paint-region";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useDocStore } from "../state/document-context";
import { authoringSpace, frameSpace, type EditSpace } from "../stage/edit-space";
import { placeClip } from "@solomotion/core";
import { animWriteMode, commitProperty, effectiveValue } from "../inspector/animatable";
import { isDrawingTool, useSession, useStageView } from "../state/session";
import { materializeArmedCell } from "./cell-materialize";
import { useTouchIntent } from "../input/use-touch-intent";
import { actForTool } from "../input/pointer-authority";
import { subscribePointerEnd } from "../input/pointer-gestures";
import { applyInverseLayerBasis, applyLayerBasis, drawFrameContent } from "../stage/render/draw-frame";
import { paintVectorStroke } from "./brush-preview";
import { grainGatedBuffer, stampDabs } from "./dab-painter";
import { armedBrush, armedBrushFor, useBrushLibrary, useDrawing, type LassoShape } from "./drawing-store";
import { shiftHeld, useShiftHeld } from "./smoothing-modifier";
import {
  beginStroke,
  captureBefore,
  commitStroke,
  extendDirty,
  paintIntoRaster,
  wetForSurface,
  wetLog,
  surfaceForClip,
  touchSurfaces,
  writeSurface,
  type StrokeTx,
} from "./raster-store";
import {
  commitDrawSurface,
  planRasterDraw,
  liveDrawPlan,
  seedDrawSurface,
  type DrawPlan,
} from "./capture-record";
import { capturePointer } from "../input/capture-pointer";
import { PenInput } from "./pen-input";
import { isTypingTarget } from "../input/typing-target";

/**
 * The drawing interaction layer — brush, eraser and paint bucket. Follows the
 * VectorOverlay pattern: a transparent canvas above the stage that owns the
 * pointer ONLY while a drawing tool is armed; wheel falls through to pan/zoom.
 *
 * Tablet-first input: pointer events with coalesced samples (full report rate
 * on Apple Pencil / Wacom / Huion), pen pressure + tilt normalized through the
 * core PenSampleNormalizer (mice get velocity-synthesized pressure), and palm
 * rejection — touch is ignored while a pen is on the surface.
 *
 * Correct paint model: a raster BRUSH stroke builds up in a stroke buffer
 * (flow accumulates dab-by-dab) which composites onto the layer ONCE at the
 * stroke's opacity — Procreate's opacity-vs-flow semantics — then journals
 * into the raster store and bumps the clip's `rev` in the same doc update, so
 * undo is one ⌘Z like everything else. The eraser writes destination-out live
 * (its feedback IS the layer) and cuts vector layers on release through the
 * headless `eraseVectorSubpaths` — split, dissolve nodes, or take the whole
 * path, whichever the tool's vector mode says. The bucket floods pixels or —
 * on vector layers — traces the region into a real filled path clip.
 */

type StrokeMode = "raster-brush" | "raster-erase" | "vector-brush";

/**
 * How a paint overlay names its side.
 *
 * A suffix on the layer name rather than a field on the clip: the side is
 * already derivable from where the layer SITS relative to its host, and the
 * name is the one place a person can see it, rename it and understand it
 * without opening anything. Two stored facts describing one arrangement is how
 * they end up disagreeing after a drag.
 */
/**
 * What a confined stroke does about its container. Module scope because
 * `ActiveStroke` carries it — the verdict is latched with the gesture.
 */
type Containment = "join" | "extend" | "fresh";

/**
 * The smallest piece of a traced region worth turning into geometry, in px².
 *
 * A photograph's flood has a ragged edge and throws off hundreds of one- and
 * two-pixel islands. Each one becomes a contour, a fit, points in the morph and
 * a box the layer's bounds have to contain — which is why a fill of a small
 * area arrived with a selection rectangle spanning half the canvas and a morph
 * of four hundred points. 24px² is below anything a person drew on purpose.
 */
const STENCIL_MIN_AREA_PX = 24;

/**
 * A MERGE MAY NOT BE MORE PRECISE THAN THE STROKES IT MERGED.
 *
 * The refit tolerance is the brush's own `fidelity.simplify` — the number that
 * decided how many anchors the stroke had in the first place — with this as a
 * floor for a hand set to draw at hairline precision.
 *
 * A constant here was the real defect, twice. It held a merged outline to 0.4px
 * while the freehand brush that drew it fits at 2.5, so every union came back
 * denser than its own inputs and the drawing got heavier with every line.
 * (Before that it was a sub-pixel RDP tolerance, which removed nothing at all —
 * RDP can only delete vertices, so following a curve forces it to keep almost
 * every one.)
 */
const MERGE_SIMPLIFY_FLOOR_PX = 0.5;

const ORIGIN = { x: 0, y: 0 } as const;

/** "Fuse with nothing" — see the merge/close-gaps gate. */
const NO_CONTOURS: ReadonlySet<string> = new Set();

const OVERLAY_OVER = "· paint";
const OVERLAY_UNDER = "· paint under";

type DirtyRect = { x0: number; y0: number; x1: number; y1: number };


/**
 * One block of room past the layer's edge, on every side, from the first dab.
 * A stroke that merely clips a corner then needs no reallocation at all.
 *
 * A function rather than a module-scope const on purpose: this module sits in
 * an import cycle with the core barrel, and a `const` initialised from an
 * imported binding at module-evaluation time is a coin flip on which side of
 * the cycle loads first. It lost that flip ("GROW_BLOCK_PX is not defined",
 * thrown before a single component rendered). Read the binding when it is
 * needed and the cycle stops mattering.
 */
function initialBleed(): SurfacePad {
  return { left: GROW_BLOCK_PX, top: GROW_BLOCK_PX, right: GROW_BLOCK_PX, bottom: GROW_BLOCK_PX };
}

/**
 * Make sure the flow buffer covers `bounds` (surface coordinates), growing it
 * in blocks if not.
 *
 * The buffer is what the live stroke is drawn into and what the release blits
 * onto the layer, so anything outside it is paint that was never made. Growing
 * is an allocate-and-blit, which is why it happens in blocks and why the buffer
 * starts a block oversized: a stroke travelling steadily outward costs a
 * handful of these, not one per frame.
 *
 * The context's transform is re-set to the new offset afterwards, so the caller
 * keeps working in surface coordinates and nothing else has to change.
 */
function growStrokeBuffer(
  s: { buffer: HTMLCanvasElement | null; bufferCtx: CanvasRenderingContext2D | null; bufferPad: SurfacePad },
  bounds: { x0: number; y0: number; x1: number; y1: number },
  surfaceW: number,
  surfaceH: number,
): void {
  const buf = s.buffer;
  const ctx = s.bufferCtx;
  if (!buf || !ctx) return;
  const pad = s.bufferPad;
  // The buffer's own rectangle, expressed in surface coordinates.
  const need = padFor(
    { x0: bounds.x0 + pad.left, y0: bounds.y0 + pad.top, x1: bounds.x1 + pad.left, y1: bounds.y1 + pad.top },
    buf.width,
    buf.height,
  );
  if (!need) return;
  const next = document.createElement("canvas");
  next.width = buf.width + need.left + need.right;
  next.height = buf.height + need.top + need.bottom;
  const nctx = next.getContext("2d")!;
  nctx.drawImage(buf, need.left, need.top);
  s.buffer = next;
  s.bufferCtx = nctx;
  s.bufferPad = {
    left: pad.left + need.left,
    top: pad.top + need.top,
    right: pad.right + need.right,
    bottom: pad.bottom + need.bottom,
  };
  nctx.setTransform(1, 0, 0, 1, s.bufferPad.left, s.bufferPad.top);
  void surfaceW;
  void surfaceH;
}

/** The box a batch of dabs covers, in surface pixels (radius included). */
function dabBounds(dabs: readonly Dab[]): { x0: number; y0: number; x1: number; y1: number } | null {
  if (dabs.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const d of dabs) {
    const r = d.size / 2 + 2;
    x0 = Math.min(x0, d.x - r);
    y0 = Math.min(y0, d.y - r);
    x1 = Math.max(x1, d.x + r);
    y1 = Math.max(y1, d.y + r);
  }
  return { x0, y0, x1, y1 };
}

function growRect(a: DirtyRect | null, b: DirtyRect): DirtyRect {
  if (!a) return { ...b };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** A point in some comp's frame-centre coordinates. */
type Pt2 = { x: number; y: number };

/** A crossing from one comp's coordinates into another's — see `bridgeFactory`. */
interface SpaceBridge {
  at: (p: Pt2) => Pt2;
  /** How many of THEIR units one of mine spans (1 when the scales match). */
  lengthScale: number;
}

interface RasterTarget {
  /** The clip retargeted to the surface being painted (a capture snapshot, or
   *  the layer's own surface) — same id, possibly a different surfaceId/rev. */
  clip: RasterClip;
  /** How this stroke lands: which surface, seed, and whether to stamp a frame. */
  plan: DrawPlan;
  tx: StrokeTx;
  /** Frame-center → surface-space transform pieces: the layer's full LayerBasis
   *  (pivot and shear included), plus where its POSITION sits in frame space. */
  cx: number;
  cy: number;
  scale: number;
  scaleY: number;
  rotation: number;
  skewX: number;
  skewY: number;
  /**
   * Stroke-space → THIS TARGET's frame-centre coordinates.
   *
   * Identity for a layer in the comp you are standing in, which is every target
   * unless the reach setting is asking for more (`DepthReach`). When it is, a
   * target in a parent or a nested comp lives in a different space, and the one
   * honest way across is the chain both frames already hang off — so the bridge
   * is composed from their `EditSpace`s and nothing here does any geometry.
   */
  from?: SpaceBridge;
  anchor: AnchorPoint;
  size: LayerBox;
}

/**
 * The resolved paint context (see `paintCtx` below) — an `EditSpace` and
 * nothing else.
 *
 * It used to be three fields: the comp strokes land in, the artboard the
 * pointer moves over, and the flipbook cell between them, with a hand-rolled
 * inverse pose to get from one to the other. That inverse understood position,
 * rotation and scale — but not pivot, not shear, not a mirrored (negative)
 * scale, and not a second level of nesting. The `EditSpace` is the whole chain,
 * exactly as the renderer composes it, so there is nothing left to get wrong.
 */
type PaintCtxState = EditSpace;

interface ActiveStroke {
  mode: StrokeMode;
  pointerId: number;
  frame: Frame;
  /** The chain that places this stroke on the canvas — frozen at press, so a
   *  live stroke can never drift out from under the hand that is drawing it. */
  space: EditSpace;
  brush: BrushPreset;
  color: string;
  sizePx: number;
  opacity: number;
  engine: StrokeEngine;
  /** The hand, read once for every mode — coalesced, stabilised in screen px, pressure-normalised (`pen-input`). */
  pen: PenInput;
  /** raster-brush: the flow buffer (surface-sized) + its target. */
  buffer: HTMLCanvasElement | null;
  /**
   * WHERE THE BUFFER SITS relative to the surface, in surface pixels.
   *
   * A pixel layer is born the size of its comp, and a stroke that reaches past
   * that edge used to be cut off at the buffer — draw an arm that swings out of
   * shot and you lost the part that left. The flow buffer now extends BEYOND
   * the surface on every side and grows in blocks as the stroke travels, so
   * paint outside the layer is kept and shown live; on release the layer itself
   * grows to hold it (`paintIntoRaster`), in the same document
   * update that bumps the paint revision.
   *
   * The buffer's context carries the same offset as a transform, so every dab,
   * every stencil clip and every dirty rect stays in SURFACE coordinates and
   * none of the stroke code below has to know this exists.
   */
  bufferPad: SurfacePad;
  bufferCtx: CanvasRenderingContext2D | null;
  target: RasterTarget | null;
  /** raster-erase: every touched pixel layer, each with its own open journal tx. */
  eraseTargets: RasterTarget[];
  /** raster-erase: the vector layers in reach, cut from the trail on release.
   *  `from` bridges this gesture's coordinates into a target in another comp. */
  vectorTargets: Array<{ clipId: string; from?: SpaceBridge }>;
  /** Eraser trail in frame-center coords (radius = live half size). */
  trail: Array<{ x: number; y: number; radius: number }>;
  /** Fidelity this stroke was armed with (the leash reads `smoothing`). */
  fidelity: PathFidelity;
  /**
   * The confine STENCIL, in frame pixels — resolved once from the first point
   * and then held for the whole gesture.
   *
   * Once, deliberately. Re-resolving per sample would let the region change
   * under the stroke as it crosses a boundary, so a line drawn from inside a
   * shape to outside it would start being clipped by wherever it currently is —
   * which is not "paint inside", it is a different tool every 8ms. Fresco,
   * Procreate and Clip Studio all latch it at touch-down for the same reason.
   */
  stencil: HTMLCanvasElement | null;
/**
   * The confinement a VECTOR stroke is cut against, as the region itself.
   *
   * A mask rather than traced contours, because the cut is made by SPLITTING
   * the polyline (see `vectorPieces`) and a split needs one thing only: "is
   * this point inside". Point tests against a bitmask are O(1); the boolean
   * intersection this replaced was both slower and wrong — a vector stroke's
   * geometry is an open centre line, so intersecting it as a polygon returned
   * nothing, the boolean reported failure, and the tool committed the stroke
   * UNCLIPPED. That is the "it looked right while painting and then added the
   * outside lines back" bug.
   */
  confineMask: RegionMask | null;
  /** The referenced clips this gesture resolved to — what `track` copies. */
  confineRefs: string[];
  /** Over or under, latched with the gesture like everything else about it. */
  depth: PaintDepth;
  /** Cut the mark at the boundary, or hold the whole thing inside a live mask.
   *  Latched too: changing it mid-stroke would clip half a line one way. */
  confineMode: ConfineMode;
  /** Whether this gesture joins, extends or builds its container. Resolved at
   *  touch-down from where the stroke STARTED — the only point at which the
   *  question has a stable answer. */
  containment: Containment;
  dirty: { x0: number; y0: number; x1: number; y1: number } | null;
}

/**
 * Maps a point in a region's PIXEL space → frame-center coords. For a raster
 * layer this is `rasterPose`; for a rendered image/video it's `FRAME_POSE`,
 * identity in frame space. One shape lets every region op ignore what it
 * selected.
 *
 * It IS a `LayerBasis` — the whole thing, pivot and shear included — rather
 * than the four fields a lift happens to write. It used to be the four, and a
 * subset of a pose is a pose that is quietly wrong: the day pixel layers began
 * to grow, every layer that had grown carried an off-centre pivot that this
 * shape had no room for, so selections and previews drew themselves half a
 * growth block from the pixels they described.
 */
interface RegionPose extends LayerBasis {
  cx: number;
  cy: number;
}

/** The identity basis — a region whose pixel space IS the frame's. */
const FRAME_POSE: RegionPose = {
  cx: 0,
  cy: 0,
  scale: 1,
  scaleY: 1,
  rotation: 0,
  skewX: 0,
  skewY: 0,
  anchor: CENTER_ANCHOR,
  size: { width: 0, height: 0, cx: 0, cy: 0 },
};

/**
 * An active pixel selection (lasso / wand) — a mask over the SOURCE layer,
 * unified across kinds: a raster layer exposes its own mutable surface (cut /
 * delete land in place), while an image/video exposes its rendered pixels
 * (immutable → lifted into a raster first). The LASSO ONLY SELECTS; to
 * move/rotate/scale the area you switch to V, which lifts it into a FLOATING
 * selection driven by the shared transform gizmo and merged back on deselect
 * (see `FloatingSel`). Right-click cuts/copies/duplicates/inverts/deselects.
 */
interface RegionState {
  frame: Frame;
  /** The chain that places this selection on the canvas. */
  space: EditSpace;
  /** The layer the selection was taken from. */
  sourceClipId: string;
  /** Raster surface (cut/delete in place) vs rendered media (copy only). */
  mutable: boolean;
  /** The mask's pixel-space dimensions (raster: clip size; rendered: frame). */
  width: number;
  height: number;
  /** Pixel-space → frame-center mapping (placement of a lifted layer). */
  pose: RegionPose;
  /** Baked pixels for an immutable source; null for a raster (read live). */
  rendered: HTMLCanvasElement | null;
  mask: RegionMask;
  /** Traced outlines in pixel space (marching-ants rendering). */
  loops: Array<Array<{ x: number; y: number }>>;
}

/**
 * A FLOATING selection — the selection after it's handed to the V tool. The
 * masked pixels have been cut from `sourceClipId` into a real temp raster clip
 * (`clipId`) that the normal on-stage gizmo transforms (move/rotate/scale) with
 * ZERO new transform code. It stays live (no auto-deselect) until you deselect
 * or select something else, at which point it FLATTENS back into the source —
 * so the edit lands in the same layer, never a duplicate.
 */
interface FloatingSel {
  clipId: string;
  sourceClipId: string;
  frameId: string;
}

export function DrawingOverlay() {
  const store = useDocStore();
  const tool = useSession((s) => s.tool);
  const active = isDrawingTool(tool);

  // Per-frame brush engine: each frame (a flipbook cell IS its own drawing
  // frame) remembers its own pixel/vector choice — a bare global "follow the
  // selected layer's kind" made engine look like it randomly flipped while
  // stepping through flipbook cells, since focusing a cell reselects its top
  // layer every time. Two effects, one seam each (session.ts owns the map):
  const activeFrameId = useSession((s) => s.activeFrameId);
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  const brushEngine = useDrawing((s) => s.brush.engine);

  // Restore on frame entry: apply the frame's remembered engine; a frame
  // with no memory yet (first visit) falls back to the original heuristic —
  // detect from the newly selected layer's kind — which seeds its memory
  // via the write effect below.
  const lastFrameRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!activeFrameId || activeFrameId === lastFrameRef.current) return;
    lastFrameRef.current = activeFrameId;
    const remembered = useSession.getState().brushEngineByFrame[activeFrameId];
    if (remembered) {
      if (remembered !== useDrawing.getState().brush.engine) {
        useDrawing.getState().setBrushOptions({ engine: remembered });
      }
      return;
    }
    const id = selectedClipIds[selectedClipIds.length - 1];
    const loc = id ? locateClip(store.getState(), id) : null;
    const kind = loc ? paintKindOf(loc.clip) : null;
    if (kind && kind !== useDrawing.getState().brush.engine) {
      useDrawing.getState().setBrushOptions({ engine: kind });
    }
  }, [activeFrameId, selectedClipIds, store]);

  // Write: mirror the live engine into the ACTIVE frame's memory whenever it
  // changes, whether by hand (toolbar flyout/shortcut) or by the fallback
  // above — so a manual pick sticks the next time this frame is visited.
  React.useEffect(() => {
    if (!activeFrameId) return;
    useSession.getState().setBrushEngineForFrame(activeFrameId, brushEngine);
  }, [activeFrameId, brushEngine]);

  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const strokeRef = React.useRef<ActiveStroke | null>(null);
  /** The selection outline being drawn, in FRAME-CENTER space (works with or
   *  without a pixel layer). ONE draft powers every sub-tool: `free` streams
   *  points on drag, `rect` recomputes 4 corners from an anchor, `poly` collects
   *  clicked vertices with a live rubber-band to the cursor. `pointerId` is null
   *  for the click-based polygon (its lifecycle isn't a single drag). */
  const lassoDraftRef = React.useRef<{
    frame: Frame;
    space: EditSpace;
    shape: LassoShape;
    points: Array<{ x: number; y: number }>;
    /** rect anchor / poly first-vertex reference (frame-center). */
    anchor: { x: number; y: number } | null;
    /** poly live cursor for the rubber-band segment. */
    cursor: { x: number; y: number } | null;
    pointerId: number | null;
    /** The free lasso is drawn by hand, so it takes the same leash a brush
     *  does (screen px). Null for rect/poly, which are placed, not drawn. */
    stab: StabilizerState | null;
  } | null>(null);
  const regionRef = React.useRef<RegionState | null>(null);
  /** The live floating selection handed to the V tool (null when none). Owned
   *  here because DrawingOverlay stays mounted under every tool. */
  const floatRef = React.useRef<FloatingSel | null>(null);
  /** Mirrors `regionRef` presence for the right-click selection menu (a ref
   *  can't drive React); toggled only on select/deselect, so it's cheap. */
  const [regionActive, setRegionActive] = React.useState(false);
  const cursorRef = React.useRef<{ x: number; y: number } | null>(null);
  /** ⇧ held right now. Watched globally rather than read off the pointer event
   *  so pressing or releasing it MID-stroke changes the leash immediately —
   *  the modifier is a live state, not a property of the last move. */
  /** A pen pointer is down — ignore touch entirely (palm rejection). It is the
   *  pointer ID rather than a flag so that a pen which never sends `pointerup`
   *  (window blur, a layer mounting over the press) can be released by the
   *  arbiter's end signal; a bare boolean stayed true and locked touch out for
   *  the rest of the session. */
  const penPointerRef = React.useRef<number | null>(null);
  const dirtyRef = React.useRef(true);

  // ── Coordinates (same conventions as VectorOverlay) ────────────────────────

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /**
   * THE paint context: which comp strokes land in, AND the chain that places it
   * on the canvas — resolved through the core brain. A drawing/plain comp takes
   * strokes directly; standing on a FLIPBOOK, tools paint into the cell under
   * the playhead, which is one more hop down the same chain.
   *
   * The space is the whole answer. Nothing downstream needs to know whether a
   * cell was involved, how deep it is, or where its source frame sits on the
   * page board — and nothing downstream may ask, because the page board is not
   * where a drilled comp is painted.
   */
  const paintCtx = (): PaintCtxState | null => authoringSpace(store.getState());

  /**
   * The paint context, MATERIALISING an armed empty flipbook slot on demand —
   * see `materializeArmedCell`, which is shared with the shape and text tools
   * so that "draw on an empty slot and it becomes a frame" is one rule rather
   * than a property of the brush. Selection-only tools (lasso, wand) keep
   * calling `paintCtx`, so they never conjure a blank frame.
   */
  const paintCtxOrCreate = (): PaintCtxState | null =>
    paintCtx() ?? (materializeArmedCell(store) ? paintCtx() : null);

  /**
   * THE COLOUR A PIXEL IS PAINTED WITH.
   *
   * Every colour slot in this app may hold a `var:<id>` token, and the paint
   * tools' slots now do too. Vector artwork stores the token and retints for
   * ever — that is the whole point of a variable, and a stroke or fill bound to
   * one follows the palette wherever it goes.
   *
   * PIXELS CANNOT. A bitmap has nowhere to keep a reference: the moment a dab
   * lands it is a number in a buffer. So raster paint resolves the token HERE,
   * once, at the moment of painting — which is also what stops a token reaching
   * `ctx.fillStyle`, where an unparseable colour silently paints black.
   *
   * That asymmetry is honest and worth stating plainly: change a variable and
   * every vector stroke, fill and shape that references it changes with it;
   * pixels you already laid down keep the colour they were laid down in, the
   * same way they keep the pressure they were drawn with.
   */
  const inkColor = (value: string): string => resolveColor(store.getState(), value);

  // ── The region under the cursor, before you commit to it ───────────────────

  /**
   * THE HOVER PREVIEW — what the bucket is about to fill, or what a confined
   * stroke will be held inside, drawn under the cursor before anything happens.
   *
   * This is the difference between a gap-closing setting you can use and one
   * you tune by filling, undoing, filling again. You move over an enclosure and
   * see it light up; you move over a leak and see the highlight flood the whole
   * canvas, which tells you the gap is open far more clearly than any number.
   *
   * It is computed by `scopeRegion` — the SAME call the commit makes — so the
   * shape you see is by construction the shape you get. A preview drawn by
   * separate code is a promise nothing keeps.
   *
   * Three things keep it cheap enough to run on pointer move:
   *   - the reference raster is cached and keyed on clip identity, so the
   *     expensive half is paid once per drawing rather than once per pixel of
   *     mouse travel (see `paint-region.ts`);
   *   - a movement gate: under `HOVER_SLOP_PX` of travel cannot change which
   *     enclosure you are in, so it does not re-flood;
   *   - it is skipped entirely while a stroke is live, while playing, and for
   *     any tool that has no region to show.
   */
  const HOVER_SLOP_PX = 6;

  interface RegionHover {
    /** Traced outline in FRAME-CENTRE coords — ready to stroke on the overlay. */
    loops: Array<Array<{ x: number; y: number }>>;
    space: EditSpace;
    /** Where it was computed, in frame coords — the movement gate's memory. */
    at: { x: number; y: number };
    /** True when the region escaped: a visible warning that a gap is open. */
    leaked: boolean;
  }

  const hoverRef = React.useRef<RegionHover | null>(null);

  /** Which tools have a region worth previewing right now. */
  const wantsRegionHover = (): boolean => {
    if (strokeRef.current) return false;
    const session = useSession.getState();
    if (session.playing) return false;
    if (session.tool === "fill") return true;
    return (
      (session.tool === "brush" || session.tool === "eraser") &&
      scopeNeedsRegion(useDrawing.getState().scope)
    );
  };

  const updateRegionHover = (e: React.PointerEvent): void => {
    if (!wantsRegionHover()) {
      if (hoverRef.current) {
        hoverRef.current = null;
        dirtyRef.current = true;
      }
      return;
    }
    const ctx = paintCtx();
    if (!ctx) return;
    const p = paintLocal(localPoint(e), ctx);
    const prev = hoverRef.current;
    if (prev && Math.hypot(p.x - prev.at.x, p.y - prev.at.y) < HOVER_SLOP_PX) return;

    const scope = useDrawing.getState().scope;
    const tool = useSession.getState().tool;
    // The SAME exclusion the stroke will use. A hover that included the layer
    // you are about to paint into would highlight one region and then confine
    // you to a different one — which is the exact mismatch this preview exists
    // to rule out.
    const medium: PaintToolCategory =
      tool === "brush" && useDrawing.getState().brush.engine === "vector" ? "vector" : "raster";
    const mask = scopeRegion(ctx.frame, p, {
      invert: scope.confine === "outside",
      global: tool === "fill" && useDrawing.getState().fill.global,
      medium,
    });
    if (!mask || mask.bounds.x1 < mask.bounds.x0) {
      hoverRef.current = null;
      dirtyRef.current = true;
      return;
    }
    // A region that found no boundary in any direction leaked. Say so in the
    // DRAWING rather than in a message — the outline is the diagnosis — and
    // read it from the same predicate the stroke's refusal uses.
    const leaked = regionEscaped(mask);
    // Coarse simplification: this is a highlight, not geometry, and a hand-drawn
    // enclosure traced at full precision is tens of thousands of points to
    // stroke sixty times a second.
    // No `.slice()`. A traced loop set is NESTED, and cutting it at a count
    // keeps holes whose outer contour was dropped — which is what made the
    // highlight (and the stencil built from the same trace) show pieces both
    // inside and outside the region. The area floor is nesting-safe.
    const loops = traceRegion(mask, 2.5, 64);
    for (const loop of loops) {
      for (const q of loop) {
        q.x -= ctx.frame.width / 2;
        q.y -= ctx.frame.height / 2;
      }
    }
    hoverRef.current = loops.length > 0 ? { loops, space: ctx, at: p, leaked } : null;
    dirtyRef.current = true;
  };

  /** Screen point → PAINT-frame centre coords (the one input mapping). */
  const paintLocal = (p: { x: number; y: number }, space: EditSpace) => space.fromScreen(p);

  /**
   * A bridge from THIS gesture's coordinates into any other comp's, memoised
   * per frame for the life of one stroke.
   *
   * Both comps are placed by the same chain, so the crossing is
   * `theirs.fromWorld(mine.toWorld(p))` and nothing here does geometry of its
   * own. Undefined for the comp the gesture is already in — the overwhelming
   * case, and one fewer closure per dab.
   */
  const bridgeFactory = (mine: EditSpace, doc: MotionDocument) => {
    const cache = new Map<string, SpaceBridge | undefined>();
    return (frameId: string): SpaceBridge | undefined => {
      if (frameId === mine.frame.id) return undefined;
      if (cache.has(frameId)) return cache.get(frameId);
      const theirs = frameSpace(frameId, doc);
      const bridge: SpaceBridge | undefined = theirs
        ? {
            at: (p) => theirs.fromWorld(mine.toWorld(p)),
            // A LENGTH crosses too. A nib 20 units wide here is 20 units of
            // WORLD only if both comps sit at the same cumulative scale, and
            // inside a half-size comp it has to become 40 of theirs to look the
            // same size on screen. Points alone would have made the eraser
            // change width the moment it reached past its own comp.
            lengthScale: theirs.worldToLocal / (mine.worldToLocal || 1),
          }
        : undefined;
      cache.set(frameId, bridge);
      return bridge;
    };
  };

  /**
   * A raster clip's LayerBasis for frame↔surface mapping (at the playhead).
   * `x/y` is the layer's POSITION — where its PIVOT sits, not its box center —
   * which is why the surface mapping below goes through the one layer map
   * rather than rotating about `x/y`: painting on a layer with a moved pivot
   * used to land the stroke somewhere else entirely.
   */
  const rasterPose = (clip: RasterClip) => {
    const local = Math.min(Math.max(0, useSession.getState().playheadMs - clip.startMs), clip.durationMs);
    const kf = sampleKeyframes(clip.keyframes, local);
    const n = (k: string, d: number) => (typeof kf[k] === "number" ? (kf[k] as number) : d);
    const t = clip.transform;
    const scale = Math.max(0.0001, n("scale", t.scale));
    return {
      cx: n("x", t.x),
      cy: n("y", t.y),
      scale,
      scaleY: Math.max(0.0001, t.scaleY == null ? scale : n("scaleY", t.scaleY)),
      rotation: n("rotation", t.rotation),
      skewX: n("skewX", t.skewX),
      skewY: n("skewY", t.skewY),
      anchor: { x: n("anchor.x", t.anchor.x), y: n("anchor.y", t.anchor.y) },
      size: { width: clip.width, height: clip.height, cx: 0, cy: 0 },
    };
  };

  const makeRasterTarget = (clip: RasterClip): RasterTarget => {
    // Resolve the actual surface this stroke paints: for a recorded (capture)
    // layer that's the current frame's snapshot — seeded from the LEFT keyframe
    // when a new frame is born — else the layer's own surface. The pose stays
    // the clip's; only the surface (and its baseline rev) is redirected.
    const session = useSession.getState();
    const plan =
      planRasterDraw({
        doc: store.getState(),
        clipId: clip.id,
        playheadMs: session.playheadMs,
        recording: session.recording,
        seed: useDrawing.getState().capture.seed,
      }) ?? liveDrawPlan(clip);
    seedDrawSurface(plan);
    const drawClip: RasterClip = { ...clip, surfaceId: plan.surfaceId, rev: plan.rev };
    return { clip: drawClip, plan, tx: beginStroke(drawClip, { grows: plan.grows }), ...rasterPose(clip) };
  };

  /** Frame-center point → a target's surface pixels. Reads only the pose (no
   *  tx), so a bare `{ ...rasterPose(clip), clip }` works for hit-testing. */
  const toSurface = (
    t: ReturnType<typeof rasterPose> & { clip: RasterClip; from?: SpaceBridge },
    p: { x: number; y: number },
  ) => {
    const q = t.from ? t.from.at(p) : p;
    const l = unmapLocal(q.x - t.cx, q.y - t.cy, t);
    return { x: l.x + t.clip.width / 2, y: l.y + t.clip.height / 2 };
  };

  // ── Target resolution ──────────────────────────────────────────────────────

  /** Paintable raster layers of the active comp, topmost first. */
  const rasterLayers = (doc: MotionDocument, frameId: string): RasterClip[] => {
    const out: RasterClip[] = [];
    for (const track of doc.tracks) {
      if (track.hidden || track.locked) continue;
      for (const clip of track.clips) {
        if (clip.kind === "raster" && clip.frameId === frameId && !clip.locked && !clip.hidden) {
          out.push(clip);
        }
      }
    }
    return out;
  };

  /**
   * The raster layer a brush/fill lands on: the selected one when it's a
   * pixel layer, else the comp's topmost. None at all → auto-create one (one
   * undo step, zero dialogs — the guard the user actually wants is "just let
   * me paint").
   */
  /**
   * A NON-destructive paint overlay for a media/vector clip: a raster layer is
   * "the overlay" — reusing the entire pixel pipeline (tools, renderer, undo,
   * capture-recording, lasso) with zero new machinery. Reuses an existing linked
   * overlay if present, else spawns a comp-sized pixel layer directly above the
   * host and link-groups them so they travel/delete together. The host media is
   * never touched.
   */
  const findOrCreatePaintOverlay = (frame: Frame, host: Clip): RasterClip | null => {
    const doc = store.getState();
    const depth = useDrawing.getState().scope.depth;
    if (host.linkGroupId) {
      for (const track of doc.tracks) {
        for (const clip of track.clips) {
          if (
            clip.kind === "raster" &&
            clip.frameId === frame.id &&
            clip.linkGroupId === host.linkGroupId &&
            !clip.locked &&
            !clip.hidden &&
            // One overlay per SIDE. Painting over and painting under a photo are
            // two different layers — reusing one would make "under" mean
            // "under, in a layer that sits on top", which is nothing at all. The
            // second stroke on a side finds that side's layer and keeps going
            // into it, which is what makes over/under a mode rather than a
            // per-stroke lottery.
            clip.name.endsWith(depth === "under" ? OVERLAY_UNDER : OVERLAY_OVER)
          ) {
            return clip;
          }
        }
      }
    }
    const overlay = createRasterClip({
      frameId: frame.id,
      width: frame.width,
      height: frame.height,
      // The host's span, so a mark made on a video lasts exactly as long as the
      // shot — the same promise `referenceTiming` makes for an explicit
      // reference, applied to the layer you are visibly painting on.
      startMs: host.startMs,
      durationMs: host.durationMs,
      name: `${host.name} ${depth === "under" ? OVERLAY_UNDER : OVERLAY_OVER}`,
    });
    store.update("Add paint overlay", (d) => {
      placeClip(d, overlay, depth === "under" ? { belowClipId: host.id } : { aboveClipId: host.id });
      linkClips(d, [host.id, overlay.id]);
    });
    useSession.getState().select([overlay.id]);
    const loc = locateClip(store.getState(), overlay.id);
    return loc?.clip.kind === "raster" ? loc.clip : null;
  };

  /**
   * A new layer's TIMING and PLACE, from whatever context exists — the one
   * answer for the brush, the bucket and the vector brush.
   *
   * Order of authority, and each step is a thing the artist actually did:
   *   1. a SELECTED clip — you pointed at it, so the mark belongs beside it;
   *   2. an explicit REFERENCE — you set it up, so the mark belongs with it;
   *   3. nothing — the playhead and the app's default length.
   *
   * Timing rides along with the anchor rather than being asked for separately,
   * because they are the same decision: a layer that sits beside a shot and
   * outlives it is the bug that made painting on video feel broken.
   */
  const paintPlacement = (
    frame: Frame,
  ): { anchorId?: string; startMs?: number; durationMs?: number } => {
    const doc = store.getState();
    const session = useSession.getState();
    const drawing = useDrawing.getState();
    for (const id of session.selectedClipIds) {
      const loc = locateClip(doc, id);
      if (!loc || loc.clip.frameId !== frame.id || loc.clip.kind === "audio") continue;
      return { anchorId: loc.clip.id, startMs: loc.clip.startMs, durationMs: loc.clip.durationMs };
    }
    const reference = resolveReference(doc, frame.id, drawing.scope.refs);
    const timing = referenceTiming(reference, drawing.scope.refs);
    return { anchorId: referenceAnchorClipId(reference), ...(timing ?? {}) };
  };

  /** Where a new layer lands relative to its anchor — one expression, so the
   *  bucket, the brush and the vector brush cannot read `depth` differently. */
  const placeByDepth = (anchorId: string | undefined, depth: PaintDepth) =>
    anchorId ? (depth === "under" ? { belowClipId: anchorId } : { aboveClipId: anchorId }) : {};

  const resolveRasterTarget = (frame: Frame, opts: { fresh?: boolean } = {}): RasterClip | null => {
    const doc = store.getState();
    const session = useSession.getState();
    for (const id of session.selectedClipIds) {
      // A contained stroke may only adopt a layer that already HAS a container
      // (its mask then either covers the new region or grows to). Anything else
      // would be clipping artwork that was there before the gesture.
      if (opts.fresh) break;
      const loc = locateClip(doc, id);
      if (!loc || loc.clip.frameId !== frame.id || isClipLocked(loc.track, loc.clip)) continue;
      // A selected pixel layer paints its own surface; a selected image/video/
      // vector paints a non-destructive overlay layer (headless decision).
      const decision = resolvePaintTarget({ id: loc.clip.id, kind: loc.clip.kind }, "raster");
      if (decision.kind === "edit" && decision.surface === "own" && loc.clip.kind === "raster") {
        return loc.clip;
      }
      // A SELECTED PAINT LAYER made of parts means its topmost part — the same
      // reading a selected path clip gets: the next stroke joins the artwork you
      // pointed at. Which part is not a question the brush asks; splitting a
      // drawing is `Separate`, deliberately, exactly as it is for vectors.
      if (isPartGroup(doc, loc.clip)) {
        const first = partsOf(doc, loc.clip.id)[0];
        if (first) return first;
      }
      if (decision.kind === "edit" && decision.surface === "overlay") {
        const overlay = findOrCreatePaintOverlay(frame, loc.clip);
        if (overlay) return overlay;
      }
    }
    // Nothing paintable is selected → ALWAYS a fresh pixel layer. Never adopt a
    // nearby existing clip: a stroke lands on your TARGET layer (the selected
    // one) or a brand-new one, full stop — never silently on someone else's.
    //
    // It is born like a shape or a path: AT THE PLAYHEAD, with the ordinary
    // default length, trimmable and extendable with the same drag. The one
    // exception is a STATIC frame (a drawing, a design), where the layers ARE
    // the picture and must span it — the case that used to be applied to every
    // pixel layer everywhere.
    const inDrawing = frame.mode === "static";
    const place = paintPlacement(frame);
    // A PIXEL LAYER IS BORN THE SIZE OF ITS COMP.
    //
    // It was briefly born the size of the MARK — a few hundred pixels — on the
    // argument that a drawing covering a tenth of the canvas should not reserve
    // the whole of it. The argument is good and the change was wrong: it made
    // the GROWTH path (`padFor` / `growRasterClip`) run on every ordinary
    // stroke instead of only on one that genuinely leaves the comp, and a path
    // that had been exercised rarely became the common one overnight. Strokes
    // came back cut to a square the size of the starting surface.
    //
    // Comp-sized is the shape every other part of this file was written
    // against, and growth stays what it was for: paint that really does leave
    // the frame. The memory idea is worth having back, behind a shrink-to-ink
    // pass AFTER a stroke commits rather than a guess before it starts.
    const born = { x: 0, y: 0, width: frame.width, height: frame.height };
    const clip = createRasterClip({
      frameId: frame.id,
      width: born.width,
      height: born.height,
      startMs: inDrawing ? 0 : (place.startMs ?? Math.max(0, session.playheadMs)),
      durationMs: inDrawing ? frameDurationMs(doc, frame) : place.durationMs,
      fillDuration: inDrawing,
      name: "Pixel layer",
    });
    clip.transform = { ...clip.transform, x: born.x, y: born.y };
    store.update("Add pixel layer", (d) =>
      placeClip(d, clip, placeByDepth(place.anchorId, useDrawing.getState().scope.depth)),
    );
    const loc = locateClip(store.getState(), clip.id);
    return loc?.clip.kind === "raster" ? loc.clip : null;
  };

  // ── Sample extraction (coalesced, normalized) ──────────────────────────────

  const samplesOf = (e: React.PointerEvent, s: ActiveStroke): PenSample[] =>
    s.pen.take(e.nativeEvent, localPoint, (q) => s.space.fromScreen(q));

  /**
   * The leash length right now, in screen px. ⇧ is a floor on whatever the tool
   * carries, so a clean arc is always one key away — and because it is read per
   * sample, pressing or releasing it mid-stroke takes effect immediately.
   */
  const liveLeash = (f: PathFidelity): number => stabilizerRadius(f.smoothing, shiftHeld());

  // ── Stroke lifecycle ───────────────────────────────────────────────────────

  /**
   * The stencil this gesture is confined to, or null.
   *
   * Read at touch-down from the pointer's own position, so "inside" means the
   * region you STARTED in — the only reading under which a stroke that leaves
   * the shape behaves predictably. Costs one cached reference raster plus one
   * flood; on the second stroke into the same artwork the raster is free (see
   * `paint-region.ts`).
   */
  const armStencil = (
    frame: Frame,
    p: { x: number; y: number },
    /** Vector strokes need the region as GEOMETRY; pixels need it as alpha. */
    wantGeometry: boolean,
  ): {
    stencil: HTMLCanvasElement | null;
    confineMask: RegionMask | null;
    confineRefs: string[];
  } => {
    const none = { stencil: null, confineMask: null, confineRefs: [] };
    const scope = useDrawing.getState().scope;
    if (!scopeNeedsRegion(scope)) return none;
    const { mask, reference } = resolveScopeRegion(frame, p, {
      invert: scope.confine === "outside",
      medium: wantGeometry ? "vector" : "raster",
    });
    if (!mask || mask.bounds.x1 < mask.bounds.x0) {
      toast(scope.confine === "outside" ? "Nothing to paint around here" : "Nothing to paint inside here");
      return none;
    }
    // AN OPEN REGION IS NOT AN ENCLOSURE.
    //
    // Start a stroke on bare canvas, or inside a shape whose outline has a gap
    // wider than the setting, and the flood escapes: the region becomes the
    // whole frame minus the artwork. Confining to that is meaningless — and
    // under `contain` it is actively bad, because it builds a group and traces
    // a many-thousand-point stencil that clips nothing.
    //
    // So it is refused, and the message names the fix rather than the symptom.
    // Only for `inside`: a `outside` region is the complement and reaching
    // every edge is exactly what it is supposed to do.
    if (scope.confine === "inside" && regionEscaped(mask)) {
      toast("That area isn't closed — raise Close gaps, or start inside a shape");
      return none;
    }
    // The MASK always comes back — it is what a live containment is traced from,
    // and both media can be contained. The alpha STENCIL is only built for the
    // one case that needs it: cutting pixels as they are laid down. Same region,
    // two readings, one resolve.
    const needsStencil = !wantGeometry && scope.confineMode === "cut";
    return {
      stencil: needsStencil ? stencilCanvas(mask, scope.featherPx) : null,
      confineMask: mask,
      // Only an EXPLICIT reference can be tracked. "Everything visible" is not
      // a thing to follow, and copying every layer in the comp as a stencil
      // would be a spectacular way to answer a small question.
      confineRefs: scope.refs.length > 0 ? reference.clipIds : [],
    };
  };

  /**
   * Did the flood escape? A region that reaches all four edges of the frame
   * found no boundary in any direction. The hover preview draws this case in
   * the destructive colour, and this is the same test — one reading of "open",
   * so the warning you saw and the refusal you get cannot disagree.
   */
  const regionEscaped = (mask: RegionMask): boolean =>
    mask.bounds.x0 <= 0 &&
    mask.bounds.y0 <= 0 &&
    mask.bounds.x1 >= mask.width - 1 &&
    mask.bounds.y1 >= mask.height - 1;

  /**
   * Clip a surface-space buffer to the gesture's stencil.
   *
   * `destination-in` is the one operation that works identically for a brush's
   * flow buffer, the bucket's flood and the live preview: whatever is in the
   * buffer keeps the stencil's alpha and loses the rest. Feather rides along as
   * coverage, so a soft confine and a hard one differ by a number rather than
   * by a code path.
   */
  const clipToStencil = (
    ctx: CanvasRenderingContext2D,
    stencil: HTMLCanvasElement,
    t: RasterTarget,
    frame: Frame,
    /** Bound the work to what just changed — a full-surface composite per
     *  pointer move is O(W·H) sixty times a second at 4K. Canvas `clip()`
     *  constrains a composite op as well as a draw, which is what makes a
     *  destination-in safe to run on a sub-rect at all. */
    rect?: DirtyRect,
  ): void => {
    ctx.save();
    if (rect) {
      ctx.beginPath();
      ctx.rect(rect.x0 - 1, rect.y0 - 1, rect.x1 - rect.x0 + 2, rect.y1 - rect.y0 + 2);
      ctx.clip();
    }
    ctx.globalCompositeOperation = "destination-in";
    drawFrameCanvasIntoSurface(ctx, stencil, t, frame);
    ctx.restore();
  };

  const beginBrushStroke = (e: React.PointerEvent): void => {
    const session = useSession.getState();
    const lib = useBrushLibrary.getState();
    const drawing = useDrawing.getState();
    // The eraser is always dab-shaped (vector splitting happens on release
    // via the trail); the brush follows the armed engine's active preset.
    const isEraser = tool === "eraser";
    // A brush/vector stroke commits an armed empty flipbook slot; the eraser
    // never conjures a blank frame (nothing to erase on it).
    const ctx = isEraser ? paintCtx() : paintCtxOrCreate();
    if (!ctx) {
      toast("No frame under the playhead — add one in the sheet");
      return;
    }
    const { frame } = ctx;
    // The eraser carries its own armed brush (its tip is a setting, not a
    // constant); the brush tool follows the armed engine's preset.
    const brush = isEraser ? armedBrushFor("eraser") : armedBrush();
    const useVector = !isEraser && brush.engine === "vector";

    const eff = isEraser
      ? { size: drawing.eraser.size, opacity: drawing.eraser.opacity }
      : lib.effective(brush.id);
    // One fidelity per gesture, read once: the leash cannot change identity
    // mid-stroke even if the options bar does (⇧ still raises it live).
    const fidelity = isEraser ? drawing.eraser.fidelity : drawing.brush.fidelity;

    const pen = new PenInput(drawing.pressure, e.pointerType, () => liveLeash(fidelity));
    // ONE call, before the branch: every stroke mode is confined by the same
    // rule, resolved from the same point, whatever it is about to paint with.
    const { stencil, confineMask, confineRefs } = armStencil(
      frame,
      paintLocal(localPoint(e), ctx),
      useVector,
    );
    const depth = drawing.scope.depth;
    const confineMode = drawing.scope.confineMode;
    // What happens to this gesture's CONTAINER — asked once, before the branch,
    // from where the stroke started. Every mode needs the same answer, and the
    // point it is asked about must not move mid-stroke.
    const containment = resolveContainment(
      { confineMask, confineMode },
      useSession.getState().selectedClipIds[0] ?? null,
      paintLocal(localPoint(e), ctx),
      frame,
    );

    if (useVector) {
      // Vector brush: engine runs in FRAME coords; the path clip is built on
      // release. Nothing to journal — the doc update IS the undo step.
      const engine = new StrokeEngine(brush, drawing.pressure, eff.size, 1, Date.now() & 0xffff);
      strokeRef.current = {
        mode: "vector-brush",
        pointerId: e.pointerId,
        frame,
        space: ctx,
        brush,
        color: drawing.brush.color,
        sizePx: eff.size,
        opacity: eff.opacity,
        engine,
        pen,
        buffer: null,
        bufferCtx: null,
        bufferPad: { left: 0, top: 0, right: 0, bottom: 0 },
        target: null,
        eraseTargets: [],
        vectorTargets: [],
        trail: [],
        fidelity,
        stencil,
        confineMask,
        confineRefs,
        depth,
        confineMode,
        containment,
        dirty: null,
      };
      return;
    }

    if (isEraser) {
      // WHAT the eraser may touch is one headless question (`resolveStrokeTargets`),
      // asked once here: this layer or all VISIBLE layers, pixels and outlines
      // together. Pixel layers open a journal tx and erase live; vector layers
      // collect the trail and are cut on release, each by the configured mode.
      // Erasing used to fall back to the topmost PIXEL layer even with a path
      // selected, so rubbing out a drawn outline quietly holed the photo behind it.
      const doc = store.getState();
      // HOW FAR the eraser reaches is the second axis (`DepthReach`): this comp
      // by default, and as many comps outward/inward as the reach setting
      // allows. A target in another comp is in another SPACE, so each one
      // carries the bridge from this stroke's coordinates into its own.
      const reachFrames = reachableFrameIds(doc, session.nav.path, drawing.scope.reach);
      const targets = resolveStrokeTargets(
        doc,
        reachFrames,
        session.selectedClipIds,
        drawing.eraser.scope,
        // On a STATIC frame the whole frame IS the moment: its layers have no
        // independent timeline life, so the time gate would exclude all of them.
        // Read off the frame's own nature, not off how you happened to get here.
        frame.mode === "static" ? null : session.playheadMs,
      );
      const layers: Array<{ clip: RasterClip; from?: SpaceBridge }> = [];
      const vectorTargets: Array<{ clipId: string; from?: SpaceBridge }> = [];
      const bridgeTo = bridgeFactory(ctx, doc);
      for (const t of targets) {
        if (t.medium === "vector") {
          vectorTargets.push({ clipId: t.clipId, from: bridgeTo(t.frameId) });
          continue;
        }
        const clip = locateClip(doc, t.clipId)?.clip;
        if (clip?.kind === "raster") layers.push({ clip, from: bridgeTo(t.frameId) });
      }
      const engine = new StrokeEngine(brush, drawing.pressure, eff.size, 1, Date.now() & 0xffff);
      strokeRef.current = {
        mode: "raster-erase",
        pointerId: e.pointerId,
        frame,
        space: ctx,
        brush,
        color: "#fff",
        sizePx: eff.size,
        opacity: eff.opacity,
        engine,
        pen,
        buffer: null,
        bufferCtx: null,
        bufferPad: { left: 0, top: 0, right: 0, bottom: 0 },
        target: null,
        eraseTargets: layers.map((l) => ({ ...makeRasterTarget(l.clip), from: l.from })),
        vectorTargets,
        trail: [],
        fidelity,
        stencil,
        confineMask,
        confineRefs,
        depth,
        confineMode,
        containment,
        dirty: null,
      };
      return;
    }

    // Raster brush. A stroke about to be CONTAINED lands on a fresh layer
    // unless the one it would join is already inside a mask group — the same
    // rule the vector side follows, for the same reason.
    const target = resolveRasterTarget(frame, { fresh: containment === "fresh" });
    if (!target) return;
    useSession.getState().select([target.id]);
    // The buffer starts one block wider than the layer on every side, so the
    // first stroke over an edge needs no reallocation at all; `growStrokeBuffer`
    // adds more as a stroke keeps travelling outward.
    // The bleed follows the WRITE's own decision — a snapshot under Record never
    // grows, so its buffer has no room past the box to paint into.
    const t = makeRasterTarget(target);
    const bleed = t.tx.grows ? initialBleed() : NO_PAD;
    const buffer = document.createElement("canvas");
    buffer.width = target.width + bleed.left + bleed.right;
    buffer.height = target.height + bleed.top + bleed.bottom;
    const bufferCtx = buffer.getContext("2d")!;
    bufferCtx.setTransform(1, 0, 0, 1, bleed.left, bleed.top);
    // Engine works directly in SURFACE pixels: size stays true to the layer.
    const engine = new StrokeEngine(brush, drawing.pressure, eff.size, 1, Date.now() & 0xffff);
    strokeRef.current = {
      mode: "raster-brush",
      pointerId: e.pointerId,
      frame,
      space: ctx,
      brush,
      // Resolved: this stroke becomes pixels (see `inkColor`).
      color: inkColor(drawing.brush.color),
      sizePx: eff.size,
      opacity: eff.opacity,
      engine,
      pen,
      buffer,
      bufferCtx,
      bufferPad: { ...bleed },
      target: t,
      eraseTargets: [],
      vectorTargets: [],
      trail: [],
      fidelity,
      stencil,
      confineMask,
      confineRefs,
      depth,
      confineMode,
      containment,
      dirty: null,
    };
  };

  const feedStroke = (e: React.PointerEvent): void => {
    const s = strokeRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    consumeSamples(s, samplesOf(e, s));
  };

  /**
   * Where samples become marks. Split out from `feedStroke` because the
   * stabiliser's release also produces samples (the catch-up to where you let
   * go) and they have to land exactly the same way — one consumer, so a
   * smoothed stroke and a raw one cannot end differently.
   */
  const consumeSamples = (s: ActiveStroke, samples: PenSample[]): void => {
    if (samples.length === 0) {
      dirtyRef.current = true; // the leash moved even if the tool did not
      return;
    }

    if (s.mode === "vector-brush") {
      for (const sample of samples) s.engine.feed(sample);
      dirtyRef.current = true;
      return;
    }

    if (s.mode === "raster-brush" && s.target && s.bufferCtx) {
      const t = s.target;
      const wet = s.brush.rendering.wet;

      // WET MEDIA: dabs go into the layer's water film instead of onto pixels.
      // Nothing else changes — the stroke engine still produces the same dabs,
      // with the same dynamics — so a wet brush is the same brush painting into
      // a medium that keeps moving after the stroke ends.
      if (wet.enabled) {
        const surface = surfaceForClip(t.clip);
        const film = wetForSurface(surface, wet);
        const rgb = hexToUnitRgb(s.color);
        for (const sample of samples) {
          const sp = toSurface(t, sample);
          for (const dab of s.engine.feed({ ...sample, x: sp.x, y: sp.y })) {
            const d = scaleDab(dab, t);
            film.dab(d.x, d.y, Math.max(0.5, d.size / 2), rgb, d.alpha * s.opacity, wet.wetness);
          }
        }
        touchSurfaces();
        dirtyRef.current = true;
        return;
      }

      for (const sample of samples) {
        const sp = toSurface(t, sample);
        const dabs = s.engine.feed({ ...sample, x: sp.x, y: sp.y }).map((d) => scaleDab(d, t));
        // Room BEFORE ink. A dab stamped past the buffer's edge is simply gone,
        // and no later measurement can tell you it was ever there.
        const bounds = dabBounds(dabs);
        if (bounds && t.tx.grows) growStrokeBuffer(s, bounds, t.clip.width, t.clip.height);
        const rect = stampDabs({ ctx: s.bufferCtx! }, dabs, s.brush, s.color);
        if (!rect) continue;
        // Confine the FLOW BUFFER, not the commit. The live preview draws this
        // same buffer, so clipping here is what makes the stroke on screen the
        // stroke that lands — the alternative (clip on release) shows paint
        // spilling over the line for the whole gesture and then snaps it back.
        //
        // Under CONTAIN the pixels are left whole and the layer is masked at
        // render time, so they stay movable. The stencil is still armed, and it
        // is what the layer's mask will be traced from.
        if (s.stencil && s.confineMode === "cut") clipToStencil(s.bufferCtx, s.stencil, t, s.frame, rect);
        s.dirty = growRect(s.dirty, rect);
      }
      dirtyRef.current = true;
      return;
    }

    // raster-erase: dabs land straight on every target surface, live.
    for (const sample of samples) {
      const dabs = s.engine.feed(sample); // frame coords
      if (dabs.length === 0) continue;
      for (const d of dabs) s.trail.push({ x: d.x, y: d.y, radius: d.size / 2 });
      for (const t of s.eraseTargets) {
        const surface = surfaceForClip(t.clip);
        const local = dabs.map((d) => scaleDab({ ...d, ...toSurface(t, d) }, t));
        // The eraser writes STRAIGHT onto the surface — the layer is its own
        // feedback — so the undo snapshot of what it is about to remove has to
        // be taken here, a nib's width at a time. See `StrokeTx.tiles`.
        captureDabs(t, local);
        if (s.stencil) {
          // Confined erasing cannot stamp straight onto the layer: the surface
          // IS the feedback, so anything that reaches it has already happened.
          // The dabs go into a scratch, the scratch is clipped, and only what
          // survives is knocked out — bounded to the dabs' own rect, so the
          // cost is the size of the nib rather than the size of the canvas.
          const scratch = eraseScratch(t);
          const rect = stampDabs({ ctx: scratch.getContext("2d")! }, local, s.brush, s.color);
          if (!rect) continue;
          const sctx = scratch.getContext("2d")!;
          clipToStencil(sctx, s.stencil, t, s.frame, rect);
          surface.ctx.save();
          surface.ctx.globalCompositeOperation = "destination-out";
          surface.ctx.drawImage(
            scratch,
            rect.x0, rect.y0, rect.x1 - rect.x0 + 1, rect.y1 - rect.y0 + 1,
            rect.x0, rect.y0, rect.x1 - rect.x0 + 1, rect.y1 - rect.y0 + 1,
          );
          surface.ctx.restore();
          sctx.clearRect(rect.x0 - 1, rect.y0 - 1, rect.x1 - rect.x0 + 3, rect.y1 - rect.y0 + 3);
          extendDirty(t.tx, rect.x0, rect.y0, rect.x1, rect.y1);
          continue;
        }
        const rect = stampDabs({ ctx: surface.ctx, erase: true }, local, s.brush, s.color);
        if (rect) extendDirty(t.tx, rect.x0, rect.y0, rect.x1, rect.y1);
      }
    }
    touchSurfaces(); // live stage repaint — the layer IS the feedback
    dirtyRef.current = true;
  };

  /**
   * A scratch canvas per erase target, born on first confined use and dropped
   * with the stroke. Keyed by the target object rather than the clip id so a
   * gesture that touches the same layer through two targets (a capture snapshot
   * and the layer's own surface) cannot share one buffer.
   */
  const eraseScratchRef = React.useRef(new WeakMap<RasterTarget, HTMLCanvasElement>());
  const eraseScratch = (t: RasterTarget): HTMLCanvasElement => {
    const existing = eraseScratchRef.current.get(t);
    if (existing) return existing;
    const canvas = document.createElement("canvas");
    canvas.width = t.clip.width;
    canvas.height = t.clip.height;
    eraseScratchRef.current.set(t, canvas);
    return canvas;
  };

  /** Snapshot the pixels a run of dabs is about to erase (see `captureBefore`). */
  const captureDabs = (t: RasterTarget, dabs: Dab[]): void => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const d of dabs) {
      const r = d.size / 2 + 2;
      if (d.x - r < x0) x0 = d.x - r;
      if (d.y - r < y0) y0 = d.y - r;
      if (d.x + r > x1) x1 = d.x + r;
      if (d.y + r > y1) y1 = d.y + r;
    }
    if (x1 > x0) captureBefore(t.tx, x0, y0, x1, y1);
  };

  /** A frame-coord dab mapped into a target's surface space. */
  const scaleDab = (d: Dab, t: RasterTarget): Dab => ({
    ...d,
    size: d.size / ((t.scale + t.scaleY) / 2),
  });

  /**
   * End the live stroke and commit it — the SAME ending however the gesture
   * finished.
   *
   * There is no catch-up and no release-only step: under smoothing the stroke
   * stops where the tool is, which is where it has visibly been the whole time
   * (core `stabilizerPush`). So a lift on the canvas, a drag off the frame, a
   * browser cancel and a lost pointer all produce the identical line, and there
   * is nothing here that could put ink somewhere the artist did not.
   */
  const finishStroke = (): void => {
    const s = strokeRef.current;
    strokeRef.current = null;
    dirtyRef.current = true;
    if (!s) return;
    s.engine.finish();

    if (s.mode === "vector-brush") {
      commitVectorStroke(s);
      return;
    }

    if (s.mode === "raster-brush" && s.target && s.buffer && s.bufferCtx) {
      const t = s.target;
      // A wet stroke commits nothing here. Its paint is on the WATER, not in
      // the bitmap, and it keeps moving — so the undoable moment is when it
      // dries, not when the pen lifts. Committing now would freeze a wash the
      // instant you stopped drawing it, which is the one thing wet media must
      // not do.
      if (s.brush.rendering.wet.enabled) {
        wetLog("stroke-end", { surface: t.clip.surfaceId, dabs: s.engine.dabs.length });
        touchSurfaces();
        return;
      }
      // End taper re-renders the buffer from the full dab list (cheap, once).
      if (s.brush.strokePath.taperEndPx > 0) {
        const dabs = [...s.engine.dabs] as Dab[];
        applyEndTaper(dabs, s.brush);
        // In SURFACE coordinates — the buffer's context is offset by its pad,
        // so clearing from 0,0 would leave the overhang untouched.
        s.bufferCtx.clearRect(-s.bufferPad.left, -s.bufferPad.top, s.buffer.width, s.buffer.height);
        const rect = stampDabs({ ctx: s.bufferCtx }, dabs, s.brush, s.color);
        if (rect) s.dirty = growRect(s.dirty, rect);
      }
      if (!s.dirty) return;
      /*
       * THE LAYER GROWS TO HOLD WHAT LEFT IT.
       *
       * `s.dirty` is in surface coordinates and may be negative or past the
       * edge — that is exactly the paint the buffer's bleed preserved. If any
       * of it is outside, the SURFACE grows first (which re-pads the open
       * transaction's snapshot and slides its dirty rect, so the commit still
       * describes the right pixels), and the document's width/height/pivot are
       * written in the SAME update that bumps `rev`. One revision, one undo
       * step, and the box can never be a revision out of step with its pixels.
       */
      paintIntoRaster(t.tx, s.dirty, (ctx, off) => {
        ctx.globalAlpha = s.opacity;
        // OVER or UNDER — the same one-word difference the bucket makes, because
        // "draw behind what is already on this layer" is a property of the mark,
        // not of the tool that made it.
        if (s.depth === "under") ctx.globalCompositeOperation = "destination-over";
        // Grain gates the whole stroke's alpha (anchored paper texture).
        // The buffer sits `bufferPad` outside the surface; `off` is how far the
        // surface's own origin moved if the layer grew to hold this stroke. The
        // difference is where the buffer's top-left now belongs.
        ctx.drawImage(
          grainGatedBuffer(s.buffer!, s.brush),
          off.x - s.bufferPad.left,
          off.y - s.bufferPad.top,
        );
      });
      const nextRev = t.clip.rev + 1;
      if (commitStroke(t.tx, nextRev)) {
        store.update("Brush stroke", (d) => {
          commitDrawSurface(d, t.clip.id, t.plan, nextRev, t.tx);
          // Pixels stay whole; the region becomes the layer's live mask, so a
          // painted-in shadow can still be moved, scaled and animated later.
          // `join` has nothing to build. `extend` adds a stencil to the group
          // that already holds this layer; `fresh` builds the group. Both go
          // through the same call — it reads the layer's group itself.
          if (s.confineMask && s.confineMode !== "cut" && s.containment !== "join") {
            containInRegion(
              d,
              t.clip.id,
              s.confineMask,
              s.frame,
              useDrawing.getState().scope.featherPx,
              s.confineMode,
              s.confineRefs,
            );
          }
        });
        invalidateReferenceRaster();
        touchSurfaces();
      }
      return;
    }

    if (s.mode === "raster-erase") {
      commitEraseStroke(s);
    }
  };

  /**
   * A finished vector stroke. Where it LANDS is the same headless decision the
   * pixel brush makes (`resolvePaintTarget`): a selected path layer receives the
   * stroke, anything else gets a new path clip. Before this, a vector stroke
   * always spawned its own clip — the paint-target table said "edit" and nobody
   * was listening, so drawing on a vector layer quietly littered the timeline.
   *
   * WHAT IT LOOKS LIKE is the options bar, always — the armed brush, its
   * colour, and the pressure this gesture actually applied. A stroke used to
   * ADOPT the target layer's paint instead, which had two bad consequences and
   * one worse one: you could not draw a second colour without making a second
   * layer; every stroke after the first wore the first one's pressure; and the
   * live preview (drawn with the armed brush, correctly) visibly changed the
   * instant you lifted the pen, because the thing that got committed was not
   * the thing you had been looking at. That flicker was never an optimisation —
   * it was the inheritance, showing.
   *
   * So a drawn contour carries its OWN ink (`setContourInk`), and the layer is
   * the group it belongs to rather than the source of its look. Drawing ten
   * strokes with one brush still writes no overrides at all — matching ink goes
   * back to inheriting at the write seam — so the common drawing stays one
   * path on the renderer's fast case and the layer's colour still edits all of
   * it. Disagree about anything, and only that stroke disagrees.
   */

  /**
   * CONFINING A VECTOR STROKE — by cutting the LINE, not by clipping a shape.
   *
   * The obvious version is wrong in a way that silently eats the stroke: a
   * vector brush's geometry is the centre line (an open contour, with the width
   * living in the stroke style — that is what keeps a drawn line an editable
   * line), and intersecting an open contour with a region as polygons returns
   * nothing at all.
   *
   * So the POLYLINE is split before it is ever fitted, and each run inside the
   * region is fitted into its own stroke. Everything survives: pressure widths,
   * tapers, caps, dash, colour, trim. A line drawn across two enclosures
   * becomes two lines, which is exactly what it looks like on the canvas.
   */
  const vectorPieces = (s: ActiveStroke): VectorStroke[] => {
    const drawing = useDrawing.getState();
    // The engine's own point type — a polyline sample, not a full pen sample.
    type EnginePoint = (typeof s.engine.polyline)[number];
    const fit = (points: readonly EnginePoint[]) =>
      vectorStroke(points, s.brush, s.sizePx, { fidelity: s.fidelity, pressure: drawing.pressure });
    // CONTAIN keeps the whole stroke — the region becomes a live mask over the
    // layer instead of a pair of scissors (see `containInRegion`). So the split
    // only runs for `cut`.
    if (!s.confineMask || drawing.scope.confineMode !== "cut") {
      const one = fit(s.engine.polyline);
      return one ? [one] : [];
    }
    const mask = s.confineMask;
    const hw = s.frame.width / 2;
    const hh = s.frame.height / 2;
    const runs = splitPolylineByMask(
      s.engine.polyline,
      (p) => maskContains(mask, p.x + hw, p.y + hh),
      // A crossing point is a real sample: the pressure at the boundary is the
      // pressure the hand was applying there, so the cut end tapers correctly
      // instead of snapping to whichever neighbour happened to be kept.
      (a, b, t) => ({
        ...a,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
      }),
    );
    const out: VectorStroke[] = [];
    for (const run of runs) {
      const piece = fit(run);
      if (piece) out.push(piece);
    }
    return out;
  };

  const commitVectorStroke = (s: ActiveStroke): void => {
    const drawing = useDrawing.getState();
    const pieces = vectorPieces(s);
    if (pieces.length === 0) return;
    const session = useSession.getState();
    const existing = vectorTarget(s.frame);
    // Only `fresh` forces a new layer. `extend` keeps the layer and grows its
    // mask instead — one layer with a four-part mask beats four layers.
    const target = s.containment === "fresh" ? null : existing;

    // The ink a PIECE was drawn with: the brush's line stack in the armed
    // colour, with that piece's own measured pressure folded onto the line that
    // carries the body. Per piece rather than per gesture, because a confined
    // stroke is several pieces and each one has its own pressure along its own
    // length — sharing one profile would stretch the first run's pressure over
    // all of them.
    const inkFor = (piece: VectorStroke, lines: StrokeStyle[]) => ({ strokes: vectorStrokeInk(piece, lines), fills: [] as Paint[] });
    const drawnFor = (piece: VectorStroke) => brushLines(piece, drawing.brush.color);
    const stroke = pieces[0]!;
    const drawn = drawnFor(stroke);

    if (target) {
      const space = layerSpace(target);
      // Every piece, mapped into the layer once. The width goes into the
      // layer's space WITH the geometry — mapping the outline and leaving the
      // ink in frame px is half a conversion, and it is why a stroke drawn at
      // 50px landed on a scaled layer wearing somebody else's width.
      //
      // Identity is minted HERE, so the contours that go into the outline and
      // the ids the ink is written against are the same objects on every
      // branch. The morphing branch used to push raw `Contour`s into a geometry
      // key — no ids at all — so the renderer could not resolve their style and
      // every stroke drawn onto a morphing layer silently inherited the layer's
      // ink. That is the "it drops the line in and makes it like the others"
      // bug, and it only ever happened on layers that morph.
      const written = pieces.map((piece) => {
        const local = contoursToLayer(piece.subpaths, space);
        return {
          local,
          subs: local.map(toSubpath),
          ink: inkFor(piece, strokesToLayer(drawnFor(piece), space)),
        };
      });
      const allSubs = written.flatMap((w) => w.subs);
      store.update("Brush stroke", (d) => {
        const loc = locateClip(d, target.id);
        if (loc?.clip.kind !== "path") return;
        const clip = loc.clip;
        // MERGE: union each piece into the contours it overlaps, in place.
        // `mergeStrokeInto` returns untouched contours by identity, so a merge
        // on a four-hundred-contour drawing costs the strokes it crossed and
        // nothing else — and the merged body keeps the absorbed host's id, so
        // that host's style override, selection and morph correspondence all
        // still resolve.
        //
        // MERGE and CLOSE GAPS are two tools, so they gate independently. With
        // merge off and gaps on, the stroke seals its OWN openings and joins
        // nothing — which is what a person sweeping a not-quite-closed shape
        // means, and what the setting silently refused to do while it was only
        // ever reachable through merge.
        const joins = drawing.scope.merge !== "off";
        const seals = drawing.scope.closeGapPx > 0;
        if ((joins || seals) && animWriteMode(clip, "geometry") !== "keyframe") {
          let any = false;
          for (const w of written) {
            const merged = mergeStrokeInto(clip.subpaths, w.local, () => createId("sub"), {
              closeGapPx: drawing.scope.closeGapPx * space.lengthScale,
              // Nothing on the layer is a candidate to fuse with when merge is
              // off; the stroke's own gaps are still fair game.
              only: joins ? undefined : NO_CONTOURS,
              // Both tolerances are quoted in SCREEN px and converted once, so
              // the same brush settings behave the same on a layer that has
              // been scaled — the merge simplifies by what the eye can see,
              // not by what the layer's local units happen to be.
              simplifyPx: Math.max(MERGE_SIMPLIFY_FLOOR_PX, s.fidelity.simplify) * space.lengthScale,
            });
            if (!merged.merged) continue;
            any = true;
            editPathGeometry(clip, (list) => {
              list.length = 0;
              list.push(...merged.subpaths);
            });
            // The absorbed contours are gone; their overrides would otherwise
            // linger as styles pointing at nothing.
            for (const id of merged.absorbed) {
              if (id !== merged.subpaths[0]?.id) clearContourStyle(clip, id);
            }
          }
          if (any) return;
        }
        if (animWriteMode(clip, "geometry") === "keyframe") {
          // A MORPHING layer: a geometry key is a snapshot by nature, so the
          // whole outline has to be written. Drawing onto a recording vector
          // layer therefore keys it exactly like dragging one of its nodes
          // does, and the frames tween through the morph that already existed
          // rather than through a second, parallel snapshot channel.
          const shown = effectiveValue(clip, "geometry", clip.subpaths, session.playheadMs);
          commitProperty(clip, "geometry", [...copySubpaths(shown), ...allSubs], session.playheadMs);
        } else {
          // The ordinary case: a stroke is an APPEND, so append. Going through
          // `commitProperty` here meant rebuilding the layer's entire outline
          // twice per stroke — once to concatenate, once inside `setPathGeometry`
          // — so the hundredth stroke on a drawing paid for the ninety-nine
          // before it. That quadratic is the lag you feel building up between
          // lines; a push is O(the stroke you just drew) forever.
          //
          // `editPathGeometry` is the seam that makes the push safe: it rebases
          // the pivot across the box change, heals identity and prunes dead
          // styles, none of which the caller has to know.
          editPathGeometry(clip, (list) => list.push(...allSubs.map((c) => ({ ...c }))));
        }
        for (const w of written) {
          for (const c of w.subs) setContourInk(clip, c.id, w.ink);
        }
      });
      // Re-selecting what is already selected wakes every subscriber — the
      // inspector, the layers panel, the timeline — for no change, in the exact
      // frame the next stroke wants the main thread.
      if (session.selectedClipIds.length !== 1 || session.selectedClipIds[0] !== target.id) {
        session.select([target.id]);
      }
      return;
    }

    // A NEW LAYER. Every piece of this gesture goes into it — a stroke cut by a
    // confine is still one stroke as far as the artist is concerned, and
    // scattering its runs across separate layers would make "paint inside"
    // produce five layers from one line.
    const subpaths = pieces.flatMap((piece) => copySubpaths(piece.subpaths));
    const b = subpathBounds(subpaths)!;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    translateSubpaths(subpaths, -cx, -cy);
    const place = paintPlacement(s.frame);
    const clip = createPathClip({
      frameId: s.frame.id,
      subpaths,
      startMs: place.startMs ?? session.playheadMs,
      durationMs: place.durationMs,
      x: Math.round(cx),
      y: Math.round(cy),
      name: "Stroke",
      fill: null,
      // The brush's LINE STACK becomes the layer's stroke stack, so what you
      // drew is an ordinary multi-stroke path you can keep editing — width,
      // colour, dash, trim — with the same controls that authored the brush.
      // The FIRST piece's ink is the layer's; a piece that disagrees (its own
      // pressure profile) overrides only itself, below. No layer-space
      // conversion here: the clip is being born around this outline, so its
      // space IS frame space.
      strokes: inkFor(stroke, drawn).strokes,
    });
    if (pieces.length > 1) {
      let at = 0;
      for (const piece of pieces) {
        const ink = inkFor(piece, drawnFor(piece));
        for (let i = 0; i < piece.subpaths.length; i++) {
          const sub = clip.subpaths[at++];
          if (sub) setContourInk(clip, sub.id, ink);
        }
      }
    }
    // A stroke that could not merge, or was told not to, is a layer of its own
    // — and it lands over or under the artwork it was drawn against, from the
    // same one-word setting the bucket reads.
    const doc2 = store.getState();
    const reference = resolveReference(doc2, s.frame.id, drawing.scope.refs);
    const anchor = referenceAnchorClipId(reference) ?? session.selectedClipIds[0];
    store.update("Brush stroke", (d) => {
      placeClip(d, clip, placeByDepth(anchor, s.depth));
      if (s.confineMask && s.confineMode !== "cut" && s.containment !== "join") {
        containInRegion(
          d,
          clip.id,
          s.confineMask,
          s.frame,
          drawing.scope.featherPx,
          s.confineMode,
          s.confineRefs,
        );
      }
    });
    session.select([clip.id]);
  };

  /**
   * Frame-centre coordinates → this path layer's own geometry space, at the
   * playhead. Core owns the arithmetic (`vector/layer-space.ts`) so the brush,
   * the eraser and the lasso cannot drift apart from each other — and so the
   * one mapping the whole drawing experience rests on is testable without a
   * browser. It carried a displacement bug for exactly as long as it was a
   * closure in this file; the invariant is now pinned by a test.
   */
  const layerSpace = (clip: PathClip) =>
    coreLayerSpace(store.getState(), clip, useSession.getState().playheadMs);


  /**
   * THE way a cutting tool touches vector art, inside a document update:
   * shapes become paths on first touch (same id, so selection holds), the
   * outline it reads is the one ON SCREEN (a morphing layer shows a sampled
   * geometry key, not its resting subpaths), and the write goes through
   * `commitProperty` — which keys `geometry` while Record is armed or the
   * layer already morphs, and bakes to the base otherwise, pivot held.
   *
   * Cutting used to read and overwrite `clip.subpaths` directly, so erasing a
   * recorded outline cut the wrong shape and then flattened the recording.
   */
  const vectorEditSeam = (d: MotionDocument, clipId: string) => {
    let loc = locateClip(d, clipId);
    if (!loc) return null;
    if (loc.clip.kind === "shape") {
      if (!convertShapeClipToPath(d, clipId)) return null;
      loc = locateClip(d, clipId);
    }
    if (!loc || loc.clip.kind !== "path") return null;
    const clip = loc.clip;
    const playheadMs = useSession.getState().playheadMs;
    return {
      clip,
      trackIndex: loc.trackIndex,
      shown: copySubpaths(effectiveValue(clip, "geometry", clip.subpaths, playheadMs)),
      write: (next: Subpath[]) => commitProperty(clip, "geometry", next, playheadMs),
    };
  };

  type VectorSeam = NonNullable<ReturnType<typeof vectorEditSeam>>;

  /**
   * Apply core's verdict. `split` lifts the taken side into its own clip right
   * above the original — same style and transform, so the geometry stays in the
   * shared space and NOTHING moves until the user moves it. Returns the ids the
   * cut produced, for the caller to select.
   */
  const applyVectorCut = (d: MotionDocument, seam: VectorSeam, result: VectorCutResult): string[] => {
    switch (result.kind) {
      case "none":
        return [];
      case "whole":
        return [seam.clip.id];
      case "delete":
        deleteClip(d, seam.clip.id);
        return [];
      case "geometry":
        seam.write(result.subpaths);
        return [seam.clip.id];
      case "split": {
        const piece = reissueClipIds(seam.clip);
        if (piece.kind !== "path") return [seam.clip.id];
        // A piece cut at ONE instant cannot carry the morph it was cut out of:
        // its geometry keys still describe the whole outline and would paint
        // over the piece on the very next frame. The piece is a static outline.
        piece.keyframes = piece.keyframes.filter((t) => t.property !== "geometry");
        // The piece inherits the original's transform, so it also inherits its
        // pivot — which has to be re-based onto the piece's own (smaller) box
        // or the lifted art would jump away from where it was cut.
        setPathGeometry(piece, result.taken);
        piece.name = `${seam.clip.name} piece`;
        const carrier = createTrack();
        carrier.clips.push(piece);
        d.tracks.splice(seam.trackIndex, 0, carrier);
        seam.write(result.subpaths);
        return [piece.id];
      }
    }
  };

  /**
   * CONTAIN — hold a layer inside a region without cutting anything.
   *
   * The whole reason this exists: a cut is permanent. Shade the inside of a
   * shape with the ink trimmed at its edge and you can never afterwards nudge,
   * scale or animate that shading — the cut edges show the moment it moves. A
   * mask clips at RENDER time, so the mark keeps its full geometry and stays
   * inside no matter what happens to it later.
   *
   * Nothing here is new machinery. The region traces into an ordinary path
   * clip, that clip is marked as the stencil, and `applyCompositeMode(…,
   * "mask")` — the same call the Combine menu makes — turns the pair into the
   * app's existing mask group. So it shows up in the layers panel as a real
   * group, the inspector edits it, un-grouping releases it, and every feature
   * that already understands mask groups understands this one for free.
   *
   * The stencil is traced from the REGION rather than being the reference layer
   * itself, and that is deliberate: a mask stencil is consumed by the group and
   * stops being painted, so using the artwork would make the outline you were
   * drawing inside disappear.
   */
  const containInRegion = (
    d: MotionDocument,
    clipId: string,
    mask: RegionMask,
    frame: Frame,
    featherPx: number,
    /** `track` copies the reference layers instead of tracing the region. */
    mode: ConfineMode = "contain",
    refClipIds: readonly string[] = [],
  ): void => {
    // ALREADY IN A MASK GROUP → grow that mask rather than build a second one.
    //
    // A mask group shows its content inside the UNION of its stencils, so
    // adding one is exactly "and this region too". That is what makes shading
    // four separate areas of one drawing produce ONE layer with a four-part
    // mask instead of four layers — and it is non-destructive either way: the
    // stencil is a visible, deletable layer, and no artwork was merged to get
    // there. A fresh layer is for when there is no container to extend.
    const existingGroup = containerGroupOf(d, clipId);

    if (mode === "track") {
      const stencils = trackingStencils(d, clipId, refClipIds, featherPx);
      if (stencils.length > 0) {
        // `placeClip(aboveClipId)` already inherited the host's group, so an
        // extension needs no grouping step at all.
        if (!existingGroup) applyCompositeMode(d, [...stencils, clipId], "mask");
        return;
      }
      // No identifiable reference to follow — fall back rather than silently
      // doing nothing. `track` is an upgrade on `contain`, not a different
      // feature, so the floor is `contain`.
    }
    // Every surviving loop, in order, with NO slice — see `traceRegion`. The
    // area floor is what keeps a photographic region from becoming ten thousand
    // specks, and it drops parents before children so the even-odd reading
    // stays true.
    // The same trace the bucket pours through: corner-preserving, and centred
    // on its own outline. A stencil whose corners were smoothed away is one
    // paint escapes through, exactly where the artwork is sharpest.
    const traced = traceRegionContours(mask, frame, {
      simplify: 1.2,
      fit: 1.4,
      minAreaPx: STENCIL_MIN_AREA_PX,
    });
    if (!traced) return;
    const { subpaths, cx, cy } = traced;
    const host = locateClip(d, clipId)?.clip;
    if (!host) return;
    const stencil = createPathClip({
      frameId: frame.id,
      subpaths,
      startMs: host.startMs,
      durationMs: host.durationMs,
      // NOT rounded. The outline is expressed about this exact point, and a
      // pivot placed half a pixel off it displaces the art by half a pixel —
      // the same mistake as centring on the mask, just smaller.
      x: cx,
      y: cy,
      name: "Inside",
      // A stencil is never painted, so its ink only has to be opaque. White,
      // not the paint colour: a stencil that looked like artwork would read as
      // a layer someone forgot to delete.
      fill: "#ffffff",
      stroke: null,
    });
    stencil.fillRule = "evenodd"; // traced holes stay holes
    // Feather rides on the STENCIL, where it belongs — the app's universal
    // layer feather, so a soft-edged containment is the same soft edge every
    // other mask in the app can have, tuned with the same control afterwards.
    if (featherPx > 0) stencil.feather = featherPx;
    placeClip(d, stencil, { aboveClipId: clipId });
    stencil.isStencil = true;
    if (!existingGroup) applyCompositeMode(d, [stencil.id, clipId], "mask");
  };

  /** The mask group holding this clip, or null. */
  const containerGroupOf = (doc: MotionDocument, clipId: string): string | null => {
    const groupId = groupOfClip(doc, clipId);
    return groupId && groupModeOf(doc, groupId) === "mask" ? groupId : null;
  };

  /**
   * TRACK — copies of the referenced layers, as the mask.
   *
   * A copy rather than the layers themselves, because a mask stencil is
   * CONSUMED by its group: using the artwork would make the outline you were
   * painting inside vanish. `reissueClipIds` deep-copies keyframes and all, so
   * the stencil animates identically to the thing it was copied from — that is
   * the whole feature. Paint inside a typewriter headline and the paint types
   * on with it.
   *
   * Several stencils are fine and correct: a mask group shows its content
   * inside the UNION of its `isStencil` members, so referencing three layers gives
   * a mask of all three, and it keeps working as each of them animates.
   */
  const trackingStencils = (
    d: MotionDocument,
    clipId: string,
    refClipIds: readonly string[],
    featherPx: number,
  ): string[] => {
    const out: string[] = [];
    for (const id of refClipIds) {
      const source = locateClip(d, id)?.clip;
      if (!source || source.kind === "audio" || source.id === clipId) continue;
      const stencil = reissueClipIds(source);
      if (stencil.kind === "audio") continue;
      stencil.name = `${source.name} · mask`;
      stencil.isStencil = true;
      // A stencil is alpha only, so anything that made the ORIGINAL look a
      // particular way is noise here — and a hidden or locked copy would be a
      // mask that does not mask.
      stencil.hidden = false;
      stencil.locked = false;
      if (featherPx > 0) stencil.feather = featherPx;
      placeClip(d, stencil, { aboveClipId: clipId });
      out.push(stencil.id);
    }
    return out;
  };

  /**
   * WHAT A CONFINED STROKE DOES ABOUT ITS CONTAINER — three answers, in order.
   *
   *   `join`    the layer is already contained AND its mask covers where you
   *             just started. Nothing to build; the stroke goes in.
   *   `extend`  the layer is contained but its mask does NOT reach here — you
   *             have moved to a different region. Add a stencil to the SAME
   *             group. A mask group shows its content inside the union of its
   *             stencils, so this is literally "and this region too", and it is
   *             what makes shading four areas of one drawing produce one layer
   *             with a four-part mask instead of four layers.
   *   `fresh`   there is no container to extend. A new layer, clipped — which
   *             is what a clipping mask means in Procreate and Photoshop, and
   *             what stops a contain from clipping artwork that was already on
   *             the layer.
   *
   * The bug this replaced: `extend` and `fresh` were both read as "already
   * contained, carry on", so a second stroke started inside a DIFFERENT shape
   * landed in the first container, where that container's own stencil clipped
   * it away completely. The mark simply vanished, with nothing on screen to say
   * why. Being inside SOME mask group was never the question — whether the mask
   * reaches the point you are painting at is.
   */
  const resolveContainment = (
    s: { confineMask: RegionMask | null; confineMode: ConfineMode },
    targetId: string | null,
    /** Where the gesture started, frame-centre coords. */
    seed: { x: number; y: number },
    frame: Frame,
  ): Containment => {
    if (!s.confineMask || s.confineMode === "cut") return "join";
    if (!targetId) return "fresh";
    const doc = store.getState();
    const groupId = containerGroupOf(doc, targetId);
    if (!groupId) return "fresh";
    const stencils = clipsInGroup(doc, groupId).filter((id) => {
      const c = locateClip(doc, id)?.clip;
      return !!c && c.kind !== "audio" && c.isStencil;
    });
    return stencilCoversPoint(doc, frame, useSession.getState().playheadMs, stencils, seed)
      ? "join"
      : "extend";
  };

  /** The path layer a vector stroke joins, or null for "make a new one". */
  const vectorTarget = (frame: Frame): PathClip | null => {
    const doc = store.getState();
    for (const id of useSession.getState().selectedClipIds) {
      const loc = locateClip(doc, id);
      if (!loc || loc.clip.frameId !== frame.id || isClipLocked(loc.track, loc.clip)) continue;
      const decision = resolvePaintTarget({ id: loc.clip.id, kind: loc.clip.kind }, "vector");
      if (decision.kind === "edit" && loc.clip.kind === "path") return loc.clip;
    }
    return null;
  };

  const commitEraseStroke = (s: ActiveStroke): void => {
    const drawing = useDrawing.getState();
    // Raster journals first (pixels already erased live).
    const commits: Array<{ id: string; rev: number; plan: DrawPlan; tx: StrokeTx }> = [];
    for (const t of s.eraseTargets) {
      const nextRev = t.clip.rev + 1;
      if (commitStroke(t.tx, nextRev)) commits.push({ id: t.clip.id, rev: nextRev, plan: t.plan, tx: t.tx });
    }
    // The vector layers were resolved when the stroke began, by the same rule
    // that picked the pixel layers — one gesture, one scope, both media.
    const vectorIds = s.trail.length > 0 ? s.vectorTargets : [];
    if (commits.length === 0 && vectorIds.length === 0) return;

    store.update("Erase", (d) => {
      for (const c of commits) commitDrawSurface(d, c.id, c.plan, c.rev, c.tx);
      for (const v of vectorIds) {
        // A target in another comp gets the trail in ITS coordinates; the radius
        // rides the same chain, so an eraser is the size it looks inside a
        // scaled comp rather than the size it was in the one you stood in.
        const trail = v.from
          ? s.trail.map((p) => ({ ...v.from!.at(p), radius: p.radius * v.from!.lengthScale }))
          : s.trail;
        eraseVectorClip(d, v.clipId, trail, drawing.eraser.vectorMode, s.fidelity);
      }
    });
    touchSurfaces();
  };

  /**
   * Erase one path/shape clip under the trail. The MODE decides the meaning
   * (cut the line, dissolve the nodes, take the whole path) and core decides
   * the geometry — this only moves the trail into the layer's space and writes
   * the verdict back.
   */
  const eraseVectorClip = (
    d: MotionDocument,
    clipId: string,
    trail: Array<{ x: number; y: number; radius: number }>,
    mode: VectorEraseMode,
    fidelity: PathFidelity,
  ): void => {
    const seam = vectorEditSeam(d, clipId);
    if (!seam) return;
    const space = layerSpace(seam.clip);
    const localTrail: EraserPath = {
      points: trail.map((p) => ({ ...space.at(p.x, p.y), radius: p.radius * space.lengthScale })),
    };
    applyVectorCut(
      d,
      seam,
      eraseVectorSubpaths(seam.shown, localTrail, {
        mode,
        filled: seam.clip.fills.length > 0,
        // The layer's own space: a scaled layer's px are not the stage's, and
        // an accuracy in px only means something once it is in the same space.
        fidelity: { ...fidelity, simplify: fidelity.simplify * space.lengthScale },
      }),
    );
  };

  // ── Paint bucket ───────────────────────────────────────────────────────────

  /**
   * THE BUCKET, and the one decision it still makes for itself.
   *
   * Every region question — where the pixels come from, how wide a gap still
   * holds paint, how far the fill spreads, how soft its edge, whether it lands
   * over or under — is the shared paint scope (`paint-region.ts`), the same
   * value a confined brush stroke reads. What is left here is genuinely the
   * bucket's own: which MEDIUM the fill is made of.
   *
   * That has three answers, tried in order, because they are three different
   * truths about what you clicked on:
   *
   *   1. a closed contour of a real vector layer → set that shape's FILL.
   *      Resolution-free, animates and morphs with the artwork, follows a
   *      colour variable. It IS the shape's fill, not a copy lying on top.
   *   2. an enclosure made by several overlapping outlines → TRACE it into a
   *      new filled path. The case tracing was invented for, and the only one
   *      it is still right for.
   *   3. pixels → flood the pixels.
   */
  const applyFill = (e: React.PointerEvent): void => {
    const ctx = paintCtxOrCreate();
    if (!ctx) {
      toast("No frame under the playhead — add one in the sheet");
      return;
    }
    const frame = ctx.frame;
    const doc = store.getState();
    const session = useSession.getState();
    const scope = useDrawing.getState().scope;
    const p = paintLocal(localPoint(e), ctx);

    // 1. An exact vector region under the cursor wins outright.
    if (fillVectorRegion(frame, p)) return;

    // 2/3. What the reference is MADE of decides the rest. A selected pixel
    // layer still overrides it: you asked to paint on that layer.
    const reference = resolveReference(doc, frame.id, scope.refs);
    const selected = session.selectedClipIds
      .map((id) => locateClip(doc, id)?.clip)
      .filter((c): c is Clip => !!c && c.frameId === frame.id);
    const selectedVector = selected.find((c) => c.kind === "path" || c.kind === "shape");
    const selectedRaster = selected.find((c): c is RasterClip => c.kind === "raster");
    const anyRaster = rasterLayers(doc, frame.id)[0] ?? null;

    if (!selectedVector && (selectedRaster || (anyRaster && !reference.vector))) {
      fillRaster(frame, p, selectedRaster ?? anyRaster!);
    } else {
      fillVector(frame, p);
    }
  };

  /**
   * The region a scope resolves to under a point, or null.
   *
   * ONE call for the bucket, for a confined stroke and for the hover preview,
   * so the outline you see before you press is computed by the code that
   * commits. Inversion for "paint outside" happens inside, rather than at three
   * call sites that would each have to remember.
   */
  const scopeRegion = (
    frame: Frame,
    p: { x: number; y: number },
    opts: { invert?: boolean; global?: boolean; medium: PaintToolCategory },
  ): RegionMask | null => resolveScopeRegion(frame, p, opts).mask;

  /**
   * …and the whole answer, reference included, for the one caller that has to
   * know WHAT bounded it (a tracked containment copies those layers).
   *
   * ## Your own marks do not confine you — unless they are all you have
   *
   * The layer a stroke joins is kept out of the reference, because otherwise
   * each mark you make narrows the region the next one gets: paint inside a
   * shape twice and the second stroke stops at the first. That rule is right,
   * and on its own it broke the commonest case in the tool — drawing a circle
   * and painting inside THAT circle, on the same layer. With the outline
   * excluded there was nothing to be inside of, so the flood ran to the edge of
   * the frame and the gesture was refused as "that area isn't closed".
   *
   * Both readings are correct; they just are not the same question. So the
   * exclusion is an OPENING BID: resolve without your own layer, and if that
   * finds no enclosure at all, resolve again with it. You are never bounded by
   * your own paint while a real boundary exists, and the outline you just drew
   * still works as one when it is the only boundary there is.
   *
   * The retry costs a second rasterize once; `referenceRaster` is keyed on the
   * exclusion, so the hover that follows is a cache hit either way.
   */
  const resolveScopeRegion = (
    frame: Frame,
    p: { x: number; y: number },
    opts: { invert?: boolean; global?: boolean; medium: PaintToolCategory },
  ): ReturnType<typeof regionAt> => {
    const doc = store.getState();
    const timeMs = useSession.getState().playheadMs;
    const scope = useDrawing.getState().scope;
    const exclude = selfPaintedClip(opts.medium);
    const first = regionAt(doc, frame, timeMs, scope, p, { ...opts, exclude });
    if (exclude.length === 0) return first;
    // An INVERTED region is the complement, so reaching every edge is what it is
    // supposed to do; only emptiness counts as failure there.
    const empty = !first.mask || first.mask.bounds.x1 < first.mask.bounds.x0;
    const open = empty || (!opts.invert && regionEscaped(first.mask!));
    if (!open) return first;
    return regionAt(doc, frame, timeMs, scope, p, { ...opts, exclude: [] });
  };

  /**
   * The layer this gesture would paint INTO, when that is a layer whose own
   * marks are about to join the ones already there.
   *
   * Asked through the headless paint-target table, so it cannot disagree with
   * where the stroke actually lands. `surface: "own"` is the whole test: it
   * means the mark joins that clip's own pixels or geometry, which is exactly
   * when the clip must not also be the boundary confining it. `surface:
   * "overlay"` is the opposite case and must NOT be excluded — selecting a
   * vector outline and painting it with the pixel brush puts the paint on a
   * new overlay, and the outline is precisely the reference you meant.
   */
  const selfPaintedClip = (medium: PaintToolCategory): string[] => {
    const doc = store.getState();
    for (const id of useSession.getState().selectedClipIds) {
      const loc = locateClip(doc, id);
      if (!loc || isClipLocked(loc.track, loc.clip)) continue;
      const decision = resolvePaintTarget({ id: loc.clip.id, kind: loc.clip.kind }, medium);
      if (decision.kind === "edit" && decision.surface === "own") return [decision.clipId];
    }
    return [];
  };

  /**
   * Every contour in the picture, expressed in ONE layer's geometry space.
   *
   * The subdivision test is a question about the whole drawing, not about one
   * layer: a line drawn across a shape cuts its face whether or not the two are
   * the same layer. Both directions of the layer map already exist
   * (`LayerSpace.toFrame` / `.at`), so crossing between them is composing the
   * pair — no geometry of its own here.
   */
  const pictureInSpace = (
    doc: MotionDocument,
    reference: ResolvedReference,
    host: PathClip,
    hostSpace: LayerSpace,
    playheadMs: number,
  ): Contour[] => {
    const out: Contour[] = [];
    for (const id of reference.clipIds) {
      const clip = locateClip(doc, id)?.clip;
      if (clip?.kind !== "path") continue;
      const shown = effectiveValue(clip, "geometry", clip.subpaths, playheadMs);
      if (clip.id === host.id) {
        // The host's own contours go in BY REFERENCE: `separateRegions` hands
        // back the very objects it was given, so identity is what lets the
        // region drop its own outline and holes out of the test.
        out.push(...shown);
        continue;
      }
      const theirs = coreLayerSpace(doc, clip, playheadMs);
      for (const c of shown) {
        out.push({
          ...c,
          points: c.points.map((pt) => {
            const f = theirs.toFrame(pt.x, pt.y);
            const q = hostSpace.at(f.x, f.y);
            // Handles are dropped on purpose: this geometry is only ever
            // SAMPLED for containment, and mapping tangents correctly is real
            // work for an answer no containment test can tell apart.
            return { ...pt, x: q.x, y: q.y, hIn: null, hOut: null };
          }),
        });
      }
    }
    return out;
  };

  /**
   * Fill a real vector shape's own region. Returns true when it handled the
   * click.
   *
   * Only REFERENCED artwork is considered (which, with no reference set, is
   * everything visible) — the same rule the raster flood obeys, so narrowing
   * the reference narrows both halves of the tool identically.
   *
   * ## Why this may decline a region it found
   *
   * This is the bucket's fast, exact path: clicking a petal recolours that
   * petal's OWN fill, so the artwork stays editable, keyframable and one layer
   * — never a traced copy stacked on top. It is the right answer whenever it is
   * true, and it is what makes recolouring a drawing feel like Illustrator.
   *
   * But it answers a different question from the outline the person is looking
   * at. The hover preview floods PIXELS and highlights the face of the whole
   * picture under the cursor; this walks ONE path's fill regions. Draw a hexagon
   * with three lines across it and the preview finds the small triangle you
   * clicked while this finds the hexagon — so the click repainted the entire
   * drawing, and the preview had promised otherwise.
   *
   * `regionIsSubdivided` is the gate that keeps the two honest: take the exact
   * shortcut only where nothing crosses the region, which is exactly when both
   * questions have the same answer. Otherwise fall through, and the pour lands
   * as the traced face the preview drew.
   */
  const fillVectorRegion = (frame: Frame, p: { x: number; y: number }): boolean => {
    const doc = store.getState();
    const drawing = useDrawing.getState();
    const playheadMs = useSession.getState().playheadMs;
    const reference = resolveReference(doc, frame.id, drawing.scope.refs);
    // Topmost first: what you clicked is what is on top, exactly as it looks.
    for (let i = reference.clipIds.length - 1; i >= 0; i--) {
      const clip = locateClip(doc, reference.clipIds[i]!)?.clip;
      if (clip?.kind !== "path") continue;
      const space = coreLayerSpace(doc, clip, playheadMs);
      const local = space.at(p.x, p.y);
      const shown = effectiveValue(clip, "geometry", clip.subpaths, playheadMs);
      const region = regionAtPoint(shown, local.x, local.y, clip.fillRule);
      if (!region) continue;
      if (regionIsSubdivided(region, pictureInSpace(doc, reference, clip, space, playheadMs))) return false;
      const contourId = region.contours[0]!.id;
      const paint = solidPaint(drawing.fill.color);
      store.update("Fill shape", (d) => {
        const target = locateClip(d, clip.id)?.clip;
        if (target?.kind === "path") pourFill(target, contourId, paint);
      });
      useSession.getState().select([clip.id]);
      return true;
    }
    return false;
  };

  const fillRaster = (frame: Frame, p: { x: number; y: number }, target: RasterClip): void => {
    const drawing = useDrawing.getState();
    const t = makeRasterTarget(target);
    // Paint the surface this stroke actually targets (a capture frame's snapshot
    // for a recorded layer, seeded from the left keyframe; else the layer's own).
    const surface = surfaceForClip(t.clip);
    const mask = scopeRegion(frame, p, {
      global: drawing.fill.global,
      medium: "raster",
    });
    if (!mask || mask.bounds.x1 < mask.bounds.x0) {
      toast("Nothing to fill here");
      return;
    }

    // The region is FRAME pixels — it was read from the reference, which is the
    // picture, not this layer's bitmap — so it enters the surface through the
    // layer's own inverse pose, exactly like a frame-space stroke does.
    const paint = fillCanvas(mask, inkColor(drawing.fill.color), drawing.scope.featherPx);
    // A POUR GROWS THE LAYER, exactly as a stroke does.
    //
    // The region is measured in the FRAME, so on a layer that has been moved or
    // scaled most of it lands outside the layer's own box — and a surface is a
    // fixed canvas, so that part was simply destroyed. Filling a nudged layer
    // stopped at its old edges instead of covering what you poured into, which
    // reads as the fill being cropped by an invisible rectangle. The bounds are
    // the region's four corners carried into surface pixels, so the layer gains
    // exactly the room the pour needs.
    paintIntoRaster(t.tx, frameBoxInSurface(t, frame, mask.bounds), (ctx, off) => {
      ctx.globalCompositeOperation =
        drawing.scope.depth === "under" ? "destination-over" : "source-over";
      drawFrameCanvasIntoSurface(ctx, paint, t, frame, off);
    });
    const nextRev = t.clip.rev + 1;
    if (commitStroke(t.tx, nextRev)) {
      store.update("Paint bucket", (d) => commitDrawSurface(d, t.clip.id, t.plan, nextRev, t.tx));
      invalidateReferenceRaster();
      touchSurfaces();
    }
  };

  /**
   * Draw a FRAME-sized canvas into a layer's surface through the layer's own
   * inverse pose.
   *
   * Written once because three things need it — the bucket's paint, a confined
   * stroke's stencil and the eraser's — and the version that existed was inline
   * in the bucket and wrong for a layer with a moved pivot: it rotated about
   * x/y instead of going through the layer map, so filling a repositioned layer
   * landed somewhere else entirely. The fit is affine, from three mapped
   * corners, so pivot, shear and non-uniform scale all come along.
   */
  const drawFrameCanvasIntoSurface = (
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    t: RasterTarget,
    frame: Frame,
    /** Where the surface's origin moved to, if the layer grew for this write. */
    offset: { x: number; y: number } = ORIGIN,
  ): void => {
    const hw = frame.width / 2;
    const hh = frame.height / 2;
    const o = toSurface(t, { x: -hw, y: -hh });
    const ax = toSurface(t, { x: hw, y: -hh });
    const ay = toSurface(t, { x: -hw, y: hh });
    ctx.setTransform(
      (ax.x - o.x) / frame.width,
      (ax.y - o.y) / frame.width,
      (ay.x - o.x) / frame.height,
      (ay.y - o.y) / frame.height,
      o.x + offset.x,
      o.y + offset.y,
    );
    ctx.drawImage(canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  /**
   * A box of FRAME pixels as a box of this layer's surface pixels.
   *
   * All four corners, then their extent — not two, because the layer's map can
   * rotate and shear, and the axis-aligned box of a rotated rectangle is not
   * the box of its two opposite corners. This is what tells a write how much
   * room it needs before it lands.
   */
  const frameBoxInSurface = (
    t: RasterTarget,
    frame: Frame,
    box: { x0: number; y0: number; x1: number; y1: number },
  ): PixelBounds => {
    const hw = frame.width / 2;
    const hh = frame.height / 2;
    // `x1`/`y1` name the last pixel IN the region; a bounds box is exclusive.
    const xs = [box.x0 - hw, box.x1 + 1 - hw];
    const ys = [box.y0 - hh, box.y1 + 1 - hh];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const x of xs) {
      for (const y of ys) {
        const q = toSurface(t, { x, y });
        x0 = Math.min(x0, q.x);
        y0 = Math.min(y0, q.y);
        x1 = Math.max(x1, q.x);
        y1 = Math.max(y1, q.y);
      }
    }
    return { x0, y0, x1, y1 };
  };

  /**
   * The traced outline of a region, ready to become a layer.
   *
   * The geometry lives in core (`traceRegionContours`) — it is pure, it is
   * where the two bugs that survived two rewrites were hiding, and it is now
   * testable without a browser. This is only the bucket's tolerances.
   */
  const traceFillGeometry = (mask: RegionMask, frame: Frame) =>
    traceRegionContours(mask, frame, { simplify: 1.4, fit: 2.2, minAreaPx: STENCIL_MIN_AREA_PX });

  /**
   * The fill layer this pour joins, or null for "make a new one".
   *
   * The same rule the vector BRUSH follows (`vectorTarget`), and for the same
   * reason: a selected path layer is where your next mark goes. Without it the
   * bucket spawned a layer per pour, so filling six areas of one drawing made
   * six layers — and, worse, Record could never key anything, because there was
   * never a second pour into the same layer to key.
   *
   * ## …unless that layer is what BOUNDED the region
   *
   * A pour is a FACE of the arrangement of strokes on the canvas — the triangle
   * between three lines that cross. It is not a contour of any one path, and
   * the path it was traced from usually has no contour of that shape at all.
   *
   * So appending it to the outline it was measured from is not "filling that
   * area", it is editing the artwork: the traced face becomes another subpath
   * of a compound path, re-read under that layer's own fill rule and painted
   * with that layer's own fill. Clicking inside a pen drawing filled the whole
   * drawing — the region was correct, the preview was correct, and the write
   * landed in the one place that changed the answer.
   *
   * This is the bucket's half of a rule the stroke reference already states
   * (`referenceRaster`): your own marks must not confine you — and the boundary
   * that confined you is not yours to write into. The pour becomes its own
   * layer instead, which is what `regions.ts` says a piece of artwork with its
   * own colour IS.
   *
   * `boundedBy` is `regionAt`'s `drawn` — the layers that actually went into
   * the picture, exclusion already applied — not the layers the scope names. A
   * fill layer is the one kept OUT of that picture, so pour after pour still
   * accumulates in one layer and Record still has something to key.
   */
  const fillTarget = (frame: Frame, boundedBy: readonly string[]): PathClip | null => {
    const doc = store.getState();
    const boundary = new Set(boundedBy);
    for (const id of useSession.getState().selectedClipIds) {
      if (boundary.has(id)) continue;
      const loc = locateClip(doc, id);
      if (!loc || loc.clip.frameId !== frame.id || isClipLocked(loc.track, loc.clip)) continue;
      if (loc.clip.kind === "path") return loc.clip;
    }
    return null;
  };

  const fillVector = (frame: Frame, p: { x: number; y: number }): void => {
    const drawing = useDrawing.getState();
    const session = useSession.getState();
    const doc = store.getState();
    // The region AND what bounded it, from the one resolver: a pour must not be
    // confined by the fill layer it is joining (the second pour into a shape
    // would stop at the first), and it must not be WRITTEN INTO whatever did
    // confine it (see `fillTarget`).
    const { mask, reference, drawn } = resolveScopeRegion(frame, p, {
      global: drawing.fill.global,
      medium: "vector",
    });
    if (!mask) return;
    const traced = traceFillGeometry(mask, frame);
    if (!traced) {
      toast("Nothing to fill here");
      return;
    }
    const { subpaths, cx, cy } = traced;

    // ── POUR INTO THE SELECTED FILL LAYER ────────────────────────────────────
    //
    // A pour is geometry, exactly like a brush stroke, so it goes through the
    // same seam: `commitProperty` writes a geometry KEYFRAME while Record is
    // armed (or the layer already morphs) and bakes to the base otherwise. That
    // one line is the whole of "fill several frames of the same clip and get
    // snapshots" — the machinery was already there, and the bucket was the only
    // geometry tool not using it.
    //
    // `capture.seed` means here what it means for the brush: CONTINUE adds this
    // pour to what the layer already shows, BLANK makes this pour the frame.
    const target = fillTarget(frame, drawn);
    if (target) {
      const space = coreLayerSpace(doc, target, session.playheadMs);
      const local = contoursToLayer(
        subpaths.map((c) => ({
          ...c,
          points: c.points.map((pt) => ({
            ...pt,
            x: pt.x + cx,
            y: pt.y + cy,
            hIn: pt.hIn ? { x: pt.hIn.x + cx, y: pt.hIn.y + cy } : pt.hIn,
            hOut: pt.hOut ? { x: pt.hOut.x + cx, y: pt.hOut.y + cy } : pt.hOut,
          })),
        })),
        space,
      );
      const subs = local.map(toSubpath);
      const paint = solidPaint(drawing.fill.color);
      store.update("Paint bucket", (d) => {
        const loc = locateClip(d, target.id);
        if (loc?.clip.kind !== "path") return;
        const clip = loc.clip;
        const keying = animWriteMode(clip, "geometry") === "keyframe";
        const blank = useDrawing.getState().capture.seed === "blank";
        // Read BEFORE the geometry write. "Is this the first pour into an empty
        // layer" is a fact about the layer we found, and the three writes below
        // change `subpaths` in three different ways — under Record it does not
        // change at all, because the outline goes to a keyframe. Deriving it
        // afterwards from a length comparison was a fact about whichever branch
        // happened to run.
        const wasEmpty = clip.subpaths.length === 0;
        if (keying) {
          // A SNAPSHOT. A geometry key is a whole outline by nature, so a
          // continued pour writes what is shown plus this one, and a blank one
          // writes only this — the same two meanings the brush's frame options
          // already carry, on the same setting.
          const shown = effectiveValue(clip, "geometry", clip.subpaths, session.playheadMs);
          const next = blank ? subs : [...copySubpaths(shown), ...subs];
          commitProperty(clip, "geometry", next, session.playheadMs);
        } else if (blank) {
          setPathGeometry(clip, subs);
        } else {
          editPathGeometry(clip, (list) => list.push(...subs.map((c) => ({ ...c }))));
        }
        // An empty layer has nothing to inherit FROM, so the colour belongs on
        // the layer. Once it holds artwork, only this pour takes the colour —
        // as a contour override, which the renderer paints as its own run with
        // its own fill rule, so a pour can never re-read somebody else's
        // outline as a hole in itself.
        if (wasEmpty) {
          clip.fills = [paint];
          clip.fillRule = "evenodd";
        } else {
          for (const c of subs) setContourInk(clip, c.id, { strokes: [], fills: [paint] });
        }
      });
      if (session.selectedClipIds.length !== 1 || session.selectedClipIds[0] !== target.id) {
        session.select([target.id]);
      }
      return;
    }

    // ── A NEW FILL LAYER ─────────────────────────────────────────────────────
    // A fill made INSIDE somebody's outline lasts exactly as long as that
    // outline — the whole reason a reference carries timing. The reference is
    // the one the REGION came from, not a fresh resolve: when the flood fell
    // back to being bounded by your own selected layer, that layer is the
    // outline this fill belongs to, and it is what the fill stacks against.
    const timing = referenceTiming(reference, drawing.scope.refs);
    const clip = createPathClip({
      frameId: frame.id,
      subpaths,
      startMs: timing?.startMs ?? session.playheadMs,
      durationMs: timing?.durationMs ?? 5000,
      // Unrounded, for the reason the stencil states: the geometry is
      // expressed about this point.
      x: cx,
      y: cy,
      name: "Fill",
      // The armed colour, token and all: a fill bound to a colour variable
      // stores the token and retints with it forever.
      fill: drawing.fill.color,
      stroke: null,
    });
    clip.fillRule = "evenodd"; // holes traced as inner loops stay holes
    const anchor = referenceAnchorClipId(reference) ?? session.selectedClipIds[0];
    store.update("Paint bucket", (d) => {
      placeClip(d, clip, placeByDepth(anchor, drawing.scope.depth));
    });
    invalidateReferenceRaster();
    session.select([clip.id]);
  };

  /**
   * The clip a new layer is stacked against — the BOTTOM of the reference going
   * under, the TOP going over. Anchoring to whatever happened to be selected
   * made "paint under" mean "under one arbitrary layer", which is why filling
   * behind line art used to land on top of half of it.
   */
  const referenceAnchorClipId = (reference: { clipIds: string[] }): string | undefined => {
    if (reference.clipIds.length === 0) return undefined;
    // `clipIds` is topmost-first (see `resolveReference`).
    return useDrawing.getState().scope.depth === "under"
      ? reference.clipIds[reference.clipIds.length - 1]
      : reference.clipIds[0];
  };

  // ── Lasso / wand regions ───────────────────────────────────────────────────

  /**
   * What a region tool (lasso / wand) acts on — resolved through the SAME
   * headless `resolvePaintTarget` table as the brush, so selection behaviour is
   * one rule across every drawing tool (no per-kind branching here):
   *  - `raster`   → a pixel layer's own surface: select, move, cut, delete IN
   *                 place (mutable pixels).
   *  - `rendered` → an image / video / vector clip: its media is immutable, so a
   *                 region LIFTS the selected rendered pixels into a new raster
   *                 layer (non-destructive) and hands off to the transform gizmo.
   * Never auto-creates a blank layer — a region needs pixels to select.
   */
  type RegionTarget =
    | { mode: "raster"; clip: RasterClip; frame: Frame }
    | { mode: "rendered"; clip: Clip; frame: Frame };

  const regionTarget = (ctx: PaintCtxState): RegionTarget | null => {
    const frame = ctx.frame;
    const doc = store.getState();
    const session = useSession.getState();
    for (const id of session.selectedClipIds) {
      const loc = locateClip(doc, id);
      if (!loc || loc.clip.frameId !== frame.id || isClipLocked(loc.track, loc.clip)) continue;
      const decision = resolvePaintTarget({ id: loc.clip.id, kind: loc.clip.kind }, "raster");
      if (decision.kind === "edit" && decision.surface === "own" && loc.clip.kind === "raster") {
        return { mode: "raster", clip: loc.clip, frame };
      }
      // Only rasterizable MEDIA (image/video) becomes a pixel region; a selected
      // shape/path is cut as EDITABLE vectors by the lasso downstream instead, so
      // it's skipped here rather than flattened to pixels.
      if (decision.kind === "edit" && decision.surface === "overlay") {
        if (loc.clip.kind === "image" || loc.clip.kind === "video") {
          return { mode: "rendered", clip: loc.clip, frame };
        }
        continue;
      }
    }
    // Nothing paintable selected → the topmost layer in range, by the SAME
    // table every other tool falls back through. If that layer is vector art the
    // region cuts IT and stops: reaching past a drawing into whatever pixels
    // happen to sit underneath is how a lasso ends up editing the wrong layer.
    const top = resolveStrokeTargets(
      doc,
      frame.id,
      [],
      "current",
      frame.id === session.activeFrameId ? session.playheadMs : null,
    )[0];
    if (!top || top.medium !== "raster") return null;
    const clip = locateClip(doc, top.clipId)?.clip;
    return clip?.kind === "raster" ? { mode: "raster", clip, frame } : null;
  };

  /**
   * Render ONE clip's current pixels into a frame-space canvas (no background),
   * reusing the export contract's `only` scope. This is the pixel source that
   * lets a region tool reach an image / video / vector layer.
   */
  const renderClipPixels = (frame: Frame, clipId: string): CanvasRenderingContext2D => {
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    drawFrameContent(ctx, store.getState(), frame, useSession.getState().playheadMs, {
      transparent: true,
      only: new Set([clipId]),
    });
    return ctx;
  };

  const maskAlphaCanvas = (mask: RegionMask): HTMLCanvasElement => {
    const canvas = document.createElement("canvas");
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(mask.width, mask.height);
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i] === 1) img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  };

  const rasterClipById = (id: string): RasterClip | null => {
    const loc = locateClip(store.getState(), id);
    return loc?.clip.kind === "raster" ? loc.clip : null;
  };

  /** The 2D context holding a region's source pixels — a rendered snapshot for
   *  an immutable image/video, or the raster layer's live surface. */
  const regionSourceCtx = (r: RegionState): CanvasRenderingContext2D | null => {
    if (r.rendered) return r.rendered.getContext("2d");
    const clip = rasterClipById(r.sourceClipId);
    return clip ? surfaceForClip(clip).ctx : null;
  };

  /** Tight bounding box of the non-transparent pixels — the "auto size" that
   *  trims a lifted layer to the real image area, not the loose lasso box. */
  const alphaBounds = (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
  ): { x0: number; y0: number; x1: number; y1: number } | null => {
    const data = ctx.getImageData(0, 0, w, h).data;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] !== 0) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    }
    return x1 < x0 ? null : { x0, y0, x1, y1 };
  };

  /** Open a live marching-ants selection over any layer — a raster surface (cut/
   *  delete land in place) or a rendered image/video (immutable, copy-only). */
  const activateRegion = (ctx: PaintCtxState, target: RegionTarget, mask: RegionMask): void => {
    if (mask.bounds.x1 < mask.bounds.x0) {
      toast("Nothing selected");
      return;
    }
    const base = {
      frame: ctx.frame,
      space: ctx,
      sourceClipId: target.clip.id,
      mask,
      loops: traceRegion(mask, 1.2),
    };
    regionRef.current =
      target.mode === "raster"
        ? {
            ...base,
            mutable: true,
            width: target.clip.width,
            height: target.clip.height,
            pose: rasterPose(target.clip),
            rendered: null,
          }
        : {
            ...base,
            mutable: false,
            width: ctx.frame.width,
            height: ctx.frame.height,
            pose: FRAME_POSE,
            rendered: renderClipPixels(ctx.frame, target.clip.id).canvas,
          };
    useSession.getState().select([target.clip.id]);
    setRegionActive(true);
    dirtyRef.current = true;
  };

  /**
   * THE selection seam every lasso sub-tool + the wand funnel into: a freshly
   * drawn mask either COMBINES with the live selection (add/subtract/intersect,
   * when it's the same layer + space) or opens a new one. So the whole "modify
   * selection" vocabulary lives here once, not per tool.
   */
  const applySelection = (ctx: PaintCtxState, target: RegionTarget, mask: RegionMask): void => {
    const combine = useDrawing.getState().lasso.combine;
    const live = regionRef.current;
    if (
      combine !== "new" &&
      live &&
      live.sourceClipId === target.clip.id &&
      live.mask.width === mask.width &&
      live.mask.height === mask.height
    ) {
      const merged = combineMasks(live.mask, mask, combine);
      if (merged.bounds.x1 < merged.bounds.x0) {
        clearRegion(); // subtracted/intersected to nothing → deselect
        return;
      }
      live.mask = merged;
      live.loops = traceRegion(merged, 1.2);
      setRegionActive(true);
      dirtyRef.current = true;
      return;
    }
    activateRegion(ctx, target, mask);
  };

  const clearRegion = (): void => {
    regionRef.current = null;
    setRegionActive(false);
    dirtyRef.current = true;
  };

  /** Drop the marching-ants selection (nothing is mutated until an explicit
   *  lift/cut, so there's nothing to restore). */
  const cancelRegion = (): void => {
    if (regionRef.current) clearRegion();
  };

  /**
   * Make the region's source EDITABLE in place. A raster layer already is; an
   * image/video is baked into a real pixel layer that REPLACES it in the same
   * track slot (same clip id, group, links) — its rendered pixels become the
   * layer's surface, so a lasso edit rewrites the media itself, exactly like a
   * brush pixel layer. This is what makes the lasso a real in-place tool on
   * images, not a duplicator. Returns false only if the source vanished.
   */
  const ensureRegionMutable = (r: RegionState): boolean => {
    if (r.mutable) return true;
    const frame = r.frame;
    const loc = locateClip(store.getState(), r.sourceClipId);
    if (!loc) {
      clearRegion();
      return false;
    }
    const old = loc.clip;
    const baked = renderClipPixels(frame, r.sourceClipId).canvas; // frame-space
    const raster = createRasterClip({
      frameId: old.frameId,
      width: frame.width,
      height: frame.height,
      startMs: old.startMs,
      durationMs: old.durationMs,
      name: old.name,
    });
    // Keep the SAME layer identity so selection/links survive the swap — and
    // the same slot, so the group (a fact of the row) does too.
    // The source is always a visual clip (image/video), so these fields exist.
    const v = old as Partial<Pick<RasterClip, "linkGroupId" | "opacity" | "blendMode" | "fillDuration">>;
    raster.id = old.id;
    raster.linkGroupId = v.linkGroupId ?? null;
    raster.locked = old.locked;
    raster.hidden = old.hidden;
    raster.opacity = v.opacity ?? 1;
    raster.blendMode = v.blendMode ?? "normal";
    raster.fillDuration = v.fillDuration ?? false;
    writeSurface(raster.surfaceId, frame.width, frame.height, (c) => c.drawImage(baked, 0, 0));
    store.update("Convert image to pixels", (d) => {
      const l = locateClip(d, r.sourceClipId);
      if (!l) return;
      const idx = l.track.clips.findIndex((c) => c.id === r.sourceClipId);
      if (idx >= 0) l.track.clips[idx] = raster;
    });
    // Retarget the region onto the new frame-space surface (identity pose).
    r.mutable = true;
    r.rendered = null;
    r.pose = FRAME_POSE;
    r.width = frame.width;
    r.height = frame.height;
    touchSurfaces();
    return true;
  };


  /**
   * THE region primitive: lift the selection into its OWN new raster layer,
   * auto-sized to the real (non-transparent) pixels, then hand off to the shared
   * on-stage transform gizmo (move/scale/rotate/snap) with zero new transform
   * code. `cut` also erases the region from the source (journaled) — an image is
   * rasterized in place first so the cut truly removes it. Copy/Duplicate leave
   * the source untouched. Returns the new clip's id (null if nothing to lift).
   */
  const liftRegionToLayer = (r: RegionState, cut: boolean): string | null => {
    if (cut && !ensureRegionMutable(r)) return null;
    const srcCtx = regionSourceCtx(r);
    if (!srcCtx) {
      clearRegion();
      return null;
    }
    const maskCanvas = maskAlphaCanvas(r.mask);
    // Full-size float = source ∩ mask, in the region's pixel space.
    const float = document.createElement("canvas");
    float.width = r.width;
    float.height = r.height;
    const fctx = float.getContext("2d", { willReadFrequently: true })!;
    fctx.drawImage(srcCtx.canvas, 0, 0);
    fctx.globalCompositeOperation = "destination-in";
    fctx.drawImage(maskCanvas, 0, 0);

    // Auto size: trim to the actual pixels, not the loose lasso rectangle.
    const ab = alphaBounds(fctx, r.width, r.height);
    if (!ab) {
      toast("Nothing to lift here");
      clearRegion();
      return null;
    }
    const bw = ab.x1 - ab.x0 + 1;
    const bh = ab.y1 - ab.y0 + 1;
    const trimmed = document.createElement("canvas");
    trimmed.width = bw;
    trimmed.height = bh;
    trimmed.getContext("2d")!.drawImage(float, ab.x0, ab.y0, bw, bh, 0, 0, bw, bh);

    // Place it: the trimmed region's pixel-space center → frame-center coords
    // through the source pose, so it lands exactly where it was selected under
    // any of the source's scale/rotation.
    const pcx = ab.x0 + bw / 2;
    const pcy = ab.y0 + bh / 2;
    const d = mapLocal(pcx - r.width / 2, pcy - r.height / 2, r.pose);
    const fx = r.pose.cx + d.x;
    const fy = r.pose.cy + d.y;

    const srcClip = locateClip(store.getState(), r.sourceClipId)?.clip;
    const layer = createRasterClip({
      frameId: r.frame.id,
      width: bw,
      height: bh,
      startMs: srcClip?.startMs ?? 0,
      durationMs: srcClip?.durationMs ?? frameDurationMs(store.getState(), r.frame),
      name: cut ? "Cut selection" : "Selection",
    });
    layer.transform = {
      ...layer.transform,
      x: fx,
      y: fy,
      scale: r.pose.scale,
      scaleY: r.pose.scaleY,
      rotation: r.pose.rotation,
      skewX: r.pose.skewX,
      skewY: r.pose.skewY,
    };
    writeSurface(layer.surfaceId, bw, bh, (c) => c.drawImage(trimmed, 0, 0));

    // Cut erases the region from a mutable (raster) source only.
    let cutInfo: { clipId: string; rev: number } | null = null;
    if (cut && r.mutable) {
      const clip = rasterClipById(r.sourceClipId);
      if (clip) {
        const surface = surfaceForClip(clip);
        const tx = beginStroke(clip);
        surface.ctx.save();
        surface.ctx.globalCompositeOperation = "destination-out";
        surface.ctx.drawImage(maskCanvas, 0, 0);
        surface.ctx.restore();
        const b = r.mask.bounds;
        extendDirty(tx, b.x0 - 1, b.y0 - 1, b.x1 + 1, b.y1 + 1);
        const next = clip.rev + 1;
        if (commitStroke(tx, next)) cutInfo = { clipId: clip.id, rev: next };
      }
    }

    store.update(cut ? "Cut to new layer" : "Lift to new layer", (d) => {
      placeClip(d, layer, { aboveClipId: r.sourceClipId });
      if (cutInfo) {
        const loc = locateClip(d, cutInfo.clipId);
        if (loc?.clip.kind === "raster") loc.clip.rev = cutInfo.rev;
      }
    });
    clearRegion();
    const session = useSession.getState();
    session.select([layer.id]);
    session.setTool("select"); // hand off to the shared transform gizmo
    touchSurfaces();
    return layer.id;
  };

  /**
   * Hand the marching-ants selection to the V tool as a FLOATING selection: cut
   * the pixels into a temp raster clip the normal gizmo transforms, and remember
   * where to merge it back. It stays live until deselect — no auto-deselect, no
   * duplicate. The image, if any, is rasterized in place by the cut first.
   */
  const beginFloatingSelection = (r: RegionState): void => {
    const clipId = liftRegionToLayer(r, true);
    if (!clipId) return;
    // `r.sourceClipId` was retargeted to the (possibly rasterized) raster source.
    floatRef.current = { clipId, sourceClipId: r.sourceClipId, frameId: r.frame.id };
  };

  /**
   * Flatten a floating selection back INTO its source layer at its current gizmo
   * transform, then delete the temp clip — the edit lands in the same layer, one
   * journaled step, never a duplicate. Runs on deselect / selecting elsewhere.
   */
  const commitFloat = (): void => {
    const f = floatRef.current;
    if (!f) return;
    floatRef.current = null;
    const doc = store.getState();
    const floatLoc = locateClip(doc, f.clipId);
    const src = rasterClipById(f.sourceClipId);
    const frame = doc.frames.find((fr) => fr.id === f.frameId);
    // Source or frame gone (deleted/undone) → just drop the temp clip.
    if (!floatLoc || !src || !frame) {
      if (floatLoc) store.update("Merge selection", (d) => deleteClip(d, f.clipId));
      return;
    }
    // Render the float at its transform in frame space, then draw it onto the
    // source surface through the inverse source pose (frame → surface pixels).
    const floatFrame = renderClipPixels(frame, f.clipId).canvas;
    const surface = surfaceForClip(src);
    const pose = rasterPose(src);
    const tx = beginStroke(src);
    // Frame space → this layer's pixels, through the one inverse layer map: it
    // undoes scale, shear and rotation in the right ORDER (a hand-written
    // rotate-then-scale chain undoes them in the wrong one under non-uniform
    // scale) and carries the pivot, so a moved — or GROWN — layer still lands
    // the float on the art.
    surface.ctx.save();
    surface.ctx.translate(src.width / 2, src.height / 2);
    applyInverseLayerBasis(surface.ctx, pose);
    surface.ctx.translate(-pose.cx - frame.width / 2, -pose.cy - frame.height / 2);
    surface.ctx.drawImage(floatFrame, 0, 0);
    surface.ctx.restore();
    extendDirty(tx, 0, 0, src.width, src.height);
    const nextRev = src.rev + 1;
    const committed = commitStroke(tx, nextRev);
    store.update("Merge selection", (d) => {
      if (committed) {
        const l = locateClip(d, src.id);
        if (l?.clip.kind === "raster") l.clip.rev = nextRev;
      }
      deleteClip(d, f.clipId);
    });
    touchSurfaces();
  };

  /** Erase the selected pixels in place. An image is rasterized first so the
   *  erase rewrites the media itself (same layer), like a pixel layer. */
  const deleteRegion = (r: RegionState): void => {
    if (!ensureRegionMutable(r)) return;
    const clip = rasterClipById(r.sourceClipId);
    if (!clip) {
      clearRegion();
      return;
    }
    const surface = surfaceForClip(clip);
    const tx = beginStroke(clip);
    surface.ctx.save();
    surface.ctx.globalCompositeOperation = "destination-out";
    surface.ctx.drawImage(maskAlphaCanvas(r.mask), 0, 0);
    surface.ctx.restore();
    const b = r.mask.bounds;
    extendDirty(tx, b.x0 - 1, b.y0 - 1, b.x1 + 1, b.y1 + 1);
    const nextRev = clip.rev + 1;
    if (commitStroke(tx, nextRev)) {
      store.update("Delete selection", (d) => {
        const loc = locateClip(d, clip.id);
        if (loc?.clip.kind === "raster") loc.clip.rev = nextRev;
      });
    }
    touchSurfaces();
    clearRegion();
  };

  /** Invert the selection to everything OUTSIDE the current mask. */
  const invertRegion = (r: RegionState): void => {
    const { width, height, data } = r.mask;
    const inv = new Uint8Array(data.length);
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const on = data[i] === 1 ? 0 : 1;
        inv[i] = on;
        if (on) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    }
    const mask: RegionMask = { width, height, data: inv, bounds: { x0, y0, x1, y1 } };
    r.mask = mask;
    r.loops = traceRegion(mask, 1.2);
    dirtyRef.current = true;
  };

  const wandSelect = (e: React.PointerEvent): void => {
    const drawing = useDrawing.getState();
    const ctx = paintCtx();
    if (!ctx) {
      toast("No frame under the playhead — add one in the sheet");
      return;
    }
    const target = regionTarget(ctx);
    if (target?.mode === "raster") {
      const surface = surfaceForClip(target.clip);
      const p = toSurface({ ...rasterPose(target.clip), clip: target.clip }, paintLocal(localPoint(e), ctx));
      const pixels = surface.ctx.getImageData(0, 0, target.clip.width, target.clip.height);
      const mask = drawing.lasso.contiguous
        ? floodRegion(pixels.data, target.clip.width, target.clip.height, p.x, p.y, drawing.lasso.tolerance)
        : globalColorMask(pixels.data, target.clip.width, target.clip.height, p.x, p.y, drawing.lasso.tolerance);
      if (mask) applySelection(ctx, target, mask);
      return;
    }
    if (target?.mode === "rendered") {
      // Image / video: flood the clip's rendered pixels in frame space and open
      // the SAME marching-ants selection (immutable source → copy-only).
      const frame = ctx.frame;
      const p = paintLocal(localPoint(e), ctx);
      const px = p.x + frame.width / 2;
      const py = p.y + frame.height / 2;
      const pixels = renderClipPixels(frame, target.clip.id).getImageData(0, 0, frame.width, frame.height);
      const mask = drawing.lasso.contiguous
        ? floodRegion(pixels.data, frame.width, frame.height, px, py, drawing.lasso.tolerance)
        : globalColorMask(pixels.data, frame.width, frame.height, px, py, drawing.lasso.tolerance);
      if (mask) applySelection(ctx, target, mask);
      return;
    }
    // Vector-only comp: flood the RENDERED pixels (the same trick as the
    // vector bucket) and cut vector strokes with the region.
    const frame = ctx.frame;
    const p = paintLocal(localPoint(e), ctx);
    // The wand on a vector comp reads the SAME cached reference raster the
    // bucket and the confine stencil do, at the wand's own tolerance. It used
    // to re-render the whole comp for every click through a private
    // `compositePixels`, which was a second rasterizer answering one question.
    const { pixels } = referenceRaster(store.getState(), frame, useSession.getState().playheadMs, {
      ...drawing.scope,
      tolerance: drawing.lasso.tolerance,
    });
    const seed = seedInRaster(p, frame);
    const mask = floodRegion(pixels.data, frame.width, frame.height, seed.x, seed.y, drawing.lasso.tolerance);
    if (!mask) return;
    const pieces = cutVectorsByRegion(frame, maskRegion(frame, mask));
    if (pieces.length === 0) toast("Nothing to select here");
  };

  /** A pixel mask as a vector REGION: traced contours, back in frame-center
   *  coords. The wand's bridge from "pixels that matched" to "an area to cut". */
  const maskRegion = (frame: Frame, mask: RegionMask): CutRegion => ({
    loops: traceRegion(mask, 1.2).map((loop) =>
      loop.map((p) => ({ x: p.x - frame.width / 2, y: p.y - frame.height / 2 })),
    ),
  });

  /**
   * The lasso and the wand, on vector art.
   *
   * A region drawn on the stage is a REGION, not a bitmap: it comes in as the
   * loops you actually drew (or the contours the wand traced) and is mapped
   * into each layer's own space, so the cut is exact at any zoom and on any
   * rotated, scaled or pivoted layer — no rasterization in the middle.
   *
   * What lands there is the layer's own business (`cutVectorByRegion`): filled
   * art splits into two CLOSED paths with your loop as the new border, an open
   * stroke splits into arcs, and in "select whole" mode nothing is cut at all.
   * Shapes become paths on touch. Returns the ids now selected.
   */
  const cutVectorsByRegion = (frame: Frame, region: CutRegion): string[] => {
    const drawing = useDrawing.getState();
    const session = useSession.getState();
    const doc = store.getState();
    const candidates = resolveStrokeTargets(
      doc,
      frame.id,
      session.selectedClipIds,
      drawing.lasso.scope,
      frame.id === session.activeFrameId ? session.playheadMs : null,
    )
      .filter((t) => t.medium === "vector")
      .map((t) => t.clipId);
    if (candidates.length === 0) return [];

    const picked: string[] = [];
    store.update("Lasso cut", (d) => {
      for (const id of candidates) {
        const seam = vectorEditSeam(d, id);
        if (!seam) continue;
        const space = layerSpace(seam.clip);
        const local: CutRegion = {
          loops: region.loops.map((loop) => loop.map((p) => space.at(p.x, p.y))),
        };
        picked.push(
          ...applyVectorCut(
            d,
            seam,
            cutVectorByRegion(seam.shown, local, {
              mode: drawing.lasso.vectorMode,
              filled: seam.clip.fills.length > 0,
              fidelity: {
                ...drawing.lasso.fidelity,
                simplify: drawing.lasso.fidelity.simplify * space.lengthScale,
              },
            }),
          ),
        );
      }
    });
    if (picked.length > 0) session.select(picked);
    return picked;
  };

  // Enter/⏎ closes an open polygon; Delete/Escape act on the live selection
  // (Escape also cancels an in-progress polygon draft).
  React.useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const draft = lassoDraftRef.current;
      if (draft && draft.shape === "poly") {
        if (e.key === "Enter") {
          e.preventDefault();
          finalizeLassoDraft(draft);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          lassoDraftRef.current = null;
          dirtyRef.current = true;
          return;
        }
      }
      const r = regionRef.current;
      if (!r) return;
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        e.stopPropagation();
        deleteRegion(r);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelRegion();
      }
    };
    // Capture phase: the selection outranks the global delete-clip shortcut.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Switching to V (select) with a live marching-ants selection hands it off as
  // a FLOATING selection — the pixels lift into a temp clip the gizmo drives, no
  // auto-deselect and no duplicate. The lasso itself never moves anything.
  React.useEffect(() => {
    if (tool !== "select") return;
    const r = regionRef.current;
    if (r) beginFloatingSelection(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // A floating selection FLATTENS back into its source the instant it stops
  // being the active selection — deselect, select-another, or leave V. Driven by
  // a session subscription (reads FRESH state) so the lift that just created it
  // — which selects the temp clip — never trips an immediate self-commit.
  React.useEffect(() => {
    return useSession.subscribe(() => {
      const f = floatRef.current;
      if (!f) return;
      const s = useSession.getState();
      if (s.tool !== "select" || !s.selectedClipIds.includes(f.clipId)) commitFloat();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Lasso sub-tools: one draft, one finalize, three drawing processes ────────

  /** The four corners of a rectangle from an anchor + moving point (same space). */
  const rectCorners = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
  };

  /** Append a free-lasso vertex, dropping ones too close to matter. */
  const pushLassoPoint = (
    draft: NonNullable<typeof lassoDraftRef.current>,
    p: { x: number; y: number },
  ): void => {
    const last = draft.points[draft.points.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1.5 * draft.space.pxToLocal) return;
    draft.points.push(p);
  };

  /** Is the pointer within a grab radius of the polygon's first vertex (close)? */
  const nearFirstPoint = (draft: NonNullable<typeof lassoDraftRef.current>, e: React.PointerEvent) => {
    const first = draft.points[0];
    if (!first) return false;
    const p = draft.space.fromScreen(localPoint(e));
    return Math.hypot(p.x - first.x, p.y - first.y) <= 9 * draft.space.pxToLocal;
  };

  /** Close the outline into a mask and route it through the selection seam —
   *  the ONE finish shared by free-drag, rectangle and polygon alike. */
  const finalizeLassoDraft = (draft: NonNullable<typeof lassoDraftRef.current>): void => {
    lassoDraftRef.current = null;
    dirtyRef.current = true;
    if (draft.points.length < 3) return;
    const frame = draft.frame;
    const frameMask = polygonMask(
      draft.points.map((p) => ({ x: p.x + frame.width / 2, y: p.y + frame.height / 2 })),
      frame.width,
      frame.height,
    );
    const pieces = cutVectorsByRegion(frame, { loops: [draft.points] });
    const draftCtx: PaintCtxState = draft.space;
    const target = regionTarget(draftCtx);
    if (target?.mode === "raster") {
      const pose = { ...rasterPose(target.clip), clip: target.clip };
      applySelection(
        draftCtx,
        target,
        polygonMask(
          draft.points.map((p) => toSurface(pose, p)),
          target.clip.width,
          target.clip.height,
        ),
      );
    } else if (target?.mode === "rendered") {
      applySelection(draftCtx, target, frameMask);
    } else if (pieces.length === 0) {
      toast("Nothing to select here");
    }
  };

  /** Arm/advance a lasso draft for the armed sub-tool. Free/rect drag; polygon
   *  collects clicked vertices and closes near its start (or on ⏎/double-click). */
  const onLassoDown = (e: React.PointerEvent): void => {
    const shape = useDrawing.getState().lasso.shape;
    const pctx = paintCtx();
    if (!pctx) {
      toast("No frame under the playhead — add one in the sheet");
      return;
    }
    const local = paintLocal(localPoint(e), pctx);
    if (shape === "poly") {
      const d = lassoDraftRef.current;
      if (d && d.shape === "poly") {
        if (d.points.length >= 3 && nearFirstPoint(d, e)) return finalizeLassoDraft(d);
        d.points.push(local);
        d.cursor = local;
        dirtyRef.current = true;
        return;
      }
      lassoDraftRef.current = {
        frame: pctx.frame,
        space: pctx,
        shape: "poly",
        points: [local],
        anchor: local,
        cursor: local,
        pointerId: null,
        stab: null,
      };
      dirtyRef.current = true;
      return;
    }
    const leash = shape === "free" ? liveLeash(useDrawing.getState().lasso.fidelity) : 0;
    lassoDraftRef.current = {
      frame: pctx.frame,
      space: pctx,
      shape,
      points: [local],
      anchor: local,
      cursor: null,
      pointerId: e.pointerId,
      stab: leash > 0 ? createStabilizer(localPoint(e), leash) : null,
    };
    dirtyRef.current = true;
  };

  // ── Pointer wiring ─────────────────────────────────────────────────────────

  /**
   * THE DRAWING DOOR — brush, eraser, smudge and the drawing lasso all begin
   * here, so pen-only and the move-or-hold intent are applied once for all of
   * them rather than per tool.
   *
   * The same `useTouchIntent` the stage uses, and for the same reason: with
   * pen-only off, a finger that starts travelling immediately meant to move the
   * canvas, not to lay down a stroke that then has to be undone. Not starting
   * is free; unstarting a stroke is not.
   *
   * `onTool` calls through a wrapper rather than passing `beginToolPress`
   * directly: it is a `const` defined below, and only the wrapper's BODY runs
   * later, which keeps the hook above every early return where a hook has to be
   * without caring which of the two is written first.
   */
  const onPointerDown = useTouchIntent({
    // The drawing tools split across three acts, not one: a brush PAINTS, the
    // lasso SWEEPS a selection region, and fill and the wand are a single
    // PICK. Asking one question for all five was what made "pen only" also
    // stop a finger from flood-filling, which nothing about a finger makes it
    // bad at.
    act: () => actForTool(useSession.getState().tool),
    onTool: (e) => beginToolPress(e),
    onPan: (dx, dy) => {
      const v = useStageView.getState();
      v.set({ scale: v.scale, tx: v.tx + dx, ty: v.ty + dy });
    },
  });

  const beginToolPress = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Palm rejection: touch is ignored while a pen is down; and a pen landing
    // cancels any stray touch stroke.
    if (e.pointerType === "touch" && penPointerRef.current !== null) return;
    if (e.pointerType === "pen") penPointerRef.current = e.pointerId;
    useSession.getState().setFocusedPanel("canvas");
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);

    // The lasso ONLY selects — moving/transforming is the V tool's job (it lifts
    // a floating selection). So a fresh press with a live selection: in a combine
    // mode it's kept (the next draw merges into it); in "new" mode it's dropped
    // and redrawn; any non-selection tool drops it.
    const region = regionRef.current;
    if (region) {
      const lassoFamily = tool === "lasso" || tool === "wand";
      if (!lassoFamily) {
        clearRegion();
      } else if (useDrawing.getState().lasso.combine === "new") {
        clearRegion();
      }
    }

    if (tool === "fill") {
      applyFill(e);
      return;
    }
    if (tool === "wand") {
      wandSelect(e);
      return;
    }
    if (tool === "lasso") {
      onLassoDown(e);
      return;
    }
    beginBrushStroke(e);
    if (strokeRef.current) feedStroke(e);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    cursorRef.current = localPoint(e);
    dirtyRef.current = true;
    updateRegionHover(e);

    const draft = lassoDraftRef.current;
    if (draft) {
      const local = draft.space.fromScreen(localPoint(e));
      if (draft.shape === "poly") {
        draft.cursor = local; // rubber-band the open edge to the cursor
        return;
      }
      if (draft.pointerId === e.pointerId) {
        if (draft.shape === "rect" && draft.anchor) {
          draft.points = rectCorners(draft.anchor, local);
          return;
        }
        // Free lasso: the same leash a brush gets, then thinned — a loop is
        // about to become a boolean's cutter, and every vertex kept here is a
        // vertex the cut has to resolve and the refit has to undo.
        const leash = liveLeash(useDrawing.getState().lasso.fidelity);
        if (leash > 0 && !draft.stab) draft.stab = createStabilizer(localPoint(e), leash);
        const screen = draft.stab ? stabilizerPush(draft.stab, localPoint(e), leash) : [localPoint(e)];
        for (const q of screen) pushLassoPoint(draft, draft.space.fromScreen(q));
        return;
      }
    }
    if (strokeRef.current) feedStroke(e);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    endPointerGesture(e.pointerId);
  };

  /**
   * THE ONE END for every drawing gesture, whatever ended it.
   *
   * Idempotent by construction — both `finishStroke` and `finalizeLassoDraft`
   * clear their ref first — because a release arrives twice: once as this
   * element's `pointerup`, once as the arbiter's. Whichever is first does the
   * work and the other finds nothing.
   */
  const endPointerGesture = (pointerId: number): void => {
    if (penPointerRef.current === pointerId) penPointerRef.current = null;
    // Free/rect finish on release; the polygon finishes on close (⏎ / near-start
    // click / double-click), never here.
    const draft = lassoDraftRef.current;
    if (draft && draft.shape !== "poly" && draft.pointerId === pointerId) {
      finalizeLassoDraft(draft);
      return;
    }
    if (strokeRef.current?.pointerId === pointerId) finishStroke();
  };

  /** Double-click closes a polygon lasso. */
  const onDoubleClick = (): void => {
    const d = lassoDraftRef.current;
    if (d && d.shape === "poly") finalizeLassoDraft(d);
  };

  /**
   * A STROKE ENDS WHEN THE POINTER DOES — including the ways a pointer ends
   * without a `pointerup` on this element.
   *
   * The two React handlers only ever hear a release or a cancel delivered HERE.
   * A window blur, a hidden tab, a portalled layer mounting over the press, or
   * a second finger landing all retire the pointer with no event this element
   * will ever see (`docs/responsive-and-gestures.md` — "the pointer that never
   * came back"). The stroke then stayed live: the brush kept painting from a
   * gesture that had ended, and the marks landed whenever the next stray move
   * arrived. Leaving the window mid-stroke with the mouse is exactly that.
   *
   * The REASON no longer matters, and that is the point: a stroke ends where
   * the tool is, so every way a pointer can disappear leaves the same line
   * behind. There is nothing left for a release to commit that a loss would
   * have had to refuse.
   */
  const endRef = React.useRef(endPointerGesture);
  endRef.current = endPointerGesture;
  React.useEffect(
    () => subscribePointerEnd((id) => endRef.current(id)),
    [],
  );

  /**
   * ⇧ as a live state. Held, it REVERSES the armed tool's smoothing — brush,
   * eraser or free lasso — so it both stabilises a loose tool and turns a
   * smoothed one loose for one stroke (core `effectiveSmoothing`). Capture
   * phase and `window`, because it must stay true while the pointer is
   * captured by the canvas; and it lands in a store rather than a ref, because
   * the brush handle's toggle has to show the same answer the stroke uses.
   */
  React.useEffect(() => {
    if (!active) return;
    const sync = (e: KeyboardEvent) => {
      if (e.shiftKey === shiftHeld()) return;
      useShiftHeld.getState().set(e.shiftKey);
      dirtyRef.current = true;
    };
    const clear = () => {
      useShiftHeld.getState().set(false);
      dirtyRef.current = true;
    };
    window.addEventListener("keydown", sync, true);
    window.addEventListener("keyup", sync, true);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync, true);
      window.removeEventListener("keyup", sync, true);
      window.removeEventListener("blur", clear);
    };
  }, [active]);

  // ── Overlay painting (cursor ring + live stroke previews) ──────────────────

  React.useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    // A freshly re-mounted canvas (re-arming a tool) must size + paint on its
    // first frame; dirtyRef can linger `false` from the previous session.
    dirtyRef.current = true;
    const unsubs = [useStageView.subscribe(() => (dirtyRef.current = true))];

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      // The loop must never assume its node is still mounted: during any teardown
      // race the canvas can be detached (parentElement === null) a frame before
      // the rAF is cancelled. Skip that frame instead of dereferencing null.
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const view = useStageView.getState();
      const s = strokeRef.current;

      // Live raster-brush buffer, composited at stroke opacity in place
      // (grain-gated, so the preview IS the committed look).
      if (s?.mode === "raster-brush" && s.buffer && s.target) {
        const t = s.target;
        ctx.save();
        ctx.globalAlpha = s.opacity;
        s.space.applyTo(ctx);
        ctx.translate(t.cx, t.cy);
        // THE renderer's own matrix, not a re-derivation of it: a live stroke
        // has to sit exactly on the pixels it is about to become, and `t.size`
        // is the box the pivot is a fraction of, so a GROWN layer (whose pivot
        // is re-normalised off centre to hold its pixels still) previews where
        // it will land instead of half a growth block toward the shorter side.
        applyLayerBasis(ctx, t);
        ctx.translate(-t.clip.width / 2, -t.clip.height / 2);
        // The buffer's (0,0) is `bufferPad` OUTSIDE the layer's own top-left —
        // that overhang is where paint made past the edge lives, and it has to
        // show while the stroke is live or the layer appears to clip marks it
        // is about to keep.
        ctx.drawImage(grainGatedBuffer(s.buffer, s.brush), -s.bufferPad.left, -s.bufferPad.top);
        ctx.restore();
      }

      // Pixel-space→screen transform for a region (raster surface OR a rendered
      // image in frame space) — the pose carries both cases (shared by chrome).
      const applyRegionTransform = (
        space: EditSpace,
        pose: RegionPose,
        width: number,
        height: number,
      ) => {
        space.applyTo(ctx);
        ctx.translate(pose.cx, pose.cy);
        applyLayerBasis(ctx, pose);
        ctx.translate(-width / 2, -height / 2);
      };

      // Selection draft: dashed outline for any sub-tool. Free/rect close their
      // shape; the polygon rubber-bands its open edge to the cursor and shows a
      // grab dot on the first vertex (click it — or ⏎ / double-click — to close).
      const draft = lassoDraftRef.current;
      if (draft && draft.points.length > 0) {
        const poly = draft.shape === "poly";
        const hair = draft.space.pxToLocal;
        ctx.save();
        draft.space.applyTo(ctx);
        ctx.lineWidth = hair;
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.setLineDash([4 * hair, 4 * hair]);
        ctx.beginPath();
        ctx.moveTo(draft.points[0]!.x, draft.points[0]!.y);
        for (const p of draft.points) ctx.lineTo(p.x, p.y);
        if (poly && draft.cursor) ctx.lineTo(draft.cursor.x, draft.cursor.y);
        if (!poly) ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        if (poly && draft.points.length >= 3) {
          ctx.beginPath();
          ctx.arc(draft.points[0]!.x, draft.points[0]!.y, 5 * hair, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Live selection: marching ants around the mask (the lasso only selects;
      // moving is the V tool's floating-selection job).
      const region = regionRef.current;
      if (region) {
        ctx.save();
        applyRegionTransform(region.space, region.pose, region.width, region.height);
        // Chrome stays a HAIRLINE at every zoom AND every nesting depth: inside
        // a half-scale comp the local unit is half a world unit, so a screen
        // pixel is `pxToLocal` of them — not `1 / view.scale`.
        const ant = region.space.pxToLocal;
        ctx.lineWidth = ant;
        for (const [color, offset] of [
          ["rgba(0,0,0,0.8)", 0],
          ["rgba(255,255,255,0.95)", 4 * ant],
        ] as const) {
          ctx.strokeStyle = color;
          ctx.setLineDash([4 * ant, 4 * ant]);
          ctx.lineDashOffset = offset;
          for (const loop of region.loops) {
            if (loop.length < 2) continue;
            ctx.beginPath();
            ctx.moveTo(loop[0]!.x, loop[0]!.y);
            for (const p of loop) ctx.lineTo(p.x, p.y);
            ctx.closePath();
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // Live vector-brush stroke — THE REAL ONE.
      //
      // This used to be a plain round-capped polyline at the nominal size: no
      // pressure, no taper, no profile, no second line of the brush's stack, no
      // dash. So a vector brush was previewed by a marker pen and then replaced
      // by the actual stroke the moment you lifted — which reads as the tool
      // changing its mind, and cost more trust than the flat line ever saved.
      //
      // It goes through `vectorStroke` + `paintVectorStroke`, which is the same
      // pair the commit and the Brush Studio playground use, so the preview
      // cannot describe a brush the commit will not draw. Fitting per frame is
      // what a live-fitting vector tool costs; the loop is dirty-flagged, so it
      // is paid once per batch of new samples rather than once per frame.
      if (s?.mode === "vector-brush" && s.engine.polyline.length > 1) {
        const preview = vectorStroke(s.engine.polyline, s.brush, s.sizePx, {
          fidelity: s.fidelity,
          pressure: useDrawing.getState().pressure,
        });
        if (preview) {
          ctx.save();
          s.space.applyTo(ctx);
          // The preview paints PIXELS on the overlay, so it resolves the token
          // even though the committed stroke will store it — same reason
          // `inkColor` exists, one frame earlier.
          paintVectorStroke(ctx, preview, inkColor(s.color), s.opacity);
          ctx.restore();
        }
      }

      // ── The region highlight ────────────────────────────────────────────
      //
      // A soft tinted wash inside the region plus a marching outline, painted
      // UNDER the cursor chrome so the ring stays readable on top of it.
      //
      // It reads as the app's own accent rather than the paint colour on
      // purpose: this is chrome saying "here is the shape I found", not a
      // preview of the fill. A translucent slab of the actual colour looks like
      // the fill has already happened, and people let go of the pen.
      //
      // A LEAKED region — one that reached every edge of the frame — is drawn in
      // the destructive colour instead. That is the whole gap-closing feedback
      // loop in one glance: hover, see red spill across the canvas, raise Close
      // gaps until it snaps back to the shape you meant.
      const hover = hoverRef.current;
      if (hover && !strokeRef.current) {
        ctx.save();
        hover.space.applyTo(ctx);
        const path = new Path2D();
        for (const loop of hover.loops) {
          if (loop.length < 2) continue;
          path.moveTo(loop[0]!.x, loop[0]!.y);
          for (let i = 1; i < loop.length; i++) path.lineTo(loop[i]!.x, loop[i]!.y);
          path.closePath();
        }
        const accent = hover.leaked ? "239,68,68" : "124,92,255";
        ctx.fillStyle = `rgba(${accent},${hover.leaked ? 0.1 : 0.14})`;
        // Even-odd so traced holes read as holes — the same rule the committed
        // fill uses (`fillRule = "evenodd"`), so the highlight and the fill
        // agree about what a donut is.
        ctx.fill(path, "evenodd");
        // Hairline at every zoom: a 1px outline scaled up by the camera becomes
        // a fat band that hides the very edge it is describing.
        const edge = hover.space.pxToLocal;
        ctx.lineWidth = 1.5 * edge;
        ctx.strokeStyle = `rgba(${accent},0.9)`;
        ctx.setLineDash([6 * edge, 4 * edge]);
        ctx.lineDashOffset = -(performance.now() / 40) % 10;
        ctx.stroke(path);
        ctx.restore();
        // The ants march, so this frame's output differs from the last one's —
        // the dirty flag is a statement about the PICTURE, not about input, and
        // an animation that does not re-arm it renders exactly one frame and
        // then looks frozen.
        dirtyRef.current = true;
      }

      // ── Tool cursor + the stabiliser's leash ────────────────────────────
      //
      // One block, because they are one thing: the ring is where the tool IS,
      // and under smoothing that is no longer where the pointer is. Drawing the
      // ring at the cursor while paint appeared somewhere else would make a
      // stabilised brush feel broken rather than smooth — so the ring rides the
      // tool, a line tethers it to your hand, and the pull is visible.
      const cursor = cursorRef.current;
      const drawing2 = useDrawing.getState();
      const lib2 = useBrushLibrary.getState();
      const toolSize =
        tool === "eraser"
          ? drawing2.eraser.size
          : tool === "brush"
            ? lib2.effective(
                drawing2.brush.engine === "vector" ? lib2.activeVectorBrushId : lib2.activeRasterBrushId,
              ).size
            : 0; // fill / lasso / wand aim with the pointer, not a ring

      /** The tip ring, stretched along its travel — a tool under load leans. */
      const tipRing = (at: { x: number; y: number }, radius: number, dir: number, tension: number) => {
        ctx.save();
        ctx.lineWidth = 1;
        for (const [color, grow] of [
          ["rgba(0,0,0,0.4)", 1],
          ["rgba(255,255,255,0.85)", 0],
        ] as const) {
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.ellipse(at.x, at.y, radius * (1 + 0.3 * tension) + grow, radius + grow, dir, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      };

      /** The leash: a bright head at the tool, fading to a ring at your hand. */
      const leashChrome = (stab: StabilizerState, radius: number) => {
        const from = stab.point;
        const to = stab.cursor;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy);
        const dir = Math.atan2(dy, dx);
        ctx.save();
        if (len > 2) {
          const grad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
          grad.addColorStop(0, `rgba(255,255,255,${(0.5 + 0.4 * stab.tension).toFixed(3)})`);
          grad.addColorStop(1, "rgba(255,255,255,0.05)");
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1 + stab.tension;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(to.x, to.y);
          ctx.stroke();
          // Debris strung along the line, thinning toward the hand: the pull
          // reads as motion instead of as a static rubber band.
          for (let i = 1; i <= 3; i++) {
            const t = i / 4;
            ctx.fillStyle = `rgba(255,255,255,${(0.45 * (1 - t) * stab.tension).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(from.x + dx * t, from.y + dy * t, 1.9 * (1 - t) + 0.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        // The hand: a small open ring, never a filled dot — it is a reference
        // point, not a thing you are placing.
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(to.x, to.y, 3.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        if (radius > 0) tipRing(from, Math.max(2, (toolSize / 2) * view.scale), dir, stab.tension);
      };

      if (s?.pen.stab) {
        leashChrome(s.pen.stab, s.pen.stab.radius);
      } else if (cursor && !s) {
        const draftStab = lassoDraftRef.current?.stab ?? null;
        if (draftStab) leashChrome(draftStab, draftStab.radius);
        else if (toolSize > 0) {
          tipRing(cursor, (toolSize / 2) * view.scale, 0, 0);
          // Idle with ⇧ down: the leash you are ABOUT to draw with, so the
          // feature announces itself the moment the key goes down.
          const idleLeash =
            tool === "eraser"
              ? liveLeash(drawing2.eraser.fidelity)
              : tool === "brush"
                ? liveLeash(drawing2.brush.fidelity)
                : 0;
          if (idleLeash > 0) {
            ctx.save();
            ctx.strokeStyle = "rgba(255,255,255,0.22)";
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 4]);
            ctx.beginPath();
            ctx.arc(cursor.x, cursor.y, idleLeash, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
        }
      }
    };
    raf = requestAnimationFrame(draw);
  return () => {
      cancelAnimationFrame(raf);
      for (const u of unsubs) u();
    };
  }, [active, tool]);

  // Interrupted gestures (tool switch, unmount) abandon cleanly: raster-brush
  // never touched the surface (buffer only); erase txs just never commit.
  React.useEffect(() => {
    if (!active && strokeRef.current) strokeRef.current = null;
  }, [active]);

  if (!active) return null;
  const overlayCanvas = (
    <canvas
      ref={canvasRef}
      // h-full w-full is load-bearing: a <canvas> is a REPLACED element, so
      // `absolute inset-0` alone does NOT stretch it — its intrinsic 300×150
      // wins and it sits as a small box in the corner until the rAF draw loop
      // sets an explicit pixel size. That made the overlay miss pointer events
      // (they fell through to the stage's select handler) right after arming a
      // tool, "fixing itself" only once a scroll marked the loop dirty. Filling
      // via CSS makes the hit area correct from mount, like VectorOverlay.
      className="absolute inset-0 z-30 h-full w-full touch-none"
      style={{
        cursor:
          tool === "brush" ? cursors.brush : tool === "eraser" ? cursors.eraser : tool === "fill" ? cursors.fill : cursors.crosshair,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onPointerLeave={() => {
        cursorRef.current = null;
        dirtyRef.current = true;
      }}
    />
  );

  // A live pixel selection gets a right-click menu — the standard set, all built
  // on shared brains (mask ops, lift-to-layer). The ContextMenu WRAPPER is always
  // mounted so the <canvas> node identity never changes: the rAF draw loop (keyed
  // on `active`, which doesn't change here) captured this exact node and renders
  // the selection chrome onto it. Swapping the wrapper in/out on `regionActive`
  // would remount the canvas — stranding the loop on a detached node
  // (parentElement === null → crash) and leaving the fresh canvas with no loop
  // (invisible marching ants). Only the menu CONTENT is gated on a live region.
  const withRegion = (fn: (r: RegionState) => void) => () => {
    const r = regionRef.current;
    if (r) fn(r);
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{overlayCanvas}</ContextMenuTrigger>
      {regionActive && (
      <ContextMenuContent className="w-56">
        <ContextMenuItem
          onClick={withRegion((r) => {
            if (liftRegionToLayer(r, true)) toast("Cut to a new layer — drag to transform");
          })}
        >
          Cut to new layer
        </ContextMenuItem>
        <ContextMenuItem
          onClick={withRegion((r) => {
            if (liftRegionToLayer(r, false)) toast("Copied to a new layer — drag to transform");
          })}
        >
          Copy to new layer
        </ContextMenuItem>
        <ContextMenuItem
          onClick={withRegion((r) => {
            if (liftRegionToLayer(r, false)) toast("Duplicated to a new layer — drag to transform");
          })}
        >
          Duplicate to new layer
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={withRegion(invertRegion)}>Invert selection</ContextMenuItem>
        <ContextMenuItem onClick={withRegion(deleteRegion)}>Delete pixels</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => cancelRegion()}>Deselect</ContextMenuItem>
      </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

/**
 * A CSS colour as unit RGB for the wet simulation.
 *
 * The sim carries PIGMENT, not a colour string: it mixes, dilutes and settles
 * per channel, none of which a `#rrggbb` can do. Kept next to its one caller
 * rather than in the painter, because the painter's whole job is the opposite
 * conversion.
 */
function hexToUnitRgb(color: string): [number, number, number] {
  if (color.startsWith("#")) {
    const hex =
      color.length === 4
        ? `${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
        : color.slice(1, 7);
    const n = parseInt(hex, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  return [1, 1, 1];
}
