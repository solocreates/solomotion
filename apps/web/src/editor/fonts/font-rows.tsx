"use client";

import * as React from "react";
import {
  drawableWeight,
  drawsLatin,
  nativeSample,
  offeredWeights,
  styleCount,
  weightName,
  type FaceStyle,
  type FontFamilyMeta,
} from "@solomotion/core";
import { Check, Copy, FolderPlus, Star, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useMarks, useCollections } from "../state/marks";
import { DRAG_OUT_PROPS } from "../panels/drag-out";
import { fontMark, removeFontFamily } from "./font-actions";
import { useSpecimen } from "./specimens";

/**
 * The pieces both font browsers are built from: a list ROW (the quick picker),
 * a specimen CARD (the Fonts window), the weight METER, the ramp, the star and
 * the right-click menu. One of each, so a star means the same thing, and a
 * weight meter reads the same way, at either size.
 */

/* ------------------------------------------------------------------ meter */

/**
 * THE WEIGHT METER — nine hairlines, Thin to Black, each one as thick as the
 * weight it stands for, lit where the family can draw it. A family's whole
 * weight story in 30px: a single-weight display face is one lit bar, a
 * variable family is a solid run, a static family shows its gaps.
 */
export function WeightMeter({ meta, className }: { meta: FontFamilyMeta; className?: string }) {
  const lit = (w: number) =>
    meta.variable ? w >= meta.variable.min && w <= meta.variable.max : meta.weights.includes(w);
  const n = styleCount(meta);
  const label = meta.variable
    ? `Variable · ${meta.variable.min}–${meta.variable.max}${meta.italics.length ? " · italics" : ""}`
    : `${meta.weights.length} ${meta.weights.length === 1 ? "weight" : "weights"}${meta.italics.length ? ` · ${n} styles` : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("flex h-3 shrink-0 items-end gap-[2px]", className)} aria-label={label}>
          {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w, i) => (
            <span
              key={w}
              className={cn("rounded-full", lit(w) ? "bg-foreground/70" : "bg-foreground/12")}
              style={{ width: 1 + i * 0.25, height: 5 + i * 0.85 }}
            />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------- star */

export function useFontStarred(family: string): boolean {
  return useMarks((s) => s.verdicts[`font/${family}`] === "starred");
}

export function StarButton({ family, className }: { family: string; className?: string }) {
  const starred = useFontStarred(family);
  const mark = useMarks((s) => s.mark);
  return (
    <button
      type="button"
      aria-label={starred ? `Unstar ${family}` : `Star ${family}`}
      aria-pressed={starred}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        mark(fontMark(family), "starred");
      }}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md transition-[opacity,color] hover:bg-foreground/8 [&_svg]:size-3.5",
        starred ? "text-[#F5B843]" : "text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        className,
      )}
    >
      <Star className={cn(starred && "fill-current")} />
    </button>
  );
}

/* ------------------------------------------------------------------- menu */

function FontMenu({ meta, onUse }: { meta: FontFamilyMeta; onUse?: () => void }) {
  const starred = useFontStarred(meta.family);
  const mark = useMarks((s) => s.mark);
  const toggleIn = useMarks((s) => s.toggleIn);
  const newCollection = useMarks((s) => s.newCollection);
  const collections = useCollections();
  const ref = fontMark(meta.family);
  const key = `font/${meta.family}`;
  return (
    <ContextMenuContent className="w-52">
      {onUse && <ContextMenuItem onSelect={onUse}>Use {meta.family}</ContextMenuItem>}
      <ContextMenuItem onSelect={() => mark(ref, "starred")}>
        <Star /> {starred ? "Unstar" : "Star"}
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <FolderPlus /> Collections
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-48">
          {collections.map((c) => (
            <ContextMenuCheckboxItem
              key={c.id}
              checked={c.keys.includes(key)}
              onCheckedChange={() => toggleIn(c.id, ref)}
            >
              {c.name}
            </ContextMenuCheckboxItem>
          ))}
          {collections.length > 0 && <ContextMenuSeparator />}
          <ContextMenuItem onSelect={() => newCollection(meta.family, ref)}>New collection</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem
        onSelect={() => {
          void navigator.clipboard?.writeText(meta.family);
          toast("Font name copied");
        }}
      >
        <Copy /> Copy name
      </ContextMenuItem>
      {meta.source === "yours" && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => void removeFontFamily(meta.family)}
          >
            <Trash2 /> Remove from this device
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}

/* -------------------------------------------------------------------- row */

export const ROW_H = 32;

/** The line a list row sets: its own name, or its own script when it cannot set Latin. */
function rowSpecimenText(meta: FontFamilyMeta): string {
  return drawsLatin(meta) ? meta.family : (nativeSample(meta) ?? meta.family);
}

/**
 * One family in the quick picker: its name in its own face, the meter, a star.
 * The name renders in the UI font, faded, until the specimen lands — then in
 * the face itself. Never in a face that can be swapped out from under it (see
 * `specimens.ts`): that swap was the blink on hover.
 */
export const FontRow = React.memo(function FontRow({
  meta,
  rowKey,
  active,
  selected,
  onPick,
  onHover,
}: {
  meta: FontFamilyMeta;
  /** Which row this is — a family can be listed in two sections at once. */
  rowKey: string;
  active: boolean;
  selected: boolean;
  onPick: (meta: FontFamilyMeta) => void;
  onHover: (meta: FontFamilyMeta, rowKey: string) => void;
}) {
  const text = rowSpecimenText(meta);
  const face = useSpecimen({ meta, text, weights: "regular" });
  const native = text !== meta.family;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="option"
          aria-selected={active}
          data-font-row=""
          onPointerEnter={() => onHover(meta, rowKey)}
          onClick={() => onPick(meta)}
          style={{ height: ROW_H }}
          className={cn(
            "group flex w-full cursor-default items-center gap-2 rounded-md pl-2 pr-1 transition-colors",
            active ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]",
          )}
        >
          <Check className={cn("size-3 shrink-0 text-primary", selected ? "opacity-100" : "opacity-0")} />
          {native ? (
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="shrink-0 truncate text-sm text-foreground/80">{meta.family}</span>
              <span
                className="min-w-0 truncate text-base text-muted-foreground transition-opacity duration-200"
                style={{ fontFamily: face ?? undefined, opacity: face ? 1 : 0 }}
              >
                {text}
              </span>
            </span>
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-lg leading-none transition-opacity duration-200"
              style={{ fontFamily: face ?? undefined, opacity: face ? 1 : 0.45 }}
            >
              {meta.family}
            </span>
          )}
          <WeightMeter meta={meta} className="opacity-60 group-hover:opacity-100" />
          <StarButton family={meta.family} />
        </div>
      </ContextMenuTrigger>
      <FontMenu meta={meta} onUse={() => onPick(meta)} />
    </ContextMenu>
  );
});

/* ------------------------------------------------------------------- card */

/** Card chrome around the specimen line: the header row plus padding. */
const CARD_CHROME = 58;
export const cardHeight = (size: number) => Math.round(CARD_CHROME + size * 1.3);

export const DEFAULT_SAMPLE = "Sphinx of black quartz, judge my vow";

/** The characters every card's specimen must hold: the line, and the ramp's "Aa". */
const RAMP_TEXT = "Aa";

/**
 * One family in the Fonts window: a specimen set BIG, at the weight you chose
 * or its own Regular, with its whole weight ramp beside the name. Hover a step
 * of the ramp and the line re-sets in that weight — no request, the card
 * loaded every weight at once (one file on a variable axis) — click it to use
 * that exact face.
 */
export const FontCard = React.memo(function FontCard({
  meta,
  sample,
  settledSample,
  script,
  size,
  weight,
  active,
  selected,
  canUse,
  onUse,
  onPress,
}: {
  meta: FontFamilyMeta;
  /** What you are typing — drawn as you type. */
  sample: string;
  /** The same text once you pause — what the specimen is FETCHED for. */
  settledSample: string;
  script: string | null;
  size: number;
  weight: number | null;
  active: boolean;
  selected: boolean;
  /** Something is selected to apply the font to (else Use makes a text layer). */
  canUse: boolean;
  onUse: (meta: FontFamilyMeta, face?: FaceStyle) => void;
  /**
   * The press — handed to the app's drag-out controller: below its threshold it
   * is a click (select the card; applying is the double-click, so a stray click
   * never restyles the layer), past it a drag that drops a text layer set in
   * this font onto the stage or timeline.
   */
  onPress: (e: React.PointerEvent, meta: FontFamilyMeta) => void;
}) {
  const line = sample || nativeSample(meta, script) || DEFAULT_SAMPLE;
  const settled = settledSample || nativeSample(meta, script) || DEFAULT_SAMPLE;
  const fresh = useSpecimen({ meta, text: settled + RAMP_TEXT, weights: "all" });
  // Until the specimen for new text lands, keep drawing with the last one: the
  // glyphs it has stay in the face, and only the few new ones fall back for a
  // beat — rather than every card blinking to the UI font on each keystroke.
  const last = React.useRef<string | null>(null);
  if (fresh) last.current = fresh;
  const face = fresh ?? last.current;
  const ramp = offeredWeights(meta);
  const [hoverWeight, setHoverWeight] = React.useState<number | null>(null);
  const shown = hoverWeight ?? drawableWeight(meta, weight ?? 400);
  const personality = [...meta.feelings.slice(0, 2), ...meta.styles.slice(0, 1)];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="option"
          aria-selected={active}
          {...DRAG_OUT_PROPS}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            onPress(e, meta);
          }}
          onDoubleClick={() => onUse(meta)}
          style={{ height: cardHeight(size) - 6 }}
          className={cn(
            "group relative mb-1.5 flex w-full cursor-grab touch-pan-y flex-col justify-center gap-1.5 overflow-hidden rounded-[--radius] px-4 transition-colors",
            active ? "bg-foreground/[0.055]" : "hover:bg-foreground/[0.035]",
            selected && "ring-1 ring-inset ring-primary/50",
          )}
        >
          <div className="flex h-6 min-w-0 items-center gap-2">
            <span className={cn("shrink-0 truncate text-sm font-medium", selected ? "text-primary" : "text-foreground")}>
              {meta.family}
            </span>
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
              {hoverWeight !== null
                ? `${weightName(hoverWeight)} · ${hoverWeight}`
                : meta.variable
                  ? "Variable"
                  : `${styleCount(meta)} ${styleCount(meta) === 1 ? "style" : "styles"}`}
            </span>
            {meta.designer && (
              <span className="hidden min-w-0 truncate text-2xs text-muted-foreground/70 @[720px]:inline">
                {meta.designer}
              </span>
            )}
            <span className="flex-1" />
            {personality.map((p) => (
              <span
                key={p}
                className="hidden shrink-0 rounded-full bg-foreground/[0.06] px-1.5 text-2xs leading-4 text-muted-foreground @[560px]:inline"
              >
                {p}
              </span>
            ))}
            <WeightRamp
              meta={meta}
              ramp={ramp}
              face={face}
              current={shown}
              onHoverWeight={setHoverWeight}
              onPickWeight={(w) => onUse(meta, { weight: w, italic: false })}
            />
            <StarButton family={meta.family} />
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onUse(meta)}
              className={cn(
                "h-6 shrink-0 rounded-md px-2 text-2xs font-medium transition-[opacity,background-color]",
                "material-glass-raised text-primary hover:brightness-110",
                active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
            >
              {canUse ? "Use" : "Add text"}
            </button>
          </div>
          <div
            // Faded off the edge, never an ellipsis: "…" reads as the font's
            // own glyph, and a specimen is a view through a window, not a label.
            className="overflow-hidden whitespace-nowrap leading-[1.2] text-foreground transition-opacity duration-300 [mask-image:linear-gradient(90deg,#000_82%,transparent)]"
            style={{
              fontFamily: face ?? undefined,
              fontSize: size,
              fontWeight: shown,
              opacity: face ? 1 : 0.14,
            }}
          >
            {line}
          </div>
        </div>
      </ContextMenuTrigger>
      <FontMenu meta={meta} onUse={() => onUse(meta)} />
    </ContextMenu>
  );
});

/**
 * THE RAMP — "Aa" at every weight the family draws, lightest to heaviest. It is
 * the thickness range made visible, and a face picker in the same gesture.
 */
function WeightRamp({
  meta,
  ramp,
  face,
  current,
  onHoverWeight,
  onPickWeight,
}: {
  meta: FontFamilyMeta;
  ramp: number[];
  face: string | null;
  current: number;
  onHoverWeight: (w: number | null) => void;
  onPickWeight: (w: number) => void;
}) {
  if (ramp.length < 2) return null;
  return (
    <span className="hidden shrink-0 items-center @[480px]:flex" onPointerLeave={() => onHoverWeight(null)}>
      {ramp.map((w) => (
        <button
          key={w}
          type="button"
          aria-label={`${meta.family} ${weightName(w)}`}
          onPointerEnter={() => onHoverWeight(w)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onPickWeight(w);
          }}
          className={cn(
            "flex h-6 min-w-[1.375rem] items-center justify-center rounded px-0.5 text-sm transition-colors",
            w === current ? "text-foreground" : "text-muted-foreground/60 hover:text-foreground",
          )}
          style={{ fontFamily: face ?? undefined, fontWeight: w }}
        >
          Aa
        </button>
      ))}
    </span>
  );
}
