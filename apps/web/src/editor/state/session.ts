"use client";

import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { type ApiSession, type ScopeAddress } from "@solomotion/core";
import {
  DEFAULT_GUIDE_COLOR,
  DEFAULT_GUIDE_STYLE,
  DEFAULT_VIEWPORT_SNAP,
  flipbookInContext,
  type BrushEngine,
  type EdgeRef,
  type GuideStyle,
  type LibrarySnapshot,
  type RulerUnit,
  type ViewportSnapSettings,
} from "@solomotion/core";
import {
  INITIAL_BUDGET,
  INITIAL_PREVIEW_RESOLUTION,
  MOTION_BLUR_LADDER,
  PREVIEW_RESOLUTIONS,
  resolutionWeight,
  closeRun,
  openingTier,
  playsLive,
  type TierMemory,
  resolvePreviewResolution,
  observeFrame,
  budgetFor,
  playheadInFrame,
  seekInFrame,
  rememberedPlayheadMs,
  type BudgetState,
  type PreviewQuality,
  type PreviewResolutionBudget,
  type PreviewResolutionDecision,
  type PreviewResolutionSetting,
  type PreviewResolution,
  type TransportState,
} from "@solomotion/core";
import { type ModifierKey } from "./drag-modifiers";

/**
 * The governor's recovery counter. Module-scoped rather than stored in the
 * session because it is scratch arithmetic, not state any surface reads —
 * putting it in the store would re-render the whole stage once per frame to
 * carry a number nobody looks at.
 */
const motionBlurRecovery = { frames: 0 };
/** The regime the last reported frame belonged to — see `reportFrameCost`. */
let lastTransport: TransportState | null = null;
/**
 * The resolution governor's regime, as a BOOLEAN: is the transport moving?
 *
 * Not the three-way `TransportState` the shutter uses, and the difference is
 * load-bearing. Scrubbing and playing are one regime here, because the
 * pre-render fills the cache while the playhead sweeps (which reads as
 * scrubbing) and playback then reads those frames back. Treating the handover
 * as a regime change would re-pick the tier between the two, and a different
 * tier is a different picture of every instant — so the range that had just
 * been built would be thrown away at the exact moment it was about to pay off.
 */
let lastPreviewRunning: boolean | null = null;
/**
 * EACH COMP'S TIER MEMORY (core `TierMemory`): the tier a run of it has proven,
 * the one a probe failed at, and what a frame costs at the proven one. A run
 * used to open from the PREVIOUS run's cost, whatever comp that was — one slow
 * cover put every later run of every comp at an eighth, and a run only ever
 * steps down. A run's cost is a property of what is playing; keyed so.
 */
const tierMemory = new Map<string, TierMemory>();
/** The run in progress: where it opened, how far it may fall, where it is. */
let openRun: { compId: string; opened: PreviewResolution; floor: PreviewResolution; at: PreviewResolution; measuredMs: number } | null = null;
/**
 * A RUN'S FIRST MOMENT IS ITS CACHES FILLING. A new tier is a new raster
 * scale, so every buffer is keyed afresh and the first frames render cold —
 * twelve boiled hills, three drawings each, at once. The governor stepped down
 * on those frames (a scene that plays in 9 ms dropped from a quarter to an
 * eighth 300 ms in) and a run never steps back up. It waits this long before
 * judging; a comp that is genuinely too slow still drops, a second later.
 */
const RUN_WARMUP_MS = 1200;
let runStartedMs = 0;
/**
 * THE RUN'S LAST FRAMES, as measured at the tier in force — the in-run verdict
 * is their MEDIAN. An exponential average seeds itself from its first sample,
 * so one 380 ms frame right after the warm-up (a cache miss, a GC) decided the
 * whole run; a median needs most of a window to be slow.
 */
const runSamples: number[] = [];
const RUN_WINDOW = 7;
const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
import { peekDoc } from "./document-context";
import { toast } from "@/lib/toast";
import {
  EMPTY_NAV,
  contextOf,
  EMPTY_TIME_AXES,
  enterLeafNav,
  enterNav,
  exitNav,
  jumpNav,
  navProjection,
  navigateNav,
  openRootNav,
  playheadForNav,
  type EditLeaf,
  type LeafMode,
  type NavState,
} from "./navigation";
import type { TimeAxes } from "../timeline/time-axes";

/**
 * Ephemeral editor state — everything that should NOT be undoable or exported:
 * tool, selection, playhead, playback, zoom, edit mode, panel tabs.
 */

import type { LeftTab } from "../panels/panel-registry";
import { CHROME_EDGES, type ChromeEdge } from "../stage/chrome-layout";
import { purgeResolutionBound } from "../cache/cache-status";

/** See `pendingNewLane`. */
/**
 * A pose-lane block, by where it is and who decided it — resolved against the
 * lane each time it is read, so it follows the block through regeneration.
 */
export interface PoseBlockRef {
  groupId: string;
  setId: string;
  /** A comp instant inside the block. */
  atMs: number;
  /** The behavior that made it (absent: your keys or the resting pose). */
  behaviorId?: string;
}

export interface PendingNewLane {
  edge: "top" | "bottom";
  /** The group whose band edge this is; null = the comp's own stack. */
  scope: string | null;
  clips: { startMs: number; durationMs: number; row: number }[];
}

export type Tool =
  | "select"
  | "hand"
  | "text"
  | "frame"
  | "rect"
  | "ellipse"
  | "triangle"
  | "polygon"
  | "star"
  | "pen"
  | "cut"
  | "brush"
  | "eraser"
  | "fill"
  | "lasso"
  | "wand"
  /** Builds a rig's skeleton (`rig/RigOverlay.tsx`): every other tool poses it. */
  | "bone";

/** Tools that draw a parametric shape by dragging. */
export const SHAPE_TOOLS = ["rect", "ellipse", "triangle", "polygon", "star"] as const;
export type ShapeTool = (typeof SHAPE_TOOLS)[number];
export function isShapeTool(tool: Tool): tool is ShapeTool {
  return (SHAPE_TOOLS as readonly string[]).includes(tool);
}

/**
 * The drawing tools (Procreate section of the toolbar). They paint through
 * the DrawingOverlay — which owns the pointer while one is armed — into
 * raster surfaces (pixel layers) or path clips (vector layers).
 */
export const DRAWING_TOOLS = ["brush", "eraser", "fill", "lasso", "wand"] as const;
export type DrawingTool = (typeof DRAWING_TOOLS)[number];
export function isDrawingTool(tool: Tool): tool is DrawingTool {
  return (DRAWING_TOOLS as readonly string[]).includes(tool);
}

/**
 * Tool categories — groups of interchangeable tools that share one toolbar
 * slot. A category is the single source of truth for two affordances at
 * once: the slot's "remember last tool" flyout AND right-clicking ANY member
 * to jump between the others. Adding a new grouped tool later is a one-line
 * addition here — nothing else needs to know about it.
 */
export const TOOL_CATEGORIES: Record<string, readonly Tool[]> = {
  shape: SHAPE_TOOLS,
  // Free lasso ↔ auto (magic-wand) lasso share one slot, like the shapes.
  lasso: ["lasso", "wand"],
};

/** The other tools in `tool`'s category (empty if it belongs to none/one). */
export function categorySiblings(tool: Tool): readonly Tool[] {
  for (const members of Object.values(TOOL_CATEGORIES)) {
    if ((members as readonly Tool[]).includes(tool)) return members;
  }
  return [];
}

export interface TextSelection {
  /** Grapheme indices into the editing clip's text; start === end means caret only. */
  start: number;
  end: number;
}

/**
 * What a drag out of a panel SHOWS while it is in the air — the picture the
 * ghost carries and the stage's drop box frames. An SVG is the honest preview
 * for artwork that IS an SVG (an icon); a rendered bitmap covers everything
 * else. Optional: a drag with none shows its label.
 */
export type DragPreview =
  | { kind: "svg"; markup: string; width: number; height: number }
  | { kind: "image"; url: string; width: number; height: number };

/**
 * Payload while dragging out of a panel.
 *
 * `snapshot` is the one arm that carries CLIPS rather than a reference to
 * something the app already knows: a saved component from the library, an
 * icon from the icons plugin, anything a panel can turn into layers. The id
 * resolves through `resolveDragSnapshot` (state/snapshot-drag.ts) — so a new
 * panel that wants to drop layers registers a snapshot and drags it, and every
 * receiver (stage, timeline, layers) already knows what to do.
 */
export type LibraryDrag =
  | {
      kind: "anim" | "template" | "media" | "component" | "transition";
      id: string;
      label: string;
    }
  | {
      kind: "snapshot";
      id: string;
      label: string;
      preview?: DragPreview;
    }
  | null;

/**
 * Which editor surface a library drag is currently hovering (drives previews).
 * One name per surface that can RECEIVE a drop, so the hover preview and the
 * release routing read the same answer instead of each re-deriving it.
 */
export type DragSurface = "stage" | "timeline" | "layers" | null;

/** What the timeline magnet snaps to, and how eagerly (px at current zoom). */
export interface SnapSettings {
  thresholdPx: number;
  toClips: boolean;
  toPlayhead: boolean;
  toKeyframes: boolean;
}

const SNAP_STORAGE_KEY = "tm-snap-settings";

function loadClipPreviews(): boolean {
  try {
    return localStorage.getItem("tm-clip-previews") !== "0";
  } catch {
    return true;
  }
}

function loadAutoDeleteEmptyTracks(): boolean {
  try {
    return localStorage.getItem("tm-auto-del-tracks") !== "0";
  } catch {
    return true;
  }
}

function loadBrushHandle(): boolean {
  try {
    return localStorage.getItem("tm-brush-handle") !== "0";
  } catch {
    return true;
  }
}

function loadPixelGrid(): boolean {
  try {
    return localStorage.getItem("tm-pixel-grid") !== "0";
  } catch {
    return true;
  }
}

/**
 * The motion-blur preview dial. Defaults to `auto`, deliberately NOT to off.
 *
 * Off-by-default is the tempting choice and the wrong one: you would never see
 * the blur while working and the export would surprise you, which is the worst
 * thing a motion tool can do. `auto` is free where it matters — parked on a
 * frame it renders at full quality, which costs one render the stage was doing
 * anyway — and steps down on its own during playback, where the detail is
 * imperceptible regardless.
 */
function loadMotionBlurQuality(): PreviewQuality | "auto" {
  try {
    const v = localStorage.getItem("tm-motion-blur");
    return v === "off" || v === "fast" || v === "full" ? v : "auto";
  } catch {
    return "auto";
  }
}

/**
 * PREVIEW RESOLUTION, persisted — the machine you are sitting at, not the
 * project. `auto` is the default for the reason spelled out in
 * `core/preview/resolution.ts`: both fixed answers are wrong, one on heavy
 * documents and one on light ones.
 */
function loadPreviewResolution(): PreviewResolutionSetting {
  try {
    const v = localStorage.getItem("tm-preview-resolution");
    return v === "full" || v === "half" || v === "quarter" || v === "eighth" ? v : "auto";
  } catch {
    return "auto";
  }
}

/** Off by default, and it should stay that way — see `holdWhilePaused`. */
function loadHoldPreviewQuality(): boolean {
  try {
    return localStorage.getItem("tm-hold-preview-quality") === "1";
  } catch {
    return false;
  }
}

function loadFocusStage(): boolean {
  try {
    return localStorage.getItem("tm-focus-stage") !== "0";
  } catch {
    return true;
  }
}

function loadFocusTime(): boolean {
  try {
    return localStorage.getItem("tm-focus-time") !== "0";
  } catch {
    return true;
  }
}

function loadDragOutModifier(): ModifierKey {
  try {
    const v = localStorage.getItem("tm-drag-out-mod");
    if (v === "meta" || v === "alt" || v === "shift") return v;
  } catch {
    // storage unavailable — fall through to the default
  }
  return "meta";
}

function loadNativeResizeLockAspect(): boolean {
  try {
    // Native geometry (shape/text/pen — dashed handles) resizes FREE by default.
    return localStorage.getItem("tm-native-ar-lock") === "1";
  } catch {
    return false;
  }
}

function loadScaleLockAspect(): boolean {
  try {
    // A true transform SCALE (image/video/nested/group — solid handles) keeps
    // aspect by default; ⇧ frees it.
    return localStorage.getItem("tm-scale-ar-lock") !== "0";
  } catch {
    return true;
  }
}

function loadScaleLockAspectOverride(): boolean | null {
  try {
    const raw = localStorage.getItem("tm-scale-ar-lock-override");
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // storage unavailable — the session value still applies
  }
  return null;
}

function loadSnapSettings(): SnapSettings {
  const fallback: SnapSettings = { thresholdPx: 10, toClips: true, toPlayhead: true, toKeyframes: true };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(SNAP_STORAGE_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<SnapSettings>) } : fallback;
  } catch {
    return fallback;
  }
}

const GUIDE_STORAGE_KEY = "tm-guide-settings";
const GUIDES_ON_KEY = "tm-guides-on";

function loadGuideSettings(): ViewportSnapSettings {
  if (typeof window === "undefined") return DEFAULT_VIEWPORT_SNAP;
  try {
    const raw = window.localStorage.getItem(GUIDE_STORAGE_KEY);
    return raw ? { ...DEFAULT_VIEWPORT_SNAP, ...(JSON.parse(raw) as Partial<ViewportSnapSettings>) } : DEFAULT_VIEWPORT_SNAP;
  } catch {
    return DEFAULT_VIEWPORT_SNAP;
  }
}

