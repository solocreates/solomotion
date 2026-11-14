"use client";

import * as React from "react";
import {
  MODULATOR_FIELDS,
  MODULATOR_GROUPS,
  applyModulators,
  createModulator,
  evaluateModulator,
  locateClip,
  modulatorPath,
  modulatorsFor,
  ENABLED_FIELD,
  type Clip,
  type EffectFieldDef,
  type KeyframeValue,
  type Modulator,
} from "@solomotion/core";
import { Activity, ChevronRight, Copy, ClipboardPaste, CopyPlus as Duplicate, Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDocStore } from "../state/document-context";
import { useParkedPlayhead } from "../state/session";
import { copyModulators, readModulators, toPatch, useCanPasteModulator } from "./modulator-clipboard";
import { GroupKeyButton, KeyedDot, SwitchKeyMenu, useSwitchKey } from "./keyframe-controls";
import { ValueField } from "./value-field";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * THE modulator control — the little pulse badge that sits on EVERY numeric
 * field row in the app, and the popover behind it.
 *
 * The point of this component is how little it knows. It takes a property path
 * and the field's declared range, and it edits `clip.modulators` — a list of
 * records addressed by that same path grammar keyframes and node drivers use.
 * It has never heard of grain, scanlines, shadows or opacity, which is exactly
 * why binding a wiggle to a brand-new effect's field needs no code here.
 *
 * The modulator's own editor is generated from `MODULATOR_FIELDS` (core) via
 * the same `ValueField` rows that render an effect — so a modulator's rate can
 * itself be keyframed, reset by double-click and scrubbed, for free. A
 * modulator IS the same shape of thing as an effect: a named record of
 * declared, keyframable fields. Giving it a second, parallel editor would have
 * been two implementations of one idea.
 *
 * ── Managing them ──────────────────────────────────────────────────────────
 * A modulator is a LIST ITEM, so it gets what every list item in this app gets:
 * a right-click menu on the thing itself, and a header row that COLLAPSES.
 *
 * The header carries exactly two controls, and which two is the whole point:
 * a keyframe diamond and the on/off switch. Copy and Duplicate used to sit
 * there as a pair of near-identical icons, which is two buttons spent on the
 * two rarest verbs while the two you reach for constantly — "when does this
 * run" and "is it on" — had no home at all. They moved to the card's
 * right-click menu, beside Reset and Remove, where rare verbs belong.
 *
 * Cards are COLLAPSED by default and only one opens at a time: three unrolled
 * modulators is fifty rows in a 340px popover, and the one you are tuning is
 * never the one on screen.
 *
 * Copy/paste moves the SETTING, not the record: see `modulator-clipboard`.
 *
 * Affordance rules, because a control on every row must not become noise:
 *  · unmodulated → the badge is invisible until the row is hovered or focused;
 *  · modulated   → it is always visible and tinted, and it PULSES with the live
 *    signal, so you can see the thing is moving without leaving the panel.
 */

/**
 * WHO OWNS THE MODULATOR LIST.
 *
 * A clip owns one. A document VARIABLE owns one — a shared accent colour that
 * breathes, a shared gradient whose angle shakes — and they are the same list
 * of the same records addressed by the same path grammar. So this control takes
 * a host, exactly as the paint and stroke editors do, rather than a clip; the
 * alternative was a second modulator popover that would have re-earned the
 * card, the copy/paste, the live pulse and the generated editor by hand.
 *
 * `clip` is the ONLY thing that differs, and it is present or it is not: a
 * clip's modulator can itself be keyframed against that clip's timeline, and a
 * variable's has no clip to be keyed against. Every surface reads that one
 * field rather than carrying a `canKey` flag someone has to remember to pass.
 */
export interface ModulatorHost {
  modulators: Modulator[] | undefined;
  /** Edit the list as one undoable step. The host removes an emptied array. */
  write: (label: string, fn: (list: Modulator[]) => void, mergeKey?: string) => void;
  /** The clock modulators read, in seconds. A clip's is clip-local; a
   *  document-level owner's is the raw playhead. */
  timeSec: (playheadMs: number) => number;
  /** Present only when the host can keyframe the MODULATOR's own fields. */
  clip?: Clip;
  /**
   * Map a row's property path to the TARGET path this host stores modulators
   * against. A clip stores them under the same path the row uses; a variable's
   * paint editor speaks `fill.<id>.<sub>` while the variable stores
   * `value.<sub>`. Translating here rather than at the call site is what keeps
   * a wiggle from targeting a path nothing reads.
   */
  target?: (path: string) => string;
}

