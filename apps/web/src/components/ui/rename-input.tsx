"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Inline rename field — the one input every double-click-to-rename surface
 * uses (layers panel rows, frame labels on the canvas, …). Autofocuses and
 * selects all on mount; commits on Enter/blur; Escape reverts to `initial`.
 */
export function RenameInput({
  initial,
  onCommit,
  className,
  ...rest
}: {
  initial: string;
  onCommit: (name: string) => void;
  className?: string;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "onBlur" | "onKeyDown" | "onFocus" | "onPointerDown"
>) {
  const [value, setValue] = React.useState(initial);
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onCommit(value);
        if (e.key === "Escape") onCommit(initial);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn("outline-none", className)}
      {...rest}
    />
  );
}
