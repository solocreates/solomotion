"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspace } from "../state/workspace";

/**
 * The one row of color dots used everywhere something takes a WORKSPACE color
 * (markers, track tints, groups, …): a fixed preset palette, the user's own
 * custom colors (app-level — they follow the user into every project), and a
 * "+" dot that adds a new custom color. Right-click a custom dot to remove it
 * from the palette (whatever already uses that color keeps it).
 */

export const WORKSPACE_PRESET_COLORS = [
  "#5B9CF6", // blue
  "#F5B843", // amber
  "#E5484D", // red
  "#46A758", // green
  "#B18CFF", // violet
  "#F4F2ED", // paper
];

export function WorkspaceColorPicker({
  value,
  onChange,
  className,
}: {
  value: string | null;
  onChange: (color: string) => void;
  className?: string;
}) {
  const customColors = useWorkspace((s) => s.customColors);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const dot = (c: string, custom: boolean) => (
    <button
      key={c}
      type="button"
      aria-label={`Color ${c}`}
      title={custom ? `${c} — right-click removes it from your palette` : c}
      onClick={() => onChange(c)}
      onContextMenu={(e) => {
        if (!custom) return;
        e.preventDefault();
        e.stopPropagation();
        useWorkspace.getState().removeCustomColor(c);
      }}
      className={cn(
        "size-5 shrink-0 rounded-full border-2 transition-transform hover:scale-110",
        value !== null && value.toUpperCase() === c.toUpperCase()
          ? "border-foreground"
          : "border-transparent",
      )}
      style={{ background: c }}
    />
  );

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {WORKSPACE_PRESET_COLORS.map((c) => dot(c, false))}
      {customColors.map((c) => dot(c, true))}
      <button
        type="button"
        aria-label="Add a custom color"
        title="Add a custom color to your palette"
        onClick={() => inputRef.current?.click()}
        className="flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground [&_svg]:size-3"
      >
        <Plus />
      </button>
      {/* Hidden native picker: picking adds to the app palette AND applies. */}
      <input
        ref={inputRef}
        type="color"
        defaultValue={value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#5B9CF6"}
        onChange={(e) => {
          const c = e.target.value.toUpperCase();
          useWorkspace.getState().addCustomColor(c);
          onChange(c);
        }}
        className="pointer-events-none absolute size-0 opacity-0"
        tabIndex={-1}
      />
    </div>
  );
}
