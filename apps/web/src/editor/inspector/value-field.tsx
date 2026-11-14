"use client";

import * as React from "react";
import { isReferenceField, resolveColor, type Clip, type EffectFieldKind, type EffectFieldOption, type KeyframeValue, type PickFilter } from "@solomotion/core";
import { Range } from "@/components/ui/range";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDoc } from "../state/document-context";
import { DocColorInput } from "./DocColorInput";
import { PropRow } from "./controls";
import { KeyControl } from "./keyframe-controls";
import { useEffectiveValue } from "./animatable";
import { PropertyBindingMenu } from "./property-binding";
import { ModulatorControl, useClipModulatorHost, type ModulatorHost } from "./ModulatorControl";
import { LayerRefField } from "../pick/ObjectField";
import { MaterialSwatch } from "./MaterialSwatch";
import { ImageWell } from "./ImageWell";

/**
 * THE keyframeable field row — one component behind every effect value in the
 * app (both effect stacks, inline cards and the floating effect editor).
 *
 * It owns the three things a value row must never disagree about: what the
 * value IS right now (the sampled keyframe beats the base), how you KEY it (the
 * shared diamond), and how you RESET it (double-click the label → the type's
 * own default). `layout` picks the grid — the effect editor's wide row or the
 * docked inspector's compact one — same component, same writes.
 */
export interface ValueFieldProps {
  /**
   * The clip these values belong to — or `null` when they belong to nothing on
   * the timeline. A brush preset is the case that forced this: its fields are
   * the SAME registry rows a stroke's are, but a brush has no clip, so it has
   * no keyframes, no drivers and no modulators. Everything else about the row
   * — the slider, the range, the reset, the unit, the hint — is identical, and
   * forking the component to say that would have been two renderers for one
   * grammar.
   */
  clip: Clip | null;
  canKey: boolean;
  path: string;
  kind: EffectFieldKind;
  label: string;
  /** An `image` field's live picture — what the effect makes of it (see `ImageWell`). */
  picture?: React.ReactNode;
  /** A `layer` field's empty choice, as shown ("This layer"); default "None". */
  empty?: string;
  /** Required when `kind` is "select" — the choices, in menu order. */
  options?: readonly EffectFieldOption[];
  /** The choices are best seen: each shows a swatch (the field def's `preview`). */
  optionPreview?: "material";
  base: KeyframeValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Tooltip on the label — say what the field DOES. */
  hint?: string;
  /** Slider fills outward from 0 rather than from `min`. */
  bipolar?: boolean;
  /**
   * Which grid the row sits in. In BOTH, a field that declares `min` and `max`
   * is a bounded scalar and its control is the meter (`Range`) — that rule used
   * to be opt-in, so the same registry field rendered as a slider in the effect
   * editor and as a bare number box three panels over.
   *
   *   editor     the effect editor's wide row: label, a track in front of the
   *              number field, the modulator and the key (`EditorRow`).
   *   inspector  the docked panel's compact row (`PropRow`): a bounded value
   *              is ONE meter with its readout inside, filling the column —
   *              a track squeezed beside a number box in 180px is neither;
   *              an open-ended value is the number field.
   */
  layout?: "editor" | "inspector";
  /** Double-clicking the label restores this. */
  defaultValue?: KeyframeValue;
  /**
   * Offer the modulator badge on this row. Defaults to on for keyable numeric
   * rows — which is every effect field in the app — and is turned off for the
   * modulator's OWN editor, since a signal driving a signal is what the node
   * graph is for.
   */
  modulatable?: boolean;
  /**
   * Who owns the modulator list for this row. Defaults to the CLIP, which is
   * every ordinary case; a document variable's paint editor passes its own,
   * which is what puts a wiggle on a shared gradient's angle without this
   * component learning that variables exist.
   */
  modulatorHost?: ModulatorHost;
  /**
   * The selection disagrees about this field. The control shows "Mixed" and
   * the first write sets every target — the same contract every other shared
   * field in the app keeps (see `selection/` in core).
   */
  mixed?: boolean;
  onChange: (v: KeyframeValue) => void;
}

/** The empty choice of a `ref` row (Radix reserves ""). */
const NONE = "__none__";

/**
 * A reference picker's choices, so the trigger is NEVER blank: what it holds
 * is always one of them — "None" when it is empty and the host offers no
 * empty choice, and a reference to something gone (a deleted pose set, a
 * renamed voice) named as missing rather than shown as nothing.
 */
function refChoices(options: readonly { value: string; label: string; hint?: string }[], current: string | null): Array<{ value: string; label: string; hint?: string }> {
  if (current === null || options.some((o) => o.value === current)) return [...options];
  if (current === "") return [{ value: "", label: "None" }, ...options];
  return [{ value: current, label: `${current} — missing`, hint: "What this points at is gone. Pick another." }, ...options];
}

