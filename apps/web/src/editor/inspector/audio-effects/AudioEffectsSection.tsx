"use client";

import * as React from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  AFX,
  AUDIO_EFFECT_TYPES,
  applyPresetPatch,
  audioEffectPresets,
  effectPresetKind,
  mergeEqPresetBands,
  presetPatchFrom,
  type AudioEffect,
  type AudioEffectType,
  type Clip,
  type EffectFieldDef,
  type KeyframeValue,
  type Preset,
  ENABLED_FIELD,
} from "@solomotion/core";
import {
  Activity,
  Binary,
  Bot,
  Filter,
  Flame,
  Gauge,
  Headphones,
  Orbit,
  Radio,
  Repeat2,
  SlidersHorizontal,
  Trash2,
  Waves,
  type LucideIcon,
} from "lucide-react";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { PanelSection } from "./../controls";
import { EffectAddMenu, type EffectMenuItem } from "./../effect-add-menu";
import { EffectCardShell } from "./../effect-card";
import { EffectEditorWindow, type EffectEditorSpec } from "./../effect-editor/EffectEditorWindow";
import { useEffectEditor } from "./../effect-editor/store";
import { GroupKeyButton } from "./../keyframe-controls";
import { commitProperty, useEffectiveValue } from "./../animatable";
import { useSession } from "../../state/session";
import { useClipUpdater } from "./../use-clip-updater";
import { AudioEffectPanel } from "./AudioEffectPanel";

/**
 * THE AUDIO EFFECT STACK — the sound half of the one effect system.
 *
 * Structurally identical to the layer stack, and deliberately so: same card
 * shell, same searchable palette, same floating editor, same preset library,
 * same keyframe controls. A user who has used one already knows this one, and
 * we did not write a second of anything to get that.
 *
 * What differs is only what genuinely differs. The stack lives on
 * `clip.audioEffects` (which rides `clipBase`, so a video's dialogue and a
 * nested comp's mix both carry it), fields keyframe at `afx.<id>.<field>`, and
 * two cards host bespoke bodies where a row of numbers would be a worse control
 * than a picture: the EQ's draggable response curve, and the reverb's room.
 *
 * ORDER IS THE SIGNAL CHAIN. Dragging a card past another is not cosmetic —
 * compressor-then-reverb and reverb-then-compressor are different sounds.
 */

const AFX_ICON: Record<AudioEffectType, LucideIcon> = {
  eq: SlidersHorizontal,
  reverb: Radio,
  echo: Repeat2,
  compressor: Gauge,
  saturator: Flame,
  filter: Filter,
  chorus: Waves,
  phaser: Orbit,
  tremolo: Activity,
  ringMod: Bot,
  bitcrush: Binary,
  stereo: Headphones,
};

/** Every kind of clip that can carry a chain — the chain is universal. */
export function clipCarriesAudioEffects(clip: Clip): boolean {
  return clip.kind === "audio" || clip.kind === "video" || clip.kind === "nested";
}

