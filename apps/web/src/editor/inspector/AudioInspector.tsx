"use client";

import * as React from "react";
import { Range } from "@/components/ui/range";
import {
  clipNaturalSourceSpanMs,
  dbToGain,
  gainToDb,
  clipSpeedCurve,
  loopCycleWallMs,
  resolveRetimeRipple,
  retimeClip,
  soundPackIdSchema,
  type AudioClip,
  type Easing,
  type KeyframeValue,
  type LoopMode,
  type SoundPackId,
} from "@solomotion/core";
import { Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EasingPicker } from "@/components/ui/easing-editor";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { soundEngine, SOUND_PACK_LABELS } from "../audio/sound-engine";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { commitProperty, useField } from "./animatable";
import { mergeReads, selectValue } from "./merge";
import { ofKind, usePeers } from "./selection-scope";
import { Pair, PanelSection, PropRow } from "./controls";
import { KeyControl } from "./keyframe-controls";
import { AudioEffectsSection } from "./audio-effects/AudioEffectsSection";
import { useClipUpdater } from "./use-clip-updater";
import { lazyComponent } from "@/editor/lazy-component";

const LipSyncRow = lazyComponent("LipSyncRow", () => import("../speech/LipSyncRow").then((m) => ({ default: m.LipSyncRow })));

const isAudio = ofKind("audio");

const LOOP_LABELS: Record<LoopMode, string> = {
  none: "Play once",
  loop: "Loop",
  pingpong: "Ping-pong",
};

/** Volume floor for the dB field — below this the clip is treated as silent. */
const MIN_DB = -60;
const MAX_DB = 12;

/** dB label for a linear gain (−∞ shown as a dash). */
function dbLabel(gain: number): string {
  if (gain <= 0) return "−∞";
  const db = gainToDb(gain);
  return `${db > 0 ? "+" : ""}${db.toFixed(1)}`;
}

