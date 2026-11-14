import type { LengthUnit } from "../schema/units";
import { formatHexColor, lerpColor } from "../animation/properties";
import { isVec2 } from "../nodes/sockets";
import type { ExprContext } from "./globals";
import { unifyTypes, type ExprType, type ExprValue } from "./types";

/**
 * THE FUNCTION LIBRARY — the verbs of the language, in one table.
 *
 * Like the globals table, this is the single source for autocomplete, the
 * checker's arity/type rules, the evaluator's implementations and the docs page.
 * Names deliberately match the NODE catalogue wherever the same idea exists
 * (`mix`, `clamp`, `map`, `rgb`, `vec`), because the expression node and the
 * math node are two faces of one system — a user who learns one has learned the
 * other, and a graph translated to text reads like the graph.
 *
 * Every function is PURE. The two that look random (`random`, `wiggle`) take
 * their entropy from `ctx.seed` plus the call's own position in the source, so
 * the same field wobbles identically on every replay, on every machine, and two
 * `wiggle()` calls in one expression still differ from each other.
 */

export type FunctionCategory =
  | "math"
  | "character"
  | "trig"
  | "interpolate"
  | "random"
  | "color"
  | "vector"
  | "text"
  | "logic"
  | "layer"
  | "track"
  | "sound"
  | "units";

export const FUNCTION_CATEGORY_META: Record<FunctionCategory, { label: string; describe: string }> = {
  math: { label: "Math", describe: "Arithmetic and rounding." },
  trig: { label: "Trigonometry", describe: "Angles, waves and circles. Angles are in radians." },
  interpolate: { label: "Interpolation", describe: "Blending and remapping ranges — the heart of most expressions." },
  random: { label: "Random", describe: "Repeatable randomness: the same wobble every time you play." },
  color: { label: "Color", describe: "Build and blend colours." },
  vector: { label: "Vector", describe: "Two-component values, for positions and sizes." },
  text: { label: "Text", describe: "Turn values into text — counters, labels, padded numbers." },
  logic: { label: "Logic", describe: "Choose between two values." },
  layer: { label: "Layers", describe: "Read values off other layers in the composition." },
  character: { label: "Character", describe: "Voices, poses, states and inputs — what makes a character act." },
  track: { label: "Tracking", describe: "Read what footage knows — where a tracked thing is, how it turned, the corners of a tracked surface." },
  sound: { label: "Sound", describe: "Make anything react to a sound — its loudness, its bass, its hits, its beat." },
  units: { label: "Units", describe: "Sizes in comp, parent or screen terms, in px — mix them like CSS calc()." },
};

export interface FunctionParam {
  name: string;
  /** null = accepts any type (a polymorphic argument like `mix`'s a/b). */
  type: ExprType | null;
  optional?: boolean;
  describe: string;
}

export interface FunctionDef {
  name: string;
  category: FunctionCategory;
  params: FunctionParam[];
  /**
   * A fixed type, one inferred from the argument types (`mix`, `if`), or null
   * for a result only knowable at run time (`layer()`, whose type depends on
   * which property was named). Null means "don't complain" to the checker and
   * "read the type off the value" to the evaluator.
   */
  returns: ExprType | null | ((args: Array<ExprType | null>) => ExprType | null);
  describe: string;
  /** A one-line example, shown in autocomplete and the docs. */
  example?: string;
  /**
   * The implementation. `site` is a per-call-site salt (the callee's offset in
   * the source) so two calls to `random()` in one expression differ while each
   * stays stable across frames.
   */
  call: (args: ExprValue[], ctx: ExprContext, site: number) => ExprValue;
}

// ── value helpers ────────────────────────────────────────────────────────────

const n = (v: ExprValue | undefined): number => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : 0);
const s = (v: ExprValue | undefined): string => (typeof v === "string" ? v : v === undefined ? "" : String(v));
const v2 = (v: ExprValue | undefined): { x: number; y: number } => (isVec2(v) ? v : { x: 0, y: 0 });
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => clamp(v, 0, 1);

/** Deterministic 0..1 hash — the whole basis of `random`, `noise` and `wiggle`. */
function hash(x: number): number {
  const t = Math.sin(x * 127.1 + 311.7) * 43758.5453123;
  return t - Math.floor(t);
}

