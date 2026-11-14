"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  CHROME_ALIGNS,
  axisOfEdge,
  flyoutSide,
  slotKey,
  type ChromeAlign,
  type ChromeAxis,
  type ChromeEdge,
  type ChromePlacement,

} from "./chrome-layout";

export type { ChromeEdge, ChromeAlign, ChromePlacement, ChromeSlotKey } from "./chrome-layout";

/**
 * STAGE CHROME — the layout that makes overlap impossible.
 *
 * Every floating thing on the canvas used to position itself with its own
 * `absolute bottom-3 left-3`, and a 260-line pixel solver in core existed
 * purely to stop them landing on each other. That is a layout problem being
 * solved at runtime, per frame, by measurement — and it still lost.
 *
 * So chrome no longer positions itself. It names a PLACEMENT (an edge and an
 * alignment — see `chrome-layout.ts`) and this owns the rest:
 *
 *   ┌───────────── TOP BAND — full width, wraps, collapses ─────────────┐
 *   │  start …                     center                     … end     │
 *   ├───────────┬───────────────────────────────────────────┬───────────┤
 *   │ LEFT      │                                           │     RIGHT │
 *   │ COLUMN    │                (canvas)                   │    COLUMN │
 *   ├───────────┴───────────────────────────────────────────┴───────────┤
 *   │  start …                     center                     … end     │
 *   └────────── BOTTOM BAND — full width, collapses when empty ─────────┘
 *
 * NOTHING IS RESERVED. A band with no occupant is not rendered at all, so the
 * tool rail rises to the very top of the stage when there is nothing above it.
 * There are no fixed band heights to keep in sync and no arithmetic anywhere.
 *
 * ── THE BANDS SPAN THE FULL STAGE. THE COLUMNS DO NOT INSET THEM. ──
 *
 * This is the correction that matters, and it is why the breadcrumb used to
 * look like it was dodging things it was nowhere near. The bottom row lived
 * INSIDE the middle column, so it was inset on the left by the tool rail's
 * column and on the right by the brush handle's — chrome anchored to the bottom
 * edge was being pushed around by two capsules that sit hundreds of pixels
 * above it. It read exactly like a collision solver making bad guesses, because
 * structurally that is what a shared column is.
 *
 * The side columns now exist only in the MIDDLE row, between the two bands, so
 * the only thing they can take width from is the canvas — which is empty. The
 * bottom band starts at the stage's left edge no matter what is docked where,
 * and a bar centred in it is centred on the STAGE, the way Figma's is, rather
 * than on whatever the rails left over.
 *
 * ── A BAND CENTRES OR IT WRAPS. It cannot do both, and the occupants decide. ──
 *
 * True centring needs side groups that are equal regardless of content
 * (`flex-1` from a zero basis); wrapping needs groups sized by their content.
 * Those are the same property with two values, so:
 *
 *   a `center` occupant  →  sides take equal halves, nothing wraps
 *   no `center` occupant →  groups size to content and wrap when short
 *
 * Which is what the top band wanted all along: the view cluster rides beside
 * the tool options bar while there is room for it, and drops to its own line
 * when there is not — instead of the bar being squeezed to a third of the
 * stage and living scrolled. And the bottom band, where the rail docks, gets a
 * centre that the breadcrumb beside it can never shift.
 *
 * ── DIRECTION IS DERIVED, NEVER PASSED TWICE. ──
 *
 * Each group publishes its placement on a context, so a capsule reads the axis
 * it is laid out along and the side its flyouts should open toward from the ONE
 * fact that decided where it is. `placement === "left"` re-derived at four call
 * sites is how a rail ends up rendering as a column with its tooltips still
 * opening downward.
 *
 * The safe area insets by whatever is eating the edges (the rulers), so nothing
 * ever lands under the tick strip.
 */

/** Distance from the stage edge, and between two capsules sharing a group. */
const CHROME_MARGIN = 8;

/**
 * The gap between the two ROWS of one band — tighter than the stage margin,
 * deliberately.
 *
 * A band's rows are one object seen twice, not two capsules that happen to be
 * near each other, and spacing them at the stage's own margin made the tool
 * line read as two separate strips and cost the canvas a row's worth of height
 * for nothing. The margin says "this floats clear of the edge"; this says
 * "these belong together".
 */
