import type { PickFilter } from "../query/pick";
import type { ClipProperty } from "../animation/clip-properties";
import type { GraphNode, NodeParam, NodeValue, SocketType, Variable } from "../schema";

/**
 * THE NODE TYPE REGISTRY — the contract every node kind implements and the
 * catalogue the board's add-menu, the evaluator, and (later) native adapters
 * all read from. A `NodeTypeDef` is pure data + one pure `evaluate` function: no
 * DOM, no React, no store. Adding a node is adding one `NodeTypeDef` and nothing
 * else — the UI renders its sockets/options from this table and the engine runs
 * its `evaluate`. This is the "do once, reuse everywhere" heart both the board
 * and expressions share.
 */

/**
 * Blender-style categories — each carries an accent color so the board reads at
 * a glance (math is blue, reads are green, colors are yellow…). Colors are data
 * here; the UI may theme them, but keeping them in the core means every surface
 * (board, expression chips, future adapters) agrees on a node's family color.
 */
export type NodeCategory =
  | "input"
  | "time"
  | "math"
  | "vector"
  | "color"
  | "logic"
  | "layer"
  | "object"
  | "effect"
  | "sound"
  | "track"
  | "output";

export interface CategoryMeta {
  label: string;
  /** Accent hex for the node header / add-menu group. */
  color: string;
}

export const CATEGORY_META: Record<NodeCategory, CategoryMeta> = {
  input: { label: "Input", color: "#5fb04f" },
  time: { label: "Time", color: "#3c9f9f" },
  math: { label: "Math", color: "#4a6fb0" },
  vector: { label: "Vector", color: "#8a5fb0" },
  color: { label: "Color", color: "#c9a13b" },
  logic: { label: "Logic", color: "#7d8794" },
  object: { label: "Object", color: "#3b8ec7" },
  effect: { label: "Effect", color: "#b06fb0" },
  layer: { label: "Layer", color: "#c77a3b" },
  sound: { label: "Sound", color: "#d65f86" },
  track: { label: "Tracking", color: "#4ade80" },
  output: { label: "Output", color: "#b04a4a" },
};

/** Every category, in menu order — the record's own order, so a new category
 *  is one entry above and every palette lists it. Two hand-kept copies of this
 *  list in the app are how the Sound node never reached the add menu. */
export const NODE_CATEGORIES = Object.keys(CATEGORY_META) as NodeCategory[];

/** Which surfaces a node type is allowed on. Board = the free workspace;
 *  expression = a property driver. Defaults to BOTH when a def omits it. */
export type NodeContext = "board" | "expression";

/** An input or output port on a node. `default` is the literal an unconnected
 *  input starts with (stored in `node.params`) — the inline value field. */
export interface SocketSpec {
  key: string;
  label: string;
  type: SocketType;
  default?: NodeValue;
  /** Grouping label for dense projection nodes (e.g. "Transform"); optional. */
  group?: string;
  /** The document property PATH this socket reads/writes, when it mirrors one.
   *  Set by projection nodes (Object/Transform/…) — the sink for driver writes,
   *  the source for reads. Absent on plain math sockets. */
  path?: string;
}

/**
 * DYNAMIC SOCKETS — a node's ports may be a fixed list OR a pure function of the
 * node instance + a host introspection hook. This is what lets ONE Object node
 * mirror whatever layer it targets: its sockets are `clipAnimatableProperties`
 * projected, so the moment the document's data shape changes the node's ports
 * follow with no code change. Plain nodes just pass an array.
 */
export interface SocketResolveCtx {
  /** The node whose sockets are being resolved — its params name any target. */
  node: GraphNode;
  /** Host hook: the live animatable properties of a target object (clip id). */
  describeClip?: (targetId: string) => ClipProperty[];
}

export type SocketList = SocketSpec[] | ((ctx: SocketResolveCtx) => SocketSpec[]);

/** Resolve a (possibly dynamic) socket list to concrete specs. */
export function resolveSockets(list: SocketList, ctx: SocketResolveCtx): SocketSpec[] {
  return typeof list === "function" ? list(ctx) : list;
}

export interface OptionChoice {
  value: string;
  label: string;
}

/** A non-socket configuration control on a node (a dropdown, a toggle) — e.g.
 *  the Math node's operation. Stored in `node.params` under `key`. */
export interface OptionSpec {
  key: string;
  label: string;
  kind: "enum" | "float" | "bool" | "color" | "string";
  /** For `kind: "enum"`. */
  choices?: OptionChoice[];
  default: NodeParam;
  min?: number;
  max?: number;
  step?: number;
  /**
   * A `string` option that holds a REFERENCE — what it may point at, as the
   * pick registry's filter. The card renders the object field (list + aim) from
   * this alone. A layer is stored by id; a property by its path, on the layer
   * the option `pickOn` names.
   */
  pick?: PickFilter;
  pickOn?: string;
}

/** What a node's `evaluate` can see: the clock and a host-provided reader for
 *  other layers' values. Kept minimal + injected so the core never depends on
 *  the document at eval time — the host threads whatever it wants readable. */