export function AudioEffectsSection({ clip, flush }: { clip: Clip; flush?: boolean }) {
  const update = useClipUpdater(clip.id);
  const effects = clip.audioEffects;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [flashId, setFlashId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(t);
  }, [flashId]);

  const addEffect = (type: AudioEffectType) => {
    const created = AFX.create(type);
    update(`Add ${type}`, (c) => void c.audioEffects.push(created));
    setFlashId(created.id);
    useEffectEditor.getState().open(created.id, type, AFX.editorHint(type));
  };

  const removeEffect = (id: string) =>
    update("Remove audio effect", (c) => {
      c.audioEffects = c.audioEffects.filter((e) => e.id !== id);
      // Every track this card owned, including its nested EQ band paths.
      c.keyframes = c.keyframes.filter((t) => !t.property.startsWith(`afx.${id}.`));
    });

  // Bypass is keyframable: `commitProperty` keys it at the playhead when the
  // switch is animated or record is armed, and writes the flag otherwise — so
  // an EQ can drop out for a bar with no bespoke automation concept.
  const setEnabled = (id: string, enabled: boolean) =>
    update(enabled ? "Enable audio effect" : "Bypass audio effect", (c) =>
      commitProperty(c, AFX.path(id, ENABLED_FIELD), enabled, useSession.getState().playheadMs),
    );

  const setToggle = (id: string, key: string, value: boolean, label: string) =>
    update(label, (c) => {
      const e = c.audioEffects.find((x) => x.id === id);
      if (e) (e as unknown as Record<string, unknown>)[key] = value;
    });

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = effects.findIndex((e) => e.id === active.id);
    const to = effects.findIndex((e) => e.id === over.id);
    if (from < 0 || to < 0) return;
    update("Reorder audio effects", (c) => void (c.audioEffects = arrayMove(c.audioEffects, from, to)));
  };

  /** One field write — keyframe-aware, so record mode captures every knob. */
  const commitField = (effect: AudioEffect, field: EffectFieldDef, v: KeyframeValue, label: string) =>
    update(
      label,
      (c) => commitProperty(c, AFX.path(effect.id, field.key), v, useSession.getState().playheadMs),
      `afx-${effect.id}-${field.key}`,
    );

  /**
   * Apply a preset patch to one card. KEYFRAME-SAFE: a preset moves the BASE
   * values the keys animate around and never touches a track. EQ needs one
   * extra step — its bands carry ids that keyframes address, so the incoming
   * curve inherits the existing ids instead of orphaning the automation.
   */
  const applyPreset = (effect: AudioEffect, data: unknown, label: string) =>
    update(label, (c) => {
      const e = c.audioEffects.find((x) => x.id === effect.id);
      if (!e) return;
      const patch = { ...(data as Record<string, unknown>) };
      if (e.type === "eq" && Array.isArray(patch.bands)) {
        patch.bands = mergeEqPresetBands(e.bands, patch.bands as Parameters<typeof mergeEqPresetBands>[1]);
      }
      Object.assign(e, patch);
    });

  const addMenu = (compact?: boolean) => (
    <AudioAddMenu present={effects} onAdd={addEffect} compact={compact} />
  );

  return (
    <PanelSection
      title="Sound effects"
      count={effects.length}
      transfer={{ domains: ["sound"], clipId: clip.id }}
      defaultOpen
      forceOpen={flashId}
      flush={flush}
      actions={flush ? undefined : addMenu(true)}
    >
      {effects.length === 0 ? (
        <AudioEffectGallery onAdd={addEffect} extra={addMenu()} />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={effects.map((e) => e.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {effects.map((effect) => (
                <AudioEffectCard
                  key={effect.id}
                  clip={clip}
                  effect={effect}
                  sortable={effects.length > 1}
                  flash={flashId === effect.id}
                  onRemove={() => removeEffect(effect.id)}
                  onEnable={(v) => setEnabled(effect.id, v)}
                  onToggle={(k, v, l) => setToggle(effect.id, k, v, l)}
                  onCommitField={commitField}
                  onApplyPreset={(data, label) => applyPreset(effect, data, label)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      {flush && effects.length > 0 && <div className="pt-2">{addMenu()}</div>}
    </PanelSection>
  );
}

function AudioEffectCard({
  clip,
  effect,
  sortable,
  flash,
  onRemove,
  onEnable,
  onToggle,
  onCommitField,
  onApplyPreset,
}: {
  clip: Clip;
  effect: AudioEffect;
  sortable: boolean;
  flash: boolean;
  onRemove: () => void;
  onEnable: (v: boolean) => void;
  onToggle: (key: string, value: boolean, label: string) => void;
  onCommitField: (e: AudioEffect, f: EffectFieldDef, v: KeyframeValue, label: string) => void;
  onApplyPreset: (data: unknown, label: string) => void;
}) {
  const def = AFX.def(effect.type);
  const fields = AFX.fields(effect);
  const Icon = AFX_ICON[effect.type];
  const openId = useEffectEditor((s) => s.openId);
  const open = openId === effect.id;
  // Bypass is animatable, so the card reads its switch at the playhead.
  const enablePath = AFX.path(effect.id, ENABLED_FIELD);
  const enabledNow = useEffectiveValue(clip, enablePath, effect.enabled);
  const label = def?.label ?? effect.type;

  const groupProps = fields.map((f) => ({
    property: AFX.path(effect.id, f.key),
    currentValue: () => fieldValue(effect, f),
  }));
  const keyControl = <GroupKeyButton clip={clip} properties={groupProps} />;

  // Factory defaults drive double-click-to-reset, derived from the registry so
  // a changed default is honoured here rather than duplicated.
  const defaults = React.useMemo(() => {
    const fresh = AFX.create(effect.type) as unknown as Record<string, KeyframeValue>;
    return Object.fromEntries(fields.map((f) => [f.key, fresh[f.key]!])) as Record<string, KeyframeValue>;
  }, [effect.type, fields]);

  // The EQ writes whole paths — its band values nest one level deeper than the
  // registry's flat field paths — so it needs the raw path writer.
  const update = useClipUpdater(clip.id);
  const commitPath = (labelText: string, path: string, v: KeyframeValue, mergeKey?: string) =>
    update(labelText, (c) => commitProperty(c, path, v, useSession.getState().playheadMs), mergeKey);

  // EVERY sound card gets the same two-column body: a picture of what the
  // effect is doing, and the knobs that shape it. Nothing renders bare rows.
  const customBody = (
    <AudioEffectPanel
      clip={clip}
      effect={effect}
      onCommit={onCommitField}
      onToggle={onToggle}
      onCommitPath={commitPath}
    />
  );

  const spec: EffectEditorSpec = {
    effectId: effect.id,
    clip,
    title: label,
    icon: Icon,
    enabled: enabledNow,
    canKey: true,
    presetKind: effectPresetKind(effect.type),
    domain: "audio",
    fields,
    groups: def?.groups,
    toggles: def?.toggles,
    value: (key) => fieldValue(effect, fields.find((f) => f.key === key) ?? { key, label: key, kind: "number" }),
    defaults,
    toggleValue: (key) => Boolean((effect as unknown as Record<string, unknown>)[key]),
    pathFor: (key) => AFX.path(effect.id, key),
    onCommit: (field, v) => onCommitField(effect, field, v, `${label} ${field.label}`),
    onToggle,
    onEnable,
    onRemove,
    onReset: () => onApplyPreset(presetPatchFrom(AFX.create(effect.type)), `Reset ${label}`),
    capture: () => presetPatchFrom(effect),
    onApplyPreset: (data, preset) => onApplyPreset(data, `Apply ${preset.name}`),
    presetName: label,
    headerKey: keyControl,
    customBody,
    // The sound panel is a LAYOUT, not a list: it wants the window's height so
    // its two columns can each be 100% of it and scroll on their own. See
    // `EffectEditorSpec.bodyFill`.
    bodyFill: true,
  };

  return (
    <>
      <EffectCardShell
        id={effect.id}
        label={label}
        icon={Icon}
        enabled={enabledNow}
        enableKey={{ clip, property: enablePath }}
        sortable={sortable}
        flash={flash}
        open={open}
        keyControl={keyControl}
        // The card animates every field its group diamond keys, plus its own eye.
        keyTargets={{ clip, targets: [...groupProps, { property: enablePath, currentValue: () => enabledNow }] }}
        onOpen={() => useEffectEditor.getState().toggle(effect.id, effect.type, AFX.editorHint(effect.type))}
        onEnable={onEnable}
        onRemove={onRemove}
        contextItems={
          <>
            <ContextMenuItem onClick={() => useEffectEditor.getState().open(effect.id, effect.type, AFX.editorHint(effect.type))}>
              <SlidersHorizontal /> Effect settings…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onRemove} className="text-destructive focus:text-destructive">
              <Trash2 /> Delete effect
            </ContextMenuItem>
          </>
        }
      />
      {open && <EffectEditorWindow spec={spec} />}
    </>
  );
}

/**
 * The sound palette — the SAME searchable window the layer stack uses, fed the
 * audio registry. Built-in presets are search synonyms, never rows: five
 * effects plus twenty-seven presets would read like thirty-two effects.
 */
function AudioAddMenu({
  present,
  onAdd,
  compact,
}: {
  present: readonly AudioEffect[];
  onAdd: (type: AudioEffectType) => void;
  compact?: boolean;
}) {
  const items: EffectMenuItem[] = AUDIO_EFFECT_TYPES.map((def) => ({
    type: def.type,
    label: def.label,
    category: def.category,
    icon: AFX_ICON[def.type],
    blurb: def.blurb,
    keywords: [...(def.tags ?? []), ...audioEffectPresets(def.type).map((p) => p.label)],
    badge: present.some((e) => e.type === def.type) ? "added" : undefined,
  }));
  return (
    <EffectAddMenu
      items={items}
      onAdd={(t) => onAdd(t as AudioEffectType)}
      compact={compact}
      domain="audio"
      addLabel="Search sound effects…"
    />
  );
}

/**
 * The empty state IS the menu.
 *
 * A dashed "Add sound effect" button is a door with nothing written on it: the
 * app has an equaliser, a convolution reverb and a compressor, and a user who
 * never clicks that button never learns any of them exist. Five effects fit on
 * screen, so we show five effects — named, iconed, one click from being on the
 * clip. Search stays underneath for when the list is longer than the panel.
 *
 * This is the same reason the layer palette promotes a "For this layer"
 * section: the fastest way to make a feature discoverable is to stop hiding it
 * behind a verb.
 */
function AudioEffectGallery({ onAdd, extra }: { onAdd: (t: AudioEffectType) => void; extra: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        {AUDIO_EFFECT_TYPES.map((def) => {
          const Icon = AFX_ICON[def.type];
          return (
            <button
              key={def.type}
              type="button"
              title={def.blurb}
              onClick={() => onAdd(def.type)}
              className={cn(
                "group flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/25 px-2 py-2 text-left transition-all",
                "hover:border-primary/50 hover:bg-primary/5 active:scale-[0.98]",
              )}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/60 text-primary/80 transition-colors group-hover:border-primary/40 group-hover:text-primary [&_svg]:size-3.5">
                <Icon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px] font-medium leading-tight text-foreground/90">
                  {def.label}
                </span>
                <span className="block truncate text-[9.5px] leading-tight text-muted-foreground/75">
                  {SHORT[def.type]}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {extra}
    </div>
  );
}

/** Two or three words — the grid tile has no room for the full blurb. */
const SHORT: Record<AudioEffectType, string> = {
  eq: "Shape the tone",
  reverb: "Put it in a room",
  echo: "Fading repeats",
  compressor: "Even out the level",
  saturator: "Warmth and drive",
  filter: "Sweep and muffle",
  chorus: "Drift, double, flange",
  phaser: "Swirling notches",
  tremolo: "Pulse or pan",
  ringMod: "Robot voice",
  bitcrush: "Lo-fi, 8-bit",
  stereo: "Width and pan",
};

function fieldValue(effect: AudioEffect, field: EffectFieldDef): KeyframeValue {
  const raw = (effect as unknown as Record<string, unknown>)[field.key];
  if (field.kind === "color") return typeof raw === "string" ? raw : "#ffffff";
  if (field.kind === "select") return typeof raw === "string" ? raw : "";
  return typeof raw === "number" ? raw : 0;
}

export { applyPresetPatch, type Preset };
