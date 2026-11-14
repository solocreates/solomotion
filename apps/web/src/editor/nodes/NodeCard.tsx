"use client";

import * as React from "react";
import {
  CATEGORY_META,
  MAIN_SOCKET_KEY,
  VARIABLES_NODE_TYPE,
  VARIABLES_PARAM_KEY,
  parseSelectedVariables,
  serializeSelectedVariables,
  type Clip,
  type GraphNode,
  type NodeParam,
  type NodeTypeDef,
  type NodeValue,
  type OptionSpec,
  type PickFilter,
  propertyPickKey,
  pickKey,
  pickProvider,
  type SelectedVariable,
  type SocketSpec,
  type VariableWriteConflict,
  type Variable,
  EXPRESSION_NODE_TYPE,
  EXPRESSION_PARAM_KEY,
} from "@solomotion/core";
import { ChevronDown, ChevronRight, ChevronUp, Link2, Unlink, Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";
import { KeyControl } from "../inspector/keyframe-controls";
import { LayerRefField, ObjectField } from "../pick/ObjectField";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { ColorInput } from "@/components/ui/color-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HEADER_H, NODE_WIDTH, OPTION_H, ROW_H, SOCKET_R, type NodeLayout } from "./board-geometry";
import { NodePropertyField } from "./NodePropertyField";
import { AddVariableControl, NodeVariableRow } from "./VariablesNodeRows";
import { NodeExpressionField } from "./NodeExpressionField";

/**
 * ONE node card. Pure presentation driven by the type registry + the node's
 * stored params: header tinted by category, output rows (right sockets, live
 * value readout), input rows (left sockets with an inline editor when
 * unconnected), then the option controls. Every interaction is delegated up to
 * the board so this stays a dumb, fast render.
 */

export interface SocketRefDir {
  dir: "in" | "out";
  key: string;
}

export interface NodeCardProps {
  node: GraphNode;
  def: NodeTypeDef;
  /** RESOLVED sockets (projection nodes vary per target) — the board resolves them. */
  inputs: SocketSpec[];
  outputs: SocketSpec[];
  layout: NodeLayout;
  selected: boolean;
  cyclic: boolean;
  /**
   * Input sockets that CANNOT be wired, and why — today, a Variables row another
   * graph already writes. The socket paints itself held and says who has it, so
   * the rule is visible before the drag rather than explained after it.
   */
  blockedInputs?: Map<string, VariableWriteConflict>;
  /** Input socket keys that currently have an incoming edge (hide inline editor). */
  connectedInputs: Set<string>;
  /** This node's evaluated output values, for the live readout. */
  values?: Record<string, NodeValue>;
  /** A socket the board wants highlighted as a valid drop target. */
  highlight?: SocketRefDir | null;
  /** The owning layer clip — present for layer-scoped graphs; enables the
   *  reused keyframe diamond beside numeric values. Null on the global board. */
  ownerClip?: Clip | null;
  /** Projection nodes can collapse to just the active rows; show an expand
   *  chevron when true. `expanded` reveals every property. */
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** The layer a projection node targets — its rows edit THIS clip's real values. */
  targetClip?: Clip | null;
  /** Live variable objects the Variables node exposes (selected), keyed by socket
   *  = variable id. Present only for `input.variables`; undefined elsewhere. */
  nodeVariables?: Variable[];
  onNodePointerDown: (e: React.PointerEvent, id: string) => void;
  onSocketPointerDown: (e: React.PointerEvent, id: string, dir: "in" | "out", key: string) => void;
  onSocketPointerUp: (e: React.PointerEvent, id: string, dir: "in" | "out", key: string) => void;
  onParam: (id: string, key: string, value: NodeParam, mergeKey?: string) => void;
  /** Unwire an input socket — the Layer picker uses it to unlink from a hub. */
  onDisconnectInput?: (id: string, key: string) => void;
}

function formatValue(v: NodeValue | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "object") return `${v.x.toFixed(1)}, ${v.y.toFixed(1)}`;
  return v;
}

