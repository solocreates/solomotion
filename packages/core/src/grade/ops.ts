import type { MotionDocument, LayerEffect, VisualClip } from "../schema";
import type {
  GradeEdge,
  GradeGraph,
  GradeNode,
  GradePortKind,
  PowerWindow,
  WindowSource,
} from "../schema/grade";
import type { TrackShape } from "../schema/tracking";
import { createId } from "../ids";
import { regionFromShape, toSubpaths } from "../tracking/contour";

/**
 * DOCUMENT OPS for grade graphs. Every mutation the Color page performs, in
 * core, so undo, export and a test share one truth.
 *
 * The only structural rule worth stating up front: a graph ALWAYS has exactly
 * one source and one output, they are created with it and cannot be deleted, and
 * a fresh graph arrives already wired Source → Corrector → Output. An empty
 * canvas with an add-menu is the most common way a node editor loses a person in
 * its first ten seconds; a working chain you can immediately push is not.
 */

const NODE_DX = 220;

/** The `grade` card on a clip's stack, if it has one. */
export function gradeCard(clip: VisualClip): Extract<LayerEffect, { type: "grade" }> | null {
  return clip.effects.find((e): e is Extract<LayerEffect, { type: "grade" }> => e.type === "grade") ?? null;
}

/** Every grade graph a clip carries, in stack order (a clip may have several). */
export function clipGrades(clip: VisualClip): Array<{ cardId: string; graph: GradeGraph }> {
  return clip.effects
    .filter((e): e is Extract<LayerEffect, { type: "grade" }> => e.type === "grade")
    .map((e) => ({ cardId: e.id, graph: e.graph }));
}

export function gradeNode(graph: GradeGraph, nodeId: string): GradeNode | null {
  return graph.nodes.find((n) => n.id === nodeId) ?? null;
}

/** The node every graph starts and ends with — never deletable. */
export function sourceNode(graph: GradeGraph): GradeNode | null {
  return graph.nodes.find((n) => n.kind === "source") ?? null;
}
export function outputNode(graph: GradeGraph): GradeNode | null {
  return graph.nodes.find((n) => n.kind === "output") ?? null;
}

function edge(from: string, to: string, port: GradePortKind = "rgb", index = 0): GradeEdge {
  return {
    id: createId("gedge"),
    from: { node: from, port, index: 0 },
    to: { node: to, port, index },
  };
}

/** A blank corrector — a node that grades everything and changes nothing yet. */
export function makeCorrector(x: number, y: number, name = ""): GradeNode {
  return {
    id: createId("gnode"),
    kind: "corrector",
    x,
    y,
    name,
    enabled: true,
    collapsed: false,
    effects: [],
    key: {
      qualifier: {
        enabled: false,
        hue: { enabled: true, center: 30, width: 40, softLow: 12, softHigh: 12 },
        sat: { enabled: true, center: 0.5, width: 0.5, softLow: 0.1, softHigh: 0.1 },
        lum: { enabled: true, center: 0.5, width: 0.5, softLow: 0.1, softHigh: 0.1 },
      },
      depth: { enabled: false, near: 0, far: 0.5, softness: 0.08, invert: false },
      windows: [],
      input: "intersect",
      invert: false,
      blurPx: 0,
      shrinkPx: 0,
    },
    blend: "normal",
    opacity: 1,
  };
}

/** Create a grade graph, pre-wired Source → Corrector → Output. */
export function createGrade(name = "Grade"): GradeGraph {
  const source: GradeNode = { id: createId("gnode"), kind: "source", x: 0, y: 0, name: "", enabled: true, collapsed: false };
  const first = makeCorrector(NODE_DX, 0, "");
  const out: GradeNode = { id: createId("gnode"), kind: "output", x: NODE_DX * 2, y: 0, name: "", enabled: true, collapsed: false };
  const graph: GradeGraph = {
    id: createId("grade"),
    name,
    nodes: [source, first, out],
    edges: [edge(source.id, first.id), edge(first.id, out.id)],
    view: null,
  };
  return graph;
}

/**
 * Find or create the grade a clip's stack points at, adding the `grade` card if
 * the clip has none. Appending it at the END of the stack is the default rather
 * than a rule: grading the finished layer is what people mean by "colour this",
 * and the card is draggable the moment it exists.
 */
