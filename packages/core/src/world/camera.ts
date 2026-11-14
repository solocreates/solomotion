import type { CameraSpec } from "../schema/world";
import { cameraSpecSchema } from "../schema/world";
import { D2R, R2D, composeTrs, type Mat4 } from "./math";

/**
 * CAMERA MATHS — lens → field of view, the default camera, and the one
 * projection description every renderer and the viewport share.
 *
 * Sensor fit is Blender's AUTO: the sensor width applies to the frame's longer
 * side, so a 50 mm lens frames a landscape and a portrait reel alike.
 */

export interface Projection {
  type: "perspective" | "orthographic";
  /** Vertical / horizontal field of view in degrees (perspective). */
  fovY: number;
  fovX: number;
  aspect: number;
  near: number;
  far: number;
  /** Orthographic half extents in world units. */
  orthoHalfW: number;
  orthoHalfH: number;
  shiftX: number;
  shiftY: number;
}

/** Field of view (degrees) a lens gives across the sensor. */
export function lensFov(focalLength: number, sensorWidth: number): number {
  return 2 * Math.atan(sensorWidth / 2 / Math.max(0.01, focalLength)) * R2D;
}

/** Inverse: the lens that gives this FOV across the sensor (for "camera to view"). */
export function fovToLens(fovDeg: number, sensorWidth: number): number {
  return sensorWidth / 2 / Math.tan((fovDeg * D2R) / 2);
}

export function projectionOf(spec: CameraSpec, width: number, height: number): Projection {
  const aspect = width / Math.max(1, height);
  const fov = lensFov(spec.focalLength, spec.sensorWidth);
  let fovX: number, fovY: number;
  if (aspect >= 1) {
    fovX = fov;
    fovY = 2 * Math.atan(Math.tan((fov * D2R) / 2) / aspect) * R2D;
  } else {
    fovY = fov;
    fovX = 2 * Math.atan(Math.tan((fov * D2R) / 2) * aspect) * R2D;
  }
  const orthoHalfW = aspect >= 1 ? spec.orthoScale / 2 : (spec.orthoScale / 2) * aspect;
  return {
    type: spec.projection,
    fovX,
    fovY,
    aspect,
    near: spec.clipStart,
    far: Math.max(spec.clipStart + 1, spec.clipEnd),
    orthoHalfW,
    orthoHalfH: orthoHalfW / aspect,
    shiftX: spec.shiftX,
    shiftY: spec.shiftY,
  };
}

export const DEFAULT_CAMERA_SPEC: CameraSpec = cameraSpecSchema.parse({});

/**
 * THE DEFAULT CAMERA — what a world shows when no camera clip is live, and
 * what makes a flat comp a world seen from the front: a 50 mm lens looking
 * along +Y from the distance at which the comp's own rectangle, standing at
 * depth 0, exactly fills the frame. (After Effects' default camera, in
 * Blender's axes: distance = longer side × 50 / 36.)
 */
export function defaultCameraDistance(width: number, height: number, spec: CameraSpec = DEFAULT_CAMERA_SPEC): number {
  const fit = Math.max(width, height);
  return fit / 2 / Math.tan((lensFov(spec.focalLength, spec.sensorWidth) * D2R) / 2);
}

export function defaultCameraMatrix(width: number, height: number): Mat4 {
  return composeTrs({ position: [0, -defaultCameraDistance(width, height), 0], rotation: [90, 0, 0], scale: [1, 1, 1] });
}

/**
 * How many world units one frame pixel spans at `depth` in front of the
 * camera — the factor that makes "slide in 100 px" mean 100 px on screen for
 * an object anywhere in the world (layer animations, nudges).
 */
export function unitsPerPixel(proj: Projection, depth: number, frameWidth: number): number {
  if (proj.type === "orthographic") return (proj.orthoHalfW * 2) / Math.max(1, frameWidth);
  return (2 * Math.max(1e-3, depth) * Math.tan((proj.fovX * D2R) / 2)) / Math.max(1, frameWidth);
}
