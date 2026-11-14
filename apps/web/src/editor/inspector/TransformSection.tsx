"use client";

import * as React from "react";
import { anchorMoveShift, clipBox, getClipProperty, isVisualClip, locateClip, type MotionDocument, type Clip } from "@solomotion/core";
import { Crosshair, Link2, Link2Off, RotateCw } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NumberInput } from "@/components/ui/number-input";
import { cn } from "@/lib/utils";
import { useDocStore, useDocWhen } from "../state/document-context";
import { useSession, useParkedPlayhead } from "../state/session";
import { commitProperty, effectiveValue } from "./animatable";
import { Half, IconToggle, Inline, Pair, PanelSection, PropRow } from "./controls";
import { GroupKeyButton, KeyControl, MultiKeyControl } from "./keyframe-controls";
import { MIXED } from "./shared-inspector";
import { useModifierKeys } from "./use-modifiers";

/**
 * THE transform section — one headless component for the whole app. It edits a
 * selection of 1..N visual clips: a single clip is just a selection of one, so
 * text, shapes, media, nested comps and multi-selections all read the SAME box
 * of fields, in the same order, wired to the SAME registry paths. No per-kind
 * transform panel exists anymore.
 *
 * Every value is the EFFECTIVE (keyframe-sampled) one and writes through
 * `commitProperty`, so record-mode / keyed properties key at the playhead
 * uniformly. Across a multi-selection, agreeing values merge to one number and
 * disagreements show as MIXED (Figma). Position writes as a delta so the
 * group's arrangement is preserved; scale/rotation are absolute.
 */

const asNum = (v: unknown): number => (typeof v === "number" ? v : 0);

/**
 * The nine standard pivot placements, laid out exactly as the picker draws them.
 * Normalized like the stored value: 0 = left/top edge, 1 = right/bottom.
 */
const ANCHOR_PRESETS: ReadonlyArray<{ x: number; y: number; label: string }> = [
  { x: 0, y: 0, label: "Top left" },
  { x: 0.5, y: 0, label: "Top centre" },
  { x: 1, y: 0, label: "Top right" },
  { x: 0, y: 0.5, label: "Left" },
  { x: 0.5, y: 0.5, label: "Centre" },
  { x: 1, y: 0.5, label: "Right" },
  { x: 0, y: 1, label: "Bottom left" },
  { x: 0.5, y: 1, label: "Bottom centre" },
  { x: 1, y: 1, label: "Bottom right" },
];

type Merged = number | typeof MIXED;

/** Effective value of a path merged across the selection (MIXED when they differ). */
function merge(clips: Clip[], path: string, playheadMs: number, doc: MotionDocument): Merged {
  let acc: number | undefined;
  for (const c of clips) {
    const base = asNum(getClipProperty(c, path));
    const v = Math.round(asNum(effectiveValue(c, path, base, playheadMs, doc)) * 1000) / 1000;
    if (acc === undefined) acc = v;
    else if (acc !== v) return MIXED;
  }
  return acc ?? 0;
}

