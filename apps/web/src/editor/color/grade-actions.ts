"use client";

import {
  addOutsideOf,
  addParallelTo,
  connectGrade,
  createLayerEffect,
  createId,
  createTracker,
  footageTimeAt,
  defaultRegion,
  disconnectGrade,
  ensureClipGrade,
  findVisualClip,
  gradeCard,
  insertCorrectorAfter,
  makeWindow,
  removeGradeNode,
  removeWindow,
  trackWindow,
  setDepthWindowBand,
  type MotionDocument,
  type DocumentStore,
  type GradeEdge,
  type GradeGraph,
  type LayerEffectType,
  type TrackShape,
  type VisualClip,
} from "@solomotion/core";
import { useColorStore } from "./color-store";

/**
 * STORE-INTEGRATED GRADE ACTIONS — each one a single labelled update, so every
 * board gesture is one undo step.
 *
 * All of them reach the graph the same way: `clip.effects` → the `grade` card →
 * its `graph`. There is no lookup table and no id registry, because the card
 * IS the address. That is the property that made putting the graph on the card
 * worth the hand-written recursive types.
 */

/** Run `fn` against the live graph on a clip's grade card, inside one update. */
export function withGrade(
  store: DocumentStore,
  clipId: string,
  cardId: string,
  label: string,
  fn: (graph: GradeGraph, clip: VisualClip, doc: MotionDocument) => void,
  mergeKey?: string,
): void {
  store.update(
    label,
    (d) => {
      const clip = findVisualClip(d, clipId);
      if (!clip) return;
      const card = clip.effects.find((e) => e.id === cardId);
      if (card?.type !== "grade") return;
      fn(card.graph, clip, d);
    },
    mergeKey ? { mergeKey } : undefined,
  );
}

/**
 * Open the Color page on a clip, creating its grade card if it has none.
 *
 * The card is appended at the END of the stack: grading the finished layer is
 * what "colour this" means, and it is draggable from the moment it exists — so
 * this is a default, not a rule about ordering.
 */
export function openColorFor(store: DocumentStore, clipId: string): void {
  const doc = store.getState();
  const clip = findVisualClip(doc, clipId);
  if (!clip) return;
  const existing = gradeCard(clip);
  if (existing) {
    useColorStore.getState().setTarget(clipId, existing.id);
    useColorStore.getState().setOpen(true);
    return;
  }
  let cardId = "";
  store.update("Add grade", (d) => {
    const c = findVisualClip(d, clipId);
    if (!c) return;
    ensureClipGrade(c);
    cardId = gradeCard(c)?.id ?? "";
  });
  if (cardId) {
    useColorStore.getState().setTarget(clipId, cardId);
    useColorStore.getState().setOpen(true);
  }
}

/**
 * Apply a saved LOOK — a whole graph — to this card.
 *
 * Node ids are REISSUED on the way in. A look is a shape, not an identity: two
 * layers wearing the same look must not share node ids, or a keyframe path
 * written against one (`lfx.<card>.n.<node>.…`) would silently address the
 * other. The wiring is remapped through the same table, so the graph arrives
 * intact with a fresh identity.
 */
export function applyGradeLook(
  store: DocumentStore,
  clipId: string,
  cardId: string,
  data: unknown,
  /** What to call the result. A look's identity cannot survive its ids being
   *  reissued, so the NAME is the record of where the grade came from. */
  name?: string,
): void {
  const payload = data as { graph?: GradeGraph; mix?: number } | null;
  const incoming = payload?.graph;
  if (!incoming) return;
  store.update("Apply look", (d) => {
    const clip = findVisualClip(d, clipId);
    const card = clip?.effects.find((e) => e.id === cardId);
    if (card?.type !== "grade") return;
    const remap = new Map(incoming.nodes.map((n) => [n.id, createId("gnode")]));
    card.graph = {
      ...incoming,
      id: createId("grade"),
      name: name ?? incoming.name,
      nodes: incoming.nodes.map((n) => {
        const next = { ...n, id: remap.get(n.id)! };
        if (next.kind === "corrector") {
          // Effect ids too: they are the other half of the keyframe path.
          next.effects = next.effects.map((e) => ({ ...e, id: createId("lfx") }));
          next.key = {
            ...next.key,
            windows: next.key.windows.map((wdw) => ({ ...wdw, id: createId("win") })),
          };
        }
        return next;
      }),
      edges: incoming.edges.map((e) => ({
        id: createId("gedge"),
        from: { ...e.from, node: remap.get(e.from.node) ?? e.from.node },
        to: { ...e.to, node: remap.get(e.to.node) ?? e.to.node },
      })),
    };
    if (typeof payload?.mix === "number") card.mix = payload.mix;
  });
  useColorStore.getState().selectNode(null);
}

