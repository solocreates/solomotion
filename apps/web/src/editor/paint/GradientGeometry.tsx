"use client";

import * as React from "react";
import { isGradientPaint, type Paint } from "@solomotion/core";
import { ValueField } from "../inspector/value-field";
import type { PaintHost } from "../inspector/paint-host";

/**
 * A gradient's geometry, named for the type you are actually editing.
 *
 * Every gradient stores the SAME two normalized points, and the type is the
 * only thing that changes what they mean (see `schema/vector`): a linear ramp
 * runs start → end, a radial is centred at start with end on its rim, an
 * angular sweeps around start from the start → end direction. So the panel does
 * not change shape between types — it renames. "SX / SY / EX / EY" was the
 * unified model leaking: correct, and unreadable, and actively wrong-looking on
 * a radial where those numbers are a centre and a radius.
 *
 * ANGLE AND LENGTH ARE DERIVED, and deliberately not stored. Storing an angle
 * beside the points would be two facts describing one thing, and they would
 * disagree the first time a handle was dragged on canvas. They are scrubbers
 * that write the points — which is also what makes them keyframable without
 * being properties: dragging Angle in record mode keys `start.x/y` and
 * `end.x/y`, because that is what an angle IS here.
 *
 * Every row is `ValueField`, so all of it — the four points, the two derived
 * scrubbers — arrives with the keyframe diamond, the binding menu, variables,
 * expressions and modulators. Nothing about that is written here.
 */

/** What the two stored points are CALLED, per gradient type. */
const POINT_LABELS: Record<"linear" | "radial" | "angular", { a: string; b: string }> = {
  linear: { a: "Start", b: "End" },
  radial: { a: "Center", b: "Edge" },
  angular: { a: "Center", b: "Sweep" },
};

/** What the length between them MEANS, per type. Null hides the row — an
 *  angular sweep has no length worth dialling, only a direction. */
const SPAN_LABEL: Record<"linear" | "radial" | "angular", string | null> = {
  linear: "Length",
  radial: "Radius",
  angular: null,
};

export function GradientGeometry({
  host,
  eff,
  id,
  sub,
  commit,
  onRotate,
}: {
  host: PaintHost;
  eff: Paint;
  id: string;
  sub: (s: string) => string;
  commit: (label: string, path: string, value: number, mergeKey?: string) => void;
  onRotate: (deg: number) => void;
}) {
  if (!isGradientPaint(eff)) return null;
  const type = eff.type;
  const names = POINT_LABELS[type];
  const spanLabel = SPAN_LABEL[type];

  const dx = eff.end.x - eff.start.x;
  const dy = eff.end.y - eff.start.y;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const span = Math.hypot(dx, dy);

  /**
   * Resize about the right anchor. A radial grows from its CENTRE — the centre
   * is a real, dragged thing and moving it because you widened the gradient
   * would be wrong. A linear ramp grows about its MIDPOINT, so lengthening it
   * opens out both ways instead of walking across the shape.
   */
  const setSpan = (next: number) => {
    const len = Math.max(0.001, next);
    const k = len / (span || 1);
    const mk = `paint-span-${id}`;
    if (type === "linear") {
      const mx = (eff.start.x + eff.end.x) / 2;
      const my = (eff.start.y + eff.end.y) / 2;
      commit(spanLabel!, sub("start.x"), mx - (dx * k) / 2, mk);
      commit(spanLabel!, sub("start.y"), my - (dy * k) / 2, mk);
      commit(spanLabel!, sub("end.x"), mx + (dx * k) / 2, mk);
      commit(spanLabel!, sub("end.y"), my + (dy * k) / 2, mk);
      return;
    }
    commit(spanLabel!, sub("end.x"), eff.start.x + dx * k, mk);
    commit(spanLabel!, sub("end.y"), eff.start.y + dy * k, mk);
  };

  const row = (
    label: string,
    key: string,
    value: number,
    onChange: (v: number) => void,
    opts: { min?: number; max?: number; step?: number; unit?: string; hint?: string; path?: string } = {},
  ) => (
    <ValueField
      key={key}
      clip={host.keyframeClip ?? null}
      // A derived scrubber has no property of its own, so it shows no diamond —
      // it keys the points it writes, which is where the animation really is.
      canKey={!!host.keyframeClip && opts.path !== undefined}
      modulatorHost={host.modulatorHost}
      path={opts.path ?? key}
      kind="number"
      label={label}
      unit={opts.unit}
      hint={opts.hint}
      base={value}
      min={opts.min}
      max={opts.max}
      step={opts.step ?? 0.01}
      onChange={(v) => onChange(Number(v))}
    />
  );

  return (
    <div className="space-y-0.5">
      {row("Angle", `grad-angle-${id}`, Math.round(angle), (v) => onRotate(v), {
        step: 1,
        unit: "°",
        hint: "Derived from the two points — scrubbing it moves them, and keys them in record mode.",
      })}
      {spanLabel &&
        row(spanLabel, `grad-span-${id}`, Number(span.toFixed(3)), setSpan, {
          min: 0,
          step: 0.01,
          hint:
            type === "radial"
              ? "Distance from the centre to the rim, as a share of the box."
              : "How far the ramp runs, as a share of the box.",
        })}

      {(["start", "end"] as const).map((end) =>
        (["x", "y"] as const).map((axis) =>
          row(
            `${end === "start" ? names.a : names.b} ${axis.toUpperCase()}`,
            `${end}.${axis}`,
            Number(eff[end][axis].toFixed(3)),
            (v) => commit(`${end === "start" ? names.a : names.b} ${axis.toUpperCase()}`, sub(`${end}.${axis}`), v, `paint-${end}${axis}-${id}`),
            { step: 0.01, path: sub(`${end}.${axis}`) },
          ),
        ),
      )}
    </div>
  );
}
