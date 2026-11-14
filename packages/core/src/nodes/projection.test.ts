import { describe, expect, it } from "vitest";
import {
  clipAnimatableProperties,
  createGraph,
  createNode,
  defaultNodeRegistry as reg,
  evaluateClipPose,
  evaluateDriver,
  evaluateGraph,
  exprToken,
  getClipProperty,
  parseDriverToken,
  resolveClipDrivers,
  resolveDocumentDrivers,
  socketKey,
  type DriverEnv,
  type EvalContext,
  type NodeGraph,
  type NodeParam,
  type Clip,
} from "..";
import { createTextClip } from "../factories";

const textClip: Clip = createTextClip({ frameId: "f1", text: "Hi", startMs: 0 });

/** A describeClip hook over a fixed set of clips. */
const describeClip = (id: string) => (id === textClip.id ? clipAnimatableProperties(textClip) : []);

/** Add a node and return {graph,id}. */
function add(graph: NodeGraph, type: string, params: Record<string, NodeParam> = {}): { graph: NodeGraph; id: string } {
  const node = createNode(reg, type, 0, 0)!;
  node.params = { ...node.params, ...params };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, id: node.id };
}

describe("clipAnimatableProperties (native enumeration)", () => {
  it("lists a text clip's transform + typography paths from the registry", () => {
    const props = clipAnimatableProperties(textClip);
    const paths = props.map((p) => p.path);
    expect(paths).toContain("x");
    expect(paths).toContain("opacity");
    expect(paths).toContain("rotation");
    expect(paths).toContain("fontSize"); // typography, text-only
    expect(paths).toContain("color");
    // Audio-only props never leak onto a text clip.
    expect(paths).not.toContain("gain");
  });

  it("grows sockets when the data structure changes (a new effect)", () => {
    const withShadow = {
      ...textClip,
      effects: [{ id: "lfxA", type: "shadow", enabled: true, color: "#000", x: 0, y: 8, blur: 24 }],
    } as Clip;
    const paths = clipAnimatableProperties(withShadow).map((p) => p.path);
    expect(paths).toContain("lfx.lfxA.blur");
    expect(paths).toContain("lfx.lfxA.x");
    // No table was touched — the enumerator read the live effect list.
  });
});

describe("Object node dynamic sockets", () => {
  it("projects one output+input socket per property of the target", () => {
    // The main "Layer" handle is ONE-SIDED by role: a source (object.layer)
    // BROADCASTS it on the output; an operator (object.transform) RECEIVES it on
    // the input. Every property is a combined output+input row on either.
    const source = createNode(reg, "object.layer", 0, 0)!;
    source.params.target = textClip.id;
    const outs = reg.outputsOf(source, { describeClip });
    const ins = reg.inputsOf(source, { describeClip });
    expect(outs[0]!.key).toBe("self"); // source leads its OUTPUT with Layer
    expect(ins.map((s) => s.key)).not.toContain("self"); // …but not its input
    const outProps = outs.slice(1).map((s) => s.key);
    expect(outProps).toContain("x");
    expect(outProps).toContain("opacity");
    expect(ins.map((s) => s.key)).toEqual(outProps); // read + write are the same set
    // Each socket carries its property path (the driver sink) + a socket type.
    const opacity = outs.find((s) => s.key === "opacity")!;
    expect(opacity.path).toBe("opacity");
    expect(opacity.type).toBe("float");

    // An operator leads its INPUT with Layer (and never its output).
    const op = createNode(reg, "object.transform", 0, 0)!;
    op.params.target = textClip.id;
    expect(reg.inputsOf(op, { describeClip })[0]!.key).toBe("self");
    expect(reg.outputsOf(op, { describeClip }).map((s) => s.key)).not.toContain("self");
  });

  it("still exposes canonical value-holder fields before it's bound", () => {
    // Unbound, a projection node falls back to its category's STATIC registry
    // fields, so it means something (holds/feeds values) with no layer attached.
    const op = createNode(reg, "object.transform", 0, 0)!; // no target
    const inKeys = reg.inputsOf(op, { describeClip }).map((s) => s.key);
    const outKeys = reg.outputsOf(op, { describeClip }).map((s) => s.key);
    expect(inKeys[0]).toBe("self"); // operator leads its input with Layer
    expect(inKeys).toContain("x");
    expect(inKeys).toContain("opacity");
    expect(outKeys).toContain("x"); // read + write, no main handle on the output
    expect(outKeys).not.toContain("self");
    // EVERY category is meaningful unbound — even instance-based ones. Paint's
    // canonical fields come from a PROTOTYPE enumerated through the SAME walker,
    // so the WHOLE surface is present (solid fill, gradient stops, stroke width)
    // with nothing hand-listed.
    const paint = createNode(reg, "object.fill", 0, 0)!;
    const paintIn = reg.inputsOf(paint, { describeClip }).map((s) => s.key);
    expect(paintIn[0]).toBe("self");
    expect(paintIn).toContain("fill.solid"); // a solid fill's color
    expect(paintIn).toContain("stroke.stroke.width"); // stroke width
    expect(paintIn.some((k) => k.includes("stop"))).toBe(true); // gradient stops
  });

  it("reads live values through readProperty at eval time", () => {
    let g = createGraph("g", "board", null);
    const obj = add(g, "object.layer", { target: textClip.id });
    g = obj.graph;
    const ctx: EvalContext = {
      timeMs: 0,
      fps: 30,
      describeClip,
      readProperty: (_id, path) => (path === "opacity" ? 0.42 : undefined),
    };
    const evald = evaluateGraph(g, reg, ctx);
    expect(evald.outputs.get(socketKey(obj.id, "opacity"))).toBe(0.42);
  });
});

