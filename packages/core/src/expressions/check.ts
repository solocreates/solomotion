import type { Expr, Program } from "./ast";
import { arity, FUNCTIONS, FUNCTIONS_BY_NAME, returnTypeOf, signatureOf } from "./functions";
import { GLOBALS, GLOBALS_BY_NAME, globalRequires } from "./globals";
import type { ExprLayerProperty } from "./layer-api";
import { closestName, resolveRef, type RefScope } from "./resolve-ref";
import {
  assignability,
  literalTextType,
  typeLabel,
  unifyTypes,
  type Diagnostic,
  type ExprType,
  type Span,
} from "./types";

/**
 * THE CHECKER — the half of the language a person actually experiences.
 *
 * Its job is not to be right about types (that is easy); it is to say something
 * a motion designer can act on. Every message names the thing that is wrong, in
 * the words the UI uses for it — "number", not "float" — and where a repair is
 * obvious the diagnostic carries it, so the editor can offer one click instead
 * of a lecture. Errors stop the expression from driving anything; warnings let
 * it run and tell you what it will quietly do (a number landing in a colour
 * field becomes grey — better to be told than to wonder).
 *
 * It is also the enforcement point for the language's one hard scoping rule:
 * **you may not redefine a name that already means something.** Shadowing a
 * built-in or a document variable would make two identical expressions behave
 * differently depending on the document, so it is an error, not a shadow.
 */

export interface CheckVariable {
  id: string;
  name: string;
  type: ExprType;
}

export interface CheckEnv {
  /** The document's variables — offered by name, checked for redefinition. */
  variables: CheckVariable[];
  /** The bound field's type; null when nothing constrains the result. */
  expect: ExprType | null;
  /**
   * What the host can actually answer here. An expression on a document-level
   * slot has no layer, so `#layer.width` is not an error in the language but IS
   * a thing worth warning about at this site.
   */
  available?: { layer?: boolean; comp?: boolean };
  /**
   * A named layer's property surface — the same list its node card shows. Lets
   * `layer("Title").rotation` be CHECKED rather than merely permitted: the type
   * comes from the property registry, so reading a colour into a number is an
   * error you see while typing instead of a silent zero at render.
   */
  layerPropertiesByName?: (name: string) => Map<string, ExprLayerProperty> | undefined;
  /** The property surface of the layer this expression is ON, so `#layer.<path>`
   *  checks against what that layer really has. */
  layerProperties?: Map<string, ExprLayerProperty>;
  /**
   * A named tracker's readings and their types (`track("Face").topLeft`) —
   * the same table its Track node's outputs come from. Absent = permitted
   * unchecked.
   */
  trackReadingsByName?: (name: string) => Map<string, ExprType> | undefined;
}

export interface CheckResult {
  /** Syntax problems and type problems together, in source order. */
  diagnostics: Diagnostic[];
  /** The result's inferred type; null when a syntax error swallowed it. */
  type: ExprType | null;
  /** Locals in declaration order — autocomplete offers these below the globals. */
  locals: Array<{ name: string; type: ExprType }>;
}

export function checkProgram(program: Program, env: CheckEnv): CheckResult {
  const diagnostics: Diagnostic[] = [...program.diagnostics];
  const locals = new Map<string, ExprType>();
  const declared: Array<{ name: string; type: ExprType }> = [];

  const byLowerName = new Map<string, CheckVariable>();
  for (const v of env.variables) byLowerName.set(v.name.toLowerCase(), v);

  const scope: RefScope = {
    locals,
    lookupVariable: (name) => byLowerName.get(name.toLowerCase()),
    layerProperties: env.layerProperties,
    fieldType: env.expect,
  };

  const report = (message: string, span: Span, severity: Diagnostic["severity"] = "error", fix?: Diagnostic["fix"]) => {
    diagnostics.push({ message, span, severity, fix });
  };

  const checker = new Checker(scope, env, report);

  // ── locals, in order: each sees the ones above it and nothing below ────────
  for (const local of program.locals) {
    const type = checker.infer(local.value) ?? "float";
    const clash = nameClash(local.name, byLowerName, locals);
    if (clash) {
      report(clash, local.nameSpan);
    } else if (local.name) {
      locals.set(local.name, type);
      declared.push({ name: local.name, type });
    }
  }

  // ── the result, and whether it fits the field ─────────────────────────────
  const type = program.result ? checker.infer(program.result) : null;
  // A layer is a thing you read values OFF, not a value in itself — so ending on
  // one is a mistake with an obvious repair, and saying so beats the generic
  // "gives layer, field holds number".
  if (program.result && type === "layer") {
    report(
      "A layer isn’t a value on its own — read one of its values off it, like .x or .opacity.",
      program.result.span,
    );
  } else if (program.result && type === "track") {
    report("A tracker isn’t a value on its own — read something off it, like .position or .rotation.", program.result.span);
  } else if (program.result && type !== null && env.expect !== null) {
    const fit = assignability(type, env.expect);
    if (fit === "none") {
      report(
        `This gives ${typeLabel(type)}, but the field holds ${typeLabel(env.expect)}.`,
        program.result.span,
      );
    } else if (fit === "convert") {
      report(
        `This gives ${typeLabel(type)}; it will be converted to ${typeLabel(env.expect)} to fit the field.`,
        program.result.span,
        "warning",
      );
    }
  }

  diagnostics.sort((a, b) => a.span.start - b.span.start);
  return { diagnostics, type, locals: declared };
}

