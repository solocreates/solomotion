import type { MotionDocument, Bind, Clip, GroupClip, MeshData } from "../schema";
import { sampledScaleY } from "../animation/uniform-scale";
import { clipAncestorGroups } from "../timeline/groups";
import { isSettledDocument } from "../timeline/settled";
import { clipBox, type MemberShaping } from "../timeline/ops";
import { anchorLocal, basisOfTransform, layerMatrix } from "../transform-map";
import { groupDeltaMatrix, groupMatrixOf } from "../timeline/group-space";
import { sampleKeyframes } from "../animation/keyframes";
import { invert4, mul4, transformPoint, type Mat4, type V3 } from "../world/math";
import { distToSegment, rigPoseAt, type RigPose } from "./pose";
import { autoWeights, deformSegments, paintWeights, rigJoints, SLOTS, type WeightGraph, type Weights } from "./weights";
import { gridSupport, meshSupport, sampleGrid, pointInfluence, type Box2, type Coverage, type GridSupport, type Influence } from "./support";

/**
 * BINDING — which bones a member of a rig follows, and how.
 *
 * Every member is bound unless it opts out (`schema/rig.ts` `bindSchema`).
 * What it binds AS is the UNIT: the layer itself, or the group above it that
 * speaks for it — a group under the rig with an explicit rigid or none binding
 * (a head group riding the head bone whole), or a rig of its own (a sword rig
 * held in a hand). Groups without one are only organisation; their leaves
 * bind one by one.
 *
 * A unit either RIDES one bone — its placement gains that bone's skin, which
 * is a placement like a group's, so it stays crisp and its picture is never
 * redrawn — or BENDS, its points blended over several bones by weights.
 *
 * Weights are taken where the art RESTS (its stored placement, keys ignored),
 * so a layer that animates inside its rig keeps its weights instead of
 * re-weighting every frame.
 */

export type BindKind = "none" | "rigid" | "smooth";

export interface MemberOf {
  rig: GroupClip;
  /** The clip that binds — the layer, or the group above it that speaks for it. */
  unit: Clip;
  /** Groups between the rig and the layer, outermost first (the unit, if a group, included). */
  inner: GroupClip[];
}

/**
 * The rig a layer belongs to, and its unit. The NEAREST rig wins (a rig inside
 * a rig owns its own members; it is itself a unit of the outer one).
 */
export function memberOf(doc: MotionDocument, clipId: string): MemberOf | null {
  const ancestors = clipAncestorGroups(doc, clipId); // innermost first
  const at = ancestors.findIndex((g) => !!g.rig && g.rig.bones.length > 0);
  if (at < 0) return null;
  const rig = ancestors[at]!;
  const inner = ancestors.slice(0, at).reverse(); // outermost first
  const self = locate(doc, clipId);
  if (!self) return null;
  // The first group under the rig that speaks for its contents is the unit.
  const speaker = inner.find(speaks);
  if (speaker) return { rig, unit: speaker, inner };
  // A group that does not speak is only organisation: its leaves bind, it does not.
  if (self.kind === "group" && !speaks(self)) return null;
  return { rig, unit: self, inner };
}

/**
 * Every rig above a layer, with the unit it binds on the way down — a layer
 * inside a rig inside a rig rides both (the hand rig rides the arm bone; the
 * hand bends with its own bones). Innermost rig LAST.
 */
export function rigsOnPath(doc: MotionDocument, clipId: string): MemberOf[] {
  const ancestors = clipAncestorGroups(doc, clipId); // innermost first
  const self = locate(doc, clipId);
  if (!self) return [];
  const out: MemberOf[] = [];
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const rig = ancestors[i]!;
    if (!rig.rig?.bones.length) continue;
    const inner = ancestors.slice(0, i).reverse();
    const unit = inner.find(speaks) ?? (self.kind !== "group" || speaks(self) ? self : null);
    if (unit) out.push({ rig, unit, inner });
  }
  return out;
}

/**
 * The bone skins a 2D layer's PLACEMENT gains, keyed by the rig group each
 * goes after (the rig's delta, then the bone, then what is inside) — for the
 * units that ride one bone. A unit that bends gains nothing here: its content
 * is warped where it is drawn. Empty in a world (worlds place in 3D).
 */
