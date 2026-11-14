"use client";

import * as React from "react";
import {
  BEHAVIOR,
  addBehavior,
  behaviorDef,
  behaviorValue,
  drivesSet,
  expressionById,
  locateClip,
  parseFxToken,
  poseSetLiveSource,
  voiceClipsIn,
  updateBehavior,
  type MotionDocument,
  pickKey,
  type PickFilter,
  type Behavior,
  type BehaviorStep,
  type Clip,
  type EffectFieldDef,
  type EffectFieldOption,
  type GroupClip,
} from "@solomotion/core";
import { Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { EffectMenuItem } from "../inspector/effect-add-menu";
import { EffectStackSection } from "../inspector/effect-stack/EffectStackSection";
import type { EffectStackHost } from "../inspector/effect-stack/host";
import { useStackFan } from "../inspector/effect-stack/use-stack-fan";
import { ValueField } from "../inspector/value-field";
import { useDoc, useDocStore } from "../state/document-context";
import { usePerform } from "../perform/state";
import { behaviorIcon } from "./behavior-style";
import { MouthMap } from "./MouthMap";
import { MachineStates } from "../machines/MachineStates";
import { ObjectField } from "../pick/ObjectField";
import { VoicePicker } from "../speech/VoicePicker";

/**
 * BEHAVIORS — the Character tab's stack of what a character does on its own
 * (ADR-characters-3). The `behavior` domain of the one effect registry, so it
 * is the Effects panel's own section with another host: cards you drag to
 * reorder (later wins where two speak), mute, duplicate, key and delete; the
 * floating editor; presets and looks; ⌘K-style search to add one. A new card
 * is tailored to the character (its Eyes, its Closed and Half poses, its head
 * bone) by core's `addBehavior`.
 */

export function BehaviorsSection({ character }: { character: GroupClip }) {
  const host = useBehaviorHost(character);
  return (
    <>
      <EffectStackSection host={host} />
      <LegacyDrivers character={character} />
    </>
  );
}

function useBehaviorHost(character: GroupClip): EffectStackHost<Behavior> {
  const store = useDocStore();
  const doc = useDoc();
  const fan = useStackFan<Behavior>({
    clips: [character],
    registry: BEHAVIOR,
    read: (c) => (c.kind === "group" ? (c.behaviors ?? []) : []),
    write: (c, list) => {
      if (c.kind === "group") c.behaviors = list.length ? list : undefined;
    },
  });
  const items: EffectMenuItem[] = BEHAVIOR.types.map((def) => ({
    type: def.type,
    label: def.label,
    blurb: def.blurb,
    keywords: def.tags,
    category: def.category,
    icon: behaviorIcon(def.type),
  }));
  return {
    registry: BEHAVIOR,
    domain: "behavior",
    icon: behaviorIcon,
    key: character.id,
    clip: character,
    canKey: true,
    effects: fan.effects,
    shared: fan.shared,
    palette: { items, heading: "Behaviors" },
    kinds: ["group"],
    update: fan.update,
    commit: fan.commit,
    setToggle: fan.setToggle,
    add: (type) => {
      let id: string | null = null;
      store.update(`Add ${behaviorDef(type)?.label ?? type}`, (d) => void (id = addBehavior(d, character.id, type)?.id ?? null));
      return id;
    },
    refOptions: (b, field) => refOptions(doc, character, b, field),
    customBody: (b) => (b.type === "cycle" ? <CycleBody character={character} behavior={b} /> : undefined),
    refField: (_b, field, value, set) => refPicker(character, field, value, set),
    bodyExtra: (b) =>
      b.type === "lipSync" ? <MouthMap character={character} behavior={b} /> : b.type === "machine" ? <MachineStates character={character} behavior={b} /> : undefined,
    transfer: { domain: "behaviors", clipIds: [character.id] },
    title: "Behaviors",
    sectionId: "character-behaviors",
    addLabel: "Add behavior",
    noun: "behavior",
    headerExtra: (
      <Button variant="ghost" size="sm" title="Play it live — keys and pointer record (⇧P)" onClick={() => usePerform.getState().enter()}>
        <Play /> Perform
      </Button>
    ),
  };
}

// ── What a reference field can pick ─────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : "");

function descendants(doc: MotionDocument, groupId: string): Clip[] {
  const out: Clip[] = [];
  const walk = (id: string) => {
    for (const t of doc.tracks) {
      if (t.groupId !== id) continue;
      for (const c of t.clips) {
        out.push(c);
        if (c.kind === "group") walk(c.id);
      }
    }
  };
  walk(groupId);
  return out;
}

const BONE_CHANNELS: Array<[string, string]> = [
  ["rotation", "turn"],
  ["scale", "stretch"],
  ["scaleY", "width"],
  ["x", "x"],
  ["y", "y"],
];
const LAYER_CHANNELS: Array<[string, string]> = [
  ["rotation", "Rotation"],
  ["scaleY", "Scale Y"],
  ["scale", "Scale"],
  ["x", "X"],
  ["y", "Y"],
  ["opacity", "Opacity"],
];

export function refOptions(doc: MotionDocument, character: GroupClip, b: Behavior, field: EffectFieldDef): EffectFieldOption[] {
  const g = (locateClip(doc, character.id)?.clip as GroupClip | undefined) ?? character;
  switch (field.ref) {
    case "poseSet":
      return [{ value: "", label: "None", hint: "It drives no part until you pick one." }, ...(g.poses ?? []).map((s) => ({ value: s.id, label: s.name, hint: `${s.poses.length} poses` }))];
    case "pose": {
      const setId = str(behaviorValue(b, field.refOf ?? "set"));
      const set = (g.poses ?? []).find((s) => s.id === setId || s.name === setId);
      const none = field.key === "closed" ? [] : [{ value: "", label: field.key === "rest" ? "Rest" : "None" }];
      return [...none, ...(set?.poses ?? []).map((p) => ({ value: p.name, label: p.name }))];
    }
    case "bone":
      return [{ value: "", label: "None" }, ...(g.rig?.bones ?? []).map((x) => ({ value: x.name, label: x.name }))];
    case "voice":
      return [{ value: "", label: "Every voice — whichever plays" }, ...voiceClipsIn(doc, g.frameId).map((c) => ({ value: c.name, label: c.name }))];
    case "part":
      return [{ value: "", label: `${g.name} (the character)` }, ...descendants(doc, g.id).filter((c) => c.kind !== "audio").map((c) => ({ value: c.id, label: c.name }))];
    case "channel": {
      const layer = str(behaviorValue(b, field.refOf ?? "layer"));
      const def = behaviorDef(b.type);
      const auto = { value: "", label: def?.defaultChannel ? "Automatic — the right bone" : "Automatic" };
      if (layer && layer !== g.id) return [auto, ...LAYER_CHANNELS.map(([v, l]) => ({ value: v, label: l }))];
      return [
        auto,
        ...(g.rig?.bones ?? []).flatMap((x) => BONE_CHANNELS.map(([ch, l]) => ({ value: `bone.${x.id}.${ch}`, label: `${x.name} · ${l}` }))),
        ...LAYER_CHANNELS.map(([v, l]) => ({ value: v, label: `${g.name} · ${l}` })),
      ];
    }
    case "machine": {
      // A machine is referenced by id or by name (agents write names); the
      // option carries whichever the card holds, so it reads as chosen.
      const cur = str(behaviorValue(b, field.key));
      return [{ value: "", label: "None" }, ...(doc.frames.find((f) => f.id === g.frameId)?.machines ?? []).map((m) => ({ value: m.name === cur ? m.name : m.id, label: m.name }))];
    }
    default:
      return [];
  }
}

/**
 * The reference fields that are really "pick a layer" — a voice, a part — get
 * the project picker (search, facets) instead of a flat list. Everything else
 * keeps its list: a pose or a bone is a short, closed set.
 */
function refPicker(character: GroupClip, field: EffectFieldDef, value: string, set: (v: string) => void): React.ReactNode | undefined {
  if (field.ref === "voice") return <VoicePicker frameId={character.frameId} value={value} onChange={set} />;
  if (field.ref === "part") return <PartPicker character={character} value={value} onChange={set} />;
  return undefined;
}

function PartPicker({ character, value, onChange }: { character: GroupClip; value: string; onChange: (id: string) => void }) {
  const filter = React.useMemo<PickFilter>(() => ({ kinds: ["layer"], within: character.id, tags: ["visual"] }), [character.id]);
  return (
    <ObjectField
      filter={filter}
      noun="part"
      value={value ? pickKey("clip", value) : null}
      onChange={(c) => onChange(c.id)}
      extras={[{ value: "", label: character.name, hint: "The whole character" }]}
      extraValue={value ? null : ""}
      onExtra={onChange}
      missing="Missing part"
    />
  );
}

// ── A cycle's steps ─────────────────────────────────────────────────────────

/** Radix reserves "" — the "pick a pose" placeholder rides a sentinel. */
const NONE = "__none__";

function CycleBody({ character, behavior }: { character: GroupClip; behavior: Behavior }) {
  const store = useDocStore();
  const doc = useDoc();
  const g = (locateClip(doc, character.id)?.clip as GroupClip | undefined) ?? character;
  const def = behaviorDef("cycle")!;
  const setId = str(behaviorValue(behavior, "set"));
  const set = (g.poses ?? []).find((s) => s.id === setId);
  const steps: BehaviorStep[] = behavior.steps ?? [];
  const write = (next: BehaviorStep[], label: string) => store.update(label, (d) => void updateBehavior(d, character.id, behavior.id, { steps: next }), { mergeKey: `cycle-${behavior.id}-${label}` });
  const field = (key: string) => def.fields.find((f) => f.key === key)!;
  const row = (key: string) => {
    const f = field(key);
    return (
      <ValueField
        key={key}
        clip={g}
        canKey
        path={BEHAVIOR.path(behavior.id, key)}
        kind={f.kind}
        label={f.label}
        hint={f.hint}
        options={f.kind === "ref" ? refOptions(doc, g, behavior, f) : f.options}
        base={behaviorValue(behavior, key) ?? ""}
        min={f.min}
        max={f.max}
        step={f.step}
        unit={f.unit}
        bipolar={f.bipolar}
        onChange={(v) => store.update(`Cycle ${f.label}`, (d) => void updateBehavior(d, character.id, behavior.id, { [key]: v as string | number }), { mergeKey: `cycle-${behavior.id}-${key}` })}
      />
    );
  };
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      {row("set")}
      {row("mode")}
      {row("speed")}
      {row("offset")}
      <div className="mt-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Steps</div>
      {steps.map((s, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-4 shrink-0 text-right text-2xs text-muted-foreground">{i + 1}</span>
          <Select value={s.pose || NONE} onValueChange={(v) => write(steps.map((x, j) => (j === i ? { ...x, pose: v === NONE ? "" : v } : x)), "Cycle step pose")}>
            <SelectTrigger className="h-7 min-w-0 flex-1 text-[12px]">
              <SelectValue placeholder="Pose" />
            </SelectTrigger>
            <SelectContent>
              {(set?.poses ?? []).map((p) => (
                <SelectItem key={p.id} value={p.name} className="text-[12px]">
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="w-24 shrink-0">
            <NumberInput value={s.ms} min={1} max={600000} step={10} unit="ms" onChange={(v) => write(steps.map((x, j) => (j === i ? { ...x, ms: Math.max(1, v) } : x)), "Cycle step length")} />
          </div>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" title="Remove this step" onClick={() => write(steps.filter((_, j) => j !== i), "Remove cycle step")}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        disabled={!set?.poses.length}
        onClick={() => write([...steps, { pose: set!.poses[steps.length % set!.poses.length]!.name, ms: 500 }], "Add cycle step")}
      >
        <Plus /> Add step
      </Button>
    </div>
  );
}

// ── Expressions still choosing a set (the escape hatch) ─────────────────────

function LegacyDrivers({ character }: { character: GroupClip }) {
  const doc = useDoc();
  const store = useDocStore();
  const g = (locateClip(doc, character.id)?.clip as GroupClip | undefined) ?? character;
  const rows = (g.poses ?? [])
    .map((set) => {
      const live = poseSetLiveSource(doc, g, set);
      const token = g.drivers?.[`pose.${set.id}`];
      if (!token) return null;
      const source = expressionById(doc, parseFxToken(token) ?? "")?.source ?? live ?? "an expression";
      const covered = (g.behaviors ?? []).some((b) => drivesSet(b, set, doc));
      return { set, source, covered };
    })
    .filter((r): r is NonNullable<typeof r> => !!r);
  if (!rows.length) return null;
  return (
    <div className="mx-3 mb-2 flex flex-col gap-1 rounded-md border border-dashed border-border/70 p-2 text-[12px]">
      <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Expressions</div>
      {rows.map((r) => (
        <div key={r.set.id} className="flex items-center gap-2">
          <span className="w-16 shrink-0 truncate text-foreground/80">{r.set.name}</span>
          <code className="min-w-0 flex-1 truncate text-2xs text-muted-foreground" title={r.source}>
            {r.source}
          </code>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-1.5 text-2xs"
            title="Stop this expression choosing the set"
            onClick={() =>
              store.update(`Remove ${r.set.name} expression`, (d) => {
                const c = locateClip(d, character.id)?.clip;
                if (c?.kind !== "group" || !c.drivers) return;
                const { [`pose.${r.set.id}`]: _gone, ...rest } = c.drivers;
                c.drivers = Object.keys(rest).length ? rest : undefined;
              })
            }
          >
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
}