describe("clipAnimatableProperties (per-INSTANCE narrowing)", () => {
  const shapeOf = (shape: string, extra: Record<string, unknown> = {}) =>
    ({
      ...textClip,
      id: `s_${shape}`,
      kind: "shape",
      shape,
      width: 100,
      height: 100,
      radius: 0,
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      pointCount: 5,
      innerRatio: 0.5,
      ...extra,
    }) as unknown as Clip;

  const paths = (clip: Clip) => clipAnimatableProperties(clip).map((p) => p.path);

  it("offers a rectangle ONE way to round a corner, not four", () => {
    // `shapeCommands` reads `radius.tl..bl` for a rect, `radius` for a
    // polygon/star, and the layer box's `borderRadius` never runs for a shape at
    // all. Offering all three made "wire a node into corner radius" a coin flip.
    const p = paths(shapeOf("rect"));
    expect(p).toContain("radius.tl");
    expect(p).not.toContain("radius");
    expect(p).not.toContain("borderRadius");
    expect(p).not.toContain("borderRadius.tl");
    // Nor the knobs only a polygon, a star or an ellipse reads.
    expect(p).not.toContain("pointCount");
    expect(p).not.toContain("arcSweepDeg");
  });

  it("offers a star its own knobs and no rect corners", () => {
    const p = paths(shapeOf("star"));
    expect(p).toContain("radius");
    expect(p).toContain("pointCount");
    expect(p).toContain("innerRatio");
    expect(p).not.toContain("radius.tl");
    expect(p).not.toContain("arcSweepDeg");
  });

  it("offers an ellipse its arc, and a polygon no inner ratio", () => {
    expect(paths(shapeOf("ellipse"))).toContain("arcSweepDeg");
    expect(paths(shapeOf("ellipse"))).not.toContain("pointCount");
    expect(paths(shapeOf("polygon"))).not.toContain("innerRatio");
    expect(paths(shapeOf("polygon"))).toContain("radius");
  });

  it("leaves every other clip kind alone", () => {
    const p = paths(textClip);
    expect(p).toContain("borderRadius");
    expect(p).toContain("opacity");
  });
});

describe("driver tokens", () => {
  it("round-trips a plain and a sink token", () => {
    expect(parseDriverToken(exprToken("g1"))).toEqual({ graphId: "g1" });
    const sink = { node: "node_ab", socket: "fill.p1.color" };
    expect(parseDriverToken(exprToken("g1", sink))).toEqual({ graphId: "g1", sink });
  });
  it("rejects non-driver values", () => {
    expect(parseDriverToken("var:x")).toBeNull();
    expect(parseDriverToken(42)).toBeNull();
  });
});

