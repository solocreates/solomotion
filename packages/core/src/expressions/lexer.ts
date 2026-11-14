import type { Span } from "./types";

/**
 * THE LEXER — source text → tokens, each carrying its SPAN.
 *
 * The spans are the point. The editor never re-scans the string to decide what
 * is a number and what is a function: it paints straight from this token list,
 * so what you SEE coloured and what the checker REASONS about can never
 * disagree. Everything is preserved, including comments and unrecognised
 * characters (as `error` tokens), so the painter can walk the list and rebuild
 * the source exactly.
 *
 * The one deliberate lexical choice: **`#` is the sigil for anything with a
 * name** — a built-in global (`#time`), a document variable (`#"Brand Pink"`)
 * or a local you declared (`#swing`). Bare identifiers are therefore always
 * FUNCTIONS, which is why colouring is unambiguous and why `time` on its own
 * can produce the precise error "did you mean `#time`?" instead of a shrug.
 *
 * A `#ref` swallows dots greedily (`#layer.index` is one token). Whether those
 * dots are part of the NAME or a member access is a question about scope, not
 * about text, so it is settled in `resolveRef` — never here.
 */

export type TokenKind =
  | "number"
  | "string"
  | "boolean"
  | "ref"
  | "ident"
  | "operator"
  | "punct"
  | "comment"
  | "error";

export interface Token extends Span {
  kind: TokenKind;
  /** Raw source slice — the painter renders this verbatim. */
  text: string;
  /** Parsed literal value; only on `number` / `string` / `boolean`. */
  value?: number | string | boolean;
  /** `ref` only: the dotted path after `#` (`#layer.index` → `["layer","index"]`). */
  path?: string[];
  /** `ref` only: written in quotes (`#"Brand Pink"`), so it may contain spaces. */
  quoted?: boolean;
  /** `error` only: why this character could not be read. */
  message?: string;
}

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdentStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** Two-character operators, matched before their one-character prefixes. */
const OPERATORS_2 = ["&&", "||", "==", "!=", "<=", ">="];
const OPERATORS_1 = ["+", "-", "*", "/", "%", "^", "!", "<", ">", "?", ":"];
const PUNCT = ["(", ")", ",", ";", ".", "="];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const push = (t: Token) => tokens.push(t);

  while (i < source.length) {
    const start = i;
    const c = source[i]!;

    // Whitespace carries no meaning and no colour — the painter fills the gaps
    // between spans with the raw source, so skipping it loses nothing.
    if (isSpace(c)) {
      i++;
      continue;
    }

    // Comments — `//` to end of line, `/* … */` (unterminated runs to the end,
    // which is what you want while still typing one).
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      push({ kind: "comment", start, end: i, text: source.slice(start, i) });
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i = Math.min(source.length, i + 2);
      push({ kind: "comment", start, end: i, text: source.slice(start, i) });
      continue;
    }

    // Numbers — `12`, `1.5`, `.5`, `2e3`, `1.2e-4`.
    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      i++;
      while (i < source.length && isDigit(source[i]!)) i++;
      if (source[i] === "." && isDigit(source[i + 1] ?? "")) {
        i++;
        while (i < source.length && isDigit(source[i]!)) i++;
      }
      if (source[i] === "e" || source[i] === "E") {
        const save = i;
        i++;
        if (source[i] === "+" || source[i] === "-") i++;
        if (isDigit(source[i] ?? "")) {
          while (i < source.length && isDigit(source[i]!)) i++;
        } else {
          i = save; // a bare `e` isn't an exponent — leave it to the ident rule.
        }
      }
      const text = source.slice(start, i);
      push({ kind: "number", start, end: i, text, value: parseFloat(text) });
      continue;
    }

    // Strings — single or double quoted, with backslash escapes.
    if (c === '"' || c === "'") {
      const { value, end, terminated } = readQuoted(source, i, c);
      i = end;
      const text = source.slice(start, i);
      if (!terminated) {
        push({ kind: "error", start, end: i, text, message: "Unclosed text — add the closing quote." });
      } else {
        push({ kind: "string", start, end: i, text, value });
      }
      continue;
    }

    // References — `#name`, `#a.b.c`, `#"a quoted name"`.
    if (c === "#") {
      i++;
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        const { value, end, terminated } = readQuoted(source, i, quote);
        i = end;
        const text = source.slice(start, i);
        if (!terminated) {
          push({ kind: "error", start, end: i, text, message: "Unclosed variable name — add the closing quote." });
        } else {
          push({ kind: "ref", start, end: i, text, path: [value], quoted: true });
        }
        continue;
      }
      if (!isIdentStart(source[i] ?? "")) {
        push({ kind: "error", start, end: i, text: source.slice(start, i), message: "`#` must be followed by a name." });
        continue;
      }
      const path: string[] = [];
      for (;;) {
        const segStart = i;
        while (i < source.length && isIdentPart(source[i]!)) i++;
        path.push(source.slice(segStart, i));
        // Only continue the dotted path when a NAME follows the dot; a dot
        // followed by anything else belongs to whatever comes next.
        if (source[i] === "." && isIdentStart(source[i + 1] ?? "")) {
          i++;
          continue;
        }
        break;
      }
      push({ kind: "ref", start, end: i, text: source.slice(start, i), path });
      continue;
    }

    // Identifiers — function names, plus the two boolean keywords.
    if (isIdentStart(c)) {
      while (i < source.length && isIdentPart(source[i]!)) i++;
      const text = source.slice(start, i);
      if (text === "true" || text === "false") {
        push({ kind: "boolean", start, end: i, text, value: text === "true" });
      } else {
        push({ kind: "ident", start, end: i, text });
      }
      continue;
    }

    const two = source.slice(i, i + 2);
    if (OPERATORS_2.includes(two)) {
      i += 2;
      push({ kind: "operator", start, end: i, text: two });
      continue;
    }
    if (OPERATORS_1.includes(c)) {
      i++;
      push({ kind: "operator", start, end: i, text: c });
      continue;
    }
    if (PUNCT.includes(c)) {
      i++;
      push({ kind: "punct", start, end: i, text: c });
      continue;
    }

    i++;
    push({ kind: "error", start, end: i, text: c, message: `Unexpected character “${c}”.` });
  }

  return tokens;
}

function readQuoted(
  source: string,
  at: number,
  quote: string,
): { value: string; end: number; terminated: boolean } {
  let i = at + 1;
  let value = "";
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\" && i + 1 < source.length) {
      const esc = source[i + 1]!;
      value += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
      i += 2;
      continue;
    }
    if (ch === quote) return { value, end: i + 1, terminated: true };
    if (ch === "\n") break; // a newline ends the attempt — the quote is missing.
    value += ch;
    i++;
  }
  return { value, end: i, terminated: false };
}

/** Tokens that carry meaning — comments and unreadable characters dropped. */
export function significantTokens(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.kind !== "comment");
}
