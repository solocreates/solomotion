import * as THREE from "three";
import { createRenderer } from "./gpu";
import {
  evaluateWorld,
  layerMaterial,
  modifierScene,
  type Material,
  type MeshData,
  type MotionDocument,
  type CameraEval,
  type Frame,
  type ShadingMode,
  type WorldSpec,
} from "@solomotion/core";
import { makeColorResolver } from "../../stage/render/paint-style";
import { SceneSync, UNIT, bodySideColor, cameraMatrixToThree, transparentSort } from "./sync";
import { layerBody } from "./body";
import { planePicture } from "../plane-picture";
import { envFor, environmentRotation, lookdevEnv } from "./environment";
import { exportWorldModel, importModelFile, type ExportFormat, type ExportModelOptions, type ImportedModel } from "./io";
import { loadModelTemplate } from "./models";
import { PostStack, ShutterAccumulator, postLookOf } from "./post";

/**
 * THE WORLD ENGINE — the lazy chunk's public face. Everything here may import
 * three.js; nothing outside `world/engine` and `world/viewport` may, and the
 * rest of the app reaches this only through `world/loader.ts`.
 */

export interface PictureRequest {
  doc: MotionDocument;
  frame: Frame;
  timeMs: number;
  /** Output size in device pixels. */
  width: number;
  height: number;
  /** Picture px per layer px for 2D planes. */
  density?: number;
  /** Leave these objects out (they are drawn on their own, with their effects). */
  hide?: readonly string[];
  /** Draw ONLY this object — everything else still hides it where it is in front. */
  only?: string;
  /** Motion blur: the instants across the open shutter (comp ms) and their weights (summing to 1). */
  shutter?: ReadonlyArray<{ timeMs: number; weight: number }>;
}

export interface WorldEngine {
  /** A world's picture through its live camera — the board, nesting, posters and export. */
  renderPicture(req: PictureRequest): HTMLCanvasElement | null;
  /** A scene sync for an interactive viewport. */
  createSync(): SceneSync;
  /** Configure a renderer for a sync and shading mode (tone, shadows, environment). */
  prepare(renderer: THREE.WebGLRenderer, sync: SceneSync, spec: WorldSpec, shading: ShadingMode): void;
  /** A three.js camera for a camera eval at an aspect. */
  cameraFor(cam: CameraEval, aspect: number, target?: THREE.Camera): THREE.Camera;
  importModel(file: File): Promise<ImportedModel>;
  /** Parse every imported model a document's worlds use (export calls this first). */
  preloadModels(doc: MotionDocument): Promise<void>;
  exportModel(doc: MotionDocument, frame: Frame, timeMs: number, format: ExportFormat, opts?: ExportModelOptions): Promise<Blob>;
  /** A layer's body as the scene shows it now (modifiers, scene and picture included) — what Convert to mesh keeps. */
  bakeBody(doc: MotionDocument, frame: Frame, clipId: string, timeMs: number): BakedBody | null;
}

export interface BakedBody {
  mesh: MeshData;
  rect: { minX: number; minY: number; maxX: number; maxY: number };
  sideColor: string | null;
  material: Material;
}

let renderer: THREE.WebGLRenderer | null = null;
/**
 * The ONE renderer every world picture goes through. When the GPU drops its
 * context (memory pressure: many worlds, big frames), we ask the browser to
 * RESTORE it and keep this renderer — three re-uploads everything on restore.
 * Throwing it away and making a fresh context each time is what gets WebGL
 * blocked for the page ("Error creating WebGL context"), after which every
 * world rendered empty until a reload.
 */
function pictureRenderer(): THREE.WebGLRenderer | null {
  if (renderer) return renderer;
  const r = createRenderer({ antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
  if (!r) return null;
  r.setPixelRatio(1);
  r.shadowMap.type = THREE.PCFShadowMap;
  r.setTransparentSort(transparentSort as never);
  r.domElement.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    // What the GPU held is gone: drop the cached scenes so they rebuild lean on restore.
    for (const s of syncs.values()) s.sync.dispose();
    syncs.clear();
  });
  renderer = r;
  return r;
}