export function AudioInspector({ clip }: { clip: AudioClip }) {
  const update = useClipUpdater(clip.id);
  const doc = useDoc();
  const peers = usePeers(clip, isAudio);
  // A file and a sound-pack voice have different panels; together they share
  // the fader, the fades and the chain.
  const isAsset = peers.every((c) => c.source.type === "asset");
  const isPack = peers.every((c) => c.source.type === "pack");
  const assetName = mergeReads(peers, (c) =>
    c.source.type === "asset" ? (doc.assets.find((a) => c.source.type === "asset" && a.id === c.source.assetId)?.name ?? "Missing asset") : "",
  );
  const asset = clip.source.type === "asset" ? doc.assets.find((a) => clip.source.type === "asset" && a.id === clip.source.assetId) : undefined;
  const pack = mergeReads(peers, (c) => (c.source.type === "pack" ? c.source.pack : null));
  // A voice category locks keep-pitch on — the one predicate is `audioKeepsPitch`.
  const isSpeech = (c: AudioClip) => doc.soundBuses.find((b) => b.id === c.soundBus)?.character === "voice";
  const keepPitch = mergeReads(peers, (c) => isSpeech(c) || c.keepPitch);
  const anyVoice = peers.some(isSpeech);
  const speed = mergeReads(peers, (c) => c.playback.speed);
  const loop = mergeReads(peers, (c) => c.playback.loop);
  const cycle = mergeReads(peers, (c) => loopCycleWallMs(c.playback, clipNaturalSourceSpanMs(doc, c), clipSpeedCurve(c)));
  const trimIn = mergeReads(peers, (c) => c.trimInMs);
  const repeat = mergeReads(peers, (c) => c.repeatEveryMs);
  const fadeIn = mergeReads(peers, (c) => c.fadeIn.durationMs);
  const fadeOut = mergeReads(peers, (c) => c.fadeOut.durationMs);

  // Animatable write bound to this clip — record mode / keyed props write a key.
  const commit = React.useCallback(
    (label: string, path: string, v: KeyframeValue, mergeKey?: string) =>
      update(label, (c) => commitProperty(c, path, v, useSession.getState().playheadMs), mergeKey),
    [update],
  );

  // Retiming RIPPLES — it moves everything after this clip — so both the fader
  // and the number field write through the one op rather than each restating it.
  const setSpeed = React.useCallback(
    (v: number) =>
      update(
        "Change speed",
        (c, d) => void retimeClip(d, c.id, v, { ripple: resolveRetimeRipple(d, c.id) }),
        "audio-speed",
      ),
    [update],
  );

  // The gain the renderer uses right now (sampled at the playhead when keyed).
  const gainField = useField(peers, "gain", (c) => c.gain);
  const pitchField = useField(peers, "pitch", (c) => c.pitchSemitones);
  const gain = gainField.value;
  const pitch = pitchField.value;
  const isVoice = anyVoice;

  return (
    <>
      <PanelSection title={isAsset ? "Audio clip" : isPack ? "Sound clip" : "Sound"} collapsible={false}>
        {!isAsset && !isPack ? null : isPack ? (
          <PropRow label="Pack">
            <div className="flex gap-1">
              <Select
                value={selectValue(pack)}
                onValueChange={(pack) =>
                  update("Change sound", (c) => {
                    if (c.kind === "audio") c.source = { type: "pack", pack: pack as SoundPackId };
                  })
                }
              >
                <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
                  <SelectValue placeholder="Mixed" />
                </SelectTrigger>
                <SelectContent>
                  {soundPackIdSchema.options.map((p) => (
                    <SelectItem key={p} value={p}>
                      {SOUND_PACK_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="secondary"
                size="icon-sm"
                aria-label="Preview"
                onClick={() => {
                  if (clip.source.type === "pack") soundEngine.preview(clip.source.pack, clip.gain);
                }}
              >
                <Play />
              </Button>
            </div>
          </PropRow>
        ) : (
          <PropRow label="File">
            <span className="truncate text-xs text-muted-foreground" title={assetName.value}>
              {assetName.mixed ? "Mixed" : assetName.value}
            </span>
          </PropRow>
        )}
        {/* Volume in dB (Resolve-style): 0 dB = unity, up to +12 dB boost. The
            slider writes the linear `gain` path, so keyframes/record capture it. */}
        <PropRow
          label="Volume"
          keyControl={<KeyControl clip={clip} property="gain" currentValue={() => gain} />}
        >
          <Range
            value={gain <= 0 ? MIN_DB : Math.max(MIN_DB, Math.min(MAX_DB, gainToDb(gain)))}
            min={MIN_DB}
            max={MAX_DB}
            step={0.5}
            defaultValue={0}
            ticks={[MIN_DB, 0]}
            aria-label="Volume"
            format={() => (gainField.mixed ? "Mixed" : `${dbLabel(gain)} dB`)}
            onChange={(db) => commit("Change volume", "gain", db <= MIN_DB ? 0 : dbToGain(db), "audio-gain")}
          />
        </PropRow>
      </PanelSection>

      {/* Fade handles (also draggable on the clip). Reversible: 0 s = no fade. */}
      <PanelSection title="Fades" transfer={{ domains: ["sound"], clipId: clip.id }}>
        <FadeRow
          label="Fade in"
          durationMs={fadeIn.value}
          mixed={fadeIn.mixed}
          curve={clip.fadeIn.curve}
          maxMs={clip.durationMs}
          onDuration={(ms, mk) =>
            update("Fade in", (c) => void (c.kind === "audio" && (c.fadeIn.durationMs = ms)), mk)
          }
          onCurve={(easing) =>
            update("Fade in curve", (c) => void (c.kind === "audio" && (c.fadeIn.curve = easing)))
          }
        />
        <FadeRow
          label="Fade out"
          durationMs={fadeOut.value}
          mixed={fadeOut.mixed}
          curve={clip.fadeOut.curve}
          maxMs={clip.durationMs}
          onDuration={(ms, mk) =>
            update("Fade out", (c) => void (c.kind === "audio" && (c.fadeOut.durationMs = ms)), mk)
          }
          onCurve={(easing) =>
            update("Fade out curve", (c) => void (c.kind === "audio" && (c.fadeOut.curve = easing)))
          }
        />
      </PanelSection>

      {/* THE sound effect stack — EQ, reverb, echo, compression, saturation.
          Same cards, same palette, same floating editor and presets as the
          visual stack; the equaliser is one entry in it rather than a field
          with its own panel, which is why this section replaced it. */}
      {/* A chain is a list of cards with their own ids — per clip, so it is
          shown for one; each clip's is in its own row below. */}
      {peers.length === 1 && <AudioEffectsSection clip={clip} />}

      {peers.length === 1 && isAsset && (
        <React.Suspense fallback={null}>
          <LipSyncRow clip={clip} />
        </React.Suspense>
      )}

      {isAsset && (
        <PanelSection title="Pitch">
          <PropRow toggle label="Keep pitch">
            <div className="flex items-center gap-2">
              <Switch
                checked={keepPitch.value && !keepPitch.mixed}
                disabled={isVoice}
                onCheckedChange={(on) =>
                  update(on ? "Keep pitch" : "Tape speed", (c) => {
                    if (c.kind === "audio") c.keepPitch = on;
                  })
                }
              />
              <span className="text-[10px] text-muted-foreground">
                {isVoice
                  ? "Always on for speech"
                  : keepPitch.mixed
                    ? "Mixed"
                    : keepPitch.value
                      ? "Pitch held under speed"
                      : "Speed shifts pitch"}
              </span>
            </div>
          </PropRow>
          {/* AN OCTAVE EACH WAY, not two. The schema still allows ±24 and a
              document that holds one reads back fine — but a four-octave fader
              in 120px put every musically useful interval inside a 30px band,
              so a single pixel of travel was a semitone and nothing between the
              detents was reachable. ±12 is the coarse range every DAW offers,
              and it halves the travel-per-pixel, which is the whole complaint. */}
          <PropRow
            label="Pitch"
            keyControl={<KeyControl clip={clip} property="pitch" currentValue={() => pitch} label="Pitch" />}
          >
            <Pair>
              <Range
                value={pitch}
                format={pitchField.mixed ? () => "Mixed" : undefined}
                min={-12}
                max={12}
                step={0.5}
                // Unison, the fifths and the octaves — the intervals you
                // actually aim for. ⇧ releases the pull for everything between.
                ticks={[-12, -7, 0, 7, 12]}
                origin={0}
                defaultValue={0}
                hideValue
                aria-label="Pitch"
                onChange={(v) => commit("Change pitch", "pitch", v, "audio-pitch")}
              />
              <NumberInput
                value={pitch}
                mixed={pitchField.mixed}
                min={-24}
                max={24}
                step={0.5}
                precision={1}
                unit="st"
                title="Pitch shift in semitones (independent of speed) — type past ±12 for extremes"
                onChange={(v) => commit("Change pitch", "pitch", v, "audio-pitch")}
              />
            </Pair>
          </PropRow>
        </PanelSection>
      )}

      {isAsset && (
        <PanelSection title="Playback">
          {/* Speed is a CENTRED value — 1× is the thing you keep coming back to
              and half/double are the landmarks either side — so it gets the same
              fader-plus-number pair as Pitch rather than a lone number field you
              have to know the range of. Log scale, because 0.5× and 2× are the
              same musical distance from 1× and a linear track would spend three
              quarters of itself above unity. */}
          <PropRow label="Speed">
            <Pair>
              <Range
                value={speed.value}
                min={0.1}
                max={4}
                scale="log"
                ticks={[0.25, 0.5, 1, 2, 4]}
                origin={1}
                defaultValue={1}
                hideValue
                aria-label="Speed"
                onChange={(v) => setSpeed(v)}
              />
              <NumberInput
                value={speed.value}
                mixed={speed.mixed}
                min={0.1}
                max={4}
                step={0.05}
                precision={2}
                unit="×"
                title="Playback rate — 1× is the recorded speed"
                onChange={(v) => setSpeed(v)}
              />
            </Pair>
          </PropRow>
          <PropRow label="Loop">
            <Select
              value={selectValue(loop)}
              onValueChange={(loop) =>
                update("Change loop", (c) => {
                  if (c.kind === "audio") c.playback.loop = loop as LoopMode;
                })
              }
            >
              <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
                <SelectValue placeholder="Mixed" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(LOOP_LABELS) as LoopMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {LOOP_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropRow>
          {(loop.mixed || loop.value !== "none") && (
            <PropRow label="Cycle" hint="How much of the clip is one loop.">
              <div className="flex items-center gap-1">
                <NumberInput
                  value={cycle.value / 1000}
                  mixed={cycle.mixed}
                  min={0.02}
                  max={600}
                  step={0.1}
                  precision={2}
                  unit="s"
                  title="How much of the clip is ONE loop — drag the handle on the clip itself, or type here"
                  onChange={(v) =>
                    update("Loop cycle length", (c) => {
                      if (c.kind === "audio") c.playback.loopLengthMs = v * 1000;
                    }, "pb-cycle")
                  }
                />
                {peers.some((c) => c.playback.loopLengthMs != null) && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Reset to the natural source length"
                    title="Reset to the natural source length"
                    onClick={() =>
                      update("Reset loop cycle", (c) => {
                        if (c.kind === "audio") c.playback.loopLengthMs = null;
                      })
                    }
                  >
                    <RotateCcw />
                  </Button>
                )}
              </div>
            </PropRow>
          )}
          <PropRow label="Trim in">
            <NumberInput
              value={trimIn.value / 1000}
              mixed={trimIn.mixed}
              min={0}
              max={(asset?.durationMs ?? 600000) / 1000}
              step={0.1}
              precision={2}
              unit="s"
              onChange={(v) =>
                update("Trim in", (c) => void (c.kind === "audio" && (c.trimInMs = v * 1000)), "audio-trim")
              }
            />
          </PropRow>
        </PanelSection>
      )}

      {isPack && (
        <PanelSection title="Retrigger">
          <PropRow toggle label="Repeat">
            <div className="flex items-center gap-2">
              <Switch
                checked={repeat.value !== null && !repeat.mixed}
                onCheckedChange={(on) =>
                  update(on ? "Enable repeat" : "Disable repeat", (c) => {
                    if (c.kind === "audio") c.repeatEveryMs = on ? 250 : null;
                  })
                }
              />
              {repeat.value !== null && (
                <NumberInput
                  value={repeat.value}
                  mixed={repeat.mixed}
                  min={30}
                  max={5000}
                  precision={0}
                  unit="ms"
                  onChange={(v) =>
                    update("Repeat interval", (c) => void (c.kind === "audio" && (c.repeatEveryMs = v)), "audio-rep")
                  }
                />
              )}
            </div>
          </PropRow>
        </PanelSection>
      )}
    </>
  );
}

function FadeRow({
  label,
  durationMs,
  mixed,
  curve,
  maxMs,
  onDuration,
  onCurve,
}: {
  label: string;
  durationMs: number;
  mixed: boolean;
  curve: Easing;
  maxMs: number;
  onDuration: (ms: number, mergeKey?: string) => void;
  onCurve: (easing: Easing) => void;
}) {
  return (
    <PropRow label={label}>
      <div className="flex items-center gap-1.5">
        <NumberInput
          value={durationMs / 1000}
          mixed={mixed}
          min={0}
          max={maxMs / 1000}
          step={0.05}
          precision={2}
          unit="s"
          className="w-16"
          onChange={(v) => onDuration(Math.min(maxMs, Math.max(0, v * 1000)), `fade-${label}`)}
        />
        {durationMs > 0 && !mixed && (
          <div className="min-w-0 flex-1">
            <EasingPicker value={curve} onChange={onCurve} />
          </div>
        )}
      </div>
    </PropRow>
  );
}

