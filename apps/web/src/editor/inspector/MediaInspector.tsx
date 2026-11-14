"use client";

import * as React from "react";
import {
  canRejoinAudio,
  canSeparateAudio,
  clipPlaybackOf,
  clipSpeedCurve,
  loopCycleWallMs,
  rejoinClipAudio,
  rejoinLoss,
  separateClipAudio,
  resolveRetimeRipple,
  retimeClip,
  retimeRippleDefault,
  setClipPlayback,
  type Clip,
  type ImageClip,
  type LoopMode,
  type VideoClip,
} from "@solomotion/core";
import { AudioLines, Link2, RotateCcw, Wand2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useDoc, useDocStore } from "../state/document-context";
import { addBackgroundRemoval } from "../state/remove-background";
import { clipLoopNaturalSpanMs } from "../stage/render/media-cache";
import { Half, IconToggle, Inline, PanelSection, PropRow } from "./controls";
import { SpeedSection, hasPlayback } from "./SpeedSection";
import { useField } from "./animatable";
import { mergeReads, selectValue } from "./merge";
import { ofKind, usePeers } from "./selection-scope";
import { KeyControl } from "./keyframe-controls";
import { useClipUpdater } from "./use-clip-updater";
import { useSession } from "../state/session";

const isMedia = ofKind("image", "video");

/**
 * The media inspector plus the shared PlaybackSection. Transform now lives in
 * the ONE unified `TransformSection` (rendered by the inspector shell), so no
 * box kind redefines it here anymore.
 */

/** Speed + loop for any source-backed clip (registry-driven). Speed changes
 * RETIME: the clip's footprint rescales to keep covering the same source span,
 * optionally rippling the rest of the track (DaVinci-style, per-clip pref). */
export function PlaybackSection({ clip }: { clip: Clip }) {
  const doc = useDoc();
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, hasPlayback);
  const playback = clipPlaybackOf(clip);
  const ripple = mergeReads(peers, (c) => clipPlaybackOf(c)?.ripple ?? retimeRippleDefault(doc, c.id));
  const loop = mergeReads(peers, (c) => clipPlaybackOf(c)?.loop ?? "none");
  const reverse = mergeReads(peers, (c) => clipPlaybackOf(c)?.reverse ?? false);
  const cycle = mergeReads(peers, (c) => {
    const pb = clipPlaybackOf(c);
    return pb ? loopCycleWallMs(pb, clipLoopNaturalSpanMs(doc, c), clipSpeedCurve(c)) : 0;
  });
  if (!playback) return null;
  return (
    <PanelSection title="Playback">
      {/* Speed is its own component because it is no longer one number: a rate,
          the verbs that ramp and freeze it, and the list of everything that
          happens to it across the clip. All of it projected from the clip's own
          speed keyframes — see `SpeedSection`. */}
      <SpeedSection clip={clip} />
      {!loop.mixed && loop.value === "none" && (
        <PropRow toggle label="Ripple" hint="Push later clips along when this one changes length.">
          <Switch
            checked={ripple.value && !ripple.mixed}
            onCheckedChange={(v) => update("Ripple on retime", (c) => setClipPlayback(c, { ripple: v }))}
          />
        </PropRow>
      )}
      <PropRow label="Loop">
        <Select
          value={selectValue(loop)}
          onValueChange={(v) => update("Loop mode", (c) => setClipPlayback(c, { loop: v as LoopMode }))}
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue placeholder="Mixed" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Play once</SelectItem>
            <SelectItem value="loop">Loop</SelectItem>
            <SelectItem value="pingpong">Ping-pong</SelectItem>
          </SelectContent>
        </Select>
      </PropRow>
      {(loop.mixed || loop.value !== "none") && (
        <PropRow label="Cycle" hint="How much of the clip is one loop — or drag the handle on the clip itself.">
          <Inline
            trailing={
              peers.some((c) => clipPlaybackOf(c)?.loopLengthMs != null) ? (
                <IconToggle
                  label="Reset to the natural source length"
                  onClick={() => update("Reset loop cycle", (c) => setClipPlayback(c, { loopLengthMs: null }))}
                >
                  <RotateCcw />
                </IconToggle>
              ) : undefined
            }
          >
            <Half>
              <NumberInput
                value={cycle.value / 1000}
                mixed={cycle.mixed}
                min={0.02}
                max={600}
                step={0.1}
                precision={2}
                unit="s"
                onChange={(v) =>
                  update("Loop cycle length", (c) => setClipPlayback(c, { loopLengthMs: v * 1000 }), "pb-cycle")
                }
              />
            </Half>
          </Inline>
        </PropRow>
      )}
      <PropRow toggle label="Reverse">
        <Switch
          checked={reverse.value && !reverse.mixed}
          onCheckedChange={(v) => update("Reverse clip", (c) => setClipPlayback(c, { reverse: v }))}
        />
      </PropRow>
    </PanelSection>
  );
}

/**
 * The way in and out of a video's sound being its own clip.
 *
 * A video carries its soundtrack, which is the right default — but the moment
 * you want to fade it, EQ it or duck it under a voiceover you need it as an
 * audio clip, and that is one button, here, beside the fader it belongs to. The
 * right-click menu offers the same verb; both call the same core op.
 */
