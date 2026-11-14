import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { locateClip } from "../timeline/ops";
import { createCommandApi, type CommandContext } from "../api";
import type { GroupClip } from "../schema";

function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn-1",
    historyLabel: "Rig a character",
    session: { focusFrameId: () => store.getState().frames[0]?.id ?? null, playheadMs: () => 0, selection: () => [] },
  };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  return { store, call };
}

describe("symmetry and constraints through the API", () => {
  it("symmetrizes a half face, aims its eyes, mirrors a pose and reads it all back", async () => {
    const { call } = harness();
    const { rigId } = (await call("rig.create", {
      name: "Face",
      bones: [
        { head: [0, 0], tail: [0, -100], name: "Head" },
        { head: [30, -60], tail: [34, -60], name: "Pupil.L", parent: null, deform: false, shape: "circle", limits: { x: [-6, 6], y: [-6, 6] } },
        { head: [40, 20], tail: [80, 40], name: "Ear.L", parent: "Head" },
        { head: [0, -300], tail: [0, -310], name: "Look", parent: null, deform: false },
      ],
    })) as { rigId: string };
    const sym = (await call("rig.symmetrize", { rigId })) as { created: string[]; axis: number };
    expect(sym.created.sort()).toEqual(["Ear.R", "Pupil.R"]);
    expect(sym.axis).toBeCloseTo(0, 9);
    expect(((await call("rig.symmetrize", { rigId })) as { created: string[] }).created).toEqual([]);

    const { added } = (await call("rig.constrain", { rigId, add: [{ bone: "Pupil.L", type: "look", target: "Look" }, { bone: "Pupil.R", type: "look", target: "Look", radius: 4 }] })) as { added: Array<{ id: string }> };
    expect(added).toHaveLength(2);
    await call("rig.constrain", { rigId, update: [{ bone: "Pupil.R", id: added[1]!.id, influence: 0.5 }] });
    await expect(call("rig.constrain", { rigId, add: [{ bone: "Look", type: "track", target: "Look" }] })).rejects.toThrow(/cannot track/);

    await call("rig.pose", { rigId, poses: [{ bone: "Ear.L", rotation: 30 }] });
    const mirrored = (await call("rig.mirror", { rigId, mode: "copy" })) as { posed: string[] };
    expect(mirrored.posed).toContain("Ear.R");
    const at = (await call("rig.inspect", { rigId })) as { bones: Array<{ name: string; side?: string; now: { head: number[]; tail: number[] }; constraints?: Array<{ type: string; target: unknown; influence: number; radius?: number }> }> };
    const bone = (n: string) => at.bones.find((b) => b.name === n)!;
    expect(bone("Ear.R").side).toBe("R");
    expect(bone("Ear.R").now.tail[0]).toBeCloseTo(-bone("Ear.L").now.tail[0]!, 0);
    expect(bone("Ear.R").now.tail[1]).toBeCloseTo(bone("Ear.L").now.tail[1]!, 0);
    expect(bone("Pupil.R").constraints?.[0]).toMatchObject({ type: "look", target: "Look", influence: 0.5, radius: 4 });
    // The pupils look up at the Look control: the left one to its pad's edge, the right half of a 4 px radius.
    expect(bone("Pupil.L").now.head[1]).toBeCloseTo(-66, 0);
    expect(bone("Pupil.R").now.head[1]).toBeCloseTo(-62, 0);
  });
});

