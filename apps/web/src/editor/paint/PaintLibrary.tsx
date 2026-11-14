"use client";

import * as React from "react";
import {
  PALETTE_LIBRARIES,
  PATTERN_DESIGNS,
  patternFromDesign,
  patternPaint,
  type PatternDesign,
  addVariable,
  libraryEntries,
  resolvePaint,
  solidPaint,
  variablePaint,
  type LibraryEntry,
  type Paint,
  type Variable,
} from "@solomotion/core";
import { Bookmark, ChevronRight, Link2Off, PanelLeftClose, PanelLeftOpen, Plus, Settings2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { PaintCanvas, PaintPreview } from "./PaintPreview";
import { makeColorResolver } from "../stage/render/paint-style";
import { recentPaints, subscribeRecentPaints } from "./recent-paints";
import { SHELF_LABEL, shelfKindOf, type ShelfKind } from "./paint-kind";

/**
 * THE fill library — one browser, on the left of the paint editor, on every tab.
 *
 * It replaced three surfaces that were each answering the same question. The
 * colour picker owned a private variables rail and a private recents strip; the
 * paint editor owned a horizontal shelf of palette chips above them both. Three
 * scroll directions, three visual languages, three ideas of what "a saved fill"
 * is — and none of them could show a gradient, because the rail only understood
 * colours. Stacked in one popover they read exactly as they looked: crowded.
 *
 * So: one vertical column, one scroll area, and every source of fills as a
 * collapsible SECTION of it. Your styles, your recents and each shipped palette
 * are the same kind of thing seen from different angles, and a browser with
 * sections scales to a hundred palettes where a row of tabs stopped working at
 * five. Open/closed state per section is remembered, because which palettes you
 * work from is a habit, not a per-popover decision.
 *
 * Binding and applying stay different verbs with different marks: a bound entry
 * follows its style forever and says so; a preset is a copy you own from the
 * moment you click it. Blurring those is how people edit a shared palette by
 * accident.
 */

const OPEN_KEY = "tm-paint-library-open";
const SHOWN_KEY = "tm-paint-library-shown";

function loadShown(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(SHOWN_KEY) !== "0";
}

/**
 * A palette's entries of one kind, computed once per (palette, kind).
 *
 * `libraryEntries` is pure over a STATIC library, so recomputing it for all
 * seven palettes on every render was pure waste — and worse than waste: it
 * mints fresh stop ids each call, so every render handed React a new identity
 * for every swatch and threw the whole grid away. A collapsed section paid for
 * it too, because the header shows a count.
 */
const shelfCache = new Map<string, LibraryEntry[]>();

/** One frozen empty list, shared. See the note at its use site. */
const NO_PAINTS: Paint[] = [];
const noPaints = () => NO_PAINTS;

function paletteShelf(lib: (typeof PALETTE_LIBRARIES)[number], kind: ShelfKind): LibraryEntry[] {
  const key = `${lib.id}:${kind}`;
  const hit = shelfCache.get(key);
  if (hit) return hit;
  const entries = libraryEntries(lib).filter((e) => e.kind === kind);
  shelfCache.set(key, entries);
  return entries;
}

function loadOpen(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function PaintLibrary({
  kind,
  /** The live paint on the entry — what "save this" would capture. */
  current,
  /** The variable this entry is bound to, if any. */
  boundId,
  onBind,
  onApplyDesign,
  onDetach,
  onApply,
  styleTypes = ["paint"],
  className,
}: {
  kind: ShelfKind;
  current: Paint;
  boundId: string | null;
  onBind: (variableId: string) => void;
  /** Apply a pattern DESIGN — its form only, keeping the fill's own colours.
   *  Present on the pattern tab; absent everywhere else. */
  onApplyDesign?: (design: PatternDesign) => void;
  onDetach: () => void;
  onApply: (paint: Paint) => void;
  /**
   * Which variable types this slot can actually BIND.
   *
   * A fill entry holds a reference to a `paint` variable; a bare colour slot
   * holds a `var:` token, which only a `color` variable answers. Showing a slot
   * a style it cannot hold is worse than showing it nothing — the click either
   * silently does the wrong thing or silently does nothing. So the library
   * lists what this slot can take, and the ONE browser stays one browser.
   */
  styleTypes?: ReadonlyArray<"paint" | "color">;
  className?: string;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const openVariables = useSession((s) => s.setVariablesOpen);
  const resolve = React.useMemo(() => makeColorResolver(doc), [doc]);

  /** The colours the design shelf previews in — the fill's own, so the shelf
   *  answers "what would MY pattern look like as a chevron". Falls back to the
   *  spec defaults before a pattern exists. */
  const designTones = React.useMemo(() => {
    const p = current;
    return p && p.type === "pattern"
      ? { color: p.pattern.color, background: p.pattern.background }
      : { color: "#1E1E1E", background: "#FFFFFF" };
  }, [current]);

  const [open, setOpen] = React.useState<Record<string, boolean>>(loadOpen);
  /**
   * THE WHOLE COLUMN FOLDS AWAY.
   *
   * Not everyone works from a palette, and a browser you are not using is space
   * the editor could have had and work the panel need not do. Folded, this
   * renders one button — so it is also the fastest the picker can possibly
   * open, without anyone having to know that closing sections is what makes it
   * quick.
   */
  const [shown, setShownState] = React.useState<boolean>(loadShown);
  const setShown = (next: boolean) => {
    setShownState(next);
    try {
      window.localStorage.setItem(SHOWN_KEY, next ? "1" : "0");
    } catch {
      // A remembered preference is a nicety, not a requirement.
    }
  };
  const toggle = (id: string, fallback: boolean) => {
    setOpen((prev) => {
      const next = { ...prev, [id]: !(prev[id] ?? fallback) };
      try {
        window.localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // Remembering which sections were open is a nicety, not a requirement.
      }
      return next;
    });
  };

  // Recents live outside React; subscribe so saving a fill updates the list
  // under the popover that saved it.
  // The server snapshot must be the SAME array every call, not merely an equal
  // one: `useSyncExternalStore` compares by identity, and a fresh `[]` per call
  // is an endless "the store changed" — which is exactly the update-depth loop
  // this panel was throwing.
  const recents = React.useSyncExternalStore(subscribeRecentPaints, () => recentPaints(kind), noPaints);

  /** The document's own fill styles of this kind, newest last (creation order
   *  is the only order a person can predict). */
  const styles = React.useMemo<Array<{ id: string; name: string; paint: Paint }>>(
    () =>
      doc.variables.flatMap((v: Variable) => {
        if (v.type === "paint" && styleTypes.includes("paint")) {
          const paint = resolvePaint(doc, v.value);
          return shelfKindOf(paint) === kind ? [{ id: v.id, name: v.name, paint }] : [];
        }
        // A colour variable IS a solid fill — it belongs on the solid shelf
        // rather than in a second list somewhere else.
        if (v.type === "color" && kind === "solid" && styleTypes.includes("color")) {
          return [{ id: v.id, name: v.name, paint: solidPaint(v.value) }];
        }
        return [];
      }),
    [doc, kind, styleTypes],
  );

  const saveAsStyle = () =>
    store.update("Save fill style", (d) => {
      // Save the kind this slot can hold. A colour row saving a `paint`
      // variable would produce a style it could not then bind to.
      const made =
        styleTypes.includes("paint") || current.type !== "solid"
          ? addVariable(d, "paint", defaultStyleName(current), structuredClone(current))
          : addVariable(d, "color", defaultStyleName(current), current.color);
      onBind(made.id);
    });

  if (!shown) {
    return (
      <div className="relative w-7 shrink-0 border-r border-border/50">
        <button
          type="button"
          onClick={() => setShown(true)}
          title="Show the library"
          className="absolute inset-0 flex items-start justify-center pt-2 text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3.5"
        >
          <PanelLeftOpen />
        </button>
      </div>
    );
  }

  return (
    /*
      THE LIBRARY NEVER SIZES THE PANEL — and the editor column always does.

      A flex row is as tall as its tallest child, so a column of 72 swatches
      stretched the whole popover to the height of the list and the picker sat
      in a metre of empty panel beside it.

      Two facts do the whole job, and neither is a workaround:

        1. This column's only child is ABSOLUTE, so it contributes no intrinsic
           height and the row is measured from the editor alone.
        2. A stretched flex item has a DEFINITE used height, so `inset-0`
           resolves against it and the scroller inside gets a real height to
           scroll within.

      Both halves are needed. The previous attempt absolutely positioned the
      ScrollArea itself, one level further in — but its viewport is `flex-1
      min-h-0` and needs a definite height from its parent, and that parent was
      a `flex-1` div inside an auto-height column, which has none. Right idea,
      one level too deep.
    */
    <div className={cn("relative w-[148px] shrink-0 border-r border-border/50", className)}>
      <div className="absolute inset-0 flex flex-col">
        <button
          type="button"
          onClick={() => setShown(false)}
          title="Hide the library"
          className="flex h-6 shrink-0 items-center gap-1 border-b border-border/50 px-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 transition-colors hover:text-foreground [&_svg]:size-3"
        >
          <PanelLeftClose /> Library
        </button>
      <ScrollArea className="min-h-0 flex-1" viewportClassName="p-1.5">
        <Section
          id="styles"
          label="Styles"
          count={styles.length}
          open={open.styles ?? false}
          onToggle={() => toggle("styles", false)}
          action={
            boundId
              ? { icon: <Link2Off />, label: "Unlink from this style", onClick: onDetach }
              : { icon: <Bookmark />, label: `Save this ${SHELF_LABEL[kind]} as a style`, onClick: saveAsStyle }
          }
        >
          {styles.length === 0 ? (
            <Empty onClick={saveAsStyle} label={`Save this ${SHELF_LABEL[kind]}`} />
          ) : (
            <Swatches>
              {styles.map((v) => (
                <Swatch
                  key={v.id}
                  label={v.name}
                  paint={v.paint}
                  bound={v.id === boundId}
                  onClick={() => (v.id === boundId ? onDetach() : onBind(v.id))}
                />
              ))}
            </Swatches>
          )}
        </Section>

        {recents.length > 0 && (
          <Section
            id="recent"
            label="Recent"
            count={recents.length}
            open={open.recent ?? false}
            onToggle={() => toggle("recent", false)}
          >
            <Swatches>
              {recents.map((p, i) => (
                <Swatch
                  key={i}
                  label="Recent"
                  paint={p}
                  resolve={resolve}
                  onClick={() => onApply(structuredClone(p))}
                />
              ))}
            </Swatches>
          </Section>
        )}

        {/* PATTERN DESIGNS — form, not colour.

            A design says "pinstripe at 14px"; it says nothing about what
            colour that is, which is why `PATTERN_DESIGNS` stores no colours.
            So the shelf previews each design in the colours THIS fill is
            already wearing, and picking one changes the form and leaves the
            palette alone. Colouring it afterwards is the Mark and Ground
            swatches below, which open the full colour library.

            This replaces seventy pre-tinted pattern entries that existed only
            because form and colour had been multiplied together. */}
        {kind === "pattern" && onApplyDesign && (
          <Section
            id="designs"
            label="Designs"
            count={PATTERN_DESIGNS.length}
            open={open.designs ?? true}
            onToggle={() => toggle("designs", true)}
          >
            {/* Full-width cards, not a swatch grid. A design is a FORM, and
                form needs room to be recognisable — a chevron and a zigzag are
                the same four dark pixels at 30px. At full width the tiling
                actually reads, and the name is next to it rather than hidden in
                a tooltip. Twelve of these is a short, scannable list; twelve
                tiny squares was a puzzle. */}
            <div className="space-y-1">
              {PATTERN_DESIGNS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onApplyDesign(d)}
                  className="group/design relative block h-14 w-full overflow-hidden rounded-md shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] transition-shadow hover:shadow-[inset_0_0_0_1px_var(--primary)]"
                >
                  <PaintCanvas
                    paint={patternPaint(patternFromDesign(d, designTones.color, designTones.background))}
                    resolve={resolve}
                  />
                  <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-3 text-left text-[10px] font-medium text-white">
                    {d.name}
                  </span>
                </button>
              ))}
            </div>
          </Section>
        )}

        {PALETTE_LIBRARIES.map((lib, i) => {
          const entries = paletteShelf(lib, kind);
          if (entries.length === 0) return null;
          /* NOTHING OPENS ITSELF.

             A section's swatches only exist while it is open, so what the
             library costs is exactly what you asked to see — and a closed
             section is one header. Opening the picker used to build every
             swatch of every expanded section before painting anything, which is
             why it was fast only once you had closed them by hand.

             So the default IS the fast case, and the panel opens as a short
             list of categories. Which you open is remembered, because that is a
             habit, not a per-popover decision. */
          const isOpen = open[lib.id] ?? false;
          return (
            <Section
              key={lib.id}
              id={lib.id}
              label={lib.name}
              accent={lib.accent}
              hint={lib.blurb}
              count={entries.length}
              open={isOpen}
              onToggle={() => toggle(lib.id, false)}
            >
              <Swatches>
                {entries.map((e, n) => (
                  <Swatch
                    key={`${lib.id}-${n}`}
                    label={e.name}
                    paint={e.paint}
                    resolve={resolve}
                    onClick={() => onApply(structuredClone(e.paint))}
                  />
                ))}
              </Swatches>
            </Section>
          );
        })}
      </ScrollArea>

      <button
        type="button"
        onClick={() => openVariables(true)}
        className="flex h-7 shrink-0 items-center gap-1.5 border-t border-border/50 px-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3"
      >
        <Settings2 /> Manage
      </button>
      </div>
    </div>
  );
}

