"use client";

import * as React from "react";
import { Globe, Server, Sparkles } from "lucide-react";
import { providerDef } from "@solomotion/agent";
import { cn } from "@/lib/utils";
import { PROVIDER_LOGOS } from "../provider-logos";

/**
 * A provider's mark in a rounded tile — brand colours when the mark has them,
 * ink otherwise. `builtin` is the agent built into the app; a provider behind
 * the product's own account wears the same spark.
 */
export function ProviderMark({ providerId, className }: { providerId: string; className?: string }) {
  const logo = PROVIDER_LOGOS[providerId];
  const Fallback = providerId === "custom" ? Server : providerId === "builtin" || providerDef(providerId)?.auth === "account" ? Sparkles : Globe;
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg border bg-background/70 text-foreground", className)}>
      {logo ? (
        <svg viewBox={logo.viewBox} fill="currentColor" fillRule="evenodd" className="size-[62%]" aria-hidden dangerouslySetInnerHTML={{ __html: logo.body }} />
      ) : (
        <Fallback className="size-[58%] text-muted-foreground" />
      )}
    </span>
  );
}
