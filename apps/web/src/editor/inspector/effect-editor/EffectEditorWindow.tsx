"use client";

import { effectFieldPicture } from "../effect-pictures";
import * as React from "react";
import type {
  Clip,
  EffectDomain,
  EffectFieldCondition,
  EffectFieldDef,
  EffectFieldGroupDef,
  EffectFieldOption,
  KeyframeValue,
  LayerEffectType,
  Preset,
} from "@solomotion/core";
import { effectDomainHasPicture, effectFieldVisible } from "@solomotion/core";
import {
  ChevronRight,
  Eye,
  EyeOff,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { FloatingWindow } from "@/components/ui/floating-window";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EditorRow, ValueField } from "../value-field";
import { EffectPreview } from "./EffectPreview";
import { PresetPicker } from "./PresetPicker";
import { useEffectEditor } from "./store";

/**
 * THE effect editor — one floating window that edits ANY effect, in any stack.
 *
 * Cards in the inspector are now just a title, a grip and their switches; the
 * fields live here, in a movable, resizable window that opens beside the panel
 * (Figma's model, with the app's window chrome). That is what makes a
 * thirty-field material like Liquid glass possible without the sidebar turning
 * into a canyon — and small effects get a live A/B preview they never had.
 *
 * The window is DUMB about effects: it renders whatever the core registry
 * declares (fields, groups, units, hints, ranges) and calls back with values.
 * A new effect type gets this editor — sliders, keyframes, presets, preview —
 * for free, which is the whole point of the registry.
 *
 * SIZE is the registry's call, then the user's. Each effect kind declares what
 * it needs (`def.editor`) — an equaliser wants three decades of frequency, a
 * Grain card wants four rows — and the height defaults to hugging the content,
 * so no card ever opens over a field of dead grey. Drag to override, and the
 * override is remembered for that KIND. Double-click the title bar to snap back
 * to the designed size.
 *
 * LAYOUT is relative to the WINDOW, not the browser. The body is a container,
 * so the field list, the knob grid and the sound visualisations reflow when you
 * drag the window narrower — the thing a viewport breakpoint cannot do, and the
 * reason a 760px window used to lay its content out as if it were 1440.
 *
 * Dismissal: it is a PANEL, not a popover — nothing closes it but you (×,
 * Escape, the card again) or its card going away. It used to close on any
 * outside click with a list of exempt surfaces, and that list was never
 * complete: a character is tuned by clicking its poses in the Character tab,
 * its machine board, another floating window — each one an "outside" click
 * that threw the window away mid-edit. A pin papered over it; the pin is gone
 * with the rule it existed to escape.
 */
