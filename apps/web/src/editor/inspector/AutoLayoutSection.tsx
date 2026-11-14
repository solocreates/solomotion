"use client";

import * as React from "react";
import {
  clipBox,
  isLayoutMember,
  locateClip,
  memberSizing,
  memberSizings,
  removeAutoLayout,
  setBoxSizing,
  setMemberSizing,
  type Clip,
  type LayoutAxis,
  type LayoutSizing,
  type GroupClip,
  type LayoutAlign,
  type LayoutSpec,
  type VisualClip,
} from "@solomotion/core";
import { ArrowDown, ArrowRight, ChevronDown, Grid2x2, Link2, Link2Off, WrapText, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { useEffectiveValue, writeAnimatable } from "./animatable";
import { Half, IconTrack, IconToggle, Pair, PanelSection, PropRow } from "./controls";
import { GroupKeyButton, KeyControl } from "./keyframe-controls";
import { useClipUpdater } from "./use-clip-updater";

/**
 * AUTO LAYOUT — the container's section. Figma's panel, with the two things a
 * motion tool adds: every number has a keyframe diamond, and the box's size is
 * either HUG or a number — never a scale.
 */
export function AutoLayoutSection({ clip }: { clip: GroupClip }) {
  return clip.layout ? <ContainerBody clip={clip} layout={clip.layout} /> : null;
}

function ContainerBody({ clip, layout }: { clip: GroupClip; layout: LayoutSpec }) {
  const store = useDocStore();
  const doc = useDoc();
  const update = useClipUpdater(clip.id);
  const hug = React.useMemo(() => clipBox(doc, clip), [doc, clip]);
  const gap = useEffectiveValue(clip, "layout.gap", layout.gap);
  const lineGap = useEffectiveValue(clip, "layout.lineGap", layout.lineGap);
  const pt = useEffectiveValue(clip, "layout.padding.top", layout.padding.top);
  const pr = useEffectiveValue(clip, "layout.padding.right", layout.padding.right);
  const pb = useEffectiveValue(clip, "layout.padding.bottom", layout.padding.bottom);
  const pl = useEffectiveValue(clip, "layout.padding.left", layout.padding.left);
  const w = useEffectiveValue(clip, "layout.width", layout.width ?? 0);
  const h = useEffectiveValue(clip, "layout.height", layout.height ?? 0);
  const [padLinked, setPadLinked] = React.useState(pt === pr && pr === pb && pb === pl);

  const set = (label: string, mutate: (l: LayoutSpec) => void, mergeKey?: string) =>
    update(label, (c) => void (c.kind === "group" && c.layout && mutate(c.layout)), mergeKey);
  const num = (path: string, label: string, mergeKey: string) => (v: number) =>
    update(
      label,
      (c) =>
        writeAnimatable(c, path, v, useSession.getState().playheadMs, (t) => {
          if (t.kind === "group" && t.layout) writeLayoutPath(t.layout, path, v);
        }),
      mergeKey,
    );
  const setPad = (side: "top" | "right" | "bottom" | "left", v: number) => {
    const sides = padLinked ? (["top", "right", "bottom", "left"] as const) : [side];
    update(
      "Change padding",
      (c) => {
        for (const s of sides) {
          writeAnimatable(c, `layout.padding.${s}`, v, useSession.getState().playheadMs, (t) => {
            if (t.kind === "group" && t.layout) t.layout.padding[s] = Math.max(0, v);
          });
        }
      },
      "layout-padding",
    );
  };
  const wrapOrGrid = layout.flow === "wrap" || layout.flow === "grid";

  return (
    <PanelSection
      id="auto-layout"
      title="Auto layout"
      hint="The members are arranged by this box. Their position is the box's to give; drag one to reorder it."
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          title="Remove auto layout — members stay where they are"
          onClick={() => store.update("Remove auto layout", (d) => void removeAutoLayout(d, clip.id, useSession.getState().playheadMs))}
        >
          <X />
        </Button>
      }
    >
      <PropRow label="Flow">
        <IconTrack
          value={layout.flow}
          items={[
            { id: "row", label: "Row", icon: <ArrowRight /> },
            { id: "column", label: "Column", icon: <ArrowDown /> },
            { id: "wrap", label: "Wrap — rows that break at the width", icon: <WrapText /> },
            { id: "grid", label: "Grid", icon: <Grid2x2 /> },
          ]}
          onPick={(v) => set("Change flow", (l) => void (l.flow = v as LayoutSpec["flow"]))}
        />
      </PropRow>
      {layout.flow === "grid" && (
        <PropRow label="Columns">
          <Half>
            <NumberInput value={layout.columns} min={1} max={24} precision={0} onChange={(v) => set("Change columns", (l) => void (l.columns = Math.max(1, Math.round(v))), "layout-cols")} />
          </Half>
        </PropRow>
      )}

      <PropRow
        label="Gap"
        keyControl={
          wrapOrGrid ? (
            <GroupKeyButton clip={clip} properties={[{ property: "layout.gap", currentValue: () => gap }, { property: "layout.lineGap", currentValue: () => lineGap }]} />
          ) : (
            <KeyControl clip={clip} property="layout.gap" currentValue={() => gap} />
          )
        }
      >
        <Pair>
          <NumberInput value={gap} min={0} precision={0} unit={wrapOrGrid ? "↔" : "px"} onChange={num("layout.gap", "Change gap", "layout-gap")} />
          {wrapOrGrid && <NumberInput value={lineGap} min={0} precision={0} unit="↕" onChange={num("layout.lineGap", "Change line gap", "layout-linegap")} />}
        </Pair>
      </PropRow>
      {!wrapOrGrid && (
        <PropRow toggle label="Spread" hint="Push the members to the box's edges instead of packing them at the gap. Needs a fixed size on the flow axis.">
          <Switch checked={layout.spaceBetween} onCheckedChange={(v) => set("Space between", (l) => void (l.spaceBetween = v))} />
        </PropRow>
      )}

      <PropRow
        label="Padding"
        keyControl={
          <GroupKeyButton
            clip={clip}
            properties={[
              { property: "layout.padding.top", currentValue: () => pt },
              { property: "layout.padding.right", currentValue: () => pr },
              { property: "layout.padding.bottom", currentValue: () => pb },
              { property: "layout.padding.left", currentValue: () => pl },
            ]}
          />
        }
      >
        <Pair
          link={
            <IconToggle label={padLinked ? "Sides linked — edit one, set all" : "Sides independent"} pressed={padLinked} onClick={() => setPadLinked((v) => !v)}>
              {padLinked ? <Link2 /> : <Link2Off />}
            </IconToggle>
          }
        >
          <NumberInput value={pt} min={0} precision={0} unit="T" onChange={(v) => setPad("top", v)} />
          <NumberInput value={pr} min={0} precision={0} unit="R" onChange={(v) => setPad("right", v)} />
          <NumberInput value={pb} min={0} precision={0} unit="B" onChange={(v) => setPad("bottom", v)} />
          <NumberInput value={pl} min={0} precision={0} unit="L" onChange={(v) => setPad("left", v)} />
        </Pair>
      </PropRow>

      <PropRow label="Align" hint="Where the members sit inside the box.">
        <AlignGrid
          x={layout.alignX}
          y={layout.alignY}
          onPick={(x, y) =>
            set("Change alignment", (l) => {
              l.alignX = x;
              l.alignY = y;
            })
          }
        />
      </PropRow>

      <PropRow
        label="Size"
        keyControl={
          layout.width !== null || layout.height !== null ? (
            <GroupKeyButton
              clip={clip}
              properties={[
                ...(layout.width !== null ? [{ property: "layout.width", currentValue: () => w }] : []),
                ...(layout.height !== null ? [{ property: "layout.height", currentValue: () => h }] : []),
              ]}
            />
          ) : undefined
        }
      >
        <Pair>
          <BoxSizeField
            axis="W"
            value={layout.width === null ? null : w}
            hug={Math.round(hug.width)}
            bounded={layout.minWidth !== null || layout.maxWidth !== null}
            onMode={(fixed) => store.update(fixed ? "Fixed width" : "Hug width", (d) => void setBoxSizing(d, clip.id, "x", fixed ? "fixed" : "hug"))}
            onValue={num("layout.width", "Change width", "layout-w")}
            onBounds={(on) => set(on ? "Width limits" : "No width limits", (l) => {
              l.minWidth = on ? Math.round(hug.width) : null;
              l.maxWidth = null;
            })}
          />
          <BoxSizeField
            axis="H"
            value={layout.height === null ? null : h}
            hug={Math.round(hug.height)}
            bounded={layout.minHeight !== null || layout.maxHeight !== null}
            onMode={(fixed) => store.update(fixed ? "Fixed height" : "Hug height", (d) => void setBoxSizing(d, clip.id, "y", fixed ? "fixed" : "hug"))}
            onValue={num("layout.height", "Change height", "layout-h")}
            onBounds={(on) => set(on ? "Height limits" : "No height limits", (l) => {
              l.minHeight = on ? Math.round(hug.height) : null;
              l.maxHeight = null;
            })}
          />
        </Pair>
      </PropRow>
      {(layout.minWidth !== null || layout.maxWidth !== null) && (
        <PropRow label="Width">
          <Pair>
            <NumberInput label="Min" value={layout.minWidth ?? 0} min={0} precision={0} onChange={(v) => set("Min width", (l) => void (l.minWidth = v > 0 ? v : null))} />
            <NumberInput label="Max" value={layout.maxWidth ?? 0} min={0} precision={0} onChange={(v) => set("Max width", (l) => void (l.maxWidth = v > 0 ? v : null))} />
          </Pair>
        </PropRow>
      )}
      {(layout.minHeight !== null || layout.maxHeight !== null) && (
        <PropRow label="Height">
          <Pair>
            <NumberInput label="Min" value={layout.minHeight ?? 0} min={0} precision={0} onChange={(v) => set("Min height", (l) => void (l.minHeight = v > 0 ? v : null))} />
            <NumberInput label="Max" value={layout.maxHeight ?? 0} min={0} precision={0} onChange={(v) => set("Max height", (l) => void (l.maxHeight = v > 0 ? v : null))} />
          </Pair>
        </PropRow>
      )}

      <PropRow toggle label="Clip content" hint="Mask the members to the box.">
        <Switch checked={layout.clipContent} onCheckedChange={(v) => set("Clip content", (l) => void (l.clipContent = v))} />
      </PropRow>
    </PanelSection>
  );
}

