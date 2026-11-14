import { LAYER_EFFECT_TYPES } from "../animation/layer-effects";
import { createId } from "../ids";
import type { GraphEdge, GraphNode, NodeGraph, NodeValue } from "../schema";
import { MAIN_SOCKET_KEY, socketTypeForProperty } from "./projection";
import type { NodeTypeDef, SocketResolveCtx, SocketSpec } from "./registry";

/**
 * THE EFFECT STACK AS A NODE CHAIN.
 *
 * A layer's effects are an ORDERED LIST OF INSTANCES, and that is exactly what
 * one flat "Effects" node could never say: it dumped the union of every effect
 * type's fields into one anonymous column — no titles, no ownership, no order,
 * and rows for effects the layer does not even have. A list of instances is a
 * CHAIN of cards, one per instance, which is how Blender/Nuke/Resolve read a
 * stack and how the eye reads it too.
 *
 * So: the `object.effects` hub is now a tiny anchor (Layer in → Stack out), and
 * each effect on the layer is its own card whose HEADER is the effect's name and
 * whose rows are only that effect's fields. The cards chain hub → 1 → 2 → 3, so
 * the stack order IS the wire path: visible at a glance, changed by re-wiring.
 *
 * ONE AUTHORITY. `clip.effects` stays the only place stack membership and order
 * live — the renderer, the inspector and the exporter already read it. These
 * nodes are a projection of it (`syncEffectNodes` materialises/prunes cards to
 * match), and a re-wire is a GESTURE that writes the new order back to the clip,
 * after which the chain is re-derived from the document. The graph never becomes
 * a second, disagreeing copy of the stack.
 */

/** Node type for one effect kind, e.g. `object.effect.dropShadow`. */
export const EFFECT_NODE_PREFIX = "object.effect.";
/** The hub every effect chain hangs off (kept at its old id so existing graphs,
 *  and the seeded per-layer boards, keep their wiring). */
export const EFFECTS_HUB_TYPE = "object.effects";
/** Param naming the effect INSTANCE a card mirrors (`clip.effects[].id`). */
export const EFFECT_PARAM_KEY = "effect";
/** The chain socket: hub → card → card. Carries the layer id, like `self`. */
export const FX_SOCKET_KEY = "fx";

export const effectNodeType = (type: string): string => `${EFFECT_NODE_PREFIX}${type}`;
export const isEffectNodeType = (type: string): boolean => type.startsWith(EFFECT_NODE_PREFIX);

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const chainSocket = (): SocketSpec => ({ key: FX_SOCKET_KEY, label: "Stack", type: "any" });

/**
 * The card's rows: ONLY the fields of the instance it mirrors, taken straight
 * from `clipAnimatableProperties` — so the socket key IS the drivable keyframe
 * path (`lfx.<id>.<field>`) and nothing is hand-listed. Add a field to an effect
 * schema and its card grows the row for free. Unbound (no layer / a pruned
 * instance) the card is just its chain handle; that state is transient, since
 * `syncEffectNodes` only ever creates a card for an effect that exists.
 */
function effectSockets(ctx: SocketResolveCtx): SocketSpec[] {
  const target = str(ctx.node.params.target);
  const effectId = str(ctx.node.params[EFFECT_PARAM_KEY]);
  if (!target || !effectId || !ctx.describeClip) return [];
  const groupId = `effect:${effectId}`;
  return ctx.describeClip(target)
    .filter((p) => p.groupId === groupId)
    .map((p) => ({
      key: p.path,
      label: p.def.label,
      type: socketTypeForProperty(p.def.kind, p.def.identity as NodeValue),
      default: p.def.identity as NodeValue,
      path: p.path,
    }));
}

/**
 * One node type PER EFFECT KIND, generated from the effect registry — the same
 * table the inspector cards render from, so a new effect is a node with no code
 * here at all. Per-kind (rather than one generic "Effect" node) is what gives
 * each card a real TITLE: the header says "Drop shadow", not "Effect".
 *
 * `hidden` keeps them out of the add-menu on purpose: membership of the stack is
 * owned by the inspector's effect list — one concept, one place to add/remove —
 * and the board mirrors it. What the board owns is ORDER and DRIVERS.
 */
