"use client";

import * as React from "react";
import {
  compileGrade,
  isNeutralKey,
  layerEffectTypeDef,
  type GradeEdge,
  type GradeGraph,
  type GradeNode,
  type GradePortKind,
} from "@solomotion/core";
import { Ban, Circle, EyeOff, Plus, Split, Trash2, Waypoints } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDocStore } from "../state/document-context";
import { usePanZoomSurface } from "../state/use-pan-zoom-surface";
import { claimPointer, subscribePointerEnd } from "../input/pointer-gestures";
import { capturePointer } from "../input/capture-pointer";
import { gradeThumb, gradeThumbsVersion, subscribeGradeThumbs } from "../stage/render/grade-thumbs";
import { isTypingTarget } from "../input/typing-target";
import { useColorStore } from "./color-store";
import {
  addOutsideNode,
  addParallelNode,
  addSerialNode,
  connect,
  deleteNode,
  disconnect,
  moveNode,
  toggleNode,
} from "./grade-actions";

/**
 * THE GRADE BOARD — the node graph, drawn.
 *
 * Deliberately NOT the app's general node board, and the reason is the socket
 * model rather than taste. A board node's ports carry scalars and its card is a
 * column of value rows; a grade node's ports carry an IMAGE and a KEY, it has
 * exactly one of each on each side, and its card is a picture with a strip of
 * badges. Forcing one component over both would have meant a socket abstraction
 * that neither surface wanted, and a card layout that suited neither.
 *
 * What IS shared is everything that is genuinely the same question:
 * `usePanZoomSurface` (the camera, the pinch, the wheel, the space-pan — so a
 * board and a grade zoom identically), the pointer arbiter, the context-menu
 * primitive, and the document's own undo. A wire is a bezier because a bezier is
 * a bezier.
 */

const CARD_W = 168;
const CARD_H = 120;
const HEADER_H = 22;
const PORT_R = 6;

/** Where a port sits, in world coordinates. */
function portAt(node: GradeNode, port: GradePortKind, side: "in" | "out", index = 0): { x: number; y: number } {
  const x = side === "in" ? node.x : node.x + CARD_W;
  // RGB at a third, key at two thirds — far enough apart to hit with a finger
  // and near enough to read as one node's pair.
  const y = node.y + HEADER_H + (port === "rgb" ? (CARD_H - HEADER_H) * 0.34 : (CARD_H - HEADER_H) * 0.72) + index * 18;
  return { x, y };
}

const PORT_COLOR: Record<GradePortKind, string> = {
  rgb: "var(--primary)",
  // A matte is monochrome and so is its wire. Colouring the key channel the
  // same as the picture is how people lose track of which one they grabbed.
  key: "#9aa3b2",
};

function wirePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
}

interface DragWire {
  from: { node: string; port: GradePortKind; index: number };
  side: "in" | "out";
  to: { x: number; y: number };
}

