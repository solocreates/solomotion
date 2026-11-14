import type { Token } from "./lexer";
import type { Diagnostic, Span } from "./types";

/**
 * THE SYNTAX TREE. Small on purpose: an expression that drives one field should
 * be readable in a glance, so the grammar is total and closed — literals,
 * `#references`, `function(calls)`, the usual operators, `?:`, member access,
 * and `#local = …;` declarations. There are no loops, no user functions and no
 * assignment to anything but a fresh local, which is exactly why evaluation can
 * be pure, terminating and safe to run once per field per frame.
 */

export interface NodeBase {
  span: Span;
}

export interface NumberLiteral extends NodeBase {
  kind: "number";
  value: number;
}
export interface StringLiteral extends NodeBase {
  kind: "string";
  value: string;
}
export interface BooleanLiteral extends NodeBase {
  kind: "boolean";
  value: boolean;
}

/** `#time`, `#layer.index`, `#"Brand Pink"`. The dotted path is UNRESOLVED here
 *  — how much of it is the name and how much is member access is a scope
 *  question, answered once in `resolveRef`. */
export interface Reference extends NodeBase {
  kind: "ref";
  path: string[];
  quoted: boolean;
}

/** `.x` on a vector, `.r` on a colour. */
export interface Member extends NodeBase {
  kind: "member";
  object: Expr;
  name: string;
  nameSpan: Span;
}

export interface Call extends NodeBase {
  kind: "call";
  callee: string;
  calleeSpan: Span;
  args: Expr[];
}

export interface Unary extends NodeBase {
  kind: "unary";
  op: "-" | "!";
  operand: Expr;
  opSpan: Span;
}

export type BinaryOp =
  | "+" | "-" | "*" | "/" | "%" | "^"
  | "<" | ">" | "<=" | ">=" | "==" | "!="
  | "&&" | "||";

export interface Binary extends NodeBase {
  kind: "binary";
  op: BinaryOp;
  left: Expr;
  right: Expr;
  opSpan: Span;
}

export interface Conditional extends NodeBase {
  kind: "conditional";
  test: Expr;
  consequent: Expr;
  alternate: Expr;
}

/** A node the parser could not build. It keeps the tree TOTAL: the checker can
 *  still walk everything around a typo instead of giving up on the whole line. */
export interface Invalid extends NodeBase {
  kind: "invalid";
}

export type Expr =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | Reference
  | Member
  | Call
  | Unary
  | Binary
  | Conditional
  | Invalid;

/** `#swing = sin(#time) * 20;` */
export interface LocalDecl {
  name: string;
  nameSpan: Span;
  value: Expr;
  span: Span;
}

/**
 * A parsed expression: zero or more local declarations followed by the single
 * expression whose value the field takes. `tokens` rides along so the editor
 * paints from the same scan the parser read.
 */
export interface Program {
  source: string;
  tokens: Token[];
  locals: LocalDecl[];
  result: Expr | null;
  /** Syntax problems only — type problems come from `check`. */
  diagnostics: Diagnostic[];
}
