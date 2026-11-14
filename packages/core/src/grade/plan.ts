import type { GradeEdge, GradeGraph, GradeKey, GradeNode } from "../schema/grade";
import { NEUTRAL_KEY } from "../schema/grade";

/**
 * THE GRADE PLAN — a graph is AUTHORED as a DAG and EXECUTED as a straight line.
 *
 * This compiler is the irreversible decision of the colour page, so it is worth
 * saying plainly what was rejected. The obvious move is to make node sockets
 * carry images and let the existing node evaluator run the grade. It is wrong
 * twice over: the evaluator is a pure scalar machine that a renderer calls per
 * frame, and teaching it about pixel buffers would put canvas lifetimes,
 * allocation and GPU state inside the one module that is guaranteed headless.
 * And a renderer cannot afford to re-walk a graph, resolve fan-out and decide
 * allocation on every frame of a 4K export.
 *
 * So the graph is compiled ONCE into a `GradePlan`: a topologically ordered list
 * of steps over numbered buffer SLOTS, with the slots reused as soon as their
 * last reader has run. The renderer becomes a loop with no graph knowledge at
 * all — the same split as `effect-nodes.ts` (the board is a projection, the
 * document is the authority) and `resolveTrackBinding` (solve once, read many).
 *
 * Everything here is pure, framework-free and synchronous, so the stage, the
 * exporter and a test compile identical plans.
 */

/** Live-selection: a key that takes every pixel, which the renderer can skip. */
export function isNeutralKey(key: GradeKey): boolean {
  if (key.invert) return false;
  if (key.qualifier.enabled) return false;
  if (key.depth.enabled) return false;
  if (key.windows.some((w) => w.enabled)) return false;
  return key.blurPx === 0 && key.shrinkPx === 0;
}

/**
 * One executable step. `out`/`rgbIn`/`keyIn`/`keyOut` are SLOT NUMBERS, not
 * buffers: the renderer owns the pool and the plan owns the schedule, which is
 * what lets the same plan drive a canvas stage, a WebGL path and an offline
 * export without any of them agreeing about allocation.
 */
export interface GradeStep {
  nodeId: string;
  node: GradeNode;
  /** RGB slot this step writes. */
  out: number;
  /** RGB slots this step reads, in wire order (a mixer reads several). */
  rgbIn: number[];
  /** Slot holding the key wired INTO this node, or null. */
  keyIn: number | null;
  /**
   * Slot this step writes its own matte into, or null when nobody needs one —
   * the node's key is neutral AND no downstream node reads its key output. Most
   * nodes in most grades land here, and skipping a full-frame matte is the
   * single biggest saving in the whole pipeline.
   */
  keyOut: number | null;
}

export interface GradePlan {
  steps: GradeStep[];
  /** RGB slots the renderer must be able to hand out. */
  rgbSlots: number;
  /** Key slots the renderer must be able to hand out. */
  keySlots: number;
  /** Slot holding the finished picture. */
  result: number;
  /**
   * Nodes left out, with the reason. Surfaced on the board (a dimmed card with
   * a tooltip) rather than silently dropped — a node you wired and that does
   * nothing is the most confusing state a graph can be in.
   */
  orphans: Array<{ nodeId: string; reason: "unreachable" | "cycle" }>;
}

/** An empty plan — a graph with no output, or nothing wired to it. */
const EMPTY: GradePlan = { steps: [], rgbSlots: 1, keySlots: 0, result: 0, orphans: [] };

interface Wiring {
  /** node id → rgb sources, ordered by the target port's `index`. */
  rgbIn: Map<string, string[]>;
  /** node id → key source node id. */
  keyIn: Map<string, string>;
  /** node ids whose KEY output is read by somebody. */
  keyConsumed: Set<string>;
}

function wiringOf(edges: GradeEdge[]): Wiring {
  const rgbSlots = new Map<string, Array<{ index: number; from: string }>>();
  const keyIn = new Map<string, string>();
  const keyConsumed = new Set<string>();
  for (const e of edges) {
    if (e.to.port === "rgb") {
      const list = rgbSlots.get(e.to.node) ?? [];
      list.push({ index: e.to.index, from: e.from.node });
      rgbSlots.set(e.to.node, list);
    } else {
      // A key input holds at most one wire — the last one drawn wins, which is
      // the drag the user just made.
      keyIn.set(e.to.node, e.from.node);
    }
    if (e.from.port === "key") keyConsumed.add(e.from.node);
  }
  const rgbIn = new Map<string, string[]>();
  for (const [node, list] of rgbSlots) {
    list.sort((a, b) => a.index - b.index);
    rgbIn.set(node, list.map((s) => s.from));
  }
  return { rgbIn, keyIn, keyConsumed };
}

/**
 * The nodes that actually reach the output, in evaluation order.
 *
 * Walked BACKWARD from the output rather than forward from the source, because
 * that is what makes "unreachable" a fact instead of a guess: a node is in the
 * plan exactly when the picture depends on it. A dangling experiment on the side
 * of the board costs nothing, which is the property that makes a board worth
 * having.
 */
