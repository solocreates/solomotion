import { bearingOf, cursors, moveAxisCursor, resizeCursor, rotateCursor } from "@solomotion/ui/cursors";
import * as THREE from "three";
import { createRenderer } from "../engine/gpu";

/** The browser would not give this viewport a WebGL context (see engine/gpu.ts). */
export class GpuUnavailableError extends Error {}
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  EMPTY_SELECTION,
  DEFAULT_CAMERA_SPEC,
  cameraEvalOf,
  type CameraEval,
  aimRotation,
  scale4,
  add,
  convertSelection,
  cross,
  dot,
  edgeKey,
  edgeLoop,
  edgeRing,
  evaluateWorld,
  objectMotionPath,
  type MotionDocument,
  type Frame,
  locateClip,
  loopCut,
  writeChannel,
  extrude,
  insetFaces,
  invert4,
  localToPlane,
  planeBasis,
  isSpatialClip,
  length3,
  linkedVerts,
  matAxis,
  matPosition,
  meshEdges,
  meshBounds,
  mul4,
  normalize3,
  objectWorldBounds,
  rotation4,
  scale3,
  selectedVerts,
  selectionMedian,
  selectionNormal,
  sub,
  transformPoint,
  transformVerts,
  transformVertsWeighted,
  proportionalWeights,
  bisect,
  selectedFaces,
  translate4,
  type CameraClip,
  type EmptyClip,
  type DocumentStore,
  type LightClip,
  type Mat4,
  type MeshData,
  type PenSample,
  type MeshClip,
  type MeshSelection,
  type V3,
  type WorldEval,
  type WorldObject,
  PenSampleNormalizer,
  SCULPT_SPACING,
  SculptSession,
  dabsAlong,
  pageFor,
  pageForward,
  resolveColor,
  transformDir,
  type DrawPage,
  type SculptStroke,
  type LayerBasis,
  type Subpath,
  copySubpaths,
  runNodeVerb,
  type NodeRef,
  pathOutlineAt,
  writePathOutline,
  type PathClip,
  falloff,
  grabContours,
  planeToLocal,
  sculptContours,
  sculptsPaths,
} from "@solomotion/core";
import type { WorldEngine } from "../engine";
import { UNIT, transparentSort, type SceneSync } from "../engine/sync";
import { SolveGuides } from "./solve-guides";
import { PostStack, postLookOf } from "../engine/post";
import { makeColorResolver } from "../../stage/render/paint-style";
import { resolvedDocAt } from "@solomotion/core";
import { gestureMods } from "../../input/modifiers";
import { beginConductPass, onMediaReady, pauseUnconductedElements, syncVideoFrames } from "../../stage/render/media-cache";
import { DrawGesture, type DrawLanding } from "../draw-stroke";
import { coalescedEvents } from "../../drawing/pen-input";
import { useDrawing } from "../../drawing/drawing-store";
import { useToolDefaults } from "../../state/tool-defaults";
import { useSession } from "../../state/session";
import { setMeasuredBoundsReader, useWorldUi, type WorldUi } from "../state";
import { WORLD_TOOLS, strokeToolOf, type StrokeTool } from "../tools";
import { commitMesh, commitPlacements, makeDefaultCameraReal, meshDataOf, parentMatrixOf, transformValuesFor } from "../commands";
import { editTargetFor, isPathTarget, vertsOfNodes, type CageMove, type EditTarget, type EditTargetContext, type PathEditTarget } from "../edit-targets";
import { DEFAULT_VIEW, applyView, eyeOf, frameBox, lerpView, orbit, pan, viewBasis, viewLabel, zoom, type ViewState } from "./view";
import { BoneLayer, type BoneModalTarget } from "./bones";
import { useRigUi } from "../../rig/state";
import { xrayOn } from "../state";
import { ACTIVE, AXIS_COLORS, SELECTED, SHEET, aimHelper, latticeHelper, cameraHelper, cursorHelper, emptyHelper, ensureSmoothNormals, lightHelper, makeGrid, outlineMaterial, pageHelper, pictureOutlineMaterial } from "./overlays";
import { EditOverlay } from "./edit-overlay";

/**
 * THE 3D VIEWPORT — Blender's grammar over the app's document.
 *
 * Owns a renderer, a scene sync and the viewport furniture, and turns pointer
 * and keyboard input into view changes, selections and document writes (all
 * writes through `world/commands`). It renders on demand: a cheap per-frame
 * comparison of what it last drew (document, playhead, selection, view, UI)
 * decides whether to draw at all, so a still viewport costs nothing.
 */

type ModalKind = "grab" | "rotate" | "scale" | "inset";
type GizmoPointer = Parameters<TransformControls["pointerDown"]>[0];

interface Constraint {
  dir: V3;
  /** True = the plane perpendicular to `dir` (Shift+axis). */
  plane: boolean;
  label: string;
  axis: 0 | 1 | 2 | null;
  local: boolean;
}

/** One line a sculpt stroke is moving: its space, its outline at the start and now. */
interface LineSculpt {
  clipId: string;
  matrix: Mat4;
  inv: Mat4;
  basis: LayerBasis;
  /** The layer's own time at the playhead — where a morphing outline is read and keyed. */
  local: number;
  start: Subpath[];
  now: Subpath[];
  weights: number[][] | null;
}

interface Modal {
  kind: ModalKind;
  start: [number, number];
  mouse: [number, number];
  pivot: V3;
  pivotScreen: [number, number];
  constraint: Constraint | null;
  typed: string;
  /** Object mode: each target's world matrix and parent at the start. */
  objects: Array<{ o: WorldObject; start: Mat4; parent: Mat4 }>;
  /** Edit mode: the mesh before the gesture and the vertices it moves. */
  edit: { clipId: string; target: EditTarget; startMesh: MeshData; verts: Set<number>; obj: Mat4; inv: Mat4; sel: MeshSelection; weights: Map<number, number> | null } | null;
  /** Local axes for a second press of X/Y/Z. */
  localAxes: Mat4;
  label: string;
  /** Shift was held from this mouse position: movement past it counts ×0.1. */
  precisionFrom: [number, number] | null;
  /** A whole extrude/duplicate is cancelled back to this document state. */
  cancelMesh?: MeshData;
  /** Rotation so far, unwrapped past ±180° so a full turn keeps counting. */
  accumulated?: number;
  /** Inset: the inner faces, selected once it lands. */
  insetSel?: MeshSelection;
  /** Object mode with bones picked: the modal moves them (a pose, or rest in Setup). */
  bones?: BoneModalTarget;
  /**
   * The plane a free move slides in when no axis is locked: a flat drawing's
   * own page (its points stay on it), else null — the view's plane.
   */
  plane?: V3 | null;
  /** A drag that began on a point: it follows THIS pointer and lands on its release. */
  tweak?: number;
  /** What the selection was before an extrude, put back if it is cancelled. */
  restoreSel?: MeshSelection;
}

export interface ViewportInfo {
  label: string;
  objectName: string;
  stats: string;
  frameName: string;
  through: boolean;
}

