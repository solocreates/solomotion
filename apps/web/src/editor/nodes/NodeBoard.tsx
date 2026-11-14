"use client";

import * as React from "react";
import { clipLocalClamped } from "../inspector/animatable";
import { ClipboardPaste, Map as MapIcon, MousePointerSquareDashed, Plus, Settings2 } from "lucide-react";
import {
  CATEGORY_META,
  NODE_CATEGORIES,
  canWire,
  clipAnimatableProperties,
  connect,
  createId,
  createNode,
  defaultNodeRegistry as reg,
  disconnect,
  disconnectInput,
  duplicateNodes,
  evaluateGraph,
  groupNodes,
  inboundEdge,
  moveNodes,
  parseSelectedVariables,
  sampleKeyframes,
  setKeyframe,
  VARIABLES_NODE_TYPE,
  variableWriteConflicts,
  setNodeParam,
  socketType,
  spliceNodeOnEdge,
  ungroup,
  type AABB,
  type Camera,
  type Clip,
  type GraphEdge,
  type GraphNode,
  type NodeCategory,
  type NodeGraph,
  type NodeParam,
  type NodeValue,
  type SocketRef,
  type SocketSpec,
  type VariableWriteConflict,
  compFps,
  withExpressionContext,
} from "@solomotion/core";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { ZoomControl, ZoomPresetList } from "@/components/ui/zoom-control";
import { CAMERA_ZOOM, stepLevel, zoomCommandFor, type ViewZoomSpec } from "../workspace/view-zoom";
import { ownsInput, registerZoomTarget } from "../workspace/zoom-shortcuts";

/**
 * The board is a CAMERA view (D5) whose renderer is legible only between 20%
 * and 250% — the kind's presets, clamped to what the board can draw.
 */
const BOARD_ZOOM: ViewZoomSpec = {
  ...CAMERA_ZOOM,
  min: 0.2,
  max: 2.5,
  presets: CAMERA_ZOOM.presets.filter((p) => p.value === "fit" || (p.value >= 0.2 && p.value <= 2.5)),
};
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { VariableTakeoverDialog } from "./VariableTakeoverDialog";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession, useParkedPlayhead } from "../state/session";
import { activeCompId } from "../timeline/timeline-utils";
import { animWriteMode } from "../inspector/animatable";
import { spacePan } from "../stage/space-pan";
import { useSweepSelect } from "../state/use-sweep-select";
import { useBoardStore } from "./board-store";
import { useResolvedDoc } from "./use-resolved";
import { effectiveTarget, makeDriverEnv, makeExprContext, soundGeneration, withEffectiveTargets } from "@solomotion/core";
import { onSoundAnalysis } from "../audio/sound-host";
import {
  deleteBoardNodes,
  findGraph,
  releaseVariableDriver,
  updateGraph,
} from "./graph-actions";
import { usePanZoomSurface } from "../state/use-pan-zoom-surface";
import {
  boxesOverlap,
  graphBounds,
  NODE_WIDTH,
  nodeBounds,
  nodeLayout,
  socketWorldPos,
  wireDistance,
  wirePath,
  type NodeLayout,
} from "./board-geometry";
import { NodeCard, type SocketRefDir } from "./NodeCard";
import { AddNodeMenu, type AddMenuAnchor } from "./AddNodeMenu";
import { Minimap } from "./Minimap";
import { capturePointer } from "../input/capture-pointer";
import { eventKey } from "../state/shortcut-registry";
import { isTypingFocused, isTypingTarget } from "../input/typing-target";

/**
 * THE NODE BOARD — a Blender-style graph workspace that reuses the Stage's
 * pan/zoom feel headlessly (`usePanZoomSurface`) and drives every structural
 * edit through the pure core ops. Everything lives in ONE camera-transformed
 * world layer so wires and cards zoom together; gestures translate pointer
 * deltas into world space and delegate the maths to `graph-ops`.
 */

const SPLICE_WORLD_RADIUS = 26;
const GROUP_PAD = 16;
const GROUP_HEADER = 22;

function unionBounds(boxes: AABB[]): AABB | null {
  if (boxes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY };
}

