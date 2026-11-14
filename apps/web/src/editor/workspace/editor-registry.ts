/**
 * THE EDITOR REGISTRY — every kind of view the workspace can host, described
 * once, headless (no React, no icons — those bind in `panels/panel-registry`).
 *
 * `PANELS` used to be this list's ancestor, and it knew one fact about a panel
 * that was really a fact about the LAYOUT: its `side`. A panel born "left"
 * could only ever be left, so the app had no docking, no splitting, no
 * per-user arrangement — the side was the arrangement. Here an editor declares
 * only what is true of the view itself: what it is, which group it belongs to,
 * how small it may get, how it zooms (D5) and which hosts it allows (D4).
 * Where it LIVES is the layout tree's business (`layout-tree.ts`).
 *
 * Order here is menu order inside a group, and the default rail order for the
 * left region (D10: Layers first, then Assets, Media · Agents, Scripts,
 * Plugins). A new editor is ONE entry; every union below derives from it.
 */

/** The editor-switcher's columns (D3). */
export type EditorGroup = "design" | "motion" | "colorfx" | "sound" | "assets" | "extend";

export const EDITOR_GROUPS: readonly { id: EditorGroup; name: string }[] = [
  { id: "design", name: "Design" },
  { id: "motion", name: "Motion" },
  { id: "colorfx", name: "Color & FX" },
  { id: "sound", name: "Sound" },
  { id: "assets", name: "Assets" },
  { id: "extend", name: "Extend" },
];

/** How a view zooms (D5) — `none` for views with nothing to magnify. */
export type ZoomKind = "camera" | "time" | "reflow" | "none";

/** Where an editor may be shown (D4). */
export type HostKind = "docked" | "floating" | "window";

export interface EditorMeta {
  id: string;
  name: string;
  group: EditorGroup;
  /** Tooltip line — what the view IS, not what the button does. */
  hint: string;
  /** Smallest usable box, CSS px. The drop solver refuses a split that breaks it. */
  minSize: { w: number; h: number };
  zoom: ZoomKind;
  hosts: readonly HostKind[];
  /** False only for the stage: there is always a canvas. */
  closable: boolean;
  /** Opening size for a floating / OS window. */
  floatSize: { w: number; h: number };
  /** Shortcut shown in the switcher (display only; the keymap owns binding). */
  shortcut?: string;
}

const ANY: readonly HostKind[] = ["docked", "floating", "window"];

