"use client";

import * as React from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Focus,
  UnfoldVertical,
  Scissors,
  SquareSquare,
  X,
} from "lucide-react";
import { CloseGapsIcon, EdgeIcon, MergeStrokesIcon, PaintInsideIcon, ReferenceIcon } from "../stage/tool-icons";
import {
  locateClip,
  type ConfineMode,
  type PaintConfine,
  type PaintDepth,
  type PaintReference,
  type VectorMerge,
} from "@solomotion/core";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Range } from "@/components/ui/range";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDoc } from "../state/document-context";
import { useHoldMenu } from "../state/use-hold-menu";
import { G, IconSeg, Opt, pod } from "../stage/tool-bar-kit";
import { useDrawing } from "./drawing-store";

/**
 * THE PAINT SCOPE STRIP — where a mark may go, in the bar, for every paint tool.
 *
 * The bar used to spend its width on SIZE and OPACITY, which is the one pair of
 * numbers that already has a better home: the brush handle pinned to the canvas
 * edge, under the hand that is drawing. Reaching to the top of the screen to
 * change a size you can change with your thumb is the trade backwards. What
 * belongs up here is the set of MODES — the things you arm before a stroke and
 * then forget about — and there was nowhere for them at all.
 *
 * Five controls, and every one of them is the same object the rest of this bar
 * already uses (`pod`, `IconSeg`): click is the everyday move, hold or
 * right-click opens the settings behind it. Nothing here needs to be learned
 * twice.
 *
 *   REFERENCE     the artwork the region is read from
 *   INSIDE        may the mark leave the region it started in
 *   OVER / UNDER   where it lands relative to what is there
 *   CLOSE GAPS    how wide an opening still holds paint
 *   MERGE         does new vector geometry join what it touches
 *
 * They are the SAME five under the brush, the eraser and the bucket, because
 * they are five facts about the gesture and none of them is about the nib.
 */

/**
 * Gap closing's everyday value — what the toggle arms.
 *
 * Exported because the keyboard shortcut arms the same thing, and "the value a
 * one-click toggle means" written in two places is two values the first time
 * one of them is tuned.
 */
export const PAINT_GAP_ON = 4;