/** Smooth 1D value noise: random at whole numbers, eased in between. */
function valueNoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hash(i + seed * 17.13);
  const b = hash(i + 1 + seed * 17.13);
  return a + (b - a) * u;
}

/** Two octaves — enough to stop a wiggle looking like a sine wave. */
function fbm(t: number, seed: number): number {
  return valueNoise(t, seed) * 0.65 + valueNoise(t * 2.17 + 13.7, seed + 41) * 0.35;
}

/**
 * Is the eye shut at `t` seconds? Blinks fall `every` seconds apart on average,
 * each gap drawn from 60–140% of it, the first somewhere in the first gap; one
 * in six is a double blink. Walks the blinks from zero — a ten-minute film is
 * a few hundred steps.
 */
function blinkAt(t: number, every: number, length: number, seed: number): number {
  const gap = Math.max(0.2, every), shut = clamp(length, 0.01, gap / 2);
  if (t < 0) return 0;
  let at = gap * (0.3 + 0.7 * hash(seed * 3.17 + 0.5));
  for (let k = 1; at <= t; k++) {
    if (t < at + shut) return 1;
    // A double blink: a second one right after the first.
    if (hash(seed * 5.03 + k * 1.91) < 1 / 6) {
      const again = at + shut * 2.2;
      if (t >= again && t < again + shut) return 1;
    }
    at += gap * (0.6 + 0.8 * hash(seed * 7.31 + k * 2.71));
  }
  return 0;
}

function hslToHex(h: number, sat: number, l: number, a: number): string {
  const hue = (((h % 360) + 360) % 360) / 360;
  const S = clamp01(sat);
  const L = clamp01(l);
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S;
  const p = 2 * L - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return formatHexColor({
    r: channel(hue + 1 / 3) * 255,
    g: channel(hue) * 255,
    b: channel(hue - 1 / 3) * 255,
    a: clamp01(a),
  });
}

const P = (name: string, type: ExprType | null, describe: string, optional = false): FunctionParam => ({
  name,
  type,
  describe,
  optional,
});

/** A one-argument number function, the shape most of the math table takes. */
function unitFn(name: string, unit: LengthUnit, describe: string, example: string): FunctionDef {
  return {
    name,
    category: "units",
    params: [P("amount", "float", `How many ${unit === "%" ? "percent" : unit}.`)],
    returns: "float",
    describe,
    example,
    call: (args, ctx) => {
      const amount = n(args[0]);
      const id = ctx.layer?.id;
      return id && ctx.lengths ? amount * ctx.lengths(id, unit, ctx.fieldPath ?? "") : amount;
    },
  };
}

function math1(name: string, category: FunctionCategory, describe: string, fn: (x: number) => number, example?: string): FunctionDef {
  return {
    name,
    category,
    params: [P("value", "float", "The number to transform.")],
    returns: "float",
    describe,
    example,
    call: (args) => fn(n(args[0])),
  };
}

function math2(name: string, category: FunctionCategory, describe: string, fn: (a: number, b: number) => number, aName = "a", bName = "b", example?: string): FunctionDef {
  return {
    name,
    category,
    params: [P(aName, "float", "A number."), P(bName, "float", "A number.")],
    returns: "float",
    describe,
    example,
    call: (args) => fn(n(args[0]), n(args[1])),
  };
}