export function rigidSkins2d(doc: MotionDocument, clipId: string, localTimeOf: (clip: Clip) => number): Map<string, Mat4> {
  const out = new Map<string, Mat4>();
  for (const m of rigsOnPath(doc, clipId)) {
    if (!rigIsFlat(doc, m.rig)) continue;
    const pose = rigPoseAt(m.rig, localTimeOf(m.rig), true);
    if (!pose || pose.atRest) continue;
    const d = decide2d(doc, m, pose);
    if (d.kind !== "rigid" || !d.bone) continue;
    const s = pose.byId.get(d.bone);
    if (s) out.set(m.rig.id, s.skin);
  }
  return out;
}

// ── What a renderer asks, per layer ─────────────────────────────────────────

const hasRigs = new WeakMap<MotionDocument, boolean>();

/** Does any group in this document carry bones? Memoised per document — the common project pays one scan. */
export function documentHasRigs(doc: MotionDocument): boolean {
  let hit = hasRigs.get(doc);
  if (hit === undefined) {
    hit = doc.tracks.some((t) => t.clips.some((c) => c.kind === "group" && !!c.rig?.bones.length));
    // Only a settled document can be remembered (a draft may gain a rig next line).
    if (isSettledDocument(doc)) hasRigs.set(doc, hit);
  }
  return hit;
}

/** A group's delta at its local time as a 4×4 (identity when it has none). */
function groupDelta4(doc: MotionDocument, g: GroupClip, localMs: number): Mat4 {
  const d = groupDeltaMatrix(doc, g, localMs);
  return d ? affine4([d.a, d.b, d.c, d.d, d.e, d.f]) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/**
 * The placement a UNIT gains at its own place in the layer tree, in a flat
 * comp: its bone's skin, carried through the groups between it and the rig
 * (I⁻¹·S·I) — a renderer that has already applied the rig's and those groups'
 * deltas on its way down applies this and is exactly where `groupChainMatrix`
 * puts it. Null for a layer that is not a riding unit (or a rig at rest).
 */
export function unitSkin2d(doc: MotionDocument, unitId: string, localTimeOf: (clip: Clip) => number): Mat4 | null {
  return unitSkinThrough(doc, unitId, localTimeOf, true);
}

/**
 * The same skin as seen from the unit's PARENT (a group unit's own delta left
 * out) — what its placed corners gain when a box is measured around it.
 */
function unitSkinThrough(doc: MotionDocument, unitId: string, localTimeOf: (clip: Clip) => number, throughSelf: boolean): Mat4 | null {
  let out: Mat4 | null = null;
  for (const m of rigsOnPath(doc, unitId)) {
    if (m.unit.id !== unitId || !rigIsFlat(doc, m.rig)) continue;
    const pose = rigPoseAt(m.rig, localTimeOf(m.rig), true);
    if (!pose || pose.atRest) continue;
    const d = decide2d(doc, m, pose);
    if (d.kind !== "rigid" || !d.bone) continue;
    const S = pose.byId.get(d.bone)?.skin;
    if (!S) continue;
    let I: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const g of m.inner) if (throughSelf || g.id !== unitId) I = mul4(I, groupDelta4(doc, g, localTimeOf(g)));
    const local = mul4(invert4(I), mul4(S, I));
    out = out ? mul4(out, local) : local;
  }
  return out;
}

const bentCache = new Map<string, number[]>();

/**
 * WHAT A RIG'S MEMBERS OCCUPY at an instant, for measuring boxes around them
 * (`groupBoxWith`): a riding unit's corners gain its bone; a bending layer
 * occupies its silhouette grid, skinned. Null when the document has no rigs —
 * the common project measures exactly as before.
 */
export function rigShaping2d(doc: MotionDocument, localTimeOf: (clip: Clip) => number): MemberShaping | null {
  if (!documentHasRigs(doc)) return null;
  return (clip) => {
    if (clip.kind === "audio" || !rigsOnPath(doc, clip.id).length) return null;
    const S = unitSkinThrough(doc, clip.id, localTimeOf, false);
    const bend = clip.kind === "group" ? null : bend2d(doc, clip.id, localTimeOf);
    if (!S && !bend) return null;
    let local: number[] | undefined;
    if (bend) {
      local = bentCache.get(bend.key);
      if (!local) {
        const p = skinGraph(bend.field.grid, bend.field.weights, bend.skins);
        local = [];
        for (let i = 0; i < bend.field.grid.count; i++) local.push(p[i * 3]!, p[i * 3 + 1]!);
        if (bentCache.size > 32) bentCache.delete(bentCache.keys().next().value!);
        bentCache.set(bend.key, local);
      }
    }
    return { ...(local && { local }), ...(S && { after: affineOf(S) }) };
  };
}

