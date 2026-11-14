import {
  VARIABLES_NODE_TYPE,
  parseSelectedVariables,
  clipAnimatableProperties,
  createGraph,
  createId,
  createNode,
  defaultNodeRegistry,
  disconnect,
  exprToken,
  MAIN_SOCKET_KEY,
  isEffectNodeType,
  parseDriverToken,
  removeNodes,
  syncEffectNodes,
  EFFECT_PARAM_KEY,
  withEffectiveTargets,
  type MotionDocument,
  type Clip,
  type ClipProperty,
  type DocumentStore,
  type GraphNode,
  type EffectStackView,
  type NodeGraph,
} from "@solomotion/core";

/** Live property projection over a draft doc — feeds projection-node sockets. */
type DescribeClip = (id: string) => ClipProperty[];
function makeDraftDescribe(doc: MotionDocument): DescribeClip {
  return (id) => {
    for (const t of doc.tracks) for (const c of t.clips) if (c.id === id) return clipAnimatableProperties(c);
    return [];
  };
}

/**
 * The same projection, for VARIABLES. A Variables-node input socket that is
 * wired makes its variable driven; unwiring clears it. Only tokens owned by THIS
 * graph are touched, so another graph's wire and a hand-set value both survive.
 *
 * Writing a REFERENCE here — rather than pushing a value into `doc.variables`
 * when the graph evaluates — is what keeps evaluation pure and order-free, and
 * what makes "who drives this variable?" a question with exactly one answer.
 */
function syncVariableDrivers(draft: MotionDocument, graph: NodeGraph): void {
  const inbound = new Set(graph.edges.map((e) => `${e.to.node}:${e.to.socket}`));
  const want = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.type !== VARIABLES_NODE_TYPE) continue;
    for (const v of parseSelectedVariables(node)) {
      if (inbound.has(`${node.id}:${v.id}`)) {
        want.set(v.id, exprToken(graph.id, { node: node.id, socket: v.id }));
      }
    }
  }
  for (const variable of draft.variables) {
    const owner = variable.driver ? (parseDriverToken(variable.driver)?.graphId ?? null) : null;
    const owned = owner === graph.id;
    const desired = want.get(variable.id);
    // A FOREIGN owner is never overwritten. Two graphs writing one variable is a
    // race whose winner is "whoever was edited last", which is unreadable from
    // either board — so the value stays with the graph that has it, and taking it
    // over is an explicit act (`releaseVariableDriver`, offered on the drop).
    if (desired) {
      if (!owner || owned) variable.driver = desired;
    } else if (owned) variable.driver = null;
  }
}

/**
 * Hand a variable back: cut the wire in the graph that currently drives it. As
 * everywhere else, the EDGE is the truth and the token is its projection — so
 * dropping the edge is what makes `syncVariableDrivers` release the variable,
 * and the other board visibly loses its connection rather than quietly holding a
 * wire that no longer does anything.
 */
export function releaseVariableDriver(store: DocumentStore, token: string): void {
  const parsed = parseDriverToken(token);
  if (!parsed?.sink) return;
  const graph = findGraph(store.getState(), parsed.graphId);
  const edge = graph?.edges.find(
    (e) => e.to.node === parsed.sink!.node && e.to.socket === parsed.sink!.socket,
  );
  if (edge) {
    updateGraph(store, parsed.graphId, "Release variable", (g) => disconnect(g, edge.id));
    return;
  }
  // No edge to cut (a hand-written token): drop it directly.
  store.update("Release variable", (draft) => {
    for (const v of draft.variables) if (v.driver === token) v.driver = null;
  });
}

/**
 * Keep target clips' DRIVERS in lock-step with the graph's Object-node wiring:
 * drivers are a pure projection of the edges. For every Object node with a
 * target, each input socket that maps to a property PATH becomes a driver token
 * when wired, and is cleared when unwired — but ONLY tokens owned by THIS graph
 * are touched, so right-click expressions and other graphs' drivers survive. One
 * call after any graph mutation means there is never a stale or missing driver.
 */