export function addSerialNode(store: DocumentStore, clipId: string, cardId: string, afterNodeId: string): void {
  let newId = "";
  withGrade(store, clipId, cardId, "Add node", (g) => {
    newId = insertCorrectorAfter(g, afterNodeId)?.id ?? "";
  });
  if (newId) useColorStore.getState().selectNode(newId);
}

export function addParallelNode(store: DocumentStore, clipId: string, cardId: string, siblingId: string): void {
  let newId = "";
  withGrade(store, clipId, cardId, "Add parallel node", (g) => {
    newId = addParallelTo(g, siblingId)?.id ?? "";
  });
  if (newId) useColorStore.getState().selectNode(newId);
}

export function addOutsideNode(store: DocumentStore, clipId: string, cardId: string, nodeId: string): void {
  let newId = "";
  withGrade(store, clipId, cardId, "Add outside node", (g) => {
    newId = addOutsideOf(g, nodeId)?.id ?? "";
  });
  if (newId) useColorStore.getState().selectNode(newId);
}

export function deleteNode(store: DocumentStore, clipId: string, cardId: string, nodeId: string): void {
  withGrade(store, clipId, cardId, "Delete node", (g) => removeGradeNode(g, nodeId));
  if (useColorStore.getState().selectedNodeId === nodeId) useColorStore.getState().selectNode(null);
}

export function renameNode(store: DocumentStore, clipId: string, cardId: string, nodeId: string, name: string): void {
  withGrade(store, clipId, cardId, "Rename node", (g) => {
    const n = g.nodes.find((x) => x.id === nodeId);
    if (n) n.name = name;
  });
}

export function toggleNode(store: DocumentStore, clipId: string, cardId: string, nodeId: string): void {
  withGrade(store, clipId, cardId, "Bypass node", (g) => {
    const n = g.nodes.find((x) => x.id === nodeId);
    if (n) n.enabled = !n.enabled;
  });
}

export function moveNode(store: DocumentStore, clipId: string, cardId: string, nodeId: string, x: number, y: number): void {
  withGrade(
    store,
    clipId,
    cardId,
    "Move node",
    (g) => {
      const n = g.nodes.find((x) => x.id === nodeId);
      if (n) {
        n.x = x;
        n.y = y;
      }
    },
    `grade-move-${nodeId}`,
  );
}

export function connect(store: DocumentStore, clipId: string, cardId: string, from: GradeEdge["from"], to: GradeEdge["to"]): void {
  withGrade(store, clipId, cardId, "Connect", (g) => connectGrade(g, from, to));
}

export function disconnect(store: DocumentStore, clipId: string, cardId: string, edgeId: string): void {
  withGrade(store, clipId, cardId, "Disconnect", (g) => disconnectGrade(g, edgeId));
  if (useColorStore.getState().selectedEdgeId === edgeId) useColorStore.getState().selectEdge(null);
}

/** Add a grading effect inside a corrector — the node's own stack. */
export function addNodeEffect(
  store: DocumentStore,
  clipId: string,
  cardId: string,
  nodeId: string,
  type: LayerEffectType,
): void {
  withGrade(store, clipId, cardId, "Add correction", (g) => {
    const n = g.nodes.find((x) => x.id === nodeId);
    if (n?.kind === "corrector") n.effects.push(createLayerEffect(type));
  });
}

export function removeNodeEffect(store: DocumentStore, clipId: string, cardId: string, nodeId: string, effectId: string): void {
  withGrade(store, clipId, cardId, "Remove correction", (g) => {
    const n = g.nodes.find((x) => x.id === nodeId);
    if (n?.kind === "corrector") n.effects = n.effects.filter((e) => e.id !== effectId);
  });
}

// ── Keys, windows and the join to tracking ──────────────────────────────────

export function setQualifierEnabled(store: DocumentStore, clipId: string, cardId: string, nodeId: string, on: boolean): void {
  withGrade(store, clipId, cardId, "Qualifier", (g) => {
    const n = g.nodes.find((x) => x.id === nodeId);
    if (n?.kind === "corrector") n.key.qualifier.enabled = on;
  });
}