export function TransformSection({ clips }: { clips: Clip[] }) {
  const store = useDocStore();
  const visual = clips.filter(isVisualClip);
  // Subscribe to the playhead so keyed values track the scrubber; the doc itself
  // re-renders the parent inspector, which hands us fresh clips.
  const playheadMs = useParkedPlayhead();
  // A keyed value is read at the clip's own frame time, which its home frame's
  // rate decides — so the frames are an input too.
  const timingDoc = useDocWhen((d) => [d.frames]);

  const single = visual.length === 1;
  const primary = visual[0];

  // Scale-link: on while every layer's X and Y scale agree (uniform). Held in
  // local state so unlinking sticks even when the values happen to coincide.
  const uniform = visual.every((c) => {
    const sy = c.transform.scaleY;
    return sy === null || sy === c.transform.scale;
  });
  const pivotClipId = useSession((s) => s.pivotClipId);
  const linkedOverride = useSession((s) => s.scaleLockAspectOverride);
  const setScaleLockAspectOverride = useSession((s) => s.setScaleLockAspectOverride);
  const linked = linkedOverride ?? uniform;
  const shiftHeld = useModifierKeys(["Shift"]);
  const effectiveLinked = shiftHeld ? !linked : linked;

  if (!primary) return null;

  /** Write one path across the selection. `relative` deltas preserve arrangement. */
  const write = (path: string, value: number, relative: boolean, extra?: string[]) => {
    const delta = relative ? value - asNum(getClipProperty(primary, path)) : 0;
    store.update(
      `Set ${path}`,
      (d) => {
        for (const c of visual) {
          const loc = locateClip(d, c.id);
          if (!loc) continue;
          const paths = extra ? [path, ...extra] : [path];
          for (const p of paths) {
            let next = relative ? asNum(getClipProperty(loc.clip, p)) + delta : value;
            // A LINKED scale carries the magnitude to its partner and leaves the
            // partner's SIGN alone — a negative scale is a mirror on that one
            // axis (see core resize.ts), and propagating the sign would silently
            // un-flip a layer the moment you typed a size into the other field.
            if (p !== path && (p === "scale" || p === "scaleY")) {
              const cur = asNum(getClipProperty(loc.clip, p));
              next = cur < 0 ? -Math.abs(next) : Math.abs(next);
            }
            commitProperty(loc.clip, p, next, playheadMs);
          }
        }
      },
      { mergeKey: `tf-${path}-${extra?.join() ?? ""}` },
    );
  };

  const x = merge(visual, "x", playheadMs, timingDoc);
  const y = merge(visual, "y", playheadMs, timingDoc);
  const scaleX = merge(visual, "scale", playheadMs, timingDoc);
  const scaleY = merge(visual, "scaleY", playheadMs, timingDoc);
  const rotation = merge(visual, "rotation", playheadMs, timingDoc);
  const z = merge(visual, "z", playheadMs, timingDoc);
  const tiltX = merge(visual, "rotationX", playheadMs, timingDoc);
  const tiltY = merge(visual, "rotationY", playheadMs, timingDoc);
  const skewX = merge(visual, "skewX", playheadMs, timingDoc);
  const skewY = merge(visual, "skewY", playheadMs, timingDoc);

  const anchorX = merge(visual, "anchor.x", playheadMs, timingDoc);
  const anchorY = merge(visual, "anchor.y", playheadMs, timingDoc);
  const pivotMode = pivotClipId === primary.id;

  /**
   * Set the pivot WITHOUT moving the layer. Pass null for an axis to leave it
   * alone. The compensating position write is the same one the on-canvas drag
   * makes — both call core's `anchorMoveShift`, so the two entry points cannot
   * disagree about where the layer ends up.
   */
  const writeAnchor = (nx: number | null, ny: number | null) => {
    store.update(
      "Set pivot",
      (d) => {
        for (const c of visual) {
          const loc = locateClip(d, c.id);
          if (!loc || loc.clip.kind === "audio") continue;
          const from = {
            x: asNum(effectiveValue(loc.clip, "anchor.x", loc.clip.transform.anchor.x, playheadMs)),
            y: asNum(effectiveValue(loc.clip, "anchor.y", loc.clip.transform.anchor.y, playheadMs)),
          };
          const to = { x: nx ?? from.x, y: ny ?? from.y };
          const size = clipBox(d, loc.clip);
          const t = loc.clip.transform;
          const shift = anchorMoveShift(from, to, {
            scale: asNum(effectiveValue(loc.clip, "scale", t.scale, playheadMs)),
            scaleY: asNum(effectiveValue(loc.clip, "scaleY", t.scaleY ?? t.scale, playheadMs)),
            rotation: asNum(effectiveValue(loc.clip, "rotation", t.rotation, playheadMs)),
            skewX: asNum(effectiveValue(loc.clip, "skewX", t.skewX, playheadMs)),
            skewY: asNum(effectiveValue(loc.clip, "skewY", t.skewY, playheadMs)),
            anchor: from,
            size,
          });
          if (nx !== null) commitProperty(loc.clip, "anchor.x", to.x, playheadMs);
          if (ny !== null) commitProperty(loc.clip, "anchor.y", to.y, playheadMs);
          // Unrounded, for the same reason the canvas drag is: `shift` is the
          // exact counter-move that keeps the art still, and rounding it to whole
          // pixels afterwards spends up to half a pixel of that promise. Setting
          // a pivot from the nine-point picker must move NOTHING.
          const px = asNum(effectiveValue(loc.clip, "x", t.x, playheadMs)) + shift.x;
          const py = asNum(effectiveValue(loc.clip, "y", t.y, playheadMs)) + shift.y;
          commitProperty(loc.clip, "x", px, playheadMs);
          commitProperty(loc.clip, "y", py, playheadMs);
        }
      },
      { mergeKey: "tf-anchor" },
    );
  };

  // Y over X, so a linked edit keeps the layer's proportions. A division, so not
  // a hook: it sits below the early return above.
  const linkX = scaleX === MIXED ? 0 : asNum(scaleX);
  const linkRatio = scaleY === MIXED || linkX === 0 ? 1 : asNum(scaleY) / linkX;

  const pct = (v: Merged) => (v === MIXED ? undefined : Math.round(v * 100));
  // Diamonds on every row, for any selection: each layer keys its own value on
  // its own clock (see `useKeyframeToggle`).
  const key = (path: string, current: () => number) => (
    <KeyControl clip={primary} property={path} currentValue={current} />
  );

  return (
    <PanelSection
      id="transform"
      title="Transform"
      /* Collapsed by default: the section you most often want PRESENT and least
         often want open. Every kind carries it, so leaving it expanded pushed
         the reason you actually selected the layer below the fold. Its open
         state is remembered per device — disagree once and it stays disagreed. */
      defaultOpen={false}
      transfer={single ? { domains: ["transform"], clipId: primary.id } : undefined}
      actions={
        <GroupKeyButton
          clip={primary}
          properties={[
            { property: "x", currentValue: () => asNum(x) },
            { property: "y", currentValue: () => asNum(y) },
            { property: "scale", currentValue: () => asNum(scaleX) },
            { property: "scaleY", currentValue: () => asNum(scaleY) },
            { property: "rotation", currentValue: () => asNum(rotation) },
            { property: "skewX", currentValue: () => asNum(skewX) },
            { property: "skewY", currentValue: () => asNum(skewY) },
          ]}
        />
      }
    >
      <PropRow
        label="Position"
        keyControl={
          <MultiKeyControl
            clip={primary}
            properties={[
              { property: "x", currentValue: () => asNum(x) },
              { property: "y", currentValue: () => asNum(y) },
            ]}
          />
        }
      >
        <Pair>
          <NumberInput
            label="X"
            value={x === MIXED ? undefined : x}
            mixed={x === MIXED}
            precision={0}
            onChange={(v) => write("x", v, true)}
          />
          <NumberInput
            label="Y"
            value={y === MIXED ? undefined : y}
            mixed={y === MIXED}
            precision={0}
            onChange={(v) => write("y", v, true)}
          />
        </Pair>
      </PropRow>

      <PropRow
        label="Scale"
        keyControl={
          <MultiKeyControl
            clip={primary}
            properties={[
              { property: "scale", currentValue: () => asNum(scaleX) },
              { property: "scaleY", currentValue: () => asNum(scaleY) },
            ]}
          />
        }
      >
        <Pair
          link={
            <IconToggle
              label="Lock aspect ratio — hold ⇧ to flip"
              pressed={effectiveLinked}
              onClick={() => {
                const next = !linked;
                setScaleLockAspectOverride(next);
                if (next && scaleX !== MIXED && scaleY !== MIXED) {
                  // Keep the current ratio when turning the link on, rather than
                  // snapping to 100%/100%.
                  const nextScaleY = Math.round(asNum(scaleX) * linkRatio * 1000) / 1000;
                  write("scaleY", nextScaleY, false);
                }
              }}
            >
              {effectiveLinked ? <Link2 /> : <Link2Off />}
            </IconToggle>
          }
        >
          <NumberInput
            label="X"
            value={pct(scaleX)}
            mixed={scaleX === MIXED}
            min={-500000}
            max={500000}
            precision={0}
            unit="%"
            onChange={(v) => write("scale", v / 100, false, effectiveLinked ? ["scaleY"] : undefined)}
          />
          <NumberInput
            label="Y"
            value={pct(scaleY)}
            mixed={scaleY === MIXED}
            min={-500000}
            max={500000}
            precision={0}
            unit="%"
            onChange={(v) => write("scaleY", v / 100, false, effectiveLinked ? ["scale"] : undefined)}
          />
        </Pair>
      </PropRow>

      <PropRow label="Rotate" keyControl={key("rotation", () => asNum(rotation))}>
        <Half>
          <NumberInput
            label={<RotateCw className="size-3" />}
            value={rotation === MIXED ? undefined : rotation}
            mixed={rotation === MIXED}
            precision={0}
            unit="°"
            onChange={(v) => write("rotation", v, false)}
          />
        </Half>
      </PropRow>

      {/* DEPTH: the layer stands in the comp's 3D space, seen by its default
          camera (core flat3d) — push it back with Z, turn it with the tilts.
          Zero is a flat layer, drawn exactly as before. */}
      <PropRow label="Depth" keyControl={key("z", () => asNum(z))}>
        <Half>
          <NumberInput
            label="Z"
            value={z === MIXED ? undefined : z}
            mixed={z === MIXED}
            precision={0}
            onChange={(v) => write("z", v, true)}
            path="z"
            fieldLabel="Depth"
          />
        </Half>
      </PropRow>

      <PropRow
        label="Tilt"
        keyControl={
          <MultiKeyControl
            clip={primary}
            properties={[
              { property: "rotationX", currentValue: () => asNum(tiltX) },
              { property: "rotationY", currentValue: () => asNum(tiltY) },
            ]}
          />
        }
      >
        <Pair>
          <NumberInput
            label="X"
            value={tiltX === MIXED ? undefined : tiltX}
            mixed={tiltX === MIXED}
            precision={0}
            unit="°"
            onChange={(v) => write("rotationX", v, false)}
            path="rotationX"
            fieldLabel="Tilt X"
          />
          <NumberInput
            label="Y"
            value={tiltY === MIXED ? undefined : tiltY}
            mixed={tiltY === MIXED}
            precision={0}
            unit="°"
            onChange={(v) => write("rotationY", v, false)}
            path="rotationY"
            fieldLabel="Tilt Y"
          />
        </Pair>
      </PropRow>

      {/* Pseudo-3D shear — ⌘/Ctrl-drag an edge on the stage does this too. */}
      <PropRow
        label="Skew"
        keyControl={
          <MultiKeyControl
            clip={primary}
            properties={[
              { property: "skewX", currentValue: () => asNum(skewX) },
              { property: "skewY", currentValue: () => asNum(skewY) },
            ]}
          />
        }
      >
        <Pair>
          <NumberInput
            label="X"
            value={skewX === MIXED ? undefined : skewX}
            mixed={skewX === MIXED}
            min={-85}
            max={85}
            precision={0}
            unit="°"
            onChange={(v) => write("skewX", v, false)}
          />
          <NumberInput
            label="Y"
            value={skewY === MIXED ? undefined : skewY}
            mixed={skewY === MIXED}
            min={-85}
            max={85}
            precision={0}
            unit="°"
            onChange={(v) => write("skewY", v, false)}
          />
        </Pair>
      </PropRow>

      {/* PIVOT — the point rotation, scale and ⌥-resize all act about. Stored as a
          fraction of the layer's own box (50%/50% = centre), which is what makes
          it survive a resize; see core transform-map.

          The nine-point pad used to sit inline underneath and cost ~110px of a
          panel where every other property is a 28px row. It's a popover now: the
          two numbers stay visible (they're the truth), and the pad — the thing
          that makes "which corner is 0%?" obvious — is one click away, together
          with the canvas gesture. */}
      <PropRow
        label="Pivot"
        keyControl={
          <MultiKeyControl
            clip={primary}
            properties={[
              { property: "anchor.x", currentValue: () => asNum(anchorX) },
              { property: "anchor.y", currentValue: () => asNum(anchorY) },
            ]}
          />
        }
      >
        <Inline
          trailing={
            <PivotPad
              anchorX={anchorX}
              anchorY={anchorY}
              onPick={writeAnchor}
              canvasMode={single ? pivotMode : null}
              onToggleCanvas={
                single
                  ? () =>
                      pivotMode
                        ? useSession.getState().closeLeaf("pivot")
                        : useSession.getState().enterLeaf(primary.id, "pivot")
                  : undefined
              }
            />
          }
        >
          <Pair>
            <NumberInput
              label="X"
              value={anchorX === MIXED ? undefined : Math.round(anchorX * 100)}
              mixed={anchorX === MIXED}
              precision={0}
              unit="%"
              onChange={(v) => writeAnchor(v / 100, null)}
            />
            <NumberInput
              label="Y"
              value={anchorY === MIXED ? undefined : Math.round(anchorY * 100)}
              mixed={anchorY === MIXED}
              precision={0}
              unit="%"
              onChange={(v) => writeAnchor(null, v / 100)}
            />
          </Pair>
        </Inline>
      </PropRow>
    </PanelSection>
  );
}

