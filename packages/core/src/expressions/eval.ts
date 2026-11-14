import { formatHexColor, parseHexColor } from "../animation/properties";
import { identityValue, isVec2 } from "../nodes/sockets";
import type { Expr, Program } from "./ast";
import { FUNCTIONS_BY_NAME } from "./functions";
import type { ExprContext } from "./globals";
import { layerPropertyIndex, type ExprLayerProperty } from "./layer-api";
import { resolveRef, type RefScope } from "./resolve-ref";
import { coerceValue, literalTextType, type ExprType, type ExprValue } from "./types";

/**
 * THE EVALUATOR — a tree and a scope in, one value out. PURE: it reads no
 * document, no clock and no store. Everything it can know arrives in `scope`,
 * exactly like a node's `EvalContext`, which is what lets the same expression
 * run in the renderer, in the export pipeline and in the editor's live preview
 * and give the same answer in all three.
 *
 * Values carry their TYPE as they flow, because a colour and a piece of text are
 * both strings at runtime and converting between them depends on knowing which
 * one you have. The rules used to convert are `nodes/sockets`' — the same ones a
 * wire obeys — so a value crossing a type boundary behaves identically whether it
 * crossed it through a wire or through this.
 */

export interface EvalScope {
  ctx: ExprContext;
  /** A document variable by name (case-insensitive), with its type. */
  readVariable: (name: string) => { id: string; value: ExprValue; type: ExprType } | undefined;
}

export interface EvalResult {
  value: ExprValue;
  type: ExprType;
}

/** A value in flight: what it is, and what kind of thing it is. */
interface Val {
  v: ExprValue;
  t: ExprType;
}

/**
 * Run a program. Returns undefined only when there is nothing to run (an empty
 * or unparseable expression) — every other failure degrades to a neutral value,
 * because a field that flickers to zero is debuggable and a field that throws
 * mid-render is not. `fieldType` is the type of the field the program drives —
 * what `#value` is.
 */
export function evaluateProgram(program: Program, scope: EvalScope, fieldType: ExprType | null = null): EvalResult | undefined {
  if (!program.result) return undefined;
  const locals = new Map<string, Val>();
  const refScope: RefScope = {
    // Only names, for resolution; the values live in `locals` beside them.
    locals: new Map(),
    lookupVariable: (name) => {
      const v = scope.readVariable(name);
      return v ? { id: v.id, name, type: v.type } : undefined;
    },
    // `#layer.<path>` resolves against the layer in scope's own projection — the
    // same list its node card shows.
    layerProperties: layerPropertyScope(scope.ctx),
    fieldType,
  };

  const ev = new Evaluator(scope, refScope, locals);
  for (const decl of program.locals) {
    if (!decl.name) continue;
    const value = ev.eval(decl.value);
    locals.set(decl.name, value);
    refScope.locals.set(decl.name, value.t);
  }
  const result = ev.eval(program.result);
  return { value: result.v, type: result.t };
}

/** Run a program and convert its result into the field's type in one step. */
export function evaluateProgramAs(
  program: Program,
  scope: EvalScope,
  expect: ExprType | null,
): ExprValue | undefined {
  const result = evaluateProgram(program, scope, expect);
  if (!result) return undefined;
  return coerceValue(result.value, result.type, expect);
}

const num = (val: Val): number => {
  const c = coerceValue(val.v, val.t, "float");
  return typeof c === "number" ? c : 0;
};
const bool = (val: Val): boolean => num(val) !== 0;
const vec = (val: Val): { x: number; y: number } => {
  const c = coerceValue(val.v, val.t, "vec2");
  return isVec2(c) ? c : { x: 0, y: 0 };
};

/** How a value reads when it is joined onto text with `+`. */
function asText(val: Val): string {
  if (typeof val.v === "string") return val.v;
  if (typeof val.v === "boolean") return val.v ? "true" : "false";
  if (isVec2(val.v)) return `${val.v.x}, ${val.v.y}`;
  return String(val.v);
}