export function GradeBoard({ graph, clipId, cardId }: { graph: GradeGraph; clipId: string; cardId: string }) {
  const store = useDocStore();
  const selectedNodeId = useColorStore((s) => s.selectedNodeId);
  const selectedEdgeId = useColorStore((s) => s.selectedEdgeId);
  const selectNode = useColorStore((s) => s.selectNode);
  const selectEdge = useColorStore((s) => s.selectEdge);
  const views = useColorStore((s) => s.views);
  const setView = useColorStore((s) => s.setView);

  const surface = usePanZoomSurface(views[graph.id] ?? { tx: 40, ty: 40, scale: 1 }, {
    minScale: 0.25,
    maxScale: 2.5,
    fitPaddingPx: 48,
  });
  const { camera, setCamera, containerRef, screenToWorld } = surface;
  const [wire, setWire] = React.useState<DragWire | null>(null);

  // Remember the camera per graph for the session, like the node board does.
  React.useEffect(() => setView(graph.id, camera), [camera, graph.id, setView]);
  React.useEffect(() => {
    const saved = views[graph.id];
    if (saved) setCamera(saved);
    // Only when the GRAPH changes — re-running on every camera tick would pin it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.id]);

  React.useEffect(() => subscribePointerEnd(() => setWire(null)), []);

  /**
   * Thumbnails exist only while this board does. The renderer's first gate is
   * "is anyone subscribed", so an unmounted Color page costs exactly nothing —
   * which is the answer to whether per-node previews are affordable: they are,
   * as long as nobody who is not looking pays for them.
   */
  const thumbVersion = React.useSyncExternalStore(subscribeGradeThumbs, gradeThumbsVersion, () => 0);

  /**
   * THE KEYBOARD. Shift+A adds, which is the Blender/board convention this app
   * already teaches, and Delete removes whichever of a node or a wire is
   * selected. Scoped to the board's own container rather than the window: a
   * grade page open beside a timeline must not eat the timeline's Delete.
   */
  const anchorFor = React.useCallback(
    (id: string | null) => id ?? [...graph.nodes].reverse().find((n) => n.kind === "corrector")?.id ?? graph.nodes.find((n) => n.kind === "source")?.id ?? null,
    [graph.nodes],
  );

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "a" && e.shiftKey) {
        e.preventDefault();
        const anchor = anchorFor(useColorStore.getState().selectedNodeId);
        if (anchor) addSerialNode(store, clipId, cardId, anchor);
        return;
      }
      if (key === "delete" || key === "backspace") {
        const { selectedNodeId: nid, selectedEdgeId: eid } = useColorStore.getState();
        if (eid) {
          e.preventDefault();
          disconnect(store, clipId, cardId, eid);
        } else if (nid) {
          e.preventDefault();
          deleteNode(store, clipId, cardId, nid);
        }
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [anchorFor, cardId, clipId, containerRef, store]);

  // The compile is what the board actually draws: orphan nodes come from here,
  // so the picture can never claim a node is live when the renderer skips it.
  const plan = React.useMemo(() => compileGrade(graph), [graph]);
  const orphans = React.useMemo(() => new Map(plan.orphans.map((o) => [o.nodeId, o.reason])), [plan]);

  const byId = React.useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  const startNodeDrag = (e: React.PointerEvent, node: GradeNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    claimPointer(e.pointerId, "drag");
    capturePointer(e.currentTarget as Element, e.pointerId);
    selectNode(node.id);
    const start = screenToWorld(...local(e, containerRef.current));
    const origin = { x: node.x, y: node.y };
    const move = (ev: PointerEvent) => {
      const p = screenToWorld(...local(ev, containerRef.current));
      moveNode(store, clipId, cardId, node.id, origin.x + (p.x - start.x), origin.y + (p.y - start.y));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
  };

  const startWire = (e: React.PointerEvent, node: GradeNode, port: GradePortKind, side: "in" | "out") => {
    e.stopPropagation();
    e.preventDefault();
    claimPointer(e.pointerId, "drag");
    const p = screenToWorld(...local(e, containerRef.current));
    setWire({ from: { node: node.id, port, index: 0 }, side, to: p });
    const move = (ev: PointerEvent) =>
      setWire((w) => (w ? { ...w, to: screenToWorld(...local(ev, containerRef.current)) } : null));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      // Land on whatever port is under the release. Reading the DOM rather than
      // hit-testing world coordinates means the drop target is exactly the thing
      // the eye saw highlight.
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-port]");
      const target = el?.dataset.port?.split(":");
      setWire(null);
      if (!target || target.length !== 3) return;
      const [tNode, tPort, tSide] = target as [string, GradePortKind, "in" | "out"];
      if (tPort !== port || tSide === side) return;
      const from = side === "out" ? { node: node.id, port, index: 0 } : { node: tNode, port, index: 0 };
      const to = side === "out" ? { node: tNode, port, index: 0 } : { node: node.id, port, index: 0 };
      connect(store, clipId, cardId, from, to);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          tabIndex={0}
          onPointerDown={(e) => {
            // The board owns its shortcuts, so a press anywhere inside it has
            // to give it focus — otherwise ⇧A works only after you happen to
            // hit the background, which is the kind of "sometimes" that reads
            // as broken.
            containerRef.current?.focus({ preventScroll: true });
            surface.onPanPointerDown(e);
            if (e.button === 0 && e.target === e.currentTarget) {
              selectNode(null);
              selectEdge(null);
            }
          }}
          className={cn(
            "relative h-full w-full overflow-hidden",
            // A dotted field, like every other free canvas here, so the camera
            // reads as a camera rather than as a page that jumps.
            "[background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:24px_24px]",
            surface.surfaceClassName,
            surface.panning && "cursor-grabbing",
            "outline-none",
          )}
          style={{ backgroundPosition: `${camera.tx}px ${camera.ty}px`, backgroundSize: `${24 * camera.scale}px ${24 * camera.scale}px` }}
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full">
            <g transform={`translate(${camera.tx} ${camera.ty}) scale(${camera.scale})`}>
              {graph.edges.map((edge) => {
                const a = byId.get(edge.from.node);
                const b = byId.get(edge.to.node);
                if (!a || !b) return null;
                const p1 = portAt(a, edge.from.port, "out");
                const p2 = portAt(b, edge.to.port, "in", edge.to.index);
                const on = selectedEdgeId === edge.id;
                return (
                  <path
                    key={edge.id}
                    d={wirePath(p1, p2)}
                    fill="none"
                    stroke={on ? "var(--primary)" : PORT_COLOR[edge.from.port]}
                    strokeWidth={on ? 3 : 2}
                    strokeOpacity={edge.from.port === "key" ? 0.8 : 0.9}
                    strokeDasharray={edge.from.port === "key" ? "6 4" : undefined}
                    className="pointer-events-auto cursor-pointer"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      selectEdge(edge.id);
                    }}
                  />
                );
              })}
              {wire && (
                <path
                  d={wirePath(
                    wire.side === "out" ? portAt(byId.get(wire.from.node)!, wire.from.port, "out") : wire.to,
                    wire.side === "out" ? wire.to : portAt(byId.get(wire.from.node)!, wire.from.port, "in"),
                  )}
                  fill="none"
                  stroke={PORT_COLOR[wire.from.port]}
                  strokeWidth={2}
                  strokeDasharray="4 4"
                />
              )}
            </g>
          </svg>

          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ transform: `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.scale})` }}
          >
            {graph.nodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                thumbVersion={thumbVersion}
                selected={selectedNodeId === node.id}
                orphan={orphans.get(node.id) ?? null}
                onPointerDown={(e) => startNodeDrag(e, node)}
                onPortDown={(e, port, side) => startWire(e, node, port, side)}
                onToggle={() => toggleNode(store, clipId, cardId, node.id)}
                onAddSerial={() => addSerialNode(store, clipId, cardId, node.id)}
                onAddParallel={() => addParallelNode(store, clipId, cardId, node.id)}
                onAddOutside={() => addOutsideNode(store, clipId, cardId, node.id)}
                onDelete={() => deleteNode(store, clipId, cardId, node.id)}
              />
            ))}
          </div>

          {/* THE TOOLBAR. The board had one way to add a node and it was a
              right-click — invisible on a desktop and unreachable on a tablet
              without knowing to press and hold. These four are the entire
              vocabulary of a grade's structure, so they are on screen. */}
          <div className="track absolute left-2 top-2 flex items-center gap-0.5 border border-border/70 bg-background/90 shadow-sm backdrop-blur">
            <BoardTool
              Icon={Plus}
              label="Add node after (⇧A)"
              onClick={() => {
                const anchor = anchorFor(selectedNodeId);
                if (anchor) addSerialNode(store, clipId, cardId, anchor);
              }}
            />
            <BoardTool
              Icon={Split}
              label="Add a parallel branch"
              disabled={!selectedNodeId}
              onClick={() => selectedNodeId && addParallelNode(store, clipId, cardId, selectedNodeId)}
            />
            <BoardTool
              Icon={Ban}
              label="Add an outside node — grade what this one did not take"
              disabled={!selectedNodeId}
              onClick={() => selectedNodeId && addOutsideNode(store, clipId, cardId, selectedNodeId)}
            />
            <div className="mx-0.5 h-4 w-px bg-border" />
            <BoardTool Icon={Waypoints} label="Fit the graph" onClick={() => surface.fit(boundsOf(graph))} />
          </div>

          {selectedEdgeId && (
            <button
              type="button"
              onClick={() => disconnect(store, clipId, cardId, selectedEdgeId)}
              className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-background/90 px-2 py-1 text-[11px] shadow-sm backdrop-blur"
            >
              <Trash2 className="size-3" /> Disconnect
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            const anchor = selectedNodeId ?? graph.nodes.find((n) => n.kind === "source")?.id;
            if (anchor) addSerialNode(store, clipId, cardId, anchor);
          }}
        >
          <Plus className="mr-2 size-3.5" /> Add node
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!selectedNodeId}
          onSelect={() => selectedNodeId && addParallelNode(store, clipId, cardId, selectedNodeId)}
        >
          <Split className="mr-2 size-3.5" /> Add parallel
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!selectedNodeId}
          onSelect={() => selectedNodeId && addOutsideNode(store, clipId, cardId, selectedNodeId)}
        >
          <Ban className="mr-2 size-3.5" /> Add outside
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => surface.fit(boundsOf(graph))}>
          <Waypoints className="mr-2 size-3.5" /> Fit graph
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The node's last rendered frame, drawn from the shared cache.
 *
 * A canvas rather than an <img>: the cache holds canvases the runner blits
 * into, and turning one into a data URL per node per pass would be the one
 * genuinely expensive thing in this whole feature.
 */
