/**
 * Where a keyboard ⌘V should land media — the last pointer position over the
 * stage, in frame-relative coordinates. A drop carries its own cursor point in
 * the event; a keyboard paste has none, so the Stage keeps this anchor fresh on
 * pointer move and clears it when the cursor leaves, giving paste the same
 * "lands under the cursor" feel. Deliberately dependency-free (no store, no
 * React) so both the Stage and the paste action can share it without a cycle.
 */
export interface StagePasteAnchor {
  /** Frame the cursor is over. */
  frameId: string;
  /** Offset from the frame CENTRE, matching the drop-import convention. */
  x: number;
  y: number;
}

let anchor: StagePasteAnchor | null = null;

/** Stage writes the live cursor anchor (or null when the cursor leaves it). */
export function setStagePasteAnchor(next: StagePasteAnchor | null): void {
  anchor = next;
}

/** The current stage paste anchor, or null when the cursor isn't over a frame. */
export function getStagePasteAnchor(): StagePasteAnchor | null {
  return anchor;
}