function Socket({
  dir,
  type,
  filled,
  highlighted,
  held,
  onPointerDown,
  onPointerUp,
}: {
  dir: "in" | "out";
  type: string;
  filled: boolean;
  highlighted: boolean;
  /** Why this socket is not free — shown on hover, and drawn as a hollow ring. */
  held?: string;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
}) {
  return (
    <span
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      title={held}
      data-socket
      className="group/socket absolute flex -translate-y-1/2 cursor-crosshair touch-none items-center justify-center"
      // Generous transparent hit area so sockets stay grabbable when zoomed out.
      style={{
        [dir === "out" ? "right" : "left"]: -SOCKET_R - 9,
        top: "50%",
        width: (SOCKET_R + 9) * 2,
        height: (SOCKET_R + 9) * 2,
      }}
    >
      <span
        className={cn(
          "rounded-full border-2 transition-transform group-hover/socket:scale-150",
          highlighted && "scale-150",
          // Held by another graph: the ring is dashed and dimmed. Still grabbable
          // — the drop asks whether to take it over, which is more useful than a
          // socket that ignores the pointer.
          held && "border-dashed opacity-45",
        )}
        style={{
          width: SOCKET_R * 2,
          height: SOCKET_R * 2,
          // Always show the ring so grab points are obvious; fill when wired/valid.
          borderColor: socketColor(type),
          backgroundColor: filled || highlighted ? socketColor(type) : "var(--card)",
          boxShadow: highlighted ? `0 0 0 3px color-mix(in srgb, ${socketColor(type)} 45%, transparent)` : undefined,
        }}
      />
    </span>
  );
}

/** Socket fill by data type — a quiet Blender-ish colour language. */
function socketColor(type: string): string {
  switch (type) {
    case "float":
      return "#9aa4b2";
    case "vec2":
      return "#8a5fb0";
    case "color":
      return "#c9a13b";
    case "bool":
      return "#7d8794";
    case "string":
      return "#5fb04f";
    default:
      return "#c0c6cf";
  }
}

function InlineInput({
  spec,
  value,
  onChange,
}: {
  spec: SocketSpec;
  value: NodeParam | undefined;
  onChange: (v: NodeParam, mergeKey: string) => void;
}) {
  const mk = `param-${spec.key}`;
  if (spec.type === "float") {
    return (
      <NumberInput
        value={typeof value === "number" ? value : 0}
        onChange={(v) => onChange(v, mk)}
        step={0.1}
        precision={2}
        className="h-5 w-16 text-[11px]"
      />
    );
  }
  if (spec.type === "bool") {
    return <Switch checked={Boolean(value)} onCheckedChange={(v) => onChange(v, mk)} />;
  }
  if (spec.type === "color") {
    return (
      <ColorInput
        value={typeof value === "string" ? value : "#ffffff"}
        onChange={(c) => onChange(c, mk)}
        className="h-5 w-6"
      />
    );
  }
  if (spec.type === "string") {
    return (
      <Input
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value, mk)}
        className="h-5 w-20 text-[11px]"
      />
    );
  }
  return null;
}

/**
 * The projection node's target control — one representation of "which layer".
 * Sits on the main "Layer" socket row: the object field (list + aim) when free,
 * and a locked chip with an Unlink action when a hub feeds the Layer input (the
 * WIRE owns the target). Picking a layer or wiring the socket are the same
 * concept, so there's never a second, conflicting control.
 */
function LayerPicker({
  value,
  filter,
  linkedName,
  linked,
  onPick,
  onUnlink,
}: {
  value: string;
  filter: PickFilter;
  linkedName: string | undefined;
  linked: boolean;
  onPick: (v: string) => void;
  onUnlink: () => void;
}) {
  if (linked) {
    return (
      <div
        className="ml-auto flex min-w-0 items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Link2 className="size-2.5 shrink-0 text-primary" />
        <span className="truncate font-medium">{linkedName ?? "Linked layer"}</span>
        <button
          type="button"
          title="Unlink from hub"
          onClick={onUnlink}
          className="-mr-0.5 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          <Unlink className="size-2.5" />
        </button>
      </div>
    );
  }
  return (
    <div className="ml-auto min-w-0 max-w-[148px] flex-1">
      <LayerRefField size="sm" filter={filter} value={value || null} none="No layer" onChange={(id) => onPick(id ?? "")} />
    </div>
  );
}

/** A reference option below the sockets — a layer, or a value on the layer
 *  another option names (`pickOn`). */
