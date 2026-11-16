"use client";

import * as React from "react";
import type { AssetKind } from "@solomotion/core";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDoc, useDocStore } from "../state/document-context";
import { toast } from "@/lib/toast";
import { importFileAsAsset, assetKindForFile } from "../assets/import";
import { readDataTransferFiles } from "../assets/folder-import";
import { AssetThumb } from "../assets/AssetThumb";

/**
 * A WordPress-style media picker: pick an existing image/video asset from the
 * project, or upload/drop a new one. Reuses the real asset pipeline
 * (`importFileAsAsset`) and thumbnail store — no parallel media model. Returns
 * the chosen asset id to the caller, which decides what to do with it.
 */
export function MediaPickerDialog({
  open,
  onOpenChange,
  onPick,
  accept = ["image", "video"],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (assetId: string) => void;
  /** Which asset kinds to offer (default image + video). */
  accept?: AssetKind[];
}) {
  const doc = useDoc();
  const store = useDocStore();
  const [busy, setBusy] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const assets = doc.assets.filter((a) => accept.includes(a.kind));

  const pick = (assetId: string) => {
    onPick(assetId);
    onOpenChange(false);
  };

  const importFiles = async (files: File[]) => {
    const usable = files.filter((f) => {
      const k = assetKindForFile(f);
      return k != null && accept.includes(k);
    });
    if (usable.length === 0) {
      if (files.length > 0) toast("Only image or video files can fill this layer");
      return;
    }
    setBusy(true);
    try {
      let first: string | null = null;
      for (const file of usable) {
        const asset = await importFileAsAsset(store, file);
        if (asset && !first) first = asset.id;
      }
      if (first) pick(first);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose media</DialogTitle>
          <DialogDescription>Pick from your project, or drop / upload a new image or video.</DialogDescription>
        </DialogHeader>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setDragOver(false);
            const dropped = await readDataTransferFiles(e.dataTransfer);
            await importFiles(dropped.map((d) => d.file));
          }}
          className={cn(
            "rounded-lg border border-dashed p-2 transition-colors",
            dragOver ? "border-primary bg-primary/5" : "border-border/70",
          )}
        >
          {assets.length === 0 ? (
            <div className="flex h-28 items-center justify-center text-center text-[11px] text-muted-foreground">
              {busy ? "Importing…" : "No media yet — drop a file here or upload one below."}
            </div>
          ) : (
            <ScrollArea className="max-h-64" contentClassName="grid grid-cols-4 gap-1.5">
              {assets.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => pick(a.id)}
                  title={a.name}
                  className="group relative aspect-square overflow-hidden rounded-md border border-border/60 bg-muted transition hover:border-primary hover:ring-1 hover:ring-primary"
                >
                  <AssetThumb assetId={a.id} kind={a.kind} mime={a.mime} className="size-full" />
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-left text-[9px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                    {a.name}
                  </span>
                </button>
              ))}
            </ScrollArea>
          )}
        </div>

        <div>
          <input
            ref={inputRef}
            type="file"
            accept={accept.map((k) => `${k}/*`).join(",")}
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void importFiles(files);
            }}
          />
          <Button className="w-full" disabled={busy} onClick={() => inputRef.current?.click()}>
            <Upload /> {busy ? "Importing…" : "Upload media"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
