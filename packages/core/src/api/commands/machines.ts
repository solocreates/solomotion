import { z } from "zod";
import {
  MACHINE_ANY,
  MACHINE_EXIT,
  machineConditionSchema,
  machineOutputSchema,
  type MotionDocument,
  type Frame,
  type Machine,
  type MachineLayer,
  type MachineOutput,
} from "../../schema";
import { createId } from "../../ids";
import { poseSetRef } from "../../machines/code";
import { ApiError, defineCommand } from "../command";
import { requireClip, resolveTargetFrame } from "../lookup";
import { frameDurationMs } from "../../timeline/ops";
import { instanceScope } from "../../components/inputs";
import { findMachineLayer, machineAt, machineIssues, machineTimeline } from "../../machines/evaluate";
import { machineScopeOf, scopeMachineInputs } from "../../machines/inputs";
import { machineHost } from "../../evaluate/expr-context";
import {
  addMachine,
  addState,
  addTransition,
  describeCondition,
  newMachineLayer,
  normalizeCondition,
  removeMachine,
  removeStates,
  removeTransitions,
  renameState,
  resolveStateRef,
} from "../../machines/ops";

/**
 * STATE MACHINES, FOR AGENTS — the verbs behind the machine board
 * (docs/adr/characters/machines.md). A comp's machine picks a state from its
 * inputs; `state("Machine")` reads it in any expression (drive a pose set's
 * `pose.<set>` with it). Exact per frame — `machine.inspect` returns the state
 * timeline over a range, the cheapest check of the logic.
 */

const conditionInput = machineConditionSchema.describe(
  'One test. {kind:"input", input:"Mood", op:"==", value:"Happy"} · {kind:"trigger", input:"Wave"} · {kind:"speaking", layer:"Voice"} · {kind:"time", op:">=", ms:2000} (time in state). Inputs by name or id.',
);

const stateInput = z.object({
  name: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  output: machineOutputSchema.optional().describe('What it shows: {kind:"pose", set: <pose set name or id>, pose: <pose name>} or {kind:"none"}'),
});

const transitionInput = z.object({
  from: z.string().describe('A state name, or "any" (Any state)'),
  to: z.string().describe('A state name, or "exit"'),
  when: z.array(conditionInput).default([]).describe("ALL must hold; none = fires at once (or at exitTime)"),
  durationMs: z.number().min(0).optional().describe("Blend time into the next state"),
  exitTime: z.number().min(0).optional().describe("Fire only once the state has run this long, ms"),
});

const layerInput = z.object({
  name: z.string().optional(),
  entry: z.string().optional().describe("The state it starts in (default: the first)"),
  states: z.array(stateInput).default([]),
  transitions: z.array(transitionInput).default([]),
});

function frameIn(d: MotionDocument, id: string): Frame {
  return d.frames.find((f) => f.id === id)!;
}

function requireMachine(frame: Frame, ref: string): Machine {
  const m = findMachineLayer(frame.machines, ref)?.machine ?? frame.machines?.find((x) => x.id === ref || x.name.toLowerCase() === ref.trim().toLowerCase());
  if (!m) throw new ApiError(`"${frame.name}" has no machine "${ref}".`, `Its machines: ${(frame.machines ?? []).map((x) => x.name).join(", ") || "none"} — machine.create makes one.`);
  return m;
}

function requireLayer(m: Machine, ref?: string): MachineLayer {
  if (!ref) {
    if (!m.layers[0]) m.layers.push(newMachineLayer());
    return m.layers[0]!;
  }
  const want = ref.trim().toLowerCase();
  const l = m.layers.find((x) => x.id === ref || x.name.trim().toLowerCase() === want);
  if (!l) throw new ApiError(`Machine "${m.name}" has no layer "${ref}".`, `Its layers: ${m.layers.map((x) => x.name).join(", ")}.`);
  return l;
}

function stateRef(layer: MachineLayer, ref: string, allow: { any?: boolean; exit?: boolean }): string {
  const id = resolveStateRef(layer, ref, allow);
  if (!id) throw new ApiError(`Layer "${layer.name}" has no state "${ref}".`, `Its states: ${layer.states.map((s) => s.name).join(", ") || "none"}${allow.any ? ', or "any"' : ""}${allow.exit ? ', or "exit"' : ""}.`);
  return id;
}

/** Lay out states without a place in a loose grid, the way a person would start. */
function placeOf(i: number): { x: number; y: number } {
  return { x: 260 + (i % 4) * 240, y: 80 + Math.floor(i / 4) * 140 };
}