/** What a BENDING layer is drawn through: its weight field, each bone's skin in its own space, and a key. */
export interface Bend2d {
  field: Field2d;
  skins: Mat4[];
  key: string;
}

/**
 * A layer that bends in a flat comp, at this instant: its field (weights over
 * its silhouette) and the skins carried into its own space through where it
 * is NOW (the groups between it and the rig, then its own transform, sampled).
 * Null when it does not bend (rides a bone, ignores the rig, or the rig rests).
 */
export function bend2d(doc: MotionDocument, leafId: string, localTimeOf: (clip: Clip) => number): Bend2d | null {
  const m = memberOf(doc, leafId);
  if (!m || m.unit.id !== leafId || m.unit.kind === "group" || m.unit.kind === "audio" || !rigIsFlat(doc, m.rig)) return null;
  const pose = rigPoseAt(m.rig, localTimeOf(m.rig), true);
  if (!pose || pose.atRest) return null;
  if (decide2d(doc, m, pose).kind !== "smooth") return null;
  const leaf = m.unit;
  const field = field2d(doc, m, leaf, pose);
  let I: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const g of m.inner) I = mul4(I, groupDelta4(doc, g, localTimeOf(g)));
  const t = leafTransformAt(leaf, localTimeOf(leaf));
  const L = layerMatrix(basisOfTransform(t, clipBox(doc, leaf)));
  const now = mul4(I, affine4([L[0], L[1], L[2], L[3], L[4] + t.x, L[5] + t.y]));
  return { field, skins: localSkins(field.weights, pose, now), key: `${pose.poseKey}|${field.grid.key}|${now.map((v) => v.toFixed(3)).join(",")}` };
}

/** A 2D layer's transform at a local instant — its keyed placement channels sampled over the stored ones. */
function leafTransformAt(clip: Exclude<Clip, { kind: "audio" }>, localMs: number): Exclude<Clip, { kind: "audio" }>["transform"] {
  const t = clip.transform;
  const tracks = clip.keyframes.filter((k) => !k.range && PLACEMENT.has(k.property));
  if (!tracks.length) return t;
  const s = sampleKeyframes(tracks, localMs);
  const n = (k: string, v: number) => (typeof s[k] === "number" ? (s[k] as number) : v);
  const scale = n("scale", t.scale);
  return {
    ...t,
    x: n("x", t.x),
    y: n("y", t.y),
    rotation: n("rotation", t.rotation),
    scale,
    scaleY: sampledScaleY(s, t.scaleY),
    skewX: n("skewX", t.skewX),
    skewY: n("skewY", t.skewY),
    anchor: { x: n("anchor.x", t.anchor.x), y: n("anchor.y", t.anchor.y) },
  };
}
const PLACEMENT = new Set(["x", "y", "rotation", "scale", "scaleY", "skewX", "skewY", "anchor.x", "anchor.y"]);

function rigIsFlat(doc: MotionDocument, g: GroupClip): boolean {
  return !doc.frames.find((f) => f.id === g.frameId)?.world;
}

/** Does a group under a rig bind as ONE unit (a rig of its own, a switch, or an explicit rigid/none)? */
export function speaksForMembers(g: Clip): boolean {
  // A switch's members are alternatives in one place (an eye's states): they move as one.
  return g.kind === "group" && (!!g.rig?.bones.length || !!g.switch || g.bind?.mode === "rigid" || g.bind?.mode === "none");
}
const speaks = speaksForMembers;

function locate(doc: MotionDocument, id: string): Clip | null {
  for (const t of doc.tracks) for (const c of t.clips) if (c.id === id) return c;
  return null;
}

// ── The art's own space ──────────────────────────────────────────────────────

/** A group's delta from its STORED transform (keys ignored) — where it rests. */
function groupRestDelta(doc: MotionDocument, g: GroupClip): Mat4 {
  const t = g.transform;
  const m = groupMatrixOf(
    { x: t.x, y: t.y, rotation: t.rotation, scaleX: t.scale, scaleY: t.scaleY ?? t.scale, skewX: t.skewX, skewY: t.skewY, anchor: t.anchor },
    anchorLocal(t.anchor, clipBox(doc, g)),
  );
  return affine4([m.a, m.b, m.c, m.d, m.e, m.f]);
}

