"use client";

import * as React from "react";
import {
  createDocumentStore,
  createEmptyDocument,
  type DocumentStore,
  type MotionDocument,
} from "@solomotion/core";
import { syncSurfacesToDocument } from "../drawing/raster-store";
import { keepListedAssetBytes } from "../assets/asset-store";
import { watchSettlingPaint } from "../drawing/wet-actions";
import { NAMES } from "@/editor/names";

/**
 * Binds the core DocumentStore (patch-based, undoable) to React.
 * There is exactly one document store per editor; everything reads through it.
 */

const DocumentStoreContext = React.createContext<DocumentStore | null>(null);

/**
 * The one live document store, reachable WITHOUT React. There is exactly one
 * per editor (see above), so this is a genuine singleton, not a shortcut around
 * context: it exists for headless state logic — chiefly the navigation slice —
 * that must resolve a path against the document inside a zustand reducer, where
 * hooks are not available. Returns null before the provider mounts.
 */
let liveStore: DocumentStore | null = null;

export function getDocStore(): DocumentStore | null {
  return liveStore;
}

/** The current document, or null before the provider mounts. */
export function peekDoc(): MotionDocument | null {
  return liveStore?.getState() ?? null;
}

/**
 * THE STORE OUTLIVES ITS PROVIDER. It used to live in the provider's state, so
 * anything that remounted the provider — the crash screen's retry under
 * `AppBoundary`, a dev hot reload of a core module — built a fresh EMPTY
 * document while the shell still said a project was open, and the next
 * autosave wrote that empty document over the project. Kept on `globalThis`
 * (not just module scope) so a hot reload of this file keeps it too.
 */
const STORE_KEY = Symbol.for(NAMES.wire.documentStore);

function theStore(): DocumentStore {
  const slot = globalThis as unknown as Record<symbol, DocumentStore | undefined>;
  const store = (slot[STORE_KEY] ??= createDocumentStore(createEmptyDocument()));
  // Bytes of anything this document lists never leave the device (see
  // `keepListedAssetBytes`). Every call, so a hot-reloaded asset store re-learns it.
  keepListedAssetBytes((id) => store.getState().assets.some((a) => a.id === id));
  return store;
}

export function DocumentProvider({ children }: { children: React.ReactNode }) {
  const store = theStore();
  liveStore = store;
  // Raster surfaces follow document history through ONE seam: every doc change
  // (including undo/redo) reconciles surface pixels to each raster clip's
  // `rev`. A no-op walk when nothing raster changed — see raster-store.ts.
  React.useEffect(
    () => store.subscribe(() => syncSurfacesToDocument(store.getState())),
    [store],
  );
  // The other half of that relationship: paint that finishes drying on its own
  // has to become pixels, and only something holding the store can take the
  // history step that says so. Same seam as the Dry button.
  React.useEffect(() => watchSettlingPaint(store), [store]);
  return <DocumentStoreContext.Provider value={store}>{children}</DocumentStoreContext.Provider>;
}

/** The document store if this subtree has one (a dialog outside the editor
 *  does not), for a generic control that only enriches itself with it. */
export function useOptionalDocStore(): DocumentStore | null {
  return React.useContext(DocumentStoreContext);
}

export function useDocStore(): DocumentStore {
  const store = React.useContext(DocumentStoreContext);
  if (!store) throw new Error("useDocStore must be used inside <DocumentProvider>");
  return store;
}

/**
 * REACT'S VIEW OF THE DOCUMENT IS COALESCED TO ONE NOTIFICATION PER FRAME.
 *
 * The store emits synchronously, once per edit, which is right: the stage's
 * own loop wants to know immediately, and so does anything reading state back
 * after a write. React is the one subscriber for which "immediately" is not
 * only unnecessary but actively wrong.
 *
 * A pointer device fires moves at whatever rate it likes — 120Hz on a modern
 * trackpad, higher on some mice — and a drag writes the document on every one
 * of them. Each write is a separate task, so React 18's automatic batching
 * cannot help: every event gets its own full render pass through every
 * component that reads the document. At 120Hz that is two complete passes for
 * every frame the display can show, and the second one is thrown away
 * unseen. Measured during a slider drag on a heavy layer, the paint was 18ms
 * of a 90ms long task; nearly all of the rest was this.
 *
 * So the notification is deferred to the next animation frame and collapsed:
 * N writes in one frame wake React once. This is a scheduling change and not a
 * consistency one — `getSnapshot` still reads the live store, so React always
 * RENDERS the current document and there is nothing to tear. The only thing
 * that moves is when a render is scheduled, and the bound is one frame, which
 * is the granularity a screen has anyway.
 *
 * Deliberately here and not in `createDocumentStore`: core is headless and runs
 * in the exporter and in tests, where there is no animation frame and no reason
 * to defer anything. The store stays synchronous; React is what batches.
 *
 * It also cannot reach the canvas. The stage subscribes to the store directly
 * from its own render loop, never through this hook.
 *
 * ONE FRAME CALLBACK PER STORE, NOT PER SUBSCRIBER. Each `useDoc` used to
 * schedule its own `requestAnimationFrame`. React flushes the sync work a
 * store change schedules in a microtask after EACH callback, so N subscribers
 * meant N separate renders and N commits in one frame — measured at ~700
 * commits per bone-drag move on the Talking Characters template (four hooks
 * per timeline clip), which is what made posing feel like wading. All of a
 * store's React subscribers now wake inside ONE callback, so React batches
 * them into one render.
 */
