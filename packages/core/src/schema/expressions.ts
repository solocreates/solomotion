import { z } from "zod";

/**
 * EXPRESSIONS — the stored side of the expression language (`../expressions`).
 *
 * A bindable slot may hold `fx:<id>` instead of a literal, exactly the way it
 * may hold `var:<id>` (a variable) or `expr:<id>` (a node graph). Three tokens,
 * one idea: **the slot references something, and the something lives in a
 * document-level table.** That is why expressions need no new plumbing to reach
 * every field — they ride the two seams the other two already ride (a `Bindable`
 * slot's own value, and a clip's `drivers` map keyed by property path).
 *
 * Only the SOURCE is stored. The tree, the types and the diagnostics are all
 * derived, so a saved file can never disagree with the compiler that opens it,
 * and improving the language improves every existing document.
 */

/** The reference token stored in a slot driven by an expression. */
export const FX_TOKEN_PREFIX = "fx:";

/** Matches an `fx:<id>` token. */
export const fxTokenRegex = /^fx:.+/;

export const expressionSchema = z.object({
  id: z.string(),
  /** The source text, exactly as typed. */
  source: z.string(),
  /**
   * An optional label. Expressions are usually private to the field that made
   * one, but the table is shared, so naming one is how it becomes a thing you
   * can recognise and reuse rather than an anonymous row.
   */
  name: z.string().default(""),
});
export type Expression = z.infer<typeof expressionSchema>;

/** Build a token for a slot. */
export function fxToken(id: string): string {
  return `${FX_TOKEN_PREFIX}${id}`;
}

/** The expression id inside a token, or null when the value isn't one. */
export function parseFxToken(value: unknown): string | null {
  return typeof value === "string" && value.startsWith(FX_TOKEN_PREFIX)
    ? value.slice(FX_TOKEN_PREFIX.length)
    : null;
}
