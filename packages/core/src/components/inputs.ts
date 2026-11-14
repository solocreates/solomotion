import type { MotionDocument, Clip, Expression, Frame, InputDef, InputValue, KeyframeTrack } from "../schema";
import { parseInputToken } from "../schema/inputs";
import { sampleKeyframeTrack } from "../animation/keyframes";
import { clipLookup, frameClipEntries } from "../timeline/frame-index";
import { compFps, frameStepMs } from "../timeline/fps";
import type { ExprContext, ExprInstanceScope } from "../expressions/globals";
import { instanceChainId } from "../expressions/bind";
import type { ExprLayerApi } from "../expressions/layer-api";
import type { ExprValue } from "../expressions/types";
import { inputPath } from "./inputs-fields";

/**
 * COMPONENT INPUTS — THE INSTANCE SCOPE AND THE ONE READER.
 *
 * A comp's inputs (`frame.inputs`) are read IN THE SCOPE OF THE INSTANCE BEING
 * DRAWN. The renderer pushes one `InstanceScope` per instance it recurses
 * through (`instanceScope`), the bake resolves `input:<id>` drivers and
 * `input("Mood")` against it, and every picture cache keys on
 * `scopeCacheKey` — so two instances of one character say different things
 * without ever sharing a wrong picture, and a hundred instances with equal
 * inputs still share ONE bake and ONE picture per instant.
 *
 * The rules (docs/adr/characters/inputs.md):
 *
 *  - **One clock.** Inputs, triggers and machines run on the instance's OUTER
 *    local time (`outerLocalMs`) — never the inner, looped or sped time. A
 *    trigger keyed at 2 s on the instance fires when the PARENT is at 2 s into
 *    the clip, however the comp inside is being played.
 *  - **Lexical.** The nearest instance whose comp defines the input answers; a
 *    plain precomp inside a component reads its component's inputs. No scope
 *    (the master edited directly) reads the defaults.
 *  - **The key is the VALUES.** `key` is "" when every input sits at its
 *    default; otherwise the non-default values, by id. Identity enters a key
 *    only where it changes the picture: a comp that draws seeded randomness
 *    (`random`, `noise`, `wiggle`, `blink`) is keyed by the instance chain too,
 *    because its seed is (a crowd must not blink in unison).
 */

/** A scope built here: the expression-facing shape plus what the reader needs. */
export interface InstanceScope extends ExprInstanceScope {
  /** The comp whose inputs this scope values (the instance's source/master). */
  readonly frameId: string;
  /** The comp the instance sits in, and that comp's time at this instant. */
  readonly outerCompId: string;
  readonly outerTimeMs: number;
  /** The outer comp's frame step — a trigger fires for one step. */
  readonly stepMs: number;
  readonly values: Record<string, ExprValue>;
  readonly parent: InstanceScope | null;
}

/** Narrow the expression context's scope to one built here. */
export function asInstanceScope(scope: ExprInstanceScope | null | undefined): InstanceScope | null {
  return scope && "frameId" in scope ? (scope as InstanceScope) : null;
}

// ── Definitions ─────────────────────────────────────────────────────────────

const NO_DEFS: readonly InputDef[] = [];

export function inputDefsOf(doc: MotionDocument, frameId: string | null | undefined): readonly InputDef[] {
  if (!frameId) return NO_DEFS;
  return doc.frames.find((f) => f.id === frameId)?.inputs ?? NO_DEFS;
}

/** By id first, then by name (case- and space-insensitive) — how people write `input("Mood")`. */
export function findInputDef(defs: readonly InputDef[], idOrName: string): InputDef | undefined {
  const byId = defs.find((d) => d.id === idOrName);
  if (byId) return byId;
  const wanted = idOrName.trim().toLowerCase();
  return defs.find((d) => d.name.trim().toLowerCase() === wanted);
}

