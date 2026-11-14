import * as THREE from "three";
import {
  extrudeOutline,
  pathCommands,
  type MotionDocument,
  type ExtrudeSpec,
  type Frame,
  type PathCommand,
  type TextClip,
  type VisualClip,
} from "@solomotion/core";
import { textToSubpaths } from "../../export/text-outline";
import { layerPivotLocal } from "../../stage/render/draw-frame";
import { notifyPicturesChanged } from "../../stage/render/media-cache";

/**
 * SOLID DEPTH, BUILT — a layer's outline (glyphs, a shape, a path) as an
 * extruded mesh in the layer's own local space: the face on the plane where
 * its picture stood (local XZ, facing −Y), the depth running away from the
 * front (+Y), bevels rounding the edges. Group 0 is the face and back, group
 * 1 the sides, so each takes its own colour.
 *
 * Text outlines come from the same glyph outliner "convert to path" and SVG
 * export use, so every script the 2D text draws — Farsi and Arabic joining
 * included — is what the solid shows. They load asynchronously (fonts); the
 * caller keeps showing what it had until `onReady` fires.
 */

interface OutlineEntry {
  sig: string;
  cmds: PathCommand[] | null;
  pending: boolean;
}
const outlines = new Map<string, OutlineEntry>();

/** What changes a layer's OUTLINE — everything but where it is and how it moves. */
const signatures = new WeakMap<object, string>();
function outlineSignature(clip: VisualClip): string {
  let sig = signatures.get(clip);
  if (sig === undefined) {
    const { transform: _t, keyframes: _k, startMs: _s, durationMs: _d, extrude: _e, animIn: _i, animOut: _o, opacity: _op, ...rest } = clip as VisualClip & {
      animIn?: unknown;
      animOut?: unknown;
    };
    sig = JSON.stringify(rest);
    signatures.set(clip, sig);
  }
  return sig;
}

/**
 * Every scene that draws solids hears when an outline lands — not only the one
 * that asked first: the board's picture renderer and an open viewport ask for
 * the same text, and whichever loses the race must still redraw.
 */
const readyListeners = new Set<() => void>();
export function onOutlineReady(cb: () => void): () => void {
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}
function outlineLanded(): void {
  notifyPicturesChanged();
  for (const cb of readyListeners) cb();
}

/** The layer's outline relative to its pivot, or null while it is not available (yet). */
export function extrudeSource(
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  localMs: number,
): { cmds: PathCommand[]; key: string } | null {
  let cmds: PathCommand[] | null;
  let key: string;
  if (clip.kind === "text") {
    const sig = outlineSignature(clip);
    let entry = outlines.get(clip.id);
    if (!entry || entry.sig !== sig) {
      const next: OutlineEntry = { sig, cmds: entry?.cmds ?? null, pending: true };
      outlines.set(clip.id, next);
      void textToSubpaths(doc, clip as TextClip)
        .then((r) => {
          if (outlines.get(clip.id) !== next) return;
          next.cmds = r ? pathCommands(r.subpaths) : null;
          next.pending = false;
          outlineLanded();
        })
        .catch(() => {
          next.pending = false;
        });
      entry = next;
    }
    cmds = entry.cmds;
    key = `${clip.id}|${entry.pending ? "…" : sig.length}|${hash(sig)}`;
  } else {
    cmds = extrudeOutline(clip, localMs);
    key = `${clip.id}|${cmds ? hash(JSON.stringify(cmds)) : 0}`;
  }
  if (!cmds || cmds.length === 0) return null;
  const p = layerPivotLocal(doc, frame, clip, localMs);
  return { cmds: p.x || p.y ? shift(cmds, -p.x, -p.y) : cmds, key: `${key}|${p.x.toFixed(2)},${p.y.toFixed(2)}` };
}

