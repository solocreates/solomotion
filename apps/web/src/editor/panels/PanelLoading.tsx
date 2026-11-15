"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { product } from "../product";

/**
 * THE ONE "this panel's code is still arriving" state — the product's own
 * loader (SoloMotion's dial, or another product's mark), centred in whatever the panel
 * occupies. Fades in, so a chunk that is already cached never flashes it.
 *
 * Every panel body renders inside a boundary that shows this
 * ({@link PanelBoundary}); a lazy panel only has to BE lazy. A per-panel
 * fallback is how Agents and Scripts ended up with an empty `<div>` each.
 */
export function PanelLoading({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-busy
      aria-label="Loading"
      className={cn("flex h-full min-h-24 w-full items-center justify-center text-fg-muted animate-in fade-in-0 duration-300", className)}
    >
      <product.Loader size={20} />
    </div>
  );
}

/** The Suspense boundary every panel host renders a body inside. */
export function PanelBoundary({ children }: { children: React.ReactNode }) {
  return <React.Suspense fallback={<PanelLoading />}>{children}</React.Suspense>;
}
