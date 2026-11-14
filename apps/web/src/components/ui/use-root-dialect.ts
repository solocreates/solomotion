"use client";

import * as React from "react";

/**
 * A theme dialect, read from the root attribute a compiled theme sets
 * (`data-range`, `data-measure`, …). Parts are styled by CSS keyed on those
 * attributes; this is for the rare part whose BEHAVIOUR or markup also
 * depends on its dialect (a ruler's detents, a block bar's cells).
 *
 * One MutationObserver for the whole app, however many controls subscribe —
 * a panel holds dozens of ranges, and a theme changes twice a session.
 */
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!observer && typeof document !== "undefined") {
    observer = new MutationObserver(() => listeners.forEach((l) => l()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-range", "data-measure", "data-switch", "data-tabs", "data-labels"] });
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

/** The current value of `data-<attr>` on the root, without subscribing. */
export function rootDialect(attr: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.documentElement.getAttribute(`data-${attr}`) ?? undefined;
}

export function useRootDialect(attr: "range" | "measure" | "switch" | "tabs" | "labels"): string | undefined {
  return React.useSyncExternalStore(
    subscribe,
    () => rootDialect(attr),
    () => undefined,
  );
}