export const FUNCTIONS: FunctionDef[] = [
  // ── Math ───────────────────────────────────────────────────────────────────
  math1("abs", "math", "Distance from zero — drops the minus sign.", Math.abs, "abs(-4) → 4"),
  math1("sign", "math", "−1, 0 or 1, depending on which side of zero the value is.", Math.sign),
  math1("floor", "math", "Rounds down to a whole number.", Math.floor, "floor(2.9) → 2"),
  math1("ceil", "math", "Rounds up to a whole number.", Math.ceil),
  math1("round", "math", "Rounds to the nearest whole number.", Math.round),
  math1("sqrt", "math", "Square root. Negative input gives 0 rather than an error.", (x) => Math.sqrt(Math.max(0, x))),
  math1("exp", "math", "e raised to this power.", Math.exp),
  math1("log", "math", "Natural logarithm. Zero or less gives 0 rather than an error.", (x) => (x > 0 ? Math.log(x) : 0)),
  math1("fract", "math", "Just the part after the decimal point — 0 to 1, and it loops.", (x) => x - Math.floor(x), "fract(#time) loops once a second"),
  math2("min", "math", "The smaller of two numbers.", Math.min),
  math2("max", "math", "The larger of two numbers.", Math.max),
  math2("pow", "math", "The first number raised to the power of the second.", Math.pow, "value", "exponent"),
  math2(
    "mod",
    "math",
    "The remainder after dividing — the usual way to make something repeat.",
    (a, b) => (b === 0 ? 0 : ((a % b) + b) % b),
    "value",
    "length",
    "mod(#time, 2) counts 0→2 over and over",
  ),
  {
    name: "clamp",
    category: "math",
    params: [P("value", "float", "The number to hold in range."), P("min", "float", "Lowest allowed."), P("max", "float", "Highest allowed.")],
    returns: "float",
    describe: "Holds a number inside a range — anything below the minimum becomes the minimum, and the same at the top.",
    example: "clamp(#progress, 0, 1)",
    call: (args) => {
      const lo = n(args[1]);
      const hi = n(args[2]);
      return clamp(n(args[0]), Math.min(lo, hi), Math.max(lo, hi));
    },
  },

  // ── Units ──────────────────────────────────────────────────────────────────
  // Each turns a length into THIS field's px, so they mix like CSS calc():
  // `fw(50) - spx(8)`. Write them on a px field (a field with a unit of its own
  // reads the result in that unit).
  unitFn("spx", "spx", "Screen pixels: the same size on the output at any zoom or scale.", "spx(2)"),
  unitFn("vw", "vw", "1% of the output's width, steady at any zoom.", "vw(10)"),
  unitFn("vh", "vh", "1% of the output's height, steady at any zoom.", "vh(5)"),
  unitFn("vmin", "vmin", "1% of the output's shorter side, steady at any zoom.", "vmin(4)"),
  unitFn("vmax", "vmax", "1% of the output's longer side, steady at any zoom.", "vmax(2)"),
  unitFn("fw", "fw", "1% of the comp's width.", "fw(50) - spx(8)"),
  unitFn("fh", "fh", "1% of the comp's height.", "fh(10)"),
  unitFn("pw", "%", "Percent of the parent box along this field's axis.", "pw(100) - 32"),

  // ── Trigonometry ───────────────────────────────────────────────────────────
  math1("sin", "trig", "Sine — a smooth wave from −1 to 1. Angles are in radians.", Math.sin, "sin(#time * 3) * 20"),
  math1("cos", "trig", "Cosine — the same wave as sine, a quarter turn ahead.", Math.cos),
  math1("tan", "trig", "Tangent.", Math.tan),
  math1("asin", "trig", "The angle whose sine is this value.", (x) => Math.asin(clamp(x, -1, 1))),
  math1("acos", "trig", "The angle whose cosine is this value.", (x) => Math.acos(clamp(x, -1, 1))),
  math1("atan", "trig", "The angle whose tangent is this value.", Math.atan),
  math2("atan2", "trig", "The angle from the origin to a point — the reliable way to aim one thing at another.", (y, x) => Math.atan2(y, x), "y", "x"),
  math1("radians", "trig", "Turns degrees into the radians every angle function here expects.", (d) => (d * Math.PI) / 180, "radians(90)"),
  math1("degrees", "trig", "Turns radians back into degrees.", (r) => (r * 180) / Math.PI),

  // ── Interpolation ──────────────────────────────────────────────────────────
  {
    name: "mix",
    category: "interpolate",
    params: [
      P("a", null, "The value at 0."),
      P("b", null, "The value at 1."),
      P("t", "float", "How far between them, 0 to 1."),
    ],
    returns: (args) => unifyTypes(args[0] ?? null, args[1] ?? null),
    describe: "Blends smoothly from the first value to the second. Works on numbers, colours and vectors alike.",
    example: 'mix("#ff8732", "#ff2885", #progress)',
    call: (args) => {
      const a = args[0];
      const b = args[1];
      const t = n(args[2]);
      if (typeof a === "string" || typeof b === "string") return lerpColor(s(a), s(b), clamp01(t));
      if (isVec2(a) || isVec2(b)) {
        const va = v2(a);
        const vb = v2(b);
        return { x: va.x + (vb.x - va.x) * t, y: va.y + (vb.y - va.y) * t };
      }
      const na = n(a);
      return na + (n(b) - na) * t;
    },
  },
  {
    name: "map",
    category: "interpolate",
    params: [
      P("value", "float", "The number to remap."),
      P("fromMin", "float", "The low end of the range it is in now."),
      P("fromMax", "float", "The high end of the range it is in now."),
      P("toMin", "float", "What the low end should become."),
      P("toMax", "float", "What the high end should become."),
    ],
    returns: "float",
    describe:
      "Rescales a number from one range to another. It keeps going past the ends — wrap it in clamp() if you want it to stop there.",
    example: "map(#layer.time, 0, 2, 0, 100)",
    call: (args) => {
      const v = n(args[0]);
      const f0 = n(args[1]);
      const f1 = n(args[2]);
      const t0 = n(args[3]);
      const t1 = n(args[4]);
      const t = f1 === f0 ? 0 : (v - f0) / (f1 - f0);
      return t0 + (t1 - t0) * t;
    },
  },
  {
    name: "smoothstep",
    category: "interpolate",
    params: [P("edge0", "float", "Where the ramp starts."), P("edge1", "float", "Where it finishes."), P("value", "float", "The number to ease.")],
    returns: "float",
    describe: "An eased 0→1 ramp between two edges: flat, then smooth, then flat again. The gentle alternative to a hard cut.",
    example: "smoothstep(0, 1, #layer.time)",
    call: (args) => {
      const e0 = n(args[0]);
      const e1 = n(args[1]);
      const t = e1 === e0 ? 0 : clamp01((n(args[2]) - e0) / (e1 - e0));
      return t * t * (3 - 2 * t);
    },
  },
  {
    name: "pingpong",
    category: "interpolate",
    params: [P("value", "float", "The number that keeps growing — usually time."), P("length", "float", "How far out it travels before turning back.")],
    returns: "float",
    describe: "Bounces back and forth between 0 and the length instead of jumping back to the start the way mod() does.",
    example: "pingpong(#time, 1)",
    call: (args) => {
      const len = n(args[1]);
      if (len <= 0) return 0;
      const t = ((n(args[0]) % (len * 2)) + len * 2) % (len * 2);
      return t <= len ? t : len * 2 - t;
    },
  },

  // ── Random ─────────────────────────────────────────────────────────────────
  {
    name: "random",
    category: "random",
    params: [P("min", "float", "Lowest value.", true), P("max", "float", "Highest value.", true)],
    returns: "float",
    describe:
      "A fixed random number for this field — the same every frame and every replay, so nothing flickers. Call it with no arguments for 0 to 1.",
    example: "random(-10, 10)",
    call: (args, ctx, site) => {
      const r = hash(ctx.seed * 7.31 + site * 1.618 + 0.5);
      if (args.length >= 2) {
        const lo = n(args[0]);
        const hi = n(args[1]);
        return lo + (hi - lo) * r;
      }
      return r;
    },
  },
  {
    name: "noise",
    category: "random",
    params: [P("value", "float", "Where to sample the noise — usually time.")],
    returns: "float",
    describe: "Smooth randomness from 0 to 1: wanders rather than jumps, and repeats exactly on every replay.",
    example: "noise(#time * 2)",
    call: (args, ctx, site) => fbm(n(args[0]), ctx.seed + site),
  },
  {
    name: "wiggle",
    category: "random",
    params: [P("frequency", "float", "Wobbles per second."), P("amount", "float", "How far it strays either side of zero.")],
    returns: "float",
    describe:
      "Organic drift around zero — add it to a value to make it breathe. Repeats exactly on every replay, and two wiggles in one expression never move together.",
    example: "100 + wiggle(2, 8)",
    call: (args, ctx, site) => {
      const freq = n(args[0]);
      const amp = n(args[1]);
      return (fbm((ctx.timeMs / 1000) * freq, ctx.seed + site) * 2 - 1) * amp;
    },
  },

  {
    name: "blink",
    category: "random",
    params: [
      P("every", "float", "Seconds between blinks, on average (default 4).", true),
      P("length", "float", "How long the eye stays shut, in seconds (default 0.12).", true),
    ],
    returns: "float",
    describe:
      "1 while an eye is shut, 0 while it is open — at a living, uneven rhythm with the odd double blink, the same on every replay. Drive an eye switch with it (1 shows its second member) or a lid bone: 1 - blink().",
    example: 'if(blink(4) > 0, "Closed", "Open")',
    call: (args, ctx, site) => blinkAt(ctx.timeMs / 1000, args.length > 0 ? n(args[0]) : 4, args.length > 1 ? n(args[1]) : 0.12, ctx.seed + site),
  },

  // ── Color ──────────────────────────────────────────────────────────────────
  {
    name: "rgb",
    category: "color",
    params: [P("r", "float", "Red, 0 to 1."), P("g", "float", "Green, 0 to 1."), P("b", "float", "Blue, 0 to 1.")],
    returns: "color",
    describe: "Builds a colour from red, green and blue, each 0 to 1.",
    example: "rgb(1, 0.5, 0)",
    call: (args) => formatHexColor({ r: clamp01(n(args[0])) * 255, g: clamp01(n(args[1])) * 255, b: clamp01(n(args[2])) * 255, a: 1 }),
  },
  {
    name: "rgba",
    category: "color",
    params: [
      P("r", "float", "Red, 0 to 1."),
      P("g", "float", "Green, 0 to 1."),
      P("b", "float", "Blue, 0 to 1."),
      P("a", "float", "Opacity, 0 to 1."),
    ],
    returns: "color",
    describe: "Builds a colour from red, green, blue and opacity.",
    call: (args) =>
      formatHexColor({
        r: clamp01(n(args[0])) * 255,
        g: clamp01(n(args[1])) * 255,
        b: clamp01(n(args[2])) * 255,
        a: clamp01(n(args[3])),
      }),
  },
  {
    name: "hsl",
    category: "color",
    params: [P("h", "float", "Hue in degrees, 0 to 360."), P("s", "float", "Saturation, 0 to 1."), P("l", "float", "Lightness, 0 to 1.")],
    returns: "color",
    describe: "Builds a colour from hue, saturation and lightness — the easy way to cycle through a rainbow.",
    example: "hsl(#time * 60, 0.8, 0.5)",
    call: (args) => hslToHex(n(args[0]), n(args[1]), n(args[2]), 1),
  },
  {
    name: "hsla",
    category: "color",
    params: [
      P("h", "float", "Hue in degrees, 0 to 360."),
      P("s", "float", "Saturation, 0 to 1."),
      P("l", "float", "Lightness, 0 to 1."),
      P("a", "float", "Opacity, 0 to 1."),
    ],
    returns: "color",
    describe: "Builds a colour from hue, saturation, lightness and opacity.",
    call: (args) => hslToHex(n(args[0]), n(args[1]), n(args[2]), n(args[3])),
  },

  // ── Vector ─────────────────────────────────────────────────────────────────
  {
    name: "vec",
    category: "vector",
    params: [P("x", "float", "Horizontal component."), P("y", "float", "Vertical component.")],
    returns: "vec2",
    describe: "Builds a two-part value from an X and a Y.",
    example: "vec(#comp.width / 2, 0)",
    call: (args) => ({ x: n(args[0]), y: n(args[1]) }),
  },
  {
    name: "length",
    category: "vector",
    params: [P("value", null, "A vector to measure, or text to count.")],
    returns: "float",
    describe: "How long something is: the magnitude of a vector, or the number of characters in a piece of text.",
    call: (args) => {
      const a = args[0];
      if (typeof a === "string") return a.length;
      const v = v2(a);
      return Math.hypot(v.x, v.y);
    },
  },
  {
    name: "distance",
    category: "vector",
    params: [P("a", "vec2", "One point."), P("b", "vec2", "The other point.")],
    returns: "float",
    describe: "The straight-line distance between two points.",
    call: (args) => {
      const a = v2(args[0]);
      const b = v2(args[1]);
      return Math.hypot(a.x - b.x, a.y - b.y);
    },
  },
  {
    name: "dot",
    category: "vector",
    params: [P("a", "vec2", "One vector."), P("b", "vec2", "The other vector.")],
    returns: "float",
    describe: "The dot product of two vectors.",
    call: (args) => {
      const a = v2(args[0]);
      const b = v2(args[1]);
      return a.x * b.x + a.y * b.y;
    },
  },
  {
    name: "normalize",
    category: "vector",
    params: [P("value", "vec2", "The vector to shorten to length 1.")],
    returns: "vec2",
    describe: "Keeps a vector’s direction but makes its length exactly 1.",
    call: (args) => {
      const v = v2(args[0]);
      const len = Math.hypot(v.x, v.y);
      return len === 0 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
    },
  },

  // ── Text ───────────────────────────────────────────────────────────────────
  {
    name: "str",
    category: "text",
    params: [P("value", null, "Anything.")],
    returns: "string",
    describe: "Turns any value into text.",
    call: (args) => {
      const a = args[0];
      if (typeof a === "string") return a;
      if (typeof a === "boolean") return a ? "true" : "false";
      if (isVec2(a)) return `${a.x}, ${a.y}`;
      return String(a ?? "");
    },
  },
  {
    name: "pad",
    category: "text",
    params: [P("value", "float", "The number to write."), P("digits", "float", "How many digits it should fill.")],
    returns: "string",
    describe: "Writes a whole number with leading zeros — what a counter or a timecode needs.",
    example: "pad(#frame, 4) → “0042”",
    call: (args) => {
      const v = Math.round(n(args[0]));
      const digits = Math.max(0, Math.round(n(args[1])));
      const sign = v < 0 ? "-" : "";
      return sign + String(Math.abs(v)).padStart(digits, "0");
    },
  },
  {
    name: "fixed",
    category: "text",
    params: [P("value", "float", "The number to write."), P("decimals", "float", "How many decimal places to keep.")],
    returns: "string",
    describe: "Writes a number with a fixed number of decimal places.",
    example: "fixed(#progress * 100, 1) + “%”",
    call: (args) => n(args[0]).toFixed(clamp(Math.round(n(args[1])), 0, 20)),
  },
  {
    name: "upper",
    category: "text",
    params: [P("value", "string", "The text to raise.")],
    returns: "string",
    describe: "Turns text into capitals.",
    call: (args) => s(args[0]).toUpperCase(),
  },
  {
    name: "lower",
    category: "text",
    params: [P("value", "string", "The text to lower.")],
    returns: "string",
    describe: "Turns text into lowercase.",
    call: (args) => s(args[0]).toLowerCase(),
  },

  // ── Logic ──────────────────────────────────────────────────────────────────
  {
    name: "if",
    category: "logic",
    params: [
      P("condition", "bool", "What to test."),
      P("then", null, "The value when the test passes."),
      P("otherwise", null, "The value when it doesn’t."),
    ],
    returns: (args) => unifyTypes(args[1] ?? null, args[2] ?? null),
    describe: "Picks one of two values. The same as writing condition ? then : otherwise.",
    example: "if(#playing, 1, 0.4)",
    call: (args) => (args[0] ? (args[1] ?? 0) : (args[2] ?? 0)),
  },

  // ── Layers ─────────────────────────────────────────────────────────────────
  {
    name: "bone",
    category: "layer",
    params: [
      P("rig", "string", "The rig's layer name, as the timeline shows it."),
      P("bone", "string", "The bone's name."),
      P("channel", "string", "rotation (default), x, y, scale, scaleY — how far it has turned, moved or stretched from rest.", true),
    ],
    returns: "float",
    describe:
      "A bone's pose — its turn, move or stretch from where it was drawn. Wire a CONTROL bone to anything: a mouth switch, an eyelid, a colour, another rig.",
    example: 'map(bone("Face", "Jaw"), 0, 30, 0, 1)',
    call: (args, ctx) => {
      const rig = typeof args[0] === "string" ? args[0] : "";
      const name = typeof args[1] === "string" ? args[1].trim().toLowerCase() : "";
      const channel = typeof args[2] === "string" && args[2] ? args[2] : "rotation";
      const id = rig ? ctx.layers?.idFor(rig) : undefined;
      if (!id || !name || !ctx.layers) return 0;
      // A bone's paths are grouped under its name — the same grouping the board's sockets use.
      const hit = ctx.layers.propertiesOf(id).find((p) => p.path.startsWith("bone.") && p.path.endsWith(`.${channel}`) && p.group.trim().toLowerCase() === name);
      const v = hit ? ctx.layers.read(id, hit.path) : undefined;
      return typeof v === "number" ? v : 0;
    },
  },
  {
    name: "layer",
    category: "layer",
    params: [
      P("name", "string", "The layer’s name, as the timeline shows it — or its key, clip:<id>, which survives renames."),
      P("property", "string", "Optional — read one value directly instead of with a dot.", true),
    ],
    // A layer, unless a property was named — then whatever that property is,
    // which only the registry knows.
    returns: (args) => (args.length > 1 ? null : "layer"),
    describe:
      "Another layer, by the name the timeline shows. Read any of its values off it with a dot — the same list its node card offers — so one layer can follow another, or a whole row can offset from a single leader.",
    example: 'layer("Title").x + 40',
    call: (args, ctx) => {
      const name = typeof args[0] === "string" ? args[0] : "";
      if (!name) return "";
      const id = ctx.layers?.idFor(name) ?? "";
      if (args.length < 2) return id;
      const property = typeof args[1] === "string" ? args[1] : "";
      return (id && property ? ctx.layers?.read(id, property) : undefined) ?? 0;
    },
  },
];

