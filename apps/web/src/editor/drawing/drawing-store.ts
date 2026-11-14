"use client";

import { create } from "zustand";
import {
  BRUSH_SCHEMA_VERSION,
  brushLibrarySchema,
  createId,
  defaultBrushes,
  DEFAULT_CAPTURE_SEED,
  DEFAULT_FREEHAND_FIDELITY,
  DEFAULT_ONION_SETTINGS,
  DEFAULT_PATH_FIDELITY,
  DEFAULT_PRESSURE_SETTINGS,
  FIDELITY_RANGE,
  duplicateBrushPreset,
  toggleReference,
  type BrushEngine,
  type BrushFolder,
  type BrushPreset,
  type CaptureSeed,
  type LayerScope,
  type MaskCombine,
  type OnionSettings,
  type PathFidelity,
  type PressureSettings,
  DEFAULT_PAINT_SCOPE,
  type PaintReference,
  type PaintScope,
  type VectorEraseMode,
  type VectorLassoMode,
} from "@solomotion/core";

/**
 * Which brush a tool is armed with. Three slots, not two: the eraser carries
 * its own brush the way Procreate's does, so switching to it never disturbs the
 * brush you were painting with — and erasing with a soft or textured tip is a
 * setting rather than a hard-coded hard round.
 */
export type BrushSlot = BrushEngine | "eraser";

/** The brush the given slot is armed with (falls back to the first factory). */
export function armedBrushFor(slot: BrushSlot): BrushPreset {
  const lib = useBrushLibrary.getState();
  return lib.brushById(lib.activeBrushId(slot)) ?? defaultBrushes()[0]!;
}

/** The brush the brush tool would paint with right now (engine-aware). */
export function armedBrush(): BrushPreset {
  return armedBrushFor(useDrawing.getState().brush.engine);
}

/**
 * Drawing state — two stores, one file:
 *
 *  useBrushLibrary  ACCOUNT-level brushes (they follow the artist, not the
 *                   project). Factory presets are editable IN PLACE — the edit
 *                   is stored as an override beside the frozen original, so
 *                   Reset always exists — and the artist's own brushes and
 *                   folders live beside them. Persisted like the workspace store.
 *  useDrawing       Tool options + pressure + onion settings — the data behind
 *                   the stage tool-options bar and its popovers. Persisted so
 *                   an artist's eraser size survives a reload.
 *
 * Favoriting reuses the app-wide favorites (workspace store), same as
 * templates — a brush id is just another favoritable id.
 */

// ── Brush library ───────────────────────────────────────────────────────────

const BRUSHES_KEY = "tm-brushes-v1";

interface BrushLibraryState {
  customBrushes: BrushPreset[];
  /**
   * Factory brushes the artist has EDITED, stored whole and keyed by id.
   *
   * Editing a factory brush used to mean duplicating it, which is the wrong
   * answer to "make the pencil softer": you wanted a better pencil, not a
   * second one called "6B Pencil copy" sitting beside the original you now
   * have to avoid. Keeping the frozen original underneath is what makes Reset
   * a deletion rather than a guess, and lets the picker badge what has been
   * touched from a FACT rather than from a flag that could disagree with it.
   */
  overrides: Record<string, BrushPreset>;
  /** The artist's own shelves. Hold ids of any brush, factory or custom. */
  folders: BrushFolder[];
  /** Recently used brush ids, most recent first (capped). */
  recent: string[];
  /**
   * The shelf the library was last showing, per engine.
   *
   * Reopening on "All brushes" every time means scrolling past ninety brushes
   * to get back to the four you are working with — the library forgets what you
   * were doing the moment you close it. Per ENGINE because the pixel and vector
   * libraries are different places you are in the middle of different work in.
   */
  lastSet: Record<string, string>;
  /** Per-brush size/opacity tweaks from the options bar (any brush, incl. built-ins). */
  tweaks: Record<string, { size?: number; opacity?: number }>;
  /** The armed brush per slot (pixel brush, vector brush, eraser). */
  activeRasterBrushId: string;
  activeVectorBrushId: string;
  activeEraserBrushId: string;
  /** Brush open in the Brush Studio (null = studio closed). */
  studioBrushId: string | null;
  /**
   * Which tool's library is open (null = closed). The SLOT rather than a
   * boolean, because the window has to know which brush it is arming — and a
   * boolean plus "whatever tool is current" would arm the wrong one the moment
   * you switched tools with the library still open.
   */
  librarySlot: BrushSlot | null;

