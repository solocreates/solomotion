import * as THREE from "three";
import type { CameraClip, EmptyClip, LightClip, MeshData } from "@solomotion/core";
import { lensFov, meshEdges } from "@solomotion/core";

/**
 * VIEWPORT FURNITURE — the floor grid, the 3D cursor, camera and light
 * helpers, selection outlines. None of it is part of the world: it lives in
 * its own scene, drawn over the world with the world's depth, and never
 * reaches a render, an export or a model file.
 *
 * Colours are Blender's, because a person who knows Blender reads them without
 * a legend: X red, Y green, Z blue; the active object light orange, the rest of
 * the selection dark orange; unselected helpers near-black.
 */

export const AXIS_COLORS = { x: "#ff3352", y: "#8bdc00", z: "#2890ff" } as const;
export const ACTIVE = new THREE.Color("#ffaa40");
export const SELECTED = new THREE.Color("#f15800");
/** A drawing layer's sheet while Paint is armed: where the brush can land. */
export const SHEET = new THREE.Color(0x8a8f98);
export const IDLE = new THREE.Color("#0b0b0d");

// ── The grid ─────────────────────────────────────────────────────────────────

/**
 * An infinite floor grid (a shader on a large quad that follows the view):
 * minor lines fade out before they shimmer, major lines every `divisions`,
 * the X and Y axes in their colours, everything fading with distance. Works
 * in world units (cm) through a `unit` uniform so it reads like Blender's at
 * every zoom.
 */
export function makeGrid(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uCell: { value: 100 },
      uDiv: { value: 10 },
      uColor: { value: new THREE.Color("#ffffff") },
      uFade: { value: 5000 },
      uOpacity: { value: 0.16 },
      uAxisX: { value: new THREE.Color(AXIS_COLORS.x) },
      uAxisY: { value: new THREE.Color(AXIS_COLORS.y) },
      uPlane: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz * 100.0;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uCell; uniform float uDiv; uniform vec3 uColor; uniform float uFade;
      uniform float uOpacity; uniform vec3 uAxisX; uniform vec3 uAxisY; uniform int uPlane; uniform vec3 uCenter;
      varying vec3 vWorld;
      float gridLine(vec2 p, float size) {
        vec2 g = abs(fract(p / size - 0.5) - 0.5) / fwidth(p / size);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        vec2 p = uPlane == 0 ? vWorld.xy : (uPlane == 1 ? vWorld.xz : vWorld.yz);
        float minor = gridLine(p, uCell / uDiv);
        float major = gridLine(p, uCell);
        // Fade minor lines before they alias.
        vec2 d = fwidth(p);
        float lod = clamp(1.0 - max(d.x, d.y) / (uCell / uDiv) * 1.2, 0.0, 1.0);
        float a = max(major, minor * lod * 0.55) * uOpacity;
        vec3 col = uColor;
        vec2 ax = abs(p) / fwidth(p);
        if (uPlane == 0) {
          if (ax.y < 1.0) { col = uAxisX; a = 0.75; }
          if (ax.x < 1.0) { col = uAxisY; a = 0.75; }
        } else if (uPlane == 1) {
          if (ax.y < 1.0) { col = uAxisX; a = 0.75; }
        } else {
          if (ax.y < 1.0) { col = uAxisY; a = 0.75; }
        }
        float dist = length(vWorld - uCenter);
        a *= 1.0 - smoothstep(uFade * 0.35, uFade, dist);
        if (a < 0.003) discard;
        gl_FragColor = vec4(col, a);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function lines(points: number[], color: THREE.Color = IDLE): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points), 3));
  const m = new THREE.LineBasicMaterial({ color, depthTest: true, transparent: true, opacity: 0.95 });
  const l = new THREE.LineSegments(g, m);
  l.frustumCulled = false;
  return l;
}

function circle(r: number, axis: "x" | "y" | "z", n = 32, cx = 0, cy = 0, cz = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    for (const a of [a0, a1]) {
      const u = Math.cos(a) * r, v = Math.sin(a) * r;
      if (axis === "z") out.push(cx + u, cy + v, cz);
      else if (axis === "y") out.push(cx + u, cy, cz + v);
      else out.push(cx, cy + u, cz + v);
    }
  }
  return out;
}

/** A camera's frustum, Blender style: the pyramid, the frame and the "up" triangle. Local −Z forward, size in cm. */
export function cameraHelper(clip: Pick<CameraClip, "camera">, aspect: number, opts: { ghost?: boolean } = {}): THREE.LineSegments {
  const size = 100;
  const fov = lensFov(clip.camera.focalLength, clip.camera.sensorWidth) * (Math.PI / 180);
  const w = aspect >= 1 ? Math.tan(fov / 2) * size : Math.tan(fov / 2) * size * aspect;
  const h = w / aspect;
  const d = clip.camera.projection === "orthographic" ? size * 0.6 : size;
  const c = [[-w, -h, -d], [w, -h, -d], [w, h, -d], [-w, h, -d]];
  const pts: number[] = [];
  for (let i = 0; i < 4; i++) {
    pts.push(0, 0, 0, ...c[i]!);
    pts.push(...c[i]!, ...c[(i + 1) % 4]!);
  }
  pts.push(-w * 0.6, h * 1.1, -d, w * 0.6, h * 1.1, -d, w * 0.6, h * 1.1, -d, 0, h * 1.7, -d, 0, h * 1.7, -d, -w * 0.6, h * 1.1, -d);
  return opts.ghost ? dashed(pts, 9, 7) : lines(pts);
}

