import type * as THREE from "three";
import {
  VECTOR_BODY_KINDS,
  bevelledCard,
  bodyIsRevolved,
  bodyIsTube,
  pathPolyline,
  profileMesh,
  strokeTube,
  tubeStroke,
  type StackEnv,
  type PictureSampler,
  type Clip,
  depthForClip,
  nearnessAt,
  bodyFit,
  bodyThickness,
  bodyThroughStack,
  cardMesh,
  layerModifiers,
  type MotionDocument,
  type Frame,
  type MeshData,
  type PathCommand,
  type WorldObject,
} from "@solomotion/core";
import type { PlanePicture } from "../plane-picture";
import { extrudeSource, extrudedGeometry } from "./extrude";

/**
 * A LAYER'S BODY, BUILT. Core (`world/body.ts`) decides what a 2D layer is
 * made of in a world and runs its modifier stack; this supplies the two things
 * only a browser has — a font's glyph outlines and a picture's silhouette —
 * and hands the scene one mesh, whatever the layer was.
 *
 *   flat                → the picture's card
 *   thick, fit `box`    → a bevelled slab the size of the picture
 *   thick, fit `outline`→ the real outline extruded: glyphs, a shape's contour,
 *                         or the silhouette traced from the picture's alpha
 *
 * Then the layer's modifiers. Every vertex carries its place on the picture
 * (layer px), so the face shows the layer however the stack bends it.
 */

export interface BuiltBody {
  mesh: MeshData;
  /** Stable while the geometry is — what the scene's geometry cache keys on. */
  key: string;
}

/** The layer's body at this instant, or null while its outline is still arriving (a font loading). */
export function layerBody(doc: MotionDocument, frame: Frame, o: WorldObject, pic: PlanePicture, env: StackEnv = {}): BuiltBody | null {
  const spec = bodyThickness(o.clip);
  const rect = `${pic.minX.toFixed(2)},${pic.minY.toFixed(2)},${pic.maxX.toFixed(2)},${pic.maxY.toFixed(2)}`;
  let base: BuiltBody;
  if (bodyIsTube(o.clip) && o.clip.kind === "path") {
    // A stroke in space: a tube along the curve, the width through its pressure profile.
    const stroke = tubeStroke(o.clip);
    const pts = pathPolyline(doc, o.clip);
    const closed = o.clip.subpaths.find((s) => s.points.length >= 2)?.closed ?? false;
    const mesh = stroke ? strokeTube(pts, stroke, { closed }) : null;
    if (!mesh) return null;
    base = { mesh, key: `tube|${closed}|${stroke!.width}|${JSON.stringify(stroke!.profile)}|${pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(";")}` };
  } else if (bodyIsRevolved(o.clip) && o.clip.kind === "path") {
    // A lathe: the outline itself, turned by the stack's Screw.
    const pts = pathPolyline(doc, o.clip);
    if (pts.length < 2) return null;
    base = { mesh: profileMesh(pts), key: `profile|${pts.length}|${pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(";")}` };
  } else if (!spec) {
    base = { mesh: cardMesh(pic, 0), key: `card|${rect}` };
  } else if (bodyFit(o.clip) === "box") {
    // The slab is the layer's own box; its effects' halo stays on the picture,
    // never stretched down the sides.
    const c = pic.content;
    base = { mesh: bevelledCard(c, spec), key: `box|${c.minX.toFixed(2)},${c.minY.toFixed(2)},${c.maxX.toFixed(2)},${c.maxY.toFixed(2)}|${spec.depth}|${spec.bevel}|${spec.bevelSegments}` };
  } else {
    const outline = VECTOR_BODY_KINDS.has(o.clip.kind) ? extrudeSource(doc, frame, o.source, o.localMs) : traceSilhouette(o.id, pic);
    if (!outline) return null;
    const geo = extrudedGeometry(outline, spec);
    base = { mesh: meshOfGeometry(geo), key: String(geo.userData.extrudeKey) };
  }
  return bodyThroughStack(base.mesh, base.key, layerModifiers(o.clip), o.localMs, { ...env, picture: pictureSampler(pic), depth: depthSampler(doc, o.clip, o.localMs, pic) });
}

