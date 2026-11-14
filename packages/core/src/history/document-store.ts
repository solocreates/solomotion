import { applyPatches, enablePatches, freeze, produce, produceWithPatches, type Patch } from "immer";
import type { MotionDocument } from "../schema";
import { reconcileTransitions } from "../timeline/transitions";
import { holdTextPivots } from "../timeline/ops";
import { RebaseConflict, rebasePatches } from "./rebase";

enablePatches();

/**
 * The document store: single source of truth for the (undoable) document.
 *
 * Every `update` runs an immer recipe and records only the resulting patches
 * (forward + inverse) — memory cost is proportional to what changed, never a
 * full snapshot. Continuous gestures (slider drags, typing, clip drags) pass a
 * `mergeKey`; consecutive updates with the same key within the merge window
 * coalesce into a single history entry, so undo granularity matches user
 * intent instead of input events.
 *
 * Framework-free: the web app binds it with useSyncExternalStore; a CLI or
 * test harness can drive it directly.
 */

export interface HistoryEntry {
  label: string;
  mergeKey?: string;
  /** Written by an agent session rather than by the person at the keyboard. */
  author?: "agent";
  at: number;
  /** Forward patches, in apply order. Appended to in place while merging. */
  patches: Patch[];
  /**
   * Inverse patches as CHUNKS, one per write, OLDEST first — undo applies them
   * newest to oldest. A merge appends one chunk instead of re-copying every
   * inverse so far, which
   * is what made a long agent turn (thousands of writes, one entry) cost
   * O(n²) in copies.
   */
  inverse: Patch[][];
  /** Estimated bytes this entry keeps alive (`patchBytes`). */
  bytes: number;
}

/**
 * HISTORY IS BOUNDED BY WHAT IT HOLDS, not only by how many steps. A step is
 * cheap when it moves a clip and expensive when it replaces a 450-key array or
 * a whole frame — the inverse holds the OLD value alive. Counting steps alone
 * let 250 heavy steps (or one agent turn merged from thousands of writes) keep
 * hundreds of megabytes of dead document alive.
 *
 *  - `MAX_HISTORY_BYTES`: the oldest steps go first once the total passes it
 *    (the newest step always stays, however large — undoing the last thing you
 *    did is the one promise history cannot break).
 *  - `MAX_ENTRY_BYTES`: a merging entry that grows past this closes, and the
 *    next same-key write opens a new entry with the same key. `undoDepthOf`
 *    already counts down to a key's OLDEST entry, so "undo the agent's turn"
 *    still takes the whole turn back, in one action.
 */
const MAX_HISTORY_BYTES = 96 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

/**
 * An estimate of the memory a patch list keeps alive — never a serialisation.
 * Shared structure is counted as if owned (an over-estimate is the safe
 * direction for a budget).
 *
 * MEASURED ONCE PER OBJECT. Immer freezes what it produces and shares what an
 * edit did not touch, so nearly every value in a patch is a frozen subtree that
 * an earlier patch already measured — and a frozen object's size can never
 * change. Re-walking them was the cost: an array shift (deleting a comp) is one
 * replace patch per later row, each holding a whole track, and the walk of all
 * of them made `frame.delete` take ~400 ms and a scripted build a third longer.
 * Unfrozen values (a draft's plain copy) are walked and not remembered.
 */
export function patchBytes(patches: readonly Patch[]): number {
  let total = 0;
  for (const p of patches) total += 48 + p.path.length * 16 + ("value" in p ? valueBytes(p.value) : 0);
  return total;
}

const sizeOf = new WeakMap<object, number>();

function valueBytes(v: unknown): number {
  if (typeof v === "string") return 16 + v.length * 2;
  if (v === null || typeof v !== "object") return 8;
  const known = sizeOf.get(v);
  if (known !== undefined) return known;
  let bytes: number;
  if (Array.isArray(v)) {
    bytes = 16 + v.length * 8;
    for (const x of v) bytes += valueBytes(x);
  } else {
    bytes = 32;
    for (const k in v as Record<string, unknown>) bytes += 8 + valueBytes((v as Record<string, unknown>)[k]);
  }
  if (Object.isFrozen(v)) sizeOf.set(v, bytes);
  return bytes;
}

function applyInverse(doc: MotionDocument, chunks: readonly Patch[][]): MotionDocument {
  let out = doc;
  for (let i = chunks.length - 1; i >= 0; i--) out = applyPatches(out, chunks[i]!);
  return out;
}