export const EFFECT_NODES: NodeTypeDef[] = LAYER_EFFECT_TYPES.map((t) => ({
  type: effectNodeType(t.type),
  category: "effect",
  title: t.label,
  description: `Drive every field of this layer's ${t.label.toLowerCase()}.`,
  hidden: true,
  contexts: ["board"],
  inputs: (ctx) => [chainSocket(), ...effectSockets(ctx)],
  outputs: (ctx) => [chainSocket(), ...effectSockets(ctx)],
  evaluate: ({ inputs, params, connected, ctx }) => {
    const target = str(params.target);
    const effectId = str(params[EFFECT_PARAM_KEY]);
    // The chain passes the layer along, so a downstream card reads the same one.
    const out: Record<string, NodeValue> = { [FX_SOCKET_KEY]: inputs[FX_SOCKET_KEY] ?? target };
    if (!target || !effectId || !ctx.describeClip) return out;
    const groupId = `effect:${effectId}`;
    for (const p of ctx.describeClip(target)) {
      if (p.groupId !== groupId) continue;
      // A WIRE into a field is a specific write and wins over the layer's own
      // value — otherwise the readout would contradict the stage, which honours
      // the driver. Same specificity rule as the projection nodes.
      if (connected.has(p.path)) {
        out[p.path] = inputs[p.path]!;
        continue;
      }
      const v = ctx.readProperty?.(target, p.path, ctx.timeMs);
      if (v !== undefined) out[p.path] = v;
    }
    return out;
  },
}));

/**
 * The hub: Layer in (fed by the `object.layer` source, or picked), Stack out.
 * It deliberately carries NO property sockets any more — its whole job is to be
 * the head of the chain, so the effects themselves are the cards you read.
 */
export const EFFECTS_HUB_NODE: NodeTypeDef = {
  type: EFFECTS_HUB_TYPE,
  category: "object",
  title: "Effects",
  description: "The layer's effect stack — one card per effect, chained in order.",
  contexts: ["board"],
  inputs: () => [{ key: MAIN_SOCKET_KEY, label: "Layer", type: "any" }],
  outputs: () => [chainSocket()],
  options: [{ key: "target", label: "Layer", kind: "string", default: "" }],
  evaluate: ({ params }) => ({ [FX_SOCKET_KEY]: str(params.target) }),
};

// ── Materialisation: the stack ⇄ the chain ───────────────────────────────────

/** One layer's stack, as the sync pass needs to see it (document order). */
export interface EffectStackView {
  clipId: string;
  effects: Array<{ id: string; type: string }>;
}

export interface EffectSyncResult {
  /** The graph with cards created/pruned and the chain re-wired. Referentially
   *  identical to the input when nothing changed, so callers can skip commits. */
  graph: NodeGraph;
  /** clipId → effect ids in the order the user's wiring implies. Only layers
   *  whose order actually MOVED appear here; the caller writes it to the clip. */
  reorders: Map<string, string[]>;
}

/** The projection SOURCE node a chain hangs off — the layer hub. */
const LAYER_SOURCE_TYPE = "object.layer";
const CARD_DX = 300;
const CARD_DY = 240;

/**
 * The chain successor of every node: `fx` is a SINGLE-FAN socket (a stack is a
 * line, not a tree), so when an output has more than one wire the LAST one
 * added wins — that is the drag the user just made, and it is what makes
 * re-wiring read as "put this one after that one".
 */
function chainSuccessors(graph: NodeGraph): Map<string, string> {
  const next = new Map<string, string>();
  for (const e of graph.edges)
    if (e.from.socket === FX_SOCKET_KEY && e.to.socket === FX_SOCKET_KEY) next.set(e.from.node, e.to.node);
  return next;
}

/** Follow the chain from a node and list the effect cards reached, in order.
 *  Guarded against cycles (a graph can always be wired into a loop). */
function walkChain(next: Map<string, string>, startNode: string, byId: Map<string, GraphNode>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([startNode]);
  let cursor = startNode;
  for (;;) {
    const nextId = next.get(cursor);
    if (!nextId || seen.has(nextId)) return out;
    const node = byId.get(nextId);
    if (!node || !isEffectNodeType(node.type)) return out;
    seen.add(nextId);
    out.push(nextId);
    cursor = nextId;
  }
}

