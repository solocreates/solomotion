"use client";

import * as React from "react";
import {
  compFps,
  isSequenceMime,
  MIN_LAYER_FPS,
  moveClip,
  reconcileFillClips,
  trimClip,
  type Clip,
} from "@solomotion/core";
import { FpsControl } from "@/components/ui/fps-control";
import { useDoc, useDocStore } from "../state/document-context";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { Half, PanelSection, PropRow } from "./controls";
import { useClipUpdater } from "./use-clip-updater";
import { mergeReads } from "./merge";
import { anyClip, usePeers } from "./selection-scope";

/**
 * WHEN the layer exists — start, duration, and whether it tracks its comp.
 * A tail section: every kind has it, nobody opens it first.
 */
export function TimingSection({ clip }: { clip: Clip }) {
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, anyClip);
  const start = mergeReads(peers, (c) => c.startMs);
  const duration = mergeReads(peers, (c) => c.durationMs);
  const fill = mergeReads(peers, (c) => c.fillDuration);
  return (
    <PanelSection id="timing" title="Timing" defaultOpen={false}>
      <PropRow label="Start">
        <Half>
          <NumberInput
            value={start.value / 1000}
            mixed={start.mixed}
            step={0.05}
            min={0}
            precision={2}
            unit="s"
            onChange={(v) => update("Move clip", (c, d) => void moveClip(d, c.id, v * 1000), "clip-start")}
          />
        </Half>
      </PropRow>
      <PropRow label="Duration">
        <Half>
          <NumberInput
            value={duration.value / 1000}
            mixed={duration.mixed}
            step={0.05}
            min={0.05}
            precision={2}
            unit="s"
            disabled={fill.value && !fill.mixed}
            onChange={(v) =>
              update("Resize clip", (c, d) => void trimClip(d, c.id, "end", c.startMs + v * 1000), "clip-dur")
            }
          />
        </Half>
      </PropRow>
      {/* Fill: the clip auto-tracks its comp's duration (the default for content
          inside a nested comp). Editing Duration above turns it off. */}
      <PropRow toggle label="Fill" hint="Track the comp's duration. Typing a duration turns this off.">
        <Switch
          checked={fill.value && !fill.mixed}
          aria-label="Fill comp duration"
          onCheckedChange={(on) =>
            update("Fill duration", (c, d) => {
              c.fillDuration = on;
              if (on) reconcileFillClips(d, c.frameId);
            })
          }
        />
      </PropRow>
      {clip.kind !== "audio" && <LayerRateRow clip={clip} />}
      {clip.kind === "image" && <SequenceRateRow assetId={clip.assetId} />}
    </PanelSection>
  );
}

/**
 * The layer's OWN frame rate: its time steps at this rate whatever the comp
 * runs at, each picture held until the next. Unset, it follows the comp —
 * shown as the comp's rate with a way to set one.
 *
 * On a frame's own effects the same field holds the WHOLE frame (posterize
 * time, `heldFrameTimeMs`), which is why the frame panel reuses this row
 * under its own name.
 */
export function LayerRateRow({
  clip,
  label = "Frame rate",
  hint = "Steps this layer at its own rate, holding each picture until the next.",
}: {
  clip: Exclude<Clip, { kind: "audio" }>;
  label?: string;
  hint?: string;
}) {
  const doc = useDoc();
  const update = useClipUpdater(clip.id);
  const own = clip.fps;
  const set = (fps: number | null) =>
    update(fps ? "Layer frame rate" : "Follow comp rate", (c) => void (c.kind !== "audio" && (c.fps = fps)), "clip-fps");
  return (
    <PropRow label={label} hint={hint}>
      <div className="flex min-w-0 items-center gap-1">
        <FpsControl
          size="compact"
          min={MIN_LAYER_FPS}
          value={own ?? compFps(doc, clip.frameId)}
          onChange={(v) => set(v)}
          menuTitle="Layer rate"
          className={own ? undefined : "opacity-60"}
        />
        {own !== null ? (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => set(null)}
          >
            Comp
          </button>
        ) : null}
      </div>
    </PropRow>
  );
}

/**
 * An image sequence's rate — a fact about the MEDIA (which instant each frame
 * is), so it changes every clip playing it and the sequence's length with it.
 */
function SequenceRateRow({ assetId }: { assetId: string }) {
  const doc = useDoc();
  const store = useDocStore();
  const asset = doc.assets.find((a) => a.id === assetId);
  if (!asset || !isSequenceMime(asset.mime) || !asset.fps || !asset.durationMs) return null;
  const frames = Math.round((asset.durationMs * asset.fps) / 1000);
  return (
    <PropRow label="Sequence" hint={`${frames} frames`}>
      <FpsControl
        size="compact"
        min={MIN_LAYER_FPS}
        value={asset.fps}
        menuTitle="Sequence rate"
        onChange={(fps) =>
          store.update(
            "Sequence rate",
            (d) => {
              const a = d.assets.find((x) => x.id === assetId);
              if (!a) return;
              a.fps = fps;
              a.durationMs = (frames / fps) * 1000;
            },
            { mergeKey: `seq-fps-${assetId}` },
          )
        }
      />
    </PropRow>
  );
}
