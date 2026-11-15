"use client";

import * as React from "react";
import { AudioLines, ChevronLeft, Headphones, Layers, RotateCcw, Trash2, Volume2, VolumeX } from "lucide-react";
import {
  busTargetLufs,
  CHARACTER_TARGET_LUFS,
  createAudioClip,
  deleteSoundBus,
  locateClip,
  setClipProperty,
  type AudioClip,
  type SoundCharacter,
} from "@solomotion/core";
import { Range } from "@/components/ui/range";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDoc, useDocStore } from "../../state/document-context";
import { useSession } from "../../state/session";
import { AudioEffectsSection } from "../audio-effects/AudioEffectsSection";
import { ClipHostProvider, type ClipHost } from "../clip-host";
import { IconAction, IconToggle, Note, PanelSection, PropRow } from "../controls";
import { BusDot } from "./CategoryPicker";
import { DuckingEditor } from "./DuckingEditor";
import { CHARACTER_LABELS, goToLayer, useBusMembers, useBusUpdater } from "./use-mix";

/**
 * A SOUND CATEGORY as the inspector's subject — the "whole family" view one
 * click from any of its members: its fader, what the leveler aims it at, its
 * own effect chain, what it ducks under, and everyone in it. Clicking a member
 * selects that layer, which hands the panel back to it.
 *
 * The chain is the SAME effect section a clip shows, bound to a shadow clip
 * through a `ClipHost`: the cards, palette, editor window and presets are one
 * implementation, and a category simply has no clock to key on.
 */