/** A value made to fit its input: clamped, snapped to an option, the right type. */
export function coerceInputValue(def: InputDef, raw: unknown): InputValue {
  switch (def.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "boolean" ? (raw ? 1 : 0) : Number(raw);
      const v = Number.isFinite(n) ? n : typeof def.default === "number" ? def.default : 0;
      return Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, v));
    }
    case "bool":
    case "trigger":
      return typeof raw === "string" ? raw === "true" || raw === "1" : !!raw;
    case "enum": {
      const options = def.options ?? [];
      if (typeof raw === "number" && options.length) return options[Math.max(0, Math.min(options.length - 1, Math.round(raw)))]!;
      const s = typeof raw === "string" ? raw : String(raw ?? "");
      const hit = options.find((o) => o === s) ?? options.find((o) => o.toLowerCase() === s.trim().toLowerCase());
      return hit ?? (typeof def.default === "string" && options.includes(def.default) ? def.default : (options[0] ?? s));
    }
    case "text":
    case "layer":
      return typeof raw === "string" ? raw : raw == null ? "" : String(raw);
    case "color":
      return typeof raw === "string" && raw ? raw : typeof def.default === "string" ? def.default : "#000000";
  }
}

/** The definition's default, coerced (a trigger's is "not firing"). */
export function inputDefault(def: InputDef): InputValue {
  return def.type === "trigger" ? false : coerceInputValue(def, def.default);
}

// ── One channel, sampled ────────────────────────────────────────────────────

/** What carries an instance's channels: a nested clip, or a linked frame (no keys). */
interface InputHost {
  keyframes: readonly KeyframeTrack[];
  inputValues?: Record<string, InputValue> | undefined;
}

function trackOf(host: InputHost, id: string): KeyframeTrack | undefined {
  const path = inputPath(id);
  return host.keyframes.find((t) => t.property === path && !t.range && t.keys.length > 0);
}

/**
 * One input's value on one host at its OUTER local time. Numbers and colours
 * glide between keys; choices, text, flags and layers hold; a TRIGGER is true
 * for exactly the frame step that contains one of its keys (`[t, t + step)`).
 */
export function sampleInputChannel(host: InputHost, def: InputDef, localMs: number, stepMs: number): InputValue {
  const track = trackOf(host, def.id);
  if (def.type === "trigger") {
    if (!track) return false;
    return track.keys.some((k) => k.timeMs >= localMs - 1e-6 && k.timeMs < localMs + stepMs - 1e-6);
  }
  if (track) {
    if (def.type === "number" || def.type === "color") {
      const v = sampleKeyframeTrack(track, localMs);
      if (v !== undefined) return coerceInputValue(def, v);
    } else {
      // Hold: the last key at or before now (the first key before any).
      let held = track.keys[0]!.value;
      for (const k of track.keys) if (k.timeMs <= localMs + 1e-6) held = k.value;
      return coerceInputValue(def, held);
    }
  }
  const override = host.inputValues?.[def.id];
  return override === undefined ? inputDefault(def) : coerceInputValue(def, override);
}

// ── Building a scope ────────────────────────────────────────────────────────

function keyOf(defs: readonly InputDef[], values: Record<string, InputValue>): string {
  let key = "";
  for (const def of defs) {
    const v = values[def.id];
    if (v === undefined || v === inputDefault(def)) continue;
    key += `${def.id}=${typeof v === "string" ? JSON.stringify(v) : String(v)};`;
  }
  return key;
}

function makeScope(
  doc: MotionDocument,
  frame: Frame,
  host: InputHost,
  hostId: string,
  outerCompId: string,
  outerTimeMs: number,
  outerLocalMs: number,
  parent: InstanceScope | null,
): InstanceScope {
  const defs = frame.inputs ?? NO_DEFS;
  const stepMs = frameStepMs(compFps(doc, outerCompId));
  const values: Record<string, InputValue> = {};
  for (const def of defs) values[def.id] = sampleInputChannel(host, def, outerLocalMs, stepMs);
  return { instanceClipId: hostId, frameId: frame.id, outerCompId, outerTimeMs, outerLocalMs, stepMs, values, key: keyOf(defs, values), parent };
}

