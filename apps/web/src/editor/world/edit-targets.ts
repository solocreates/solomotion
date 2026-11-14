import {
  bakeClipAt,
  beginTangentDrag,
  clipBox,
  copySubpaths,
  cropWindow,
  handleDepth,
  isSmoothNode,
  localToPlane,
  locateClip,
  outlineWritesKey,
  pathOutlineAt,
  planeBasis,
  planeToLocal,
  resolveTangentDrag,
  runNodeVerb,
  NODE_VERBS,
  writeChannel,
  writePathOutline,
  type MotionDocument,
  type Clip,
  type DocumentStore,
  type ElementMode,
  type LayerBasis,
  type MeshClip,
  type MeshData,
  type NodeRef,
  type NodeVerbId,
  type NodeVerbResult,
  type PathClip,
  type PathPoint,
  type Subpath,
  type V3,
  type VisualClip,
} from "@solomotion/core";
import { commitMesh, meshDataOf } from "./commands";

/**
 * EDIT TARGETS — what the 3D viewport's EDIT MODE can edit.
 *
 * Blender has one edit mode for everything editable: a mesh, a curve, a
 * grease-pencil stroke all show their points and move them with the same
 * selection, G/R/S, gizmo, proportional editing and snapping. The viewport's
 * edit mode was written for meshes; this is the seam that makes it Blender's.
 * A target presents what can be moved as a CAGE — positions in the object's
 * local 3D space, with faces where it has faces and WIRES (loose line pairs)
 * where it has lines — and knows how to show a moved cage live and how to write
 * it back as one undo step. Everything else (picking, box select, the modal,
 * the overlay) is the edit mode's own and never learns what it is editing.
 *
 *   mesh   its polygons (vertex / edge / face). Mesh-only operators — extrude,
 *          inset, loop cut, knife — gate on `kind === "mesh"`.
 *   path   a path layer standing in a world: its nodes and Bézier handles on
 *          the layer's plane — the flat pen's node editor, in space. Moving a
 *          point off the plane gives it depth, so a flat path becomes a true
 *          3D curve. Its structural verbs are the pen's own (core
 *          `node-verbs`). Shapes enter as paths ("make editable", as a
 *          primitive becomes a mesh).
 *   crop   an image or video: the four corners of its crop window. A side is an
 *          edge, the whole window is the face — G on the face pans the crop.
 *
 * A new editable kind is one row in `TARGET_OF` and one factory in `FACTORIES`.
 */

/** How a cage point is drawn: a mesh vertex, a path node (corner or smooth), a handle. */
export const GLYPH = { vertex: 0, corner: 1, smooth: 2, handle: 3 } as const;

export interface EditCage {
  mesh: MeshData;
  /** Line pairs drawn and picked beside the faces' edges: a handle's arm. */
  wires: ReadonlyArray<readonly [number, number]>;
  /** Each point's glyph (`GLYPH`); absent = every point a plain vertex. */
  glyphs?: Uint8Array;
}

/** A stretch of the true line between two node vertices, sampled — drawn, never picked as an edge. */
export interface CageCurve {
  a: number;
  b: number;
  /** Object-local points, ends included. */
  points: V3[];
}

/** How a moved cage is read: ⌥ held (a handle breaks from its partner), and how close to its node a handle dissolves. */
export interface CageMove {
  alt?: boolean;
  /** Object-local units. */
  dissolveWithin?: number;
}

export interface EditTarget {
  readonly clipId: string;
  readonly kind: "mesh" | "path" | "crop";
  /** The element modes this target has, in toolbar order. */
  readonly elements: readonly ElementMode[];
  /** The cage as the document has it now. Stable identity while the layer is unchanged. */
  cage(): EditCage;
  /** Points that move WITH these (a node carries its handles). */
  followers(verts: ReadonlySet<number>): Set<number>;
  /** The points on screen for this selection (a path's handles show only around it). Absent: all. */
  shown?(selected: ReadonlySet<number>): ReadonlySet<number>;
  /** Can a box select this point? (A path's nodes, never its handles.) Absent: any shown point. */
  boxable?(vert: number): boolean;
  /** The real line through a (moved) cage, for the overlay. */
  curves?(mesh: MeshData): CageCurve[];
  /** Show a moved cage live — the whole app sees it, history does not. */
  preview(mesh: MeshData, move?: CageMove): void;
  clearPreview(): void;
  /** Write a moved cage as one undo step. */
  commit(mesh: MeshData, label: string, move?: CageMove): void;
}