/** Why a local name is not allowed, or null when it is free. */
function nameClash(
  name: string,
  variables: Map<string, CheckVariable>,
  locals: Map<string, ExprType>,
): string | null {
  if (!name) return null;
  if (GLOBALS_BY_NAME.has(name)) {
    return `“#${name}” is built in — pick another name for your value.`;
  }
  const variable = variables.get(name.toLowerCase());
  if (variable) {
    return `“${variable.name}” is already a document variable — pick another name, or edit the variable itself.`;
  }
  if (locals.has(name)) {
    return `“#${name}” is already defined further up.`;
  }
  return null;
}

type Report = (message: string, span: Span, severity?: Diagnostic["severity"], fix?: Diagnostic["fix"]) => void;

/** Members a type exposes, and what they give back (all numbers, today). */
const MEMBERS: Partial<Record<ExprType, string[]>> = {
  vec2: ["x", "y"],
  color: ["r", "g", "b", "a"],
};

/** What `.` offers after a value of this type — the checker's own table, so
 *  completion can never suggest a member the checker then rejects. A layer's
 *  members are its properties (`ExprLayerApi.propertiesOf`), not listed here. */
export function exprMembersOf(type: ExprType): readonly string[] {
  return MEMBERS[type] ?? [];
}

/**
 * Flatten `a.b.c` into its base and the dotted path read off it. Returns null
 * for anything that is not a plain chain of member reads.
 */
function memberChain(expr: Expr & { kind: "member" }): { object: Expr; path: string } | null {
  const parts: string[] = [];
  let node: Expr = expr;
  while (node.kind === "member") {
    parts.unshift(node.name);
    node = node.object;
  }
  return parts.length > 0 ? { object: node, path: parts.join(".") } : null;
}

class Checker {
  constructor(
    private readonly scope: RefScope,
    private readonly env: CheckEnv,
    private readonly report: Report,
  ) {}

  /** The type an expression produces, or null when it is unknowable (a syntax
   *  error below it) — null suppresses cascading complaints. */
  infer(expr: Expr): ExprType | null {
    switch (expr.kind) {
      case "invalid":
        return null;
      case "number":
        return "float";
      case "string":
        // Text that looks like a colour IS a colour — the same rule the
        // evaluator applies. Typing them separately is how a checker starts
        // rejecting expressions that run perfectly well.
        return literalTextType(expr.value);
      case "boolean":
        return "bool";
      case "ref":
        return this.inferRef(expr);
      case "member": {
        // A layer's members are its PROPERTIES, and there are hundreds of them
        // with dots in their names (`fill.<id>.color`), so the whole chain has to
        // be read as one path rather than one segment at a time.
        const chain = memberChain(expr);
        if (chain) {
          const base = this.infer(chain.object);
          if (base === "layer") return this.inferLayerProperty(chain.object, chain.path, expr.nameSpan);
          if (base === "track") return this.inferTrackReading(chain.object, chain.path, expr.nameSpan);
        }
        return this.inferMember(this.infer(expr.object), expr.name, expr.nameSpan);
      }
      case "call":
        return this.inferCall(expr);
      case "unary":
        return this.inferUnary(expr);
      case "binary":
        return this.inferBinary(expr);
      case "conditional": {
        const test = this.infer(expr.test);
        if (test === "string") {
          this.report("A test has to be a yes/no value, and this is text.", expr.test.span);
        }
        return unifyTypes(this.infer(expr.consequent), this.infer(expr.alternate));
      }
    }
  }