  allBrushes: () => BrushPreset[];
  brushById: (id: string) => BrushPreset | null;
  /** Has this factory brush been edited? (Derived — never stored.) */
  isCustomized: (id: string) => boolean;
  /** Effective size/opacity for a brush = preset base × options-bar tweak. */
  effective: (id: string) => { size: number; opacity: number };
  activeBrushId: (slot: BrushSlot) => string;
  setActiveBrush: (slot: BrushSlot, id: string) => void;
  setTweak: (id: string, patch: { size?: number; opacity?: number }) => void;
  duplicateBrush: (id: string) => BrushPreset | null;
  /** A blank brush of `engine`, added and returned (the studio's "New"). */
  createBrush: (engine: BrushEngine, from?: BrushPreset) => BrushPreset;
  updateBrush: (id: string, patch: Partial<BrushPreset>) => void;
  /** Drop a factory brush's override — back to how it shipped. */
  resetBrush: (id: string) => void;
  deleteBrush: (id: string) => void;
  noteUsed: (id: string) => void;
  setLastSet: (engine: string, setId: string) => void;
  addFolder: (name: string) => BrushFolder;
  renameFolder: (id: string, name: string) => void;
  setFolderIcon: (id: string, icon: string) => void;
  deleteFolder: (id: string) => void;
  /** Put a brush in / take it out of a folder. Folders own no brush. */
  setInFolder: (folderId: string, brushId: string, member: boolean) => void;
  openStudio: (id: string | null) => void;
  openLibrary: (slot: BrushSlot | null) => void;
  /** ⌘Z inside the Brush Studio — see `undoScope`. */
  undo: () => boolean;
  redo: () => boolean;
}

/**
 * Brush history — the same shape as the document store's, at the scale this
 * needs.
 *
 * Brushes are ACCOUNT-level, so they carry no document patches and ⌘Z used to
 * pass straight over the slider you were dragging. A preset is a few hundred
 * bytes of JSON, so whole snapshots cost nothing and there is no reason to
 * reach for patches; what it does borrow is the merge window, because a slider
 * drag is one edit and fifty undo steps is not an undo stack, it is a rewind.
 *
 * The merge key is DERIVED by diffing (`changedPaths`) rather than passed in:
 * the studio writes whole cloned presets, so every call would otherwise look
 * identical. Dragging one slider keeps the same key and coalesces; moving to a
 * different control changes it and starts a new step — with no call site having
 * to remember to say so.
 */
interface BrushSnapshot {
  customBrushes: BrushPreset[];
  overrides: Record<string, BrushPreset>;
  folders: BrushFolder[];
  tweaks: Record<string, { size?: number; opacity?: number }>;
}

const BRUSH_MERGE_MS = 700;

/** Leaf paths that differ between two values — the studio's edit, identified. */
function changedPaths(a: unknown, b: unknown, prefix = ""): string[] {
  if (a === b) return [];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return [prefix];
  }
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out.push(
      ...changedPaths(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        prefix ? `${prefix}.${key}` : key,
      ),
    );
  }
  return out;
}

interface PersistedBrushes {
  customBrushes: BrushPreset[];
  overrides: Record<string, BrushPreset>;
  folders: BrushFolder[];
  recent: string[];
  lastSet: Record<string, string>;
  tweaks: Record<string, { size?: number; opacity?: number }>;
  activeRasterBrushId: string;
  activeVectorBrushId: string;
  activeEraserBrushId: string;
}

/** What a fresh install arms. */
const FIRST_RASTER = "brush_pen_studio";
const FIRST_VECTOR = "brush_vector_pen";
const FIRST_ERASER = "brush_rt_eraser_soft";
const RECENT_MAX = 12;

