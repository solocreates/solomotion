import { describe, expect, it } from "vitest";
import {
  canConnect,
  coerce,
  connect,
  createGraph,
  createNode,
  defaultNodeRegistry as reg,
  disconnectInput,
  duplicateNodes,
  evaluateDriver,
  evaluateGraph,
  removeNodes,
  setNodeParam,
  socketKey,
  spliceNodeOnEdge,
  wouldCycle,
  type EvalContext,
} from "./index";
import { DOCUMENT_VERSION, createEmptyDocument, parseDocument, serializeDocument, type NodeGraph } from "..";

const ctx: EvalContext = { timeMs: 2000, fps: 30 };

/** Add a node at (0,0) and return its id — small helper for building graphs. */
function add(graph: NodeGraph, type: string): { graph: NodeGraph; id: string } {
  const node = createNode(reg, type, 0, 0)!;
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, id: node.id };
}

describe("socket coercion", () => {
  it("bridges the numeric family and is strict about strings", () => {
    expect(coerce(3, "float", "vec2")).toEqual({ x: 3, y: 3 });
    expect(coerce({ x: 4, y: 6 }, "vec2", "float")).toBe(5); // average
    expect(coerce(true, "bool", "float")).toBe(1);
    expect(coerce(1, "float", "color")).toBe("#ffffff");
    expect(canConnect("float", "color")).toBe(true);
    expect(canConnect("string", "float")).toBe(false);
    expect(canConnect("any", "float")).toBe(true);
  });
});

describe("evaluateGraph", () => {
  it("computes a value → math(×2) → output chain", () => {
    let g = createGraph();
    const v = add(g, "input.value");
    g = v.graph;
    const m = add(g, "math.op");
    g = m.graph;
    g = setNodeParam(g, v.id, "value", 21);
    g = setNodeParam(g, m.id, "operation", "multiply");
    g = setNodeParam(g, m.id, "b", 2);
    g = connect(reg, g, { node: v.id, socket: "value" }, { node: m.id, socket: "a" })!;

    const out = evaluateGraph(g, reg, ctx).outputs;
    expect(out.get(socketKey(m.id, "value"))).toBe(42);
  });

  it("map_range remaps and clamps", () => {
    let g = createGraph();
    const r = add(g, "math.map_range");
    g = r.graph;
    g = setNodeParam(g, r.id, "value", 5);
    g = setNodeParam(g, r.id, "fromMax", 10);
    g = setNodeParam(g, r.id, "toMax", 100);
    expect(evaluateGraph(g, reg, ctx).outputs.get(socketKey(r.id, "value"))).toBe(50);

    g = setNodeParam(g, r.id, "value", 999); // clamp on by default
    expect(evaluateGraph(g, reg, ctx).outputs.get(socketKey(r.id, "value"))).toBe(100);
  });

  it("reads the clock through time nodes", () => {
    let g = createGraph();
    const t = add(g, "time.seconds");
    g = t.graph;
    expect(evaluateGraph(g, reg, ctx).outputs.get(socketKey(t.id, "seconds"))).toBe(2);
  });

  it("breaks cycles with identity instead of hanging", () => {
    // Two math nodes wired a→b and b→a. Illegal to build via connect(), so we
    // craft the edges directly to prove the evaluator is cycle-safe regardless.
    let g = createGraph();
    const a = add(g, "math.op");
    g = a.graph;
    const b = add(g, "math.op");
    g = b.graph;
    g = {
      ...g,
      edges: [
        { id: "e1", from: { node: a.id, socket: "value" }, to: { node: b.id, socket: "a" } },
        { id: "e2", from: { node: b.id, socket: "value" }, to: { node: a.id, socket: "a" } },
      ],
    };
    const res = evaluateGraph(g, reg, ctx);
    expect(res.cyclic.size).toBeGreaterThan(0);
    expect(Number.isFinite(res.outputs.get(socketKey(a.id, "value")) as number)).toBe(true);
  });

  it("reads another layer's value through readProperty", () => {
    let g = createGraph();
    const p = add(g, "layer.property");
    g = p.graph;
    g = setNodeParam(g, p.id, "layer", "clip_hero");
    g = setNodeParam(g, p.id, "property", "opacity");
    const reads: Array<[string, string]> = [];
    const readCtx: EvalContext = {
      timeMs: 1000,
      fps: 30,
      readProperty: (clip, prop) => {
        reads.push([clip, prop]);
        return 0.5;
      },
    };
    expect(evaluateGraph(g, reg, readCtx).outputs.get(socketKey(p.id, "value"))).toBe(0.5);
    expect(reads).toEqual([["clip_hero", "opacity"]]);
  });
});

