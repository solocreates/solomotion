"use client";

import * as React from "react";
import { suggestVariables, variableCssName, variableValueNow, type VariableType } from "@solomotion/core";
import { useOptionalDocStore } from "../state/document-context";

export interface VariableSuggestion {
  id: string;
  /** As typed: `--brand-deep`. */
  cssName: string;
  /** The value now, formatted short. */
  preview: string;
  /** A swatch, for colours. */
  swatch?: string;
}

function previewOf(value: unknown): { preview: string; swatch?: string } {
  if (typeof value === "number") return { preview: String(Math.round(value * 1000) / 1000) };
  if (typeof value === "string") return /^#[0-9a-f]{3,8}$/i.test(value) ? { preview: value, swatch: value } : { preview: value };
  return { preview: "" };
}

/**
 * What `--…` typed into a field offers: the document's variables of a type the
 * slot takes, by their typed spelling. Empty outside a document (a settings
 * dialog), so a generic field asks without knowing where it is.
 */
export function useVariableSuggestions(query: string | null, types: readonly VariableType[]): VariableSuggestion[] {
  const store = useOptionalDocStore();
  return React.useMemo(() => {
    if (query === null || !store) return [];
    return suggestVariables(store.getState(), query, types).map((v) => ({
      id: v.id,
      cssName: variableCssName(v.name),
      ...previewOf(variableValueNow(v)),
    }));
    // `types` is a constant list at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, store]);
}

/**
 * The list under a field while someone types `--`. Keyboard is the field's
 * (it keeps focus); this only draws and takes a pointer pick. Rows are the
 * menu part, so every theme's menu dialect applies.
 */
export function VariableSuggestList({
  items,
  active,
  query,
  onPick,
}: {
  items: VariableSuggestion[];
  active: number;
  query: string;
  onPick: (s: VariableSuggestion) => void;
}) {
  return (
    <div
      data-part="menu"
      role="listbox"
      className="absolute left-0 top-[calc(100%+4px)] z-50 flex min-w-56 max-w-80 flex-col gap-px p-1"
      // Keep focus in the field: a pick happens on press, before blur commits.
      onPointerDown={(e) => e.preventDefault()}
    >
      {items.length === 0 ? (
        <div className="px-2 py-1.5 font-mono text-meta text-fg-faint">No variable {query || "--"} here</div>
      ) : (
        items.map((s, i) => (
          <div
            key={s.id}
            role="option"
            aria-selected={i === active}
            data-part="menu-item"
            className="flex h-(--control-h-sm) cursor-default items-center gap-2 px-2 font-mono text-meta"
            onPointerDown={(e) => {
              e.preventDefault();
              onPick(s);
            }}
          >
            {s.swatch && <span className="size-2.5 shrink-0 rounded-[2px] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.2)]" style={{ background: s.swatch }} />}
            <span className="truncate">{s.cssName}</span>
            <span className="ml-auto pl-3 text-fg-faint">{s.preview}</span>
          </div>
        ))
      )}
    </div>
  );
}

export { variableCssName };
