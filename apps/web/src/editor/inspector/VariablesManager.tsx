"use client";

import * as React from "react";
import { Boxes, ChevronRight } from "lucide-react";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { PanelSection } from "./controls";

/**
 * Sidebar entry to the document's variables. The full Figma-style manager lives
 * in the floating `VariablesWindow` (typed tables, filters, per-type editors);
 * here we show a compact summary per type and a button to open it — so the
 * inspector stays lean while variables scale to any type.
 */
export function VariablesManager() {
  const doc = useDoc();
  const openVariables = useSession((s) => s.setVariablesOpen);

  const counts = React.useMemo(() => {
    const c = new Map<string, number>();
    for (const v of doc.variables) c.set(v.type, (c.get(v.type) ?? 0) + 1);
    return c;
  }, [doc.variables]);

  const summary =
    doc.variables.length === 0
      ? "None yet"
      : (["color", "number", "fontFamily", "fontWeight", "string"] as const)
          .map((t) => (counts.get(t) ? `${counts.get(t)} ${LABEL[t]}` : null))
          .filter(Boolean)
          .join(" · ");

  return (
    <PanelSection title="Variables" defaultOpen>
      <button
        type="button"
        onClick={() => openVariables(true)}
        className="flex w-full items-center gap-2 rounded-md border border-border/70 px-2.5 py-2 text-left transition-colors hover:border-primary/50 hover:bg-muted/40"
      >
        <Boxes className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">Manage variables</div>
          <div className="truncate text-[10px] text-muted-foreground">{summary}</div>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </PanelSection>
  );
}

const LABEL: Record<string, string> = {
  color: "color",
  number: "number",
  fontFamily: "font",
  fontWeight: "weight",
  string: "text",
};