/**
 * A clip as a modulator host — the everyday case. Takes `null` and returns
 * null so a row that has no clip can still call it unconditionally: hooks may
 * not be called in a branch, and a sentinel clip would have been a fake object
 * threaded through real code paths.
 */
export function useClipModulatorHost(clip: Clip | null): ModulatorHost | undefined {
  const store = useDocStore();
  return React.useMemo(
    () =>
      clip
        ? {
            modulators: clip.modulators,
            clip,
            timeSec: (playheadMs: number) => Math.max(0, playheadMs - clip.startMs) / 1000,
            write: (label: string, fn: (list: Modulator[]) => void, mergeKey?: string) =>
              store.update(
                label,
                (d) => {
                  const loc = locateClip(d, clip.id);
                  if (!loc) return;
                  loc.clip.modulators ??= [];
                  fn(loc.clip.modulators);
                  // Never leave an empty array behind: `modulators` is optional
                  // precisely so a clip with none carries nothing into the file.
                  if (loc.clip.modulators.length === 0) delete loc.clip.modulators;
                },
                mergeKey ? { mergeKey } : undefined,
              ),
          }
        : undefined,
    [store, clip],
  );
}

export function ModulatorControl({
  host,
  path,
  label,
  field,
}: {
  host: ModulatorHost;
  path: string;
  label: string;
  /** The target field's declared range — sizes a sensible default amplitude. */
  field?: Pick<EffectFieldDef, "min" | "max">;
}) {
  const clip = host.clip ?? null;
  const target = host.target ? host.target(path) : path;
  const mods = modulatorsFor(host.modulators, target);
  const [open, setOpen] = React.useState(false);
  // ONE card open at a time. Three modulators unrolled at once is fifty rows in
  // a 340px popover — you scroll it instead of reading it, and the card you are
  // actually tuning is never the one on screen. Collapsed is the resting state;
  // a freshly added or pasted modulator opens itself, because that is the one
  // you just asked for.
  const [openCard, setOpenCard] = React.useState<string | null>(null);
  const canPaste = useCanPasteModulator();

  const write = host.write;

  const add = (thenOpen = true) => {
    const created = createModulator(target, field);
    write(`Modulate ${label}`, (list) => list.push(created));
    setOpenCard(created.id);
    if (thenOpen) setOpen(true);
  };

  /** Paste lands as NEW modulators on this path — settings, fresh ids. */
  const paste = async () => {
    const patches = await readModulators();
    if (!patches?.length) return;
    let lastId: string | null = null;
    write(`Paste modulator on ${label}`, (list) => {
      for (const patch of patches) {
        const made = { ...createModulator(target, field), ...patch, target } as Modulator;
        lastId = made.id;
        list.push(made);
      }
    });
    setOpenCard(lastId);
    setOpen(true);
  };

  const removeAll = () =>
    write(`Remove modulators on ${label}`, (list) => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.target === target) list.splice(i, 1);
    });

  // The same menu whether or not the field is modulated yet — a right-click
  // that does nothing on an empty row would be the worse half of the feature.
  const menu = (
    <ContextMenuContent className="w-52">
      <ContextMenuItem onClick={() => add()}>
        <Plus /> {mods.length === 0 ? "Modulate this" : "Add another"}
      </ContextMenuItem>
      {mods.length > 0 && (
        <ContextMenuItem onClick={() => copyModulators(mods)}>
          <Copy /> Copy{mods.length > 1 ? ` ${mods.length}` : ""}
        </ContextMenuItem>
      )}
      <ContextMenuItem disabled={!canPaste} onClick={() => void paste()}>
        <ClipboardPaste /> Paste
      </ContextMenuItem>
      {mods.length > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={removeAll} className="text-destructive focus:text-destructive">
            <Trash2 /> Remove {mods.length > 1 ? "all" : ""}
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );

  if (mods.length === 0) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Modulate ${label}`}
            title={`Modulate ${label} — make it move on its own. Right-click for more.`}
            onClick={() => add()}
            className="flex size-4 items-center justify-center rounded text-muted-foreground/0 transition-colors group-hover/row:text-muted-foreground/60 hover:!text-foreground focus-visible:text-foreground focus-visible:outline-none [&_svg]:size-3"
          >
            <Activity />
          </button>
        </ContextMenuTrigger>
        {menu}
      </ContextMenu>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Edit modulator on ${label}`}
              title={`${mods.length} modulator${mods.length > 1 ? "s" : ""} on ${label} — right-click to copy or remove`}
              className="flex size-4 items-center justify-center rounded text-primary transition-colors hover:text-foreground [&_svg]:size-3"
            >
              <LiveIcon host={host} mods={mods} path={target} />
            </button>
          </PopoverTrigger>
        </ContextMenuTrigger>
        {menu}
      </ContextMenu>

      <PopoverContent align="end" side="left" className="w-[340px] p-0" data-wheel-scroll>
        <div className="flex items-center gap-1 border-b border-border/60 px-2.5 py-1.5">
          <Activity className="size-3 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <IconButton label="Paste modulator" disabled={!canPaste} onClick={() => void paste()}>
            <ClipboardPaste />
          </IconButton>
          <IconButton label="Copy all" onClick={() => copyModulators(mods)}>
            <Copy />
          </IconButton>
          <IconButton label="Add another modulator" onClick={() => add(false)}>
            <Plus />
          </IconButton>
        </div>
        <ScrollArea className="max-h-[min(64vh,460px)]" viewportClassName="p-2.5" contentClassName="space-y-2">
          {mods.map((m, i) => (
            <ModulatorBody
              key={m.id}
              clip={clip}
              modulator={m}
              index={i}
              showIndex={mods.length > 1}
              expanded={openCard === m.id}
              onToggleExpanded={() => setOpenCard((cur) => (cur === m.id ? null : m.id))}
              onPatch={(patch, undoLabel, mergeKey) =>
                write(
                  undoLabel,
                  (list) => {
                    const target = list.find((x) => x.id === m.id);
                    if (target) Object.assign(target, patch);
                  },
                  mergeKey,
                )
              }
              onDuplicate={() =>
                write(`Duplicate modulator on ${label}`, (list) => {
                  const at = list.findIndex((x) => x.id === m.id);
                  const copy = { ...createModulator(path, field), ...toPatch(m), target: path } as Modulator;
                  list.splice(at + 1, 0, copy);
                })
              }
              onCopy={() => copyModulators([m])}
              onRemove={() =>
                write(`Remove modulator on ${label}`, (list) => {
                  const at = list.findIndex((x) => x.id === m.id);
                  if (at >= 0) list.splice(at, 1);
                })
              }
              onReset={() =>
                write(`Reset modulator on ${label}`, (list) => {
                  const target = list.find((x) => x.id === m.id);
                  if (target) Object.assign(target, createModulator(path, field), { id: target.id });
                })
              }
            />
          ))}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The badge, breathing with the live signal. It reads the playhead (which the
 * panel already subscribes to) rather than running its own rAF — a per-row
 * animation loop on a panel that can hold a hundred rows is exactly the kind of
 * thing the performance contract forbids.
 */
