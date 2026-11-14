"use client";

import * as React from "react";
import {
  checkProgram,
  compileExpression,
  expressionById,
  exprTypeForVariable,
  variableValueNow,
  type ValueSource,
} from "@solomotion/core";
import { useSession } from "../state/session";
import { useDoc, useDocStore } from "../state/document-context";
import { evaluateAt, useExprContext } from "../expressions/expression-context";
import { previewText } from "../expressions/ExpressionEditor";
import { openBoardAtDriver } from "../inspector/driver-control";
import { findGraph } from "../nodes/graph-actions";
import type { DynamicFieldState } from "./dynamic-field";

/**
 * ONE description of a bound field, whichever of the three sources drives it and
 * whichever of the two storage seams holds the reference.
 *
 * The point is that nothing above this asks "is it an expression or a graph?".
 * A provider hands over the parsed source and how to open a panel; it gets back
 * the name, the live value, the error state and the two gestures — and passes
 * that straight into the field context. When a fourth kind of source arrives it
 * is one branch here and every input in the app understands it.
 */
export function useSourceState(
  source: ValueSource,
  opts: {
    /** Open one of the in-place panels the provider owns. */
    openPanel: (panel: "variable" | "expression") => void;
    /** Drop the reference, keeping the value on screen. */
    detach: () => void;
    /**
     * Ask for a formatted live value. Slots that STORE their reference need it
     * (the control is holding a token, not a number); path-addressed properties
     * do not, because the resolved document already handed the control its real
     * value.
     */
    withPreview?: boolean;
    /** The raw token, for a graph source — it names the node to open. */
    token?: string;
  },
): DynamicFieldState | null {
  const doc = useDoc();
  const store = useDocStore();
  const ctx = useExprContext();
  const { openPanel, detach, withPreview, token } = opts;

  const variable = source.kind === "variable" ? doc.variables.find((v) => v.id === source.id) : undefined;
  const expression = source.kind === "expression" ? (expressionById(doc, source.id) ?? null) : null;
  const graph = source.kind === "graph" ? findGraph(doc, source.graphId) : null;
  // A component input: the comp that defines it, and the definition.
  const inputHome = source.kind === "input" ? doc.frames.find((f) => f.inputs?.some((d) => d.id === source.id)) : undefined;
  const input = source.kind === "input" ? inputHome?.inputs?.find((d) => d.id === source.id) : undefined;

  return React.useMemo(() => {
    if (source.kind === "literal") return null;

    if (source.kind === "variable") {
      // A reference to a variable that no longer exists reads as an error rather
      // than as a working field showing a stale number.
      if (!variable) {
        return { ...state(source, null, null, "That variable was deleted", () => openPanel("variable"), detach), dead: true };
      }
      const value = variableValueNow(variable);
      return state(
        source,
        variable.name,
        withPreview ? format(value) : null,
        null,
        () => openPanel("variable"),
        detach,
      );
    }

    if (source.kind === "expression") {
      if (!expression) {
        return state(source, null, null, "That expression was deleted", () => openPanel("expression"), detach);
      }
      // The same checker the editor's diagnostics strip runs, so the tooltip on a
      // broken field says exactly what the panel would say when you open it.
      const check = checkProgram(compileExpression(expression.source), {
        // Only what an expression can READ — a paint has no expression type.
        variables: doc.variables.flatMap((v) => {
          const type = exprTypeForVariable(v.type);
          return type ? [{ id: v.id, name: v.name, type }] : [];
        }),
        expect: null,
      });
      const failure = check.diagnostics.find((d) => d.severity === "error");
      const shown = failure ? null : evaluateAt(expression.source, doc.variables, ctx, expression.id);
      return state(
        source,
        expression.name || null,
        withPreview ? previewText(shown) : null,
        failure?.message ?? (shown ? null : "This isn’t producing a value"),
        () => openPanel("expression"),
        detach,
      );
    }

    if (source.kind === "input") {
      // Opens the comp that owns it, whose Design tab lists its inputs.
      const open = () => inputHome && useSession.getState().selectFrame(inputHome.id);
      if (!input) return state(source, null, null, "That input was deleted", open, detach);
      return state(source, input.name, withPreview ? format(input.default) : null, null, open, detach);
    }

    return state(
      source,
      graph?.name || null,
      null,
      graph ? null : "That node graph was deleted",
      () => {
        if (token) openBoardAtDriver(store, token);
      },
      detach,
    );
  }, [source, variable, expression, graph, inputHome, input, doc.variables, ctx, withPreview, token, store, openPanel, detach]);
}

function state(
  source: ValueSource,
  name: string | null,
  preview: string | null,
  error: string | null,
  open: () => void,
  detach: () => void,
): DynamicFieldState {
  return { source: source as DynamicFieldState["source"], name, preview, error, open, detach };
}

/** A variable's value as a field shows it — the same rounding the expression
 *  preview uses, so one value never reads two ways in two places. */
function format(value: unknown): string {
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value && typeof value === "object" && "x" in value) {
    const v = value as { x: number; y: number };
    return `${Math.round(v.x * 100) / 100}, ${Math.round(v.y * 100) / 100}`;
  }
  return String(value ?? "");
}