function loadGuidesOn(): boolean {
  try {
    return typeof window === "undefined" ? true : window.localStorage.getItem(GUIDES_ON_KEY) !== "0";
  } catch {
    return true;
  }
}

const RULERS_ON_KEY = "tm-rulers-on";
const RULER_UNIT_KEY = "tm-ruler-unit";
const MOTION_PATHS_KEY = "tm-motion-paths";
const RULER_GUIDES_KEY = "tm-ruler-guides";

/**
 * Are the guide LINES drawn? Independent of the rulers, deliberately.
 *
 * Turning the rulers off used to leave every guide on the canvas with no
 * control anywhere that could hide them — the rulers are how you MAKE a guide
 * (drag one off the strip), not what a guide is, and conflating the two leaves
 * you able to create something you cannot then put away.
 *
 * Figma, Illustrator and Photoshop all separate them for the same reason, and
 * all three default to visible: a guide you placed and cannot see is worse than
 * one you can.
 */
function loadRulerGuidesOn(): boolean {
  try {
    return typeof window === "undefined" ? true : window.localStorage.getItem(RULER_GUIDES_KEY) !== "0";
  } catch {
    return true;
  }
}

function loadMotionPathsOn(): boolean {
  try {
    return typeof window === "undefined" ? true : window.localStorage.getItem(MOTION_PATHS_KEY) !== "0";
  } catch {
    return true;
  }
}

function loadRulersOn(): boolean {
  try {
    return typeof window === "undefined" ? false : window.localStorage.getItem(RULERS_ON_KEY) === "1";
  } catch {
    return false;
  }
}

function loadRulerUnit(): RulerUnit {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(RULER_UNIT_KEY);
    return raw === "pt" || raw === "mm" || raw === "cm" || raw === "in" ? raw : "px";
  } catch {
    return "px";
  }
}

const GUIDE_COLOR_KEY = "tm-guide-default-color";
const GUIDE_STYLE_KEY = "tm-guide-default-style";

function loadGuideDefaultColor(): string {
  try {
    return (typeof window === "undefined" ? null : window.localStorage.getItem(GUIDE_COLOR_KEY)) ?? DEFAULT_GUIDE_COLOR;
  } catch {
    return DEFAULT_GUIDE_COLOR;
  }
}

function loadGuideDefaultStyle(): GuideStyle {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(GUIDE_STYLE_KEY);
    return raw === "dashed" || raw === "dotted" ? raw : DEFAULT_GUIDE_STYLE;
  } catch {
    return DEFAULT_GUIDE_STYLE;
  }
}

const TOOLBAR_DOCK_KEY = "tm-toolbar-dock";

/**
 * Where the tool rail lives. Two placements, not eight: a left rail (the
 * default — it leaves the bottom edge clear of the timeline for good) or a
 * bottom bar. The free-form 8-anchor drag it replaces cost a pixel collision
 * solver, a grip handle that sat on the first tool, and a stream of states
 * nobody chose on purpose. Every reference tool ships exactly these two.
 */
/**
 * Which EDGE of the stage the tool rail docks to. It is a `ChromeEdge` rather
 * than a private union because the stage's chrome layout already lays a capsule
 * out from its edge — the axis it runs on, the side its flyouts open, where
 * along the edge it sits. A second two-value union here would be a fact the
 * layout already owns, kept in a place that can disagree with it.
 */
export type ToolbarPlacement = ChromeEdge;

function loadToolbarPlacement(): ToolbarPlacement {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(TOOLBAR_DOCK_KEY);
    // The tools float at the bottom of the stage by default (Figma's shape);
    // a dock someone chose is kept.
    return CHROME_EDGES.includes(raw as ChromeEdge) ? (raw as ChromeEdge) : "bottom";
  } catch {
    return "bottom";
  }
}

/**
 * Which paint a gradient is being edited on. Unified: `target` is the paint list
 * (`fill`/`stroke`) and `id` the entry id — resolves the same on ANY visual clip
 * (shape, text, image…), since they all share the same fills/strokes lists.
 */
export interface PaintTarget {
  clipId: string;
  target: "fill" | "stroke";
  id: string;
}

/** An editor that owns ⌘Z while it is open (see `undoScope`). */
/**
 * A workspace surface that can hold keyboard context. One union, here, because
 * it is a fact about the session — `panel-focus.ts` re-exports it beside the
 * hook that writes it. It was written out by hand in three places, and the
 * third one was always the one that had not learned about the newest panel.
 */
export type WorkspacePanel = "canvas" | "timeline" | "sheet" | "curves" | "media";

export interface UndoScope {
  undo: () => boolean;
  redo: () => boolean;
}

interface SessionState {
  playheadMs: number;
  playing: boolean;
  muted: boolean;

  tool: Tool;

  /**
   * Per-frame "last used brush engine" memory (drawing/DrawingOverlay).
   * A frame — including each flipbook cell, which IS its own drawing-role
   * frame — remembers its own pixel/vector choice once set, instead of a
   * single global value re-guessed from whatever's currently selected
   * (which made engine look like it randomly flipped between cells).
   * Session-scoped: reset per document, never persisted or shared across
   * projects — frame ids are only meaningful within one doc.
   */
  brushEngineByFrame: Record<string, BrushEngine>;
  setBrushEngineForFrame: (frameId: string, engine: BrushEngine) => void;

  selectedClipIds: string[];
  /**
   * Selected frames (artboards) — mutually exclusive with clip selection.
   * Multiple frames can be selected (⇧-click / marquee on empty canvas). The
   * LAST entry is the "primary" (drives activeFrameId + the inspector).
   */
  selectedFrameIds: string[];
  /**
   * THE navigation state — where you are and what you're editing. Canonical;
   * every field below marked "projection of `nav`" is derived from it by
   * `navProjection` and written by nothing else. See state/navigation.ts.
   */
  nav: NavState;

  /**
   * PROJECTION of `nav`. The OPEN composition: the timeline shows this frame's
   * clips, new layers land here, and the playhead is local time inside it.
   * Read freely; never assign — navigate instead (`openTimeline`, `enterClip`,
   * `jumpToDepth`, `revealFrame`), or the breadcrumb and the timeline will
   * describe two different places, which is exactly the class of bug the
   * canonical path exists to make impossible.
   */
  activeFrameId: string | null;
  /**
   * The tracker the stage overlay is editing, if any. SESSION state rather than
   * document state: which track you are adjusting is a mode you are in, like a
   * tool, not something a file should reopen in. Null = no track overlay.
   */
  activeTrackerId: string | null;
  setActiveTracker: (id: string | null) => void;

  /**
   * PROJECTION of `nav`. Whose TIME AXIS the bottom region is showing — the
   * flipbook when one (or a cell drawing of one) is open, the comp you stand in
   * otherwise. It is the key `zoomBySurface` is stored under; a stored "current
   * surface" would be a second fact able to disagree with where you are.
   */
  timeSurfaceId: string;
  /** PROJECTION of `nav`. The axes that surface opens at (see time-axes.ts). */
  timeSurfaceDefaults: TimeAxes;

  /**
   * Which workspace panel last took focus — canvas or timeline. Arrow-key
   * gestures (keyboard-nav.ts) route to the focused panel: on the canvas they
   * nudge the selected layer / scrub the playhead; in the timeline they scrub,
   * scroll lanes, jump between clip edges, or move the selected clip. Set on
   * pointer-down in each panel; canvas is the default so shortcuts work before
   * anything is touched.
   */
  focusedPanel: WorkspacePanel;

  /**
   * A request to open the unified easing popover at a screen point (the E
   * shortcut over selected keyframes — any panel). Null = closed. The overlay
   * component renders it and applies the picked easing to every selected key.
   */
  easingPopoverAt: { x: number; y: number } | null;

  /**
   * The clip-edge DECORATION selected on the timeline — a layer animation, a
   * text (glyph) animation, or a cut transition. All three are one idea to the
   * user (see core `clip-edges.ts`), so they share ONE slot: Delete removes the
   * decoration rather than the clip, and ⌘C/⌘X/⌘V act on it whichever kind it
   * is. Two slots meant two branches everywhere and a state where both could be
   * set at once. Cleared on any clip-selection change.
   */
  selectedEdgeDecor: EdgeRef | null;

  /**
   * An EMPTY flipbook-sheet slot picked as the paste target — a void isn't a
   * clip, so it can't live in `selectedClipIds`. Click a void to set this
   * (clearing normal selection); any real selection change clears it back.
   * ⌘V / "Paste here" read it to land pasted frames exactly on the slot the
   * user aimed at, in any row.
   */
  selectedFlipbookVoid: { flipbookId: string; trackId: string; ms: number } | null;

  /**
   * A SPOT ON A LANE — where you pressed on empty timeline space. It is the
   * one selection the lanes' background can hold, and it means two things at
   * once, both derived at the moment they are used:
   *
   *  · the TARGET LANE: a paste, a new layer, a dropped preset lands on this
   *    track (`placeAboveSelection`) — Premiere's targeted track, without a
   *    second control for it. Clicking a lane IS aiming at it.
   *  · a GAP, when the spot lies in a hole between clips: Delete closes it,
   *    the way every NLE lets you pick a hole and press Delete.
   *
   * A POSITION, never an object: the hole's edges are re-read from the document
   * (core `trackGaps`) when the edit runs, so it survives an undo, a drag
   * elsewhere, or a trim that changed its size. It lives beside the other
   * selections rather than inside `selectedClipIds` for the reason a void does:
   * it is not a clip. Selecting anything else clears it, and it clears
   * everything else — one selection at a time.
   */
  laneSpot: { trackId: string; frameId: string; startMs: number } | null;
  setLaneSpot: (spot: { trackId: string; frameId: string; startMs: number } | null) => void;

  /**
   * PROJECTION of `nav.leaf`: the clip in on-stage CROP mode (its four crop
   * edges show as draggable handles with the cropped-away areas faded,
   * Figma-style). These four interior editors are mutually exclusive by
   * construction now — one `leaf`, one mode — instead of four independent
   * nullable fields with sixteen combinations of which five were legal.
   */
  cropClipId: string | null;

  /**
   * PROJECTION of `nav.leaf`: the clip in PIVOT mode — its anchor point shows as
   * a draggable crosshair that can be placed anywhere, including outside the
   * layer. Modal for the same reason crop is: the pivot sits in the middle of
   * the layer, right where you drag to move it, so a always-live handle would
   * be grabbed by accident constantly. Double-click the crosshair to enter.
   */
  pivotClipId: string | null;

  /**
   * PROJECTION of `nav.leaf`: the clip whose CONTENTS are being edited (text
   * caret, vector nodes, shape corners, crop). Layer-level chrome hides while
   * it is set — see `NavProjection`.
   */
  contentEditClipId: string | null;

  /**
   * Timeline tabs (Resolve-style): comps the user has opened, in tab order.
   * The active comp always shows even if it isn't pinned here.
   */
  openTimelineIds: string[];
  /**
   * PINNED tabs — always shown, ordered first, and immune to "close others".
   * A pin is the user saying "this timeline stays open no matter where I
   * navigate", so it survives page/frame switches like every open tab does.
   */
  pinnedTimelineIds: string[];
  /**
   * When true, the tab strip only shows timelines whose comp lives on the
   * ACTIVE page (pinned tabs always show). Off by default — tabs are global,
   * so drilling/paging never rearranges the strip out from under you.
   */
  tabsFollowActivePage: boolean;
  /**
   * PROJECTION of `nav.path`: the ancestors stepped through, root-first, each
   * with the nested clip entered. Kept in this legacy shape for existing
   * readers; new code should resolve the full `EditContext` instead, which also
   * carries geometry and per-frame times.
   */
  timelinePath: Array<{ frameId: string; clipId: string }>;
  /**
   * Selected keyframe ids (across the selected clip). When non-empty, edit
   * commands (copy/cut/paste/delete) target the KEYFRAMES, not the clip — the
   * timeline marquee sets this when it lands on part of a single clip.
   */
  selectedKeyframeIds: string[];

  /** Selected timeline-marker ids — Delete removes them; click a pin to select. */
  selectedMarkerIds: string[];

  /**
   * Blocks picked on a character's pose lanes (a syllable, a blink, a keyed
   * stretch). PARTS of that character, like an edge decoration: they live as
   * long as it stays selected. The edit verbs act on them first — Split cuts
   * the block under the playhead, Delete clears it — through the same
   * shortcut table as every clip.
   */
  selectedPoseBlocks: PoseBlockRef[];
  setSelectedPoseBlocks: (refs: PoseBlockRef[]) => void;

  /** PROJECTION of `nav.leaf`: the clip in inline text-edit mode. */
  editingClipId: string | null;
  textSelection: TextSelection | null;
  /**
   * WHICH STYLE TARGET the sidebar writes to — the layer, a caption's focused
   * words, or a text span. Session state rather than component state because it
   * has to survive a tab switch: you set the focus colour on Design, then its
   * stroke on Design again and its animation on Animate, without re-choosing.
   *
   * This is a CHOICE, not a fact. `null` — the resting state — means "follow
   * the selection": core's `selectionScope` reads the live span and the
   * playhead and says whether that is the layer, the spoken word or a range.
   * Picking a chip in the scope bar records an explicit choice, which holds
   * only until the selection changes or goes away (`setTextSelection`); there
   * is nothing to remember about a selection that is no longer on screen. A
   * `range` choice is read against the LIVE span, never a stored one.
   */
  scopeAddress: ScopeAddress | null;
  setScopeAddress: (scope: ScopeAddress | null) => void;

