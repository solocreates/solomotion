"use client";

import * as React from "react";
import {
  addVariable,
  expressionById,
  exprTypeForVariable,
  parseSource,
  resolveVar,
  varToken,
  type VariableType,
  type VariableValueOf,
} from "@solomotion/core";
import { Boxes, Link2, Link2Off, Plus, Settings2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverAnchor, PopoverTrigger } from "@/components/ui/popover";
import { useDoc, useDocStore } from "../../state/document-context";
import { useSession } from "../../state/session";
import { evaluateAt, useExprContext } from "../../expressions/expression-context";
import {
  detachedLiteral,
  ExpressionPopoverContent,
  WriteExpressionIcon,
  WRITE_EXPRESSION_LABEL,
} from "../../expressions/ExpressionPopover";
import { VARIABLE_TYPE_META } from "./variable-meta";
import { VariablePickerContent } from "./VariablePicker";
import { DynamicFieldProvider } from "../../binding/dynamic-field";
import { useSourceState } from "../../binding/use-source-state";
import { useTypedSourceBinder } from "../../binding/use-typed-source";

/**
 * The headless binding kit: make ANY inspector field take its value from
 * somewhere else. A field stores a literal, a `var:<id>` reference, or an
 * `fx:<id>` expression; whichever it holds, `BindableField` shows THE SAME
 * CONTROL — tinted by its source, showing that source's live value, opening it
 * on click — and offers the vocabulary two ways: the link button beside the
 * control, and a right-click menu on the field itself (so a field with no room
 * for a button still gets all of it).
 *
 * It used to swallow the control and show a chip. That answered "what drives
 * this?" while hiding the thing a person came to look at, which is the value.
 *
 * The binding rule, one line, every type and every source: a bound field
 * REFERENCES what drives it, and detaching leaves behind the value that was on
 * screen (Figma). The variable's own value is edited in the Variables window;
 * the expression's, in its own panel. So "change it here" never silently
 * restyles the whole document, and unlinking never moves anything on the canvas.
 */

/** Which panel a field currently has open. One popover, two sources. */
type Panel = null | "variable" | "expression";