function loadBrushes(): PersistedBrushes {
  const fallback: PersistedBrushes = {
    customBrushes: [],
    overrides: {},
    folders: [],
    recent: [],
    lastSet: {},
    tweaks: {},
    activeRasterBrushId: FIRST_RASTER,
    activeVectorBrushId: FIRST_VECTOR,
    activeEraserBrushId: FIRST_ERASER,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(BRUSHES_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedBrushes> & { library?: unknown };
    const lib = brushLibrarySchema.safeParse(parsed.library);
    return {
      customBrushes: lib.success ? lib.data.customBrushes : [],
      overrides: lib.success ? lib.data.overrides : {},
      folders: lib.success ? lib.data.folders : [],
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(0, RECENT_MAX) : [],
      lastSet: parsed.lastSet && typeof parsed.lastSet === "object" ? parsed.lastSet : {},
      tweaks: parsed.tweaks ?? {},
      activeRasterBrushId: parsed.activeRasterBrushId ?? fallback.activeRasterBrushId,
      activeVectorBrushId: parsed.activeVectorBrushId ?? fallback.activeVectorBrushId,
      activeEraserBrushId: parsed.activeEraserBrushId ?? fallback.activeEraserBrushId,
    };
  } catch {
    return fallback;
  }
}

function persistBrushes(s: PersistedBrushes): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      BRUSHES_KEY,
      JSON.stringify({
        library: {
          version: BRUSH_SCHEMA_VERSION,
          customBrushes: s.customBrushes,
          overrides: s.overrides,
          folders: s.folders,
          order: [],
        },
        recent: s.recent,
        lastSet: s.lastSet,
        tweaks: s.tweaks,
        activeRasterBrushId: s.activeRasterBrushId,
        activeVectorBrushId: s.activeVectorBrushId,
        activeEraserBrushId: s.activeEraserBrushId,
      }),
    );
  } catch {
    // Quota / private mode — brushes just won't persist this change.
  }
}