/** What one shutter instant cost to render in each world (ms) — the next frame's sample plan. */
const sampleCostMs = new Map<string, number>();
/** A frame's motion blur may spend about this long on its instants. */
const SHUTTER_BUDGET_MS = 700;

/** `n` instants spread evenly across the shutter, their weights summing to 1 again. */
function evenly<T extends { weight: number }>(all: readonly T[], n: number): T[] {
  const picked = Array.from({ length: n }, (_, i) => all[Math.min(all.length - 1, Math.round(((i + 0.5) * all.length) / n - 0.5))]!);
  const total = picked.reduce((a, p) => a + p.weight, 0) || 1;
  return picked.map((p) => ({ ...p, weight: p.weight / total }));
}

const syncs = new Map<string, { sync: SceneSync; last: number }>();
let syncTick = 0;

/**
 * A DELETED WORLD LETS GO AT ONCE. Its scene — geometry, materials, its sun's
 * shadow map — sat on the GPU until four newer worlds pushed it out, so an
 * agent rebuilding a film (delete + recreate, new ids each time) kept every
 * world it ever made. Checked once per document, against at most four ids.
 */
let prunedFor: MotionDocument | null = null;
function pruneSyncs(doc: MotionDocument): void {
  if (doc === prunedFor) return;
  prunedFor = doc;
  for (const [id, s] of syncs) {
    if (doc.frames.some((f) => f.id === id)) continue;
    s.sync.dispose();
    syncs.delete(id);
    sampleCostMs.delete(id);
  }
}

function pictureSync(frameId: string): SceneSync {
  let s = syncs.get(frameId);
  if (!s) {
    s = { sync: new SceneSync(), last: 0 };
    syncs.set(frameId, s);
    // Each cached world holds its geometry and textures on the GPU; a film of many
    // worlds rendered at 1920² exhausted it at 8. Keep the four most recent.
    if (syncs.size > 4) {
      const oldest = [...syncs.entries()].sort((a, b) => a[1].last - b[1].last)[0]!;
      oldest[1].sync.dispose();
      syncs.delete(oldest[0]);
    }
  }
  s.last = ++syncTick;
  return s.sync;
}

const TONE: Record<WorldSpec["render"]["toneMapping"], THREE.ToneMapping> = {
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
  none: THREE.NoToneMapping,
};
const SHADOW_SIZE = { low: 512, medium: 1024, high: 2048 } as const;

function prepare(r: THREE.WebGLRenderer, sync: SceneSync, spec: WorldSpec, shading: ShadingMode): void {
  r.toneMapping = TONE[spec.render.toneMapping];
  r.toneMappingExposure = Math.pow(2, spec.render.exposure);
  const rendered = shading === "rendered";
  r.shadowMap.enabled = rendered && spec.render.shadows;
  const size = SHADOW_SIZE[spec.render.shadowQuality];
  sync.scene.traverse((o) => {
    const l = o as THREE.Light & { shadow?: THREE.LightShadow };
    if (l.isLight && l.shadow && l.shadow.mapSize.x !== size) {
      l.shadow.mapSize.set(size, size);
      l.shadow.map?.dispose();
      l.shadow.map = null;
    }
  });
  const env = sync.environment;
  if (rendered) {
    sync.scene.environment = env ? envFor(r, env.preset) : null;
    sync.scene.environmentIntensity = env?.intensity ?? 0;
    const rot = environmentRotation(env?.rotationZ ?? 0);
    sync.scene.environmentRotation.copy(rot);
    sync.scene.background = env?.showBackground ? envFor(r, env.preset) : null;
    sync.scene.backgroundRotation.copy(rot);
    sync.scene.backgroundIntensity = env?.intensity ?? 1;
  } else {
    // Solid and Material preview: a fixed studio, scene lights off (Blender's LookDev).
    sync.scene.environment = lookdevEnv(r);
    sync.scene.environmentIntensity = shading === "material" ? 1 : 0.9;
    sync.scene.environmentRotation.copy(environmentRotation(0));
    sync.scene.background = null;
  }
}

