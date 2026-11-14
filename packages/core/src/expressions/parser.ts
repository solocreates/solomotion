import type { BinaryOp, Expr, LocalDecl, Program } from "./ast";
import { significantTokens, tokenize, type Token } from "./lexer";
import type { Diagnostic, Span } from "./types";

/**
 * THE PARSER — tokens → tree, and it never throws.
 *
 * Every failure produces a diagnostic plus an `invalid` node and the walk
 * continues, because this parser runs on EVERY keystroke (debounced) against
 * half-typed source. A parser that bailed on the first problem would blank the
 * editor's highlighting mid-word; one that keeps going can say "you're missing a
 * `)`" while still colouring and type-checking everything around it.
 *
 *   program     := local* expression ";"?
 *   local       := "#" name "=" expression ";"
 *   expression  := conditional
 *   conditional := or ("?" expression ":" conditional)?
 *   or          := and ("||" and)*
 *   and         := equality ("&&" equality)*
 *   equality    := comparison (("==" | "!=") comparison)*
 *   comparison  := additive (("<" | ">" | "<=" | ">=") additive)*
 *   additive    := multiplicative (("+" | "-") multiplicative)*
 *   multiplicative := unary (("*" | "/" | "%") unary)*
 *   unary       := ("-" | "!") unary | power
 *   power       := postfix ("^" unary)?            // right-associative
 *   postfix     := primary ("." name)*
 *   primary     := number | text | true | false | "#"ref | name "(" args ")" | "(" expression ")"
 */

const PRECEDENCE_ORDER: BinaryOp[][] = [
  ["||"],
  ["&&"],
  ["==", "!="],
  ["<", ">", "<=", ">="],
  ["+", "-"],
  ["*", "/", "%"],
];

export function parseExpression(source: string): Program {
  const allTokens = tokenize(source);
  const tokens = significantTokens(allTokens);
  const diagnostics: Diagnostic[] = [];

  // Unreadable characters are reported once, here, then dropped — the grammar
  // below should never have to reason about them.
  const usable: Token[] = [];
  for (const t of tokens) {
    if (t.kind === "error") {
      diagnostics.push({
        message: t.message ?? "Unexpected input.",
        span: { start: t.start, end: t.end },
        severity: "error",
      });
      continue;
    }
    usable.push(t);
  }

  const p = new Parser(usable, source, diagnostics);
  const locals = p.parseLocals();
  const result = p.parseResult();
  p.finish();

  return { source, tokens: allTokens, locals, result, diagnostics };
}

const EOF_SPAN = (source: string): Span => ({ start: source.length, end: source.length });