  /** PROJECTION of `nav.leaf`: the path clip in Bézier node-edit mode. */
  vectorEditClipId: string | null;

  /**
   * The Bézier nodes selected on the canvas, as `"<subpath>:<point>"` keys.
   *
   * The VectorOverlay OWNS this — it needs the state at pointer rate and does
   * weld-group expansion on every write — and publishes it here so surfaces
   * OUTSIDE the canvas can scope to it. The inspector's Corners row is the
   * first: with nodes selected it rounds those, with none it rounds the object,
   * and neither the row nor the overlay learns anything about the other. Same
   * one-way shape as `navProjection`: exactly one writer, so it cannot drift.
   */
  vectorNodeSelection: readonly string[];
  setVectorNodeSelection: (keys: readonly string[]) => void;

  /**
   * PROJECTION of `nav.leaf`: the parametric SHAPE clip in corner-edit mode —
   * its natural corners become draggable while it stays a shape (rect/polygon/
   * star), never a path.
   */
  shapeEditClipId: string | null;

  /**
   * The paint entry currently open for gradient editing — set when a gradient
   * swatch popover opens. Drives the on-stage gradient handles (drag start/end,
   * stops) so the canvas and the inspector edit the same gradient. `target`
   * distinguishes a vector fill/stroke entry (id = entry id) from a text block
   * fill (`text`, id = ""). Cleared on deselect / solid paint / close.
   */
  activePaint: PaintTarget | null;
  /** The stop whose inline on-canvas color popover is open (null = none). */
  activeGradientStopId: string | null;

  /**
   * THE TIME AXES, PER SURFACE — a memory keyed by the comp whose axis is
   * showing, exactly like `hopsByTab` remembers each tab's drill cursor.
   *
   * There is deliberately NO stored "current pxPerSec". The timeline and the
   * flipbook sheet used to share two global numbers, so they were never really
   * two surfaces: zooming one zoomed the other, every switch between them
   * arrived at a zoom chosen for its neighbour, and the sheet (whose frame is
   * ~83ms wide, not 1000) could not use the shared number honestly at all — it
   * multiplied it by a private 56/90 fudge, which is why "the same zoom axes"
   * stepped at different rates depending on which panel the pointer was over.
   *
   * The live value is DERIVED from this memory plus `timeSurfaceId` (see
   * `timeline/use-time-axes.ts`), so a zoom level and the surface it belongs to
   * cannot fall out of step. A missing entry means "never zoomed": the
   * surface's own default applies.
   */
  zoomBySurface: Record<string, { pxPerSec?: number; laneZoom?: number }>;
  snapping: boolean;
  /**
   * Linked selection (DaVinci's chain-link switch): selecting a clip pulls in
   * its link-group partners so they move/split/delete together. Off = ignore
   * links for selection; the link DATA stays on the clips either way.
   */
  linkedSelection: boolean;
  /** Timeline markers shown + snappable (off hides every marker). */
  markersEnabled: boolean;
  /**
   * Off (default): a comp's ruler shows only ITS OWN markers. On: markers
   * merge across the nesting hierarchy — every ancestor along the current
   * drill path and every descendant nested comp projects its markers onto
   * this ruler too (time-mapped through each clip's speed/loop/trim), so
   * beats/cues placed anywhere in the composition line up everywhere.
   */
  mergeMarkers: boolean;
  /**
   * DaVinci-style in/out working range for the active comp: rendered dimmed
   * outside, playback loops inside it, and export can target just this span.
   * `compId` ties it to the comp it was set in — switching comps hides it (the
   * values are kept until a new range is set). Null = never set.
   */
  workRange: { compId: string; startMs: number; endMs: number } | null;
  /** Master toggle: reveals the in/out controls and activates the range. */
  workRangeEnabled: boolean;
  snapSettings: SnapSettings;
  /** Absolute ms of the currently active snap target (feedback line), if any. */
  snapIndicatorMs: number | null;

  /**
   * CANVAS snapping ("smart guides") — the viewport twin of `snapping`, kept
   * separate so the two magnets toggle independently. `S` flips whichever
   * surface has focus (canvas → guides, timeline → snapping), reusing the same
   * focus-aware routing as the arrow-key gestures.
   */
  guides: boolean;
  /** What the canvas magnet snaps to + how eagerly (persisted). */
  guideSettings: ViewportSnapSettings;
  /** Figma rulers along the canvas top/left edges (persisted). */
  rulers: boolean;
  /** Are the guide LINES drawn on the canvas? Separate from `rulers`, which is
   *  only the strip you drag them off — see `loadRulerGuidesOn`. Persisted. */
  rulerGuides: boolean;
  /** Motion paths on the stage: selected clips' position keyframes drawn as an
   *  editable spatial curve (View menu, persisted, default on). */
  motionPaths: boolean;
  /** Ruler measurement unit (persisted). */
  rulerUnit: RulerUnit;
  /** Default guide colour + line style — used by every guide that has no own
   *  override, so changing these restyles all "plain" guides at once. */
  guideDefaultColor: string;
  guideDefaultStyle: GuideStyle;
  /** Where the tool rail sits — left (default) or bottom. Persisted. */
  toolbarPlacement: ToolbarPlacement;

  /**
   * Live preview of the track(s) a clip drag past the first/last lane would
   * create — set every pointermove while a drag sits in the dead-zone past an
   * edge, cleared the instant it doesn't (dragging back onto a real lane, or
   * releasing). `clips` carries every previewed clip with the RELATIVE new-lane
   * row it lands on (0 = the new lane nearest existing content), so a linked
   * video+audio push spawns two ghost lanes, a single drop just one. Nothing is
   * created until the drop commits (`moveClipsToNewLanes`); read-only feedback.
   *
   * `scope` names WHOSE edge: null is the comp's top/bottom lane, a group id
   * is the first/last row of that group's band — dragging past a band's edge
   * makes a row inside the group, exactly as the comp's edge makes a lane.
   */
  pendingNewLane: PendingNewLane | null;

  /** A trim just stretched a play-once media clip past its footage — the
   * timeline shows the loop-or-stretch prompt for this clip. */
  footageOverrunClipId: string | null;

  /**
   * Show each clip's pictures on the timeline — filmstrips for footage, comps
   * and flipbooks, a thumbnail for images and vector layers (View menu /
   * Settings, persisted, ON by default).
   *
   * A real off switch, not a hide: turning it off frees every cached bitmap
   * and stops all production (`setPostersEnabled`), so a heavy project gets
   * the memory and the decode budget back rather than just a plainer timeline.
   */
  clipPreviews: boolean;

  /** Auto-remove a track once the last clip LEAVES it (drag away / delete).
   * Never touches tracks made empty via "+ Track". Persisted; default on. */
  autoDeleteEmptyTracks: boolean;

  /** The canvas page (Figma-style). Null = the document's first page. */
  activePageId: string | null;

  /** Group the user has entered by double-clicking (Figma semantics). */
  enteredGroupId: string | null;

  /**
   * Every collapsed ROW, across both views: group clips, frames, the audio
   * header, a composite group's role sections.
   *
   * ONE set, because the timeline and the layers panel are two views of one
   * tree. The layers panel used to keep its own `useState`, so a group you
   * opened in one view was still shut in the other and neither was wrong — the
   * classic two-answers bug this codebase keeps paying for. The timeline reads
   * the group ids and ignores the rest; the panel reads all of them.
   */
  collapsedIds: string[];
  toggleCollapsed: (groupId: string) => void;
  setCollapsed: (groupId: string, collapsed: boolean) => void;
  /**
   * Open every row on the way to something — collapse ids unfolded, nested
   * instances peeked — in ONE update, and none at all when they already are.
   * The applying half of core's `treeRevealForClip`; see `selection-reveal.ts`.
   */
  openTreeRows: (collapseIds: readonly string[], nestedIds: readonly string[]) => void;

  /**
   * Characters whose timeline band shows their raw LAYERS instead of their
   * performance (one lane per pose set — `characterLanes`). Parts is the
   * default for any group with pose sets, so only the exceptions are kept.
   */
  characterLayersIds: string[];
  setCharacterLayers: (groupId: string, layers: boolean) => void;

  /** Inspector tab requested from elsewhere (e.g. double-click a caption → "words"). */
  /**
   * The inspector's active tab. It was `useState` inside the inspector, plus a
   * one-shot `inspectorTabRequest` channel so other surfaces could ask it to
   * change — the request channel existed only because the real state was
   * unreachable. Both are replaced by this: the right rail, the cue list and
   * the sound stack all set it directly, and the inspector reads it.
   */
  inspectorTab: InspectorTabId;

  /**
   * A sound CATEGORY opened in the inspector, with the selection it was opened
   * FROM. The category shows only while that exact selection stands, so any
   * new pick — a layer, a frame, nothing — takes the panel back with no
   * clearing code in a dozen selection setters. Derived, not managed.
   */
  inspectedSoundBus: { id: string; clips: readonly string[]; frames: readonly string[] } | null;

  /** Layer effect to scroll to and flash in the inspector (e.g. after "Remove background"). */
  lfxFocusId: string | null;

  /** The property-transfer dialog (copy/paste properties) — null = closed. */
  propertyTransfer: { mode: "copy" | "paste"; clipId: string } | null;

  /** Figma-style pixel grid on the stage past ~4× zoom (View menu, persisted). */
  pixelGrid: boolean;

  /**
   * The stage's brush handle — the Procreate sliders pinned to the canvas edge
   * (persisted, on by default).
   *
   * A preference rather than a mode: it is only ever ON SCREEN while a paint
   * tool is armed (the handle itself asks `usePaintDials`), so an artist who
   * never draws never sees it and never has to turn it off. What this stores is
   * the answer to "I would rather reach for the options bar", which has to
   * survive a reload or it is not a preference at all.
   */
  brushHandle: boolean;

  /**
   * MOTION BLUR IN THE PREVIEW (v56) — the user's ceiling, persisted. `auto`
   * lets the governor pick per frame (full when parked, cheap while playing,
   * lower still if a frame blows its budget); the three explicit tiers pin it.
   *
   * This is the third level of the three-level model and the only one that is
   * NOT in the document, because it describes the machine you are sitting at
   * and not the project. Nothing here can make a layer blur that the comp
   * master or the layer switch has turned off.
   */
  motionBlurQuality: PreviewQuality | "auto";
  /**
   * What the governor actually settled on this frame, and whether IT chose —
   * `degraded` is what turns the stage's shutter chip amber. Session-only and
   * never persisted: it is a measurement, not a preference.
   */
  motionBlurActual: BudgetState;

  /**
   * PREVIEW RESOLUTION (v60) — the user's ceiling, persisted.
   *
   * Applied by the stage as the canvas backing store's DPR, never as
   * `renderScale`: see `core/preview/resolution.ts` for why that distinction is
   * the whole feature and not a detail.
   */
  previewResolution: PreviewResolutionSetting;
  /** What the governor settled on. A measurement, never persisted. */
  previewResolutionActual: PreviewResolutionBudget;
  /**
   * The tier the stage is ACTUALLY rendering at right now — the resolved
   * answer, published so the chip on the canvas reads it instead of working it
   * out again. A control that re-derives a policy is a second implementation of
   * it, and the two disagree the first time either one learns something.
   */
  previewTier: PreviewResolution;
  /**
   * Keep the preview tier while PAUSED instead of snapping back to full.
   *
   * Ships OFF. A still frame is the thing you are judging, so it has to be
   * true; the switch is for projects where that one honest render is seconds
   * long and every pause would stall.
   */
  holdPreviewQuality: boolean;
  /**
   * Pre-rendering the work range into the frame cache: how far it has got,
   * 0..1, or null when nothing is building.
   *
   * A number rather than a boolean because the only acceptable version of
   * "wait, load, then play" is one you can watch and one you can stop.
   */
  prerenderProgress: number | null;
  /**
   * The render-cost HUD. Session-only: it is a debugging lens, and one you want
   * to have to turn on — leaving it on across restarts would mean paying for
   * instrumentation you forgot about, which is how profilers end up lying.
   */
  perfHud: boolean;

  /**
   * Smart focus (Figma "focus on active layer"): selecting exactly one clip
   * or frame pans/zooms it into view — but ONLY when it isn't visible at all
   * already, so it never yanks the camera out from under a deliberate manual
   * zoom/pan. Two independent switches (View menu + Settings, both
   * persisted): `focusStage` frames it on the canvas, `focusTime` scrolls the
   * timeline to it (clips only — a bare frame selection has no time span in
   * the open comp). See `state/selection-reveal.ts`.
   */
  focusStage: boolean;
  focusTime: boolean;

  /**
   * Which modifier, held during a timeline clip drag, RELEASES the clip from
   * its group — without it a drag stays inside the band it started in (past
   * the band's edges it makes new rows there); with it the clip lands on
   * whatever row is under the pointer, any scope. Dropping INTO a group from
   * outside never needs it. Previewed live, committed on drop (Settings →
   * Editing, persisted). Default ⌘/Ctrl (free on the move gesture: ⌥ is
   * duplicate, ⇧ is the vertical lock).
   */
  dragOutModifier: ModifierKey;