const CHROME_ROW_GAP = 4;

export interface StageChromeInsets {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

// ── What a capsule can ask about where it is ────────────────────────────────

const PlacementContext = React.createContext<ChromePlacement>({ edge: "top", align: "start" });

/** Where am I docked? Every capsule inside a band gets a real answer. */
export function useChromePlacement(): ChromePlacement {
  return React.useContext(PlacementContext);
}

/** Do I lay out as a row or a column? Derived from the edge, never stored. */
export function useChromeAxis(): ChromeAxis {
  return axisOfEdge(useChromePlacement().edge);
}

/** Which way do my menus and tooltips open? Into the canvas. */
export function useChromeFlyoutSide(): "top" | "right" | "bottom" | "left" {
  return flyoutSide(useChromePlacement().edge);
}

/**
 * HOW TALL A SIDE COLUMN MAY BE — the one number a capsule cannot work out for
 * itself, published by the layout that owns it.
 *
 * A capsule on a vertical edge sits inside a band whose height is its own
 * content, so `100%` inside it resolves against a parent that is sizing itself
 * to the capsule: the percentage collapses, and a control that wants to ADAPT
 * to the room it has can only ever measure its own height back. That is why the
 * brush handle ended up with a hard-coded 356px and then quietly squashed its
 * faders to slivers when the stage was shorter than that — the `max-h-full`
 * clamp shrinks whatever is flexible, which is exactly the part that matters.
 *
 * The MIDDLE ROW's height is the honest answer, and it is definite: the chrome
 * root is `inset-0`, the bands above and below size to their content, and the
 * row takes what is left. It cannot oscillate, because nothing in a side column
 * can grow it — the row is `flex-1 min-h-0`, so its height is decided before
 * its occupants are laid out.
 *
 * One ResizeObserver, one number, changing only when the stage is resized or
 * the rulers come and go. A capsule reads it and decides how much of itself to
 * show (`resolveHandleLayout` is the first customer).
 */
const ChromeColumnHeight = React.createContext(0);

/** The height a capsule docked to a side edge may occupy. 0 before first paint. */
export function useChromeColumnHeight(): number {
  return React.useContext(ChromeColumnHeight);
}

function useMeasuredHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [h, setH] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => setH((prev) => (Math.abs(prev - el.clientHeight) < 1 ? prev : el.clientHeight));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

// ── The layout ──────────────────────────────────────────────────────────────

/**
 * One alignment group of one edge.
 *
 * NO overflow here, deliberately. A group that scrolls clips whatever it holds
 * — which cut the rounded corners and the cast shadow off every capsule, and
 * quietly scrolled the tool rail's first tool out of view whenever the stage
 * got short. A capsule that cannot fit scrolls ITSELF, inside its own radius,
 * where the clip is invisible.
 */
function Group({
  edge,
  align,
  children,
  gap,
}: {
  edge: ChromeEdge;
  align: ChromeAlign;
  children?: React.ReactNode;
  gap: number;
}) {
  const horizontal = axisOfEdge(edge) === "horizontal";
  const placement = React.useMemo<ChromePlacement>(() => ({ edge, align }), [edge, align]);
  // The SIDES hold an equal share whether or not they have an occupant — that
  // is the whole centring mechanism, and `empty:hidden` would undo it the
  // moment the breadcrumb went away and slide the docked rail off centre.
  //
  // The CENTRE is `0 1 auto`: it takes the size its occupant asks for and gives
  // only when the band is genuinely too short. Not `flex-1` (an equal third
  // squeezed the brush handle's faders to slivers on a stage with room to
  // spare) and not `flex-none` (which cannot give, so a short stage overflowed
  // instead). The sides flex from a ZERO basis and so contribute nothing to
  // shrinking, which means every pixel that must come off comes off the centre
  // — and its resolved size is definite, which is what lets a capsule inside
  // ask for `min(288px, 100%)` and get a real number back.
  const side = align !== "center";
  return (
    <PlacementContext.Provider value={placement}>
      <div
        data-chrome-slot={slotKey(placement)}
        style={{ gap }}
        className={cn(
          "pointer-events-none flex min-h-0 min-w-0",
          horizontal ? "flex-row flex-wrap" : "flex-col",
          align === "start" ? "justify-start" : align === "end" ? "justify-end" : "justify-center",
          crossAlign(edge),
          side ? "flex-1 basis-0" : "flex-[0_1_auto]",
          "[&>*]:pointer-events-auto",
          horizontal ? "[&>*]:min-w-0" : "[&>*]:min-h-0",
        )}
      >
        {children}
      </div>
    </PlacementContext.Provider>
  );
}

/**
 * One occupant of a band that does not centre — a plain flex item, so the band
 * wraps ITEMS rather than three group boxes.
 *
 * That distinction is the whole reason the tool line works. Wrapping GROUPS
 * meant the tool options bar and the project tabs were one box two lines tall
 * with the view cluster stuck beside the pair of them, so the tabs could never
 * share a line with the zoom readout — which is where they belong and where
 * the room already is.
 *
 * Wrapping items, the line fills and then breaks, which is the only rule that
 * is right at both ends of the range. On a wide stage the bar, the tabs and the
 * cluster sit on one line with the cluster flush right; as the stage narrows
 * they peel off in reverse order. Nothing declares a line — an earlier version
 * let the bar claim one outright, and on a desktop that bought a permanent
 * empty strip beside a 600px bar on a 1400px stage.
 *
 * `empty:hidden` per item, so an occupant that renders null leaves no gap and
 * takes nothing with it.
 */
function Item({ item, gap, onNaturalHeight }: { item: ChromeItem; gap: number; onNaturalHeight?: (h: number) => void }) {
  const horizontal = axisOfEdge(item.edge) === "horizontal";
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !onNaturalHeight || typeof ResizeObserver === "undefined") return;
    // The content's own height (scrollHeight), not the box's: a squeezed
    // neighbour still reports what it needs.
    const read = () => onNaturalHeight(el.offsetParent === null ? 0 : el.scrollHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  }, [onNaturalHeight]);
  const placement = React.useMemo<ChromePlacement>(
    () => ({ edge: item.edge, align: item.align }),
    [item.edge, item.align],
  );
  return (
    <PlacementContext.Provider value={placement}>
      <div
        ref={ref}
        data-chrome-slot={slotKey(placement)}
        data-chrome-item={item.id}
        style={{ gap }}
        className={cn(
          "pointer-events-none flex min-h-0 min-w-0 empty:hidden",
          horizontal ? "flex-row" : "flex-col",
          crossAlign(item.edge),
          // The far end is reached with an auto margin, not a spacer: it stays
          // there after a wrap, and needs no empty middle box to survive.
          item.align === "end" && (horizontal ? "ml-auto" : "mt-auto"),
          "[&>*]:pointer-events-auto",
          horizontal ? "[&>*]:min-w-0" : "[&>*]:min-h-0",
        )}
      >
        {item.node}
      </div>
    </PlacementContext.Provider>
  );
}