export const FUNCTIONS_BY_NAME: Map<string, FunctionDef> = new Map(FUNCTIONS.map((f) => [f.name, f]));

/**
 * THE EXTENSION SEAM — a feature that owns a function (`lipsync`, `state`,
 * `input`…) registers it from its own module instead of growing the table
 * above. Autocomplete, the checker, the docs and the evaluator all read
 * `FUNCTIONS` / `FUNCTIONS_BY_NAME`, so a registered function is everywhere a
 * built-in is. Registering a name twice replaces it (hot reload, tests);
 * a name that collides with a built-in is a programming error.
 */
export function registerExprFunction(def: FunctionDef): void {
  const existing = FUNCTIONS_BY_NAME.get(def.name);
  if (existing && !registered.has(def.name)) throw new Error(`Expression function "${def.name}" is built in.`);
  if (existing) FUNCTIONS.splice(FUNCTIONS.indexOf(existing), 1);
  FUNCTIONS.push(def);
  FUNCTIONS_BY_NAME.set(def.name, def);
  registered.add(def.name);
}
const registered = new Set<string>();

/** How many arguments a function must and may take. */
export function arity(def: FunctionDef): { min: number; max: number } {
  return {
    min: def.params.filter((p) => !p.optional).length,
    max: def.params.length,
  };
}

/** The display signature — `mix(a, b, t)`, optional arguments in brackets. */
export function signatureOf(def: FunctionDef): string {
  const parts = def.params.map((p) => (p.optional ? `[${p.name}]` : p.name));
  return `${def.name}(${parts.join(", ")})`;
}

/** The declared return type, resolved against the argument types it was given.
 *  Null = unknown until the value exists. */
export function returnTypeOf(def: FunctionDef, args: Array<ExprType | null>): ExprType | null {
  return typeof def.returns === "function" ? def.returns(args) : def.returns;
}

export const FUNCTION_CATEGORY_ORDER: FunctionCategory[] = [
  "math",
  "trig",
  "interpolate",
  "random",
  "color",
  "vector",
  "text",
  "logic",
  "layer",
  "character",
];

export function functionsByCategory(): Array<{ category: FunctionCategory; functions: FunctionDef[] }> {
  return FUNCTION_CATEGORY_ORDER.map((category) => ({
    category,
    functions: FUNCTIONS.filter((f) => f.category === category),
  }));
}