/** Build one layer from a spec, keeping ids of states that keep their names (the board stays put). */
/** A pose output names its set by id or name; stored by id. */
function resolveOutput(doc: MotionDocument, frame: Frame, o: MachineOutput | undefined): MachineOutput | undefined {
  if (!o || o.kind !== "pose") return o;
  const set = poseSetRef(doc, frame.id, o.set);
  if (!set) throw new ApiError(`No pose set "${o.set}" in "${frame.name}".`, "Name a pose set on one of its groups — poses.inspect lists them.");
  return { ...o, set: set.id };
}

function buildLayer(doc: MotionDocument, frame: Frame, spec: z.output<typeof layerInput>, prev: MachineLayer | undefined, index: number): MachineLayer {
  const layer: MachineLayer = { id: prev?.id ?? createId("mlay"), name: spec.name?.trim() || prev?.name || `Layer ${index + 1}`, entry: "", states: [], transitions: [] };
  spec.states.forEach((s, i) => {
    const old = prev?.states.find((x) => x.name.trim().toLowerCase() === s.name.trim().toLowerCase());
    const at = s.x !== undefined && s.y !== undefined ? { x: s.x, y: s.y } : old ? { x: old.x, y: old.y } : placeOf(i);
    const st = addState(layer, { name: s.name, ...at, output: resolveOutput(doc, frame, s.output) ?? old?.output });
    if (old) st.id = old.id;
  });
  layer.entry = spec.entry ? stateRef(layer, spec.entry, {}) : (layer.states[0]?.id ?? "");
  for (const t of spec.transitions) {
    addTransition(layer, {
      from: stateRef(layer, t.from, { any: true }),
      to: stateRef(layer, t.to, { exit: true }),
      conditions: t.when.map((c) => normalizeCondition(frame, c)),
      durationMs: t.durationMs,
      exitTime: t.exitTime,
    });
  }
  return layer;
}

/** A machine as an agent reads it: names, not ids, and conditions in words. */
function describeMachine(frame: Frame, m: Machine) {
  return {
    id: m.id,
    name: m.name,
    layers: m.layers.map((l) => {
      const nameOf = (id: string) => (id === MACHINE_ANY ? "Any state" : id === MACHINE_EXIT ? "Exit" : (l.states.find((s) => s.id === id)?.name ?? `?${id}`));
      return {
        id: l.id,
        name: l.name,
        entry: l.entry ? nameOf(l.entry) : null,
        states: l.states.map((s) => ({ id: s.id, name: s.name, ...(s.output.kind !== "none" ? { output: s.output } : {}) })),
        transitions: l.transitions.map((t) => ({
          id: t.id,
          from: nameOf(t.from),
          to: nameOf(t.to),
          when: t.conditions.map((c) => describeCondition(frame, c)),
          ...(t.durationMs ? { durationMs: t.durationMs } : {}),
          ...(t.exitTime !== undefined ? { exitTime: t.exitTime } : {}),
        })),
      };
    }),
  };
}

/** The scope a read runs in: an instance of the comp (by id or name), or the comp at its defaults. */
function scopeFor(doc: MotionDocument, frame: Frame, instance: string | undefined, atMs: number) {
  if (!instance) return null;
  const clip = requireClip(doc, instance).clip;
  if (clip.kind !== "nested" || clip.sourceFrameId !== frame.id) throw new ApiError(`"${clip.name}" is not an instance of "${frame.name}".`);
  return instanceScope(doc, clip, atMs, null);
}

export const machineCreate = defineCommand({
  id: "machine.create",
  summary: "Make (or REPLACE, by name) a comp's state machine in one call: layers of states and the transitions between them.",
  details:
    "Rive's model: each layer is in one state at a time; it starts in `entry`; a transition fires when ALL its `when` conditions hold (none = at once), `from: \"any\"` fires from whatever state the layer is in, `to: \"exit\"` ends the layer. Order is priority (Any state first). " +
    "Calling again with the same name replaces it — states that keep their names keep their ids and places, so this is how to EDIT a whole machine. " +
    "Read it with state(\"Name\") in an expression (e.g. a pose set's pose.<set> driver). Check the logic with machine.inspect.",
  effect: "write",
  input: z.object({
    frameId: z.string().optional(),
    name: z.string().default("Machine"),
    layers: z.array(layerInput).default([{ states: [], transitions: [] }]),
  }),
  run(input, rt) {
    const target = resolveTargetFrame(rt, input.frameId);
    let id = "";
    rt.write(`Machine ${input.name}`, (d) => {
      const frame = frameIn(d, target.id);
      const prev = frame.machines?.find((m) => m.name.trim().toLowerCase() === input.name.trim().toLowerCase());
      const machine: Machine = prev ?? addMachine(frame, input.name);
      const layers = input.layers.map((spec, i) => buildLayer(d, frame, spec, prev?.layers.find((l) => l.name === spec.name) ?? prev?.layers[i], i));
      machine.layers = layers;
      id = machine.id;
    });
    const frame = rt.doc().frames.find((f) => f.id === target.id)!;
    const m = frame.machines!.find((x) => x.id === id)!;
    return { ...describeMachine(frame, m), issues: machineIssues(m, scopeMachineInputs(rt.doc(), null, frame.id)) };
  },
});

