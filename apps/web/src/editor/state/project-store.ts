"use client";

import { mirrorDelete, mirrorPut, mirrorPutDoc, mirroredIds, readMirroredDoc, readMirroredRecord } from "./project-mirror";
import { customAlphabet } from "nanoid";
import {
  createId,
  parseDocument,
  serializeDocument,
  type Frame,
  type MotionDocument,
} from "@solomotion/core";
import { drawFrameContent } from "../stage/render/draw-frame";
import { forgetProjects, hydrateProjectIndex, publishProject, type ProjectMeta, type ProjectOrigin } from "./project-index";
import { ENGINE, NAMES } from "@/editor/names";

const PROJECT_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const projectId = customAlphabet(PROJECT_ID_ALPHABET, 20);

/**
 * A project's id doubles as its `/project/[id]` URL — like a Figma file key:
 * a long opaque unique id with NO name in it. A name-derived slug (tried
 * first) reads badly precisely because every new project starts "Untitled"
 * (`/project/untitled-sbklay` for every single one) and names drift after
 * renames anyway — the id carries none of that, just uniqueness.
 */
export function createProjectId(): string {
  return projectId();
}

/**
 * Recent projects — local, app-level storage of whole documents in IndexedDB
 * (docs + thumbnails are too big for localStorage). This is the home screen's
 * backing store and the editor's autosave target; the clean seam for cloud
 * projects later.
 *
 * v3 keeps a project in TWO rows: its metadata (name, dates, tree place, a
 * small thumbnail) in `projects`, and its serialized document in `docs`. They
 * were one row, and IndexedDB has no projection — every read of the home grid,
 * the Open popover, a rename, a move or an autosave pulled EVERY project's whole
 * document into memory to look at its name. Home with a few big projects sat on
 * hundreds of megabytes of JSON before you had opened anything. Now nothing but
 * an open, a hover preview or a duplicate ever reads a document.
 *
 * v2 adds a **file-manager layer**: projects and folders form a tree (`parentId`,
 * null = root) with soft-delete trash (`deletedAt`) grouped by `trashRootId` so a
 * cascaded folder delete restores/purges as one unit. Folders are metadata-only
 * rows in their own store. The home `filer/` engine reads this through a thin
 * adapter — the same engine the media library will reuse.
 */

/** Fields every node in the project tree shares (projects + folders). */
export interface TreeNodeFields {
  /** Parent folder id, or null for the root level. */
  parentId: string | null;
  /** Soft-delete timestamp; null/undefined = live. Trashed nodes are hidden. */
  deletedAt?: number | null;
  /**
   * Which delete operation this node belongs to — the id of the top node the
   * user trashed. Descendants of a trashed folder share its root so restore /
   * purge act on the whole group at once. `id === trashRootId` marks a root.
   */
  trashRootId?: string | null;
}

export interface ProjectRecord extends TreeNodeFields {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Image data URL of the first frame — the home card's still. */
  thumbnail: string | null;
  width: number;
  height: number;
  /** The community item it was cloned from, if any (see `project-index`). */
  origin?: ProjectOrigin | null;
}

/** What the project index keeps of a record — never its still or its document. */
function metaOf(p: ProjectRecord): ProjectMeta {
  return { id: p.id, name: p.name, updatedAt: p.updatedAt, origin: p.origin ?? null };
}

/** A project's document, stored apart from its metadata (see the module note). */
interface DocRow {
  id: string;
  /** serializeDocument(doc). */
  docJson: string;
}

