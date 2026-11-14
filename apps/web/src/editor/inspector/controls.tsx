"use client";

import * as React from "react";
import { ChevronRight, Clipboard, Copy, Scissors, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { isTypingTarget } from "../input/typing-target";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PartLabel } from "@/components/ui/part-label";
import { toast } from "@/lib/toast";
import { copyProperties, pastePropertiesDomain } from "../state/clip-actions";
import { useDocStore } from "../state/document-context";
import { PropertyBindingMenu } from "./property-binding";
import type { KeyTarget } from "./keyframe-menu-items";
import { useInspectorNav, useSectionPrefs } from "../state/inspector-nav";
import type { Clip, KeyframeValue } from "@solomotion/core";

/**
 * The inspector layout kit. Every panel in the right sidebar composes from these
 * five primitives and nothing else, which is the whole point: the old sidebar
 * looked improvised because each section invented its own widths (`w-16`, `w-20`,
 * `flex-1`, ad-hoc grids outside a row), so no two fields lined up.
 *
 * The contract:
 *   • ONE control height — 28px (`h-7`). No section overrides it.
 *   • ONE row grid — 56px label · fluid control · 20px keyframe gutter. A control
 *     never sets its own width; it fills the middle column and `Pair`/`Trio`
 *     subdivide it, so an X/Y pair in Transform is pixel-identical to an X/Y pair
 *     in Crop.
 *   • Trailing toggles (link, pivot, …) live in `Inline`'s fixed 20px slot, so
 *     adding one doesn't silently shrink the field next to it.
 *   • Words are expensive. Labels are one or two, everything else is a tooltip.
 */

// ── Section ──────────────────────────────────────────────────────────────────

export function PanelSection({
  id,
  title,
  children,
  actions,
  collapsible = true,
  defaultOpen = true,
  forceOpen,
  transfer,
  /** Right-aligned micro-count in the header (effects, colours, …). */
  count,
  /**
   * The COLLAPSED summary — shown in the header only while shut, hidden when
   * open because the body says it better. Same contract (and same word) as
   * `AccordionItem`'s `meta`, so a closed section can still answer the question
   * you would have opened it to ask: which colours are in here, is the shutter
   * on, how many strokes.
   */
  summary,
  /** Tooltip on the section title. This is where explanatory prose goes — the
   * panel used to carry paragraphs of it inline, which is a lot of ink for
   * something you read once. */
  hint,
  /** Drops the outer hairline + padding — for a section that IS the tab body. */
  flush,
}: {
  /**
   * Stable section id. Giving one turns the section into two things at once:
   *
   *  • a MEMORY cell — its open state survives the session, so `defaultOpen`
   *    is only the answer until the person disagrees with it once;
   *  • an ANCHOR — `revealInInspector({ section: id })` scrolls it into view
   *    and pops it open, which is why adding a navigable destination is
   *    giving a section a name rather than registering it anywhere.
   *
   * Optional: a one-off section with nothing to remember and nowhere to be
   * linked from needs neither.
   */
  id?: string;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Pops the section open whenever this changes to a truthy value (focus requests). */
  forceOpen?: unknown;
  /**
   * Wires the section to the property-transfer brain: right-click offers
   * "Copy <title>" / "Paste <title>" scoped to exactly these domains.
   */
  transfer?: { domains: string[]; clipId: string };
  count?: number;
  summary?: React.ReactNode;
  hint?: string;
  flush?: boolean;
}) {
  const stored = useSectionPrefs((s) => (id ? s.open[id] : undefined));
  const [local, setLocal] = React.useState(defaultOpen);
  const open = id ? (stored ?? defaultOpen) : local;
  const setOpen = (next: boolean) => {
    if (id) useSectionPrefs.getState().setOpen(id, next);
    else setLocal(next);
  };

  React.useEffect(() => {
    if (forceOpen) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceOpen]);

  // The anchor half: a reveal aimed at this id opens it, brings it on screen
  // and flashes the header once, so a gesture three panels away lands on the
  // exact row it meant instead of merely the right tab.
  const ref = React.useRef<HTMLElement | null>(null);
  const reveal = useInspectorNav((s) => s.reveal);
  const [flash, setFlash] = React.useState(false);
  React.useEffect(() => {
    if (!id || reveal.section !== id) return;
    setOpen(true);
    setFlash(true);
    const raf = requestAnimationFrame(() =>
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
    const t = setTimeout(() => setFlash(false), 900);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal.seq, id]);

  if (flush) {
    return <div className="px-3 pb-3 pt-2">{children}</div>;
  }

  const body = (
    <section
      ref={ref}
      data-section={id}
      // A section is a HEADING + SPACE (v5 redesign, D6), not a box: the
      // hairline under every section made the inspector a stack of cards.
      className={cn("pb-2 transition-colors duration-500", flash && "bg-selection")}
    >
      <div
        role={collapsible ? "button" : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? open : undefined}
        className={cn(
          "group/sec flex h-(--control-h-lg) items-center gap-1 pl-3 pr-1.5 outline-none",
          collapsible && "cursor-pointer select-none",
        )}
        onClick={() => collapsible && setOpen(!open)}
        onKeyDown={(e) => {
          if (!collapsible) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(!open);
          }
        }}
      >
        {hint ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <PartLabel text={title} className="truncate text-label text-fg decoration-dotted underline-offset-2 hover:underline" />
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-56">
              {hint}
            </TooltipContent>
          </Tooltip>
        ) : (
          <PartLabel text={title} className="truncate text-label text-fg" />
        )}
        {count !== undefined && count > 0 && (
          <span className="text-meta tabular-nums text-fg-faint">{count}</span>
        )}
        {/* The fold affordance trails the title and stays quiet until you reach
            for the header — a column of chevrons down the left edge was the
            loudest thing in the panel. A folded section always shows it. */}
        {collapsible && (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-fg-faint transition-[transform,opacity] duration-150",
              open ? "rotate-90 opacity-0 group-hover/sec:opacity-100" : "opacity-100",
            )}
          />
        )}
        <div className="flex-1" />
        {!open && summary !== undefined && (
          <div className="flex min-w-0 shrink items-center overflow-hidden">{summary}</div>
        )}
        {/* Stop clicks on actions (buttons, switches) from bubbling to the header toggle. */}
        <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      </div>
      {open && <div className="grid gap-1 px-3 pb-2">{children}</div>}
    </section>
  );
  if (!transfer) return body;
  return <SectionTransferMenu transfer={transfer} title={title} body={body} />;
}

