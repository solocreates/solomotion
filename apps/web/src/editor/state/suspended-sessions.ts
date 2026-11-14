import { capHistory, documentFingerprint, type DocumentStore, type MotionDocument, type SuspendedHistory } from "@solomotion/core";
import { NAMES } from "../names";
import { useSession, useStageView } from "./session";

/**
 * SUSPENDED SESSIONS — each open project keeps its own undo and its own view.
 *
 * There is ONE resident document (app-shell's memory rule: forty tabs cost
 * what one costs), so a project you switch away from is not kept alive. What
 * used to be lost with it was everything that is not the document: the undo
 * history, the selection, where you were in it. Now, on the way out, those
 * are written down as a SUSPENDED SESSION; on the way back in, after the
 * document has loaded, they are handed back.
 *
 * The record's shape is persisted, so it is the irreversible part: versioned,
 * capped (core `SUSPEND_CAPS`), and only ever restored over the very document
 * it was taken against (core `documentFingerprint`). If the project changed
 * while it was away, the history is dropped, never replayed.
 */
export const SESSION_RECORD_VERSION = 1;

/** A project's view: the session fields `resetForDocument` wipes, plus the timeline's zoom. */
const VIEW_KEYS = [
  "nav",
  "activePageId",
  "activeFrameId",
  "timelinePath",
  "openTimelineIds",
  "pinnedTimelineIds",
  "playheadMs",
  "workRange",
  "workRangeEnabled",
  "selectedClipIds",
  "selectedFrameIds",
  "selectedKeyframeIds",
  "enteredGroupId",
  "collapsedIds",
  "inspectorTab",
  "zoomBySurface",
] as const;
type SessionView = Pick<ReturnType<typeof useSession.getState>, (typeof VIEW_KEYS)[number]>;

export interface SuspendedSession {
  v: typeof SESSION_RECORD_VERSION;
  /** The document this was taken against (`documentFingerprint`). */
  fingerprint: string;
  at: number;
  history: SuspendedHistory;
  view: SessionView;
  camera: { scale: number; tx: number; ty: number };
}

/** Documents are immutable, so a fingerprint is remembered per document object. */
const fingerprints = new WeakMap<MotionDocument, string>();
function fingerprintOf(doc: MotionDocument): string {
  let fp = fingerprints.get(doc);
  if (fp === undefined) fingerprints.set(doc, (fp = documentFingerprint(doc)));
  return fp;
}

/** Write down the resident project's session (call BEFORE its document is replaced). */
export function suspend(store: DocumentStore): SuspendedSession {
  const s = useSession.getState();
  const view = Object.fromEntries(VIEW_KEYS.map((k) => [k, structuredClone(s[k])])) as SessionView;
  const { scale, tx, ty } = useStageView.getState();
  return {
    v: SESSION_RECORD_VERSION,
    fingerprint: fingerprintOf(store.getState()),
    at: Date.now(),
    history: capHistory(store.exportHistory()),
    view,
    camera: { scale, tx, ty },
  };
}

/**
 * Hand a session back (call AFTER the document is loaded and the session
 * reset). Returns false, and changes nothing, when the record does not
 * describe this document.
 */
export function resume(store: DocumentStore, rec: SuspendedSession): boolean {
  if (rec.v !== SESSION_RECORD_VERSION || rec.fingerprint !== fingerprintOf(store.getState())) return false;
  store.importHistory(rec.history);
  useSession.setState(rec.view);
  useStageView.setState(rec.camera);
  return true;
}

// ── Where records live: memory for this session, IndexedDB across reloads ──

const memory = new Map<string, SuspendedSession>();
const STORE = "sessions";
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((ok, fail) => {
    const req = indexedDB.open(NAMES.databases.sessions, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
  return dbp;
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((ok, fail) => {
        const r = fn(d.transaction(STORE, mode).objectStore(STORE));
        r.onsuccess = () => ok(r.result);
        r.onerror = () => fail(r.error);
      }),
  );
}

export function keepSession(projectId: string, rec: SuspendedSession): void {
  memory.set(projectId, rec);
  if (typeof indexedDB !== "undefined") void tx("readwrite", (s) => s.put(rec, projectId)).catch(() => {});
}

export function forgetSession(projectId: string): void {
  memory.delete(projectId);
  if (typeof indexedDB !== "undefined") void tx("readwrite", (s) => s.delete(projectId)).catch(() => {});
}

/**
 * Bring a project's session back once its document is resident. From memory
 * at once; from disk a moment later, applied only if nothing has happened in
 * between (no new history, the same document).
 */
export function restoreSession(store: DocumentStore, projectId: string, stillResident: () => boolean): void {
  const hit = memory.get(projectId);
  if (hit) {
    resume(store, hit);
    return;
  }
  if (typeof indexedDB === "undefined") return;
  void tx<SuspendedSession | undefined>("readonly", (s) => s.get(projectId))
    .then((rec) => {
      if (rec && stillResident() && !store.canUndo() && !store.canRedo()) resume(store, rec);
    })
    .catch(() => {});
}
