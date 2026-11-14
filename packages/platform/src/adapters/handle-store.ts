/**
 * A tiny IndexedDB keyed store for File System Access directory handles. Handles
 * are structured-cloneable, so persisting one lets a linked folder survive a
 * reload — the browser still gates access behind a permission re-request, which
 * the caller does on a user gesture. Web-only; the native shell uses paths.
 */

const STORE = "handles";

export interface HandleStore {
  put(id: string, handle: FileSystemDirectoryHandle): Promise<void>;
  get(id: string): Promise<FileSystemDirectoryHandle | null>;
  delete(id: string): Promise<void>;
}

/** The store, in its own database (`<ns>-fs-handles`, named by the host). */
export function createHandleStore(dbName: string): HandleStore {
  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDb().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const request = run(db.transaction(STORE, mode).objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }),
    );
  }

  return {
    put: (id, handle) => tx("readwrite", (s) => s.put(handle, id)).then(() => undefined),
    get: (id) =>
      tx<FileSystemDirectoryHandle | undefined>("readonly", (s) => s.get(id))
        .then((h) => h ?? null)
        .catch(() => null),
    delete: (id) =>
      tx("readwrite", (s) => s.delete(id))
        .then(() => undefined)
        .catch(() => undefined),
  };
}