/** A pod whose click toggles and whose hold opens a settings popover. */
function ScopePod({
  icon,
  label,
  armed,
  detail,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  armed: boolean;
  /** The value, spelled out in the tooltip — never as grey text in the bar. */
  detail: string;
  onToggle: () => void;
  /** The popover body. Omit for a pod with nothing behind it. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const hold = useHoldMenu(() => children && setOpen(true));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <PopoverAnchor asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`${label} — click to toggle${children ? ", hold for settings" : ""}`}
              aria-pressed={armed}
              {...(children ? hold.bind : {})}
              onClick={() => {
                if (children && hold.guard()) return;
                onToggle();
              }}
              className={pod(armed)}
            >
              {icon}
            </button>
          </TooltipTrigger>
        </PopoverAnchor>
        <TooltipContent side="bottom">
          {label} · {detail}
        </TooltipContent>
      </Tooltip>
      {children && (
        <PopoverContent side="bottom" align="center" sideOffset={8} className="w-64 space-y-3 p-3">
          {children}
        </PopoverContent>
      )}
    </Popover>
  );
}

/** One labelled row inside a scope popover — label left, control right. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** A px setting as a fader plus its exact number — the pattern the handle uses. */
function PxRow({
  label,
  value,
  min,
  max,
  unit = "px",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  /** The number's own unit. Empty for a plain count (comps, levels). */
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Row label={label}>
        <NumberInput
          value={value}
          min={min}
          max={max}
          precision={0}
          unit={unit}
          className="w-16"
          onChange={onChange}
        />
      </Row>
      <Range value={value} min={min} max={max} step={1} hideValue onChange={onChange} />
    </div>
  );
}

// ── Reference ───────────────────────────────────────────────────────────────

/**
 * What a referenced source is CALLED, resolved against the live document.
 *
 * A reference outlives the thing it points at (delete the layer, the id stays),
 * so this resolves every time rather than storing a name that could go stale —
 * and a source that no longer resolves says so plainly instead of vanishing,
 * because a silently shrinking list is how you lose track of why a fill stopped
 * behaving.
 */
function useReferenceLabels(refs: readonly PaintReference[]) {
  const doc = useDoc();
  return React.useMemo(
    () =>
      refs.map((ref) => {
        if (ref.kind === "clip") {
          const name = locateClip(doc, ref.id)?.clip.name;
          return { ref, name: name ?? "Missing layer", missing: !name };
        }
        if (ref.kind === "track") {
          const name = doc.tracks.find((t) => t.id === ref.id)?.name;
          return { ref, name: name ? `${name} · track` : "Missing track", missing: !name };
        }
        return { ref, name: "Group", missing: false };
      }),
    [doc, refs],
  );
}

/**
 * THE REFERENCE POD.
 *
 * Empty is not a disabled state — it means "the whole picture", which is the
 * right default and what most fills want. The pod arms only once you have
 * NARROWED it, so the armed light means "you are working against something
 * specific" rather than "this feature is switched on".
 *
 * There is no "add" button here on purpose. A reference is chosen by pointing
 * at the thing — right-click any layer, clip or track → Use as reference —
 * because that is where you already are when you decide, and a picker would be
 * a second list of the same layers you can already see.
 */
export function ReferencePod() {
  const refs = useDrawing((s) => s.scope.refs);
  const toggleRef = useDrawing((s) => s.toggleRef);
  const clearRefs = useDrawing((s) => s.clearRefs);
  const labels = useReferenceLabels(refs);
  const [open, setOpen] = React.useState(false);
  const hold = useHoldMenu(() => setOpen(true));
  const armed = refs.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <PopoverAnchor asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Reference — the artwork regions are read from"
              aria-pressed={armed}
              {...hold.bind}
              onClick={() => {
                if (hold.guard()) return;
                setOpen(true);
              }}
              className={cn(pod(armed), armed && "relative")}
            >
              <ReferenceIcon />
              {refs.length > 1 && (
                <span className="absolute -right-0.5 -top-0.5 rounded-full bg-primary px-1 font-mono text-[9px] leading-[13px] text-primary-foreground">
                  {refs.length}
                </span>
              )}
            </button>
          </TooltipTrigger>
        </PopoverAnchor>
        <TooltipContent side="bottom">
          Reference · {armed ? labels.map((l) => l.name).join(", ") : "everything visible"}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="center" sideOffset={8} className="w-64 space-y-2 p-3">
        {labels.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Regions are read from everything visible. Right-click a layer or track → Use as
            reference to narrow it.
          </p>
        ) : (
          <>
            <div className="space-y-1">
              {labels.map(({ ref, name, missing }) => (
                <div
                  key={`${ref.kind}:${ref.id}`}
                  className="flex h-7 items-center gap-1.5 rounded-md bg-accent/40 pl-2 pr-1 text-xs"
                >
                  <ReferenceIcon className="size-3 shrink-0 text-primary" />
                  <span className={cn("min-w-0 flex-1 truncate", missing && "text-muted-foreground line-through")}>
                    {name}
                  </span>
                  <button
                    type="button"
                    aria-label={`Stop referencing ${name}`}
                    onClick={() => toggleRef(ref)}
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                clearRefs();
                setOpen(false);
              }}
              className="h-7 w-full rounded-md text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Reference everything visible
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Confine, depth, gaps, merge ─────────────────────────────────────────────

const CONFINE_OPTIONS: Array<{ v: PaintConfine; icon: React.ComponentType<{ className?: string }>; label: string }> = [
  { v: "off", icon: SquareSquare, label: "Paint anywhere" },
  { v: "inside", icon: PaintInsideIcon, label: "Paint inside the region you start in" },
  { v: "outside", icon: Focus, label: "Paint everywhere except that region" },
];

/**
 * PAINT INSIDE — the one that makes the rest of this worth having.
 *
 * A click arms it, which is the move that happens a hundred times a session;
 * everything that shapes the region (which region, how far it spreads, how soft
 * its edge) is one hold away, because those are set once and then left alone.
 */
const CONFINE_MODES: Array<{ v: ConfineMode; icon: React.ComponentType<{ className?: string }>; label: string }> = [
  { v: "cut", icon: Scissors, label: "Cut the mark at the edge — permanent, nothing to move afterwards" },
  { v: "contain", icon: PaintInsideIcon, label: "Hold it inside a mask — the mark stays movable" },
  { v: "track", icon: Focus, label: "Follow the reference — the mask animates with it" },
];

export function ConfinePod() {
  const scope = useDrawing((s) => s.scope);
  const set = useDrawing((s) => s.setScope);
  const on = scope.confine !== "off";
  const trackable = scope.refs.length > 0;
  return (
    <ScopePod
      icon={scope.confine === "outside" ? <Focus /> : <PaintInsideIcon />}
      label="Paint inside"
      armed={on}
      detail={on ? `${scope.confine === "inside" ? "inside" : "outside"} · ${scope.confineMode}` : "off"}
      onToggle={() => set({ confine: on ? "off" : "inside" })}
    >
      <Row label="Confine">
        <IconSeg value={scope.confine} onChange={(confine: PaintConfine) => set({ confine })} options={CONFINE_OPTIONS} />
      </Row>
      <Row label="Hold it">
        <IconSeg
          value={scope.confineMode}
          onChange={(confineMode: ConfineMode) => set({ confineMode })}
          options={CONFINE_MODES.filter((m) => m.v !== "track" || trackable)}
        />
      </Row>
      {/* The one thing about this feature worth a sentence: which rung of the
          ladder you are on, and what it costs you. Everything else is a
          tooltip. */}
      <p className="text-2xs text-muted-foreground">
        {scope.confineMode === "cut"
          ? "The ink ends at the edge. Moving it later shows the cut."
          : scope.confineMode === "track"
            ? "A copy of the reference masks the mark — it moves and animates with it."
            : "A mask holds the mark, so it stays movable inside the shape."}
      </p>
    </ScopePod>
  );
}

/**
 * THE EDGE POD — how a boundary is FOUND, and where it then falls.
 *
 * One pod, because they are one question. Tolerance decides what counts as the
 * same area (where the edge is); the rest decide what the mark does when it
 * gets there. Splitting them meant the bucket — whose accuracy is entirely
 * tolerance — could not reach the setting at all: it lived inside the *Paint
 * inside* popover, a control the bucket does not use.
 *
 *   accuracy        what counts as the same area
 *   under the line  does the fill tuck beneath the outline, or stop at it
 *   expand          does it sit proud of the edge, or inset from it
 *   irregular       is the offset machined, or does it wander like a hand
 *   feather         is the edge hard, or soft
 *
 * Every one is read by the SAME `resolveRegion` the bucket, the confine stencil
 * and the hover preview use — so what you tune here is visible under the cursor
 * before you commit to it, on every tool at once, and it is remembered.
 */
export function EdgePod() {
  const scope = useDrawing((s) => s.scope);
  const set = useDrawing((s) => s.setScope);
  const shaped = scope.expandPx !== 0 || scope.featherPx > 0 || scope.jitter > 0;
  const detail = [
    `${Math.round(scope.tolerance * 100)}% accuracy`,
    scope.expandPx !== 0 ? `${scope.expandPx > 0 ? "+" : ""}${scope.expandPx} px` : null,
    scope.featherPx > 0 ? `${scope.featherPx} px soft` : null,
    scope.jitter > 0 ? `${Math.round(scope.jitter * 100)}% irregular` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ScopePod
      icon={<EdgeIcon />}
      label="Edge"
      armed={shaped}
      detail={detail}
      // A click zeroes the SHAPE back to a flush edge — the value you want when
      // a margin has gone wrong and you cannot see why. Accuracy is deliberately
      // left alone: it is how the region is found, not how it is decorated, and
      // resetting it would move the boundary you were happy with.
      onToggle={() => set({ expandPx: 0, featherPx: 0, jitter: 0 })}
    >
      <div className="space-y-1">
        <Row label="Accuracy">
          <NumberInput
            value={Math.round(scope.tolerance * 100)}
            min={0}
            max={100}
            precision={0}
            unit="%"
            className="w-16"
            onChange={(v) => set({ tolerance: v / 100 })}
          />
        </Row>
        <Range value={scope.tolerance} min={0} max={1} step={0.01} hideValue onChange={(tolerance) => set({ tolerance })} />
      </div>
      <Row label="Under the line">
        <Switch checked={scope.includeEdge} onCheckedChange={(includeEdge) => set({ includeEdge })} />
      </Row>
      <PxRow label="Expand" value={scope.expandPx} min={-20} max={40} onChange={(expandPx) => set({ expandPx })} />
      <div className="space-y-1">
        <Row label="Irregular">
          <NumberInput
            value={Math.round(scope.jitter * 100)}
            min={0}
            max={100}
            precision={0}
            unit="%"
            className="w-16"
            onChange={(v) => set({ jitter: v / 100 })}
          />
        </Row>
        <Range value={scope.jitter} min={0} max={1} step={0.01} hideValue onChange={(jitter) => set({ jitter })} />
      </div>
      <PxRow label="Feather" value={scope.featherPx} min={0} max={60} onChange={(featherPx) => set({ featherPx })} />
    </ScopePod>
  );
}

/**
 * OVER / UNDER, for every tool that adds something.
 *
 * A vector stroke that MERGES into another path has no order of its own — it
 * becomes its host — so the control goes inert rather than lying about it. It
 * comes back the moment merging is off, or set to "this layer", where the
 * stroke still owns its own place in the stack.
 */
export function DepthSeg({ moot }: { moot?: boolean }) {
  const depth = useDrawing((s) => s.scope.depth);
  const set = useDrawing((s) => s.setScope);
  return (
    <IconSeg
      value={depth}
      onChange={(d: PaintDepth) => set({ depth: d })}
      disabled={moot}
      disabledHint="A merged stroke takes its host's place in the stack"
      options={[
        { v: "over", icon: ArrowUpToLine, label: "Paint over what is there" },
        { v: "under", icon: ArrowDownToLine, label: "Paint under what is there" },
      ]}
    />
  );
}

/**
 * CLOSE GAPS — one number, three consumers.
 *
 * It is the bucket's flood barrier, the confine stencil's barrier, and the
 * distance a vector merge will bridge between two loose ends. All three are the
 * same promise about hand-drawn line art ("treat it as if it closed"), in the
 * same units, so they are one control rather than three that drift.
 */
export function GapPod() {
  const gap = useDrawing((s) => s.scope.closeGapPx);
  const set = useDrawing((s) => s.setScope);
  const on = gap > 0;
  return (
    <ScopePod
      icon={<CloseGapsIcon />}
      label="Close gaps"
      armed={on}
      detail={on ? `${gap} px` : "off"}
      onToggle={() => set({ closeGapPx: on ? 0 : PAINT_GAP_ON })}
    >
      <PxRow label="Close gaps" value={gap} min={0} max={40} onChange={(closeGapPx) => set({ closeGapPx })} />
      <p className="text-2xs text-muted-foreground">
        An opening this wide still holds paint — and joins two strokes that nearly meet.
      </p>
    </ScopePod>
  );
}

const MERGE_OPTIONS: Array<{ v: VectorMerge; icon: React.ComponentType<{ className?: string }>; label: string }> = [
  { v: "off", icon: SquareSquare, label: "Every stroke stays its own outline" },
  { v: "self", icon: MergeStrokesIcon, label: "Join strokes within this layer" },
  { v: "overlap", icon: Focus, label: "Join whatever path the stroke crosses, in any layer" },
];

/**
 * MERGE — vector only, because pixels merge by definition.
 *
 * Separate from Close gaps on purpose: they are wanted in every combination.
 * Merge without gap closing joins only what genuinely overlaps; gap closing
 * without merge is still the bucket's barrier.
 */
export function MergePod() {
  const merge = useDrawing((s) => s.scope.merge);
  const set = useDrawing((s) => s.setScope);
  const on = merge !== "off";
  return (
    <ScopePod
      icon={<MergeStrokesIcon />}
      label="Merge strokes"
      armed={on}
      detail={merge === "off" ? "off" : merge === "self" ? "this layer" : "anything it crosses"}
      onToggle={() => set({ merge: on ? "off" : "self" })}
    >
      <Row label="Merge into">
        <IconSeg value={merge} onChange={(m: VectorMerge) => set({ merge: m })} options={MERGE_OPTIONS} />
      </Row>
      <p className="text-2xs text-muted-foreground">
        Overlapping strokes become one outline, so fills and trims read them as one shape.
      </p>
    </ScopePod>
  );
}

/**
 * REACH — how far out of this comp, and how far into the ones inside it, the
 * tools may act.
 *
 * The second axis beside "this layer / all layers", and the two are genuinely
 * different questions: that one asks which LAYERS of a comp, this one asks
 * which COMPS. Standing inside a character's head, "all layers" means the
 * head's layers — correct, and also why the eraser could never take a line that
 * had ended up on the body.
 *
 * Two faders rather than one number, because out and in are wanted separately:
 * reaching into the pieces of what you are pointing at is an everyday thing,
 * reaching out into the scene around you is a deliberate one.
 */
function ReachPod() {
  const reach = useDrawing((s) => s.scope.reach);
  const set = useDrawing((s) => s.setScope);
  const on = reach.up > 0 || reach.down > 0;
  const detail = !on ? "this comp only" : [reach.up > 0 && `${reach.up} out`, reach.down > 0 && `${reach.down} in`].filter(Boolean).join(", ");
  return (
    <ScopePod
      icon={<UnfoldVertical />}
      label="Reach"
      armed={on}
      detail={detail}
      onToggle={() => set({ reach: on ? { up: 0, down: 0 } : { up: 0, down: 1 } })}
    >
      <PxRow
        label="Out"
        value={reach.up}
        min={0}
        max={4}
        unit=""
        onChange={(up) => set({ reach: { ...reach, up } })}
      />
      <PxRow
        label="In"
        value={reach.down}
        min={0}
        max={4}
        unit=""
        onChange={(down) => set({ reach: { ...reach, down } })}
      />
      <p className="text-2xs text-muted-foreground">
        Comps the tools may act in besides this one — outward toward the scene, inward into what is
        nested here. Marks land in each comp&rsquo;s own space, at its own scale.
      </p>
    </ScopePod>
  );
}

/**
 * The strip, assembled — what every paint tool's section renders.
 *
 * `merge` is passed rather than derived so the eraser and the bucket, which
 * make no fresh geometry, do not offer a control that could not act.
 */
export function PaintScopeStrip({ merge = false, region = false }: { merge?: boolean; region?: boolean }) {
  const mergeMode = useDrawing((s) => s.scope.merge);
  const confined = useDrawing((s) => s.scope.confine !== "off");
  return (
    // ONE ZONE. The strip is a single idea — "where this tool may act" — so it
    // takes one separator from whatever precedes it, however many of its pods
    // happen to apply. It used to emit a leading `<Divider />` unconditionally,
    // which is how a bar ended up with two hairlines side by side whenever the
    // section before it had already closed with one of its own.
    <G>
      {/* Reading order is the order the questions arise: what is the world,
          am I held inside it, where exactly is its edge, how forgiving is it
          about gaps, does new geometry join — and finally, on which side of
          everything the mark lands. */}
      <ReferencePod />
      <ConfinePod />
      {/* The edge only means something once a REGION is being computed — a
          confined mark, or a pour. Under a free brush it is a control for
          nothing, and a control that is always visible to say nothing is how a
          toolbar turns into noise. */}
      {(confined || region) && <EdgePod />}
      <GapPod />
      <ReachPod />
      {merge && <MergePod />}
      <DepthSeg moot={merge && mergeMode === "overlap"} />
    </G>
  );
}
