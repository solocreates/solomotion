import { beforeEach, describe, expect, it } from "vitest";
import "../index";
import type { MotionDocument, Clip, Frame, NestedClip } from "../schema";
import { createEmptyDocument, createFrame, createNestedClip, createTrack } from "../factories";
import { writeChannel } from "../animation/channels";
import { makeComponentFromFrame } from "../components";
import { defineInput } from "../components/inputs-ops";
import { inputPath } from "../components/inputs-fields";
import { instanceScope } from "../components/inputs";
import { evaluateExpressionRaw, withExpressionContext } from "../expressions/bind";
import type { ExprContext } from "../expressions/globals";
import { machineAt, machineIssues, machineMemoStats, machineTimeline, resetMachineMemo, type MachineInputs } from "./evaluate";
import { machineScopeOf, readMachineState, scopeMachineInputs } from "./inputs";
import { addMachine, addState, addTransition } from "./ops";

// ── Fixture: a character comp with inputs + a machine, one instance on a scene ──

function scene(fps = 30) {
  const doc = createEmptyDocument();
  const root = doc.frames[0]!;
  root.fps = fps;
  const master = createFrame({ name: "Character", width: 200, height: 200 });
  master.fps = fps;
  doc.frames.push(master);
  makeComponentFromFrame(doc, master.id);
  const happy = defineInput(doc, master.id, { name: "Happy", type: "bool" });
  const level = defineInput(doc, master.id, { name: "Level", type: "number", default: 0 });
  const wave = defineInput(doc, master.id, { name: "Wave", type: "trigger" });
  const inst = { ...createNestedClip({ frameId: root.id, sourceFrameId: master.id, startMs: 0, durationMs: 600_000, x: 0, y: 0 }), name: "Pip" } as NestedClip;
  const t = createTrack("Pip");
  t.clips.push(inst);
  doc.tracks.push(t);
  return { doc, root, master, happy, level, wave, inst };
}

function frameOf(doc: MotionDocument, id: string): Frame {
  return doc.frames.find((f) => f.id === id)!;
}

function clipOf(doc: MotionDocument, id: string): Clip {
  for (const t of doc.tracks) for (const c of t.clips) if (c.id === id) return c;
  throw new Error(id);
}

/** The state at instance-local time t, the way state() reads it. */
function stateAt(doc: MotionDocument, masterId: string, instId: string, t: number, machine = "Mood", layer?: string) {
  const scope = instanceScope(doc, clipOf(doc, instId), t, null);
  return readMachineState(doc, masterId, scope, t, machine, layer)?.stateName;
}

beforeEach(() => resetMachineMemo());

