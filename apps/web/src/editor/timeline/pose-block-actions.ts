"use client";

import {
  changeBlockPose,
  characterLanes,
  deleteBlock,
  pickPose,
  locateClip,
  poseEnvAt,
  splitBlock,
  type MotionDocument,
  type DocumentStore,
  type PoseBlock,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { useSession, type PoseBlockRef } from "../state/session";

/**
 * What the edit verbs do to the blocks picked on a character's pose lanes —
 * called from the shortcut table ahead of clips, so Split and Delete reach
 * whatever key they are bound to (never a key of their own here). Each is one
 * undo step through core's block verbs (`rig/block-edit`).
 */

/** The block a ref names, over the character's whole span (the verbs need its true edges). */
export function resolvePoseBlock(doc: MotionDocument, ref: PoseBlockRef): { blocks: PoseBlock[]; index: number } | null {
  const g = locateClip(doc, ref.groupId)?.clip;
  if (g?.kind !== "group") return null;
  const lane = characterLanes(doc, ref.groupId, undefined, (t) => poseEnvAt(doc, t, g.frameId), ref.setId)[0];
  if (!lane) return null;
  const index = lane.blocks.findIndex((b) => b.fromMs <= ref.atMs && ref.atMs < b.toMs && b.behaviorId === ref.behaviorId);
  return index >= 0 ? { blocks: lane.blocks, index } : null;
}

/** A ref to a block — its middle, so it survives an edge moving. */
export const refOf = (groupId: string, setId: string, b: { fromMs: number; toMs: number; behaviorId?: string }): PoseBlockRef => ({
  groupId,
  setId,
  atMs: (b.fromMs + b.toMs) / 2,
  ...(b.behaviorId ? { behaviorId: b.behaviorId } : {}),
});

/** Split: each picked block under the playhead is cut there. Returns false when none is (the clip split runs instead). */
export function splitPickedBlocks(store: DocumentStore): boolean {
  const s = useSession.getState();
  if (!s.selectedPoseBlocks.length) return false;
  const at = s.playheadMs;
  const doc = store.getState();
  const hits = s.selectedPoseBlocks.map((r) => ({ r, hit: resolvePoseBlock(doc, r) })).filter((x) => x.hit && x.hit.blocks[x.hit.index]!.fromMs < at && at < x.hit.blocks[x.hit.index]!.toMs);
  if (!hits.length) {
    toast("Move the playhead into the block to split it");
    return true;
  }
  let made = 0;
  store.update("Split block", (d) => {
    for (const { r, hit } of hits) if (splitBlock(d, r.groupId, r.setId, hit!.blocks[hit!.index]!, at)) made++;
  });
  if (!made) toast("Too close to its edge to split");
  // The part after the playhead is picked: the one you are about to change.
  else s.setSelectedPoseBlocks(hits.map(({ r, hit }) => ({ ...r, atMs: (at + hit!.blocks[hit!.index]!.toMs) / 2 })));
  return true;
}

/** Delete: keys go, a behavior stands aside there. Returns false when nothing is picked. */
export function deletePickedBlocks(store: DocumentStore): boolean {
  const s = useSession.getState();
  if (!s.selectedPoseBlocks.length) return false;
  const doc = store.getState();
  const hits = s.selectedPoseBlocks.map((r) => ({ r, hit: resolvePoseBlock(doc, r) })).filter((x) => !!x.hit);
  store.update(hits.length > 1 ? `Delete ${hits.length} blocks` : "Delete block", (d) => {
    for (const { r, hit } of hits) deleteBlock(d, r.groupId, r.setId, hit!.blocks[hit!.index]!);
  });
  s.setSelectedPoseBlocks([]);
  return true;
}

/** A digit with blocks picked: each shows its set's Nth pose (1-based). False when nothing is picked. */
export function posePickedBlocks(store: DocumentStore, n: number): boolean {
  const s = useSession.getState();
  if (!s.selectedPoseBlocks.length) return false;
  const doc = store.getState();
  const hits = s.selectedPoseBlocks.map((r) => ({ r, hit: resolvePoseBlock(doc, r) })).filter((x) => !!x.hit);
  const nameOf = (r: PoseBlockRef) => {
    const g = locateClip(doc, r.groupId)?.clip;
    return g?.kind === "group" ? g.poses?.find((x) => x.id === r.setId)?.poses[n - 1] : undefined;
  };
  const named = hits.filter(({ r }) => nameOf(r));
  if (!named.length) return true;
  store.update(`Pose ${nameOf(named[0]!.r)!.name}`, (d) => {
    for (const { r, hit } of named) changeBlockPose(d, r.groupId, r.setId, hit!.blocks[hit!.index]!, nameOf(r)!.id);
  });
  return true;
}

/**
 * A pose picked NOW (the Face pad, the character menu) — core `pickPose`:
 * the picked blocks of that set, else the block under the playhead
 * (recording: from the playhead on). One undo step. False where no block can
 * take it (a driver chooses there) — the caller explains that.
 */
export function pickPoseNow(store: DocumentStore, groupId: string, setId: string, poseId: string, label: string): boolean {
  const s = useSession.getState();
  const doc = store.getState();
  const g = locateClip(doc, groupId)?.clip;
  if (g?.kind !== "group") return false;
  const lane = characterLanes(doc, groupId, undefined, (t) => poseEnvAt(doc, t, g.frameId), setId)[0];
  if (!lane) return false;
  const picked = s.selectedPoseBlocks.filter((r) => r.groupId === groupId && r.setId === setId).map((r) => r.atMs);
  const at = s.playheadMs;
  const under = lane.blocks.find((b) => b.fromMs <= at && at < b.toMs);
  if (!picked.length && (!under || (under.source === "live" && !under.behaviorId))) return false;
  let changed = 0;
  store.update(label, (d) => void (changed = pickPose(d, groupId, setId, poseId, lane.blocks, { atMs: at, record: s.recording, picked }).length));
  return changed > 0;
}

