"use client";

import * as React from "react";
import type { SoundAnchor, SoundVoice } from "@solomotion/core";
import { NumberInput } from "@/components/ui/number-input";
import { Range } from "@/components/ui/range";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SoundField } from "../audio/SoundPicker";
import { PropRow } from "./controls";

/**
 * THE voice editor — what a sound sounds like and where its hit lands, with no
 * opinion about what it is attached to.
 *
 * It came out of the sound stack's row when the text-look browser needed the
 * same six controls for a voice that has no clip, no phase and no trigger yet.
 * The alternative was a second pitch slider and a second anchor menu that would
 * have started identical and drifted the first time either was tuned — which is
 * this codebase's most reliable defect, and the reason `SoundField` was already
 * factored out one level below this.
 *
 * Split at the honest seam: `SoundVoice` is the timbre, `anchor`/`offsetMs` are
 * the placement. A caller that has nowhere to place a hit omits `placement` and
 * gets only the timbre — the rows do not appear, rather than appearing inert.
 */

export const SOUND_ANCHOR_LABEL: Record<SoundAnchor, string> = {
  start: "Start",
  peak: "Impact",
  end: "Settle",
};

export interface VoicePlacement {
  anchor: SoundAnchor;
  offsetMs: number;
  onChange: (patch: { anchor?: SoundAnchor; offsetMs?: number }, label: string) => void;
}

export function SoundVoiceFields({
  value,
  onChange,
  placement,
  /** Disambiguates the drag-merge keys when two of these are on screen. */
  scope = "voice",
}: {
  value: SoundVoice;
  onChange: (patch: Partial<SoundVoice>, label: string, mergeKey?: string) => void;
  placement?: VoicePlacement;
  scope?: string;
}) {
  return (
    <>
      {/* Level, pitch and humanisation are judged BY EAR against playback, so
          they are bars you sweep, not boxes you type a number into and then
          have to listen again to check. */}
      <PropRow wide>
        <Range
          label="Volume"
          value={Math.round(value.volume * 100)}
          min={0}
          max={100}
          step={1}
          precision={0}
          unit="%"
          defaultValue={100}
          onChange={(v) => onChange({ volume: v / 100 }, "Change volume", `${scope}-vol`)}
        />
      </PropRow>
      <PropRow wide>
        <Range
          label="Pitch"
          value={value.pitch}
          min={0.5}
          max={2}
          step={0.01}
          precision={2}
          unit="×"
          defaultValue={1}
          onChange={(v) => onChange({ pitch: v }, "Change pitch", `${scope}-pitch`)}
        />
      </PropRow>
      <PropRow wide>
        <Range
          label="Random"
          value={Math.round(value.randomness * 100)}
          min={0}
          max={100}
          step={1}
          precision={0}
          unit="%"
          defaultValue={0}
          format={(v) => (v === 0 ? "Exact" : `${Math.round(v)}%`)}
          onChange={(v) => onChange({ randomness: v / 100 }, "Change randomness", `${scope}-rand`)}
        />
      </PropRow>

      {placement && (
        <>
          <PropRow
            label="Lands on"
            hint="Where in the animation the hit falls. Impact tracks the easing curve's fastest moment."
          >
            <Select
              value={placement.anchor}
              onValueChange={(a) => placement.onChange({ anchor: a as SoundAnchor }, "Change sound anchor")}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SOUND_ANCHOR_LABEL) as SoundAnchor[]).map((a) => (
                  <SelectItem key={a} value={a}>
                    {SOUND_ANCHOR_LABEL[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropRow>
          <PropRow label="Offset" hint="Negative leads the motion.">
            <NumberInput
              value={placement.offsetMs}
              min={-2000}
              max={2000}
              step={5}
              precision={0}
              unit="ms"
              onChange={(v) => placement.onChange({ offsetMs: v }, "Change sound offset")}
            />
          </PropRow>
        </>
      )}
    </>
  );
}

/** The picker row on its own — the one control every voice starts with. */
export function SoundVoicePicker({
  value,
  onChange,
}: {
  value: SoundVoice;
  onChange: (patch: Partial<SoundVoice>, label: string) => void;
}) {
  return <SoundField value={value} onChange={(p, label) => onChange(p as Partial<SoundVoice>, label)} />;
}