function syncGraphDrivers(draft: MotionDocument, graph: NodeGraph, describe: DescribeClip): void {
  const inbound = new Set(graph.edges.map((e) => `${e.to.node}:${e.to.socket}`));
  // Resolve sockets against BAKED targets, or a hub-fed operator (empty literal
  // target) would expose only its Layer socket and never map a property → driver.
  const baked = withEffectiveTargets(graph);

  // 1. The drivers this graph SHOULD own right now: clipId → (path → token). A
  //    property earns a token only when its input socket is actually wired.
  const want = new Map<string, Map<string, string>>();
  for (const node of baked.nodes) {
    const clipId = typeof node.params.target === "string" ? node.params.target : "";
    if (!clipId) continue;
    for (const s of defaultNodeRegistry.inputsOf(node, { describeClip: describe })) {
      if (!s.path || !inbound.has(`${node.id}:${s.key}`)) continue;
      let m = want.get(clipId);
      if (!m) want.set(clipId, (m = new Map()));
      m.set(s.path, exprToken(graph.id, { node: node.id, socket: s.key }));
    }
  }

  // 2. Reconcile EVERY clip: drivers are a pure projection of THIS graph's live
  //    wiring — so a token owned by this graph survives only if it's still wanted.
  //    This sweeps orphans left when a hub link is cut (the operator loses its
  //    target, so step 1 can't name it) — the core reason a disconnect used to
  //    "not disconnect for real". Other graphs' tokens are never touched.
  for (const t of draft.tracks)
    for (const clip of t.clips) {
      const desired = want.get(clip.id);
      if (!clip.drivers && !desired) continue;
      const next: Record<string, string> = { ...(clip.drivers ?? {}) };
      let changed = false;
      for (const path of Object.keys(next)) {
        if (parseDriverToken(next[path])?.graphId !== graph.id) continue; // foreign
        if (desired?.get(path) !== next[path]) {
          delete next[path];
          changed = true;
        }
      }
      if (desired)
        for (const [path, token] of desired)
          if (next[path] !== token) {
            next[path] = token;
            changed = true;
          }
      if (changed) clip.drivers = Object.keys(next).length ? next : undefined;
    }
}

/**
 * Keep the board's EFFECT CARDS in lock-step with the layers' effect stacks —
 * the other half of "drivers are a projection of the wiring". `syncEffectNodes`
 * (headless) materialises one card per effect, prunes cards whose effect is
 * gone, reads the order the user's `fx` wiring implies and rebuilds the chain
 * from it; here we write that order back onto the clips, which stay the ONE
 * authority for what the renderer composites.
 *
 * The sync resolves against BAKED targets (a hub-fed Effects node stores no
 * layer of its own), but only the NEW cards keep their baked params — existing
 * nodes are restored to their stored selves, so the wire never silently becomes
 * a literal target.
 */
function syncEffectStack(draft: MotionDocument, graph: NodeGraph): NodeGraph {
  const stacks: EffectStackView[] = [];
  for (const t of draft.tracks)
    for (const c of t.clips)
      if ("effects" in c && Array.isArray(c.effects))
        stacks.push({ clipId: c.id, effects: c.effects.map((e) => ({ id: e.id, type: e.type })) });

  const baked = withEffectiveTargets(graph);
  const { graph: next, reorders } = syncEffectNodes(baked, stacks);

  for (const t of draft.tracks)
    for (const c of t.clips) {
      const order = reorders.get(c.id);
      if (!order || !("effects" in c) || !Array.isArray(c.effects)) continue;
      const byId = new Map(c.effects.map((e) => [e.id, e]));
      c.effects = order.map((id) => byId.get(id)).filter((e): e is NonNullable<typeof e> => !!e);
    }

  if (next === baked) return graph;
  const stored = new Map(graph.nodes.map((n) => [n.id, n]));
  return { ...next, nodes: next.nodes.map((n) => stored.get(n.id) ?? n) };
}

/**
 * The bridge from the board's gestures to the undoable document. Every board
 * edit funnels through `updateGraph`: it locates the active graph in
 * `doc.graphs` and swaps in the NEW graph a pure core op (`connect`,
 * `spliceNodeOnEdge`, `duplicateNodes`, …) returned — so all the graph logic
 * stays headless and this file only wires it to history. `mergeKey` lets a
 * continuous drag collapse into one undo step, exactly like the rest of the app.
 */

export function findGraph(doc: MotionDocument, graphId: string): NodeGraph | undefined {
  return doc.graphs.find((g) => g.id === graphId);
}

/** Apply a pure `(graph) → graph` transform to one graph as a single history
 *  entry. A null return (illegal op) is a no-op. */
export function updateGraph(
  store: DocumentStore,
  graphId: string,
  label: string,
  fn: (graph: NodeGraph) => NodeGraph | null,
  mergeKey?: string,
): void {
  store.update(label, (draft) => commitGraph(draft, graphId, fn), mergeKey ? { mergeKey } : undefined);
}

/** The commit pipeline itself, so other document edits can ride the SAME immer
 *  recipe (one history entry) instead of forking their own copy of it. */
function commitGraph(draft: MotionDocument, graphId: string, fn: (graph: NodeGraph) => NodeGraph | null): void {
  const idx = draft.graphs.findIndex((g) => g.id === graphId);
  if (idx < 0) return;
  const next = fn(draft.graphs[idx]!);
  if (!next) return;
  // Effect cards + chain first: they can ADD nodes/sockets, and the driver pass
  // below has to see them to claim their properties.
  const synced = syncEffectStack(draft, next);
  draft.graphs[idx] = synced;
  // Drivers are a projection of the wiring — resync after every edit so an
  // Object-node connect/disconnect takes over / releases the property.
  syncGraphDrivers(draft, synced, makeDraftDescribe(draft));
  syncVariableDrivers(draft, synced);
}

