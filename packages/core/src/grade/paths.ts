import type { GradeGraph, GradeNode } from "../schema/grade";
import type { LayerEffect } from "../schema/layer-effects";

/**
 * GRADE PROPERTY PATHS — how everything inside a node graph becomes keyframable
 * without inventing an address space.
 *
 * A grade lives on its card, so every value in it is already under that card's
 * existing namespace and the whole grammar is a SUFFIX:
 *
 *   lfx.<card>.mix                          the card's own master wet/dry
 *   lfx.<card>.n.<node>.opacity             a corrector's composite level
 *   lfx.<card>.n.<node>.enabled             its bypass (a discrete property)
 *   lfx.<card>.n.<node>.q.<band>.<f>        a qualifier band (hue|sat|lum)
 *   lfx.<card>.n.<node>.d.<f>               the depth band
 *   lfx.<card>.n.<node>.m.<f>               matte blur / shrink
 *   lfx.<card>.n.<node>.w.<win>.<f>         a power window's pose and edge
 *   lfx.<card>.n.<node>.fx.<fx>.<field>     a field of an effect inside the node
 *
 * The last line is the one that matters most and cost nothing: a corrector's
 * payload is an ordinary effect stack, so every grading control that already
 * exists — every wheel, every curve, every future card — keyframes here the day
 * it ships, with no per-field registration.
 *
 * Everything is `n.`-prefixed so the parser can tell a grade path from a plain
 * effect field in one comparison, and so a future card with its own sub-tree can
 * take a different letter without ambiguity.
 */

export const GRADE_NODE_SEGMENT = "n";

export type GradeTarget =
  | { kind: "node"; nodeId: string; field: "opacity" | "enabled" | "blend" }
  | { kind: "keyFlag"; nodeId: string; field: "invert" | "input" }
  | { kind: "qualifierOn"; nodeId: string }
  | { kind: "qualifier"; nodeId: string; band: "hue" | "sat" | "lum"; field: string }
  | { kind: "depth"; nodeId: string; field: string }
  | { kind: "matte"; nodeId: string; field: "blurPx" | "shrinkPx" }
  | { kind: "window"; nodeId: string; windowId: string; field: string }
  | { kind: "effect"; nodeId: string; effectId: string; field: string };

/** Build the suffix that follows `lfx.<cardId>.`. */
export const gradePath = {
  node: (nodeId: string, field: "opacity" | "enabled" | "blend") => `n.${nodeId}.${field}`,
  qualifierOn: (nodeId: string) => `n.${nodeId}.q.on`,
  keyFlag: (nodeId: string, field: "invert" | "input") => `n.${nodeId}.k.${field}`,
  qualifier: (nodeId: string, band: string, field: string) => `n.${nodeId}.q.${band}.${field}`,
  depth: (nodeId: string, field: string) => `n.${nodeId}.d.${field}`,
  matte: (nodeId: string, field: string) => `n.${nodeId}.m.${field}`,
  window: (nodeId: string, windowId: string, field: string) => `n.${nodeId}.w.${windowId}.${field}`,
  effect: (nodeId: string, effectId: string, field: string) => `n.${nodeId}.fx.${effectId}.${field}`,
};

/** Decompose a grade suffix, or null when it is not one. */
export function parseGradePath(suffix: string): GradeTarget | null {
  const parts = suffix.split(".");
  if (parts[0] !== GRADE_NODE_SEGMENT || parts.length < 3) return null;
  const nodeId = parts[1]!;
  const head = parts[2]!;
  const rest = parts.slice(3);

  if (head === "opacity" || head === "enabled" || head === "blend") return { kind: "node", nodeId, field: head };
  if (head === "q" && rest.length === 1 && rest[0] === "on") return { kind: "qualifierOn", nodeId };
  if (head === "k" && rest.length === 1) {
    const f = rest[0]!;
    if (f !== "invert" && f !== "input") return null;
    return { kind: "keyFlag", nodeId, field: f };
  }
  if (head === "q" && rest.length === 2) {
    const band = rest[0]!;
    if (band !== "hue" && band !== "sat" && band !== "lum") return null;
    return { kind: "qualifier", nodeId, band, field: rest[1]! };
  }
  if (head === "d" && rest.length === 1) return { kind: "depth", nodeId, field: rest[0]! };
  if (head === "m" && rest.length === 1) {
    const f = rest[0]!;
    if (f !== "blurPx" && f !== "shrinkPx") return null;
    return { kind: "matte", nodeId, field: f };
  }
  if (head === "w" && rest.length >= 2) {
    return { kind: "window", nodeId, windowId: rest[0]!, field: rest.slice(1).join(".") };
  }
  if (head === "fx" && rest.length >= 2) {
    return { kind: "effect", nodeId, effectId: rest[0]!, field: rest.slice(1).join(".") };
  }
  return null;
}