const frameBroadcasters = new WeakMap<DocumentStore, (cb: () => void) => () => void>();
function frameBroadcaster(store: DocumentStore): (cb: () => void) => () => void {
  let sub = frameBroadcasters.get(store);
  if (sub) return sub;
  const listeners = new Set<() => void>();
  let raf = 0;
  let unsubStore: (() => void) | null = null;
  const flush = () => {
    raf = 0;
    for (const l of [...listeners]) l();
  };
  sub = (cb) => {
    listeners.add(cb);
    unsubStore ??= store.subscribe(() => {
      if (!raf) raf = requestAnimationFrame(flush);
    });
    return () => {
      listeners.delete(cb);
      if (listeners.size) return;
      unsubStore?.();
      unsubStore = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
  };
  frameBroadcasters.set(store, sub);
  return sub;
}

function useCoalescedDocSubscribe(store: DocumentStore): (cb: () => void) => () => void {
  return React.useMemo(() => frameBroadcaster(store), [store]);
}

/**
 * Subscribe to a SLICE of the document: re-renders only when `select` returns
 * something new (by `isEqual`, `Object.is` by default). The document is
 * immutable and structurally shared, so selecting a clip, a frame or a track
 * returns the same object until that thing actually changes — a timeline row
 * selecting its own clip sits still while a bone drag rewrites another layer.
 * `select` should be cheap; it runs on every document change.
 */
export function useDocSelector<T>(select: (doc: MotionDocument) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useDocStore();
  const subscribe = useCoalescedDocSubscribe(store);
  // Memoised on (document, selector): an inline selector is a new function each
  // render, and is re-run then — but an equal answer keeps the old identity, so
  // useSyncExternalStore sees no change and nothing below re-renders.
  const last = React.useRef<{ doc: MotionDocument; select: unknown; value: T } | null>(null);
  const getSnapshot = () => {
    const doc = store.getState();
    const prev = last.current;
    if (prev && prev.doc === doc && prev.select === select) return prev.value;
    const next = select(doc);
    const value = prev && isEqual(prev.value, next) ? prev.value : next;
    last.current = { doc, select, value };
    return value;
  };
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/**
 * The document, for a view that READS widely but DEPENDS narrowly: it
 * re-renders only when one of `deps(doc)` changes identity, and hands back the
 * document as of that change. Name every input the view's output depends on —
 * a dependency left out is a view that goes stale. Prefer `useDocSelector`
 * when the view needs one value.
 */
export function useDocWhen(deps: (doc: MotionDocument) => readonly unknown[]): MotionDocument {
  return useDocSelector(
    (doc) => ({ doc, deps: deps(doc) }),
    (a, b) => sameList(a.deps, b.deps),
  ).doc;
}

/** Subscribe to the whole document. Components re-render on any doc change. */
export function useDoc(): MotionDocument {
  const store = useDocStore();
  const subscribe = useCoalescedDocSubscribe(store);
  return React.useSyncExternalStore(subscribe, store.getState, store.getState);
}

export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export function useHistoryInfo(): HistoryInfo {
  const store = useDocStore();
  const get = React.useCallback((): HistoryInfo => {
    return {
      canUndo: store.canUndo(),
      canRedo: store.canRedo(),
      undoLabel: store.peekUndoLabel(),
      redoLabel: store.peekRedoLabel(),
    };
  }, [store]);
  // Cache the snapshot object; invalidate on store notifications.
  const cache = React.useRef<{ snap: HistoryInfo }>({ snap: get() });
  // The snapshot is refreshed the moment the store says so — `getSnapshot` must
  // never be stale — but waking React is coalesced to a frame like every other
  // document-driven render. Undo labels do not need to arrive faster than the
  // screen can show them.
  const coalesced = useCoalescedDocSubscribe(store);
  const subscribe = React.useCallback(
    (cb: () => void) => {
      const unsubNow = store.subscribe(() => {
        cache.current.snap = get();
      });
      const unsubFrame = coalesced(cb);
      return () => {
        unsubNow();
        unsubFrame();
      };
    },
    [store, get, coalesced],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => cache.current.snap,
    () => cache.current.snap,
  );
}
