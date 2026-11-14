"use client";

import * as React from "react";
import { addExpression, findVariableByCssName, fxToken, readTypedValue, varToken, type ExprType } from "@solomotion/core";
import { useDocStore } from "../state/document-context";
import type { AcceptTyped } from "./dynamic-field";

/**
 * TYPING AN EXPRESSION INTO A FIELD, wherever fields are.
 *
 * `readTypedValue` decides what the text IS (core, pure, tested). This is the
 * one place that acts on the answer: mint the expression, bind the field, name
 * the history entry. Both binding wrappers hand the result to their controls
 * through `DynamicFieldProvider`, so every input in the app gained the gesture
 * without a single call site changing — and a control that is not wrapped is
 * untouched, because there is nothing to accept its text.
 *
 * `bind` is deliberately the SAME writer the menus use (a driver token for a
 * path-addressed property, an `onChange` for a slot). Typing an expression and
 * choosing "Write an expression…" must produce the identical document; a second
 * write path here is how the two would drift.
 */
export function useTypedSourceBinder(opts: {
  /** The type of the slot, so a number field can tell `-5` from a subtraction. */
  expect: ExprType | null;
  /** Write the reference token into wherever this field keeps its source. */
  bind: (token: string) => void;
  /** No binding while a field is disabled, multi-selected or in range mode. */
  disabled?: boolean;
}): AcceptTyped | null {
  const store = useDocStore();
  const { expect, bind, disabled } = opts;
  return React.useMemo(() => {
    if (disabled) return null;
    return (text: string) => {
      // `--brand-deep` names a document variable the way a field spells it.
      if (/^\s*--[\w-]+\s*$/.test(text)) {
        const v = findVariableByCssName(store.getState(), text);
        if (!v) return false;
        bind(varToken(v.id));
        return true;
      }
      const typed = readTypedValue(text, expect);
      if (typed.kind === "literal") return false;
      if (typed.kind === "token") {
        bind(typed.token);
        return true;
      }
      let created: string | null = null;
      store.update("Write expression", (d) => {
        created = addExpression(d, typed.source).id;
      });
      if (!created) return false;
      bind(fxToken(created));
      return true;
    };
  }, [store, expect, bind, disabled]);
}