export interface UpdateOptions {
  /** Coalesce with the previous entry when it has the same key (drags, typing). */
  mergeKey?: string;
  /**
   * How long after the previous write a same-key write still merges. Defaults
   * to the gesture window (900ms), which is right for input events and wrong
   * for a SESSION of edits: an agent turn writes a dozen times over a minute,
   * between model round-trips, and is still one thing the user asked for.
   * `Infinity` merges for as long as nothing else lands on the stack — any
   * other entry (the user's own edit, an undo) breaks the chain, so a long
   * window can never swallow work that was not part of it.
   */
  mergeWindowMs?: number;
  /** An agent session wrote this — see `undoOwn`. Absent means the person did. */
  author?: "agent";
}

/** What the person's ⌘Z did. */
export type UndoOwnResult = "undone" | "nothing" | "conflict";

export interface DocumentStore {
  getState(): MotionDocument;
  /** Run a mutation as an undoable step. Returns whether anything changed. */
  update(label: string, recipe: (draft: MotionDocument) => void, options?: UpdateOptions): boolean;
  /**
   * Set (or clear, with `null`) an EPHEMERAL preview overlay: a recipe layered
   * on top of the committed document for reads only — `getState()` returns the
   * overlaid view, so the canvas and every subscriber render it live, while
   * history stays untouched. The one seam for non-committal previews (font
   * hover, drag ghosts, …); commit by clearing the overlay then calling
   * `update`. Idempotent and cheap: an inactive overlay returns the doc itself.
   */
  setOverlay(recipe: ((draft: MotionDocument) => void) | null): void;
  /**
   * A write the document KEEPS but history never sees — view state that is
   * saved with the project (each frame's playhead) and that undo must neither
   * record nor roll back. Patches are path-granular, so undoing an unrelated
   * edit leaves it alone. Never for content: an edit the user cannot undo is a
   * bug.
   */
  remember(recipe: (draft: MotionDocument) => void): void;
  undo(): boolean;
  /**
   * THE PERSON'S UNDO. While an agent works alongside them, its steps land on
   * the same stack — so a plain undo after the person's own edit took back the
   * agent's newest step instead. When the agent steps on top belong to turns
   * that were already running before that edit (the turn has steps BELOW it
   * too), this undoes the person's edit from under them, rebasing the agent's
   * steps past it. A turn that began after the person's last edit is theirs to
   * undo as a whole, so it is undone as before. `conflict`: both changed the
   * same thing — nothing is touched.
   */
  undoOwn(): UndoOwnResult;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Label of the step that undo/redo would revert/reapply (for tooltips). */
  peekUndoLabel(): string | null;
  peekRedoLabel(): string | null;
  /**
   * How many undos take the document back to before the OLDEST entry written
   * with this merge key (a whole agent turn, even one the user interrupted with
   * their own edit) — null when none is on the stack. Everything above it is
   * undone too, and all of it stays redoable.
   */
  undoDepthOf(mergeKey: string): number | null;
  /** How many redos bring back every entry written with this key — null when none is waiting. */
  redoDepthOf(mergeKey: string): number | null;
  /**
   * Could `id` be in the document now, or after any undo or redo? True when
   * the committed document or any history step mentions it. What decides
   * whether something an edit dropped (an asset's bytes) may be freed: an
   * undo must find it where it was.
   */
  reaches(id: string): boolean;
  /** Replace the document wholesale (import / new). Clears history. */
  replace(doc: MotionDocument): void;
  /**
   * The undo and redo stacks as plain data, for a tab that is put away
   * (`importHistory` hands them back). Entries are immer patches over plain
   * JSON, so they serialise as they are.
   */
  exportHistory(): SuspendedHistory;
  /**
   * Hand back stacks exported from THIS document. The caller proves the match
   * (a fingerprint of the document both were taken against); a history
   * replayed over a different document would corrupt it, so a mismatch must
   * never reach here.
   */
  importHistory(history: SuspendedHistory): void;
  subscribe(listener: () => void): () => void;
}

const MERGE_WINDOW_MS = 900;
const MAX_HISTORY = 250;