/** A 2D affine `[a b c d e f]` as a 4×4 (z untouched). */
export function affine4(a: readonly number[]): Mat4 {
  return [a[0]!, a[1]!, 0, 0, a[2]!, a[3]!, 0, 0, 0, 0, 1, 0, a[4]!, a[5]!, 0, 1];
}

/** A 4×4 that keeps the plane, as a 2D affine `[a b c d e f]`. */
export function affineOf(m: Mat4): [number, number, number, number, number, number] {
  return [m[0]!, m[1]!, m[4]!, m[5]!, m[12]!, m[13]!];
}

/**
 * A 2D layer's own space → the rig's, where it RESTS (stored transform, the
 * groups between at their stored transforms). What its weights are measured in.
 */
export function restToRig2d(doc: MotionDocument, m: MemberOf, leaf: Clip): Mat4 {
  return restThrough2d(doc, m.inner, leaf);
}

/**
 * The same through any chain of groups (outermost first) — where a layer RESTS
 * in the space the outermost group's members are written in. Character part
 * detection measures a group that is not (yet) a rig with it.
 */
export function restThrough2d(doc: MotionDocument, inner: readonly GroupClip[], leaf: Clip): Mat4 {
  let out: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const g of inner) out = mul4(out, groupRestDelta(doc, g));
  if (leaf.kind === "audio") return out;
  const t = leaf.transform;
  const box = clipBox(doc, leaf);
  const L = layerMatrix(basisOfTransform(t, box));
  return mul4(out, affine4([L[0], L[1], L[2], L[3], L[4] + t.x, L[5] + t.y]));
}

/** The box a 2D layer's weights cover, in its own space. */
export function artBox(doc: MotionDocument, leaf: Clip): Box2 {
  const b = clipBox(doc, leaf);
  return { minX: b.cx - b.width / 2, minY: b.cy - b.height / 2, maxX: b.cx + b.width / 2, maxY: b.cy + b.height / 2 };
}

// ── The silhouette, from whoever can see it ─────────────────────────────────

/**
 * Core cannot see pixels. The app installs the one thing that can — the
 * opacity of a layer's own picture at a point of its own space — and every
 * binding reads it (the `setTextBoxMeasurer` pattern). Headless, a layer's
 * silhouette is its box.
 */
export type CoverageProvider = (doc: MotionDocument, clip: Clip) => { key: string; at: Coverage } | null;
let coverageProvider: CoverageProvider | null = null;
export function setRigCoverageProvider(fn: CoverageProvider | null): void {
  coverageProvider = fn;
  fieldCache.clear();
}

// ── Deciding ─────────────────────────────────────────────────────────────────

export interface Field2d {
  grid: GridSupport;
  weights: Weights;
}

const fieldCache = new Map<string, Field2d>();
const decideCache = new Map<string, Decision>();

export interface Decision {
  kind: BindKind;
  /** Rigid: the bone it rides. */
  bone?: string;
  /** Smooth: the bones it is made of (they run through it) — what bends it, and what simulates when it falls. */
  made?: string[];
}

/** A key for the bits of a bind that change weights. */
function bindKey(b: Bind | undefined): string {
  if (!b) return "auto";
  return `${b.mode}|${b.bone ?? ""}|${b.paint.length}:${b.paint.map((s) => `${s.bone}${s.mode}${s.strength}${s.radius}${s.points.length}:${s.points.slice(0, 4).join(",")}:${s.points.slice(-4).join(",")}`).join(";")}`;
}

/**
 * A piece of art as binding sees it: its extent in its OWN space, how that
 * space sits in the rig's where it rests, and — for a 2D layer — its
 * silhouette. A flat piece is read in its plane (depth ignored), a mesh as
 * its box.
 */
export interface ArtShape {
  key: string;
  toRig: Mat4;
  min: V3;
  max: V3;
  flat: boolean;
  coverage: { key: string; at: Coverage } | null;
}

/** A 2D layer's art shape in a flat comp (or, with `restToRig`, standing in a world). */
export function artShape2d(doc: MotionDocument, m: MemberOf, leaf: Clip, restToRig?: Mat4): ArtShape {
  const box = artBox(doc, leaf);
  const cov = coverageProvider?.(doc, leaf) ?? null;
  const toRig = restToRig ?? restToRig2d(doc, m, leaf);
  return { key: `${leaf.id}|${boxKey(box)}|${cov?.key ?? "box"}`, toRig, min: [box.minX, box.minY, 0], max: [box.maxX, box.maxY, 0], flat: true, coverage: cov };
}

