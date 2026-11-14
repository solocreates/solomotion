"use client";

import * as React from "react";
import type { AssetKind } from "@solomotion/core";
import { AudioLines, Film, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { assetObjectURL } from "./asset-store";
import { useAssetSoundShape } from "../library/item-peaks";
import { PeaksWave } from "../library/PeaksWave";

/** Resolve an asset's object URL (blob) for previews — null until loaded/missing. */
export function useAssetUrl(assetId: string | null | undefined, mime?: string): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!assetId) {
      setUrl(null);
      return;
    }
    let alive = true;
    void assetObjectURL(assetId, mime).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [assetId, mime]);
  return url;
}

/**
 * A visual thumbnail for any imported asset — the decoded image, a video's first
 * frame (`#t` poster hint), or a kind icon while bytes stream in / are missing.
 * Reused by the fill-row swatch, the media picker, and the media fill editor.
 */
export function AssetThumb({
  assetId,
  kind,
  mime,
  className,
}: {
  assetId: string | null | undefined;
  kind: AssetKind;
  mime?: string;
  className?: string;
}) {
  // AUDIO IS A WAVEFORM, not a picture. It used to fall through to the image
  // branch below, which pointed an `<img>` at a .wav and drew the browser's
  // broken-image box — the blank tile where every sound in the media library
  // should have been. A file that looks like nothing is indistinguishable from
  // a file that failed to import.
  //
  // The hook runs first regardless: an early return above it would make hook
  // order depend on an asset's KIND, so a video replacing an audio file in the
  // same slot would tear every later hook off its state.
  const url = useAssetUrl(kind === "audio" ? null : assetId, mime);
  if (kind === "audio") return <AudioThumb assetId={assetId} className={className} />;
  if (!url) {
    return (
      <div className={cn("flex items-center justify-center text-muted-foreground/60 [&_svg]:size-1/3", className)}>
        {kind === "video" ? <Film /> : <ImageIcon />}
      </div>
    );
  }
  if (kind === "video") {
    // The #t fragment nudges the browser to render a poster frame without playing.
    return <video src={`${url}#t=0.1`} muted playsInline preload="metadata" className={cn("object-cover", className)} />;
  }
  return <img src={url} alt="" className={cn("object-cover", className)} />;
}

/**
 * One audio tile, drawn through the SAME peaks pipeline as every other
 * waveform in the app — the library card, the timeline lane, the sound picker.
 * A second binner here would make the same file a different shape depending on
 * which panel you were looking at.
 *
 * The glyph stands in only until the bytes decode, and decoding is triggered by
 * asking: a tile that is never rendered never costs a decode.
 */
function AudioThumb({ assetId, className }: { assetId: string | null | undefined; className?: string }) {
  const shape = useAssetSoundShape(assetId);
  if (!shape.peaks.length) {
    return (
      <div className={cn("flex items-center justify-center text-muted-foreground/60 [&_svg]:size-1/3", className)}>
        <AudioLines />
      </div>
    );
  }
  return (
    <PeaksWave
      peaks={shape.peaks}
      durationMs={shape.durationMs}
      hitMs={shape.hitMs}
      className={cn("text-muted-foreground", className)}
    />
  );
}
