import { setBakePosePreview } from "@solomotion/core";
import { markStageDirty } from "../stage/render/stage-dirty";

/**
 * THE FACE PAD'S HOVER PREVIEW on the stage — the bake's view flag (core
 * `setBakePosePreview`) plus the repaint it needs. Never reaches the document
 * or an export; cleared the moment the pointer leaves the tile.
 */
export function setPosePreview(next: { groupId: string; setId: string; poseId: string } | null): void {
  setBakePosePreview(next);
  markStageDirty();
}