/** The switch's keyframe menu, where there is a timeline to key against. Where
 *  there is not, the switch is just a switch — a menu whose every item is
 *  disabled is worse than no menu. */
function MaybeSwitchKeyMenu({
  clip,
  property,
  on,
  children,
}: {
  clip: Clip | null;
  property: string;
  on: boolean;
  children: React.ReactNode;
}) {
  if (!clip) return <>{children}</>;
  return (
    <SwitchKeyMenu clip={clip} property={property} on={on}>
      {children}
    </SwitchKeyMenu>
  );
}

function LiveIcon({ host, mods, path }: { host: ModulatorHost; mods: Modulator[]; path: string }) {
  const playheadMs = useParkedPlayhead();
  const t = host.timeSec(playheadMs);
  // Normalize the combined signal against its own amplitude so the badge reads
  // the same whether it is nudging an opacity or shaking a position by 200px.
  const span = mods.reduce((sum, m) => sum + Math.abs(m.amount), 0) || 1;
  const signal = Math.max(-1, Math.min(1, (applyModulators(mods, path, 0, t) - 0) / span));
  return (
    <Activity
      style={{ transform: `scale(${1 + signal * 0.28})`, opacity: 0.65 + Math.abs(signal) * 0.35 }}
      className="transition-none"
    />
  );
}