/**
 * Where a camera is looking: a dashed line from its lens to the point it aims
 * at, one unit long along local −Z (the caller scales it to the distance).
 */
export function aimHelper(): THREE.LineSegments {
  return dashed([0, 0, 0, 0, 0, -1], 0.012, 0.01);
}

function dashed(points: number[], dash: number, gap: number): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points), 3));
  const m = new THREE.LineDashedMaterial({ color: IDLE, dashSize: dash, gapSize: gap, depthTest: true, transparent: true, opacity: 0.8 });
  const l = new THREE.LineSegments(g, m);
  l.computeLineDistances();
  l.frustumCulled = false;
  return l;
}

/** A light's glyph: its reach and direction, in cm, local −Z forward. */
export function lightHelper(clip: LightClip): THREE.LineSegments {
  const l = clip.light;
  const pts: number[] = [];
  const r = 18;
  if (l.type === "point") {
    pts.push(...circle(r, "x", 20), ...circle(r, "y", 20), ...circle(r, "z", 20));
  } else if (l.type === "sun") {
    pts.push(...circle(r, "z", 24));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pts.push(Math.cos(a) * r * 1.4, Math.sin(a) * r * 1.4, 0, Math.cos(a) * r * 2.2, Math.sin(a) * r * 2.2, 0);
    }
    pts.push(0, 0, 0, 0, 0, -400);
  } else if (l.type === "spot") {
    const len = 150;
    const rad = Math.tan(((l.spotAngle / 2) * Math.PI) / 180) * len;
    pts.push(...circle(rad, "z", 32, 0, 0, -len));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      pts.push(0, 0, 0, Math.cos(a) * rad, Math.sin(a) * rad, -len);
    }
  } else if (l.type === "area") {
    const w = l.width / 2, h = l.height / 2;
    pts.push(-w, -h, 0, w, -h, 0, w, -h, 0, w, h, 0, w, h, 0, -w, h, 0, -w, h, 0, -w, -h, 0, 0, 0, 0, 0, 0, -120);
  } else if (l.type === "environment") {
    pts.push(...circle(r * 1.6, "x", 28), ...circle(r * 1.6, "y", 28), ...circle(r * 1.6, "z", 28));
  } else {
    pts.push(...circle(r * 1.5, "z", 28));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      pts.push(Math.cos(a) * r * 1.5, Math.sin(a) * r * 1.5, 0, 0, 0, r * 1.5);
    }
  }
  return lines(pts);
}

/**
 * THE PAGE a stroke will land on, shown while drawing (Blender's canvas
 * grid): a square grid in local X–Y, ±1, fading out from its centre so it
 * reads as "this plane, here" without a hard edge. Placed by matrix — the
 * page's right, up and anchor — and scaled to the view.
 */
export function pageHelper(cells = 16): THREE.LineSegments {
  const pts: number[] = [];
  for (let i = 0; i <= cells; i++) {
    const t = (i / cells) * 2 - 1;
    pts.push(t, -1, 0, t, 1, 0, -1, t, 0, 1, t, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
  const m = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    transparent: true,
    uniforms: { uColor: { value: new THREE.Color("#8ab4ff") } },
    vertexShader: "varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader:
      "uniform vec3 uColor; varying vec2 vP; void main(){ float r = length(vP); float a = 0.6 * (1.0 - smoothstep(0.25, 1.0, r)); if (a < 0.01) discard; gl_FragColor = vec4(uColor, a); }",
  });
  const l = new THREE.LineSegments(g, m);
  l.frustumCulled = false;
  l.matrixAutoUpdate = false;
  l.renderOrder = 5;
  return l;
}

/** The 3D cursor: Blender's red-and-white ring with crosshair ticks. */
export function cursorHelper(): THREE.Group {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.75, 32),
    new THREE.ShaderMaterial({
      depthTest: false,
      transparent: true,
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader:
        "varying vec2 vUv; void main(){ float a = atan(vUv.y-0.5, vUv.x-0.5); float s = step(0.0, sin(a*4.0)); gl_FragColor = vec4(mix(vec3(1.0), vec3(1.0,0.2,0.25), s), 1.0); }",
    }),
  );
  g.add(ring);
  const ticks = lines([-1.4, 0, 0, -0.85, 0, 0, 1.4, 0, 0, 0.85, 0, 0, 0, -1.4, 0, 0, -0.85, 0, 0, 1.4, 0, 0, 0.85, 0], new THREE.Color("#111"));
  (ticks.material as THREE.LineBasicMaterial).depthTest = false;
  g.add(ticks);
  g.renderOrder = 10;
  return g;
}