export const useBrushLibrary = create<BrushLibraryState>((set, get) => {
  let past: BrushSnapshot[] = [];
  let future: BrushSnapshot[] = [];
  let lastKey: string | null = null;
  let lastAt = 0;

  const snapshot = (): BrushSnapshot => ({
    customBrushes: structuredClone(get().customBrushes),
    overrides: structuredClone(get().overrides),
    folders: structuredClone(get().folders),
    tweaks: structuredClone(get().tweaks),
  });

  /** Record the state BEFORE an edit, coalescing a continuing gesture. */
  const remember = (mergeKey: string | null) => {
    const now = Date.now();
    const continues = mergeKey !== null && mergeKey === lastKey && now - lastAt < BRUSH_MERGE_MS;
    lastKey = mergeKey;
    lastAt = now;
    if (continues) return;
    past.push(snapshot());
    if (past.length > 100) past.shift();
    future = [];
  };

  const save = (patch: Partial<PersistedBrushes>) =>
    set((s) => {
      const next: PersistedBrushes = {
        customBrushes: patch.customBrushes ?? s.customBrushes,
        overrides: patch.overrides ?? s.overrides,
        folders: patch.folders ?? s.folders,
        recent: patch.recent ?? s.recent,
        lastSet: patch.lastSet ?? s.lastSet,
        tweaks: patch.tweaks ?? s.tweaks,
        activeRasterBrushId: patch.activeRasterBrushId ?? s.activeRasterBrushId,
        activeVectorBrushId: patch.activeVectorBrushId ?? s.activeVectorBrushId,
        activeEraserBrushId: patch.activeEraserBrushId ?? s.activeEraserBrushId,
      };
      persistBrushes(next);
      return next;
    });

  /** Restore a snapshot, pushing the current state onto the opposite stack. */
  const travel = (from: BrushSnapshot[], to: BrushSnapshot[]): boolean => {
    const entry = from.pop();
    if (!entry) return false;
    to.push(snapshot());
    lastKey = null;
    save(entry);
    return true;
  };

  /**
   * The composed library, memoised on the three slices that can change it.
   *
   * `allBrushes()` is called by every card, every preview and every selector,
   * so composing ~130 presets fresh each time was a real cost with a real
   * symptom: a new array reference each call means any component selecting it
   * re-renders forever. One cache keyed on identity fixes both.
   */
  let composed: { key: unknown[]; list: BrushPreset[] } | null = null;

  return {
    ...loadBrushes(),
    studioBrushId: null,
    librarySlot: null,

    // The whole factory pack (the drawing tools offer the stroke library as
    // brushes too), each entry replaced by its override where one exists, then
    // the artist's own brushes.
    allBrushes: () => {
      const s = get();
      const key = [s.overrides, s.customBrushes];
      if (composed && composed.key[0] === key[0] && composed.key[1] === key[1]) return composed.list;
      const list = [
        ...defaultBrushes().map((b) => s.overrides[b.id] ?? b),
        ...s.customBrushes,
      ];
      composed = { key, list };
      return list;
    },
    brushById: (id) => get().allBrushes().find((b) => b.id === id) ?? null,
    isCustomized: (id) => id in get().overrides,
    effective: (id) => {
      const brush = get().brushById(id);
      const tweak = get().tweaks[id];
      return {
        size: tweak?.size ?? brush?.size ?? 12,
        opacity: tweak?.opacity ?? brush?.opacity ?? 1,
      };
    },
    activeBrushId: (slot) => {
      const s = get();
      if (slot === "vector") return s.activeVectorBrushId;
      return slot === "eraser" ? s.activeEraserBrushId : s.activeRasterBrushId;
    },
    setActiveBrush: (slot, id) => {
      save(
        slot === "vector"
          ? { activeVectorBrushId: id }
          : slot === "eraser"
            ? { activeEraserBrushId: id }
            : { activeRasterBrushId: id },
      );
      get().noteUsed(id);
    },
    noteUsed: (id) => save({ recent: [id, ...get().recent.filter((r) => r !== id)].slice(0, RECENT_MAX) }),
    setLastSet: (engine, setId) => save({ lastSet: { ...get().lastSet, [engine]: setId } }),
    setTweak: (id, patch) => {
      remember(`tweak:${id}:${Object.keys(patch).join(",")}`);
      save({ tweaks: { ...get().tweaks, [id]: { ...get().tweaks[id], ...patch } } });
    },
    duplicateBrush: (id) => {
      const source = get().brushById(id);
      if (!source) return null;
      const copy = duplicateBrushPreset(source);
      remember(null);
      save({ customBrushes: [...get().customBrushes, copy] });
      return copy;
    },
    createBrush: (engine, from) => {
      const base = from ?? get().brushById(engine === "vector" ? FIRST_VECTOR : FIRST_RASTER);
      const brush: BrushPreset = {
        ...structuredClone(base ?? defaultBrushes()[0]!),
        id: createId("brush"),
        name: "New brush",
        engine,
        group: "My brushes",
        builtIn: false,
      };
      remember(null);
      save({ customBrushes: [...get().customBrushes, brush] });
      return brush;
    },
    /**
     * Write an edit, into the custom list or into the override map — the ONE
     * place that decides which, so no caller has to know whether the brush it
     * is editing shipped with the app.
     */
    updateBrush: (id, patch) => {
      const s = get();
      const before = s.customBrushes.find((b) => b.id === id) ?? s.overrides[id] ?? s.brushById(id);
      if (!before) return;
      const next = { ...before, ...patch, id };
      const paths = changedPaths(before, next);
      // Nothing actually changed — a re-render, not an edit. Never a history step.
      if (paths.length === 0) return;
      remember(`brush:${id}:${paths.sort().join(",")}`);
      if (s.customBrushes.some((b) => b.id === id)) {
        save({ customBrushes: s.customBrushes.map((b) => (b.id === id ? next : b)) });
      } else {
        save({ overrides: { ...s.overrides, [id]: next } });
      }
    },
    resetBrush: (id) => {
      const s = get();
      if (!(id in s.overrides)) return;
      remember(null);
      const { [id]: _dropped, ...rest } = s.overrides;
      save({ overrides: rest });
    },
    deleteBrush: (id) => {
      const s = get();
      remember(null);
      const { [id]: _dropped, ...overrides } = s.overrides;
      save({
        customBrushes: s.customBrushes.filter((b) => b.id !== id),
        overrides,
        folders: s.folders.map((f) => ({ ...f, brushIds: f.brushIds.filter((b) => b !== id) })),
        recent: s.recent.filter((r) => r !== id),
        ...(s.activeRasterBrushId === id ? { activeRasterBrushId: FIRST_RASTER } : {}),
        ...(s.activeVectorBrushId === id ? { activeVectorBrushId: FIRST_VECTOR } : {}),
        ...(s.activeEraserBrushId === id ? { activeEraserBrushId: FIRST_ERASER } : {}),
      });
      if (s.studioBrushId === id) set({ studioBrushId: null });
    },
    addFolder: (name) => {
      const folder: BrushFolder = { id: createId("bfolder"), name, icon: "folder", brushIds: [] };
      remember(null);
      save({ folders: [...get().folders, folder] });
      return folder;
    },
    renameFolder: (id, name) => {
      remember(`folder-name:${id}`);
      save({ folders: get().folders.map((f) => (f.id === id ? { ...f, name } : f)) });
    },
    setFolderIcon: (id, icon) => {
      remember(null);
      save({ folders: get().folders.map((f) => (f.id === id ? { ...f, icon } : f)) });
    },
    deleteFolder: (id) => {
      remember(null);
      save({ folders: get().folders.filter((f) => f.id !== id) });
    },
    setInFolder: (folderId, brushId, member) => {
      remember(null);
      save({
        folders: get().folders.map((f) =>
          f.id !== folderId
            ? f
            : {
                ...f,
                brushIds: member
                  ? f.brushIds.includes(brushId) ? f.brushIds : [...f.brushIds, brushId]
                  : f.brushIds.filter((b) => b !== brushId),
              },
        ),
      });
    },
    openStudio: (id) => set({ studioBrushId: id }),
    openLibrary: (slot) => set({ librarySlot: slot }),
    undo: () => travel(past, future),
    redo: () => travel(future, past),
  };
});