/**
 * Which way an occupant hugs ACROSS the band it is in: toward the stage edge it
 * is docked to. Hard-coding `items-end` for every horizontal band is what left
 * the view cluster hanging from the bottom of the tool line, half a capsule
 * below the top of the stage, whenever the armed tool's bar was taller than it.
 */
function crossAlign(edge: ChromeEdge): string {
  return edge === "top"
    ? "items-start"
    : edge === "bottom"
      ? "items-end"
      : edge === "left"
        ? "items-start"
        : "items-end";
}

/**
 * IS THE PRIMARY OCCUPANT SHOWING AT ALL?
 *
 * The top band's rule is a PRIORITY, not a fit test:
 *
 *     [ tool bar ··· scrolls ··· ] [ zoom · view ]     ← the view cluster OWNS the top-right
 *     [ tabs ]
 *
 * The view cluster never leaves the top-right corner; the armed tool's bar
 * takes whatever is left of that row and scrolls sideways when it needs more.
 * It used to be the other way round — the bar kept its full width and the
 * cluster dropped to the tabs' row whenever the bar was wide — which moved the
 * zoom every time you changed tools. A control you reach for by position must
 * not move.
 *
 * That also retired the fit MEASUREMENT (and its convergence guard): a decision
 * that changes the layout it just measured is a feedback loop, and this rule
 * no longer asks the layout anything but whether the bar rendered. That answer
 * does not depend on which row it sits in, so it cannot oscillate.
 *
 * `offsetParent` is null for a `display:none` occupant — the armed tool has no
 * bar — and then the view cluster joins the tabs on the one remaining line.
 */