export interface EvalContext {
  timeMs: number;
  fps: number;
  /**
   * Resolve any clip's property value at a time (transform, effects, …). The
   * host injects this (it owns the sampler); undefined = reads yield 0. This is
   * what lets a `layer.property` node drive one layer from another's motion.
   */
  readProperty?: (clipId: string, propertyKey: string, timeMs: number) => number | string | boolean | undefined;
  /** The live animatable properties of a target clip — feeds projection nodes'
   *  dynamic sockets during evaluation (same hook as `SocketResolveCtx`). */
  describeClip?: (targetId: string) => ClipProperty[];
  /** Read a document variable's value (keyframe-aware, sampled at the host's
   *  clock). Injected by the host; undefined = the Variables node reads defaults.
   *  The one hook that lets a graph consume `doc.variables`. */
  readVariable?: (id: string) => number | string | boolean | { x: number; y: number } | undefined;
  /**
   * What the Expression node needs to run the WRITTEN language inside a graph:
   * the document's variables (named, not id'd — expressions refer to them the
   * way people do) and the sampler that reads their live value. Injected by the
   * host exactly like `readVariable`; absent = an Expression node outputs 0.
   */
  expressions?: { variables: Variable[]; sample: (variable: Variable) => NodeValue };
  /**
   * Where a media layer (id or name) is in its recording at the host's clock,
   * plus `offsetMs` — the one source-time map (`mediaSourceAt`), so the Sound
   * node hears exactly what plays. Injected by the host; absent = silence.
   */
  mediaAt?: (layer: string, offsetMs: number) => { assetId: string; sourceMs: number } | undefined;
  /**
   * A tracker's reading (by tracker id or name) in this comp at the host's
   * clock — core's one tracking reader, so the Track node and `track()` agree.
   * Injected by the host; absent = every reading is its identity.
   */
  trackAt?: (tracker: string, reading: string) => NodeValue | undefined;
}

export interface EvaluateArgs {
  /** Input socket values, already resolved from wires/params and coerced to the
   *  socket's declared type — `evaluate` just does math. */
  inputs: Record<string, NodeValue>;
  /** Keys of the inputs fed by an actual WIRE (not a default/literal). A
   *  projection node treats these as SPECIFIC WRITES: the wired value wins over
   *  the target layer's live value, so the output never clobbers what's injected
   *  into that exact field (CSS-selector specificity). */
  connected: Set<string>;
  /** Merged option/param values (defaults overlaid with the node's own). */
  params: Record<string, NodeParam>;
  ctx: EvalContext;
  node: GraphNode;
}

export interface NodeTypeDef {
  type: string;
  category: NodeCategory;
  title: string;
  description?: string;
  /** Input ports — a fixed list, or a resolver of the node + host (projection). */
  inputs: SocketList;
  /** Output ports — a fixed list, or a resolver of the node + host (projection). */
  outputs: SocketList;
  options?: OptionSpec[];
  /** Allowed surfaces; omit = both board and expression. */
  contexts?: NodeContext[];
  /**
   * Keep this type OUT of the add-menu. For nodes the app MATERIALISES rather
   * than the user placing them (the per-effect cards mirror `clip.effects`) —
   * offering them in the palette would create a second, conflicting way to add
   * an effect. They are still ordinary registry entries in every other respect.
   */
  hidden?: boolean;
  /** Pure: same inputs+params+ctx → same outputs, keyed by output socket key. */
  evaluate: (args: EvaluateArgs) => Record<string, NodeValue>;
}

/** Is a node type usable in the given context (board vs expression)? */
export function allowsContext(def: NodeTypeDef, ctx: NodeContext): boolean {
  return def.contexts === undefined || def.contexts.includes(ctx);
}

/**
 * The node catalogue. A tiny class (not a bare Map) so hosts/plugins can spin up
 * their own registry, and so lookups/grouping have one obvious home. The
 * app-wide default is `defaultNodeRegistry` in `./builtin`.
 */
export class NodeRegistry {
  private defs = new Map<string, NodeTypeDef>();

  register(def: NodeTypeDef): this {
    if (this.defs.has(def.type)) throw new Error(`Duplicate node type: ${def.type}`);
    this.defs.set(def.type, def);
    return this;
  }

  registerAll(defs: NodeTypeDef[]): this {
    for (const d of defs) this.register(d);
    return this;
  }

  get(type: string): NodeTypeDef | undefined {
    return this.defs.get(type);
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  all(): NodeTypeDef[] {
    return [...this.defs.values()];
  }

  /** Every type allowed in a context, useful for building the add-menu. */
  forContext(ctx: NodeContext): NodeTypeDef[] {
    return this.all().filter((d) => allowsContext(d, ctx));
  }

  /** A node's resolved input sockets (dynamic lists included). */
  inputsOf(node: GraphNode, ctx?: Partial<SocketResolveCtx>): SocketSpec[] {
    const def = this.defs.get(node.type);
    return def ? resolveSockets(def.inputs, { node, ...ctx }) : [];
  }

  /** A node's resolved output sockets (dynamic lists included). */
  outputsOf(node: GraphNode, ctx?: Partial<SocketResolveCtx>): SocketSpec[] {
    const def = this.defs.get(node.type);
    return def ? resolveSockets(def.outputs, { node, ...ctx }) : [];
  }
}
