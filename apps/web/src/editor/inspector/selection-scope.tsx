"use client";

import * as React from "react";
import type { Clip } from "@solomotion/core";

/**
 * THE SELECTION IS THE SUBJECT.
 *
 * Every inspector section is written against ONE clip — the primary — and the
 * scope is what turns it into an editor of the whole selection, in both
 * directions:
 *
 *   write   `useClipUpdater` runs the section's mutation against every clip
 *           in scope, in one undo step (see `use-clip-updater.ts`).
 *   read    `usePeers` hands the section every clip it is showing, so each
 *           field reports the primary's value plus whether the selection
 *           disagrees (`mergeReads` / `useField`) — and says "Mixed".
 *
 * `LayerSections` provides the scope around every tab, for a selection of one
 * as much as a selection of fifty, so there is no single-clip path and no
 * multi-clip path: there is one panel, and it is asked about N clips. A section
 * that only makes sense for one layer says so in its `applies`, not by being a
 * different component.
 */
export interface SelectionScopeValue {
  /** Every clip an edit fans to and a field merges over — primary first. */
  clips: readonly Clip[];
  ids: readonly string[];
}

const SelectionScopeContext = React.createContext<SelectionScopeValue | null>(null);

export function SelectionScope({ clips, children }: { clips: readonly Clip[]; children: React.ReactNode }) {
  const key = clips.map((c) => c.id).join(",");
  const ids = React.useMemo(() => key.split(",").filter(Boolean), [key]);
  const value = React.useMemo(() => ({ clips, ids }), [clips, ids]);
  return <SelectionScopeContext.Provider value={value}>{children}</SelectionScopeContext.Provider>;
}

/** The ids an edit fans to, or null outside a scope (then it edits its own clip). */
export function useSelectionScope(): readonly string[] | null {
  return React.useContext(SelectionScopeContext)?.ids ?? null;
}

/**
 * The clips a section showing `clip` merges over: `clip` first, then every
 * other clip in scope that `is` admits. Outside a scope, just `[clip]`.
 *
 * `is` is required rather than defaulted to "same kind" because the two cases
 * look identical and disagree: a shape's geometry merges over shapes, but its
 * motion blur merges over every visual layer in the selection — a default
 * would silently drop the text layer from the second.
 */
export function usePeers<C extends Clip>(clip: C, is: (c: Clip) => c is C): readonly C[] {
  const scope = React.useContext(SelectionScopeContext);
  return React.useMemo(() => {
    // Same rule as the write seam: a clip outside the scope is shown alone.
    if (!scope || !scope.ids.includes(clip.id)) return [clip];
    const rest = scope.clips.filter((c): c is C => c.id !== clip.id && is(c));
    return rest.length === 0 ? [clip] : [clip, ...rest];
  }, [scope, clip, is]);
}

/** Admits every clip — for sections whose fields every layer carries. */
export const anyClip = (_c: Clip): _c is Clip => true;

/**
 * A kind guard for `usePeers`, e.g. `const isShape = ofKind("shape")`. Build it
 * once at module level — `usePeers` memoises on its identity.
 */
export function ofKind<K extends Clip["kind"]>(...kinds: K[]) {
  const set: ReadonlySet<string> = new Set(kinds);
  return (c: Clip): c is Extract<Clip, { kind: K }> => set.has(c.kind);
}
