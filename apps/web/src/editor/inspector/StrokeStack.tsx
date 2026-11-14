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
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  STROKE_PRESET_KIND,
  STROKE_STACK_PRESET_KIND,
  applyStrokeSet,
  brushStackPresets,
  coreBrushes,
  isDefaultPipeline,
  solidPaint,
  strokeSetFrom,
  strokeSetPatch,
  strokeStackFrom,
  strokeStyle,
  resolveColor,
  strokesFromStack,
  type StrokeSet,
  type StrokeStyle,
} from "@solomotion/core";
import { Eye, EyeOff, GripVertical, Layers, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { PICKER_PLACEMENT, PICKER_WIDTH } from "@/components/ui/color-picker";
import { useBrushLibrary } from "../drawing/drawing-store";
import { useDoc } from "../state/document-context";
import { CHECKER } from "./PaintList";
import { PaintEditorBody } from "./PaintPopover";
import { PaintPreview } from "../paint/PaintPreview";
import type { PaintHost } from "./paint-host";
import { LookBrowser, type LookItem } from "../pickers/LookBrowser";
import { usePresets } from "./effect-editor/use-presets";
import { StrokePreview } from "./StrokePreview";
import { StrokeFields } from "./StrokeFields";
import { StrokeEditorWindow, strokeWindowId } from "./StrokeEditorWindow";
import { useEffectEditor } from "./effect-editor/store";
import type { StrokeHost } from "./stroke-host";
import { useEffectiveValue } from "./animatable";

/**
 * THE stroke-stack editor — a sortable list of lines, and the panel that edits
 * one of them. Mounted twice with different hosts and no other difference: on a
 * layer (keyframable) and on a vector brush (a design, no timeline).
 *
 * There are two preset scopes here and the split is the point:
 *
 *  - the SECTION offers STACKS, because a stack is what it replaces — and a
 *    vector brush is a stack, so the brush library loads straight in;
 *  - a ROW offers SOLO sets, because you are changing that line and a preset
 *    that swapped the whole stack would answer a question you did not ask.
 *
 * Both run the same engine (`StrokePreview`, the same library, the same apply),
 * so there is one card design and one place a look is drawn.
 */
export function StrokeStackEditor({
  host,
  scope = "layer",
  paintOf,
  paintHost,
}: {
  host: StrokeHost;
  scope?: "layer" | "brush";
  /** Colour for a line added or loaded from a stack preset. */
  paintOf?: () => string;
  /**
   * The full paint host, when the strokes have paints of their own — a layer's
   * do (solid, gradient, image, pattern, each with its own blend). A vector
   * brush's do not: a brush paints in whatever colour the tool is holding, so
   * it passes nothing and its rows carry no swatch. That absence IS the
   * difference between the two, and it is one prop rather than a `mode` flag.
   */
  paintHost?: PaintHost;
}) {
  const ids = host.strokes.map((s) => s.id);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const colour = paintOf?.() ?? "#1E1E1E";

  const add = () =>
    host.update("Add stroke", (c) => {
      c.strokes.push(strokeStyle(solidPaint(colour), { width: 2 }));
    });

  const remove = (id: string) =>
    host.update("Remove stroke", (c) => {
      c.strokes = c.strokes.filter((s) => s.id !== id);
    });

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    host.update("Reorder strokes", (c) => {
      c.strokes = arrayMove(c.strokes, from, to);
    });
  };

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-center gap-1">
        <StackPresetMenu host={host} colour={colour} />
        <div className="flex-1" />
        <button
          type="button"
          onClick={add}
          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3"
        >
          <Plus /> Add
        </button>
      </div>

      {/* One window at a time, rendered by the stack that owns the row — so it
          reads live values through this host and writes through its semantics. */}
      {scope === "layer" && <StrokeEditorWindow host={host} />}

      {host.strokes.length === 0 ? (
        <button
          type="button"
          onClick={add}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/80 py-2 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground [&_svg]:size-3.5"
        >
          <Plus /> Add stroke
        </button>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <div className="space-y-1">
              {host.strokes.map((s) => (
                <StackRow
                  key={s.id}
                  host={host}
                  paintHost={paintHost}
                  stroke={s}
                  scope={scope}
                  sortable={host.strokes.length > 1}
                  onRemove={() => remove(s.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

/** One line: its own preview, width, a solo-set menu, visibility and delete —
 *  and it expands in place into the full field panel. */
function StackRow({
  host,
  paintHost,
  stroke,
  scope,
  sortable,
  onRemove,
}: {
  host: StrokeHost;
  paintHost?: PaintHost;
  stroke: StrokeStyle;
  scope: "layer" | "brush";
  sortable: boolean;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: stroke.id });
  const set = React.useMemo(() => strokeSetFrom(stroke), [stroke]);
  // The width AT THE PLAYHEAD, exactly as the window's field reads it. Showing
  // the resting `stroke.width` here made a keyed (or recorded) edit snap back:
  // the write landed as a key, the box re-read the untouched base.
  const width = useEffectiveValue(host.keyframeClip, `stroke.${stroke.id}.width`, stroke.width);
  // In the SIDEBAR a stroke opens the floating editor — five stages of controls
  // do not belong in a 340px column, which is what made the old popover feel
  // cramped. The Brush Studio is already a wide dialog, so there the same panel
  // expands in place rather than opening a window over a window.
  const windowId = strokeWindowId(host.key, stroke.id);
  const openId = useEffectEditor((s) => s.openId);
  const toggleWindow = useEffectEditor((s) => s.toggle);
  const [inlineOpen, setInlineOpen] = React.useState(false);
  const expanded = scope === "brush" ? inlineOpen : openId === windowId;
  const toggle = () => (scope === "brush" ? setInlineOpen((v) => !v) : toggleWindow(windowId, "stroke"));

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "rounded-lg border border-border/50 bg-muted/20 transition-opacity",
        !stroke.enabled && "opacity-45",
        isDragging && "relative z-10 shadow-lg",
      )}
    >
      <div className="group/line flex items-center gap-1.5 px-1.5 py-1">
        {sortable && (
          <button
            type="button"
            aria-label="Reorder stroke"
            className="flex size-4 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground group-hover/line:opacity-100 active:cursor-grabbing [&_svg]:size-3.5"
            {...attributes}
            {...listeners}
          >
            <GripVertical />
          </button>
        )}
        {paintHost && <StrokePaintSwatch host={paintHost} stroke={stroke} />}
        <button
          type="button"
          aria-label={expanded ? "Close stroke settings" : "Stroke settings"}
          onClick={toggle}
          className={cn(
            "min-w-0 flex-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/60",
            expanded && "material-glass-raised",
          )}
        >
          <StrokePreview
            stack={[set]}
            shape="wave"
            className="h-5 w-full max-w-20"
            color={paintHost ? undefined : "currentColor"}
          />
        </button>

        <SoloSetMenu host={host} stroke={stroke} />
        <NumberInput
          value={width}
          min={0}
          step={0.5}
          precision={1}
          className="w-12"
          title="Width"
          onChange={(v) => host.commit(`stroke.${stroke.id}.width`, v, "Stroke width", `w-${stroke.id}`)}
        />
        <button
          type="button"
          aria-label={stroke.enabled ? "Hide stroke" : "Show stroke"}
          onClick={() =>
            host.update(stroke.enabled ? "Hide stroke" : "Show stroke", (c) => {
              const s = c.strokes.find((x) => x.id === stroke.id);
              if (s) s.enabled = !s.enabled;
            })
          }
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-all hover:text-foreground [&_svg]:size-3.5",
            stroke.enabled ? "opacity-0 group-hover/line:opacity-100" : "opacity-100 text-foreground/70",
          )}
        >
          {stroke.enabled ? <Eye /> : <EyeOff />}
        </button>
        <button
          type="button"
          aria-label="Remove stroke"
          onClick={onRemove}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-all hover:text-destructive group-hover/line:opacity-100 [&_svg]:size-3.5"
        >
          <Trash2 />
        </button>
      </div>

      {expanded && scope === "brush" && (
        <div className="border-t border-border/40 px-2 pb-1">
          <StrokeFields host={host} strokeId={stroke.id} scope={scope} />
        </div>
      )}
    </div>
  );
}

/** The line's own paint — solid, gradient, image or pattern — through the SAME
 *  editor a fill uses. A stroke's colour was never a different question. */
function StrokePaintSwatch({ host, stroke }: { host: PaintHost; stroke: StrokeStyle }) {
  const doc = useDoc();
  const resolve = React.useCallback((c: string) => resolveColor(doc, c), [doc]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Stroke colour"
          className="relative size-6 shrink-0 overflow-hidden rounded-[7px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25),inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-transform hover:scale-105"
          style={{ background: CHECKER }}
        >
          <span className="absolute inset-0">
            <PaintPreview paint={stroke.paint} checker={false} />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent {...PICKER_PLACEMENT} className={cn("p-0", PICKER_WIDTH)}>
        <PaintEditorBody host={host} kind="stroke" id={stroke.id} eff={stroke.paint} />
      </PopoverContent>
    </Popover>
  );
}

// ── Presets ──────────────────────────────────────────────────────────────────

/**
 * Every look in the library, as browser items.
 *
 * Singles and stacks are ONE catalogue here, because "a solo set is a stack of
 * one" is not a slogan — it is how the data is shaped, and splitting the
 * catalogue was what made the section menu show nine looks while the library
 * held forty-one. What differs between the two menus is what a CLICK MEANS
 * (replace this line vs replace the list), not what you are allowed to look at,
 * so the row simply narrows the same list to the looks a single line can hold.
 */
function useLookItems(singlesOnly: boolean): LookItem[] {
  const { presets: singles } = usePresets(STROKE_PRESET_KIND);
  const { presets: stacks } = usePresets(STROKE_STACK_PRESET_KIND);
  // Select the STORED slice, not `allBrushes()` — that composes a fresh array
  // on every call, so using it as a selector hands zustand a new reference each
  // render and the component never settles.
  const custom = useBrushLibrary((s) => s.customBrushes);

  return React.useMemo(() => {
    const brushes = brushStackPresets([...coreBrushes(), ...custom]);
    const all: Array<{ preset: (typeof singles)[number]; stack: StrokeSet[] }> = [
      ...singles.map((p) => ({ preset: p, stack: [asSet(p.data)] })),
      ...(singlesOnly ? [] : [...brushes, ...stacks].map((p) => ({ preset: p, stack: (p.data as StrokeSet[]).map(asSet) }))),
    ];
    return all.map(({ preset, stack }) => ({
      id: preset.id,
      name: preset.name,
      group: preset.group ?? (preset.scope === "builtin" ? "Built-in" : "Saved"),
      tags: preset.tags,
      // Spelled out rather than a bare count badge: a lone "3" beside a look is
      // a number nobody can read without asking what it counts.
      meta: stack.length > 1 ? `${stack.length} lines` : undefined,
      preview: <StrokePreview stack={stack} shape="wave" className="h-8 w-full" />,
      stack,
    }));
  }, [singles, stacks, custom, singlesOnly]);
}

/** A look item carrying the stack it would apply. */
type StrokeLookItem = LookItem & { stack: StrokeSet[] };

/** Solo sets — one line's look. Offered on the row it changes. */
function SoloSetMenu({ host, stroke }: { host: StrokeHost; stroke: StrokeStyle }) {
  const { save } = usePresets(STROKE_PRESET_KIND);
  const items = useLookItems(true);
  const [open, setOpen] = React.useState(false);

  return (
    <LookMenu
      open={open}
      onOpenChange={setOpen}
      label="Line presets"
      icon={<Sparkles />}
      items={items}
      placeholder="Search line looks…"
      onPick={(data) => {
        host.update("Apply stroke set", (c) => {
          const s = c.strokes.find((x) => x.id === stroke.id);
          if (s) Object.assign(s, applyStrokeSet(s, { ...data, id: s.id }));
        });
        setOpen(false);
      }}
      onSave={() => {
        const name = window.prompt("Name this stroke set", "My line");
        if (!name?.trim()) return;
        save("project", name.trim(), strokeSetPatch(strokeSetFrom(stroke)), { group: "Saved" });
        setOpen(false);
      }}
      saveLabel="Save this line"
      saveDisabled={isDefaultPipeline(stroke)}
    />
  );
}

/**
 * Stacks — the whole list. This is where vector brushes appear: a brush's lines
 * ARE a stack, so the library needs no export format and no second card.
 */
function StackPresetMenu({ host, colour }: { host: StrokeHost; colour: string }) {
  const { save } = usePresets(STROKE_STACK_PRESET_KIND);
  const items = useLookItems(false);
  const [open, setOpen] = React.useState(false);

  return (
    <LookMenu
      open={open}
      onOpenChange={setOpen}
      label="Stroke sets"
      icon={<Layers />}
      items={items}
      placeholder="Search strokes and brushes…"
      onPick={(_data, stack) => {
        host.update("Apply stroke stack", (c) => {
          c.strokes = strokesFromStack(stack, solidPaint(colour));
        });
        setOpen(false);
      }}
      onSave={() => {
        const name = window.prompt("Name this stroke set", "My stroke");
        if (!name?.trim()) return;
        save("project", name.trim(), strokeStackFrom(host.strokes).map(strokeSetPatch), { group: "Saved" });
        setOpen(false);
      }}
      saveLabel="Save this stack"
      saveDisabled={host.strokes.length === 0}
      wide
    />
  );
}

/** A stored patch back into a full set (its id is the stroke's, not the look's). */
const asSet = (data: unknown): StrokeSet => ({ ...strokeSetFrom(strokeStyle(solidPaint("#000"))), ...(data as object) });

/**
 * The trigger + the shared browser. Both scopes mount this, so the stroke
 * library and the vector-brush library are literally the same window — search,
 * shelves, stars and cards — differing only in what a pick writes.
 */
function LookMenu({
  open,
  onOpenChange,
  label,
  icon,
  items,
  placeholder,
  onPick,
  onSave,
  saveLabel,
  saveDisabled,
  wide,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  label: string;
  icon: React.ReactNode;
  items: LookItem[];
  placeholder: string;
  onPick: (first: StrokeSet, stack: StrokeSet[]) => void;
  onSave: () => void;
  saveLabel: string;
  saveDisabled?: boolean;
  wide?: boolean;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3",
            !wide && "size-6 justify-center px-0",
          )}
        >
          {icon}
          {wide && label}
        </button>
      </PopoverTrigger>
      <PopoverContent side="left" align="start" sideOffset={8} className="w-[380px] p-0">
        <LookBrowser
          items={items}
          placeholder={placeholder}
          onPick={(i) => {
            const stack = (i as StrokeLookItem).stack;
            onPick(stack[0]!, stack);
          }}
          footer={
            <button
              type="button"
              onClick={onSave}
              disabled={saveDisabled}
              className="flex w-full items-center justify-center gap-1.5 rounded-md py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 [&_svg]:size-3"
            >
              <Save />
              {saveLabel}
            </button>
          }
        />
      </PopoverContent>
    </Popover>
  );
}
