"use client";

import * as React from "react";
import { ImagePlus, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useDoc, useDocStore } from "../state/document-context";
import { importFileAsAsset, assetKindForFile } from "../assets/import";
import { readDataTransferFiles } from "../assets/folder-import";
import { AssetThumb } from "../assets/AssetThumb";
import { MediaPickerDialog } from "./MediaPickerDialog";

/**
 * THE IMAGE WELL — an effect's `image` field (a texture, a pattern, a map).
 *
 * The picture is the control, as in Figma's image fill: you see what the
 * effect is reading, click it to pick another from the media library, drop a
 * file on it from the desktop, and reset it to what the effect makes on its
 * own. Every effect that declares an `image` field gets this one well, so a
 * new texture-reading effect is a field in the registry, not a panel.
 *
 * `picture` is the effect's OWN view of the field, live — Surface shows its
 * lit sheet, so the default is never a blank and a replaced texture is shown
 * as the material it became, not as the raw file. Without one the well shows
 * the asset itself.
 */
export function ImageWell({
  value,
  onChange,
  empty = "None",
  picture,
  mixed,
  label,
}: {
  /** The image asset id; "" = none (the effect's own). */
  value: string;
  onChange: (assetId: string) => void;
  /** What an empty field means, as a caption ("Material's own"). */
  empty?: string;
  picture?: React.ReactNode;
  mixed?: boolean;
  label: string;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const [picking, setPicking] = React.useState(false);
  const [over, setOver] = React.useState(false);
  const asset = value ? doc.assets.find((a) => a.id === value) : undefined;
  const missing = !!value && !asset;

  const drop = async (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = (await readDataTransferFiles(e.dataTransfer)).map((d) => d.file).filter((f) => assetKindForFile(f) === "image");
    if (!files.length) {
      toast("Drop an image file here");
      return;
    }
    const added = await importFileAsAsset(store, files[0]!);
    if (added) onChange(added.id);
  };

  const caption = mixed ? "Mixed" : missing ? "Missing image" : (asset?.name ?? empty);

  return (
    <div className="min-w-0 flex-1">
      <MediaPickerDialog open={picking} onOpenChange={setPicking} onPick={onChange} accept={["image"]} />
      <div
        className={cn(
          "group relative h-16 w-full overflow-hidden rounded-md border border-line bg-input transition-colors",
          over && "border-primary",
        )}
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => void drop(e)}
      >
        <button
          type="button"
          aria-label={value ? `Replace ${label.toLowerCase()}` : `Choose ${label.toLowerCase()}`}
          title={value ? "Replace — or drop an image here" : "Choose an image — or drop one here"}
          onClick={() => setPicking(true)}
          className="absolute inset-0 size-full"
        >
          {picture ?? (asset ? <AssetThumb assetId={asset.id} kind="image" mime={asset.mime} className="size-full object-cover" /> : null)}
          {!picture && !asset && (
            <span className="flex size-full items-center justify-center gap-1.5 text-body text-fg-muted [&_svg]:size-4">
              <ImagePlus />
              Choose image
            </span>
          )}
        </button>
        {/* The caption and the reset ride ON the picture, as chips, and stay
            visible: hover-only actions do not exist on a touch screen. */}
        <span className="pointer-events-none absolute bottom-1 left-1 max-w-[calc(100%-2.5rem)] truncate rounded-sm bg-popover/85 px-1.5 text-meta text-fg-muted">
          {caption}
        </span>
        {value && (
          <button
            type="button"
            aria-label={`Reset ${label.toLowerCase()}`}
            title={`Back to ${empty.toLowerCase()}`}
            onClick={() => onChange("")}
            className="absolute right-1 bottom-1 flex size-5 items-center justify-center rounded-sm bg-popover/85 text-fg-muted transition-colors hover:text-fg [&_svg]:size-3"
          >
            <RotateCcw />
          </button>
        )}
      </div>
    </div>
  );
}
