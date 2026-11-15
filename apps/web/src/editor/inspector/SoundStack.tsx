"use client";

import * as React from "react";
import {
  availableTriggers,
  locateClip,
  makeSoundLayer,
  SOUND_SCALES,
  SOUND_SET_PRESET_KIND,
  soundIntensityPath,
  type AnimationUnit,
  type Clip,
  type SoundLayer,
  type SoundClimb,
  type SoundNoteOrder,
  type SoundNotes,
  type SoundPhase,
  type SoundScale,
  type SoundTriggerKind,
  type SoundVoice,
  type VisualClip,
} from "@solomotion/core";
import {
  ArrowRightFromLine,
  ArrowRightToLine,
  ChevronRight,
  Play,
  Plus,
  Shuffle,
  Trash2,
  TriangleAlert,
  Zap,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Range } from "@/components/ui/range";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SoundField } from "../audio/SoundPicker";
import { soundEngine } from "../audio/sound-engine";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { commitProperty, useEffectiveValue } from "./animatable";
import { PresetPicker } from "./effect-editor/PresetPicker";
import { KeyControl } from "./keyframe-controls";
import { Accordion, AccordionItem, AccordionMeta, PropRow } from "./controls";
import { SoundKitFields } from "./SoundKitFields";
import { SoundVoiceFields } from "./SoundVoiceFields";
import { useClipUpdater } from "./use-clip-updater";

/**
 * THE SOUND TAB — the Animate tab, with ears.
 *
 * A sound does not stand on its own: it rides a MOMENT, and every moment a
 * clip has is already a named section one tab over — text animate in, layer
 * animate out, a transition. The panel used to make you say that yourself, in
 * the panel's own words: you pressed "Add sound", chose between "Per unit",
 * "Whole layer" and "Transition", and then read a chip to find out what you
 * had made. Three abstractions for a thing the Animate tab names in plain
 * language, and two panels about the same instants that looked nothing alike.
 *
 * So the trigger stops being a field and becomes the SECTION. The slots below
 * carry the same titles, the same icons and the same accordion the Animate tab
 * uses, in the same order, and a sound dropped into "Text animate in" rides
 * text-animate-in because that is the drawer you opened. Nothing about the
 * document changed — `SoundLayer.trigger.kind` and `.phase` are still the
 * stored fact, and `SOUND_SLOTS` is the one table that projects them — but the
 * vocabulary a person has to learn went from two sets to one.
 *
 * Which slots a clip can carry is still asked ONCE, of `availableTriggers` in
 * core, so a new trigger kind is a row in that table and nothing else.
 */

/** How a slot is spelled in the panel. One row per (trigger, phase). */
interface SoundSlot {
  id: string;
  kind: SoundTriggerKind;
  phase: SoundPhase;
  title: string;
  icon: React.ReactNode;
}

/**
 * THE SLOT TABLE — the panel's whole vocabulary, and deliberately identical to
 * the Animate tab's. Ordered glyphs-first, exactly as Animate orders them:
 * what the letters do, then what the layer does, then what the cut does.
 */
const SOUND_SLOTS: SoundSlot[] = [
  { id: "text-in", kind: "text", phase: "in", title: "Text animate in", icon: <ArrowRightToLine /> },
  { id: "text-out", kind: "text", phase: "out", title: "Text animate out", icon: <ArrowRightFromLine /> },
  { id: "layer-in", kind: "layer", phase: "in", title: "Layer animate in", icon: <ArrowRightToLine /> },
  { id: "layer-out", kind: "layer", phase: "out", title: "Layer animate out", icon: <ArrowRightFromLine /> },
  { id: "transition-in", kind: "transition", phase: "in", title: "Transition in", icon: <Shuffle /> },
  { id: "transition-out", kind: "transition", phase: "out", title: "Transition out", icon: <Shuffle /> },
  { id: "hit", kind: "hit", phase: "in", title: "Collisions", icon: <Zap /> },
];

const UNIT_LABEL: Record<AnimationUnit, string> = {
  letter: "Per letter",
  word: "Per word",
  line: "Per line",
};