export interface FolderRecord extends TreeNodeFields {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

/** A trashed group as shown in Recently Deleted — the root plus how much it holds. */
export interface TrashEntry {
  node: (ProjectRecord & { type: "project" }) | (FolderRecord & { type: "folder" });
  /** Total nodes (root + descendants) that restore/purge together. */
  count: number;
}

const DB_NAME = NAMES.databases.projects;
const DB_VERSION = 3;
const STORE = "projects";
const FOLDERS = "folders";
const DOCS = "docs";

let persistAsked = false;
/**
 * Projects live only here, and a browser keeps "best-effort" storage only until
 * it needs the room — it may clear it without asking. Ask once for persistent
 * storage (granted silently to an installed or engaged site), so a project is
 * never evicted behind the user's back.
 */
function askToPersist(): void {
  if (persistAsked) return;
  persistAsked = true;
  void navigator.storage?.persisted?.().then((already) => (already ? undefined : navigator.storage?.persist?.())).catch(() => {});
}

/**
 * ONE connection, opened once and kept. Every helper used to open its own, and
 * that made the one write that has to start NOW impossible: a save reached
 * from `pagehide` awaited a fresh open, the page was gone before it resolved,
 * and the edits it was carrying went with it. With the handle in hand a save
 * opens its transaction in the same task (`saveDocument`), and IndexedDB keeps
 * an opened transaction alive through the unload.
 */
let dbHandle: IDBDatabase | null = null;
let dbOpening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbHandle) return Promise.resolve(dbHandle);
  dbOpening ??= openDbConnection().then(
    (db) => {
      dbHandle = db;
      // Another tab upgrading the schema: step aside, reopen on the next call.
      db.onversionchange = () => {
        db.close();
        dbHandle = null;
        dbOpening = null;
      };
      db.onclose = () => {
        dbHandle = null;
        dbOpening = null;
      };
      return db;
    },
    (err) => {
      dbOpening = null;
      throw err;
    },
  );
  return dbOpening;
}

function openDbConnection(): Promise<IDBDatabase> {
  askToPersist();
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Additive migration: existing project rows read as root (parentId
      // undefined ⇒ null) and live (deletedAt undefined). No data is touched.
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(FOLDERS)) {
        db.createObjectStore(FOLDERS, { keyPath: "id" });
      }
      // v3: documents move out of the metadata rows, one record at a time — a
      // cursor, never a getAll, so the upgrade itself cannot hold them all.
      if (!db.objectStoreNames.contains(DOCS)) {
        const docs = db.createObjectStore(DOCS, { keyPath: "id" });
        const projects = req.transaction!.objectStore(STORE);
        projects.openCursor().onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          const { docJson, ...meta } = cursor.value as ProjectRecord & { docJson?: string };
          if (typeof docJson === "string") {
            docs.put({ id: meta.id, docJson } satisfies DocRow);
            cursor.update(meta);
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

// ── Low-level store helpers ────────────────────────────────────────────────

function getAll<T>(store: string): Promise<T[]> {
  if (typeof indexedDB === "undefined") return Promise.resolve([]);
  return openDb().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const req = db.transaction(store, "readonly").objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error);
      }),
  );
}

function getAllKeys(store: string): Promise<string[]> {
  if (typeof indexedDB === "undefined") return Promise.resolve([]);
  return openDb().then(
    (db) =>
      new Promise<string[]>((resolve, reject) => {
        const req = db.transaction(store, "readonly").objectStore(store).getAllKeys();
        req.onsuccess = () => resolve(req.result as string[]);
        req.onerror = () => reject(req.error);
      }),
  );
}

function getOne<T>(store: string, id: string): Promise<T | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve, reject) => {
        const req = db.transaction(store, "readonly").objectStore(store).get(id);
        req.onsuccess = () => resolve((req.result as T) ?? null);
        req.onerror = () => reject(req.error);
      }),
  );
}

function putOne(store: string, record: unknown): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

/**
 * Apply a mutation to a set of nodes across both stores in one transaction.
 * `mutate` receives each found record (tagged with its store) and returns the
 * updated record to write back, or null to leave it untouched.
 */
