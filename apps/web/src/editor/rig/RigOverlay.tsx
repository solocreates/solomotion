"use client";

import { bearingOf, cursors, rotateCursor } from "@solomotion/ui/cursors";
import * as React from "react";
import {
  boneColor,
  addBone,
  apply,
  bakeClipAt,
  bakeRig,
  clipBox,
  decide2d,
  invert,
  memberCorners,
  memberOf,
  clipAncestorGroups,
  clipLocalTime,
  connectBone,
  createRig,
  editBone,
  reachChainLength,
  setBoneProps,
  evaluateRig,
  groupChainMatrix,
  groupDeltaMatrix,
  limitChannel,
  locateClip,
  moveChannels,
  multiply,
  beneathPoses,
  poseBones,
  poseEnvAt,
  posedPathsAt,
  type PosedPath,
  reachChannels,
  removeBones,
  stretchChannels,
  turnChannel,
  type MotionDocument,
  type BoneState,
  type Clip,
  type GroupClip,
  type Mat2D,
  type Rig,
  type RigPose,
  type V3,
} from "@solomotion/core";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession, useStageCamera, useParkedPlayhead, useTransportRunning } from "../state/session";
import { editSpaceOf, navSpace, type EditSpace } from "../stage/edit-space";
import { capturePointer } from "../input/capture-pointer";
import { claimPointer, subscribePointerEnd } from "../input/pointer-gestures";
import { accentColor } from "../theme/theme-tokens";
import { clipLocalClamped, commitProperty } from "../inspector/animatable";
import { toast } from "@/lib/toast";
import { useRigUi } from "./state";
import { performFeed, performRelease } from "../perform/state";
import { resolvedDocAt } from "@solomotion/core";

/**
 * BONES ON THE CANVAS — drawn, picked, posed and (with the Bone tool) built.
 *
 * Two modes (`useRigUi.mode`, the Rig section's Pose / Setup switch — Spine's
 * Animate / Setup, Blender's Pose / Edit):
 *
 *   POSE    The art is grabbed by its bone. Two grammars (`useRigUi.grammar`):
 *           REACH (default) — drag a bone or the piece it rides and its tip
 *           follows the pointer while the chain above it bends to let it, up
 *           to `chain` bones ([ and ] change it) and never past a PINNED bone;
 *           a leg follows its foot. ROTATE — the bone turns about its head (FK).
 *           Its tip always reaches (⌥: that bone alone); the piece a root
 *           hangs from carries the whole rig. G / R / S with bones picked.
 *           Right-click a bone: pin, parent, connect.
 *   SETUP   The rig shows at rest (`restView`, a view-only overlay of the
 *           document — the art unbent, every cache invalidated by identity).
 *           Bones and art are adjusted APART: drag a joint and the art stays,
 *           drag a piece and its bone stays. ⌫ removes picked bones. The Bone
 *           tool (J) is setup with drawing: drag on empty canvas to draw a
 *           bone (from a joint: its child; a free tip grows the chain).
 *
 * Every pose write goes through core (`turnChannel`, `reachChannels`,
 * `moveChannels`, `stretchChannels` → `poseBones`): keyed where the channel is
 * keyed or Record is on, the resting pose otherwise — exactly an inspector
 * edit. A gesture previews on the store's overlay and commits ONE undo step.
 *
 * An SVG over the stage, like the tracker's: only bones and knobs take the
 * pointer, so everything else falls through to the stage.
 */

/** A rig, ready to draw: its pose, and how its space lands on the canvas. */
interface Shown {
  rig: GroupClip;
  pose: RigPose;
  space: EditSpace;
  /** The rig's local time at the playhead (what pose writes key at). */
  local: number;
  /** Does it have controls (shaped bones)? Then its deforming bones step back while posing. */
  controls: boolean;
}

/**
 * A gesture in progress. Every one carries the rig AS IT WAS when it began
 * (`pose`, `rig`): the preview rewrites the document on each move, and a
 * gesture measured against the live pose would add its own preview again on
 * every move and run away.
 */
type Grab =
  | { kind: "draw"; rigId: string | null; parent: string | null; head: V3; at: V3 }
  | { kind: "joint"; rigId: string; bone: string; end: "head" | "tail"; start: V3; pose: RigPose }
  | { kind: "shift"; rigId: string; bone: string; start: V3; pose: RigPose }
  | { kind: "turn"; rigId: string; bone: string; start: V3; pose: RigPose }
  | { kind: "reach"; rigId: string; bone: string; chain: number; rig: Rig; offset?: V3 }
  | { kind: "move"; rigId: string; bone: string; start: V3; pose: RigPose }
  /** A layer carried by the pointer — the whole rig in POSE (its anchor piece grabbed), one piece in SETUP. */
  | { kind: "carry"; rigId: string; clipId: string; from: { x: number; y: number }; x0: number; y0: number; inv: Mat2D };

/** A piece of a shown rig, as the canvas sees it: what pressing it grabs, and where it is on screen. */
interface Piece {
  s: Shown;
  unitId: string;
  /** In POSE: the bone it rides, the bones it bends with, or neither (the rig carries it). */
  grabs: { kind: "bone"; bone: string } | { kind: "bend" } | { kind: "rig" };
  /** Its outline, screen px. */
  quad: Array<{ x: number; y: number }>;
}

/** The modal G / R / S, Blender's: follow the pointer, type a value, Enter or click to keep, Esc to drop. */
interface Modal {
  op: "grab" | "rotate" | "scale";
  rigId: string;
  /** The rig as it was when the modal began (see `Grab`). */
  pose: RigPose;
  bones: string[];
  /** Where the pointer was when it began, rig space. */
  from: V3;
  /** The pivot (the picked bones' heads' middle), rig space. */
  pivot: V3;
  axis: "x" | "y" | null;
  typed: string;
}

const SNAP = 10; // screen px within which a press lands on a joint

/** The document as it RESTS: every bone at rest, IK let go — what setup is done against. */
export function restView(d: MotionDocument): void {
  for (const t of d.tracks) {
    for (const c of t.clips) {
      if (c.kind !== "group" || !c.rig) continue;
      if (c.keyframes.some((k) => k.property.startsWith("bone."))) c.keyframes = c.keyframes.filter((k) => !k.property.startsWith("bone."));
      if (c.modulators?.some((m) => m.target.startsWith("bone."))) c.modulators = c.modulators.filter((m) => !m.target.startsWith("bone."));
      if (c.drivers) for (const p of Object.keys(c.drivers)) if (p.startsWith("bone.")) delete c.drivers[p];
      for (const b of c.rig.bones) {
        b.pose = undefined;
        if (b.ik) b.ik.mix = 0;
      }
      // Pose sets move bones too (a Wave pose turns the arm). At rest they
      // must not — else the art waves while the skeleton stands in setup.
      // Their other values (which drawing a switch shows) stay.
      for (const set of c.poses ?? []) for (const p of set.poses) if (p.values.some((v) => v.path.startsWith("bone."))) p.values = p.values.filter((v) => !v.path.startsWith("bone."));
    }
  }
}

