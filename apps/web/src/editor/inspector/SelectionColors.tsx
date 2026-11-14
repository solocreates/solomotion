"use client";

import * as React from "react";
import {
  addColorVariable,
  colorVarToken,
  collectSubtreeColors,
  deleteColorVariable,
  parseColorVarToken,
  remapSubtreeColors,
  resolveColor,
  solidPaint,
  type MotionDocument,
  type Paint,
  type SubtreeColor,
} from "@solomotion/core";
import { ColorInput } from "@/components/ui/color-picker";
import { PaintLibrary } from "../paint/PaintLibrary";

/** A bare colour slot holds a `var:` token, so only colour variables fit. */
const COLOR_STYLES = ["color"] as const;
import { useDoc, useDocStore } from "../state/document-context";
import { PanelSection } from "./controls";

/**
 * Figma "Selection colors" — every distinct colour used across the selection
 * and everything nested inside it (a group's members, a nested comp's inner
 * clips, a vector's fills / stroke / gradient stops). Editing a row RETINTS
 * every occurrence in one undoable step; you can also promote a colour to a
 * variable (links every occurrence) right here. Reads/writes go through the
 * headless `collectSubtreeColors` / `remapSubtreeColors` core walkers.
 */
export function SelectionColorsSection({ clipIds }: { clipIds: string[] }) {
  const doc = useDoc();
  const colors = collectSubtreeColors(doc, clipIds);
  if (colors.length === 0) return null;
  const sorted = [...colors].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  return (
    <PanelSection
      id="colors"
      title="Colors"
      count={sorted.length}
      // Closed by default: it is a REPORT, not a control you reach for. The
      // swatch strip in the header answers "what colours are in here?" without
      // opening it, which is the only question most people had.
      defaultOpen={false}
      summary={<ColorDots doc={doc} colors={sorted} />}
    >
      <div className="space-y-1">
        {sorted.map((usage, i) => (
          <ColorRow key={i} clipIds={clipIds} usage={usage} />
        ))}
      </div>
    </PanelSection>
  );
}

/**
 * The collapsed swatch strip. Caps at a fixed count and states the remainder
 * rather than letting the row grow — a layer with forty distinct colours is
 * exactly when the header must not reflow, and "+34" is more informative than
 * thirty more 8px dots you cannot tell apart anyway.
 */
const MAX_DOTS = 8;

function ColorDots({ doc, colors }: { doc: MotionDocument; colors: SubtreeColor[] }) {
  const shown = colors.slice(0, MAX_DOTS);
  const rest = colors.length - shown.length;
  return (
    <div className="flex items-center gap-[3px]">
      {shown.map((c, i) => (
        <span
          key={i}
          // A ring rather than a border: a white swatch on a dark panel and a
          // near-black one both need an edge, and one inset ring gives both.
          className="size-2.5 shrink-0 rounded-[3px] ring-1 ring-inset ring-white/15"
          style={{ background: resolveColor(doc, c.value) }}
          title={`${c.value} · ${c.count}×`}
        />
      ))}
      {rest > 0 && (
        <span className="ml-0.5 font-mono text-[9px] leading-none text-muted-foreground/70">+{rest}</span>
      )}
    </div>
  );
}

function ColorRow({ clipIds, usage }: { clipIds: string[]; usage: SubtreeColor }) {
  const doc = useDoc();
  const store = useDocStore();
  // The value this row currently represents. Held locally so a live edit chains
  // (remap A→B→C) without the row losing its identity as the aggregate shifts.
  const fromRef = React.useRef(usage.value);
  React.useEffect(() => {
    fromRef.current = usage.value;
  }, [usage.value]);

  const linkedId = parseColorVarToken(fromRef.current);
  const resolved = resolveColor(doc, fromRef.current);

  const remap = (to: string, mergeKey?: string) => {
    const from = fromRef.current;
    if (from === to) return;
    store.update("Recolor selection", (d) => remapSubtreeColors(d, clipIds, from, to), mergeKey ? { mergeKey } : undefined);
    fromRef.current = to;
  };

  return (
    // Same [control | 20px] rhythm as a property row, so the colour list lines
    // up with the fields above it instead of running 12px further right.
    <div className="grid grid-cols-[minmax(0,1fr)_20px] items-center gap-x-1.5">
      <ColorInput
        value={resolved}
        className="min-w-0"
        variables={doc.variables.filter((v) => v.type === "color")}
        linkedId={linkedId}
        onChange={(c: string) => {
          if (linkedId) {
            store.update(
              "Edit color variable",
              (d) => {
                const v = d.variables.find((x) => x.id === linkedId);
                if (v) v.value = c;
              },
              { mergeKey: `cvar-${linkedId}` },
            );
          } else {
            remap(c, `recolor-${fromRef.current}`);
          }
        }}
        onLinkVariable={(id: string | null) => remap(id ? colorVarToken(id) : resolved)}
        // The one library, filtered to colours — the same browser every other
        // colour control opens, so "my styles" means one thing app-wide.
        library={
          <PaintLibrary
            kind="solid"
            styleTypes={COLOR_STYLES}
            current={solidPaint(resolved)}
            boundId={linkedId}
            onBind={(id: string) => remap(colorVarToken(id))}
            onDetach={() => remap(resolved)}
            onApply={(paint: Paint) => paint.type === "solid" && remap(paint.color, `recolor-${fromRef.current}`)}
          />
        }
      />
      <span className="text-right text-[10px] tabular-nums text-muted-foreground/60">{usage.count}</span>
    </div>
  );
}