  private inferRef(expr: Expr & { kind: "ref" }): ExprType | null {
    const resolved = resolveRef(expr.path, this.scope);
    if (!resolved) {
      const written = expr.path.join(".");
      const suggestion = closestName(written, [
        ...GLOBALS.map((g) => g.name),
        ...[...this.scope.locals.keys()],
        ...this.env.variables.map((v) => v.name),
      ]);
      this.report(
        `Nothing is called “#${written}”.${suggestion ? ` Did you mean “#${suggestion}”?` : ""}`,
        expr.span,
        "error",
        suggestion ? { label: `Change to #${suggestion}`, replacement: `#${suggestion}`, span: expr.span } : undefined,
      );
      return null;
    }

    if (resolved.target.source === "global") {
      const needs = globalRequires(resolved.target.def);
      const has = this.env.available;
      if (has && needs === "layer" && has.layer === false) {
        this.report(
          `“#${resolved.target.name}” needs a layer, and this field isn’t on one — it will read 0.`,
          expr.span,
          "warning",
        );
      } else if (has && needs === "comp" && has.comp === false) {
        this.report(
          `“#${resolved.target.name}” needs a composition, and this field isn’t in one — it will read 0.`,
          expr.span,
          "warning",
        );
      }
      // A document variable sharing a built-in's name is legal but confusing.
      if (this.scope.lookupVariable(resolved.target.name)) {
        this.report(
          `“#${resolved.target.name}” is the built-in value here; your variable of the same name is not being read. Rename the variable to use it.`,
          expr.span,
          "warning",
        );
      }
    }

    // Any path segments the name did not consume are member accesses.
    let type: ExprType | null = resolved.target.type;
    for (let i = resolved.consumed; i < expr.path.length; i++) {
      type = this.inferMember(type, expr.path[i]!, expr.span);
    }
    return type;
  }

  /**
   * The type of `<layer>.<path>`. Resolved against that layer's real projection,
   * so what the language accepts and what a socket exposes are the same set by
   * construction — and a path that layer does not have is named as such, with
   * the nearest one it does have.
   */
  private inferLayerProperty(object: Expr, path: string, span: Span): ExprType | null {
    const props = this.layerPropertiesOf(object);
    if (!props) return null; // which layer is unknowable here — permit it
    const found = props.get(path);
    if (found) return found.type;
    const suggestion = closestName(path, [...props.keys()]);
    this.report(
      `That layer has no “${path}”.${suggestion ? ` Did you mean “${suggestion}”?` : ""}`,
      span,
      "error",
      suggestion ? { label: `Change to ${suggestion}`, replacement: suggestion, span } : undefined,
    );
    return null;
  }

  /**
   * The type of `<tracker>.<reading>[.x]`, from that tracker's readings table.
   * An unknown reading is named, with the nearest real one.
   */
  private inferTrackReading(object: Expr, path: string, span: Span): ExprType | null {
    const arg = object.kind === "call" && object.callee === "track" ? object.args[0] : undefined;
    const readings = arg?.kind === "string" ? this.env.trackReadingsByName?.(arg.value) : undefined;
    if (!readings) return null;
    const [head, ...rest] = path.split(".");
    const found = readings.get(head!);
    if (!found) {
      const suggestion = closestName(head!, [...readings.keys()]);
      this.report(
        `A tracker has no “${head}”.${suggestion ? ` Did you mean “${suggestion}”?` : ""}`,
        span,
        "error",
        suggestion ? { label: `Change to ${suggestion}`, replacement: suggestion, span } : undefined,
      );
      return null;
    }
    let type: ExprType | null = found;
    for (const m of rest) type = this.inferMember(type, m, span);
    return type;
  }

  /** Which layer an expression denotes, as a property map — `#layer` is the one
   *  in scope, `layer("Name")` is that one, anything else is unknown. */
  private layerPropertiesOf(object: Expr): Map<string, ExprLayerProperty> | undefined {
    if (object.kind === "ref" && object.path.length === 1 && object.path[0] === "layer") {
      return this.scope.layerProperties;
    }
    if (object.kind === "call" && object.callee === "layer") {
      const arg = object.args[0];
      if (arg?.kind === "string") return this.env.layerPropertiesByName?.(arg.value);
    }
    return undefined;
  }

