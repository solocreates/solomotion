"use client";

import type { FilerAdapter, FilerTrashEntry } from "../filer/model/adapter";
import type { FilerFolder, FilerItem, FilerTree } from "../filer/model/tree";
import { useAppShell } from "../state/app-shell";
import { renameProject } from "../state/project-index";
import {
  createFolder,
  duplicateProject,
  getActiveTree,
  listTrash,
  moveNodes,
  purgeTrash,
  restoreTrash,
  trashNodes,
  type FolderRecord,
  type ProjectRecord,
} from "../state/project-store";

/**
 * The projects surface of the headless filer — maps the IndexedDB project/folder
 * tree onto `FilerAdapter`. Item payload is the project's METADATA: the card
 * shows its stored still, and only a hover preview or an open reads the
 * document (see `project-store`).
 */

function folderToNode(f: FolderRecord): FilerFolder {
  return { kind: "folder", id: f.id, name: f.name, parentId: f.parentId ?? null, createdAt: f.createdAt, updatedAt: f.updatedAt };
}

function projectToNode(p: ProjectRecord): FilerItem<ProjectRecord> {
  return { kind: "item", id: p.id, name: p.name, parentId: p.parentId ?? null, createdAt: p.createdAt, updatedAt: p.updatedAt, data: p };
}

export function createProjectsAdapter(): FilerAdapter<ProjectRecord> {
  return {
    async load(): Promise<FilerTree<ProjectRecord>> {
      const { folders, projects } = await getActiveTree();
      return { folders: folders.map(folderToNode), items: projects.map(projectToNode) };
    },

    createFolder: (parentId, name) => createFolder(parentId, name).then((f) => f.id),
    // Through the index's one rename, so an OPEN project's document is renamed
    // too — a record-only write was reverted by its next autosave.
    rename: (id, name) => renameProject(id, name),
    move: (ids, targetParentId) => moveNodes(ids, targetParentId),
    duplicate: async (ids) => {
      for (const id of ids) await duplicateProject(id);
    },

    trash: (ids) => trashNodes(ids),
    async loadTrash(): Promise<FilerTrashEntry<ProjectRecord>[]> {
      const entries = await listTrash();
      return entries.map((e) => ({
        node: e.node.type === "folder" ? folderToNode(e.node) : projectToNode(e.node),
        count: e.count,
      }));
    },
    restore: (rootIds) => restoreTrash(rootIds),
    purge: (rootIds) => purgeTrash(rootIds),

    // THE app's one loader (`use-url-sync`): supervised, with a deadline, and
    // it flushes the outgoing project first. Home used to open synchronously
    // from the record it was holding — a second loader, and the reason Home
    // had to hold every document.
    open: (item) => useAppShell.getState().openProject(item.id),
  };
}
