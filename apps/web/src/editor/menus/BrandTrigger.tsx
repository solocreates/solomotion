"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { product } from "../product";

/**
 * The logo that opens the app menu — the top bar's and Home's, one button.
 *
 * Wide: the product's real lockup (`product.Lockup`). Compact: the mark alone,
 * the way every app icon shrinks. Busy (an agent at work, an export): the
 * lockup moves in its own way, or the mark becomes the loader.
 */
export const BrandTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { compact: boolean; busy?: boolean }
>(function BrandTrigger({ compact, busy = false, className, ...rest }, ref) {
  const Mark = busy ? product.Loader : product.Mark;
  return (
    <button
      ref={ref}
      type="button"
      aria-label="Main menu"
      className={cn(
        "group flex h-(--control-h-lg) shrink-0 items-center gap-1.5 rounded-md px-2 text-fg transition-colors hover:bg-hover data-[state=open]:bg-hover",
        className,
      )}
      {...rest}
    >
      {compact ? (
        <Mark size={20} className="size-5 shrink-0" />
      ) : (
        <product.Lockup busy={busy} className="text-[1.25rem]" />
      )}
      <ChevronDown className="size-3 text-fg-faint transition-transform group-data-[state=open]:rotate-180" />
    </button>
  );
});
