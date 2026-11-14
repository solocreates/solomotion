"use client";

import { landingFrameId, type MotionDocument, type DocumentStore } from "@solomotion/core";
import { create } from "zustand";
import { useAppShell } from "./app-shell";
import { flushAutosave } from "./autosave";
import { useSession } from "./session";

/**
 * THE PROJECT INDEX — what every surface knows about a project without
 * holding its document: its name and where it came from.
 *
 * A project's name used to be stored three times: in its document
 * (`doc.name`), in its IndexedDB record, and in a copy on each open tab. Three
 * writers, three readers, and a sync for only one pair of them — so a tab
 * opened from a link said "Untitled" until you went into it, and a rename on
 * Home was reverted by the next autosave of the still-loaded document.
 *
 * Now there is one rule, and it is a derivation rather than a sync:
 *
 *   the RESIDENT project (the one the document store holds)  →  `doc.name`, live
 *   every other project                                       →  its record
 *
 * The record is written by `project-store` and published here on every write;
 * the resident's name follows the store on every keystroke. A tab, the Open
 * popover, Home and the inspector all read `useProjectName(id)`, so they
 * cannot disagree — there is nothing to keep in step.
 *
 * The one race this has to close is a document switch: `store.replace` lands
 * the incoming document while every id in the app still names the outgoing
 * project. So the resident's id and name move TOGETHER, in `makeResident`,
 * BEFORE the store changes — a name can never be read under the wrong id.
 */

/** Where a project came from, when it was made from a community item. */
export interface ProjectOrigin {
  /** The library item's stable id (`online:template:<pack>/<entry>`). */
  itemId: string;
  /** The content hash of the bundle it was cloned from — the template's version. */
  version: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  origin: ProjectOrigin | null;
}

interface ProjectIndexState {
  /** Live (non-trashed) projects by id. */
  records: Record<string, ProjectMeta>;
  /** True once the first read of the database has landed. */
  ready: boolean;
  /** The project the document store holds, and its live name. Moved only together. */
  residentId: string | null;
  residentName: string;
}

export const useProjectIndex = create<ProjectIndexState>(() => ({
  records: {},
  ready: false,
  residentId: null,
  residentName: "",
}));

/** The shape every UI shows. An empty name is a project nobody has named yet. */
export function displayName(name: string | null | undefined): string {
  return name?.trim() || "Untitled";
}

/** A project's name, live. Null while unknown (before the index has loaded, or a project this browser lacks). */
export function projectNameOf(s: ProjectIndexState, id: string): string | null {
  if (s.residentId === id) return s.residentName;
  return s.records[id]?.name ?? null;
}

export function useProjectName(id: string): string | null {
  return useProjectIndex((s) => projectNameOf(s, id));
}

// ── Writers ────────────────────────────────────────────────────────────────

/** A record was written. Called by `project-store` only. */
export function publishProject(meta: ProjectMeta & { deletedAt?: number | null }): void {
  const { deletedAt, ...rest } = meta;
  if (deletedAt) return forgetProjects([meta.id]);
  useProjectIndex.setState((s) => ({ records: { ...s.records, [meta.id]: rest } }));
}

/** Records left (trashed or purged). Their tabs go with them. */
export function forgetProjects(ids: string[]): void {
  const gone = ids.filter((id) => id in useProjectIndex.getState().records);
  if (!gone.length) return;
  useProjectIndex.setState((s) => {
    const records = { ...s.records };
    for (const id of gone) delete records[id];
    return { records };
  });
  const shell = useAppShell.getState();
  for (const id of gone) if (shell.tabs.includes(id)) useAppShell.getState().closeTab(id);
}

/** The first read: every live record's metadata. */
export function hydrateProjectIndex(metas: ProjectMeta[]): void {
  const records: Record<string, ProjectMeta> = {};
  for (const m of metas) records[m.id] = m;
  useProjectIndex.setState({ records, ready: true });
}

// ── The resident ───────────────────────────────────────────────────────────

let residentStore: DocumentStore | null = null;
let unfollow: (() => void) | null = null;

/** Bind the app's one document store, once, so its name is followed live. */
export function bindDocumentStore(store: DocumentStore): () => void {
  residentStore = store;
  unfollow?.();
  unfollow = store.subscribe(() => {
    const name = store.getState().name;
    if (name !== useProjectIndex.getState().residentName) useProjectIndex.setState({ residentName: name });
  });
  return () => {
    unfollow?.();
    unfollow = null;
    residentStore = null;
  };
}

/**
 * THE one way a document becomes the open project. Every open — a tab, a link,
 * New, an import, a community clone — lands here, so the id, the name, the
 * session and the shell move in one order that cannot race.
 */
export function makeResident(store: DocumentStore, id: string, doc: MotionDocument): void {
  // The outgoing project's last edits first. The save opens its transaction
  // now, while the store still holds that document and the shell still names
  // it, so nothing below can file them under the new project or drop them.
  void flushAutosave(store);
  useProjectIndex.setState({ residentId: id, residentName: doc.name });
  store.replace(doc);
  useSession.getState().resetForDocument(landingFrameId(doc));
  useAppShell.getState().enterEditor(id);
}

/** Nothing is open any more (every tab closed). */
export function clearResident(): void {
  useProjectIndex.setState({ residentId: null, residentName: "" });
}

/**
 * Rename a project, wherever it lives. The resident is renamed in its document
 * — one undo step, and autosave carries it to the record — and the record is
 * written too, so Home and the tabs are right at once rather than after a
 * debounce. A project that is not open is a record write alone; its document's
 * stale name is corrected when it next opens (`reconcileOpenedName`).
 */
export async function renameProject(id: string, name: string): Promise<void> {
  const next = name.trim();
  if (!next) return;
  const { residentId } = useProjectIndex.getState();
  if (residentId === id && residentStore && residentStore.getState().name !== next) {
    residentStore.update("Rename project", (d) => void (d.name = next), { mergeKey: "rename-project" });
  }
  const { renameNode } = await import("./project-store");
  await renameNode(id, next);
}

/** On open, the record's name wins: it is the only one a rename-while-closed could reach. */
export function reconcileOpenedName(doc: MotionDocument, recordName: string): void {
  if (recordName.trim() && doc.name !== recordName) doc.name = recordName;
}

/** Local copies of a community item at exactly this version, newest first. */
export function copiesOf(itemId: string, version: string): ProjectMeta[] {
  return Object.values(useProjectIndex.getState().records)
    .filter((m) => m.origin?.itemId === itemId && m.origin.version === version)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
