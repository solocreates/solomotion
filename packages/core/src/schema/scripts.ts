import { z } from "zod";

/**
 * SCRIPTS (v94) — JavaScript files that live IN the project, the way Blender
 * keeps text blocks inside the .blend. A script drives the document through the
 * same command registry the agent and MCP use (`ac.layer.create(…)`), so
 * nothing a script can do is a second implementation of anything.
 *
 * In the document, not in app storage, because a script is project content: it
 * belongs with the comps it builds, travels in the bundle, is undoable, and an
 * agent that edits the project can read and write it like any other table.
 *
 * Only the SOURCE and one fact about the past are stored. Diagnostics, the
 * API a script sees and its completions are all derived from the live
 * registry, so a saved script never disagrees with the app that opens it.
 */

/**
 * What a re-run does with the previous run's output.
 *
 *  • `replace` — remove what this script's last run CREATED, then run. Edit,
 *    run, edit, run: the scene is rebuilt, never stacked. The default, because
 *    a script is a recipe for an outcome.
 *  • `append` — leave it; every run adds. For generators you fire repeatedly.
 *
 * A union rather than a boolean so a third policy (e.g. reuse-by-name) is one
 * arm, not a second flag that can contradict the first.
 */
export const scriptRunModeSchema = z.enum(["replace", "append"]);
export type ScriptRunMode = z.infer<typeof scriptRunModeSchema>;

/**
 * What the last run of a script created — layers and comps that did not exist
 * before it started. Not derivable: it is a record of an event. Layers created
 * inside a created comp are not listed; the comp takes them with it.
 */
export const scriptOutputSchema = z.object({
  clipIds: z.array(z.string()).default([]),
  frameIds: z.array(z.string()).default([]),
});
export type ScriptOutput = z.infer<typeof scriptOutputSchema>;

export const scriptSchema = z.object({
  id: z.string(),
  /** File name as shown in the explorer — `intro.js`. Unique per folder. */
  name: z.string(),
  folderId: z.string().nullable().default(null),
  source: z.string().default(""),
  onRun: scriptRunModeSchema.default("replace"),
  output: scriptOutputSchema.default({}),
});
export type Script = z.infer<typeof scriptSchema>;

export const scriptFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable().default(null),
});
export type ScriptFolder = z.infer<typeof scriptFolderSchema>;
