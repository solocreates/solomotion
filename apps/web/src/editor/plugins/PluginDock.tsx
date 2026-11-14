"use client";

import { FloatingWindow, pixelBounds } from "@/components/ui/floating-window";
import { PluginMark } from "./PluginIcon";
import { usePlugins } from "./plugins-store";
import type { RuntimePlugin } from "./plugin-model";
import { PluginBody } from "./PluginBody";
import { pluginWindowId, usePluginWindows, type PluginWindowState } from "./plugin-windows";

/**
 * The floating plugin layer (Figma-style): every windowed plugin renders in one
 * shared chrome. Which runtime draws the body is `PluginBody`'s question, not
 * this file's — the same body also runs docked inside the Plugins panel, and
 * fusing the two here is what used to make a window the only way to run a
 * plugin at all.
 */
export function PluginDock() {
  const windows = usePluginWindows((s) => s.windows);
  const plugins = usePlugins((s) => s.plugins);
  if (windows.length === 0) return null;
  return (
    <>
      {windows.map((w) => {
        const plugin = plugins.find((p) => p.id === w.pluginId);
        return plugin?.enabled ? <PluginWindow key={w.pluginId} win={w} plugin={plugin} /> : null;
      })}
    </>
  );
}

function PluginWindow({ win, plugin }: { win: PluginWindowState; plugin: RuntimePlugin }) {
  const close = usePluginWindows((s) => s.close);
  const toggleMinimized = usePluginWindows((s) => s.toggleMinimized);
  const setBounds = usePluginWindows((s) => s.setBounds);
  return (
    <FloatingWindow
      title={plugin.name}
      icon={<PluginMark icon={plugin.icon} size="sm" />}
      bounds={win}
      windowId={pluginWindowId(plugin.id)}
      onBoundsChange={(patch) => setBounds(plugin.id, pixelBounds(patch))}
      onClose={() => close(plugin.id)}
      onToggleMinimize={() => toggleMinimized(plugin.id)}
      // A sandboxed iframe fills the frame and scrolls inside its own document.
      body="fill"
    >
      <PluginBody
        plugin={plugin}
        onResize={(w, h) => setBounds(plugin.id, { width: w, height: h })}
        onClose={() => close(plugin.id)}
      />
    </FloatingWindow>
  );
}
