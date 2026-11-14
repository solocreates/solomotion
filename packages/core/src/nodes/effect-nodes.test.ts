import { describe, expect, it } from "vitest";
import { LAYER_EFFECT_TYPES } from "../animation/layer-effects";
import { createGraph, createNode } from "./graph-ops";
import { defaultNodeRegistry } from "./builtin";
import {
  EFFECTS_HUB_TYPE,
  FX_SOCKET_KEY,
  effectNodeType,
  isEffectNodeType,
  syncEffectNodes,
  type EffectStackView,
} from "./effect-nodes";
import { MAIN_SOCKET_KEY } from "./projection";
import type { GraphNode, NodeGraph } from "../schema";

const hub = (id: string, target: string): GraphNode => ({
  id,
  type: EFFECTS_HUB_TYPE,
  x: 0,
  y: 0,
  params: { target },
  collapsed: false,
  groupId: null,
});

const stack = (ids: Array<[string, string]>): EffectStackView[] => [
  { clipId: "clip", effects: ids.map(([id, type]) => ({ id, type })) },
];

const cardsOf = (g: NodeGraph) =>
  g.nodes.filter((n) => isEffectNodeType(n.type)).map((n) => String(n.params.effect));

/** The chain order, read the way the board draws it: hub → card → card. */
const chainOrder = (g: NodeGraph, hubId: string): string[] => {
  const out: string[] = [];
  let cursor = hubId;
  for (;;) {
    const e = g.edges.find((x) => x.from.node === cursor && x.from.socket === FX_SOCKET_KEY);
    if (!e) return out;
    const n = g.nodes.find((x) => x.id === e.to.node)!;
    out.push(String(n.params.effect));
    cursor = n.id;
  }
};

describe("effect nodes", () => {
  it("registers one node type per layer effect, hidden from the palette", () => {
    const shadow = defaultNodeRegistry.get(effectNodeType("shadow"));
    // The card's header IS the effect's own registry label — that is the "which
    // effect does this field belong to?" answer the flat Effects node never gave.
    expect(shadow?.title).toBe(LAYER_EFFECT_TYPES.find((t) => t.type === "shadow")!.label);
    expect(shadow?.hidden).toBe(true);
    expect(defaultNodeRegistry.get(EFFECTS_HUB_TYPE)?.hidden).toBeUndefined();
  });

  it("materialises one card per effect and chains them in stack order", () => {
    const g = { ...createGraph("g"), nodes: [hub("h", "clip")] };
    const { graph, reorders } = syncEffectNodes(g, stack([["a", "shadow"], ["b", "blur"]]));
    expect(cardsOf(graph)).toEqual(["a", "b"]);
    expect(chainOrder(graph, "h")).toEqual(["a", "b"]);
    // The document already agreed with the chain, so nothing to write back.
    expect(reorders.size).toBe(0);
  });

  it("is idempotent — a second pass returns the very same graph", () => {
    const g = { ...createGraph("g"), nodes: [hub("h", "clip")] };
    const once = syncEffectNodes(g, stack([["a", "shadow"], ["b", "blur"]])).graph;
    const twice = syncEffectNodes(once, stack([["a", "shadow"], ["b", "blur"]]));
    expect(twice.graph).toBe(once);
    expect(twice.reorders.size).toBe(0);
  });

  it("prunes the card of an effect deleted from the layer", () => {
    const g = { ...createGraph("g"), nodes: [hub("h", "clip")] };
    const full = syncEffectNodes(g, stack([["a", "shadow"], ["b", "blur"]])).graph;
    const pruned = syncEffectNodes(full, stack([["b", "blur"]])).graph;
    expect(cardsOf(pruned)).toEqual(["b"]);
    expect(chainOrder(pruned, "h")).toEqual(["b"]);
  });

  it("reads a re-wire as a re-order and writes it back to the layer", () => {
    const g = { ...createGraph("g"), nodes: [hub("h", "clip")] };
    const base = syncEffectNodes(g, stack([["a", "shadow"], ["b", "blur"], ["c", "glow"]])).graph;
    const idOf = (eff: string) => base.nodes.find((n) => n.params.effect === eff)!.id;
    // Drag hub → c: `fx` is single-fan, so the newest wire out of the hub wins
    // and c becomes the head of the stack.
    const rewired: NodeGraph = {
      ...base,
      edges: [...base.edges, { id: "e-new", from: { node: "h", socket: FX_SOCKET_KEY }, to: { node: idOf("c"), socket: FX_SOCKET_KEY } }],
    };
    const { graph, reorders } = syncEffectNodes(rewired, stack([["a", "shadow"], ["b", "blur"], ["c", "glow"]]));
    expect(reorders.get("clip")).toEqual(["c", "a", "b"]);
    expect(chainOrder(graph, "h")).toEqual(["c", "a", "b"]);
  });

  it("sweeps edges into hub sockets that the redesign removed", () => {
    const g: NodeGraph = {
      ...createGraph("g"),
      nodes: [hub("h", "clip")],
      edges: [{ id: "legacy", from: { node: "other", socket: "value" }, to: { node: "h", socket: "lfx.a.blur" } }],
    };
    const { graph } = syncEffectNodes(g, stack([["a", "blur"]]));
    expect(graph.edges.some((e) => e.id === "legacy")).toBe(false);
  });

  it("grows the hub itself for a board that never had one", () => {
    // A shape layer's board is seeded with Transform/Shape/Paint and NO Effects
    // node — and every graph saved before this redesign is in the same state. The
    // hub is part of the projection, so it must materialise, or the layer's
    // effects have nowhere to appear at all.
    const g = createGraph("g", "board", "clip");
    const source = createNode(defaultNodeRegistry, "object.layer", 40, 120)!;
    source.params = { ...source.params, target: "clip" };
    g.nodes.push(source);

    const { graph } = syncEffectNodes(g, stack([["a", "shadow"]]));
    const hubNode = graph.nodes.find((n) => n.type === EFFECTS_HUB_TYPE)!;
    expect(hubNode).toBeDefined();
    expect(hubNode.params.target).toBe("clip");
    // Wired from the Layer source, so it reads as part of the tree…
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: { node: source.id, socket: MAIN_SOCKET_KEY }, to: { node: hubNode.id, socket: MAIN_SOCKET_KEY } }),
    );
    // …and it does not land on top of the nodes already placed.
    expect(hubNode.x).toBeGreaterThan(source.x);
    expect(chainOrder(graph, hubNode.id)).toEqual(["a"]);
    // Second pass adds nothing.
    expect(syncEffectNodes(graph, stack([["a", "shadow"]])).graph).toBe(graph);
  });

  it("does not invent a hub for a layer the board does not show", () => {
    const g = createGraph("g", "board", null);
    expect(syncEffectNodes(g, stack([["a", "shadow"]])).graph.nodes).toHaveLength(0);
  });
});