// ── A picture's brightness, for Displace ─────────────────────────────────────

const samplers = new Map<string, PictureSampler>();
let lumaCanvas: HTMLCanvasElement | null = null;

/**
 * The picture's brightness as a sampler over layer px — read lazily (the first
 * `at` reads the pixels, once per picture version), at ≤256 cells a side,
 * bilinear between them. Only a stack that displaces by its picture ever reads.
 */
function pictureSampler(pic: PlanePicture): PictureSampler {
  const hit = samplers.get(pic.key);
  if (hit) return hit;
  let grid: { w: number; h: number; v: Float32Array } | null = null;
  const read = () => {
    const cw = pic.canvas.width, ch = pic.canvas.height;
    const k = Math.min(1, 256 / Math.max(cw, ch, 1));
    const w = Math.max(2, Math.round(cw * k)), h = Math.max(2, Math.round(ch * k));
    lumaCanvas ??= document.createElement("canvas");
    lumaCanvas.width = w;
    lumaCanvas.height = h;
    const ctx = lumaCanvas.getContext("2d", { willReadFrequently: true })!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(pic.canvas, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const v = new Float32Array(w * h);
    // Brightness over transparency: a clear pixel is dark (it raises nothing).
    for (let i = 0; i < v.length; i++) v[i] = ((0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!) / 255) * (d[i * 4 + 3]! / 255);
    // One soft pass (3×3 box, twice): a relief with hard pixel steps reads as
    // stairs once the surface has fewer points than the picture has pixels.
    let src = v;
    for (let pass = 0; pass < 2; pass++) {
      const dst = new Float32Array(src.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            sum += src[yy * w + xx]!;
            n++;
          }
          dst[y * w + x] = sum / n;
        }
      }
      src = dst;
    }
    return { w, h, v: src };
  };
  const sampler: PictureSampler = {
    key: pic.key,
    at(u, v) {
      grid ??= read();
      const gx = ((u - pic.minX) / Math.max(1e-6, pic.maxX - pic.minX)) * (grid.w - 1);
      const gy = ((v - pic.minY) / Math.max(1e-6, pic.maxY - pic.minY)) * (grid.h - 1);
      const x0 = Math.max(0, Math.min(grid.w - 1, Math.floor(gx))), y0 = Math.max(0, Math.min(grid.h - 1, Math.floor(gy)));
      const x1 = Math.min(grid.w - 1, x0 + 1), y1 = Math.min(grid.h - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, gx - x0)), fy = Math.max(0, Math.min(1, gy - y0));
      const g = grid.v, W = grid.w;
      const top = g[y0 * W + x0]! * (1 - fx) + g[y0 * W + x1]! * fx;
      const bot = g[y1 * W + x0]! * (1 - fx) + g[y1 * W + x1]! * fx;
      return top * (1 - fy) + bot * fy;
    },
  };
  samplers.set(pic.key, sampler);
  if (samplers.size > 64) samplers.delete(samplers.keys().next().value!);
  return sampler;
}

/**
 * The picture's DEPTH as a sampler over layer px (nearness 0 far … 1 near),
 * from its depth tracker's map laid over the layer's own box — Displace ›
 * Its depth, the still → relief plane. Undefined without a map.
 */
function depthSampler(doc: MotionDocument, clip: Clip, localMs: number, pic: PlanePicture): PictureSampler | undefined {
  const got = depthForClip(doc, clip, localMs);
  if (!got) return undefined;
  const c = pic.content;
  const w = Math.max(1e-6, c.maxX - c.minX);
  const h = Math.max(1e-6, c.maxY - c.minY);
  return {
    key: `depth:${got.tracker.maps?.key}|${got.frame.width}x${got.frame.height}|${got.tracker.maps?.times.length}`,
    at: (u, v) => nearnessAt(got.frame, Math.min(1, Math.max(0, (u - c.minX) / w)), Math.min(1, Math.max(0, (v - c.minY) / h))),
  };
}

