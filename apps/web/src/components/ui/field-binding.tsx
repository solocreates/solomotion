"use client";

import * as React from "react";

/**
 * HOW A PLAIN CONTROL GETS THE BINDING MENU.
 *
 * "Make this value dynamic" — link a variable, write an expression, add a
 * modulator, key it — is the same question on every numeric field in the app,
 * and the answer already exists once, in `PropertyBindingMenu`. The problem was
 * never that the menu was missing; it was that only `ValueField` mounted it, so
 * a panel that laid out its own fields (the gradient tab, the pattern studio)
 * got bare inputs and no way in.
 *
 * The obvious fix — have `NumberInput` import the menu — inverts the layering:
 * `components/ui` is the generic half and must not reach into `editor/`. So the
 * generic half declares a SLOT, and the editor fills it. A control that knows
 * its property path renders through whatever decorator is installed above it,
 * and knows nothing about what that decorator does.
 *
 * The result is additive by construction. No provider, or no `path`, and the
 * control renders exactly as it did before — which is why turning this on could
 * not disturb the hundreds of inputs already in the app.
 */

export interface FieldBindingArgs {
  /** The property this control edits, e.g. `fill.<id>.start.x`. */
  path: string;
  /** Human name for the menu's heading and undo labels. */
  label: string;
  /** The control's current literal, for detach-to-value. */
  literal: number | string;
  kind?: "number" | "color";
  children: React.ReactNode;
}

export type FieldBindingRender = (args: FieldBindingArgs) => React.ReactNode;

const FieldBindingContext = React.createContext<FieldBindingRender | null>(null);

/** Install the decorator for a subtree. The editor does this once per surface
 *  that owns a clip; everything numeric inside inherits it. */
export function FieldBindingProvider({
  render,
  children,
}: {
  render: FieldBindingRender | null;
  children: React.ReactNode;
}) {
  return <FieldBindingContext.Provider value={render}>{children}</FieldBindingContext.Provider>;
}

/**
 * Wrap `children` in the installed decorator, or return them untouched.
 *
 * Untouched is the important half: a control with no path, or one rendered
 * outside any provider (a brush preset, a dialog, a story) keeps its exact
 * previous behaviour rather than degrading to a menu that would open onto
 * nothing.
 */
export function useFieldBinding(): (args: FieldBindingArgs) => React.ReactNode {
  const render = React.useContext(FieldBindingContext);
  return React.useCallback(
    (args: FieldBindingArgs) => (render ? render(args) : args.children),
    [render],
  );
}

/** Whether a decorator is installed — for a control deciding whether to offer
 *  an affordance at all (a right-click hint, a bound-state ring). */
export function useHasFieldBinding(): boolean {
  return React.useContext(FieldBindingContext) !== null;
}
