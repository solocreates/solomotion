import type { Patch } from "immer";

/**
 * REBASING PATCHES — so one author's step can be undone from under another's.
 *
 * An agent and a person edit the same document at once: the person tweaks the
 * cover while the agent keys the reel. History is one stack, so the person's
 * ⌘Z popped the agent's newest step — their own edit stayed and the agent's
 * keys vanished. Undoing THEIR step means applying its inverse to a document
 * the agent has changed since, and that only works if the patches are moved
 * past each other first. That is operational transformation over immer's
 * patch paths, and it is small because the paths are:
 *
 *  · disjoint paths commute untouched (a different clip, a different field);
 *  · an array insert or removal SHIFTS the indices of later siblings — the
 *    one structural fact, so the one rewrite;
 *  · anything else that overlaps (the same field written by both, one side
 *    replacing or removing what the other edits inside) is a CONFLICT. There
 *    is no right merge for it, so the caller refuses and says why; it never
 *    guesses. A wrong guess is a corrupted document; a refusal is a message.
 */
export class RebaseConflict extends Error {
  constructor() {
    super("Edits overlap");
  }
}

type Path = Patch["path"];

const isArrayOp = (p: Patch) => (p.op === "add" || p.op === "remove") && typeof p.path[p.path.length - 1] === "number";

/** `t` moved to apply AFTER `by` — both authored against the same state. */
export function patchAfter(t: Patch, by: Patch, tieAfter: boolean): Patch {
  const T = t.path;
  const B = by.path;
  if (B[B.length - 1] === "length" || T[T.length - 1] === "length") {
    if (prefixLen(T, B) >= Math.min(T.length, B.length) - 1) throw new RebaseConflict();
  }
  const k = prefixLen(T, B);
  // An insert or removal in an array T reaches into (or sits in).
  if (isArrayOp(by)) {
    const pos = B.length - 1;
    if (k >= pos && T.length > pos && typeof T[pos] === "number") {
      const i = T[pos] as number;
      const j = B[pos] as number;
      if (by.op === "add") {
        // Same slot: an existing element (deeper path, or a replace/remove of
        // it) moved up one; two inserts there order by `tieAfter`.
        const shifts = i > j || (i === j && (T.length > B.length || t.op !== "add" || tieAfter));
        return shifts ? withIndex(t, pos, i + 1) : t;
      }
      if (i === j) throw new RebaseConflict();
      return i > j ? withIndex(t, pos, i - 1) : t;
    }
  }
  if (k < Math.min(T.length, B.length)) return t; // diverged: independent
  // One path contains the other.
  if (T.length < B.length && isArrayOp(t) && t.op === "add") return t; // inserting beside what `by` edits
  throw new RebaseConflict();
}

function prefixLen(a: Path, b: Path): number {
  const n = Math.min(a.length, b.length);
  let k = 0;
  while (k < n && a[k] === b[k]) k++;
  return k;
}

function withIndex(p: Patch, pos: number, index: number): Patch {
  const path = p.path.slice();
  path[pos] = index;
  return { ...p, path };
}

/**
 * Two patch lists authored against the SAME state, each moved past the other:
 * `a` to apply after `b`, and `b` to apply after `a`. Throws `RebaseConflict`
 * when any pair overlaps in a way no index shift resolves.
 */
export function rebasePatches(a: readonly Patch[], b: readonly Patch[]): { a: Patch[]; b: Patch[] } {
  let bs = b.slice();
  const out: Patch[] = [];
  for (const p0 of a) {
    let p = p0;
    const next: Patch[] = [];
    for (const q of bs) {
      next.push(patchAfter(q, p, false));
      p = patchAfter(p, q, true);
    }
    bs = next;
    out.push(p);
  }
  return { a: out, b: bs };
}