// ── Extruded geometry → an editable mesh ─────────────────────────────────────

const meshes = new WeakMap<THREE.BufferGeometry, MeshData>();

/**
 * three's ExtrudeGeometry (a triangle soup, caps in group 0 and sides in
 * group 1) as a welded n-gon mesh: shared corners, so modifiers bend it in one
 * piece and the buffers smooth across its bevels; the sides their own part.
 */
function meshOfGeometry(geo: THREE.BufferGeometry): MeshData {
  const hit = meshes.get(geo);
  if (hit) return hit;
  const pos = geo.getAttribute("position");
  const index = new Map<string, number>();
  const positions: number[] = [];
  const uv: number[] = [];
  const at = (i: number): number => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${Math.round(x * 512)},${Math.round(y * 512)},${Math.round(z * 512)}`;
    let v = index.get(k);
    if (v === undefined) {
      v = positions.length / 3;
      index.set(k, v);
      positions.push(x, y, z);
      // The picture's own coordinates: layer x, and y down (local −Z).
      uv.push(x, -z);
    }
    return v;
  };
  const faces: number[][] = [];
  const faceParts: string[] = [];
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: pos.count, materialIndex: 0 }];
  for (const g of groups) {
    const part = g.materialIndex === 1 ? "side" : "";
    for (let i = g.start; i + 2 < g.start + g.count; i += 3) {
      const a = at(i), b = at(i + 1), c = at(i + 2);
      if (a === b || b === c || c === a) continue;
      faces.push([a, b, c]);
      faceParts.push(part);
    }
  }
  const mesh: MeshData = { positions, faces, faceParts, uv };
  meshes.set(geo, mesh);
  return mesh;
}

// ── A picture's silhouette ───────────────────────────────────────────────────

const traces = new Map<string, { key: string; outline: { cmds: PathCommand[]; key: string } | null }>();
let scratch: HTMLCanvasElement | null = null;

/**
 * The outline of what a picture actually covers — its alpha, thresholded at
 * half and traced along pixel edges, then simplified — in layer px relative
 * to the pivot, so it extrudes exactly like a glyph does. A picture with no
 * transparency is its rectangle (no trace at all). Traced once per picture;
 * a moving picture (a keyed video) re-traces each frame, at a coarser grid.
 */
export function traceSilhouette(clipId: string, pic: PlanePicture): { cmds: PathCommand[]; key: string } | null {
  const hit = traces.get(clipId);
  if (hit && hit.key === pic.key) return hit.outline;
  const outline = trace(pic);
  traces.set(clipId, { key: pic.key, outline });
  if (traces.size > 128) traces.delete(traces.keys().next().value!);
  return outline;
}

function trace(pic: PlanePicture): { cmds: PathCommand[]; key: string } | null {
  const cw = pic.canvas.width, ch = pic.canvas.height;
  if (!cw || !ch) return null;
  const grid = pic.varies ? 128 : 320;
  const k = Math.min(1, grid / Math.max(cw, ch));
  const gw = Math.max(2, Math.round(cw * k)), gh = Math.max(2, Math.round(ch * k));
  scratch ??= document.createElement("canvas");
  scratch.width = gw;
  scratch.height = gh;
  const ctx = scratch.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, gw, gh);
  ctx.drawImage(pic.canvas, 0, 0, gw, gh);
  const data = ctx.getImageData(0, 0, gw, gh).data;
  const inside = new Uint8Array(gw * gh);
  let count = 0;
  for (let i = 0; i < inside.length; i++) if (data[i * 4 + 3]! >= 128) (inside[i] = 1), count++;
  if (count === 0) return null;
  const sx = (pic.maxX - pic.minX) / gw, sy = (pic.maxY - pic.minY) / gh;
  const toLayer = (x: number, y: number) => ({ x: pic.minX + x * sx, y: pic.minY + y * sy });
  const cmds: PathCommand[] = [];
  const loops = count === inside.length ? [[[0, 0], [gw, 0], [gw, gh], [0, gh]] as Array<[number, number]>] : crackLoops(inside, gw, gh);
  for (const loop of loops) {
    const pts = simplify(loop, 0.75);
    if (pts.length < 3 || Math.abs(area(pts)) < 2) continue;
    pts.forEach(([x, y], i) => cmds.push({ type: i === 0 ? "M" : "L", ...toLayer(x, y) }));
    cmds.push({ type: "Z" });
  }
  return cmds.length ? { cmds, key: `trace|${pic.key}` } : null;
}

/**
 * Every boundary between covered and uncovered cells as closed loops along the
 * pixel grid (a covered region clockwise, a hole the other way — the extruder
 * reads nesting, not winding). At a saddle, where two regions touch only at a
 * corner, the walk turns right, keeping diagonal neighbours apart.
 */
function crackLoops(inside: Uint8Array, w: number, h: number): Array<Array<[number, number]>> {
  const cell = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && inside[y * w + x] === 1;
  const W = w + 1;
  // Outgoing edges per grid vertex, as direction codes 0=E 1=S 2=W 3=N.
  const out = new Map<number, number[]>();
  const add = (x: number, y: number, dir: number) => {
    const k = y * W + x;
    const list = out.get(k);
    if (list) list.push(dir);
    else out.set(k, [dir]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside[y * w + x]) continue;
      if (!cell(x, y - 1)) add(x, y, 0);
      if (!cell(x + 1, y)) add(x + 1, y, 1);
      if (!cell(x, y + 1)) add(x + 1, y + 1, 2);
      if (!cell(x - 1, y)) add(x, y + 1, 3);
    }
  }
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const loops: Array<Array<[number, number]>> = [];
  for (const [start, dirs] of out) {
    while (dirs.length) {
      let x = start % W, y = Math.floor(start / W);
      let dir = dirs.pop()!;
      const loop: Array<[number, number]> = [[x, y]];
      for (let guard = 0; guard < 4 * W * (h + 1); guard++) {
        x += DX[dir]!;
        y += DY[dir]!;
        const k = y * W + x;
        if (k === start) break;
        const here = out.get(k);
        if (!here || here.length === 0) break;
        // Prefer a right turn, then straight, then left.
        const pick = [(dir + 1) % 4, dir, (dir + 3) % 4].find((d) => here.includes(d)) ?? here[0]!;
        here.splice(here.indexOf(pick), 1);
        if (pick !== dir) loop.push([x, y]);
        dir = pick;
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/** Ramer–Douglas–Peucker on a closed loop, tolerance in grid cells. */
function simplify(loop: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (loop.length <= 4) return loop;
  // Split at the point farthest from the first, so the closed loop becomes two open runs.
  let far = 0, fd = -1;
  for (let i = 1; i < loop.length; i++) {
    const d = (loop[i]![0] - loop[0]![0]) ** 2 + (loop[i]![1] - loop[0]![1]) ** 2;
    if (d > fd) (fd = d), (far = i);
  }
  const run = (a: number, b: number): Array<[number, number]> => {
    const pts = a < b ? loop.slice(a, b + 1) : [...loop.slice(a), ...loop.slice(0, b + 1)];
    return rdp(pts, tol);
  };
  const first = run(0, far);
  const second = run(far, 0);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function rdp(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (pts.length <= 2) return pts;
  const [ax, ay] = pts[0]!, [bx, by] = pts[pts.length - 1]!;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let idx = 0, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((bx - ax) * (ay - pts[i]![1]) - (ax - pts[i]![0]) * (by - ay)) / len;
    if (d > dmax) (dmax = d), (idx = i);
  }
  if (dmax <= tol) return [pts[0]!, pts[pts.length - 1]!];
  const left = rdp(pts.slice(0, idx + 1), tol);
  return [...left.slice(0, -1), ...rdp(pts.slice(idx), tol)];
}

function area(pts: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!, [x2, y2] = pts[(i + 1) % pts.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
