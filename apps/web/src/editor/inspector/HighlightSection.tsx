"use client";

import * as React from "react";
import type { Clip, EffectFieldDef, KeyframeValue, PartialTextStyle, TextClip } from "@solomotion/core";
import { Highlighter, Plus, Trash2 } from "lucide-react";
import { useSession } from "../state/session";
import { commitProperty } from "./animatable";
import { PanelSection } from "./controls";
import { ValueField } from "./value-field";
import { GroupKeyButton } from "./keyframe-controls";
import { useClipUpdater } from "./use-clip-updater";

/**
 * The highlight pill — the text background, and the ONE thing left in the text
 * sidebar that looks like an effect and is not.
 *
 * Its neighbours all left in v54. Shadow, glow, stroke, blur, inner shadow and
 * long shadow were a second effect system that existed only on text and drew
 * per glyph; they are now ordinary cards on the layer stack, in the Effects
 * tab, alongside every other layer's. What stayed is what could not: a pill is
 * sized from the laid-out run's own box and padding and sits BEHIND the words,
 * so it is a property of the type rather than a pass over the layer's pixels —
 * the same reason captions reuse it for the spoken-word background.
 *
 * It keeps the keyframe contract it always had (`highlight.<field>`), and on a
 * range it writes the override style instead.
 */

export interface HighlightSectionProps {
  clip: TextClip;
  value: PartialTextStyle;
  set: (patch: PartialTextStyle, label: string, mergeKey?: string) => void;
  /** Editing an override scope (a text range, a caption focus) — see StyleFields. */
  overrideScope?: boolean;
}

const HIGHLIGHT_FIELDS: EffectFieldDef[] = [
  { key: "color", label: "Color", kind: "color" },
  { key: "radius", label: "Radius", kind: "number", min: 0, max: 80, step: 1 },
  { key: "paddingX", label: "Pad X", kind: "number", min: 0, max: 120, step: 1 },
  { key: "paddingY", label: "Pad Y", kind: "number", min: 0, max: 120, step: 1 },
];
const DEFAULT_HIGHLIGHT = { color: "#F5B843", radius: 8, paddingX: 8, paddingY: 4 };

export function HighlightSection({ clip, value, set, overrideScope }: HighlightSectionProps) {
  const update = useClipUpdater(clip.id);
  const canKey = !overrideScope;
  const highlight = (overrideScope ? value.highlight : clip.style.highlight) ?? null;

  const setPresent = (on: boolean) => {
    if (overrideScope) {
      set({ highlight: on ? { ...DEFAULT_HIGHLIGHT } : null }, on ? "Add highlight" : "Remove highlight");
    } else {
      update(on ? "Add highlight" : "Remove highlight", (c) => {
        if (c.kind !== "text") return;
        c.style.highlight = on ? { ...DEFAULT_HIGHLIGHT } : null;
        if (!on) c.keyframes = c.keyframes.filter((t) => !t.property.startsWith("highlight."));
      });
    }
  };

  const commit = (field: EffectFieldDef, v: KeyframeValue, label: string) => {
    const mergeKey = `hl-${field.key}`;
    if (overrideScope) {
      set({ highlight: { ...(value.highlight ?? DEFAULT_HIGHLIGHT), [field.key]: v } }, label, mergeKey);
    } else {
      update(
        label,
        (c) => {
          if (c.kind !== "audio") commitProperty(c, `highlight.${field.key}`, v, useSession.getState().playheadMs);
        },
        mergeKey,
      );
    }
  };

  const groupProps = canKey && highlight
    ? HIGHLIGHT_FIELDS.map((f) => ({
        property: `highlight.${f.key}`,
        currentValue: () => (f.kind === "color" ? String((highlight as Record<string, unknown>)[f.key]) : Number((highlight as Record<string, unknown>)[f.key])),
      }))
    : [];

  return (
    <PanelSection
      id="highlight"
      title="Highlight"
      actions={
        highlight ? (
          <div className="flex items-center gap-0.5">
            {canKey && <GroupKeyButton clip={clip} properties={groupProps} />}
            <button
              type="button"
              aria-label="Remove highlight"
              onClick={() => setPresent(false)}
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-destructive [&_svg]:size-3.5"
            >
              <Trash2 />
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label="Add highlight"
            onClick={() => setPresent(true)}
            className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
          >
            <Plus />
          </button>
        )
      }
    >
      {highlight ? (
        <div className="space-y-1.5">
          {HIGHLIGHT_FIELDS.map((f) => {
            const raw = (highlight as Record<string, unknown>)[f.key];
            return (
              <ValueField
                key={f.key}
                clip={clip}
                canKey={canKey}
                path={`highlight.${f.key}`}
                kind={f.kind}
                label={f.label}
                base={f.kind === "color" ? (typeof raw === "string" ? raw : "#ffffff") : typeof raw === "number" ? raw : 0}
                min={f.min}
                max={f.max}
                step={f.step}
                onChange={(v) => commit(f, v, `Highlight ${f.label}`)}
              />
            );
          })}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPresent(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/80 py-2 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground [&_svg]:size-3.5"
        >
          <Highlighter /> Add highlight
        </button>
      )}
    </PanelSection>
  );
}