function ModulatorBody({
  clip,
  modulator,
  index,
  showIndex,
  expanded,
  onToggleExpanded,
  onPatch,
  onCopy,
  onDuplicate,
  onRemove,
  onReset,
}: {
  clip: Clip | null;
  modulator: Modulator;
  index: number;
  showIndex: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onPatch: (patch: Partial<Modulator>, label: string, mergeKey?: string) => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onReset: () => void;
}) {
  const defaults = React.useMemo(
    () => createModulator(modulator.target) as unknown as Record<string, KeyframeValue>,
    [modulator.target],
  );
  // Shape-specific rows stay hidden rather than greyed: a Duty slider on a sine
  // is not a disabled control, it is a control that does not exist there.
  const relevant = MODULATOR_FIELDS.filter((f) => {
    if (f.key === "duty") return modulator.shape === "pulse";
    if (f.key === "octaves" || f.key === "roughness") return modulator.shape === "wiggle";
    if (f.key === "stutter" || f.key === "jitter") return modulator.shape !== "wave" && modulator.shape !== "ramp";
    return true;
  });

  // The switch is a KEYFRAMABLE property like every other field of the card —
  // `mod.<id>.enabled`, a discrete boolean that holds between keys. That is what
  // makes "the shake starts at 00:02 and stops at 00:05" two keys rather than
  // two duplicate modulators with amplitude ramps, and it needed no new concept:
  // see `animation/activeness.ts`.
  const enablePath = modulatorPath(modulator.id, ENABLED_FIELD);
  const { on, keyed, setOn } = useSwitchKey(clip ?? undefined, enablePath, modulator.enabled, "Toggle modulator");
  // A modulator owned by something without a timeline (a document variable) has
  // no clip to key its own switch against, so the switch writes the plain flag.
  // The signal still runs — it reads the document playhead — it simply cannot
  // be scheduled, which is the honest difference and not a missing feature.
  const setEnabled = clip ? setOn : (v: boolean) => onPatch({ enabled: v }, "Toggle modulator");
  const off = !on;

  // ONE diamond for the whole card — it keys every field the card is showing,
  // which is the same contract a section header's diamond has everywhere else.
  const groupProps = relevant.map((f) => ({
    property: modulatorPath(modulator.id, f.key),
    currentValue: () => (modulator as unknown as Record<string, KeyframeValue>)[f.key]!,
  }));

  const header = (
    <div className="group/row flex items-center gap-1.5 px-2 py-1.5">
      <button
        type="button"
        aria-label={expanded ? "Collapse modulator" : "Expand modulator"}
        onClick={onToggleExpanded}
        className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground [&_svg]:size-3"
      >
        <ChevronRight className={cn("transition-transform", expanded && "rotate-90")} />
      </button>
      {showIndex && (
        <span className="shrink-0 rounded bg-muted/60 px-1 text-[9.5px] tabular-nums text-muted-foreground">
          {index + 1}
        </span>
      )}
      <button
        type="button"
        onClick={onToggleExpanded}
        className={cn(
          "min-w-0 flex-1 truncate text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground",
          off && "line-through opacity-60",
        )}
      >
        {describe(modulator)}
      </button>

      {/* The two controls the user actually reaches for on a card: when does it
          run, and is it on. Copy and Duplicate moved to the right-click menu —
          two buttons for two rare verbs was crowding out the two common ones. */}
      {clip && <GroupKeyButton clip={clip} properties={groupProps} />}
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="relative flex shrink-0 items-center"
            // Same nesting rule as the effect card's eye: the switch lives
            // inside the card's context menu, so its own right-click must not
            // bubble up into it.
            onContextMenu={(e) => e.stopPropagation()}
          >
            {/* The menu attaches to a WRAPPER, not to the Switch itself: Radix
                stamps its own `data-state` on an `asChild` target, which would
                overwrite the switch's checked/unchecked state and freeze the
                thumb. */}
            <MaybeSwitchKeyMenu clip={clip} property={enablePath} on={on}>
              <span className="flex items-center">
                <Switch
                  checked={on}
                  aria-label={on ? "Disable modulator" : "Enable modulator"}
                  className="scale-75"
                  onCheckedChange={setEnabled}
                />
              </span>
            </MaybeSwitchKeyMenu>
            {keyed && <KeyedDot className="-right-1 -top-0.5" />}
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">
          {keyed ? "Animated on/off — right-click for keyframe options" : "On/off · right-click to keyframe it"}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <IconButton label="Remove modulator" danger onClick={onRemove}>
              <Trash2 />
            </IconButton>
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">Remove · right-click the card for copy, duplicate and reset</TooltipContent>
      </Tooltip>
    </div>
  );

  return (
    <div className="rounded-md border border-border/50 bg-muted/20">
      <ContextMenu>
        <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={onCopy}>
            <Copy /> Copy modulator
          </ContextMenuItem>
          <ContextMenuItem onClick={onDuplicate}>
            <Duplicate /> Duplicate
          </ContextMenuItem>
          <ContextMenuItem onClick={onReset}>
            <RotateCcw /> Reset to defaults
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onRemove} className="text-destructive focus:text-destructive">
            <Trash2 /> Remove
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {expanded && (
        <div className={cn("space-y-1.5 border-t border-border/40 p-2", off && "opacity-50")}>
          {MODULATOR_GROUPS.map((group) => {
            const fields = relevant.filter((f) => f.group === group.id);
            if (fields.length === 0) return null;
            return (
              <Section key={group.id} label={group.label} defaultCollapsed={group.collapsed}>
                {fields.map((f) => (
                  <ValueField
                    key={f.key}
                    clip={clip}
                    canKey={!!clip}
                    // A modulator's own fields keyframe through `mod.<id>.<field>`,
                    // which is what makes "the shake ramps in and settles" a
                    // keyframe pair rather than a feature request.
                    path={modulatorPath(modulator.id, f.key)}
                    kind={f.kind}
                    options={f.options}
                    label={f.label}
                    unit={f.unit}
                    hint={f.hint}
                    bipolar={f.bipolar}
                    base={(modulator as unknown as Record<string, KeyframeValue>)[f.key]!}
                    defaultValue={defaults[f.key]}
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    // Modulators cannot be modulated: a signal driving a signal is
                    // what the node graph is for, and offering it here would be a
                    // recursion with no visible way out.
                    modulatable={false}
                    onChange={(v) => onPatch({ [f.key]: v } as Partial<Modulator>, `Modulator ${f.label}`, `mod-${modulator.id}-${f.key}`)}
                  />
                ))}
              </Section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A plain-English readout of what the modulator is doing — faster to scan than
 *  six sliders when you reopen a project a month later. */
function describe(m: Modulator): string {
  const verb = { add: "±", multiply: "×", replace: "=" }[m.compose];
  const hz = m.rate >= 1 ? `${Math.round(m.rate * 10) / 10}/s` : `every ${Math.round(10 / m.rate) / 10}s`;
  return `${m.shape} ${verb}${Math.abs(m.amount)} · ${hz}`;
}

function Section({
  label,
  defaultCollapsed,
  children,
}: {
  label: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(!defaultCollapsed);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-1 flex w-full items-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 transition-colors hover:text-foreground"
      >
        {label}
      </button>
      {open && <div className="space-y-1.5 pb-1">{children}</div>}
    </div>
  );
}

function IconButton({
  children,
  label,
  danger,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-3",
        danger && "hover:text-destructive",
      )}
    >
      {children}
    </button>
  );
}

/** Re-exported so a caller can decide whether a row deserves the badge at all. */
export function hasModulator(clip: Clip, path: string): boolean {
  return modulatorsFor(clip.modulators, path).length > 0;
}

/** Live value preview for a modulated path, used by the field row's readout. */
export function modulatedValueAt(clip: Clip, path: string, base: number, playheadMs: number): number {
  return applyModulators(clip.modulators, path, base, Math.max(0, playheadMs - clip.startMs) / 1000);
}

export { evaluateModulator };