export interface EffectEditorSpec {
  effectId: string;
  /**
   * The clip whose keyframes these fields write to (also framed in the
   * preview). `null` for an editor over something that has no clip — a frame's
   * stroke, a brush's line — where the rows render as plain controls.
   */
  clip: Clip | null;
  title: string;
  icon: LucideIcon;
  enabled: boolean;
  /** False for range-scoped text styles, where values can't be keyed. */
  canKey: boolean;
  /** Preset namespace, e.g. `effect:glass`. */
  presetKind: string;
  /**
   * Which domain this card belongs to. Sound has no before/after PICTURE — the
   * visual preview is meaningless for it — so the window drops that block and
   * hands the whole body to the card instead.
   */
  domain?: EffectDomain;
  /** The effect's registry type — lets the preview decide whether to run its clock. */
  effectType?: LayerEffectType;
  /**
   * Whether the SELECTION disagrees about a field. A multi-selection edits
   * the primary's card and fans the write; a field the siblings hold
   * differently shows "Mixed" until it is written once.
   */
  mixed?: (key: string) => boolean;
  fields: readonly EffectFieldDef[];
  /** The choices of a `ref` field — only the host knows them (a character's sets, its bones). */
  optionsFor?: (field: EffectFieldDef) => readonly EffectFieldOption[] | undefined;
  /** A `ref` field as the host's own picker (see `EffectStackHost.refField`). */
  refField?: (field: EffectFieldDef, value: string, set: (v: string) => void) => React.ReactNode | undefined;
  groups?: readonly EffectFieldGroupDef[];
  toggles?: ReadonlyArray<{
    key: string;
    label: string;
    hint?: string;
    group?: string;
    showIf?: EffectFieldCondition;
  }>;
  /** Current base value of a field (keyframes are resolved by the field row). */
  value: (key: string) => KeyframeValue;
  /** Factory defaults, for double-click-to-reset and "Reset all". */
  defaults: Record<string, KeyframeValue>;
  toggleValue: (key: string) => boolean;
  pathFor: (key: string) => string;
  onCommit: (field: EffectFieldDef, v: KeyframeValue) => void;
  onToggle: (key: string, v: boolean, label: string) => void;
  onEnable: (v: boolean) => void;
  onRemove: () => void;
  onReset: () => void;
  /** Everything but identity — what a saved preset stores. */
  capture: () => unknown;
  onApplyPreset: (data: unknown, preset: Preset) => void;
  chip?: () => [string, string] | null;
  /** Suggested name when saving a preset from here. */
  presetName?: string;
  /**
   * The card-level keyframe control — keys every field at once. It lives in the
   * TITLE BAR, beside the other whole-effect actions (enable, reset, delete),
   * because that is what it is: an action on the effect, not a field. It used
   * to sit in a footer under the last row, labelled "Key every field", where it
   * was both the only prose in the window and the reason the window had a
   * footer at all.
   */
  headerKey?: React.ReactNode;
  /** Replaces the generated rows for effects with a bespoke editor (wheels…). */
  customBody?: React.ReactNode;
  /** Precedes the generated rows — see `EffectStackHost.bodyLead`. */
  bodyLead?: React.ReactNode;
  /** Follows the generated rows — see `EffectStackHost.bodyExtra`. */
  bodyExtra?: React.ReactNode;
  /**
   * The custom body OWNS the window's remaining height and does its own
   * scrolling.
   *
   * The generated rows are a list: they want a scroller wrapped around them and
   * a height that comes from however many fields the effect declares. A designed
   * panel is the opposite — it is a LAYOUT, and it needs to know how tall the
   * window is so its columns can each be 100% of it and scroll independently.
   * Wrapping one of those in the list's scroller is what produced the sound
   * cards' two symptoms at once: a second, nested scrollbar inside a column that
   * was already scrolling, and a panel that ignored the window's height because
   * its own content had defined it before the window was ever consulted.
   */
  bodyFill?: boolean;
  /**
   * Replaces the A/B picture. A stroke shows the LINE it makes — a before/after
   * of the whole layer would answer a question nobody asked about a dash offset.
   */
  customPreview?: React.ReactNode;
}

