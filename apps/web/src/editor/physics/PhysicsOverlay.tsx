"use client";

import { cursors, resizeCursor } from "@solomotion/ui/cursors";
import * as React from "react";
import {
  anchorLocal,
  apply,
  basisOfTransform,
  bakeClipAt,
  clipBox,
  clipLocalTime,
  EMITTER,
  emitterLookOf,
  flatPhysics,
  simulate,
  simulateHits,
  groupChainMatrix,
  invert,
  layerMatrix,
  locateClip,
  multiply,
  type MotionDocument,
  type Clip,
  type EmitterSpec,
  type ForceSpec,
  type Mat2D,
  type VisualClip,
} from "@solomotion/core";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession, useStageView, useParkedPlayhead, useTransportRunning } from "../state/session";
import { navSpace } from "../stage/edit-space";
import { capturePointer } from "../input/capture-pointer";
import { claimPointer, subscribePointerEnd } from "../input/pointer-gestures";
import { accentColor } from "../theme/theme-tokens";
import { commitProperty } from "../inspector/animatable";
import { resolvedDocAt } from "@solomotion/core";


/**
 * PHYSICS ON THE CANVAS (flat comps) — the parts of a simulation that have no
 * picture of their own: FIELDS (a glyph you can grab — an arrow for a wind,
 * a swirl, a pull — and the dashed reach when it has one), 2D NULLS (a
 * crosshair, so a layer that never renders can still be picked and moved),
 * JOINTS (a line with its pins), and the selected body's real COLLIDER (a
 * dashed outline: what it will land on — its box, its hull or its pieces).
 *
 * A GRAVITY WELL draws its horizon (a dark disc: what it swallows) and, when
 * bounded, its reach; on the selected well both rings drag to resize.
 *
 * The SELECTED layer says what it does and what happens next, the rest stay
 * quiet: a selected body draws where it will go (its next 1.6 s, fading) and
 * rings where it will hit; a selected emitter draws its aim — a fan, "every
 * way", or the box it fills — and a label naming it. Nothing for unselected
 * emitters: eleven balls with trails were eleven orange discs.
 *
 * Guides only: never in a render. Drawn at the playhead, where the
 * simulation has the bodies (`resolvedDocAt`).
 */

const GLYPH = 26;

