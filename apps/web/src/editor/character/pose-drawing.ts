"use client";

import { duplicatePoseDrawing, expandToDescendants, locateClip, poseDrawingOf, type DocumentStore } from "@solomotion/core";
import { toast } from "@/lib/toast";
import { useSession } from "../state/session";
import { clipEditMode, openClipEditor } from "../state/focus-model";
import { setPosePreview } from "./pose-preview";

/**
 * EDITING A POSE'S DRAWING — the designer's door into a part (ADR-characters-3,
 * "Drawings"). A swap pose shows one layer (a hand drawn as a fist); editing
 * it edits that pose wherever it is used, like a component's master. While you
 * work the set is PINNED to that pose on the canvas (the bake's preview flag,
 * never the document), so what you edit is what you see; leaving the drawing
 * — selecting anything outside it — lets go.
 *
 * The drawing opens the way that layer opens (`clipEditMode` →
 * `openClipEditor`, the double-click brain): a path in node edit, a text
 * typing; a drawing made of several shapes is entered, its shapes yours to pick.
 */
let release: (() => void) | null = null;

export function editPoseDrawing(store: DocumentStore, groupId: string, setId: string, poseId: string): boolean {
  const doc = store.getState();
  const drawing = poseDrawingOf(doc, groupId, setId, poseId);
  const member = drawing && locateClip(doc, drawing.memberId)?.clip;
  if (!drawing || !member) return false;
  release?.();
  setPosePreview({ groupId, setId, poseId });
  const s = useSession.getState();
  const isGroup = member.kind === "group";
  s.setEnteredGroup(isGroup ? member.id : drawing.switchId);
  const inside = new Set(expandToDescendants(doc, [member.id]));
  const first = isGroup ? doc.tracks.find((t) => t.groupId === member.id)?.clips[0] : null;
  s.select([first?.id ?? member.id]);
  const mode = isGroup ? null : clipEditMode(doc, member);
  if (mode) openClipEditor(store, member, mode);
  toast(`Editing ${member.name} — select outside it when you are done`);
  // Let go when the work leaves the drawing.
  const off = useSession.subscribe((next) => {
    const here = next.selectedClipIds.some((id) => inside.has(id)) || (next.editingClipId !== null && inside.has(next.editingClipId)) || (next.enteredGroupId !== null && inside.has(next.enteredGroupId));
    if (!here) release?.();
  });
  release = () => {
    off();
    setPosePreview(null);
    release = null;
  };
  return true;
}

/** A new drawing from a pose — then straight into editing it (the original stays as it was). */
export function newDrawingFromPose(store: DocumentStore, groupId: string, setId: string, poseId: string): void {
  let made: ReturnType<typeof duplicatePoseDrawing> = null;
  store.update("New drawing from pose", (d) => void (made = duplicatePoseDrawing(d, groupId, setId, poseId)));
  const m = made as ReturnType<typeof duplicatePoseDrawing>;
  if (m) editPoseDrawing(store, groupId, setId, m.poseId);
}
