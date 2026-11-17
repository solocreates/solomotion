"use client";

import * as React from "react";
import {
  addWeightStroke,
  clipLocalTime,
  evaluateRig,
  field2d,
  gridCells,
  groupChainMatrix,
  groupDeltaMatrix,
  influencesAt,
  invert4,
  locateClip,
  memberOf,
  multiply,
  restToRig2d,
  transformPoint,
  weightAt,
  weightStrokeSchema,
  type MotionDocument,
  type Clip,
  type GroupClip,
  type Mat2D,
  type Mat4,
  type V3,
} from "@solomotion/core";
import { Button } from "@/components/ui/button";
import { Range } from "@/components/ui/range";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession, useStageCamera } from "../state/session";
import { editSpaceOf, navSpace, type EditSpace } from "../stage/edit-space";
import { capturePointer } from "../input/capture-pointer";
import { claimPointer } from "../input/pointer-gestures";
import { IconTrack } from "../inspector/controls";
import { restView } from "./RigOverlay";
import { useRigUi, type WeightMode } from "./state";

/**
 * WEIGHT PAINT — how much each bone pulls on a bending layer, painted.
 *
 * Painted against the rig AT REST (the store's view overlay, like the Bone
 * tool), because a stroke is kept in the layer's OWN space and replayed over
 * whatever the art becomes (`schema/rig.ts` WeightStroke): rest is where the
 * screen and that space agree. The heat is the painted bone's weight on the
 * layer's silhouette grid — blue nothing, red all — recomputed from the same
 * `field2d` the renderer bends by, so what you see is what will bend.
 *
 * A stroke previews on the overlay and lands as ONE undo step on release.
 * ⌥-click samples the bone pulling hardest under the brush; Esc or Done leaves.
 */

const MODES: ReadonlyArray<{ id: WeightMode; label: string; icon: React.ReactNode }> = [
  { id: "add", label: "Add — more of this bone", icon: <span className="text-[10px] font-medium">Add</span> },
  { id: "subtract", label: "Subtract — less of it", icon: <span className="text-[10px] font-medium">Sub</span> },
  { id: "replace", label: "Replace — toward the strength", icon: <span className="text-[10px] font-medium">Set</span> },
  { id: "smooth", label: "Smooth — even out a crease", icon: <span className="text-[10px] font-medium">Blur</span> },
];

interface Target {
  rig: GroupClip;
  leaf: Clip;
  space: EditSpace;
  /** The layer's own space → the rig's, at rest. */
  toRig: Mat4;
}

export function WeightPaintOverlay() {
  const paint = useRigUi((s) => s.paint);
  return paint ? <Painter clipId={paint.clipId} bone={paint.bone} /> : null;
}