export interface EditTargetContext {
  store: DocumentStore;
  /** The engine's live mesh previews, keyed by clip id (the viewport's). */
  meshPreview: Map<string, MeshData>;
  /** The playhead and record mode — crop insets are keyframe-aware writes. */
  playheadMs: () => number;
  recording: () => boolean;
}

export type EditTargetKind = EditTarget["kind"];

/** Which target a layer kind edits as. A shape edits as a path once made editable. */
const TARGET_OF: Partial<Record<Clip["kind"], EditTargetKind>> = {
  mesh: "mesh",
  path: "path",
  shape: "path",
  image: "crop",
  video: "crop",
};

/** The element modes each target has, in toolbar order. */
const ELEMENTS: Record<EditTargetKind, readonly ElementMode[]> = {
  mesh: ["vertex", "edge", "face"],
  path: ["vertex"],
  crop: ["vertex", "edge", "face"],
};

/** What a layer of this kind edits as, or null when edit mode has nothing to offer it. */
export function editTargetKindOf(kind: Clip["kind"]): EditTargetKind | null {
  return TARGET_OF[kind] ?? null;
}

/** The element modes a layer of this kind can be edited in. */
export function editElementsOf(kind: Clip["kind"]): readonly ElementMode[] {
  const t = TARGET_OF[kind];
  return t ? ELEMENTS[t] : [];
}

type Factory = (ctx: EditTargetContext, doc: MotionDocument, clip: Clip) => EditTarget | null;

const FACTORIES: Partial<Record<Clip["kind"], Factory>> = {
  mesh: (ctx, _doc, clip) => meshTarget(ctx, clip as MeshClip),
  path: (ctx, doc, clip) => pathTarget(ctx, doc, clip as PathClip),
  image: (ctx, doc, clip) => cropTarget(ctx, doc, clip as VisualClip),
  video: (ctx, doc, clip) => cropTarget(ctx, doc, clip as VisualClip),
};

/** The target for a layer, or null when it has nothing edit mode can move. */
export function editTargetFor(ctx: EditTargetContext, doc: MotionDocument, clipId: string): EditTarget | null {
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip) return null;
  return FACTORIES[clip.kind]?.(ctx, doc, clip) ?? null;
}


// ── Mesh ─────────────────────────────────────────────────────────────────────

function meshTarget(ctx: EditTargetContext, clip: MeshClip): EditTarget | null {
  const mesh = meshDataOf(clip);
  if (!mesh) return null;
  return {
    clipId: clip.id,
    kind: "mesh",
    elements: ELEMENTS.mesh,
    cage: () => cached(clip, () => ({ mesh, wires: [] })),
    followers: (verts) => new Set(verts),
    preview: (m) => void ctx.meshPreview.set(clip.id, m),
    clearPreview: () => void ctx.meshPreview.delete(clip.id),
    commit: (m, label) => {
      ctx.meshPreview.delete(clip.id);
      commitMesh(ctx.store, clip.id, m, label);
    },
  };
}

// ── Path ─────────────────────────────────────────────────────────────────────

/** Which point of the path each cage vertex is. */
interface PathRef {
  sub: number;
  index: number;
  part: "anchor" | "in" | "out";
}

interface PathCage extends EditCage {
  refs: PathRef[];
  basis: LayerBasis;
  /** The outline the cage was built from (the shown one, keyed or base). */
  subpaths: Subpath[];
  /** `anchorAt[sub][index]` — the cage vertex of each node. */
  anchorAt: number[][];
}