export function PhysicsOverlay() {
  // Reads the live stage — drag state, edit spaces, pointer geometry — every
  // render, outside React, by design. Memoising it would freeze the overlay.
  "use no memo";
  const doc = useDoc();
  const store = useDocStore();
  const playheadMs = useParkedPlayhead();
  // An editing overlay is for a still frame: the canvas draws the motion.
  const running = useTransportRunning();
  const selected = useSession((s) => s.selectedClipIds);
  const tool = useSession((s) => s.tool);
  const nav = useSession((s) => s.nav);
  useStageView();
  const dragRef = React.useRef<
    | { kind: "move"; id: string; from: { x: number; y: number }; x0: number; y0: number; inv: Mat2D }
    | { kind: "radius"; id: string; path: string; origin: { x: number; y: number }; r0: number; stop: () => void }
    | null
  >(null);

  const space = navSpace(doc);
  const frame = space?.frame ?? null;
  const model = React.useMemo(() => {
    if (!space || !frame || frame.world) return null;
    const compMs = space.ctx.frameTimes.get(frame.id) ?? playheadMs;
    const now = resolvedDocAt(doc, compMs, frame.id);
    const at = (c: Clip) => clipLocalTime(c, compMs) ?? Math.max(0, compMs - c.startMs);
    const clips = now.tracks.flatMap((t) => t.clips).filter((c): c is VisualClip => c.frameId === frame.id && c.kind !== "audio");
    const toComp = (c: VisualClip): Mat2D => {
      const b = bakeClipAt(c, at(c));
      const t = b.transform;
      const L = layerMatrix(basisOfTransform(t, clipBox(now, b)));
      return multiply(groupChainMatrix(now, c.id, at), { a: L[0], b: L[1], c: L[2], d: L[3], e: L[4] + t.x, f: L[5] + t.y });
    };
    const fields = clips.filter((c) => c.forces?.length || c.kind === "empty");
    const emitting = clips.filter((c) => c.emitters?.some((e) => e.enabled));
    const withJoints = clips.filter((c) => c.joints?.length);
    return { compMs, now, clips, toComp, fields, emitting, withJoints, fp: flatPhysics(doc, frame.id), at };
    // The edit context is rebuilt on every render (each camera move); what it
    // is derived from — the document and the navigation — is the real key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, nav, frame, playheadMs]);

  if (running || !space || !frame || !model || tool === "bone") return null;
  const accent = accentColor();
  const S = (p: { x: number; y: number }) => space.toScreen(p);

  const onDown = (e: React.PointerEvent, c: VisualClip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    useSession.getState().select(e.shiftKey ? [...useSession.getState().selectedClipIds, c.id] : [c.id]);
    claimPointer(e.pointerId, "drag");
    capturePointer(e.target as Element, e.pointerId);
    const chain = groupChainMatrix(model.now, c.id, model.at);
    const b = bakeClipAt(c, model.at(c));
    dragRef.current = { kind: "move", id: c.id, from: space.fromScreen(local(e)), x0: b.transform.x, y0: b.transform.y, inv: invert({ ...chain, e: 0, f: 0 }) ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };
  };
  /** A well's horizon or reach, grabbed on its ring: the radius follows the pointer's distance from the centre. */
  const onRingDown = (e: React.PointerEvent, c: VisualClip, force: ForceSpec, field: "horizon" | "radius", origin: { x: number; y: number }) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    claimPointer(e.pointerId, "drag");
    capturePointer(e.target as Element, e.pointerId);
    const path = `force.${force.id}.${field}`;
    const r0 = force[field];
    const pointer = e.pointerId;
    // A second finger, a lost pointer: the ring goes back to where it was — abort, never commit.
    const stop = subscribePointerEnd((id, reason) => {
      if (id !== pointer || dragRef.current?.kind !== "radius") return;
      if (reason === "superseded" || reason === "lost") writeRadius(c.id, path, r0);
      dragRef.current = null;
      stop();
    });
    dragRef.current = { kind: "radius", id: c.id, path, origin, r0, stop };
  };
  const writeRadius = (id: string, path: string, value: number) =>
    store.update(
      "Resize force",
      (dd) => {
        const clip = locateClip(dd, id)?.clip;
        if (clip) commitProperty(clip, path, Math.max(0, Math.round(value)), useSession.getState().playheadMs);
      },
      { mergeKey: `field-radius-${id}-${path}` },
    );
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = space.fromScreen(local(e));
    if (d.kind === "radius") return writeRadius(d.id, d.path, Math.hypot(p.x - d.origin.x, p.y - d.origin.y));
    const delta = apply(d.inv, { x: p.x - d.from.x, y: p.y - d.from.y });
    store.update(
      "Move force",
      (dd) => {
        const c = locateClip(dd, d.id)?.clip;
        if (!c) return;
        const ms = useSession.getState().playheadMs;
        commitProperty(c, "x", d.x0 + delta.x, ms);
        commitProperty(c, "y", d.y0 + delta.y, ms);
      },
      { mergeKey: `field-drag-${d.id}` },
    );
  };
  const onUp = () => {
    const d = dragRef.current;
    if (d?.kind === "radius") d.stop();
    dragRef.current = null;
  };
  const local = (e: React.PointerEvent) => {
    const r = (e.currentTarget as Element).closest("svg")!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" data-physics-overlay onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      {/* The selected bodies' colliders, where the simulation has them. */}
      {model.fp &&
        selected.map((id) => {
          const body = model.fp!.scene.bodies.find((b) => b.id === id);
          const pl = model.fp!.placements.get(id);
          const c = model.clips.find((x) => x.id === id);
          if (!body || !pl || !c) return null;
          // The body frame now: its pivot and angle as resolved, the mass centre at its offset.
          const m = model.toComp(c);
          const pivot = apply(m, pivotOwn(model.now, c));
          const ang = Math.atan2(m.b, m.a);
          const cos = Math.cos(ang), sin = Math.sin(ang);
          const com = { x: pivot.x + pl.centre[0] * cos - pl.centre[1] * sin, y: pivot.y + pl.centre[0] * sin + pl.centre[1] * cos };
          const place = (x: number, y: number) => S({ x: com.x + x * cos - y * sin, y: com.y + x * sin + y * cos });
          return (
            <g key={`col${id}`} opacity={0.9}>
              {body.colliders.map((k, i) => {
                if (k.kind === "sphere") {
                  const o = place(k.offset[0], k.offset[1]);
                  const r = Math.hypot(...((p) => [p.x - o.x, p.y - o.y])(place(k.offset[0] + k.radius, k.offset[1])) as [number, number]);
                  return <circle key={i} cx={o.x} cy={o.y} r={r} fill="none" stroke={accent} strokeWidth={1} strokeDasharray="4 3" />;
                }
                if (k.kind === "prism") {
                  const off = k.offset ?? [0, 0, 0];
                  const d = k.points.map(([x, y], j) => {
                    const q = place(x + off[0], y + off[1]);
                    return `${j ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
                  });
                  return <path key={i} d={`${d.join(" ")} Z`} fill={accent} fillOpacity={0.05} stroke={accent} strokeWidth={1} strokeDasharray="4 3" />;
                }
                return null;
              })}
            </g>
          );
        })}

      {/* Joints: a line from this body's anchor to where it is held, a pin at each end. */}
      {model.withJoints.map((c) =>
        (c.joints ?? []).map((j) => {
          const a = S(apply(model.toComp(c), { x: j.anchor[0], y: j.anchor[1] }));
          const target = j.target ? model.clips.find((x) => x.id === j.target) : null;
          const sj = model.fp?.scene.joints.find((x) => x.id === j.id);
          const bComp = target ? apply(model.toComp(target), j.targetAnchor ? { x: j.targetAnchor[0], y: j.targetAnchor[1] } : pivotOwn(model.now, target)) : sj ? { x: sj.anchorB[0], y: sj.anchorB[1] } : apply(model.toComp(c), { x: j.anchor[0], y: j.anchor[1] });
          const b = S(bComp);
          const on = selected.includes(c.id) || (!!j.target && selected.includes(j.target));
          const tint = on ? accent : "#4fe0b5";
          return (
            <g key={j.id} opacity={j.enabled ? 1 : 0.35}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={tint} strokeWidth={1.5} strokeDasharray={j.type === "rope" ? "2 3" : j.type === "spring" ? "6 2 1 2" : undefined} />
              <circle cx={a.x} cy={a.y} r={3.5} fill={tint} />
              <circle cx={b.x} cy={b.y} r={j.target ? 3.5 : 5} fill={j.target ? tint : "none"} stroke={tint} strokeWidth={1.5} />
            </g>
          );
        }),
      )}

      {/* Where the selected bodies go next, and where they will hit. */}
      {model.fp &&
        (() => {
          const fp = model.fp!;
          const ids = selected.filter((id) => fp.scene.bodies.some((b) => b.id === id && b.type === "active"));
          if (!ids.length) return null;
          const from = Math.max(0, (model.compMs - fp.startMs) / 1000);
          const tracks = new Map<string, Array<{ x: number; y: number } | null>>(ids.map((id) => [id, []]));
          for (let k = 1; k <= AHEAD_STEPS; k++) {
            const poses = simulate(fp.scene, from + (k * AHEAD_S) / AHEAD_STEPS);
            for (const id of ids) {
              const p = poses.get(id);
              tracks.get(id)!.push(p ? S({ x: p.position[0], y: p.position[1] }) : null);
            }
          }
          // Ahead only (not the contacts it is in now), one ring per place.
          const hits: Array<{ x: number; y: number }> = [];
          for (const h of simulateHits(fp.scene, from + AHEAD_S)) {
            if (h.t <= (from + 0.05) * fp.scene.timeScale || h.particle !== undefined || h.x === undefined || !ids.some((id) => h.a === id || h.b === id)) continue;
            const q = S({ x: h.x, y: h.y! });
            if (hits.length < 12 && !hits.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < 14)) hits.push(q);
          }
          return (
            <g pointerEvents="none">
              {[...tracks].map(([id, pts]) =>
                pts.map((q, k) => (q ? <circle key={`${id}${k}`} cx={q.x} cy={q.y} r={2.4 - (1.4 * k) / AHEAD_STEPS} fill={accent} opacity={0.85 * (1 - k / AHEAD_STEPS)} /> : null)),
              )}
              {hits.map((q, k) => (
                <circle key={`h${k}`} cx={q.x} cy={q.y} r={7} fill="none" stroke={accent} strokeWidth={1.5} opacity={0.9 - Math.min(0.6, k * 0.08)} />
              ))}
            </g>
          );
        })()}

      {/* The selected emitters: where they throw — a fan, every way, or the box they fill — and what they are. */}
      {model.emitting
        .filter((c) => selected.includes(c.id))
        .map((c) => {
          const m = model.toComp(c);
          const b = bakeClipAt(c, model.at(c));
          const list = (b.emitters ?? []).filter((x) => x.enabled);
          if (!list.length) return null;
          const p = S(apply(m, pivotOwn(model.now, c)));
          const ang = Math.atan2(m.b, m.a);
          // An aim only where it throws: a trail (born nearly still) has nowhere to point.
          const thrown = list.filter((e) => e.type === "stream" || e.type === "burst");
          const aimed = thrown.find((e) => e.source === "point" && e.launch === "aim" && e.speed >= 60);
          const filled = thrown.some((e) => e.source === "area" || e.source === "outline");
          // A ring is in comp units about the origin, like a force's reach.
          const unit = Math.hypot(...((q) => [q.x - p.x, q.y - p.y])(S({ x: apply(m, pivotOwn(model.now, c)).x + 1, y: apply(m, pivotOwn(model.now, c)).y })) as [number, number]);
          const rings = [...new Set(thrown.filter((e) => e.source === "ring").flatMap((e) => [e.inner, e.outer]))];
          // A tilted plane's ring is drawn as it is seen: an ellipse.
          const squash = Math.cos((Math.min(89, thrown.find((e) => e.source === "ring")?.tilt ?? 0) * Math.PI) / 180);
          const box = filled ? clipBox(model.now, c) : null;
          const corners = box ? [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([u, v]) => S(apply(m, { x: box.cx + u! * box.width, y: box.cy + v! * box.height }))) : null;
          const names = [...new Set(list.map(emitterName))];
          const label = names.length > 2 ? `${names.slice(0, 2).join(" · ")} +${names.length - 2}` : names.join(" · ");
          return (
            <g key={c.id} pointerEvents="none">
              {corners && <polygon points={corners.map((q) => `${q.x},${q.y}`).join(" ")} fill={accent} fillOpacity={0.05} stroke={accent} strokeOpacity={0.8} strokeWidth={1} strokeDasharray="4 3" />}
              {rings.map((r) => (
                <ellipse key={`ring${r}`} cx={p.x} cy={p.y} rx={r * unit} ry={r * unit * squash} fill="none" stroke={accent} strokeOpacity={0.8} strokeWidth={1} strokeDasharray="4 3" />
              ))}
              {aimed && <AimGuide x={p.x} y={p.y} angle={ang} spread={aimed.spread} tint={accent} />}
              <Chip x={p.x} y={p.y + GLYPH} text={label} />
            </g>
          );
        })}

      {/* Fields and 2D nulls: a glyph to grab, the reach when it has one. */}
      {model.fields.map((c) => {
        const m = model.toComp(c);
        const o = apply(m, pivotOwn(model.now, c));
        const p = S(o);
        const ang = (Math.atan2(m.b, m.a) * 180) / Math.PI;
        const on = selected.includes(c.id);
        const tint = on ? accent : "#4fe0b5";
        // The cards as they are at the playhead: a keyed horizon draws where it is now.
        const stack = bakeClipAt(c, model.at(c)).forces ?? [];
        // The glyph is the first card that is on; every reach in the stack is drawn, once per distance.
        const lead = stack.find((f) => f.enabled) ?? stack[0] ?? null;
        const unit = Math.hypot(...((q) => [q.x - p.x, q.y - p.y])(S({ x: o.x + 1, y: o.y })) as [number, number]);
        const wells = stack.filter((f) => f.enabled && f.type === "gravity");
        const reaches = [...new Set(stack.filter((f) => f.enabled && f.radius > 0 && f.type !== "gravity").map((f) => f.radius))];
        return (
          <g key={c.id}>
            {reaches.map((r) => (
              <circle key={r} cx={p.x} cy={p.y} r={r * unit} fill={tint} fillOpacity={0.04} stroke={tint} strokeOpacity={0.6} strokeWidth={1} strokeDasharray="3 4" pointerEvents="none" />
            ))}
            {wells.map((f) => (
              <g key={f.id}>
                {f.radius > 0 && <WellRing x={p.x} y={p.y} r={f.radius * unit} tint={tint} dashed grab={on} label="Reach" onDown={(e) => onRingDown(e, c, f, "radius", o)} />}
                {f.horizon > 0 && <WellRing x={p.x} y={p.y} r={f.horizon * unit} tint={tint} grab={on} label="Horizon" onDown={(e) => onRingDown(e, c, f, "horizon", o)} />}
              </g>
            ))}
            <g transform={`translate(${p.x} ${p.y}) rotate(${ang})`} style={{ pointerEvents: "auto", cursor: cursors.move }} onPointerDown={(e) => onDown(e, c)}>
              <circle r={GLYPH / 2 + 4} fill="transparent" />
              {lead || !c.emitters?.length ? <FieldGlyph field={lead} tint={tint} on={on} /> : <EmitterGlyph tint={tint} on={on} />}
              <title>{c.name}</title>
            </g>
            {stack.length > 1 && (
              <g transform={`translate(${p.x + GLYPH / 2} ${p.y - GLYPH / 2})`} pointerEvents="none">
                <circle r={7} fill={tint} />
                <text textAnchor="middle" dy="0.35em" fontSize={9} fontWeight={600} fill="#0c0c0f">
                  {stack.length}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** How far ahead a selected body's path is drawn, and in how many dots. */
const AHEAD_S = 1.6;
const AHEAD_STEPS = 40;

/** A card's name as people know it: its look, or its kind. */
function emitterName(e: EmitterSpec): string {
  const look = emitterLookOf(e)?.name;
  if (look) return e.type === "hit" ? `${look} · on hit` : look;
  return EMITTER.def(e.type)?.label ?? "Particles";
}

/**
 * Where a point emitter throws: a fan with an arrow down its middle when it
 * is aimed, a ring with spokes when it goes every way (a trail, a firework) —
 * screen-sized, so it reads at any zoom.
 */
function AimGuide({ x, y, angle, spread, tint }: { x: number; y: number; angle: number; spread: number; tint: string }) {
  const R = 44;
  if (spread >= 300) {
    return (
      <g transform={`translate(${x} ${y})`}>
        <circle r={R * 0.55} fill="none" stroke={tint} strokeOpacity={0.7} strokeWidth={1} strokeDasharray="3 3" />
        {Array.from({ length: 8 }, (_, k) => {
          const a = (k * Math.PI) / 4;
          return <line key={k} x1={Math.cos(a) * R * 0.62} y1={Math.sin(a) * R * 0.62} x2={Math.cos(a) * R * 0.85} y2={Math.sin(a) * R * 0.85} stroke={tint} strokeWidth={1.5} strokeLinecap="round" />;
        })}
      </g>
    );
  }
  const half = (spread * Math.PI) / 360;
  const at = (a: number, r: number) => `${(Math.cos(a) * r).toFixed(1)} ${(Math.sin(a) * r).toFixed(1)}`;
  const tip = R + 10;
  return (
    <g transform={`translate(${x} ${y}) rotate(${(angle * 180) / Math.PI})`}>
      {spread > 0.5 && <path d={`M0 0 L${at(-half, R)} A${R} ${R} 0 0 1 ${at(half, R)} Z`} fill={tint} fillOpacity={0.1} stroke={tint} strokeOpacity={0.7} strokeWidth={1} />}
      <path d={`M0 0 H${tip} M${tip - 6} -4 L${tip} 0 L${tip - 6} 4`} fill="none" stroke={tint} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

/** A small label under a selected guide: what it is, in the words its card uses. */
function Chip({ x, y, text }: { x: number; y: number; text: string }) {
  const w = Math.min(220, text.length * 6.2 + 14);
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-w / 2} y={-9} width={w} height={18} rx={9} fill="#0c0c0f" fillOpacity={0.82} stroke="#ffffff" strokeOpacity={0.12} />
      <text textAnchor="middle" dy="0.35em" fontSize={10.5} fontWeight={500} fill="#f4f2ed">
        {text}
      </text>
    </g>
  );
}

/**
 * A well's ring: the horizon a dark disc with a solid edge, the reach dashed.
 * On the selected well the edge is a grab target (a wide invisible stroke,
 * never the disc — a press inside still reaches what is under it).
 */
function WellRing({ x, y, r, tint, dashed, grab, label, onDown }: { x: number; y: number; r: number; tint: string; dashed?: boolean; grab: boolean; label: string; onDown: (e: React.PointerEvent) => void }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={dashed ? tint : "#000"} fillOpacity={dashed ? 0.03 : 0.35} stroke={tint} strokeOpacity={dashed ? 0.6 : 0.9} strokeWidth={dashed ? 1 : 1.5} strokeDasharray={dashed ? "3 4" : undefined} pointerEvents="none" />
      {grab && (
        <circle cx={x} cy={y} r={r} fill="none" stroke="transparent" strokeWidth={12} style={{ pointerEvents: "stroke", cursor: resizeCursor(0), touchAction: "none" }} onPointerDown={onDown}>
          <title>{label}</title>
        </circle>
      )}
    </g>
  );
}

/** An emitter null's glyph: a spray along its +X. */
function EmitterGlyph({ tint, on }: { tint: string; on: boolean }) {
  const r = GLYPH / 2;
  return (
    <g>
      <circle r={r} fill="var(--background, #111)" fillOpacity={0.55} stroke={tint} strokeWidth={1} strokeOpacity={on ? 0.9 : 0.5} />
      <circle cx={-r + 7} r={2.5} fill={tint} />
      {[[-0.5, 0.55], [0, 0.8], [0.5, 0.55], [-0.25, 0.3], [0.25, 0.3]].map(([a, d], i) => (
        <circle key={i} cx={-r + 7 + Math.cos(a!) * (r * 1.4) * d!} cy={Math.sin(a!) * (r * 1.4) * d!} r={1.6} fill={tint} />
      ))}
    </g>
  );
}

/** A layer's pivot in its own space (where its origin's glyph sits). */
function pivotOwn(doc: MotionDocument, c: VisualClip): { x: number; y: number } {
  return anchorLocal(c.transform.anchor, clipBox(doc, c));
}

function FieldGlyph({ field, tint, on }: { field: ForceSpec | null; tint: string; on: boolean }) {
  const r = GLYPH / 2;
  const sw = on ? 2 : 1.5;
  const common = { fill: "none", stroke: tint, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const back = <circle r={r} fill="var(--background, #111)" fillOpacity={0.55} stroke={tint} strokeWidth={1} strokeOpacity={0.5} />;
  if (!field) {
    return (
      <g>
        <line x1={-r} y1={0} x2={r} y2={0} {...common} />
        <line x1={0} y1={-r} x2={0} y2={r} {...common} />
        <circle r={3} fill={tint} />
      </g>
    );
  }
  const off = field.enabled ? 1 : 0.4;
  switch (field.type) {
    case "wind":
      return (
        <g opacity={off}>
          {back}
          <path d={`M${-r + 5} -4 H${r - 6} M${-r + 5} 4 H${r - 9}`} {...common} />
          <path d={`M${r - 9} -8 L${r - 4} -4 L${r - 9} 0`} {...common} />
        </g>
      );
    case "vortex":
      return (
        <g opacity={off}>
          {back}
          <path d={`M0 ${-r + 5} A${r - 5} ${r - 5} 0 1 1 ${-r + 5} 0 M-3 -3 A4 4 0 1 1 3 3`} {...common} />
          <path d={`M${-r + 1} -4 L${-r + 5} 0 L${-r + 9} -4`} {...common} />
        </g>
      );
    case "point":
      return (
        <g opacity={off}>
          {back}
          <circle r={2.5} fill={tint} />
          {[0, 90, 180, 270].map((a) => (
            <g key={a} transform={`rotate(${a})`}>
              {field.strength >= 0 ? <path d={`M${r - 3} 0 H6 M9 -3 L6 0 L9 3`} {...common} /> : <path d={`M6 0 H${r - 3} M${r - 6} -3 L${r - 3} 0 L${r - 6} 3`} {...common} />}
            </g>
          ))}
        </g>
      );
    case "gravity":
      // A mass: a dark core inside its tilted orbit.
      return (
        <g opacity={off}>
          {back}
          <ellipse rx={r - 3} ry={(r - 3) * 0.42} transform="rotate(-18)" {...common} />
          <circle r={4.5} fill="#000" stroke={tint} strokeWidth={sw} />
        </g>
      );
    case "turbulence":
      return (
        <g opacity={off}>
          {back}
          <path d="M-9 -4 q3 -4 6 0 t6 0 t6 0 M-9 4 q3 -4 6 0 t6 0 t6 0" {...common} />
        </g>
      );
    default:
      return (
        <g opacity={off}>
          {back}
          <path d="M-8 -6 V6 M-3 -6 V6 M2 -6 V6 M7 -6 V6" {...common} />
        </g>
      );
  }
}
