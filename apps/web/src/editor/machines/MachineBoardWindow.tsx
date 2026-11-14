"use client";

import * as React from "react";
import { Plus, Workflow, X, Zap } from "lucide-react";
import {
  MACHINE_ANY,
  MACHINE_EXIT,
  addState,
  addTransition,
  describeCondition,
  duplicateStates,
  inputPath,
  reify,
  newMachineLayer,
  removeStates,
  removeTransitions,
  renameState,
  writeChannel,
  type Frame,
  type InputDef,
  type Machine,
  type MachineCondition,
  type MachineLayer,
  type MachineLayerReading,
  type MachineTransition,
} from "@solomotion/core";
import { FloatingWindow, type WindowBounds } from "@/components/ui/floating-window";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RenameInput } from "@/components/ui/rename-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useDoc, useDocStore } from "../state/document-context";
import { usePanZoomSurface } from "../state/use-pan-zoom-surface";
import { spacePan } from "../stage/space-pan";
import { isTypingTarget } from "../input/typing-target";
import { useMachineBoard } from "./machine-store";

const MachineCodeEditor = lazyComponent("MachineCodeEditor", () => import("./MachineCodeEditor"));
import { useLiveMachine, type LiveMachine } from "./use-live-machine";
import { BoardMinimap } from "../board/BoardMinimap";
import { BoardAddMenu, type BoardAddAnchor, type BoardAddGroup } from "../board/BoardAddMenu";
import { behaviorTint } from "../character/behavior-style";
import { CARD_H, CARD_W, ENTRY, arrowBetween, layerNodes, nodeAt, nodesBounds, type BoardNode } from "./machine-geometry";
import { lazyComponent } from "@/editor/lazy-component";

/**
 * THE MACHINE BOARD — a Rive-style state graph in a floating window (the node
 * board's chrome and camera: `usePanZoomSurface`, the dot grid, glass chips).
 * Board · Code tabs (ux.md §4.5). Every edit goes through the core machine ops
 * as one undo step; the state lit at the playhead comes from `useLiveMachine`,
 * which renders only when the state changes, never per frame.
 */