export const machineState = defineCommand({
  id: "machine.state",
  summary: "Add, change or remove a machine's states — name, board place, what it shows (a pose), which one is the entry.",
  effect: "write",
  input: z.object({
    frameId: z.string().optional(),
    machine: z.string(),
    layer: z.string().optional().describe("Default: the first"),
    add: z.array(stateInput.extend({ entry: z.boolean().optional() })).optional(),
    edit: z.array(stateInput.partial().extend({ state: z.string(), entry: z.boolean().optional() })).optional(),
    remove: z.array(z.string()).optional().describe("State names or ids; their transitions go too"),
  }),
  run(input, rt) {
    const target = resolveTargetFrame(rt, input.frameId);
    rt.write("Machine states", (d) => {
      const frame = frameIn(d, target.id);
      const layer = requireLayer(requireMachine(frame, input.machine), input.layer);
      for (const a of input.add ?? []) {
        const st = addState(layer, { name: a.name, ...(a.x !== undefined && a.y !== undefined ? { x: a.x, y: a.y } : placeOf(layer.states.length)), output: resolveOutput(d, frame, a.output) });
        if (a.entry) layer.entry = st.id;
      }
      for (const e of input.edit ?? []) {
        const id = stateRef(layer, e.state, {});
        const st = layer.states.find((s) => s.id === id)!;
        if (e.name) renameState(layer, id, e.name);
        if (e.x !== undefined) st.x = e.x;
        if (e.y !== undefined) st.y = e.y;
        if (e.output) st.output = resolveOutput(d, frame, e.output)!;
        if (e.entry) layer.entry = id;
      }
      if (input.remove?.length) removeStates(layer, input.remove.map((r) => stateRef(layer, r, {})));
    });
    const frame = rt.doc().frames.find((f) => f.id === target.id)!;
    return describeMachine(frame, requireMachine(frame, input.machine));
  },
});

export const machineTransition = defineCommand({
  id: "machine.transition",
  summary: "Add, change or remove a machine's transitions — from (a state or \"any\"), to (a state or \"exit\"), when (conditions), blend, exit time.",
  effect: "write",
  input: z.object({
    frameId: z.string().optional(),
    machine: z.string(),
    layer: z.string().optional(),
    add: z.array(transitionInput).optional(),
    edit: z
      .array(
        z.object({
          transition: z.string(),
          from: z.string().optional(),
          to: z.string().optional(),
          when: z.array(conditionInput).optional(),
          durationMs: z.number().min(0).optional(),
          exitTime: z.number().min(0).nullable().optional().describe("null removes it"),
        }),
      )
      .optional(),
    remove: z.array(z.string()).optional().describe("Transition ids"),
  }),
  run(input, rt) {
    const target = resolveTargetFrame(rt, input.frameId);
    rt.write("Machine transitions", (d) => {
      const frame = frameIn(d, target.id);
      const layer = requireLayer(requireMachine(frame, input.machine), input.layer);
      for (const t of input.add ?? []) {
        addTransition(layer, {
          from: stateRef(layer, t.from, { any: true }),
          to: stateRef(layer, t.to, { exit: true }),
          conditions: t.when.map((c) => normalizeCondition(frame, c)),
          durationMs: t.durationMs,
          exitTime: t.exitTime,
        });
      }
      for (const e of input.edit ?? []) {
        const t = layer.transitions.find((x) => x.id === e.transition);
        if (!t) throw new ApiError(`No transition "${e.transition}" in "${layer.name}".`, "machine.inspect lists them with ids.");
        if (e.from) t.from = stateRef(layer, e.from, { any: true });
        if (e.to) t.to = stateRef(layer, e.to, { exit: true });
        if (e.when) t.conditions = e.when.map((c) => normalizeCondition(frame, c));
        if (e.durationMs !== undefined) t.durationMs = e.durationMs;
        if (e.exitTime === null) delete t.exitTime;
        else if (e.exitTime !== undefined) t.exitTime = e.exitTime;
      }
      if (input.remove?.length) removeTransitions(layer, input.remove);
    });
    const frame = rt.doc().frames.find((f) => f.id === target.id)!;
    return describeMachine(frame, requireMachine(frame, input.machine));
  },
});