// ── Outlines ─────────────────────────────────────────────────────────────────

/**
 * A screen-space silhouette outline: the object's back faces pushed out along
 * smooth normals by a fixed number of PIXELS, drawn behind it — so the line
 * is the same weight at any zoom, only shows where the object meets what is
 * behind it, and costs one extra draw of geometry already on the GPU.
 */
export function outlineMaterial(color: THREE.Color, px: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uColor: { value: color.clone() }, uPx: { value: px }, uRes: { value: new THREE.Vector2(1, 1) } },
    vertexShader: /* glsl */ `
      attribute vec3 smoothNormal;
      uniform float uPx; uniform vec2 uRes;
      void main() {
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * smoothNormal);
        vec2 dir = normalize((projectionMatrix * vec4(n, 0.0)).xy + 1e-6);
        clip.xy += dir * uPx * 2.0 / uRes * clip.w;
        gl_Position = clip;
      }
    `,
    fragmentShader: "uniform vec3 uColor; void main(){ gl_FragColor = vec4(uColor, 1.0); }",
  });
}

/**
 * A PICTURE'S OUTLINE — the selection ring around what a plane actually
 * draws, read from its own alpha: a fragment is ring where the picture is
 * clear but has ink within `uPx` screen pixels (screen-sized through the
 * texture's own derivatives, so the ring is as thin far away as near).
 *
 * A plane's card is a rectangle of mostly nothing. Outlining the card drew an
 * orange box around every selected stroke — a rectangle with "weird big
 * strokes" round each line you drew, which is what it looked like and what it
 * was. The ring now hugs the ink, as the flat canvas's selection does.
 */
export function pictureOutlineMaterial(map: THREE.Texture, color: THREE.Color, px: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Coplanar with the picture it rings: drawn a hair in front of it.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    uniforms: { map: { value: map }, uColor: { value: color.clone() }, uPx: { value: px } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map; uniform vec3 uColor; uniform float uPx;
      varying vec2 vUv;
      void main() {
        vec2 d = fwidth(vUv) * uPx;
        float self = texture2D(map, vUv).a;
        float near = 0.0;
        for (int i = 0; i < 12; i++) {
          float t = float(i) * 0.5235988;
          near = max(near, texture2D(map, vUv + vec2(cos(t), sin(t)) * d).a);
        }
        float ring = clamp((near - self) * 1.5, 0.0, 1.0);
        if (ring < 0.15) discard;
        gl_FragColor = vec4(uColor, ring);
      }
    `,
  });
}

/** Normals averaged per position, so a hull pushed along them never cracks at a hard edge. */
export function ensureSmoothNormals(geo: THREE.BufferGeometry): void {
  if (geo.getAttribute("smoothNormal")) return;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const nor = geo.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const acc = new Map<string, [number, number, number]>();
  const key = (i: number) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    const a = acc.get(k) ?? [0, 0, 0];
    if (nor) {
      a[0] += nor.getX(i);
      a[1] += nor.getY(i);
      a[2] += nor.getZ(i);
    }
    acc.set(k, a);
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const a = acc.get(key(i))!;
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    out.set([a[0] / l, a[1] / l, a[2] / l], i * 3);
  }
  geo.setAttribute("smoothNormal", new THREE.BufferAttribute(out, 3));
}

/** A controller's helper: its axes, a cube, a sphere or arrows, at its size. */
/** A lattice cage as it stands: every grid edge (its loose lines), in its own space. */
export function latticeHelper(mesh: MeshData): THREE.LineSegments {
  const P = mesh.positions;
  const pts: number[] = [];
  for (const e of meshEdges(mesh).list) pts.push(P[e.a * 3]!, P[e.a * 3 + 1]!, P[e.a * 3 + 2]!, P[e.b * 3]!, P[e.b * 3 + 1]!, P[e.b * 3 + 2]!);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: IDLE }));
}

export function emptyHelper(clip: EmptyClip): THREE.LineSegments {
  const r = clip.size / 2;
  const pts: number[] = [];
  if (clip.display === "cube") {
    const c = [-r, r];
    for (const a of c) for (const b of c) {
      pts.push(-r, a, b, r, a, b, a, -r, b, a, r, b, a, b, -r, a, b, r);
    }
  } else if (clip.display === "sphere") {
    pts.push(...circle(r, "x", 32), ...circle(r, "y", 32), ...circle(r, "z", 32));
  } else {
    pts.push(-r, 0, 0, r, 0, 0, 0, -r, 0, 0, r, 0, 0, 0, -r, 0, 0, r);
    if (clip.display === "arrows") {
      const h = r * 0.18;
      pts.push(r, 0, 0, r - h, h, 0, r, 0, 0, r - h, -h, 0, 0, r, 0, h, r - h, 0, 0, r, 0, -h, r - h, 0, 0, 0, r, h, 0, r - h, 0, 0, r, -h, 0, r - h);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: IDLE }));
}
