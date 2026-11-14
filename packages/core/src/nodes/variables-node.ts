import type { GraphNode, NodeValue, SocketType, VariableType } from "../schema";
import type { NodeTypeDef } from "./registry";

/**
 * THE VARIABLES NODE — reads document variables onto the board. You pick which
 * variables to expose (an iterator, since a document may hold many); each becomes
 * one OUTPUT socket carrying its live, keyframe-aware value, wireable into any
 * property or node. It is deliberately a projection of `doc.variables` (like the
 * Object node projects a clip): the sockets are a pure function of the selection,
 * so the moment you add/remove a variable the ports follow with no code change.
 *
 * The selection lives in `node.params.vars` as a JSON list of `{id,type,name}` —
 * self-contained so socket TYPE (stable per variable) needs no host lookup; the
 * live NAME is refreshed by the card from the document. Values are read at eval
 * time through `EvalContext.readVariable`, which the host samples at the clock —
 * so a keyframed variable reads its animated value here too.
 */

export const VARIABLES_NODE_TYPE = "input.variables";

/** The `node.params` key holding the serialized variable selection. */
export const VARIABLES_PARAM_KEY = "vars";

/** One exposed variable on the node: enough to lay out its socket without a lookup. */
export interface SelectedVariable {
  id: string;
  type: VariableType;
  name: string;
}

/**
 * The socket type a variable of the given kind carries, or null when the board
 * has no socket for it. Paint variables are that case — a socket carries a
 * scalar and a paint is a whole object — so the Variables node simply does not
 * offer them rather than offering a socket that could never be wired.
 */
export function socketTypeForVariable(type: VariableType): SocketType | null {
  switch (type) {
    case "color":
      return "color";
    case "number":
    case "fontWeight":
      return "float";
    case "fontFamily":
    case "string":
      return "string";
    case "paint":
      return null;
  }
}

/** A type-appropriate zero, used when a variable can't be read (e.g. deleted). */
export function defaultForVariable(type: VariableType): NodeValue {
  switch (type) {
    case "color":
      return "#ffffff";
    case "number":
      return 0;
    case "fontWeight":
      return 400;
    case "fontFamily":
    case "string":
      return "";
    // Unreachable through the board (paints get no socket), but the switch is
    // total so a new variable type is a compile error here rather than a
    // silently undefined default at runtime.
    case "paint":
      return "";
  }
}

/** Parse a node's exposed-variable selection (tolerant of legacy/empty params). */
export function parseSelectedVariables(node: GraphNode): SelectedVariable[] {
  const raw = node.params[VARIABLES_PARAM_KEY];
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is SelectedVariable =>
        !!v && typeof (v as SelectedVariable).id === "string" && typeof (v as SelectedVariable).type === "string",
    );
  } catch {
    return [];
  }
}

/** Serialize a selection back into the params string. */
export function serializeSelectedVariables(vars: SelectedVariable[]): string {
  return JSON.stringify(vars.map((v) => ({ id: v.id, type: v.type, name: v.name })));
}

/** The selected variables the board can actually wire, paired with their socket
 *  type — one filter, so the inputs, the outputs and the evaluation cannot
 *  disagree about which rows exist. */
function socketedVariables(node: Parameters<typeof parseSelectedVariables>[0]) {
  return parseSelectedVariables(node).flatMap((v) => {
    const type = socketTypeForVariable(v.type);
    return type ? [{ v, type }] : [];
  });
}

export const variablesNode: NodeTypeDef = {
  type: VARIABLES_NODE_TYPE,
  category: "input",
  title: "Variables",
  description: "Read document variables — pick which to expose; each is a live, keyframe-aware output.",
  // Each exposed variable is one ROW with an input AND an output on the same key
  // — the shape the primitive Value/Color nodes already use. Unwired, the row is
  // the variable's own editable value; wired, the incoming value DRIVES it.
  // Writing happens by storing a driver on the variable (see `Variable.driver`),
  // never by mutating the document mid-evaluation, so this node stays as pure as
  // every other one.
  // A variable with no socket type (a paint) is not offered a row at all. An
  // unwireable socket would be worse than its absence — it reads as broken.
  inputs: (ctx) =>
    socketedVariables(ctx.node).map(({ v, type }) => ({
      key: v.id,
      label: v.name,
      type,
      default: defaultForVariable(v.type),
    })),
  outputs: (ctx) =>
    socketedVariables(ctx.node).map(({ v, type }) => ({ key: v.id, label: v.name, type })),
  evaluate: ({ node, ctx, inputs, connected }) => {
    const out: Record<string, NodeValue> = {};
    for (const { v } of socketedVariables(node)) {
      // A wired row passes the incoming value straight through, so the rest of
      // the board reads what the variable is ABOUT to be rather than one frame of
      // stale value — the same specificity rule the projection nodes use.
      if (connected.has(v.id)) {
        out[v.id] = inputs[v.id] ?? defaultForVariable(v.type);
        continue;
      }
      out[v.id] = ctx.readVariable?.(v.id) ?? defaultForVariable(v.type);
    }
    return out;
  },
};