  /**
   * Aspect-ratio defaults for on-stage resizing (persisted, Settings → Editing).
   * The two resize families are deliberately independent, and ⇧ always INVERTS
   * whichever default applies:
   *  - `nativeResizeLockAspect` — dashed handles: a shape/text/pen's OWN geometry
   *    (width/height/wrap). Free by default (`false`) so a rectangle stretches to
   *    any proportion; ⇧ locks it.
   *  - `scaleLockAspect` — solid handles: a true transform SCALE (image/video/
   *    nested/group, or any layer under ⌘). Locked by default (`true`) so pixels
   *    never distort; ⇧ frees per-axis.
   */
  nativeResizeLockAspect: boolean;
  scaleLockAspect: boolean;
  scaleLockAspectOverride: boolean | null;

  leftTab: LeftTab;

  /** Live drag payload from the library (presets/templates → canvas/timeline). */
  libraryDrag: LibraryDrag;
  /**
   * Live cursor position (client px) while a library drag is in flight — drives
   * drop previews. `over` is the surface currently under the cursor, so the
   * timeline lane ghost only shows over the timeline and the stage owns its own
   * preview — one source of truth, no more phantom lanes while over the canvas.
   */
  libraryDragPos: { x: number; y: number; over: DragSurface } | null;

  /** Captured selection awaiting the "Add to library" dialog (null = closed). */
  addToLibraryDraft: LibrarySnapshot | null;
  /** The layer the render-in-place dialog is asking about (null = closed). */
  renderInPlaceClipId: string | null;

  /**
   * Keyframe record mode (Figma Motion style). When armed, editing a layer's
   * animatable property writes a keyframe at the playhead instead of the base
   * value — even for a property that has no keys yet.
   */
  recording: boolean;

  /** Modal singletons — openable from anywhere (topbar, palette, menus). */
  exportDialogOpen: boolean;
  /**
   * What the export dialog should open ON (menu items set it before opening):
   * scope picks the target tab (whole frame vs the current selection), medium
   * preselects a format tab (e.g. "lottie" from Export → Lottie…). Null = the
   * dialog's own smart default. Consumed once when the dialog opens.
   */
  exportIntent: { scope: "frame" | "selection"; medium: "image" | "video" | "lottie" | "pdf" | null } | null;
  commandPaletteOpen: boolean;
  settingsDialogOpen: boolean;
  /** The floating Variables window (Figma-style manager). */
  variablesOpen: boolean;
  setVariablesOpen: (open: boolean) => void;
  /** A variable the manager should open ON — set when something elsewhere says
   *  "edit this style". Cleared by the window once it has scrolled to it, so a
   *  later open does not jump back to whatever was last requested. */
  variablesFocusId: string | null;
  revealVariable: (id: string) => void;
  clearVariableFocus: () => void;
  /** The floating Console window (DevTools-style log viewer over the platform log bus). */
  consoleOpen: boolean;
  setConsoleOpen: (open: boolean) => void;
  /** The floating Activity window — what the app is doing, and what froze it. */
  activityOpen: boolean;
  setActivityOpen: (open: boolean) => void;