function PickOption({ opt, node, onParam }: { opt: OptionSpec & { pick: PickFilter }; node: GraphNode; onParam: NodeCardProps["onParam"] }) {
  const raw = node.params[opt.key];
  const val = typeof raw === "string" ? raw : "";
  const on = opt.pickOn ? node.params[opt.pickOn] : undefined;
  const host = typeof on === "string" ? on : "";
  const property = opt.pick.kinds.includes("property");
  const filter = React.useMemo<PickFilter>(() => (property ? { ...opt.pick, ofLayers: host ? [host] : [] } : opt.pick), [opt.pick, property, host]);
  return (
    <div className="flex items-center justify-between gap-1.5 text-[11px] text-muted-foreground">
      <span className="truncate">{opt.label}</span>
      <div className="min-w-0 max-w-[148px] flex-1">
        {property ? (
          <ObjectField
            size="sm"
            filter={filter}
            noun="property"
            value={host && val ? propertyPickKey(host, val) : null}
            missing={val || undefined}
            disabled={!host}
            onChange={(c) => c.path && onParam(node.id, opt.key, c.path)}
          />
        ) : opt.pick.kinds.every((k) => k === "layer") ? (
          <LayerRefField size="sm" filter={filter} value={val || null} none="No layer" onChange={(id) => onParam(node.id, opt.key, id ?? "")} />
        ) : (
          // Any other family (a tracker) stores its bare id; the key is the
          // provider's prefix on it, so a new pickable kind needs no case here.
          <ObjectField
            size="sm"
            filter={filter}
            value={val ? pickKey(pickProvider(opt.pick.kinds[0]!)?.prefix ?? opt.pick.kinds[0]!, val) : null}
            missing={val || undefined}
            onChange={(c) => onParam(node.id, opt.key, c.id)}
          />
        )}
      </div>
    </div>
  );
}

