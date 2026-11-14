"use client";

import * as React from "react";
import { brushMod, type BrushMod, type BrushModSource, type BrushModTarget } from "@solomotion/core";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Dial, Group, Hint, type StudioProps } from "./controls";

/**
 * THE DYNAMICS EDITOR — where a brush stops being a shape and starts being an
 * instrument.
 *
 * A modulation reads as one sentence — *size, from pressure, by 80%* — and the
 * row is laid out to be read that way, because the alternative (a grid of
 * numbers under headings) makes you translate before you can think. Two dropdowns
 * and a signed dial is the whole grammar, and it is the same grammar for the
 * eleventh mod as for the first.
 *
 * The starters below matter more than they look. A list-of-anything is
 * infinitely capable and completely unhelpful on an empty state — nobody's first
 * question is "which of seven sources shall I bind to which of eleven targets".
 * It is "make this react to pressure". So the add menu is a shelf of the
 * combinations that MEAN something, named by what they do to the mark, with the
 * raw pairing still one click further on.
 */

const TARGET_LABEL: Record<BrushModTarget, string> = {
  size: "Size",
  opacity: "Opacity",
  flow: "Flow",
  roundness: "Roundness",
  grain: "Grain",
  angle: "Angle",
  scatter: "Scatter",
  jitter: "Jitter",
  hue: "Hue",
  saturation: "Saturation",
  lightness: "Lightness",
};

const SOURCE_LABEL: Record<BrushModSource, string> = {
  pressure: "Pressure",
  tilt: "Tilt",
  velocity: "Speed",
  direction: "Direction",
  random: "Random",
  strokeT: "Along stroke",
  time: "Time",
};

const SOURCE_HINT: Record<BrushModSource, string> = {
  pressure: "How hard the pen is pressed.",
  tilt: "How far the pen is laid over — the side of the lead.",
  velocity: "How fast the hand is moving. Invert it for ink that thins as you accelerate.",
  direction: "Which way the stroke is heading.",
  random: "A fresh value every stamp. What makes scattered marks stop looking cloned.",
  strokeT: "0 at the start of the stroke, 1 at the end. Ribbons, comets, fades.",
  time: "Seconds since the stroke began.",
};

/** Targets that SCALE the value; the rest offset it. Mirrors the engine. */
const MULTIPLICATIVE = new Set<BrushModTarget>(["size", "opacity", "flow", "roundness", "grain"]);

/** The combinations worth naming — the add menu's top shelf. */
const STARTERS: Array<{ label: string; hint: string; mod: () => BrushMod }> = [
  { label: "Press harder, thicker", hint: "The response nearly every hand-held tool has.", mod: () => brushMod("size", "pressure", 0.85, { floor: 0.15 }) },
  { label: "Press harder, darker", hint: "Dry media and washes — not pens, which run at full ink.", mod: () => brushMod("opacity", "pressure", 0.8, { floor: 0.05 }) },
  { label: "Tilt to shade", hint: "Widens the tip as the pen lies over, like the side of a pencil.", mod: () => brushMod("size", "tilt", 0.6) },
  { label: "Faster, thinner", hint: "Ink drags out to a hairline when the hand accelerates.", mod: () => brushMod("size", "velocity", -0.6, { floor: 0.2 }) },
  { label: "Rotate every stamp", hint: "Stops a scatter brush reading as one shape repeated.", mod: () => brushMod("angle", "random", 1) },
  { label: "Vary every size", hint: "Debris, foliage, snow — nature is never one size.", mod: () => brushMod("size", "random", 0.6, { floor: 0.3 }) },
  { label: "Shift the colour", hint: "A little hue per stamp reads as many objects, not many copies.", mod: () => brushMod("hue", "random", 0.15) },
  { label: "Fade along the stroke", hint: "Ribbons and trails that thin out as they travel.", mod: () => brushMod("opacity", "strokeT", -1, { floor: 0.05 }) },
];

