"use client";

import * as THREE from "three";
import {
  addBone,
  bakeRig,
  boneColor,
  bonesInRig,
  clipAncestorGroups,
  clipLocalTime,
  createRig,
  editBone,
  evaluateRig,
  invert4,
  locateClip,
  moveChannels3d,
  mul4,
  poseBones,
  reachChainLength,
  reachChannels3d,
  rotateChannels3d,
  sub,
  transformDir,
  transformPoint,
  turnBetween,
  type MotionDocument,
  type BoneInRig,
  type BoneState,
  type DocumentStore,
  type GroupClip,
  type Mat4,
  type Rig,
  type RigPose,
  type V3,
  type WorldEval,
  type WorldRig,
} from "@solomotion/core";
import { useSession } from "../../state/session";
import { useRigUi } from "../../rig/state";
import { useWorldUi } from "../state";
import { ACTIVE } from "./overlays";

/**
 * BONES IN THE VIEWPORT — the world's half of `rig/RigOverlay.tsx`, with the
 * same two modes and two grammars (ADR-characters-3, "Rig").
 *
 * A rig shows while it (or a layer in it) is selected, or the Bone tool is
 * armed: deforming bones as Blender's octahedral wire, controls as their shape
 * around the head, drawn in front of everything (bones are guides, never
 * rendered); a child that does not start at its parent's tip hangs off it by a
 * dashed line.
 *
 *   POSE    press a bone and drag. REACH (default): its tip follows the
 *           pointer and the chain above it bends to let it (`reachChannels3d`),
 *           up to the chain length, below a pin or a branch. ROTATE: it turns
 *           about the line of sight through its head. Its tip aims; a control
 *           moves in the plane facing you. G / R / S with X Y Z axis locks are
 *           the viewport's own modal, aimed at the picked bones.
 *   SETUP   (the rig's Setup mode, or the Bone tool) the rig shows at REST and
 *           drags edit rest: a bone's body moves it, its head or tip moves that
 *           joint (a joined parent's tip comes with a head). With the Bone tool
 *           a drag on empty space draws a bone on the plane through the 3D
 *           cursor, a drag from a tip extrudes its child, E extrudes from the
 *           active bone. G / R / S move, turn and stretch rest.
 *
 * Every write is core's: `poseBones` (keyed with Record on or where already
 * keyed) in Pose, `editBone` / `addBone` / `createRig` in Setup — previewed on
 * the store's overlay and committed as one undo step on release.
 */

export interface BoneHost {
  store: DocumentStore;
  toScreen(p: V3): [number, number] | null;
  /** Ray ∩ the plane through `p` facing `n`, world units. */
  hitPlane(x: number, y: number, p: V3, n: V3): V3 | null;
  /** The view's forward direction, world space. */
  forward(): V3;
  /** The world comp this viewport shows (where new rigs go). */
  frameId(): string | null;
}

export interface BoneHit {
  rigId: string;
  bone: string;
  kind: "body" | "tip" | "head" | "control";
}

interface Shown {
  rig: WorldRig;
  clip: GroupClip;
  /** The pose drawn: the live one in Pose, rest in Setup. */
  pose: RigPose;
}

type Grab =
  | (BoneHit & { mode: "pose"; pose: RigPose; rig: Rig; matrix: Mat4; start: V3; local: number; chain: number })
  | (BoneHit & { mode: "setup"; at: Map<string, BoneInRig>; matrix: Mat4; start: V3 })
  | { kind: "draw"; mode: "draw"; rigId: string | null; parent: string | null; matrix: Mat4; head: V3; at: V3; click: boolean };

/** What the viewport's G / R / S modal moves when bones are picked. */
export interface BoneModalTarget {
  rigId: string;
  ids: string[];
  setup: boolean;
  matrix: Mat4;
  /** Pose: the rig as it was; Setup: each bone's rest in rig space. */
  pose: RigPose;
  at: Map<string, BoneInRig>;
  local: number;
  /** World space: the pivot (the picked heads' middle) and local axes (the active bone's). */
  pivot: V3;
  axes: Mat4;
}