function writeLayoutPath(layout: LayoutSpec, path: string, v: number): void {
  switch (path) {
    case "layout.gap": layout.gap = Math.max(0, v); return;
    case "layout.lineGap": layout.lineGap = Math.max(0, v); return;
    case "layout.width": layout.width = Math.max(1, v); return;
    case "layout.height": layout.height = Math.max(1, v); return;
  }
}

/**
 * One axis of the box: `W 618 · Hug ▾` — Figma's field. The number is the
 * size either way (hugging, it reads the size the members give it, and typing
 * fixes it there); the menu says which, and holds the limits.
 */
function BoxSizeField({
  axis,
  value,
  hug,
  bounded,
  onMode,
  onValue,
  onBounds,
}: {
  axis: "W" | "H";
  value: number | null;
  hug: number;
  bounded: boolean;
  onMode: (fixed: boolean) => void;
  onValue: (v: number) => void;
  onBounds: (on: boolean) => void;
}) {
  const noun = axis === "W" ? "width" : "height";
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <NumberInput
        className="min-w-0 flex-1"
        label={axis}
        value={value ?? hug}
        min={1}
        precision={0}
        onChange={(v) => {
          if (value === null) onMode(true);
          onValue(v);
        }}
      />
      <SizeModeMenu
        label={value === null ? "Hug" : "Fixed"}
        options={[
          { id: "hug", label: "Hug contents", on: value === null, pick: () => onMode(false) },
          { id: "fixed", label: `Fixed ${noun}`, on: value !== null, pick: () => onMode(true) },
        ]}
        extra={{ label: bounded ? `Remove ${noun} limits` : `Add min / max ${noun}`, pick: () => onBounds(!bounded) }}
      />
    </div>
  );
}

