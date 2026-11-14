"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The crumb trail — ONE presentational primitive behind every "where am I"
 * path in the app: the project home's folders, the media library's folders and
 * the preset browser's categories. It knows nothing about what it is naming;
 * callers hand it a resolved trail and get back navigation, overflow collapsing
 * and (optionally) drop targets.
 *
 * Extracting it is what stops the third caller from becoming a third
 * near-identical copy of the same 80 lines.
 */
export interface Crumb {
  /** Null is the root crumb. */
  id: string | null;
  label?: string;
  icon?: React.ReactNode;
}

export function Crumbs({
  trail,
  currentId,
  onNavigate,
  maxDepth,
  compact,
  /** Renders `data-drop-<name>` on each crumb so a drag can drop up the tree. */
  dropAttribute,
  className,
}: {
  /** Root first, current last. The root crumb is usually icon-only. */
  trail: Crumb[];
  currentId: string | null;
  onNavigate: (id: string | null) => void;
  /** Show at most this many trailing crumbs after the root; deeper ones collapse. */
  maxDepth?: number;
  compact?: boolean;
  dropAttribute?: string;
  className?: string;
}) {
  const [root, ...rest] = trail;
  const overflow = maxDepth != null && rest.length > maxDepth;
  const shown = overflow ? rest.slice(rest.length - maxDepth!) : rest;
  const ellipsisTarget = overflow ? rest[rest.length - maxDepth! - 1]!.id : null;

  const index = trail.findIndex((c) => c.id === currentId);
  const parent = index > 0 ? trail[index - 1]!.id : null;
  const chev = cn("shrink-0 text-muted-foreground/50", compact ? "size-3" : "size-3.5");

  const crumb = (c: Crumb, key: string, children: React.ReactNode) => (
    <button
      key={key}
      type="button"
      {...(dropAttribute ? { [`data-drop-${dropAttribute}`]: c.id ?? "" } : {})}
      onClick={() => onNavigate(c.id)}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md transition-colors",
        compact ? "px-1.5 py-0.5" : "px-2 py-1",
        "data-[drop-over=true]:bg-primary/15 data-[drop-over=true]:ring-1 data-[drop-over=true]:ring-primary/60",
        c.id === currentId
          ? "text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );

  return (
    <div className={cn("flex min-w-0 items-center gap-0.5", compact ? "text-xs" : "text-sm", className)}>
      <button
        type="button"
        disabled={currentId === (root?.id ?? null)}
        onClick={() => onNavigate(parent)}
        aria-label="Back"
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
          compact ? "size-6" : "size-7",
        )}
      >
        <ChevronLeft className={compact ? "size-3.5" : "size-4"} />
      </button>
      {root && crumb(root, "root", root.icon ?? <span className="truncate font-medium">{root.label}</span>)}
      {overflow && (
        <>
          <ChevronRight className={chev} />
          {crumb({ id: ellipsisTarget }, "ellipsis", <MoreHorizontal className="size-3.5" />)}
        </>
      )}
      {shown.map((c) => (
        <React.Fragment key={c.id ?? "null"}>
          <ChevronRight className={chev} />
          {crumb(c, c.id ?? "null", <span className="truncate font-medium">{c.label}</span>)}
        </React.Fragment>
      ))}
    </div>
  );
}
