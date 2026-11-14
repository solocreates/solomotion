import type { NodeTypeDef } from "./registry";
import { compileExpression } from "../expressions/bind";
import { evaluateProgram } from "../expressions/eval";
import { makeExprScope } from "../expressions/scope";
import type { NodeValue } from "../schema";

/**
 * THE EXPRESSION NODE — the written language, as a node.
 *
 * It holds one thing: source text. Everything else — the lexer, the checker, the
 * globals table, the function library, the seed rule — is IMPORTED, not
 * reimplemented, so a sentence means exactly the same thing whether you typed it
 * into a field's expression panel or dropped it on the board. That is the whole
 * point of the node existing: it is not a second expression system, it is the
 * first one with sockets on it.
 *
 * The output is `any` because the result type depends on what was written
 * (`#time * 2` is a number, `hsl(...)` is a colour), and the socket rules coerce
 * at the point of use exactly as they do for every other wildcard output.
 *
 * Its randomness is seeded from the NODE's id, matching how a field-bound
 * expression seeds from the expression's id: two copies of the same node wobble
 * independently, and each is identical on every replay.
 */

export const EXPRESSION_NODE_TYPE = "input.expression";

/** The `node.params` key holding the expression source. */
export const EXPRESSION_PARAM_KEY = "source";

export const expressionNode: NodeTypeDef = {
  type: EXPRESSION_NODE_TYPE,
  category: "input",
  title: "Expression",
  description: "Write a value — #time, your variables, maths and functions. The same language the fields use.",
  inputs: [],
  outputs: [{ key: "value", label: "Value", type: "any" }],
  options: [{ key: EXPRESSION_PARAM_KEY, label: "Expression", kind: "string", default: "" }],
  evaluate: ({ params, ctx, node }) => {
    const source = typeof params[EXPRESSION_PARAM_KEY] === "string" ? params[EXPRESSION_PARAM_KEY] : "";
    if (!source.trim() || !ctx.expressions) return { value: 0 as NodeValue };
    const scope = makeExprScope(ctx.expressions.variables, ctx.expressions.sample, node.id);
    const result = evaluateProgram(compileExpression(source), scope);
    return { value: result ? result.value : 0 };
  },
};