/** The node either side of `i` (wrapping on a closed run), null past an open end. */
function neighbours(sub: { closed: boolean; points: PathPoint[] }, i: number): { prev: PathPoint | null; next: PathPoint | null } {
  const n = sub.points.length;
  return {
    prev: i > 0 ? sub.points[i - 1]! : sub.closed && n > 1 ? sub.points[n - 1]! : null,
    next: i < n - 1 ? sub.points[i + 1]! : sub.closed && n > 1 ? sub.points[0]! : null,
  };
}

/** A handle's 3D position in the layer's coordinates — its depth its own, or the straight run's. */
function handle3(pt: PathPoint, side: "in" | "out", sub: Subpath, i: number): { x: number; y: number; z: number } | null {
  const h = side === "in" ? pt.hIn : pt.hOut;
  if (!h) return null;
  const { prev, next } = neighbours(sub, i);
  return { x: h.x, y: h.y, z: handleDepth(pt, h, side === "in" ? prev : next) };
}

/**
 * The cage of an outline: each node, then its in and out handles — the order
 * `vertsOfNodes` counts in. Handles sit at their real depth (their own, or a
 * straight run's), so a handle you see is exactly where the curve aims.
 */
function buildPathCage(basis: LayerBasis, subpaths: Subpath[]): PathCage {
  const positions: number[] = [];
  const refs: PathRef[] = [];
  const wires: Array<[number, number]> = [];
  const glyphs: number[] = [];
  const anchorAt: number[][] = [];
  const push = (p: V3, ref: PathRef, glyph: number) => {
    positions.push(p[0], p[1], p[2]);
    refs.push(ref);
    glyphs.push(glyph);
    return refs.length - 1;
  };
  subpaths.forEach((sp, s) => {
    anchorAt.push([]);
    sp.points.forEach((pt, i) => {
      const a = push(planeToLocal(basis, pt), { sub: s, index: i, part: "anchor" }, isSmoothNode(pt) ? GLYPH.smooth : GLYPH.corner);
      anchorAt[s]!.push(a);
      for (const side of ["in", "out"] as const) {
        const h = handle3(pt, side, sp, i);
        if (h) wires.push([a, push(planeToLocal(basis, h), { sub: s, index: i, part: side }, GLYPH.handle)]);
      }
    });
    // No anchor-to-anchor wires: a chord is not the curve. The overlay draws
    // the TRUE line through the nodes (`curves`) — never straight chords
    // across it, which read as a second, wrong outline.
  });
  return { mesh: { positions, faces: [] }, wires, glyphs: Uint8Array.from(glyphs), refs, basis, subpaths, anchorAt };
}

/**
 * The cage of the outline AS IT SHOWS at an instant — a morphing path's shape
 * at the playhead, placed with the pivot the renderer uses there (the baked
 * clip), so every point sits exactly on the line you see.
 */
function pathCage(doc: MotionDocument, clip: PathClip, localMs: number): PathCage {
  const animated = outlineWritesKey(clip);
  const shown = animated ? (bakeClipAt(clip, localMs) as PathClip) : clip;
  const build = () => buildPathCage(planeBasis(doc, shown), shown.subpaths);
  // A still outline caches per clip version; a morphing one is rebuilt (it changes with the playhead).
  return animated ? build() : cached(clip, build);
}

/** Only real depth is written: a value within float noise of the default is the default. */
const DEPTH_EPS = 1e-6;

/** Write a handle at a 3D spot, its depth only where it differs from the straight run's. */
function placeHandle(pt: PathPoint, side: "hIn" | "hOut", at: { x: number; y: number; z: number }, toward: PathPoint | null): void {
  const def = handleDepth(pt, null, toward);
  pt[side] = Math.abs(at.z - def) > DEPTH_EPS ? { x: at.x, y: at.y, z: at.z } : { x: at.x, y: at.y };
}