function cameraFor(cam: CameraEval, aspect: number, target?: THREE.Camera): THREE.Camera {
  const p = cam.projection;
  let c: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  if (p.type === "orthographic") {
    const o = target instanceof THREE.OrthographicCamera ? target : new THREE.OrthographicCamera();
    const halfW = p.orthoHalfW * UNIT;
    const halfH = halfW / aspect;
    o.left = -halfW;
    o.right = halfW;
    o.top = halfH;
    o.bottom = -halfH;
    o.near = p.near * UNIT;
    o.far = p.far * UNIT;
    c = o;
  } else {
    const pc = target instanceof THREE.PerspectiveCamera ? target : new THREE.PerspectiveCamera();
    pc.fov = p.fovY;
    pc.aspect = aspect;
    pc.near = Math.max(1e-4, p.near * UNIT);
    pc.far = p.far * UNIT;
    c = pc;
  }
  c.updateProjectionMatrix();
  // Lens shift (Blender): a fraction of the longer side, applied in clip space.
  if (p.shiftX || p.shiftY) {
    const e = c.projectionMatrix.elements;
    const sx = 2 * p.shiftX * (aspect >= 1 ? 1 : 1 / aspect);
    const sy = 2 * p.shiftY * (aspect >= 1 ? aspect : 1);
    if (p.type === "perspective") {
      e[8] += sx;
      e[9] += sy;
    } else {
      e[12] -= sx;
      e[13] -= sy;
    }
    c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
  }
  cameraMatrixToThree(cam.matrix, c);
  return c;
}

let maxSide = 4096;

function renderPicture(req: PictureRequest): HTMLCanvasElement | null {
  const r = pictureRenderer();
  // No GPU, or mid-restore: "not ready" (callers retry), never an empty picture that gets cached or exported.
  if (!r || r.getContext().isContextLost()) return null;
  maxSide = Math.min(8192, r.capabilities.maxTextureSize || 4096);
  const w = Math.max(1, Math.min(maxSide, Math.round(req.width)));
  const h = Math.max(1, Math.min(maxSide, Math.round(req.height)));
  const ev = evaluateWorld(req.doc, req.frame, req.timeMs);
  pruneSyncs(req.doc);
  const sync = pictureSync(req.frame.id);
  sync.sync(ev, {
    doc: req.doc,
    frame: req.frame,
    shading: "rendered",
    resolve: makeColorResolver(req.doc),
    density: req.density ?? 2,
  });
  // Planes render their 2D pictures during the sync, which can re-enter this
  // renderer (a world inside a world) — so size and draw only AFTER it.
  if (r.domElement.width !== w || r.domElement.height !== h) r.setSize(w, h, false);
  prepare(r, sync, ev.spec, "rendered");
  const cam = cameraFor(ev.camera, w / h);
  sync.updateLines(cam, new THREE.Vector2(w, h), w / req.frame.width);
  r.setClearColor(0x000000, 0);
  r.clear();
  const hidden: THREE.Object3D[] = [];
  const hide = (o: THREE.Object3D) => {
    if (o.visible) (o.visible = false), hidden.push(o);
  };
  if (req.only) {
    // Pass 1: everything else writes depth only, so it still occludes.
    const target = sync.entries.get(req.only);
    if (target) hide(target.holder);
    sync.scene.overrideMaterial = DEPTH_ONLY;
    r.render(sync.scene, cam);
    sync.scene.overrideMaterial = null;
    for (const o of hidden.splice(0)) o.visible = true;
    // Pass 2: the object alone, lit as it is in the scene, over that depth.
    for (const e of sync.entries.values()) if (e.id !== req.only && e.kind !== "light") hide(e.holder);
    const auto = r.autoClear;
    r.autoClear = false;
    r.render(sync.scene, cam);
    r.autoClear = auto;
  } else {
    for (const id of req.hide ?? []) {
      const e = sync.entries.get(id);
      if (e) hide(e.holder);
    }
    const shutter = req.shutter?.filter((s) => s.weight > 0) ?? [];
    if (shutter.length > 1) {
      // MOTION BLUR: the finished shot at each instant across the shutter,
      // averaged by weight (each instant synced fresh — moving objects,
      // a moving camera, animated pictures all smear as they move).
      if (accumulator?.renderer !== r) (accumulator?.dispose(), (accumulator = new ShutterAccumulator(r)));
      accumulator!.begin();
      // A TIME BUDGET for the shutter: each instant is a full render, and a
      // heavy world (hundreds of particles, bloom, 1920²) asked for 24 of them
      // per frame — one frame took minutes and the machine ran out of memory.
      // Plan from what an instant cost last time in this world.
      const est = sampleCostMs.get(req.frame.id);
      // An export-sized shutter (more than a preview's 4) earns more time — still bounded.
      const budget = shutter.length > 4 ? SHUTTER_BUDGET_MS * 3.5 : SHUTTER_BUDGET_MS;
      const fit = est ? Math.max(2, Math.floor(budget / Math.max(1, est))) : 4;
      const plan = fit < shutter.length ? evenly(shutter, fit) : shutter;
      const t0 = performance.now();
      for (const smp of plan) {
        // Who is in the shot is the frame's own instant; each instant poses them held inside their spans.
        const evS = evaluateWorld(req.doc, req.frame, smp.timeMs, { aliveAt: req.timeMs });
        sync.sync(evS, { doc: req.doc, frame: req.frame, shading: "rendered", resolve: makeColorResolver(req.doc), density: req.density ?? 2 });
        for (const id of req.hide ?? []) {
          const e = sync.entries.get(id);
          if (e && e.holder.visible) hide(e.holder);
        }
        prepare(r, sync, evS.spec, "rendered");
        const camS = cameraFor(evS.camera, w / h);
        sync.updateLines(camS, new THREE.Vector2(w, h), w / req.frame.width);
        r.setClearColor(0x000000, 0);
        r.clear();
        sync.renderMirror(r, camS);
        renderOver(r, sync.scene, camS);
        accumulator!.addCanvas(smp.weight);
      }
      sampleCostMs.set(req.frame.id, (performance.now() - t0) / plan.length);
      accumulator!.present();
    } else {
      sync.renderMirror(r, cam);
      renderOver(r, sync.scene, cam);
    }
    // The camera's lens and the world's bloom — what the board and export show.
    const look = postLookOf(ev);
    if (look) {
      if (post?.renderer !== r) (post?.dispose(), (post = new PostStack(r)));
      post!.apply(sync.scene, cam, look);
    }
  }
  for (const o of hidden) o.visible = true;
  return r.domElement;
}