// ── Tool options (the options-bar data) ─────────────────────────────────────

/** Where multi-layer tools read from / act on (the headless rule owns it). */
export type { LayerScope };

export interface EraserOptions {
  size: number;
  opacity: number;
  scope: LayerScope;
  /** What erasing MEANS on vector art — pixels have only one meaning. */
  vectorMode: VectorEraseMode;
  /** Hand stabilising + the density of the outline a cut hands back. */
  fidelity: PathFidelity;
}

/**
 * The bucket's own settings — which is now only its COLOUR.
 *
 * Tolerance, gap closing, expand, feather and over/under all moved to
 * `PaintScope`, because they were never the bucket's: a confined brush stroke
 * asks the identical questions and used to have no answer for any of them. The
 * bucket is a confined mark with a flood instead of a nib.
 */
export interface FillOptions {
  color: string;
  /** Take every matching pixel, not just the connected region (wand-style). */
  global: boolean;
}

/** How you DRAW a lasso selection — the process differs, the result (a mask) is
 *  identical, so every shape flows through the one selection pipeline. */
export type LassoShape = "free" | "rect" | "poly";

export interface LassoOptions {
  /** Wand tolerance, 0..1 (free lasso ignores it). */
  tolerance: number;
  scope: LayerScope;
  /** Wand: contiguous region vs. same color anywhere. */
  contiguous: boolean;
  /** Active lasso sub-tool (free / rectangle / polygon). Wand ignores it. */
  shape: LassoShape;
  /** How a new selection merges with the live one (add/subtract/intersect). A
   *  lasso-family option, shared across every sub-tool AND the wand. */
  combine: MaskCombine;
  /** What the loop does to vector art: cut it into pieces, or pick it whole. */
  vectorMode: VectorLassoMode;
  /** Hand stabilising + the density of the outline a cut hands back. */
  fidelity: PathFidelity;
}

/**
 * Drawing OVER TIME — what the next stroke does when a frame has to be born.
 * A tool preference (it follows the artist, not the project), which is why it
 * lives here beside pressure and onion rather than on the clip: the clip stores
 * the frames, this stores the habit that makes them.
 */
