/**
 * BRIEF FOCUSES — "I'm doing sound" as a choice of sections, never as text.
 *
 * A focus names the craft files, catalogs and API namespaces a kind of work
 * needs; the content stays where it lives (the skill, the registry). A new
 * reference or catalog is one id added here, and a test fails if an id stops
 * resolving, so a focus can never quietly lose the file it was built around.
 */

export interface BriefFocus {
  id: string;
  name: string;
  /** Section ids on top of `BRIEF_BASE`; `"*"` is every section there is. */
  sections: readonly string[];
}

/** The focus that takes every section — heavy, for chats with a long context. */
export const ALL_SECTIONS = "*";

/** In every focus: how the app works, where you are, and the verbs every script uses. */
export const BRIEF_BASE: readonly string[] = [
  "skill:SKILL.md",
  "project",
  "file",
  "run",
  "catalog:properties",
  "api:doc",
  "api:layer",
  "api:layers",
  "api:view",
  "api:catalog",
  "api:api",
];

const ref = (name: string) => `skill:references/${name}.md`;

export const BRIEF_FOCUSES: readonly BriefFocus[] = [
  {
    id: "everyday",
    name: "Everyday",
    sections: [ref("motion"), ref("type-and-captions"), ref("layers-and-layout"), ref("recipes"), ref("review"), "catalog:animations", "catalog:text-templates", "catalog:easings", "api:animation", "api:keyframes", "api:text", "api:frame", "api:template"],
  },
  {
    id: "motion",
    name: "Motion",
    sections: [ref("motion"), ref("effects"), ref("layers-and-layout"), ref("recipes"), ref("review"), "catalog:animations", "catalog:easings", "catalog:layer-effects", "catalog:transitions", "catalog:blend-modes", "api:animation", "api:keyframes", "api:effects", "api:expression", "api:layout", "api:frame", "api:transition"],
  },
  {
    id: "type",
    name: "Type",
    sections: [ref("type-and-captions"), ref("motion"), ref("recipes"), "catalog:text-templates", "catalog:text-effects", "catalog:animations", "catalog:easings", "api:text", "api:animation", "api:keyframes", "api:template", "api:effects"],
  },
  {
    id: "sound",
    name: "Sound",
    sections: [ref("sound"), ref("media-and-generation"), "catalog:audio-effects", "api:sounds", "api:sound", "api:audio", "api:generate", "api:voices", "api:media", "api:effects"],
  },
  {
    id: "3d",
    name: "3D",
    sections: [ref("3d"), ref("motion"), "catalog:primitives", "catalog:modifiers", "catalog:materials", "catalog:lights", "catalog:easings", "api:world", "api:mesh", "api:effects", "api:keyframes"],
  },
  {
    id: "drawing",
    name: "Drawing & frame by frame",
    sections: [ref("fills-strokes-vectors"), ref("layers-and-layout"), ref("motion"), "catalog:blend-modes", "catalog:easings", "api:flipbook", "api:keyframes", "api:effects", "api:frame"],
  },
  {
    id: "characters",
    name: "Characters & physics",
    sections: [ref("rigging"), ref("physics"), ref("motion"), "catalog:forces", "catalog:easings", "api:rig", "api:switch", "api:physics", "api:keyframes"],
  },
  {
    id: "editing",
    name: "Editing",
    sections: [ref("editing"), ref("media-and-generation"), ref("sound"), "catalog:transitions", "catalog:audio-effects", "api:timeline", "api:media", "api:transition", "api:audio"],
  },
  {
    id: "color",
    name: "Color & grade",
    sections: [ref("color-and-grading"), ref("effects"), "catalog:layer-effects", "catalog:blend-modes", "api:grade", "api:effects"],
  },
  { id: "all", name: "Everything", sections: [ALL_SECTIONS] },
];

/**
 * A focus's full selection: the base, its own sections, and anything always-on
 * the caller adds. `available` is what `"*"` expands to.
 */
export function focusSelection(focusId: string, alwaysOn: readonly string[] = [], available: readonly string[] = []): Set<string> {
  const focus = BRIEF_FOCUSES.find((f) => f.id === focusId) ?? BRIEF_FOCUSES[0]!;
  const own = focus.sections.flatMap((id) => (id === ALL_SECTIONS ? available : [id]));
  return new Set([...BRIEF_BASE, ...own, ...alwaysOn]);
}
