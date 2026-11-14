"use client";

import * as React from "react";
import {
  PATTERN_COLOR_FIELDS,
  PATTERN_FIELD_GROUPS,
  PATTERN_KINDS,
  PATTERN_KIND_LABELS,
  defaultPatternSpec,
  patternFieldsFor,
  patternScalar,
  type PatternKind,
  type PatternPaint,
  type PatternSpec,
} from "@solomotion/core";
import { ImagePlus, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { DocColorInput } from "../inspector/DocColorInput";
import { FieldSection } from "../inspector/StrokeFields";
import { ValueField } from "../inspector/value-field";
import type { PaintCarrierDraft, PaintHost } from "../inspector/paint-host";
import { PatternPreview } from "./PaintPreview";
import { PatternImagePicker } from "./PatternImagePicker";

/**
 * THE PATTERN STUDIO — the whole pattern engine as a panel, rendered from the
 * field registry.
 *
 * Nothing here knows what a "dot" is. The kind strip lists `PATTERN_KINDS`, the
 * rows are `patternFieldsFor(kind)`, and each row is the app's ordinary
 * `ValueField` — so every pattern property arrives with a keyframe diamond, a
 * binding menu and a modulator badge already attached, and a knob added to the
 * registry appears here with nothing written. That is what "everything is
 * keyframable" has to mean structurally: not a list of properties somebody
 * remembered to wire, but a panel that cannot render an unwired one.
 *
 * The preview is the REAL painter (see PaintPreview), so dragging an angle
 * rotates the actual tiling under your finger rather than a CSS impression of
 * it — and a design card, a swatch and the layer on stage are all the same
 * picture.
 */
export function PatternStudio({
  host,
  kind,
  id,
  eff,
}: {
  host: PaintHost;
  kind: "fill" | "stroke";
  id: string;
  eff: PatternPaint;
}) {
  const spec = eff.pattern;
  const path = (field: string) => `${kind}.${id}.pattern.${field}`;

  /** Structural edits (the kind, the asset) — never keyed: there is no halfway
   *  between stripes and dots worth rendering on the frame between them. */
  const edit = (label: string, fn: (s: PatternSpec) => void) =>
    host.update(label, (c: PaintCarrierDraft) => {
      const p = kind === "fill" ? c.fills.find((f) => f.id === id) : c.strokes.find((s) => s.id === id)?.paint;
      if (p && p.type === "pattern") fn(p.pattern);
    });

  const fields = patternFieldsFor(spec.kind);
  const groups = PATTERN_FIELD_GROUPS.filter((g) => fields.some((f) => f.group === g.id));

  // Switching kinds KEEPS every dialled value — the flat spec's whole point.
  // Only the kind changes, so a 45° hatch becomes a 45° chevron rather than
  // resetting to a default nobody asked for.
  const setKind = (next: PatternKind) => edit(`${PATTERN_KIND_LABELS[next]} pattern`, (s) => void (s.kind = next));

  const reset = () =>
    edit("Reset pattern", (s) => Object.assign(s, defaultPatternSpec(s.kind), { color: s.color, background: s.background }));

  return (
    <div className="flex min-h-0 flex-col">
      {/* The live tile, big enough to read the design at its real scale. */}
      <div className="relative m-2.5 mb-1.5 h-24 overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.09)]">
        <PatternPreview pattern={spec} />
        <button
          type="button"
          onClick={reset}
          title="Back to this kind's defaults"
          className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md material-glass text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5 group-hover:opacity-100"
        >
          <RotateCcw />
        </button>
      </div>

      {/* Kind — ONE picker, and it shows THIS pattern drawn each way.
          There used to be two rows here: a strip of shipped designs and a row
          of kind chips. They are different ideas (a preset vs. the vocabulary)
          and they read as one confused control, which is exactly how it looked
          — two thumbnail rows and a row of buttons for what is really a single
          choice. The designs live in the library on the left now, where every
          other preset in this editor lives, so what remains is the vocabulary.

          Each tile renders the CURRENT spec in that kind rather than a generic
          sample, so the grid answers "what would switching do to my pattern"
          instead of "what does the word dots mean". */}
      <div className="grid shrink-0 grid-cols-6 gap-1 px-2.5 pb-2">
        {PATTERN_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            title={PATTERN_KIND_LABELS[k]}
            className={cn(
              "group/kind flex flex-col items-center gap-0.5 rounded-md p-0.5 transition-colors",
              spec.kind === k ? "material-glass-raised" : "hover:bg-muted/50",
            )}
          >
            <span
              className={cn(
                "relative aspect-square w-full overflow-hidden rounded-[5px]",
                spec.kind === k
                  ? "shadow-[inset_0_0_0_1.5px_var(--primary)]"
                  : "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]",
              )}
            >
              {k === "image" ? (
                <span className="flex size-full items-center justify-center bg-muted/60 text-muted-foreground [&_svg]:size-3.5">
                  <ImagePlus />
                </span>
              ) : (
                <PatternPreview pattern={{ ...spec, kind: k }} />
              )}
            </span>
            <span
              className={cn(
                "w-full truncate text-center text-[9px] leading-tight transition-colors",
                spec.kind === k ? "text-primary" : "text-muted-foreground group-hover/kind:text-foreground",
              )}
            >
              {PATTERN_KIND_LABELS[k]}
            </span>
          </button>
        ))}
      </div>

      <div className="px-2.5 pb-2.5">
        {spec.kind === "image" ? (
          <PatternImagePicker
            assetId={spec.assetId}
            onPick={(assetId) => edit("Pattern image", (s) => void (s.assetId = assetId))}
          />
        ) : (
          <div className="flex gap-1.5">
            {PATTERN_COLOR_FIELDS.map((c) => (
              <label key={c.key} className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{c.label}</span>
                <DocColorInput
                  value={spec[c.key]}
                  onChange={(color) => host.commit(path(c.key), color, `Pattern ${c.label.toLowerCase()}`, `pat-${c.key}-${id}`)}
                />
              </label>
            ))}
          </div>
        )}

        {groups.map((g) => (
          <FieldSection key={g.id} label={g.label} defaultCollapsed={g.collapsed}>
            {fields
              .filter((f) => f.group === g.id)
              .map((f) => {
                // Percent fields are stored 0..1 and read 0..100 — the scaling
                // lives in the row so the registry keeps ONE set of true ranges.
                const pct = f.unit === "%" && (f.max ?? 0) <= 1;
                const base = patternScalar(spec, f.key) ?? 0;
                return (
                  <ValueField
                    key={f.key}
                    clip={host.keyframeClip ?? null}
                    canKey={!!host.keyframeClip}
                    modulatorHost={host.modulatorHost}
                    path={path(f.key)}
                    kind="number"
                    label={f.label}
                    unit={f.unit}
                    hint={f.hint}
                    bipolar={f.bipolar}
                    base={pct ? base * 100 : base}
                    min={pct ? (f.min ?? 0) * 100 : f.min}
                    max={pct ? (f.max ?? 1) * 100 : f.max}
                    step={pct ? Math.max(1, (f.step ?? 0.01) * 100) : f.step}
                    onChange={(v) =>
                      host.commit(path(f.key), pct ? Number(v) / 100 : Number(v), f.label, `pat-${f.key}-${id}`)
                    }
                  />
                );
              })}
          </FieldSection>
        ))}
      </div>
    </div>
  );
}

/** The kind switcher's icon-free chip list needs no export; this is here so an
 *  image pattern with nothing chosen still reads as a call to action. */
export { ImagePlus };
