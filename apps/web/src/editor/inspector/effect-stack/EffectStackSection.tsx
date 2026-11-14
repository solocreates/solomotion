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
  ENABLED_FIELD,
  EFFECT_GROUP_TYPE,
  applyLookAsGroup,
  createId,
  groupEffects,
  isEffectGroup,
  lookDataFromGroup,
  normalizeEffectGroups,
  ungroupEffects,
  type EffectGroupCard,
  type GroupableEffect,
  type LayerEffect,
  type VisualClip,
  applyPresetPatch,
  isReferenceField,
  effectsFromStackPreset,
  presetPatchFrom,
  stackPresetFrom,
  type BaseEffect,
  type EffectFieldDef,
  type KeyframeValue,
  type Preset,
} from "@solomotion/core";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  BookmarkPlus,
  ChevronRight,
  Clipboard,
  Copy,
  CopyPlus,
  Layers,
  Scissors,
  SlidersHorizontal,
  Trash2,
  Ungroup,
  Group as GroupIcon,
  Replace,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { CommandGroup } from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/lib/toast";
import { copyProperties, pastePropertiesDomain } from "../../state/clip-actions";
import { useDocStore } from "../../state/document-context";
import { useInspectorNav } from "../../state/inspector-nav";
import { useListSelection } from "../../state/use-list-selection";
import { eventKey } from "../../state/shortcut-registry";
import { useEffectiveValue } from "../animatable";
import { PanelSection } from "../controls";
import { EffectAddMenu, EffectPaletteItem, PRESET_FALLBACK_ICON } from "../effect-add-menu";
import { EffectCardShell } from "../effect-card";
import { EffectEditorWindow, type EffectEditorSpec } from "../effect-editor/EffectEditorWindow";
import { PresetPicker } from "../effect-editor/PresetPicker";
import { useEffectEditor } from "../effect-editor/store";
import { usePresets } from "../effect-editor/use-presets";
import { saveToLibrary } from "../../presets/SaveToLibraryDialog";
import { GroupKeyButton } from "../keyframe-controls";
import type { EffectStackHost } from "./host";
import { useDoc } from "../../state/document-context";
import { useParkedPlayhead } from "../../state/session";
import { LookGalleryPopover, LookRow, type LookTarget } from "./LookGallery";

/**
 * THE effect stack — one section for every registry, every list, every
 * selection size.
 *
 * It renders whatever its host hands it: cards from the registry (drag-sorted,
 * every kind repeatable, applied top to bottom), each opening the ONE floating
 * editor; an add palette; a LOOKS picker for the whole stack; marquee and
 * ⇧/⌘ selection with ⌘C/⌘X/⌘V/⌫; and, across a multi-selection, only the
 * cards every target shares — with "Mixed" on the fields they hold
 * differently. The layer stack and the per-glyph text stack are two hosts of
 * this, not two of these; that is what makes them behave identically, and
 * what made the old text panel (its own inputs, no keyframes, no presets, a
 * Sparkles icon for "on") a bug rather than a design.
 *
 * `flush` renders it as a TAB BODY — no section header, the looks picker as a
 * strip above the cards and the add palette as the last card. Same component,
 * same writes, two homes.
 */