/**
 * How a unit follows its rig: none, riding one bone, or bending.
 *
 * `auto` reads the art: the bones whose rest segments run through it (its
 * silhouette in 2D, its box in 3D) for at least a quarter of their length are
 * the ones it is MADE of. Two or more and it bends; one and it rides that
 * bone; none and it rides the nearest — a hat above the head bone, a pupil in
 * an eye. A cut-out arm whose end only overlaps the elbow rides its own bone
 * and keeps its drawn shape, which is what a cut-out is for.
 */
export function decideUnit(m: MemberOf, pose: RigPose, art: ArtShape | null, centre?: V3, opts: { whole?: boolean } = {}): Decision {
  const unit = m.unit;
  const bind = unit.kind === "audio" ? undefined : unit.bind;
  const mode = bind?.mode ?? "auto";
  const segs = deformSegments(pose);
  if (mode === "none") return { kind: "none" };
  if (mode === "rigid" && bind?.bone && pose.byId.has(bind.bone)) return { kind: "rigid", bone: bind.bone };
  if (!segs.length) return mode === "rigid" && pose.bones.length ? { kind: "rigid", bone: pose.bones[0]!.id } : { kind: "none" };
  if (!art) return mode === "smooth" && !opts.whole ? { kind: "smooth" } : { kind: "rigid", bone: nearestBone(segs, centre ?? [0, 0, 0]) };
  const key = `${pose.restKey}|${art.key}|${art.toRig.map((v) => v.toFixed(2)).join(",")}|${mode}|${opts.whole ? 1 : 0}`;
  const hit = decideCache.get(key);
  if (hit) return hit;
  const inv = invert4(art.toRig);
  const pad = art.flat ? 0 : 1e-6;
  const inside = (p: V3): boolean => {
    const l = transformPoint(inv, p);
    if (l[0] < art.min[0] || l[0] > art.max[0] || l[1] < art.min[1] || l[1] > art.max[1]) return false;
    if (!art.flat && (l[2] < art.min[2] - pad || l[2] > art.max[2] + pad)) return false;
    return art.coverage ? art.coverage.at(l[0], l[1]) > 0.05 : true;
  };
  const span = Math.max(art.max[0] - art.min[0], art.max[1] - art.min[1], art.flat ? 0 : art.max[2] - art.min[2]);
  const cell = Math.max(span / 40, 1e-3);
  const made: Array<{ id: string; len: number }> = [];
  for (const s of segs) {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]);
    const steps = Math.min(400, Math.max(2, Math.ceil(len / (cell * 0.5))));
    let inLen = 0;
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      if (inside([s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t, s.a[2] + (s.b[2] - s.a[2]) * t])) inLen += len / steps;
    }
    if (inLen >= Math.max(len * 0.25, cell * 2) || (len < cell * 2 && inLen >= len * 0.5)) made.push({ id: s.id, len: inLen });
  }
  const mid = transformPoint(art.toRig, [(art.min[0] + art.max[0]) / 2, (art.min[1] + art.max[1]) / 2, (art.min[2] + art.max[2]) / 2]);
  let out: Decision;
  if (mode === "rigid" || (opts.whole && made.length >= 2)) out = { kind: "rigid", bone: made.slice().sort((a, b) => b.len - a.len)[0]?.id ?? nearestBone(segs, mid) };
  else if (mode === "smooth" || made.length >= 2) out = { kind: "smooth", made: made.map((m) => m.id) };
  else if (made.length === 1) out = { kind: "rigid", bone: made[0]!.id };
  else out = hangOrReach(segs, pose, inside, mid);
  if (decideCache.size > 512) decideCache.delete(decideCache.keys().next().value!);
  decideCache.set(key, out);
  return out;
}

/**
 * Art no bone runs through: a cut-out piece joined to the next by a bone drawn
 * from one to the other. The piece a bone REACHES rides it (its tip is in the
 * art — the clock hand); the piece a bone only STARTS in is what the bone
 * hangs from, so it rides that bone's parent — or, under a root, the rig
 * itself (the clock's face stays put while the hand turns). Neither: the
 * nearest bone, as before (a hat above the head bone).
 */