export interface CaptureOptions {
  seed: CaptureSeed;
}

export interface BrushToolOptions {
  /** Paint color (raster dabs / vector stroke paint). */
  color: string;
  /**
   * Which engine the brush tool is in: pixel dabs or fitted vector paths.
   * Auto-follows the selected layer's kind (a raster layer arms px, a path
   * arms vector) but the options-bar switch always overrides by hand.
   */
  engine: BrushEngine;
  /**
   * Hand stabilising + how finely a vector stroke is fitted.
   *
   * The same `PathFidelity` the eraser and lasso carry — one type, one set of
   * controls, three tools — with a looser default, because a freehand line's
   * wobble is hand noise while a carve's detail is the artwork's own edge. It
   * is the TOOL's, not the brush's: point density describes the drawing you
   * are making, and the preset's `vector.fitTolerance` stays the brush's own
   * baseline for the places with no tool to ask (studio previews, thumbnails).
   */
  fidelity: PathFidelity;
}

interface DrawingState {
  brush: BrushToolOptions;
  eraser: EraserOptions;
  fill: FillOptions;
  lasso: LassoOptions;
  /**
   * WHERE a mark may go, shared by every paint tool. One value, because
   * "inside this outline", "under what is there" and "close gaps up to 4px" are
   * facts about the gesture, not about which nib is on it — and an artist who
   * sets up a reference and switches from brush to bucket means to keep it.
   */
  scope: PaintScope;
  pressure: PressureSettings;
  onion: OnionSettings;
  capture: CaptureOptions;

  setBrushOptions: (patch: Partial<BrushToolOptions>) => void;
  setEraserOptions: (patch: Partial<EraserOptions>) => void;
  setFillOptions: (patch: Partial<FillOptions>) => void;
  setLassoOptions: (patch: Partial<LassoOptions>) => void;
  setScope: (patch: Partial<PaintScope>) => void;
  /** Add / remove one reference source — the verb behind every right-click. */
  toggleRef: (ref: PaintReference) => void;
  clearRefs: () => void;
  setPressure: (patch: Partial<PressureSettings>) => void;
  setOnion: (patch: Partial<OnionSettings>) => void;
  setCapture: (patch: Partial<CaptureOptions>) => void;
}

const DRAWING_KEY = "tm-drawing-v1";

type PersistedDrawing = Pick<
  DrawingState,
  "brush" | "eraser" | "fill" | "lasso" | "scope" | "pressure" | "onion" | "capture"
>;

const DRAWING_DEFAULTS: PersistedDrawing = {
  brush: { color: "#F4F2ED", engine: "raster", fidelity: DEFAULT_FREEHAND_FIDELITY },
  eraser: { size: 24, opacity: 1, scope: "current", vectorMode: "split", fidelity: DEFAULT_PATH_FIDELITY },
  fill: { color: "#F5B843", global: false },
  scope: DEFAULT_PAINT_SCOPE,
  lasso: {
    tolerance: 0.15,
    scope: "current",
    contiguous: true,
    shape: "free",
    combine: "new",
    vectorMode: "cut",
    fidelity: DEFAULT_PATH_FIDELITY,
  },
  pressure: DEFAULT_PRESSURE_SETTINGS,
  onion: DEFAULT_ONION_SETTINGS,
  capture: { seed: DEFAULT_CAPTURE_SEED },
};

/** A stored fidelity, clamped — an old or hand-edited value cannot arm a
 *  setting the UI would refuse, and a missing field falls back to the default. */
function mergeFidelity(base: PathFidelity, saved: Partial<PathFidelity> | undefined): PathFidelity {
  const pick = (v: number | undefined, fallback: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    smoothing: pick(saved?.smoothing, base.smoothing, FIDELITY_RANGE.smoothing.min, FIDELITY_RANGE.smoothing.max),
    simplify: pick(saved?.simplify, base.simplify, FIDELITY_RANGE.simplify.min, FIDELITY_RANGE.simplify.max),
    corner: pick(saved?.corner, base.corner, FIDELITY_RANGE.corner.min, FIDELITY_RANGE.corner.max),
  };
}

