"use client";

import * as React from "react";
import { AudioLines, ChevronDown, Layers, Plus, Trash2 } from "lucide-react";
import { locateClip, makeDuckRule, type DuckRule, type SoundTarget } from "@solomotion/core";
import { Range } from "@/components/ui/range";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDoc } from "../../state/document-context";
import { IconAction, PropRow } from "../controls";
import { BusDot } from "./CategoryPicker";
import { useSoundSources } from "./use-mix";

/**
 * DUCKING RULES — "this gets quieter while that plays". The same editor for a
 * category and a clip, because a rule is the same fact on either owner: a
 * trigger (a category, a layer, or a whole nested scene), how far down, how
 * fast out and back. The attack LOOKS AHEAD, so the default already has the
 * music moving before the first word lands.
 */
export function DuckingEditor({
  rules,
  owner,
  onChange,
}: {
  rules: readonly DuckRule[];
  /** What owns these rules — it can never duck under itself. */
  owner: SoundTarget;
  /** Replace the list (one undo step per call; pass a merge key for drags). */
  onChange: (label: string, next: DuckRule[], mergeKey?: string) => void;
}) {
  const doc = useDoc();
  const defaultTrigger: SoundTarget =
    owner.kind === "bus" && owner.id === "voice" ? { kind: "bus", id: "music" } : { kind: "bus", id: "voice" };

  const patch = (id: string, fn: (r: DuckRule) => DuckRule, label: string, mergeKey?: string) =>
    onChange(label, rules.map((r) => (r.id === id ? fn(r) : r)), mergeKey);

  return (
    <div className="space-y-2">
      {rules.map((rule) => (
        <div key={rule.id} className="space-y-1.5 rounded-md border border-border/60 p-2">
          <div className="flex items-center gap-1.5">
            <Switch
              checked={rule.enabled}
              onCheckedChange={(on) => patch(rule.id, (r) => ({ ...r, enabled: on }), on ? "Enable ducking" : "Bypass ducking")}
              aria-label="Ducking on"
            />
            <span className="shrink-0 text-[11px] text-muted-foreground">Under</span>
            <TriggerPicker
              value={rule.under}
              owner={owner}
              onPick={(under) => patch(rule.id, (r) => ({ ...r, under }), "Duck under")}
            />
            <IconAction label="Remove rule" onClick={() => onChange("Remove ducking", rules.filter((r) => r.id !== rule.id))}>
              <Trash2 />
            </IconAction>
          </div>
          <PropRow label="Depth">
            <Range
              value={rule.depthDb}
              min={0}
              max={40}
              step={0.5}
              precision={1}
              unit=" dB"
              defaultValue={12}
              ticks={[6, 12, 24]}
              format={(v) => `−${v.toFixed(1)} dB`}
              onChange={(v) => patch(rule.id, (r) => ({ ...r, depthDb: v }), "Ducking depth", "duck-depth")}
            />
          </PropRow>
          <PropRow label="Timing" hint="How fast it gets out of the way (it starts early), and how fast it comes back.">
            <div className="flex min-w-0 flex-1 gap-1.5">
              <NumberInput
                label="In"
                value={rule.attackMs}
                min={0}
                max={5000}
                precision={0}
                unit="ms"
                onChange={(v) => patch(rule.id, (r) => ({ ...r, attackMs: Math.max(0, v) }), "Ducking attack", "duck-attack")}
              />
              <NumberInput
                label="Out"
                value={rule.releaseMs}
                min={0}
                max={10000}
                precision={0}
                unit="ms"
                onChange={(v) => patch(rule.id, (r) => ({ ...r, releaseMs: Math.max(0, v) }), "Ducking release", "duck-release")}
              />
            </div>
          </PropRow>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange("Add ducking", [...rules, makeDuckRule(defaultTrigger)])}
        className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/70 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
      >
        <Plus className="size-3" />
        {rules.length ? "Another rule" : `Duck under ${nameOf(doc, defaultTrigger)}`}
      </button>
    </div>
  );
}

function nameOf(doc: ReturnType<typeof useDoc>, t: SoundTarget): string {
  if (t.kind === "bus") return doc.soundBuses.find((b) => b.id === t.id)?.name ?? "a category";
  return locateClip(doc, t.id)?.clip.name ?? "a layer";
}

function TriggerPicker({
  value,
  owner,
  onPick,
}: {
  value: SoundTarget;
  owner: SoundTarget;
  onPick: (t: SoundTarget) => void;
}) {
  const doc = useDoc();
  const sources = useSoundSources();
  const same = (t: SoundTarget) => t.kind === owner.kind && t.id === owner.id;
  const bus = value.kind === "bus" ? doc.soundBuses.find((b) => b.id === value.id) : null;
  const layers = React.useMemo(
    () =>
      sources
        .map((id) => locateClip(doc, id)?.clip)
        .filter((c): c is NonNullable<typeof c> => !!c && !(owner.kind === "clip" && c.id === owner.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [doc, sources, owner],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-input/35 px-2 text-xs transition-colors hover:bg-input/55"
        >
          {bus ? <BusDot color={bus.color} /> : <Layers className="size-3 shrink-0 opacity-70" />}
          <span className="flex-1 truncate text-left">{nameOf(doc, value)}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Category</DropdownMenuLabel>
        {doc.soundBuses
          .filter((b) => !same({ kind: "bus", id: b.id }))
          .map((b) => (
            <DropdownMenuItem key={b.id} onSelect={() => onPick({ kind: "bus", id: b.id })}>
              <BusDot color={b.color} />
              {b.name}
            </DropdownMenuItem>
          ))}
        {layers.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Layer</DropdownMenuLabel>
            {layers.map((c) => (
              <DropdownMenuItem key={c.id} onSelect={() => onPick({ kind: "clip", id: c.id })}>
                {c.kind === "nested" ? <Layers className="size-3.5" /> : <AudioLines className="size-3.5" />}
                <span className="truncate">{c.name}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