export function SoundStackSection({ clip }: { clip: Clip }) {
  const doc = useDoc();
  const update = useClipUpdater(clip.id);

  const track = locateClip(doc, clip.id)?.track ?? null;
  const offered = new Set(availableTriggers(clip, track));
  const slots = SOUND_SLOTS.filter((s) => offered.has(s.kind));

  const rowsIn = (slot: SoundSlot) =>
    clip.sounds.filter((s) => s.trigger.kind === slot.kind && s.phase === slot.phase);

  const add = (slot: SoundSlot) =>
    update("Add sound", (c) => {
      c.sounds.push(makeSoundLayer(slot.kind === "hit" ? { kind: "hit", minSpeed: 60 } : ({ kind: slot.kind } as SoundLayer["trigger"]), slot.phase));
    });

  const patch = (id: string, next: Partial<SoundLayer>, label: string, mergeKey?: string) =>
    update(
      label,
      (c) => {
        const row = c.sounds.find((s) => s.id === id);
        if (row) Object.assign(row, next);
      },
      mergeKey ? `${mergeKey}-${id}` : undefined,
    );

  /** The climax dial is animatable: a key at the playhead when keyed, else the base. */
  const setIntensity = (id: string, v: number) =>
    update(
      "Change intensity",
      (c) => commitProperty(c, soundIntensityPath(id), v, useSession.getState().playheadMs),
      `snd-int-${id}`,
    );

  const remove = (id: string) =>
    update("Remove sound", (c) => {
      c.sounds = c.sounds.filter((s) => s.id !== id);
    });

  /** The animate grain lives on the animation spec — ONE place — so editing it
   *  from a sound row writes straight there rather than shadowing it. */
  const setUnit = (p: SoundPhase, unit: AnimationUnit) =>
    update("Change animate unit", (c) => {
      if (c.kind !== "text") return;
      const spec = c.animations[p];
      if (spec) spec.unit = unit;
    });

  // Open the first slot that HAS something, else the first one offered. You
  // come back to this panel to change a sound far more often than to add the
  // first one, so the drawer that opens should be the one with sound in it.
  const firstFilled = slots.find((s) => rowsIn(s).length > 0) ?? slots[0];

  return (
    <Accordion defaultOpen={firstFilled?.id}>
      {slots.map((slot) => {
        const rows = rowsIn(slot);
        const missing = missingEventFor(clip, slot);
        return (
          <AccordionItem
            key={slot.id}
            id={slot.id}
            title={slot.title}
            icon={slot.icon}
            meta={<SlotMeta rows={rows} missing={missing} />}
          >
            {/* A slot whose moment does not exist is silent, and silently so —
                the one state worth flagging, and it belongs on the SLOT now
                rather than on each sound in it: it is one fact about the
                drawer, not N facts about its contents. */}
            {missing && rows.length > 0 && (
              <div className="flex items-center gap-1.5 rounded-md bg-warning/10 px-2 py-1 text-[10.5px] text-warning">
                <TriangleAlert className="size-3 shrink-0" />
                {missing}
              </div>
            )}

            {/* The grain belongs to the SLOT, not to each sound riding it —
                they all fire on the same letters. It sat on every row before,
                which is the same control repeated once per sound. */}
            {slot.kind === "text" && clip.kind === "text" && clip.animations[slot.phase] && (
              <PropRow
                label="Fires"
                hint="The animate grain these sounds fire on. Shared with the Animate tab — there is one grain, and changing it here changes the animation too."
              >
                <Select
                  value={clip.animations[slot.phase]!.unit}
                  onValueChange={(u) => setUnit(slot.phase, u as AnimationUnit)}
                >
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(UNIT_LABEL) as AnimationUnit[]).map((u) => (
                      <SelectItem key={u} value={u}>
                        {UNIT_LABEL[u]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </PropRow>
            )}

            {rows.map((row) => (
              <SoundRow
                key={row.id}
                clip={clip}
                row={row}
                onIntensity={(v) => setIntensity(row.id, v)}
                onPatch={(next, label, mergeKey) => patch(row.id, next, label, mergeKey)}
                onRemove={() => remove(row.id)}
              />
            ))}

            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-full justify-start gap-1.5 px-1.5 text-[11px] text-muted-foreground"
              onClick={() => add(slot)}
            >
              <Plus className="size-3" />
              Add sound
            </Button>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}

/**
 * The collapsed summary: how many sounds, and whether any of them can be
 * heard. A slot with three muted sounds and a slot with none are different
 * facts, and the speaker glyph is the one that says which — the same glyph the
 * In/Out tabs used to carry, kept because it was the good part of them.
 */
function SlotMeta({ rows, missing }: { rows: SoundLayer[]; missing: string | null }) {
  if (rows.length === 0) return <AccordionMeta muted>None</AccordionMeta>;
  const audible = rows.some((r) => r.enabled) && !missing;
  const Icon = audible ? Volume2 : VolumeX;
  return (
    <AccordionMeta>
      <Icon className={cn("size-3", audible ? "text-primary" : "opacity-50")} />
      {rows.length}
    </AccordionMeta>
  );
}

/**
 * One sound in a slot.
 *
 * Collapsed it answers the question you ask while scanning — what does this
 * sound like — with the waveform, and nothing else, because the slot above it
 * has already answered what it is attached to. Everything that used to be
 * repeated per row (the trigger chip, the grain) moved up to the slot, so a
 * row is now just a sound.
 */
function SoundRow({
  clip,
  row,
  onPatch,
  onIntensity,
  onRemove,
}: {
  clip: Clip;
  row: SoundLayer;
  onPatch: (next: Partial<SoundLayer>, label: string, mergeKey?: string) => void;
  onIntensity: (v: number) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = React.useState(false);

  const header = (
    <div className="flex items-center gap-1 p-1">
      <button
        type="button"
        aria-label={open ? "Collapse" : "Expand"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      <SoundField value={row} onChange={(p, label) => onPatch(p as Partial<SoundLayer>, label)} />
      <Switch
        checked={row.enabled}
        aria-label={row.enabled ? "Mute this sound" : "Unmute this sound"}
        onCheckedChange={(on) => onPatch({ enabled: on }, on ? "Enable sound" : "Disable sound")}
        className="shrink-0 scale-75"
      />
    </div>
  );

  return (
    <div className={cn("rounded-md border bg-card/40", !row.enabled && "opacity-55")}>
      {/* Right-click reaches the sound itself — the effect stack's affordance,
          on the thing that most looks like an effect stack entry. */}
      <ContextMenu>
        <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={() => setOpen(true)}>Edit timing</ContextMenuItem>
          <ContextMenuItem
            onClick={() => onPatch({ enabled: !row.enabled }, row.enabled ? "Disable sound" : "Enable sound")}
          >
            {row.enabled ? "Mute" : "Unmute"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onRemove} className="text-destructive focus:text-destructive">
            <Trash2 /> Remove
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {open && (
        <div className="space-y-1 border-t px-1.5 py-1.5">
          <SoundSetFields clip={clip} row={row} onPatch={onPatch} onIntensity={onIntensity} />
          <SoundVoiceFields
            value={row}
            scope="snd"
            onChange={(patch, label, mergeKey) => onPatch(patch, label, mergeKey)}
            placement={{
              anchor: row.anchor,
              offsetMs: row.offsetMs,
              onChange: (patch, label) => onPatch(patch, label),
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-full justify-start gap-1.5 px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2 className="size-3" />
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

const SCALE_LABEL: Record<SoundScale, string> = {
  pentatonic: "Pentatonic",
  minorPentatonic: "Minor pentatonic",
  major: "Major",
  minor: "Minor",
  wholeTone: "Whole tone",
  fifths: "Fifths",
};

const ORDER_LABEL: Record<SoundNoteOrder, string> = {
  rise: "Climbs",
  bounce: "Up and back",
  random: "Random",
  body: "Each its own",
  strength: "By force",
};

/** A scale picked from "One tone" starts as a climbing octave and a half. */
const FIRST_NOTES: Omit<SoundNotes, "scale"> = { order: "rise", span: 8 };

/**
 * A voice as a SET — its notes and its climax (v103). The set picker is the
 * preset library's (kind `sound-set`), so the built-in sets and the ones you
 * save sit in one list, and the trigger names the set this voice still is.
 * The ▶ plays the voice as it fires: across its notes, building when it builds.
 */
function SoundSetFields({
  clip,
  row,
  onPatch,
  onIntensity,
}: {
  clip: Clip;
  row: SoundLayer;
  onPatch: (next: Partial<SoundLayer>, label: string, mergeKey?: string) => void;
  onIntensity: (v: number) => void;
}) {
  const path = soundIntensityPath(row.id);
  const intensity = useEffectiveValue(clip, path, row.intensity);
  const keyed = clip.keyframes.some((k) => k.property === path && k.keys.length > 1);
  const rise = row.trigger.kind === "hit" ? row.trigger.rise : null;
  const builds = rise === "hits" || keyed;

  return (
    <>
      <PropRow label="Set">
        <div className="flex min-w-0 items-center justify-end gap-1">
          <PresetPicker
            kind={SOUND_SET_PRESET_KIND}
            capture={() => ({ pack: row.pack, custom: row.custom, notes: row.notes, kit: row.kit, climb: row.climb })}
            onApply={(data) => onPatch(data as Partial<SoundLayer>, "Use sound set")}
            label="Sets"
            defaultName="My set"
            saveLabel="Save as a set"
            saveTitle="Save sound set"
            saveDescription="This sound and its notes, on any layer."
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label="Preview"
                onClick={() => soundEngine.previewPhrase(row, builds ? "build" : intensity)}
              >
                <Play className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{builds ? "Preview the build" : "Preview"}</TooltipContent>
          </Tooltip>
        </div>
      </PropRow>

      <PropRow label="Notes" hint="Play a scale instead of one tone. Pitch transposes it.">
        <Select
          value={row.notes?.scale ?? "none"}
          onValueChange={(v) =>
            onPatch(
              { notes: v === "none" ? null : { ...FIRST_NOTES, ...row.notes, scale: v as SoundScale } },
              "Change notes",
            )
          }
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">One tone</SelectItem>
            {(Object.keys(SOUND_SCALES) as SoundScale[]).map((k) => (
              <SelectItem key={k} value={k}>
                {SCALE_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PropRow>
      {row.notes && (
        <>
          <PropRow label="Order" hint="Climbs and Up and back walk the scale across every body sharing this sound.">
            <Select
              value={row.notes.order}
              onValueChange={(v) => onPatch({ notes: { ...row.notes!, order: v as SoundNoteOrder } }, "Change note order")}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ORDER_LABEL) as SoundNoteOrder[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {ORDER_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropRow>
          <PropRow wide>
            <Range
              label="Range"
              value={row.notes.span}
              min={1}
              max={24}
              step={1}
              precision={0}
              format={(v) => `${Math.round(v)} notes`}
              defaultValue={FIRST_NOTES.span}
              onChange={(v) => onPatch({ notes: { ...row.notes!, span: Math.round(v) } }, "Change note range", "snd-span")}
            />
          </PropRow>
        </>
      )}

      <SoundKitFields row={row} onPatch={onPatch} />

      <PropRow label="Climbs" hint="How the climax is felt. In weight keeps the register: notes ring shorter, a low weight joins, hits spread where they land.">
        <Select value={row.climb} onValueChange={(v) => onPatch({ climb: v as SoundClimb }, "Change how the climax climbs")}>
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pitch">Up in pitch</SelectItem>
            <SelectItem value="weight">In weight</SelectItem>
          </SelectContent>
        </Select>
      </PropRow>
      <PropRow
        label="Climax"
        hint={
          row.climb === "weight"
            ? "Louder and heavier, notes damped shorter; a low weight joins past halfway. Key it to build."
            : "Higher notes, brighter, louder; a heavy low hit joins past halfway. Key it to build."
        }
        keyControl={<KeyControl clip={clip} property={path} label="Intensity" currentValue={() => intensity} />}
      >
        <Range
          value={Math.round(intensity * 100)}
          min={0}
          max={100}
          step={1}
          precision={0}
          unit="%"
          defaultValue={0}
          onChange={(v) => onIntensity(v / 100)}
        />
      </PropRow>
      {rise && row.trigger.kind === "hit" && (
        <PropRow label="Builds" hint="With the hits: climbs as the scene gets busier, peaking at its busiest. Keys still set the floor.">
          <Select
            value={rise}
            onValueChange={(v) =>
              row.trigger.kind === "hit" &&
              onPatch({ trigger: { ...row.trigger, rise: v as "keys" | "hits" } }, "Change how the climax builds")
            }
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="keys">With keys</SelectItem>
              <SelectItem value="hits">With the hits</SelectItem>
            </SelectContent>
          </Select>
        </PropRow>
      )}
    </>
  );
}

/**
 * Why a slot cannot make a sound right now, or null when it can. A voice rides
 * an EVENT, so a slot whose event does not exist is inert — and the only
 * honest thing a panel can do is say which event is missing.
 */
function missingEventFor(clip: Clip, slot: SoundSlot): string | null {
  const visual = clip as VisualClip;
  switch (slot.kind) {
    case "text":
      if (clip.kind !== "text") return null;
      return clip.animations[slot.phase] ? null : `No text animate ${slot.phase} to ride`;
    case "layer":
      return (slot.phase === "in" ? visual.animIn : visual.animOut)
        ? null
        : `No layer animate ${slot.phase} to ride`;
    case "transition":
      return null; // resolved against the live seam; absence is legible on the timeline
    case "hit":
      return null; // offered only to bodies
  }
}

export type { SoundVoice };
