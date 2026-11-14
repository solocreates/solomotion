import { describe, expect, it } from "vitest";
// The package entry first: it fixes the module order the app uses (a deep
// import of factories first evaluates retime before the property registry).
import "../index";
import type { MotionDocument, Clip, Frame, NestedClip, ShapeClip } from "../schema";
import { inputToken } from "../schema/inputs";
import { createEmptyDocument, createFrame, createNestedClip, createShapeClip, createTrack } from "../factories";
import { getClipProperty, setClipProperty } from "../animation/paths";
import { clipAnimatableProperties } from "../animation/clip-properties";
import { writeChannel } from "../animation/channels";
import { resolveDocumentDrivers } from "../nodes/resolve-clip";
import { defaultNodeRegistry } from "../nodes";
import type { DriverEnv } from "../nodes/drivers";
import { withExpressionContext } from "../expressions/bind";
import { resolveFxToken } from "../expressions/scope";
import { evaluateExpressionRaw } from "../expressions/bind";
import type { ExprContext, ExprInstanceScope } from "../expressions/globals";
import type { ExprLayerApi } from "../expressions/layer-api";
import { addVariant, makeComponentFromFrame } from "../components";
import { locateClip } from "../timeline/ops";
import { parseSource } from "../binding/source";
import {
  documentHasInputs,
  frameInstanceScope,
  inputFiredBetween,
  instanceScope,
  readInput,
  resolveScopedLayer,
  scopeCacheKey,
  type InstanceScope,
} from "./inputs";
import { defineInput, exposeAsInput, inputBindings, keyableVariants, removeInput } from "./inputs-ops";
import { inputPath } from "./inputs-fields";
import "./inputs-function";

// ── Fixture: a character comp with inputs, two instances of it on a scene ──

function lane(doc: MotionDocument, clip: Clip) {
  const t = createTrack(clip.name);
  t.clips.push(clip);
  doc.tracks.push(t);
  return clip;
}

function scene() {
  const doc = createEmptyDocument();
  const root = doc.frames[0]!;
  const master = createFrame({ name: "Character", width: 200, height: 200 });
  doc.frames.push(master);
  makeComponentFromFrame(doc, master.id);
  const size = defineInput(doc, master.id, { name: "Size", type: "number", default: 1, min: 0, max: 4 });
  const mood = defineInput(doc, master.id, { name: "Mood", type: "enum", options: ["Happy", "Sad"] });
  const wave = defineInput(doc, master.id, { name: "Wave", type: "trigger" });
  const body = lane(doc, { ...createShapeClip({ frameId: master.id, shape: "rect", startMs: 0, durationMs: 4000, width: 50, height: 50 }), name: "Body" }) as ShapeClip;
  body.drivers = { scale: inputToken(size.id) };
  const inst = (name: string, x: number) =>
    lane(doc, { ...createNestedClip({ frameId: root.id, sourceFrameId: master.id, startMs: 0, durationMs: 4000, x, y: 0 }), name }) as NestedClip;
  const a = inst("A", -200);
  const b = inst("B", 200);
  return { doc, root, master, size, mood, wave, body, a, b };
}

/** The app's bake, from core parts: drivers of ONE comp, in ONE scope. */
function bakeComp(doc: MotionDocument, compId: string, scope: InstanceScope | null, timeMs = 0): MotionDocument {
  const read = (id: string) => readInput(doc, scope, compId, id);
  const env: DriverEnv = {
    graphs: [],
    registry: defaultNodeRegistry,
    fps: 30,
    readProperty: () => undefined,
    describeClip: () => [],
    readInput: read,
    expressions: { table: doc.expressions, variables: doc.variables, sample: () => 0 },
  };
  return withExpressionContext(ctxFor(doc, compId, scope, timeMs), () => resolveDocumentDrivers(doc, timeMs, env, compId));
}

function ctxFor(doc: MotionDocument, compId: string, scope: ExprInstanceScope | null, timeMs = 0): ExprContext {
  return { timeMs, fps: 30, comp: null, layer: null, playing: false, seed: 0, compId, scope, readInput: (n) => readInput(doc, scope, compId, n) };
}

const bodyIn = (doc: MotionDocument, id: string) => doc.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;