  setPlayhead: (ms: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  setMuted: (muted: boolean) => void;

  setTool: (tool: Tool) => void;

  select: (ids: string[], additive?: boolean) => void;
  /** Select a single frame (or clear with null). Thin wrapper over selectFrames. */
  selectFrame: (frameId: string | null) => void;
  /** Select frames; additive ⇧-toggles each id against the current set. */
  selectFrames: (ids: string[], additive?: boolean) => void;
  setFocusedPanel: (panel: WorkspacePanel) => void;
  setEasingPopoverAt: (at: { x: number; y: number } | null) => void;
  setSelectedEdgeDecor: (ref: EdgeRef | null) => void;
  setSelectedFlipbookVoid: (v: { flipbookId: string; trackId: string; ms: number } | null) => void;

  /**
   * Nested clips whose layers are showing in the Layers panel — the disclosure
   * triangles, as SESSION state rather than the panel's own.
   *
   * It lives here because expansion is now something OTHER things ask for.
   * Opening an SVG for editing used to drill into its comp, which re-scoped the
   * timeline for what is really a request to SEE inside; it now expands the row
   * instead, and the timeline stays where it was. A view of the document, never
   * part of it: nothing here is undoable, and flipping a triangle twice is a
   * no-op at the byte level.
   *
   * Absent = collapsed, so peeking is opt-in and the tree never dumps a whole
   * comp's layers into the parent list unasked.
   */
  expandedNested: string[];
  toggleNestedExpanded: (clipId: string) => void;
  setNestedExpanded: (clipId: string, open: boolean) => void;
  setCropClipId: (id: string | null) => void;
  clearSelection: () => void;
  /** Reset ALL per-document navigation state when a new/opened doc is swapped in. */
  resetForDocument: (firstFrameId: string | null) => void;
  setSelectedKeyframes: (ids: string[]) => void;
  setSelectedMarkers: (ids: string[]) => void;

  /**
   * Open a comp as the active ROOT tab. Restores that tab's remembered cursor
   * (the hops you were inside last time), so tabs stop throwing your place
   * away. A comp that is somebody's private inside re-roots through its owner
   * instead of opening as a naked orphan artboard.
   */
  openTimeline: (frameId: string, playheadMs?: number) => void;
  /**
   * Step INTO a clip — the ONE entering verb, for every kind of inside
   * (component instance, private nested comp, vectorized SVG, flipbook,
   * drawing). Which of those it is, and whether the edit happens in place or on
   * an isolated canvas, is the scope registry's business, not the caller's.
   * Returns false when the clip has no inside.
   */
  enterClip: (clipId: string) => boolean;
  /** Open a clip's own interior editor (text glyphs, Bézier nodes, corners, crop). */
  enterLeaf: (clipId: string, mode: LeafMode) => void;
  /**
   * ONE step out, in the order a person expects: close the interior editor,
   * else leave the innermost comp. Returns false when there was nowhere to go
   * (the caller then clears the selection — that's Escape's last resort).
   */
  exitContext: () => boolean;
  /** Jump to a breadcrumb depth (0 = the root comp); the instant is preserved. */
  jumpToDepth: (depth: number) => void;
  /**
   * Make a comp the one you're working in WITHOUT opening a tab — what a click
   * or a new layer landing in another artboard means. A no-op when it's already
   * the comp you're in, which is why a click inside a nested context can never
   * silently re-root you (the old `setState({ activeFrameId })` calls could,
   * and did: that was the "click a layer, get teleported to the root" bug).
   */
  setActiveComp: (frameId: string | null) => void;
  /**
   * Navigate straight to a comp wherever it lives — the path is DERIVED from
   * the document's own ancestry, so callers no longer compute and pass one
   * (they used to, and a stale one was a whole bug family). Unlike a plain comp
   * switch this KEEPS the selection, since a reveal is driven by selecting
   * something that lives inside the comp.
   */
  revealFrame: (frameId: string, playheadMs?: number, opts?: { pinTabs?: boolean }) => void;
  /**
   * THE SEEK VERB — put the playhead at `ms` as measured by `frameId`'s own
   * clock, and stand somewhere that can express it.
   *
   * The playhead is ONE instant; `playheadMs` only ever reports it in the
   * clock of wherever you are standing. A surface that draws a comp it is not
   * standing in (the flipbook sheet, always drawn in sheet time even while you
   * are two levels down inside a cell's paint layer) must therefore convert,
   * and converting is not the caller's business — three of them each grew a
   * different rule for it, and the disagreement WAS the "dragging the playhead
   * fights the focused cell" bug.
   *
   * `deselect` is the scrub gesture's own half of that: a drag along a ruler
   * means "show me the sheet", so it lets go of whatever cell was drilled
   * rather than being pulled back into it a frame later.
   */
  seekIn: (frameId: string, ms: number, opts?: { deselect?: boolean }) => void;
  /** The playhead as `frameId`'s clock reads it — the reader half of `seekIn`. */
  playheadIn: (frameId: string) => number;
  closeTimeline: (frameId: string) => void;
  /** Close every tab except `keepId` (pinned tabs are always kept). */
  closeOtherTimelines: (keepId: string) => void;
  /** Toggle a tab's pinned state (pinning also ensures it's an open tab). */
  togglePinTimeline: (frameId: string) => void;
  setTabsFollowActivePage: (on: boolean) => void;
  /** Reorder the tab strip (drag): move a comp's tab to an index. */
  moveTimelineTab: (frameId: string, toIndex: number) => void;

  /** Close the interior editor — optionally only if it is the given mode. */
  closeLeaf: (mode?: LeafMode) => void;
  startTextEdit: (clipId: string) => void;
  endTextEdit: () => void;
  setTextSelection: (sel: TextSelection | null) => void;
  setVectorEdit: (clipId: string | null) => void;
  setShapeEdit: (clipId: string | null) => void;
  setActivePaint: (target: PaintTarget | null) => void;
  setActiveGradientStop: (stopId: string | null) => void;

  setPxPerSec: (v: number) => void;
  setLaneZoom: (v: number) => void;
  setSnapping: (v: boolean) => void;
  setLinkedSelection: (v: boolean) => void;
  setMarkersEnabled: (v: boolean) => void;
  setMergeMarkers: (v: boolean) => void;
  setWorkRange: (range: { compId: string; startMs: number; endMs: number } | null) => void;
  setWorkRangeEnabled: (v: boolean) => void;
  setSnapSettings: (patch: Partial<SnapSettings>) => void;
  setSnapIndicator: (ms: number | null) => void;
  setGuides: (v: boolean) => void;
  setGuideSettings: (patch: Partial<ViewportSnapSettings>) => void;
  setRulers: (v: boolean) => void;
  setRulerGuides: (v: boolean) => void;
  setMotionPaths: (v: boolean) => void;
  setRulerUnit: (u: RulerUnit) => void;
  setGuideDefaultColor: (c: string) => void;
  setGuideDefaultStyle: (s: GuideStyle) => void;
  setToolbarPlacement: (p: ToolbarPlacement) => void;
  setPendingNewLane: (v: PendingNewLane | null) => void;
  setFootageOverrun: (clipId: string | null) => void;
  setClipPreviews: (on: boolean) => void;
  setAutoDeleteEmptyTracks: (on: boolean) => void;
  setEnteredGroup: (groupId: string | null) => void;
  /**
   * Groups the DRILL opened (double-click to enter). Tracked separately from
   * `collapsedIds` so leaving a group closes exactly what entering it opened —
   * a group you opened yourself with the chevron stays open, because you said
   * so and a navigation gesture has no business overriding that.
   */
  drillOpenedIds: string[];
  openGroupForDrill: (groupId: string) => void;
  /**
   * Move the entered context to `groupId` (null = the top level), folding the
   * rows the drill opened DEEPER than it. `openChain` is the group and its
   * ancestors — the rows that stay open because you are still inside them.
   * Stepping from three deep to one deep closes two rows, not three.
   */
  retreatToGroup: (groupId: string | null, openChain: readonly string[]) => void;
  /** The raw write. Switch pages through `switchPage` / `goToPage` (state/frame-nav), which remember where you were. */
  setActivePage: (pageId: string | null) => void;
  setInspectorTab: (tab: InspectorTabId) => void;
  /** Open a sound category in the inspector (null closes it). */
  inspectSoundBus: (id: string | null) => void;
  focusLayerEffect: (id: string | null) => void;
  openPropertyTransfer: (mode: "copy" | "paste", clipId: string) => void;
  closePropertyTransfer: () => void;
  setPixelGrid: (on: boolean) => void;
  setBrushHandle: (on: boolean) => void;
  /** Set the preview ceiling. `auto` hands the choice back to the governor. */
  setMotionBlurQuality: (q: PreviewQuality | "auto") => void;
  setPreviewResolution: (r: PreviewResolutionSetting) => void;
  setHoldPreviewQuality: (on: boolean) => void;
  setPrerenderProgress: (p: number | null) => void;
  /**
   * Fold one measured frame into the RESOLUTION governor, and hand back the
   * tier for the next one. Same shape as `reportFrameCost`, same brain
   * (`observeFrame`) over a different ladder — one hysteresis loop in the app,
   * two readers of it.
   */
  /**
   * `memoryCap` — the sharpest tier whose range fits the cache allowance
   * (`tierFittingMemory`). Asked once, when a run begins, and only under Auto.
   */
  reportPreviewFrame: (
    ms: number,
    fps: number,
    transport: TransportState,
    /** `needsRange`: the comp cannot play live, so its range must fit the cache (core `playsLive`). */
    memoryCap?: (needsRange: boolean) => PreviewResolution,
    /** An exact run: the tier it opened at holds to the end (see the stage). */
    frozen?: boolean,
    /** The comp being played — what a run's remembered cost belongs to. */
    compId?: string | null,
  ) => PreviewResolutionDecision;
  /** Report a measured frame to the governor. Called by the stage's rAF only. */
  reportFrameCost: (ms: number, fps: number, transport: TransportState) => void;
  setPerfHud: (on: boolean) => void;
  setFocusStage: (on: boolean) => void;
  setFocusTime: (on: boolean) => void;
  setDragOutModifier: (m: ModifierKey) => void;
  setNativeResizeLockAspect: (on: boolean) => void;
  setScaleLockAspect: (on: boolean) => void;
  setScaleLockAspectOverride: (on: boolean | null) => void;
  setLeftTab: (tab: LeftTab) => void;
  setLibraryDrag: (drag: LibraryDrag) => void;
  setLibraryDragPos: (pos: { x: number; y: number; over: DragSurface } | null) => void;
  setAddToLibraryDraft: (snapshot: LibrarySnapshot | null) => void;
  setRenderInPlaceClipId: (clipId: string | null) => void;
  /**
   * The editor that owns ⌘Z right now, or null for the document.
   *
   * ⌘Z means "undo what I am editing", and not everything editable is in the
   * document: an account-level surface like the Brush Studio has real edits and
   * no patches for `store.undo` to walk. A modal editor claims the scope while
   * it is open and releases it on close — the same convention Figma and every
   * OS text field use — so there is one undo COMMAND with an owner, rather than
   * a second history competing with the first.
   */
  undoScope: UndoScope | null;
  setUndoScope: (scope: UndoScope | null) => void;
  setRecording: (v: boolean) => void;
  toggleRecording: () => void;
  setExportDialogOpen: (
    open: boolean,
    intent?: { scope: "frame" | "selection"; medium: "image" | "video" | "lottie" | "pdf" | null },
  ) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setSettingsDialogOpen: (open: boolean) => void;
  /**
   * Which settings tab to land on. Set by anything that means "take me to THAT
   * preference" — the floating gestures button, and whatever else later. A
   * caller that could only say "open settings" would leave the user to hunt
   * for the switch they were just promised.
   */
  settingsTab: string | null;
  openSettingsAt: (tab: string) => void;

  /** Drop any references to clips that no longer exist (after delete/undo). */
  pruneSelection: (existingClipIds: Set<string>, existingFrameIds: Set<string>) => void;
}

/** Selection never survives a comp switch — the clips belong to another timeline. */
/**
 * What a COMP SWITCH clears. Note what is NOT here: the interior-editor fields
 * (`editingClipId`, `vectorEditClipId`, `shapeEditClipId`, `cropClipId`). Those
 * are projections of `nav.leaf` and are written by the navigation verbs alone —
 * spreading this before `navProjection(...)` is what keeps that true.
 */
const COMP_SWITCH_RESET = {
  selectedClipIds: [] as string[],
  selectedFrameIds: [] as string[],
  selectedKeyframeIds: [] as string[],
  selectedMarkerIds: [] as string[],
  selectedPoseBlocks: [] as PoseBlockRef[],
  textSelection: null,
  scopeAddress: null,
  activePaint: null,
  activeGradientStopId: null,
  enteredGroupId: null,
} as const;

/** Mirrors `InspectorTab` in inspector/shared-inspector. Declared here rather
 *  than imported to keep the store free of a cycle through the inspector. */
/** The right panel's tabs — THE list; `inspector/shared-inspector` decides which a selection offers. */
export type InspectorTabId = "design" | "character" | "effects" | "animate" | "track" | "physics" | "sound" | "cues";

/**
 * Remember an axis for the SHOWING surface — the one place either axis is
 * written.
 *
 * The guard is the point. The readers (`use-time-axes.ts`) treat an empty
 * `timeSurfaceId` as "no surface" and answer with the defaults, so a write
 * under that key is a write nothing can ever read back: the zoom changed, the
 * store changed, and the number that came out was still 90. Dropping the write
 * makes the two sides agree by construction — there is no key the writer will
 * use and the reader won't look at — and there is nothing to remember for a
 * surface that is not on screen anyway.
 */
function rememberAxis(s: SessionState, axis: Partial<TimeAxes>): Partial<SessionState> | SessionState {
  if (!s.timeSurfaceId) return s;
  return {
    zoomBySurface: {
      ...s.zoomBySurface,
      [s.timeSurfaceId]: { ...s.zoomBySurface[s.timeSurfaceId], ...axis },
    },
  };
}

/** The collapse id of one comp's Audio section in the layers list — it lives in `collapsedIds` like every other row. */
export const audioCollapseId = (frameId: string): string => `__audio:${frameId}`;

export const useSession = create<SessionState>((set, get) => ({
  playheadMs: 0,
  playing: false,
  muted: false,

  brushEngineByFrame: {},
  setBrushEngineForFrame: (frameId, engine) =>
    set((s) => (s.brushEngineByFrame[frameId] === engine ? s : { brushEngineByFrame: { ...s.brushEngineByFrame, [frameId]: engine } })),

  tool: "select",

  selectedClipIds: [],
  selectedFrameIds: [],
  nav: EMPTY_NAV,
  activeFrameId: null,
  activeTrackerId: null,
  setActiveTracker: (id) => set({ activeTrackerId: id }),
  focusedPanel: "canvas",
  easingPopoverAt: null,
  selectedEdgeDecor: null,
  selectedFlipbookVoid: null,
  laneSpot: null,
  expandedNested: [] as string[],
  cropClipId: null,
  pivotClipId: null,
  contentEditClipId: null,
  openTimelineIds: [],
  pinnedTimelineIds: [],
  tabsFollowActivePage: false,
  timelinePath: [],
  selectedKeyframeIds: [],
  selectedMarkerIds: [],
  selectedPoseBlocks: [],

  editingClipId: null,
  textSelection: null,
  scopeAddress: null,
  vectorEditClipId: null,
  vectorNodeSelection: [],
  shapeEditClipId: null,
  activePaint: null,
  activeGradientStopId: null,

  activePageId: null,

  zoomBySurface: {},
  timeSurfaceId: "",
  timeSurfaceDefaults: EMPTY_TIME_AXES,
  snapping: true,
  linkedSelection: true,
  markersEnabled: true,
  mergeMarkers: false,
  workRange: null,
  workRangeEnabled: false,
  snapSettings: loadSnapSettings(),
  snapIndicatorMs: null,
  guides: loadGuidesOn(),
  motionPaths: loadMotionPathsOn(),
  guideSettings: loadGuideSettings(),
  rulers: loadRulersOn(),
  rulerGuides: loadRulerGuidesOn(),
  rulerUnit: loadRulerUnit(),
  guideDefaultColor: loadGuideDefaultColor(),
  guideDefaultStyle: loadGuideDefaultStyle(),
  toolbarPlacement: loadToolbarPlacement(),
  pendingNewLane: null,
  footageOverrunClipId: null,
  clipPreviews: loadClipPreviews(),
  autoDeleteEmptyTracks: loadAutoDeleteEmptyTracks(),

  enteredGroupId: null,
  collapsedIds: [],
  characterLayersIds: [],
  drillOpenedIds: [],
  inspectorTab: "design",
  inspectedSoundBus: null,
  lfxFocusId: null,
  propertyTransfer: null,
  pixelGrid: loadPixelGrid(),
  brushHandle: loadBrushHandle(),
  motionBlurQuality: loadMotionBlurQuality(),
  motionBlurActual: INITIAL_BUDGET,
  previewResolution: loadPreviewResolution(),
  previewResolutionActual: INITIAL_PREVIEW_RESOLUTION,
  previewTier: "full",
  holdPreviewQuality: loadHoldPreviewQuality(),
  prerenderProgress: null,
  perfHud: false,
  focusStage: loadFocusStage(),
  focusTime: loadFocusTime(),
  dragOutModifier: loadDragOutModifier(),
  nativeResizeLockAspect: loadNativeResizeLockAspect(),
  scaleLockAspect: loadScaleLockAspect(),
  scaleLockAspectOverride: loadScaleLockAspectOverride(),

  leftTab: "library",
  libraryDrag: null,
  libraryDragPos: null,
  addToLibraryDraft: null,
  renderInPlaceClipId: null,

  recording: false,

  exportDialogOpen: false,
  exportIntent: null,
  commandPaletteOpen: false,
  settingsDialogOpen: false,
  settingsTab: null,
  variablesOpen: false,
  variablesFocusId: null,
  consoleOpen: false,
  activityOpen: false,

  setPlayhead: (ms) => set({ playheadMs: Math.max(0, ms) }),
  setPlaying: (playing) => {
    const stillReason = playing ? stillBlocksPlayback(get().nav, get().playheadMs) : null;
    if (stillReason) {
      toast(stillReason);
      return;
    }
    set({
      playing,
      ...(playing
        ? { editingClipId: null, textSelection: null, scopeAddress: null, vectorEditClipId: null, shapeEditClipId: null }
        : {}),
    });
  },
  togglePlaying: () => get().setPlaying(!get().playing),
  setMuted: (muted) => set({ muted }),

  setTool: (tool) =>
    set((s) => {
      // Picking another tool leaves the text caret — through the nav, so the
      // whole leaf (and every projection of it) moves together.
      if (!s.editingClipId || tool === "select") return { tool };
      const doc = peekDoc();
      return {
        tool,
        textSelection: null, scopeAddress: null,
        ...(doc ? navProjection(doc, enterLeafNav(s.nav, null)) : { editingClipId: null }),
      };
    }),

  select: (ids, additive = false) =>
    set((s) => {
      let selectedClipIds: string[];
      if (!additive) {
        selectedClipIds = ids;
      } else {
        const merged = new Set(s.selectedClipIds);
        for (const id of ids) {
          if (merged.has(id)) merged.delete(id);
          else merged.add(id);
        }
        selectedClipIds = [...merged];
      }
      // Selecting away from the clip being text/node/shape-edited ends that mode.
      // A DECORATION follows the same law: it is a part of its clip, so it
      // survives exactly as long as that clip is still selected. Clearing it on
      // every `select` was what made pressing an in/out chip unable to both
      // pick the decoration AND hand the press on to the clip's move gesture —
      // the clip's own press-selection ran second and wiped it.
      const editStays = s.editingClipId !== null && selectedClipIds.includes(s.editingClipId);
      // A transition has no clip of its own — it straddles two — so it is never
      // kept by a clip selection.
      const decorStays =
        s.selectedEdgeDecor !== null &&
        s.selectedEdgeDecor.kind !== "transition" &&
        selectedClipIds.includes(s.selectedEdgeDecor.clipId);
      const vecStays = s.vectorEditClipId !== null && selectedClipIds.includes(s.vectorEditClipId);
      const shapeStays = s.shapeEditClipId !== null && selectedClipIds.includes(s.shapeEditClipId);
      const cropStays = s.cropClipId !== null && selectedClipIds.includes(s.cropClipId);
      const pivotStays = s.pivotClipId !== null && selectedClipIds.includes(s.pivotClipId);
      const blocks = s.selectedPoseBlocks.filter((b) => selectedClipIds.includes(b.groupId));
      return {
        selectedClipIds,
        selectedFrameIds: [],
        selectedKeyframeIds: [],
        selectedMarkerIds: [],
        ...(blocks.length === s.selectedPoseBlocks.length ? {} : { selectedPoseBlocks: blocks }),
        ...(decorStays ? {} : { selectedEdgeDecor: null }),
        selectedFlipbookVoid: null,
        laneSpot: null,
        ...(editStays ? {} : { editingClipId: null, textSelection: null, scopeAddress: null }),
        ...(vecStays ? {} : { vectorEditClipId: null }),
        ...(shapeStays ? {} : { shapeEditClipId: null }),
        ...(cropStays ? {} : { cropClipId: null }),
        ...(pivotStays ? {} : { pivotClipId: null }),
      };
    }),

  selectFrame: (frameId) => get().selectFrames(frameId ? [frameId] : [], false),

  selectFrames: (ids, additive = false) =>
    set((s) => {
      let selectedFrameIds: string[];
      if (!additive) {
        selectedFrameIds = ids;
      } else {
        const merged = new Set(s.selectedFrameIds);
        for (const id of ids) {
          if (merged.has(id)) merged.delete(id);
          else merged.add(id);
        }
        selectedFrameIds = [...merged];
      }
      // The last-added frame is the primary: it opens the timeline + inspector.
      const primary = selectedFrameIds[selectedFrameIds.length - 1];
      const doc = peekDoc();
      // Touching ANOTHER frame on the canvas re-roots the navigation there (and
      // restores that tab's cursor). Touching the frame you're already inside
      // changes nothing — which is why a click on an inner layer can no longer
      // teleport you out to the root: navigation only moves when you ask it to.
      const reroot =
        doc && primary && primary !== s.activeFrameId
          ? openRootNav(doc, s.nav, primary)
          : null;
      return {
        selectedFrameIds,
        selectedClipIds: [],
        selectedKeyframeIds: [],
        selectedMarkerIds: [],
        selectedPoseBlocks: [],
        selectedFlipbookVoid: null,
        laneSpot: null,
        textSelection: null, scopeAddress: null,
        ...(doc && s.nav.leaf ? navProjection(doc, enterLeafNav(s.nav, null)) : {}),
        ...(reroot && doc ? navProjection(doc, reroot) : {}),
      };
    }),

  setFocusedPanel: (panel) => set((s) => (s.focusedPanel === panel ? {} : { focusedPanel: panel })),
  setEasingPopoverAt: (at) => set({ easingPopoverAt: at }),
  setSelectedEdgeDecor: (ref) => set({ selectedEdgeDecor: ref }),
  setSelectedFlipbookVoid: (v) => set({ selectedFlipbookVoid: v }),
  setLaneSpot: (spot) =>
    set({
      laneSpot: spot,
      selectedClipIds: [],
      selectedFrameIds: [],
      selectedKeyframeIds: [],
      selectedMarkerIds: [],
      selectedPoseBlocks: [],
      selectedEdgeDecor: null,
      selectedFlipbookVoid: null,
    }),
  toggleNestedExpanded: (clipId) =>
    set((s) => ({
      expandedNested: s.expandedNested.includes(clipId)
        ? s.expandedNested.filter((id) => id !== clipId)
        : [...s.expandedNested, clipId],
    })),
  setNestedExpanded: (clipId, open) =>
    set((s) => {
      const has = s.expandedNested.includes(clipId);
      if (has === open) return {};
      return {
        expandedNested: open ? [...s.expandedNested, clipId] : s.expandedNested.filter((id) => id !== clipId),
      };
    }),
  setCropClipId: (id) => (id ? get().enterLeaf(id, "crop") : get().closeLeaf("crop")),

  clearSelection: () =>
    set((s) => {
      const doc = peekDoc();
      return {
        selectedClipIds: [],
        selectedFrameIds: [],
        selectedKeyframeIds: [],
        selectedMarkerIds: [],
        selectedPoseBlocks: [],
        selectedEdgeDecor: null,
        selectedFlipbookVoid: null,
        laneSpot: null,
        textSelection: null, scopeAddress: null,
        enteredGroupId: null,
        // Clearing the selection closes any interior editor — through the nav,
        // so the four projections move together or not at all.
        ...(doc && s.nav.leaf ? navProjection(doc, enterLeafNav(s.nav, null)) : {}),
      };
    }),
  resetForDocument: (firstFrameId) =>
    set({
      ...COMP_SWITCH_RESET,
      activePageId: null,
      nav: { path: { rootFrameId: firstFrameId ?? "", hops: [] }, leaf: null, hopsByTab: {} },
      activeFrameId: firstFrameId,
      timelinePath: [],
      editingClipId: null,
      vectorEditClipId: null,
      shapeEditClipId: null,
      cropClipId: null,
      pivotClipId: null,
      openTimelineIds: [],
      pinnedTimelineIds: [],
      // The project reopens where each comp was left, not at zero.
      playheadMs: (() => {
        const doc = peekDoc();
        return doc && firstFrameId ? rememberedPlayheadMs(doc, firstFrameId) : 0;
      })(),
      playing: false,
      workRange: null,
      workRangeEnabled: false,
      brushEngineByFrame: {},
      // A canvas with no frame has one thing to do first: draw one.
      ...(firstFrameId === null ? { tool: "frame" as const } : {}),
    }),
  setSelectedKeyframes: (ids) => set({ selectedKeyframeIds: ids }),
  setSelectedMarkers: (ids) => set({ selectedMarkerIds: ids }),
  // Picking blocks is a timeline selection of its own: keyframes and markers give way.
  setSelectedPoseBlocks: (refs) => set({ selectedPoseBlocks: refs, ...(refs.length ? { selectedKeyframeIds: [], selectedMarkerIds: [] } : {}) }),

  /* ---------------------------------------------------------- navigation ---
   * Every navigation verb funnels through `applyNav`: normalise the path,
   * recompute the projections, carry the instant across the move. One writer,
   * one invariant — the breadcrumb, the timeline, the stage and playback all
   * read the same resolved truth.
   */

  openTimeline: (frameId, playheadMs) =>
    set((s) => {
      const doc = peekDoc();
      if (!doc) return {};
      const next = openRootNav(doc, s.nav, frameId);
      return {
        openTimelineIds: s.openTimelineIds.includes(next.path.rootFrameId)
          ? s.openTimelineIds
          : [...s.openTimelineIds, next.path.rootFrameId],
        ...COMP_SWITCH_RESET,
        ...navProjection(doc, next),
        ...(playheadMs !== undefined
          ? { playheadMs: Math.max(0, playheadMs) }
          : { playheadMs: playheadForNav(doc, s.nav, next, s.playheadMs) }),
      };
    }),

  enterClip: (clipId) => {
    const doc = peekDoc();
    if (!doc) return false;
    const s = get();
    const next = enterNav(doc, s.nav, clipId);
    if (!next) return false;
    set({
      ...COMP_SWITCH_RESET,
      ...navProjection(doc, next),
      playheadMs: playheadForNav(doc, s.nav, next, s.playheadMs),
    });
    return true;
  },

  enterLeaf: (clipId, mode) =>
    set((s) => {
      const doc = peekDoc();
      if (!doc) return {};
      const next = enterLeafNav(s.nav, { clipId, mode });
      return {
        ...navProjection(doc, next),
        selectedClipIds: [clipId],
        selectedFrameIds: [],
        selectedKeyframeIds: [],
        playing: false,
        textSelection: null, scopeAddress: null,
      };
    }),

  exitContext: () => {
    const doc = peekDoc();
    if (!doc) return false;
    const s = get();
    const next = exitNav(doc, s.nav);
    if (!next) return false;
    set({
      playheadMs: playheadForNav(doc, s.nav, next, s.playheadMs),
      // Leaving a COMP resets the working selection; merely closing an interior
      // editor keeps it (you stay on the layer you were editing).
      ...(next.path.hops.length !== s.nav.path.hops.length ? COMP_SWITCH_RESET : {}),
      ...navProjection(doc, next),
    });
    return true;
  },

  jumpToDepth: (depth) =>
    set((s) => {
      const doc = peekDoc();
      if (!doc) return {};
      const next = jumpNav(doc, s.nav, depth);
      return {
        ...COMP_SWITCH_RESET,
        ...navProjection(doc, next),
        playheadMs: playheadForNav(doc, s.nav, next, s.playheadMs),
      };
    }),

  setActiveComp: (frameId) =>
    set((s) => {
      const doc = peekDoc();
      if (!doc || !frameId || frameId === s.activeFrameId) return {};
      const next = openRootNav(doc, s.nav, frameId);
      return { ...navProjection(doc, next), playheadMs: playheadForNav(doc, s.nav, next, s.playheadMs) };
    }),

  /* THE seek verb — see the interface for why this cannot live in its callers. */
  seekIn: (frameId, ms, opts) =>
    set((s) => {
      const doc = peekDoc();
      if (!doc) return {};
      const plan = seekInFrame(doc, s.nav.path, frameId, ms);
      const cleared = opts?.deselect
        ? { selectedClipIds: [], selectedFrameIds: [], selectedKeyframeIds: [], selectedFlipbookVoid: null, laneSpot: null }
        : {};
      // Staying put is the common case and must not churn the nav projection —
      // a scrub writes one number sixty times a second.
      if (!plan.moved) return { playheadMs: plan.playheadMs, ...cleared };
      return {
        ...navProjection(doc, navigateNav(doc, s.nav, plan.path, { leaf: null })),
        playheadMs: plan.playheadMs,
        textSelection: null, scopeAddress: null,
        ...cleared,
      };
    }),

  playheadIn: (frameId) => {
    const doc = peekDoc();
    const s = get();
    if (!doc) return s.playheadMs;
    return playheadInFrame(doc, s.nav.path, s.playheadMs, frameId);
  },

  revealFrame: (frameId, playheadMs, opts) =>
    set((s) => {
      const doc = peekDoc();
      if (!doc) return {};
      const next = openRootNav(doc, s.nav, frameId);
      // pinTabs:false = focus WITHOUT adding to the tab strip — a flipbook cell
      // is not a standalone timeline, so entering one moves the breadcrumb and
      // canvas only (the whole flipbook stays the one tab).
      const openTimelineIds =
        opts?.pinTabs === false || s.openTimelineIds.includes(next.path.rootFrameId)
          ? s.openTimelineIds
          : [...s.openTimelineIds, next.path.rootFrameId];
      return {
        ...navProjection(doc, next),
        openTimelineIds,
        // A reveal KEEPS the selection (it was caused by selecting something in
        // there) but drops interior editors a comp switch cannot carry.
        textSelection: null, scopeAddress: null,
        // THE INSTANT IS CARRIED, exactly as `openTimeline`/`enterClip`/
        // `exitContext`/`jumpToDepth` already carry it. `revealFrame` was the
        // one navigation verb that did not: it left `playheadMs` at whatever
        // number the PREVIOUS comp's clock happened to hold, so drilling into a
        // flipbook cell reported the sheet's time as the drawing's time. Every
        // caller had papered over that by passing a hand-computed `playheadMs`
        // — most of them a literal `0` — which is why focusing a frame moved
        // the playhead and moving the playhead refocused a frame.
        playheadMs:
          playheadMs !== undefined
            ? Math.max(0, playheadMs)
            : playheadForNav(doc, s.nav, next, s.playheadMs),
      };
    }),

  closeTimeline: (frameId) =>
    set((s) => {
      const openTimelineIds = s.openTimelineIds.filter((id) => id !== frameId);
      // Closing a tab also drops its pin — a closed timeline can't stay pinned.
      const pinnedTimelineIds = s.pinnedTimelineIds.filter((id) => id !== frameId);
      if (s.activeFrameId !== frameId) return { openTimelineIds, pinnedTimelineIds };
      const doc = peekDoc();
      const fallback = openTimelineIds[openTimelineIds.length - 1] ?? null;
      // Through the nav like every other comp switch, so the path, the
      // projections and the instant (the next tab's OWN time) move together.
      if (!doc || !fallback) {
        return { openTimelineIds, pinnedTimelineIds, activeFrameId: fallback, timelinePath: [], ...COMP_SWITCH_RESET };
      }
      const next = openRootNav(doc, s.nav, fallback);
      return {
        openTimelineIds,
        pinnedTimelineIds,
        ...COMP_SWITCH_RESET,
        ...navProjection(doc, next),
        playheadMs: playheadForNav(doc, s.nav, next, s.playheadMs),
      };
    }),

  closeOtherTimelines: (keepId) =>
    set((s) => {
      // Keep the target + every pinned tab; everything else closes.
      const keep = new Set([keepId, ...s.pinnedTimelineIds]);
      const openTimelineIds = s.openTimelineIds.filter((id) => keep.has(id));
      const doc = peekDoc();
      if (!doc) return { openTimelineIds, activeFrameId: keepId, timelinePath: [], ...COMP_SWITCH_RESET };
      const next = openRootNav(doc, s.nav, keepId);
      return {
        openTimelineIds,
        ...COMP_SWITCH_RESET,
        ...navProjection(doc, next),
        playheadMs: playheadForNav(doc, s.nav, next, s.playheadMs),
      };
    }),

  togglePinTimeline: (frameId) =>
    set((s) => {
      if (s.pinnedTimelineIds.includes(frameId)) {
        return { pinnedTimelineIds: s.pinnedTimelineIds.filter((id) => id !== frameId) };
      }
      // Pinning makes it a real, persistent tab (never just the active pseudo-tab).
      const openTimelineIds = s.openTimelineIds.includes(frameId)
        ? s.openTimelineIds
        : [...s.openTimelineIds, frameId];
      return { pinnedTimelineIds: [...s.pinnedTimelineIds, frameId], openTimelineIds };
    }),

  setTabsFollowActivePage: (on) => set({ tabsFollowActivePage: on }),

  moveTimelineTab: (frameId, toIndex) =>
    set((s) => {
      const ids = s.openTimelineIds.includes(frameId)
        ? s.openTimelineIds.filter((id) => id !== frameId)
        : [...s.openTimelineIds];
      ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, frameId);
      return { openTimelineIds: ids };
    }),


  // The interior-editor verbs are all one call now: open (or close) the leaf.
  // Mutual exclusion is structural — there is one leaf slot — so "entering
  // vector edit clears shape edit" is not a rule anyone has to remember.
  startTextEdit: (clipId) => get().enterLeaf(clipId, "text"),
  endTextEdit: () => get().closeLeaf("text"),
  setTextSelection: (sel) =>
    set((s) => {
      // A chip choice is about the span that was on screen when it was made.
      // A NEW span — or none — is the person pointing somewhere else, and the
      // sidebar follows them; only the same span re-published (a caret blink,
      // a re-render) keeps the choice, which is what lets the Text chip stay
      // chosen while the selection is still there.
      //
      // A CAPTION STATE is the exception, because it was never about a span:
      // "how the unread words look" means the same thing wherever the caret
      // goes. Dropping it on every click is what made the state tabs feel like
      // they wouldn't stay put.
      const same = !!sel && !!s.textSelection && s.textSelection.start === sel.start && s.textSelection.end === sel.end;
      if (same || s.scopeAddress?.kind === "caption") return { textSelection: sel };
      return { textSelection: sel, scopeAddress: null };
    }),
  setScopeAddress: (scopeAddress) => set({ scopeAddress }),
  setVectorNodeSelection: (keys) =>
    set((s) =>
      s.vectorNodeSelection.length === keys.length && s.vectorNodeSelection.every((k, i) => k === keys[i])
        ? s
        : { vectorNodeSelection: keys },
    ),
  setVectorEdit: (clipId) =>
    clipId ? get().enterLeaf(clipId, "vectorNodes") : get().closeLeaf("vectorNodes"),
  setShapeEdit: (clipId) =>
    clipId ? get().enterLeaf(clipId, "shapeCorners") : get().closeLeaf("shapeCorners"),

  closeLeaf: (mode) =>
    set((s) => {
      const doc = peekDoc();
      if (!doc || !s.nav.leaf) return {};
      if (mode && s.nav.leaf.mode !== mode) return {};
      return { ...navProjection(doc, enterLeafNav(s.nav, null)), textSelection: null, scopeAddress: null };
    }),
  setActivePaint: (target) => set({ activePaint: target, activeGradientStopId: null }),
  setActiveGradientStop: (stopId) => set({ activeGradientStopId: stopId }),

  // Only the ABSOLUTE bounds here (0.05 = ABSOLUTE_MIN_PX_PER_SEC, 600 = MAX in
  // timeline-view.ts). The duration-aware zoom-out floor is applied by the
  // callers (timelineView.zoom + the zoom dial's `min`) — this setter can't
  // import timeline-view without a cycle, and mustn't re-impose the old fixed
  // floor of 12, which was capping long timelines at ~1 min on screen.
  /*
   * ZOOM WRITES LAND ON THE SHOWING SURFACE. The absolute rails here exist only
   * to keep an unusable number out of the store — a sheet at 60fps legitimately
   * wants 15000 px/s to show a 250px frame, and a two-hour timeline legitimately
   * wants 0.05. The USEFUL limits are the reader's: `timelineView.zoom` clamps
   * to the comp's duration, `sheetAxisBounds` clamps to px-per-frame.
   */
  setPxPerSec: (v) =>
    set((s) =>
      rememberAxis(s, { pxPerSec: Math.min(40000, Math.max(0.05, v)) }),
    ),
  // Kept in sync with MIN/MAX_LANE_ZOOM in timeline-utils.ts (same split as
  // pxPerSec/timeline-view.ts above — session.ts can't import a module that
  // itself imports `useSession`).
  setLaneZoom: (v) => set((s) => rememberAxis(s, { laneZoom: v })),
  setSnapping: (v) => set({ snapping: v }),
  setLinkedSelection: (v) => set({ linkedSelection: v }),
  setMarkersEnabled: (v) => set({ markersEnabled: v }),
  setMergeMarkers: (v) => set({ mergeMarkers: v }),
  setWorkRange: (range) => set({ workRange: range }),
  setWorkRangeEnabled: (v) => set({ workRangeEnabled: v }),
  setSnapSettings: (patch) =>
    set((s) => {
      const snapSettings = { ...s.snapSettings, ...patch };
      try {
        window.localStorage.setItem(SNAP_STORAGE_KEY, JSON.stringify(snapSettings));
      } catch {
        // Private mode etc. — settings just won't persist.
      }
      return { snapSettings };
    }),
  setSnapIndicator: (ms) =>
    set((s) => (s.snapIndicatorMs === ms ? {} : { snapIndicatorMs: ms })),
  setGuides: (v) => {
    try {
      window.localStorage.setItem(GUIDES_ON_KEY, v ? "1" : "0");
    } catch {
      // Private mode etc. — the toggle just won't persist.
    }
    set({ guides: v });
  },
  setGuideSettings: (patch) =>
    set((s) => {
      const guideSettings = { ...s.guideSettings, ...patch };
      try {
        window.localStorage.setItem(GUIDE_STORAGE_KEY, JSON.stringify(guideSettings));
      } catch {
        // Private mode etc. — settings just won't persist.
      }
      return { guideSettings };
    }),
  setRulers: (v) => {
    try {
      window.localStorage.setItem(RULERS_ON_KEY, v ? "1" : "0");
    } catch {
      // Private mode etc.
    }
    set({ rulers: v });
  },
  setRulerGuides: (v) => {
    try {
      window.localStorage.setItem(RULER_GUIDES_KEY, v ? "1" : "0");
    } catch {
      // Private mode etc.
    }
    set({ rulerGuides: v });
  },
  setMotionPaths: (v) => {
    try {
      window.localStorage.setItem(MOTION_PATHS_KEY, v ? "1" : "0");
    } catch {
      // Private mode etc.
    }
    set({ motionPaths: v });
  },
  setRulerUnit: (u) => {
    try {
      window.localStorage.setItem(RULER_UNIT_KEY, u);
    } catch {
      // Private mode etc.
    }
    set({ rulerUnit: u });
  },
  setGuideDefaultColor: (c) => {
    try {
      window.localStorage.setItem(GUIDE_COLOR_KEY, c);
    } catch {
      // Private mode etc.
    }
    set({ guideDefaultColor: c });
  },
  setGuideDefaultStyle: (s) => {
    try {
      window.localStorage.setItem(GUIDE_STYLE_KEY, s);
    } catch {
      // Private mode etc.
    }
    set({ guideDefaultStyle: s });
  },
  setToolbarPlacement: (p) => {
    try {
      window.localStorage.setItem(TOOLBAR_DOCK_KEY, p);
    } catch {
      // Private mode etc. — the placement just won't persist.
    }
    set({ toolbarPlacement: p });
  },
  setPendingNewLane: (v) => set({ pendingNewLane: v }),
  setFootageOverrun: (clipId) => set({ footageOverrunClipId: clipId }),
  setClipPreviews: (on) => {
    try {
      localStorage.setItem("tm-clip-previews", on ? "1" : "0");
    } catch {
      // storage unavailable — the session value still applies
    }
    set({ clipPreviews: on });
  },
  setAutoDeleteEmptyTracks: (on) => {
    try {
      localStorage.setItem("tm-auto-del-tracks", on ? "1" : "0");
    } catch {
      // storage unavailable — the session value still applies
    }
    set({ autoDeleteEmptyTracks: on });
  },
  setEnteredGroup: (groupId) => set({ enteredGroupId: groupId }),
  openGroupForDrill: (groupId) =>
    set((s) => ({
      // Only record it as ours if it was actually shut — reopening something
      // already open must not make us responsible for closing it.
      drillOpenedIds: s.collapsedIds.includes(groupId)
        ? [...new Set([...s.drillOpenedIds, groupId])]
        : s.drillOpenedIds,
      collapsedIds: s.collapsedIds.filter((id) => id !== groupId),
    })),
  retreatToGroup: (groupId, openChain) =>
    set((s) => {
      const keep = new Set(openChain);
      const fold = s.drillOpenedIds.filter((id) => !keep.has(id));
      return {
        enteredGroupId: groupId,
        collapsedIds: [...new Set([...s.collapsedIds, ...fold])],
        drillOpenedIds: s.drillOpenedIds.filter((id) => keep.has(id)),
      };
    }),
  toggleCollapsed: (groupId) =>
    set((s) => ({
      collapsedIds: s.collapsedIds.includes(groupId)
        ? s.collapsedIds.filter((id) => id !== groupId)
        : [...s.collapsedIds, groupId],
    })),
  setCollapsed: (groupId, collapsed) =>
    set((s) => ({
      collapsedIds: collapsed
        ? [...new Set([...s.collapsedIds, groupId])]
        : s.collapsedIds.filter((id) => id !== groupId),
    })),
  openTreeRows: (collapseIds, nestedIds) =>
    set((s) => {
      const unfold = new Set(collapseIds);
      const shut = s.collapsedIds.some((id) => unfold.has(id));
      const peek = nestedIds.filter((id) => !s.expandedNested.includes(id));
      if (!shut && peek.length === 0) return s;
      return {
        ...(shut ? { collapsedIds: s.collapsedIds.filter((id) => !unfold.has(id)) } : {}),
        ...(peek.length ? { expandedNested: [...s.expandedNested, ...peek] } : {}),
      };
    }),
  setCharacterLayers: (groupId, layers) =>
    set((s) => ({
      characterLayersIds: layers ? [...new Set([...s.characterLayersIds, groupId])] : s.characterLayersIds.filter((id) => id !== groupId),
    })),
  setActivePage: (pageId) => set({ activePageId: pageId }),
  setInspectorTab: (tab) => set({ inspectorTab: tab }),
  inspectSoundBus: (id) =>
    set((s) => ({ inspectedSoundBus: id ? { id, clips: s.selectedClipIds, frames: s.selectedFrameIds } : null })),
  focusLayerEffect: (id) => set({ lfxFocusId: id }),
  openPropertyTransfer: (mode, clipId) => set({ propertyTransfer: { mode, clipId } }),
  closePropertyTransfer: () => set({ propertyTransfer: null }),
  setMotionBlurQuality: (q) => {
    try {
      localStorage.setItem("tm-motion-blur", q);
    } catch {
      // storage unavailable — the session value still applies
    }
    // Pinning a tier clears any governor verdict: the chip must stop reading
    // "degraded" the instant the choice becomes the user's again.
    set({ motionBlurQuality: q, motionBlurActual: { ...INITIAL_BUDGET, quality: q === "auto" ? "full" : q } });
  },
  reportFrameCost: (ms, fps, transport) => {
    const s = get();
    // A pinned tier is a pinned tier — measure nothing and decide nothing.
    if (s.motionBlurQuality !== "auto") return;

    // A REGIME CHANGE INVALIDATES THE VERDICT. Playing and parked are different
    // machines: one draws sixty frames a second, the other draws one and then
    // sits still. Carrying a playback measurement across that boundary compares
    // unlike things — and worse, it strands the governor, because recovery
    // needs RECOVER_FRAMES consecutive cheap frames and a parked stage will
    // never draw them. Without this, one slow playback would leave the chip
    // amber and the preview capped forever, quietly making "parked renders at
    // full quality" a lie.
    if (transport !== lastTransport) {
      lastTransport = transport;
      motionBlurRecovery.frames = 0;
      set({ motionBlurActual: INITIAL_BUDGET });
      return;
    }

    const next = observeFrame(s.motionBlurActual, ms, fps, "full", motionBlurRecovery, MOTION_BLUR_LADDER);
    // Zustand-level identity check: the governor returns a fresh object every
    // frame, and re-setting an equal one would re-render the chip 60×/second
    // for a value that did not change.
    const prev = s.motionBlurActual;
    if (next.quality === prev.quality && next.degraded === prev.degraded) {
      prev.frameMs = next.frameMs;
      return;
    }
    set({ motionBlurActual: next });
  },
  setPreviewResolution: (r) => {
    try {
      localStorage.setItem("tm-preview-resolution", r);
    } catch {
      // storage unavailable — the session value still applies
    }
    // Pinning a tier clears the governor's verdict, exactly as pinning a
    // shutter tier does: the chip must stop saying "the app lowered this" the
    // instant the choice became the user's again.
    runSamples.length = 0;
    // A CHOSEN resolution is a new picture: everything kept was made at the
    // old one and would sit in memory unreachable. Rendered work goes (decoded
    // footage stays — it has no resolution). Auto's own switching never clears.
    if (get().previewResolution !== r) purgeResolutionBound();
    set({
      previewResolution: r,
      previewResolutionActual: { ...INITIAL_PREVIEW_RESOLUTION, quality: r === "auto" ? "full" : r },
    });
  },
  setHoldPreviewQuality: (on) => {
    try {
      localStorage.setItem("tm-hold-preview-quality", on ? "1" : "0");
    } catch {
      // storage unavailable — the session value still applies
    }
    set({ holdPreviewQuality: on });
  },
  setPrerenderProgress: (p) => {
    if (get().prerenderProgress === p) return;
    set({ prerenderProgress: p });
  },
  reportPreviewFrame: (ms, fps, transport, memoryCap, frozen, compId) => {
    const s = get();
    const decide = (governed: PreviewResolution): PreviewResolutionDecision => {
      const d = resolvePreviewResolution({
        setting: s.previewResolution,
        governed,
        transport,
        holdWhilePaused: s.holdPreviewQuality,
      });
      // Published only on a real change: this runs once per frame, and setting
      // an equal value would re-render the chip sixty times a second.
      if (get().previewTier !== d.tier) set({ previewTier: d.tier });
      return d;
    };

    // A pinned tier measures nothing and decides nothing.
    if (s.previewResolution !== "auto") return decide(s.previewResolutionActual.quality);

    const prev = s.previewResolutionActual;
    const running = transport !== "idle";
    const regimeChanged = running !== lastPreviewRunning;
    lastPreviewRunning = running;

    // ── PARKED ────────────────────────────────────────────────────────────
    //
    // Measure nothing, decide nothing, and — this is the part that matters —
    // DO NOT RESET THE VERDICT. The standing tier is "what playback runs at",
    // and it has to survive a pause: it is part of what makes a cached frame
    // valid, so resetting it on every stop erased the range the person had
    // just spent time building, which is the single most annoying thing a
    // cache can do. A parked frame is rendered at full quality regardless
    // (see `resolvePreviewResolution`), and its cost is measured at a
    // different resolution from the run's, so it is not a comparable sample
    // either.
    if (!running) {
      if (regimeChanged) {
        // What the run taught, filed under its comp.
        if (openRun) tierMemory.set(openRun.compId, closeRun(tierMemory.get(openRun.compId) ?? null, openRun.opened, openRun.at, openRun.measuredMs));
        openRun = null;
      }
      return decide(prev.quality);
    }

    // ── A RUN BEGINS ──────────────────────────────────────────────────────
    //
    // Choose once, from what we have already measured. `ms` arrives NORMALISED
    // to full resolution, so it is a real prediction rather than a reading
    // taken through whatever tier happened to be in force.
    if (regimeChanged) {
      runStartedMs = performance.now();
      runSamples.length = 0;
      // Speed AND memory: no sharper than the machine can draw in time, and no
      // sharper than the range can be kept at. See `tierFittingMemory`.
      //
      // The cap alone opens the run when there is one. Predicting speed from a
      // cost scaled by 1/s² put a light comp at an eighth before a single
      // frame had been late; the in-run governor below drops on the first
      // frame that actually is.
      const memory = (compId && tierMemory.get(compId)) || null;
      const { tier: opening, floor } = openingTier(memory, ms, fps, memoryCap ? memoryCap(!playsLive(memory, ms, fps)) : "full");
      openRun = compId ? { compId, opened: opening, floor, at: opening, measuredMs: memory?.measuredMs ?? ms } : null;
      // No sample yet: the smoothing starts from the run's own first warm
      // frame (`observeFrame`), not from a parked frame drawn at full.
      set({ previewResolutionActual: { quality: opening, degraded: opening !== "full", frameMs: 0 } });
      return decide(opening);
    }

    // An exact run shows the true frame at the tier it opened with; a cost
    // never moves it (a slow frame is simply waited for).
    if (frozen) return decide(prev.quality);

    // ── DURING A RUN: IT MAY ONLY GO DOWN ─────────────────────────────────
    //
    // The ceiling is the tier already in force, so the governor's recovery arm
    // can never fire while the transport is running. Climbing back mid-playback
    // was visibly wrong twice over: the picture changed sharpness in the middle
    // of the motion you were judging, and every change of tier is a change of
    // what a cached frame IS, so it threw the range away and the next second of
    // playback had to be rendered again — which made it slow, which dropped the
    // tier, which is the strobe. It picks again the moment you stop.
    if (performance.now() - runStartedMs < RUN_WARMUP_MS) return decide(prev.quality);
    // `ms` arrives normalised to full; the verdict is about THIS tier's frames.
    runSamples.push(ms * resolutionWeight(prev.quality));
    if (runSamples.length > RUN_WINDOW) runSamples.shift();
    const typical = median(runSamples);
    if (openRun) openRun.measuredMs = typical;
    // Read by the chip's tooltip; mutated, not set — an equal tier must not
    // re-render it every frame.
    prev.frameMs = typical / resolutionWeight(prev.quality);
    const at = PREVIEW_RESOLUTIONS.indexOf(prev.quality);
    // A PROBE FALLS BACK TO WHAT IS PROVEN, never below it in one go: the tier
    // under the probe has played this comp to the end already.
    const floorAt = openRun ? PREVIEW_RESOLUTIONS.indexOf(openRun.floor) : 0;
    if (runSamples.length < RUN_WINDOW || typical <= budgetFor(fps) || at <= 0) return decide(prev.quality);
    const quality = PREVIEW_RESOLUTIONS[Math.max(floorAt, at - 1)]!;
    if (quality === prev.quality) return decide(prev.quality);
    runSamples.length = 0;
    if (openRun) openRun.at = quality;
    set({ previewResolutionActual: { quality, degraded: quality !== "full", frameMs: typical / resolutionWeight(quality) } });
    return decide(quality);
  },
  setPerfHud: (on) => set({ perfHud: on }),
  setBrushHandle: (on) => {
    try {
      localStorage.setItem("tm-brush-handle", on ? "1" : "0");
    } catch {
      // storage unavailable — the session value still applies
    }
    set({ brushHandle: on });
  },
  setPixelGrid: (on) => {
    try {
      localStorage.setItem("tm-pixel-grid", on ? "1" : "0");
    } catch {
      // storage unavailable — the session value still applies
    }
    set({ pixelGrid: on });
  },
  setFocusStage: (on) => {
    try {
      localStorage.setItem("tm-focus-stage", on ? "1" : "0");
    } catch {
      // storage unavailable — the session value still applies
    }
    set({ focusStage: on });
  },
  setFocusTime: (on) => {
    try {
      localStorage.setItem("tm-focus-time", on ? "1" : "0");
    } catch {
      // storage unavailable — the session value still applies
    }
    set({ focusTime: on });
  },
  setDragOutModifier: (m) => {
    try {
      localStorage.setItem("tm-drag-out-mod", m);
    } catch {
      // storage unavailable — the session value still applies
    }
    set({ dragOutModifier: m });
  },
  setNativeResizeLockAspect: (on) => {
    try {
      localStorage.setItem("tm-native-ar-lock", on ? "1" : "0");
    } catch {
      // storage unavailable — the session value still applies
    }
    set({ nativeResizeLockAspect: on });
  },
  setScaleLockAspect: (on: boolean) => {
    try {
      localStorage.setItem("tm-scale-ar-lock", on ? "1" : "0");
    } catch {
      // storage unavailable — the session value still applies
    }
    set({ scaleLockAspect: on });
  },
  setScaleLockAspectOverride: (on: boolean | null) => {
    try {
      if (on === null) localStorage.removeItem("tm-scale-ar-lock-override");
      else localStorage.setItem("tm-scale-ar-lock-override", on ? "1" : "0");
    } catch {
      // storage unavailable — the session value still applies
    }
    set({ scaleLockAspectOverride: on });
  },
  setLeftTab: (tab) => set({ leftTab: tab }),
  setLibraryDrag: (drag) => set({ libraryDrag: drag }),
  setLibraryDragPos: (pos) => set({ libraryDragPos: pos }),
  setAddToLibraryDraft: (snapshot) => set({ addToLibraryDraft: snapshot }),
  setRenderInPlaceClipId: (clipId) => set({ renderInPlaceClipId: clipId }),
  undoScope: null,
  setUndoScope: (scope) => set({ undoScope: scope }),
  setRecording: (v) => set({ recording: v }),
  toggleRecording: () => set((s) => ({ recording: !s.recording })),
  setExportDialogOpen: (open, intent) =>
    set({ exportDialogOpen: open, exportIntent: open ? (intent ?? null) : null }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),
  openSettingsAt: (tab) => set({ settingsTab: tab, settingsDialogOpen: true }),
  setVariablesOpen: (open) => set({ variablesOpen: open }),
  revealVariable: (id) => set({ variablesOpen: true, variablesFocusId: id }),
  clearVariableFocus: () => set({ variablesFocusId: null }),
  setConsoleOpen: (open) => set({ consoleOpen: open }),
  setActivityOpen: (open) => set({ activityOpen: open }),

  pruneSelection: (existingClipIds, existingFrameIds) =>
    set((s) => {
      const kept = s.selectedClipIds.filter((id) => existingClipIds.has(id));
      const keptFrames = s.selectedFrameIds.filter((id) => existingFrameIds.has(id));
      const frameOk = keptFrames.length === s.selectedFrameIds.length;
      const openKept = s.openTimelineIds.filter((id) => existingFrameIds.has(id));
      const doc = peekDoc();
      // The navigation heals itself: `normalizePath` truncates to the longest
      // still-valid prefix and the leaf drops if its clip is gone. One rule,
      // instead of five parallel "is this id still alive?" checks that could
      // each survive independently and leave the nav half-valid.
      const leafOk = !s.nav.leaf || existingClipIds.has(s.nav.leaf.clipId);
      const rootOk = existingFrameIds.has(s.nav.path.rootFrameId);
      const healed = doc
        ? navigateNav(
            doc,
            s.nav,
            rootOk ? s.nav.path : { rootFrameId: openKept[openKept.length - 1] ?? "", hops: [] },
            { leaf: leafOk ? s.nav.leaf : null },
          )
        : s.nav;
      const projected = doc ? navProjection(doc, healed) : null;
      const navChanged =
        !doc ||
        healed.path.rootFrameId !== s.nav.path.rootFrameId ||
        healed.path.hops.length !== s.nav.path.hops.length ||
        healed.leaf !== s.nav.leaf ||
        // …or the PROJECTION is stale even though the nav is not. That is not a
        // hypothetical: the nav has no root until you deliberately navigate,
        // while the timeline has always fallen back to the document's first
        // frame — so a freshly opened project sat with `timeSurfaceId: ""`, the
        // store's pre-document value, for the whole session. Comparing what the
        // projection WOULD say (rather than only whether the nav moved) is what
        // makes a projection that drifted heal itself on the next document tick.
        projected!.timeSurfaceId !== s.timeSurfaceId;
      if (
        kept.length === s.selectedClipIds.length &&
        frameOk &&
        !navChanged &&
        openKept.length === s.openTimelineIds.length
      ) {
        // THE STATE ITSELF, not `{}`. This runs on every document write, and
        // zustand only skips notifying when the updater returns the object it
        // was given — `{}` is a different object, so it merges into a fresh
        // state and wakes every session subscriber. The nothing-changed case is
        // the overwhelmingly common one, so that was a second full React pass
        // per edit, spent to discover that the selection was still valid.
        return s;
      }
      return {
        selectedClipIds: kept,
        selectedFrameIds: frameOk ? s.selectedFrameIds : keptFrames,
        openTimelineIds: openKept,
        ...(projected ?? {}),
      };
    }),
}));

