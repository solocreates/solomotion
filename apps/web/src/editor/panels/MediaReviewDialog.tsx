"use client";

import * as React from "react";
import { create } from "zustand";
import type { AssetKind } from "@solomotion/core";
import { Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { linkFileToAsset } from "../assets/import";
import { forgetRefs, orphanClipRefs, reimportOrphanAssets, type ClipRef } from "../assets/media-usage";
import { useDocStore } from "../state/document-context";
import { AffectedClipsList } from "./AffectedClips";

/**
 * The single "clips not in the library" workflow, mounted once and opened from
 * anywhere (the media panel banner, the Save alert). It snapshots the affected
 * clips so relinked rows stay visible as ✓ done instead of vanishing mid-fix.
 * Per row: click to jump to the clip, drop a file / Replace to relink, or Forget
 * to drop it entirely. Import automatically recovers everything whose bytes are
 * still on this device. One dialog, no duplicated DOM.
 */

interface MediaReviewUi {
  open: boolean;
  openReview: () => void;
  close: () => void;
}
export const useMediaReviewUi = create<MediaReviewUi>((set) => ({
  open: false,
  openReview: () => set({ open: true }),
  close: () => set({ open: false }),
}));

function assetKind(ref: ClipRef): AssetKind {
  return ref.kind === "video" ? "video" : ref.kind === "audio" ? "audio" : "image";
}

export function MediaReviewDialog() {
  const store = useDocStore();
  const open = useMediaReviewUi((s) => s.open);
  const close = useMediaReviewUi((s) => s.close);

  const [items, setItems] = React.useState<ClipRef[]>([]);
  const [resolved, setResolved] = React.useState<Set<string>>(new Set());

  // Snapshot on open so relinked rows persist (as done) rather than disappearing.
  React.useEffect(() => {
    if (open) {
      setItems(orphanClipRefs(store.getState()));
      setResolved(new Set());
    }
  }, [open, store]);

  const markResolved = (assetIds: Iterable<string>) =>
    setResolved((prev) => {
      const next = new Set(prev);
      for (const id of assetIds) next.add(id);
      return next;
    });

  const importAuto = async () => {
    await reimportOrphanAssets(store);
    const known = new Set(store.getState().assets.map((a) => a.id));
    markResolved(items.filter((r) => known.has(r.assetId)).map((r) => r.assetId));
  };

  const replace = (ref: ClipRef) => {
    const el = document.createElement("input");
    el.type = "file";
    el.accept = `${assetKind(ref)}/*`;
    el.onchange = async () => {
      const file = el.files?.[0];
      if (file && (await linkFileToAsset(store, { assetId: ref.assetId, kind: assetKind(ref), name: ref.name }, file)))
        markResolved([ref.assetId]);
    };
    el.click();
  };

  const dropFile = async (ref: ClipRef, file: File) => {
    if (await linkFileToAsset(store, { assetId: ref.assetId, kind: assetKind(ref), name: ref.name }, file))
      markResolved([ref.assetId]);
  };

  const forget = (ref: ClipRef) => {
    forgetRefs(store, [ref]);
    setItems((prev) => prev.filter((r) => r.clipId !== ref.clipId));
  };

  const allResolved = items.length > 0 && items.every((r) => resolved.has(r.assetId));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Clips not in the library</DialogTitle>
          <DialogDescription>
            These clips play from cached bytes but aren’t saved with the project. Import them, drop a file on
            one to relink, or forget the clip entirely.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button size="sm" className="h-8 gap-1.5" onClick={importAuto}>
            <Sparkles className="size-3.5" /> Import automatically
          </Button>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 text-destructive hover:text-destructive"
            onClick={() => {
              forgetRefs(store, items);
              setItems([]);
            }}
          >
            <Trash2 className="size-3.5" /> Forget all
          </Button>
        </div>

        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Nothing to review — every clip is linked.</p>
        ) : (
          <AffectedClipsList
            refs={items}
            resolved={resolved}
            onFocus={close}
            onReplace={replace}
            onForget={forget}
            onDropFile={dropFile}
            className="min-h-0 flex-1"
          />
        )}

        <DialogFooter>
          <Button onClick={close}>{allResolved ? "Done" : "Close"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
