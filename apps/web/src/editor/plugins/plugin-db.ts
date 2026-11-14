"use client";

import type { InstalledPlugin } from "./plugin-model";
import { NAMES } from "@/editor/names";

/**
 * Installed plugins live in IndexedDB — they carry their whole bundle (bytes),
 * which is too big for localStorage. Same hand-rolled promise-IDB idiom as the
 * project store. Keyed by the manifest id (the uniqueness key), so re-installing
 * the same plugin id overwrites the row.
 */

const DB_NAME = NAMES.databases.plugins;
const DB_VERSION = 1;
const STORE = "plugins";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "manifest.id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

export function dbGetAllPlugins(): Promise<InstalledPlugin[]> {
  if (typeof indexedDB === "undefined") return Promise.resolve([]);
  return openDb().then(
    (db) =>
      new Promise<InstalledPlugin[]>((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result as InstalledPlugin[]);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function dbPutPlugin(record: InstalledPlugin): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export function dbDeletePlugin(id: string): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}