function SeparateAudioButton({ clip }: { clip: VideoClip }) {
  const doc = useDoc();
  const store = useDocStore();
  const rejoin = canRejoinAudio(doc, clip.id);
  if (!rejoin && !canSeparateAudio(clip)) return null;
  const lost = rejoin ? rejoinLoss(doc, clip.id) : [];
  return (
    <button
      type="button"
      onClick={() => {
        if (rejoin) {
          store.update("Rejoin audio", (d) => void rejoinClipAudio(d, clip.id));
          toast(lost.length ? `Audio rejoined — discarded ${lost.join(" and ")}` : "Audio rejoined");
          return;
        }
        let audioId: string | null = null;
        store.update("Separate audio", (d) => {
          audioId = separateClipAudio(d, clip.id);
        });
        if (audioId) {
          useSession.getState().select([clip.id, audioId]);
          toast("Audio separated — it's linked, so they still move together");
        }
      }}
      className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/80 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground [&_svg]:size-3.5"
    >
      {rejoin ? <Link2 className="text-primary" /> : <AudioLines className="text-primary" />}
      {rejoin ? "Rejoin audio" : "Separate audio"}
    </button>
  );
}

// Fill and Stroke are TAIL sections of the spine, shared with every other
// paintable kind — a media clip's footage is simply its bottom fill. They used
// to be rendered here as well, which drew both sections twice on every image
// and video: once here, once from the spine.

export function MediaInspector({ clip }: { clip: ImageClip | VideoClip }) {
  const doc = useDoc();
  const store = useDocStore();
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, isMedia);
  const asset = doc.assets.find((a) => a.id === clip.assetId);
  const assetOf = (c: ImageClip | VideoClip) => doc.assets.find((a) => a.id === c.assetId);
  const file = mergeReads(peers, (c) => assetOf(c)?.name ?? "Missing asset");
  const size = mergeReads(peers, (c) => {
    const a = assetOf(c);
    return a?.width != null && a.height != null ? `${Math.round(a.width)} × ${Math.round(a.height)}` : null;
  });
  const videos = peers.filter((c): c is VideoClip => c.kind === "video");
  const allVideo = videos.length === peers.length;

  return (
    <>
      <PanelSection
        title={allVideo ? "Video" : peers.every((c) => c.kind === "image") ? "Image" : "Media"}
        collapsible={false}
      >
        <PropRow label="File">
          <span className="truncate text-xs text-muted-foreground" title={file.value}>
            {file.mixed ? "Mixed" : file.value}
          </span>
        </PropRow>
        {(size.mixed || size.value !== null) && (
          <PropRow label="Size">
            <span className="text-xs text-muted-foreground">{size.mixed ? "Mixed" : size.value}</span>
          </PropRow>
        )}
        <button
          type="button"
          onClick={() => {
            let added = 0;
            for (const c of peers) if (addBackgroundRemoval(store, c.id)) added++;
            if (added > 0) toast("Chroma key added — tune the color and tolerance below");
          }}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/80 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground [&_svg]:size-3.5"
        >
          <Wand2 className="text-primary" /> Remove background
        </button>
      </PanelSection>

      {clip.kind === "video" && allVideo && (
        <VideoSound clip={clip} videos={videos} assetMaxMs={asset?.durationMs ?? 600000} update={update} />
      )}
    </>
  );
}

/** A video's playback and its soundtrack — across every selected video. */
function VideoSound({
  clip,
  videos,
  assetMaxMs,
  update,
}: {
  clip: VideoClip;
  videos: readonly VideoClip[];
  assetMaxMs: number;
  update: ReturnType<typeof useClipUpdater>;
}) {
  const volume = useField(videos, "volume", (c) => c.volume);
  const muted = mergeReads(videos, (c) => c.muted);
  const trimIn = mergeReads(videos, (c) => c.trimInMs);
  return (
    <>
      <PlaybackSection clip={clip} />
      <PanelSection title="Sound" transfer={videos.length === 1 ? { domains: ["sound"], clipId: clip.id } : undefined}>
        <PropRow
          label="Volume"
          keyControl={<KeyControl clip={clip} property="volume" currentValue={() => volume.value} />}
        >
          <NumberInput
            value={Math.round(volume.value * 100)}
            mixed={volume.mixed}
            min={0}
            max={100}
            precision={0}
            unit="%"
            onChange={(v) => update("Volume", (c) => void (c.kind === "video" && (c.volume = v / 100)), "vid-vol")}
          />
        </PropRow>
        <PropRow toggle label="Muted">
          <Switch
            checked={muted.value && !muted.mixed}
            onCheckedChange={(on) =>
              update(on ? "Mute video" : "Unmute video", (c) => {
                if (c.kind === "video") c.muted = on;
              })
            }
          />
        </PropRow>
        <PropRow label="Trim in">
          <NumberInput
            value={trimIn.value / 1000}
            mixed={trimIn.mixed}
            min={0}
            max={assetMaxMs / 1000}
            step={0.1}
            precision={2}
            unit="s"
            onChange={(v) => update("Trim in", (c) => void (c.kind === "video" && (c.trimInMs = v * 1000)), "vid-trim")}
          />
        </PropRow>
        {videos.length === 1 && <SeparateAudioButton clip={clip} />}
      </PanelSection>
    </>
  );
}