export const NodeCard = React.memo(function NodeCard(props: NodeCardProps) {
  const { node, def, inputs, outputs, layout, selected, cyclic, connectedInputs, blockedInputs, values, highlight, ownerClip, onParam } = props;
  /** "Who holds this input", in the words the socket and the row both use. */
  const heldReason = (key: string) => {
    const held = blockedInputs?.get(key);
    return held ? `“${held.variableName}” is driven by ${held.graphName} — drop a wire here to take it over` : undefined;
  };
  const accent = CATEGORY_META[def.category].color;
  // The Layer row's picker comes from the node's own `target` option: what it
  // may point at is data on the node type, not a list the board assembles.
  const targetPick = def.options?.find((o) => o.key === "target")?.pick;

  // Unified rows: a key on BOTH sides is one combined row (in-dot left, out-dot
  // right); the rest stack (outputs-only on top, inputs-only below) — matching
  // `nodeLayout`'s order so the absolute wire endpoints line up with the DOM.
  const inKeys = new Set(inputs.map((s) => s.key));
  const outKeys = new Set(outputs.map((s) => s.key));
  // The main "Layer" socket is rendered as ONE dedicated top row (role picks its
  // side), so it's held out of the generic in/out/combined machinery below.
  const isSelf = (k: string) => k === MAIN_SOCKET_KEY;
  const mainIn = inputs.find((s) => isSelf(s.key));
  const mainOut = outputs.find((s) => isSelf(s.key));
  const hasMain = Boolean(mainIn || mainOut);
  const outOnly = outputs.filter((o) => !isSelf(o.key) && !inKeys.has(o.key));
  const combined = outputs
    .filter((o) => !isSelf(o.key) && inKeys.has(o.key))
    .map((o) => ({ out: o, in: inputs.find((i) => i.key === o.key)! }));
  const inOnly = inputs.filter((i) => !isSelf(i.key) && !outKeys.has(i.key));

  // The keyframe diamond for one numeric value — the SAME control the inspector
  // uses, so node values keyframe/record/reset exactly like every other property.
  const keyCtl = (key: string, val: NodeValue | undefined) =>
    ownerClip ? (
      <KeyControl clip={ownerClip} property={`node.${node.id}.${key}`} currentValue={() => (typeof val === "number" ? val : 0)} />
    ) : null;

  // The Variables node projects `doc.variables`: each output row is a reusable
  // value field + keyframe cluster, plus an iterator to add/remove which ones.
  const isVarsNode = def.type === VARIABLES_NODE_TYPE;
  const varById = React.useMemo(() => {
    const m = new Map<string, Variable>();
    for (const v of props.nodeVariables ?? []) m.set(v.id, v);
    return m;
  }, [props.nodeVariables]);
  const selectedIds = React.useMemo(
    () => new Set(parseSelectedVariables(node).map((s) => s.id)),
    [node],
  );
  const setSelection = (list: SelectedVariable[]) =>
    onParam(node.id, VARIABLES_PARAM_KEY, serializeSelectedVariables(list));
  const addVar = (v: SelectedVariable) => setSelection([...parseSelectedVariables(node), v]);
  const removeVar = (id: string) => setSelection(parseSelectedVariables(node).filter((s) => s.id !== id));

  return (
    <div
      data-node-id={node.id}
      onPointerDown={(e) => props.onNodePointerDown(e, node.id)}
      className={cn(
        "absolute select-none rounded-xl border bg-card text-card-foreground shadow-lg",
        selected ? "border-primary ring-1 ring-primary" : "border-border/80",
        cyclic && "border-destructive ring-1 ring-destructive",
      )}
      style={{ left: node.x, top: node.y, width: NODE_WIDTH }}
    >
      {/* Header */}
      <div
        className="flex h-[30px] items-center gap-1.5 rounded-t-xl px-2.5 text-[12px] font-medium"
        style={{ backgroundColor: `${accent}22`, borderBottom: `1px solid ${accent}55` }}
      >
        <span className="size-2 rounded-full" style={{ backgroundColor: accent }} />
        <span className="truncate">{def.title}</span>
        {props.expandable && (
          <button
            type="button"
            className="ml-auto -mr-1 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            title={props.expanded ? "Show only active properties" : "Show all properties"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={props.onToggleExpand}
          >
            {props.expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        )}
      </div>

      {/* The one "Layer" row — a single dot on the side its role dictates (a
          source broadcasts on the RIGHT, an operator receives on the LEFT), with
          the layer picker in between. One handle, one direction: no more the same
          "Layer" on both sides. */}
      {hasMain && targetPick && (
        <div className="group/row relative flex items-center gap-1.5 px-2.5 text-[11px]" style={{ height: ROW_H, marginTop: 6 }}>
          {mainIn && (
            <Socket
              dir="in"
              type={mainIn.type}
              filled={connectedInputs.has(MAIN_SOCKET_KEY)}
              highlighted={highlight?.dir === "in" && highlight.key === MAIN_SOCKET_KEY}
              onPointerDown={(e) => props.onSocketPointerDown(e, node.id, "in", MAIN_SOCKET_KEY)}
              onPointerUp={(e) => props.onSocketPointerUp(e, node.id, "in", MAIN_SOCKET_KEY)}
            />
          )}
          <span className="text-muted-foreground">Layer</span>
          <LayerPicker
            value={typeof node.params.target === "string" ? node.params.target : ""}
            filter={targetPick}
            linkedName={props.targetClip?.name}
            linked={connectedInputs.has(MAIN_SOCKET_KEY)}
            onPick={(v) => onParam(node.id, "target", v)}
            onUnlink={() => props.onDisconnectInput?.(node.id, MAIN_SOCKET_KEY)}
          />
          {mainOut && (
            <Socket
              dir="out"
              type={mainOut.type}
              filled
              highlighted={highlight?.dir === "out" && highlight.key === MAIN_SOCKET_KEY}
              onPointerDown={(e) => props.onSocketPointerDown(e, node.id, "out", MAIN_SOCKET_KEY)}
              onPointerUp={(e) => props.onSocketPointerUp(e, node.id, "out", MAIN_SOCKET_KEY)}
            />
          )}
        </div>
      )}

      {/* Output-only rows (right socket + live readout). The Variables node makes
          each row a reusable value field + keyframe cluster reading its variable. */}
      {outOnly.map((o, i) => {
        const variable = isVarsNode ? varById.get(o.key) : undefined;
        return (
          <div
            key={`o:${o.key}`}
            className={cn(
              "relative flex items-center gap-1.5 px-2.5 text-[11px]",
              variable ? "group/row" : "justify-end",
            )}
            style={{ height: ROW_H, marginTop: !hasMain && i === 0 ? 6 : 0 }}
          >
            {variable ? (
              <>
                <NodeVariableRow variable={variable} onRemove={() => removeVar(variable.id)} />
                {/* Held by another graph — said on the row too, so you can see it
                    without hovering a 5px socket. */}
                {blockedInputs?.has(o.key) && (
                  <Waypoints
                    className="size-3 shrink-0 text-muted-foreground/60"
                    aria-label={heldReason(o.key)}
                  />
                )}
              </>
            ) : (
              <>
                {values && o.path && (
                  <span className="truncate text-[10px] tabular-nums text-muted-foreground">{formatValue(values[o.key])}</span>
                )}
                <span className="text-muted-foreground">{o.label}</span>
              </>
            )}
            <Socket
              dir="out"
              type={o.type}
              filled
              highlighted={highlight?.dir === "out" && highlight.key === o.key}
              onPointerDown={(e) => props.onSocketPointerDown(e, node.id, "out", o.key)}
              onPointerUp={(e) => props.onSocketPointerUp(e, node.id, "out", o.key)}
            />
          </div>
        );
      })}

      {/* Combined rows — one field, driven from the LEFT socket, read from the
          RIGHT. The middle is the field's editor (universal): the "Layer" main
          socket carries the layer PICKER; a layer property is its sidebar field;
          any other unconnected input is its inline literal editor; a wired input
          shows the incoming value. `group/row` reveals the keyframe diamond on
          hover so it's grabbable, not a blind click into empty space. */}
      {combined.map(({ out: o, in: inp }, i) => {
        const wired = connectedInputs.has(inp.key);
        return (
          <div
            key={`c:${o.key}`}
            className="group/row relative flex items-center gap-1.5 px-2.5 text-[11px]"
            style={{ height: ROW_H, marginTop: !hasMain && outOnly.length === 0 && i === 0 ? 6 : 0 }}
          >
            <Socket
              dir="in"
              type={inp.type}
              filled={wired}
              highlighted={highlight?.dir === "in" && highlight.key === inp.key}
              held={heldReason(inp.key)}
              onPointerDown={(e) => props.onSocketPointerDown(e, node.id, "in", inp.key)}
              onPointerUp={(e) => props.onSocketPointerUp(e, node.id, "in", inp.key)}
            />
            <span className="text-muted-foreground">{o.label}</span>
            {wired ? (
              values ? (
                <span className="ml-auto truncate text-[10px] tabular-nums text-muted-foreground">
                  {formatValue(values[o.key])}
                </span>
              ) : null
            ) : o.path && props.targetClip ? (
              <NodePropertyField clip={props.targetClip} path={o.path} />
            ) : (
              <div className="ml-auto flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
                <InlineInput spec={inp} value={node.params[inp.key]} onChange={(v, mk) => onParam(node.id, inp.key, v, mk)} />
                {inp.type === "float" && keyCtl(inp.key, node.params[inp.key])}
              </div>
            )}
            <Socket
              dir="out"
              type={o.type}
              filled
              highlighted={highlight?.dir === "out" && highlight.key === o.key}
              onPointerDown={(e) => props.onSocketPointerDown(e, node.id, "out", o.key)}
              onPointerUp={(e) => props.onSocketPointerUp(e, node.id, "out", o.key)}
            />
          </div>
        );
      })}

      {/* Input-only rows (left socket + inline literal editor) */}
      {inOnly.map((inp) => {
        const wired = connectedInputs.has(inp.key);
        return (
          <div
            key={`i:${inp.key}`}
            className="group/row relative flex items-center gap-1.5 px-2.5 text-[11px]"
            style={{ height: ROW_H }}
          >
            <Socket
              dir="in"
              type={inp.type}
              filled={wired}
              highlighted={highlight?.dir === "in" && highlight.key === inp.key}
              held={heldReason(inp.key)}
              onPointerDown={(e) => props.onSocketPointerDown(e, node.id, "in", inp.key)}
              onPointerUp={(e) => props.onSocketPointerUp(e, node.id, "in", inp.key)}
            />
            <span className="text-muted-foreground">{inp.label}</span>
            {!wired && (
              <div className="ml-auto flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
                <InlineInput
                  spec={inp}
                  value={node.params[inp.key]}
                  onChange={(v, mk) => onParam(node.id, inp.key, v, mk)}
                />
                {inp.type === "float" && keyCtl(inp.key, node.params[inp.key])}
              </div>
            )}
          </div>
        );
      })}

      {/* The Variables node's iterator — add another document variable to read. */}
      {isVarsNode && <AddVariableControl selectedIds={selectedIds} onAdd={addVar} />}

      {/* Options — the `target` option is rendered up on the Layer socket row,
          so it's excluded here (leaving math ops, toggles, colours, …). */}
      {(def.options?.filter((o) => o.key !== "target").length ?? 0) > 0 && (
        <div className="flex flex-col gap-1 px-2.5 pb-2 pt-1" onPointerDown={(e) => e.stopPropagation()}>
          {def.options!.map((opt) => {
            if (opt.key === "target") return null;
            const val = node.params[opt.key] ?? opt.default;
            // The Expression node's source gets the real editor, not a text box.
            if (node.type === EXPRESSION_NODE_TYPE && opt.key === EXPRESSION_PARAM_KEY) {
              return (
                <NodeExpressionField
                  key={opt.key}
                  nodeId={node.id}
                  source={typeof val === "string" ? val : ""}
                  onChange={(next) => onParam(node.id, opt.key, next, `expr-${node.id}`)}
                />
              );
            }
            if (opt.pick) return <PickOption key={opt.key} opt={{ ...opt, pick: opt.pick }} node={node} onParam={onParam} />;
            if (opt.kind === "enum") {
              return (
                <Select
                  key={opt.key}
                  value={String(val)}
                  onValueChange={(v) => onParam(node.id, opt.key, v)}
                >
                  <SelectTrigger className="h-6 text-[11px]" style={{ minHeight: OPTION_H - 6 }}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {opt.choices?.map((c) => (
                      <SelectItem key={c.value} value={c.value} className="text-[12px]">
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              );
            }
            if (opt.kind === "bool") {
              return (
                <label key={opt.key} className="flex items-center justify-between text-[11px] text-muted-foreground">
                  {opt.label}
                  <Switch checked={Boolean(val)} onCheckedChange={(v) => onParam(node.id, opt.key, v)} />
                </label>
              );
            }
            if (opt.kind === "float") {
              return (
                <div key={opt.key} className="group/row flex items-center justify-between gap-1 text-[11px] text-muted-foreground">
                  <span className="truncate">{opt.label}</span>
                  <div className="flex items-center gap-1">
                    <NumberInput
                      value={typeof val === "number" ? val : 0}
                      onChange={(v) => onParam(node.id, opt.key, v, `opt-${opt.key}`)}
                      min={opt.min}
                      max={opt.max}
                      step={opt.step ?? 0.1}
                      className="h-5 w-16 text-[11px]"
                    />
                    {keyCtl(opt.key, val)}
                  </div>
                </div>
              );
            }
            if (opt.kind === "color") {
              return (
                <label key={opt.key} className="flex items-center justify-between text-[11px] text-muted-foreground">
                  {opt.label}
                  <ColorInput
                    value={typeof val === "string" ? val : "#ffffff"}
                    onChange={(c) => onParam(node.id, opt.key, c)}
                    className="h-5 w-7"
                  />
                </label>
              );
            }
            return (
              <Input
                key={opt.key}
                value={typeof val === "string" ? val : ""}
                onChange={(e) => onParam(node.id, opt.key, e.target.value)}
                placeholder={opt.label}
                className="h-6 text-[11px]"
              />
            );
          })}
        </div>
      )}

      {/* A second expand affordance at the FOOT of the card — the header chevron
          is easy to miss once a card is tall, so "All fields / Less" lives here
          too, full-width and labelled. */}
      {props.expandable && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={props.onToggleExpand}
          className="flex w-full items-center justify-center gap-1 rounded-b-xl border-t border-border/50 py-1 text-[10px] font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        >
          {props.expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          {props.expanded ? "Less" : "All fields"}
        </button>
      )}
    </div>
  );
});
