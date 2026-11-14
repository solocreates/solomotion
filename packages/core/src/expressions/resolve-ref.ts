import { GLOBALS_BY_NAME, type GlobalDef } from "./globals";
import type { ExprLayerProperty } from "./layer-api";
import type { ExprType } from "./types";

/**
 * ONE answer to "what does `#a.b.c` point at?", shared by the checker and the
 * evaluator so they can never disagree about a name.
 *
 * The lexer hands over a whole dotted path because whether a dot is part of a
 * NAME (`#layer.index`) or a member access (`#position.x`) is a question about
 * scope, not about text. So we resolve the LONGEST prefix that names something
 * and hand the leftover segments back as member accesses. `#layer.index` matches
 * a global outright; `#offset.x` matches the variable `offset` and leaves `.x`;
 * `#layer.index.x` matches the global and then fails cleanly on `.x` with a real
 * message instead of a shrug.
 */

export type RefTarget =
  | { source: "local"; name: string; type: ExprType }
  | { source: "global"; name: string; type: ExprType; def: GlobalDef }
  | { source: "variable"; name: string; type: ExprType; id: string }
  /** `#layer.rotation`, `#layer.fill.<id>.color` — a real animatable path on the
   *  layer in scope, resolved against the SAME projection its node card uses. */
  | { source: "layerProperty"; name: string; type: ExprType; property: ExprLayerProperty };

export interface RefScope {
  /** Locals declared ABOVE the reference, by exact name. */
  locals: Map<string, ExprType>;
  /** Document variables by name, case-insensitive (names carry spaces/case). */
  lookupVariable: (name: string) => { id: string; name: string; type: ExprType } | undefined;
  /**
   * Every animatable path the layer in scope exposes, by path — the layer's own
   * node sockets, reachable as `#layer.<path>`. Absent when no layer is in scope
   * (a document-level expression), which is exactly when those names should not
   * resolve.
   */
  layerProperties?: Map<string, ExprLayerProperty>;
  /** The type of the field the expression drives — what `#value` is. Absent: it drives none. */
  fieldType?: ExprType | null;
}

export interface ResolvedRef {
  target: RefTarget;
  /** How many leading path segments the name consumed; the rest are members. */
  consumed: number;
}

export function resolveRef(path: string[], scope: RefScope): ResolvedRef | null {
  for (let len = path.length; len >= 1; len--) {
    const name = path.slice(0, len).join(".");

    const local = scope.locals.get(name);
    if (local) return { target: { source: "local", name, type: local }, consumed: len };

    const global = GLOBALS_BY_NAME.get(name);
    // Built-ins win a tie with a same-named document variable. There is exactly
    // one #time in the language and it is this one; the checker separately warns
    // at the reference so a shadowed variable is visible rather than mysterious.
    if (global) return { target: { source: "global", name, type: global.fieldTyped && scope.fieldType ? scope.fieldType : global.type, def: global }, consumed: len };

    const variable = scope.lookupVariable(name);
    if (variable) {
      return { target: { source: "variable", name: variable.name, type: variable.type, id: variable.id }, consumed: len };
    }

    // `#layer.<path>`: anything the layer in scope actually exposes. Checked
    // AFTER the intrinsics so `#layer.time` keeps meaning clip-local time rather
    // than resolving to some property that happens to share the name, and after
    // variables so a name you chose is never shadowed by the document's shape.
    if (name.startsWith("layer.")) {
      const property = scope.layerProperties?.get(name.slice("layer.".length));
      if (property) {
        return { target: { source: "layerProperty", name, type: property.type, property }, consumed: len };
      }
    }
  }
  return null;
}

/** The closest known name to a typo, for "did you mean…?" — null when nothing
 *  is near enough to be worth suggesting. */
export function closestName(input: string, candidates: string[]): string | null {
  const target = input.toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = editDistance(target, c.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  // Allow roughly a third of the word to be wrong before we stop guessing.
  return best !== null && bestScore <= Math.max(1, Math.floor(target.length / 3) + 1) ? best : null;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}
