import { createId } from "../ids";
import {
  MACHINE_ANY,
  MACHINE_EXIT,
  machineConditionSchema,
  type Frame,
  type Machine,
  type MachineCondition,
  type MachineConditionInput,
  type MachineLayer,
  type MachineOutput,
  type MachineState,
  type MachineTransition,
} from "../schema";
import { findInputDef } from "../components/inputs";

/**
 * MACHINE EDITS — pure operations on a frame's machines, shared by the verbs
 * and the board so both make the same document. Each takes a draft (immer) and
 * mutates it; ids are minted here and never reused.
 */

/** A name not yet taken in `taken` — "State", "State 2", "State 3"… */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((n) => n.trim().toLowerCase()));
  if (!set.has(base.trim().toLowerCase())) return base;
  for (let i = 2; ; i++) if (!set.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

export function newMachineLayer(name = "Layer 1"): MachineLayer {
  return { id: createId("mlay"), name, entry: "", states: [], transitions: [] };
}

/** Add a machine to a frame: one empty layer, as Rive starts one. */
export function addMachine(frame: Frame, name = "Machine"): Machine {
  const machine: Machine = { id: createId("mach"), name: uniqueName(name, (frame.machines ?? []).map((m) => m.name)), layers: [newMachineLayer()] };
  (frame.machines ??= []).push(machine);
  return machine;
}

export function removeMachine(frame: Frame, machineId: string): void {
  const next = (frame.machines ?? []).filter((m) => m.id !== machineId);
  frame.machines = next.length ? next : undefined;
}

/** Add a state; the first one a layer gets is its entry. */
export function addState(layer: MachineLayer, spec: { name?: string; x?: number; y?: number; output?: MachineOutput } = {}): MachineState {
  const state: MachineState = {
    id: createId("st"),
    name: uniqueName(spec.name?.trim() || "State", layer.states.map((s) => s.name)),
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    output: spec.output ?? { kind: "none" },
  };
  layer.states.push(state);
  if (!layer.entry || !layer.states.some((s) => s.id === layer.entry)) layer.entry = state.id;
  return state;
}

/** Remove states and every transition that touches them; the entry moves to the first left. */
export function removeStates(layer: MachineLayer, ids: readonly string[]): void {
  const gone = new Set(ids);
  layer.states = layer.states.filter((s) => !gone.has(s.id));
  layer.transitions = layer.transitions.filter((t) => !gone.has(t.from) && !gone.has(t.to));
  if (gone.has(layer.entry) || !layer.states.some((s) => s.id === layer.entry)) layer.entry = layer.states[0]?.id ?? "";
}

export function renameState(layer: MachineLayer, id: string, name: string): void {
  const state = layer.states.find((s) => s.id === id);
  const clean = name.trim();
  if (!state || !clean || clean === state.name) return;
  state.name = uniqueName(clean, layer.states.filter((s) => s.id !== id).map((s) => s.name));
}

/** Duplicate states (offset on the board); transitions between duplicated states come along. */
export function duplicateStates(layer: MachineLayer, ids: readonly string[]): string[] {
  const map = new Map<string, string>();
  for (const id of ids) {
    const s = layer.states.find((x) => x.id === id);
    if (!s) continue;
    const copy = addState(layer, { name: s.name, x: s.x + 32, y: s.y + 32, output: structuredClone(s.output) });
    map.set(s.id, copy.id);
  }
  for (const t of [...layer.transitions]) {
    const from = map.get(t.from);
    const to = map.get(t.to);
    if (from && to) layer.transitions.push({ ...structuredClone(t), id: createId("tr"), from, to });
  }
  return [...map.values()];
}

export function addTransition(
  layer: MachineLayer,
  spec: { from: string; to: string; conditions?: MachineConditionInput[]; durationMs?: number; exitTime?: number },
): MachineTransition {
  const t: MachineTransition = {
    id: createId("tr"),
    from: spec.from,
    to: spec.to,
    conditions: (spec.conditions ?? []).map((c) => machineConditionSchema.parse(c)),
    durationMs: spec.durationMs ?? 0,
    ...(spec.exitTime !== undefined ? { exitTime: spec.exitTime } : {}),
  };
  layer.transitions.push(t);
  return t;
}

export function removeTransitions(layer: MachineLayer, ids: readonly string[]): void {
  const gone = new Set(ids);
  layer.transitions = layer.transitions.filter((t) => !gone.has(t.id));
}

/** A state by id or name (case-insensitive); also `any` / `exit` / `entry` for the pseudo-states. */
export function resolveStateRef(layer: MachineLayer, ref: string, allow: { any?: boolean; exit?: boolean } = {}): string | null {
  const r = ref.trim();
  const low = r.toLowerCase();
  if (allow.any && (low === MACHINE_ANY || low === "any state")) return MACHINE_ANY;
  if (allow.exit && low === MACHINE_EXIT) return MACHINE_EXIT;
  return layer.states.find((s) => s.id === r)?.id ?? layer.states.find((s) => s.name.trim().toLowerCase() === low)?.id ?? null;
}

/** Store an input condition by the input's ID when the comp defines it (a rename then keeps it working). */
export function normalizeCondition(frame: Frame, c: MachineCondition): MachineCondition {
  if (c.kind !== "input" && c.kind !== "trigger") return c;
  const def = findInputDef(frame.inputs ?? [], c.input);
  return def ? { ...c, input: def.id } : c;
}

/** The words a condition reads as on the board and in inspect — `Mood is Happy`, `Wave fires`. */
export function describeCondition(frame: Frame | undefined, c: MachineCondition): string {
  const inputName = (ref: string) => findInputDef(frame?.inputs ?? [], ref)?.name ?? ref;
  switch (c.kind) {
    case "input": {
      if (typeof c.value === "boolean" && (c.op === "==" || c.op === "!=")) {
        const on = c.op === "==" ? c.value : !c.value;
        return on ? inputName(c.input) : `not ${inputName(c.input)}`;
      }
      const op = c.op === "==" ? "is" : c.op === "!=" ? "is not" : c.op;
      return `${inputName(c.input)} ${op} ${String(c.value)}`;
    }
    case "trigger":
      return `${inputName(c.input)} fires`;
    case "speaking":
      return c.is ? "Speaking" : "Silent";
    case "time": {
      const s = c.ms / 1000;
      return `Time in state ${c.op === ">=" ? ">" : c.op} ${Number.isInteger(s) ? s : s.toFixed(2)} s`;
    }
  }
}