/**
 * The pivot control in 20px. The TRIGGER is the readout: a miniature of the
 * layer's box with a dot sitting where the pivot actually is, so the panel shows
 * you the answer without you parsing two percentages. Clicking opens the
 * nine-point pad and the on-canvas gesture — the two ways to move it.
 */
function PivotPad({
  anchorX,
  anchorY,
  onPick,
  canvasMode,
  onToggleCanvas,
}: {
  anchorX: Merged;
  anchorY: Merged;
  onPick: (x: number | null, y: number | null) => void;
  /** null when the selection isn't a single layer (no canvas gesture). */
  canvasMode: boolean | null;
  onToggleCanvas?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const known = anchorX !== MIXED && anchorY !== MIXED;
  const px = known ? asNum(anchorX) : 0.5;
  const py = known ? asNum(anchorY) : 0.5;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Pivot placement"
              className={cn(
                "relative flex size-5 items-center justify-center rounded transition-colors",
                open || canvasMode
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground/60 hover:bg-muted hover:text-foreground",
              )}
            >
              <span className="relative size-3 rounded-[2px] border border-current">
                <span
                  className={cn(
                    "absolute size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
                    known ? "bg-current" : "bg-current/40",
                  )}
                  style={{ left: `${px * 100}%`, top: `${py * 100}%` }}
                />
              </span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="left">Pivot placement</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" side="left" className="w-auto p-2">
        <div className="grid grid-cols-3 gap-0.5">
          {ANCHOR_PRESETS.map((preset) => {
            const on = known && Math.abs(px - preset.x) < 0.001 && Math.abs(py - preset.y) < 0.001;
            return (
              <Tooltip key={preset.label}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={preset.label}
                    aria-pressed={on}
                    onClick={() => onPick(preset.x, preset.y)}
                    className="group flex size-6 items-center justify-center rounded transition-colors hover:bg-accent"
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full transition-all",
                        on
                          ? "bg-primary ring-2 ring-primary/25"
                          : "bg-muted-foreground/35 group-hover:bg-muted-foreground/80",
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{preset.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        {onToggleCanvas && (
          <>
            <div className="my-1.5 h-px bg-border" />
            <button
              type="button"
              aria-pressed={!!canvasMode}
              onClick={() => {
                onToggleCanvas();
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[11px] transition-colors",
                canvasMode
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Crosshair className="size-3" />
              On canvas
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