function evaluationOrder(
  graph: GradeGraph,
  wiring: Wiring,
  outputId: string,
): { order: string[]; cycles: Set<string> } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const cycles = new Set<string>();

  const visit = (id: string): void => {
    const mark = state.get(id);
    if (mark === "done") return;
    if (mark === "visiting") {
      // A wire loop. Drop the back-edge by refusing to descend again; the node
      // still evaluates, it just reads whatever its other inputs give it.
      cycles.add(id);
      return;
    }
    if (!byId.has(id)) return;
    state.set(id, "visiting");
    for (const src of wiring.rgbIn.get(id) ?? []) visit(src);
    const key = wiring.keyIn.get(id);
    if (key) visit(key);
    state.set(id, "done");
    order.push(id);
  };

  visit(outputId);
  return { order, cycles };
}

/**
 * Compile a graph into an executable plan.
 *
 * Slot reuse is a liveness pass, not an optimisation to do later: a grade on a
 * 4K plate is ~34 MB per buffer, and a ten-node graph that allocates one buffer
 * per node is a third of a gigabyte for a picture that only ever needs three
 * alive at once. The last-reader table below is the whole trick — a slot returns
 * to the pool the moment the final step that reads it has run.
 */
export function compileGrade(graph: GradeGraph): GradePlan {
  const output = graph.nodes.find((n) => n.kind === "output");
  if (!output) return EMPTY;

  const wiring = wiringOf(graph.edges);
  const { order, cycles } = evaluationOrder(graph, wiring, output.id);
  const reached = new Set(order);

  const orphans: GradePlan["orphans"] = [];
  for (const n of graph.nodes) {
    if (cycles.has(n.id)) orphans.push({ nodeId: n.id, reason: "cycle" });
    else if (!reached.has(n.id)) orphans.push({ nodeId: n.id, reason: "unreachable" });
  }

  // LAST READER per producer, over the evaluation order — where a slot dies.
  const lastRgbReader = new Map<string, number>();
  const lastKeyReader = new Map<string, number>();
  order.forEach((id, i) => {
    for (const src of wiring.rgbIn.get(id) ?? []) lastRgbReader.set(src, i);
    const key = wiring.keyIn.get(id);
    if (key) lastKeyReader.set(key, i);
  });

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const rgbPool = new Pool();
  const keyPool = new Pool();
  const rgbSlotOf = new Map<string, number>();
  const keySlotOf = new Map<string, number>();
  const steps: GradeStep[] = [];

  order.forEach((id, i) => {
    const node = byId.get(id)!;
    const rgbIn = (wiring.rgbIn.get(id) ?? [])
      .map((src) => rgbSlotOf.get(src))
      .filter((s): s is number => s != null);
    const keySrc = wiring.keyIn.get(id);
    const keyIn = keySrc != null ? (keySlotOf.get(keySrc) ?? null) : null;

    // A node writes a matte when it has one of its own AND somebody uses it:
    // itself (to composite through) or a downstream key wire.
    const key = node.kind === "corrector" ? node.key : NEUTRAL_KEY;
    const hasOwnKey = node.kind === "corrector" && (!isNeutralKey(key) || keyIn != null);
    const keyOut = hasOwnKey || wiring.keyConsumed.has(id) ? keyPool.take() : null;

    const out = rgbPool.take();
    steps.push({ nodeId: id, node, out, rgbIn, keyIn, keyOut });
    rgbSlotOf.set(id, out);
    if (keyOut != null) keySlotOf.set(id, keyOut);

    // Free every slot whose last reader was this step. Done AFTER taking `out`
    // so a step never writes into a slot it is still reading.
    for (const [src, last] of lastRgbReader) {
      if (last === i) {
        const slot = rgbSlotOf.get(src);
        if (slot != null && src !== id) rgbPool.give(slot);
      }
    }
    for (const [src, last] of lastKeyReader) {
      if (last === i) {
        const slot = keySlotOf.get(src);
        if (slot != null && src !== id) keyPool.give(slot);
      }
    }
  });

  const result = rgbSlotOf.get(output.id) ?? 0;
  return {
    steps,
    rgbSlots: Math.max(1, rgbPool.high),
    keySlots: keyPool.high,
    result,
    orphans,
  };
}

/** A tiny free-list. `high` is the peak concurrent slot count — what to allocate. */
class Pool {
  private free: number[] = [];
  private next = 0;
  high = 0;
  take(): number {
    const slot = this.free.pop() ?? this.next++;
    this.high = Math.max(this.high, this.next - this.free.length);
    return slot;
  }
  give(slot: number): void {
    if (!this.free.includes(slot)) this.free.push(slot);
  }
}

/**
 * Does this graph do anything? A fresh graph is Source → Corrector → Output with
 * a neutral corrector, and rendering it is a no-op the stage should skip
 * entirely rather than round-trip a 4K plate through three canvases to prove it.
 */
export function gradeIsIdentity(graph: GradeGraph): boolean {
  return graph.nodes.every(
    (n) =>
      n.kind !== "corrector" ||
      !n.enabled ||
      (n.effects.length === 0 && isNeutralKey(n.key) && n.blend === "normal" && n.opacity === 1),
  );
}
