"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { DynamicGlyph, useAcceptTyped, useDynamicControl } from "@/editor/binding/dynamic-field";

function Input({ className, type, onKeyDown, onBlur, ...props }: React.ComponentProps<"input">) {
  // A driven text field shows the text its source produces. Typing into it would
  // write a literal the source overwrites on the next frame, so the press opens
  // the source instead (⌥-press detaches, keeping what is on screen).
  const dynamic = useDynamicControl();
  // A free one can BECOME driven: an expression typed in and committed binds the
  // field. Enter and blur are the commit points a text field already has.
  const acceptTyped = useAcceptTyped();
  if (dynamic) {
    return (
      <div
        data-part="field"
        className={cn(
          "flex h-(--control-h) w-full px-2 text-body items-center gap-1.5",
          dynamic.className,
          className,
        )}
        style={dynamic.style}
        {...dynamic.props}
      >
        <DynamicGlyph field={dynamic.field} />
        <span className="min-w-0 flex-1 truncate">
          {dynamic.field.preview ?? String(props.value ?? "")}
        </span>
      </div>
    );
  }
  return (
    <input
      type={type}
      onKeyDown={(e) => {
        if (e.key === "Enter" && acceptTyped?.(e.currentTarget.value)) {
          e.preventDefault();
          e.currentTarget.blur();
          return;
        }
        onKeyDown?.(e);
      }}
      onBlur={(e) => {
        if (acceptTyped?.(e.currentTarget.value)) return;
        onBlur?.(e);
      }}
      data-part="field"
      className={cn(
        "flex h-(--control-h) w-full px-2 text-body file:border-0 file:bg-transparent file:text-body file:font-medium placeholder:text-fg-faint focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