export class WorldViewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly sync: SceneSync;
  private readonly overlay = new THREE.Scene();
  private readonly overlayRoot = new THREE.Group();
  /** A camera solve's points and backplate, when this world is match-moved. */
  private readonly guides = new SolveGuides(this.overlayRoot);
  /** A selected rig's bones: drawn, picked and posed (`bones.ts`). */
  private readonly bones: BoneLayer;
  private readonly gridScene = new THREE.Scene();
  private readonly persp = new THREE.PerspectiveCamera();
  private readonly ortho = new THREE.OrthographicCamera();
  private throughCam: THREE.Camera | null = null;
  private camera: THREE.Camera = this.persp;
  private readonly grid = makeGrid();
  private readonly cursor = cursorHelper();
  /** The page the next stroke lands on, while the vector brush is out. */
  private readonly pageGrid = pageHelper();
  private readonly helpers = new Map<string, { line: THREE.LineSegments; key: string }>();
  /** Aim lines: where each selected camera (and the default one) is looking. */
  private readonly aims = new Map<string, THREE.LineSegments>();
  private readonly outlines = new Map<string, THREE.Object3D>();
  /** Motion paths of the selected travellers, rebuilt only when the document changes. */
  private readonly paths = new Map<string, { group: THREE.Group; key: string }>();
  private readonly editOverlay = new EditOverlay();
  private readonly gizmo: TransformControls;
  private readonly gizmoProxy = new THREE.Object3D();
  private gizmoStart: { pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 } | null = null;
  private readonly raycaster = new THREE.Raycaster();

  view: ViewState = { ...DEFAULT_VIEW };
  private viewAnim: { from: ViewState; to: ViewState; t0: number } | null = null;
  ev: WorldEval | null = null;
  private meshOverride = new Map<string, MeshData>();
  private modal: Modal | null = null;
  private drag: { kind: "orbit" | "pan" | "zoom" | "box" | "maybeClick" | "place" | "fill"; x: number; y: number; sx: number; sy: number; id: number; shift: boolean; ctrl: boolean; element?: { vert?: number; edge?: string; face?: number } | null; object?: string | null } | null = null;
  /**
   * ⌥-dragging a path's node pulls a fresh, balanced pair of handles out of it
   * (the flat pen's gesture): the node, the outline it started from, and the
   * plane the pointer is read on.
   */
  private pull: { id: number; target: PathEditTarget; ref: NodeRef; start: Subpath[]; at: V3; normal: V3; next: Subpath[] | null } | null = null;
  /**
   * THE ONE POINTER a gesture here belongs to. A second finger is never a
   * second gesture: it is the stage's two-finger navigation (`touchNavigate`),
   * and the arbiter ends this one first (`pointerEnded`). This replaced a
   * private touch table that `pointerUp` skipped while a stroke was in
   * flight, so a lifted finger stayed "down" forever and the next single
   * touch read as half of a pinch — the view that sometimes moved and
   * sometimes did not.
   */
  private owner: { id: number; type: string } | null = null;
  /** The gizmo is driving the owner's gesture; a cancel restores rather than confirms. */
  private gizmoDrive = false;
  private gizmoCancel = false;
  /** Only the overlay changed (a stroke growing, the brush ring moving): redraw it, not the world. */
  private hudDirty = false;
  private lastAspect = 1;
  /** Where a hovering pointer is — the sculpt brush's ring follows it. */
  private hover: [number, number] | null = null;
  private box: [number, number, number, number] | null = null;
  private hoverEdge: string | null = null;
  private lastMouse: [number, number] = [0, 0];
  private raf = 0;
  private drawnKey = "";
  private dirty = true;
  private width = 1;
  private height = 1;
  private disposed = false;
  onInfo: ((info: ViewportInfo) => void) | null = null;
  /** Draws the navigation gizmo for the view just rendered (imperative — no React per frame). */
  onNav: ((view: ViewState) => void) | null = null;
  onHud: ((hud: HTMLCanvasElement) => void) | null = null;
  /** Ask the React layer to open a menu at a point (add, delete, merge, context, view, shading, snap). */
  onMenu: ((menu: string, x: number, y: number) => void) | null = null;
  /** A click with the Text or Shape tool: what to place, where it lands, and what (if anything) it landed on. */
  onPlace: ((tool: "text" | "shape", at: V3, hitId: string | null) => void) | null = null;
  readonly hud: HTMLCanvasElement;
  private readonly hudCtx: CanvasRenderingContext2D;
  /**
   * THE THEME the viewport paints its furniture in — the app's stage colour for
   * the void, its foreground for grid, wires and guides — so a world sits in a
   * light theme as naturally as in a dark one. Set by the React layer from the
   * theme store; never read from the DOM per frame.
   */
  private theme = { void: new THREE.Color("#08080b"), ink: new THREE.Color("#ececf1"), wire: new THREE.Color("#8a8a94"), css: "236,236,241", light: false };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    hud: HTMLCanvasElement,
    private readonly engine: WorldEngine,
    private readonly store: DocumentStore,
    public frameId: string,
  ) {
    this.hud = hud;
    this.hudCtx = hud.getContext("2d")!;
    const renderer = createRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    if (!renderer) throw new GpuUnavailableError();
    this.renderer = renderer;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setTransparentSort(transparentSort as never);
    this.sync = engine.createSync();
    this.sync.onChange = () => (this.dirty = true);
    this.overlayRoot.scale.setScalar(UNIT);
    this.overlay.add(this.overlayRoot);
    this.gridScene.add(this.grid);
    this.cursor.scale.setScalar(1);
    this.overlay.add(this.cursor);
    this.overlay.add(this.pageGrid);
    this.overlayRoot.add(this.editOverlay.group);
    this.bones = new BoneLayer({
      store: this.store,
      toScreen: (p) => this.toScreen(p),
      hitPlane: (x, y, p, n) => this.hitPlane(x, y, p, n),
      forward: () => this.screenBasis().forward,
      frameId: () => this.ev?.frameId ?? null,
    });
    this.overlayRoot.add(this.bones.group);
    // The gizmo never listens to the DOM. Left connected, three's controls
    // took ANY pointer that landed on a handle (the second finger of a pinch,
    // a palm), followed every pointer's moves rather than its own, and never
    // heard `pointercancel` — so two fingers dragged objects and a cancelled
    // touch left a drag running. It is driven by the viewport's one gesture
    // owner instead (`gizmoDown`), like every other handle here.
    this.gizmo = new TransformControls(this.persp, canvas);
    this.gizmo.disconnect();
    this.gizmo.setSize(0.85);
    this.overlay.add(this.gizmoProxy);
    this.overlay.add(this.gizmo.getHelper());
    this.gizmo.addEventListener("dragging-changed", (e) => this.onGizmoDragging((e as unknown as { value: boolean }).value));
    this.gizmo.addEventListener("objectChange", () => this.onGizmoChange());
    this.gizmo.addEventListener("change", () => (this.dirty = true));
    this.restoreView();
    // A picture that was a placeholder (an image decoding, a model parsing)
    // became real: draw again, so the plane re-reads it.
    this.unsubMedia = onMediaReady(() => (this.dirty = true));
    // What a body really spans (its glyphs, its silhouette) — the engine is the
    // only one that knows; Add lattice fits its cage to it.
    setMeasuredBoundsReader((id) => {
      const m = this.sync.entries.get(id)?.geo?.mesh;
      return m && m.positions.length ? meshBounds(m) : null;
    });
    this.loop();
  }
  private readonly unsubMedia: () => void;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  resize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.renderer.setSize(this.width, this.height, false);
    const dpr = this.renderer.getPixelRatio();
    this.hud.width = Math.round(this.width * dpr);
    this.hud.height = Math.round(this.height * dpr);
    this.dirty = true;
  }

  private post: PostStack | null = null;

  dispose(): void {
    setMeasuredBoundsReader(null);
    this.post?.dispose();
    this.disposed = true;
    this.unsubMedia();
    cancelAnimationFrame(this.raf);
    this.persistView();
    this.store.setOverlay(null);
    this.bones.dispose();
    this.guides.dispose();
    this.gizmo.detach();
    this.gizmo.dispose();
    this.editOverlay.dispose();
    this.sync.dispose();
    this.renderer.dispose();
    // `dispose()` frees three's objects but not the WebGL CONTEXT: its drawing
    // buffers stay on the GPU until the canvas is garbage collected, which for
    // a large GPU footprint and a small JS one may be never. Every world opened
    // and closed kept ~50 MB of GPU memory alive.
    this.renderer.forceContextLoss();
  }

  private restoreView(): void {
    const frame = this.store.getState().frames.find((f) => f.id === this.frameId);
    const v = frame?.world?.view;
    if (v) this.view = { target: [...v.target] as V3, distance: v.distance, yaw: v.yaw, pitch: v.pitch, ortho: v.ortho, fov: DEFAULT_VIEW.fov };
    else this.pendingFrameAll = true;
    if (v) useWorldUi.getState().set({ shading: v.shading, xray: v.xray, gridSize: v.gridSize, gridDivisions: v.gridDivisions, grid: v.showGrid, overlays: v.showOverlays });
  }
  private pendingFrameAll = false;

  /** Where the view was left is saved with the project — view state, never an undo step. */
  persistView(): void {
    const ui = useWorldUi.getState();
    const v = this.view;
    this.store.remember((d) => {
      const f = d.frames.find((x) => x.id === this.frameId);
      if (!f?.world) return;
      f.world.view = {
        target: [...v.target] as [number, number, number],
        distance: v.distance,
        yaw: v.yaw,
        pitch: v.pitch,
        ortho: v.ortho,
        shading: ui.shading,
        xray: xrayOn(ui),
        gridSize: ui.gridSize,
        gridDivisions: ui.gridDivisions,
        showGrid: ui.grid,
        showOverlays: ui.overlays,
      };
    });
  }

  /** The cursor last written to the canvas. */
  private shownCursor = "";

  /**
   * What the pointer wears right now. One derivation, read every frame, so no
   * gesture has to remember to set or restore it: a running gesture speaks first,
   * then the gizmo handle under the pointer, then the tool.
   */
  private cursorNow(): string {
    const at = this.hover ?? this.lastMouse;
    if (this.gizmoStart || (this.gizmo.object && this.gizmo.axis && !this.modal && !this.drag)) return this.gizmoCursor(at);
    const m = this.modal;
    if (m) {
      const fromPivot = bearingOf(m.mouse[0] - m.pivotScreen[0], m.mouse[1] - m.pivotScreen[1]);
      if (m.kind === "rotate") return rotateCursor(fromPivot);
      if (m.kind === "grab") {
        const axis = m.constraint && !m.constraint.plane ? this.axisBearing(m.pivot, m.constraint.dir) : null;
        return axis === null ? cursors.move : moveAxisCursor(axis);
      }
      return resizeCursor(fromPivot);
    }
    if (this.drag?.kind === "orbit") return cursors.orbit;
    if (this.drag?.kind === "pan") return cursors.grabbing;
    if (this.drag?.kind === "zoom") return cursors.zoomIn;
    return WORLD_TOOLS[useWorldUi.getState().tool].cursor;
  }

  /** The on-screen direction of a world axis through a point, or null when it points at the eye. */
  private axisBearing(through: V3, dir: V3): number | null {
    const a = this.toScreen(through);
    const b = this.toScreen(add(through, scale3(dir, this.pixelSizeAt(through) * 40)));
    if (!a || !b || Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-3) return null;
    return bearingOf(b[0] - a[0], b[1] - a[1]);
  }

  /** The gizmo handle held or hovered: its own axis, as it projects on screen this frame. */
  private gizmoCursor(at: [number, number]): string {
    const handle = this.gizmo.axis ?? "";
    const p = this.gizmoProxy.position;
    const pivot: V3 = [p.x / UNIT, p.y / UNIT, p.z / UNIT];
    const centre = this.toScreen(pivot);
    const radial = centre ? bearingOf(at[0] - centre[0], at[1] - centre[1]) : 0;
    if (this.gizmo.mode === "rotate") return rotateCursor(radial);
    if (handle !== "X" && handle !== "Y" && handle !== "Z") {
      return this.gizmo.mode === "scale" ? resizeCursor(radial) : cursors.move;
    }
    const axis = new THREE.Vector3(handle === "X" ? 1 : 0, handle === "Y" ? 1 : 0, handle === "Z" ? 1 : 0);
    if (this.gizmo.space === "local") axis.applyQuaternion(this.gizmoProxy.quaternion);
    const bearing = this.axisBearing(pivot, [axis.x, axis.y, axis.z]);
    if (bearing === null) return cursors.move;
    return this.gizmo.mode === "scale" ? resizeCursor(bearing) : moveAxisCursor(bearing);
  }

  private loop = (): void => {
    const cursor = this.cursorNow();
    if (cursor !== this.shownCursor) {
      this.shownCursor = cursor;
      this.canvas.style.cursor = cursor;
    }
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const session = useSession.getState();
    const ui = useWorldUi.getState();
    const doc = this.store.getState();
    if (this.viewAnim) {
      const t = Math.min(1, (performance.now() - this.viewAnim.t0) / 220);
      this.view = lerpView(this.viewAnim.from, this.viewAnim.to, t);
      if (t >= 1) this.viewAnim = null;
      this.dirty = true;
    }
    // FOOTAGE. This viewport IS the stage while a world is open (CenterStage
    // mounts it instead of the flat Stage), so it conducts the videos the flat
    // stage's paint loop would — an exact seek while parked, rolling while
    // playing. Without it every video in a world stood on its first frame.
    // A landed seek marks this dirty (`onMediaReady`).
    const world = doc.frames.find((f) => f.id === this.frameId);
    beginConductPass();
    if (world) syncVideoFrames(doc, world, session.playheadMs, session.playing);
    pauseUnconductedElements();
    this.followPickedCamera(session.selectedClipIds, ui);
    const key = `${idOf(doc)}|${session.playheadMs}|${session.selectedClipIds.join(",")}|${idOf(ui)}|${useToolDefaults.getState().world.placement}|${this.width}x${this.height}`;
    if (key === this.drawnKey && !this.dirty) {
      if (this.hudDirty) {
        this.hudDirty = false;
        this.drawHud(ui, this.lastAspect);
      }
      return;
    }
    this.drawnKey = key;
    this.dirty = false;
    this.hudDirty = false;
    this.draw();
  };

  // ── Drawing ────────────────────────────────────────────────────────────────

  private draw(): void {
    const session = useSession.getState();
    const ui = useWorldUi.getState();
    const raw = this.store.getState();
    const frame = raw.frames.find((f) => f.id === this.frameId);
    if (!frame) return;
    const t = session.playheadMs;
    const doc = resolvedDocAt(raw, t, this.frameId, session.playing);
    const ev = evaluateWorld(doc, frame, t);
    this.ev = ev;
    // THE CAMERA IS THE TRUTH while you look through it. The view is re-read
    // from it every frame — the playhead between two keys, an undo, a field —
    // so navigating with Lock starts from where the camera IS, never from the
    // pose the view held when you entered (which threw the camera back to an
    // old key the moment you nudged it between two others). The orbit
    // distance is kept, so this is a no-op while the view drives the camera.
    if (ui.throughCamera && !this.viewAnim) this.view = this.viewFromCamera(this.viewCam(ev), this.view.distance);
    if (this.pendingFrameAll) {
      this.pendingFrameAll = false;
      // Opening a world: everything in view with room around it (Blender's startup distance for its cube).
      const f = this.framed(ev.objects.filter((o) => o.kind === "mesh" || o.kind === "plane"), this.view);
      this.view = { ...f, distance: f.distance * 2 };
    }
    const shading = ui.shading;
    this.sync.sync(ev, {
      doc,
      frame,
      shading,
      resolve: makeColorResolver(doc),
      density: 2,
      // A picture as sharp as it stands on screen: texels per layer px from how
      // big the layer is in the view, in powers of two (2, 4, 8) so zooming
      // redraws it at a few steps, not every frame.
      densityFor: (o) => {
        const scale = (length3(matAxis(o.matrix, 0)) + length3(matAxis(o.matrix, 2))) / 2;
        const need = (scale / Math.max(1e-6, this.pixelSizeAt(matPosition(o.matrix)))) * this.renderer.getPixelRatio();
        return Math.min(8, Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(1e-6, need)))));
      },
      xray: xrayOn(ui) && shading !== "rendered",
      // Strokes the eraser is passing over are gone already — back if the gesture is cancelled.
      localHidden: new Set(this.erasing ? [...ui.localHidden, ...this.erasing] : ui.localHidden),
      meshOverride: this.meshOverride,
      viewport: true,
    });
    this.engine.prepare(this.renderer, this.sync, ev.spec, shading);

    // Camera: the view, or the live camera framed inside the viewport.
    const aspect = this.width / this.height;
    if (ui.throughCamera) {
      this.camera = this.throughCamera(ev, aspect);
    } else {
      this.camera = applyView(this.view, aspect, this.persp, this.ortho);
    }
    this.gizmo.camera = this.camera;

    // Background: the theme's stage for working modes — the same void the flat
    // canvas floats on; the world's own paint (its first solid) when previewing
    // the render.
    const paint = shading === "rendered" || shading === "material" ? solidOf(frame) : null;
    this.renderer.setClearColor(paint ? new THREE.Color(paint) : this.theme.void, 1);
    this.renderer.autoClear = false;
    this.renderer.clear();

    const dpr = this.renderer.getPixelRatio();
    this.sync.updateLines(this.camera, new THREE.Vector2(this.width * dpr, this.height * dpr), dpr);
    // 0. A match-moved world's backplate, behind everything, through the camera.
    if (ui.throughCamera && this.guides.updatePlate(doc, frame, t, ev, this.camera)) this.renderer.render(this.guides.plateScene, this.camera);
    // 1. Grid (under everything, never writes depth).
    this.updateGrid(ui);
    if (ui.grid && ui.overlays && !ui.throughCamera) this.renderer.render(this.gridScene, this.camera);
    // 2. The world — through the lens in Rendered view: bloom and contact
    // shadows always, depth of field only through the camera (it is the
    // camera's lens, not the editor's).
    if (shading === "rendered") this.sync.renderMirror(this.renderer, this.camera);
    this.renderer.render(this.sync.scene, this.camera);
    if (shading === "rendered") {
      const look = postLookOf(ev);
      if (look && !ui.throughCamera) look.dof = null;
      if (look && (look.dof || look.bloom || look.ao)) (this.post ??= new PostStack(this.renderer)).apply(this.sync.scene, this.camera, look);
    }
    // 3. Furniture, over the world's depth.
    this.updateOverlays(ev, ui, session.selectedClipIds);
    this.updatePaths(raw, frame, ui, session.selectedClipIds);
    this.renderer.render(this.overlay, this.camera);
    this.lastAspect = frame.width / frame.height;
    this.drawHud(ui, this.lastAspect);
    this.onNav?.(this.view);
    this.emitInfo(ev, ui, frame.name);
  }

  /**
   * The camera the viewport looks through: the one you picked (`viewCameraId`)
   * when it is in the world now, else the one rendering.
   */
  viewCam(ev: WorldEval): CameraEval {
    const id = useWorldUi.getState().viewCameraId;
    if (id && id !== ev.camera.clipId) {
      const o = ev.objects.find((x) => x.id === id && x.kind === "camera");
      if (o) return cameraEvalOf(o, ev.width, ev.height);
    }
    return ev.camera;
  }

  /** Picking ONE camera (anywhere: Layers, timeline, here) makes it the one to look through. */
  private pickedKey = "";
  private followPickedCamera(selected: string[], ui: WorldUi): void {
    const key = selected.join(",");
    if (key === this.pickedKey) return;
    this.pickedKey = key;
    const last = selected[selected.length - 1];
    if (!last || last === ui.viewCameraId) return;
    const clip = locateClip(this.store.getState(), last)?.clip;
    if (clip?.kind === "camera" && clip.frameId === this.frameId) ui.set({ viewCameraId: last });
  }

  private throughCamera(ev: WorldEval, aspect: number): THREE.Camera {
    const frameAspect = ev.width / ev.height;
    const fill = Math.min(0.88, (0.88 * aspect) / frameAspect);
    const lens = this.viewCam(ev);
    const cam = this.engine.cameraFor(lens, aspect, this.throughCam ?? undefined);
    this.throughCam = cam;
    // Widen the lens so the frame occupies `fill` of the viewport height; the
    // rest is the passepartout, darkened in the HUD.
    if (cam instanceof THREE.PerspectiveCamera) {
      cam.fov = (2 * Math.atan(Math.tan((lens.projection.fovY * Math.PI) / 360) / fill) * 180) / Math.PI;
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    } else if (cam instanceof THREE.OrthographicCamera) {
      const halfH = (lens.projection.orthoHalfH * UNIT) / fill;
      cam.top = halfH;
      cam.bottom = -halfH;
      cam.left = -halfH * aspect;
      cam.right = halfH * aspect;
      cam.updateProjectionMatrix();
    }
    this.passepartout = { fill, frameAspect };
    return cam;
  }
  private passepartout: { fill: number; frameAspect: number } | null = null;

  private updateGrid(ui: WorldUi): void {
    const g = this.grid;
    const mat = g.material as THREE.ShaderMaterial;
    // Axis-aligned side views get a grid in the view plane (Blender's ortho grid).
    const side = this.view.ortho && Math.abs(this.view.pitch) < 0.01;
    const yaw = ((this.view.yaw % 360) + 360) % 360;
    const plane = side ? (Math.abs(yaw % 180) < 0.01 ? 1 : 2) : 0;
    mat.uniforms.uPlane!.value = plane;
    mat.uniforms.uCell!.value = ui.gridSize;
    mat.uniforms.uDiv!.value = ui.gridDivisions;
    const reach = Math.max(2000, this.view.distance * 12);
    mat.uniforms.uFade!.value = reach;
    const eye = eyeOf(this.view);
    mat.uniforms.uCenter!.value.set(this.view.target[0], this.view.target[1], plane === 0 ? 0 : this.view.target[2]);
    void eye;
    g.rotation.set(plane === 1 ? Math.PI / 2 : 0, plane === 2 ? Math.PI / 2 : 0, 0);
    if (plane === 2) g.rotation.set(0, Math.PI / 2, 0);
    g.scale.setScalar(reach * UNIT);
    g.position.set(plane === 2 ? 0 : this.view.target[0] * UNIT, plane === 1 ? 0 : this.view.target[1] * UNIT, plane === 0 ? 0 : this.view.target[2] * UNIT);
  }

  /**
   * MOTION PATHS — where each selected, animated object travels over its
   * span, as a line through space with a dot on every position key (After
   * Effects shows them for the selected layers; so does this). Sampled from
   * the world itself, so parents, constraints, IK and physics are all in the
   * path. Recomputed when the document or the selection changes — never in
   * the middle of a drag, which keeps the path it started with.
   */
  private motionPathGroup = new THREE.Group();
  private motionPathKey = "";
  private updateMotionPaths(ui: WorldUi, selected: string[]): void {
    const show = ui.overlays && ui.motionPaths && !ui.throughCamera && ui.mode === "object";
    this.motionPathGroup.visible = show;
    if (!this.motionPathGroup.parent) this.overlayRoot.add(this.motionPathGroup);
    if (!show || this.modal) return;
    const doc = this.store.getState();
    const key = `${idOf(doc)}|${selected.join(",")}`;
    if (key === this.motionPathKey) return;
    this.motionPathKey = key;
    for (const c of [...this.motionPathGroup.children]) {
      this.motionPathGroup.remove(c);
      const g = c as THREE.Line;
      g.geometry?.dispose();
      (g.material as THREE.Material)?.dispose();
    }
    const frame = doc.frames.find((f) => f.id === this.frameId);
    if (!frame || !selected.length) return;
    const clips = selected.map((id) => locateClip(doc, id)?.clip).filter((c): c is NonNullable<typeof c> => !!c && c.kind !== "audio");
    if (!clips.length) return;
    // Over the selection's spans, about two samples a frame, at most 160.
    const from = Math.min(...clips.map((c) => c.startMs)), to = Math.max(...clips.map((c) => c.startMs + c.durationMs));
    const n = Math.max(2, Math.min(160, Math.ceil(((to - from) / 1000) * 48)));
    const times = Array.from({ length: n }, (_, i) => from + ((to - from - 1) * i) / (n - 1));
    const keyTimes = new Map(clips.map((c) => [c.id, [...new Set(c.keyframes.filter((k) => ["x", "y", "z"].includes(k.property)).flatMap((k) => k.keys.map((key) => c.startMs + key.timeMs)))]]));
    const all = [...new Set([...times, ...[...keyTimes.values()].flat()])].sort((a, b) => a - b);
    const at = new Map<string, Map<number, V3>>(clips.map((c) => [c.id, new Map()]));
    for (const t of all) {
      const e = evaluateWorld(doc, frame, t);
      for (const c of clips) {
        if (t < c.startMs || t >= c.startMs + c.durationMs) continue;
        const o = e.objects.find((x) => x.id === c.id);
        if (o) at.get(c.id)!.set(t, matPosition(o.matrix));
      }
    }
    for (const c of clips) {
      const pts = at.get(c.id)!;
      const line = times.filter((t) => pts.has(t)).map((t) => pts.get(t)!);
      if (line.length < 2) continue;
      // Only what moves has a path.
      const span = line.reduce((m, p) => Math.max(m, Math.hypot(p[0] - line[0]![0], p[1] - line[0]![1], p[2] - line[0]![2])), 0);
      if (span < 0.5) continue;
      const g = new THREE.BufferGeometry().setFromPoints(line.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
      const path = new THREE.Line(g, new THREE.LineBasicMaterial({ color: this.theme.wire, transparent: true, opacity: 0.85, depthTest: false }));
      path.renderOrder = 4;
      this.motionPathGroup.add(path);
      const keys = (keyTimes.get(c.id) ?? []).filter((t) => pts.has(t)).map((t) => pts.get(t)!);
      if (keys.length) {
        const kg = new THREE.BufferGeometry().setFromPoints(keys.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
        const dots = new THREE.Points(kg, new THREE.PointsMaterial({ color: ACTIVE, size: 7, sizeAttenuation: false, depthTest: false }));
        dots.renderOrder = 5;
        this.motionPathGroup.add(dots);
      }
    }
  }

  private updateOverlays(ev: WorldEval, ui: WorldUi, selected: string[]): void {
    this.updateMotionPaths(ui, selected);
    this.guides.updatePoints(this.store.getState(), this.frameId, ui.overlays && ui.mode === "object");
    const show = ui.overlays && !ui.throughCamera;
    this.bones.update(ev, selected, show && ui.mode === "object");
    const sel = new Set(selected);
    const active = selected[selected.length - 1];
    const live = new Set<string>();
    // Camera and light helpers.
    for (const o of ev.objects) {
      if (o.kind !== "camera" && o.kind !== "light" && o.kind !== "empty") continue;
      if (ui.localHidden.includes(o.id)) continue;
      live.add(o.id);
      const key =
        o.kind === "camera" ? JSON.stringify((o.clip as CameraClip).camera) + ev.width / ev.height
        : o.kind === "empty" ? `${(o.clip as EmptyClip).display}|${(o.clip as EmptyClip).size}`
        : JSON.stringify((o.clip as LightClip).light);
      let h = this.helpers.get(o.id);
      if (!h || h.key !== key) {
        if (h) {
          this.overlayRoot.remove(h.line);
          h.line.geometry.dispose();
        }
        const line =
          o.kind === "camera" ? cameraHelper(o.clip as CameraClip, ev.width / ev.height)
          : o.kind === "empty" ? emptyHelper(o.clip as EmptyClip)
          : lightHelper(o.clip as LightClip);
        line.matrixAutoUpdate = false;
        h = { line, key };
        this.helpers.set(o.id, h);
        this.overlayRoot.add(line);
      }
      h.line.matrix.fromArray(stripScale(o.matrix));
      h.line.matrixWorldNeedsUpdate = true;
      h.line.visible = show && !(ui.throughCamera && o.id === this.viewCam(ev).clipId);
      (h.line.material as THREE.LineBasicMaterial).color.copy(o.id === active ? ACTIVE : sel.has(o.id) ? SELECTED : this.theme.wire);
    }
    // THE DEFAULT CAMERA, when it is the one showing: a dashed ghost where it
    // stands. Clicking it makes it a camera layer (`makeDefaultCameraReal`).
    if (ev.camera.clipId === null) {
      live.add(GHOST_CAMERA);
      const key = `ghost|${ev.width / ev.height}`;
      let h = this.helpers.get(GHOST_CAMERA);
      if (!h || h.key !== key) {
        if (h) {
          this.overlayRoot.remove(h.line);
          h.line.geometry.dispose();
        }
        const line = cameraHelper({ camera: DEFAULT_CAMERA_SPEC }, ev.width / ev.height, { ghost: true });
        line.matrixAutoUpdate = false;
        h = { line, key };
        this.helpers.set(GHOST_CAMERA, h);
        this.overlayRoot.add(line);
      }
      h.line.matrix.fromArray(ev.camera.matrix);
      h.line.matrixWorldNeedsUpdate = true;
      h.line.visible = show;
      (h.line.material as THREE.LineDashedMaterial).color.copy(this.theme.wire);
    }
    // Where a camera looks: the selected cameras, and the default one — a
    // dashed line from the lens to its target (what it looks at, else the
    // point on its line of sight nearest the world's centre).
    const aims: Array<{ id: string; from: Mat4; to: V3 }> = [];
    if (ev.camera.clipId === null) aims.push({ id: GHOST_CAMERA, from: ev.camera.matrix, to: [0, 0, 0] });
    for (const o of ev.objects) {
      if (o.kind !== "camera" || !sel.has(o.id) || ui.localHidden.includes(o.id)) continue;
      const look = (o.clip.constraints ?? []).find((c) => c.enabled && c.type === "lookAt" && c.targetId);
      const target = look ? ev.objects.find((x) => x.id === (look as { targetId: string }).targetId) : undefined;
      aims.push({ id: o.id, from: stripScale(o.matrix), to: target ? matPosition(target.matrix) : sightPoint(stripScale(o.matrix)) });
    }
    const aimLive = new Set<string>();
    for (const a of aims) {
      const len = Math.hypot(...sub(a.to, matPosition(a.from)));
      if (len < 1) continue;
      aimLive.add(a.id);
      let line = this.aims.get(a.id);
      if (!line) {
        line = aimHelper();
        line.matrixAutoUpdate = false;
        this.aims.set(a.id, line);
        this.overlayRoot.add(line);
      }
      // Turned from the lens toward the target, stretched to reach it.
      const dir = normalize3(sub(a.to, matPosition(a.from)));
      const aim = mul4(mul4(translate4(matPosition(a.from)), aimRotation(dir, "-z")), scale4([1, 1, len]));
      line.matrix.fromArray(aim);
      line.matrixWorldNeedsUpdate = true;
      line.visible = show && !(ui.throughCamera && a.id === (this.viewCam(ev).clipId ?? GHOST_CAMERA));
      (line.material as THREE.LineDashedMaterial).color.copy(a.id === active ? ACTIVE : sel.has(a.id) ? SELECTED : this.theme.wire);
    }
    for (const [id, line] of this.aims) {
      if (aimLive.has(id)) continue;
      this.overlayRoot.remove(line);
      line.geometry.dispose();
      this.aims.delete(id);
    }
    // Lattice cages: their grid as it stands now (edited, animated) — a guide, never rendered.
    for (const o of ev.objects) {
      if (o.kind !== "mesh" || !(o.clip as MeshClip).lattice || ui.localHidden.includes(o.id)) continue;
      const geo = this.sync.entries.get(o.id)?.geo?.mesh;
      if (!geo) continue;
      live.add(o.id);
      const key = `lattice:${idOf(geo)}`;
      let h = this.helpers.get(o.id);
      if (!h || h.key !== key) {
        if (h) {
          this.overlayRoot.remove(h.line);
          h.line.geometry.dispose();
        }
        const line = latticeHelper(geo);
        line.matrixAutoUpdate = false;
        h = { line, key };
        this.helpers.set(o.id, h);
        this.overlayRoot.add(line);
      }
      h.line.matrix.fromArray(o.matrix);
      h.line.matrixWorldNeedsUpdate = true;
      // While its points are being edited, edit mode draws the cage.
      h.line.visible = show && !(ui.mode === "edit" && ui.editClipId === o.id);
      (h.line.material as THREE.LineBasicMaterial).color.copy(o.id === active ? ACTIVE : sel.has(o.id) ? SELECTED : this.theme.wire);
    }
    for (const [id, h] of this.helpers) {
      if (live.has(id)) continue;
      this.overlayRoot.remove(h.line);
      h.line.geometry.dispose();
      this.helpers.delete(id);
    }
    // Selection outlines.
    const want = new Set<string>();
    if (show && ui.mode === "object") for (const id of selected) want.add(id);
    // Paint armed: every drawing layer shows its sheet — a blank one is otherwise nothing to aim at.
    const sheets = new Set<string>();
    if (show && ui.tool === "paint") {
      for (const o of ev.objects) if (o.clip.kind === "raster" && !want.has(o.id)) (sheets.add(o.id), want.add(o.id));
    }
    for (const [id, o] of this.outlines) {
      if (want.has(id)) continue;
      this.overlay.remove(o);
      this.outlines.delete(id);
    }
    for (const id of want) {
      const e = this.sync.entries.get(id);
      if (!e) continue;
      const color = sheets.has(id) ? SHEET : id === active ? ACTIVE : SELECTED;
      let o = this.outlines.get(id);
      // A boolean's kept member outlines the RESULT — the shape you see.
      const source = (e.mesh?.userData.booleanResult as THREE.Mesh | undefined) ?? e.mesh ?? e.plane?.mesh ?? null;
      if (!source && e.model) {
        // An imported model is many meshes: its selection is the box around them.
        let box = o as THREE.BoxHelper | undefined;
        if (!(box instanceof THREE.BoxHelper) || box.userData.geo !== e.model) {
          if (o) this.overlay.remove(o);
          box = new THREE.BoxHelper(e.model, color);
          box.userData.geo = e.model;
          this.outlines.set(id, box);
          this.overlay.add(box);
        }
        box.setFromObject(e.model);
        (box.material as THREE.LineBasicMaterial).color.copy(color);
        continue;
      }
      if (!source) continue;
      const picture = e.plane && source === e.plane.mesh ? e.plane.texture : null;
      if (!o || o.userData.geo !== source.geometry || (picture && o.userData.map !== picture)) {
        if (o) this.overlay.remove(o);
        // The outline by TOPOLOGY: a pushed-out back-face hull reads as a rim
        // only around a closed solid. A picture rings its INK; anything else
        // open outlines its feature edges.
        const open = source === e.mesh && e.geo && !isClosedMesh(e.geo.mesh);
        if (picture) {
          o = new THREE.Mesh(source.geometry, pictureOutlineMaterial(picture, color, 2));
          o.userData.map = picture;
        } else if (open) {
          o = new THREE.LineSegments(new THREE.EdgesGeometry(source.geometry, 30), new THREE.LineBasicMaterial({ color }));
        } else {
          ensureSmoothNormals(source.geometry);
          o = new THREE.Mesh(source.geometry, outlineMaterial(color, 1.5));
        }
        o.userData.geo = source.geometry;
        o.matrixAutoUpdate = false;
        this.outlines.set(id, o);
        this.overlay.add(o);
      }
      source.updateWorldMatrix(true, false);
      o.matrix.copy(source.matrixWorld);
      o.matrixWorldNeedsUpdate = true;
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | THREE.LineBasicMaterial;
      if (m instanceof THREE.ShaderMaterial) {
        (m.uniforms.uColor!.value as THREE.Color).copy(color);
        (m.uniforms.uRes?.value as THREE.Vector2 | undefined)?.set(this.width, this.height);
      } else m.color.copy(color);
    }
    // 3D cursor, kept a constant size on screen.
    const c = ui.cursor;
    this.cursor.visible = show;
    this.cursor.position.set(c[0] * UNIT, c[1] * UNIT, c[2] * UNIT);
    this.cursor.quaternion.copy(this.camera.quaternion);
    this.cursor.scale.setScalar(this.pixelSizeAt(c) * 9 * UNIT);
    // The page the vector brush draws on — a selected drawing's own, or the
    // axis plane picked — so where a stroke lands is seen before it is drawn.
    const page = show && ui.mode === "draw" && ui.tool === "draw" ? this.shownPage() : null;
    this.pageGrid.visible = !!page;
    if (page) {
      const n = pageForward(page);
      const half = this.pixelSizeAt(page.anchor) * Math.min(this.width, this.height) * 0.45 * UNIT;
      const [r, u, a] = [scale3(page.right, half), scale3(page.up, half), scale3(page.anchor, UNIT)];
      this.pageGrid.matrix.set(r[0], u[0], n[0], a[0], r[1], u[1], n[1], a[1], r[2], u[2], n[2], a[2], 0, 0, 0, 1);
      this.pageGrid.matrixWorldNeedsUpdate = true;
    }
    // Edit mode.
    const target = this.editTarget();
    if (target) {
      const o = ev.objects.find((x) => x.id === target.clipId);
      const cage = target.cage();
      const mesh = this.liveCage ?? cage.mesh;
      const version = `${idOf(mesh)}|${idOf(cage)}|${idOf(ui.elementSel)}`;
      // Shown points and the traced line are rebuilt only when the cage or the selection change.
      const display = this.displayKey === version ? this.display : { glyphs: cage.glyphs, shown: target.shown?.(selectedVerts(mesh, ui.elementSel)) ?? null, curves: target.curves?.(mesh) };
      this.display = display;
      this.displayKey = version;
      this.editOverlay.update(mesh, cage.wires, ui.elementSel, o?.matrix ?? null, xrayOn(ui), version, display);
    } else this.editOverlay.update(null, [], EMPTY_SELECTION, null, false, "");
    this.syncGizmo(ui, selected);
  }

  /**
   * MOTION PATHS — where each selected object travels across its span, with
   * its position keys marked (Blender's path display, always on for what is
   * selected and moving). Sampled from the document by core, so a path bends
   * with easing, modulators, groups and follows exactly as playback will.
   * Held through a G/R/S drag (the document there is a preview) and rebuilt
   * when it commits.
   */
  private updatePaths(doc: MotionDocument, frame: Frame, ui: WorldUi, selected: string[]): void {
    const show = ui.overlays && !ui.throughCamera && ui.mode === "object";
    const want = new Set(show ? selected : []);
    for (const [id, p] of this.paths) {
      if (want.has(id)) continue;
      this.overlayRoot.remove(p.group);
      disposeTree(p.group);
      this.paths.delete(id);
    }
    if (this.modal || this.gizmoStart) return;
    for (const id of want) {
      const key = `${idOf(doc)}`;
      const had = this.paths.get(id);
      if (had?.key === key) continue;
      if (had) {
        this.overlayRoot.remove(had.group);
        disposeTree(had.group);
        this.paths.delete(id);
      }
      const path = objectMotionPath(doc, frame, id, { maxSamples: 180 });
      const group = new THREE.Group();
      if (path && path.points.length > 1) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(path.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]))),
          new THREE.LineBasicMaterial({ color: 0xd8dae0, transparent: true, opacity: 0.55, depthTest: false }),
        );
        const dots = new THREE.Points(
          new THREE.BufferGeometry().setFromPoints(path.keys.map((p) => new THREE.Vector3(p[0], p[1], p[2]))),
          new THREE.PointsMaterial({ color: 0xffc94d, size: 7, sizeAttenuation: false, depthTest: false }),
        );
        line.renderOrder = dots.renderOrder = 5;
        group.add(line, dots);
      }
      this.overlayRoot.add(group);
      this.paths.set(id, { group, key });
    }
  }

  private drawHud(ui: WorldUi, frameAspect: number): void {
    const ctx = this.hudCtx;
    const dpr = this.renderer.getPixelRatio();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.hud.width, this.hud.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Passepartout: the outside of the camera frame, darkened; the frame outlined.
    if (ui.throughCamera && this.passepartout) {
      const { fill } = this.passepartout;
      const h = this.height * fill;
      const w = h * frameAspect;
      const x = (this.width - w) / 2, y = (this.height - h) / 2;
      ctx.fillStyle = this.theme.light ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.55)";
      ctx.beginPath();
      ctx.rect(0, 0, this.width, this.height);
      ctx.rect(x, y, w, h);
      ctx.fill("evenodd");
      ctx.strokeStyle = this.ink(0.35);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }
    if (this.box) {
      const [x0, y0, x1, y1] = this.box;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = this.ink(0.9);
      ctx.fillStyle = this.ink(0.06);
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }
    const m = this.modal;
    if (m) {
      if (m.constraint) {
        // The constraint as a line across the view, in the axis colour.
        const p = m.pivot;
        const d = m.constraint.dir;
        const color = m.constraint.axis === 0 ? AXIS_COLORS.x : m.constraint.axis === 1 ? AXIS_COLORS.y : m.constraint.axis === 2 ? AXIS_COLORS.z : "#ffffff";
        const dirs: V3[] = m.constraint.plane ? planeAxes(d) : [d];
        for (const dd of dirs) {
          // Project a short step along the axis and extend it across the view
          // in 2D — a far point would land behind the camera.
          const a = this.toScreen(p);
          const b = this.toScreen(add(p, scale3(dd, this.pixelSizeAt(p) * 40)));
          if (!a || !b) continue;
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const l = Math.hypot(dx, dy);
          if (l < 1e-3) continue;
          const k = (this.width + this.height) / l;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(a[0] - dx * k, a[1] - dy * k);
          ctx.lineTo(a[0] + dx * k, a[1] + dy * k);
          ctx.stroke();
        }
      }
      if (m.edit?.weights) {
        // The falloff's reach, a circle about the pivot the size it is in the world.
        const r = useWorldUi.getState().propRadius / Math.max(1e-6, this.pixelSizeAt(m.pivot));
        const c = this.toScreen(m.pivot);
        if (c && r > 2 && r < 1e5) {
          ctx.strokeStyle = this.ink(0.55);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(c[0], c[1], r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (m.kind !== "grab") {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = this.ink(0.8);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(m.pivotScreen[0], m.pivotScreen[1]);
        ctx.lineTo(m.mouse[0], m.mouse[1]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // The vector brush's stroke as it is drawn — THE fit that will commit,
    // painted by the brush's own painter (pressure, taper, every line).
    const doc = this.store.getState();
    this.drawing?.paint(ctx, (c) => resolveColor(doc, c));
    // The knife's line, as it is drawn.
    if (this.stroke && this.stroke.length > 1) {
      ctx.strokeStyle = "#ffd84a";
      ctx.lineWidth = 1.5;
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      this.stroke.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // The eraser's trail, as wide as it reaches.
    if (this.erasing && this.erasePath.length) {
      ctx.strokeStyle = this.ink(0.25);
      ctx.lineWidth = this.eraserRadius() * 2;
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.beginPath();
      this.erasePath.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      if (this.erasePath.length === 1) ctx.lineTo(this.erasePath[0]![0] + 0.01, this.erasePath[0]![1]);
      ctx.stroke();
    }
    // The sculpt brush: its reach, where the hand is — a solid ring on the
    // shape, a dashed one off it (a drag there turns the view).
    if (ui.tool === "sculpt" && this.hover) {
      const s = useToolDefaults.getState().world.sculpt;
      const [hx, hy] = this.hover;
      const on = !!this.sculpting || !!this.pathSculpt || !!this.sculptTarget(hx, hy);
      ctx.strokeStyle = this.ink(on ? 0.9 : 0.4);
      ctx.lineWidth = 1.25;
      if (!on) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(hx, hy, s.radiusPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (on && s.strength > 0) {
        ctx.strokeStyle = this.ink(0.45);
        ctx.beginPath();
        ctx.arc(hx, hy, s.radiusPx * Math.min(1, s.strength), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // The edge a loop cut would take.
    if (ui.mode === "edit" && this.hoverEdge && this.loopCutHover) {
      ctx.strokeStyle = "#ffd84a";
      ctx.lineWidth = 2;
      for (const seg of this.loopCutHover) {
        ctx.beginPath();
        ctx.moveTo(seg[0], seg[1]);
        ctx.lineTo(seg[2], seg[3]);
        ctx.stroke();
      }
    }
  }
  loopCutHover: Array<[number, number, number, number]> | null = null;
  private display: import("./edit-overlay").CageDisplay = {};
  private displayKey = "";

  private emitInfo(ev: WorldEval, ui: WorldUi, frameName: string): void {
    if (!this.onInfo) return;
    const selected = useSession.getState().selectedClipIds;
    const active = ev.objects.find((o) => o.id === selected[selected.length - 1]);
    let verts = 0, faces = 0, tris = 0;
    for (const e of this.sync.entries.values()) {
      const g = e.geo;
      if (!g) continue;
      verts += g.mesh.positions.length / 3;
      faces += g.mesh.faces.length;
      tris += g.triFace.length;
    }
    // In edit mode the counts are the thing being edited — its cage, whatever kind it is.
    const target = this.editTarget();
    const cage = target ? this.editCage() : null;
    const picked = cage ? selectedVerts(cage, ui.elementSel).size : 0;
    // A path counts its NODES (a handle is part of its node, not a point of its own).
    const path = isPathTarget(target) && cage ? { picked: target.nodesOf(selectedVerts(cage, ui.elementSel)).length, all: target.outline().reduce((n, s) => n + s.points.length, 0), lines: target.outline().length } : null;
    this.onInfo({
      label: ui.throughCamera ? this.throughLabel(ev) : viewLabel(this.view),
      // Looking through the selected camera, its name is already the label.
      objectName: ui.throughCamera && active?.id === this.viewCam(ev).clipId ? "" : (active?.clip.name ?? ""),
      stats: path
        ? `Points ${path.picked}/${path.all.toLocaleString()} · Lines ${path.lines}`
        : cage
        ? `Points ${picked}/${(cage.positions.length / 3).toLocaleString()} · Faces ${cage.faces.length.toLocaleString()}`
        : `Objects ${ev.objects.length} · Vertices ${verts.toLocaleString()} · Faces ${faces.toLocaleString()} · Triangles ${tris.toLocaleString()}`,
      frameName,
      through: ui.throughCamera,
    });
  }

  // ── Coordinates ────────────────────────────────────────────────────────────

  toScreen(p: V3): [number, number] | null {
    const v = new THREE.Vector3(p[0] * UNIT, p[1] * UNIT, p[2] * UNIT).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return [((v.x + 1) / 2) * this.width, ((1 - v.y) / 2) * this.height];
  }

  /** The mouse as a world ray (cm). */
  ray(x: number, y: number): { o: V3; d: V3 } {
    this.raycaster.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const r = this.raycaster.ray;
    return { o: [r.origin.x / UNIT, r.origin.y / UNIT, r.origin.z / UNIT], d: [r.direction.x, r.direction.y, r.direction.z] };
  }

  /** World units per screen pixel at a point (for gestures that should feel 1:1). */
  pixelSizeAt(p: V3): number {
    const a = this.toScreen(p);
    const { right } = this.screenBasis();
    const b = this.toScreen(add(p, scale3(right, 100)));
    if (!a || !b) return this.view.distance / this.height;
    return 100 / Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1]));
  }

  private screenBasis(): { right: V3; up: V3; forward: V3 } {
    const m = this.camera.matrixWorld.elements;
    return {
      right: normalize3([m[0]!, m[1]!, m[2]!]),
      up: normalize3([m[4]!, m[5]!, m[6]!]),
      forward: normalize3([-m[8]!, -m[9]!, -m[10]!]),
    };
  }

  /** Ray ∩ plane through `p` with normal `n`. */
  private hitPlane(x: number, y: number, p: V3, n: V3): V3 | null {
    const { o, d } = this.ray(x, y);
    const den = dot(d, n);
    if (Math.abs(den) < 1e-9) return null;
    const t = dot(sub(p, o), n) / den;
    if (t < 0 && !this.view.ortho) return null;
    return add(o, scale3(d, t));
  }

  /** The point under the cursor on a surface, else on the floor (for the 3D cursor and adds). */
  surfacePoint(x: number, y: number): V3 {
    const hit = this.pickRay(x, y);
    if (hit) return hit.point;
    return this.hitPlane(x, y, [0, 0, 0], [0, 0, 1]) ?? this.view.target;
  }

  // ── Picking ────────────────────────────────────────────────────────────────

  /**
   * What the pointer is ON — by INK, not by card. A picture plane (a drawn
   * stroke, a title, a cut-out photo) is a rectangle of mostly nothing, and
   * picking by the rectangle meant a tap on the empty air beside a stroke took
   * the stroke, and a stroke's card hid everything behind it from the pointer.
   * A plane counts only where its picture has ink within `reach` screen px; a
   * mesh where its surface is. `kinds` narrows what may be hit (the eraser
   * takes strokes only, and looks straight through everything else).
   */
  private pickRay(x: number, y: number, opts: { reach?: number; kinds?: readonly string[]; only?: ReadonlySet<string> | null; skip?: string | null; skipKinds?: readonly string[] } = {}): { id: string; point: V3; face: number | null; distance: number; normal: V3 | null } | null {
    // A stroke standing in the world is a few px wide: pick it within a
    // forgiving reach, as the canvas does for a thin path.
    this.raycaster.params.Line2 = { threshold: opts.reach === 0 ? 0.5 : 8 };
    this.raycaster.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const hits = this.raycaster.intersectObjects(this.sync.pickables(), true);
    for (const h of hits) {
      let n: THREE.Object3D | null = h.object;
      while (n && !n.userData.clipId) n = n.parent;
      if (!n) continue;
      const hit = n.userData.clipId as string;
      // Inside an instance of a world component (`<instance>/<id>`): the click
      // picks the INSTANCE — its parts are the component's, edited there.
      const slash = hit.indexOf("/");
      const id = slash < 0 ? hit : hit.slice(0, slash);
      const e = this.sync.entries.get(hit);
      if (opts.kinds && !opts.kinds.includes(e?.object.clip.kind ?? "")) continue;
      if (opts.skipKinds?.includes(e?.object.clip.kind ?? "")) continue;
      if (opts.only && !opts.only.has(id)) continue;
      if (opts.skip && id === opts.skip) continue;
      if (e?.plane && h.object === e.plane.mesh && !this.inkNear(e.plane, h, opts.reach ?? 6)) continue;
      const face = slash < 0 && h.faceIndex != null && e?.geo ? e.geo.triFace[h.faceIndex] ?? null : null;
      let normal: V3 | null = null;
      if (h.face) {
        const nn = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        // Toward the eye: a surface seen from behind is drawn on its seen side.
        if (nn.dot(this.raycaster.ray.direction) > 0) nn.negate();
        normal = [nn.x, nn.y, nn.z];
      }
      return { id, point: [h.point.x / UNIT, h.point.y / UNIT, h.point.z / UNIT], face, distance: h.distance / UNIT, normal };
    }
    return null;
  }

  /** Every object under the pointer, nearest first, CARDS included — the fill tool asks what region of a drawing it is inside. */
  hitsAt(x: number, y: number): Array<{ id: string; point: V3 }> {
    this.raycaster.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const out: Array<{ id: string; point: V3 }> = [];
    for (const h of this.raycaster.intersectObjects(this.sync.pickables(), true)) {
      let n: THREE.Object3D | null = h.object;
      while (n && !n.userData.clipId) n = n.parent;
      if (!n || out.some((o) => o.id === n!.userData.clipId)) continue;
      out.push({ id: n.userData.clipId as string, point: [h.point.x / UNIT, h.point.y / UNIT, h.point.z / UNIT] });
    }
    return out;
  }

  /** Does a plane's picture have ink within `reachPx` screen px of where the ray met it? */
  private inkNear(plane: { mesh: THREE.Mesh; texture: THREE.CanvasTexture | null }, hit: THREE.Intersection, reachPx: number): boolean {
    const img = plane.texture?.image as HTMLCanvasElement | undefined;
    const ctx = img?.getContext?.("2d");
    if (!img || !ctx || !hit.uv || !img.width || !img.height) return true;
    const geo = plane.mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const localW = Math.max(1e-6, geo.boundingBox!.max.x - geo.boundingBox!.min.x);
    const unitsPerLocal = plane.mesh.getWorldScale(new THREE.Vector3()).x / UNIT;
    const worldPerTexel = (localW * unitsPerLocal) / img.width;
    const at: V3 = [hit.point.x / UNIT, hit.point.y / UNIT, hit.point.z / UNIT];
    const r = Math.min(32, Math.max(1, Math.ceil((reachPx * this.pixelSizeAt(at)) / Math.max(1e-6, worldPerTexel))));
    const cx = Math.floor(hit.uv.x * img.width), cy = Math.floor((1 - hit.uv.y) * img.height);
    const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r);
    const x1 = Math.min(img.width, cx + r + 1), y1 = Math.min(img.height, cy + r + 1);
    if (x1 <= x0 || y1 <= y0) return false;
    const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 24) return true;
    return false;
  }

  /**
   * The object under the cursor: surfaces by ray; cameras, lights and
   * controllers by their DRAWN glyph — any of its lines, or its origin. (By the
   * origin alone, a camera's frame was a big shape you could not click.)
   * `ghost`: the default camera's ghost counts too (the selection click).
   */
  pickObject(x: number, y: number, opts: { ghost?: boolean } = {}): string | null {
    const hit = this.pickRay(x, y);
    let best: { id: string; d: number } | null = null;
    const glyph = (id: string, origin: V3) => {
      const s = this.toScreen(origin);
      if (s) {
        const d = Math.hypot(s[0] - x, s[1] - y);
        if (d < 16 && (!best || d < best.d)) best = { id, d };
      }
      const h = this.helpers.get(id);
      if (!h || !h.line.visible) return;
      const P = h.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      const m = h.line.matrix.elements as unknown as Mat4;
      for (let i = 0; i + 1 < P.count; i += 2) {
        const a = this.toScreen(transformPoint(m, [P.getX(i), P.getY(i), P.getZ(i)]));
        const b = this.toScreen(transformPoint(m, [P.getX(i + 1), P.getY(i + 1), P.getZ(i + 1)]));
        if (!a || !b) continue;
        const d = segmentDistance(x, y, a, b) + 4; // an origin hit beats a line the same distance away
        if (d < 10 && (!best || d < best.d)) best = { id, d };
      }
    };
    for (const o of this.ev?.objects ?? []) {
      if (o.kind !== "camera" && o.kind !== "light" && o.kind !== "empty") continue;
      glyph(o.id, matPosition(o.matrix));
    }
    if (opts.ghost && this.ev && this.ev.camera.clipId === null) glyph(GHOST_CAMERA, matPosition(this.ev.camera.matrix));
    // A lattice cage is picked by its edges, as Blender's is — clicking inside it reaches what it holds.
    for (const o of this.ev?.objects ?? []) {
      if (o.kind !== "mesh" || !(o.clip as MeshClip).lattice) continue;
      const mesh = this.sync.entries.get(o.id)?.geo?.mesh;
      if (!mesh) continue;
      const P = mesh.positions;
      const at = (v: number) => this.toScreen(transformPoint(o.matrix, [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!]));
      for (const e of meshEdges(mesh).list) {
        const a = at(e.a), b = at(e.b);
        if (!a || !b) continue;
        const d = segmentDistance(x, y, a, b);
        if (d < 6 && (!best || d < best.d)) best = { id: o.id, d };
      }
    }
    return best?.id ?? hit?.id ?? null;
  }

  // ── Edit mode ──────────────────────────────────────────────────────────────

  /**
   * What edit mode is editing — a mesh, a path, a crop window — as one target
   * (`edit-targets.ts`). Everything generic here (picking, box select, the
   * modal, the gizmo, the overlay) talks to the target's CAGE and never asks
   * what kind of thing it is.
   */
  editTarget(): EditTarget | null {
    const ui = useWorldUi.getState();
    if (ui.mode !== "edit" || !ui.editClipId) return null;
    this.targetCtx ??= {
      store: this.store,
      meshPreview: this.meshOverride,
      playheadMs: () => useSession.getState().playheadMs,
      recording: () => useSession.getState().recording,
    };
    return editTargetFor(this.targetCtx, this.store.getState(), ui.editClipId);
  }
  private targetCtx: EditTargetContext | null = null;
  /** The cage while a modal moves it — what every read sees until it commits or cancels. */
  private liveCage: MeshData | null = null;

  /** The cage being edited, live while a modal moves it. */
  editCage(): MeshData | null {
    return this.liveCage ?? this.editTarget()?.cage().mesh ?? null;
  }

  /** The MESH being edited — null for a path or a crop. Mesh-only operators read this. */
  editMesh(): MeshData | null {
    return this.editTarget()?.kind === "mesh" ? this.editCage() : null;
  }

  /** Move the cage live: every read sees it, the target previews it. */
  private setLive(target: EditTarget, mesh: MeshData, move?: CageMove): void {
    this.liveCage = mesh;
    this.liveMove = move;
    target.preview(mesh, move);
  }
  private liveMove: CageMove | undefined;

  /**
   * How a moving cage is read right now: ⌥ held (a handle breaks from its
   * partner — or, on a broken node, re-pairs), and how close to its node a
   * handle drops to dissolve, 8 screen px in the object's units.
   */
  private cageMove(m: Modal): CageMove {
    const o = m.edit ? this.ev?.objects.find((x) => x.id === m.edit!.clipId) : null;
    const scale = o ? Math.max(1e-6, (length3(matAxis(o.matrix, 0)) + length3(matAxis(o.matrix, 2))) / 2) : 1;
    return { alt: gestureMods().alt, dissolveWithin: (8 * this.pixelSizeAt(m.pivot)) / scale };
  }

  private editObject(): WorldObject | null {
    const ui = useWorldUi.getState();
    return this.ev?.objects.find((x) => x.id === ui.editClipId) ?? null;
  }

  /** Every vertex on screen, with whether it is visible (not behind a surface) unless X-ray. */
  private screenVerts(mesh: MeshData, obj: Mat4, xray: boolean): Array<[number, number, boolean]> {
    const out: Array<[number, number, boolean]> = [];
    const camPos = this.camera.getWorldPosition(new THREE.Vector3());
    // A line's points sit INSIDE its own body (a 3D stroke's tube, a drawing's
    // picture): only OTHER things can hide them. A mesh's own far side hides
    // its far vertices, as in Blender.
    const t = this.editTarget();
    const skip = t && t.kind !== "mesh" ? t.clipId : null;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const w = transformPoint(obj, [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]);
      const s = this.toScreen(w);
      if (!s) {
        out.push([-1e6, -1e6, false]);
        continue;
      }
      let visible = true;
      if (!xray) {
        // EXACT: only what truly covers a point hides it — a thin line passing
        // a few px away (which a click forgives) does not.
        // And a LINE never hides a point (a stroke drawn over another is not a
        // wall in front of it): only solid things — meshes, pictures, bodies — do.
        const hit = this.pickRay(s[0], s[1], { skip, reach: 0, skipKinds: ["path"] });
        if (hit) {
          const dv = Math.hypot(w[0] - camPos.x / UNIT, w[1] - camPos.y / UNIT, w[2] - camPos.z / UNIT);
          visible = hit.distance >= dv - Math.max(0.5, dv * 0.002);
        }
      }
      out.push([s[0], s[1], visible]);
    }
    return out;
  }

  /** Click in edit mode: the nearest element of the current kind. */
  pickElement(x: number, y: number): { vert?: number; edge?: string; face?: number } | null {
    const ui = useWorldUi.getState();
    const mesh = this.editCage();
    const o = this.editObject();
    if (!mesh || !o) return null;
    if (ui.elementMode === "face") {
      const hit = this.pickRay(x, y);
      if (!hit || hit.id !== o.id) return null;
      // A mesh's faces are its own triangles' faces; a crop window is ONE face.
      if (this.editTarget()?.kind !== "mesh") return mesh.faces.length ? { face: 0 } : null;
      return hit.face != null ? { face: hit.face } : null;
    }
    const sv = this.screenVerts(mesh, o.matrix, xrayOn(ui));
    if (ui.elementMode === "vertex") {
      // Only what is on screen can be grabbed: a path's hidden handles are not there.
      const shown = this.shownVerts(mesh);
      let best = -1, bd = 14;
      sv.forEach(([sx, sy, vis], i) => {
        if (!vis || (shown && !shown.has(i))) return;
        const d = Math.hypot(sx - x, sy - y);
        if (d < bd) (bd = d), (best = i);
      });
      return best >= 0 ? { vert: best } : null;
    }
    let best: string | null = null, bd = 10;
    for (const e of meshEdges(mesh).list) {
      const a = sv[e.a]!, b = sv[e.b]!;
      if (!a[2] && !b[2]) continue;
      const d = segDist(x, y, a[0], a[1], b[0], b[1]);
      if (d < bd) (bd = d), (best = edgeKey(e.a, e.b));
    }
    return best ? { edge: best } : null;
  }

  /** The cage points on screen now (a path shows its handles only around the selection); null = all. */
  private shownVerts(mesh: MeshData): ReadonlySet<number> | null {
    const t = this.editTarget();
    return t?.shown ? t.shown(selectedVerts(mesh, useWorldUi.getState().elementSel)) : null;
  }

  /** Is any point of what is being edited within reach of this screen point, hidden or not? */
  nearEditPoint(x: number, y: number): boolean {
    const mesh = this.editCage();
    const o = this.editObject();
    if (!mesh || !o) return false;
    return this.screenVerts(mesh, o.matrix, true).some(([sx, sy]) => Math.hypot(sx - x, sy - y) < 14);
  }

  /** The path node or handle under a screen point (edit mode on a path), with what it is. */
  pathPointAt(x: number, y: number): { vert: number; ref: NodeRef; part: "anchor" | "in" | "out" } | null {
    const t = this.editTarget();
    if (!isPathTarget(t) || useWorldUi.getState().elementMode !== "vertex") return null;
    const el = this.pickElement(x, y);
    const r = el?.vert !== undefined ? t.refOf(el.vert) : null;
    return r ? { vert: el!.vert!, ref: { sub: r.sub, index: r.index }, part: r.part } : null;
  }

  /** The segment of the edited path's true line under a screen point (within 8px), by its two node vertices. */
  pathSegmentAt(x: number, y: number): { a: number; b: number } | null {
    const t = this.editTarget();
    const o = this.editObject();
    if (!isPathTarget(t) || !o || !t.curves) return null;
    let best: { a: number; b: number } | null = null, bd = 8;
    for (const c of t.curves(t.cage().mesh)) {
      let prev: [number, number] | null = null;
      for (const p of c.points) {
        const s = this.toScreen(transformPoint(o.matrix, p));
        if (s && prev) {
          const d = segDist(x, y, prev[0], prev[1], s[0], s[1]);
          if (d < bd) (bd = d), (best = { a: c.a, b: c.b });
        }
        prev = s;
      }
    }
    return best;
  }

  // ── Modal operators (G / R / S / I) ────────────────────────────────────────

  get modalActive(): boolean {
    return this.modal !== null;
  }

  /** Begin G/R/S on the selection. Returns false when there is nothing to act on. */
  beginModal(kind: ModalKind, opts: { constraint?: Constraint | null; label?: string; cancelMesh?: MeshData; target?: EditTarget; tweak?: number; restoreSel?: MeshSelection } = {}): boolean {
    const ui = useWorldUi.getState();
    const ev = this.ev;
    if (!ev) return false;
    const [mx, my] = this.lastMouse;
    let pivot: V3 | null = null;
    let localAxes: Mat4 = rotation4(0, 0, 0);
    const modal: Modal = {
      kind, start: [mx, my], mouse: [mx, my], pivot: [0, 0, 0], pivotScreen: [mx, my], constraint: opts.constraint ?? null,
      typed: "", objects: [], edit: null, localAxes, label: opts.label ?? kind, precisionFrom: null, cancelMesh: opts.cancelMesh,
      tweak: opts.tweak, restoreSel: opts.restoreSel,
    };
    if (ui.mode === "edit" && ui.editClipId) {
      const target = opts.target ?? this.editTarget();
      const o = this.editObject();
      const mesh = opts.target ? (this.liveCage ?? opts.target.cage().mesh) : this.editCage();
      if (!target || !o || !mesh) return false;
      // An anchor carries its handles (the target says which points follow).
      const verts = target.followers(selectedVerts(mesh, ui.elementSel));
      if (verts.size === 0) return false;
      const med = selectionMedian(mesh, ui.elementSel)!;
      pivot = ui.pivot === "cursor" ? ui.cursor : transformPoint(o.matrix, med);
      localAxes = stripScale(o.matrix);
      localAxes[12] = localAxes[13] = localAxes[14] = 0;
      modal.edit = { clipId: o.id, target, startMesh: mesh, verts, obj: o.matrix, inv: invert4(o.matrix), sel: ui.elementSel, weights: null };
      // A FLAT DRAWING'S POINTS STAY ON ITS PAGE. A free move of points that
      // share one depth slides them in their own plane (the layer's local XZ,
      // at that depth) — the flat pen's drag, wherever the view is. An axis
      // key still lifts them off it (Y twice: along the page's normal), and a
      // page seen edge-on reads the pointer on the view's plane and flattens
      // the move back onto the page. R and S turn and grow within it always.
      if (isPathTarget(target) && kind !== "inset") {
        const depths = [...verts].map((v) => mesh.positions[v * 3 + 1]!);
        const flat = depths.every((d) => Math.abs(d - depths[0]!) < 1e-3);
        const normal = normalize3(matAxis(o.matrix, 1));
        if (flat) modal.plane = normal;
      }
      // Extrude and inset move what they made, never its neighbours.
      if (ui.proportional && (kind === "grab" || kind === "rotate" || kind === "scale") && !opts.cancelMesh) {
        modal.edit.weights = proportionalWeights(mesh, verts, ui.propRadius, { falloff: ui.propFalloff, matrix: o.matrix });
      }
    } else if (kind !== "inset" && this.bones.modalTarget()) {
      // Bones picked in a selected rig: G / R / S pose them (or move their rest in Setup).
      const t = this.bones.modalTarget()!;
      modal.bones = t;
      pivot = ui.pivot === "cursor" ? ui.cursor : t.pivot;
      localAxes = t.axes;
    } else {
      const ids = useSession.getState().selectedClipIds;
      const targets = ev.objects.filter((o) => ids.includes(o.id) && !(o.clip.locked));
      if (targets.length === 0) return false;
      modal.objects = targets.map((o) => ({ o, start: o.matrix, parent: parentMatrixOf(o) }));
      const active = targets.find((o) => o.id === ids[ids.length - 1]) ?? targets[0]!;
      localAxes = stripScale(active.matrix);
      localAxes[12] = localAxes[13] = localAxes[14] = 0;
      pivot =
        ui.pivot === "cursor" ? ui.cursor
        : ui.pivot === "active" ? matPosition(active.matrix)
        : scale3(targets.reduce((a, o) => add(a, matPosition(o.matrix)), [0, 0, 0] as V3), 1 / targets.length);
    }
    modal.pivot = pivot!;
    modal.localAxes = localAxes;
    modal.pivotScreen = this.toScreen(pivot!) ?? [mx, my];
    this.modal = modal;
    this.updateModal();
    return true;
  }

  /** X / Y / Z during a modal: global → local → off; with Shift, the plane. */
  axisKey(axis: 0 | 1 | 2, shift: boolean): void {
    const m = this.modal;
    if (!m) return;
    const name = "XYZ"[axis]!;
    const c = m.constraint;
    const sameAxis = c && c.axis === axis && c.plane === shift;
    let next: Constraint | null;
    if (!sameAxis) next = { dir: unitAxis(axis), plane: shift, label: `${shift ? "plane ⟂ " : ""}global ${name}`, axis, local: false };
    else if (!c!.local) next = { dir: normalize3(matAxis(m.localAxes, axis)), plane: shift, label: `${shift ? "plane ⟂ " : ""}local ${name}`, axis, local: true };
    else next = null;
    m.constraint = next;
    this.updateModal();
  }

  typeKey(key: string): void {
    const m = this.modal;
    if (!m) return;
    if (key === "Backspace") m.typed = m.typed.slice(0, -1);
    else if (key === "-") m.typed = m.typed.startsWith("-") ? m.typed.slice(1) : `-${m.typed}`;
    else if (/^[0-9.]$/.test(key)) m.typed += key;
    this.updateModal();
  }

  modalMouse(x: number, y: number, shift: boolean, ctrl: boolean): void {
    const m = this.modal;
    if (!m) return;
    if (shift && !m.precisionFrom) m.precisionFrom = [x, y];
    if (!shift) m.precisionFrom = null;
    const eff: [number, number] = m.precisionFrom ? [m.precisionFrom[0] + (x - m.precisionFrom[0]) * 0.1, m.precisionFrom[1] + (y - m.precisionFrom[1]) * 0.1] : [x, y];
    m.mouse = eff;
    this.snapOn = ctrl !== useWorldUi.getState().snap;
    this.updateModal();
  }
  private snapOn = false;

  private updateModal(): void {
    const m = this.modal;
    if (!m) return;
    const ui = useWorldUi.getState();
    const typed = m.typed && m.typed !== "-" ? Number(m.typed) : null;
    let D: Mat4;
    let hud = "";
    const step = ui.gridSize / ui.gridDivisions;
    if (m.kind === "grab") {
      let delta: V3;
      if (typed !== null && Number.isFinite(typed)) {
        delta = m.constraint && !m.constraint.plane ? scale3(m.constraint.dir, typed) : [typed, 0, 0];
      } else delta = this.grabDelta(m);
      // In a match-moved world, snapping lands on the solve's points (Blender's snap to vertex); else the grid.
      const onPoint = this.snapOn && !m.edit && this.guides.hasPoints ? this.guides.nearest((p) => this.toScreen(p), m.mouse[0], m.mouse[1]) : null;
      if (onPoint) delta = sub(onPoint, m.pivot);
      else if (this.snapOn) delta = [snapTo(delta[0], step), snapTo(delta[1], step), snapTo(delta[2], step)];
      D = translate4(delta);
      hud = m.constraint && !m.constraint.plane
        ? `D: ${fmt(dot(delta, m.constraint.dir))} along ${m.constraint.label}`
        : `Dx: ${fmt(delta[0])}  Dy: ${fmt(delta[1])}  Dz: ${fmt(delta[2])}  (${fmt(length3(delta))})${m.constraint ? ` ${m.constraint.label}` : m.plane ? "  on its page · Y Y lifts off it" : ""}`;
    } else if (m.kind === "rotate") {
      const { forward } = this.screenBasis();
      // A flat drawing turns in its own plane (about its page's normal), as on the canvas.
      const axis = m.constraint ? m.constraint.dir : (m.plane ?? forward);
      let deg: number;
      if (typed !== null && Number.isFinite(typed)) deg = typed;
      else {
        const a0 = Math.atan2(m.start[1] - m.pivotScreen[1], m.start[0] - m.pivotScreen[0]);
        const a1 = Math.atan2(m.mouse[1] - m.pivotScreen[1], m.mouse[0] - m.pivotScreen[0]);
        let d = ((a1 - a0) * 180) / Math.PI;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        deg = dot(axis, forward) >= 0 ? d : -d;
        m.accumulated = unwrap(m.accumulated ?? 0, deg);
        deg = m.accumulated;
      }
      if (this.snapOn) deg = snapTo(deg, 5);
      D = mul4(mul4(translate4(m.pivot), axisAngle4(axis, deg)), translate4(scale3(m.pivot, -1)));
      hud = `Rot: ${fmt(deg)}°${m.constraint ? ` ${m.constraint.label}` : ""}`;
    } else if (m.kind === "scale") {
      let f: number;
      if (typed !== null && Number.isFinite(typed)) f = typed;
      else {
        const d0 = Math.hypot(m.start[0] - m.pivotScreen[0], m.start[1] - m.pivotScreen[1]);
        const d1 = Math.hypot(m.mouse[0] - m.pivotScreen[0], m.mouse[1] - m.pivotScreen[1]);
        f = d1 / Math.max(1, d0);
      }
      if (this.snapOn) f = snapTo(f, 0.1);
      // ... and grows in its own plane, never off it.
      const S = constrainedScale(f, m.constraint ?? (m.plane ? { dir: m.plane, plane: true, label: "page", axis: null, local: true } : null));
      D = mul4(mul4(translate4(m.pivot), S), translate4(scale3(m.pivot, -1)));
      hud = `Scale: ${fmt(f)}${m.constraint ? ` ${m.constraint.label}` : ""}`;
    } else {
      // Inset: pulling toward the face centre deepens it.
      const d0 = Math.hypot(m.start[0] - m.pivotScreen[0], m.start[1] - m.pivotScreen[1]);
      const d1 = Math.hypot(m.mouse[0] - m.pivotScreen[0], m.mouse[1] - m.pivotScreen[1]);
      let thick = typed !== null && Number.isFinite(typed) ? typed : Math.max(0, (d0 - d1) * this.pixelSizeAt(m.pivot));
      if (this.snapOn) thick = snapTo(thick, step);
      if (m.edit) {
        const res = insetFaces(m.edit.startMesh, m.edit.sel, thick);
        this.setLive(m.edit.target, res.mesh);
        m.insetSel = res.selection;
      }
      useWorldUi.getState().set({ hud: `Inset: ${fmt(thick)}${m.typed ? ` [${m.typed}]` : ""}` });
      this.dirty = true;
      return;
    }
    if (m.typed) hud += `  [${m.typed}]`;
    if (m.edit?.weights) hud += `   Proportional size: ${fmt(ui.propRadius)}`;
    useWorldUi.getState().set({ hud });
    this.applyModalDelta(m, D);
    this.dirty = true;
  }

  private grabDelta(m: Modal): V3 {
    const c = m.constraint;
    const { forward } = this.screenBasis();
    if (c && !c.plane) {
      // Closest point on the axis line to each mouse ray; the delta is the difference.
      const t0 = this.axisParam(m.start, m.pivot, c.dir);
      const t1 = this.axisParam(m.mouse, m.pivot, c.dir);
      return scale3(c.dir, t1 - t0);
    }
    // The page itself, unless it is seen edge-on (a ray along it lands nowhere useful): then the view's plane.
    const page = m.plane && Math.abs(dot(m.plane, forward)) > 0.2 ? m.plane : null;
    const n = c ? c.dir : (page ?? forward);
    const a = this.hitPlane(m.start[0], m.start[1], m.pivot, n);
    const b = this.hitPlane(m.mouse[0], m.mouse[1], m.pivot, n);
    if (!a || !b) return [0, 0, 0];
    const d = sub(b, a);
    // Edge-on, the view's move is flattened onto the page: a flat drawing never gains depth by accident.
    return !c && m.plane && !page ? sub(d, scale3(m.plane, dot(d, m.plane))) : d;
  }

  /** Parameter along a line (p + t·d) closest to the mouse ray. */
  private axisParam(mouse: [number, number], p: V3, d: V3): number {
    const { o, d: r } = this.ray(mouse[0], mouse[1]);
    const w = sub(p, o);
    const a = dot(d, d), b = dot(d, r), c = dot(r, r), dd = dot(d, w), e = dot(r, w);
    const den = a * c - b * b;
    if (Math.abs(den) < 1e-9) return 0;
    return (b * e - c * dd) / den;
  }

  private applyModalDelta(m: Modal, D: Mat4): void {
    if (m.bones && m.kind !== "inset") {
      const r = this.bones.modalRecipe(m.bones, D, m.kind);
      this.store.setOverlay(r.recipe);
      this.pendingBones = r;
      return;
    }
    if (m.edit) {
      const local = mul4(mul4(m.edit.inv, D), m.edit.obj);
      this.setLive(m.edit.target, m.edit.weights ? transformVertsWeighted(m.edit.startMesh, m.edit.weights, local) : transformVerts(m.edit.startMesh, m.edit.verts, local), this.cageMove(m));
      return;
    }
    const recording = useSession.getState().recording;
    const playhead = useSession.getState().playheadMs;
    const items = m.objects.map(({ o, start, parent }) => ({ id: o.id, values: transformValuesFor(o.source, mul4(D, start), parent) }));
    // A live, uncommitted preview the whole app sees (inspector, timeline):
    // the same keyed-or-resting write the commit makes, on an overlay.
    this.store.setOverlay((d) => {
      for (const it of items) {
        const loc = locateClip(d, it.id);
        if (!loc || loc.clip.kind === "audio") continue;
        const local = playhead - loc.clip.startMs;
        for (const [k, v] of Object.entries(it.values)) writeChannel(loc.clip, k, local, v, { forceKey: recording });
      }
    });
    this.pendingItems = items;
  }
  private pendingItems: Array<{ id: string; values: Record<string, number> }> = [];
  private pendingBones: { label: string; recipe: (d: MotionDocument) => void } | null = null;

  confirmModal(): void {
    const m = this.modal;
    if (!m) return;
    this.modal = null;
    useWorldUi.getState().set({ hud: null });
    if (m.bones) {
      const r = this.pendingBones;
      this.pendingBones = null;
      this.store.setOverlay(null);
      if (r) this.store.update(r.label, r.recipe);
      this.dirty = true;
      return;
    }
    if (m.edit) {
      const mesh = this.liveCage;
      const move = this.liveMove;
      this.liveCage = null;
      if (mesh) m.edit.target.commit(mesh, labelOf(m), move);
      else m.edit.target.clearPreview();
      // A handle dissolved into its node takes a point out of the cage: what
      // was selected is re-found by the nodes it named, in the new layout.
      if (isPathTarget(m.edit.target)) this.reselectPathNodes(m.edit.target, m.edit.sel);
      if (m.kind === "inset" && m.insetSel) useWorldUi.getState().set({ elementSel: m.insetSel });
    } else {
      this.store.setOverlay(null);
      if (this.pendingItems.length) commitPlacements(this.store, labelOf(m), this.pendingItems);
      this.pendingItems = [];
    }
    this.dirty = true;
  }

  cancelModal(): void {
    const m = this.modal;
    if (!m) return;
    this.modal = null;
    useWorldUi.getState().set({ hud: null });
    if (m.bones) {
      this.pendingBones = null;
      this.store.setOverlay(null);
      this.dirty = true;
      return;
    }
    if (m.edit) {
      this.liveCage = null;
      m.edit.target.clearPreview();
      if (m.restoreSel) useWorldUi.getState().set({ elementSel: m.restoreSel });
      // An extrude or duplicate that is cancelled leaves the new geometry in
      // place, unmoved — exactly Blender's behaviour.
      if (m.cancelMesh) m.edit.target.commit(m.cancelMesh, labelOf(m));
    } else {
      this.store.setOverlay(null);
      this.pendingItems = [];
    }
    this.dirty = true;
  }

  /** A bone being drawn or edited right now (Esc cancels it). */
  get bonesActive(): boolean {
    return this.bones.active;
  }

  cancelBones(): void {
    this.bones.end(false);
    this.dirty = true;
  }

  /** A modifier changed mid-operator (⌥ pressed or let go): read the move again. */
  refreshModal(): void {
    if (this.modal) this.updateModal();
  }

  /** E with a bone picked in Setup or the Bone tool: a child grows from its tip, following the pointer. */
  extrudeBone(): boolean {
    const setup = useWorldUi.getState().tool === "bone" || useRigUi.getState().mode === "setup";
    if (!setup || useWorldUi.getState().mode !== "object") return false;
    const ok = this.bones.beginExtrude();
    if (ok) {
      this.bones.move(this.lastMouse[0], this.lastMouse[1]);
      this.dirty = true;
    }
    return ok;
  }

  /**
   * E — extrude, then move. A mesh's selection along its normal; a path's
   * nodes each grow a new point (core `extrudeNodes`: an open end continues,
   * a middle node starts a welded branch) that follows the pointer on the
   * drawing's page. Cancelled, nothing was added.
   */
  extrudeModal(): boolean {
    const ui = useWorldUi.getState();
    const target = this.editTarget();
    if (isPathTarget(target)) return this.extrudePath(target);
    const mesh = this.editMesh();
    const o = this.editObject();
    if (!target || !mesh || !o) return false;
    const res = extrude(mesh, ui.elementSel);
    if (res.mesh === mesh) return false;
    const nLocal = selectionNormal(mesh, ui.elementSel);
    const n = normalize3(sub(transformPoint(o.matrix, nLocal), transformPoint(o.matrix, [0, 0, 0])));
    useWorldUi.getState().set({ elementSel: res.selection });
    this.setLive(target, res.mesh);
    const ok = this.beginModal("grab", { constraint: { dir: n, plane: false, label: "normal", axis: null, local: true }, label: "Extrude", cancelMesh: res.mesh });
    if (!ok) {
      this.liveCage = null;
      target.clearPreview();
    }
    return ok;
  }

  private extrudePath(target: PathEditTarget): boolean {
    const ui = useWorldUi.getState();
    const cage = target.cage();
    const refs = target.nodesOf(selectedVerts(cage.mesh, ui.elementSel));
    if (!refs.length) return false;
    const subs = copySubpaths(target.outline());
    const r = runNodeVerb("extrude", subs, refs);
    if (!r.changed || !r.select?.length) return false;
    const grown = target.withOutline(subs, "Extrude");
    const before = ui.elementSel;
    ui.set({ elementSel: { ...EMPTY_SELECTION, mode: "vertex", verts: vertsOfNodes(subs, r.select) } });
    this.setLive(grown, grown.cage().mesh);
    const ok = this.beginModal("grab", { target: grown, label: "Extrude", restoreSel: before });
    if (!ok) {
      this.liveCage = null;
      grown.clearPreview();
      ui.set({ elementSel: before });
    }
    return ok;
  }

  /**
   * After a write that changed the cage's layout (a handle dissolved into its
   * node takes a point out), select the same nodes again in the new one.
   */
  private reselectPathNodes(target: PathEditTarget, sel: MeshSelection): void {
    const fresh = this.editTarget();
    if (!isPathTarget(fresh) || fresh.cage().mesh.positions.length === target.cage().mesh.positions.length) return;
    const verts = vertsOfNodes(fresh.outline(), target.nodesOf(new Set(sel.verts)));
    useWorldUi.getState().set({ elementSel: { ...EMPTY_SELECTION, mode: "vertex", verts } });
  }


  insetModal(): void {
    if (this.editMesh()) this.beginModal("inset", { label: "Inset" });
  }

  // ── Gizmo ──────────────────────────────────────────────────────────────────

  private syncGizmo(ui: WorldUi, selected: string[]): void {
    // A drag the gizmo is driving is left alone. The drag runs on the modal
    // machinery (G/R/S), and the rule below hides the gizmo while a modal runs
    // — so the first redraw after a handle was grabbed DETACHED the gizmo
    // mid-drag: its axis went null and every later move was ignored. That is
    // the "it moves a pixel, then lets go" bug, on mouse and tablet alike.
    if (this.gizmoStart) return;
    const tool = ui.tool;
    const show = (tool === "move" || tool === "rotate" || tool === "scale" || tool === "transform") && !this.modal && !ui.throughCamera;
    let pivot: V3 | null = null;
    let axes: Mat4 | null = null;
    if (show) {
      if (ui.mode === "edit") {
        const mesh = this.editCage();
        const o = this.editObject();
        const med = mesh ? selectionMedian(mesh, ui.elementSel) : null;
        if (o && med) {
          pivot = transformPoint(o.matrix, med);
          axes = stripScale(o.matrix);
        }
      } else {
        const objs = this.ev?.objects.filter((o) => selected.includes(o.id)) ?? [];
        if (objs.length) {
          pivot = scale3(objs.reduce((a, o) => add(a, matPosition(o.matrix)), [0, 0, 0] as V3), 1 / objs.length);
          axes = stripScale(objs[objs.length - 1]!.matrix);
        }
      }
    }
    if (!pivot) {
      if (this.gizmo.object) this.gizmo.detach();
      return;
    }
    this.gizmo.setMode(tool === "rotate" ? "rotate" : tool === "scale" ? "scale" : "translate");
    this.gizmo.setSpace(ui.orientation === "local" ? "local" : "world");
    this.gizmoProxy.position.set(pivot[0] * UNIT, pivot[1] * UNIT, pivot[2] * UNIT);
    if (axes) {
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(axes));
      this.gizmoProxy.quaternion.copy(q);
    }
    this.gizmoProxy.scale.set(1, 1, 1);
    this.gizmoProxy.updateMatrixWorld();
    if (this.gizmo.object !== this.gizmoProxy) this.gizmo.attach(this.gizmoProxy);
    if (ui.snap) {
      this.gizmo.setTranslationSnap((ui.gridSize / ui.gridDivisions) * UNIT);
      this.gizmo.setRotationSnap((5 * Math.PI) / 180);
      this.gizmo.setScaleSnap(0.1);
    } else {
      this.gizmo.setTranslationSnap(null);
      this.gizmo.setRotationSnap(null);
      this.gizmo.setScaleSnap(null);
    }
  }

  private onGizmoDragging(on: boolean): void {
    if (on) {
      this.gizmoStart = { pos: this.gizmoProxy.position.clone(), quat: this.gizmoProxy.quaternion.clone(), scale: this.gizmoProxy.scale.clone() };
      // Reuse the modal machinery with a pre-made delta.
      this.beginModal("grab", { label: "Transform" });
    } else {
      this.gizmoStart = null;
      // A gizmo drag the owner never released (a second finger, a cancel) puts everything back.
      if (this.gizmoCancel) this.cancelModal();
      else this.confirmModal();
    }
  }

  private onGizmoChange(): void {
    const s = this.gizmoStart;
    const m = this.modal;
    if (!s || !m) return;
    const p0 = new THREE.Vector3().copy(s.pos).multiplyScalar(1 / UNIT);
    const p1 = new THREE.Vector3().copy(this.gizmoProxy.position).multiplyScalar(1 / UNIT);
    const rotDelta = this.gizmoProxy.quaternion.clone().multiply(s.quat.clone().invert());
    const sc = this.gizmoProxy.scale;
    // Scale happens in the gizmo's own axes; rotation and move in the world.
    const R = new THREE.Matrix4().makeRotationFromQuaternion(rotDelta).elements;
    const Q = new THREE.Matrix4().makeRotationFromQuaternion(s.quat).elements;
    const Qi = new THREE.Matrix4().makeRotationFromQuaternion(s.quat.clone().invert()).elements;
    const S = mul4(mul4(Array.from(Q), [sc.x, 0, 0, 0, 0, sc.y, 0, 0, 0, 0, sc.z, 0, 0, 0, 0, 1]), Array.from(Qi));
    const pivot: V3 = [p0.x, p0.y, p0.z];
    // D = T(p1) · R · S · T(−p0): about where the gizmo started, to where it is.
    const D = mul4(translate4([p1.x, p1.y, p1.z]), mul4(mul4(Array.from(R), S), translate4(scale3(pivot, -1))));
    this.applyModalDelta(m, D);
    useWorldUi.getState().set({ hud: null });
    this.dirty = true;
  }

  // ── View operations ────────────────────────────────────────────────────────

  setView(next: ViewState, animate = true): void {
    if (useWorldUi.getState().throughCamera && !useWorldUi.getState().lockCamera) useWorldUi.getState().set({ throughCamera: false });
    if (animate) this.viewAnim = { from: this.view, to: next, t0: performance.now() };
    else this.view = next;
    this.dirty = true;
    this.onViewChanged();
  }

  /** The HUD's name for the lens: the camera's own name, and whether it is the one rendering. */
  private throughLabel(ev: WorldEval): string {
    const lens = this.viewCam(ev);
    if (!lens.clipId) return "Default camera";
    const name = ev.objects.find((o) => o.id === lens.clipId)?.clip.name || "Camera";
    return lens.clipId === ev.camera.clipId ? name : `${name} · not live`;
  }

  /** With Lock Camera to View, navigating moves the camera you look through (and records it when recording). */
  private onViewChanged(): void {
    const ui = useWorldUi.getState();
    if (!ui.throughCamera || !ui.lockCamera) return;
    const ev = this.ev;
    const camId = ev ? this.viewCam(ev).clipId : null;
    const o = camId ? ev?.objects.find((x) => x.id === camId) : undefined;
    if (!o) return;
    const v = this.viewAnim?.to ?? this.view;
    const eye = eyeOf(v);
    const { right, up, forward } = viewBasis(v);
    const m: Mat4 = [right[0], right[1], right[2], 0, up[0], up[1], up[2], 0, -forward[0], -forward[1], -forward[2], 0, eye[0], eye[1], eye[2], 1];
    commitPlacements(this.store, "Move camera", [{ id: o.id, values: transformValuesFor(o.source, m, parentMatrixOf(o)) }], "camera-lock");
  }

  /** Enter/leave the live camera (numpad 0). Entering with lock on derives the view from the camera. */
  toggleCameraView(): void {
    const ui = useWorldUi.getState();
    const on = !ui.throughCamera;
    // A world with no camera at all gets its camera NOW, as a layer: a view
    // you can look through but never move, lock or key reads as broken.
    if (on && !worldHasCamera(this.store.getState(), this.frameId)) {
      const id = makeDefaultCameraReal(this.store, this.frameId);
      if (id) ui.set({ viewCameraId: id });
    }
    ui.set({ throughCamera: on });
    if (on && this.ev) this.view = this.viewFromCamera(this.viewCam(this.ev));
    this.dirty = true;
  }

  /** Look through THIS camera (double-click it, or its row's menu) — without making it the one that renders. */
  lookThrough(cameraId: string): void {
    useWorldUi.getState().set({ viewCameraId: cameraId, throughCamera: true });
    this.dirty = true;
    if (this.ev) {
      const o = this.ev.objects.find((x) => x.id === cameraId && x.kind === "camera");
      if (o) this.view = this.viewFromCamera(cameraEvalOf(o, this.ev.width, this.ev.height));
    }
  }

  /**
   * Lock camera to view. A lock needs a camera to move, so with only the
   * default camera showing it becomes a real layer first — the one state that
   * used to look locked and move nothing.
   */
  setCameraLock(on: boolean): void {
    const ui = useWorldUi.getState();
    if (on && this.ev && this.viewCam(this.ev).clipId === null) {
      const id = makeDefaultCameraReal(this.store, this.frameId);
      if (!id) return;
      ui.set({ viewCameraId: id });
    }
    ui.set({ lockCamera: on, throughCamera: on || ui.throughCamera });
    this.dirty = true;
  }

  private viewFromCamera(cam: CameraEval, distance?: number): ViewState {
    const m = cam.matrix;
    const pos = matPosition(m);
    const fwd = normalize3(scale3(matAxis(m, 2), -1));
    const dist = distance ?? Math.max(100, length3(pos) || 1000);
    const pitch = (Math.asin(Math.max(-1, Math.min(1, -fwd[2]))) * 180) / Math.PI;
    const yaw = (Math.atan2(-fwd[0], fwd[1]) * 180) / Math.PI;
    return { ...this.view, target: add(pos, scale3(fwd, dist)), distance: dist, yaw, pitch, ortho: false };
  }

  /** Ctrl+Alt+Numpad0 — put the active camera where the view is. */
  cameraToView(): void {
    const ev = this.ev;
    const camId = ev ? this.viewCam(ev).clipId : null;
    const o = camId ? ev?.objects.find((x) => x.id === camId) : undefined;
    if (!o) return;
    const v = this.view;
    const eye = eyeOf(v);
    const { right, up, forward } = viewBasis(v);
    const m: Mat4 = [right[0], right[1], right[2], 0, up[0], up[1], up[2], 0, -forward[0], -forward[1], -forward[2], 0, eye[0], eye[1], eye[2], 1];
    commitPlacements(this.store, "Camera to view", [{ id: o.id, values: transformValuesFor(o.source, m, parentMatrixOf(o)) }]);
    useWorldUi.getState().set({ throughCamera: true });
  }

  private framed(objs: WorldObject[], v: ViewState): ViewState {
    if (!objs.length) return { ...v, target: [0, 0, 0], distance: 1500 };
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const o of objs) {
      const b = objectWorldBounds(o, this.store.getState());
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, b.min[k]!);
        max[k] = Math.max(max[k]!, b.max[k]!);
      }
    }
    return frameBox(v, min, max, this.width / this.height);
  }

  frameSelected(): void {
    const ui = useWorldUi.getState();
    if (ui.mode === "edit") {
      const mesh = this.editCage();
      const o = this.editObject();
      if (mesh && o) {
        const vs = [...selectedVerts(mesh, ui.elementSel)];
        if (vs.length) {
          const pts = vs.map((v) => transformPoint(o.matrix, [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!]));
          const min = pts.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.min(a[2], p[2])] as V3, [Infinity, Infinity, Infinity] as V3);
          const max = pts.reduce((a, p) => [Math.max(a[0], p[0]), Math.max(a[1], p[1]), Math.max(a[2], p[2])] as V3, [-Infinity, -Infinity, -Infinity] as V3);
          this.setView(frameBox(this.view, min, max, this.width / this.height));
          return;
        }
      }
    }
    const ids = useSession.getState().selectedClipIds;
    const objs = this.ev?.objects.filter((o) => ids.includes(o.id)) ?? [];
    if (!objs.length) return this.frameAll();
    this.setView(this.framed(objs, this.view));
  }

  frameAll(): void {
    this.setView(this.framed(this.ev?.objects ?? [], this.view));
  }

  // ── Theme ──────────────────────────────────────────────────────────────────

  /** Repaint the furniture in a theme's colours (hex): its stage void and its ink. */
  setTheme(colors: { stage: string; foreground: string; light: boolean }): void {
    const ink = new THREE.Color(colors.foreground);
    const voidColor = new THREE.Color(colors.stage);
    this.theme = {
      void: voidColor,
      ink,
      // Idle wires sit between the ink and the void: present, never loud.
      wire: voidColor.clone().lerp(ink, colors.light ? 0.55 : 0.45),
      css: `${Math.round(ink.r * 255)},${Math.round(ink.g * 255)},${Math.round(ink.b * 255)}`,
      light: colors.light,
    };
    const mat = this.grid.material as THREE.ShaderMaterial;
    (mat.uniforms.uColor!.value as THREE.Color).copy(ink);
    mat.uniforms.uOpacity!.value = colors.light ? 0.2 : 0.14;
    this.editOverlay.setInk(this.theme.wire);
    this.dirty = true;
  }

  private ink(alpha: number): string {
    return `rgba(${this.theme.css},${alpha})`;
  }

  // ── Pointer input ──────────────────────────────────────────────────────────
  //
  // ONE pointer owns a gesture, from its press to its release. The stage in
  // front of this (WorldStage) has already asked the app's input stack what
  // the press may be: `useTouchIntent` (may this finger drive the armed tool,
  // or does it navigate), `useMultiTouch` (two fingers navigate), the arbiter
  // (a second finger ends this one). So everything that arrives here is a
  // press the tool should have — and a release that never came (a cancel, a
  // second finger, a lost pointer) ABORTS through `abortGesture`, it never
  // commits.

  /** Is a gesture under way? (The stage keeps a resting palm out while a pen draws.) */
  get ownerType(): string | null {
    return this.owner?.type ?? null;
  }

  private own(e: PointerEvent): void {
    this.owner = { id: e.pointerId, type: e.pointerType };
  }

  pointerDown(e: PointerEvent): void {
    if (this.owner) {
      // A pen takes the surface from a hand that was resting on it; anything
      // else is a second pointer, and a second pointer is never a second gesture.
      if (e.pointerType !== "pen" || this.owner.type === "pen") return;
      this.abortGesture();
    }
    const [x, y] = this.local(e);
    this.lastMouse = [x, y];
    const ui = useWorldUi.getState();
    if (this.modal) {
      if (e.button === 2) this.cancelModal();
      else this.confirmModal();
      return;
    }
    // E's extrude follows the pointer with no button held: a click lands it, a right-click drops it.
    if (this.bones.waitsForClick) {
      this.bones.end(e.button === 0);
      this.dirty = true;
      return;
    }
    if (e.button === 1 || (e.button === 0 && e.altKey && !ui.editClipId)) {
      e.preventDefault();
      this.own(e);
      this.drag = { kind: e.shiftKey ? "pan" : e.ctrlKey || e.metaKey ? "zoom" : "orbit", x, y, sx: x, sy: y, id: e.pointerId, shift: e.shiftKey, ctrl: e.ctrlKey };
      return;
    }
    if (e.button === 2) {
      if (e.shiftKey) {
        // Shift+right-click places the 3D cursor (Blender).
        ui.set({ cursor: this.surfacePoint(x, y) });
        this.dirty = true;
      }
      return;
    }
    if (e.button !== 0) return;
    this.own(e);
    // Handles first: the gizmo's arrows and a rig's bones are grabbed by
    // whatever lands on them, a finger included (moving is a finger's job).
    if (this.gizmoDown(x, y)) return;
    const bone = ui.mode === "object" ? this.bones.hit(x, y) : null;
    if (bone) {
      this.bones.begin(bone, x, y, e.shiftKey, e.ctrlKey || e.metaKey);
      this.dirty = true;
      return;
    }
    // The Bone tool on empty space: a new bone, from the plane through the 3D cursor.
    if (ui.tool === "bone" && ui.mode === "object") {
      this.bones.beginDraw(x, y);
      this.dirty = true;
      return;
    }
    switch (ui.tool) {
      case "draw":
        this.drawing = new DrawGesture(e, (ev) => this.localPoint(ev));
        this.drawStart = { x, y };
        this.hudDirty = true;
        return;
      case "knife":
        this.stroke = [[x, y]];
        this.hudDirty = true;
        return;
      case "paint":
        return this.paintDown(e, x, y);
      case "erase":
        this.erasing = new Set();
        this.eraseAt(x, y);
        return;
      case "sculpt":
        if (this.sculptDown(e, x, y)) return;
        // Off the shape, a FINGER turns the view (Nomad's rule on a tablet).
        // A mouse, a trackpad or a pen stays the tool's and does nothing there:
        // navigation on a laptop is the wheel, the trackpad's two fingers and
        // the middle button, never a click.
        if (e.pointerType === "touch") this.drag = { kind: "orbit", x, y, sx: x, sy: y, id: e.pointerId, shift: false, ctrl: false };
        else this.release();
        return;
      case "cursor":
        ui.set({ cursor: this.surfacePoint(x, y) });
        this.dirty = true;
        this.release();
        return;
      case "fill":
        this.drag = { kind: "fill", x, y, sx: x, sy: y, id: e.pointerId, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
        return;
      case "text":
      case "shape":
        // A place tool acts on the CLICK (release without travel), like every
        // tool: acting on the press opened the text field before the press's own
        // default (focusing the canvas) ran, and that focus closed the field.
        this.drag = { kind: "place", x, y, sx: x, sy: y, id: e.pointerId, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
        return;
      default: {
        // In edit mode a press ON a point (an edge, a face) is the start of a
        // drag that moves it — the pen's drag, Blender's tweak. Off them, a
        // drag sweeps a box.
        const element = ui.mode === "edit" && !this.loopCutArmed ? this.pickElement(x, y) : null;
        // In Object mode a mouse or pen pressed ON an object drags it — the
        // flat canvas's drag, dropped where it is let go. A finger's drag stays
        // the view's (an object never moves under a hand that meant to look).
        const object = ui.mode === "object" && e.pointerType !== "touch" && (ui.tool === "select" || ui.tool === "move") ? this.pickObject(x, y) : null;
        this.drag = { kind: "maybeClick", x, y, sx: x, sy: y, id: e.pointerId, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, element, object: object === GHOST_CAMERA ? null : object };
      }
    }
  }

  /**
   * ⌥ + press in edit mode. On a path: on a node, pull fresh handles out of
   * it (a drag) — on a handle, the drag breaks it from its partner (the plain
   * press path, with ⌥ read live) — elsewhere, select the whole line under
   * the pointer. On a mesh: the edge loop. Returns whether it took the press.
   */
  altPress(e: PointerEvent): boolean {
    const [x, y] = this.local(e);
    this.lastMouse = [x, y];
    const t = this.editTarget();
    if (!isPathTarget(t)) {
      this.loopSelect(x, y, e.shiftKey);
      return true;
    }
    const hit = this.pathPointAt(x, y);
    if (hit?.part === "anchor") {
      const o = this.editObject();
      if (!o) return true;
      const cage = t.cage();
      const at = transformPoint(o.matrix, [cage.mesh.positions[hit.vert * 3]!, cage.mesh.positions[hit.vert * 3 + 1]!, cage.mesh.positions[hit.vert * 3 + 2]!]);
      this.own(e);
      this.pull = { id: e.pointerId, target: t, ref: hit.ref, start: copySubpaths(t.outline()), at, normal: normalize3(matAxis(o.matrix, 1)), next: null };
      useWorldUi.getState().set({ elementSel: { ...EMPTY_SELECTION, mode: "vertex", verts: [hit.vert] } });
      this.dirty = true;
      return true;
    }
    if (hit) return false; // a handle: the ordinary drag, ⌥ breaking it
    const seg = this.pathSegmentAt(x, y);
    const ref = seg ? t.refOf(seg.a) : null;
    if (ref) {
      const run = runNodeVerb("selectRun", copySubpaths(t.outline()), [{ sub: ref.sub, index: ref.index }]);
      const verts = vertsOfNodes(t.outline(), run.select ?? []);
      const prev = e.shiftKey ? useWorldUi.getState().elementSel.verts : [];
      useWorldUi.getState().set({ elementSel: { ...EMPTY_SELECTION, mode: "vertex", verts: [...new Set([...prev, ...verts])] } });
      this.dirty = true;
    }
    return true;
  }

  /** One move of a handle pull: the pointer on the node's page, the pair balanced through the node. */
  private pullMove(x: number, y: number): void {
    const p = this.pull!;
    const o = this.editObject();
    if (!o) return;
    const forward = this.screenBasis().forward;
    const n = Math.abs(dot(p.normal, forward)) > 0.2 ? p.normal : forward;
    const w = this.hitPlane(x, y, p.at, n);
    if (!w) return;
    const subs = copySubpaths(p.start);
    const pt = subs[p.ref.sub]?.points[p.ref.index];
    if (!pt) return;
    const q = localToPlane(planeBasis(this.store.getState(), o.source), transformPoint(invert4(o.matrix), w));
    // The arm is drawn on the node's own depth plane: a pull shapes the curve,
    // it does not tip the node's tangent out of its page.
    const dx = q.x - pt.x, dy = q.y - pt.y;
    if (Math.hypot(dx, dy) < 1e-6) return;
    const z = pt.z;
    pt.hOut = z === undefined ? { x: pt.x + dx, y: pt.y + dy } : { x: pt.x + dx, y: pt.y + dy, z };
    pt.hIn = z === undefined ? { x: pt.x - dx, y: pt.y - dy } : { x: pt.x - dx, y: pt.y - dy, z };
    p.next = subs;
    p.target.previewOutline(subs);
    this.dirty = true;
  }

  /**
   * A TAP the stage resolved after the finger lifted (`useTouchIntent`: a
   * still press, or one held then released) — the tool's click, with no drag
   * behind it. A brush the finger may not paint with does nothing on a tap.
   */
  tap(e: PointerEvent): void {
    const tool = useWorldUi.getState().tool;
    if (strokeToolOf(tool)) return;
    this.pointerDown(e);
    if (this.owner?.id === e.pointerId) this.pointerUp(e);
  }

  /** One finger navigating (the stage's touch intent decided this press was a look, not a tool). */
  orbitBy(dx: number, dy: number): void {
    this.setView(orbit(this.view, dx, dy), false);
  }

  /** Two fingers: the centroid pans, the spread zooms toward where they are. */
  touchNavigate(g: { scale: number; dx: number; dy: number; x: number; y: number }): void {
    let v = pan(this.view, g.dx, g.dy, this.height);
    if (Math.abs(g.scale - 1) > 1e-4) v = zoom(v, 1 / g.scale, this.surfaceOrTarget(g.x, g.y));
    this.setView(v, false);
  }

  pointerMove(e: PointerEvent): void {
    const [x, y] = this.local(e);
    if (!this.owner) {
      this.lastMouse = [x, y];
      // G / R / S from the keyboard follow the pointer with no button held,
      // until a click lands them (Blender's operator) — never the gizmo's own drag.
      if (this.modal && !this.gizmoStart) {
        const mods = gestureMods(e);
        this.modalMouse(x, y, mods.shift, mods.meta);
        return;
      }
      // A bone extruded with E follows the pointer with no button held, until a click lands it.
      if (this.bones.waitsForClick) {
        this.bones.move(x, y);
        this.dirty = true;
        return;
      }
      // Hover: only a pointer that CAN hover (a finger never does).
      if (e.pointerType === "touch") return;
      this.hover = [x, y];
      if (this.gizmo.object) this.gizmo.pointerHover(this.ndc(x, y, -1));
      if (useWorldUi.getState().tool === "sculpt") this.hudDirty = true;
      // Hover feedback in edit mode for a pending loop cut.
      if (this.loopCutArmed) this.updateLoopCutHover(x, y);
      return;
    }
    if (e.pointerId !== this.owner.id) return;
    this.lastMouse = [x, y];
    this.hover = [x, y];
    if (this.gizmoDrive) {
      this.gizmo.pointerMove(this.ndc(x, y, -1));
      return;
    }
    if (this.bones.active) {
      this.bones.move(x, y);
      this.dirty = true;
      return;
    }
    if (this.pull) return this.pullMove(x, y);
    if (this.drawing) {
      this.drawing.push(e, (ev) => this.localPoint(ev));
      this.hudDirty = true;
      return;
    }
    if (this.sculpting || this.pathSculpt) {
      for (const ev of coalescedEvents(e)) this.sculptMove(ev);
      return;
    }
    if (this.painting) {
      for (const ev of coalescedEvents(e)) {
        const [ex, ey] = this.local(ev);
        this.paintSample(ev, ex, ey);
      }
      return;
    }
    if (this.erasing) {
      for (const ev of coalescedEvents(e)) this.eraseAt(...this.local(ev));
      return;
    }
    if (this.stroke) {
      this.stroke = [this.stroke[0]!, [x, y]];
      this.hudDirty = true;
      return;
    }
    if (this.modal) {
      // A gizmo-driven transform is the gizmo's: the pointer does not also drive it.
      if (!this.gizmoStart) {
        // Modifiers come from the APP (keyboard or the touch puck), never the event alone.
        const mods = gestureMods(e);
        this.modalMouse(x, y, mods.shift, mods.meta);
      }
      return;
    }
    const d = this.drag;
    if (!d) return;
    const dx = x - d.x, dy = y - d.y;
    d.x = x;
    d.y = y;
    if (d.kind === "maybeClick" && Math.hypot(x - d.sx, y - d.sy) > 4) {
      if (d.element || d.object) {
        // A drag that began on a point (an object) moves it — and, when it
        // was part of the selection, the whole selection with it.
        this.tweak(d, e.pointerId);
        return;
      }
      // A finger that got here was handed the tool (the "tool" finger setting,
      // or a hold): a drag from it still turns the view. Mouse and pen sweep a box.
      d.kind = e.pointerType === "touch" ? "orbit" : "box";
    }
    if (d.kind === "orbit") this.setView(orbit(this.view, dx, dy), false);
    else if (d.kind === "pan") this.setView(pan(this.view, dx, dy, this.height), false);
    else if (d.kind === "zoom") this.setView(zoom(this.view, Math.exp(dy * 0.01)), false);
    else if (d.kind === "box") {
      this.box = [d.sx, d.sy, x, y];
      this.hudDirty = true;
    }
  }

  pointerUp(e: PointerEvent): void {
    if (!this.owner || e.pointerId !== this.owner.id) return;
    this.release();
    const [x, y] = this.local(e);
    if (this.bones.waitsForClick) return;
    // A drag that began on a point lands where it is let go.
    if (this.modal?.tweak === e.pointerId) {
      this.confirmModal();
      return;
    }
    if (this.pull) {
      const p = this.pull;
      this.pull = null;
      if (p.next) p.target.commitOutline(p.next, "Pull handles");
      else p.target.clearPreview();
      this.dirty = true;
      return;
    }
    if (this.gizmoDrive) {
      this.gizmoDrive = false;
      this.gizmo.pointerUp(this.ndc(x, y, 0));
      return;
    }
    if (this.bones.active) {
      this.bones.end(true);
      this.dirty = true;
      return;
    }
    if (this.painting) {
      this.painting = null;
      this.onPaint?.end();
      this.dirty = true;
      return;
    }
    if (this.sculpting || this.pathSculpt) return this.sculptEnd(true);
    if (this.erasing) {
      const ids = [...this.erasing];
      this.erasing = null;
      this.erasePath = [];
      this.dirty = true;
      if (ids.length) this.onErase?.(ids);
      return;
    }
    if (this.drawing) {
      const g = this.drawing;
      const at = this.drawLanding(this.drawStart ?? { x, y }, g.sizePx / 2);
      this.drawing = null;
      this.hudDirty = true;
      this.onDraw?.(g, at);
      return;
    }
    if (this.stroke) {
      this.finishStroke();
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const still = Math.hypot(x - d.sx, y - d.sy) < 6;
    if (d.kind === "maybeClick") this.click(x, y, d.shift || d.ctrl, d.element);
    else if (d.kind === "place") {
      const tool = useWorldUi.getState().tool;
      if ((tool === "text" || tool === "shape") && still) this.onPlace?.(tool, this.surfacePoint(x, y), this.pickObject(x, y));
    } else if (d.kind === "fill") {
      if (still) this.onFill?.(x, y);
    } else if (d.kind === "box" && this.box) {
      this.boxSelect(this.box, d.shift || d.ctrl);
      this.box = null;
    }
    this.dirty = true;
  }

  /**
   * The owner's release will never come — a `pointercancel`, a second finger
   * (`superseded`), a lost pointer. Whatever was in flight is UNDONE, never
   * committed: nothing on release is a decision the user made if the release
   * never happened.
   */
  pointerEnded(id: number): void {
    if (this.owner?.id === id) this.abortGesture();
  }

  /** Drop whatever gesture is in flight, leaving the document as it was before it. */
  abortGesture(): void {
    this.release();
    if (this.modal?.tweak !== undefined) this.cancelModal();
    if (this.pull) {
      this.pull.target.clearPreview();
      this.pull = null;
    }
    if (this.gizmoDrive) {
      this.gizmoDrive = false;
      this.gizmoCancel = true;
      this.gizmo.pointerUp(this.ndc(0, 0, 0));
      this.gizmoCancel = false;
    }
    if (this.bones.active) this.bones.end(false);
    if (this.painting) {
      this.painting = null;
      this.onPaint?.cancel();
    }
    if (this.sculpting || this.pathSculpt) this.sculptEnd(false);
    this.drawing = null;
    this.stroke = null;
    this.erasing = null;
    this.erasePath = [];
    this.drag = null;
    this.box = null;
    this.dirty = true;
  }

  private release(): void {
    this.owner = null;
  }

  /** The pointer left the viewport: no ring where no hand is. */
  pointerLeave(): void {
    this.hover = null;
    if (!this.gizmoStart) this.gizmo.axis = null;
    this.hudDirty = true;
  }

  /** A gizmo handle under the press takes the gesture (three's controls, driven by this owner). */
  private gizmoDown(x: number, y: number): boolean {
    if (!this.gizmo.object || this.gizmo.dragging) return false;
    const p = this.ndc(x, y, 0);
    this.gizmo.pointerHover(p);
    if (this.gizmo.axis === null) return false;
    this.gizmo.pointerDown(p);
    if (!this.gizmo.dragging) return false;
    this.gizmoDrive = true;
    return true;
  }

  /** Is a grab handle (gizmo axis, bone) under this point? The stage hands a finger there to the handle, never to navigation. */
  handleAt(x: number, y: number): boolean {
    if (this.gizmo.object && !this.gizmo.dragging) {
      const was = this.gizmo.axis;
      this.gizmo.pointerHover(this.ndc(x, y, -1));
      const hot = this.gizmo.axis !== null;
      if (!hot) this.gizmo.axis = was;
      if (hot) return true;
    }
    // A path's node or handle, or a mesh vertex, under the finger is grabbed
    // by it — the finger's drag moves points; elsewhere it turns the view.
    const ui = useWorldUi.getState();
    if (ui.mode === "edit" && ui.elementMode === "vertex" && this.pickElement(x, y)?.vert !== undefined) return true;
    return ui.mode === "object" && !!this.bones.hit(x, y);
  }

  /**
   * A drag that began on a point becomes a grab of it: a point outside the
   * selection is selected first (alone, or added with ⇧), one inside moves
   * the whole selection. It follows this pointer and lands on its release.
   */
  private tweak(d: NonNullable<WorldViewport["drag"]>, pointerId: number): void {
    const ui = useWorldUi.getState();
    this.drag = null;
    if (d.object) {
      const session = useSession.getState();
      const ids = session.selectedClipIds;
      if (!ids.includes(d.object)) session.select(d.shift ? [...ids, d.object] : [d.object]);
      this.lastMouse = [d.sx, d.sy];
      if (this.beginModal("grab", { tweak: pointerId })) this.modalMouse(d.x, d.y, false, false);
      return;
    }
    const mesh = this.editCage();
    const el = d.element;
    if (!mesh || !el) return;
    const has = el.vert !== undefined ? ui.elementSel.verts.includes(el.vert) : el.edge !== undefined ? ui.elementSel.edges.includes(el.edge) : ui.elementSel.faces.includes(el.face!);
    if (!has) {
      const base = d.shift ? ui.elementSel : { ...EMPTY_SELECTION, mode: ui.elementMode };
      const sel = el.vert !== undefined ? toggle(base, "verts", el.vert, true) : el.edge !== undefined ? toggle(base, "edges", el.edge, true) : toggle(base, "faces", el.face!, true);
      ui.set({ elementSel: { ...sel, mode: ui.elementMode } });
    }
    // The grab measures from where the press began, so the point never jumps.
    this.lastMouse = [d.sx, d.sy];
    if (!this.beginModal("grab", { tweak: pointerId })) return;
    this.modalMouse(d.x, d.y, false, false);
  }

  /**
   * Screen px → the pointer three's controls read: normalised device
   * coordinates and a button (−1 = a move). Its typings call that argument a
   * PointerEvent; what its methods read is exactly these three fields (its own
   * `_getPointer` builds this shape), so the one adapter lives here.
   */
  private ndc(x: number, y: number, button: number): GizmoPointer {
    return { x: (x / this.width) * 2 - 1, y: -(y / this.height) * 2 + 1, button } as unknown as GizmoPointer;
  }

  private localPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const [x, y] = this.local(e);
    return { x, y };
  }

  wheel(e: WheelEvent): void {
    e.preventDefault();
    const [x, y] = this.local(e);
    if (this.modal) {
      // Blender: the wheel sizes the proportional falloff while it is in use.
      if (this.modal.edit?.weights) this.resizeProportional(e.deltaY > 0 ? 1 / 1.1 : 1.1);
      return;
    }
    // Trackpads send fractional, two-axis deltas; a mouse wheel sends whole notches.
    const trackpad = e.deltaMode === 0 && (e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40);
    if (e.ctrlKey || e.metaKey) {
      // Pinch (the browser reports it as ctrl+wheel) or ctrl+scroll: zoom toward the cursor.
      const toward = this.surfaceOrTarget(x, y);
      this.setView(zoom(this.view, Math.exp(e.deltaY * 0.01), toward), false);
    } else if (trackpad) {
      if (e.shiftKey) this.setView(pan(this.view, -e.deltaX, -e.deltaY, this.height), false);
      else this.setView(orbit(this.view, -e.deltaX * 0.6, -e.deltaY * 0.6), false);
    } else {
      const step = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      this.setView(zoom(this.view, step), false);
    }
  }

  /** Grow or shrink the proportional radius mid-gesture (wheel, Page Up/Down). */
  resizeProportional(factor: number): void {
    const m = this.modal;
    const ui = useWorldUi.getState();
    if (!m?.edit?.weights) return;
    const radius = Math.min(1e6, Math.max(1, ui.propRadius * factor));
    ui.set({ propRadius: radius });
    m.edit.weights = proportionalWeights(m.edit.startMesh, m.edit.verts, radius, { falloff: ui.propFalloff, matrix: m.edit.obj });
    this.updateModal();
    this.dirty = true;
  }

  private surfaceOrTarget(x: number, y: number): V3 | undefined {
    const hit = this.pickRay(x, y);
    return hit?.point;
  }

  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  get mouse(): [number, number] {
    return this.lastMouse;
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  private click(x: number, y: number, extend: boolean, picked?: { vert?: number; edge?: string; face?: number } | null): void {
    const ui = useWorldUi.getState();
    if (this.loopCutArmed && this.hoverEdge) {
      this.applyLoopCut();
      return;
    }
    if (ui.mode === "edit") {
      // The press already found what is under it; picking again costs a ray per point.
      const el = picked !== undefined ? picked : this.pickElement(x, y);
      const mesh = this.editCage();
      if (!mesh) return;
      let sel = ui.elementSel;
      if (!el) {
        if (!extend) sel = { ...EMPTY_SELECTION, mode: ui.elementMode };
      } else if (el.vert !== undefined) {
        sel = toggle(sel, "verts", el.vert, extend);
      } else if (el.edge) {
        sel = toggle(sel, "edges", el.edge, extend);
      } else if (el.face !== undefined) {
        sel = toggle(sel, "faces", el.face, extend);
      }
      ui.set({ elementSel: { ...sel, mode: ui.elementMode } });
      this.dirty = true;
      return;
    }
    const id = this.pickObject(x, y, { ghost: true });
    const session = useSession.getState();
    if (!id) {
      if (!extend) session.select([]);
      return;
    }
    // The default camera has no layer to select: picking it makes it one.
    if (id === GHOST_CAMERA) {
      makeDefaultCameraReal(this.store, this.frameId);
      return;
    }
    if (extend) {
      const cur = session.selectedClipIds;
      // Blender: shift-click an unselected object adds it (and makes it active);
      // shift-click the ACTIVE one deselects it; another selected one becomes active.
      if (cur[cur.length - 1] === id) session.select(cur.filter((x) => x !== id));
      else session.select([...cur.filter((x) => x !== id), id]);
    } else session.select([id]);
  }

  /** Alt+click in edit mode: the edge loop through the clicked edge. */
  loopSelect(x: number, y: number, extend: boolean): void {
    const ui = useWorldUi.getState();
    const mesh = this.editMesh();
    if (!mesh) return;
    const prevMode = ui.elementMode;
    ui.set({ elementMode: "edge" });
    const el = this.pickElement(x, y);
    ui.set({ elementMode: prevMode });
    if (!el?.edge) return;
    const loop = edgeLoop(mesh, el.edge);
    const asEdges: MeshSelection = { mode: "edge", verts: [], edges: loop, faces: [] };
    let sel = convertSelection(mesh, asEdges, prevMode);
    if (extend) {
      const prev = ui.elementSel;
      sel = { ...sel, verts: [...new Set([...prev.verts, ...sel.verts])], edges: [...new Set([...prev.edges, ...sel.edges])], faces: [...new Set([...prev.faces, ...sel.faces])] };
    }
    ui.set({ elementSel: sel });
    this.dirty = true;
  }

  private boxSelect(box: [number, number, number, number], extend: boolean): void {
    const ui = useWorldUi.getState();
    const [x0, y0, x1, y1] = [Math.min(box[0], box[2]), Math.min(box[1], box[3]), Math.max(box[0], box[2]), Math.max(box[1], box[3])];
    const inside = (s: [number, number] | null) => !!s && s[0] >= x0 && s[0] <= x1 && s[1] >= y0 && s[1] <= y1;
    if (ui.mode === "edit") {
      const mesh = this.editCage();
      const o = this.editObject();
      if (!mesh || !o) return;
      const sv = this.screenVerts(mesh, o.matrix, xrayOn(ui));
      const hit = new Set<number>();
      // A box takes what a target lets it (a path's nodes; their handles ride along).
      const t = this.editTarget();
      sv.forEach(([sx, sy, vis], i) => {
        if (vis && sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1 && (!t?.boxable || t.boxable(i))) hit.add(i);
      });
      const prev = extend ? selectedVerts(mesh, ui.elementSel) : new Set<number>();
      for (const v of hit) prev.add(v);
      ui.set({ elementSel: convertSelection(mesh, { mode: "vertex", verts: [...prev], edges: [], faces: [] }, ui.elementMode) });
      return;
    }
    const ids: string[] = [];
    for (const o of this.ev?.objects ?? []) {
      if (ui.localHidden.includes(o.id)) continue;
      const b = objectWorldBounds(o, this.store.getState());
      const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      if (inside(this.toScreen(o.kind === "mesh" || o.kind === "plane" ? c : matPosition(o.matrix)))) ids.push(o.id);
    }
    const session = useSession.getState();
    session.select(extend ? [...new Set([...session.selectedClipIds, ...ids])] : ids);
  }

  // ── Loop cut (Ctrl+R) ──────────────────────────────────────────────────────

  loopCutArmed = false;

  // ── Stroke tools ───────────────────────────────────────────────────────────

  /** The stroke gesture the armed tool makes — read off the ONE tool state, never kept beside it. */
  get strokeTool(): StrokeTool | null {
    return strokeToolOf(useWorldUi.getState().tool);
  }
  /** The knife's line, screen px. */
  private stroke: Array<[number, number]> | null = null;
  /** The vector brush's gesture in flight, and where it started (a surface page starts there). */
  private drawing: DrawGesture | null = null;
  private drawStart: { x: number; y: number } | null = null;
  /** The pixel layer (or mesh) the pen is painting, while it is down. */
  private painting: string | null = null;
  /** Where the last sample landed on the surface — a far jump is a texture seam. */
  private paintedAt: { x: number; y: number } | null = null;
  /** The strokes the eraser has crossed — hidden live, deleted on release, back on a cancel. */
  private erasing: Set<string> | null = null;
  private erasePath: Array<[number, number]> = [];

  /** A finished vector-brush gesture and where it lands (world/draw-stroke commits it). */
  onDraw: ((gesture: DrawGesture, at: DrawLanding) => void) | null = null;
  /** The pixel brush on a picture in space (world/plane-paint): where it starts, each sample in surface px, the lift. */
  onPaint: { start(clipId: string): void; move(sample: PenSample): void; jump(): void; end(): void; cancel(): void; miss(): void } | null = null;
  /** The eraser lifted over these strokes. */
  onErase: ((ids: string[]) => void) | null = null;
  /** A click with the fill tool. */
  onFill: ((x: number, y: number) => void) | null = null;

  /**
   * WHERE A STROKE LANDS (core `world/draw`): the page its placement names,
   * how a screen point meets it, and — a flat page only — the stroke layer
   * already standing on that page, which the stroke joins.
   */
  drawLanding(first: { x: number; y: number }, halfWidthPx = 0): DrawLanding {
    const { placement, surfaceOffset } = useToolDefaults.getState().world;
    const basis = this.screenBasis();
    const surface = placement === "surface";
    const hit = surface ? (this.pickRay(first.x, first.y)?.point ?? null) : null;
    // A selected drawing facing you is the page: new strokes land on it and join it.
    const chosen = placement === "view" ? this.selectedPage(basis.forward) : null;
    const page = chosen ?? pageFor(placement, basis, useWorldUi.getState().cursor, hit);
    const facing = pageForward(page);
    const onPage = (x: number, y: number) => this.hitPlane(x, y, page.anchor, facing);
    // On a surface the line stands OFF it along the surface's own normal, by
    // half its width (so its tube rests on the surface, not half inside it)
    // plus the offset you chose — Blender's Surface Offset.
    const lift = halfWidthPx * this.pixelSizeAt(page.anchor) + surfaceOffset;
    const land = surface
      ? (x: number, y: number) => {
          const h = this.pickRay(x, y);
          return h ? add(h.point, scale3(h.normal ?? scale3(basis.forward, -1), lift)) : onPage(x, y);
        }
      : onPage;
    return { page, unitsPerPx: this.pixelSizeAt(page.anchor), land, onPage, into: surface ? null : this.pageLayer(page) };
  }

  /**
   * The page worth SHOWING: a drawing being added to, or an axis plane. A
   * page facing the view needs no grid (it is the screen), nor does drawing
   * on surfaces (the surfaces are the page).
   */
  private shownPage(): DrawPage | null {
    const { placement } = useToolDefaults.getState().world;
    if (placement === "surface") return null;
    const basis = this.screenBasis();
    if (placement === "view") return this.selectedPage(basis.forward);
    return pageFor(placement, basis, useWorldUi.getState().cursor);
  }

  /**
   * The selected flat drawing's own plane: it stays the page as you orbit
   * (Blender's drawing plane is the object's), until it is seen nearly
   * edge-on (within ~10°), where a stroke could not be aimed on it.
   */
  private selectedPage(forward: V3): DrawPage | null {
    const id = useSession.getState().selectedClipIds.at(-1);
    const o = id ? this.ev?.objects.find((x) => x.id === id) : null;
    if (!o || o.kind !== "plane" || o.clip.kind !== "path" || o.clip.subpaths.some((c) => c.points.some((p) => p.z))) return null;
    const m = o.matrix;
    const right = normalize3(matAxis(m, 0)), up = normalize3(matAxis(m, 2));
    const facing = pageForward({ right, up });
    if (Math.abs(dot(facing, forward)) < 0.17) return null;
    // Seen from behind, keep its up and turn its right, as an axis page does.
    return { anchor: matPosition(m), right: dot(facing, forward) >= 0 ? right : scale3(right, -1), up };
  }

  /** The selected stroke layer, when it stands flat on exactly this page — a drawing on one page is one layer. */
  private pageLayer(page: DrawPage): DrawLanding["into"] {
    const id = useSession.getState().selectedClipIds.at(-1);
    const o = id ? this.ev?.objects.find((x) => x.id === id) : null;
    if (!o || o.kind !== "plane" || o.clip.kind !== "path") return null;
    if (o.clip.subpaths.some((c) => c.points.some((p) => p.z))) return null;
    const m = o.matrix;
    const normal = normalize3(matAxis(m, 1));
    if (Math.abs(dot(normal, pageForward(page))) < 0.9999) return null;
    if (Math.abs(dot(sub(page.anchor, matPosition(m)), normal)) > 0.5) return null;
    const inv = invert4(m);
    const basis = planeBasis(this.store.getState(), o.source);
    const scale = (length3(matAxis(m, 0)) + length3(matAxis(m, 2))) / 2;
    return { clipId: o.id, toLayer: (w) => localToPlane(basis, transformPoint(inv, w)), unitsPerWorld: 1 / Math.max(1e-6, scale) };
  }

  /** The pixel brush lands on the drawing layer under the pen — or on a mesh's surface, through the comp it wears. */
  private paintDown(e: PointerEvent, x: number, y: number): void {
    const id = this.pickObject(x, y);
    const o = id ? this.ev?.objects.find((ob) => ob.id === id) : null;
    const mesh = o?.clip.kind === "mesh" ? (o.clip as MeshClip) : null;
    const paintable = o && (o.clip.kind === "raster" || (mesh && !mesh.lattice && mesh.geometry.type !== "asset"));
    if (!paintable || !this.onPaint) {
      this.onPaint?.miss();
      this.release();
      return;
    }
    this.painting = id;
    this.paintedAt = null;
    this.onPaint.start(id!);
    this.paintSample(e, x, y);
  }

  /** One pen sample onto the surface being painted; across a texture seam the stroke starts a new run. */
  private paintSample(e: PointerEvent, x: number, y: number): void {
    if (!this.painting) return;
    const px = this.surfacePixel(this.painting, x, y);
    if (!px) return;
    if (px.span && this.paintedAt && Math.hypot(px.x - this.paintedAt.x, px.y - this.paintedAt.y) > px.span * 0.25) this.onPaint?.jump();
    this.paintedAt = { x: px.x, y: px.y };
    this.onPaint?.move({ ...this.penSample(e, x, y), x: px.x, y: px.y });
  }

  /** The eraser takes every drawn stroke whose INK it passes over (a stroke's empty card is not the stroke). */
  private eraseAt(x: number, y: number): void {
    if (!this.erasing) return;
    this.erasePath.push([x, y]);
    const r = this.eraserRadius();
    for (const [dx, dy] of [[0, 0], [r * 0.7, 0], [-r * 0.7, 0], [0, r * 0.7], [0, -r * 0.7]] as const) {
      const hit = this.pickRay(x + dx, y + dy, { reach: r * 0.4, kinds: ["path"], only: this.brushScope() });
      if (hit && !this.erasing.has(hit.id)) {
        this.erasing.add(hit.id);
        this.dirty = true;
      }
    }
    this.hudDirty = true;
  }

  /**
   * THE BRUSH SCOPE — one rule for every brush in a world (sculpt, eraser):
   * with something selected the brush touches only that; with nothing
   * selected, whatever is under it.
   */
  private brushScope(): ReadonlySet<string> | null {
    const ids = useSession.getState().selectedClipIds;
    return ids.length ? new Set(ids) : null;
  }

  private eraserRadius(): number {
    return Math.max(6, useDrawing.getState().eraser.size / 2);
  }

  /**
   * Where the pointer meets a picture's plane, in its SURFACE pixels — the ray
   * cast onto the plane (even past its edge, so a stroke can leave and come
   * back), into the object's space, through the one plane mapping.
   */
  surfacePixel(clipId: string, x: number, y: number): { x: number; y: number; span?: number } | null {
    const o = this.ev?.objects.find((ob) => ob.id === clipId);
    if (o?.clip.kind === "mesh") return this.texturePixel(clipId, x, y);
    if (!o || o.clip.kind !== "raster") return null;
    const m = o.matrix;
    const origin: V3 = [m[12]!, m[13]!, m[14]!];
    const normal = normalize3([-m[4]!, -m[5]!, -m[6]!]);
    const { o: ro, d } = this.ray(x, y);
    const den = dot(d, normal);
    if (Math.abs(den) < 1e-9) return null;
    const t = dot(sub(origin, ro), normal) / den;
    const hit = add(ro, scale3(d, t));
    const local = transformPoint(invert4(m), hit);
    const p = localToPlane(planeBasis(this.store.getState(), o.source), local);
    return { x: p.x + o.clip.width / 2, y: p.y + o.clip.height / 2 };
  }
  /**
   * Where the pointer meets a mesh, in the pixels of the comp it wears as its
   * texture: the ray's hit carries the surface's unwrap (u, v), which the comp
   * is wrapped by — v up, as a texture reads it, and repeated as the texture
   * repeats. `span` is the comp's size, for telling a seam from a stroke.
   */
  private texturePixel(clipId: string, x: number, y: number): { x: number; y: number; span: number } | null {
    const e = this.sync.entries.get(clipId);
    // The document's clip, not the evaluated one: starting a stroke may have just given it a texture.
    const clip = locateClip(this.store.getState(), clipId)?.clip;
    if (!e?.mesh || clip?.kind !== "mesh" || !clip.texture) return null;
    const comp = this.store.getState().frames.find((f) => f.id === clip.texture!.frameId);
    if (!comp) return null;
    this.raycaster.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const hit = this.raycaster.intersectObject(e.mesh, false)[0];
    if (!hit?.uv) return null;
    const r = clip.texture.repeat || 1;
    const wrap = (v: number) => (r === 1 ? v : v * r - Math.floor(v * r));
    return { x: wrap(hit.uv.x) * comp.width, y: (1 - wrap(hit.uv.y)) * comp.height, span: Math.max(comp.width, comp.height) };
  }

  private penSample(e: PointerEvent, x: number, y: number): PenSample {
    return { x, y, pressure: e.pressure, tiltX: e.tiltX ?? 0, tiltY: e.tiltY ?? 0, timeMs: e.timeStamp };
  }

  /** Arm a stroke tool, or go back to Select. */
  armStroke(tool: StrokeTool | null): void {
    useWorldUi.getState().set({ tool: tool ?? "select" });
    this.stroke = null;
    this.dirty = true;
  }

  private finishStroke(): void {
    const pts = this.stroke;
    const tool = this.strokeTool;
    this.stroke = null;
    this.dirty = true;
    if (!pts || pts.length < 2 || !tool) return;
    this.armStroke(null);
    const mesh = this.editMesh();
    const o = this.editObject();
    if (!mesh || !o) return;
    const [x0, y0] = pts[0]!;
    const [x1, y1] = pts[pts.length - 1]!;
    if (Math.hypot(x1 - x0, y1 - y0) < 4) return;
    const a = this.ray(x0, y0), b = this.ray(x1, y1);
    let n = cross(a.d, b.d);
    if (length3(n) < 1e-9) n = cross(sub(b.o, a.o), a.d);
    if (length3(n) < 1e-9) return;
    // The plane into the object's own space: a point through the inverse, the
    // normal through the transpose of the linear part.
    const M = o.matrix;
    const nl: V3 = [M[0]! * n[0] + M[1]! * n[1] + M[2]! * n[2], M[4]! * n[0] + M[5]! * n[1] + M[6]! * n[2], M[8]! * n[0] + M[9]! * n[1] + M[10]! * n[2]];
    const ql = transformPoint(invert4(M), a.o);
    const ui = useWorldUi.getState();
    const sel = selectedFaces(mesh, ui.elementSel);
    const res = bisect(mesh, ql, nl, sel.size ? sel : null);
    if (res.mesh.faces.length === mesh.faces.length) return;
    commitMesh(this.store, o.id, res.mesh, "Knife");
    ui.set({ elementSel: convertSelection(res.mesh, res.selection, ui.elementMode) });
  }

  // ── Sculpt ─────────────────────────────────────────────────────────────────
  //
  // The pen becomes dabs (core `world/sculpt`): each one a ray onto the LIVE
  // surface, so a ridge you are raising is drawn on as it rises; the brush
  // radius is screen px at that depth (as Blender's is); the stroke previews
  // through the mesh override and lands as ONE undo step on release.

  private sculpting: {
    clipId: string;
    session: SculptSession;
    inv: Mat4;
    scale: number;
    normalizer: PenSampleNormalizer;
    last: { x: number; y: number };
    carry: number;
    grab: { start: V3 } | null;
  } | null = null;

  /**
   * Drawings being sculpted — EVERY line under the brush, in the scope (the
   * selection, or anything when nothing is selected), each in its own space,
   * previewed together through the store's overlay and landing as one step.
   */
  private pathSculpt: {
    lines: LineSculpt[];
    /** Where Grab took hold, in the world: the points slide in the plane facing you through it. */
    grabFrom: V3 | null;
    normalizer: PenSampleNormalizer;
    last: { x: number; y: number };
    carry: number;
  } | null = null;

  /** A world-space move as a move of a line's points: its own (x, y, depth). */
  private layerDelta(k: LineSculpt, d: V3): { x: number; y: number; z: number } {
    const l = transformDir(k.inv, d);
    const a = localToPlane(k.basis, [0, 0, 0]), b = localToPlane(k.basis, l);
    return { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  }

  /** The brush's base settings now, with the modifiers held at this sample (⇧ smooths, ⌃/⌘ inverts). */
  private sculptStroke(e: PointerEvent, at: V3, pressure: number): SculptStroke {
    const s = useToolDefaults.getState().world.sculpt;
    const mods = gestureMods(e);
    const p = pressure;
    const radiusPx = s.radiusPx * (s.pressureRadius ? 0.25 + 0.75 * p : 1);
    const k = this.sculpting!;
    const view = s.frontOnly ? normalize3(transformDir(k.inv, this.screenBasis().forward)) : null;
    return {
      brush: mods.shift && s.brush !== "grab" ? "smooth" : s.brush,
      radius: (radiusPx * this.pixelSizeAt(at)) / k.scale,
      strength: s.strength * (s.pressureStrength ? p : 1),
      direction: (mods.meta ? -s.direction : s.direction) as 1 | -1,
      falloff: s.falloff,
      symmetry: s.symmetry,
      view,
    };
  }

  /** Where the pen meets the sculpted mesh (its live surface), world space. */
  private sculptHit(clipId: string, x: number, y: number): V3 | null {
    const mesh = this.sync.entries.get(clipId)?.mesh;
    if (!mesh) return null;
    this.raycaster.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const h = this.raycaster.intersectObject(mesh, false)[0];
    return h ? [h.point.x / UNIT, h.point.y / UNIT, h.point.z / UNIT] : null;
  }

  /** What the sculpt brush would take under this point: a mesh, or a drawing — within the scope. */
  private sculptTarget(x: number, y: number): { id: string; kind: "mesh" | "path" } | null {
    const brush = useToolDefaults.getState().world.sculpt.brush;
    const kinds = sculptsPaths(brush) ? ["mesh", "path"] : ["mesh"];
    const hit = this.pickRay(x, y, { kinds, only: this.brushScope(), reach: useToolDefaults.getState().world.sculpt.radiusPx * 0.5 });
    if (!hit) {
      // A thin line beside the pen, inside the brush's ring, is under the brush too.
      const near = this.linesUnder(x, y, "")[0];
      return near ? { id: near.clipId, kind: "path" } : null;
    }
    const clip = locateClip(this.store.getState(), hit.id)?.clip;
    if (clip?.kind === "mesh" && !clip.lattice && clip.geometry.type !== "asset") return { id: hit.id, kind: "mesh" };
    if (clip?.kind === "path") return { id: hit.id, kind: "path" };
    return null;
  }

  private sculptDown(e: PointerEvent, x: number, y: number): boolean {
    const target = this.sculptTarget(x, y);
    const o = target ? this.ev?.objects.find((ob) => ob.id === target.id) : null;
    const clip = o ? locateClip(this.store.getState(), o.id)?.clip : null;
    if (!target || !o || !clip) return false;
    const normalizer = new PenSampleNormalizer(useDrawing.getState().pressure, e.pointerType === "pen");
    if (target.kind === "path" && clip.kind === "path") {
      const lines = this.linesUnder(x, y, o.id);
      if (!lines.length) return false;
      this.pathSculpt = { lines, grabFrom: null, normalizer, last: { x, y }, carry: 0 };
      this.pathDab(e, x, y);
      return true;
    }
    if (clip.kind !== "mesh") return false;
    const mesh = meshDataOf(clip);
    const at = this.sculptHit(o.id, x, y);
    if (!mesh || !at) return false;
    const m = o.matrix;
    this.sculpting = {
      clipId: o.id,
      session: new SculptSession(mesh),
      inv: invert4(m),
      scale: Math.max(1e-6, (length3(matAxis(m, 0)) + length3(matAxis(m, 1)) + length3(matAxis(m, 2))) / 3),
      normalizer,
      last: { x, y },
      carry: 0,
      grab: null,
    };
    const k = this.sculpting;
    const pressure = k.normalizer.normalize(this.penSample(e, x, y)).pressure;
    const stroke = this.sculptStroke(e, at, pressure);
    if (stroke.brush === "grab") {
      k.session.beginGrab(transformPoint(k.inv, at), stroke);
      k.grab = { start: at };
    } else k.session.dab(transformPoint(k.inv, at), stroke);
    this.sculptPreview();
    return true;
  }

  private sculptMove(e: PointerEvent): void {
    if (this.pathSculpt) return this.pathMove(e);
    const k = this.sculpting;
    if (!k) return;
    const [x, y] = this.local(e);
    const pressure = k.normalizer.normalize(this.penSample(e, x, y)).pressure;
    if (k.grab) {
      const to = this.hitPlane(x, y, k.grab.start, this.screenBasis().forward);
      if (to) k.session.moveGrab(transformDir(k.inv, sub(to, k.grab.start)));
      this.sculptPreview();
      return;
    }
    const spacing = Math.max(2, useToolDefaults.getState().world.sculpt.radiusPx * SCULPT_SPACING);
    const run = dabsAlong(k.last, { x, y }, spacing, k.carry);
    k.carry = run.carry;
    k.last = { x, y };
    for (const p of run.points) {
      const at = this.sculptHit(k.clipId, p.x, p.y);
      if (at) k.session.dab(transformPoint(k.inv, at), this.sculptStroke(e, at, pressure));
    }
    if (run.points.length) this.sculptPreview();
  }

  // ── Sculpting a drawing ──

  /**
   * The lines a stroke starting here sculpts: the one under the pen, and every
   * other drawing in the scope with a point inside the brush — so Smooth or
   * Grab over a drawing made of many strokes reaches all of them, as one.
   * Each is read as it SHOWS (a morphing outline at the playhead).
   */
  private linesUnder(x: number, y: number, picked: string): LineSculpt[] {
    const r = useToolDefaults.getState().world.sculpt.radiusPx;
    return this.linePool()
      .filter((c) => c.line.clipId === picked || c.screen.some((sp) => Math.hypot(sp[0] - x, sp[1] - y) < r))
      .map((c) => ({ ...c.line, start: c.line.start, now: c.line.start, weights: null }));
  }

  /**
   * Every line a sculpt may reach (in the scope, visible, unlocked), with its
   * points on screen — measured once per stroke (the view does not move under
   * a brush) and once per hover frame otherwise.
   */
  private linePool(): Array<{ line: LineSculpt; screen: Array<[number, number]> }> {
    const key = `${idOf(this.store.getState())}|${idOf(this.view)}|${this.width}x${this.height}`;
    // Mid-stroke the document is the stroke's own preview: the pool it started with stands.
    if (this.pool && (this.pool.key === key || this.pathSculpt)) return this.pool.lines;
    const ev = this.ev;
    if (!ev) return [];
    const doc = this.store.getState();
    const ui = useWorldUi.getState();
    const scope = this.brushScope();
    const playhead = useSession.getState().playheadMs;
    const lines: Array<{ line: LineSculpt; screen: Array<[number, number]> }> = [];
    for (const o of ev.objects) {
      if (o.clip.kind !== "path" || ui.localHidden.includes(o.id) || o.clip.locked) continue;
      if (scope && !scope.has(o.id)) continue;
      const clip = o.clip as PathClip;
      const local = Math.max(0, playhead - clip.startMs);
      const basis = planeBasis(doc, o.source);
      const start = copySubpaths(pathOutlineAt(clip, local));
      const screen: Array<[number, number]> = [];
      for (const c of start) for (const p of c.points) {
        const sp = this.toScreen(transformPoint(o.matrix, planeToLocal(basis, p)));
        if (sp) screen.push(sp);
      }
      lines.push({ line: { clipId: o.id, matrix: o.matrix, inv: invert4(o.matrix), basis, local, start, now: start, weights: null }, screen });
    }
    this.pool = { key, lines };
    return lines;
  }
  private pool: { key: string; lines: Array<{ line: LineSculpt; screen: Array<[number, number]> }> } | null = null;


  /** A screen point on a line's own plane, in its layer coordinates. */
  private pathLocal(k: LineSculpt, x: number, y: number): { x: number; y: number } | null {
    const w = this.hitPlane(x, y, matPosition(k.matrix), normalize3(matAxis(k.matrix, 1)));
    if (!w) return null;
    const p = localToPlane(k.basis, transformPoint(k.inv, w));
    return { x: p.x, y: p.y };
  }

  /** The brush's weight on each point of a line, by where it sits on SCREEN. */
  private pathWeights(k: LineSculpt, cx: number, cy: number, pressure: number): number[][] {
    const s = useToolDefaults.getState().world.sculpt;
    const r = s.radiusPx * (s.pressureRadius ? 0.25 + 0.75 * pressure : 1);
    const strength = s.strength * (s.pressureStrength ? pressure : 1);
    return k.now.map((c) =>
      c.points.map((p) => {
        const at = this.toScreen(transformPoint(k.matrix, planeToLocal(k.basis, p)));
        if (!at) return 0;
        const d = Math.hypot(at[0] - cx, at[1] - cy);
        return d >= r ? 0 : falloff(s.falloff, 1 - d / r) * strength;
      }),
    );
  }

  private pathDab(e: PointerEvent, x: number, y: number): void {
    const ps = this.pathSculpt!;
    const s = useToolDefaults.getState().world.sculpt;
    const pressure = ps.normalizer.normalize(this.penSample(e, x, y)).pressure;
    const brush = gestureMods(e).shift ? "smooth" : s.brush;
    const dir = (gestureMods(e).meta ? -s.direction : s.direction) as 1 | -1;
    const forward = this.screenBasis().forward;
    if (brush === "grab") {
      // In 3D: the points slide in the plane facing you through where the
      // brush took hold — a 3D stroke is grabbed as you see it, depth and all.
      const only = new Set(ps.lines.map((l) => l.clipId));
      ps.grabFrom ??= this.hitPlane(x, y, this.pickRay(x, y, { only })?.point ?? matPosition(ps.lines[0]!.matrix), forward);
      const to = ps.grabFrom ? this.hitPlane(x, y, ps.grabFrom, forward) : null;
      for (const k of ps.lines) {
        k.weights ??= this.pathWeights(k, x, y, pressure);
        if (ps.grabFrom && to) k.now = grabContours(k.start, k.weights, this.layerDelta(k, sub(to, ps.grabFrom)));
      }
    } else {
      for (const k of ps.lines) {
        const c = this.pathLocal(k, x, y);
        if (!c) continue;
        const w = this.pathWeights(k, x, y, pressure);
        if (!w.some((row) => row.some((v) => v > 0))) continue;
        // Draw and Clay lift toward the eye; the reach is the brush's, in the line's units.
        const at = transformPoint(k.matrix, planeToLocal(k.basis, c));
        const toward = this.layerDelta(k, scale3(forward, -1));
        const tl = Math.hypot(toward.x, toward.y, toward.z) || 1;
        const scale = Math.max(1e-6, (length3(matAxis(k.matrix, 0)) + length3(matAxis(k.matrix, 2))) / 2);
        k.now = sculptContours(k.now, brush, c, (ci, i) => w[ci]?.[i] ?? 0, dir, {
          radius: (s.radiusPx * this.pixelSizeAt(at)) / scale,
          toward: { x: toward.x / tl, y: toward.y / tl, z: toward.z / tl },
        });
      }
    }
    const lines = ps.lines.filter((k) => k.now !== k.start);
    const recording = useSession.getState().recording;
    this.store.setOverlay((d) => this.writeLines(d, lines, recording));
    this.dirty = true;
  }

  /** The lines a sculpt changed, written through THE outline write (a key where the outline morphs). */
  private writeLines(d: MotionDocument, lines: LineSculpt[], record: boolean): void {
    for (const k of lines) {
      const c = locateClip(d, k.clipId)?.clip;
      if (c?.kind === "path") writePathOutline(c, k.now, k.local, { record });
    }
  }

  private pathMove(e: PointerEvent): void {
    const k = this.pathSculpt!;
    const [x, y] = this.local(e);
    if (useToolDefaults.getState().world.sculpt.brush === "grab" && !gestureMods(e).shift) return this.pathDab(e, x, y);
    const spacing = Math.max(2, useToolDefaults.getState().world.sculpt.radiusPx * SCULPT_SPACING);
    const run = dabsAlong(k.last, { x, y }, spacing, k.carry);
    k.carry = run.carry;
    k.last = { x, y };
    for (const p of run.points) {
      // A line the stroke reaches on its way is sculpted from there on, as a mesh's surface is.
      const have = new Set(k.lines.map((l) => l.clipId));
      for (const l of this.linesUnder(p.x, p.y, "")) if (!have.has(l.clipId)) k.lines.push(l);
      this.pathDab(e, p.x, p.y);
    }
  }

  private sculptPreview(): void {
    const k = this.sculpting;
    if (!k) return;
    this.meshOverride.set(k.clipId, k.session.mesh());
    this.dirty = true;
  }

  private sculptEnd(keep: boolean): void {
    const ps = this.pathSculpt;
    if (ps) {
      this.pathSculpt = null;
      this.store.setOverlay(null);
      const lines = ps.lines.filter((k) => k.now !== k.start);
      if (keep && lines.length) {
        const record = useSession.getState().recording;
        this.store.update(lines.length > 1 ? "Sculpt drawings" : "Sculpt drawing", (d) => this.writeLines(d, lines, record));
      }
      this.dirty = true;
      return;
    }
    const k = this.sculpting;
    this.sculpting = null;
    if (!k) return;
    k.session.endGrab();
    if (keep) commitMesh(this.store, k.clipId, k.session.mesh(), "Sculpt");
    this.meshOverride.delete(k.clipId);
    this.dirty = true;
  }

  armLoopCut(on: boolean): void {
    this.loopCutArmed = on;
    this.hoverEdge = null;
    this.loopCutHover = null;
    useWorldUi.getState().set({ hud: on ? "Loop cut: click an edge · Esc to cancel" : null });
    if (on) this.updateLoopCutHover(this.lastMouse[0], this.lastMouse[1]);
    this.dirty = true;
  }

  private updateLoopCutHover(x: number, y: number): void {
    const ui = useWorldUi.getState();
    const prev = ui.elementMode;
    useWorldUi.setState({ elementMode: "edge" });
    const el = this.pickElement(x, y);
    useWorldUi.setState({ elementMode: prev });
    this.hoverEdge = el?.edge ?? null;
    this.loopCutHover = null;
    const mesh = this.editMesh();
    const o = this.editObject();
    if (this.hoverEdge && mesh && o) {
      {
        const ring = edgeRing(mesh, this.hoverEdge!);
        const segs: Array<[number, number, number, number]> = [];
        // Draw the cut: midpoints of consecutive ring edges.
        const mids = ring.map((k) => {
          const [a, b] = k.split("_").map(Number) as [number, number];
          const pa = transformPoint(o.matrix, [mesh.positions[a * 3]!, mesh.positions[a * 3 + 1]!, mesh.positions[a * 3 + 2]!]);
          const pb = transformPoint(o.matrix, [mesh.positions[b * 3]!, mesh.positions[b * 3 + 1]!, mesh.positions[b * 3 + 2]!]);
          return this.toScreen(scale3(add(pa, pb), 0.5));
        });
        for (let i = 0; i + 1 < mids.length; i++) {
          const a = mids[i], b = mids[i + 1];
          if (a && b) segs.push([a[0], a[1], b[0], b[1]]);
        }
        if (ring.length > 2 && mids[0] && mids[mids.length - 1]) segs.push([mids[mids.length - 1]![0], mids[mids.length - 1]![1], mids[0]![0], mids[0]![1]]);
        this.loopCutHover = segs;
        this.dirty = true;
      }
    }
    this.dirty = true;
  }

  private applyLoopCut(): void {
    const mesh = this.editMesh();
    const o = this.editObject();
    const edge = this.hoverEdge;
    this.armLoopCut(false);
    if (!mesh || !o || !edge) return;
    const res = loopCut(mesh, edge, 0.5);
    commitMesh(this.store, o.id, res.mesh, "Loop cut");
    useWorldUi.getState().set({ elementSel: convertSelection(res.mesh, res.selection, useWorldUi.getState().elementMode) });
  }

  selectLinkedUnder(x: number, y: number): void {
    const ui = useWorldUi.getState();
    const mesh = this.editMesh();
    if (!mesh) return;
    const prev = ui.elementMode;
    useWorldUi.setState({ elementMode: "vertex" });
    const el = this.pickElement(x, y);
    useWorldUi.setState({ elementMode: prev });
    if (el?.vert === undefined) return;
    const linked = linkedVerts(mesh, [el.vert]);
    const merged = new Set([...selectedVerts(mesh, ui.elementSel), ...linked]);
    ui.set({ elementSel: convertSelection(mesh, { mode: "vertex", verts: [...merged], edges: [], faces: [] }, prev) });
  }

  requestDraw(): void {
    this.dirty = true;
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** Screen distance from (x, y) to the segment a–b. */
function segmentDistance(x: number, y: number, a: readonly number[], b: readonly number[]): number {
  const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - a[0]!) * dx + (y - a[1]!) * dy) / len)) : 0;
  return Math.hypot(x - (a[0]! + dx * t), y - (a[1]! + dy * t));
}

let serial = 0;
const ids = new WeakMap<object, number>();
function idOf(o: object): number {
  let n = ids.get(o);
  if (n === undefined) ids.set(o, (n = ++serial));
  return n;
}

function solidOf(frame: { background: string; fills: Array<{ type: string; color?: string }> }): string | null {
  const top = frame.fills.find((f) => f.type === "solid") as { color?: string } | undefined;
  const c = top?.color ?? frame.background;
  if (!c || c.length === 9 && c.endsWith("00")) return null;
  return c.startsWith("var:") ? null : c;
}

/** The helper id of the default camera's ghost — never a clip id (clip ids carry no "§"). */
const GHOST_CAMERA = "§default-camera";

/** Does this world own a camera layer at all (live now or not)? */
function worldHasCamera(doc: MotionDocument, frameId: string): boolean {
  return doc.tracks.some((t) => t.clips.some((c) => c.kind === "camera" && c.frameId === frameId));
}

/** Where a camera's line of sight passes nearest the world's centre (or 500 ahead, if the centre is behind it). */
function sightPoint(m: Mat4): V3 {
  const at = matPosition(m);
  const fwd = normalize3([-m[8]!, -m[9]!, -m[10]!]);
  const t = -dot(at, fwd);
  return add(at, scale3(fwd, t > 1 ? t : 500));
}

function stripScale(m: Mat4): Mat4 {
  const x = normalize3([m[0]!, m[1]!, m[2]!]), y = normalize3([m[4]!, m[5]!, m[6]!]), z = normalize3([m[8]!, m[9]!, m[10]!]);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, m[12]!, m[13]!, m[14]!, 1];
}

