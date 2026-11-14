import * as THREE from "three";
import { cameraPointsInWorld, type MotionDocument, type CameraTracker, type Frame, type VisualClip, type WorldEval } from "@solomotion/core";
import { planePicture } from "../plane-picture";

/**
 * A MATCH-MOVED WORLD'S GUIDES in the viewport — what a camera solve gives the
 * person placing things in the shot:
 *
 *   the solve's POINTS, a point cloud in the tracker's colour, the snap
 *   targets a grab lands on (`nearest`);
 *   the BACKPLATE behind the scene when looking through the camera, on a
 *   quad that rides the live camera and spans exactly its lens's frame —
 *   sized from the camera's own field of view, not the viewport's, which is
 *   widened for the passepartout.
 *
 * Guides only: neither is a layer, renders or exports. The board, nesting
 * and export draw the backplate through the flat painter (`draw-frame`).
 */

interface Cloud {
  key: string;
  points: THREE.Points;
  world: Float64Array;
}

/** The camera trackers whose solve drives a camera in this world. */
export function solvesInWorld(doc: MotionDocument, frameId: string): CameraTracker[] {
  const ids = new Set<string>();
  for (const track of doc.tracks) for (const c of track.clips) if (c.frameId === frameId && c.kind === "camera" && c.trackBinding?.enabled) ids.add(c.trackBinding.trackerId);
  return doc.trackers.filter((t): t is CameraTracker => t.kind === "camera" && ids.has(t.id) && !!t.solution);
}

export class SolveGuides {
  private clouds = new Map<string, Cloud>();
  readonly plateScene = new THREE.Scene();
  private plate: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  private plateTex: THREE.CanvasTexture | null = null;
  private plateKey = "";

  constructor(private readonly root: THREE.Object3D) {}

  /** Keep a point cloud per solve driving this world; show them with the overlays. */
  updatePoints(doc: MotionDocument, frameId: string, show: boolean): void {
    const live = new Set<string>();
    for (const t of solvesInWorld(doc, frameId)) {
      live.add(t.id);
      const key = `${t.solution!.error}|${t.solution!.points.length}|${JSON.stringify(t.scene)}|${t.color}`;
      let c = this.clouds.get(t.id);
      if (!c || c.key !== key) {
        if (c) this.dropCloud(t.id);
        const world = cameraPointsInWorld(t);
        const pos = new Float32Array(world.length);
        const col = new Float32Array(world.length);
        const tint = new THREE.Color(t.color);
        for (let i = 0; i < world.length; i += 3) {
          // World units: the overlay root carries the scene's ×UNIT.
          pos[i] = world[i]!;
          pos[i + 1] = world[i + 1]!;
          pos[i + 2] = world[i + 2]!;
          // The feature's own grey, lifted toward the tracker's colour so it reads on any plate.
          const g = 0.35 + 0.65 * ((t.solution!.pointLuma[i / 3] ?? 128) / 255);
          col[i] = tint.r * g;
          col[i + 1] = tint.g * g;
          col[i + 2] = tint.b * g;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
        const mat = new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 });
        const points = new THREE.Points(geo, mat);
        points.renderOrder = 10;
        points.frustumCulled = false;
        this.root.add(points);
        c = { key, points, world };
        this.clouds.set(t.id, c);
      }
      c.points.visible = show;
    }
    for (const id of [...this.clouds.keys()]) if (!live.has(id)) this.dropCloud(id);
  }

  private dropCloud(id: string): void {
    const c = this.clouds.get(id);
    if (!c) return;
    this.root.remove(c.points);
    c.points.geometry.dispose();
    (c.points.material as THREE.Material).dispose();
    this.clouds.delete(id);
  }

  /** The solve point nearest a screen position, within `radius` px — a grab's snap target. */
  nearest(toScreen: (p: [number, number, number]) => [number, number] | null, x: number, y: number, radius = 14): [number, number, number] | null {
    let best: [number, number, number] | null = null;
    let bestD = radius * radius;
    for (const c of this.clouds.values()) {
      if (!c.points.visible) continue;
      const w = c.world;
      for (let i = 0; i < w.length; i += 3) {
        const p: [number, number, number] = [w[i]!, w[i + 1]!, w[i + 2]!];
        const s = toScreen(p);
        if (!s) continue;
        const d = (s[0] - x) ** 2 + (s[1] - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
    }
    return best;
  }

  get hasPoints(): boolean {
    for (const c of this.clouds.values()) if (c.points.visible) return true;
    return false;
  }

  /**
   * The backplate behind the scene, seen through `camera` (the viewport's
   * camera, placed where the live camera is). False when there is none.
   */
  updatePlate(doc: MotionDocument, frame: Frame, timeMs: number, ev: WorldEval, camera: THREE.Camera): boolean {
    const plate = doc.tracks
      .flatMap((t) => (t.hidden ? [] : t.clips))
      .find((c): c is VisualClip => c.frameId === frame.id && "backplate" in c && !!c.backplate && !c.hidden);
    const pic = plate ? planePicture(doc, frame, plate, timeMs, 1) : null;
    if (!pic || ev.camera.projection.type !== "perspective") {
      if (this.plate) this.plate.visible = false;
      return false;
    }
    if (!this.plate) {
      this.plate = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false }));
      this.plate.matrixAutoUpdate = false;
      this.plate.frustumCulled = false;
      this.plateScene.add(this.plate);
    }
    if (!this.plateTex || this.plateTex.image !== pic.canvas) {
      this.plateTex?.dispose();
      this.plateTex = new THREE.CanvasTexture(pic.canvas);
      this.plateTex.colorSpace = THREE.SRGBColorSpace;
      this.plate.material.map = this.plateTex;
      this.plate.material.needsUpdate = true;
      this.plateKey = "";
    }
    if (pic.key !== this.plateKey) {
      this.plateTex.needsUpdate = true;
      this.plateKey = pic.key;
    }
    // A quad at depth d spanning the live lens's frame; the picture's rect (comp px about the plate's pivot) mapped onto it.
    const persp = camera as THREE.PerspectiveCamera;
    const d = Math.max(persp.near * 4, Math.min(persp.far * 0.5, 100));
    const halfH = d * Math.tan((ev.camera.projection.fovY * Math.PI) / 360);
    const perPx = (2 * halfH) / frame.height;
    const t = plate!.transform;
    const k = perPx * t.scale;
    const cx = (t.x + ((pic.minX + pic.maxX) / 2) * t.scale) * perPx;
    const cy = (t.y + ((pic.minY + pic.maxY) / 2) * t.scale) * perPx;
    const local = new THREE.Matrix4().compose(new THREE.Vector3(cx, -cy, -d), new THREE.Quaternion(), new THREE.Vector3((pic.maxX - pic.minX) * k, (pic.maxY - pic.minY) * (t.scaleY ?? t.scale) * perPx, 1));
    camera.updateMatrixWorld();
    this.plate.matrix.multiplyMatrices(camera.matrixWorld, local);
    this.plate.matrixWorld.copy(this.plate.matrix);
    this.plate.visible = true;
    return true;
  }

  dispose(): void {
    for (const id of [...this.clouds.keys()]) this.dropCloud(id);
    this.plateTex?.dispose();
    this.plate?.geometry.dispose();
    this.plate?.material.dispose();
  }
}