const DEPTH_ONLY = new THREE.MeshBasicMaterial({ colorWrite: false });

/** Render without clearing what is already drawn (a mirror's reflection under it). */
function renderOver(r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera): void {
  const auto = r.autoClear;
  r.autoClear = false;
  r.render(scene, cam);
  r.autoClear = auto;
}
let post: PostStack | null = null;
let accumulator: ShutterAccumulator | null = null;

export function createWorldEngine(): WorldEngine {
  return {
    renderPicture,
    createSync: () => new SceneSync(),
    prepare,
    cameraFor,
    importModel: importModelFile,
    preloadModels: async (doc) => {
      const ids = new Set<string>();
      for (const t of doc.tracks) for (const c of t.clips) if (c.kind === "mesh" && c.geometry.type === "asset") ids.add(c.geometry.assetId);
      await Promise.all([...ids].map((id) => loadModelTemplate(id)));
    },
    exportModel: exportWorldModel,
    bakeBody: (doc, frame, clipId, timeMs) => {
      const ev = evaluateWorld(doc, frame, timeMs);
      const o = ev.objects.find((x) => x.id === clipId);
      if (!o || o.kind !== "plane") return null;
      const pic = planePicture(doc, frame, o.source, timeMs, 2);
      if (!pic) return null;
      const body = layerBody(doc, frame, o, pic, { scene: modifierScene(doc, frame, ev, o), skin: o.skin });
      if (!body) return null;
      return {
        mesh: body.mesh,
        rect: { minX: pic.minX, minY: pic.minY, maxX: pic.maxX, maxY: pic.maxY },
        sideColor: bodySideColor(o.clip, makeColorResolver(doc)),
        material: layerMaterial(o.clip),
      };
    },
  };
}

export type { SceneSync, ExportFormat, ExportModelOptions };
export { UNIT };
