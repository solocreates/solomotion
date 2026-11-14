import {
  GLOBALS_BY_NAME,
  resolveRef,
  type Diagnostic,
  type ExprType,
  type RefScope,
  type Token,
} from "@solomotion/core";

/**
 * HOW AN EXPRESSION LOOKS — and why it looks that way.
 *
 * Colour here carries meaning, not decoration. Literals, functions and
 * punctuation each get their own hue, but the interesting one is REFERENCES: a
 * `#name` is painted by WHAT IT RESOLVED TO — built-in, document variable, or a
 * local you declared above — so you can see that `#Brand` found your variable
 * without reading the diagnostics strip, and see that `#Brnad` did not.
 *
 * Everything is driven off the lexer's spans and the checker's scope. The editor
 * never re-scans the string, so the colours and the diagnostics are always
 * describing the same parse.
 */

export type PaintKind =
  | "number"
  | "text"
  | "global"
  | "variable"
  | "local"
  | "function"
  | "punct"
  | "comment"
  | "unknown";

export const PAINT_CLASS: Record<PaintKind, string> = {
  number: "text-[var(--syntax-number)]",
  text: "text-[var(--syntax-text)]",
  global: "text-[var(--syntax-global)]",
  variable: "text-[var(--syntax-variable)]",
  local: "text-[var(--syntax-local)]",
  function: "text-[var(--syntax-function)]",
  punct: "text-[var(--syntax-punct)]",
  comment: "italic text-[var(--syntax-comment)]",
  unknown: "text-destructive",
};

/** The one place the editor's two layers agree on metrics. A single character
 *  of drift between the painted text and the textarea shows up as a caret that
 *  sits beside the letter it is meant to be inside, so this is shared, never
 *  restated. */
export const EDITOR_TEXT =
  "font-mono text-[12px] leading-[1.5rem] tracking-normal whitespace-pre-wrap break-words";
export const EDITOR_PADDING = "px-2.5 py-2";

/** How to paint one token, given what the checker's scope knows. */
export function paintKindFor(token: Token, scope: RefScope, isCall: boolean): PaintKind {
  switch (token.kind) {
    case "number":
    case "boolean":
      return "number";
    case "string":
      return "text";
    case "comment":
      return "comment";
    case "error":
      return "unknown";
    case "operator":
    case "punct":
      return "punct";
    case "ident":
      return isCall ? "function" : "unknown";
    case "ref": {
      const resolved = resolveRef(token.path ?? [], scope);
      if (!resolved) return "unknown";
      return resolved.target.source === "global"
        ? "global"
        : resolved.target.source === "variable"
          ? "variable"
          : "local";
    }
  }
}

/** Is this identifier a function call (followed by an opening bracket)? */
export function isCallToken(tokens: Token[], index: number): boolean {
  const next = tokens[index + 1];
  return !!next && next.kind === "punct" && next.text === "(";
}

/**
 * Which diagnostics deserve a squiggle under the text. One that covers the WHOLE
 * expression is a statement about the result, not about a place — underlining
 * every character would say "all of this is wrong" when the answer is usually
 * "add a `* 100`". Those live in the strip alone.
 */
export function squiggleSpans(diagnostics: Diagnostic[], sourceLength: number) {
  return diagnostics.filter(
    (d) => d.severity === "error" && d.span.end > d.span.start && d.span.end - d.span.start < sourceLength,
  );
}

/** A short label for the value a field expects, for the header chip. */
export const TYPE_CHIP: Record<ExprType, string> = {
  float: "number",
  color: "color",
  string: "text",
  bool: "yes/no",
  vec2: "vector",
  layer: "layer",
  track: "tracker",
};

/** Is this global name known? (Used to explain a `#foo` that resolved to nothing.) */
export function isKnownGlobal(name: string): boolean {
  return GLOBALS_BY_NAME.has(name);
}
