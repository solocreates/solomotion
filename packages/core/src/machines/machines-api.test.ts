import { describe, expect, it } from "vitest";
import "../index";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { createCommandApi, type CommandContext } from "../api";
import { machineCode, machineSpec } from "./code";

function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  let focus = store.getState().frames[0]!.id;
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Machines",
    session: { focusFrameId: () => focus, playheadMs: () => 0, selection: () => [] },
  };
  const call = async <T = Record<string, unknown>>(id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as T;
  };
  return { store, call, focusOn: (id: string) => (focus = id) };
}

type Timeline = { machines: Array<{ issues: string[]; timeline: Array<{ layer: string; segments: Array<{ state: string; from: number; to: number; via?: string }> }> }> };

describe("state machines through the API, the way an agent does it", () => {
  it("builds a mood machine on a character, keys an instance and reads the state timeline", async () => {
    const { store, call, focusOn } = harness();
    const root = store.getState().frames[0]!.id;
    const ch = await call<{ id: string }>("frame.create", { name: "Pip", width: 200, height: 200 });
    focusOn(ch.id);
    await call("component.inputs", { action: "define", frameId: ch.id, def: { name: "Happy", type: "bool" } });
    await call("component.inputs", { action: "define", frameId: ch.id, def: { name: "Wave", type: "trigger" } });
    const made = await call<{ layers: Array<{ states: Array<{ id: string; name: string }>; transitions: Array<{ when: string[] }> }>; issues: string[] }>("machine.create", {
      name: "Mood",
      layers: [
        {
          states: [{ name: "Idle" }, { name: "Joy" }, { name: "Waving" }],
          transitions: [
            { from: "Idle", to: "Joy", when: [{ kind: "input", input: "Happy", value: true }], durationMs: 200 },
            { from: "Joy", to: "Idle", when: [{ kind: "input", input: "Happy", value: false }] },
            { from: "any", to: "Waving", when: [{ kind: "trigger", input: "Wave" }] },
            { from: "Waving", to: "Idle", exitTime: 600 },
          ],
        },
      ],
    });
    expect(made.issues).toEqual([]);
    expect(made.layers[0]!.transitions[0]!.when).toEqual(["Happy"]);
    expect(made.layers[0]!.transitions[2]!.when).toEqual(["Wave fires"]);

    // An instance on the root, keyed.
    focusOn(root);
    const inst = await call<{ id: string }>("layer.create", { kind: "comp", sourceFrameId: ch.id, name: "Pip 1" });
    const defs = store.getState().frames.find((f) => f.id === ch.id)!.inputs!;
    const happy = defs.find((d) => d.name === "Happy")!.id;
    const wave = defs.find((d) => d.name === "Wave")!.id;
    await call("keyframes.set", { id: inst.id, property: `input.${happy}`, keys: [{ at: 0, value: false }, { at: 1000, value: true }] });
    await call("keyframes.set", { id: inst.id, property: `input.${wave}`, keys: [{ at: 2000, value: true }] });

    const read = await call<Timeline>("machine.inspect", { frameId: ch.id, instance: "Pip 1", toMs: 4000 });
    const segs = read.machines[0]!.timeline[0]!.segments.map((s) => `${s.state}@${s.from}`);
    expect(segs).toEqual(["Idle@0", "Joy@1000", "Waving@2000", "Joy@2600"]); // Waving → Idle → Joy in one step: Happy still holds

    const at = await call<Array<{ state: string; from?: string; transition?: { progress: number } }>>("machine.evaluate", { frameId: ch.id, machine: "Mood", instance: inst.id, atMs: 1100 });
    expect(at[0]!.state).toBe("Joy");
    expect(at[0]!.from).toBe("Idle");
    expect(at[0]!.transition!.progress).toBeCloseTo(0.5, 5);

    // Defaults (no instance): Happy is false, triggers never fire.
    const plain = await call<Timeline>("machine.inspect", { frameId: ch.id, toMs: 4000 });
    expect(plain.machines[0]!.timeline[0]!.segments.map((s) => s.state)).toEqual(["Idle"]);

    // Re-create by name: states keep their ids.
    const before = made.layers[0]!.states.map((s) => s.id);
    const again = await call<typeof made>("machine.create", { frameId: ch.id, name: "Mood", layers: [{ states: [{ name: "Idle" }, { name: "Joy" }], transitions: [] }] });
    expect(again.layers[0]!.states.map((s) => s.id)).toEqual(before.slice(0, 2));
    expect(store.getState().frames.find((f) => f.id === ch.id)!.machines).toHaveLength(1);

    // Edit verbs.
    await call("machine.state", { frameId: ch.id, machine: "Mood", add: [{ name: "Sleep" }], edit: [{ state: "Joy", name: "Glad" }] });
    const t = await call<{ layers: Array<{ transitions: Array<{ id: string; from: string; to: string }> }> }>("machine.transition", {
      frameId: ch.id,
      machine: "Mood",
      add: [{ from: "Idle", to: "Sleep", when: [{ kind: "time", op: ">=", ms: 3000 }] }],
    });
    expect(t.layers[0]!.transitions.at(-1)).toMatchObject({ from: "Idle", to: "Sleep" });
    const bad = await call<Timeline>("machine.transition", { frameId: ch.id, machine: "Mood", add: [{ from: "Sleep", to: "Glad", when: [{ kind: "input", input: "Nope", value: 1 }] }] }).then(() =>
      call<Timeline>("machine.inspect", { frameId: ch.id }),
    );
    expect(bad.machines[0]!.issues.join()).toMatch(/"Nope", which does not exist/);
    await call("machine.remove", { frameId: ch.id, machine: "Mood" });
    expect(store.getState().frames.find((f) => f.id === ch.id)!.machines).toBeUndefined();
  });
});