// ── The playhead a view of a still frame reads ──────────────────────────────

/** Is the transport running — playing, or building a range (which plays unpaced)? */
const transportRunning = (s: Pick<SessionState, "playing" | "prerenderProgress">): boolean =>
  s.playing || s.prerenderProgress !== null;

/** The playhead as it stood the last time the transport was NOT running. */
let parkedPlayheadMs = useSession.getState().playheadMs;
useSession.subscribe((s) => {
  if (!transportRunning(s)) parkedPlayheadMs = s.playheadMs;
});

/** Re-renders only when the transport starts or stops. */
export function useTransportRunning(): boolean {
  return useSession(transportRunning);
}

/**
 * THE PLAYHEAD FOR A VIEW OF A STILL FRAME — every panel, inspector readout and
 * editing overlay. While parked or scrubbing it IS the playhead; while the
 * transport runs it HOLDS where it was, and the view catches up the moment you
 * stop.
 *
 * Playback never re-renders React. Thirty components subscribed to
 * `playheadMs` itself, so every one of them — and the whole inspector under
 * `useResolvedDoc`, which re-baked the document per frame for any project with
 * an expression — rendered twenty-five times a second while playing: a third of
 * a second of every three on the Playground cover, plus the DOM work that
 * followed it. The canvas draws the motion; the timeline's playhead moves
 * itself imperatively.
 *
 * `when` false subscribes to nothing (a constant), for a view that needs the
 * playhead only in some states.
 */