/**
 * Does drawing this comp through an instance open a scope? A comp with inputs
 * always does; a COMPONENT does even without any, so its seeded randomness is
 * per instance. A plain precomp with no inputs passes its parent's scope on.
 */
export function opensInstanceScope(frame: Frame | undefined): frame is Frame {
  return !!frame && ((frame.inputs?.length ?? 0) > 0 || frame.component != null);
}

/**
 * The scope a NESTED CLIP opens for its source comp, at its own local time in
 * the comp it sits in. `clip` should be the BAKED clip (its `input.<id>`
 * channels may be driven by the outer comp — the voice idiom). Returns
 * `parent` unchanged when the source opens no scope.
 */
export function instanceScope(
  doc: MotionDocument,
  clip: Clip,
  outerLocalMs: number,
  parent: InstanceScope | null,
): InstanceScope | null {
  if (clip.kind !== "nested") return parent;
  const frame = doc.frames.find((f) => f.id === clip.sourceFrameId);
  if (!opensInstanceScope(frame)) return parent;
  return makeScope(doc, frame, clip, clip.id, clip.frameId, clip.startMs + outerLocalMs, outerLocalMs, parent);
}

/**
 * The scope a LINKED INSTANCE FRAME (`instanceOf`) opens for its master. A
 * frame has no keyframe tracks, so its values are static overrides
 * (`frame.inputValues`); its "outer local time" is its own time.
 */
export function frameInstanceScope(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  parent: InstanceScope | null,
): InstanceScope | null {
  const master = frame.instanceOf ? doc.frames.find((f) => f.id === frame.instanceOf) : undefined;
  if (!opensInstanceScope(master)) return parent;
  return makeScope(doc, master, { keyframes: [], inputValues: frame.inputValues }, frame.id, frame.id, timeMs, timeMs, parent);
}

/**
 * The same scope at another instant of its OUTER clock (`atOuterLocalMs`;
 * outer hops move by the same amount, rate 1 — the history rule of
 * `readInput`). What a reader looking BACK needs when it must resolve a layer
 * in an outer comp at that earlier instant (`speaking()` for a machine's
 * fold, a pose set's look-back). With `doc`, every hop's VALUES are re-read
 * at its new instant too, so `input()` answers for then; without, they stay
 * as sampled. The instant is SET, not accumulated, so a fold step lands on
 * the frame grid exactly whatever instant the fold was asked from (a snapped
 * cue edge sits on that grid; a float drift there made scrub direction change
 * the state).
 */
export function scopeAtOuterLocal<S extends ExprInstanceScope | null | undefined>(scope: S, atOuterLocalMs: number, doc?: MotionDocument): S {
  const s = asInstanceScope(scope);
  if (!s || atOuterLocalMs === s.outerLocalMs) return scope;
  const move = (h: InstanceScope | null, local: number): InstanceScope | null => {
    if (!h) return null;
    let values = h.values;
    if (doc) {
      values = {};
      for (const def of inputDefsOf(doc, h.frameId)) values[def.id] = readInput(doc, h, h.frameId, def.id, local) ?? inputDefault(def);
    }
    const d = local - h.outerLocalMs;
    return { ...h, values, outerLocalMs: local, outerTimeMs: h.outerTimeMs - h.outerLocalMs + local, parent: h.parent && move(h.parent, h.parent.outerLocalMs + d) };
  };
  return move(s, atOuterLocalMs) as S;
}

// ── Keys ────────────────────────────────────────────────────────────────────

