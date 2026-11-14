"use client";

import * as React from "react";
import {
  coerceInputValue,
  defineInput,
  inputBindings,
  inputDefault,
  inputPath,
  locateClip,
  removeInput,
  reorderInput,
  updateInput,
  writeChannel,
  type Frame,
  type InputDef,
  type InputType,
  type InputValue,
  type KeyframeValue,
  type NestedClip,
} from "@solomotion/core";
import { ChevronDown, ChevronUp, Plus, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RenameInput } from "@/components/ui/rename-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { PanelSection, PropRow } from "./controls";
import { ValueField } from "./value-field";
import { KeyControl } from "./keyframe-controls";
import { clipLocalClamped, commitProperty, useEffectiveValue } from "./animatable";

/**
 * COMPONENT INPUTS in the Design tab (docs/adr/characters/ux.md §2.2, §4.6).
 *
 *  - An INSTANCE shows its comp's inputs at the top, one control per type, each
 *    keyable like any field (they are ordinary `input.<id>` channels).
 *  - A linked instance FRAME shows the same controls, unkeyed (a frame has no
 *    tracks).
 *  - The DEFINITION (a component, or any comp with inputs) lists them: rename,
 *    type, default, reorder, delete. Fields join with right-click → Expose as input.
 *
 * All writes go through core (`inputs-ops.ts`, `commitProperty`), so the panel,
 * the agent verb and the field menu cannot disagree.
 */

const TYPE_LABEL: Record<InputType, string> = {
  number: "Number",
  bool: "Toggle",
  enum: "Choice",
  text: "Text",
  color: "Colour",
  trigger: "Trigger",
  layer: "Layer",
};
const TYPES = Object.keys(TYPE_LABEL) as InputType[];

// ── Values: one control per type ────────────────────────────────────────────

interface ValueRowProps {
  def: InputDef;
  /** Keyable instance, or null for a static host (a linked frame, a default). */
  clip: NestedClip | null;
  value: InputValue;
  onChange: (v: InputValue) => void;
  /** Trigger only: key a pulse at the playhead. */
  onFire?: () => void;
}

function InputValueRow({ def, clip, value, onChange, onFire }: ValueRowProps) {
  const path = inputPath(def.id);
  const label = def.name;
  switch (def.type) {
    case "number":
      return (
        <ValueField clip={clip} canKey={!!clip} path={path} kind="number" label={label} layout="inspector" base={value as number}
          min={def.min} max={def.max} step={def.step} defaultValue={def.default} onChange={(v) => onChange(coerceInputValue(def, v))} />
      );
    case "color":
      return <ValueField clip={clip} canKey={!!clip} path={path} kind="color" label={label} layout="inspector" base={String(value)} onChange={(v) => onChange(String(v))} />;
    case "enum":
      return (
        <ValueField clip={clip} canKey={!!clip} path={path} kind="select" label={label} layout="inspector" base={String(value)}
          options={(def.options ?? []).map((o) => ({ value: o, label: o }))} onChange={(v) => onChange(String(v))} />
      );
    case "layer":
      return <ValueField clip={clip} canKey={false} path={path} kind="layer" label={label} layout="inspector" base={String(value)} onChange={(v) => onChange(String(v))} />;
    case "bool":
      return (
        <KeyedRow clip={clip} path={path} label={label} value={value} toggle>
          <Switch checked={!!value} onCheckedChange={(on) => onChange(on)} aria-label={label} />
        </KeyedRow>
      );
    case "text":
      return (
        <KeyedRow clip={clip} path={path} label={label} value={value}>
          <TextValue value={String(value)} onCommit={onChange} />
        </KeyedRow>
      );
    case "trigger":
      return (
        <PropRow label={label}>
          <Button variant="secondary" size="sm" className="h-7 w-full" disabled={!onFire} onClick={onFire}>
            <Zap /> Fire
          </Button>
        </PropRow>
      );
  }
}