/**
 * The subpaths a moved cage means. A node carries its handles (they are in
 * the cage as followers). A handle moved ALONE obeys the shared tangent rule
 * (core `tangents`, the flat pen's and the motion path's): a smooth node stays
 * smooth — its partner turns, mirrored or at its own length — a broken one
 * stays broken, ⌥ does the other, and a handle dropped onto its node
 * dissolves into a corner. All of it in 3D: a handle's depth is part of its arm.
 */
function pathFromCage(cage: PathCage, mesh: MeshData, move: CageMove = {}): Subpath[] {
  const subs = copySubpaths(cage.subpaths);
  const at = (i: number): V3 => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
  const was = (i: number): V3 => [cage.mesh.positions[i * 3]!, cage.mesh.positions[i * 3 + 1]!, cage.mesh.positions[i * 3 + 2]!];
  const moved = (i: number) => {
    const a = at(i), b = was(i);
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 1e-9;
  };
  const key = (r: PathRef) => `${r.sub}:${r.index}`;
  const movedParts = new Set<string>();
  cage.refs.forEach((r, i) => moved(i) && movedParts.add(`${key(r)}:${r.part}`));
  // Nodes first: a handle's default depth reads its node's and its neighbour's.
  cage.refs.forEach((r, i) => {
    if (r.part !== "anchor" || !moved(i)) return;
    const pt = subs[r.sub]!.points[r.index]!;
    const q = localToPlane(cage.basis, at(i));
    pt.x = q.x;
    pt.y = q.y;
    // Depth only when it has some: a flat path stays a flat path.
    if (Math.abs(q.z) > DEPTH_EPS) pt.z = q.z;
    else delete pt.z;
  });
  cage.refs.forEach((r, i) => {
    if (r.part === "anchor" || !moved(i)) return;
    const sub = subs[r.sub]!;
    const pt = sub.points[r.index]!;
    const side = r.part === "in" ? "hIn" : "hOut";
    const other = r.part === "in" ? "hOut" : "hIn";
    const { prev, next } = neighbours(sub, r.index);
    const toward = r.part === "in" ? prev : next;
    const q = localToPlane(cage.basis, at(i));
    placeHandle(pt, side, q, toward);
    // Carried by its node, or moved with its partner: no pairing to resolve.
    if (movedParts.has(`${key(r)}:anchor`) || movedParts.has(`${key(r)}:${r.part === "in" ? "out" : "in"}`)) return;
    const orig = cage.subpaths[r.sub]!.points[r.index]!;
    const origSub = cage.subpaths[r.sub]!;
    const arm = (p: PathPoint, s: "in" | "out") => {
      const h = handle3(p, s, origSub, r.index);
      return h ? { x: h.x - p.x, y: h.y - p.y, z: h.z - (p.z ?? 0) } : null;
    };
    const res = resolveTangentDrag(beginTangentDrag(arm(orig, r.part), arm(orig, r.part === "in" ? "out" : "in")), {
      vector: { x: q.x - pt.x, y: q.y - pt.y, z: q.z - (pt.z ?? 0) },
      alt: !!move.alt,
      shift: false,
      dissolveWithin: move.dissolveWithin ?? 0,
    });
    if (!res.dragged) {
      pt[side] = null;
      return;
    }
    if (res.partner) {
      const p = res.partner;
      placeHandle(pt, other, { x: pt.x + p.x, y: pt.y + p.y, z: (pt.z ?? 0) + (p.z ?? 0) }, r.part === "in" ? next : prev);
    }
  });
  return subs;
}

/** The node vertices of a cage built from these subpaths — the layout `buildPathCage` writes. */
export function vertsOfNodes(subpaths: ReadonlyArray<Subpath>, refs: ReadonlyArray<NodeRef>): number[] {
  const want = new Set(refs.map((r) => `${r.sub}:${r.index}`));
  const out: number[] = [];
  let v = 0;
  subpaths.forEach((sp, s) =>
    sp.points.forEach((pt, i) => {
      if (want.has(`${s}:${i}`)) out.push(v);
      v += 1 + (pt.hIn ? 1 : 0) + (pt.hOut ? 1 : 0);
    }),
  );
  return out;
}

