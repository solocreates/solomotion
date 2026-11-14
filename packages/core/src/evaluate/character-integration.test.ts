import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../index";
import { runSpeechEngine, type SynthesisResult } from "@solomotion/lipsync";
import type { MotionDocument, Clip } from "../schema";
import { createDocumentStore, type DocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { createCommandApi, type CommandContext } from "../api";
import { inProcessAc } from "../scripts/run-in-process";
import { getClipProperty } from "../animation/paths";
import { clipLookup } from "../timeline/frame-index";
import { clipSourcePhaseAt } from "../timeline/ops";
import { compFps } from "../timeline/fps";
import { cueIndexAt } from "@solomotion/lipsync";
import { instanceScope } from "../components/inputs";
import { installSpeechReader } from "../speech/reader";
import { mediaSourceAt } from "../speech/source";
import { actedCues } from "../speech/feel";
import { resolvePoseName } from "../rig/vocabulary";
import { resolvedDocAt } from "./resolved-doc";
import { evaluateGeometry, evaluateWorld } from "../world/evaluate";
import { transformPoint } from "../world/math";
import type { MeshClip } from "../schema";

/**
 * CHARACTERS 2.0 AS ONE SYSTEM — built the way an agent builds it (registry
 * verbs through the in-process `ac`), evaluated through the headless bake the
 * canvas draws with. Each chain is asserted end to end: a voice beside each
 * instance → `lipsync(input("Voice"))` → a pose set → a mouth switch; blink
 * seeds per instance; `loudness()` → a jaw bone; `speaking` → a machine →
 * `statePose()` → a hand pose set.
 */

type Ac = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const LINES = { a: "Hello there, how are you today?", b: "Wow. Bob saw my old blue boat." } as const;
const tracks = new Map<string, SynthesisResult>();

beforeAll(async () => {
  tracks.set("voice-a", (await runSpeechEngine("test-voice", { text: LINES.a }, { preset: "warm" })) as SynthesisResult);
  tracks.set("voice-b", (await runSpeechEngine("test-voice", { text: LINES.b }, { preset: "bright" })) as SynthesisResult);
  // The Test Voice's EXACT cues, installed the way the host installs a landed track.
  installSpeechReader((assetId) => tracks.get(assetId) ?? null);
});
afterAll(() => installSpeechReader(null));

function harness() {
  const doc = createEmptyDocument("Characters");
  for (const id of tracks.keys())
    doc.assets.push({ id, kind: "audio", name: `${id}.wav`, mime: "audio/wav", bytes: 1, width: null, height: null, durationMs: Math.ceil(tracks.get(id)!.durationMs), fps: null, folderId: null, origin: null });
  const store: DocumentStore = createDocumentStore(doc);
  let focus = doc.frames[0]!.id;
  const ctx: CommandContext = {
    store,
    actor: "AI",
    historyKey: "turn",
    historyLabel: "Character",
    session: { focusFrameId: () => focus, playheadMs: () => 0, selection: () => [] },
  };
  const ac = inProcessAc(createCommandApi(), ctx) as Ac;
  return { store, ac, root: doc.frames[0]!.id, focusOn: (id: string) => (focus = id) };
}

const DUR = 4000;
const shape = (frameId: string, name: string, x = 0, y = 0) => ({ kind: "shape", shape: "ellipse", width: 40, height: 20, frameId, name, startMs: 0, durationMs: DUR, x, y });

/** The character, made the way an agent makes it. */
async function buildCharacter(ac: Ac, focusOn: (id: string) => void) {
  const pip = (await ac.frame.create({ name: "Pip", width: 400, height: 400, fps: 30, durationMs: DUR })) as { id: string };
  focusOn(pip.id);
  await ac.component.inputs({ action: "define", frameId: pip.id, def: { name: "Voice", type: "layer" } });

  // Mouth: five drawings in a switch; a pose set on the head picks one by viseme.
  const mouths: string[] = [];
  for (const n of ["Rest", "MBP", "AI", "E", "O"]) mouths.push(((await ac.layer.create(shape(pip.id, n, 0, 60))) as { id: string }).id);
  const mouth = (await ac.switch.create({ ids: mouths, name: "Mouth" })) as { switchId: string };
  // Hand: three drawings; a machine picks one.
  const hands: string[] = [];
  for (const n of ["Relaxed", "Open", "Wave"]) hands.push(((await ac.layer.create(shape(pip.id, n, 120, 100))) as { id: string }).id);
  const hand = (await ac.switch.create({ ids: hands, name: "Hand" })) as { switchId: string };
  const eye = (await ac.layer.create(shape(pip.id, "Eye", 0, -40))) as { id: string };

  const rig = (await ac.rig.create({ ids: [mouth.switchId, hand.switchId, eye.id], name: "Head", bones: [{ name: "Jaw", head: [0, 30], tail: [0, 80] }] })) as {
    rigId: string;
    bones: Array<{ id: string; name: string }>;
  };
  const head = rig.rigId;
  const jaw = rig.bones.find((b) => b.name === "Jaw")!.id;

  const mouthSet = (await ac.poses.create({ groupId: head, name: "Mouth", vocabulary: "visemes", fromSwitch: mouth.switchId })) as { setId: string; path: string };
  // A float on every viseme too (the mouth's y): what the eased blend acts on.
  for (const [i, n] of ["Rest", "MBP", "AI", "E", "O"].entries())
    await ac.poses.update({ groupId: head, set: mouthSet.setId, pose: n, setValues: [{ clipId: mouth.switchId, path: "y", value: 60 + i * 10 }] });
  const handSet = (await ac.poses.create({ groupId: head, name: "Hand", vocabulary: "hands", fromSwitch: hand.switchId })) as { setId: string; path: string };

  await ac.expression.set({ id: head, property: mouthSet.path, source: 'lipsync(input("Voice"))' });
  await ac.expression.set({ id: head, property: `bone.${jaw}.rotation`, source: 'loudness(input("Voice")) * 20' });
  await ac.expression.set({ id: eye.id, property: "opacity", source: "1 - blink(1.5)" });
  return { pip: pip.id, head, jaw, mouth: mouth.switchId, hand: hand.switchId, eye: eye.id, mouthSet, handSet };
}

async function buildScene() {
  const h = harness();
  const ch = await buildCharacter(h.ac, h.focusOn);
  h.focusOn(h.root);
  const voiceA = (await h.ac.layer.create({ kind: "media", assetId: "voice-a", frameId: h.root, name: "Voice A", startMs: 0 })) as { id: string };
  const voiceB = (await h.ac.layer.create({ kind: "media", assetId: "voice-b", frameId: h.root, name: "Voice B", startMs: 0 })) as { id: string };
  const pip1 = (await h.ac.layer.create({ kind: "comp", sourceFrameId: ch.pip, frameId: h.root, name: "Pip 1", startMs: 0, durationMs: DUR, x: -200 })) as { id: string };
  const pip2 = (await h.ac.layer.create({ kind: "comp", sourceFrameId: ch.pip, frameId: h.root, name: "Pip 2", startMs: 0, durationMs: DUR, x: 200 })) as { id: string };
  await h.ac.layer.set({ ids: [pip1.id], values: { "input.Voice": "Voice A" } });
  await h.ac.layer.set({ ids: [pip2.id], values: { "input.Voice": "Voice B" } });
  return { ...h, ch, voiceA: voiceA.id, voiceB: voiceB.id, pip1: pip1.id, pip2: pip2.id };
}

/**
 * What the canvas draws for one instance at root time `t`: the root bake, the
 * instance's scope on its outer clock, its comp baked at its content time in
 * that scope — the renderer's walk (`drawNestedClip`) without the pixels.
 */
function instanceAt(doc: MotionDocument, rootId: string, instanceId: string, t: number) {
  const outer = resolvedDocAt(doc, t, rootId);
  const clip = clipLookup(outer)(instanceId)!;
  const local = t - clip.startMs;
  const scope = instanceScope(outer, clip, local, null);
  const inner = resolvedDocAt(outer, clipSourcePhaseAt(outer, clip, local).sourceMs, clip.kind === "nested" ? clip.sourceFrameId : rootId, false, scope);
  const of = clipLookup(inner);
  return (id: string, path: string) => getClipProperty(of(id) as Clip, path);
}

/** The viseme a voice says at root time `t`, through the clip's time map and the drawings feel profile, as the mouth names it. */
function expectedMouth(doc: MotionDocument, voiceId: string, fps: number, t: number): string {
  const voice = clipLookup(doc)(voiceId)!;
  const src = mediaSourceAt(doc, voice, t);
  const names = ["Rest", "MBP", "AI", "E", "O"];
  if (!src) return resolvePoseName("visemes", "X", names)!;
  const cues = actedCues(tracks.get(src.assetId)!, { kind: "drawings", fps, speech: src.asset?.speech });
  const i = cueIndexAt(cues, src.sourceMs);
  return resolvePoseName("visemes", i < 0 ? "X" : cues[i]!.viseme, names)!;
}

const SAMPLES = Array.from({ length: 120 }, (_, i) => i * 33.3333);

describe("Characters 2.0 — one system", () => {
  it("2D: two instances lip-sync their own voices, blink out of step, open the jaw with loudness, and re-sync alone when one voice moves", async () => {
    const s = await buildScene();
    const doc = s.store.getState();
    const fps = compFps(doc, s.ch.pip);

    const mouthOf = (d: MotionDocument, inst: string) => SAMPLES.map((t) => instanceAt(d, s.root, inst, t)(s.ch.mouth, "switch"));
    const m1 = mouthOf(doc, s.pip1);
    const m2 = mouthOf(doc, s.pip2);
    expect(m1).toEqual(SAMPLES.map((t) => expectedMouth(doc, s.voiceA, fps, t)));
    expect(m2).toEqual(SAMPLES.map((t) => expectedMouth(doc, s.voiceB, fps, t)));
    expect(new Set(m1).size).toBeGreaterThan(3); // it really talks
    expect(m1.filter((v, i) => v !== m2[i]).length).toBeGreaterThan(20); // two lines, two mouths

    // Blinks: seeded per instance chain, so a crowd never blinks in unison.
    const eyes = (inst: string) => SAMPLES.map((t) => instanceAt(doc, s.root, inst, t)(s.ch.eye, "opacity"));
    const e1 = eyes(s.pip1);
    const e2 = eyes(s.pip2);
    expect(e1.some((v) => v === 0)).toBe(true);
    expect(e1).not.toEqual(e2);

    // Jaw: loudness of each instance's own voice.
    const jaws = (inst: string) => SAMPLES.map((t) => Number(instanceAt(doc, s.root, inst, t)(s.ch.head, `bone.${s.ch.jaw}.rotation`)));
    const j1 = jaws(s.pip1);
    expect(Math.max(...j1)).toBeGreaterThan(4);
    expect(j1).not.toEqual(jaws(s.pip2));

    // The look-back hears the voice at each EARLIER frame: a viseme change
    // eases the mouth's y (between two poses' values) instead of jumping.
    const ys = SAMPLES.map((t) => Number(instanceAt(doc, s.root, s.pip1, t)(s.ch.mouth, "y")));
    expect(ys.some((y) => ![60, 70, 80, 90, 100].some((v) => Math.abs(v - y) < 1e-6))).toBe(true);

    // Backward scrub on a cold copy == forward.
    const cold = structuredClone(doc);
    const back = [...SAMPLES].reverse().map((t) => instanceAt(cold, s.root, s.pip1, t)(s.ch.mouth, "switch")).reverse();
    expect(back).toEqual(m1);

    // Move voice A by 400 ms, trim B's tail: each instance follows ITS voice only.
    await s.ac.timeline.move({ ids: [s.voiceA], byMs: 400 });
    const moved = s.store.getState();
    const m1Moved = mouthOf(moved, s.pip1);
    expect(m1Moved).toEqual(SAMPLES.map((t) => expectedMouth(moved, s.voiceA, fps, t)));
    expect(m1Moved).not.toEqual(m1);
    expect(mouthOf(moved, s.pip2)).toEqual(m2);
    const endB = clipLookup(moved)(s.voiceB)!.durationMs * 0.5;
    await s.ac.timeline.trim({ id: s.voiceB, endMs: endB });
    const trimmed = s.store.getState();
    const m2Trim = mouthOf(trimmed, s.pip2);
    expect(m2Trim).toEqual(SAMPLES.map((t) => expectedMouth(trimmed, s.voiceB, fps, t)));
    expect(m2Trim.filter((_, i) => SAMPLES[i]! > endB + 50).every((v) => v === "Rest")).toBe(true);
    expect(mouthOf(trimmed, s.pip1)).toEqual(m1Moved);
  });

  it("machine: speaking and a trigger drive Idle/Talking/Waving, whose pose OUTPUT selects the hand — per instance", async () => {
    const s = await buildScene();
    const { ac, ch } = s;
    s.focusOn(ch.pip);
    await ac.component.inputs({ action: "define", frameId: ch.pip, def: { name: "Wave", type: "trigger" } });
    const pose = (name: string) => ({ kind: "pose", set: ch.handSet.setId, pose: name });
    await ac.machine.create({
      frameId: ch.pip,
      name: "Body",
      layers: [
        {
          states: [
            { name: "Idle", output: pose("Relaxed") },
            { name: "Talking", output: pose("Open") },
            { name: "Waving", output: pose("Wave") },
          ],
          transitions: [
            { from: "any", to: "Waving", when: [{ kind: "trigger", input: "Wave" }] },
            { from: "Idle", to: "Talking", when: [{ kind: "speaking", layer: "Voice" }] },
            { from: "Talking", to: "Idle", when: [{ kind: "speaking", layer: "Voice", is: false }] },
            { from: "Waving", to: "Idle", exitTime: 600 },
          ],
        },
      ],
    });
    // The state's pose OUTPUT is what the hand shows.
    await ac.expression.set({ id: ch.head, property: ch.handSet.path, source: 'statePose("Body")' });
    const defs = s.store.getState().frames.find((f) => f.id === ch.pip)!.inputs!;
    const wave = defs.find((d) => d.name === "Wave")!.id;
    await ac.keyframes.set({ id: s.pip2, property: `input.${wave}`, keys: [{ at: 1000, value: true }] });

    const doc = s.store.getState();
    const fps = compFps(doc, ch.pip);
    const talking = (voice: string, t: number) => expectedMouth(doc, voice, fps, t) !== "Rest";
    const handOf = (inst: string, t: number) => instanceAt(doc, s.root, inst, t)(ch.hand, "switch");

    // Instance 1: no trigger — Talking exactly while its own voice speaks.
    const h1 = SAMPLES.map((t) => handOf(s.pip1, t));
    expect(h1).toEqual(SAMPLES.map((t) => (talking(s.voiceA, t) ? "Open" : "Relaxed")));
    expect(h1).toContain("Open");
    expect(h1).toContain("Relaxed");
    // Order-free: a cold copy scrubbed backward folds the same history.
    const cold = structuredClone(doc);
    expect([...SAMPLES].reverse().map((t) => instanceAt(cold, s.root, s.pip1, t)(ch.hand, "switch")).reverse()).toEqual(h1);

    // The verb reads the same timeline the bake draws.
    const read = (await ac.machine.inspect({ frameId: ch.pip, machine: "Body", instance: "Pip 1", toMs: DUR })) as {
      machines: Array<{ timeline: Array<{ segments: Array<{ state: string; from: number; to: number }> }> }>;
    };
    const segs = read.machines[0]!.timeline[0]!.segments;
    // Mid-frame instants: segment edges are rounded to 0.1 ms, frame steps are thirds of 100.
    const stateAt = (t: number) => segs.find((x) => t >= x.from && t < x.to)?.state;
    const mid = SAMPLES.map((t) => t + 10);
    expect(mid.map((t) => (stateAt(t) === "Talking" ? "Open" : "Relaxed"))).toEqual(mid.map((t) => handOf(s.pip1, t)));

    // Instance 2: the trigger at 1 s waves for 600 ms, whatever its voice says.
    for (const t of [1000, 1300, 1550]) expect(handOf(s.pip2, t)).toBe("Wave");
    expect(handOf(s.pip1, 1300)).not.toBe("Wave");
    const after = SAMPLES.filter((t) => t > 1700);
    expect(after.map((t) => handOf(s.pip2, t))).toEqual(after.map((t) => (talking(s.voiceB, t) ? "Open" : "Relaxed")));
  });

  it("3D: a pose set eases a mesh's shape-key weight through evaluateWorld/evaluateGeometry, and the rig still bends the morphed mesh", async () => {
    const { ac, store, focusOn } = harness();
    const world = (await ac.world.create({ name: "Head 3D" })) as { frameId: string; objects: string[] };
    focusOn(world.frameId);
    const cube = world.objects[0]!;
    const VERT = 2;
    const open = (await ac.shapekey.create({ id: cube, name: "jawOpen", editable: true, verts: [{ index: VERT, dy: 40 }] })) as { id: string; path: string };
    const rig = (await ac.rig.create({ ids: [cube], name: "Head", bones: [{ name: "Neck", head: [0, 100, 0], tail: [0, -100, 0] }] })) as { rigId: string };
    const set = (await ac.poses.create({
      groupId: rig.rigId,
      name: "Mouth",
      vocabulary: "visemes",
      blend: { ms: 200, ease: "linear" },
      poses: [
        { name: "Rest", values: [{ clipId: cube, path: open.path, value: 0 }] },
        { name: "AI", values: [{ clipId: cube, path: open.path, value: 1 }] },
      ],
    })) as { setId: string };
    await ac.poses.key({ groupId: rig.rigId, set: set.setId, keys: [{ atMs: 0, pose: "Rest" }, { atMs: 500, pose: "AI" }] });

    const frameOf = () => store.getState().frames.find((f) => f.id === world.frameId)!;
    /** The world position of the keyed vertex, through the bake, the world walk and the geometry stack (skin included). */
    const vertexAt = (t: number) => {
      const baked = resolvedDocAt(store.getState(), t, world.frameId);
      const obj = evaluateWorld(baked, frameOf(), t).objects.find((o) => o.id === cube)!;
      const g = evaluateGeometry(obj.clip as MeshClip, obj.localMs, obj.skin ? { skin: obj.skin } : {});
      const p = g.mesh!.positions;
      return { at: transformPoint(obj.matrix, [p[VERT * 3]!, p[VERT * 3 + 1]!, p[VERT * 3 + 2]!]), key: g.key };
    };
    const rest = vertexAt(400);
    const half = vertexAt(600); // half way through the 200 ms linear blend
    const full = vertexAt(800);
    expect(half.key).not.toBe(rest.key); // not the unmorphed cache
    const d = (a: number[], b: number[]) => a.map((v, i) => v - b[i]!);
    const len = (v: number[]) => Math.hypot(...v);
    expect(len(d(full.at, rest.at))).toBeCloseTo(40, 3);
    expect(len(d(half.at, rest.at))).toBeCloseTo(20, 3);

    // Bend the neck: the rig acts on the MORPHED mesh (keys before bones) — the
    // morph's offset turns with the bone instead of being lost or applied twice.
    await ac.rig.pose({ rigId: rig.rigId, poses: [{ bone: "Neck", rotation: 30 }] });
    const bentRest = vertexAt(400);
    const bentFull = vertexAt(800);
    expect(len(d(bentRest.at, rest.at))).toBeGreaterThan(1);
    expect(len(d(bentFull.at, bentRest.at))).toBeCloseTo(40, 3);
    const dot = d(full.at, rest.at).reduce((s, v, i) => s + v * d(bentFull.at, bentRest.at)[i]!, 0) / (40 * 40);
    expect(dot).toBeLessThan(0.99); // turned with the bone
  });
});