function unitAxis(a: 0 | 1 | 2): V3 {
  return a === 0 ? [1, 0, 0] : a === 1 ? [0, 1, 0] : [0, 0, 1];
}

function planeAxes(n: V3): V3[] {
  const a: V3 = Math.abs(n[2]) < 0.9 ? normalize3(cross(n, [0, 0, 1])) : normalize3(cross(n, [1, 0, 0]));
  return [a, normalize3(cross(n, a))];
}

function axisAngle4(axis: V3, deg: number): Mat4 {
  const a = (deg * Math.PI) / 180;
  const [x, y, z] = normalize3(axis);
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

function constrainedScale(f: number, c: Constraint | null): Mat4 {
  if (!c) return [f, 0, 0, 0, 0, f, 0, 0, 0, 0, f, 0, 0, 0, 0, 1];
  // S = I + (f − 1)·d·dᵀ along an axis; I·f − (f − 1)·d·dᵀ for the plane.
  const d = c.dir;
  const out: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const ddT = d[i]! * d[j]!;
      const id = i === j ? 1 : 0;
      out[j * 4 + i] = c.plane ? id * f - (f - 1) * ddT : id + (f - 1) * ddT;
    }
  }
  return out;
}

function snapTo(v: number, step: number): number {
  return Math.round(v / step) * step;
}