/** Sample a cubic between two nodes, depth included (core's handle-depth rule). */
function sampleSegment(a: PathPoint, b: PathPoint, steps: number): Array<{ x: number; y: number; z: number }> {
  const c1 = a.hOut ?? a, c2 = b.hIn ?? b;
  const az = a.z ?? 0, bz = b.z ?? 0;
  const z1 = handleDepth(a, a.hOut, b), z2 = handleDepth(b, b.hIn, a);
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps, u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    out.push({ x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x, y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y, z: w0 * az + w1 * z1 + w2 * z2 + w3 * bz });
  }
  return out;
}

/** A path target, with the verbs only a path has. */
export interface PathEditTarget extends EditTarget {
  readonly kind: "path";
  /** The outline as it shows (what the cage was built from). */
  outline(): Subpath[];
  /** The nodes a vertex selection names (a handle names its node). */
  nodesOf(verts: ReadonlySet<number>): NodeRef[];
  /** The node a vertex is, with which part of it. */
  refOf(vert: number): PathRef | null;
  /**
   * Run a shared point verb (core `node-verbs`) as one undo step, and say
   * which cage vertices are selected after it (undefined: keep; null: none).
   */
  run(id: NodeVerbId, verts: ReadonlySet<number>): { result: NodeVerbResult; select: number[] | null | undefined };
  /** `run` for an edit no verb names (merge at the 3D cursor): the same step, selection and emptying rules. */
  apply(label: string, fn: (subs: Subpath[], refs: NodeRef[]) => NodeVerbResult, verts: ReadonlySet<number>): { result: NodeVerbResult; select: number[] | null | undefined };
  /** A point of the object's own space, in the layer's coordinates (x, y, depth). */
  toLayer(local: V3): { x: number; y: number; z: number };
  /** Edit the outline by hand (⌥-dragging handles out of a node): live, then one step. */
  previewOutline(subs: Subpath[]): void;
  commitOutline(subs: Subpath[], label: string): void;
  /** The same layer, its cage built from this outline instead (an extrude's new points, before they move). */
  withOutline(subs: Subpath[], label: string): PathEditTarget;
}

export function isPathTarget(t: EditTarget | null | undefined): t is PathEditTarget {
  return t?.kind === "path";
}