describe("component inputs — the instance scope", () => {
  it("two instances with different keyed inputs bake different pictures at the same instant", () => {
    const { doc, master, size, body, a, b } = scene();
    writeChannel(a, inputPath(size.id), 0, 2, { forceKey: true });
    writeChannel(a, inputPath(size.id), 1000, 3, { forceKey: true });
    writeChannel(b, inputPath(size.id), 0, 0.5, { forceKey: true });
    const sa = instanceScope(doc, a, 500, null)!;
    const sb = instanceScope(doc, b, 500, null)!;
    expect(sa.values[size.id]).toBeCloseTo(2.5, 6);
    expect(sb.values[size.id]).toBe(0.5);
    expect(scopeCacheKey(doc, master.id, sa)).not.toBe(scopeCacheKey(doc, master.id, sb));
    expect(getClipProperty(bodyIn(bakeComp(doc, master.id, sa), body.id), "scale")).toBeCloseTo(2.5, 6);
    expect(getClipProperty(bodyIn(bakeComp(doc, master.id, sb), body.id), "scale")).toBe(0.5);
  });

  it("equal inputs share one key — defaults share the master's own (empty) key", () => {
    const { doc, master, size, mood, a, b } = scene();
    expect(scopeCacheKey(doc, master.id, instanceScope(doc, a, 0, null))).toBe("");
    setClipProperty(a, inputPath(size.id), 2);
    setClipProperty(b, inputPath(size.id), 2);
    setClipProperty(a, inputPath(mood.id), "Sad");
    setClipProperty(b, inputPath(mood.id), "sad"); // coerced to the option
    const ka = scopeCacheKey(doc, master.id, instanceScope(doc, a, 0, null));
    expect(ka).not.toBe("");
    expect(scopeCacheKey(doc, master.id, instanceScope(doc, b, 0, null))).toBe(ka);
  });

  it("the master edited directly reads the defaults", () => {
    const { doc, master, size, mood, body } = scene();
    expect(readInput(doc, null, master.id, "Size")).toBe(1);
    expect(readInput(doc, null, master.id, "mood")).toBe("Happy");
    expect(readInput(doc, null, master.id, "Nope")).toBeUndefined();
    expect(getClipProperty(bodyIn(bakeComp(doc, master.id, null), body.id), "scale")).toBe(1);
    expect(size.default).toBe(1);
    expect(mood.default).toBe("Happy");
  });

  it("inputs run on the instance's OUTER clock, not the looped/sped inner time", () => {
    const { doc, size, a } = scene();
    a.playback = { ...a.playback, speed: 2 };
    writeChannel(a, inputPath(size.id), 0, 0, { forceKey: true });
    writeChannel(a, inputPath(size.id), 1000, 1, { forceKey: true });
    // Whatever the comp inside is showing, the input reads the clip's own 500 ms.
    expect(instanceScope(doc, a, 500, null)!.values[size.id]).toBeCloseTo(0.5, 6);
    // History reads re-sample the same outer channel at another outer instant.
    expect(readInput(doc, instanceScope(doc, a, 500, null), null, "Size", 250)).toBe(instanceScope(doc, a, 250, null)!.values[size.id]);
  });

  it("a trigger fires exactly on the frame of its key, and nowhere else", () => {
    const { doc, wave, a } = scene();
    writeChannel(a, inputPath(wave.id), 1000, true, { forceKey: true });
    const step = 1000 / 30;
    expect(instanceScope(doc, a, 1000, null)!.values[wave.id]).toBe(true);
    expect(instanceScope(doc, a, 1000 - step, null)!.values[wave.id]).toBe(false);
    expect(instanceScope(doc, a, 1000 + step, null)!.values[wave.id]).toBe(false);
    const s = instanceScope(doc, a, 1000, null);
    expect(inputFiredBetween(doc, s, "Wave", 1000 - step, 1000)).toBe(true);
    expect(inputFiredBetween(doc, s, "Wave", 1000, 1000 + step)).toBe(false);
  });

  it("an instance inside an instance: the inner input bound to the outer one, through the chain", () => {
    const { doc, master, size, body, a } = scene();
    // A "Pair" component holding one Character instance whose Size is bound to Pair's Scale.
    const pair = createFrame({ name: "Pair", width: 400, height: 200 });
    doc.frames.push(pair);
    makeComponentFromFrame(doc, pair.id);
    const scale = defineInput(doc, pair.id, { name: "Scale", type: "number", default: 1 });
    const inner = lane(doc, { ...createNestedClip({ frameId: pair.id, sourceFrameId: master.id, startMs: 0, durationMs: 4000, x: 0, y: 0 }), name: "Inner" }) as NestedClip;
    inner.drivers = { [inputPath(size.id)]: inputToken(scale.id) };
    a.sourceFrameId = pair.id;
    writeChannel(a, inputPath(scale.id), 0, 3, { forceKey: true });
    writeChannel(a, inputPath(scale.id), 2000, 1, { forceKey: true });

    const outer = instanceScope(doc, a, 0, null)!;
    const pairBaked = bakeComp(doc, pair.id, outer);
    const innerBaked = bodyIn(pairBaked, inner.id) as NestedClip;
    expect(innerBaked.inputValues?.[size.id]).toBe(3);
    const chain = instanceScope(pairBaked, innerBaked, 0, outer)!;
    expect(chain.parent).toBe(outer);
    expect(getClipProperty(bodyIn(bakeComp(doc, master.id, chain), body.id), "scale")).toBe(3);
    // History through the binding: the inner reader asks the outer scope.
    expect(readInput(doc, chain, master.id, "Size", 1000)).toBeCloseTo(2, 6);
  });

  it("a linked instance FRAME values its master's inputs with static overrides", () => {
    const { doc, master, size } = scene();
    const linked = createFrame({ name: "Copy" });
    linked.instanceOf = master.id;
    linked.inputValues = { [size.id]: 0.25 };
    doc.frames.push(linked);
    const s = frameInstanceScope(doc, linked, 0, null)!;
    expect(s.frameId).toBe(master.id);
    expect(readInput(doc, s, master.id, "Size")).toBe(0.25);
  });
});

