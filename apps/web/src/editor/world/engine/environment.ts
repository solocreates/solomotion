import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { LightSpec } from "@solomotion/core";

/**
 * ENVIRONMENTS — the studio or sky that lights reflections and ambient.
 *
 * Procedural on purpose: no HDRI download stands between opening a world and
 * seeing it lit, and every preset is a few gradient stops and emitters that
 * look right with the PBR materials. A PMREM is tied to the renderer that made
 * it, so each renderer keeps its own (`envFor`).
 *
 * The scenes are built Y-up (RoomEnvironment's convention) and the world is
 * Z-up, so every environment is turned +90° about X when applied.
 */

type Preset = LightSpec["environment"];

interface Sky {
  top: string;
  horizon: string;
  bottom: string;
  /** Emitters: direction (Y-up), colour, strength, size. */
  lights: Array<{ dir: [number, number, number]; color: string; strength: number; size: number }>;
}

const SKIES: Record<Exclude<Preset, "studio">, Sky> = {
  soft: { top: "#ffffff", horizon: "#e2e5ea", bottom: "#7d8088", lights: [{ dir: [0.3, 1, 0.4], color: "#ffffff", strength: 3, size: 4 }] },
  sunset: { top: "#28335e", horizon: "#ff9452", bottom: "#2c2230", lights: [{ dir: [1, 0.12, 0.3], color: "#ffb36b", strength: 14, size: 1.2 }] },
  dawn: { top: "#8db6e9", horizon: "#ffd8b2", bottom: "#62656e", lights: [{ dir: [-0.8, 0.3, 0.5], color: "#fff0d8", strength: 8, size: 1.5 }] },
  night: { top: "#03050c", horizon: "#141c34", bottom: "#010103", lights: [{ dir: [0.4, 0.8, -0.3], color: "#bcd0ff", strength: 2.5, size: 0.8 }] },
  overcast: { top: "#c8cdd5", horizon: "#b0b5bd", bottom: "#5d6168", lights: [] },
};

function skyScene(sky: Sky): THREE.Scene {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(50, 48, 24);
  const top = new THREE.Color(sky.top), hor = new THREE.Color(sky.horizon), bot = new THREE.Color(sky.bottom);
  const pos = geo.attributes.position!;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 50;
    if (y >= 0) c.copy(hor).lerp(top, Math.pow(y, 0.6));
    else c.copy(hor).lerp(bot, Math.pow(-y, 0.5));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  for (const l of sky.lights) {
    const disc = new THREE.Mesh(
      new THREE.SphereGeometry(l.size, 16, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(l.color).multiplyScalar(l.strength) }),
    );
    disc.position.set(...l.dir).normalize().multiplyScalar(40);
    scene.add(disc);
  }
  return scene;
}

const perRenderer = new WeakMap<THREE.WebGLRenderer, Map<Preset, THREE.Texture>>();

export function envFor(renderer: THREE.WebGLRenderer, preset: Preset): THREE.Texture {
  let map = perRenderer.get(renderer);
  if (!map) perRenderer.set(renderer, (map = new Map()));
  let tex = map.get(preset);
  if (!tex) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const scene = preset === "studio" ? new RoomEnvironment() : skyScene(SKIES[preset]);
    tex = pmrem.fromScene(scene, 0.03).texture;
    pmrem.dispose();
    map.set(preset, tex);
  }
  return tex;
}

/** Y-up environment → Z-up world, then the light's own turn about Z. */
export function environmentRotation(zDegrees: number): THREE.Euler {
  const m = new THREE.Matrix4()
    .makeRotationZ((zDegrees * Math.PI) / 180)
    .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  return new THREE.Euler().setFromRotationMatrix(m);
}

/** A flat grey studio for Solid / Material preview shading (Blender's LookDev). */
export function lookdevEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  return envFor(renderer, "studio");
}