type Scalar = number | string | boolean;

function nodeOf(graph: GradeGraph, id: string): GradeNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

/** Read a value addressed by a grade suffix. `undefined` when it does not exist. */
export function readGradeValue(graph: GradeGraph, target: GradeTarget): Scalar | undefined {
  const node = nodeOf(graph, target.nodeId);
  if (!node) return undefined;
  if (target.kind === "node") {
    if (target.field === "enabled") return node.enabled;
    if (node.kind !== "corrector") return undefined;
    return target.field === "blend" ? node.blend : node.opacity;
  }
  if (node.kind !== "corrector") return undefined;
  if (target.kind === "qualifierOn") return node.key.qualifier.enabled;
  if (target.kind === "keyFlag") return node.key[target.field];
  switch (target.kind) {
    case "qualifier": {
      const band = node.key.qualifier[target.band] as unknown as Record<string, Scalar>;
      return band[target.field];
    }
    case "depth":
      return (node.key.depth as unknown as Record<string, Scalar>)[target.field];
    case "matte":
      return node.key[target.field];
    case "window": {
      const win = node.key.windows.find((w) => w.id === target.windowId);
      if (!win) return undefined;
      if (target.field === "feather") return win.feather;
      if (target.field === "expand") return win.expand;
      if (target.field === "invert") return win.invert;
      if (target.field === "combine") return win.combine;
      if (win.source.type !== "shape") return undefined;
      return (win.source.transform as unknown as Record<string, Scalar | null>)[target.field] ?? undefined;
    }
    case "effect": {
      const fx = node.effects.find((e) => e.id === target.effectId) as
        | (LayerEffect & Record<string, Scalar>)
        | undefined;
      return fx?.[target.field];
    }
  }
}

/** Write a value addressed by a grade suffix. Returns false when nothing matched. */
export function writeGradeValue(graph: GradeGraph, target: GradeTarget, value: Scalar): boolean {
  const node = nodeOf(graph, target.nodeId);
  if (!node) return false;
  if (target.kind === "node") {
    if (target.field === "enabled") {
      node.enabled = !!value;
      return true;
    }
    if (node.kind !== "corrector") return false;
    if (target.field === "blend") {
      node.blend = value as typeof node.blend;
      return true;
    }
    node.opacity = Math.min(1, Math.max(0, Number(value)));
    return true;
  }
  if (node.kind !== "corrector") return false;
  if (target.kind === "qualifierOn") {
    node.key.qualifier.enabled = !!value;
    return true;
  }
  if (target.kind === "keyFlag") {
    if (target.field === "invert") node.key.invert = !!value;
    else node.key.input = value as typeof node.key.input;
    return true;
  }
  switch (target.kind) {
    case "qualifier": {
      const band = node.key.qualifier[target.band] as unknown as Record<string, Scalar>;
      if (!(target.field in band)) return false;
      band[target.field] = typeof band[target.field] === "boolean" ? !!value : Number(value);
      return true;
    }
    case "depth": {
      const depth = node.key.depth as unknown as Record<string, Scalar>;
      if (!(target.field in depth)) return false;
      depth[target.field] = typeof depth[target.field] === "boolean" ? !!value : Number(value);
      return true;
    }
    case "matte":
      node.key[target.field] = Number(value);
      return true;
    case "window": {
      const win = node.key.windows.find((w) => w.id === target.windowId);
      if (!win) return false;
      if (target.field === "feather") {
        win.feather = Math.max(0, Number(value));
        return true;
      }
      if (target.field === "expand") {
        win.expand = Number(value);
        return true;
      }
      if (target.field === "invert") {
        win.invert = !!value;
        return true;
      }
      if (target.field === "combine") {
        win.combine = value as typeof win.combine;
        return true;
      }
      if (win.source.type !== "shape") return false;
      const t = win.source.transform as unknown as Record<string, number | null>;
      if (!(target.field in t)) return false;
      t[target.field] = Number(value);
      return true;
    }
    case "effect": {
      const fx = node.effects.find((e) => e.id === target.effectId) as
        | (LayerEffect & Record<string, Scalar>)
        | undefined;
      if (!fx || !(target.field in fx)) return false;
      fx[target.field] = typeof fx[target.field] === "boolean" ? !!value : value;
      return true;
    }
  }
}