describe("machine evaluator — exact per frame", () => {
  it("reads the same whether scrubbed forward, backward or cold", () => {
    const s = scene();
    const m = addMachine(frameOf(s.doc, s.master.id), "Mood");
    const L = m.layers[0]!;
    const idle = addState(L, { name: "Idle" });
    const joy = addState(L, { name: "Joy" });
    const done = addState(L, { name: "Done" });
    addTransition(L, { from: idle.id, to: joy.id, conditions: [{ kind: "input", input: s.happy.id, op: "==", value: true }] });
    addTransition(L, { from: joy.id, to: done.id, conditions: [{ kind: "time", op: ">=", ms: 500 }] });
    addTransition(L, { from: "any", to: idle.id, conditions: [{ kind: "trigger", input: s.wave.id }] });
    writeChannel(s.inst, inputPath(s.happy.id), 0, false, { forceKey: true });
    writeChannel(s.inst, inputPath(s.happy.id), 400, true, { forceKey: true });
    writeChannel(s.inst, inputPath(s.happy.id), 1200, false, { forceKey: true });
    writeChannel(s.inst, inputPath(s.wave.id), 1500, true, { forceKey: true });
    const times = Array.from({ length: 90 }, (_, i) => i * 33.333333);
    const forward = times.map((t) => stateAt(s.doc, s.master.id, s.inst.id, t));
    resetMachineMemo();
    const backward = [...times].reverse().map((t) => stateAt(s.doc, s.master.id, s.inst.id, t)).reverse();
    resetMachineMemo();
    const cold = times.map((t) => {
      resetMachineMemo();
      return stateAt(s.doc, s.master.id, s.inst.id, t);
    });
    expect(backward).toEqual(forward);
    expect(cold).toEqual(forward);
    expect(forward[0]).toBe("Idle");
    expect(stateAt(s.doc, s.master.id, s.inst.id, 450)).toBe("Joy");
    expect(stateAt(s.doc, s.master.id, s.inst.id, 1000)).toBe("Done");
    // The trigger at 1.5 s sends it back to Idle; Happy is false again so it stays.
    expect(stateAt(s.doc, s.master.id, s.inst.id, 1600)).toBe("Idle");
  });

  it("fires a trigger keyed exactly on a step boundary on that step, never before", () => {
    const s = scene(30);
    const m = addMachine(frameOf(s.doc, s.master.id), "Mood");
    const L = m.layers[0]!;
    const a = addState(L, { name: "Rest" });
    const b = addState(L, { name: "Wave" });
    addTransition(L, { from: a.id, to: b.id, conditions: [{ kind: "trigger", input: s.wave.id }] });
    writeChannel(s.inst, inputPath(s.wave.id), 1000, true, { forceKey: true }); // step 30 at 30 fps
    expect(stateAt(s.doc, s.master.id, s.inst.id, 999)).toBe("Rest");
    expect(stateAt(s.doc, s.master.id, s.inst.id, 1000)).toBe("Wave");
    const r = readMachineState(s.doc, s.master.id, instanceScope(s.doc, s.inst, 1000, null), 1000, "Mood")!;
    expect(r.enteredAtMs).toBeCloseTo(1000, 6);
    // A key between steps fires on the NEXT step (its own time has passed), not the one before.
    resetMachineMemo();
    const s2 = scene(30);
    const m2 = addMachine(frameOf(s2.doc, s2.master.id), "Mood");
    const a2 = addState(m2.layers[0]!, { name: "Rest" });
    const b2 = addState(m2.layers[0]!, { name: "Wave" });
    addTransition(m2.layers[0]!, { from: a2.id, to: b2.id, conditions: [{ kind: "trigger", input: s2.wave.id }] });
    writeChannel(s2.inst, inputPath(s2.wave.id), 1010, true, { forceKey: true });
    expect(stateAt(s2.doc, s2.master.id, s2.inst.id, 1020)).toBe("Rest");
    expect(stateAt(s2.doc, s2.master.id, s2.inst.id, 1034)).toBe("Wave");
  });

  it("a trigger moves a layer once: a toggle on one trigger flips, it does not bounce back", () => {
    const s = scene();
    const m = addMachine(frameOf(s.doc, s.master.id), "Mood");
    const L = m.layers[0]!;
    const off = addState(L, { name: "Off" });
    const on = addState(L, { name: "On" });
    addTransition(L, { from: off.id, to: on.id, conditions: [{ kind: "trigger", input: s.wave.id }] });
    addTransition(L, { from: on.id, to: off.id, conditions: [{ kind: "trigger", input: s.wave.id }] });
    writeChannel(s.inst, inputPath(s.wave.id), 500, true, { forceKey: true });
    writeChannel(s.inst, inputPath(s.wave.id), 1000, true, { forceKey: true });
    expect(stateAt(s.doc, s.master.id, s.inst.id, 600)).toBe("On");
    expect(stateAt(s.doc, s.master.id, s.inst.id, 1100)).toBe("Off");
  });

  it("compares floats with a tolerance: a keyed 0.1 + 0.2 equals 0.3", () => {
    const s = scene();
    const m = addMachine(frameOf(s.doc, s.master.id), "Mood");
    const L = m.layers[0]!;
    const a = addState(L, { name: "Low" });
    const b = addState(L, { name: "Exact" });
    addTransition(L, { from: a.id, to: b.id, conditions: [{ kind: "input", input: "Level", op: "==", value: 0.3 }] });
    writeChannel(s.inst, inputPath(s.level.id), 200, 0.1 + 0.2, { forceKey: true });
    expect(0.1 + 0.2 === 0.3).toBe(false);
    expect(stateAt(s.doc, s.master.id, s.inst.id, 100)).toBe("Exact"); // a single key holds its value everywhere
    // >= and <= include the tolerance band too; > and < exclude it.
    const inputs: MachineInputs = { value: () => 0.30000000000000004, fired: () => false };
    const m2 = addMachine(frameOf(s.doc, s.master.id), "Strict");
    const L2 = m2.layers[0]!;
    const x = addState(L2, { name: "X" });
    const y = addState(L2, { name: "Y" });
    addTransition(L2, { from: x.id, to: y.id, conditions: [{ kind: "input", input: "v", op: ">", value: 0.3 }] });
    expect(machineAt({ doc: s.doc, frameId: s.master.id, instanceId: "", fps: 30 }, m2, inputs, 500).layers[0]!.stateName).toBe("X");
  });

  it("an instant-transition loop terminates deterministically and says so", () => {
    const s = scene();
    const m = addMachine(frameOf(s.doc, s.master.id), "Mood");
    const L = m.layers[0]!;
    const a = addState(L, { name: "Idle" });
    const b = addState(L, { name: "Walk" });
    addTransition(L, { from: a.id, to: b.id });
    addTransition(L, { from: b.id, to: a.id });
    addTransition(L, { from: "any", to: b.id, conditions: [{ kind: "input", input: s.happy.id, value: false }] });
    const run = () => {
      resetMachineMemo();
      return machineTimeline(machineScopeOf(s.doc, s.master.id, null), m, scopeMachineInputs(s.doc, null, s.master.id), 0, 200)[0]!.segments.map((x) => `${x.stateName}${x.cut ? "!" : ""}`);
    };
    const first = run();
    expect(run()).toEqual(first);
    expect(first.some((x) => x.endsWith("!"))).toBe(true);
    const r = machineAt(machineScopeOf(s.doc, s.master.id, null), m, scopeMachineInputs(s.doc, null, s.master.id), 0);
    expect(r.layers[0]!.cut).toBe(true);
  });

  it("exit time gates a transition whose condition held earlier", () => {
    const s = scene(30);
    const m = addMachine(frameOf(s.doc, s.master.id), "Mood");
    const L = m.layers[0]!;
    const a = addState(L, { name: "Intro" });
    const b = addState(L, { name: "Loop" });
    addTransition(L, { from: a.id, to: b.id, exitTime: 250, conditions: [{ kind: "input", input: s.happy.id, value: true }] });
    writeChannel(s.inst, inputPath(s.happy.id), 0, false, { forceKey: true });
    writeChannel(s.inst, inputPath(s.happy.id), 100, true, { forceKey: true });
    expect(stateAt(s.doc, s.master.id, s.inst.id, 240)).toBe("Intro");
    // 250 ms is step 7.5 at 30 fps — the first step past it is 8 (266.7 ms).
    expect(stateAt(s.doc, s.master.id, s.inst.id, 260)).toBe("Intro");
    expect(stateAt(s.doc, s.master.id, s.inst.id, 267)).toBe("Loop");
  });

  it("editing a key at t re-folds only from t", () => {
    const s = scene(30);
    const m = addMachine(frameOf(s.doc, s.master.id), "Mood");
    const L = m.layers[0]!;
    const a = addState(L, { name: "A" });
    const b = addState(L, { name: "B" });
    addTransition(L, { from: a.id, to: b.id, conditions: [{ kind: "trigger", input: s.wave.id }] });
    addTransition(L, { from: b.id, to: a.id, conditions: [{ kind: "time", op: ">=", ms: 300 }] });
    writeChannel(s.inst, inputPath(s.wave.id), 2000, true, { forceKey: true });
    writeChannel(s.inst, inputPath(s.wave.id), 5000, true, { forceKey: true });
    expect(stateAt(s.doc, s.master.id, s.inst.id, 10_000)).toBe("A");
    expect(machineMemoStats.stepsFolded).toBe(301);
    // An edit elsewhere in the document: nothing re-folds.
    const other = structuredClone(s.doc);
    other.name = "Renamed";
    expect(stateAt(other, s.master.id, s.inst.id, 10_000)).toBe("A");
    expect(machineMemoStats.stepsFolded).toBe(301);
    // Move the 5 s key to 6 s: steps before 5 s are kept.
    const edited = structuredClone(other);
    const track = clipOf(edited, s.inst.id).keyframes.find((t) => t.property === inputPath(s.wave.id))!;
    track.keys[1]!.timeMs = 6000;
    expect(stateAt(edited, s.master.id, s.inst.id, 6100)).toBe("B");
    expect(machineMemoStats.refolds).toBe(1);
    expect(machineMemoStats.stepsFolded).toBe(301 + (183 - 150 + 1)); // steps 150..183
    expect(stateAt(edited, s.master.id, s.inst.id, 5100)).toBe("A");
    expect(stateAt(edited, s.master.id, s.inst.id, 2100)).toBe("B");
  });

  it("folds 10,000 steps inside the budget", () => {
    const s = scene(60);
    const m = addMachine(frameOf(s.doc, s.master.id), "Mood");
    for (let li = 0; li < 3; li++) {
      const L = li === 0 ? m.layers[0]! : (m.layers.push({ id: `l${li}`, name: `L${li}`, entry: "", states: [], transitions: [] }), m.layers[li]!);
      const st = Array.from({ length: 6 }, (_, i) => addState(L, { name: `S${i}` }));
      st.forEach((x, i) => {
        addTransition(L, { from: x.id, to: st[(i + 1) % 6]!.id, conditions: [{ kind: "time", op: ">=", ms: 200 + i * 50 }, { kind: "input", input: s.level.id, op: "<", value: 5 }] });
        addTransition(L, { from: x.id, to: st[(i + 3) % 6]!.id, conditions: [{ kind: "trigger", input: s.wave.id }] });
      });
    }
    for (let k = 0; k < 40; k++) writeChannel(s.inst, inputPath(s.wave.id), k * 4000 + 7, true, { forceKey: true });
    writeChannel(s.inst, inputPath(s.level.id), 0, 0, { forceKey: true });
    writeChannel(s.inst, inputPath(s.level.id), 160_000, 10, { forceKey: true });
    const t0 = performance.now();
    const end = (10_000 / 60) * 1000;
    stateAt(s.doc, s.master.id, s.inst.id, end);
    const ms = performance.now() - t0;
    expect(machineMemoStats.stepsFolded).toBe(10_001);
    // The step count is the real guarantee (linear, once). The wall clock only
    // catches a catastrophe: the full suite runs files in parallel, so a tight
    // budget here measures the machine's load, not this fold (it read 637 ms
    // under load against ~150 ms alone).
    expect(ms).toBeLessThan(2_000);
    // Reading back anywhere is a lookup.
    const before = machineMemoStats.stepsFolded;
    for (let t = 0; t < end; t += 997) stateAt(s.doc, s.master.id, s.inst.id, t);
    expect(machineMemoStats.stepsFolded).toBe(before);
  });

  it("a machine with no states, or no layers, reads empty", () => {
    const s = scene();
    const frame = frameOf(s.doc, s.master.id);
    const m = addMachine(frame, "Mood");
    expect(stateAt(s.doc, s.master.id, s.inst.id, 500)).toBe("");
    m.layers = [];
    resetMachineMemo();
    expect(stateAt(s.doc, s.master.id, s.inst.id, 500)).toBeUndefined();
    const r = machineAt(machineScopeOf(s.doc, s.master.id, null), m, scopeMachineInputs(s.doc, null, s.master.id), 500);
    expect(r.layers).toEqual([]);
    expect(machineIssues(m)).toEqual([]);
  });

  it("a condition on a deleted input never fires and is reported", () => {
    const s = scene();
    const m = addMachine(frameOf(s.doc, s.master.id), "Mood");
    const L = m.layers[0]!;
    const a = addState(L, { name: "A" });
    const b = addState(L, { name: "B" });
    addTransition(L, { from: a.id, to: b.id, conditions: [{ kind: "input", input: s.happy.id, op: "==", value: false }] });
    expect(stateAt(s.doc, s.master.id, s.inst.id, 100)).toBe("B");
    const frame = frameOf(s.doc, s.master.id);
    frame.inputs = frame.inputs!.filter((d) => d.id !== s.happy.id);
    resetMachineMemo();
    expect(stateAt(s.doc, s.master.id, s.inst.id, 100)).toBe("A");
    const issues = machineIssues(m, scopeMachineInputs(s.doc, null, s.master.id));
    expect(issues.join()).toMatch(/does not exist/);
  });

  it("two instances fold apart; the master drawn as itself reads defaults", () => {
    const s = scene();
    const m = addMachine(frameOf(s.doc, s.master.id), "Mood");
    const L = m.layers[0]!;
    const a = addState(L, { name: "Calm" });
    const b = addState(L, { name: "Joy" });
    addTransition(L, { from: a.id, to: b.id, conditions: [{ kind: "input", input: "Happy", value: true }] });
    const twin = { ...structuredClone(s.inst), id: "twin", name: "Twin" };
    s.doc.tracks[s.doc.tracks.length - 1]!.clips.push(twin);
    writeChannel(s.inst, inputPath(s.happy.id), 0, true, { forceKey: true });
    expect(stateAt(s.doc, s.master.id, s.inst.id, 100)).toBe("Joy");
    expect(stateAt(s.doc, s.master.id, twin.id, 100)).toBe("Calm");
    expect(readMachineState(s.doc, s.master.id, null, 100, "Mood")?.stateName).toBe("Calm");
  });

  it("state() and stateTime() read through the host's reader", () => {
    const s = scene();
    const m = addMachine(frameOf(s.doc, s.master.id), "Mood");
    addState(m.layers[0]!, { name: "Idle" });
    const scope = instanceScope(s.doc, s.inst, 1500, null);
    const ctx: ExprContext = {
      timeMs: 1500, fps: 30, comp: null, layer: null, playing: false, seed: 0, compId: s.master.id, scope,
      readMachine: (machine, layer) => readMachineState(s.doc, s.master.id, scope, 1500, machine, layer),
    };
    const v = withExpressionContext(ctx, () => evaluateExpressionRaw('state("mood") + ":" + fixed(stateTime("Mood"), 1)', { ctx, readVariable: () => undefined }));
    expect(v?.value).toBe("Idle:1.5");
  });
});
