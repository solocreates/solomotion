"use client";

import { capturePointer } from "../input/capture-pointer";
import { onStageZoomRequest } from "../input/page-zoom-guard";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { SquareDashed } from "lucide-react";
import {
  EMPTY_SELECTION,
  validSelection,
  selectionMedian,
  mirrorSelection,
  assignPart,
  buildPrimitive,
  convertSelection,
  deleteElements,
  dissolveEdges,
  duplicateFaces,
  fillFace,
  bridgeLoops,
  spinSelection,
  flipFaces,
  growSelection,
  invertSelection,
  locateClip,
  meshBounds,
  type DocumentStore,
  moveClipsToScope,
  replaceClipInPlace,
  markEdges,
  mergeVerts,
  recalcNormalsOutside,
  resolveStageBackground,
  convertShapeClipToPath,
  convertBodyToMesh,
  addLattice,
  texturePaintLayer,
  isBodyKind,
  applyModifier,
  copySubpaths,
  pathOutlineAt,
  writePathOutline,
  nodeSelection,
  NODE_VERBS,
  mergeNodes,
  type NodeSelection,
  type NodeVerbId,
  writeChannel,
  selectAll,
  selectLinked,
  selectedFaces,
  separateFaces,
  subdivideFaces,
  weldMesh,
  selectedVerts,
  type ElementMode,
  deleteLayers,
  type LightType,
  type MeshClip,
  type ShadingMode,
  type V3,
  placeClip,
  invert4 as invert,
  matPosition,
  catmullClark,
  setMeshData,
  localToPlane,
  planeBasis,
  pourFill,
  regionAtPoint,
  solidPaint,
  transformPoint,
  type SculptBrush,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { commitTextContent } from "../state/text-content";
import { isTypingTarget } from "../input/typing-target";
import { formatCombo, useCombo, worldCommandsFor, worldComboFromEvent, type WorldCommandId } from "../state/shortcut-registry";
import { convertTextClipToPath } from "../export/text-outline";
import { StageChrome } from "../stage/StageChrome";
import { isLight } from "../theme/theme-tokens";
import { useTheme } from "../theme/use-theme";
import { loadWorldEngine } from "./loader";
import type { ExportFormat } from "./engine";
import { downloadBlob } from "../io/file-handle-store";
import { exitWorldViewport, markViewportMounted, measuredBounds, useWorldUi, type WorldMode, type WorldTool } from "./state";
import { WORLD_TOOLS, strokeToolOf, toolInMode, worldActFor } from "./tools";
import { useMultiTouch } from "../input/use-multi-touch";
import { useTouchIntent } from "../input/use-touch-intent";
import { multiFingerDown, subscribePointerEnd, trackedPointer } from "../input/pointer-gestures";
import { usePointerAuthority } from "../input/pointer-authority";
import { useToolDefaults } from "../state/tool-defaults";
import { useDrawing } from "../drawing/drawing-store";
import {
  addCamera,
  addController,
  addLight,
  addPrimitive,
  addText,
  applyTransform,
  clearTransform,
  commitMesh,
  deleteObjects,
  joinObjects,
  makeEditable,
  meshDataOf,
  separateInto,
  setOrigin,
  commitPlacements,
  parentMatrixOf,
  setActiveCamera,
  spanFor,
} from "./commands";
import { GpuUnavailableError, WorldViewport, type ViewportInfo } from "./viewport/viewport";
import { axisView, viewBasis, zoom as zoomView, type ViewState } from "./viewport/view";
import { importModelsIntoWorld, isModelFile, BLEND_FILE, explainBlendFile } from "./import";
import { importFileAsAsset, buildAssetClip, buildSvgVectorClips, isSvgFile } from "../assets/import";
import { AddItems, NAV_SIZE, worldChromeItems } from "./WorldChrome";
import { NavGizmo } from "./nav-gizmo";
import { commitDrawnStroke } from "./draw-stroke";
import { PlanePaint } from "./plane-paint";
import { repaint } from "./paint-gen";
import { PaintEngineProvider, PaintToolProvider } from "../drawing/paint-dials";
import { editElementsOf, isPathTarget, vertsOfNodes } from "./edit-targets";
import { ShadingIcon } from "./viewport-icons";
import { NAMES } from "@/editor/names";

/**
 * THE 3D WORKSPACE — the centre stage when you are inside a world.
 *
 * Blender's grammar with the app's surfaces: the inspector on the right is the
 * app's own (select a camera, see the camera), the timeline below is the
 * world's timeline, the layers panel is the outliner, and the chrome over the
 * viewport is the flat stage's own kit (`WorldChrome`). This file is the
 * viewport's BEHAVIOUR: mounting the engine, the keymap, every verb by name,
 * pointer plumbing, drops, the menus Blender users reach for by key, and
 * typing into a text that stands in the world.
 */

type MenuKind = "add" | "context" | "delete" | "merge" | "mirror" | "view" | "shading" | "snap" | "apply" | null;

/**
 * An SVG image in a world, opened into its vector paths in one step. The 2D
 * conversion lays the pieces out in x and y; in a world the picture's
 * vertical is z (y is depth), so each piece's offset is carried across.
 */
async function svgToWorldPaths(store: DocumentStore, clipId: string): Promise<void> {
  const built = await buildSvgVectorClips(store, clipId);
  if (!built) return;
  const { result, clip: image } = built;
  const t = image.transform;
  for (const c of result.clips) {
    if (c.kind !== "path") continue;
    const dy = c.transform.y - t.y;
    c.transform.y = t.y;
    c.transform.z = (t.z ?? 0) - dy;
  }
  store.update("Convert to vectors", (d) => {
    replaceClipInPlace(d, clipId, result.clips);
    if (result.group) moveClipsToScope(d, result.members, result.group.id);
  });
  useSession.getState().select(result.clips.filter((c) => c.kind === "path").map((c) => c.id));
}

export default function WorldStage({ frameId }: { frameId: string }) {
  const store = useDocStore();
  const doc = useDoc();
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const hudRef = React.useRef<HTMLCanvasElement>(null);
  const navRef = React.useRef<HTMLCanvasElement>(null);
  const hostRef = React.useRef<HTMLDivElement>(null);
  const vpRef = React.useRef<WorldViewport | null>(null);
  const [info, setInfo] = React.useState<ViewportInfo | null>(null);
  /** The browser would not give 3D a GPU context: say so here instead of throwing. */
  const [gpuOff, setGpuOff] = React.useState(false);
  const [menu, setMenu] = React.useState<{ kind: MenuKind; x: number; y: number }>({ kind: null, x: 0, y: 0 });
  const [typing, setTyping] = React.useState<{ id: string; x: number; y: number; selectAll: boolean } | null>(null);
  const nested = useSession((s) => s.nav.path.hops.length > 0);

  // THE THEME the void, grid and wires are painted in: the stage colour the
  // flat canvas floats on (a document's own, when it chose one), and the
  // theme's ink. Pushed to the viewport when either changes — never per frame.
  const colors = useTheme((s) => s.colors);
  const stage = resolveStageBackground(doc) ?? colors.stage;
  const theme = React.useMemo(() => ({ stage, foreground: colors.foreground, light: isLight(colors.background) }), [stage, colors.foreground, colors.background]);
  const themeRef = React.useRef(theme);
  themeRef.current = theme;
  const ink = React.useMemo(() => {
    const h = theme.foreground.replace("#", "");
    const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},ALPHA)`;
  }, [theme.foreground]);
  const inkRef = React.useRef(ink);
  inkRef.current = ink;
  React.useEffect(() => {
    vpRef.current?.setTheme(theme);
    vpRef.current?.requestDraw();
  }, [theme]);

  const nav = React.useMemo(() => new NavGizmo(NAV_SIZE, () => vpRef.current, () => navRef.current), []);

  /** Start typing into a text standing in the world, at the pointer (or the middle of the view). */
  const editText = React.useCallback((id: string, selectAll = false) => {
    const vp = vpRef.current;
    const [x, y] = vp?.mouse ?? [0, 0];
    useSession.getState().select([id]);
    setTyping({ id, x, y, selectAll });
  }, []);

  // The wheel NATIVELY and not passive: React's onWheel is passive, so the
  // viewport's preventDefault was ignored and a pinch zoomed the whole page
  // along with the view.
  React.useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const on = (e: WheelEvent) => vpRef.current?.wheel(e);
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, []);
  // ⌘+ / ⌘− zoom the view, ⌘0 / ⇧0 frame everything (a 3D view has no 100%).
  React.useEffect(
    () =>
      onStageZoomRequest((kind) => {
        const vp = vpRef.current;
        if (!vp) return;
        if (kind === "fit" || kind === "actual") vp.frameAll();
        else vp.setView(zoomView(vp.view, kind === "in" ? 1 / 1.2 : 1.2));
      }),
    [],
  );

  // Mount the viewport once the engine chunk is here.
  React.useEffect(() => {
    let vp: WorldViewport | null = null;
    let disposed = false;
    markViewportMounted(true);
    void loadWorldEngine().then((engine) => {
      if (disposed || !canvasRef.current || !hudRef.current) return;
      try {
        vp = new WorldViewport(canvasRef.current, hudRef.current, engine, store, frameId);
      } catch (e) {
        if (e instanceof GpuUnavailableError) return setGpuOff(true);
        throw e;
      }
      vpRef.current = vp;
      vp.setTheme(themeRef.current);
      // Dev only: the live viewport, for driving scripts (see `__<ns>`).
      if (process.env.NODE_ENV !== "production") (window as unknown as Record<string, unknown>)[NAMES.wire.debug("Viewport")] = vp;
      let last = "";
      vp.onInfo = (i) => {
        const k = JSON.stringify(i);
        if (k !== last) {
          last = k;
          setInfo(i);
        }
      };
      const r = hostRef.current!.getBoundingClientRect();
      vp.resize(r.width, r.height);
      vp.onNav = (v: ViewState) => nav.draw(v, inkRef.current);
      vp.onDraw = (gesture, at) => {
        const id = commitDrawnStroke(store, frameId, gesture, at, spanFor(store.getState(), frameId));
        // The stroke's layer is the selection, so the next stroke on this page
        // joins it — a drawing is one layer, as it is on the flat canvas.
        if (id && useSession.getState().selectedClipIds.at(-1) !== id) useSession.getState().select([id]);
      };
      vp.onErase = (ids) => {
        store.update(ids.length > 1 ? "Erase strokes" : "Erase stroke", (d) => deleteLayers(d, ids, { pruneEmptiedTracks: true }));
        const sel = useSession.getState().selectedClipIds;
        if (sel.some((s) => ids.includes(s))) useSession.getState().select(sel.filter((s) => !ids.includes(s)));
      };
      vp.onFill = (x, y) => actRef.current?.fillAt(x, y);
      vp.onPlace = (tool, at, hitId) => actRef.current?.place(tool, at, hitId);
      // The pixel brush on a picture in space: the viewport finds the surface pixels, PlanePaint lays the paint.
      let paint: PlanePaint | null = null;
      vp.onPaint = {
        start: (clipId) => {
          const clip = locateClip(store.getState(), clipId)?.clip;
          if (clip?.kind === "raster") {
            useSession.getState().select([clipId]);
            paint = new PlanePaint(store, clip, () => vp?.requestDraw());
            return;
          }
          if (clip?.kind !== "mesh") return;
          // A mesh paints into the comp it wears — given one (and a drawing layer) on the first stroke.
          let made: { rasterId: string; frameId: string } | null = null;
          store.update("Paint on the surface", (d) => void (made = texturePaintLayer(d, clipId)));
          const target = made as { rasterId: string; frameId: string } | null;
          const layer = target ? locateClip(store.getState(), target.rasterId)?.clip : null;
          if (!target || layer?.kind !== "raster") return;
          useSession.getState().select([clipId]);
          paint = new PlanePaint(store, layer, () => {
            repaint(target.frameId);
            vp?.requestDraw();
          });
        },
        move: (sample) => paint?.feed(sample),
        jump: () => paint?.jump(),
        end: () => {
          paint?.end();
          paint = null;
        },
        cancel: () => {
          paint?.cancel();
          paint = null;
        },
        miss: () =>
          toast("The brush paints on meshes and drawing layers", { description: "Aim at an object's surface, or at a drawing layer standing in the world." }),
      };
    });
    const ro = new ResizeObserver(() => {
      const host = hostRef.current;
      if (host && vpRef.current) {
        const r = host.getBoundingClientRect();
        vpRef.current.resize(r.width, r.height);
      }
    });
    if (hostRef.current) ro.observe(hostRef.current);
    return () => {
      disposed = true;
      ro.disconnect();
      markViewportMounted(false);
      vp?.dispose();
      vpRef.current = null;
    };
  }, [store, frameId, nav]);

  // Edit and Sculpt follow the document: leave when their object goes (undo,
  // delete), and drop selected elements its polygons no longer have (an undo
  // of an extrude, an agent's edit) so nothing points past the mesh.
  React.useEffect(() => {
    return store.subscribe(() => {
      const u = useWorldUi.getState();
      if ((u.mode !== "edit" && u.mode !== "sculpt") || !u.editClipId) return;
      const clip = locateClip(store.getState(), u.editClipId)?.clip;
      if (!clip) {
        u.set({ mode: "object", editClipId: null, elementSel: EMPTY_SELECTION, tool: "select" });
        return;
      }
      if (u.mode !== "edit" || vpRef.current?.modalActive) return;
      if (clip.kind === "path") {
        // An undo or an agent's edit can take points out from under the
        // selection. Checked once the write settles: a commit clears its
        // preview overlay first, which notifies with the outline as it was
        // BEFORE the edit — an extrude's new point would read as gone.
        queueMicrotask(() => {
          const now = useWorldUi.getState();
          if (now.mode !== "edit" || now.editClipId !== u.editClipId || vpRef.current?.modalActive) return;
          const n = (vpRef.current?.editCage()?.positions.length ?? 0) / 3;
          if (now.elementSel.verts.some((v) => v >= n)) now.set({ elementSel: { ...EMPTY_SELECTION, mode: "vertex" } });
        });
        return;
      }
      if (clip.kind !== "mesh") return;
      const mesh = meshDataOf(clip);
      if (!mesh) return;
      const sel = validSelection(mesh, u.elementSel);
      if (sel !== u.elementSel) u.set({ elementSel: sel });
    });
  }, [store]);

  const openMenu = React.useCallback((kind: MenuKind) => {
    const [x, y] = vpRef.current?.mouse ?? [200, 200];
    setMenu({ kind, x, y });
  }, []);

  const act = React.useMemo(() => makeActions(store, frameId, vpRef, openMenu, nav, editText), [store, frameId, openMenu, nav, editText]);
  const pointerInside = React.useRef(false);
  const actRef = React.useRef(act);
  actRef.current = act;

  // ── The keymap (Blender's), captured while the viewport is up ──────────────
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const vp = vpRef.current;
      if (!vp || isTypingTarget(e.target)) return;
      // Keys go to the editor UNDER THE MOUSE (Blender's rule): over the
      // timeline or a panel the app's shortcuts stand. A running operator owns
      // the keyboard wherever the pointer has wandered.
      const here = pointerInside.current || !!hostRef.current?.contains(document.activeElement);
      if (!here && !vp.modalActive) return;
      if (menu.kind) return; // the open menu owns the keyboard
      const handled = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      const code = e.code;
      const mod = e.ctrlKey || e.metaKey;
      if (vp.modalActive) {
        // The operator owns the keyboard until it ends (Blender's rule): undo
        // mid-drag cancels the drag, and nothing else — a Delete, a tool key —
        // reaches the app while a preview is half-applied.
        if (mod && code === "KeyZ") vp.cancelModal();
        else if (code === "Escape") vp.cancelModal();
        else if (code === "Enter" || code === "NumpadEnter") vp.confirmModal();
        else if (code === "KeyX" || code === "KeyY" || code === "KeyZ") vp.axisKey(code === "KeyX" ? 0 : code === "KeyY" ? 1 : 2, e.shiftKey);
        else if (/^(Digit|Numpad)[0-9]$/.test(code)) vp.typeKey(code.slice(-1));
        else if (code === "Period" || code === "NumpadDecimal") vp.typeKey(".");
        else if (code === "Minus" || code === "NumpadSubtract") vp.typeKey("-");
        else if (code === "Backspace") vp.typeKey("Backspace");
        else if (code === "PageUp" || code === "PageDown") vp.resizeProportional(code === "PageUp" ? 1.1 : 1 / 1.1);
        else if (/^(Shift|Control|Alt|Meta)/.test(code)) {
          // Ctrl snaps, Shift is precision, ⌥ breaks a handle from its partner — read now, not on the next move.
          requestAnimationFrame(() => vp.refreshModal());
          return;
        }
        handled();
        return;
      }
      if (vp.loopCutArmed && code === "Escape") {
        vp.armLoopCut(false);
        return handled();
      }
      // A bone being drawn or dragged: Esc drops it.
      if (vp.bonesActive && code === "Escape") {
        vp.cancelBones();
        return handled();
      }
      // E in Setup / the Bone tool: extrude a child bone from the active one's tip.
      if (code === "KeyE" && !mod && !e.shiftKey && !e.altKey && vp.extrudeBone()) return handled();
      // The registry says which 3D command this combo is, in this mode
      // (`world-shortcuts.ts`); the first one that acts takes the key. A combo
      // no 3D command claims — ⌘Z, ⌘S, Space — is the app's.
      const combo = worldComboFromEvent(e);
      if (!combo) return;
      for (const def of worldCommandsFor(combo, useWorldUi.getState().mode)) {
        if (act.handlers[def.id as WorldCommandId](e) !== false) return handled();
      }
    };
    // Letting go of a modifier mid-operator is a change too.
    const onKeyUp = (e: KeyboardEvent) => {
      if (vpRef.current?.modalActive && /^(Shift|Control|Alt|Meta)/.test(e.code)) requestAnimationFrame(() => vpRef.current?.refreshModal());
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [act, menu.kind]);

  // ── Pointer plumbing ───────────────────────────────────────────────────────
  //
  // THE VIEWPORT IS A TOOL DOOR, and it asks what every door asks
  // (docs/responsive-and-gestures.md). One finger: `useTouchIntent` decides
  // whether the press drives the armed tool or navigates — by the 3D finger
  // setting (navigate by default: drag orbits, a tap is the tool's click,
  // holding still is the menu), by the pen-only rule for a brush, and always
  // to a handle under it. Two fingers: `useMultiTouch` pans and pinches. A
  // pen owns the surface while it is down. And a pointer that will never
  // come back up ends its gesture as an ABORT (`pointerEnded`).

  const multi = useMultiTouch(hostRef, {
    onStart: () => vpRef.current?.abortGesture(),
    onGesture: (g) => vpRef.current?.touchNavigate(g),
  });

  React.useEffect(
    () =>
      subscribePointerEnd((id, reason) => {
        if (reason !== "up") vpRef.current?.pointerEnded(id);
      }),
    [],
  );

  const handleUnder = (e: React.PointerEvent) => {
    const r = canvasRef.current?.getBoundingClientRect();
    return !!r && !!vpRef.current?.handleAt(e.clientX - r.left, e.clientY - r.top);
  };

  const door = useTouchIntent({
    act: (e) => (handleUnder(e) ? "transform" : worldActFor(useWorldUi.getState().tool)),
    finger: (e) => (strokeToolOf(useWorldUi.getState().tool) || handleUnder(e) ? "tool" : usePointerAuthority.getState().fingerWorld),
    onTool: (e) => {
      const vp = vpRef.current;
      if (!vp) return;
      // A press resolved after the finger LIFTED is a tap: the tool's click, no drag behind it.
      if (e.pointerType === "touch" && !trackedPointer(e.pointerId)) vp.tap(e.nativeEvent);
      else vp.pointerDown(e.nativeEvent);
    },
    onPan: (dx, dy) => vpRef.current?.orbitBy(dx, dy),
  });

  const onPointerDown = (e: React.PointerEvent) => {
    const vp = vpRef.current;
    if (!vp) return;
    if (e.pointerType === "touch") {
      // A hand resting on the glass while the pen draws is a palm, not a gesture.
      if (vp.ownerType === "pen" || multi.penActive()) return;
      // A second finger is the two-finger gesture's — never a second press.
      if (multiFingerDown()) return;
    }
    capturePointer(e.target as Element, e.pointerId);
    // ⌥ in edit mode: pull handles out of a path's node, select a whole line,
    // a mesh's edge loop — or, on a handle, the ordinary drag that breaks it.
    if (e.button === 0 && e.altKey && useWorldUi.getState().mode === "edit" && vp.altPress(e.nativeEvent)) return;
    door(e);
  };

  /**
   * Double-click goes INTO what you clicked, as on the flat canvas: a mesh into
   * its points, a text into its words, a frame standing in the world into
   * that frame.
   */
  const onDoubleClick = (e: React.MouseEvent) => {
    const vp = vpRef.current;
    if (!vp) return;
    const r = canvasRef.current!.getBoundingClientRect();
    const id = vp.pickObject(e.clientX - r.left, e.clientY - r.top);
    const u = useWorldUi.getState();
    // A brush's double-tap is two dabs, not a way into something.
    if (u.mode === "sculpt" || u.mode === "draw") return;
    if (u.mode === "edit") {
      // On a path's node: corner ↔ smooth — the flat pen's double-click.
      const hit = vp.pathPointAt(e.clientX - r.left, e.clientY - r.top);
      if (hit?.part === "anchor") {
        act.pointVerbAt("toggleType", [hit.vert]);
        return;
      }
      // Edit stays on its object: a click never wanders off it. A
      // DOUBLE-click on another editable thing moves the edit there
      // (Blender's Alt Q) — a deliberate act, never an accident.
      if (id && id !== u.editClipId && !vp.nearEditPoint(e.clientX - r.left, e.clientY - r.top) && editElementsOf(locateClip(store.getState(), id)?.clip.kind ?? "audio").length) {
        act.toggleEdit();
        act.openEditor(id);
      }
      return;
    }
    if (!id) return;
    // A camera has no points to go into: going INTO a camera is looking through it.
    if (locateClip(store.getState(), id)?.clip.kind === "camera") vp.lookThrough(id);
    else act.openEditor(id);
  };

  // Requests to open a layer's editor from outside the viewport (timeline,
  // menus, the Layers list) — answered here, once the viewport is up.
  const editRequest = useWorldUi((s) => s.editRequest);
  const ready = info !== null;
  React.useEffect(() => {
    if (!editRequest || !vpRef.current) return;
    useWorldUi.getState().set({ editRequest: null });
    if (useWorldUi.getState().mode === "edit") act.toggleEdit();
    act.openEditor(editRequest);
  }, [editRequest, act, ready]);

  const onDrop = async (e: React.DragEvent) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    const vp = vpRef.current;
    const r = canvasRef.current!.getBoundingClientRect();
    const at = vp ? vp.surfacePoint(e.clientX - r.left, e.clientY - r.top) : ([0, 0, 0] as V3);
    if (files.some((f) => BLEND_FILE.test(f.name))) explainBlendFile();
    const models = files.filter(isModelFile);
    if (models.length) await importModelsIntoWorld(store, frameId, models, at);
    // Pictures and footage stand in the world as planes, at the drop point.
    for (const f of files.filter((f) => !isModelFile(f) && !BLEND_FILE.test(f.name))) {
      const asset = await importFileAsAsset(store, f);
      if (!asset || asset.kind === "audio") continue;
      const frame = store.getState().frames.find((x) => x.id === frameId)!;
      const clip = buildAssetClip(asset, { frameId, startMs: 0, x: at[0], y: at[1] }, frame);
      if (clip.kind !== "audio") clip.transform.z = at[2] + (asset.height ?? 0) / 2;
      store.update(`Add ${asset.kind}`, (d) => placeClip(d, clip, { landing: "surface" }));
      useSession.getState().select([clip.id]);
      // An SVG arrives as its PATHS, standing upright where it was dropped — so
      // a logo can be made solid (Solid depth) or recoloured piece by piece.
      if (isSvgFile(f)) await svgToWorldPaths(store, clip.id);
    }
  };

  const tool = useWorldUi((s) => s.tool);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      ref={hostRef}
      // The flat stage's own surface: `isolate` keeps the WebGL canvas and the
      // glass chrome inside the card's rounded clip (without its own stacking
      // context the composited canvas painted square corners over it), and the
      // void is the theme's stage colour, not a grey of its own.
      className="relative isolate h-full w-full touch-none select-none overflow-hidden rounded-[inherit] bg-stage"
      style={{ backgroundColor: stage }}
      data-world-viewport
      data-stage-drop
      onPointerEnter={() => (pointerInside.current = true)}
      onPointerLeave={() => {
        pointerInside.current = false;
        vpRef.current?.pointerLeave();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (e.shiftKey || vpRef.current?.modalActive) return;
        if (!canvasRef.current?.contains(e.target as Node)) return;
        const r = canvasRef.current.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        // The menu acts on what is under it (the flat pen's rule): a node
        // outside the selection is selected alone, a segment selects its two.
        act.selectUnder(x, y);
        setMenu({ kind: "context", x, y });
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* Both canvases carry the card's radius THEMSELVES: Firefox does not clip
          a composited WebGL canvas to an ancestor's rounded overflow, so a clip
          that lives only on the card left square corners of grid outside it. */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full rounded-[inherit] outline-none"
        tabIndex={0}
        // A brush armed makes the canvas a sheet of paper: a still pen press is a dot, never the hold menu.
        data-no-longpress={strokeToolOf(tool) ? "" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => vpRef.current?.pointerMove(e.nativeEvent)}
        onPointerUp={(e) => vpRef.current?.pointerUp(e.nativeEvent)}
        // A cancel is not a release: what was in flight is undone, never committed.
        onPointerCancel={(e) => vpRef.current?.pointerEnded(e.pointerId)}
        onDoubleClick={onDoubleClick}
      />
      <canvas ref={hudRef} className="pointer-events-none absolute inset-0 h-full w-full rounded-[inherit]" />
      {/* The world's brushes are the flat brush family: the brush handle and
          dials read which one from here instead of the flat stage's tool. */}
      <PaintToolProvider value={tool === "draw" || tool === "paint" ? "brush" : tool === "erase" ? "eraser" : null}>
        <PaintEngineProvider value={tool === "paint" ? "raster" : "vector"}>
          <StageChrome items={worldChromeItems({ act, vpRef, navRef, info, nested })} />
        </PaintEngineProvider>
      </PaintToolProvider>
      <PointMenu menu={menu} close={() => setMenu({ kind: null, x: 0, y: 0 })} act={act} vpRef={vpRef} />
      {typing && <WorldTextEditor key={typing.id} {...typing} close={() => setTyping(null)} />}
      {gpuOff && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
          <p className="max-w-xs">3D is paused — this browser turned off WebGL for the tab.</p>
          <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * TYPING INTO A TEXT IN THE WORLD — a field at the pointer, writing through the
 * same commit the flat canvas's inline editor uses (`commitTextContent`), so a
 * word typed here keys, records and keeps its styled ranges exactly as one
 * typed on the canvas. Every keystroke lands live; Esc or a click away ends it.
 */
function WorldTextEditor({ id, x, y, selectAll, close }: { id: string; x: number; y: number; selectAll: boolean; close: () => void }) {
  const store = useDocStore();
  const initial = React.useMemo(() => {
    const c = locateClip(store.getState(), id)?.clip;
    return c?.kind === "text" ? c.text : "";
  }, [store, id]);
  const [value, setValue] = React.useState(initial);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  // Focus when the popover's content is really in the document (it renders
  // through a portal, after this component's own effects have run).
  const focusField = (e: Event) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  };
  return (
    <Popover open onOpenChange={(o) => !o && close()}>
      <PopoverAnchor asChild>
        <span className="pointer-events-none absolute size-px" style={{ left: x, top: y }} />
      </PopoverAnchor>
      <PopoverContent side="bottom" align="start" sideOffset={10} className="w-72 p-1.5" onOpenAutoFocus={focusField}>
        <textarea
          ref={ref}
          value={value}
          rows={Math.min(6, Math.max(1, value.split("\n").length))}
          onChange={(e) => {
            setValue(e.target.value);
            commitTextContent(store, id, e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
              e.preventDefault();
              close();
            }
          }}
          aria-label="Text"
          className="block w-full resize-none rounded-md bg-transparent px-2 py-1.5 text-sm leading-snug outline-none placeholder:text-muted-foreground"
          placeholder="Type…"
        />
        <div className="flex justify-end px-2 pb-0.5 text-2xs text-muted-foreground">Esc to finish</div>
      </PopoverContent>
    </Popover>
  );
}

// ── Actions: every viewport verb, by name and by key ─────────────────────────

export type Actions = ReturnType<typeof makeActions>;

function makeActions(
  store: ReturnType<typeof useDocStore>,
  frameId: string,
  vpRef: React.MutableRefObject<WorldViewport | null>,
  openMenu: (k: MenuKind) => void,
  nav: NavGizmo,
  editText: (id: string, selectAll?: boolean) => void,
) {
  const vp = () => vpRef.current;
  const ui = () => useWorldUi.getState();
  const selected = () => useSession.getState().selectedClipIds;
  const active = () => {
    const ids = selected();
    return ids[ids.length - 1] ?? null;
  };
  const activeObject = () => vp()?.ev?.objects.find((o) => o.id === active()) ?? null;
  const cursor = () => ui().cursor;

  /** The MESH being edited — for topology operators (extrude, merge, fill…). */
  const editMesh = () => vp()?.editMesh() ?? null;
  /** Whatever is being edited — a mesh, a path, a crop: selection works on any of them. */
  const editCage = () => vp()?.editCage() ?? null;
  const editCommit = (label: string, fn: (mesh: NonNullable<ReturnType<typeof editMesh>>) => { mesh: NonNullable<ReturnType<typeof editMesh>>; sel?: typeof EMPTY_SELECTION } | null) => {
    const u = ui();
    const mesh = editMesh();
    if (!mesh || !u.editClipId) return;
    const res = fn(mesh);
    if (!res) return;
    commitMesh(store, u.editClipId, res.mesh, label);
    if (res.sel) u.set({ elementSel: res.sel });
  };

  /**
   * THE ONE WAY BETWEEN MODES — the header's switch, Tab, the tool keys, Esc.
   * Each mode says what it needs (Edit and Sculpt an object to work on) and
   * which tool it starts with; leaving one always lands in a tool the next
   * mode has, so the rail can never show a tool its mode does not offer.
   */
  const enterMode = (mode: WorldMode, tool?: WorldTool): unknown => {
    const u = ui();
    if (mode === "edit") return u.mode === "edit" ? undefined : enterEdit();
    if (mode === "sculpt") return enterSculpt();
    const next = tool ?? (toolInMode(u.tool, mode) ? u.tool : mode === "draw" ? "draw" : "select");
    u.set({ mode, editClipId: null, elementSel: EMPTY_SELECTION, tool: next });
  };

  /**
   * SCULPT is entered with anything or nothing selected: the brush works on
   * what is under it, inside the selection when there is one (the brush scope).
   * A primitive becomes polygons on its first stroke, in that stroke's undo.
   */
  const enterSculpt = (): unknown => ui().set({ mode: "sculpt", editClipId: null, elementSel: EMPTY_SELECTION, tool: "sculpt" });

  const toggleEdit = () => {
    const u = ui();
    if (u.mode === "edit") {
      enterMode("object");
      return;
    }
    return enterEdit();
  };

  const enterEdit = () => {
    const u = ui();
    const id = active();
    const clip = id ? locateClip(store.getState(), id)?.clip : null;
    const elements = clip ? editElementsOf(clip.kind) : [];
    // Nothing to edit here: not taken, so the key reaches the app.
    if (!clip || elements.length === 0) return false;
    if (clip.kind === "mesh" && clip.geometry.type === "asset") {
      toast("Imported models edit as polygons once made editable", { description: "Right-click › Make editable." });
      return;
    }
    // Parametric things become editable on the way in, in one undo step — a
    // primitive into polygons, a shape into a path (C4D's "make editable").
    if (clip.kind === "mesh" && clip.geometry.type === "primitive") makeEditable(store, clip.id);
    if (clip.kind === "shape") store.update("Make editable", (d) => void convertShapeClipToPath(d, clip.id));
    const mode = elements.includes(u.elementMode) ? u.elementMode : elements[0]!;
    u.set({ mode: "edit", editClipId: clip.id, elementMode: mode, elementSel: { ...EMPTY_SELECTION, mode }, tool: toolInMode(u.tool, "edit") ? u.tool : "select" });
  };

  /**
   * THE FILL TOOL — the paint bucket, in space. Tap inside a drawing on its
   * page and that region fills (the flat bucket's exact path, `pourFill`);
   * tap an object and it takes the colour as its fill (a mesh's base colour,
   * a text's or a shape's fill). Looks THROUGH empty cards to what is behind.
   */
  const fillAt = (x: number, y: number) => {
    const v = vp();
    if (!v?.ev) return;
    const doc = store.getState();
    const paint = solidPaint(useDrawing.getState().fill.color);
    const inked = v.pickObject(x, y);
    for (const h of v.hitsAt(x, y)) {
      const o = v.ev.objects.find((ob) => ob.id === h.id);
      const clip = locateClip(doc, h.id)?.clip;
      if (!o || !clip) continue;
      if (clip.kind === "path") {
        const p = localToPlane(planeBasis(doc, o.source), transformPoint(invert(o.matrix), h.point));
        const region = regionAtPoint(clip.subpaths, p.x, p.y, clip.fillRule);
        if (!region) continue;
        const contourId = region.contours[0]!.id;
        store.update("Fill shape", (d) => {
          const c = locateClip(d, h.id)?.clip;
          if (c?.kind === "path") pourFill(c, contourId, paint);
        });
        return;
      }
      if (h.id !== inked) continue;
      if (clip.kind === "mesh" || clip.kind === "text" || clip.kind === "shape") {
        store.update("Fill", (d) => {
          const c = locateClip(d, h.id)?.clip;
          if (c && "fills" in c) (c as { fills: unknown[] }).fills = [paint];
        });
        return;
      }
    }
    toast("Nothing to fill here", { description: "Tap inside a closed drawing, or on an object." });
  };

  /** The sculpt brush's settings — the options row and the keys write the same store. */
  const sculpt = (patch: Parameters<ReturnType<typeof useToolDefaults.getState>["setSculpt"]>[0]) => useToolDefaults.getState().setSculpt(patch);
  const sculptBrush = (brush: SculptBrush) => () => (ui().mode === "sculpt" ? (sculpt({ brush }), ui().set({ tool: "sculpt" })) : false);
  /** Smooth the selected meshes into four times the points — what a low-poly shape needs before a brush can shape it. */
  const sculptDetail = () => {
    const doc = store.getState();
    const meshes = selected()
      .map((id) => locateClip(doc, id)?.clip)
      .filter((c): c is MeshClip => c?.kind === "mesh" && c.geometry.type !== "asset" && !c.lattice);
    if (!meshes.length) {
      toast("Select a mesh to subdivide");
      return;
    }
    store.update("Subdivide", (d) => {
      for (const c of meshes) {
        const mesh = meshDataOf(c);
        if (mesh && mesh.faces.length < 120000) setMeshData(d, c.id, catmullClark(mesh));
      }
    });
  };

  /**
   * DOUBLE-CLICK GOES INTO WHAT IT HITS — every kind's own editor, the flat
   * canvas's rule in 3D: a mesh into its polygons, a path or a stroke into its
   * points, a shape into points (made a path on the way), a picture into its
   * crop, a text into its words, a nested comp into its timeline.
   */
  const openEditor = (id: string): unknown => {
    const clip = locateClip(store.getState(), id)?.clip;
    if (!clip) return false;
    if (clip.kind === "text") return editText(id);
    if (clip.kind === "nested") return useSession.getState().enterClip(id);
    if (!editElementsOf(clip.kind).length) return false;
    useSession.getState().select([id]);
    return toggleEdit();
  };

  /**
   * THE POINT VERBS on a path in edit mode — core `node-verbs`, the flat pen's
   * own, on the nodes selected here. The verb says what is selected after it
   * (the point an extrude made, the node a merge left, the same nodes in a new
   * layout, or none), and a path left with nothing goes, back to Object mode.
   * Not taken (false) when the verb means nothing for this selection, so its
   * key falls through.
   */
  const pointVerbAt = (id: NodeVerbId, verts?: number[]): boolean => {
    const t = vp()?.editTarget();
    const cage = vp()?.editCage();
    if (!isPathTarget(t) || !cage) return false;
    const sel = verts ? new Set(verts) : selectedVerts(cage, ui().elementSel);
    const { result, select } = t.run(id, sel);
    if (result.emptied) {
      ui().set({ mode: "object", editClipId: null, elementSel: EMPTY_SELECTION, tool: "select" });
      return true;
    }
    if (!result.changed && select === undefined) return false;
    if (select !== undefined) ui().set({ elementSel: { ...EMPTY_SELECTION, mode: "vertex", verts: select ?? [] } });
    return true;
  };
  const pointVerb = (id: NodeVerbId) => () => pointVerbAt(id);
  /** What the selected nodes are — which verbs a menu or the bar offers. */
  const pointSelection = (): NodeSelection | null => {
    const t = vp()?.editTarget();
    const cage = vp()?.editCage();
    if (!isPathTarget(t) || !cage) return null;
    return nodeSelection(t.outline(), t.nodesOf(selectedVerts(cage, ui().elementSel)));
  };
  /** F — Blender's "make segment": two open ends join (a line's own two close it); otherwise close or open the line. */
  const makeSegment = () => (pointSelection()?.endpointPair ? pointVerbAt("join") : pointVerbAt("toggleClosed"));
  /** M › At 3D cursor on a path: the nodes become one, where the cursor is. */
  const mergeAtCursor = () => {
    const v = vp();
    const t = v?.editTarget();
    const cage = v?.editCage();
    if (!v || !isPathTarget(t) || !cage) return false;
    const at = t.toLayer(toLocal(v, t.clipId, cursor()));
    const { result, select } = t.apply("Merge points", (subs, refs) => mergeNodes(subs, refs, at), selectedVerts(cage, ui().elementSel));
    if (result.emptied) return void ui().set({ mode: "object", editClipId: null, elementSel: EMPTY_SELECTION, tool: "select" });
    if (select !== undefined) ui().set({ elementSel: { ...EMPTY_SELECTION, mode: "vertex", verts: select ?? [] } });
  };
  const pathOps = {
    delete: pointVerb("delete"),
    toggleSmooth: pointVerb("toggleType"),
    toggleClosed: pointVerb("toggleClosed"),
    subdivide: pointVerb("subdivide"),
    merge: pointVerb("merge"),
    mergeAtCursor,
    extrude: () => vp()?.extrudeModal() ?? false,
    makeSegment,
  };

  /** ⌘A / A on a path: every node (their handles show and ride along). */
  const selectAllNodes = () => {
    const t = vp()?.editTarget();
    if (!isPathTarget(t)) return false;
    const subs = t.outline();
    ui().set({ elementSel: { ...EMPTY_SELECTION, mode: "vertex", verts: vertsOfNodes(subs, subs.flatMap((sp, sub) => sp.points.map((_, index) => ({ sub, index })))) } });
  };

  /**
   * Right-click acts on what is under the pointer: a node outside the
   * selection is selected alone, a segment of the line selects its two nodes,
   * a mesh vertex outside the selection is selected. A point inside the
   * selection leaves it as it is — the menu acts on all of it.
   */
  const selectUnder = (x: number, y: number) => {
    const v = vp();
    const u = ui();
    if (!v || u.mode !== "edit") return;
    const t = v.editTarget();
    if (isPathTarget(t)) {
      const hit = v.pathPointAt(x, y);
      if (hit) {
        if (!u.elementSel.verts.includes(hit.vert)) u.set({ elementSel: { ...EMPTY_SELECTION, mode: "vertex", verts: [hit.vert] } });
        return;
      }
      const seg = v.pathSegmentAt(x, y);
      if (seg && !(u.elementSel.verts.includes(seg.a) && u.elementSel.verts.includes(seg.b))) u.set({ elementSel: { ...EMPTY_SELECTION, mode: "vertex", verts: [seg.a, seg.b] } });
      return;
    }
    const el = u.elementMode === "vertex" ? v.pickElement(x, y) : null;
    if (el?.vert !== undefined && !u.elementSel.verts.includes(el.vert)) u.set({ elementSel: { ...EMPTY_SELECTION, mode: "vertex", verts: [el.vert] } });
  };

  const editKind = () => vp()?.editTarget()?.kind ?? null;
  const cropOps = {
    /** The whole picture again — every inset to 0, keyframe-aware like any crop write. */
    reset: () => {
      const id = vp()?.editTarget()?.clipId;
      if (!id) return;
      store.update("Reset crop", (d) => {
        const loc = locateClip(d, id);
        if (!loc || loc.clip.kind === "audio") return;
        const local = useSession.getState().playheadMs - loc.clip.startMs;
        for (const side of ["top", "right", "bottom", "left"] as const) writeChannel(loc.clip, `crop.${side}`, local, 0, { forceKey: useSession.getState().recording });
      });
    },
  };

  const setElementMode = (mode: ElementMode) => {
    const u = ui();
    const mesh = editMesh();
    u.set({ elementMode: mode, elementSel: mesh ? convertSelection(mesh, u.elementSel, mode) : { ...EMPTY_SELECTION, mode } });
  };

  const view = (key: "front" | "right" | "top", opposite: boolean) => {
    const v = vp();
    if (v) v.setView(axisView(v.view, key, opposite));
  };

  const shading = (s: ShadingMode) => ui().set({ shading: s });

  const add = {
    primitive: (id: string) => addPrimitive(store, frameId, id, cursor()),
    light: (t: LightType) => addLight(store, frameId, t, t === "sun" || t === "environment" || t === "hemisphere" ? [cursor()[0], cursor()[1], cursor()[2] + 500] : add3(cursor(), [0, -200, 300])),
    camera: () => {
      const v = vp();
      const at = v ? eyeFromView(v.view) : ([0, -1500, 300] as V3);
      addCamera(store, frameId, at, v ? v.view.target : [0, 0, 0]);
    },
    text: () => {
      const id = addText(store, frameId, cursor());
      if (id) editText(id, true);
    },
    controller: () => addController(store, frameId, cursor()),
    importModel: () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".glb,.gltf,.obj,.stl,.fbx,.ply";
      input.multiple = true;
      input.onchange = () => void importModelsIntoWorld(store, frameId, [...(input.files ?? [])], cursor());
      input.click();
    },
  };

  /** Click-to-place (the Text and Shape tools): on what you clicked, standing on it. */
  const place = (tool: "text" | "shape", at: V3, hitId: string | null) => {
    const hit = hitId ? locateClip(store.getState(), hitId)?.clip : null;
    if (tool === "text" && hit?.kind === "text") {
      useSession.getState().select([hit.id]);
      editText(hit.id);
      return;
    }
    let id: string | null;
    if (tool === "text") id = addText(store, frameId, at);
    else {
      // A shape lands RESTING on the point, not buried to its waist in it.
      const shape = ui().shape;
      const built = buildPrimitive(shape, {});
      const lift = built ? -meshBounds(built).min[2] : 0;
      id = addPrimitive(store, frameId, shape, [at[0], at[1], at[2] + lift]);
    }
    ui().set({ tool: "select" });
    if (id && tool === "text") editText(id, true);
  };

  /** The edit-mode operators the rail and the menus press, by name — never by faking a key. */
  const ops = {
    extrude: () => vp()?.extrudeModal(),
    inset: () => vp()?.insetModal(),
    loopCut: () => vp()?.armLoopCut(true),
  };

  const objectOps = {
    delete: () => deleteObjects(store, selected()),
    duplicate: () => {
      const ids = selected();
      if (!ids.length) return;
      import("@solomotion/core").then(({ duplicateClips }) => {
        let tops: string[] = [];
        store.update("Duplicate", (d) => void (tops = duplicateClips(d, ids).tops));
        useSession.getState().select(tops);
        // Blender: Shift+D drops you straight into a grab.
        requestAnimationFrame(() => requestAnimationFrame(() => vp()?.beginModal("grab", { label: "Duplicate" })));
      });
    },
    join: () => {
      const v = vp();
      const a = active();
      if (!v?.ev || !a) return;
      if (!joinObjects(store, v.ev.objects.filter((o) => selected().includes(o.id)), a)) toast("Select two or more meshes to join");
    },
    hide: () => ui().set({ localHidden: [...new Set([...ui().localHidden, ...selected()])] }),
    hideOthers: () => {
      const keep = new Set(selected());
      ui().set({ localHidden: (vp()?.ev?.objects ?? []).map((o) => o.id).filter((id) => !keep.has(id)) });
    },
    reveal: () => ui().set({ localHidden: [] }),
    selectAll: () => useSession.getState().select((vp()?.ev?.objects ?? []).map((o) => o.id).filter((id) => !ui().localHidden.includes(id))),
    deselect: () => useSession.getState().select([]),
    invert: () => {
      const cur = new Set(selected());
      useSession.getState().select((vp()?.ev?.objects ?? []).map((o) => o.id).filter((id) => !cur.has(id)));
    },
    originToGeometry: () => {
      const o = activeObject();
      if (o?.kind === "mesh") setOrigin(store, o, "geometry");
    },
    originToCursor: () => {
      const o = activeObject();
      if (o?.kind === "mesh") setOrigin(store, o, "cursor");
    },
    applyTransform: () => {
      const o = activeObject();
      if (o?.kind === "mesh") applyTransform(store, o);
    },
    /** Bake every selected mesh's whole stack into its polygons, at the playhead (Apply › All modifiers). */
    applyModifiers: () => {
      const doc = store.getState();
      const meshes = selected().filter((id) => {
        const c = locateClip(doc, id)?.clip;
        return c?.kind === "mesh" && c.modifiers.length > 0 && c.geometry.type !== "asset";
      });
      if (!meshes.length) return void toast("No modifiers to apply", { description: "Select a mesh with a modifier stack." });
      store.update("Apply all modifiers", (d) => {
        for (const id of meshes) {
          const c = locateClip(d, id)?.clip;
          const last = c?.kind === "mesh" ? c.modifiers[c.modifiers.length - 1] : undefined;
          if (c?.kind === "mesh" && last) applyModifier(c, last.id, Math.max(0, (vp()?.ev?.timeMs ?? 0) - c.startMs));
        }
      });
    },
    shade: (mode: MeshClip["shading"]) =>
      store.update("Shade", (d) => {
        for (const id of selected()) {
          const c = locateClip(d, id)?.clip;
          if (c?.kind === "mesh") c.shading = mode;
        }
      }),
    makeEditable: () => {
      const a = active();
      if (a) makeEditable(store, a);
    },
    makeActiveCamera: () => {
      const a = active();
      if (a) setActiveCamera(store, frameId, a);
    },
    lookThrough: (lock: boolean) => {
      const a = active();
      if (a && setActiveCamera(store, frameId, a, { look: true }) && lock) useWorldUi.getState().set({ lockCamera: true });
    },
    insertKey: () => {
      const v = vp();
      if (!v?.ev) return;
      const items = v.ev.objects
        .filter((o) => selected().includes(o.id))
        .map((o) => {
          const t = o.source.transform;
          return { id: o.id, values: { x: t.x, y: t.y, z: t.z ?? 0, rotationX: t.rotationX ?? 0, rotationY: t.rotationY ?? 0, rotation: t.rotation, scale: t.scale, scaleY: t.scaleY ?? t.scale, scaleZ: t.scaleZ ?? t.scale } };
        });
      const was = useSession.getState().recording;
      useSession.setState({ recording: true });
      commitPlacements(store, "Insert keyframe", items);
      useSession.setState({ recording: was });
      toast(`Keyed location, rotation and scale`);
    },
  };

  const editOps = {
    selectAll: () => {
      const m = editCage();
      if (m) ui().set({ elementSel: selectAll(m, ui().elementMode) });
    },
    deselect: () => ui().set({ elementSel: { ...EMPTY_SELECTION, mode: ui().elementMode } }),
    invert: () => {
      const m = editCage();
      if (m) ui().set({ elementSel: invertSelection(m, ui().elementSel) });
    },
    linked: () => {
      const m = editMesh();
      if (m) ui().set({ elementSel: selectLinked(m, ui().elementSel) });
    },
    grow: () => {
      const m = editMesh();
      if (m) ui().set({ elementSel: growSelection(m, ui().elementSel) });
    },
    delete: (kind: "vertices" | "edges" | "faces" | "onlyFaces") =>
      editCommit("Delete", (m) => {
        const r = deleteElements(m, ui().elementSel, kind);
        return { mesh: r.mesh, sel: r.selection };
      }),
    dissolve: () => editCommit("Dissolve edges", (m) => {
      const r = dissolveEdges(m, ui().elementSel);
      return { mesh: r.mesh, sel: r.selection };
    }),
    merge: (at: "center" | "cursor" | "first" | "last") =>
      editCommit("Merge", (m) => {
        const r = mergeVerts(m, ui().elementSel, at, toLocal(vp(), ui().editClipId, cursor()));
        return { mesh: r.mesh, sel: convertSelection(r.mesh, r.selection, ui().elementMode) };
      }),
    // Ctrl+M: flip the selection across the pivot (median, or the 3D cursor), on the object's own axis.
    mirror: (axis: 0 | 1 | 2) =>
      editCommit(`Mirror ${"XYZ"[axis]}`, (m) => {
        const sel = ui().elementSel;
        const pivot = ui().pivot === "cursor" ? toLocal(vp(), ui().editClipId, cursor()) : (selectionMedian(m, sel) ?? [0, 0, 0]);
        const r = mirrorSelection(m, sel, axis, pivot);
        return { mesh: r.mesh, sel: r.selection };
      }),
    mergeByDistance: () =>
      editCommit("Merge by distance", (m) => {
        const r = weldMesh(m, 0.5, selectedVerts(m, ui().elementSel));
        toast(`Removed ${r.removed} vertices`);
        return { mesh: r.mesh, sel: { ...EMPTY_SELECTION, mode: ui().elementMode } };
      }),
    fill: () => editCommit("Fill", (m) => {
      const r = fillFace(m, ui().elementSel);
      return { mesh: r.mesh, sel: convertSelection(r.mesh, r.selection, ui().elementMode) };
    }),
    bridge: () =>
      editCommit("Bridge edge loops", (m) => {
        const r = bridgeLoops(m, ui().elementSel);
        if (r.error) {
          toast(r.error);
          return null;
        }
        return { mesh: r.mesh, sel: convertSelection(r.mesh, r.selection, ui().elementMode) };
      }),
    // Blender's Spin: around the view's axis, through the 3D cursor — a full turn in 12 steps.
    spin: () =>
      editCommit("Spin", (m) => {
        const v = vp();
        const id = ui().editClipId;
        if (!v) return null;
        const c = cursor();
        const f = viewBasis(v.view).forward;
        const center = toLocal(v, id, c);
        const ahead = toLocal(v, id, [c[0] + f[0], c[1] + f[1], c[2] + f[2]]);
        const r = spinSelection(m, ui().elementSel, center, [ahead[0] - center[0], ahead[1] - center[1], ahead[2] - center[2]], 360, 12);
        if (r.mesh === m) {
          toast("Select points or edges to spin");
          return null;
        }
        return { mesh: r.mesh, sel: convertSelection(r.mesh, r.selection, ui().elementMode) };
      }),
    subdivide: () => editCommit("Subdivide", (m) => {
      const r = subdivideFaces(m, ui().elementSel);
      return { mesh: r.mesh, sel: convertSelection(r.mesh, r.selection, ui().elementMode) };
    }),
    flip: () => editCommit("Flip normals", (m) => ({ mesh: flipFaces(m, selectedFaces(m, ui().elementSel)) })),
    recalc: () => editCommit("Recalculate normals", (m) => ({ mesh: recalcNormalsOutside(m) })),
    duplicate: () => {
      const m = editMesh();
      const u = ui();
      if (!m || !u.editClipId) return;
      const r = duplicateFaces(m, u.elementSel);
      if (r.mesh === m) return;
      commitMesh(store, u.editClipId, r.mesh, "Duplicate");
      u.set({ elementSel: r.selection });
      requestAnimationFrame(() => requestAnimationFrame(() => vp()?.beginModal("grab", { label: "Duplicate" })));
    },
    separate: () => {
      const m = editMesh();
      const u = ui();
      if (!m || !u.editClipId) return;
      const r = separateFaces(m, u.elementSel);
      if (!r) return toast("Select some faces (but not all) to separate");
      separateInto(store, u.editClipId, r.kept, r.separated);
      u.set({ elementSel: { ...EMPTY_SELECTION, mode: u.elementMode } });
    },
    markStroke: (on: boolean) => editCommit(on ? "Mark for stroke" : "Clear stroke mark", (m) => ({ mesh: markEdges(m, ui().elementSel, "marks", on) })),
    markSharp: (on: boolean) => editCommit(on ? "Mark sharp" : "Clear sharp", (m) => ({ mesh: markEdges(m, ui().elementSel, "sharp", on) })),
    newPart: () => {
      const u = ui();
      const id = u.editClipId;
      const m = editMesh();
      if (!id || !m) return;
      const partId = `part_${Math.random().toString(36).slice(2, 8)}`;
      store.update("New part from selection", (d) => {
        const c = locateClip(d, id)?.clip;
        if (c?.kind !== "mesh") return;
        c.parts.push({ id: partId, name: `Part ${c.parts.length + 1}`, fills: [{ id: `paint_${partId}`, type: "solid", color: "#ff7a45", enabled: true, opacity: 1, blendMode: "normal" }] });
        if (c.geometry.type === "mesh") c.geometry.mesh = assignPart(c.geometry.mesh, u.elementSel, partId);
      });
      toast("The selected faces are a part now — style them in the inspector");
    },
  };

  /**
   * CONVERT (Blender's Object › Convert; the canvas's ⌘E): a text becomes a
   * path and a shape a path, IN PLACE — same layer, same keys, same thickness
   * and stack — so its points are yours to edit. Nothing convertible selected:
   * not taken.
   */
  const convert = () => {
    const doc = store.getState();
    const ids = selected().filter((id) => {
      const k = locateClip(doc, id)?.clip.kind;
      return k === "text" || k === "shape";
    });
    if (ids.length === 0) return false;
    void (async () => {
      let done = 0;
      for (const id of ids) {
        const kind = locateClip(store.getState(), id)?.clip.kind;
        if (kind === "shape") store.update("Convert to path", (d) => void (convertShapeClipToPath(d, id) && done++));
        else if (kind === "text" && (await convertTextClipToPath(store, id))) done++;
      }
      if (done) toast(done > 1 ? `${done} layers are paths now` : "It's a path now — Tab to edit its points");
      else toast.error("Couldn't outline that text", { description: "Its font may still be loading." });
    })();
  };

  /**
   * CONVERT TO MESH (Blender's Object › Convert › Mesh): the layer's body as it
   * stands — thickness, modifiers and all — becomes editable polygons, and the
   * layer moves into a comp the mesh wears, so its picture stays live (core
   * `convertBodyToMesh`). Nothing that is a 2D layer selected: not taken.
   */
  const convertToMesh = () => {
    const doc = store.getState();
    const ids = selected().filter((id) => {
      const c = locateClip(doc, id)?.clip;
      return !!c && isBodyKind(c.kind);
    });
    if (!ids.length) return false;
    void (async () => {
      const engine = await loadWorldEngine();
      const frame = store.getState().frames.find((f) => f.id === frameId);
      if (!frame) return;
      const t = vp()?.ev?.timeMs ?? 0;
      const made: string[] = [];
      for (const id of ids) {
        const baked = engine.bakeBody(store.getState(), frame, id, t);
        if (!baked) continue;
        store.update("Convert to mesh", (d) => {
          const m = convertBodyToMesh(d, id, baked);
          if (m) made.push(m);
        });
      }
      if (made.length) {
        useSession.getState().select(made);
        toast(made.length > 1 ? `${made.length} meshes — their pictures live on as textures` : "It's a mesh now — Tab edits its polygons; the picture is still live", {
          description: "The layer moved into a comp the mesh wears: open it from the Texture section to change the words or the picture.",
        });
      } else toast.error("Couldn't build that body yet", { description: "A font may still be loading — try again in a moment." });
    })();
  };

  /** Blender's Add › Lattice, fitted, parented and wired in one step (core `addLattice`); the cage comes selected, ready for Tab. */
  const addLatticeTo = () => {
    const doc = store.getState();
    const ids = selected().filter((id) => {
      const c = locateClip(doc, id)?.clip;
      return !!c && ((c.kind === "mesh" && !c.lattice) || isBodyKind(c.kind));
    });
    if (!ids.length) return false;
    const cages: string[] = [];
    store.update("Add lattice", (d) => {
      for (const id of ids) {
        const made = addLattice(d, id, { bounds: measuredBounds(id) });
        if (made) cages.push(made.cageId);
      }
    });
    if (!cages.length) return false;
    useSession.getState().select(cages);
    toast(cages.length > 1 ? `${cages.length} lattices` : "A lattice round it", { description: "Tab into the cage and move its points — the shape follows. Its Lattice card is in Modifiers." });
  };

  /**
   * The viewport's commands, by id — the keys themselves live in the one
   * shortcut registry (`state/world-shortcuts.ts`): Blender's by default, the
   * the app's keymap or your own from Settings. A command returns `false` when it
   * did nothing here (no selection to grab, an edit verb on the wrong kind),
   * and the key is then NOT taken: the app's own command for it still works.
   */
  const inEdit = () => ui().mode === "edit";
  const either = (o: () => unknown, e: () => unknown) => () => (inEdit() ? e() : o());
  const zoom = (k: number) => {
    const v = vp();
    if (v) v.setView({ ...v.view, distance: v.view.distance * k });
  };
  const handlers: Record<WorldCommandId, (e: KeyboardEvent) => unknown> = {
    // With nothing to move these do nothing — and so they are not taken: the
    // key falls through to the app (R records, S snaps), as Blender passes a
    // key the editor under the mouse has no use for.
    "world.grab": () => vp()?.beginModal("grab") ?? false,
    "world.rotate": () => vp()?.beginModal("rotate") ?? false,
    "world.scale": () => vp()?.beginModal("scale") ?? false,
    "world.clearLocation": () => clearTransform(store, selected(), "location"),
    "world.clearRotation": () => clearTransform(store, selected(), "rotation"),
    "world.clearScale": () => clearTransform(store, selected(), "scale"),
    "world.applyMenu": () => openMenu("apply"),
    "world.snapMenu": () => openMenu("snap"),
    "world.proportional": () => ui().set({ proportional: !ui().proportional }),
    "world.selectAll": either(objectOps.selectAll, () => (editKind() === "path" ? selectAllNodes() : editOps.selectAll())),
    "world.deselect": either(objectOps.deselect, editOps.deselect),
    "world.invert": either(objectOps.invert, editOps.invert),
    "world.selectLinked": () => {
      const v = vp();
      if (!v) return;
      if (editKind() !== "path") return v.selectLinkedUnder(v.mouse[0], v.mouse[1]);
      // L on a line: the whole line under the pointer joins the selection.
      const hit = v.pathPointAt(v.mouse[0], v.mouse[1]);
      const seg = hit ? null : v.pathSegmentAt(v.mouse[0], v.mouse[1]);
      const at = hit?.vert ?? seg?.a;
      if (at === undefined) return false;
      const was = ui().elementSel.verts;
      pointVerbAt("selectRun", [at]);
      ui().set({ elementSel: { ...ui().elementSel, verts: [...new Set([...was, ...ui().elementSel.verts])] } });
    },
    "world.selectLinkedAll": () => (editKind() === "path" ? pointVerbAt("selectRun") : editOps.linked()),
    "world.grow": () => editOps.grow(),
    "world.toggleEdit": toggleEdit,
    "world.add": () => openMenu("add"),
    "world.delete": () => {
      if (!inEdit()) return objectOps.delete();
      const kind = editKind();
      if (kind === "path") return pathOps.delete();
      if (kind === "mesh") return openMenu("delete");
      return false;
    },
    "world.duplicate": either(objectOps.duplicate, editOps.duplicate),
    "world.join": objectOps.join,
    "world.convert": convert,
    "world.convertMesh": convertToMesh,
    "world.addLattice": addLatticeTo,
    "world.hide": objectOps.hide,
    "world.hideOthers": objectOps.hideOthers,
    "world.reveal": objectOps.reveal,
    "world.insertKey": objectOps.insertKey,
    "world.extrude": () => vp()?.extrudeModal() ?? false,
    "world.inset": () => vp()?.insetModal() ?? false,
    "world.loopCut": () => vp()?.armLoopCut(true),
    "world.bridge": () => (editKind() === "mesh" ? editOps.bridge() : false),
    "world.spin": () => (editKind() === "mesh" ? editOps.spin() : false),
    "world.fill": () => (editKind() === "mesh" ? editOps.fill() : editKind() === "path" ? makeSegment() : false),
    "world.toggleClosed": () => editKind() === "path" && pathOps.toggleClosed(),
    "world.pointType": () => (editKind() === "path" ? pathOps.toggleSmooth() : false),
    "world.merge": () => (editKind() === "path" && (pointSelection()?.nodeCount ?? 0) < 2 ? false : openMenu("merge")),
    "world.mirror": () => openMenu("mirror"),
    "world.separate": () => editOps.separate(),
    "world.recalcNormals": () => editOps.recalc(),
    "world.flipNormals": () => editOps.flip(),
    "world.vertexMode": () => setElementMode("vertex"),
    "world.edgeMode": () => setElementMode("edge"),
    "world.faceMode": () => setElementMode("face"),
    "world.toolSelect": () => ui().set({ tool: "select" }),
    "world.cycleTool": () => cycleTool(),
    "world.toolDraw": () => armTool("draw"),
    "world.toolPaint": () => armTool("paint"),
    "world.toolErase": () => armTool("erase"),
    "world.toolFill": () => armTool("fill"),
    "world.toolText": () => armTool("text"),
    "world.toolKnife": () => armTool("knife"),
    "world.modeSculpt": () => enterMode("sculpt"),
    "world.sculptDraw": sculptBrush("draw"),
    "world.sculptClay": sculptBrush("clay"),
    "world.sculptInflate": sculptBrush("inflate"),
    "world.sculptCrease": sculptBrush("crease"),
    "world.sculptSmooth": sculptBrush("smooth"),
    "world.sculptFlatten": sculptBrush("flatten"),
    "world.sculptPinch": sculptBrush("pinch"),
    "world.sculptGrab": sculptBrush("grab"),
    "world.sculptInvert": () => sculpt({ direction: useToolDefaults.getState().world.sculpt.direction === 1 ? -1 : 1 }),
    "world.brushSmaller": () => sculpt({ radiusPx: Math.max(2, Math.round(useToolDefaults.getState().world.sculpt.radiusPx / 1.15)) }),
    "world.brushBigger": () => sculpt({ radiusPx: Math.min(600, Math.round(useToolDefaults.getState().world.sculpt.radiusPx * 1.15)) }),
    "world.sculptDetail": sculptDetail,
    "world.escape": () => {
      // Out one step at a time: the armed tool, then the mode.
      const u = ui();
      if (u.mode === "sculpt" || u.mode === "draw") enterMode("object");
      else if (u.tool !== "select") u.set({ tool: "select" });
      else if (inEdit()) toggleEdit();
      else return false;
    },
    "world.shadingMenu": () => openMenu("shading"),
    "world.xray": () => ui().set({ xray: !ui().xray }),
    "world.viewMenu": () => openMenu("view"),
    "world.viewFront": () => view("front", false),
    "world.viewBack": () => view("front", true),
    "world.viewRight": () => view("right", false),
    "world.viewLeft": () => view("right", true),
    "world.viewTop": () => view("top", false),
    "world.viewBottom": () => view("top", true),
    "world.viewFrontAlt": () => view("front", false),
    "world.viewRightAlt": () => view("right", false),
    "world.viewTopAlt": () => view("top", false),
    "world.viewOpposite": () => {
      const v = vp();
      if (v) v.setView({ ...v.view, pitch: -v.view.pitch, yaw: v.view.yaw + 180 });
    },
    "world.perspective": () => togglePerspective(),
    "world.cameraView": () => vp()?.toggleCameraView(),
    "world.cameraToView": () => vp()?.cameraToView(),
    "world.frameSelected": () => vp()?.frameSelected(),
    "world.frameAll": () => vp()?.frameAll(),
    "world.resetCursor": () => {
      ui().set({ cursor: [0, 0, 0] });
      vp()?.frameAll();
    },
    "world.orbitLeft": () => orbitStep(vp(), -15, 0),
    "world.orbitRight": () => orbitStep(vp(), 15, 0),
    "world.orbitUp": () => orbitStep(vp(), 0, 15),
    "world.orbitDown": () => orbitStep(vp(), 0, -15),
    "world.zoomIn": () => zoom(1 / 1.2),
    "world.zoomOut": () => zoom(1.2),
  };

  const cycleTool = () => {
    const order: WorldTool[] = ["select", "move", "rotate", "scale"];
    const i = order.indexOf(ui().tool);
    ui().set({ tool: order[(i + 1) % order.length]! });
  };

  /**
   * Arm a tool — entering the mode it belongs to (D from Object mode is Draw
   * mode with the vector brush) — or, pressed again, step back out (Blender's
   * toggle for D and K).
   */
  const armTool = (tool: WorldTool): unknown => {
    const u = ui();
    if (u.tool === tool) return u.mode === "draw" ? enterMode("object") : u.set({ tool: "select" });
    if (toolInMode(tool, u.mode)) return u.set({ tool });
    const home = WORLD_TOOLS[tool].modes[0]!;
    // Only Draw is entered by its tool's key: Edit and Sculpt need an object first.
    if (home !== "draw") return false;
    return enterMode(home, tool);
  };
  const togglePerspective = () => {
    const v = vp();
    if (v) v.setView({ ...v.view, ortho: !v.view.ortho });
  };
  /**
   * EXPORT THE SELECTION as a 3D file — through the same exporter as the
   * Export panel's whole-world one, so a single object and a scene come out
   * the same: its body, materials, the picture it wears.
   */
  const exportSelection = async (format: ExportFormat) => {
    const ids = selected();
    const doc = store.getState();
    const frame = doc.frames.find((f) => f.id === frameId);
    if (!frame || !ids.length) return;
    try {
      const engine = await loadWorldEngine();
      const blob = await engine.exportModel(doc, frame, vp()?.ev?.timeMs ?? 0, format, { only: ids });
      const name = ids.length === 1 ? (locateClip(doc, ids[0]!)?.clip.name ?? "object") : `${frame.name || "world"} selection`;
      downloadBlob(blob, `${name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "object"}.${format}`);
      toast(`Exported ${format.toUpperCase()}`);
    } catch (err) {
      toast.error("Couldn't export that", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return {
    handlers,
    openEditor,
    pointVerb,
    pointVerbAt,
    pointSelection,
    selectUnder,
    convert,
    convertToMesh,
    addLatticeTo,
    exportSelection,
    add,
    place,
    ops,
    objectOps,
    editOps,
    pathOps,
    cropOps,
    toggleEdit,
    enterMode,
    fillAt,
    sculptDetail,
    armTool,
    setElementMode,
    view,
    shading,
    togglePerspective,
    nav,
    openMenu,
    exit: exitWorldViewport,
    cursorToSelected: () => cursorToSelected(vp()),
    selectionToCursor: () => selectionToCursor(store, vp()),
  };
}

function add3(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function eyeFromView(v: ViewState): V3 {
  const cp = Math.cos((v.pitch * Math.PI) / 180);
  return [
    v.target[0] + Math.sin((v.yaw * Math.PI) / 180) * cp * v.distance,
    v.target[1] - Math.cos((v.yaw * Math.PI) / 180) * cp * v.distance,
    v.target[2] + Math.sin((v.pitch * Math.PI) / 180) * v.distance,
  ];
}

function orbitStep(vp: WorldViewport | null, yaw: number, pitch: number): void {
  if (!vp) return;
  vp.setView({ ...vp.view, yaw: vp.view.yaw + yaw, pitch: Math.max(-90, Math.min(90, vp.view.pitch + pitch)), ortho: false });
}

function toLocal(vp: WorldViewport | null, clipId: string | null, p: V3): V3 {
  const o = vp?.ev?.objects.find((x) => x.id === clipId);
  if (!o) return p;
  const m = o.matrix;
  const inv = invert(m);
  return [
    inv[0]! * p[0] + inv[4]! * p[1] + inv[8]! * p[2] + inv[12]!,
    inv[1]! * p[0] + inv[5]! * p[1] + inv[9]! * p[2] + inv[13]!,
    inv[2]! * p[0] + inv[6]! * p[1] + inv[10]! * p[2] + inv[14]!,
  ];
}

function cursorToSelected(vp: WorldViewport | null): void {
  if (!vp?.ev) return;
  const ids = useSession.getState().selectedClipIds;
  const objs = vp.ev.objects.filter((o) => ids.includes(o.id));
  if (!objs.length) return;
  const c = objs.reduce((a, o) => add3(a, matPosition(o.matrix)), [0, 0, 0] as V3).map((v) => v / objs.length) as V3;
  useWorldUi.getState().set({ cursor: c });
}

function selectionToCursor(store: ReturnType<typeof useDocStore>, vp: WorldViewport | null): void {
  if (!vp?.ev) return;
  const ids = useSession.getState().selectedClipIds;
  const c = useWorldUi.getState().cursor;
  const items = vp.ev.objects
    .filter((o) => ids.includes(o.id))
    .map((o) => {
      // The cursor, expressed in the space the object's position is written in.
      const inv = invert(parentMatrixOf(o));
      return {
        id: o.id,
        values: {
          x: inv[0]! * c[0] + inv[4]! * c[1] + inv[8]! * c[2] + inv[12]!,
          y: inv[1]! * c[0] + inv[5]! * c[1] + inv[9]! * c[2] + inv[13]!,
          z: inv[2]! * c[0] + inv[6]! * c[1] + inv[10]! * c[2] + inv[14]!,
        },
      };
    });
  commitPlacements(store, "Selection to cursor", items);
}

// ── Menus at the pointer (⇧A, right-click, X, M, Z, ⇧S, `) ──────────────────

const EXPORT_CHOICES: Array<{ format: ExportFormat; label: string; detail: string }> = [
  { format: "glb", label: "glTF Binary (.glb)", detail: "Blender, web, game engines" },
  { format: "usdz", label: "USDZ", detail: "AR on iPhone and iPad" },
  { format: "obj", label: "OBJ", detail: "Geometry anywhere" },
  { format: "stl", label: "STL", detail: "3D printing, millimetres" },
];

/** Export ▸ — the selection as a 3D file, in the formats people actually open. */
function ExportItems({ act }: { act: Actions }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Export as 3D file</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-60">
        {EXPORT_CHOICES.map((c) => (
          <DropdownMenuItem key={c.format} onSelect={() => void act.exportSelection(c.format)}>
            <span className="flex min-w-0 flex-col">
              <span>{c.label}</span>
              <span className="text-2xs text-muted-foreground">{c.detail}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** A 3D command's key as the registry has it now (the first, where it has several). */
function K({ id }: { id: WorldCommandId }) {
  const combo = useCombo(id).split(" ")[0] ?? "";
  return combo ? <DropdownMenuShortcut>{formatCombo(combo)}</DropdownMenuShortcut> : null;
}

/**
 * THE OBJECT MENU (right-click in Object mode) — what Blender's object context
 * menu is, for what is actually selected: a mesh's shading, a text's Convert,
 * a camera's Make active, and the verbs everything shares.
 */
function ObjectMenu({ act }: { act: Actions }) {
  const doc = useDoc();
  const ids = useSession((s) => s.selectedClipIds);
  const clips = ids.map((id) => locateClip(doc, id)?.clip).filter((c): c is NonNullable<typeof c> => !!c);
  const kinds = new Set(clips.map((c) => c.kind));
  const only = (k: string) => kinds.size === 1 && kinds.has(k as never);
  const convertible = clips.some((c) => c.kind === "text" || c.kind === "shape");
  const bodies = clips.some((c) => isBodyKind(c.kind));
  const latticeable = clips.some((c) => (c.kind === "mesh" && !c.lattice) || isBodyKind(c.kind));
  const editable = clips.length === 1 && editElementsOf(clips[0]!.kind).length > 0;
  const editLabel = clips[0]?.kind === "mesh" ? "Edit mesh" : clips[0]?.kind === "image" || clips[0]?.kind === "video" ? "Crop" : "Edit points";
  return (
    <>
      <DropdownMenuLabel>{clips.length > 1 ? `${clips.length} objects` : (clips[0]?.name ?? "Object")}</DropdownMenuLabel>
      {only("mesh") && (
        <>
          <DropdownMenuItem onSelect={() => act.objectOps.shade("smooth")}>Shade smooth</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act.objectOps.shade("auto")}>Shade auto smooth</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act.objectOps.shade("flat")}>Shade flat</DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      {editable && <DropdownMenuItem onSelect={act.toggleEdit}>{editLabel} <K id="world.toggleEdit" /></DropdownMenuItem>}
      {(convertible || bodies) && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Convert</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {convertible && <DropdownMenuItem onSelect={act.convert}>To path <K id="world.convert" /></DropdownMenuItem>}
            {bodies && <DropdownMenuItem onSelect={act.convertToMesh}>To mesh <K id="world.convertMesh" /></DropdownMenuItem>}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      {only("mesh") && <DropdownMenuItem onSelect={act.objectOps.makeEditable}>Make editable</DropdownMenuItem>}
      {latticeable && <DropdownMenuItem onSelect={act.addLatticeTo}>Add lattice <K id="world.addLattice" /></DropdownMenuItem>}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Set origin</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onSelect={act.objectOps.originToGeometry}>Origin to geometry</DropdownMenuItem>
          <DropdownMenuItem onSelect={act.objectOps.originToCursor}>Origin to 3D cursor</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Apply</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onSelect={act.objectOps.applyTransform}>Rotation &amp; scale <K id="world.applyMenu" /></DropdownMenuItem>
          {only("mesh") && <DropdownMenuItem onSelect={act.objectOps.applyModifiers}>All modifiers</DropdownMenuItem>}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {only("camera") && clips.length === 1 && (
        <>
          <DropdownMenuItem onSelect={act.objectOps.makeActiveCamera}>Make active camera</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act.objectOps.lookThrough(false)}>Look through it</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act.objectOps.lookThrough(true)}>Look through and lock to view</DropdownMenuItem>
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={act.objectOps.insertKey}>Insert keyframe <K id="world.insertKey" /></DropdownMenuItem>
      <DropdownMenuItem onSelect={act.objectOps.duplicate}>Duplicate <K id="world.duplicate" /></DropdownMenuItem>
      {only("mesh") && clips.length > 1 && <DropdownMenuItem onSelect={act.objectOps.join}>Join <K id="world.join" /></DropdownMenuItem>}
      <DropdownMenuItem onSelect={act.objectOps.hide}>Hide <K id="world.hide" /></DropdownMenuItem>
      <DropdownMenuItem onSelect={act.objectOps.reveal}>Reveal hidden <K id="world.reveal" /></DropdownMenuItem>
      <DropdownMenuSeparator />
      <ExportItems act={act} />
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={act.objectOps.delete} className="text-destructive">Delete <K id="world.delete" /></DropdownMenuItem>
    </>
  );
}

/** One shared verb as a menu item, its key from the registry. */
function VerbItem({ act, id, cmd, label, danger }: { act: Actions; id: NodeVerbId; cmd?: WorldCommandId; label?: string; danger?: boolean }) {
  return (
    <DropdownMenuItem onSelect={() => void act.pointVerbAt(id)} className={danger ? "text-destructive" : undefined}>
      {label ?? NODE_VERBS[id].label} {cmd && <K id={cmd} />}
    </DropdownMenuItem>
  );
}

/**
 * THE POINT MENU (right-click on a path in edit mode) — the flat pen's point
 * menu, organised by what is acted on, offering only what this selection can
 * do: the nodes, then the segment two of them name, then the line. Every item
 * is a shared verb (core `node-verbs`), so it does here exactly what it does
 * on the canvas.
 */
function PathPointMenu({ act }: { act: Actions }) {
  const sel = act.pointSelection();
  if (!sel) return null;
  const n = sel.nodeCount;
  const ok = (id: NodeVerbId) => NODE_VERBS[id].applies(sel);
  return (
    <>
      {n > 0 && (
        <>
          <DropdownMenuLabel>{n > 1 ? `${n} points` : "Point"}</DropdownMenuLabel>
          {sel.type !== "smooth" && <VerbItem act={act} id="smooth" cmd={sel.type === "corner" ? "world.pointType" : undefined} />}
          {sel.type !== "corner" && <VerbItem act={act} id="corner" cmd={sel.type === "smooth" ? "world.pointType" : undefined} />}
          {sel.type !== "corner" && <VerbItem act={act} id="mirrorHandles" />}
          {ok("join") && <VerbItem act={act} id="join" cmd="world.fill" />}
          {ok("merge") && (
            <DropdownMenuItem onSelect={() => requestAnimationFrame(() => act.openMenu("merge"))}>
              Merge… <K id="world.merge" />
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void act.pathOps.extrude()}>
            Extrude <K id="world.extrude" />
          </DropdownMenuItem>
          {ok("break") && <VerbItem act={act} id="break" />}
          {ok("subdivide") && !sel.segment && <VerbItem act={act} id="subdivide" />}
        </>
      )}
      {sel.segment && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Segment</DropdownMenuLabel>
          <VerbItem act={act} id={sel.segment === "line" ? "toCurve" : "toLine"} />
          <VerbItem act={act} id="subdivide" label="Add point" />
          <VerbItem act={act} id="duplicateSeg" />
          <VerbItem act={act} id="deleteSeg" />
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Line</DropdownMenuLabel>
      {n > 0 && <VerbItem act={act} id="selectRun" cmd="world.selectLinkedAll" />}
      {n > 0 && sel.anyOpen && <VerbItem act={act} id="close" cmd="world.toggleClosed" />}
      {n > 0 && sel.anyClosed && <VerbItem act={act} id="open" cmd="world.toggleClosed" />}
      <VerbItem act={act} id="reverse" />
      <VerbItem act={act} id="simplify" />
      {n > 0 && (
        <>
          <DropdownMenuSeparator />
          <VerbItem act={act} id="delete" label={n > 1 ? `Delete ${n} points` : "Delete point"} cmd="world.delete" danger />
        </>
      )}
    </>
  );
}

function PointMenu({ menu, close, act, vpRef }: { menu: { kind: MenuKind; x: number; y: number }; close: () => void; act: Actions; vpRef: React.RefObject<WorldViewport | null> }) {
  const ui = useWorldUi();
  const open = menu.kind !== null;
  const edit = ui.mode === "edit";
  const editKind = open && edit ? (vpRef.current?.editTarget()?.kind ?? null) : null;
  return (
    <DropdownMenu open={open} onOpenChange={(o) => !o && close()} modal={false}>
      <DropdownMenuTrigger asChild>
        <span className="pointer-events-none absolute size-px" style={{ left: menu.x, top: menu.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
        {menu.kind === "add" && (
          <>
            <DropdownMenuLabel>Add</DropdownMenuLabel>
            <AddItems act={act} />
          </>
        )}
        {menu.kind === "shading" && (
          <>
            <DropdownMenuLabel>Shading</DropdownMenuLabel>
            {(["wireframe", "solid", "material", "rendered"] as const).map((m) => (
              <DropdownMenuItem key={m} onSelect={() => act.shading(m)}>
                <ShadingIcon mode={m} /> {m === "material" ? "Material preview" : m[0]!.toUpperCase() + m.slice(1)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => ui.set({ xray: !ui.xray })}>
              <SquareDashed className="size-3.5" /> {ui.xray ? "X-ray off" : "X-ray"} <K id="world.xray" />
            </DropdownMenuItem>
          </>
        )}
        {menu.kind === "view" && (
          <>
            <DropdownMenuLabel>View</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => act.view("front", false)}>Front <K id="world.viewFront" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.view("front", true)}>Back <K id="world.viewBack" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.view("right", false)}>Right <K id="world.viewRight" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.view("right", true)}>Left <K id="world.viewLeft" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.view("top", false)}>Top <K id="world.viewTop" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.view("top", true)}>Bottom <K id="world.viewBottom" /></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => vpRef.current?.toggleCameraView()}>Camera <K id="world.cameraView" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => vpRef.current?.frameSelected()}>Frame selected <K id="world.frameSelected" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => vpRef.current?.frameAll()}>Frame all <K id="world.frameAll" /></DropdownMenuItem>
          </>
        )}
        {menu.kind === "snap" && (
          <>
            <DropdownMenuLabel>Snap</DropdownMenuLabel>
            <DropdownMenuItem onSelect={act.cursorToSelected}>Cursor to selected</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ui.set({ cursor: [0, 0, 0] })}>Cursor to world origin</DropdownMenuItem>
            <DropdownMenuItem onSelect={act.selectionToCursor}>Selection to cursor</DropdownMenuItem>
          </>
        )}
        {menu.kind === "apply" && (
          <>
            <DropdownMenuLabel>Apply</DropdownMenuLabel>
            <DropdownMenuItem onSelect={act.objectOps.applyTransform}>Rotation &amp; scale</DropdownMenuItem>
            <DropdownMenuItem onSelect={act.objectOps.applyModifiers}>All modifiers</DropdownMenuItem>
            <DropdownMenuItem onSelect={act.objectOps.makeEditable}>Make editable</DropdownMenuItem>
          </>
        )}
        {menu.kind === "delete" && (
          <>
            <DropdownMenuLabel>Delete</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => act.editOps.delete("vertices")}>Vertices</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.editOps.delete("edges")}>Edges</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.editOps.delete("faces")}>Faces</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.editOps.delete("onlyFaces")}>Only faces</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={act.editOps.dissolve}>Dissolve edges</DropdownMenuItem>
          </>
        )}
        {menu.kind === "merge" && editKind === "path" && (
          <>
            <DropdownMenuLabel>Merge points</DropdownMenuLabel>
            <DropdownMenuItem onSelect={act.pathOps.merge}>At center</DropdownMenuItem>
            <DropdownMenuItem onSelect={act.pathOps.mergeAtCursor}>At 3D cursor</DropdownMenuItem>
          </>
        )}
        {menu.kind === "merge" && editKind !== "path" && (
          <>
            <DropdownMenuLabel>Merge</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => act.editOps.merge("center")}>At center</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.editOps.merge("cursor")}>At cursor</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.editOps.merge("first")}>At first</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.editOps.merge("last")}>At last</DropdownMenuItem>
            <DropdownMenuItem onSelect={act.editOps.mergeByDistance}>By distance</DropdownMenuItem>
          </>
        )}
        {menu.kind === "mirror" && (
          <>
            <DropdownMenuLabel>Mirror</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => act.editOps.mirror(0)}>X <DropdownMenuShortcut>X</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.editOps.mirror(1)}>Y <DropdownMenuShortcut>Y</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.editOps.mirror(2)}>Z <DropdownMenuShortcut>Z</DropdownMenuShortcut></DropdownMenuItem>
          </>
        )}
        {menu.kind === "context" && !edit && <ObjectMenu act={act} />}
        {menu.kind === "context" && edit && editKind === "path" && <PathPointMenu act={act} />}
        {menu.kind === "context" && edit && editKind === "crop" && (
          <>
            <DropdownMenuLabel>Crop</DropdownMenuLabel>
            <DropdownMenuItem onSelect={act.cropOps.reset}>Reset crop</DropdownMenuItem>
          </>
        )}
        {menu.kind === "context" && edit && editKind === "mesh" && (
          <>
            <DropdownMenuLabel>{ui.elementMode === "vertex" ? "Vertex" : ui.elementMode === "edge" ? "Edge" : "Face"}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={act.ops.extrude}>Extrude <K id="world.extrude" /></DropdownMenuItem>
            {ui.elementMode === "face" && <DropdownMenuItem onSelect={act.ops.inset}>Inset faces <K id="world.inset" /></DropdownMenuItem>}
            <DropdownMenuItem onSelect={act.editOps.subdivide}>Subdivide</DropdownMenuItem>
            <DropdownMenuItem onSelect={act.editOps.bridge}>Bridge edge loops <K id="world.bridge" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={act.editOps.spin}>Spin around the view <K id="world.spin" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={act.editOps.fill}>Fill <K id="world.fill" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => requestAnimationFrame(() => act.openMenu("merge"))}>Merge… <K id="world.merge" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={act.editOps.duplicate}>Duplicate <K id="world.duplicate" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={act.editOps.separate}>Separate <K id="world.separate" /></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={act.editOps.newPart}>New part from faces</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.editOps.markStroke(true)}>Mark edges for stroke</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.editOps.markStroke(false)}>Clear stroke mark</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.editOps.markSharp(true)}>Mark sharp</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => act.editOps.markSharp(false)}>Clear sharp</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={act.editOps.flip}>Flip normals <K id="world.flipNormals" /></DropdownMenuItem>
            <DropdownMenuItem onSelect={act.editOps.recalc}>Recalculate outside <K id="world.recalcNormals" /></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => requestAnimationFrame(() => act.openMenu("delete"))} className="text-destructive">Delete… <K id="world.delete" /></DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