describe("evaluateDriver (expression result)", () => {
  it("returns the Output node's resolved input", () => {
    let g = createGraph("expr", "expression");
    const s = add(g, "time.seconds");
    g = s.graph;
    const m = add(g, "math.op");
    g = m.graph;
    const o = add(g, "output.value");
    g = o.graph;
    g = setNodeParam(g, m.id, "operation", "multiply");
    g = setNodeParam(g, m.id, "b", 90); // 90°/sec spin
    g = connect(reg, g, { node: s.id, socket: "seconds" }, { node: m.id, socket: "a" })!;
    g = connect(reg, g, { node: m.id, socket: "value" }, { node: o.id, socket: "value" })!;
    // ctx.timeMs = 2000 → 2s × 90 = 180
    expect(evaluateDriver(g, reg, ctx)).toBe(180);
  });

  it("is undefined without an Output node", () => {
    const g = createGraph();
    expect(evaluateDriver(g, reg, ctx)).toBeUndefined();
  });
});

describe("graph ops", () => {
  it("connect refuses cycles and type-incompatible wires; input holds one edge", () => {
    let g = createGraph();
    const a = add(g, "input.value");
    g = a.graph;
    const b = add(g, "math.op");
    g = b.graph;
    const c = add(g, "input.value");
    g = c.graph;

    // a.value → b.a, then c.value → b.a should REPLACE (input holds one edge).
    g = connect(reg, g, { node: a.id, socket: "value" }, { node: b.id, socket: "a" })!;
    g = connect(reg, g, { node: c.id, socket: "value" }, { node: b.id, socket: "a" })!;
    expect(g.edges.filter((e) => e.to.node === b.id && e.to.socket === "a")).toHaveLength(1);
    expect(g.edges.find((e) => e.to.node === b.id)!.from.node).toBe(c.id);

    // c already feeds b, so wiring b back into c would close a loop → refused.
    expect(wouldCycle(g, b.id, c.id)).toBe(true);
    expect(connect(reg, g, { node: b.id, socket: "value" }, { node: c.id, socket: "value" })).toBeNull();
    // A node may never wire into itself.
    const looped = connect(reg, g, { node: b.id, socket: "value" }, { node: b.id, socket: "b" });
    expect(looped).toBeNull();
  });

  it("splices a node onto an existing wire", () => {
    let g = createGraph();
    const a = add(g, "input.value");
    g = a.graph;
    const o = add(g, "output.value");
    g = o.graph;
    g = connect(reg, g, { node: a.id, socket: "value" }, { node: o.id, socket: "value" })!;
    const edgeId = g.edges[0]!.id;

    const m = add(g, "math.op");
    g = m.graph;
    const spliced = spliceNodeOnEdge(reg, g, edgeId, m.id)!;
    // Old edge gone; two new edges a→m and m→o.
    expect(spliced.edges.find((e) => e.id === edgeId)).toBeUndefined();
    expect(spliced.edges.some((e) => e.from.node === a.id && e.to.node === m.id)).toBe(true);
    expect(spliced.edges.some((e) => e.from.node === m.id && e.to.node === o.id)).toBe(true);
  });

  it("duplicates nodes with their internal wiring, offset", () => {
    let g = createGraph();
    const a = add(g, "input.value");
    g = a.graph;
    const b = add(g, "math.op");
    g = b.graph;
    g = connect(reg, g, { node: a.id, socket: "value" }, { node: b.id, socket: "a" })!;

    const dup = duplicateNodes(g, [a.id, b.id], 40, 40);
    expect(dup.graph.nodes).toHaveLength(4);
    expect(dup.graph.edges).toHaveLength(2); // internal edge cloned
    const cloneA = dup.graph.nodes.find((n) => n.id === dup.idMap.get(a.id))!;
    expect(cloneA.x).toBe(40);
  });

  it("removeNodes drops touching edges; disconnectInput detaches", () => {
    let g = createGraph();
    const a = add(g, "input.value");
    g = a.graph;
    const b = add(g, "math.op");
    g = b.graph;
    g = connect(reg, g, { node: a.id, socket: "value" }, { node: b.id, socket: "a" })!;

    expect(disconnectInput(g, b.id, "a").edges).toHaveLength(0);
    expect(removeNodes(g, [a.id]).edges).toHaveLength(0);
    expect(removeNodes(g, [a.id]).nodes).toHaveLength(1);
  });
});

describe("document persistence", () => {
  it("round-trips graphs and defaults them on legacy docs", () => {
    const doc = createEmptyDocument("nodes");
    let g = createGraph("Driver", "expression");
    const v = createNode(reg, "input.value", 10, 20)!;
    g = { ...g, nodes: [v] };
    doc.graphs = [g];

    const restored = parseDocument(serializeDocument(doc));
    expect(restored.graphs).toHaveLength(1);
    expect(restored.graphs[0]!.nodes[0]!.type).toBe("input.value");
    // Version-agnostic on purpose: a round-trip must land on CURRENT, so a
    // future schema bump does not have to come back and edit this line.
    expect(restored.version).toBe(DOCUMENT_VERSION);

    // A v40 doc with no `graphs` field parses to an empty table (migration + default).
    const legacy = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    legacy.version = 40;
    delete legacy.graphs;
    expect(parseDocument(JSON.stringify(legacy)).graphs).toEqual([]);
  });
});
