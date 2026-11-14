import type { MotionDocument, Clip, Frame, KeyframeTrack, Machine } from "../schema";
import type { ExprInstanceScope } from "../expressions/globals";
import { asInstanceScope, findInputDef, inputDefsOf, inputFiredBetween, readInput, type InstanceScope } from "../components/inputs";
import { inputPath } from "../components/inputs-fields";
import { clipLookup } from "../timeline/frame-index";
import { compFps } from "../timeline/fps";
import { findMachineLayer, machineLayerAt, type MachineInputs, type MachineLayerReading, type MachineScope, type MachineValue } from "./evaluate";

/**
 * A MACHINE'S INPUTS, read through the component-input readers — the bridge
 * from `components/inputs.ts` (`readInput`, `inputFiredBetween`) to the fold.
 * Values are read on the scope's OUTER clock; no scope reads the defaults and
 * fires no trigger (the comp drawn as itself).
 *
 * `divergesFrom` is what lets an edit keep the fold before it: it compares the
 * instance clips that carry the inputs the machine reads, in the old document
 * and the new — identity first (an unrelated edit leaves them shared), then key
 * by key. Bounded by those keys; it never walks the document.
 */
class ScopeInputs implements MachineInputs {
  constructor(
    readonly doc: MotionDocument,
    readonly scope: InstanceScope | null,
    readonly frameId: string,
    readonly speakingAt?: (layer: string, atMs: number) => boolean,
  ) {}

  value(idOrName: string, atMs: number): MachineValue | undefined {
    return readInput(this.doc, this.scope, this.frameId, idOrName, this.scope ? atMs : undefined);
  }

  fired(idOrName: string, fromMs: number, toMs: number): boolean {
    return inputFiredBetween(this.doc, this.scope, idOrName, fromMs, toMs);
  }

  speaking(layer: string, atMs: number): boolean {
    // The voice-per-instance idiom (amendment 9): a condition naming a `layer`
    // INPUT ("Voice") hears the clip that input names beside the instance —
    // not a layer literally called "Voice", which a character never contains.
    const def = findInputDef(inputDefsOf(this.doc, this.frameId), layer);
    const ref = def?.type === "layer" ? String(this.value(def.id, atMs) ?? "") : layer;
    return (!!ref && this.speakingAt?.(ref, atMs)) || false;
  }

  divergesFrom(prev: MachineInputs, refs: readonly string[]): number {
    if (!(prev instanceof ScopeInputs) || prev.frameId !== this.frameId) return -Infinity;
    if (!sameDefs(inputDefsOf(prev.doc, this.frameId), inputDefsOf(this.doc, this.frameId))) return -Infinity;
    let a = this.scope;
    let b = prev.scope;
    const clock = a?.outerLocalMs ?? 0;
    let earliest = Infinity;
    while (a || b) {
      if (!a || !b || a.instanceClipId !== b.instanceClipId || a.frameId !== b.frameId) return -Infinity;
      if (!sameDefs(inputDefsOf(prev.doc, a.frameId), inputDefsOf(this.doc, a.frameId))) return -Infinity;
      const d = hopDivergence(prev.doc, this.doc, a, refs);
      // Into the machine's clock: this hop's clock runs `clock - a.outerLocalMs` behind (rate 1).
      if (d !== Infinity) earliest = Math.min(earliest, d === -Infinity ? d : d + (clock - a.outerLocalMs));
      if (earliest === -Infinity) return earliest;
      a = a.parent;
      b = b.parent;
    }
    return earliest;
  }
}

function sameDefs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function overrideOf(clip: Clip, id: string): unknown {
  return clip.kind === "nested" ? (clip.inputValues?.[id] ?? null) : null;
}

function trackOf(clip: Clip, id: string): KeyframeTrack | undefined {
  const path = inputPath(id);
  return clip.keyframes.find((t) => t.property === path && !t.range);
}