describe("component inputs — caches and performance", () => {
  it("a hundred instances with equal inputs bake their comp ONCE per instant", () => {
    const { doc, root, master, size } = scene();
    for (let i = 0; i < 98; i++) {
      const c = lane(doc, { ...createNestedClip({ frameId: root.id, sourceFrameId: master.id, startMs: 0, durationMs: 4000, x: i, y: 0 }), name: `I${i}` }) as NestedClip;
      setClipProperty(c, inputPath(size.id), 2);
    }
    for (const t of doc.tracks) for (const c of t.clips) if (c.kind === "nested") setClipProperty(c, inputPath(size.id), 2);
    const memo = new Map<string, MotionDocument>();
    let bakes = 0;
    const instances = doc.tracks.flatMap((t) => t.clips).filter((c): c is NestedClip => c.kind === "nested");
    expect(instances).toHaveLength(100);
    for (const t of [0, 33, 66]) {
      for (const c of instances) {
        const s = instanceScope(doc, c, t, null);
        const key = `${master.id}@${t}|${scopeCacheKey(doc, master.id, s)}`;
        if (!memo.has(key)) {
          bakes++;
          memo.set(key, bakeComp(doc, master.id, s, t));
        }
      }
    }
    expect(bakes).toBe(3);
  });

  it("a crowd does not blink in unison: seeded randomness is per instance, and keys follow", () => {
    const { doc, master, body, a, b } = scene();
    doc.expressions.push({ id: "fx1", source: "random()", name: "" } as MotionDocument["expressions"][number]);
    body.drivers = { ...body.drivers, opacity: "fx:fx1" };
    const sa = instanceScope(doc, a, 0, null)!;
    const sb = instanceScope(doc, b, 0, null)!;
    const at = (s: InstanceScope) =>
      withExpressionContext(ctxFor(doc, master.id, s), () => resolveFxToken("fx:fx1", doc.expressions, doc.variables, () => 0, null));
    expect(at(sa)).not.toBe(at(sb));
    expect(at(sa)).toBe(at(instanceScope(doc, a, 0, null)!));
    // Equal (default) inputs, but the picture holds per-instance dice: keys differ.
    expect(scopeCacheKey(doc, master.id, sa)).not.toBe(scopeCacheKey(doc, master.id, sb));
  });

  it("settled-doc memo: measure BEFORE on a structuredClone (memos are keyed by identity)", () => {
    const { doc, master } = scene();
    const plain = structuredClone(doc) as MotionDocument;
    for (const f of plain.frames) delete f.inputs;
    for (const t of plain.tracks) for (const c of t.clips) delete c.drivers;
    const before = documentHasInputs(structuredClone(plain));
    plain.frames.find((f) => f.id === master.id)!.inputs = [{ id: "x", name: "X", type: "bool", default: false }];
    expect(before).toBe(false);
    expect(documentHasInputs(plain)).toBe(true);
  });
});

