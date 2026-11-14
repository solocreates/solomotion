import type { NodeValue } from "../schema";
import { lerpColor, parseHexColor, formatHexColor } from "../animation/properties";
import { EFFECTS_HUB_NODE, EFFECT_NODES } from "./effect-nodes";
import { PROJECTION_NODES } from "./projection";
import { variablesNode } from "./variables-node";
import { expressionNode } from "./expression-node";
import { soundNode } from "./sound-node";
import { trackNode } from "../tracking/track-node";
import { NodeRegistry, type NodeTypeDef } from "./registry";
import { isVec2 } from "./sockets";

/**
 * THE BUILT-IN NODE LIBRARY — the app's starter catalogue, Blender-categorised.
 * Every node is one `NodeTypeDef`: pure data + a pure `evaluate`. Following
 * Blender, families that vary only by operation are ONE node with an operation
 * dropdown (Math, Vector Math, Compare) rather than a node per operator — the
 * catalogue stays small and the UI stays uncluttered.
 *
 * These are the nodes usable from BOTH the free board and expressions. When a
 * board-only node kind arrives (e.g. render-to-canvas), it sets
 * `contexts: ["board"]` and the expression add-menu drops it automatically.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

// Inputs are guaranteed present by the evaluator, but `noUncheckedIndexedAccess`
// widens `inputs.x` to `| undefined` — these accessors normalise that away.
const num = (v: NodeValue | undefined): number => (typeof v === "number" ? v : 0);
const vec = (v: NodeValue | undefined): { x: number; y: number } => (isVec2(v) ? v : { x: 0, y: 0 });
const str = (v: NodeValue | undefined): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ── Input (constants) ────────────────────────────────────────────────────────

// Value/Vector/Color/Boolean are the primitive VALUES of the node world. Each is
// input AND output on ONE combined socket (key shared): unwired, the row's inline
// editor sets the literal (the socket default IS the param); wired, it passes the
// incoming value straight through. So every value is drive-able and readable with
// no separate "constant vs set" nodes — uniform and headless, like every field.
const inputValue: NodeTypeDef = {
  type: "input.value",
  category: "input",
  title: "Value",
  description: "A number — type it, or drive it.",
  inputs: [{ key: "value", label: "Value", type: "float", default: 0 }],
  outputs: [{ key: "value", label: "Value", type: "float" }],
  evaluate: ({ inputs }) => ({ value: num(inputs.value) }),
};

const inputVector: NodeTypeDef = {
  type: "input.vector",
  category: "input",
  title: "Vector",
  description: "A 2D vector — X and Y each drive-able, plus a combined output.",
  // X and Y are each their own combined in/out row (sub-fields with input AND
  // output, like a Transform); the extra `vector` output packs them into a vec2.
  inputs: [
    { key: "x", label: "X", type: "float", default: 0 },
    { key: "y", label: "Y", type: "float", default: 0 },
  ],
  outputs: [
    { key: "x", label: "X", type: "float" },
    { key: "y", label: "Y", type: "float" },
    { key: "vector", label: "Vector", type: "vec2" },
  ],
  evaluate: ({ inputs }) => {
    const x = num(inputs.x);
    const y = num(inputs.y);
    return { x, y, vector: { x, y } };
  },
};

const inputColor: NodeTypeDef = {
  type: "input.color",
  category: "input",
  title: "Color",
  description: "A color — pick it, or drive it.",
  inputs: [{ key: "color", label: "Color", type: "color", default: "#ffffff" }],
  outputs: [{ key: "color", label: "Color", type: "color" }],
  evaluate: ({ inputs }) => ({ color: str(inputs.color) }),
};

const inputBool: NodeTypeDef = {
  type: "input.bool",
  category: "input",
  title: "Boolean",
  description: "An on/off value — toggle it, or drive it.",
  inputs: [{ key: "value", label: "On", type: "bool", default: false }],
  outputs: [{ key: "value", label: "Value", type: "bool" }],
  evaluate: ({ inputs }) => ({ value: Boolean(inputs.value) }),
};

// ── Time ─────────────────────────────────────────────────────────────────────

const timeSeconds: NodeTypeDef = {
  type: "time.seconds",
  category: "time",
  title: "Time",
  description: "The playhead time, in seconds.",
  inputs: [],
  outputs: [{ key: "seconds", label: "Seconds", type: "float" }],
  evaluate: ({ ctx }) => ({ seconds: ctx.timeMs / 1000 }),
};

const timeFrame: NodeTypeDef = {
  type: "time.frame",
  category: "time",
  title: "Frame",
  description: "The current frame index at the document fps.",
  inputs: [],
  outputs: [{ key: "frame", label: "Frame", type: "float" }],
  evaluate: ({ ctx }) => ({ frame: Math.round((ctx.timeMs / 1000) * ctx.fps) }),
};

// ── Math ─────────────────────────────────────────────────────────────────────

const MATH_OPS = [
  { value: "add", label: "Add" },
  { value: "subtract", label: "Subtract" },
  { value: "multiply", label: "Multiply" },
  { value: "divide", label: "Divide" },
  { value: "power", label: "Power" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
  { value: "modulo", label: "Modulo" },
  { value: "abs", label: "Absolute" },
  { value: "sqrt", label: "Square Root" },
  { value: "sin", label: "Sine" },
  { value: "cos", label: "Cosine" },
  { value: "tan", label: "Tangent" },
  { value: "floor", label: "Floor" },
  { value: "round", label: "Round" },
  { value: "ceil", label: "Ceil" },
  { value: "sign", label: "Sign" },
  { value: "fract", label: "Fraction" },
] as const;

function applyMath(op: string, a: number, b: number): number {
  switch (op) {
    case "add":
      return a + b;
    case "subtract":
      return a - b;
    case "multiply":
      return a * b;
    case "divide":
      return b === 0 ? 0 : a / b;
    case "power":
      return Math.pow(a, b);
    case "min":
      return Math.min(a, b);
    case "max":
      return Math.max(a, b);
    case "modulo":
      return b === 0 ? 0 : a % b;
    case "abs":
      return Math.abs(a);
    case "sqrt":
      return Math.sqrt(Math.max(0, a));
    case "sin":
      return Math.sin(a);
    case "cos":
      return Math.cos(a);
    case "tan":
      return Math.tan(a);
    case "floor":
      return Math.floor(a);
    case "round":
      return Math.round(a);
    case "ceil":
      return Math.ceil(a);
    case "sign":
      return Math.sign(a);
    case "fract":
      return a - Math.floor(a);
    default:
      return a;
  }
}

const mathOp: NodeTypeDef = {
  type: "math.op",
  category: "math",
  title: "Math",
  description: "A scalar operation (add, multiply, sine, …). Unary ops ignore B.",
  inputs: [
    { key: "a", label: "A", type: "float", default: 0 },
    { key: "b", label: "B", type: "float", default: 0 },
  ],
  outputs: [{ key: "value", label: "Value", type: "float" }],
  options: [{ key: "operation", label: "Operation", kind: "enum", choices: [...MATH_OPS], default: "add" }],
  evaluate: ({ inputs, params }) => ({
    value: applyMath(str(params.operation as NodeValue), num(inputs.a), num(inputs.b)),
  }),
};

const mathMix: NodeTypeDef = {
  type: "math.mix",
  category: "math",
  title: "Mix",
  description: "Linear blend from A to B by Factor.",
  inputs: [
    { key: "a", label: "A", type: "float", default: 0 },
    { key: "b", label: "B", type: "float", default: 1 },
    { key: "factor", label: "Factor", type: "float", default: 0.5 },
  ],
  outputs: [{ key: "value", label: "Value", type: "float" }],
  evaluate: ({ inputs }) => {
    const a = num(inputs.a);
    const b = num(inputs.b);
    return { value: a + (b - a) * num(inputs.factor) };
  },
};

const mathClamp: NodeTypeDef = {
  type: "math.clamp",
  category: "math",
  title: "Clamp",
  description: "Constrain a value to a [min, max] range.",
  inputs: [
    { key: "value", label: "Value", type: "float", default: 0 },
    { key: "min", label: "Min", type: "float", default: 0 },
    { key: "max", label: "Max", type: "float", default: 1 },
  ],
  outputs: [{ key: "value", label: "Value", type: "float" }],
  evaluate: ({ inputs }) => {
    const lo = num(inputs.min);
    const hi = num(inputs.max);
    return { value: clamp(num(inputs.value), Math.min(lo, hi), Math.max(lo, hi)) };
  },
};

const mathMapRange: NodeTypeDef = {
  type: "math.map_range",
  category: "math",
  title: "Map Range",
  description: "Remap a value from one range to another (optionally clamped).",
  inputs: [
    { key: "value", label: "Value", type: "float", default: 0 },
    { key: "fromMin", label: "From Min", type: "float", default: 0 },
    { key: "fromMax", label: "From Max", type: "float", default: 1 },
    { key: "toMin", label: "To Min", type: "float", default: 0 },
    { key: "toMax", label: "To Max", type: "float", default: 1 },
  ],
  outputs: [{ key: "value", label: "Value", type: "float" }],
  options: [{ key: "clamp", label: "Clamp", kind: "bool", default: true }],
  evaluate: ({ inputs, params }) => {
    const v = num(inputs.value);
    const fMin = num(inputs.fromMin);
    const fMax = num(inputs.fromMax);
    const tMin = num(inputs.toMin);
    const tMax = num(inputs.toMax);
    const t = fMax === fMin ? 0 : (v - fMin) / (fMax - fMin);
    const mapped = tMin + (tMax - tMin) * t;
    return { value: params.clamp ? clamp(mapped, Math.min(tMin, tMax), Math.max(tMin, tMax)) : mapped };
  },
};

// ── Vector ───────────────────────────────────────────────────────────────────

const vectorCombine: NodeTypeDef = {
  type: "vector.combine",
  category: "vector",
  title: "Combine XY",
  description: "Build a vector from separate X and Y.",
  inputs: [
    { key: "x", label: "X", type: "float", default: 0 },
    { key: "y", label: "Y", type: "float", default: 0 },
  ],
  outputs: [{ key: "vector", label: "Vector", type: "vec2" }],
  evaluate: ({ inputs }) => ({ vector: { x: num(inputs.x), y: num(inputs.y) } }),
};

const vectorSeparate: NodeTypeDef = {
  type: "vector.separate",
  category: "vector",
  title: "Separate XY",
  description: "Split a vector into X and Y.",
  inputs: [{ key: "vector", label: "Vector", type: "vec2", default: { x: 0, y: 0 } }],
  outputs: [
    { key: "x", label: "X", type: "float" },
    { key: "y", label: "Y", type: "float" },
  ],
  evaluate: ({ inputs }) => {
    const v = vec(inputs.vector);
    return { x: v.x, y: v.y };
  },
};

const VEC_OPS = [
  { value: "add", label: "Add" },
  { value: "subtract", label: "Subtract" },
  { value: "multiply", label: "Multiply" },
  { value: "scale", label: "Scale" },
  { value: "dot", label: "Dot Product" },
  { value: "distance", label: "Distance" },
  { value: "length", label: "Length" },
  { value: "normalize", label: "Normalize" },
] as const;

const vectorMath: NodeTypeDef = {
  type: "vector.math",
  category: "vector",
  title: "Vector Math",
  description: "Vector operations. Vector output for add/…, Value output for dot/length/distance.",
  inputs: [
    { key: "a", label: "A", type: "vec2", default: { x: 0, y: 0 } },
    { key: "b", label: "B", type: "vec2", default: { x: 0, y: 0 } },
    { key: "scale", label: "Scale", type: "float", default: 1 },
  ],
  outputs: [
    { key: "vector", label: "Vector", type: "vec2" },
    { key: "value", label: "Value", type: "float" },
  ],
  options: [{ key: "operation", label: "Operation", kind: "enum", choices: [...VEC_OPS], default: "add" }],
  evaluate: ({ inputs, params }) => {
    const a = vec(inputs.a);
    const b = vec(inputs.b);
    const s = num(inputs.scale);
    const op = str(params.operation as NodeValue);
    switch (op) {
      case "add":
        return { vector: { x: a.x + b.x, y: a.y + b.y }, value: 0 };
      case "subtract":
        return { vector: { x: a.x - b.x, y: a.y - b.y }, value: 0 };
      case "multiply":
        return { vector: { x: a.x * b.x, y: a.y * b.y }, value: 0 };
      case "scale":
        return { vector: { x: a.x * s, y: a.y * s }, value: 0 };
      case "dot":
        return { vector: { x: 0, y: 0 }, value: a.x * b.x + a.y * b.y };
      case "distance":
        return { vector: { x: 0, y: 0 }, value: Math.hypot(a.x - b.x, a.y - b.y) };
      case "length":
        return { vector: { x: 0, y: 0 }, value: Math.hypot(a.x, a.y) };
      case "normalize": {
        const len = Math.hypot(a.x, a.y);
        return { vector: len === 0 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len }, value: len };
      }
      default:
        return { vector: a, value: 0 };
    }
  },
};

// ── Color ────────────────────────────────────────────────────────────────────

const colorCombine: NodeTypeDef = {
  type: "color.combine",
  category: "color",
  title: "Combine Color",
  description: "Build a color from R, G, B, A channels (0..1).",
  inputs: [
    { key: "r", label: "R", type: "float", default: 0 },
    { key: "g", label: "G", type: "float", default: 0 },
    { key: "b", label: "B", type: "float", default: 0 },
    { key: "a", label: "A", type: "float", default: 1 },
  ],
  outputs: [{ key: "color", label: "Color", type: "color" }],
  evaluate: ({ inputs }) => ({
    color: formatHexColor({
      r: clamp(num(inputs.r), 0, 1) * 255,
      g: clamp(num(inputs.g), 0, 1) * 255,
      b: clamp(num(inputs.b), 0, 1) * 255,
      a: clamp(num(inputs.a), 0, 1),
    }),
  }),
};

const colorSeparate: NodeTypeDef = {
  type: "color.separate",
  category: "color",
  title: "Separate Color",
  description: "Split a color into R, G, B, A channels (0..1).",
  inputs: [{ key: "color", label: "Color", type: "color", default: "#ffffff" }],
  outputs: [
    { key: "r", label: "R", type: "float" },
    { key: "g", label: "G", type: "float" },
    { key: "b", label: "B", type: "float" },
    { key: "a", label: "A", type: "float" },
  ],
  evaluate: ({ inputs }) => {
    const c = parseHexColor(str(inputs.color)) ?? { r: 0, g: 0, b: 0, a: 1 };
    return { r: c.r / 255, g: c.g / 255, b: c.b / 255, a: c.a };
  },
};

const colorMix: NodeTypeDef = {
  type: "color.mix",
  category: "color",
  title: "Mix Color",
  description: "Blend two colors by factor.",
  inputs: [
    { key: "a", label: "A", type: "color", default: "#000000" },
    { key: "b", label: "B", type: "color", default: "#ffffff" },
    { key: "factor", label: "Factor", type: "float", default: 0.5 },
  ],
  outputs: [{ key: "color", label: "Color", type: "color" }],
  evaluate: ({ inputs }) => ({
    color: lerpColor(str(inputs.a), str(inputs.b), clamp(num(inputs.factor), 0, 1)),
  }),
};

// ── Logic ────────────────────────────────────────────────────────────────────

const COMPARE_OPS = [
  { value: "gt", label: "Greater Than" },
  { value: "lt", label: "Less Than" },
  { value: "gte", label: "Greater or Equal" },
  { value: "lte", label: "Less or Equal" },
  { value: "eq", label: "Equal" },
  { value: "neq", label: "Not Equal" },
] as const;

const logicCompare: NodeTypeDef = {
  type: "logic.compare",
  category: "logic",
  title: "Compare",
  description: "Compare two values → a boolean AND a 1/0 value you can wire on.",
  inputs: [
    { key: "a", label: "A", type: "float", default: 0 },
    { key: "b", label: "B", type: "float", default: 0 },
  ],
  // Both faces of the result: `result` for logic wires, `value` (1/0) so it can
  // drive any numeric field directly without a separate bool→number step.
  outputs: [
    { key: "result", label: "Result", type: "bool" },
    { key: "value", label: "Value", type: "float" },
  ],
  options: [{ key: "operation", label: "Operation", kind: "enum", choices: [...COMPARE_OPS], default: "gt" }],
  evaluate: ({ inputs, params }) => {
    const a = num(inputs.a);
    const b = num(inputs.b);
    const eps = 1e-6;
    const op = str(params.operation as NodeValue);
    let r = false;
    switch (op) {
      case "gt":
        r = a > b;
        break;
      case "lt":
        r = a < b;
        break;
      case "gte":
        r = a >= b;
        break;
      case "lte":
        r = a <= b;
        break;
      case "eq":
        r = Math.abs(a - b) <= eps;
        break;
      case "neq":
        r = Math.abs(a - b) > eps;
        break;
    }
    return { result: r, value: r ? 1 : 0 };
  },
};

const logicSwitch: NodeTypeDef = {
  type: "logic.switch",
  category: "logic",
  title: "Switch",
  description: "Pass True or False input depending on the condition.",
  inputs: [
    { key: "condition", label: "Condition", type: "bool", default: false },
    { key: "ifFalse", label: "False", type: "any", default: 0 },
    { key: "ifTrue", label: "True", type: "any", default: 0 },
  ],
  outputs: [{ key: "result", label: "Result", type: "any" }],
  evaluate: ({ inputs }) => ({ result: (inputs.condition ? inputs.ifTrue : inputs.ifFalse) ?? 0 }),
};

// ── Layer (read) ─────────────────────────────────────────────────────────────

const layerProperty: NodeTypeDef = {
  type: "layer.property",
  category: "layer",
  title: "Layer Value",
  description: "Read any layer's property value at the current time (e.g. x, opacity, rotation).",
  inputs: [],
  outputs: [{ key: "value", label: "Value", type: "any" }],
  options: [
    { key: "layer", label: "Layer", kind: "string", default: "", pick: { kinds: ["layer"] } },
    { key: "property", label: "Property", kind: "string", default: "x", pick: { kinds: ["property"] }, pickOn: "layer" },
  ],
  evaluate: ({ params, ctx }) => {
    const layer = str(params.layer as NodeValue);
    const property = str(params.property as NodeValue);
    if (!layer || !ctx.readProperty) return { value: 0 };
    const raw = ctx.readProperty(layer, property, ctx.timeMs);
    return { value: raw === undefined ? 0 : raw };
  },
};

// ── Output (the graph's result) ──────────────────────────────────────────────

const outputValue: NodeTypeDef = {
  type: "output.value",
  category: "output",
  title: "Output",
  description: "The graph's result. In expression mode this drives the bound property.",
  inputs: [{ key: "value", label: "Value", type: "any", default: 0 }],
  // Echoes its input so `evaluateDriver` can read the resolved value off the
  // Output node's own socket like any other node.
  outputs: [{ key: "value", label: "Value", type: "any" }],
  evaluate: ({ inputs }) => ({ value: inputs.value ?? 0 }),
};

/** The socket key on the Output node that carries the graph's driven value. */
export const OUTPUT_NODE_TYPE = outputValue.type;
export const OUTPUT_SOCKET_KEY = "value";

export const BUILTIN_NODES: NodeTypeDef[] = [
  inputValue,
  inputVector,
  inputColor,
  inputBool,
  variablesNode,
  expressionNode,
  soundNode,
  trackNode,
  timeSeconds,
  timeFrame,
  mathOp,
  mathMix,
  mathClamp,
  mathMapRange,
  vectorCombine,
  vectorSeparate,
  vectorMath,
  colorCombine,
  colorSeparate,
  colorMix,
  logicCompare,
  logicSwitch,
  layerProperty,
  ...PROJECTION_NODES,
  // The effect stack, projected: the chain hub plus one card per effect kind.
  EFFECTS_HUB_NODE,
  ...EFFECT_NODES,
  outputValue,
];

/** The app-wide registry, preloaded with every built-in node. Hosts/plugins can
 *  build their own `NodeRegistry` and register more. */
export const defaultNodeRegistry: NodeRegistry = new NodeRegistry().registerAll(BUILTIN_NODES);
