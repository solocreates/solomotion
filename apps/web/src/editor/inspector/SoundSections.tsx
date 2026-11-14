"use client";

import * as React from "react";
import type { AudioClip, Clip } from "@solomotion/core";
import { Mic, Volume2, VolumeX } from "lucide-react";
import { Range } from "@/components/ui/range";
import { useDoc } from "../state/document-context";
import { AudioInspector } from "./AudioInspector";
import { Accordion, AccordionItem, AccordionMeta, IconToggle, Note, PanelSection, PropRow } from "./controls";
import { KeyControl } from "./keyframe-controls";
import { collectSoundLeaves } from "./sound-targets";
import { useField } from "./animatable";
import { mergeReads } from "./merge";
import { SelectionScope, anyClip, usePeers } from "./selection-scope";
import { useClipUpdater } from "./use-clip-updater";

/**
 * The SOUND tab's spine, in the same three slots the Design tab uses — because
 * it had three different shapes before, one per kind, and that is exactly the
 * ladder the Design tab stopped being.
 *
 *   head   OUTPUT — the fader every layer has, whatever it is
 *   kind   what makes THIS layer's sound what it is (a clip's source, a text
 *          layer's stack of fired sounds, a comp's contained voices)
 *   tail   the effect chain, then timing and export
 *
 * The visible win is that a TEXT layer finally has the first and third. It
 * fires sounds through its stack, those sounds are gated by `audioMix` in the
 * engine (`cues.ts`), and yet the panel showed neither the fader that gates
 * them nor the voices underneath — so a caption's Sound tab was one empty box.
 */

/**
 * OUTPUT — the universal fader. Every clip carries `audioMix`, and every sound
 * it makes or contains passes through it, so this is the one control that is
 * honest on every kind. Mixed-aware, so it works on a selection too.
 */
export function SoundOutputSection({ clip }: { clip: Clip }) {
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, anyClip);
  const vol = useField(peers, "audioMix.volume", (c) => c.audioMix.volume);
  const muted = mergeReads(peers, (c) => c.audioMix.muted);
  const isMuted = muted.value && !muted.mixed;

  return (
    <PanelSection
      id="sound-output"
      title="Output"
      collapsible={false}
      hint="Everything this layer makes or contains passes through here."
      actions={
        <IconToggle
          label={isMuted ? "Unmute" : "Mute"}
          pressed={isMuted}
          onClick={() => update(isMuted ? "Unmute" : "Mute", (c) => void (c.audioMix.muted = !isMuted))}
        >
          {isMuted ? <VolumeX /> : <Volume2 />}
        </IconToggle>
      }
    >
      <PropRow
        label="Level"
        keyControl={<KeyControl clip={clip} property="audioMix.volume" currentValue={() => vol.value} />}
      >
        <Range
          value={Math.round(vol.value * 100)}
          min={0}
          max={400}
          step={1}
          precision={0}
          unit="%"
          defaultValue={100}
          // Unity is the value you return to, and 200/400 are the ones you
          // overshoot to on purpose — checkpoints, not a lattice.
          ticks={[0, 100, 200]}
          disabled={isMuted}
          format={vol.mixed ? () => "Mixed" : undefined}
          onChange={(v) =>
            update("Volume", (c) => void (c.audioMix.volume = Math.max(0, Math.min(4, v / 100))), "mix-vol")
          }
        />
      </PropRow>
    </PanelSection>
  );
}

/**
 * VOICES — the actual audio underneath this layer, however deep. A nested comp
 * three levels down still lists the clip that makes the noise, because what you
 * want to reach is the voice, not the container you happen to have selected.
 *
 * Each row's body is the FULL `AudioInspector` bound to the real leaf, so a
 * voice inside a comp is edited by the same panel a plain audio clip is —
 * reused, never rebuilt.
 */
export function SoundVoicesSection({ clips }: { clips: Clip[] }) {
  const doc = useDoc();
  const leaves = collectSoundLeaves(doc, clips);
  const audioLeaves = leaves.map((l) => l.clip);
  const buried = leaves.some((l) => l.path !== "");

  if (audioLeaves.length === 0) return null;

  // The selection IS its voices (audio clips): their panel is this tab's
  // subject, flush — merged across all of them by the spine's scope, so two
  // clips show the one panel with "Mixed" where they differ.
  if (clips.every((c) => c.kind === "audio")) return <AudioInspector clip={audioLeaves[0]!} />;

  return (
    <PanelSection
      id="sound-voices"
      title={buried ? "Voices inside" : "Voices"}
      count={audioLeaves.length}
      hint="Every clip that actually makes a sound under this layer, however deep."
    >
      {audioLeaves.length === 1 ? (
        <AudioInspector clip={audioLeaves[0]!} />
      ) : (
        <Accordion defaultOpen="all-voices">
          {/* The SAME panel, scoped to every voice: one edit, all of them. */}
          <AccordionItem id="all-voices" title={`All ${audioLeaves.length} voices`} icon={<Mic />}>
            <SelectionScope clips={audioLeaves}>
              <AudioInspector clip={audioLeaves[0]!} />
            </SelectionScope>
          </AccordionItem>
          {leaves.map(({ clip, path }) => (
            <AccordionItem
              key={clip.id}
              id={clip.id}
              title={clip.name}
              icon={<Mic />}
              meta={path ? <AccordionMeta>{path}</AccordionMeta> : undefined}
            >
              <AudioInspector clip={clip} />
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </PanelSection>
  );
}

/** Nothing under here makes a sound — said once, where the voices would be. */
export function SoundEmptyNote({ clips }: { clips: Clip[] }) {
  const doc = useDoc();
  if (collectSoundLeaves(doc, clips).length > 0) return null;
  return (
    <div className="px-3 py-2">
      <Note>
        {clips.length > 1
          ? "Nothing here makes a sound yet."
          : "Nothing here makes a sound yet. Add one above, or drop audio inside this layer."}
      </Note>
    </div>
  );
}

export type { AudioClip };
