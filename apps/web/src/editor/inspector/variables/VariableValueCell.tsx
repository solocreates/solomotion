"use client";

import * as React from "react";
import { resolvePaint, type Paint, type Variable } from "@solomotion/core";
import { PICKER_MAX_HEIGHT, PICKER_PLACEMENT, PICKER_WIDTH } from "@/components/ui/color-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../../state/document-context";
import { PaintPreview } from "../../paint/PaintPreview";
import { PaintEditorBody } from "../PaintPopover";
import { VariableValueField } from "./VariableValueField";
import { useVariablePaintHost } from "./variable-paint-host";

/**
 * A variable's editor cell. Everything except a FILL is already served by
 * `VariableValueField`; a fill opens the app's own paint editor over a host
 * that addresses the variable instead of a layer.
 *
 * That indirection is the point. A fill style edited in a bespoke panel would
 * have needed its own gradient rail, its own pattern studio and its own media
 * picker within a week of existing, and the two would have started disagreeing
 * about what a stop is. One editor, two hosts.
 */
export function VariableValueCell({
  variable,
  value,
  onChange,
  className,
}: {
  variable: Variable;
  value: Variable["value"];
  onChange: (value: Variable["value"]) => void;
  className?: string;
}) {
  if (variable.type === "paint") {
    return <PaintValueCell variable={variable} value={value as Paint} className={className} />;
  }
  return <VariableValueField variable={variable} value={value} onChange={onChange} className={className} />;
}

function PaintValueCell({
  variable,
  value,
  className,
}: {
  variable: Variable;
  value: Paint;
  className?: string;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const host = useVariablePaintHost(store, variable);
  const resolved = React.useMemo(() => resolvePaint(doc, value), [doc, value]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Edit ${variable.name}`}
          className={cn(
            "relative size-5 shrink-0 overflow-hidden rounded-md shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25),inset_0_0_0_1px_rgba(255,255,255,0.1)] transition-transform hover:scale-105",
            className,
          )}
        >
          <PaintPreview paint={resolved} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...PICKER_PLACEMENT}
        className={cn("p-0", PICKER_WIDTH)}
        style={{ maxHeight: PICKER_MAX_HEIGHT }}
      >
        {host.fills[0] && <PaintEditorBody host={host} kind="fill" id={host.fills[0].id} eff={resolved} />}
      </PopoverContent>
    </Popover>
  );
}