function Painter({ clipId, bone }: { clipId: string; bone: string }) {
  const doc = useDoc();
  const store = useDocStore();
  const brush = useRigUi((s) => s.brush);
  useStageCamera();
  useSession((s) => s.nav);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const stroke = React.useRef<number[] | null>(null);
  /** The stroke's radius in the layer's own units, fixed when it begins. */
  const radiusRef = React.useRef(1);
  const [pointer, setPointer] = React.useState<{ x: number; y: number } | null>(null);

  // Paint against rest, and leave cleanly.
  React.useEffect(() => {
    store.setOverlay(restView);
    return () => store.setOverlay(null);
  }, [store]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      useRigUi.getState().stopPaint();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // Leaving the layer (selecting something else, a tool that owns the stage) ends the session.
  const selected = useSession((s) => s.selectedClipIds);
  const tool = useSession((s) => s.tool);
  React.useEffect(() => {
    if (tool === "bone" || (selected.length && !selected.includes(clipId))) useRigUi.getState().stopPaint();
  }, [tool, selected, clipId]);

  const target = React.useMemo((): Target | null => {
    const space = navSpace(doc);
    const m = memberOf(doc, clipId);
    if (!space || !m || m.unit.id !== clipId || m.unit.kind === "group" || space.frame.world) return null;
    const rig = m.rig;
    const compMs = space.ctx.frameTimes.get(space.frame.id) ?? useSession.getState().playheadMs;
    const local = clipLocalTime(rig, compMs) ?? 0;
    const localOf = (c: Clip) => clipLocalTime(c, compMs) ?? 0;
    const delta = groupDeltaMatrix(doc, rig, local);
    const chain = groupChainMatrix(doc, rig.id, localOf);
    const pre: Mat2D = delta ? multiply(chain, delta) : chain;
    return { rig, leaf: m.unit, space: editSpaceOf(space.ctx, pre), toRig: restToRig2d(doc, m, m.unit) };
  }, [doc, clipId]);

  // `doc` is the store's read view — the overlay included — so the heat follows the stroke being painted.
  const field = React.useMemo(() => {
    if (!target) return null;
    const m = memberOf(doc, clipId);
    if (!m) return null;
    return field2d(doc, m, m.unit, evaluateRig(m.rig.rig!, { planar: true }));
  }, [doc, clipId, target]);

  // Draw the heat.
  React.useEffect(() => {
    const c = canvasRef.current;
    if (!c || !target || !field) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) (c.width = Math.round(w * dpr)), (c.height = Math.round(h * dpr));
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const g = field.grid;
    const screenOf = (i: number) => {
      const p = transformPoint(target.toRig, [g.local[i * 3]!, g.local[i * 3 + 1]!, 0]);
      return target.space.toScreen({ x: p[0], y: p[1] });
    };
    const pts = Array.from({ length: g.count }, (_, i) => screenOf(i));
    ctx.globalAlpha = 0.6;
    for (const quad of gridCells(g)) {
      const wt = quad.reduce((a, i) => a + weightAt(field.weights, i, bone), 0) / 4;
      ctx.fillStyle = heat(wt);
      ctx.beginPath();
      quad.forEach((i, k) => (k ? ctx.lineTo(pts[i]!.x, pts[i]!.y) : ctx.moveTo(pts[i]!.x, pts[i]!.y)));
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (pointer) {
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, brush.radius, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, brush.radius * brush.strength, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.stroke();
    }
  }, [target, field, bone, pointer, brush.radius, brush.strength]);

  if (!target) return null;
  const rig = target.rig.rig!;
  const deformBones = rig.bones.filter((b) => b.deform);

  /** A screen point → the layer's own space; and the brush's radius there. */
  const toOwn = (x: number, y: number): V3 => {
    const r = target.space.fromScreen({ x, y });
    return transformPoint(invert4(target.toRig), [r.x, r.y, 0]);
  };
  const radiusOwn = (x: number, y: number) => {
    const a = toOwn(x, y), b = toOwn(x + brush.radius, y);
    return Math.max(0.5, Math.hypot(b[0] - a[0], b[1] - a[1]));
  };
  const local = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const recipeFor = (pts: number[], radius: number) => (d: MotionDocument) => {
    restView(d);
    addWeightStroke(d, clipId, weightStrokeSchema.parse({ bone, mode: brush.mode, strength: brush.strength, radius, points: pts }));
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p = local(e);
    if (e.altKey && field) {
      // Sample: the bone pulling hardest at the nearest point of the grid.
      const own = toOwn(p.x, p.y);
      let best = -1, bd = Infinity;
      for (let i = 0; i < field.grid.count; i++) {
        const d = Math.hypot(field.grid.local[i * 3]! - own[0], field.grid.local[i * 3 + 1]! - own[1]);
        if (d < bd) (bd = d), (best = i);
      }
      const top = best >= 0 ? influencesAt(field.weights, best)[0] : undefined;
      if (top) useRigUi.getState().startPaint(clipId, top.bone);
      return;
    }
    claimPointer(e.pointerId, "drag");
    capturePointer(e.target as Element, e.pointerId);
    radiusRef.current = radiusOwn(p.x, p.y);
    const o = toOwn(p.x, p.y);
    stroke.current = [o[0], o[1], 0, e.pressure > 0 && e.pointerType === "pen" ? e.pressure : 1];
    store.setOverlay(recipeFor(stroke.current, radiusRef.current));
  };
  const onMove = (e: React.PointerEvent) => {
    const p = local(e);
    setPointer(p);
    const pts = stroke.current;
    if (!pts) return;
    const r = radiusRef.current;
    const o = toOwn(p.x, p.y);
    // A dab every quarter radius: even coverage, a stroke of a few dozen dabs.
    const lx = pts[pts.length - 4]!, ly = pts[pts.length - 3]!;
    if (Math.hypot(o[0] - lx, o[1] - ly) < r * 0.25) return;
    pts.push(o[0], o[1], 0, e.pressure > 0 && e.pointerType === "pen" ? e.pressure : 1);
    store.setOverlay(recipeFor(pts.slice(), r));
  };
  const onUp = () => {
    const pts = stroke.current;
    stroke.current = null;
    if (!pts) return;
    const r = radiusRef.current;
    store.setOverlay(restView);
    store.update("Paint weights", (d) => void addWeightStroke(d, clipId, weightStrokeSchema.parse({ bone, mode: brush.mode, strength: brush.strength, radius: r, points: pts })));
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        data-weight-paint
        className="absolute inset-0 h-full w-full"
        style={{ cursor: "none", touchAction: "none" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setPointer(null)}
      />
      {/* The brush, at the top of the stage: which bone, how, how big, how hard. */}
      <div className="absolute left-1/2 top-3 z-10 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-[12px] text-popover-foreground shadow-lg" onPointerDown={(e) => e.stopPropagation()}>
        <span className="text-[11px] text-muted-foreground">Weights</span>
        <div className="flex max-w-80 flex-wrap gap-1">
          {deformBones.map((b) => (
            <button
              key={b.id}
              type="button"
              className={cn("h-6 rounded px-2 text-[11px]", b.id === bone ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "bg-input/35 text-muted-foreground hover:text-foreground")}
              onClick={() => useRigUi.getState().startPaint(clipId, b.id)}
            >
              {b.name}
            </button>
          ))}
        </div>
        <div className="w-44">
          <IconTrack value={brush.mode} items={MODES} onPick={(v) => useRigUi.getState().setBrush({ mode: v })} />
        </div>
        <Range className="w-28" label="Size" value={brush.radius} min={4} max={200} step={1} precision={0} unit="px" aria-label="Brush size" onChange={(v) => useRigUi.getState().setBrush({ radius: v })} />
        <Range className="w-28" label="Strength" value={brush.strength} min={0} max={1} step={0.01} precision={2} aria-label="Brush strength" onChange={(v) => useRigUi.getState().setBrush({ strength: v })} />
        <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={() => useRigUi.getState().stopPaint()}>
          Done
        </Button>
      </div>
    </>
  );
}

/** Blender's weight ramp: blue (none) → cyan → green → yellow → red (all). */
function heat(w: number): string {
  const t = Math.max(0, Math.min(1, w));
  return `hsl(${Math.round(240 * (1 - t))} 90% 50%)`;
}