/** A row with the keyframe diamond for the controls `ValueField` does not cover. */
function KeyedRow({ clip, path, label, value, toggle, children }: { clip: NestedClip | null; path: string; label: string; value: KeyframeValue; toggle?: boolean; children: React.ReactNode }) {
  return (
    <PropRow label={label} toggle={toggle} keyControl={clip ? <KeyControl clip={clip} property={path} label={label} currentValue={() => value} /> : undefined}>
      {children}
    </PropRow>
  );
}

function TextValue({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  return (
    <Input
      className="h-7 text-[12px]"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** The value a keyable instance shows at the playhead (its keys, else its override, else the default). */
function InstanceValueRow({ def, clip }: { def: InputDef; clip: NestedClip }) {
  const store = useDocStore();
  const path = inputPath(def.id);
  const base = clip.inputValues?.[def.id] ?? inputDefault(def);
  const shown = useEffectiveValue(clip, path, base as KeyframeValue);
  const value = coerceInputValue(def, shown);
  const write = (v: InputValue) =>
    store.update(`Set ${def.name}`, (d) => {
      const c = locateClip(d, clip.id)?.clip;
      if (c) commitProperty(c, path, v, useSession.getState().playheadMs);
    });
  const fire = () =>
    store.update(`Fire ${def.name}`, (d) => {
      const c = locateClip(d, clip.id)?.clip;
      if (c) writeChannel(c, path, clipLocalClamped(c, useSession.getState().playheadMs), true, { forceKey: true });
    });
  return <InputValueRow def={def} clip={clip} value={value} onChange={write} onFire={fire} />;
}

/** An instance clip's inputs — the top of its Design tab. */
export function InstanceInputs({ clip }: { clip: NestedClip }) {
  const doc = useDoc();
  const store = useDocStore();
  const defs = doc.frames.find((f) => f.id === clip.sourceFrameId)?.inputs ?? [];
  if (defs.length === 0) return null;
  const changed = !!clip.inputValues || clip.keyframes.some((t) => t.property.startsWith("input."));
  const reset = () =>
    store.update("Reset inputs", (d) => {
      const c = locateClip(d, clip.id)?.clip;
      if (!c || c.kind !== "nested") return;
      delete c.inputValues;
      c.keyframes = c.keyframes.filter((t) => !t.property.startsWith("input."));
    });
  return (
    <PanelSection
      title="Inputs"
      collapsible={false}
      actions={changed ? <ResetLink onClick={reset} /> : undefined}
    >
      {defs.map((def) => <InstanceValueRow key={def.id} def={def} clip={clip} />)}
    </PanelSection>
  );
}

function ResetLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-[11px] text-muted-foreground transition-colors hover:text-foreground">
      Reset to default
    </button>
  );
}

// ── Frames: a linked instance's overrides, or the definition's list ─────────

/** The Inputs section for a frame: a linked instance's values, or the definition. */
export function FrameInputs({ frame }: { frame: Frame }) {
  const doc = useDoc();
  if (frame.instanceOf) {
    const master = doc.frames.find((f) => f.id === frame.instanceOf);
    return master?.inputs?.length ? <LinkedFrameInputs frame={frame} defs={master.inputs} /> : null;
  }
  if (frame.component == null && !frame.inputs?.length) return null;
  return <DefinitionInputs frame={frame} />;
}

function LinkedFrameInputs({ frame, defs }: { frame: Frame; defs: readonly InputDef[] }) {
  const store = useDocStore();
  const write = (def: InputDef, v: InputValue) =>
    store.update(`Set ${def.name}`, (d) => {
      const f = d.frames.find((x) => x.id === frame.id);
      if (f) f.inputValues = { ...f.inputValues, [def.id]: coerceInputValue(def, v) };
    });
  const reset = () =>
    store.update("Reset inputs", (d) => {
      const f = d.frames.find((x) => x.id === frame.id);
      if (f) delete f.inputValues;
    });
  return (
    <PanelSection title="Inputs" collapsible={false} actions={frame.inputValues ? <ResetLink onClick={reset} /> : undefined}>
      {defs.map((def) => (
        <InputValueRow key={def.id} def={def} clip={null} value={coerceInputValue(def, frame.inputValues?.[def.id] ?? inputDefault(def))} onChange={(v) => write(def, v)} />
      ))}
    </PanelSection>
  );
}

function DefinitionInputs({ frame }: { frame: Frame }) {
  const store = useDocStore();
  const defs = frame.inputs ?? [];
  const add = (type: InputType) =>
    store.update("Add input", (d) => {
      defineInput(d, frame.id, { type, name: TYPE_LABEL[type] });
    });
  return (
    <PanelSection
      title="Inputs"
      collapsible={false}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Add input" className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5">
              <Plus />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-32">
            {TYPES.map((t) => (
              <DropdownMenuItem key={t} onSelect={() => add(t)} className="text-[12px]">
                {TYPE_LABEL[t]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {defs.map((def, i) => (
        <DefinitionRow key={def.id} frame={frame} def={def} index={i} count={defs.length} />
      ))}
    </PanelSection>
  );
}

function DefinitionRow({ frame, def, index, count }: { frame: Frame; def: InputDef; index: number; count: number }) {
  const doc = useDoc();
  const store = useDocStore();
  const [renaming, setRenaming] = React.useState(false);
  const bound = inputBindings(doc, frame.id, def.id).length;
  const patch = (label: string, p: Partial<Omit<InputDef, "id">>) => store.update(label, (d) => void updateInput(d, frame.id, def.id, p));
  return (
    <div className="group/input space-y-1 rounded-md py-1">
      <div className="flex items-center gap-1">
        {renaming ? (
          <RenameInput
            initial={def.name}
            className="h-6 min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 text-[12px]"
            onCommit={(name) => {
              setRenaming(false);
              if (name.trim() && name !== def.name) patch("Rename input", { name });
            }}
          />
        ) : (
          <button type="button" className="min-w-0 flex-1 truncate text-left text-[12px]" onDoubleClick={() => setRenaming(true)} title={bound ? `${bound} bound` : undefined}>
            {def.name}
          </button>
        )}
        <Select value={def.type} onValueChange={(t) => patch("Change input type", { type: t as InputType })}>
          <SelectTrigger className="h-6 w-[84px] text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPES.map((t) => (
              <SelectItem key={t} value={t} className="text-[12px]">
                {TYPE_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex opacity-0 transition-opacity group-hover/input:opacity-100 focus-within:opacity-100">
          <IconBtn label="Move up" disabled={index === 0} onClick={() => store.update("Reorder inputs", (d) => void reorderInput(d, frame.id, def.id, index - 1))}>
            <ChevronUp />
          </IconBtn>
          <IconBtn label="Move down" disabled={index === count - 1} onClick={() => store.update("Reorder inputs", (d) => void reorderInput(d, frame.id, def.id, index + 1))}>
            <ChevronDown />
          </IconBtn>
          <IconBtn label="Delete input" onClick={() => store.update("Delete input", (d) => void removeInput(d, frame.id, def.id))}>
            <X />
          </IconBtn>
        </div>
      </div>
      {def.type === "enum" && (
        <PropRow label="Choices">
          <TextValue value={(def.options ?? []).join(", ")} onCommit={(v) => patch("Edit choices", { options: v.split(",").map((s) => s.trim()).filter(Boolean) })} />
        </PropRow>
      )}
      {def.type === "number" && (
        <PropRow label="Range">
          <div className="flex gap-1">
            <TextValue value={def.min === undefined ? "" : String(def.min)} onCommit={(v) => patch("Input range", { min: v.trim() === "" ? undefined : Number(v) })} />
            <TextValue value={def.max === undefined ? "" : String(def.max)} onCommit={(v) => patch("Input range", { max: v.trim() === "" ? undefined : Number(v) })} />
          </div>
        </PropRow>
      )}
      {def.type !== "trigger" && def.type !== "layer" && (
        <InputValueRow def={{ ...def, name: "Default" }} clip={null} value={coerceInputValue(def, def.default)} onChange={(v) => patch("Input default", { default: v })} />
      )}
    </div>
  );
}

function IconBtn({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 [&_svg]:size-3"
    >
      {children}
    </button>
  );
}
