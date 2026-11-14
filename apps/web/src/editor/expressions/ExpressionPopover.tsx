"use client";

import * as React from "react";
import {
  addExpression,
  exprTypeForVariable,
  expressionById,
  fxToken,
  parseSource,
  setExpressionSource,
  type ExprType,
  type ExprValue,
  type VariableType,
  type VariableValueOf,
} from "@solomotion/core";
import { FunctionSquare, Link2Off, Sparkles } from "lucide-react";
import { PopoverContent, PopoverFooter, PopoverHeader } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useExprContext } from "./expression-context";
import { ExpressionEditor, previewText, useExpressionAnalysis } from "./ExpressionEditor";
import { TYPE_CHIP } from "./expression-theme";

/**
 * THE WRITE-AN-EXPRESSION PANEL — deliberately the same shape, width and chrome
 * as the variable picker, because they are the same VERB: this field is going to
 * take its value from somewhere else. A person should feel they picked a
 * different source, not that they opened a different application.
 *
 * The binding rule matches the one variables already shipped: a bound field
 * REFERENCES its expression, and detaching leaves behind the value that was on
 * screen, so nothing on the canvas moves when you unlink. What differs is the
 * write model — an expression applies LIVE as you type (debounced, coalesced
 * into one history entry) because the whole point of a preview is watching the
 * thing you are describing.
 */

/** The expression a field is currently bound to, or null. */
export function useBoundExpression(value: string | number | undefined) {
  const doc = useDoc();
  const source = parseSource(value);
  const id = source.kind === "expression" ? source.id : null;
  return id ? (expressionById(doc, id) ?? null) : null;
}

/** What a blank editor starts with: the value that is already in the field,
 *  written as an expression. Starting from the current value turns "write an
 *  expression" into "keep going from here" instead of a blank page. */
function seedSource(type: VariableType, literal: unknown): string {
  if (type === "color") return JSON.stringify(String(literal ?? "#ffffff"));
  if (type === "number" || type === "fontWeight") return String(typeof literal === "number" ? literal : 0);
  return JSON.stringify(String(literal ?? ""));
}

export function ExpressionPopoverContent<T extends VariableType>({
  type,
  value,
  onChange,
  literal,
  onClose,
  available,
  className,
  ...rest
}: {
  type: T;
  value: string | number | undefined;
  onChange: (next: string | number) => void;
  literal: VariableValueOf<T>;
  onClose: () => void;
  /** Which globals the host can answer here (a doc-level slot has no layer). */
  available?: { layer?: boolean; comp?: boolean };
} & Omit<React.ComponentProps<typeof PopoverContent>, "value" | "onChange" | "type">) {
  const store = useDocStore();
  const bound = useBoundExpression(value);
  // Paints never open this panel (they bind to a variable, not to an
  // expression), so the fallback is unreachable rather than a guess.
  const exprType: ExprType = exprTypeForVariable(type) ?? "float";
  const ctx = useExprContext();

  // The id is fixed for the lifetime of the panel: it names the history entry
  // that every keystroke coalesces into, and seeds the preview's randomness so
  // a wiggle doesn't re-roll while you are watching it.
  const [bindingId, setBindingId] = React.useState<string | null>(bound?.id ?? null);
  const seeded = React.useRef(bound ? null : seedSource(type, literal));
  const [source, setSource] = React.useState(() => bound?.source ?? seeded.current ?? "");

  const analysis = useExpressionAnalysis(source, {
    expect: exprType,
    ctx,
    seedKey: bindingId ?? "fx_draft",
    // Caller's word first; otherwise ask the context itself, so a field on a
    // selected layer offers `#layer.*` and a document-level one warns instead.
    available: available ?? { layer: ctx.layer !== null, comp: ctx.comp !== null },
  });

  // Apply on every SETTLED source — the same debounce the linter runs on, so the
  // canvas updates exactly when the diagnostics do and the two never disagree
  // about what the document currently holds.
  const settled = analysis.settled;
  const bind = React.useRef(onChange);
  bind.current = onChange;
  React.useEffect(() => {
    if (settled.trim() === "") return;
    // Opening the panel must not bind anything. The editor starts seeded with
    // the field's own value so you can keep going from it, and until you change
    // that seed there is no expression — only a preview of what one would say.
    if (!bindingId && settled === seeded.current) return;
    if (bindingId) {
      store.update("Edit expression", (d) => setExpressionSource(d, bindingId, settled), {
        mergeKey: `expression:${bindingId}`,
      });
      return;
    }
    // The first real edit binds the field. Everything after this coalesces.
    let created: string | null = null;
    store.update("Bind expression", (d) => {
      created = addExpression(d, settled).id;
    });
    if (created) {
      setBindingId(created);
      bind.current(fxToken(created));
    }
  }, [settled, bindingId, store]);

  const detach = () => {
    onChange(detachedLiteral(type, analysis.preview?.value, literal));
    // The orphaned row is swept on the next load (`pruneExpressions`), the same
    // way an unused row from any other detach is.
    onClose();
  };

  return (
    <PopoverContent align="end" sideOffset={6} className={cn("w-[22rem] p-0", className)} {...rest}>
      <PopoverHeader className="flex items-center gap-2 px-2.5 py-2">
        <FunctionSquare className="size-3.5 shrink-0 text-[var(--syntax-function)]" />
        <span className="min-w-0 flex-1 text-xs font-medium">Expression</span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
          {TYPE_CHIP[exprType]}
        </span>
      </PopoverHeader>

      <ExpressionEditor
        source={source}
        onChange={setSource}
        analysis={analysis}
        autoFocus
        rows={3}
        onSubmit={onClose}
      />

      <PopoverFooter className="flex items-center gap-1 px-2 py-1.5">
        {bindingId && (
          <button
            type="button"
            onClick={detach}
            className="flex h-6 items-center gap-1.5 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3"
          >
            <Link2Off /> Remove
          </button>
        )}
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 text-[10px] text-muted-foreground/60">⌘⏎ to finish</span>
      </PopoverFooter>
    </PopoverContent>
  );
}

/**
 * The literal a field keeps when its expression is removed: whatever the
 * expression was SHOWING, so unlinking never moves anything on the canvas. The
 * field's old literal is only the fallback for an expression that couldn't run.
 */
export function detachedLiteral(
  type: VariableType,
  shown: ExprValue | undefined,
  fallback: unknown,
): string | number {
  if (type === "number" || type === "fontWeight") {
    return typeof shown === "number" ? shown : typeof fallback === "number" ? fallback : 0;
  }
  return typeof shown === "string" ? shown : String(fallback ?? "");
}

/** One label and one icon, so the menu row and the picker row read identically. */
export const WRITE_EXPRESSION_LABEL = "Write an expression…";
export const WriteExpressionIcon = Sparkles;

export { previewText };