  private inferMember(objectType: ExprType | null, name: string, span: Span): ExprType | null {
    if (objectType === null) return null;
    if (objectType === "track") return null; // which tracker is unknowable here — permit it
    if (objectType === "layer") {
      // Reached only when we could not tell WHICH layer (a computed name), so
      // the path cannot be checked — but the read itself is fine.
      return null;
    }
    const allowed = MEMBERS[objectType];
    if (!allowed) {
      this.report(`A ${typeLabel(objectType)} has no “.${name}” to read.`, span);
      return null;
    }
    if (!allowed.includes(name)) {
      this.report(
        `A ${typeLabel(objectType)} has no “.${name}” — try ${allowed.map((a) => `.${a}`).join(", ")}.`,
        span,
      );
      return null;
    }
    return "float";
  }

  private inferCall(expr: Expr & { kind: "call" }): ExprType | null {
    const def = FUNCTIONS_BY_NAME.get(expr.callee);
    const argTypes = expr.args.map((a) => this.infer(a));

    if (!def) {
      const suggestion = closestName(expr.callee, FUNCTIONS.map((f) => f.name));
      this.report(
        `There’s no function called “${expr.callee}”.${suggestion ? ` Did you mean “${suggestion}”?` : ""}`,
        expr.calleeSpan,
        "error",
        suggestion
          ? { label: `Change to ${suggestion}`, replacement: suggestion, span: expr.calleeSpan }
          : undefined,
      );
      return null;
    }

    const { min, max } = arity(def);
    if (expr.args.length < min || expr.args.length > max) {
      const want = min === max ? `${min}` : `${min} to ${max}`;
      this.report(
        `${signatureOf(def)} takes ${want} argument${max === 1 ? "" : "s"}, and got ${expr.args.length}.`,
        expr.span,
      );
      return returnTypeOf(def, argTypes);
    }

    expr.args.forEach((arg, i) => {
      const param = def.params[i];
      const got = argTypes[i];
      if (!param || got == null || param.type === null) return;
      // Only IMPOSSIBLE arguments are reported. A number handed to a colour
      // argument is nearly always deliberate, and warning on every one of those
      // would train people to ignore the strip.
      if (assignability(got, param.type) === "none") {
        this.report(
          `${def.name}’s “${param.name}” wants ${typeLabel(param.type)}, and this is ${typeLabel(got)}.`,
          arg.span,
        );
      }
    });

    return returnTypeOf(def, argTypes);
  }

  private inferUnary(expr: Expr & { kind: "unary" }): ExprType | null {
    const operand = this.infer(expr.operand);
    if (expr.op === "!") return "bool";
    if (operand === "string") {
      this.report("Text can’t be negated.", expr.span);
      return null;
    }
    return operand === "vec2" ? "vec2" : "float";
  }

  private inferBinary(expr: Expr & { kind: "binary" }): ExprType | null {
    const left = this.infer(expr.left);
    const right = this.infer(expr.right);
    const op = expr.op;

    if (op === "&&" || op === "||") return "bool";

    if (op === "==" || op === "!=") {
      if ((left === "string") !== (right === "string") && left !== null && right !== null) {
        this.report(`Text and ${typeLabel(left === "string" ? right : left)} are never equal.`, expr.span, "warning");
      }
      return "bool";
    }

    if (op === "<" || op === ">" || op === "<=" || op === ">=") {
      for (const [type, node] of [[left, expr.left], [right, expr.right]] as const) {
        if (type === "string") this.report("Text can’t be compared with < or >.", node.span);
      }
      return "bool";
    }

    // `+` is the one operator that joins text — it is how a counter gets a label.
    if (op === "+" && (left === "string" || right === "string")) return "string";

    if (left === "string" || right === "string") {
      this.report(`Text can’t be used with “${op}”. Only “+” joins text.`, expr.opSpan);
      return null;
    }

    // Vectors ride along with the arithmetic they sensibly support: add and
    // subtract with another vector, scale by a number.
    if (left === "vec2" || right === "vec2") {
      if (op === "+" || op === "-") {
        if (left !== right && left !== null && right !== null) {
          this.report(`A vector and a ${typeLabel(left === "vec2" ? right : left)} can’t be added.`, expr.opSpan);
          return null;
        }
        return "vec2";
      }
      if (op === "*" || op === "/") return "vec2";
      this.report(`Vectors can’t be used with “${op}”.`, expr.opSpan);
      return null;
    }

    // Colour arithmetic stays colour — the evaluator works channel by channel,
    // so `#Brand * 0.5` is a darker brand colour, not a number.
    if (left === "color" || right === "color") return "color";

    if (left === null && right === null) return null;
    return "float";
  }
}