function loadDrawing(): PersistedDrawing {
  if (typeof window === "undefined") return DRAWING_DEFAULTS;
  try {
    const raw = window.localStorage.getItem(DRAWING_KEY);
    if (!raw) return DRAWING_DEFAULTS;
    const p = JSON.parse(raw) as Partial<PersistedDrawing>;
    return {
      brush: { ...DRAWING_DEFAULTS.brush, ...p.brush, fidelity: mergeFidelity(DRAWING_DEFAULTS.brush.fidelity, p.brush?.fidelity) },
      eraser: { ...DRAWING_DEFAULTS.eraser, ...p.eraser, fidelity: mergeFidelity(DRAWING_DEFAULTS.eraser.fidelity, p.eraser?.fidelity) },
      fill: { ...DRAWING_DEFAULTS.fill, ...p.fill },
      // References point at clips in ONE document, so they can never be
      // restored into another — the settings persist, the targets do not.
      scope: { ...DRAWING_DEFAULTS.scope, ...p.scope, refs: [] },
      lasso: { ...DRAWING_DEFAULTS.lasso, ...p.lasso, fidelity: mergeFidelity(DRAWING_DEFAULTS.lasso.fidelity, p.lasso?.fidelity) },
      pressure: {
        ...DRAWING_DEFAULTS.pressure,
        ...p.pressure,
        size: { ...DRAWING_DEFAULTS.pressure.size, ...p.pressure?.size },
        opacity: { ...DRAWING_DEFAULTS.pressure.opacity, ...p.pressure?.opacity },
      },
      onion: onionFromStore(p.onion),
      capture: { ...DRAWING_DEFAULTS.capture, ...p.capture },
    };
  } catch {
    return DRAWING_DEFAULTS;
  }
}

/**
 * Stored onion settings, with the OLD fixed red/green defaults read as "the
 * theme's" (null): those were never a person's pick, just what every install
 * stored, and keeping them would pin a re-themed studio to someone else's hues.
 */
function onionFromStore(stored: Partial<OnionSettings> | undefined): OnionSettings {
  const o = { ...DRAWING_DEFAULTS.onion, ...stored };
  if (o.prevColor?.toUpperCase() === "#E5484D") o.prevColor = null;
  if (o.nextColor?.toUpperCase() === "#30A46C") o.nextColor = null;
  return o;
}

export const useDrawing = create<DrawingState>((set, get) => {
  const save = (patch: Partial<PersistedDrawing>) =>
    set((s) => {
      const next: PersistedDrawing = {
        brush: patch.brush ?? s.brush,
        eraser: patch.eraser ?? s.eraser,
        fill: patch.fill ?? s.fill,
        lasso: patch.lasso ?? s.lasso,
        scope: patch.scope ?? s.scope,
        pressure: patch.pressure ?? s.pressure,
        onion: patch.onion ?? s.onion,
        capture: patch.capture ?? s.capture,
      };
      try {
        window.localStorage.setItem(DRAWING_KEY, JSON.stringify(next));
      } catch {
        // Private mode etc. — options just won't persist.
      }
      return next;
    });

  return {
    ...loadDrawing(),
    setBrushOptions: (patch) => save({ brush: { ...get().brush, ...patch } }),
    setEraserOptions: (patch) => save({ eraser: { ...get().eraser, ...patch } }),
    setFillOptions: (patch) => save({ fill: { ...get().fill, ...patch } }),
    setLassoOptions: (patch) => save({ lasso: { ...get().lasso, ...patch } }),
    setScope: (patch) => save({ scope: { ...get().scope, ...patch } }),
    toggleRef: (ref) => save({ scope: { ...get().scope, refs: toggleReference(get().scope.refs, ref) } }),
    clearRefs: () => save({ scope: { ...get().scope, refs: [] } }),
    setPressure: (patch) => save({ pressure: { ...get().pressure, ...patch } }),
    setOnion: (patch) => save({ onion: { ...get().onion, ...patch } }),
    setCapture: (patch) => save({ capture: { ...get().capture, ...patch } }),
  };
});