const SEEDED_CALL = /\b(random|noise|wiggle|blink)\s*\(/;
const seededMemo = new WeakMap<MotionDocument, Map<string, boolean>>();

/**
 * Does anything painted in this comp draw SEEDED randomness? Those seeds mix
 * the instance chain (ADR amendment 10), so such a comp's picture is per
 * instance; everything else is per input values. An `fx:` token anywhere on a
 * clip counts — drivers and bound slots alike. Memoised per document.
 */
export function compDrawsSeeds(doc: MotionDocument, compId: string): boolean {
  if (doc.expressions.length === 0) return false;
  let memo = seededMemo.get(doc);
  if (!memo) seededMemo.set(doc, (memo = new Map()));
  const hit = memo.get(compId);
  if (hit !== undefined) return hit;
  const seeded = new Set(doc.expressions.filter((e: Expression) => SEEDED_CALL.test(e.source)).map((e) => e.id));
  let answer = false;
  if (seeded.size > 0) {
    for (const { clip } of frameClipEntries(doc, compId)) {
      const text = JSON.stringify(clip);
      if (!text.includes("fx:")) continue;
      for (const id of seeded) if (text.includes(`fx:${id}`)) answer = true;
      if (answer) break;
    }
  }
  memo.set(compId, answer);
  return answer;
}

/**
 * THE CACHE TERM for a comp drawn in a scope — the bake key, the comp-picture
 * store and anything else that keeps a scoped picture append exactly this.
 * "" = the picture is the master's own (no scope, or defaults and no seeds).
 */
export function scopeCacheKey(doc: MotionDocument, compId: string, scope: ExprInstanceScope | null | undefined): string {
  if (!scope) return "";
  const seeds = compDrawsSeeds(doc, compId) ? `#${instanceChainId(scope)}` : "";
  return scope.key || seeds ? `${scope.key}${seeds}` : "";
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * THE READER — the value of one input, as the comp `frameId` sees it, through
 * `scope`. Every consumer reads through this: `input:<id>` drivers, the
 * `input()` expression, the machines, the inspector.
 *
 *  - `frameId`: the comp asking (where the expression or machine lives).
 *  - `idOrName`: an input id, or its name (case-insensitive).
 *  - `atOuterLocalMs`: OPTIONAL, on the scope's OUTER clock (`outerLocalMs`).
 *    Omitted = now. A machine folding over history passes earlier instants;
 *    the instance clip's own keys are re-sampled there.
 *
 * The nearest scope whose comp defines the input answers; none = the default
 * of `frameId`'s own definition; no such input = undefined.
 */
export function readInput(
  doc: MotionDocument,
  scope: ExprInstanceScope | null | undefined,
  frameId: string | null | undefined,
  idOrName: string,
  atOuterLocalMs?: number,
): InputValue | undefined {
  for (let s = asInstanceScope(scope); s; s = s.parent) {
    const def = findInputDef(inputDefsOf(doc, s.frameId), idOrName);
    if (!def) continue;
    if (atOuterLocalMs === undefined || Math.abs(atOuterLocalMs - s.outerLocalMs) < 1e-6) {
      const v = s.values[def.id];
      return v === undefined ? inputDefault(def) : (v as InputValue);
    }
    return sampleScopeAt(doc, s, def, atOuterLocalMs);
  }
  const def = findInputDef(inputDefsOf(doc, frameId), idOrName);
  return def ? inputDefault(def) : undefined;
}

/** One input of one scope at another instant of its outer clock. */
function sampleScopeAt(doc: MotionDocument, s: InstanceScope, def: InputDef, atMs: number): InputValue {
  const clip = clipLookup(doc)(s.instanceClipId);
  if (!clip) {
    // A linked frame: static overrides — the same at every instant.
    const frame = doc.frames.find((f) => f.id === s.instanceClipId);
    return sampleInputChannel({ keyframes: [], inputValues: frame?.inputValues }, def, atMs, s.stepMs);
  }
  // Bound to an input of the comp the instance sits in: ask that scope, the
  // same distance away on its own clock (a rate-1 map — see the ADR's gaps).
  const outer = parseInputToken(clip.drivers?.[inputPath(def.id)]);
  if (outer && s.parent) {
    const v = readInput(doc, s.parent, s.outerCompId, outer, s.parent.outerLocalMs + (atMs - s.outerLocalMs));
    if (v !== undefined) return coerceInputValue(def, v);
  }
  return sampleInputChannel(clip, def, atMs, s.stepMs);
}

/**
 * Did a TRIGGER fire in `(fromMs, toMs]` of the scope's outer clock? What a
 * machine's step fold asks (one call per step); a trigger with no scope never
 * fires. Keys sit on the instance clip; a trigger bound to an outer trigger
 * asks the outer scope over the same span.
 */
export function inputFiredBetween(
  doc: MotionDocument,
  scope: ExprInstanceScope | null | undefined,
  idOrName: string,
  fromMs: number,
  toMs: number,
): boolean {
  for (let s = asInstanceScope(scope); s; s = s.parent) {
    const def = findInputDef(inputDefsOf(doc, s.frameId), idOrName);
    if (!def) continue;
    if (def.type !== "trigger") return false;
    const clip = clipLookup(doc)(s.instanceClipId);
    if (!clip) return false;
    const outer = parseInputToken(clip.drivers?.[inputPath(def.id)]);
    if (outer && s.parent) {
      const shift = s.parent.outerLocalMs - s.outerLocalMs;
      return inputFiredBetween(doc, s.parent, outer, fromMs + shift, toMs + shift);
    }
    return trackOf(clip, def.id)?.keys.some((k) => k.timeMs > fromMs + 1e-6 && k.timeMs <= toMs + 1e-6) ?? false;
  }
  return false;
}

// ── Layer inputs: a reference into the OUTER comp ───────────────────────────

/** A layer resolved in the comp where it lives, at that comp's instant. */
export interface ScopedLayerRef {
  clipId: string;
  compId: string | null;
  /** That comp's time at this instant. */
  timeMs: number;
  /** The layer API for that comp at that time (`sourceOf`, `read`…). */
  layers: ExprLayerApi;
}

/**
 * Resolve a layer reference — a name or an id, typically the value of a
 * `layer` input (`lipsync(input("Voice"))`) — in the comp it LIVES in. The
 * current comp first, then each instance's OUTER comp up the scope chain, at
 * that comp's own instant. This is how two instances of one character speak
 * two different lines: each instance's `Voice` input names a clip beside it.
 * Needs the host's `layersIn` on the context; without it only the current comp
 * is searched.
 */
export function resolveScopedLayer(ctx: ExprContext, ref: string): ScopedLayerRef | null {
  if (!ref) return null;
  const find = (layers: ExprLayerApi | undefined) => {
    if (!layers) return undefined;
    if (layers.nameOf(ref) !== undefined) return ref;
    return layers.idFor(ref);
  };
  const here = find(ctx.layers);
  if (here && ctx.layers) return { clipId: here, compId: ctx.compId ?? null, timeMs: ctx.timeMs, layers: ctx.layers };
  for (let s = asInstanceScope(ctx.scope); s; s = s.parent) {
    const layers = ctx.layersIn?.(s.outerCompId, s.outerTimeMs);
    const id = find(layers);
    if (id && layers) return { clipId: id, compId: s.outerCompId, timeMs: s.outerTimeMs, layers };
  }
  return null;
}

// ── Document facts ──────────────────────────────────────────────────────────

const hasInputsMemo = new WeakMap<MotionDocument, boolean>();

/**
 * Does anything in this document read an input? (Bake gate, ADR amendment 3.)
 * A comp with inputs, or any `input:` driver. Memoised per document.
 */
export function documentHasInputs(doc: MotionDocument): boolean {
  let hit = hasInputsMemo.get(doc);
  if (hit === undefined) {
    hit = doc.frames.some((f) => (f.inputs?.length ?? 0) > 0);
    if (!hit) {
      outer: for (const t of doc.tracks) {
        for (const c of t.clips) {
          if (c.drivers && Object.values(c.drivers).some((v) => parseInputToken(v))) {
            hit = true;
            break outer;
          }
        }
      }
    }
    hasInputsMemo.set(doc, hit);
  }
  return hit;
}
