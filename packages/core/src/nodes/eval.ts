import type { GraphNode, NodeGraph, NodeParam, NodeValue } from "../schema";
import { OUTPUT_NODE_TYPE, OUTPUT_SOCKET_KEY } from "./builtin";
import { resolveSockets, type EvalContext, type NodeRegistry, type NodeTypeDef, type SocketSpec } from "./registry";
import { coerce, identityValue, runtimeType } from "./sockets";

/**
 * THE EVALUATION ENGINE — turns a graph + a moment in time into concrete socket
 * values. One pure function serves BOTH faces: the board previews every socket
 * from `evaluateGraph`, and an expression reads its single result from
 * `evaluateDriver`. Pure and memoised: each node evaluates at most once per
 * call, cycles are caught (a wire that loops yields identity, never hangs), and
 * unknown/removed node types degrade to identity instead of throwing.
 *
 * A socket key in the result map is `"<nodeId>:<socketKey>"`.
 */

export interface GraphEval {
  /** Every OUTPUT socket's value, keyed `"<nodeId>:<socketKey>"`. */
  outputs: Map<string, NodeValue>;
  /** Every reachable node's resolved INPUT socket value, same key scheme — what
   *  an Object-node sink socket carries, i.e. the value a driver writes. */
  inputs: Map<string, NodeValue>;
  /** Nodes detected inside a cycle — their outputs were forced to identity. */
  cyclic: Set<string>;
}

/** The socket-map key for one output socket. */
export function socketKey(nodeId: string, socket: string): string {
  return `${nodeId}:${socket}`;
}

function mergedParams(def: NodeTypeDef, node: GraphNode): Record<string, NodeParam> {
  const params: Record<string, NodeParam> = {};
  for (const o of def.options ?? []) params[o.key] = o.default;
  return { ...params, ...node.params };
}

function identityOutputs(specs: SocketSpec[]): Record<string, NodeValue> {
  const out: Record<string, NodeValue> = {};
  for (const s of specs) out[s.key] = s.default ?? identityValue(s.type);
  return out;
}

/**
 * Evaluate a whole graph at `ctx.timeMs`. Every reachable node's outputs land in
 * the returned map; the board reads them to render live socket values and
 * highlight cyclic nodes.
 */
export function evaluateGraph(graph: NodeGraph, registry: NodeRegistry, ctx: EvalContext): GraphEval {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  // Fast lookup of the single edge feeding each input socket.
  const inbound = new Map<string, { node: string; socket: string }>();
  for (const e of graph.edges) inbound.set(socketKey(e.to.node, e.to.socket), e.from);

  const memo = new Map<string, Record<string, NodeValue>>();
  const visiting = new Set<string>();
  const cyclic = new Set<string>();
  const inputsMap = new Map<string, NodeValue>();
  const describeClip = ctx.describeClip;

  // A node's resolved output specs (dynamic projection lists included), cached.
  const outSpecsCache = new Map<string, SocketSpec[]>();
  function outputSpecs(node: GraphNode, def: NodeTypeDef): SocketSpec[] {
    let s = outSpecsCache.get(node.id);
    if (!s) {
      s = resolveSockets(def.outputs, { node, describeClip });
      outSpecsCache.set(node.id, s);
    }
    return s;
  }

  function evalNode(id: string): Record<string, NodeValue> {
    const cached = memo.get(id);
    if (cached) return cached;

    const node = nodeById.get(id);
    const def = node ? registry.get(node.type) : undefined;
    if (!node || !def) {
      const empty: Record<string, NodeValue> = {};
      memo.set(id, empty);
      return empty;
    }
    const outSpecs = outputSpecs(node, def);
    if (visiting.has(id)) {
      // A cycle — break it with identity so evaluation always terminates.
      cyclic.add(id);
      return identityOutputs(outSpecs);
    }
    visiting.add(id);

    const inputs: Record<string, NodeValue> = {};
    const connected = new Set<string>();
    for (const spec of resolveSockets(def.inputs, { node, describeClip })) {
      const src = inbound.get(socketKey(id, spec.key));
      if (src) {
        connected.add(spec.key);
        const srcNode = nodeById.get(src.node);
        const srcDef = srcNode ? registry.get(srcNode.type) : undefined;
        const srcType =
          srcNode && srcDef
            ? outputSpecs(srcNode, srcDef).find((o) => o.key === src.socket)?.type ?? "any"
            : "any";
        const raw = evalNode(src.node)[src.socket];
        inputs[spec.key] =
          raw === undefined ? spec.default ?? identityValue(spec.type) : coerce(raw, srcType, spec.type);
      } else {
        const p = node.params[spec.key];
        inputs[spec.key] =
          p === undefined ? spec.default ?? identityValue(spec.type) : coerce(p, runtimeType(p), spec.type);
      }
      inputsMap.set(socketKey(id, spec.key), inputs[spec.key]!);
    }

    let produced: Record<string, NodeValue>;
    try {
      produced = def.evaluate({ inputs, connected, params: mergedParams(def, node), ctx, node });
    } catch {
      produced = identityOutputs(outSpecs);
    }

    // Normalise every declared output to its socket type (and fill any missing).
    const outputs: Record<string, NodeValue> = {};
    for (const spec of outSpecs) {
      const v = produced[spec.key];
      outputs[spec.key] = v === undefined ? identityValue(spec.type) : coerce(v, spec.type, spec.type);
    }

    visiting.delete(id);
    memo.set(id, outputs);
    return outputs;
  }

  const outputs = new Map<string, NodeValue>();
  for (const n of graph.nodes) {
    const outs = evalNode(n.id);
    for (const [k, v] of Object.entries(outs)) outputs.set(socketKey(n.id, k), v);
  }
  return { outputs, inputs: inputsMap, cyclic };
}

/** The specific socket a driver reads from: an Object-node INPUT sink (`node`
 *  + `socket`), or — when absent — the graph's Output node. */
export interface DriverSink {
  node: string;
  socket: string;
}

/**
 * The value a DRIVER produces at this time. Two shapes, one funnel:
 *  - no `sink` → the graph's Output node input (a right-click "Add expression").
 *  - a `sink`  → the value arriving at that node's input socket (an Object-node
 *    property socket wired on the board) — i.e. what that property is driven to.
 * Returns undefined when there's nothing to read (no Output, missing sink), so
 * the sampler falls back to the keyframed/base value. This is the ONE call the
 * property sampler makes to turn an `expr:<id>[@node.socket]` token into a value.
 */
export function evaluateDriver(
  graph: NodeGraph,
  registry: NodeRegistry,
  ctx: EvalContext,
  sink?: DriverSink,
): NodeValue | undefined {
  const evald = evaluateGraph(graph, registry, ctx);
  if (sink) return evald.inputs.get(socketKey(sink.node, sink.socket));
  const outNode = graph.nodes.find((n) => n.type === OUTPUT_NODE_TYPE);
  if (!outNode) return undefined;
  return evald.outputs.get(socketKey(outNode.id, OUTPUT_SOCKET_KEY));
}