function NodeThumb({ nodeId, version }: { nodeId: string; version: number }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const dst = ref.current;
    const src = gradeThumb(nodeId);
    if (!dst) return;
    const ctx = dst.getContext("2d");
    if (!ctx) return;
    if (!src || src.width === 0) {
      ctx.clearRect(0, 0, dst.width, dst.height);
      return;
    }
    if (dst.width !== src.width || dst.height !== src.height) {
      dst.width = src.width;
      dst.height = src.height;
    }
    ctx.clearRect(0, 0, dst.width, dst.height);
    ctx.drawImage(src, 0, 0);
  }, [nodeId, version]);

  return (
    // A dark ground rather than a checkerboard: a thumbnail this small is read
    // for its TONE, and a checker under it lies about the shadows.
    <div className="h-10 w-full shrink-0 overflow-hidden rounded border border-border/50 bg-[#0a0b0d]">
      <canvas ref={ref} className="h-full w-full object-contain" />
    </div>
  );
}

function BoardTool({
  Icon,
  label,
  onClick,
  disabled,
}: {
  Icon: typeof Plus;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClick}
          className="grid size-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <Icon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function local(e: { clientX: number; clientY: number }, el: HTMLElement | null): [number, number] {
  const r = el?.getBoundingClientRect();
  return [e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0)];
}