export function NodeBoard({
  graphId,
  ownerLabel,
  scope,
}: {
  graphId: string;
  ownerLabel: string;
  scope: "layer" | "frame" | "global";
}) {
  const doc = useDoc();
  const visualDoc = useResolvedDoc();
  const store = useDocStore();
  const baseGraph = findGraph(doc, graphId) ?? null;
  const playheadMs = useParkedPlayhead();
  // The board evaluates against the comp you're editing, so a `Frame` node
  // reports that comp's frame number rather than some project-wide count.
  const activeFrameId = useSession((s) => s.activeFrameId);
  const compId = activeCompId(doc, activeFrameId);

  // MIRROR THE EFFECT STACKS. Effect cards are a projection of `clip.effects`,
  // so adding or removing an effect in the inspector has to make its card appear
  // or vanish here. `updateGraph` already runs the sync on every board edit; a
  // no-op transform is therefore the whole poke — and a sync that changes nothing
  // produces no immer patches, so it costs no history entry and no re-render.
  const effectStackSig = React.useMemo(() => {
    const parts: string[] = [];
    for (const t of doc.tracks)
      for (const c of t.clips)
        if ("effects" in c && Array.isArray(c.effects) && c.effects.length)
          parts.push(`${c.id}=${c.effects.map((e) => e.id).join(",")}`);
    return parts.join("|");
  }, [doc]);
  React.useEffect(() => {
    if (graphId) updateGraph(store, graphId, "Sync effect nodes", (g) => g);
  }, [effectStackSig, graphId, store]);

  // The owning layer clip (for layer-scoped graphs) — the home for node-value
  // keyframes, and the source of their sampled values at the playhead.
  const ownerClip = React.useMemo<Clip | null>(() => {
    if (!baseGraph?.ownerId) return null;
    for (const t of doc.tracks) for (const c of t.clips) if (c.id === baseGraph.ownerId) return c;
    return null;
  }, [doc, baseGraph?.ownerId]);
  const ownerLocalMs = ownerClip ? Math.min(Math.max(playheadMs - ownerClip.startMs, 0), ownerClip.durationMs) : playheadMs;

  // Effective graph: numeric params that carry a keyframe track on the owning
  // clip are overridden with their SAMPLED value at the playhead, so the board
  // (readouts + eval + inline fields) shows exactly what the layer sees — the
  // node tree animating through the SAME keyframe system as everything else.
  const graph = React.useMemo(() => {
    if (!baseGraph || !ownerClip) return baseGraph;
    const sampled = sampleKeyframes(ownerClip.keyframes, ownerLocalMs);
    let changed = false;
    const nodes = baseGraph.nodes.map((n) => {
      let np: Record<string, typeof n.params[string]> | null = null;
      for (const key of Object.keys(n.params)) {
        const v = sampled[`node.${n.id}.${key}`];
        if (typeof v === "number") {
          np = np ?? { ...n.params };
          np[key] = v;
          changed = true;
        }
      }
      // Operators fed by a Layer hub read/drive THAT hub's layer — resolve their
      // effective target from the wire so sockets/fields/eval all see it.
      const et = effectiveTarget(baseGraph, n);
      if (et && et !== n.params.target) {
        np = np ?? { ...n.params };
        np.target = et;
        changed = true;
      }
      return np ? { ...n, params: np } : n;
    });
    return changed ? { ...baseGraph, nodes } : baseGraph;
  }, [baseGraph, ownerClip, ownerLocalMs]);
  const selectedNodeIds = useBoardStore((s) => s.selectedNodeIds);
  const selectedEdgeId = useBoardStore((s) => s.selectedEdgeId);
  const minimapVisible = useBoardStore((s) => s.minimapVisible);
  const minimapCorner = useBoardStore((s) => s.minimapCorner);
  const board = useBoardStore;

  const initialCam = React.useMemo<Camera>(
    () => board.getState().views[graphId] ?? graph?.view ?? { scale: 1, tx: 0, ty: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graphId],
  );
  const surface = usePanZoomSurface(initialCam, { minScale: BOARD_ZOOM.min, maxScale: BOARD_ZOOM.max });
  const { camera, containerRef, screenToWorld, panning } = surface;
  const camRef = React.useRef(camera);
  camRef.current = camera;

  // Live property projection for a target layer — feeds Object/projection nodes'
  // dynamic sockets (layout, eval, wiring) straight from the document, so they
  // mirror whatever layer they point at with zero hand-listing.
  const describeClip = React.useCallback(
    (id: string): ReturnType<typeof clipAnimatableProperties> => {
      for (const t of doc.tracks) for (const c of t.clips) if (c.id === id) return clipAnimatableProperties(c);
      return [];
    },
    [doc],
  );

  // A card's value rows show the layer AS IT IS — drivers baked — so a field on
  // the board reads the same number the canvas is drawing. Structure still comes
  // from the raw document above; only what a row DISPLAYS comes from here.
  const clipById = React.useCallback(
    (id: string): Clip | null => {
      for (const t of visualDoc.tracks) for (const c of t.clips) if (c.id === id) return c;
      return null;
    },
    [visualDoc],
  );


  // Object (projection) AND effect cards are both LAYER-SCOPED: they read/drive a
  // clip's real properties, so they share the target clip, the collapse rule and
  // the expand chevron. One predicate, so the two never drift apart.
  const isLayerScoped = (c: NodeCategory) => c === "object" || c === "effect";

  // The VISIBLE sockets of a node. Projection nodes collapse by default to just
  // their main "Layer" handle + the rows that are already meaningful (keyframed,
  // driven, or wired); expanding (header chevron → node.params.expanded) reveals
  // every property. ONE resolver so layout, rendering, hit-testing and wire
  // validation all agree on which sockets exist right now.
  /**
   * A VARIABLE ROW ANOTHER GRAPH ALREADY WRITES. One question, one answer
   * (`variableWriteConflicts`), used three ways: the socket paints itself
   * disabled and says who holds it, the drop offers to take it over, and the
   * driver sync refuses the write outright. Only the Variables node can write a
   * variable, so only its rows can be blocked.
   */
  const conflicts = React.useMemo(() => variableWriteConflicts(doc, graphId), [doc, graphId]);
  const blockedInputsOf = React.useCallback(
    (node: GraphNode): Map<string, VariableWriteConflict> | undefined => {
      if (node.type !== VARIABLES_NODE_TYPE || conflicts.size === 0) return undefined;
      const out = new Map<string, VariableWriteConflict>();
      for (const v of parseSelectedVariables(node)) {
        const held = conflicts.get(v.id);
        if (held) out.set(v.id, held);
      }
      return out.size ? out : undefined;
    },
    [conflicts],
  );

  const visibleSocketsOf = React.useCallback(
    (node: GraphNode): { inputs: SocketSpec[]; outputs: SocketSpec[]; hidden: number } => {
      const def = reg.get(node.type);
      const inputs = reg.inputsOf(node, { describeClip });
      const outputs = reg.outputsOf(node, { describeClip });
      if (!def || !isLayerScoped(def.category)) return { inputs, outputs, hidden: 0 };
      const target = typeof node.params.target === "string" ? node.params.target : "";
      let clip: Clip | null = null;
      if (target) for (const t of doc.tracks) for (const c of t.clips) if (c.id === target) clip = c;
      const kf = new Set(clip?.keyframes.map((t) => t.property) ?? []);
      const driven = new Set(Object.keys(clip?.drivers ?? {}));
      const wired = new Set<string>();
      if (graph)
        for (const e of graph.edges) {
          if (e.to.node === node.id) wired.add(e.to.socket);
          if (e.from.node === node.id) wired.add(e.from.socket);
        }
      // No `path` = the main handle (always kept); a property row survives only
      // when it already matters.
      const active = (s: SocketSpec) => !s.path || kf.has(s.path) || driven.has(s.path) || wired.has(s.key);
      const vIn = inputs.filter(active);
      const vOut = outputs.filter(active);
      // `hidden` is what the collapse WOULD hide, computed whether or not the card
      // is currently expanded — it is the ONE number that decides if an expand
      // affordance is offered at all, so a card with nothing to reveal (the
      // Effects hub: Layer in, Stack out) never grows a dead chevron.
      const hidden = inputs.length - vIn.length + outputs.length - vOut.length;
      if (node.params.expanded) return { inputs, outputs, hidden };
      return { inputs: vIn, outputs: vOut, hidden };
    },
    [describeClip, doc, graph],
  );

  const layoutCache = React.useRef(new Map<string, NodeLayout>());
  const layoutOf = React.useCallback(
    (node: GraphNode): NodeLayout => {
      const def = reg.get(node.type);
      if (!def) return { width: NODE_WIDTH, height: 40, inputs: [], outputs: [], optionsY: 30 };
      const { inputs, outputs } = visibleSocketsOf(node);
      // Cache by a signature capturing target + expand + socket counts.
      const key = `${node.type}:${String(node.params.target ?? "")}:${node.params.expanded ? 1 : 0}:${inputs.length}:${outputs.length}`;
      const cached = layoutCache.current.get(key);
      if (cached) return cached;
      const l = nodeLayout(def, inputs, outputs);
      layoutCache.current.set(key, l);
      return l;
    },
    [visibleSocketsOf],
  );

  // A sound's analysis landing changes what a Sound node reads at the same instant.
  const heard = React.useSyncExternalStore(onSoundAnalysis, soundGeneration, soundGeneration);
  const evalResult = React.useMemo(() => {
    if (!graph) return null;
    const env = makeDriverEnv(doc, playheadMs, compId);
    // The board previews inside the SAME ambient context the renderer paints in,
    // because an Expression node's `#time`/`#comp.*` are read from it, not passed
    // to it. Without this the card confidently showed the value at time zero
    // while the canvas drew the value at the playhead.
    return withExpressionContext(makeExprContext(doc, playheadMs, compId, false), () =>
      evaluateGraph(graph, reg, {
        timeMs: playheadMs,
        fps: compFps(doc, compId),
        describeClip,
        readProperty: env.readProperty,
        readVariable: env.readVariable,
        // So an Expression node previews on the board with the same numbers the
        // renderer will draw — one language, one answer, both surfaces.
        expressions: env.expressions,
        mediaAt: env.mediaAt,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, playheadMs, doc, compId, describeClip, heard]);
  const valuesByNode = React.useMemo(() => {
    const map = new Map<string, Record<string, NodeValue>>();
    if (!evalResult) return map;
    for (const [k, v] of evalResult.outputs) {
      const sep = k.lastIndexOf(":");
      const rec = map.get(k.slice(0, sep)) ?? {};
      rec[k.slice(sep + 1)] = v;
      map.set(k.slice(0, sep), rec);
    }
    return map;
  }, [evalResult]);

  const connectedByNode = React.useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!graph) return map;
    for (const e of graph.edges) {
      const set = map.get(e.to.node) ?? new Set<string>();
      set.add(e.to.socket);
      map.set(e.to.node, set);
    }
    return map;
  }, [graph]);

  // ── interaction state ──────────────────────────────────────────────────────
  const [liveWire, setLiveWire] = React.useState<{ anchor: SocketRef; anchorDir: "in" | "out"; cursor: { x: number; y: number } } | null>(null);
  const [wireTarget, setWireTarget] = React.useState<({ node: string } & SocketRefDir) | null>(null);
  // A drop that was refused because another graph writes that variable — held so
  // the person can take it over instead of being told "no" and left with nothing.
  const [takeover, setTakeover] = React.useState<
    { held: VariableWriteConflict; from: SocketRef; to: SocketRef } | null
  >(null);
  const [marquee, setMarquee] = React.useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [spliceEdgeId, setSpliceEdgeId] = React.useState<string | null>(null);
  const [addMenu, setAddMenu] = React.useState<AddMenuAnchor | null>(null);
  const pointer = React.useRef({ clientX: 0, clientY: 0, screenX: 0, screenY: 0, worldX: 0, worldY: 0 });
  const contextAt = React.useRef<AddMenuAnchor>({ clientX: 0, clientY: 0, worldX: 0, worldY: 0 });

  const rect = () => containerRef.current?.getBoundingClientRect();
  const screenAt = (e: { clientX: number; clientY: number }) => {
    const r = rect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const worldAt = (e: { clientX: number; clientY: number }) => {
    const s = screenAt(e);
    return screenToWorld(s.x, s.y);
  };
  const trackPointer = (e: React.PointerEvent) => {
    const s = screenAt(e);
    const w = screenToWorld(s.x, s.y);
    pointer.current = { clientX: e.clientX, clientY: e.clientY, screenX: s.x, screenY: s.y, worldX: w.x, worldY: w.y };
  };

  React.useEffect(() => {
    if (graph && !board.getState().views[graphId] && !graph.view) {
      const b = graphBounds(graph, layoutOf);
      if (b) surface.fit(b);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId]);

  React.useEffect(() => {
    board.getState().setView(graphId, camera);
  }, [camera, graphId, board]);

  React.useEffect(() => {
    // Take keyboard focus for board shortcuts — but NEVER steal it from an open
    // editor. A fresh stage text layer autofocuses its editor; grabbing focus
    // here ate the first keystrokes (they landed on the board, which swallows
    // them). Only pull focus when nothing editable holds it.
    if (isTypingFocused()) return;
    containerRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId]);

  // Honor a driver "open at node" request: when this graph is the pinned one,
  // select the node and center the camera on it at a readable zoom, then release
  // the pin. This is the board side of the reusable "open board AT a node" seam.
  const focus = useBoardStore((s) => s.focus);
  React.useEffect(() => {
    if (!focus || focus.graphId !== graphId) return;
    const g = findGraph(store.getState(), graphId);
    const node = g?.nodes.find((n) => n.id === focus.nodeId);
    if (!node) {
      board.getState().clearFocus();
      return;
    }
    const layout = layoutOf(node);
    const cx = node.x + layout.width / 2;
    const cy = node.y + layout.height / 2;
    const vp = surface.viewport();
    const k = 1;
    surface.setCamera(() => ({ scale: k, tx: vp.width / 2 - cx * k, ty: vp.height / 2 - cy * k }));
    board.getState().select([focus.nodeId]);
    board.getState().clearFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, graphId]);

  // ── helpers ─────────────────────────────────────────────────────────────────
  const nearestSocket = React.useCallback(
    (world: { x: number; y: number }, dir: "in" | "out"): ({ node: string } & SocketRefDir) | null => {
      const base = findGraph(store.getState(), graphId);
      // Bake hub-fed targets so a node's per-property sockets (X, Y…) actually
      // resolve — otherwise only the "Layer" socket exists and drops snap there.
      const g = base ? withEffectiveTargets(base) : null;
      if (!g) return null;
      let best: ({ node: string } & SocketRefDir) | null = null;
      let bestD = 16 / camRef.current.scale;
      for (const node of g.nodes) {
        const def = reg.get(node.type);
        if (!def) continue;
        const layout = layoutOf(node);
        const vis = visibleSocketsOf(node);
        for (const s of dir === "out" ? vis.outputs : vis.inputs) {
          const p = socketWorldPos(node, layout, dir, s.key);
          if (!p) continue;
          const d = Math.hypot(p.x - world.x, p.y - world.y);
          if (d < bestD) {
            bestD = d;
            best = { node: node.id, dir, key: s.key };
          }
        }
      }
      return best;
    },
    [store, graphId, layoutOf],
  );

  const edgeEnds = React.useCallback(
    (g: NodeGraph, e: GraphEdge): { a: { x: number; y: number }; b: { x: number; y: number } } | null => {
      const fromNode = g.nodes.find((n) => n.id === e.from.node);
      const toNode = g.nodes.find((n) => n.id === e.to.node);
      if (!fromNode || !toNode) return null;
      const a = socketWorldPos(fromNode, layoutOf(fromNode), "out", e.from.socket);
      const b = socketWorldPos(toNode, layoutOf(toNode), "in", e.to.socket);
      return a && b ? { a, b } : null;
    },
    [layoutOf],
  );

  const spliceCandidate = (dragIds: string[]): string | null => {
    const base = findGraph(store.getState(), graphId);
    const g = base ? withEffectiveTargets(base) : null;
    if (!g || dragIds.length !== 1) return null;
    const node = g.nodes.find((n) => n.id === dragIds[0]);
    if (!node || g.edges.some((e) => e.from.node === node.id || e.to.node === node.id)) return null;
    const layout = layoutOf(node);
    const center = { x: node.x + layout.width / 2, y: node.y + layout.height / 2 };
    let best: string | null = null;
    let bestD = SPLICE_WORLD_RADIUS;
    for (const e of g.edges) {
      const ends = edgeEnds(g, e);
      if (!ends) continue;
      const d = wireDistance(ends.a, ends.b, center);
      if (d < bestD) {
        bestD = d;
        best = e.id;
      }
    }
    return best;
  };

  // ── node drag / select ───────────────────────────────────────────────────────
  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    if (spacePan.held || e.button === 1) {
      surface.onPanPointerDown(e);
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    capturePointer((e.currentTarget as Element), e.pointerId);
    const additive = e.metaKey || e.ctrlKey;
    const st = board.getState();
    if (!additive && !st.selectedNodeIds.includes(id)) st.select([id]);

    const isAlt = e.altKey;
    const isShift = e.shiftKey;
    const startClient = { x: e.clientX, y: e.clientY };
    let lastWorld = worldAt(e);
    let moved = false;
    let duplicated = false;
    let extracted = false;
    let dragIds = additive ? st.selectedNodeIds : st.selectedNodeIds.includes(id) ? st.selectedNodeIds : [id];

    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) < 3) return;
      moved = true;
      const w = worldAt(ev);
      const dx = w.x - lastWorld.x;
      const dy = w.y - lastWorld.y;
      lastWorld = w;

      if (isAlt && !duplicated) {
        const snap = findGraph(store.getState(), graphId);
        if (snap) {
          const dup = duplicateNodes(snap, dragIds, 0, 0);
          updateGraph(store, graphId, "Duplicate nodes", () => dup.graph);
          board.getState().select(dup.newIds);
          dragIds = dup.newIds;
        }
        duplicated = true;
      }
      if (isShift && !extracted) {
        const set = new Set(dragIds);
        updateGraph(store, graphId, "Detach nodes", (g) => ({
          ...g,
          edges: g.edges.filter((ed) => !set.has(ed.from.node) && !set.has(ed.to.node)),
        }));
        extracted = true;
      }
      updateGraph(store, graphId, "Move nodes", (g) => moveNodes(g, dragIds, dx, dy), "drag-nodes");
      setSpliceEdgeId(spliceCandidate(dragIds));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) {
        if (additive) board.getState().toggle(id);
        else board.getState().select([id]);
      } else {
        const cand = spliceCandidate(dragIds);
        if (cand && dragIds.length === 1) updateGraph(store, graphId, "Insert node", (g) => spliceNodeOnEdge(reg, g, cand, dragIds[0]!));
      }
      setSpliceEdgeId(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ── group frame drag (move all members) ──────────────────────────────────────
  const onGroupPointerDown = (e: React.PointerEvent, groupId: string) => {
    if (spacePan.held || e.button === 1) {
      surface.onPanPointerDown(e);
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    capturePointer((e.currentTarget as Element), e.pointerId);
    const g0 = findGraph(store.getState(), graphId);
    const memberIds = g0 ? g0.nodes.filter((n) => n.groupId === groupId).map((n) => n.id) : [];
    board.getState().select(memberIds);
    let lastWorld = worldAt(e);
    const move = (ev: PointerEvent) => {
      const w = worldAt(ev);
      const dx = w.x - lastWorld.x;
      const dy = w.y - lastWorld.y;
      lastWorld = w;
      updateGraph(store, graphId, "Move group", (g) => moveNodes(g, memberIds, dx, dy), "drag-nodes");
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Persist one wire. Validate on the baked graph, but write only the EDGE
   *  delta onto the base graph so operators keep their wire-owned (empty)
   *  target. The drag and the take-over confirm both land here. */
  const applyConnect = React.useCallback(
    (from: SocketRef, to: SocketRef) => {
      updateGraph(store, graphId, "Connect", (base) => {
        const res = connect(reg, withEffectiveTargets(base), from, to, describeClip);
        return res ? { ...base, edges: res.edges } : null;
      });
    },
    [store, graphId, describeClip],
  );

  // ── wire drag ────────────────────────────────────────────────────────────────
  const onSocketPointerDown = (e: React.PointerEvent, nodeId: string, dir: "in" | "out", key: string) => {
    if (spacePan.held || e.button === 1) {
      surface.onPanPointerDown(e);
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    // Capture on the socket element itself — the SAME pattern node dragging uses
    // (which works): the captured pointer keeps delivering moves to this element,
    // and they bubble to the window listeners below.
    capturePointer((e.currentTarget as Element), e.pointerId);
    const g0 = findGraph(store.getState(), graphId);
    if (!g0) return;

    let anchor: SocketRef;
    let anchorDir: "in" | "out";
    if (dir === "out") {
      anchor = { node: nodeId, socket: key };
      anchorDir = "out";
    } else {
      const existing = inboundEdge(g0, nodeId, key);
      if (existing) {
        updateGraph(store, graphId, "Disconnect", (g) => disconnect(g, existing.id));
        anchor = existing.from;
        anchorDir = "out";
      } else {
        anchor = { node: nodeId, socket: key };
        anchorDir = "in";
      }
    }
    setLiveWire({ anchor, anchorDir, cursor: worldAt(e) });
    let dropTarget: ({ node: string } & SocketRefDir) | null = null;
    // A socket we hovered that was type-INCOMPATIBLE — so a release near it can
    // explain WHY nothing connected instead of failing silently.
    let missReason: string | null = null;

    const move = (ev: PointerEvent) => {
      const w = worldAt(ev);
      const target = nearestSocket(w, anchorDir === "out" ? "in" : "out");
      const base = findGraph(store.getState(), graphId);
      // Validate against baked targets so property↔property wires are allowed
      // (base operators have an empty target → only the Layer socket resolves).
      const g = base ? withEffectiveTargets(base) : null;
      let ok: ({ node: string } & SocketRefDir) | null = null;
      missReason = null;
      if (target && g) {
        const from = anchorDir === "out" ? anchor : { node: target.node, socket: target.key };
        const to = anchorDir === "out" ? { node: target.node, socket: target.key } : anchor;
        if (canWire(reg, g, from, to, describeClip)) ok = target;
        else {
          // Over a socket, but the wire is illegal — say why (a cycle vs a type
          // clash) so the rule is visible, not a mystery.
          const ft = socketType(reg, g, from, "out", describeClip);
          const tt = socketType(reg, g, to, "in", describeClip);
          missReason =
            ft && tt && from.node !== to.node ? `Can’t connect ${ft} → ${tt} — types don’t match` : "Can’t connect these — it would loop";
        }
      }
      dropTarget = ok;
      setWireTarget(ok);
      setLiveWire((lw) => (lw ? { ...lw, cursor: w } : lw));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!dropTarget && missReason) toast(missReason);
      if (dropTarget) {
        const from = anchorDir === "out" ? anchor : { node: dropTarget.node, socket: dropTarget.key };
        const to = anchorDir === "out" ? { node: dropTarget.node, socket: dropTarget.key } : anchor;
        // Dropped on a variable another graph writes: ask, rather than connect a
        // wire that would silently do nothing (the sync refuses foreign writes).
        const targetNode = findGraph(store.getState(), graphId)?.nodes.find((n) => n.id === to.node);
        const held = targetNode ? blockedInputsOf(targetNode)?.get(to.socket) : undefined;
        if (held) {
          setTakeover({ held, from, to });
          setWireTarget(null);
          setLiveWire(null);
          return;
        }
        applyConnect(from, to);
      }
      setWireTarget(null);
      setLiveWire(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ── surface (empty space): pan or marquee ────────────────────────────────────
  /*
   * The board's lasso. Its rectangle below is WORLD-space (screen → world, then
   * box overlap against each node's layout bounds) because the board is a
   * camera, not a scroller — so the shared hook could not replace it. But nodes
   * already carry `data-node-id`, and a polygon drawn on screen hit-tests their
   * screen rects perfectly well, so the lasso needs nothing new here either.
   */
  const lassoBase = React.useRef<string[]>([]);
  const lasso = useSweepSelect(containerRef, "data-node-id", {
    onDragStart: (additive) => {
      lassoBase.current = additive ? board.getState().selectedNodeIds : [];
    },
    onSweep: (ids) => board.getState().select([...new Set([...lassoBase.current, ...ids])]),
    onClear: () => board.getState().clearSelection(),
  });

  const onSurfacePointerDown = (e: React.PointerEvent) => {
    if (spacePan.held || e.button === 1) {
      surface.onPanPointerDown(e);
      return;
    }
    if (e.button !== 0) return;
    // The lasso owns the surface while armed; two selection shapes must never
    // race one pointer-down.
    if (lasso.armed) return;
    const additive = e.shiftKey;
    const base = additive ? board.getState().selectedNodeIds : [];
    const start = screenAt(e);
    const startClient = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) < 4) return;
      moved = true;
      const cur = screenAt(ev);
      const x = Math.min(start.x, cur.x);
      const y = Math.min(start.y, cur.y);
      const w = Math.abs(cur.x - start.x);
      const h = Math.abs(cur.y - start.y);
      setMarquee({ x, y, w, h });
      const wa = screenToWorld(x, y);
      const wb = screenToWorld(x + w, y + h);
      const box = { minX: wa.x, minY: wa.y, maxX: wb.x, maxY: wb.y };
      const g = findGraph(store.getState(), graphId);
      const hits = g ? g.nodes.filter((n) => boxesOverlap(box, nodeBounds(n, layoutOf(n)))).map((n) => n.id) : [];
      board.getState().select([...new Set([...base, ...hits])]);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved && !additive) board.getState().clearSelection();
      setMarquee(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ── commands ─────────────────────────────────────────────────────────────────
  const addNode = React.useCallback(
    (type: string, worldX: number, worldY: number) => {
      const node = createNode(reg, type, worldX, worldY);
      if (!node) return;
      // Object/projection nodes start belonging to NO layer (empty target) and
      // EXPANDED — pick a layer (or wire the Layer socket) and every field's
      // input+output shows at once, instead of the compact card hiding them.
      if (reg.get(type)?.category === "object") {
        node.params = { ...node.params, expanded: true };
      }
      updateGraph(store, graphId, `Add ${type}`, (g) => ({ ...g, nodes: [...g.nodes, node] }));
      board.getState().select([node.id]);
    },
    [store, graphId, board],
  );

  // Commit a NUMERIC node value through the app's animatable policy: a keyframe
  // at the playhead when the value is keyed OR record mode is armed, else the
  // base param. Reuses `animWriteMode` + `setKeyframe` — the exact same brain
  // the inspector uses — so node values record/animate identically.
  const commitNodeValue = React.useCallback(
    (nodeId: string, key: string, value: number, mergeKey?: string) => {
      store.update(
        "Set node value",
        (draft) => {
          const g = draft.graphs.find((x) => x.id === graphId);
          const node = g?.nodes.find((n) => n.id === nodeId);
          if (!g || !node) return;
          const path = `node.${nodeId}.${key}`;
          let clip: Clip | null = null;
          if (g.ownerId) for (const t of draft.tracks) for (const c of t.clips) if (c.id === g.ownerId) clip = c;
          if (clip && animWriteMode(clip, path) === "keyframe") {
            const local = clipLocalClamped(clip, playheadMs);
            setKeyframe(clip.keyframes, path, local, value);
          } else {
            node.params[key] = value;
          }
        },
        mergeKey ? { mergeKey } : undefined,
      );
    },
    [store, graphId, playheadMs],
  );

  // Unwire an input socket (used by the projection card's "Layer" chip to unlink
  // a node from its hub — the picker and the Layer socket are one control now).
  const clearInput = React.useCallback(
    (nodeId: string, key: string) => {
      updateGraph(store, graphId, "Unlink layer", (g) => disconnectInput(g, nodeId, key));
    },
    [store, graphId],
  );

  const copySelection = React.useCallback(() => {
    const g = findGraph(store.getState(), graphId);
    if (!g) return;
    const ids = new Set(board.getState().selectedNodeIds);
    if (ids.size === 0) return;
    board.getState().setClipboard({
      nodes: g.nodes.filter((n) => ids.has(n.id)).map((n) => ({ ...n, params: { ...n.params } })),
      edges: g.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node)),
    });
  }, [store, graphId, board]);

  const pasteAt = React.useCallback(
    (worldX: number, worldY: number) => {
      const clip = board.getState().clipboard;
      if (!clip || clip.nodes.length === 0) return;
      const minX = Math.min(...clip.nodes.map((n) => n.x));
      const minY = Math.min(...clip.nodes.map((n) => n.y));
      const idMap = new Map<string, string>();
      const nodes: GraphNode[] = clip.nodes.map((n) => {
        const nid = createId("node");
        idMap.set(n.id, nid);
        return { ...n, id: nid, x: worldX + (n.x - minX), y: worldY + (n.y - minY), params: { ...n.params }, groupId: null };
      });
      const edges: GraphEdge[] = clip.edges.map((e) => ({
        id: createId("edge"),
        from: { node: idMap.get(e.from.node)!, socket: e.from.socket },
        to: { node: idMap.get(e.to.node)!, socket: e.to.socket },
      }));
      updateGraph(store, graphId, "Paste nodes", (g) => ({ ...g, nodes: [...g.nodes, ...nodes], edges: [...g.edges, ...edges] }));
      board.getState().select([...idMap.values()]);
    },
    [store, graphId, board],
  );

  const groupSelection = React.useCallback(() => {
    const ids = board.getState().selectedNodeIds;
    if (ids.length < 1) return;
    updateGraph(store, graphId, "Group nodes", (g) => groupNodes(g, ids));
  }, [store, graphId, board]);

  const ungroupSelection = React.useCallback(() => {
    const g = findGraph(store.getState(), graphId);
    if (!g) return;
    const ids = new Set(board.getState().selectedNodeIds);
    const gids = new Set(g.nodes.filter((n) => ids.has(n.id) && n.groupId).map((n) => n.groupId as string));
    let next = g;
    for (const gid of gids) next = ungroup(next, gid);
    if (gids.size) updateGraph(store, graphId, "Ungroup", () => next);
  }, [store, graphId, board]);

  const selectAll = React.useCallback(() => {
    const g = findGraph(store.getState(), graphId);
    if (g) board.getState().select(g.nodes.map((n) => n.id));
  }, [store, graphId, board]);

  const deleteSelection = React.useCallback(() => {
    const { selectedNodeIds: ids, selectedEdgeId: edgeSel } = board.getState();
    if (ids.length) deleteBoardNodes(store, graphId, ids);
    if (edgeSel) updateGraph(store, graphId, "Delete wire", (g) => disconnect(g, edgeSel));
    board.getState().clearSelection();
  }, [store, graphId, board]);

  const openAddMenu = (a: AddMenuAnchor) => setAddMenu(a);

  // The surface's own centre-anchored zoom, bounded by the board's spec.
  const zoomTo = surface.zoomTo;
  const fitAll = () => {
    if (!graph) return;
    const b = graphBounds(graph, layoutOf);
    if (b) surface.fit(b);
  };

  // The D5 zoom keys, through the one router: this board owns them while the
  // pointer is over it or focus is inside it.
  const zoomRef = React.useRef({ zoomTo, fitAll });
  zoomRef.current = { zoomTo, fitAll };
  React.useEffect(
    () =>
      registerZoomTarget({
        isActive: () => ownsInput(containerRef.current),
        run: (cmd) => {
          const { zoomTo: z, fitAll: f } = zoomRef.current;
          if (cmd === "fit") f();
          else if (cmd === "actual") z(1);
          else z(stepLevel(BOARD_ZOOM, camRef.current.scale, cmd === "in" ? 1 : -1));
        },
      }),
    [containerRef],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Zoom keys belong to the shared router (above); let them reach it.
    if (zoomCommandFor(e)) return;
    if (isTypingTarget(e.target)) {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    // Undo/redo belong to the global handler (they cover board edits too).
    if (meta && eventKey(e) === "z") return;
    // Everything else while the board is focused is the BOARD's — stop it here so
    // the app's global shortcuts (clip copy/cut/paste/delete) never also fire.
    // This is what stops ⌘V from pasting a whole clip alongside the nodes.
    e.stopPropagation();
    if (e.key === "Escape") {
      if (addMenu) setAddMenu(null);
      else board.getState().clearSelection();
      return;
    }
    if ((eventKey(e) === "a" && e.shiftKey && !meta) || (e.code === "Space" && e.shiftKey)) {
      e.preventDefault();
      openAddMenu({ clientX: pointer.current.clientX, clientY: pointer.current.clientY, worldX: pointer.current.worldX, worldY: pointer.current.worldY });
      return;
    }
    if (meta && eventKey(e) === "g") {
      e.preventDefault();
      if (e.shiftKey) ungroupSelection();
      else groupSelection();
      return;
    }
    if (meta && eventKey(e) === "a") {
      e.preventDefault();
      selectAll();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelection();
      return;
    }
    if (meta && eventKey(e) === "c") return void copySelection();
    if (meta && eventKey(e) === "x") {
      e.preventDefault();
      copySelection();
      deleteBoardNodes(store, graphId, board.getState().selectedNodeIds, "Cut nodes");
      board.getState().clearSelection();
      return;
    }
    if (meta && eventKey(e) === "v") {
      e.preventDefault();
      pasteAt(pointer.current.worldX, pointer.current.worldY);
      return;
    }
    if (meta && eventKey(e) === "d") {
      e.preventDefault();
      const g = findGraph(store.getState(), graphId);
      const ids = board.getState().selectedNodeIds;
      if (g && ids.length) {
        const dup = duplicateNodes(g, ids, 32, 32);
        updateGraph(store, graphId, "Duplicate nodes", () => dup.graph);
        board.getState().select(dup.newIds);
      }
    }
  };

  if (!graph) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">This graph was removed.</div>;
  }

  const { scale, tx, ty } = camera;
  const selectedSet = new Set(selectedNodeIds);
  const wireColor = (sourceNodeId: string): string => {
    const def = reg.get(graph.nodes.find((n) => n.id === sourceNodeId)?.type ?? "");
    return def ? CATEGORY_META[def.category].color : "rgba(180,190,205,0.85)";
  };
  const hasSelection = selectedNodeIds.length > 0;
  const canPaste = useBoardStore((s) => !!s.clipboard);

  // Group frames — world rects behind their member nodes.
  const groupFrames = graph.groups
    .map((grp) => {
      const members = graph.nodes.filter((n) => n.groupId === grp.id);
      const b = unionBounds(members.map((m) => nodeBounds(m, layoutOf(m))));
      return b ? { grp, box: b } : null;
    })
    .filter(Boolean) as { grp: (typeof graph.groups)[number]; box: AABB }[];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            lasso.onPointerDown(e);
            onSurfacePointerDown(e);
          }}
          onPointerMove={trackPointer}
          onContextMenu={(e) => {
            const s = screenAt(e);
            const w = screenToWorld(s.x, s.y);
            contextAt.current = { clientX: e.clientX, clientY: e.clientY, worldX: w.x, worldY: w.y };
          }}
          // `bg-stage` — the board is a CANVAS, the same kind of surface as the
          // stage, so it wears the theme's surround rather than the near-black
          // literal it used to hardcode (`#0d0d10`, which was the dark theme's
          // stage tone copied by hand and then frozen). It now goes light with
          // the light theme, in step with the stage beside it.
          className={cn(
            "relative h-full w-full touch-none overflow-hidden bg-stage outline-none",
            panning ? "cursor-grabbing" : spacePan.held ? "cursor-grab" : "cursor-default",
          )}
          style={{
            // The dot grid is INK on that surround, not a white constant: at
            // 6% white it simply vanished on a pale board.
            backgroundImage:
              "radial-gradient(circle, color-mix(in srgb, var(--foreground) 22%, transparent) 1px, transparent 1px)",
            backgroundSize: `${24 * scale}px ${24 * scale}px`,
            backgroundPosition: `${tx}px ${ty}px`,
          }}
        >
          <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}>
            {/* Group frames (behind everything) */}
            {groupFrames.map(({ grp, box }) => {
              const accent = grp.color ?? "#7d8794";
              return (
                <div key={grp.id} className="absolute" style={{ left: box.minX - GROUP_PAD, top: box.minY - GROUP_PAD - GROUP_HEADER }}>
                  <div
                    className="rounded-xl border"
                    style={{
                      width: box.maxX - box.minX + GROUP_PAD * 2,
                      height: box.maxY - box.minY + GROUP_PAD * 2 + GROUP_HEADER,
                      borderColor: `${accent}66`,
                      backgroundColor: `${accent}12`,
                    }}
                  >
                    <div
                      onPointerDown={(e) => onGroupPointerDown(e, grp.id)}
                      className="flex h-[22px] cursor-grab items-center gap-1.5 rounded-t-xl px-2.5 text-[11px] font-medium"
                      style={{ backgroundColor: `${accent}22`, color: "#cfd6df" }}
                    >
                      <span className="size-1.5 rounded-full" style={{ backgroundColor: accent }} />
                      {grp.name}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Wires */}
            <svg className="pointer-events-none absolute overflow-visible" style={{ left: 0, top: 0, width: 1, height: 1 }}>
              {graph.edges.map((e) => {
                const ends = edgeEnds(graph, e);
                if (!ends) return null;
                const selected = e.id === selectedEdgeId;
                const splice = e.id === spliceEdgeId;
                // Colour the wire by the SOURCE node's category, so a graph reads
                // as organised families of connections at a glance.
                const color = wireColor(e.from.node);
                return (
                  <g key={e.id}>
                    <path
                      d={wirePath(ends.a, ends.b)}
                      className="pointer-events-auto cursor-pointer"
                      fill="none"
                      stroke="transparent"
                      strokeWidth={16}
                      vectorEffect="non-scaling-stroke"
                      onPointerDown={(ev) => {
                        ev.stopPropagation();
                        // Shift/Alt-click ANY wire severs it (headless — one rule
                        // for every connection); a plain click just selects it.
                        if (ev.shiftKey || ev.altKey) {
                          updateGraph(store, graphId, "Disconnect", (g) => disconnect(g, e.id));
                          board.getState().selectEdge(null);
                        } else {
                          board.getState().selectEdge(e.id);
                        }
                      }}
                    />
                    <path
                      d={wirePath(ends.a, ends.b)}
                      fill="none"
                      stroke={splice ? "#ff8732" : selected ? "hsl(var(--primary))" : color}
                      strokeWidth={splice || selected ? 2.75 : 2}
                      strokeOpacity={selected || splice ? 1 : 0.9}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                );
              })}
            </svg>

            {/* Nodes */}
            {graph.nodes.map((node) => {
              const def = reg.get(node.type);
              if (!def) return null;
              const highlight: SocketRefDir | null = wireTarget && wireTarget.node === node.id ? { dir: wireTarget.dir, key: wireTarget.key } : null;
              const vis = visibleSocketsOf(node);
              return (
                <NodeCard
                  key={node.id}
                  node={node}
                  def={def}
                  inputs={vis.inputs}
                  outputs={vis.outputs}
                  expandable={isLayerScoped(def.category) && vis.hidden > 0}
                  expanded={Boolean(node.params.expanded)}
                  targetClip={
                    isLayerScoped(def.category) && typeof node.params.target === "string"
                      ? clipById(node.params.target)
                      : null
                  }
                  nodeVariables={
                    def.type === VARIABLES_NODE_TYPE
                      ? parseSelectedVariables(node)
                          .map((s) => doc.variables.find((v) => v.id === s.id))
                          .filter((v): v is (typeof doc.variables)[number] => !!v)
                      : undefined
                  }
                  onToggleExpand={() =>
                    updateGraph(store, graphId, "Toggle node details", (g) =>
                      setNodeParam(g, node.id, "expanded", !node.params.expanded),
                    )
                  }
                  layout={layoutOf(node)}
                  selected={selectedSet.has(node.id)}
                  cyclic={evalResult?.cyclic.has(node.id) ?? false}
                  connectedInputs={connectedByNode.get(node.id) ?? EMPTY_SET}
                  blockedInputs={blockedInputsOf(node)}
                  values={valuesByNode.get(node.id)}
                  highlight={highlight}
                  ownerClip={ownerClip}
                  onNodePointerDown={onNodePointerDown}
                  onSocketPointerDown={onSocketPointerDown}
                  onSocketPointerUp={() => {}}
                  onDisconnectInput={clearInput}
                  onParam={(nid, key, value, mergeKey) =>
                    typeof value === "number"
                      ? commitNodeValue(nid, key, value, mergeKey)
                      : updateGraph(store, graphId, "Edit node", (g) => setNodeParam(g, nid, key, value as NodeParam), mergeKey)
                  }
                />
              );
            })}
          </div>

          {/* LIVE DRAG WIRE — drawn in SCREEN space over the whole surface, so it
              can never be clipped by the world layer's SVG. Two points: the anchor
              socket and the cursor, projected world→screen; same curve/style as a
              real wire. */}
          {liveWire &&
            (() => {
              const node = graph.nodes.find((n) => n.id === liveWire.anchor.node);
              if (!node) return null;
              const wp = socketWorldPos(node, layoutOf(node), liveWire.anchorDir, liveWire.anchor.socket);
              if (!wp) return null;
              const anchorS = surface.worldToScreen(wp.x, wp.y);
              const cursorS = surface.worldToScreen(liveWire.cursor.x, liveWire.cursor.y);
              const from = liveWire.anchorDir === "out" ? anchorS : cursorS;
              const to = liveWire.anchorDir === "out" ? cursorS : anchorS;
              // Tint the drag wire by its source (output) node when we know it.
              const color = liveWire.anchorDir === "out" ? wireColor(liveWire.anchor.node) : "hsl(var(--primary))";
              return (
                <svg className="pointer-events-none absolute inset-0 h-full w-full">
                  <path d={wirePath(from, to)} fill="none" stroke={color} strokeWidth={2.75} strokeDasharray="7 4" />
                  <circle cx={anchorS.x} cy={anchorS.y} r={4.5} fill={color} />
                  <circle cx={cursorS.x} cy={cursorS.y} r={6} fill={color} stroke="white" strokeWidth={1.5} />
                </svg>
              );
            })()}

          {/* Marquee (screen space) */}
          {marquee && (
            <div className="pointer-events-none absolute rounded-sm border border-primary/70 bg-primary/10" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
          )}

          {/* The lasso polygon — same screen space as the rect above. */}
          {lasso.marqueeNode}

          {/* Scope chip — which layer/frame this node tree belongs to. */}
          <div className="pointer-events-none absolute left-3 top-3">
            <div className="material-glass pointer-events-auto flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium">
              <span className="size-2 rounded-full bg-primary" />
              <span className="text-muted-foreground">{scope === "global" ? "Document" : scope === "frame" ? "Frame" : "Layer"}</span>
              <span className="max-w-45 truncate">{ownerLabel}</span>
            </div>
          </div>

          {/* Settings gear — BOTTOM-RIGHT, mirroring the main stage. Its popover
              holds the live zoom (the same ZoomControl the stage uses) and the
              board view options, so there's no chrome scattered on the canvas. */}
          <div className="pointer-events-auto absolute bottom-3 right-3">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="material-glass rounded-full" aria-label="Board settings">
                  <Settings2 />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" side="top" className="w-60">
                <div className="mb-1 text-[11px] font-medium text-muted-foreground">Zoom</div>
                <ZoomControl
                  value={camera.scale}
                  spec={BOARD_ZOOM}
                  length={168}
                  onChange={(v) => zoomTo(v)}
                  onReset={fitAll}
                  aria-label="Board zoom"
                />
                <ZoomPresetList spec={BOARD_ZOOM} value={camera.scale} onPick={zoomTo} onFit={fitAll} />
                <div className="my-2 h-px bg-border" />
                <div className="flex items-center gap-2 py-0.5">
                  <MapIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 text-xs">Minimap</span>
                  <Switch checked={minimapVisible} onCheckedChange={(v) => board.getState().setMinimapVisible(v)} />
                </div>
                {minimapVisible && (
                  <div className="mt-2 grid grid-cols-2 gap-1">
                    {(["tl", "tr", "bl", "br"] as const).map((c) => (
                      <Button
                        key={c}
                        variant={minimapCorner === c ? "secondary" : "ghost"}
                        size="sm"
                        className="h-7 text-[11px]"
                        onClick={() => board.getState().setMinimapCorner(c)}
                      >
                        {c === "tl" ? "Top left" : c === "tr" ? "Top right" : c === "bl" ? "Bottom left" : "Bottom right"}
                      </Button>
                    ))}
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>

          {minimapVisible && (
            <Minimap
              graph={graph}
              layoutOf={layoutOf}
              camera={camera}
              viewport={surface.viewport()}
              corner={minimapCorner}
              onHide={() => board.getState().setMinimapVisible(false)}
              onCenterOn={(wx, wy) => {
                const vp = surface.viewport();
                surface.setCamera((c) => ({ ...c, tx: vp.width / 2 - wx * c.scale, ty: vp.height / 2 - wy * c.scale }));
              }}
            />
          )}

          {addMenu && (
            <AddNodeMenu
              anchor={addMenu}
              context={graph.kind === "expression" ? "expression" : "board"}
              onPick={(type) => {
                addNode(type, addMenu.worldX, addMenu.worldY);
                setAddMenu(null);
              }}
              onClose={() => setAddMenu(null)}
            />
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => openAddMenu(contextAt.current)}>
          <Plus /> Add node…
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Plus /> Add
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
<ScrollArea className="max-h-80">
            {NODE_CATEGORIES.map((cat) => {
              const items = reg.forContext(graph.kind === "expression" ? "expression" : "board").filter((d) => d.category === cat && !d.hidden);
              if (items.length === 0) return null;
              return (
                <React.Fragment key={cat}>
                  <ContextMenuLabel className="flex items-center gap-1.5 text-[11px]">
                    <span className="size-2 rounded-full" style={{ backgroundColor: CATEGORY_META[cat].color }} />
                    {CATEGORY_META[cat].label}
                  </ContextMenuLabel>
                  {items.map((d) => (
                    <ContextMenuItem key={d.type} className="pl-6" onSelect={() => addNode(d.type, contextAt.current.worldX, contextAt.current.worldY)}>
                      {d.title}
                    </ContextMenuItem>
                  ))}
                </React.Fragment>
              );
            })}
          </ScrollArea>
        </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canPaste} onSelect={() => pasteAt(contextAt.current.worldX, contextAt.current.worldY)}>
          <ClipboardPaste /> Paste
        </ContextMenuItem>
        <ContextMenuItem onSelect={selectAll}>
          <MousePointerSquareDashed /> Select all
        </ContextMenuItem>
        {hasSelection && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={groupSelection}>Group selection ⌘G</ContextMenuItem>
            <ContextMenuItem onSelect={copySelection}>Copy ⌘C</ContextMenuItem>
            <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={deleteSelection}>
              Delete ⌫
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
      <VariableTakeoverDialog
        conflict={takeover?.held ?? null}
        onCancel={() => setTakeover(null)}
        onForce={() => {
          if (!takeover) return;
          // Release FIRST: the other graph's edge is the truth, and cutting it is
          // what lets `syncVariableDrivers` hand the variable to this wire.
          releaseVariableDriver(store, takeover.held.token);
          applyConnect(takeover.from, takeover.to);
          setTakeover(null);
        }}
      />
    </ContextMenu>
  );
}

const EMPTY_SET: Set<string> = new Set();
