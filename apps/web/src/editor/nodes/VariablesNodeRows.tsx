"use client";

import * as React from "react";
import {
  socketTypeForVariable,
  type SelectedVariable,
  type Variable,
  type VariableType,
} from "@solomotion/core";
import { Boxes, Hash, Palette, Plus, Type as TypeIcon, Weight, X } from "lucide-react";
import { Command, CommandEmpty, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useDoc } from "../state/document-context";
import { VariableValueField } from "../inspector/variables/VariableValueField";
import { VariableKeyControl } from "../inspector/variables/VariableKeyControl";
import { useVariableValue } from "../inspector/variables/use-variable-value";

/**
 * The Variables node's row internals — the same reusable value field + keyframe
 * cluster the Variables window uses, so a variable edits and animates identically
 * on the board. Rendered BETWEEN the node's output socket and label; the socket
 * (owned by NodeCard, so wire geometry stays exact) reads this variable live.
 */

const TYPE_ICON: Record<VariableType, React.ComponentType<{ className?: string }>> = {
  color: Palette,
  // Never rendered — a paint gets no socket, so the node never lists one — but
  // the map is total so a new variable type is a compile error, not a blank.
  paint: Palette,
  number: Hash,
  fontFamily: TypeIcon,
  fontWeight: Weight,
  string: TypeIcon,
};

export function NodeVariableRow({ variable, onRemove }: { variable: Variable; onRemove: () => void }) {
  const { value, setValue } = useVariableValue(variable);
  const Icon = TYPE_ICON[variable.type];
  return (
    <>
      {/* Stop pointerdown reaching the card's drag handler — otherwise scrubbing a
          number field (or opening a picker) also grabs and drags the whole node. */}
      <div className="flex items-center" onPointerDown={(e) => e.stopPropagation()}>
        <VariableValueField variable={variable} value={value} onChange={setValue} />
      </div>
      <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
        <Icon className="size-3 shrink-0 opacity-50" />
        <span className="truncate">{variable.name}</span>
      </span>
      <div className="ml-auto flex items-center" onPointerDown={(e) => e.stopPropagation()}>
        <VariableKeyControl variable={variable} />
        <button
          type="button"
          aria-label={`Remove ${variable.name} from node`}
          title="Remove from node"
          onClick={onRemove}
          className="flex size-4 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-hover/row:opacity-100"
        >
          <X className="size-3" />
        </button>
      </div>
    </>
  );
}

/**
 * The iterator: pick which document variables the node exposes. A searchable
 * list of every variable NOT already on the node (a document can hold many, so
 * you add only the ones you want). Picking one appends it as an output socket.
 */
export function AddVariableControl({
  selectedIds,
  onAdd,
}: {
  selectedIds: Set<string>;
  onAdd: (v: SelectedVariable) => void;
}) {
  const doc = useDoc();
  const [open, setOpen] = React.useState(false);
  const available = doc.variables.filter((v) => !selectedIds.has(v.id));

  return (
    <div className="px-2.5 pb-2 pt-1" onPointerDown={(e) => e.stopPropagation()}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/70 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground [&_svg]:size-3"
          >
            <Plus /> Add variable
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-56 p-0">
          <Command>
            <CommandList className="max-h-64">
              <CommandEmpty className="py-4 text-center text-[11px] text-muted-foreground">
                {doc.variables.length === 0 ? "No variables yet." : "All variables added."}
              </CommandEmpty>
              {available.map((v) => {
                const Icon = TYPE_ICON[v.type];
                return (
                  <CommandItem
                    key={v.id}
                    value={`${v.name} ${v.id}`}
                    onSelect={() => {
                      onAdd({ id: v.id, type: v.type, name: v.name });
                      setOpen(false);
                    }}
                    className="gap-2 text-[12px]"
                  >
                    <Icon className={cn("size-3 shrink-0 opacity-60")} />
                    <span className="min-w-0 flex-1 truncate">{v.name}</span>
                    <span className="text-[9px] uppercase tracking-wide text-muted-foreground/60">
                      {socketTypeForVariable(v.type)}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selectedIds.size === 0 && (
        <p className="mt-1 flex items-center justify-center gap-1 text-center text-[9px] text-muted-foreground/70 [&_svg]:size-2.5">
          <Boxes /> pick variables to read
        </p>
      )}
    </div>
  );
}