/** The small `Hug ▾` chip beside a size field — one menu, the same everywhere. */
function SizeModeMenu({
  label,
  options,
  extra,
  disabled,
}: {
  label: string;
  options: { id: string; label: string; on: boolean; pick: () => void; disabled?: boolean }[];
  extra?: { label: string; pick: () => void };
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="flex h-7 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground disabled:opacity-40"
        >
          {label}
          <ChevronDown className="size-3 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {options.map((o) => (
          <DropdownMenuCheckboxItem key={o.id} checked={o.on} disabled={o.disabled} onCheckedChange={() => o.pick()}>
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
        {extra && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={extra.pick}>{extra.label}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Figma's nine-dot alignment picker. */
function AlignGrid({ x, y, onPick }: { x: LayoutAlign; y: LayoutAlign; onPick: (x: LayoutAlign, y: LayoutAlign) => void }) {
  const cells: LayoutAlign[] = ["start", "center", "end"];
  return (
    <div className="grid w-fit grid-cols-3 gap-px rounded-md border border-border/60 bg-muted/40 p-1">
      {cells.map((cy) =>
        cells.map((cx) => {
          const on = cx === x && cy === y;
          return (
            <button
              key={`${cx}-${cy}`}
              type="button"
              aria-label={`${cy} ${cx}`}
              aria-pressed={on}
              onClick={() => onPick(cx, cy)}
              className={cn(
                "flex size-5 items-center justify-center rounded-sm transition-colors hover:bg-muted",
                on && "bg-primary/15",
              )}
            >
              <span className={cn("size-1.5 rounded-full", on ? "bg-primary" : "bg-muted-foreground/40")} />
            </button>
          );
        }),
      )}
    </div>
  );
}

/**
 * A MEMBER's side of the bargain: fill the slot or keep its size, or opt out
 * and float free (Figma "absolute position"). Shown on any layer that sits on
 * a laid-out group's rows.
 */
export function LayoutItemSection({ clip }: { clip: VisualClip }) {
  const doc = useDoc();
  const store = useDocStore();
  const update = useClipUpdater(clip.id);
  const container = isLayoutMember(doc, clip.id);
  if (!container) return null;
  const item = clip.layoutItem;
  const set = (label: string, mutate: (it: VisualClip["layoutItem"]) => void) =>
    update(label, (c) => void (c.kind !== "audio" && mutate(c.layoutItem)));
  const box = clipBox(doc, clip);
  const modes = memberSizings(clip);
  const axisField = (axis: LayoutAxis) => {
    const noun = axis === "x" ? "width" : "height";
    const mode = memberSizing(clip, axis);
    const pick = (next: LayoutSizing) =>
      store.update(`${SIZING_LABEL[next]} ${noun}`, (d) => void setMemberSizing(d, clip.id, axis, next));
    return (
      <div className="flex min-w-0 items-center gap-0.5">
        <NumberInput
          className={cn("min-w-0 flex-1", mode !== "fixed" && "opacity-60")}
          label={axis === "x" ? "W" : "H"}
          value={Math.round(axis === "x" ? box.width : box.height)}
          min={1}
          precision={0}
          disabled={item.absolute || !modes.includes("fixed") || !canTypeSize(clip)}
          onChange={(v) =>
            store.update(`Set ${noun}`, (d) => {
              setMemberSizing(d, clip.id, axis, "fixed");
              const c = locateClip(d, clip.id)?.clip;
              if (c) writeMemberSize(c, axis, v);
            }, { mergeKey: `member-size-${axis}-${clip.id}` })
          }
        />
        <SizeModeMenu
          label={SIZING_LABEL[mode]}
          disabled={item.absolute}
          options={modes.map((m) => ({ id: m, label: `${SIZING_LABEL[m]} ${m === "hug" ? "contents" : noun}`, on: mode === m, pick: () => pick(m) }))}
        />
      </div>
    );
  };
  return (
    <PanelSection id="layout-item" title="In layout" hint={`Arranged by “${container.name}”.`} defaultOpen>
      <PropRow label="Size">
        <Pair>
          {axisField("x")}
          {axisField("y")}
        </Pair>
      </PropRow>
      {(item.fillX || item.fillY) && (
        <PropRow label="Limits" hint="The smallest and largest slot this layer accepts. 0 is none.">
          <Pair>
            <NumberInput label="Min" value={(item.fillX ? item.minWidth : item.minHeight) ?? 0} min={0} precision={0} onChange={(v) => set("Min size", (it) => { if (item.fillX) it.minWidth = v > 0 ? v : null; if (item.fillY) it.minHeight = v > 0 ? v : null; })} />
            <NumberInput label="Max" value={(item.fillX ? item.maxWidth : item.maxHeight) ?? 0} min={0} precision={0} onChange={(v) => set("Max size", (it) => { if (item.fillX) it.maxWidth = v > 0 ? v : null; if (item.fillY) it.maxHeight = v > 0 ? v : null; })} />
          </Pair>
        </PropRow>
      )}
      <PropRow toggle label="Absolute" hint="Keep its own place and take no slot.">
        <Switch checked={item.absolute} onCheckedChange={(v) => set("Absolute position", (it) => void (it.absolute = v))} />
      </PropRow>
    </PanelSection>
  );
}

const SIZING_LABEL: Record<LayoutSizing, string> = { fixed: "Fixed", hug: "Hug", fill: "Fill" };

/** Kinds whose size is a number you can type here (media keeps its pixels). */
function canTypeSize(clip: VisualClip): boolean {
  return clip.kind === "shape" || clip.kind === "raster" || clip.kind === "text" || (clip.kind === "group" && clip.layout !== null);
}

/** A typed size, written to what that kind calls its size. */
function writeMemberSize(c: Clip, axis: LayoutAxis, v: number): void {
  const n = Math.max(1, Math.round(v));
  if (c.kind === "shape" || c.kind === "raster") {
    if (axis === "x") c.width = n;
    else c.height = n;
  } else if (c.kind === "text") {
    if (axis === "x") c.maxWidth = n;
    else c.maxHeight = n;
  } else if (c.kind === "group" && c.layout) {
    c.layout = { ...c.layout, [axis === "x" ? "width" : "height"]: n };
  }
}
