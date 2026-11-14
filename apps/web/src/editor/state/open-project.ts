"use client";

import type { MotionDocument, DocumentStore } from "@solomotion/core";
import { toast } from "@/lib/toast";
import { openProjectFile } from "../io/motion-file";
import { canUseOpenPicker, pickOpenFile, putSaveTarget, type SaveTarget } from "../io/file-handle-store";
import { createProject, createProjectId } from "./project-store";
import { makeResident } from "./project-index";

/**
 * Opening a project FILE (`.motion` or legacy `.json`) — the counterpart to the
 * save flow. Reads and rehydrates the bundle (media/fonts back into their
 * stores), registers it as a fresh recent project so Home lists it and autosave
 * binds to it, then makes it the open project (`makeResident`, which saves the
 * outgoing one first). Says nothing: Home's "Import project", File → Open and
 * an agent's `project.open` each tell the person in their own words.
 */
export async function openFileAsProject(
  store: DocumentStore,
  file: File,
  handle?: SaveTarget["handle"],
): Promise<{ id: string; doc: MotionDocument; missingAssetIds: string[] }> {
  const { doc, manifest, missingAssetIds } = await openProjectFile(file);

  const id = createProjectId();
  await createProject(id, doc);
  // Bind the opened file as the save target so ⌘S overwrites it in place — but
  // only for a real .motion (writing a bundle over a .json would be wrong).
  if (handle && file.name.toLowerCase().endsWith(".motion")) {
    await putSaveTarget({ projectId: id, handle, includeMedia: manifest?.mediaIncluded ?? true, fileName: file.name });
  }
  makeResident(store, id, doc);
  return { id, doc, missingAssetIds };
}

/** A person opening a file: File → Open, Home's "Import project". */
export async function importProjectFromFile(
  store: DocumentStore,
  file: File,
  handle?: SaveTarget["handle"],
): Promise<void> {
  const { doc, missingAssetIds } = await openFileAsProject(store, file, handle);
  toast.success(`Opened “${doc.name}”`);
  if (missingAssetIds.length > 0) {
    toast.warning(
      `${missingAssetIds.length} media file${missingAssetIds.length > 1 ? "s were" : " was"} not embedded — relink from the Media panel.`,
    );
  }
}

/** Prompt for a project file and open it. Rejects only on a real read error. */
export async function pickAndImportProject(store: DocumentStore): Promise<void> {
  // Prefer the File System Access picker: it hands back a writable handle, so a
  // later ⌘S overwrites the very file that was opened (no repeat downloads).
  if (canUseOpenPicker()) {
    const picked = await pickOpenFile();
    if (!picked) return; // cancelled
    try {
      await importProjectFromFile(store, picked.file, picked.handle);
    } catch (err) {
      toast.error("Couldn't open project", { description: (err as Error).message });
      throw err;
    }
    return;
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".motion,.json,application/zip,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve();
      try {
        await importProjectFromFile(store, file);
        resolve();
      } catch (err) {
        toast.error("Couldn't open project", { description: (err as Error).message });
        reject(err);
      }
    };
    input.click();
  });
}
