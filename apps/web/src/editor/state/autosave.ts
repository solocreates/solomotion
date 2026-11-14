"use client";

import type { MotionDocument, DocumentStore } from "@solomotion/core";
import { useAppShell } from "./app-shell";
import { saveDocument } from "./project-store";

/**
 * THE AUTOSAVE — the one owner of "the open project is on disk".
 *
 * It was a trailing debounce inside `Editor`: 1.5 s after the LAST change. A
 * person pauses, so it saved. An agent does not: a build that writes a layer
 * every few hundred milliseconds kept pushing the timer back, nothing reached
 * IndexedDB until it stopped, and a reload in the middle of it (a dev hot
 * reload, a crash) took every edit since the last pause. And the flush on
 * `pagehide` began its write a task too late (see `saveDocument`).
 *
 * Three promises now, each kept in one place:
 *
 *   QUIET      1.5 s after a person's last change, as before.
 *   BOUNDED    while changes keep coming, at least every 4 s — no edit is
 *              ever more than that from disk.
 *   DURABLE    `flushAutosave()` resolves once everything changed before the
 *              call is written. The agent door (`agent/call.ts`) awaits it
 *              before a call that changed the document answers, so an edit an
 *              agent was told is done survives a reload.
 *
 * Saves never overlap out of order: each one opens its IndexedDB transaction
 * when it starts, and IndexedDB commits overlapping writes to one store in the
 * order they were opened.
 */

const QUIET_MS = 1500;
const MAX_WAIT_MS = 4000;

interface Running {
  store: DocumentStore;
  timer: number | undefined;
  /** When the oldest unsaved change happened; null = nothing unsaved. */
  dirtySince: number | null;
  /** The last save started — what a flush with nothing new waits on. */
  last: Promise<void>;
}

let running: Running | null = null;

/**
 * "Has the open project changes not yet on disk?" — read by the logo menu's
 * dirty dot and the window title's `•`. A tiny subscribable flag, notified
 * only when it flips, so nothing re-renders per edit.
 */
let unsaved = false;
const unsavedListeners = new Set<() => void>();
function setUnsaved(next: boolean): void {
  if (unsaved === next) return;
  unsaved = next;
  for (const fn of unsavedListeners) fn();
}
export function hasUnsavedChanges(): boolean {
  return unsaved;
}
export function subscribeUnsaved(fn: () => void): () => void {
  unsavedListeners.add(fn);
  return () => unsavedListeners.delete(fn);
}

/**
 * The project whose document the store holds. `currentProjectId` moves only
 * when a document becomes resident (`makeResident`), so it names the store's
 * document on Home and while another project loads too: an edit made just
 * before either is still that project's to save.
 */
function openProjectId(): string | null {
  return useAppShell.getState().currentProjectId;
}

function saveNow(r: Running, id: string | null = openProjectId()): Promise<void> {
  window.clearTimeout(r.timer);
  r.timer = undefined;
  if (r.dirtySince === null) return r.last;
  if (!id) return r.last;
  r.dirtySince = null;
  const doc: MotionDocument = r.store.getState();
  // Never rejects: a failed save leaves the next change to try again, and a
  // caller waiting for durability must not fail the edit it already made.
  r.last = saveDocument(id, doc)
    .then(() => {
      if (r.dirtySince === null) setUnsaved(false);
    })
    .catch((err) => {
      console.warn("[autosave] could not save the project", err);
    });
  return r.last;
}

function schedule(r: Running): void {
  const now = Date.now();
  r.dirtySince ??= now;
  setUnsaved(true);
  const due = Math.min(now + QUIET_MS, r.dirtySince + MAX_WAIT_MS);
  window.clearTimeout(r.timer);
  r.timer = window.setTimeout(() => void saveNow(r), Math.max(0, due - now));
}

/** Start saving `store` as the open project. Returns the stop function. */
export function startAutosave(store: DocumentStore): () => void {
  const r: Running = { store, timer: undefined, dirtySince: null, last: Promise.resolve() };
  running = r;
  const unsub = store.subscribe(() => {
    if (openProjectId()) schedule(r);
  });
  const flush = () => void saveNow(r);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flush();
  };
  // `beforeunload` first: it fires while the page is still whole, and a reload
  // keeps it alive until the next page answers — time for the write to commit.
  // By `pagehide` the page is being torn down and a write begun there can be
  // dropped with it; it stays as the last chance (a closing tab, bfcache).
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", flush);
  window.addEventListener("pagehide", flush);
  return () => {
    window.clearTimeout(r.timer);
    unsub();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("beforeunload", flush);
    window.removeEventListener("pagehide", flush);
    if (running === r) {
      running = null;
      setUnsaved(false);
    }
  };
}

/**
 * Write everything changed so far, now. Resolves when it is on disk — or at
 * once when `store` is not the project being autosaved (a scratch store, a
 * test harness), which has nowhere to go. `projectId` names the owner when the
 * shell has already let go of it (the last tab closing).
 */
export function flushAutosave(store?: DocumentStore, projectId?: string | null): Promise<void> {
  const r = running;
  if (!r || (store && store !== r.store)) return Promise.resolve();
  return saveNow(r, projectId === undefined ? openProjectId() : projectId);
}
