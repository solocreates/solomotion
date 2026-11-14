"use client";
import { NAMES } from "@/editor/names";

/**
 * The app's ONE font database — `<ns>-fonts` in IndexedDB. App level, not
 * project level: an uploaded face, a lifted system face and a cached specimen
 * all follow the person across every project on this device.
 *
 *   faces       real faces the renderer draws with (uploads, OS lifts, bundle
 *               imports), keyed by `faceKey`
 *   specimens   tiny `text=`-subset previews the browsers draw rows with,
 *               keyed by family + text + weight set
 *   fonts       v1's family-keyed uploads — a migration SOURCE, read once,
 *               never written (see `restoreCustomFonts`)
 *
 * One opener, so a version bump happens in one place: two modules each opening
 * the same database at different versions is a `VersionError` on whichever
 * loses the race.
 */

const DB_NAME = NAMES.databases.fonts;
const DB_VERSION = 3;

export const LEGACY_STORE = "fonts";
export const FACE_STORE = "faces";
export const SPECIMEN_STORE = "specimens";

let opening: Promise<IDBDatabase> | null = null;

export function openFontDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LEGACY_STORE)) db.createObjectStore(LEGACY_STORE, { keyPath: "family" });
      if (!db.objectStoreNames.contains(FACE_STORE)) db.createObjectStore(FACE_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(SPECIMEN_STORE)) {
        db.createObjectStore(SPECIMEN_STORE, { keyPath: "key" }).createIndex("at", "at");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading must not be blocked by this one holding it open.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      opening = null;
      reject(req.error ?? new Error("IndexedDB unavailable"));
    };
  });
  return opening;
}

export function idbGet<T>(store: string, key: string): Promise<T | null> {
  return openFontDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        const req = db.transaction(store, "readonly").objectStore(store).get(key);
        req.onsuccess = () => resolve((req.result as T) ?? null);
        req.onerror = () => resolve(null);
      }),
    () => null,
  );
}

export function idbGetAll<T>(store: string): Promise<T[]> {
  return openFontDb().then(
    (db) =>
      new Promise<T[]>((resolve) => {
        if (!db.objectStoreNames.contains(store)) return resolve([]);
        const req = db.transaction(store, "readonly").objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => resolve([]);
      }),
    () => [],
  );
}

export function idbPut(store: string, record: unknown): Promise<void> {
  return openFontDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve(); // the value still works this session
      }),
    () => undefined,
  );
}

export function idbDelete(store: string, keys: readonly string[]): Promise<void> {
  return openFontDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        const tx = db.transaction(store, "readwrite");
        const os = tx.objectStore(store);
        for (const k of keys) os.delete(k);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      }),
    () => undefined,
  );
}

/**
 * Keep a store to at most `max` records, dropping the least recently used by
 * its `at` index. Cheap enough to run after a batch of writes; a cache that
 * only grows is a cache that eventually costs more than the network it saves.
 */
export function idbPrune(store: string, max: number): Promise<void> {
  return openFontDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        const tx = db.transaction(store, "readwrite");
        const os = tx.objectStore(store);
        const count = os.count();
        count.onsuccess = () => {
          let excess = count.result - max;
          if (excess <= 0) return;
          const cursor = os.index("at").openCursor();
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (!c || excess <= 0) return;
            c.delete();
            excess--;
            c.continue();
          };
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      }),
    () => undefined,
  );
}