function boundsOf(graph: GradeGraph) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of graph.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + CARD_W);
    maxY = Math.max(maxY, n.y + CARD_H);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: CARD_W, maxY: CARD_H };
  return { minX, minY, maxX, maxY };
}

const KIND_LABEL: Record<GradeNode["kind"], string> = {
  source: "Source",
  corrector: "Corrector",
  mixer: "Mixer",
  output: "Output",
};

function NodeCard({
  node,
  thumbVersion,
  selected,
  orphan,
  onPointerDown,
  onPortDown,
  onToggle,
  onAddSerial,
  onAddParallel,
  onAddOutside,
  onDelete,
}: {
  node: GradeNode;
  /** Bumped by the render loop; the canvases mutate in place and React cannot
   *  see that, so this is what makes a repaint land on screen. */
  thumbVersion: number;
  selected: boolean;
  orphan: "unreachable" | "cycle" | null;
  onPointerDown: (e: React.PointerEvent) => void;
  onPortDown: (e: React.PointerEvent, port: GradePortKind, side: "in" | "out") => void;
  onToggle: () => void;
  onAddSerial: () => void;
  onAddParallel: () => void;
  onAddOutside: () => void;
  onDelete: () => void;
}) {
  const corrector = node.kind === "corrector" ? node : null;
  const keyed = corrector ? !isNeutralKey(corrector.key) : false;
  const label = node.name || KIND_LABEL[node.kind];
  const fixed = node.kind === "source" || node.kind === "output";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onPointerDown={onPointerDown}
          style={{ left: node.x, top: node.y, width: CARD_W, height: CARD_H }}
          className={cn(
            "group absolute select-none rounded-lg border bg-card shadow-sm transition-colors",
            selected ? "border-primary ring-1 ring-primary/40" : "border-border",
            !node.enabled && "opacity-45",
            orphan && "opacity-40",
          )}
        >
          <div className="flex h-[22px] items-center gap-1 rounded-t-lg border-b border-border/60 bg-muted/50 px-1.5">
            <span className="truncate text-[10px] font-medium">{label}</span>
            {keyed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-auto rounded bg-foreground/10 px-1 text-[8px] uppercase tracking-wide">key</span>
                </TooltipTrigger>
                <TooltipContent>This node grades only part of the picture</TooltipContent>
              </Tooltip>
            )}
            {!node.enabled && <EyeOff className={cn("size-3 text-muted-foreground", keyed ? "ml-1" : "ml-auto")} />}
          </div>

          {/* WHAT THIS NODE PRODUCED, then what it is made of. The picture
              first, because a chain of thumbnails is the thing you actually
              read a grade from — the badges are the caption. */}
          <div className="flex h-[calc(100%-22px)] flex-col gap-1 p-1.5">
            <NodeThumb nodeId={node.id} version={thumbVersion} />
            {corrector ? (
              <div className="flex flex-wrap content-start gap-0.5 overflow-hidden">
                {corrector.effects.length === 0 && (
                  <span className="text-[10px] text-muted-foreground">No correction yet</span>
                )}
                {corrector.effects.map((e) => (
                  <span key={e.id} className="rounded bg-foreground/[0.07] px-1 py-px text-[9px]">
                    {layerEffectTypeDef(e.type)?.label ?? e.type}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-[10px] text-muted-foreground">
                {node.kind === "source"
                  ? "The plate"
                  : node.kind === "output"
                    ? "What gets drawn"
                    : node.kind === "mixer" && node.mix === "layer"
                      ? "Layered, top over bottom"
                      : "Averaged"}
              </span>
            )}

            {corrector && (
              <div className="mt-auto flex items-center gap-1 text-[9px] text-muted-foreground">
                {corrector.key.windows.length > 0 && (
                  <span className="flex items-center gap-0.5">
                    <Circle className="size-2.5" />
                    {corrector.key.windows.length}
                  </span>
                )}
                {corrector.opacity < 1 && <span>{Math.round(corrector.opacity * 100)}%</span>}
                {corrector.blend !== "normal" && <span className="truncate">{corrector.blend}</span>}
                {orphan && <span className="ml-auto text-warning">{orphan === "cycle" ? "loop" : "not wired"}</span>}
              </div>
            )}
          </div>

          {/* Ports. Rendered as real elements rather than SVG circles so the
              drop target the release reads is the same box the eye hit. */}
          {node.kind !== "source" && (
            <>
              <Port node={node} port="rgb" side="in" onDown={onPortDown} />
              {node.kind === "corrector" && <Port node={node} port="key" side="in" onDown={onPortDown} />}
            </>
          )}
          {node.kind !== "output" && (
            <>
              <Port node={node} port="rgb" side="out" onDown={onPortDown} />
              {node.kind === "corrector" && <Port node={node} port="key" side="out" onDown={onPortDown} />}
            </>
          )}

          {/* Add-after, on the card. The gesture people reach for first is
              "another one of these, right here", and it should not require
              finding a menu. Revealed on hover and always present on a coarse
              pointer, where there is no hover to reveal it with. */}
          {node.kind !== "output" && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onAddSerial();
              }}
              title="Add a node after this one"
              className={cn(
                "absolute grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground transition-opacity",
                "opacity-0 hover:text-foreground group-hover:opacity-100",
                "[@media(pointer:coarse)]:opacity-100",
              )}
              style={{ left: CARD_W - 10, top: -10 }}
            >
              <Plus className="size-3" />
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onAddSerial}>
          <Plus className="mr-2 size-3.5" /> Add node after
        </ContextMenuItem>
        <ContextMenuItem onSelect={onAddParallel} disabled={node.kind === "source"}>
          <Split className="mr-2 size-3.5" /> Add parallel
        </ContextMenuItem>
        <ContextMenuItem onSelect={onAddOutside} disabled={node.kind !== "corrector"}>
          <Ban className="mr-2 size-3.5" /> Add outside
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onToggle} disabled={fixed}>
          <EyeOff className="mr-2 size-3.5" /> {node.enabled ? "Bypass" : "Enable"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onDelete} disabled={fixed} className="text-destructive focus:text-destructive">
          <Trash2 className="mr-2 size-3.5" /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Port({
  node,
  port,
  side,
  onDown,
}: {
  node: GradeNode;
  port: GradePortKind;
  side: "in" | "out";
  onDown: (e: React.PointerEvent, port: GradePortKind, side: "in" | "out") => void;
}) {
  const p = portAt(node, port, side);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          data-port={`${node.id}:${port}:${side}`}
          onPointerDown={(e) => onDown(e, port, side)}
          className="absolute cursor-crosshair rounded-full border-2 border-card transition-transform hover:scale-125"
          style={{
            left: p.x - node.x - PORT_R,
            top: p.y - node.y - PORT_R,
            width: PORT_R * 2,
            height: PORT_R * 2,
            background: PORT_COLOR[port],
          }}
        />
      </TooltipTrigger>
      <TooltipContent side={side === "in" ? "left" : "right"}>
        {port === "rgb" ? "Picture" : "Key — the matte this node selects"}
      </TooltipContent>
    </Tooltip>
  );
}

export { CARD_W, CARD_H };
export type { GradeEdge };