export function EffectStackSection<E extends BaseEffect>({
  host,
  flush,
  defaultOpen = true,
  looks: lookRowWanted = true,
}: {
  host: EffectStackHost<E>;
  flush?: boolean;
  defaultOpen?: boolean;
  /** Show the Look row (layer stacks only). A frame shows its own, inline. */
  looks?: boolean;
}) {
  const store = useDocStore();
  const doc = useDoc();
  const playheadMs = useParkedPlayhead();
  const { registry, effects, shared } = host;
  // LOOKS (D13): only a registry with a group arm has them. A look is
  // COLLAPSED by default — one card that says what the layer wears.
  const hasGroups = !!registry.def(EFFECT_GROUP_TYPE);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const asGroup = (e: E) => e as unknown as GroupableEffect;
  const groupOf = (e: E) => asGroup(e).group ?? null;
  // What the panel SHOWS: the entries the whole selection carries. For one
  // target that is the whole list; for many it is the index-parallel overlap.
  // A collapsed look hides its members.
  const allShown = shared.entries.map((e) => e.primary);
  const shown = allShown.filter((e) => {
    const g = groupOf(e);
    return !g || isEffectGroup(asGroup(e)) || expanded.has(g) || !allShown.some((h) => h.id === g);
  });
  const mixedOf = React.useMemo(() => new Map(shared.entries.map((e) => [e.primary.id, e.mixed])), [shared]);

  // ── Multi-select ───────────────────────────────────────────────────────────
  // The media library's gesture vocabulary, mounted on the stack: marquee-drag
  // empty space, ⇧-range, ⌘-toggle, click empty to deselect. A verb fired on a
  // card acts on the whole selection when that card is part of it — the rule
  // every file manager uses, and the reason right-clicking one of five selected
  // cards does not silently drop four.
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const sel = useListSelection(shown.map((e) => e.id), listRef);

  const removeIds = (ids: string[]) => {
    const doomed = new Set(ids);
    // Deleting a look deletes what it holds — the card IS the look.
    for (const e of effects) if (groupOf(e) && doomed.has(groupOf(e)!)) doomed.add(e.id);
    ids = [...doomed];
    if (!effects.some((e) => doomed.has(e.id))) return;
    host.update(ids.length > 1 ? `Remove ${ids.length} ${host.noun}s` : `Remove ${host.noun}`, (list) =>
      list.filter((e) => !doomed.has(e.id)),
    );
    sel.clear();
  };

  const copyIds = (ids: string[], cut = false) => {
    const t = host.transfer;
    if (!t) return;
    void copyProperties(store, host.clip.id, { [t.domain]: ids }, true, true).then((ok) => {
      if (!ok) return;
      const many = ids.length > 1 ? `${ids.length} ${host.noun}s` : cap(host.noun);
      if (cut) removeIds(ids);
      toast(`${many} ${cut ? "cut" : "copied"} — ⌘V pastes ${ids.length > 1 ? "them" : "it"} on any layer`);
    });
  };
  const copyAll = () => {
    const t = host.transfer;
    if (!t) return;
    void copyProperties(store, host.clip.id, { [t.domain]: true }).then(
      (ok) => ok && toast(`${cap(host.noun)}s copied — ⌘V pastes them on any layer`),
    );
  };
  const pasteHere = () => {
    const t = host.transfer;
    if (!t) return;
    void pastePropertiesDomain(store, t.clipIds, [t.domain]).then((what) =>
      toast(what ? `${cap(host.noun)}s pasted` : `No ${host.noun}s on the clipboard`),
    );
  };

  // Preset writes reuse the ONE library (built-in / this project / this device);
  // a card only ever hands it the identity-free patch.
  const presets = usePresets("");
  const saveOne = (effect: E) =>
    saveToLibrary({
      title: `Save ${host.noun} preset`,
      description: "Reuse this card on any layer — in this project, or in all of them.",
      defaultName: registry.def(effect.type)?.label ?? effect.type,
      onSave: (label, scope) => {
        presets.save(scope, label, presetPatchFrom(effect), { group: "Saved", chip: effectChip(host, effect) }, registry.presetKind(effect.type));
        toast(`Saved “${label}” — ${scope === "project" ? "in this project" : "for every project"}`);
      },
    });

  // A reveal aimed at a CARD (the stage's "Remove background" pill) scrolls it
  // into view, flashes it and opens its editor. The section half of the same
  // request is handled by `PanelSection` itself — this only knows about cards.
  const reveal = useInspectorNav((s) => s.reveal);
  const [flashId, setFlashId] = React.useState<string | null>(null);
  React.useEffect(() => {
    const entry = reveal.entry;
    if (!entry || !effects.some((e) => e.id === entry)) return;
    setFlashId(entry);
    const focused = effects.find((e) => e.id === entry);
    if (focused) useEffectEditor.getState().open(entry, editorKey(host, focused.type), registry.editorHint(focused.type));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal.seq]);
  React.useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(t);
  }, [flashId]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Add appends a FRESH card; the host mints one per sibling. The engine for a
  // family is a lazy chunk, and the moment someone picks a card is the moment
  // we know they want it — so `prepare` kicks the fetch off HERE, one tick
  // before the first frame that needs it, and is never awaited.
  const addEffect = (type: string) => {
    host.prepare?.(type);
    const own = host.add?.(type);
    if (own) return setFlashId(own);
    const created = registry.createFor(type as E["type"], host.kinds);
    host.update(`Add ${registry.def(type)?.label ?? type}`, (list) => [...list, created]);
    setFlashId(created.id);
  };

  /** A saved single-card preset becomes a fresh card of its own kind. */
  const addPreset = (preset: Preset) => {
    const type = registry.types.find((d) => registry.presetKind(d.type) === preset.kind)?.type;
    if (!type) return;
    host.prepare?.(type);
    const created = applyPresetPatch(registry.create(type), preset.data);
    host.update(`Add ${preset.name}`, (list) => [...list, created]);
    setFlashId(created.id);
  };

  /**
   * A LOOK replaces the whole stack — one undo step, fresh ids everywhere. A
   * look that plays on its own rate (Stop motion, `Preset.fps`) sets the
   * layer's rate in the same step; on a frame's effects that holds the frame.
   */
  const applyLook = (data: unknown, preset: Preset) => {
    const next = effectsFromStackPreset(registry, data);
    for (const e of next) host.prepare?.(e.type);
    const fps = preset.fps;
    host.update(`Apply ${preset.name}`, () => next, undefined, fps ? (c) => void (c.kind !== "audio" && (c.fps = fps)) : undefined);
  };

  // The eye writes like every other field of the card: `commit` puts a key at
  // the playhead when the switch is animated or record is armed, and the base
  // flag otherwise. That one substitution is what makes "this glow is off
  // until 00:04" possible — and it fans across the selection like the rest.
  const setEnabled = (effect: E, enabled: boolean) =>
    host.commit(effect, ENABLED_FIELD, enabled, enabled ? `Enable ${host.noun}` : `Disable ${host.noun}`);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = effects.findIndex((e) => e.id === active.id);
    const to = effects.findIndex((e) => e.id === over.id);
    if (from < 0 || to < 0) return;
    if (!hasGroups) {
      host.update(`Reorder ${host.noun}s`, (list) => arrayMove(list, from, to));
      return;
    }
    // MEMBERSHIP FOLLOWS THE CARD YOU DROP ON: onto a look's member, or onto
    // its header from above, a card joins that look; onto a loose card, or
    // onto a header from below, it is loose. A look's header carries its
    // members (normalize pulls them after it).
    const dragged = effects[from]!;
    const target = effects[to]!;
    let group: string | null = null;
    if (!isEffectGroup(asGroup(dragged))) {
      if (isEffectGroup(asGroup(target))) group = from < to ? target.id : null;
      else group = groupOf(target);
    }
    host.update(group !== groupOf(dragged) ? (group ? "Move into look" : "Move out of look") : `Reorder ${host.noun}s`, (list) => {
      const moved = arrayMove(list, from, to).map((e) => {
        if (e.id !== dragged.id || isEffectGroup(asGroup(e))) return e;
        const { group: _g, ...rest } = e as E & { group?: string };
        return (group ? { ...rest, group } : rest) as E;
      });
      return normalizeEffectGroups(moved as unknown as GroupableEffect[]) as unknown as E[];
    });
    if (group) setExpanded((prev) => new Set(prev).add(group!));
  };

  // ── Look verbs ─────────────────────────────────────────────────────────────
  const groupCards = (ids: string[]) => {
    const header = registry.create(EFFECT_GROUP_TYPE as E["type"]) as E & { name: string };
    header.name = "My look";
    host.update("Group as look", (list) =>
      groupEffects(list as unknown as GroupableEffect[], ids, header as unknown as GroupableEffect & EffectGroupCard) as unknown as E[],
    );
    setExpanded((prev) => new Set(prev).add(header.id));
    sel.clear();
  };
  const ungroup = (id: string) =>
    host.update("Ungroup look", (list) => ungroupEffects(list as unknown as GroupableEffect[], id) as unknown as E[]);
  const saveLook = (groupId: string) => {
    const header = effects.find((e) => e.id === groupId) as (E & { name?: string }) | undefined;
    saveToLibrary({
      title: "Save look",
      description: "Its cards, in order — wear it on any layer from the Look row.",
      defaultName: header?.name ?? "My look",
      onSave: (label, scope) => {
        presets.save(scope, label, lookDataFromGroup(effects as unknown as GroupableEffect[], groupId), { group: "Saved", chip: stackChip(host) }, registry.stackPresetKind);
        toast(`Saved “${label}” — ${scope === "project" ? "in this project" : "for every project"}`);
      },
    });
  };
  const frameOf = doc.frames.find((f) => "frameId" in host.clip && f.id === (host.clip as { frameId?: string }).frameId) ?? null;
  const lookTarget: LookTarget | null = hasGroups
    ? {
        effects: effects as unknown as LayerEffect[],
        subject: frameOf && host.clip.kind !== "audio" ? { doc, frame: frameOf, clip: host.clip as VisualClip, timeMs: playheadMs } : null,
        apply: (preset, into) => {
          const data = Array.isArray(preset.data) ? (preset.data as Array<{ type?: string }>) : [];
          for (const e of data) if (e.type) host.prepare?.(e.type);
          const fps = preset.fps;
          let made: string | null = null;
          host.update(
            `Apply ${preset.name}`,
            (list) => {
              const out = applyLookAsGroup(list as unknown as GroupableEffect[], { domain: "layer", preset }, into);
              made = out.group;
              return out.effects as unknown as E[];
            },
            undefined,
            fps ? (c) => void (c.kind !== "audio" && (c.fps = fps)) : undefined,
          );
          if (made) setFlashId(made);
        },
        remove: (gid) => removeIds([gid]),
        save: () => {
          const g = effects.find((e) => isEffectGroup(asGroup(e)));
          if (g) saveLook(g.id);
        },
      }
    : null;

  /** Apply a preset patch (or the defaults) to one card. */
  const patchCard = (effect: E, data: unknown, label: string) =>
    host.update(label, (list) => list.map((e) => (e.id === effect.id ? applyPresetPatch(e, data) : e)));

  /** ⌘C / ⌘X / ⌘V / ⌫ over the stack, scoped to the focused list. */
  const onListKeys = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const ids = [...sel.selected];
    if (mod && eventKey(e) === "a") {
      e.preventDefault();
      sel.selectAll();
    } else if (mod && eventKey(e) === "c" && ids.length) {
      e.preventDefault();
      copyIds(ids);
    } else if (mod && eventKey(e) === "x" && ids.length) {
      e.preventDefault();
      copyIds(ids, true);
    } else if (mod && eventKey(e) === "v") {
      e.preventDefault();
      pasteHere();
    } else if ((e.key === "Delete" || e.key === "Backspace") && ids.length) {
      e.preventDefault();
      removeIds(ids);
    } else if (e.key === "Escape" && ids.length) {
      sel.clear();
    }
  };

  const addMenu = (compact?: boolean) => (
    <EffectAddMenu
      items={host.palette.items}
      onAdd={addEffect}
      compact={compact}
      addLabel={host.addLabel}
      specificHeading={host.palette.heading}
      domain={host.domain}
      extra={(close) => (
        <SavedPresetsGroup
          host={host}
          onPick={(preset) => {
            addPreset(preset);
            close();
          }}
        />
      )}
    />
  );

  // The whole stack as one thing you can name. Its trigger names the live look
  // when the stack IS one, so a title wearing "Neon sign" says so.
  const looks = hasGroups ? null : (
    <PresetPicker
      kind={registry.stackPresetKind}
      capture={() => stackPresetFrom(effects)}
      current={host.lookOf ? () => host.lookOf!(effects) : undefined}
      onApply={applyLook}
      chipFor={() => stackChip(host)}
      label="Looks"
      showLabel={effects.length === 0}
      defaultName="My look"
      saveLabel="Save this stack as a look"
      saveTitle="Save look"
      saveDescription="The whole stack, in order — apply it to any layer in one click."
    />
  );

  const uneven = shared.uneven && (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex h-6 items-center gap-1 rounded-md bg-muted/60 px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground [&_svg]:size-3">
          <Layers /> Differ
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-56 text-[11px] leading-relaxed">
        The selected layers carry different stacks. Only the cards they all share are shown; adding or applying a look reaches every layer.
      </TooltipContent>
    </Tooltip>
  );

  const list =
    shown.length === 0 ? (
      addMenu()
    ) : (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* `relative` hosts the rubber band; the keyboard verbs are bound to
              the list itself so ⌘C/⌘X/⌘V/⌫ only fire while it has focus and
              can never fight the timeline's or the canvas's bindings. */}
          <div
            ref={listRef}
            tabIndex={-1}
            // The bottom strip is deliberate: cards are marquee TARGETS, so a
            // sweep can only begin on empty space, and without a strip the
            // only empty space in a full stack is the 8px between cards.
            className="relative pb-3 outline-none"
            {...sel.containerProps}
            onKeyDown={onListKeys}
          >
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={shown.map((e) => e.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {shown.map((effect) => (
                    <EffectCard
                      key={effect.id}
                      host={host}
                      effect={effect}
                      look={
                        hasGroups && lookTarget
                          ? {
                              isHeader: isEffectGroup(asGroup(effect)),
                              member: !!groupOf(effect) && !isEffectGroup(asGroup(effect)),
                              expanded: expanded.has(effect.id),
                              onToggle: () => toggleExpanded(effect.id),
                              target: lookTarget,
                              onUngroup: () => ungroup(effect.id),
                              onSaveLook: () => saveLook(effect.id),
                              onGroup: () => groupCards(sel.actionable(effect.id)),
                              onLeave: () =>
                                host.update("Move out of look", (list) =>
                                  normalizeEffectGroups(
                                    list.map((e) => {
                                      if (e.id !== effect.id) return e;
                                      const { group: _g, ...rest } = e as E & { group?: string };
                                      return rest as E;
                                    }) as unknown as GroupableEffect[],
                                  ) as unknown as E[],
                                ),
                            }
                          : undefined
                      }
                      mixed={mixedOf.get(effect.id)}
                      sortable={shown.length > 1}
                      flash={flashId === effect.id}
                      selected={sel.isSelected(effect.id)}
                      rootProps={{
                        ...sel.itemProps(effect.id),
                        onPointerDown: (e) => sel.onItemPointerDown(effect.id, e),
                      }}
                      selectionCount={sel.isSelected(effect.id) ? sel.selected.size : 1}
                      onRemove={() => removeIds(sel.actionable(effect.id))}
                      onCut={() => copyIds(sel.actionable(effect.id), true)}
                      onEnable={(v) => setEnabled(effect, v)}
                      onApplyPreset={(data, label) => patchCard(effect, data, label)}
                      onCopy={() => copyIds(sel.actionable(effect.id))}
                      onCopyAll={copyAll}
                      onPaste={pasteHere}
                      onSave={() => saveOne(effect)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            {sel.marqueeNode}
          </div>
        </ContextMenuTrigger>
        {/* Right-clicking EMPTY space is a real gesture too — it is where you
            paste, and where you reach for "select all" before a bulk verb. */}
        <ContextMenuContent className="w-52">
          {host.transfer && (
            <>
              <ContextMenuItem onClick={pasteHere}>
                <Clipboard /> Paste {host.noun}s here
              </ContextMenuItem>
              <ContextMenuItem onClick={copyAll}>
                <Copy /> Copy all {host.noun}s
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onClick={sel.selectAll}>Select all</ContextMenuItem>
          <ContextMenuItem disabled={sel.selected.size === 0} onClick={sel.clear}>
            Deselect
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );

  return (
    <PanelSection
      id={host.sectionId}
      title={host.title}
      count={shown.length}
      transfer={host.transfer ? { domains: [host.transfer.domain], clipId: host.clip.id } : undefined}
      defaultOpen={defaultOpen}
      forceOpen={flashId}
      flush={flush}
      actions={
        flush ? undefined : (
          <>
            {uneven}
            {looks}
            {host.headerExtra}
            {addMenu(true)}
          </>
        )
      }
    >
      {/* In tab mode there is no header, so the look picker gets a strip of
          its own above the cards — where a person looks for "what is this". */}
      {flush && (
        <div className="mb-2 flex items-center justify-between gap-2">
          {looks}
          <span className="flex items-center gap-1.5">
            {uneven}
            {host.headerExtra}
          </span>
        </div>
      )}
      {lookTarget && lookRowWanted && (
        <div className="mb-2">
          <LookRow target={lookTarget} />
        </div>
      )}
      {list}
      {/* In tab mode the add menu is the last card in the stack, so "add another"
          sits where your eye already is instead of up in a header. */}
      {flush && shown.length > 0 && <div className="pt-2">{addMenu()}</div>}
    </PanelSection>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The editor window files its remembered size under this key. Layer kinds
 *  keep their bare names so sizes people already tuned survive; other domains
 *  are namespaced, or a text Glow would open at a layer Glow's height. */
function editorKey<E extends BaseEffect>(host: EffectStackHost<E>, type: string): string {
  return host.domain === "layer" ? type : `${host.domain}:${type}`;
}

interface LookCardProps {
  isHeader: boolean;
  member: boolean;
  expanded: boolean;
  onToggle: () => void;
  target: LookTarget;
  onUngroup: () => void;
  onSaveLook: () => void;
  onGroup: () => void;
  onLeave: () => void;
}

function EffectCard<E extends BaseEffect>({
  host,
  effect,
  look,
  mixed,
  sortable,
  flash,
  selected,
  rootProps,
  selectionCount,
  onRemove,
  onCut,
  onEnable,
  onApplyPreset,
  onCopy,
  onCopyAll,
  onPaste,
  onSave,
}: {
  host: EffectStackHost<E>;
  effect: E;
  look?: LookCardProps;
  mixed: ReadonlySet<string> | undefined;
  sortable: boolean;
  flash: boolean;
  selected?: boolean;
  rootProps?: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>;
  /** How many cards this card's verbs act on — 1, or the whole selection. */
  selectionCount: number;
  onRemove: () => void;
  onCut: () => void;
  onEnable: (enabled: boolean) => void;
  onApplyPreset: (data: unknown, label: string) => void;
  onCopy: () => void;
  onCopyAll: () => void;
  onPaste: () => void;
  onSave: () => void;
}) {
  const { registry, clip } = host;
  const def = registry.def(effect.type);
  const fields = registry.fields(effect);
  const Icon = host.icon(effect.type);
  const openId = useEffectEditor((s) => s.openId);
  const open = openId === effect.id;
  const key = editorKey(host, effect.type);
  const openEditor = () => useEffectEditor.getState().open(effect.id, key, registry.editorHint(effect.type));
  // The card shows the switch AT THE PLAYHEAD, not the flag left in the panel:
  // an effect keyed off at 00:04 dims its own card there too.
  const enablePath = registry.path(effect.id, ENABLED_FIELD);
  const enabledNow = useEffectiveValue(host.canKey ? clip : undefined, enablePath, effect.enabled);
  const groupProps = fields.map((f) => ({
    property: registry.path(effect.id, f.key),
    currentValue: () => fieldValue(effect, f),
  }));
  // Factory defaults drive double-click-to-reset and "Reset all" — derived from
  // the registry rather than duplicated, so a changed default is honoured here.
  const defaults = React.useMemo(
    () => registry.defaults(effect.type) as Record<string, KeyframeValue>,
    [registry, effect.type],
  );

  const label = (look?.isHeader ? (effect as unknown as { name?: string }).name : undefined) ?? host.cardLabel?.(effect) ?? def?.label ?? effect.type;
  const mixPath = registry.path(effect.id, "mix");
  const mixNow = Number(useEffectiveValue(host.canKey ? clip : undefined, mixPath, (effect as unknown as { mix?: number }).mix ?? 1));
  const keyControl = host.canKey ? <GroupKeyButton clip={clip} properties={groupProps} /> : undefined;
  // Every verb on this card's menu speaks for the SELECTION when the card is
  // part of one, so the wording has to say so — "Delete effect" while five are
  // ringed is a menu that lies about what it is about to do.
  const many = selectionCount > 1 ? `${selectionCount} ${host.noun}s` : host.noun;
  const isMixed = (k: string) => mixed?.has(k) ?? false;

  const spec: EffectEditorSpec = {
    effectId: effect.id,
    clip,
    title: label,
    icon: Icon,
    enabled: Boolean(enabledNow),
    canKey: host.canKey,
    presetKind: registry.presetKind(effect.type),
    domain: host.domain,
    effectType: host.domain === "layer" ? (effect.type as never) : undefined,
    mixed: isMixed,
    fields,
    optionsFor: host.refOptions ? (f) => host.refOptions!(effect, f) : undefined,
    refField: host.refField ? (f, v, set) => host.refField!(effect, f, v, set) : undefined,
    groups: def?.groups,
    toggles: def?.toggles,
    value: (k) => fieldValue(effect, fields.find((f) => f.key === k) ?? { key: k, label: k, kind: "number" }),
    defaults,
    toggleValue: (k) => Boolean((effect as unknown as Record<string, unknown>)[k]),
    pathFor: (k) => (host.pathOf ?? registry.path)(effect.id, k),
    onCommit: (field, v) => host.commit(effect, field.key, v, `${label} ${field.label}`, `${registry.prefix}-${effect.id}-${field.key}`),
    onToggle: (k, v, l) => host.setToggle(effect, k, v, l),
    onEnable,
    onRemove,
    onReset: () => onApplyPreset(defaults, `Reset ${label}`),
    capture: () => presetPatchFrom(effect),
    onApplyPreset: (data, preset) => onApplyPreset(data, `Apply ${preset.name}`),
    chip: () => effectChip(host, effect),
    presetName: label,
    headerKey: keyControl,
    customBody: host.customBody?.(effect),
    bodyLead: host.bodyLead?.(effect),
    bodyExtra: host.bodyExtra?.(effect),
  };

  return (
    <>
      <EffectCardShell
        id={effect.id}
        label={label}
        icon={Icon}
        enabled={Boolean(enabledNow)}
        enableKey={host.canKey ? { clip, property: enablePath } : undefined}
        sortable={sortable}
        flash={flash}
        open={open}
        selected={selected}
        badge={mixed && mixed.size > 0 ? "Mixed" : undefined}
        rootProps={rootProps}
        keyControl={keyControl}
        indent={look?.member}
        below={
          look?.isHeader ? (
            // Mix: the one dial a look is regularly turned by, under its name.
            <label className="flex h-6 items-center gap-2 pb-1 pl-6 text-[11px] text-muted-foreground">
              Mix
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={Number.isFinite(mixNow) ? mixNow : 1}
                aria-label="Look mix"
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => host.commit(effect, "mix", Number(e.target.value), `${label} mix`, `${registry.prefix}-${effect.id}-mix`)}
                className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--primary)]"
              />
              <span className="w-8 text-right tabular-nums">{Math.round((Number.isFinite(mixNow) ? mixNow : 1) * 100)}%</span>
            </label>
          ) : undefined
        }
        lead={
          look?.isHeader ? (
            <button
              type="button"
              aria-label={look.expanded ? "Collapse look" : "Expand look"}
              aria-expanded={look.expanded}
              onClick={look.onToggle}
              className="-ml-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
            >
              <ChevronRight className={look.expanded ? "rotate-90 transition-transform" : "transition-transform"} />
            </button>
          ) : undefined
        }
        trailing={
          look?.isHeader ? (
            <>
              <LookGalleryPopover target={look.target} into={effect.id}>
                <button
                  type="button"
                  aria-label="Swap look"
                  title="Swap look"
                  className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-white/5 hover:text-foreground [&_svg]:size-3.5"
                >
                  <Replace />
                </button>
              </LookGalleryPopover>
            </>
          ) : undefined
        }
        // The card animates every field its group diamond keys, plus its own eye.
        keyTargets={
          host.canKey
            ? { clip, targets: [...groupProps, { property: enablePath, currentValue: () => Boolean(enabledNow) }] }
            : undefined
        }
        onOpen={() => useEffectEditor.getState().toggle(effect.id, key, registry.editorHint(effect.type))}
        onEnable={onEnable}
        onRemove={onRemove}
        contextItems={
          <>
            <ContextMenuItem onClick={openEditor}>
              <SlidersHorizontal /> {cap(host.noun)} settings…
            </ContextMenuItem>
            {(host.cardActions?.(effect) ?? []).map((a) => (
              <ContextMenuItem key={a.id} disabled={!!a.disabledReason} onClick={a.run} title={a.disabledReason}>
                <a.icon /> {a.label}
              </ContextMenuItem>
            ))}
            {look?.isHeader && (
              <>
                <ContextMenuItem onClick={look.onSaveLook}>
                  <BookmarkPlus /> Save as look…
                </ContextMenuItem>
                <ContextMenuItem onClick={look.onUngroup}>
                  <Ungroup /> Ungroup
                </ContextMenuItem>
              </>
            )}
            {look && !look.isHeader && (
              <ContextMenuItem onClick={look.onGroup}>
                <GroupIcon /> Group as look
              </ContextMenuItem>
            )}
            {look?.member && <ContextMenuItem onClick={look.onLeave}>Move out of look</ContextMenuItem>}
            <ContextMenuSeparator />
            {/* ORDER is meaning in a stack (mirror then subdivide is not
                subdivide then mirror) — dragging is one way to say it, these
                are the exact ones. */}
            <ContextMenuItem onClick={() => host.update(`Duplicate ${label}`, (list) => dup(list, effect.id))}>
              <CopyPlus /> Duplicate
            </ContextMenuItem>
            <ContextMenuItem disabled={host.effects[0]?.id === effect.id} onClick={() => host.update(`Move ${label} to top`, (list) => moveTo(list, effect.id, 0))}>
              <ArrowUpToLine /> Move to top
            </ContextMenuItem>
            <ContextMenuItem
              disabled={host.effects[host.effects.length - 1]?.id === effect.id}
              onClick={() => host.update(`Move ${label} to bottom`, (list) => moveTo(list, effect.id, list.length - 1))}
            >
              <ArrowDownToLine /> Move to bottom
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onSave}>
              <BookmarkPlus /> Add to library…
            </ContextMenuItem>
            {host.transfer && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={onCopy}>
                  <Copy /> Copy {many}
                </ContextMenuItem>
                <ContextMenuItem onClick={onCut}>
                  <Scissors /> Cut {many}
                </ContextMenuItem>
                <ContextMenuItem onClick={onCopyAll}>
                  <Copy /> Copy all {host.noun}s
                </ContextMenuItem>
                <ContextMenuItem onClick={onPaste}>
                  <Clipboard /> Paste {host.noun}s here
                </ContextMenuItem>
              </>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onRemove} className="text-destructive focus:text-destructive">
              <Trash2 /> Delete {many}
            </ContextMenuItem>
          </>
        }
      />
      {open && <EffectEditorWindow spec={spec} />}
    </>
  );
}

/**
 * The user's OWN saved presets of this domain — the one preset group that
 * stays a list of rows in the palette, because unlike a built-in look these
 * are specific configured cards the user asked to keep, there are few of them,
 * and there is nowhere else to find them. Built-ins are deliberately absent:
 * they are a LOOK OF an effect and live in the card's own picker, one click
 * after adding, where they can actually be compared.
 */
function SavedPresetsGroup<E extends BaseEffect>({
  host,
  onPick,
}: {
  host: EffectStackHost<E>;
  onPick: (preset: Preset) => void;
}) {
  const { presets, remove } = usePresets("");
  const { registry } = host;
  const kinds = new Map(registry.types.map((d) => [registry.presetKind(d.type), d]));
  const mine = presets.filter((p) => p.scope !== "builtin" && kinds.has(p.kind));
  if (mine.length === 0) return null;

  return (
    <CommandGroup heading="Saved">
      {mine.map((preset) => {
        const def = kinds.get(preset.kind)!;
        return (
          <EffectPaletteItem
            key={preset.id}
            icon={host.icon(def.type) ?? PRESET_FALLBACK_ICON}
            label={preset.name}
            blurb={def.label}
            value={preset.name}
            keywords={[def.label, ...(preset.tags ?? [])]}
            onSelect={() => onPick(preset)}
            trailing={
              <button
                type="button"
                aria-label={`Delete preset ${preset.name}`}
                title="Delete preset"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(preset);
                }}
                className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-aria-selected:opacity-100 [&_svg]:size-3"
              >
                <Trash2 />
              </button>
            }
          />
        );
      })}
    </CommandGroup>
  );
}

function fieldValue<E extends BaseEffect>(effect: E, field: EffectFieldDef): KeyframeValue {
  const raw = (effect as unknown as Record<string, unknown>)[field.key];
  if (field.kind === "color") return typeof raw === "string" ? raw : "#000000";
  // An enum falls back to its FIRST declared option rather than to "" — an
  // empty value would put the picker in a state none of its items match.
  if (field.kind === "select") return typeof raw === "string" ? raw : field.options?.[0]?.value ?? "";
  // A reference (a layer, a pose set, a voice) is an id or a name — "" is its
  // "none". Never a number: a 0 matches no choice and the picker shows blank.
  if (isReferenceField(field.kind)) return typeof raw === "string" ? raw : "";
  return typeof raw === "number" ? raw : 0;
}

/** Two colours that hint at a saved effect — its own colour fields when it has
 *  any, otherwise a neutral chip. Keeps saved presets visually scannable. */
function effectChip<E extends BaseEffect>(host: EffectStackHost<E>, effect: E): [string, string] | null {
  const colors = host.registry
    .fields(effect)
    .filter((f) => f.kind === "color")
    .map((f) => String((effect as unknown as Record<string, unknown>)[f.key] ?? ""))
    .filter((c) => c.startsWith("#"));
  if (colors.length === 0) return null;
  return [colors[0]!, colors[colors.length - 1]!];
}

/** A look's chip: the first card's first colour to the last card's last. */
function stackChip<E extends BaseEffect>(host: EffectStackHost<E>): [string, string] | null {
  const chips = host.effects.map((e) => effectChip(host, e)).filter((c): c is [string, string] => c !== null);
  if (chips.length === 0) return null;
  return [chips[0]![0], chips[chips.length - 1]![1]];
}

/** The list with a copy of one card right under it (a fresh id; its keys stay with the original). */
function dup<E extends BaseEffect>(list: E[], id: string): E[] {
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return list;
  const src = list[i]!;
  const copy = { ...structuredClone(src), id: createId(src.id.split("_")[0] || "fx") } as E;
  return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)];
}

/** The list with one card moved to an index. */
function moveTo<E extends BaseEffect>(list: E[], id: string, to: number): E[] {
  const i = list.findIndex((e) => e.id === id);
  if (i < 0 || i === to) return list;
  const next = list.slice();
  const [e] = next.splice(i, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, e!);
  return next;
}
