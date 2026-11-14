import type { MotionDocument, ScriptOutput } from "../schema";
import { locateClip } from "../timeline/ops";
import { expandToDescendants } from "../timeline/groups";
import { deleteLayers } from "../timeline/delete-layers";
import { deleteFrame } from "../timeline/ops";

/**
 * WHAT A RUN MADE — and how a re-run takes it back.
 *
 * Ownership is measured, never declared: a run records which layers and comps
 * exist AFTER it that did not BEFORE. So it holds however the script got there
 * — `layer.create`, `template.apply`, `layers.duplicate`, a batch — and needs
 * no cooperation from any command. A script that edits existing layers owns
 * nothing; re-running it re-applies the edit, which is what a recipe should do.
 */

export interface DocIds {
  clips: ReadonlySet<string>;
  frames: ReadonlySet<string>;
}

export function docIds(doc: MotionDocument): DocIds {
  return {
    clips: new Set(doc.tracks.flatMap((t) => t.clips.map((c) => c.id))),
    frames: new Set(doc.frames.map((f) => f.id)),
  };
}

/**
 * The ROOTS of what appeared since `before`: a new comp, and every new layer
 * not already inside a new comp or a new group — deleting a root takes its
 * contents, so listing them too would only make the record lie after an edit.
 */
export function createdSince(before: DocIds, doc: MotionDocument): ScriptOutput {
  const frameIds = doc.frames.filter((f) => !before.frames.has(f.id)).map((f) => f.id);
  const newFrames = new Set(frameIds);
  const newClips = new Set<string>();
  for (const t of doc.tracks) for (const c of t.clips) if (!before.clips.has(c.id)) newClips.add(c.id);
  const clipIds: string[] = [];
  for (const t of doc.tracks) {
    if (t.groupId && newClips.has(t.groupId)) continue;
    for (const c of t.clips) if (newClips.has(c.id) && !newFrames.has(c.frameId)) clipIds.push(c.id);
  }
  return { clipIds, frameIds };
}

/** Merge a later run's output into an earlier one (append mode keeps both). */
export function mergeOutputs(a: ScriptOutput, b: ScriptOutput): ScriptOutput {
  return {
    clipIds: [...new Set([...a.clipIds, ...b.clipIds])],
    frameIds: [...new Set([...a.frameIds, ...b.frameIds])],
  };
}

/**
 * Remove what a previous run created (mutates a draft). What the person has
 * since deleted is skipped; the last comp in a project stays, as it does for
 * every other delete — and is returned as `kept`, still the script's. A
 * project made wholly by its script (a template build) always hits this: the
 * survivor used to drop out of the record, outlive every later run and, being
 * oldest, become the project's FIRST comp. The run hands `kept` to
 * `dropKeptOutput` once it has made a comp to stand in its place.
 */
export function clearScriptOutput(draft: MotionDocument, output: ScriptOutput): { layers: number; comps: number; kept: string[] } {
  const live = output.clipIds.filter((id) => locateClip(draft, id));
  let layers = 0;
  if (live.length) {
    const all = expandToDescendants(draft, live);
    layers = live.length;
    deleteLayers(draft, all, { pruneEmptiedTracks: true });
  }
  let comps = 0;
  const kept: string[] = [];
  for (const id of output.frameIds) {
    if (!draft.frames.some((f) => f.id === id)) continue;
    if (draft.frames.length > 1 && deleteFrame(draft, id)) comps++;
    else kept.push(id);
  }
  return { layers, comps, kept };
}

/**
 * The second half of a replace: the comps `clearScriptOutput` had to keep go
 * now, if the project has others. Returns the ones still standing (the run
 * made no comp — they stay the script's for the next run to take).
 */
export function dropKeptOutput(draft: MotionDocument, kept: readonly string[]): { comps: number; left: string[] } {
  let comps = 0;
  const left: string[] = [];
  for (const id of kept) {
    if (!draft.frames.some((f) => f.id === id)) continue;
    if (draft.frames.length > 1 && deleteFrame(draft, id)) comps++;
    else left.push(id);
  }
  return { comps, left };
}