describe("driver evaluation + baking", () => {
  function envFor(graphs: NodeGraph[]): DriverEnv {
    return { graphs, registry: reg, fps: 30, readProperty: () => undefined, describeClip };
  }

  /** A graph whose Output-node expression emits one constant value. */
  function constantGraph(value: number): NodeGraph {
    let g = createGraph("g", "expression", textClip.id);
    const inp = add(g, "input.value", { value });
    g = inp.graph;
    const out = add(g, "output.value");
    g = out.graph;
    return { ...g, edges: [{ id: "e1", from: { node: inp.id, socket: "value" }, to: { node: out.id, socket: "value" } }] };
  }

  it("Output-node expression drives a value", () => {
    const g = constantGraph(0.25);
    expect(evaluateDriver(g, reg, { timeMs: 0, fps: 30 })).toBe(0.25);

    const driven = { ...textClip, drivers: { opacity: exprToken(g.id) } } as Clip;
    const baked = resolveClipDrivers(driven, 0, envFor([g]));
    expect(getClipProperty(baked, "opacity")).toBe(0.25);
  });

  it("the bake WINS over a keyframe on the same property", () => {
    // A driver owns its property outright, so the track has to go — leaving it
    // would let `sampleKeyframes` overwrite the baked value further downstream
    // and the driver would appear to do nothing at all.
    const g = constantGraph(0.3);
    const driven = {
      ...textClip,
      drivers: { opacity: exprToken(g.id) },
      keyframes: [
        { property: "opacity", keys: [{ id: "k1", timeMs: 0, value: 1, easing: "linear" }] },
        { property: "x", keys: [{ id: "k2", timeMs: 0, value: 12, easing: "linear" }] },
      ],
    } as unknown as Clip;

    const baked = resolveClipDrivers(driven, 0, envFor([g]));
    expect(getClipProperty(baked, "opacity")).toBe(0.3);
    expect(baked.keyframes.some((t) => t.property === "opacity")).toBe(false);
    // An UNdriven property keeps its animation — the bake is surgical.
    expect(baked.keyframes.some((t) => t.property === "x")).toBe(true);
    expect(evaluateClipPose(baked as never, 0).opacity).toBe(0.3);
  });

  it("leaves the stored value alone when a driver resolves to nothing", () => {
    // A deleted graph, a broken expression, an unwired socket: the field keeps
    // the last thing that made sense rather than snapping to zero.
    const orphan = { ...textClip, opacity: 0.8, drivers: { opacity: exprToken("gone") } } as Clip;
    const baked = resolveClipDrivers(orphan, 0, envFor([]));
    expect(baked).toBe(orphan);
    expect(getClipProperty(baked, "opacity")).toBe(0.8);
  });

  it("returns undriven clips BY REFERENCE", () => {
    // The whole editor memoises on clip identity, so cloning unconditionally
    // would re-render every surface on every frame of playback.
    const env = envFor([]);
    expect(resolveClipDrivers(textClip, 0, env)).toBe(textClip);
    const emptyMap = { ...textClip, drivers: {} } as Clip;
    expect(resolveClipDrivers(emptyMap, 0, env)).toBe(emptyMap);
  });

  it("resolves a whole document, keeping untouched tracks identical", () => {
    const g = constantGraph(0.5);
    const driven = { ...textClip, id: "c_driven", drivers: { opacity: exprToken(g.id) } } as Clip;
    const plain = { ...textClip, id: "c_plain" } as Clip;
    const doc = {
      graphs: [g],
      tracks: [
        { id: "t1", clips: [driven] },
        { id: "t2", clips: [plain] },
      ],
    } as never as Parameters<typeof resolveDocumentDrivers>[0];

    const out = resolveDocumentDrivers(doc, 0, envFor([g]));
    expect(getClipProperty(out.tracks[0]!.clips[0]!, "opacity")).toBe(0.5);
    expect(out.tracks[1]).toBe(doc.tracks[1]);
    // Scoped to one comp, a clip in another frame is left exactly as it was.
    const scoped = resolveDocumentDrivers(doc, 0, envFor([g]), "other-frame");
    expect(scoped).toBe(doc);
  });

  it("Object-node sink socket drives the wired-in value", () => {
    // Graph: input.value(0.7) → object.layer[opacity input]
    let g = createGraph("g", "board", textClip.id);
    const inp = add(g, "input.value", { value: 0.7 });
    g = inp.graph;
    const obj = add(g, "object.layer", { target: textClip.id });
    g = obj.graph;
    g = {
      ...g,
      edges: [{ id: "e1", from: { node: inp.id, socket: "value" }, to: { node: obj.id, socket: "opacity" } }],
    };

    const token = exprToken(g.id, { node: obj.id, socket: "opacity" });
    const driven = { ...textClip, drivers: { opacity: token } } as Clip;
    expect(getClipProperty(resolveClipDrivers(driven, 0, envFor([g])), "opacity")).toBe(0.7);
  });
});