/** Always-positive remainder — `mod(-1, 3)` is 2. Both the `%` operator and the
 *  `mod()` function use it, because a designer reaching for either is looping
 *  something, and a negative loop position is never the answer. */
function positiveMod(a: number, b: number): number {
  return b === 0 ? 0 : ((a % b) + b) % b;
}

const MEMBER_INDEX: Record<string, number> = { r: 0, g: 1, b: 2, a: 3, x: 0, y: 1 };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The expression type a runtime value has. Text that looks like a colour IS a
 *  colour — the same rule a written literal obeys, so a value read off another
 *  layer types identically to one typed in by hand. */
function runtimeExprType(value: ExprValue): ExprType {
  if (typeof value === "number") return "float";
  if (typeof value === "boolean") return "bool";
  if (isVec2(value)) return "vec2";
  return literalTextType(value);
}

/** A colour value as `[r, g, b, a]`, every channel 0..1 — the same normalisation
 *  the Separate Color node uses, so `.r` and channel maths agree. */
function channels(val: Val): [number, number, number, number] {
  const c = parseHexColor(typeof val.v === "string" ? val.v : "#000000") ?? { r: 0, g: 0, b: 0, a: 1 };
  return [c.r / 255, c.g / 255, c.b / 255, c.a];
}

/** The property surface of the layer in scope, indexed by path. Memoised on the
 *  layer's identity so a field re-evaluating every frame does not re-project. */
function layerPropertyScope(ctx: ExprContext): Map<string, ExprLayerProperty> | undefined {
  const id = ctx.layer?.id;
  if (!id || !ctx.layers) return undefined;
  return layerPropertyIndex(ctx.layers.propertiesOf(id));
}

/** Flatten `a.b.c` into its base and the dotted path read off it — the mirror of
 *  the checker's, so what type-checks is what runs. */
function memberChain(expr: Expr & { kind: "member" }): { object: Expr; path: string } | null {
  const parts: string[] = [];
  let node: Expr = expr;
  while (node.kind === "member") {
    parts.unshift(node.name);
    node = node.object;
  }
  return parts.length > 0 ? { object: node, path: parts.join(".") } : null;
}

class Evaluator {
  constructor(
    private readonly scope: EvalScope,
    private readonly refScope: RefScope,
    private readonly locals: Map<string, Val>,
  ) {}

  eval(expr: Expr): Val {
    switch (expr.kind) {
      case "invalid":
        return { v: 0, t: "float" };
      case "number":
        return { v: expr.value, t: "float" };
      case "boolean":
        return { v: expr.value, t: "bool" };
      case "string":
        return { v: expr.value, t: literalTextType(expr.value) };
      case "ref":
        return this.evalRef(expr);
      case "member": {
        // A layer's members are its properties — read as ONE dotted path, from
        // the same API the node engine reads (`ctx.layers`), so a wire and a
        // sentence asking for the same value get the same answer.
        const chain = memberChain(expr);
        if (chain) {
          const base = this.eval(chain.object);
          if (base.t === "layer") return this.layerRead(String(base.v), chain.path);
          if (base.t === "track") return this.trackRead(String(base.v), chain.path);
        }
        return this.member(this.eval(expr.object), expr.name);
      }
      case "call":
        return this.evalCall(expr);
      case "unary": {
        const operand = this.eval(expr.operand);
        if (expr.op === "!") return { v: !bool(operand), t: "bool" };
        if (operand.t === "vec2") {
          const v = vec(operand);
          return { v: { x: -v.x, y: -v.y }, t: "vec2" };
        }
        return { v: -num(operand), t: "float" };
      }
      case "binary":
        return this.evalBinary(expr);
      case "conditional":
        return bool(this.eval(expr.test)) ? this.eval(expr.consequent) : this.eval(expr.alternate);
    }
  }