/**
 * Right-click copy/paste for ONE property domain — the section-scoped door
 * into the property-transfer brain. Paste applies only what matches this
 * section, whatever the clipboard holds (a capture or a whole copied layer).
 */
function SectionTransferMenu({
  transfer,
  title,
  body,
}: {
  transfer: { domains: string[]; clipId: string };
  title: string;
  body: React.ReactElement;
}) {
  const store = useDocStore();
  const run = (fn: "copy" | "paste") => {
    if (fn === "copy") {
      void copyProperties(
        store,
        transfer.clipId,
        Object.fromEntries(transfer.domains.map((d) => [d, true as const])),
      ).then((labels) => labels && toast(`Copied ${labels.join(", ").toLowerCase()}`));
    } else {
      void pastePropertiesDomain(store, transfer.clipId, transfer.domains).then((what) =>
        toast(what ? `Pasted ${what}` : "Nothing matching on the clipboard"),
      );
    }
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{body}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={() => run("copy")}>
          <Copy /> Copy {title.toLowerCase()}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => run("paste")}>
          <Clipboard /> Paste {title.toLowerCase()}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The ADVANCED disclosure — the expert half of a section, folded away.
 *
 * It replaces a bare "More" / "Less" text link, which read as a placeholder
 * because it was one: no affordance, no indication of direction, and a word
 * that says nothing about what is behind it. This is a hairline that the label
 * sits inside, which is the pro-tool convention (and reads as a SEAM in the
 * section rather than as another control competing with the fields above it).
 *
 * `count` puts the number of hidden fields on the chip, so the fold advertises
 * its own weight instead of making you open it to find out.
 */
export function Disclosure({
  open,
  onToggle,
  label = "Advanced",
  count,
}: {
  open: boolean;
  onToggle: () => void;
  label?: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      // A quiet text row, not a pill between two rules: "more" is tier 3,
      // and it should read as such.
      className={cn(
        "flex h-(--control-h-sm) w-fit items-center gap-1 rounded-sm pr-1.5 text-meta transition-colors",
        open ? "text-fg" : "text-fg-muted hover:text-fg",
      )}
    >
      <ChevronRight className={cn("size-3 transition-transform duration-150", open && "rotate-90")} />
      {open ? "Less" : label}
      {!open && count !== undefined && count > 0 && <span className="tabular-nums text-fg-faint">{count}</span>}
    </button>
  );
}

// ── Accordion ────────────────────────────────────────────────────────────────

/**
 * The exclusive accordion — ONE open item, the rest collapsed to their headers.
 *
 * The Animate tab is why this exists. It rendered four independent
 * `PanelSection`s, each defaulting open, each carrying a preview stage, a row
 * of sliders and an easing graph: a very long scroll in which only one of the
 * four was ever the thing being edited. Sections that each own their open state
 * cannot express "this one, not the others" — so the state moves up here, and
 * the closed headers become the tab's table of contents, each carrying enough
 * summary (`meta`) to answer "does this layer animate in?" without opening it.
 *
 * Toggling the open item shut is allowed: all-collapsed is the overview, and
 * it is the only way to see four summaries at once.
 */
const AccordionCtx = React.createContext<{
  open: string | null;
  setOpen: (id: string | null) => void;
  /** Items announce themselves so a reveal aimed elsewhere doesn't collapse us. */
  register: (id: string) => () => void;
} | null>(null);

export function Accordion({
  defaultOpen = null,
  children,
}: {
  /** Which item starts open. Remount (via `key`) to re-seed it. */
  defaultOpen?: string | null;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState<string | null>(defaultOpen);
  // An accordion item is an ANCHOR too: the animation badge on a clip edge asks
  // for `layer-in`, and lands with that editor open rather than on a tab where
  // it is one more click away. Same id space as `PanelSection`, so a caller
  // never has to know which of the two its destination happens to be.
  const ids = React.useRef(new Set<string>());
  const register = React.useCallback((id: string) => {
    ids.current.add(id);
    return () => void ids.current.delete(id);
  }, []);
  const reveal = useInspectorNav((s) => s.reveal);
  React.useEffect(() => {
    // Only OURS: a reveal naming a section this accordion doesn't hold must
    // leave it exactly as it was, not collapse every item to satisfy a request
    // meant for a panel three sections down.
    if (reveal.section && ids.current.has(reveal.section)) setOpen(reveal.section);
  }, [reveal.seq, reveal.section]);
  const ctx = React.useMemo(() => ({ open, setOpen, register }), [open, register]);
  return (
    <AccordionCtx.Provider value={ctx}>
      <div className="grid gap-1 p-2">{children}</div>
    </AccordionCtx.Provider>
  );
}

/**
 * What an accordion item's HEADER can move around: the thing the section
 * holds, as one unit. An animation edge, a text phase, a transition — any
 * section whose content is one setting you would want to copy to another
 * section of the same shape. The header gets a right-click menu and, while it
 * has focus, ⌘C / ⌘X / ⌘V / ⌫ — so "select the In section, copy, select the
 * Out section, paste" is the gesture it reads as. Each verb is optional; an
 * empty section offers only Paste.
 */
export interface AccordionClipboard {
  /** The noun in the menu: "animation", "transition". */
  noun: string;
  /** Present when there is something to copy. */
  copy?: () => void;
  paste: () => void;
  /** Present when there is something to clear. Cut is copy then clear. */
  clear?: () => void;
}

export function AccordionItem({
  id,
  title,
  icon,
  meta,
  clipboard,
  children,
}: {
  id: string;
  title: string;
  /** A 12px glyph. Carries the accent when open — never a filled slab. */
  icon?: React.ReactNode;
  /** The collapsed summary. Hidden while open, where the body says it better. */
  meta?: React.ReactNode;
  /** Copy / cut / paste / clear the section's one setting from its header. */
  clipboard?: AccordionClipboard;
  children: React.ReactNode;
}) {
  const ctx = React.useContext(AccordionCtx);
  const open = ctx?.open === id;
  const register = ctx?.register;
  React.useEffect(() => register?.(id), [register, id]);

  const cut = clipboard?.copy && clipboard.clear ? () => { clipboard.copy!(); clipboard.clear!(); } : undefined;
  const onKeyDown = clipboard
    ? (e: React.KeyboardEvent) => {
        // Only when the HEADER itself is focused — a ⌘C inside a field in the
        // body is the field's.
        if (e.target !== e.currentTarget || isTypingTarget(e.target)) return;
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key === "c" && clipboard.copy) clipboard.copy();
        else if (mod && e.key === "x" && cut) cut();
        else if (mod && e.key === "v") clipboard.paste();
        else if ((e.key === "Backspace" || e.key === "Delete") && clipboard.clear) clipboard.clear();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }
    : undefined;

  const header = (
      <button
        type="button"
        aria-expanded={open}
        onClick={() => ctx?.setOpen(open ? null : id)}
        onKeyDown={onKeyDown}
        className={cn(
          "flex h-(--control-h-lg) w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left outline-none transition-colors",
          open ? "material-glass-raised" : "hover:bg-hover",
        )}
      >
        {icon && (
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5",
              open ? "text-primary" : "text-fg-muted",
            )}
          >
            {icon}
          </span>
        )}
        <span className={cn("truncate text-body", open ? "font-medium text-fg" : "text-fg")}>
          {title}
        </span>
        <div className="ml-auto flex min-w-0 shrink items-center gap-1.5">
          {!open && meta}
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-fg-faint transition-transform duration-150",
              open && "rotate-90",
            )}
          />
        </div>
      </button>
  );

  return (
    <div className={cn("min-w-0 overflow-hidden rounded-lg", open && "bg-hover")}>
      {clipboard ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            {clipboard.copy && (
              <ContextMenuItem onClick={clipboard.copy}>
                <Copy /> Copy {clipboard.noun}
              </ContextMenuItem>
            )}
            {cut && (
              <ContextMenuItem onClick={cut}>
                <Scissors /> Cut {clipboard.noun}
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={clipboard.paste}>
              <Clipboard /> Paste {clipboard.noun}
            </ContextMenuItem>
            {clipboard.clear && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={clipboard.clear} className="text-destructive focus:text-destructive">
                  <Trash2 /> Clear
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        header
      )}
      {open && <div className="grid min-w-0 gap-1.5 px-2 pb-2 pt-1.5">{children}</div>}
    </div>
  );
}

/**
 * The ONE collapsed summary chip — a preset's name, a sound's name, a count.
 * `muted` is the "nothing here" case, which must not read as loud as a real
 * value or an empty edge draws the eye first.
 */
export function AccordionMeta({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  if (muted) return <span className="truncate text-meta text-fg-faint">{children}</span>;
  return (
    <span className="max-w-28 truncate rounded-sm px-1.5 text-meta material-chip">{children}</span>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────

/**
 * Label · control · keyframe gutter. The gutter is a FIXED 20px — it used to be
 * 52px because the ‹◆› cluster rendered its jump arrows inline on every row,
 * which stole a third of the panel's width from the actual fields. The arrows
 * moved into the diamond's right-click menu (see keyframe-controls).
 *
 * `group/row` scopes the hover reveal of quiet chrome inside the row.
 */
/**
 * The binding target a row already declares, read off the keyframe control it
 * passes. Every animatable row in the app hands `PropRow` a `KeyControl` (or a
 * `MultiKeyControl`) carrying the clip and the property PATH — the exact two
 * things a binding needs. Reading them here is what makes "right-click any field
 * to make it dynamic" true across all twenty inspectors without a single one of
 * them being edited, and it can never drift: a row that gains a keyframe diamond
 * gains binding in the same stroke, because they are the same fact.
 *
 * Duck-typed on purpose — importing `KeyControl` here would close an import loop
 * (it reaches back into this module for the row layout), and the shape is owned
 * by the same folder.
 */
export interface BindingTarget {
  path: string;
  currentValue: () => KeyframeValue;
}

function bindingTargetsOf(
  keyControl: React.ReactNode,
): { clip: Clip; targets: BindingTarget[] } | null {
  if (!React.isValidElement(keyControl)) return null;
  const props = keyControl.props as {
    clip?: Clip;
    property?: string;
    currentValue?: () => KeyframeValue;
    properties?: Array<{ property: string; currentValue: () => KeyframeValue }>;
  };
  if (!props.clip) return null;
  if (typeof props.property === "string" && props.currentValue) {
    return { clip: props.clip, targets: [{ path: props.property, currentValue: props.currentValue }] };
  }
  // `MultiKeyControl` names the path `property`; the binding side calls it
  // `path`. Translated once, here, rather than everywhere it is read.
  return props.properties?.length
    ? {
        clip: props.clip,
        targets: props.properties.map((p) => ({ path: p.property, currentValue: p.currentValue })),
      }
    : null;
}

/**
 * A multi-input row's targets, handed DOWN to the layout primitive that lays the
 * inputs out. A `Pair` holding Position's X and Y is two fields on one row, so
 * one menu across the pair would have to guess which half you meant. The pair
 * itself knows: its children and this list are in the same order, by
 * construction, because both come from the same declaration. Each input gets its
 * own menu bound to its own path.
 */
const RowBinding = React.createContext<{ clip: Clip; targets: BindingTarget[]; label: string } | null>(null);

/** Give each of `count` side-by-side controls its own binding menu, or leave
 *  them alone when the row's shape and its property list disagree. */
function useSplitBinding(children: React.ReactNode): React.ReactNode | null {
  const row = React.useContext(RowBinding);
  const kids = React.Children.toArray(children);
  if (!row || row.targets.length !== kids.length) return null;
  return kids.map((child, i) => {
    const target = row.targets[i]!;
    return (
      // Cleared inside, so a nested arrangement can't wrap the same input twice.
      <RowBinding.Provider key={i} value={null}>
        <PropertyBindingMenu
          clip={row.clip}
          path={target.path}
          kind={bindingKind(target.currentValue())}
          label={`${row.label} · ${target.path}`}
          literal={target.currentValue() as string | number}
          keyTargets={keyTargetsOf([target])}
        >
          <div className="min-w-0">{child}</div>
        </PropertyBindingMenu>
      </RowBinding.Provider>
    );
  });
}

/**
 * The row's binding targets, in the keyframe menu's vocabulary.
 *
 * The two lists are the same fact under two names — `path` on the binding side,
 * `property` on the keyframe side — and this is the ONE place the translation
 * happens, the same way `bindingTargetsOf` already translates the other
 * direction for `MultiKeyControl`. A ganged row keys both halves together,
 * which is what its diamond does, so the field's menu and the diamond's menu
 * act on exactly the same tracks.
 */
function keyTargetsOf(targets: BindingTarget[]): KeyTarget[] {
  return targets.map((t) => ({ property: t.path, currentValue: t.currentValue }));
}

/** Which family of variable a value belongs to — a string that parses as a
 *  colour IS a colour, the same rule the expression language uses. */
function bindingKind(value: KeyframeValue): "number" | "color" | "string" {
  if (typeof value === "number") return "number";
  return typeof value === "string" && /^#([0-9a-fA-F]{3,8})$/.test(value.trim()) ? "color" : "string";
}

export function PropRow({
  label,
  children,
  keyControl,
  /** Hides the label column entirely — for a full-bleed control under a row. */
  wide,
  /** Top-aligns the label against a multi-row control (a paint stack, a list). */
  start,
  hint,
  toggle,
}: {
  label?: string;
  children: React.ReactNode;
  keyControl?: React.ReactNode;
  wide?: boolean;
  start?: boolean;
  /**
   * The control is a SWITCH — so the label, not the control, wants the room.
   *
   * The 56px label column exists so every value field in a panel starts at the
   * same x, which is what gives Typography and Transform their vertical
   * rhythm. A toggle has no value field to line up with: it is 28px of control
   * against a column sized for numbers, so the only thing 56px achieves is
   * clipping "Clip content" to "Clip cont…" beside a quarter-inch of switch
   * and three inches of nothing. This opts the row out of the grid it gains
   * nothing from, and no row that IS in that grid moves.
   */
  toggle?: boolean;
  /** Tooltip on the label. Prefer this over a paragraph of explanation. */
  hint?: string;
}) {
  const labelNode = hint ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <PartLabel
          text={label ?? ""}
          className={cn(
            "w-fit max-w-full cursor-help text-body text-fg-muted decoration-dotted underline-offset-2 hover:underline",
            toggle ? "whitespace-nowrap" : "truncate",
          )}
        />
      </TooltipTrigger>
      <TooltipContent side="left">{hint}</TooltipContent>
    </Tooltip>
  ) : (
    <PartLabel
      text={label ?? ""}
      className={cn(
        "text-body text-fg-muted",
        toggle ? "whitespace-nowrap" : "truncate",
        start && "flex h-(--control-h) items-center",
      )}
    />
  );

  // Right-click the CONTROL for the full binding vocabulary. Mounted once, here,
  // so it reaches every animatable row in every inspector at the same moment.
  const row = bindingTargetsOf(keyControl);
  const only = row?.targets.length === 1 ? row.targets[0] : undefined;
  const control =
    row && only ? (
      <PropertyBindingMenu
        clip={row.clip}
        path={only.path}
        kind={bindingKind(only.currentValue())}
        label={label ?? only.path}
        literal={only.currentValue() as string | number}
        keyTargets={keyTargetsOf(row.targets)}
      >
        <div className="min-w-0">{children}</div>
      </PropertyBindingMenu>
    ) : row ? (
      // Several inputs on one row — the arrangement below binds them one by one.
      <RowBinding.Provider value={{ clip: row.clip, targets: row.targets, label: label ?? "" }}>
        <div className="min-w-0">{children}</div>
      </RowBinding.Provider>
    ) : (
      <div className="min-w-0">{children}</div>
    );

  return (
    <div
      className={cn(
        "group/row grid min-w-0 gap-x-1.5",
        start ? "items-start" : "items-center",
        wide
          ? "grid-cols-[minmax(0,1fr)_20px]"
          : toggle
            ? "grid-cols-[auto_minmax(0,1fr)_20px]"
            : // The label column is a theme metric: CAPS and --var labels run
              // wider than sentence case, and truncating them is the failure.
              "grid-cols-[var(--label-col,3.5rem)_minmax(0,1fr)_20px]",
      )}
    >
      {!wide && labelNode}
      {control}
      <div className={cn("flex w-5 shrink-0 justify-end", start && "h-(--control-h) items-center")}>
        {keyControl ?? null}
      </div>
    </div>
  );
}

// ── Field arrangements ───────────────────────────────────────────────────────

/** Two controls of exactly equal width (X/Y, W/H …). */
export function Pair({ children, link }: { children: React.ReactNode; link?: React.ReactNode }) {
  const split = useSplitBinding(children);
  const content = split ?? children;
  if (!link) return <div className="grid grid-cols-2 gap-1.5">{content}</div>;
  /*
   * A TIE BELONGS BETWEEN THE TWO THINGS IT TIES.
   *
   * The chain used to sit in `Inline`'s trailing slot, off to the right of the
   * pair — which reads as a third control in the row rather than as a statement
   * about X and Y, and made Scale's fields 26px narrower than the Position
   * fields directly above them. Between them it is unmistakable (it is the
   * Photoshop / Illustrator / Figma bracket, drawn the short way), and the row
   * regains the same outer width as every other pair, so the panel's vertical
   * rhythm finally holds through Transform.
   *
   * The frame Size row had already hand-rolled exactly this; it now uses this.
   */
  const kids = React.Children.toArray(content);
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
      <div className="min-w-0">{kids[0]}</div>
      {link}
      <div className="min-w-0">{kids[1]}</div>
    </div>
  );
}

/**
 * ONE control occupying the LEFT half of the pair grid. A lone number stretched
 * across the whole column (a rotation, a feather) reads as a different kind of
 * field than the X of the row above it, even though it isn't — so single values
 * take the same cell an X would, and the panel gets one hard vertical rhythm.
 */
export function Half({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Three controls of exactly equal width. */
export function Trio({ children }: { children: React.ReactNode }) {
  const split = useSplitBinding(children);
  return <div className="grid grid-cols-3 gap-1.5">{split ?? children}</div>;
}

/**
 * A control (or `Pair`) with a fixed 20px trailing slot for its toggle. The slot
 * exists whether or not it's filled, so a row with a link button and a row
 * without one keep the same field width — the single biggest reason the old
 * panel looked ragged.
 */
export function Inline({
  children,
  trailing,
}: {
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="min-w-0 flex-1">{children}</div>
      <div className="flex size-5 shrink-0 items-center justify-center">{trailing}</div>
    </div>
  );
}

/**
 * The ONE inline note. Every panel that needed to say something used to invent
 * its own `<p className="px-0.5 text-[10px] text-[#FBBF24]">`, so status text
 * came in five sizes and three hard-coded colours. Explanations belong in a
 * `hint` tooltip; this is for state you must SEE — a shaky track, a stale
 * solve, an empty stack.
 */
export function Note({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "warn" | "good";
}) {
  return (
    <p
      className={cn(
        "px-0.5 text-meta",
        tone === "warn" ? "text-warning" : tone === "good" ? "text-success" : "text-fg-muted",
      )}
    >
      {children}
    </p>
  );
}

// ── Buttons ──────────────────────────────────────────────────────────────────

/**
 * THE inline toggle — link aspect, edit-pivot, independent corners, everything.
 * 20px, tooltip-labelled, `aria-pressed`. One shape so a toggle always reads as
 * a toggle wherever it turns up.
 */
export function IconToggle({
  label,
  pressed,
  onClick,
  children,
  className,
}: {
  label: string;
  pressed?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-sm transition-colors [&_svg]:size-3.5",
            pressed ? "bg-selection text-selection-fg" : "text-fg-faint hover:bg-hover hover:text-fg",
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A 28px icon action sitting in the control column (crop-on-canvas, reset, …) —
 * same height as every field, so it lines up with the box it belongs to.
 */
export function IconAction({
  label,
  active,
  onClick,
  children,
  className,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            "flex size-(--control-h) shrink-0 items-center justify-center rounded-md border border-transparent transition-colors [&_svg]:size-3.5",
            active ? "bg-selection text-selection-fg" : "bg-input text-fg-muted hover:border-line hover:text-fg",
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

/** A word inside a segmented track — for the few choices an icon would riddle. */
export function Seg({ children }: { children: React.ReactNode }) {
  return <span className="truncate px-1 text-body">{children}</span>;
}

/**
 * A track of icon buttons that behave as one control — align/distribute, scope
 * pickers, side selectors. `items` are tooltip-labelled; the track fills the
 * control column so it matches the fields above and below it.
 */
export function IconTrack<T extends string>({
  items,
  value,
  onPick,
  dividerAfter,
}: {
  items: ReadonlyArray<{ id: T; label: string; icon: React.ReactNode }>;
  /**
   * Which items read as ON. A single id is a segmented control — one of these,
   * mutually exclusive (case, alignment). An ARRAY is a set of independent
   * toggles that happen to share a track.
   *
   * Both shapes exist because both facts exist. Bold and italic are two
   * booleans; forcing them through one value meant bold-and-italic could only
   * light one of them, so the panel told you italic was off while the text on
   * stage was plainly italic. A control whose state cannot represent the model
   * will misreport it, and no amount of care at the call site fixes that.
   */
  value?: T | readonly T[];
  onPick: (id: T) => void;
  /** Draw a hairline after these ids — groups actions inside one track. */
  dividerAfter?: ReadonlyArray<T>;
}) {
  const isOn = (id: T) =>
    value === undefined ? undefined : Array.isArray(value) ? value.includes(id) : value === id;
  // A set of toggles is not a radio group, and assistive tech has to be told so.
  const multi = Array.isArray(value);

  return (
    <div className="track flex h-(--control-h) items-center gap-px bg-input" role={multi ? "group" : undefined}>
      {items.map((it) => (
        <React.Fragment key={it.id}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={it.label}
                aria-pressed={isOn(it.id)}
                onClick={() => onPick(it.id)}
                className={cn(
                  "flex h-full flex-1 items-center justify-center transition-colors [&_svg]:size-3.5",
                  isOn(it.id) ? "material-glass-raised text-primary" : "text-fg-muted hover:bg-hover hover:text-fg",
                )}
              >
                {it.icon}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{it.label}</TooltipContent>
          </Tooltip>
          {dividerAfter?.includes(it.id) && <div className="mx-0.5 h-4 w-px bg-line" />}
        </React.Fragment>
      ))}
    </div>
  );
}
