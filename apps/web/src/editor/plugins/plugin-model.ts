import type * as React from "react";
import type { LucideIcon } from "lucide-react";
import type { Capability, PluginManifest } from "@solomotion/plugin-sdk";

/**
 * The unified plugin model. Built-in (first-party, trusted, in-process React)
 * and installed (third-party, sandboxed iframe) plugins are DIFFERENT runtimes,
 * but the rest of the app only ever sees one shape — `RuntimePlugin`. That's the
 * whole point: the dock, the menu and the manager don't branch on trust; they
 * render a plugin. Only the dock's body chooses a runtime.
 */

/** How a plugin's avatar is drawn. */
export type PluginIcon =
  | { kind: "lucide"; icon: LucideIcon }
  | { kind: "image"; src: string }
  | { kind: "initial"; text: string; hue: number };

/** A plugin bundle: bytes keyed by forward-slash relative path (manifest at root). */
export type PluginBundleFiles = Record<string, Uint8Array>;

/** Where an installed plugin came from — drives the manager badge + reload. */
export type PluginSource =
  | { kind: "file"; fileName: string } // a .zip / .atomplugin the user uploaded
  | { kind: "folder"; folderName: string } // a dev folder (live reload, Chromium)
  | { kind: "sample" }; // the bundled example

/** The persisted record for a user-installed plugin. */
export interface InstalledPlugin {
  manifest: PluginManifest;
  files: PluginBundleFiles;
  source: PluginSource;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
}

/** A first-party plugin — trusted React, code-split, bundled with the editor. */
export interface BuiltinPluginDef {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: LucideIcon;
  defaultSize: { width: number; height: number };
  load: () => Promise<{ default: React.ComponentType }>;
}

export interface PluginWindowSize {
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  resizable: boolean;
}

/** The one shape the UI renders — built-in OR installed. */
export interface RuntimePlugin {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: PluginIcon;
  /** semver for installed plugins; null for built-ins. */
  version: string | null;
  author: string | null;
  window: PluginWindowSize;
  builtin: boolean;
  enabled: boolean;
  /** null for built-ins (nothing to uninstall). */
  source: PluginSource | null;
  runtime:
    | { kind: "internal"; load: () => Promise<{ default: React.ComponentType }> }
    | { kind: "sandboxed"; installed: InstalledPlugin; granted: Capability[] };
}

// ── Adapters (built-in / installed → RuntimePlugin) ──────────────────────────

export function toRuntimeFromBuiltin(def: BuiltinPluginDef): RuntimePlugin {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    category: def.category,
    icon: { kind: "lucide", icon: def.icon },
    version: null,
    author: null,
    window: { width: def.defaultSize.width, height: def.defaultSize.height, resizable: true },
    builtin: true,
    enabled: true,
    source: null,
    runtime: { kind: "internal", load: def.load },
  };
}

export function toRuntimeFromInstalled(installed: InstalledPlugin, iconUrl: string | null): RuntimePlugin {
  const m = installed.manifest;
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    category: m.categories[0] ?? "Plugin",
    icon: iconUrl ? { kind: "image", src: iconUrl } : { kind: "initial", text: initialFor(m.name), hue: hueFor(m.id) },
    version: m.version,
    author: m.author.name,
    window: {
      width: m.window.width,
      height: m.window.height,
      minWidth: m.window.minWidth,
      minHeight: m.window.minHeight,
      resizable: m.window.resizable,
    },
    builtin: false,
    enabled: installed.enabled,
    source: installed.source,
    // Grant exactly what the manifest declared — the bridge is the real gate,
    // this just carries the set through to the sandbox context.
    runtime: { kind: "sandboxed", installed, granted: m.capabilities },
  };
}

// ── Generated-avatar helpers (fallback when a plugin ships no icon) ──────────

export function initialFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}
