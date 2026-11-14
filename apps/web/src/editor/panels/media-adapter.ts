"use client";

import { createId, type Asset, type DocumentStore } from "@solomotion/core";
import { toast } from "@/lib/toast";
import type { FilerAdapter } from "../filer/model/adapter";
import type { FilerFolder, FilerItem, FilerTree } from "../filer/model/tree";
import { placeAssetClips } from "../assets/import";
import { getAssetBlob, putAssetBlob } from "../assets/asset-store";
import { releaseAssetBytes } from "../assets/release-bytes";
import { placeAboveSelection } from "../state/clip-actions";
import { useSession } from "../state/session";

/**
 * The media-library surface of the headless filer, over `doc.mediaFolders` +
 * `doc.assets` (folderId = parent). Every mutation runs through the document
 * store so it's undoable and saved/bundled with the project — folders travel
 * with the file like everything else. Media has no soft-delete: `trash` hard-
 * removes assets and their blobs (folders cascade). `open` places the asset on
 * the active frame at the playhead. Assets carry no timestamps, so tree ordinals
 * mirror their document order (newest import last).
 */
export function createMediaAdapter(store: DocumentStore): FilerAdapter<Asset> {
  const folderNode = (f: { id: string; name: string; parentId: string | null }, i: number): FilerFolder => ({
    kind: "folder",
    id: f.id,
    name: f.name,
    parentId: f.parentId ?? null,
    createdAt: i,
    updatedAt: i,
  });
  const assetNode = (a: Asset, i: number): FilerItem<Asset> => ({
    kind: "item",
    id: a.id,
    name: a.name,
    parentId: a.folderId ?? null,
    createdAt: i,
    updatedAt: i,
    data: a,
  });

  /** Folder ids + asset ids inside `rootIds` (folders cascade to descendants). */
  const collect = (rootIds: string[]) => {
    const d = store.getState();
    const folderIds = new Set<string>();
    const assetIds = new Set<string>();
    const walk = (parentId: string) => {
      for (const f of d.mediaFolders) if (f.parentId === parentId) { folderIds.add(f.id); walk(f.id); }
      for (const a of d.assets) if (a.folderId === parentId) assetIds.add(a.id);
    };
    for (const id of rootIds) {
      if (d.mediaFolders.some((f) => f.id === id)) {
        folderIds.add(id);
        walk(id);
      } else if (d.assets.some((a) => a.id === id)) {
        assetIds.add(id);
      }
    }
    return { folderIds, assetIds };
  };

  return {
    async load(): Promise<FilerTree<Asset>> {
      const d = store.getState();
      return {
        folders: d.mediaFolders.map(folderNode),
        items: d.assets.map(assetNode),
      };
    },

    async createFolder(parentId, name) {
      const id = createId("mfolder");
      store.update("New media folder", (d) => {
        d.mediaFolders.push({ id, name: name.trim() || "New folder", parentId, linked: null });
      });
      return id;
    },

    async rename(id, name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      store.update("Rename", (d) => {
        const f = d.mediaFolders.find((x) => x.id === id);
        if (f) {
          f.name = trimmed;
          return;
        }
        const a = d.assets.find((x) => x.id === id);
        if (a) a.name = trimmed;
      });
    },

    async move(ids, targetParentId) {
      const set = new Set(ids);
      store.update("Move media", (d) => {
        for (const f of d.mediaFolders) if (set.has(f.id)) f.parentId = targetParentId;
        for (const a of d.assets) if (set.has(a.id)) a.folderId = targetParentId;
      });
    },

    async trash(ids) {
      const { folderIds, assetIds } = collect(ids);
      if (folderIds.size + assetIds.size === 0) return;
      store.update("Delete media", (d) => {
        d.mediaFolders = d.mediaFolders.filter((f) => !folderIds.has(f.id));
        d.assets = d.assets.filter((a) => !assetIds.has(a.id));
      });
      // The bytes go only when nothing can use them — a clip, an undo, another project.
      releaseAssetBytes(store, assetIds);
      toast(`Deleted ${assetIds.size || folderIds.size} item${assetIds.size + folderIds.size === 1 ? "" : "s"}`);
    },

    async duplicate(ids) {
      const d = store.getState();
      for (const id of ids) {
        const src = d.assets.find((a) => a.id === id);
        if (!src) continue;
        const blob = await getAssetBlob(src.id);
        const newId = createId("asset");
        if (blob) await putAssetBlob(newId, blob);
        store.update("Duplicate media", (dd) => {
          dd.assets.push({ ...src, id: newId, name: `${src.name} copy` });
        });
      }
    },

    open(item) {
      const d = store.getState();
      const session = useSession.getState();
      const frameId =
        session.activeFrameId && d.frames.some((f) => f.id === session.activeFrameId)
          ? session.activeFrameId
          : d.frames[0]?.id;
      const frame = d.frames.find((f) => f.id === frameId);
      if (!frame) {
        toast("Add a frame first");
        return;
      }
      // Split-aware placement (video keeps its sound as a linked audio lane).
      void placeAssetClips(
        store,
        item.data,
        { frameId: frame.id, startMs: session.playheadMs },
        { width: frame.width, height: frame.height },
        (dd, primary) => placeAboveSelection(dd, primary),
      );
    },
  };
}