function hangOrReach(segs: ReturnType<typeof deformSegments>, pose: RigPose, inside: (p: V3) => boolean, mid: V3): Decision {
  const reached = segs.filter((s) => inside(s.b));
  if (reached.length) return { kind: "rigid", bone: nearestTail(reached, mid) };
  const hung = segs.filter((s) => inside(s.a));
  if (hung.length) {
    const parent = pose.byId.get(hung[0]!.id)?.parent ?? null;
    return parent ? { kind: "rigid", bone: parent } : { kind: "none" };
  }
  return { kind: "rigid", bone: nearestBone(segs, mid) };
}

function nearestTail(segs: ReturnType<typeof deformSegments>, p: V3): string {
  let best = segs[0]!.id, bd = Infinity;
  for (const s of segs) {
    const d = Math.hypot(s.b[0] - p[0], s.b[1] - p[1], s.b[2] - p[2]);
    if (d < bd) (bd = d), (best = s.id);
  }
  return best;
}

/** `decideUnit` for a flat comp's unit (a layer, or a group that speaks). */
export function decide2d(doc: MotionDocument, m: MemberOf, pose: RigPose, restToRig?: Mat4): Decision {
  const unit = m.unit;
  // A group unit is read by its box: the bones running through it are what it is made of, and
  // since a group moves whole, the one running furthest through it is the one it rides.
  if (unit.kind === "group") return decideUnit(m, pose, groupArt(doc, m, unit), undefined, { whole: true });
  return decideUnit(m, pose, unit.kind === "audio" ? null : artShape2d(doc, m, unit, restToRig));
}

/** A group unit as art: its resting box, placed in the rig through the groups around it and its own delta. */
function groupArt(doc: MotionDocument, m: MemberOf, g: GroupClip): ArtShape {
  const b = clipBox(doc, g);
  let toRig: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const ig of m.inner) {
    toRig = mul4(toRig, groupRestDelta(doc, ig));
    if (ig.id === g.id) break;
  }
  const box = { minX: b.cx - b.width / 2, minY: b.cy - b.height / 2, maxX: b.cx + b.width / 2, maxY: b.cy + b.height / 2 };
  return { key: `${g.id}|${boxKey(box)}`, toRig, min: [box.minX, box.minY, 0], max: [box.maxX, box.maxY, 0], flat: true, coverage: null };
}

function boxKey(b: Box2): string {
  return `${b.minX.toFixed(1)},${b.minY.toFixed(1)},${b.maxX.toFixed(1)},${b.maxY.toFixed(1)}`;
}

function centreInRig(doc: MotionDocument, m: MemberOf, g: GroupClip): V3 {
  const b = clipBox(doc, g);
  // A group's members are written in rig space already (groups are deltas).
  let p: V3 = [b.cx, b.cy, 0];
  for (const ig of m.inner) {
    if (ig === g) break;
    p = transformPoint(groupRestDelta(doc, ig), p);
  }
  return p;
}

function nearestBone(segs: ReturnType<typeof deformSegments>, p: V3): string {
  let best = segs[0]!.id, bd = Infinity;
  for (const s of segs) {
    const d = distToSegment(p, s.a, s.b);
    if (d < bd) (bd = d), (best = s.id);
  }
  return best;
}

/** The weight field of a 2D layer that bends: its silhouette grid, automatic weights, paint replayed. */
export function field2d(doc: MotionDocument, m: MemberOf, leaf: Clip, pose: RigPose, restToRig?: Mat4): Field2d {
  const blend = m.rig.rig?.blend ?? 0.35;
  const toRig = restToRig ?? restToRig2d(doc, m, leaf);
  const cov = coverageProvider?.(doc, leaf) ?? null;
  const box = artBox(doc, leaf);
  const bind = leaf.kind === "audio" ? undefined : leaf.bind;
  const key = `${pose.restKey}|${blend}|${leaf.id}|${boxKey(box)}|${toRig.map((v) => v.toFixed(3)).join(",")}|${cov?.key ?? "box"}|${bindKey(bind)}`;
  const hit = fieldCache.get(key);
  if (hit) {
    fieldCache.delete(key);
    fieldCache.set(key, hit);
    return hit;
  }
  const grid = gridSupport(box, toRig, cov?.at ?? null, leaf.id);
  const auto = autoWeights(grid, deformSegments(pose), { joints: rigJoints(pose, blend) });
  const weights = paintWeights(auto, grid, bind?.paint ?? []);
  const out = { grid, weights };
  if (fieldCache.size > 64) fieldCache.delete(fieldCache.keys().next().value!);
  fieldCache.set(key, out);
  return out;
}

