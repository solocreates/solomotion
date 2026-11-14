import * as THREE from "three";
import type { V3 } from "@solomotion/core";
import { UNIT } from "../engine/sync";

/**
 * THE VIEW — Blender's turntable camera, in the world's units (cm).
 *
 * The view is a target, a distance and two angles (yaw about Z, pitch above
 * the horizon), so orbiting can never roll the horizon and "front", "right" and
 * "top" are exact angles rather than accumulated rotations. Orthographic is the
 * same view with the distance turned into a size.
 */

export interface ViewState {
  target: V3;
  distance: number;
  yaw: number;
  pitch: number;
  ortho: boolean;
  /** Vertical field of view of the viewport lens (Blender's 50 mm viewport ≈ 39.6° on 36 mm). */
  fov: number;
}

export const DEFAULT_VIEW: ViewState = { target: [0, 0, 0], distance: 1500, yaw: 35, pitch: 25, ortho: false, fov: 30 };

const D2R = Math.PI / 180;

/** Eye position for a view (cm). Yaw 0 looks along +Y (Blender's front). */
export function eyeOf(v: ViewState): V3 {
  const cp = Math.cos(v.pitch * D2R);
  const dir: V3 = [Math.sin(v.yaw * D2R) * cp, -Math.cos(v.yaw * D2R) * cp, Math.sin(v.pitch * D2R)];
  return [v.target[0] + dir[0] * v.distance, v.target[1] + dir[1] * v.distance, v.target[2] + dir[2] * v.distance];
}

/** Configure a three camera (metres) for a view at an aspect. */
export function applyView(v: ViewState, aspect: number, persp: THREE.PerspectiveCamera, ortho: THREE.OrthographicCamera): THREE.Camera {
  const eye = eyeOf(v);
  const cam: THREE.Camera = v.ortho ? ortho : persp;
  cam.up.set(0, 0, 1);
  cam.position.set(eye[0] * UNIT, eye[1] * UNIT, eye[2] * UNIT);
  // Straight up/down: keep yaw as the "up" on screen so top view never spins.
  if (Math.abs(v.pitch) > 89.9) cam.up.set(Math.sin(v.yaw * D2R) * -Math.sign(v.pitch), Math.cos(v.yaw * D2R) * Math.sign(v.pitch), 0);
  cam.lookAt(v.target[0] * UNIT, v.target[1] * UNIT, v.target[2] * UNIT);
  cam.matrixAutoUpdate = true;
  cam.updateMatrixWorld(true);
  const near = Math.max(0.001, v.distance * UNIT * 0.002);
  const far = Math.max(2000, v.distance * UNIT * 200);
  if (v.ortho) {
    const halfH = (v.distance * UNIT * Math.tan((v.fov * D2R) / 2));
    ortho.left = -halfH * aspect;
    ortho.right = halfH * aspect;
    ortho.top = halfH;
    ortho.bottom = -halfH;
    ortho.near = -far;
    ortho.far = far;
    ortho.updateProjectionMatrix();
  } else {
    persp.fov = v.fov;
    persp.aspect = aspect;
    persp.near = near;
    persp.far = far;
    persp.updateProjectionMatrix();
  }
  return cam;
}

/** Numpad views. `opposite` is Ctrl (back, left, bottom). */
export function axisView(v: ViewState, key: "front" | "right" | "top", opposite: boolean): ViewState {
  if (key === "front") return { ...v, yaw: opposite ? 180 : 0, pitch: 0, ortho: true };
  if (key === "right") return { ...v, yaw: opposite ? -90 : 90, pitch: 0, ortho: true };
  return { ...v, yaw: 0, pitch: opposite ? -90 : 90, ortho: true };
}

/** Orbit by a screen drag (Blender: 0.4° per px feels right on a mouse). */
export function orbit(v: ViewState, dx: number, dy: number, autoPerspective = true): ViewState {
  const pitch = Math.max(-90, Math.min(90, v.pitch + dy * 0.35));
  // Auto perspective (Blender's default): leaving an axis view by orbiting goes back to perspective.
  return { ...v, yaw: v.yaw - dx * 0.35, pitch, ortho: autoPerspective ? false : v.ortho };
}

