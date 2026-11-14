import { MACHINE_ANY, MACHINE_EXIT, type Machine, type MachineCondition, type MachineLayer, type MachineOp, type MachineOutput } from "../schema/machines";

/**
 * THE MACHINE EVALUATOR — a deterministic fold over frame steps.
 *
 * The clock is the instance's OUTER local time (`scope.outerLocalMs`) — the one
 * clock inputs and triggers run on — or the comp's own time when it is drawn as
 * itself. Step k is the instant k·Δ (Δ = 1000/fps of the comp). At step 0
 * every layer stands in its entry state; at each step it carries the previous
 * step's state, then takes transitions until none fires (Any State first, then
 * the state's own, each in list order). Inputs are sampled AT the step; a
 * trigger keyed in (t(k-1), t(k)] fires at step k — so a key exactly on a step
 * fires on that step, and never before its own time — and moves each layer at
 * most once.
 *
 * Exact on a timeline:
 *  - Reading t means "everything up to t has happened": it folds from step 0.
 *    Scrubbing backward, playing, exporting out of order and a cold read of one
 *    frame all land on the same state.
 *  - Every step's result is kept in typed arrays. A read behind the fold's
 *    front is a lookup; a read ahead extends it.
 *  - The memo is the raw document's identity + comp + machine + instance + step
 *    (the physics rule). After an edit, the new document ADOPTS the last fold
 *    and cuts it back to the first instant its inputs can differ
 *    (`MachineInputs.divergesFrom`, bounded by the keys of the inputs the
 *    machine reads — never a scan of the document). A key moved at t keeps
 *    every step before t; moving or renaming a state card keeps them all.
 *  - A chain of instant transitions never enters a state twice in one step: a
 *    loop A→B→A stops at the last new state and is flagged (`cut`) — the same
 *    way on every run.
 */

export type MachineValue = number | boolean | string;

/**
 * What a machine reads, in ONE scope (an instance of the comp, or the comp at
 * its defaults), on the machine clock. Injected: core's `scopeMachineInputs`
 * builds it over the component-input readers; tests build their own.
 */
export interface MachineInputs {
  /** An input's value at an instant; undefined = no such input (its conditions never hold). */
  value(idOrName: string, atMs: number): MachineValue | undefined;
  /** Did a trigger fire in (fromMs, toMs]? */
  fired(idOrName: string, fromMs: number, toMs: number): boolean;
  /** Is a voice layer speaking at an instant? Absent = silent. */
  speaking?(layer: string, atMs: number): boolean;
  /**
   * The earliest instant at which these histories can differ from `prev` (the
   * same scope read in an older document), for the inputs named in `refs`.
   * Infinity = identical. Absent = anywhere (a full re-fold — always correct).
   */
  divergesFrom?(prev: MachineInputs, refs: readonly string[]): number;
}

/** Where a fold lives — its memo identity. */
export interface MachineScope {
  /** The RAW document; its identity keys the memo. */
  doc: object;
  /** The comp the machine belongs to. */
  frameId: string;
  /** The instance clip the comp is drawn through; "" = drawn as itself. */
  instanceId: string;
  /** The comp's frame rate — the step grid. */
  fps: number;
  /** Anything else the histories depend on that the document does not hold (speech arrival). */
  generation?: string;
}

/** A layer's state at one instant. */
export interface MachineLayerReading {
  layerId: string;
  layerName: string;
  /** The state id; `exit` once the layer ended; null for a layer with no states. */
  stateId: string | null;
  /** "" for no state, "Exit" once ended. */
  stateName: string;
  output: MachineOutput;
  /** When the layer entered this state (a step instant on the machine clock). */
  enteredAtMs: number;
  timeInStateMs: number;
  /** The state it came from, when a transition brought it here. */
  from: { id: string; name: string } | null;
  /** The transition that entered this state, with its blend progress 0..1. */
  transition: { id: string; durationMs: number; progress: number } | null;
  /** True when an instant loop was cut on the step this state was reached. */
  cut: boolean;
}