// ── Meshes (3D) ──────────────────────────────────────────────────────────────

const meshFieldCache = new Map<string, { graph: WeightGraph; weights: Weights }>();

/**
 * The weights of a mesh that bends — its own vertices and edges. `meshKey`
 * names the geometry (the evaluated-geometry key), `toRig` its object space at
 * rest in the rig's.
 */
export function meshField(mesh: MeshData, meshKey: string, toRig: Mat4, pose: RigPose, bind: Bind | undefined, blend = 0.35): { graph: WeightGraph; weights: Weights } {
  const key = `${pose.restKey}|${blend}|${meshKey}|${toRig.map((v) => v.toFixed(3)).join(",")}|${bindKey(bind)}`;
  const hit = meshFieldCache.get(key);
  if (hit) return hit;
  const graph = meshSupport(mesh, toRig, meshKey);
  const weights = paintWeights(autoWeights(graph, deformSegments(pose), { joints: rigJoints(pose, blend) }), graph, bind?.paint ?? []);
  const out = { graph, weights };
  if (meshFieldCache.size > 32) meshFieldCache.delete(meshFieldCache.keys().next().value!);
  meshFieldCache.set(key, out);
  return out;
}

/** Does a mesh's weighting make it ride one bone whole (every point ≥ 99.9% one bone)? */
export function rigidBoneOf(weights: Weights): string | null {
  let only = -2;
  for (let i = 0; i < weights.count; i++) {
    const b = weights.bone[i * SLOTS]!;
    if (b < 0 || weights.w[i * SLOTS]! < 0.999) return null;
    if (only === -2) only = b;
    else if (only !== b) return null;
  }
  return only >= 0 ? weights.bones[only]! : null;
}

// ── Skinning ─────────────────────────────────────────────────────────────────

/**
 * Each deform bone's skin carried into the art's own space at this instant:
 * `M⁻¹ · S · M`, M the art → rig map NOW. Indexed like `weights.bones`.
 */
export function localSkins(weights: Weights, pose: RigPose, toRigNow: Mat4): Mat4[] {
  const inv = invert4(toRigNow);
  return weights.bones.map((id) => {
    const s = pose.byId.get(id);
    return s ? mul4(inv, mul4(s.skin, toRigNow)) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  });
}

/** Linear-blend skinning of one point. */
export function skinPoint(skins: readonly Mat4[], inf: Influence, x: number, y: number, z: number): V3 {
  let ox = 0, oy = 0, oz = 0, sum = 0;
  for (let k = 0; k < inf.bone.length; k++) {
    const b = inf.bone[k]!;
    if (b < 0) break;
    const w = inf.w[k]!;
    const m = skins[b]!;
    ox += w * (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!);
    oy += w * (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!);
    oz += w * (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
    sum += w;
  }
  return sum > 0 ? [ox, oy, oz] : [x, y, z];
}

/** Every point of a graph, skinned — `xyz` in the art's own space. */
export function skinGraph(graph: WeightGraph, weights: Weights, skins: readonly Mat4[]): Float64Array {
  const out = new Float64Array(graph.count * 3);
  const inf: Influence = { bone: new Int16Array(4), w: new Float32Array(4) };
  for (let i = 0; i < graph.count; i++) {
    pointInfluence(weights, i, inf);
    const p = skinPoint(skins, inf, graph.local[i * 3]!, graph.local[i * 3 + 1]!, graph.local[i * 3 + 2]!);
    out[i * 3] = p[0], out[i * 3 + 1] = p[1], out[i * 3 + 2] = p[2];
  }
  return out;
}

/** Points anywhere in a 2D layer's own space (a path's outline), skinned through its field. */
export function skinPoints2d(field: Field2d, skins: readonly Mat4[], pts: readonly number[]): number[] {
  const out = new Array<number>(pts.length);
  const inf: Influence = { bone: new Int16Array(4), w: new Float32Array(4) };
  for (let i = 0; i + 1 < pts.length; i += 2) {
    sampleGrid(field.grid, field.weights, pts[i]!, pts[i + 1]!, inf);
    const p = skinPoint(skins, inf, pts[i]!, pts[i + 1]!, 0);
    out[i] = p[0];
    out[i + 1] = p[1];
  }
  return out;
}
