"use client";
import { onWorldEngineReady, worldEngine } from "../../world/loader";
import { planePicture } from "../../world/plane-picture";
import { affineFromTriangle, drawTexturedRegion, drawTexturedTriangle } from "./texture-mesh";
// Side effect: hands core the silhouette a rig weights by (see the module).
import "./rig-coverage";
import "../../physics/outline-reader";
import "../../speech/speech-host";
import { defaultCameraDistance, flatLayerMatrix, layerDepthAt, projectFlat, transformPoint, type LayerDepth } from "@solomotion/core";
import { compHasScreenUnits, lengthFrameOf, type LengthView } from "@solomotion/core";
import { bend2d, clipsUnderGroup, documentHasRigs, gridCells, hiddenBySwitch, pointInfluence, skinPoint, unitSkin2d, warpedVectorClip, type Bend2d } from "@solomotion/core";

import {
  glyphDirection,
  nestedClipsContent,
  compPictureDeps,
  captionTravelAt,
  clipLocalTime,
  clipRenderLocalTime,
  caretAt,
  effectiveText,
  type ResolvedTextStyle,
  type TextEffect,
  type ResolvedTextEffect,
  type ScopeOverlay,
  resolveTextEffect,
  textEffectPath,
  effectiveRanges,
  overlayTouchesPaints,
  resolveLook,
  styleAt,
  evaluateClipPose,
  evaluateTextGlyphs,
  loopSpanMs,
  paintWithSampled,
  parseColorVarToken,
  resolvePaint,
  variableValueNow,
  buildPatternTile,
  patternNoiseAt,
  resolveTextStyle,
  pathCommands,
  resolveShapeGeometry,
  sampleKeyframes,
  sampledScaleY,
  segmentTextCached,
  shapeCommands,
  shapeLocalBounds,
  frameLayerTree,
  resolveAdjustmentTargets,
  setVariableClock,
  setExpressionContext,
  peekExpressionContext,
  withExpressionLayer,
  getVariableClock,
  sourceTimeAt,
  subpathBounds,
  trackLocalTime,
  buildStrokePlan,
  needsSampling,
  strokeIsVisible,
  resolveStrokeAt,
  clipRevealAt,
  inkedOutlineAt,
  flattenCommands,
  filterCss,
  type FilterOp,
  strokeStyle,
  type ClipReveal,
  type AdjustmentClip,
  type BlendMode,
  type ClipLayerNode,
  type LayerTreeNode,
  type ClipPlayback,
  type ClipPose,
  type Frame,
  type GroupMode,
  type GroupClip,
  type GroupLayerNode,
  type ImageClip,
  type MeshClip,
  type CameraClip,
  type LightClip,
  type EmptyClip,
  type KeyframeValue,
  type NestedClip,
  type CornerRadius,
  type ContentTransform,
  type CropInsets,
  type MediaPaint,
  type Paint,
  type PatternSpec,
  type PathClip,
  type PathCommand,
  type RasterClip,
  type ShapeClip,
  type StrokeStyle,
  type StyleRange,
  type Subpath,
  type TextClip,
  type TextHighlight,
  type MotionDocument,
  type VideoClip,
  type VisualClip,
  type WaveformClip,
  type WaveformStyle,
  type TraceClip,
  evaluateTrace,
  traceBounds,
  traceColorAt,
  traceLookAt,
  traceSourceOf,
  type TraceState,
  quantizeMsToFrame,
  frameEvalTimeMs,
  frameFps,
  LFX,
  clipByIdIn,
  clipRowIn,
  frameClipEntries,
  linkSpans,
} from "@solomotion/core";
import {
  IDENTITY_RESOLVER,
  makeColorResolver,
  paintStyle,
  patternCanvasStyle,
  type ColorResolver,
  type PaintBounds,
} from "./paint-style";
import { groupShowingKey, groupSilhouette } from "./group-silhouette";
import { layoutNudgeAt } from "./layout-motion";
import {
  acquireLayerCanvas,
  enterKeptUnit,
  invalidateLayerCache,
  invalidateLayersShowing,
  layerCacheAdmits,
  layerCacheReadable,
  noteLayerCost,
  readLayerCache,
  readLayerCacheCovering,
  readStackPrefix,
  storeStackPrefix,
} from "./layer-cache";
import {
  compFps,
  compSteadyKey,
  createFrameLedger,
  frameStepMs,
  type PictureFill,
  layerBlendsThrough,
  layerBufferSegment,
  placedSourceOf,
  layerShowsFootage,
  stackPrefixAt,
  steadyStackPrefix,
  teeProfiler,
} from "@solomotion/core";
import { isCachingEnabled } from "../../cache/cache-status";
import { type CachedFrame, readFrame, storeFrame, withPictureSize } from "./frame-store";
import { GLYPH_IDENTITY, composePoses, isIdentityPose, layerPoseAt, shearPoint, type GlyphVisual } from "@solomotion/core";
import { NO_CONTENT, NO_CROP } from "@solomotion/core";
import { effectGroupPlan } from "@solomotion/core";
import { entityRef, reportError, withSubject, type EntityRef } from "@solomotion/core";
// The shutter (v56). The measure/plan halves are pure core; only the pixels are here.
import {
  boundsSpan,
  frameCentre,
  layerRegionPad,
  quadBounds,
  quadMotion,
  regionRect,
  resolveMotionBlur,
  locateClip,
  bakeClipAt,
  bakeSourceOf,
  flatParticles,
  flatParticleView,
  viewParticles,
  viewsParticles,
  activeCameraAt,
  evaluateWorld,
  DEFAULT_CLIP_MOTION_BLUR,
  shutterWeight,
  resolveShutter,
  shutterQuads,
  shutterWindow,
  cutShutterAtSteps,
  type MotionBlurPolicy,
  type Quad,
  type RenderProfiler,
} from "@solomotion/core";
import { paintParticles } from "./particles";
import { paintShutter, placementBetween, shutterDisplacements } from "./motion-blur";
import { DRAFT_LAYER_BUFFER_PX, MAX_LAYER_BUFFER_PX, WINDOW_MARGINS, seenWindow, shutterSeenRect, viewOverscanPx, type Affine2d } from "@solomotion/core";
import {
  layerEffectPath,
  activeAt,
  anyActiveAt,
  layerEffectCarves,
  pixelCount,
  ENABLED_FIELD,
  layerEffectTypeDef,
  resolveEffectValues,
  filmDamageIsNoop,
  glassIsNoop,
  grainIsNoop,
  noiseIsNoop,
  resolveFilmDamageParams,
  layerEffectReadsBackdrop,
  resolveGlassParams,
  resolveGrainParams,
  resolveNoiseParams,
  resolveSurfaceParams,
  surfaceIsNoop,
  resolveScanlineParams,
  scanlinesIsNoop,
  lightningIsNoop,
  resolveLightningParams,
  type LightningOutline,
  resolveTemporalStep,
  ownClockSec,
  sweepAt,
  type LayerEffect,
  type LayerEffectType,
  type Modulator,
} from "@solomotion/core";
import {
  activeTransitionAt,
  defaultVeilColor,
  getTransitionPreset,
  isSeparableMix,
  transitionMediaShortfall,
  transitionMixAt,
  transitionParticipants,
  type Clip,
  type Track,
  type Transition,
  type TransitionMixOp,
  type WipeSpec,
} from "@solomotion/core";
import { captureStateAt, captureSurface, captureTrack, hostPolylinesAt, pathGeometryAt } from "@solomotion/core";
import {
  getImageForAsset,
  videoFrameForClip,
  clipSourceMs,
  animatedImageFrameAt,
  animatedImageFrameAtRaw,
  sequenceFrameForClip,
  sequencePicture,
  animatedImageDurationMs,
  drewFootageSince,
  faithfulSince,
  isAnimatedImageMime,
  pictureFaults,
  replayPicture,
  markTransientPicture,
  notifyPicturesChanged,
} from "./media-cache";
import { glyphCommandsIfReady } from "../../export/text-outline";
import { clipAtInstant, exprLayerFor, frameInstanceScope, instanceScope, makeExprContext, resolvedDocAt, scopeCacheKey, type InstanceScope } from "@solomotion/core";
import { onPathExtent, planTextOnPath, type OnPathPlan } from "./text-on-path";
import { pathTextSlides, pathTextTravel } from "@solomotion/core";
import { compContentRevision, heardGeneration } from "@solomotion/core";
import { surfaceCanvas, wetFilmCanvas } from "../../drawing/raster-store";
import { chromaKeyedFrame, sourceFrameKey, type ChromaKeyParams } from "./chroma-key";
import { colorGradedFrame, type ColorGradeParams } from "./color-grade";
import { resolveGradeProgram, setGradeFrameEnv, type GradeProgram } from "./grade-stage";
import { runGradeProgram } from "./grade-runner";
import { applyEffectPass } from "./passes/registry";
import { passNeedsBackdrop, type DepthSampler, type LfxPass, type PassEnv } from "./passes/types";
import { blurTo } from "./gaussian";
import { hasCanvasFilter } from "./capabilities";
import { drawBlurred, drawFiltered, paintFiltered } from "./canvas-filter";
import { parseColor } from "@/lib/color";
import {
  anchorLocal,
  inverseLayerMatrix,
  layerMatrix,
  apply as applyMat,
  clipBox,
  layerContentRefs,
  groupBoxAt,
  groupDeltaMatrix,
  groupPivotPlaced,
  groupNeedsIsolation,
  groupTintFills,
  cropWindow,
  contentExtent,
  contentIsIdentity,
  mapContent,
  contentScaleY,
  contourOverlay,
  hasContourOverrides,
  resolveContourStyle,
  hopMatrix,
  hopPoseAtLocal,
  mapLocal,
  invert as matInvert,
  footageMatrix,
  depthForClip,
  nearnessAt,
  multiply as matMultiply,
  rotation as matRotation,
  scaling as matScaling,
  snapRectToPixels,
  translation as matTranslate,
  type AnchorPoint,
  type AnimationUnit,
  type LayerBasis,
  type LayerBox,
  type Mat2D,
} from "@solomotion/core";
import { readSoundAnalysis, styleBinCount, visualizerBars } from "@solomotion/core";
import { paintWaveform } from "../../audio/waveform-visuals";
import { boxWidthOf, fauxBoldOutset, layoutOverridesFor, layoutTextClip, fontString, highlightBounds, highlightPills, paintedRunRules, spanPill, type HighlightPill, samePose, textInkBounds, unitPivotsX, type GlyphAnim, type LaidGlyph, type LayoutOverrides, type TextLayout } from "./text-layout";

/**
 * The single draw path. Stage preview, PNG, PNG-sequence, MP4 and WebM export
 * all render one frame's content through drawFrameContent with the ctx origin
 * at the frame's top-left — identical output everywhere by construction.
 */

/**
 * One line of a text LINK, as fractions of its hit rect's local box (−0.5…0.5
 * on each axis, centre 0). Fractions, so the rect's own trip through nesting,
 * capture and world space carries it unchanged. `start`/`end` are the link
 * span's graphemes (ADR-links).
 */
export interface LinkRun {
  start: number;
  end: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface ClipHitRect {
  /** A text's link runs, when it has any. See `LinkRun`. */
  linkRuns?: LinkRun[];
  clipId: string;
  frameId: string;
  /**
   * The frame whose render produced this rect — normally the clip's own frame,
   * but for a LINKED INSTANCE frame it's that instance (while `frameId` stays the
   * shared master). Lets selection/gizmos land on the instance you clicked when
   * the same master clip is painted in several instance frames at once.
   */
  hostFrameId: string;
  /** Anchor center in world coords (frame offset included). */
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotation: number;
  /** Pseudo-3D shear (deg), applied post-scale/pre-rotation — the K in T·R·K·S. */
  skewX: number;
  skewY: number;
  /**
   * How many nested comps deep this layer was painted. 0 = it lives in a frame
   * the stage is showing directly.
   *
   * Depth is what lets a nested comp's layers have a world box WITHOUT becoming
   * click targets: a plain click and a marquee take depth 0 only (Figma's rule —
   * one click selects the outermost thing), while the selection gizmo, the
   * colour picker and smart focus take any depth, so a piece of artwork selected
   * in the Layers panel gets its box drawn on the canvas without the timeline
   * moving. Before this, the only way to reach an inner layer's geometry was to
   * navigate into its comp.
   */
  depth: number;
}

/**
 * How a nested draw's rects get back into WORLD space. A nested scene paints in
 * its own local coordinates, so its rects are mapped up through the chain of
 * clip poses that placed it — the SAME `hopMatrix` the edit context uses, which
 * is what makes an inner layer's gizmo land exactly where its pixels are.
 *
 * Scale and rotation accumulate so the rect keeps a true size and angle. Skew is
 * carried from the innermost layer only: a hit rect is a box, and two skews at
 * different levels do not compose into one — an honest approximation for a
 * selection box, and the only lossy step in the chain.
 */
export interface HitSpace {
  /** Nested-local → world. */
  m: Mat2D;
  scaleX: number;
  scaleY: number;
  rotation: number;
  depth: number;
}

/**
 * Push a rect through the current hit space. Every rect in the renderer goes
 * through here, so "where is this layer in the world" has one answer whether the
 * layer is on the artboard, inside a transformed group, or four comps down.
 *
 * ONE COORDINATE CONVENTION: a rect is pushed in the coordinates of the FRAME
 * being drawn, and the space maps it to world. It used to be world already at
 * the top level (the frame's page offset added inside `layerCenter`) and
 * frame-local deeper down — two conventions, and a group's transform is a
 * frame-local delta that could only be composed into one of them. The top level
 * now carries a space of its own (`rootHitSpace`), which is the whole reason a
 * group can place what it holds.
 */
function pushHitRect(options: DrawOptions, rect: Omit<ClipHitRect, "depth">): void {
  const list = options.hitRects;
  if (!list || matteDepth > 0) return;
  // EVERY LAYER BEING CACHED AROUND THIS RECT RECORDS IT — see
  // `hitCaptures`. Each relative to its own base, because the space carries
  // the board's page offset and the group chain's delta, neither of which is
  // part of what makes the PIXELS reusable. Replaying a rect through whatever
  // space is current keeps one coordinate convention and lets a cached layer
  // move around the board without its click target going stale.
  for (const c of hitCaptures) c.rects.push(relativeToCaptureBase(rect, c.base, options._hitSpace));
  const space = options._hitSpace;
  if (!space) {
    list.push({ ...rect, depth: 0 });
    return;
  }
  const c = applyMat(space.m, { x: rect.cx, y: rect.cy });
  list.push({
    ...rect,
    cx: c.x,
    cy: c.y,
    width: Math.abs(rect.width * space.scaleX),
    height: Math.abs(rect.height * space.scaleY),
    rotation: rect.rotation + space.rotation,
    depth: space.depth,
  });
}

/**
 * A rect expressed relative to the capture base: what the cached layer's own
 * drawing added to it, with everything OUTSIDE the layer removed.
 *
 * Identity for a leaf, because there the base IS the current space. The group's
 * delta for a member drawn inside a cached group — which is the whole point. A
 * non-invertible space (a group scaled flat to zero) falls back to the raw
 * rect: that is the previous behaviour, and a degenerate layer has nothing
 * clickable anyway.
 */
function relativeToCaptureBase(
  rect: Omit<ClipHitRect, "depth">,
  base: HitSpace | null,
  space: HitSpace | undefined,
): Omit<ClipHitRect, "depth"> {
  if (!base || !space || base === space) return rect;
  const baseInv = matInvert(base.m);
  if (!baseInv) return rect;
  const rel = matMultiply(baseInv, space.m);
  const c = applyMat(rel, { x: rect.cx, y: rect.cy });
  const sx = space.scaleX / (base.scaleX || 1);
  const sy = space.scaleY / (base.scaleY || 1);
  return {
    ...rect,
    cx: c.x,
    cy: c.y,
    width: Math.abs(rect.width * sx),
    height: Math.abs(rect.height * sy),
    rotation: rect.rotation + (space.rotation - base.rotation),
  };
}

/**
 * A hit rect's extent along one axis: the local size times the scale MAGNITUDE,
 * floored so a hairline layer stays grabbable. Magnitude, because a mirrored
 * layer carries a negative scale (see core `resize.ts`) and a selection box is a
 * size, not a direction — the flip lives in the render matrix, and letting it
 * leak here would collapse every mirrored layer to the floor value.
 */
function hitExtent(local: number, scale: number, floor: number): number {
  return Math.max(Math.abs(local * scale), floor);
}

/**
 * Apply the layer's pseudo-3D shear to the canvas: call between `ctx.rotate` and
 * `ctx.scale` so the composited map is T·R·K·S (matches `shearPoint` in core and
 * the hit-test / export). A no-op when both angles are 0 (the common case).
 */
export function applySkewToCtx(ctx: CanvasRenderingContext2D, skewX: number, skewY: number): void {
  if (skewX === 0 && skewY === 0) return;
  ctx.transform(1, Math.tan((skewY * Math.PI) / 180), Math.tan((skewX * Math.PI) / 180), 1, 0, 0);
}

export interface DrawOptions {
  /**
   * Which side of the artboard this pass paints — see `OverflowPass`. Set only
   * by the stage, and only for the frame you are working in, so it can show the
   * spill dimmed. Absent everywhere else, EXPORT ABOVE ALL: the output
   * rectangle is the frame, and what reaches past it has never been in it.
   */
  overflowPass?: OverflowPass;
  /** Clip being inline-edited — skipped so the DOM overlay replaces it. */
  skipClipId?: string | null;
  /**
   * Clips that own their END instant — the selection, while paused. See core
   * `clipRenderLocalTime`. The stage's alone: export never sets it.
   */
  clipEnds?: ReadonlySet<string> | null;
  /** Filled with clip bounds (topmost last) for stage hit-testing. */
  hitRects?: ClipHitRect[];
  /**
   * Set by `nestedOptions` when descending into a nested comp: how to map that
   * comp's rects back into world space. Absent at the top level, where
   * `worldOffset` has already placed them. @see HitSpace
   */
  _hitSpace?: HitSpace;
  /** Added to hit rect centers (the frame's world position on the stage). */
  worldOffset?: { x: number; y: number };
  /**
   * The frame currently being painted — stamped on every hit rect as
   * `hostFrameId`. Defaults to each clip's own frame; the stage sets it per frame
   * so a linked instance frame's rects are tagged with the instance (not the
   * shared master). Threads unchanged into nested draws.
   */
  hostFrameId?: string;
  /**
   * Layer-scoped rendering (export a layer/group/selection): only these clip
   * ids draw. A composite group (union/subtract/…/mask) renders as a unit only
   * when EVERY member is included — a partial pick draws its members flat, so
   * exporting one layer out of a mask never applies half a mask.
   */
  only?: ReadonlySet<string> | null;
  /**
   * THIS DRAW IS A SLICE LAID ONTO A COMPOSITE THAT ALREADY HOLDS THE REST.
   *
   * `only` has two meanings, and conflating them is a bug: an export of one
   * layer means "the document is only these clips", while the drag fast path's
   * live pass means "paint only these clips — everything else is already on the
   * canvas". A MATERIAL is where the difference shows: its backdrop is the
   * whole scene beneath it either way, so narrowing the scene-beneath by `only`
   * (right for an export) leaves a dragged pane of glass refracting nothing.
   *
   * Set by the stage's sandwich filling, and by nothing else.
   */
  _onComposite?: boolean;
  /**
   * Draw hidden clips too (the adjustment MATTE pass sets this). A tracked mask
   * uses a hidden shape as its silhouette: invisible on the main composite, but
   * its alpha still shapes the grade — an After-Effects track matte. Only ever
   * set alongside `only`, so it can't leak hidden layers into the real frame.
   */
  includeHidden?: boolean;
  /**
   * This render does not PAINT the frame box — no background fill, no border.
   * An alpha export, a boardless drag slice, a layer-scoped patch, a hit-rect
   * probe. The frame's "Clip content" still applies: whether the artboard is
   * painted is a fact about the render, whether content crops is a fact about
   * the frame, and bundling the two cost an alpha export its crop.
   *
   * It is a fact about the RENDER, never a note that somebody else already
   * painted the background. That distinction is not pedantry: it was the bug.
   * The exporter used to fill the artboard colour itself and then pass
   * "skipBackground", and `sceneBeneath` — which asks the DOCUMENT what is
   * under a layer, not the canvas — read that as "this frame has no
   * background". So every material in every export refracted an empty buffer:
   * liquid glass came back opaque with only its rim, on the stage it was
   * correct, and the two never agreed. Anything that paints must paint through
   * `drawFrameContent`, so `transparent` stays the single source of truth.
   */
  transparent?: boolean;
  /**
   * THE SETTLING BUDGET — the stage's. Once `spent`, a layer whose buffer is
   * missing ONLY because the camera moved (another zoom, another window of a
   * magnified layer) shows the best picture it has (`readLayerCacheCovering`),
   * scaled into the same frame-space rect, calls `defer` (the stage renders
   * again once the camera is still) and marks the picture transient so nothing
   * keeps the soft stand-in. Zooming into a page of boiled hills re-rendered
   * every one at the new resolution in the tick the camera settled — seconds;
   * now it sharpens a budget's worth per tick.
   *
   * Spent for as long as the camera is MOVING — parked or playing: a draft
   * while you navigate, the true picture when you stop. Never set for an
   * export or a retained picture.
   */
  settle?: { spent(): boolean; defer(): void; /** The camera is in motion: draft whatever has no picture. */ moving?: boolean } | null;
  /**
   * THE FILL BUDGET — the stage's, in LIVE playback only. A nested comp whose
   * picture is missing is made only while the frame can afford it, in turns;
   * otherwise its nearest kept picture stands in, transient (see
   * `drawCompPicture`). Never set for an exact run, a build or an export —
   * those make every picture they need.
   */
  pictureFill?: PictureFill | null;
  /**
   * Is the transport running? Read by the `#playing` expression global, and only
   * ever true for the live stage — an export is a render, not a playback, so
   * leaving it false there is the honest answer rather than an oversight.
   */
  playing?: boolean;
  /**
   * Footage is playing LIVE on screen (real-time playback, outside a kept run):
   * pictures made from footage are neither read from nor written to the layer
   * cache — see `playbackRegime`. Set by the stage; absent everywhere else.
   */
  footageLive?: boolean;
  /**
   * A pass run for GEOMETRY only (click targets): nothing it draws is a
   * picture anyone sees, so it neither reads nor keeps cached pixels.
   */
  measureOnly?: boolean;
  /**
   * The clip in on-stage CROP mode: its box painter draws the FULL media dimmed
   * (so the cropped-away region is visible while you edit) plus the crop region
   * crisp on top. Stage-only — never set during export, so a real render always
   * shows the clean cropped result.
   */
  cropPreviewClipId?: string | null;
  /**
   * THE CARD UNDER EDIT — one effect on one layer that someone is tuning.
   *
   * It changes no pixel on its own. It moves WHERE THE STACK SPLITS: every card
   * beneath it is a constant for as long as you tune, so that prefix is kept
   * (`stackPrefixAt`, validated across edits above it by
   * `stackPrefixUnchanged`) and a slider drag re-runs only this card and the
   * ones above. The stage sets it from the open effect editor; the editor's
   * preview sets it too, so both surfaces cut the stack in the same place.
   *
   * `leadMs` advances THIS CARD's clock (and the cards above it, which consume
   * its output) without moving document time — the preview lets grain and a
   * shine breathe while the picture stays on the playhead. It used to be a
   * global offset handed to every layer in the comp, which gave every layer a
   * new cache key per tick: the preview missed the layer cache for the whole
   * scene sixty times a second and flooded it with pictures of the frozen
   * layers at instants nobody would ask for, evicting the stage's own.
   * A separate offset rather than a later time, because document time decides
   * which clips exist and where footage is.
   */
  effectFocus?: EffectFocus | null;
  /**
   * Render the ROOT comp on this rate instead of its own — the export dialog's
   * frame-rate override, and nothing else.
   *
   * Deliberately root-only: a nested comp keeps its own rate no matter what the
   * render is being stepped at, because that is the whole nesting rule (a 12fps
   * sheet inside a 60fps comp is still on twelves). Rendering a 24fps comp at
   * 60 with this set genuinely samples at 60 — the comp bends to the export
   * rather than holding — which is what "override" has to mean to be useful.
   */
  fpsOverride?: number | null;
  /**
   * THE RASTER SCALE (v57) — document px per frame px for every RASTERISED
   * step: layer effects, materials, feather.
   *
   * It is a fact about the RENDER, never about the viewport. The stage never
   * sets it, because stage zoom is not a property of the document: an effect
   * that rasterises at the zoom level renders a different picture at every zoom
   * — a different grain pattern, a different film-damage roll, a glass rim that
   * shears once the browser's blur clamp bites — and none of them is the
   * picture that exports. The exporter sets it to its output scale, so a 2×
   * render rasterises at 2× and stays sharp.
   *
   * Vector work (paths, text, strokes, the isolation buffer of a layer with no
   * pixel effects) still draws at DEVICE resolution and stays crisp at any
   * zoom. Only the pixel pipeline is pinned here, which is exactly the part
   * that has no resolution-independent meaning.
   */
  renderScale?: number;
  /**
   * IS THIS RENDER A DELIVERABLE? Explicit, because the alternative was
   * inferring it from `renderScale` being set at all — and that inference is
   * what made a preview quality tier impossible to implement honestly.
   *
   * The stage has to be able to lower the raster scale: `renderScale` is what
   * REGIONAL effects (goo, glass, grain, damage — everything that reads a
   * neighbour) rasterise at, so a preview tier that cannot touch it does not
   * reduce the cost of the only layers that are ever expensive. It reduces
   * nothing and adds a bigger downscale on the way out, which is how dropping
   * to Quarter ended up SLOWER than Full — the exact opposite of the point.
   *
   * So the two facts are separated: `renderScale` says how many document
   * pixels per frame pixel, and this says whether the result is going in a
   * file. Caches key off THIS, never off the number.
   */
  exporting?: boolean;
  /**
   * Set while rendering the SCENE BENEATH a material (see `sceneBeneath`). A
   * material inside that render does not ask for a scene of its own — it reads
   * the backdrop buffer as far as it has been painted. Glass behind glass is
   * one refraction deep, which is what a compositor does and the only version
   * that terminates.
   * @internal
   */
  _inBackdrop?: boolean;
  /**
   * THE SHUTTER POLICY (v56) — how much motion blur this SURFACE is willing to
   * pay for. The third level of the three-level model (layer switch × comp
   * master × render setting), and the only one not stored in the document,
   * because it is a fact about the machine you are sitting at.
   *
   * Absent means off, which is the honest default for every incidental draw
   * this renderer serves — posters, thumbnails, hit-rect probes, the effect
   * editor's A/B preview. Those want to know what a layer IS, not what it looks
   * like mid-flight, and a blurred thumbnail is a worse thumbnail.
   */
  motionBlur?: MotionBlurPolicy;
  /**
   * Per-layer cost attribution. Null/absent costs one check per layer; set, it
   * is two `performance.now()` calls. Threads into nested draws, which is
   * exactly where a surprising cost usually hides.
   */
  profiler?: RenderProfiler | null;
  /**
   * The PIXEL SCALE this frame is being rendered at — the preview quality tier,
   * as a fraction of full resolution. 1 unless the stage has dropped a tier.
   *
   * Reported, never obeyed: nothing in here reads it to draw differently. It
   * exists so the profiler can normalise what a layer cost (the work is
   * per-pixel, so a quarter-tier frame is a sixteenth of the bill) and a cost
   * readout therefore means one stable thing while the governor moves the tier
   * underneath it. The tier itself is applied by the stage, as the canvas
   * backing store's DPR — NEVER as `renderScale`, which is the document's own
   * raster scale and would re-roll every effect that has a clock.
   */
  previewScale?: number;
  /**
   * Filled by `withLayer` with the id of every layer the LAYER CACHE served
   * rather than redrew, so the per-layer profile can say "cached" instead of
   * reporting a blit as this layer's price and making the heaviest thing in the
   * document vanish from the list at the moment it got cheap to show.
   *
   * A set on the options rather than a module flag: the cache read happens
   * several frames down the stack from the bracket that reads it, and a hidden
   * global would be wrong the first time a nested comp rendered inside one.
   */
  cacheHits?: Set<string>;
  /**
   * Internal: an ANCESTOR is already re-rendering this subtree across its own
   * shutter (`content` tier). A descendant must not then blur again — its
   * motion is already being integrated, so doing it twice would both
   * double-smear the picture and multiply the cost by the two sample counts.
   * The outermost content-tier sampler owns its whole subtree.
   */
  _inContentShutter?: boolean;
  /**
   * Internal: the COMP time the layer being painted was reached at. A group's
   * region is measured from what its members paint at this instant, and the
   * members are on the comp's clock, not the group's local one.
   */
  _compTimeMs?: number;
  /**
   * Internal: the INSTANCE CHAIN this comp is drawn through — pushed by a
   * nested instance (`instanceScope`) or a linked instance frame, read by the
   * bake (`input:<id>`, `input()`), and part of every picture-cache key below
   * it (`scopeCacheKey`). Threads into nested draws unchanged.
   */
  _scope?: InstanceScope | null;
  /**
   * Internal: the frame whose BOX (fills/border/clip) is painted under these
   * layers, when that is not the frame the layers belong to.
   *
   * A LINKED INSTANCE frame paints its own box around its MASTER's layers, so
   * the two differ exactly there — and a material inside the master has to
   * refract the instance's background, not the master's.
   * @internal
   */
  _boxFrame?: Frame;
  /** Internal: the frame ids currently on the render stack (nested-clip cycle guard). */
  _nestGuard?: Set<string>;
  /**
   * Internal: HOW THIS COMP IS SEEN — output px per comp px and the output's
   * size (core `LengthView`). The root is its own output; each nest multiplies
   * in its layer's scale (`nestedView`). The bake reads it for screen units
   * (`spx`, `vw`…), so a 2 spx line is two output px at any nest depth or zoom.
   * The stage zoom and `renderScale` are never in it: they magnify the output.
   */
  _view?: LengthView;
}

/** See `DrawOptions.effectFocus`. */
export interface EffectFocus {
  clipId: string;
  effectId: string;
  /** How far this card's clock runs ahead of document time. */
  leadMs?: number;
}

/** The effect clock's lead for this layer — zero for every layer but the focus. */
function focusLead(options: DrawOptions, clipId: string): number {
  const f = options.effectFocus;
  return f && f.clipId === clipId ? (f.leadMs ?? 0) : 0;
}

/**
 * The options a NESTED comp draws under.
 *
 * This used to be a hand-written whitelist at the recursion site — it passed
 * `_nestGuard` and `skipClipId` and dropped everything else on the floor. That
 * shape is wrong in the way that only shows up later: every option added since
 * was silently lost at the first comp boundary, including three whose own doc
 * comments promised they threaded. Motion blur simply vanished the moment a
 * layer was precomposed; `playing`, `effectTimeOffsetMs` and `profiler` were
 * already quietly broken the same way and nobody had looked.
 *
 * So it is written as a SUBTRACTION instead. A new option inherits by default
 * and has to opt OUT here, which is the safe direction to be wrong in: the
 * failure mode becomes "this crossed a boundary it shouldn't have", which is
 * visible, rather than "this stopped working two levels down", which is not.
 *
 * The four that must reset, and why:
 *
 *  - `hitRects` / `worldOffset` / `hostFrameId` — the parent's coordinate
 *    space. A nested scene registers no hit rects of its own.
 *  - `only` / `_onComposite` / `includeHidden` — a layer-scoped draw names clips
 *    in the PARENT. Threading it down would filter out every inner layer and
 *    render the comp empty, so a one-layer export of a nested clip would come
 *    back blank — and a slice's "the rest is already painted" is a claim about
 *    the parent's canvas, not about the comp's own buffer.
 *  - `transparent` / `_boxFrame` — the nested comp paints its own frame box.
 *  - `overflowPass`, for a WINDOWED comp (`nestedClipsContent`) — which side of
 *    the ROOT's edge this pass paints. That comp is a picture in its layer's
 *    window whatever pass its host is on: handed "outside", it painted only its
 *    own spill and no paper. A comp that never crops keeps the pass it had.
 *  - `fpsOverride` — root-only by contract: a 12fps sheet inside a 60fps comp
 *    stays on twelves no matter what rate the export is being stepped at.
 */
function nestedOptions(
  options: DrawOptions,
  childGuard: Set<string>,
  hitSpace: HitSpace | undefined,
  windowed: boolean,
): DrawOptions {
  const {
    worldOffset: _worldOffset,
    hostFrameId: _hostFrameId,
    only: _only,
    _onComposite: _onComposite,
    includeHidden: _includeHidden,
    transparent: _transparent,
    _boxFrame: _boxFrame,
    fpsOverride: _fpsOverride,
    ...inherited
  } = options;
  if (windowed) delete inherited.overflowPass;
  // `hitRects` now DOES thread through, mapped by `hitSpace` — that is the whole
  // of "a piece of a vector has a world box without being navigated to". Without
  // a space to map by (a backdrop probe, a layer-scoped patch) it is dropped,
  // because an unmapped rect is a rect in the wrong coordinate system.
  return { ...inherited, hitRects: hitSpace ? inherited.hitRects : undefined, _hitSpace: hitSpace, _nestGuard: childGuard };
}

/**
 * THE FRAME'S OWN BOX — its fills, its border and its content clip, painted with
 * the ctx origin at the frame's top-left.
 *
 * Extracted because it has two callers that MUST agree: the frame render itself,
 * and `sceneBeneath` — the backdrop a material refracts. They disagreed for a
 * release: this one painted the fill list (gradients, blend modes, a border),
 * the backdrop painted a single flat `frame.background` and only when it felt
 * like it, so glass over a gradient artboard refracted the wrong colour and
 * glass in an export refracted nothing at all.
 *
 * "What is under the layers" is one question. It gets one answer.
 */
function paintFrameBox(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  resolve: ColorResolver,
  options?: DrawOptions,
): void {
  // The SPILL pass paints no board: the artboard's fill and border belong to
  // the artboard, and painting them again outside it would draw a second,
  // ghosted frame around the first.
  if (options?.overflowPass === "outside") {
    clipToFrameBox(ctx, frame, "outside");
    return;
  }
  // Unified paint: a frame's `fills` (solid/gradient, ordered) paint the
  // background through the SAME painter as every layer; empty = the legacy
  // flat `background` color.
  const bg: PaintBounds = { x: 0, y: 0, w: frame.width, h: frame.height };
  // The paper ends on the pixel grid, like the clip below it (`gridRect`).
  const paper = gridRect(ctx, 0, 0, frame.width, frame.height);
  if (frame.fills.length === 0) {
    ctx.fillStyle = resolve(frame.background);
    ctx.fillRect(paper.x, paper.y, paper.width, paper.height);
  } else {
    for (const f of frame.fills) {
      if (f.opacity <= 0.001) continue;
      ctx.save();
      ctx.globalAlpha *= f.opacity;
      ctx.globalCompositeOperation = COMPOSITE[f.blendMode];
      ctx.fillStyle = paintStyle(ctx, f, bg, resolve);
      ctx.fillRect(paper.x, paper.y, paper.width, paper.height);
      ctx.restore();
    }
  }
  // Frame border — the unified stroke list over the artboard rect, through the
  // SAME painter every other stroke uses, so a frame's border gets dash
  // offsets, trims and tapers exactly like a shape's does. Inside-aligned, so
  // it sits within the bounds like Figma's frame stroke.
  if (frame.strokes.length > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, frame.width, frame.height);
    ctx.clip();
    paintStrokes(ctx, boxOutlineCommands(bg, ZERO_RADIUS), frame.strokes, resolve, bg, null);
    ctx.restore();
  }
  clipToFrameBox(ctx, frame, options?.overflowPass);
}

/**
 * WHICH SIDE OF THE ARTBOARD THIS PASS PAINTS.
 *
 * `inside` clips to the box, `outside` clips to everything BUT the box. They
 * are the two halves of showing a frame's SPILL: the stage paints the content
 * once inside at full strength and once outside at `frame.overflow`, so the
 * artwork you drew off the edge is visibly there and visibly outside.
 *
 * Absent = the frame's own rule. `overflow: 0` clips; anything else does not,
 * which is exactly what the old `clipContent` boolean did on both its settings.
 */
export type OverflowPass = "inside" | "outside";

/** Does this frame hide everything past its edge? (`overflow` of zero.) */
export function frameClips(frame: Pick<Frame, "overflow">): boolean {
  return frame.overflow <= 0;
}

/**
 * Clip to the frame's box — or to everything outside it, for the spill pass.
 *
 * SEPARATE FROM THE PAINT, because they are separate facts. Whether the
 * artboard's fill lands is a fact about this RENDER (`DrawOptions.transparent`
 * — an alpha export, a boardless slice); whether content crops is a fact about
 * the FRAME. Bundling them meant every transparent render also lost the crop,
 * so an alpha export of a clip-content frame spilled past its own edges.
 */
function clipToFrameBox(ctx: CanvasRenderingContext2D, frame: Frame, pass?: OverflowPass): void {
  if (pass === "outside") {
    // Everything except the box: a very large rect with the box punched out of
    // it, even-odd. The outer rect is deliberately far larger than any canvas —
    // this runs in the frame's own coordinates and artwork may be anywhere.
    // The hole is the SAME grid rect the inside pass clips to, so the two
    // halves meet without a hairline gap or a double-painted row.
    const far = 1e6;
    const r = gridRect(ctx, 0, 0, frame.width, frame.height);
    ctx.beginPath();
    ctx.rect(-far, -far, far * 2, far * 2);
    ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip("evenodd");
    return;
  }
  if (pass !== "inside" && !frameClips(frame)) return;
  const r = gridRect(ctx, 0, 0, frame.width, frame.height);
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.width, r.height);
  ctx.clip();
}

/**
 * A box edge ON THE PIXEL GRID of the canvas as it is transformed right now —
 * core's `snapRectToPixels`, fed the live matrix.
 *
 * Every edge that layers END AT goes through here: the artboard's paper and its
 * clip, a layer's crop window, a nested comp's window. Anti-aliased separately,
 * two layers sharing an edge leave `a·(1−a)` of whatever is under them on the
 * pixel the edge half-covers — a comp's dark paper showed through the light
 * ground laid over it as a line along the top and bottom of every scaled scene
 * in a reel, pulsing as an animated scale slid the edge through sub-pixel
 * positions. On the grid, coverage there is all or nothing, so nothing inside
 * can seam. Under rotation there is no grid and the rect is returned as is.
 */
function gridRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
  return snapRectToPixels(ctx.getTransform(), { x, y, width, height });
}

/**
 * Draw one frame's content (background + its clips) with the ctx origin at
 * the frame's top-left. This is the export contract.
 */
export function drawFrameContent(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  options: DrawOptions = {},
): void {
  ctx.save();

  // ── THE RENDER CLOCK ──────────────────────────────────────────────────────
  // A comp renders ON ITS OWN FRAME GRID. Every instant inside a frame resolves
  // to that frame's start, so a 2fps comp genuinely plays on twos rather than
  // interpolating smoothly at monitor rate and making its rate a lie.
  //
  // Quantizing HERE is what makes the whole per-frame model real, because this
  // one function is the render contract: the stage, the exporter, thumbnails
  // and — via the nested recursion below — every child comp all pass through
  // it. A nested comp recurses with ITS OWN frame, so it quantizes to its own
  // rate: a 12fps flipbook inside a 60fps comp holds each drawing for ~83ms
  // while the parent moves every ~17ms, with nothing anywhere negotiating
  // between the two.
  //
  // The override applies to the root draw only (see `fpsOverride`), so an
  // export can re-rate the comp it is rendering without re-rating its children.
  // The colour page's windows read trackers through core's one reader, which
  // needs the document. Published once per draw and read only during this
  // synchronous walk (see `grade-stage.setGradeFrameEnv`).
  setGradeFrameEnv({ doc });

  const isRootDraw = options._nestGuard === undefined;
  const renderFps = (isRootDraw ? options.fpsOverride : null) ?? frameFps(doc, frame);
  // …and a STATIC frame answers every time with its still (`frameEvalTimeMs`
  // is the render clock for both rules — see core timeline/fps).
  timeMs = frameEvalTimeMs(doc, frame, timeMs, renderFps);

  // ── THE RESOLVED DOCUMENT ────────────────────────────────────────────────
  // Every driven property is baked into its clip's own slot BEFORE anything is
  // painted, so from here down there is no such thing as a driver: `clip.x` is
  // where the layer is, full stop. This replaced an overlay applied at each
  // sampling site, which only the code that remembered to sample through it
  // could see — the transform moved and the hit rectangle, the corner-radius
  // grips and the inspector field stayed where the layer used to be.
  //
  // Resolved PER COMP, at that comp's own time: a nested comp recurses into this
  // function with its own frame and source time and gets its own bake, so a
  // layer inside a 12fps sheet is driven on the sheet's clock and not the
  // parent's. `resolvedDocAt` normalises back to the raw document first, so the
  // recursion cannot bake a bake.
  // Ancestor frames on the render stack — nested clips referencing one are cut
  // to break cycles.
  const guard = options._nestGuard ?? new Set<string>([frame.id]);

  // Frame-level component instancing: a LINKED INSTANCE frame (`instanceOf`)
  // owns no content — it renders its MASTER's layers in place. Its own box
  // (background/size/clip) still applies, so it looks like a normal frame, but
  // the layers it paints are the master's SHARED clips: editing them updates the
  // master and every instance frame at once. `guard` breaks any instanceOf cycle.
  //
  // Resolved BEFORE the bake, because the bake is of the CONTENT frame: baked
  // under the instance frame's own id (which holds no clips), every driver on
  // the master's layers was ignored here. A linked frame also opens its
  // master's input scope with its own static overrides.
  const master = frame.instanceOf ? doc.frames.find((f) => f.id === frame.instanceOf) : undefined;
  const contentFrame = master && !guard.has(master.id) ? master : frame;
  if (contentFrame !== frame) guard.add(contentFrame.id);
  const outerScope = options._scope ?? null;
  const scope = contentFrame !== frame ? frameInstanceScope(doc, frame, timeMs, outerScope) : outerScope;
  if (scope !== outerScope) options = { ...options, _scope: scope };
  const view = options._view ?? { scale: 1, width: frame.width, height: frame.height };
  if (options._view !== view) options = { ...options, _view: view };
  doc = resolvedDocAt(doc, timeMs, contentFrame.id, options.playing === true, scope, view);

  // The raster scale for this draw tree (see `DrawOptions.renderScale`). Held
  // module-scoped: the whole synchronous
  // draw — nested comps included, which inherit it — shares one value, and
  // threading a constant through every painter buys nothing. Saved/restored so
  // a nested draw cannot leak a different scale back to its parent.
  const prevRasterScale = rasterScale;
  rasterScale = Math.max(0.05, options.renderScale ?? 1);
  // …and the device px one ROOT comp px lands at: the stage's zoom × DPR, or
  // the export's scale. Everything a layer is magnified by past this is the
  // document's own doing (a scaled group, a scaled nest) — see `seenScale`.
  const prevRootDeviceScale = rootDeviceScale;
  if (isRootDraw) {
    const m0 = ctx.getTransform();
    rootDeviceScale = Math.max(1e-6, (Math.hypot(m0.a, m0.b) + Math.hypot(m0.c, m0.d)) / 2);
  }

  // Expression globals for THIS comp. Unlike variables (doc-global, set once at
  // the root) `#comp.width` and `#time` are facts about the comp being painted,
  // so the context is set per draw and restored after — a nested comp must not
  // leak its geometry onto the layers the parent still has to paint. Skipped
  // entirely when the document holds no expressions (the common case, zero cost).
  const prevExprCtx = peekExpressionContext();
  const hasExpressions = doc.expressions.length > 0;
  if (hasExpressions) {
    setExpressionContext(makeExprContext(doc, timeMs, contentFrame.id, options.playing === true, null, scope));
  }

  // Keyframed VARIABLES resolve at an ambient clock (the document playhead), like
  // the driver env — but they are doc-GLOBAL, so the clock is set once at the ROOT
  // draw and left for the whole subtree (nested comps drawn at their own source
  // time still read variables on the global timeline). Save/restore so re-entrant
  // draws (thumbnails, export) don't leak a stale clock. (`isRootDraw` is
  // computed above, where the render clock is quantized.)
  const prevVarClock = isRootDraw ? getVariableClock() : null;
  if (isRootDraw) setVariableClock(timeMs);

  // WHICH COMPS THIS COMPOSITE WALKED. One call, here, at the one function
  // every comp — root, nested, component master — is drawn through, so the
  // frame cache learns that a precomp three levels down contributed to it
  // without anybody maintaining a map of who nests whom.
  options.profiler?.comp(frame.id);

  // Color variables resolve at the paint boundary — one map per draw call.
  const resolve = makeColorResolver(doc);
  // THE ROOT HIT SPACE — frame-local → world for the frame the stage is
  // painting. Established here so every rect below is pushed in one coordinate
  // system, whatever it sits inside (see `pushHitRect`).
  if (options.hitRects && !options._hitSpace) {
    const off = options.worldOffset ?? { x: 0, y: 0 };
    options = { ...options, _hitSpace: { m: matTranslate(off.x, off.y), scaleX: 1, scaleY: 1, rotation: 0, depth: 0 } };
  }

  // The light matte holds lights only — a comp's paper is not one.
  if (options.transparent || lightPass === "only") clipToFrameBox(ctx, frame, options.overflowPass);
  else paintFrameBox(ctx, frame, resolve, options);
  // A linked instance paints ITS box around the master's layers, so a material
  // down there refracts the instance's background (see `_boxFrame`).
  if (contentFrame !== frame) options = { ...options, _boxFrame: frame };

  // A WORLD comp's layers are a 3D scene: its picture is the engine's render
  // through the live camera, laid over the box the comp's own paint just
  // filled (the world's backdrop IS the frame's paint). This one branch is how
  // the board, nested worlds, posters, the frame cache and every exporter draw
  // 3D without knowing it exists. See docs/adr/ADR-3d.md.
  if (contentFrame.world) {
    // A world's BACKPLATE (the footage a camera solve came from) is painted
    // flat first, by the very painter a flat comp uses — its time map,
    // effects and placement exactly as on the plate — and the 3D picture,
    // transparent where nothing stands, is laid over it.
    const plates = frameLayerTree(doc, contentFrame.id).filter((n) => n.type === "clip" && "backplate" in n.clip && n.clip.backplate);
    if (plates.length) paintLayerNodes(ctx, doc, contentFrame, plates, timeMs, options, resolve, guard);
    drawWorldPicture(ctx, doc, contentFrame, timeMs, options);
  } else {
  // Paint the frame's LAYER TREE bottom→top — the same recursive structure
  // the layers panel shows, from the one core brain (`frameLayerTree`). Plain
  // groups pass through flat; composite groups (union/subtract/…/mask) isolate
  // and combine their children as finished units, so a union nested inside a
  // subtract composites exactly as the list reads, at any depth.
  const tree = frameLayerTree(doc, contentFrame.id);
  // THE SPILL PASS PAINTS ONLY WHAT SPILLS: see `staysInsideBox`. At the root
  // only — a nested comp's own box is not the box this pass is cut to.
  const nodes = isRootDraw && options.overflowPass === "outside" ? tree.filter((n) => !staysInsideBox(ctx, doc, contentFrame, n, timeMs, options)) : tree;
  paintLayerNodes(ctx, doc, contentFrame, nodes, timeMs, options, resolve, guard);
  }

  // Adjustment post-pass: layers with reach "all" grade the WHOLE frame,
  // ignoring their own z-position (`runFramePostPass`). Skipped under a
  // layer-scoped export (`only`) — that isolates one layer, not global grades.
  if (!options.only) runFramePostPass(ctx, doc, contentFrame, timeMs, options, resolve, guard);

  if (hasExpressions) setExpressionContext(prevExprCtx);
  if (isRootDraw) setVariableClock(prevVarClock);
  rasterScale = prevRasterScale;
  rootDeviceScale = prevRootDeviceScale;
  ctx.restore();
}

/**
 * THE FRAME'S POST-PASS — every whole-comp processor (`reach: "all"`, a comp's
 * Frame effects among them) grading the finished frame, bottom→top (highest
 * track index first) so several chain like nodes, whatever their z-position.
 *
 * `until`: stop BEFORE that processor. What a whole-comp processor reads is
 * exactly the picture this leaves on the canvas — every layer, then the
 * processors before it — so `paintBeneath` runs it with `until` to paint that
 * picture from the document. One function, so the two cannot disagree.
 */
function runFramePostPass(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  contentFrame: Frame,
  timeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
  until?: string,
): void {
  const alls: Array<{ clip: AdjustmentClip; trackIndex: number }> = [];
  for (const { clip: c, row: trackIndex } of frameClipEntries(doc, contentFrame.id)) {
    if (c.kind === "adjustment" && c.scope.reach === "all") alls.push({ clip: c, trackIndex });
  }
  alls.sort((a, b) => b.trackIndex - a.trackIndex);
  for (const { clip, trackIndex } of alls) {
    if (clip.id === until) return;
    const node: ClipLayerNode = { type: "clip", clip, trackIndex };
    const tt = clipNodeTime(doc, contentFrame, node, timeMs, options);
    if (tt === null) continue;
    const local = clipLocalTime(clip, tt);
    if (local === null) continue;
    // A cut over a frame-wide grade is resolved HERE, through the same
    // `renderTransition` the walk uses — the post-pass, not the walk, owns
    // when these clips paint. The live-participant gate above is what keeps
    // the pair painted ONCE: at any instant exactly one side is inside its
    // own span, and that side paints both.
    const track = doc.tracks[trackIndex];
    const active = track ? activeTransitionAt(track, contentFrame.id, tt) : null;
    if (
      track &&
      active &&
      (active.transition.aClipId === clip.id || active.transition.bClipId === clip.id)
    ) {
      renderTransition(
        ctx, doc, contentFrame, track, active.transition, active.progress, tt, timeMs, options, resolve, guard,
      );
      continue;
    }
    renderAdjustment(
      ctx, doc, contentFrame, clip, local, timeMs, resolve, options, guard, layerAnimMix(clip, local),
    );
  }
}

/**
 * The last picture of each world comp at each size it is drawn — its own
 * canvas (the engine's is shared and reused) — most recent last, a few kept.
 */
const worldPictures = new Map<string, { key: string; world: Frame["world"]; expressions: MotionDocument["expressions"]; canvas: HTMLCanvasElement }>();
const WORLD_PICTURES_KEPT = 8;

function keepWorldPicture(slot: string, frame: Frame, doc: MotionDocument, key: string, pic: HTMLCanvasElement): void {
  const prev = worldPictures.get(slot);
  worldPictures.delete(slot);
  while (worldPictures.size >= WORLD_PICTURES_KEPT) worldPictures.delete(worldPictures.keys().next().value!);
  const canvas = prev?.canvas ?? document.createElement("canvas");
  if (canvas.width !== pic.width) canvas.width = pic.width;
  if (canvas.height !== pic.height) canvas.height = pic.height;
  const c = canvas.getContext("2d");
  if (!c) return;
  c.clearRect(0, 0, canvas.width, canvas.height);
  c.drawImage(pic, 0, 0);
  worldPictures.set(slot, { key, world: frame.world, expressions: doc.expressions, canvas });
}

/**
 * A world comp's picture, drawn into the 2D composite at the resolution the
 * canvas is actually showing it. Until the engine chunk has arrived the box
 * stays as its paint left it, the picture is marked transient (no cache may
 * keep it) and the chunk is requested; its arrival redraws everything.
 */
function drawWorldPicture(ctx: CanvasRenderingContext2D, doc: MotionDocument, frame: Frame, timeMs: number, options: DrawOptions): void {
  if (options.measureOnly) return;
  const engine = worldEngine();
  if (!engine) {
    // `worldEngine()` has asked for the chunk; its arrival redraws.
    markTransientPicture();
    return;
  }
  const m = ctx.getTransform();
  const scale = Math.max(0.05, Math.hypot(m.a, m.b));
  // EFFECTS ON ONE OBJECT: a mesh with its own effect stack is left out of the
  // picture, then drawn alone (everything in front of it still hides it) and
  // run through the SAME stack a 2D layer uses — glow, blur, shadow, grade.
  const withFx = doc.tracks.flatMap((t) => (t.hidden ? [] : t.clips)).filter(
    (c): c is MeshClip => c.frameId === frame.id && c.kind === "mesh" && !c.hidden && c.effects.some((e) => e.enabled) && clipLocalTime(c, timeMs) !== null,
  );
  const base = {
    doc,
    frame,
    timeMs,
    width: frame.width * scale,
    height: frame.height * scale,
    density: Math.min(3, Math.max(0.5, scale * 1.5)),
  };
  const shutter = worldShutter(doc, frame, timeMs, options.motionBlur);
  // The same world at the same instant and size is the same picture: a board
  // repaint for something ELSE (a drag on another comp's lane, a selection)
  // draws the one it has instead of a full 3D render — and the shared
  // renderer is not resized back and forth between the board and a tile.
  const plain = !withFx.length && !shutter;
  // One per comp AND size: the board draws a world at its picture tier and at the live zoom.
  const slot = `${frame.id}|${Math.round(base.width)}x${Math.round(base.height)}|${base.density}`;
  const key = plain ? `${compContentRevision(doc, frame.id)}|${heardGeneration()}|${timeMs}` : "";
  const kept = plain ? worldPictures.get(slot) : undefined;
  if (kept && kept.key === key && kept.world === frame.world && kept.expressions === doc.expressions) {
    worldPictures.delete(slot);
    worldPictures.set(slot, kept);
    ctx.drawImage(kept.canvas, 0, 0, frame.width, frame.height);
    return;
  }
  const pic = engine.renderPicture({ ...base, ...(withFx.length && { hide: withFx.map((c) => c.id) }), ...(shutter && { shutter }) });
  if (pic) ctx.drawImage(pic, 0, 0, frame.width, frame.height);
  if (pic && plain) keepWorldPicture(slot, frame, doc, key, pic);
  if (!withFx.length) return;
  const resolve = makeColorResolver(doc);
  for (const clip of withFx) {
    const local = clipLocalTime(clip, timeMs)!;
    const obj = engine.renderPicture({ ...base, only: clip.id });
    if (!obj) continue;
    // Synchronous, so the shared picture canvas still holds this object for every draw the stack makes.
    applyLayerEffects(ctx, clip, sampleKeyframes(clip.keyframes, local), local, resolve, (t) => t.drawImage(obj, 0, 0, frame.width, frame.height));
  }
}

onWorldEngineReady(notifyPicturesChanged);

/**
 * A WORLD'S SHUTTER — the live camera is the world's lens, so its motion blur
 * (or, with no camera, the world comp's own) decides the window, through the
 * same `resolveMotionBlur` and weighting a flat layer uses, inside the policy's
 * budget (a parked or exporting stage spends more than a playing one). A shot
 * where nothing moves across the window costs one render, not twelve.
 */
function worldShutter(doc: MotionDocument, frame: Frame, timeMs: number, policy: MotionBlurPolicy | undefined): Array<{ timeMs: number; weight: number }> | undefined {
  if (!policy || policy.kind === "off" || !frame.motionBlur.enabled) return undefined;
  const camId = activeCameraAt(doc, frame, timeMs);
  const cam = camId ? locateClip(doc, camId)?.clip : null;
  const subject = (cam ?? { motionBlur: DEFAULT_CLIP_MOTION_BLUR, keyframes: [], effects: [] }) as Parameters<typeof resolveMotionBlur>[1];
  const resolved = resolveMotionBlur(frame, subject, policy, cam ? (clipLocalTime(cam, timeMs) ?? 0) : 0);
  if (!resolved) return undefined;
  const { settings } = resolved;
  const interval = 1000 / frameFps(doc, frame);
  const win = shutterWindow(interval, timeMs, settings);
  // `amount` stretches the window about its middle, as it stretches a flat layer's smear.
  const mid = (win.openMs + win.closeMs) / 2;
  const half = ((win.closeMs - win.openMs) / 2) * Math.max(0, settings.amount);
  const openMs = mid - half, closeMs = mid + half;
  if (closeMs - openMs < 0.5) return undefined;
  const travel = worldTravel(doc, frame, openMs, closeMs, timeMs);
  if (travel <= 0) return undefined;
  // As many instants as the motion needs (a sample every few units of
  // travel — 1 unit is 1 px at the default camera), inside the budget.
  const n = Math.max(2, Math.min(policy.kind === "full" ? 24 : 4, resolved.maxSamples * (policy.kind === "full" ? 2 : 1), Math.ceil(travel / 6)));
  const samples = Array.from({ length: n }, (_, i) => {
    const u = (i + 0.5) / n;
    return { timeMs: openMs + u * (closeMs - openMs), weight: Math.max(0, shutterWeight(settings.weighting, u, settings.curve)) };
  });
  const total = samples.reduce((a, b) => a + b.weight, 0) || 1;
  for (const x of samples) x.weight /= total;
  return samples;
}

/**
 * How far the world moves between two instants, in units — the largest
 * travel of any object or the camera (a turn counts as travel at a 100-unit
 * arm). 0 = nothing moves; a shot that holds still costs one render.
 */
function worldTravel(doc: MotionDocument, frame: Frame, a: number, b: number, aliveAt: number): number {
  // Measured as the shutter will see it: a layer entering or leaving is not travel.
  const ea = evaluateWorld(doc, frame, a, { aliveAt }), eb = evaluateWorld(doc, frame, b, { aliveAt });
  const travel = (m: readonly number[], n: readonly number[]) => {
    const t = Math.hypot(m[12]! - n[12]!, m[13]! - n[13]!, m[14]! - n[14]!);
    let r = 0;
    for (let i = 0; i < 11; i++) if (i % 4 !== 3) r = Math.max(r, Math.abs(m[i]! - n[i]!));
    return Math.max(t, r * 100);
  };
  let most = travel(ea.camera.matrix, eb.camera.matrix);
  const at = new Map(eb.objects.map((o) => [o.id, o]));
  for (const o of ea.objects) {
    const p = at.get(o.id);
    most = Math.max(most, p ? travel(o.matrix, p.matrix) : 1000);
  }
  if (ea.objects.length !== eb.objects.length) most = Math.max(most, 1000);
  return most < 0.25 ? 0 : most;
}

/**
 * A 2D LAYER STANDING IN THE COMP'S 3D SPACE (core `flat3d`).
 *
 * The layer is drawn ONCE at rest by the ordinary 2D renderer — its text,
 * effects and strokes untouched — and that picture is laid on its plane and
 * projected through the comp's default camera. Canvas 2D has only affine
 * transforms, so the plane is cut into triangles small enough that each one's
 * affine map is within half a device pixel of the true perspective; a layer
 * that is barely turned is one draw. Every engine, no filters, no WebGL.
 *
 * Returns false when there is nothing to show (the picture is not ready, or
 * the layer is entirely behind the camera); the caller then draws it flat.
 */
function paintDepthLayer(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  localMs: number,
  timeMs: number,
  depth: LayerDepth,
  options: DrawOptions,
): boolean {
  const { pose } = clipLocalGeometry(doc, ctx, frame, clip, localMs, false, options._compTimeMs);
  const C = ctx.getTransform();
  const zoom = Math.hypot(C.a, C.b) || 1;
  const D = defaultCameraDistance(frame.width, frame.height);
  const s = Math.max(Math.abs(pose.scale), Math.abs(pose.scaleY), 0.01);
  // Pixels of picture per layer px — enough for the plane's nearest point, in powers of two so a move does not redraw it.
  const want = zoom * s * (D / Math.max(D * 0.25, D + depth.z));
  const density = Math.min(4, Math.max(0.25, 2 ** Math.ceil(Math.log2(want))));
  const pic = planePicture(doc, frame, clip, timeMs, density);
  if (!pic) return false;
  const anim = layerPoseAt(clip, localMs);
  const M = flatLayerMatrix({ x: pose.x, y: pose.y, rotation: pose.rotation, scaleX: pose.scale, scaleY: pose.scaleY }, depth, frame.width, frame.height, anim);
  const project = (u: number, v: number) => projectFlat(transformPoint(M, [u, v, 0]), frame.width, frame.height);

  const corners = [project(pic.minX, pic.minY), project(pic.maxX, pic.minY), project(pic.maxX, pic.maxY), project(pic.minX, pic.maxY)];
  const seen = corners.filter((p): p is { x: number; y: number } => p !== null);
  if (seen.length === 0) return false;

  // The click target: the box around what is on screen.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of seen) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
  pushHitRect(options, {
    clipId: clip.id,
    frameId: clip.frameId,
    hostFrameId: options.hostFrameId ?? clip.frameId,
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    width: Math.max(24, x1 - x0),
    height: Math.max(24, y1 - y0),
    rotation: 0,
    skewX: 0,
    skewY: 0,
  });
  if (options.skipClipId === clip.id) return true;

  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const opacity = (typeof sampled["opacity"] === "number" ? (sampled["opacity"] as number) : clip.opacity) * anim.opacity;
  if (opacity <= 0.001) return true;

  // How far the plane is from affine: its true centre against the diagonal's midpoint.
  const mid = project((pic.minX + pic.maxX) / 2, (pic.minY + pic.maxY) / 2);
  const bend = mid && seen.length === 4 ? Math.hypot(mid.x - (seen[0]!.x + seen[2]!.x) / 2, mid.y - (seen[0]!.y + seen[2]!.y) / 2) * zoom : 512;
  const n = bend < 0.25 ? 1 : Math.min(32, Math.max(2, Math.ceil(Math.sqrt(bend / 0.5))));

  const img = pic.canvas;
  const grid: ({ x: number; y: number } | null)[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) grid.push(project(pic.minX + ((pic.maxX - pic.minX) * i) / n, pic.minY + ((pic.maxY - pic.minY) * j) / n));
  }
  const tex = (i: number, j: number) => ({ u: (img.width * i) / n, v: (img.height * j) / n });

  ctx.save();
  ctx.globalAlpha *= opacity;
  if (clip.blendMode !== "normal") ctx.globalCompositeOperation = COMPOSITE[clip.blendMode];
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // Triangles overlap by a hair so no seam shows between them (one triangle = the whole picture, unclipped).
  const grow = n > 1 ? 0.6 / zoom : 0;
  type P = { x: number; y: number };
  type T = { u: number; v: number };
  const tri = (p0: P | null, p1: P | null, p2: P | null, ta: T, tb: T, tc: T) => {
    if (!p0 || !p1 || !p2) return;
    drawTexturedTriangle(ctx, img, p0, p1, p2, { x: ta.u, y: ta.v }, { x: tb.u, y: tb.v }, { x: tc.u, y: tc.v }, grow);
  };
  const at = (i: number, j: number) => grid[j * (n + 1) + i] ?? null;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const A = tex(i, j), B = tex(i + 1, j), Cc = tex(i + 1, j + 1), Dd = tex(i, j + 1);
      tri(at(i, j), at(i + 1, j), at(i + 1, j + 1), A, B, Cc);
      // One cell is one affine map: its first triangle already drew the whole
      // picture unclipped, and a second draw doubled every soft edge's alpha.
      if (n > 1) tri(at(i, j), at(i + 1, j + 1), at(i, j + 1), A, Cc, Dd);
    }
  }
  ctx.restore();
  return true;
}

/**
 * A LAYER BENDING WITH ITS RIG, as a picture (text, image, video, a nested
 * comp — anything that is not a vector): the picture it shows at rest, laid
 * through its weight grid with every point skinned (core `bend2d`).
 *
 * Fast where it can be: every stretch of the picture that rides ONE bone
 * whole is one affine map, so it is one clipped `drawImage` (a region), and
 * only the cells that blend across a joint are drawn triangle by triangle.
 * Only the cells the silhouette covers are drawn at all.
 */
function paintBentPicture(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  localMs: number,
  timeMs: number,
  bend: Bend2d,
  options: DrawOptions,
): boolean {
  const geo = clipLocalGeometry(doc, ctx, frame, clip, localMs, false, options._compTimeMs);
  const { matrix } = layerPlacement(doc, ctx, frame, clip, localMs, undefined, false, options._compTimeMs);
  const C = ctx.getTransform();
  const zoom = Math.hypot(C.a, C.b) || 1;
  const s = Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d), 0.01);
  const density = Math.min(4, Math.max(0.25, 2 ** Math.ceil(Math.log2(zoom * s))));
  const pic = planePicture(doc, frame, clip, timeMs, density);
  if (!pic) return false;
  const img = pic.canvas;
  const { grid, weights } = bend.field;
  const pivot = anchorLocal(geo.pose.anchor, geo.box);
  const kx = geo.pose.skewX, ky = geo.pose.skewY;
  const sx = img.width / Math.max(1e-6, pic.maxX - pic.minX), sy = img.height / Math.max(1e-6, pic.maxY - pic.minY);
  const n = grid.count;
  // Each grid point: where it is drawn (bent, placed) and where it is in the picture (at rest).
  const scr: Array<{ x: number; y: number }> = new Array(n);
  const tex: Array<{ x: number; y: number }> = new Array(n);
  const solo = new Int32Array(n).fill(-1);
  const inf = { bone: new Int16Array(4), w: new Float32Array(4) };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const gx = grid.local[i * 3]!, gy = grid.local[i * 3 + 1]!;
    pointInfluence(weights, i, inf);
    if (inf.bone[1]! < 0 || inf.w[0]! >= 0.999) solo[i] = inf.bone[0]!;
    const w = skinPoint(bend.skins, inf, gx, gy, 0);
    const p = matrix.transformPoint({ x: w[0], y: w[1] });
    scr[i] = { x: p.x, y: p.y };
    x0 = Math.min(x0, p.x), y0 = Math.min(y0, p.y), x1 = Math.max(x1, p.x), y1 = Math.max(y1, p.y);
    const q = shearPoint(gx - pivot.x, gy - pivot.y, kx, ky);
    tex[i] = { x: (q.x - pic.minX) * sx, y: (q.y - pic.minY) * sy };
  }
  pushHitRect(options, {
    clipId: clip.id,
    frameId: clip.frameId,
    hostFrameId: options.hostFrameId ?? clip.frameId,
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    width: Math.max(8, x1 - x0),
    height: Math.max(8, y1 - y0),
    rotation: 0,
    skewX: 0,
    skewY: 0,
  });
  if (options.skipClipId === clip.id) return true;
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const anim = layerPoseAt(clip, localMs);
  const opacity = (typeof sampled["opacity"] === "number" ? (sampled["opacity"] as number) : clip.opacity) * anim.opacity;
  if (opacity <= 0.001) return true;

  ctx.save();
  ctx.globalAlpha *= opacity;
  if (clip.blendMode !== "normal") ctx.globalCompositeOperation = COMPOSITE[clip.blendMode];
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const grow = 0.6 / zoom;
  // Cells riding one bone whole, by bone: one region each (unsheared pictures — a
  // sheared cell is not a rectangle in the picture, so it goes by triangles).
  const regions = new Map<number, { map: [number, number, number, number, number, number] | null; rects: Array<[number, number, number, number]> }>();
  const sheared = kx !== 0 || ky !== 0;
  for (const [a, b, c, d] of gridCells(grid)) {
    const one = solo[a]!;
    if (!sheared && one >= 0 && solo[b] === one && solo[c] === one && solo[d] === one) {
      let r = regions.get(one);
      if (!r) regions.set(one, (r = { map: affineFromTriangle(tex[a]!, tex[b]!, tex[c]!, scr[a]!, scr[b]!, scr[c]!), rects: [] }));
      r.rects.push([tex[a]!.x, tex[a]!.y, tex[c]!.x - tex[a]!.x, tex[c]!.y - tex[a]!.y]);
      continue;
    }
    drawTexturedTriangle(ctx, img, scr[a]!, scr[b]!, scr[c]!, tex[a]!, tex[b]!, tex[c]!, grow);
    drawTexturedTriangle(ctx, img, scr[a]!, scr[c]!, scr[d]!, tex[a]!, tex[c]!, tex[d]!, grow);
  }
  for (const r of regions.values()) if (r.map) drawTexturedRegion(ctx, img, r.map, r.rects, 0.5);
  ctx.restore();
  return true;
}

/** A vector bending with its rig, drawn as itself — memoised per clip and bend, so a held pose re-uses it. */
const bentVectors = new WeakMap<Clip, { key: string; clip: PathClip }>();
function bentVectorClip(clip: PathClip | ShapeClip, localMs: number, bend: Bend2d, tolerance: number): PathClip {
  const key = `${bend.key}|${tolerance.toFixed(3)}|${localMs}`;
  const hit = bentVectors.get(clip);
  if (hit && hit.key === key) return hit.clip;
  const out = warpedVectorClip(clip, sampleKeyframes(clip.keyframes, localMs), bend.field, bend.skins, tolerance);
  bentVectors.set(clip, { key, clip: out });
  return out;
}

/**
 * Where a layer's PIVOT sits in its own local (centre-origin) space — the
 * point its picture is drawn about. A world's extruded text and shapes build
 * their outline relative to it, so the solid's face lands exactly where the
 * flat picture of the same layer stood.
 */
let pivotCtx: CanvasRenderingContext2D | null = null;
export function layerPivotLocal(doc: MotionDocument, frame: Frame, clip: VisualClip, localMs: number): { x: number; y: number } {
  pivotCtx ??= document.createElement("canvas").getContext("2d")!;
  const { box } = clipLocalGeometry(doc, pivotCtx, frame, clip, localMs);
  return anchorLocal(clip.transform.anchor, box);
}

/**
 * Draw ONE layer, fitted into a box — the seam the preview poster cache
 * renders `layer` sources through (a shape, a path, a pixel layer: the clips
 * whose only source is themselves).
 *
 * It fits the layer's OWN silhouette rather than its comp, because a poster of
 * a 40px sticker inside a 4K frame has to show the sticker and not a speck.
 * The bounds come from `clipObjectBounds` — the same function the isolation
 * buffer and the selection box use — so a poster frames a layer exactly the
 * way the stage does, and the pixels come from `drawFrameContent` itself, so a
 * poster and the canvas cannot disagree about what a layer looks like.
 *
 * Returns false when the layer has no drawable extent at this time (nothing to
 * poster — the caller keeps its flat clip body rather than a blank rectangle).
 */
const flatFrames = new WeakMap<Frame, Frame>();
/**
 * A world comp as a FLAT comp, so the 2D walk paints one of its layers
 * instead of rendering the whole world through its camera — a layer's own
 * picture (its plane in space, its poster in the timeline).
 */
export function flatFrame(frame: Frame): Frame {
  if (!frame.world) return frame;
  let f = flatFrames.get(frame);
  if (!f) flatFrames.set(frame, (f = { ...frame, world: undefined }));
  return f;
}

export function drawClipPoster(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  compTimeMs: number,
  boxW: number,
  boxH: number,
  /** Room past the silhouette, layer px — what its effects paint there (`layerBleedPad`). 0 for a thumbnail. */
  pad = 0,
  /** Frame THIS box (comp px about the centre) instead of the layer's own silhouette. */
  focus?: ObjectBounds,
): boolean {
  // A layer standing in a world shows ITSELF, never the world's render of everything.
  frame = flatFrame(frame);
  const local = clipLocalTime(clip, compTimeMs) ?? 0;
  const raw = focus ?? clipObjectBounds(doc, ctx, frame, clip, local);
  const bounds = pad > 0 ? { minX: raw.minX - pad, minY: raw.minY - pad, maxX: raw.maxX + pad, maxY: raw.maxY + pad } : raw;
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return false;
  const scale = Math.min(boxW / w, boxH / h);
  ctx.save();
  // Centre the fitted silhouette, then place the comp so the layer's bounding
  // box lands on the box origin. `includeHidden` is deliberate: a poster is
  // asked for by a surface that already decided this clip is worth showing.
  ctx.translate((boxW - w * scale) / 2, (boxH - h * scale) / 2);
  ctx.scale(scale, scale);
  ctx.translate(-(frame.width / 2 + bounds.minX), -(frame.height / 2 + bounds.minY));
  // A group's poster is its members: `only` filters leaf clips by id, so naming
  // the group alone lets the group through and filters out everything it holds
  // — a transparent picture (the Face pad's blank pose tiles).
  const only = new Set(clip.kind === "group" ? [clip.id, ...clipsUnderGroup(doc, clip.id)] : [clip.id]);
  drawFrameContent(ctx, doc, frame, compTimeMs, {
    only,
    transparent: true,
    includeHidden: true,
  });
  ctx.restore();
  return true;
}

/** The per-kind draw dispatch, shared by the flat path and composite groups. */
function dispatchDrawClip(
  tctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  local: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
  /**
   * The COMP's clock. A vector layer needs it beside its own local time: an
   * enclosing group's draw-on runs on the group's edge, and children keep
   * absolute times, so the group's local time is not derivable from the
   * child's.
   */
  compTimeMs: number,
): void {
  if (clip.kind === "text") {
    drawTextClip(tctx, doc, frame, clip, local, options, resolve);
  } else if (clip.kind === "nested") {
    drawNestedClip(tctx, doc, frame, clip, local, options, guard);
  } else if (clip.kind === "image") {
    drawImageClip(tctx, doc, frame, clip, local, options, resolve);
  } else if (clip.kind === "video") {
    drawVideoClip(tctx, doc, frame, clip, local, options, resolve);
  } else if (clip.kind === "shape") {
    drawShapeClip(tctx, doc, frame, clip, local, options, resolve, compTimeMs);
  } else if (clip.kind === "path") {
    drawPathClip(tctx, doc, frame, clip, local, options, resolve, compTimeMs);
  } else if (clip.kind === "waveform") {
    drawWaveformClip(tctx, doc, frame, clip, local, options, resolve);
  } else if (clip.kind === "trace") {
    drawTraceClip(tctx, doc, frame, clip, local, options, resolve);
  } else if (clip.kind === "raster") {
    drawRasterClip(tctx, frame, clip, local, options, resolve);
  }
}

/** Each blend mode as a canvas composite op (only `normal` differs). */
export const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  darken: "darken",
  multiply: "multiply",
  "color-burn": "color-burn",
  lighten: "lighten",
  screen: "screen",
  "color-dodge": "color-dodge",
  overlay: "overlay",
  "soft-light": "soft-light",
  "hard-light": "hard-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

/**
 * Scratch canvases for ISOLATED layer compositing (a blend mode, or unit-
 * opacity for a self-alpha'd layer like text). A tiny stack pool so nested
 * blended layers can each hold a buffer at once; buffers are reused across
 * frames and only ever grow to the canvas size.
 */
interface Scratch {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  busy: boolean;
}
const scratchPool: Scratch[] = [];
/**
 * THE SPILL AND THE BOX ARE TWO COMPOSITES OF ONE RENDER.
 *
 * The working comp is drawn twice a frame: the dimmed spill outside its box,
 * then the box itself. A leaf's buffer is the same picture in both — only the
 * clip of the composite differs (`keyWith` leaves the side out for leaves) —
 * so the layer cache already let the box pass read what the spill pass made.
 * Except while PLAYING, when a per-instant buffer is refused (frames mode, or
 * a layer too cheap to keep): then every layer reaching past the artboard was
 * rendered twice a frame. A full-frame sky that drifts is exactly that layer —
 * half of what playing the Black Hole cost.
 *
 * So a buffer the spill pass makes and may not keep is HELD FOR THIS TICK, and
 * the box pass composites it. It never outlives the tick that made it: it is
 * not a cache, it is one render handed to its second reader.
 */
interface SpillShared {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tick: number;
  key: string;
  clip: Clip;
  refs: readonly unknown[];
  rect: { x: number; y: number; w: number; h: number };
  hits: readonly Omit<ClipHitRect, "depth">[];
}
const spillShare = new Map<string, SpillShared>();
let spillTick = 0;

/** Once per stage frame, before either pass: last tick's renders are not this tick's pictures. */
export function beginSpillShare(): void {
  spillTick++;
  // A layer that stopped spilling lets its canvas go a tick later.
  for (const [id, e] of spillShare) if (e.tick < spillTick - 1) spillShare.delete(id);
}

function acquireSpillShare(clip: Clip, w: number, h: number): Scratch & { entry: SpillShared } {
  let e = spillShare.get(clip.id);
  if (!e) {
    const canvas = document.createElement("canvas");
    e = { canvas, ctx: canvas.getContext("2d")!, tick: -1, key: "", clip, refs: EMPTY_REFS, rect: { x: 0, y: 0, w: 0, h: 0 }, hits: [] };
    spillShare.set(clip.id, e);
  }
  e.tick = -1; // not readable until it is finished
  if (e.canvas.width !== w || e.canvas.height !== h) {
    e.canvas.width = w;
    e.canvas.height = h;
  } else {
    e.ctx.setTransform(1, 0, 0, 1, 0, 0);
    e.ctx.clearRect(0, 0, w, h);
  }
  e.ctx.filter = "none";
  e.ctx.globalAlpha = 1;
  e.ctx.globalCompositeOperation = "source-over";
  return { canvas: e.canvas, ctx: e.ctx, busy: true, entry: e };
}

function readSpillShare(clip: Clip, key: string, refs: readonly unknown[]): SpillShared | null {
  const e = spillShare.get(clip.id);
  if (!e || e.tick !== spillTick || e.key !== key || e.clip !== clip || e.refs.length !== refs.length) return null;
  for (let i = 0; i < refs.length; i++) if (e.refs[i] !== refs[i]) return null;
  return e;
}

function acquireScratch(w: number, h: number): Scratch {
  let s = scratchPool.find((x) => !x.busy);
  if (!s) {
    const canvas = document.createElement("canvas");
    s = { canvas, ctx: canvas.getContext("2d")!, busy: false };
    scratchPool.push(s);
  }
  s.busy = true;
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w; // resizing clears the canvas AND its paint state
    s.canvas.height = h;
  } else {
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.ctx.clearRect(0, 0, w, h);
  }
  // Reused buffers carry their last tenant's paint state. Resizing resets it,
  // holding the size does not — so a buffer that happened to keep its
  // dimensions handed the next layer someone else's `filter`, alpha or blend
  // mode, and the picture changed depending on what had been drawn before it.
  // Every sibling pool in this pipeline already clears all three; this one
  // cleared the transform only. Render output must not depend on history.
  s.ctx.filter = "none";
  s.ctx.globalAlpha = 1;
  s.ctx.globalCompositeOperation = "source-over";
  return s;
}

interface ObjectBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type TransformPose = Omit<BoxPose, "opacity" | "borderRadius" | "crop" | "content">;

/**
 * Put the canvas into a layer's own space: translate to its POSITION (which is
 * where its PIVOT sits) → rotate → shear → scale → step off the pivot. That last
 * step is the whole pivot feature: everything before it happens ABOUT the pivot,
 * so a layer with a corner pivot spins and scales about that corner.
 *
 * Called by every layer painter, so the T·R·K·S order and the pivot are stated
 * once — four painters used to inline these four lines each, and a fifth kind
 * would have inlined them again.
 */
function applyLayerPose(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  pose: TransformPose,
  size: LayerBox,
): void {
  ctx.translate(frame.width / 2 + pose.x, frame.height / 2 + pose.y);
  applyLayerBasis(ctx, { ...pose, size });
}

/**
 * The pose's linear half — everything that happens ABOUT the pivot — as one
 * `ctx.transform`, from the same `layerMatrix` the headless point map is built
 * on. Exported because the drawing overlay draws a LIVE stroke over the picture
 * this function drew, and the only way a preview is guaranteed to sit on its
 * subject is for both to come from one matrix. (It hand-rolled these four lines
 * for a long time and got away with it until pixel layers learned to grow.)
 *
 * The caller still translates to the layer's POSITION first: where a layer sits
 * is the caller's business (a frame's centre here, an artboard plus a flipbook
 * cell's pose in the overlay), and only the pivot-relative half is shared.
 */
export function applyLayerBasis(ctx: CanvasRenderingContext2D, basis: LayerBasis): void {
  const m = layerMatrix(basis);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
}

/**
 * The other direction: put a context that is in a layer's OWN pixel space into
 * frame space, so frame-space content can be drawn straight into the layer's
 * surface. Merging layers down and dropping a floating selection back onto its
 * source both do this, and both used to invert the pose by hand.
 *
 * Callers bracket it the same way the forward map is bracketed, mirrored:
 * `translate(w/2, h/2)` → this → `translate(-pose.x - frame.width/2, …)`.
 */
export function applyInverseLayerBasis(ctx: CanvasRenderingContext2D, basis: LayerBasis): void {
  const m = inverseLayerMatrix(basis);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
}

/**
 * Where a layer's box CENTRE lands in world — the anchor of its hit rect,
 * selection box and gizmos. `geoCenter` is the geometry's own centre in local
 * units (non-zero for a path, or a cropped media box).
 */
function layerCenter(
  frame: Frame,
  pose: TransformPose,
  size: LayerBox,
  geoCenter: { x: number; y: number } = { x: 0, y: 0 },
): { cx: number; cy: number } {
  const d = mapLocal(geoCenter.x, geoCenter.y, { ...pose, size });
  return { cx: frame.width / 2 + pose.x + d.x, cy: frame.height / 2 + pose.y + d.y };
}

function poseMatrix(pose: TransformPose, size: LayerBox): DOMMatrix {
  // Same matrix the painters get, positioned. Built by hand it also disagreed
  // with them whenever BOTH skews were set: `skewX().skewY()` is the product of
  // two shears, while one shear with both tangents — what `shearPoint` and
  // `applySkewToCtx` do — is not the same matrix.
  const m = layerMatrix({ ...pose, size });
  return new DOMMatrix().translate(pose.x, pose.y).multiply(new DOMMatrix([...m]));
}

/**
 * A layer's PAINTED EXTENT placed by its pose, in frame-centre coordinates.
 *
 * `box` is the PIVOT BOX and is a separate argument because it is a separate
 * fact: deriving it from the extent (as this used to) is right only for a layer
 * whose ink fills its box exactly, and wrong for every layer that is CROPPED, a
 * shape with a dragged-out corner, a path animated off its declared box and a
 * text layer with a fixed wrap box. Core's `cropWindow` states the split and
 * why getting it wrong clips artwork rather than merely misplacing it.
 */
function transformBounds(bounds: ObjectBounds, pose: TransformPose, box: LayerBox): ObjectBounds {
  const m = poseMatrix(pose, box);
  const pts = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ].map((p) => m.transformPoint(p));
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

/**
 * The transform channels of a SHAPE or PATH layer at one instant.
 *
 * Only those two kinds: a box layer samples its own pose through
 * `evaluateBoxPose` (which carries the crop and runs the track drive itself)
 * and a text layer through `evaluateClipPose`, with `clipLocalGeometry` as the
 * one place that dispatches between the three. Re-running the track drive here
 * on top of `evaluateBoxPose`'s own is exactly how a tracked box layer's REGION
 * came to be displaced by twice its drive while the picture moved once.
 */
function buildTransformPose(clip: ShapeClip | PathClip, localMs: number): TransformPose {
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const n = (key: string, fallback: number) =>
    typeof sampled[key] === "number" ? (sampled[key] as number) : fallback;
  const scale = n("scale", clip.transform.scale);
  const pose: TransformPose = {
    x: n("x", clip.transform.x),
    y: n("y", clip.transform.y),
    scale,
    scaleY: sampledScaleY(sampled, clip.transform.scaleY) ?? scale,
    rotation: n("rotation", clip.transform.rotation),
    skewX: n("skewX", clip.transform.skewX),
    skewY: n("skewY", clip.transform.skewY),
    anchor: { x: n("anchor.x", clip.transform.anchor.x), y: n("anchor.y", clip.transform.anchor.y) },
  };
  return pose;
}

/** An `ObjectBounds` from a box in the layer's own (centre-origin) space. */
function boxBounds(b: LayerBox): ObjectBounds {
  return {
    minX: b.cx - b.width / 2,
    minY: b.cy - b.height / 2,
    maxX: b.cx + b.width / 2,
    maxY: b.cy + b.height / 2,
  };
}

/**
 * WHERE A LAYER IS, in the three parts every consumer of the question needs:
 * the pose that places it, the PIVOT BOX that pose turns about, and the
 * PAINTED EXTENT it actually inks.
 *
 * Three and not two. The box and the extent are different rectangles — core's
 * `cropWindow` states the split and what conflating them costs — and this
 * function is where the renderer had them conflated: it returned the CROPPED
 * extent and every caller then resolved the pivot against it, so an
 * off-centre crop moved the answer by the crop's own offset times the scale.
 * The painter never had that bug (`withBoxClip` poses about `clipBox` and
 * clips to the crop afterwards), which is why the picture looked right and
 * only the BUFFERS measured from this — the isolation buffer and the shutter
 * region — came out around a rectangle the layer was not in, cutting the
 * artwork off at the buffer wall.
 *
 * Both halves are sampled at `localMs`: the crop is keyframable, so the extent
 * is the window the layer has RIGHT NOW, not the one it was authored with.
 *
 * Split out of `clipObjectBounds` (which is now one line over it) because the
 * shutter needs the local halves, not the transformed box: a pivot is a
 * FRACTION of the pivot box, so re-deriving a motion-blur sample's placement
 * from an already-transformed AABB would resolve it against the wrong
 * rectangle and swing a corner-pivoted layer about its centre.
 */
function clipLocalGeometry(
  doc: MotionDocument,
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  clip: VisualClip,
  localMs: number,
  /**
   * This clip is the one in CROP MODE: `withBoxClip` paints its whole media
   * (the cropped-away part dimmed) rather than just the window, so that is what
   * it covers and that is what a buffer has to hold. The extent follows the
   * paint — always — which is the only rule that keeps this function honest as
   * new paint modes arrive.
   */
  cropPreview = false,
  /** COMP time, for a group to ask its members what they paint right now. */
  compTimeMs?: number,
): { local: ObjectBounds; box: LayerBox; pose: TransformPose } {
  if (clip.kind === "shape") {
    const pose = buildTransformPose(clip, localMs);
    // A shape's declared w/h is its pivot box; a dragged-out corner or a pulled
    // star point paints past it, so the extent is the geometry's own bounds.
    const geo = resolveShapeGeometry(clip, sampleKeyframes(clip.keyframes, localMs));
    return {
      local: shapeLocalBounds(geo),
      box: { width: geo.width, height: geo.height, cx: 0, cy: 0 },
      pose,
    };
  }

  if (clip.kind === "path") {
    const pose = buildTransformPose(clip, localMs);
    // `clipBox` — the DECLARED outline box, which is what `drawPathClip` poses
    // about; the sampled outline is the ink and can wander outside it mid-morph.
    const geometry = pathGeometryAt(clip, sampleKeyframes(clip.keyframes, localMs));
    const b = subpathBounds(geometry) ?? { minX: -4, minY: -4, maxX: 4, maxY: 4 };
    return { local: b, box: clipBox(doc, clip), pose };
  }

  if (clip.kind === "text") {
    const { pose, layout, anim, onPath } = textDrawPlan(ctx, doc, clip, localMs);
    if (onPath) {
      // On a path the ink is wherever the curve put it, in the host's space,
      // and the pivot box is the host's — the same split as everywhere else.
      return { local: onPathExtent(onPath, layout), box: onPath.box, pose };
    }
    // What it PAINTS — every glyph box and every highlight pill, each one WHERE
    // ITS ANIMATION PUTS IT — not what it poses about. `textInkBounds` is the
    // one answer; measured from the typographic box instead, every buffer this
    // feeds trimmed a pill at its own padding (a rounded pill came back with
    // square corners) and trimmed the glyphs of any line placed against a box
    // wider than itself. Measured at REST, it did the same to every word that
    // moves — which on a caption is the word being spoken, every time.
    return {
      // The FIXED WRAP BOX, when there is one, is what `drawGlyphBlock` poses
      // about — the same split, one grain smaller.
      local: textInkBounds(layout, anim),
      box: {
        width: layout.clipBox?.width ?? layout.width,
        height: layout.clipBox?.height ?? layout.height,
        cx: 0,
        cy: 0,
      },
      pose,
    };
  }

  if (clip.kind === "adjustment") {
    // A processor has no intrinsic box — it spans the comp it is grading, which
    // is what `adjustmentPoseMatrix` poses about. Nothing crops it.
    const box = { width: frame.width, height: frame.height, cx: 0, cy: 0 };
    return { local: boxBounds(box), box, pose: evaluateBoxPose(clip, localMs) };
  }

  if (clip.kind === "trace") {
    // A trace paints in COMP space, whatever its own pose (that only names its
    // pen), so its geometry is posed at the comp's centre with no transform
    // and its extent is the line it has drawn by now, padded by its widest
    // stroke and its ghosts.
    const box = { width: frame.width, height: frame.height, cx: 0, cy: 0 };
    const state = evaluateTrace(doc, clip, clip.startMs + localMs);
    return { local: traceExtent(doc, clip, state) ?? { minX: -1, minY: -1, maxX: 1, maxY: 1 }, box, pose: COMP_SPACE_POSE };
  }

  if (clip.kind === "mesh" || clip.kind === "camera" || clip.kind === "light" || clip.kind === "empty") {
    // A 3D object is drawn by the world engine, never by a 2D painter; to a
    // 2D surface that asks anyway it is a nominal box at its origin.
    const box = { width: 100, height: 100, cx: 0, cy: 0 };
    return { local: boxBounds(box), box, pose: evaluateBoxPose(clip, localMs) };
  }

  // The box kinds — image, video, nested comp, waveform, raster, and a GROUP
  // (whose box is the union of what it holds; see `clipNaturalSize`). `clipBox` is
  // THE size answer for all five (the painters read it too, so the pivot cannot
  // resolve differently here than it does on canvas), and the crop is the
  // window inside it.
  const pose = evaluateBoxPose(clip, localMs);
  const box = clipBox(doc, clip);
  if (clip.kind === "group") {
    // A GROUP'S BOX IS NOT CENTRED ON ITS ORIGIN — it is the union of what it
    // holds, wherever that sits — and its (x, y) is a DELTA about its pivot
    // (`groupMatrixOf`, the one authority for where a group puts things).
    // `poseMatrix` reads a layer the other way round: the pivot LANDS at
    // (x, y). The two agree for every kind whose box is centred on its own
    // origin and disagree by the whole box offset for this one, which measured
    // an animating group's buffer around the frame centre instead of around
    // its artwork — cropped or blank until the pose reached identity and the
    // group stopped isolating. Re-expressed here so the generic path below
    // reads the group exactly as the painter places it.
    const p = anchorLocal(pose.anchor, box);
    pose.x += p.x;
    pose.y += p.y;
    // WHAT THE GROUP PAINTS IS WHAT ITS MEMBERS PAINT, NOW. The union box is a
    // document fact — members at rest, no strokes, no effects, no in/out
    // poses — and a buffer measured from it clipped a member the instant it
    // moved, scaled, or wore a stroke. The extent is the union of the members'
    // own extents at this instant, each padded the way its own buffer would
    // be; the box stays the pivot box, which is a different fact.
    const live = compTimeMs != null ? layersExtent(doc, ctx, frame, clip.id, compTimeMs) : null;
    return { local: live ?? boxBounds(cropWindow(pose.crop, box)), box, pose };
  }
  const win = cropWindow(pose.crop, box);
  // THE EXTENT FOLLOWS THE PAINT, always — the rule `cropWindow` states, and the
  // reason a buffer can never be measured around a rectangle the layer is not
  // in. Normally the layer inks its window and nothing else (the content
  // transform clips to it). In CROP MODE it paints its whole picture, dimmed,
  // outside the window — so what it covers is that picture WHERE THE CONTENT
  // TRANSFORM PUT IT, not the box it was authored in.
  const painted = boxBounds(cropPreview ? contentExtent(pose.content, box) : win);
  // A comp that SPILLS (`nestedClipsContent` says no window) paints past its
  // box too, by however far its own layers reach — the same rule a group
  // follows. Measured from the box alone, a camera rig's World lost everything
  // outside 1920×1080 the moment motion blur isolated it.
  const spill = clip.kind === "nested" ? nestedSpillExtent(doc, ctx, clip, pose.content, box, localMs) : null;
  return { local: spill ? unionBounds(painted, spill) : painted, box, pose };
}

/**
 * What a SPILLING nested comp paints, in the nested layer's own centre-origin
 * box space — its comp's layers at the instant the comp shows, through the
 * layer's content transform. Null for a windowed comp (its box is the answer).
 *
 * Memoised per document and instant: the documents are immutable, so a new
 * edit is a new key, and playback asks once per frame however many buffers
 * (isolation, shutter, region) measure the same layer. Guarded against a comp
 * that nests itself.
 */
const spillMemo = new WeakMap<MotionDocument, Map<string, ObjectBounds | null>>();
const measuringSpill = new Set<string>();
function nestedSpillExtent(
  doc: MotionDocument,
  ctx: CanvasRenderingContext2D,
  clip: NestedClip,
  content: ContentTransform,
  box: LayerBox,
  localMs: number,
): ObjectBounds | null {
  const source = doc.frames.find((f) => f.id === clip.sourceFrameId);
  if (!source || nestedClipsContent(clip, source) || measuringSpill.has(source.id)) return null;
  const t = frameEvalTimeMs(doc, source, clipSourceMs(doc, clip, localMs));
  let memo = spillMemo.get(doc);
  if (!memo) spillMemo.set(doc, (memo = new Map()));
  const key = `${source.id}@${t}`;
  let inner = memo.get(key);
  if (inner === undefined) {
    measuringSpill.add(source.id);
    try {
      inner = layersExtent(doc, ctx, source, null, t);
    } finally {
      measuringSpill.delete(source.id);
    }
    memo.set(key, inner);
  }
  if (!inner || contentIsIdentity(content)) return inner;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [[inner.minX, inner.minY], [inner.maxX, inner.minY], [inner.maxX, inner.maxY], [inner.minX, inner.maxY]] as const) {
    const p = mapContent(x, y, content, box);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function unionBounds(a: ObjectBounds, b: ObjectBounds): ObjectBounds {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

/**
 * The frame-centre-space rectangle a group's members (or, with `groupId` null,
 * the comp's top-level layers) ink at `compTimeMs` —
 * each member placed by its own pose AND its own in/out animation (the same
 * `layerPlacement` the shutter measures with), padded by its own effect and
 * stroke bleed, and unioned. A member that is off (hidden, off its lane's
 * clock, outside a nested window) contributes nothing; a nested group asks
 * its own members in turn. Null when nothing inside paints, so the caller
 * can fall back to the document box rather than a zero-size buffer.
 *
 * Measured BEFORE the group's own delta: the caller poses the result exactly
 * as the painter poses the children (`withGroupTransform`), so the buffer and
 * the pixels are placed by one matrix.
 */
function layersExtent(
  doc: MotionDocument,
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  groupId: string | null,
  compTimeMs: number,
): ObjectBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  for (const { track, clip: member } of frameClipEntries(doc, frame.id)) {
    if ((track.groupId ?? null) !== groupId || track.hidden) continue;
    if (member.kind === "audio" || member.hidden) continue;
    const local = clipRenderLocalTime(track, member, trackLocalTime(track, frame.id, compTimeMs));
    if (!local) continue;
    const placed = layerPlacement(doc, ctx, frame, member, local.local, undefined, false, compTimeMs);
    const sampled = sampleKeyframes(member.keyframes, local.local);
    const feather = typeof sampled["feather"] === "number" ? (sampled["feather"] as number) : member.feather;
    const b = quadBounds([boundsQuad(placed.matrix, placed.local)]);
    const pad = layerRegionPad(
      { effects: member.effects, strokes: member.strokes, textEffects: textEffectStacks(member, local.local) },
      sampled,
      Math.max(0, feather),
      boundsSpan(b),
    );
    minX = Math.min(minX, b.minX - pad - cx);
    minY = Math.min(minY, b.minY - pad - cy);
    maxX = Math.max(maxX, b.maxX + pad - cx);
    maxY = Math.max(maxY, b.maxY + pad - cy);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

export function clipObjectBounds(
  doc: MotionDocument,
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  clip: VisualClip,
  localMs: number,
  cropPreview = false,
  compTimeMs?: number,
): ObjectBounds {
  const g = clipLocalGeometry(doc, ctx, frame, clip, localMs, cropPreview, compTimeMs);
  return transformBounds(g.local, g.pose, g.box);
}

/**
 * The per-layer seam: applies the effect stack, layer opacity, and blend mode
 * around a clip's draw. `normal` blend at full (or self-managed) opacity takes
 * the fast path — draw straight onto `ctx` with a scaled `globalAlpha`. A blend
 * mode (or a fractional opacity on a text layer whose glyphs set alpha
 * absolutely) ISOLATES the layer into a buffer and composites it back as one
 * unit — the correct Figma model. `draw` receives the target ctx to paint into.
 */
/**
 * Every per-glyph text stack that could land on a glyph of this clip — the base
 * style's, plus each range's resolved variant.
 *
 * Resolved through `styleAt`, the same per-glyph resolver the layout and the
 * glyph pass come through, so the halo the region reserves room for is by
 * construction the halo that gets drawn. Sampling one grapheme per range is
 * enough: a range's overlay is uniform across its own span.
 */
function textEffectStacks(clip: VisualClip, localMs: number): (readonly TextEffect[] | undefined)[] {
  if (clip.kind !== "text") return [];
  const ranges = effectiveRanges(clip, localMs);
  const stacks: (readonly TextEffect[] | undefined)[] = [clip.style.textEffects];
  for (const r of ranges) stacks.push(styleAt(clip.style, ranges, r.start).textEffects);
  return stacks;
}

/**
 * A vector layer's outline in FRAME px (origin top-left), posed exactly as the
 * painter poses it — the geometry an effect that RUNS ALONG the layer (an
 * outline lightning arc) follows. Lazy: built only when a card asks, since
 * the pose and the flattening are not free and almost no layer asks.
 *
 * Frame px rather than pass px because the pass buffer is not known here; the
 * effect stack maps it through its own transform when it builds the passes.
 *
 * `inked` asks for the line as DRAWN — the draw-on and the stroke's trim cut
 * away (`inkedOutlineAt`) — which is what an arc running along the outline
 * follows; a fill needs the whole region, however much of its edge is inked.
 */
function vectorOutlineInFrame(
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  localMs: number,
  compTimeMs: number,
  inked: boolean,
): LayerOutline | null {
  if (clip.kind !== "shape" && clip.kind !== "path") return null;
  const pose = buildTransformPose(clip, localMs);
  const basis = { ...pose, size: clipBox(doc, clip) };
  const ox = frame.width / 2 + pose.x;
  const oy = frame.height / 2 + pose.y;
  const pls = inked ? flattenCommands(inkedOutlineAt(doc, clip, localMs, compTimeMs), 0.25) : hostPolylinesAt(clip, localMs);
  if (pls.length === 0) return null;
  return {
    contours: pls.map((pl) =>
      pl.pts.map((pt) => {
        const m = mapLocal(pt.x, pt.y, basis);
        return { x: ox + m.x, y: oy + m.y };
      }),
    ),
    closed: pls.map((pl) => pl.closed),
  };
}

let bleedCtx: CanvasRenderingContext2D | null = null;

/**
 * HOW FAR PAST ITS OWN BOX A LAYER CAN PAINT at a comp instant, in the layer's
 * own px — the pad `withLayer` reserves for feather, strokes, per-glyph halos
 * and every card that bleeds (glow, shadow, blur, a boil's reach). The same
 * `layerRegionPad` call, so a surface that confines work to "where this layer
 * can change pixels" (the effect editor's preview) cannot disagree with the
 * buffer the renderer actually paints.
 */
export function layerBleedPad(doc: MotionDocument, frame: Frame, clip: VisualClip, compTimeMs: number): number {
  const track = doc.tracks[clipRowIn(doc, clip.id)];
  if (!track) return 0;
  const local = clipRenderLocalTime(track, clip, trackLocalTime(track, frame.id, compTimeMs));
  if (!local) return 0;
  bleedCtx ??= document.createElement("canvas").getContext("2d");
  if (!bleedCtx) return 0;
  const sampled = sampleKeyframes(clip.keyframes, local.local);
  const feather = typeof sampled["feather"] === "number" ? (sampled["feather"] as number) : clip.feather;
  const bounds = clipObjectBounds(doc, bleedCtx, frame, clip, local.local, false, compTimeMs);
  return layerRegionPad(
    { effects: clip.effects, strokes: clip.strokes, textEffects: textEffectStacks(clip, local.local) },
    sampled,
    Math.max(0, feather),
    boundsSpan(bounds),
  );
}

/**
 * CAN `globalAlpha` STAND IN FOR THIS LAYER'S OPACITY?
 *
 * Only when its picture is ONE paint operation. Opacity is a compositing step —
 * Figma, After Effects and Photoshop all fade the flattened layer — and alpha
 * on the canvas is per draw call: anything drawn in two calls is drawn twice
 * where the calls overlap. So everything else fades as a unit through the layer
 * buffer, which also lets a fading layer keep its pixels in the layer cache
 * (opacity composites the buffer; it is not part of it).
 *
 * Text is not asked: it composites its own fades (`drawGlyphBlock`), because a
 * text fades per word and per letter as well as per layer.
 *
 * A container whose members blend THROUGH it keeps the old behaviour on
 * purpose — buffering it would change what it looks like, and Photoshop fades a
 * pass-through group member by member for the same reason.
 */
function opacityIsOnePaint(doc: MotionDocument, clip: VisualClip, options: DrawOptions): boolean {
  if (clip.kind === "text") return true;
  if (layerBlendsThrough(doc, clip)) return true;
  if (clip.effects.some((fx) => fx.enabled)) return false;
  const paints =
    clip.fills.filter((f) => f.enabled && f.opacity > 0.001).length + clip.strokes.filter(strokeIsVisible).length;
  switch (clip.kind) {
    case "image":
    case "video":
      return paints === 0;
    case "shape":
    case "path":
      return paints <= 1;
    case "nested":
      // Served from the comp-picture store it is one `drawImage`; drawn live it
      // is every layer inside it.
      return paints === 0 && nestedUsesCompStore(doc, clip, options);
    default:
      return false;
  }
}

/** A layer's outline in frame px, one polyline per contour. */
type LayerOutline ={ contours: Array<Array<{ x: number; y: number }>>; closed: boolean[] };
/** Which outline a card runs on: the line as drawn, or the whole region. */
type OutlineAsk = (inked: boolean) => LayerOutline | null;

/** Does this stack carry a card that wants the layer's outline? */
function wantsOutline(effects: VisualClip["effects"]): boolean {
  return effects.some((fx) => fx.enabled && fx.type === "lightning" && (fx.mode === "outline" || fx.mode === "fill"));
}

/**
 * The document, comp and instant a layer is being painted in — module-held
 * for the synchronous draw (like `rasterScale`), so the depth family's passes
 * can read a footage's depth without threading the scene through every effect
 * path. Set and restored around each layer by `withLayer`.
 */
let depthScene: { doc: MotionDocument; frame: Frame; compMs: number } | null = null;

/**
 * THE LIGHT PASS — which part of the picture this draw paints, for Surface's
 * Spare lights: `all` (the picture), `only` (what gives off light: the light
 * picture a material leaves clean) or `unlit` (everything but the lights: what
 * the material is laid on). Module-scoped like `rasterScale`: the whole
 * synchronous draw beneath, nested comps included, shares one answer, and the
 * passes re-run the very `draw` closure the picture uses, so the three cannot
 * disagree about where a light is.
 *
 * A layer is a light when it is marked (`emitsLight`) or sits in a group or a
 * nested comp that is. A stencil paints in every pass (it shapes where a light
 * inside a mask shows). `only` paints no paper and no material (a material
 * never touches light); `unlit` is the whole picture with its lights left out.
 * Every cache a pass can reach names it (`lightsKey`).
 */
type LightPass = "all" | "only" | "unlit";
let lightPass: LightPass = "all";

/** Run `fn` under a light pass. */
function withLightPass<T>(pass: LightPass, fn: () => T): T {
  const prev = lightPass;
  lightPass = pass;
  try {
    return fn();
  } finally {
    lightPass = prev;
  }
}

/** The cache-key term for a light pass ("" for the picture). */
const lightsKey = (): string => (lightPass === "all" ? "" : `|L${lightPass}`);

/**
 * Entering a layer that EMITS: in the light pass all of it is light, so it
 * paints whole (`all`); in the unlit pass none of it is, so it paints nothing
 * (null). Everything else keeps the pass it is in.
 */
function lightPassInside(clip: VisualClip): LightPass | null {
  if (!clip.emitsLight || lightPass === "all") return lightPass;
  return lightPass === "only" ? "all" : null;
}

/**
 * How deep we are inside a LIGHT picture paint. It is a part of the picture,
 * not the picture: it pushes no click targets, and it neither reads nor fills
 * the layer caches, whose entries carry the click targets their draw emitted.
 */
let matteDepth = 0;

/**
 * Paint `draw` as the LIGHT PICTURE into `dst`: what of it gives off light. A
 * layer that emits is light whole; a group or a nested comp is light where its
 * members are; any other layer has no light, and paints nothing.
 */
function paintLightPicture(dst: CanvasRenderingContext2D, clip: VisualClip, draw: (target: CanvasRenderingContext2D) => void): void {
  const container = clip.kind === "group" || clip.kind === "nested";
  if (!clip.emitsLight && !container) return;
  matteDepth++;
  try {
    withLightPass(clip.emitsLight ? "all" : "only", () => draw(dst));
  } finally {
    matteDepth--;
  }
}

/**
 * Paint `draw` UNLIT into `dst`: the layer without its lights — what a material
 * with Spare lights is laid on. A layer that is itself a light has nothing left.
 */
function paintUnlit(dst: CanvasRenderingContext2D, clip: VisualClip, draw: (target: CanvasRenderingContext2D) => void): void {
  if (clip.emitsLight) return;
  withLightPass("unlit", () => draw(dst));
}

function withLayer(...args: Parameters<typeof withLayerBody>): void {
  const [, doc, frame, clip, localMs, , , options] = args;
  const prev = depthScene;
  depthScene = { doc, frame, compMs: options._compTimeMs ?? clip.startMs + localMs };
  try {
    withLayerBody(...args);
  } finally {
    depthScene = prev;
  }
}

function withLayerBody(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  localMs: number,
  resolve: ColorResolver,
  draw: (target: CanvasRenderingContext2D) => void,
  /**
   * The draw's own options, whole.
   *
   * It used to take `effectTimeOffsetMs` alone, plucked out at each of the
   * three call sites, and that is why the region below could not see
   * `cropPreviewClipId` — a layer in CROP MODE paints its full media (dimmed,
   * so you can see what you are bringing back) and a region measured for the
   * cropped window would cut that preview off at the very edge you are dragging.
   * A render mode the buffer has to know about is not a field to keep plucking:
   * pass the options.
   */
  options: DrawOptions,
  /**
   * A pose contributed from OUTSIDE the clip — today, the side of a transition
   * this clip is playing. It composes onto the clip's own in/out animation
   * rather than replacing it, so the whole isolation/effect/feather path below
   * is reused verbatim: a transition gets correct blend modes, feathering and
   * effect bleed for free instead of reimplementing them.
   */
  extraPose?: GlyphVisual,
  /**
   * Where the SCENE BEHIND this layer really is, when that is not `ctx`.
   *
   * A material (glass) refracts the composite under the layer, and every path
   * below finds that composite by reading the target canvas — which is right
   * until someone renders the layer somewhere other than the composite. Motion
   * blur does exactly that: it draws into a scratch buffer so it can re-composite
   * the result, and a scratch buffer starts empty, so glass refracted nothing
   * and the layer came back looking un-effected.
   *
   * The buffer shares the composite's device size and CTM, so the correction is
   * only ever "read those pixels from over there" — no re-projection.
   */
  backdropSource?: CanvasRenderingContext2D,
  /**
   * Paints the SCENE BENEATH this layer from the document into the layer's own
   * region (see `sceneBeneath`), with the transform already set to frame→region.
   * Supplied whenever the caller can name the layers underneath; without it the
   * backdrop falls back to projecting whatever is on the composite, which is
   * only complete when the composite is the whole frame.
   */
  beneath?: SceneBeneath,
): void {
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const effectTimeOffsetMs = focusLead(options, clip.id);
  const blend = clip.blendMode;
  const selfOpacity = clip.kind === "text";
  const opacity = selfOpacity
    ? 1
    : typeof sampled["opacity"] === "number"
      ? (sampled["opacity"] as number)
      : clip.opacity;

  const own = layerPoseAt(clip, localMs);
  const anim = extraPose && !isIdentityPose(extraPose) ? composePoses(own, extraPose) : own;
  const animating = !isIdentityPose(anim);
  if (animating && anim.opacity <= 0.001) return;

  const feather = typeof sampled["feather"] === "number" ? (sampled["feather"] as number) : clip.feather;
  // A PIXEL effect is measured against the buffer it is handed: glass builds its
  // height field from the alpha in it, a vignette centres on it, grain and film
  // damage lay their pattern across it. Handed the composite canvas, that buffer
  // is the STAGE VIEWPORT — so the layer's effects were anchored to the screen
  // instead of to the layer. They grew a rim along the stage edge, stayed put
  // while the artwork scrolled under them, and re-rolled into a different
  // picture at every zoom level, none of which was the picture that exports.
  //
  // The region below is the fix, and it is the ONLY region: the layer's own
  // bounds, in frame space, rasterised at the document's scale. One buffer
  // serves feather, blend isolation, the in/out pose AND the effect stack, so
  // there is no second answer to "what am I applied to".
  const pixelFx = hasPixelEffect(clip.effects);
  // Built once per layer draw, and only when a card will read it.
  const outlineMemo: [LayerOutline | null | undefined, LayerOutline | null | undefined] = [undefined, undefined];
  const outlineInFrame: OutlineAsk | undefined = wantsOutline(clip.effects)
    ? (inked) => {
        const k = inked ? 1 : 0;
        if (outlineMemo[k] === undefined) {
          outlineMemo[k] = vectorOutlineInFrame(doc, frame, clip, localMs, options._compTimeMs ?? localMs, inked);
        }
        return outlineMemo[k]!;
      }
    : undefined;
  // A GROUP'S TINT is composited ATOP the layer's own pixels (`paintGroupTint`),
  // which means it must HAVE pixels of its own: painted straight onto the
  // composite, `source-atop` would find the whole frame beneath the group as
  // its destination and recolour that instead of the group.
  const atopPaint = clip.kind === "group" && groupTintFills(clip).length > 0;
  // FOOTAGE IS A UNIT WHENEVER PLAYBACK IS NOT LIVE — exact playback, or a
  // run of kept pictures. A plain video (or a group or nested comp holding one)
  // paints straight onto the composite, so nothing could keep it, and footage
  // is the costliest thing in the stack to get back: every replay would decode
  // it all over again. Given a buffer, it is kept bottom of the stack first,
  // and read back by the same path.
  // Never a container whose members blend through it — buffering one would
  // change what it looks like.
  // A nested comp the comp-picture store serves is not a unit here as well:
  // that would keep its pixels twice.
  const footageUnit =
    !!options.playing &&
    !options.exporting &&
    !options.footageLive &&
    layerShowsFootage(doc, clip) &&
    !layerBlendsThrough(doc, clip) &&
    !nestedUsesCompStore(doc, clip, options);
  // OPACITY FADES THE FINISHED PICTURE, never each thing in it (see
  // `opacityIsOnePaint`). A group, a nested comp or a filled-and-stroked shape
  // handed its alpha down drew every overlap twice — a darker band wherever two
  // members met, a ring inside every outlined shape, a seam at every join of a
  // connected script.
  const fadesAsUnit = opacity < 0.999 && !opacityIsOnePaint(doc, clip, options);
  const isolate = blend !== "normal" || animating || feather > 0.01 || pixelFx || atopPaint || footageUnit || fadesAsUnit;

  if (!isolate) {
    // Painted straight onto the composite: the backdrop IS the target canvas,
    // so `applyLayerEffects` snapshots it itself (no painter needed) — unless
    // the caller told us the composite lives elsewhere, which is the one case
    // the target canvas is a lie (see `backdropSource`).
    const backdrop = backdropSource
      ? (dst: CanvasRenderingContext2D) => {
          dst.save();
          dst.setTransform(1, 0, 0, 1, 0, 0);
          dst.drawImage(backdropSource.canvas, 0, 0);
          dst.restore();
        }
      : undefined;
    if (opacity >= 0.999) {
      applyLayerEffects(ctx, clip, sampled, localMs, resolve, draw, backdrop, effectTimeOffsetMs, outlineInFrame);
      return;
    }
    ctx.save();
    ctx.globalAlpha *= Math.max(0, opacity);
    applyLayerEffects(ctx, clip, sampled, localMs, resolve, draw, backdrop, effectTimeOffsetMs, outlineInFrame);
    ctx.restore();
    return;
  }

  // THE LAYER REGION — the clip's own silhouette plus whatever its stack paints
  // past it, in FRAME space. Never the canvas: bounding to the object is what
  // fixes stage-edge clipping, and anchoring to frame space is what stops the
  // whole effect stack from sliding around as the stage pans.
  const C = ctx.getTransform();
  const bounds = clipObjectBounds(doc, ctx, frame, clip, localMs, options.cropPreviewClipId === clip.id, options._compTimeMs);
  const featherAmount = Math.max(0, feather);
  // Pad past the object silhouette for feather AND any effect that bleeds
  // outward (shadow/blur/glow/glass rim/…), so soft edges are never clipped at
  // the buffer boundary — the "blur trims when animating" fix. Through
  // `layerRegionPad`, which is the SAME pad the shutter region uses: two
  // buffers holding the same layer must never reserve different room for it.
  const padding = layerRegionPad(
    { effects: clip.effects, strokes: clip.strokes, textEffects: textEffectStacks(clip, localMs) },
    sampled,
    featherAmount,
    boundsSpan(bounds),
  );
  const whole = regionRect(bounds, padding, frameCentre(frame));
  const zoom = (Math.hypot(C.a, C.b) + Math.hypot(C.c, C.d)) / 2 || 1;
  const MAX_BUFFER_DIM = MAX_LAYER_BUFFER_PX;
  // SEEN, NOT WHOLE. A layer magnified past what one buffer holds — a glow on
  // a ball inside a ×13 000 nest, a ×12 room faded to 40% — was rasterised
  // WHOLE and capped at 4096 px, then drawn up: soft glows, blocky fades, at
  // the deepest frame of every zoom. Only the part of it that lands on the
  // target can be seen, so past the cap the region is cut to the target's
  // bounds (back in frame space), grown by the same pad, so a glow or blur
  // reaching in from off-target content is still whole. Under the cap nothing
  // changes: the whole layer stays one picture that pans for free.
  //
  // "Past the cap" is asked of the buffer the layer would actually GET. A
  // stack pinned to the document's pixels (grain, halftone) is made at most at
  // the document's scale however far the stage zooms, so its whole buffer
  // still fits — and cutting it anyway made the window, and with it the cache
  // key, a function of the camera: every pan re-ran the grain.
  //
  // Vector-only isolation (a blend mode, a feather, an in/out pose) rasterises
  // at DEVICE resolution, so an isolated layer stays as crisp as an un-isolated
  // one at any zoom — those operations are scale-exact, they only move and
  // soften pixels the layer already has.
  //
  // A PIXEL stack never rasterises PAST the document's scale. Not a
  // compromise: effects have no resolution-independent meaning — a grain cell,
  // a scratch, a refracted rim are pixels — so magnifying renders a DIFFERENT
  // picture at every zoom, and only one of those is the export. Capped at the
  // document, the stage is a magnifying glass over the frame that will ship.
  // Seen SMALLER, it is made at the size it is seen (`seenScale`).
  const MAX_REGIONAL_PIXELS = 2_097_152;
  //
  // "Document scale" is only honest for cards whose look IS the pixel grid
  // (`gridBound`: grain, halftone, pixelate…). A shadow, blur, glow or boil
  // scales its fields exactly, so pinning those to document pixels only made a
  // shadowed nested scene go soft under a Retina zoom while nothing beside it
  // did. They render at the screen's resolution — unless the stage is on a
  // preview tier, whose whole job is to spend fewer pixels.
  const regional = needsDocumentRaster(clip.effects);
  const pinned = regional && (rasterScale < 1 || gridBoundStack(clip.effects));
  const playing = !!options.playing;
  const need =
    Math.max(whole.width, whole.height) * (pinned ? seenScale(zoom) : zoom) > MAX_BUFFER_DIM
      ? seenRect(C, ctx.canvas, padding, whole)
      : null;
  // A WINDOW IS A TILE (core `seenWindow`): parked, it is grown by the view's
  // margin and snapped, so panning inside the margin is a cache hit instead of
  // a re-render of every magnified layer. A run of frames keeps the exact cut
  // — the layer changes every frame there, and margin is pure cost — and so
  // does a layer the target cannot see at all.
  const grow =
    need && need.width > 1e-3 && !playing && !options.exporting
      ? (WINDOW_MARGINS * viewOverscanPx(need.width * zoom, need.height * zoom)) / zoom
      : 0;
  let seen = need ? seenWindow(need, whole, grow) : null;
  // Buffer px per frame px, and the buffer that follows from it. Re-placed
  // once, below, when a moving camera settles for the layer's draft.
  let rectX = 0, rectY = 0, rectW = 0, rectH = 0, renderScale = 1, objectWidth = 1, objectHeight = 1;
  const place = (r: { x: number; y: number; width: number; height: number }, maxDim: number) => {
    rectX = r.x;
    rectY = r.y;
    rectW = r.width;
    rectH = r.height;
    // MAGNIFICATION PAST THE DOCUMENT IS BUDGETED. A regional stack (boil, a
    // displacement, glow…) is paid per pixel, and at 1480% a boiled hill's buffer
    // was 4096 px wide — seconds of warp for a strip of which the screen showed a
    // twentieth. On the stage, past what `MAX_REGIONAL_PIXELS` affords, it renders
    // at that and draws up: never below the document's own raster, so 1:1 is the
    // export's picture, and an export (which zooms nothing) is untouched. The
    // budget is for what is SEEN: a window's margin is paid for on top, once,
    // rather than taken out of the sharpness of the part on screen.
    // A draft gets a quarter of it.
    const share = draft ? 0.25 : need && seen === r ? Math.max(1, Math.min(2.5, (rectW * rectH) / Math.max(1e-9, need.width * need.height))) : 1;
    const budgeted =
      regional && !options.exporting
        ? Math.max(rasterScale, Math.sqrt((MAX_REGIONAL_PIXELS * share) / Math.max(1, rectW * rectH)))
        : Infinity;
    renderScale = Math.min(pinned ? seenScale(zoom) : Math.min(zoom, budgeted), maxDim / Math.max(rectW, rectH));
    objectWidth = pixelCount(rectW * renderScale);
    objectHeight = pixelCount(rectH * renderScale);
  };
  /** Rendering the whole layer small because the camera is moving — see below. */
  let draft = false;
  place(seen ?? whole, MAX_BUFFER_DIM);

  /**
   * Draw a finished layer buffer onto the composite — the ONE place that does
   * it, so a cache hit and a fresh render are byte-identical by construction
   * rather than by two pieces of code agreeing.
   */
  const compositeBuffer = (buffer: HTMLCanvasElement, r: { x: number; y: number; w: number; h: number }) => {
    ctx.save();
    const a0 = ctx.globalAlpha;
    if (animating && (anim.dx !== 0 || anim.dy !== 0 || anim.scale !== 1 || anim.rotation !== 0)) {
      // The in/out pose turns and scales about the layer's PIVOT as placed. For
      // every layer whose box is centred on its origin that is (x, y); a group's
      // box is its artwork, wherever that sits, so its pivot is asked of the
      // group authority — a breathe on a group breathes about the group.
      const placed =
        clip.kind === "group"
          ? groupPivotPlaced(doc, clip, localMs)
          : {
              x: typeof sampled["x"] === "number" ? (sampled["x"] as number) : clip.transform.x,
              y: typeof sampled["y"] === "number" ? (sampled["y"] as number) : clip.transform.y,
            };
      const ax = frame.width / 2 + placed.x;
      const ay = frame.height / 2 + placed.y;
      const P = new DOMMatrix()
        .translate(ax + anim.dx, ay + anim.dy)
        .rotate(anim.rotation)
        .scale(anim.scale)
        .translate(-ax, -ay);
      // The buffer is drawn at its FRAME-space rect, so the animation P (also
      // frame-space, pivoted at ax/ay) composes on the RIGHT of C: frame → animated
      // frame → device. Conjugating with C.inverse() here was the bug — it only
      // applies when drawing in device space, and skewed the pose by C's linear
      // part (DPR × stage zoom), which is why the layer sat in the wrong place mid
      // animation and snapped correct the instant P reached identity.
      ctx.setTransform(C.multiply(P));
    } else {
      ctx.setTransform(C);
    }
    ctx.globalAlpha = a0 * Math.max(0, Math.min(1, opacity * (animating ? anim.opacity : 1)));
    ctx.globalCompositeOperation = COMPOSITE[blend];
    // Draw the device-resolution buffer back into its frame-space rect; the active
    // transform (C, or C·P with the in/out pose) rescales it to ~1:1 device px.
    // An in/out animation's blur softens it on the way — on every engine.
    drawFiltered(ctx, buffer, animating && anim.blur > 0.2 ? [{ kind: "blur", px: anim.blur * Math.hypot(C.a, C.b) }] : [], r.x, r.y, r.w, r.h);
    ctx.restore();
  };

  // ── THE LAYER CACHE ───────────────────────────────────────────────────────
  //
  // Everything below this point — the effect stack, the feather, the
  // rasterisation — produces one buffer of pixels, and for a layer whose
  // picture does not depend on time, that buffer is the SAME buffer every time
  // it is asked for. The stage asks constantly: every store write re-renders
  // every layer, so selecting a clip, nudging a slider or panning the camera
  // each paid for a fresh jump-flood, a fresh per-pixel threshold and a fresh
  // path rasterisation of artwork that had not changed.
  //
  // The key is identity plus declared inputs — see `layer-cache.ts` for why it
  // can never be a hand-maintained signature. What is NOT the clip object is
  // spelled out here:
  //
  //  · the buffer's placement, size and scale (zoom, DPR, the region)
  //  · the feather, which is applied INTO the buffer below (blend, opacity and
  //    the in/out pose are not — they composite the finished buffer, so they
  //    belong to the draw and not to the pixels)
  //  · the draw mode: a layer-scoped pass, a crop preview, a hidden-layer pass,
  //    the effect editor's clock, the backdrop pass
  //  · for a MATERIAL, the key of the scene it refracts
  //  · for a GROUP, every member clip and track object, because a group's
  //    buffer is its members' picture and its own identity says nothing about
  //    theirs
  //
  // `resolve` is deliberately absent: it is rebuilt per render so its identity
  // would miss every time, and it resolves nothing at all unless the document
  // has variables — which `layerIsCacheable` already refuses outright.
  const cacheable =
    // AN EXPORT IS NOT A PREVIEW — and it says so, rather than being inferred
    // from whether anyone set a raster scale (see `DrawOptions.exporting`;
    // the stage sets a scale too now). An export walks every frame once,
    // so every lookup is a miss AND a store: it would fill the budget with
    // buffers nothing will ask for again and evict the stage's live ones on
    // the way. A cache that is never read is pure cost.
    !options.exporting &&
    !options.measureOnly &&
    matteDepth === 0 &&
    !extraPose &&
    !backdropSource &&
    (!readsBackdrop(clip) || (beneath != null && beneath.key != null)) &&
    layerCacheReadable(doc, clip);
  // THE STEADY SEGMENT this instant sits in, when the layer is provably holding
  // still here — one buffer for the whole stretch instead of one per frame.
  // See `core/preview/picture-steady.ts`.
  //
  // THE BUFFER IS THE LAYER BEFORE IT IS PLACED. Its region is its own
  // silhouette and every effect is anchored to that region, so a pure x/y move
  // shifts the rect and leaves every pixel in it alone. The entry is keyed to
  // the clip the pixels belong to — the stored one, when a bake only moved it
  // (`placedSourceOf`) — its steadiness is judged with placement taken out
  // (`layerBufferSegment`), the key names the rect's SIZE, never its position,
  // and a hit composites and replays at the rect of NOW. A hill scrolled by
  // expression under a 3-drawing boil is three buffers, not a warp per frame.
  const bufferOf = placedSourceOf(clip);
  const segment = cacheable ? layerBufferSegment(doc, bufferOf, localMs, effectTimeOffsetMs) : null;

  let cacheKey = "";
  // The key without its resolution or window terms: the same picture at any
  // zoom, through any window (`readLayerCacheCovering`).
  let family = "";
  // THE DRAW MODE — every term of the key except the instant and the scene
  // beneath. Shared with the kept effect-stack prefix (`applyLayerEffects`),
  // because whatever decides whether THIS layer's pixels and rects can be
  // reused decides it for a stage of them too. The prefix once had its own,
  // shorter key, and the stage's dimmed spill pass — which collects no click
  // targets and runs first — built entries the real pass then served: a group
  // under Liquid merge painted and could not be clicked, framed or rounded.
  let modeKey = "";
  let cacheRefs: readonly unknown[] = EMPTY_REFS;
  // What the layer is MADE of, without the scene beneath — all a prefix reads.
  let contentRefs: readonly unknown[] = EMPTY_REFS;
  if (cacheable) {
    const own: unknown[] = [frame, options._boxFrame ?? null];
    // A CONTAINER'S BUFFER IS ITS CONTENTS' PICTURE, so its own identity says
    // nothing about whether the buffer is still good — move a rectangle inside
    // a glass group, or edit a layer inside a component, and the container clip
    // is untouched. One walk answers it for groups, nested comps and component
    // instances alike, at any depth (`layerContentRefs`); a leaf adds nothing.
    layerContentRefs(doc, clip, own);
    contentRefs = own;
    cacheRefs = beneath?.refs ? [...own, ...beneath.refs] : own;
    // WHICH SIDE OF THE ARTBOARD, AND IS THERE PAPER? Both clip the COMPOSITE
    // (`clipToFrameBox`), never a leaf's buffer, so for a leaf they are not
    // part of its picture — and keying on them made the working comp's dimmed
    // spill pass a second render of every layer reaching past the box, every
    // frame (a scrolling hill's boil, twice). A container draws nested comps
    // that window by them, so it keeps both terms.
    const boxed = clip.kind === "group" || clip.kind === "nested";
    const keyWith = (hits: boolean, scaled = true) =>
      (scaled
        ? `|${rectW.toFixed(3)},${rectH.toFixed(3)}` +
          // A cut region is a picture of THAT window (see `seenWindow`) — named
          // by where it sits IN THE LAYER, because that is what its pixels are.
          // Named in frame space, a layer scrolled by an expression under a
          // still camera kept its key while its picture moved through it.
          (seen ? `|@${(rectX - whole.x).toFixed(3)},${(rectY - whole.y).toFixed(3)}` : "") +
          `|${renderScale.toFixed(4)}|${objectWidth}x${objectHeight}`
        : `|${whole.width.toFixed(3)},${whole.height.toFixed(3)}|~`) +
      `|f${featherAmount.toFixed(3)}` +
      `|${options.includeHidden ? 1 : 0}${boxed && options.transparent ? 1 : 0}${options._inBackdrop ? 1 : 0}${options._onComposite ? 1 : 0}` +
      // WAS THIS DRAW COLLECTING CLICK TARGETS? An entry carries the rects its
      // draw emitted, so one made by a pass that collects none (a thumbnail, a
      // poster, an onion skin, the effect editor's preview — all of which share
      // this renderer) must never be served to a pass that needs them, or the
      // layer paints and cannot be clicked. Their buffer sizes differ in
      // practice and would usually key them apart anyway; "usually" is not a
      // property worth relying on for a defect this hard to recognise.
      `|${hits ? 1 : 0}` +
      `|${boxed ? (options.overflowPass ?? "") : ""}|${options.skipClipId ?? ""}|${options.cropPreviewClipId === clip.id ? 1 : 0}` +
      // `only` reaches INSIDE a group (it decides which members paint) but can
      // never change a leaf's own pixels, so a leaf is spared building it.
      `|${clip.kind === "group" && options.only ? [...options.only].sort().join(",") : ""}` +
      // WHICH MEMBERS ARE ON SCREEN. A group spans its members, so its picture
      // changes at every member's in- and out-point without a single keyframe
      // anywhere — the pixel twin of the stroke bug `groupShowingKey` was
      // written for, which is why this reads that function rather than a second
      // opinion about when a group's picture changes.
      `|${clip.kind === "group" ? groupShowingKey(doc, clip.id, options._compTimeMs ?? localMs) : ""}` +
      // THE INSTANCE SCOPE: a layer inside a component instance is a picture of
      // THOSE inputs (equal inputs share; "" outside any instance).
      `|${options._scope ? scopeCacheKey(doc, frame.id, options._scope) : ""}` +
      lightsKey();
    modeKey = keyWith(!!options.hitRects);
    // THE INSTANT, first: it is what decides whether these pixels are this
    // layer's picture or a different frame of it. Everything an animated layer
    // does — its keyframes, its in/out pose, a driven field, a grain that
    // re-rolls, the frame a video is showing — is a function of this number, so
    // one term covers all of them and none of them needs its own. A STEADY
    // layer names its segment instead: every instant in it is the same
    // picture, so they are one entry.
    const keyOf = (mode: string) => (segment ? segment.key : `t${localMs}`) + mode + `|${beneath?.key ?? ""}`;
    cacheKey = keyOf(modeKey);
    family = keyOf(keyWith(!!options.hitRects, false));
    // A pass that collects no click targets is served by an entry that has
    // them (the rects replay into nothing) — never the other way round.
    const read = (key: string) => readLayerCache(bufferOf, key, cacheRefs, playing && !!options.footageLive);
    const shared = effectTimeOffsetMs === 0 && options.overflowPass !== "outside" ? readSpillShare(clip, cacheKey, cacheRefs) : null;
    const hit = effectTimeOffsetMs !== 0 ? null : (shared ?? (!options.hitRects ? read(keyOf(keyWith(true))) : null) ?? read(cacheKey));
    if (hit) {
      if (hit !== shared) options.cacheHits?.add(clip.id);
      // The draw is skipped, so the rects it would have emitted are replayed —
      // through the CURRENT hit space, so a cached layer stays clickable and
      // its box tracks the board even though no pixel was recomputed. Moved
      // by however far the layer has been placed since the buffer was made.
      const dx = rectX - hit.rect.x;
      const dy = rectY - hit.rect.y;
      for (const r of hit.hits) pushHitRect(options, dx === 0 && dy === 0 ? r : { ...r, cx: r.cx + dx, cy: r.cy + dy });
      compositeBuffer(hit.canvas, { x: rectX, y: rectY, w: hit.rect.w, h: hit.rect.h });
      return;
    }
    // THE PICTURE IT HAS (`readLayerCacheCovering`). Two cases, one read:
    //
    //  · A WINDOWED layer asks for any buffer that HOLDS what the target needs.
    //    A window made for where the camera stood a moment ago usually does,
    //    at full sharpness — that is a hit, not a stand-in.
    //  · MOVING, OR OVER THE SETTLING BUDGET (`DrawOptions.settle`), any layer
    //    shows what it has rather than stalling to make what it wants: its last
    //    zoom's buffer, or the whole layer as it was rendered further out — the
    //    parent tile of every window inside it. Soft for a tick, marked
    //    transient so nothing above keeps it, and the stage is asked back.
    if (effectTimeOffsetMs === 0 && (seen || options.settle?.spent())) {
      const families = options.hitRects ? [family] : [keyOf(keyWith(true, false)), family];
      const cover = readLayerCacheCovering(bufferOf, families, cacheRefs, need ?? whole, whole);
      // A regional stack's scale follows its window's area, so two windows of
      // one zoom differ by a hair; that is not a reason to run the stack again.
      const sharp = cover != null && seen != null && cover.scale >= renderScale * (regional ? 0.8 : 0.999);
      if (cover && (sharp || options.settle?.spent())) {
        if (!sharp) {
          options.settle!.defer();
          markTransientPicture();
        }
        options.cacheHits?.add(clip.id);
        const { dx, dy } = cover;
        for (const r of cover.hits) pushHitRect(options, dx === 0 && dy === 0 ? r : { ...r, cx: r.cx + dx, cy: r.cy + dy });
        compositeBuffer(cover.canvas, cover.rect);
        return;
      }
      // NOTHING TO SHOW, AND THE CAMERA IS MOVING. A windowed layer with no
      // picture at all (the project opened zoomed in) is made WHOLE, small:
      // one render the rest of the gesture — and every later one — reuses,
      // where a window per camera position was a render per frame. At rest and
      // merely over budget, the window itself is the thing to make.
      if (seen && options.settle?.moving) {
        draft = true;
        seen = null;
        place(whole, DRAFT_LAYER_BUFFER_PX);
        modeKey = keyWith(!!options.hitRects);
        cacheKey = keyOf(modeKey);
        options.settle.defer();
      }
    }
  }

  // KEPT only when it pays — see `layerCacheAdmits` — and only if every picture
  // the draw below reads turns out to have been faithful (`pictureFaults`).
  // THE SPILL IS CONTEXT, NOT PICTURE. The dimmed copy of what reaches past
  // the artboard is drawn for your eyes while you work; kept per instant while
  // playing, it was a second, full-resolution copy of every moving layer.
  // A nested comp the comp-picture store serves is kept THERE; only a layer
  // processed on top of it (pixel effects) is a different picture worth a buffer.
  const keepable =
    !(playing && options.overflowPass === "outside") &&
    !(!pixelFx && clip.kind === "nested" && nestedUsesCompStore(doc, clip, options));
  const owned =
    cacheable && keepable && effectTimeOffsetMs === 0 && layerCacheAdmits(clip.id, playing, segment != null, footageUnit || showsFootage(doc, clip, beneath))
      ? acquireLayerCanvas(bufferOf, cacheKey, objectWidth, objectHeight, {
          from: segment ? segment.from : localMs,
          to: segment ? segment.to : localMs,
          gridMs: frameStepMs(compFps(doc, frame.id)),
          // The stage's own pass is what the clip's bar describes — not a
          // poster, a backdrop, or the dimmed spill outside the artboard.
          // Only playback pictures are "cached" on a bar — a paused, full-res
          // buffer is an editing aid playback can never read.
          report: playing && !!options.hitRects && !options._inBackdrop && options.overflowPass !== "outside",
          evict: !playing,
          playing,
          family,
          anchor: { x: whole.x, y: whole.y },
          window: seen != null,
        })
      : null;
  const faultsBefore = owned ? pictureFaults() : null;
  const renderStart = cacheable ? performance.now() : 0;
  // A unit kept per instant holds its children's pixels — nothing inside it
  // is kept a second time (see `layerCacheAdmits`).
  const closeUnit = owned && playing ? enterKeptUnit() : null;

  // Record what this draw emits, so a later hit can replay it. Relative to
  // THIS layer's space: replaying through whatever space is current later
  // re-applies the outside and nothing else.
  // Made by the spill pass and not kept: held for the box pass (`beginSpillShare`).
  const sharing = !owned && cacheable && options.overflowPass === "outside" && effectTimeOffsetMs === 0;
  const myCapture = owned || sharing ? beginHitCapture(options._hitSpace) : null;
  const shareBuf = sharing ? acquireSpillShare(clip, objectWidth, objectHeight) : null;
  const s = owned ? { canvas: owned.canvas, ctx: owned.ctx, busy: true } : (shareBuf ?? acquireScratch(objectWidth, objectHeight));
  const bctx = s.ctx;
  // frame space → this buffer's pixels. Keeping it as a matrix (rather than a
  // second set of scale/offset numbers) is what lets the backdrop painter below
  // map DEVICE pixels into the buffer: B · C⁻¹.
  const B = new DOMMatrix([renderScale, 0, 0, renderScale, -rectX * renderScale, -rectY * renderScale]);
  bctx.save();
  bctx.setTransform(B);
  applyLayerEffects(bctx, clip, sampled, localMs, resolve, draw, (dst) => {
    // An isolation buffer starts EMPTY, so a material inside one would refract
    // nothing. Re-project the real composite (device px) into the buffer's own
    // space so glass in an isolated layer — one with a blend mode, a feather or
    // an in/out animation — sees exactly what glass in a flat layer sees.
    dst.save();
    if (beneath) {
      dst.setTransform(B);
      beneath.paint(dst);
      dst.restore();
      return;
    }
    // Fallback: project the composite. The composite's OWN transform, not this
    // layer's — a shutter buffer is a region of its own, so assuming it shared
    // `C` projected the scene through the wrong matrix the moment the two
    // spaces stopped agreeing.
    const source = backdropSource ?? ctx;
    dst.setTransform(B.multiply(source.getTransform().inverse()));
    dst.drawImage(source.canvas, 0, 0);
    dst.restore();
  }, effectTimeOffsetMs, outlineInFrame, cacheable && !options.exporting ? { doc, options, modeKey, refs: contentRefs } : undefined);
  bctx.restore();

  // Feather is authored in FRAME px; the buffer holds `renderScale` device px
  // per frame px, so soften in the buffer's own scale.
  if (featherAmount > 0.01) {
    featherLayerAlpha(s, featherAmount * renderScale);
  }

  if (myCapture) endHitCapture(myCapture);
  closeUnit?.();
  const rect = { x: rectX, y: rectY, w: rectW, h: rectH };
  // What this layer MEASURED, at the resolution it ran at — the number that
  // decides whether it earns a buffer per instant while a range is built.
  // Never scaled up: see `normalise` in core's profiler.
  if (cacheable) noteLayerCost(clip.id, performance.now() - renderStart);
  // The buffer now holds the finished layer — effects, feather and all — so the
  // entry becomes real here and not a line earlier (see `acquireLayerCanvas`).
  // A range (playing) keeps only EXACT pictures; a parked stage also keeps a
  // stable one, such as footage frozen where playback stopped.
  if (owned && faultsBefore && faithfulSince(faultsBefore, !playing)) {
    owned.commit(cacheRefs, rect, myCapture?.rects ?? [], faithfulSince(faultsBefore), drewFootageSince(faultsBefore));
  }
  // AFTER its own commit: the draft is a true picture of this layer and is
  // kept, but whatever holds it (a group, the frame) is soft because of it.
  if (draft) markTransientPicture();
  if (shareBuf) Object.assign(shareBuf.entry, { tick: spillTick, key: cacheKey, clip, refs: cacheRefs, rect, hits: myCapture?.rects ?? [] });
  compositeBuffer(s.canvas, rect);
  s.busy = false;
}

/**
 * Feather an isolated layer buffer's ALPHA edge in place (device px) — a proper
 * INWARD soft edge (the layer's own pixels dissolve toward transparent as they
 * approach the boundary), with NO outward halo/glow and the interior COLOUR left
 * crisp. The old "blur then source-atop" spread a blurred ring OUTSIDE the
 * silhouette, which read as a drop-shadow instead of a feather.
 *
 * Method: build the INVERSE coverage (opaque everywhere the layer ISN'T), blur
 * it, then `destination-out` it from the layer — so the transparent outside
 * "eats" into the edge over `featherPx`, giving a smooth gradient that fades away
 * exactly at the edge and never leaks past it. One extra buffer, one blur; the
 * alpha is all any mask/matte consumer reads, so this softens a plain layer, a
 * mask stencil AND an adjustment matte through the one path — and it rides the
 * crop clip for free (feathers the CROPPED silhouette).
 */
function featherLayerAlpha(s: Scratch, featherPx: number): void {
  if (featherPx < 0.5) return;
  const w = s.canvas.width;
  const h = s.canvas.height;

  const inv = acquireScratch(w, h);
  inv.ctx.save();
  inv.ctx.setTransform(1, 0, 0, 1, 0, 0);
  inv.ctx.fillStyle = "#000";
  inv.ctx.fillRect(0, 0, w, h);
  inv.ctx.globalCompositeOperation = "destination-out";
  inv.ctx.drawImage(s.canvas, 0, 0);
  inv.ctx.restore();

  // Pre-blur the inverse ONCE → a soft "distance from the edge" ramp. Through
  // `blurTo`, which is the one place that knows a browser blur saturates near
  // 100px — a feather that stops widening past the clamp is a feather that
  // changes with zoom, since the radius here is in buffer px.
  const blurInv = acquireScratch(w, h);
  blurTo(blurInv.ctx, inv.canvas, w, h, Math.max(0.5, featherPx));

  s.ctx.save();
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.globalCompositeOperation = "destination-out";
  s.ctx.imageSmoothingEnabled = true;
  for (let k = 0; k < 4; k++) s.ctx.drawImage(blurInv.canvas, 0, 0, w, h);
  s.ctx.restore();
  inv.busy = false;
  blurInv.busy = false;
}

// ── Composite groups (union / subtract / intersect / exclude / mask) ─────────

/** Each boolean group mode as the composite op its NON-BOTTOM members use. */
const GROUP_OP: Partial<Record<GroupMode, GlobalCompositeOperation>> = {
  union: "source-over",
  subtract: "destination-out",
  intersect: "destination-in",
  exclude: "xor",
  mask: "destination-in",
};

/** Paint sibling layer nodes bottom→top (tree children are top→bottom in z). */
/**
 * THE SCENE BENEATH a layer, rendered from the DOCUMENT rather than scraped off
 * the canvas.
 *
 * A material refracts what is behind it, and "what is behind it" used to mean
 * "whatever pixels happen to be on the composite" — which on the stage is the
 * VIEWPORT. Everything the viewport did not contain read as empty, and empty
 * backdrop means no transmission, so a pane bigger than the window faded back
 * to its own fill exactly where the stage ran out: a coloured gradient welling
 * up out of the stage's corners, deeper the further you zoomed in, following
 * the window instead of the artwork.
 *
 * The scene beneath a layer is a property of the DOCUMENT — the layers that
 * paint before it — so it is rendered as such, into the material's own region,
 * through the same layer-scoped path adjustment mattes use. It costs one re-draw
 * of the layers underneath, paid only by a layer that actually asks.
 */
/** Every leaf of a comp's tree but `except` — what a whole-comp processor's input is made of (`paintBeneath`). */
function leafIdsOf(nodes: LayerTreeNode[], except: string): Set<string> {
  const out = new Set<string>();
  const walk = (ns: LayerTreeNode[]): void => {
    for (const n of ns) {
      if (n.type === "clip") {
        if (n.clip.id !== except) out.add(n.clip.id);
      } else walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function clipsPaintedBefore(nodes: LayerTreeNode[], clipId: string): Set<string> | null {
  // Paint order is the tree walked in reverse — see `paintLayerNodes`.
  //
  // A GROUP is findable here as well as a leaf, and its answer is everything
  // painted before its WHOLE SUBTREE — because a group paints as one unit, so
  // what is behind it is what was on the canvas when it started, not what was
  // there by the time some member of it got its turn.
  //
  // Only leaves go into `order`: that set is handed back as a layer-scoped
  // `only`, and putting a group's own id in it would tell the backdrop pass to
  // paint the very group we are computing a backdrop for.
  const order: string[] = [];
  let cut = -1;
  const walk = (ns: LayerTreeNode[]): void => {
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i]!;
      if (cut < 0 && n.clip.id === clipId) cut = order.length;
      if (n.type === "clip") order.push(n.clip.id);
      else walk(n.children);
    }
  };
  walk(nodes);
  return cut < 0 ? null : new Set(order.slice(0, cut));
}

/**
 * True when this clip carries a material that reads what is behind it — asked
 * of the ONE core declaration (`readsBackdrop` on the effect's type def), never
 * of a `type === "glass"` test written here.
 *
 * Deliberately conservative: `enabled` is read flat rather than through the
 * keyframe track, because the answer only decides whether to BUILD the painter
 * below. The painter is a closure and costs nothing until the effect stack
 * actually asks for a backdrop, which is the precise, post-cull question.
 */
function readsBackdrop(clip: VisualClip): boolean {
  return clip.effects.some((fx) => fx.enabled && layerEffectReadsBackdrop(fx));
}

/**
 * Build the painter that fills a material's region with the scene beneath it,
 * or undefined when this layer needs no backdrop (or is itself inside one).
 * `dst`'s transform is already frame→region when it is called.
 */
function sceneBeneath(
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  timeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
): SceneBeneath | undefined {
  if (options._inBackdrop || !readsBackdrop(clip)) return undefined;
  return paintBeneath(doc, frame, clip, timeMs, options, resolve, guard);
}

/**
 * THE SCENE BENEATH A LAYER, FROM THE DOCUMENT: the comp's box and every layer
 * painted before this one, drawn into whatever region `dst` maps the frame to.
 * What a material refracts (`sceneBeneath`), and what a regional processor on
 * a comp reads (`renderAdjustment`) — never the device canvas, which holds only
 * the part of the comp the view happens to show.
 */
function paintBeneath(
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  timeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
): SceneBeneath | undefined {
  const tree = frameLayerTree(doc, frame.id);
  // A WHOLE-COMP processor (`reach: "all"`, a comp's Frame effects) is not
  // beneath anything: the walk skips it and the post-pass applies it to the
  // finished frame, whatever its lane (`runFramePostPass`). So it reads every
  // layer, then the whole-comp processors before it — never "what lies under
  // its z". Read by z, a Frame effects layer left on a low lane by a rebuild saw
  // three layers: its look was laid on an empty card and the frame came apart.
  const wholeComp = clip.kind === "adjustment" && clip.scope.reach === "all";
  let beneath = wholeComp ? leafIdsOf(tree, clip.id) : clipsPaintedBefore(tree, clip.id);
  if (!beneath) return undefined;
  // A layer-scoped draw (an export of one layer, an adjustment matte) already
  // narrowed what exists; the scene beneath cannot be wider than that. A SLICE
  // is the opposite — the rest of the scene exists, it is simply already
  // painted — so it keeps the whole backdrop (see `_onComposite`).
  if (options.only && !options._onComposite) beneath = new Set([...beneath].filter((id) => options.only!.has(id)));
  const paint = (dst: CanvasRenderingContext2D) => {
    // The SAME frame box the composite gets — fills, border, content clip —
    // because this buffer has to end up holding the pixels that will really be
    // under the layer. See `paintFrameBox`.
    const boxFrame = options._boxFrame ?? frame;
    if (options.transparent || lightPass === "only") clipToFrameBox(dst, boxFrame, options.overflowPass);
    else paintFrameBox(dst, boxFrame, resolve, options);
    if (beneath.size === 0) return;
    if (wholeComp) {
      const finished = { ...options, _onComposite: false, _inBackdrop: true, hitRects: undefined };
      paintLayerNodes(dst, doc, frame, tree, timeMs, finished, resolve, guard);
      runFramePostPass(dst, doc, frame, timeMs, finished, resolve, guard, clip.id);
      return;
    }
    paintLayerNodes(
      dst,
      doc,
      frame,
      tree,
      timeMs,
      { ...options, only: beneath, _onComposite: false, _inBackdrop: true, hitRects: undefined },
      resolve,
      guard,
    );
  };
  const deps = backdropDeps(doc, frame, tree, beneath, timeMs, options);
  // The backdrop's own cache key, handed upward so a MATERIAL's layer cache can
  // include it: glass refracts what is behind it, so its pixels are only good
  // for as long as that scene is. Null when the backdrop cannot state its
  // dependencies (a nested comp beneath), which makes the glass over it
  // uncacheable too — the honest answer, and the same refusal `backdropDeps`
  // already makes for its own shelf.
  const cacheKey = deps ? `${deps.key}#${deps.refs.length}` : null;
  const draw = (dst: CanvasRenderingContext2D) => {
    if (!deps) return paint(dst);
    // ── THE BACKDROP CACHE ──────────────────────────────────────────────────
    // Nudging one slider on a glass card re-renders the document, and the
    // scene beneath the pane is repainted with it — every layer under it,
    // every frame, though not one of them changed. The scene beneath depends
    // only on the layers beneath, the time, the palette and the buffer it
    // lands in; those are the key, and an identical key means the pixels are
    // still on the shelf.
    const m = dst.getTransform();
    const key = `${deps.key}|${dst.canvas.width}x${dst.canvas.height}|${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}`;
    // One shelf per layer and pass: a comp's look reads its picture and its
    // light matte every frame, and one shelf for both evicted each by the other.
    const shelf = clip.id + lightsKey();
    const hit = backdropCache.get(shelf);
    if (hit && hit.key === key && hit.refs.every((r, i) => r === deps.refs[i]) && hit.generation === backdropGeneration) {
      // The glass reading this shelf is made of what the shelf was made of.
      replayPicture(hit.exact, hit.footage);
      dst.save();
      dst.setTransform(1, 0, 0, 1, 0, 0);
      dst.drawImage(hit.canvas, 0, 0);
      dst.restore();
      return;
    }
    const before = pictureFaults();
    paint(dst);
    // A backdrop painted around a picture still on its way is not a shelf.
    if (!faithfulSince(before, !options.playing)) return;
    const canvas = hit?.canvas ?? document.createElement("canvas");
    if (canvas.width !== dst.canvas.width || canvas.height !== dst.canvas.height) {
      canvas.width = dst.canvas.width;
      canvas.height = dst.canvas.height;
    }
    const cctx = canvas.getContext("2d")!;
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, canvas.width, canvas.height);
    cctx.drawImage(dst.canvas, 0, 0);
    if (!hit && backdropCache.size >= BACKDROP_CACHE_SLOTS) {
      backdropCache.delete(backdropCache.keys().next().value!);
    }
    backdropCache.set(shelf, {
      key,
      refs: deps.refs,
      generation: backdropGeneration,
      canvas,
      exact: faithfulSince(before),
      footage: drewFootageSince(before),
    });
  };
  return { paint: draw, key: cacheKey, refs: deps?.refs ?? null };
}

/**
 * The scene behind a material, as a painter AND as what it depends on.
 *
 * The painter alone was enough while nothing cached the layer that reads it.
 * Once the layer's own pixels are cached, "what is behind me" becomes part of
 * that layer's identity — so the two travel together, and a backdrop that
 * cannot say what it depends on (`key: null`) makes the glass in front of it
 * decline the cache rather than serve a stale refraction.
 */
interface SceneBeneath {
  paint: (dst: CanvasRenderingContext2D) => void;
  key: string | null;
  refs: readonly unknown[] | null;
}

/**
 * Is this layer's picture made from footage — its own (a video, or a container
 * holding one) or the scene it refracts? Asked before a render, so admission
 * can refuse a slot live playback would only have to throw away.
 */
function showsFootage(doc: MotionDocument, clip: VisualClip, beneath: SceneBeneath | undefined): boolean {
  if (layerShowsFootage(doc, clip)) return true;
  return !!beneath?.refs && readsBackdrop(clip) && beneath.refs.some((r) => (r as { kind?: unknown } | null)?.kind === "video");
}

/** Shared empty refs array, so an uncached layer allocates nothing. */
const EMPTY_REFS: readonly unknown[] = [];

/** One shelf per material layer; a handful is plenty and bounds the memory. */
const BACKDROP_CACHE_SLOTS = 6;
const backdropCache = new Map<
  string,
  { key: string; refs: unknown[]; generation: number; canvas: HTMLCanvasElement; exact: boolean; footage: boolean }
>();
let backdropGeneration = 0;

/**
 * THE KEPT LOOKS — a whole-comp look's finished picture (see `renderAdjustment`),
 * one shelf per look and light pass, least recently used out, bounded by BYTES:
 * a 4K comp's look is 33 MB, so a count would be no bound at all. A picture
 * bigger than half the budget is never kept; it would only evict the rest.
 */
const LOOK_SHELF_BYTES = 96 * 1024 * 1024;
const lookShelves = new Map<
  string,
  { key: string; refs: unknown[]; generation: number; canvas: HTMLCanvasElement; bytes: number; exact: boolean; footage: boolean }
>();
let lookShelfBytes = 0;

function dropLook(shelf: string): void {
  const e = lookShelves.get(shelf);
  if (!e) return;
  lookShelves.delete(shelf);
  lookShelfBytes -= e.bytes;
}

function keptLook(shelf: string, key: string, refs: readonly unknown[]): HTMLCanvasElement | null {
  const e = lookShelves.get(shelf);
  if (!e || e.key !== key || e.generation !== backdropGeneration || e.refs.length !== refs.length || !e.refs.every((r, i) => r === refs[i])) {
    return null;
  }
  lookShelves.delete(shelf);
  lookShelves.set(shelf, e);
  replayPicture(e.exact, e.footage);
  return e.canvas;
}

function keepLook(
  shelf: string,
  key: string,
  refs: unknown[],
  picture: HTMLCanvasElement | OffscreenCanvas,
  exact: boolean,
  footage: boolean,
): void {
  const bytes = picture.width * picture.height * 4;
  const old = lookShelves.get(shelf);
  dropLook(shelf);
  if (bytes > LOOK_SHELF_BYTES / 2) return;
  for (const k of lookShelves.keys()) {
    if (lookShelfBytes + bytes <= LOOK_SHELF_BYTES) break;
    dropLook(k);
  }
  // Reuse the shelf's own canvas when it is the right size: a look scrubbed
  // through time re-keeps every instant, and a fresh canvas each time is churn.
  const canvas = old?.canvas ?? document.createElement("canvas");
  if (canvas.width !== picture.width || canvas.height !== picture.height) {
    canvas.width = picture.width;
    canvas.height = picture.height;
  }
  const c = canvas.getContext("2d");
  if (!c) return;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, canvas.width, canvas.height);
  c.drawImage(picture, 0, 0);
  lookShelves.set(shelf, { key, refs, generation: backdropGeneration, canvas, bytes, exact, footage });
  lookShelfBytes += bytes;
}

/**
 * Something drawable arrived from OUTSIDE the document — a decoded video
 * frame, a loaded image, a parsed font, a lazy effect engine — so a backdrop
 * painted before it may be missing it. The stage calls this from the same
 * hooks that mark it dirty for those events.
 */
/**
 * Something outside the document changed what a render produces: a font loaded,
 * an image or video frame decoded, a paint surface arrived, a lazily-loaded
 * effect engine landed.
 *
 * ONE funnel for both pixel caches. They answer different questions — what is
 * behind a material, and what a layer looks like — but they are stale for
 * exactly the same reasons, and two counters bumped from two lists is how one
 * of them eventually stops being bumped.
 */
export function invalidateBackdrops(): void {
  backdropGeneration++;
  invalidateLayerCache();
}

/**
 * ONE clip's picture changed (a video frame landed) — drop the layers and the
 * backdrop shelves that painted it, and nothing else. What made a playing
 * video in the comp flush every cached layer in the document on every frame
 * was this being `invalidateBackdrops()`.
 */
export function invalidateMediaDependents(clipId: string): void {
  invalidateLayersShowing(clipId);
  const host = clipId.includes("::") ? clipId.slice(0, clipId.indexOf("::")) : clipId;
  for (const [shelf, entry] of [...backdropCache]) {
    if (entry.refs.some((r) => (r as { id?: unknown } | null)?.id === host)) backdropCache.delete(shelf);
  }
  for (const [shelf, entry] of [...lookShelves]) {
    if (entry.refs.some((r) => (r as { id?: unknown } | null)?.id === host)) dropLook(shelf);
  }
}

/**
 * What the scene beneath a layer depends on, as object identities plus a
 * string: the clips beneath (a changed clip is a new object under immer), the
 * frame, the palette, the time, and the draw options that shape the paint.
 *
 * A NESTED comp beneath is stated through its contents — the same walk the
 * layer cache uses for containers (`layerContentRefs`): its source frame, its
 * clips at any depth and the rows they sit on. It used to refuse outright, and
 * that made the commonest heavy layout in the app — glass over a nested comp or
 * a component with footage in it — the one layer that could never be kept: a
 * 60ms material re-rendered on every tick, parked or playing. The footage
 * inside is covered too: its clip is in these refs, so a new decoded frame of
 * it drops exactly the materials looking at it (`invalidateMediaDependents`).
 */
function backdropDeps(
  doc: MotionDocument,
  frame: Frame,
  tree: LayerTreeNode[],
  beneath: Set<string>,
  timeMs: number,
  options: DrawOptions,
): { key: string; refs: unknown[] } | null {
  const refs: unknown[] = [frame, doc.variables, options._boxFrame ?? null];
  const walk = (ns: LayerTreeNode[]): boolean => {
    for (const n of ns) {
      if (n.type === "clip") {
        if (!beneath.has(n.clip.id)) continue;
        refs.push(n.clip, doc.tracks[n.trackIndex]);
        if (n.clip.kind === "nested") layerContentRefs(doc, n.clip, refs);
      } else if (!walk(n.children)) return false;
    }
    return true;
  };
  if (!walk(tree)) return null;
  // Nothing beneath: the backdrop is the board alone, the same at every
  // instant — so time is not part of it, and glass over it holds still with
  // the rest of its layer instead of being kept once per frame.
  const key = `${beneath.size > 0 ? timeMs : "-"}${lightsKey()}|${options.transparent ? 1 : 0}|${options.overflowPass ?? ""}|${options.includeHidden ? 1 : 0}|${options._onComposite ? "slice" : options.only ? [...options.only].join(",") : ""}|${refs.length}`;
  return { key, refs };
}

function paintLayerNodes(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  nodes: LayerTreeNode[],
  timeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    paintLayerNode(ctx, doc, frame, nodes[i]!, timeMs, options, resolve, guard);
  }
}

/** Leaf kinds whose whole picture is their own padded region (`withLayer`). */
const REGION_BOUND_KINDS: ReadonlySet<string> = new Set(["nested", "text", "shape", "path", "image", "video", "raster", "waveform"]);

/**
 * Does this top-level layer paint NOTHING outside the artboard right now?
 *
 * The dimmed spill pass (`overflowPass: "outside"`) draws the working comp a
 * second time, clipped to everything BUT its box. Every layer that sits inside
 * the box was rendered in full and then clipped to nothing — on the Playground
 * cover, nine nested scenes, every frame: 60% of what playing it cost.
 *
 * Proven, never guessed: a leaf whose own region — its bounds plus every pad
 * its stack bleeds (`layerRegionPad`, the same pad its buffer reserves) — lies
 * inside the box, and that is not moved past its bounds by anything drawn on
 * top of them: an in/out pose, a shutter, depth or a rig bend. Anything else
 * paints as before.
 */
function staysInsideBox(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  node: LayerTreeNode,
  timeMs: number,
  options: DrawOptions,
): boolean {
  if (node.type !== "clip" || !REGION_BOUND_KINDS.has(node.clip.kind)) return false;
  const clip = node.clip as VisualClip;
  const track = doc.tracks[node.trackIndex];
  const tt = clipNodeTime(doc, frame, node, timeMs, options);
  const local = track && tt !== null ? clipRenderLocalTime(track, clip, tt, options.clipEnds) : null;
  if (!local) return true; // not on screen at all
  const at = local.local;
  if (!isIdentityPose(layerPoseAt(clip, at))) return false;
  if (options.motionBlur && resolveMotionBlur(frame, clip, options.motionBlur, at)) return false;
  if (layerDepthAt(clip, at) || documentHasRigs(doc)) return false;
  const sampled = sampleKeyframes(clip.keyframes, at);
  const feather = typeof sampled["feather"] === "number" ? (sampled["feather"] as number) : clip.feather;
  const bounds = clipObjectBounds(doc, ctx, frame, clip, at, false, timeMs);
  const pad = layerRegionPad(
    { effects: clip.effects, strokes: clip.strokes, textEffects: textEffectStacks(clip, at) },
    sampled,
    Math.max(0, feather),
    boundsSpan(bounds),
  );
  const r = regionRect(bounds, pad, frameCentre(frame));
  return r.x >= 0 && r.y >= 0 && r.x + r.width <= frame.width && r.y + r.height <= frame.height;
}

/**
 * A clip node's track-remapped time (the v32 track-loop seam: a looping
 * lane's content span repeats to fill the comp), or null when the clip is
 * hidden or filtered out by a layer-scoped draw.
 */
function clipNodeTime(
  doc: MotionDocument,
  frame: Frame,
  node: ClipLayerNode,
  timeMs: number,
  options: DrawOptions,
): number | null {
  const track = doc.tracks[node.trackIndex];
  if (!track || track.hidden || (node.clip.hidden && !options.includeHidden)) return null;
  if (options.only && !options.only.has(node.clip.id)) return null;
  // A light pass: a nested comp paints (its layers decide); a stencil always
  // paints; otherwise a light paints in `only` and not in `unlit`.
  if (lightPass !== "all" && node.clip.kind !== "nested" && !node.clip.isStencil && !!node.clip.emitsLight !== (lightPass === "only")) return null;
  // A member its switch does not show is off screen now, like a clip outside its span.
  if (hiddenBySwitch(doc, track, node.clip, timeMs)) return null;
  return trackLocalTime(track, frame.id, timeMs);
}

/**
 * Is this node PART OF THE PICTURE at this instant — the question the
 * contributor ledger asks, which is not quite the one `nodeDrawable` answers.
 *
 * For a leaf they are the same. For a group this deliberately stops at the
 * group's own gates rather than recursing: see the call site in
 * `paintLayerNode` for why the cheap half is the half that matters.
 */
function nodeAttends(
  doc: MotionDocument,
  frame: Frame,
  node: LayerTreeNode,
  timeMs: number,
  options: DrawOptions,
): boolean {
  if (node.type === "clip") return nodeDrawable(doc, frame, node, timeMs, options);
  const track = doc.tracks[node.trackIndex];
  if (!track || track.hidden || (node.clip.hidden && !options.includeHidden)) return false;
  if (options.only && !options.only.has(node.clip.id) && !node.clipIds.some((id) => options.only!.has(id))) {
    return false;
  }
  if (hiddenBySwitch(doc, track, node.clip, timeMs)) return false;
  const groupTime = trackLocalTime(track, frame.id, timeMs);
  return clipRenderLocalTime(track, node.clip, groupTime, options.clipEnds) !== null;
}

/** Whether a node paints anything at this time — drives the degenerate cases. */
function nodeDrawable(
  doc: MotionDocument,
  frame: Frame,
  node: LayerTreeNode,
  timeMs: number,
  options: DrawOptions,
): boolean {
  if (node.type === "clip") {
    const tt = clipNodeTime(doc, frame, node, timeMs, options);
    if (tt === null) return false;
    const track = doc.tracks[node.trackIndex];
    return !!track && clipRenderLocalTime(track, node.clip, tt, options.clipEnds) !== null;
  }
  const track = doc.tracks[node.trackIndex];
  if (track && hiddenBySwitch(doc, track, node.clip, timeMs)) return false;
  return node.children.some((c) => nodeDrawable(doc, frame, c, timeMs, options));
}


// ── Transitions ──────────────────────────────────────────────────────────────

/**
 * Paint the WIPE stencil for a transition — opaque wherever the incoming clip
 * should show through, transparent where the outgoing one stays. Drawn in FRAME
 * coordinates (the caller has already set the frame transform), so it lines up
 * with the content regardless of stage zoom or DPR.
 */
function paintWipeStencil(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  wipe: WipeSpec,
  scale: number,
): void {
  const w = frame.width;
  const h = frame.height;
  // Softness is authored as a percentage of the frame's smaller side, so a wipe
  // looks the same on a square post and a widescreen edit.
  const soft = (wipe.softness / 100) * Math.min(w, h) * 0.5;

  if (wipe.kind === "linear" || wipe.kind === "barn") {
    const rad = (wipe.angleDeg * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    // Project the frame onto the sweep axis so the gradient always spans it
    // fully, whatever the angle — no dead zones at 45°.
    const reach = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    const cx = w / 2;
    const cy = h / 2;

    if (wipe.kind === "linear") {
      // The edge travels the full reach plus its own softness, so the wipe
      // genuinely starts fully closed and ends fully open.
      const travel = reach * 2 + soft * 2;
      const head = -reach - soft + travel * wipe.progress;
      const g = ctx.createLinearGradient(
        cx + dx * (head - soft), cy + dy * (head - soft),
        cx + dx * (head + soft), cy + dy * (head + soft),
      );
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = soft > 0.5 ? g : "#000";
      if (soft <= 0.5) {
        // Hard edge: fill the half-plane behind the head.
        ctx.save();
        ctx.beginPath();
        const px = -dy;
        const py = dx;
        const far = reach * 4;
        ctx.moveTo(cx + dx * head + px * far, cy + dy * head + py * far);
        ctx.lineTo(cx + dx * head - px * far, cy + dy * head - py * far);
        ctx.lineTo(cx + dx * (head - far) - px * far, cy + dy * (head - far) - py * far);
        ctx.lineTo(cx + dx * (head - far) + px * far, cy + dy * (head - far) + py * far);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        return;
      }
      ctx.fillRect(0, 0, w, h);
      return;
    }

    // Barn door: two edges opening from the centre line, mirrored.
    const half = (reach + soft) * wipe.progress;
    const g = ctx.createLinearGradient(cx - dx * reach, cy - dy * reach, cx + dx * reach, cy + dy * reach);
    const stop = Math.min(0.5, Math.max(0, 0.5 - half / (reach * 2)));
    const feather = Math.min(0.25, soft / (reach * 2));
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(Math.max(0, stop - feather), "rgba(0,0,0,0)");
    g.addColorStop(Math.min(0.5, stop + feather), "rgba(0,0,0,1)");
    g.addColorStop(Math.max(0.5, 1 - stop - feather), "rgba(0,0,0,1)");
    g.addColorStop(Math.min(1, 1 - stop + feather), "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    return;
  }

  if (wipe.kind === "circle") {
    const cx = wipe.cx * w;
    const cy = wipe.cy * h;
    // Reach the furthest corner so the iris genuinely clears the frame at t=1.
    const maxR = Math.max(
      Math.hypot(cx, cy),
      Math.hypot(w - cx, cy),
      Math.hypot(cx, h - cy),
      Math.hypot(w - cx, h - cy),
    );
    const r = (maxR + soft) * wipe.progress;
    if (r <= 0) return;
    const inner = Math.max(0, r - soft);
    const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, Math.max(inner + 0.01, r));
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = soft > 0.5 ? g : "#000";
    if (soft <= 0.5) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.fillRect(0, 0, w, h);
    return;
  }

  // Clock: a growing pie wedge. Softened with a blur rather than a gradient —
  // a radial sweep has no gradient primitive in 2D canvas.
  const cx = wipe.cx * w;
  const cy = wipe.cy * h;
  const r = Math.hypot(w, h);
  const start = (wipe.startDeg * Math.PI) / 180;
  ctx.save();
  paintFiltered(ctx, soft > 0.5 ? [{ kind: "blur", px: soft * scale }] : [], (c) => {
    c.fillStyle = "#000";
    c.beginPath();
    c.moveTo(cx, cy);
    c.arc(cx, cy, r, start, start + Math.PI * 2 * wipe.progress);
    c.closePath();
    c.fill();
  });
  ctx.restore();
}

/**
 * The clip-local time a transition participant is painted at — which may sit
 * OUTSIDE the clip's own span, because a mix shows the outgoing clip past its
 * out point and the incoming one before its in point.
 *
 * Where the source has no frames left to give, the time is HELD at the edge:
 * a freeze is honest and matches every NLE, whereas letting the seek run past
 * the media flashes black. `transitionMediaShortfall` decides how much is held
 * and the timeline warns about the same number, so preview, export and the UI
 * never disagree.
 */
function transitionLocalTime(
  clip: Clip,
  trackTimeMs: number,
  allowanceMs: number,
  side: "a" | "b",
): number {
  const raw = trackTimeMs - clip.startMs;
  // A may run `allowance` past its out point; B may start `allowance` early.
  return side === "a" ? Math.min(raw, clip.durationMs + allowanceMs) : Math.max(raw, -allowanceMs);
}

/**
 * Render a cut transition: both participants, posed and combined per the mix.
 *
 * Two paths, chosen per FRAME by `isSeparableMix`:
 *  • separable (no stencil, no veil) — the clips paint as ordinary posed
 *    layers straight into the target. No offscreen buffers at all, so a
 *    dissolve or a push costs the same as two normal layers.
 *  • otherwise — each side renders into its own full-frame buffer, the stencil
 *    mattes the incoming one, and the pair composites with the veil on top.
 *
 * Either way the per-side pose rides `withLayer`, so blend modes, effects,
 * feather and crop keep working through a transition instead of being bypassed.
 */
function renderTransition(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  track: Track,
  transition: Transition,
  progress: number,
  trackTimeMs: number,
  /** The COMP's time — `trackTimeMs` is remapped by a looping lane, and a
   *  processor's scope matte has to re-render its targets at the comp clock. */
  compTimeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
): void {
  const { a, b } = transitionParticipants(track, transition);
  // The mix is told which sides EXIST: a lone clip edge is the same record with
  // one participant null, and presets whose two halves are separate events
  // (the dips) play only their own half there.
  const op = transitionMixAt(transition, progress, { a: a !== null, b: b !== null });
  const shortfall = transitionMediaShortfall(doc, track, transition);
  const split = Math.min(transition.splitMs, transition.durationMs);
  const aAllowance = Math.max(0, transition.durationMs - split - shortfall.aFreezeMs);
  const bAllowance = Math.max(0, split - shortfall.bFreezeMs);

  // A PROCESSOR has no picture to mix. Handed a scratch buffer it would grade
  // transparent pixels and hand back nothing, which is why a transition on an
  // adjustment layer looked like it did nothing at all. Its side belongs on the
  // TARGET, where the composite it grades actually lives — run in a→b order
  // around the picture mix, so a cut between two grades is Resolve's grade wipe
  // and a grade cut against footage lands on the footage, not under it.
  const procA = a?.kind === "adjustment" ? a : null;
  const procB = b?.kind === "adjustment" ? b : null;
  const picA = procA ? null : a;
  const picB = procB ? null : b;
  // The veil is the transition's own darkness. A picture side already wears it
  // (below); with neither side a picture, the processors carry it over the only
  // pixels the cut owns — the ones they grade.
  const veil =
    !picA && !picB && op.veil > 0.001
      ? { color: transition.color ?? defaultVeilColor(transition.preset), alpha: Math.min(1, op.veil) }
      : null;

  const paintProcessor = (clip: AdjustmentClip | null, pose: GlyphVisual, side: "a" | "b") => {
    if (!clip || pose.opacity <= 0.001) return;
    const local = transitionLocalTime(clip, trackTimeMs, side === "a" ? aAllowance : bAllowance, side);
    renderAdjustment(ctx, doc, frame, clip, local, compTimeMs, resolve, options, guard, {
      // The cut's mix composes with whatever the layer's own in/out is doing —
      // the same composition `layerPlacement` performs for a painted layer.
      pose: composePoses(layerPoseAt(clip, local), pose),
      // Only the INCOMING side is stencilled: the wipe reveals B over A.
      wipe: side === "b" ? op.wipe : null,
      veil,
    });
  };

  const paintSide = (
    target: CanvasRenderingContext2D,
    clip: Clip | null,
    pose: GlyphVisual,
    side: "a" | "b",
  ) => {
    if (!clip || clip.kind === "audio" || clip.kind === "adjustment") return;
    if (pose.opacity <= 0.001) return;
    const local = transitionLocalTime(clip, trackTimeMs, side === "a" ? aAllowance : bAllowance, side);
    withLayer(
      target,
      doc,
      frame,
      clip,
      local,
      resolve,
      (tctx) => dispatchDrawClip(tctx, doc, frame, clip, local, options, resolve, guard, compTimeMs),
      options,
      pose,
    );
  };

  paintProcessor(procA, op.a, "a");

  // Both sides processors: the picture mix has nothing to mix, and running it
  // would blit an empty buffer over the grade we just laid down.
  if (!picA && !picB) {
    paintProcessor(procB, op.b, "b");
    return;
  }

  if (isSeparableMix(op)) {
    paintSide(ctx, picA, op.a, "a");
    paintSide(ctx, picB, op.b, "b");
    paintProcessor(procB, op.b, "b");
    return;
  }

  const m = ctx.getTransform();
  const scale = (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2 || 1;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  const mixed = acquireScratch(w, h);
  mixed.ctx.save();
  mixed.ctx.setTransform(m);
  paintSide(mixed.ctx, picA, op.a, "a");
  mixed.ctx.restore();

  const incoming = acquireScratch(w, h);
  incoming.ctx.save();
  incoming.ctx.setTransform(m);
  paintSide(incoming.ctx, picB, op.b, "b");
  incoming.ctx.restore();

  if (op.wipe) {
    // Matte the incoming side down to the stencil, then lay it over A.
    const mask = acquireScratch(w, h);
    mask.ctx.save();
    mask.ctx.setTransform(m);
    paintWipeStencil(mask.ctx, frame, op.wipe, scale);
    mask.ctx.restore();
    incoming.ctx.save();
    incoming.ctx.setTransform(1, 0, 0, 1, 0, 0);
    incoming.ctx.globalCompositeOperation = "destination-in";
    incoming.ctx.drawImage(mask.canvas, 0, 0);
    incoming.ctx.restore();
    mask.busy = false;
  }

  mixed.ctx.save();
  mixed.ctx.setTransform(1, 0, 0, 1, 0, 0);
  mixed.ctx.drawImage(incoming.canvas, 0, 0);
  mixed.ctx.restore();
  incoming.busy = false;

  if (op.veil > 0.001) {
    // `source-atop` confines the veil to the transition's OWN pixels. Filling
    // the frame rect instead would black out every track below, which is a
    // nasty surprise for a dip applied to an overlay rather than the A-roll.
    mixed.ctx.save();
    mixed.ctx.setTransform(m);
    mixed.ctx.globalCompositeOperation = "source-atop";
    mixed.ctx.globalAlpha = Math.min(1, op.veil);
    mixed.ctx.fillStyle = transition.color ?? defaultVeilColor(transition.preset);
    mixed.ctx.fillRect(0, 0, frame.width, frame.height);
    mixed.ctx.restore();
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(mixed.canvas, 0, 0);
  ctx.restore();
  mixed.busy = false;

  // B last, over the finished picture mix — a grade cutting in on top of
  // footage grades the footage, which is the only order that means anything.
  paintProcessor(procB, op.b, "b");
}

/**
 * Paint one layer node. A clip rides the per-layer seam (effects + opacity +
 * blend via `withLayer`); a plain group is just its children; a composite
 * group renders as ONE unit — children combine inside an isolation buffer per
 * the mode, and the result composites back onto the frame. Alpha-compositing
 * semantics: union keeps every member's own paint; subtract knocks the upper
 * children out of the bottom one; intersect keeps the shared region; exclude
 * XORs; mask shows the content only inside the union of the direct `isStencil`
 * clips (a nested subgroup is always content). A child that is itself a group
 * RECURSES to its finished pixels first — this is what makes a union nested
 * inside a subtract (or any depth of combinations) compose naturally, in
 * preview and export alike, because it all lives on the one draw path.
 */

// ── The shutter ──────────────────────────────────────────────────────────────

/**
 * Paint one clip THROUGH ITS SHUTTER, or return false to let the caller draw it
 * the ordinary way.
 *
 * This sits above `withLayer` and below the layer-tree walk, which is the whole
 * architectural claim of the feature: motion blur is not an effect (an effect is
 * `pixels(t) → pixels`; this re-invokes the entire layer render, effect stack
 * included, once per sample) and it is not a transform hack (it integrates
 * whatever the layer DOES across the interval, so an in/out animation, a
 * transition pose and a keyframed position all blur through the same path).
 *
 * It returns false far more often than true, and cheaply: three boolean checks
 * resolve the switches, then ONE measurement decides whether anything moved
 * enough to be worth a buffer. A layer sitting still with motion blur switched
 * on costs that measurement and nothing else, which is the entire reason the
 * feature can be left on by default.
 */
function paintClipShutter(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  localMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  draw: (target: CanvasRenderingContext2D, atLocalMs: number, at: { doc: MotionDocument; clip: VisualClip }, atCompMs: number) => void,
  beneath?: SceneBeneath,
  /** Comp time of the frame — what `localMs` is local to. */
  compMs = localMs,
): boolean {
  const policy = options.motionBlur;
  // An ancestor already integrating this subtree owns it — see `_inContentShutter`.
  if (!policy || options._inContentShutter) return false;
  const resolved = resolveMotionBlur(frame, clip, policy, localMs);
  if (!resolved) return false;

  const fps = frameFps(doc, frame);
  const interval = 1000 / Math.max(1, fps);
  const window0 = shutterWindow(interval, localMs, resolved.settings);
  // THE MEASUREMENT. Placement — not merely the transform — because a layer's
  // position on the stage is its pose composed with its in/out animation, and
  // measuring only the transform would declare a layer that flies in to be
  // standing still. The PIVOT BOX is taken once, at the frame time, and every
  // sample turns about it (see `layerPlacement`); the EXTENT is what the layer
  // inks there, which under a crop is a different rectangle entirely.
  //
  // Each sub-sample reads the layer AS ITS COMP RESOLVES IT THEN (core
  // `clipAtInstant`): a body, a tracked layer or a driven move has no keys in
  // this frame's bake to sample, so reading `clip` at t ± ε put every sample
  // where the frame is and nothing driven ever smeared. A clip nothing derives
  // is its own answer at every instant, at no cost.
  const compAt = (t: number) => compMs + (t - localMs);
  const instant = (t: number) => (t === localMs ? { doc, clip } : clipAtInstant(doc, clip, compAt(t)));
  const cropPreview = options.cropPreviewClipId === clip.id;
  const geo = clipLocalGeometry(doc, ctx, frame, clip, localMs, cropPreview);
  const box = geo.box;
  const placeAt = (t: number) => {
    const at = instant(t);
    return layerPlacement(at.doc, ctx, frame, at.clip, t, box, cropPreview);
  };
  const placementAt = (t: number) => placeAt(t).matrix;
  // A step (a HOLD key here or in any ancestor) inside the shutter is two
  // pictures, not motion: the window keeps the frame's own side of it.
  const { openMs, closeMs } = cutShutterAtSteps(window0, localMs, (t) => boundsQuad(placementAt(t), geo.local), (a, b) => quadMotion(a, b).px);
  // Measured on the FRAME-TIME extent at both ends: this asks whether the LAYER
  // moved, and a crop edge travelling is not the layer travelling — smearing a
  // window that slid over a still picture would blur artwork that never moved.
  let motion = quadMotion(boundsQuad(placementAt(openMs), geo.local), boundsQuad(placementAt(closeMs), geo.local));
  // A text riding a path moves along it while its pose — the host's — stands
  // still, which the quad cannot see. Its travel along the curve joins the
  // measure here, so the significance test and the sample count both know.
  if (clip.kind === "text" && clip.path && pathTextSlides(clip)) {
    const plan = textDrawPlan(ctx, doc, clip, localMs).onPath;
    if (plan) {
      const travel = pathTextTravel(clip, plan.pl.length, openMs, closeMs);
      if (travel > motion.px) motion = { ...motion, px: travel };
    }
  }

  const plan = resolveShutter(
    { frameIntervalMs: interval, localMs, settings: resolved.settings, tier: resolved.tier, maxSamples: resolved.maxSamples, window: { openMs, closeMs } },
    motion,
  );
  if (!plan) return false;

  // THE SHUTTER REGION — the union of every quad this plan is about to paint,
  // grown by whatever the effect stack pushes past a silhouette.
  //
  // The union, and not the silhouette plus a travel distance. `motion.dx/dy` is
  // the mean corner displacement — the movement of the layer's CENTRE — and the
  // centre is exactly the point that stays put when a layer spins or scales
  // about its pivot: four corners fly outward, four deltas cancel, and the
  // region came out measured for a layer standing still. Every sample that
  // reached past the frame-time silhouette was then sliced off at the buffer
  // wall, which is what put straight cuts and hard corners on a spinning
  // rectangle and made a scale-up "crop past a certain size". Translation is
  // the one motion where the mean equals the excursion, which is why panning
  // never showed it.
  //
  // `shutterQuads` asks the plan where the layer actually lands — per tier, so
  // a `velocity` smear reserves the straight line it will draw and a
  // `transform` one reserves every degree it will — so the region is exact for
  // rotation, scale, skew, a pivoted swing and an in/out pose alike, with no
  // scalar left to be wrong in three directions at once.
  const C = ctx.getTransform();
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const feather = typeof sampled["feather"] === "number" ? (sampled["feather"] as number) : clip.feather;
  const baseQuad = boundsQuad(placementAt(localMs), geo.local);
  // What each sample actually paints. The two pose tiers BANK one render of the
  // frame-time layer and re-place those pixels, so their sample quad is the
  // frame-time extent moved; `content` re-renders the layer at the sample
  // instant, so a crop animating open inside the shutter interval is genuinely
  // wider there and the region has to hold the wider one.
  const quadAt = (t: number) => {
    const p = placeAt(t);
    return boundsQuad(p.matrix, plan.tier === "content" ? p.local : geo.local);
  };
  const swept = quadBounds(shutterQuads(plan, localMs, baseQuad, quadAt));
  // The effect stack's reach is a fact about the LAYER, so it is measured
  // against the layer's own span — not the swept one, which grows with speed.
  const pad = layerRegionPad(
    { effects: clip.effects, strokes: clip.strokes, textEffects: textEffectStacks(clip, localMs) },
    sampled,
    feather,
    boundsSpan(quadBounds([baseQuad])),
  );
  // `placementAt` already maps into frame-top-left space, so no centre offset
  // here — unlike `clipObjectBounds` above, which is measured about the centre.
  const whole = regionRect(swept, pad);
  // Integration is a weighted average — scale-exact — so it rasterises at
  // DEVICE resolution and stays as crisp as the layer it smears. Any pinned
  // effect inside gets its own document-scale region from `withLayer`.
  const zoom = (Math.hypot(C.a, C.b) + Math.hypot(C.c, C.d)) / 2 || 1;
  // SEEN, NOT WHOLE — the shutter's turn. A layer bigger than one buffer at
  // this zoom (a camera group magnified ×4 is twelve thousand pixels tall) was
  // integrated whole at a fraction of the output's resolution and drawn back
  // up, so every blurred zoom went blocky and snapped sharp at rest. Past the
  // cap, the region is cut to what can land on the target: the target itself,
  // and where each sample reads its banked pixels from (core `shutterSeenRect`).
  // Under the cap nothing changes.
  let cut: ReturnType<typeof shutterSeenRect> = null;
  if (Math.max(whole.width, whole.height) * zoom > MAX_LAYER_BUFFER_PX) {
    const seen = seenRect(C, ctx.canvas, pad + 2 / zoom, whole);
    if (seen) {
      const D = shutterDisplacements(plan, localMs, placementAt);
      const pullbacks: Affine2d[] = [];
      for (let k = 0; D.length && k <= 2 * D.length; k++) {
        const m = placementBetween(D, k / 2 - 0.5);
        if (!m.is2D || Math.abs(m.a * m.d - m.b * m.c) < 1e-12) continue;
        const v = m.inverse();
        pullbacks.push([v.a, v.b, v.c, v.d, v.e, v.f]);
      }
      cut = shutterSeenRect(whole, seen, pullbacks) ?? null;
    }
  }
  const { x: rectX, y: rectY, width: rectW, height: rectH } = cut ?? whole;
  const scale = Math.min(zoom, MAX_LAYER_BUFFER_PX / Math.max(rectW, rectH));
  const region = {
    width: pixelCount(rectW * scale),
    height: pixelCount(rectH * scale),
    matrix: new DOMMatrix([scale, 0, 0, scale, -rectX * scale, -rectY * scale]),
  };

  const t0 = options.profiler ? performance.now() : 0;
  // The `content` tier re-renders the subtree, so it claims the subtree: nested
  // comps and grouped children below it must not integrate again.
  const inner: DrawOptions = plan.tier === "content" ? { ...options, _inContentShutter: true } : options;

  // THE SCENE BENEATH IS A FACT ABOUT THE FRAME, NOT ABOUT THE SAMPLE.
  //
  // A material now floors at the `content` tier (see `shutterTierFloor`), which
  // means the layer is rendered once per sample — and each of those renders
  // asked for the scene beneath it, re-rendering every layer underneath from
  // the document. Sixteen samples, sixteen identical scenes. The samples differ
  // in where the LAYER is; what is behind it is the same picture every time.
  //
  // So it is rendered once, into the shutter's own region — the one space that
  // is stable across the whole integration — and each sample blits it into
  // whatever region its own isolation buffer happens to occupy. R⁻¹ composed
  // into the destination's CTM is the same re-projection the backdrop fallback
  // in `withLayer` does; both spaces are frame-space maps, so the composition
  // is exact rather than an approximation that drifts.
  let cachedBeneath: Scratch | null = null;
  const beneathOnce: SceneBeneath | undefined = beneath
    ? { key: null, refs: null, paint: (dst: CanvasRenderingContext2D) => {
        if (!cachedBeneath) {
          cachedBeneath = acquireScratch(region.width, region.height);
          cachedBeneath.ctx.save();
          cachedBeneath.ctx.setTransform(region.matrix);
          beneath.paint(cachedBeneath.ctx);
          cachedBeneath.ctx.restore();
        }
        dst.save();
        dst.setTransform(dst.getTransform().multiply(region.matrix.inverse()));
        dst.drawImage(cachedBeneath.canvas, 0, 0);
        dst.restore();
      } }
    : undefined;

  // ── THE KEPT SHUTTER ──────────────────────────────────────────────────────
  //
  // A layer in motion blur is N renders integrated into one region — the most
  // expensive picture a layer can have — and it never went through the layer
  // cache: every sample renders into a scratch buffer against a backdrop that
  // cannot be keyed, so a blurred layer (and anything glass moving fast enough
  // to smear) was re-integrated on every frame of every replay. The integrated
  // RESULT is the layer's picture at this instant; that is what is kept, keyed
  // by the instant, the plan, the region and the scene it refracts.
  //
  // Normal blend only: then compositing the finished smear is byte-identical
  // to painting it here. A layer that blends through keeps painting live.
  const playing = !!options.playing;
  const kept =
    !options.exporting &&
    !options.measureOnly &&
    matteDepth === 0 &&
    clip.blendMode === "normal" &&
    layerCacheReadable(doc, clip) &&
    (!readsBackdrop(clip) || beneath?.key != null);
  let keptKey = "";
  let keptRefs: unknown[] = [];
  const keptRect = { x: rectX, y: rectY, w: region.width / scale, h: region.height / scale };
  const drawKept = (canvas: HTMLCanvasElement) => ctx.drawImage(canvas, keptRect.x, keptRect.y, keptRect.w, keptRect.h);
  if (kept) {
    keptRefs = [frame, options._boxFrame ?? null];
    layerContentRefs(doc, clip, keptRefs);
    if (beneath?.refs) keptRefs.push(...beneath.refs);
    keptKey =
      `shutter|t${localMs}|${plan.tier}|${plan.samples.length}|${JSON.stringify(plan.settings)}` +
      `|${region.width}x${region.height}|${scale.toFixed(4)},${rectX.toFixed(3)},${rectY.toFixed(3)}` +
      `|${options.hitRects ? 1 : 0}${options.transparent ? 1 : 0}${options._inBackdrop ? 1 : 0}${options._onComposite ? 1 : 0}` +
      `|${options.overflowPass ?? ""}|${options.skipClipId ?? ""}|${options.cropPreviewClipId === clip.id ? 1 : 0}` +
      `|${focusLead(options, clip.id)}|${beneath?.key ?? ""}` +
      `|${options._scope ? scopeCacheKey(doc, frame.id, options._scope) : ""}` +
      lightsKey();
    const hit = readLayerCache(clip, keptKey, keptRefs, playing && !!options.footageLive);
    if (hit) {
      options.cacheHits?.add(clip.id);
      for (const r of hit.hits) pushHitRect(options, r);
      drawKept(hit.canvas);
      return true;
    }
  }
  const owned =
    kept && layerCacheAdmits(clip.id, playing, false, showsFootage(doc, clip, beneath), plan.samples.length)
      ? acquireLayerCanvas(clip, keptKey, region.width, region.height, {
          from: localMs,
          to: localMs,
          gridMs: frameStepMs(compFps(doc, frame.id)),
          // Only playback pictures are "cached" on a bar — a paused, full-res
          // buffer is an editing aid playback can never read.
          report: playing && !!options.hitRects && !options._inBackdrop && options.overflowPass !== "outside",
          evict: !playing,
          playing,
          family: keptKey,
        })
      : null;
  if (owned) owned.ctx.setTransform(region.matrix); // the region's own space: the smear lands 1:1
  const keptFaults = owned ? pictureFaults() : null;
  const keptCapture = owned ? beginHitCapture(options._hitSpace) : null;
  const closeKeptUnit = owned && playing ? enterKeptUnit() : null;

  const painted = paintShutter({
    ctx: owned ? owned.ctx : ctx,
    region,
    plan,
    localMs,
    acquire: acquireScratch,
    placementAt,
    renderLayer: (target, t) => {
      const at = instant(t);
      withLayer(
        target,
        at.doc,
        frame,
        at.clip,
        t,
        resolve,
        (tctx) => draw(tctx, t, at, compAt(t)),
        inner,
        undefined,
        // `target` is a scratch buffer, so the scene behind the layer is NOT
        // under it — it is still on the real composite. Materials read that,
        // unless the caller can render the scene beneath properly.
        ctx,
        beneathOnce,
      );
    },
  });
  if (cachedBeneath) (cachedBeneath as Scratch).busy = false;
  closeKeptUnit?.();
  if (keptCapture) endHitCapture(keptCapture);
  if (owned) {
    if (!painted) return false;
    if (keptFaults && faithfulSince(keptFaults, !playing)) {
      owned.commit(keptRefs, keptRect, keptCapture?.rects ?? [], faithfulSince(keptFaults), drewFootageSince(keptFaults));
    }
    drawKept(owned.canvas);
  }
  if (options.profiler && painted) {
    options.profiler.motionBlur(clip.id, performance.now() - t0, plan.samples.length);
  }
  return painted;
}

// ── Particles ────────────────────────────────────────────────────────────────

/**
 * A layer's PARTICLES, painted right above it — at its place in the stack,
 * in comp space (they left the layer; its transform no longer moves them).
 * Read from the raw document's simulation (the per-instant bake shares it),
 * so preview and export draw the same run the hit sounds hear.
 */
function paintEmitted(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  local: number,
  timeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
  behind: boolean,
): void {
  if (!clip.emitters?.length || frame.world || options.measureOnly) return;
  if (!clip.emitters.some((e) => e.enabled && e.behind === behind)) return;
  const sets = flatParticles(bakeSourceOf(doc), clip.frameId, timeMs).filter((p) => p.layer === clip.id && p.count > 0);
  if (!sets.length) return;
  const baked = bakeClipAt(clip, local);
  for (const set of sets) {
    const spec = baked.emitters?.[set.index];
    if (!spec?.enabled || spec.behind !== behind) continue;
    const sprite = spec.shape === "layer" && spec.instance ? particleSprite(ctx, doc, frame, spec.instance, timeMs, spec.size * Math.max(1, spec.grow), options, resolve, guard) : null;
    // Seen at a tilt, through a lens: drawn where their light lands, not where they are.
    const view = viewsParticles(spec) ? flatParticleView(bakeSourceOf(doc), clip.frameId, timeMs, clip.id, set.index) : null;
    const seen = view ? viewParticles(set, spec, view.origin, view.fields) : set;
    paintParticles(ctx, frame, seen, { spec, sprite: sprite?.canvas ?? null, spriteAspect: sprite?.aspect ?? 1 }, resolve);
  }
}

/**
 * A layer's picture, small, centred — what `shape: "layer"` stamps once per
 * particle. Drawn at the instant through the layer's own painter with its
 * placement reset (its keys still play: an animated sticker animates on every
 * particle). Its effects are not drawn on particles. One per frame per layer.
 */
function particleSprite(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  instanceId: string,
  timeMs: number,
  sizeUnits: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
): { canvas: HTMLCanvasElement; aspect: number } | null {
  const loc = locateClip(doc, instanceId);
  if (!loc || loc.clip.kind === "audio" || loc.clip.kind === "group") return null;
  const raw = loc.clip as VisualClip;
  const local = Math.max(0, Math.min(raw.durationMs - 1, timeMs - raw.startMs));
  const C = ctx.getTransform();
  const zoom = (Math.hypot(C.a, C.b) + Math.hypot(C.c, C.d)) / 2 || 1;
  const box = clipBox(doc, raw);
  const longest = Math.max(1, box.width, box.height);
  const px = Math.max(8, Math.min(512, Math.ceil(sizeUnits * zoom)));
  const key = `${instanceId}|${local}|${px}|${options.playing ? 1 : 0}`;
  const hit = spriteMemo.get(doc)?.get(key);
  if (hit) return hit;
  const k = px / longest;
  const w = pixelCount(box.width * k), h = pixelCount(box.height * k);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const sctx = canvas.getContext("2d");
  if (!sctx) return null;
  const baked = bakeClipAt(raw, local);
  const placement = new Set(["x", "y", "rotation", "scale", "scaleY", "skewX", "skewY", "anchor.x", "anchor.y", "opacity"]);
  const centred = {
    ...baked,
    hidden: false,
    opacity: 1,
    transform: { ...baked.transform, x: 0, y: 0, rotation: 0, scale: 1, scaleY: null, skewX: 0, skewY: 0, anchor: { x: 0.5, y: 0.5 } },
    keyframes: baked.keyframes.filter((t) => !placement.has(t.property)),
  } as VisualClip;
  sctx.setTransform(k, 0, 0, k, w / 2 - (frame.width / 2) * k, h / 2 - (frame.height / 2) * k);
  dispatchDrawClip(sctx, doc, frame, centred, local, { ...options, hitRects: undefined }, resolve, guard, timeMs);
  const out = { canvas, aspect: box.width / Math.max(1e-6, box.height) };
  let memo = spriteMemo.get(doc);
  if (!memo) spriteMemo.set(doc, (memo = new Map()));
  if (memo.size > 64) memo.clear();
  memo.set(key, out);
  return out;
}

const spriteMemo = new WeakMap<MotionDocument, Map<string, { canvas: HTMLCanvasElement; aspect: number }>>();

/**
 * Where the layer sits, in FRAME coordinates, at one instant — transform pose
 * composed with the in/out animation pose — and what it PAINTS there.
 *
 * Frame-top-left origin, matching the CTM `drawFrameContent` establishes, so a
 * delta built from two of these can be conjugated by the canvas transform
 * without a second origin convention to get wrong. The pivot box is passed in,
 * taken once at the frame time rather than re-measured per sample: it is the
 * rectangle the pivot is a fraction of, and re-laying out a text block per
 * sub-sample would cost more than the blur. The extent comes back with the
 * matrix because it is sampled — a keyframed crop is a different rectangle at
 * every instant — and the caller measuring a region needs both halves at once.
 */
function layerPlacement(
  doc: MotionDocument,
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  clip: VisualClip,
  localMs: number,
  /** The pivot box; omitted = the layer's own at this instant. */
  box?: LayerBox,
  cropPreview = false,
  compTimeMs?: number,
): { matrix: DOMMatrix; local: ObjectBounds } {
  const geo = clipLocalGeometry(doc, ctx, frame, clip, localMs, cropPreview, compTimeMs);
  const { pose, local } = geo;
  const M = new DOMMatrix().translate(frame.width / 2, frame.height / 2).multiply(poseMatrix(pose, box ?? geo.box));
  const anim = layerPoseAt(clip, localMs);
  if (isIdentityPose(anim)) return { matrix: M, local };
  // The in/out pose is applied about the layer's POSITION in frame space —
  // the same pivot `withLayer` uses when it composites an animating layer, so
  // the two cannot describe different arcs.
  const ax = frame.width / 2 + pose.x;
  const ay = frame.height / 2 + pose.y;
  const matrix = new DOMMatrix()
    .translate(ax + anim.dx, ay + anim.dy)
    .rotate(anim.rotation)
    .scale(anim.scale)
    .translate(-ax, -ay)
    .multiply(M);
  return { matrix, local };
}

/**
 * The four corners of what a layer PAINTS, under a placement matrix — the input
 * to `quadMotion` and to the shutter region.
 *
 * The extent, never the pivot box: they are the same rectangle only for an
 * uncropped layer whose ink fills its box, and the region is sized from this,
 * so handing it the box would reserve room around the wrong rectangle. Core's
 * `poseQuad` is the same function for callers that hold a pose instead of a
 * matrix; this one exists because a stage placement is a PRODUCT of matrices
 * (pose · in/out pose · transition pose), which no `LayerPose` can express.
 */
function boundsQuad(m: DOMMatrix, b: ObjectBounds): Quad {
  return [
    m.transformPoint({ x: b.minX, y: b.minY }),
    m.transformPoint({ x: b.maxX, y: b.minY }),
    m.transformPoint({ x: b.maxX, y: b.maxY }),
    m.transformPoint({ x: b.minX, y: b.maxY }),
  ].map((p) => ({ x: p.x, y: p.y })) as Quad;
}

function paintLayerNode(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  node: LayerTreeNode,
  timeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
): void {
  // A RIG: a unit that rides a bone is placed by it — one more delta on the
  // way down, on the canvas and on the hit space alike (core `unitSkin2d`,
  // the same matrix `groupChainMatrix` hands every control). A vector that
  // bends is drawn as its bent self.
  if (!frame.world && documentHasRigs(doc) && nodePaints(node, options)) {
    const localOf = (c: Clip) => nodeLocalOf(doc, frame, c, timeMs, options);
    const S = unitSkin2d(doc, node.clip.id, localOf);
    if (S) {
      const cx = frame.width / 2, cy = frame.height / 2;
      const D = matMultiply(matMultiply(matTranslate(cx, cy), { a: S[0]!, b: S[1]!, c: S[4]!, d: S[5]!, e: S[12]!, f: S[13]! }), matTranslate(-cx, -cy));
      ctx.save();
      ctx.transform(D.a, D.b, D.c, D.d, D.e, D.f);
      paintLayerNodeRigged(ctx, doc, frame, node, timeMs, withDeltaHitSpace(options, D), resolve, guard);
      ctx.restore();
      return;
    }
  }
  paintLayerNodeRigged(ctx, doc, frame, node, timeMs, options, resolve, guard);
}

/** A node after its bone placement: a bending vector swaps in its bent self. */
function paintLayerNodeRigged(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  node: LayerTreeNode,
  timeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
): void {
  if (node.type === "clip" && (node.clip.kind === "path" || node.clip.kind === "shape") && !frame.world && documentHasRigs(doc) && nodePaints(node, options)) {
    const localOf = (c: Clip) => nodeLocalOf(doc, frame, c, timeMs, options);
    const bend = bend2d(doc, node.clip.id, localOf);
    if (bend) {
      const C = ctx.getTransform();
      const t = node.clip.transform;
      const zoom = (Math.hypot(C.a, C.b) || 1) * Math.max(Math.abs(t.scale), Math.abs(t.scaleY ?? t.scale), 0.01);
      node = { ...node, clip: bentVectorClip(node.clip, localOf(node.clip), bend, 0.35 / zoom) };
    }
  }
  // A member of an auto layout gliding to a new slot (see `layout-motion`):
  // drawn offset in its container's space for the moment it takes to arrive.
  // Presentation only — never in a file, and the layout itself is already true.
  const nudge = options.exporting ? null : layoutNudgeAt(node.clip.id);
  if (nudge) {
    ctx.save();
    ctx.translate(nudge.x, nudge.y);
    paintLayerNodeMeasured(ctx, doc, frame, node, timeMs, options, resolve, guard);
    ctx.restore();
    return;
  }
  paintLayerNodeMeasured(ctx, doc, frame, node, timeMs, options, resolve, guard);
}

function paintLayerNodeMeasured(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  node: LayerTreeNode,
  timeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
): void {
  // PER-LAYER COST. Bracketed here, and nowhere else, because this is the one
  // function every layer in the app passes through — the same property that
  // made the shutter's call site obvious. Off, it is one truthiness check per
  // layer; on, it is the honest answer to "what is making this slow", which no
  // amount of GPU guesswork would give us.
  const profiler = options.profiler;
  if (!profiler) {
    paintLayerNodeProfiled(ctx, doc, frame, node, timeMs, options, resolve, guard);
    return;
  }
  // ONLY LAYERS THAT ACTUALLY PAINT ARE REPORTED, and that matters far more
  // than it looks. `frameLayerTree` contains every clip in the comp regardless
  // of time — the time gate lives inside `paintLayerNodeInner` — so bracketing
  // unconditionally would name every clip in the document as a contributor to
  // every cached frame, and the frame cache's invalidation would collapse back
  // into "clear everything on any edit", which is the one thing it exists not
  // to be. `nodeDrawable` is the renderer's own answer to "does this node put
  // anything on screen at this instant", recursive through groups, so the
  // contributor list is the picture rather than a model of it.
  // A HIDDEN LAYER CONTRIBUTES NOTHING, and must not be recorded as though it
  // did. A contributor list naming layers that painted no pixels is a cache
  // that throws away good frames whenever one of them is touched — and hiding
  // a heavy layer is the exact thing a person does to make an editor faster.
  //
  // A GROUP is asked the CHEAP half of the question only: its own row, its own
  // hidden flag, its own window. `nodeDrawable` recurses a group's whole
  // subtree, which is O(layers x depth) on every frame of every drag, and the
  // expensive half only distinguishes "this group is empty right now" from
  // "this group is showing" — being generous about that over-invalidates by at
  // most the number of groups in the document. Being generous about HIDDEN
  // over-invalidates by the layers a person deliberately took out of the
  // picture, which is the opposite of what they asked for.
  if (!nodeAttends(doc, frame, node, timeMs, options)) {
    paintLayerNodeProfiled(ctx, doc, frame, node, timeMs, options, resolve, guard);
    return;
  }
  const t0 = performance.now();
  paintLayerNodeProfiled(ctx, doc, frame, node, timeMs, options, resolve, guard);
  profiler.layer(node.clip.id, node.clip.name, performance.now() - t0, {
    scale: options.previewScale ?? 1,
    // A GROUP is reported alongside its children, and its bracket encloses
    // them — so a group's number is its whole subtree's cost, which is the
    // number a person actually needs: a group is where the expensive things
    // hide, and a flat list of leaves is exactly where they hide from.
    source: options.cacheHits?.has(node.clip.id) ? "cached" : "rendered",
  });
}

function paintLayerNodeProfiled(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  node: LayerTreeNode,
  timeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
): void {
  // `#layer.*` is scoped to the clip being painted. Wrapping the whole body once
  // is what makes that safe: the function below returns early in a dozen places,
  // and a set/restore pair around any of them would eventually miss one.
  if (node.type === "clip") {
    // THE SAME PROPERTY, USED TWICE MORE. Because every layer passes through
    // here, this is also where a layer becomes the SUBJECT of anything that
    // goes wrong inside it — so a failure three levels down in an effect kernel
    // reports as "Clip “Title”" without a single call site being handed an id —
    // and where one bad layer is stopped from taking the whole frame with it.
    const paint = () =>
      doc.expressions.length > 0
        ? withExpressionLayer(exprLayerFor(doc, node.clip, node.trackIndex), () =>
            paintLayerNodeInner(ctx, doc, frame, node, timeMs, options, resolve, guard),
          )
        : paintLayerNodeInner(ctx, doc, frame, node, timeMs, options, resolve, guard);
    paintIsolated(ctx, clipSubject(node.clip), paint);
    return;
  }
  paintLayerNodeInner(ctx, doc, frame, node, timeMs, options, resolve, guard);
}

/**
 * One layer's `EntityRef`, memoised on the clip object itself.
 *
 * Clips are immutable, so a `WeakMap` keyed on the object means the steady
 * state allocates NOTHING — which matters, because this is on the per-layer,
 * per-frame path and an object literal here would be thousands of short-lived
 * allocations a second for a label almost nobody reads.
 */
const CLIP_SUBJECTS = new WeakMap<Clip, EntityRef>();

function clipSubject(clip: Clip): EntityRef {
  let ref = CLIP_SUBJECTS.get(clip);
  if (!ref) {
    ref = entityRef("clip", clip.id, clip.name);
    CLIP_SUBJECTS.set(clip, ref);
  }
  return ref;
}

/**
 * A canvas state marker no real drawing code sets, used to unwind an unbalanced
 * `save()` stack. 10 is the spec default for `miterLimit`; this is not 10.
 */
const UNWIND_SENTINEL = 10.000001;
/** A layer nested deeper than this has a different problem. */
const MAX_UNWIND = 64;

/**
 * Paint one layer so that a throw inside it costs that LAYER and not the frame.
 *
 * Before this, an effect that divided by zero on one clip left the canvas blank
 * and the console screaming sixty times a second, with nothing naming the clip.
 * Now the layer is skipped, reported ONCE (the error bus folds the repeats), and
 * everything else still draws — which is both what a person expects and what
 * makes the broken layer identifiable: it is the missing one.
 *
 * The delicate part is the canvas state. A body that throws between its own
 * `save()` and `restore()` leaves the stack unbalanced, and every layer painted
 * afterwards inherits the wrong clip, transform and alpha — a far worse failure
 * than the original, and one that looks like a renderer bug. There is no API for
 * "how deep is the stack", so we mark our own level with a value nothing else
 * writes and pop until it is gone. Bounded, so a pathological case ends.
 */
function paintIsolated(ctx: CanvasRenderingContext2D, subject: EntityRef, paint: () => void): void {
  ctx.save();
  const outerMiter = ctx.miterLimit;
  ctx.miterLimit = UNWIND_SENTINEL;
  try {
    withSubject(subject, paint);
  } catch (err) {
    reportError(err, { phase: "paint" });
    for (let i = 0; i < MAX_UNWIND; i++) {
      ctx.restore();
      if (ctx.miterLimit !== UNWIND_SENTINEL) return;
    }
    return;
  }
  ctx.restore();
  ctx.miterLimit = outerMiter;
}

function paintLayerNodeInner(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  node: LayerTreeNode,
  timeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
): void {
  if (node.type === "clip") {
    const tt = clipNodeTime(doc, frame, node, timeMs, options);
    if (tt === null) return;
    // Gap-fill: a footage clip HOLDS a still across an adjacent timeline gap
    // (prefer the next clip's first frame, else the last clip's final frame) so
    // a montage never flashes transparent between shots. Overlays get null in a
    // gap (honest transparency) exactly as before.
    const track = doc.tracks[node.trackIndex];
    const rl = track ? clipRenderLocalTime(track, node.clip, tt, options.clipEnds) : null;
    if (!rl) return;
    const local = rl.local;
    // An "all" reach processor grades the finished frame from any z-position, so
    // it — and any cut over it — is resolved by the post-pass in
    // `drawFrameContent`, never inline. Bailing here rather than after the
    // transition check is what keeps a frame-wide grade from jumping to its
    // z-position for the length of a transition.
    if (node.clip.kind === "adjustment" && node.clip.scope.reach === "all") return;
    // A cut transition is painted ONCE, by whichever participant is live at
    // this instant — before the cut that is the outgoing clip, after it the
    // incoming one. The other participant's node is outside its own span and
    // has already returned at the time gate above, so the pair can never paint
    // twice and no cross-node bookkeeping is needed. Layer-scoped draws (mattes,
    // adjustment reach) opt out: they want the clip itself, not the mix.
    if (!options.only && track) {
      const active = activeTransitionAt(track, frame.id, tt);
      if (active && (active.transition.aClipId === node.clip.id || active.transition.bClipId === node.clip.id)) {
        renderTransition(
          ctx, doc, frame, track, active.transition, active.progress, tt, timeMs, options, resolve, guard,
        );
        return;
      }
    }

    // A processor paints no content — it grades what it reaches, at its own
    // z-position, wearing whatever its in/out animation is doing right now.
    if (node.clip.kind === "adjustment") {
      renderAdjustment(
        ctx, doc, frame, node.clip, local, timeMs, resolve, options, guard,
        layerAnimMix(node.clip, local),
      );
      return;
    }

    // A LAYER BENDING WITH ITS RIG (anything not a vector — those are drawn
    // as their bent selves above): its picture through its weight grid.
    if (!frame.world && node.clip.kind !== "group" && node.clip.kind !== "path" && node.clip.kind !== "shape" && documentHasRigs(doc)) {
      const bend = bend2d(doc, node.clip.id, (c) => nodeLocalOf(doc, frame, c, timeMs, options));
      if (bend && paintBentPicture(ctx, doc, frame, node.clip, local, timeMs, bend, options)) return;
    }

    // A 2D LAYER WITH DEPTH (`z`, a tilt) in a flat comp: the same picture,
    // standing in the comp's 3D space, seen by its default camera. Groups and
    // worlds are not asked — a world places its own layers, and a group's
    // members carry their own depth.
    if (!frame.world && node.clip.kind !== "group") {
      const depth = layerDepthAt(node.clip, local);
      if (depth && paintDepthLayer(ctx, doc, frame, node.clip, local, timeMs, depth, options)) return;
    }

    // THE SHUTTER. Tried first, and it declines cheaply (three switch checks
    // and one displacement measurement) whenever this layer is not blurring or
    // is not moving — so the ordinary path below is what almost every layer of
    // almost every frame still takes.
    const drawAt = (tctx: CanvasRenderingContext2D, t: number, at: { doc: MotionDocument; clip: VisualClip }, atCompMs: number) =>
      dispatchDrawClip(tctx, at.doc, frame, at.clip, t, options, resolve, guard, atCompMs);
    const beneath = sceneBeneath(doc, frame, node.clip, timeMs, options, resolve, guard);
    // Particles that go behind their layer (a ball's trail) first, the rest over it.
    paintEmitted(ctx, doc, frame, node.clip, local, timeMs, options, resolve, guard, true);
    if (paintClipShutter(ctx, doc, frame, node.clip, local, options, resolve, drawAt, beneath, timeMs)) {
      paintEmitted(ctx, doc, frame, node.clip, local, timeMs, options, resolve, guard, false);
      return;
    }

    withLayer(
      ctx,
      doc,
      frame,
      node.clip,
      local,
      resolve,
      (tctx) => dispatchDrawClip(tctx, doc, frame, node.clip, local, options, resolve, guard, timeMs),
      // A card riding a vector's drawn outline reads an enclosing group's
      // draw-on, which runs on the comp's clock.
      wantsOutline(node.clip.effects) ? { ...options, _compTimeMs: timeMs } : options,
      undefined,
      undefined,
      beneath,
    );
    paintEmitted(ctx, doc, frame, node.clip, local, timeMs, options, resolve, guard, false);
    return;
  }

  // A GROUP. Its own lane decides when it paints, its own transform places what
  // it holds, and its own paint/effects/stroke wear the finished result — all of
  // which it gets by BEING a clip, through the same `withLayer` seam every other
  // layer uses. There is no group-specific opacity, blend, effect or feather
  // code below, and that is the point of the model.
  const group = node.clip;
  // A group that gives off light is a light all through: the light pass paints
  // it whole, members and look alike, and the unlit pass leaves it out.
  if (lightPass !== "all" && group.emitsLight) {
    const inside = lightPassInside(group);
    if (inside) withLightPass(inside, () => paintLayerNodeInner(ctx, doc, frame, node, timeMs, options, resolve, guard));
    return;
  }
  const groupTrack = doc.tracks[node.trackIndex];
  if (!groupTrack || groupTrack.hidden || (group.hidden && !options.includeHidden)) return;
  // A layer-scoped draw that names NOTHING inside this group draws none of it.
  // Without this the group still ran its whole look over an empty buffer — and
  // `paintGroupStroke` measures its silhouette from the DOCUMENT, so a slice
  // holding none of the members still painted the outline of all of them. That
  // ghost outline, baked into the drag fast path's bread, is "the stroke stays
  // behind while I move what is inside the group".
  if (options.only && !options.only.has(group.id) && !node.clipIds.some((id) => options.only!.has(id))) return;
  // An option its switch does not show paints nothing inside it.
  if (hiddenBySwitch(doc, groupTrack, group, timeMs)) return;
  const groupTime = trackLocalTime(groupTrack, frame.id, timeMs);
  const groupLocal = clipRenderLocalTime(groupTrack, group, groupTime, options.clipEnds);
  // THE WINDOW: outside the group's own span nothing inside it paints. This is
  // what makes trimming a group mean something — and it is one check here rather
  // than a condition every member would have to carry.
  if (!groupLocal) return;

  // Layer-scoped draws: a composite group only composites when EVERY member is
  // included — a partial pick paints flat (see DrawOptions.only).
  const mode: GroupMode =
    options.only && !node.clipIds.every((id) => options.only!.has(id)) ? "pass" : group.mode;

  // THE GROUP'S TRANSFORM, AS A MATRIX — built once and used twice: to place
  // the canvas, and to place the hit rects of everything inside. Two
  // derivations here is the bug the whole file keeps having: the artwork moved
  // and its selection box, its gizmo and its vector nodes stayed behind.
  const delta = groupDeltaAt(doc, frame, group, groupLocal.local);
  const inner = delta ? withGroupHitSpace(options, group, groupLocal.local, delta) : options;
  // ALWAYS, delta or not. An identity pose is still a placement — it is the one
  // every group has before you touch it — and gating the rect on `delta` meant a
  // freshly selected group had no box, no handles and nothing to resize, until
  // the first nudge gave it a non-identity pose and the chrome appeared out of
  // nowhere. `null` here means "identity", not "nowhere".
  pushGroupHitRect(doc, frame, group, groupLocal.local, timeMs, delta, options);

  // What the group holds, painted at one instant of its own (`gLocal`) and of
  // the comp (`compMs`): the frame's, or a shutter sample's.
  const paintInsideAt = (tctx: CanvasRenderingContext2D, gLocal: number, compMs: number) => {
    const atFrame = gLocal === groupLocal.local;
    const d = atFrame ? delta : groupDeltaAt(doc, frame, group, gLocal);
    const opts = atFrame ? inner : d ? withGroupHitSpace(options, group, gLocal, d) : options;
    // The stroke lives INSIDE the group's transform, with the children.
    //
    // It used to be drawn after it, in raw frame coordinates, and that is one
    // shape of bug: the silhouette is measured from where the members are in
    // the document, and the group transform is a DELTA the renderer applies on
    // top — so moving, scaling or rotating a group carried the artwork and left
    // its outline behind. An outline of a thing travels with the thing; there
    // is no version of this where the two are placed by different code.
    withGroupTransform(tctx, d, () => {
      // A laid-out group IS a box (relations/layout.ts): its fills paint that
      // box behind the members, its strokes outline it, and — with clip on —
      // the members are masked to it. That is the whole of what makes it a
      // Figma frame rather than a group with a tint.
      const layoutBox = group.layout ? groupBoxRect(doc, frame, group) : null;
      if (layoutBox) paintLayoutBox(tctx, group, gLocal, layoutBox, resolve);
      const paintMembers = () => paintGroupChildren(tctx, doc, frame, node, mode, compMs, opts, resolve, guard);
      if (layoutBox && group.layout?.clipContent) {
        tctx.save();
        roundRect(tctx, layoutBox.x, layoutBox.y, layoutBox.w, layoutBox.h, sampledRadius(group, gLocal));
        tctx.clip();
        paintMembers();
        tctx.restore();
      } else {
        paintMembers();
      }
      // OVER the combined result, under the outline of it: the group's fill
      // recolours the picture its members made (`paintGroupTint`), and its
      // stroke runs around that picture rather than around any one member. A
      // container is the exception at both ends — its fill is the box behind,
      // its stroke the box's outline, both painted above.
      if (!layoutBox) {
        paintGroupTint(tctx, doc, frame, group, gLocal, resolve);
        paintGroupStroke(tctx, doc, frame, group, gLocal, compMs, resolve);
      }
    });
  };
  const paintInside = (tctx: CanvasRenderingContext2D) => paintInsideAt(tctx, groupLocal.local, timeMs);

  // THE SHUTTER, as for any layer: a group is a clip, and its own motion (its
  // keys, its in/out pose) smears what it holds. Without this only a member's
  // motion relative to the group blurred, so a keyed group of tiles flew past
  // razor sharp. Members measure their placement inside the group's space, so
  // nothing is blurred twice. Tried before the free path below: a group keyed
  // through identity is moving on that frame even though its pose is identity.
  const groupOptions = { ...options, _compTimeMs: timeMs };
  // THE SCENE BEHIND THE GROUP. A group carrying a material — glass on the
  // whole group rather than on one member, which is the entire point of a group
  // being a surface — used to get no backdrop painter at all: `sceneBeneath`
  // could not find a group in paint order, and this call site never asked. It
  // fell through to "project whatever is on the composite", which happens to
  // look right on the stage (the composite IS the frame there) and is wrong
  // anywhere the composite is a buffer. It also made the group permanently
  // uncacheable, because a layer that reads a backdrop it cannot describe
  // cannot say when its pixels went stale — so the heaviest layer in a document
  // was the one layer the cache could never help.
  const groupBeneath = sceneBeneath(doc, frame, group, timeMs, options, resolve, guard);
  if (paintClipShutter(ctx, doc, frame, group, groupLocal.local, groupOptions, resolve, (tctx, t, _at, atCompMs) => paintInsideAt(tctx, t, atCompMs), groupBeneath, timeMs)) return;

  // A plain group with nothing of its own still costs exactly nothing: no
  // buffer, no matrix, straight onto the composite, byte for byte what a
  // pre-v66 `pass` group did.
  // `delta == null` rather than `groupHasTransform`: the pose is SAMPLED, so a
  // group that animates out of identity takes the slow path on the frames where
  // it actually moves instead of only when its base transform is non-default.
  // A laid-out group with a box to paint (or a mask to apply) is never the
  // free path: there is something of its own to draw.
  const boxed = !!group.layout && (group.fills.length > 0 || group.strokes.length > 0 || group.layout.clipContent);
  if (mode === "pass" && !groupNeedsIsolation(group) && delta == null && !boxed) {
    paintLayerNodes(ctx, doc, frame, node.children, timeMs, inner, resolve, guard);
    return;
  }

  withLayer(ctx, doc, frame, group, groupLocal.local, resolve, paintInside, groupOptions, undefined, undefined, groupBeneath);
  return;
}

/** The group's own transform, applied to everything inside it.
 *
 * A DELTA about the group's pivot, never a coordinate space of its own: members
 * are placed in frame coordinates and stay that way, so moving a group moves
 * what you see and the members' own x/y still say where they are. (A nested comp
 * is the opposite — its children live in ITS frame — which is exactly the
 * difference between the two containers.) */
function withGroupTransform(
  ctx: CanvasRenderingContext2D,
  delta: Mat2D | null,
  paint: () => void,
): void {
  if (!delta) {
    paint();
    return;
  }
  ctx.save();
  ctx.transform(delta.a, delta.b, delta.c, delta.d, delta.e, delta.f);
  paint();
  ctx.restore();
}

/**
 * The group's transform as a delta in the FRAME-TOP-LEFT coordinates this
 * renderer paints in — core's one answer, conjugated by half the frame.
 *
 * The matrix itself used to be written out here, which made the renderer the
 * only thing in the app that knew where a grouped layer is. Every on-canvas
 * control asked the comp chain instead and landed a whole group-delta away
 * from the artwork. It lives in `group-space.ts` now; this is the half-frame
 * step between that module's LOCAL (frame centre, where `transform.x/y` is
 * written) and the top-left origin the canvas is in.
 */
function groupDeltaAt(doc: MotionDocument, frame: Frame, group: GroupClip, localMs: number): Mat2D | null {
  const m = groupDeltaMatrix(doc, group, localMs);
  if (!m) return null;
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  return matMultiply(matMultiply(matTranslate(cx, cy), m), matTranslate(-cx, -cy));
}

/**
 * Will this node paint in this draw at all? A layer-scoped draw (`only`)
 * walks nodes it will not paint; asking their rig how to place them would be
 * work for nothing — and a member's silhouette is drawn by exactly such a
 * draw of the member alone, so asking would recurse through every member.
 */
function nodePaints(node: LayerTreeNode, options: DrawOptions): boolean {
  const only = options.only;
  if (!only) return true;
  return node.type === "clip" ? only.has(node.clip.id) : only.has(node.clip.id) || node.clipIds.some((id) => only.has(id));
}

/** A clip's local time at a comp instant, as the renderer paints it (its lane's time, retimed). */
function nodeLocalOf(doc: MotionDocument, frame: Frame, clip: Clip, timeMs: number, options: DrawOptions): number {
  const track = locateClip(doc, clip.id)?.track;
  if (!track) return timeMs - clip.startMs;
  return clipRenderLocalTime(track, clip, trackLocalTime(track, frame.id, timeMs), options.clipEnds)?.local ?? timeMs - clip.startMs;
}

/** Options for what a bone places: its delta on the hit space, so the selection box rides with the pixels. */
function withDeltaHitSpace(options: DrawOptions, delta: Mat2D): DrawOptions {
  const outer = options._hitSpace;
  if (!options.hitRects || !outer) return options;
  return {
    ...options,
    _hitSpace: {
      m: matMultiply(outer.m, delta),
      scaleX: outer.scaleX * Math.hypot(delta.a, delta.b),
      scaleY: outer.scaleY * Math.hypot(delta.c, delta.d),
      rotation: outer.rotation + (Math.atan2(delta.b, delta.a) * 180) / Math.PI,
      depth: outer.depth,
    },
  };
}

/** Options for everything INSIDE a transformed group: the same delta, on the
 *  hit space, so a member's selection box travels with its pixels. */
function withGroupHitSpace(
  options: DrawOptions,
  group: GroupClip,
  localMs: number,
  delta: Mat2D,
): DrawOptions {
  const outer = options._hitSpace;
  if (!options.hitRects || !outer) return options;
  const pose = evaluateBoxPose(group, localMs);
  return {
    ...options,
    _hitSpace: {
      m: matMultiply(outer.m, delta),
      scaleX: outer.scaleX * (pose.scale || 1),
      scaleY: outer.scaleY * (pose.scaleY || pose.scale || 1),
      rotation: outer.rotation + pose.rotation,
      depth: outer.depth,
    },
  };
}

/**
 * A rect for the GROUP ITSELF, so it gets the same selection box, gizmo and
 * transform readout every other layer has.
 *
 * A composite group had none at all: you could move it from the inspector and
 * see nothing on the canvas describing what you were moving. Its box is its
 * members' combined bounds carried through its own delta — the same matrix that
 * placed the pixels, so the outline is around the artwork by construction.
 */
function pushGroupHitRect(
  doc: MotionDocument,
  frame: Frame,
  group: GroupClip,
  localMs: number,
  /** COMP time — what the MEMBERS are measured at, exactly as the stroke is. */
  timeMs: number,
  /** The group's own delta, or `null` for the identity pose every group starts at. */
  delta: Mat2D | null,
  options: DrawOptions,
): void {
  if (!options.hitRects) return;
  const pose = evaluateBoxPose(group, localMs);
  // LIVE, not authored. A group is the one layer whose size is derived from
  // other layers, so it is the one layer whose box can be wrong about time —
  // and reading `clipBox` here left the selection box, the gizmo and the W/H
  // readout welded to where the members were before anything animated or was
  // dragged. `groupBoxAt` measures them where they are now, at the same instant
  // `paintGroupStroke` measures the outline, so box and outline agree.
  const box = groupBoxAt(doc, group, timeMs);
  const centre = { x: frame.width / 2 + box.cx, y: frame.height / 2 + box.cy };
  const c = delta ? applyMat(delta, centre) : centre;
  pushHitRect(options, {
    clipId: group.id,
    frameId: group.frameId,
    hostFrameId: options.hostFrameId ?? group.frameId,
    cx: c.x,
    cy: c.y,
    width: hitExtent(box.width, pose.scale, 24),
    height: hitExtent(box.height, pose.scaleY || pose.scale, 24),
    rotation: pose.rotation,
    skewX: 0,
    skewY: 0,
  });
}

/**
 * The group's own box in frame-top-left coordinates, before its delta — its
 * members' combined bounds, which is the only box a group has.
 *
 * Two readers, one answer: it is the rect a CONTAINER paints as its background
 * and the rect a plain group's TINT measures its gradient across. The gradient
 * spanning this box rather than each member's is the whole point of painting
 * the tint over the finished picture (see `groupTintFills`), and it is
 * deliberately the DOCUMENT box, not a per-frame silhouette, so a ramp laid
 * across a logo does not crawl as the logo animates.
 */
function groupBoxRect(doc: MotionDocument, frame: Frame, group: GroupClip): PaintBounds | null {
  const box = clipBox(doc, group);
  if (!box) return null;
  return {
    x: frame.width / 2 + box.cx - box.width / 2,
    y: frame.height / 2 + box.cy - box.height / 2,
    w: box.width,
    h: box.height,
  };
}

/**
 * THE GROUP'S TINT: its fills painted OVER the members' finished pixels,
 * masked by their alpha.
 *
 * This is what makes a group a surface. The paint lands on whatever the group
 * turned out to be — text, a photo, a nested sub-group, a boolean composite —
 * so it overrides every descendant's own fill without touching it, and one
 * gradient spans the whole group instead of being re-run inside each member's
 * box. Drop a layer out of the group and its own paint is simply there again:
 * nothing was ever written.
 *
 * Two compositing paths, because a fill entry carries a blend mode and canvas
 * blending composites source-OVER:
 *
 *   normal   `source-atop` — replace the colour inside the silhouette, keep the
 *            alpha exactly. `source-over` is the wrong one: at a soft edge it
 *            would lay the fill over a half-covered pixel and darken the rim.
 *   blended  the blend op, then `destination-in` against a snapshot of the
 *            alpha. Blending alone leaks the fill into the transparent region
 *            around the artwork (source-over compositing does not respect the
 *            destination's alpha); restoring the snapshot puts the silhouette
 *            back, so `multiply` over a word multiplies the word and nothing
 *            else. The snapshot is taken once and stays valid — both ops
 *            preserve the alpha channel they started with.
 *
 * Painted into the group's ISOLATION buffer (`groupNeedsIsolation` returns true
 * whenever there is a tint), which holds this group's pixels and nothing else —
 * so "mask by the destination alpha" is exactly "mask by the group".
 */
function paintGroupTint(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  group: GroupClip,
  localMs: number,
  resolve: ColorResolver,
): void {
  const fills = groupTintFills(group);
  if (fills.length === 0) return;
  const bounds = groupBoxRect(doc, frame, group);
  const cover = userSpaceCover(ctx);
  if (!bounds || !cover) return;
  const sampled = sampleKeyframes(group.keyframes, localMs);
  const media: MediaDrawCtx = { clipId: group.id, doc, localMs };
  let alpha: Scratch | null = null;
  for (const raw of fills) {
    const fill = effectiveFill(raw, sampled);
    if (!fill.enabled || fill.opacity <= 0.001) continue;
    const blended = fill.blendMode !== "normal";
    if (blended && !alpha) alpha = snapshotCanvas(ctx);
    ctx.save();
    ctx.globalAlpha *= fill.opacity;
    ctx.globalCompositeOperation = blended ? COMPOSITE[fill.blendMode] : "source-atop";
    if (fill.type === "media") {
      // An image or a movie poured through the group's silhouette — footage
      // inside a word, with no mask layer to build.
      if (fill.source.type === "asset") drawMediaFill(ctx, fill, bounds, media);
    } else {
      ctx.fillStyle = paintStyle(ctx, fill, bounds, resolve);
      ctx.fillRect(cover.x, cover.y, cover.w, cover.h);
    }
    ctx.restore();
    if (blended && alpha) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(alpha.canvas, 0, 0);
      ctx.restore();
    }
  }
  if (alpha) alpha.busy = false;
}

/**
 * The whole target canvas in the CURRENT user space — the rect to fill when the
 * thing being painted is "every pixel of this buffer", and the transform in
 * force is the one a gradient's coordinates are written in.
 *
 * Exact rather than a generous pad: the tint has to reach every pixel the group
 * inked, INCLUDING what its members' own shadows and glows painted past the
 * silhouette, or the tint stops at a rect edge and leaves a straight seam
 * through a soft one. Null when the transform is degenerate (a zero scale),
 * where there is nothing to paint anyway.
 */
function userSpaceCover(ctx: CanvasRenderingContext2D): { x: number; y: number; w: number; h: number } | null {
  const m = ctx.getTransform();
  if (Math.abs(m.a * m.d - m.b * m.c) < 1e-9) return null;
  const inv = m.inverse();
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]] as const) {
    const p = inv.transformPoint(new DOMPoint(x, y));
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** A pooled copy of a buffer's pixels — here, to keep its alpha channel. */
function snapshotCanvas(ctx: CanvasRenderingContext2D): Scratch {
  const s = acquireScratch(ctx.canvas.width, ctx.canvas.height);
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.drawImage(ctx.canvas, 0, 0);
  return s;
}

/** The group's corner radii with `borderRadius.*` keys folded in. */
function sampledRadius(group: GroupClip, localMs: number): CornerRadius {
  const kf = sampleKeyframes(group.keyframes, localMs);
  const n = (k: string, d: number) => (typeof kf[k] === "number" ? (kf[k] as number) : d);
  const r = group.borderRadius;
  return { tl: n("borderRadius.tl", r.tl), tr: n("borderRadius.tr", r.tr), br: n("borderRadius.br", r.br), bl: n("borderRadius.bl", r.bl) };
}

/**
 * THE CONTAINER'S OWN PAINT: its fills as the box, its strokes as the box's
 * outline, corners rounded by its `borderRadius` — the same rounded-rect a
 * box layer paints, on a box that is derived rather than declared.
 */
function paintLayoutBox(
  ctx: CanvasRenderingContext2D,
  group: GroupClip,
  localMs: number,
  bounds: PaintBounds,
  resolve: ColorResolver,
): void {
  if (group.fills.length === 0 && group.strokes.length === 0) return;
  const sampled = sampleKeyframes(group.keyframes, localMs);
  const radius = sampledRadius(group, localMs);
  ctx.save();
  for (const raw of group.fills) {
    const fill = effectiveFill(raw, sampled);
    if (!fill.enabled || fill.opacity <= 0.001 || fill.type === "media") continue;
    ctx.save();
    ctx.globalAlpha *= fill.opacity;
    ctx.globalCompositeOperation = COMPOSITE[fill.blendMode];
    ctx.fillStyle = paintStyle(ctx, fill, bounds, resolve);
    roundRect(ctx, bounds.x, bounds.y, bounds.w, bounds.h, radius);
    ctx.fill();
    ctx.restore();
  }
  if (group.strokes.length > 0) {
    const strokes = group.strokes.map((st) => effectiveStroke(st, sampled, group.modulators, localMs));
    paintStrokes(ctx, boxOutlineCommands(bounds, radius), strokes, resolve, bounds, null);
  }
  ctx.restore();
}

/** The group's combined outline, stroked once through the shared stroke plan. */
function paintGroupStroke(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  group: GroupClip,
  localMs: number,
  /** COMP time — what the MEMBERS' animation is sampled at (the group's own
   *  local time drives its stroke keyframes, and the two are not the same
   *  clock once the group's track is retimed). */
  timeMs: number,
  resolve: ColorResolver,
): void {
  if (group.strokes.length === 0) return;
  const contours = groupSilhouette(doc, group, timeMs);
  if (!contours) return;
  const sampled = sampleKeyframes(group.keyframes, localMs);
  const strokes = group.strokes.map((st) => effectiveStroke(st, sampled, group.modulators, localMs));
  const cmds = pathCommands(contours);
  const bbox = subpathBounds(contours);
  if (!bbox) return;
  ctx.save();
  ctx.translate(frame.width / 2, frame.height / 2);
  paintVector(
    ctx,
    commandsToPath2D(cmds),
    [],
    strokes,
    "nonzero",
    resolve,
    { x: bbox.minX, y: bbox.minY, w: bbox.maxX - bbox.minX, h: bbox.maxY - bbox.minY },
    null,
    cmds,
  );
  ctx.restore();
}

/** Composite a group's children under its mode. */
function paintGroupChildren(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  node: GroupLayerNode,
  mode: GroupMode,
  timeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
): void {
  if (mode === "pass") {
    paintLayerNodes(ctx, doc, frame, node.children, timeMs, options, resolve, guard);
    return;
  }

  const drawable = node.children.filter((c) => nodeDrawable(doc, frame, c, timeMs, options));
  // ONE role split for every mode that has one: the stencil layers union into a
  // single alpha, and the op applies that to the content. `union` and `pass`
  // have no sides — everything is content.
  const roles = mode === "union";
  const stencils = roles ? [] : drawable.filter((c) => c.clip.isStencil);
  const contents = roles ? drawable : drawable.filter((c) => !c.clip.isStencil);

  // Content that EXISTS but is not live now (it ended, or has not started) is
  // an empty side, not a missing one: the op runs on nothing. Mask, subtract
  // and intersect of nothing are nothing; exclude leaves the stencil. Painting
  // the stencils as plain layers here is what drew a mask's cutter as a solid
  // white shape the moment the picture it revealed ended.
  if (!roles && contents.length === 0 && stencils.length > 0 && node.children.some((c) => !c.clip.isStencil)) {
    if (mode === "exclude") paintLayerNodes(ctx, doc, frame, stencils, timeMs, options, resolve, guard);
    return;
  }
  // Degenerate cases keep the fast path: a lone union member, or a composite
  // with no active stencil or no content member at all (content shows
  // unoperated — never a surprise blank canvas mid-edit).
  if ((roles && drawable.length <= 1) || (!roles && (stencils.length === 0 || contents.length === 0))) {
    paintLayerNodes(ctx, doc, frame, contents.length > 0 ? contents : drawable, timeMs, options, resolve, guard);
    return;
  }

  const s = acquireScratch(ctx.canvas.width, ctx.canvas.height);
  const bctx = s.ctx;
  bctx.save();
  bctx.setTransform(ctx.getTransform());

  if (roles) {
    // Union: every member composites as one unit, bottom first.
    for (let i = drawable.length - 1; i >= 0; i--) {
      paintCombined(bctx, "source-over", doc, frame, drawable[i]!, timeMs, options, resolve, guard);
    }
  } else {
    // CONTENT first, as one finished picture…
    for (let i = contents.length - 1; i >= 0; i--) {
      paintCombined(bctx, "source-over", doc, frame, contents[i]!, timeMs, options, resolve, guard);
    }
    const op = GROUP_OP[mode] ?? "destination-in";
    if (stencils.length === 1) {
      // …then the lone stencil's finished pixels, under the mode's op.
      paintCombined(bctx, op, doc, frame, stencils[0]!, timeMs, options, resolve, guard);
    } else {
      // Several stencils UNION into one alpha first, so "many cutters" is the
      // same code path as one — this is what mask always did, now for every mode.
      const m = acquireScratch(ctx.canvas.width, ctx.canvas.height);
      m.ctx.save();
      m.ctx.setTransform(ctx.getTransform());
      for (let i = stencils.length - 1; i >= 0; i--) {
        paintCombined(m.ctx, "source-over", doc, frame, stencils[i]!, timeMs, options, resolve, guard);
      }
      m.ctx.restore();
      bctx.save();
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.globalCompositeOperation = op;
      bctx.drawImage(m.canvas, 0, 0);
      bctx.restore();
      m.busy = false;
    }
  }
  bctx.restore();

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(s.canvas, 0, 0);
  ctx.restore();
  s.busy = false;
}

/**
 * Combine one child node into a group buffer under a composite op. A
 * non-source-over op first isolates the child so the op applies to its
 * FINISHED pixels — this is what lets booleans/masks work on any layer kind
 * (and on whole nested groups), not just vector fills.
 */
function paintCombined(
  bctx: CanvasRenderingContext2D,
  op: GlobalCompositeOperation,
  doc: MotionDocument,
  frame: Frame,
  node: LayerTreeNode,
  timeMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
): void {
  if (op === "source-over") {
    paintLayerNode(bctx, doc, frame, node, timeMs, options, resolve, guard);
    return;
  }
  const s = acquireScratch(bctx.canvas.width, bctx.canvas.height);
  s.ctx.save();
  s.ctx.setTransform(bctx.getTransform());
  paintLayerNode(s.ctx, doc, frame, node, timeMs, options, resolve, guard);
  s.ctx.restore();
  bctx.save();
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.globalCompositeOperation = op;
  bctx.drawImage(s.canvas, 0, 0);
  bctx.restore();
  s.busy = false;
}

/**
 * Apply a clip's layer-effect stack around its draw. The stack is a real
 * ordered pipeline: it partitions into CSS-filter segments split at PIXEL
 * passes (color grades — adjacent grade cards merge into one engine call), so
 * "blur, then grade, then shadow" means exactly that. With no pixel pass the
 * whole stack collapses to the legacy one-ctx fast path: the first shadow
 * rides ctx.shadow* (it hugs the painted silhouette), everything else joins
 * one ctx.filter string. Shadow offsets and blur radii are frame px but
 * canvas applies them in DEVICE space, so they're scaled by the current
 * transform — correct at any zoom and in exports. Sampled `lfx.` keyframes
 * override base values, so every field animates. `target` is the ctx to paint
 * into (the main ctx or an isolation buffer).
 */
type LfxShadow = { color: string; x: number; y: number; blur: number };
/**
 * Exported so a GRADE NODE can carry one. A corrector's payload is an ordinary
 * effect stack, so it compiles through the same builder and runs through the
 * same executor — the type crossing the module boundary is what keeps that a
 * fact rather than a claim. `grade-stage` imports it as a TYPE only, so there
 * is no runtime cycle.
 */
export type LfxStage =
  // A run of FILTER OPS (data, not a CSS string — see `canvas-filter.ts`),
  // plus the first shadow, which rides ctx.shadow* and hugs the silhouette.
  | { kind: "css"; ops: FilterOp[]; shadow: LfxShadow | null }
  | { kind: "grade"; grades: ColorGradeParams[] }
  // A grade GRAPH. Separate from the flat `grade` stage above because a graph
  // can branch, carry mattes and composite — it is a program, not a list of
  // trims that merge with the next one.
  | { kind: "gradeGraph"; program: GradeProgram }
  | { kind: "pass"; passes: LfxPass[] }
  // A LOOK below full strength: its members' own pipeline, run over the
  // picture as it arrives and crossfaded with it by `mix`. A look at 1 never
  // becomes one of these — its cards inline (`effectGroupPlan`).
  | { kind: "group"; stages: LfxStage[]; mix: number };

/**
 * The effect kinds that compile to nothing but a CSS filter on the layer's own
 * draw — no buffer, no neighbourhood, no region. EVERYTHING ELSE is a pixel
 * stage, and a pixel stage is only meaningful relative to the region it is
 * handed, so it forces the layer region in `withLayer`.
 *
 * Stated as the CSS-only set rather than the pixel set on purpose: a new effect
 * kind that nobody remembers to classify then defaults to the correct, safe
 * side. Getting it wrong the other way is silent — the effect simply anchors
 * itself to the viewport again.
 */
const CSS_ONLY_EFFECTS: ReadonlySet<LayerEffectType> = new Set<LayerEffectType>([
  "shadow",
  "blur",
  "adjust",
  // Keys the SOURCE pixels inside the media draw, never a stage of its own.
  "chromaKey",
]);

/**
 * Pixel stages whose output at a pixel depends on THAT PIXEL and nothing else.
 * They read no neighbour and measure against no region, so they are exact at
 * any resolution and may rasterise at device scale like ordinary vector work.
 * Everything outside both sets is REGIONAL and must be pinned to the document.
 */
const PER_PIXEL_EFFECTS: ReadonlySet<LayerEffectType> = new Set<LayerEffectType>([
  "colorGrade",
  // A lookup table indexed by one pixel's own luminance. No neighbour, no
  // region — so these are exact at any resolution and get the sharper picture
  // that device-scale rasterisation buys, same as the grading node.
  "gradientMap",
  "posterize",
]);

/**
 * The CSS-only kinds that compile to FILTER OPS. On an engine whose
 * `ctx.filter` does nothing they run on the CPU over a buffer, so there they
 * need the layer's own region like any pixel stage — or the CPU would blur the
 * whole viewport to soften one layer.
 */
const FILTER_EFFECTS: ReadonlySet<LayerEffectType> = new Set<LayerEffectType>(["shadow", "blur", "adjust"]);

/** Does this stack need a pixel buffer at all? See `CSS_ONLY_EFFECTS`. */
function hasPixelEffect(effects: VisualClip["effects"]): boolean {
  const cpuFilters = !hasCanvasFilter();
  return effects.some((fx) => fx.enabled && (!CSS_ONLY_EFFECTS.has(fx.type) || (cpuFilters && FILTER_EFFECTS.has(fx.type))));
}

/**
 * Does this stack have to rasterise at the DOCUMENT's scale — i.e. does it
 * contain anything whose picture would change with the stage zoom?
 */
/** Any active card whose picture is tied to the document's pixel grid. */
function gridBoundStack(effects: VisualClip["effects"]): boolean {
  return effects.some((fx) => fx.enabled && LFX.def(fx.type)?.gridBound === true);
}

function needsDocumentRaster(effects: VisualClip["effects"]): boolean {
  return effects.some((fx) => fx.enabled && !CSS_ONLY_EFFECTS.has(fx.type) && !PER_PIXEL_EFFECTS.has(fx.type));
}

/**
 * Compile a clip's active effect stack into the ordered stage list: CSS-filter
 * segments split at colorGrade PIXEL passes (adjacent grades merge into one
 * engine call). Pure over `sampled` + `scale`, so the per-layer draw path AND
 * the adjustment-layer path (which grades already-composited pixels) build the
 * SAME pipeline from one place — add an effect kind here once, both benefit.
 */
/**
 * DOES THIS CARD PAINT ANYTHING AT THIS INSTANT? Asked of the one compiler
 * the renderer runs, so the answer cannot disagree with the picture: a card
 * switched off, keyed to zero or otherwise a no-op here compiles to nothing.
 *
 * The effect editor's preview asks it to say "no change here" instead of
 * showing an identical Before and After and leaving you to guess. A pixel
 * comparison was tried first and is the wrong test: a card that adds bleed
 * resizes the layer's buffer, so the cards beneath it land on different pixels
 * and a silent card still "differs".
 *
 * A card it cannot judge alone (a grade needs its program) answers true.
 */
export function layerEffectPaintsAt(clip: VisualClip, effectId: string, localMs: number, leadMs = 0): boolean {
  const fx = clip.effects.find((e) => e.id === effectId);
  if (!fx || fx.type === "grade") return true;
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  if (!anyActiveAt([fx], (id) => layerEffectPath(id, ENABLED_FIELD), sampled)) return false;
  const stages = buildLfxStages([fx], sampled, IDENTITY_RESOLVER, 1, localMs + leadMs, clip.modulators);
  const first = stages[0]!;
  return stages.length > 1 || (first.kind === "css" && (first.ops.length > 0 || first.shadow != null));
}

function buildLfxStages(
  effects: VisualClip["effects"],
  sampled: Record<string, KeyframeValue>,
  resolve: ColorResolver,
  scale: number,
  /** The clip's LOCAL time — time-driven cards and every modulator read it. */
  localMs: number,
  /** The clip's modulators — bound to `lfx.` paths like keyframes are. */
  modulators: readonly Modulator[] | undefined,
  /** The layer's outline in this buffer's px, when the layer has geometry. */
  outline?: (inked: boolean) => LightningOutline | null,
  /** Resolves a `grade` card into a runnable program. Absent = no colour page. */
  gradeProgram?: (card: Extract<LayerEffect, { type: "grade" }>) => GradeProgram | null,
  /**
   * How a field of this list is ADDRESSED. Defaults to a clip's own
   * `lfx.<id>.<field>`; a grade node's stack lives one level down and spells it
   * `lfx.<card>.n.<node>.fx.<id>.<field>`. Taking it as a parameter is what
   * lets a node reuse this whole compiler instead of growing a second one that
   * only understood colour grades.
   */
  pathOf: (effectId: string, field: string) => string = layerEffectPath,
  /** The layer's own scale: a `placed` card (a lens, a shockwave) is an object on it and grows with it. */
  carrierScale = 1,
): LfxStage[] {
  const timeSec = localMs / 1000;
  /**
   * EVERY card resolves its fields through the one core resolver — keyframes,
   * colour variables, MODULATORS and px scaling, in that order. It used to be
   * per-card inline closures here (which is what `resolveEffectValues` was
   * written to kill, and which quietly disagreed about which fields scale);
   * routing the simple cards through it too is what makes a modulator bindable
   * to a drop shadow's blur, not just to the cards that happened to use it.
   */
  const vals = (fx: { id: string; type: LayerEffectType }): Record<string, number | string> =>
    resolveEffectValues(
      layerEffectTypeDef(fx.type)?.fields ?? [],
      fx as unknown as Record<string, unknown>,
      sampled,
      (k) => pathOf(fx.id, k),
      { scale: layerEffectTypeDef(fx.type)?.placed ? scale * carrierScale : scale, resolveColor: resolve, modulators, timeSec },
    );
  const stages: LfxStage[] = [{ kind: "css", ops: [], shadow: null }];
  const cssStage = (): Extract<LfxStage, { kind: "css" }> => {
    const last = stages[stages.length - 1]!;
    if (last.kind === "css") return last;
    const next = { kind: "css" as const, ops: [] as FilterOp[], shadow: null };
    stages.push(next);
    return next;
  };
  // Compositing passes (vignette/sharpen/grain/motion blur) are pixel passes like
  // grades — they split the CSS run and merge with an adjacent pass stage.
  const passStage = (): Extract<LfxStage, { kind: "pass" }> => {
    const last = stages[stages.length - 1]!;
    if (last.kind === "pass") return last;
    const next = { kind: "pass" as const, passes: [] as LfxPass[] };
    stages.push(next);
    return next;
  };
  // An effect's eye is keyframable (a discrete `lfx.<id>.enabled` track), so the
  // stack is asked what is on AT THIS INSTANT rather than what was left on in
  // the inspector. Unkeyed effects fall straight through to their stored flag.
  // LOOKS: the stack as the plan runs it — full-strength looks inlined, a
  // partial look compiled to its own sub-pipeline and stood in for by its
  // header card, which the first branch below turns into a `group` stage.
  const partial = new Map<string, Extract<LfxStage, { kind: "group" }>>();
  const ordered: VisualClip["effects"] = [];
  const isOn = (e: LayerEffect) => activeAt([e], (id) => layerEffectPath(id, ENABLED_FIELD), sampled).length > 0;
  for (const seg of effectGroupPlan(effects, isOn, (g) => Number(vals(g).mix ?? g.mix))) {
    if (seg.mix >= 1) {
      ordered.push(...seg.effects);
      continue;
    }
    const header = effects.find((e) => e.id === seg.group)!;
    partial.set(header.id, {
      kind: "group",
      mix: seg.mix,
      stages: buildLfxStages(seg.effects, sampled, resolve, scale, localMs, modulators, outline, gradeProgram, pathOf, carrierScale),
    });
    ordered.push(header);
  }
  for (const fx of ordered) {
    if (fx.type === "group") {
      const g = partial.get(fx.id);
      if (g) stages.push(g);
      continue;
    }
    // `v` is already keyframed, modulated, colour-resolved and px-scaled — the
    // blocks below only decide WHERE each number goes in the pipeline.
    const v = vals(fx);
    // The card's OWN motion reads this, never `timeSec`: held still, it stops.
    const own = ownClockSec(fx, timeSec);
    const n = (k: string) => Number(v[k]) || 0;
    const c = (k: string) => String(v[k]);
    if (fx.type === "shadow") {
      const seg = cssStage();
      const shadow = { color: c("color"), x: n("x"), y: n("y"), blur: Math.max(0, n("blur")) };
      // The FIRST shadow rides ctx.shadow* because that hugs the painted
      // silhouette (a star casts a star); later ones fall back to a filter.
      if (seg === stages[0] && !seg.shadow) seg.shadow = shadow;
      else seg.ops.push({ kind: "dropShadow", ...shadow });
    } else if (fx.type === "blur") {
      const r = Math.max(0, n("radius"));
      if (r > 0) cssStage().ops.push({ kind: "blur", px: r });
    } else if (fx.type === "innerShadow") {
      passStage().passes.push({
        kind: "innerShadow",
        color: c("color"),
        x: n("x"),
        y: n("y"),
        blur: Math.max(0, n("blur")),
      });
    } else if (fx.type === "glow") {
      passStage().passes.push({
        kind: "glow",
        // `mode` is a select field, so it arrives resolved as a string.
        mode: c("mode") === "solid" ? "solid" : "auto",
        color: c("color"),
        size: Math.max(0, n("size")),
        intensity: n("intensity"),
        saturation: Math.max(0, n("saturation")),
        brightness: Math.max(0, n("brightness")),
        inner: fx.inner,
        glowFalloff: c("glowFalloff") === "light" ? "light" : "even",
      });
    } else if (fx.type === "stroke") {
      const width = Math.max(0, n("width"));
      if (width > 0) {
        const placement = c("placement");
        passStage().passes.push({
          kind: "stroke",
          color: c("color"),
          width,
          placement: placement === "inside" || placement === "center" ? placement : "outside",
          softness: Math.max(0, Math.min(1, n("softness"))),
        });
      }
    } else if (fx.type === "longShadow") {
      const length = Math.max(0, n("length"));
      if (length > 0) {
        passStage().passes.push({
          kind: "longShadow",
          color: c("color"),
          angle: n("angle"),
          length,
          fade: Math.max(0, Math.min(1, n("fade"))),
        });
      }
    } else if (fx.type === "rgbSplit") {
      passStage().passes.push({ kind: "rgbSplit", angle: n("angle"), distance: Math.max(0, n("distance")) });
    } else if (fx.type === "glass") {
      // The material brain resolves every field (keyframes, px scaling, the
      // light vector, the ripple phase at this exact time) — the pass just
      // carries the result, so preview and export cannot disagree.
      const params = resolveGlassParams(fx, sampled, scale, timeSec, resolve, modulators);
      if (!glassIsNoop(params)) passStage().passes.push({ kind: "glass", params });
    } else if (fx.type === "chromaKey") {
      // Keys the SOURCE pixels — applied inside the media draw paths, so the
      // shadows/blurs around it follow the keyed silhouette.
    } else if (fx.type === "colorGrade") {
      const grade: ColorGradeParams = {
        temperature: n("temperature"),
        tint: n("tint"),
        exposure: n("exposure"),
        contrast: n("contrast"),
        saturation: n("saturation"),
        vibrance: n("vibrance"),
        hueDeg: n("hueDeg"),
        intensity: n("intensity"),
        lift: [n("liftR"), n("liftG"), n("liftB"), n("liftM")],
        gamma: [n("gammaR"), n("gammaG"), n("gammaB"), n("gammaM")],
        gain: [n("gainR"), n("gainG"), n("gainB"), n("gainM")],
      };
      const last = stages[stages.length - 1]!;
      if (last.kind === "grade") last.grades.push(grade);
      else stages.push({ kind: "grade", grades: [grade] });
    } else if (fx.type === "grade") {
      // The node graph. Resolved into a flat program here — see `grade-stage`
      // — so the runner never touches the document or the clock.
      const program = gradeProgram?.(fx);
      if (program) stages.push({ kind: "gradeGraph", program });
    } else if (fx.type === "vignette") {
      passStage().passes.push({
        kind: "vignette",
        amount: n("amount"),
        softness: n("softness"),
        roundness: n("roundness"),
        color: c("color"),
      });
    } else if (fx.type === "sharpen") {
      passStage().passes.push({ kind: "sharpen", amount: Math.max(0, n("amount")), radius: Math.max(0.3, n("radius")) });
    } else if (fx.type === "grain") {
      // The analog family mirrors glass: core resolves every field, the px
      // scaling AND the temporal step from the clip's own local time, so the
      // pass carries a finished description of this instant and preview,
      // scrub, export and re-export are the same pixels by construction.
      const params = resolveGrainParams(fx, sampled, scale, timeSec, resolve, modulators);
      if (!grainIsNoop(params)) passStage().passes.push({ kind: "grain", params });
    } else if (fx.type === "filmDamage") {
      const params = resolveFilmDamageParams(fx, sampled, scale, timeSec, resolve, modulators);
      if (!filmDamageIsNoop(params)) passStage().passes.push({ kind: "filmDamage", params });
    } else if (fx.type === "scanlines") {
      const params = resolveScanlineParams(fx, sampled, scale, timeSec, resolve, modulators);
      if (!scanlinesIsNoop(params)) passStage().passes.push({ kind: "scanlines", params });
    } else if (fx.type === "noise") {
      const params = resolveNoiseParams(fx, sampled, scale, timeSec, resolve, modulators);
      if (!noiseIsNoop(params)) passStage().passes.push({ kind: "noise", params });
    } else if (fx.type === "surface") {
      // The material brain resolves the clock, the sheet's offset at this
      // step and the dye — the pass carries a finished description.
      const params = resolveSurfaceParams(fx, sampled, scale, timeSec, resolve, modulators);
      // A material never moves light: the light matte paints without it.
      // A custom texture is a SOURCE read, like a media fill: decoded here,
      // handed to the pass as pixels (`getImageForAsset` marks the frame
      // transient until it lands, so nothing caches the stand-in material).
      const texture = params.texture ? textureImage(params.texture) : null;
      if (!surfaceIsNoop(params) && lightPass !== "only") passStage().passes.push({ kind: "surface", params, texture });
    } else if (fx.type === "directionalBlur") {
      passStage().passes.push({ kind: "directionalBlur", angle: n("angle"), distance: Math.max(0, n("distance")) });
    } else if (fx.type === "zoomBlur") {
      passStage().passes.push({ kind: "zoomBlur", strength: n("strength"), cx: n("centerX"), cy: n("centerY") });
    } else if (fx.type === "spinBlur") {
      passStage().passes.push({ kind: "spinBlur", angle: n("angle"), cx: n("centerX"), cy: n("centerY") });

    // ── Light & optics ─────────────────────────────────────────────────────
    // The two travelling cards resolve their position through the SWEEP clock,
    // which reads the clip's own local time — so a preset that ships a duration
    // arrives already moving, with no keyframes and nothing to retime by hand.
    } else if (fx.type === "shine") {
      passStage().passes.push({
        kind: "shine",
        position: sweepAt({ position: n("position"), duration: n("duration"), delay: n("delay"), loop: fx.loop }, own),
        angle: n("angle"),
        width: Math.max(0, n("width")),
        softness: clamp01(n("softness")),
        count: Math.max(1, Math.round(n("count"))),
        gap: Math.max(0.01, n("gap")),
        falloff: clamp01(n("falloff")),
        color: c("color"),
        intensity: Math.max(0, n("intensity")),
        bloom: Math.max(0, n("bloom")),
        blend: c("blend"),
        inside: fx.inside,
      });
    } else if (fx.type === "lightRays") {
      passStage().passes.push({
        kind: "lightRays",
        cx: n("centerX"),
        cy: n("centerY"),
        length: Math.max(0, n("length")),
        intensity: Math.max(0, n("intensity")),
        decay: Math.max(0.1, n("decay")),
        threshold: clamp01(n("threshold")),
        mode: c("mode") === "solid" ? "solid" : "auto",
        color: c("color"),
        saturation: Math.max(0, n("saturation")),
        samples: Math.max(4, Math.round(n("samples"))),
        blend: c("blend"),
        behind: fx.behind,
      });
    } else if (fx.type === "lensFlare") {
      passStage().passes.push({
        kind: "lensFlare",
        cx: n("centerX"),
        cy: n("centerY"),
        brightness: Math.max(0, n("brightness")),
        size: Math.max(0, n("size")),
        color: c("color"),
        streak: clamp01(n("streak")),
        streakColor: c("streakColor"),
        streakAngle: n("streakAngle"),
        halo: clamp01(n("halo")),
        ghosts: Math.max(0, Math.round(n("ghosts"))),
        ghostSpread: n("ghostSpread"),
        ghostChroma: clamp01(n("ghostChroma")),
        blend: c("blend"),
        inside: fx.inside,
      });
    } else if (fx.type === "lightning") {
      // Same contract as glass and the analog family: core resolved the
      // geometry — including the seeded step and the strike's draw-on — so the
      // pass carries finished polylines and the export strikes the same bolt.
      // A vector layer hands its real outline over now (path-precise); any
      // other layer's arrives at draw time from a silhouette trace.
      // An outline arc rides the line as drawn (draw-on + trim); a fill fills
      // the whole shape.
      const geometry = fx.mode === "outline" || fx.mode === "fill" ? outline?.(fx.mode === "outline") ?? null : null;
      const params = resolveLightningParams(fx, sampled, scale, timeSec, resolve, modulators, geometry);
      if (!lightningIsNoop(params)) passStage().passes.push({ kind: "lightning", params });

    // ── Distort ────────────────────────────────────────────────────────────
    } else if (fx.type === "bulge") {
      passStage().passes.push({
        kind: "bulge",
        cx: n("centerX"),
        cy: n("centerY"),
        radius: Math.max(0.01, n("radius")),
        strength: n("strength"),
        softness: clamp01(n("softness")),
        aspect: Math.max(0.1, n("aspect")),
        refract: clamp01(n("refract")),
      });
    } else if (fx.type === "wave") {
      passStage().passes.push({
        kind: "wave",
        shape: waveShape(c("shape")),
        angle: n("angle"),
        wavelength: Math.max(2, n("wavelength")),
        amplitude: Math.max(0, n("amplitude")),
        // `speed` advances the phase from the clip's own time and ADDS to the
        // keyframed phase — the convention glass's ripple already set.
        phase: n("phase") + n("speed") * own * 360,
        cross: clamp01(n("cross")),
        anchor: clamp01(n("anchor")),
        seed: 1,
      });
    } else if (fx.type === "twirl") {
      passStage().passes.push({
        kind: "twirl",
        cx: n("centerX"),
        cy: n("centerY"),
        radius: Math.max(0.01, n("radius")),
        angle: n("angle"),
        softness: clamp01(n("softness")),
      });
    } else if (fx.type === "lensDistort") {
      passStage().passes.push({
        kind: "lensDistort",
        amount: n("amount"),
        cubic: n("cubic"),
        chroma: clamp01(n("chroma")),
        scale: Math.max(0.25, n("scale")),
        cx: n("centerX"),
        cy: n("centerY"),
      });
    } else if (fx.type === "goo") {
      passStage().passes.push({
        kind: "goo",
        blur: Math.max(0, n("blur")),
        threshold: clamp01(n("threshold")),
        softness: Math.max(0, n("softness")),
        mix: clamp01(n("mix")),
      });
    } else if (fx.type === "boil") {
      const step = resolveTemporalStep(
        { seed: Math.round(n("seed")), rate: n("rate"), jitter: clamp01(n("jitter")), stutter: clamp01(n("stutter")) },
        own,
      );
      const variants = Math.max(0, Math.round(n("variants")));
      passStage().passes.push({
        kind: "boil",
        style: c("style") === "wobble" ? "wobble" : c("style") === "jitter" ? "jitter" : "boil",
        amount: Math.max(0, n("amount")),
        scale: Math.max(2, n("scale")),
        complexity: Math.max(1, Math.round(n("complexity"))),
        // A loop of N drawings is the cel animator's trick: the eye reads the
        // cycle as life, not as noise. 0 = a fresh drawing every step.
        drawing: variants > 0 ? ((step.index % variants) + variants) % variants : step.index,
        seed: Math.round(n("seed")),
        shake: Math.max(0, n("shake")),
        rotate: Math.max(0, n("rotate")),
        mix: clamp01(n("mix")),
      });
    } else if (fx.type === "roughenEdges") {
      const step = resolveTemporalStep(
        { seed: Math.round(n("seed")), rate: n("rate"), jitter: clamp01(n("jitter")), stutter: clamp01(n("stutter")) },
        own,
      );
      passStage().passes.push({
        kind: "roughenEdges",
        style: roughenStyle(c("style")),
        amount: Math.max(0, n("amount")),
        scale: Math.max(1, n("scale")),
        complexity: Math.max(1, Math.round(n("complexity"))),
        sharpness: clamp01(n("sharpness")),
        // The clock advances the noise's third axis in whole steps, so the edge
        // crawls on the gate rather than sliding smoothly with the playhead.
        evolve: n("evolve") * step.index,
        seed: step.seed,
        color: c("color"),
        tint: clamp01(n("tint")),
      });
    } else if (fx.type === "glitch") {
      const step = resolveTemporalStep(
        { seed: Math.round(n("seed")), rate: n("rate"), jitter: clamp01(n("jitter")), stutter: clamp01(n("stutter")) },
        own,
      );
      passStage().passes.push({
        kind: "glitch",
        mix: clamp01(n("mix")),
        amount: clamp01(n("amount")),
        blocks: Math.max(1, Math.round(n("blocks"))),
        displace: Math.max(0, n("displace")),
        chroma: Math.max(0, n("chroma")),
        scramble: clamp01(n("scramble")),
        colorShift: clamp01(n("colorShift")),
        direction: glitchDirection(c("direction")),
        inside: fx.inside,
        seed: step.seed,
      });

    // ── Pattern & surface ──────────────────────────────────────────────────
    } else if (fx.type === "halftone") {
      passStage().passes.push({
        kind: "halftone",
        shape: halftoneShape(c("shape")),
        size: Math.max(1, n("size")),
        angle: n("angle"),
        softness: clamp01(n("softness")),
        contrast: Math.max(0, n("contrast")),
        mode: halftoneMode(c("mode")),
        inkColor: c("inkColor"),
        paperColor: c("paperColor"),
        jitter: Math.max(0, n("jitter")),
        spread: Math.max(0, n("spread")),
        mix: clamp01(n("mix")),
        invert: fx.invert,
        inside: fx.inside,
        // Duotone and riso ARE ink on paper; the switch is for the rest.
        paper: fx.paper || halftoneMode(c("mode")) === "duotone" || halftoneMode(c("mode")) === "riso",
        ink2Color: c("ink2Color"),
        misregister: Math.max(0, n("misregister")),
      });
    } else if (fx.type === "pixelate") {
      passStage().passes.push({
        kind: "pixelate",
        size: Math.max(1, n("size")),
        aspect: Math.max(0.1, n("aspect")),
        shape: pixelateShape(c("shape")),
        gap: Math.max(0, Math.min(0.9, n("gap"))),
        softness: clamp01(n("softness")),
        mix: clamp01(n("mix")),
        board: c("board"),
      });
    } else if (fx.type === "bevel") {
      passStage().passes.push({
        kind: "bevel",
        style: bevelStyle(c("style")),
        depth: Math.max(0, n("depth")),
        strength: Math.max(0, n("strength")),
        angle: n("angle"),
        elevation: Math.max(0, Math.min(90, n("elevation"))),
        softness: clamp01(n("softness")),
        highlightColor: c("highlightColor"),
        highlightOpacity: clamp01(n("highlightOpacity")),
        shadowColor: c("shadowColor"),
        shadowOpacity: clamp01(n("shadowOpacity")),
        highlightBlend: c("highlightBlend"),
        shadowBlend: c("shadowBlend"),
      });

    // ── Colour lookups ─────────────────────────────────────────────────────
    } else if (fx.type === "gradientMap") {
      passStage().passes.push({
        kind: "gradientMap",
        shadowColor: c("shadowColor"),
        midColor: c("midColor"),
        highColor: c("highColor"),
        midpoint: Math.max(0.02, Math.min(0.98, n("midpoint"))),
        contrast: Math.max(0, n("contrast")),
        brightness: n("brightness"),
        mix: clamp01(n("mix")),
        invert: fx.invert,
      });
    } else if (fx.type === "posterize") {
      passStage().passes.push({
        kind: "posterize",
        levels: Math.max(2, Math.round(n("levels"))),
        dither: clamp01(n("dither")),
        gamma: Math.max(0.05, n("gamma")),
        mix: clamp01(n("mix")),
        luminanceOnly: fx.luminanceOnly,
      });
    // ── Depth: read the footage's depth maps (core `depthForClip`) ─────────
    } else if (fx.type === "lens") {
      // Always a pass, even bending nothing: the lens REPLACES its carrier's
      // picture, so a lens keyed to 0 shows the plain backdrop, never the circle.
      passStage().passes.push({
        kind: "lens",
        radius: Math.max(0, n("radius")),
        strength: clamp01(n("strength")),
        shadow: Math.max(0, n("shadow")),
        ring: Math.max(0, n("ring")),
        ringWidth: Math.max(0.5, n("ringWidth")),
        ringColor: c("ringColor"),
        glow: Math.max(0, n("glow")),
        reach: Math.max(1.5, n("reach")),
      });
    } else if (fx.type === "shockwave") {
      // Always a pass, like the lens: it replaces its carrier's picture.
      passStage().passes.push({
        kind: "shockwave",
        radius: Math.max(0, n("radius")),
        width: Math.max(1, n("width")),
        strength: n("strength"),
        chroma: clamp01(n("chroma")),
        light: Math.max(0, n("light")),
        color: c("color"),
      });
    } else if (fx.type === "star") {
      passStage().passes.push({
        kind: "star",
        temperature: Math.max(1000, n("temperature")),
        brightness: Math.max(0, n("brightness")),
        granulation: Math.max(0.005, n("granulation")),
        contrast: clamp01(n("contrast")),
        limb: clamp01(n("limb")),
        corona: Math.max(0, n("corona")),
        coronaSize: Math.max(0, n("coronaSize")),
        time: own * Math.max(0, n("boil")),
        seed: Math.round(n("seed")),
      });
    } else if (fx.type === "starfield") {
      passStage().passes.push({
        kind: "starfield",
        density: Math.max(0, n("density")),
        brightness: Math.max(0, n("brightness")),
        size: Math.max(0.1, n("size")),
        spectral: clamp01(n("spectral")),
        twinkle: clamp01(n("twinkle")),
        // The twinkle's step — the same number the card's `picture` keys caches by.
        step: Math.floor(own * Math.max(1, n("rate")) + 1e-6),
        spikes: Math.max(0, n("spikes")),
        spikeAngle: n("spikeAngle"),
        band: clamp01(n("band")),
        bandAngle: n("bandAngle"),
        driftX: n("driftX"),
        driftY: n("driftY"),
        seed: Math.round(n("seed")),
        scale,
      });
    } else if (fx.type === "nebula") {
      passStage().passes.push({
        kind: "nebula",
        scale: Math.max(1, n("scale")),
        detail: Math.max(1, Math.min(8, Math.round(n("detail")))),
        warp: Math.max(0, n("warp")),
        coverage: clamp01(n("coverage")),
        brightness: Math.max(0, n("brightness")),
        colorA: c("colorA"),
        colorB: c("colorB"),
        colorC: c("colorC"),
        dust: clamp01(n("dust")),
        evolve: n("evolve") + own * n("speed"),
        driftX: n("driftX"),
        driftY: n("driftY"),
        seed: Math.round(n("seed")),
      });
    } else if (fx.type === "fog") {
      if (n("density") > 0.001 && n("mix") > 0.001)
        passStage().passes.push({ kind: "fog", source: fx.source, color: c("color"), density: clamp01(n("density")), start: clamp01(n("start")), end: clamp01(n("end")), mix: clamp01(n("mix")) });
    } else if (fx.type === "lensBlur") {
      // The blur is in document px; the buffer is at `scale`.
      if (n("amount") > 0.01 && n("mix") > 0.001)
        passStage().passes.push({ kind: "lensBlur", source: fx.source, focus: clamp01(n("focus")), range: clamp01(n("range")), amount: Math.max(0, n("amount")) * scale, mix: clamp01(n("mix")) });
    } else if (fx.type === "depthMatte") {
      passStage().passes.push({ kind: "depthMatte", source: fx.source, depth: clamp01(n("depth")), softness: Math.max(0, n("softness")), invert: fx.invert });
    } else if (fx.type === "overlay") {
      passStage().passes.push({
        kind: "overlay",
        mode: overlayMode(c("mode")),
        image: fx.mode === "image" && fx.image ? textureImage(fx.image) : null,
        colorA: c("colorA"),
        colorB: c("colorB"),
        angle: n("angle"),
        scale: Math.max(0.05, n("scale")),
        offsetX: n("offsetX"),
        offsetY: n("offsetY"),
        midpoint: Math.max(0.02, Math.min(0.98, n("midpoint"))),
        repeat: Math.max(1, Math.round(n("repeat"))),
        opacity: clamp01(n("opacity")),
        blend: c("blend"),
        mirror: fx.mirror,
        inside: fx.inside,
      });
    } else if (fx.type === "adjust") {
      const seg = cssStage();
      if (n("brightness") !== 1) seg.ops.push({ kind: "brightness", amount: n("brightness") });
      if (n("contrast") !== 1) seg.ops.push({ kind: "contrast", amount: n("contrast") });
      if (n("saturate") !== 1) seg.ops.push({ kind: "saturate", amount: n("saturate") });
      if (n("hueDeg") !== 0) seg.ops.push({ kind: "hueRotate", deg: n("hueDeg") });
      if (n("grayscale") > 0) seg.ops.push({ kind: "grayscale", amount: n("grayscale") });
      if (n("sepia") > 0) seg.ops.push({ kind: "sepia", amount: n("sepia") });
    }
  }
  return stages;
}

/**
 * The select fields, narrowed.
 *
 * `resolveEffectValues` hands enums back as plain strings — it cannot know each
 * card's option list, and it deliberately does not try. Narrowing at the ONE
 * place a pass is constructed keeps the pass union honestly typed, and means a
 * stale keyframe naming an option that no longer exists falls back to the
 * card's default instead of reaching the renderer as a shape nothing draws.
 */
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function pick<T extends string>(value: string, options: readonly T[], fallback: T): T {
  return (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

const waveShape = (v: string) => pick(v, ["sine", "triangle", "square", "noise"] as const, "sine");
const roughenStyle = (v: string) => pick(v, ["rough", "spiky", "torn", "melt", "rusty"] as const, "rough");
const glitchDirection = (v: string) => pick(v, ["horizontal", "vertical", "both"] as const, "horizontal");
const halftoneShape = (v: string) => pick(v, ["dot", "line", "square", "cross", "diamond"] as const, "dot");
const halftoneMode = (v: string) => pick(v, ["mono", "duotone", "color", "cmyk", "riso"] as const, "mono");
const pixelateShape = (v: string) => pick(v, ["square", "dot", "diamond", "cross"] as const, "square");
const bevelStyle = (v: string) => pick(v, ["inner", "outer", "pillow", "emboss"] as const, "inner");
const overlayMode = (v: string) => pick(v, ["solid", "linear", "radial", "conic", "image"] as const, "linear");

/**
 * The picture an effect's `image` field names, decoded — or null while it
 * decodes or when it cannot be (gone, or not a still): the effect then draws
 * what it would without one. Through the same decode cache as image layers and media
 * fills, so export warms it with every other still.
 */
function textureImage(assetId: string): HTMLImageElement | null {
  const img = getImageForAsset(assetId);
  return img && img.width && img.height ? img : null;
}

/**
 * Set the first CSS stage onto a ctx that is about to DRAW the layer (call
 * inside save/restore). The shadow always rides ctx.shadow*, which every
 * engine honours. The filter ops ride `ctx.filter` only where it really
 * filters; elsewhere `firstOpsInDraw` is false and the caller runs them over
 * the drawn buffer with `drawFiltered` — the same picture, on the CPU.
 */
function applyFirstStage(ctx: CanvasRenderingContext2D, first: Extract<LfxStage, { kind: "css" }>): void {
  // Canvas filters THEN casts the shadow — so where the filter moves after the
  // draw, the shadow moves with it (`firstOpsAfterDraw`), or an adjust would
  // recolour a shadow that the GPU path leaves its own colour.
  if (!firstOpsInDraw(first)) return;
  if (first.shadow) {
    ctx.shadowColor = first.shadow.color;
    ctx.shadowOffsetX = first.shadow.x;
    ctx.shadowOffsetY = first.shadow.y;
    ctx.shadowBlur = first.shadow.blur;
  }
  if (first.ops.length && hasCanvasFilter()) ctx.filter = filterCss(first.ops);
}

/** Does the first stage's filter run inside the draw (GPU), or after it on the buffer? */
function firstOpsInDraw(first: Extract<LfxStage, { kind: "css" }>): boolean {
  return first.ops.length === 0 || hasCanvasFilter();
}

/** Run the first stage's ops over an already-drawn buffer when the draw could not. Returns the result's source. */
function firstOpsAfterDraw(
  first: Extract<LfxStage, { kind: "css" }>,
  img: CanvasImageSource,
  w: number,
  h: number,
): { img: CanvasImageSource; release: () => void } {
  if (firstOpsInDraw(first)) return { img, release: () => {} };
  const out = acquireScratch(w, h);
  out.ctx.save();
  out.ctx.setTransform(1, 0, 0, 1, 0, 0);
  out.ctx.clearRect(0, 0, w, h);
  // ctx.shadowBlur is twice the deviation, exactly drop-shadow's length.
  drawFiltered(out.ctx, img, first.shadow ? [...first.ops, { kind: "dropShadow", ...first.shadow }] : first.ops);
  out.ctx.restore();
  return { img: out.canvas, release: () => { out.busy = false; } };
}

/**
 * Run stages 1..n over a device-space source image (identity space). The first
 * stage is assumed already applied while producing `src`. Returns the final
 * image plus a trailing CSS filter to apply on composite, and a `release` to
 * free any intermediate buffer. Shared by the layer draw path and adjustments.
 */
/**
 * Run a NODE's compiled stack over one picture and hand the result to
 * `consume` — the executor a grade's correctors call.
 *
 * The callback shape is the buffer contract: `runLfxPixelStages` borrows from a
 * pool and returns a canvas that stops being yours the moment it is released,
 * so the consumer copies inside the window where it is still valid. Returning
 * it instead would have been a use-after-free that only shows up on a graph
 * deep enough to reuse a scratch.
 *
 * The first stage is a CSS filter run applied while PRODUCING the source, which
 * a node has no draw of its own to fold into — so it gets a pass of its own
 * here, and a corrector carrying only a blur (a pure CSS card) works.
 */
function runNodeStack(
  stages: LfxStage[],
  src: CanvasImageSource,
  consume: (img: CanvasImageSource) => void,
  env?: PassEnv,
): void {
  const canvas = (src as HTMLCanvasElement);
  const w = canvas.width ?? 0;
  const h = canvas.height ?? 0;
  if (w <= 0 || h <= 0) {
    consume(src);
    return;
  }
  const first = stages[0] as Extract<LfxStage, { kind: "css" }> | undefined;
  let head: Scratch | null = null;
  let input = src;
  let afterHead = () => {};
  if (first?.kind === "css" && (first.ops.length > 0 || first.shadow)) {
    head = acquireScratch(w, h);
    head.ctx.save();
    head.ctx.setTransform(1, 0, 0, 1, 0, 0);
    head.ctx.clearRect(0, 0, w, h);
    applyFirstStage(head.ctx, first);
    head.ctx.drawImage(src, 0, 0);
    head.ctx.restore();
    const after = firstOpsAfterDraw(first, head.canvas, w, h);
    input = after.img;
    afterHead = after.release;
  }

  const { img, finalOps, release } = runLfxPixelStages(stages, input, w, h, env);
  let tail: Scratch | null = null;
  let out = img;
  if (finalOps) {
    tail = acquireScratch(w, h);
    tail.ctx.save();
    tail.ctx.setTransform(1, 0, 0, 1, 0, 0);
    tail.ctx.clearRect(0, 0, w, h);
    drawFiltered(tail.ctx, img, finalOps);
    tail.ctx.restore();
    out = tail.canvas;
  }
  consume(out);
  release();
  afterHead();
  if (head) head.busy = false;
  if (tail) tail.busy = false;
}

function runLfxPixelStages(
  stages: LfxStage[],
  src: CanvasImageSource,
  w: number,
  h: number,
  env: PassEnv = { backdrop: null },
): { img: CanvasImageSource; finalOps: FilterOp[] | null; release: () => void } {
  let img: CanvasImageSource = src;
  let mid: Scratch | null = null;
  const held: Scratch[] = [];
  let finalOps: FilterOp[] | null = null;
  for (let i = 1; i < stages.length; i++) {
    const st = stages[i]!;
    if (st.kind === "grade") {
      img = colorGradedFrame(img, w, h, st.grades) ?? img;
    } else if (st.kind === "gradeGraph") {
      img = runGradeProgram(st.program, img, w, h, runNodeStack);
    } else if (st.kind === "pass") {
      for (const p of st.passes) img = applyEffectPass(p, img, w, h, env);
    } else if (st.kind === "group") {
      const out = runGroupStage(st, img, w, h, env);
      held.push(out);
      img = out.canvas;
    } else if (i === stages.length - 1) {
      finalOps = st.ops.length ? st.ops : null;
    } else if (st.ops.length) {
      // A filter segment BETWEEN pixel passes gets its own buffer pass.
      mid ??= acquireScratch(w, h);
      mid.ctx.save();
      mid.ctx.setTransform(1, 0, 0, 1, 0, 0);
      mid.ctx.clearRect(0, 0, w, h);
      drawFiltered(mid.ctx, img, st.ops);
      mid.ctx.restore();
      img = mid.canvas;
    }
  }
  return {
    img,
    finalOps,
    release: () => {
      if (mid) mid.busy = false;
      for (const h of held) h.busy = false;
    },
  };
}

/**
 * Run a LOOK's members over `src` and crossfade the result with `src` by
 * `mix`. The input is copied first: the members draw from the same pass
 * buffers the arriving picture may live in, and a deep enough look would
 * otherwise overwrite its own dry signal. The crossfade is a premultiplied
 * lerp — dry at (1 − mix), wet ADDED at mix — so a transparent edge fades
 * instead of darkening. The caller frees the returned buffer.
 */
function runGroupStage(st: Extract<LfxStage, { kind: "group" }>, src: CanvasImageSource, w: number, h: number, env: PassEnv): Scratch {
  const dry = acquireScratch(w, h);
  dry.ctx.drawImage(src, 0, 0);
  const out = acquireScratch(w, h);
  runNodeStack(
    st.stages,
    dry.canvas,
    (wet) => {
      out.ctx.save();
      out.ctx.setTransform(1, 0, 0, 1, 0, 0);
      out.ctx.clearRect(0, 0, w, h);
      out.ctx.globalAlpha = 1 - st.mix;
      out.ctx.drawImage(dry.canvas, 0, 0);
      out.ctx.globalCompositeOperation = "lighter";
      out.ctx.globalAlpha = st.mix;
      out.ctx.drawImage(wet, 0, 0);
      out.ctx.restore();
    },
    env,
  );
  dry.busy = false;
  return out;
}

/** Spare lights from the light layers: the one pass that reads the light picture. */
const passReadsLights = (p: LfxPass): boolean => p.kind === "surface" && p.params.lights > 0.002 && p.params.lightsFrom === "layers";

/** Could this stack spare lights from the light layers? Read flat (a keyed dial counts), so a split never hands a lit prefix to it. */
const stackSparesLights = (clip: VisualClip, effects: VisualClip["effects"]): boolean =>
  effects.some(
    (fx) =>
      fx.enabled &&
      fx.type === "surface" &&
      fx.lightsFrom !== "colour" &&
      (fx.lights > 0 || clip.keyframes.some((t) => t.property === layerEffectPath(fx.id, "lights"))),
  );

/**
 * The light picture, the pass input's size: `paint` through `m` (frame → these
 * pixels), painted NOW — before the effect chain runs, like the backdrop.
 *
 * Never lazily from inside a pass. Painting it renders every light layer, and
 * their own effects draw from the same pass buffers (the output ring, the temp
 * pool) the asking pass is holding: a comp with enough glowing lights wrapped
 * the ring onto the surface pass's own output, which came back the size of one
 * glowing word — the material vanished and that word sat in the frame's corner.
 * Inside an UNLIT pass there are no lights to lay back (a stack that spares
 * lights, under an outer one that already took them out): null.
 */
function lightPictureNow(w: number, h: number, m: DOMMatrix, paint: (dst: CanvasRenderingContext2D) => void): Scratch | null {
  if (lightPass === "unlit") return null;
  const buf = acquireScratch(w, h);
  buf.ctx.save();
  buf.ctx.setTransform(m);
  paint(buf.ctx);
  buf.ctx.restore();
  return buf;
}

const passReadsDepth = (p: LfxPass): boolean => p.kind === "fog" || p.kind === "lensBlur" || p.kind === "depthMatte";

/**
 * The depth family's view of the scene: for a footage layer (`""` = the
 * layer being drawn), a sampler from THIS buffer's pixels to that footage's
 * depth — buffer px → frame (the buffer's own transform, inverted) → comp →
 * the footage's source px (its placement, inverted) → its map. One affine,
 * folded once, so the per-pixel cost is six multiplies and a bilinear read.
 */
function depthEnvFor(self: VisualClip, m: DOMMatrix): ((source: string) => DepthSampler | null) | undefined {
  const scene = depthScene;
  if (!scene) return undefined;
  const { doc, frame, compMs } = scene;
  return (source) => {
    const clip = source ? doc.tracks.flatMap((t) => t.clips).find((c) => c.id === source) : self;
    if (!clip || (clip.kind !== "video" && clip.kind !== "image") || clip.frameId !== frame.id) return null;
    const local = clipLocalTime(clip, compMs);
    if (local === null) return null;
    const got = depthForClip(doc, clip, local);
    const asset = doc.assets.find((a) => a.id === clip.assetId);
    if (!got || !asset?.width || !asset.height) return null;
    const inv = matInvert(footageMatrix(doc, clip, compMs));
    if (!inv) return null;
    const toSource = new DOMMatrix([inv.a, inv.b, inv.c, inv.d, inv.e, inv.f])
      .multiply(new DOMMatrix().translate(-frame.width / 2, -frame.height / 2))
      .multiply(m.inverse());
    const sx = 1 / asset.width;
    const sy = 1 / asset.height;
    const { a, b, c, d, e, f } = toSource;
    const map = got.frame;
    return (x, y) => {
      const u = (a * x + c * y + e) * sx;
      const v = (b * x + d * y + f) * sy;
      return u < 0 || v < 0 || u > 1 || v > 1 ? null : 1 - nearnessAt(map, u, v);
    };
  };
}

/** A layer's own scale at an instant, both axes averaged — what a `placed` card's lengths ride. */
function carrierScaleOf(clip: VisualClip, sampled: Record<string, KeyframeValue>): number {
  const s = typeof sampled.scale === "number" ? sampled.scale : clip.transform.scale;
  const sy = sampledScaleY(sampled, clip.transform.scaleY) ?? s;
  return (Math.abs(s) + Math.abs(sy)) / 2 || 1;
}

function applyLayerEffects(
  target: CanvasRenderingContext2D,
  clip: VisualClip,
  sampled: Record<string, KeyframeValue>,
  localMs: number,
  resolve: ColorResolver,
  draw: (target: CanvasRenderingContext2D) => void,
  /**
   * Paints the scene BEHIND this layer into a buffer aligned with the effect
   * pipeline's device space. Only material passes (glass) ask for it, and only
   * then is it called — a layer with no material pays nothing. The caller owns
   * the alignment because only it knows whether the layer is being painted
   * straight onto the composite or into an object-bounded isolation buffer.
   */
  paintBackdrop?: (dst: CanvasRenderingContext2D, w: number, h: number) => void,
  /** The effect clock's lead (`DrawOptions.effectFocus`) — shifts the effect clock only. */
  effectTimeOffsetMs = 0,
  /** The layer's vector outline in frame px, for cards that run along it. */
  outlineInFrame?: OutlineAsk,
  /**
   * Allows the STEADY PREFIX of the stack to be kept (see `steadyStackPrefix`).
   * Only the isolated path passes it: its buffer is the layer's own region, so
   * a kept prefix is the size of the layer, never of the viewport.
   */
  prefix?: { doc: MotionDocument; options: DrawOptions; modeKey: string; refs: readonly unknown[] },
  /**
   * Paints what of this layer gives off light (Spare lights reads it). Default:
   * the layer's own draw as its light picture (`paintLightPicture`). The moving
   * tail of a split stack is handed its layer's, since its `draw` replays the prefix.
   */
  paintLights: (dst: CanvasRenderingContext2D) => void = (dst) => paintLightPicture(dst, clip, draw),
): void {
  if (!anyActiveAt(clip.effects, (id) => layerEffectPath(id, ENABLED_FIELD), sampled)) {
    draw(target);
    return;
  }
  // WHERE THE STACK SPLITS. At the card under edit when there is one and the
  // instant is parked — the cards beneath it are a constant while you tune,
  // moving or not, and are run ONCE. Otherwise where the stack starts to move.
  // Under a focus the prefix runs on document time and only the cards from
  // the focus up see its clock: the preview animates the card you are
  // judging, not the grain beneath it.
  const focus = prefix?.options.effectFocus;
  const focusAt = focus && focus.clipId === clip.id && !prefix!.options.playing ? clip.effects.findIndex((fx) => fx.id === focus.effectId) : -1;
  const pinned = focusAt > 0 ? stackPrefixAt(prefix!.doc, clip, localMs, focusAt) : null;
  const split = pinned ?? (prefix ? steadyStackPrefix(prefix.doc, clip, localMs) : null);
  const headClockMs = pinned ? 0 : effectTimeOffsetMs;
  if (split && prefix) {
    // ── THE STEADY PREFIX ────────────────────────────────────────────────────
    //
    // Everything up to the first moving card, computed once per steady segment;
    // only the moving tail runs per frame. The stack runs strictly in order, so
    // the two halves chained are the whole stack.
    const w = target.canvas.width;
    const h = target.canvas.height;
    const m = target.getTransform();
    const head = { ...clip, effects: clip.effects.slice(0, split.count) } as VisualClip;
    const tail = { ...clip, effects: clip.effects.slice(split.count) } as VisualClip;
    // A tail that spares lights lays its material on the picture WITHOUT them,
    // so the prefix it reads is the unlit one (and kept as such).
    const unlitHead = stackSparesLights(clip, tail.effects);
    const headDraw = unlitHead ? (dst: CanvasRenderingContext2D) => paintUnlit(dst, clip, draw) : draw;
    const key = `${split.segment.key}${prefix.modeKey}|${w}x${h}|${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}|${split.count}${unlitHead ? "|unlit" : ""}`;
    let kept = readStackPrefix(clip, key, prefix.refs, split.count);
    let scratch: Scratch | null = null;
    if (kept) {
      // The content draw is skipped, so its click targets are replayed — the
      // same rule the layer cache keeps.
      for (const r of kept.hits) pushHitRect(prefix.options, r);
    } else {
      scratch = acquireScratch(w, h);
      scratch.ctx.save();
      scratch.ctx.setTransform(1, 0, 0, 1, 0, 0);
      scratch.ctx.clearRect(0, 0, w, h);
      scratch.ctx.setTransform(m);
      const capture = beginHitCapture(prefix.options._hitSpace);
      const before = pictureFaults();
      applyLayerEffects(scratch.ctx, head, sampled, localMs, resolve, headDraw, undefined, headClockMs, outlineInFrame);
      endHitCapture(capture);
      const captured = capture.rects;
      scratch.ctx.restore();
      if (faithfulSince(before, !prefix.options.playing)) {
        storeStackPrefix(clip, key, prefix.refs, split.count, scratch.canvas, captured, {
          exact: faithfulSince(before),
          footage: drewFootageSince(before),
        });
      }
      kept = { canvas: scratch.canvas, hits: captured };
    }
    const image = kept.canvas;
    applyLayerEffects(
      target,
      tail,
      sampled,
      localMs,
      resolve,
      (dst) => {
        dst.save();
        dst.setTransform(1, 0, 0, 1, 0, 0);
        dst.drawImage(image, 0, 0);
        dst.restore();
      },
      paintBackdrop,
      effectTimeOffsetMs,
      outlineInFrame,
      undefined,
      paintLights,
    );
    if (scratch) scratch.busy = false;
    return;
  }
  const m = target.getTransform();
  const scale = (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2 || 1;
  // Frame px → this buffer's px, for the outline a path-following card runs on.
  const outline = (inked: boolean): LightningOutline | null => {
    const o = outlineInFrame?.(inked);
    if (!o) return null;
    return {
      contours: o.contours.map((c) => c.map((p) => {
        const q = m.transformPoint(p);
        return { x: q.x, y: q.y };
      })),
      closed: o.closed,
      width: target.canvas.width,
      height: target.canvas.height,
    };
  };
  const stages = buildLfxStages(
    clip.effects,
    sampled,
    resolve,
    scale,
    localMs + effectTimeOffsetMs,
    clip.modulators,
    outline,
    (card) =>
      resolveGradeProgram(
        card,
        sampled,
        // A node's stack compiles through the SAME builder a layer's does —
        // addressed one level down. That is what makes every effect work
        // inside a corrector instead of only the colour grades.
        (effects, pathOf) =>
          buildLfxStages(effects, sampled, resolve, scale, localMs + effectTimeOffsetMs, clip.modulators, undefined, undefined, pathOf),
        resolve,
        scale,
        (localMs + effectTimeOffsetMs) / 1000,
        clip.modulators,
        // The layer's centre in this buffer. Effect bleed pads the region
        // symmetrically, so the buffer's middle IS the layer's middle — the
        // same assumption every centred card here already makes.
        { width: target.canvas.width, height: target.canvas.height, cx: target.canvas.width / 2, cy: target.canvas.height / 2 },
        localMs,
        clip.id,
      ),
    undefined,
    carrierScaleOf(clip, sampled),
  );
  const first = stages[0] as Extract<LfxStage, { kind: "css" }>;
  const paint = (ctx2: CanvasRenderingContext2D) => {
    ctx2.save();
    applyFirstStage(ctx2, first);
    draw(ctx2);
    ctx2.restore();
  };

  // No pixel pass → legacy one-ctx fast path — when the filter can ride the
  // draw. Where it cannot (WebKit), the layer takes the buffer path below and
  // its filter runs on the drawn pixels instead of silently doing nothing.
  if (stages.length === 1 && firstOpsInDraw(first)) {
    paint(target);
    return;
  }

  // Pixel pipeline: paint into a device-space buffer, run the stages in
  // order, composite the result 1:1 back onto the target (whose globalAlpha
  // and blend still apply — the layer grades as one isolated unit).
  const w = target.canvas.width;
  const h = target.canvas.height;
  // SPARE LIGHTS: the material is laid on the layer without its lights, and
  // the pass lays them back on top (`env.lights`).
  const readsLights = stages.some((st) => st.kind === "pass" && st.passes.some(passReadsLights));
  const buf = acquireScratch(w, h);
  buf.ctx.save();
  buf.ctx.setTransform(m);
  if (readsLights) paintUnlit(buf.ctx, clip, paint);
  else paint(buf.ctx);
  buf.ctx.restore();

  // Materials read what is already on the canvas beneath the layer.
  const needsBackdrop = stages.some((st) => st.kind === "pass" && st.passes.some(passNeedsBackdrop));
  let back: Scratch | null = null;
  if (needsBackdrop) {
    back = acquireScratch(w, h);
    if (paintBackdrop) paintBackdrop(back.ctx, w, h);
    else back.ctx.drawImage(target.canvas, 0, 0); // painted straight onto the composite
  }

  // Painted before anything below takes a pass buffer (see `lightPictureNow`).
  const lights = readsLights ? lightPictureNow(w, h, m, paintLights) : null;
  const head = firstOpsAfterDraw(first, buf.canvas, w, h);
  const { img, finalOps, release } = runLfxPixelStages(stages, head.img, w, h, {
    backdrop: back?.canvas ?? null,
    depth: stages.some((st) => st.kind === "pass" && st.passes.some(passReadsDepth)) ? depthEnvFor(clip, m) : undefined,
    lights: lights?.canvas ?? null,
  });
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  if (finalOps) drawFiltered(target, img, finalOps);
  else target.drawImage(img, 0, 0);
  target.restore();
  buf.busy = false;
  if (back) back.busy = false;
  if (lights) lights.busy = false;
  head.release();
  release();
}

/**
 * Everything OUTSIDE a processor's own properties that modulates it at an
 * instant: its in/out animation, and — when a cut is live over it — that cut's
 * mix, wipe and veil for the side it is on.
 *
 * It exists so a grade is animated by the same machinery a picture is. Before
 * it, `renderAdjustment` read the clip's keyframes and nothing else, which is
 * why an adjustment layer could be given an in-animation in the inspector and
 * simply not play it, and why a transition dropped on one did nothing at all:
 * the two features were wired to `withLayer`, and a processor does not go
 * through `withLayer` — it grades pixels that are already there.
 */
interface AdjustmentMix {
  /** In/out ∘ transition pose. Translate/scale/rotate size it, alpha mixes it. */
  pose: GlyphVisual;
  /** A transition's wipe, matting the graded region down to the swept side. */
  wipe: WipeSpec | null;
  /** A dip's veil, laid over the graded pixels only. */
  veil: { color: string; alpha: number } | null;
}

const IDENTITY_MIX: AdjustmentMix = { pose: GLYPH_IDENTITY, wipe: null, veil: null };

/** The processor's mix from its own in/out animation alone — the common case. */
function layerAnimMix(clip: AdjustmentClip, localMs: number): AdjustmentMix {
  const pose = layerPoseAt(clip, localMs);
  return pose === GLYPH_IDENTITY ? IDENTITY_MIX : { pose, wipe: null, veil: null };
}

/**
 * IS THE COMPOSITE ALREADY THE PICTURE A REGIONAL GRADE READS?
 *
 * A regional stack reads the comp painted from the document (`paintBeneath`),
 * because the canvas is the VIEWPORT: zoomed in, it holds only the middle of
 * the comp, and a surface reading it took the empty rest for ground. But when
 * the canvas holds the WHOLE region — the comp fully on screen, every layer
 * beneath already painted onto it — the two are the same pixels, and the
 * re-paint was a second render of the entire scene every frame (a vignette and
 * a grain on a film: half of what playing it cost). Then the composite is the
 * input, projected into the region like a region-blind grade's.
 *
 * Only on the real composite: never a slice of one (`_onComposite`), a
 * layer-scoped draw, a transparent pass, a matte, an export, or a grade that
 * needs the picture without its lights.
 */
function compositeHoldsRegion(
  ctx: CanvasRenderingContext2D,
  m: DOMMatrix,
  R: DOMMatrix,
  w: number,
  h: number,
  options: DrawOptions,
  readsLights: boolean,
): boolean {
  if (readsLights || options.exporting || options.only || options._onComposite || options.transparent || options._inBackdrop || matteDepth > 0) return false;
  const toCanvas = m.multiply(R.inverse());
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const EPS = 0.5;
  for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]] as const) {
    const p = toCanvas.transformPoint({ x, y });
    if (p.x < -EPS || p.y < -EPS || p.x > cw + EPS || p.y > ch + EPS) return false;
  }
  return true;
}

/**
 * Render one adjustment layer (v39): grade the reachable composite currently on
 * `ctx` through the shared effect stack, keep the graded pixels inside the scope
 * matte, and composite back at the layer's opacity (wet/dry mix) + blend mode.
 * The "content" is pixels already painted — so this reuses the exact same
 * `buildLfxStages` / `runLfxPixelStages` pipeline every clip's own effects use,
 * with a snapshot standing in for the fresh draw. `timeMs`/`guard` drive the
 * scope matte, which re-renders the target set's silhouette through the ONE
 * layer-scoped draw path (`options.only`) — include/exclude for free.
 */
function renderAdjustment(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: AdjustmentClip,
  localMs: number,
  timeMs: number,
  resolve: ColorResolver,
  options: DrawOptions,
  guard: Set<string>,
  mix: AdjustmentMix = IDENTITY_MIX,
): void {
  // The adjustment RUNS when it has an effect stack OR a non-identity transform
  // (the DaVinci "sizing" node — pan/zoom/rotate the whole composite below), OR
  // when something is animating it. Both are keyframable and compose: stacked
  // adjustments each grade+transform what the previous produced, bottom→top,
  // like nodes.
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const hasFx = anyActiveAt(clip.effects, (id) => layerEffectPath(id, ENABLED_FIELD), sampled);
  const pose = evaluateBoxPose(clip, localMs);
  const xform = adjustmentPoseMatrix(frame, pose, mix.pose);
  const hasXform = xform !== null;
  if (!hasFx && !hasXform) return;
  // The in/out animation and a live cut are BOTH just a pose over the layer's
  // own: their translate/scale/rotate size the graded region (folded into
  // `xform` above) and their alpha is the grade's wet/dry mix. That is the
  // whole reason an adjustment can wear an animation preset at all — a "fade
  // in" ramps the grade on, a "slide" pushes the graded picture across.
  const opacity = pose.opacity * mix.pose.opacity;
  if (opacity <= 0.001) return;

  const targets = resolveAdjustmentTargets(doc, frame.id, clip);
  if (!targets.wholeReach && targets.matteIds.size === 0) return; // grades nothing

  const m = ctx.getTransform();
  const pinned = needsDocumentRaster(clip.effects);
  // THE SPILL CANNOT SEE IT. A pinned whole-comp grade works in the comp's own
  // box and nowhere else, and the spill pass is clipped to everything BUT that
  // box: graded there, every pixel was thrown away — after re-painting the
  // whole scene beneath to grade it (`paintBeneath`), every frame.
  if (pinned && options.overflowPass === "outside" && targets.wholeReach && !hasXform && !mix.wipe) return;

  // THE REGION an adjustment is applied to. A layer's region is its silhouette;
  // an adjustment layer has no box of its own — it spans its comp — so the comp
  // IS its region, and `R` maps frame space into it.
  //
  // A REGIONAL stack (grain, film damage, vignette, glass, …) has to rasterise
  // in the frame's own space, at most the document's scale: given the canvas instead,
  // its pattern is laid across the STAGE VIEWPORT, so it slides when the board
  // is panned and re-rolls at every zoom — and none of those pictures is the
  // one that exports. A region-blind stack (a colour grade, a CSS filter) is
  // exact wherever it runs, so it keeps the canvas, which is both the sharpest
  // buffer and the only one that costs nothing extra.
  const MAX_BUFFER_DIM = MAX_LAYER_BUFFER_PX;
  const MAX_REGIONAL_PIXELS = 2_097_152;
  // At the scale the comp is SEEN (`seenScale`): a look on a comp shown as a
  // third-size tile was made at the comp's full size.
  let R = pinned
    ? new DOMMatrix([1, 0, 0, 1, 0, 0]).scale(
        Math.min(seenScale((Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2), MAX_BUFFER_DIM / Math.max(frame.width, frame.height)),
      )
    : m;
  let w = pinned ? pixelCount(frame.width * R.a) : ctx.canvas.width;
  let h = pinned ? pixelCount(frame.height * R.d) : ctx.canvas.height;
  // A SCOPED stack works where its layers are, not across the whole comp. The
  // matte below already confines the RESULT to them; this confines the WORK —
  // a boil scoped to one character distorted every pixel of a 1100² comp each
  // frame, and a halftone took seconds. Skipped when a sizing pose or a wipe
  // can carry pixels in from outside the layers' own box.
  if (pinned && !targets.wholeReach && !hasXform && !mix.wipe) {
    const box = scopedWorkBox(doc, frame, timeMs, targets.matteIds, options, resolve, guard, stackReach(clip.effects, sampled));
    if (!box) return; // the scoped layers paint nothing this frame
    const s = R.a;
    R = R.translate(-box.x, -box.y);
    w = pixelCount(box.w * s);
    h = pixelCount(box.h * s);
  }
  const scale = (Math.hypot(R.a, R.b) + Math.hypot(R.c, R.d)) / 2 || 1;

  const stages = buildLfxStages(
    clip.effects,
    sampled,
    resolve,
    scale,
    localMs + focusLead(options, clip.id),
    clip.modulators,
    undefined,
    // An adjustment layer grades pixels it does not own, so a window drawn in
    // ITS space has no layer box to be centred on. Grade graphs on adjustments
    // are therefore not resolved here yet, rather than drawn in the wrong place.
    undefined,
  );
  const first = stages[0] as Extract<LfxStage, { kind: "css" }>;
  // SPARE LIGHTS: a surface that spares the light layers is laid on the
  // picture without them, and lays them back on top (`env.lights`).
  const readsLights = stages.some((st) => st.kind === "pass" && st.passes.some(passReadsLights));

  // THE INPUT. A region-blind stack (a grade, a CSS filter) reads the reachable
  // composite straight off the canvas — device pixels projected through R·m⁻¹,
  // the identity whenever the region is the canvas — and is exact there.
  //
  // A REGIONAL stack reads the PICTURE: a surface finds the ground and cuts the
  // shapes from it, a halftone screens it. Its input is the comp's own picture,
  // painted from the document into the region (`paintBeneath`), never the
  // canvas: a comp seen through a ×2.2 camera shows the canvas only its middle,
  // so the snapshot was mostly empty, the surface took "transparent" for the
  // ground, and the whole board became one shape — tooth on the card, chalk a
  // smooth fill. The same comp is now the same picture at any zoom, nested or
  // drilled into, and the same one the comp-picture store keeps.
  const cropBox = { width: frame.width, height: frame.height, cx: 0, cy: 0 };
  const win = cropWindow(pose.crop, cropBox);
  const radius = pose.borderRadius;
  const windowed =
    win.width < frame.width - 0.01 ||
    win.height < frame.height - 0.01 ||
    radius.tl > 0.01 || radius.tr > 0.01 || radius.br > 0.01 || radius.bl > 0.01;

  // ── THE KEPT LOOK ──────────────────────────────────────────────────────────
  // A whole-comp look (Stop motion, Claymation, chalk…) is a pure function of
  // the picture it reads, the card, the instant and the region it was made in —
  // and the region is the comp's own (`R`), not the view. So a camera move
  // never changes it: panning a paused board re-ran a surface and film damage
  // over every pixel of the comp on every pointer tick, which is why the stage
  // went heavy zoomed in (R is the document's scale there) and was fine zoomed
  // out (R shrinks with the zoom). Keyed by what the picture beneath depends on
  // (`paintBeneath`'s own deps — the same proof the backdrop shelf trusts), it
  // is made once per instant and only re-landed under the new view.
  const keepable = pinned && targets.wholeReach && mix === IDENTITY_MIX && !hasXform && !windowed && !options.measureOnly && !options.exporting;
  const lookDeps = keepable ? paintBeneath(doc, frame, clip, timeMs, options, resolve, guard) : undefined;
  const lookKey = lookDeps?.key && lookDeps.refs
    ? `${lookDeps.key}|${localMs}|${w}x${h}|${R.a},${R.b},${R.c},${R.d},${R.e},${R.f}${lightsKey()}`
    : null;
  const lookRefs = lookDeps?.refs ? [clip, ...lookDeps.refs] : null;
  const shelf = `${clip.id}${lightsKey()}|${options.overflowPass ?? ""}`;
  const kept = lookKey && lookRefs ? keptLook(shelf, lookKey, lookRefs) : null;

  const produce = (): { canvas: HTMLCanvasElement | OffscreenCanvas; region: Scratch | null; free: () => void } => {
    const src = acquireScratch(w, h);
    src.ctx.save();
    src.ctx.setTransform(R);
    const painted =
      pinned &&
      !compositeHoldsRegion(ctx, m, R, w, h, options, readsLights) &&
      withLightPass(readsLights ? "unlit" : lightPass, () => {
        const beneath = paintBeneath(doc, frame, clip, timeMs, options, resolve, guard);
        beneath?.paint(src.ctx);
        return !!beneath;
      });
    if (!painted) {
      src.ctx.setTransform(R.multiply(m.inverse()));
      src.ctx.drawImage(ctx.canvas, 0, 0);
    }
    src.ctx.restore();

    // The light picture of what this grade reads, painted before anything below
    // takes a pass buffer (see `lightPictureNow`): the lights in what it reads,
    // at any depth, in the same region (the comp's paper is never one).
    const lights = readsLights
      ? lightPictureNow(w, h, R, (dst) => {
          matteDepth++;
          try {
            withLightPass("only", () => paintBeneath(doc, frame, clip, timeMs, { ...options, transparent: true }, resolve, guard)?.paint(dst));
          } finally {
            matteDepth--;
          }
        })
      : null;

    // Apply the first CSS stage while blitting the snapshot into a clean buffer.
    const graded = acquireScratch(w, h);
    graded.ctx.save();
    applyFirstStage(graded.ctx, first);
    graded.ctx.drawImage(src.canvas, 0, 0);
    graded.ctx.restore();

    // An adjustment layer's "content" IS the composite beneath it, so that
    // snapshot doubles as the backdrop: glass on an adjustment becomes a pane of
    // glass laid over the whole scene (scoped by the same matte as any grade).
    const gradedHead = firstOpsAfterDraw(first, graded.canvas, w, h);
    const { img, finalOps, release } = runLfxPixelStages(stages, gradedHead.img, w, h, {
      backdrop: src.canvas,
      lights: lights?.canvas ?? null,
    });

    // Land the graded result (+ trailing filter) into an output buffer we can matte.
    const out = acquireScratch(w, h);
    out.ctx.save();
    if (finalOps) drawFiltered(out.ctx, img, finalOps);
    else out.ctx.drawImage(img, 0, 0);
    out.ctx.restore();
    gradedHead.release();

    // ── THE PROCESSOR'S REGION ────────────────────────────────────────────────
    //
    // What this grade is allowed to touch, as ONE alpha stencil:
    //
    //   scope    the picked layers' silhouette (`resolveAdjustmentTargets`),
    //            rendered through the shared layer-scoped draw path
    //   window   a rectangular crop, rounded by `borderRadius` — the same two
    //            box properties every footage layer carries, which on a processor
    //            (whose "box" IS its comp) read as a Resolve power window
    //   feather  the soft edge on the FINISHED silhouette
    //
    // Intersected into one buffer rather than applied one at a time, because the
    // feather has to soften what the pieces add up to — a window feathered before
    // it met the scope matte would blur an edge that is not the edge you see. It
    // is also exactly the shape `replaces` erases from the plate below, so "what
    // this grade covers" is computed once and answers both questions.
    const featherPx = Math.max(0, typeof sampled["feather"] === "number" ? (sampled["feather"] as number) : clip.feather);

    // A ref cell, not a `let`: the buffer is assigned inside the narrowing
    // closure, which control-flow analysis cannot follow.
    const region: { current: Scratch | null } = { current: null };
    const narrowRegion = (paint: (dst: CanvasRenderingContext2D) => void): void => {
      const layer = acquireScratch(w, h);
      layer.ctx.save();
      layer.ctx.setTransform(R);
      paint(layer.ctx);
      layer.ctx.restore();
      const held = region.current;
      if (!held) {
        region.current = layer;
        return;
      }
      held.ctx.save();
      held.ctx.setTransform(1, 0, 0, 1, 0, 0);
      held.ctx.globalCompositeOperation = "destination-in";
      held.ctx.drawImage(layer.canvas, 0, 0);
      held.ctx.restore();
      layer.busy = false;
    };

    if (!targets.wholeReach) {
      narrowRegion((dst) =>
        paintLayerNodes(
          dst,
          doc,
          frame,
          frameLayerTree(doc, frame.id),
          timeMs,
          { ...options, only: targets.matteIds, includeHidden: true },
          resolve,
          guard,
        ),
      );
    }
    if (windowed) {
      narrowRegion((dst) => {
        roundRect(
          dst,
          win.cx + frame.width / 2 - win.width / 2,
          win.cy + frame.height / 2 - win.height / 2,
          win.width,
          win.height,
          radius,
        );
        dst.fillStyle = "#000";
        dst.fill();
      });
    }
    // The one universal feather (`featherLayerAlpha`) — the same function that
    // softens a plain layer's edge and a mask stencil, eating inward so the
    // window fades away exactly at its border instead of glowing past it.
    if (region.current && featherPx > 0.01) featherLayerAlpha(region.current, featherPx * scale);

    const applyStencil = (canvas: HTMLCanvasElement | OffscreenCanvas) => {
      out.ctx.save();
      out.ctx.setTransform(1, 0, 0, 1, 0, 0);
      out.ctx.globalCompositeOperation = "destination-in";
      out.ctx.drawImage(canvas, 0, 0);
      out.ctx.restore();
    };
    if (region.current) applyStencil(region.current.canvas);
    // A transition's wipe is NOT part of the region: the sweep carries its own
    // softness from the preset, and it must not be erased from the plate the way
    // the region is — a cut reveals, it does not cut a hole.
    if (mix.wipe) {
      const wipeMatte = acquireScratch(w, h);
      wipeMatte.ctx.save();
      wipeMatte.ctx.setTransform(R);
      paintWipeStencil(wipeMatte.ctx, frame, mix.wipe, scale);
      wipeMatte.ctx.restore();
      applyStencil(wipeMatte.canvas);
      wipeMatte.busy = false;
    }

    // A dip's veil, over the pixels this grade owns and no others (`source-atop`),
    // exactly as the picture path confines it to the transition's own pixels.
    if (mix.veil) {
      out.ctx.save();
      out.ctx.setTransform(R);
      out.ctx.globalCompositeOperation = "source-atop";
      out.ctx.globalAlpha = mix.veil.alpha;
      out.ctx.fillStyle = mix.veil.color;
      out.ctx.fillRect(0, 0, frame.width, frame.height);
      out.ctx.restore();
    }

    return {
      canvas: out.canvas,
      region: region.current,
      free: () => {
        src.busy = false;
        graded.busy = false;
        out.busy = false;
        if (lights) lights.busy = false;
        if (region.current) region.current.busy = false;
        release();
      },
    };
  };
  let made: ReturnType<typeof produce>;
  if (kept) {
    made = { canvas: kept, region: null, free: () => {} };
  } else {
    const before = pictureFaults();
    made = produce();
    if (lookKey && lookRefs && faithfulSince(before, !options.playing)) {
      keepLook(shelf, lookKey, lookRefs, made.canvas, faithfulSince(before), drewFootageSince(before));
    }
  }

  // Composite the graded (and optionally transformed) region back over the
  // original at mix + blend. Everything is CLIPPED to the frame rect: the stage
  // paints every board frame onto one canvas, so without this an adjustment
  // would bleed into its neighbours — and the clip doubles as the "sizing"
  // viewport, so a zoom/pan stays inside its own frame like DaVinci.
  ctx.save();
  ctx.setTransform(m);
  ctx.beginPath();
  ctx.rect(0, 0, frame.width, frame.height);
  ctx.clip();
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  ctx.globalCompositeOperation = COMPOSITE[clip.blendMode];
  // SOURCE: does the grade consume what it read? With `replaces`, the region is
  // erased from the plate before the result lands, so a sizing pose MOVES the
  // picture (a zoom-out reveals the background, not a ghost of the original;
  // a scoped grade slides the layer instead of leaving an un-graded twin
  // sitting under its own copy). "over" keeps the original underneath.
  //
  // Only ever at unity opacity through a normal blend — below that, "replace"
  // has no meaning: a partial mix IS a crossfade between the two, and erasing
  // first would crossfade against a hole. A wipe never erases either; the cut
  // is revealing the grade, not cutting into the frame.
  //
  // A grade that CARVES (`carves`: a screen's gaps, a matte) consumes too: it
  // never moves a pixel, but where it leaves nothing the original must not show
  // through — an LED board on an adjustment layer read as the photo behind it.
  const carves = anyActiveAt(
    clip.effects.filter((fx) => layerEffectCarves(fx.type)),
    (id) => layerEffectPath(id, ENABLED_FIELD),
    sampled,
  );
  if ((hasXform || carves) && targets.replaces && !mix.wipe && opacity >= 0.999 && clip.blendMode === "normal") {
    if (made.region) {
      // Erase exactly the region — untransformed, because what is being removed
      // is the SOURCE where it sits, not where the grade is about to put it.
      const undo = m.multiply(R.inverse());
      ctx.save();
      ctx.setTransform(undo.a, undo.b, undo.c, undo.d, undo.e, undo.f);
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 1;
      ctx.drawImage(made.region.canvas, 0, 0);
      ctx.restore();
    } else {
      ctx.clearRect(0, 0, frame.width, frame.height);
    }
    // PUT THE PAPER BACK.
    //
    // The plate we just cut into is the whole composite, and the bottom of that
    // composite is the ARTBOARD — so erasing a region punched a hole clean
    // through the frame's own background and out the other side: a black shape
    // on the dark stage, a white one in the render, and an alpha hole on export.
    //
    // A grade consumes the LAYERS it read, never the paper they sit on (the
    // same reason a DaVinci sizing node zoomed out shows the canvas, not a
    // window into nothing). `destination-over` fills exactly the hole, because
    // every other pixel inside the frame rect is already opaque background.
    // `transparent` is the one case a hole is honest: there is no paper.
    if (!options.transparent) {
      const boxFrame = options._boxFrame ?? frame;
      const paper = acquireScratch(ctx.canvas.width, ctx.canvas.height);
      paper.ctx.save();
      paper.ctx.setTransform(m);
      // Through the frame's OWN painter, so fills, gradients and blend modes
      // come back exactly as `drawFrameContent` laid them down. It sets its own
      // composite op per fill, which is why it paints into a buffer first
      // rather than straight through a `destination-over` on the target.
      paintFrameBox(paper.ctx, boxFrame, resolve);
      paper.ctx.restore();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "destination-over";
      ctx.globalAlpha = 1;
      ctx.drawImage(paper.canvas, 0, 0);
      ctx.restore();
      paper.busy = false;
    }
  }
  // Region px → frame px (R⁻¹), the frame-space sizing pose, then the canvas:
  // m·pose·R⁻¹. With the region on the canvas (R = m) this collapses to the
  // conjugation m·pose·m⁻¹ the device-space path used, and to the identity when
  // there is no pose — one expression instead of a branch per space.
  const place = hasXform ? m.multiply(xform).multiply(R.inverse()) : m.multiply(R.inverse());
  ctx.setTransform(place.a, place.b, place.c, place.d, place.e, place.f);
  // An animation's BLUR softens the graded result on its way back, in the same
  // device-scaled px `withLayer` uses for a painted layer — otherwise a preset
  // like "Blur in" would land on a processor with its most characteristic half
  // silently dropped.
  drawFiltered(ctx, made.canvas, mix.pose.blur > 0.2 ? [{ kind: "blur", px: mix.pose.blur * Math.hypot(m.a, m.b) }] : []);
  ctx.restore();

  made.free();
}

/** The one small readback canvas the scoped-work probe measures on. */
let workProbe: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
const WORK_PROBE_DIM = 192;
const WORK_ORIGIN_GRID = 256;

/**
 * WHERE A SCOPED ADJUSTMENT HAS WORK TO DO — its layers' painted extent this
 * frame, in frame px, grown by how far the stack can move a pixel, clamped to
 * the frame. Measured by painting the scope matte at a thumbnail's size and
 * reading its alpha: the same draw path the matte itself uses, so a nested
 * comp, a group, an animated layer or a flipbook cell all bound themselves
 * without a per-kind rule. Null = nothing of the scope paints now.
 */
function scopedWorkBox(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  matteIds: ReadonlySet<string>,
  options: DrawOptions,
  resolve: ColorResolver,
  guard: Set<string>,
  reach: number,
): { x: number; y: number; w: number; h: number } | null {
  const k = Math.min(1, WORK_PROBE_DIM / Math.max(frame.width, frame.height));
  const cw = pixelCount(frame.width * k);
  const ch = pixelCount(frame.height * k);
  if (!workProbe) {
    const canvas = document.createElement("canvas");
    workProbe = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true })! };
  }
  const { canvas, ctx } = workProbe;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  } else {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
  }
  ctx.save();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  paintLayerNodes(ctx, doc, frame, frameLayerTree(doc, frame.id), timeMs, { ...options, only: new Set(matteIds), includeHidden: true, hitRects: undefined }, resolve, guard);
  ctx.restore();
  const px = ctx.getImageData(0, 0, cw, ch).data;
  let minX = cw, minY = ch, maxX = -1, maxY = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (px[(y * cw + x) * 4 + 3]! === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  // One probe pixel of slack each side (the thumbnail rounds), plus the reach.
  const pad = reach + 1 / k;
  // The origin snaps to a coarse grid: a regional stack's noise and pattern are
  // laid from the buffer's origin, so a box that followed its layer every frame
  // would make a boil or a halftone swim across the character. Snapped, it holds
  // still while the layer moves inside it.
  const x0 = Math.max(0, Math.floor((minX / k - pad) / WORK_ORIGIN_GRID) * WORK_ORIGIN_GRID);
  const y0 = Math.max(0, Math.floor((minY / k - pad) / WORK_ORIGIN_GRID) * WORK_ORIGIN_GRID);
  const x1 = Math.min(frame.width, (maxX + 1) / k + pad);
  const y1 = Math.min(frame.height, (maxY + 1) / k + pad);
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
}

/**
 * How far a layer-effect stack can carry a pixel from where it was, in frame px
 * — generous by design: over-reaching costs a little work, under-reaching cuts
 * the effect at an edge. Reads the stack's own size-like fields (a boil's
 * amount and wiggle size, a blur's radius, a glow's size, a pixel block…).
 */
function stackReach(effects: readonly LayerEffect[], sampled: Record<string, unknown>): number {
  let reach = 24;
  for (const e of effects) {
    const rec = e as unknown as Record<string, unknown>;
    let r = 0;
    for (const key of ["amount", "radius", "size", "blur", "scale", "spread", "distance"]) {
      const live = sampled[layerEffectPath(e.id, key)];
      const v = typeof live === "number" ? live : typeof rec[key] === "number" ? (rec[key] as number) : 0;
      r = Math.max(r, key === "amount" ? v * 3 : key === "radius" || key === "blur" ? v * 3 : v);
    }
    reach += Math.min(400, r);
  }
  return reach;
}

/**
 * The adjustment's own transform as a frame-space matrix around the frame centre
 * (T·R·K·S, the same order layers use), or null when it's the identity — so a
 * plain grade skips all the sizing work. This is what turns an adjustment into a
 * DaVinci "sizing" node: its pan/zoom/rotate/skew move the whole composite it
 * grades, and because each adjustment sees the one below already transformed,
 * stacked sizing nodes compose for free.
 */
function adjustmentPoseMatrix(frame: Frame, pose: BoxPose, anim: GlyphVisual = GLYPH_IDENTITY): DOMMatrix | null {
  // An adjustment has no intrinsic box — it spans its comp, so that IS its box.
  const a = anchorLocal(pose.anchor, { width: frame.width, height: frame.height, cx: 0, cy: 0 });
  const animating = !isIdentityPose(anim) && (anim.dx !== 0 || anim.dy !== 0 || anim.scale !== 1 || anim.rotation !== 0);
  if (
    !animating &&
    pose.x === 0 &&
    pose.y === 0 &&
    pose.scale === 1 &&
    pose.scaleY === 1 &&
    pose.rotation === 0 &&
    pose.skewX === 0 &&
    pose.skewY === 0 &&
    a.x === 0 &&
    a.y === 0
  ) {
    return null;
  }
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  const skew = new DOMMatrix([1, Math.tan((pose.skewY * Math.PI) / 180), Math.tan((pose.skewX * Math.PI) / 180), 1, 0, 0]);
  const M = new DOMMatrix()
    .translate(cx + pose.x, cy + pose.y)
    .rotate(pose.rotation)
    .multiply(skew)
    .scale(pose.scale, pose.scaleY)
    .translate(-a.x, -a.y)
    .translate(-cx, -cy);
  if (!animating) return M;
  // The in/out (or transition) pose acts about the processor's POSITION in
  // frame space — the same pivot `layerPlacement` uses for a painted layer, so
  // a preset cannot describe one arc on a shape and a different one on a grade.
  const ax = cx + pose.x;
  const ay = cy + pose.y;
  return new DOMMatrix()
    .translate(ax + anim.dx, ay + anim.dy)
    .rotate(anim.rotation)
    .scale(anim.scale)
    .translate(-ax, -ay)
    .multiply(M);
}

interface BoxPose {
  x: number;
  y: number;
  scale: number;
  scaleY: number;
  rotation: number;
  skewX: number;
  skewY: number;
  /** Sampled PIVOT, normalized to the layer's box — see core `transform-map`. */
  anchor: AnchorPoint;
  opacity: number;
  /** Universal PER-CORNER border radius (frame px), keyframe-sampled. All 0 = square. */
  borderRadius: CornerRadius;
  /** The crop WINDOW's insets (box px), keyframe-sampled. All 0 = the whole box. */
  crop: CropInsets;
  /**
   * Where the PICTURE sits inside that window (v68), keyframe-sampled. Identity
   * = square in the window, and every seam checks `contentIsIdentity` before
   * doing anything, so an untouched layer renders exactly as it did before the
   * field existed. See core `contentTransformSchema`.
   */
  content: ContentTransform;
}

/**
 * The content transform's vertical zoom, on the same `null = uniform` rule the
 * layer transform uses — and broken by a key on `content.scaleY` exactly as the
 * layer's is, so the two axes can part ways mid-animation.
 */
function resolveContentScaleY(
  content: ContentTransform,
  n: (key: string, fallback: number) => number,
): number | null {
  const keyed = n("content.scaleY", Number.NaN);
  // `null` is kept as `null` — core's `contentScaleY` reads it against the
  // SAMPLED `scale`, so a uniform zoom keeps both axes together while it
  // animates instead of freezing Y at the design-time value.
  return Number.isNaN(keyed) ? content.scaleY : keyed;
}

/**
 * The rects each layer currently being cached has pushed — ONE ENTRY PER
 * ENCLOSING CACHE, innermost last.
 *
 * Hit testing and painting are the same pass in this renderer: `drawShapeClip`,
 * `drawPathClip` and `drawTextClip` emit their click targets while they draw.
 * That is a good arrangement — one walk, one answer for where a layer is — and
 * it has one consequence for a cache: a HIT skips the draw, so it would also
 * skip the rects, and a cached layer would render perfectly and be impossible
 * to click, with no selection box and no gizmo.
 *
 * So the rects travel with the pixels. Module-level rather than threaded
 * through the options, for the same reason `rasterScale` is: the draw callback
 * is a closure built by the caller, and there is nothing to thread through.
 */
/**
 * WHY A STACK. Caches nest: a glass group is kept, and so is the rectangle
 * inside it, and so is the steady prefix of that rectangle's effect stack. A
 * rect must reach EVERY one of them, because any of them may be the entry that
 * is replayed next. A single slot saved and restored around each cache meant
 * the inner one swallowed its contents' rects — a group whose members were
 * cached (or merely drawn while an uncached member cleared the slot) replayed
 * with no member targets, so its children painted and could not be clicked or
 * framed. Each cache now only brackets itself; no cache can hide a rect from
 * another, whatever the effect, stroke or nesting that caused it.
 */
interface HitCapture {
  base: HitSpace | null;
  rects: Omit<ClipHitRect, "depth">[];
}
const hitCaptures: HitCapture[] = [];

/** Start recording rects relative to `base` — the caching layer's own space. */
function beginHitCapture(base: HitSpace | undefined): HitCapture {
  const capture: HitCapture = { base: base ?? null, rects: [] };
  hitCaptures.push(capture);
  return capture;
}

/** Stop recording; drops anything a draw that threw left above it too. */
function endHitCapture(capture: HitCapture): void {
  const at = hitCaptures.lastIndexOf(capture);
  if (at >= 0) hitCaptures.length = at;
}

/** Once per stage frame, beside `resetKeptUnits`: a render that threw must not leave a capture open. */
export function resetHitCaptures(): void {
  hitCaptures.length = 0;
}

/** See `DrawOptions.renderScale`. Document px per frame px for rasterised work. */
let rasterScale = 1;
/** Device px per ROOT comp px for the draw in progress (set by the root `drawFrameContent`). */
let rootDeviceScale = 1;

/**
 * The crop window's insets at an instant — the ONE reader, for every kind that
 * crops (a box layer through `withBoxClip`, a text block through
 * `drawGlyphBlock`). The property registry offers crop on every visual layer,
 * so a painter that skipped it took keys and drew nothing different.
 */
function sampleCrop(clip: { crop: CropInsets }, kf: Record<string, unknown>): CropInsets {
  const n = (key: string, fallback: number) => (typeof kf[key] === "number" ? (kf[key] as number) : fallback);
  return {
    top: n("crop.top", clip.crop.top),
    right: n("crop.right", clip.crop.right),
    bottom: n("crop.bottom", clip.crop.bottom),
    left: n("crop.left", clip.crop.left),
  };
}

const hasCrop = (c: CropInsets) => c.top > 0 || c.right > 0 || c.bottom > 0 || c.left > 0;

/** Clip a posed layer's drawing to its crop window — `box` is what the pivot is a fraction of. */
function clipToCrop(ctx: CanvasRenderingContext2D, crop: CropInsets, box: LayerBox): void {
  if (!hasCrop(crop)) return;
  const win = cropWindow(crop, box);
  ctx.beginPath();
  ctx.rect(win.cx - win.width / 2, win.cy - win.height / 2, win.width, win.height);
  ctx.clip();
}

/** Transform + opacity pose for box-like clips (nested comps, images, videos, waveforms). */
function evaluateBoxPose(
  clip: NestedClip | ImageClip | VideoClip | WaveformClip | RasterClip | AdjustmentClip | GroupClip | MeshClip | CameraClip | LightClip | EmptyClip,
  localMs: number,
): BoxPose {
  const kf = sampleKeyframes(clip.keyframes, localMs);
  const n = (key: string, fallback: number) => (typeof kf[key] === "number" ? (kf[key] as number) : fallback);
  const scale = n("scale", clip.transform.scale);
  const pose: BoxPose = {
    x: n("x", clip.transform.x),
    y: n("y", clip.transform.y),
    scale,
    scaleY: sampledScaleY(kf, clip.transform.scaleY) ?? scale,
    rotation: n("rotation", clip.transform.rotation),
    skewX: n("skewX", clip.transform.skewX),
    skewY: n("skewY", clip.transform.skewY),
    anchor: { x: n("anchor.x", clip.transform.anchor.x), y: n("anchor.y", clip.transform.anchor.y) },
    opacity: n("opacity", clip.opacity),
    borderRadius: {
      tl: n("borderRadius.tl", n("borderRadius", clip.borderRadius.tl)),
      tr: n("borderRadius.tr", n("borderRadius", clip.borderRadius.tr)),
      br: n("borderRadius.br", n("borderRadius", clip.borderRadius.br)),
      bl: n("borderRadius.bl", n("borderRadius", clip.borderRadius.bl)),
    },
    crop: sampleCrop(clip, kf),
    content: {
      x: n("content.x", clip.content.x),
      y: n("content.y", clip.content.y),
      scale: n("content.scale", clip.content.scale),
      scaleY: resolveContentScaleY(clip.content, n),
      rotation: n("content.rotation", clip.content.rotation),
    },
  };
  return pose;
}

/**
 * The ART, placed inside the window — what `paint` wraps whatever actually
 * draws the picture in (see `withBoxClip`'s `paint(content)` argument).
 *
 * It is handed to the painter rather than wrapped around the whole of it
 * deliberately. A layer's box holds two different kinds of ink: the PICTURE
 * (footage, a drawing's pixels, a nested comp) and the window's own DRESSING (a
 * solid or gradient fill behind it, the border stroke that hugs the cropped
 * rect). Panning the footage must not drag the border off with it, so the
 * painter says which of its ink is the picture. One word at each call site, and
 * the alternative — wrapping everything — is a border that swims.
 */
export type ContentWrap = (draw: () => void) => void;

/**
 * Shared box-clip framing: registers the hit rect, applies pose transform and
 * alpha, then hands the painter a centered w×h box. Returns false when the
 * clip shouldn't paint (skipped or fully transparent).
 */
function withBoxClip(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  clip: NestedClip | ImageClip | VideoClip | WaveformClip | RasterClip,
  pose: BoxPose,
  width: number,
  height: number,
  options: DrawOptions,
  paint: (content: ContentWrap) => void,
  /** Clip to the box even uncropped — a windowed nested comp (`nestedClipsContent`). */
  windowed = false,
): void {
  // The media box is centred on the layer's origin, so the pivot's box carries
  // no offset — the CROP window's own centre travels separately, as `geoCenter`.
  // The window itself comes from core's `cropWindow`, which is also what sizes
  // the isolation buffer and the shutter region: one clamp, so a buffer can
  // never be measured around a different rectangle than the one that paints.
  const size = { width, height, cx: 0, cy: 0 };
  const win = cropWindow(pose.crop, size);
  const croppedWidth = win.width;
  const croppedHeight = win.height;
  const cropCenterX = win.cx;
  const cropCenterY = win.cy;
  const x0 = win.cx + width / 2 - win.width / 2;
  const y0 = win.cy + height / 2 - win.height / 2;
  const x1 = x0 + win.width;
  const y1 = y0 + win.height;
  const full = layerCenter(frame, pose, size);
  const croppedCentre = layerCenter(frame, pose, size, { x: cropCenterX, y: cropCenterY });
  const fullCenterX = full.cx;
  const fullCenterY = full.cy;
  const croppedCenterX = croppedCentre.cx;
  const croppedCenterY = croppedCentre.cy;

  const hitRect = {
    clipId: clip.id,
    frameId: clip.frameId,
    hostFrameId: options.hostFrameId ?? clip.frameId,
    cx: options.cropPreviewClipId === clip.id ? fullCenterX : croppedCenterX,
    cy: options.cropPreviewClipId === clip.id ? fullCenterY : croppedCenterY,
    width: hitExtent(options.cropPreviewClipId === clip.id ? width : croppedWidth, pose.scale, 24),
    height: hitExtent(options.cropPreviewClipId === clip.id ? height : croppedHeight, pose.scaleY, 24),
    rotation: pose.rotation,
    skewX: pose.skewX,
    skewY: pose.skewY,
  };

  pushHitRect(options, hitRect);
  if (options.skipClipId === clip.id || pose.opacity <= 0.001) return;
  // Layer opacity is applied once at the `withLayer` seam (fast path or an
  // isolation buffer) — the box painters no longer multiply it in here.
  ctx.save();
  applyLayerPose(ctx, frame, pose, size);
  ctx.translate(-width / 2, -height / 2);
  // Universal CROP + BORDER RADIUS: one rounded-rect clip in the box's own local
  // space, so every box kind (image/video/drawing/nested) crops and rounds
  // identically — and, because it's applied inside the isolated layer buffer
  // upstream, it composes with feather (the soft edge follows the rounded/cropped
  // silhouette) for free. Skipped entirely when both are off (zero cost).
  const cropped = x0 !== 0 || y0 !== 0 || x1 !== width || y1 !== height;
  const clipToCrop = () => {
    const r = gridRect(ctx, x0, y0, x1 - x0, y1 - y0);
    roundRect(ctx, r.x, r.y, r.width, r.height, pose.borderRadius);
    ctx.clip();
  };
  // THE PICTURE'S OWN PLACEMENT — core's `mapContent`, in canvas calls.
  //
  // The pivot is the BOX's centre and never the window's, which is the whole
  // reason a crop can be dragged without the footage coming with it: the window
  // is a function of the insets, so pivoting about it would couple the two
  // facts this field exists to separate. The painter is in the box's top-left
  // space here, so that centre is simply half the box.
  const content: ContentWrap = contentIsIdentity(pose.content)
    ? (draw) => draw()
    : (draw) => {
        const bcx = width / 2;
        const bcy = height / 2;
        ctx.save();
        // Pan OUTSIDE the zoom (the CSS/After Effects order), so `x`/`y` are in
        // final px and a drag moves the picture 1:1 with the pointer at any zoom.
        ctx.translate(pose.content.x, pose.content.y);
        ctx.translate(bcx, bcy);
        ctx.rotate((pose.content.rotation * Math.PI) / 180);
        ctx.scale(pose.content.scale || 1e-6, contentScaleY(pose.content) || 1e-6);
        ctx.translate(-bcx, -bcy);
        draw();
        ctx.restore();
      };
  if (options.cropPreviewClipId === clip.id) {
    // CROP MODE preview: the full media dimmed (the cropped-away region you can
    // still bring back), then the crop region crisp on top — so cropping reads as
    // "reframing a live image", Figma-style, not "deleting pixels".
    ctx.save();
    ctx.globalAlpha *= 0.28;
    paint(content);
    ctx.restore();
    ctx.save();
    clipToCrop();
    paint(content);
    ctx.restore();
    ctx.restore();
    return;
  }
  // A non-identity content transform CLIPS, with or without insets: the box is
  // a window onto its content, so zooming the picture in must not spill past
  // the rectangle you framed. A windowed nested comp clips too (see
  // `nestedClipsContent`).
  if (windowed || cropped || hasCornerRadius(pose.borderRadius) || !contentIsIdentity(pose.content)) {
    clipToCrop();
  }
  paint(content);
  ctx.restore();
}

/**
 * The clip's enabled chroma keys with keyframe-sampled values, in stack order —
 * everything the keyer engine needs, colors resolved through variables.
 */
function resolveChromaKeys(
  clip: ImageClip | VideoClip | RasterClip,
  localMs: number,
  resolve: ColorResolver,
): ChromaKeyParams[] {
  const active = clip.effects.filter(
    (e): e is Extract<typeof e, { type: "chromaKey" }> => e.enabled && e.type === "chromaKey",
  );
  if (active.length === 0) return [];
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const num = (k: string, base: number) => (typeof sampled[k] === "number" ? (sampled[k] as number) : base);
  const str = (k: string, base: string) => (typeof sampled[k] === "string" ? (sampled[k] as string) : base);
  return active.map((fx) => {
    const rgb = parseColor(resolve(str(`lfx.${fx.id}.color`, fx.color))) ?? { r: 0, g: 212, b: 99 };
    return {
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      tolerance: num(`lfx.${fx.id}.tolerance`, fx.tolerance),
      softness: num(`lfx.${fx.id}.softness`, fx.softness),
      spill: num(`lfx.${fx.id}.spill`, fx.spill),
      feather: num(`lfx.${fx.id}.feather`, fx.feather),
      choke: num(`lfx.${fx.id}.choke`, fx.choke),
      edgesOnly: fx.edgesOnly,
      invert: fx.invert,
    };
  });
}

/** Route a media drawable through the keyer when the clip carries chroma keys. */
function withChromaKeys(
  clip: ImageClip | VideoClip | RasterClip,
  src: CanvasImageSource,
  w: number,
  h: number,
  keys: ChromaKeyParams[],
): CanvasImageSource {
  if (keys.length === 0) return src;
  return chromaKeyedFrame(clip.id, sourceFrameKey(src), src, w, h, keys) ?? src;
}

/** Placeholder box while an asset is still loading (or failed). */
function drawMediaPlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = "rgba(128,128,128,0.15)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(128,128,128,0.4)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);
}

function drawImageClip(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: ImageClip,
  localMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
) {
  // ONE size answer, shared with the stage (handles, pivot, bounds, snapping).
  // These used to be derived inline per painter, which meant the PIVOT — a
  // fraction of this box — resolved from a different number here than on the
  // stage, and the layer drifted when you moved it.
  const asset = doc.assets.find((a) => a.id === clip.assetId);
  const { width: w, height: h } = clipBox(doc, clip);
  const pose = evaluateBoxPose(clip, localMs);
  const keys = resolveChromaKeys(clip, localMs, resolve);
  withBoxClip(ctx, frame, clip, pose, w, h, options, (content) => {
    const drawSelf = () => {
      // Animated formats (GIF/APNG/animated WebP) draw the frame for this
      // moment through the SAME time-remap every source-backed clip uses
      // (speed/loop/pingpong/reverse/loopLengthMs) — stills use the image path.
      // An image SEQUENCE is footage: the frame comes from the ONE mapping an
      // export also waits on (`sequenceFrameForClip`), read on demand.
      const seqIndex = sequenceFrameForClip(doc, clip, localMs);
      const animated =
        seqIndex !== null
          ? sequencePicture(clip.assetId, seqIndex, clip.id)
          : asset && isAnimatedImageMime(asset.mime, asset.name)
            ? animatedImageFrameForClip(clip, localMs)
            : null;
      if (animated) {
        ctx.drawImage(withChromaKeys(clip, animated, w, h, keys), 0, 0, w, h);
        return;
      }
      const img = getImageForAsset(clip.assetId, asset?.mime);
      if (img) ctx.drawImage(withChromaKeys(clip, img, w, h, keys), 0, 0, w, h);
      else drawMediaPlaceholder(ctx, w, h);
    };
    // Footage is the clip's `self` fill; overlays/underlays + strokes stack around it.
    paintBoxFills(ctx, clip.fills, clip.strokes, croppedBounds(pose.crop, w, h), pose.borderRadius, resolve, { clipId: clip.id, doc, localMs }, drawSelf, content);
  });
}

/** A static image clip never sets `playback` — an animated one defaults to
 * always-loop (matches the format's own natural behavior) until touched. */
const DEFAULT_ANIMATED_IMAGE_PLAYBACK: ClipPlayback = { speed: 1, loop: "loop", reverse: false, loopLengthMs: null };

/**
 * The animated-image frame for a clip-local time, through the same
 * trim/speed/loop/pingpong/reverse/loopLengthMs remap every other
 * source-backed clip kind uses (`sourceTimeAt` + `loopSpanMs`). While the
 * asset's natural duration isn't known yet (still decoding), falls back to
 * `animatedImageFrameAt` purely to kick/await the decode — same as before.
 */
function animatedImageFrameForClip(clip: ImageClip, localMs: number): ImageBitmap | null {
  const playback = clip.playback ?? DEFAULT_ANIMATED_IMAGE_PLAYBACK;
  const natural = animatedImageDurationMs(clip.assetId);
  if (natural == null) return animatedImageFrameAt(clip.assetId, localMs);
  const span = Math.max(1, natural - clip.trimInMs);
  const srcMs = clip.trimInMs + sourceTimeAt(localMs, loopSpanMs(playback, span), playback);
  return animatedImageFrameAtRaw(clip.assetId, srcMs);
}

/**
 * A raster paint layer: its live surface canvas drawn like an image — at ONE
 * PIXEL PER UNIT, always. Every draw names its source rect, so a surface that
 * ever disagrees with its box is cropped or left short, never rescaled: a
 * stretched draw is what turned a size mismatch into "my drawing shrank into a
 * corner". The store keeps the two equal (`fitSurfaceToBox`). The
 * surface store answers synchronously (blank while its bytes stream in, then
 * `onSurfaceReady` repaints), so this path never awaits — same contract as
 * every media draw. Chroma keys and the whole layer seam apply, so painted
 * layers key/blend/mask exactly like imported footage.
 */
function drawRasterClip(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  clip: RasterClip,
  localMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
) {
  const w = clip.width;
  const h = clip.height;

  // Capture (recordable drawing over time): a `capture` track turns this layer
  // into an inline flipbook of frozen snapshots. Before the first snapshot the
  // layer is blank (the drawing "appears" over time); between snapshots it holds
  // the sampled one; at/after the last it shows the LIVE surface so ongoing
  // drawing stays visible. Plain raster clips (no track) draw their live surface
  // exactly as before.
  const track = captureTrack(clip.keyframes);
  let state: ReturnType<typeof captureStateAt> = null;
  if (track) {
    if (localMs < track.keys[0]!.timeMs) return; // blank before the first snapshot
    // Each frame is its OWN snapshot surface — the layer's own surface is never
    // shown for a recorded clip, so editing one frame can't leak into another.
    state = captureStateAt(track, localMs, clip.captureCrossfade ?? false);
  }
  const snap = (id: string) => surfaceCanvas({ surfaceId: id, width: w, height: h, rev: 0 });

  const pose = evaluateBoxPose(clip, localMs);
  const keys = resolveChromaKeys(clip, localMs, resolve);
  // A drawing's pixels ARE the picture, all of them, so the whole body is
  // wrapped rather than a fill inside it.
  withBoxClip(ctx, frame, clip, pose, w, h, options, (content) => content(() => {
    if (state && state.next && state.mix > 0) {
      // Crossfade: dissolve the held snapshot out as the next fades in.
      ctx.save();
      ctx.globalAlpha = 1 - state.mix;
      ctx.drawImage(withChromaKeys(clip, snap(captureSurface(state.value)), w, h, keys), 0, 0, w, h, 0, 0, w, h);
      ctx.globalAlpha = state.mix;
      ctx.drawImage(withChromaKeys(clip, snap(captureSurface(state.next)), w, h, keys), 0, 0, w, h, 0, 0, w, h);
      ctx.restore();
    } else {
      const surface = state ? snap(captureSurface(state.value)) : surfaceCanvas(clip);
      ctx.drawImage(withChromaKeys(clip, surface, w, h, keys), 0, 0, w, h, 0, 0, w, h);
      // WET PAINT, as an explicit second layer over the pixels.
      //
      // Not merged into the surface and not merged into what `surfaceCanvas`
      // returns: the film changes every frame while the bitmap only changes
      // when paint dries, and a function that returns a canvas has to keep
      // returning THE SAME canvas or every consumer caching it is holding
      // something another caller wipes. Two layers, drawn in order, is the only
      // arrangement where both of those stay true.
      //
      // A recorded (capture) frame shows its snapshot, never the live film —
      // that surface is a different one, and its wetness is not this frame's.
      if (!state) {
        const film = wetFilmCanvas(clip);
        if (film) ctx.drawImage(film, 0, 0, w, h, 0, 0, w, h);
      }
    }
  }));
}

function drawVideoClip(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: VideoClip,
  localMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
) {
  const asset = doc.assets.find((a) => a.id === clip.assetId);
  const { width: w, height: h } = clipBox(doc, clip);
  const pose = evaluateBoxPose(clip, localMs);
  const keys = resolveChromaKeys(clip, localMs, resolve);
  withBoxClip(ctx, frame, clip, pose, w, h, options, (content) => {
    const drawSelf = () => {
      // Pure consumer: element time is owned by the media pipeline (syncVideoFrames
      // before paint / prepareVideoFramesForExport for stepped exports). The wanted
      // source time picks between the live element and a cached decoded frame.
      const src = videoFrameForClip(
        clip.id,
        clip.assetId,
        clipSourceMs(doc, clip, localMs) / 1000,
      );
      if (src) ctx.drawImage(withChromaKeys(clip, src, w, h, keys), 0, 0, w, h);
      else drawMediaPlaceholder(ctx, w, h);
    };
    // Footage is the clip's `self` fill; overlays/underlays + strokes stack around it.
    paintBoxFills(ctx, clip.fills, clip.strokes, croppedBounds(pose.crop, w, h), pose.borderRadius, resolve, { clipId: clip.id, doc, localMs }, drawSelf, content);
  });
}

/**
 * The audio-bearing source a waveform clip listens to: the target clip's asset
 * + its OWN timing (start/trim/playback). Read live each frame, so changing the
 * audio's speed, trim or loop re-shapes the waveform instantly — nothing baked.
 */
export function waveformAudioSource(
  doc: MotionDocument,
  targetClipId: string,
): { assetId: string; startMs: number; durationMs: number; trimInMs: number; playback: NestedClip["playback"] } | null {
  for (const track of doc.tracks) {
    for (const c of track.clips) {
      if (c.id !== targetClipId) continue;
      if (c.kind === "audio" && c.source.type === "asset") {
        return { assetId: c.source.assetId, startMs: c.startMs, durationMs: c.durationMs, trimInMs: c.trimInMs, playback: c.playback };
      }
      if (c.kind === "video") {
        return { assetId: c.assetId, startMs: c.startMs, durationMs: c.durationMs, trimInMs: c.trimInMs, playback: c.playback };
      }
      return null;
    }
  }
  return null;
}

/**
 * Draw a waveform-visualizer clip: the sound AUDIBLE at this document moment,
 * read through the target clip's own playback (speed/loop/trim/reverse) and
 * painted by the shared template painter. Runs identically in preview and
 * export because it *is* the one draw path. `wave.*` keyframes override style
 * numbers, so reactivity itself animates.
 */
function drawWaveformClip(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: WaveformClip,
  localMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
) {
  const kf = sampleKeyframes(clip.keyframes, localMs);
  const num = (k: string, base: number) => (typeof kf[k] === "number" ? (kf[k] as number) : base);
  const str = (k: string, base: string) => (typeof kf[k] === "string" ? (kf[k] as string) : base);
  const style: WaveformStyle = {
    ...clip.style,
    amplitude: num("wave.amplitude", clip.style.amplitude),
    glow: num("wave.glow", clip.style.glow),
    thickness: num("wave.thickness", clip.style.thickness),
    color: str("wave.color", clip.style.color),
  };
  const { width: w, height: h } = clipBox(doc, clip);
  const pose = evaluateBoxPose(clip, localMs);
  withBoxClip(ctx, frame, clip, pose, w, h, options, (content) => content(() => {
    let peaks: Float32Array | null = null;
    const src = waveformAudioSource(doc, clip.targetClipId);
    // The sound's analysis — the same data `sound()` and the Sound node read.
    // Asking queues it on a miss; the stage repaints via onSoundAnalysis.
    const analysis = src ? readSoundAnalysis(src.assetId) : null;
    if (src && analysis) peaks = visualizerBars(analysis, style, src, clip.startMs + localMs - src.startMs);
    // No target / still analysing → zero peaks: a quiet baseline, not a hole.
    paintWaveform(ctx, style, peaks ?? new Float32Array(styleBinCount(style)), w, h, resolve);
  }));
}

/** The pose of something drawn straight in comp space: the identity at the comp's centre. */
const COMP_SPACE_POSE: TransformPose = { x: 0, y: 0, scale: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0, anchor: { x: 0.5, y: 0.5 } };

/** Segments a trace strokes at most per frame: older stretches are banded, each band one stroke. */
const TRACE_BANDS = 256;

/**
 * What a trace paints, comp centre-origin: its vertices padded by its widest
 * stroke, and its ghosts by a ghost's reach (a dot's radius, or the source's
 * own extent when ghosts are copies of it).
 */
function traceExtent(doc: MotionDocument, clip: TraceClip, state: TraceState): ObjectBounds | null {
  const b = traceBounds(state);
  if (!b) return null;
  const { spec } = state;
  let pad = Math.max(spec.head.width, spec.tail.width) / 2 + 2;
  if (spec.ghosts.enabled) {
    const source = traceSourceOf(doc, clip);
    const reach = spec.ghosts.style === "source" && source && source !== clip ? Math.hypot(clipBox(doc, source).width, clipBox(doc, source).height) / 2 : spec.ghosts.size / 2;
    pad = Math.max(pad, reach + 2);
  }
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

/**
 * Draw a TRACE: the path its source has drawn up to now (core `evaluateTrace`
 * samples it; nothing is stored), cooling from head to tail by age, then its
 * strobe ghosts on top. Comp space throughout — the trace's own pose names
 * only its pen. The same path for the stage and every exporter.
 *
 * Banded, not per-vertex: a minute of orbit is thousands of segments, so the
 * line is cut into at most `TRACE_BANDS` strokes, each at the look of its
 * middle age. Round joins inside a band keep a bend smooth; bands meet butt to
 * butt so a translucent tail never beads where two strokes overlap.
 */
function drawTraceClip(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: TraceClip,
  localMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
): void {
  const state = evaluateTrace(doc, clip, clip.startMs + localMs);
  const { spec, nowMs, coolMs } = state;
  const extent = traceExtent(doc, clip, state);
  // The click target is the drawn line — or, before it has one, the pen.
  const hit = extent ?? { minX: clip.transform.x - 12, minY: clip.transform.y - 12, maxX: clip.transform.x + 12, maxY: clip.transform.y + 12 };
  pushHitRect(options, {
    clipId: clip.id,
    frameId: clip.frameId,
    hostFrameId: options.hostFrameId ?? clip.frameId,
    cx: frame.width / 2 + (hit.minX + hit.maxX) / 2,
    cy: frame.height / 2 + (hit.minY + hit.maxY) / 2,
    width: Math.max(24, hit.maxX - hit.minX),
    height: Math.max(24, hit.maxY - hit.minY),
    rotation: 0,
    skewX: 0,
    skewY: 0,
  });
  if (options.skipClipId === clip.id || !extent) return;
  const head = resolve(spec.head.color);
  const tail = resolve(spec.tail.color);
  const outer = ctx.getTransform();

  ctx.save();
  ctx.translate(frame.width / 2, frame.height / 2);
  ctx.lineJoin = "round";
  const segments = state.runs.reduce((n, r) => n + Math.max(0, r.length - 1), 0);
  const per = Math.max(1, Math.ceil(segments / TRACE_BANDS));
  const baseAlpha = ctx.globalAlpha;
  for (const run of state.runs) {
    const last = run.length - 1;
    for (let i = 0; i < last; i += per) {
      const j = Math.min(last, i + per);
      const look = traceLookAt(spec, nowMs - (run[i]!.t + run[j]!.t) / 2, coolMs);
      if (look.width <= 0 || look.opacity <= 0) continue;
      ctx.beginPath();
      ctx.moveTo(run[i]!.x, run[i]!.y);
      for (let k = i + 1; k <= j; k++) ctx.lineTo(run[k]!.x, run[k]!.y);
      ctx.lineWidth = look.width;
      ctx.lineCap = i === 0 || j === last ? spec.cap : "butt";
      ctx.strokeStyle = traceColorAt(head, tail, look.u);
      ctx.globalAlpha = baseAlpha * look.opacity;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = baseAlpha;

  const g = spec.ghosts;
  const source = traceSourceOf(doc, clip);
  // Oldest first, so the newest ghost lies on top; the one AT now is the source itself.
  const ghosts = state.ghosts.filter((v) => nowMs - v.t > 1e-6).reverse();
  const alphaOf = (t: number) => g.opacity * (g.fade ? traceLookAt(spec, nowMs - t, coolMs).opacity : 1);
  if (g.enabled && ghosts.length && (g.style === "dot" || !source || source === clip)) {
    for (const v of ghosts) {
      ctx.globalAlpha = baseAlpha * alphaOf(v.t);
      ctx.fillStyle = traceColorAt(head, tail, traceLookAt(spec, nowMs - v.t, coolMs).u);
      ctx.beginPath();
      ctx.arc(v.x, v.y, g.size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  if (g.enabled && ghosts.length && g.style === "source" && source && source !== clip) {
    // COPIES OF THE SOURCE: the comp drawn at each ghost's instant with only
    // the source in it, so a ghost is exactly what the layer looked like then
    // (turned, squashed, recoloured). Into a buffer first: a layer paints its
    // own opacity outright, so the ghost's is applied when the copy lands.
    const scratch = acquireScratch(ctx.canvas.width, ctx.canvas.height);
    // Only the source draws, so a ghost can never reach this trace again.
    const only = new Set([source.id]);
    try {
      // Equal opacities (no fade) share one buffer; a fading strobe lands one by one.
      const batches = g.fade ? ghosts.map((v) => [v]) : [ghosts];
      for (const batch of batches) {
        scratch.ctx.setTransform(1, 0, 0, 1, 0, 0);
        scratch.ctx.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height);
        scratch.ctx.setTransform(outer);
        // A 1 ms render grid: the ghost lands at its own instant, not on the comp's frame.
        for (const v of batch) drawFrameContent(scratch.ctx, doc, frame, v.t, { only, transparent: true, fpsOverride: 1000, playing: options.playing });
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = baseAlpha * alphaOf(batch[0]!.t);
        ctx.drawImage(scratch.canvas, 0, 0);
        ctx.restore();
      }
    } finally {
      scratch.busy = false;
    }
  }
}

/**
 * Draw a nested clip: the source frame's whole animated content, played through
 * the clip's `playback` (speed + loop/pingpong via sourceTimeAt) and placed at
 * the clip's transform inside the parent. Recurses into drawFrameContent with a
 * cycle guard, so timelines nest and stay in sync.
 */
function drawNestedClip(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  parentFrame: Frame,
  clip: NestedClip,
  localMs: number,
  options: DrawOptions,
  guard: Set<string>,
) {
  const source = doc.frames.find((f) => f.id === clip.sourceFrameId);
  if (!source || guard.has(source.id)) return; // missing source, or a cycle

  const pose = evaluateBoxPose(clip, localMs);
  const srcLocal = clipSourceMs(doc, clip, localMs);

  // The nested scene's rects are mapped home through `hopMatrix` — the same
  // function `resolveEditContext` composes, so an inner layer's gizmo and its
  // pixels are placed by one formula and cannot drift apart. Built only when
  // this draw is collecting rects at all.
  const outer = options._hitSpace;
  const hitSpace: HitSpace | undefined = options.hitRects
    ? (() => {
        const hp = hopPoseAtLocal(clip, localMs);
        const off = options.worldOffset ?? { x: 0, y: 0 };
        // At the top level the frame's page position IS the mapping; deeper in,
        // the chain built so far already carries it.
        const base = outer ? outer.m : matTranslate(off.x, off.y);
        return {
          m: matMultiply(base, hopMatrix(hp, parentFrame, source)),
          scaleX: (outer?.scaleX ?? 1) * hp.scaleX,
          scaleY: (outer?.scaleY ?? 1) * hp.scaleY,
          rotation: (outer?.rotation ?? 0) + hp.rotation,
          depth: (outer?.depth ?? 0) + 1,
        };
      })()
    : undefined;

  const seenAs = nestedView(doc, clip, localMs, options._view);
  // A comp MAGNIFIED on the output (a push into a ×13 000 nest) draws live: a
  // stored picture is made at the document's raster and would be drawn up —
  // the soft, smeared deep zoom that only playback showed.
  const magnified = !!seenAs && Math.max(Math.abs(seenAs.scale), Math.abs(seenAs.scaleY ?? seenAs.scale)) > 1.001;
  const pictured = !magnified && nestedUsesCompStore(doc, clip, options);
  const windowed = nestedClipsContent(clip, source);
  withBoxClip(ctx, parentFrame, clip, pose, source.width, source.height, options, (content) =>
    content(() => {
      const childGuard = new Set(guard);
      childGuard.add(source.id);
      // `skipClipId` DOES thread through: a skipped clip stays skipped at any
      // nesting depth (text-edit overlays, the parent-context preview's "don't
      // double-draw the comp being edited").
      // THE INSTANCE SCOPE, on the clip's OWN local time in this comp — inputs,
      // triggers and machines run on that clock, never the inner looped one.
      // `clip` is the baked clip, so an input driven out here (a voice) lands.
      const scoped = instanceScope(doc, clip, localMs, options._scope ?? null);
      const inner = { ...nestedOptions(options, childGuard, hitSpace, windowed), _scope: scoped, _view: seenAs };
      // A nested comp that gives off light is a light all through (see `lightPass`).
      const inside = lightPassInside(clip);
      if (inside) {
        withLightPass(inside, () => {
          if (pictured) drawCompPicture(ctx, doc, clip, source, srcLocal, inner, options.overflowPass === "outside");
          else drawFrameContent(ctx, doc, source, srcLocal, inner);
        });
      }
    }),
    windowed,
  );
}

/**
 * THE PART OF A REGION THE TARGET CAN SHOW — the target canvas's bounds mapped
 * back through `C` into frame space, grown by `pad`, cut from `whole`. Null
 * when it would not shrink the region (or `C` cannot be inverted).
 */
function seenRect(
  C: DOMMatrix,
  target: { width: number; height: number },
  pad: number,
  whole: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  if (!C.is2D || Math.abs(C.a * C.d - C.b * C.c) < 1e-18) return null;
  const inv = C.inverse();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of [[0, 0], [target.width, 0], [0, target.height], [target.width, target.height]] as const) {
    const p = inv.transformPoint({ x: px, y: py });
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const x = Math.max(whole.x, x0 - pad);
  const y = Math.max(whole.y, y0 - pad);
  const r = Math.min(whole.x + whole.width, x1 + pad);
  const b = Math.min(whole.y + whole.height, y1 + pad);
  if (!(r > x && b > y)) return { x: whole.x, y: whole.y, width: 1e-6, height: 1e-6 };
  if (r - x >= whole.width && b - y >= whole.height) return null;
  return { x, y, width: r - x, height: b - y };
}

/**
 * HOW A NESTED COMP IS SEEN — the parent's view times the nested layer's own
 * scale and its groups' (core `lengthFrameOf`, the same frame a unit on the
 * layer itself would read). One product per hop, so a comp three nests down at
 * ×12 · ×1000 · ×1.1 is seen at ×13 200 and its spx lines are drawn that thin.
 */
function nestedView(doc: MotionDocument, clip: NestedClip, localMs: number, parent: LengthView | undefined): LengthView | undefined {
  if (!parent) return undefined;
  const { screen } = lengthFrameOf(doc, clip, clip.startMs + localMs, parent);
  return { scale: screen.x, scaleY: screen.y, width: parent.width, height: parent.height };
}

/**
 * IS THIS COMP SEEN THROUGH ITS LAYER AS A WINDOW — clipped to its own box?
 * `nestedClipsContent` (core) answers it for every path: the layer's own
 * "Clip content" switch, else the comp — a transparent part spills, a comp
 * with a visible box windows, `overflow` 0/1 force it.
 *
 * The window is also what keeps a scaled comp from seaming: its paper and the
 * layers laid over it all end at one grid-snapped edge (`gridRect`).
 */

/**
 * MAY THIS NESTED CLIP SHOW ITS COMP'S STORED PICTURE?
 *
 * A comp's finished picture at an instant is ONE picture — the same whether it
 * is the root being played, seen through a nested clip from its parent, or the
 * comp you drilled into — so it is kept once, in the comp-picture store
 * (`frame-store.ts`), and every depth reads the same entries. Only where a
 * stored picture would be WRONG does a nested clip draw live:
 *
 *  - a comp whose layers blend THROUGH it into the parent (a stored picture is
 *    the comp alone, blended over nothing);
 *  - a COMPONENT instance: overrides make each instance a different picture of
 *    the same source, so there is no one picture to keep;
 *  - a pass that is not the picture: a layer-scoped slice, a shutter sample,
 *    an export;
 *  - paused, a comp holding the selection (you are working inside it);
 *  - a text edit or crop preview, which changes how the comp draws;
 *  - live footage inside, while footage plays live (see `playbackRegime`).
 */
function nestedUsesCompStore(doc: MotionDocument, clip: VisualClip, options: DrawOptions): boolean {
  if (clip.kind !== "nested" || options.exporting) return false;
  // An UNCLIPPED pass (drilled in, with the target's overflow fully shown) still
  // gets the picture while the transport runs: playback shows the comp as it
  // exports — inside its box — and the overflow context returns when you stop.
  // THE SPILL TOO: a windowed comp (required below) draws its own box whichever
  // side of the parent's this pass paints — its inner draw carries no overflow
  // side (`nestedOptions`) — so its picture is the same one. Refused, a wall of
  // scenes flying in from outside the cover re-rendered all nine live, every
  // frame, in the pass nobody keeps.
  if (options.only || options._onComposite || options._inContentShutter || lightPass !== "all") return false;
  if (options.skipClipId || options.cropPreviewClipId) return false;
  const source = doc.frames.find((f) => f.id === clip.sourceFrameId);
  if (!source) return false;
  // A stored picture is the comp's BOX. A comp that spills past it would lose
  // everything outside the box for as long as the transport runs (a logo's
  // shockwave cut square during playback, whole when paused or exported).
  if (!nestedClipsContent(clip, source)) return false;
  if (layerBlendsThrough(doc, clip)) return false;
  if (options.footageLive && layerShowsFootage(doc, clip)) return false;
  // A comp sized in SCREEN units is a different picture at every scale it is
  // seen at; the store keys pictures by instant and size, not by view.
  const raw = bakeSourceOf(doc);
  for (const f of compPictureDeps(doc, source.id).frames) if (compHasScreenUnits(raw, f)) return false;
  // PAUSED TOO. A picture is made at the size it is seen and a smaller one is a
  // miss (`readFrame`), so a paused frame shows the same pixels a live draw
  // would. Drawn live instead, a cover of nine looks re-ran nine material
  // pipelines on every pan tick of the comp you were in (150 ms a tick) for
  // pixels that had not changed. Live only while you are working INSIDE it:
  // a comp holding the selection, whose layers you are dragging.
  // (A selected layer also draws at its END instant while paused — `clipEnds` —
  // which no stored picture knows about.) Anywhere inside, at any depth.
  if (!options.playing && options.clipEnds?.size) {
    const inside = compPictureDeps(doc, source.id).clipIds;
    for (const id of options.clipEnds) if (inside.has(id)) return false;
  }
  return true;
}

/**
 * Show a comp's picture at an instant from the store — or make it, keep it if
 * every picture in it was exact, and show that. Its click targets travel with
 * it in the comp's own space; its contributors are handed to whatever frame is
 * blitting it, so an edit inside reaches every picture that shows this one.
 */
function drawCompPicture(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  clip: VisualClip,
  source: Frame,
  srcLocal: number,
  options: DrawOptions,
  /**
   * Seen in the parent's dimmed SPILL — context nothing keeps. It shows what
   * the store has (any size, else the nearest instant) and makes a picture only
   * when there is none at all: the spill is seen at the display's size and the
   * box pass at the comp buffer's, and making both was every picture twice.
   */
  inSpill = false,
): void {
  // The picture's key is the instant the comp SHOWS — its still, for a static one.
  const t = frameEvalTimeMs(doc, source, srcLocal);
  // AT THE SIZE IT IS SEEN. A comp's picture is made at the resolution this
  // nested clip actually puts on screen — rounded UP to a power-of-two step of
  // the raster scale, so it is never upscaled and a camera move does not mint a
  // new size every frame — never at the comp's full size. A 1400×4400 plane
  // drawn at a fifth of its size is a 280×880 picture (1 MB), not 24 MB per
  // frame per plane; the cache holds twenty-five times the frames and every
  // one of them costs a twenty-fifth to make.
  const scale = pictureScaleFor(ctx);
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  // WHICH PICTURE OF THE COMP: an instance's inputs make it a different one,
  // so the scope's key is part of the store's key — equal inputs share.
  const scopeKey = options._scope ? scopeCacheKey(doc, source.id, options._scope) : "";
  // A picture made smaller than this draw needs (the stage zoomed in since) is
  // not this picture: make the sharper one, which replaces it.
  const kept = readFrame(source.id, t, inSpill ? 0 : w, scopeKey);
  const fill = options.pictureFill;
  const fillKey = scopeKey ? `${source.id}\u0001${scopeKey}` : source.id;
  // LIVE PLAYBACK MAKES A BUDGET'S WORTH OF MISSING PICTURES A FRAME, in turns
  // (core `createPictureFill`). A miss that must wait shows the comp's nearest
  // kept picture — transient, so nothing keeps the frame it lands in — and is
  // made on a later turn. With nothing kept nearby there is nothing to wait
  // with: it is made now.
  const standIn = !kept && (inSpill || (fill && !fill.mayMake(fillKey))) ? nearestKeptPicture(doc, source, srcLocal, scopeKey) : null;
  if (standIn) markTransientPicture();
  const shown = kept ?? standIn;
  if (shown) {
    for (const r of shown.hits) pushHitRect(options, r);
    replayPicture(true, layerShowsFootage(doc, clip));
    const prof = options.profiler;
    if (prof) {
      for (const id of shown.contributors.clipIds) prof.layer(id, "", 0, { source: "cached", scale: rasterScale });
      for (const id of shown.contributors.frameIds) prof.comp(id);
    }
    ctx.drawImage(shown.canvas, 0, 0, source.width, source.height);
    return;
  }
  const t0 = performance.now();
  const scratch = acquireScratch(w, h);
  // The comp spans the buffer EXACTLY: `w` is rounded, so scaling by `scale`
  // left the paper ending partway into the last row and column — the seam
  // `gridRect` prevents, baked into the picture.
  scratch.ctx.setTransform(w / source.width, 0, 0, h / source.height, 0, 0);
  const ledger = createFrameLedger();
  ledger.begin();
  const capture = beginHitCapture(options._hitSpace);
  const before = pictureFaults();
  // THE COMP IS THE UNIT: nothing inside it is kept a second time — the
  // picture holds every layer's pixels already (the same rule a kept group has).
  const closeUnit = enterKeptUnit();
  try {
    // Inside a picture being made, every miss is made: a stand-in there would
    // make this picture transient, and the render was paid for nothing.
    drawFrameContent(scratch.ctx, doc, source, srcLocal, { ...options, pictureFill: null, profiler: teeProfiler(options.profiler, ledger) });
  } finally {
    closeUnit();
    endHitCapture(capture);
  }
  fill?.made(fillKey, performance.now() - t0);
  if (isCachingEnabled() && faithfulSince(before)) {
    const steady = compSteadyKey(doc, source.id, t, ledger.clipIds);
    // The resolution is part of a SHARED picture's identity: a steady stretch
    // seen small must not lend its small picture to an instant seen large.
    storeFrame(source.id, t, scratch.canvas, capture.rects, ledger, frameStepMs(compFps(doc, source.id)), withPictureSize(steady, w), scopeKey);
  }
  ctx.drawImage(scratch.canvas, 0, 0, source.width, source.height);
  scratch.busy = false;
}

/** How far either side of its instant a comp's stand-in may come from, in its own frames. */
const STAND_IN_FRAMES = 15;

/**
 * The kept picture of this comp NEAREST the instant it should show — earlier
 * first at equal distance, at any size (a stand-in is soft for a moment, never
 * a hole). Asked through the render clock, so every probe lands on a key the
 * store can hold.
 */
function nearestKeptPicture(doc: MotionDocument, source: Frame, srcLocal: number, scopeKey: string): CachedFrame | null {
  const step = frameStepMs(compFps(doc, source.id));
  for (let k = 1; k <= STAND_IN_FRAMES; k++) {
    for (const at of [srcLocal - k * step, srcLocal + k * step]) {
      if (at < 0) continue;
      const near = readFrame(source.id, frameEvalTimeMs(doc, source, at), 0, scopeKey);
      if (near) return near;
    }
  }
  return null;
}

/**
 * The device-pixel scale a comp-space draw lands at on `ctx`, as a picture
 * resolution: the larger axis of the current transform, rounded UP to a
 * power-of-two step and capped at the raster scale (the most the old
 * full-size picture ever had). Floored so a speck still has pixels.
 */
function pictureScaleFor(ctx: CanvasRenderingContext2D): number {
  const m = ctx.getTransform();
  return seenScale(Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d)));
}

/**
 * THE RESOLUTION PIXELS ARE MADE AT, given the device px one comp unit is SEEN
 * at: that, rounded UP to a power-of-two step of the raster scale (never drawn
 * up; a camera move or a zoom does not mint a new size every frame), capped at
 * the raster scale and floored so a speck still has pixels.
 *
 * Capped, because past the document a pixel stack is a magnifying glass over
 * the frame that exports (`drawClip`). Not pinned AT it: a comp seen at a
 * third — a cover tile, a board picture, a thumbnail — made its grain,
 * halftone and materials at full size and threw eight of every nine pixels
 * away (a 3×3 wall of looks cost 300–400 ms a tile). Everything that
 * rasterises a stack asks here, so a tile, a picture and a layer agree.
 */
function seenScale(drawn: number): number {
  if (!(drawn > 0) || !Number.isFinite(drawn)) return rasterScale;
  const stepped = 2 ** Math.ceil(Math.log2(drawn / rasterScale) - 1e-9) * rasterScale;
  return Math.min(outputCap(drawn), Math.max(rasterScale / 32, stepped));
}

/**
 * THE MOST a pixel stack may be made at: the raster scale, times whatever the
 * DOCUMENT magnifies this layer by.
 *
 * The cap exists so the stage zoom is a magnifying glass over the exported
 * frame, never a different picture. It used to be the raster scale per LAYER
 * px, which also capped what the document itself magnifies: a surface, grain
 * or chalk card inside a camera group at ×4.2 (or a nest at ×4) was made at
 * one buffer px per layer px and drawn up 4.2× — blocky in the export as
 * much as on the stage. The stage zoom is divided out (`rootDeviceScale`), so
 * what remains is the group/nest magnification, and the look is made at the
 * OUTPUT's resolution wherever it sits. Stepped in quarter octaves, so a
 * camera zooming does not mint a new buffer size every frame, nor pay a whole
 * octave of over-render.
 */
function outputCap(drawn: number): number {
  const magnified = drawn / rootDeviceScale;
  if (!(magnified > 1) || !Number.isFinite(magnified)) return rasterScale;
  return rasterScale * 2 ** (Math.ceil(4 * Math.log2(magnified) - 1e-9) / 4);
}

// ── Vector clips ─────────────────────────────────────────────────────────────

/**
 * Compile core path commands into a Path2D — RETAINED for frozen commands (the
 * document's own outlines; see core `pathCommands`). Building a Path2D re-traces
 * every segment, and the canvas never mutates one it is handed (`addPath` only
 * copies FROM a path), so a frozen outline is traced once per identity instead
 * of once per draw — the whole cost of a heavy board that pans while nothing
 * changes. Working copies (drafts, morph frames) are not frozen and rebuild.
 */
const path2dMemo = new WeakMap<readonly PathCommand[], Path2D>();
export function commandsToPath2D(cmds: PathCommand[]): Path2D {
  if (!Object.isFrozen(cmds)) return buildPath2D(cmds);
  let p = path2dMemo.get(cmds);
  if (!p) {
    p = buildPath2D(cmds);
    path2dMemo.set(cmds, p);
  }
  return p;
}

function buildPath2D(cmds: readonly PathCommand[]): Path2D {
  const p = new Path2D();
  for (const c of cmds) {
    if (c.type === "M") p.moveTo(c.x, c.y);
    else if (c.type === "L") p.lineTo(c.x, c.y);
    else if (c.type === "C") p.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
    else p.closePath();
  }
  return p;
}

/** The box a paint spans, in the local (pre-transform) drawing space. */
/** Context a media fill needs to resolve its footage FROM THE FILL: the host
 *  clip id (keys the video element pool), the document (asset lookup) and the
 *  clip-local time. Threaded to every place that paints a media fill. */
interface MediaDrawCtx {
  clipId: string;
  doc: MotionDocument;
  localMs: number;
}

/**
 * Draw ONE asset-sourced media fill (image OR video) into `bounds`, framed by its
 * `fit`. The drawable is resolved entirely from the fill's `source.assetId` — a
 * still through the image decode cache, a video through the synced element pool
 * keyed per (clip, fill) so `collectVideoTargets` conducts it. Nothing is read
 * from the host clip's own footage here (that's the `self` fill's job). The
 * caller has already clipped to the box/path, so overflow (cover) is trimmed.
 */
function drawMediaFill(ctx: CanvasRenderingContext2D, paint: MediaPaint, bounds: PaintBounds, media: MediaDrawCtx): void {
  if (paint.source.type !== "asset" || !paint.source.assetId) return;
  const assetId = paint.source.assetId;
  const asset = media.doc.assets.find((a) => a.id === assetId);
  let src: CanvasImageSource | null = null;
  let iw = bounds.w;
  let ih = bounds.h;
  if (asset?.kind === "video") {
    const dur = asset.durationMs ?? 0;
    const srcSec = (dur > 0 ? ((media.localMs % dur) + dur) % dur : Math.max(0, media.localMs)) / 1000;
    src = videoFrameForClip(`${media.clipId}::fill::${paint.id}`, assetId, srcSec);
    iw = asset.width ?? bounds.w;
    ih = asset.height ?? bounds.h;
  } else {
    const img = getImageForAsset(assetId, asset?.mime);
    if (img && img.width && img.height) {
      src = img;
      iw = img.width;
      ih = img.height;
    }
  }
  if (!src) return;
  drawFittedMedia(ctx, src, iw, ih, bounds, paint);
}

/** Blit a drawable into `bounds` under a fill's `fit`/`focus`/`tileScale`. */
function drawFittedMedia(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  iw: number,
  ih: number,
  bounds: PaintBounds,
  paint: MediaPaint,
): void {
  if (paint.fit === "tile") {
    const cp = ctx.createPattern(src, "repeat");
    if (!cp) return;
    try {
      cp.setTransform(new DOMMatrix().translateSelf(bounds.x, bounds.y).scaleSelf(paint.tileScale, paint.tileScale));
    } catch {
      /* DOMMatrix unavailable — untransformed tile. */
    }
    ctx.fillStyle = cp;
    ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    return;
  }
  let dw: number;
  let dh: number;
  if (paint.fit === "fill") {
    dw = bounds.w;
    dh = bounds.h;
  } else {
    const s = paint.fit === "contain" ? Math.min(bounds.w / iw, bounds.h / ih) : Math.max(bounds.w / iw, bounds.h / ih);
    dw = iw * s;
    dh = ih * s;
  }
  // Focal point positions the fitted media: cover overflow slides, contain margin centers.
  const dx = bounds.x + (bounds.w - dw) * paint.focus.x;
  const dy = bounds.y + (bounds.h - dh) * paint.focus.y;
  ctx.drawImage(src, dx, dy, dw, dh);
}

/** The visible (cropped) box in the clip's local space — core's `cropWindow`,
 *  in the top-left convention the box painters draw in. Solid/gradient/pattern/
 *  asset-media fills and the box stroke all read THIS so they hug the cropped
 *  rect (crop-safe); `self` footage still draws full-size and is trimmed by
 *  withBoxClip's clip. */
function croppedBounds(crop: BoxPose["crop"], w: number, h: number): PaintBounds {
  const win = cropWindow(crop, { width: w, height: h, cx: 0, cy: 0 });
  return { x: win.cx + w / 2 - win.width / 2, y: win.cy + h / 2 - win.height / 2, w: win.width, h: win.height };
}

/**
 * Paint a media clip's ORDERED fill list, then its strokes, into the current box
 * (already posed and clipped to crop+radius by withBoxClip). Footage is read ONLY
 * from the fills: a `self` media fill draws the clip's own footage (drawSelf,
 * reusing the proven per-kind media/chroma path), an `asset` media fill draws its
 * chosen image/video (drawMediaFill), and solid/gradient/pattern fills paint flat.
 * No fallback — remove the media fill and the footage is gone (Figma). Strokes
 * hug the box last.
 */
function paintBoxFills(
  ctx: CanvasRenderingContext2D,
  fills: Paint[],
  strokes: StrokeStyle[],
  bounds: PaintBounds,
  radius: CornerRadius,
  resolve: ColorResolver,
  media: MediaDrawCtx,
  drawSelf: () => void,
  /**
   * The layer's content transform (v68). It wraps the MEDIA fills and nothing
   * else: a photo panned inside its crop must not take the solid backing behind
   * it, or the border that hugs the cropped rect, along for the ride.
   */
  content: ContentWrap,
): void {
  for (const fill of fills) {
    if (!fill.enabled || fill.opacity <= 0.001) continue;
    ctx.save();
    ctx.globalAlpha *= fill.opacity;
    ctx.globalCompositeOperation = COMPOSITE[fill.blendMode];
    if (fill.type === "media") {
      if (fill.source.type === "self") content(drawSelf);
      else content(() => drawMediaFill(ctx, fill, bounds, media));
    } else {
      ctx.fillStyle = paintStyle(ctx, fill, bounds, resolve);
      ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    }
    ctx.restore();
  }
  // Strokes hug the box's rounded rect. We're inside withBoxClip's crop+radius
  // clip, so the stroke reads as INSIDE-aligned (its width is doubled and the
  // clip keeps the inner half) — the clean Figma default for a box border.
  //
  // The border is compiled to real COMMANDS rather than drawn straight onto the
  // context, so a photo's border gets the whole stroke pipeline — trim, dash
  // offset, taper, arrowheads — for free, from the same brain a shape uses.
  if (strokes.length > 0) paintStrokes(ctx, boxOutlineCommands(bounds, radius), strokes, resolve, bounds, null);
}

/** A square-cornered box — the frame border's radius (frames aren't rounded). */
const ZERO_RADIUS: CornerRadius = { tl: 0, tr: 0, br: 0, bl: 0 };

/** A box's rounded-rect border as path commands, in the box's own space. */
function boxOutlineCommands(bounds: PaintBounds, radius: CornerRadius): PathCommand[] {
  const cmds = shapeCommands({
    shape: "rect",
    width: Math.max(0.01, bounds.w),
    height: Math.max(0.01, bounds.h),
    cornerRadius: radius,
    radius: 0,
    pointCount: 4,
    innerRatio: 0.5,
  });
  // `shapeCommands` builds about the origin; the box sits at its own bounds.
  const dx = bounds.x + bounds.w / 2;
  const dy = bounds.y + bounds.h / 2;
  return cmds.map((c) =>
    c.type === "Z"
      ? c
      : c.type === "C"
        ? { ...c, x1: c.x1 + dx, y1: c.y1 + dy, x2: c.x2 + dx, y2: c.y2 + dy, x: c.x + dx, y: c.y + dy }
        : { ...c, x: c.x + dx, y: c.y + dy },
  );
}

/**
 * Paint a stroke LIST over one outline — the single place strokes become pixels,
 * shared by vector layers and box borders alike.
 *
 * Geometry comes from core's `buildStrokePlan`, so trim, wave, dash, taper and
 * endpoint markers are resolved by the same brain the SVG exporter uses. Two
 * shapes come back and each has its own cheapest draw:
 *
 *   `plan.path`    a centre line → native `ctx.stroke()` with the dash pattern.
 *   `plan.ribbon`  a variable-width outline → `ctx.fill()`.
 *
 * `clipTo` supplies the region alignment is measured against (a vector's own
 * outline). Box borders pass null: they are already inside a rounded-rect clip,
 * which is what makes them read as inside-aligned, so they double their width
 * and let the caller's clip keep the inner half.
 */
function paintStrokes(
  ctx: CanvasRenderingContext2D,
  cmds: PathCommand[],
  strokes: StrokeStyle[],
  resolve: ColorResolver,
  bounds: PaintBounds,
  clipTo: { path: Path2D; rule: "nonzero" | "evenodd" } | null,
  /** A draw-on's per-subpath windows — see `buildStrokePlan`. */
  reveal?: ReadonlyArray<readonly [number, number, number?]>,
): void {
  for (const stroke of strokes) {
    const plan = buildStrokePlan(cmds, stroke, reveal);
    if (!plan.path && !plan.ribbon && plan.markers.length === 0) continue;
    ctx.save();
    ctx.globalAlpha *= stroke.opacity;
    ctx.globalCompositeOperation = COMPOSITE[stroke.blendMode];
    const style = paintStyle(ctx, stroke.paint, bounds, resolve);

    // A ribbon and the markers are real outlines — they FILL. Alignment does not
    // apply to them: they already carry their own edges.
    if (plan.ribbon) {
      ctx.fillStyle = style;
      ctx.fill(commandsToPath2D(plan.ribbon), "nonzero");
    } else if (plan.path) {
      ctx.strokeStyle = style;
      ctx.lineCap = stroke.cap;
      ctx.lineJoin = stroke.join;
      ctx.setLineDash(plan.dash);
      // Canvas walks its dash pattern the opposite way from the offset every
      // host (and SVG) means by it, so a rising offset marches forward.
      ctx.lineDashOffset = -plan.dashOffset;
      const outline = commandsToPath2D(plan.path);
      const align = clipTo ? stroke.align : "boxInside";
      if (align === "center") {
        ctx.lineWidth = stroke.width;
        ctx.stroke(outline);
      } else {
        ctx.save();
        // Alignment clips against the FULL region even when the outline is
        // trimmed — an inside stroke of a half-drawn path is still inside.
        if (clipTo) {
          if (align === "inside") {
            ctx.clip(clipTo.path, clipTo.rule);
          } else {
            const inverse = new Path2D();
            inverse.rect(-1e5, -1e5, 2e5, 2e5);
            inverse.addPath(clipTo.path);
            ctx.clip(inverse, "evenodd");
          }
        }
        ctx.lineWidth = stroke.width * 2;
        ctx.stroke(outline);
        ctx.restore();
      }
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
    if (plan.markers.length > 0) {
      ctx.fillStyle = style;
      ctx.fill(commandsToPath2D(plan.markers), "nonzero");
    }
    ctx.restore();
  }
}

/**
 * Fill + stroke a vector path with Figma's ORDERED paint lists: every fill then
 * every stroke paints bottom→top, each under its own opacity + blend mode.
 * Strokes go through the shared `paintStrokes` pipeline.
 */
function paintVector(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  fills: Paint[],
  strokes: StrokeStyle[],
  fillRule: "nonzero" | "evenodd",
  resolve: ColorResolver,
  bounds: PaintBounds,
  /** Media-fill context (image/video fills on a shape/path); omit = no media. */
  media: MediaDrawCtx | null = null,
  /** The outline the strokes run along (trim/dash/taper are resolved from it). */
  strokeCmds: PathCommand[] = [],
  /**
   * The draw-on in force, if any: it fades the fills, windows every stroke,
   * and — for a layer with no stroke of its own — inks the fill's silhouette
   * so a filled icon still draws itself on.
   */
  reveal: ClipReveal | null = null,
): void {
  const fillAlpha = reveal?.fillAlpha ?? 1;
  if (fillAlpha > 0.001) {
    for (const fill of fills) {
      if (!fill.enabled || fill.opacity <= 0.001) continue;
      ctx.save();
      ctx.globalAlpha *= fill.opacity * fillAlpha;
      ctx.globalCompositeOperation = COMPOSITE[fill.blendMode];
      if (fill.type === "media" && media) {
        // A media fill clips to the vector outline, then blits its image/video —
        // Figma's "image fill" on a shape (footage read from the fill, not a clip).
        ctx.clip(path, fillRule);
        if (fill.source.type === "asset") drawMediaFill(ctx, fill, bounds, media);
      } else {
        ctx.fillStyle = paintStyle(ctx, fill, bounds, resolve);
        ctx.fill(path, fillRule);
      }
      ctx.restore();
    }
  }
  const inked = reveal?.synthesiseOutline ? syntheticOutline(fills, reveal.reveal.pen) : null;
  paintStrokes(ctx, strokeCmds, inked ? [inked, ...strokes] : strokes, resolve, bounds, { path, rule: fillRule }, reveal?.windows);
}

/**
 * The pen a draw-on borrows when the layer has no stroke: the first visible
 * fill's paint, round-capped, at the reveal's width. Null when there is no
 * fill either — nothing to draw with.
 */
function syntheticOutline(fills: Paint[], pen: number): StrokeStyle | null {
  const fill = fills.find((f) => f.enabled && f.opacity > 0.001 && f.type !== "media");
  return fill ? strokeStyle(fill, { width: pen, cap: "round", join: "round", opacity: fill.opacity }) : null;
}

/** One fill entry with its per-id keyframes (color / stops / geometry / opacity) applied. */
function effectiveFill(fill: Paint, sampled: Record<string, KeyframeValue>): Paint {
  const p = paintWithSampled(fill, `fill.${fill.id}`, sampled);
  const op = sampled[`fill.${fill.id}.opacity`];
  return typeof op === "number" && op !== p.opacity ? { ...p, opacity: op } : p;
}

/**
 * One stroke entry resolved at this instant: keyframes, then MODULATORS on top,
 * then the inner paint's own sampled values.
 *
 * The modulator half is why a stroke can shake. Modulators were already a
 * headless, path-addressed brain (`applyModulators` takes any property path);
 * they simply had one consumer — the effect-field resolver — so nothing outside
 * an effect ever asked. Routing strokes through `resolveStrokeAt` is the whole
 * change, and it means `stroke.<id>.dashOffset` or `wave.phase` can carry a
 * wiggle with nothing stroke-specific written on either side.
 */
function effectiveStroke(
  stroke: StrokeStyle,
  sampled: Record<string, KeyframeValue>,
  modulators?: readonly Modulator[],
  localMs = 0,
): StrokeStyle {
  const s = resolveStrokeAt(stroke, { sampled, modulators, timeSec: localMs / 1000 });
  return { ...s, paint: paintWithSampled(s.paint, `stroke.${s.id}`, sampled) };
}

/** Sampled keyframe values with typed fallbacks. */
function samplers(sampled: Record<string, KeyframeValue>) {
  return {
    n: (key: string, fallback: number) =>
      typeof sampled[key] === "number" ? (sampled[key] as number) : fallback,
    s: (key: string, fallback: string) =>
      typeof sampled[key] === "string" ? (sampled[key] as string) : fallback,
  };
}

function drawShapeClip(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: ShapeClip,
  localMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  compTimeMs: number,
) {
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const { n } = samplers(sampled);
  const scaleX = n("scale", clip.transform.scale);
  // A vector has no picture separate from its box — its geometry IS its
  // content, and you move it by editing the nodes. So the content transform is
  // identity here rather than plumbed: the field is universal, the GESTURE for
  // it belongs to the kinds with footage inside a window.
  const pose: BoxPose = {
    x: n("x", clip.transform.x),
    y: n("y", clip.transform.y),
    scale: scaleX,
    scaleY: sampledScaleY(sampled, clip.transform.scaleY) ?? scaleX,
    rotation: n("rotation", clip.transform.rotation),
    skewX: n("skewX", clip.transform.skewX),
    skewY: n("skewY", clip.transform.skewY),
    anchor: { x: n("anchor.x", clip.transform.anchor.x), y: n("anchor.y", clip.transform.anchor.y) },
    opacity: n("opacity", clip.opacity),
    // Shapes carry their own per-vertex `cornerRadius` + geometry, so the
    // box-level border radius doesn't apply. The crop window does — every
    // visual layer offers it (a keyed crop is how a wipe reveals a shape).
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: sampleCrop(clip, sampled),
    content: { ...NO_CONTENT },
  };
  // ONE animated-geometry seam, shared with the on-stage edit handles (Stage.tsx)
  // so drawn shape and its corner/radius/arc dots can never disagree at a keyframe.
  const geo = resolveShapeGeometry(clip, sampled);
  // Hit/selection box hugs the shape's ACTUAL bounds (frame grown to include any
  // dragged-out corner) so the transform box reacts to corner edits. Local bbox
  // center maps to world through the pose (rotation/scale).
  const b = shapeLocalBounds(geo);
  // The box center rides through scale → shear → rotate (T·R·K·S) about the
  // PIVOT, so the hit rect lands on the same center the corner math expands from.
  const shapeSize = { width: geo.width, height: geo.height, cx: 0, cy: 0 };
  const shapeCentre = layerCenter(frame, pose, shapeSize, {
    x: (b.minX + b.maxX) / 2,
    y: (b.minY + b.maxY) / 2,
  });
  pushHitRect(options, {
    clipId: clip.id,
    frameId: clip.frameId,
    hostFrameId: options.hostFrameId ?? clip.frameId,
    cx: shapeCentre.cx,
    cy: shapeCentre.cy,
    width: hitExtent(b.maxX - b.minX, pose.scale, 8),
    height: hitExtent(b.maxY - b.minY, pose.scaleY, 8),
    rotation: pose.rotation,
    skewX: pose.skewX,
    skewY: pose.skewY,
  });
  if (options.skipClipId === clip.id || pose.opacity <= 0.001) return;

  const cmds = shapeCommands(geo);
  const path = commandsToPath2D(cmds);
  const fills = clip.fills.map((f) => effectiveFill(f, sampled));
  const strokes = clip.strokes.map((s) => effectiveStroke(s, sampled, clip.modulators, localMs));

  ctx.save();
  applyLayerPose(ctx, frame, pose, shapeSize);
  clipToCrop(ctx, pose.crop, shapeSize);
  paintVector(
    ctx,
    path,
    fills,
    strokes,
    "nonzero",
    resolve,
    { x: -geo.width / 2, y: -geo.height / 2, w: geo.width, h: geo.height },
    { clipId: clip.id, doc, localMs },
    cmds,
    clipRevealAt(doc, clip, localMs, compTimeMs),
  );
  ctx.restore();
}

function drawPathClip(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: PathClip,
  localMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
  compTimeMs: number,
) {
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const { n } = samplers(sampled);
  const scaleXp = n("scale", clip.transform.scale);
  // Identity content — see `drawShapeClip` above.
  const pose: BoxPose = {
    x: n("x", clip.transform.x),
    y: n("y", clip.transform.y),
    scale: scaleXp,
    scaleY: sampledScaleY(sampled, clip.transform.scaleY) ?? scaleXp,
    rotation: n("rotation", clip.transform.rotation),
    skewX: n("skewX", clip.transform.skewX),
    skewY: n("skewY", clip.transform.skewY),
    anchor: { x: n("anchor.x", clip.transform.anchor.x), y: n("anchor.y", clip.transform.anchor.y) },
    opacity: n("opacity", clip.opacity),
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: sampleCrop(clip, sampled),
    content: { ...NO_CONTENT },
  };
  // What this layer's outline IS right now — a recorded capture frame, a
  // geometry morph, or the declared subpaths. `null` = nothing drawn yet (a
  // vector drawing appearing over time, before its first frame).
  const geometry = pathGeometryAt(clip, sampled);
  if (!geometry) return;
  // Bounds may sit off the anchor (points are free); the hit rect follows them.
  const b = subpathBounds(geometry);
  const bw = b ? b.maxX - b.minX : 8;
  const bh = b ? b.maxY - b.minY : 8;
  const bcx = b ? (b.minX + b.maxX) / 2 : 0;
  const bcy = b ? (b.minY + b.maxY) / 2 : 0;
  const rad = (pose.rotation * Math.PI) / 180;
  // A path's box IS its outline extent, and its centre needn't sit on the origin.
  //
  // The PIVOT resolves against the box the clip DECLARES (`clip.subpaths`), not
  // against whatever frame of a geometry morph is on screen: the pivot belongs to
  // the layer, not to its content, so a morph must not slide the layer around as
  // the outline breathes. Every other surface (the inspector, the node overlay,
  // the pivot crosshair) reads that same declared box via `clipBox`; sampling it
  // here was the renderer quietly disagreeing with all of them.
  const poseBox = clipBox(doc, clip);
  // The HIT rect is the opposite question — "where is the art right now" — so it
  // follows the sampled outline.
  const pathCentre = layerCenter(frame, pose, poseBox, { x: bcx, y: bcy });
  pushHitRect(options, {
    clipId: clip.id,
    frameId: clip.frameId,
    hostFrameId: options.hostFrameId ?? clip.frameId,
    cx: pathCentre.cx,
    cy: pathCentre.cy,
    width: hitExtent(bw, pose.scale, 8),
    height: hitExtent(bh, pose.scaleY, 8),
    rotation: pose.rotation,
    skewX: pose.skewX,
    skewY: pose.skewY,
  });
  if (options.skipClipId === clip.id || pose.opacity <= 0.001) return;

  // Paint bounds are the WHOLE layer's, for every run below: a gradient belongs
  // to the artwork, not to whichever piece happens to be painting, so
  // overriding one petal's colour must not re-space the gradient under it.
  const bounds = { x: b ? b.minX : -4, y: b ? b.minY : -4, w: Math.max(1, bw), h: Math.max(1, bh) };
  const media = { clipId: clip.id, doc, localMs };

  ctx.save();
  applyLayerPose(ctx, frame, pose, poseBox);
  clipToCrop(ctx, pose.crop, poseBox);
  // The draw-on in force — the layer's own, or an enclosing group's read
  // through. Null for almost every layer on almost every frame.
  const reveal = clipRevealAt(doc, clip, localMs, compTimeMs);

  if (!hasContourOverrides(clip)) {
    // THE FAST PATH, and the one almost every layer takes: no contour overrides
    // anything, so the whole outline is one path painted once — byte for byte
    // what this did before per-contour styling existed.
    const cmds = pathCommands(geometry);
    const fills = clip.fills.map((f) => effectiveFill(f, sampled));
    const strokes = clip.strokes.map((st) => effectiveStroke(st, sampled, clip.modulators, localMs));
    paintVector(ctx, commandsToPath2D(cmds), fills, strokes, clip.fillRule, resolve, bounds, media, cmds, reveal);
    ctx.restore();
    return;
  }

  // Some contour differs. Paint in RUNS of consecutive contours that share an
  // overlay — consecutive, not grouped, because `subpaths` order IS paint order
  // and gathering all the inheritors together would lift them above a piece
  // that was drawn over them. A compound path stays intact for free: a hole
  // inherits, so it lands in the same run as the outline it belongs to and the
  // fill rule still sees both. (Overriding a HOLE's own colour is meaningless —
  // a hole has no colour — and nothing offers it.)
  for (let start = 0; start < geometry.length; ) {
    const key = contourOverlay(clip, geometry[start]!.id);
    let end = start + 1;
    while (end < geometry.length && contourOverlay(clip, geometry[end]!.id) === key) end++;
    const style = resolveContourStyle(clip, geometry[start]!.id);
    const runCmds = pathCommands(geometry.slice(start, end));
    paintVector(
      ctx,
      commandsToPath2D(runCmds),
      style.fills.map((f) => effectiveFill(f, sampled)),
      style.strokes.map((st) => effectiveStroke(st, sampled, clip.modulators, localMs)),
      style.fillRule,
      resolve,
      bounds,
      media,
      runCmds,
      // The windows are per contour, in subpath order — this run's slice.
      reveal ? { ...reveal, windows: reveal.windows.slice(start, end) } : null,
    );
    start = end;
  }
  ctx.restore();
}


function recordHit(
  options: DrawOptions,
  frame: Frame,
  clipId: string,
  pose: ClipPose,
  layout: TextLayout,
  /** Fixed box width (maxWidth) — the selection/hit reflects the BOX, not the content. */
  boxWidth?: number | null,
  /** The text, when its link runs should ride the rect (only while collecting hits). */
  linked?: TextClip,
) {
  // A fixed/wrap box selects to the BOX, not the content — overflowing content
  // is clipped, so the selection (and the inline editor) stay the box's size
  // whether or not text spills past it (Figma). Auto-width has no box → content.
  const width = boxWidth != null ? boxWidth : layout.width;
  // Pivot box = the same box the renderer lays the glyphs in (`clipBox` is
  // "fixed dims, else the laid block"), so the handle and the art agree.
  const centre = layerCenter(frame, pose, {
    ...(layout.clipBox ?? { width, height: layout.height }),
    cx: 0,
    cy: 0,
  });
  const rectW = hitExtent(width, pose.scale, 24);
  const rectH = hitExtent(layout.height, pose.scaleY, 24);
  const linkRuns = linked && options.hitRects ? textLinkRuns(linked, layout, pose.scale / rectW, pose.scaleY / rectH) : undefined;
  pushHitRect(options, {
    clipId,
    frameId: frame.id,
    hostFrameId: options.hostFrameId ?? frame.id,
    cx: centre.cx,
    cy: centre.cy,
    width: rectW,
    height: rectH,
    rotation: pose.rotation,
    skewX: pose.skewX,
    skewY: pose.skewY,
    ...(linkRuns ? { linkRuns } : null),
  });
}

/**
 * A text's link spans as line boxes, through the ONE run-geometry function the
 * highlight pill uses (`highlightPills`) — each span measured with a pill of
 * its own, padded by nothing, so a link's area is exactly its letters' band.
 * `kx`/`ky` turn layout px into fractions of the hit rect (sign included, so a
 * mirrored text's link sits where its mirrored letters do).
 */
function textLinkRuns(clip: TextClip, layout: TextLayout, kx: number, ky: number): LinkRun[] | undefined {
  const spans = linkSpans(clip);
  if (spans.length === 0) return undefined;
  const marks = spans.map((_, i) => ({ color: `link-${i}`, radius: 0, paddingX: 0, paddingY: 0 }));
  const spanOf = (gi: number) => spans.findIndex((sp) => gi >= sp.start && gi < sp.end);
  const pills = highlightPills(layout, {
    highlightOf: (i) => {
      const k = spanOf(layout.glyphs[i]!.graphemeIndex);
      return k >= 0 ? marks[k]! : null;
    },
  });
  const runs: LinkRun[] = [];
  for (const p of pills) {
    const k = marks.indexOf(p.highlight);
    if (k < 0) continue;
    const xs = [p.x * kx, (p.x + p.width) * kx];
    const ys = [p.y * ky, (p.y + p.height) * ky];
    runs.push({ start: spans[k]!.start, end: spans[k]!.end, u0: Math.min(...xs), u1: Math.max(...xs), v0: Math.min(...ys), v1: Math.max(...ys) });
  }
  return runs.length ? runs : undefined;
}

/**
 * EVERYTHING IT TAKES TO DRAW ONE TEXT LAYER at one instant — resolved once.
 *
 * Two callers need this and they must agree exactly: the painter, and
 * `clipLocalGeometry`, which reserves the buffer the painter draws into. They
 * used to derive it separately, and the half the extent left out was the
 * animation — so every caption cut its spoken word's pill off at the buffer
 * wall. A shared plan makes that class of drift unrepresentable rather than
 * merely unlikely.
 */
interface TextDrawPlan {
  pose: ClipPose;
  layout: TextLayout;
  text: string;
  rStyle: ResolvedTextStyle;
  overrides: LayoutOverrides | undefined;
  /** Per GRAPHEME (what `evaluateTextGlyphs` returns). */
  visuals: GlyphVisual[];
  /** Per LAID GLYPH, the x its unit poses about; null = per-character. */
  pivotsX: number[] | null;
  /** The same two answers, keyed by laid glyph — what the extent walks. */
  anim: GlyphAnim;
  /** Per grapheme, the fills and strokes it is drawn with (ranges included). */
  paints: GlyphPaints;
  /** Per grapheme, the per-glyph passes — resolved for this instant. */
  textFx: GlyphTextEffects;
  /** Where the glyphs go when this text rides another layer's outline. */
  onPath: OnPathPlan | null;
}

function textDrawPlan(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  clip: TextClip,
  localMs: number,
): TextDrawPlan {
  const pose = evaluateClipPose(clip, localMs);
  const text = effectiveText(clip, localMs);
  const rStyle = resolveTextStyle(doc, clip.style);
  const overrides = layoutOverridesFor(pose);
  // The layer's ranges plus, on a caption, the cue being spoken — ONE array,
  // and after this line nothing below knows whether this is a caption.
  const ranges = effectiveRanges(clip, localMs);
  const layout = layoutTextClip(ctx, clip, overrides, text === clip.text ? undefined : text, rStyle, ranges);
  const seg = segmentTextCached(text);
  const visuals = evaluateTextGlyphs(clip, seg, localMs);
  const pivotsX = unitPivotsX(layout, seg, animatingUnit(clip, localMs));
  const anim: GlyphAnim = {
    visualAt: (i) => visuals[layout.glyphs[i]!.graphemeIndex] ?? GLYPH_IDENTITY,
    pivotXAt: (i) => (pivotsX ? pivotsX[i]! : layout.glyphs[i]!.x + layout.glyphs[i]!.width / 2),
  };
  const paints = glyphPaintsFor(clip, ranges, localMs);
  const textFx = glyphTextEffectsFor(clip, ranges, localMs);
  const onPath = planTextOnPath(doc, clip, layout, localMs, pose.sampled);
  return { pose, layout, text, rStyle, overrides, visuals, pivotsX, anim, paints, textFx, onPath };
}

/** Per grapheme index, the per-glyph passes to draw it with, resolved. */
export interface GlyphTextEffects {
  at: (graphemeIndex: number) => readonly ResolvedTextEffect[];
}

const NO_TEXT_FX: GlyphTextEffects = { at: () => [] };

/**
 * How far a glyph's own passes paint outside its box, in its local px — an
 * extrusion's length, an echo's travel, a shadow's offset and spread, a glow's
 * radius, a stroke's width. Bounds the buffer a blurred glyph is painted into
 * on engines where the blur runs on the CPU (`paintFiltered`).
 */
function glyphPaintReach(fx: readonly ResolvedTextEffect[], strokes: readonly { width: number }[]): number {
  let r = 0;
  for (const e of fx) {
    if (e.type === "extrude") r = Math.max(r, e.length);
    else if (e.type === "echo") r = Math.max(r, e.distance * e.count);
    else if (e.type === "glow") r = Math.max(r, e.radius * 2);
    else r = Math.max(r, Math.abs(e.x) + Math.abs(e.y) + e.blur * 2);
  }
  for (const st of strokes) r = Math.max(r, st.width * 2);
  return r;
}

/**
 * What each glyph's PASSES are worth right now — the same shape as
 * `glyphPaintsFor`, one grain over: the layer's stack resolved through the
 * registry (keyframes on `tfx.<id>.*`, modulators, the colour table), and,
 * where a range or a caption's focus carries its own list, that list resolved
 * the same way. Ranges never overlap, so a glyph reads one stack.
 *
 * Resolved once per STACK and not per glyph: a stack of three on a paragraph
 * of four hundred glyphs is three resolutions, not twelve hundred. The one
 * value that genuinely varies per glyph — the letter's own colour, for a pass
 * whose source is `text` — is substituted at draw time off `source`.
 *
 * Before this, the glyph pass read the raw effect off `g.style`, so a keyframe
 * on a glow's radius was addressable, sampled by the region pad, and then
 * drawn at its base value. The region grew for a halo that never moved.
 */
export function glyphTextEffectsFor(clip: TextClip, ranges: StyleRange[], localMs: number): GlyphTextEffects {
  const stackOf = (list: readonly TextEffect[] | undefined) => (list ?? []).filter((e) => e.enabled);
  const base = stackOf(clip.style.textEffects);
  const scoped = ranges.filter((r) => overlayTouchesTextEffects(r.overlay));
  if (base.length === 0 && scoped.length === 0) return NO_TEXT_FX;

  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const timeSec = localMs / 1000;
  const resolveStack = (list: readonly TextEffect[]): ResolvedTextEffect[] =>
    list
      .map((fx) => {
        // The eye is a discrete track like any field — `activeAt` reads it
        // for the region; here it is one lookup on the same sampled bag.
        const on = sampled[textEffectPath(fx.id, ENABLED_FIELD)];
        if (on === false) return null;
        return resolveTextEffect(fx, sampled, { glyphColor: "#000000", modulators: clip.modulators, timeSec });
      })
      .filter((fx): fx is ResolvedTextEffect => fx !== null && fx.opacity > 0.001);

  const baseResolved = resolveStack(base);
  if (scoped.length === 0) return { at: () => baseResolved };
  const sets = scoped.map((r) => ({
    start: r.start,
    end: r.end,
    list: resolveStack(stackOf(styleAt(clip.style, ranges, r.start).textEffects)),
  }));
  return {
    at: (graphemeIndex) => {
      for (const s of sets) if (graphemeIndex >= s.start && graphemeIndex < s.end) return s.list;
      return baseResolved;
    },
  };
}

/** Does this overlay change the per-glyph stack at all? */
function overlayTouchesTextEffects(ov: ScopeOverlay): boolean {
  return (
    ov.added.textEffects.length > 0 ||
    ov.removed.length > 0 ||
    Object.keys(ov.props).some((p) => p.startsWith("tfx."))
  );
}

/**
 * What each glyph is PAINTED with — the layer's fills and strokes, or, where a
 * range (a caption's spoken word included) overrides them, that range's.
 *
 * Resolved once per RANGE, not per glyph: ranges never overlap, so a glyph's
 * paint is the base set or the one set its covering range resolves to, through
 * the same `resolveLook` the inspector shows. That is what makes "add a fill
 * to these three words" paint those three words — the document could say it
 * since v59, and the inspector could write it; only the renderer was still
 * drawing every glyph with the layer's list.
 *
 * The override is applied over the SAMPLED layer paints, so an inherited fill
 * keeps its keyframes and a range that recolours it wins for its own glyphs —
 * an explicit override outranks the value it overrides, as an instance's does
 * in Figma. Ranges that only touch typography cost nothing here.
 */
export function glyphPaintsFor(clip: TextClip, ranges: StyleRange[], localMs: number): GlyphPaints {
  const base = paintSet(effectivePaints(clip, localMs));
  const scoped = ranges.filter((r) => overlayTouchesPaints(r.overlay));
  if (scoped.length === 0) return { at: () => base };
  const sets = scoped.map((r) => ({
    start: r.start,
    end: r.end,
    set: paintSet(resolveLook({ fills: base.fills, strokes: base.strokes, effects: clip.effects }, r.overlay)),
  }));
  return {
    at: (graphemeIndex) => {
      for (const s of sets) if (graphemeIndex >= s.start && graphemeIndex < s.end) return s.set;
      return base;
    },
  };
}

/** One resolved paint set, with the stroke visibility filter done once. */
export interface PaintSet {
  fills: Paint[];
  strokes: StrokeStyle[];
  visibleStrokes: StrokeStyle[];
}

/** Per grapheme index, the paints to draw it with. */
export interface GlyphPaints {
  at: (graphemeIndex: number) => PaintSet;
}

function paintSet(p: { fills: Paint[]; strokes: StrokeStyle[] }): PaintSet {
  return { fills: p.fills, strokes: p.strokes, visibleStrokes: p.strokes.filter(strokeIsVisible) };
}

const NO_PAINTS: GlyphPaints = { at: () => paintSet({ fills: [], strokes: [] }) };

function drawTextClip(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: TextClip,
  localMs: number,
  options: DrawOptions,
  resolve: ColorResolver,
) {
  const { pose, layout, text, rStyle, overrides, visuals, pivotsX, paints, textFx, onPath } = textDrawPlan(ctx, doc, clip, localMs);

  if (onPath) {
    // On a path the text's PIVOT box is the host's, but what you can click is
    // the ink — the letters where the curve put them. A hit rect the size of
    // the host would sit over the whole shape and steal every click meant for
    // it, so the rect is the glyphs' extent, posed by the host's transform
    // (which the resolved document has already made this text's own).
    const ink = onPathExtent(onPath, layout);
    const centre = layerCenter(frame, pose, onPath.box, { x: (ink.minX + ink.maxX) / 2, y: (ink.minY + ink.maxY) / 2 });
    pushHitRect(options, {
      clipId: clip.id,
      frameId: frame.id,
      hostFrameId: options.hostFrameId ?? frame.id,
      cx: centre.cx,
      cy: centre.cy,
      width: hitExtent(ink.maxX - ink.minX, pose.scale, 24),
      height: hitExtent(ink.maxY - ink.minY, pose.scaleY, 24),
      rotation: pose.rotation,
      skewX: pose.skewX,
      skewY: pose.skewY,
    });
  } else {
    recordHit(options, frame, clip.id, pose, layout, boxWidthOf(clip, overrides), clip);
  }
  // The inline editor stands in for a plain text while it is being edited; a
  // text on a path has no straight box for it to stand in, so the canvas keeps
  // painting the glyphs and the editor only carries the caret and the keys.
  if (options.skipClipId === clip.id && !onPath) return;

  drawGlyphBlock(
    ctx, frame, pose, layout, visuals, false, resolve, paints, clip.clipContent && !onPath,
    onPath ? null : resolveCaret(clip, layout, localMs, text, pose, rStyle, resolve),
    onPath ? null : pivotsX,
    textFx,
    onPath,
    onPath ? null : pillTravelFor(clip, localMs),
    onPath ? null : sampleCrop(clip, sampleKeyframes(clip.keyframes, localMs)),
  );
}

/**
 * The travelling-pill plan for this clip at this instant, or null.
 *
 * Timing comes from core (`captionTravelAt`); all this adds is the spans, so
 * the painter never learns what a cue is. Null the moment travel is off, which
 * is the fast path every non-caption text takes.
 */
function pillTravelFor(clip: TextClip, localMs: number): PillTravel | null {
  const caption = clip.caption;
  if (!caption?.motion.travel) return null;
  const t = captionTravelAt(caption, localMs);
  if (!t) return null;
  return {
    from: t.from ? { start: t.from.start, end: t.from.end } : null,
    to: { start: t.to.start, end: t.to.end },
    t: t.t,
  };
}

/**
 * The grain currently driving this clip's glyphs.
 *
 * A clip can enter by word and leave by letter, and only one of them is moving
 * at any instant — so the pivot follows whichever phase this moment belongs to,
 * split at the clip's midpoint. With one spec (the overwhelming case) there is
 * nothing to choose.
 */
function animatingUnit(clip: TextClip, localMs: number): AnimationUnit {
  const { in: inSpec, out: outSpec } = clip.animations;
  if (inSpec && outSpec) return localMs >= clip.durationMs / 2 ? outSpec.unit : inSpec.unit;
  return (inSpec ?? outSpec)?.unit ?? "letter";
}

/** A caret resolved to the box the drawer paints, in block-local px. */
interface DrawnCaret {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

/**
 * Turn the DERIVED caret placement into a rectangle in the text block's own
 * space. Core answers "which grapheme is the head at, and is it lit"; the
 * layout answers "where is that grapheme"; nothing about either is stored.
 *
 * The caret sits at the trailing edge of the glyph before it (or the leading
 * edge of the first glyph when nothing has typed yet), which is where a caret
 * sits in every text editor — and reading it off the LAID glyph means it lands
 * correctly for wrapped lines and RTL runs for free, since the layout has
 * already resolved both.
 */
function resolveCaret(
  clip: TextClip,
  layout: TextLayout,
  localMs: number,
  text: string,
  pose: ClipPose,
  rStyle: ResolvedTextStyle,
  resolve: ColorResolver,
): DrawnCaret | null {
  const placement = caretAt(clip, localMs);
  // A node driver can rewrite the content out from under the schedule; the
  // placement then indexes a string we are not drawing, so we draw no caret
  // rather than one in an arbitrary spot.
  if (!placement || !placement.lit || placement.text !== text) return null;

  const glyphs = layout.glyphs;
  if (glyphs.length === 0) return null;
  const idx = placement.graphemeIndex;

  // Anchor to the NEAREST PRECEDING laid glyph, scanning rather than looking up
  // `idx - 1` directly: not every grapheme is laid (a newline has no glyph), and
  // an exact-index lookup that misses used to fall back to glyph 0 — which
  // parked the cursor at the start of the sentence exactly when it should have
  // been resting at the end. Only a caret genuinely before all text sits left of
  // the first glyph.
  let prev: LaidGlyph | undefined;
  let here: LaidGlyph | undefined;
  for (const g of glyphs) {
    if (g.graphemeIndex < idx && (!prev || g.graphemeIndex > prev.graphemeIndex)) prev = g;
    if (g.graphemeIndex >= idx && (!here || g.graphemeIndex < here.graphemeIndex)) here = g;
  }
  const anchorGlyph = prev ?? here ?? glyphs[0]!;
  const size = anchorGlyph.style.fontSize;
  const x = prev ? prev.x + prev.width : anchorGlyph.x;

  const caret = clip.caret;
  const thickness = Math.max(0.5, size * caret.width);
  const color = resolve(caret.color ?? pose.colorOverride ?? anchorGlyph.style.color ?? rStyle.color);
  switch (caret.style) {
    case "block":
      return { x, y: anchorGlyph.y - size * 0.78, width: size * 0.55, height: size * 0.98, color };
    case "underline":
      return { x, y: anchorGlyph.y + size * 0.1, width: size * 0.55, height: thickness, color };
    default:
      return { x, y: anchorGlyph.y - size * 0.78, width: thickness, height: size * 0.98, color };
  }
}

/** A visual clip's fills/strokes with their per-id keyframes applied at `localMs`. */
function effectivePaints(
  clip: {
    keyframes: TextClip["keyframes"];
    fills: Paint[];
    strokes: StrokeStyle[];
    drivers?: Record<string, string>;
    modulators?: readonly Modulator[];
  },
  localMs: number,
): { fills: Paint[]; strokes: StrokeStyle[] } {
  if (clip.fills.length === 0 && clip.strokes.length === 0) return { fills: [], strokes: [] };
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const { n } = samplers(sampled);
  return {
    fills: clip.fills.map((f) => effectiveFill(f, sampled)),
    strokes: clip.strokes.map((s) => effectiveStroke(s, sampled, clip.modulators, localMs)),
  };
}

/**
 * LAY ONE GLYPH'S INK — the fill, and with faux bold on, a stroke of the SAME
 * paint around it, so the extra thickness is the glyph's own colour, gradient
 * or pattern. Every pass that draws a glyph's silhouette goes through here —
 * fills, extrude and echo copies, the source a shadow or glow is cast from —
 * so a bold letter casts a bold shadow and extrudes a bold side.
 *
 * Fill and stroke are two draw calls, and two draw calls are two layers of
 * alpha: under a fade, a translucent paint, a blend mode or a canvas shadow,
 * the band where the stroke overlaps the fill would come out darker — a ring
 * inside every letter while it fades in, a doubled shadow under it. So unless
 * the draw is opaque, plain source-over and unshadowed (where overlap is
 * invisible), the silhouette is built once on a scratch canvas in DEVICE space
 * and composited in one `drawImage`, which the alpha, the blend, the blur
 * filter and the shadow then treat as the single shape it is.
 */
let glyphScratch: HTMLCanvasElement | null = null;

function inkGlyph(ctx: CanvasRenderingContext2D, g: LaidGlyph, x: number, y: number): void {
  const out = fauxBoldOutset(g.style);
  if (out <= 0) {
    ctx.fillText(g.char, x, y);
    return;
  }
  const shadowed = ctx.shadowBlur > 0 || ctx.shadowOffsetX !== 0 || ctx.shadowOffsetY !== 0;
  const direct = ctx.globalAlpha >= 0.999 && ctx.globalCompositeOperation === "source-over" && !shadowed;
  const embolden = (c: CanvasRenderingContext2D) => {
    c.fillText(g.char, x, y);
    c.save();
    c.strokeStyle = c.fillStyle;
    c.lineWidth = out * 2;
    c.lineJoin = "round";
    c.setLineDash([]);
    c.strokeText(g.char, x, y);
    c.restore();
  };
  if (direct || typeof document === "undefined") {
    embolden(ctx);
    return;
  }

  // The glyph's ink, generously: accents above the cap height, the widest
  // descender, and the outset on every side.
  const size = g.style.fontSize;
  const pad = out + 2;
  const m = ctx.getTransform();
  const corners = [
    [x - pad, y - Math.max(size * 1.25, g.inkAscent) - pad],
    [x + g.width + pad + size * 0.25, y - Math.max(size * 1.25, g.inkAscent) - pad],
    [x - pad, y + Math.max(size * 0.5, g.inkDescent) + pad],
    [x + g.width + pad + size * 0.25, y + Math.max(size * 0.5, g.inkDescent) + pad],
  ].map(([px, py]) => [m.a * px! + m.c * py! + m.e, m.b * px! + m.d * py! + m.f] as const);
  const x0 = Math.floor(Math.min(...corners.map((c) => c[0])));
  const y0 = Math.floor(Math.min(...corners.map((c) => c[1])));
  const w = Math.ceil(Math.max(...corners.map((c) => c[0]))) - x0;
  const h = Math.ceil(Math.max(...corners.map((c) => c[1]))) - y0;
  if (w <= 0 || h <= 0 || w * h > 4096 * 4096) {
    embolden(ctx);
    return;
  }
  glyphScratch ??= document.createElement("canvas");
  if (glyphScratch.width < w) glyphScratch.width = w;
  if (glyphScratch.height < h) glyphScratch.height = h;
  const sc = glyphScratch.getContext("2d");
  if (!sc) {
    embolden(ctx);
    return;
  }
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.clearRect(0, 0, w, h);
  sc.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0);
  sc.font = ctx.font;
  sc.textAlign = ctx.textAlign;
  sc.textBaseline = ctx.textBaseline;
  sc.direction = ctx.direction;
  sc.fillStyle = ctx.fillStyle;
  embolden(sc);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(glyphScratch, 0, 0, w, h, x0, y0, w, h);
  ctx.restore();
}

/**
 * Draw a laid-out block of glyphs with per-glyph animation visuals.
 * `visualsByLaidOrder`: when true, visuals[i] corresponds to layout.glyphs[i];
 * otherwise visuals is indexed by graphemeIndex.
 */
function drawGlyphBlock(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  pose: ClipPose,
  layout: TextLayout,
  visuals: GlyphVisual[],
  visualsByLaidOrder = false,
  resolve: ColorResolver = IDENTITY_RESOLVER,
  /**
   * Unified paint lists (Figma) per glyph: multiple fills merge, strokes
   * outline glyphs. Per glyph because a range can carry its own — see
   * `glyphPaintsFor`. An empty fill list falls back to the glyph's `color`.
   */
  paints: GlyphPaints = NO_PAINTS,
  /** Clip glyphs + their effects to the text box (Figma "Clip content"). */
  clipToBox = false,
  /** Typewriter caret, already resolved to block-local px (text clips only). */
  caret: DrawnCaret | null = null,
  /**
   * Per laid glyph, the x its animation scales and rotates ABOUT — the centre
   * of the word or line it animates as part of. Null = per-character, which is
   * both the `letter` grain and every caller that has no animation grain.
   * See `unitPivotsX`.
   */
  pivotsX: number[] | null = null,
  /** Per glyph, the resolved per-glyph passes. Callers without a clip (the
   *  library's cards, a paste preview) have none. */
  textFx: GlyphTextEffects = NO_TEXT_FX,
  /**
   * The glyphs' poses on a host's outline. When present every glyph is drawn
   * at its pose in the HOST's local space (the text's box is the host's), the
   * pills, decorations and caret — all straight-line ideas — are skipped, and
   * the per-glyph animation plays in the glyph's turned frame.
   */
  onPath: OnPathPlan | null = null,
  /** The spoken word's pill is sliding to it from the previous one. See `PillTravel`. */
  travel: PillTravel | null = null,
  /** The layer's crop window insets, in its box's px — the same window a box layer crops to. */
  crop: CropInsets | null = null,
) {
  // THE LAYER'S ALPHA, including what it inherits. Every pass below ASSIGNS
  // `globalAlpha` per glyph, pill, run and caret — so the alpha already on the
  // canvas (an enclosing group fading out, drawn straight through rather than
  // into a buffer) has to be folded in here, once, or the group's pill fades
  // and its text stays at full strength until it pops off at its out-point.
  const layerAlpha = ctx.globalAlpha * pose.opacity;
  ctx.save();
  // A text layer's box is its laid-out block (or its fixed wrap box) — that is
  // what the pivot is a fraction of. On a path it is the host's box.
  applyLayerPose(
    ctx,
    frame,
    pose,
    onPath
      ? onPath.box
      : {
          width: layout.clipBox?.width ?? layout.width,
          height: layout.clipBox?.height ?? layout.height,
          cx: 0,
          cy: 0,
        },
  );
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // THE CROP WINDOW, in the box the pivot is a fraction of — exactly what
  // `withBoxClip` does for a box layer, so a keyed crop wipes text the same way.
  if (crop) clipToCrop(ctx, crop, { width: layout.clipBox?.width ?? layout.width, height: layout.clipBox?.height ?? layout.height, cx: 0, cy: 0 });

  // The animation this block is drawn under, keyed by LAID glyph — built once
  // and shared by the mask below and the pill pass, so neither can disagree
  // with the other (or with the buffer `clipLocalGeometry` sized for them).
  const anim: GlyphAnim = {
    visualAt: (i) =>
      (visualsByLaidOrder ? visuals[i] : visuals[layout.glyphs[i]!.graphemeIndex]) ?? GLYPH_IDENTITY,
    pivotXAt: (i) => (pivotsX ? pivotsX[i]! : layout.glyphs[i]!.x + layout.glyphs[i]!.width / 2),
  };

  // "Clip content" on: mask the glyphs (and their effects) to the text box so
  // anything overflowing is cut off, exactly like Figma. Off (default): draw
  // free so strokes/shadows/blurs and layer animations never trim the edges.
  if (clipToBox && layout.clipBox) {
    // The pill is never trimmed, not even here. "Clip content" is a promise
    // about the TEXT overflowing its box; a highlight is drawn behind the run
    // it belongs to, always exactly as wide as its padding says, and cutting it
    // at the box edge squares off the corner radius instead of hiding anything
    // anyone asked to hide. So the mask is the box UNION the pills — the pills
    // AS POSED, or a caption's spoken word would pop straight into the mask.
    const pill = highlightBounds(layout, anim);
    const minX = Math.min(-layout.clipBox.width / 2, pill?.minX ?? Infinity);
    const minY = Math.min(-layout.clipBox.height / 2, pill?.minY ?? Infinity);
    const maxX = Math.max(layout.clipBox.width / 2, pill?.maxX ?? -Infinity);
    const maxY = Math.max(layout.clipBox.height / 2, pill?.maxY ?? -Infinity);
    ctx.beginPath();
    ctx.rect(minX, minY, maxX - minX, maxY - minY);
    ctx.clip();
  }

  // Text gradient fill: the whole block shares ONE paint box (block-local,
  // centered on the pose origin — the same box the on-stage handles map over).
  // Each glyph draws in its own translated frame, so we shift the box by the
  // glyph origin and reuse the exact `paintStyle` the vectors use.
  const textPaintBox: PaintBounds = { x: -layout.width / 2, y: -layout.height / 2, w: layout.width, h: layout.height };

  // Pass 2 — glyphs, in TWO passes: every stroke in the run, then every fill.
  //
  // This ordering is the whole reason connected scripts look right. A glyph is
  // its own closed outline, and in Arabic the outlines of adjacent letters
  // TOUCH — that is what a cursive join is. Stroking each glyph and filling it
  // before moving to the next meant letter N+1's stroke was painted on top of
  // letter N's fill, so every join wore a seam and a word read as a row of
  // separately outlined boxes rather than one connected shape. Zero letter
  // spacing made it worse, not better: the closer the letters, the more of each
  // stroke landed on its neighbour.
  //
  // Painting all strokes first fixes it exactly, with no boolean union and no
  // buffer: the seam is by definition INSIDE the union of the fills, so the
  // fills cover it. What survives is the outer silhouette of the whole word —
  // which is what a stroke on connected text means. Latin is unaffected because
  // its letters do not overlap, and a stroke was already drawn under its own
  // glyph's fill, so nothing about a single glyph's look changes.

  /*
   * DRAW UNITS — a glyph, or a whole WORD in a joining script.
   *
   * Arabic and Persian only look like themselves when the font shapes the
   * whole word: joins, the lam-alef ligature, kerning, contextual alternates.
   * The inline editor is DOM text, so it always gets that; a canvas that drew
   * letter by letter could only imitate it, and the imitation differed by font
   * and by letter — the "right while editing, wrong after" bug. So a word the
   * layout marked (`LaidGlyph.word`) is drawn in ONE call whenever its letters
   * move together: same visuals, same pivot, same paints, same look. That is
   * every static frame and every word- or line-grained animation. Only a
   * letter-grained animation, which moves the letters apart, draws them one
   * by one (each in its joined form, `shapeArabicGraphemes`).
   *
   * The unit carries the word's first letter's index for paint and visual
   * lookups (they are identical across the word by construction) and spans
   * the word's laid box, which layout already sized to the shaped word.
   */
  const units: Array<{ g: LaidGlyph; i: number }> = [];
  {
    const visOf = (k: number) =>
      (visualsByLaidOrder ? visuals[k] : visuals[layout.glyphs[k]!.graphemeIndex]) ?? GLYPH_IDENTITY;
    const sameVis = (a: GlyphVisual, b: GlyphVisual) =>
      a === b ||
      (a.opacity === b.opacity && a.dx === b.dx && a.dy === b.dy && a.scale === b.scale && a.rotation === b.rotation && a.blur === b.blur);
    const sameList = <T,>(a: readonly T[], b: readonly T[]) => a === b || (a.length === 0 && b.length === 0);
    const together = (from: number, to: number) => {
      const g0 = layout.glyphs[from]!;
      const v0 = visOf(from);
      const p0 = paints.at(g0.graphemeIndex);
      const f0 = textFx.at(g0.graphemeIndex);
      // Letter-grained pivots differ per letter: a turned or scaled word must
      // turn about one point, so without a shared pivot it stays per letter.
      if (!pivotsX && (v0.scale !== 1 || v0.rotation !== 0)) return false;
      for (let k = from + 1; k < to; k++) {
        const g = layout.glyphs[k]!;
        const p = paints.at(g.graphemeIndex);
        if (!sameVis(visOf(k), v0)) return false;
        if (pivotsX && pivotsX[k] !== pivotsX[from]) return false;
        if (!sameList(p.fills, p0.fills) || !sameList(p.strokes, p0.strokes)) return false;
        if (!sameList(textFx.at(g.graphemeIndex), f0)) return false;
        if (g.style.color !== g0.style.color || g.style.opacity !== g0.style.opacity || g.style.fauxBold !== g0.style.fauxBold) return false;
      }
      return true;
    };
    for (let i = 0; i < layout.glyphs.length; ) {
      const g = layout.glyphs[i]!;
      const w = g.word;
      if (w && !onPath) {
        let j = i + 1;
        while (j < layout.glyphs.length && layout.glyphs[j]!.word === w && layout.glyphs[j]!.line === g.line) j++;
        if (j - i === w.size && together(i, j)) {
          const members = layout.glyphs.slice(i, j);
          const first = members.reduce((a, m) => (m.graphemeIndex < a.graphemeIndex ? m : a));
          units.push({
            i,
            g: {
              ...first,
              char: w.text,
              x: Math.min(...members.map((m) => m.x)),
              width: members.reduce((a, m) => a + m.width, 0),
              inkAscent: Math.max(...members.map((m) => m.inkAscent)),
              inkDescent: Math.max(...members.map((m) => m.inkDescent)),
            },
          });
          i = j;
          continue;
        }
      }
      units.push({ g, i });
      i++;
    }
  }

  type Unit = (typeof units)[number];
  const unitVis = ({ g, i }: Unit) => (visualsByLaidOrder ? visuals[i] : visuals[g.graphemeIndex]) ?? GLYPH_IDENTITY;
  /** Whitespace, and the empty slot of an alef folded into lam-alef, paint nothing. */
  const blank = (g: LaidGlyph) => g.char === "\n" || /^\s*$/.test(g.char);
  /** What a unit's passes can reach past its box (extrusions, echoes, shadows, strokes). */
  const reachOf = (g: LaidGlyph) =>
    g.style.fontSize * 0.5 + glyphPaintReach(textFx.at(g.graphemeIndex), paints.at(g.graphemeIndex).visibleStrokes);
  /** A unit's ink box in its own frame — what its blur paints through, and what a fade buffer must hold. */
  const inkBox = (g: LaidGlyph, reach: number) => ({
    x: -g.width / 2 - reach,
    y: -Math.max(g.style.fontSize * 1.25, g.inkAscent) - reach,
    w: g.width + reach * 2,
    h: Math.max(g.style.fontSize * 1.25, g.inkAscent) + Math.max(g.style.fontSize * 0.4, g.inkDescent) + reach * 2,
  });
  /**
   * Into a unit's own frame, from the block's. ONE function for the canvas that
   * paints the unit and the matrix that measures it, so the buffer a fade
   * composites through can never disagree with where the glyph lands.
   */
  const enterUnit = (t: Frame2D, g: LaidGlyph, i: number, vis: GlyphVisual) => {
    const onCurve = onPath ? onPath.poses[i] : undefined;
    if (onCurve) {
      // On the curve: the glyph's frame is its pose — translated to where the
      // path put its baseline centre, turned along the tangent — and the
      // animation plays INSIDE that frame, so a letter that slides in slides
      // along its own baseline rather than across the comp.
      t.translate(onCurve.x, onCurve.y);
      if (onCurve.angle !== 0) t.rotate(onCurve.angle);
      t.translate(vis.dx, vis.dy);
      if (vis.rotation !== 0) t.rotate((vis.rotation * Math.PI) / 180);
      if (vis.scale !== 1) t.scale(vis.scale, vis.scale);
      return;
    }
    // Scale and rotate about the ANIMATION UNIT's centre — the glyph's own
    // for the `letter` grain, the word's or the line's otherwise. Scaling a
    // line-grained animation per character is what made a line arrive as a
    // row of separately shrinking letters instead of as a line.
    const px = pivotsX ? pivotsX[i]! : g.x + g.width / 2;
    t.translate(px + vis.dx, g.y + vis.dy);
    if (vis.rotation !== 0) t.rotate((vis.rotation * Math.PI) / 180);
    if (vis.scale !== 1) t.scale(vis.scale, vis.scale);
    // Back out to the glyph's own frame; zero when the pivot IS the glyph.
    t.translate(g.x + g.width / 2 - px, 0);
  };

  type GlyphPainter = (
    g: LaidGlyph,
    alpha: number,
    paintFor: (p: Paint) => string | CanvasGradient | CanvasPattern,
    glyphBounds: PaintBounds,
    baseColor: string,
    /** The context to draw THIS glyph into — the target's, or a blur's own buffer (`paintFiltered`). */
    c: CanvasRenderingContext2D,
  ) => void;

  /**
   * Walk `list` once, setting up each glyph's own frame (transform, alpha,
   * font, gradient box) on `target` and handing `paint` only what depends on
   * it. `alphaOf` turns the unit's own alpha into the one it paints at — the
   * layer's folded in when painting straight onto the layer, 1 inside a fade
   * buffer that applies it once.
   */
  const forEachGlyph = (target: CanvasRenderingContext2D, list: readonly Unit[], alphaOf: (unitAlpha: number) => number, paint: GlyphPainter) => {
    for (const u of list) {
      const { g, i } = u;
      const vis = unitVis(u);
      const alpha = alphaOf(vis.opacity * g.style.opacity);
      if (alpha <= 0.001 || blank(g)) continue;
      const onCurve = onPath ? onPath.poses[i] : undefined;
      if (onCurve && !onCurve.visible) continue;

      target.save();
      target.globalAlpha = Math.min(1, alpha);
      enterUnit(target, g, i, vis);

      target.font = fontString(g.style);
      // A joined Arabic letter only takes its contextual form in an RTL run —
      // the same direction layout measured it in (see `glyphDirection`).
      target.direction = glyphDirection(g.char);

      // Each glyph draws in its own translated frame, so the block-wide gradient
      // box is shifted by the glyph origin — the same trick keeps a text gradient
      // continuous across every glyph (and identical to the on-stage handles).
      const ox = g.x + vis.dx + g.width / 2;
      const oy = g.y + vis.dy;
      const glyphBounds: PaintBounds = { x: textPaintBox.x - ox, y: textPaintBox.y - oy, w: textPaintBox.w, h: textPaintBox.h };
      // Blur is purely the per-glyph ANIMATION blur; a blur EFFECT is a pass
      // over the composited layer, like every other effect (v54). Painted
      // THROUGH it, so it blurs on every engine.
      paintFiltered(
        target,
        vis.blur > 0.2 ? [{ kind: "blur", px: vis.blur }] : [],
        (c) => {
          c.font = target.font;
          c.direction = target.direction;
          paint(
            g,
            alpha,
            (paint2: Paint) => paintStyle(c, paint2, glyphBounds, resolve),
            glyphBounds,
            // The representative solid color (fallback + what shadows cast).
            resolve(g.style.color),
            c,
          );
        },
        inkBox(g, reachOf(g)),
      );
      target.restore();
    }
  };

  /*
   * Pass 1b — TEXT EFFECTS, per glyph, behind the strokes and fills.
   *
   * The passes arrive RESOLVED (`glyphTextEffectsFor`): keyframes, modulators
   * and the colour table are already in the numbers, and a range or a
   * caption's focus that carries its own list has been picked per grapheme.
   * So a focused word carrying its own glow needs nothing here — the same
   * scope resolution that gives it its own colour gives it its own passes.
   *
   * Shadow and glow ride the canvas's own shadow, which is per DRAW CALL and
   * therefore already per glyph — the cheapest correct place for either. Glow
   * is a zero-offset shadow laid down `intensity` times, which is how every
   * canvas renderer builds one. Extrude steps a solid copy along an angle, back
   * to front, so the near face lands last; echo does the same with spaced,
   * fading copies.
   */
  const fxPass: GlyphPainter = (g, alpha, _paintFor, _glyphBounds, _baseColor, c) => {
    const fx = textFx.at(g.graphemeIndex);
    if (fx.length === 0) return;
    for (const e of fx) {
      // A `text` source FOLLOWS THE GLYPH — which is why a focused word's glow
      // tracks its focus colour with no code here that knows about scopes.
      const color = e.source === "text" ? resolve(g.style.color) : e.color;
      c.save();
      c.globalAlpha = Math.min(1, alpha) * e.opacity;
      if (e.type === "extrude") {
        const rad = (e.angle * Math.PI) / 180;
        const dx = Math.cos(rad);
        const dy = Math.sin(rad);
        c.fillStyle = color;
        // Back to front, one step per pixel of length — far enough apart to be
        // cheap, close enough that the extrusion reads as solid.
        for (let d = Math.round(e.length); d >= 1; d--) {
          inkGlyph(c, g, -g.width / 2 + dx * d, dy * d);
        }
      } else if (e.type === "echo") {
        const rad = (e.angle * Math.PI) / 180;
        const dx = Math.cos(rad);
        const dy = Math.sin(rad);
        c.fillStyle = color;
        const count = Math.max(1, Math.round(e.count));
        // Far copy first, each one dimmer by `fade` of the way to the last.
        for (let i = count; i >= 1; i--) {
          const t = count === 1 ? 1 : (i - 1) / (count - 1);
          c.globalAlpha = Math.min(1, alpha) * e.opacity * (1 - e.fade * t);
          inkGlyph(c, g, -g.width / 2 + dx * e.distance * i, dy * e.distance * i);
        }
      } else {
        c.shadowColor = color;
        // Shadow blur is DEVICE space, not user space — it does not ride the
        // CTM the glyph is drawn under. Scaling it by the current transform is
        // what keeps a 12px glow looking like 12px of the FRAME at every zoom,
        // instead of vanishing when you zoom out and swallowing the letter
        // when you zoom in.
        const m = c.getTransform();
        const zoomK = (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2 || 1;
        c.shadowBlur = (e.type === "glow" ? e.radius : e.blur) * zoomK;
        c.shadowOffsetX = (e.type === "glow" ? 0 : e.x) * zoomK;
        c.shadowOffsetY = (e.type === "glow" ? 0 : e.y) * zoomK;
        // The SOURCE has to be opaque. A canvas shadow is cast by the pixels
        // actually drawn, so filling transparently casts nothing at all —
        // which is why the first cut of this rendered nothing whatsoever.
        // Painting the source in the effect's own colour is safe: it lands at
        // the glyph's own position, where the real fill covers it a pass later,
        // and on the rare translucent fill what shows through is the same hue.
        c.fillStyle = color;
        const times = e.type === "glow" ? Math.max(1, Math.round(e.intensity * 2)) : 1;
        for (let i = 0; i < times; i++) inkGlyph(c, g, -g.width / 2, 0);
      }
      c.restore();
    }
  };

  // Pass 2a — unified paint strokes (Figma), the whole run, behind every fill.
  //
  // A glyph is rasterized by the FONT, not by a path we hold, so this is the
  // one place a stroke cannot be handed to `paintStrokes`. What it can share
  // is every DECISION: visibility comes from core's `strokeIsVisible`, and the
  // dash pair comes off the resolved stroke — which is exactly what
  // `buildStrokePlan` hands back for a uniform line. So "Marching ants" means
  // the same thing on a letter as on a shape, and a modulator on
  // `stroke.<id>.dashOffset` marches both. Trim, wave, taper and markers need
  // real geometry and are applied once the glyph's outline is available
  // (see `glyphOutline`).
  const strokePass: GlyphPainter = (g, alpha, paintFor, glyphBounds, _baseColor, c) => {
      const visibleStrokes = paints.at(g.graphemeIndex).visibleStrokes;
      if (visibleStrokes.length === 0) return;
      // Outlines are only fetched when a stroke actually needs geometry, and only
      // read if the font is already resident — never awaited on a frame.
      const outline = visibleStrokes.some(needsSampling)
        ? glyphCommandsIfReady(g.char, g.style, -g.width / 2, 0)
        : null;
      const outlinePath = outline ? commandsToPath2D(outline) : null;

      for (const s of visibleStrokes) {
        // Real geometry available → the SAME painter a shape uses, so trim, wave,
        // taper and markers behave identically on a letter.
        if (outline && outlinePath && needsSampling(s)) {
          c.save();
          c.globalAlpha = Math.min(1, alpha);
          paintStrokes(c, outline, [s], resolve, glyphBounds, { path: outlinePath, rule: "nonzero" });
          c.restore();
          continue;
        }
        c.save();
        c.globalAlpha = Math.min(1, alpha) * s.opacity;
        c.globalCompositeOperation = COMPOSITE[s.blendMode];
        c.strokeStyle = paintFor(s.paint);
        c.lineJoin = s.join;
        c.lineCap = s.cap;
        c.setLineDash(s.dash);
        // Canvas walks its dash the opposite way from the offset every host means
        // by it — negate so a rising offset marches forward, as it does on a path.
        c.lineDashOffset = -s.dashOffset;
        // Centre align is exact. Without the glyph as a clip region the other two
        // can only paint doubled UNDER the fill, whose inner half the fill then
        // covers — which is what an outside-aligned stroke looks like.
        // Faux bold moved the glyph's edge outward by its outset; the stroke
        // rides the edge that is actually painted, not the face's own.
        c.lineWidth = (s.align === "center" ? s.width : s.width * 2) + fauxBoldOutset(g.style) * 2;
        c.strokeText(g.char, -g.width / 2, 0);
        c.restore();
      }
  };

  // Pass 2b — crisp fills: the glyph's unified fill list (multiple merge,
  // gradients supported); an empty list falls back to the glyph's own `color`,
  // which is where a range's colour override lives.
  const fillPass: GlyphPainter = (g, alpha, paintFor, _glyphBounds, baseColor, c) => {
    const fills = paints.at(g.graphemeIndex).fills;
    if (fills.length === 0) {
      c.fillStyle = baseColor;
      inkGlyph(c, g, -g.width / 2, 0);
      return;
    }
    for (const f of fills) {
      if (f.opacity <= 0.001) continue;
      c.save();
      c.globalAlpha = Math.min(1, alpha) * f.opacity;
      c.globalCompositeOperation = COMPOSITE[f.blendMode];
      c.fillStyle = paintFor(f);
      inkGlyph(c, g, -g.width / 2, 0);
      c.restore();
    }
  };

  const paintUnits = (target: CanvasRenderingContext2D, list: readonly Unit[], alphaOf: (unitAlpha: number) => number) => {
    forEachGlyph(target, list, alphaOf, fxPass);
    forEachGlyph(target, list, alphaOf, strokePass);
    forEachGlyph(target, list, alphaOf, fillPass);
  };

  // Pass 3 — underline / strikethrough over contiguous decorated runs. Pass 4
  // — the typing caret, over everything. It takes the LAYER's opacity but none
  // of the per-glyph animation: a cursor that faded and slid with the letter it
  // trails would read as another letter, not as a cursor.
  const paintOver = (target: CanvasRenderingContext2D, alpha: number) => {
    if (!onPath) drawDecorationRuns(target, layout, visuals, visualsByLaidOrder, alpha, resolve, pivotsX);
    if (caret) {
      target.save();
      target.globalAlpha = alpha;
      target.fillStyle = caret.color;
      // `x`/`y` are already in the same block-local space the glyph pass draws in.
      target.fillRect(caret.x, caret.y, caret.width, caret.height);
      target.restore();
    }
  };

  /*
   * FADES COMPOSITE, THEY DO NOT MULTIPLY.
   *
   * Alpha on a canvas is per draw call, and inside one call it is per GLYPH:
   * a whole Persian word filled at 50% still lays its joins down twice, where
   * each letter's outline reaches under its neighbour. Every translucent text
   * came out with bright seams at its joins, a darker ring where a stroke met
   * its fill, and overlapping script letters stacked.
   *
   * So a fade is applied to a finished picture, at two levels, the way
   * Figma and After Effects do:
   *  · the LAYER's opacity (its own, and an enclosing group's drawn through)
   *    once, over the whole block — pills, glyphs, decorations, caret;
   *  · a UNIT's own fade (a word or letter of an animation) once per run of
   *    units fading together — every unit of a whole-layer or line-grained
   *    fade, each word of a word-grained one.
   * Units with DIFFERENT fades still overlap as the separate pieces they are,
   * exactly as two layers would.
   *
   * Opaque text (nearly every frame) never takes this path. Neither does a
   * block whose paints blend with the backdrop: in a buffer they would blend
   * with nothing, and the look would jump the frame its fade began.
   */
  const runs: Array<{ alpha: number; units: Unit[] }> = [];
  for (const u of units) {
    const a = unitVis(u).opacity * u.g.style.opacity;
    const last = runs[runs.length - 1];
    if (last && last.alpha === a) last.units.push(u);
    else runs.push({ alpha: a, units: [u] });
  }
  const fadedRun = (r: (typeof runs)[number]) => r.alpha > 0.001 && r.alpha < 0.999;
  const fading = layerAlpha > 0.001 && (layerAlpha < 0.999 || runs.some(fadedRun));
  const region = fading && !blendsWithBackdrop(units, paints) ? fadeRegion(ctx, layout, units) : null;

  if (!region) {
    if (!onPath) drawHighlightRuns(ctx, layout, anim, layerAlpha, resolve, travel);
    paintUnits(ctx, units, (a) => a * layerAlpha);
    paintOver(ctx, layerAlpha);
    ctx.restore();
    return;
  }

  // The block's own buffer when the layer fades; else runs land on the layer.
  const block = layerAlpha < 0.999 ? takeFadeBuffer(region) : null;
  const target = block ?? ctx;
  const k = block ? 1 : layerAlpha;
  if (!onPath) drawHighlightRuns(target, layout, anim, k, resolve, travel);
  for (const run of runs) {
    if (!fadedRun(run)) {
      paintUnits(target, run.units, (a) => a * k);
      continue;
    }
    const buffer = takeFadeBuffer(region);
    if (!buffer) {
      paintUnits(target, run.units, (a) => a * k);
      continue;
    }
    paintUnits(buffer, run.units, () => 1);
    compositeFadeBuffer(target, buffer, region, run.alpha * k, !block);
  }
  paintOver(target, k);
  if (block) compositeFadeBuffer(ctx, block, region, layerAlpha, true);
  ctx.restore();

  /** Everything the block can paint, in DEVICE px, on the canvas it paints. */
  function fadeRegion(c: CanvasRenderingContext2D, lay: TextLayout, list: readonly Unit[]): FadeRegion | null {
    if (typeof document === "undefined") return null;
    const M = c.getTransform();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (m: DOMMatrix, r: { x: number; y: number; w: number; h: number }) => {
      for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]] as const) {
        const X = m.a * px + m.c * py + m.e;
        const Y = m.b * px + m.d * py + m.f;
        if (X < x0) x0 = X;
        if (X > x1) x1 = X;
        if (Y < y0) y0 = Y;
        if (Y > y1) y1 = Y;
      }
    };
    for (const u of list) {
      if (blank(u.g)) continue;
      const vis = unitVis(u);
      const m = DOMMatrix.fromMatrix(M);
      enterUnit(matrixFrame(m), u.g, u.i, vis);
      add(m, inkBox(u.g, reachOf(u.g) + vis.blur * 3));
    }
    if (!onPath) {
      const pill = highlightBounds(lay, anim);
      if (pill) add(M, { x: pill.minX, y: pill.minY, w: pill.maxX - pill.minX, h: pill.maxY - pill.minY });
    }
    if (caret) add(M, { x: caret.x, y: caret.y, w: caret.width, h: caret.height });
    const x = Math.max(0, Math.floor(x0) - 2);
    const y = Math.max(0, Math.floor(y0) - 2);
    const w = Math.min(c.canvas.width, Math.ceil(x1) + 2) - x;
    const h = Math.min(c.canvas.height, Math.ceil(y1) + 2) - y;
    if (!(w > 0 && h > 0) || w * h > FADE_MAX_PIXELS) return null;
    return { x, y, w, h, m: M };
  }
}

/** The four transform ops a unit's frame is built from — on a canvas, or on a matrix that measures it. */
type Frame2D = Pick<CanvasRenderingContext2D, "translate" | "rotate" | "scale">;

function matrixFrame(m: DOMMatrix): Frame2D {
  return {
    translate: (x, y) => void m.translateSelf(x, y),
    rotate: (radians) => void m.rotateSelf((radians * 180) / Math.PI),
    scale: (x, y) => void m.scaleSelf(x, y),
  };
}

/** A text block's fade buffer: where it sits on the canvas, and the block's own transform there. */
interface FadeRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  m: DOMMatrix;
}

/** Past this a fade paints straight through (16 MP — an 8K title, more than any screen). */
const FADE_MAX_PIXELS = 4096 * 4096;
/** Buffers past this are not kept for reuse: one huge title must not pin its pixels for the session. */
const FADE_KEEP_PIXELS = 2048 * 2048;
/** A block and one run inside it are in use at once; a few spare cover a nested draw. */
const fadePool: HTMLCanvasElement[] = [];

/** A cleared buffer the size of `r`, already in the block's frame. */
function takeFadeBuffer(r: FadeRegion): CanvasRenderingContext2D | null {
  const canvas = fadePool.pop() ?? document.createElement("canvas");
  if (canvas.width < r.w || canvas.height < r.h) {
    canvas.width = Math.max(canvas.width, r.w);
    canvas.height = Math.max(canvas.height, r.h);
  }
  const c = canvas.getContext("2d");
  if (!c) return null;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
  c.clearRect(0, 0, r.w, r.h);
  c.setTransform(r.m.a, r.m.b, r.m.c, r.m.d, r.m.e - r.x, r.m.f - r.y);
  c.textAlign = "left";
  c.textBaseline = "alphabetic";
  return c;
}

/**
 * Lay a finished buffer onto `target` at `alpha`, then give it back. `onCanvas`:
 * `target` is the real canvas (the buffer goes at the region's place); else it
 * is the block's own buffer, which starts at the region's corner.
 */
function compositeFadeBuffer(target: CanvasRenderingContext2D, buffer: CanvasRenderingContext2D, r: FadeRegion, alpha: number, onCanvas: boolean): void {
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = Math.max(0, Math.min(1, alpha));
  target.drawImage(buffer.canvas, 0, 0, r.w, r.h, onCanvas ? r.x : 0, onCanvas ? r.y : 0, r.w, r.h);
  target.restore();
  const canvas = buffer.canvas;
  if (canvas.width * canvas.height <= FADE_KEEP_PIXELS && fadePool.length < 4) fadePool.push(canvas);
  else canvas.width = canvas.height = 0;
}

/** Does any paint in these units blend with what is beneath the text (and so cannot be buffered)? */
function blendsWithBackdrop(units: readonly { g: LaidGlyph }[], paints: GlyphPaints): boolean {
  return units.some(({ g }) => {
    const p = paints.at(g.graphemeIndex);
    return p.fills.some((f) => f.blendMode !== "normal") || p.visibleStrokes.some((s) => s.blendMode !== "normal");
  });
}


/**
 * Two glyphs animate as ONE piece when their pose is identical — same offset,
 * same scale, same spin, same fade.
 *
 * That is what breaks a highlight pill or an underline into runs. Splitting on
 * the unit instead would cut a static clip's continuous pill into one pill per
 * word (each wearing its own padding, so gaps appear where there were none);
 * splitting on nothing at all is what left a badge's pill sitting at full size
 * while the words inside it scaled in. Identical poses cover both: a static
 * clip is one run because every glyph is at rest, and an animating one splits
 * exactly where the motion actually differs.
 */
/** Put the canvas in a run's animated frame — the same pivot its glyphs use. */
function enterRunPose(ctx: CanvasRenderingContext2D, vis: GlyphVisual, pivotX: number, baselineY: number): void {
  ctx.translate(pivotX + vis.dx, baselineY + vis.dy);
  if (vis.rotation !== 0) ctx.rotate((vis.rotation * Math.PI) / 180);
  if (vis.scale !== 1) ctx.scale(vis.scale, vis.scale);
  ctx.translate(-pivotX, -baselineY);
}

/** Draw underline / strikethrough lines over runs of glyphs sharing a decoration. */
function drawDecorationRuns(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  visuals: GlyphVisual[],
  visualsByLaidOrder: boolean,
  poseOpacity: number,
  resolve: ColorResolver,
  pivotsX: number[] | null = null,
) {
  let run:
    | { decoration: "underline" | "strikethrough"; color: string; startX: number; endX: number; line: number; y: number; fontSize: number; vis: GlyphVisual; pivotX: number }
    | null = null;

  const flush = () => {
    if (!run) return;
    // Underline sits just below the baseline; strikethrough crosses the x-height.
    const yy = run.y + (run.decoration === "underline" ? run.fontSize * 0.12 : -run.fontSize * 0.3);
    ctx.save();
    ctx.globalAlpha = Math.min(1, run.vis.opacity * poseOpacity);
    enterRunPose(ctx, run.vis, run.pivotX, run.y);
    ctx.strokeStyle = resolve(run.color);
    ctx.lineWidth = Math.max(1, run.fontSize * 0.055);
    ctx.beginPath();
    ctx.moveTo(run.startX, yy);
    ctx.lineTo(run.endX, yy);
    ctx.stroke();
    ctx.restore();
    run = null;
  };

  for (let i = 0; i < layout.glyphs.length; i++) {
    const g = layout.glyphs[i]!;
    const vis = (visualsByLaidOrder ? visuals[i] : visuals[g.graphemeIndex]) ?? GLYPH_IDENTITY;
    const dec = g.style.decoration;
    if (dec === "none" || g.char === "\n" || /^\s+$/.test(g.char) || vis.opacity <= 0.01) {
      flush();
      continue;
    }
    if (
      run &&
      (run.line !== g.line ||
        run.decoration !== dec ||
        run.color !== g.style.color ||
        !samePose(run.vis, vis))
    ) {
      flush();
    }
    if (!run) {
      run = {
        decoration: dec,
        color: g.style.color,
        startX: g.x,
        endX: g.x + g.width,
        line: g.line,
        y: g.y,
        fontSize: g.style.fontSize,
        vis,
        pivotX: pivotsX ? pivotsX[i]! : g.x + g.width / 2,
      };
    } else {
      run.endX = g.x + g.width;
      run.fontSize = Math.max(run.fontSize, g.style.fontSize);
    }
  }
  flush();
}

/**
 * THE TRAVELLING PILL, as the painter needs it: two grapheme spans and how far
 * between them. Grapheme spans rather than cues, because a painter has no
 * business knowing what a cue is — and the inline editor, which lays out the
 * same text, can hand over the same shape.
 */
interface PillTravel {
  from: { start: number; end: number } | null;
  to: { start: number; end: number };
  t: number;
}

/** A pill the travel pass may fade — `alpha` absent means "solid", as drawn normally. */
type TravelPill = HighlightPill & { alpha?: number };

function drawHighlightRuns(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  anim: GlyphAnim,
  poseOpacity: number,
  resolve: ColorResolver,
  travel: PillTravel | null = null,
) {
  // The RECT is layout's answer (so the inline editor draws the same one) and
  // so are the two DRAWING rules that break a run — through `paintedRunRules`,
  // because the buffer this pass paints into was sized by walking exactly these
  // pills. Break them differently here and the difference is a clipped pill.
  const rules = paintedRunRules(anim);
  // TRAVEL: the spoken word's pill is not drawn where the spoken word is — it
  // is drawn sliding in from the word before it. So the pill over the target
  // span is suppressed in the normal pass and painted once, lerped, below.
  const moving = travel ? travellingPills(layout, travel) : [];
  const pills: TravelPill[] = highlightPills(
    layout,
    moving.length > 0
      ? {
          ...rules,
          // Both ENDS of the crossing are hidden in the normal pass: the target
          // because its pill is the one arriving, the source because a pill
          // fading out where the word is no longer spoken would otherwise be
          // drawn twice — once solid by the run, once fading by the travel.
          visible: (i) =>
            rules.visible?.(i) !== false &&
            !inSpan(layout, i, travel!.to) &&
            !(travel!.from && inSpan(layout, i, travel!.from)),
        }
      : rules,
  );
  pills.push(...moving);
  for (const p of pills) {
    const h = p.highlight;
    const vis = anim.visualAt(p.start);
    ctx.save();
    ctx.globalAlpha = Math.min(1, vis.opacity * poseOpacity * (p.alpha ?? 1));
    // The pill rides its run's pose. Left alone it was drawn at full size under
    // words that were scaling in, so a badge grew INSIDE a pill that had never
    // moved — the "it doesn't come from the centre" everyone could see and
    // nobody could name.
    enterRunPose(ctx, vis, anim.pivotXAt(p.start), p.baselineY);
    ctx.fillStyle = resolve(h.color);
    roundRect(ctx, p.x, p.y, p.width, p.height, { tl: h.radius, tr: h.radius, br: h.radius, bl: h.radius });
    ctx.fill();
    ctx.restore();
  }
}

/** Is this laid glyph inside a grapheme span? */
function inSpan(layout: TextLayout, i: number, span: { start: number; end: number }): boolean {
  const gi = layout.glyphs[i]!.graphemeIndex;
  return gi >= span.start && gi < span.end;
}

/**
 * The spoken word's pill, LERPED from where it was to where it is going.
 *
 * Two rules, and both are about what a pill on a page can plausibly do:
 *
 *  - a different LINE is a cut, not a slide. A pill flying diagonally across a
 *    paragraph reads as a bug however smooth the curve is, so the pill simply
 *    appears on the new word — which is exactly what a teleprompter does.
 *  - the pill takes the TARGET's look (colour, radius, padding) throughout, so
 *    a slide never half-paints two palettes.
 *
 * Null when the target span has no ink — a cue over whitespace, which has no
 * pill to move.
 */
function travellingPills(layout: TextLayout, travel: PillTravel): TravelPill[] {
  const toIndex = layout.glyphs.findIndex((g) => g.graphemeIndex >= travel.to.start && g.graphemeIndex < travel.to.end);
  if (toIndex < 0) return [];
  const highlight = layout.glyphs[toIndex]!.style.highlight;
  if (!highlight) return [];
  const to = spanPill(layout, travel.to.start, travel.to.end, highlight);
  if (!to) return [];
  if (!travel.from || travel.t >= 1) return [to];
  const from = spanPill(layout, travel.from.start, travel.from.end, highlight);
  if (!from) return [to];

  // A LINE BREAK is a crossfade, not a slide: the old pill goes out where it
  // stands while the new one comes up where it belongs, on the same curve and
  // in the same time. Sliding would send it diagonally back across the whole
  // paragraph, which reads as a bug however smooth the easing is.
  if (from.line !== to.line) {
    return [
      { ...from, alpha: 1 - travel.t },
      { ...to, alpha: travel.t },
    ];
  }

  const mix = (a: number, b: number) => a + (b - a) * travel.t;
  return [
    {
      ...to,
      x: mix(from.x, to.x),
      y: mix(from.y, to.y),
      width: mix(from.width, to.width),
      height: mix(from.height, to.height),
      baselineY: mix(from.baselineY, to.baselineY),
    },
  ];
}

/** True when any corner is rounded — gates the (cheap-when-square) box clip. */
function hasCornerRadius(r: CornerRadius): boolean {
  return r.tl > 0 || r.tr > 0 || r.br > 0 || r.bl > 0;
}

/** A rounded-rect path with independent per-corner radii (Figma). Each corner is
 *  clamped to half the shorter side, matching the on-stage handle limit. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: CornerRadius,
) {
  const max = Math.min(w, h) / 2;
  const tl = Math.min(Math.max(0, r.tl), max);
  const tr = Math.min(Math.max(0, r.tr), max);
  const br = Math.min(Math.max(0, r.br), max);
  const bl = Math.min(Math.max(0, r.bl), max);
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}