export function EffectEditorWindow({ spec }: { spec: EffectEditorSpec }) {
  const bounds = useEffectEditor((s) => s.bounds);
  const previewOpen = useEffectEditor((s) => s.previewOpen);
  const close = useEffectEditor((s) => s.close);
  const setBounds = useEffectEditor((s) => s.setBounds);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !escapeIsOurs(e)) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  useReleaseOnUnmount(spec.effectId);

  const Icon = spec.icon;
  const grouped = groupFields(spec);
  const renderToggle = (t: (typeof grouped)[number]["toggles"][number]) => (
    <EditorRow key={t.key} label={t.label} hint={t.hint}>
      <Switch
        checked={spec.toggleValue(t.key)}
        onCheckedChange={(v) => spec.onToggle(t.key, v, `${spec.title} ${t.label}`)}
      />
    </EditorRow>
  );
  const renderSection = (section: (typeof grouped)[number], sub = false) => (
    <FieldSection
      key={section.id ?? "_"}
      label={section.label}
      defaultCollapsed={section.collapsed}
      sub={sub}
    >
      {/* A section's MASTER switch — one the rows below are conditional on —
          comes first: a switch sitting under the fields it reveals makes them
          appear above your pointer. */}
      {section.toggles.filter((t) => section.gates.has(t.key)).map(renderToggle)}
      {section.fields.map((f) => {
        const picker = f.kind === "ref" ? spec.refField?.(f, String(spec.value(f.key) ?? ""), (v) => spec.onCommit(f, v)) : undefined;
        if (picker)
          return (
            <EditorRow key={f.key} label={f.label} hint={f.hint}>
              {picker}
            </EditorRow>
          );
        return (
        <ValueField
          key={f.key}
          clip={spec.clip}
          canKey={spec.canKey}
          path={spec.pathFor(f.key)}
          kind={f.kind}
          options={f.kind === "ref" ? (spec.optionsFor?.(f) ?? []) : f.options}
          optionPreview={f.preview}
          empty={f.empty}
          picture={f.kind === "image" ? effectFieldPicture(spec.effectType, f.key, spec.clip, spec.effectId) : undefined}
          label={f.label}
          unit={f.unit}
          hint={f.hint}
          bipolar={f.bipolar}
          base={spec.value(f.key)}
          defaultValue={spec.defaults[f.key]}
          min={f.min}
          max={f.max}
          step={f.step}
          mixed={spec.mixed?.(f.key)}
          onChange={(v) => spec.onCommit(f, v)}
        />
        );
      })}
      {/* Toggles use the SAME row grammar as the fields above them (see
            `EditorRow`), so a switch starts where a slider starts instead
            of drifting to the window's right edge. */}
      {section.toggles.filter((t) => !section.gates.has(t.key)).map(renderToggle)}
    </FieldSection>
  );

  return (
    <FloatingWindow
      title={spec.title}
      icon={<Icon />}
      bounds={bounds}
      windowId="effect-editor"
      minWidth={320}
      // A designed panel (`bodyFill`) divides the height it is given, so the
      // floor has to leave something worth dividing.
      minHeight={260}
      // A pinned Preview block over a scrolling field list — the window frame
      // must not scroll, or the preview would scroll away with the fields.
      body="fill"
      onBoundsChange={(patch) => setBounds(patch)}
      // No minimize: this window is a tool you finish with, not a panel you
      // park. Pin covers "keep it while I work" and Escape covers "done" — so
      // the title bar's double-click is free, and it does the useful thing
      // instead of nothing: snap back to the size this effect was designed at.
      onToggleMinimize={() => useEffectEditor.getState().resetSize()}
      onClose={close}
      titleActions={
        <>
          {spec.headerKey && (
            <>
              <span
                className="flex size-6 items-center justify-center"
                title="Key every field"
              >
                {spec.headerKey}
              </span>
              <span className="mx-0.5 h-4 w-px bg-border/70" />
            </>
          )}
          <PresetPicker
            kind={spec.presetKind}
            capture={spec.capture}
            onApply={spec.onApplyPreset}
            chipFor={spec.chip}
            defaultName={spec.presetName ?? spec.title}
          />
          <HeaderButton
            label={spec.enabled ? "Disable effect" : "Enable effect"}
            onClick={() => spec.onEnable(!spec.enabled)}
          >
            {spec.enabled ? <Eye /> : <EyeOff />}
          </HeaderButton>
          <HeaderButton label="Reset all fields" onClick={spec.onReset}>
            <RotateCcw />
          </HeaderButton>
          <HeaderButton
            label="Delete effect"
            danger
            onClick={() => {
              spec.onRemove();
              close();
            }}
          >
            <Trash2 />
          </HeaderButton>
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* The A/B picture is for effects you LOOK at. A reverb has nothing
              to show here, and a checkerboard labelled "before/after" over
              silence is worse than no block at all — so sound cards get the
              whole window for their own visualisation. */}
        {effectDomainHasPicture(spec.domain ?? "layer") && (
          <div className="shrink-0 border-b border-border/60 px-3 py-2">
            <button
              type="button"
              onClick={() =>
                useEffectEditor.getState().setPreviewOpen(!previewOpen)
              }
              className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3"
            >
              <ChevronRight
                className={cn(
                  "transition-transform",
                  previewOpen && "rotate-90",
                )}
              />
              Preview
            </button>
            {previewOpen &&
              (spec.customPreview ?? (
                spec.clip && (
                  <EffectPreview
                    clip={spec.clip}
                    effectId={spec.effectId}
                  />
                )
              ))}
          </div>
        )}
        {/* Sizes against THIS WINDOW: `FloatingWindow`'s body is the
              container, so `@[620px]:` below means "the window is 620 wide",
              not "the monitor is". */}
        {spec.bodyFill ? (
          <div className="min-h-0 flex-1 px-3 py-2">{spec.customBody}</div>
        ) : (
        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-3 py-2">
          {spec.customBody ? (
            <div className="space-y-1.5">{spec.customBody}</div>
          ) : (
            <>
              {spec.bodyLead}
              {grouped.filter((g) => !g.advanced).map((section) => renderSection(section))}
              {/* The main sections are the look; everything a kind marks
                    `advanced` lives under one closed disclosure — its own
                    headings intact — so the first screen of a thirty-field
                    card is the seven controls that matter. */}
              {grouped.some((g) => g.advanced) && (
                <FieldSection label="Advanced" defaultCollapsed nested>
                  {grouped.filter((g) => g.advanced).map((section) => renderSection(section, true))}
                </FieldSection>
              )}
              {spec.bodyExtra}
            </>
          )}
        </ScrollArea>
        )}
      </div>
    </FloatingWindow>
  );
}

