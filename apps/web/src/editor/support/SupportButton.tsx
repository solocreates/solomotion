"use client";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { product } from "../product";
import { useSupport } from "./support-store";
import { SupportPanel } from "./SupportPanel";
import { WarmHeart } from "./WarmHeart";
import s from "./support.module.css";

/**
 * The top bar's Support entry for an open product, and the popover it owns.
 * A popover, not a modal: support is a thing you glance at beside your work,
 * anchored to what you pressed, gone with a click outside.
 *
 * The heart warms (fills from the bottom) on hover and stays warm while open;
 * opening beats it once. All CSS — see `support.module.css`.
 */
export function SupportButton({ compact }: { compact: boolean }) {
  const open = useSupport((st) => st.open);
  const support = product.support;
  if (!support) return null;
  return (
    <Popover open={open} onOpenChange={(v) => useSupport.getState().setOpen(v)}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Support" className={cn(s.button, "data-[state=open]:bg-pressed")}>
          <WarmHeart className="size-4" />
          {!compact && "Support"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[22rem] p-0">
        <div className="min-h-0 overflow-y-auto">
          <SupportPanel support={support} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
