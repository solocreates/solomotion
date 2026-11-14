import { clipAnimatableProperties, type ClipProperty } from "../animation/clip-properties";
import { PROPERTY_DEFS, type PropertyKind } from "../animation/properties";
import { gradientPaint, solidPaint, strokeStyle } from "../schema/vector";
import type { Clip, NodeValue, SocketType } from "../schema";
import type { NodeTypeDef, SocketResolveCtx, SocketSpec } from "./registry";

/**
 * PROPERTY PROJECTION — turns a clip's live animatable properties (from
 * `clipAnimatableProperties`) into node sockets, so ONE Object node mirrors
 * whatever layer it targets with BOTH an output (read the current value) and an
 * input (wire in → drive it) per property. Nothing is hand-listed: the sockets
 * are the data structure, projected. Add a property to the registry, add a fill
 * to a layer — the node grows the matching sockets for free. The category
 * convenience nodes (Transform, Typography, …) are the exact same projection
 * with a group filter, so there is one code path, never a parallel table.
 */

/** Map an animatable-property def onto the socket type that carries its value. */
export function socketTypeForProperty(kind: PropertyKind, identity: NodeValue): SocketType {
  switch (kind) {
    case "color":
      return "color";
    case "number":
      return "float";
    case "geometry":
      return "any";
    case "discrete":
      if (typeof identity === "boolean") return "bool";
      if (typeof identity === "number") return "float";
      if (typeof identity === "string") return "string";
      return "any";
  }
}

/** A property → socket spec (key IS the property path; sink for driver writes). */
function propertySocket(p: ClipProperty): SocketSpec {
  return {
    key: p.path,
    label: p.def.label,
    type: socketTypeForProperty(p.def.kind, p.def.identity as NodeValue),
    default: p.def.identity as NodeValue,
    group: p.group,
    path: p.path,
  };
}

/** The MAIN socket — the whole object as one connection point (Blender's
 *  geometry-thread idea). Carries the target clip id; type `any` so it can flow
 *  between object-aware nodes. Always present so a projection node has a handle
 *  even before you expand into individual properties. */
export const MAIN_SOCKET_KEY = "self";
function mainSocket(): SocketSpec {
  return { key: MAIN_SOCKET_KEY, label: "Layer", type: "any" };
}

/**
 * The CANONICAL field catalogue — every category's fields as value-holder
 * sockets, with NO clip. This is what lets EVERY projection node still MEAN
 * something before it belongs to a layer: each socket is a real value-holder
 * (type + label + an editable/wire-able literal), sourced headlessly from the
 * same registries the live projection reads. Instance-based categories (paint,
 * effects — a fill/effect only *exists* on a real layer) are represented by a
 * canonical set too, so no node is ever a dead, empty card. `groupId` mirrors
 * the live projection's ids so a node's category `match` selects the same rows.
 */
type CanonicalSocket = SocketSpec & { groupId: string };

const socketFromDef = (d: ClipProperty["def"]): SocketSpec => ({
  key: d.key,
  label: d.label,
  type: socketTypeForProperty(d.kind, d.identity as NodeValue),
  default: d.identity as NodeValue,
  path: d.key,
});
const socketFromProp = (p: ClipProperty): CanonicalSocket => ({
  key: p.path,
  label: p.def.label,
  type: socketTypeForProperty(p.def.kind, p.def.identity as NodeValue),
  default: p.def.identity as NodeValue,
  group: p.group,
  path: p.path,
  groupId: p.groupId,
});

/**
 * A PROTOTYPE clip carrying one of every instance-based PAINT structure — a
 * solid fill, a gradient fill (with stops) and a stroke. Enumerating it through
 * the SAME `clipAnimatableProperties` the live projection uses yields the
 * complete paint field surface (gradient stops, stroke width) with ZERO
 * hand-listing — add a paint variant to the schema and these grow for free.
 * Fixed ids keep the socket keys stable across sessions. (Static per-kind props
 * like transform/typography/audio come from `PROPERTY_DEFS`, the registry
 * itself; effects are NOT here — a layer's effects are an ordered list of
 * instances, projected as one card each by `./effect-nodes`.)
 */
const PROTOTYPE = {
  kind: "shape",
  fills: [
    { ...solidPaint("#ffffff"), id: "solid" },
    {
      ...gradientPaint("linear", [
        { id: "a", color: "#ffffff", offset: 0 },
        { id: "b", color: "#000000", offset: 1 },
      ]),
      id: "gradient",
    },
  ],
  strokes: [{ ...strokeStyle(solidPaint("#000000")), id: "stroke" }],
} as unknown as Clip;

const CANONICAL: CanonicalSocket[] = [
  // Static per-kind properties, straight from the animatable-property registry.
  ...PROPERTY_DEFS.map((d) => ({ ...socketFromDef(d), group: d.group, groupId: d.group })),
  // Instance-based paint properties, enumerated from the prototype —
  // the same headless path the live projection walks, so nothing is hand-listed.
  ...clipAnimatableProperties(PROTOTYPE)
    .filter((p) => p.groupId.startsWith("paint:"))
    .map(socketFromProp),
];

/**
 * The canonical value-holder sockets for a CATEGORY. The universal Layer node
 * (no category filter) returns none — it would otherwise dump every field of
 * every type, which is noise and means nothing without a layer; it stays at its
 * Layer handle until bound. Deduped by key (a few registry defs share one).
 */
function staticSockets(match?: (groupId: string) => boolean): SocketSpec[] {
  if (!match) return [];
  const seen = new Set<string>();
  const out: SocketSpec[] = [];
  for (const s of CANONICAL) {
    if (!match(s.groupId) || seen.has(s.key)) continue;
    seen.add(s.key);
    const { groupId: _groupId, ...spec } = s;
    out.push(spec);
  }
  return out;
}