export const machineRemove = defineCommand({
  id: "machine.remove",
  summary: "Delete a comp's state machine.",
  effect: "write",
  input: z.object({ frameId: z.string().optional(), machine: z.string() }),
  run(input, rt) {
    const target = resolveTargetFrame(rt, input.frameId);
    const id = requireMachine(target, input.machine).id;
    rt.write("Delete machine", (d) => removeMachine(frameIn(d, target.id), id));
    return { removed: id };
  },
});

export const machineInspect = defineCommand({
  id: "machine.inspect",
  summary: "A comp's machines — states, transitions in words, problems — and the STATE TIMELINE over a range: which state each layer is in, when, and which transition took it there.",
  details:
    "The cheapest way to check a machine's logic: key the inputs, then read the timeline instead of rendering. `instance` (an instance clip of this comp, id or name) reads its inputs, with times on that clip's own clock; omitted = the comp at its input defaults (triggers never fire). A segment marked `cut` is an instant loop the guard stopped.",
  effect: "read",
  input: z.object({
    frameId: z.string().optional(),
    machine: z.string().optional(),
    instance: z.string().optional(),
    fromMs: z.number().min(0).default(0),
    toMs: z.number().min(0).optional().describe("Default: the comp's end, at most 60 s"),
  }),
  run(input, rt) {
    const doc = rt.doc();
    const frame = resolveTargetFrame(rt, input.frameId);
    const machines = input.machine ? [requireMachine(frame, input.machine)] : (frame.machines ?? []);
    const toMs = input.toMs ?? Math.min(60_000, frameDurationMs(doc, frame));
    const scope = scopeFor(doc, frame, input.instance, input.fromMs);
    // The bake's own host: `speaking` conditions hear the voice the canvas hears.
    const host = machineHost(doc, input.fromMs, frame.id, scope);
    const inputs = scopeMachineInputs(doc, scope, frame.id, host.speakingAt);
    const round = (n: number) => Math.round(n * 10) / 10;
    return {
      frameId: frame.id,
      inputs: (frame.inputs ?? []).map((i) => ({ id: i.id, name: i.name, type: i.type, default: i.default })),
      machines: machines.map((m) => ({
        ...describeMachine(frame, m),
        issues: machineIssues(m, inputs),
        timeline: machineTimeline(machineScopeOf(doc, frame.id, scope, host.generation), m, inputs, input.fromMs, toMs).map((l) => ({
          layer: l.layerName,
          segments: l.segments.map((s) => ({ state: s.stateName, from: round(s.startMs), to: round(s.endMs), ...(s.via ? { via: s.via } : {}), ...(s.cut ? { cut: true } : {}) })),
        })),
      })),
    };
  },
});

export const machineEvaluate = defineCommand({
  id: "machine.evaluate",
  summary: "Where a machine stands at one instant: each layer's state, time in state, where it came from and the blend in progress.",
  effect: "read",
  input: z.object({ frameId: z.string().optional(), machine: z.string(), atMs: z.number().min(0), instance: z.string().optional() }),
  run(input, rt) {
    const doc = rt.doc();
    const frame = resolveTargetFrame(rt, input.frameId);
    const m = requireMachine(frame, input.machine);
    const scope = scopeFor(doc, frame, input.instance, input.atMs);
    const host = machineHost(doc, input.atMs, frame.id, scope);
    const r = machineAt(machineScopeOf(doc, frame.id, scope, host.generation), m, scopeMachineInputs(doc, scope, frame.id, host.speakingAt), input.atMs);
    return r.layers.map((l) => ({
      layer: l.layerName,
      state: l.stateName,
      timeInStateMs: Math.round(l.timeInStateMs),
      ...(l.from ? { from: l.from.name } : {}),
      ...(l.transition ? { transition: l.transition } : {}),
      ...(l.output.kind !== "none" ? { output: l.output } : {}),
      ...(l.cut ? { cut: true } : {}),
    }));
  },
});

export const MACHINE_COMMANDS = [machineCreate, machineState, machineTransition, machineRemove, machineInspect, machineEvaluate];
