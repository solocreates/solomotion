import type { MotionDocument, Clip } from "../schema";
import { clipLocalTime } from "../animation/evaluate";
import { clipSourcePhaseAt } from "../timeline/ops";
import { switchOptions } from "../timeline/switch";
import type { ExprLayerApi } from "../expressions/layer-api";
import type { MediaPosition } from "./types";
import { mouthKindOf } from "./feel";

/**
 * FROM A COMP INSTANT TO A MOMENT OF THE RECORDING.
 *
 * Cues are stored in asset time; a clip plays its asset through trim, speed
 * (and speed ramps), loop, ping-pong and reverse. All of that is ONE function
 * already — `clipSourcePhaseAt`, the map the renderer, the exporter and the
 * waveform read — so lip sync asks it too and can never disagree with what is
 * heard. Moving, trimming or retiming a clip re-syncs the mouth with no
 * re-analysis, because nothing about the track changed.
 */

/** The recording a layer plays, if it plays one we can hear: an imported audio file or a video's sound. */
export function mediaAssetOf(clip: Clip): string | null {
  if (clip.kind === "audio") return clip.source.type === "asset" ? clip.source.assetId : null;
  if (clip.kind === "video") return clip.assetId;
  return null;
}

/**
 * Where `clip` is in its recording at comp time `compMs`, or null when it is
 * not sounding then: before it starts, after it ends, past the end of a
 * play-once source, or frozen (a held frame is silent).
 */
export function mediaSourceAt(doc: MotionDocument, clip: Clip, compMs: number): MediaPosition | null {
  const assetId = mediaAssetOf(clip);
  if (!assetId) return null;
  const local = clipLocalTime(clip, compMs);
  if (local === null) return null;
  const phase = clipSourcePhaseAt(doc, clip, local);
  if (phase.held) return null;
  const asset = doc.assets.find((a) => a.id === assetId);
  return { assetId, sourceMs: phase.sourceMs, ...(asset ? { asset } : {}) };
}

/**
 * The named states a layer can show — a switch's member names, top first.
 * What `lipsync()` resolves its viseme against when it drives a switch, so a
 * mouth missing a drawing shows its nearest neighbour instead of its top one.
 */
export function layerChoiceNames(doc: MotionDocument, clip: Clip): string[] | undefined {
  if (clip.kind !== "group" || !clip.switch) return undefined;
  return [...new Set(switchOptions(doc, clip.id).map((c) => c.name))];
}

/**
 * The media half of the expression layer API (`sourceOf`, `mouth`) for a
 * document at comp time `timeMs` — built ONCE here; the host spreads it into
 * the API it builds and tests build theirs from it, so both answer through
 * the same functions.
 */
export function mediaLayerApi(
  doc: MotionDocument,
  timeMs: number,
  clipOf: (id: string) => Clip | undefined,
): Pick<ExprLayerApi, "sourceOf" | "mouth"> {
  return {
    sourceOf: (id, offsetMs = 0) => {
      const clip = clipOf(id);
      return (clip && mediaSourceAt(doc, clip, timeMs + offsetMs)) ?? undefined;
    },
    mouth: (id) => {
      const clip = clipOf(id);
      if (!clip) return undefined;
      const choices = layerChoiceNames(doc, clip);
      return { kind: mouthKindOf(clip), ...(choices ? { choices } : {}) };
    },
  };
}