export interface SuspendedHistory {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

export interface DocumentStoreOptions {
  /**
   * Keep an undo history (the default). A store nobody will ever undo — a
   * template or script BUILD that makes a document from nothing and hands it
   * on — says `false`, and every write is a plain immer `produce`: no patch
   * lists, no inverse, no byte accounting. On the Playground's ~2,000 build
   * writes those were a third of the build, all of it for a history that was
   * thrown away with the store.
   */
  history?: boolean;
}

export function createDocumentStore(initial: MotionDocument, storeOptions: DocumentStoreOptions = {}): DocumentStore {
  const keepsHistory = storeOptions.history !== false;
  // Frozen from the first frame, not from the first edit. Immer freezes every
  // snapshot it produces, and the per-document memos (`scopeIndex`, the
  // revision caches, the draw-on strand tables) take "frozen" as their proof
  // of immutability — a document that is only frozen after its first edit
  // would render its opening frames without them.
  let doc = freeze(initial, true);
  // The committed doc, or a preview layered on top of it. Cached so `getState`
  // stays referentially stable (useSyncExternalStore contract) — it only ever
  // changes identity when the doc or the overlay actually changes.
  let view = doc;
  let overlay: ((draft: MotionDocument) => void) | null = null;
  let undoStack: HistoryEntry[] = [];
  let redoStack: HistoryEntry[] = [];
  /** Sum of `bytes` over BOTH stacks. */
  let heldBytes = 0;
  const trim = () => {
    while (undoStack.length > 1 && (undoStack.length > MAX_HISTORY || heldBytes > MAX_HISTORY_BYTES)) {
      heldBytes -= undoStack.shift()!.bytes;
    }
  };
  const listeners = new Set<() => void>();

  const recomputeView = () => {
    view = overlay ? produce(doc, overlay) : doc;
  };

  const emit = () => {
    for (const l of listeners) l();
  };

  /**
   * Every mutation — committed or previewed — is followed by the transition
   * re-anchor pass, INSIDE the same immer recipe so its changes ride the same
   * patch set and undo/redo carry them for free.
   *
   * This is deliberately central rather than sprinkled through the edit ops:
   * trims, moves, splits, ripples, deletes and future ops nobody has written
   * yet all shift the cuts transitions hang off, and requiring each of them to
   * remember would guarantee a dangling record eventually. The pass early-outs
   * on tracks with no transitions, so the overwhelmingly common edit pays a
   * single length check per lane.
   */
  const withReconcile =
    (recipe: (draft: MotionDocument) => void) =>
    (draft: MotionDocument) => {
      recipe(draft);
      reconcileTransitions(draft);
      // The same argument, for a text layer's pivot: every content edit —
      // typed, picked in a font window, pasted, sent by an agent — keeps the
      // point the pivot sits on, so the words never slide (see the function).
      holdTextPivots(draft);
    };

  const store: DocumentStore = {
    getState: () => view,

    reaches(id) {
      if (JSON.stringify(doc).includes(id)) return true;
      const mentions = (e: HistoryEntry) => JSON.stringify(e.patches).includes(id) || JSON.stringify(e.inverse).includes(id);
      return undoStack.some(mentions) || redoStack.some(mentions);
    },

    setOverlay(recipe) {
      overlay = recipe ? withReconcile(recipe) : recipe;
      recomputeView();
      emit();
    },

    remember(recipe) {
      const next = produce(doc, recipe);
      if (next === doc) return;
      doc = next;
      recomputeView();
      emit();
    },

    update(label, recipe, options) {
      if (!keepsHistory) {
        const next = produce(doc, withReconcile(recipe));
        if (next === doc) return false;
        doc = next;
        recomputeView();
        emit();
        return true;
      }
      const [next, patches, inverse] = produceWithPatches(doc, withReconcile(recipe));
      if (patches.length === 0) return false;

      doc = next;
      recomputeView();
      for (const e of redoStack) heldBytes -= e.bytes;
      redoStack = [];

      const top = undoStack[undoStack.length - 1];
      const now = Date.now();
      const bytes = patchBytes(patches) + patchBytes(inverse);
      if (
        options?.mergeKey &&
        top &&
        top.mergeKey === options.mergeKey &&
        now - top.at < (options.mergeWindowMs ?? MERGE_WINDOW_MS) &&
        top.bytes < MAX_ENTRY_BYTES
      ) {
        // Compose: forward applies old-then-new, inverse applies new-then-old.
        for (const p of patches) top.patches.push(p);
        top.inverse.push(inverse);
        top.bytes += bytes;
        heldBytes += bytes;
        top.at = now;
        // The LATEST label wins. A merged entry is one gesture, and a gesture
        // can change what it is while it runs — hold ⌥ halfway through a clip
        // drag and it stops being a move and becomes a duplicate. Undo should
        // offer to undo what the gesture ENDED as, not what it started as.
        // Every other merging gesture passes the same label each time, so this
        // is a no-op for them.
        top.label = label;
      } else {
        undoStack.push({
          label,
          mergeKey: options?.mergeKey,
          ...(options?.author ? { author: options.author } : {}),
          at: now,
          patches: patches.slice(),
          inverse: [inverse],
          bytes,
        });
        heldBytes += bytes;
      }
      trim();
      emit();
      return true;
    },

    undo() {
      const entry = undoStack.pop();
      if (!entry) return false;
      doc = applyInverse(doc, entry.inverse);
      recomputeView();
      redoStack.push(entry);
      emit();
      return true;
    },

    undoOwn() {
      if (!undoStack.length) return "nothing";
      let u = undoStack.length - 1;
      while (u >= 0 && undoStack[u]!.author === "agent") u--;
      const above = undoStack.slice(u + 1);
      // Nothing of the agent's on top, or none of it interleaved with this
      // edit: an ordinary undo of the newest step.
      const below = new Set(undoStack.slice(0, Math.max(0, u)).map((e) => e.mergeKey));
      if (u < 0 || !above.length || !above.every((e) => e.mergeKey !== undefined && below.has(e.mergeKey))) {
        return store.undo() ? "undone" : "nothing";
      }
      const own = undoStack[u]!;
      let rebased: { own: HistoryEntry; above: HistoryEntry[]; undo: Patch[] };
      try {
        rebased = rebaseUndo(own, above);
      } catch (e) {
        if (e instanceof RebaseConflict) return "conflict";
        throw e;
      }
      doc = applyPatches(doc, rebased.undo);
      recomputeView();
      undoStack = [...undoStack.slice(0, u), ...rebased.above];
      redoStack.push(rebased.own);
      emit();
      return "undone";
    },

    redo() {
      const entry = redoStack.pop();
      if (!entry) return false;
      doc = applyPatches(doc, entry.patches);
      recomputeView();
      undoStack.push(entry);
      emit();
      return true;
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    peekUndoLabel: () => undoStack[undoStack.length - 1]?.label ?? null,
    peekRedoLabel: () => redoStack[redoStack.length - 1]?.label ?? null,
    // Undo pops the newest first, so the redo stack holds a key's newest entry
    // lowest; either way the answer is "down to the lowest index with the key".
    undoDepthOf: (key) => {
      const i = undoStack.findIndex((e) => e.mergeKey === key);
      return i < 0 ? null : undoStack.length - i;
    },
    redoDepthOf: (key) => {
      const i = redoStack.findIndex((e) => e.mergeKey === key);
      return i < 0 ? null : redoStack.length - i;
    },

    exportHistory: () => ({ undo: [...undoStack], redo: [...redoStack] }),

    importHistory(history) {
      if (!keepsHistory) return;
      undoStack = [...history.undo];
      redoStack = [...history.redo];
      heldBytes = [...undoStack, ...redoStack].reduce((n, e) => n + e.bytes, 0);
      trim();
      emit();
    },

    replace(nextDoc) {
      doc = freeze(nextDoc, true);
      overlay = null;
      recomputeView();
      undoStack = [];
      redoStack = [];
      heldBytes = 0;
      emit();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
}

/** An entry's inverse chunks as one list, in apply order (newest chunk first). */
function flatInverse(e: HistoryEntry): Patch[] {
  const out: Patch[] = [];
  for (let i = e.inverse.length - 1; i >= 0; i--) out.push(...e.inverse[i]!);
  return out;
}

/**
 * Undo `own` from under the entries written after it: its inverse moved past
 * each of theirs, their steps moved past its undo (so they still undo and
 * redo correctly in a world without it), and its own redo moved past them.
 * Throws `RebaseConflict` when anything overlaps.
 */
function rebaseUndo(own: HistoryEntry, above: readonly HistoryEntry[]): { own: HistoryEntry; above: HistoryEntry[]; undo: Patch[] } {
  // `undo` travels up the stack: at each entry it is authored against the
  // state BEFORE that entry, like the entry's forward patches.
  let undo = flatInverse(own);
  const forwards: Patch[][] = [];
  const out: HistoryEntry[] = [];
  for (const e of above) {
    const r = rebasePatches(undo, e.patches);
    undo = r.a;
    forwards.push(r.b);
    // The entry's inverse is authored against the state AFTER it — where the
    // advanced `undo` now is too.
    const inv = rebasePatches(flatInverse(e), undo).a;
    out.push({ ...e, patches: r.b, inverse: [inv] });
  }
  // Redo re-applies `own` on top of the rebased entries.
  let redo = own.patches.slice();
  for (const f of forwards) redo = rebasePatches(redo, f).a;
  return { own: { ...own, patches: redo, inverse: [undo] }, above: out, undo };
}