function pathTarget(ctx: EditTargetContext, doc: MotionDocument, clip: PathClip, seed?: { subs: Subpath[]; label: string }): PathEditTarget {
  const local = Math.max(0, ctx.playheadMs() - clip.startMs);
  const cage = seed ? buildPathCage(planeBasis(doc, outlineWritesKey(clip) ? (bakeClipAt(clip, local) as PathClip) : clip), seed.subs) : pathCage(doc, clip, local);
  // THE outline write (core `writePathOutline`): the pivot held so untouched
  // points never move, and a key at the playhead when the outline morphs.
  const writeSubs = (d: MotionDocument, subs: Subpath[]) => {
    const loc = locateClip(d, clip.id);
    if (loc?.clip.kind === "path") writePathOutline(loc.clip, subs, local, { record: ctx.recording() });
  };
  const write = (d: MotionDocument, mesh: MeshData, move?: CageMove) => writeSubs(d, pathFromCage(cage, mesh, move));
  const refsOf = (verts: ReadonlySet<number>): NodeRef[] => {
    const seen = new Set<string>();
    const out: NodeRef[] = [];
    for (const v of verts) {
      const r = cage.refs[v];
      if (!r || seen.has(`${r.sub}:${r.index}`)) continue;
      seen.add(`${r.sub}:${r.index}`);
      out.push({ sub: r.sub, index: r.index });
    }
    return out;
  };
  const handlesOf = (s: number, i: number): number[] => {
    const a = cage.anchorAt[s]?.[i];
    if (a === undefined) return [];
    const out: number[] = [];
    for (let k = a + 1; k < cage.refs.length && cage.refs[k]!.part !== "anchor"; k++) out.push(k);
    return out;
  };
  const target: PathEditTarget = {
    clipId: clip.id,
    kind: "path",
    elements: ELEMENTS.path,
    cage: () => cage,
    followers: (verts) => {
      const out = new Set(verts);
      for (const v of verts) {
        const r = cage.refs[v];
        if (r?.part === "anchor") for (const h of handlesOf(r.sub, r.index)) out.add(h);
      }
      return out;
    },
    // The flat pen's rule: a node's handles show while it is selected — and
    // so do the neighbours' handles that shape the segments either side of
    // it, and any handle that is itself selected. A long brush stroke is a
    // row of nodes, not a hedge of arms.
    shown: (selected) => {
      const out = new Set<number>();
      cage.refs.forEach((r, v) => r.part === "anchor" && out.add(v));
      for (const v of selected) {
        const r = cage.refs[v];
        if (!r) continue;
        out.add(v);
        for (const h of handlesOf(r.sub, r.index)) out.add(h);
        if (r.part !== "anchor") continue;
        const sub = cage.subpaths[r.sub]!;
        const n = sub.points.length;
        const prev = r.index > 0 ? r.index - 1 : sub.closed ? n - 1 : -1;
        const next = r.index < n - 1 ? r.index + 1 : sub.closed ? 0 : -1;
        for (const h of prev >= 0 ? handlesOf(r.sub, prev) : []) if (cage.refs[h]!.part === "out") out.add(h);
        for (const h of next >= 0 ? handlesOf(r.sub, next) : []) if (cage.refs[h]!.part === "in") out.add(h);
      }
      return out;
    },
    boxable: (v) => cage.refs[v]?.part === "anchor",
    curves: (mesh) => {
      const subs = mesh === cage.mesh ? cage.subpaths : pathFromCage(cage, mesh);
      const out: CageCurve[] = [];
      subs.forEach((sp, s) => {
        const n = sp.points.length;
        const count = sp.closed ? n : n - 1;
        for (let i = 0; i < count; i++) {
          const a = sp.points[i]!, b = sp.points[(i + 1) % n]!;
          const steps = a.hOut || b.hIn ? 16 : 1;
          out.push({ a: cage.anchorAt[s]![i]!, b: cage.anchorAt[s]![(i + 1) % n]!, points: sampleSegment(a, b, steps).map((p) => planeToLocal(cage.basis, p)) });
        }
      });
      return out;
    },
    preview: (mesh, move) => ctx.store.setOverlay((d) => write(d, mesh, move)),
    clearPreview: () => ctx.store.setOverlay(null),
    commit: (mesh, label, move) => {
      ctx.store.setOverlay(null);
      ctx.store.update(seed?.label ?? label, (d) => write(d, mesh, move));
    },
    outline: () => cage.subpaths,
    nodesOf: refsOf,
    refOf: (v) => cage.refs[v] ?? null,
    run: (id, verts) => target.apply(NODE_VERBS[id].undo, (subs, refs) => runNodeVerb(id, subs, refs), verts),
    toLayer: (v) => localToPlane(cage.basis, v),
    apply: (label, fn, verts) => {
      const refs = refsOf(verts);
      let result: NodeVerbResult = { changed: false };
      let after: Subpath[] = [];
      ctx.store.update(label, (d) => {
        const loc = locateClip(d, clip.id);
        if (loc?.clip.kind !== "path") return;
        // The outline as it SHOWS here (a morph's shape at the playhead),
        // edited as a copy and written through the one seam.
        const subs = copySubpaths(pathOutlineAt(loc.clip, local));
        result = fn(subs, refs);
        if (!result.changed) return;
        if (result.emptied) {
          loc.track.clips.splice(loc.clipIndex, 1);
          return;
        }
        writePathOutline(loc.clip, subs, local, { record: ctx.recording() });
        after = subs;
      });
      const r = result as NodeVerbResult;
      // "The same nodes" are re-found in the new layout: a node that gained
      // handles pushed every vertex after it along.
      if (r.select === undefined) return { result: r, select: r.changed ? vertsOfNodes(after, refs) : undefined };
      return { result: r, select: r.select ? vertsOfNodes(r.changed ? after : cage.subpaths, r.select) : null };
    },
    previewOutline: (subs) => ctx.store.setOverlay((d) => writeSubs(d, subs)),
    commitOutline: (subs, label) => {
      ctx.store.setOverlay(null);
      ctx.store.update(label, (d) => writeSubs(d, subs));
    },
    withOutline: (subs, label) => pathTarget(ctx, doc, clip, { subs, label }),
  };
  return target;
}

