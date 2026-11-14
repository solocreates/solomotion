/**
 * The filer clipboard — cut/copy of node ids with paste semantics. Cut then
 * paste = move; copy then paste = duplicate. A cut set renders dimmed until it's
 * pasted or cleared. Held in the manager state; this module owns only the shape
 * and how a paste resolves against a target folder.
 */

export interface FilerClipboard {
  mode: "cut" | "copy";
  ids: string[];
}

export type PasteOp =
  | { type: "move"; ids: string[]; targetParentId: string | null; clear: true }
  | { type: "duplicate"; ids: string[] };

/** Resolve what a paste into `targetParentId` should do for a clipboard. */
export function resolvePaste(clip: FilerClipboard, targetParentId: string | null): PasteOp {
  if (clip.mode === "cut") return { type: "move", ids: clip.ids, targetParentId, clear: true };
  return { type: "duplicate", ids: clip.ids };
}