/** The rig a layer belongs to (the nearest group with bones above it), or the layer itself when it is one. */
function rigOfClip(doc: MotionDocument, id: string): GroupClip | null {
  const self = locateClip(doc, id)?.clip;
  if (self?.kind === "group" && self.rig) return self;
  return clipAncestorGroups(doc, id).find((g) => !!g.rig) ?? null;
}

/** The outline of a bone: a knob at the head, a long diamond to the tip (Spine's and Blender's silhouette). */
function bonePath(h: { x: number; y: number }, t: { x: number; y: number }): { body: string; r: number } {
  const dx = t.x - h.x, dy = t.y - h.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const w = Math.max(3, Math.min(11, len * 0.11));
  const m = { x: h.x + ux * Math.min(len * 0.18, w * 2.2), y: h.y + uy * Math.min(len * 0.18, w * 2.2) };
  const body = `M${h.x} ${h.y} L${m.x + nx * w} ${m.y + ny * w} L${t.x} ${t.y} L${m.x - nx * w} ${m.y - ny * w} Z`;
  return { body, r: w * 0.85 };
}

export function RigOverlay() {
  // Reads the live stage — drag state, edit spaces, pointer geometry — every
  // render, outside React, by design. Memoising it would freeze the overlay.
  "use no memo";
  const doc = useDoc();
  const store = useDocStore();
  const tool = useSession((s) => s.tool);
  const selected = useSession((s) => s.selectedClipIds);
  const playheadMs = useParkedPlayhead();
  // An editing overlay is for a still frame: the canvas draws the motion.
  const running = useTransportRunning();
  useSession((s) => s.nav);
  useStageCamera();
  const picked = useRigUi((s) => (s.rigId ? s.bones : EMPTY));
  const pickedRig = useRigUi((s) => s.rigId);
  const svgRef = React.useRef<SVGSVGElement>(null);
  const grabRef = React.useRef<Grab | null>(null);
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const [modal, setModal] = React.useState<Modal | null>(null);
  /** Which way the pointer lies from a modal turn's pivot, on screen: the rotate cursor rides it. */
  const [modalBearing, setModalBearing] = React.useState(0);
  /** The bone menu (right-click a bone): where, and on what. */
  const grammar = useRigUi((s) => s.grammar);
  const pins = useRigUi((s) => s.pins);
  const pointerRef = React.useRef<{ x: number; y: number } | null>(null);
  const mode = useRigUi((s) => s.mode);
  /** The Bone tool draws; Setup with any tool adjusts. Both show the rig at rest. */
  const drawing = tool === "bone";
  const setup = drawing || mode === "setup";

  // SETUP shows rigs at rest; leaving the tool shows the pose again.
  React.useEffect(() => {
    if (!setup) return;
    store.setOverlay(restView);
    return () => store.setOverlay(null);
  }, [setup, store]);

  // A LOST pointer (a cancelled touch, a blur, a portal) drops the gesture. The
  // arbiter publishes every end in the capture phase — before this overlay's
  // own pointerup — so an ordinary release is left to `onUp`, which commits.
  React.useEffect(
    () =>
      subscribePointerEnd((_, reason) => {
        if (!grabRef.current || reason === "up") return;
        grabRef.current = null;
        lastRecipe.current = null;
        store.setOverlay(setup ? restView : null);
        redraw();
      }),
    [store, setup],
  );

  const space = navSpace(doc);
  const frame = space?.frame ?? null;

  // Which rigs show: every rig in this comp while building; otherwise the rig
  // of what is selected (a rig, or a layer in one), if it shows its bones.
  const shown: Shown[] = React.useMemo(() => {
    if (!space || !frame || frame.world) return [];
    const compMs = space.ctx.frameTimes.get(frame.id) ?? playheadMs;
    const ids = new Set<string>();
    if (drawing) for (const t of doc.tracks) for (const c of t.clips) if (c.kind === "group" && c.rig && c.frameId === frame.id) ids.add(c.id);
    for (const id of selected) {
      const r = rigOfClip(doc, id);
      if (r && r.frameId === frame.id && r.rig!.showBones) ids.add(r.id);
    }
    if (pickedRig) ids.add(pickedRig);
    const out: Shown[] = [];
    // Bones are drawn where the stage draws them: the resolved instant, with drivers,
    // relations and physics in it (a swinging bone is drawn swinging). At rest in setup.
    const view = setup ? doc : resolvedDocAt(doc, compMs, frame.id);
    for (const id of ids) {
      const rig = locateClip(view, id)?.clip;
      if (rig?.kind !== "group" || !rig.rig || rig.frameId !== frame.id) continue;
      const local = clipLocalTime(rig, compMs) ?? clipLocalClamped(rig, playheadMs);
      const localOf = (c: Clip) => clipLocalTime(c, compMs) ?? 0;
      const delta = groupDeltaMatrix(view, rig, local);
      const chain = groupChainMatrix(view, rig.id, localOf);
      const pre: Mat2D = delta ? multiply(chain, delta) : chain;
      const baked = bakeRig(rig, local) ?? rig.rig;
      out.push({ rig, pose: evaluateRig(baked, { planar: true }), space: editSpaceOf(space.ctx, pre), local, controls: rig.rig.bones.some((b) => b.shape !== "bone") });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, space?.ctx, frame, selected, drawing, setup, pickedRig, playheadMs]);

  // Every piece of every shown rig, top layer last (painted last = pressed first),
  // for the Select tool: in POSE pressing a piece grabs its bone, in SETUP the piece.
  const pieces: Piece[] = React.useMemo(() => {
    if (drawing || tool !== "select" || !space || !frame) return [];
    const compMs = space.ctx.frameTimes.get(frame.id) ?? playheadMs;
    const localOf = (c: Clip) => clipLocalTime(c, compMs) ?? 0;
    const out: Piece[] = [];
    const view = setup ? doc : resolvedDocAt(doc, compMs, frame.id);
    // ENTERED PARTS EDIT LIKE ANY LAYER. Once a double-click has landed on a
    // part (it, or something inside it, is selected), its presses belong to
    // the stage — move it, resize it, double-click again into its outline —
    // while every bone stays grabbable by its own handle. Leaving is the
    // stage's usual way out: Esc or a click elsewhere selects the character.
    const entered = new Set<string>();
    for (const id of selected) {
      if (rigOfClip(view, id)?.id === id) continue;
      entered.add(id);
      for (const g of clipAncestorGroups(view, id)) entered.add(g.id);
    }
    for (const s of shown) {
      for (let ti = view.tracks.length - 1; ti >= 0; ti--) {
        for (const c of view.tracks[ti]!.clips) {
          if (c.frameId !== frame.id || c.kind === "audio" || c.hidden || view.tracks[ti]!.hidden) continue;
          if (entered.has(c.id)) continue;
          const m = memberOf(view, c.id);
          if (!m || m.rig.id !== s.rig.id || m.unit.id !== c.id || clipLocalTime(c, compMs) === null) continue;
          const d = decide2d(view, m, s.pose);
          const grabs: Piece["grabs"] = d.kind === "rigid" && d.bone ? { kind: "bone", bone: d.bone } : d.kind === "smooth" ? { kind: "bend" } : { kind: "rig" };
          const baked = bakeClipAt(c, localOf(c));
          const chain = groupChainMatrix(view, c.id, localOf);
          const quad = memberCorners(baked, clipBox(view, c), baked.transform).map((q) => space.toScreen(apply(chain, q)));
          out.push({ s, unitId: c.id, grabs, quad });
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, drawing, setup, tool, doc, space?.ctx, frame, playheadMs, selected]);

  const toRig = React.useCallback(
    (s: Shown, e: { clientX: number; clientY: number }): V3 => {
      const r = svgRef.current!.getBoundingClientRect();
      const p = s.space.fromScreen({ x: e.clientX - r.left, y: e.clientY - r.top });
      return [p.x, p.y, 0];
    },
    [],
  );

  // ── Writes ───────────────────────────────────────────────────────────────

  /** Preview a pose write on the overlay (one gesture = one undo step on release). */
  const preview = (recipe: (d: MotionDocument) => void) => store.setOverlay((d) => (setup && restView(d), recipe(d)));
  const commit = (label: string, recipe: (d: MotionDocument) => void) => {
    store.setOverlay(setup ? restView : null);
    store.update(label, recipe);
  };
  const recording = () => useSession.getState().recording;
  const lastRecipe = React.useRef<{ label: string; recipe: (d: MotionDocument) => void } | null>(null);
  const live = (label: string, recipe: (d: MotionDocument) => void) => {
    lastRecipe.current = { label, recipe };
    preview(recipe);
  };
  /**
   * What the poses on a rig bring at this instant — walked once per gesture
   * (time stands still while you drag), from the COMMITTED document: the
   * preview only rewrites your own layer, which a pose's contribution does not
   * read.
   */
  const posedRef = React.useRef<{ key: string; posed: Map<string, PosedPath> } | null>(null);
  const posedFor = (rigId: string, local: number): Map<string, PosedPath> => {
    const raw = store.getState();
    const rig = locateClip(raw, rigId)?.clip;
    if (!rig) return new Map();
    const compMs = rig.startMs + local;
    const key = `${rigId}|${compMs}`;
    if (posedRef.current?.key !== key) {
      const fid = rig.frameId;
      posedRef.current = { key, posed: posedPathsAt(raw, compMs, fid, poseEnvAt(raw, compMs, fid)) };
    }
    return posedRef.current.posed;
  };
  /**
   * A pose gesture's values — what the bones should SHOW — written to your own
   * layer beneath any pose (`beneathPoses`), so a drag over a waving arm puts
   * the arm under your hand and the wave stays a wave. Perform takes them while
   * it is on (it owns when they land); otherwise a live preview.
   */
  const livePose = (label: string, rigId: string, shown: Array<{ bone: string; values: Record<string, number> }>, local: number) => {
    const items = beneathPoses(posedFor(rigId, local), rigId, shown);
    const values: Record<string, number> = {};
    for (const it of items) for (const [ch, v] of Object.entries(it.values)) if (typeof v === "number") values[`bone.${it.bone}.${ch}`] = v;
    if (performFeed(rigId, values)) return void (lastRecipe.current = null);
    live(label, (d) => poseBones(d, rigId, items, local, { key: recording() }));
  };

  // ── Gestures ─────────────────────────────────────────────────────────────

  const shownOf = (rigId: string | null) => shown.find((s) => s.rig.id === rigId) ?? null;

  /** The joint nearest a screen point, within SNAP: which bone, which end. */
  const jointAt = (sx: number, sy: number): { s: Shown; bone: BoneState; end: "head" | "tail" } | null => {
    let best: { s: Shown; bone: BoneState; end: "head" | "tail"; d: number } | null = null;
    for (const s of shown) {
      for (const b of s.pose.bones) {
        for (const end of ["tail", "head"] as const) {
          const p = s.space.toScreen({ x: b[end][0], y: b[end][1] });
          const d = Math.hypot(p.x - sx, p.y - sy);
          if (d <= SNAP && (!best || d < best.d)) best = { s, bone: b, end, d };
        }
      }
    }
    return best;
  };

  const begin = (e: React.PointerEvent, g: Grab) => {
    e.stopPropagation();
    e.preventDefault();
    claimPointer(e.pointerId, "drag");
    // On the pressed element: moves then bubble to the overlay's handlers even
    // where the overlay itself takes no pointer (posing over the stage).
    capturePointer(e.target as Element, e.pointerId);
    grabRef.current = g;
    lastRecipe.current = null;
    posedRef.current = null;
    redraw();
  };

  /** A press on empty canvas with the Bone tool: a new bone starts here. */
  const onSurfaceDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !space) return;
    const r = svgRef.current!.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const hit = jointAt(sx, sy);
    const target = hit?.s ?? shownOf(pickedRig) ?? shownOf(selected.map((id) => rigOfClip(doc, id)?.id ?? "").find(Boolean) ?? null);
    const at: V3 = target ? toRig(target, e) : ((p) => [p.x, p.y, 0] as V3)(space.fromScreen({ x: sx, y: sy }));
    // From a joint: the new bone starts exactly there, and is the child of the bone whose tip it is.
    const head: V3 = hit ? [hit.bone[hit.end][0], hit.bone[hit.end][1], 0] : at;
    const parent = hit ? (hit.end === "tail" ? hit.bone.id : hit.bone.parent) : (target && pickedRig === target.rig.id ? (picked[picked.length - 1] ?? null) : null);
    begin(e, { kind: "draw", rigId: target?.rig.id ?? null, parent, head, at: head });
  };

  /**
   * REACH from `bone`: its tip follows the pointer (offset by where it was
   * grabbed), the chain above it bends — as many bones as the chain length
   * allows, stopping below a pinned one. False when the bone itself is pinned.
   */
  const startReach = (e: React.PointerEvent, s: Shown, bone: BoneState, start: V3, only = false): boolean => {
    const ui = useRigUi.getState();
    const rig = bakeRig(s.rig, s.local) ?? s.rig.rig!;
    const chain = reachChainLength(rig, bone.id, only ? 1 : ui.chain, new Set(ui.pins[s.rig.id] ?? []));
    if (chain === 0) {
      toast("Pinned — right-click to unpin it");
      return false;
    }
    begin(e, { kind: "reach", rigId: s.rig.id, bone: bone.id, chain, rig, offset: [bone.tail[0] - start[0], bone.tail[1] - start[1], 0] });
    return true;
  };

  const onBoneDown = (e: React.PointerEvent, s: Shown, bone: BoneState) => {
    if (e.button === 2) return;
    if (e.button !== 0) return;
    const ui = useRigUi.getState();
    ui.selectBones(s.rig.id, [bone.id], e.shiftKey);
    useSession.getState().select([s.rig.id]);
    const start = toRig(s, e);
    if (setup) return begin(e, { kind: "shift", rigId: s.rig.id, bone: bone.id, start, pose: s.pose });
    // A CONTROL is grabbed to move it (an IK target, a slider's knob, a pad's
    // dot) — unless its move is locked, when grabbing it turns it (a dial).
    const moves = isControl(bone) && !moveLocked(bone);
    if (!moves && useRigUi.getState().grammar === "reach" && !e.altKey) {
      startReach(e, s, bone, start);
      return;
    }
    begin(e, { kind: moves ? "move" : "turn", rigId: s.rig.id, bone: bone.id, start, pose: s.pose });
  };

  const onKnobDown = (e: React.PointerEvent, s: Shown, bone: BoneState, end: "head" | "tail") => {
    if (e.button !== 0) return;
    if (drawing) {
      // A FREE tip grows the chain (the next bone starts there, its child); a
      // joint something already hangs off moves. ⌥ always draws a new bone.
      const free = end === "tail" && !s.pose.bones.some((b) => b.parent === bone.id && Math.hypot(b.head[0] - bone.tail[0], b.head[1] - bone.tail[1]) < 1e-3);
      if (free || e.altKey) {
        const at = end === "tail" ? bone.tail : bone.head;
        begin(e, { kind: "draw", rigId: s.rig.id, parent: end === "tail" ? bone.id : bone.parent, head: [at[0], at[1], 0], at: [at[0], at[1], 0] });
        return;
      }
    }
    useRigUi.getState().selectBones(s.rig.id, [bone.id], e.shiftKey);
    useSession.getState().select([s.rig.id]);
    if (setup) begin(e, { kind: "joint", rigId: s.rig.id, bone: bone.id, end, start: toRig(s, e), pose: s.pose });
    else if (end === "tail") startReach(e, s, bone, [bone.tail[0], bone.tail[1], 0], e.altKey);
    else {
      // A root's head sitting on art the rig carries is that art's joint: moving it
      // alone would tear the bone off the piece it hangs from. It carries the rig.
      const h = s.space.toScreen({ x: bone.head[0], y: bone.head[1] });
      const anchor = pieces.find((p) => p.s.rig.id === s.rig.id && p.grabs.kind === "rig" && insideQuad(p.quad, h));
      if (anchor) return onPieceDown(e, anchor);
      begin(e, { kind: "move", rigId: s.rig.id, bone: bone.id, start: toRig(s, e), pose: s.pose });
    }
  };

  /**
   * A press on a piece of art. POSE: the bone it rides turns about its joint
   * (a bending piece: the bone nearest the press); the piece a root hangs from
   * carries the whole rig. SETUP: the piece moves on its own, its bone stays.
   * A double-click selects the layer itself (its own panels, text editing).
   */
  const onPieceDown = (e: React.PointerEvent, p: Piece) => {
    if (e.button !== 0) return;
    if (e.detail >= 2) {
      e.stopPropagation();
      useSession.getState().select([p.unitId]);
      return;
    }
    const { s } = p;
    const carry = (clipId: string) => {
      const d = doc;
      const c = locateClip(d, clipId)?.clip;
      if (!c || c.kind === "audio") return;
      const compMs = space!.ctx.frameTimes.get(frame!.id) ?? playheadMs;
      const localOf = (x: Clip) => clipLocalTime(x, compMs) ?? 0;
      const baked = bakeClipAt(c, clipLocalClamped(c, playheadMs));
      const chain = groupChainMatrix(d, c.id, localOf);
      const r = svgRef.current!.getBoundingClientRect();
      begin(e, { kind: "carry", rigId: s.rig.id, clipId, from: space!.fromScreen({ x: e.clientX - r.left, y: e.clientY - r.top }), x0: baked.transform.x, y0: baked.transform.y, inv: invert({ ...chain, e: 0, f: 0 }) ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } });
    };
    if (setup) {
      useSession.getState().select([p.unitId]);
      return carry(p.unitId);
    }
    useSession.getState().select([s.rig.id]);
    if (p.grabs.kind === "rig") {
      useRigUi.getState().selectBones(s.rig.id, []);
      return carry(s.rig.id);
    }
    const at = toRig(s, e);
    const bone = p.grabs.kind === "bone" ? s.pose.byId.get(p.grabs.bone) : nearestBoneTo(s.pose, at);
    if (!bone) return;
    useRigUi.getState().selectBones(s.rig.id, [bone.id], e.shiftKey);
    if (useRigUi.getState().grammar === "reach" && !e.altKey && startReach(e, s, bone, at)) return;
    begin(e, { kind: "turn", rigId: s.rig.id, bone: bone.id, start: at, pose: s.pose });
  };

  const onMove = (e: React.PointerEvent) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (r) pointerRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (modal) return void runModal(modal, e);
    const g = grabRef.current;
    if (!g) return;
    const s = shownOf(g.rigId);
    if (g.kind === "draw") {
      const at: V3 = s ? toRig(s, e) : ((p) => [p.x, p.y, 0] as V3)(space!.fromScreen(pointerRef.current!));
      grabRef.current = { ...g, at: e.shiftKey ? snapAngle(g.head, at) : at };
      redraw();
      return;
    }
    if (g.kind === "carry") {
      const p = space!.fromScreen(pointerRef.current!);
      const delta = apply(g.inv, { x: p.x - g.from.x, y: p.y - g.from.y });
      live(g.clipId === g.rigId ? "Move rig" : "Move piece", (d) => {
        const c = locateClip(d, g.clipId)?.clip;
        if (!c) return;
        const ms = useSession.getState().playheadMs;
        commitProperty(c, "x", g.x0 + delta.x, ms);
        commitProperty(c, "y", g.y0 + delta.y, ms);
      });
      return;
    }
    if (!s) return;
    const now = toRig(s, e);
    const rigId = g.rigId;
    const pose0 = g.kind === "reach" ? evaluateRig(g.rig, { planar: true }) : g.pose;
    const bone = pose0.byId.get(g.bone);
    if (!bone) return;
    if (g.kind === "joint") {
      const p: V3 = [now[0], now[1], 0];
      live("Move joint", (d) => {
        editBone(d, rigId, g.bone, g.end === "tail" ? { tail: p } : { head: p }, { children: "stay" });
        // The head of a joined child IS its parent's tip: move them together.
        if (g.end === "head" && bone.parent) {
          const up = pose0.byId.get(bone.parent)!;
          if (Math.hypot(up.tail[0] - bone.head[0], up.tail[1] - bone.head[1]) < 1e-3) editBone(d, rigId, up.id, { tail: p }, { children: "stay" });
        }
      });
    } else if (g.kind === "shift") {
      const dx = now[0] - g.start[0], dy = now[1] - g.start[1];
      live("Move bone", (d) => editBone(d, rigId, g.bone, { head: [bone.head[0] + dx, bone.head[1] + dy, 0], tail: [bone.tail[0] + dx, bone.tail[1] + dy, 0] }, { children: "follow" }));
    } else if (g.kind === "turn") {
      let delta = angleAbout(bone.head, g.start, now);
      if (e.shiftKey) delta = Math.round((worldAngleOf(bone) + delta) / 15) * 15 - worldAngleOf(bone);
      const rotation = turnChannel(pose0, g.bone, delta);
      livePose("Turn bone", rigId, [{ bone: g.bone, values: { rotation } }], s.local);
    } else if (g.kind === "reach") {
      const target: V3 = g.offset ? [now[0] + g.offset[0], now[1] + g.offset[1], 0] : now;
      const rots = reachChannels(unik(g.rig), g.bone, target, g.chain);
      livePose("Reach", rigId, rots.map((x) => ({ bone: x.bone, values: { rotation: x.rotation } })), s.local);
    } else if (g.kind === "move") {
      const vals = moveChannels(pose0, g.bone, [now[0] - g.start[0], now[1] - g.start[1], 0]);
      livePose("Move bone", rigId, [{ bone: g.bone, values: vals }], s.local);
    }
  };

  const onUp = (e: React.PointerEvent) => {
    if (modal) return;
    const g = grabRef.current;
    grabRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    if (g?.kind === "draw") return void finishDraw(g);
    // A performed gesture is Perform's to write (one take, one undo step).
    if (g && performRelease()) {
      lastRecipe.current = null;
      return void redraw();
    }
    const last = lastRecipe.current;
    lastRecipe.current = null;
    if (last) commit(last.label, last.recipe);
    redraw();
  };

  /** A drawn bone, kept — into the rig it was drawn for, or a new rig around the selected art. */
  const finishDraw = (g: Extract<Grab, { kind: "draw" }>) => {
    const sp = shownOf(g.rigId)?.space ?? space;
    const a = sp?.toScreen({ x: g.head[0], y: g.head[1] });
    const b = sp?.toScreen({ x: g.at[0], y: g.at[1] });
    const short = !a || !b || Math.hypot(a.x - b.x, a.y - b.y) < 4;
    if (short) {
      useRigUi.getState().selectBones(null, []);
      redraw();
      return;
    }
    let made: { rigId: string; bone: string } | null = null;
    store.setOverlay(setup ? restView : null);
    store.update(g.rigId ? "Add bone" : "Make rig", (d) => {
      let rigId = g.rigId;
      if (!rigId) {
        // The art you had selected goes in with its first bone.
        const art = selected.filter((id) => {
          const c = locateClip(d, id)?.clip;
          return !!c && c.kind !== "audio" && c.frameId === frame!.id && !rigOfClip(d, id);
        });
        rigId = art.length ? createRig(d, frame!.id, { memberIds: art }) : null;
        if (rigId) {
          const bone = addBone(d, rigId, { head: g.head, tail: g.at, parent: null });
          if (bone) made = { rigId, bone };
          return;
        }
        rigId = createRig(d, frame!.id, { bones: [{ head: g.head, tail: g.at, parent: null }] });
        const gr = rigId ? (locateClip(d, rigId)?.clip as GroupClip | undefined) : undefined;
        if (rigId && gr?.rig?.bones[0]) made = { rigId, bone: gr.rig.bones[0].id };
        return;
      }
      const bone = addBone(d, rigId, { head: g.head, tail: g.at, parent: g.parent });
      if (bone) made = { rigId, bone };
    });
    const m = made as { rigId: string; bone: string } | null;
    if (m) {
      useRigUi.getState().selectBones(m.rigId, [m.bone]);
      useSession.getState().select([m.rigId]);
      if (!g.rigId) toast("Rig made — keep drawing from a bone's tip to chain the next one");
    }
    redraw();
  };

  // ── G / R / S ────────────────────────────────────────────────────────────

  const runModal = (m: Modal, e: { clientX: number; clientY: number; shiftKey?: boolean }) => {
    const s = shownOf(m.rigId);
    if (!s) return;
    const now = toRig(s, e);
    if (m.op === "rotate") {
      const c = s.space.toScreen({ x: m.pivot[0], y: m.pivot[1] });
      const at = s.space.toScreen({ x: now[0], y: now[1] });
      setModalBearing(bearingOf(at.x - c.x, at.y - c.y));
    }
    const typed = m.typed && m.typed !== "-" ? Number(m.typed) : NaN;
    const items: Array<{ bone: string; values: Record<string, number> }> = [];
    const pose0 = m.pose;
    for (const id of m.bones) {
      if (!pose0.byId.has(id)) continue;
      if (m.op === "rotate") {
        let delta = Number.isFinite(typed) ? typed : angleAbout(m.pivot, m.from, now);
        if (e.shiftKey && !Number.isFinite(typed)) delta = Math.round(delta / 5) * 5;
        items.push({ bone: id, values: { rotation: turnChannel(pose0, id, delta) } });
      } else if (m.op === "grab") {
        let dx = now[0] - m.from[0], dy = now[1] - m.from[1];
        if (Number.isFinite(typed)) (dx = m.axis === "y" ? 0 : typed), (dy = m.axis === "y" ? typed : 0);
        if (m.axis === "x") dy = 0;
        if (m.axis === "y") dx = 0;
        items.push({ bone: id, values: moveChannels(pose0, id, [dx, dy, 0]) });
      } else {
        const d0 = Math.hypot(m.from[0] - m.pivot[0], m.from[1] - m.pivot[1]) || 1;
        const k = Number.isFinite(typed) ? typed : Math.hypot(now[0] - m.pivot[0], now[1] - m.pivot[1]) / d0;
        const v = stretchChannels(pose0, id, k, m.axis ?? "both");
        items.push({ bone: id, values: Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "number")) as Record<string, number> });
      }
    }
    const label = m.op === "rotate" ? "Rotate bones" : m.op === "grab" ? "Move bones" : "Stretch bones";
    live(label, (d) => poseBones(d, m.rigId, items, s.local, { key: recording() }));
  };

  const endModal = (keep: boolean) => {
    setModal(null);
    const last = lastRecipe.current;
    lastRecipe.current = null;
    if (keep && last) commit(last.label, last.recipe);
    else store.setOverlay(setup ? restView : null);
  };

  // Keys: G R S with bones picked and the pointer over the stage (Blender's
  // rule — the keys belong to the editor under the mouse); ⌫ removes bones while
  // building; Esc leaves the Bone tool. Capture phase, so the app's own G (the
  // bucket) and R (record) stand down only when a bone modal takes the key.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      const ui = useRigUi.getState();
      const p = pointerRef.current;
      const over = !!p && !!svgRef.current && p.x >= 0 && p.y >= 0 && p.x <= svgRef.current.clientWidth && p.y <= svgRef.current.clientHeight;
      const k = e.key.toLowerCase();
      if (modal) {
        e.preventDefault();
        e.stopPropagation();
        if (k === "escape") return endModal(false);
        if (k === "enter") return endModal(true);
        if (k === "x" || k === "y") return setModal({ ...modal, axis: modal.axis === k ? null : k });
        if (/^[0-9.]$/.test(k) || (k === "-" && !modal.typed)) return setModal({ ...modal, typed: modal.typed + k });
        if (k === "backspace") return setModal({ ...modal, typed: modal.typed.slice(0, -1) });
        return;
      }
      // PARENTING (Blender's): ⌘/Ctrl+P parents the picked bones to the active
      // one, keeping each where it is (⇧ also connects them to its tip);
      // ⌥P clears their parent. Rest is setup, so it is a setup verb.
      if (setup && k === "p" && (e.metaKey || e.ctrlKey || e.altKey) && ui.rigId && ui.bones.length) {
        e.preventDefault();
        e.stopPropagation();
        const rigId = ui.rigId, ids = ui.bones.slice();
        const active = ids[ids.length - 1]!;
        if (e.altKey) {
          store.setOverlay(restView);
          store.update("Clear parent", (d) => ids.forEach((id) => void setBoneProps(d, rigId, id, { parent: null })));
        } else if (ids.length > 1) {
          store.setOverlay(restView);
          store.update(e.shiftKey ? "Parent and connect" : "Parent bones", (d) =>
            ids.slice(0, -1).forEach((id) => {
              setBoneProps(d, rigId, id, { parent: active });
              if (e.shiftKey) connectBone(d, rigId, id);
            }),
          );
        } else toast("Pick the children, then the parent last (⇧-click), then ⌘P");
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!setup && over && (k === "[" || k === "]")) {
        e.preventDefault();
        const next = useRigUi.getState().chain + (k === "]" ? 1 : -1);
        useRigUi.getState().setChain(next);
        toast(`Reach bends ${Math.max(1, Math.min(16, next))} bone${next === 1 ? "" : "s"}`);
        return;
      }
      if (setup && k === "escape") {
        e.preventDefault();
        // Out of setup: the Bone tool hands back to Select, the mode to Pose.
        if (drawing) useSession.getState().setTool("select");
        else useRigUi.getState().setMode("pose");
        return;
      }
      if (setup && (k === "backspace" || k === "delete") && ui.rigId && ui.bones.length) {
        e.preventDefault();
        e.stopPropagation();
        const rigId = ui.rigId, ids = ui.bones;
        store.setOverlay(restView);
        store.update("Delete bones", (d) => void removeBones(d, rigId, ids));
        ui.selectBones(null, []);
        return;
      }
      if (!over || !ui.rigId || !ui.bones.length || setup) return;
      const op = k === "g" ? "grab" : k === "r" ? "rotate" : k === "s" ? "scale" : null;
      if (!op) return;
      const s = shownOf(ui.rigId);
      if (!s || !p) return;
      e.preventDefault();
      e.stopPropagation();
      const heads = ui.bones.map((id) => s.pose.byId.get(id)?.head).filter((h): h is V3 => !!h);
      if (!heads.length) return;
      const pivot: V3 = [heads.reduce((a, h) => a + h[0], 0) / heads.length, heads.reduce((a, h) => a + h[1], 0) / heads.length, 0];
      const r = svgRef.current!.getBoundingClientRect();
      const from = toRig(s, { clientX: r.left + p.x, clientY: r.top + p.y });
      lastRecipe.current = null;
      setModal({ op, rigId: ui.rigId, pose: s.pose, bones: ui.bones.slice(), from, pivot, axis: null, typed: "" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, shown, setup]);

  // A typed value or an axis changes the modal at once, not on the next move.
  React.useEffect(() => {
    if (!modal || !pointerRef.current || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    runModal(modal, { clientX: r.left + pointerRef.current.x, clientY: r.top + pointerRef.current.y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal?.typed, modal?.axis]);

  // ── Draw ─────────────────────────────────────────────────────────────────

  if (running || !space || !frame || frame.world || (!shown.length && !drawing)) return null;
  const accent = accentColor();
  const g = grabRef.current;

  return (
    <svg
      ref={svgRef}
      className="absolute inset-0 h-full w-full"
      style={{ pointerEvents: drawing || modal ? "auto" : "none", cursor: drawing ? cursors.crosshair : modal ? (modal.op === "rotate" ? rotateCursor(modalBearing) : cursors.move) : undefined }}
      data-rig-overlay
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerDown={(e) => {
        if (modal) {
          e.preventDefault();
          e.stopPropagation();
          return endModal(e.button === 0);
        }
        if (drawing && e.target === svgRef.current) onSurfaceDown(e);
      }}
      onContextMenu={(e) => modal && e.preventDefault()}
    >
      {/* The art, grabbable — under the bones, so a bone or a joint always wins its own pixels. */}
      {pieces.map((p) => (
        <polygon
          key={`${p.s.rig.id}:${p.unitId}`}
          points={p.quad.map((q) => `${q.x},${q.y}`).join(" ")}
          fill="transparent"
          stroke={accent}
          strokeOpacity={0}
          strokeWidth={1.25}
          strokeDasharray="4 3"
          className="transition-[stroke-opacity] duration-100 hover:[stroke-opacity:0.7]"
          style={{ pointerEvents: "auto", cursor: setup || p.grabs.kind === "rig" ? cursors.move : cursors.grab }}
          data-rig-piece={p.unitId}
          onPointerDown={(e) => onPieceDown(e, p)}
        />
      ))}
      {shown.map((s) => (
        <g key={s.rig.id}>
          {/* PARENTING you can see: a child whose head is not at its parent's tip
              hangs off it by a dashed line (Blender's relationship line). */}
          {s.pose.bones.map((b) => {
            if (!b.parent) return null;
            const up = s.pose.byId.get(b.parent);
            if (!up) return null;
            const gap = Math.hypot(up.tail[0] - b.head[0], up.tail[1] - b.head[1]);
            if (gap <= Math.max(1e-3, up.bone.rest.length * 1e-3)) return null;
            const a = s.space.toScreen({ x: up.tail[0], y: up.tail[1] });
            const c = s.space.toScreen({ x: b.head[0], y: b.head[1] });
            return <line key={`rel${b.id}`} x1={a.x} y1={a.y} x2={c.x} y2={c.y} stroke="#ffffff" strokeOpacity={setup ? 0.7 : 0.35} strokeWidth={1} strokeDasharray="2 3" pointerEvents="none" />;
          })}
          {/* Pinned bones: a nail at the head. */}
          {(pins[s.rig.id] ?? []).map((id) => {
            const b = s.pose.byId.get(id);
            if (!b) return null;
            const h = s.space.toScreen({ x: b.head[0], y: b.head[1] });
            return (
              <g key={`pin${id}`} pointerEvents="none">
                <circle cx={h.x} cy={h.y} r={7} fill="none" stroke={accent} strokeWidth={2} />
                <circle cx={h.x} cy={h.y} r={2} fill={accent} />
              </g>
            );
          })}
          {/* IK reach: a dashed line from the chain's tip to what it reaches for. */}
          {s.pose.bones
            .filter((b) => b.bone.ik)
            .map((b) => {
              const t = s.pose.byId.get(b.bone.ik!.target);
              if (!t) return null;
              const a = s.space.toScreen({ x: b.tail[0], y: b.tail[1] });
              const c = s.space.toScreen({ x: t.head[0], y: t.head[1] });
              return <line key={`ik${b.id}`} x1={a.x} y1={a.y} x2={c.x} y2={c.y} stroke={accent} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} pointerEvents="none" />;
            })}
          {/* What each limited control may reach: a slider's track, a pad's box, a joint's arc. */}
          {!setup &&
            s.pose.bones.map((b) => {
              const on = s.rig.id === pickedRig && picked.includes(b.id);
              const reach = limitGuide(s, b, on);
              if (!reach) return null;
              const tint = boneColor(b.bone) ?? (isControl(b) ? CONTROL : "#ffffff");
              return (
                <path key={`lim${b.id}`} d={reach} fill={tint} fillOpacity={0.06} stroke={tint} strokeOpacity={on ? 0.75 : 0.45} strokeWidth={1} strokeDasharray="2 3" strokeLinecap="round" pointerEvents="none" />
              );
            })}
          {s.pose.bones.map((b) => {
            const h = s.space.toScreen({ x: b.head[0], y: b.head[1] });
            const t = s.space.toScreen({ x: b.tail[0], y: b.tail[1] });
            const on = s.rig.id === pickedRig && picked.includes(b.id);
            const active = on && picked[picked.length - 1] === b.id;
            if (!setup && b.bone.shape !== "bone") {
              const tint = on ? accent : (boneColor(b.bone) ?? CONTROL);
              return (
                <path
                  key={b.id}
                  d={controlPath(s, b)}
                  fill={tint}
                  fillOpacity={on ? 0.28 : 0.12}
                  stroke={tint}
                  strokeWidth={active ? 2.25 : 1.75}
                  strokeLinejoin="round"
                  style={{ pointerEvents: "auto", cursor: moveLocked(b) ? rotateCursor(boneBearing(s, b)) : cursors.grab }}
                  onPointerDown={(e) => onBoneDown(e, s, b)}
                >
                  <title>{b.bone.name}</title>
                </path>
              );
            }
            const { body, r } = bonePath(h, t);
            const control = !b.bone.deform;
            // With controls to animate by, the skeleton steps back: a person grabs the handles.
            const quiet = !setup && !on && s.controls && b.bone.deform;
            return (
              <g key={b.id} opacity={quiet ? 0.35 : 1}>
                <path
                  d={body}
                  fill={on ? accent : (boneColor(b.bone) ?? "#ffffff")}
                  fillOpacity={control ? 0 : on ? 0.55 : 0.22}
                  stroke={on ? accent : "#0c0c0f"}
                  strokeOpacity={on ? 1 : 0.85}
                  strokeWidth={active ? 2 : 1.25}
                  strokeDasharray={control ? "4 3" : undefined}
                  strokeLinejoin="round"
                  style={{ pointerEvents: "auto", cursor: setup ? cursors.move : cursors.grab }}
                  data-rig-bone={b.id}
                  data-rig-id={s.rig.id}
                  onPointerDown={(e) => onBoneDown(e, s, b)}
                  onContextMenu={() => {
                    // Pick it and let the press reach the canvas menu: one menu,
                    // the bone's verbs at its head (character/character-menu).
                    if (!picked.includes(b.id) || pickedRig !== s.rig.id) useRigUi.getState().selectBones(s.rig.id, [b.id]);
                    useSession.getState().select([s.rig.id]);
                  }}
                >
                  <title>{b.bone.name}</title>
                </path>
                <circle cx={h.x} cy={h.y} r={r} fill={on ? accent : "#ffffff"} fillOpacity={0.9} stroke="#0c0c0f" strokeWidth={1} style={{ pointerEvents: setup || (on && !b.parent) ? "auto" : "none", cursor: cursors.move }} onPointerDown={(e) => onKnobDown(e, s, b, "head")} />
                {(setup || on) && (
                  <circle
                    cx={t.x}
                    cy={t.y}
                    r={Math.max(3.5, r * 0.75)}
                    fill="#0c0c0f"
                    stroke={on ? accent : "#ffffff"}
                    strokeWidth={1.5}
                    style={{ pointerEvents: "auto", cursor: setup ? cursors.move : cursors.crosshair }}
                    onPointerDown={(e) => onKnobDown(e, s, b, "tail")}
                  >
                    <title>{setup ? "Drag to move this joint" : "Drag to reach (⌥: this bone only)"}</title>
                  </circle>
                )}
              </g>
            );
          })}
        </g>
      ))}
      {/* The bone being drawn. */}
      {g?.kind === "draw" &&
        (() => {
          const s = shownOf(g.rigId);
          const map = (p: V3) => (s ? s.space.toScreen({ x: p[0], y: p[1] }) : space.toScreen({ x: p[0], y: p[1] }));
          const { body, r } = bonePath(map(g.head), map(g.at));
          const h = map(g.head);
          return (
            <g pointerEvents="none">
              <path d={body} fill={accent} fillOpacity={0.4} stroke={accent} strokeWidth={1.5} />
              <circle cx={h.x} cy={h.y} r={r} fill={accent} />
            </g>
          );
        })()}
      {!setup && !modal && pickedRig && (
        <text x={12} y={20} fill="currentColor" fontSize={11} className="text-muted-foreground" style={{ userSelect: "none" }} pointerEvents="none">
          {grammar === "reach" ? `Reach · ${useRigUi.getState().chain} bones — [ ] to change, ⌥-drag turns one bone` : "Rotate — drag a bone to turn it"}
        </text>
      )}
      {modal && (
        <text x={12} y={20} fill="currentColor" fontSize={12} className="text-foreground" style={{ userSelect: "none" }}>
          {modal.op === "rotate" ? "Rotate" : modal.op === "grab" ? "Move" : "Stretch"}
          {modal.axis ? ` along ${modal.axis.toUpperCase()}` : ""}
          {modal.typed ? ` · ${modal.typed}` : ""} — click or ↵ to keep, Esc to cancel
        </text>
      )}
    </svg>
  );
}

const EMPTY: string[] = [];

/** Is a screen point inside a convex quad (any winding)? */
function insideQuad(q: ReadonlyArray<{ x: number; y: number }>, p: { x: number; y: number }): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!, b = q[(i + 1) % q.length]!;
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(c) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

/** The deforming bone whose posed segment passes nearest a rig-space point (what a press on bending art turns). */
function nearestBoneTo(pose: RigPose, p: V3): BoneState | null {
  let best: BoneState | null = null, bd = Infinity;
  for (const b of pose.bones) {
    if (!b.bone.deform) continue;
    const dx = b.tail[0] - b.head[0], dy = b.tail[1] - b.head[1];
    const t = Math.max(0, Math.min(1, ((p[0] - b.head[0]) * dx + (p[1] - b.head[1]) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(b.head[0] + dx * t - p[0], b.head[1] + dy * t - p[1]);
    if (d < bd) (bd = d), (best = b);
  }
  return best;
}

/** The turn about `pivot` from `a` to `b`, degrees (rig space: + is clockwise on screen). */
function angleAbout(pivot: V3, a: V3, b: V3): number {
  const a0 = Math.atan2(a[1] - pivot[1], a[0] - pivot[0]);
  const a1 = Math.atan2(b[1] - pivot[1], b[0] - pivot[0]);
  let d = ((a1 - a0) * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function worldAngleOf(b: BoneState): number {
  return (Math.atan2(b.tail[1] - b.head[1], b.tail[0] - b.head[0]) * 180) / Math.PI;
}

/** ⇧ while drawing: the bone in 15° steps from its head. */
function snapAngle(head: V3, at: V3): V3 {
  const len = Math.hypot(at[0] - head[0], at[1] - head[1]);
  const a = Math.round(Math.atan2(at[1] - head[1], at[0] - head[0]) / (Math.PI / 12)) * (Math.PI / 12);
  return [head[0] + Math.cos(a) * len, head[1] + Math.sin(a) * len, 0];
}

/** Dragging a tip is the person's own IK: bone IK that would fight the drag is let go for the solve. */
function unik(rig: Rig): Rig {
  return rig.bones.some((b) => b.ik) ? { ...rig, bones: rig.bones.map((b) => (b.ik ? { ...b, ik: null } : b)) } : rig;
}

/** The colour a control is drawn in until it is given one — the viewport's too, apart from both selection colours and the art's whites. */
const CONTROL = "#4fe0b5";

const isControl = (b: BoneState) => b.bone.shape !== "bone" || !b.bone.deform;

/** Is a bone's move locked — both translation channels pinned by its limits? Then grabbing it turns it. */
function moveLocked(b: BoneState): boolean {
  const l = b.bone.limits;
  return !!l?.x && !!l?.y && l.x[0] === l.x[1] && l.y[0] === l.y[1];
}

/** A control's shape around its head, in screen space — sized in the rig's units so it scales with the art. */
/** The way a bone points on screen, head to tail: a rotate-only bone's cursor wraps that end. */
function boneBearing(s: Shown, b: BoneState): number {
  const h = s.space.toScreen({ x: b.head[0], y: b.head[1] });
  const t = s.space.toScreen({ x: b.tail[0], y: b.tail[1] });
  return bearingOf(t.x - h.x, t.y - h.y);
}

function controlPath(s: Shown, b: BoneState): string {
  const R = b.bone.size ?? Math.max(10, b.bone.rest.length * 0.35);
  const ang = Math.atan2(b.tail[1] - b.head[1], b.tail[0] - b.head[0]);
  const at = (u: number, v: number) => {
    const p = s.space.toScreen({ x: b.head[0] + Math.cos(ang) * u - Math.sin(ang) * v, y: b.head[1] + Math.sin(ang) * u + Math.cos(ang) * v });
    return `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  };
  const poly = (pts: Array<[number, number]>) => "M" + pts.map(([u, v]) => at(u, v)).join(" L") + " Z";
  switch (b.bone.shape) {
    case "square":
      return poly([[-R, -R], [R, -R], [R, R], [-R, R]]);
    case "diamond":
      return poly([[0, -R], [R, 0], [0, R], [-R, 0]]);
    case "cross": {
      const w = R * 0.32;
      return poly([[-w, -R], [w, -R], [w, -w], [R, -w], [R, w], [w, w], [w, R], [-w, R], [-w, w], [-R, w], [-R, -w], [-w, -w]]);
    }
    default: {
      // A circle, as a 24-gon so it shears and turns with the space it is drawn in.
      const pts: Array<[number, number]> = [];
      for (let i = 0; i < 24; i++) pts.push([Math.cos((i / 24) * Math.PI * 2) * R, Math.sin((i / 24) * Math.PI * 2) * R]);
      return poly(pts);
    }
  }
}

/**
 * What a limited bone may reach, in screen space: the box its head's x/y
 * limits allow (a line when one axis is locked — a slider's track), drawn in
 * its parent's frame where those channels live; or, for a picked bone with a
 * rotation limit, the arc its tip may sweep. Null when it is free.
 */
function limitGuide(s: Shown, b: BoneState, picked: boolean): string | null {
  const l = b.bone.limits;
  if (!l) return null;
  const parent = b.parent ? s.pose.byId.get(b.parent)!.pose : null;
  const r = b.bone.rest;
  const toScreen = (x: number, y: number) => {
    const p = parent ? { x: parent[0]! * x + parent[4]! * y + parent[12]!, y: parent[1]! * x + parent[5]! * y + parent[13]! } : { x, y };
    const q = s.space.toScreen(p);
    return `${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
  };
  if (l.x || l.y) {
    const [x0, x1] = l.x ?? [-Infinity, Infinity];
    const [y0, y1] = l.y ?? [-Infinity, Infinity];
    // Only a bounded box can be drawn; an open side is a free axis.
    if (Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(y0) && Number.isFinite(y1)) {
      const a = toScreen(r.x + x0, r.y + y0), c = toScreen(r.x + x1, r.y + y1);
      if (x0 === x1 || y0 === y1) return `M${a} L${c}`;
      return `M${a} L${toScreen(r.x + x1, r.y + y0)} L${c} L${toScreen(r.x + x0, r.y + y1)} Z`;
    }
  }
  if (l.rotation && picked) {
    // The arc the tip sweeps, about the head, from the bone's angle at its limits.
    const now = Math.atan2(b.tail[1] - b.head[1], b.tail[0] - b.head[0]);
    const cur = (limitChannel(b.bone, "rotation", b.bone.pose?.rotation ?? 0) * Math.PI) / 180;
    const sign = mirroredFrame(s, b) ? -1 : 1;
    const len = Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1]) * 0.6;
    const pts: string[] = [];
    for (let i = 0; i <= 24; i++) {
      const deg = l.rotation[0] + ((l.rotation[1] - l.rotation[0]) * i) / 24;
      const a = now + sign * ((deg * Math.PI) / 180 - cur);
      const q = s.space.toScreen({ x: b.head[0] + Math.cos(a) * len, y: b.head[1] + Math.sin(a) * len });
      pts.push(`${q.x.toFixed(1)} ${q.y.toFixed(1)}`);
    }
    const h = s.space.toScreen({ x: b.head[0], y: b.head[1] });
    return `M${h.x.toFixed(1)} ${h.y.toFixed(1)} L${pts.join(" L")} Z`;
  }
  return null;
}

/** Does a bone's turn run the other way on screen (a mirrored parent or own scale)? */
function mirroredFrame(s: Shown, b: BoneState): boolean {
  const p = b.parent ? s.pose.byId.get(b.parent)!.pose : null;
  const flipParent = !!p && p[0]! * p[5]! - p[1]! * p[4]! < 0;
  const own = b.bone.pose;
  const flipOwn = !!own && own.scale * (own.scaleY ?? own.scale) < 0;
  return flipParent !== flipOwn;
}