/**
 * One animatable slot inside a grade, for the property enumerator.
 *
 * `group` is the node's display name, so the curve editor and dope sheet sort a
 * grade's keys under the node they belong to — which is the only grouping that
 * means anything on a page whose whole structure is nodes.
 */
export interface GradeSlot {
  /** The suffix (prefix with `lfx.<cardId>.`). */
  suffix: string;
  label: string;
  group: string;
  nodeId: string;
  kind: "number" | "boolean" | "color" | "string";
  min?: number;
  max?: number;
  step?: number;
}

const BAND_LABEL = { hue: "Hue", sat: "Sat", lum: "Lum" } as const;

/**
 * Every animatable slot a graph exposes, excluding the effect fields — those are
 * enumerated by the caller from the effect registry, which already knows each
 * card's field metadata and would only be re-described worse here.
 */
export function gradeSlots(graph: GradeGraph): GradeSlot[] {
  const out: GradeSlot[] = [];
  graph.nodes.forEach((node, i) => {
    const group = node.name || `Node ${i}`;
    out.push({ suffix: gradePath.node(node.id, "enabled"), label: "Enabled", group, nodeId: node.id, kind: "boolean" });
    if (node.kind !== "corrector") return;
    out.push({
      suffix: gradePath.node(node.id, "opacity"),
      label: "Opacity",
      group,
      nodeId: node.id,
      kind: "number",
      min: 0,
      max: 1,
      step: 0.01,
    });
    for (const band of ["hue", "sat", "lum"] as const) {
      const scale = band === "hue" ? 360 : 1;
      for (const f of ["center", "width", "softLow", "softHigh"] as const) {
        out.push({
          suffix: gradePath.qualifier(node.id, band, f),
          label: `${BAND_LABEL[band]} ${f === "center" ? "centre" : f === "width" ? "width" : f === "softLow" ? "soft low" : "soft high"}`,
          group,
          nodeId: node.id,
          kind: "number",
          min: band === "hue" && f === "center" ? 0 : 0,
          max: scale,
          step: band === "hue" ? 1 : 0.01,
        });
      }
    }
    for (const f of ["near", "far", "softness"] as const) {
      out.push({
        suffix: gradePath.depth(node.id, f),
        label: `Depth ${f}`,
        group,
        nodeId: node.id,
        kind: "number",
        min: 0,
        max: 1,
        step: 0.01,
      });
    }
    out.push({ suffix: gradePath.qualifierOn(node.id), label: "Qualifier", group, nodeId: node.id, kind: "boolean" });
    out.push({ suffix: gradePath.keyFlag(node.id, "invert"), label: "Invert key", group, nodeId: node.id, kind: "boolean" });
    out.push({ suffix: gradePath.node(node.id, "blend"), label: "Blend", group, nodeId: node.id, kind: "string" });
    out.push({ suffix: gradePath.matte(node.id, "blurPx"), label: "Matte blur", group, nodeId: node.id, kind: "number", min: 0, max: 128, step: 1 });
    out.push({ suffix: gradePath.matte(node.id, "shrinkPx"), label: "Matte shrink", group, nodeId: node.id, kind: "number", min: -64, max: 64, step: 1 });

    for (const win of node.key.windows) {
      const wg = `${group} · ${win.name}`;
      out.push({ suffix: gradePath.window(node.id, win.id, "feather"), label: "Feather", group: wg, nodeId: node.id, kind: "number", min: 0, max: 400, step: 1 });
      out.push({ suffix: gradePath.window(node.id, win.id, "expand"), label: "Expand", group: wg, nodeId: node.id, kind: "number", min: -200, max: 200, step: 1 });
      out.push({ suffix: gradePath.window(node.id, win.id, "invert"), label: "Invert", group: wg, nodeId: node.id, kind: "boolean" });
      if (win.source.type !== "shape") continue;
      for (const f of ["x", "y", "scale", "rotation"] as const) {
        out.push({
          suffix: gradePath.window(node.id, win.id, f),
          label: f === "x" ? "X" : f === "y" ? "Y" : f === "scale" ? "Scale" : "Rotation",
          group: wg,
          nodeId: node.id,
          kind: "number",
          step: f === "scale" ? 0.01 : 1,
        });
      }
    }
  });
  return out;
}