/**
 * Delete nodes from the board — with ONE special case that is really the general
 * rule: an effect card IS its effect, not a view of it, so deleting the card
 * deletes the effect from the layer. Without this the sync would faithfully
 * re-materialise the card (membership flows down from `clip.effects`) and delete
 * would read as broken. Both edits ride one recipe, so one undo puts it back.
 */
export function deleteBoardNodes(store: DocumentStore, graphId: string, ids: string[], label = "Delete nodes"): void {
  const graph = findGraph(store.getState(), graphId);
  if (!graph || ids.length === 0) return;
  const kill = new Set(ids);
  const cards = graph.nodes.filter((n) => kill.has(n.id) && isEffectNodeType(n.type));
  store.update(label, (draft) => {
    for (const card of cards) {
      const clipId = typeof card.params.target === "string" ? card.params.target : "";
      const effectId = typeof card.params[EFFECT_PARAM_KEY] === "string" ? card.params[EFFECT_PARAM_KEY] : "";
      if (!clipId || !effectId) continue;
      for (const t of draft.tracks)
        for (const c of t.clips)
          if (c.id === clipId && "effects" in c && Array.isArray(c.effects))
            c.effects = c.effects.filter((e) => e.id !== effectId);
    }
    commitGraph(draft, graphId, (g) => removeNodes(g, ids));
  });
}

/**
 * The graph owned by `ownerId` (a clip/frame id, or null for the document-level
 * board), find-or-create. This is what makes every layer carry its OWN node
 * tree: the board resolves selection → owner → this graph, creating an empty one
 * lazily the first time that layer's board is opened. A document accumulates
 * only the graphs actually touched.
 */
export function findOrCreateOwnerGraph(store: DocumentStore, ownerId: string | null, name: string): string {
  const existing = store.getState().graphs.find((g) => g.kind === "board" && g.ownerId === ownerId);
  if (existing) return existing.id;
  const graph = createGraph(name, "board", ownerId);
  // Seed a REAL tree: a central Layer HUB (the object, `object.layer` targeting
  // the owner) with the type-appropriate operator nodes (Transform + Font +
  // Effects for text, Shape + Paint for vectors, …) fanned out from its Layer
  // OUTPUT into each operator's Layer INPUT. The operators carry no target of
  // their own — they read/drive whatever layer the hub feeds them, so you can
  // drop a SECOND hub (any layer) and rewire to pull another layer's values in.
  // The set is derived from the kind, nothing hand-wired per layer.
  if (ownerId) {
    const clip = findClipInStore(store, ownerId);
    const hub = createNode(defaultNodeRegistry, "object.layer", 40, 120);
    if (hub) {
      hub.params = { ...hub.params, target: ownerId };
      graph.nodes.push(hub);
      const types = defaultNodeTypesForKind(clip?.kind);
      let y = 0;
      for (const type of types) {
        const op = createNode(defaultNodeRegistry, type, 360, y);
        if (!op) continue;
        op.params = { ...op.params, expanded: true };
        graph.nodes.push(op);
        graph.edges.push({
          id: createId("edge"),
          from: { node: hub.id, socket: MAIN_SOCKET_KEY },
          to: { node: op.id, socket: MAIN_SOCKET_KEY },
        });
        y += 300;
      }
    }
  }
  store.update("Create node graph", (draft) => {
    draft.graphs.push(graph);
  });
  return graph.id;
}

function findClipInStore(store: DocumentStore, id: string): Clip | undefined {
  for (const t of store.getState().tracks) for (const c of t.clips) if (c.id === id) return c;
  return undefined;
}

/** The projection nodes worth pre-seeding for a layer kind — a curated, useful
 *  starting graph. All are the same headless projection, so this only chooses
 *  which category cards to show; their fields still come from the data.
 *  Effects are NOT here: the effect hub + its cards MATERIALISE from the layer's
 *  actual stack (`syncEffectNodes`), so a layer with no effects never gets a
 *  dead empty card and a layer with effects gets them whatever its kind — which
 *  a hand-written per-kind list kept getting wrong (shapes had no Effects node
 *  at all, so their effects had nowhere to appear). */
function defaultNodeTypesForKind(kind: Clip["kind"] | undefined): string[] {
  switch (kind) {
    case "text":
      return ["object.transform", "object.typography"];
    case "shape":
    case "path":
      return ["object.transform", "object.shape", "object.fill"];
    case "audio":
      return ["object.audio"];
    case "image":
    case "video":
    case "nested":
    case "raster":
      return ["object.transform"];
    default:
      return ["object.transform"];
  }
}