export function useParkedPlayhead(when = true): number {
  return useSession((s) => (!when ? 0 : transportRunning(s) ? parkedPlayheadMs : s.playheadMs));
}

/** Stage viewport (pan/zoom of the canvas), separate so overlays can track it. */
interface StageView {
  scale: number;
  tx: number;
  ty: number;
  set: (v: { scale: number; tx: number; ty: number }) => void;
}

export const useStageView = create<StageView>((set) => ({
  scale: 0.3,
  tx: 0,
  ty: 0,
  set: (v) => set(v),
}));

/**
 * THE CAMERA, FOR REACT — at most once per animation frame.
 *
 * `useStageView` is written on every wheel and pointer event, and a trackpad
 * sends several per frame. The canvas does not care: it reads the store when
 * it draws, once a frame. But a component subscribed to the store re-rendered
 * on every one of those writes — the rulers repainted, the selection callout
 * re-placed itself, a text editor re-laid its box — two or three times for
 * each frame anyone could see, on the main thread the pan itself needs.
 *
 * So anything in React that FOLLOWS the camera subscribes here: the writes of
 * a frame collapse into one notification, delivered in that frame's animation
 * callback, and the render it causes is synchronous — it lands in the same
 * frame as the canvas's own draw, so a DOM overlay stays locked to the pixels
 * under it. A selector for one field (`useStageView((v) => v.scale)`) is still
 * fine where only that field matters: panning never re-renders it.
 */