export function CategoryPanel({ busId }: { busId: string }) {
  const doc = useDoc();
  const store = useDocStore();
  const updateBus = useBusUpdater();
  const members = useBusMembers().get(busId) ?? [];
  const bus = doc.soundBuses.find((b) => b.id === busId)!;

  const shadowId = `bus:${busId}`;
  const shadow = React.useMemo<AudioClip>(
    () => ({ ...createAudioClip({ frameId: "", startMs: 0, durationMs: 1 }), id: shadowId, name: bus.name, audioEffects: bus.audioEffects }),
    [shadowId, bus.name, bus.audioEffects],
  );
  const host = React.useMemo<ClipHost>(
    () => ({
      id: shadowId,
      timeless: true,
      write: (label, fn, mergeKey) =>
        store.update(
          label,
          (d) => {
            const b = d.soundBuses.find((x) => x.id === busId);
            if (!b) return;
            const c: AudioClip = { ...createAudioClip({ frameId: "", startMs: 0, durationMs: 1 }), id: shadowId, audioEffects: b.audioEffects, keyframes: [] };
            fn(c, d);
            // No clock: a key written in record mode IS the value.
            for (const t of c.keyframes) {
              const last = t.keys[t.keys.length - 1];
              if (last) setClipProperty(c, t.property, last.value);
            }
            b.audioEffects = c.audioEffects;
          },
          mergeKey ? { mergeKey: `${mergeKey}-${shadowId}` } : undefined,
        ),
    }),
    [store, busId, shadowId],
  );

  const muted = bus.muted;
  return (
    <>
      <div className="flex h-10 items-center gap-1 border-b px-2">
        <IconAction label="Back" onClick={() => useSession.getState().inspectSoundBus(null)}>
          <ChevronLeft />
        </IconAction>
        <BusDot color={bus.color} className="size-2.5" />
        <input
          value={bus.name}
          onChange={(e) => updateBus(busId, "Rename category", (b) => void (b.name = e.target.value), "rename-bus")}
          className="min-w-0 flex-1 truncate rounded bg-transparent px-1 text-title outline-none transition-colors hover:bg-hover focus:bg-input"
          spellCheck={false}
          aria-label="Category name"
        />
        <input
          type="color"
          value={bus.color}
          onChange={(e) => updateBus(busId, "Category colour", (b) => void (b.color = e.target.value), "bus-color")}
          className="size-5 cursor-pointer rounded border-0 bg-transparent p-0"
          aria-label="Category colour"
        />
        {!bus.builtIn && (
          <IconAction
            label="Delete category"
            onClick={() => {
              store.update("Delete category", (d) => void deleteSoundBus(d, busId));
              useSession.getState().inspectSoundBus(null);
            }}
          >
            <Trash2 />
          </IconAction>
        )}
      </div>

      <PanelSection
        id="bus-fader"
        title="Category"
        collapsible={false}
        actions={
          <>
            <IconToggle
              label={bus.solo ? "Unsolo" : "Solo — hear only this"}
              pressed={bus.solo}
              onClick={() => updateBus(busId, bus.solo ? "Unsolo category" : "Solo category", (b) => void (b.solo = !b.solo))}
            >
              <Headphones />
            </IconToggle>
            <IconToggle
              label={muted ? "Unmute" : "Mute"}
              pressed={muted}
              onClick={() => updateBus(busId, muted ? "Unmute category" : "Mute category", (b) => void (b.muted = !b.muted))}
            >
              {muted ? <VolumeX /> : <Volume2 />}
            </IconToggle>
          </>
        }
      >
        <PropRow label="Level">
          <Range
            value={Math.round(bus.volume * 100)}
            min={0}
            max={400}
            step={1}
            precision={0}
            unit="%"
            defaultValue={100}
            ticks={[0, 100, 200]}
            disabled={muted}
            onChange={(v) => updateBus(busId, "Category level", (b) => void (b.volume = Math.max(0, Math.min(4, v / 100))), "bus-vol")}
          />
        </PropRow>
        <PropRow label="Kind" hint="How the leveler hears it: speech and music by their average, effects by their loudest moment.">
          <Select
            value={bus.character}
            onValueChange={(v) => updateBus(busId, "Category kind", (b) => void (b.character = v as SoundCharacter))}
          >
            <SelectTrigger className="h-(--control-h) min-w-0 flex-1 text-body">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CHARACTER_LABELS) as SoundCharacter[]).map((c) => (
                <SelectItem key={c} value={c}>
                  {CHARACTER_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PropRow>
        <PropRow
          label="Target"
          hint="The loudness the leveler brings this category to."
          keyControl={
            // A moved target resets from the gutter, like any value that has a default.
            bus.targetLufs !== null && bus.targetLufs !== CHARACTER_TARGET_LUFS[bus.character] ? (
              <IconAction label="Reset to the kind's target" onClick={() => updateBus(busId, "Reset category target", (b) => void (b.targetLufs = null))}>
                <RotateCcw />
              </IconAction>
            ) : undefined
          }
        >
          <NumberInput
            value={busTargetLufs(bus)}
            min={-40}
            max={-6}
            step={0.5}
            precision={1}
            unit="LUFS"
            onChange={(v) => updateBus(busId, "Category target", (b) => void (b.targetLufs = Math.max(-40, Math.min(-6, v))), "bus-target")}
          />
        </PropRow>
      </PanelSection>

      <ClipHostProvider host={host}>
        <AudioEffectsSection clip={shadow} />
      </ClipHostProvider>

      <PanelSection id="bus-ducking" title="Ducking" count={bus.ducking.length} defaultOpen={bus.ducking.length > 0}>
        <DuckingEditor
          rules={bus.ducking}
          owner={{ kind: "bus", id: busId }}
          onChange={(label, next, mergeKey) => updateBus(busId, label, (b) => void (b.ducking = next), mergeKey)}
        />
      </PanelSection>

      <PanelSection id="bus-members" title="Layers" count={members.length} defaultOpen={members.length > 0 && members.length <= 24}>
        {members.length === 0 ? (
          <Note>Nothing routes here yet.</Note>
        ) : (
          <ul className="-mx-1 space-y-px">
            {members.map((id) => {
              const clip = locateClip(doc, id)?.clip;
              if (!clip) return null;
              const frame = doc.frames.find((f) => f.id === clip.frameId);
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => goToLayer(doc, id)}
                    className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    {clip.kind === "nested" ? (
                      <Layers className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <AudioLines className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{clip.name}</span>
                    {frame && <span className="max-w-[45%] truncate text-meta text-fg-faint">{frame.name}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>
    </>
  );
}