export function BindableField<T extends VariableType>({
  type,
  value,
  onChange,
  /** The current resolved literal — used to seed a newly created variable and to
   *  detach back to a literal on unlink. */
  literal,
  /** Disable binding (e.g. keyframed / multi-select / range mode). */
  disabled,
  children,
}: {
  type: T;
  value: string | number | undefined;
  onChange: (next: string | number) => void;
  literal: VariableValueOf<T>;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const doc = useDoc();
  const ctx = useExprContext();
  const [panel, setPanel] = React.useState<Panel>(null);

  const source = parseSource(value);
  const linked = source.kind === "variable" ? resolveVar(doc, value as string) : null;
  const expression = source.kind === "expression" ? (expressionById(doc, source.id) ?? null) : null;

  const detach = React.useCallback(() => {
    if (linked) return onChange(linked.value as string | number);
    const shown = expression ? evaluateAt(expression.source, doc.variables, ctx, expression.id) : null;
    onChange(detachedLiteral(type, shown?.value, literal));
  }, [linked, expression, doc.variables, ctx, onChange, type, literal]);

  const openPanel = React.useCallback((next: "variable" | "expression") => setPanel(next), []);
  // A slot HOLDS its reference, so the control is looking at a token rather than
  // a value — unlike a path-addressed property, whose value the resolved document
  // already baked. That is the whole of `withPreview`.
  const dynamic = useSourceState(source, { openPanel, detach, withPreview: true });
  const acceptTyped = useTypedSourceBinder({
    expect: exprTypeForVariable(type),
    bind: onChange,
    disabled: disabled || source.kind !== "literal",
  });

  const shared = { type, value, onChange, literal, onClose: () => setPanel(null) } as const;

  return (
    <BindingContextMenu type={type} value={value} onChange={onChange} literal={literal} disabled={disabled}>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <Popover open={panel !== null} onOpenChange={(open) => !open && setPanel(null)}>
          <PopoverAnchor asChild>
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {/* The control itself, tinted by its source and opening that source
                  on click — the same field whether it is free or driven. */}
              <DynamicFieldProvider state={dynamic} accept={acceptTyped}>
                <div className="min-w-0 flex-1">{children}</div>
              </DynamicFieldProvider>
              {!dynamic && !disabled && (
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    title="Bind to a variable or an expression"
                    aria-label="Bind to a variable or an expression"
                    onClick={() => setPanel("variable")}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
                  >
                    <Link2 />
                  </button>
                </PopoverTrigger>
              )}
            </div>
          </PopoverAnchor>
          {panel === "variable" && (
            <VariablePickerContent {...shared} onWriteExpression={() => setPanel("expression")} />
          )}
          {panel === "expression" && <ExpressionPopoverContent {...shared} />}
        </Popover>
      </div>
    </BindingContextMenu>
  );
}

/**
 * Right-click binding for ANY field — wrap a control and it grows the same
 * vocabulary the link button offers (link / write / create / detach / manage)
 * without spending a pixel of row width. Fields that can't fit a link button
 * (number scrubs, node input rows, tight grids) use this alone.
 *
 * This menu is the ONE place a field learns a new verb. When a third way to
 * drive a value arrives, it is one item here and every field in the app has it.
 */
export function BindingContextMenu<T extends VariableType>({
  type,
  value,
  onChange,
  literal,
  disabled,
  children,
  className,
}: {
  type: T;
  value: string | number | undefined;
  onChange: (next: string | number) => void;
  literal: VariableValueOf<T>;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const ctx = useExprContext();
  const openManager = useSession((s) => s.setVariablesOpen);
  const [panel, setPanel] = React.useState<Panel>(null);
  const meta = VARIABLE_TYPE_META[type];

  const source = parseSource(value);
  const linked = source.kind === "variable" ? resolveVar(doc, value as string) : null;
  const expression = source.kind === "expression" ? (expressionById(doc, source.id) ?? null) : null;
  const options = doc.variables.filter((v) => v.type === type);

  const detachVariable = () => onChange((linked ? linked.value : literal) as string | number);
  const detachExpression = () => {
    const shown = expression ? evaluateAt(expression.source, doc.variables, ctx, expression.id) : null;
    onChange(detachedLiteral(type, shown?.value, literal));
  };
  const createFromValue = () => {
    let id: string | null = null;
    store.update(`Create ${meta.label.toLowerCase()} variable`, (d) => {
      id = addVariable(d, type, meta.label, literal).id;
    });
    if (id) onChange(varToken(id));
  };

  // Radix closes the menu on select; opening a popover in the same tick would be
  // swallowed by that dismissal, so every one of these waits a frame.
  const openPanel = (next: Panel) => requestAnimationFrame(() => setPanel(next));

  // Standalone hosts (node input rows, tight grids) wrap with this menu alone, so
  // the typed-expression gesture is offered here too. When `BindableField` is the
  // host its own provider sits inside this one and wins, which is right: it knows
  // the field's live source as well.
  const acceptTyped = useTypedSourceBinder({
    expect: exprTypeForVariable(type),
    bind: onChange,
    disabled: disabled || source.kind !== "literal",
  });

  if (disabled) return <>{children}</>;

  const shared = { type, value, onChange, literal, onClose: () => setPanel(null) } as const;

  return (
    <DynamicFieldProvider accept={acceptTyped}>
    <Popover open={panel !== null} onOpenChange={(open) => !open && setPanel(null)}>
      <ContextMenu>
        <ContextMenuTrigger asChild className={className}>
          {/* An ANCHOR, not a trigger: the field keeps its own click behaviour
              and the panel merely opens against it, so it lands where the user
              right-clicked instead of at a detached corner of the screen. */}
          <PopoverAnchor asChild>{children}</PopoverAnchor>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-52">
          <ContextMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            {meta.label} field
          </ContextMenuLabel>
          {linked ? (
            <>
              <ContextMenuItem onSelect={() => openManager(true)}>
                <Boxes /> Edit “{linked.name}”…
              </ContextMenuItem>
              <ContextMenuItem onSelect={detachVariable}>
                <Link2Off /> Detach from variable
              </ContextMenuItem>
            </>
          ) : expression ? (
            <>
              <ContextMenuItem onSelect={() => openPanel("expression")}>
                <WriteExpressionIcon /> Edit expression…
              </ContextMenuItem>
              <ContextMenuItem onSelect={detachExpression}>
                <Link2Off /> Remove expression
              </ContextMenuItem>
            </>
          ) : (
            <>
              <ContextMenuItem disabled={options.length === 0} onSelect={() => openPanel("variable")}>
                <Link2 /> Link a variable…
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => openPanel("expression")}>
                <WriteExpressionIcon /> {WRITE_EXPRESSION_LABEL}
              </ContextMenuItem>
              <ContextMenuItem onSelect={createFromValue}>
                <Plus /> Create variable from this value
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => openManager(true)}>
            <Settings2 /> Manage variables…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {panel === "variable" && (
        <VariablePickerContent
          {...shared}
          align="start"
          onWriteExpression={() => setPanel("expression")}
        />
      )}
      {panel === "expression" && <ExpressionPopoverContent {...shared} align="start" />}
    </Popover>
    </DynamicFieldProvider>
  );
}