export function ensureClipGrade(clip: VisualClip): GradeGraph {
  const card = gradeCard(clip);
  if (card) return card.graph;
  const graph = createGrade(`${clip.name} grade`);
  clip.effects.push({ id: createId("lfx"), type: "grade", enabled: true, graph, mix: 1 });
  return graph;
}

/**
 * Insert a corrector AFTER `afterNodeId`, re-wiring the chain through it — the
 * "add a node" gesture, which in a grading page nearly always means "another
 * one in series" rather than "a loose card on the canvas".
 */
export function insertCorrectorAfter(graph: GradeGraph, afterNodeId: string, name = ""): GradeNode | null {
  const anchor = gradeNode(graph, afterNodeId);
  if (!anchor) return null;
  const node = makeCorrector(anchor.x + NODE_DX, anchor.y, name);
  graph.nodes.push(node);

  const downstream = graph.edges.filter((e) => e.from.node === afterNodeId && e.from.port === "rgb");
  for (const e of downstream) e.from = { node: node.id, port: "rgb", index: 0 };
  graph.edges.push(edge(afterNodeId, node.id));

  // Everything after the insertion slides right, so a chain stays legible
  // instead of growing a pile at one x.
  for (const n of graph.nodes) {
    if (n.id !== node.id && n.x > anchor.x && n.kind !== "source") n.x += NODE_DX;
  }
  return node;
}

/**
 * Add a node in PARALLEL with `siblingId`: both read what the sibling reads,
 * and a mixer is created (or reused) to fold them back together. Resolve's
 * parallel node, as one action — building it by hand is four wires people get
 * wrong the first three times.
 */
export function addParallelTo(graph: GradeGraph, siblingId: string): GradeNode | null {
  const sibling = gradeNode(graph, siblingId);
  if (!sibling) return null;
  const feed = graph.edges.find((e) => e.to.node === siblingId && e.to.port === "rgb");
  if (!feed) return null;

  const node = makeCorrector(sibling.x, sibling.y + 150);
  graph.nodes.push(node);
  graph.edges.push(edge(feed.from.node, node.id));

  const consumers = graph.edges.filter((e) => e.from.node === siblingId && e.from.port === "rgb");
  const existingMixer = consumers
    .map((e) => gradeNode(graph, e.to.node))
    .find((n): n is Extract<GradeNode, { kind: "mixer" }> => n?.kind === "mixer");

  if (existingMixer) {
    const used = graph.edges.filter((e) => e.to.node === existingMixer.id && e.to.port === "rgb").length;
    graph.edges.push(edge(node.id, existingMixer.id, "rgb", used));
    return node;
  }

  const mixer: GradeNode = {
    id: createId("gnode"),
    kind: "mixer",
    x: sibling.x + NODE_DX,
    y: sibling.y + 75,
    name: "",
    enabled: true,
    collapsed: false,
    mix: "layer",
  };
  graph.nodes.push(mixer);
  for (const e of consumers) e.from = { node: mixer.id, port: "rgb", index: 0 };
  graph.edges.push(edge(siblingId, mixer.id, "rgb", 0));
  graph.edges.push(edge(node.id, mixer.id, "rgb", 1));
  for (const n of graph.nodes) {
    if (n.x > sibling.x && n.id !== mixer.id && n.id !== node.id) n.x += NODE_DX;
  }
  return node;
}

/**
 * Wire one node's KEY output into another's key input, set to grade everything
 * the first node did NOT take. Resolve calls this an "outside node" and it is
 * the single most used move on the page; here it is two ordinary fields, so the
 * inverse ("grade the same selection") is the same action with one toggle.
 */
export function addOutsideOf(graph: GradeGraph, nodeId: string): GradeNode | null {
  const node = insertCorrectorAfter(graph, nodeId, "Outside");
  if (!node || node.kind !== "corrector") return null;
  graph.edges.push(edge(nodeId, node.id, "key"));
  node.key.input = "replace";
  node.key.invert = true;
  return node;
}

/** Remove a node and every wire touching it. Source and output are never removed. */
export function removeGradeNode(graph: GradeGraph, nodeId: string): void {
  const node = gradeNode(graph, nodeId);
  if (!node || node.kind === "source" || node.kind === "output") return;

  // Heal the chain: whatever fed this node feeds whatever it fed, so deleting a
  // node from the middle of a grade leaves a working grade rather than a gap.
  const feed = graph.edges.find((e) => e.to.node === nodeId && e.to.port === "rgb");
  const consumers = graph.edges.filter((e) => e.from.node === nodeId && e.from.port === "rgb");
  if (feed) for (const c of consumers) c.from = { ...feed.from };

  graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);
  graph.edges = graph.edges.filter((e) => e.from.node !== nodeId && e.to.node !== nodeId);
}

