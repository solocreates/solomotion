import { createId } from "../ids";
import type { MotionDocument, Expression } from "../schema";
import { parseFxToken } from "../schema";
import { variableValueNow, visitValueSlots } from "../variables";
import type { CheckEnv } from "./check";
import type { EvalScope } from "./eval";
import { makeExprScope, resolveFxToken } from "./scope";
import { exprTypeForVariable, type ExprType, type ExprValue } from "./types";

/**
 * THE DOCUMENT FACE of the language: turning `fx:<id>` into a value, and keeping
 * the `doc.expressions` table honest.
 *
 * Everything here is the same shape the variables table already has — create,
 * read, count usages, sweep orphans — because they are the same kind of thing:
 * a reusable row that slots point at. Sharing that shape is what makes undo,
 * export, slicing and the manager UI work on expressions without a second
 * implementation of any of them.
 */

export function expressionById(doc: MotionDocument, id: string): Expression | undefined {
  return doc.expressions.find((e) => e.id === id);
}

export function addExpression(doc: MotionDocument, source: string, name = ""): Expression {
  const expression: Expression = { id: createId("fx"), source, name };
  doc.expressions.push(expression);
  return expression;
}

export function setExpressionSource(doc: MotionDocument, id: string, source: string): void {
  const expression = expressionById(doc, id);
  if (expression) expression.source = source;
}

/** Remove a row. The SLOT is the caller's business — detaching a field means
 *  writing a literal back into it, which only the field knows how to do. */
export function deleteExpression(doc: MotionDocument, id: string): void {
  doc.expressions = doc.expressions.filter((e) => e.id !== id);
}

/** The evaluation scope for one expression in this document, at the ambient
 *  clock — the document-shaped wrapper over `makeExprScope`. */
export function documentExprScope(doc: MotionDocument, expressionId: string): EvalScope {
  return makeExprScope(doc.variables, (v) => variableValueNow(v) as ExprValue, expressionId);
}

/**
 * `fx:<id>` → a value, for callers that hold the whole document. The variables
 * funnel uses the raw `resolveFxToken` instead (it cannot import this module
 * without a cycle); both run the same code underneath.
 */
export function resolveExpressionToken(
  doc: MotionDocument,
  value: unknown,
  expect: ExprType | null,
): ExprValue | undefined {
  return resolveFxToken(value, doc.expressions, doc.variables, (v) => variableValueNow(v) as ExprValue, expect);
}

/** The checking environment for a document — what the editor lints against. */
export function documentCheckEnv(
  doc: MotionDocument,
  expect: ExprType | null,
  available?: CheckEnv["available"],
): CheckEnv {
  return {
    // Only variables an expression can actually READ. A paint has no
    // expression type, so it is absent from the lint environment rather than
    // present with a type the evaluator would choke on.
    variables: doc.variables.flatMap((v) => {
      const type = exprTypeForVariable(v.type);
      return type ? [{ id: v.id, name: v.name, type }] : [];
    }),
    expect,
    available,
  };
}

// ── Usage & housekeeping ─────────────────────────────────────────────────────

/**
 * Visit every property-path DRIVER token in the document (`clip.drivers`), the
 * seam that carries `expr:` graph tokens and `fx:` expression tokens alike.
 * Return a replacement to rewrite the entry, or undefined to leave it. This is
 * the companion to `visitValueSlots`: between them they see every place a
 * reference token can be stored.
 */
export function visitDriverSlots(
  doc: MotionDocument,
  visit: (token: string, path: string, clipId: string) => string | undefined,
): void {
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const drivers = clip.drivers;
      if (!drivers) continue;
      for (const path in drivers) {
        const token = drivers[path];
        if (typeof token !== "string") continue;
        const next = visit(token, path, clip.id);
        if (next !== undefined) drivers[path] = next;
      }
    }
  }
}

/** How many slots reference each expression, across BOTH storage seams. */
export function expressionUsage(doc: MotionDocument): Map<string, number> {
  const usage = new Map<string, number>();
  const count = (value: unknown) => {
    const id = parseFxToken(value);
    if (id) usage.set(id, (usage.get(id) ?? 0) + 1);
  };
  // Slot-stored tokens (colours, typography, anything `Bindable`). Reusing the
  // variables walker is deliberate: the two token schemes must see exactly the
  // same set of slots, and one walker is the only way to guarantee that.
  visitValueSlots(doc, (value) => {
    count(value);
    return undefined;
  });
  // Property-path drivers.
  visitDriverSlots(doc, (token) => {
    count(token);
    return undefined;
  });
  return usage;
}

/**
 * Drop rows nothing points at. Run on load, so a document that has had fields
 * detached and clips deleted heals itself instead of accumulating dead text.
 */
export function pruneExpressions(doc: MotionDocument): void {
  if (doc.expressions.length === 0) return;
  const usage = expressionUsage(doc);
  doc.expressions = doc.expressions.filter((e) => (usage.get(e.id) ?? 0) > 0);
}

/**
 * The document as it should LEAVE memory: the same document without the rows
 * nothing points at — or the very same object when there are none.
 *
 * Pruning only on load meant every save, bundle and publish in between carried
 * the expressions of layers deleted since (a black-hole film shipped eleven).
 * Pruning in the delete would have to be remembered by every path that removes
 * a layer, and would break undo's picture of what the row held. So the live
 * document keeps them (undo restores a layer with its expressions intact) and
 * nothing written out does.
 */
export function withLiveExpressions(doc: MotionDocument): MotionDocument {
  if (doc.expressions.length === 0) return doc;
  const usage = expressionUsage(doc);
  const live = doc.expressions.filter((e) => (usage.get(e.id) ?? 0) > 0);
  return live.length === doc.expressions.length ? doc : { ...doc, expressions: live };
}
