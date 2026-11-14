"use client";

import { create } from "zustand";
import { toast } from "@/lib/toast";
import type { DocumentStore } from "@solomotion/core";
import { useAppShell } from "./app-shell";
import { saveDocument } from "./project-store";
import { flushSurfaces } from "../drawing/raster-store";
import { writeMotionBundle } from "../io/motion-file";
import {
  canUseFilePicker,
  downloadBlob,
  ensureHandlePermission,
  getSaveTarget,
  pickSaveFile,
  putSaveTarget,
  safeName,
  writeBlobToHandle,
} from "../io/file-handle-store";

/**
 * The save flow. First save (and "Save As…") opens the dialog to pick media +
 * location; afterwards ⌘S re-saves silently to the remembered target. The
 * bundle is rebuilt fresh each time, so it always mirrors the live document
 * (media added/removed since last save syncs automatically).
 */

export type SaveDialogMode = "save" | "save-as";

interface SaveUiState {
  dialogOpen: boolean;
  dialogMode: SaveDialogMode;
  /** True while a bundle is being written (disables re-entry, shows progress). */
  saving: boolean;
  openSaveDialog: (mode: SaveDialogMode) => void;
  closeSaveDialog: () => void;
  setSaving: (saving: boolean) => void;
}

export const useSaveUi = create<SaveUiState>((set) => ({
  dialogOpen: false,
  dialogMode: "save",
  saving: false,
  openSaveDialog: (mode) => set({ dialogOpen: true, dialogMode: mode }),
  closeSaveDialog: () => set({ dialogOpen: false }),
  setSaving: (saving) => set({ saving }),
}));

/**
 * Write the bundle to disk: overwrite the remembered handle when we have one,
 * otherwise prompt for a location (File System Access) or download a fresh file.
 * Returns false only when the user cancels the location prompt.
 */
export async function performSave(
  store: DocumentStore,
  projectId: string,
  includeMedia: boolean,
  opts: { handle?: import("../io/file-handle-store").SaveTarget["handle"]; forceNewLocation?: boolean } = {},
): Promise<boolean> {
  useSaveUi.getState().setSaving(true);
  try {
    const doc = store.getState();
    const fileName = `${safeName(doc.name)}.motion`;
    const blob = await writeMotionBundle(doc, { includeMedia });

    let handle = opts.forceNewLocation ? null : (opts.handle ?? null);
    if (handle && !(await ensureHandlePermission(handle))) handle = null;
    if (!handle && canUseFilePicker()) {
      handle = await pickSaveFile(fileName);
      if (!handle) return false; // user dismissed the picker
    }

    if (handle) await writeBlobToHandle(handle, blob);
    else downloadBlob(blob, fileName);

    await putSaveTarget({ projectId, handle, includeMedia, fileName });
    // Keep the Home/autosave record in step with the export.
    await saveDocument(projectId, doc);
    toast.success(handle ? "Project saved" : "Project downloaded");
    return true;
  } catch (err) {
    toast.error("Save failed", { description: (err as Error).message });
    return false;
  } finally {
    useSaveUi.getState().setSaving(false);
  }
}

/**
 * ⌘S / menu entry point. Silent re-save when a target is remembered; otherwise
 * (or on Save As…) it opens the dialog to choose media + location first.
 */
export async function saveProject(store: DocumentStore, opts: { forceDialog?: boolean; mode?: SaveDialogMode } = {}): Promise<void> {
  const projectId = useAppShell.getState().currentProjectId;
  if (!projectId) return;
  // Paint surfaces flush their pixels first — a save never races the
  // debounced PNG persist.
  await flushSurfaces();

  const target = await getSaveTarget(projectId);
  if (opts.forceDialog || !target) {
    useSaveUi.getState().openSaveDialog(opts.mode ?? "save");
    return;
  }
  await performSave(store, projectId, target.includeMedia, { handle: target.handle });
}
