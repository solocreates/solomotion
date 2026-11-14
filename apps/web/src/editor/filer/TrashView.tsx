"use client";

import * as React from "react";
import { Folder, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FilerItem } from "./model/tree";
import { useFiler, type FilerStore } from "./use-file-manager";

/**
 * Recently Deleted — restore or permanently remove trashed groups (a trashed
 * folder brings its whole subtree back / away as one). Reads `fm.trash`; open
 * state is the store's (`openTrash`/`closeTrash`).
 */
export function TrashView<T>({
  fm,
  itemThumbUrl,
}: {
  fm: FilerStore<T>;
  itemThumbUrl: (item: FilerItem<T>) => string | null;
}) {
  const trash = useFiler(fm, (s) => s.trash);

  return (
    <Dialog open={trash !== null} onOpenChange={(o) => !o && fm.getState().closeTrash()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Recently deleted</DialogTitle>
          <DialogDescription>Restore items to where they were, or delete them for good.</DialogDescription>
        </DialogHeader>

        {trash && trash.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">Nothing here.</p>
        ) : (
          <ScrollArea className="max-h-[60vh]">
            <ul className="flex flex-col gap-1.5 pr-3">
              {trash?.map((entry) => {
                const isFolder = entry.node.kind === "folder";
                const thumb = !isFolder ? itemThumbUrl(entry.node as FilerItem<T>) : null;
                return (
                  <li
                    key={entry.node.id}
                    className="flex items-center gap-3 rounded-lg border bg-card px-2.5 py-2"
                  >
                    <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-stage">
                      {isFolder ? (
                        <Folder className="size-5 text-muted-foreground" />
                      ) : thumb ? (
                        <img src={thumb} alt="" className="size-full object-cover" draggable={false} />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{entry.node.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {isFolder ? `Folder · ${entry.count} item${entry.count === 1 ? "" : "s"}` : "Project"}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                      onClick={() => void fm.getState().restore([entry.node.id])}
                    >
                      <RotateCcw className="size-3.5" /> Restore
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1.5 text-destructive hover:text-destructive"
                      onClick={() => void fm.getState().purge([entry.node.id])}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
