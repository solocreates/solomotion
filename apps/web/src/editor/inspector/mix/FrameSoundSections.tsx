"use client";

import * as React from "react";
import { Headphones, Plus, Volume2, VolumeX } from "lucide-react";
import { createSoundBus, type Frame, type FrameSoundMix } from "@solomotion/core";
import { Range } from "@/components/ui/range";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { useDoc, useDocStore } from "../../state/document-context";
import { useSession } from "../../state/session";
import { useLoudnessVersion } from "../../audio/loudness-cache";
import { IconToggle, IconTrack, PanelSection, PropRow } from "../controls";
import { BusDot } from "./CategoryPicker";
import { useBusMembers, useBusUpdater } from "./use-mix";

/** Write a frame's mix master in one undo step. */
function useMixUpdater(frameId: string) {
  const store = useDocStore();
  return React.useCallback(
    (label: string, fn: (mix: FrameSoundMix) => void, mergeKey?: string) =>
      store.update(
        label,
        (d) => {
          const f = d.frames.find((x) => x.id === frameId);
          if (f) fn(f.soundMix);
        },
        mergeKey ? { mergeKey: `${mergeKey}-${frameId}` } : undefined,
      ),
    [store, frameId],
  );
}

/**
 * A COMP'S SOUND — the mix master: the smart leveler, the master fader and
 * limiter, and every category with its fader. One component, two doors: the
 * frame's Sound tab and the mixer's settings. It governs the comp whenever it
 * is the one being played or exported, its whole tree at any depth.
 */
export function FrameSoundSections({ frame }: { frame: Frame }) {
  return (
    <>
      <LevelerSection frame={frame} />
      <MasterSection frame={frame} />
      <CategoriesSection />
    </>
  );
}

export function LevelerSection({ frame }: { frame: Frame }) {
  const update = useMixUpdater(frame.id);
  const lv = frame.soundMix.leveler;
  const measuring = useLoudnessVersion((s) => s.queued);
  const set = (label: string, fn: (l: FrameSoundMix["leveler"]) => void, key?: string) => update(label, (m) => fn(m.leveler), key);

  return (
    <PanelSection
      id="frame-leveler"
      title="Leveler"
      hint="Keeps every sound where its kind should sit, and nothing too loud. Measures each sound once, in the background."
      summary={lv.enabled ? `${Math.round(lv.strength * 100)}%` : "Off"}
      actions={
        <Switch
          checked={lv.enabled}
          onCheckedChange={(on) => set(on ? "Leveler on" : "Leveler off", (l) => void (l.enabled = on))}
          aria-label="Leveler"
        />
      }
    >
      <PropRow label="Level">
        <IconTrack
          items={[
            { id: "category", label: "Each category to its own target", icon: <span className="text-[11px]">By category</span> },
            { id: "all", label: "Everything to one target", icon: <span className="text-[11px]">All</span> },
          ]}
          value={lv.mode}
          onPick={(mode) => set("Leveler mode", (l) => void (l.mode = mode))}
        />
      </PropRow>
      <PropRow label="Strength">
        <Range
          value={Math.round(lv.strength * 100)}
          min={0}
          max={100}
          step={1}
          precision={0}
          unit="%"
          defaultValue={80}
          disabled={!lv.enabled}
          onChange={(v) => set("Leveler strength", (l) => void (l.strength = v / 100), "lv-strength")}
        />
      </PropRow>
      <PropRow toggle label="Tame loud sounds">
        <Switch checked={lv.tameLoud} onCheckedChange={(on) => set("Tame loud sounds", (l) => void (l.tameLoud = on))} disabled={!lv.enabled} />
      </PropRow>
      <PropRow toggle label="Lift quiet sounds" hint="Off by default — lifting a quiet take lifts its noise too.">
        <Switch checked={lv.liftQuiet} onCheckedChange={(on) => set("Lift quiet sounds", (l) => void (l.liftQuiet = on))} disabled={!lv.enabled} />
      </PropRow>
      <PropRow toggle label="Even out speech" hint="A slow dialogue leveler on speech categories: loud words come down, the take stays natural.">
        <Switch checked={lv.evenSpeech} onCheckedChange={(on) => set("Even out speech", (l) => void (l.evenSpeech = on))} disabled={!lv.enabled} />
      </PropRow>
      {lv.enabled && measuring > 0 && (
        <p className="px-1 text-[11px] text-muted-foreground">Measuring {measuring} {measuring === 1 ? "sound" : "sounds"}…</p>
      )}
    </PanelSection>
  );
}

function MasterSection({ frame }: { frame: Frame }) {
  const update = useMixUpdater(frame.id);
  const mix = frame.soundMix;
  return (
    <PanelSection id="frame-master" title="Master" summary={`${Math.round(mix.volume * 100)}%`}>
      <PropRow label="Level">
        <Range
          value={Math.round(mix.volume * 100)}
          min={0}
          max={400}
          step={1}
          precision={0}
          unit="%"
          defaultValue={100}
          ticks={[0, 100, 200]}
          onChange={(v) => update("Master level", (m) => void (m.volume = Math.max(0, Math.min(4, v / 100))), "master-vol")}
        />
      </PropRow>
      <PropRow toggle label="Limiter" hint="Nothing leaves the mix louder than the ceiling — the last guard for your ears.">
        <Switch checked={mix.limiter.enabled} onCheckedChange={(on) => update(on ? "Limiter on" : "Limiter off", (m) => void (m.limiter.enabled = on))} />
      </PropRow>
      {mix.limiter.enabled && (
        <PropRow label="Ceiling">
          <NumberInput
            value={mix.limiter.ceilingDb}
            min={-12}
            max={0}
            step={0.5}
            precision={1}
            unit="dB"
            onChange={(v) => update("Limiter ceiling", (m) => void (m.limiter.ceilingDb = Math.max(-12, Math.min(0, v))), "ceiling")}
          />
        </PropRow>
      )}
    </PanelSection>
  );
}

export function CategoriesSection() {
  const doc = useDoc();
  const store = useDocStore();
  const members = useBusMembers();
  const updateBus = useBusUpdater();
  return (
    <PanelSection id="frame-categories" title="Categories" count={doc.soundBuses.length}>
      <ul className="-mx-1 space-y-px">
        {doc.soundBuses.map((bus) => (
          <li key={bus.id} className="group flex h-7 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-accent">
            <BusDot color={bus.color} />
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-xs"
              onClick={() => useSession.getState().inspectSoundBus(bus.id)}
            >
              {bus.name}
            </button>
            <span className="font-mono text-[10px] text-muted-foreground">{members.get(bus.id)?.length ?? 0}</span>
            <IconToggle label={bus.solo ? "Unsolo" : "Solo"} pressed={bus.solo} onClick={() => updateBus(bus.id, bus.solo ? "Unsolo category" : "Solo category", (b) => void (b.solo = !b.solo))}>
              <Headphones />
            </IconToggle>
            <IconToggle label={bus.muted ? "Unmute" : "Mute"} pressed={bus.muted} onClick={() => updateBus(bus.id, bus.muted ? "Unmute category" : "Mute category", (b) => void (b.muted = !b.muted))}>
              {bus.muted ? <VolumeX /> : <Volume2 />}
            </IconToggle>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          let id = "";
          store.update("New sound category", (d) => void (id = createSoundBus(d, { name: `Category ${d.soundBuses.filter((b) => !b.builtIn).length + 1}` })));
          if (id) useSession.getState().inspectSoundBus(id);
        }}
        className="mt-1 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/70 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
      >
        <Plus className="size-3" />
        New category
      </button>
    </PanelSection>
  );
}