export function ValueField({
  clip,
  canKey,
  path,
  kind,
  label,
  options,
  optionPreview,
  empty,
  picture,
  base,
  min,
  max,
  step,
  unit,
  hint,
  bipolar,
  layout = "editor",
  defaultValue,
  modulatable = true,
  modulatorHost,
  mixed,
  onChange,
}: ValueFieldProps) {
  const doc = useDoc();
  // Keying needs a clip to key ON; without one the row is a plain control.
  // A REFERENCE is a pick, never a key (there is no halfway between two layers).
  const keyable = canKey && clip !== null && !isReferenceField(kind);
  const clipHost = useClipModulatorHost(keyable ? clip : null);
  const modulatorHostResolved = modulatorHost ?? clipHost;
  const shown = useEffectiveValue(keyable ? clip : undefined, path, base);
  const keyControl = keyable ? (
    <KeyControl
      clip={clip}
      property={path}
      currentValue={() => (kind === "color" ? resolveColor(doc, String(shown)) : shown)}
    />
  ) : undefined;
  const precision = step !== undefined && step < 1 ? (step < 0.05 ? 2 : 1) : 0;

  const control =
    kind === "image" ? (
      <ImageWell value={String(shown ?? "")} empty={empty} picture={picture} mixed={mixed} label={label} onChange={(v) => onChange(v)} />
    ) : kind === "color" ? (
      <DocColorInput value={String(shown)} mixed={mixed} onChange={(c) => onChange(c)} />
    ) : kind === "layer" ? (
      <LayerPicker clip={clip} value={String(shown ?? "")} empty={empty} onChange={(v) => onChange(v)} />
    ) : kind === "ref" ? (
      // A REFERENCE the host lists (a pose set, a pose, a bone, a voice). Radix
      // reserves "" for "no value", so the empty choice rides a sentinel.
      <Select value={mixed ? undefined : String(shown ?? "") || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
        <SelectTrigger className={cn("h-7 w-full text-[12px]", mixed && "text-muted-foreground/70")}>
          <SelectValue placeholder="Mixed" />
        </SelectTrigger>
        <SelectContent className="max-w-72">
          {refChoices(options ?? [], mixed ? null : String(shown ?? "")).map((o) => (
            <SelectItem key={o.value || NONE} value={o.value || NONE} className="text-[12px]" description={o.hint}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : kind === "select" ? (
      <Select value={mixed ? "" : String(shown)} onValueChange={(v) => onChange(v)}>
        <SelectTrigger className={cn("h-7 w-full text-[12px]", mixed && "text-muted-foreground/70")}>
          <SelectValue placeholder="Mixed" />
        </SelectTrigger>
        <SelectContent className="max-w-72">
          {(options ?? []).map((o) => (
            // `description`, not nested markup: the hint belongs to the MENU.
            // Stacking it inside the item's text is what used to make every
            // enum row in the app render as a two-line trigger.
            <SelectItem key={o.value} value={o.value} className="text-[12px]" description={o.hint}>
              {optionPreview === "material" ? (
                <span className="flex items-center gap-2">
                  <MaterialSwatch material={o.value} />
                  {o.label}
                </span>
              ) : (
                o.label
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <NumberInput
        value={Number(shown)}
        min={min}
        max={max}
        step={step}
        unit={unit}
        precision={precision}
        mixed={mixed}
        onChange={(v) => onChange(v)}
      />
    );

  // Right-click any value row for the full binding vocabulary. `ValueField` is
  // behind every effect field in the app, so this one mount is what makes
  // "make this dynamic" available on all of them at once.
  // The inspector layout goes through `PropRow`, which mounts the binding menu
  // for every inspector at once — wrapping again would nest two context menus.
  // The editor layout builds its own grid, so it wraps its own control.
  const input =
    keyable && layout === "editor" ? (
      <PropertyBindingMenu
        clip={clip}
        path={path}
        kind={kind}
        label={label}
        literal={shown as string | number}
      >
        <div className="min-w-0 flex-1">{control}</div>
      </PropertyBindingMenu>
    ) : (
      control
    );

  // Only NUMBERS can be modulated: there is no meaningful signal to add to a
  // colour or to an enum, and offering the control there would be a promise the
  // renderer can't keep.
  const mod =
    modulatable && kind === "number" && modulatorHostResolved ? (
      <ModulatorControl host={modulatorHostResolved} path={path} label={label} field={{ min, max }} />
    ) : null;

  const canSlide = kind === "number" && min !== undefined && max !== undefined;
  if (layout === "inspector") {
    return (
      <PropRow label={label} hint={hint} keyControl={keyControl}>
        {canSlide ? (
          <Range
            className={cn("w-full", mixed && "opacity-50")}
            value={Number(shown)}
            min={min!}
            max={max!}
            step={step ?? 0.01}
            unit={unit}
            precision={precision}
            origin={bipolar ? 0 : undefined}
            defaultValue={typeof defaultValue === "number" ? defaultValue : undefined}
            aria-label={label}
            onChange={onChange}
          />
        ) : (
          input
        )}
      </PropRow>
    );
  }

  return (
    <EditorRow
      label={label}
      hint={hint}
      onReset={defaultValue !== undefined ? () => onChange(defaultValue) : undefined}
      trailing={
        <>
          {mod}
          {keyControl ?? null}
        </>
      }
    >
      {canSlide && (
        // ONE Range for every effect/inspector field in the app: this is the
        // single renderer they all funnel through, so the control's design
        // lives in one component instead of in each panel that grew a track.
        <Range
          className={cn("min-w-0 flex-1", mixed && "opacity-50")}
          value={Number(shown)}
          min={min!}
          max={max!}
          step={step ?? 0.01}
          origin={bipolar ? 0 : undefined}
          hideValue
          aria-label={label}
          onChange={onChange}
        />
      )}
      <div className={cn("shrink-0", canSlide ? "w-[74px]" : "flex-1")}>{input}</div>
    </EditorRow>
  );
}

/**
 * THE row grammar of the wide editor layout — the floating effect window and
 * every panel that lays fields out at that width.
 *
 * `PropRow` is the sidebar's grammar (56px label · fluid · 20px keyframe
 * gutter); this is the same idea at editor width, and it exists for the same
 * reason `PropRow` does. The toggle rows in the effect window used to declare
 * their own grid — the same three columns, but with an empty spacer in the
 * control column and the switch in the trailing one — so "Bulge" and "Edge
 * only" sat hard against the right edge of the window while every slider above
 * them started at the same x and ended 52px short of it. Two rows in one panel,
 * disagreeing about where a control begins, is a layout with two authors.
 *
 * There is now one author. A control — a slider, a colour, a select, a SWITCH —
 * starts at the control column. The trailing 52px is reserved whether or not
 * anything is in it, so a row with a keyframe diamond and a row without keep
 * the same field width. That is the whole contract, and it holds for anything
 * added to a window tomorrow.
 */
export function EditorRow({
  label,
  hint,
  onReset,
  trailing,
  children,
}: {
  label: string;
  hint?: string;
  /** Double-clicking the label restores the default. Omit for no reset. */
  onReset?: () => void;
  /** The reserved 52px gutter — modulator badge, keyframe diamond, nothing. */
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="group/row grid grid-cols-[86px_minmax(0,1fr)_52px] items-center gap-2">
      <FieldLabel label={label} hint={hint} resettable={!!onReset} onReset={() => onReset?.()} />
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      <div className="flex shrink-0 items-center justify-end gap-0.5">{trailing}</div>
    </div>
  );
}

/** Label with an optional hint tooltip and a double-click reset. */
function FieldLabel({
  label,
  hint,
  resettable,
  onReset,
}: {
  label: string;
  hint?: string;
  resettable: boolean;
  onReset: () => void;
}) {
  const el = (
    <span
      onDoubleClick={resettable ? onReset : undefined}
      title={resettable && !hint ? "Double-click to reset" : undefined}
      className={cn(
        "truncate text-[12px] text-muted-foreground",
        resettable && "cursor-default select-none hover:text-foreground",
        hint && "decoration-muted-foreground/40 underline-offset-4 hover:underline",
      )}
    >
      {label}
    </span>
  );
  if (!hint) return el;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{el}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-64 text-[11px] leading-relaxed">
        {hint}
        {resettable && <span className="block pt-1 opacity-60">Double-click the label to reset</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A REFERENCE to another layer of the same comp (a modifier's path, surface or
 * controller): any other visual, non-group layer there — picked from the list
 * or pointed at.
 */
function LayerPicker({ clip, value, empty, onChange }: { clip: Clip | null; value: string; empty?: string; onChange: (id: string) => void }) {
  const filter = React.useMemo<PickFilter>(
    () => ({ kinds: ["layer"], frameId: clip?.frameId, tags: ["visual"], exclude: clip ? [clip.id] : [], predicate: (c) => c.clip?.kind !== "group" }),
    [clip],
  );
  return <LayerRefField filter={filter} value={value || null} none={empty} onChange={(id) => onChange(id ?? "")} disabled={!clip} />;
}
