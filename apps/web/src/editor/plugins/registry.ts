"use client";

import { AudioLines, Music, Shapes, Type } from "lucide-react";
import type { BuiltinPluginDef } from "./plugin-model";

/**
 * Built-in (first-party) plugins. These are TRUSTED: ordinary React components
 * rendered in the shared plugin window, talking to the editor through the SAME
 * store as the built-in panels (`useDocStore`, `useSession`, @solomotion/core ops).
 * The manifest is bundled eagerly; each plugin's code is a lazy `import()` chunk
 * that loads only when its window first opens.
 *
 * `description` is ONE short line. It is rendered in a sidebar row and in a
 * menu, both of which truncate — a sentence with three clauses arrives as
 * "…templates, live styling, always in" and teaches the reader nothing except
 * that the panel is broken. Say what it does; the rest is the plugin's own UI.
 *
 * Third-party plugins are DIFFERENT — untrusted, sandboxed, message-bridged (see
 * ./sandbox). Both surface as `RuntimePlugin` through `usePlugins`, so the rest
 * of the app never distinguishes them; only the dock body chooses a runtime.
 */
export const BUILTIN_PLUGINS: BuiltinPluginDef[] = [
  {
    id: "icons",
    name: "Icons",
    description: "Every open-source icon set, drag and drop.",
    category: "Library",
    icon: Shapes,
    defaultSize: { width: 920, height: 640 },
    load: () => import("./icons/IconsPlugin"),
  },
  {
    id: "fonts",
    name: "Fonts",
    description: "Every font, set big, starred, yours.",
    category: "Library",
    icon: Type,
    defaultSize: { width: 1000, height: 680 },
    load: () => import("./fonts/FontsPlugin"),
  },
  {
    id: "sfx",
    name: "Sound Effects",
    description: "A whole SFX archive, auditioned one row at a time.",
    // A library, not an audio tool: you come here to FIND a sound, the way you
    // come to Icons to find a glyph. The Audio shelf is for things that
    // process what a project already has.
    category: "Library",
    icon: Music,
    defaultSize: { width: 960, height: 620 },
    load: () => import("./sfx/SfxPlugin"),
  },
  {
    id: "waveform",
    name: "Waveform Visualizer",
    description: "Waveforms that move with your audio.",
    category: "Audio",
    icon: AudioLines,
    defaultSize: { width: 780, height: 600 },
    load: () => import("./waveform/WaveformPlugin"),
  },
];