/**
 * Reconcile the board with the layers' effect stacks, both ways at once:
 *
 *  • ORDER FLOWS UP. The chain the user wired is read first; whatever it names
 *    becomes the new stack order (effects it doesn't mention keep their relative
 *    document order, appended). That is the re-wire gesture.
 *  • MEMBERSHIP FLOWS DOWN. A card is created for every effect that has none and
 *    deleted for every card whose effect is gone — so adding a drop shadow in
 *    the inspector makes its card appear, and deleting it takes the card with it.
 *  • THE CHAIN IS REBUILT from the resulting order, so the wires can never
 *    disagree with the stack: they are a drawing of it.
 *
 * Pure — the caller (which owns history) applies `reorders` to the document.
 * `graph` should have effective targets baked in, so hub-fed nodes name a layer.
 */
export function syncEffectNodes(graph: NodeGraph, stacks: EffectStackView[]): EffectSyncResult {
  const byClip = new Map(stacks.map((s) => [s.clipId, s]));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const successor = chainSuccessors(graph);
  const reorders = new Map<string, string[]>();

  let nodes = graph.nodes;
  let changed = false;
  // Every card that survives, per layer, in FINAL stack order — the chain source.
  const chains: Array<{ hub: GraphNode | undefined; cards: string[] }> = [];
  const extraEdges: GraphEdge[] = [];

  // 1. Prune cards whose effect instance no longer exists anywhere.
  const liveEffects = new Set<string>();
  for (const s of stacks) for (const e of s.effects) liveEffects.add(`${s.clipId}:${e.id}`);
  const stale = new Set(
    nodes
      .filter((n) => isEffectNodeType(n.type) && !liveEffects.has(`${str(n.params.target)}:${str(n.params[EFFECT_PARAM_KEY])}`))
      .map((n) => n.id),
  );
  if (stale.size) {
    nodes = nodes.filter((n) => !stale.has(n.id));
    changed = true;
  }

  // 1b. Materialise the HUB itself. It is part of the projection, not something
  //     the user places: a board seeded before this redesign (or for a kind whose
  //     seed never listed Effects — shapes, paths) has no hub, and without one a
  //     layer's effects would have nowhere to appear at all. So any layer that
  //     HAS effects and is represented on this board (a Layer source targets it,
  //     or it owns the graph) grows its hub, wired from that source.
  const hubTargets = new Set(nodes.filter((n) => n.type === EFFECTS_HUB_TYPE).map((n) => str(n.params.target)));
  const newHubs: GraphNode[] = [];
  for (const s of stacks) {
    if (s.effects.length === 0 || hubTargets.has(s.clipId)) continue;
    const source = nodes.find((n) => n.type === LAYER_SOURCE_TYPE && str(n.params.target) === s.clipId);
    if (!source && graph.ownerId !== s.clipId) continue;
    // Park it clear of everything already placed, so materialising never drops a
    // card on top of the tree the user arranged.
    const rightmost = nodes.reduce((m, n) => Math.max(m, n.x), source?.x ?? 40);
    const hub: GraphNode = {
      id: createId("node"),
      type: EFFECTS_HUB_TYPE,
      x: rightmost + CARD_DX,
      y: source?.y ?? 120,
      // A literal target AND (when there is a source) a wire: they agree, and
      // `effectiveTarget` prefers the wire, so the picker still reads as linked.
      params: { target: s.clipId },
      collapsed: false,
      groupId: null,
    };
    newHubs.push(hub);
    if (source) extraEdges.push({ id: createId("edge"), from: { node: source.id, socket: MAIN_SOCKET_KEY }, to: { node: hub.id, socket: MAIN_SOCKET_KEY } });
  }
  if (newHubs.length) {
    nodes = [...nodes, ...newHubs];
    changed = true;
  }

  // 2. Per hub, resolve the order the wiring implies and materialise the cards.
  for (const hub of [...nodes.filter((n) => n.type === EFFECTS_HUB_TYPE && !newHubs.includes(n)), ...newHubs]) {
    const clipId = str(hub.params.target);
    const stack = byClip.get(clipId);
    if (!stack) continue;

    const cardByEffect = new Map<string, GraphNode>();
    for (const n of nodes)
      if (isEffectNodeType(n.type) && str(n.params.target) === clipId && !stale.has(n.id))
        cardByEffect.set(str(n.params[EFFECT_PARAM_KEY]), n);

    // Order = wired chain first, then anything unwired in its document order.
    const wired = walkChain(successor, hub.id, byId)
      .map((id) => str(byId.get(id)?.params[EFFECT_PARAM_KEY]))
      .filter((eid) => eid && stack.effects.some((e) => e.id === eid));
    const seen = new Set(wired);
    const order = [...wired, ...stack.effects.map((e) => e.id).filter((id) => !seen.has(id))];
    if (order.some((id, i) => stack.effects[i]?.id !== id)) reorders.set(clipId, order);

    // Create the missing cards, laid out down the chain to the hub's right.
    const cards: string[] = [];
    const created: GraphNode[] = [];
    order.forEach((effectId, i) => {
      const existing = cardByEffect.get(effectId);
      if (existing) {
        cards.push(existing.id);
        return;
      }
      const def = stack.effects.find((e) => e.id === effectId);
      if (!def) return;
      const node: GraphNode = {
        id: createId("node"),
        type: effectNodeType(def.type),
        x: hub.x + CARD_DX,
        y: hub.y + i * CARD_DY,
        collapsed: false,
        groupId: null,
        // `expanded` so a fresh card shows its fields rather than collapsing to
        // "nothing is keyframed yet" — the whole point is seeing what it owns.
        params: { target: clipId, [EFFECT_PARAM_KEY]: effectId, expanded: true },
      };
      created.push(node);
      cards.push(node.id);
    });
    if (created.length) {
      nodes = [...nodes, ...created];
      changed = true;
    }
    chains.push({ hub, cards });
  }

  // 3. Rebuild every `fx` wire from the resolved order. Wires are a DRAWING of
  //    the stack, so they are regenerated rather than patched — no path exists
  //    by which a leftover edge can outlive the order it described.
  const wantEdges: GraphEdge[] = [];
  for (const { hub, cards } of chains) {
    let from = hub?.id;
    for (const card of cards) {
      if (from) wantEdges.push({ id: createId("edge"), from: { node: from, socket: FX_SOCKET_KEY }, to: { node: card, socket: FX_SOCKET_KEY } });
      from = card;
    }
  }
  // The hub's contract is exactly "Layer in, Stack out" — it used to carry a
  // socket per effect FIELD, so graphs saved before this redesign hold edges into
  // ports that no longer exist. They resolve to nothing and would linger as
  // invisible ghosts (and as stale driver tokens), so the sync sweeps them.
  const hubIds = new Set(nodes.filter((n) => n.type === EFFECTS_HUB_TYPE).map((n) => n.id));
  const legal = (e: GraphEdge) =>
    !(hubIds.has(e.to.node) && e.to.socket !== MAIN_SOCKET_KEY) &&
    !(hubIds.has(e.from.node) && e.from.socket !== FX_SOCKET_KEY);
  const keep = graph.edges.filter((e) => e.from.socket !== FX_SOCKET_KEY && e.to.socket !== FX_SOCKET_KEY && legal(e));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const survivingKeep = keep.filter((e) => nodeIds.has(e.from.node) && nodeIds.has(e.to.node));
  // Compared as an ORDER-INSENSITIVE set of endpoints: the rebuilt edges carry
  // fresh ids and a different array order, and treating that as a change would
  // make the sync commit on every pass forever.
  const sig = (list: GraphEdge[]) =>
    list.map((e) => `${e.from.node}.${e.from.socket}>${e.to.node}.${e.to.socket}`).sort().join("|");
  const nextEdges = [...survivingKeep, ...extraEdges, ...wantEdges];
  if (sig(nextEdges) !== sig(graph.edges)) changed = true;

  if (!changed) return { graph, reorders };
  return { graph: { ...graph, nodes, edges: nextEdges }, reorders };
}