function usePrimaryShown(ref: React.RefObject<HTMLElement | null>, primaryId: string | undefined): boolean {
  const [shown, setShown] = React.useState(true);
  React.useLayoutEffect(() => {
    const host = ref.current;
    if (!host || !primaryId) return;
    const primary = host.querySelector<HTMLElement>(`[data-chrome-item="${primaryId}"]`);
    const next = !!primary && primary.offsetParent !== null;
    if (next !== shown) setShown(next);
  });
  return shown;
}

/**
 * A horizontal band with a `secondLine` occupant: TWO ROWS, explicitly.
 *
 * Explicit rows rather than one wrapping line, because the two arrangements
 * above need different orders and a row you can re-fill is the honest way to
 * say that. Each row is `empty:hidden`, so a band with nothing on its first
 * line collapses to one visible line and the whole thing costs the canvas
 * nothing when the armed tool brings no bar.
 */
function SplitBand({
  edge,
  items,
  gap,
  className,
}: {
  edge: ChromeEdge;
  items: readonly ChromeItem[];
  gap: number;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const primary = items.find((i) => !i.secondLine);
  const beside = usePrimaryShown(ref, primary?.id);

  const firstRow = beside ? items.filter((i) => !i.secondLine) : primary ? [primary] : [];
  const secondRow = beside
    ? items.filter((i) => i.secondLine)
    : [...items.filter((i) => i.secondLine), ...items.filter((i) => !i.secondLine && i !== primary)];

  return (
    <div
      ref={ref}
      data-chrome-band={edge}
      className={cn("pointer-events-none flex shrink-0 min-w-0 flex-col", "[&:not(:has(>*>*>*))]:hidden", className)}
      style={{ gap: CHROME_ROW_GAP }}
    >
      {[firstRow, secondRow].map((row, i) => (
        <div
          key={i}
          className={cn(
            "pointer-events-none flex min-w-0 flex-row",
            // The first row NEVER wraps: the bar shrinks (and scrolls) so the
            // occupants after it keep their place. Only the bar may give way.
            i === 0 ? "flex-nowrap [&>*+*]:shrink-0" : "flex-wrap",
            // A ROW IS EMPTY WHEN ITS OCCUPANTS RENDERED NOTHING — not when it
            // holds no elements.
            //
            // This was `empty:hidden`, and it never once fired. A row always
            // holds its `Item` wrappers; an Item whose node renders null hides
            // ITSELF, so the row keeps a child element, is not `:empty`, and
            // stays displayed at zero height — where it still collects the
            // band's `CHROME_ROW_GAP` and the stage's own margin below it.
            //
            // That is the "extra margin above the canvas when the armed tool
            // has no bar" exactly: a phantom row nobody could see, charging
            // rent. The height of the capsules was never the problem, and
            // shrinking them (the top band spent a release in a squeezed
            // half-height variant of the shared capsule) treated the symptom
            // while the empty row went on paying for itself.
            //
            // A GRANDCHILD is the honest test: some Item rendered a real
            // element. Same predicate `Band` already uses one level up, for
            // the same reason.
            "[&:not(:has(>*>*))]:hidden",
            crossAlign(edge),
          )}
          style={{ gap }}
        >
          {row.map((item) => (
            <Item key={item.id} item={item} gap={gap} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * One edge. Renders nothing at all when no occupant produced an element —
 * `:has` rather than a flag the caller passes, because `ToolOptionsBar` renders
 * null for a tool with no options and only the browser can see that. A
 * predicate at the call site would be a second copy of `TOOL_SECTIONS`, and the
 * copy is what goes stale.
 *
 * TWO SHAPES, and the occupants choose between them, because they are the same
 * flex property with two values and pretending to offer both is how one of them
 * silently stops working:
 *
 *   a `center` occupant  →  three groups, sides equal from a zero basis, so the
 *                           centre is centred on the STAGE and nothing beside it
 *                           can shift it. Cannot wrap.
 *   no `center` occupant →  the items themselves, wrapping, each sized to its
 *                           content, `end` reached by an auto margin.
 */
function Band({
  edge,
  items,
  gap,
  className,
}: {
  edge: ChromeEdge;
  items: readonly ChromeItem[];
  gap: number;
  className?: string;
}) {
  const horizontal = axisOfEdge(edge) === "horizontal";
  const mine = items.filter((i) => i.edge === edge);
  // Read from the LIST, not by measuring: a centre occupant that renders null
  // still means "this band is the kind that centres", so a band cannot flip
  // shape as a tool is armed.
  const centred = mine.some((i) => i.align === "center");
  // A band whose occupants asked for a second line is a two-row band. Centring
  // and line-splitting are different jobs, so this is a fork in the SHAPE, not
  // a flag inside one.
  if (horizontal && mine.some((i) => i.secondLine)) {
    if (!centred) return <SplitBand edge={edge} items={mine} gap={gap} className={className} />;
    // A CENTRED band with a second line (a 3D world: Blender's header, its
    // tool settings under it). The header keeps its centring — its own band —
    // and the line under it is a band of its own, so neither can shift the
    // other. The second line sits on the canvas side of the first.
    const first = mine.filter((i) => !i.secondLine);
    const second = mine.filter((i) => i.secondLine).map((i) => ({ ...i, secondLine: false }));
    const rows = [<Band key="1" edge={edge} items={first} gap={gap} />, <Band key="2" edge={edge} items={second} gap={gap} />];
    return (
      <div data-chrome-band={edge} className={cn("pointer-events-none flex min-w-0 shrink-0 flex-col", "[&:not(:has(>*>*>*))]:hidden", className)} style={{ gap: CHROME_ROW_GAP }}>
        {edge === "bottom" ? rows.reverse() : rows}
      </div>
    );
  }
  return (
    <div
      data-chrome-band={edge}
      className={cn(
        "pointer-events-none flex min-h-0 min-w-0",
        horizontal ? "shrink-0 flex-row" : "flex-none flex-col",
        crossAlign(edge),
        !centred && horizontal && "flex-wrap",
        // Collapse when nothing rendered, so an unused edge costs the canvas
        // nothing — not even the frame's gap.
        "[&:not(:has(>*>*))]:hidden",
        className,
      )}
      style={{ gap }}
    >
      {centred
        ? CHROME_ALIGNS.map((align) => (
            <Group key={align} edge={edge} align={align} gap={gap}>
              {mine
                .filter((i) => i.align === align)
                .map((i) => (
                  <React.Fragment key={i.id}>{i.node}</React.Fragment>
                ))}
            </Group>
          ))
        : horizontal
          ? mine.map((i) => <Item key={i.id} item={i} gap={gap} />)
          : <SideItems items={mine} gap={gap} />}
    </div>
  );
}

/**
 * THE OCCUPANTS OF A SIDE EDGE, each told the room the OTHERS leave it.
 *
 * `useChromeColumnHeight` used to be the whole column, which is the room only
 * when a capsule is alone on its edge. The brush handle sizes itself to that
 * number, and in a 3D world it shares the right edge with the navigation
 * column — so it laid out for the full height and sat on top of the nav
 * buttons. Room is now per occupant: the column, less the NATURAL heights of
 * the others (their content's, so a neighbour that is squeezed does not hand
 * the room back and start a loop), less the gaps between them.
 */
function SideItems({ items, gap }: { items: readonly ChromeItem[]; gap: number }) {
  const column = useChromeColumnHeight();
  const [heights, setHeights] = React.useState<Record<string, number>>({});
  const report = React.useCallback((id: string, h: number) => setHeights((prev) => (Math.abs((prev[id] ?? 0) - h) < 1 ? prev : { ...prev, [id]: h })), []);
  return (
    <>
      {items.map((i) => {
        const others = items.filter((o) => o.id !== i.id && (heights[o.id] ?? 0) > 0);
        const room = Math.max(0, column - others.reduce((n, o) => n + heights[o.id]! + gap, 0));
        return (
          <ChromeColumnHeight.Provider key={i.id} value={room}>
            <Item item={i} gap={gap} onNaturalHeight={(h) => report(i.id, h)} />
          </ChromeColumnHeight.Provider>
        );
      })}
    </>
  );
}

/**
 * One thing floating on the stage. A LIST of these, not a map of slot → node:
 * two capsules genuinely can share a placement (the project tabs and the tool
 * rail both hang from the top-left when the rail is docked there), and a map
 * makes that the one arrangement you cannot express — you get a ternary at the
 * call site that composes fragments and skips the key, which is a layout rule
 * written in the wrong file. A list also gives every capsule a stable id, so
 * moving one is editing a row rather than rewriting an object.
 */
export interface ChromeItem extends ChromePlacement {
  id: string;
  node: React.ReactNode;
  /**
   * Never share a line with the band's PRIMARY occupant — take the line below
   * it. The project tabs ask: the armed tool's bar changes with every tool
   * while the tabs do not, and a 600px brush section beside a tab strip leaves
   * both of them scrolled.
   *
   * This is what makes a horizontal band a two-row band. See `SplitBand`.
   */
  secondLine?: boolean;
}

export function StageChrome({
  insets,
  items,
}: {
  insets?: StageChromeInsets;
  /** Everything floating on the stage, in the order it should stack per slot. */
  items: readonly ChromeItem[];
}) {
  const pad = CHROME_MARGIN;
  const middle = React.useRef<HTMLDivElement>(null);
  const columnHeight = useMeasuredHeight(middle);
  return (
    <div
      className="pointer-events-none absolute inset-0 z-40 flex flex-col"
      style={{
        paddingTop: pad + (insets?.top ?? 0),
        paddingRight: pad + (insets?.right ?? 0),
        paddingBottom: pad + (insets?.bottom ?? 0),
        paddingLeft: pad + (insets?.left ?? 0),
        gap: pad,
      }}
    >
      <Band edge="top" items={items} gap={pad} />

      {/* THE MIDDLE ROW — the only place the side columns exist, so they can
          only ever take width from the canvas. `min-h-0` so a full-height
          column (the brush handle's) has something definite to be a
          percentage of. */}
      <div ref={middle} className="flex min-h-0 min-w-0 flex-1" style={{ gap: pad }}>
        <ChromeColumnHeight.Provider value={columnHeight}>
          <Band edge="left" items={items} gap={pad} className="max-h-full" />
          {/* The canvas shows through here, and it is the only thing that gives. */}
          <div className="min-h-0 min-w-0 flex-1" />
          <Band edge="right" items={items} gap={pad} className="max-h-full" />
        </ChromeColumnHeight.Provider>
      </div>

      <Band edge="bottom" items={items} gap={pad} />
    </div>
  );
}

/**
 * The shared look of a floating stage capsule. The tool rail, the breadcrumb,
 * the zoom cluster and the tool-options bar are all THIS object, so the canvas
 * reads as one family instead of four near-misses — three different radii, two
 * blurs and a stray border was most of why it looked noisy.
 */
export const CHROME_CAPSULE = [
  // ONE PADDING, one gap, one radius — for the rail, the breadcrumb, the view
  // cluster, the tool options bar and the project tabs alike.
  //
  // There used to be a second, half-padded variant for the top band, added to
  // stop that band looking tall. It was the wrong lever: the height came from
  // a phantom row in `SplitBand` (see above), and shrinking the capsules to
  // compensate left every control in the top band pressed against its own
  // edges while the rail below kept room to breathe. Two weights of one object
  // is also exactly the drift this constant exists to prevent.
  "flex items-center gap-1 rounded-xl p-1",
  // The shared liquid-glass material — same object as every popover, menu and
  // floating window, so the canvas chrome belongs to the app rather than being
  // a lookalike maintained separately. Near-solid on purpose: at 75% alpha it
  // sat over a white artboard and turned mid-grey, and the whole rail read as
  // disabled. The blur gives depth; it no longer carries the surface colour.
  "material-glass",
  // The capsule itself never scrolls and never clips — that is what cost it its
  // rounded corners and its shadow. It only agrees to be SHORTER than its
  // content (`min-h-0`) so a scroller placed inside it can engage.
  "min-h-0 min-w-0 max-h-full max-w-full",
].join(" ");
