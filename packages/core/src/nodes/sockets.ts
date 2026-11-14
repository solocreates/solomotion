import type { NodeValue, SocketType } from "../schema";
import { formatHexColor, parseHexColor } from "../animation/properties";

/**
 * THE SOCKET TYPE SYSTEM — the single source of truth for "can this wire
 * connect?" and "how does a value cross a type boundary?". Every connection the
 * board offers and every value the evaluator moves goes through `canConnect`
 * and `coerce`, so there is exactly ONE definition of the type rules and they
 * can never drift between the UI (what it lets you drag) and the engine (what it
 * actually computes). Blender-style: numbers, vectors, colors and booleans all
 * inter-convert sensibly; strings stay strict; `any` accepts everything and
 * coerces at the point of use.
 */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function isVec2(v: NodeValue | undefined): v is { x: number; y: number } {
  return typeof v === "object" && v !== null && typeof (v as { x?: unknown }).x === "number";
}

/** The socket type a raw runtime value looks like (colors read as `string`). */
export function runtimeType(v: NodeValue): SocketType {
  if (typeof v === "number") return "float";
  if (typeof v === "boolean") return "bool";
  if (isVec2(v)) return "vec2";
  return "string";
}

/** The neutral value for a type — what an unfed input or a broken node yields. */
export function identityValue(t: SocketType): NodeValue {
  switch (t) {
    case "float":
      return 0;
    case "vec2":
      return { x: 0, y: 0 };
    case "color":
      return "#000000";
    case "bool":
      return false;
    case "string":
      return "";
    // No layer (or tracker) at all — every read through it reports itself
    // unavailable rather than quietly answering for some other one.
    case "layer":
    case "track":
      return "";
    case "any":
      return 0;
  }
}

// ── Conversions ──────────────────────────────────────────────────────────────

export function toFloat(v: NodeValue, from: SocketType): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isVec2(v)) return (v.x + v.y) / 2; // Blender: vector→value averages components
  if (typeof v === "string") {
    if (from === "color") {
      const c = parseHexColor(v);
      return c ? (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255 : 0; // luma 0..1
    }
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function toVec2(v: NodeValue, from: SocketType): { x: number; y: number } {
  if (isVec2(v)) return v;
  if (typeof v === "number") return { x: v, y: v };
  if (typeof v === "boolean") return { x: v ? 1 : 0, y: v ? 1 : 0 };
  if (typeof v === "string" && from === "color") {
    const c = parseHexColor(v);
    return c ? { x: c.r / 255, y: c.g / 255 } : { x: 0, y: 0 };
  }
  return { x: 0, y: 0 };
}

export function toColor(v: NodeValue, from: SocketType): string {
  if (typeof v === "string") {
    const c = parseHexColor(v);
    return c ? formatHexColor(c) : "#000000";
  }
  if (typeof v === "number") {
    const g = clamp01(v) * 255;
    return formatHexColor({ r: g, g, b: g, a: 1 });
  }
  if (typeof v === "boolean") return v ? "#ffffff" : "#000000";
  if (isVec2(v)) return formatHexColor({ r: clamp01(v.x) * 255, g: clamp01(v.y) * 255, b: 0, a: 1 });
  return "#000000";
}

export function toBool(v: NodeValue, from: SocketType): boolean {
  return toFloat(v, from) !== 0;
}

export function toStr(v: NodeValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (isVec2(v)) return `${v.x}, ${v.y}`;
  return String(v);
}

/** Move a value from its declared `from` type to a socket's `to` type. */
export function coerce(v: NodeValue, from: SocketType, to: SocketType): NodeValue {
  if (to === "any" || from === to) return v;
  switch (to) {
    case "float":
      return toFloat(v, from);
    case "vec2":
      return toVec2(v, from);
    case "color":
      return toColor(v, from);
    case "bool":
      return toBool(v, from);
    case "string":
      return toStr(v);
    // A layer or a tracker only ever crosses into a slot of its own kind
    // (`canConnect` forbids the rest), so there is nothing to convert.
    case "layer":
    case "track":
      return v;
  }
}

/**
 * May a wire from an output of type `from` feed an input of type `to`? `any` on
 * either side always connects. The numeric family (float / vec2 / bool / color)
 * all inter-connect — you can drive a color from a value, a value from a vector,
 * etc. `string` is strict: it only meets `string` (or `any`), so text never
 * silently becomes a number on the wire.
 */
export function canConnect(from: SocketType, to: SocketType): boolean {
  if (from === "any" || to === "any") return true;
  if (from === to) return true;
  // A layer is not a value and no value is a layer: there is no sensible reading
  // of "this number, as a layer". It connects only to itself.
  if (from === "layer" || to === "layer" || from === "track" || to === "track") return false;
  if (from === "string" || to === "string") return false;
  return true; // remaining pairs are all within the numeric family
}
