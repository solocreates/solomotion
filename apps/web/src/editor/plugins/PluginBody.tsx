"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { SandboxHost } from "./sandbox/SandboxHost";
import type { RuntimePlugin } from "./plugin-model";
import { lazyComponent } from "@/editor/lazy-component";

/**
 * A running plugin, host-agnostic.
 *
 * This is the only place that knows a plugin has two runtimes: a trusted
 * built-in is a lazily-imported React chunk; an installed one is an iframe
 * bridged through SandboxHost. Everything ABOVE it — the floating window, the
 * docked Plugins panel — just asks for a body and gets one.
 *
 * It used to live inside `PluginDock`, fused to the window chrome, which meant
 * "run a plugin" and "float a window" were the same act and a plugin could only
 * ever appear in a window. Splitting them is what lets the panel host one.
 *
 * `onResize` / `onClose` are what a plugin can ask of its HOST through the
 * bridge. A window can grant both; a docked panel is sized by the sidebar and
 * closes by going back, so it answers what it can and ignores the rest.
 */
export function PluginBody({
  plugin,
  onResize,
  onClose,
}: {
  plugin: RuntimePlugin;
  onResize?: (width: number, height: number) => void;
  onClose?: () => void;
}) {
  if (plugin.runtime.kind === "internal") {
    return <InternalBody id={plugin.id} load={plugin.runtime.load} />;
  }
  return (
    <SandboxHost
      installed={plugin.runtime.installed}
      granted={plugin.runtime.granted}
      onResize={(w, h) => onResize?.(w, h)}
      onClose={() => onClose?.()}
    />
  );
}

// One lazy component per built-in id, cached so re-opens don't re-mount fresh.
const lazyCache = new Map<string, React.LazyExoticComponent<React.ComponentType>>();
function lazyInternal(id: string, load: () => Promise<{ default: React.ComponentType }>) {
  let entry = lazyCache.get(id);
  if (!entry) {
    entry = lazyComponent(`plugin/${id}`, load);
    lazyCache.set(id, entry);
  }
  return entry;
}

function InternalBody({ id, load }: { id: string; load: () => Promise<{ default: React.ComponentType }> }) {
  const Body = lazyInternal(id, load);
  return (
    <React.Suspense
      fallback={
        <div className="flex h-full min-h-32 items-center justify-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      }
    >
      <Body />
    </React.Suspense>
  );
}