/**
 * The projected sockets of the clip a node targets, filtered to a category by a
 * group-id predicate (transform, typography, effect:*, paint:*). With no target
 * — or a target that has none of this category's fields (an Effects node on a
 * layer with no effects) — it falls back to the canonical value-holders, so a
 * node's fields never collapse to nothing. Where the layer DOES expose the
 * category, its own projection is the whole truth: what the card offers is
 * exactly what turning it would change.
 */
export function projectedSockets(ctx: SocketResolveCtx, match?: (groupId: string) => boolean): SocketSpec[] {
  const canon = staticSockets(match);
  const target = ctx.node.params.target;
  if (typeof target !== "string" || !target || !ctx.describeClip) return canon;
  let props = ctx.describeClip(target);
  if (match) props = props.filter((p) => match(p.groupId));
  // A BOUND node shows the layer's own fields, and only those. The canonical
  // holders are a prototype — every field of every variant — so unioning them in
  // meant a rectangle's card offered a star's point count, an ellipse's arc and
  // three corner radii it does not read. Each of those accepted a wire, wrote a
  // driver and changed nothing, with no way to tell which of the four was real.
  //
  // The fallback stays for the case it was actually for: a node whose target has
  // NONE of this category's fields (an Effects node on a layer with no effects)
  // keeps its holders rather than collapsing to an empty card.
  if (props.length === 0) return canon;
  return props.map(propertySocket);
}

/**
 * Build an Object/projection node. `match` narrows it to a category by property
 * group-id (omit = the universal Layer node). Every PROPERTY is one combined row
 * (output reads the value at the playhead, input is the driver sink), derived
 * from `clipAnimatableProperties` so a node covers whatever the targeted layer
 * TYPE exposes with nothing hand-listed.
 *
 * The MAIN "Layer" socket is ONE-SIDED by role, so it's never ambiguous which
 * way it flows: a `source` hub BROADCASTS its layer (Layer OUTPUT, right), and
 * an `operator` RECEIVES one (Layer INPUT, left). You wire hub-out → operator-in
 * and fan a hub out to as many operators as you like — a single dot, a single
 * direction, instead of the same handle on both sides.
 */
function makeProjectionNode(opts: {
  type: string;
  title: string;
  description: string;
  match?: (groupId: string) => boolean;
  role: "source" | "operator";
}): NodeTypeDef {
  const { match, role } = opts;
  return {
    type: opts.type,
    category: "object",
    title: opts.title,
    description: opts.description,
    inputs: (ctx) => [...(role === "operator" ? [mainSocket()] : []), ...projectedSockets(ctx, match)],
    outputs: (ctx) => [...(role === "source" ? [mainSocket()] : []), ...projectedSockets(ctx, match)],
    options: [{ key: "target", label: "Layer", kind: "string", default: "", pick: { kinds: ["layer"] } }],
    evaluate: ({ params, inputs, connected, ctx }) => {
      const target = typeof params.target === "string" ? params.target : "";
      const out: Record<string, NodeValue> = { [MAIN_SOCKET_KEY]: target };
      // Canonical holders ALWAYS emit their held value (a wired input, else the
      // edited literal) — so every field means something with or without a layer.
      for (const s of staticSockets(match)) {
        const v = inputs[s.key] ?? params[s.key];
        if (v !== undefined) out[s.key] = v as NodeValue;
      }
      // A bound layer's live values fill the outputs — EXCEPT where a socket is
      // WIRED. A wire is a specific write into that exact field, and it must win
      // over the parent layer's value (CSS-selector specificity): otherwise the
      // output — the readout, and what downstream nodes read — would show the
      // layer's own value instead of what's being injected, disagreeing with the
      // stage (which honours the driver). So live reads never clobber a wire.
      if (target && ctx.readProperty && ctx.describeClip) {
        let props = ctx.describeClip(target);
        if (match) props = props.filter((p) => match(p.groupId));
        for (const p of props) {
          if (connected.has(p.path)) continue;
          const v = ctx.readProperty(target, p.path, ctx.timeMs);
          if (v !== undefined) out[p.path] = v;
        }
      }
      return out;
    },
  };
}

const gid = (id: string) => (g: string) => g === id;
const gidPrefix = (p: string) => (g: string) => g.startsWith(p);

/**
 * The projection catalogue — the universal Layer node plus one node per natural
 * category. All share ONE factory; each just carries a group-id predicate, so
 * they stay in lock-step with the data structure (add a property or an effect
 * field and the matching node grows it for free). A node whose category is
 * absent on the targeted layer simply shows nothing but its Layer handle.
 */
export const PROJECTION_NODES: NodeTypeDef[] = [
  makeProjectionNode({ type: "object.layer", title: "Layer", description: "Read and drive EVERY property of a layer.", role: "source" }),
  makeProjectionNode({ type: "object.transform", title: "Transform", description: "Position, scale, rotation, opacity, skew, crop, corners.", match: gid("transform"), role: "operator" }),
  makeProjectionNode({ type: "object.typography", title: "Typography", description: "Font size, spacing, line height, color, weight, content.", match: gid("typography"), role: "operator" }),
  makeProjectionNode({ type: "object.fill", title: "Paint", description: "Every fill & stroke — colors, opacity, width, gradient stops.", match: gidPrefix("paint:"), role: "operator" }),
  makeProjectionNode({ type: "object.shape", title: "Shape", description: "Vector geometry — size, corner radius, points.", match: gid("vector"), role: "operator" }),
  makeProjectionNode({ type: "object.audio", title: "Audio", description: "Volume, pitch, EQ bands.", match: gid("audio"), role: "operator" }),
];