export default function MachineBoardWindow({ frameId, machineId }: { frameId: string; machineId: string }) {
  const doc = useDoc();
  const tab = useMachineBoard((s) => s.tab);
  const frame = doc.frames.find((f) => f.id === frameId);
  const machine = frame?.machines?.find((m) => m.id === machineId);
  const [bounds, setBounds] = React.useState<WindowBounds>(() => {
    const width = Math.min(940, window.innerWidth - 120);
    const height = Math.min(580, window.innerHeight - 200);
    return { x: window.innerWidth - width - 40, y: 96, width, height, minimized: false };
  });
  const close = () => useMachineBoard.getState().close();
  React.useEffect(() => {
    if (!machine) close();
  }, [machine]);
  if (!frame || !machine) return null;

  return (
    <FloatingWindow
      title={machine.name}
      icon={<Workflow className="size-3.5" />}
      bounds={bounds}
      windowId="machine-board"
      minWidth={460}
      minHeight={300}
      onBoundsChange={(patch) => setBounds((b) => ({ ...b, ...patch }))}
      onToggleMinimize={() => setBounds((b) => ({ ...b, minimized: !b.minimized }))}
      onClose={close}
      body="fill"
      titleActions={
        <div className="flex items-center rounded-md bg-muted/60 p-0.5 text-[11px]">
          {(["board", "code"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={cn("rounded px-2 py-0.5", tab === t ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
              onClick={() => useMachineBoard.getState().setTab(t)}
            >
              {t === "board" ? "Board" : "Code"}
            </button>
          ))}
        </div>
      }
    >
      {tab === "board" ? <MachineBoard frame={frame} machine={machine} onClose={close} /> : <MachineCodeTab frame={frame} machine={machine} />}
    </FloatingWindow>
  );
}

// ── The board ────────────────────────────────────────────────────────────────

type Selection = { kind: "states"; ids: string[] } | { kind: "transition"; id: string } | null;

function MachineBoard({ frame, machine, onClose }: { frame: Frame; machine: Machine; onClose: () => void }) {
  const store = useDocStore();
  const [layerIdx, setLayerIdx] = React.useState(0);
  const layer = machine.layers[Math.min(layerIdx, machine.layers.length - 1)];
  const live = useLiveMachine(frame.id, machine.id);
  const liveLayer = live?.reading.layers[Math.min(layerIdx, machine.layers.length - 1)] ?? null;
  const [selection, setSelection] = React.useState<Selection>(null);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [wire, setWire] = React.useState<{ from: string; cursor: { x: number; y: number } } | null>(null);
  /** ⇧A / right-click: the add menu, at the cursor. */
  const [adding, setAdding] = React.useState<BoardAddAnchor | null>(null);
  /** A marquee drag on empty board: its corners, world space. */
  const [marquee, setMarquee] = React.useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const [minimap, setMinimap] = React.useState(true);
  const lastPointer = React.useRef<{ clientX: number; clientY: number } | null>(null);
  const doc = useDoc();
  const surface = usePanZoomSurface({ scale: 1, tx: 0, ty: 0 }, { minScale: 0.25, maxScale: 2 });
  const { camera, containerRef } = surface;
  const nodes = React.useMemo(() => (layer ? layerNodes(layer) : []), [layer]);

  /** One undo step on this layer. */
  const edit = React.useCallback(
    (label: string, fn: (l: MachineLayer, f: Frame) => void, mergeKey?: string) =>
      store.update(
        label,
        (d) => {
          const f = d.frames.find((x) => x.id === frame.id);
          const m = f?.machines?.find((x) => x.id === machine.id);
          const l = m?.layers.find((x) => x.id === layer?.id);
          if (f && l) fn(l, f);
        },
        mergeKey ? { mergeKey } : undefined,
      ),
    [store, frame.id, machine.id, layer?.id],
  );

  const fitAll = React.useCallback(() => {
    const b = nodesBounds(nodes);
    if (b) surface.fit(b);
  }, [nodes, surface]);
  const fitted = React.useRef(false);
  React.useEffect(() => {
    if (fitted.current || !containerRef.current) return;
    fitted.current = true;
    fitAll();
  }, [fitAll, containerRef]);

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = containerRef.current!.getBoundingClientRect();
    return surface.screenToWorld(e.clientX - r.left, e.clientY - r.top);
  };

  if (!layer) return null;
  const selectedStates = selection?.kind === "states" ? selection.ids : [];

  const addStateAt = (at: { x: number; y: number }) => {
    let id = "";
    edit("Add state", (l) => {
      id = addState(l, { name: "State", x: at.x - CARD_W / 2, y: at.y - CARD_H / 2 }).id;
    });
    setSelection({ kind: "states", ids: [id] });
    setRenaming(id);
  };

  const onCardPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || spacePan.held) return;
    e.stopPropagation();
    containerRef.current?.focus();
    const ids = e.shiftKey ? [...new Set([...selectedStates, id])] : selectedStates.includes(id) ? selectedStates : [id];
    setSelection({ kind: "states", ids });
    let last = toWorld(e);
    let moved = false;
    const key = `machine-move:${id}:${e.timeStamp}`;
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev);
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      if (!moved && Math.hypot(dx, dy) * camera.scale < 3) return;
      moved = true;
      last = p;
      edit("Move states", (l) => {
        for (const s of l.states) if (ids.includes(s.id)) (s.x += dx), (s.y += dy);
      }, key);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /** Drag from a node's handle to another node: a transition (from Entry: the start state). */
  const onHandlePointerDown = (e: React.PointerEvent, from: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setWire({ from, cursor: toWorld(e) });
    const move = (ev: PointerEvent) => setWire({ from, cursor: toWorld(ev) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWire(null);
      const target = nodeAt(layerNodes(layer), toWorld(ev));
      if (!target || target.kind === "entry" || target.kind === "any" || (target.id === from && from === ENTRY)) return;
      if (from === ENTRY) {
        if (target.kind === "state") edit("Set entry", (l) => void (l.entry = target.id));
        return;
      }
      let id = "";
      edit("Add transition", (l) => {
        id = addTransition(l, { from, to: target.id }).id;
      });
      setSelection({ kind: "transition", id });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** What ⇧A offers: an empty state, a state per pose of every character in this comp, a layer. */
  const addGroups = ((): BoardAddGroup[] => {
    const groups: BoardAddGroup[] = [{ heading: "States", items: [{ id: "state", label: "Empty state", keywords: "state node", note: "double-click" }] }];
    for (const t of doc.tracks)
      for (const c of t.clips) {
        if (c.frameId !== frame.id || c.kind !== "group" || !c.poses?.length) continue;
        for (const set of c.poses)
          groups.push({
            heading: `${c.name} · ${set.name}`,
            items: set.poses.map((p) => ({ id: `pose:${set.id}:${p.name}`, label: `${p.name}`, keywords: `${c.name} ${set.name} pose`, color: behaviorTint("machine") })),
          });
      }
    groups.push({ heading: "Machine", items: [{ id: "layer", label: "New layer", keywords: "layer parallel" }] });
    return groups;
  })();

  const openAdd = (clientX: number, clientY: number) => {
    const w = toWorld({ clientX, clientY });
    setAdding({ clientX, clientY, worldX: w.x, worldY: w.y });
  };

  const pickAdd = (id: string) => {
    const at = adding;
    setAdding(null);
    if (!at) return;
    if (id === "layer") {
      store.update("Add machine layer", (d) => {
        const m = d.frames.find((f) => f.id === frame.id)?.machines?.find((x) => x.id === machine.id);
        if (m) m.layers.push(newMachineLayer(`Layer ${m.layers.length + 1}`));
      });
      setLayerIdx(machine.layers.length);
      return;
    }
    if (id === "state") return addStateAt({ x: at.worldX, y: at.worldY });
    const m = /^pose:([^:]+):(.+)$/.exec(id);
    if (!m) return;
    let made = "";
    edit("Add pose state", (l) => {
      made = addState(l, { name: m[2]!, x: at.worldX - CARD_W / 2, y: at.worldY - CARD_H / 2, output: { kind: "pose", set: m[1]!, pose: m[2]! } }).id;
    });
    setSelection({ kind: "states", ids: [made] });
  };

  /** Drag on empty board: a marquee that picks every state it touches (⇧ adds). */
  const startMarquee = (e: React.PointerEvent) => {
    const a = toWorld(e);
    const additive = e.shiftKey;
    const before = selectedStates;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const b = toWorld(ev);
      if (!moved && Math.hypot(b.x - a.x, b.y - a.y) * camera.scale < 4) return;
      moved = true;
      setMarquee({ a, b });
      const box = { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
      const hit = nodes.filter((n) => n.kind === "state" && n.x < box.maxX && n.x + n.w > box.minX && n.y < box.maxY && n.y + n.h > box.minY).map((n) => n.id);
      setSelection({ kind: "states", ids: additive ? [...new Set([...before, ...hit])] : hit });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setMarquee(null);
      if (!moved && !additive) setSelection(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const deleteSelection = () => {
    if (selection?.kind === "states" && selection.ids.length) edit("Delete states", (l) => removeStates(l, selection.ids));
    else if (selection?.kind === "transition") edit("Delete transition", (l) => removeTransitions(l, [selection.id]));
    setSelection(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTypingTarget(e.target) || renaming) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Delete" || e.key === "Backspace" || (!mod && e.key.toLowerCase() === "x")) deleteSelection();
    else if (e.shiftKey && e.key.toLowerCase() === "a") {
      const p = lastPointer.current;
      const r = containerRef.current!.getBoundingClientRect();
      openAdd(p?.clientX ?? r.left + r.width / 2, p?.clientY ?? r.top + r.height / 2);
    } else if (!mod && e.key.toLowerCase() === "a" && !e.shiftKey) setSelection({ kind: "states", ids: layer.states.map((s) => s.id) });
    else if (mod && e.key.toLowerCase() === "d" && selectedStates.length) {
      let ids: string[] = [];
      edit("Duplicate states", (l) => void (ids = duplicateStates(l, selectedStates)));
      setSelection({ kind: "states", ids });
    } else if (!mod && e.key.toLowerCase() === "f") fitAll();
    else if (e.key === "Enter" && selectedStates.length === 1) setRenaming(selectedStates[0]!);
    else if (e.key.startsWith("Arrow") && selectedStates.length) {
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      edit("Nudge states", (l) => {
        for (const s of l.states) if (selectedStates.includes(s.id)) (s.x += dx), (s.y += dy);
      }, `machine-nudge:${selectedStates.join()}`);
    } else if (e.key === "Escape") {
      if (selection) setSelection(null);
      else onClose();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const entryNode = byId.get(ENTRY);
  const entryTarget = byId.get(layer.entry);
  // Pairs drawn side by side: A→B and B→A get opposite lanes.
  const laneOf = (t: MachineTransition) => (layer.transitions.some((o) => o.from === t.to && o.to === t.from && o.id !== t.id) ? 1 : 0);
  const liveTransition = liveLayer?.transition?.id ?? null;
  const { scale, tx, ty } = camera;

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          surface.onPanPointerDown(e);
          containerRef.current?.focus();
          if (e.button === 0 && !spacePan.held) startMarquee(e);
        }}
        onPointerMove={(e) => (lastPointer.current = { clientX: e.clientX, clientY: e.clientY })}
        onContextMenu={(e) => {
          e.preventDefault();
          openAdd(e.clientX, e.clientY);
        }}
        onDoubleClick={(e) => {
          if (e.target === containerRef.current || (e.target as HTMLElement).dataset.board) addStateAt(toWorld(e));
        }}
        className={cn("relative h-full w-full overflow-hidden bg-stage outline-none", surface.surfaceClassName, surface.panning ? "cursor-grabbing" : "cursor-default")}
        style={{
          backgroundImage: "radial-gradient(circle, color-mix(in srgb, var(--foreground) 22%, transparent) 1px, transparent 1px)",
          backgroundSize: `${24 * scale}px ${24 * scale}px`,
          backgroundPosition: `${tx}px ${ty}px`,
        }}
      >
        <div data-board="1" className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}>
          <svg className="pointer-events-none absolute overflow-visible" style={{ left: 0, top: 0, width: 1, height: 1 }}>
            <defs>
              <marker id="mach-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
              </marker>
            </defs>
            {entryNode && entryTarget && (
              <path d={arrowBetween(entryNode, entryTarget, 0).d} stroke="var(--muted-foreground)" strokeWidth={1.5} fill="none" markerEnd="url(#mach-arrow)" />
            )}
            {layer.transitions.map((t) => {
              const a = byId.get(t.from);
              const b = byId.get(t.to);
              if (!a || !b) return null;
              const { d } = arrowBetween(a, b, laneOf(t));
              const selected = selection?.kind === "transition" && selection.id === t.id;
              const lit = t.id === liveTransition;
              return (
                <g key={t.id}>
                  <path
                    d={d}
                    stroke="transparent"
                    strokeWidth={14}
                    fill="none"
                    className="pointer-events-auto cursor-pointer"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelection({ kind: "transition", id: t.id });
                    }}
                  />
                  <path
                    d={d}
                    stroke={selected || lit ? "var(--primary)" : "color-mix(in srgb, var(--foreground) 55%, transparent)"}
                    strokeWidth={selected || lit ? 2.5 : 1.5}
                    fill="none"
                    markerEnd="url(#mach-arrow)"
                  />
                </g>
              );
            })}
            {wire &&
              (() => {
                const a = byId.get(wire.from);
                if (!a) return null;
                return <line x1={a.x + a.w} y1={a.y + a.h / 2} x2={wire.cursor.x} y2={wire.cursor.y} stroke="var(--primary)" strokeWidth={2} strokeDasharray="6 4" />;
              })()}
          </svg>

          {/* Condition chips at each arrow's middle; the live one says why. */}
          {layer.transitions.map((t) => {
            const a = byId.get(t.from);
            const b = byId.get(t.to);
            if (!a || !b) return null;
            const { mid } = arrowBetween(a, b, laneOf(t));
            const lit = t.id === liveTransition;
            const words = lit ? whyOf(frame, t) : chipOf(frame, t);
            if (!words) return null;
            return (
              <div
                key={`chip-${t.id}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelection({ kind: "transition", id: t.id });
                }}
                className={cn(
                  "absolute max-w-48 -translate-x-1/2 -translate-y-1/2 cursor-pointer truncate whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px]",
                  lit ? "border-primary bg-primary text-primary-foreground" : "border-border bg-popover text-muted-foreground",
                )}
                style={{ left: mid.x, top: mid.y }}
              >
                {words}
              </div>
            );
          })}

          {marquee && (
            <div
              className="pointer-events-none absolute rounded-sm border border-primary/80 bg-primary/10"
              style={{ left: Math.min(marquee.a.x, marquee.b.x), top: Math.min(marquee.a.y, marquee.b.y), width: Math.abs(marquee.b.x - marquee.a.x), height: Math.abs(marquee.b.y - marquee.a.y) }}
            />
          )}
          {nodes.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              layer={layer}
              selected={selectedStates.includes(n.id)}
              live={liveLayer?.stateId === n.id}
              renaming={renaming === n.id}
              onPointerDown={(e) => (n.kind === "state" ? onCardPointerDown(e, n.id) : e.stopPropagation())}
              onHandle={(e) => onHandlePointerDown(e, n.id)}
              onRename={(name) => {
                setRenaming(null);
                edit("Rename state", (l) => renameState(l, n.id, name));
              }}
              onStartRename={() => setRenaming(n.id)}
            />
          ))}
        </div>

        {/* Layer chips — top left, the node board's scope-chip spot. */}
        <div className="absolute left-3 top-3 flex items-center gap-1">
          {machine.layers.map((l, i) => (
            <button
              key={l.id}
              type="button"
              onClick={() => setLayerIdx(i)}
              className={cn("material-glass rounded-full px-3 py-1 text-xs", i === layerIdx ? "font-medium" : "text-muted-foreground")}
            >
              {l.name}
            </button>
          ))}
          <Button
            variant="ghost"
            size="icon-sm"
            className="material-glass rounded-full"
            aria-label="Add layer"
            title="Add layer"
            onClick={() => {
              store.update("Add machine layer", (d) => {
                const m = d.frames.find((f) => f.id === frame.id)?.machines?.find((x) => x.id === machine.id);
                if (m) m.layers.push(newMachineLayer(`Layer ${m.layers.length + 1}`));
              });
              setLayerIdx(machine.layers.length);
            }}
          >
            <Plus />
          </Button>
        </div>

        {liveLayer?.cut && <LoopBanner layer={layer} reading={liveLayer} onShow={(ids) => setSelection({ kind: "states", ids })} />}

        {layer.states.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Button variant="secondary" size="sm" className="pointer-events-auto gap-1" onClick={() => addStateAt(surface.screenToWorld(surface.viewport().width / 2, surface.viewport().height / 2))}>
              <Plus className="size-3.5" /> State
            </Button>
          </div>
        )}
      </div>

      {minimap && nodes.length > 0 && (
        <BoardMinimap
          items={nodes.map((n) => ({ id: n.id, box: { minX: n.x, minY: n.y, maxX: n.x + n.w, maxY: n.y + n.h }, color: n.kind === "state" ? "color-mix(in srgb, var(--foreground) 55%, transparent)" : "var(--muted-foreground)", lit: liveLayer?.stateId === n.id }))}
          camera={camera}
          viewport={surface.viewport()}
          corner="br"
          onCenterOn={(x, y) => surface.setCamera((c) => ({ ...c, tx: surface.viewport().width / 2 - x * c.scale, ty: surface.viewport().height / 2 - y * c.scale }))}
          onHide={() => setMinimap(false)}
        />
      )}
      {adding && <BoardAddMenu anchor={adding} groups={addGroups} placeholder="Add a state…" onPick={pickAdd} onClose={() => setAdding(null)} />}
      <div className="pointer-events-none absolute bottom-3 left-3 text-[10px] text-muted-foreground/80">⇧A or right-click to add · drag to select · F to frame · X to delete</div>
      {live && <InputsStrip frame={frame} live={live} />}
      {selection?.kind === "transition" && (
        <TransitionPanel frame={frame} layer={layer} transitionId={selection.id} edit={edit} onClose={() => setSelection(null)} />
      )}
    </div>
  );
}

function NodeCard({
  node,
  layer,
  selected,
  live,
  renaming,
  onPointerDown,
  onHandle,
  onRename,
  onStartRename,
}: {
  node: BoardNode;
  layer: MachineLayer;
  selected: boolean;
  live: boolean;
  renaming: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onHandle: (e: React.PointerEvent) => void;
  onRename: (name: string) => void;
  onStartRename: () => void;
}) {
  const state = node.kind === "state" ? layer.states.find((s) => s.id === node.id) : undefined;
  const label = node.kind === "entry" ? "Entry" : node.kind === "any" ? "Any state" : node.kind === "exit" ? "Exit" : (state?.name ?? "");
  const pseudo = node.kind !== "state";
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!pseudo) onStartRename();
      }}
      className={cn(
        "group absolute flex items-center justify-center border text-xs shadow-sm transition-shadow select-none",
        pseudo ? "rounded-full border-dashed bg-muted/70 text-muted-foreground" : "cursor-grab rounded-lg bg-popover font-medium",
        node.kind === "any" && "border-solid bg-amber-500/10 text-foreground",
        selected && "border-primary ring-1 ring-primary",
        live && "border-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_35%,transparent),0_0_24px_color-mix(in_srgb,var(--primary)_45%,transparent)]",
      )}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
    >
      {renaming && state ? (
        <RenameInput initial={state.name} onCommit={onRename} className="w-[90%] bg-transparent text-center" />
      ) : (
        <span className="max-w-[85%] truncate">{label}</span>
      )}
      {state?.output.kind === "pose" && (
        <span className="absolute bottom-1 left-2 right-2 flex items-center gap-1 truncate text-[9px] text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: behaviorTint("machine") }} />
          shows {state.output.pose}
        </span>
      )}
      {live && !pseudo && <span className="absolute right-2 top-1.5 size-1.5 rounded-full bg-primary" />}
      {node.kind !== "exit" && (
        <span
          onPointerDown={onHandle}
          title={node.kind === "entry" ? "Drag to the start state" : "Drag to a state"}
          className="absolute -right-1.5 top-1/2 size-3 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-background bg-primary opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
    </div>
  );
}

/** The chip on a transition: its conditions in words (`Mood is Happy · Wave fires`). */
function chipOf(frame: Frame, t: MachineTransition): string {
  const words = t.conditions.map((c) => describeCondition(frame, c));
  if (t.exitTime !== undefined) words.push(`after ${fmtS(t.exitTime)}`);
  return words.join(" · ");
}

/** The why-badge on the transition that fired: `Mood became Happy`. */
function whyOf(frame: Frame, t: MachineTransition): string {
  const c = t.conditions[0];
  if (!c) return t.exitTime !== undefined ? `after ${fmtS(t.exitTime)}` : "at once";
  if (c.kind === "input") {
    const name = frame.inputs?.find((d) => d.id === c.input)?.name ?? c.input;
    return c.op === "==" && typeof c.value !== "boolean" ? `${name} became ${String(c.value)}` : describeCondition(frame, c);
  }
  return describeCondition(frame, c);
}

const fmtS = (ms: number) => `${Math.round(ms / 100) / 10} s`;

function LoopBanner({ layer, reading, onShow }: { layer: MachineLayer; reading: MachineLayerReading; onShow: (ids: string[]) => void }) {
  const a = reading.from?.name ?? "";
  const b = reading.stateName;
  const ids = [reading.from?.id, reading.stateId].filter((x): x is string => !!x);
  const count = layer.transitions.filter((t) => (ids.includes(t.from) || t.from === MACHINE_ANY) && ids.includes(t.to)).length;
  return (
    <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-500/50 bg-amber-500/15 px-3 py-1 text-xs">
      <span>
        Ping-pong between {a} and {b} — {count} transitions are true together
      </span>
      <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => onShow(ids)}>
        Show
      </button>
    </div>
  );
}

// ── Inputs: live controls that key the instance in scope ────────────────────

function InputsStrip({ frame, live }: { frame: Frame; live: LiveMachine }) {
  const store = useDocStore();
  const defs = (frame.inputs ?? []).filter((d) => d.type !== "layer");
  if (!defs.length) return null;
  const inst = live.instance;
  const key = (def: InputDef, value: string | number | boolean) => {
    if (!inst) return;
    store.update(`Key ${def.name}`, (d) => {
      for (const t of d.tracks) {
        const c = t.clips.find((x) => x.id === inst.id);
        if (c) writeChannel(c, inputPath(def.id), live.clockMs, value, { forceKey: true });
      }
    });
  };
  const hint = inst ? undefined : "Select an instance to key";
  return (
    <div className="material-glass absolute bottom-3 left-3 w-56 rounded-xl p-2 text-xs" title={hint}>
      <div className="mb-1 px-1 text-[11px] font-medium text-muted-foreground">Inputs</div>
      {defs.map((def) => {
        const v = live.values[def.id] ?? def.default;
        return (
          <div key={def.id} className="flex h-7 items-center gap-2 px-1">
            <span className="min-w-0 flex-1 truncate">{def.name}</span>
            {def.type === "bool" ? (
              <Switch disabled={!inst} checked={v === true} onCheckedChange={(on) => key(def, on)} />
            ) : def.type === "trigger" ? (
              <Button disabled={!inst} variant="secondary" size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={() => key(def, true)}>
                <Zap className="size-3" /> Fire
              </Button>
            ) : def.type === "enum" ? (
              <Select disabled={!inst} value={String(v)} onValueChange={(x) => key(def, x)}>
                <SelectTrigger className="h-6 w-24 text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(def.options ?? []).map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : def.type === "number" ? (
              <Input
                disabled={!inst}
                type="number"
                className="h-6 w-20 text-[11px]"
                defaultValue={typeof v === "number" ? v : 0}
                key={String(v)}
                onKeyDown={(e) => e.key === "Enter" && key(def, Number((e.target as HTMLInputElement).value))}
                onBlur={(e) => Number(e.target.value) !== v && key(def, Number(e.target.value))}
              />
            ) : (
              <span className="max-w-20 truncate text-muted-foreground">{String(v)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── The transition inspector: When · Blend · Wait for end ───────────────────

const OPS = ["==", "!=", "<", "<=", ">", ">="] as const;

function TransitionPanel({
  frame,
  layer,
  transitionId,
  edit,
  onClose,
}: {
  frame: Frame;
  layer: MachineLayer;
  transitionId: string;
  edit: (label: string, fn: (l: MachineLayer, f: Frame) => void, mergeKey?: string) => void;
  onClose: () => void;
}) {
  const t = layer.transitions.find((x) => x.id === transitionId);
  if (!t) return null;
  const nameOf = (id: string) => (id === MACHINE_ANY ? "Any state" : id === MACHINE_EXIT ? "Exit" : (layer.states.find((s) => s.id === id)?.name ?? "?"));
  const patch = (label: string, fn: (x: MachineTransition) => void, mergeKey?: string) =>
    edit(label, (l) => {
      const x = l.transitions.find((y) => y.id === transitionId);
      if (x) fn(x);
    }, mergeKey);
  const setCond = (i: number, c: MachineCondition) => patch("Edit condition", (x) => void (x.conditions[i] = c), `machine-cond:${transitionId}:${i}`);
  const inputs = frame.inputs ?? [];
  const firstInput = inputs.find((d) => d.type !== "trigger" && d.type !== "layer");
  const firstTrigger = inputs.find((d) => d.type === "trigger");

  return (
    <div className="material-glass absolute right-3 top-3 w-64 rounded-xl p-3 text-xs" onPointerDown={(e) => e.stopPropagation()}>
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">
          {nameOf(t.from)} → {nameOf(t.to)}
        </span>
        <button type="button" aria-label="Close" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">When</div>
      {t.conditions.map((c, i) => (
        <div key={i} className="mb-1 flex items-center gap-1">
          <ConditionEditor frame={frame} condition={c} onChange={(next) => setCond(i, next)} />
          <button type="button" aria-label="Remove condition" className="text-muted-foreground hover:text-foreground" onClick={() => patch("Remove condition", (x) => void x.conditions.splice(i, 1))}>
            <X className="size-3" />
          </button>
        </div>
      ))}
      <Select
        value=""
        onValueChange={(kind) =>
          patch("Add condition", (x) => {
            if (kind === "input" && firstInput) x.conditions.push({ kind: "input", input: firstInput.id, op: "==", value: firstInput.default });
            else if (kind === "trigger" && firstTrigger) x.conditions.push({ kind: "trigger", input: firstTrigger.id });
            else if (kind === "speaking") x.conditions.push({ kind: "speaking", layer: "Voice", is: true });
            else if (kind === "time") x.conditions.push({ kind: "time", op: ">=", ms: 1000 });
          })
        }
      >
        <SelectTrigger className="mb-2 h-6 w-full text-[11px]">
          <SelectValue placeholder="+ Condition" />
        </SelectTrigger>
        <SelectContent>
          {firstInput && <SelectItem value="input">Input</SelectItem>}
          {firstTrigger && <SelectItem value="trigger">Trigger</SelectItem>}
          <SelectItem value="speaking">Speaking</SelectItem>
          <SelectItem value="time">Time in state</SelectItem>
        </SelectContent>
      </Select>
      <MsRow label="Blend" value={t.durationMs} onChange={(ms) => patch("Blend", (x) => void (x.durationMs = ms ?? 0), `machine-blend:${transitionId}`)} />
      <MsRow
        label="Wait for end"
        value={t.exitTime}
        onChange={(ms) =>
          patch("Wait for end", (x) => {
            if (ms === undefined) delete x.exitTime;
            else x.exitTime = ms;
          }, `machine-exit:${transitionId}`)
        }
      />
    </div>
  );
}

function MsRow({ label, value, onChange }: { label: string; value: number | undefined; onChange: (ms: number | undefined) => void }) {
  return (
    <div className="flex h-7 items-center gap-2">
      <span className="flex-1 text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={0}
        className="h-6 w-20 text-[11px]"
        placeholder="—"
        key={String(value)}
        defaultValue={value ?? ""}
        onBlur={(e) => onChange(e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)))}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <span className="w-5 text-muted-foreground">ms</span>
    </div>
  );
}

function ConditionEditor({ frame, condition: c, onChange }: { frame: Frame; condition: MachineCondition; onChange: (c: MachineCondition) => void }) {
  const inputs = frame.inputs ?? [];
  const small = "h-6 text-[11px]";
  switch (c.kind) {
    case "input": {
      const def = inputs.find((d) => d.id === c.input);
      return (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <Select value={c.input} onValueChange={(id) => onChange({ ...c, input: id, value: inputs.find((d) => d.id === id)?.default ?? c.value })}>
            <SelectTrigger className={cn(small, "w-20")}>
              <SelectValue placeholder={c.input} />
            </SelectTrigger>
            <SelectContent>
              {inputs.filter((d) => d.type !== "trigger" && d.type !== "layer").map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={c.op}
            onValueChange={(v) => {
              const op = OPS.find((o) => o === v);
              if (op) onChange({ ...c, op });
            }}
          >
            <SelectTrigger className={cn(small, "w-12")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPS.map((o) => (
                <SelectItem key={o} value={o}>
                  {o === "==" ? "is" : o === "!=" ? "is not" : o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {def?.type === "bool" ? (
            <Switch checked={c.value === true} onCheckedChange={(v) => onChange({ ...c, value: v })} />
          ) : def?.type === "enum" ? (
            <Select value={String(c.value)} onValueChange={(v) => onChange({ ...c, value: v })}>
              <SelectTrigger className={cn(small, "min-w-0 flex-1")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(def.options ?? []).map((o) => (
                  <SelectItem key={o} value={o}>
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              className={cn(small, "min-w-0 flex-1")}
              key={String(c.value)}
              defaultValue={String(c.value)}
              onBlur={(e) => onChange({ ...c, value: def?.type === "number" ? Number(e.target.value) : e.target.value })}
            />
          )}
        </div>
      );
    }
    case "trigger":
      return (
        <Select value={c.input} onValueChange={(id) => onChange({ ...c, input: id })}>
          <SelectTrigger className={cn(small, "min-w-0 flex-1")}>
            <SelectValue placeholder={c.input} />
          </SelectTrigger>
          <SelectContent>
            {inputs.filter((d) => d.type === "trigger").map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name} fires
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "speaking":
      return (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <Input className={cn(small, "min-w-0 flex-1")} key={c.layer} defaultValue={c.layer} onBlur={(e) => onChange({ ...c, layer: e.target.value })} title="The voice layer" />
          <Select value={c.is ? "on" : "off"} onValueChange={(v) => onChange({ ...c, is: v === "on" })}>
            <SelectTrigger className={cn(small, "w-24")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="on">Speaking</SelectItem>
              <SelectItem value="off">Silent</SelectItem>
            </SelectContent>
          </Select>
        </div>
      );
    case "time":
      return (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <span className="whitespace-nowrap text-muted-foreground">Time in state &gt;</span>
          <Input
            type="number"
            min={0}
            step={0.1}
            className={cn(small, "w-14")}
            key={String(c.ms)}
            defaultValue={c.ms / 1000}
            onBlur={(e) => onChange({ ...c, op: ">=", ms: Math.max(0, Number(e.target.value)) * 1000 })}
          />
          <span className="text-muted-foreground">s</span>
        </div>
      );
  }
}

// ── Code: the machine as one call; Run rebuilds it ───────────────────────────

function MachineCodeTab({ frame, machine }: { frame: Frame; machine: Machine }) {
  const store = useDocStore();
  // The machine printed by its reifier — the same code `script.reify {machine}` and Copy as code give.
  const [printed, setPrinted] = React.useState("");
  React.useEffect(() => {
    let live = true;
    reify(store.getState(), { part: "machine", frameId: frame.id, id: machine.id }).then(
      (r) => live && setPrinted(r.code),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [store, frame, machine]);
  const [code, setCode] = React.useState(printed);
  const dirty = code !== printed;
  const [running, setRunning] = React.useState(false);
  const lastPrinted = React.useRef(printed);
  React.useEffect(() => {
    // Follow the board while the text is untouched.
    if (code === lastPrinted.current) setCode(printed);
    lastPrinted.current = printed;
  }, [printed, code]);

  const [error, setError] = React.useState<{ line: number; message: string } | null>(null);
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const [{ scriptHost, panelRunContext, runReport }, { agentApi }] = await Promise.all([import("../scripts/host"), import("../agent/runner")]);
      const record = await scriptHost(agentApi).run({ code, path: `${machine.name}.machine.js`, repl: false, frameId: frame.id, ctx: panelRunContext(store, `${machine.name}.machine.js`) });
      const report = runReport(record) as { error?: { message: string; line?: number } };
      if (report.error) {
        if (report.error.line) setError({ line: report.error.line, message: report.error.message });
        else toast.error(report.error.message);
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <React.Suspense fallback={null}>
          <MachineCodeEditor value={code} onChange={setCode} onRun={() => void run()} error={error} />
        </React.Suspense>
      </div>
      <div className="flex items-center gap-2 border-t px-3 py-2 text-xs">
        <Button size="sm" className="h-7" disabled={running} onClick={() => void run()}>
          Run
        </Button>
        <span className="text-muted-foreground">Edits here rewrite the board</span>
        {dirty && (
          <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setCode(printed)}>
            Revert
          </button>
        )}
      </div>
    </div>
  );
}
