import { FX_TOKEN_PREFIX, parseFxToken } from "../schema/expressions";
import { EXPR_TOKEN_PREFIX, exprToken, parseDriverToken } from "../schema/nodes";
import { VAR_TOKEN_PREFIX } from "../schema/variables";
import { INPUT_TOKEN_PREFIX, inputToken, parseInputToken } from "../schema/inputs";
import { parseVarToken, varToken } from "../variables";

/**
 * WHERE A VALUE COMES FROM — one vocabulary, one parser, one writer.
 *
 * A slot can hold a literal or a reference, and there are three kinds of
 * reference: `var:<id>` (a document variable), `fx:<id>` (a written expression)
 * and `expr:<graphId>[@node.socket]` (a node graph). Each grammar lives with the
 * schema that validates it, which is right — but every surface that wanted to
 * ask "what drives this?" was re-writing the same three-way branch, and each
 * copy learned about a new token flavour on a different day. That is how the
 * inspector came to show a "Nodes" chip on an expression, and how the renderer
 * came to gate its whole driver path on `doc.graphs.length`.
 *
 * So: nothing outside this file branches on a prefix. Ask `parseSource` what a
 * stored value IS, and hand `sourceToken` what you want it to become.
 */
export type ValueSource =
  | { kind: "literal" }
  | { kind: "variable"; id: string }
  | { kind: "expression"; id: string }
  | { kind: "graph"; graphId: string; sink?: { node: string; socket: string } }
  /** `input:<id>` — an input of the comp the slot lives in, valued per instance. */
  | { kind: "input"; id: string };

/** The kinds that are a reference to something — every source but a literal. */
export type BoundSourceKind = Exclude<ValueSource["kind"], "literal">;

/** A literal, shared so a "nothing drives this" answer costs no allocation and
 *  can be compared by identity. */
export const LITERAL_SOURCE: ValueSource = { kind: "literal" };

/** THE parser. Anything that is not a reference token reads as a literal, so a
 *  caller never has to check the type of what it is holding first. */
export function parseSource(value: unknown): ValueSource {
  if (typeof value !== "string") return LITERAL_SOURCE;
  const variable = parseVarToken(value);
  if (variable) return { kind: "variable", id: variable };
  const expression = parseFxToken(value);
  if (expression) return { kind: "expression", id: expression };
  const input = parseInputToken(value);
  if (input) return { kind: "input", id: input };
  const graph = parseDriverToken(value);
  if (graph) return { kind: "graph", graphId: graph.graphId, sink: graph.sink };
  return LITERAL_SOURCE;
}

/** THE writer — the exact inverse of `parseSource`. A literal has no token,
 *  which is what `null` says: remove the reference and let the value speak. */
export function sourceToken(source: ValueSource): string | null {
  switch (source.kind) {
    case "variable":
      return varToken(source.id);
    case "expression":
      return `${FX_TOKEN_PREFIX}${source.id}`;
    case "graph":
      return exprToken(source.graphId, source.sink);
    case "input":
      return inputToken(source.id);
    case "literal":
      return null;
  }
}

/** Is this stored value a reference rather than a value? The one predicate
 *  behind "did the user type over a binding" and "may this row be keyframed". */
export function isBound(value: unknown): boolean {
  return parseSource(value).kind !== "literal";
}

/** Two sources naming the same thing. Used to tell "rebound" from "re-rendered"
 *  without comparing tokens by hand at each call site. */
export function sameSource(a: ValueSource, b: ValueSource): boolean {
  return sourceToken(a) === sourceToken(b);
}

/**
 * The prefixes, listed once so a schema, a migration or a test can state "any
 * reference" without repeating the set — the omission that once let an `fx:`
 * token save fine and then fail to reopen.
 */
export const SOURCE_TOKEN_PREFIXES = [VAR_TOKEN_PREFIX, FX_TOKEN_PREFIX, EXPR_TOKEN_PREFIX, INPUT_TOKEN_PREFIX] as const;