export const EDITORS = [
  // ── Design
  { id: "stage", name: "Stage", group: "design", hint: "The canvas", minSize: { w: 240, h: 160 }, zoom: "camera", hosts: ["docked"], closable: false, floatSize: { w: 800, h: 520 } },
  { id: "layers", name: "Layers", group: "design", hint: "The document's structure", minSize: { w: 200, h: 160 }, zoom: "none", hosts: ANY, closable: true, floatSize: { w: 264, h: 440 } },
  { id: "inspector", name: "Properties", group: "design", hint: "The selected layer's properties", minSize: { w: 240, h: 200 }, zoom: "none", hosts: ANY, closable: true, floatSize: { w: 340, h: 540 } },
  // ── Motion
  { id: "timeline", name: "Timeline", group: "motion", hint: "The track lanes", minSize: { w: 320, h: 96 }, zoom: "time", hosts: ANY, closable: true, floatSize: { w: 900, h: 320 } },
  { id: "keys", name: "Keyframes", group: "motion", hint: "Dope sheet — every keyframe as a grid", minSize: { w: 320, h: 96 }, zoom: "time", hosts: ANY, closable: true, floatSize: { w: 900, h: 320 } },
  { id: "curves", name: "Curves", group: "motion", hint: "Value and speed graphs", minSize: { w: 320, h: 120 }, zoom: "time", hosts: ANY, closable: true, floatSize: { w: 900, h: 360 } },
  // ── Color & FX
  { id: "color", name: "Color", group: "colorfx", hint: "Grade the selected layer", minSize: { w: 360, h: 160 }, zoom: "none", hosts: ANY, closable: true, floatSize: { w: 900, h: 360 } },
  { id: "nodes", name: "Nodes", group: "colorfx", hint: "The selected layer's node graph", minSize: { w: 320, h: 160 }, zoom: "camera", hosts: ANY, closable: true, floatSize: { w: 900, h: 440 } },
  // ── Sound
  { id: "mixer", name: "Mixer", group: "sound", hint: "Buses, meters and the master", minSize: { w: 160, h: 96 }, zoom: "none", hosts: ANY, closable: true, floatSize: { w: 360, h: 320 } },
  // ── Assets
  { id: "library", name: "Library", group: "assets", hint: "Browse presets, components and sounds", minSize: { w: 220, h: 200 }, zoom: "reflow", hosts: ANY, closable: true, floatSize: { w: 420, h: 560 } },
  { id: "media", name: "Media", group: "assets", hint: "This project's files and folders", minSize: { w: 220, h: 200 }, zoom: "reflow", hosts: ANY, closable: true, floatSize: { w: 320, h: 480 } },
  // ── Extend
  { id: "agents", name: "Agents", group: "extend", hint: "Ask AI to design, animate and edit", minSize: { w: 280, h: 240 }, zoom: "none", hosts: ANY, closable: true, floatSize: { w: 380, h: 620 } },
  { id: "scripts", name: "Scripts", group: "extend", hint: "Run JavaScript against this project", minSize: { w: 320, h: 240 }, zoom: "none", hosts: ANY, closable: true, floatSize: { w: 760, h: 560 } },
  { id: "plugins", name: "Plugins", group: "extend", hint: "Your tools — run one right here", minSize: { w: 240, h: 240 }, zoom: "reflow", hosts: ANY, closable: true, floatSize: { w: 340, h: 560 } },
] as const satisfies readonly EditorMeta[];

export type EditorId = (typeof EDITORS)[number]["id"];

const BY_ID = new Map<string, EditorMeta>(EDITORS.map((e) => [e.id, e]));

export function editorMeta(id: string): EditorMeta | undefined {
  return BY_ID.get(id);
}

export function isEditorId(id: unknown): id is EditorId {
  return typeof id === "string" && BY_ID.has(id);
}

export function allowsHost(id: EditorId, host: HostKind): boolean {
  return (editorMeta(id)?.hosts ?? []).includes(host);
}

/** Editors in switcher order, grouped (empty groups dropped). */
export function editorsByGroup(): { group: EditorGroup; name: string; editors: EditorMeta[] }[] {
  return EDITOR_GROUPS.map((g) => ({
    group: g.id,
    name: g.name,
    editors: EDITORS.filter((e) => e.group === g.id),
  })).filter((g) => g.editors.length > 0);
}

/**
 * The editors that share the bottom region's TIME AXIS. Today they stack
 * inside one region (lanes over a graph, beside a mixer) and their open state
 * lives in their own stores; the layout tree records WHICH region hosts them,
 * the stores still say which are showing inside it.
 */
export const TIME_FAMILY: readonly EditorId[] = ["timeline", "keys", "curves", "color", "nodes", "mixer"];

/** The default left region, D10 order: Layers first. */
export const LEFT_DEFAULT: readonly EditorId[] = ["layers", "library", "media", "agents", "scripts", "plugins"];

/**
 * Filter for the switcher's type-to-filter: name prefix beats word prefix
 * beats substring, ties keep registry order.
 */
export function filterEditors(query: string, list: readonly EditorMeta[] = EDITORS): EditorMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  const score = (e: EditorMeta): number => {
    const n = e.name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.split(/[\s&]+/).some((w) => w.startsWith(q))) return 1;
    if (n.includes(q) || e.hint.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return list
    .map((e, i) => ({ e, i, s: score(e) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.e);
}