// Apart from both selection colours (the viewport's amber, the canvas' accent), so a picked control always reads as picked.
const CONTROL = new THREE.Color("#4fe0b5");
// A mid grey: drawn in front of everything, it has to read on a white mesh and on the dark void alike —
// and stand apart from the side colours (`SIDE_COLORS`: left red, right blue) a named bone takes.
const DEFORM = new THREE.Color("#9aa3b0");
const PIN = new THREE.Color("#ffcf5a");

const restRig = (rig: Rig): Rig => ({ ...rig, bones: rig.bones.map((b) => (b.pose ? { ...b, pose: undefined } : b)) });

export class BoneLayer {
  readonly group = new THREE.Group();
  private readonly lines: THREE.LineSegments;
  private readonly dashed: THREE.LineSegments;
  private shown: Shown[] = [];
  private grab: Grab | null = null;
  private last: { label: string; recipe: (d: MotionDocument) => void } | null = null;

  constructor(private readonly host: BoneHost) {
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
    this.lines.renderOrder = 6;
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
    const dash = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 4, gapSize: 4, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
    this.dashed = new THREE.LineSegments(new THREE.BufferGeometry(), dash);
    this.dashed.renderOrder = 6;
    this.dashed.frustumCulled = false;
    this.group.add(this.dashed);
  }

  get active(): boolean {
    return this.grab !== null;
  }

  /** A bone being drawn that waits for a click (E's extrude), not a release. */
  get waitsForClick(): boolean {
    return this.grab?.kind === "draw" && this.grab.click;
  }

  private setup(): boolean {
    return useRigUi.getState().mode === "setup" || useWorldUi.getState().tool === "bone";
  }

