import type { Expression, Variable } from "../schema";
import { parseFxToken } from "../schema";
import { evaluateExpressionSource, getExpressionContext, scopedSeedFor } from "./bind";
import type { EvalScope } from "./eval";
import { exprTypeForVariable, type ExprType, type ExprValue } from "./types";

/**
 * SCOPE CONSTRUCTION — the doc-shaped facts an expression reads, assembled
 * WITHOUT importing the variables engine.
 *
 * That omission is the point. `variables/index.ts` is the funnel every render
 * path already calls (`resolveColor`, `resolveNumber`, …), so it has to be able
 * to resolve an `fx:` token; if this module reached back into it for
 * `variableValueNow`, the two would import each other. Instead the sampler is
 * passed IN. The variables module hands over its own, and everyone else goes
 * through `expressions/document.ts`, which is free to import both.
 */

/**
 * Expressions name variables the way people do — by name, case-insensitively —
 * while the rest of the document uses ids. Memoised on the variables ARRAY:
 * immer hands back a new array on every edit, so the index can never go stale
 * and invalidation costs nothing.
 */
const nameIndex = new WeakMap<Variable[], Map<string, Variable>>();

export function variablesByName(variables: Variable[]): Map<string, Variable> {
  const cached = nameIndex.get(variables);
  if (cached) return cached;
  const index = new Map<string, Variable>();
  for (const v of variables) index.set(v.name.trim().toLowerCase(), v);
  nameIndex.set(variables, index);
  return index;
}

/** How a variable's live value is read — `variableValueNow`, injected. */
export type VariableSampler = (variable: Variable) => ExprValue;

/** The evaluation scope for one expression: ambient host facts + this
 *  expression's own stable seed + the document's variables by name. */
export function makeExprScope(
  variables: Variable[],
  sample: VariableSampler,
  expressionId: string,
): EvalScope {
  const index = variablesByName(variables);
  return {
    ctx: (() => {
      const ambient = getExpressionContext();
      return { ...ambient, seed: scopedSeedFor(expressionId, ambient.scope) };
    })(),
    readVariable: (name) => {
      const v = index.get(name.trim().toLowerCase());
      if (!v) return undefined;
      const type = exprTypeForVariable(v.type);
      // A paint has no expression type — naming one in an expression reads as
      // an unknown variable, which is exactly what it is from here.
      return type ? { id: v.id, value: sample(v), type } : undefined;
    },
  };
}

/**
 * THE ONE FUNNEL, in its raw form: a stored slot value in, a resolved value out,
 * `undefined` for anything that is not an `fx:` token — so a caller can chain it
 * in front of its existing logic in a single line.
 */
export function resolveFxToken(
  value: unknown,
  expressions: Expression[],
  variables: Variable[],
  sample: VariableSampler,
  expect: ExprType | null,
): ExprValue | undefined {
  const id = parseFxToken(value);
  if (!id) return undefined;
  const expression = expressions.find((e) => e.id === id);
  if (!expression) return undefined;
  return evaluateExpressionSource(expression.source, makeExprScope(variables, sample, id), expect);
}