/**
 * Whether an Escape is the WINDOW's to take. This listener runs in the capture
 * phase — ahead of everything inside the window — so without asking it stole
 * the key from the dropdown, colour picker or menu it was meant to dismiss,
 * and closing a Voice list closed the whole window. An open floating layer
 * gets the key; a focused field just lets go of focus.
 */
function escapeIsOurs(e: KeyboardEvent): boolean {
  if (document.querySelector("[data-radix-popper-content-wrapper],[role=listbox],[role=menu]")) return false;
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    el.blur();
    e.stopPropagation();
    return false;
  }
  return true;
}

/**
 * The window is rendered BY its card, so when the card goes (another tab,
 * another selection, the effect deleted) the window goes with it — and the
 * store has to hear about it. Otherwise `openId` outlived the window, and the
 * next click on that card "closed" a window nobody could see: two clicks to
 * open it, which reads as the window being flaky. Released a tick late and
 * only when nothing re-mounted it, so a StrictMode double-mount or a card
 * re-keying under the same effect is not mistaken for leaving.
 */
const mounts = new Map<string, number>();
function useReleaseOnUnmount(effectId: string): void {
  React.useEffect(() => {
    mounts.set(effectId, (mounts.get(effectId) ?? 0) + 1);
    return () => {
      mounts.set(effectId, (mounts.get(effectId) ?? 1) - 1);
      setTimeout(() => {
        if ((mounts.get(effectId) ?? 0) > 0) return;
        mounts.delete(effectId);
        if (useEffectEditor.getState().openId === effectId) useEffectEditor.getState().close();
      }, 0);
    };
  }, [effectId]);
}

/**
 * Fields + toggles bucketed into their declared sections, in registry order —
 * and filtered by `showIf` first, so a row that cannot apply is not shown
 * greyed out but simply is not there.
 *
 * That is the honest rendering of a conditional field: Glow's `color` does not
 * exist in auto mode (the bloom is made of the layer's own pixels), and a
 * disabled colour swatch would invite the user to argue with it. The condition
 * is plain data on the registry, so this reads it rather than knowing about any
 * particular effect.
 */
