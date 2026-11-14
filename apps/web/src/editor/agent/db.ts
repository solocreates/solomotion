"use client";
import { NAMES } from "@/editor/names";

/**
 * Everything the agent remembers lives in ONE IndexedDB on this device:
 * connections (with their keys), knowledge packs, settings, chats, the files
 * people attached, and feedback. Same hand-rolled promise-IDB idiom as the
 * project and plugin stores — no dependency, and nothing leaves the machine
 * unless the user turns on feedback sharing.
 *
 * Chats are their own records (not one blob) so a long history loads the list
 * without loading every message, and attachments are separate so a chat that
 * mentions a 200MB video does not carry it on every save.
 */

const DB_NAME = NAMES.databases.agent;
const DB_VERSION = 1;

export type StoreName = "kv" | "chats" | "attachments" | "feedback";

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ["kv", "chats", "attachments", "feedback"] as const) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("IndexedDB unavailable"));
    };
  }));
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export function dbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  return tx<T>(store, "readonly", (s) => s.get(key) as IDBRequest<T>).catch(() => undefined);
}

export function dbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  return tx(store, "readwrite", (s) => void s.put(value, key)).then(() => undefined);
}

export function dbDelete(store: StoreName, key: string): Promise<void> {
  return tx(store, "readwrite", (s) => void s.delete(key)).then(() => undefined);
}

export function dbAll<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>).then((r) => r ?? [], () => []);
}