  private evalRef(expr: Expr & { kind: "ref" }): Val {
    const resolved = resolveRef(expr.path, this.refScope);
    if (!resolved) return { v: 0, t: "float" };

    let val: Val;
    switch (resolved.target.source) {
      case "local":
        val = this.locals.get(resolved.target.name) ?? { v: 0, t: resolved.target.type };
        break;
      case "global": {
        const raw = resolved.target.def.read(this.scope.ctx);
        if (resolved.target.def.fieldTyped && raw !== undefined) {
          // `#value` is read AS the field: its declared type when the host knows
          // it, else whatever the field holds (a pose channel holds a name).
          const t = this.refScope.fieldType ?? runtimeExprType(raw);
          val = { v: coerceValue(raw, runtimeExprType(raw), t) ?? identityValue(t), t };
          break;
        }
        val = { v: raw ?? identityValue(resolved.target.type), t: resolved.target.type };
        break;
      }
      case "variable": {
        const read = this.scope.readVariable(resolved.target.name);
        val = { v: read ? read.value : identityValue(resolved.target.type), t: resolved.target.type };
        break;
      }
      case "layerProperty": {
        const id = this.scope.ctx.layer?.id;
        val = id
          ? this.layerRead(id, resolved.target.property.path)
          : { v: identityValue(resolved.target.type), t: resolved.target.type };
        break;
      }
    }

    for (let i = resolved.consumed; i < expr.path.length; i++) val = this.member(val, expr.path[i]!);
    return val;
  }

  /** One layer's property, through the host's layer API — the SAME reader the
   *  node engine uses, so the two surfaces cannot answer differently. */
  private layerRead(clipId: string, path: string): Val {
    const props = this.scope.ctx.layers?.propertiesOf(clipId) ?? [];
    const def = props.find((p) => p.path === path);
    const raw = clipId ? this.scope.ctx.layers?.read(clipId, path) : undefined;
    // No such layer, or no such value on it: the declared type's identity, so a
    // broken read is a neutral number rather than a thrown render.
    if (raw === undefined) return { v: identityValue(def?.type ?? "float"), t: def?.type ?? "float" };
    return { v: raw, t: def?.type ?? runtimeExprType(raw) };
  }

  /** `<tracker>.<reading>[.x]` through the host's tracker API — the one tracking reader. */
  private trackRead(trackerId: string, path: string): Val {
    const [reading, ...rest] = path.split(".");
    const api = this.scope.ctx.tracks;
    const type = api?.readingsOf(trackerId).find((r) => r.id === reading)?.type ?? "float";
    const raw = trackerId && reading ? api?.read(trackerId, reading) : undefined;
    // Nothing to say yet (no bake, footage not on screen): the reading's identity.
    let val: Val = raw === undefined ? { v: identityValue(type), t: type } : { v: raw, t: type };
    for (const m of rest) val = this.member(val, m);
    return val;
  }

  private member(object: Val, name: string): Val {
    const index = MEMBER_INDEX[name];
    if (index === undefined) return { v: 0, t: "float" };
    if (object.t === "vec2") {
      const v = vec(object);
      return { v: name === "x" ? v.x : v.y, t: "float" };
    }
    if (object.t === "color") return { v: channels(object)[index] ?? 0, t: "float" };
    return { v: 0, t: "float" };
  }

  private evalCall(expr: Expr & { kind: "call" }): Val {
    const def = FUNCTIONS_BY_NAME.get(expr.callee);
    if (!def) return { v: 0, t: "float" };
    const args = expr.args.map((a) => this.eval(a));
    // Arguments arrive in the type the signature declares, so implementations
    // never repeat conversion logic. Polymorphic slots (`type: null`) pass through.
    const converted = args.map((arg, i) => {
      const param = def.params[i];
      return param && param.type !== null ? coerceValue(arg.v, arg.t, param.type) : arg.v;
    });
    const declared =
      typeof def.returns === "function" ? def.returns(args.map((a) => a.t)) : def.returns;
    let value: ExprValue;
    try {
      value = def.call(converted, this.scope.ctx, expr.calleeSpan.start);
    } catch {
      value = identityValue(declared ?? "float");
    }
    // A signature that can't name its result type (`layer()`) gets it from the
    // value it produced, so the rest of the walk types it exactly as it would a
    // literal of the same shape.
    return { v: value, t: declared ?? runtimeExprType(value) };
  }