function shift(cmds: PathCommand[], dx: number, dy: number): PathCommand[] {
  return cmds.map((c) =>
    c.type === "Z"
      ? c
      : c.type === "C"
        ? { ...c, x1: c.x1 + dx, y1: c.y1 + dy, x2: c.x2 + dx, y2: c.y2 + dy, x: c.x + dx, y: c.y + dy }
        : { ...c, x: c.x + dx, y: c.y + dy },
  );
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Contours → solids with holes, by NESTING rather than winding: a contour
 * inside an even number of others is a solid, inside an odd number a hole of
 * the innermost one around it. Fonts disagree on winding (TrueType and CFF are
 * opposite) and a drawn path can wind any way; nesting is what the eye reads.
 */
function shapesOf(cmds: PathCommand[]): THREE.Shape[] {
  const contours: THREE.Shape[] = [];
  let cur: THREE.Shape | null = null;
  for (const c of cmds) {
    if (c.type === "M") {
      cur = new THREE.Shape();
      cur.moveTo(c.x, c.y);
      contours.push(cur);
    } else if (!cur) continue;
    else if (c.type === "L") cur.lineTo(c.x, c.y);
    else if (c.type === "C") cur.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
    else cur.closePath();
  }
  const polys = contours.map((s) => s.getPoints(6));
  const n = contours.length;
  const inside = (pt: THREE.Vector2, poly: THREE.Vector2[]) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };
  const area = (poly: THREE.Vector2[]) => Math.abs(THREE.ShapeUtils.area(poly));
  const containers: number[][] = [];
  for (let i = 0; i < n; i++) {
    const probe = polys[i]![0];
    containers.push([]);
    if (!probe || polys[i]!.length < 3) continue;
    for (let j = 0; j < n; j++) if (j !== i && polys[j]!.length >= 3 && area(polys[j]!) > area(polys[i]!) && inside(probe, polys[j]!)) containers[i]!.push(j);
  }
  const solids: THREE.Shape[] = [];
  const byIndex = new Map<number, THREE.Shape>();
  for (let i = 0; i < n; i++) {
    if (polys[i]!.length < 3 || containers[i]!.length % 2 === 1) continue;
    byIndex.set(i, contours[i]!);
    solids.push(contours[i]!);
  }
  for (let i = 0; i < n; i++) {
    if (polys[i]!.length < 3 || containers[i]!.length % 2 === 0) continue;
    // The innermost container: the one with the most containers of its own.
    const parent = containers[i]!.reduce((best, j) => (containers[j]!.length > containers[best]!.length ? j : best), containers[i]![0]!);
    byIndex.get(parent)?.holes.push(contours[i]!);
  }
  return solids;
}

const geometryCache = new Map<string, { geo: THREE.BufferGeometry; users: number; lastUsed: number }>();
let tick = 0;

/** The extruded geometry for an outline at a depth and bevel — cached, shared. */
export function extrudedGeometry(source: { cmds: PathCommand[]; key: string }, spec: ExtrudeSpec): THREE.BufferGeometry {
  const key = `${source.key}|${spec.depth.toFixed(2)}|${spec.bevel.toFixed(2)}|${spec.bevelSegments}`;
  const hit = geometryCache.get(key);
  tick++;
  if (hit) {
    hit.lastUsed = tick;
    return hit.geo;
  }
  const bevel = spec.bevel;
  const geo = new THREE.ExtrudeGeometry(shapesOf(source.cmds), {
    depth: spec.depth,
    curveSegments: 10,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: spec.bevelSegments,
  });
  // Face at the plane, depth away from the front: (u, v, z) → (u, z, −v).
  geo.translate(0, 0, bevel);
  geo.rotateX(-Math.PI / 2);
  geo.computeBoundingSphere();
  geo.userData.extrudeKey = key;
  geometryCache.set(key, { geo, users: 0, lastUsed: tick });
  if (geometryCache.size > 64) {
    let oldest: string | null = null;
    let at = Infinity;
    for (const [k, e] of geometryCache) if (e.lastUsed < at && k !== key) (at = e.lastUsed), (oldest = k);
    if (oldest) {
      geometryCache.get(oldest)!.geo.dispose();
      geometryCache.delete(oldest);
    }
  }
  return geo;
}
