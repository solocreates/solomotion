"use client";

import * as React from "react";
import { createId, type Asset } from "@solomotion/core";
import { HardDrive, Trash2, Upload } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { putAssetBlob } from "../assets/asset-store";
import { AssetThumb } from "../assets/AssetThumb";
import { useDoc, useDocStore } from "../state/document-context";
import {
  removeDevicePatternImage,
  saveDevicePatternImage,
  useDevicePatternImages,
  type DevicePatternImage,
} from "./pattern-images";

/**
 * Choose the picture an image pattern tiles: one already in this project, one
 * saved on this device, or a new file.
 *
 * Importing asks where it lives — this project, or every project — which is the
 * same question the custom-sound importer asks, phrased the same way, because
 * it is the same question. The bytes land in the shared asset store either way,
 * so "save for all projects" costs one metadata row rather than a second copy
 * of the file.
 */
export function PatternImagePicker({
  assetId,
  onPick,
}: {
  assetId: string;
  onPick: (assetId: string) => void;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const device = useDevicePatternImages();
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [everywhere, setEverywhere] = React.useState(false);

  const projectImages = doc.assets.filter((a) => a.kind === "image");

  /** Adopt a device image into this project — one asset row pointing at bytes
   *  the blob store already holds. */
  const adopt = (image: DevicePatternImage) => {
    if (!doc.assets.some((a) => a.id === image.id)) {
      store.update("Use pattern image", (d) => {
        d.assets.push({
          id: image.id,
          kind: "image",
          name: image.name,
          mime: image.mime,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          durationMs: null,
          fps: null,
          folderId: null,
        } as Asset);
      });
    }
    onPick(image.id);
  };

  const importFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Patterns tile a picture — pick an image file.");
      return;
    }
    const id = createId("asset");
    await putAssetBlob(id, file);
    const size = await intrinsicSize(file);
    store.update("Import pattern image", (d) => {
      d.assets.push({
        id,
        kind: "image",
        name: file.name,
        mime: file.type,
        bytes: file.size,
        width: size?.w ?? null,
        height: size?.h ?? null,
        durationMs: null,
        fps: null,
        folderId: null,
      } as Asset);
    });
    if (everywhere) {
      saveDevicePatternImage({
        id,
        name: file.name,
        mime: file.type,
        bytes: file.size,
        width: size?.w ?? null,
        height: size?.h ?? null,
        savedAt: Date.now(),
      });
    }
    onPick(id);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex h-(--control-h) flex-1 items-center justify-center gap-1.5 rounded-md material-glass text-xs transition-colors hover:text-primary [&_svg]:size-3.5"
        >
          <Upload /> Import image
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={everywhere}
          onClick={() => setEverywhere((v) => !v)}
          title="Keep this image for every project on this device"
          className={cn(
            "flex h-(--control-h) items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors [&_svg]:size-3.5",
            everywhere ? "material-glass-raised text-primary" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <HardDrive /> All projects
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importFile(file);
        }}
      />

      {(projectImages.length > 0 || device.length > 0) && (
        <ScrollArea className="max-h-40">
          <div className="grid grid-cols-4 gap-1.5 pr-1">
            {projectImages.map((a) => (
              <ImageTile key={a.id} id={a.id} name={a.name} selected={a.id === assetId} onPick={() => onPick(a.id)} />
            ))}
            {device
              .filter((i) => !projectImages.some((a) => a.id === i.id))
              .map((i) => (
                <ImageTile
                  key={i.id}
                  id={i.id}
                  name={i.name}
                  device
                  selected={i.id === assetId}
                  onPick={() => adopt(i)}
                  onForget={() => removeDevicePatternImage(i.id)}
                />
              ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function ImageTile({
  id,
  name,
  selected,
  device,
  onPick,
  onForget,
}: {
  id: string;
  name: string;
  selected: boolean;
  device?: boolean;
  onPick: () => void;
  onForget?: () => void;
}) {
  return (
    <div className="group/tile relative">
      <button
        type="button"
        onClick={onPick}
        title={name}
        className={cn(
          "block aspect-square w-full overflow-hidden rounded-md transition-transform hover:scale-105",
          selected
            ? "shadow-[inset_0_0_0_2px_var(--primary)]"
            : "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]",
        )}
      >
        <AssetThumb assetId={id} kind="image" className="size-full object-cover" />
      </button>
      {device && (
        <span className="pointer-events-none absolute left-1 top-1 flex size-4 items-center justify-center rounded material-chip [&_svg]:size-2.5">
          <HardDrive />
        </span>
      )}
      {onForget && (
        <button
          type="button"
          onClick={onForget}
          aria-label={`Forget ${name}`}
          className="absolute right-1 top-1 flex size-4 items-center justify-center rounded material-chip text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/tile:opacity-100 [&_svg]:size-2.5"
        >
          <Trash2 />
        </button>
      )}
    </div>
  );
}

/** The picture's intrinsic size, for the asset row. Null when it will not
 *  decode — the import still succeeds, it just has no dimensions to report. */
async function intrinsicSize(file: File): Promise<{ w: number; h: number } | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
