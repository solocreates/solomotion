import { DEFAULT_FPS } from "../timeline/fps";
import type { Program } from "./ast";
import { checkProgram, type CheckEnv, type CheckResult } from "./check";
import { evaluateProgram, evaluateProgramAs, type EvalScope } from "./eval";
import type { ExprContext, ExprInstanceScope, ExprLayer } from "./globals";
import { parseExpression } from "./parser";
import type { ExprType, ExprValue } from "./types";

/**
 * THE BINDING SEAM — everything between "a slot holds `fx:<id>`" and "here is
 * the value", with the compiler cached and the host's facts made ambient.
 *
 * Ambient, not threaded, and deliberately so: this is the pattern the document
 * already uses for keyframed variables (`setVariableClock`) and node drivers
 * (`DriverEnv`). The renderer sets the context once per draw and restores it,
 * and every resolver underneath — colours, typography, property paths — reads
 * the same clock and the same layer without a single new parameter threaded
 * through the pipeline. That is what lets expressions land on EVERY field
 * instead of the handful whose call sites we were willing to change.
 */

// ── Compilation cache ────────────────────────────────────────────────────────
//
// Parsing is cheap, but a driven field parses once per frame per slot, and the
// same source is usually shared across a whole document. Keyed by source text,
// so an edit is a new key and a stale tree is impossible.

const CACHE_LIMIT = 256;
const cache = new Map<string, Program>();

/** Parse (and cache) an expression's source. Never throws. */
export function compileExpression(source: string): Program {
  const hit = cache.get(source);
  if (hit) return hit;
  const program = parseExpression(source);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(source, program);
  return program;
}

/** Parse + type-check in one call — what the editor runs on every debounce. */
export function analyzeExpression(source: string, env: CheckEnv): { program: Program; check: CheckResult } {
  const program = compileExpression(source);
  return { program, check: checkProgram(program, env) };
}

// ── Ambient host context ─────────────────────────────────────────────────────

const NEUTRAL_CONTEXT: ExprContext = {
  timeMs: 0,
  fps: DEFAULT_FPS,
  comp: null,
  layer: null,
  playing: false,
  seed: 0,
};

let ambient: ExprContext | null = null;

/** Set the facts `#globals` read. Pass null to clear (static contexts read a
 *  neutral context: time 0, no layer, no composition). */
export function setExpressionContext(ctx: ExprContext | null): void {
  ambient = ctx;
}

/** The ambient context, or a neutral one. Never null, so no resolver has to
 *  branch on "is expression support switched on". */
export function getExpressionContext(): ExprContext {
  return ambient ?? NEUTRAL_CONTEXT;
}

/** The raw ambient context — null when none is set. A host saves this before a
 *  nested draw and restores it after, so an inner comp cannot leak its own
 *  geometry back onto the layers the outer one still has to paint. */
export function peekExpressionContext(): ExprContext | null {
  return ambient;
}

/**
 * Run `fn` with a whole context in scope, then restore the previous one. The
 * save/restore pair is the point: a nested comp, a board preview and an
 * inspector all evaluate against their own facts while something else may be
 * mid-draw, and every one of them used to hand-roll this.
 */
export function withExpressionContext<T>(ctx: ExprContext | null, fn: () => T): T {
  const previous = ambient;
  ambient = ctx;
  try {
    return fn();
  } finally {
    ambient = previous;
  }
}

/**
 * Run `fn` with `#value` reading `read` — the driven field's own value (keys
 * or base) — in the ambient context. Every place a driver resolves a FIELD
 * wraps the resolve in this; nowhere else has a field to read.
 */
export function withFieldValue<T>(read: () => ExprValue | undefined, fn: () => T, fieldPath?: string): T {
  return withExpressionContext({ ...getExpressionContext(), fieldValue: read, ...(fieldPath ? { fieldPath } : {}) }, fn);
}

/**
 * Run `fn` with the layer facts of one clip in scope, then restore. The
 * renderer wraps each layer's draw in this, which is the only reason
 * `#layer.time` and friends can mean something different per layer while the
 * rest of the context stays shared.
 */
export function withExpressionLayer<T>(layer: ExprLayer | null, fn: () => T): T {
  const previous = ambient;
  ambient = { ...getExpressionContext(), layer };
  try {
    return fn();
  } finally {
    ambient = previous;
  }
}

// ── Seeds ────────────────────────────────────────────────────────────────────

/**
 * A stable seed for one expression. Derived from its id, so `random()` and
 * `wiggle()` give the same answer on every frame, every reload and every
 * machine — while two different fields still wobble independently.
 */
export function seedFor(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * The INSTANCE CHAIN as one string ("" outside any instance) — mixed into an
 * expression's seed so a crowd of one character does not blink, wiggle or
 * roll its dice in unison (ADR-characters amendment 10). Memoised per scope.
 */
const chainMemo = new WeakMap<ExprInstanceScope, string>();
export function instanceChainId(scope: ExprInstanceScope | null | undefined): string {
  if (!scope) return "";
  let id = chainMemo.get(scope);
  if (id === undefined) {
    id = scope.parent ? `${instanceChainId(scope.parent)}/${scope.instanceClipId}` : scope.instanceClipId;
    chainMemo.set(scope, id);
  }
  return id;
}

/** An expression's seed in the current instance: its own, mixed with the chain. */
export function scopedSeedFor(id: string, scope: ExprInstanceScope | null | undefined): number {
  const chain = instanceChainId(scope);
  return seedFor(chain ? `${id}@${chain}` : id);
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/** Run one expression's source against a scope, converted into the field's type. */
export function evaluateExpressionSource(
  source: string,
  scope: EvalScope,
  expect: ExprType | null,
): ExprValue | undefined {
  return evaluateProgramAs(compileExpression(source), scope, expect);
}

/** Run one expression's source, keeping the result's own type. */
export function evaluateExpressionRaw(source: string, scope: EvalScope) {
  return evaluateProgram(compileExpression(source), scope);
}
