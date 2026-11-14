import type { NodeValue, SocketType, VariableType } from "../schema";
import { canConnect, coerce } from "../nodes/sockets";

/**
 * THE ONE TYPE BRAIN — shared by the expression checker, the variable picker's
 * filter and the node board's wires.
 *
 * `ExprType` is deliberately the SOCKET type union minus `any`, not a parallel
 * enum: an expression is just another thing that produces a value into a typed
 * slot, so it must obey exactly the rules a wire obeys. Because of that,
 * `canConnect`/`coerce` from `nodes/sockets` ARE the assignability and
 * conversion rules here — there is no second definition to drift. What this
 * file adds on top is the vocabulary the two *product* surfaces need: a human
 * label for messages, and the variable-type ↔ expression-type map that lets one
 * function answer both "which variables may this field be bound to?" and "does
 * this expression's result fit this field?".
 */

/** A concrete value an expression produces (identical to a node socket value). */
export type ExprValue = NodeValue;

/** Every type an expression can hold. `any` is a socket-only wildcard. */
export type ExprType = Exclude<SocketType, "any">;

export const EXPR_TYPES: ExprType[] = ["float", "vec2", "color", "bool", "string", "layer", "track"];

/**
 * What a type is CALLED to a human. The engine says `float` because sockets do;
 * every message a user reads says "number", because that is the word they typed
 * the value in. One table, so the two never disagree.
 */
export const EXPR_TYPE_LABEL: Record<ExprType, string> = {
  float: "number",
  vec2: "vector",
  color: "color",
  bool: "boolean",
  string: "text",
  layer: "layer",
  track: "tracker",
};

export function typeLabel(t: ExprType | null): string {
  return t === null ? "any" : EXPR_TYPE_LABEL[t];
}

// ── Variable ↔ expression types ──────────────────────────────────────────────

/**
 * The expression type a variable of this kind carries, or NULL when it carries
 * none.
 *
 * A paint variable is the null case, and saying so is better than picking a
 * plausible answer. Its value is a whole Paint — stops, a pattern, an asset —
 * and every expression type is a scalar, so any mapping would hand the
 * evaluator an object where it expected a string and fail at the far end of the
 * pipeline instead of here. Callers building a variable list for an expression
 * or a graph filter on this; callers that only need a default for an editor
 * they will never open on a paint fall back explicitly.
 */
export function exprTypeForVariable(type: VariableType): ExprType | null {
  switch (type) {
    case "color":
      return "color";
    case "number":
    case "fontWeight":
      return "float";
    case "fontFamily":
    case "string":
      return "string";
    case "paint":
      return null;
  }
}

/**
 * Which variable types may be bound into a slot of this expression type — the
 * VariablePicker's filter. It is the inverse of `exprTypeForVariable`, computed
 * from that table rather than hand-listed, so a new variable type shows up in
 * the right pickers the moment its mapping exists.
 */
export function variableTypesForExprType(type: ExprType): VariableType[] {
  const all: VariableType[] = ["color", "number", "fontFamily", "fontWeight", "string"];
  return all.filter((v) => exprTypeForVariable(v) === type);
}

/** A socket type as an expression type — `any` becomes null ("accepts all"). */
export function exprTypeForSocket(type: SocketType): ExprType | null {
  return type === "any" ? null : type;
}

// ── Assignability ────────────────────────────────────────────────────────────

/**
 * Can a value of type `from` land in a slot of type `to`, and how cleanly?
 *
 *  - `"exact"`   — same type, nothing happens.
 *  - `"convert"` — the socket rules define a conversion, but it LOSES something
 *    a person would notice (a number becoming a grey colour, a vector collapsing
 *    to its average). Allowed, and worth a warning on the result of a whole
 *    expression; silent on a function argument, where it is usually intended.
 *  - `"none"`    — no rule exists (text never silently becomes a number).
 *
 * bool↔number is treated as exact-enough to stay silent: 1/0 is what a
 * comparison is FOR, and warning about it would fire on every `#time > 1`.
 */
export type Assignability = "exact" | "convert" | "none";

export function assignability(from: ExprType, to: ExprType | null): Assignability {
  if (to === null || from === to) return "exact";
  const numeric = (t: ExprType) => t === "float" || t === "bool";
  if (numeric(from) && numeric(to)) return "exact";
  return canConnect(from, to) ? "convert" : "none";
}

/** Convert a value into a slot's type using the shared socket conversions. */
export function coerceValue(value: ExprValue, from: ExprType, to: ExprType | null): ExprValue {
  return to === null ? value : coerce(value, from, to);
}

// ── Source positions & diagnostics ───────────────────────────────────────────

/** A half-open range of the source text — what the editor colours and squiggles. */
export interface Span {
  start: number;
  end: number;
}

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  message: string;
  span: Span;
  severity: DiagnosticSeverity;
  /**
   * A one-click repair the editor can offer ("did you mean `#time`?"). Purely
   * advisory data — the core never edits source text itself.
   */
  fix?: { label: string; replacement: string; span: Span };
}

export function span(start: number, end: number): Span {
  return { start, end };
}

/** Does this list contain anything that stops the expression from running? */
export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/**
 * The one type two branches of an `if` (or two arms of `mix`) settle on. Used
 * by the checker to infer a result and by the function table to describe a
 * polymorphic return, so both agree on what `mix(red, blue, t)` produces.
 */
export function unifyTypes(a: ExprType | null, b: ExprType | null): ExprType {
  if (a === null) return b ?? "float";
  if (b === null) return a;
  if (a === b) return a;
  if (a === "string" || b === "string") return "string";
  if (a === "color" || b === "color") return "color";
  if (a === "vec2" || b === "vec2") return "vec2";
  if (a === "float" || b === "float") return "float";
  return "bool";
}

/** A hex colour, in any of the forms the document's colour parser accepts. */
const HEX_COLOR = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * The type of a text literal. Text that looks like a colour IS a colour: it is
 * what a person means when they type `"#ff8732"` into a fill, and typing it into
 * an expression should not suddenly mean something else. Everything else is text.
 */
export function literalTextType(value: string): ExprType {
  return HEX_COLOR.test(value.trim()) ? "color" : "string";
}