class Parser {
  private i = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
    private readonly diagnostics: Diagnostic[],
  ) {}

  // ── cursor ────────────────────────────────────────────────────────────────

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }

  private next(): Token | undefined {
    return this.tokens[this.i++];
  }

  private at(kind: Token["kind"], text?: string, offset = 0): boolean {
    const t = this.peek(offset);
    return !!t && t.kind === kind && (text === undefined || t.text === text);
  }

  private eat(kind: Token["kind"], text?: string): Token | undefined {
    if (!this.at(kind, text)) return undefined;
    return this.next();
  }

  private spanHere(): Span {
    const t = this.peek();
    return t ? { start: t.start, end: t.end } : EOF_SPAN(this.source);
  }

  private error(message: string, span = this.spanHere(), fix?: Diagnostic["fix"]): Expr {
    this.diagnostics.push({ message, span, severity: "error", fix });
    return { kind: "invalid", span };
  }

  private expect(kind: Token["kind"], text: string, what: string): boolean {
    if (this.eat(kind, text)) return true;
    this.error(`Expected ${what}.`);
    return false;
  }

  // ── program ───────────────────────────────────────────────────────────────

  /** `#name = expr;` declarations, greedily, while the shape matches. */
  parseLocals(): LocalDecl[] {
    const locals: LocalDecl[] = [];
    while (this.at("ref") && this.at("punct", "=", 1)) {
      const ref = this.next()!;
      this.next(); // "="
      const nameSpan: Span = { start: ref.start, end: ref.end };
      const path = ref.path ?? [];
      const name = path.join(".");
      if (path.length !== 1) {
        this.diagnostics.push({
          message: `“${name}” can’t be defined here — a name you define may not contain a dot.`,
          span: nameSpan,
          severity: "error",
        });
      }
      const value = this.parseExpression();
      const semi = this.eat("punct", ";");
      if (!semi) {
        this.diagnostics.push({
          message: "Add a “;” after a definition.",
          span: { start: value.span.end, end: value.span.end },
          severity: "error",
        });
      }
      locals.push({ name, nameSpan, value, span: { start: ref.start, end: semi?.end ?? value.span.end } });
    }
    return locals;
  }

  parseResult(): Expr | null {
    if (!this.peek()) {
      this.diagnostics.push({
        message: "This expression is empty — end it with the value the field should take.",
        span: EOF_SPAN(this.source),
        severity: "error",
      });
      return null;
    }
    const result = this.parseExpression();
    this.eat("punct", ";");
    return result;
  }

  /** Anything left over is a second expression with nothing joining it. */
  finish(): void {
    const leftover = this.peek();
    if (!leftover) return;
    const last = this.tokens[this.tokens.length - 1]!;
    this.diagnostics.push({
      message: `Unexpected “${leftover.text}” — an expression ends with a single value.`,
      span: { start: leftover.start, end: last.end },
      severity: "error",
    });
    this.i = this.tokens.length;
  }

  // ── expressions ───────────────────────────────────────────────────────────

  parseExpression(): Expr {
    return this.parseConditional();
  }

  private parseConditional(): Expr {
    const test = this.parseBinary(0);
    if (!this.at("operator", "?")) return test;
    this.next();
    const consequent = this.parseExpression();
    this.expect("operator", ":", "“:” to give the other result");
    const alternate = this.parseConditional();
    return {
      kind: "conditional",
      test,
      consequent,
      alternate,
      span: { start: test.span.start, end: alternate.span.end },
    };
  }

  /** One table-driven walk for every left-associative binary level. */
  private parseBinary(level: number): Expr {
    const ops = PRECEDENCE_ORDER[level];
    if (!ops) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== "operator" || !ops.includes(t.text as BinaryOp)) return left;
      this.next();
      const right = this.parseBinary(level + 1);
      left = {
        kind: "binary",
        op: t.text as BinaryOp,
        left,
        right,
        opSpan: { start: t.start, end: t.end },
        span: { start: left.span.start, end: right.span.end },
      };
    }
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t && t.kind === "operator" && (t.text === "-" || t.text === "!")) {
      this.next();
      const operand = this.parseUnary();
      return {
        kind: "unary",
        op: t.text,
        operand,
        opSpan: { start: t.start, end: t.end },
        span: { start: t.start, end: operand.span.end },
      };
    }
    return this.parsePower();
  }

  private parsePower(): Expr {
    const base = this.parsePostfix();
    const t = this.peek();
    if (!t || t.kind !== "operator" || t.text !== "^") return base;
    this.next();
    // Right-associative, and the exponent may be signed (`2 ^ -1`).
    const right = this.parseUnary();
    return {
      kind: "binary",
      op: "^",
      left: base,
      right,
      opSpan: { start: t.start, end: t.end },
      span: { start: base.span.start, end: right.span.end },
    };
  }

  private parsePostfix(): Expr {
    let object = this.parsePrimary();
    while (this.at("punct", ".")) {
      this.next();
      const name = this.peek();
      if (!name || name.kind !== "ident") {
        this.error("Expected a field name after “.” (for example .x or .r).");
        return object;
      }
      this.next();
      object = {
        kind: "member",
        object,
        name: name.text,
        nameSpan: { start: name.start, end: name.end },
        span: { start: object.span.start, end: name.end },
      };
    }
    return object;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (!t) return this.error("Expected a value.");
    const span: Span = { start: t.start, end: t.end };

    switch (t.kind) {
      case "number":
        this.next();
        return { kind: "number", value: t.value as number, span };
      case "string":
        this.next();
        return { kind: "string", value: t.value as string, span };
      case "boolean":
        this.next();
        return { kind: "boolean", value: t.value as boolean, span };
      case "ref":
        this.next();
        return { kind: "ref", path: t.path ?? [], quoted: t.quoted === true, span };
      case "ident": {
        this.next();
        if (!this.at("punct", "(")) {
          // The single most common mistake, and the sigil makes it diagnosable:
          // a bare word can only ever have been a call, so it is either a typo'd
          // function or a reference missing its `#`.
          return this.error(
            `“${t.text}” isn’t a function. To use a value by name, write #${t.text}.`,
            span,
            { label: `Change to #${t.text}`, replacement: `#${t.text}`, span },
          );
        }
        this.next(); // "("
        const args: Expr[] = [];
        if (!this.at("punct", ")")) {
          for (;;) {
            args.push(this.parseExpression());
            if (this.eat("punct", ",")) continue;
            break;
          }
        }
        const close = this.eat("punct", ")");
        if (!close) this.error(`Missing “)” to close ${t.text}(.`);
        return {
          kind: "call",
          callee: t.text,
          calleeSpan: span,
          args,
          span: { start: t.start, end: close ? close.end : (args[args.length - 1]?.span.end ?? t.end) },
        };
      }
      case "punct":
        if (t.text === "(") {
          this.next();
          const inner = this.parseExpression();
          const close = this.eat("punct", ")");
          if (!close) this.error("Missing “)”.");
          return close ? { ...inner, span: { start: t.start, end: close.end } } : inner;
        }
        break;
    }

    this.next();
    return this.error(`Unexpected “${t.text}”.`, span);
  }
}