describe("component inputs — authoring", () => {
  it("expose as input names, types and binds the field from what it shows", () => {
    const { doc, body } = scene();
    setClipProperty(body, "opacity", 0.6);
    const { frameId, input } = exposeAsInput(doc, body.id, "opacity");
    expect(input).toMatchObject({ name: "Opacity", type: "number", default: 0.6 });
    expect(parseSource(body.drivers!.opacity)).toEqual({ kind: "input", id: input.id });
    expect(inputBindings(doc, frameId, input.id)).toEqual([{ clipId: body.id, path: "opacity" }]);
    // Exposing it again finds the same input.
    expect(exposeAsInput(doc, body.id, "opacity").input.id).toBe(input.id);
  });

  it("an instance lists its inputs as ordinary, typed, settable paths", () => {
    const { doc, size, mood, a } = scene();
    const props = clipAnimatableProperties(a, doc).filter((p) => p.groupId === "inputs");
    expect(props.map((p) => p.path)).toEqual([inputPath(size.id), inputPath(mood.id), expect.stringMatching(/^input\./)]);
    expect(props[1]!.def.kind).toBe("discrete");
    setClipProperty(a, inputPath(mood.id), "Sad");
    expect(getClipProperty(a, inputPath(mood.id))).toBe("Sad");
  });

  it("deleting an input with keys and bindings unbinds cleanly", () => {
    const { doc, master, size, body, a, b } = scene();
    writeChannel(a, inputPath(size.id), 0, 2, { forceKey: true });
    setClipProperty(b, inputPath(size.id), 3);
    const linked = createFrame({ name: "Copy" });
    linked.instanceOf = master.id;
    linked.inputValues = { [size.id]: 2 };
    doc.frames.push(linked);
    expect(removeInput(doc, master.id, size.id)).toBe(1);
    expect(body.drivers?.scale).toBeUndefined();
    expect(getClipProperty(body, "scale")).toBe(1); // what the master showed
    expect(a.keyframes.some((t) => t.property === inputPath(size.id))).toBe(false);
    expect(b.inputValues?.[size.id]).toBeUndefined();
    expect(linked.inputValues?.[size.id]).toBeUndefined();
    expect(readInput(doc, instanceScope(doc, a, 0, null), master.id, "Size")).toBeUndefined();
  });

  it("keyable variants: a Choice input drives a switch of the set's variants", () => {
    const { doc, master, a } = scene();
    addVariant(doc, master.id, "Angry");
    const made = keyableVariants(doc, master.id)!;
    const frame = doc.frames.find((f) => f.id === made.frameId) as Frame;
    const input = frame.inputs!.find((d) => d.id === made.inputId)!;
    expect(input.type).toBe("enum");
    expect(input.options).toEqual(["Main", "Angry"]);
    const sw = locateClip(doc, made.switchId)!.clip;
    expect(parseSource(sw.drivers!.switch)).toEqual({ kind: "input", id: input.id });
    a.sourceFrameId = frame.id;
    writeChannel(a, inputPath(input.id), 0, "Main", { forceKey: true });
    writeChannel(a, inputPath(input.id), 1000, "Angry", { forceKey: true });
    const baked = bakeComp(doc, frame.id, instanceScope(doc, a, 1500, null));
    expect(getClipProperty(locateClip(baked, made.switchId)!.clip, "switch")).toBe("Angry");
  });
});

describe("component inputs — expressions and layer references", () => {
  it("input(\"Mood\") reads the instance on screen, and the default without one", () => {
    const { doc, master, mood, a } = scene();
    setClipProperty(a, inputPath(mood.id), "Sad");
    const scope: { ctx: ExprContext; readVariable: () => undefined } = { ctx: ctxFor(doc, master.id, instanceScope(doc, a, 0, null)), readVariable: () => undefined };
    expect(evaluateExpressionRaw('input("Mood")', scope)?.value).toBe("Sad");
    expect(evaluateExpressionRaw('input("Mood")', { ctx: ctxFor(doc, master.id, null), readVariable: () => undefined })?.value).toBe("Happy");
  });

  it("a layer input resolves in the comp the instance sits in", () => {
    const { doc, root, master, a, b } = scene();
    const voice = defineInput(doc, master.id, { name: "Voice", type: "layer" });
    setClipProperty(a, inputPath(voice.id), "Line A");
    setClipProperty(b, inputPath(voice.id), "Line B");
    const api = (names: Record<string, string>): ExprLayerApi => ({
      idFor: (n) => names[n],
      nameOf: (id) => Object.keys(names).find((k) => names[k] === id),
      propertiesOf: () => [],
      read: () => undefined,
      all: () => [],
    });
    const rootLayers = api({ "Line A": "clipA", "Line B": "clipB" });
    for (const [inst, want] of [[a, "clipA"], [b, "clipB"]] as const) {
      const s = instanceScope(doc, inst, 500, null)!;
      const ctx: ExprContext = { ...ctxFor(doc, master.id, s), layers: api({}), layersIn: (compId) => (compId === root.id ? rootLayers : undefined) };
      const ref = resolveScopedLayer(ctx, String(readInput(doc, s, master.id, "Voice")));
      expect(ref).toMatchObject({ clipId: want, compId: root.id, timeMs: 500 });
    }
  });

  it("documentHasInputs gates the bake", () => {
    expect(documentHasInputs(createEmptyDocument())).toBe(false);
    expect(documentHasInputs(scene().doc)).toBe(true);
  });
});