const cameraFrameListeners = new Set<() => void>();
let cameraFrame = 0;
useStageView.subscribe(() => {
  if (cameraFrame !== 0 || cameraFrameListeners.size === 0) return;
  cameraFrame = requestAnimationFrame(() => {
    cameraFrame = 0;
    for (const notify of [...cameraFrameListeners]) notify();
  });
});
const subscribeCameraFrame = (notify: () => void) => {
  cameraFrameListeners.add(notify);
  return () => {
    cameraFrameListeners.delete(notify);
  };
};

export function useStageCamera(): StageView {
  return useSyncExternalStore(subscribeCameraFrame, useStageView.getState, useStageView.getState);
}


/**
 * Why the transport will not run here, or null. A still has no clock: standing
 * in one on its own there is nothing to play, and standing BENEATH one the
 * picture is pinned to the still's moment — the playhead there picks that
 * moment (see `useStillMoments`) rather than running. A still inside a sheet is
 * a drawing, and the sheet above it keeps time, so that one plays.
 */
function stillBlocksPlayback(nav: NavState, playheadMs: number): string | null {
  const doc = peekDoc();
  if (!doc) return null;
  const ctx = contextOf(doc, nav, playheadMs);
  if (!ctx) return null;
  if (ctx.hops.some((h) => h.parent.mode === "static")) return "Inside a static frame — scrub to pick the moment it shows";
  if (ctx.target.mode === "static" && !flipbookInContext(doc, ctx.target.id)) return "A static frame has no playback";
  return null;
}

/**
 * The editor's session as the command API reads it — where "here" is for every
 * caller that drives the registry from inside the app (the chat, MCP, quick
 * actions, scripts). One answer, so they can never disagree about the focus.
 */
export function editorApiSession(): ApiSession {
  return {
    focusFrameId: () => useSession.getState().activeFrameId,
    playheadMs: () => useSession.getState().playheadMs,
    selection: () => useSession.getState().selectedClipIds,
  };
}