export interface MachineReading {
  machineId: string;
  machineName: string;
  step: number;
  layers: MachineLayerReading[];
}

const NONE_OUTPUT: MachineOutput = { kind: "none" };
const EPS = 1e-6;

// ── Comparison ───────────────────────────────────────────────────────────────

/** Float tolerance for `==` — a keyed 0.3 equals 0.1 + 0.2. Relative above 1. */
function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

function asNumber(v: MachineValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

/** THE comparison a condition makes. Numbers (and bools, as 0/1) with a tolerance; text exactly. */
export function compareValues(a: MachineValue, op: MachineOp, b: MachineValue): boolean {
  const x = asNumber(a);
  const y = asNumber(b);
  if (x !== null && y !== null) {
    const eq = nearlyEqual(x, y);
    switch (op) {
      case "==": return eq;
      case "!=": return !eq;
      case "<": return x < y && !eq;
      case "<=": return x < y || eq;
      case ">": return x > y && !eq;
      case ">=": return x > y || eq;
    }
  }
  const s = String(a);
  const t = String(b);
  switch (op) {
    case "==": return s === t;
    case "!=": return s !== t;
    case "<": return s < t;
    case "<=": return s <= t;
    case ">": return s > t;
    case ">=": return s >= t;
  }
}

// ── Compilation ──────────────────────────────────────────────────────────────

type Cond =
  | { kind: "input"; ref: string; slot: number; op: MachineOp; value: MachineValue }
  | { kind: "trigger"; ref: string; slot: number }
  | { kind: "speaking"; ref: string; slot: number; is: boolean }
  | { kind: "time"; op: MachineOp; ms: number };

interface Trans {
  index: number;
  to: number;
  conds: Cond[];
  exitTime: number | undefined;
  triggers: number[];
}

interface CompiledLayer {
  /** Index of the Exit pseudo-state (= states.length). */
  exit: number;
  entry: number;
  any: Trans[];
  own: Trans[][];
}

interface Compiled {
  signature: string;
  /** Distinct value/trigger/speaking reads — one sample slot each per step. */
  slots: number;
  /** Input names/ids the machine reads (for `divergesFrom`). */
  inputRefs: string[];
  usesSpeaking: boolean;
  layers: CompiledLayer[];
}

/** What the FOLD depends on — not names, outputs or board positions. */
function logicSignature(m: Machine): string {
  return JSON.stringify(
    m.layers.map((l) => [l.entry, l.states.map((s) => s.id), l.transitions.map((t) => [t.from, t.to, t.conditions, t.exitTime ?? null])]),
  );
}

function compile(m: Machine): Compiled {
  const slotOf = new Map<string, number>();
  const slot = (key: string) => {
    let i = slotOf.get(key);
    if (i === undefined) slotOf.set(key, (i = slotOf.size));
    return i;
  };
  const refs = new Set<string>();
  let usesSpeaking = false;
  const cond = (c: MachineCondition): Cond => {
    switch (c.kind) {
      case "input":
        refs.add(c.input);
        return { kind: "input", ref: c.input, slot: slot(`v:${c.input}`), op: c.op, value: c.value };
      case "trigger":
        refs.add(c.input);
        return { kind: "trigger", ref: c.input, slot: slot(`t:${c.input}`) };
      case "speaking":
        usesSpeaking = true;
        return { kind: "speaking", ref: c.layer, slot: slot(`s:${c.layer}`), is: c.is };
      case "time":
        return { kind: "time", op: c.op, ms: c.ms };
    }
  };
  const layers = m.layers.map((layer: MachineLayer): CompiledLayer => {
    const idx = new Map(layer.states.map((s, i) => [s.id, i]));
    const exit = layer.states.length;
    const any: Trans[] = [];
    const own: Trans[][] = layer.states.map(() => []);
    layer.transitions.forEach((t, index) => {
      const to = t.to === MACHINE_EXIT ? exit : idx.get(t.to);
      if (to === undefined) return; // dangling: reported by `machineIssues`, never fires
      const conds = t.conditions.map(cond);
      const tr: Trans = { index, to, conds, exitTime: t.exitTime, triggers: conds.flatMap((c) => (c.kind === "trigger" ? [c.slot] : [])) };
      if (t.from === MACHINE_ANY) any.push(tr);
      else {
        const from = idx.get(t.from);
        if (from !== undefined) own[from]!.push(tr);
      }
    });
    const entry = layer.states.length === 0 ? -1 : (idx.get(layer.entry) ?? 0);
    return { exit, entry, any, own };
  });
  return { signature: logicSignature(m), slots: slotOf.size, inputRefs: [...refs], usesSpeaking, layers };
}

const compiledOf = new WeakMap<Machine, Compiled>();
function compiled(m: Machine): Compiled {
  let c = compiledOf.get(m);
  if (!c) compiledOf.set(m, (c = compile(m)));
  return c;
}

// ── The fold ─────────────────────────────────────────────────────────────────

/** One layer's history: per step, where it stands. Grown by doubling. */
class LayerRun {
  cur = new Int32Array(64);
  entered = new Int32Array(64);
  from = new Int32Array(64);
  via = new Int32Array(64);
  cut = new Uint8Array(64);

  ensure(n: number) {
    if (n <= this.cur.length) return;
    let cap = this.cur.length;
    while (cap < n) cap *= 2;
    const i32 = (a: Int32Array) => {
      const b = new Int32Array(cap);
      b.set(a);
      return b;
    };
    this.cur = i32(this.cur);
    this.entered = i32(this.entered);
    this.from = i32(this.from);
    this.via = i32(this.via);
    const c = new Uint8Array(cap);
    c.set(this.cut);
    this.cut = c;
  }
}

interface Run {
  compiled: Compiled;
  fps: number;
  generation: string;
  inputs: MachineInputs;
  layers: LayerRun[];
  /** Steps [0, length) are folded and valid. */
  length: number;
}

const LATEST_LIMIT = 128;
/** THE memo: per raw document (identity), per comp|machine|instance. */
let runsByDoc = new WeakMap<object, Map<string, Run>>();
/** The newest fold per comp|machine|instance, whatever document — what an edit adopts. */
const latest = new Map<string, { run: Run; doc: object }>();

/** Memo counters — what tests (and a perf HUD) read to see what a read cost. */
export const machineMemoStats = { stepsFolded: 0, refolds: 0, runsCreated: 0 };

/** Drop every fold and zero the counters (tests). */
export function resetMachineMemo(): void {
  latest.clear();
  runsByDoc = new WeakMap();
  machineMemoStats.stepsFolded = 0;
  machineMemoStats.refolds = 0;
  machineMemoStats.runsCreated = 0;
}

const stepMsOf = (fps: number) => 1000 / fps;
const rateOf = (fps: number) => (fps > 0 && Number.isFinite(fps) ? fps : 30);

/** The step an instant falls in. The tolerance keeps 1000 ms at 30 fps in step 30, not 29. */
export function machineStepOf(timeMs: number, fps: number): number {
  if (!(timeMs > 0)) return 0;
  return Math.floor((timeMs * rateOf(fps)) / 1000 + EPS);
}

function runFor(scope: MachineScope, machine: Machine, inputs: MachineInputs): Run {
  const fps = rateOf(scope.fps);
  const generation = scope.generation ?? "";
  const key = `${scope.frameId}|${machine.id}|${scope.instanceId}`;
  const c = compiled(machine);
  let perDoc = runsByDoc.get(scope.doc);
  if (!perDoc) runsByDoc.set(scope.doc, (perDoc = new Map()));
  let run = perDoc.get(key);
  const fits = (r: Run) => r.fps === fps && r.generation === generation && r.compiled.signature === c.signature;
  if (run && fits(run)) {
    run.compiled = c; // same logic; names and outputs may have changed
    run.inputs = inputs;
    return run;
  }
  const prev = latest.get(key);
  if (prev && prev.doc !== scope.doc && fits(prev.run)) {
    // An edit: keep every step before the first instant the inputs can differ.
    run = prev.run;
    runsByDoc.get(prev.doc)?.delete(key);
    const from = c.usesSpeaking ? -Infinity : (inputs.divergesFrom?.(run.inputs, c.inputRefs) ?? -Infinity);
    const keep = from === Infinity ? run.length : Math.min(run.length, machineStepOf(from, fps));
    if (keep < run.length) {
      machineMemoStats.refolds++;
      run.length = keep;
    }
    run.compiled = c;
    run.inputs = inputs;
  } else {
    machineMemoStats.runsCreated++;
    run = { compiled: c, fps, generation, inputs, layers: c.layers.map(() => new LayerRun()), length: 0 };
  }
  perDoc.set(key, run);
  latest.delete(key);
  latest.set(key, { run, doc: scope.doc });
  if (latest.size > LATEST_LIMIT) {
    const oldest = latest.keys().next().value;
    if (oldest !== undefined) latest.delete(oldest);
  }
  return run;
}

/** Fold steps [run.length, upTo] — every layer, in order. */
function extend(run: Run, upTo: number): void {
  if (upTo < run.length) return;
  const stepMs = stepMsOf(run.fps);
  const { layers, slots } = run.compiled;
  const inputs = run.inputs;
  const n = upTo + 1;
  for (const lr of run.layers) lr.ensure(n);
  // One sample per slot per step, shared by every layer and hop.
  const sampled: Array<MachineValue | undefined> = new Array(slots);
  const stamp = new Int32Array(slots).fill(-1);
  const consumed = new Int32Array(slots).fill(-1);
  let visited = new Int32Array(16);

  for (let k = run.length; k < n; k++) {
    const tk = k * stepMs;
    const read = (c: Exclude<Cond, { kind: "time" }>): MachineValue | undefined => {
      if (stamp[c.slot] !== k) {
        stamp[c.slot] = k;
        sampled[c.slot] =
          c.kind === "input" ? inputs.value(c.ref, tk)
          : c.kind === "trigger" ? inputs.fired(c.ref, tk - stepMs, tk)
          : (inputs.speaking?.(c.ref, tk) ?? false);
      }
      return sampled[c.slot];
    };
    for (let li = 0; li < layers.length; li++) {
      const cl = layers[li]!;
      const lr = run.layers[li]!;
      let cur = k === 0 ? cl.entry : lr.cur[k - 1]!;
      let entered = k === 0 ? 0 : lr.entered[k - 1]!;
      let from = k === 0 ? -1 : lr.from[k - 1]!;
      let via = k === 0 ? -1 : lr.via[k - 1]!;
      let cut = 0;
      if (cur >= 0) {
        if (visited.length < cl.exit + 2) visited = new Int32Array(cl.exit + 2);
        let nVisited = 0;
        visited[nVisited++] = cur;
        const mark = k * 4096 + li; // a trigger moves each layer once per step
        const holds = (t: Trans, inState: number): boolean => {
          if (t.exitTime !== undefined && inState + EPS < t.exitTime) return false;
          for (const c of t.conds) {
            if (c.kind === "time") {
              if (!compareValues(inState, c.op, c.ms)) return false;
            } else if (c.kind === "trigger") {
              if (consumed[c.slot] === mark || read(c) !== true) return false;
            } else if (c.kind === "speaking") {
              if ((read(c) === true) !== c.is) return false;
            } else {
              const v = read(c);
              if (v === undefined || !compareValues(v, c.op, c.value)) return false;
            }
          }
          return true;
        };
        for (;;) {
          const inState = (k - entered) * stepMs;
          let fire: Trans | null = null;
          for (const t of cl.any) {
            if (t.to !== cur && holds(t, inState)) {
              fire = t;
              break;
            }
          }
          if (!fire && cur !== cl.exit) {
            for (const t of cl.own[cur]!) {
              if (holds(t, inState)) {
                fire = t;
                break;
              }
            }
          }
          if (!fire) break;
          let seen = false;
          for (let v = 0; v < nVisited; v++) if (visited[v] === fire.to) seen = true;
          if (seen) {
            cut = 1;
            break;
          }
          for (const s of fire.triggers) consumed[s] = mark;
          from = cur;
          cur = fire.to;
          entered = k;
          via = fire.index;
          visited[nVisited++] = cur;
        }
      }
      lr.cur[k] = cur;
      lr.entered[k] = entered;
      lr.from[k] = from;
      lr.via[k] = via;
      lr.cut[k] = cut;
    }
    machineMemoStats.stepsFolded++;
  }
  run.length = n;
}

function layerReading(run: Run, machine: Machine, li: number, k: number, timeMs: number): MachineLayerReading {
  const stepMs = stepMsOf(run.fps);
  const cl = run.compiled.layers[li]!;
  const lr = run.layers[li]!;
  const layer = machine.layers[li]!;
  const cur = lr.cur[k]!;
  const enteredAtMs = lr.entered[k]! * stepMs;
  const timeInStateMs = Math.max(0, timeMs - enteredAtMs);
  if (cur < 0) {
    return { layerId: layer.id, layerName: layer.name, stateId: null, stateName: "", output: NONE_OUTPUT, enteredAtMs: 0, timeInStateMs, from: null, transition: null, cut: false };
  }
  const exit = cur === cl.exit;
  const state = exit ? undefined : layer.states[cur];
  const fromIdx = lr.from[k]!;
  const fromState = fromIdx < 0 ? null : fromIdx === cl.exit ? { id: MACHINE_EXIT, name: "Exit" } : (layer.states[fromIdx] ?? null);
  const via = lr.via[k]!;
  const t = via >= 0 ? layer.transitions[via] : undefined;
  return {
    layerId: layer.id,
    layerName: layer.name,
    stateId: exit ? MACHINE_EXIT : (state?.id ?? null),
    stateName: exit ? "Exit" : (state?.name ?? ""),
    output: state?.output ?? NONE_OUTPUT,
    enteredAtMs,
    timeInStateMs,
    from: fromState ? { id: fromState.id, name: fromState.name } : null,
    transition: t ? { id: t.id, durationMs: t.durationMs, progress: t.durationMs > 0 ? Math.min(1, timeInStateMs / t.durationMs) : 1 } : null,
    cut: lr.cut[k] === 1,
  };
}

/** THE READ — a machine's state in every layer at an instant of its clock. */
export function machineAt(scope: MachineScope, machine: Machine, inputs: MachineInputs, timeMs: number): MachineReading {
  const run = runFor(scope, machine, inputs);
  const k = machineStepOf(timeMs, run.fps);
  extend(run, k);
  return {
    machineId: machine.id,
    machineName: machine.name,
    step: k,
    layers: machine.layers.map((_, li) => layerReading(run, machine, li, k, Math.max(0, timeMs))),
  };
}

/** One layer's reading (what `state()` asks — no allocation for the other layers). */
export function machineLayerAt(scope: MachineScope, machine: Machine, layerIndex: number, inputs: MachineInputs, timeMs: number): MachineLayerReading | null {
  if (!machine.layers[layerIndex]) return null;
  const run = runFor(scope, machine, inputs);
  const k = machineStepOf(timeMs, run.fps);
  extend(run, k);
  return layerReading(run, machine, layerIndex, k, Math.max(0, timeMs));
}

export interface MachineSegment {
  stateId: string | null;
  stateName: string;
  startMs: number;
  /** Exclusive. */
  endMs: number;
  /** The transition that entered it (null = entry, or carried in from before the range). */
  via: string | null;
  /** An instant loop was cut while in it. */
  cut?: true;
}

/**
 * THE STATE TIMELINE over a range — per layer, the runs of one state. The
 * cheapest way to check a machine's logic: one call answers "what does it do
 * over these ten seconds?". A state re-entered (a self-loop) starts a new segment.
 */
export function machineTimeline(
  scope: MachineScope,
  machine: Machine,
  inputs: MachineInputs,
  fromMs: number,
  toMs: number,
): Array<{ layerId: string; layerName: string; segments: MachineSegment[] }> {
  const run = runFor(scope, machine, inputs);
  const stepMs = stepMsOf(run.fps);
  const a = machineStepOf(Math.max(0, fromMs), run.fps);
  const b = Math.max(a, machineStepOf(Math.max(0, toMs), run.fps));
  extend(run, b);
  return machine.layers.map((layer, li) => {
    const cl = run.compiled.layers[li]!;
    const lr = run.layers[li]!;
    const segments: MachineSegment[] = [];
    const named = (cur: number) =>
      cur < 0 ? { id: null, name: "" } : cur === cl.exit ? { id: MACHINE_EXIT, name: "Exit" } : { id: layer.states[cur]?.id ?? null, name: layer.states[cur]?.name ?? "" };
    for (let k = a; k <= b; k++) {
      const last = segments[segments.length - 1];
      const fresh = !last || lr.cur[k] !== lr.cur[k - 1] || lr.entered[k] !== lr.entered[k - 1];
      if (!fresh) {
        last.endMs = (k + 1) * stepMs;
        if (lr.cut[k]) last.cut = true;
        continue;
      }
      const n = named(lr.cur[k]!);
      const via = lr.entered[k] === k && lr.via[k]! >= 0 ? (layer.transitions[lr.via[k]!]?.id ?? null) : null;
      segments.push({ stateId: n.id, stateName: n.name, startMs: k * stepMs, endMs: (k + 1) * stepMs, via, ...(lr.cut[k] ? { cut: true as const } : {}) });
    }
    if (segments.length) {
      segments[0]!.startMs = Math.max(segments[0]!.startMs, Math.max(0, fromMs));
      const end = segments[segments.length - 1]!;
      end.endMs = Math.max(end.startMs, Math.min(end.endMs, toMs));
    }
    return { layerId: layer.id, layerName: layer.name, segments };
  });
}

/**
 * What is wrong with a machine, in words an agent can act on: a condition on
 * an input that does not exist, a transition to a state that does not, an
 * entry that names nothing.
 */
export function machineIssues(machine: Machine, inputs?: MachineInputs): string[] {
  const out: string[] = [];
  for (const layer of machine.layers) {
    const ids = new Set(layer.states.map((s) => s.id));
    const name = (id: string) => layer.states.find((s) => s.id === id)?.name ?? id;
    if (layer.states.length && !ids.has(layer.entry)) out.push(`Layer "${layer.name}": entry names no state — it starts in "${layer.states[0]!.name}".`);
    for (const t of layer.transitions) {
      const label = `${t.from === MACHINE_ANY ? "Any state" : name(t.from)} → ${t.to === MACHINE_EXIT ? "Exit" : name(t.to)}`;
      if (t.from !== MACHINE_ANY && !ids.has(t.from)) out.push(`Layer "${layer.name}": transition ${t.id} starts at a state that does not exist (${t.from}).`);
      if (t.to !== MACHINE_EXIT && !ids.has(t.to)) out.push(`Layer "${layer.name}": transition ${t.id} goes to a state that does not exist (${t.to}).`);
      if (!inputs) continue;
      for (const c of t.conditions) {
        if ((c.kind === "input" || c.kind === "trigger") && inputs.value(c.input, 0) === undefined) {
          out.push(`Layer "${layer.name}": ${label} reads input "${c.input}", which does not exist — it never fires.`);
        }
      }
    }
  }
  return out;
}

/** Find a machine by id or name (case-insensitive), and a layer in it by id or name (default: the first). */
export function findMachineLayer(
  machines: readonly Machine[] | undefined,
  machine: string,
  layer?: string,
): { machine: Machine; layerIndex: number } | null {
  if (!machines?.length) return null;
  const want = machine.trim().toLowerCase();
  const m = machines.find((x) => x.id === machine) ?? machines.find((x) => x.name.trim().toLowerCase() === want);
  if (!m) return null;
  if (!layer) return m.layers.length ? { machine: m, layerIndex: 0 } : null;
  const wl = layer.trim().toLowerCase();
  const i = m.layers.findIndex((l) => l.id === layer || l.name.trim().toLowerCase() === wl);
  return i >= 0 ? { machine: m, layerIndex: i } : null;
}
