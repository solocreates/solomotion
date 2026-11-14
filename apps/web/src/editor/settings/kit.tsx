"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * THE SETTINGS KIT — one row, one section, one search (v5 redesign, D14).
 *
 * A row is a label on the left and its control on the right, 32px of rhythm,
 * and a `?` when there is something worth saying. Never a grey paragraph.
 *
 * SEARCH FILTERS ROWS, ACROSS PAGES. While the field has text the dialog
 * renders every page at once; each row compares its own label (and keywords)
 * to the query and renders nothing on a miss, and a section or page left with
 * no rows hides itself through CSS `:has()` — so the index can never drift
 * from the rows, because the rows ARE the index. Clicking a result jumps to
 * its page and flashes the row.
 */

export interface SettingsNav {
  query: string;
  /** The page being rendered (set by `SettingsPage`). */
  page: string;
  /** Row to scroll to and flash, as `page/label`. */
  highlight: string | null;
  jump: (page: string, label: string) => void;
}

export const SettingsNavContext = React.createContext<SettingsNav>({
  query: "",
  page: "",
  highlight: null,
  jump: () => {},
});

export function matchesQuery(query: string, ...texts: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return texts.some((t) => t?.toLowerCase().includes(q));
}

/** One page's rows. Hides itself while searching when none of its rows match. */
export function SettingsPage({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  const nav = React.useContext(SettingsNavContext);
  const searching = nav.query.trim() !== "";
  return (
    <SettingsNavContext.Provider value={{ ...nav, page: id }}>
      <div className={cn("flex flex-col gap-6", searching && "[&:not(:has([data-setting-row]))]:hidden")}>
        {searching && <h3 className="text-label text-fg-muted">{title}</h3>}
        {children}
      </div>
    </SettingsNavContext.Provider>
  );
}

/** A heading and space — no box, no dividers (D6). */
export function Section({ title, children, aside }: { title?: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="flex flex-col [&:not(:has([data-setting-row]))]:hidden">
      {title && (
        <div className="flex h-(--control-h) items-center justify-between">
          <h4 className="text-title text-fg">{title}</h4>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Hint({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`About ${label}`}
          className="flex size-4 shrink-0 items-center justify-center rounded-full text-meta text-fg-faint transition-colors hover:bg-hover hover:text-fg"
        >
          ?
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{children}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Label left, control right. `keywords` are extra words search should find it
 * by ("zoom" for UI scale). `wide` gives the control the full row below the
 * label (preset pickers, the keymap cards).
 */
export function Row({
  label,
  hint,
  keywords,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  keywords?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const nav = React.useContext(SettingsNavContext);
  const ref = React.useRef<HTMLDivElement>(null);
  const key = `${nav.page}/${label}`;
  const flashing = nav.highlight === key;
  React.useEffect(() => {
    if (flashing) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [flashing]);
  const searching = nav.query.trim() !== "";
  if (!matchesQuery(nav.query, label, keywords, hint)) return null;

  return (
    <div
      ref={ref}
      data-setting-row=""
      data-setting-key={key}
      onClick={searching ? () => nav.jump(nav.page, label) : undefined}
      className={cn(
        "-mx-2 flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md px-2 py-1 transition-colors duration-700",
        wide && "flex-col items-stretch py-2",
        flashing && "bg-selection duration-150",
        searching && "cursor-pointer hover:bg-hover",
      )}
    >
      <div className={cn("flex min-w-0 items-center gap-1", wide ? "flex-none" : "flex-[1_1_8rem]")}>
        <span className="truncate text-body text-fg">{label}</span>
        {hint && <Hint label={label}>{hint}</Hint>}
      </div>
      {/* While searching, a result is a link to its row, not a live control. */}
      <div
        className={cn(
          "flex min-w-0 items-center",
          // Compact: the control takes what's left of the line (at least 9rem),
          // right-aligned, and wraps under the label only when it must.
          wide ? "w-full" : "min-w-36 flex-[1_0_auto] justify-end @[30rem]:w-60 @[30rem]:flex-none [&>*]:max-w-full",
          searching && "pointer-events-none",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** "Customise ▸" — tier 3 lives one click down, never deleted. */
export function Disclosure({
  label,
  open: controlledOpen,
  onOpenChange,
  children,
}: {
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const nav = React.useContext(SettingsNavContext);
  const [localOpen, setLocalOpen] = React.useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  // Search reaches inside: a hidden row that matches is still a result.
  const shown = open || nav.query.trim() !== "" || (nav.highlight?.startsWith(`${nav.page}/`) ?? false);
  // A jump that lands inside keeps it open after the flash ends.
  const boxRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!nav.highlight || open) return;
    if (boxRef.current?.querySelector(`[data-setting-key="${CSS.escape(nav.highlight)}"]`)) setOpen(true);
  }, [nav.highlight, open, setOpen]);
  return (
    <div ref={boxRef} className="flex flex-col">
      {nav.query.trim() === "" && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="-mx-2 flex h-8 items-center gap-1 rounded-md px-2 text-body text-fg-muted hover:bg-hover hover:text-fg"
        >
          {label}
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
      )}
      {shown && <div className="flex flex-col">{children}</div>}
    </div>
  );
}