function unwrap(prev: number, next: number): number {
  let n = next;
  while (n - prev > 180) n -= 360;
  while (n - prev < -180) n += 360;
  return n;
}

function fmt(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function toggle(sel: MeshSelection, field: "verts" | "edges" | "faces", value: number | string, extend: boolean): MeshSelection {
  const list = sel[field] as Array<number | string>;
  if (!extend) return { ...sel, verts: [], edges: [], faces: [], [field]: [value] };
  const has = list.includes(value);
  const last = list[list.length - 1] === value;
  // Blender: shift-click the active element deselects it; any other becomes active.
  const next = has && last ? list.filter((x) => x !== value) : [...list.filter((x) => x !== value), value];
  return { ...sel, [field]: next } as MeshSelection;
}

function labelOf(m: Modal): string {
  if (m.label !== m.kind) return m.label;
  return m.kind === "grab" ? "Move" : m.kind === "rotate" ? "Rotate" : m.kind === "scale" ? "Scale" : "Inset";
}

export type { Constraint };
export { isSpatialClip };

function disposeTree(o: THREE.Object3D): void {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((q) => q.dispose());
    else mat?.dispose();
  });
}

const closedMeshes = new WeakMap<MeshData, boolean>();
/** Every edge between exactly two faces — a solid the hull outline can rim (cached per mesh). */
function isClosedMesh(mesh: MeshData): boolean {
  let v = closedMeshes.get(mesh);
  if (v === undefined) {
    v = mesh.faces.length > 0 && meshEdges(mesh).list.every((e) => e.faces.length === 2);
    closedMeshes.set(mesh, v);
  }
  return v;
}
