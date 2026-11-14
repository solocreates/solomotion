"use client";

import * as React from "react";
import {
  BRUSH_HIDDEN_STROKE_FIELDS,
  STROKE_FIELDS,
  STROKE_FIELD_GROUPS,
  setStrokeField,
  strokeField,
  type Clip,
  type EffectFieldDef,
  type StrokeStyle,
} from "@solomotion/core";
import { ChevronRight, Link2, Unlink2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ValueField } from "./value-field";
import type { StrokeHost } from "./stroke-host";

/**
 * THE stroke panel — every field of the pipeline, rendered from the registry.
 *
 * One component, two homes: a layer's stroke in the inspector's editor window,
 * and a vector brush's line in the Brush Studio. They were never two features —
 * a brush lays down a line and a shape carries one, and both are described by
 * `STROKE_FIELDS`. Whichever surface you learn, you already know the other.
 *
 * The rows are `ValueField`, so a stroke on a CLIP gets the keyframe diamond,
 * the binding menu and the modulator badge with nothing written here — that is
 * how `stroke.<id>.dashOffset` became wiggle-able. A brush has no clip, so the
 * same rows render as plain sliders and the gutter simply stands empty.
 */
export function StrokeFields({
  host,
  strokeId,
  /** Hides width/opacity/align, which a brush owns elsewhere (its size slider). */
  scope = "layer",
}: {
  host: StrokeHost;
  strokeId: string;
  scope?: "layer" | "brush";
}) {
  const stroke = host.strokes.find((s) => s.id === strokeId);
  if (!stroke) return null;

  const fields = STROKE_FIELDS.filter(
    (f) => (scope === "layer" || !BRUSH_HIDDEN_STROKE_FIELDS.has(f.key)) && visible(f, stroke),
  );
  const groups = STROKE_FIELD_GROUPS.filter((g) => fields.some((f) => f.group === g.id));

  return (
    <>
      {groups.map((g) => (
        <FieldSection key={g.id} label={g.label} defaultCollapsed={g.collapsed}>
          {fields
            .filter((f) => f.group === g.id)
            .map((f) => (
              <StrokeFieldRow key={f.key} host={host} stroke={stroke} field={f} />
            ))}
          {g.id === "line" && <ProportionalRow host={host} stroke={stroke} />}
        </FieldSection>
      ))}
    </>
  );
}

/**
 * The proportional lock, and the one row here that is NOT a registry field.
 *
 * `baseWidth` is the width the look was designed at — the constant every other
 * pixel length in the pipeline is measured against. Keyframing it would be a
 * second, contradictory way of saying what keyframing the width already says,
 * so it gets no diamond, no binding and no modulator badge, and it stays out of
 * `STROKE_FIELDS` where those come from automatically. What it gets instead is
 * a lock, because the only decision a person makes about it is whether the
 * design scales with the line or holds its absolute sizes.
 *
 * The live factor is on the row when it is not 1. That number is the answer to
 * "why did my dashes get big", and it should never take a second click to find.
 */
function ProportionalRow({ host, stroke }: { host: StrokeHost; stroke: StrokeStyle }) {
  const on = stroke.baseWidth !== null && stroke.baseWidth > 0;
  const k = on ? stroke.width / stroke.baseWidth! : 1;
  const toggle = () =>
    host.update(on ? "Stroke sizes are absolute" : "Stroke scales with width", (c) => {
      const s = c.strokes.find((x) => x.id === stroke.id);
      // Re-locking anchors on the CURRENT width, so turning the lock back on
      // never retroactively rescales a design the user has since re-dialled by
      // hand at this size.
      if (s) s.baseWidth = on ? null : Math.max(0.01, s.width);
    });

  return (
    <div className="flex h-(--control-h) items-center gap-2 pl-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={toggle}
        title={
          on
            ? "Dash, wave, roughness and offset grow with the width."
            : "Every size is absolute — the width moves on its own."
        }
        className={cn(
          "flex h-5 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors [&_svg]:size-3",
          on ? "material-glass-raised text-primary" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {on ? <Link2 /> : <Unlink2 />}
        Scale with width
      </button>
      {on && Math.abs(k - 1) > 0.005 && (
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {k.toFixed(2)}x
        </span>
      )}
    </div>
  );
}

/** A `showIf` row that cannot apply is absent, never greyed — same rule the
 *  effect editor follows, so the two panels read alike. */
function visible(f: EffectFieldDef, stroke: StrokeStyle): boolean {
  if (!f.showIf) return true;
  return f.showIf.equals.includes(strokeField(stroke, f.showIf.key) as string);
}

/**
 * One field. Numbers go through the animatable write (keyframes when the host
 * keyframes); enums are structure and always edit the base — there is no
 * halfway between a round cap and a square one worth tweening.
 */
function StrokeFieldRow({
  host,
  stroke,
  field,
}: {
  host: StrokeHost;
  stroke: StrokeStyle;
  field: EffectFieldDef;
}) {
  const path = `stroke.${stroke.id}.${field.key}`;
  const base = strokeField(stroke, field.key);
  // Percent fields are stored 0..1 and read 0..100 — the scaling lives in the
  // row so the registry keeps ONE set of true ranges for every consumer.
  const asPct = field.unit === "%" && (field.max ?? 0) <= 4;
  const show = (v: number | string) => (asPct && typeof v === "number" ? v * 100 : v);
  const store = (v: number) => (asPct ? v / 100 : v);

  return (
    <ValueField
      clip={host.keyframeClip ?? null}
      canKey={!!host.keyframeClip}
      path={path}
      kind={field.kind}
      options={field.options}
      label={field.label}
      unit={field.unit}
      hint={field.hint}
      bipolar={field.bipolar}
      base={show(base)}
      min={asPct ? (field.min ?? 0) * 100 : field.min}
      max={asPct ? (field.max ?? 1) * 100 : field.max}
      step={asPct ? Math.max(1, (field.step ?? 0.01) * 100) : field.step}
      onChange={(v) => {
        if (field.kind === "select") {
          host.update(field.label, (c) => {
            const s = c.strokes.find((x) => x.id === stroke.id);
            if (s) setStrokeField(s, field.key, String(v));
          });
          return;
        }
        host.commit(path, store(Number(v)), field.label, `sf-${stroke.id}-${field.key}`);
      }}
    />
  );
}

/** A collapsible run of rows — the effect editor's own section grammar. */
export function FieldSection({
  label,
  defaultCollapsed,
  children,
}: {
  label: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(!defaultCollapsed);
  return (
    <section className="border-b border-border/40 py-1.5 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-0.5 flex w-full items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3"
      >
        <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open && <div className="space-y-1">{children}</div>}
    </section>
  );
}

export type { Clip };