  private evalBinary(expr: Expr & { kind: "binary" }): Val {
    const op = expr.op;

    // Short-circuit before evaluating the right side, so `#a && 1/#a` is safe.
    if (op === "&&") {
      const left = this.eval(expr.left);
      return { v: bool(left) ? bool(this.eval(expr.right)) : false, t: "bool" };
    }
    if (op === "||") {
      const left = this.eval(expr.left);
      return { v: bool(left) ? true : bool(this.eval(expr.right)), t: "bool" };
    }

    const l = this.eval(expr.left);
    const r = this.eval(expr.right);

    switch (op) {
      case "==":
      case "!=": {
        const equal =
          l.t === "string" || r.t === "string"
            ? asText(l) === asText(r)
            : Math.abs(num(l) - num(r)) <= 1e-6;
        return { v: op === "==" ? equal : !equal, t: "bool" };
      }
      case "<":
        return { v: num(l) < num(r), t: "bool" };
      case ">":
        return { v: num(l) > num(r), t: "bool" };
      case "<=":
        return { v: num(l) <= num(r), t: "bool" };
      case ">=":
        return { v: num(l) >= num(r), t: "bool" };
    }

    if (op === "+" && (l.t === "string" || r.t === "string")) {
      return { v: asText(l) + asText(r), t: "string" };
    }

    if (l.t === "vec2" || r.t === "vec2") {
      const a = vec(l);
      const b = vec(r);
      switch (op) {
        case "+":
          return { v: { x: a.x + b.x, y: a.y + b.y }, t: "vec2" };
        case "-":
          return { v: { x: a.x - b.x, y: a.y - b.y }, t: "vec2" };
        case "*": {
          if (l.t === "vec2" && r.t === "vec2") return { v: { x: a.x * b.x, y: a.y * b.y }, t: "vec2" };
          const k = l.t === "vec2" ? num(r) : num(l);
          const v = l.t === "vec2" ? a : b;
          return { v: { x: v.x * k, y: v.y * k }, t: "vec2" };
        }
        case "/": {
          const k = num(r);
          return { v: k === 0 ? { x: 0, y: 0 } : { x: a.x / k, y: a.y / k }, t: "vec2" };
        }
      }
    }

    const arithmetic = (a: number, b: number): number =>
      op === "+" ? a + b
      : op === "-" ? a - b
      : op === "*" ? a * b
      : op === "/" ? (b === 0 ? 0 : a / b)
      : op === "%" ? positiveMod(a, b)
      : Math.pow(a, b);

    // A colour in arithmetic stays a colour and works CHANNEL BY CHANNEL, so
    // `#Brand * 0.5` darkens it and `#A + #B` adds light. Collapsing it to its
    // brightness first (which is what a plain number conversion would do) would
    // turn every such edit grey — technically defensible, visibly wrong.
    if (l.t === "color" || r.t === "color") {
      const ca = l.t === "color" ? channels(l) : null;
      const cb = r.t === "color" ? channels(r) : null;
      const sa = ca ? 0 : num(l);
      const sb = cb ? 0 : num(r);
      const at = (i: number) => arithmetic(ca ? ca[i]! : sa, cb ? cb[i]! : sb);
      const alpha = (ca ?? cb)![3]!;
      return {
        v: formatHexColor({
          r: clamp01(at(0)) * 255,
          g: clamp01(at(1)) * 255,
          b: clamp01(at(2)) * 255,
          a: alpha,
        }),
        t: "color",
      };
    }

    return { v: arithmetic(num(l), num(r)), t: "float" };
  }
}