function groupFields(spec: EffectEditorSpec) {
  const defs = spec.groups ?? [];
  // A condition may name either a field or a toggle, so both are consulted.
  const fieldKeys = new Set(spec.fields.map((f) => f.key));
  // Core's rule (`effectFieldVisible`), read against this window's values —
  // a second copy here once ignored a condition core had learned (`not`).
  const visible = (row: { showIf?: EffectFieldCondition }): boolean => {
    if (!row.showIf) return true;
    const { key } = row.showIf;
    return effectFieldVisible(row, { [key]: fieldKeys.has(key) ? spec.value(key) : spec.toggleValue(key) });
  };
  const fields = spec.fields.filter(visible);
  const toggles = (spec.toggles ?? []).filter(visible);
  const sections: Array<{
    id: string | null;
    label: string | null;
    collapsed?: boolean;
    advanced?: boolean;
    fields: EffectFieldDef[];
    toggles: NonNullable<EffectEditorSpec["toggles"]>[number][];
  }> = [];
  const bucket = (id: string | null) => {
    let s = sections.find((x) => x.id === id);
    if (!s) {
      const def = defs.find((d) => d.id === id);
      s = {
        id,
        label: def?.label ?? null,
        collapsed: def?.collapsed,
        advanced: def?.advanced,
        fields: [],
        toggles: [],
      };
      sections.push(s);
    }
    return s;
  };
  // Ungrouped fields first (small effects declare no groups at all), then the
  // declared sections in the order the registry lists them.
  for (const f of fields) if (!f.group) bucket(null).fields.push(f);
  for (const t of toggles) if (!t.group) bucket(null).toggles.push(t);
  for (const def of defs) {
    const s = bucket(def.id);
    s.fields.push(...fields.filter((f) => f.group === def.id));
    s.toggles.push(...toggles.filter((t) => t.group === def.id));
  }
  // Which keys the section's own rows are conditional on — its master switches.
  const gates = (s: (typeof sections)[number]) =>
    new Set((spec.fields.filter((f) => f.group === (s.id ?? undefined)).map((f) => f.showIf?.key)).filter((k): k is string => !!k));
  return sections
    .filter((s) => s.fields.length > 0 || s.toggles.length > 0)
    .map((s) => ({ ...s, gates: gates(s) }));
}

/**
 * A section's rows, laid out against the WINDOW's width.
 *
 * One column while the window is narrow; two once there is honestly room for
 * two (a field row needs ~300px before its label, slider and number stop
 * fighting each other). This is why a thirty-field material is a panel you can
 * read rather than a scroll you have to remember your place in — and why
 * widening the window does something instead of adding margin.
 */
const ROWS = "grid grid-cols-1 gap-x-5 gap-y-1.5 @[620px]:grid-cols-2";

function FieldSection({
  label,
  defaultCollapsed,
  children,
  nested,
  sub,
}: {
  label: string | null;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
  /** The body holds sections of its own rather than rows. */
  nested?: boolean;
  /** A section inside the Advanced disclosure — quieter heading, indented. */
  sub?: boolean;
}) {
  const [open, setOpen] = React.useState(!defaultCollapsed);
  if (!label) return <div className={cn(ROWS, "pb-2")}>{children}</div>;
  return (
    <div className={cn("py-2", sub ? "pl-3" : "border-b border-border/40 last:border-b-0")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "mb-1.5 flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3",
          sub && "font-medium normal-case tracking-normal text-muted-foreground/80",
        )}
      >
        <ChevronRight
          className={cn("transition-transform", open && "rotate-90")}
        />
        {label}
      </button>
      {open && (nested ? <div>{children}</div> : <div className={ROWS}>{children}</div>)}
    </div>
  );
}

function HeaderButton({
  children,
  label,
  active,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-6 items-center justify-center rounded transition-colors [&_svg]:size-3.5",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground",
        danger && "hover:text-destructive",
      )}
    >
      {children}
    </button>
  );
}