/** The view's screen axes in world space: right, up and forward (eye → target). */
export function viewBasis(v: ViewState): { right: V3; up: V3; forward: V3 } {
  const cp = Math.cos(v.pitch * D2R), sp = Math.sin(v.pitch * D2R);
  const sy = Math.sin(v.yaw * D2R), cy = Math.cos(v.yaw * D2R);
  const forward: V3 = [-sy * cp, cy * cp, -sp];
  const right: V3 = [cy, sy, 0];
  // up = right × forward
  const up: V3 = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  return { right, up, forward };
}

/** Pan the target by a screen delta, so the point at the target's depth tracks the cursor 1:1. */
export function pan(v: ViewState, dx: number, dy: number, viewportHeight: number): ViewState {
  const k = (2 * v.distance * Math.tan((v.fov * D2R) / 2)) / Math.max(1, viewportHeight);
  const { right, up } = viewBasis(v);
  return {
    ...v,
    target: [
      v.target[0] - right[0] * dx * k + up[0] * dy * k,
      v.target[1] - right[1] * dx * k + up[1] * dy * k,
      v.target[2] - right[2] * dx * k + up[2] * dy * k,
    ],
  };
}

/** Dolly toward the target (or toward a point under the cursor). */
export function zoom(v: ViewState, factor: number, toward?: V3): ViewState {
  const d = Math.max(1, Math.min(1e7, v.distance * factor));
  if (!toward) return { ...v, distance: d };
  // Move the target a matching fraction toward the point, so it stays put on screen.
  const t = 1 - factor;
  return {
    ...v,
    distance: d,
    target: [v.target[0] + (toward[0] - v.target[0]) * t, v.target[1] + (toward[1] - v.target[1]) * t, v.target[2] + (toward[2] - v.target[2]) * t],
  };
}

/** Frame a bounding box (View Selected / View All). */
export function frameBox(v: ViewState, min: V3, max: V3, aspect: number): ViewState {
  const c: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const r = Math.max(10, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  const fit = Math.min(v.fov, 2 * Math.atan(Math.tan((v.fov * D2R) / 2) * aspect) / D2R);
  const d = (r / Math.sin((fit * D2R) / 2)) * 1.08;
  return { ...v, target: c, distance: d };
}

/** Smoothly interpolate two views (angles take the short way round). */
export function lerpView(a: ViewState, b: ViewState, t: number): ViewState {
  let dy = b.yaw - a.yaw;
  while (dy > 180) dy -= 360;
  while (dy < -180) dy += 360;
  const e = t * t * (3 - 2 * t);
  return {
    target: [a.target[0] + (b.target[0] - a.target[0]) * e, a.target[1] + (b.target[1] - a.target[1]) * e, a.target[2] + (b.target[2] - a.target[2]) * e],
    distance: a.distance * Math.pow(b.distance / a.distance, e),
    yaw: a.yaw + dy * e,
    pitch: a.pitch + (b.pitch - a.pitch) * e,
    ortho: t < 1 ? b.ortho && a.ortho : b.ortho,
    fov: a.fov + (b.fov - a.fov) * e,
  };
}

/** The view's label, Blender's way ("User Perspective", "Front Orthographic"…). */
export function viewLabel(v: ViewState): string {
  const kind = v.ortho ? "Orthographic" : "Perspective";
  const yaw = ((v.yaw % 360) + 360) % 360;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  if (v.ortho) {
    if (near(v.pitch, 90)) return `Top ${kind}`;
    if (near(v.pitch, -90)) return `Bottom ${kind}`;
    if (near(v.pitch, 0)) {
      if (near(yaw, 0)) return `Front ${kind}`;
      if (near(yaw, 180)) return `Back ${kind}`;
      if (near(yaw, 90)) return `Right ${kind}`;
      if (near(yaw, 270)) return `Left ${kind}`;
    }
  }
  return `User ${kind}`;
}
