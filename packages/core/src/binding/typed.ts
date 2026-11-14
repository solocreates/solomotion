import { compileExpression } from "../expressions/bind";
import { hasErrors, literalTextType, type ExprType } from "../expressions/types";
import { isBound } from "./source";

/**
 * TYPE IT AND IT BECOMES DYNAMIC.
 *
 * The fastest way to bind a field is the one a person reaches for without being
 * taught: click it and write what you mean. `#frame`, `#layer.rotation * 2`,
 * `wiggle(2, 10)` — typed straight into the field, committed, and the field is
 * an expression from that keystroke on. No menu, no panel, no verb to discover.
 *
 * This is the whole decision, in one pure function, so that every control in the
 * app answers it identically: a number scrub, a text box, a colour swatch and
 * anything written next year all call `readTypedValue` on commit and act on the
 * answer. Two inputs disagreeing about whether "#time" is a value or a name is
 * exactly the class of bug this codebase spends its effort not having.
 *
 * The rule, in order:
 *
 *  1. A reference token pasted in (`fx:…`, `var:…`, `expr:…`) means what it says.
 *     People copy these between fields; honouring them costs nothing.
 *  2. A leading `=` is the explicit escape hatch — "this IS an expression",
 *     borrowed from every spreadsheet ever made. It wins over every other rule,
 *     so `="5"` is text and `=5` is an expression that yields five.
 *  3. Otherwise the field's OWN literal wins: a number field parses a number
 *     first, a colour field takes `#ff8732` as a colour. A literal must never
 *     become an expression by accident — that would break typing.
 *  4. What is left becomes an expression only if it both LOOKS like one and
 *     PARSES. Semantics are deliberately not checked here: `#Sizee * 2` binds
 *     and shows its error on the field, which tells the person what is wrong.
 *     Silently dropping it back to a literal would tell them nothing.
 */
export type TypedValue =
  /** Not dynamic — the control should parse this its own way, as it always has. */
  | { kind: "literal" }
  /** Bind this expression source (already stripped of any `=`). */
  | { kind: "expression"; source: string }
  /** A reference token, pasted in whole — bind it as-is. */
  | { kind: "token"; token: string };

const LITERAL: TypedValue = { kind: "literal" };

export function readTypedValue(text: string, expect: ExprType | null = null): TypedValue {
  const trimmed = text.trim();
  if (trimmed === "") return LITERAL;
  if (isBound(trimmed)) return { kind: "token", token: trimmed };

  if (trimmed.startsWith("=")) {
    const source = trimmed.slice(1).trim();
    return source === "" ? LITERAL : { kind: "expression", source };
  }

  if (isLiteralFor(trimmed, expect)) return LITERAL;
  if (!looksDynamic(trimmed)) return LITERAL;
  return hasErrors(compileExpression(trimmed).diagnostics) ? LITERAL : { kind: "expression", source: trimmed };
}

/**
 * Would this text already be a perfectly good value in a field of this type?
 * Numbers and colours are the two that could otherwise be misread — `-5` is not
 * a subtraction and `#ff8732` is not a global called `ff8732`.
 *
 * `null` (an untyped slot) is treated as text, the safest reading: an untyped
 * field only goes dynamic when the person says so with `=` or a `#`.
 */
function isLiteralFor(text: string, expect: ExprType | null): boolean {
  if (expect === "float" || expect === "bool") return Number.isFinite(Number(text.replace(/,/g, ".")));
  if (expect === "color") return literalTextType(text) === "color";
  return false;
}

/**
 * Does this text carry a mark of the language? Requiring one keeps a fat-fingered
 * "12px" or a stray word out of the expression system — it stays what it always
 * was, a literal the control rejects on its own terms.
 *
 * The marks: a global or a layer read (`#…`), a function call, or an operator
 * between two things. The leading character is skipped when scanning for an
 * operator so that a lone sign (`-5`, `+3`) reads as the number it is.
 */
function looksDynamic(text: string): boolean {
  if (text.includes("#")) return true;
  if (/[A-Za-z_][\w.]*\s*\(/.test(text)) return true;
  return /[+\-*/%]|[<>=!]=|>|<|&&|\|\||\?|\blet\b/.test(text.slice(1));
}