export function DynamicsEditor({ brush, patch }: StudioProps) {
  const mods = brush.dynamics.mods;

  const update = (id: string, fn: (m: BrushMod) => void) =>
    patch((b) => {
      const m = b.dynamics.mods.find((x) => x.id === id);
      if (m) fn(m);
    });

  return (
    <>
      <Group title="Paint" hint="How much pigment one stamp carries, before anything modulates it.">
        <Dial
          label="Flow"
          hint="Paint laid down per stamp. Opacity is the ceiling the stroke builds toward; flow is how fast it gets there."
          percent
          min={0.01}
          value={brush.dynamics.flow}
          defaultValue={1}
          onChange={(v) => patch((b) => void (b.dynamics.flow = v))}
        />
      </Group>

      <section>
        <div className="mb-2 flex items-center gap-1.5">
          <h3 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Modulation
          </h3>
          <AddModMenu onAdd={(mod) => patch((b) => void b.dynamics.mods.push(mod))} />
        </div>

        {mods.length === 0 ? (
          <p className="rounded-[--radius] border border-dashed border-border/70 px-3 py-6 text-center text-[11px] text-muted-foreground">
            A brush with no modulation paints the same mark every time.
          </p>
        ) : (
          <div className="space-y-1.5">
            {mods.map((mod) => (
              <ModCard
                key={mod.id}
                mod={mod}
                onChange={(fn) => update(mod.id, fn)}
                onRemove={() =>
                  patch((b) => void (b.dynamics.mods = b.dynamics.mods.filter((m) => m.id !== mod.id)))
                }
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function AddModMenu({ onAdd }: { onAdd: (mod: BrushMod) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost" className="gap-1 text-[11px]">
          <Plus className="size-3" /> Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide">Common</DropdownMenuLabel>
        {STARTERS.map((s) => (
          <DropdownMenuItem key={s.label} onClick={() => onAdd(s.mod())} title={s.hint}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs">{s.label}</span>
              <span className="truncate text-[10px] text-muted-foreground">{s.hint}</span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide">Anything else</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => onAdd(brushMod("size", "pressure", 0.5))}>
          Empty modulation…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One modulation, read as a sentence and edited in place. */
function ModCard({
  mod,
  onChange,
  onRemove,
}: {
  mod: BrushMod;
  onChange: (fn: (m: BrushMod) => void) => void;
  onRemove: () => void;
}) {
  const scales = MULTIPLICATIVE.has(mod.target);
  return (
    <div className="rounded-[--radius] border border-border/60 bg-[--panel] p-2">
      <div className="mb-1.5 flex items-center gap-1 text-xs">
        <Picker
          value={mod.target}
          options={Object.entries(TARGET_LABEL).map(([v, label]) => ({ v: v as BrushModTarget, label }))}
          onChange={(v) => onChange((m) => void (m.target = v))}
        />
        <span className="shrink-0 text-muted-foreground">←</span>
        <Picker
          value={mod.source}
          options={Object.entries(SOURCE_LABEL).map(([v, label]) => ({
            v: v as BrushModSource,
            label,
            hint: SOURCE_HINT[v as BrushModSource],
          }))}
          onChange={(v) => onChange((m) => void (m.source = v))}
        />
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Remove modulation"
          onClick={onRemove}
          className="rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="space-y-1.5">
        <Dial
          label="Amount"
          hint="Depth of the effect. Negative inverts the signal — thinner when fast rather than thicker."
          value={mod.amount}
          min={-1}
          max={1}
          origin={0}
          ticks={[-1, 0, 1]}
          defaultValue={1}
          percent
          onChange={(v) => onChange((m) => void (m.amount = v))}
        />
        <Dial
          label="Response"
          hint="Below 1 reacts early — a soft touch already does something. Above 1 reacts late, which feels firm."
          value={mod.gamma}
          min={0.1}
          max={4}
          step={0.05}
          precision={2}
          ticks={[1]}
          defaultValue={1}
          onChange={(v) => onChange((m) => void (m.gamma = v))}
        />
        {scales && (
          <Dial
            label="Floor"
            hint="How much survives at zero signal — a feather touch still leaves a mark."
            value={mod.floor}
            percent
            defaultValue={0}
            onChange={(v) => onChange((m) => void (m.floor = v))}
          />
        )}
      </div>
    </div>
  );
}

/** A tiny inline enum picker — the mod sentence's two nouns. */
function Picker<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ v: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="h-6 shrink-0 rounded-[--radius] border border-border/70 px-1.5 text-[11px] transition-colors hover:bg-muted/50"
        >
          {options.find((o) => o.v === value)?.label ?? value}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-48">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.v}
            onClick={() => onChange(o.v)}
            className={cn(o.v === value && "text-primary")}
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-xs">{o.label}</span>
              {o.hint && <span className="truncate text-[10px] text-muted-foreground">{o.hint}</span>}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

