"use client";

import * as React from "react";
import { Star } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { PopoverBody } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useIsFavorite, useWorkspace } from "../state/workspace";

/**
 * THE look browser — one searchable, shelved card grid behind every "pick a
 * look" surface in the app.
 *
 * It exists because the brush picker and the stroke-preset menus were asking
 * the same question — *which of these dozens of looks do I want?* — with two
 * different answers: a card grid with search and stars on one side of the
 * stage, a flat 11px list on the other. The list was written when the library
 * held eight presets; at fifty it is a scroll-hunt, and the two chromes
 * disagreeing about what a look looks like is exactly the drift this codebase
 * keeps paying for elsewhere.
 *
 * It is deliberately blind to what a look IS. An item hands it a preview node,
 * a name, a shelf and (optionally) a right-click menu; brushes render a real
 * painted bitmap, stroke sets render `StrokePreview`, and a future text-style
 * or animation library renders whatever it likes. The browser owns search,
 * shelving, starring, the active ring and the empty state — once.
 *
 * Stars ride the SAME workspace favourites every other starrable thing uses,
 * keyed by the item's id, so a starred look stays starred wherever it appears.
 */
export interface LookItem {
  id: string;
  name: string;
  /** Shelf heading. Items with no natural group should pass a real fallback. */
  group: string;
  /** Extra words search should match (family, tags, "dashed", "hand"). */
  tags?: readonly string[];
  /** Small caption at the card's foot — "3 lines", "painting". */
  meta?: string;
  preview: React.ReactNode;
  /** Right-click menu body (`<ContextMenuItem>`s). Omit for no menu. */
  menu?: React.ReactNode;
  onDoubleClick?: () => void;
}

export function LookBrowser({
  items,
  activeId,
  onPick,
  placeholder = "Search…",
  footer,
  starrable = true,
  className,
}: {
  items: readonly LookItem[];
  activeId?: string;
  onPick: (item: LookItem) => void;
  placeholder?: string;
  /** Pinned strip under the grid — "Save this stack", scope switches. */
  footer?: React.ReactNode;
  starrable?: boolean;
  className?: string;
}) {
  const [query, setQuery] = React.useState("");
  const isFavorite = useIsFavorite();

  const { starred, shelves } = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (i: LookItem) =>
      !q ||
      i.name.toLowerCase().includes(q) ||
      i.group.toLowerCase().includes(q) ||
      (i.tags ?? []).some((t) => t.toLowerCase().includes(q));
    const all = items.filter(hit);
    const star = starrable ? all.filter((i) => isFavorite(i.id)) : [];
    const rest = starrable ? all.filter((i) => !isFavorite(i.id)) : all;
    const byGroup = new Map<string, LookItem[]>();
    for (const i of rest) {
      if (!byGroup.has(i.group)) byGroup.set(i.group, []);
      byGroup.get(i.group)!.push(i);
    }
    return { starred: star, shelves: [...byGroup] };
  }, [items, query, isFavorite, starrable]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="border-b p-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="h-7 text-xs"
          autoFocus
        />
      </div>
      <PopoverBody className="max-h-[26rem]" viewportClassName="p-2">
        {starred.length > 0 && (
          <Shelf title="Starred">
            {starred.map((i) => (
              <Card key={i.id} item={i} active={i.id === activeId} onPick={onPick} starrable={starrable} />
            ))}
          </Shelf>
        )}
        {shelves.map(([name, list]) => (
          <Shelf key={name} title={name}>
            {list.map((i) => (
              <Card key={i.id} item={i} active={i.id === activeId} onPick={onPick} starrable={starrable} />
            ))}
          </Shelf>
        ))}
        {starred.length === 0 && shelves.length === 0 && (
          <p className="px-1 py-6 text-center text-[11px] text-muted-foreground">
            {query ? `Nothing matches “${query}”.` : "Nothing here yet."}
          </p>
        )}
      </PopoverBody>
      {footer && <div className="border-t border-border/60 p-1.5">{footer}</div>}
    </div>
  );
}

/** One titled shelf — the browser's only grouping primitive. */
function Shelf({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pb-2">
      <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="grid grid-cols-2 gap-1.5">{children}</div>
    </div>
  );
}

/**
 * One card. The preview gets the whole top of the card on a constant dark tile
 * — constant because a look has to be comparable to the look beside it, and a
 * tile that changed with the theme would make two brushes look different for a
 * reason that has nothing to do with either of them.
 */
function Card({
  item,
  active,
  onPick,
  starrable,
}: {
  item: LookItem;
  active: boolean;
  onPick: (item: LookItem) => void;
  starrable: boolean;
}) {
  const isFavorite = useIsFavorite();
  const toggleFavorite = useWorkspace((s) => s.toggleFavorite);
  const starred = starrable && isFavorite(item.id);

  const card = (
    <div
      role="button"
      tabIndex={0}
      title={item.name}
      onClick={() => onPick(item)}
      onDoubleClick={item.onDoubleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick(item);
        }
      }}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-xl border bg-[#101014] transition-shadow",
        active ? "border-primary ring-2 ring-primary/40" : "border-border/70 hover:border-foreground/30",
      )}
    >
      <div className="flex h-14 items-center justify-center overflow-hidden px-2 text-white/85">{item.preview}</div>
      <div className="flex items-center gap-1.5 border-t border-border/50 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px]">{item.name}</span>
        {item.meta && <span className="shrink-0 text-[9px] text-muted-foreground">{item.meta}</span>}
        {starrable && (
          <button
            type="button"
            aria-label={starred ? `Unstar ${item.name}` : `Star ${item.name}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleFavorite(item.id);
            }}
            className={cn(
              "rounded p-0.5 transition-opacity",
              starred ? "text-warning" : "text-muted-foreground opacity-0 group-hover:opacity-100",
            )}
          >
            <Star className={cn("size-3", starred && "fill-current")} />
          </button>
        )}
      </div>
    </div>
  );

  if (!item.menu) return card;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">{item.menu}</ContextMenuContent>
    </ContextMenu>
  );
}