  /** Which rigs show and their wire, at this instant. */
  update(ev: WorldEval | null, selected: readonly string[], visible: boolean): void {
    const doc = this.host.store.getState();
    const ui = useRigUi.getState();
    const setup = this.setup();
    const want = new Set<string>();
    for (const id of selected) {
      const c = locateClip(doc, id)?.clip;
      if (c?.kind === "group" && c.rig) want.add(c.id);
      for (const g of clipAncestorGroups(doc, id)) if (g.rig) want.add(g.id);
    }
    if (ui.rigId) want.add(ui.rigId);
    this.shown = [];
    for (const r of ev?.rigs ?? []) {
      const clip = locateClip(doc, r.id)?.clip;
      if (clip?.kind !== "group" || !clip.rig) continue;
      // The Bone tool shows every rig (you build on what is there); otherwise the selected ones.
      if (!clip.rig.showBones || (!want.has(r.id) && !(setup && useWorldUi.getState().tool === "bone"))) continue;
      this.shown.push({ rig: r, clip, pose: setup ? evaluateRig(restRig(clip.rig), { planar: false }) : r.pose });
    }
    const g = this.grab;
    this.group.visible = visible && (this.shown.length > 0 || g?.kind === "draw");
    if (!this.group.visible) return;
    const pos: number[] = [];
    const col: number[] = [];
    const dpos: number[] = [];
    const seg = (a: V3, b: V3, c: THREE.Color) => {
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    const octa = (head: V3, frame: (u: number, v: number, w: number) => V3, len: number, color: THREE.Color) => {
      const w = Math.max(0.5, len * 0.1), m = len * 0.2;
      const tail = frame(len, 0, 0);
      const ring = [frame(m, w, 0), frame(m, 0, w), frame(m, -w, 0), frame(m, 0, -w)];
      for (let i = 0; i < 4; i++) {
        seg(head, ring[i]!, color);
        seg(ring[i]!, tail, color);
        seg(ring[i]!, ring[(i + 1) % 4]!, color);
      }
    };
    for (const { rig, clip, pose } of this.shown) {
      const picked = ui.rigId === rig.id ? ui.bones : [];
      const pins = new Set(ui.pins[rig.id] ?? []);
      for (const b of pose.bones) {
        const on = picked.includes(b.id);
        const shaped = b.bone.shape !== "bone";
        const own = boneColor(b.bone);
        const color = on ? ACTIVE : own ? new THREE.Color(own) : shaped || !b.bone.deform ? CONTROL : DEFORM;
        const frame = (u: number, v: number, w: number): V3 => transformPoint(rig.matrix, transformPoint(b.pose, [u, v, w]));
        const len = b.bone.rest.length;
        // A child that does not start at its parent's tip: the relationship line.
        if (b.parent) {
          const up = pose.byId.get(b.parent);
          if (up && Math.hypot(up.tail[0] - b.head[0], up.tail[1] - b.head[1], up.tail[2] - b.head[2]) > Math.max(1e-3, up.bone.rest.length * 1e-3)) {
            const a = transformPoint(rig.matrix, up.tail), h = transformPoint(rig.matrix, b.head);
            dpos.push(a[0], a[1], a[2], h[0], h[1], h[2]);
          }
        }
        if (pins.has(b.id)) {
          const R = Math.max(3, len * 0.12);
          for (let i = 0; i < 12; i++) seg(frame(0, Math.cos((i / 12) * Math.PI * 2) * R, Math.sin((i / 12) * Math.PI * 2) * R), frame(0, Math.cos(((i + 1) / 12) * Math.PI * 2) * R, Math.sin(((i + 1) / 12) * Math.PI * 2) * R), PIN);
        }
        if (shaped && !setup) {
          // The control's shape around its head, across the bone (Blender's custom shape).
          const R = b.bone.size ?? Math.max(4, len * 0.35);
          const ring = (pts: Array<[number, number]>) => {
            for (let i = 0; i < pts.length; i++) {
              const [a1, a2] = pts[i]!, [b1, b2] = pts[(i + 1) % pts.length]!;
              seg(frame(0, a1, a2), frame(0, b1, b2), color);
            }
          };
          if (b.bone.shape === "circle") ring(Array.from({ length: 24 }, (_, i) => [Math.cos((i / 24) * Math.PI * 2) * R, Math.sin((i / 24) * Math.PI * 2) * R] as [number, number]));
          else if (b.bone.shape === "square") ring([[-R, -R], [R, -R], [R, R], [-R, R]]);
          else if (b.bone.shape === "diamond") ring([[0, -R], [R, 0], [0, R], [-R, 0]]);
          else {
            seg(frame(0, -R, 0), frame(0, R, 0), color);
            seg(frame(0, 0, -R), frame(0, 0, R), color);
          }
          continue;
        }
        octa(frame(0, 0, 0), frame, len, color);
        if (b.bone.ik && !setup) {
          const t = pose.byId.get(b.bone.ik.target);
          if (t) seg(frame(len, 0, 0), transformPoint(rig.matrix, t.head), CONTROL);
        }
      }
      void clip;
    }
    // The bone being drawn.
    if (g?.kind === "draw") {
      const d = sub(g.at, g.head);
      const len = Math.hypot(d[0], d[1], d[2]);
      if (len > 1e-6) {
        const x: V3 = [d[0] / len, d[1] / len, d[2] / len];
        const up: V3 = Math.abs(x[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
        const z = norm(cross(x, up)), y = cross(z, x);
        octa(g.head, (u, v, w) => [g.head[0] + x[0] * u + y[0] * v + z[0] * w, g.head[1] + x[1] * u + y[1] * v + z[1] * w, g.head[2] + x[2] * u + y[2] * v + z[2] * w], len, ACTIVE);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    this.lines.geometry.dispose();
    this.lines.geometry = geo;
    const dg = new THREE.BufferGeometry();
    dg.setAttribute("position", new THREE.Float32BufferAttribute(dpos, 3));
    this.dashed.geometry.dispose();
    this.dashed.geometry = dg;
    this.dashed.computeLineDistances();
  }

  /** The bone under a screen point: a control by its shape's reach, a bone by its tip, head (setup) or length. */
  hit(x: number, y: number): BoneHit | null {
    if (!this.group.visible) return null;
    const setup = this.setup();
    let best: (BoneHit & { d: number }) | null = null;
    const consider = (h: BoneHit, d: number, reach: number) => {
      if (d <= reach && (!best || d < best.d)) best = { ...h, d };
    };
    for (const { rig, pose } of this.shown) {
      for (const b of pose.bones) {
        const head = this.host.toScreen(transformPoint(rig.matrix, b.head));
        const tail = this.host.toScreen(transformPoint(rig.matrix, b.tail));
        if (!head || !tail) continue;
        if (b.bone.shape !== "bone" && !setup) {
          const R = b.bone.size ?? Math.max(4, b.bone.rest.length * 0.35);
          const edge = this.host.toScreen(transformPoint(rig.matrix, transformPoint(b.pose, [0, R, 0])));
          const r = edge ? Math.hypot(edge[0] - head[0], edge[1] - head[1]) : 10;
          consider({ rigId: rig.id, bone: b.id, kind: "control" }, Math.max(0, Math.hypot(x - head[0], y - head[1]) - r), 6);
          continue;
        }
        consider({ rigId: rig.id, bone: b.id, kind: "tip" }, Math.hypot(x - tail[0], y - tail[1]), 9);
        if (setup) consider({ rigId: rig.id, bone: b.id, kind: "head" }, Math.hypot(x - head[0], y - head[1]), 8);
        consider({ rigId: rig.id, bone: b.id, kind: "body" }, segDist(x, y, head, tail) + 2, 8);
      }
    }
    if (!best) return null;
    const { d: _d, ...h } = best as BoneHit & { d: number };
    void _d;
    return h;
  }

  private shownOf(rigId: string): Shown | undefined {
    return this.shown.find((r) => r.rig.id === rigId);
  }

  /** Press on a bone: pick it (and its rig), and start posing or editing it. */
  begin(h: BoneHit, x: number, y: number, extend: boolean, alt = false): void {
    const s = this.shownOf(h.rigId);
    const b = s?.pose.byId.get(h.bone);
    if (!s || !b) return;
    useRigUi.getState().selectBones(h.rigId, [h.bone], extend);
    useSession.getState().select([h.rigId]);
    const at = h.kind === "tip" ? b.tail : b.head;
    const point = transformPoint(s.rig.matrix, at);
    const start = this.host.hitPlane(x, y, point, this.host.forward()) ?? point;
    this.last = null;
    if (this.setup()) {
      // The Bone tool on a free tip: extrude its child from there.
      const free = h.kind === "tip" && !s.pose.bones.some((c) => c.parent === b.id && Math.hypot(c.head[0] - b.tail[0], c.head[1] - b.tail[1], c.head[2] - b.tail[2]) < 1e-3);
      if (useWorldUi.getState().tool === "bone" && (free || alt) && h.kind === "tip") {
        this.grab = { kind: "draw", mode: "draw", rigId: s.rig.id, parent: b.id, matrix: s.rig.matrix, head: point, at: point, click: false };
        return;
      }
      this.grab = { ...h, mode: "setup", at: bonesInRig(s.clip.rig!, false), matrix: s.rig.matrix, start };
      return;
    }
    const time = useSession.getState().playheadMs;
    const local = clipLocalTime(s.clip, time) ?? Math.max(0, time - s.clip.startMs);
    // Measured against the rig as it was (its baked pose), never against a preview.
    const rig = bakeRig(s.clip, local) ?? s.clip.rig!;
    const pose = evaluateRig(rig, { planar: false });
    const ui = useRigUi.getState();
    const chain = h.kind === "control" ? 0 : reachChainLength(rig, h.bone, alt ? 1 : ui.chain, new Set(ui.pins[h.rigId] ?? []));
    this.grab = { ...h, mode: "pose", pose, rig, matrix: s.rig.matrix, start, local, chain };
  }

  /**
   * Draw a new bone from empty space (the Bone tool): its head on the plane
   * through the 3D cursor facing you, into the rig picked or selected — or a
   * new rig around the selected objects. `click` waits for a click to land it
   * (E's extrude follows the pointer with no button held).
   */
  beginDraw(x: number, y: number): void {
    const cursor = useWorldUi.getState().cursor;
    const head = this.host.hitPlane(x, y, cursor, this.host.forward()) ?? cursor;
    const ui = useRigUi.getState();
    const doc = this.host.store.getState();
    const sel = useSession.getState().selectedClipIds;
    const rigId = [ui.rigId, ...sel.map((id) => {
      const c = locateClip(doc, id)?.clip;
      return c?.kind === "group" && c.rig ? c.id : (clipAncestorGroups(doc, id).find((g) => g.rig)?.id ?? null);
    })].find((id): id is string => !!id && !!this.shownOf(id)) ?? null;
    const s = rigId ? this.shownOf(rigId) : undefined;
    const parent = rigId && ui.rigId === rigId ? (ui.bones[ui.bones.length - 1] ?? null) : null;
    this.grab = { kind: "draw", mode: "draw", rigId, parent, matrix: s?.rig.matrix ?? IDENTITY, head, at: head, click: false };
  }

  /** E — a child of the active bone, from its tip, following the pointer until a click. */
  beginExtrude(): boolean {
    const ui = useRigUi.getState();
    const s = ui.rigId ? this.shownOf(ui.rigId) : undefined;
    const b = s && ui.bones.length ? s.pose.byId.get(ui.bones[ui.bones.length - 1]!) : undefined;
    if (!s || !b) return false;
    const tip = transformPoint(s.rig.matrix, b.tail);
    this.grab = { kind: "draw", mode: "draw", rigId: s.rig.id, parent: b.id, matrix: s.rig.matrix, head: tip, at: tip, click: true };
    return true;
  }

  move(x: number, y: number): void {
    const g = this.grab;
    if (!g) return;
    if (g.kind === "draw") {
      g.at = this.host.hitPlane(x, y, g.head, this.host.forward()) ?? g.at;
      return;
    }
    const toRig = invert4(g.matrix);
    if (g.mode === "setup") {
      const at0 = g.at.get(g.bone);
      if (!at0) return;
      const ref = transformPoint(g.matrix, g.kind === "tip" ? at0.tail : at0.head);
      const at = this.host.hitPlane(x, y, ref, this.host.forward());
      if (!at) return;
      const d = transformDir(toRig, sub(at, g.start));
      const rigId = g.rigId, bone = g.bone, all = g.at;
      const kind = g.kind;
      const add = (p: V3): V3 => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
      const recipe = (doc: MotionDocument) => {
        if (kind === "tip") editBone(doc, rigId, bone, { tail: add(at0.tail) }, { children: "stay" });
        else if (kind === "head") {
          editBone(doc, rigId, bone, { head: add(at0.head) }, { children: "stay" });
          // The head of a joined child IS its parent's tip: they move together.
          const rig = (locateClip(doc, rigId)?.clip as GroupClip | undefined)?.rig;
          const parent = rig?.bones.find((x) => x.id === bone)?.parent;
          const up = parent ? all.get(parent) : undefined;
          if (parent && up && Math.hypot(up.tail[0] - at0.head[0], up.tail[1] - at0.head[1], up.tail[2] - at0.head[2]) < 1e-3) editBone(doc, rigId, parent, { tail: add(at0.head) }, { children: "stay" });
        } else editBone(doc, rigId, bone, { head: add(at0.head), tail: add(at0.tail) }, { children: "follow" });
      };
      this.last = { label: kind === "body" ? "Move bone" : "Move joint", recipe };
      this.host.store.setOverlay(recipe);
      return;
    }
    const b = g.pose.byId.get(g.bone);
    if (!b) return;
    const head = transformPoint(g.matrix, b.head);
    const ref = g.kind === "tip" ? transformPoint(g.matrix, b.tail) : head;
    const at = this.host.hitPlane(x, y, ref, this.host.forward());
    if (!at) return;
    const dir = (v: V3) => transformDir(toRig, v);
    const key = useSession.getState().recording;
    let items: Array<{ bone: string; values: Record<string, number> }>;
    let label: string;
    const grammar = useRigUi.getState().grammar;
    if (g.kind === "control" || (g.kind === "body" && !b.parent && b.bone.shape !== "bone")) {
      items = [{ bone: g.bone, values: moveChannels3d(g.pose, g.bone, dir(sub(at, g.start))) }];
      label = "Move bone";
    } else if ((grammar === "reach" || g.kind === "tip") && g.chain > 0) {
      // The tip follows the pointer (offset by where the bone was grabbed); the chain bends.
      const tipW = transformPoint(g.matrix, b.tail);
      const target = transformPoint(toRig, [tipW[0] + at[0] - g.start[0], tipW[1] + at[1] - g.start[1], tipW[2] + at[2] - g.start[2]]);
      items = reachChannels3d(g.rig, g.bone, target, g.chain);
      label = "Reach";
    } else {
      const from = sub(g.start, head);
      const turn = turnBetween(dir(from), dir(sub(at, head)));
      if (!turn) return;
      items = [{ bone: g.bone, values: rotateChannels3d(g.pose, g.bone, turn) }];
      label = "Turn bone";
    }
    const rigId = g.rigId, local = g.local;
    const recipe = (d: MotionDocument) => void poseBones(d, rigId, items, local, { key });
    this.last = { label, recipe };
    this.host.store.setOverlay(recipe);
  }

  /** Release: keep the pose or the edit (one undo step) or drop it. */
  end(keep: boolean): void {
    const g = this.grab;
    const last = this.last;
    this.grab = null;
    this.last = null;
    this.host.store.setOverlay(null);
    if (g?.kind === "draw") {
      if (keep) this.finishDraw(g);
      return;
    }
    if (keep && last) this.host.store.update(last.label, last.recipe);
  }

  private finishDraw(g: Extract<Grab, { kind: "draw" }>): void {
    const a = this.host.toScreen(g.head), b = this.host.toScreen(g.at);
    if (!a || !b || Math.hypot(a[0] - b[0], a[1] - b[1]) < 4) return;
    const frameId = this.host.frameId();
    let made: { rigId: string; bone: string } | null = null;
    this.host.store.update(g.rigId ? "Add bone" : "New rig", (d) => {
      if (g.rigId) {
        const inv = invert4(g.matrix);
        const bone = addBone(d, g.rigId, { head: transformPoint(inv, g.head), tail: transformPoint(inv, g.at), parent: g.parent });
        if (bone) made = { rigId: g.rigId, bone };
        return;
      }
      if (!frameId) return;
      // A new rig around the selected objects of this world (none: an empty rig at the bone).
      const ids = useSession.getState().selectedClipIds.filter((id) => locateClip(d, id)?.clip.frameId === frameId);
      const rigId = createRig(d, frameId, { name: "Armature", memberIds: ids, bones: [{ head: g.head, tail: g.at }] });
      const rig = rigId ? (locateClip(d, rigId)?.clip as GroupClip | undefined) : undefined;
      if (rigId && rig?.rig?.bones[0]) made = { rigId, bone: rig.rig.bones[0].id };
    });
    if (made) {
      const m = made as { rigId: string; bone: string };
      useRigUi.getState().selectBones(m.rigId, [m.bone]);
      useSession.getState().select([m.rigId]);
    }
  }

  // ── The viewport's G / R / S on bones ────────────────────────────────────

  /** The picked bones of a shown rig, ready for a modal — null when none are picked. */
  modalTarget(): BoneModalTarget | null {
    const ui = useRigUi.getState();
    if (!ui.rigId || !ui.bones.length || !useSession.getState().selectedClipIds.includes(ui.rigId)) return null;
    const s = this.shownOf(ui.rigId);
    if (!s) return null;
    const setup = this.setup();
    const time = useSession.getState().playheadMs;
    const local = clipLocalTime(s.clip, time) ?? Math.max(0, time - s.clip.startMs);
    const rig = setup ? restRig(s.clip.rig!) : (bakeRig(s.clip, local) ?? s.clip.rig!);
    const pose = evaluateRig(rig, { planar: false });
    const ids = ui.bones.filter((id) => pose.byId.has(id));
    if (!ids.length) return null;
    const heads = ids.map((id) => transformPoint(s.rig.matrix, pose.byId.get(id)!.head));
    const pivot: V3 = [heads.reduce((a, h) => a + h[0], 0) / heads.length, heads.reduce((a, h) => a + h[1], 0) / heads.length, heads.reduce((a, h) => a + h[2], 0) / heads.length];
    const active = pose.byId.get(ids[ids.length - 1]!)!;
    const axes = mul4(s.rig.matrix, active.pose);
    axes[12] = axes[13] = axes[14] = 0;
    return { rigId: s.rig.id, ids, setup, matrix: s.rig.matrix, pose, at: bonesInRig(s.clip.rig!, false), local, pivot, axes };
  }

  /**
   * The write a modal's world delta `D` makes on its bones. SETUP: every
   * picked bone's head and tail go through D (a turn about the pivot, a
   * stretch from it). POSE: the same change, as channels — a move as x/y/z, a
   * turn as the rotation's part of D, a stretch as `scale` along the bone.
   */
  modalRecipe(t: BoneModalTarget, D: Mat4, kind: "grab" | "rotate" | "scale"): { label: string; recipe: (d: MotionDocument) => void } {
    const toRig = invert4(t.matrix);
    if (t.setup) {
      const local = mul4(mul4(toRig, D), t.matrix);
      const moved = t.ids.map((id) => {
        const at = t.at.get(id)!;
        return { id, head: transformPoint(local, at.head), tail: transformPoint(local, at.tail) };
      });
      const rigId = t.rigId;
      return {
        label: kind === "grab" ? "Move bones" : kind === "rotate" ? "Rotate bones" : "Scale bones",
        recipe: (d) => {
          for (const m of moved) editBone(d, rigId, m.id, { head: m.head, tail: m.tail }, { children: "stay" });
        },
      };
    }
    const items: Array<{ bone: string; values: Record<string, number> }> = [];
    for (const id of t.ids) {
      const s = t.pose.byId.get(id);
      if (!s) continue;
      if (kind === "grab") {
        const h = transformPoint(t.matrix, s.head);
        const moved = transformPoint(D, h);
        items.push({ bone: id, values: moveChannels3d(t.pose, id, transformDir(toRig, sub(moved, h))) });
      } else if (kind === "rotate") {
        const R = mul4(mul4(toRig, D), t.matrix);
        R[12] = R[13] = R[14] = 0;
        items.push({ bone: id, values: rotateChannels3d(t.pose, id, R) });
      } else {
        const h = transformPoint(t.matrix, s.head), tl = transformPoint(t.matrix, s.tail);
        const a = sub(tl, h), b = sub(transformPoint(D, tl), transformPoint(D, h));
        const f = Math.hypot(b[0], b[1], b[2]) / Math.max(1e-9, Math.hypot(a[0], a[1], a[2]));
        items.push({ bone: id, values: { scale: (s.bone.pose?.scale ?? 1) * f } });
      }
    }
    const rigId = t.rigId, local = t.local, key = useSession.getState().recording;
    return {
      label: kind === "grab" ? "Move bones" : kind === "rotate" ? "Rotate bones" : "Stretch bones",
      recipe: (d) => void poseBones(d, rigId, items, local, { key }),
    };
  }

  dispose(): void {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.dashed.geometry.dispose();
    (this.dashed.material as THREE.Material).dispose();
  }
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Screen distance from a point to a segment. */
function segDist(x: number, y: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len > 1e-9 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len)) : 0;
  return Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t));
}

export type { BoneState };