function Section({
  label,
  count,
  accent,
  hint,
  open,
  onToggle,
  action,
  children,
}: {
  id: string;
  label: string;
  count: number;
  accent?: string;
  hint?: string;
  open: boolean;
  onToggle: () => void;
  action?: { icon: React.ReactNode; label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <section className="mb-0.5">
      <div className="group/sec flex h-6 items-center gap-1 rounded pl-0.5 pr-0.5 hover:bg-muted/40">
        <button
          type="button"
          onClick={onToggle}
          title={hint}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
          {accent && <span className="size-2 shrink-0 rounded-full" style={{ background: accent }} />}
          <span className="min-w-0 truncate">{label}</span>
          <span className="font-mono text-[9px] font-normal tabular-nums opacity-40">{count}</span>
        </button>
        {action && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={action.label}
                onClick={action.onClick}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/sec:opacity-100 [&_svg]:size-3"
              >
                {action.icon}
              </button>
            </TooltipTrigger>
            <TooltipContent>{action.label}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {open && <div className="pb-1 pl-1 pt-0.5">{children}</div>}
    </section>
  );
}

/** Four to a row at this rail width — big enough to read a gradient's direction
 *  and a pattern's grain, which a 5-across grid of 22px chips cannot show. */
function Swatches({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-4 gap-1">{children}</div>;
}

function Swatch({
  label,
  paint,
  bound,
  resolve,
  onClick,
}: {
  label: string;
  paint: Paint;
  bound?: boolean;
  resolve?: ReturnType<typeof makeColorResolver>;
  onClick: () => void;
}) {
  /*
    A NATIVE `title`, not a Tooltip component.

    This is the single biggest reason the picker felt heavy. A swatch's tooltip
    is one word — its name — and wrapping each in a Radix Tooltip built a
    provider, a trigger and a portal per swatch. Seven palettes plus your own
    styles is several hundred of them, all constructed before you have hovered
    anything, and all of it re-rendered whenever the document changed.

    What is left is a button with a background: the browser handles thousands of
    those without noticing. Reach for the component again when a tooltip needs
    rich content or a controlled delay; a name is not that.
  */
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        "relative aspect-square w-full overflow-hidden rounded-[5px] transition-transform hover:scale-110",
        bound ? "shadow-[inset_0_0_0_2px_var(--primary)]" : "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]",
      )}
    >
      {resolve ? <PaintCanvas paint={paint} resolve={resolve} /> : <PaintPreview paint={paint} />}
    </button>
  );
}

function Empty({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/60 text-[10px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground [&_svg]:size-3"
    >
      <Plus /> {label}
    </button>
  );
}

/** A name that says what the style IS, so a table of them stays readable
 *  without anyone having to type. */
function defaultStyleName(paint: Paint): string {
  switch (paint.type) {
    case "solid":
      return paint.color.replace(/^#/, "").toUpperCase();
    case "linear":
    case "radial":
    case "angular":
      return `${paint.type[0]!.toUpperCase()}${paint.type.slice(1)} gradient`;
    case "pattern":
      return `${paint.pattern.kind[0]!.toUpperCase()}${paint.pattern.kind.slice(1)}`;
    case "media":
      return "Image fill";
    case "variable":
      return "Fill style";
  }
}

export { variablePaint, shelfKindOf };
export type { ShelfKind };
