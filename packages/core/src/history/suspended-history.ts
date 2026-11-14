import { parseDocument, serializeDocument } from "../io";
import { hashString } from "../hash";
import type { MotionDocument } from "../schema";
import type { HistoryEntry, SuspendedHistory } from "./document-store";

/**
 * What a put-away project may keep of its undo: the NEAREST steps, newest
 * first, until either cap is reached. Undo fills first (it is what people
 * reach for); redo gets what is left. Persisted per open tab, so these caps
 * are what keeps a long day's history from filling the disk.
 */
export const SUSPEND_CAPS = { steps: 64, bytes: 8 * 1024 * 1024 } as const;

export function capHistory(h: SuspendedHistory, caps: { steps: number; bytes: number } = SUSPEND_CAPS): SuspendedHistory {
  let bytes = 0;
  const nearest = (stack: HistoryEntry[]): HistoryEntry[] => {
    const kept: HistoryEntry[] = [];
    for (let i = stack.length - 1; i >= 0 && kept.length < caps.steps; i--) {
      const e = stack[i]!;
      if (bytes + e.bytes > caps.bytes) break;
      bytes += e.bytes;
      kept.unshift(e);
    }
    return kept;
  };
  const undo = nearest(h.undo);
  return { undo, redo: nearest(h.redo) };
}

/**
 * THE identity a suspended history is checked against: a hash of the document
 * as it will come back from disk. A project reloads through `parseDocument`,
 * which orders keys by the schema and fills defaults, so the live document
 * and the reloaded one differ as text while describing the same thing; one
 * pass through serialise → parse is a fixed point, so fingerprinting that
 * normal form makes "the same document" mean the same thing on both sides.
 * Anything else (an import, another window's save, a newer autosave that
 * deleted a layer the history mentions) gives a different fingerprint, and the
 * history is dropped rather than replayed over a document it does not describe.
 */
export function documentFingerprint(doc: MotionDocument): string {
  return hashString(serializeDocument(parseDocument(serializeDocument(doc))));
}
