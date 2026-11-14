"use client";

import * as React from "react";
import { Check, FolderPlus, Star, ThumbsDown } from "lucide-react";
import { collectionsFor, verdictOf, type MarkRef } from "@solomotion/core";
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
import { useMarks, useMarksState } from "../state/marks";

/**
 * RIGHT-CLICK ANY PIECE OF CONTENT — one menu, every catalogue.
 *
 * The icons grid, the sound rows and the library cards all ask the same three
 * questions of an item ("do I like this", "never show me this again", "put it
 * with the others"), so they ask them through one component over one store.
 * Writing it per browser is how the app ended up with two incompatible ideas
 * of what a favourite was.
 *
 * `extra` is the seam for what is genuinely local to a surface — copy an id,
 * download the file, open the pack. Those differ per content type and belong
 * to the surface; the marks do not.
 */

export function MarkMenu({
  target,
  label,
  extra,
  children,
}: {
  target: MarkRef;
  /** The item's name — the menu's own heading, so the row it acts on is never
   *  in doubt when several are visible. */
  label: string;
  /** Surface-specific rows, rendered under a separator. */
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const marks = useMarksState();
  const mark = useMarks((s) => s.mark);
  const toggleIn = useMarks((s) => s.toggleIn);
  const newCollection = useMarks((s) => s.newCollection);
  const verdict = verdictOf(marks, target);
  const holding = React.useMemo(
    () => new Set(collectionsFor(marks, target).map((c) => c.id)),
    [marks, target],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <div className="truncate px-2 py-1.5 text-[11px] font-medium text-muted-foreground">{label}</div>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => mark(target, "starred")}>
          <Star className={verdict === "starred" ? "fill-current text-primary" : undefined} />
          {verdict === "starred" ? "Unstar" : "Star"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => mark(target, "disliked")}>
          <ThumbsDown className={verdict === "disliked" ? "fill-current text-primary" : undefined} />
          {verdict === "disliked" ? "Undo dislike" : "Dislike"}
        </ContextMenuItem>

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderPlus />
            Collections
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            {marks.collections.map((c) => (
              <ContextMenuCheckboxItem
                key={c.id}
                checked={holding.has(c.id)}
                onSelect={(e) => {
                  // Keep the menu open: adding one thing to three collections
                  // should not be three right-clicks.
                  e.preventDefault();
                  toggleIn(c.id, target);
                }}
              >
                <span className="truncate">{c.name}</span>
              </ContextMenuCheckboxItem>
            ))}
            {marks.collections.length > 0 && <ContextMenuSeparator />}
            <ContextMenuItem
              // Made and filled in one action, named afterwards in the rail
              // where the row can be edited in place. A `window.prompt` here
              // asked for the one thing nobody has decided yet — what an empty
              // collection is called — in the one dialog the app cannot style,
              // cannot dismiss with Escape and cannot put beside the item it
              // is about.
              onSelect={() => newCollection("Untitled", target)}
            >
              <Check className="opacity-0" />
              New collection
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>

        {extra && (
          <>
            <ContextMenuSeparator />
            {extra}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