async function updateNodes(
  ids: Iterable<string>,
  mutate: (node: (ProjectRecord | FolderRecord) & { id: string }) => ProjectRecord | FolderRecord | null,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const idSet = new Set(ids);
  if (idSet.size === 0) return;
  const db = await openDb();
  const published: ProjectRecord[] = [];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, FOLDERS], "readwrite");
    const projects = tx.objectStore(STORE);
    const folders = tx.objectStore(FOLDERS);
    for (const id of idSet) {
      const pReq = projects.get(id);
      pReq.onsuccess = () => {
        const rec = pReq.result as ProjectRecord | undefined;
        if (rec) {
          const next = mutate(rec);
          if (next) {
            projects.put(next);
            knownRecords.set(next.id, next as ProjectRecord);
            mirrorPut("project", next as ProjectRecord);
            published.push(next as ProjectRecord);
          }
          return;
        }
        const fReq = folders.get(id);
        fReq.onsuccess = () => {
          const frec = fReq.result as FolderRecord | undefined;
          if (!frec) return;
          const next = mutate(frec);
          if (next) {
            folders.put(next);
            mirrorPut("folder", next as FolderRecord);
          }
        };
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  // After the commit, never inside it: the index says only what is durable.
  for (const p of published) publishProject({ ...metaOf(p), deletedAt: p.deletedAt });
}

/**
 * Fill the project index from the database — once per session, metadata only.
 * Every later change arrives through the writes below, so nothing re-reads.
 */
let indexed: Promise<void> | null = null;
export function loadProjectIndex(): Promise<void> {
  indexed ??= listProjects()
    .then((all) => hydrateProjectIndex(all.map(metaOf)))
    .catch(() => hydrateProjectIndex([]));
  return indexed;
}

// ── Projects ───────────────────────────────────────────────────────────────

/** All live (non-trashed) projects, newest first. */
export async function listProjects(): Promise<ProjectRecord[]> {
  await recovered();
  const all = await getAll<ProjectRecord>(STORE).catch(() => []);
  return all.filter((p) => !p.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  await recovered();
  const record = await getOne<ProjectRecord>(STORE, id).catch(() => null);
  if (record) knownRecords.set(id, record);
  return record;
}

/**
 * The project rows this tab last read or wrote — what `saveDocument` keeps a
 * row's folder, trash state and origin from without a read it could not wait
 * for. Refreshed by every read and write through this module.
 */
const knownRecords = new Map<string, ProjectRecord>();

/** A project's document, parsed; null when the project has none. Throws on a document that will not parse. */
export async function getProjectDocument(id: string): Promise<MotionDocument | null> {
  await recovered();
  const row = await getOne<DocRow>(DOCS, id).catch(() => null);
  return row ? parseDocument(row.docJson, ENGINE.ns) : null;
}

/**
 * Write a project: its metadata row, and — when the document changed — its
 * document row, in ONE transaction so a crash never leaves a name without its
 * document or a document under the wrong name.
 */
async function writeProject(meta: ProjectRecord, docJson?: string): Promise<void> {
  knownRecords.set(meta.id, meta);
  if (typeof indexedDB !== "undefined") {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(docJson === undefined ? [STORE] : [STORE, DOCS], "readwrite");
      tx.objectStore(STORE).put(meta);
      if (docJson !== undefined) tx.objectStore(DOCS).put({ id: meta.id, docJson } satisfies DocRow);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  mirrorPut("project", meta);
  if (docJson !== undefined) mirrorPutDoc(meta.id, docJson);
  publishProject({ ...metaOf(meta), deletedAt: meta.deletedAt });
}

/** A brand-new project from a document — at the root, its first save. */
export async function createProject(id: string, doc: MotionDocument, origin: ProjectOrigin | null = null): Promise<void> {
  const { meta, docJson } = projectFromDocument(id, doc, Date.now());
  await writeProject({ ...meta, origin }, docJson);
}

// ── The mirror: put back what the database lost ──────────────────────────
//
// Once per session, before the first read: every record the OPFS mirror holds
// that IndexedDB does not is written back (a crash made Chromium discard the
// database), and every record the database holds that the mirror lacks is
// mirrored (projects saved before the mirror existed). See project-mirror.ts.

let recovery: Promise<number> | null = null;
/** True once the mirror has put back what the database lost — a save may then skip waiting for it. */
let recoveryDone = false;
function recovered(): Promise<number> {
  recovery ??= recoverFromMirror()
    .catch(() => 0)
    .finally(() => {
      recoveryDone = true;
    });
  return recovery;
}

async function recoverFromMirror(): Promise<number> {
  if (typeof indexedDB === "undefined") return 0;
  // Keys and metadata only. The documents are read one at a time, and only the
  // ones one side is missing — never every project at once on every launch.
  const [mirror, projects, folders, docIds] = await Promise.all([
    mirroredIds(),
    getAll<ProjectRecord>(STORE).catch(() => []),
    getAll<FolderRecord>(FOLDERS).catch(() => []),
    getAllKeys(DOCS).catch(() => [] as string[]),
  ]);
  const haveP = new Set(projects.map((p) => p.id)), haveF = new Set(folders.map((f) => f.id)), haveD = new Set(docIds);
  let back = 0;
  for (const id of mirror.folders) {
    if (haveF.has(id)) continue;
    const f = await readMirroredRecord<FolderRecord>("folder", id);
    if (f?.id) await putOne(FOLDERS, f);
  }
  for (const id of mirror.projects) {
    if (haveP.has(id) && haveD.has(id)) continue;
    // A mirror written before v3 holds the document INSIDE the record.
    const rec = await readMirroredRecord<ProjectRecord & { docJson?: string }>("project", id);
    if (!rec?.id) continue;
    const { docJson: inline, ...meta } = rec;
    const docJson = haveD.has(id) ? undefined : (inline ?? (await readMirroredDoc(id)) ?? undefined);
    if (haveP.has(id) && docJson === undefined) continue;
    await writeProject(haveP.has(id) ? projects.find((p) => p.id === id)! : meta, docJson);
    if (!haveP.has(id) && !meta.deletedAt) back++;
  }
  // The other way: put a second copy of anything the mirror lacks. A project
  // mirrored before v3 has no document file of its own yet; it gets one here,
  // once, read from the database one project at a time.
  for (const f of folders) if (!mirror.folders.has(f.id)) mirrorPut("folder", f);
  for (const p of projects) {
    if (!mirror.projects.has(p.id)) mirrorPut("project", p);
    if (mirror.docs.has(p.id) || !haveD.has(p.id)) continue;
    const row = await getOne<DocRow>(DOCS, p.id).catch(() => null);
    if (row) {
      mirrorPut("project", p);
      mirrorPutDoc(p.id, row.docJson);
    }
  }
  if (back > 0) {
    void import("./app-shell").then(({ useAppShell }) =>
      useAppShell.getState().setHomeNotice(`Recovered ${back} project${back === 1 ? "" : "s"} this browser had lost.`),
    );
  }
  return back;
}

/** Hard-delete a single project record (legacy path). Prefer trashNodes. */
export async function deleteProject(id: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    knownRecords.delete(id);
    const tx = db.transaction([STORE, DOCS], "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.objectStore(DOCS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  mirrorDelete("project", id);
  forgetProjects([id]);
}

// ── Folders ──────────────────────────────────────────────────────────────

/** All live (non-trashed) folders. */
export async function listFolders(): Promise<FolderRecord[]> {
  await recovered();
  const all = await getAll<FolderRecord>(FOLDERS).catch(() => []);
  return all.filter((f) => !f.deletedAt);
}

export async function putFolder(record: FolderRecord): Promise<void> {
  await putOne(FOLDERS, record);
  mirrorPut("folder", record);
}

export async function createFolder(parentId: string | null, name: string): Promise<FolderRecord> {
  const now = Date.now();
  const folder: FolderRecord = {
    id: createId("folder"),
    name: name.trim() || "New folder",
    parentId,
    createdAt: now,
    updatedAt: now,
  };
  await putFolder(folder);
  return folder;
}

// ── Tree, move, rename, duplicate ────────────────────────────────────────

/** The full live tree — everything the home grid, breadcrumb and search need. */
export async function getActiveTree(): Promise<{ folders: FolderRecord[]; projects: ProjectRecord[] }> {
  const [folders, projects] = await Promise.all([listFolders(), listProjects()]);
  return { folders, projects };
}

/** Rename any node (project or folder) by id. */
export async function renameNode(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await updateNodes([id], (n) => ({ ...n, name: trimmed, updatedAt: Date.now() }));
}

/** Reparent nodes (projects and/or folders) into `targetParentId` (null = root). */
export async function moveNodes(ids: string[], targetParentId: string | null): Promise<void> {
  const now = Date.now();
  await updateNodes(ids, (n) => ({ ...n, parentId: targetParentId, updatedAt: now }));
}

/** Duplicate a project (same doc + thumbnail) beside the original as “… copy”. */
export async function duplicateProject(id: string): Promise<ProjectRecord | null> {
  const src = await getProject(id);
  if (!src) return null;
  const body = await getOne<DocRow>(DOCS, id).catch(() => null);
  const now = Date.now();
  const copy: ProjectRecord = {
    ...src,
    id: createProjectId(),
    name: `${src.name} copy`,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    trashRootId: null,
    // A duplicate is the person's own project, not a copy of the community item.
    origin: null,
  };
  await writeProject(copy, body?.docJson);
  return copy;
}

/**
 * Which of `ids` does any saved project still mention — live or in the trash?
 * Media bytes are shared by id across this device (a duplicated project uses
 * the same assets), so they are only freed when no project can use them.
 * Read on the rare occasion something is freed; one pass over the documents.
 */
export async function idsInSavedProjects(ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (ids.length === 0) return found;
  const rows = await getAll<DocRow>(DOCS).catch(() => [] as DocRow[]);
  for (const row of rows) for (const id of ids) if (!found.has(id) && row.docJson.includes(id)) found.add(id);
  return found;
}

// ── Trash (soft-delete) ──────────────────────────────────────────────────

/** All descendant ids of a folder (folders + projects), excluding the folder. */
function descendantIds(rootId: string, folders: FolderRecord[], projects: ProjectRecord[]): string[] {
  const out: string[] = [];
  const walk = (parentId: string) => {
    for (const f of folders) {
      if (f.parentId === parentId) {
        out.push(f.id);
        walk(f.id);
      }
    }
    for (const p of projects) if (p.parentId === parentId) out.push(p.id);
  };
  walk(rootId);
  return out;
}

/**
 * Soft-delete nodes. Each selected node becomes a trash *root*; its descendants
 * (for folders) are trashed under the same `trashRootId` so they come back
 * together. A node already inside another selected folder folds into that group.
 */
export async function trashNodes(ids: string[]): Promise<void> {
  const { folders, projects } = await getActiveTree();
  const selected = new Set(ids);
  const parentOf = new Map<string, string | null>();
  for (const f of folders) parentOf.set(f.id, f.parentId);
  for (const p of projects) parentOf.set(p.id, p.parentId);
  const hasSelectedAncestor = (id: string): boolean => {
    let cur = parentOf.get(id) ?? null;
    while (cur) {
      if (selected.has(cur)) return true;
      cur = parentOf.get(cur) ?? null;
    }
    return false;
  };

  const now = Date.now();
  const assign = new Map<string, string>(); // nodeId -> trashRootId
  for (const id of ids) {
    if (hasSelectedAncestor(id)) continue; // covered by an ancestor's group
    assign.set(id, id);
    for (const d of descendantIds(id, folders, projects)) assign.set(d, id);
  }
  await updateNodes(assign.keys(), (n) => ({
    ...n,
    deletedAt: now,
    trashRootId: assign.get(n.id) ?? n.id,
  }));
}

/** Recently Deleted — one entry per trashed group (the root), with its size. */
export async function listTrash(): Promise<TrashEntry[]> {
  const [folders, projects] = await Promise.all([
    getAll<FolderRecord>(FOLDERS).catch(() => []),
    getAll<ProjectRecord>(STORE).catch(() => []),
  ]);
  const trashed = [...folders, ...projects].filter((n) => n.deletedAt);
  const size = new Map<string, number>();
  for (const n of trashed) {
    const root = n.trashRootId ?? n.id;
    size.set(root, (size.get(root) ?? 0) + 1);
  }
  const entries: TrashEntry[] = [];
  for (const f of folders) {
    if (f.deletedAt && (f.trashRootId ?? f.id) === f.id)
      entries.push({ node: { ...f, type: "folder" }, count: size.get(f.id) ?? 1 });
  }
  for (const p of projects) {
    if (p.deletedAt && (p.trashRootId ?? p.id) === p.id)
      entries.push({ node: { ...p, type: "project" }, count: size.get(p.id) ?? 1 });
  }
  return entries.sort((a, b) => (b.node.deletedAt ?? 0) - (a.node.deletedAt ?? 0));
}

/** Ids belonging to the given trash groups (roots + their trashed members). */
async function trashGroupIds(rootIds: string[]): Promise<string[]> {
  const roots = new Set(rootIds);
  const [folders, projects] = await Promise.all([
    getAll<FolderRecord>(FOLDERS).catch(() => []),
    getAll<ProjectRecord>(STORE).catch(() => []),
  ]);
  const ids: string[] = [];
  for (const n of [...folders, ...projects]) {
    if (n.deletedAt && roots.has(n.trashRootId ?? n.id)) ids.push(n.id);
  }
  return ids;
}

/**
 * Restore trashed groups. Clears the delete marks; if a restored node's parent
 * folder is still trashed (partial state), it re-surfaces at the root so nothing
 * is left orphaned in a folder the user can't reach.
 */
export async function restoreTrash(rootIds: string[]): Promise<void> {
  const ids = await trashGroupIds(rootIds);
  const restored = new Set(ids);
  const foldersById = new Map(
    (await getAll<FolderRecord>(FOLDERS).catch(() => [])).map((f) => [f.id, f] as const),
  );
  await updateNodes(ids, (n) => {
    let parentId = n.parentId;
    if (parentId && !restored.has(parentId)) {
      const parent = foldersById.get(parentId);
      if (parent?.deletedAt) parentId = null; // parent still in trash → to root
    }
    return { ...n, parentId, deletedAt: null, trashRootId: null };
  });
}

/** Permanently delete trashed groups (records only — projects carry no blobs). */
export async function purgeTrash(rootIds: string[]): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const ids = new Set(await trashGroupIds(rootIds));
  if (ids.size === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, FOLDERS, DOCS], "readwrite");
    const projects = tx.objectStore(STORE);
    const folders = tx.objectStore(FOLDERS);
    const docs = tx.objectStore(DOCS);
    for (const id of ids) {
      knownRecords.delete(id);
      projects.delete(id);
      folders.delete(id);
      docs.delete(id);
      mirrorDelete("project", id);
      mirrorDelete("folder", id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  forgetProjects([...ids]);
}

// ── Document ⇄ record ────────────────────────────────────────────────────

/**
 * Render a frame to a downscaled still (long edge ≤ maxEdge). WebP keeps alpha
 * at a fraction of PNG's size — every card's still is held by the home grid —
 * and a browser that cannot encode it hands back PNG, per the canvas spec.
 */
export function captureThumbnail(doc: MotionDocument, frame: Frame, timeMs: number, maxEdge = 480): string | null {
  if (typeof document === "undefined") return null;
  const scale = Math.min(1, maxEdge / Math.max(frame.width, frame.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(frame.width * scale));
  canvas.height = Math.max(1, Math.round(frame.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  try {
    drawFrameContent(ctx, doc, frame, timeMs);
    return canvas.toDataURL("image/webp", 0.86);
  } catch {
    return null;
  }
}

/** A saveable project from a live document: its metadata (with a representative still) and its JSON. */
function projectFromDocument(id: string, doc: MotionDocument, createdAt: number, thumbnail: "fresh" | "keep" = "fresh"): { meta: ProjectRecord; docJson: string } {
  // The project's face is its first frame — when it has one. An empty canvas is
  // a real project with no picture yet; its card shows that, never an error.
  const frame = doc.frames[0] ?? null;
  // A moment after the intro so animations have settled into something legible.
  const still = Math.min(doc.durationMs * 0.5, 2000);
  return {
    meta: {
      id,
      name: doc.name,
      createdAt,
      updatedAt: Date.now(),
      parentId: null,
      thumbnail: frame && thumbnail === "fresh" ? captureThumbnail(doc, frame, still) : null,
      width: frame?.width ?? 1920,
      height: frame?.height ?? 1080,
    },
    docJson: serializeDocument(doc),
  };
}

/**
 * Save a document to its project record, preserving the original createdAt and
 * its place in the tree (parentId / trash state) so autosave never yanks a
 * project out of its folder.
 */
/**
 * SAVE THE OPEN PROJECT — its document and its card, in one transaction that
 * reads the row it updates (folder, trash, origin, creation time) and writes
 * it back.
 *
 * It used to read the row first and write in a second step. Each step awaited,
 * so the write began a task or two later, and from `pagehide` that is after
 * the page has gone: the last edits before a reload never landed. Now, once the
 * database is open, the transaction is created before this function returns —
 * the serialisation is the only work in between, and it is synchronous.
 */
export function saveDocument(id: string, doc: MotionDocument): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  // Serialise NOW: `doc` is the state the caller means, whatever happens next.
  const card = cachedThumbnail(id);
  const { meta, docJson } = projectFromDocument(id, doc, Date.now(), card);
  const write = (db: IDBDatabase) =>
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, DOCS], "readwrite");
      const rows = tx.objectStore(STORE);
      let record: ProjectRecord | null = null;
      const place = (existing: ProjectRecord | null) => {
        record = {
          ...meta,
          createdAt: existing?.createdAt ?? meta.createdAt,
          thumbnail: card === "keep" ? (existing?.thumbnail ?? meta.thumbnail) : meta.thumbnail,
          parentId: existing?.parentId ?? null,
          deletedAt: existing?.deletedAt ?? null,
          trashRootId: existing?.trashRootId ?? null,
          origin: existing?.origin ?? null,
        };
        rows.put(record);
      };
      // Every write is ISSUED here, in this task: during an unload no callback
      // runs again, so a write issued from a read's callback never happens (the
      // first version of this did exactly that, and lost the edit it carried).
      // The row's tree fields come from the copy this tab last read or wrote.
      tx.objectStore(DOCS).put({ id, docJson } satisfies DocRow);
      const known = knownRecords.get(id);
      if (known) {
        place(known);
        // Everything is issued: ask for the commit now rather than when the
        // task ends, so a save begun as the page closes is already on its way.
        (tx as IDBTransaction & { commit?: () => void }).commit?.();
      } else {
        const req = rows.get(id);
        req.onsuccess = () => place((req.result as ProjectRecord | undefined) ?? null);
      }
      tx.oncomplete = () => {
        if (record) {
          knownRecords.set(id, record);
          mirrorPut("project", record);
          mirrorPutDoc(id, docJson);
          publishProject({ ...metaOf(record), deletedAt: record.deletedAt });
        }
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("The save was aborted."));
    });
  // The fast path is the whole point: database open, mirror recovery settled.
  if (dbHandle && recoveryDone) return write(dbHandle);
  return recovered().then(() => openDb()).then(write);
}

/**
 * A project's card picture, re-rendered at most every few seconds.
 *
 * A save is now frequent — every agent call that changed something waits for
 * one (`autosave.ts`) — and the card is a full frame render. Between renders a
 * save keeps the card it has (`null` = keep the stored one), so the cost of
 * being durable is the serialisation, not a thumbnail per call.
 */
const THUMBNAIL_EVERY_MS = 8_000;
const thumbnails = new Map<string, number>();
function cachedThumbnail(id: string): "fresh" | "keep" {
  const now = Date.now();
  if (now - (thumbnails.get(id) ?? 0) < THUMBNAIL_EVERY_MS) return "keep";
  thumbnails.set(id, now);
  return "fresh";
}
