"use client";

import * as React from "react";
import {
  compContentRevision,
  getTemplate,
  resolveTemplate,
  type LibraryItem,
  type LibraryPreview,
} from "@solomotion/core";
import { ArrowLeftRight, Component, Film, Image as ImageIcon, LayoutTemplate, Music, Sparkles, Type } from "lucide-react";
import { TemplatePoster } from "./TemplatePoster";
import { cn } from "@/lib/utils";
import { useDocWhen } from "../state/document-context";
import { ComponentThumb } from "../panels/component-thumb";
import { AnimationPreview, TransitionPreview } from "../ui/PosePreview";
import { AssetThumb } from "../assets/AssetThumb";
import { useWorkspace } from "../state/workspace";
import { PeaksWave } from "./PeaksWave";
import { TextLookPreview } from "./TextLookPreview";
import { useSoundShape } from "./item-peaks";

/**
 * THE preview surface — one component that draws any library item, online or
 * local, and the reason there is one card instead of six.
 *
 * It dispatches on `item.preview`, and the `render` arm dispatches again on
 * what the item IS, because "the app draws it itself" means something different
 * for a component (the real renderer), a sound (its decoded waveform) and a
 * preset (the headless evaluator). Every one of those already existed and was
 * already correct; the work here is routing, not drawing.
 *
 * `playing` is hover. Nothing animates, decodes or fetches until it is true —
 * an idle library of a thousand cards costs a thousand `<canvas>` elements
 * doing nothing, which is the only budget that matters at that size.
 */

const KIND_GLYPH = {
  sound: Music,
  text: Type,
  animation: Sparkles,
  transition: ArrowLeftRight,
  component: Component,
  media: Film,
  template: LayoutTemplate,
} as const;

export function LibraryArt({
  item,
  playing,
  className,
}: {
  item: LibraryItem;
  playing: boolean;
  className?: string;
}) {
  return (
    <div className={cn("relative flex size-full items-center justify-center overflow-hidden", className)}>
      <Art item={item} preview={item.preview} playing={playing} />
    </div>
  );
}

function Art({
  item,
  preview,
  playing,
}: {
  item: LibraryItem;
  preview: LibraryPreview;
  playing: boolean;
}) {
  switch (preview.type) {
    case "peaks":
      return <SoundArt item={item} playing={playing} />;
    case "image":
      return <PreviewImage url={preview.url} />;
    case "video":
      return <PreviewVideo preview={preview} playing={playing} />;
    case "css":
    case "render":
      return <SelfRendered item={item} playing={playing} />;
    default:
      return <Glyph item={item} />;
  }
}

/** The app drawing its own content, routed by what the item actually is. */
function SelfRendered({ item, playing }: { item: LibraryItem; playing: boolean }) {
  const action = item.action;
  // A component card is a picture of its comp; an asset card reads its asset.
  // Nothing else on the card comes from the document.
  const doc = useDocWhen((d) =>
    action?.type === "instance" ? [compContentRevision(d, action.frameId), d.frames] : action?.type === "asset" ? [d.assets] : [],
  );

  if (action?.type === "instance") {
    const frame = doc.frames.find((f) => f.id === action.frameId);
    return frame ? <ComponentThumb doc={doc} frame={frame} /> : <Glyph item={item} />;
  }

  if (action?.type === "template") return <TemplatePoster templateId={action.templateId} playing={playing} />;

  if (action?.type === "snapshot") {
    return <Glyph item={item} />;
  }

  if (action?.type === "asset") {
    const asset = doc.assets.find((a) => a.id === action.assetId);
    return asset ? (
      <AssetThumb assetId={asset.id} kind={asset.kind} mime={asset.mime} className="size-full" />
    ) : (
      <Glyph item={item} />
    );
  }

  if (action?.type === "sound") return <SoundArt item={item} playing={playing} />;

  if (action?.type === "preset") {
    if (action.domain === "transition") {
      return <TransitionPreview presetId={action.presetId} playing={playing} className="size-full" />;
    }
    if (action.domain === "animation") {
      return <AnimationPreview presetId={action.presetId} playing={playing} className="size-full" />;
    }
    return <TemplateArt templateId={action.presetId} playing={playing} />;
  }

  return <Glyph item={item} />;
}

/**
 * A text look, previewed as the REAL thing — see `TextLookPreview`. Resolved
 * through the SAME preferences the apply path uses, so a card is showing you
 * the colour and the voice you would actually get, not the one the preset
 * happened to be authored in.
 */
function TemplateArt({ templateId, playing }: { templateId: string; playing: boolean }) {
  const prefs = useWorkspace((s) => s.textLookPrefs);
  const template = getTemplate(templateId);
  const look = React.useMemo(
    () => (template ? resolveTemplate(template, prefs) : null),
    [template, prefs],
  );
  if (!look) return null;
  return <TextLookPreview look={look} playing={playing} />;
}

/**
 * Every sound, one painter. Published peaks stand in until the samples decode,
 * and both are measured the same way — so the waveform does not change shape
 * the moment a sound arrives.
 */
function SoundArt({ item, playing }: { item: LibraryItem; playing: boolean }) {
  const shape = useSoundShape(item);
  if (!shape.peaks.length) return <Glyph item={item} />;
  return (
    <PeaksWave
      peaks={shape.peaks}
      durationMs={shape.durationMs}
      hitMs={shape.hitMs}
      playing={playing}
      className="size-full text-muted-foreground [--tm-wave-played:var(--primary)]"
    />
  );
}

function PreviewImage({ url }: { url: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" loading="lazy" draggable={false} className="size-full object-cover" />;
}

/**
 * Poster at rest, silent loop on hover. The video element is only created once
 * hovered — a grid of autoplaying loops is the fastest way to make a library
 * feel broken on a laptop.
 */
function PreviewVideo({
  preview,
  playing,
}: {
  preview: Extract<LibraryPreview, { type: "video" }>;
  playing: boolean;
}) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    if (playing) setMounted(true);
  }, [playing]);

  return (
    <>
      {preview.posterUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.posterUrl}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn("absolute inset-0 size-full object-cover transition-opacity", playing && mounted && "opacity-0")}
        />
      )}
      {mounted && (
        <video
          src={preview.url}
          muted
          loop
          playsInline
          autoPlay={playing}
          ref={(el) => {
            if (!el) return;
            if (playing) void el.play().catch(() => {});
            else {
              el.pause();
              el.currentTime = 0;
            }
          }}
          className="size-full object-cover"
        />
      )}
    </>
  );
}

function Glyph({ item }: { item: LibraryItem }) {
  const Icon = KIND_GLYPH[item.kind];
  return <Icon className="size-5 text-muted-foreground/60" />;
}