describe("rigging through the API, the way an agent does it", () => {
  it("rigs an arm, gives it IK, keys a reach and reads it back", async () => {
    const { call, store } = harness();
    const upper = (await call("layer.create", { kind: "shape", shape: "rect", width: 210, height: 40, x: -100, y: 0, fill: "#ff5a5f" })) as { id: string };
    const fore = (await call("layer.create", { kind: "shape", shape: "rect", width: 200, height: 36, x: 100, y: 0, fill: "#3fa7ff" })) as { id: string };
    const made = (await call("rig.create", {
      ids: [upper.id, fore.id],
      name: "Arm",
      bones: [
        { head: [-200, 0], tail: [0, 0], name: "Upper" },
        { head: [0, 0], tail: [200, 0], name: "Fore" },
        { head: [200, 0], tail: [240, 0], name: "Hand ctrl", parent: null, deform: false },
      ],
    })) as { rigId: string; bones: Array<{ name: string; parent: string | null }> };
    expect(made.bones.map((b) => [b.name, b.parent])).toEqual([["Upper", null], ["Fore", "Upper"], ["Hand ctrl", null]]);

    await call("rig.bone", { rigId: made.rigId, edit: [{ bone: "fore", ik: { target: "Hand ctrl", chain: 2 } }] });
    // Key the control at rest at 0, lifted at 1000: the arm reaches.
    await call("rig.pose", { rigId: made.rigId, atMs: 0, key: true, poses: [{ bone: "Hand ctrl", x: 0, y: 0 }] });
    await call("rig.pose", { rigId: made.rigId, atMs: 1000, key: true, poses: [{ bone: "Hand ctrl", x: -60, y: -150 }] });
    const at = (await call("rig.inspect", { rigId: made.rigId, atMs: 1000 })) as {
      bones: Array<{ name: string; now: { head: number[]; tail: number[] } }>;
      members: Array<{ name: string; follows: string }>;
    };
    const tip = at.bones.find((b) => b.name === "Fore")!.now.tail;
    expect(Math.hypot(tip[0]! - 140, tip[1]! + 150)).toBeLessThan(1);
    expect(at.members.map((m) => m.follows).sort()).toEqual(["rides Fore", "rides Upper"]);
    // The keys are ordinary channels on the rig.
    const g = locateClip(store.getState(), made.rigId)!.clip as GroupClip;
    expect(g.keyframes.some((t) => /^bone\..+\.x$/.test(t.property))).toBe(true);
  });

  it("refuses what makes no sense, with a way forward", async () => {
    const { call } = harness();
    const s = (await call("layer.create", { kind: "shape", shape: "rect", width: 100, height: 100 })) as { id: string };
    await expect(call("rig.pose", { rigId: s.id, poses: [] })).rejects.toThrow(/not a rig/);
    const { rigId } = (await call("rig.create", { bones: [{ head: [0, 0], tail: [0, 100], name: "Spine" }] })) as { rigId: string };
    await expect(call("rig.pose", { rigId, poses: [{ bone: "Tail", rotation: 10 }] })).rejects.toThrow(/No bone "Tail".*Spine/);
    await expect(call("rig.bind", { ids: s.id, mode: "rigid" })).rejects.toThrow(/not in a rig/);
  });

  it("paints weights in rig space and the stroke lands in the layer's own", async () => {
    const { call, store } = harness();
    const sleeve = (await call("layer.create", { kind: "shape", shape: "rect", width: 400, height: 40, x: 50, y: 30 })) as { id: string };
    const { rigId } = (await call("rig.create", { ids: [sleeve.id], bones: [{ head: [-150, 30], tail: [50, 30], name: "A" }, { head: [50, 30], tail: [250, 30], name: "B" }] })) as { rigId: string };
    await call("rig.paint", { id: sleeve.id, bone: "B", points: [[0, 30]], radius: 40, strength: 1 });
    const c = locateClip(store.getState(), sleeve.id)!.clip as { bind?: { mode: string; paint: Array<{ points: number[] }> } };
    expect(c.bind?.mode).toBe("smooth");
    // The sleeve's own space has its origin at its centre (50, 30): rig (0, 30) is own (−50, 0).
    expect(c.bind!.paint[0]!.points.slice(0, 2).map((v) => Math.round(v))).toEqual([-50, 0]);
    void rigId;
  });

  it("builds a face: an eye SWITCH that blinks, riding a head bone, looked around by a limited control", async () => {
    const { call, store } = harness();
    const head = (await call("layer.create", { kind: "shape", shape: "ellipse", width: 200, height: 220, x: 0, y: -200, fill: "#f2c6a0" })) as { id: string };
    const states = [] as string[];
    for (const [name, h] of [["Open", 40], ["Closed", 4]] as const) {
      const e = (await call("layer.create", { kind: "shape", shape: "ellipse", width: 40, height: h, x: 40, y: -220, fill: "#222222", name })) as { id: string };
      states.push(e.id);
    }
    const eye = (await call("switch.create", { ids: states, name: "Eye R" })) as { switchId: string; members: Array<{ name: string }>; show: string };
    expect(eye.members.map((m) => m.name).sort()).toEqual(["Closed", "Open"]);
    // A blink is two keys on the switch.
    await call("switch.show", { id: eye.switchId, show: "Open", atMs: 0, key: true });
    await call("switch.show", { id: eye.switchId, show: "closed", atMs: 1000, key: true });
    await expect(call("switch.show", { id: eye.switchId, show: "Wink" })).rejects.toThrow(/Members: .*Open/);

    const rig = (await call("rig.create", {
      ids: [head.id, eye.switchId],
      name: "Face",
      bones: [
        { head: [0, 0], tail: [0, -100], name: "Neck" },
        { head: [0, -100], tail: [0, -300], name: "Head" },
        // A pad: the look control moves 30 px either way, no further.
        { head: [0, -420], tail: [0, -440], name: "Look", parent: null, deform: false, shape: "circle", limits: { x: [-30, 30], y: [-30, 30] } },
      ],
    })) as { rigId: string };
    // The eye switch is one unit of the rig: it rides the head bone whole, and so does the head.
    const at0 = (await call("rig.inspect", { rigId: rig.rigId })) as { bones: Array<{ name: string; shape?: string; limits?: unknown; now: { head: number[] } }>; members: Array<{ name: string; follows: string }> };
    expect(at0.members.find((m) => m.name === "Eye R")!.follows).toBe("rides Head");
    expect(at0.bones.find((b) => b.name === "Look")).toMatchObject({ shape: "circle", limits: { x: [-30, 30], y: [-30, 30] } });

    // Pushed past the pad's edge: it stops at it.
    await call("rig.pose", { rigId: rig.rigId, poses: [{ bone: "Look", x: 80, y: -5 }] });
    const pushed = (await call("rig.inspect", { rigId: rig.rigId })) as { bones: Array<{ name: string; now: { head: number[] } }> };
    expect(pushed.bones.find((b) => b.name === "Look")!.now.head).toEqual([30, -425]);

    // The control drives the pupil's switch through an expression: it checks, binds, and names the bone.
    const bound = (await call("expression.set", { id: eye.switchId, property: "switch", source: 'if(bone("Face", "Look", "y") < -20 || blink(4) > 0, "Closed", "Open")' })) as { expressionId: string };
    expect(bound.expressionId).toBeTruthy();
    const g = locateClip(store.getState(), eye.switchId)!.clip as GroupClip;
    expect(g.drivers?.switch).toMatch(/^fx:/);
  });
});