/** The first instant (this hop's clock) the named inputs on one instance can differ between two documents. */
function hopDivergence(before: MotionDocument, after: MotionDocument, s: InstanceScope, refs: readonly string[]): number {
  const x = clipLookup(before)(s.instanceClipId);
  const y = clipLookup(after)(s.instanceClipId);
  if (x === y && x) return Infinity;
  if (!x || !y) {
    // A linked instance frame: static overrides.
    const fx = before.frames.find((f: Frame) => f.id === s.instanceClipId);
    const fy = after.frames.find((f: Frame) => f.id === s.instanceClipId);
    if (fx === fy) return Infinity;
    return JSON.stringify(fx?.inputValues ?? null) === JSON.stringify(fy?.inputValues ?? null) ? Infinity : -Infinity;
  }
  const defs = inputDefsOf(after, s.frameId);
  let earliest = Infinity;
  for (const ref of refs) {
    const def = findInputDef(defs, ref);
    if (!def) continue;
    const path = inputPath(def.id);
    const dx = x.drivers?.[path];
    const dy = y.drivers?.[path];
    if (dx !== dy || ((dx || dy) && x.startMs !== y.startMs)) return -Infinity;
    if (overrideOf(x, def.id) !== overrideOf(y, def.id)) return -Infinity;
    const d = keyDivergence(trackOf(x, def.id), trackOf(y, def.id), def.type === "number" || def.type === "color");
    earliest = Math.min(earliest, d);
  }
  return earliest;
}

/**
 * The first instant two key lists can disagree. Held values differ from the
 * first differing key on; a gliding value from the key BEFORE it (the segment
 * into the edited key bends too).
 */
export function keyDivergence(a: KeyframeTrack | undefined, b: KeyframeTrack | undefined, glides: boolean): number {
  if (a === b) return Infinity;
  const ka = a?.keys ?? [];
  const kb = b?.keys ?? [];
  const n = Math.max(ka.length, kb.length);
  for (let i = 0; i < n; i++) {
    const p = ka[i];
    const q = kb[i];
    if (p && q && p.timeMs === q.timeMs && JSON.stringify(p.value) === JSON.stringify(q.value) && JSON.stringify(p.easing) === JSON.stringify(q.easing)) continue;
    if (glides) return i === 0 ? -Infinity : ka[i - 1]!.timeMs;
    return Math.min(p?.timeMs ?? Infinity, q?.timeMs ?? Infinity);
  }
  return Infinity;
}

/** The machine inputs of one scope — what the fold reads. */
export function scopeMachineInputs(
  doc: MotionDocument,
  scope: ExprInstanceScope | null | undefined,
  frameId: string,
  speakingAt?: (layer: string, atMs: number) => boolean,
): MachineInputs {
  return new ScopeInputs(doc, asInstanceScope(scope), frameId, speakingAt);
}

/** Where a machine of `frameId` folds, drawn through `scope`: memo identity + clock. */
export function machineScopeOf(
  doc: MotionDocument,
  frameId: string,
  scope: ExprInstanceScope | null | undefined,
  generation?: string,
): MachineScope {
  return { doc, frameId, instanceId: scope?.instanceClipId ?? "", fps: compFps(doc, frameId), ...(generation ? { generation } : {}) };
}

/** The machine clock at an instant: the instance's outer local time, else the comp's own. */
export function machineClockMs(scope: ExprInstanceScope | null | undefined, compTimeMs: number): number {
  return scope ? scope.outerLocalMs : compTimeMs;
}

/**
 * THE DOCUMENT-SHAPED READ — one machine layer of comp `frameId`, drawn through
 * `scope`, at comp time `timeMs`. What the host behind `state()` calls, and what
 * the board and the verbs read.
 */
export function readMachineState(
  doc: MotionDocument,
  frameId: string,
  scope: ExprInstanceScope | null | undefined,
  timeMs: number,
  machine: string,
  layer?: string,
  options: { speakingAt?: (layer: string, atMs: number) => boolean; generation?: string } = {},
): MachineLayerReading | null {
  const frame = doc.frames.find((f) => f.id === frameId);
  const hit = findMachineLayer(frame?.machines, machine, layer);
  if (!hit) return null;
  return machineLayerAt(
    machineScopeOf(doc, frameId, scope, options.generation),
    hit.machine,
    hit.layerIndex,
    scopeMachineInputs(doc, scope, frameId, options.speakingAt),
    machineClockMs(scope, timeMs),
  );
}

const hasMachines = new WeakMap<MotionDocument, boolean>();
/** Does any comp carry a machine? (The bake gate, ADR amendment 3.) Memoised per document. */
export function documentHasMachines(doc: MotionDocument): boolean {
  let hit = hasMachines.get(doc);
  if (hit === undefined) hasMachines.set(doc, (hit = doc.frames.some((f) => (f.machines?.length ?? 0) > 0)));
  return hit;
}

/** Every machine of a comp. */
export function frameMachines(doc: MotionDocument, frameId: string): readonly Machine[] {
  return doc.frames.find((f) => f.id === frameId)?.machines ?? [];
}
