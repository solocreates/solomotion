"use client";

import * as React from "react";
import {
  addVariable,
  parseSource,
  varToken,
  type Variable,
  type VariableType,
  type VariableValueOf,
} from "@solomotion/core";
import { Boxes, Link2Off, Plus, Settings2 } from "lucide-react";
import { WriteExpressionIcon, WRITE_EXPRESSION_LABEL } from "../../expressions/ExpressionPopover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../../state/document-context";
import { useSession } from "../../state/session";
import { VARIABLE_TYPE_META, VariableSwatch, variableValueLabel } from "./variable-meta";

/**
 * THE bind-a-variable panel — one searchable list, reused by every field in the
 * app (colour swatches, inspector rows, node input rows, field context menus).
 *
 * It is deliberately TYPE-FILTERED: a field declares the variable type it can
 * hold and only those variables are offered, so a number field can never be
 * bound to a font family. Search behaves like the effect add-menu (cmdk, type to
 * narrow, ↑↓/⏎), and the footer always offers the two escape hatches — mint a
 * variable from the value that's already in the field, or open the manager.
 *
 * Rendered as `PopoverContent`, so callers only supply `<Popover>` +
 * `<PopoverTrigger>` and get all of the primitive's edge handling for free.
 */

export interface VariableBindingProps<T extends VariableType = VariableType> {
  /** The variable type this field accepts — the list is filtered to it. */
  type: T;
  /** The field's stored value (a literal, or a `var:<id>` token). */
  value: string | number | undefined;
  /** Write the field: a `var:<id>` token on link, a literal on detach. */
  onChange: (next: string | number) => void;
  /** The field's current resolved literal — seeds a new variable, and is what
   *  detaching falls back to. */
  literal: VariableValueOf<T>;
}

/** The variable a field is currently bound to, or null when it holds a literal. */
export function useBoundVariable(value: string | number | undefined): Variable | null {
  const doc = useDoc();
  const source = parseSource(value);
  const id = source.kind === "variable" ? source.id : null;
  return id ? (doc.variables.find((v) => v.id === id) ?? null) : null;
}

export function VariablePickerContent<T extends VariableType>({
  type,
  value,
  onChange,
  literal,
  onClose,
  onWriteExpression,
  className,
  ...rest
}: VariableBindingProps<T> &
  Omit<React.ComponentProps<typeof PopoverContent>, "value" | "onChange" | "type"> & {
    onClose: () => void;
    /** Hand the field over to the expression editor. Omitted where writing one
     *  makes no sense (a picker with nowhere to put the result). */
    onWriteExpression?: () => void;
  }) {
  const doc = useDoc();
  const store = useDocStore();
  const openManager = useSession((s) => s.setVariablesOpen);
  const bound = useBoundVariable(value);
  const meta = VARIABLE_TYPE_META[type];

  const options = doc.variables.filter((v) => v.type === type);

  const link = (id: string) => {
    onChange(varToken(id));
    onClose();
  };

  const detach = () => {
    // Keep what's on screen: the bound variable's own value becomes the literal.
    onChange((bound ? bound.value : literal) as string | number);
    onClose();
  };

  const createFromValue = () => {
    let id: string | null = null;
    store.update(`Create ${meta.label.toLowerCase()} variable`, (d) => {
      id = addVariable(d, type, meta.label, literal).id;
    });
    if (id) link(id);
  };

  const manage = () => {
    onClose();
    openManager(true);
  };

  return (
    <PopoverContent align="end" sideOffset={6} className={cn("w-64 p-0", className)} {...rest}>
      <Command
        // Match on the name AND the value text, so "#ff8" finds a colour.
        filter={(itemValue, search) =>
          itemValue.toLowerCase().includes(search.toLowerCase().trim()) ? 1 : 0
        }
      >
        <CommandInput placeholder={`Search ${meta.label.toLowerCase()} variables…`} />
        <CommandList className="max-h-none">
          <CommandEmpty className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            No {meta.label.toLowerCase()} variable matches.
          </CommandEmpty>
          {options.length > 0 && (
            <CommandGroup heading={`${meta.label} variables`}>
              {options.map((v) => (
                <CommandItem
                  key={v.id}
                  value={`${v.name} ${variableValueLabel(v)}`}
                  onSelect={() => link(v.id)}
                  className="gap-2"
                >
                  <VariableSwatch variable={v} />
                  <span className="min-w-0 flex-1 truncate">{v.name}</span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                    {variableValueLabel(v)}
                  </span>
                  {bound?.id === v.id && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandSeparator />
          <CommandGroup>
            {bound && (
              <CommandItem value="detach unlink" onSelect={detach} className="gap-2">
                <Link2Off className="size-3.5" />
                Detach from “{bound.name}”
              </CommandItem>
            )}
            {/* Minting from the field's value only makes sense while the field
                HOLDS a value of its own — once bound, that button would just
                clone the variable you're already pointing at. */}
            {!bound && (
              <CommandItem value="create new variable" onSelect={createFromValue} className="gap-2">
                <Plus className="size-3.5" />
                Create variable from this value
              </CommandItem>
            )}
            {onWriteExpression && !bound && (
              <CommandItem
                value="write expression formula"
                onSelect={onWriteExpression}
                className="gap-2"
              >
                <WriteExpressionIcon className="size-3.5" />
                {WRITE_EXPRESSION_LABEL}
              </CommandItem>
            )}
            <CommandItem value="manage variables" onSelect={manage} className="gap-2">
              <Settings2 className="size-3.5" />
              Manage variables…
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  );
}
