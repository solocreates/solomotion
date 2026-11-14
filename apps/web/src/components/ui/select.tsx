"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { withFloatingLayerEvents } from "@/lib/portal-events";
import { DynamicGlyph, useDynamicControl } from "@/editor/binding/dynamic-field";

const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

/**
 * Arrow-cycle wiring, shared by every Select. Items self-register their value
 * (in child order) so a focused, CLOSED trigger can step the value with
 * ArrowUp/Down — the native-`<select>` feel — without opening the menu. Radix
 * only mounts items while open, so the ordered set is captured the first time
 * the menu opens and then persists; before that first open the arrow keys fall
 * back to Radix's default (open the menu). On by default; opt out per Select.
 */
interface SelectCycleContextValue {
  arrowCycle: boolean;
  register: (value: string) => void;
  /** Step the value by `dir`; returns whether it changed anything. */
  step: (dir: 1 | -1) => boolean;
}
const SelectCycleContext = React.createContext<SelectCycleContextValue | null>(null);

function Select({
  arrowCycle = true,
  value,
  onValueChange,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root> & { arrowCycle?: boolean }) {
  // Registration (child) order — deduped, kept across close so closed-cycling
  // keeps working after the menu has been opened once.
  const orderRef = React.useRef<string[]>([]);
  const valueRef = React.useRef(value);
  valueRef.current = value;

  const ctx = React.useMemo<SelectCycleContextValue>(
    () => ({
      arrowCycle,
      register: (v) => {
        if (!orderRef.current.includes(v)) orderRef.current.push(v);
      },
      step: (dir) => {
        const list = orderRef.current;
        if (list.length === 0 || !onValueChange) return false;
        const cur = valueRef.current;
        const at = cur != null ? list.indexOf(cur) : -1;
        const next = list[(at + dir + list.length) % list.length];
        if (next != null && next !== cur) onValueChange(next);
        return true;
      },
    }),
    [arrowCycle, onValueChange],
  );

  return (
    <SelectCycleContext.Provider value={ctx}>
      <SelectPrimitive.Root value={value} onValueChange={onValueChange} {...props}>
        {children}
      </SelectPrimitive.Root>
    </SelectCycleContext.Provider>
  );
}

function SelectTrigger({
  className,
  children,
  onKeyDown,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  const cycle = React.useContext(SelectCycleContext);
  const dynamic = useDynamicControl();
  // A computed choice is not a menu: opening the list would offer options the
  // source overrules the moment you pick one. Show the value, open the source.
  if (dynamic) {
    return (
      <div
        className={cn(
          "flex h-(--control-h) w-full rounded-md border border-transparent bg-input px-2 text-body items-center gap-1.5 whitespace-nowrap",
          dynamic.className,
          className,
        )}
        style={dynamic.style}
        {...dynamic.props}
      >
        <DynamicGlyph field={dynamic.field} />
        <span className="min-w-0 flex-1 truncate">{dynamic.field.preview ?? children}</span>
      </div>
    );
  }
  return (
    <SelectPrimitive.Trigger
      className={cn(
        // `min-w-0` + the truncating child span is what keeps a long option
        // name from pushing the chevron off the end of a narrow inspector row.
        "flex h-(--control-h) w-full min-w-0 items-center justify-between gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-input px-2 text-body transition-colors placeholder:text-fg-faint hover:border-line data-[state=open]:border-line focus:outline-none focus-visible:border-primary/60 disabled:cursor-not-allowed disabled:opacity-50 [&>span:first-child]:min-w-0 [&>span:first-child]:flex-1 [&>span:first-child]:truncate [&>span:first-child]:text-left",
        className,
      )}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || !cycle?.arrowCycle) return;
        // Only while closed — Radix owns navigation once the menu is open.
        if (e.currentTarget.dataset.state === "open") return;
        if (e.key === "ArrowDown" && cycle.step(1)) e.preventDefault();
        else if (e.key === "ArrowUp" && cycle.step(-1)) e.preventDefault();
      }}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-3.5 shrink-0 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-part="menu"
        className={cn(
          "relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] overflow-y-auto overflow-x-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className,
        )}
        position={position}
        {...props}
        {...withFloatingLayerEvents({ onPointerDown: props.onPointerDown, onContextMenu: props.onContextMenu })}
      >
        <SelectPrimitive.ScrollUpButton className="flex cursor-default items-center justify-center py-1">
          <ChevronUp className="h-4 w-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex cursor-default items-center justify-center py-1">
          <ChevronDown className="h-4 w-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn("px-2 pb-1 pt-2 text-meta font-medium text-fg-muted", className)}
      {...props}
    />
  );
}

/**
 * One choice. `description` is the reason this component exists rather than a
 * bare Radix item.
 *
 * Radix CLONES an item's `ItemText` into the trigger to show the current value.
 * So a two-line item built the obvious way — label and description stacked
 * inside `ItemText` — silently makes the TRIGGER two lines too, and every
 * select in the app grows to 56px with a subtitle nobody asked for on it. That
 * is the bug in "Shape / Organic random drift" and "Mask / Broadcast raster
 * lines": not a styling accident, a structural one.
 *
 * The fix is structural: `ItemText` carries the label and NOTHING else, and the
 * description renders as its sibling. The menu is as rich as it wants to be;
 * the trigger stays one line, always, in every caller — which is why this lives
 * here instead of being worked around per panel.
 */
function SelectItem({
  onPointerDown,
  onPointerUp,
  onClick,
  className,
  children,
  description,
  value,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & {
  /** A one-liner under the label, IN THE MENU ONLY. Never reaches the trigger. */
  description?: React.ReactNode;
}) {
  const cycle = React.useContext(SelectCycleContext);
  React.useEffect(() => cycle?.register(value), [cycle, value]);
  return (
    <SelectPrimitive.Item
      value={value}
      data-part="menu-item"
      className={cn(
        "group/item relative flex w-full cursor-default select-none flex-col items-start gap-0.5 min-h-(--control-h) justify-center py-1 pl-2 pr-8 text-body outline-none",
        className,
      )}
      {...props}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onClick={onClick}
    >
      <span className="absolute top-1.5 right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      {description && (
        <span className="text-meta text-fg-muted">
          {description}
        </span>
      )}
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-line", className)}
      {...props}
    />
  );
}

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
};