export function patchKey(
  store: DocumentStore,
  clipId: string,
  cardId: string,
  nodeId: string,
  fn: (key: Extract<GradeGraph["nodes"][number], { kind: "corrector" }>["key"]) => void,
  mergeKey?: string,
): void {
  withGrade(
    store,
    clipId,
    cardId,
    "Key",
    (g) => {
      const n = g.nodes.find((x) => x.id === nodeId);
      if (n?.kind === "corrector") fn(n.key);
    },
    mergeKey,
  );
}

export function addPowerWindow(
  store: DocumentStore,
  clipId: string,
  cardId: string,
  nodeId: string,
  shape: TrackShape,
  frameWidth: number,
  frameHeight: number,
): void {
  withGrade(store, clipId, cardId, "Add window", (g) => {
    const n = g.nodes.find((x) => x.id === nodeId);
    if (n?.kind === "corrector") n.key.windows.push(makeWindow(shape, frameWidth, frameHeight));
  });
}

export function deletePowerWindow(store: DocumentStore, clipId: string, cardId: string, nodeId: string, windowId: string): void {
  withGrade(store, clipId, cardId, "Remove window", (g) => {
    const n = g.nodes.find((x) => x.id === nodeId);
    if (n) removeWindow(n, windowId);
  });
}

/**
 * PROMOTE A DRAWN WINDOW TO A TRACKED ONE — the move that makes colour and
 * tracking one feature.
 *
 * A tracker is created FROM the window's own contour, at the frame you are on,
 * and the window's source switches to it. Nothing about the shape is converted:
 * the contour a window stores and the contour a tracker stores are the same
 * type, so this is a change of owner rather than a translation between two
 * formats that would then drift.
 */
export function trackPowerWindow(
  store: DocumentStore,
  clipId: string,
  cardId: string,
  nodeId: string,
  windowId: string,
  sourceClipId: string,
  referenceMs: number,
): string | null {
  let made: string | null = null;
  withGrade(store, clipId, cardId, "Track window", (g, clip, d) => {
    void clip;
    const n = g.nodes.find((x) => x.id === nodeId);
    if (n?.kind !== "corrector") return;
    const win = n.key.windows.find((w) => w.id === windowId);
    if (!win || win.source.type !== "shape") return;
    const footage = findVisualClip(d, sourceClipId);
    if (!footage || (footage.kind !== "video" && footage.kind !== "image")) return;
    // The window's contour becomes the tracker's region verbatim.
    const region = {
      ...defaultRegion(win.source.shape, 100, 100),
      shape: win.source.shape,
      subpaths: win.source.subpaths,
      feather: win.feather,
      expand: win.expand,
      invert: win.invert,
    };
    // `referenceMs` arrives as the clip's local time; a tracker keys its footage's own time.
    const sourceMs = footageTimeAt(d, footage, footage.startMs + referenceMs) ?? referenceMs;
    const tracker = createTracker(d, { source: { kind: "asset", assetId: footage.assetId }, via: footage.id, region, referenceMs: sourceMs });
    trackWindow(n, windowId, tracker.id);
    made = tracker.id;
  });
  return made;
}

/** Key a window to a tracker that already exists — the same matte, shared. */
export function keyWindowToTracker(store: DocumentStore, clipId: string, cardId: string, nodeId: string, windowId: string, trackerId: string): void {
  // A depth tracker keys the window to a band of depth; any other to its outline.
  const kind = store.getState().trackers.find((t) => t.id === trackerId)?.kind === "depth" ? "depth" : "region";
  withGrade(store, clipId, cardId, kind === "depth" ? "Depth window" : "Window tracker", (g) => {
    const n = g.nodes.find((x) => x.id === nodeId);
    if (n) trackWindow(n, windowId, trackerId, kind);
  });
}

/** A depth window's band: near, far, softness (depth 0..1). */
export function patchDepthWindow(store: DocumentStore, clipId: string, cardId: string, nodeId: string, windowId: string, patch: Partial<{ near: number; far: number; softness: number }>): void {
  withGrade(store, clipId, cardId, "Depth band", (g) => {
    const n = g.nodes.find((x) => x.id === nodeId);
    if (n) setDepthWindowBand(n, windowId, patch);
  });
}