/** Node refs of a path cage's selected vertices — what core's node verbs take. */
export function selectedNodeRefs(target: EditTarget, verts: ReadonlySet<number>): NodeRef[] {
  return isPathTarget(target) ? target.nodesOf(verts) : [];
}

// ── Crop ─────────────────────────────────────────────────────────────────────

const CROP_SIDES = ["top", "right", "bottom", "left"] as const;

function cropTarget(ctx: EditTargetContext, doc: MotionDocument, clip: VisualClip): EditTarget {
  const box = clipBox(doc, clip);
  const cage = cached(clip, () => {
    const basis = planeBasis(doc, clip);
    const w = cropWindow(clip.crop, box);
    const x0 = w.cx - w.width / 2, x1 = w.cx + w.width / 2, y0 = w.cy - w.height / 2, y1 = w.cy + w.height / 2;
    const corners = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ] as const;
    return { mesh: { positions: corners.flatMap(([x, y]) => planeToLocal(basis, { x, y })), faces: [[0, 1, 2, 3]] }, wires: [], basis } as EditCage & { basis: LayerBasis };
  });
  /** A moved cage → crop insets: the window is the box the corners now span, on the plane. */
  const insets = (mesh: MeshData) => {
    const pts = [0, 1, 2, 3].map((i) => localToPlane(cage.basis, [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!]));
    const bx0 = box.cx - box.width / 2, by0 = box.cy - box.height / 2;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    return {
      left: clamp(Math.min(...xs) - bx0, box.width),
      top: clamp(Math.min(...ys) - by0, box.height),
      right: clamp(bx0 + box.width - Math.max(...xs), box.width),
      bottom: clamp(by0 + box.height - Math.max(...ys), box.height),
    };
  };
  const write = (d: MotionDocument, mesh: MeshData) => {
    const loc = locateClip(d, clip.id);
    if (!loc || loc.clip.kind === "audio") return;
    const next = insets(mesh);
    const local = ctx.playheadMs() - loc.clip.startMs;
    // Keyed when the inset is keyed or record is on — the write every crop gesture makes.
    for (const side of CROP_SIDES) writeChannel(loc.clip, `crop.${side}`, local, Math.round(next[side] * 100) / 100, { forceKey: ctx.recording() });
  };
  return {
    clipId: clip.id,
    kind: "crop",
    elements: ELEMENTS.crop,
    cage: () => cage,
    followers: (verts) => new Set(verts),
    preview: (mesh) => ctx.store.setOverlay((d) => write(d, mesh)),
    clearPreview: () => ctx.store.setOverlay(null),
    // Whatever moved it — a corner, a side, the whole window — the step is a crop.
    commit: (mesh) => {
      ctx.store.setOverlay(null);
      ctx.store.update("Crop", (d) => write(d, mesh));
    },
  };
}

// ── A cage per layer version ─────────────────────────────────────────────────

const cages = new WeakMap<object, EditCage>();
/**
 * One cage per version of a layer, so the overlay and the selection see the
 * SAME object while nothing changed (the overlay rebuilds on identity) and a
 * fresh one the moment the document does.
 */
function cached<T extends EditCage>(clip: object, build: () => T): T {
  let c = cages.get(clip) as T | undefined;
  if (!c) cages.set(clip, (c = build()));
  return c;
}