describe("a machine as code", () => {
  it("round-trips: running the printed call rebuilds the same machine", async () => {
    const { store, call, focusOn } = harness();
    const ch = await call<{ id: string }>("frame.create", { name: "Pip", width: 200, height: 200 });
    focusOn(ch.id);
    await call("component.inputs", { action: "define", frameId: ch.id, def: { name: "Mood", type: "enum", options: ["Calm", "Happy"] } });
    await call("machine.create", {
      name: "Face",
      layers: [
        {
          name: "Eyes",
          entry: "Open",
          states: [{ name: "Shut", x: 10, y: 20 }, { name: "Open", x: 300, y: 20 }],
          transitions: [
            { from: "Open", to: "Shut", when: [{ kind: "time", op: ">=", ms: 2000 }], exitTime: 100 },
            { from: "Shut", to: "Open", when: [], durationMs: 80 },
          ],
        },
        {
          name: "Mouth",
          states: [{ name: "Rest" }, { name: "Smile" }],
          transitions: [
            { from: "any", to: "Smile", when: [{ kind: "input", input: "Mood", value: "Happy" }] },
            { from: "Smile", to: "exit", when: [{ kind: "speaking", layer: "Voice" }] },
          ],
        },
      ],
    });
    const frame = () => store.getState().frames.find((f) => f.id === ch.id)!;
    const before = structuredClone(frame().machines![0]!);
    const code = machineCode(frame(), before);
    expect(code).toContain("ac.machine.create(");
    expect(code).toContain('"input": "Mood"');
    const arg = JSON.parse(code.slice(code.indexOf("(") + 1, code.lastIndexOf(")")));
    await call("machine.create", arg);
    expect(frame().machines).toHaveLength(1);
    const after = frame().machines![0]!;
    // Same states (ids kept), same logic; transition ids are minted afresh.
    const strip = (m: typeof after) => ({ ...m, layers: m.layers.map((l) => ({ ...l, transitions: l.transitions.map(({ id: _id, ...t }) => t) })) });
    expect(strip(after)).toEqual(strip(before));
    expect(machineSpec(frame(), after)).toEqual(arg);
  });

  it("a state's pose set is named in code and resolved by name — never a raw id in what people read", async () => {
    const { store, call, focusOn } = harness();
    const ch = await call<{ id: string }>("frame.create", { name: "Pip", width: 200, height: 200 });
    focusOn(ch.id);
    const hand = await call<{ id: string }>("layer.create", { kind: "shape", shape: "rect", width: 20, height: 20, name: "Hand" });
    const g = await call<{ id?: string; groupId?: string }>("layers.group", { ids: [hand.id], name: "Body" });
    const set = await call<{ id?: string; setId?: string }>("poses.create", { groupId: g.groupId ?? g.id, name: "Left hand", poses: [{ name: "Relaxed", values: [] }, { name: "Wave", values: [] }] });
    await call("machine.create", { name: "Hands", layers: [{ states: [{ name: "Waving", output: { kind: "pose", set: "left HAND", pose: "Wave" } }], transitions: [] }] });
    const frame = () => store.getState().frames.find((f) => f.id === ch.id)!;
    const m = frame().machines![0]!;
    const out = m.layers[0]!.states[0]!.output;
    const setId = set.setId ?? set.id!;
    expect(out.kind === "pose" && out.set).toBe(setId);
    const code = machineCode(frame(), m, store.getState());
    expect(code).toContain('"set": "Left hand"');
    expect(code).not.toContain(setId);
    await expect(call("machine.create", { name: "Bad", layers: [{ states: [{ name: "A", output: { kind: "pose", set: "Nope", pose: "X" } }], transitions: [] }] })).rejects.toThrow(/No pose set "Nope"/);
  });
});
