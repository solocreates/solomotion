"use client";

import { onStageZoomRequest } from "../input/page-zoom-guard";
import { CAMERA_ZOOM, readLevel, stepLevel } from "../workspace/view-zoom";
import { useWorldUi } from "../world/state";
import * as React from "react";
import {
  createPictureFill,
  clipsUnderGroup,
  documentFontUsage,
  hollowStrokeReach,
  isHollowVector,
  isPathHost,
  layerShowsAt,
  nearestOnOutline,
  pointInPolylines,
  pressHoldsSelection,
  resolvePressSelection,
  createFrame,
  createNestedClip,
  constrainDragToAngle,
  isDrillPress,
  createShapeClip,
  createTextClip,
  solidPaint,
  strokeStyle,
  deleteClip,
  duplicateClipInPlace,
  duplicateFrame,
  expandSelectionToGroups,
  frameContentDurationMs,
  isClipLocked,
  isClipHidden,
  getClipProperty,
  locateClip,
  snapshotBounds,
  pickContextTarget,
  nativeResizeKind,
  clampScale,
  localAxes,
  anchorLocal,
  groupChainMatrix,
  positionOrigin,
  pivotModel,
  type PivotModel,
  CENTER_ANCHOR,
  mapLinear,
  unmapLinear,
  mapLocal,
  type AnchorPoint,
  type LayerBox,
  type Vec2,
  clipBox,
  cropWindow,
  mapContent,
  NO_CONTENT,
  type ContentTransform,
  clipNaturalSize,
  mirrorScale,
  realizedFactor,
  resizeCenter,
  resizePosition,
  resizeSign,
  solveResizeFactors,
  type HandleSign,
  type ResizeBox,
  type ResizeFactors,
  type ResizePose,
  bendMotionSegment,
  deleteMotionKey,
  insertMotionKey,
  motionKeysOf,
  setMotionAnchor,
  setMotionTangent,
  beginTangentDrag,
  resolveTangentDrag,
  type TangentDragStart,
  toggleMotionSmooth,
  type MotionKey,
  buildSnapCandidates,
  snapMove,
  snapPoint,
  type AABB,
  type SnapCandidates,
  type SnapLine,
  clampCameraToLeash,
  compOwnerNested,
  componentFrames,
  componentSetId,
  isComponentsView,
  containsWorldPoint,
  resolveClipContext,
  targetQuad,
  worldDeltaToTarget,
  apply as applyMat,
  type Mat2D,
  invert as invertMat,
  IDENTITY,
  repivotClip,
  pivotPoseAt,
  type EditContext,
  fitCamera,
  maxCornerRadiusForShape,
  reparentClipToFrame,
  playbackScopeOf,
  rememberedPlayheadMs,
  resizeFrame,
  resolveColor,
  resolveStageBackground,
  resolveShapeGeometry,
  type ResolvedShapeGeometry,
  propertyHasKeys,
  sampleKeyframes,
  shapeCommands,
  shearPoint,
  unshearPoint,
  mergeSnapCandidates,
  nodeSnapLines,
  shapeCornerBasis,
  shapeCornerPoints,
  applyLayerAnimToClips,
  paintWithSampled,
  isGradientPaint,
  type Clip,
  type CornerRadius,
  type Frame,
  type Paint,
  type ShapeClip,
  type ShapeKind,
  type MotionDocument,

  pageOfFrame,
  NO_CROP,
  type CropInsets,
  bindTextToPath,
  groupOfClip,
  isPathText,
  offsetForArcLength,
  reorderLayoutMember,
  setBoxSizing,
  layoutMembersOf,
  compPictureDeps,
  findGuide,
  guideLineWorld,
  guideLinesOf,
  guideOwner,
  removeGuide,
} from "@solomotion/core";
import {
  gradientHandleModel,
  hitTestGradient,
  worldToPaintNorm,
  axisT,
  type GradientHandleModel,
  type GradientHandleHit,
} from "./gradient-handles";
import { toast } from "@/lib/toast";
import { isForeignEvent } from "@/lib/portal-events";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { importFilesAsClips, isSvgImageClip, placeAssetClips } from "../assets/import";
import { applyLibraryItemToClip, libraryDropAppliesTo, libraryDropTargets } from "../library/apply-to-clip";
import { setStagePasteAnchor } from "./paste-anchor";
import { filesFromDataTransfer } from "../assets/folder-import";
import { importDroppedFiles } from "../io/slice-file";
import { useDoc, useDocStore } from "../state/document-context";
import type { DocumentStore } from "@solomotion/core";
import { clipLocalClamped, commitProperty, effectiveValue, writeAnimatable } from "../inspector/animatable";
import { useEffectEditor } from "../inspector/effect-editor/store";
import { nudgeTargets } from "./nudge-target";
import { ClipMenuItems, EmptyAreaMenuItems, FrameMenuItems } from "../menus/selection-menu";
import { ensureContentFrame, placeAboveSelection, placeComponentInstance, placeLibraryItem, textPresetClip } from "../state/clip-actions";
import { placeClip, clipByIdIn, linkClickIntent, type LinkClickMode, type Link } from "@solomotion/core";
import { linkAreasIn, linkAtPoint, linkMarkers, type LinkMarker, type LinkUnderPoint, type Quad } from "./link-hit";
import { followLink } from "../links/navigate";
import { isDrawingTool, isShapeTool, useSession, useStageView, type LibraryDrag, type ShapeTool } from "../state/session";
import { switchPage } from "../state/frame-nav";
import { insertFrame } from "../frames/frame-modes";
import { resolveDragSnapshot } from "../state/snapshot-drag";
import { DragPreviewArt } from "../panels/drag-out";
import { useStageDropTarget } from "./use-drop-target";
import { useStagePickSurface } from "./use-stage-pick-surface";
import { contextOf, type NavState } from "../state/navigation";
import { useToolDefaults } from "../state/tool-defaults";
import { useAppShell } from "../state/app-shell";
import { readMods, watchDragModifiers, type DragMods } from "../state/drag-modifiers";
import { getLastFont } from "../state/font-prefs";
import { dragZoomFactor, middleDragIntent, useZoomGesture } from "../state/use-zoom-gesture";
import { useMultiTouch } from "../input/use-multi-touch";
import { useTouchIntent } from "../input/use-touch-intent";
import { actForTool } from "../input/pointer-authority";
import { rectSweepAllowed } from "../state/use-sweep-select";
import { claimPointer, subscribePointerEnd } from "../input/pointer-gestures";
import { beginRotate, drawRotationDial, type RotateTracker } from "./rotation";
import {
  buildMotionScene,
  hitMotionScene,
  motionLocalToWorld,
  motionWorldToLocal,
  paintMotionScene,
  type MotionScene,
} from "./motion-path";
import { PATH_HIT, passedDragLatch } from "./path-chrome";
import {
  PREVIEW_RESOLUTION_SCALE,
  editScopeClipIds,
  compFps,
  compRenderTimeMs,
  frameFps,
  compSteadyKey,
  diffDocumentPicture,
  minTier,
  tierFittingMemory,
  tierForDisplay,
  type PreviewResolution,
  frameStepMs,
  quantizeMsToFrame,
  stagePolicy,
  teeProfiler,
} from "@solomotion/core";
import {
  commandsToPath2D,
  drawFrameContent,
  invalidateBackdrops,
  invalidateMediaDependents,
  type ClipHitRect,
  type EffectFocus,
  resetHitCaptures,
  beginSpillShare,
} from "./render/draw-frame";
import { onEffectPassesReady } from "./render/passes/registry";
import { renderProfiler } from "./render/profiler-instance";
import { notePresented, onStageDirtyRequest } from "./render/stage-dirty";
import {
  drewFootageSince,
  exactMediaPending,
  faithfulSince,
  mediaSeeksPending,
  onMediaSourceChanged,
  outsideFidelity,
  pictureFaults,
  rollingVideoOnScreen,
} from "./render/media-cache";
import { applyDeltaToLayerCache, dropParkedLayers, resetKeptUnits } from "./render/layer-cache";
import { isScrubbingTime } from "../timeline/scrub";
import { framesCacheOn, isCachingEnabled, layersCacheOn, playbackRegime } from "../cache/cache-status";
import {
  blitRaster,
  cameraInMotion,
  cameraStillForMs,
  dropRaster,
  captureRaster,
  noteCameraMove,
  planBlit,
  rasterWorthwhile,
} from "./render/camera-raster";
import { noteRenderCost, shouldDeferRender } from "./render/render-budget";
import {
  applyDeltaToFrameCache,
  cachedRunAhead,
  endFrameEpoch,
  setFrameVariant,
  frameLedger,
  isResolvedAt,
  layerCacheHits,
  noteBuilt,
  readFrame,
  storeFrame,
  withPictureSize,
} from "./render/frame-store";
import { endIncrementalScene, prepareIncrementalScene } from "./render/live-raster";
import { resolvedDocAt } from "@solomotion/core";
import { hostSpaceOf, offsetUnderPointer, outlineUnderPointer, pathTextRide, stageDoc, type OutlineTarget } from "./text-path-chrome";
import { HANDLE_HIT_PX, ROTATE_BAND_PX, cornerBearing, edgeBearing, rotateZoneCorner } from "@solomotion/core";
import { bearingOf, cursors, resizeCursor, rotateCursor } from "@solomotion/ui/cursors";
import { drawTextPathChrome, PATH_GRIP_HIT_PX, textPathGripScreen } from "./text-path-overlay";
import { containerOf, layoutGeometry, layoutHandleAt, type LayoutHandle, type LayoutSlotView } from "./layout-chrome";
import { glideFrom, holdAt, layoutMotionActive, releaseHold } from "./render/layout-motion";
import { drawLayoutChrome, sameLayoutHandle } from "./layout-overlay";
import { activeCompId, timelineEndMs } from "../timeline/timeline-utils";
import { effectiveWorkRange } from "../timeline/work-range";
import { BUDGET_SHARE, shareOfBudget } from "../cache/memory-budget";
import { beginConductPass, onMediaReady, pauseUnconductedElements, syncVideoFrames } from "./render/media-cache";
import {
  beginBoardTick,
  boardLevel,
  boardPictureKey,
  drawBoardPicture,
  dropBoardPictures,
  endBoardEpoch,
  readBoardPicture,
  renderBoardPicture,
  renderInBudget,
  takeUpgradeSlot,
  firstLevel,
  readStaleBoardPicture,
} from "./render/board-pictures";
import { onSurfaceReady } from "../drawing/raster-store";
import { DrawingOverlay } from "../drawing/DrawingOverlay";
import { ToolOptionsBar } from "./ToolOptionsBar";
import { drawOnionSkin } from "../drawing/onion-render";
import { useDrawing } from "../drawing/drawing-store";
import { SelectionCallout } from "./SelectionCallout";
import { AiWorkOverlay } from "./AiWorkOverlay";
import { StageContextBar } from "./StageContextBar";
import { warmDocument } from "./render/warm";
import { onAudioBufferReady } from "../audio/waveform";
import { onSpeechTrack } from "../speech/speech-host";
import { onSoundAnalysis } from "../audio/sound-host";
import { fontChangeTouches, fontFamiliesChangedSince, fontsVersion, subscribeFonts } from "./render/fonts";
import { ensureDocumentFaces } from "./render/system-fonts";
import { spacePan } from "./space-pan";
import { isStageBoundsVisible } from "./stage-focus";
import { useHoverLink } from "./hover-link";
import { FrameRenameOverlay } from "./FrameRenameOverlay";
import { FRAME_LABEL_DIMS_GAP, fitFrameLabel, frameLabelAnchor, frameLabelFont } from "./frame-label";
import { TextEditOverlay } from "./TextEditOverlay";
import { VectorOverlay } from "./VectorOverlay";
import { TrackOverlay } from "./TrackOverlay";
import { RigOverlay } from "../rig/RigOverlay";
import { useRigUi } from "../rig/state";
import { PerformLayer } from "../perform/PerformLayer";
import { PickLayer } from "../character/PickLayer";
import { PhysicsOverlayHost } from "../physics/lazy";
import { WeightPaintOverlay } from "../rig/WeightPaint";
import { WindowOverlay } from "../color/WindowOverlay";
import { consumeRegionDraw } from "./region-draw";
import "../color/window-draw";
import "../tracking/track-draw";
import { regionFromShape } from "@solomotion/core";
import { registerStageCanvas } from "./frame-sample";
import { onGradePreviewChange } from "./render/grade-stage";
import { GradientStopEditor } from "./GradientStopEditor";
import { EyedropperOverlay } from "./EyedropperOverlay";
import { drawPixelGrid } from "./render/pixel-grid";
import { StageToolbar } from "./Toolbar";
import { StageChrome } from "./StageChrome";
import { placementOf } from "./chrome-layout";
import { StageBrushHandle } from "../drawing/StageBrushHandle";
import { accentColor } from "../theme/theme-tokens";
import { StageControls } from "./StageControls";
import { hitAABB, hitCorners, stageHitRects, unionAABB } from "./stage-geometry";
import { materializeArmedCell } from "../drawing/cell-materialize";
import { frameSpace, layerPlacement, layerSpace, standingFrameId } from "./edit-space";
import { beginHeldDrag, type HeldDrag } from "../input/hold-to-drag";
import { frameVectorNodesWorld } from "./stage-snap";
import { SCENE, drawDot, drawGrip, drawMarquee, drawPivot, drawReadout, drawSnapLines, sceneInk, strokeOutline } from "./scene-chrome";
import { RulerOverlay, RULER_SIZE } from "./RulerOverlay";
import { RulerSettings } from "./RulerSettings";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { guideDraft, onGuideDraftChange } from "./guide-drag";
import { guideDashPattern, resolveGuideAppearance, type GuideLine } from "@solomotion/core";
import { applyEnter, openClipEditor, resolveEnter } from "../state/focus-model";
import { capturePointer } from "../input/capture-pointer";

/**
 * The infinite canvas: multiple frames (artboards), Figma-grade interactions.
 *
 *  select (V): click/drag layers · marquee on empty space · ⌥drag duplicates
 *              corner handles resize · frame labels select/move frames
 *  hand (H):   pan (middle mouse pans in any tool; right-click = context menu)
 *  text (T):   click a frame to place a text layer (click text to edit it)
 *  frame (F):  drag to draw an artboard (click = default size), live W×H
 *
 * Rendering is dirty-flagged: when nothing changed and playback is stopped,
 * the rAF loop exits immediately — idle costs nothing.
 */

/**
 * How long after the playhead last moved the stage still counts as SCRUBBING.
 *
 * The transport rule for motion blur is deliberately the opposite of the naive
 * one: full quality when PARKED — that is where you judge the look, and it
 * costs one render the stage was doing anyway — the cheap tier while playing,
 * where smear detail is imperceptible at frame rate, and nothing at all while
 * scrubbing, which is navigation rather than evaluation.
 *
 * Kept short. This is the delay between letting go of the playhead and seeing
 * the real picture, so it wants to be long enough that a drag never stutters
 * and short enough that the settle reads as instant.
 */
/**
 * How many cached frames must lie ahead before playback over LIVE footage
 * switches to reading the cache. See `cachedRunAhead`: a cached frame is the
 * exact picture and a live one is wherever the element's own clock has got to,
 * so the picture may change source only at the edge of a run — never flicker
 * between the two frame by frame, which is the frame jumping back and forth.
 */
const CACHE_RUN_ENTRY_FRAMES = 6;

const SCRUB_SETTLE_MS = 90;

/** Longest a parked stage holds its frame waiting for a video seek to land. */
const SETTLE_WAIT_MS = 400;

/** Longest a single step holds its frame for the next one's seek. */
const STEP_WAIT_MS = 60;

/** Longest exact playback holds an instant for its footage (the clock releases at 2s). */
const EXACT_WAIT_MS = 1800;

const FIT_PADDING = 72;
/**
 * Forgiveness around a layer's box when clicking it, in SCREEN px (divided by
 * the zoom before use). Small on purpose: it exists so hairline strokes and
 * 1px-tall shapes stay grabbable, not so a big layer can steal its neighbours'
 * clicks.
 */
const HIT_SLOP_PX = 4;
/** A layout member sized by hand stops filling on the axes it was sized along. */
function releaseFill(clip: { layoutItem: { fillX: boolean; fillY: boolean } }, horiz: boolean, vert: boolean): void {
  if (horiz && clip.layoutItem.fillX) clip.layoutItem = { ...clip.layoutItem, fillX: false };
  if (vert && clip.layoutItem.fillY) clip.layoutItem = { ...clip.layoutItem, fillY: false };
}

/** Grab radius of the pivot crosshair — a touch larger, it is a single point. */
const PIVOT_HIT_PX = 11;
/** How close (screen px) the text tool must be to an outline to write on it. */
const TEXT_PATH_SNAP_PX = 10;

/** World bounds of a set of frames (the page's content) — the one shape both
 *  the mount-time "fit all" and the pan/zoom leash clamp measure against, so
 *  they can never disagree about what "the content" is. */
function contentBoundsOf(frames: Frame[]): AABB | null {
  if (frames.length === 0) return null;
  return unionAABB(frames.map((f) => ({ minX: f.x, minY: f.y, maxX: f.x + f.width, maxY: f.y + f.height })));
}

interface FrameLabelRect {
  frameId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

type GestureMode =
  | "none"
  | "pan"
  | "zoom-drag"
  | "pinch"
  | "marquee"
  | "drag-layers"
  | "resize"
  | "resize-group"
  | "move-pivot"
  | "transform-edge"
  | "skew"
  | "rotate"
  | "crop"
  | "crop-pan"
  | "crop-content"
  | "crop-zoom"
  | "crop-rotate"
  | "drag-frame"
  | "resize-frame"
  | "draw-frame"
  | "draw-shape"
  | "draw-text"
  | "radius-drag"
  | "shape-handle"
  | "shape-corner"
  | "gradient-handle"
  | "guide-move"
  | "motion-anchor"
  | "motion-handle"
  | "motion-bend"
  /** Sliding a text along the outline it rides (`text-path-chrome.ts`). */
  | "path-slide"
  /** Dragging a container's gap / padding pill (`layout-chrome.ts`). */
  | "layout-handle"
  /** Carrying a member to a new place in its container's flow. */
  | "layout-reorder";

type RadiusCorner = "tl" | "tr" | "br" | "bl" | "all";

/** The eight crop-overlay handles (four edges + four corners). */
type CropSide = "n" | "s" | "e" | "w" | "nw" | "ne" | "se" | "sw";

/**
 * Which DOCUMENT crop inset each VISUAL side of the crop box edits. A mirrored
 * layer (negative scale) renders its content flipped, so the box's LEFT edge is
 * the media's `right` inset. Mapped once, in `cropGeom`, so the hit-test, the
 * overlay and the drag can never disagree about which edge the pointer moved.
 */
interface CropInsetMap {
  w: "left" | "right";
  e: "left" | "right";
  n: "top" | "bottom";
  s: "top" | "bottom";
}
function cropInsetMap(scaleX: number, scaleY: number): CropInsetMap {
  return {
    w: scaleX < 0 ? "right" : "left",
    e: scaleX < 0 ? "left" : "right",
    n: scaleY < 0 ? "bottom" : "top",
    s: scaleY < 0 ? "top" : "bottom",
  };
}

/**
 * The three things a crop drag can move. One union, and every surface that
 * names them — the cursor, the badge, the press, the modifier watcher — reads
 * it, so a fourth verb is a row here rather than four `else if`s.
 */
type CropVerb = "crop-pan" | "crop-content" | "crop-zoom" | "crop-rotate";

const CROP_VERB_LABEL: Record<CropVerb, string> = {
  "crop-pan": "Reframe crop",
  "crop-content": "Move image",
  "crop-zoom": "Resize image",
  "crop-rotate": "Turn image",
};

/** The cursor each verb wears. */
const CROP_VERB_CURSOR: Record<CropVerb, string> = {
  "crop-pan": cursors.move,
  "crop-content": cursors.grab,
  "crop-zoom": resizeCursor(45),
  // Resolved live from the pointer's angle (see `updateCursor`) — this entry is
  // only the fallback when there is no geometry to aim from.
  "crop-rotate": cursors.grab,
};

/** A crop side, as the corner index or edge index it is on `transform-zones`' box order (nw, ne, se, sw). */
const CROP_SIDE_BOX: Record<CropSide, { corner: number } | { edge: number }> = {
  nw: { corner: 0 },
  ne: { corner: 1 },
  se: { corner: 2 },
  sw: { corner: 3 },
  n: { edge: 0 },
  e: { edge: 1 },
  s: { edge: 2 },
  w: { edge: 3 },
};

/** Local (unrotated, clip-space) position of a rect corner. */
const RECT_CORNER_SIGN: Record<Exclude<RadiusCorner, "all">, { x: number; y: number }> = {
  tl: { x: -1, y: -1 },
  tr: { x: 1, y: -1 },
  br: { x: 1, y: 1 },
  bl: { x: -1, y: 1 },
};

/** Grab gap: a radius dot never sits closer than this to its sharp corner ON
 *  SCREEN, so it stays pickable at radius 0 and at any zoom/scale/skew. */
const RADIUS_DOT_GAP_PX = 13;

/**
 * Screen positions of a shape's corner-radius handles (Figma's inset dots).
 *
 * The dot marks the ACTUAL rounding: its anchor is the inner corner of the
 * rounding square in the shape's own space — `radius` in from the corner on each
 * edge — mapped to screen through the ONE skew-aware ShapePose transform, so it
 * hugs the real rounded arc under any rotation / non-uniform scale / shear (the
 * corner it belongs to, not an averaged guess). The ONLY screen-space nudge is a
 * minimum grab gap: if the true anchor lands within `RADIUS_DOT_GAP_PX` of the
 * sharp corner (small or zero radius), it's pushed out to that gap along the
 * corner's real inward direction so it's always visible and grabbable. Rects get
 * one per corner; polygons/stars one on the top vertex.
 */
/**
 * One inset radius dot for a rect-style corner at local sign (sx, sy). Shared by
 * BOTH shapes and box layers (image/video/nested/drawing) — the pose is the only
 * thing that differs, so the dot hugs the real rounded arc under any rotation /
 * non-uniform scale / shear. `hw`/`hh` are the box half-extents in local units.
 */
function radiusDot(
  sx: number,
  sy: number,
  radius: number,
  maxR: number,
  corner: RadiusCorner,
  hw: number,
  hh: number,
  pose: ShapePose,
  view: { scale: number; tx: number; ty: number },
): { corner: RadiusCorner; x: number; y: number } {
  const r = Math.min(Math.max(0, radius), maxR);
  const cs = shapeLocalToScreen(sx * hw, sy * hh, pose, view); // the sharp corner
  const anchor = shapeLocalToScreen(sx * (hw - r), sy * (hh - r), pose, view); // rounding start
  let dx = anchor.x - cs.x;
  let dy = anchor.y - cs.y;
  let dist = Math.hypot(dx, dy);
  if (dist < RADIUS_DOT_GAP_PX) {
    // Too tight to grab — nudge inward along the true direction, or toward the
    // center when the anchor coincides with the corner (radius 0).
    if (dist < 0.5) {
      // radius 0: the arc has no start point to hug. Aim the dot along the SAME
      // inward diagonal a tiny radius would (J·(-signX,-signY)) — not toward the
      // box center, whose direction skews to the long axis on a non-square box
      // and makes the dot snap sideways at exactly 0. `e` stays inside the box so
      // the local sign (hence the direction) never flips.
      const e = Math.min(hw, hh) / 2 || 1;
      const inset = shapeLocalToScreen(sx * (hw - e), sy * (hh - e), pose, view);
      dx = inset.x - cs.x;
      dy = inset.y - cs.y;
      dist = Math.hypot(dx, dy) || 1;
    }
    const k = RADIUS_DOT_GAP_PX / dist;
    return { corner, x: cs.x + dx * k, y: cs.y + dy * k };
  }
  return { corner, x: anchor.x, y: anchor.y };
}

/** The four per-corner radius dots for a rect box (a rect shape OR a box layer).
 *  Hidden when the box is too small on screen to place grabbable dots. */
function rectRadiusHandles(
  width: number,
  height: number,
  cornerRadius: CornerRadius,
  pose: ShapePose,
  view: { scale: number; tx: number; ty: number },
): Array<{ corner: RadiusCorner; x: number; y: number }> {
  if (Math.min(width * pose.sx, height * pose.sy) * view.scale < 48) return [];
  const hw = width / 2;
  const hh = height / 2;
  const maxR = Math.min(hw, hh);
  return (Object.keys(RECT_CORNER_SIGN) as Array<Exclude<RadiusCorner, "all">>).map((corner) => {
    const s = RECT_CORNER_SIGN[corner];
    return radiusDot(s.x, s.y, cornerRadius[corner], maxR, corner, hw, hh, pose, view);
  });
}

function shapeRadiusHandles(
  geo: ResolvedShapeGeometry,
  pose: ShapePose,
  view: { scale: number; tx: number; ty: number },
): Array<{ corner: RadiusCorner; x: number; y: number }> {
  if (geo.shape === "ellipse") return [];
  if (Math.min(geo.width * pose.sx, geo.height * pose.sy) * view.scale < 48) return [];
  if (geo.shape === "rect") return rectRadiusHandles(geo.width, geo.height, geo.cornerRadius, pose, view);
  // Polygon/star round every vertex uniformly — one dot on the top vertex. Its
  // travel caps at maxCornerRadiusForShape so the handle reaches the end exactly
  // when the shape becomes a circle.
  return [radiusDot(0, -1, geo.radius, maxCornerRadiusForShape(geo), "all", geo.width / 2, geo.height / 2, pose, view)];
}

/** Box layers that round like a rectangle — they get the SAME corner dots as a
 *  rect shape (image/video/nested/drawing), driven by `borderRadius`. */
const BOX_RADIUS_KINDS: ReadonlySet<Clip["kind"]> = new Set(["image", "video", "nested", "raster"]);

/** A box layer as a rect radius target (geometry + world pose + sampled radii),
 *  or null if it isn't a rounding box. THE one seam box handles/hit-test/drag
 *  read, mirroring `shapeGeoFor`/`shapePoseFor` for shapes. */
function boxRadiusTarget(
  clip: Clip,
  doc: MotionDocument,
  playhead: number,
): { width: number; height: number; cornerRadius: CornerRadius; pose: ShapePose } | null {
  if (!BOX_RADIUS_KINDS.has(clip.kind)) return null;
  const frame = doc.frames.find((f) => f.id === clip.frameId);
  if (!frame) return null;
  const local = clipLocalClamped(clip, playhead);
  const p = clipPose(clip, local);
  const size = clipBox(doc, clip);
  const naturalPose = worldPoseOf(doc, clip, frame, p, size);
  const boxed = clip as Extract<Clip, { borderRadius: CornerRadius }>;
  const kf = sampleKeyframes(clip.keyframes, local);
  const n = (k: string, d: number) => (typeof kf[k] === "number" ? (kf[k] as number) : d);
  // CROP-SAFE: the renderer rounds the CROPPED box (withBoxClip), so the handles
  // ride it too. `cropWindow` is that same visible rect — core's one answer, the
  // one the painter and both render buffers read — and the pose is re-centred on
  // it so radius dots + drag stay glued to the real corners.
  const win = cropWindow(
    {
      top: n("crop.top", boxed.crop.top),
      right: n("crop.right", boxed.crop.right),
      bottom: n("crop.bottom", boxed.crop.bottom),
      left: n("crop.left", boxed.crop.left),
    },
    size,
  );
  const world = shapeLocalToWorldPt(win.cx, win.cy, naturalPose);
  // INVARIANT: a ShapePose's offsets are measured from `ox/oy` through the layer
  // map, which subtracts the pivot. Re-centring `ox/oy` on the crop box already
  // consumed that subtraction — leaving the real pivot on the pose would apply
  // it a SECOND time and slide every radius dot by the pivot's displacement
  // (invisible while the pivot is centred, since the shift is then zero). The
  // re-centred pose is therefore centre-anchored on the CROPPED box by
  // definition: offsets from here are offsets from the visible rect's middle.
  const pose: ShapePose = {
    ...naturalPose,
    ox: world.x,
    oy: world.y,
    anchor: CENTER_ANCHOR,
    size: { width: win.width, height: win.height, cx: 0, cy: 0 },
  };
  const base = boxed.borderRadius;
  const u = (c: keyof CornerRadius) => n(`borderRadius.${c}`, n("borderRadius", base[c]));
  return { width: win.width, height: win.height, cornerRadius: { tl: u("tl"), tr: u("tr"), br: u("br"), bl: u("bl") }, pose };
}

/**
 * How far a local point sits INWARD from a shape's corner along the rounding —
 * the scalar a radius drag reads. For a rect corner it's the tighter of the two
 * edge insets (radius is bounded by both); for a polygon/star it's the drop from
 * the top vertex. Shared by the drag's grab baseline and its live delta so they
 * measure the exact same quantity (skew-corrected, since `l` is unsheared).
 */
function cornerInward(
  geo: { shape: string; width: number; height: number },
  corner: RadiusCorner,
  l: { x: number; y: number },
): number {
  const hh = geo.height / 2;
  if (geo.shape !== "rect") return l.y + hh;
  const sign = RECT_CORNER_SIGN[corner === "all" ? "tl" : corner];
  return Math.min(geo.width / 2 - sign.x * l.x, hh - sign.y * l.y);
}

/**
 * Kinds of on-canvas shape control (beyond corner radius). One tag per gesture;
 * adding a new shape affordance is one entry in `shapeControlHandles` + one arm
 * of the `shape-handle` drag — the whole vocabulary lives in those two places.
 */
type ShapeHandleKind = "arc-sweep" | "arc-start" | "arc-ratio" | "star-inner";
interface ShapeHandle {
  kind: ShapeHandleKind;
  x: number;
  y: number;
}

/**
 * A shape's world placement: its transform ORIGIN (center) in world, per-axis
 * scale, and rotation. Handles map from the shape's own base-unit local space
 * through this — NOT through the selection box (which now hugs the geometry
 * bounds and would drift once corners are pushed out). One source of truth for
 * where a local point lands on screen; every shape affordance reuses it.
 */
interface ShapePose {
  /** World position of the shape's PIVOT (its transform origin). */
  ox: number;
  oy: number;
  sx: number;
  sy: number;
  rot: number;
  /** Pseudo-3D shear (deg) — the K in T·R·K·S, so every shape affordance rides it. */
  skewX: number;
  skewY: number;
  /** Normalized pivot + the box it is a fraction of — see core `transform-map`. */
  anchor: AnchorPoint;
  size: LayerBox;
}

/**
 * A LAYER'S POSE IN WORLD — the one mapping every on-canvas control reads.
 *
 * `transform.x/y` is measured from the centre of the layer's own comp, and
 * where that centre IS in world is the comp's chain (`frameSpace`), never its
 * page coordinates. A frame reached by drilling — a flipbook cell's drawing
 * above all — lives on the internal shelf with an `x`/`y` nothing paints at, so
 * `frame.x + frame.width / 2` put the corner-radius dots and the shape handles
 * hundreds of units from the artwork while the selection box, which reads the
 * renderer's own hit rects, sat correctly around it.
 *
 * The chain's own scale and rotation fold in too, so a handle inside a scaled
 * or rotated comp is the size and angle it looks, not the size and angle the
 * layer happens to carry.
 */
/** Apply a matrix's LINEAR part to a delta — a vector has no origin to translate. */
function applyLinear(m: Mat2D, d: { x: number; y: number }): { x: number; y: number } {
  return { x: m.a * d.x + m.c * d.y, y: m.b * d.x + m.d * d.y };
}

function worldPoseOf(
  doc: MotionDocument,
  clip: Clip,
  frame: Frame,
  pose: { x: number; y: number; scale: number; scaleY: number; rotation: number; skewX: number; skewY: number; anchor: AnchorPoint },
  size: LayerBox,
): ShapePose {
  // THE GROUP CHAIN, first. A layer's `transform.x/y` is where it sits in its
  // comp BEFORE any group it belongs to has moved, turned or scaled the lot —
  // so a grouped layer's real position is its own, carried through every
  // enclosing group's delta (core `groupChainMatrix`).
  //
  // Leaving it out is why the handles and the selection box have always
  // disagreed inside a group: the box comes from the renderer's hit rects,
  // which DO go through the chain, and everything drawn beside it came through
  // here, which did not. Identity for an ungrouped layer, so nothing branches.
  const space = layerSpace(clip.id, doc);
  const o = space
    ? space.toWorld({ x: pose.x, y: pose.y })
    : { x: frame.x + frame.width / 2 + pose.x, y: frame.y + frame.height / 2 + pose.y };
  const place = layerPlacement(clip.id, doc);
  return {
    ox: o.x,
    oy: o.y,
    sx: pose.scale * place.scaleX,
    sy: pose.scaleY * place.scaleY,
    rot: pose.rotation + place.rotation,
    skewX: pose.skewX,
    skewY: pose.skewY,
    anchor: pose.anchor,
    size,
  };
}

/** Build a shape's world placement from its sampled pose at the playhead. */
function shapePoseOf(clip: ShapeClip, doc: MotionDocument, frame: Frame, playhead: number): ShapePose {
  const local = clipLocalClamped(clip, playhead);
  const pose = clipPose(clip, local);
  return worldPoseOf(doc, clip, frame, pose, { ...shapeSizeAt(clip, local), cx: 0, cy: 0 });
}

/** Base-unit local (lx, ly) → WORLD, through the ONE core layer map. */
function shapeLocalToWorldPt(lx: number, ly: number, pose: ShapePose): { x: number; y: number } {
  const d = mapLocal(lx, ly, {
    scale: pose.sx,
    scaleY: pose.sy,
    rotation: pose.rot,
    skewX: pose.skewX,
    skewY: pose.skewY,
    anchor: pose.anchor,
    size: pose.size,
  });
  return { x: pose.ox + d.x, y: pose.oy + d.y };
}

/** Map a base-unit local point (lx, ly) to screen through a shape's placement. */
function shapeLocalToScreen(
  lx: number,
  ly: number,
  pose: ShapePose,
  view: { scale: number; tx: number; ty: number },
): { x: number; y: number } {
  const w = shapeLocalToWorldPt(lx, ly, pose);
  return { x: view.tx + w.x * view.scale, y: view.ty + w.y * view.scale };
}

/**
 * THE per-shape direct-manipulation handles (Figma): an ellipse's arc sweep /
 * start / ratio, a star's spike depth. Positions in screen space, derived from
 * the shape's own parametric space so they ride the layer's scale/rotation.
 * The ellipse's local point at param angle θ, radius fraction f, is
 * (rx·f·cosθ, ry·f·sinθ) — the same basis the geometry compiler uses.
 */
function shapeControlHandles(
  geo: ResolvedShapeGeometry,
  pose: ShapePose,
  view: { scale: number; tx: number; ty: number },
): ShapeHandle[] {
  if (Math.min(geo.width * pose.sx, geo.height * pose.sy) * view.scale < 40) return [];
  const rx = geo.width / 2;
  const ry = geo.height / 2;
  const pt = (theta: number, f: number) =>
    shapeLocalToScreen(rx * f * Math.cos(theta), ry * f * Math.sin(theta), pose, view);
  const out: ShapeHandle[] = [];
  if (geo.shape === "ellipse") {
    const start = (geo.arcStartDeg * Math.PI) / 180;
    const sweepRad = (geo.arcSweepDeg * Math.PI) / 180;
    const partial = geo.arcSweepDeg < 359.999;
    out.push({ kind: "arc-sweep", ...pt(start + sweepRad, 1) });
    if (partial) out.push({ kind: "arc-start", ...pt(start, 1) });
    // Ratio dot at the sweep's midpoint, on the inner edge (grabbable at 0).
    out.push({ kind: "arc-ratio", ...pt(start + sweepRad / 2, Math.max(0.001, geo.arcRatio)) });
  } else if (geo.shape === "star") {
    const n = Math.max(3, Math.round(geo.pointCount));
    out.push({ kind: "star-inner", ...pt(-Math.PI / 2 + Math.PI / n, geo.innerRatio) });
  }
  return out;
}

/** Screen positions of a shape's editable corner points (rect/polygon/star). */
function shapeCornerScreens(
  geo: ResolvedShapeGeometry,
  pose: ShapePose,
  view: { scale: number; tx: number; ty: number },
): Array<{ x: number; y: number }> {
  return shapeCornerPoints(geo).map((p) => shapeLocalToScreen(p.x, p.y, pose, view));
}

/** Base-unit local → WORLD (the world half of shapeLocalToScreen). Lets a
 *  shape's own corners seed the node-to-node snap engine, same as path nodes. */
function shapeLocalToWorld(lx: number, ly: number, pose: ShapePose): { x: number; y: number } {
  return shapeLocalToWorldPt(lx, ly, pose);
}

/** Inverse of shapeLocalToScreen: a world point back into base-unit local space
 *  (undo translate → rotate → shear → scale, exactly reversing T·R·K·S). */
function worldToShapeLocal(
  world: { x: number; y: number },
  pose: ShapePose,
): { x: number; y: number } {
  const rot = (-pose.rot * Math.PI) / 180;
  const dx = world.x - pose.ox;
  const dy = world.y - pose.oy;
  const rx = dx * Math.cos(rot) - dy * Math.sin(rot);
  const ry = dx * Math.sin(rot) + dy * Math.cos(rot);
  const u = unshearPoint(rx, ry, pose.skewX, pose.skewY);
  // Inverse of `shapeLocalToWorldPt`: undo the scale (sign-preserving, so a
  // MIRRORED shape maps back to the local point you actually grabbed), then add
  // the pivot back — local coords are measured from the box centre, not the pivot.
  const a = anchorLocal(pose.anchor, pose.size);
  return {
    x: u.x / clampScale(pose.sx, 0.0001) + a.x,
    y: u.y / clampScale(pose.sy, 0.0001) + a.y,
  };
}

/** The clip's param-space angle (deg) and radius fraction under a world point. */
function ellipseParamAt(
  world: { x: number; y: number },
  geo: ResolvedShapeGeometry,
  pose: ShapePose,
): { deg: number; frac: number } {
  const l = worldToShapeLocal(world, pose);
  const nx = l.x / Math.max(1, geo.width / 2);
  const ny = l.y / Math.max(1, geo.height / 2);
  return { deg: (Math.atan2(ny, nx) * 180) / Math.PI, frac: Math.hypot(nx, ny) };
}

type FrameHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** Shared empty corner selection — no allocation per frame in the draw loop. */
const EMPTY_CORNERS: ReadonlySet<number> = new Set<number>();

/** The families a document draws — asked only when a font lands, memoised per snapshot. */
const familiesMemo = new WeakMap<MotionDocument, string[]>();
function documentFamilies(doc: MotionDocument): string[] {
  let hit = familiesMemo.get(doc);
  if (!hit) familiesMemo.set(doc, (hit = [...new Set(documentFontUsage(doc).map((u) => u.family))]));
  return hit;
}

const FRAME_HANDLES: FrameHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function frameHandleCenter(
  f: { x: number; y: number; width: number; height: number },
  handle: FrameHandle,
  view: { scale: number; tx: number; ty: number },
): { x: number; y: number } {
  const x0 = view.tx + f.x * view.scale;
  const y0 = view.ty + f.y * view.scale;
  const x1 = x0 + f.width * view.scale;
  const y1 = y0 + f.height * view.scale;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  switch (handle) {
    case "nw": return { x: x0, y: y0 };
    case "n": return { x: cx, y: y0 };
    case "ne": return { x: x1, y: y0 };
    case "e": return { x: x1, y: cy };
    case "se": return { x: x1, y: y1 };
    case "s": return { x: cx, y: y1 };
    case "sw": return { x: x0, y: y1 };
    case "w": return { x: x0, y: cy };
  }
}

const HANDLE_CURSOR: Record<FrameHandle, string> = {
  nw: resizeCursor(45),
  se: resizeCursor(45),
  ne: resizeCursor(135),
  sw: resizeCursor(135),
  n: resizeCursor(90),
  s: resizeCursor(90),
  e: resizeCursor(0),
  w: resizeCursor(0),
};

// Selection-handle order (matches selectionHandleCenters): nw, ne, se, sw.
// Each carries a unit diagonal — the *corner identity*, not the box aspect —
// so a wide-and-short text layer still gets a real 45° corner cursor instead
// of collapsing toward ew/ns. Rotating this unit vector by the clip's angle
// then turns the cursor with the object, exactly like Figma.
const CORNER_DIRS = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
] as const;

// Edge identities in the same order the corners connect (nw→ne top, ne→se
// right, se→sw bottom, sw→nw left) — one sign component is 0 (single-axis).
const EDGE_DIRS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
] as const;

/** How close (screen px) the pointer must be to a selection edge to resize it. */
const EDGE_HIT_PX = 6;

/**
 * A shape tool → the parametric shape it draws + its starting vertex count.
 * Triangle is a polygon(3), so it reuses the ENTIRE polygon pipeline (render,
 * handles, corner-edit, inspector) — the tool is just a friendlier door to it.
 */
const SHAPE_TOOL_GEOMETRY: Record<ShapeTool, { shape: ShapeKind; pointCount: number }> = {
  rect: { shape: "rect", pointCount: 3 },
  ellipse: { shape: "ellipse", pointCount: 3 },
  triangle: { shape: "polygon", pointCount: 3 },
  polygon: { shape: "polygon", pointCount: 5 },
  star: { shape: "star", pointCount: 5 },
};

/** Shortest distance from point p to segment a–b (screen space). */
function distToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/**
 * The stage's view of the navigation: ONE resolved `EditContext` per read, from
 * the one canonical path. Every stage question — what to paint, what to dim,
 * where an inner layer's hit rect goes, which frame conducts audio — is a field
 * on this object rather than a bespoke re-derivation, which is what let the old
 * code disagree with itself about whether the playhead meant root time or
 * target time.
 */
function stageContext(doc: MotionDocument, session: StageNav): EditContext | null {
  return contextOf(doc, session.nav, session.playheadMs);
}

/**
 * The context of ONE CLIP — resolved from the clip, not from `nav`.
 *
 * A layer inside a nested comp can now be selected without navigating into it,
 * so "which space does this transform live in" is a question about the CLIP.
 * Reading it off the navigation instead was correct only while the two could
 * not differ: drag a piece of artwork selected from the Layers panel and it
 * would move by the parent's scale, drifting further from the cursor the more
 * the comp was scaled. Falls back to the stage's own context for a clip that
 * cannot be placed, which is exactly the old behaviour.
 */
function clipContext(doc: MotionDocument, session: StageNav, clipId: string): EditContext | null {
  return (
    resolveClipContext(doc, session.nav.path, session.playheadMs, clipId)?.ctx ??
    stageContext(doc, session)
  );
}

interface StageNav {
  nav: NavState;
  playheadMs: number;
  activePageId: string | null;
  activeFrameId: string | null;
}

/**
 * The frames the canvas shows.
 *
 * At the top level: every frame on the active page (Figma). Source comps never
 * appear — they live off-page on the internal shelf, reachable only by entering
 * the thing that owns them, so a flipbook's forty cell drawings can no longer
 * show up as forty stray artboards called "Frame 7".
 *
 * While DRILLED IN (any depth, any kind — a component, a nested comp, a
 * drawing surface, a flipbook cell): the whole working page stays visible and
 * live. You edit the child's layers exactly where its instance is painted, so
 * the scene around it must keep rendering — that IS the context you're editing
 * against. The target's own definition frame is excluded (a legacy master
 * sitting on the page must not paint or emit hit rects twice).
 *
 * There is no second mode. Painting a drilled target on its own, at its own
 * shelf coordinates, is what produced a live area sitting off to the side of
 * the artwork — and every tool that measured against it drew into thin air.
 */
function framesInView(doc: MotionDocument, session: StageNav): Frame[] {
  const ctx = stageContext(doc, session);
  if (ctx && ctx.depth > 0) {
    const pageId = pageOfFrame(doc, ctx.root);
    return doc.frames.filter(
      (x) => pageOfFrame(doc, x) === pageId && x.id !== ctx.target.id && !compOwnerNested(doc, x.id),
    );
  }
  // The virtual Components view aggregates every component frame wherever it
  // actually lives — no relocation, no duplication (see COMPONENTS_VIEW_ID).
  if (isComponentsView(session.activePageId)) return componentFrames(doc);
  const pageId = session.activePageId ?? doc.pages[0]!.id;
  return doc.frames.filter((x) => pageOfFrame(doc, x) === pageId && !compOwnerNested(doc, x.id));
}

/**
 * ISOLATION (Illustrator "enter isolation"). While inside anything, exactly one
 * frame stays lit and interactive; everything else fades and locks, so a stray
 * click can't yank you out of context. The context already knows which frame
 * that is — the ROOT for an in-place edit (it paints the picture you're
 * editing), the target when isolated — so render, hit-testing and selection
 * read one value instead of three guesses.
 */
function isolationFocusId(doc: MotionDocument, session: StageNav): string | null {
  return stageContext(doc, session)?.isolationFrameId ?? null;
}

/**
 * HOW LOUDLY THIS FRAME'S SPILL SHOWS, right now.
 *
 * The frame's stored `overflow` — but only while this is the frame you are
 * working in: the comp you have drilled into, or (at the top level) the one
 * whose layer is selected, or the artboard you have selected outright. Every
 * other frame on the page is clipped, because a page where every comp shows
 * everything it has ever been handed is a page nobody can read.
 *
 * A VIEW rule, deliberately here and not in the document: which frame you are
 * looking at is not a property of the artwork.
 */
/**
 * Whether a selected clip in `compId` ends exactly at `atMs` — the one case
 * where the parked picture differs from what the frame cache holds for that
 * instant (the cache is built by playback, which never owns a cut).
 */
function selectionOwnsCut(
  doc: MotionDocument,
  clipEnds: ReadonlySet<string> | null,
  compId: string | null,
  atMs: number,
): boolean {
  if (!clipEnds || !compId) return false;
  for (const id of clipEnds) {
    const clip = locateClip(doc, id)?.clip;
    if (clip && clip.frameId === compId && Math.abs(clip.startMs + clip.durationMs - atMs) < 0.001) return true;
  }
  return false;
}

function spillOpacity(frame: Frame, doc: MotionDocument, session: StageNav, selected: readonly string[]): number {
  if (frame.overflow <= 0) return 0;
  const ctx = stageContext(doc, session);
  // Drilled in, the spill belongs to the TARGET and is painted by the frame
  // that actually puts pixels on the page — the root of the chain.
  if (ctx && ctx.depth > 0) return frame.id === ctx.root.id ? ctx.target.overflow : 0;
  if (session.activeFrameId === frame.id) return frame.overflow;
  if (selected.some((id) => locateClip(doc, id)?.clip.frameId === frame.id)) return frame.overflow;
  return 0;
}

/** Is a world point inside the area you're currently editing? */
function insideEditContext(doc: MotionDocument, session: StageNav, p: { x: number; y: number }): boolean {
  const ctx = stageContext(doc, session);
  if (!ctx || ctx.depth === 0) return true;
  return containsWorldPoint(ctx, p);
}

/**
 * Re-anchor hit rects measured in the target's own local space onto the stage,
 * through the cumulative instance pose — so a click lands on the inner layer
 * exactly where it is painted, however deep the nesting.
 */
function placeMeasuredHits(measured: ClipHitRect[], ctx: EditContext): ClipHitRect[] {
  return measured.map((h) => {
    const p = applyMat(ctx.matrix, { x: h.cx, y: h.cy });
    return {
      ...h,
      cx: p.x,
      cy: p.y,
      width: h.width * ctx.scaleX,
      height: h.height * ctx.scaleY,
      rotation: h.rotation + ctx.rotation,
    };
  });
}

/**
 * Live canvas placeholder for a library drag hovering the STAGE: a modern dashed
 * box at the cursor showing exactly where — and how big — the clip will land,
 * sized like the real drop (fit within the frame under the cursor, centered on
 * the pointer). Purely derived from the ephemeral drag session state; nothing is
 * created until release. The timeline half (clip at the playhead) is drawn by
 * `MediaDropGhost`, so a stage drop previews both at once. Renders nothing for
 * audio (no on-canvas footprint) or non-visual kinds.
 */
function LibraryDropStageGhost() {
  // Follows a drag the browser reports outside React, reading the live stores
  // every render by design. Memoising it would pin the ghost.
  "use no memo";
  const drag = useSession((s) => s.libraryDrag);
  const pos = useSession((s) => s.libraryDragPos);
  const scale = useStageView((v) => v.scale);
  const tx = useStageView((v) => v.tx);
  const ty = useStageView((v) => v.ty);
  const doc = useDoc();

  if (!drag || pos?.over !== "stage") return null;
  const asset = drag.kind === "media" ? doc.assets.find((a) => a.id === drag.id) : undefined;
  const isVisualMedia = asset?.kind === "image" || asset?.kind === "video";
  // Only things that CREATE get a drop outline. An animation modifies the layer
  // under the cursor, so a ghost box promising a new one would be a lie.
  const isTextPreset = drag.kind === "template";
  // A snapshot's footprint is the union of the clips it will place — the same
  // arithmetic the drop uses, so the box is exactly where the artwork lands.
  const snapshot = drag.kind === "snapshot" ? resolveDragSnapshot(drag.id) : null;
  const footprint = snapshot ? snapshotBounds(doc, snapshot.snapshot) : null;
  if (!isVisualMedia && !isTextPreset && !footprint) return null;

  const el = typeof document !== "undefined" ? document.querySelector("[data-stage-drop]") : null;
  const rect = el?.getBoundingClientRect();
  if (!rect) return null;

  // Cursor in container-local screen space, and the world point it maps to — the
  // same transform Stage's own `toWorld` uses (world = (local − t) / scale).
  const localX = pos.x - rect.left;
  const localY = pos.y - rect.top;
  const worldX = (localX - tx) / scale;
  const worldY = (localY - ty) / scale;

  // Frame under the cursor drives the fit size, exactly like the real drop.
  const session = useSession.getState();
  const frames = framesInView(doc, session);
  const standing = standingFrameId(doc);
  const frame = standing
    ? doc.frames.find((f) => f.id === standing)
    : (frames.find((f) => worldX >= f.x && worldX <= f.x + f.width && worldY >= f.y && worldY <= f.y + f.height) ??
      frames.find((f) => f.id === session.activeFrameId) ??
      frames[0]);
  if (!frame) return null;

  // World box the clip will occupy (image/video fit ≤90% of the frame, never
  // upscaled — matches `fitScale`; text preset gets a sensible insertion box;
  // a snapshot is its own footprint, centred where its clips are centred).
  let boxW: number, boxH: number;
  let boxCx = 0, boxCy = 0;
  if (isVisualMedia) {
    const aw = asset!.width ?? 512;
    const ah = asset!.height ?? 512;
    const fit = Math.min(1, (frame.width * 0.9) / aw, (frame.height * 0.9) / ah);
    boxW = aw * fit;
    boxH = ah * fit;
  } else if (footprint) {
    boxW = Math.max(8, footprint.maxX - footprint.minX);
    boxH = Math.max(8, footprint.maxY - footprint.minY);
    boxCx = (footprint.minX + footprint.maxX) / 2;
    boxCy = (footprint.minY + footprint.maxY) / 2;
  } else {
    boxW = Math.min(frame.width * 0.6, 480);
    boxH = 96;
  }
  const screenW = boxW * scale;
  const screenH = boxH * scale;
  const preview = drag.kind === "snapshot" ? drag.preview : undefined;

  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
      <div
        className="absolute rounded-xl border-2 border-dashed border-primary/80 bg-primary/10 shadow-lg shadow-primary/20 backdrop-blur-[1px] transition-[width,height] duration-100 ease-out"
        style={{
          left: localX + boxCx * scale - screenW / 2,
          top: localY + boxCy * scale - screenH / 2,
          width: screenW,
          height: screenH,
        }}
      >
        {/* The artwork itself, at the size it will land — a REAL preview, not a
            box that promises one. */}
        {preview && <DragPreviewArt preview={preview} className="absolute inset-0 size-full" />}
        {/* Corner label pill — reads as a Figma-style drop affordance. */}
        <div className="absolute -top-6 left-0 flex max-w-full items-center gap-1 rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground shadow-sm">
          <span aria-hidden className="text-primary-foreground/80">+</span>
          <span className="truncate">{drag.label}</span>
        </div>
      </div>
    </div>
  );
}

/** Session keys only the timeline draws — a change to these alone never repaints the canvas. */
const TIMELINE_ONLY = new Set<string>(["snapIndicatorMs", "selectedPoseBlocks"]);

/** What a parked tick may spend sharpening layers after a zoom — see `DrawOptions.settle`. */
const SETTLE_BUDGET_MS = 24;
/** Idle ticks (nothing dirty, nothing timed pending) before the render loop parks — half a second of slack. */
const PARK_AFTER_TICKS = 30;
/** What a live frame may spend making missing comp pictures beyond its first — see `DrawOptions.pictureFill`. */
const PICTURE_FILL_MS = 12;
/** How long the camera must be still before layers sharpen to the new zoom. */
const SHARPEN_AFTER_MS = 160;

export function Stage() {
  const doc = useDoc();
  const store = useDocStore();
  /**
   * THE DOCUMENT AS IT LOOKS, right now — every driven property baked into the
   * clip's own slot. Every GEOMETRY read on this surface goes through it: what
   * the canvas paints, where the hit rectangles land, where the resize handles
   * and corner-radius grips sit. Writes go to the raw store underneath, because
   * you edit the value beneath a driver, never the driven result.
   *
   * The same call the renderer makes, so the two share one cached resolution and
   * cannot disagree about where a layer is — which is exactly how a driven shape
   * used to move while its own handles stayed behind.
   */
  const visualState = React.useCallback((): MotionDocument => {
    const raw = store.getState();
    const session = useSession.getState();
    return resolvedDocAt(raw, session.playheadMs, activeCompId(raw, session.activeFrameId), session.playing);
  }, [store]);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const hitRectsRef = React.useRef<ClipHitRect[]>([]);
  /**
   * A clip's hit rect for GIZMOS/handles — prefers the rect painted by the frame
   * you're editing in (`activeFrameId`). A shared instance clip is painted once
   * per instance frame; this makes handles land on the one you clicked instead
   * of an arbitrary sibling/master.
   */
  const activeHit = React.useCallback((clipId: string): ClipHitRect | undefined => {
    const rects = hitRectsRef.current;
    const host = useSession.getState().activeFrameId;
    return rects.find((h) => h.clipId === clipId && h.hostFrameId === host) ?? rects.find((h) => h.clipId === clipId);
  }, []);
  /** Tiny offscreen canvas for the in-place component-edit hit-measure pass. */
  const measureCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  /** The motion-path scene from the last paint — the gesture handlers' hit model. */
  const motionSceneRef = React.useRef<MotionScene | null>(null);
  /**
   * THE PAINTED CLOCK: comp time each frame was drawn at on the last paint.
   *
   * A gizmo sits beside a PICTURE, not beside the store. During playback the
   * canvas advances on the playback clock while `session.playheadMs`
   * deliberately does not re-render React, so any handle re-derived from the
   * store is posed at a stale time — which is roundness dots trailing a
   * transform box that reads the painted hit rect, and the same lag on every
   * other affordance that samples a pose itself. It is per FRAME because a clip
   * inside a nested comp is painted at that comp's own mapped time and never at
   * the page playhead. Read it through `paintedTimeFor`.
   */
  const paintTimesRef = React.useRef<Map<string, number>>(new Map());
  /** The clock a gizmo must pose against — see `paintTimesRef`. */
  const paintedTimeFor = React.useCallback(
    (frameId: string): number => paintTimesRef.current.get(frameId) ?? useSession.getState().playheadMs,
    [],
  );
  const labelRectsRef = React.useRef<FrameLabelRect[]>([]);
  const chromeRef = React.useRef<HTMLCanvasElement | null>(null);
  const lastPointerRef = React.useRef({ x: 0, y: 0 });
  /** Last crop verb the cursor reported — repaints the badge only when it flips. */
  const cropVerbRef = React.useRef<CropVerb | null>(null);
  /** The auto layout gap / padding band under the pointer, lit on hover. */
  const layoutHoverRef = React.useRef<LayoutHandle | null>(null);
  /** The link under the pointer while one would follow (⌘ held, or viewing) — drawn as an outline. */
  const linkHoverRef = React.useRef<LinkUnderPoint | null>(null);
  /** A press that belongs to a link: followed on the click, if the pointer did not travel. */
  const linkPressRef = React.useRef<{ x: number; y: number; link: Link; newTab: boolean } | null>(null);
  /** The link markers as last drawn, in stage px — what a press on one hits. */
  const linkMarkersRef = React.useRef<DrawnLinkMarker[]>([]);
  /** Markers are derived from the hit pass; recomputed only when it (or the doc) changes. */
  const linkMarkerCache = React.useRef<{ hits: ClipHitRect[]; doc: MotionDocument; markers: LinkMarker[] } | null>(null);
  /**
   * THE DIRTY FLAG WAKES THE LOOP. The render loop parks itself when nothing
   * is pending (see `PARK_AFTER_TICKS`), so an idle editor runs no frame
   * callback at all — and every one of the many places that set this flag
   * wakes it by setting it, without having to know the loop can sleep.
   */
  const wakeRef = React.useRef<() => void>(() => {});
  const dirtyRef = React.useMemo<React.MutableRefObject<boolean>>(() => {
    let dirty = true;
    return {
      get current() {
        return dirty;
      },
      set current(next: boolean) {
        dirty = next;
        if (next) wakeRef.current();
      },
    };
  }, []);
  /**
   * The caret on a text-on-path is painted by the overlay (the DOM editor has
   * no curve to blink on), so while one is being edited the overlay repaints
   * on the blink's half period. One timer, re-armed by each paint.
   */
  const caretBlinkTimer = React.useRef<number | null>(null);
  const scheduleCaretBlink = () => {
    if (caretBlinkTimer.current != null) return;
    caretBlinkTimer.current = window.setTimeout(() => {
      caretBlinkTimer.current = null;
      dirtyRef.current = true;
    }, 530);
  };
  /** Bumped by everything that changes what a draw would PRODUCE — the camera
   *  raster's staleness check (see `camera-raster.ts`). */
  const contentVersionRef = React.useRef(0);
  /** The comp-space buffer the active comp renders into — see `paintFrame`. */
  const compBufferRef = React.useRef<HTMLCanvasElement | null>(null);
  /** Did the last painted tick blit the camera raster rather than render? */
  const blittedRef = React.useRef(false);
  // ⌘/Ctrl held right now — flips the selection chrome from dashed (native
  // geometry resize) to solid (scale-as-object), live as the key is held.
  const scaleModifierRef = React.useRef(false);
  const refreshCursorRef = React.useRef<(() => void) | null>(null);
  // Smart-guide lines to flash this frame (world coords), set by whichever
  // gesture is snapping and cleared on pointer-up. Rendered as the last chrome.
  const activeGuidesRef = React.useRef<{ v: SnapLine[]; h: SnapLine[] }>({ v: [], h: [] });
  // While ⇧-constraining a layer drag: the locked angle (deg) + its world pivot,
  // so the RAF loop can draw the constraint axis through the selection. Null off.
  const constrainAxisRef = React.useRef<{ angleDeg: number; cx: number; cy: number } | null>(null);
  const fittedRef = React.useRef(false);
  // Double-clicking a frame's name label (above the artboard) renames it
  // inline — Figma's gesture. Scoped locally: only the canvas triggers it.
  const [renamingFrameId, setRenamingFrameId] = React.useState<string | null>(null);
  // The draw loop reads it here: the label under the field is not drawn.
  const renamingFrameRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    renamingFrameRef.current = renamingFrameId;
    dirtyRef.current = true;
  }, [renamingFrameId]);
  const tool = useSession((s) => s.tool);
  // Chrome layout inputs: the rulers eat the top/left edges, and the tool rail's
  // placement decides which slot it occupies (see StageChrome).
  const rulersOn = useSession((s) => s.rulers);
  const toolbarPlacement = useSession((s) => s.toolbarPlacement);

  // Load every FACE the document renders — each with the text drawn in it, so
  // non-Latin subsets (Persian, CJK…) fetch for canvas use rather than the Latin
  // default, and so a weight the OS owns is embedded before it is needed.
  // `documentFontUsage` is the walk; the loaders de-dupe.
  React.useEffect(() => {
    ensureDocumentFaces(doc);
  }, [doc]);

  const fit = React.useCallback((opts?: { onlyIfOffscreen?: boolean }) => {
    const el = containerRef.current;
    if (!el) return;
    const { width: cw, height: ch } = el.getBoundingClientRect();
    if (cw === 0) return;
    const d = store.getState();
    const all = framesInView(d, useSession.getState());
    const bounds = contentBoundsOf(all.length > 0 ? all : d.frames);
    if (!bounds) return;
    // Entering a comp/component you can already see shouldn't yank the camera —
    // the SAME "leave it alone if any part is visible" rule the smart-focus
    // system uses. Only refit when the target content is genuinely off-screen.
    if (opts?.onlyIfOffscreen && isStageBoundsVisible(bounds)) return;
    useStageView.getState().set(fitCamera(bounds, { width: cw, height: ch }, { paddingPx: FIT_PADDING, maxScale: 2 }));
  }, [store]);

  // The scopes read what the stage drew. Registering the canvas (rather than
  // letting them query the DOM for it) means the Color page can never find the
  // wrong one, and costs nothing when nobody is looking — the sampler only runs
  // while something is subscribed. See `stage/frame-sample.ts`.
  React.useEffect(() => registerStageCanvas(canvasRef.current), []);

  // A Layers row hovered → repaint, so its outline appears (D20).
  React.useEffect(
    () =>
      useHoverLink.subscribe((s, prev) => {
        if (s.id !== prev.id) dirtyRef.current = true;
      }),
    [],
  );

  // ── Dirty-flag render loop ──────────────────────────────────────────────────
  React.useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const artCtx = canvas.getContext("2d");
    if (!artCtx) return;
    // CHROME IS NEVER PREVIEW-RESOLUTION. The art canvas's backing store is
    // scaled by the preview tier (¼ of the pixels at ¼), which is right for the
    // artwork and wrong for everything that is the EDITOR — frame titles,
    // guides, handles, the pixel grid. Those draw on this overlay, at the
    // device's full ratio, whatever tier the picture is at.
    const chromeCanvas = chromeRef.current;
    const chromeCtx = chromeCanvas?.getContext("2d") ?? null;

    // TWO KINDS OF DIRTY. `invalidate` means "what a draw would produce has
    // changed"; the camera moving means only "you are standing somewhere else".
    // Keeping them apart is the whole basis of the camera fast path — the
    // content version it checks is bumped here and nowhere else, so a source
    // that forgets to bump simply never gets its pixels reused, which is the
    // safe direction to be wrong in.
    const invalidate = () => {
      dirtyRef.current = true;
      contentVersionRef.current++;
    };
    // The same, for things that arrived from OUTSIDE the document (media,
    // fonts, surfaces, engines): a backdrop painted before they landed is
    // stale even though no clip changed. See `invalidateBackdrops`.
    const invalidateExternal = () => {
      endBoardEpoch();
      invalidateBackdrops();
      invalidate();
      // A font, a surface, a lazily-loaded effect engine: none of them can say
      // which clip they changed, so the honest answer is the whole table.
      endFrameEpoch();
    };
    // A DIFFERENT PROJECT IS A DIFFERENT SET OF PIXELS. Tabs swap the document
    // store, and comp ids from the project you just left can never be served
    // again — they would simply sit in the budget until the LRU noticed. This
    // effect re-runs only when the store changes, so it is the project-switch
    // seam whether or not anyone names it one.
    endFrameEpoch();
    dropBoardPictures();
    let lastDoc = store.getState();
    const unsubs = [
      store.subscribe(() => {
        invalidate();
        // THE RAW DOCUMENT, never the resolved one. A driven document is
        // re-baked at every instant, so diffing the resolved version would
        // report everything as changed forever — and the graphs, expressions
        // and variables that need this cache most would be the only ones that
        // never got it. See `core/preview/frame-cache.ts`.
        const next = store.getState();
        // ONE analysis of where the edit landed, handed to both caches — so the
        // frame cache and the layer cache can never disagree about it. See
        // `core/preview/picture-change.ts`.
        const delta = diffDocumentPicture(lastDoc, next);
        applyDeltaToFrameCache(delta);
        applyDeltaToLayerCache(delta, next);
        lastDoc = next;
      }),
      // Any session change the canvas can show — not the timeline's own state
      // (a snap line flickering under a drag, blocks picked on a pose lane),
      // which would repaint every frame on the board for every pointer move.
      useSession.subscribe((next, prev) => {
        for (const k in next) {
          if (TIMELINE_ONLY.has(k)) continue;
          if (next[k as keyof typeof next] !== prev[k as keyof typeof prev]) return invalidate();
        }
      }),
      useStageView.subscribe(() => {
        dirtyRef.current = true;
      }),
      // WHAT A CLIP SHOWS changed. Only the layers that painted that clip are
      // stale — itself, a group holding it, glass looking through it. The frame
      // cache is not touched at all: it admits only exact pictures, and an
      // exact picture of an instant cannot go stale. `null` is an asset that
      // became drawable for everyone (an image decoding) — rare, and broad.
      onMediaReady((clipId) => {
        // A retained board picture may show this clip's previous frame.
        endBoardEpoch();
        if (clipId) invalidateMediaDependents(clipId);
        else invalidateBackdrops();
        invalidate();
      }),
      // The bytes behind an asset changed (a relink): every picture of it is
      // stale, including the exact ones.
      onMediaSourceChanged(invalidateExternal),
      // Paint surfaces load their persisted pixels async (and undo/redo can
      // rewrite them wholesale) — repaint when they land.
      onSurfaceReady(invalidateExternal),
      // Onion settings / tool options change what the canvas shows.
      // Onion skins and tool options change the picture and are read inside the
      // renderer rather than passed to it, so they cannot appear in the paint
      // signature — the counter is the honest answer for them.
      useDrawing.subscribe(() => {
        invalidate();
        endFrameEpoch();
        endBoardEpoch();
      }),
      // Waveform clips paint a quiet baseline until their audio decodes —
      // repaint the moment the buffer lands.
      onAudioBufferReady(invalidateExternal),
      // A lip-sync track landed: driven mouths change at every instant.
      onSpeechTrack(invalidateExternal),
      // A sound's analysis landed: visualizers, `sound()` and Sound nodes start moving.
      onSoundAnalysis(invalidateExternal),
      // A guide being dragged out of a ruler flashes on the canvas.
      onGuideDraftChange(invalidate),
      // Effect engines are lazy chunks (see `render/passes/registry.ts`). The
      // frame that first mentions a family draws without it; this is what
      // repaints the moment it arrives, exactly as media and paint surfaces do.
      onEffectPassesReady(invalidateExternal),
      onGradePreviewChange(invalidateExternal),
      // The RAM preview build asks for a frame at an instant the playhead is
      // already sitting on, where nothing would otherwise mark the canvas
      // dirty. See `stage-dirty.ts`.
      onStageDirtyRequest(() => {
        dirtyRef.current = true;
      }),
    ];
    const ro = new ResizeObserver(invalidate);
    ro.observe(container);
    let lastFonts = fontsVersion();

    let raf = 0;
    // An idle loop parks instead of asking for frames forever: a frame callback
    // that does nothing still makes the browser run a frame, sixty times a
    // second, on every machine that leaves the editor open.
    let parked = false;
    let idleTicks = 0;
    const wake = () => {
      if (!parked) return;
      parked = false;
      idleTicks = 0;
      raf = requestAnimationFrame(frame);
    };
    wakeRef.current = wake;
    // SCRUB DETECTION. There is no scrubbing flag in the session, and inventing
    // a stored one would be a second field describing a fact the playhead
    // already states: if it moved recently and the transport is not running,
    // you are dragging it. Local to the loop because nothing else needs to know.
    let lastPlayhead = -1;
    let lastPlayheadMoveMs = 0;
    let lastPolicyKey = "";
    let mbPolicy = stagePolicy("off", "idle");
    /** What the PREVIOUS full render cost, and at what rate — the governor's
     *  input for this one. A frame cannot measure itself before it is drawn. */
    let lastFrameCostMs = 0;
    let lastFrameFps = 30;
    /**
     * Is playback reading the frame cache right now? Entered only at the start
     * of a cached run over live footage (see `CACHE_RUN_ENTRY_FRAMES`), left on
     * the first miss. Also what exempts a tick from the render pacer: a blit
     * is not a render, and pacing one drops a frame that costs nothing.
     */
    let cacheRun = false;
    /** The comp frame last drawn while playing a sub-30fps comp. */
    let lastPlayIdx = -1;
    /**
     * The shutter the last RUN rendered with — the motion-blur twin of
     * `playbackTier`. Kept pictures are playback pictures; the variant that
     * names them must not change when you stop, or the ruler goes blank on
     * pause (parked, the auto governor reports a different quality).
     */
    let runShutter: string | null = null;
    /** Live playback's budget for missing comp pictures — see `DrawOptions.pictureFill`. */
    const pictureFill = createPictureFill(PICTURE_FILL_MS);
    /** The paused instant the layer cache's editing working set belongs to. */
    let parkedAt: string | null = null;
    /** When the present-only-settled wait began, or -1. */
    let settleWaitSince = -1;
    /**
     * Auto's ceiling for a run: no sharper than the display shows
     * (`tierForDisplay` — the comp as you see it, zoom × device ratio) and no
     * sharper than the range fits the composite cache's share at
     * (`tierFittingMemory`). Asked when a run begins, never per tick.
     */
    const memoryCap = (needsRange: boolean): PreviewResolution => {
      // FOOTAGE IS NOT DOWNSCALED FOR THE ZOOM. A video drawn into a smaller
      // backing store is cheaper in Chrome and measurably MORE expensive in
      // Firefox (a CPU downscale per frame), so fitting the display is only a
      // saving where there is no footage. Speed and memory still apply.
      const docForCap = store.getState();
      const hasFootage = docForCap.tracks.some((t) => t.clips.some((c) => c.kind === "video"));
      const displayTier = hasFootage
        ? "full"
        : tierForDisplay(useStageView.getState().scale * (window.devicePixelRatio || 1));
      // THE RANGE CAP IS FOR A COMP THAT NEEDS ITS RANGE — one that cannot play
      // live (core `playsLive`). Staying at the tier a range was built at is
      // the session's `openingTier`: a run that needed the cache opens where
      // the last one ran, per comp.
      return needsRange ? minTier(displayTier, rangeFitTier()) : displayTier;
    };
    const rangeFitTier = (): PreviewResolution => {
      const doc = store.getState();
      const comp = activeCompId(doc, useSession.getState().activeFrameId);
      const f = doc.frames.find((x) => x.id === comp);
      if (!f) return "full";
      const range = effectiveWorkRange(f.id);
      const spanMs = range ? range.endMs - range.startMs : timelineEndMs(doc, f.id);
      const frames = Math.ceil(Math.max(0, spanMs) / frameStepMs(compFps(doc, f.id)));
      // Against the PLAYBACK cache's allowance — frames or layers, whichever is on.
      const share = shareOfBudget(framesCacheOn() ? BUDGET_SHARE.composite : BUDGET_SHARE.layers);
      return tierFittingMemory(f.width, f.height, frames, share);
    };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      // The ART context until the scene is painted; the chrome pass swaps it.
      let ctx: CanvasRenderingContext2D = artCtx;
      if (fontsVersion() !== lastFonts) {
        // Only a face the DOCUMENT draws can change a picture. The editor's own
        // chrome (a timecode, the Library's text-look previews) loads faces
        // too, and answering those with a purge is what emptied a just-built
        // cache moments after every pause.
        const changed = fontFamiliesChangedSince(lastFonts);
        lastFonts = fontsVersion();
        if (fontChangeTouches(changed, documentFamilies(store.getState()))) invalidateExternal();
      }

      // ── THE SHUTTER POLICY ────────────────────────────────────────────────
      // Computed ABOVE the dirty gate, and that placement is the whole point.
      //
      // This policy is a function of WALL-CLOCK TIME (the scrub window expires
      // on its own), while the canvas only redraws when something marks it
      // dirty. Below the gate, the sequence was: the playhead moves, one frame
      // draws while still counted as scrubbing — blur off — and then the window
      // lapses with nothing left to trigger a redraw. The unblurred frame sat
      // there until some unrelated event happened to dirty the canvas, which is
      // why pausing, arrow-stepping and releasing a drag all "gained" their blur
      // only once you jiggled the mouse.
      //
      // So the policy is treated exactly like `fontsVersion` above it: anything
      // that changes what a draw would PRODUCE has to be able to request one.
      // A render that varies with time must own its own invalidation.
      const nowMs = performance.now();
      const s0 = useSession.getState();
      if (s0.playheadMs !== lastPlayhead) {
        lastPlayhead = s0.playheadMs;
        lastPlayheadMoveMs = nowMs;
      }
      // A PRE-RENDER IS A PLAYBACK PASS. It exists to produce the frames the
      // transport will play, so every decision that shapes the picture — the
      // shutter policy, the resolution tier, which comps advance — has to be
      // the one playback would make. Treating it as scrubbing produced frames
      // the transport could not use (scrubbing turns motion blur OFF) and, far
      // worse, made the regime FLAP: the loop skips instants it already has, the
      // scrub window lapses, the transport reads "idle", and the change of
      // regime invalidated the very range being built. That is the bar filling
      // and emptying instead of filling.
      const prerendering = s0.prerenderProgress !== null;
      const running = s0.playing || prerendering;
      // A HELD DRAG IS STILL A DRAG. The settle window alone treats a slow or
      // paused scrub as a stop, so the preview flickered between the reduced
      // tier and full quality under your hand — and each flip is a different
      // variant, so it also stopped reading the frames it had just built.
      const scrubbing = !running && (isScrubbingTime() || nowMs - lastPlayheadMoveMs < SCRUB_SETTLE_MS);
      const transport = running ? "playing" : scrubbing ? "scrubbing" : "idle";
      // AN EXACT RUN DECIDES ITS PICTURE ONCE. The governors trade quality for
      // speed frame by frame — and every trade is a different picture: blur
      // switched off while the first frames were slow was kept, then switched
      // back on once cache hits made frames cheap, and every frame after that
      // rendered through the shutter, uncacheable, for the rest of the run.
      // Exact playback's promise is the true frame, not a fast one: the shutter
      // is the export's (Auto → Full) and the tier is the one the run opened at.
      const exactRunNow = running && playbackRegime() === "exact";
      // A HELD DRAG READS WHAT PLAYBACK KEPT. Dragging the playhead over a
      // built stretch is where the cache is most obviously worth having — and
      // it could never hit: a drag rendered at the parked tier with the shutter
      // off, so no key a run had kept ever matched, and every position paid a
      // seek (a backward one re-decodes from the keyframe). A held drag now
      // renders exactly as playback would — its tier, its shutter, its draw
      // options — so a kept instant is a blit and the rest render as a run
      // would. Letting go settles to the full-quality exact frame; an arrow
      // step is still a still frame, exact and uncached.
      const dragReadsKept = !running && isScrubbingTime() && isCachingEnabled();
      const asPlayback = running || dragReadsKept;
      const mbQuality =
        s0.motionBlurQuality === "auto"
          ? exactRunNow || dragReadsKept
            ? "full"
            : s0.motionBlurActual.quality
          : s0.motionBlurQuality;
      if (asPlayback) runShutter = mbQuality;
      const policyKey = `${mbQuality}:${dragReadsKept ? "playing" : transport}`;
      if (policyKey !== lastPolicyKey) {
        lastPolicyKey = policyKey;
        // Rebuilt only on change, so an idle stage allocates nothing per tick.
        mbPolicy = stagePolicy(mbQuality, dragReadsKept ? "playing" : transport);
        invalidate();
      }

      // THE SETTLE RENDER. A blitted tick consumed the dirty flag, and the
      // camera stopping is not an event anybody publishes — so without this the
      // stage would sit on a moved raster until something unrelated happened to
      // dirty it. Same rule as the shutter policy above: a render that varies
      // with WALL-CLOCK time owns its own invalidation.
      if (blittedRef.current && !cameraInMotion(nowMs)) {
        blittedRef.current = false;
        dirtyRef.current = true;
      }


      // A COMP SLOWER THAN ITS FOOTAGE SHOWS ITS OWN RATE. Below 30fps the
      // stage redraws only when the comp frame changes, so a 10fps comp shows
      // 10fps footage rather than the element's own 30. At 30fps and above it
      // draws every display frame — gating there put two equal-rate clocks out
      // of phase and juddered.
      // LIVE ONLY. Exact playback moves the playhead one comp frame at a time
      // already, and it redraws WITHIN a frame when its footage lands — a gate
      // here swallowed that redraw, and the clock waiting on it froze.
      if (dirtyRef.current && s0.playing && !prerendering && playbackRegime() === "live") {
        const doc0 = store.getState();
        const fps0 = compFps(doc0, activeCompId(doc0, s0.activeFrameId));
        if (fps0 < 30) {
          const idx = Math.floor(s0.playheadMs / frameStepMs(fps0));
          if (idx === lastPlayIdx) return;
          lastPlayIdx = idx;
        }
      } else if (!s0.playing) lastPlayIdx = -1;

      if (!dirtyRef.current) {
        // idle → zero work, and soon no ticks: park once nothing that changes
        // with wall-clock time is pending (a scrub settling, the camera
        // settling, a glide, the transport). A dirty write wakes it.
        if (!running && transport === "idle" && !cameraInMotion(nowMs) && !blittedRef.current && !layoutMotionActive(nowMs) && ++idleTicks > PARK_AFTER_TICKS) {
          cancelAnimationFrame(raf);
          parked = true;
        }
        return;
      }
      idleTicks = 0;

      // ── THE RENDER PACER ──────────────────────────────────────────────────
      // A render costing 300ms, run on every dirty tick, holds the main thread
      // at 100% duty: the pointermoves that arrived during it, React, the
      // timeline and the cursor all wait behind it, and the app does not feel
      // slow, it feels broken. The pacer keeps a share of every second free for
      // them (see `render-budget.ts`), so the canvas lags under load and the
      // interface does not stop.
      //
      // The dirty flag STAYS SET — this postpones a render, it does not skip
      // one — which also means skipping coalesces: ten slider positions become
      // one render of the tenth.
      //
      // The two fast paths are excluded because they are already cheap by
      // construction and already have their own deferral: a camera blit costs a
      // copy, and the incremental scene renders only what is changing. Both
      // are also what the user is directly manipulating, where latency is the
      // thing being bought, not spent.
      const gestNow = gesture.current;
      if (
        !cameraInMotion(nowMs) &&
        gestNow.mode !== "drag-layers" &&
        // Members gliding into a new layout slot: a paced frame is a stutter.
        !layoutMotionActive(nowMs) &&
        // A PRE-RENDER IS NOT AN INTERACTION. The pacer exists to keep a share
        // of every second free for input while a person is working; a RAM
        // preview build is the work, it steps one frame per animation frame
        // (so it yields by construction), and pacing it would halve the rate
        // of the one job the user is watching progress on.
        s0.prerenderProgress === null &&
        // A RUN OF CACHED FRAMES IS NEVER PACED. The pacer holds back renders
        // to keep the main thread free; a cached frame is a blit, and delaying
        // it just drops a frame that was already made — which is how a second
        // pass over a built range played slower and heavier than the first.
        !(running && cacheRun) &&
        shouldDeferRender(nowMs)
      ) {
        return;
      }
      dirtyRef.current = false;
      const frameStartMs = nowMs;

      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      if (!fittedRef.current) {
        fittedRef.current = true;
        fit();
      }

      // ── PREVIEW QUALITY, APPLIED AT BOTH SEAMS THAT COST MONEY ───────────
      //
      // A tier lowers the DEVICE scale (the canvas backing store) and the
      // DOCUMENT raster scale, because the renderer has two different kinds of
      // layer and only one of them follows the first.
      //
      // Vector-ish work rasterises at device scale, so the backing store alone
      // covers it. But every REGIONAL effect — goo, glass, grain, film damage,
      // anything that reads a neighbour — is pinned to the DOCUMENT scale on
      // purpose, so that the stage is a magnifying glass over the frame that
      // will ship rather than a different picture at every zoom (see
      // `needsDocumentRaster`). Those are the only layers that are ever
      // expensive, and a tier that cannot touch their scale does not make them
      // cheaper by a single pixel. It just hands the compositor a
      // full-resolution buffer to shrink by a larger factor — which is why
      // Quarter measured SLOWER than Full, monotonically, all the way down.
      //
      // So the tier is what it says it is: render the preview at a fraction of
      // full resolution. Grain and damage genuinely re-roll at a different
      // raster scale — they are pixels, they have no resolution-independent
      // meaning — and that is the trade a preview tier exists to make. It is
      // also exactly why PAUSED IS FULL: the frame you judge is never the
      // reduced one.
      //
      // `renderScale` is no longer how the renderer recognises an export;
      // `exporting` says so outright. See `DrawOptions.exporting`.
      // THE TIER DROPS ONLY WHILE PLAYING. A scrub or an arrow step is a still
      // frame being looked at: it was treated as a run, so Auto flicked to ½
      // and back to Full around every step — each flip a canvas resize, which
      // wipes it. Scrubbing renders at the parked tier.
      const quality = useSession
        .getState()
        .reportPreviewFrame(
          lastFrameCostMs,
          lastFrameFps,
          running ? "playing" : dragReadsKept ? "scrubbing" : "idle",
          memoryCap,
          exactRunNow || dragReadsKept,
          s0.activeFrameId,
        );
      const previewScale = PREVIEW_RESOLUTION_SCALE[quality.tier];

      const dpr = (window.devicePixelRatio || 1) * previewScale;
      const pw = Math.max(1, Math.round(rect.width * dpr));
      const ph = Math.max(1, Math.round(rect.height * dpr));
      // Applied after the settled-media wait below: resizing a canvas clears
      // it, and a tick that resizes and then waits leaves it black.
      const resizeCanvas = () => {
        if (canvas.width === pw && canvas.height === ph) return;
        canvas.width = pw;
        canvas.height = ph;
        // The camera raster is device pixels at the OLD backing size, so a blit
        // of it into the new one would resample the whole viewport — a visibly
        // soft, subtly shifted frame on the tick a tier changes, which reads as
        // the picture breaking up rather than as a resolution change.
        dropRaster();
      };

      const docNow = visualState();
      const session = useSession.getState();
      const view = useStageView.getState();
      // ── THE RESOLUTION THE COMP IS CACHED AT ─────────────────────────────
      //
      // The TIER, and nothing else. Not the zoom, not the window, not the
      // device ratio — nothing about where you are standing enters this cache
      // at any point.
      //
      // It briefly followed the zoom, quantised to powers of two, on the theory
      // that rendering a comp at full size while you work zoomed out is waste.
      // That theory is right about cost and wrong about everything else: a
      // comp-space buffer is BLITTED THROUGH THE VIEW TRANSFORM, so a buffer at
      // any resolution displays correctly at any zoom — the only difference is
      // sharpness. Putting the zoom in the key bought nothing and cost the
      // whole feature: every bucket boundary was a different variant, so a
      // range built at one zoom went dark at the next, which is "stage zoom
      // still breaks it".
      //
      // Being the same number as `renderScale` is the point, not a coincidence.
      // The document raster scale and the buffer the document is rasterised
      // into have to agree, or every regional effect is computed for a picture
      // of a different size than the one it lands in.
      const compScale = PREVIEW_RESOLUTION_SCALE[quality.playbackTier];
      // THE CARD YOU ARE TUNING. With its editor open, the stack splits there:
      // the cards beneath it are kept and a slider drag re-runs only it and
      // those above (`DrawOptions.effectFocus`) — the same cut the editor's
      // preview makes, so the two surfaces never do the work below twice.
      const effectFocus = stageEffectFocus(docNow, session.selectedClipIds, useEffectEditor.getState().openId);
      // The canvas shows ONE page (Figma) — or just the comp you're drilled into.
      // Hit rects come from the paint pass, so hit-testing follows automatically.
      const pageFrames = framesInView(docNow, session);


      // THE navigation context for this paint. Ancestor times come straight
      // from it (`frameTimes`), mapped up through each hop's trim and speed, so
      // scrubbing a child previews its parents in context. Nothing has to
      // RECONSTRUCT the ancestor scene any more: you are always editing in
      // place, so the parents are literally on the canvas.
      const editCtx = stageContext(docNow, session);
      const frameTimes = editCtx?.frameTimes ?? new Map<string, number>();

      // One media pass BEFORE painting: video element time is owned by the
      // pipeline, never by draw functions (keeps preview and export from
      // fighting over currentTime). One conduct per element per tick — the
      // ACTIVE timeline syncs first so its mapping wins when the same clip
      // is visible through several frames (nested parent + child, instances).
      const activeTimelineId =
        session.timelinePath.length > 0
          ? session.timelinePath[session.timelinePath.length - 1]!.frameId
          : session.activeFrameId;
      // THE WORKING COMP IS ON THE PAGE YOU ARE LOOKING AT. A timeline left on
      // a comp of another page (a pinned tab, a page switched under it) does
      // not make anything here live: every comp on this page is a picture.
      const timelineFrame = docNow.frames.find((f) => f.id === activeTimelineId);
      const activeTimelineFrame = !timelineFrame
        ? pageFrames[0]
        : session.timelinePath.length > 0 || pageFrames.includes(timelineFrame)
          ? timelineFrame
          : undefined;

      // Playback is SCOPED to the active timeline: only the frame whose timeline
      // is open (and its parent-preview ancestors, which carry a mapped time)
      // advances with the playhead. Sibling artboards on the page freeze at their
      // poster (t=0) so they don't all run at once — their nested children still
      // play, because those render INSIDE the active frame's own content. One
      // time-selector drives both the video-sync pass and the paint pass so they
      // never disagree about what a frame's "current time" is.
      // Only DURING PLAYBACK do siblings freeze — so identical component instances
      // (and every other frame) still render at the SAME playhead while you're
      // paused/scrubbing/editing, staying perfectly in sync. Playing them all at
      // once is the chaos we suppress; a static, in-sync canvas is what you edit.
      //
      // The timeline you're ON is authoritative. ONE scope — shared verbatim with
      // the audio conductor (resolvePlaybackScope) — decides which frames advance
      // and at what time, so picture and sound can NEVER disagree. Playing: only
      // frames in `liveTimes` advance — the active comp, plus, for an in-place
      // edit, the ancestry that actually paints its picture (before this, that
      // ancestor froze and you got moving sound over a still image). Every other
      // frame — siblings, and the SAME component retimed elsewhere — freezes at
      // its poster, so a foreign timeline can't drag playback off the second
      // you're on (you'd see 5s while sitting at 4s). Paused: parent-preview.
      const playScope = running && editCtx ? playbackScopeOf(editCtx) : null;
      // During playback the active comp (and, for an in-place component edit, its
      // painting ancestry) advance via `playScope.liveTimes`. When PARENT PREVIEW
      // is on we ALSO advance the ancestry chain's frames from `frameTimes`, so
      // the parent scene plays in-context — not just while paused (the old
      // `!playing` gate). Picture only: audio stays on the authority conduct.
      // Everything not in either map freezes at its poster (t = 0).
      const painted = new Map<string, number>();
      paintTimesRef.current = painted;
      const frameTimeFor = (fid: string) => {
        // A frame off the path is somebody else's timeline — it sits at its
        // OWN remembered instant, never the one you are scrubbing, and never
        // its first frame either: playing and parked answer the same, so a
        // sibling's picture does not flip when the transport starts or stops.
        const t =
          playScope?.liveTimes.get(fid) ?? frameTimes.get(fid) ?? rememberedPlayheadMs(docNow, fid);
        // Every gizmo drawn later this tick poses against this — see `paintTimesRef`.
        painted.set(fid, t);
        return t;
      };


      // THE CUT BELONGS TO THE SELECTION while parked: on the exact instant a
      // selected clip ends, it holds its last pose instead of yielding to the
      // clip that starts there — you are looking at the keyframe you edit.
      // Playback and export follow the plain [start, end) rule.
      const clipEnds = !running && session.selectedClipIds.length > 0 ? new Set(session.selectedClipIds) : null;

      // Isolation: while drilled in, the focused frame is lit + interactive and
      // every sibling fades (renders faded, emits no hit rects). ONE seam feeds
      // render, hit-testing and selection so they stay in lockstep.
      const isoFocusId = isolationFocusId(docNow, session);

      beginConductPass();
      const syncOrder = activeTimelineFrame
        ? [activeTimelineFrame, ...pageFrames.filter((f) => f.id !== activeTimelineFrame.id)]
        : pageFrames;
      // Exact playback also hands each frame its NEXT instant, so footage
      // decodes one frame ahead while this one is on screen.
      const exactPlaying = running && playbackRegime() === "exact";
      for (const f of syncOrder) {
        const t = frameTimeFor(f.id);
        const lead = exactPlaying ? t + frameStepMs(compFps(docNow, f.id)) : null;
        syncVideoFrames(docNow, f, t, session.playing, false, lead, clipEnds);
      }
      // Park any video element that left the visible set this tick — the video
      // pipeline is the sole authority over element play/pause (the media
      // conductor no longer pauses elements, which used to freeze nested videos).
      pauseUnconductedElements();
      // Kick the lazy decodes this document needs (images, raster surfaces),
      // once. Video is never warmed — see warm.ts.
      warmDocument(docNow);

      // ── PARKED, PRESENT ONLY WHAT HAS LANDED ─────────────────────────────
      // Stopped or stepping, a video seek is in flight for a moment. Painting
      // during it shows whatever the element was holding — the frame before, a
      // snapshot, a neighbouring cell — and then the real one: 3 → 4 → 3 → 4,
      // the jump on every pause and every arrow key, cache on or off. So the
      // stage does what every player does: keeps the frame already on screen
      // until the seek lands (the landing re-dirties it), bounded so a stuck
      // decode can never freeze the canvas. The conduct above still ran — the
      // seek is under way; only the PAINT waits. A drag-scrub is exempt: there,
      // a stream of landed frames is the feedback.
      // AT REST only — whatever moved the playhead (a ruler drag, an arrow key
      // held down, the time field dragged). While it moves, every frame the
      // video lands on is shown as it lands; waiting there skipped frames
      // (.89 → 1.18 while stepping slowly). `transport` is "idle" once the
      // playhead has been still for the scrub settle window.
      //
      // A single STEP (an arrow, a typed or dragged time value) gets a short
      // hold too: the seek of one frame usually lands inside it, so the screen
      // goes straight from the old frame to the new one. A held drag on the
      // ruler never waits — there a stream of landed frames is the feedback.
      // EXACT PLAYBACK presents nothing until every picture is the frame of its
      // instant — a step passing through its frames, or a seek mid-flight, is
      // exactly the flicker it exists to remove — unless the instant is already
      // kept, where no footage is needed at all. Bounded like the others; the
      // clock's own stall release is the longer of the two.
      const exactRun = exactPlaying;
      const holdComp = activeTimelineFrame?.id ?? null;
      const exactWait =
        exactRun &&
        holdComp != null &&
        !isResolvedAt(holdComp, compRenderTimeMs(docNow, holdComp, frameTimeFor(holdComp))) &&
        exactMediaPending();
      const settleCap = exactRun
        ? EXACT_WAIT_MS
        : transport === "idle"
          ? SETTLE_WAIT_MS
          : !isScrubbingTime() && !running
            ? STEP_WAIT_MS
            : 0;
      if (settleCap > 0 && (exactRun ? exactWait : mediaSeeksPending())) {
        if (settleWaitSince < 0) settleWaitSince = nowMs;
        if (nowMs - settleWaitSince < settleCap) {
          dirtyRef.current = true;
          return;
        }
      }
      settleWaitSince = -1;
      resetKeptUnits();
      resetHitCaptures();
      beginSpillShare();

      resizeCanvas();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      // Frames: shadow + content. Extracted into a closure so isolation can paint
      // the FOCUSED frame a SECOND time — on top of the glass scrim — while every
      // sibling sits behind it. That's a real overlay layer (Illustrator
      // isolation), not a per-frame fade that leaves siblings looking half-lit and
      // still on top. `collectHits` is off for a behind-glass frame, so a click
      // passes over it as empty canvas.
      // THE CAMERA FAST PATH. While the camera is in motion and nothing about
      // the artwork has changed, the frames already painted ARE this frame's
      // frames — moved. Never while the transport runs (the picture genuinely
      // changes every tick), and never when a real render is cheap enough that
      // deferring it would buy nothing. See `camera-raster.ts`.
      // ONE SINK, TWO READERS. The rolling profile answers "which layer is
      // expensive" for the HUD and the timeline; the ledger answers "who
      // painted into this exact frame" for the frame cache. Both are fed from
      // the single bracket in `paintLayerNode`, rather than by walking the
      // scene twice to ask two questions about one pass.
      const frameProfiler = teeProfiler(renderProfiler, frameLedger);
      /** Did the active comp come out of the cache this tick? Set by `paintFrame`. */
      let compCacheHit = false;

      // ── THE FRAME CACHE'S KEY ────────────────────────────────────────────
      //
      // The comp being played, and the frame index the playhead is INSIDE.
      // That is a legitimate key only because `drawFrameContent` already
      // quantizes every time through the render clock, so a comp genuinely
      // only exists at grid instants — without that the transport, which
      // advances by wall-clock delta, would never visit one millisecond twice
      // and the hit rate would be exactly zero.
      //
      // ONE GRID, and it is the ACTIVE COMP'S OWN RATE — the rate the timeline
      // is ruled in, the rate the build steps at, and the rate the bar is drawn
      // against.
      //
      // It was the finest rate on screen, out of caution about a parent-preview
      // ancestor running faster than the comp you are in. That caution cost far
      // more than it bought: the build and the bar both step at the comp's own
      // rate, so on any comp whose rate was not the maximum on screen, the keys
      // they asked for were never the keys that had been stored. Nothing was
      // ever found, the range rebuilt itself forever, and the bar filled with
      // cells that no instant could ever land in — a dashed line that could not
      // converge no matter how long it ran.
      //
      // The caveat is written down rather than defended against: under parent
      // preview, an ancestor at a finer rate can advance a frame inside one of
      // this comp's cells. That is one stale ancestor frame in a preview of
      // somebody else's comp, against a cache that otherwise does not work at
      // all.
      const cacheComp = activeTimelineFrame?.id ?? null;
      const cacheFps = compFps(docNow, cacheComp);
      const cacheGridMs = frameStepMs(cacheFps);
      // THE INSTANT THE COMP IS ACTUALLY DRAWN AT, not the playhead.
      //
      // They are the same number on a root comp at rest and different
      // everywhere else: `frameTimeFor` maps the playhead through the playback
      // scope while the transport runs, and through each hop's trim and speed
      // when you are drilled into something. Keying on the playhead meant two
      // different playhead positions could share a key while the comp was drawn
      // at two different instants — so the cache served one of the two
      // pictures, apparently at random, and the frame flicked back and forth
      // between them. That is the "bouncy jump between two frames", and it
      // needed a comp whose time is mapped (a nested comp, a retimed one, a
      // drilled edit) to show up at all.
      const cacheTimeMs = cacheComp
        ? compRenderTimeMs(docNow, cacheComp, frameTimeFor(cacheComp))
        : 0;
      // WHAT A COMP'S PICTURE IS MADE AT — and nothing about where you are.
      // It used to hold the page, the active comp, the drilled target, the
      // selection's spill: so the frames a comp kept as the root were
      // unreachable the moment you drilled into it, and a nested comp could
      // never share its pictures with its parent. A comp's picture is the same
      // at every depth; states that DO change how a comp draws (a text edit, a
      // crop preview) bypass the store instead of forking its key. The tier and
      // shutter are the playback run's, as before: stopping changes neither.
      setFrameVariant(quality.playbackTier, `${runShutter ?? mbQuality}`);
      // Paused layers are kept for the frame you are editing and no other: a
      // new paused instant, or a run starting, lets the old set go.
      const parkedNow = running ? null : `${cacheComp}@${cacheTimeMs}`;
      if (parkedNow !== parkedAt) {
        if (parkedAt !== null) dropParkedLayers();
        parkedAt = parkedNow;
      }

      // ONLY WHILE WE ARE RENDERING WHAT PLAYBACK WOULD RENDER. A parked
      // full-quality frame is a one-off for your eyes: reading the cache there
      // would blit a preview-resolution picture into the moment you are judging
      // the artwork, and writing to it would make every play/pause a different
      // resolution of every instant — which is a build thrown away each time
      // you stop. See `PreviewResolutionDecision.playbackTier`.
      // ONLY WHILE THE TRANSPORT IS MOVING, and only while we are rendering
      // what playback would render. Two conditions, two different bugs:
      //
      //  · A PARKED STAGE MUST NOT PAY FOR THIS. Storing a frame is a copy of
      //    the whole viewport — megabytes — and while you are dragging a corner
      //    radius every one of those copies is superseded by the next edit
      //    before anything could ever read it. That is a cache doing pure
      //    damage: the mechanism must be able to notice when it is not paying,
      //    and the honest answer here is that a still frame you are actively
      //    changing will never be asked for twice.
      //  · A PARKED FRAME IS FULL QUALITY, and the cache holds preview-tier
      //    pixels. Reading one into the moment you are judging the artwork
      //    would be the whole point of "paused is true", lost.
      // READING AND WRITING ARE NOT THE SAME QUESTION, and conflating them is
      // what made this feel like it was fighting you.
      //
      // READ whenever the playhead is moving — playing, pre-rendering, OR
      // dragging the bar. Scrubbing across a built range should be a blit, and
      // it is the moment the cache is most obviously worth having. Stop, and
      // the read stops with it: a settled frame is rendered at full quality,
      // because that is the frame you are judging.
      //
      // WRITE only while a RUN is in progress. A scrub paints siblings live
      // while playback freezes them at their poster, so a frame captured
      // mid-scrub is not the frame the transport would show — storing it would
      // serve the wrong picture later. Reading one during a scrub is the
      // harmless direction of that difference; writing one is not.
      //
      // ONE SWITCH GOVERNS BOTH PRODUCERS. The timeline's caching toggle used
      // to mean only "keep decoded video frames", and this cache ignored it —
      // two switches for one idea, which is how you end up with a "cache work
      // range" button that silently does nothing because an unrelated toggle is
      // off. It now means what a person reading it would assume: may this app
      // keep rendered work. Turning it off purges both; the work-range button
      // turns it on rather than failing quietly.
      const tierMatchesCache = quality.tier === quality.playbackTier;
      // READ whenever the frame being drawn IS the frame the cache holds. That
      // is the whole condition, and `tierMatchesCache` already says it: while
      // the transport moves, the tier is the playback tier; while parked, it is
      // Full unless you asked it to hold. So a scrub across a built range is a
      // blit, a settled pause re-renders the true frame, and turning HOLD on —
      // which is a person saying "show me the preview version, I know what it
      // is" — makes a paused frame a blit too, instead of the full re-render
      // that made holding quality somehow cost MORE than not holding it.
      const frameCacheRead =
        cacheComp != null &&
        tierMatchesCache &&
        (transport !== "idle" || session.holdPreviewQuality) &&
        framesCacheOn() &&
        !session.editingClipId &&
        !session.cropClipId &&
        !selectionOwnsCut(docNow, clipEnds, cacheComp, cacheTimeMs);
      const frameCacheOn = frameCacheRead && running;
      // Footage rolling on screen means a live render shows the element where
      // ITS clock is, and a cached frame shows the exact instant: they may only
      // alternate at the edge of a run. See `cachedRunAhead`.
      const liveFootage = running && rollingVideoOnScreen();
      // THE LAYERS MODE READS IN RUNS TOO. A built instant holds every unit —
      // footage-made ones included, kept by an exact pass or a build — and
      // reading those beside the live element is the jump; so, exactly like
      // the Frames mode, playback over live footage switches to the kept
      // pictures only at the start of a run of built instants and leaves on
      // the first miss. Without this a built range played live anyway.
      if (layersCacheOn() && liveFootage && cacheComp) {
        if (cacheRun) {
          if (!isResolvedAt(cacheComp, cacheTimeMs)) cacheRun = false;
        } else {
          cacheRun = cachedRunAhead(cacheComp, cacheTimeMs, cacheGridMs, CACHE_RUN_ENTRY_FRAMES);
        }
      } else if (layersCacheOn()) {
        cacheRun = false;
      }
      const footageLive = liveFootage && !(layersCacheOn() && cacheRun);

      const blitPlan = running
        ? null
        : planBlit(nowMs, contentVersionRef.current, rect.width, rect.height, view);
      const reuseRaster = blitPlan !== null;
      // Hit rects are WORLD space, so the previous pass's are still exactly
      // right after a blit — reusing the array keeps them, and keeps the
      // `hitRectsRef` assignment below a no-op instead of a wipe.
      const hits: ClipHitRect[] = reuseRaster ? hitRectsRef.current : [];
      /**
       * `slice` paints ONE third of the incremental scene (see `live-raster.ts`):
       * `only` narrows the clips, `board` decides whether this pass owns the
       * frame's fill and drop shadow — the bottom slice does, so the board is
       * painted exactly once, underneath everything, as it always was.
       */
      // RETAINED BOARD PICTURES (see `render/board-pictures.ts`): one sharpening
      // per idle tick; a picture still short of the zoom asks for another tick.
      beginBoardTick(transport === "idle" && !cameraInMotion(nowMs));
      // A LIVE run makes missing comp pictures within a budget, in turns; an
      // exact run (or a build) makes every one it needs.
      const fillLive = running && !exactRunNow;
      if (fillLive) pictureFill.beginFrame();
      // A RETAINED PICTURE IS RENDERED ONCE, so it takes the shutter a parked
      // stage would — never the auto governor's live verdict. That verdict
      // reacts to frame cost and flips the moment a pan starts and again when
      // it stops; keyed on it, every comp on the page re-rendered from its
      // vectors at both ends of every pan (and the slow re-render fed the
      // governor the next flip).
      //
      // THE SAME HOLDS FOR THE TRANSPORT AND THE TIER: a picture is the parked
      // look of its comp at its own level (`board-pictures.ts`). Keyed on the
      // live tier and transport, pressing play re-rendered every comp on the
      // page, which slowed the frame, which dropped the tier, which re-keyed
      // them all again — the Playground's Styles page fell to an eighth.
      const pictureQuality = s0.motionBlurQuality === "auto" ? "full" : s0.motionBlurQuality;
      const pictureShutter = stagePolicy(pictureQuality, "idle");
      const boardVariant = pictureQuality;
      const editFrames = editCtx ? [...editCtx.frameTimes.keys()] : [];
      // THE SETTLING BUDGET (`DrawOptions.settle`): parked only. While the
      // camera is moving — and for a beat after — a layer that only needs a
      // sharper buffer shows the one it has; once still, it sharpens a budget's
      // worth per tick and asks for another. A zoom never waits on a re-render.
      const settleStart = performance.now();
      const sharpening = cameraStillForMs(nowMs) >= SHARPEN_AFTER_MS;
      const settle =
        transport === "idle"
          ? {
              spent: () => !sharpening || performance.now() - settleStart > SETTLE_BUDGET_MS,
              defer: () => {
                dirtyRef.current = true;
              },
            }
          : null;
      const paintFrame = (
        f: Frame,
        collectHits: boolean,
        slice?: { only: ReadonlySet<string>; board: boolean; onComposite?: boolean },
        /** Where to paint. The live canvas unless a drag slice is being baked
         *  into its own raster — see `live-raster.ts`. */
        target?: CanvasRenderingContext2D,
      ) => {
        const g = target ?? ctx;
        const board = slice ? slice.board : true;
        g.save();
        g.translate(view.tx + f.x * view.scale, view.ty + f.y * view.scale);
        g.scale(view.scale, view.scale);
        if (board) {
          g.shadowColor = "rgba(0,0,0,0.55)";
          g.shadowBlur = 48 / view.scale;
          g.shadowOffsetY = 12 / view.scale;
          g.fillStyle = f.background;
          g.fillRect(0, 0, f.width, f.height);
        }
        // Fully clear the frame's drop-shadow before painting content. Resetting
        // only the color left `shadowBlur`/`shadowOffsetY` at `x / view.scale`,
        // which any content shadow that sets color+blur but not offset (e.g. the
        // waveform glow) would inherit — making its glow slide as you zoom.
        g.shadowColor = "transparent";
        g.shadowBlur = 0;
        g.shadowOffsetX = 0;
        g.shadowOffsetY = 0;
        // THE SPILL. Artwork that reaches past the artboard is drawn a second
        // time, outside the box, at the frame's own `overflow` opacity — so a
        // rough drawn off the side of a shot is visibly there and visibly out.
        //
        // Only on the frame you are WORKING IN. Every comp on a page showing
        // everything it has ever been given is a board nobody can read, and
        // this is the one frame whose outside you are currently responsible
        // for. Only when it has hit rects to give, too, so the boardless slices
        // of the drag fast path never double-paint it.
        //
        // Two content draws in the dimmed middle, one at either extreme: at
        // `overflow: 0` the spill pass is skipped and at 1 the content is
        // simply not clipped, which are the two costs this already had.
        const spill = spillOpacity(f, docNow, session, session.selectedClipIds);
        if (spill > 0 && spill < 1) {
          g.save();
          g.globalAlpha = spill;
          outsideFidelity(() => drawFrameContent(g, docNow, f, frameTimeFor(f.id), {
            overflowPass: "outside",
            transparent: true,
            // Click targets collected and thrown away: a layer buffer carries
            // the rects its draw emitted, so a spill that collected none made
            // buffers the real pass below could not read — and it runs FIRST,
            // so every layer reaching past the box rendered twice.
            hitRects: [],
            only: slice?.only ?? null,
            _onComposite: slice?.onComposite,
            skipClipId: session.editingClipId,
            clipEnds,
            playing: asPlayback,
            footageLive,
            motionBlur: mbPolicy,
            previewScale,
            renderScale: previewScale,
            cacheHits: layerCacheHits,
            profiler: frameProfiler,
            settle,
            // The spill's nested pictures are the box pass's (see
            // `nestedUsesCompStore`): one fill for both, so a picture made here
            // is the box pass's hit, and turns are not taken twice.
            pictureFill: fillLive ? pictureFill : null,
          }));
          g.restore();
        }
        /**
         * THE CONTENT OPTIONS, built once and used by BOTH destinations.
         *
         * A cached comp is rendered into its own buffer and blitted; a miss
         * renders into that same buffer. Two option objects here would be two
         * descriptions of one picture, and the cache would eventually be keyed
         * to a frame nobody was drawing.
         */
        const contentOptions = {
          // The box pass. Anything short of a fully-visible spill has to CLIP,
          // or the content lands twice over its own edge — and a frame you are
          // not working in clips outright, which is what `spillOpacity` already
          // said by returning zero for it.
          overflowPass: spill < 1 ? "inside" : undefined,
          hitRects: collectHits ? hits : undefined,
          only: slice?.only ?? null,
          _onComposite: slice?.onComposite,
          // A SLICE THAT DOES NOT OWN THE BOARD HAS NO FRAME BOX.
          //
          // `drawFrameContent` paints the artboard — fills, border, content
          // clip — unless told this render has none. The board flag above only
          // suppressed the drop shadow and the background fill painted HERE, so
          // both boardless slices (the "above" raster, and the live render of
          // the layers in your hand) still laid an OPAQUE artboard over
          // everything already composited beneath them. Dragging a layer wiped
          // itself and every layer below it, sixty times a second, while the
          // layers above — painted on top of that box — were untouched.
          //
          // It only showed up once the drag fast path engaged, which needs a
          // render costing more than the budget: zoom in and the board wipes,
          // zoom out and it does not. And an adjustment layer anywhere made it
          // vanish, because that refuses the whole cut (see `live-raster.ts`).
          transparent: slice ? !slice.board : undefined,
          skipClipId: session.editingClipId,
            clipEnds,
          worldOffset: { x: f.x, y: f.y },
          hostFrameId: f.id,
          cropPreviewClipId: session.cropClipId,
          effectFocus,
          playing: asPlayback,
          footageLive,
          motionBlur: mbPolicy,
          previewScale,
          renderScale: previewScale,
          cacheHits: layerCacheHits,
          // ALWAYS ON now, and that is a deliberate change. It was gated on the
          // HUD because it was only ever a debugging lens; it has two more
          // readers since — the timeline's per-clip cost, and the frame cache's
          // contributor ledger, which is not optional if the cache is to
          // invalidate per clip. The price is two `performance.now()` calls per
          // layer, which is microseconds against a render measured in
          // milliseconds, and the profile itself is a bounded rolling window.
          profiler: frameProfiler,
          settle,
          pictureFill: fillLive ? pictureFill : null,
        } satisfies Parameters<typeof drawFrameContent>[4];

        // ── THE COMP BUFFER ──────────────────────────────────────────────
        //
        // The active comp's content is rendered into a buffer THE SIZE OF THE
        // COMP and blitted onto the board, rather than straight onto the
        // viewport. That one indirection is what lets the cache be of the comp
        // instead of of your window: pan, zoom, resize a panel — none of it
        // touches what is stored, because none of it is what was stored.
        //
        // A slice never takes this path: the incremental scene is painting a
        // handful of layers over a bake, so its output is not the comp.
        // ── THE RETAINED BOARD PICTURE ───────────────────────────────────
        //
        // Every comp you are NOT working in is a picture: drawn through the
        // camera, re-rendered only when its dependency signature moves (core
        // `compPictureDeps`) or the zoom wants a sharper level. Anything that
        // could make a picture lie stays live: the working comp, a comp
        // advancing with the playhead, a spill pass, and any comp holding a
        // selected / edited / cropped / effect-focused layer or on the path
        // you are drilled into.
        if (!slice && f.id !== cacheComp && spill <= 0 && !(playScope?.liveTimes.has(f.id) ?? false)) {
          const deps = compPictureDeps(docNow, f.id);
          const touched =
            session.selectedClipIds.some((id) => deps.clipIds.has(id)) ||
            (session.editingClipId != null && deps.clipIds.has(session.editingClipId)) ||
            (session.cropClipId != null && deps.clipIds.has(session.cropClipId)) ||
            (effectFocus != null && deps.clipIds.has(effectFocus.clipId)) ||
            // ON the path you are drilled into — not merely NESTING a comp on
            // it: that is every consumer of the comp you are in (a cover of
            // nine looks of one scene), which an edit already re-renders through
            // `deps.signature`. Asked as "depends on", opening a scene drew all
            // thirty-five of its consumers live on every pan tick.
            editFrames.includes(f.id);
          const level = touched ? null : boardLevel(view.scale * dpr, f.width, f.height);
          if (level != null) {
            const t = frameTimeFor(f.id);
            const key = boardPictureKey(deps.signature, t, boardVariant);
            // Rendered parked, at the picture's own raster: the level IS its
            // resolution, so a quarter-level first look spends a quarter's
            // pixels in every pixel effect it holds.
            const render = (at: number) =>
              renderBoardPicture(f.id, key, at, f.width, f.height, f.x, f.y, nowMs, (pctx) => {
                const local: ClipHitRect[] = [];
                const raster = Math.min(1, at);
                drawFrameContent(pctx, docNow, f, t, {
                  ...contentOptions,
                  playing: false,
                  footageLive: false,
                  previewScale: raster,
                  renderScale: raster,
                  motionBlur: pictureShutter,
                  hitRects: local,
                  // A retained picture is kept as drawn: never a soft stand-in.
                  settle: null,
                });
                return local;
              });
            let pic = readBoardPicture(f.id, key);
            // OFF SCREEN, a missing picture waits: nobody can see it, and a
            // page is often wider than the view. What it last had still draws
            // (and still hit-tests); the render happens when it scrolls in.
            const sx = view.tx + f.x * view.scale;
            const sy = view.ty + f.y * view.scale;
            const onScreen = sx < rect.width && sy < rect.height && sx + f.width * view.scale > 0 && sy + f.height * view.scale > 0;
            if (!onScreen) pic ??= readStaleBoardPicture(f.id);
            if (!onScreen) {
              // Off screen nothing is drawn — a picture is resampled even where
              // it lands outside the canvas — but it still hit-tests.
              if (pic && collectHits) for (const r of pic.hits) hits.push({ ...r, cx: r.cx + f.x, cy: r.cy + f.y, depth: (r as ClipHitRect).depth ?? 0 });
              g.restore();
              return;
            }
            if (!pic) {
              // A miss renders inside the tick's budget, coarse on a first look;
              // over budget it shows what it last had and asks for another tick.
              const stale = readStaleBoardPicture(f.id);
              pic = renderInBudget(f.id, () => render(stale ? Math.min(level, stale.level) : firstLevel(level, f.width, f.height))) ?? stale;
              if (!pic || pic.key !== key || pic.level < level) dirtyRef.current = true;
              // Waiting with nothing to show: its bare board, painted above. A
              // live render here would be the very stall the budget exists for.
              if (!pic) {
                g.restore();
                return;
              }
            } else if (pic.level < level) {
              if (takeUpgradeSlot()) pic = render(level);
              else dirtyRef.current = true; // sharpen on a later idle tick
            }
            if (pic) {
              if (collectHits) for (const r of pic.hits) hits.push({ ...r, cx: r.cx + f.x, cy: r.cy + f.y, depth: (r as ClipHitRect).depth ?? 0 });
              drawBoardPicture(g, pic, f.width, f.height, nowMs, level);
              g.restore();
              return;
            }
          }
        }

        const useCompBuffer = !slice && f.id === cacheComp && frameCacheRead && collectHits;
        if (useCompBuffer) {
          const bw = Math.max(1, Math.round(f.width * compScale));
          const bh = Math.max(1, Math.round(f.height * compScale));
          // Pictures are kept at the size they were SEEN (a comp nested small
          // is stored small — see `drawCompPicture`). One smaller than this
          // buffer is not this frame's picture; render the sharp one, which
          // replaces it.
          let cached = readFrame(cacheComp!, cacheTimeMs, bw);
          if (running) {
            if (!cached) {
              // A gap is not the end of a run: there is nothing there that a
              // live render and a cached one could disagree about.
              if (!isResolvedAt(cacheComp!, cacheTimeMs)) cacheRun = false;
            } else if (liveFootage && !cacheRun) {
              cacheRun = cachedRunAhead(cacheComp!, cacheTimeMs, cacheGridMs, CACHE_RUN_ENTRY_FRAMES);
              if (!cacheRun) cached = null; // stay live until a run is ahead
            } else {
              cacheRun = true;
            }
          }
          if (cached) {
            compCacheHit = true;
            // Stored in the comp's own space; onto the board here.
            for (const r of cached.hits) hits.push({ ...r, cx: r.cx + f.x, cy: r.cy + f.y, depth: (r as ClipHitRect).depth ?? 0 });
            g.drawImage(cached.canvas, 0, 0, f.width, f.height);
            g.restore();
            return;
          }
          const buf = compBufferRef.current ?? (compBufferRef.current = document.createElement("canvas"));
          if (buf.width !== bw || buf.height !== bh) {
            buf.width = bw;
            buf.height = bh;
          }
          const bctx = buf.getContext("2d");
          if (bctx) {
            bctx.setTransform(1, 0, 0, 1, 0, 0);
            bctx.clearRect(0, 0, bw, bh);
            // Exactly buffer-sized, not `compScale`: the size is rounded, and the
            // comp's paper ending partway into the last row seams (`gridRect`).
            // The same pictures are what nested clips blit from the store.
            bctx.setTransform(bw / f.width, 0, 0, bh / f.height, 0, 0);
            const before = hits.length;
            // THIS comp's contributors only — the ledger is what the stored
            // frame invalidates by, and what its steady signature is made of.
            frameLedger.begin();
            const faultsBefore = pictureFaults();
            drawFrameContent(bctx, docNow, f, frameTimeFor(f.id), contentOptions);
            g.drawImage(buf, 0, 0, f.width, f.height);
            // ── ONLY KEEP A FRAME WE COULD REPRODUCE ─────────────────────
            //
            // Every picture this frame drew has to have been the picture of its
            // instant — the media layer says so, draw by draw (`pictureFaults`).
            // A frame of a video mid-seek, or of a rolling element that had
            // drifted off the instant, is a photograph of something moving; kept,
            // it replays as the jitter it was taken with, forever. Refused, the
            // frame simply stays live, and building the range — which parks each
            // element on its instant — keeps the exact one instead. A comp with
            // no footage is always faithful, so it caches as it plays.
            if (frameCacheOn && faithfulSince(faultsBefore)) {
              storeFrame(
                cacheComp!,
                cacheTimeMs,
                buf,
                hits.slice(before).map((r) => ({ ...r, cx: r.cx - f.x, cy: r.cy - f.y })),
                frameLedger,
                cacheGridMs,
                // Resolution is part of a shared picture's identity (see above).
                withPictureSize(compSteadyKey(docNow, cacheComp!, cacheTimeMs, frameLedger.clipIds), bw),
              );
            }
            g.restore();
            return;
          }
        }

        drawFrameContent(g, docNow, f, frameTimeFor(f.id), contentOptions);
        g.restore();
      };

      // HIT SCOPE. While you are inside something, ONLY that thing's own layers
      // are clickable. The surrounding scene still paints (that's the context
      // you're editing against) but emits no hit rects, so a click on the
      // parent's artwork — or on the very instance you entered — can no longer
      // select it and teleport you back out to the root. In place, the target's
      // hits come from the measure pass below; isolated, from the target frame
      // itself. Not drilled: everything is live, as always.
      const drilled = editCtx != null && editCtx.depth > 0;
      blittedRef.current = reuseRaster;

      // WHAT MAY CHANGE RIGHT NOW. A drag says so through the gesture; every
      // other way of changing one layer — typing in a text box, pulling a pen
      // node, dragging a shape corner, working inside a nested comp or a
      // component — says so through the NAVIGATION, which is already the one
      // canonical answer to "what am I working on" (`editScopeClipIds`). The
      // session's `editingClipId`, `vectorEditClipId` and friends are
      // projections of that same leaf, so there is no list of modes here to
      // fall out of step, and a mode added tomorrow is covered the day it
      // becomes a leaf.
      //
      // Being generous is safe by construction: the partition is a hypothesis
      // and the bake verifies every unchanged clip's identity on every tick, so
      // a wrong guess costs a re-bake and can never cost a wrong picture.
      // NOT WHILE THE CAMERA IS MOVING. The bake holds device pixels at one
      // view, so a pan invalidates it on every tick — and a re-bake is TWO full
      // scene renders, against the one a plain render would cost. While this
      // only ran during a layer drag that could never happen; you do not pan
      // and drag at once. Generalised to any edit, "in text mode, panning"
      // became a straight doubling. The camera raster already owns this case
      // and is strictly better at it: it blits what it has and falls back to a
      // single full render.
      // NOT WHILE THE PLAYHEAD IS MOVING, which is a strictly broader rule than
      // "not while playing" and fixes two things at once.
      //
      // The bake holds every layer that is NOT changing, and it is verified by
      // clip identity and the camera — never by TIME. So with a layer selected
      // and the playhead moving, every other layer in the scene stayed frozen
      // at the instant the bake was taken while the selected one animated: the
      // scene around your selection is simply the wrong frame, which reads as
      // layers being in the wrong places rather than as anything to do with a
      // cache.
      //
      // It also silently ate the RAM preview. A pre-render sweeps the playhead
      // with the navigation's edit scope still set, so this path engaged on
      // every step and the stage never took the full-render branch — the one
      // branch that commits a frame. The range "finished" having stored
      // nothing.
      //
      // The incremental scene is for editing a PARKED scene, which is what it
      // was written for and what its payoff accounting assumes.
      const gest = gesture.current;
      const changing =
        transport === "idle" && !reuseRaster && !cameraInMotion(nowMs) && rasterWorthwhile()
          ? (() => {
              const set: Set<string> = editScopeClipIds(session.nav.path, session.nav.leaf?.clipId ?? null);
              if (gest.mode === "drag-layers") for (const id of gest.dragOrigins.keys()) set.add(id);
              return set.size > 0 ? set : null;
            })()
          : null;
      const scene = changing
        ? prepareIncrementalScene(docNow, pageFrames, changing, `${view.scale}|${view.tx}|${view.ty}`, {
            paintSlice: (target, only, board) => {
              target.setTransform(dpr, 0, 0, dpr, 0, 0);
              for (const f of pageFrames) paintFrame(f, false, { only, board }, target);
            },
            width: canvas.width,
            height: canvas.height,
          })
        : null;
      if (!changing) endIncrementalScene();

      if (blitPlan) {
        blitRaster(ctx, view);
        // NO VOID AT THE LEADING EDGE. The raster covers where you were; the
        // strip that just came into view is painted for real, clipped to
        // exactly that strip, so board sliding in from off-screen arrives
        // already drawn instead of as a black band that fills in later.
        if (blitPlan.holes.length > 0) {
          ctx.save();
          ctx.beginPath();
          for (const h of blitPlan.holes) ctx.rect(h.x, h.y, h.w, h.h);
          ctx.clip();
          for (const f of pageFrames) {
            paintFrame(f, false);
          }
          ctx.restore();
        }
        // A pure pan produced a composite as good as a render, so it becomes
        // the new raster: panning then costs only the strip entering the
        // viewport, however heavy the board is. A zoom keeps its original
        // rather than compounding resample softness tick after tick.
        if (blitPlan.exact) {
          captureRaster(canvas, view, rect.width, rect.height, nowMs, contentVersionRef.current, true);
        }
      } else if (scene) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        scene.blitBelow(ctx);
        // Only the layers under your cursor are actually rendered. Their hit
        // rects replace last pass's — the handles have to track the drag —
        // while every other layer keeps the rect it already had.
        //
        // NOT `noteRenderCost`: this is a PARTIAL render, and the cost average
        // is what decides whether this path runs at all. Feeding it back its
        // own cheap number made the fast path measure itself, fall under the
        // budget, tear the bake down mid-edit, render fully, climb back
        // over the budget and re-cut — several times a second, for as long as
        // you held the layer. Only a FULL render is a render cost.
        const movingHits: ClipHitRect[] = [];
        const keep = hitRectsRef.current.filter((h) => !scene.changingOnly.has(h.clipId));
        for (const f of pageFrames) {
          paintFrame(f, true, { only: scene.changingOnly, board: false, onComposite: true });
        }
        scene.blitAbove(ctx);
        for (const h of hits) if (scene.changingOnly.has(h.clipId)) movingHits.push(h);
        hits.length = 0;
        for (const h of keep) hits.push(h);
        for (const h of movingHits) hits.push(h);
      } else {
        const contentStartMs = performance.now();
        frameLedger.begin();
        layerCacheHits.clear();
        compCacheHit = false;
        const faultsAll = pictureFaults();
        for (const f of pageFrames) {
          paintFrame(f, !drilled || f.id === editCtx!.target.id);
        }
        const faithful = faithfulSince(faultsAll);
        notePresented(cacheComp, cacheTimeMs, s0.playheadMs, faithful);
        // BUILT, in the Layers mode: presented exactly during a run, so every
        // unit it has is kept. What the ruler shows, and what play asks. Live
        // playback keeps nothing made from footage (it is only as exact as the
        // element's clock), so an instant that drew footage live is not built.
        if (
          running &&
          faithful &&
          cacheComp &&
          !compCacheHit &&
          (playbackRegime() === "exact" || !drewFootageSince(faultsAll))
        ) {
          noteBuilt(cacheComp, cacheTimeMs, frameLedger, cacheGridMs);
        }
        const contentMs = performance.now() - contentStartMs;
        // A TICK THAT BLITTED THE COMP IS NOT A MEASUREMENT OF RENDERING IT.
        // Feeding a cache hit to the governor would say the document had become
        // cheap, it would climb a tier, the tier is part of what a cached frame
        // IS, and the range it had just read would stop matching — the cache
        // talking itself out of existence.
        if (!compCacheHit) {
          // NOR IS MAKING MISSING PICTURES. The fill paces those itself (a
          // budget a frame, in turns); judged as the frame's cost, a first loop
          // of a wall of scenes stepped the tier down to an eighth while the
          // store was filling — every picture made after was an eighth — and
          // the pacer skipped every other frame on top.
          const steadyMs = fillLive ? Math.max(0, contentMs - pictureFill.spent()) : contentMs;
          noteRenderCost(steadyMs);
          lastFrameCostMs = steadyMs / Math.max(0.0001, previewScale * previewScale);
          lastFrameFps = cacheFps;
        }
        // Keep what was just painted, for the camera to move around while a
        // gesture is running. Taken HERE — after the frames, before any chrome
        // — so selection, guides, rulers and the scrim stay live on a blitted
        // tick.
        captureRaster(canvas, view, rect.width, rect.height, nowMs, contentVersionRef.current);
      }

      // Components view: wrap each SET's variant frames in a dashed bordered box
      // (Figma's variant panel) labelled with the component name — so a component
      // and its named alternates read as one pack you can scan and copy from.
      if (isComponentsView(session.activePageId) && pageFrames.length > 0) {
        const sets = new Map<string, Frame[]>();
        for (const f of pageFrames) {
          const sid = componentSetId(f);
          if (!sid) continue;
          const arr = sets.get(sid);
          if (arr) arr.push(f);
          else sets.set(sid, [f]);
        }
        const PAD = 32;
        for (const members of sets.values()) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const f of members) {
            minX = Math.min(minX, f.x);
            minY = Math.min(minY, f.y);
            maxX = Math.max(maxX, f.x + f.width);
            maxY = Math.max(maxY, f.y + f.height);
          }
          const sx = view.tx + (minX - PAD) * view.scale;
          const sy = view.ty + (minY - PAD) * view.scale;
          const sw = (maxX - minX + PAD * 2) * view.scale;
          const sh = (maxY - minY + PAD * 2) * view.scale;
          ctx.save();
          ctx.strokeStyle = "rgba(155,123,255,0.55)";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([7, 5]);
          ctx.beginPath();
          ctx.roundRect(sx, sy, sw, sh, 12);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(155,123,255,0.95)";
          ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
          ctx.fillText(members[0]?.name ?? "Component", sx + 6, sy - 7);
          ctx.restore();
        }
      }

      // The parent already painted the child's content on the page above. Now
      // register hit rects for the TARGET's inner layers at its world anchor (a
      // measure-only pass into a throwaway canvas — no pixels touch the stage),
      // so you can select and edit them right where they are painted, at any
      // nesting depth, and every instance updates live.
      const inplace = editCtx && editCtx.depth > 0 ? editCtx : null;
      // NOT WHILE PLAYING, and never into a pixel cache. This pass exists for
      // click targets; it used to render the whole drilled comp a second time
      // every tick — glass and all — and, looking like a parked render, keep a
      // full-resolution buffer of every layer at every instant it played.
      if (inplace && !reuseRaster && !running) {
        let mc = measureCanvasRef.current;
        if (!mc) {
          mc = document.createElement("canvas");
          mc.width = mc.height = 8;
          measureCanvasRef.current = mc;
        }
        const mctx = mc.getContext("2d");
        if (mctx) {
          mctx.setTransform(1, 0, 0, 1, 0, 0);
          mctx.clearRect(0, 0, mc.width, mc.height);
          const measured: ClipHitRect[] = [];
          painted.set(inplace.target.id, inplace.targetTimeMs);
          drawFrameContent(mctx, docNow, inplace.target, inplace.targetTimeMs, {
            hostFrameId: inplace.target.id,
            hitRects: measured,
            worldOffset: { x: 0, y: 0 },
            skipClipId: session.editingClipId,
            clipEnds,
            transparent: true,
            measureOnly: true,
          });
          for (const h of placeMeasuredHits(measured, inplace)) hits.push(h);
        }
      }

      // ONION SKIN — the edit target's ghosts, in world space, through the same
      // chain its artwork rides. Drawn after the scene and before the scrim, so
      // the ghosts sit inside the lit area rather than under the glass.
      if (editCtx && !session.playing) {
        const onion = useDrawing.getState().onion;
        drawOnionSkin(
          ctx,
          docNow,
          {
            playing: session.playing,
            playheadMs: session.playheadMs,
            selectedClipIds: session.selectedClipIds,
            selectedFlipbookVoid: session.selectedFlipbookVoid,
          },
          editCtx,
          view,
          onion,
        );
      }

      // ISOLATION SCRIM. Everything outside the area you're editing dims — one
      // sheet of glass with the target's own quad punched out of it, drawn in
      // WORLD space so it follows the instance's rotation, scale and position
      // exactly. Unlike a per-frame fade this reads as a single unmistakable
      // "you are in here, that is out there", at any nesting depth, whether the
      // target is a whole artboard or a small rotated component inside one.
      if (editCtx && editCtx.depth > 0) {
        const q = targetQuad(editCtx).map((pt) => ({
          x: view.tx + pt.x * view.scale,
          y: view.ty + pt.y * view.scale,
        }));
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, rect.width, rect.height);
        ctx.moveTo(q[0]!.x, q[0]!.y);
        for (let i = q.length - 1; i >= 1; i--) ctx.lineTo(q[i]!.x, q[i]!.y);
        ctx.closePath();
        ctx.fillStyle = "rgba(9,9,11,0.55)";
        ctx.fill("evenodd");
        // A hairline of the brand accent traces the live area — the visual
        // equivalent of the breadcrumb's last chip.
        ctx.beginPath();
        ctx.moveTo(q[0]!.x, q[0]!.y);
        for (let i = 1; i < q.length; i++) ctx.lineTo(q[i]!.x, q[i]!.y);
        ctx.closePath();
        ctx.strokeStyle = sceneInk().accent;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = SCENE.stroke;
        ctx.stroke();
        ctx.restore();
      }

      hitRectsRef.current = hits;
      stageHitRects.current = hits; // publish for the align toolbar / menus

      // ── CHROME ────────────────────────────────────────────────────────────
      // Everything from here on is the editor, not the picture: switch to the
      // full-resolution overlay (see `chromeCanvas`).
      if (chromeCanvas && chromeCtx) {
        const full = window.devicePixelRatio || 1;
        const cw = Math.max(1, Math.round(rect.width * full));
        const ch = Math.max(1, Math.round(rect.height * full));
        if (chromeCanvas.width !== cw || chromeCanvas.height !== ch) {
          chromeCanvas.width = cw;
          chromeCanvas.height = ch;
        }
        chromeCtx.setTransform(full, 0, 0, full, 0, 0);
        chromeCtx.clearRect(0, 0, rect.width, rect.height);
        ctx = chromeCtx;
      }

      // Ruler guides (teal) on the active frame + the one being dragged out.
      // Frame-local, so they ride with the artboard; span the canvas past the
      // rulers. Drawn under chrome so handles/snap-lines sit on top.
      // Page guides (D17) are drawn too: they live on the board, in canvas space.
      const guideFrame = docNow.frames.find((f) => f.id === session.activeFrameId) ?? pageFrames[0];
      const guidePage = guideOwner(docNow, session.activePageId ?? docNow.pages[0]?.id ?? "");
      if (guideFrame || guidePage || guideDraft.current) {
        const off = session.rulers ? RULER_SIZE : 0;
        // `pos` here is WORLD: each owner's origin is added by the caller.
        const drawGuide = (axis: "x" | "y", pos: number, color: string, dash: number[]) => {
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.setLineDash(dash);
          ctx.beginPath();
          if (axis === "x") {
            const sx = Math.round(view.tx + pos * view.scale) + 0.5;
            ctx.moveTo(sx, off);
            ctx.lineTo(sx, rect.height);
          } else {
            const sy = Math.round(view.ty + pos * view.scale) + 0.5;
            ctx.moveTo(off, sy);
            ctx.lineTo(rect.width, sy);
          }
          ctx.stroke();
          ctx.restore();
        };
        // The DRAFT is drawn even while guides are hidden — dragging one off
        // the ruler turns them back on the moment it lands (`guide-drag`), and
        // a drag with no line following the pointer reads as a broken ruler.
        if (session.rulerGuides) {
          for (const owner of [guidePage, guideFrame ? guideOwner(docNow, guideFrame.id) : null]) {
            if (!owner) continue;
            for (const gd of owner.guides) {
              const a = resolveGuideAppearance(gd, session.guideDefaultColor, session.guideDefaultStyle);
              drawGuide(gd.axis, guideLineWorld(owner, gd).pos, a.color, guideDashPattern(a.style));
            }
          }
        }
        const d = guideDraft.current;
        const dOwner = d ? guideOwner(docNow, d.frameId) : null;
        if (d && dOwner) {
          // The draft always dashes in the default colour so it reads as "not
          // placed yet" regardless of the default style.
          drawGuide(d.axis, guideLineWorld(dOwner, d).pos, session.guideDefaultColor, [4, 4]);
        }
      }

      // Pixel grid — over content, under chrome; only kicks in past 4× zoom.
      if (session.pixelGrid) drawPixelGrid(ctx, view, rect.width, rect.height);

      // Frame labels + selected frame outline (screen space, crisp).
      const labels: FrameLabelRect[] = [];
      ctx.save();
      ctx.font = frameLabelFont();
      for (const f of pageFrames) {
        // Isolation: only the focused frame keeps a title. Siblings behind the
        // glass draw none and — being absent from labelRects — can't be clicked
        // to select or drag them out of the drilled context.
        if (isoFocusId != null && f.id !== isoFocusId) continue;
        const sx = view.tx + f.x * view.scale;
        const sy = view.ty + f.y * view.scale;
        const label = frameLabelAnchor(f, view);
        const selected = session.selectedFrameIds.includes(f.id);
        // Resize handles only make sense for a lone frame; a multi-selection
        // just gets outlines (Figma shows a group box, but per-frame outlines
        // read clearly here and keep the resize math single-subject).
        const soloFrame = selected && session.selectedFrameIds.length === 1;
        // The label never runs past its frame (Figma's rule): zoomed out, the
        // size readout goes first, then the name truncates — neighbours'
        // titles used to print over each other.
        const room = Math.max(0, f.width * view.scale);
        const dims = `${f.width} × ${f.height}`;
        const text = fitFrameLabel(ctx, f.name, room);
        const tw = ctx.measureText(text).width;
        const showDims = text === f.name && tw + FRAME_LABEL_DIMS_GAP + ctx.measureText(dims).width <= room;
        // Being renamed: the field IS the label (`FrameRenameOverlay`), and the
        // size readout would sit under the name as it grows.
        if (renamingFrameRef.current !== f.id && text) {
          ctx.fillStyle = selected ? sceneInk().accent : sceneInk().muted;
          ctx.fillText(text, label.x, label.baseline);
          if (showDims) {
            ctx.globalAlpha = 0.6;
            ctx.fillStyle = sceneInk().muted;
            ctx.fillText(dims, label.x + tw + FRAME_LABEL_DIMS_GAP, label.baseline);
            ctx.globalAlpha = 1;
          }
        }
        labels.push({ frameId: f.id, x: label.x - 2, y: label.baseline - 14, w: tw + 8, h: 20 });

        if (selected) {
          const x0 = Math.round(sx) - 0.5;
          const y0 = Math.round(sy) - 0.5;
          const x1 = Math.round(sx + f.width * view.scale) + 0.5;
          const y1 = Math.round(sy + f.height * view.scale) + 0.5;
          strokeOutline(ctx, [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);
        }
        if (soloFrame) {
          // Resize handles (⇧ keeps aspect, ⌘ scales contents).
          for (const handle of FRAME_HANDLES) {
            const c = frameHandleCenter(f, handle, view);
            drawGrip(ctx, c.x, c.y);
          }
        }
      }
      ctx.restore();
      labelRectsRef.current = labels;

      const g = gesture.current;
      // A member being carried to a new slot: its container's chrome and the
      // bar where it would land.
      if (g.mode === "layout-reorder") {
        const geo = layoutGeometry(g.layoutGroupId, docNow);
        if (geo) drawLayoutChrome(ctx, geo, { accent: accentColor(), active: null, carried: g.layoutReorderClipId });
      }
      // Selection chrome. The W×H / X,Y readout only appears while the layer is
      // actively being moved (position) or resized (size) — never at rest.
      const single = session.selectedClipIds.length === 1;
      let readout: SelectionReadout = null;
      if (single) {
        if (g.mode === "resize") {
          readout = { kind: "size" };
        } else if (g.mode === "drag-layers" && g.moved) {
          const loc = locateClip(store.getState(), session.selectedClipIds[0]!);
          if (loc && loc.clip.kind !== "audio") {
            readout = { kind: "pos", x: loc.clip.transform.x, y: loc.clip.transform.y };
          }
        }
      }
      if (linkHoverRef.current) drawLinkHover(ctx, linkHoverRef.current.areas, view);
      // A small chain beside every link, so a link is never invisible (text
      // stays unstyled — ADR-links). Off while playing or mid-gesture.
      if (session.playing || g.mode !== "none") linkMarkersRef.current = [];
      else {
        let cache = linkMarkerCache.current;
        if (!cache || cache.hits !== hitRectsRef.current || cache.doc !== docNow) {
          cache = { hits: hitRectsRef.current, doc: docNow, markers: linkMarkers(linkAreasIn(docNow, hitRectsRef.current)) };
          linkMarkerCache.current = cache;
        }
        linkMarkersRef.current = cache.markers.length ? drawLinkMarkers(ctx, cache.markers, view, linkHoverRef.current) : [];
      }
      for (const id of session.selectedClipIds) {
        // A layer being TYPED IN keeps its box — same rect, same drawer, same
        // weight — and only loses its grab-dots (they would fight the caret).
        // The box used to be handed to the text overlay, which drew its own
        // ring at its own offset, so entering edit mode visibly re-framed the
        // layer. One box, one drawer, no jump.
        const typing = id === session.editingClipId;
        // Prefer the rect drawn by the frame you're editing in (the active host)
        // so a shared instance clip's box lands on the instance you clicked.
        const hit =
          hits.find((h) => h.clipId === id && h.hostFrameId === session.activeFrameId) ??
          hits.find((h) => h.clipId === id);
        // In point-edit mode (shape corners OR vector nodes) the transform box
        // hides — you're editing geometry, not the box. The point handles below
        // (or the VectorOverlay) are the only chrome.
        const inPointEdit = id === session.vectorEditClipId || id === session.shapeEditClipId;
        // Dashed box = a resize would edit the layer's own geometry (shape
        // width/height, text wrap) and leave radii/glyphs crisp; solid = it
        // would scale the whole object. During an active resize the gesture's
        // latched mode wins; otherwise it tracks the live ⌘/Ctrl state.
        const activeResize = g.mode === "resize" && id === g.resizeClipId;
        const dashed = activeResize
          ? g.resizeNativeKind !== null
          : (() => {
              const loc = locateClip(docNow, id);
              const nk = loc && loc.clip.kind !== "audio" ? nativeResizeKind(loc.clip) : null;
              return !!nk && !scaleModifierRef.current;
            })();
        // The clip in crop mode shows the crop overlay instead of the plain box;
        // a cropped clip shows the box around its VISIBLE (cropped) bounds.
        // A member being carried through its layout is drawn under the pointer;
        // its box would sit at the slot it is leaving, so it waits for the drop.
        const carried = g.mode === "layout-reorder" && g.moved && id === g.layoutReorderClipId;
        if (hit && !inPointEdit && !carried && id !== session.cropClipId) {
          drawSelection(ctx, croppedDisplayRect(id) ?? hit, view, single && !typing, typing ? null : readout, dashed);
        }
        // A text on a path: its host's outline as a guide, the grip that slides
        // it, and — while typing — the caret and selection on the curve. Drawn
        // whether or not the layer is being edited, because the grip is how the
        // words get to where you want them.
        if (single && session.tool === "select") {
          const loc = locateClip(docNow, id);
          if (loc && isPathText(loc.clip)) {
            drawTextPathChrome(ctx, loc.clip, {
              accent: accentColor(),
              sliding: g.mode === "path-slide" && g.pathSlideClipId === id,
              editing: typing ? (session.textSelection ?? { start: 0, end: 0 }) : null,
              caretLit: Math.floor(performance.now() / 530) % 2 === 0,
              playheadMs: session.playheadMs,
            });
            if (typing) scheduleCaretBlink();
          }
        }
        // A laid-out group: its slots, and the gap / padding pills.
        if (single && session.tool === "select") {
          const geo = layoutGeometry(id, docNow);
          if (geo) {
            drawLayoutChrome(ctx, geo, {
              accent: accentColor(),
              active: g.mode === "layout-handle" ? g.layoutHandle : null,
              hover: layoutHoverRef.current,
            });
          }
        }
        // Corner-radius dots + parametric shape handles on a single selected
        // shape (Figma's inset dots + arc/spike controls).
        if (hit && single && !typing && session.tool === "select") {
          const loc = locateClip(docNow, id);
          const sc = loc?.clip.kind === "shape" ? loc.clip : null;
          const frame = sc ? docNow.frames.find((f) => f.id === sc.frameId) : null;
          if (sc && frame) {
            const pose = shapePoseOf(sc, docNow, frame, paintedTimeFor(sc.frameId));
            const geo = shapeGeoFor(sc);
            if (session.shapeEditClipId === id) {
              // Corner-edit mode: draggable square nodes at each corner (on the
              // ANIMATED geometry so they track a keyframed corner/size). Other
              // handles hide so the focus is purely on moving points.
              // A SELECTED corner is filled with the accent (an empty one stays
              // white) — the same read as a vector node, so "what will the arrow
              // keys move" is answered by looking at the shape.
              const picked = cornerSelection(id);
              shapeCornerScreens(geo, pose, view).forEach((c, i) => {
                drawGrip(ctx, c.x, c.y, picked.has(i) ? "on" : "rest");
              });
            } else {
              for (const h of shapeRadiusHandles(geo, pose, view)) drawDot(ctx, h.x, h.y);
              // Ratio dots read as a hollow ring; arc/spike dots as filled.
              for (const h of shapeControlHandles(geo, pose, view)) drawDot(ctx, h.x, h.y, h.kind === "arc-ratio" ? "rest" : "on");
            }
          }
          // Box layers (image/video/nested/drawing) get the SAME rect corner-radius
          // dots — reusing rectRadiusHandles. Hidden in crop mode (crop owns the box).
          const boxT = loc && !sc && id !== session.cropClipId ? boxRadiusFor(loc.clip) : null;
          if (boxT) {
            for (const h of rectRadiusHandles(boxT.width, boxT.height, boxT.cornerRadius, boxT.pose, view)) drawDot(ctx, h.x, h.y);
          }
        }
      }

      // On-stage CROP overlay (Figma): the renderer already draws the full media
      // dimmed + the crop region crisp (cropPreviewClipId), so here we just draw
      // the chrome — a faint full-box outline (the extent you can bring back), the
      // crisp crop-rect outline, edge bars + corner brackets, and thin thirds
      // guides. ONE geometry brain (`cropGeom`) shared with hit-test + gesture.
      if (
        session.cropClipId &&
        session.selectedClipIds.includes(session.cropClipId) &&
        session.tool === "select"
      ) {
        const geo = cropGeom(session.cropClipId);
        if (geo) {
          // The PICTURE'S quad — `cropGeom.mediaRect`, which is the rectangle
          // the renderer paints (content transform included). Drawing the
          // authored box instead would put the dashed outline, the dim and the
          // grab targets in three different places the moment you reframed.
          const fNW = geo.mediaRect.nw;
          const fNE = geo.mediaRect.ne;
          const fSE = geo.mediaRect.se;
          const fSW = geo.mediaRect.sw;
          const cNW = geo.rect.nw;
          const cNE = geo.rect.ne;
          const cSE = geo.rect.se;
          const cSW = geo.rect.sw;
          // Faint full-box outline (the media you can bring back).
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = "rgba(255,255,255,0.4)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(fNW.x, fNW.y);
          ctx.lineTo(fNE.x, fNE.y);
          ctx.lineTo(fSE.x, fSE.y);
          ctx.lineTo(fSW.x, fSW.y);
          ctx.closePath();
          ctx.stroke();
          ctx.restore();
          // Crop rect outline + rule-of-thirds guides (Figma crop feel).
          ctx.save();
          ctx.strokeStyle = sceneInk().accent;
          ctx.lineWidth = SCENE.stroke;
          ctx.beginPath();
          ctx.moveTo(cNW.x, cNW.y);
          ctx.lineTo(cNE.x, cNE.y);
          ctx.lineTo(cSE.x, cSE.y);
          ctx.lineTo(cSW.x, cSW.y);
          ctx.closePath();
          ctx.stroke();
          ctx.globalAlpha = 0.35;
          for (let k = 1; k <= 2; k++) {
            const t = k / 3;
            const aTop = { x: cNW.x + (cNE.x - cNW.x) * t, y: cNW.y + (cNE.y - cNW.y) * t };
            const aBot = { x: cSW.x + (cSE.x - cSW.x) * t, y: cSW.y + (cSE.y - cSW.y) * t };
            const aLef = { x: cNW.x + (cSW.x - cNW.x) * t, y: cNW.y + (cSW.y - cNW.y) * t };
            const aRig = { x: cNE.x + (cSE.x - cNE.x) * t, y: cNE.y + (cSE.y - cNE.y) * t };
            ctx.beginPath();
            ctx.moveTo(aTop.x, aTop.y);
            ctx.lineTo(aBot.x, aBot.y);
            ctx.moveTo(aLef.x, aLef.y);
            ctx.lineTo(aRig.x, aRig.y);
            ctx.stroke();
          }
          ctx.restore();
          // The window's grips: the same squares as every resize handle.
          for (const h of geo.handles) drawGrip(ctx, h.pt.x, h.pt.y);
          // The picture's own corner grips — hollow, so they never read as the
          // window's solid handles. They are what you pull to resize the
          // FOOTAGE while the framing holds still.
          for (const pt of [fNW, fNE, fSE, fSW]) drawDot(ctx, pt.x, pt.y, "ghost");

          // TURN THE PICTURE — a quarter-arc just outside each of those grips,
          // in the band the drag actually reads. A rotate band is invisible
          // everywhere else in this app because a box's corners are a
          // convention people arrive with; the picture quad is not one, so the
          // affordance has to be drawn or nobody will ever find it.
          ctx.save();
          ctx.strokeStyle = "rgba(255,255,255,0.6)";
          ctx.lineWidth = SCENE.stroke;
          ctx.lineCap = "round";
          const pcx = geo.picCentre.x;
          const pcy = geo.picCentre.y;
          for (const pt of [fNW, fNE, fSE, fSW]) {
            const a = Math.atan2(pt.y - pcy, pt.x - pcx);
            // Mid-band, so the arc you aim at IS the ring that answers — see
            // `hitTestCropMediaRotate`, which starts where the grip stops.
            const r = HANDLE_HIT_PX + 3 + ROTATE_BAND_PX / 2;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, r, a - 0.75, a + 0.75);
            ctx.stroke();
          }
          ctx.restore();

          // A live verb badge under the box: which of the two things a drag
          // would move right now, and the key that swaps to the other. Crop mode
          // has two opposite gestures sharing one rectangle, so saying which one
          // is armed is the difference between "clever" and "discoverable".
          const verb = cropVerbAt(lastPointerRef.current, geo);
          if (verb) drawCropVerbBadge(ctx, [cNW, cNE, cSE, cSW], verb);
        }
      }

      /*
       * The PIVOT crosshair — After Effects' anchor point. Always visible for a
       * single selection so you can SEE what rotation and ⌥-resize turn about.
       *
       * TWO STATES, and the second one is the whole discoverability of the hold.
       * At rest it is a quiet white mark: present, not asking for anything. It
       * turns ACCENT, grows, fills and drops a tether to the box the
       * moment it owns the pointer — which is true in pivot mode, true while a
       * pivot drag is running, and true the instant a hold lands on it. Without
       * that last one the hold is a wait with no feedback, and a gesture nobody
       * can see arriving is a gesture nobody finds.
       */
      {
        const ph = pivotHandle();
        if (ph) {
          const active =
            session.pivotClipId === ph.clipId ||
            (g.pivotClipId === ph.clipId &&
              (g.mode === "move-pivot" || !!g.pivotHold?.ready()));
          // In-mode, a dashed tether runs back to the box centre, so a pivot
          // dragged far outside the layer still reads as belonging to it.
          const hit = active ? activeHit(ph.clipId) : null;
          drawPivot(ctx, ph.x, ph.y, active, hit ? { x: view.tx + hit.cx * view.scale, y: view.ty + hit.cy * view.scale } : null);
        }
      }

      // Gradient direct-manipulation handles (Figma): the axis/ring + endpoints
      // + draggable stop dots for whichever gradient paint is open for editing.
      {
        const grad = activeGradient();
        if (grad) drawGradientOverlay(ctx, grad.model, view, session.activeGradientStopId, (c) => resolveColor(docNow, c));
      }

      // Group bounding box + resize handles around a multi-selection (Figma).
      // Each clip already drew its own thin outline above; this adds the shared
      // box you grab to scale them all together.
      if (session.selectedClipIds.length > 1) {
        const box = selectionGroupBox(session.selectedClipIds, hits);
        if (box) {
          drawSelection(
            ctx,
            { clipId: "", frameId: "", hostFrameId: "", cx: box.cx, cy: box.cy, width: box.hw * 2, height: box.hh * 2, rotation: 0, skewX: 0, skewY: 0, depth: 0 },
            view,
            true,
            g.mode === "resize-group" ? { kind: "size" } : null,
          );
        }
      }

      // Motion paths — the selected clips' position keyframes drawn as an
      // editable spatial curve (View-gated). The scene built here doubles as
      // the pointer handlers' hit model, so paint and gestures can't disagree.
      motionSceneRef.current = null;
      if (
        session.motionPaths &&
        session.tool === "select" &&
        !session.vectorEditClipId &&
        !session.shapeEditClipId &&
        !session.editingClipId &&
        session.selectedClipIds.length > 0
      ) {
        const scene = buildMotionScene(docNow, session.selectedClipIds, view, session.playheadMs);
        if (scene.paths.length > 0) {
          // Hit-test against the scene we're about to paint, so the mark that
          // lights up under the pointer is exactly the one a press would grab —
          // and hovering the curve offers its insert badge. Suppressed mid-drag,
          // where the gesture already owns what's highlighted.
          const idle = g.mode === "none";
          const hover = idle ? hitMotionScene(scene, lastPointerRef.current) : null;
          paintMotionScene(ctx, scene, hover, idle ? lastPointerRef.current : null);
          motionSceneRef.current = scene;
        }
      }

      // Rotation dial ("clock") while actively turning a selection — the
      // satisfying gauge that fills as you spin and stacks a ring per turn.
      if (g.mode === "rotate" && g.rotateClips.length > 0) {
        const scx = view.tx + g.rotateCx * view.scale;
        const scy = view.ty + g.rotateCy * view.scale;
        const primHit = activeHit(g.rotateClips[0]!.id);
        // Hug the layer, but keep the dial in a comfortable on-screen range.
        const radius = primHit
          ? Math.max(46, Math.min(120, (Math.hypot(primHit.width, primHit.height) * view.scale) / 2 + 22))
          : 60;
        drawRotationDial(ctx, {
          cx: scx,
          cy: scy,
          radius,
          totalDeg: g.rotatePrimaryStart + g.rotateAppliedDelta,
          snapping: g.rotateSnapping,
        });
      }

      // …and the SAME dial when the thing turning is the picture inside a crop.
      // The gauge, the rings per revolution and the ⇧ tick marks are the one
      // `drawRotationDial`; only the centre it hugs is different.
      if (g.mode === "crop-rotate") {
        const geo = cropGeom(g.cropClipId);
        if (geo) {
          const w = Math.hypot(geo.mediaRect.ne.x - geo.mediaRect.nw.x, geo.mediaRect.ne.y - geo.mediaRect.nw.y);
          const h = Math.hypot(geo.mediaRect.sw.x - geo.mediaRect.nw.x, geo.mediaRect.sw.y - geo.mediaRect.nw.y);
          drawRotationDial(ctx, {
            cx: geo.picCentre.x,
            cy: geo.picCentre.y,
            radius: Math.max(46, Math.min(120, Math.hypot(w, h) / 2 + 22)),
            totalDeg: geo.content.rotation,
            snapping: g.rotateSnapping,
          });
        }
      }

      // Gesture overlays (marquee / frame draft).
      if (g.mode === "marquee") {
        drawMarquee(ctx, normRect(g.marqueeStart, g.marqueeEnd));
      }
      if (g.mode === "draw-frame") {
        const a = worldToScreen(g.frameStart, view);
        const b = worldToScreen(g.frameEnd, view);
        const r = normRect(a, b);
        strokeOutline(
          ctx,
          [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }],
          [4, 4],
        );
        const w = Math.round(Math.abs(g.frameEnd.x - g.frameStart.x));
        const h = Math.round(Math.abs(g.frameEnd.y - g.frameStart.y));
        drawReadout(ctx, `${w} × ${h}`, r.x + r.w / 2, r.y + r.h + 8);
      }
      if (g.mode === "draw-shape") {
        const rect = shapeDrawRect(g.frameStart, g.frameEnd, g.shapeSquare, g.shapeFromCenter);
        const c = worldToScreen({ x: rect.cx, y: rect.cy }, view);
        const sw = Math.max(1, rect.w * view.scale);
        const sh = Math.max(1, rect.h * view.scale);
        ctx.save();
        ctx.strokeStyle = sceneInk().accent;
        ctx.fillStyle = sceneInk().accent;
        ctx.lineWidth = SCENE.stroke;
        const geo = SHAPE_TOOL_GEOMETRY[g.shapeKind];
        const preview = commandsToPath2D(
          shapeCommands({
            shape: geo.shape,
            width: sw,
            height: sh,
            cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
            radius: 0,
            pointCount: geo.pointCount,
            innerRatio: 0.5,
          }),
        );
        ctx.translate(c.x, c.y);
        ctx.globalAlpha = 0.12;
        ctx.fill(preview);
        ctx.globalAlpha = 1;
        ctx.stroke(preview);
        ctx.restore();
      }

      if (g.mode === "draw-text") {
        const a = worldToScreen(g.frameStart, view);
        const b = worldToScreen(g.frameEnd, view);
        const r = normRect(a, b);
        ctx.save();
        ctx.strokeStyle = sceneInk().accent;
        ctx.lineWidth = SCENE.stroke;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.restore();
      }

      // SHARED HOVER (D20): the hovered layer — from a Layers row or the stage
      // itself — gets Figma's hover outline, 1px accent, unless it is already
      // selected (the selection chrome says more). Only while idle.
      {
        const hv = useHoverLink.getState().id;
        if (hv && g.mode === "none" && !session.selectedClipIds.includes(hv)) {
          const hr = stageHitRects.current.find((h) => h.clipId === hv);
          if (hr) {
            strokeOutline(ctx, hitCorners(hr).map((c) => worldToScreen(c, view)));
          }
        }
      }

      // Smart guides — the last chrome, over everything (`scene-chrome`).
      drawSnapLines(ctx, activeGuidesRef.current, view);

      // ⇧-constrain axis: a dashed accent line through the moving selection at
      // the locked angle, so the axis you're constrained to is visible (Figma).
      const axis = constrainAxisRef.current;
      if (axis) {
        const sx = view.tx + axis.cx * view.scale;
        const sy = view.ty + axis.cy * view.scale;
        const a = (axis.angleDeg * Math.PI) / 180;
        const L = 4000;
        ctx.save();
        ctx.strokeStyle = sceneInk().snap;
        ctx.lineWidth = SCENE.stroke;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(Math.round(sx - Math.cos(a) * L) + 0.5, Math.round(sy - Math.sin(a) * L) + 0.5);
        ctx.lineTo(Math.round(sx + Math.cos(a) * L) + 0.5, Math.round(sy + Math.sin(a) * L) + 0.5);
        ctx.stroke();
        ctx.restore();
      }

      // Hand the measured cost to the governor. Only `auto` acts on it (a
      // pinned tier returns immediately), and only the STAGE reports — an
      // export is not a preview and must never talk itself down a tier.
      // Still gliding — draw the next frame too.
      if (layoutMotionActive()) dirtyRef.current = true;
      renderProfiler.frame(performance.now() - frameStartMs, previewScale);
      const budgetFrame = editCtx?.target ?? docNow.frames.find((f) => f.id === session.activeFrameId);
      if (!exactRunNow) useSession.getState().reportFrameCost(
        performance.now() - frameStartMs,
        budgetFrame ? frameFps(docNow, budgetFrame) : 30,
        transport,
      );
    };
    raf = requestAnimationFrame(frame);
    // A face finishing its load is polled by the tick (`fontsVersion`): wake it to look.
    const unsubFonts = subscribeFonts(wake);
    return () => {
      cancelAnimationFrame(raf);
      wakeRef.current = () => {};
      unsubFonts();
      ro.disconnect();
      for (const u of unsubs) u();
    };
  }, [store, fit]);

  // Track ⌘/Ctrl so the selection chrome can switch dashed↔solid the instant the
  // key is pressed/released (even with no pointer motion). Window blur clears it
  // so a tab-switch never leaves the modifier stuck on.
  React.useEffect(() => {
    const sync = (held: boolean) => {
      if (held !== scaleModifierRef.current) {
        scaleModifierRef.current = held;
        dirtyRef.current = true;
        // ⌘ turns links live under a STILL pointer — the cursor says so now.
        refreshCursorRef.current?.();
      }
    };
    const onKey = (e: KeyboardEvent) => sync(e.metaKey || e.ctrlKey);
    const onBlur = () => sync(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // ── Interaction state ──────────────────────────────────────────────────────
  /**
   * Which of a shape's CORNERS are selected in corner-edit mode.
   *
   * Corners had no selection at all — you grabbed one and dragged it, which is
   * enough for a mouse and useless for a keyboard. Pressing a corner now selects
   * it (⇧ adds), exactly like a vector node: that is what makes the filled dot
   * mean something and what the arrow keys move. Kept beside the clip it belongs
   * to, so a selection left over from another shape is stale by construction
   * instead of by remembering to clear it.
   */
  const cornerSel = React.useRef<{ clipId: string; idx: Set<number> }>({ clipId: "", idx: new Set() });
  /** The live corner selection for `clipId` — empty when it belongs elsewhere. */
  const cornerSelection = (clipId: string): ReadonlySet<number> =>
    cornerSel.current.clipId === clipId ? cornerSel.current.idx : EMPTY_CORNERS;

  /**
   * Arrow-key nudge of the selected CORNERS — the keyboard half of a corner drag.
   *
   * Same shape as the vector-node nudge (`VectorOverlay`): a WORLD delta folded
   * into the shape's own space through the one layer map, so the corner travels
   * the way you pressed however the layer is rotated or squashed, and written
   * with `commitProperty` so it keys and interpolates exactly like the drag does.
   * The offset it adds to is the EFFECTIVE one — read the value on screen, not
   * the resting one, or a keyed corner would jump back to its base on the first
   * press.
   */
  const nudgeShapeCorners = React.useCallback(
    (dxWorld: number, dyWorld: number): boolean => {
      const session = useSession.getState();
      const id = session.shapeEditClipId;
      if (!id) return false;
      const picked = [...cornerSelection(id)];
      if (picked.length === 0) return false;
      const loc = locateClip(store.getState(), id);
      if (loc?.clip.kind !== "shape") return false;
      const playhead = session.playheadMs;
      const pose = clipPose(loc.clip, clipLocalClamped(loc.clip, playhead));
      const d = unmapLinear(dxWorld, dyWorld, pose);
      store.update(
        "Nudge corner",
        (doc) => {
          const l = locateClip(doc, id);
          if (l?.clip.kind !== "shape") return;
          for (const i of picked) {
            for (const [axis, delta] of [
              ["x", d.x],
              ["y", d.y],
            ] as const) {
              if (delta === 0) continue;
              const path = `corner.${i}.${axis}`;
              const base = (getClipProperty(l.clip, path) as number | undefined) ?? 0;
              commitProperty(l.clip, path, effectiveValue(l.clip, path, base, playhead) + delta, playhead);
            }
          }
        },
        // Repeated presses coalesce into one undo step, like every other nudge.
        { mergeKey: `corner-nudge-${id}` },
      );
      return true;
    },
    [store],
  );

  React.useEffect(
    () => nudgeTargets.register({ nudge: (dx, dy) => nudgeShapeCorners(dx, dy) }),
    [nudgeShapeCorners],
  );

  // Entering or leaving corner-edit starts with a clean selection — the same
  // fresh start node-edit gives you, rather than resurrecting whatever corner
  // you happened to grab last time you were in here.
  React.useEffect(
    () =>
      useSession.subscribe((s, prev) => {
        if (s.shapeEditClipId !== prev.shapeEditClipId) cornerSel.current = { clipId: "", idx: new Set() };
      }),
    [],
  );

  const gesture = React.useRef({
    mode: "none" as GestureMode,
    pointers: new Map<number, { x: number; y: number }>(),
    dragStart: { x: 0, y: 0 }, // screen
    dragOrigins: new Map<string, { x: number; y: number }>(),
    // Layer-drag: the ORIGINAL selection + its base poses (kept fixed for the
    // whole gesture) so ⌥ can duplicate/undo-duplicate in real time — when
    // duplicating, the originals hold at base and the COPIES ride `dragOrigins`.
    dragBaseIds: [] as string[],
    dragBaseOrigins: new Map<string, { x: number; y: number }>(),
    /** Live duplicate ids while ⌥ is held mid-drag, else null. */
    dupIds: null as string[] | null,
    /**
     * The selection a press that never moves resolves to — grab priority's
     * retarget and ⇧'s toggle, decided at release (`resolvePressSelection`).
     */
    selectOnClick: null as { ids: string[]; hostFrameId: string } | null,
    /** Teardown for the live ⇧/⌥ modifier watcher (set per drag). */
    modWatch: null as null | (() => void),
    mergeKey: "",
    marqueeStart: { x: 0, y: 0 }, // screen
    marqueeEnd: { x: 0, y: 0 },
    marqueeBase: [] as string[],
    /** This marquee selects FRAMES (started over empty canvas), not clips. */
    marqueeFrames: false,
    frameStart: { x: 0, y: 0 }, // world
    frameEnd: { x: 0, y: 0 },
    shapeKind: "rect" as ShapeTool,
    shapeSquare: false,
    /** ⌥ while drawing: the start point is the CENTER, so the shape grows
     *  symmetrically instead of from a corner (Figma/Blender). */
    shapeFromCenter: false,
    radiusClipId: "",
    radiusCorner: "all" as RadiusCorner,
    radiusIndependent: false,
    /** The radius drag targets a box layer's `borderRadius` (vs a shape's radius). */
    radiusIsBox: false,
    // Relative radius drag: the corner's radius at grab + the pointer's inward
    // distance from the corner at grab, so the drag adds a delta (grab never
    // jumps the value, even when the dot was pushed out to its min grab gap).
    radiusStart: 0,
    radiusInward0: 0,
    shapeHandleClipId: "",
    shapeHandleKind: "arc-sweep" as ShapeHandleKind,
    shapeCornerClipId: "",
    shapeCornerIndex: 0,
    /** Gradient handle drag: which knob/stop + the paint's keyframe prefix. */
    gradientKind: { kind: "start" } as GradientHandleHit,
    gradientPrefix: "",
    gradientStopId: "",
    frameDragId: "",
    frameOrigin: { x: 0, y: 0 },
    // Every frame moving in this drag-frame gesture (all selected frames), with
    // its start origin. frameDragId is the grabbed one (drives nest-on-drop).
    frameDrags: [] as Array<{ id: string; ox: number; oy: number }>,
    frameHandle: "se" as FrameHandle,
    frameStartRect: { x: 0, y: 0, w: 0, h: 0 },
    // Smart-guide snapping for the active gesture: the candidate lines (built
    // once at gesture start — siblings/page don't move mid-drag) and the moving
    // selection's world box at start (drag adds its delta to this, then snaps).
    snapCandidates: null as SnapCandidates | null,
    dragStartBox: null as AABB | null,
    // Moving an existing ruler guide (drag it to reposition, or onto the ruler /
    // off the artboard to delete).
    guideMoveFrameId: "",
    guideMoveId: "",
    guideMoveAxis: "x" as "x" | "y",
    guideDeletePending: false,
    // Motion-path editing: which clip/key the gesture holds, the tangent end
    // being steered, and (for bend) the grabbed segment snapshotted at press —
    // total-delta math against a fixed base keeps the drag stable.
    motionClipId: "",
    motionTimeMs: 0,
    motionEnd: "out" as "in" | "out",
    /**
     * True when this handle drag began as ⌥-drag on an ANCHOR — the "pull fresh
     * handles out of a corner" gesture, which is symmetric by definition and so
     * pairs its arms no matter what ⌥ does for the rest of the drag.
     */
    motionFreshHandles: false,
    /** What the shared tangent-drag brain froze at press (was the pair balanced). */
    motionDrag: { symmetric: false } as TangentDragStart,
    /** Latched once the pointer travels — a click's jitter must not edit the path. */
    motionMoved: false,
    motionSeg: null as null | { a: MotionKey; b: MotionKey; u: number; start: { x: number; y: number } },
    resizeClipId: "",
    resizeStartScale: 1,
    // Non-uniform (free) resize: start Y-scale, the box's start half-extents in
    // its OWN axes, its center + rotation. Free by default; ⇧ locks the aspect.
    resizeStartScaleY: 1,
    resizeStartHalfBoxW: 1,
    resizeStartHalfBoxH: 1,
    resizeCx: 0,
    resizeCy: 0,
    resizeRot: 0,
    // Which corner is grabbed, as a sign along the box's own axes (−1/+1). The
    // OPPOSITE corner is the anchor that stays fixed (Figma); ⌥ anchors center.
    resizeCornerSx: 1,
    resizeCornerSy: 1,
    // Start pose position (frame-relative) — a resize also shifts x/y so the
    // anchor corner holds still while the box grows.
    resizeStartX: 0,
    resizeStartY: 0,
    /** The clip's scaleY was null (mirroring scale) when the drag began. */
    resizeScaleYWasNull: true,
    /**
     * The layer's PIVOT (normalized) and the box it is a fraction of at grab
     * time. `transform.x/y` positions the PIVOT, not the box centre, so a resize
     * that changes the scale or the box size also moves the pivot→centre offset —
     * `pivotDrift` corrects for exactly that. Both are the identity for a centred
     * pivot, which is why the plain centre delta was right until pivots existed.
     */
    resizeAnchor: CENTER_ANCHOR as AnchorPoint,
    resizeStartSize: { width: 1, height: 1, cx: 0, cy: 0 } as LayerBox,
    /**
     * The pivot ⌥ resizes about, in the gesture's own space — the layer's
     * position for a leaf, its placed box pivot for a group (`positionOrigin`).
     */
    resizePivot: { x: 0, y: 0 },
    /**
     * World → the space this resize measures in, captured at the press:
     * `layerSpace`'s, i.e. the comp chain AND every enclosing group. Null only
     * when the layer cannot be placed at all, where world is the best answer
     * left. See the press handler for why it is captured rather than re-derived.
     */
    resizeSpace: null as { fromWorld: (p: { x: number; y: number }) => { x: number; y: number } } | null,
    /** The layer's shear at grab time — part of the linear map `pivotDrift` uses. */
    resizeSkewX: 0,
    resizeSkewY: 0,
    // Pivot drag (only in pivot mode): the layer's pose and box at grab time, so
    // the compensating position write can be derived from the pivot's new spot.
    pivotClipId: "",
    pivotStartPose: null as StagePose | null,
    pivotSize: { width: 1, height: 1, cx: 0, cy: 0 } as LayerBox,
    /** How THIS layer's pivot behaves — see core `pivotModel`. */
    pivotModel: null as PivotModel | null,
    /**
     * The pivot's bid for a press it does not own yet — see the press handler.
     * Non-null means the crosshair was pressed OUTSIDE pivot mode: whatever
     * gesture took the press is provisional until this resolves.
     */
    pivotHold: null as HeldDrag | null,
    pivotMergeKey: "",
    /** The text being slid along its path, and the lap the slide began on. */
    pathSlideClipId: "",
    pathSlideNear: 0,
    /** A container resize: the box's corner (`layout.x/y`) and centre at the press. */
    layoutStartCorner: { x: 0, y: 0 },
    layoutStartCentre: { x: 0, y: 0 },
    /** The gap / padding pill being dragged, its group, and the value it started at. */
    layoutHandle: null as LayoutHandle | null,
    layoutGroupId: "",
    layoutHandleStart: 0,
    layoutHandleStartWorld: { x: 0, y: 0 },
    /** A member being carried: where it would land, for the bar and the drop. */
    layoutReorderClipId: "",
    /**
     * A member being carried to another slot. `slots` / `order` are the layout
     * as it was at the press: the target is the nearest ORIGINAL slot, so the
     * answer cannot flicker while the others glide out of the way.
     */
    layoutReorder: null as null | {
      press: { x: number; y: number };
      grab: Vec2;
      grabSlot: Vec2;
      slots: LayoutSlotView[];
      order: string[];
      fromIndex: number;
      index: number;
      mergeKey: string;
    },
    pivotSnap: null as SnapCandidates | null,
    /** Inverse of the enclosing groups' delta, for reading the pointer. */
    pivotChainInverse: null as Mat2D | null,
    /** Where the pivot was PAINTED when the drag began (world) — the origin the
     *  pointer offset is measured from, correct at any nesting depth. */
    pivotStartWorld: { x: 0, y: 0 },
    // Native (geometry) resize mode for this drag — one source of truth from
    // `nativeResizeKind`, gated by ⌘/Ctrl (held = scale as an object instead).
    // "shape" edits width/height, "text" edits the wrap box, null scales.
    resizeNativeKind: null as "shape" | "text" | "layout" | null,
    // Start geometry for a native resize: text wrap width, or a shape's own
    // width/height (sampled at the playhead so a keyframed size drags true).
    resizeStartWidth: 0,
    resizeStartHeight: 0,
    /**
     * The text box was already Fixed-size (maxHeight set) when the drag began.
     * A height drag only resizes an already-Fixed box; an auto box never gains a
     * fixed height by dragging (it grows with content and never clips — Fixed is
     * opt-in via the Sizing panel).
     */
    resizeTextFixed: false,
    /**
     * The mirror signs a NATIVE-geometry resize has already applied. Geometry
     * (a shape's width, a text box's wrap width) never goes negative, so a drag
     * that crosses its own anchor grows the geometry back out and flips the
     * layer by negating its transform scale on that axis. Latching the applied
     * signs here means the scale is written only on the frame the flip actually
     * crosses — not on every pointermove — so a native resize adds no scale
     * churn to history and no keyframe spam while recording.
     */
    resizeMirrorX: 1 as 1 | -1,
    resizeMirrorY: 1 as 1 | -1,
    // Skew (⌘/Ctrl + drag an edge): shear the layer about its center. `skewAxis`
    // says which angle the grabbed edge drives; `skewDenom` is the signed world
    // half-extent the edge sits at, so pointer travel along the box's own axis
    // maps straight to a shear tangent. `skewRot` deskews the pointer into the
    // box's rotated frame; `skewStartTan` is the tangent at grab (deltas add to
    // it so the edge tracks the pointer exactly).
    skewClipId: "",
    skewAxis: "x" as "x" | "y",
    skewRot: 0,
    skewDenom: 1,
    skewStartTan: 0,
    skewStartWorld: { x: 0, y: 0 },
    // Crop (on-stage visual crop): the grabbed edge/corner, the insets at grab
    // time, the clip's natural box size + rotation (so pointer travel projects
    // onto the box's own axes and maps 1:1 to box-local px), and the world grab
    // point. Insets are clamped so opposite sides never cross.
    cropClipId: "",
    cropSide: "" as "" | CropSide,
    /** The whole framing at the (re)base: window insets AND content offset. */
    cropStart: { ...NO_CROP } as CropInsets,
    /** Visual box side → document inset, so a mirrored layer crops the edge you grabbed. */
    cropInsets: cropInsetMap(1, 1),
    cropNatW: 1,
    cropNatH: 1,
    cropScaleX: 1,
    cropScaleY: 1,
    cropRot: 0,
    cropStartWorld: { x: 0, y: 0 },
    /** The layer's position at the (re)base — moving the picture moves the layer. */
    cropStartPos: { x: 0, y: 0 },
    /**
     * Which gesture the PRESS meant. ⌥ inverts it live, so the modifier always
     * reads as "do the other one" no matter where you started the drag.
     */
    cropPressMode: "crop-pan" as "crop-pan" | "crop-content" | "crop-zoom",
    /** The picture's placement at press — what a reframe drag is measured from. */
    cropContentStart: { ...NO_CONTENT } as ContentTransform,
    /** Which corner of the PICTURE quad is being pulled — the resize handle. */
    cropZoomCorner: "se" as "nw" | "ne" | "se" | "sw",
    /** Mirror signs, so a flipped layer's picture still follows the pointer. */
    cropContentSign: { x: 1, y: 1 },
    // Group (multi-select) resize: the world box at grab time, plus each clip's
    // start pose + its frame center — so every layer scales about the group
    // center, preserving relative layout (Figma group scale).
    groupCx: 0,
    groupCy: 0,
    groupHw: 1,
    groupHh: 1,
    /** Grabbed corner sign in the group box's axes — carries the mirror. */
    groupSx: 1 as HandleSign,
    groupSy: 1 as HandleSign,
    groupClips: [] as Array<{
      id: string;
      fcx: number;
      fcy: number;
      x0: number;
      y0: number;
      s0: number;
      sy0: number;
      syNull: boolean;
    }>,
    // Rotation: the world pivot every selected layer turns about, the pointer
    // angle at grab + last move (to accumulate infinite turns), the running
    // signed delta, and the primary layer's start angle (drives snap + the dial).
    // Each entry keeps its start rotation and its offset from the pivot so a
    // group turns as a rigid body; a single layer has dx=dy=0 (spins in place).
    rotateCx: 0,
    rotateCy: 0,
    /** The shared angle recognizer for THIS drag — see `beginRotate`. */
    rotateTracker: null as RotateTracker | null,
    rotatePrimaryStart: 0,
    rotateAppliedDelta: 0,
    /** Which way the grabbed corner faced at the press; the cursor is this plus the turn so far. */
    rotateBearing: 0,
    rotateSnapping: false,
    rotateClips: [] as Array<{
      id: string;
      rot0: number;
      x0: number;
      y0: number;
      dx: number;
      dy: number;
    }>,
    moved: false,
  });

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const toWorld = (p: { x: number; y: number }) => {
    const view = useStageView.getState();
    return { x: (p.x - view.tx) / view.scale, y: (p.y - view.ty) / view.scale };
  };

  /**
   * Snap candidates for a gesture inside `frameId`: every OTHER layer on that
   * frame (edges + centers) plus the frame itself (edges + center), per the
   * guide settings. Built ONCE per gesture from the current hit rects — siblings
   * and the page don't move while you drag. Built regardless of the guides
   * toggle so that flipping snapping ON mid-drag (S) engages immediately, with
   * no drop-and-regrab; each pointer-move re-checks the LIVE `guides` flag.
   */
  const buildStageCandidates = (
    excludeIds: Set<string>,
    frameId: string,
    includeGuides = true,
  ): SnapCandidates | null => {
    const session = useSession.getState();
    const targets: AABB[] = [];
    for (const h of hitRectsRef.current) {
      // Depth 0: a layer inside a nested comp is not a sibling of the thing
      // being dragged, so it is not something to snap to.
      if (h.depth !== 0 || h.frameId !== frameId || excludeIds.has(h.clipId)) continue;
      targets.push(hitAABB(h));
    }
    const f = store.getState().frames.find((fr) => fr.id === frameId);
    const page: AABB | null = f ? { minX: f.x, minY: f.y, maxX: f.x + f.width, maxY: f.y + f.height } : null;
    // Ruler guides on this frame become snap lines too (gated by the toGuides
    // switch inside buildSnapCandidates) — layers click onto guides you pulled.
    // Excluded when MOVING a guide (a guide never snaps to itself/siblings),
    // and when the guides are HIDDEN: an invisible magnet is the worst kind.
    // Page guides (D17) snap everything on the board, frame or not.
    const docS = store.getState();
    const guides: GuideLine[] =
      includeGuides && session.rulerGuides
        ? [
            ...(f ? guideLinesOf(guideOwner(docS, f.id)) : []),
            ...guideLinesOf(guideOwner(docS, (f ? pageOfFrame(docS, f) : null) ?? session.activePageId ?? docS.pages[0]?.id ?? "")),
          ]
        : [];
    return buildSnapCandidates(targets, page, session.guideSettings, guides);
  };

  /** Clear the flashed guide lines (gesture ended / no snap this frame). */
  const clearGuides = () => {
    const g = activeGuidesRef.current;
    if (g.v.length || g.h.length) {
      activeGuidesRef.current = { v: [], h: [] };
      dirtyRef.current = true;
    }
  };

  /**
   * THE hit stack under a point — every clip whose PIXELS the pointer is over,
   * TOPMOST FIRST. Every stage gesture reads its target from here, so "what is
   * under the cursor?" has exactly one answer.
   *
   * A box is where a layer MIGHT be; the stack is where it IS. Three rules
   * decide the difference, and each lives in a headless core function so the
   * stage only supplies geometry:
   *  • LOCKED layers are transparent (Figma): they can't be grabbed and must
   *    never block the layer beneath — a locked backdrop used to turn every
   *    click over it into a marquee. `includeLocked` is for the right-click
   *    menu, the one surface that still has to target them (to unlock).
   *  • MASKED-AWAY pixels are nobody's (`layerShowsAt`): the part of a layer
   *    its mask cut off is not in the stack at all — you click the layer you
   *    can see through the hole. A stencil is a matte: reachable, but only
   *    once nothing that genuinely shows there has claimed the press.
   *  • HOLLOW layers own their stroke, not their inside (`isHollowVector`):
   *    the interior of a fill-less rectangle falls through to what is under
   *    it, and is reachable as the last resort so a lone outline over empty
   *    canvas is still one click away.
   * The last two share one shape — a FALLBACK tier behind the visible hits —
   * so the top of the stack is always something you are actually looking at.
   *  • the grab slop is a constant number of SCREEN px, converted to world.
   *    A fixed world slop was a 30px halo when zoomed out (stealing clicks
   *    from small neighbours) and a hairline when zoomed in.
   */
  const hitStackAt = (
    screen: { x: number; y: number },
    includeLocked = false,
  ): ClipHitRect[] => {
    const w = toWorld(screen);
    const scale = useStageView.getState().scale;
    const slop = HIT_SLOP_PX / scale;
    const doc = store.getState();
    const visible: ClipHitRect[] = [];
    const fallback: ClipHitRect[] = [];
    const hits = hitRectsRef.current;
    // The mask probes, built lazily — most presses never meet a composite group.
    let resolved: MotionDocument | null | undefined;
    const rectOf = (id: string) => hits.find((h) => h.clipId === id);
    const insideSilhouette = (id: string): boolean => {
      const loc = locateClip(doc, id);
      if (loc?.clip.kind === "group") return clipsUnderGroup(doc, id).some(insideSilhouette);
      const r = rectOf(id);
      if (!r || !pointInRotatedRect(w, r, 0)) return false;
      // A shape's or path's silhouette is its outline, not its box: the
      // corners outside a circular mask are exactly the pixels it cut away.
      if (isPathHost(loc?.clip)) {
        resolved ??= stageDoc();
        const hs = hostSpaceOf(id, resolved);
        if (hs) return pointInPolylines(hs.toLocal(w), hs.polylines);
      }
      return true;
    };
    const probe = { painted: (id: string) => !!rectOf(id), inside: insideSilhouette };
    // Is the press inside a hollow layer's outline but OFF its stroke?
    const throughHollow = (h: ClipHitRect, clip: Clip): boolean => {
      if (!isHollowVector(clip)) return false;
      resolved ??= stageDoc();
      const hs = hostSpaceOf(clip.id, resolved);
      if (!hs) return false;
      // Distance to the LINE, not "inside the outline": an ellipse's box
      // corners and an open pen stroke's empty box are through-pixels too.
      const hit = nearestOnOutline(hs.polylines, hs.toLocal(w));
      if (!hit) return false;
      const reach = hollowStrokeReach(clip, sampleKeyframes(clip.keyframes, clipLocalClamped(clip, useSession.getState().playheadMs)));
      return hit.dist > reach + HIT_SLOP_PX * hs.pxToLocal;
    };
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i]!;
      // Depth 0 only. A nested comp's layers now HAVE world boxes (so a piece
      // selected in the Layers panel gets its gizmo), but one click selects the
      // outermost thing — Figma's rule, and the reason a click on a component
      // instance still picks the instance rather than a letter inside it.
      // Double-click drills, as it always has.
      if (h.depth !== 0) continue;
      if (!pointInRotatedRect(w, h, slop)) continue;
      const loc = locateClip(doc, h.clipId);
      // A GROUP has a rect so it can wear a selection box and a gizmo, but a
      // rect is a BOX and a group is its contents: clicking the empty space
      // inside a union's bounds must fall through to whatever is actually
      // under the cursor, the way it always has. You select a group by
      // clicking its artwork or from the Layers panel.
      if (!loc) continue;
      if (loc.clip.kind === "group") {
        // …except an AUTO LAYOUT box, which is a thing of its own: it paints
        // its fill and stroke across that whole rect, so its whole area is
        // its to be clicked (Figma selects a frame wherever you click inside
        // it). With nothing painted it is the last resort, behind anything
        // that genuinely shows there.
        if (!loc.clip.layout || (!includeLocked && isClipLocked(loc.track, loc.clip))) continue;
        const paints = loc.clip.fills.some((f) => f.enabled) || loc.clip.strokes.some((st) => st.enabled);
        (paints ? visible : fallback).push(h);
        continue;
      }
      if (!includeLocked && isClipLocked(loc.track, loc.clip)) continue;
      const shows = layerShowsAt(doc, h.clipId, probe);
      if (shows.matte) fallback.push(h);
      else if (!shows.visible) continue;
      else if (throughHollow(h, loc.clip)) fallback.push(h);
      else visible.push(h);
    }
    return visible.concat(fallback);
  };

  /**
   * WHICH LAYER a library drop would land on — the topmost layer under the
   * point that this particular item can actually modify.
   *
   * "Topmost" alone was the wrong question: it outlined a shape for a text
   * template and an audio layer for an animation, then the commit refused and
   * the drop read as broken. Asking the SHARED predicate here means the
   * highlight and the edit are the same sentence, and it falls THROUGH a layer
   * that cannot take the item to the one beneath that can — which is what
   * aiming at a stack should do.
   */
  const layerDropTargetAt = (
    p: { x: number; y: number },
    drag: NonNullable<LibraryDrag>,
  ): ClipHitRect | null => {
    const doc = store.getState();
    return hitStackAt(p).find((h) => libraryDropAppliesTo(doc, drag, h.clipId)) ?? null;
  };

  /**
   * WHICH LAYER a right-click targets. The rule is headless (core
   * `pickContextTarget`) because it is pure policy over a stack, a selection
   * and the lock flags — the stage only supplies the stack.
   */
  const contextTargetAt = (p: { x: number; y: number }): ClipHitRect | null => {
    const stack = hitStackAt(p, true);
    const id = pickContextTarget(
      store.getState(),
      stack.map((h) => h.clipId),
      useSession.getState().selectedClipIds,
    );
    return stack.find((h) => h.clipId === id) ?? null;
  };

  /** The single clip a gesture should act on: the topmost one whose pixels are under the point. */
  const hitTestClip = (screen: { x: number; y: number }): ClipHitRect | null => hitStackAt(screen)[0] ?? null;

  /** A ruler guide under the pointer (within a few screen px of its line). */
  const hitTestGuide = (
    screen: { x: number; y: number },
  ): { frameId: string; id: string; axis: "x" | "y" } | null => {
    const session = useSession.getState();
    if (!session.rulerGuides) return null; // you cannot grab a line that is not drawn
    const doc = store.getState();
    const gf = doc.frames.find((f) => f.id === session.activeFrameId) ?? framesInView(doc, session)[0];
    const view = useStageView.getState();
    // The frame's guides first (more specific), then the page's (D17).
    const owners = [gf ? guideOwner(doc, gf.id) : null, guideOwner(doc, session.activePageId ?? doc.pages[0]?.id ?? "")];
    for (const owner of owners) {
      if (!owner) continue;
      for (const g of owner.guides) {
        const line = guideLineWorld(owner, g);
        const d = g.axis === "x" ? Math.abs(screen.x - (view.tx + line.pos * view.scale)) : Math.abs(screen.y - (view.ty + line.pos * view.scale));
        if (d <= 5) return { frameId: owner.id, id: g.id, axis: g.axis };
      }
    }
    return null;
  };

  const hitTestLabel = (screen: { x: number; y: number }): string | null => {
    for (const l of labelRectsRef.current) {
      if (screen.x >= l.x && screen.x <= l.x + l.w && screen.y >= l.y && screen.y <= l.y + l.h) {
        return l.frameId;
      }
    }
    return null;
  };

  const hitTestFrameHandle = (
    screen: { x: number; y: number },
  ): { frame: Frame; handle: FrameHandle } | null => {
    const session = useSession.getState();
    // Resize handles belong to a lone selected frame only.
    if (session.selectedFrameIds.length !== 1) return null;
    const frame = store.getState().frames.find((f) => f.id === session.selectedFrameIds[0]);
    if (!frame) return null;
    const view = useStageView.getState();
    for (const handle of FRAME_HANDLES) {
      const c = frameHandleCenter(frame, handle, view);
      if (Math.hypot(screen.x - c.x, screen.y - c.y) <= HANDLE_HIT_PX) return { frame, handle };
    }
    return null;
  };

  const hitTestRadiusHandle = (
    screen: { x: number; y: number },
  ): { clipId: string; corner: RadiusCorner } | null => {
    const session = useSession.getState();
    if (session.tool !== "select" || session.selectedClipIds.length !== 1) return null;
    // The pivot belongs to WHOLE-LAYER transforms. Inside a sub-object editor —
    // text caret, vector/shape nodes, the crop window — the gestures on screen
    // move geometry INSIDE the layer, the pivot isn't grabbable, and it still
    // sat there as a crosshair that could only be misread as a node. One rule,
    // one place: the draw and the hit-test both come through here, so hiding it
    // also makes it unhittable, and there is no mode where you can see it but
    // not use it.
    if (
      session.editingClipId ||
      session.vectorEditClipId ||
      session.shapeEditClipId ||
      session.cropClipId
    )
      return null;
    const id = session.selectedClipIds[0]!;
    if (session.shapeEditClipId === id) return null; // corner-edit owns the dots
    const loc = locateClip(visualState(), id);
    if (!loc) return null;
    const view = useStageView.getState();
    let handles: Array<{ corner: RadiusCorner; x: number; y: number }> = [];
    if (loc.clip.kind === "shape") {
      const pose = shapePoseFor(loc.clip);
      if (pose) handles = shapeRadiusHandles(shapeGeoFor(loc.clip), pose, view);
    } else {
      const boxT = boxRadiusFor(loc.clip);
      if (boxT) handles = rectRadiusHandles(boxT.width, boxT.height, boxT.cornerRadius, boxT.pose, view);
    }
    for (const h of handles) {
      if (Math.hypot(screen.x - h.x, screen.y - h.y) <= HANDLE_HIT_PX) {
        return { clipId: id, corner: h.corner };
      }
    }
    return null;
  };

    /**
   * The selected shape's world placement — `worldPoseOf` and nothing else.
   *
   * There used to be a second step here (`placeShapePose`) that took the pose
   * and applied the drill chain's scale and rotation to it, back when
   * `shapePoseOf` produced a pose in the comp's own coordinates. `worldPoseOf`
   * does that now, once, for every on-canvas control — so the second step was
   * multiplying the chain in TWICE and overriding the origin from a third
   * source. A handle inside a flipbook cell therefore landed somewhere no
   * arithmetic could explain, differently for every cell, which is exactly how
   * it looked.
   *
   * ONE PLACEMENT. If a control is in the wrong place now, `worldPoseOf` is the
   * only thing to look at.
   */
  const shapePoseFor = (clip: ShapeClip): ShapePose | null => {
    const frame = visualState().frames.find((f) => f.id === clip.frameId);
    return frame ? shapePoseOf(clip, visualState(), frame, paintedTimeFor(clip.frameId)) : null;
  };

  /** A box layer's rect-radius target, placed by the same one function. */
  const boxRadiusFor = (clip: Clip) =>
    boxRadiusTarget(clip, visualState(), paintedTimeFor(clip.frameId));

  /** The selected shape's geometry resolved at the playhead — animated width/
   *  height/corner radii/nudges/arc params. THE seam every shape affordance
   *  (corner dots, radius/arc/star handles, their hit-tests + drags) reads, so
   *  the handles ride the keyframed shape instead of its static base state. */
  const shapeGeoFor = (clip: ShapeClip): ResolvedShapeGeometry =>
    resolveShapeGeometry(
      clip,
      sampleKeyframes(clip.keyframes, clipLocalClamped(clip, paintedTimeFor(clip.frameId))),
    );

  /**
   * The gradient currently open for on-stage editing (session.activePaint) as a
   * ready-to-use bundle: the sampled paint, the clip's hit rect (= paint box),
   * the keyframe-path prefix to write, and the world-space handle model. Null
   * unless a single gradient paint is active on a selected clip. This is THE one
   * place the canvas resolves "which gradient am I editing", shared by paint +
   * hit-test + drag so they never disagree.
   */
  const activeGradient = (): {
    prefix: string;
    hit: ClipHitRect;
    eff: Paint;
    model: GradientHandleModel;
  } | null => {
    const session = useSession.getState();
    if (session.tool !== "select" || session.selectedClipIds.length !== 1) return null;
    const clipId = session.selectedClipIds[0]!;
    if (session.editingClipId === clipId) return null; // not while typing
    const loc = locateClip(visualState(), clipId);
    if (!loc || loc.clip.kind === "audio") return null;
    const clip = loc.clip;

    // Which paint drives the handles: the entry whose colour popover is open
    // (activePaint), else the layer's first gradient paint — so the bar is
    // ALWAYS on screen for a gradient layer (Figma), not only while a picker is
    // open. The axis is inert; only the endpoint/stop dots grab, so this never
    // steals a plain move-drag.
    const ref =
      session.activePaint?.clipId === clipId
        ? { target: session.activePaint.target, id: session.activePaint.id }
        : firstGradientRef(clip);
    if (!ref) return null;

    // Every visual clip shares the same fills/strokes lists, so one lookup works.
    const prefix = `${ref.target}.${ref.id}`;
    const base = paintOfPrefix(clip, prefix);
    if (!base || base.type === "solid") return null;

    const sampled = sampleKeyframes(clip.keyframes, clipLocalClamped(clip, session.playheadMs));
    const eff = paintWithSampled(base, prefix, sampled);
    const hit = activeHit(clipId);
    if (!hit) return null;
    const model = gradientHandleModel(eff, hit);
    if (!model) return null;
    return { prefix, hit, eff, model };
  };

  const hitTestShapeHandle = (
    screen: { x: number; y: number },
  ): { clipId: string; kind: ShapeHandleKind } | null => {
    const session = useSession.getState();
    if (session.tool !== "select" || session.selectedClipIds.length !== 1) return null;
    const id = session.selectedClipIds[0]!;
    const loc = locateClip(visualState(), id);
    if (loc?.clip.kind !== "shape") return null;
    const pose = shapePoseFor(loc.clip);
    if (!pose) return null;
    for (const h of shapeControlHandles(shapeGeoFor(loc.clip), pose, useStageView.getState())) {
      if (Math.hypot(screen.x - h.x, screen.y - h.y) <= HANDLE_HIT_PX) {
        return { clipId: id, kind: h.kind };
      }
    }
    return null;
  };

  /** A corner node of the shape currently in corner-edit mode, if hit. */
  const hitTestShapeCorner = (
    screen: { x: number; y: number },
  ): { clipId: string; index: number } | null => {
    const session = useSession.getState();
    const id = session.shapeEditClipId;
    if (session.tool !== "select" || !id || !session.selectedClipIds.includes(id)) return null;
    const loc = locateClip(visualState(), id);
    if (loc?.clip.kind !== "shape") return null;
    const pose = shapePoseFor(loc.clip);
    if (!pose) return null;
    const centers = shapeCornerScreens(shapeGeoFor(loc.clip), pose, useStageView.getState());
    for (let i = 0; i < centers.length; i++) {
      if (Math.hypot(screen.x - centers[i]!.x, screen.y - centers[i]!.y) <= HANDLE_HIT_PX) {
        return { clipId: id, index: i };
      }
    }
    return null;
  };

  // The rotate hotzone: the band just OUTSIDE any selection corner (single layer
  // or the group box). Returns the world + screen pivot the drag turns about.
  // One brain for single AND group — the caller doesn't care which.
  const hitTestRotateZone = (
    screen: { x: number; y: number },
  ): { wcx: number; wcy: number; scx: number; scy: number; bearing: number } | null => {
    const session = useSession.getState();
    if (session.tool !== "select" || session.selectedClipIds.length === 0) return null;
    const view = useStageView.getState();
    let wcx: number, wcy: number;
    let centers: Array<{ x: number; y: number }>;
    if (session.selectedClipIds.length === 1) {
      const hit = croppedDisplayRect(session.selectedClipIds[0]!);
      if (!hit) return null;
      // A single layer turns about its own PIVOT (the box centre by default), so
      // the pointer's angle is measured about the very point the art spins on.
      const p = pivotWorld(session.selectedClipIds[0]!);
      wcx = p?.x ?? hit.cx;
      wcy = p?.y ?? hit.cy;
      centers = selectionHandleCenters(hit, view);
    } else {
      const box = selectionGroupBox(session.selectedClipIds, hitRectsRef.current);
      if (!box) return null;
      wcx = box.cx;
      wcy = box.cy;
      centers = groupHandleCenters(box, view);
    }
    const corner = rotateZoneCorner(screen, centers);
    if (corner === null) return null;
    return {
      wcx,
      wcy,
      scx: view.tx + wcx * view.scale,
      scy: view.ty + wcy * view.scale,
      bearing: cornerBearing(centers, corner),
    };
  };

  const hitTestResizeHandle = (
    screen: { x: number; y: number },
  ): { rect: ClipHitRect; cursor: string; sx: number; sy: number } | null => {
    const session = useSession.getState();
    if (session.selectedClipIds.length !== 1) return null;
    // A cropped clip resizes from its VISIBLE bounds (handles hug the cropped
    // image), so grab the cropped display rect — falls back to the full box.
    const hit = croppedDisplayRect(session.selectedClipIds[0]!);
    if (!hit) return null;
    const view = useStageView.getState();
    const centers = selectionHandleCenters(hit, view); // nw, ne, se, sw
    // Corner handles win (they'd otherwise be shadowed by the edge hotzone).
    for (let i = 0; i < 4; i++) {
      const c = centers[i]!;
      if (Math.hypot(screen.x - c.x, screen.y - c.y) <= HANDLE_HIT_PX) {
        const d = CORNER_DIRS[i]!;
        return { rect: hit, sx: d.x, sy: d.y, cursor: resizeCursor(cornerBearing(centers, i)) };
      }
    }
    // Edges: grab anywhere along the selection outline to resize that side
    // (Figma). One sign component is 0 → single-axis resize.
    for (let i = 0; i < 4; i++) {
      const d = EDGE_DIRS[i]!;
      if (distToSegment(screen, centers[i]!, centers[(i + 1) % 4]!) <= EDGE_HIT_PX) {
        return { rect: hit, sx: d.x, sy: d.y, cursor: resizeCursor(edgeBearing(centers, i)) };
      }
    }
    return null;
  };

  // The group (multi-select) bounding box handles — a Figma-style box around
  // every selected layer that scales them together. Only when 2+ are selected
  // (single selection uses the per-clip handles above).
  const hitTestGroupResizeHandle = (
    screen: { x: number; y: number },
  ): { box: GroupBox; corner: number; cursor: string } | null => {
    const session = useSession.getState();
    if (session.tool !== "select" || session.selectedClipIds.length < 2) return null;
    const box = selectionGroupBox(session.selectedClipIds, hitRectsRef.current);
    if (!box) return null;
    const view = useStageView.getState();
    const centers = groupHandleCenters(box, view);
    for (let i = 0; i < centers.length; i++) {
      const c = centers[i]!;
      if (Math.hypot(screen.x - c.x, screen.y - c.y) <= HANDLE_HIT_PX) {
        return { box, corner: i, cursor: resizeCursor(cornerBearing(centers, i)) };
      }
    }
    return null;
  };

  /**
   * A world-space movement expressed in the coordinates a clip's TRANSFORM is
   * actually written in.
   *
   * The pointer, the hit rects and every gizmo live in WORLD space; a clip's
   * `transform.x/y` lives in its own frame's space. At the root those are the
   * same thing, so for a long time nothing needed to say so. Inside an in-place
   * nested edit (a component, a precomp) they are NOT: the hop chain scales and
   * rotates the frame, so a world delta written straight into a transform moves
   * the layer by the hop's scale factor — which is why resizing a rectangle
   * inside a nested comp used to fling it across the canvas and then chase the
   * pointer with absurd values.
   *
   * `applyDragLayers` already did this for plain moves; resize, group resize,
   * rotate-orbit and the pivot drag now go through the SAME conversion, so
   * "world in, frame-local out" has one implementation instead of one per
   * gesture (and three that forgot).
   */
  /**
   * A WORLD point in the coordinates a clip's transform is written in: its own
   * frame's space, origin at the frame CENTRE (which is what `transform.x/y` is
   * relative to).
   *
   * Gestures that measure a POSITION — resize above all — must convert once, up
   * front, and then do every bit of their arithmetic in this one space. Mixing
   * spaces is what made resizing inside a nested comp explode: the box came from
   * world-placed hit rects while the value written was frame-local, so the two
   * disagreed by the hop chain's scale and the drag chased its own tail.
   */
  /**
   * The nine key points of a layer's painted box in WORLD: four corners, four
   * edge midpoints and the centre. Rotation and shear ride along, because they
   * come from the same rotated-corner math the selection box is drawn from.
   */
  const boxKeyPointsWorld = (clipId: string): Array<{ x: number; y: number }> => {
    const hit = activeHit(clipId);
    if (!hit) return [];
    const c = rotatedCorners(hit);
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    });
    return [
      ...c,
      mid(c[0]!, c[1]!),
      mid(c[1]!, c[2]!),
      mid(c[2]!, c[3]!),
      mid(c[3]!, c[0]!),
      { x: hit.cx, y: hit.cy },
    ];
  };

  /** The hop chain's scale/rotation at this depth — 1/1/0 at the root. */
  const toLocalDelta = (dx: number, dy: number): { x: number; y: number } => {
    const ctxNow = stageContext(store.getState(), useSession.getState());
    return ctxNow ? worldDeltaToTarget(ctxNow, dx, dy) : { x: dx, y: dy };
  };

  /**
   * World position of a clip's PIVOT.
   *
   * In the clip's own frame space the pivot IS `transform.x/y` — that is what
   * position means once a pivot exists — so this is a straight forward mapping
   * of that point, not a reconstruction from the painted box. (It used to be
   * derived by subtracting the pivot→centre offset from the hit rect, which is
   * only equal for geometry centred on its own origin: a rect with dragged-out
   * corners has off-centre bounds, so the crosshair sat slightly wrong, dragging
   * it computed a slightly wrong pivot, and the layer crept — taking its corner
   * radius dots with it.)
   */
  const pivotWorld = (clipId: string): { x: number; y: number } | null => {
    const doc = visualState();
    const loc = locateClip(doc, clipId);
    if (!loc || loc.clip.kind === "audio") return null;
    // A text on a path has no pivot of its own — its transform is the host's,
    // so a crosshair here would offer a thing the drag could not change.
    if (isPathText(loc.clip)) return null;
    const frame = doc.frames.find((f) => f.id === loc.clip.frameId);
    if (!frame) return null;
    // The PAINTED clock, not the caller's: a crosshair that samples its own time
    // drifts off the artwork the moment the two disagree. See `paintTimesRef`.
    const painted = paintedTimeFor(loc.clip.frameId);
    const pose = clipPose(loc.clip, clipLocalClamped(loc.clip, painted));
    /*
     * WHERE THE PIVOT IS, in the comp. A leaf's position IS its pivot; a group's
     * `x/y` is a DELTA about a pivot derived from the box of what it holds. That
     * gap is core's `positionOrigin` — one term, no branch here — and reading
     * `pose.x/y` without it put a group's crosshair at the comp centre plus the
     * delta, nowhere near the artwork and sliding further with every nudge.
     *
     * Then the enclosing groups' chain, so a pivot INSIDE a group lands on the
     * art rather than where the art would be if the group were identity.
     */
    const origin = positionOrigin(doc, loc.clip, clipLocalClamped(loc.clip, painted));
    const localPivot = { x: pose.x + origin.x, y: pose.y + origin.y };
    const placed = applyMat(
      groupChainMatrix(doc, clipId, (g) => clipLocalClamped(g, painted)),
      localPivot,
    );
    const ctxNow = stageContext(doc, useSession.getState());
    if (ctxNow && ctxNow.depth > 0 && ctxNow.target.id === frame.id) {
      // Drilled in: the frame's own x/y are meaningless (it lives off-page on the
      // internal shelf) — the hop chain places it. Target-local origin is the
      // frame's TOP-LEFT, while a transform is relative to its centre.
      return applyMat(ctxNow.matrix, {
        x: frame.width / 2 + placed.x,
        y: frame.height / 2 + placed.y,
      });
    }
    const space = frameSpace(frame.id, doc);
    return space
      ? space.toWorld(placed)
      : { x: frame.x + frame.width / 2 + placed.x, y: frame.y + frame.height / 2 + placed.y };
  };

  /**
   * The PIVOT crosshair for a single selection, in screen space — null when the
   * selection isn't exactly one unlocked layer. THE one geometry answer shared
   * by the hit-test, the drag and the chrome, so they can never disagree.
   */
  const pivotHandle = (): { clipId: string; x: number; y: number } | null => {
    const session = useSession.getState();
    if (session.tool !== "select" || session.selectedClipIds.length !== 1) return null;
    const id = session.selectedClipIds[0]!;
    // Inside the layer, the anchor point is not the subject: editing a text
    // clip's glyphs, a vector's nodes, a shape's corners or a crop frame puts
    // the caret exactly where the crosshair floats, so it reads as debris and
    // gets grabbed by accident. HIDING the chrome is all this does — the pivot
    // itself is untouched and still positions the layer. `contentEditClipId` is
    // the nav's own answer to "am I inside this clip", so a future leaf mode is
    // covered without touching this file.
    if (session.contentEditClipId === id) return null;
    const loc = locateClip(visualState(), id);
    // Hidden reads the same as locked here: there is no art on screen for the
    // crosshair to be the pivot OF.
    if (
      !loc ||
      loc.clip.kind === "audio" ||
      isClipLocked(loc.track, loc.clip) ||
      isClipHidden(loc.track, loc.clip)
    )
      return null;
    // An AUTO LAYOUT box shows its gap and padding handles, and at rest its
    // pivot sits exactly on the middle gap — so the crosshair stays out of the
    // way (drawn and grabbed) until pivot mode asks for it, where it wins.
    if (loc.clip.kind === "group" && loc.clip.layout && session.pivotClipId !== id) return null;
    const w = pivotWorld(id);
    if (!w) return null;
    const view = useStageView.getState();
    return { clipId: id, x: view.tx + w.x * view.scale, y: view.ty + w.y * view.scale };
  };

  /**
   * Is the pointer on the pivot crosshair? It is a DIRECT-GRAB handle: press and
   * drag moves it, no mode required.
   *
   * Grabbing it needs intent, because it sits inside the selection where a drag
   * would otherwise move the layer — and the answer is the same one this canvas
   * already uses for corner-radius dots: a small, hover-lit handle that takes
   * priority within its own radius. Making it modal instead failed a basic
   * usability test — "double-click, then drag" presses again BEFORE the dblclick
   * event lands, so the drag that follows the double-click moved the layer.
   *
   * Pivot MODE still exists (double-click, or the inspector's button): it makes
   * the handle bigger, tethers it to the box, and reads back in the breadcrumb —
   * it is the "I'm working on the pivot now" state, not a permission gate.
   */
  const hitTestPivot = (screen: { x: number; y: number }): string | null => {
    const h = pivotHandle();
    if (!h) return null;
    const r = useSession.getState().pivotClipId === h.clipId ? PIVOT_HIT_PX + 3 : PIVOT_HIT_PX;
    return Math.hypot(screen.x - h.x, screen.y - h.y) <= r ? h.clipId : null;
  };

  // ── On-stage crop (Figma) ────────────────────────────────────────────────
  // Geometry of the crop overlay for the clip currently in crop mode: the full
  // media box AND the inset crop rect, both in screen space, plus the box's own
  // axes so a drag projects onto them. ONE brain shared by hit-test, cursor,
  // render and the drag — so the faded areas, the handles and the gesture can
  // never disagree.
  const cropGeom = (clipId: string) => {
    const doc = visualState();
    const loc = locateClip(doc, clipId);
    if (!loc || loc.clip.kind === "audio") return null;
    const clip = loc.clip;
    const hit = activeHit(clipId);
    if (!hit) return null;
    const view = useStageView.getState();
    const local = clipLocalClamped(clip, paintedTimeFor(clip.frameId));
    const pose = clipPose(clip, local);
    // Crop insets are in the media's own natural px — core owns that per-kind
    // answer (it also sizes bounds and resolves the pivot).
    const nat = clipBox(doc, clip);
    const kf = sampleKeyframes(clip.keyframes, local);
    const cv = (k: string, base: number) => (typeof kf[k] === "number" ? (kf[k] as number) : base);
    const crop: CropInsets = {
      top: Math.max(0, cv("crop.top", clip.crop.top)),
      right: Math.max(0, cv("crop.right", clip.crop.right)),
      bottom: Math.max(0, cv("crop.bottom", clip.crop.bottom)),
      left: Math.max(0, cv("crop.left", clip.crop.left)),
    };
    // Where the PICTURE is inside that window — sampled the same way, because
    // it is keyframable the same way.
    const content: ContentTransform = {
      x: cv("content.x", clip.content.x),
      y: cv("content.y", clip.content.y),
      scale: cv("content.scale", clip.content.scale),
      scaleY: typeof kf["content.scaleY"] === "number" ? (kf["content.scaleY"] as number) : clip.content.scaleY,
      rotation: cv("content.rotation", clip.content.rotation),
    };
    // World half-extents of the FULL media box (natural size × scale MAGNITUDE —
    // a mirrored layer's box is the same size, the flip lives in the renderer).
    const hw = Math.max(1, Math.abs(nat.width * pose.scale) / 2);
    const hh = Math.max(1, Math.abs(nat.height * pose.scaleY) / 2);
    const rot = (hit.rotation * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // Local (box-axis, world-unit) offset → screen. hit.cx/cy already carry any
    // nested-drill world offset, so this works at every depth.
    const toScreen = (lx: number, ly: number) => ({
      x: view.tx + (hit.cx + lx * cos - ly * sin) * view.scale,
      y: view.ty + (hit.cy + lx * sin + ly * cos) * view.scale,
    });
    // Crop rect edges in the box's own axes (world units): insets scale with pose.
    const sxAbs = Math.abs(pose.scale);
    const syAbs = Math.abs(pose.scaleY);
    const insets = cropInsetMap(pose.scale, pose.scaleY);
    const x0 = -hw + crop[insets.w] * sxAbs;
    const x1 = hw - crop[insets.e] * sxAbs;
    const y0 = -hh + crop[insets.n] * syAbs;
    const y1 = hh - crop[insets.s] * syAbs;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    const handles: Array<{ side: CropSide; pt: { x: number; y: number } }> = [
      { side: "nw", pt: toScreen(x0, y0) },
      { side: "n", pt: toScreen(mx, y0) },
      { side: "ne", pt: toScreen(x1, y0) },
      { side: "e", pt: toScreen(x1, my) },
      { side: "se", pt: toScreen(x1, y1) },
      { side: "s", pt: toScreen(mx, y1) },
      { side: "sw", pt: toScreen(x0, y1) },
      { side: "w", pt: toScreen(x0, my) },
    ];
    // Crop-rect corners (screen), in nw→ne→se→sw order for edge segments + fill.
    const rect = {
      nw: toScreen(x0, y0),
      ne: toScreen(x1, y0),
      se: toScreen(x1, y1),
      sw: toScreen(x0, y1),
    };
    // THE PICTURE, where the content transform actually put it (v68).
    //
    // The dimmed area outside the crop rect is a live drag target — it moves
    // the picture, and its corners now RESIZE the picture — so this quad has to
    // be the same rectangle the renderer paints, not the box the media was
    // authored in. Mapped through core's `mapContent`, the one function
    // `withBoxClip` uses, so the dim, the handles and the gesture cannot
    // disagree about where the art is.
    const win = cropWindow(crop, { width: nat.width, height: nat.height, cx: 0, cy: 0 });
    const box = { width: nat.width, height: nat.height, cx: 0, cy: 0 };
    // Box-local px → the box's own world axes (magnitudes; the flip lives in
    // the renderer and is carried here by `insets`/`contentSign`). `mapContent`
    // takes the BOX — never the window — exactly as the renderer does, which is
    // what keeps the dim, the handles and the art in the same place while a
    // crop edge is being dragged.
    const mediaCorner = (sx: number, sy: number) => {
      const p = mapContent(box.cx + (sx * box.width) / 2, box.cy + (sy * box.height) / 2, content, box);
      return toScreen(p.x * sxAbs, p.y * syAbs);
    };
    const mediaRect = {
      nw: mediaCorner(-1, -1),
      ne: mediaCorner(1, -1),
      se: mediaCorner(1, 1),
      sw: mediaCorner(-1, 1),
    };
    // The PICTURE's own centre on screen — the point its zoom grows from, so a
    // corner drag can measure a scale factor as a ratio of two radii from it.
    const picLocal = mapContent(box.cx, box.cy, content, box);
    const picCentre = toScreen(picLocal.x * sxAbs, picLocal.y * syAbs);
    return {
      clip, pose, nat, hw, hh, x0, x1, y0, y1, cos, sin, toScreen, handles, rect,
      mediaRect, picCentre, crop, content, win, box, insets, hit,
    };
  };

  // Hit a crop edge/corner (only while a clip is in crop mode + still selected).
  // Corners win within the grab dot; edges are grabbable ALONG THEIR WHOLE LENGTH
  // (Figma) so you never accidentally resize the object instead of cropping.
  const hitTestCropHandle = (
    screen: { x: number; y: number },
  ): { side: CropSide } | null => {
    const session = useSession.getState();
    if (session.tool !== "select" || !session.cropClipId) return null;
    if (!session.selectedClipIds.includes(session.cropClipId)) return null;
    const geo = cropGeom(session.cropClipId);
    if (!geo) return null;
    // Corners first (each is a 2-letter side).
    for (const h of geo.handles) {
      if (h.side.length === 2 && Math.hypot(screen.x - h.pt.x, screen.y - h.pt.y) <= HANDLE_HIT_PX + 3) {
        return { side: h.side };
      }
    }
    // Edges: the pointer anywhere along the crop-rect side grabs that side.
    const { nw, ne, se, sw } = geo.rect;
    const edges: Array<[CropSide, { x: number; y: number }, { x: number; y: number }]> = [
      ["n", nw, ne],
      ["e", ne, se],
      ["s", se, sw],
      ["w", sw, nw],
    ];
    for (const [side, a, b] of edges) {
      if (distToSegment(screen, a, b) <= EDGE_HIT_PX + 2) return { side };
    }
    return null;
  };

  /**
   * The rect a CROPPED clip presents to normal selection: its VISIBLE (cropped)
   * bounds, not the full media box — so the selection outline, resize + rotate
   * handles hug the image you actually see (Figma). Uncropped clips (or ones with
   * no hit rect) fall back to the plain full-box hit. Derived from the one
   * `cropGeom` brain so it can never disagree with the crop overlay.
   */
  const croppedDisplayRect = (clipId: string): ClipHitRect | null => {
    const full = activeHit(clipId);
    return full ?? null;
  };

  /**
   * A corner of the PICTURE (the dimmed media quad) — the grab that resizes the
   * footage inside a window that does not move.
   *
   * Tested AFTER the window's own handles, so where the two coincide (an
   * uncropped layer) the window wins and cropping still starts with a corner
   * drag, exactly as it did. The picture's corners are only reachable once
   * there is a crop — which is the only time resizing the picture separately
   * means anything.
   */
  const hitTestCropMediaCorner = (
    screen: { x: number; y: number },
    geo: NonNullable<ReturnType<typeof cropGeom>>,
  ): "nw" | "ne" | "se" | "sw" | null =>
    (["nw", "ne", "se", "sw"] as const).find(
      (k) => Math.hypot(screen.x - geo.mediaRect[k].x, screen.y - geo.mediaRect[k].y) <= HANDLE_HIT_PX + 3,
    ) ?? null;

  /**
   * TURN THE PICTURE — the ring just OUTSIDE the media quad's corners.
   *
   * Exactly where a layer's own rotate handle lives relative to its box, for
   * exactly the same reason: past the corner is the only place on a rectangle
   * that cannot mean "resize", and everybody already knows to reach for it.
   * Here it turns the footage inside a window that does not move, which is the
   * one thing the crop gesture could not do — you could pan the picture and
   * zoom it, and to straighten a crooked photo you had to rotate the whole
   * layer and then fight the crop back into square.
   *
   * Tested after the picture's own corners, so the resize still wins where the
   * two rings overlap.
   */
  const hitTestCropMediaRotate = (
    screen: { x: number; y: number },
    geo: NonNullable<ReturnType<typeof cropGeom>>,
  ): boolean =>
    rotateZoneCorner(screen, [geo.mediaRect.nw, geo.mediaRect.ne, geo.mediaRect.se, geo.mediaRect.sw], HANDLE_HIT_PX + 3) !== null;

  /**
   * WHICH CROP VERB a press at this point means — the one answer the badge, the
   * cursor and the press itself all read.
   *
   * It mirrors the press's branch order exactly (picture corner, then window,
   * then picture), because the cost of a second opinion here is a cursor that
   * promises one thing and a drag that does another. Mid-drag the LIVE mode
   * wins, so ⌥ swapping the verb keeps both telling the truth.
   */
  const cropVerbAt = (
    screen: { x: number; y: number },
    geo: NonNullable<ReturnType<typeof cropGeom>>,
  ): CropVerb | null => {
    const mode = gesture.current.mode;
    if (mode === "crop-pan" || mode === "crop-content" || mode === "crop-zoom" || mode === "crop-rotate") {
      return mode;
    }
    if (hitTestCropMediaCorner(screen, geo)) return "crop-zoom";
    if (hitTestCropMediaRotate(screen, geo)) return "crop-rotate";
    const region = cropRegionAt(screen, geo);
    return region === "window" ? "crop-pan" : region === "content" ? "crop-content" : null;
  };

  /** Even-odd test against a rotated screen quad — the crop rect or media box. */
  const pointInQuad = (
    screen: { x: number; y: number },
    quad: Record<"nw" | "ne" | "se" | "sw", { x: number; y: number }>,
  ): boolean => {
    const pts = [quad.nw, quad.ne, quad.se, quad.sw];
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = pts[i]!;
      const b = pts[j]!;
      if (a.y > screen.y !== b.y > screen.y && screen.x < ((b.x - a.x) * (screen.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  };

  /** True when a screen point is inside the crop rect (for the pan-window drag). */
  const pointInCropRect = (screen: { x: number; y: number }, geo: NonNullable<ReturnType<typeof cropGeom>>): boolean =>
    pointInQuad(screen, geo.rect);

  /**
   * Which crop gesture a press at this point means, before modifiers. Inside the
   * window you reframe the WINDOW; out in the dimmed media you move the PICTURE
   * (you are literally grabbing the part of the image you can't see yet); past
   * the media entirely there is nothing to drag, so the press leaves crop mode.
   */
  const cropRegionAt = (
    screen: { x: number; y: number },
    geo: NonNullable<ReturnType<typeof cropGeom>>,
  ): "window" | "content" | "outside" => {
    if (pointInQuad(screen, geo.rect)) return "window";
    if (pointInQuad(screen, geo.mediaRect)) return "content";
    return "outside";
  };

  // The canvas page follows the active comp: opening a timeline for a frame
  // on another page (e.g. a precomposed comp on "Nested") switches pages. And
  // when the drill DEPTH changes (enter/leave a nested comp), the view refits so
  // the now-focused comp — or the page you came back to — is on-screen.
  // SPACE press/release flips the cursor to/from grab even without a mouse move.
  React.useEffect(() => {
    const unsub = spacePan.subscribe(() => updateCursor(lastPointerRef.current));
    return () => void unsub();
  }, []);

  React.useEffect(
    () =>
      useSession.subscribe((s, prev) => {
        const d = store.getState();
        // Drilling in never moves the camera or the page: the whole point is
        // that entering changes the TIMELINE, not the stage. Nothing takes the
        // view any more — a drawing surface or flipbook sheet is edited exactly
        // where its instance is painted, like everything else.
        const ctx = stageContext(d, s);
        const inplace = ctx != null && ctx.depth > 0;
        if (!inplace && s.activeFrameId !== prev.activeFrameId && s.activeFrameId) {
          const f = d.frames.find((x) => x.id === s.activeFrameId);
          if (f) {
            const pid = pageOfFrame(d, f);
            if (pid !== (s.activePageId ?? d.pages[0]!.id)) switchPage(d, pid, { frameId: f.id });
          }
        }
        // Refit on entering/leaving a nested comp (drill depth changed) — but
        // only if the now-focused content isn't already on-screen, so editing a
        // component you can already see stays put instead of jumping.
        if (!inplace && (s.nav.path.hops.length > 0) !== (prev.nav.path.hops.length > 0)) {
          requestAnimationFrame(() => fit({ onlyIfOffscreen: true }));
        }
      }),
    [store, fit],
  );

  const frameAtWorld = (w: { x: number; y: number }): Frame | null => {
    const doc = store.getState();
    const session = useSession.getState();
    // Isolation lock: while you're inside something, the ONLY frame that exists
    // as far as the pointer is concerned is the one you're editing — and only
    // within its own painted quad. Everything else is inert, so you can never
    // select or drag your way out of context (double-click the glass, or
    // Escape, is the ONE way back).
    const ctx = stageContext(doc, session);
    if (ctx && ctx.depth > 0) return containsWorldPoint(ctx, w) ? ctx.target : null;
    const frames = framesInView(doc, session);
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i]!;
      if (w.x >= f.x && w.x <= f.x + f.width && w.y >= f.y && w.y <= f.y + f.height) return f;
    }
    return null;
  };

  /**
   * WHERE A NEW THING GOES — the comp it belongs to, AND that comp's live
   * placement on the canvas, resolved together because they are one answer.
   *
   * They used to be two. `frameForRect` / `frameForPoint` handed back a frame
   * and every caller mapped world → local for itself; `dropTargetAt` did it
   * through `frameSpace` and was right, while the shape tool and the text tool
   * each wrote the page-board expression by hand:
   *
   *     world.x - frame.x - frame.width / 2
   *
   * That is the position of a FREE-STANDING ARTBOARD on the page board, and it
   * is only accidentally correct at depth 0 (see `edit-space.ts`, which exists
   * to say exactly this). One hop in — inside a component, a nested comp, a
   * flipbook cell's drawing — the comp you are standing in is not on the board
   * at all: it sits on the internal shelf with a leftover `x/y` nobody paints
   * at, while its picture is composed into the scene through the hop chain. So
   * a rectangle drawn inside a flipbook cell was measured against a rectangle
   * thousands of units away and landed there, off the canvas, while the pen and
   * the brush — which already went through the edit space — landed correctly.
   *
   * Returning the mapping with the frame is what makes the wrong version
   * unwriteable: there is no longer a caller holding a frame and needing to
   * decide how to measure against it.
   */
  interface NewLayerSpot {
    frame: Frame;
    /** World point → that frame's own frame-centre coordinates. */
    local(w: { x: number; y: number }): { x: number; y: number };
  }

  /**
   * WHERE A NEW THING GOES, having first made sure there is somewhere to put
   * it. On a flipbook slot that has only been ARMED, the frame is born from the
   * first gesture that actually fills it — the same seam the brush and the pen
   * go through (`materializeArmedCell`), so a rectangle, a text box and a
   * stroke aimed at the same empty slot all mean the same thing.
   */
  const spotForNewLayer = (w: { x: number; y: number }): NewLayerSpot | null => {
    materializeArmedCell(store);
    return frameForPoint(w);
  };

  const spotIn = (frame: Frame): NewLayerSpot => {
    const space = frameSpace(frame.id, store.getState());
    return {
      frame,
      local: (w) => {
        const l = space ? space.fromWorld(w) : { x: w.x - frame.x - frame.width / 2, y: w.y - frame.y - frame.height / 2 };
        return { x: Math.round(l.x), y: Math.round(l.y) };
      },
    };
  };

  const dropTargetAt = (p: { x: number; y: number }) => {
    const wc = toWorld(p);
    const spot = frameForPoint(wc);
    if (!spot) return null;
    return { frame: spot.frame, ...spot.local(wc) };
  };

  const frameForPoint = (w: { x: number; y: number }): NewLayerSpot | null => {
    const docNow = store.getState();
    const standing = standingFrameId(docNow);
    const session = useSession.getState();
    const frame = standing
      ? (docNow.frames.find((f) => f.id === standing) ?? null)
      : (frameAtWorld(w) ??
        docNow.frames.find((f) => f.id === session.activeFrameId) ??
        framesInView(docNow, session)[0] ??
        null);
    return frame ? spotIn(frame) : null;
  };

  /**
   * Which frame a newly-drawn RECT belongs to. Drilled in, it is the comp you
   * are standing in, full stop. At the TOP level it is Figma-smart: an
   * explicitly selected frame wins (draw into it, even if the rect spills out);
   * otherwise the frame it OVERLAPS most — so a shape only PARTLY inside a
   * frame still lands in it, instead of being pushed out. Null only when the
   * rect touches no frame at all.
   */
  const frameForRect = (rect: { x: number; y: number; w: number; h: number }): NewLayerSpot | null => {
    const docNow = store.getState();
    const session = useSession.getState();
    // Drilled in, the level you are standing in wins outright — a shape drawn
    // half outside the comp still belongs to it. See `standingFrameId`.
    const standing = standingFrameId(docNow);
    if (standing) {
      const f = docNow.frames.find((fr) => fr.id === standing);
      return f ? spotIn(f) : null;
    }
    const selId = session.selectedFrameIds[session.selectedFrameIds.length - 1];
    if (selId) {
      const sel = docNow.frames.find((f) => f.id === selId);
      if (sel) return spotIn(sel);
    }
    let best: Frame | null = null;
    let bestArea = 0;
    const inView = framesInView(docNow, session);
    for (const f of inView) {
      const ox = Math.min(rect.x + rect.w, f.x + f.width) - Math.max(rect.x, f.x);
      const oy = Math.min(rect.y + rect.h, f.y + f.height) - Math.max(rect.y, f.y);
      if (ox <= 0 || oy <= 0) continue;
      const area = ox * oy;
      if (area > bestArea) {
        bestArea = area;
        best = f;
      }
    }
    // DRAWN ENTIRELY OFF THE BOARD. It belongs to the comp you are WORKING IN,
    // and it stays exactly where you drew it — outside. Every level has its own
    // canvas, and that canvas is the frame's own space carried past its edges;
    // there is no separate container to put anything in, and `frame.overflow`
    // is what lets you see what you put out there. Refusing was what made the
    // space around an artboard dead.
    if (!best) best = inView.find((f) => f.id === session.activeFrameId) ?? inView[0] ?? null;
    return best ? spotIn(best) : null;
  };

  // ── Context menu ───────────────────────────────────────────────────────────
  // Right-click aims the shared menu at whatever is under the cursor and
  // selects it (Figma-style) before Radix opens the content.
  const [menuTarget, setMenuTarget] = React.useState<
    { kind: "empty" } | { kind: "clip" } | { kind: "frame"; frameId: string }
  >({ kind: "empty" });
  // Right-clicking a guide line opens its own settings popover (customize +
  // remove), anchored at the cursor — separate from the layer/frame menu.
  /** Right-clicked motion-path anchor → smooth/corner + delete point menu. */
  const [motionMenu, setMotionMenu] = React.useState<{
    clipId: string;
    timeMs: number;
    smooth: boolean;
    x: number;
    y: number;
  } | null>(null);
  const [guideMenu, setGuideMenu] = React.useState<{ frameId: string; guideId: string; x: number; y: number } | null>(
    null,
  );
  // Never leave the guide popover hovering over a guide that's gone — if the
  // target disappears (removed here, dragged off, undo/redo), close it.
  React.useEffect(() => {
    if (!guideMenu) return;
    const exists = findGuide(doc, guideMenu.frameId, guideMenu.guideId) != null;
    if (!exists) setGuideMenu(null);
  }, [doc, guideMenu]);

  const onStageContextMenu = (e: React.MouseEvent) => {
    // A floating layer above the stage (the fill picker, a dialog, any menu) is
    // portalled to <body> but is still a REACT descendant of this handler, so
    // its right-clicks arrive here first. They are not ours — leave them
    // entirely alone, or the branch below swallows the event during CAPTURE and
    // the panel's own menu never gets it. `stageMenuGuard.onContextMenu` is what
    // keeps our own Radix menu shut.
    if (isForeignEvent(containerRef.current, e)) return;
    // macOS turns Ctrl-click into a right-click, so the click never comes. A
    // Ctrl-press that landed on a link is a follow, not a menu.
    const press = linkPressRef.current;
    if (press && e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      linkPressRef.current = null;
      linkHoverRef.current = null;
      dirtyRef.current = true;
      followLink(store, press.link, { forceNew: press.newTab });
      return;
    }
    // The vector overlay owns right-click while pen/node-edit is active
    // (point menu). Let the event reach it untouched.
    if ((e.target as HTMLElement).closest?.("[data-vector-overlay]")) return;
    // The floating toolbar owns right-click for its own tool-category flyouts.
    if ((e.target as HTMLElement).closest?.("[data-toolbar]")) return;
    // The rulers own right-click for their unit/settings popover.
    if ((e.target as HTMLElement).closest?.("[data-ruler]")) return;
    // Any button using the shared hold/right-click submenu gesture owns its own
    // right-click — never let the capture handler swallow it first.
    if ((e.target as HTMLElement).closest?.("[data-hold-menu]")) return;
    // A text layer being EDITED is a text field, and a text field's right-click
    // is cut/copy/paste/select-all. Letting the stage menu win here meant the
    // one place in the app where you are actually typing was the one place with
    // no editing menu — and worse, opening it ended the edit.
    if ((e.target as HTMLElement).closest?.("[data-text-edit]")) return;
    // A BONE is part of the character, not chrome: its right-click is the
    // character's menu (it has just picked the bone and its rig).
    const onBone = !!(e.target as Element).closest?.("[data-rig-bone]");
    // …and a rigged piece's grab zone is the art itself: the menu of what is under it.
    const onPiece = !!(e.target as Element).closest?.("[data-rig-piece]");
    if (e.target !== canvasRef.current && !onBone && !onPiece) {
      // Overlays (toolbar, zoom, text edit) never open the stage menu.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const p = localPoint(e);
    const session = useSession.getState();

    // A guide line under the cursor → its own customize/remove popover, not the
    // layer menu. Suppress the Radix stage menu for this right-click.
    const guideHit = hitTestGuide(p);
    if (guideHit) {
      e.preventDefault();
      e.stopPropagation();
      setGuideMenu({ frameId: guideHit.frameId, guideId: guideHit.id, x: e.clientX, y: e.clientY });
      return;
    }

    // A motion-path anchor under the cursor → its own point menu.
    const motionHit = motionSceneRef.current ? hitMotionScene(motionSceneRef.current, p) : null;
    if (motionHit?.kind === "anchor" && !motionHit.locked) {
      e.preventDefault();
      e.stopPropagation();
      const path = motionSceneRef.current!.paths.find((mp) => mp.clipId === motionHit.clipId);
      const anchor = path?.anchors.find((a) => Math.abs(a.timeMs - motionHit.timeMs) < 0.5);
      setMotionMenu({
        clipId: motionHit.clipId,
        timeMs: motionHit.timeMs,
        smooth: !!anchor?.smooth,
        x: e.clientX,
        y: e.clientY,
      });
      return;
    }

    if (session.editingClipId) session.endTextEdit();

    const hit = onBone ? null : contextTargetAt(p);
    if (onBone) {
      // The capture phase runs first: pick the bone and its rig here.
      const el = (e.target as Element).closest("[data-rig-bone]")!;
      const rigId = el.getAttribute("data-rig-id")!;
      const boneId = el.getAttribute("data-rig-bone")!;
      const rigUi = useRigUi.getState();
      if (rigUi.rigId !== rigId || !rigUi.bones.includes(boneId)) rigUi.selectBones(rigId, [boneId]);
      if (session.selectedClipIds.length !== 1 || session.selectedClipIds[0] !== rigId) session.select([rigId]);
      const rig = locateClip(store.getState(), rigId)?.clip;
      if (rig) session.setActiveComp(rig.frameId);
      setMenuTarget({ kind: "clip" });
      return;
    }
    if (hit) {
      // A menu is about the thing you already have when you opened it ON that
      // thing — a selected group's member included. Only a press elsewhere
      // retargets.
      if (!pressHoldsSelection(store.getState(), [hit.clipId], session.selectedClipIds)) {
        session.select(
          expandSelectionToGroups(store.getState(), [hit.clipId], session.enteredGroupId),
        );
      }
      session.setActiveComp(hit.frameId);
      setMenuTarget({ kind: "clip" });
      return;
    }
    const labelId = hitTestLabel(p);
    const frame = labelId
      ? store.getState().frames.find((f) => f.id === labelId) ?? null
      : frameAtWorld(toWorld(p));
    if (frame) {
      session.selectFrame(frame.id);
      setMenuTarget({ kind: "frame", frameId: frame.id });
      return;
    }
    setMenuTarget({ kind: "empty" });
  };

  // ── Pointer handlers ───────────────────────────────────────────────────────

  /**
   * MIDDLE MOUSE ALWAYS PANS.
   *
   * This is a property of the STAGE, not of a tool or a mode, and it was being
   * treated as neither. The rule lived inside `onPointerDown`, below two guards
   * that had nothing to do with it: `e.target !== canvasRef.current` (so any
   * overlay covering the canvas — the vector editor, the text box, the crop
   * chrome, a drop ghost — ate the press) and an early return for drawing tools
   * (so a brush disabled panning outright). Every new overlay silently took the
   * gesture away again, and the fix each time would have been another line in
   * someone else's component.
   *
   * So it moves ABOVE everything, into the capture phase on the container:
   * capture runs before any child handler, so nothing downstream can stop it,
   * and nothing downstream has to know. `stopPropagation` keeps the press away
   * from whatever it landed on, `preventDefault` kills Chrome's autoscroll
   * puck, and the capture goes on the CONTAINER so the moves retarget here even
   * though the press began over an overlay.
   *
   * One concept, one place, true in every tool and every mode by construction.
   *
   * With ⌘/Ctrl held the same press scrubs the ZOOM about the point it landed
   * on (`middleDragIntent` — the rule the node board's camera shares).
   */
  const onMiddlePanCapture = (e: React.PointerEvent) => {
    if (e.button !== 1) return;
    // A press inside a body-portalled floating panel is not ours — it is only a
    // React descendant. (Same guard the stage context menu uses.)
    if (isForeignEvent(containerRef.current, e)) return;
    e.preventDefault();
    e.stopPropagation();
    const g = gesture.current;
    const p = localPoint(e);
    // The gesture is armed BEFORE the capture is attempted. `setPointerCapture`
    // throws when the pointer is already gone (a fast click, a synthetic event,
    // a pointer the browser retired mid-dispatch), and doing it first meant that
    // throw escaped before `mode` was ever set — leaving a press that had been
    // swallowed by `stopPropagation` above and then handled by nobody. Capture
    // is an optimisation for tracking off-element; the pan works without it.
    g.pointers.set(e.pointerId, p);
    const zooming = middleDragIntent(e) === "zoom";
    g.mode = zooming ? "zoom-drag" : "pan";
    g.moved = false;
    g.dragStart = p;
    capturePointer(containerRef.current, e.pointerId);
    if (containerRef.current) containerRef.current.style.cursor = zooming ? cursors.zoomIn : cursors.grabbing;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Leave text-edit mode on any press that reaches the stage. The text
    // overlay stops its own pointer events, so getting here at all means the
    // press landed OUTSIDE the text — one exit path, shared with Escape and
    // the T-tool flow, and robust to which element the press retargets to.
    if (e.button !== 2 && useSession.getState().editingClipId) {
      useSession.getState().endTextEdit();
    }
    // Only presses on the canvas start stage gestures. Anything else inside the
    // container (toolbar, zoom controls, text-edit overlay) handles itself —
    // capturing their pointer here would swallow their clicks.
    if (e.target !== canvasRef.current) return;
    // A drawing tool is armed → the DrawingOverlay owns the pointer. The stage
    // must NEVER start a select/move/draw-shape gesture then, even if a press
    // slips through (a stray pointer-capture, a mid-switch frame): a brush can
    // never move the flipbook container. The overlay handles the actual stroke.
    if (isDrawingTool(useSession.getState().tool)) return;
    // The Bone tool's overlay owns the pointer the same way (rig/RigOverlay.tsx).
    if (useSession.getState().tool === "bone") return;
    // Touching the canvas routes arrow-key gestures here (keyboard-nav.ts).
    useSession.getState().setFocusedPanel("canvas");
    // Right mouse never starts a gesture — it aims the context menu instead.
    if (e.button === 2) return;
    const g = gesture.current;
    const p = localPoint(e);
    g.pointers.set(e.pointerId, p);
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);
    g.moved = false;
    // The press that OPENS a layer belongs to the drill, not to the chrome
    // floating inside it (pivot crosshair, corner-radius dots, shape handles).
    // Each of those is gated on this below; see `isDrillPress` for why the rule
    // is one predicate rather than a special case per handle.
    const drill = isDrillPress(e.detail);

    // Two fingers is NAVIGATION, and it is recognised by the shared
    // `useMultiTouch` below rather than here — see the note on `touch` for why
    // this stage-private pinch had to go.

    const session = useSession.getState();

    // Dragging while SPACE is held, or with the hand tool (Figma's temporary
    // hand — the active tool never changes). Middle mouse never reaches here:
    // it is claimed in capture, above every guard. See `onMiddlePanCapture`.
    if (session.tool === "hand" || spacePan.held) {
      g.mode = "pan";
      g.dragStart = p;
      if (containerRef.current) containerRef.current.style.cursor = cursors.grabbing;
      return;
    }

    // On-stage CROP is MODAL: while a clip is in crop mode NOTHING edits its
    // transform (no resize/rotate/move) — the whole press is consumed here. Its
    // edge/corner handles crop; a drag INSIDE the visible rect pans the crop
    // window over the image (image fixed, crop values change); a press OUTSIDE
    // leaves crop mode but KEEPS the layer selected — exactly like stepping out
    // of vector-node edit, never a bare deselect.
    if (session.tool === "select" && session.cropClipId) {
      const cropId = session.cropClipId;
      const geo = session.selectedClipIds.includes(cropId) ? cropGeom(cropId) : null;
      if (geo) {
        const startCropDrag = () => {
          g.cropClipId = cropId;
          g.cropStart = { ...geo.crop };
          g.cropNatW = geo.nat.width;
          g.cropNatH = geo.nat.height;
          // Magnitudes: the box is unmirrored, the flip is carried by `cropInsets`.
          g.cropScaleX = Math.abs(geo.pose.scale);
          g.cropScaleY = Math.abs(geo.pose.scaleY);
          g.cropInsets = geo.insets;
          g.cropRot = geo.hit.rotation;
          g.cropStartWorld = toWorld(p);
          g.cropStartPos = { x: geo.pose.x, y: geo.pose.y };
          g.cropContentStart = { ...geo.content };
          // A mirrored layer renders its content flipped, so a rightward drag
          // has to write a leftward pan. Same fact `cropInsetMap` encodes for
          // the insets, in the form the content transform needs.
          g.cropContentSign = {
            x: geo.pose.scale < 0 ? -1 : 1,
            y: geo.pose.scaleY < 0 ? -1 : 1,
          };
          g.mergeKey = `canvas-crop-${e.pointerId}`;
          dirtyRef.current = true;
        };
        const cropHit = hitTestCropHandle(p);
        if (cropHit) {
          g.mode = "crop";
          g.cropSide = cropHit.side;
          startCropDrag();
          return;
        }
        // Inside the window reframes the window; out in the dimmed media you
        // grab the picture itself and pull it through. ⌥ swaps the two live —
        // the watcher re-applies the drag the instant it toggles, so you never
        // have to let go and start again.
        // The picture's own corners resize the picture. One more handle set on
        // the geometry that was already there, so the dim you can see IS the
        // thing you can grab.
        const mediaCorner = hitTestCropMediaCorner(p, geo);
        if (mediaCorner) {
          g.cropPressMode = "crop-zoom";
          g.mode = "crop-zoom";
          g.cropSide = "";
          g.cropZoomCorner = mediaCorner;
          startCropDrag();
          // ⇧/⌥ must bite the instant they are pressed, pointer held still —
          // the same live watcher the reframe halves already use.
          g.modWatch?.();
          g.modWatch = watchDragModifiers(readMods(e), (m) => applyCropReframe(m));
          return;
        }
        // Past the picture's corners: turn it. The accumulators are the LAYER
        // rotate gesture's own, so winding past ±180 and ⇧-snapping to 15°
        // behave identically — one rotation brain, two subjects.
        if (hitTestCropMediaRotate(p, geo)) {
          g.mode = "crop-rotate";
          g.cropPressMode = "crop-zoom"; // never inverted by ⌥ — not an opposite
          g.cropSide = "";
          startCropDrag();
          g.rotatePrimaryStart = geo.content.rotation;
          // Screen space here (the picture's centre is a screen point), which
          // the tracker is indifferent to — it only measures angles.
          g.rotateTracker = beginRotate({
            centre: geo.picCentre,
            start: p,
            baseDeg: geo.content.rotation,
          });
          return;
        }
        const region = cropRegionAt(p, geo);
        if (region !== "outside") {
          g.cropPressMode = region === "window" ? "crop-pan" : "crop-content";
          g.mode = g.cropPressMode;
          g.cropSide = "";
          startCropDrag();
          g.modWatch?.();
          g.modWatch = watchDragModifiers(readMods(e), (mods) => applyCropReframe(mods));
          // Honour a modifier already held at press time.
          if (readMods(e).alt) applyCropReframe(readMods(e));
          return;
        }
        // Pressed past the media entirely → commit + leave crop, keep selection.
        session.setCropClipId(null);
        return;
      }
      // Stale crop target (its clip got deselected elsewhere) → clear it.
      session.setCropClipId(null);
    }

    if (session.tool === "text") {
      const hit = hitTestClip(p);
      const loc = hit ? locateClip(store.getState(), hit.clipId) : null;
      if (loc?.clip.kind === "text" && !isClipLocked(loc.track, loc.clip)) {
        session.startTextEdit(loc.clip.id);
        session.setTool("select");
        return;
      }
      // Figma: the text tool over a shape's EDGE writes on it. The outline wins
      // over the interior click that would drop plain text, because the cursor
      // already said so — a press that binds is never a surprise.
      const outline = outlineUnderPointer(toWorld(p), hitRectsRef.current, TEXT_PATH_SNAP_PX, useStageView.getState().scale);
      if (outline) {
        placeTextOnPath(outline);
        return;
      }
      // Figma T-tool: a plain click drops auto-width text; DRAG rubber-bands a
      // fixed-width text box (wrap on). Decided on release from the drag size.
      g.mode = "draw-text";
      g.frameStart = toWorld(p);
      g.frameEnd = g.frameStart;
      dirtyRef.current = true;
      return;
    }

    if (session.tool === "frame") {
      g.mode = "draw-frame";
      g.frameStart = toWorld(p);
      g.frameEnd = g.frameStart;
      dirtyRef.current = true;
      return;
    }

    if (isShapeTool(session.tool)) {
      g.mode = "draw-shape";
      g.shapeKind = session.tool;
      g.shapeSquare = e.shiftKey;
      g.shapeFromCenter = e.altKey;
      g.frameStart = toWorld(p);
      g.frameEnd = g.frameStart;
      // Snap the new shape's corner to the layers/page it's drawn over.
      const drawFrame = frameAtWorld(g.frameStart);
      g.snapCandidates = drawFrame ? buildStageCandidates(new Set(), drawFrame.id) : null;
      dirtyRef.current = true;
      return;
    }

    // ── Select tool ──
    // Grab a ruler guide if the pointer is right on one (over layers, under the
    // resize handles below — guides are thin chrome you nudge, not content).
    const guideHit = hitTestGuide(p);
    if (guideHit) {
      g.mode = "guide-move";
      g.guideMoveFrameId = guideHit.frameId;
      g.guideMoveId = guideHit.id;
      g.guideMoveAxis = guideHit.axis;
      g.guideDeletePending = false;
      g.snapCandidates = buildStageCandidates(new Set(), guideHit.frameId, false);
      g.mergeKey = `guide-move-${guideHit.id}-${e.pointerId}`;
      return;
    }

    /*
     * ── THE PIVOT CROSSHAIR, AND WHO OWNS ITS POINT ───────────────────────
     *
     * Three gestures want this one spot, and no hit-test order alone can sort
     * them, because two of them are not merely close — they are THE SAME PIXELS.
     * A position keyframe says where the pivot goes, so on any animated layer
     * the motion path's anchor and the pivot crosshair are one point by
     * definition. The third is the layer itself: the crosshair sits inside the
     * selection, where a drag means "move this".
     *
     * Ordering alone gave a different bug at each setting. Pivot first: you
     * could not touch your own motion path. Motion first (where it was): the
     * pivot became unreachable the moment a layer was animated — including
     * inside pivot MODE, which is the one state that exists to say otherwise.
     * And with neither, the crosshair stole presses meant to move the layer,
     * so it "drags away by accident" constantly.
     *
     * So this is a MODE plus an INTENT, which is the only pair that answers all
     * three:
     *
     *   pivot mode on this layer   the crosshair wins outright. Entering the
     *                              mode IS the statement, and a mode that can
     *                              be overruled by whatever is underneath is
     *                              not a mode.
     *   otherwise                  the press falls through to whatever it would
     *                              have done — the motion key, the layer — and
     *                              the pivot is claimed by a brief STILL HOLD
     *                              (`require: "hold"`), which lights the
     *                              crosshair the instant it lands.
     *
     * A fast drag over the crosshair therefore never moves the pivot, which is
     * the whole complaint, and the pivot is never unreachable, which is the
     * other one.
     */
    {
      const pivotId = drill ? null : hitTestPivot(p);
      if (pivotId) {
        const docNow = store.getState();
        const loc = locateClip(docNow, pivotId);
        const frame = loc ? docNow.frames.find((f) => f.id === loc.clip.frameId) : null;
        if (loc && frame && loc.clip.kind !== "audio") {
          const size = clipBox(docNow, loc.clip);
          const startPose = clipPose(loc.clip, clipLocalClamped(loc.clip, useSession.getState().playheadMs));
          g.pivotClipId = pivotId;
          g.pivotStartPose = startPose;
          g.pivotSize = size;
          // Built once, at the press, from the pose the drag is measured against
          // — so every move reads the same box and the same starting pivot. The
          // box is handed in because it is the expensive one for a group (a walk
          // of every member) and a pivot move can never change it.
          g.pivotModel = pivotModel(docNow, loc.clip, startPose, size);
          // The enclosing groups' delta, inverted — see the drag body. Null
          // (rather than the identity) for an ungrouped layer, so the common
          // case costs nothing.
          const chain = groupChainMatrix(docNow, pivotId, (gc) =>
            clipLocalClamped(gc, useSession.getState().playheadMs),
          );
          g.pivotChainInverse = chain === IDENTITY ? null : (invertMat(chain) ?? null);
          g.pivotStartWorld = pivotWorld(pivotId) ?? { x: 0, y: 0 };
          // A pivot mostly wants to land on ITS OWN box: a corner, an edge
          // midpoint, or dead centre. Those nine points are added as snap lines
          // (each contributes a vertical AND a horizontal), so "centre X only",
          // "centre Y only" and "centre centre" all fall out of the same engine
          // the rest of the canvas uses — on top of the usual neighbours/page.
          // Held apart from `g.snapCandidates` deliberately: the press may fall
          // through to a gesture that builds its OWN candidates, and the pivot
          // would then arm with the layer drag's set.
          g.pivotSnap = mergeSnapCandidates(
            buildStageCandidates(new Set([pivotId]), loc.clip.frameId),
            nodeSnapLines(boxKeyPointsWorld(pivotId)),
          );
          g.pivotMergeKey = `canvas-pivot-${e.pointerId}`;
          if (useSession.getState().pivotClipId === pivotId) {
            g.mode = "move-pivot";
            g.mergeKey = g.pivotMergeKey;
            g.snapCandidates = g.pivotSnap;
            return;
          }
          // Not in the mode: ask for the press instead of taking it. The
          // crosshair repaints the moment the hold lands, so the wait is
          // visible rather than a secret.
          g.pivotHold = beginHeldDrag(e, {
            require: "hold",
            onReady: () => {
              dirtyRef.current = true;
            },
          });
          // …and fall through, so this press still does whatever it would have.
        }
      }
    }

    // Motion-path chrome (anchors / tangent knobs / the curve itself) floats
    // above layers, like guides: grabbing it edits the path, never the layer.
    const motionHit = motionSceneRef.current ? hitMotionScene(motionSceneRef.current, p) : null;
    if (motionHit && !motionHit.locked) {
      g.motionClipId = motionHit.clipId;
      g.mergeKey = `motion-${motionHit.clipId}-${e.pointerId}`;
      g.motionMoved = false;
      g.dragStart = p;
      // ⇧ and ⌥ steer a tangent, so they must answer with the pointer held
      // still — same live watcher the layer drag and the crop reframe use.
      const armMotionModWatch = () => {
        g.modWatch?.();
        g.modWatch = watchDragModifiers(readMods(e), (mods) => {
          if (gesture.current.motionMoved) applyMotionHandle(mods);
        });
      };
      if (motionHit.kind === "anchor") {
        g.motionTimeMs = motionHit.timeMs;
        if (e.altKey) {
          // ⌥-drag an anchor pulls fresh mirrored handles out of it (vector convention).
          g.mode = "motion-handle";
          g.motionEnd = "out";
          g.motionFreshHandles = true;
          // A bare corner has no pair yet; the fresh-pull flag forces balance.
          g.motionDrag = { symmetric: true };
          armMotionModWatch();
        } else {
          g.mode = "motion-anchor";
          const loc = locateClip(store.getState(), motionHit.clipId);
          if (loc) g.snapCandidates = buildStageCandidates(new Set([motionHit.clipId]), loc.clip.frameId);
        }
      } else if (motionHit.kind === "handle") {
        g.mode = "motion-handle";
        g.motionTimeMs = motionHit.timeMs;
        g.motionEnd = motionHit.end;
        g.motionFreshHandles = false;
        // Freeze whether the pair is balanced, BEFORE the drag can change it.
        const held = locateClip(store.getState(), motionHit.clipId);
        const key =
          held && held.clip.kind !== "audio"
            ? motionKeysOf(held.clip).find((k) => Math.abs(k.timeMs - motionHit.timeMs) < 0.5)
            : undefined;
        g.motionDrag = beginTangentDrag(
          (motionHit.end === "in" ? key?.tIn : key?.tOut) ?? null,
          (motionHit.end === "in" ? key?.tOut : key?.tIn) ?? null,
        );
        armMotionModWatch();
      } else {
        g.mode = "motion-bend";
        g.motionSeg = { a: motionHit.a, b: motionHit.b, u: motionHit.u, start: toWorld(p) };
      }
      return;
    }

    const frameHandleHit = hitTestFrameHandle(p);
    if (frameHandleHit) {
      g.mode = "resize-frame";
      g.frameDragId = frameHandleHit.frame.id;
      g.frameHandle = frameHandleHit.handle;
      g.frameStartRect = {
        x: frameHandleHit.frame.x,
        y: frameHandleHit.frame.y,
        w: frameHandleHit.frame.width,
        h: frameHandleHit.frame.height,
      };
      g.dragStart = p;
      g.mergeKey = `frame-resize-${e.pointerId}`;
      return;
    }

    // Corner-edit nodes win over everything while a shape is in corner-edit
    // mode — that's the whole point of the mode.
    // Gradient handles win over every in-box control: the open gradient's axis,
    // endpoints and stops sit inside the selection where a drag would move it.
    const grad = activeGradient();
    if (grad) {
      const view = useStageView.getState();
      const gHit = hitTestGradient(grad.model, toWorld(p), 10 / view.scale);
      if (gHit) {
        g.mode = "gradient-handle";
        g.gradientPrefix = grad.prefix;
        g.moved = false;
        g.mergeKey = `gradient-${e.pointerId}`;
        g.gradientKind = gHit;
        // Endpoints represent the first/last stop; a plain stop carries its id.
        g.gradientStopId =
          gHit.kind === "stop"
            ? gHit.id
            : gHit.kind === "start"
              ? (grad.model.stops[0]?.id ?? "")
              : (grad.model.stops[grad.model.stops.length - 1]?.id ?? "");
        return;
      }
    }

    const cornerHit = hitTestShapeCorner(p);
    if (cornerHit) {
      // Grabbing a corner selects it (⇧ adds to the set) — the same "the thing
      // you touched is now the thing you're editing" rule the pen's nodes follow,
      // and what the arrow keys read.
      const prev = cornerSelection(cornerHit.clipId);
      cornerSel.current = {
        clipId: cornerHit.clipId,
        idx: e.shiftKey ? new Set([...prev, cornerHit.index]) : new Set([cornerHit.index]),
      };
      g.mode = "shape-corner";
      g.shapeCornerClipId = cornerHit.clipId;
      g.shapeCornerIndex = cornerHit.index;
      g.mergeKey = `shape-corner-${cornerHit.index}-${e.pointerId}`;
      g.moved = false;
      g.dragStart = p; // screen — the constrain baseline (world) for ⇧
      const loc = locateClip(store.getState(), cornerHit.clipId);
      // A shape vertex snaps to the SAME guides + siblings a layer does — PLUS
      // this shape's own OTHER corners, so a corner aligns to its siblings
      // (node-to-node, the same shared brain the pen uses).
      let cand = loc ? buildStageCandidates(new Set([cornerHit.clipId]), loc.clip.frameId) : null;
      if (loc?.clip.kind === "shape") {
        const pose = shapePoseFor(loc.clip);
        if (pose) {
          const others = shapeCornerPoints(shapeGeoFor(loc.clip))
            .filter((_, i) => i !== cornerHit.index)
            .map((pt) => shapeLocalToWorld(pt.x, pt.y, pose));
          cand = mergeSnapCandidates(cand, nodeSnapLines(others));
        }
      }
      // Cross-object: this corner also snaps to every OTHER vector node in the
      // frame (paths' anchors + other shapes' corners) — the shared node cloud.
      if (loc) {
        const sib = frameVectorNodesWorld(store.getState(), loc.clip.frameId, new Set([cornerHit.clipId]));
        cand = mergeSnapCandidates(cand, nodeSnapLines(sib));
      }
      g.snapCandidates = cand;
      return;
    }

    // Corner-radius dots take priority over the box resize handles — they sit
    // INSIDE the selection where a drag would otherwise move the layer.
    const radiusHit = drill ? null : hitTestRadiusHandle(p);
    if (radiusHit) {
      g.mode = "radius-drag";
      g.radiusClipId = radiusHit.clipId;
      g.radiusCorner = radiusHit.corner;
      const loc = locateClip(store.getState(), radiusHit.clipId);
      const key = radiusHit.corner === "all" ? "tl" : radiusHit.corner;
      // A rect target = {shape,width,height,cornerRadius,pose,radiusStart}, unified
      // across shapes and box layers so the SAME baseline math serves both.
      const t =
        loc?.clip.kind === "shape"
          ? (() => {
              const geo = shapeGeoFor(loc.clip);
              const pose = shapePoseFor(loc.clip);
              return pose && { geo, pose, cr: geo.cornerRadius, start: geo.shape === "rect" ? geo.cornerRadius[key] : geo.radius, isBox: false };
            })()
          : (() => {
              const box = loc ? boxRadiusFor(loc.clip) : null;
              return box && { geo: { shape: "rect" as const, width: box.width, height: box.height }, pose: box.pose, cr: box.cornerRadius, start: box.cornerRadius[key], isBox: true };
            })();
      g.radiusIsBox = !!t && t.isBox;
      g.radiusIndependent = !!t && !(t.cr.tl === t.cr.tr && t.cr.tr === t.cr.br && t.cr.br === t.cr.bl);
      if (t) {
        g.radiusStart = t.start;
        g.radiusInward0 = cornerInward(t.geo, radiusHit.corner, worldToShapeLocal(toWorld(p), t.pose));
      }
      g.mergeKey = `radius-${e.pointerId}`;
      return;
    }

    // Parametric shape controls (ellipse arc, star spike) — like radius dots,
    // they live inside the selection so they must win over move/resize.
    const shapeHit = drill ? null : hitTestShapeHandle(p);
    if (shapeHit) {
      g.mode = "shape-handle";
      g.shapeHandleClipId = shapeHit.clipId;
      g.shapeHandleKind = shapeHit.kind;
      g.mergeKey = `shape-handle-${e.pointerId}`;
      return;
    }

    // A selected container's gap / padding pills — inside the box, so they must
    // win over the box's own edge handles, which a zero padding puts them on.
    {
      const selId = session.selectedClipIds.length === 1 ? session.selectedClipIds[0]! : null;
      const geo = selId && !drill ? layoutGeometry(selId) : null;
      const handle = geo ? layoutHandleAt(geo, p) : null;
      if (geo && handle && selId) {
        const spec = geo.spec;
        g.mode = "layout-handle";
        g.layoutHandle = handle;
        g.layoutGroupId = selId;
        g.layoutHandleStart =
          handle.kind === "gap" ? spec.gap : handle.kind === "lineGap" ? spec.lineGap : spec.padding[handle.side!];
        g.layoutHandleStartWorld = toWorld(p);
        g.mergeKey = `layout-handle-${e.pointerId}`;
        g.moved = false;
        claimPointer(e.pointerId, "drag");
        dirtyRef.current = true;
        return;
      }
    }

    const handleHit = hitTestResizeHandle(p);
    if (handleHit) {
      const rect = handleHit.rect;
      g.mode = "resize";
      g.resizeClipId = rect.clipId;
      const loc = locateClip(store.getState(), rect.clipId);
      const pose =
        loc && loc.clip.kind !== "audio"
          ? clipPose(loc.clip, clipLocalClamped(loc.clip, useSession.getState().playheadMs))
          : null;
      g.resizeStartScale = pose?.scale ?? 1;
      g.resizeStartScaleY = pose?.scaleY ?? pose?.scale ?? 1;
      g.resizeStartX = pose?.x ?? 0;
      g.resizeStartY = pose?.y ?? 0;
      g.resizeScaleYWasNull =
        !!loc && loc.clip.kind !== "audio" && loc.clip.transform.scaleY == null;
      // No flip has been applied yet this gesture (see `takeMirror`).
      g.resizeMirrorX = 1;
      g.resizeMirrorY = 1;
      g.resizeAnchor = pose?.anchor ?? CENTER_ANCHOR;
      g.resizeSkewX = pose?.skewX ?? 0;
      g.resizeSkewY = pose?.skewY ?? 0;
      const startSize = loc ? clipNaturalSize(store.getState(), loc.clip) : null;
      g.resizeStartSize = startSize ?? {
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
        cx: 0,
        cy: 0,
      };
      /*
       * THE ONE SPACE THIS GESTURE LIVES IN.
       *
       * A resize measures a pointer, projects it onto a box, and writes a
       * POSITION. Those three have to be the same rectangle or the layer creeps
       * by the difference, multiplied by however far you dragged — and they were
       * three different rectangles. The pointer and the box came back through
       * the comp hops alone (`toFrameSpace`), the pivot was read raw off the
       * pose, and one correction mapped a point that was already frame-local as
       * if it were world. Inside a scaled group every one of those is off by
       * that group's delta, which is exactly "resizing a group makes it drift".
       *
       * `layerSpace` is the space `transform.x/y` is actually written in as the
       * layer is PLACED — its comp's chain AND every group enclosing it — which
       * is the space the hit rect was pushed through. Captured once: nothing
       * above this layer moves while you pull its handle, and re-deriving it per
       * move is how two frames of one drag end up measured differently.
       */
      const space = layerSpace(rect.clipId);
      g.resizeSpace = space ? { fromWorld: space.fromWorld } : null;
      const place = layerPlacement(rect.clipId);
      /*
       * ⌥ anchors at the PIVOT, and WHERE THE PIVOT IS depends on the placement
       * model. A leaf's position IS its pivot; a group's `x/y` is a delta about
       * a pivot derived from the box of what it holds. That gap is core's
       * `positionOrigin` — the same one term the crosshair and the motion path
       * read, so ⌥ cannot anchor somewhere the crosshair is not. Reading
       * `pose.x/y` raw put ⌥'s anchor at the comp centre plus the delta, nowhere
       * near the artwork, so ⌥-resizing a group swept it across the canvas.
       */
      const pivotOrigin =
        loc && loc.clip.kind !== "audio"
          ? positionOrigin(
              store.getState(),
              loc.clip,
              clipLocalClamped(loc.clip, useSession.getState().playheadMs),
              g.resizeStartSize,
            )
          : { x: 0, y: 0 };
      g.resizePivot = { x: (pose?.x ?? 0) + pivotOrigin.x, y: (pose?.y ?? 0) + pivotOrigin.y };
      // Start box geometry in the clip's OWN axes and that one space — centre,
      // rotation and half-extents — so a free resize projects the drag onto each
      // axis and writes a position in the same units it measured. The hit rect
      // is WORLD (it has to be: that is where the pointer and every gizmo live),
      // so the placement is undone exactly once, here.
      const fc = resizeToLayerSpace(g, { x: rect.cx, y: rect.cy });
      g.resizeCx = fc.x;
      g.resizeCy = fc.y;
      g.resizeRot = rect.rotation - place.rotation;
      g.resizeStartHalfBoxW = Math.max(1, Math.abs(rect.width / (place.scaleX || 1)) / 2);
      g.resizeStartHalfBoxH = Math.max(1, Math.abs(rect.height / (place.scaleY || 1)) / 2);
      // The grabbed corner/edge sign along the box's own axes — the OPPOSITE
      // corner/edge is the anchor that stays pinned (Figma). An edge has one
      // component 0, so that axis stays fixed (single-side resize).
      g.resizeCornerSx = handleHit.sx;
      g.resizeCornerSy = handleHit.sy;
      // Native resize edits the clip's OWN geometry (shape width/height, text
      // wrap width) so corner radii / glyphs never stretch. ⌘/Ctrl overrides it
      // to a plain transform scale (Figma: hold to scale the object as a unit).
      const native = loc && loc.clip.kind !== "audio" ? nativeResizeKind(loc.clip) : null;
      g.resizeNativeKind = e.metaKey || e.ctrlKey ? null : native;
      if (g.resizeNativeKind === "text" && loc && loc.clip.kind === "text") {
        // Start width/height: the fixed box dims, or the current laid content
        // size (so a vertical drag can start a fixed height from the content).
        // The half-extents above are already in FRAME space, so the box's own
        // units are just those divided by the clip's own scale.
        // Sampled at the playhead (like the shape branch below) so a KEYFRAMED
        // box drags relative to what is on screen, not to its base value.
        const boxLocal = clipLocalClamped(loc.clip, useSession.getState().playheadMs);
        // `null` = auto on that axis and is not a keyframable value, so it is
        // kept OUTSIDE the sampler and restored when no track exists.
        const keyedW = propertyHasKeys(loc.clip.keyframes, "maxWidth")
          ? effectiveValue(loc.clip, "maxWidth", loc.clip.maxWidth ?? 0, boxLocal)
          : loc.clip.maxWidth;
        const keyedH = propertyHasKeys(loc.clip.keyframes, "maxHeight")
          ? effectiveValue(loc.clip, "maxHeight", loc.clip.maxHeight ?? 0, boxLocal)
          : loc.clip.maxHeight;
        g.resizeStartWidth =
          keyedW ?? Math.max(50, Math.abs((g.resizeStartHalfBoxW * 2) / (pose?.scale || 1)));
        g.resizeStartHeight =
          keyedH ?? Math.max(24, Math.abs((g.resizeStartHalfBoxH * 2) / (pose?.scaleY || 1)));
        g.resizeTextFixed = keyedH != null;
      } else if (g.resizeNativeKind === "shape" && loc && loc.clip.kind === "shape") {
        // Edit the shape's intrinsic size (sampled at the playhead so a keyframed
        // width/height drags relative to what's on screen).
        const size = shapeSizeAt(loc.clip, clipLocalClamped(loc.clip, useSession.getState().playheadMs));
        g.resizeStartWidth = size.width;
        g.resizeStartHeight = size.height;
      } else if (g.resizeNativeKind === "layout" && loc && loc.clip.kind === "group") {
        // The container's box as it stands — hugging or fixed, this is the
        // number the drag starts from and the axis it touches becomes fixed.
        const box = clipBox(visualState(), loc.clip);
        g.resizeStartWidth = box.width;
        g.resizeStartHeight = box.height;
        g.layoutStartCorner = { x: loc.clip.layout!.x, y: loc.clip.layout!.y };
        g.layoutStartCentre = { x: box.cx, y: box.cy };
      }
      // Snap the grabbed corner/edge to the other layers + page while resizing.
      g.snapCandidates = loc ? buildStageCandidates(new Set([rect.clipId]), loc.clip.frameId) : null;
      g.mergeKey = `canvas-resize-${e.pointerId}`;

      // ⌘/Ctrl + EDGE → "transform mode": the resize state above is ready to
      // SCALE, but a shear is also possible. Rather than force one, we DEFER and
      // read intent from the drag direction (Figma-natural): dragging ALONG the
      // grabbed edge shears (skew), dragging ACROSS it scales. Resolved on the
      // first decisive movement in `transform-edge`. Corners keep plain scale.
      const isEdge = handleHit.sx === 0 || handleHit.sy === 0;
      const skewable = !!loc && loc.clip.kind !== "audio" && !isClipLocked(loc.track, loc.clip);
      if ((e.metaKey || e.ctrlKey) && isEdge && skewable) {
        g.mode = "transform-edge";
        g.skewClipId = rect.clipId;
        if (handleHit.sx === 0) {
          // Top/bottom edge (line along local X): along→skewX, across→scale height.
          g.skewAxis = "x";
          g.skewDenom = handleHit.sy * Math.max(1, rect.height / 2);
          g.skewStartTan = Math.tan((rect.skewX * Math.PI) / 180);
        } else {
          // Left/right edge (line along local Y): along→skewY, across→scale width.
          g.skewAxis = "y";
          g.skewDenom = handleHit.sx * Math.max(1, rect.width / 2);
          g.skewStartTan = Math.tan((rect.skewY * Math.PI) / 180);
        }
        g.skewRot = rect.rotation;
        g.skewStartWorld = toWorld(p);
        g.mergeKey = `canvas-transform-${e.pointerId}`;
      }
      return;
    }

    // Group resize: a handle on the multi-select bounding box scales every
    // selected layer together, about the group center, keeping their layout.
    const groupHandleHit = hitTestGroupResizeHandle(p);
    if (groupHandleHit) {
      g.mode = "resize-group";
      const box = groupHandleHit.box;
      g.groupCx = box.cx;
      g.groupCy = box.cy;
      g.groupHw = box.hw;
      g.groupHh = box.hh;
      // Which corner was grabbed — the sign is what lets the drag cross the
      // group center and MIRROR the whole arrangement (see core `resize.ts`).
      g.groupSx = (CORNER_DIRS[groupHandleHit.corner]?.x ?? 1) as HandleSign;
      g.groupSy = (CORNER_DIRS[groupHandleHit.corner]?.y ?? 1) as HandleSign;
      g.groupClips = [];
      const docNow = store.getState();
      const playhead = useSession.getState().playheadMs;
      for (const id of useSession.getState().selectedClipIds) {
        const loc = locateClip(docNow, id);
        if (!loc || loc.clip.kind === "audio" || isClipLocked(loc.track, loc.clip)) continue;
        const fr = docNow.frames.find((f) => f.id === loc.clip.frameId);
        if (!fr) continue;
        const pose = clipPose(loc.clip, clipLocalClamped(loc.clip, playhead));
        // The comp's centre in WORLD — its chain, never its page coordinates.
        const fo = frameSpace(fr.id, docNow)?.toWorld({ x: 0, y: 0 }) ?? {
          x: fr.x + fr.width / 2,
          y: fr.y + fr.height / 2,
        };
        g.groupClips.push({
          id,
          fcx: fo.x,
          fcy: fo.y,
          x0: pose.x,
          y0: pose.y,
          s0: pose.scale,
          sy0: pose.scaleY,
          syNull: loc.clip.transform.scaleY == null,
        });
      }
      g.mergeKey = `group-resize-${e.pointerId}`;
      return;
    }

    // Rotate: grabbing the band just OUTSIDE a corner spins the selection about
    // its center. Tested AFTER every resize handle/edge so it can only claim the
    // empty space beyond the grab-dots — this mirrors `updateCursor`'s priority
    // (resize wins over rotate), so the gesture always matches the shown cursor.
    const rotateHit = hitTestRotateZone(p);
    if (rotateHit) {
      const docNow = store.getState();
      const playhead = useSession.getState().playheadMs;
      g.mode = "rotate";
      g.rotateCx = rotateHit.wcx;
      g.rotateCy = rotateHit.wcy;
      g.rotateAppliedDelta = 0;
      g.rotateBearing = rotateHit.bearing;
      g.rotateSnapping = false;
      g.rotateClips = [];
      for (const id of useSession.getState().selectedClipIds) {
        const loc = locateClip(docNow, id);
        if (!loc || loc.clip.kind === "audio" || isClipLocked(loc.track, loc.clip)) continue;
        const pose = clipPose(loc.clip, clipLocalClamped(loc.clip, playhead));
        // The orbit is measured PIVOT-to-centre, because a layer's position IS
        // its pivot — so writing x/y moves the pivot exactly onto its new spot.
        // A single layer needs no orbit at all: its own rotation already turns it
        // about its pivot, and orbiting too would double-apply the turn.
        const single = useSession.getState().selectedClipIds.length === 1;
        const pw = single ? null : pivotWorld(id);
        g.rotateClips.push({
          id,
          rot0: pose.rotation,
          x0: pose.x,
          y0: pose.y,
          dx: pw ? pw.x - rotateHit.wcx : 0,
          dy: pw ? pw.y - rotateHit.wcy : 0,
        });
      }
      g.rotatePrimaryStart = g.rotateClips[0]?.rot0 ?? 0;
      // ONE recognizer for every turn in the app — see `beginRotate`.
      g.rotateTracker = beginRotate({
        centre: { x: rotateHit.wcx, y: rotateHit.wcy },
        start: toWorld(p),
        baseDeg: g.rotatePrimaryStart,
      });
      g.mergeKey = `canvas-rotate-${e.pointerId}`;
      dirtyRef.current = true;
      return;
    }

    const labelFrame = hitTestLabel(p);
    if (labelFrame) {
      // ⇧-click a label toggles that frame in the multi-selection (no drag).
      if (e.shiftKey) {
        session.selectFrames([labelFrame], true);
        return;
      }
      // Plain click: if the frame is already part of a multi-selection keep the
      // whole set (drag them together); otherwise select just this one.
      const already = useSession.getState().selectedFrameIds.includes(labelFrame);
      if (!already) session.selectFrame(labelFrame);
      if (e.altKey) {
        let newId: string | null = null;
        g.mergeKey = `frame-dup-${e.pointerId}`;
        store.update("Duplicate frame", (d) => {
          newId = duplicateFrame(d, labelFrame);
          // Alt-drag duplicates IN PLACE and travels with the cursor (like layer
          // ⌥-drag) — no "poops a copy off to the side". The copy sits exactly on
          // the original until you drag it to where you drop.
          const src = d.frames.find((x) => x.id === labelFrame);
          const dup = newId ? d.frames.find((x) => x.id === newId) : null;
          if (src && dup) {
            dup.x = src.x;
            dup.y = src.y;
          }
        }, {
          mergeKey: g.mergeKey,
        });
        if (newId) session.selectFrame(newId);
      } else {
        g.mergeKey = `frame-drag-${e.pointerId}`;
      }
      // Drag every selected frame together (the grabbed one drives nest-on-drop).
      const docNow = store.getState();
      const sel = useSession.getState().selectedFrameIds;
      const ids = sel.includes(labelFrame) ? sel : [labelFrame];
      g.frameDrags = ids
        .map((id) => docNow.frames.find((x) => x.id === id))
        .filter((f): f is Frame => !!f)
        .map((f) => ({ id: f.id, ox: f.x, oy: f.y }));
      const grabbed = docNow.frames.find((x) => x.id === labelFrame) ?? docNow.frames[0]!;
      g.mode = "drag-frame";
      g.frameDragId = grabbed.id;
      g.frameOrigin = { x: grabbed.x, y: grabbed.y };
      g.dragStart = p;
      return;
    }

    // The press target and the SELECTION target are two different questions,
    // and answering them with one hit test was the bug: a big selected
    // background swallowed every click on the small layers stacked over it.
    //   • `top`  — the topmost layer under the cursor. This is what a CLICK
    //              selects, always (⇧-click too: it is an explicit "this exact
    //              layer" gesture).
    //   • `held` — the press landed ON the selection: a selected layer in the
    //              stack (below `top`, possibly), a member of a selected group,
    //              or the air inside the selection's box. This is what a DRAG
    //              moves, so dragging keeps hold of the set you already had —
    //              with ⇧ too, which used to switch this off and turn every
    //              ⇧-constrained drag into a re-selection.
    // When they disagree the press starts as a grab and the reselect is
    // deferred to release (`resolvePressSelection`, core).
    const stack = hitStackAt(p);
    const top = stack[0] ?? null;
    const selectedNow = new Set(session.selectedClipIds);
    const inSelectionBox = (): boolean => {
      const box = selectedNow.size > 0 ? selectionGroupBox(session.selectedClipIds, hitRectsRef.current) : null;
      if (!box) return false;
      const w = toWorld(p);
      return Math.abs(w.x - box.cx) <= box.hw && Math.abs(w.y - box.cy) <= box.hh;
    };
    const held =
      pressHoldsSelection(store.getState(), stack.map((h) => h.clipId), session.selectedClipIds) || inSelectionBox();
    // The rect the drag is anchored to: the selected layer under the point
    // when there is one, else any selected rect (the box's air), else the top.
    const grabbed = held
      ? (stack.find((h) => pressHoldsSelection(store.getState(), [h.clipId], session.selectedClipIds)) ??
        hitRectsRef.current.find((h) => selectedNow.has(h.clipId)) ??
        top)
      : top;
    const hit = grabbed ?? top;

    /**
     * A bound text does not MOVE — its place is the host's. Grabbing it, or its
     * grip, slides it along the outline instead, which is the one thing a drag
     * on it can mean. The lap it starts on is remembered so a slide across the
     * seam of a circle keeps counting rather than snapping back a whole turn.
     */
    const startPathSlide = (clipId: string): boolean => {
      const loc = locateClip(store.getState(), clipId);
      if (!loc || !isPathText(loc.clip) || isClipLocked(loc.track, loc.clip)) return false;
      const local = clipLocalClamped(loc.clip, session.playheadMs);
      const kf = sampleKeyframes(loc.clip.keyframes, local);
      g.mode = "path-slide";
      g.pathSlideClipId = clipId;
      g.pathSlideNear = typeof kf["path.offset"] === "number" ? (kf["path.offset"] as number) : loc.clip.path.offset;
      g.mergeKey = `path-slide-${e.pointerId}`;
      g.moved = false;
      claimPointer(e.pointerId, "drag");
      dirtyRef.current = true;
      return true;
    };
    {
      const selId = session.selectedClipIds.length === 1 ? session.selectedClipIds[0]! : null;
      if (selId && !drill) {
        const gripLoc = locateClip(store.getState(), selId);
        const grip = gripLoc && isPathText(gripLoc.clip) ? textPathGripScreen(gripLoc.clip) : null;
        if (grip && Math.hypot(p.x - grip.x, p.y - grip.y) <= PATH_GRIP_HIT_PX && startPathSlide(selId)) return;
      }
    }

    /** Arm a move of `ids` from this press — the one tail every layer grab shares. */
    const startLayerDrag = (ids: string[], frameId: string): void => {
      if (ids.length === 1 && startPathSlide(ids[0]!)) return;
      // A member of a laid-out group is not moved — it is REORDERED: its place
      // is the container's to give, so a drag carries it to another slot.
      if (ids.length === 1) {
        const member = locateClip(store.getState(), ids[0]!);
        const container = member ? containerOf(ids[0]!) : null;
        if (member && container && member.clip.kind !== "audio" && !member.clip.layoutItem.absolute) {
          const geo = layoutGeometry(container.id);
          const slot = geo?.slots.find((s) => s.id === ids[0]);
          if (!geo || !slot) return;
          const order = layoutMembersOf(stageDoc() ?? store.getState(), geo.group).map((m) => m.id);
          g.mode = "layout-reorder";
          g.layoutReorderClipId = ids[0]!;
          g.layoutGroupId = container.id;
          g.layoutReorder = {
            press: p,
            grab: geo.space.fromWorld(toWorld(p)),
            grabSlot: { x: slot.x, y: slot.y },
            slots: geo.slots,
            order,
            fromIndex: order.indexOf(ids[0]!),
            index: order.indexOf(ids[0]!),
            mergeKey: `layout-reorder-${e.pointerId}`,
          };
          g.moved = false;
          claimPointer(e.pointerId, "drag");
          dirtyRef.current = true;
          return;
        }
      }
      g.mode = "drag-layers";
      g.moved = false;
      g.dragBaseIds = ids;
      g.dupIds = null;
      g.dragStart = p;
      g.mergeKey = `canvas-drag-${e.pointerId}`;
      g.dragOrigins.clear();
      g.dragBaseOrigins.clear();
      const docNow = store.getState();
      const playhead = useSession.getState().playheadMs;
      for (const id of ids) {
        const loc = locateClip(docNow, id);
        if (loc && loc.clip.kind !== "audio" && !isClipLocked(loc.track, loc.clip)) {
          // Origin = what's on screen (sampled when keyframed), not the raw base.
          const pose = clipPose(loc.clip, clipLocalClamped(loc.clip, playhead));
          g.dragOrigins.set(id, { x: pose.x, y: pose.y });
          g.dragBaseOrigins.set(id, { x: pose.x, y: pose.y });
        }
      }
      // Smart guides: candidates from the drag's home frame (siblings + page), and
      // the moving selection's start box — the drag delta rides on top of this,
      // then snaps. Built once; static for the whole gesture.
      const box = selectionGroupBox(ids, hitRectsRef.current);
      g.dragStartBox = box ? { minX: box.cx - box.hw, minY: box.cy - box.hh, maxX: box.cx + box.hw, maxY: box.cy + box.hh } : null;
      g.snapCandidates = buildStageCandidates(new Set(ids), frameId);
      // Live ⇧/⌥: re-apply the drag the instant a modifier toggles, even with the
      // pointer held still — one shared watcher (drag-modifiers) drives real-time
      // axis-constrain and duplicate for every draggable.
      g.modWatch?.();
      g.modWatch = watchDragModifiers(readMods(e), (mods) => applyDragLayers(mods));
    };

    if (!hit) {
      // Empty-space press (locked clips are transparent to the hit stack, so a
      // locked backdrop no longer blocks the marquee either).
      // Figma intent split: a press that lands on a frame's bare interior
      // means "work inside that frame" (marquee its children, targets it for
      // new layers). A press on the truly empty canvas (over no frame) means
      // "work with frames" — the marquee will pick FRAMES.
      const overFrame = frameAtWorld(toWorld(p));
      if (overFrame) session.setActiveComp(overFrame.id);
      /*
       * A RUBBER BAND IS THE ONE STAGE GESTURE A FINGER SHOULD NOT GET FOR
       * FREE. It starts from exactly the press that means "nothing here", it
       * replaces the selection you had built up, and it is the gesture a
       * resting palm produces. So the sweep asks for itself — the tool door
       * above could not, because at press time it did not yet know the press
       * would land on empty space.
       *
       * Refused, the press still CLEARS the selection, which is what tapping
       * empty space means everywhere. It just does not draw a box.
       */
      if (!rectSweepAllowed(e, "canvas")) {
        if (!e.shiftKey) session.clearSelection();
        dirtyRef.current = true;
        return;
      }
      g.mode = "marquee";
      g.marqueeStart = p;
      g.marqueeEnd = p;
      // No frame under the start → marquee FRAMES — but never while isolated
      // (you can't rubber-band the locked siblings you're drilled away from; the
      // marquee stays scoped to the focused frame's own clips). Same one seam.
      g.marqueeFrames = !overFrame && isolationFocusId(store.getState(), useSession.getState()) == null;
      g.marqueeBase = e.shiftKey
        ? g.marqueeFrames
          ? session.selectedFrameIds
          : session.selectedClipIds
        : [];
      if (!e.shiftKey) session.clearSelection();
      dirtyRef.current = true;
      return;
    }

    // ⇧ semantics resolve at RELEASE (Figma): ⇧-CLICK toggles a layer in/out of
    // the selection, but ⇧-DRAG constrains a MOVE of the whole selection. So a
    // ⇧ press never early-returns — it starts a potential drag and defers the
    // toggle to a press that turned out to be a click (handled in onPointerUp).
    // Shared resolver (same brain as the timeline): a ⇧-click targets the exact
    // leaf; a plain click selects the unit at the deepest open group (Figma).
    // A press on the box's air has no `top` and nothing to retarget to.
    const picks = !top
      ? []
      : e.shiftKey
        ? [top.clipId]
        : expandSelectionToGroups(store.getState(), [top.clipId], session.enteredGroupId);
    const sel = resolvePressSelection(session.selectedClipIds, picks, e.shiftKey, held);
    if (sel.changed) session.select(sel.selection);
    g.selectOnClick = sel.onClick ? { ids: sel.onClick, hostFrameId: (top ?? hit).hostFrameId } : null;
    // The frame you're EDITING IN is the one you clicked (the host) — for a
    // linked instance that's the instance frame, not the shared master — so
    // gizmos/handles land where you clicked and drags stay parent-safe. Inside
    // a nested context this is always the target you're already in, so it is a
    // no-op: clicking a layer never changes where you are.
    session.setActiveComp(hit.hostFrameId);
    startLayerDrag(useSession.getState().selectedClipIds, hit.frameId);
  };

  /**
   * The layer-drag brain — a pure-ish function of (last pointer + modifiers), so
   * BOTH pointer-move and the live modifier watcher call it and the drag reacts
   * to ⇧/⌥ in real time. ⌥ toggles a real duplicate on/off (originals hold at
   * base, copies ride the drag); ⇧ constrains the delta to a snapped angle (and
   * suppresses align-snap, like Figma); otherwise smart-guide snapping applies.
   */
  /**
   * The crop REFRAME brain — one body for both halves of the gesture, shared by
   * pointermove and the live modifier watcher so ⌥ takes effect the instant it
   * is pressed, with the pointer held perfectly still.
   *
   * Two things can move, and they are opposites:
   *  · `crop-pan` slides the WINDOW across a fixed picture (all four insets move
   *    together, window size held) — the crop rectangle travels on canvas.
   *  · `crop-content` slides the PICTURE under a fixed window — the layer moves
   *    one way while the insets absorb the same amount the other way, so the
   *    rectangle stays put on canvas and the image travels through it.
   *
   * ⌥ INVERTS whichever one the press meant, so the modifier always reads as
   * "do the other thing" wherever you grabbed. Flipping re-bases the gesture on
   * the values and pointer position at that moment, so the switch is seamless:
   * nothing jumps, and the whole drag stays a single undo step.
   */
  /**
   * Steer a motion-path tangent. Shares the pen's modifier contract exactly:
   * ⇧ locks the arm to a 15° ray, ⌥ breaks the mirror so only the grabbed side
   * moves, and dropping the knob back on its own anchor dissolves the handle
   * (the node becomes a corner). Split out of pointermove so the live modifier
   * watcher can re-run it with the pointer held still — press ⌥ mid-drag and the
   * far side lets go THEN, not on the next mouse move.
   */
  const applyMotionHandle = (mods: DragMods) => {
    const g = gesture.current;
    const view = useStageView.getState();
    const w = toWorld(lastPointerRef.current);
    store.update(
      "Adjust motion handle",
      (d) => {
        const loc = locateClip(d, g.motionClipId);
        if (!loc || loc.clip.kind === "audio") return;
        const key = motionKeysOf(loc.clip).find((k) => Math.abs(k.timeMs - g.motionTimeMs) < 0.5);
        if (!key) return;
        // A motion key already stores its arms as vectors from the anchor, so
        // the whole gesture is the shared brain plus this one subtraction.
        const res = resolveTangentDrag(g.motionDrag, {
          vector: (() => {
            const anchor = motionLocalToWorld(g.motionClipId, key);
            return { x: w.x - anchor.x, y: w.y - anchor.y };
          })(),
          alt: mods.alt,
          shift: mods.shift,
          dissolveWithin: PATH_HIT.handleDissolve / Math.max(0.001, view.scale),
        });
        // Pulling fresh arms out of a corner is a balanced gesture by
        // definition — ⌥ is what STARTED it, so it must not also read as "break".
        const mirror = g.motionFreshHandles || res.partner != null;
        setMotionTangent(loc.clip, g.motionTimeMs, g.motionEnd, res.dragged, mirror);
      },
      { mergeKey: g.mergeKey },
    );
    dirtyRef.current = true;
  };

  const applyCropReframe = (mods: DragMods) => {
    const g = gesture.current;
    // A corner grab is a ZOOM and stays one — ⌥ only ever swaps the two drags
    // that are opposites of each other.
    const wanted =
      g.cropPressMode === "crop-zoom"
        ? "crop-zoom"
        : mods.alt
          ? g.cropPressMode === "crop-pan"
            ? "crop-content"
            : "crop-pan"
          : g.cropPressMode;
    if (wanted !== g.mode) {
      // Re-base: adopt the values the drag has produced so far as the new start,
      // and re-anchor to where the pointer is NOW. Without this, switching mode
      // mid-drag would replay the whole delta into the other property and snap.
      const geo = cropGeom(g.cropClipId);
      if (geo) {
        g.cropStart = { ...geo.crop };
        g.cropContentStart = { ...geo.content };
      }
      g.cropStartWorld = toWorld(lastPointerRef.current);
      g.mode = wanted;
      updateCursor(lastPointerRef.current);
    }

    // Pointer delta, un-rotated onto the box's own axes and de-scaled into the
    // media's natural px — so a rotated or resized layer reframes true to itself.
    const dw = toWorld(lastPointerRef.current);
    const rad = (g.cropRot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const ddx = dw.x - g.cropStartWorld.x;
    const ddy = dw.y - g.cropStartWorld.y;
    const dPxX = (ddx * cos + ddy * sin) / Math.max(0.001, g.cropScaleX);
    const dPxY = (-ddx * sin + ddy * cos) / Math.max(0.001, g.cropScaleY);
    const st = g.cropStart;
    const ins = g.cropInsets;
    const playhead = useSession.getState().playheadMs;

    if (g.mode === "crop-content") {
      // GRAB THE PICTURE AND DRAG IT — one property, nothing cancelling.
      //
      // This used to move the LAYER one way and absorb the same amount back
      // into the insets, so the window held still. It worked, and it cost:
      // reframing wrote `x`/`y`, so it fought any animation the layer had; the
      // delta had to be clamped in exactly one place or the two halves drifted
      // and the window crept; and there was no equivalent trick for ZOOM at
      // all, which is the thing people actually wanted (core's
      // `contentTransformSchema` has the full account).
      //
      // The pan lives OUTSIDE the zoom (core's `mapContent`), so it is already
      // in the layer's final px: the picture follows the pointer 1:1 at any
      // zoom, with nothing to divide by and nothing to drift.
      const nx = g.cropContentStart.x + dPxX * g.cropContentSign.x;
      const ny = g.cropContentStart.y + dPxY * g.cropContentSign.y;
      store.update(
        "Move image in crop",
        (d) => {
          const loc = locateClip(d, g.cropClipId);
          if (!loc || loc.clip.kind === "audio") return;
          commitProperty(loc.clip, "content.x", Math.round(nx), playhead);
          commitProperty(loc.clip, "content.y", Math.round(ny), playhead);
        },
        { mergeKey: g.mergeKey },
      );
      g.moved = true;
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "crop-zoom") {
      /*
       * RESIZE THE PICTURE inside a window that does not move — through the
       * SAME solver every other resize in this app goes through.
       *
       * It used to be a ratio of two radii from the picture's centre, which is
       * the arithmetic you write when a gesture is the only one of its kind:
       * always uniform, always about the centre, no mirror, and ⇧ and ⌥ meant
       * nothing. But this is a corner drag on a rotated box, which is exactly
       * what `solveResizeFactors` answers, and answering it twice is how one
       * copy ends up without a modifier the other has.
       *
       * So the picture's quad becomes a `ResizeBox` and the layer's own rules
       * arrive with it: ⇧ locks the aspect, ⌥ grows about the centre, and a
       * drag across the anchor MIRRORS the footage (a negative content scale —
       * the same model `resize.ts` uses for layers, not a second flip flag).
       * `resizeCenter` then says where the picture's centre has to sit for the
       * anchor to stay pinned, and that offset becomes the pan.
       */
      const geo = cropGeom(g.cropClipId);
      if (!geo) return;
      const q = geo.mediaRect;
      // The quad's own axes, MEASURED — so a mirrored or rotated picture is
      // described correctly without a special case.
      const topX = q.ne.x - q.nw.x;
      const topY = q.ne.y - q.nw.y;
      const halfW = Math.hypot(topX, topY) / 2;
      const halfH = Math.hypot(q.sw.x - q.nw.x, q.sw.y - q.nw.y) / 2;
      if (!(halfW > 0.01) || !(halfH > 0.01)) return;
      const rotation = (Math.atan2(topY, topX) * 180) / Math.PI;
      const ax = localAxes(rotation);
      const grabbed = q[g.cropZoomCorner];
      const gx = grabbed.x - geo.picCentre.x;
      const gy = grabbed.y - geo.picCentre.y;
      const box = {
        cx: geo.picCentre.x,
        cy: geo.picCentre.y,
        rotation,
        halfW,
        halfH,
        sx: resizeSign(gx * ax.uxx + gy * ax.uxy) as HandleSign,
        sy: resizeSign(gx * ax.uyx + gy * ax.uyy) as HandleSign,
      };
      const f = solveResizeFactors(box, lastPointerRef.current, {
        centerAnchor: mods.alt,
        keepAspect: mods.shift,
        allowMirror: true,
      });
      const base = g.cropContentStart;
      const baseY = base.scaleY ?? base.scale;
      const next = clampScale(base.scale * f.fx, 0.02);
      const nextY = clampScale(baseY * f.fy, 0.02);
      // Where the picture's centre must land for the anchor to hold — fed the
      // REALIZED factors, so a clamp at the scale floor still pins the corner.
      const realized = {
        fx: realizedFactor(next, base.scale, f.fx),
        fy: realizedFactor(nextY, baseY, f.fy),
      };
      const c = resizeCenter(box, realized, mods.alt);
      // Screen → the layer's own px: undo the view zoom, the layer's rotation
      // and its scale, exactly as the pan branch above does.
      const view = useStageView.getState();
      const dwx = (c.x - geo.picCentre.x) / Math.max(0.001, view.scale);
      const dwy = (c.y - geo.picCentre.y) / Math.max(0.001, view.scale);
      const panX = g.cropContentStart.x + ((dwx * cos + dwy * sin) / Math.max(0.001, g.cropScaleX)) * g.cropContentSign.x;
      const panY = g.cropContentStart.y + ((-dwx * sin + dwy * cos) / Math.max(0.001, g.cropScaleY)) * g.cropContentSign.y;
      // ⇧ locks the aspect, so the two axes stay linked rather than both being
      // written — `scaleY: null` IS the link, same as a layer's transform.
      const linked = mods.shift && base.scaleY == null;
      store.update(
        "Resize image in crop",
        (d) => {
          const loc = locateClip(d, g.cropClipId);
          if (!loc || loc.clip.kind === "audio") return;
          commitProperty(loc.clip, "content.scale", Number(next.toFixed(4)), playhead);
          if (!linked) commitProperty(loc.clip, "content.scaleY", Number(nextY.toFixed(4)), playhead);
          commitProperty(loc.clip, "content.x", Math.round(panX), playhead);
          commitProperty(loc.clip, "content.y", Math.round(panY), playhead);
        },
        { mergeKey: g.mergeKey },
      );
      g.moved = true;
      dirtyRef.current = true;
      return;
    }

    // Pan the crop WINDOW across the image (image + transform fixed): the
    // window keeps its size, we just shift which region shows. All four insets
    // move together, and it's clamped so the window can't leave the media.
    const winW = g.cropNatW - st.left - st.right; // constant during a pan
    const winH = g.cropNatH - st.top - st.bottom;
    // Pan in VISUAL sides so the window follows the pointer on a mirrored layer.
    const w2 = Math.max(0, Math.min(st[ins.w] + dPxX, g.cropNatW - winW));
    const n = Math.max(0, Math.min(st[ins.n] + dPxY, g.cropNatH - winH));
    const e2 = g.cropNatW - winW - w2;
    const sIn = g.cropNatH - winH - n;
    store.update(
      "Reframe crop",
      (d) => {
        const loc = locateClip(d, g.cropClipId);
        if (!loc || loc.clip.kind === "audio") return;
        commitProperty(loc.clip, `crop.${ins.w}`, Math.round(w2), playhead);
        commitProperty(loc.clip, `crop.${ins.e}`, Math.round(e2), playhead);
        commitProperty(loc.clip, `crop.${ins.n}`, Math.round(n), playhead);
        commitProperty(loc.clip, `crop.${ins.s}`, Math.round(sIn), playhead);
      },
      { mergeKey: g.mergeKey },
    );
    g.moved = true;
    dirtyRef.current = true;
  };

  const applyDragLayers = (mods: DragMods) => {
    const g = gesture.current;
    const view = useStageView.getState();
    const p = lastPointerRef.current;
    const dxs = p.x - g.dragStart.x;
    const dys = p.y - g.dragStart.y;
    if (!g.moved && Math.hypot(dxs, dys) < 3) return;
    g.moved = true;
    const playhead = useSession.getState().playheadMs;

    // ── ⌥ duplicate, toggled live ──
    if (mods.alt && !g.dupIds) {
      const created: string[] = [];
      store.update(
        "Duplicate layer",
        (d) => {
          // Originals snap back to base (they may have moved before ⌥ went down)
          // so the copies — not the originals — are what travels.
          for (const [id, o] of g.dragBaseOrigins) {
            const loc = locateClip(d, id);
            if (loc && loc.clip.kind !== "audio") {
              writeAnimatable(loc.clip, "x", o.x, playhead, (c) => { if (c.kind !== "audio") c.transform.x = o.x; });
              writeAnimatable(loc.clip, "y", o.y, playhead, (c) => { if (c.kind !== "audio") c.transform.y = o.y; });
            }
          }
          for (const id of g.dragBaseIds) {
            const n = duplicateClipInPlace(d, id);
            if (n) created.push(n);
          }
        },
        { mergeKey: g.mergeKey },
      );
      if (created.length > 0) {
        g.dupIds = created;
        useSession.getState().select(created);
        const docNow = store.getState();
        g.dragOrigins.clear();
        for (const id of created) {
          const loc = locateClip(docNow, id);
          if (loc && loc.clip.kind !== "audio") g.dragOrigins.set(id, { x: loc.clip.transform.x, y: loc.clip.transform.y });
        }
      }
    } else if (!mods.alt && g.dupIds) {
      const dupIds = g.dupIds;
      store.update("Move layer", (d) => { for (const id of dupIds) deleteClip(d, id); }, { mergeKey: g.mergeKey });
      g.dupIds = null;
      useSession.getState().select(g.dragBaseIds);
      g.dragOrigins = new Map(g.dragBaseOrigins);
    }

    // ── Delta: ⇧ angle-constrain (suppresses align-snap), else smart guides ──
    let dxf = dxs / view.scale;
    let dyf = dys / view.scale;
    if (mods.shift) {
      const c = constrainDragToAngle(dxf, dyf);
      dxf = c.dx;
      dyf = c.dy;
      const b = g.dragStartBox;
      constrainAxisRef.current = b
        ? { angleDeg: c.angleDeg, cx: (b.minX + b.maxX) / 2 + dxf, cy: (b.minY + b.maxY) / 2 + dyf }
        : null;
      activeGuidesRef.current = { v: [], h: [] };
    } else {
      constrainAxisRef.current = null;
      if (g.snapCandidates && g.dragStartBox && useSession.getState().guides && !mods.meta) {
        const b = g.dragStartBox;
        const moved: AABB = { minX: b.minX + dxf, minY: b.minY + dyf, maxX: b.maxX + dxf, maxY: b.maxY + dyf };
        const threshold = useSession.getState().guideSettings.thresholdPx / view.scale;
        const snap = snapMove(moved, g.snapCandidates, threshold);
        dxf += snap.dx;
        dyf += snap.dy;
        activeGuidesRef.current = { v: snap.v, h: snap.h };
      } else {
        activeGuidesRef.current = { v: [], h: [] };
      }
    }

    // The pointer measured a WORLD delta, but a clip's transform lives in its
    // own comp's space. Inside a scaled/rotated instance those differ, so the
    // delta is mapped down through the context — identity at the top level.
    //
    // PER CLIP, because a selection can now span depths: a piece inside a
    // half-size nested comp and a layer on the artboard both move exactly as
    // far as the cursor went, in the direction it went, in the same drag.
    const dragDoc = store.getState();
    const dragSession = useSession.getState();
    const localByFrame = new Map<string, { x: number; y: number }>();
    const localDelta = (id: string, frameId: string): { x: number; y: number } => {
      const cached = localByFrame.get(frameId);
      if (cached) return cached;
      const c = clipContext(dragDoc, dragSession, id);
      const v = c ? worldDeltaToTarget(c, dxf, dyf) : { x: dxf, y: dyf };
      localByFrame.set(frameId, v);
      return v;
    };
    store.update(
      "Move layer",
      (d) => {
        for (const [id, origin] of g.dragOrigins) {
          const loc = locateClip(d, id);
          if (loc && loc.clip.kind !== "audio") {
            const local = localDelta(id, loc.clip.frameId);
            const nx = Math.round(origin.x + local.x);
            const ny = Math.round(origin.y + local.y);
            writeAnimatable(loc.clip, "x", nx, playhead, (c) => { if (c.kind !== "audio") c.transform.x = nx; });
            writeAnimatable(loc.clip, "y", ny, playhead, (c) => { if (c.kind !== "audio") c.transform.y = ny; });
          }
        }
      },
      { mergeKey: g.mergeKey },
    );
    dirtyRef.current = true;
  };

  /**
   * THE STAGE'S TOOL DOOR — pen-only, plus the two-finger rule, in one place.
   *
   * `onPointerDown` below is the entry for every stage tool: select, pen,
   * shape, frame, text, eyedropper. Wrapping it here means a finger that is
   * not allowed to author, or a second finger that turns the gesture into a
   * pinch, never reaches ANY of them — rather than each tool growing its own
   * copy of the same two checks and one of them being wrong.
   *
   * The two-finger half matters even with pen-only off: the second finger of a
   * pinch used to land as a fresh tool press, so zooming with the brush armed
   * painted a dab and zooming with the frame tool started a frame.
   */
  /**
   * THE STAGE'S TOOL DOOR — every stage tool (select, pen, shape, frame, text,
   * eyedropper) enters here, so the rules about WHICH pointers may author live
   * once instead of twelve times.
   *
   * Three of them, in order:
   *   1. a pinch already owns the surface → its fingers are not tool presses.
   *      Without this the second finger of a zoom landed as a fresh press, so
   *      zooming with the brush armed painted a dab.
   *   2. pointer authority (`pointerMay`, inside the intent hook) — which
   *      asks what the ARMED TOOL does, so a finger that may not paint can
   *      still move a layer.
   *   3. with pen-only OFF, a finger still has to say what it MEANT — move
   *      first and it pans, hold still and it authors. See `useTouchIntent`.
   */
  const onStagePointerDown = useTouchIntent({
    // WHICH act, per press, from the armed tool — so a finger that may not
    // paint can still move a layer, pull a handle or drag out a text box.
    // `select` reports `transform`; the one case where a select press is
    // really a sweep asks for itself where the stage discovers there was
    // nothing under the pointer (see the marquee branch).
    act: () => actForTool(useSession.getState().tool),
    onTool: (e) => {
      if (touch.active()) return;
      onPointerDown(e);
    },
    // Navigation verdict: move the camera, exactly as the middle-drag and
    // space-pan paths do, so a finger pan and every other pan are one motion
    // model rather than two that drift.
    onPan: (dx, dy) => {
      if (touch.active()) return;
      const view = useStageView.getState();
      applyCamera({ scale: view.scale, tx: view.tx + dx, ty: view.ty + dy });
    },
  });

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    const p = localPoint(e);
    lastPointerRef.current = p;

    // Keep the paste anchor fresh so a keyboard ⌘V of media lands under the
    // cursor, in frame-relative coords (the same convention a drop uses).
    const anchorWorld = toWorld(p);
    const anchorFrame = frameAtWorld(anchorWorld);
    const anchorAt = anchorFrame ? frameSpace(anchorFrame.id)?.fromWorld(anchorWorld) : null;
    setStagePasteAnchor(
      anchorFrame
        ? {
            frameId: anchorFrame.id,
            x: Math.round(anchorAt?.x ?? anchorWorld.x - (anchorFrame.x + anchorFrame.width / 2)),
            y: Math.round(anchorAt?.y ?? anchorWorld.y - (anchorFrame.y + anchorFrame.height / 2)),
          }
        : null,
    );

    // Hover cursor (no gesture running).
    if (g.mode === "none") {
      if (e.target === canvasRef.current) updateCursor(p);
      // The stage half of the shared hover (D20): the select tool's topmost
      // layer under the pointer lights its Layers row.
      if (useSession.getState().tool === "select") useHoverLink.getState().set(hitTestClip(p)?.clipId ?? null, "stage");
      // Motion-path marks light up under the pointer and the curve offers its
      // insert badge, so an idle move has to repaint — but only while a path is
      // actually on screen, so this costs nothing the rest of the time.
      if (motionSceneRef.current) dirtyRef.current = true;
      return;
    }
    if (!g.pointers.has(e.pointerId)) return;
    // A two-finger gesture owns the surface outright: the first finger's drag
    // was cancelled when the second landed, and letting its moves through here
    // would drag a layer around underneath the pinch.
    if (touch.active()) return;
    const prev = g.pointers.get(e.pointerId) ?? p;
    g.pointers.set(e.pointerId, p);
    const view = useStageView.getState();

    /*
     * THE PIVOT'S BID RESOLVES HERE, before anything else can act on this move.
     *
     * The press landed on the crosshair outside pivot mode, so it was handed to
     * whatever was underneath (a motion key, the layer) and that gesture is
     * PROVISIONAL until the hold says which one this was. Three outcomes, and
     * the middle one is the load-bearing one:
     *
     *   armed      the stillness landed and then moved: the pivot takes over.
     *              Nothing under it has moved — the branch below returned every
     *              time — so there is nothing to undo, only to replace.
     *   undecided  return. Neither gesture acts, which is what keeps a hold from
     *              nudging the layer a few pixels on its way to arming.
     *   abandoned  the press was a real drag after all. The other gesture keeps
     *              it, and the travel spent deciding is ABSORBED (`dragStart`
     *              moves to here) so it starts from where it is rather than
     *              leaping by the slop — the same rule `HeldDrag.delta` states.
     */
    if (g.pivotHold) {
      const hold = g.pivotHold;
      if (hold.update(e.clientX, e.clientY)) {
        hold.end();
        g.pivotHold = null;
        g.mode = "move-pivot";
        g.mergeKey = g.pivotMergeKey;
        g.snapCandidates = g.pivotSnap;
        g.moved = false;
      } else if (!hold.abandoned()) {
        return;
      } else {
        hold.end();
        g.pivotHold = null;
        g.dragStart = p;
      }
    }

    if (g.mode === "pan") {
      const dx = p.x - g.dragStart.x;
      const dy = p.y - g.dragStart.y;
      g.dragStart = p;
      if (dx || dy) spacePan.markDragged(); // a real pan → release is never a tap
      applyCamera({ scale: view.scale, tx: view.tx + dx, ty: view.ty + dy });
      return;
    }

    // ⌘+middle: scrub the zoom about the PRESS point (`dragStart` stays put —
    // it is the anchor, not a running position). Same clamped, leashed path as
    // every other zoom.
    if (g.mode === "zoom-drag") {
      const factor = dragZoomFactor(p.x - prev.x, p.y - prev.y);
      const next = clampViewScale(view.scale * factor);
      if (next !== view.scale) zoomAt(g.dragStart, next);
      return;
    }

    if (g.mode === "marquee") {
      g.marqueeEnd = p;
      dirtyRef.current = true;
      const r = normRect(g.marqueeStart, g.marqueeEnd);
      if (g.marqueeFrames) {
        // Frame marquee: pick every frame the rectangle touches (screen-space
        // box vs. each frame's screen rect).
        const frames = framesInView(store.getState(), useSession.getState());
        const hits = frames
          .filter((f) => {
            const fx = view.tx + f.x * view.scale;
            const fy = view.ty + f.y * view.scale;
            const fw = f.width * view.scale;
            const fh = f.height * view.scale;
            return r.x <= fx + fw && r.x + r.w >= fx && r.y <= fy + fh && r.y + r.h >= fy;
          })
          .map((f) => f.id);
        const merged = [...new Set([...g.marqueeBase, ...hits])];
        useSession.setState({ selectedFrameIds: merged, selectedClipIds: [] });
        return;
      }
      const docNow = store.getState();
      const hitsInside = hitRectsRef.current
        .filter((h) => h.depth === 0 && rotatedRectIntersectsScreenRect(h, r, view))
        .map((h) => h.clipId)
        .filter((id) => {
          const loc = locateClip(docNow, id);
          return loc && !isClipLocked(loc.track, loc.clip);
        });
      const merged = [...new Set([...g.marqueeBase, ...hitsInside])];
      useSession.setState({ selectedClipIds: merged, selectedFrameIds: [] });
      return;
    }

    if (g.mode === "draw-frame") {
      g.frameEnd = toWorld(p);
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "draw-shape") {
      const w = toWorld(p);
      g.shapeSquare = e.shiftKey;
      g.shapeFromCenter = e.altKey;
      // Snap the dragged corner to guides (⌘/Ctrl bypasses). Square/center still
      // draw from the (snapped) pointer, so the corner clicks onto alignments.
      if (g.snapCandidates && useSession.getState().guides && !(e.metaKey || e.ctrlKey)) {
        const threshold = useSession.getState().guideSettings.thresholdPx / view.scale;
        const s = snapPoint(w.x, w.y, g.snapCandidates, threshold);
        g.frameEnd = { x: s.x, y: s.y };
        activeGuidesRef.current = { v: s.v, h: s.h };
      } else {
        g.frameEnd = w;
        activeGuidesRef.current = { v: [], h: [] };
      }
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "draw-text") {
      g.frameEnd = toWorld(p);
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "radius-drag") {
      const locNow = locateClip(store.getState(), g.radiusClipId);
      if (!locNow) return;
      // Resolve the drag geometry + pose for a shape OR a box layer — the same
      // relative-drag math (inward distance vs its grab value) serves both.
      let geo: { shape: string; width: number; height: number };
      let pose: ShapePose;
      // For a polygon/star the ceiling is the incircle radius (shape → circle),
      // not half-min-side, so the drag stops exactly where the shape rounds out.
      let maxR: number;
      if (locNow.clip.kind === "shape") {
        const sp = shapePoseFor(locNow.clip);
        if (!sp) return;
        pose = sp;
        const sgeo = shapeGeoFor(locNow.clip);
        geo = sgeo;
        maxR = maxCornerRadiusForShape(sgeo);
      } else {
        const box = boxRadiusFor(locNow.clip);
        if (!box) return;
        pose = box.pose;
        geo = { shape: "rect", width: box.width, height: box.height };
        maxR = Math.min(geo.width, geo.height) / 2;
      }
      const inwardNow = cornerInward(geo, g.radiusCorner, worldToShapeLocal(toWorld(p), pose));
      const radius = Math.round(Math.max(0, Math.min(maxR, g.radiusStart + (inwardNow - g.radiusInward0))));

      // Figma's alt convention: while corners are uniform a drag moves ALL and
      // ⌥ isolates one; once corners differ a drag moves ONE and ⌥ moves all.
      const single = e.altKey !== g.radiusIndependent;
      const playhead = useSession.getState().playheadMs;
      const prefix = g.radiusIsBox ? "borderRadius" : "radius";
      store.update(
        "Corner radius",
        (d) => {
          const l = locateClip(d, g.radiusClipId);
          if (!l) return;
          const c = l.clip;
          // A non-rect shape rounds every vertex through the single `radius`.
          if (c.kind === "shape" && c.shape !== "rect") {
            writeAnimatable(c, "radius", radius, playhead, (cc) => {
              if (cc.kind === "shape") cc.radius = radius;
            });
            return;
          }
          const corners: Array<Exclude<RadiusCorner, "all">> =
            single && g.radiusCorner !== "all" ? [g.radiusCorner] : ["tl", "tr", "br", "bl"];
          for (const corner of corners) {
            writeAnimatable(c, `${prefix}.${corner}`, radius, playhead, (cc) => {
              if (cc.kind === "shape") cc.cornerRadius[corner] = radius;
              else if ("borderRadius" in cc) cc.borderRadius[corner] = radius;
            });
          }
        },
        { mergeKey: g.mergeKey },
      );
      return;
    }

    if (g.mode === "shape-handle") {
      const locNow = locateClip(store.getState(), g.shapeHandleClipId);
      if (locNow?.clip.kind !== "shape") return;
      const pose = shapePoseFor(locNow.clip);
      if (!pose) return;
      const param = ellipseParamAt(toWorld(p), shapeGeoFor(locNow.clip), pose);
      const kind = g.shapeHandleKind;
      const playhead = useSession.getState().playheadMs;
      const label =
        kind === "arc-sweep" ? "Arc sweep" : kind === "arc-start" ? "Arc start" : kind === "arc-ratio" ? "Arc ratio" : "Star inner";
      store.update(
        label,
        (d) => {
          const l = locateClip(d, g.shapeHandleClipId);
          if (l?.clip.kind !== "shape") return;
          const c = l.clip;
          if (kind === "arc-sweep") {
            // Angle swept from the (fixed) start to the pointer; snapping to 360
            // at the seam lets the ring close back to a full ellipse.
            let deg = (((param.deg - c.arcStartDeg) % 360) + 360) % 360;
            if (deg < 0.5) deg = 360;
            deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg);
            writeAnimatable(c, "arcSweepDeg", deg, playhead, (cc) => {
              if (cc.kind === "shape") cc.arcSweepDeg = deg;
            });
          } else if (kind === "arc-start") {
            let deg = (((param.deg % 360) + 360) % 360);
            deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg);
            writeAnimatable(c, "arcStartDeg", deg, playhead, (cc) => {
              if (cc.kind === "shape") cc.arcStartDeg = deg;
            });
          } else if (kind === "arc-ratio") {
            const r = Math.round(Math.min(0.99, Math.max(0, param.frac)) * 100) / 100;
            writeAnimatable(c, "arcRatio", r, playhead, (cc) => {
              if (cc.kind === "shape") cc.arcRatio = r;
            });
          } else {
            const r = Math.round(Math.min(1, Math.max(0.01, param.frac)) * 100) / 100;
            writeAnimatable(c, "innerRatio", r, playhead, (cc) => {
              if (cc.kind === "shape") cc.innerRatio = r;
            });
          }
        },
        { mergeKey: g.mergeKey },
      );
      return;
    }

    if (g.mode === "gradient-handle") {
      const grad = activeGradient();
      if (!grad) return;
      g.moved = true;
      const playhead = useSession.getState().playheadMs;
      const clipId = grad.hit.clipId;
      const prefix = g.gradientPrefix;
      const wp = toWorld(p);
      const kind = g.gradientKind;
      const writes: Array<[string, number]> = [];
      if (kind.kind === "start" || kind.kind === "end") {
        const nrm = worldToPaintNorm(wp, grad.hit);
        const clamp2 = (v: number) => Math.round(Math.min(2, Math.max(-1, v)) * 1000) / 1000;
        writes.push([`${prefix}.${kind.kind}.x`, clamp2(nrm.x)], [`${prefix}.${kind.kind}.y`, clamp2(nrm.y)]);
      } else if (kind.kind === "stop") {
        const t = Math.round(Math.min(1, Math.max(0, axisT(wp, grad.model.start, grad.model.end))) * 1000) / 1000;
        writes.push([`${prefix}.stop.${g.gradientStopId}.offset`, t]);
      }
      if (writes.length) {
        store.update(
          "Edit gradient",
          (d) => {
            const l = locateClip(d, clipId);
            if (!l) return;
            for (const [path, value] of writes) commitProperty(l.clip, path, value, playhead);
          },
          { mergeKey: g.mergeKey },
        );
      }
      return;
    }

    if (g.mode === "shape-corner") {
      const locNow = locateClip(store.getState(), g.shapeCornerClipId);
      if (locNow?.clip.kind !== "shape") return;
      const pose = shapePoseFor(locNow.clip);
      if (!pose) return;
      // ⇧ constrains the vertex to a snapped axis from its grab point; otherwise
      // it snaps to guides/siblings — the SAME rules as a layer drag, in world
      // space, then folded back into the shape's local basis.
      let w = toWorld(p);
      if (e.shiftKey) {
        const start = toWorld(g.dragStart);
        const c = constrainDragToAngle(w.x - start.x, w.y - start.y);
        w = { x: start.x + c.dx, y: start.y + c.dy };
        activeGuidesRef.current = { v: [], h: [] };
      } else if (g.snapCandidates && useSession.getState().guides && !(e.metaKey || e.ctrlKey)) {
        const threshold = useSession.getState().guideSettings.thresholdPx / view.scale;
        const s = snapPoint(w.x, w.y, g.snapCandidates, threshold);
        w = { x: s.x, y: s.y };
        activeGuidesRef.current = { v: s.v, h: s.h };
      } else {
        activeGuidesRef.current = { v: [], h: [] };
      }
      const local = worldToShapeLocal(w, pose);
      const i = g.shapeCornerIndex;
      const basis = shapeCornerBasis(shapeGeoFor(locNow.clip));
      if (i >= basis.length) return;
      // The nudge is the corner's displacement from its natural vertex. Written
      // through commitProperty so it records + interpolates like any number.
      const ox = Math.round(local.x - basis[i]!.x);
      const oy = Math.round(local.y - basis[i]!.y);
      const playhead = useSession.getState().playheadMs;
      store.update(
        "Edit corner",
        (d) => {
          const l = locateClip(d, g.shapeCornerClipId);
          if (l?.clip.kind !== "shape") return;
          commitProperty(l.clip, `corner.${i}.x`, ox, playhead);
          commitProperty(l.clip, `corner.${i}.y`, oy, playhead);
        },
        { mergeKey: g.mergeKey },
      );
      g.moved = true;
      return;
    }

    if (g.mode === "motion-anchor" || g.mode === "motion-handle" || g.mode === "motion-bend") {
      // Clicks (incl. the first half of a double-click) never edit the path —
      // only a real drag does. Same latch distance the pen uses, from the shared
      // kit, so neither surface can feel twitchier than the other.
      if (!g.motionMoved && !passedDragLatch(g.dragStart, p)) return;
      g.motionMoved = true;
    }
    if (g.mode === "motion-anchor") {
      const w = toWorld(p);
      let wx = w.x;
      let wy = w.y;
      if (g.snapCandidates && useSession.getState().guides && !(e.metaKey || e.ctrlKey)) {
        const threshold = useSession.getState().guideSettings.thresholdPx / view.scale;
        const s = snapPoint(wx, wy, g.snapCandidates, threshold);
        wx = s.x;
        wy = s.y;
        activeGuidesRef.current = { v: s.v, h: s.h };
      } else {
        activeGuidesRef.current = { v: [], h: [] };
      }
      const { x: lx, y: ly } = motionWorldToLocal(g.motionClipId, { x: wx, y: wy });
      store.update(
        "Move motion point",
        (d) => {
          const loc = locateClip(d, g.motionClipId);
          if (loc && loc.clip.kind !== "audio") setMotionAnchor(loc.clip, g.motionTimeMs, lx, ly);
        },
        { mergeKey: g.mergeKey },
      );
      dirtyRef.current = true;
      return;
    }
    if (g.mode === "motion-handle") {
      applyMotionHandle(readMods(e));
      return;
    }
    if (g.mode === "motion-bend" && g.motionSeg) {
      const w = toWorld(p);
      const seg = g.motionSeg;
      const dx = w.x - seg.start.x;
      const dy = w.y - seg.start.y;
      store.update(
        "Bend motion path",
        (d) => {
          const loc = locateClip(d, g.motionClipId);
          if (loc && loc.clip.kind !== "audio") bendMotionSegment(loc.clip, seg.a, seg.b, seg.u, dx, dy);
        },
        { mergeKey: g.mergeKey },
      );
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "guide-move") {
      const w = toWorld(p);
      const gf = guideOwner(store.getState(), g.guideMoveFrameId);
      if (!gf) return;
      let wx = w.x;
      let wy = w.y;
      if (g.snapCandidates && useSession.getState().guides) {
        const threshold = useSession.getState().guideSettings.thresholdPx / view.scale;
        const s = snapPoint(wx, wy, g.snapCandidates, threshold);
        wx = s.x;
        wy = s.y;
        activeGuidesRef.current = { v: g.guideMoveAxis === "x" ? s.v : [], h: g.guideMoveAxis === "y" ? s.h : [] };
      } else {
        activeGuidesRef.current = { v: [], h: [] };
      }
      // Drop onto the ruler strip, or drag the guide off the artboard → delete.
      const onRuler = useSession.getState().rulers && (g.guideMoveAxis === "x" ? p.x < RULER_SIZE : p.y < RULER_SIZE);
      const pos = g.guideMoveAxis === "x" ? wx - gf.ox : wy - gf.oy;
      // A FRAME guide dragged off its artboard is deleted; a page guide has no edge.
      const span = g.guideMoveAxis === "x" ? gf.hi.x - gf.lo.x : gf.hi.y - gf.lo.y;
      const outside = gf.kind === "frame" && (pos < -2 || pos > span + 2);
      g.guideDeletePending = onRuler || outside;
      if (!g.guideDeletePending) {
        store.update(
          "Move guide",
          (d) => {
            const gd = findGuide(d, g.guideMoveFrameId, g.guideMoveId);
            if (gd) gd.pos = Math.round(pos);
          },
          { mergeKey: g.mergeKey },
        );
      }
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "resize-frame") {
      const dx = (p.x - g.dragStart.x) / view.scale;
      const dy = (p.y - g.dragStart.y) / view.scale;
      const r = g.frameStartRect;
      const h = g.frameHandle;
      let x0 = r.x;
      let y0 = r.y;
      let x1 = r.x + r.w;
      let y1 = r.y + r.h;
      if (h.includes("w")) x0 = r.x + dx;
      if (h.includes("e")) x1 = r.x + r.w + dx;
      if (h.includes("n")) y0 = r.y + dy;
      if (h.includes("s")) y1 = r.y + r.h + dy;

      // ⌘/Ctrl = scale contents (uniform by definition); ⇧ = keep aspect.
      const scaleContents = e.metaKey || e.ctrlKey;
      const keepAspect = scaleContents || e.shiftKey;
      if (keepAspect && r.w > 0 && r.h > 0) {
        const ratio = r.h / r.w;
        const isEdgeV = h === "n" || h === "s";
        if (isEdgeV) {
          const hh = Math.max(16, y1 - y0);
          const ww = hh / ratio;
          const cx = r.x + r.w / 2;
          x0 = cx - ww / 2;
          x1 = cx + ww / 2;
        } else {
          const ww = Math.max(16, x1 - x0);
          const hh = ww * ratio;
          if (h.includes("n")) y0 = y1 - hh;
          else y1 = y0 + hh;
          if (h === "e" || h === "w") {
            const cy = r.y + r.h / 2;
            y0 = cy - hh / 2;
            y1 = cy + hh / 2;
          }
        }
      }

      const w = Math.max(16, Math.round(x1 - x0));
      const hgt = Math.max(16, Math.round(y1 - y0));
      store.update(
        scaleContents ? "Scale frame" : "Resize frame",
        (d) => {
          const f = d.frames.find((x) => x.id === g.frameDragId);
          if (!f) return;
          resizeFrame(d, g.frameDragId, w, hgt, { scaleContents });
          f.x = Math.round(x0);
          f.y = Math.round(y0);
        },
        { mergeKey: g.mergeKey },
      );
      return;
    }

    if (g.mode === "drag-frame") {
      const dx = (p.x - g.dragStart.x) / view.scale;
      const dy = (p.y - g.dragStart.y) / view.scale;
      const drags = g.frameDrags.length ? g.frameDrags : [{ id: g.frameDragId, ox: g.frameOrigin.x, oy: g.frameOrigin.y }];
      store.update(
        drags.length > 1 ? "Move frames" : "Move frame",
        (d) => {
          for (const fd of drags) {
            const f = d.frames.find((x) => x.id === fd.id);
            if (f) {
              f.x = Math.round(fd.ox + dx);
              f.y = Math.round(fd.oy + dy);
            }
          }
        },
        { mergeKey: g.mergeKey },
      );
      return;
    }

    // ⌘/Ctrl + edge is deferred until the drag reveals intent: project the travel
    // onto the box's own axes and compare the component ALONG the grabbed edge
    // (shear) against the one ACROSS it (scale). Whichever the pointer commits to
    // first wins, then we hand off to that gesture's handler in the SAME frame.
    if (g.mode === "transform-edge") {
      const w = toWorld(p);
      const dx = w.x - g.skewStartWorld.x;
      const dy = w.y - g.skewStartWorld.y;
      const rad = (-g.skewRot * Math.PI) / 180;
      const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
      const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
      // Edge line runs along local X for top/bottom (skewAxis "x"), local Y for sides.
      const along = g.skewAxis === "x" ? localX : localY;
      const across = g.skewAxis === "x" ? localY : localX;
      if (Math.hypot(localX, localY) * view.scale < 4) return; // await a decisive move
      g.mode = Math.abs(along) >= Math.abs(across) ? "skew" : "resize";
      // fall through: the resolved handler below runs this same move.
    }

    if (g.mode === "resize") {
      let wWorld = toWorld(p);
      // Smart guides: snap the grabbed corner to the surrounding layers/page —
      // only for an unrotated box (world axes = box axes) and only on the axes
      // this handle actually moves (an edge pins one). Rotated boxes skip it so
      // the guide can't fight the box's own tilted axes.
      if (g.snapCandidates && g.resizeRot === 0 && useSession.getState().guides) {
        const threshold = useSession.getState().guideSettings.thresholdPx / view.scale;
        const s = snapPoint(wWorld.x, wWorld.y, g.snapCandidates, threshold);
        const freeX = g.resizeCornerSx !== 0;
        const freeY = g.resizeCornerSy !== 0;
        wWorld = { x: freeX ? s.x : wWorld.x, y: freeY ? s.y : wWorld.y };
        activeGuidesRef.current = { v: freeX ? s.v : [], h: freeY ? s.h : [] };
      } else {
        activeGuidesRef.current = { v: [], h: [] };
      }
      // Snapping done in world (that is where the guides are); from here on the
      // entire resize lives in the ONE space captured at the press.
      const w = resizeToLayerSpace(g, wWorld);

      // Figma resize: the corner OPPOSITE the grabbed one stays pinned, so the
      // box grows toward the pointer. ⌥/Alt anchors the CENTER instead (grows
      // symmetrically). Everything works in the box's OWN (rotated) axes, and
      // the whole arithmetic — including MIRRORING when the drag crosses its own
      // anchor — lives in core `resize.ts`; this block only decides WHICH value
      // each mode grows (scale, shape geometry, text wrap) and writes it.
      const centerAnchor = e.altKey;
      const box: ResizeBox = {
        cx: g.resizeCx,
        cy: g.resizeCy,
        rotation: g.resizeRot,
        halfW: g.resizeStartHalfBoxW,
        halfH: g.resizeStartHalfBoxH,
        sx: g.resizeCornerSx as HandleSign,
        sy: g.resizeCornerSy as HandleSign,
        // ⌥ resizes about the PIVOT — the box centre unless the user moved it.
        pivot: g.resizePivot,
      };
      // Aspect ratio default depends on WHAT is being resized, and ⇧ always
      // INVERTS that default. Native geometry (shape/text/pen — dashed handles,
      // `resizeNativeKind !== null`) is FREE by default: a rectangle should
      // stretch to any proportion. A true transform SCALE (`resizeNativeKind ===
      // null` — image/video/nested/group, or any layer under ⌘) is LOCKED by
      // default so pixels never distort. Both defaults are user-configurable
      // (Settings → Editing). Aspect lock couples the two MAGNITUDES only, so a
      // diagonal drag past one edge still mirrors that one axis.
      const sess = useSession.getState();
      const lockAspectDefault =
        g.resizeNativeKind !== null ? sess.nativeResizeLockAspect : sess.scaleLockAspect;
      const overrideAspectLock = sess.scaleLockAspectOverride;
      const lockAspect = overrideAspectLock !== null ? overrideAspectLock : lockAspectDefault;
      const keepAspect = lockAspect !== e.shiftKey;
      const f = solveResizeFactors(box, w, { centerAnchor, keepAspect, allowMirror: true });
      const playhead = useSession.getState().playheadMs;

      // Text box: the horizontal factor drives the wrap width (breaks words),
      // the vertical factor the box height — never scale — with the opposite
      // edge/corner pinned. The horizontal factor sets the wrap width (grows
      // auto-height — text never clips). A height drag only resizes a box that
      // is ALREADY Fixed-size; an auto box never gains a fixed height by
      // dragging (Fixed/clip is opt-in via the Sizing panel). Side edges touch
      // one axis; a corner touches both. Crossing the anchor MIRRORS the layer
      // (the wrap width stays a positive magnitude — a negative line-break width
      // means nothing — and the flip rides the transform, exactly like a shape).
      if (g.resizeNativeKind === "text") {
        const horiz = box.sx !== 0;
        // Height only participates for an already-Fixed box.
        const vert = box.sy !== 0 && g.resizeTextFixed;
        const nextWidth = Math.round(Math.min(8000, Math.max(50, g.resizeStartWidth * Math.abs(f.fx))));
        const nextHeight = Math.round(Math.min(8000, Math.max(24, g.resizeStartHeight * Math.abs(f.fy))));
        const rx = horiz ? realizedFactor(nextWidth, g.resizeStartWidth, f.fx) : 1;
        const ry = vert ? realizedFactor(nextHeight, g.resizeStartHeight, f.fy) : 1;
        const c = resizeCenter(box, { fx: rx, fy: ry }, centerAnchor);
        const mirror = takeMirror(g, box, f);
        const pos = resizePosition(
          resizeStartPose(g),
          {
            scale: mirror?.scale ?? g.resizeStartScale,
            scaleY: mirror?.scaleY ?? g.resizeStartScaleY,
            size: { width: horiz ? nextWidth : g.resizeStartWidth, height: vert ? nextHeight : g.resizeStartHeight, cx: 0, cy: 0 },
          },
          { x: c.x - g.resizeCx, y: c.y - g.resizeCy },
        );
        const nx = Math.round(pos.x);
        const ny = Math.round(pos.y);
        store.update(
          "Resize text box",
          (d) => {
            const loc = locateClip(d, g.resizeClipId);
            if (loc && loc.clip.kind === "text") {
              // Sized by hand inside a layout, the dragged axis is FIXED now —
              // a fill would ignore the number you just drew.
              releaseFill(loc.clip, horiz, vert);
              // Through the SAME animatable seam the inspector field uses: with
              // the box keyed (or record armed) dragging its edge writes a
              // keyframe, so the gesture and the number can't disagree about
              // where the value went.
              if (horiz) {
                writeAnimatable(loc.clip, "maxWidth", nextWidth, playhead, (c2) => {
                  if (c2.kind === "text") c2.maxWidth = nextWidth;
                });
              }
              // Only an already-Fixed box tracks a dragged height.
              if (vert) {
                writeAnimatable(loc.clip, "maxHeight", nextHeight, playhead, (c2) => {
                  if (c2.kind === "text") c2.maxHeight = nextHeight;
                });
              }
              if (mirror) writeMirror(loc.clip, mirror, playhead);
              writeAnimatable(loc.clip, "x", nx, playhead, (c2) => {
                if (c2.kind !== "audio") c2.transform.x = nx;
              });
              writeAnimatable(loc.clip, "y", ny, playhead, (c2) => {
                if (c2.kind !== "audio") c2.transform.y = ny;
              });
            }
          },
          { mergeKey: g.mergeKey },
        );
        return;
      }

      // Shape: the drag edits the shape's OWN width/height at a fixed transform,
      // so corner radii, strokes and vertices keep their true pixel size instead
      // of stretching. The anchor corner stays pinned exactly like a scale, but
      // the box grows because the geometry grows — not because scale changes.
      // Dragging PAST the anchor doesn't stall at the 1px floor: the geometry
      // grows back out while the mirror goes onto the transform's scale sign, so
      // the radii and strokes stay true through the flip.
      if (g.resizeNativeKind === "shape") {
        const clampD = (v: number) => Math.round(Math.min(20000, Math.max(1, v)));
        const nextWidth = clampD(g.resizeStartWidth * Math.abs(f.fx));
        const nextHeight = clampD(g.resizeStartHeight * Math.abs(f.fy));
        const rx = realizedFactor(nextWidth, g.resizeStartWidth, f.fx);
        const ry = realizedFactor(nextHeight, g.resizeStartHeight, f.fy);
        const c = resizeCenter(box, { fx: rx, fy: ry }, centerAnchor);
        const mirror = takeMirror(g, box, f);
        const pos = resizePosition(
          resizeStartPose(g),
          {
            scale: mirror?.scale ?? g.resizeStartScale,
            scaleY: mirror?.scaleY ?? g.resizeStartScaleY,
            size: { width: nextWidth, height: nextHeight, cx: 0, cy: 0 },
          },
          { x: c.x - g.resizeCx, y: c.y - g.resizeCy },
        );
        const nx = Math.round(pos.x);
        const ny = Math.round(pos.y);
        store.update(
          "Resize shape",
          (d) => {
            const loc = locateClip(d, g.resizeClipId);
            if (loc && loc.clip.kind === "shape") {
              releaseFill(loc.clip, box.sx !== 0, box.sy !== 0);
              writeAnimatable(loc.clip, "width", nextWidth, playhead, (c2) => {
                if (c2.kind === "shape") c2.width = nextWidth;
              });
              writeAnimatable(loc.clip, "height", nextHeight, playhead, (c2) => {
                if (c2.kind === "shape") c2.height = nextHeight;
              });
              if (mirror) writeMirror(loc.clip, mirror, playhead);
              writeAnimatable(loc.clip, "x", nx, playhead, (c2) => {
                if (c2.kind !== "audio") c2.transform.x = nx;
              });
              writeAnimatable(loc.clip, "y", ny, playhead, (c2) => {
                if (c2.kind !== "audio") c2.transform.y = ny;
              });
            }
          },
          { mergeKey: g.mergeKey },
        );
        return;
      }

      // Auto layout: the drag sets the container's WIDTH / HEIGHT (fixing a
      // hugging axis), and the box's centre moves so the anchored edge stays.
      // The members follow because they are derived from the box.
      if (g.resizeNativeKind === "layout") {
        const clampD = (v: number) => Math.round(Math.min(20000, Math.max(1, v)));
        const horiz = box.sx !== 0;
        const vert = box.sy !== 0;
        const nextWidth = clampD(g.resizeStartWidth * Math.abs(f.fx));
        const nextHeight = clampD(g.resizeStartHeight * Math.abs(f.fy));
        const rx = horiz ? realizedFactor(nextWidth, g.resizeStartWidth, f.fx) : 1;
        const ry = vert ? realizedFactor(nextHeight, g.resizeStartHeight, f.fy) : 1;
        const c = resizeCenter(box, { fx: rx, fy: ry }, centerAnchor);
        const dx = c.x - g.resizeCx;
        const dy = c.y - g.resizeCy;
        store.update(
          "Resize auto layout",
          (d) => {
            const loc = locateClip(d, g.resizeClipId);
            if (!loc || loc.clip.kind !== "group" || !loc.clip.layout) return;
            const group = loc.clip;
            // Leaving HUG goes through the one sizing op, so what was hugging
            // inside (a button's label) starts following the box you're sizing.
            if (horiz && group.layout?.width === null) setBoxSizing(d, group.id, "x", "fixed");
            if (vert && group.layout?.height === null) setBoxSizing(d, group.id, "y", "fixed");
            if (horiz) {
              writeAnimatable(group, "layout.width", nextWidth, playhead, (c2) => {
                if (c2.kind === "group" && c2.layout) c2.layout.width = nextWidth;
              });
            }
            if (vert) {
              writeAnimatable(group, "layout.height", nextHeight, playhead, (c2) => {
                if (c2.kind === "group" && c2.layout) c2.layout.height = nextHeight;
              });
            }
            // The box is placed by its top-left, in the group's own delta space;
            // for the identity delta every container starts with, that is comp
            // space. The centre moved by (dx, dy) and the size changed, so the
            // corner is the new centre less half the new size.
            const nx = Math.round(horiz ? g.layoutStartCentre.x + dx - nextWidth / 2 : g.layoutStartCorner.x);
            const ny = Math.round(vert ? g.layoutStartCentre.y + dy - nextHeight / 2 : g.layoutStartCorner.y);
            writeAnimatable(group, "layout.x", nx, playhead, (c2) => {
              if (c2.kind === "group" && c2.layout) c2.layout.x = nx;
            });
            writeAnimatable(group, "layout.y", ny, playhead, (c2) => {
              if (c2.kind === "group" && c2.layout) c2.layout.y = ny;
            });
          },
          { mergeKey: g.mergeKey },
        );
        return;
      }

      const clampS = (s2: number) => Math.round(clampScale(s2, 0.02) * 1000) / 1000;
      // Keep the layer uniform (scaleY = null → mirrors scale) as long as the
      // aspect stays locked, it was uniform to begin with, AND both axes end up
      // with the same sign — a one-axis mirror is exactly the case `scaleY: null`
      // cannot express (it would read as a 180° rotation), so it must break the
      // link. With AR locked (default), even an edge stays uniform because both
      // axes scale by the same factor; ⇧ (free) breaks the mirror with an
      // explicit Y.
      const keepUniform =
        keepAspect && g.resizeScaleYWasNull && resizeSign(f.fx) === resizeSign(f.fy);
      const nextScale = clampS(g.resizeStartScale * f.fx);
      const nextScaleY = keepUniform ? nextScale : clampS(g.resizeStartScaleY * f.fy);
      // Shift x/y so the anchor stays pinned, using the ACTUAL (clamped) factors.
      const c = resizeCenter(
        box,
        {
          fx: realizedFactor(nextScale, g.resizeStartScale, f.fx),
          fy: realizedFactor(nextScaleY, g.resizeStartScaleY, f.fy),
        },
        centerAnchor,
      );
      // The box itself is unchanged — a scale resize moves nothing inside the
      // layer — so the only correction left is the pivot→centre offset riding
      // the new scale.
      const pos = resizePosition(
        resizeStartPose(g),
        { scale: nextScale, scaleY: nextScaleY, size: g.resizeStartSize },
        { x: c.x - g.resizeCx, y: c.y - g.resizeCy },
      );
      /*
       * ONE FORMULA, BOTH PLACEMENT MODELS — and the reason there is no `if
       * (isGroup)` here any more is worth stating, because the branch that used
       * to be here is what made a group drift.
       *
       * A leaf's box centre sits at `position + L(boxCentre − pivot)`; a group's
       * sits at `position + pivot + L(boxCentre − pivot)`, because a group's
       * `x/y` is a DELTA about its pivot rather than the pivot itself. Those are
       * genuinely two placements — but a RESIZE never moves the pivot, so the
       * extra `pivot` term is the SAME before and after and cancels out of the
       * difference. What is left is identical for both:
       *
       *     Δposition = Δ(box centre) − Δ( L(boxCentre − pivot) )
       *
       * `resizeCenter` is the first term (where the box has to sit for the
       * grabbed handle's opposite corner — or the pivot, under ⌥ — to stay
       * pinned); `pivotDrift` is the second. A second formula written at this
       * call site for groups was not a different fact, it was the same fact
       * derived twice — and the copy had its correction applied in a space it
       * had already left, so the group crept by that error on every pointer
       * move. Deriving it once is what makes that class of bug unwriteable.
       */
      const nx = Math.round(pos.x);
      const ny = Math.round(pos.y);
      store.update(
        "Resize layer",
        (d) => {
          const loc = locateClip(d, g.resizeClipId);
          if (loc && loc.clip.kind !== "audio") {
            writeAnimatable(loc.clip, "scale", nextScale, playhead, (c2) => {
              if (c2.kind !== "audio") c2.transform.scale = nextScale;
            });
            if (keepUniform) {
              loc.clip.transform.scaleY = null;
            } else {
              writeAnimatable(loc.clip, "scaleY", nextScaleY, playhead, (c2) => {
                if (c2.kind !== "audio") c2.transform.scaleY = nextScaleY;
              });
            }
            writeAnimatable(loc.clip, "x", nx, playhead, (c2) => {
              if (c2.kind !== "audio") c2.transform.x = nx;
            });
            writeAnimatable(loc.clip, "y", ny, playhead, (c2) => {
              if (c2.kind !== "audio") c2.transform.y = ny;
            });
          }
        },
        { mergeKey: g.mergeKey },
      );
      return;
    }

    if (g.mode === "skew") {
      const w = toWorld(p);
      const dx = w.x - g.skewStartWorld.x;
      const dy = w.y - g.skewStartWorld.y;
      // Deskew the pointer travel into the box's own (rotated) axes, then map the
      // grabbed edge's displacement to a shear tangent so the edge tracks the
      // pointer 1:1 (change in edge offset = Δtan · extent = travel).
      const rad = (-g.skewRot * Math.PI) / 180;
      const travel =
        g.skewAxis === "x" ? dx * Math.cos(rad) - dy * Math.sin(rad) : dx * Math.sin(rad) + dy * Math.cos(rad);
      let deg = (Math.atan(g.skewStartTan + travel / g.skewDenom) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15; // ⇧ snaps to tidy 15° steps
      deg = Math.max(-85, Math.min(85, deg));
      const path = g.skewAxis === "x" ? "skewX" : "skewY";
      const playhead = useSession.getState().playheadMs;
      store.update(
        "Skew layer",
        (d) => {
          const loc = locateClip(d, g.skewClipId);
          if (loc && loc.clip.kind !== "audio") commitProperty(loc.clip, path, deg, playhead);
        },
        { mergeKey: g.mergeKey },
      );
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "resize-group") {
      const w = toWorld(p);
      // A group resize scales its members about the group CENTER — same family
      // as a layer SCALE, so it follows `scaleLockAspect` (locked by default),
      // ⇧ inverts it, and it runs through the SAME core solver as every other
      // resize. Dragging a corner through the center mirrors the whole
      // arrangement: the signed factor flips each member's scale AND reflects
      // its position across the center, so the layout folds over as one.
      const keepAspect = useSession.getState().scaleLockAspect !== e.shiftKey;
      const { fx, fy } = solveResizeFactors(
        { cx: g.groupCx, cy: g.groupCy, rotation: 0, halfW: g.groupHw, halfH: g.groupHh, sx: g.groupSx, sy: g.groupSy },
        w,
        { centerAnchor: true, keepAspect, allowMirror: true },
      );
      const clampS = (s2: number) => Math.round(clampScale(s2, 0.02) * 1000) / 1000;
      const playhead = useSession.getState().playheadMs;
      store.update(
        "Resize layers",
        (d) => {
          for (const gc of g.groupClips) {
            const loc = locateClip(d, gc.id);
            if (!loc || loc.clip.kind === "audio") continue;
            const nScale = clampS(gc.s0 * fx);
            const nScaleY = clampS(gc.sy0 * fy);
            // Scale each layer's world anchor about the group center, then map
            // the MOVEMENT back into the frame's own coordinates (identity at the
            // root, the inverse hop chain inside a nested edit).
            const wx = g.groupCx + (gc.fcx + gc.x0 - g.groupCx) * fx - gc.fcx;
            const wy = g.groupCy + (gc.fcy + gc.y0 - g.groupCy) * fy - gc.fcy;
            const gm = toLocalDelta(wx - gc.x0, wy - gc.y0);
            const nx = Math.round(gc.x0 + gm.x);
            const ny = Math.round(gc.y0 + gm.y);
            // A one-axis mirror can't be expressed by `scaleY: null` (it would
            // read as a 180° rotation), so equal signs are part of staying uniform.
            const keepUniform = keepAspect && gc.syNull && resizeSign(fx) === resizeSign(fy);
            writeAnimatable(loc.clip, "scale", nScale, playhead, (c) => {
              if (c.kind !== "audio") c.transform.scale = nScale;
            });
            if (keepUniform) {
              loc.clip.transform.scaleY = null;
            } else {
              writeAnimatable(loc.clip, "scaleY", nScaleY, playhead, (c) => {
                if (c.kind !== "audio") c.transform.scaleY = nScaleY;
              });
            }
            writeAnimatable(loc.clip, "x", nx, playhead, (c) => {
              if (c.kind !== "audio") c.transform.x = nx;
            });
            writeAnimatable(loc.clip, "y", ny, playhead, (c) => {
              if (c.kind !== "audio") c.transform.y = ny;
            });
          }
        },
        { mergeKey: g.mergeKey },
      );
      g.moved = true;
      return;
    }

    if (g.mode === "move-pivot") {
      const pose = g.pivotStartPose;
      if (!pose) return;
      let w = toWorld(p);
      // Snap the pivot to the surrounding layout like any other point, so it
      // lands cleanly on an edge, a centre or a neighbour's guide.
      if (g.snapCandidates && useSession.getState().guides) {
        // Stickier than a normal drag (×1.6): a pivot is a single point people
        // place deliberately, and "nearly on the corner" is never what they meant.
        // Still fully off when canvas snapping is off — one toggle, no exceptions.
        const threshold = (useSession.getState().guideSettings.thresholdPx * 1.6) / view.scale;
        const snapped = snapPoint(w.x, w.y, g.snapCandidates, threshold);
        w = { x: snapped.x, y: snapped.y };
        activeGuidesRef.current = { v: snapped.v, h: snapped.h };
      } else {
        activeGuidesRef.current = { v: [], h: [] };
      }
      // Pointer → the layer's own local units, in two documented steps: undo the
      // NESTING (world → this frame's coordinates), then undo the layer's own
      // rotate → shear → scale. Measured from where the pivot is actually
      // PAINTED, so it works identically at any drill depth. The pivot is
      // deliberately UNCLAMPED — placing it outside the layer (an orbit centre
      // off to one side) is a thing people want, and the whole reason this is a
      // mode rather than a nudge.
      // Pointer travel, brought all the way back into the space this layer's
      // transform is written in — THREE undos, and the middle one was missing.
      //  1. `toLocalDelta` undoes the COMP chain (nested comps, drill hops).
      //  2. the GROUP chain, below: a layer inside a scaled or rotated group is
      //     PAINTED through that delta, so a pointer that travels 100px on
      //     screen has moved fewer (or more) of the layer's own units. Without
      //     this the pivot ran away from the pointer inside any transformed
      //     group, which is the "children's pivot is jumpy".
      //  3. `toPivotSpace` undoes the layer's OWN rotate → shear → scale.
      const compLocal = toLocalDelta(w.x - g.pivotStartWorld.x, w.y - g.pivotStartWorld.y);
      const world = g.pivotChainInverse
        ? applyLinear(g.pivotChainInverse, compLocal)
        : compLocal;
      /*
       * ONE PIVOT MODEL, whatever this layer is (core `pivotModel`).
       *
       * Two things differ between a leaf and a group and both used to be
       * written here in the leaf's terms. The pointer delta has to reach the
       * space the pivot is WRITTEN in — a leaf's own local space, back through
       * rotate/shear/scale; a group's pivot already lives in the comp, so the
       * delta arrives as-is. And the counter-move that holds the art still is
       * "the position travels with the pivot" for a leaf but "only the part the
       * linear map does not absorb" for a group, which for an unrotated,
       * unscaled group is NOTHING.
       *
       * Running the leaf formulas on a group is why grabbing a group's
       * crosshair threw the whole group across the canvas. The model answers
       * both, so there is nothing to branch on here.
       */
      const model = g.pivotModel;
      if (!model) return;
      const u = model.toPivotSpace(world);
      // Offset from the OLD pivot, in pivot-space units → the new normalized pivot.
      const lx = u.x + model.local.x;
      const ly = u.y + model.local.y;
      const nextAnchor = {
        x: Math.round(((lx - model.box.cx) / Math.max(1, model.box.width) + 0.5) * 1000) / 1000,
        y: Math.round(((ly - model.box.cy) / Math.max(1, model.box.height) + 0.5) * 1000) / 1000,
      };
      // NOT rounded. `shift` is the exact counter-move that holds the art still
      // while the pivot travels, and it is exact against the anchor as STORED
      // (3dp, computed just above). Rounding the position to whole pixels after
      // the fact throws away up to half a pixel of that correction — so the
      // layer stepped and re-settled as you dragged, which is that "it moves
      // about a pixel, then corrects itself". A layer position is a float
      // everywhere else in the app; the one gesture whose whole promise is
      // "nothing moves" is the last place to quantize it.
      const playhead = useSession.getState().playheadMs;
      store.update(
        "Move pivot",
        (d) => {
          const loc = locateClip(d, g.pivotClipId);
          if (!loc || loc.clip.kind === "audio") return;
          // ONE headless op (`repivotClip`). It moves the base position AND
          // every x/y KEY by that key's own correction — a layer with a motion
          // path used to keep the correction in its base value alone, so the
          // art held still at the playhead and the whole path changed shape.
          // It is also the only thing that knows a group's position is a delta.
          // `g.pivotSize` was measured at the press and a pivot move never
          // changes a box — so the group's member walk happens once per gesture
          // instead of once per keyframe per pointer move.
          repivotClip(
            d,
            loc.clip,
            nextAnchor,
            (ms) => clipPose(loc.clip, ms),
            clipLocalClamped(loc.clip, playhead),
            g.pivotSize,
          );
        },
        { mergeKey: g.mergeKey },
      );
      g.moved = true;
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "crop") {
      const dw = toWorld(p);
      const rad = (g.cropRot * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const ddx = dw.x - g.cropStartWorld.x;
      const ddy = dw.y - g.cropStartWorld.y;
      // Pointer travel projected onto the box's OWN axes (world), then into
      // box-local px (undo the pose scale) — a rotated media crops true to its
      // own edges.
      const dPxX = (ddx * cos + ddy * sin) / Math.max(0.001, g.cropScaleX);
      const dPxY = (-ddx * sin + ddy * cos) / Math.max(0.001, g.cropScaleY);
      const s = g.cropStart;
      const side = g.cropSide;
      const ins = g.cropInsets;
      // Work in VISUAL sides (the edges the user sees and grabbed), then write
      // through the mirror map — so a flipped layer crops the edge under the
      // pointer instead of the opposite one.
      let n = s[ins.n];
      let sIn = s[ins.s];
      let w2 = s[ins.w];
      let e2 = s[ins.e];
      if (side.includes("w")) w2 = s[ins.w] + dPxX;
      if (side.includes("e")) e2 = s[ins.e] - dPxX;
      if (side.includes("n")) n = s[ins.n] + dPxY;
      if (side.includes("s")) sIn = s[ins.s] - dPxY;
      // Snap each edge to the media's TRUE edge (inset 0 = full size) when close —
      // the "snap to full size of the media" the crop wants, gated by the same
      // guide toggle as everything else on stage.
      if (useSession.getState().guides) {
        const thr = useSession.getState().guideSettings.thresholdPx / Math.max(0.001, view.scale);
        if (side.includes("w") && w2 * g.cropScaleX < thr) w2 = 0;
        if (side.includes("e") && e2 * g.cropScaleX < thr) e2 = 0;
        if (side.includes("n") && n * g.cropScaleY < thr) n = 0;
        if (side.includes("s") && sIn * g.cropScaleY < thr) sIn = 0;
      }
      const clamp = (v: number, hi: number) => Math.max(0, Math.min(v, Math.max(0, hi)));
      w2 = clamp(w2, g.cropNatW - e2 - 4);
      e2 = clamp(e2, g.cropNatW - w2 - 4);
      n = clamp(n, g.cropNatH - sIn - 4);
      sIn = clamp(sIn, g.cropNatH - n - 4);
      const playhead = useSession.getState().playheadMs;
      store.update(
        "Crop",
        (d) => {
          const loc = locateClip(d, g.cropClipId);
          if (!loc || loc.clip.kind === "audio") return;
          if (side.includes("n")) commitProperty(loc.clip, `crop.${ins.n}`, Math.round(n), playhead);
          if (side.includes("s")) commitProperty(loc.clip, `crop.${ins.s}`, Math.round(sIn), playhead);
          if (side.includes("w")) commitProperty(loc.clip, `crop.${ins.w}`, Math.round(w2), playhead);
          if (side.includes("e")) commitProperty(loc.clip, `crop.${ins.e}`, Math.round(e2), playhead);
        },
        { mergeKey: g.mergeKey },
      );
      g.moved = true;
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "crop-rotate") {
      // THE SAME recognizer the layer's own rotate band uses, pointed at the
      // picture instead of the box: identical winding, identical ⇧ snap,
      // identical dial. Turning the footage inside a crop is not a different
      // gesture — it is the gesture with a different subject.
      if (!g.rotateTracker) return;
      const next = g.rotateTracker.angleAt(p, e.shiftKey);
      g.rotateSnapping = e.shiftKey;
      const playhead = useSession.getState().playheadMs;
      store.update(
        "Turn image in crop",
        (d) => {
          const loc = locateClip(d, g.cropClipId);
          if (!loc || loc.clip.kind === "audio") return;
          commitProperty(loc.clip, "content.rotation", Math.round(next * 10) / 10, playhead);
        },
        { mergeKey: g.mergeKey },
      );
      g.moved = true;
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "crop-pan" || g.mode === "crop-content" || g.mode === "crop-zoom") {
      applyCropReframe(readMods(e));
      return;
    }

    if (g.mode === "rotate") {
      // The SHARED recognizer (`beginRotate`): infinite winding and ⇧-snap of
      // the resulting ANGLE — the whole group turns by that same clean
      // increment, so relative angles inside it hold.
      if (!g.rotateTracker) return;
      g.rotateTracker.angleAt(toWorld(p), e.shiftKey);
      const delta = g.rotateTracker.delta();
      g.rotateSnapping = e.shiftKey;
      g.rotateAppliedDelta = delta;
      // The handle turned, so the cursor on it turns by the same amount.
      if (containerRef.current) containerRef.current.style.cursor = rotateCursor(g.rotateBearing + delta);
      const playhead = useSession.getState().playheadMs;
      const rad = (delta * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      store.update(
        g.rotateClips.length > 1 ? "Rotate layers" : "Rotate layer",
        (d) => {
          for (const rc of g.rotateClips) {
            const loc = locateClip(d, rc.id);
            if (!loc || loc.clip.kind === "audio") continue;
            const nextRot = Math.round((rc.rot0 + delta) * 10) / 10;
            writeAnimatable(loc.clip, "rotation", nextRot, playhead, (c) => {
              if (c.kind !== "audio") c.transform.rotation = nextRot;
            });
            // A group also ORBITS each layer about the pivot so the selection
            // turns as one rigid body; a single layer (dx=dy=0) spins in place.
            if (rc.dx !== 0 || rc.dy !== 0) {
              // The orbit is computed in WORLD (that is where the group box is);
              // the position it writes is frame-local.
              const om = toLocalDelta(
                rc.dx * cos - rc.dy * sin - rc.dx,
                rc.dx * sin + rc.dy * cos - rc.dy,
              );
              const nx = Math.round(rc.x0 + om.x);
              const ny = Math.round(rc.y0 + om.y);
              writeAnimatable(loc.clip, "x", nx, playhead, (c) => {
                if (c.kind !== "audio") c.transform.x = nx;
              });
              writeAnimatable(loc.clip, "y", ny, playhead, (c) => {
                if (c.kind !== "audio") c.transform.y = ny;
              });
            }
          }
        },
        { mergeKey: g.mergeKey },
      );
      g.moved = true;
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "layout-handle" && g.layoutHandle) {
      const geo = layoutGeometry(g.layoutGroupId);
      if (!geo) return;
      const h = g.layoutHandle;
      // The drag in the container's own units, along the handle's axis.
      const a = geo.space.fromWorld(g.layoutHandleStartWorld);
      const b = geo.space.fromWorld(toWorld(p));
      const delta = (h.axis === "x" ? b.x - a.x : b.y - a.y) * h.sign;
      const next = Math.max(0, Math.round(g.layoutHandleStart + delta));
      const path = h.kind === "gap" ? "layout.gap" : h.kind === "lineGap" ? "layout.lineGap" : `layout.padding.${h.side}`;
      const playhead = useSession.getState().playheadMs;
      store.update(
        h.kind === "padding" ? "Change padding" : "Change gap",
        (d) => {
          const l = locateClip(d, g.layoutGroupId);
          if (!l || l.clip.kind !== "group" || !l.clip.layout) return;
          writeAnimatable(l.clip, path, next, playhead, (c) => {
            if (c.kind !== "group" || !c.layout) return;
            if (h.kind === "gap") c.layout.gap = next;
            else if (h.kind === "lineGap") c.layout.lineGap = next;
            else c.layout.padding[h.side!] = next;
          });
        },
        { mergeKey: g.mergeKey },
      );
      g.moved = true;
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "layout-reorder") {
      const r = g.layoutReorder;
      const geo = layoutGeometry(g.layoutGroupId);
      if (!r || !geo) return;
      if (!g.moved && Math.hypot(p.x - r.press.x, p.y - r.press.y) < 4) return;
      g.moved = true;
      const id = g.layoutReorderClipId;
      const at = geo.space.fromWorld(toWorld(p));
      // The slot the pointer is over — nearest centre, so rows, columns, wraps
      // and grids all answer the same way.
      let target = r.slots[0]!;
      let best = Infinity;
      for (const s of r.slots) {
        const d = Math.hypot(at.x - (s.x + s.width / 2), at.y - (s.y + s.height / 2));
        if (d < best) {
          best = d;
          target = s;
        }
      }
      const to = r.order.indexOf(target.id);
      let now = geo;
      if (to >= 0 && to !== r.index) {
        // The new order is WRITTEN (one undo step for the whole carry), the one
        // solver lays it out, and everything that moved glides from where it
        // was drawn — so the motion is always the true result, in every flow.
        const before = new Map(geo.slots.map((s) => [s.id, s]));
        store.update("Reorder in layout", (d) => void reorderLayoutMember(d, g.layoutGroupId, id, to), { mergeKey: r.mergeKey });
        r.index = to;
        const after = layoutGeometry(g.layoutGroupId);
        if (after) {
          for (const s of after.slots) {
            const b = before.get(s.id);
            if (b && s.id !== id) glideFrom(s.id, { x: b.x - s.x, y: b.y - s.y });
          }
          now = after;
        }
      }
      const slot = now.slots.find((s) => s.id === id);
      if (slot) holdAt(id, { x: at.x - r.grab.x - (slot.x - r.grabSlot.x), y: at.y - r.grab.y - (slot.y - r.grabSlot.y) });
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "path-slide") {
      const docNow = store.getState();
      const loc = locateClip(docNow, g.pathSlideClipId);
      if (!loc || !isPathText(loc.clip)) return;
      const ride = pathTextRide(loc.clip);
      if (!ride) return;
      const next = Math.round(offsetUnderPointer(ride, toWorld(p), g.pathSlideNear) * 1000) / 1000;
      const playhead = useSession.getState().playheadMs;
      store.update(
        "Slide text along path",
        (d) => {
          const l = locateClip(d, g.pathSlideClipId);
          if (!l || !isPathText(l.clip)) return;
          // The same animatable seam the inspector field uses: keyed (or record
          // armed) writes a key at the playhead, otherwise the base offset.
          writeAnimatable(l.clip, "path.offset", next, playhead, (c) => {
            if (c.kind === "text" && c.path) c.path.offset = next;
          });
        },
        { mergeKey: g.mergeKey },
      );
      g.pathSlideNear = next;
      g.moved = true;
      dirtyRef.current = true;
      return;
    }

    if (g.mode === "drag-layers") {
      // The whole layer-drag brain (delta → constrain/duplicate → write) lives
      // in applyDragLayers, shared with the live ⇧/⌥ modifier watcher.
      applyDragLayers(readMods(e));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    g.pointers.delete(e.pointerId);
    // Always release the live modifier watcher + constraint visual — no drag
    // can leave a keydown listener behind to fire into the next gesture.
    g.modWatch?.();
    g.modWatch = null;
    constrainAxisRef.current = null;

    // A gradient knob CLICKED (not dragged) opens its color editor right at the
    // knob — endpoints edit the first/last stop, interior dots edit their own.
    if (g.mode === "gradient-handle") {
      const setStop = useSession.getState().setActiveGradientStop;
      setStop(!g.moved && g.gradientStopId ? g.gradientStopId : null);
    }

    if (g.mode === "draw-frame") {
      const a = g.frameStart;
      const b = g.frameEnd;
      const w = Math.round(Math.abs(b.x - a.x));
      const h = Math.round(Math.abs(b.y - a.y));
      const dragged = w > 8 && h > 8;
      const docNow = store.getState();
      const frame = createFrame({
        name: `Frame ${docNow.frames.length + 1}`,
        x: Math.round(dragged ? Math.min(a.x, b.x) : a.x - 540),
        y: Math.round(dragged ? Math.min(a.y, b.y) : a.y - 960),
        width: dragged ? w : 1080,
        height: dragged ? h : 1920,
      });
      store.update("Add frame", (d) => {
        frame.pageId = useSession.getState().activePageId;
        insertFrame(d, frame);
      });
      useSession.getState().selectFrame(frame.id);
      useSession.getState().setTool("select");
    }

    if (g.mode === "draw-shape") {
      const a = g.frameStart;
      const b = g.frameEnd;
      const dragged = Math.abs(b.x - a.x) > 4 && Math.abs(b.y - a.y) > 4;
      // A click (no real drag) drops a default 200×200 centered on the point;
      // a drag uses the shared ⇧/⌥-aware rect so preview and result agree.
      const rect = dragged ? shapeDrawRect(a, b, g.shapeSquare, g.shapeFromCenter) : { cx: a.x, cy: a.y, w: 200, h: 200 };
      const cx = rect.cx;
      const cy = rect.cy;
      const w = Math.round(rect.w);
      const h = Math.round(rect.h);
      materializeArmedCell(store);
      const spot =
        frameForRect({ x: cx - w / 2, y: cy - h / 2, w, h }) ??
        (() => {
          const f = frameAtWorld({ x: cx, y: cy });
          return f ? spotIn(f) : null;
        })();
      if (!spot) {
        toast("Add a frame first");
      } else {
        const frame = spot.frame;
        const at = spot.local({ x: cx, y: cy });
        const session = useSession.getState();
        const geo = SHAPE_TOOL_GEOMETRY[g.shapeKind];
        // A POWER WINDOW was asked for: the drawing becomes a grade's window
        // rather than a layer. Same tool, same drag, same geometry.
        if (
          consumeRegionDraw(
            store,
            regionFromShape(
              geo.shape === "ellipse" ? "ellipse" : geo.shape === "polygon" || geo.shape === "star" ? "polygon" : "rect",
              w,
              h,
              geo.pointCount,
            ),
            at,
          )
        ) {
          return;
        }
        // The shape tool's creation defaults (fill / stroke / corner) — edited
        // in the per-tool inspector, applied here, headlessly.
        const sd = useToolDefaults.getState().shape;
        const clip = createShapeClip({
          frameId: frame.id,
          shape: geo.shape,
          pointCount: geo.pointCount,
          startMs: session.playheadMs,
          durationMs: 5000,
          x: at.x,
          y: at.y,
          width: w,
          height: h,
          fill: sd.fill ?? undefined,
          stroke: sd.strokeOn ? strokeStyle(solidPaint(sd.stroke), { width: sd.strokeWidth }) : null,
        });
        if (sd.cornerRadius > 0) {
          const r = sd.cornerRadius;
          clip.cornerRadius = { tl: r, tr: r, br: r, bl: r };
        }
        store.update("Add shape", (d) => placeClip(d, clip, placeAboveSelection(d, clip)));
        session.select([clip.id]);
        session.setActiveComp(frame.id);
        session.setTool("select");
      }
    }

    if (g.mode === "draw-text") {
      const a = g.frameStart;
      const b = g.frameEnd;
      const boxW = Math.round(Math.abs(b.x - a.x));
      const boxH = Math.round(Math.abs(b.y - a.y));
      if (boxW > 12) {
        // A dragged rectangle becomes a FIXED-SIZE text box — it keeps the width
        // AND the height you drew (Figma "Fixed size"), centered on the drag.
        // Content that overflows the box is clipped, not auto-grown.
        placeTextAt(store.getState(), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, boxW, Math.max(24, boxH));
      } else {
        placeTextAt(store.getState(), a, null, null);
      }
    }

    // A carried member lands in the slot the bar showed; a press that never
    // moved is a click, which the selection already handled.
    if (g.mode === "layout-reorder") {
      // Already in its slot — the order was written as it was carried. It
      // only has to glide the last stretch from the pointer into place.
      releaseHold(g.layoutReorderClipId);
      g.layoutReorder = null;
      dirtyRef.current = true;
    }

    if (g.mode === "drag-layers") {
      if (g.moved) {
        // Re-parent layers whose center now sits inside a different frame.
        store.update(
          "Move layer",
          (d) => {
            for (const id of g.dragOrigins.keys()) reparentByPosition(d, id);
          },
          { mergeKey: g.mergeKey },
        );
      } else if (g.selectOnClick) {
        // A press that never moved is a CLICK, and a click resolves the
        // selection it deferred: the topmost layer under the cursor, or ⇧'s
        // toggle — the grab we were holding for a possible drag is released.
        useSession.getState().select(g.selectOnClick.ids);
        useSession.getState().setActiveComp(g.selectOnClick.hostFrameId);
      }
      g.selectOnClick = null;
      dirtyRef.current = true;
    }

    // Drop a frame inside another frame → nest it there (the source frame stays
    // put; a nested clip instance appears in the target). Figma-style parenting.
    if (g.mode === "drag-frame") {
      const docNow = store.getState();
      const dragged = docNow.frames.find((f) => f.id === g.frameDragId);
      // Nest-on-drop is a single-frame gesture; a multi-frame move never nests.
      const singleDrag = g.frameDrags.length <= 1;
      const moved =
        !!dragged &&
        (Math.abs(dragged.x - g.frameOrigin.x) > 6 || Math.abs(dragged.y - g.frameOrigin.y) > 6);
      if (dragged && moved && singleDrag) {
        const cx = dragged.x + dragged.width / 2;
        const cy = dragged.y + dragged.height / 2;
        const target = docNow.frames.find(
          (f) => f.id !== dragged.id && cx >= f.x && cx <= f.x + f.width && cy >= f.y && cy <= f.y + f.height,
        );
        if (target) {
          const clip = createNestedClip({
            frameId: target.id,
            sourceFrameId: dragged.id,
            startMs: useSession.getState().playheadMs,
            durationMs: Math.max(500, frameContentDurationMs(docNow, dragged.id)),
            name: dragged.name,
            x: Math.round(cx - target.x - target.width / 2),
            y: Math.round(cy - target.y - target.height / 2),
            // Inherit the source frame's loop mode as the instance default.
            playback: { loop: dragged.loop },
          });
          store.update("Nest frame", (d) => {
            const src = d.frames.find((f) => f.id === g.frameDragId);
            if (src) {
              // Return the source artboard to where it started — it's the source,
              // not a child; the nested instance lives in the target.
              src.x = g.frameOrigin.x;
              src.y = g.frameOrigin.y;
            }
            placeClip(d, clip, placeAboveSelection(d, clip));
          });
          useSession.getState().select([clip.id]);
          toast(`Nested “${dragged.name}” into “${target.name}”`);
        }
      }
    }

    // A guide dragged onto the ruler / off the artboard is deleted on release.
    if (g.mode === "guide-move" && g.guideDeletePending) {
      store.update("Delete guide", (d) => {
        removeGuide(d, g.guideMoveFrameId, g.guideMoveId);
      });
    }

    // The gesture is over — drop the smart-guide flash and its candidates.
    g.pivotHold?.end();
    g.pivotHold = null;
    g.pivotSnap = null;
    g.snapCandidates = null;
    g.dragStartBox = null;
    clearGuides();

    if (g.pointers.size === 0) {
      g.mode = "none";
      dirtyRef.current = true;
      // Restore the hover cursor now the gesture (pan/resize/etc.) is over.
      updateCursor(localPoint(e));
    }
  };

  /**
   * THE PRESS THAT NEVER CAME BACK.
   *
   * The stage tears its gestures down from its own `onPointerUp` /
   * `onPointerCancel`, which is complete for as long as the pointer keeps
   * behaving. It does not always: a portalled layer mounting over the press
   * (a context menu on a slow Pencil marquee — the reported case), the window
   * blurring, or the tab going away all take the pointer with no `pointerup`
   * anywhere. The marquee then stayed on screen with nothing able to close it,
   * and the next press landed into a gesture that had never ended.
   *
   * The arbiter already knows — it tracks every pointer in the window, in
   * capture phase — so it publishes the fact and this is one subscription
   * rather than a hand-written `pointerup`/`pointercancel`/`blur` trio that
   * the next hand-rolled drag would forget in exactly the same way.
   *
   * A lost pointer ABORTS rather than commits. Nothing on release is a
   * decision the user made if the release never happened.
   */
  React.useEffect(
    () =>
      subscribePointerEnd((id) => {
        /*
         * THE BACKSTOP RUNS FOR EVERY ENDING, not just the lost ones.
         *
         * The first version of this only handled `lost`, on the reasoning that
         * `pointerup` and `pointercancel` already reach the container's own
         * handlers. That reasoning is exactly the assumption that produced the
         * bug: a Pencil marquee that stayed on screen until you clicked again
         * or switched tools, because for whatever reason — a capture stolen by
         * a layer that mounted mid-gesture, a release retargeted after the DOM
         * moved under it, an engine that delivers a pen's last event somewhere
         * the container never sees — the handler did not run. Enumerating the
         * causes is the wrong shape of fix. There are several, they are
         * engine-specific, and the next one will be a cause nobody listed.
         *
         * So this asks the only question that matters and can be answered
         * without knowing why: DID THE GESTURE ACTUALLY END? The arbiter fires
         * in capture, before React's bubble-phase handler, so the check is
         * deferred a turn — by then the container's handler has either run and
         * removed the pointer, or it has not and the gesture is stranded.
         *
         * Aborting rather than committing is deliberate. Nothing that happens
         * on release is a decision the user made if we never saw the release.
         */
        window.setTimeout(() => {
          const g = gesture.current;
          if (!g.pointers.delete(id) || g.pointers.size > 0) return;
          if (g.mode === "none") return;
          // A carry that never saw its release puts the order back.
          const r = g.layoutReorder;
          if (g.mode === "layout-reorder" && r) {
            if (r.index !== r.fromIndex) {
              store.update("Reorder in layout", (d) => void reorderLayoutMember(d, g.layoutGroupId, g.layoutReorderClipId, r.fromIndex), { mergeKey: r.mergeKey });
            }
            releaseHold(g.layoutReorderClipId);
            g.layoutReorder = null;
          }
          g.modWatch?.();
          g.modWatch = null;
          constrainAxisRef.current = null;
          g.snapCandidates = null;
          g.dragStartBox = null;
          clearGuides();
          g.mode = "none";
          if (containerRef.current) containerRef.current.style.cursor = "";
          dirtyRef.current = true;
        }, 0);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const placeTextAt = (
    docNow: MotionDocument,
    world: { x: number; y: number },
    maxWidth: number | null,
    maxHeight: number | null = null,
  ) => {
    const spot = spotForNewLayer(world);
    if (!spot) {
      toast("Add a frame first");
      return;
    }
    const frame = spot.frame;
    const at = spot.local(world);
    const session = useSession.getState();
    const lastFont = getLastFont(useAppShell.getState().currentProjectId);
    // The text tool's creation defaults (font, size, colour, alignment…), edited
    // in the per-tool inspector. The project's last-used font still wins so new
    // text continues where you left off.
    const textDefaults = useToolDefaults.getState().text;
    const clip = createTextClip({
      // Born empty (Figma): the caret sits ready, and clicking away without
      // typing discards the layer (TextEditOverlay's blur cleanup).
      frameId: frame.id,
      // Unopinionated: T-tool text has NO default animation (library/template
      // drops still bring their own preset). null = born plain.
      presetId: null,
      text: "",
      startMs: session.playheadMs,
      x: at.x,
      y: at.y,
      style: { ...textDefaults, ...(lastFont ? { fontFamily: lastFont } : {}) },
    });
    // A dragged box wraps to a fixed width; a click stays auto-width.
    if (maxWidth !== null) clip.maxWidth = Math.max(50, Math.round(maxWidth));
    if (maxHeight !== null) clip.maxHeight = Math.max(24, Math.round(maxHeight));
    store.update("Add text", (d) => placeClip(d, clip, placeAboveSelection(d, clip)));
    session.select([clip.id]);
    session.startTextEdit(clip.id);
    session.setTool("select");
  };

  /**
   * Text that WRITES ON an outline: born bound to the host under the text tool,
   * anchored where the pointer touched the curve, and opened for typing at
   * once. The text's align decides which end of the run sits at the anchor —
   * the tool's default, so it reads exactly as a plain text placed there would.
   *
   * It goes on the host's own scope (the same group rows) so the group chain
   * that places the host places the text, and above the host in z so the
   * letters are never under the fill they sit on.
   */
  const placeTextOnPath = (target: OutlineTarget) => {
    const host = target.hostSpace.host;
    const session = useSession.getState();
    const lastFont = getLastFont(useAppShell.getState().currentProjectId);
    const textDefaults = useToolDefaults.getState().text;
    const clip = createTextClip({
      frameId: host.frameId,
      presetId: null,
      text: "",
      startMs: session.playheadMs,
      x: 0,
      y: 0,
      style: { ...textDefaults, ...(lastFont ? { fontFamily: lastFont } : {}) },
    });
    const length = target.hostSpace.polylines[target.hit.contour]?.length ?? 0;
    // Letters stand on the OUTSIDE of a shape. On a host that is the size of
    // its comp — a backdrop — outside is off the artboard, where the frame's
    // overflow clips it and the first thing typed is invisible; a host that big
    // is written on the inside instead.
    const frame = store.getState().frames.find((f) => f.id === host.frameId);
    const hostBox = clipBox(store.getState(), host);
    const flip = !!frame && hostBox.width * hostBox.height >= frame.width * frame.height * 0.85;
    store.update("Add text on path", (d) => {
      // Same rows as the host, so one group chain places both.
      placeClip(d, clip, { aboveClipId: host.id, groupId: groupOfClip(d, host.id) });
      const live = locateClip(d, clip.id)?.clip;
      if (!live || live.kind !== "text") return;
      bindTextToPath(d, live, host.id, {
        contour: target.hit.contour,
        offset: offsetForArcLength(target.hit.d, length),
        flip,
      });
    });
    session.select([clip.id]);
    session.startTextEdit(clip.id);
    session.setTool("select");
  };

  /**
   * A dragged layer joins the frame under its world center — reparented, its
   * world position kept, placed on top (core `reparentClipToFrame`). Dropping it
   * over the void (no frame under the center) keeps its current parent, so a
   * layer nudged off its frame is never orphaned. One rule for both directions.
   *
   * DRILLED IN, there is no reparenting at all. The comp you are editing is
   * painted on top of the page frame behind it, so "the frame under the centre"
   * is that page frame for every layer inside it — dragging artwork a few
   * pixels would have silently torn it out of the comp and dropped it in the
   * parent. A gesture inside a level never moves anything out of that level.
   */
  const reparentByPosition = (d: MotionDocument, clipId: string) => {
    if (standingFrameId(d)) return;
    const loc = locateClip(d, clipId);
    if (!loc || loc.clip.kind === "audio") return;
    const clip = loc.clip;
    const from = d.frames.find((f) => f.id === clip.frameId);
    if (!from) return;
    const playhead = useSession.getState().playheadMs;
    const pose = clipPose(clip, clipLocalClamped(clip, playhead));
    const worldX = from.x + from.width / 2 + pose.x;
    const worldY = from.y + from.height / 2 + pose.y;
    const frames = framesInView(d, useSession.getState());
    // Topmost frame under the center wins; core no-ops if it's the same frame.
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i]!;
      if (worldX >= f.x && worldX <= f.x + f.width && worldY >= f.y && worldY <= f.y + f.height) {
        // A LINKED INSTANCE frame owns no content — it renders its master's
        // shared clips. So a layer dropped "into" an instance belongs to that
        // master, never the instance frame (which would orphan it and empty the
        // master's timeline). Resolve every drop target to its content owner.
        reparentClipToFrame(d, clipId, f.instanceOf ?? f.id);
        return;
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    // Accept the canvas or its container: while a pointer capture from the
    // preceding clicks is active, the browser can retarget the compatibility
    // mouse (dbl)click to the capturing container instead of the canvas.
    // Overlays that shouldn't trigger this (text editor, toolbar) stop
    // propagation themselves, so widening the guard here is safe.
    if (e.target !== canvasRef.current && e.target !== containerRef.current) return;
    const p = localPoint(e);
    // Figma: double-clicking a frame's name label renames it inline — takes
    // priority since the label sits just above the frame, outside its bounds.
    const labelFrameId = hitTestLabel(p);
    if (labelFrameId) {
      useSession.getState().selectFrame(labelFrameId);
      setRenamingFrameId(labelFrameId);
      return;
    }
    // Motion path: double-click an anchor toggles smooth ↔ corner; double-click
    // the curve plants a new position key exactly ON the path (shape preserved).
    {
      const mh = motionSceneRef.current ? hitMotionScene(motionSceneRef.current, p) : null;
      if (mh && !mh.locked) {
        if (mh.kind === "anchor") {
          store.update("Toggle smooth motion point", (d) => {
            const loc = locateClip(d, mh.clipId);
            if (loc && loc.clip.kind !== "audio") toggleMotionSmooth(loc.clip, mh.timeMs);
          });
        } else if (mh.kind === "segment") {
          store.update("Add motion point", (d) => {
            const loc = locateClip(d, mh.clipId);
            if (loc && loc.clip.kind !== "audio") insertMotionKey(loc.clip, mh.a, mh.b, mh.u);
          });
        }
        dirtyRef.current = true;
        return;
      }
    }
    // NOTE: the pivot crosshair deliberately has NO double-click of its own.
    // It floats inside the layer it belongs to, so a branch here answered "the
    // pointer is over the anchor" when the user's intent was "open this layer",
    // and which one you got depended on where the anchor happened to sit — a
    // text layer with a centred anchor was almost impossible to double-click
    // into. A double-click is the drill, everywhere, for every kind of layer;
    // pivot MODE is entered from the inspector's anchor control, which is a
    // deliberate act rather than a coincidence of geometry. The crosshair is
    // still a direct press-drag handle (see `isDrillPress`).
    // ONE ladder in, ONE ladder out. A double-click that isn't on a clip — or
    // that lands outside the thing you're currently inside — steps out exactly
    // one level: close the interior editor (corners, crop, nodes, glyphs), else
    // leave the innermost comp. It is the same `exitContext` Escape walks, so
    // the two gestures can never drift apart, and it replaces the three
    // separate "am I in shape edit / crop / a drill?" special cases that used
    // to each decide for themselves what "out" meant.
    const hit = hitTestClip(p);
    {
      const session = useSession.getState();
      const outsideContext = !hit && !insideEditContext(store.getState(), session, toWorld(p));
      if ((!hit && session.nav.leaf) || outsideContext) {
        const leafId = session.nav.leaf?.clipId ?? null;
        if (session.exitContext()) {
          // Closing an interior editor leaves you ON that layer, selected —
          // one more double-click on empty canvas then deselects.
          if (leafId) useSession.getState().select([leafId]);
          return;
        }
      }
    }
    if (!hit) {
      const f = frameAtWorld(toWorld(p));
      if (f) {
        useSession.getState().selectFrame(f.id);
        // A 3D world opens its viewport, the way entering a comp opens its timeline.
        if (f.world) useWorldUi.getState().set({ openId: f.id });
      }
      return;
    }
    const loc = locateClip(store.getState(), hit.clipId);
    if (!loc || isClipLocked(loc.track, loc.clip)) return;
    const session = useSession.getState();

    // The unified drill brain (shared with the timeline): each double-click
    // steps ONE level — outermost group → … → innermost group → the leaf clip →
    // the clip's own editor. Text is no longer special-cased into an instant
    // edit; a grouped text now first selects its layer, THEN edits on the next
    // double-click, exactly like every other kind (base layer → its own mode).
    const action = resolveEnter(store.getState(), loc.clip, {
      enteredGroupId: session.enteredGroupId,
      selectedClipIds: session.selectedClipIds,
    });
    const edit = applyEnter(action, session);
    if (!edit) return; // drilled a group / selected the leaf — done
    // The terminal step is shared with the timeline AND the right-click menu's
    // top item (`openClipEditor`), so all three ways into a layer's own editor
    // are literally the same code path.
    openClipEditor(store, loc.clip, edit.mode);
  };

  // 64× ceiling: deep enough to pixel-peep (the pixel grid fades in past 4×).
  // Named for the CAMERA — layer scale is clamped by core `clampScale`, which is
  // sign-preserving because a negative layer scale is a mirror.
  const clampViewScale = (s: number) => Math.min(64, Math.max(0.02, s));

  // "Don't allow us to go too far from the nearest frame" — every gesture that
  // moves the camera (drag-pan, wheel-pan, pinch/wheel-zoom) funnels through
  // here, so the leash can't be bypassed by some future gesture forgetting to
  // apply it. Only pulls back once content has drifted well past the slack
  // margin (clampCameraToLeash); scale itself is clamped separately by the
  // caller, so this never fights a deliberate deep zoom.
  const applyCamera = (next: { scale: number; tx: number; ty: number }) => {
    // Every camera gesture funnels through here, which is also why the raster
    // fast path is armed here: one seam, so no future gesture can move the
    // camera without the renderer knowing it was only the camera that moved.
    noteCameraMove(performance.now());
    const el = containerRef.current;
    if (!el) {
      useStageView.getState().set(next);
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    const d = store.getState();
    const all = framesInView(d, useSession.getState());
    const bounds = contentBoundsOf(all.length > 0 ? all : d.frames);
    useStageView.getState().set(bounds ? clampCameraToLeash(next, bounds, { width, height }) : next);
  };

  const zoomAt = (center: { x: number; y: number }, nextScale: number) => {
    const view = useStageView.getState();
    const k = nextScale / view.scale;
    applyCamera({
      scale: nextScale,
      tx: center.x - (center.x - view.tx) * k,
      ty: center.y - (center.y - view.ty) * k,
    });
  };

  /**
   * TWO FINGERS = NAVIGATE. Pinch zooms, drag pans, and the two compose in one
   * gesture the way they do in every map and every canvas app.
   *
   * The stage used to recognise a pinch itself, inside `onPointerDown`: a
   * private `mode: "pinch"` that could zoom but not pan, that no other surface
   * could reach, and that left the timeline, the node board and the curve
   * editor with no two-finger gesture at all. One surface having a partial
   * private copy of a concept the whole app needs is the duplication this
   * codebase keeps paying for, so the recognizer moved out (`input/
   * use-multi-touch`) and every surface now shares it — including this one,
   * which gained panning by giving its copy up.
   *
   * The zoom is anchored at the CENTROID and applied incrementally, so it goes
   * through `zoomAt` — the same leashed, clamped camera path the wheel, the
   * dial and Fit all use. Nothing here can move the camera behind the
   * renderer's back.
   */
  const touch = useMultiTouch(containerRef, {
    onStart: () => {
      // The first finger may already have started a drag. It is cancelled, not
      // committed: the user reached for navigation, and half a move should not
      // survive it.
      const g = gesture.current;
      g.modWatch?.();
      g.modWatch = null;
      constrainAxisRef.current = null;
      g.pivotHold?.end();
      g.pivotHold = null;
      g.pivotSnap = null;
      g.snapCandidates = null;
      g.dragStartBox = null;
      clearGuides();
      g.mode = "none";
      dirtyRef.current = true;
    },
    onGesture: ({ scale, dx, dy, x, y }) => {
      const view = useStageView.getState();
      const next = clampViewScale(view.scale * scale);
      // Pan first, then zoom about the centroid: applying the translation to
      // the pre-zoom camera keeps the point under the fingers fixed through
      // both halves of the gesture, which is what makes it feel like the
      // canvas is under your hand rather than being driven.
      applyCamera({ scale: view.scale, tx: view.tx + dx, ty: view.ty + dy });
      if (next !== view.scale) zoomAt({ x, y }, next);
    },
  });

  // The stage zoom dial (StageControls) sets an absolute scale anchored at the
  // viewport center — the same clamped/leashed path every other zoom gesture
  // uses, so nothing can bypass the leash.
  const zoomStageToScale = React.useCallback((nextScale: number) => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    zoomAt({ x: r.width / 2, y: r.height / 2 }, readLevel(CAMERA_ZOOM, nextScale));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The D5 keys, routed here when no other view owns them
  // (`workspace/zoom-shortcuts.ts`): ⌘± step by the camera spec, ⌘0 fits,
  // ⇧0 is 100%.
  React.useEffect(
    () =>
      onStageZoomRequest((kind) => {
        if (kind === "fit") fit();
        else zoomStageToScale(kind === "actual" ? 1 : stepLevel(CAMERA_ZOOM, useStageView.getState().scale, kind === "in" ? 1 : -1));
      }),
    [zoomStageToScale, fit],
  );

  // Wheel: pan; pinch / ⌘-scroll: zoom — the unified gesture, same as the
  // timeline and the graph panel.
  useZoomGesture(containerRef, {
    onZoom: (factor, center) => {
      zoomAt(center, clampViewScale(useStageView.getState().scale * factor));
    },
    onPan: (dx, dy) => {
      const view = useStageView.getState();
      applyCamera({ scale: view.scale, tx: view.tx + dx, ty: view.ty + dy });
    },
  });

  // Which layer a MODIFIER drag would land on, outlined live. One hook, shared
  // by every surface that drops something onto a layer (see use-drop-target).
  // The highlight runs the DROP's own resolver — one answer, so the outline
  // can never promise a layer the release would refuse.
  // Passed fresh every render on purpose: the hook holds it in a latest-value
  // ref, so memoising it here would only risk freezing a stale camera.
  const dropTarget = useStageDropTarget(containerRef, (client, drag) => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return layerDropTargetAt({ x: client.x - rect.left, y: client.y - rect.top }, drag);
  });

  // Pick mode: the stage answers "which candidate is here" with the click's own
  // hit stack (locked layers included — a target need not be editable).
  useStagePickSurface({
    containerRef,
    hitStack: (p) => hitStackAt(p, true),
    hitRects: () => hitRectsRef.current,
    doc: () => store.getState(),
    pan: (dx, dy) => {
      const view = useStageView.getState();
      applyCamera({ scale: view.scale, tx: view.tx + dx, ty: view.ty + dy });
    },
  });

  // Library drag-drop onto the canvas (dispatched by the left panel controller).
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onDrop = (e: Event) => {
      const { clientX, clientY, drag } = (e as CustomEvent<{ clientX: number; clientY: number; drag: LibraryDrag }>).detail;
      if (!drag) return;
      const p = localPoint({ clientX, clientY });
      const session = useSession.getState();
      // A media asset drops as a new clip at the cursor, in the frame under it.
      if (drag.kind === "media") {
        const drop = dropTargetAt(p);
        if (!drop) return;
        const cf = drop.frame;
        const asset = store.getState().assets.find((a) => a.id === drag.id);
        if (!asset) return;
        // Split-aware placement (video keeps its sound as a linked audio lane).
        void placeAssetClips(
          store,
          asset,
          { frameId: cf.id, startMs: session.playheadMs, x: drop.x, y: drop.y },
          { width: cf.width, height: cf.height },
        );
        return;
      }
      // A COMPONENT drops as an INSTANCE at the cursor, in the frame under it.
      if (drag.kind === "component") {
        const drop = dropTargetAt(p);
        if (drop) {
          placeComponentInstance(store, drag.id, {
            frameId: drop.frame.id,
            startMs: session.playheadMs,
            x: drop.x,
            y: drop.y,
          });
        }
        return;
      }
      // A snapshot — a saved component, an icon, any panel's clips — lands at
      // the drop position (never "apply to a clip"), on top of what is there.
      if (drag.kind === "snapshot") {
        const wc = toWorld(p);
        const cf =
          frameAtWorld(wc) ??
          store.getState().frames.find((f) => f.id === session.activeFrameId) ??
          store.getState().frames[0];
        if (cf) {
          placeLibraryItem(
            store,
            drag.id,
            {
              frameId: cf.id,
              startMs: session.playheadMs,
              dx: Math.round(wc.x - cf.x - cf.width / 2),
              dy: Math.round(wc.y - cf.y - cf.height / 2),
            },
          );
        }
        return;
      }
      // A transition attaches to a CUT, which the canvas does not have. Say so
      // once rather than swallowing the gesture.
      if (drag.kind === "transition") {
        toast("Transitions drop on a cut in the timeline");
        return;
      }
      // An ANIMATION is a modifier: it lands on the LAYER under the cursor and
      // does nothing at all over empty canvas. It used to fall through to the
      // create path and conjure a text layer to animate, which is the preset
      // inventing its own subject.
      const hit = layerDropTargetAt(p, drag);
      if (drag.kind === "anim") {
        if (!hit) {
          toast("Drop an animation on a layer");
          return;
        }
        const loc = locateClip(store.getState(), hit.clipId);
        const targets = libraryDropTargets(hit.clipId, session.selectedClipIds);
        applyLibraryItemToClip(store, drag, targets);
        session.select([...targets]);
        if (loc) {
          session.setPlayhead(loc.clip.startMs);
          session.setPlaying(true);
        }
        return;
      }
      // Drop-to-RESTYLE (Figma): a text preset dropped ONTO a text layer
      // restyles that layer in place. `layerDropTargetAt` already answered
      // whether any layer under the cursor can take it; over an image or shape
      // it is null, so the drop falls through to CREATE rather than swallowing
      // the gesture and merely reselecting a layer it cannot touch.
      if (hit) {
        const targets = libraryDropTargets(hit.clipId, session.selectedClipIds);
        applyLibraryItemToClip(store, drag, targets);
        session.select([...targets]);
        return;
      }
      const w = toWorld(p);
      // Land in the frame under the cursor, or the currently OPEN comp (e.g.
      // drilled into a nested clip/component) when the drop point doesn't land
      // inside a frame's own bounds — a private nested comp's source frame lives
      // far from its instance's on-canvas position, so hit-testing alone would
      // silently drop nothing.
      const frame =
        frameAtWorld(w) ??
        store.getState().frames.find((f) => f.id === session.activeFrameId) ??
        store.getState().frames[0];
      if (!frame) return;
      const x = Math.round(w.x - frame.x - frame.width / 2);
      const y = Math.round(w.y - frame.y - frame.height / 2);
      // ONE seam for "what clip a text preset makes" — shared with the timeline
      // drop and the drag ghost, so every surface drops the exact same layer.
      const clip = textPresetClip(drag, { frameId: frame.id, startMs: session.playheadMs, x, y });
      // Nothing to create and (by the branch above) no layer that could take
      // it — an honest no-op.
      if (!clip) return;
      store.update(drag.kind === "template" ? "Add template" : "Add text", (d) => placeClip(d, clip));
      session.select([clip.id]);
    };
    el.addEventListener("tm-library-drop", onDrop);
    return () => el.removeEventListener("tm-library-drop", onDrop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  /** Editing selects; the Hand tool views. A present mode is one more value here. */
  const linkMode = (): LinkClickMode => (useSession.getState().tool === "hand" ? "view" : "edit");
  const linkPressIntent = (mod: boolean) => linkClickIntent(linkMode(), { mod });
  const linkUnder = (p: { x: number; y: number }): LinkUnderPoint | null => {
    const doc = store.getState();
    return linkAtPoint(doc, hitRectsRef.current, toWorld(p), (id) => clipByIdIn(doc, id) ?? null);
  };
  const linkMarkerAt = (p: { x: number; y: number }): LinkMarker | null =>
    linkMarkersRef.current.find((m) => Math.hypot(p.x - m.x, p.y - m.y) <= LINK_MARKER_HIT_PX)?.marker ?? null;
  refreshCursorRef.current = () => updateCursor(lastPointerRef.current);

  /**
   * A press on a link it should follow. Editing: the press is the link's
   * outright (no select, no drag) — ⌘ already said so. Viewing: the hand still
   * pans, and only a click that did not travel follows.
   */
  const onLinkPressCapture = (e: React.PointerEvent): boolean => {
    linkPressRef.current = null;
    if (e.button !== 0 || isForeignEvent(containerRef.current, e)) return false;
    // The marker is a button: a plain press follows it, in any mode.
    const marker = linkMarkerAt(localPoint(e));
    if (marker) {
      const p = localPoint(e);
      linkPressRef.current = { x: p.x, y: p.y, link: marker.link, newTab: e.metaKey || e.ctrlKey };
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    const intent = linkPressIntent(e.metaKey || e.ctrlKey);
    if (!intent) return false;
    const p = localPoint(e);
    const hit = linkUnder(p);
    if (!hit) return false;
    linkPressRef.current = { x: p.x, y: p.y, link: hit.link, newTab: intent === "follow-new" };
    if (linkMode() !== "edit") return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };
  const onLinkClick = (e: React.MouseEvent) => {
    const press = linkPressRef.current;
    linkPressRef.current = null;
    if (!press) return;
    const p = localPoint(e);
    if (Math.hypot(p.x - press.x, p.y - press.y) > LINK_CLICK_SLOP_PX) return;
    linkHoverRef.current = null;
    dirtyRef.current = true;
    followLink(store, press.link, { forceNew: press.newTab });
  };

  /** The resize cursor for the picture corner nearest the pointer, aimed the way that corner faces. */
  const mediaCornerCursor = (
    p: { x: number; y: number },
    geo: NonNullable<ReturnType<typeof cropGeom>>,
  ): string => {
    const { nw, ne, se, sw } = geo.mediaRect;
    const box = [nw, ne, se, sw];
    let nearest = 0;
    box.forEach((c, i) => {
      if (Math.hypot(p.x - c.x, p.y - c.y) < Math.hypot(p.x - box[nearest]!.x, p.y - box[nearest]!.y)) nearest = i;
    });
    return resizeCursor(cornerBearing(box, nearest));
  };

  const updateCursor = (p: { x: number; y: number }) => {
    const el = containerRef.current;
    if (!el) return;
    // While SPACE is held the canvas is a temporary hand tool — grab beats every
    // per-handle cursor (a running pan already shows "grabbing").
    if (spacePan.held) {
      el.style.cursor = cursors.grab;
      return;
    }
    // A LINK that a press would follow wins the cursor: ⌘ held while editing,
    // or any time with the Hand tool (ADR-links). Outlined, so the press that
    // follows is never a surprise.
    const hover = linkMarkerAt(p) ?? (linkPressIntent(scaleModifierRef.current) ? linkUnder(p) : null);
    if (!sameLinkHover(linkHoverRef.current, hover)) {
      linkHoverRef.current = hover;
      dirtyRef.current = true;
    }
    if (hover) {
      el.style.cursor = cursors.pointer;
      return;
    }
    const t = useSession.getState().tool;
    let cursor =
      t === "hand"
        ? cursors.grab
        : t === "text"
          ? cursors.text
          : t === "pen"
            ? cursors.pen
            : t === "frame" || isShapeTool(t)
              ? cursors.crosshairAdd
              : cursors.arrow;
    // The text tool over an outline announces the bind before the click: the
    // I-beam grows a wave under it, exactly where a press would write on the
    // curve. Announced, so the bind never reads as an accident.
    if (t === "text") {
      const view = useStageView.getState();
      if (outlineUnderPointer(toWorld(p), hitRectsRef.current, TEXT_PATH_SNAP_PX, view.scale)) cursor = cursors.textOnPath;
    }
    if (t === "select") {
      const selId = useSession.getState().selectedClipIds;
      if (selId.length === 1) {
        const loc = locateClip(store.getState(), selId[0]!);
        const grip = loc && isPathText(loc.clip) ? textPathGripScreen(loc.clip) : null;
        if (grip && Math.hypot(p.x - grip.x, p.y - grip.y) <= PATH_GRIP_HIT_PX) {
          el.style.cursor = cursors.grab;
          return;
        }
      }
    }
    if (t === "select") {
      // A selected auto layout box: hovering a gap or padding band lights it and
      // shows its value, the way Figma does — and the cursor says which way it goes.
      const sel = useSession.getState().selectedClipIds;
      const geo = sel.length === 1 ? layoutGeometry(sel[0]!) : null;
      const handle = geo ? layoutHandleAt(geo, p) : null;
      if (!sameLayoutHandle(layoutHoverRef.current, handle)) {
        layoutHoverRef.current = handle;
        dirtyRef.current = true;
      }
      if (handle) {
        el.style.cursor = handle.axis === "x" ? cursors.colResize : cursors.rowResize;
        return;
      }
      const guide = hitTestGuide(p);
      if (guide) {
        el.style.cursor = resizeCursor(guide.axis === "x" ? 0 : 90);
        return;
      }
      // Crop mode is MODAL: the crop handles are an axis/diagonal resize, and
      // the two drag regions read as two different verbs — a move cursor over
      // the window you can reframe, a grab hand over the picture you can pull
      // through it. Everything else is the default; no transform cursors ever
      // leak through. Fully self-contained + returns.
      const cropId = useSession.getState().cropClipId;
      if (cropId && useSession.getState().selectedClipIds.includes(cropId)) {
        const cropHit = hitTestCropHandle(p);
        if (cropHit) {
          const { nw, ne, se, sw } = cropGeom(cropId)!.rect;
          const box = [nw, ne, se, sw];
          const at = CROP_SIDE_BOX[cropHit.side];
          el.style.cursor = resizeCursor("corner" in at ? cornerBearing(box, at.corner) : edgeBearing(box, at.edge));
          return;
        }
        const geo = cropGeom(cropId);
        // Same brain as the badge — and mid-drag it reports the LIVE verb, so a
        // ⌥ swap moves the cursor with it.
        const verb = geo ? cropVerbAt(p, geo) : null;
        // Turning the picture gets the SAME orientation-aware rotate cursor the
        // layer's own band shows — `rotateCursor`, aimed from the picture's
        // centre — rather than a generic one. The cursor is most of how a
        // rotate band announces itself.
        el.style.cursor = !verb
          ? cursors.arrow
          : verb === "crop-rotate" && geo
            ? rotateCursor(bearingOf(p.x - geo.picCentre.x, p.y - geo.picCentre.y))
            : verb === "crop-zoom" && geo
              ? mediaCornerCursor(p, geo)
              : CROP_VERB_CURSOR[verb];
        // The verb badge follows the hovered region, so crossing between the two
        // has to repaint. Crop is a focused modal state — one clip, thin chrome —
        // so marking dirty on move here costs nothing.
        if (cropVerbRef.current !== verb) {
          cropVerbRef.current = verb;
          dirtyRef.current = true;
        }
        return;
      }
      // The pivot and the motion path's marks come first, as they do on a press.
      const motionMark = motionSceneRef.current ? hitMotionScene(motionSceneRef.current, p) : null;
      if (hitTestPivot(p) || (motionMark && !motionMark.locked)) {
        el.style.cursor = cursors.move;
        return;
      }
      const cornerNode = hitTestShapeCorner(p);
      const frameHandle = cornerNode ? null : hitTestFrameHandle(p);
      const radiusHandle = cornerNode || frameHandle ? null : hitTestRadiusHandle(p);
      const shapeHandle =
        cornerNode || frameHandle || radiusHandle ? null : hitTestShapeHandle(p);
      const resizeHandle =
        cornerNode || frameHandle || radiusHandle || shapeHandle ? null : hitTestResizeHandle(p);
      const groupHandle =
        cornerNode || frameHandle || radiusHandle || shapeHandle || resizeHandle
          ? null
          : hitTestGroupResizeHandle(p);
      // The rotate band lives OUTSIDE the corners, so it only claims the cursor
      // once nothing on the box itself does.
      const rotateZone =
        cornerNode || frameHandle || radiusHandle || shapeHandle || resizeHandle || groupHandle
          ? null
          : hitTestRotateZone(p);
      if (cornerNode) cursor = cursors.move;
      else if (frameHandle) cursor = HANDLE_CURSOR[frameHandle.handle];
      else if (radiusHandle) cursor = cursors.cornerRadius;
      else if (shapeHandle) cursor = shapeHandle.kind === "arc-ratio" ? cursors.move : cursors.crosshair;
      else if (resizeHandle) cursor = resizeHandle.cursor;
      else if (groupHandle) cursor = groupHandle.cursor;
      else if (rotateZone) cursor = rotateCursor(rotateZone.bearing);
      else if (hitTestLabel(p)) cursor = cursors.move;
    }
    el.style.cursor = cursor;
  };

  // Files dropped anywhere on the canvas import through ONE dispatcher: media
  // lands as clips in the frame under the cursor; slice files (slices /
  // .motion) merge in and drop their new top-level frames at the cursor point.
  const onFileDrop = (e: React.DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt || (dt.items.length === 0 && dt.files.length === 0)) return;
    e.preventDefault();
    e.stopPropagation();
    const world = toWorld({
      x: e.clientX - containerRef.current!.getBoundingClientRect().left,
      y: e.clientY - containerRef.current!.getBoundingClientRect().top,
    });
    const doc = store.getState();
    const session = useSession.getState();
    const frame = frameAtWorld(world) ?? ensureContentFrame(store, session.activeFrameId);
    const dropLocal = frameSpace(frame.id, doc)?.fromWorld(world) ?? {
      x: world.x - (frame.x + frame.width / 2),
      y: world.y - (frame.y + frame.height / 2),
    };
    const target = {
      media: {
        frameId: frame.id,
        startMs: session.playheadMs,
        x: Math.round(dropLocal.x),
        y: Math.round(dropLocal.y),
        placement: {},
      },
      data: { onPage: { pageId: frame.pageId ?? doc.pages[0]!.id, world } },
    };
    // Recurse any dropped folders (entries captured synchronously), then import.
    void filesFromDataTransfer(dt).then((files) => {
      if (files.length) void importDroppedFiles(store, files, target);
    });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div
      ref={containerRef}
      // `isolate` traps the stage's internal z-indexes (toolbar z-50, chrome
      // z-40, drawing z-30) in their OWN stacking context, so body-portalled
      // floating windows always paint above the whole stage — the sticky
      // toolbar never covers a window any more.
      className="stage-backdrop relative isolate h-full w-full touch-none select-none overflow-hidden bg-stage"
      // `bg-stage` is the THEME's surround and it stays on the element. A
      // document that named its own colour paints over it; one that asked to
      // follow the theme (the default) paints nothing at all, so the surround
      // re-tints live when the theme changes instead of being frozen at the
      // hex some document was created under.
      style={{ backgroundColor: resolveStageBackground(doc) ?? undefined }}
      data-stage-drop
      onPointerDownCapture={(e) => {
        if (!onLinkPressCapture(e)) onMiddlePanCapture(e);
      }}
      onClick={onLinkClick}
      onPointerDown={onStagePointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // Middle-click's default action (paste on X11, the autoscroll puck on
      // Windows) has to be refused on the click too, not only the press.
      onAuxClick={(e) => e.button === 1 && e.preventDefault()}
      onPointerLeave={() => {
        setStagePasteAnchor(null);
        useHoverLink.getState().clear("stage");
        if (linkHoverRef.current) {
          linkHoverRef.current = null;
          dirtyRef.current = true;
        }
      }}
      onDoubleClick={onDoubleClick}
      onContextMenuCapture={onStageContextMenu}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
      }}
      onDrop={onFileDrop}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={chromeRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
      <VectorOverlay />
      <TrackOverlay />
      <PerformLayer />
      <PickLayer />
      <RigOverlay />
      <PhysicsOverlayHost />
      <WeightPaintOverlay />
      <WindowOverlay />
      <DrawingOverlay />
      <TextEditOverlay />
      <LibraryDropStageGhost />
      {dropTarget.overlay}
      <GradientStopEditor />
      {renamingFrameId && (
        <FrameRenameOverlay frameId={renamingFrameId} onDone={() => setRenamingFrameId(null)} />
      )}
      <RulerOverlay />

      {/* Per-guide settings — opened by right-clicking a guide line on canvas. */}
      <Popover open={!!guideMenu} onOpenChange={(o) => !o && setGuideMenu(null)}>
        <PopoverAnchor asChild>
          <div className="pointer-events-none fixed" style={{ left: guideMenu?.x ?? 0, top: guideMenu?.y ?? 0 }} />
        </PopoverAnchor>
        {guideMenu && (
          <PopoverContent align="start" sideOffset={4} className="w-56 p-3">
            <RulerSettings
              target={{ kind: "guide", frameId: guideMenu.frameId, guideId: guideMenu.guideId }}
              onRemove={() => setGuideMenu(null)}
            />
          </PopoverContent>
        )}
      </Popover>

      {/* Motion-path point menu — right-click an anchor on the path. */}
      <Popover open={!!motionMenu} onOpenChange={(o) => !o && setMotionMenu(null)}>
        <PopoverAnchor asChild>
          <div className="pointer-events-none fixed" style={{ left: motionMenu?.x ?? 0, top: motionMenu?.y ?? 0 }} />
        </PopoverAnchor>
        {motionMenu && (
          <PopoverContent align="start" sideOffset={4} className="w-44 p-1">
            <button
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
              onClick={() => {
                store.update(motionMenu.smooth ? "Corner motion point" : "Smooth motion point", (d) => {
                  const loc = locateClip(d, motionMenu.clipId);
                  if (loc && loc.clip.kind !== "audio") toggleMotionSmooth(loc.clip, motionMenu.timeMs);
                });
                dirtyRef.current = true;
                setMotionMenu(null);
              }}
            >
              {motionMenu.smooth ? "Make corner (straight)" : "Make smooth (curved)"}
            </button>
            <button
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-accent"
              onClick={() => {
                store.update("Delete motion point", (d) => {
                  const loc = locateClip(d, motionMenu.clipId);
                  if (loc && loc.clip.kind !== "audio") deleteMotionKey(loc.clip, motionMenu.timeMs);
                });
                dirtyRef.current = true;
                setMotionMenu(null);
              }}
            >
              Delete point
            </button>
          </PopoverContent>
        )}
      </Popover>

      {/* ALL floating chrome, in one collision-proof layout (StageChrome).
          Nothing here positions itself — each piece names a slot and the grid
          owns the rest, which is why the tool rail can no longer land on the
          timeline or on the view cluster. */}
      <StageChrome
        insets={rulersOn ? { top: RULER_SIZE, left: RULER_SIZE } : undefined}
        items={[
          // THE TOP EDGE, three zones (`chrome-layout.ts`): where you are on
          // the left, how you see it on the right, always, and the armed
          // tool's own options between them, capped and scrolling.
          //
          //     [ path ] ······· [ tool options ] ······· [ zoom · view ]
          //
          // THE BOTTOM EDGE: the tools, centred and floating (Figma's shape),
          // a capsule the stage reserves before anything else is laid out, so
          // no panel, timeline or narrow window can clip it; past its width it
          // scrolls with edge fades. A person may still dock it on a side.
          { id: "breadcrumb", edge: "top", align: "start", node: <StageContextBar /> },
          { id: "view", edge: "top", align: "end", node: <StageControls onZoom={zoomStageToScale} onFit={() => fit()} /> },
          { id: "tool-options", edge: "top", align: "center", node: <ToolOptionsBar /> },
          { id: "rail", ...placementOf(toolbarPlacement), node: <StageToolbar /> },
          // A thing you HOLD, so it hangs where a hand already rests. It
          // renders itself away unless a paint tool is armed.
          { id: "brush", edge: "right", align: "center", node: <StageBrushHandle /> },
        ]}
      />

      {/* Per-layer contextual actions, floating ON the layer they act on —
          the other half of the chrome model (StageChrome docks; this anchors). */}
      <SelectionCallout insets={rulersOn ? { top: RULER_SIZE, left: RULER_SIZE } : undefined} />

      {/* What an AI job is working on, shown on the layer itself. */}
      <AiWorkOverlay />

      <EyedropperOverlay canvasRef={canvasRef} />
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuTarget.kind === "clip" && <ClipMenuItems store={store} />}
        {menuTarget.kind === "frame" && <FrameMenuItems store={store} frameId={menuTarget.frameId} />}
        {menuTarget.kind === "empty" && <EmptyAreaMenuItems store={store} />}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Apply a dragged library card to an existing clip.
 *
 * An ANIMATION preset lands at LAYER grain on ANY visual clip — shapes, images,
 * video, nested comps and text alike. It used to write the per-GLYPH spec and
 * therefore silently did nothing on everything that isn't text, which is why
 * "animate this layer" only ever animated letters. Glyph animation remains
 * reachable, but from the text-scoped control that says so.
 */

/**
 * The transform-scale half of a NATIVE-geometry resize (shape / text). Geometry
 * stays a positive magnitude, so a drag that crossed its own anchor is expressed
 * as a NEGATED scale on that axis — the one representation of a mirrored layer
 * (see core `resize.ts`). Returns null while nothing has flipped since the last
 * write, which is every frame of an ordinary resize.
 *
 * A mirror on ONE axis is precisely what `scaleY: null` (uniform) cannot say —
 * negating a uniform scale reads as a 180° rotation — so the pair materializes
 * whenever the signs part ways, and collapses back to null when they agree again.
 */
function takeMirror(
  g: {
    resizeStartScale: number;
    resizeStartScaleY: number;
    resizeScaleYWasNull: boolean;
    resizeMirrorX: 1 | -1;
    resizeMirrorY: 1 | -1;
  },
  box: ResizeBox,
  f: ResizeFactors,
): { scale: number; scaleY: number | null } | null {
  // An EDGE handle pins its axis: it can never cross an anchor it isn't moving
  // toward, so it must not inherit a mirror from the aspect-locked partner.
  const mx = box.sx !== 0 ? resizeSign(f.fx) : 1;
  const my = box.sy !== 0 ? resizeSign(f.fy) : 1;
  if (mx === g.resizeMirrorX && my === g.resizeMirrorY) return null;
  g.resizeMirrorX = mx;
  g.resizeMirrorY = my;
  const scale = mirrorScale(g.resizeStartScale, mx);
  const scaleY = mirrorScale(g.resizeStartScaleY, my);
  return { scale, scaleY: g.resizeScaleYWasNull && scale === scaleY ? null : scaleY };
}

/**
 * World → the space the resize is being measured in. One call, so the pointer,
 * the box centre and the pivot can never be read against different rectangles.
 */
function resizeToLayerSpace(
  g: { resizeSpace: { fromWorld: (p: { x: number; y: number }) => { x: number; y: number } } | null },
  w: { x: number; y: number },
): { x: number; y: number } {
  return g.resizeSpace ? g.resizeSpace.fromWorld(w) : w;
}

/**
 * The gesture's start pose, in the shape core's `resizePosition` asks for. The
 * gesture state is flat (it is written field by field at the press); this is the
 * one place it is read back as the pose it describes, so no branch of the resize
 * can assemble a different one.
 */
function resizeStartPose(g: {
  resizeStartX: number;
  resizeStartY: number;
  resizeStartScale: number;
  resizeStartScaleY: number;
  resizeRot: number;
  resizeSkewX: number;
  resizeSkewY: number;
  resizeAnchor: AnchorPoint;
  resizeStartSize: LayerBox;
}): ResizePose {
  return {
    x: g.resizeStartX,
    y: g.resizeStartY,
    scale: g.resizeStartScale,
    scaleY: g.resizeStartScaleY,
    rotation: g.resizeRot,
    skewX: g.resizeSkewX,
    skewY: g.resizeSkewY,
    anchor: g.resizeAnchor,
    size: g.resizeStartSize,
  };
}

/** Write a `takeMirror` result onto a clip (keyframing it when recording). */
function writeMirror(
  clip: Clip,
  m: { scale: number; scaleY: number | null },
  playheadMs: number,
): void {
  if (clip.kind === "audio") return;
  writeAnimatable(clip, "scale", m.scale, playheadMs, (c) => {
    if (c.kind !== "audio") c.transform.scale = m.scale;
  });
  if (m.scaleY === null) {
    clip.transform.scaleY = null;
    return;
  }
  const sy = m.scaleY;
  writeAnimatable(clip, "scaleY", sy, playheadMs, (c) => {
    if (c.kind !== "audio") c.transform.scaleY = sy;
  });
}

/** Transform pose (x/y/scale/rotation) for any clip — box clips (nested,
 *  image, video) have no style, so they sample their transform directly;
 *  audio has no pose. */
interface StagePose {
  x: number;
  y: number;
  scale: number;
  scaleY: number;
  rotation: number;
  skewX: number;
  skewY: number;
  /** Sampled PIVOT (normalized to the layer's box) — see core `transform-map`. */
  anchor: AnchorPoint;
}

/** The layer's placement at `localMs` — core's one sampler (`pivotPoseAt`). */
function clipPose(clip: Clip, localMs: number): StagePose {
  return pivotPoseAt(clip, localMs);
}

/** Effective (keyframe-sampled) width/height of a shape at a local time. */
function shapeSizeAt(clip: ShapeClip, localMs: number): { width: number; height: number } {
  const kf = sampleKeyframes(clip.keyframes, localMs);
  const n = (k: string, d: number) => (typeof kf[k] === "number" ? (kf[k] as number) : d);
  return { width: Math.max(1, n("width", clip.width)), height: Math.max(1, n("height", clip.height)) };
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/**
 * The rectangle a shape-draw gesture defines (world units): dragged from `a`
 * (the anchor) to `b` (the pointer), with ⇧ locking a 1:1 square and ⌥ making
 * `a` the CENTER so the shape grows symmetrically. Pure — both the live preview
 * and the commit call it, so they can never disagree.
 */
function shapeDrawRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  square: boolean,
  fromCenter: boolean,
): { cx: number; cy: number; w: number; h: number } {
  let w = Math.abs(b.x - a.x);
  let h = Math.abs(b.y - a.y);
  if (fromCenter) {
    // Anchor is the center; the pointer marks a corner → the full extent is 2×.
    if (square) w = h = Math.max(w, h);
    return { cx: a.x, cy: a.y, w: w * 2, h: h * 2 };
  }
  if (square) {
    const s = Math.max(w, h);
    // Grow the square toward the pointer from the anchored start corner.
    const cx = a.x + Math.sign(b.x - a.x || 1) * (s / 2);
    const cy = a.y + Math.sign(b.y - a.y || 1) * (s / 2);
    return { cx, cy, w: s, h: s };
  }
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, w, h };
}

function normRect(a: { x: number; y: number }, b: { x: number; y: number }) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function worldToScreen(w: { x: number; y: number }, view: { scale: number; tx: number; ty: number }) {
  return { x: view.tx + w.x * view.scale, y: view.ty + w.y * view.scale };
}

/** Gradient-handle accent — Figma's blue, distinct from the shape-tool accents. */
const GRAD_ACCENT = "#0d99ff";

/** A crisp white line with a dark halo (readable over any artwork). */
function strokeHaloLine(ctx: CanvasRenderingContext2D, path: () => void) {
  ctx.lineCap = "round";
  ctx.beginPath();
  path();
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/**
 * Paint the gradient handle rig in screen space: the axis (a ring too, for
 * radial), the two endpoint knobs, and a colored dot per stop. All sizes are
 * fixed screen px so the rig reads the same at any zoom.
 */
function drawGradientOverlay(
  ctx: CanvasRenderingContext2D,
  model: GradientHandleModel,
  view: { scale: number; tx: number; ty: number },
  activeStopId: string | null,
  resolve: (c: string) => string,
) {
  const s = worldToScreen(model.start, view);
  const e = worldToScreen(model.end, view);
  ctx.save();

  // Radial shows its extent as a ring centered on the start knob.
  if (model.type === "radial") {
    const r = Math.hypot(e.x - s.x, e.y - s.y);
    strokeHaloLine(ctx, () => ctx.arc(s.x, s.y, r, 0, Math.PI * 2));
  }
  // The axis line (linear/angular direction; radial radius).
  strokeHaloLine(ctx, () => {
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(e.x, e.y);
  });

  // Stop dots ride the axis, filled with their own color.
  for (const st of model.stops) {
    const p = worldToScreen(st.at, view);
    const active = st.id === activeStopId;
    ctx.beginPath();
    ctx.arc(p.x, p.y, active ? 6 : 5, 0, Math.PI * 2);
    ctx.fillStyle = resolve(st.color);
    ctx.strokeStyle = active ? GRAD_ACCENT : "#fff";
    ctx.lineWidth = active ? 2.5 : 2;
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 3;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
  }

  // Endpoint knobs on top — each shows the color of its end stop (Figma), ringed
  // in the accent so it reads as a control, not just a swatch.
  const sorted = model.stops;
  const knob = (p: { x: number; y: number }, color: string) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3;
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 4;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    // Thin accent ring outside the white for the control affordance.
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8.5, 0, Math.PI * 2);
    ctx.strokeStyle = GRAD_ACCENT;
    ctx.lineWidth = 1.25;
    ctx.stroke();
  };
  knob(s, resolve(sorted[0]?.color ?? "#ffffff"));
  knob(e, resolve(sorted[sorted.length - 1]?.color ?? "#ffffff"));
  ctx.restore();
}

/** Resolve a paint keyframe-prefix (`fill.<id>` / `stroke.<id>`) to its base paint on any visual clip. */
function paintOfPrefix(clip: Clip, prefix: string): Paint | undefined {
  if (clip.kind === "audio") return undefined;
  const m = /^(fill|stroke)\.(.+)$/.exec(prefix);
  if (!m) return undefined;
  return m[1] === "fill" ? clip.fills.find((f) => f.id === m[2]) : clip.strokes.find((s) => s.id === m[2])?.paint;
}

/** The layer's primary gradient paint (first gradient fill, then stroke) — what
 *  the on-stage handles default to when no paint editor popover is open. */
function firstGradientRef(clip: Clip): { target: "fill" | "stroke"; id: string } | null {
  if (clip.kind === "audio") return null;
  const fill = clip.fills.find((f) => isGradientPaint(f));
  if (fill) return { target: "fill", id: fill.id };
  const stroke = clip.strokes.find((s) => isGradientPaint(s.paint));
  if (stroke) return { target: "stroke", id: stroke.id };
  return null;
}

function pointInRotatedRect(
  p: { x: number; y: number },
  h: ClipHitRect,
  slop: number,
): boolean {
  const rad = (-h.rotation * Math.PI) / 180;
  const dx = p.x - h.cx;
  const dy = p.y - h.cy;
  const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
  // Undo the shear (T·R·K·S) so the test is a plain box in pre-shear local space.
  const l = unshearPoint(rx, ry, h.skewX, h.skewY);
  return Math.abs(l.x) <= h.width / 2 + slop && Math.abs(l.y) <= h.height / 2 + slop;
}

function rotatedCorners(h: ClipHitRect): Array<{ x: number; y: number }> {
  const rad = (h.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = h.width / 2;
  const hh = h.height / 2;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ].map((c) => {
    // Corner rides shear → rotate → translate (the K·… of T·R·K·S; scale is in hw/hh).
    const s = shearPoint(c.x, c.y, h.skewX, h.skewY);
    return { x: h.cx + s.x * cos - s.y * sin, y: h.cy + s.x * sin + s.y * cos };
  });
}

function rotatedRectIntersectsScreenRect(
  h: ClipHitRect,
  r: { x: number; y: number; w: number; h: number },
  view: { scale: number; tx: number; ty: number },
): boolean {
  const corners = rotatedCorners(h).map((c) => worldToScreen(c, view));
  const minX = Math.min(...corners.map((c) => c.x));
  const maxX = Math.max(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const maxY = Math.max(...corners.map((c) => c.y));
  return minX <= r.x + r.w && maxX >= r.x && minY <= r.y + r.h && maxY >= r.y;
}

/** Axis-aligned world box (center + half-extents). */
interface GroupBox {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

/** Axis-aligned world union of several clips' rendered (rotated) hit boxes. */
function selectionGroupBox(ids: string[], hits: ClipHitRect[]): GroupBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let n = 0;
  for (const id of ids) {
    const h = hits.find((x) => x.clipId === id);
    if (!h) continue;
    for (const c of rotatedCorners(h)) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    }
    n++;
  }
  if (n === 0 || !Number.isFinite(minX)) return null;
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    hw: Math.max(1, (maxX - minX) / 2),
    hh: Math.max(1, (maxY - minY) / 2),
  };
}

/** Screen positions of a group box's 4 corner handles (nw, ne, se, sw). */
function groupHandleCenters(
  box: GroupBox,
  view: { scale: number; tx: number; ty: number },
): Array<{ x: number; y: number }> {
  const cx = view.tx + box.cx * view.scale;
  const cy = view.ty + box.cy * view.scale;
  const hw = box.hw * view.scale;
  const hh = box.hh * view.scale;
  return [
    { x: cx - hw, y: cy - hh },
    { x: cx + hw, y: cy - hh },
    { x: cx + hw, y: cy + hh },
    { x: cx - hw, y: cy + hh },
  ];
}

function selectionHandleCenters(
  h: ClipHitRect,
  view: { scale: number; tx: number; ty: number },
): Array<{ x: number; y: number }> {
  const rad = (h.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = view.tx + h.cx * view.scale;
  const cy = view.ty + h.cy * view.scale;
  // Handles sit exactly on the corners — the box hugs the layer bounds (no pad).
  const hw = (h.width * view.scale) / 2;
  const hh = (h.height * view.scale) / 2;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ].map((c) => {
    const s = shearPoint(c.x, c.y, h.skewX, h.skewY);
    return { x: cx + s.x * cos - s.y * sin, y: cy + s.x * sin + s.y * cos };
  });
}

/**
 * The crop-mode verb badge: the armed gesture bright, the alternative dimmed
 * behind its modifier key. Both halves always show, so the swap is something you
 * can SEE before you ever press ⌥ — the modifier teaches itself.
 */
function drawCropVerbBadge(
  ctx: CanvasRenderingContext2D,
  corners: Array<{ x: number; y: number }>,
  verb: CropVerb,
): void {
  const cx = corners.reduce((a, c) => a + c.x, 0) / corners.length;
  const bottom = Math.max(...corners.map((c) => c.y));
  const armed = CROP_VERB_LABEL[verb];
  // The SECOND half of the badge is whatever the modifiers do here. Pan and
  // reframe are opposites, so ⌥ trades them; a resize and a turn have no
  // opposite, so ⌥ and ⇧ do what they do everywhere else in the app and the
  // badge says so rather than going blank.
  const other =
    verb === "crop-zoom"
      ? "⇧ lock aspect · ⌥ from centre"
      : verb === "crop-rotate"
        ? "⇧ snap 15°"
        : verb === "crop-content"
          ? "⌥ Reframe crop"
          : "⌥ Move image";
  ctx.save();
  ctx.font = `500 10px ${sceneInk().codeFont}`;
  const wArmed = ctx.measureText(armed).width;
  const wOther = other ? ctx.measureText(other).width : 0;
  const padX = 8;
  const gap = other ? 10 : 0;
  const w = padX * 2 + wArmed + gap + wOther;
  const x = cx - w / 2;
  const y = bottom + 14;
  // Dark plate first so the badge survives on any artwork, in any theme.
  ctx.fillStyle = "rgba(14,14,18,0.86)";
  roundedFill(ctx, x, y, w, 20, 6);
  ctx.textBaseline = "middle";
  ctx.fillStyle = sceneInk().accent;
  ctx.fillText(armed, x + padX, y + 10.5);
  if (other) {
    ctx.fillStyle = "rgba(255,255,255,0.42)";
    ctx.fillText(other, x + padX + wArmed + gap, y + 10.5);
  }
  ctx.restore();
}

function roundedFill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

/** Live overlay readout: size while resizing, position while moving, or none. */
type SelectionReadout = { kind: "size" } | { kind: "pos"; x: number; y: number } | null;

function drawSelection(
  ctx: CanvasRenderingContext2D,
  hit: ClipHitRect,
  view: { scale: number; tx: number; ty: number },
  withHandles: boolean,
  readout: SelectionReadout = null,
  dashed: boolean = false,
) {
  const cx = view.tx + hit.cx * view.scale;
  const cy = view.ty + hit.cy * view.scale;
  const w = hit.width * view.scale;
  const h = hit.height * view.scale;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((hit.rotation * Math.PI) / 180);
  // Shear the box into a parallelogram (T·R·K·S) so the outline hugs a skewed
  // layer exactly. Grab-dots draw AFTER restoring the shear so they stay round.
  const corner = (sx: number, sy: number) => shearPoint((sx * w) / 2, (sy * h) / 2, hit.skewX, hit.skewY);
  const quad = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  // Dashed = native geometry-resize affordance (shapes/text); solid = object
  // scale. Only the box dashes — the grips stay solid. The box hugs the
  // layer's true bounds exactly (no padding), so it lines up with the smart
  // guides and the layer edge. The context is turned with the box, so the
  // square grips turn with it (Figma).
  strokeOutline(ctx, quad, dashed ? [5, 4] : undefined);
  if (withHandles) for (const c of quad) drawGrip(ctx, c.x, c.y);

  // Readout pill under the selection — only while dragging (position) or
  // resizing (size), so nothing clutters the canvas at rest.
  if (readout) {
    const label =
      readout.kind === "size"
        ? `${Math.round(hit.width)} × ${Math.round(hit.height)}`
        : `${Math.round(readout.x)}, ${Math.round(readout.y)}`;
    drawReadout(ctx, label, 0, h / 2 + 12);
  }
  ctx.restore();
}

/** The open effect card as a focus, when it sits on a selected layer's own stack. */
function stageEffectFocus(doc: MotionDocument, selected: readonly string[], effectId: string | null): EffectFocus | null {
  if (!effectId || selected.length === 0) return null;
  const ids = new Set(selected);
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (ids.has(c.id) && c.kind !== "audio" && c.effects.some((fx) => fx.id === effectId)) return { clipId: c.id, effectId };
    }
  }
  return null;
}

/** How far a link click may travel and still be a click, screen px. */
const LINK_CLICK_SLOP_PX = 4;
/** The link marker: its glyph (stage px), how far a press may miss it, and below what line height it hides. */
const LINK_MARKER_PX = 11;
const LINK_MARKER_HIT_PX = 9;
const LINK_MARKER_MIN_LINE_PX = 7;

interface DrawnLinkMarker {
  x: number;
  y: number;
  marker: LinkMarker;
}

/** Lucide's `link`, 24-unit box. */
let linkGlyph: Path2D[] | null = null;
const linkGlyphPaths = () =>
  (linkGlyph ??= [
    new Path2D("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"),
    new Path2D("M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"),
  ]);

/**
 * One quiet chain per link: above the end of a text run's last line (where
 * a reader looks for "this goes somewhere"), or just off a linked layer's
 * top-right corner. A dark halo keeps it legible on any artwork;
 * the hovered one takes the accent. Returns where each was drawn.
 */
function drawLinkMarkers(ctx: CanvasRenderingContext2D, markers: readonly LinkMarker[], view: { scale: number; tx: number; ty: number }, hover: LinkUnderPoint | null): DrawnLinkMarker[] {
  const drawn: DrawnLinkMarker[] = [];
  const accent = accentColor();
  const k = LINK_MARKER_PX / 24;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const m of markers) {
    const last = m.areas[m.areas.length - 1]!;
    const lineH = Math.hypot(last[2].x - last[1].x, last[2].y - last[1].y) * view.scale;
    if (m.span && lineH < LINK_MARKER_MIN_LINE_PX) continue;
    // The area's own axes, so a rotated layer's marker rides with it: `along`
    // runs with the text, `up` points out of its top edge.
    const unit = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
    };
    const along = unit(last[0], last[1]);
    const up = unit(last[2], last[1]);
    const half = LINK_MARKER_PX / 2;
    // A run: sitting on the line's top edge, flush with its last letter — never
    // over the next word. A layer: just off its top-right corner.
    const a = m.span ? -half : half + 3;
    const u = half + (m.span ? 1 : 3);
    const x = view.tx + m.at.x * view.scale + along.x * a + up.x * u;
    const y = view.ty + m.at.y * view.scale + along.y * a + up.y * u;
    const lit = !!hover && hover.clipId === m.clipId && hover.span?.start === m.span?.start;
    ctx.save();
    ctx.translate(x - LINK_MARKER_PX / 2, y - LINK_MARKER_PX / 2);
    ctx.scale(k, k);
    for (const path of linkGlyphPaths()) {
      ctx.strokeStyle = "rgba(10,10,12,0.55)";
      ctx.lineWidth = 6;
      ctx.stroke(path);
      ctx.strokeStyle = lit ? accent : "rgba(255,255,255,0.82)";
      ctx.lineWidth = 2.4;
      ctx.stroke(path);
    }
    ctx.restore();
    drawn.push({ x, y, marker: m });
  }
  ctx.restore();
  return drawn;
}

function sameLinkHover(a: LinkUnderPoint | null, b: LinkUnderPoint | null): boolean {
  if (!a || !b) return a === b;
  return a.clipId === b.clipId && a.span?.start === b.span?.start && a.areas.length === b.areas.length && a.areas.every((q, i) => q[0].x === b.areas[i]![0].x && q[0].y === b.areas[i]![0].y);
}

/** A link's area under the pointer: its line boxes (or its layer's box), outlined in the accent. */
function drawLinkHover(ctx: CanvasRenderingContext2D, areas: readonly Quad[], view: { scale: number; tx: number; ty: number }): void {
  ctx.save();
  const accent = accentColor();
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  ctx.lineWidth = 1.5;
  for (const q of areas) {
    ctx.beginPath();
    q.forEach((pt, i) => {
      const x = view.tx + pt.x * view.scale;
      const y = view.ty + pt.y * view.scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.globalAlpha = 0.08;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
  }
  ctx.restore();
}
