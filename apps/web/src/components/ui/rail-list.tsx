"use client";

import * as React from "react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

/**
 * THE RAIL LIST — a vertical list of places, on a panel surface, beside the
 * thing it filters.
 *
 * This was written inside the Variables window and then wanted by the brush
 * library and the Brush Studio's tabs, which is the moment a local component
 * becomes a shared one. Copying it would have been the usual mistake: three
 * rails that look alike until one of them grows a drop target or an armed state
 * and the other two quietly disagree about what "selected" looks like.
 *
 * The armed state is `material-glass-raised` with the accent carried by the
 * ICON and LABEL — the app's one armed object, not a saturated slab. A rail
 * item is `h-8` so it lines up with every other control in a panel.
 */

export function RailSection({
  label,
  action,
}: {
  label: string;
  action?: { icon: React.ReactNode; label: string; onClick: () => void };
}) {
  return (
    <div className="mb-0.5 flex h-6 items-center gap-1 px-2 pt-3 first:pt-0">
      <span className="flex-1 text-meta font-medium text-fg-muted">
        {label}
      </span>
      {action && (
        <button
          type="button"
          aria-label={action.label}
          title={action.label}
          onClick={action.onClick}
          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3.5"
        >
          {action.icon}
        </button>
      )}
    </div>
  );
}

export function RailItem({
  icon,
  label,
  count,
  active,
  depth = 0,
  accent,
  onClick,
  onDoubleClick,
  onDrop,
  onDropActive,
  onDropOver,
  children,
  menu,
  trailing,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  count?: number;
  active: boolean;
  depth?: number;
  accent?: string;
  onClick: () => void;
  onDoubleClick?: () => void;
  onDrop?: () => void;
  onDropActive?: boolean;
  onDropOver?: (over: boolean) => void;
  /** Rendered BEFORE the icon — a disclosure chevron. */
  children?: React.ReactNode;
  /** Rendered after the count — a badge or an action. */
  trailing?: React.ReactNode;
  /**
   * Context-menu ITEMS — not a `<ContextMenuContent>`.
   *
   * The wrapper is supplied here because forgetting it is not a layout bug, it
   * is a crash: a Radix item outside its content throws "`MenuItem` must be
   * used within `MenuContent`", and two of three callers only got it right by
   * copying the first. A prop typed `ReactNode` cannot say which it wants, so
   * the component owns the chrome and a caller can only pass items.
   */
  menu?: React.ReactNode;
}) {
  const row = (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      aria-current={active}
      onDragOver={onDrop ? (e) => (e.preventDefault(), onDropOver?.(true)) : undefined}
      onDragLeave={onDrop ? () => onDropOver?.(false) : undefined}
      onDrop={
        onDrop
          ? (e) => {
              e.preventDefault();
              onDropOver?.(false);
              onDrop();
            }
          : undefined
      }
      className={cn(
        "flex h-(--control-h) w-full items-center gap-2 rounded-md pr-2 text-left text-body transition-colors [&>svg]:size-3.5",
        active ? "bg-selection text-selection-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
        onDropActive && "ring-1 ring-primary",
      )}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      {children}
      <span
        className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5"
        style={accent ? { color: accent } : undefined}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-meta tabular-nums text-fg-faint">{count}</span>
      )}
      {trailing}
    </button>
  );
  return menu ? (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">{menu}</ContextMenuContent>
    </ContextMenu>
  ) : (
    row
  );
}