/**
 * Connect two ports. An INPUT holds at most one wire, so an existing one at the
 * target is replaced — the drag the user just made is the one they meant.
 */
export function connectGrade(graph: GradeGraph, from: GradeEdge["from"], to: GradeEdge["to"]): void {
  if (from.node === to.node || from.port !== to.port) return;
  graph.edges = graph.edges.filter((e) => !(e.to.node === to.node && e.to.port === to.port && e.to.index === to.index));
  graph.edges.push({ id: createId("gedge"), from, to });
}

export function disconnectGrade(graph: GradeGraph, edgeId: string): void {
  graph.edges = graph.edges.filter((e) => e.id !== edgeId);
}

// ── Power windows ────────────────────────────────────────────────────────────

/** A drawn window of a given shape, sized to a fraction of the frame. */
export function makeWindow(shape: TrackShape, frameWidth: number, frameHeight: number, name?: string): PowerWindow {
  const w = Math.max(48, Math.round(frameWidth / 3));
  const h = Math.max(48, Math.round(frameHeight / 3));
  return {
    id: createId("win"),
    name: name ?? `${shape[0]!.toUpperCase()}${shape.slice(1)} window`,
    enabled: true,
    source: {
      type: "shape",
      shape,
      subpaths: toSubpaths(regionFromShape(shape, w, h)),
      transform: { x: 0, y: 0, scale: 1, scaleY: null, rotation: 0 },
    },
    feather: Math.round(Math.min(w, h) * 0.12),
    expand: 0,
    invert: false,
    combine: "union",
  };
}

export function addWindow(node: GradeNode, window: PowerWindow): void {
  if (node.kind !== "corrector") return;
  node.key.windows.push(window);
}

export function removeWindow(node: GradeNode, windowId: string): void {
  if (node.kind !== "corrector") return;
  node.key.windows = node.key.windows.filter((w) => w.id !== windowId);
}

/**
 * Point a window at a tracker instead of its own shape — the "track this
 * window" promotion. The caller creates the tracker (seeded from this window's
 * contour) and hands the id over; the window keeps its feather, expand, invert
 * and combine, because those describe the EDGE and the edge did not change.
 */
/** Key a window to a tracker: a region tracker's outline, or a depth tracker's band (kept if it already was one). */
export function trackWindow(node: GradeNode, windowId: string, trackerId: string, kind: "region" | "depth" = "region"): void {
  if (node.kind !== "corrector") return;
  const win = node.key.windows.find((w) => w.id === windowId);
  if (!win) return;
  if (kind === "depth") {
    const band = win.source.type === "depth" ? win.source : { near: 0, far: 0.4, softness: 0.05 };
    win.source = { type: "depth", trackerId, near: band.near, far: band.far, softness: band.softness } satisfies WindowSource;
  } else win.source = { type: "tracker", trackerId } satisfies WindowSource;
}

/** A depth window's band. */
export function setDepthWindowBand(node: GradeNode, windowId: string, patch: Partial<{ near: number; far: number; softness: number }>): void {
  if (node.kind !== "corrector") return;
  const win = node.key.windows.find((w) => w.id === windowId);
  if (win?.source.type === "depth") win.source = { ...win.source, ...patch };
}

/** Every grade graph in the document, with the clip and card that own it. */
export function allGrades(doc: MotionDocument): Array<{ clip: VisualClip; cardId: string; graph: GradeGraph }> {
  const out: Array<{ clip: VisualClip; cardId: string; graph: GradeGraph }> = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const effects = (clip as Partial<VisualClip>).effects;
      if (!effects) continue;
      for (const e of effects) {
        if (e.type === "grade") out.push({ clip: clip as VisualClip, cardId: e.id, graph: e.graph });
      }
    }
  }
  return out;
}

/** Every tracker any grade depends on — for badges and safe deletion. */
export function trackersUsedByGrades(doc: MotionDocument): Set<string> {
  const ids = new Set<string>();
  for (const { graph } of allGrades(doc)) {
    for (const node of graph.nodes) {
      if (node.kind !== "corrector") continue;
      for (const w of node.key.windows) if (w.source.type === "tracker" || w.source.type === "depth") ids.add(w.source.trackerId);
    }
  }
  return ids;
}
