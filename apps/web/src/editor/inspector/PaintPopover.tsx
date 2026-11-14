"use client";

import * as React from "react";
import {
  createId,
  gradientColorAt,
  gradientPaint,
  isGradientPaint,
  locateClip,
  mediaPaint,
  paintColors,
  parseHexColor,
  patternFromDesign,
  patternPaint,
  resolveColor,
  resolvePaint,
  clearPaintOverride,
  clearPaintOverrides,
  paintOverrides,
  propertyDef,
  type PaintOverride,
  type GradientType,
  type ImageClip,
  type KeyframeValue,
    type MediaFit,
  type MediaPaint,
  type Paint,
  type PathClip,
  type PatternDesign,
  type PatternPaint,
  type PatternSpec,
  type ShapeClip,
  type TextClip,
  type VideoClip,
} from "@solomotion/core";
import { AlignHorizontalSpaceAround, ChevronRight, FlipHorizontal2, Link2, Link2Off, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { NumberInput } from "@/components/ui/number-input";
import { PICKER_MAX_HEIGHT, PICKER_PLACEMENT, PICKER_WIDTH, PickerPanel } from "@/components/ui/color-picker";
import { FieldBindingProvider, type FieldBindingRender } from "@/components/ui/field-binding";
import {
  Popover,
  PopoverAnchor,
  PopoverBody,
  PopoverContent,
  PopoverFooter,
  PopoverHeader,
} from "@/components/ui/popover";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { AssetThumb } from "../assets/AssetThumb";
import { BLEND_GROUPS } from "./blend-modes";
import { DocColorInput } from "./DocColorInput";
import { useColorVariableBinding } from "./color-variable-binding";
import { PropertyBindingMenu } from "./property-binding";
import { MediaPickerDialog } from "./MediaPickerDialog";
import type { PaintCarrierDraft, PaintHost } from "./paint-host";
import { PatternStudio } from "../paint/PatternStudio";
import { GradientGeometry } from "../paint/GradientGeometry";
import { GradientRail, RAIL_HINT } from "../paint/GradientRail";
import { PaintPreview } from "../paint/PaintPreview";
import { PaintLibrary } from "../paint/PaintLibrary";
import { shelfKindOf } from "../paint/paint-kind";
import { pushRecentPaint } from "../paint/recent-paints";
import { variablePaint } from "@solomotion/core";
import { isTypingTarget } from "../input/typing-target";

/**
 * The paint editor popover — opens straight onto the picker (no tab hop). A
 * compact Solid / Linear / Radial switch sits at the top; below it a solid gets
 * the full colour picker inline, a gradient gets the ramp + a picker for the
 * selected stop. A per-paint Blend row sits at the bottom (stroke paints also
 * show cap / join / align). Every value write goes through `commitProperty`
 * against the entry's id-scoped path (`fill.<id>.…`), so record mode keys it.
 */

/** Any layer that carries the unified fills/strokes lists (Figma: every visual layer). */
export type PaintableClip = ShapeClip | PathClip | TextClip | ImageClip | VideoClip;
type PaintKind = "fill" | "stroke";

const TYPE_LABEL: Record<Paint["type"], string> = {
  solid: "Solid",
  variable: "Fill style",
  linear: "Linear",
  radial: "Radial",
  angular: "Angular",
  media: "Image",
  pattern: "Pattern",
};

/** The four top-level tabs (Figma). Gradient collapses the three ramp types. */
const PAINT_TABS = ["solid", "gradient", "pattern", "media"] as const;
type PaintTab = (typeof PAINT_TABS)[number];
const TAB_LABEL: Record<PaintTab, string> = { solid: "Solid", gradient: "Gradient", pattern: "Pattern", media: "Media" };

/** Which tab a paint lives under (every gradient type → the one Gradient tab). */
function tabOfPaint(type: Paint["type"]): PaintTab {
  if (type === "solid") return "solid";
  if (type === "pattern") return "pattern";
  if (type === "media") return "media";
  return "gradient";
}

/** The gradient axis angle (deg, 0 = →) from its two handle points. */
function gradientAngleDeg(paint: Extract<Paint, { type: GradientType }>): number {
  return (Math.atan2(paint.end.y - paint.start.y, paint.end.x - paint.start.x) * 180) / Math.PI;
}

/** The primary color a paint carries (feeds solid↔other conversions). */
function primaryColor(paint: Paint): string {
  if (paint.type === "solid") return paint.color;
  if (isGradientPaint(paint)) return [...paint.stops].sort((a, b) => a.offset - b.offset)[0]!.color;
  return paintColors(paint)[0] ?? "#B0B4BB";
}

/** Convert a paint to another type, keeping id/opacity/blend and (where it makes
 *  sense) geometry/stops. Media/pattern convert to/from the color world too. */
function convertPaint(paint: Paint, type: Paint["type"]): Paint {
  if (type === paint.type) return paint;
  const base = { id: paint.id, enabled: paint.enabled, opacity: paint.opacity, blendMode: paint.blendMode };
  // Binding to a fill style is CHOOSING one, which the library rail does — not
  // a type conversion, because there is no "which variable" for a switch to
  // guess. Converting away from one is ordinary: by then the picker has already
  // resolved the reference to the look it pointed at.
  if (type === "variable") return paint;
  if (type === "solid") return { ...base, type: "solid", color: primaryColor(paint) };
  if (type === "pattern") return { ...patternPaint(), ...base };
  if (type === "media") return { ...mediaPaint({ type: "asset", assetId: "" }), ...base };
  // Gradient target: gradient → gradient keeps the exact handles + stops; anything
  // else seeds a color→transparent ramp with default left→right geometry.
  if (isGradientPaint(paint)) {
    return { ...base, type, stops: paint.stops, start: paint.start, end: paint.end };
  }
  const seed = primaryColor(paint);
  const stops = [
    { id: createId("stop"), offset: 0, color: seed },
    { id: createId("stop"), offset: 1, color: fadeOut(seed) },
  ];
  return { ...gradientPaint(type as GradientType, stops), ...base };
}

/** Figma's solid→gradient default: the color fading to transparent. */
function fadeOut(color: string): string {
  const rgba = parseHexColor(color);
  if (!rgba) return color;
  const to2 = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${to2(rgba.r)}${to2(rgba.g)}${to2(rgba.b)}00`;
}

/**
 * PickerPanel bound to the document's colour variables — the SAME binding policy
 * as DocColorInput (edits detach, ⚙ opens the manager), rendered inline so one
 * click on a swatch lands you on the picker.
 */
export function DocPicker({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (color: string) => void;
  className?: string;
}) {
  const binding = useColorVariableBinding(value, onChange);
  return (
    <div className={className}>
      <PickerPanel
        value={binding.resolved ?? "#ffffff"}
        onCommit={() => {}}
        {...binding.props}
      />
    </div>
  );
}

/**
 * The paint editor body for ONE fill/stroke entry (`eff` = the effective,
 * sampled paint; `id` = the entry id). Renders inside the swatch's popover.
 */
export function PaintEditorBody({
  host,
  kind,
  id,
  eff: entry,
}: {
  host: PaintHost;
  kind: PaintKind;
  id: string;
  eff: Paint;
}) {
  const doc = useDoc();
  /**
   * THE LOOK, whether this entry owns it or links to it.
   *
   * A linked entry stores a REFERENCE — no colour, no stops, no pattern — so
   * every editor below was given something it could not render, and the panel
   * had to hide them all behind "unlink to edit here". Worse, Unlink itself
   * cloned the reference back onto itself and did nothing at all.
   *
   * Resolving once, here, fixes both by removing the special case: the editors
   * render the inherited look, writes land as OVERRIDES (see
   * `setPaintProperty`), and Unlink clones an actual paint.
   */
  const eff = React.useMemo(() => resolvePaint(doc, entry), [doc, entry]);
  const [selectedStop, setSelectedStop] = React.useState<string | null>(null);

  // Keyframe paths: a solid fill's colour is the bare `fill.<id>`; a solid
  // stroke's is `stroke.<id>.color`; gradient sub-paths hang off `<kind>.<id>`.
  const solidPath = kind === "fill" ? `fill.${id}` : `stroke.${id}.color`;
  const sub = (s: string) => `${kind}.${id}.${s}`;

  const commit = (label: string, path: string, v: KeyframeValue, mergeKey?: string) =>
    host.commit(path, v, label, mergeKey);

  const mutate = (label: string, fn: (p: Paint, c: PaintCarrierDraft) => void) =>
    host.update(label, (c) => {
      const p = kind === "fill" ? c.fills.find((f) => f.id === id) : c.strokes.find((s) => s.id === id)?.paint;
      if (p) fn(p, c);
    });

  const stops = isGradientPaint(eff) ? [...eff.stops].sort((a, b) => a.offset - b.offset) : null;
  const stop = stops?.find((s) => s.id === selectedStop) ?? stops?.[0];

  const replaceType = (type: Paint["type"]) => {
    mutate(`${TYPE_LABEL[type]} paint`, (p) => {
      const next = convertPaint(p, type);
      for (const k of Object.keys(p)) delete (p as unknown as Record<string, unknown>)[k];
      Object.assign(p, next);
    });
    // Only gradients drive on-stage handles; solid/pattern/media clear them.
    if (host.keyframeClip) {
      const isGradient = type === "linear" || type === "radial" || type === "angular";
      useSession.getState().setActivePaint(isGradient ? { clipId: host.key, target: kind, id } : null);
    }
  };

  const tab = tabOfPaint(eff.type);

  // Per-tab drafts: switching tabs while the popover is open KEEPS each tab's
  // values (gradient stops, the picked media, pattern fields, the solid colour).
  // Snapshot the tab we leave, restore the tab we return to; only convert to a
  // fresh default the first time a tab is opened. Lives only as long as the
  // popover (a fresh open starts clean) — the entry id/opacity/blend are always
  // the live ones, so composite never resets.
  const draftsRef = React.useRef<Partial<Record<PaintTab, Paint>>>({});
  const selectTab = (t: PaintTab) => {
    if (t === tab) return;
    const leaving = kind === "fill" ? host.fills.find((f) => f.id === id) : host.strokes.find((s) => s.id === id)?.paint;
    if (leaving) draftsRef.current[tab] = structuredClone(leaving);
    const cached = draftsRef.current[t];
    mutate(`${TAB_LABEL[t]} paint`, (p) => {
      const next: Paint = cached
        ? { ...cached, id: p.id, opacity: p.opacity, blendMode: p.blendMode }
        : convertPaint(p, t === "gradient" ? "linear" : t);
      for (const k of Object.keys(p)) delete (p as unknown as Record<string, unknown>)[k];
      Object.assign(p, next);
    });
    if (host.keyframeClip) {
      const nextType = cached?.type ?? (t === "gradient" ? "linear" : t);
      const isGradient = nextType === "linear" || nextType === "radial" || nextType === "angular";
      useSession.getState().setActivePaint(isGradient ? { clipId: host.key, target: kind, id } : null);
    }
  };

  const setBlend = (mode: string) =>
    host.update("Blend mode", (c) => {
      const entry = kind === "fill" ? c.fills.find((f) => f.id === id) : c.strokes.find((s) => s.id === id);
      if (entry) entry.blendMode = mode as Paint["blendMode"];
    });

  const rampRef = React.useRef<HTMLDivElement | null>(null);

  /** ⌥-drag duplicates: the copy is what moves, the original stays (Figma).
   *  The rail owns the gesture; this only mints the twin and hands back its id. */
  const duplicateStop = (stopId: string): string | null => {
    const src = stops?.find((s) => s.id === stopId);
    if (!src) return null;
    const dragId = createId("stop");
    mutate("Duplicate gradient stop", (p) => {
      if (isGradientPaint(p)) p.stops.push({ id: dragId, offset: src.offset, color: src.color });
    });
    return dragId;
  };

  /** Add a stop at an offset, coloured by what the ramp already shows there —
   *  so clicking the rail never changes the gradient, it only gives you a
   *  handle on a colour that was already in it. */
  const addStopAt = (offset: number) => {
    if (!isGradientPaint(eff) || !stops) return;
    const color = gradientColorAt(stops, offset);
    const sid = createId("stop");
    mutate("Add gradient stop", (p) => {
      if (!isGradientPaint(p)) return;
      p.stops.push({ id: sid, offset, color });
    });
    setSelectedStop(sid);
  };

  const deleteStop = (stopId: string) =>
    mutate("Delete gradient stop", (p, c) => {
      if (!isGradientPaint(p) || p.stops.length <= 2) return;
      const i = p.stops.findIndex((x) => x.id === stopId);
      if (i >= 0) p.stops.splice(i, 1);
      if (c.keyframes) c.keyframes = c.keyframes.filter((t) => !t.property.startsWith(sub(`stop.${stopId}.`)));
    });

  // The stop whose color popover is open (double-click a pin). Separate from the
  // ramp SELECTION so single-click still just selects/moves.
  const [colorStopId, setColorStopId] = React.useState<string | null>(null);

  // Pressing Delete/⌫ with the ramp focused removes the SELECTED stop — never the
  // whole layer. A capture-phase listener beats the app's global delete shortcut
  // (which lives on window); it's only mounted while this gradient editor is.
  const selectedRef = React.useRef<string | null>(null);
  selectedRef.current = stop?.id ?? null;
  const deleteRef = React.useRef(deleteStop);
  deleteRef.current = deleteStop;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (isTypingTarget(e.target)) return;
      const sid = selectedRef.current;
      if (!sid) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      deleteRef.current(sid);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Rotate the gradient axis about its midpoint to a given angle (keeps length),
  // through the keyframe-aware path so record mode captures it as one step.
  const rotateGradient = (deg: number) => {
    if (!isGradientPaint(eff)) return;
    const mx = (eff.start.x + eff.end.x) / 2;
    const my = (eff.start.y + eff.end.y) / 2;
    const len = Math.hypot(eff.end.x - eff.start.x, eff.end.y - eff.start.y) || 1;
    const hx = (Math.cos((deg * Math.PI) / 180) * len) / 2;
    const hy = (Math.sin((deg * Math.PI) / 180) * len) / 2;
    const mk = `paint-rot-${id}`;
    commit("Gradient angle", sub("start.x"), mx - hx, mk);
    commit("Gradient angle", sub("start.y"), my - hy, mk);
    commit("Gradient angle", sub("end.x"), mx + hx, mk);
    commit("Gradient angle", sub("end.y"), my + hy, mk);
  };

  /** Space the stops evenly from 0 to 1 — the one edit that is tedious by hand
   *  and instantly obvious once it exists. */
  const distributeStops = () =>
    mutate("Distribute stops", (p) => {
      if (!isGradientPaint(p) || p.stops.length < 2) return;
      const order = [...p.stops].sort((a, b) => a.offset - b.offset);
      order.forEach((s, i) => void (s.offset = i / (order.length - 1)));
    });

  const reverseStops = () =>
    mutate("Reverse gradient", (p) => {
      if (!isGradientPaint(p)) return;
      for (const s of p.stops) s.offset = 1 - s.offset;
    });

  const resolve = React.useCallback((c: string) => resolveColor(doc, c), [doc]);

  // The RAW entry — `eff` is already resolved and sampled, so it can never tell
  // us whether this fill is bound to a style. Only the stored one knows.
  const raw = kind === "fill" ? host.fills.find((f) => f.id === id) : host.strokes.find((s) => s.id === id)?.paint;
  const boundStyleId = raw?.type === "variable" ? raw.variableId : null;
  const boundStyle = boundStyleId ? doc.variables.find((v) => v.id === boundStyleId) : undefined;
  const shelfKind = shelfKindOf(eff);

  /** Point this entry at a style. The ENTRY keeps its own id, opacity and
   *  blend — binding changes what it looks like, never how it composites. */
  const bindStyle = (variableId: string) =>
    mutate("Use fill style", (p) => {
      const next = { ...variablePaint(variableId), id: p.id, enabled: p.enabled, opacity: p.opacity, blendMode: p.blendMode };
      for (const k of Object.keys(p)) delete (p as unknown as Record<string, unknown>)[k];
      Object.assign(p, next);
    });

  /** Unlink, keeping exactly what is on screen — a detach must never be a
   *  visual change, only a change of ownership. */
  const detachStyle = () =>
    mutate("Unlink fill style", (p) => {
      const next = { ...structuredClone(eff), id: p.id, enabled: p.enabled, opacity: p.opacity, blendMode: p.blendMode };
      for (const k of Object.keys(p)) delete (p as unknown as Record<string, unknown>)[k];
      Object.assign(p, next);
    });

  /** Drop a preset's look in. A copy, owned from this moment — presets are not
   *  bindings, and blurring the two is how people edit a palette by accident. */
  const applyPaint = (paint: Paint) => {
    pushRecentPaint(paint);
    mutate("Apply fill", (p) => {
      const next = { ...paint, id: p.id, enabled: p.enabled, opacity: p.opacity, blendMode: p.blendMode };
      for (const k of Object.keys(p)) delete (p as unknown as Record<string, unknown>)[k];
      Object.assign(p, next);
    });
  };

  /**
   * Apply a pattern DESIGN: its form, over the colours already on the fill.
   *
   * It also OWNS the fill, exactly as applying a preset does. A design is
   * something you author from, not a value you subscribe to — and a fill still
   * linked to a style would have taken the new form as an override, which is
   * the confusing half-state ("I picked chevron and nothing below me changed")
   * that came from treating tinted patterns as shareable styles at all.
   */
  const applyDesign = (design: PatternDesign) => {
    const from = eff.type === "pattern" ? eff.pattern : null;
    const spec = patternFromDesign(
      design,
      from?.color ?? "#1E1E1E",
      from?.background ?? "#FFFFFF",
    );
    applyPaint(patternPaint(spec));
  };

  // Every fill this editor settles on becomes a recent, whichever tab made it.
  // Settles, not streams: a debounce means dragging a hue slider leaves ONE
  // entry behind instead of forty, which is what a colour-keyed recents list
  // could never get right.
  React.useEffect(() => {
    if (entry.type === "variable" || eff.type === "media") return;
    const t = setTimeout(() => pushRecentPaint(eff), 900);
    return () => clearTimeout(t);
  }, [eff, entry.type]);

  /**
   * Install the binding menu for every numeric field in this editor.
   *
   * The gradient and pattern panels lay out their own controls, so they never
   * went through `ValueField` and never got the menu — an angle you could
   * scrub but not link, key or modulate. Rather than rebuild those panels on
   * `ValueField` (whose PropRow layout does not fit them) or repeat the menu at
   * every input, the decorator is installed ONCE here and every `NumberInput`
   * below that names a `path` inherits it.
   *
   * `keyframeClip` is the gate, and it is the honest one: a fill on a brush
   * preset has no timeline, so there is nothing to key, bind or modulate and
   * the fields correctly stay plain.
   */
  const bindRender = React.useCallback<FieldBindingRender>(
    ({ path, label, literal, kind: valueKind, children }) =>
      host.keyframeClip ? (
        <PropertyBindingMenu
          clip={host.keyframeClip}
          path={path}
          kind={valueKind ?? "number"}
          label={label}
          literal={literal}
        >
          {children}
        </PropertyBindingMenu>
      ) : (
        children
      ),
    [host.keyframeClip],
  );

  return (
    <FieldBindingProvider render={bindRender}>
      {/* Figma-style top tabs: Solid · Gradient · Pattern · Media. Pinned as
          popover chrome so switching tabs never scrolls them out of reach — and
          so a taller tab grows the SCROLL region, not the panel. */}
      <PopoverHeader className="grid grid-cols-4 gap-0.5 bg-muted/40 p-1">
        {PAINT_TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => selectTab(t)}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
              tab === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </PopoverHeader>

      {/* Two columns under the tabs: the fill LIBRARY on the left, the editor
          on the right. Both scroll on their own, so a tall pattern studio never
          pushes the library out of reach and a long palette never stretches the
          panel. The library is on EVERY tab — a colour, a gradient and a
          pattern are all fills, and giving colours a private one is exactly what
          left a perfected gradient unshareable. */}
      <div className="flex min-h-0 flex-1">
        {shelfKind && (
          <PaintLibrary
            kind={shelfKind}
            current={eff}
            boundId={boundStyleId}
            onBind={bindStyle}
            onDetach={detachStyle}
            onApply={applyPaint}
            onApplyDesign={applyDesign}
          />
        )}
        <PopoverBody className="min-w-0 flex-1">
      {/* Linked to a style: what it is, what you have changed about it, and
          the two ways out. The editors below stay LIVE — see `eff`. */}
      {boundStyleId && boundStyle && (
        <PaintPathContext.Provider value={{ kind, id }}>
        <StyleLinkBar
          name={boundStyle.name}
          overrides={paintOverrides(raw!)}
          onReveal={(path) => selectTab(tabOfSub(path, eff.type))}
          onRevert={(path) =>
            mutate("Revert override", (p) => clearPaintOverride(p, path))
          }
          onRevertAll={() => mutate("Reset to style", (p) => clearPaintOverrides(p))}
          onEditStyle={() => useSession.getState().revealVariable(boundStyleId)}
          onUnlink={detachStyle}
        />
        </PaintPathContext.Provider>
      )}

      {tab === "solid" && eff.type === "solid" && (
        // One click on the swatch already landed here — the picker is inline.
        <DocPicker value={eff.color} onChange={(color) => commit("Paint color", solidPath, color, `paint-${kind}-${id}`)} />
      )}

      {tab === "media" && eff.type === "media" && (
        <div className="p-2.5">
          <MediaFillEditor host={host} kind={kind} id={id} eff={eff} />
        </div>
      )}

      {tab === "pattern" && eff.type === "pattern" && (
        <PatternStudio host={host} kind={kind} id={id} eff={eff} />
      )}

      {tab === "gradient" && isGradientPaint(eff) && (
        <div className="space-y-2.5 p-2.5">
          {/* The fill as it will actually draw — the real painter, so a radial
              reads as a disc and an angular as a sweep before you commit. */}
          <div className="h-20 overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]">
            <PaintPreview paint={eff} />
          </div>

          {/* Gradient type — the three share geometry, so switching keeps handles. */}
          <div className="track grid grid-cols-3 gap-0.5 bg-muted/60">
            {(["linear", "radial", "angular"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => replaceType(t)}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                  eff.type === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>

          {/* The rail takes the gradient's own shape (see GradientRail): a bar,
              a disc, a ring. Click empty space to add a stop, drag to move,
              ⌥-drag to duplicate, double-click for colour, right-click for a menu. */}
          <div ref={rampRef}>
            <GradientRail
              paint={eff}
              stops={stops ?? []}
              selectedId={stop?.id ?? null}
              resolve={resolve}
              onSelect={setSelectedStop}
              onMove={(sid, offset) => commit("Move gradient stop", sub(`stop.${sid}.offset`), offset, `paint-stop-${sid}`)}
              onAdd={(offset) => addStopAt(offset)}
              onDuplicate={duplicateStop}
              onOpenColor={(sid) => {
                setSelectedStop(sid);
                setColorStopId(sid);
              }}
              pinWrapper={(s, pin) => (
                <ContextMenu key={s.id}>
                  <ContextMenuTrigger asChild>{pin}</ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => setColorStopId(s.id)}>Edit color…</ContextMenuItem>
                    <ContextMenuItem
                      className="text-destructive focus:text-destructive"
                      disabled={(stops?.length ?? 0) <= 2}
                      onSelect={() => deleteStop(s.id)}
                    >
                      Delete stop
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )}
            />
            {/* Double-click colour popover — portals over everything. */}
            <Popover open={!!colorStopId} onOpenChange={(o) => !o && setColorStopId(null)}>
              <PopoverAnchor asChild>
                <div className="pointer-events-none size-0" />
              </PopoverAnchor>
              <PopoverContent
                {...PICKER_PLACEMENT}
                className={cn("p-0", PICKER_WIDTH)}
                style={{ maxHeight: PICKER_MAX_HEIGHT }}
              >
                <PopoverBody>
                  {colorStopId && (
                    <DocPicker
                      value={stops?.find((s) => s.id === colorStopId)?.color ?? "#ffffff"}
                      onChange={(color) => commit("Stop color", sub(`stop.${colorStopId}.color`), color, `paint-stopc-${colorStopId}`)}
                    />
                  )}
                </PopoverBody>
              </PopoverContent>
            </Popover>
          </div>

          {stop && (
            <div className="flex items-center gap-1.5">
              <DocColorInput
                value={stop.color}
                onChange={(color) => commit("Stop color", sub(`stop.${stop.id}.color`), color, `paint-stopc-${stop.id}`)}
                className="flex-1"
              />
              <NumberInput
                // The leading slot is an ICON-sized affix, not a caption.
                // "Start to end" crammed into it rendered as a clipped grey
                // smear that read as a broken empty field. What the number
                // measures belongs in the tooltip; the field shows the number.
                label="%"
                title={`Stop position — ${RAIL_HINT[eff.type].toLowerCase()}`}
                value={Math.round(stop.offset * 100)}
                min={0}
                max={100}
                precision={0}
                className="w-20"
                path={sub(`stop.${stop.id}.offset`)}
                fieldLabel="Stop position"
                onChange={(v) => commit("Stop position", sub(`stop.${stop.id}.offset`), v / 100, `paint-stopo-${stop.id}`)}
              />
              <button
                type="button"
                aria-label="Delete stop"
                disabled={(stops?.length ?? 0) <= 2}
                onClick={() => deleteStop(stop.id)}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 [&_svg]:size-3.5"
              >
                <Trash2 />
              </button>
            </div>
          )}

          {/* Geometry lives on the canvas (drag the handles); the panel keeps
              the two actions that are tedious by hand always in reach. */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={reverseStops}
              title="Reverse stops"
              className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-border/70 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
            >
              <FlipHorizontal2 />
              Reverse
            </button>
            <button
              type="button"
              onClick={distributeStops}
              title="Space the stops evenly"
              className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-border/70 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
            >
              <AlignHorizontalSpaceAround />
              Even
            </button>
          </div>

          <GradientGeometry
            host={host}
            eff={eff}
            id={id}
            sub={sub}
            commit={(label, path, value, mk) => commit(label, path, value, mk)}
            onRotate={rotateGradient}
          />
        </div>
      )}

        </PopoverBody>
      </div>

      {/* Per-paint blend + opacity — Figma keeps blend on the paint itself.
          Pinned to the bottom: they apply to every tab, so they should never be
          a scroll away. */}
      <PopoverFooter className="flex items-center gap-1.5 p-2">
        <BlendSelect value={eff.blendMode} onChange={setBlend} className="h-7 min-w-0 flex-1 text-xs" />
        <NumberInput
          path={sub("opacity")}
          fieldLabel="Opacity"
          label="Opacity"
          value={Math.round(eff.opacity * 100)}
          min={0}
          max={100}
          precision={0}
          unit="%"
          className="w-24"
          onChange={(v) => commit("Paint opacity", `${kind}.${id}.opacity`, v / 100, `paint-op-${id}`)}
        />
      </PopoverFooter>
    </FieldBindingProvider>
  );
}

const FIT_LABEL: Record<MediaFit, string> = { cover: "Fill", contain: "Fit", fill: "Stretch", tile: "Tile" };

/**
 * The MEDIA fill editor — an image/video paint. `self` fills show the layer's own
 * footage; `asset` fills point at an imported asset (the media picker lands next
 * phase). `fit` frames the media in the box. Per-fill grade (Adjust) arrives with
 * the center-slider phase.
 */
function MediaFillEditor({
  host,
  kind,
  id,
  eff,
}: {
  host: PaintHost;
  kind: PaintKind;
  id: string;
  eff: MediaPaint;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const updateMedia = (label: string, fn: (m: MediaPaint) => void) =>
    host.update(label, (c) => {
      const p = kind === "fill" ? c.fills.find((f) => f.id === id) : c.strokes.find((s) => s.id === id)?.paint;
      if (p && p.type === "media") fn(p);
    });

  const isSelf = eff.source.type === "self";
  const clip = host.keyframeClip;

  // What the preview + fit apply to: a `self` fill shows the host clip's own
  // footage; an `asset` fill shows its chosen asset.
  const previewAssetId = isSelf ? (clip && "assetId" in clip ? clip.assetId : null) : eff.source.type === "asset" ? eff.source.assetId : null;
  const previewAsset = previewAssetId ? doc.assets.find((a) => a.id === previewAssetId) : undefined;
  const previewKind = previewAsset?.kind ?? (isSelf && clip?.kind === "video" ? "video" : "image");

  const applyPick = (assetId: string) => {
    if (isSelf && clip) {
      // Replace the layer's own footage (keep it a `self` fill).
      store.update("Replace media", (d) => {
        const loc = locateClip(d, clip.id);
        if (loc && (loc.clip.kind === "image" || loc.clip.kind === "video")) loc.clip.assetId = assetId;
      });
    } else {
      updateMedia("Set media", (m) => void (m.source = { type: "asset", assetId }));
    }
  };

  return (
    <div className="space-y-2">
      <MediaPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} onPick={applyPick} />
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="relative flex h-24 w-full items-center justify-center overflow-hidden rounded-md border border-border/70 text-center text-[11px] text-muted-foreground transition hover:border-primary/60"
        style={{ background: CHECKER_BG }}
      >
        {previewAssetId ? (
          <AssetThumb assetId={previewAssetId} kind={previewKind} mime={previewAsset?.mime} className="absolute inset-0 size-full" />
        ) : (
          <span className="px-3">Choose an image or video from the media library.</span>
        )}
      </button>
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border/70 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
      >
        {isSelf ? "Replace footage…" : "Choose media…"}
      </button>
      <div className="flex items-center gap-1.5">
        <Select value={eff.fit} onValueChange={(v) => updateMedia("Media fit", (m) => void (m.fit = v as MediaFit))}>
          <SelectTrigger className="h-7 flex-1 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FIT_LABEL) as MediaFit[]).map((f) => (
              <SelectItem key={f} value={f}>
                {FIT_LABEL[f]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {eff.fit === "tile" && (
          <NumberInput
            label="Scale"
            value={Math.round(eff.tileScale * 100)}
            min={1}
            precision={0}
            unit="%"
            className="w-24"
            onChange={(v) => updateMedia("Tile scale", (m) => void (m.tileScale = Math.max(0.01, v / 100)))}
          />
        )}
      </div>
    </div>
  );
}

/** Checkerboard behind translucent media/pattern previews. */
const CHECKER_BG =
  "repeating-conic-gradient(rgba(0,0,0,0.28) 0% 25%, transparent 0% 50%) 0 0 / 12px 12px";

/** The blend-mode dropdown — Figma's grouped list. Reused by paints and layers. */
export function BlendSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (mode: string) => void;
  className?: string;
}) {
  return (
    // "" = the selection disagrees; Radix then shows the placeholder.
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className}>
        <SelectValue placeholder="Mixed" />
      </SelectTrigger>
      <SelectContent>
        {BLEND_GROUPS.map((group, i) =>
          group.label ? (
            <SelectGroup key={group.label}>
              <SelectLabel className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {group.label}
              </SelectLabel>
              {group.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : (
            <SelectGroup key={`g${i}`}>
              {group.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ),
        )}
      </SelectContent>
    </Select>
  );
}

/**
 * Which TAB owns a given paint sub-path — the reveal target for an override
 * row, and the same "take me to where this is edited" gesture the text scope's
 * override list makes. An override you cannot navigate to is a receipt, not a
 * control.
 */
function tabOfSub(sub: string, type: Paint["type"]): PaintTab {
  if (sub.startsWith("pattern.")) return "pattern";
  if (sub.startsWith("stop.") || sub.startsWith("start.") || sub.startsWith("end.")) return "gradient";
  if (sub === "color") return "solid";
  return tabOfPaint(type);
}

/** A human name for a paint sub-path. Read from the SAME property registry the
 *  keyframe rows and curve editor label themselves from, so an override reads
 *  as the field it came from rather than as a path. */
function subLabel(sub: string, kind: PaintKind, id: string): string {
  return propertyDef(`${kind}.${id}.${sub}`)?.label ?? sub;
}

/**
 * THE STYLE LINK — inherited, not frozen.
 *
 * A link used to be a wall: the panel showed the style's name and hid every
 * editor, because a stored reference has no colour or stops for them to write
 * into. So the only way to move a shared gradient's angle on one shape was to
 * break the link and lose the colours with it.
 *
 * Now the editors stay live and each edit becomes a sparse OVERRIDE, which is
 * the same thing a caption's focus scope does to a text style — inherit
 * everything, own the handful you touched. This bar is the other half of that
 * idea: it says what you have taken over, hands any of it back, and clicking a
 * row takes you to the field that owns it.
 */
function StyleLinkBar({
  name,
  overrides,
  onReveal,
  onRevert,
  onRevertAll,
  onEditStyle,
  onUnlink,
}: {
  name: string;
  overrides: PaintOverride[];
  onReveal: (path: string) => void;
  onRevert: (path: string) => void;
  onRevertAll: () => void;
  onEditStyle: () => void;
  onUnlink: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const kindId = React.useContext(PaintPathContext);

  return (
    <div className="border-b border-border/50 bg-primary/[0.04] px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Link2 className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={name}>
          {name}
        </span>
        {overrides.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex h-5 items-center gap-1 rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/25 [&_svg]:size-2.5"
          >
            <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
            {overrides.length} changed
          </button>
        )}
        <button
          type="button"
          onClick={onEditStyle}
          title="Open this style in the Variables window"
          className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3.5"
        >
          <Pencil />
        </button>
        <button
          type="button"
          onClick={onUnlink}
          title="Keep this look and stop following the style"
          className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3.5"
        >
          <Link2Off />
        </button>
      </div>

      {open && overrides.length > 0 && (
        <div className="mt-1.5 space-y-px">
          {overrides.map((o) => (
            <div key={o.path} className="group/ovr flex h-6 items-center gap-1.5 rounded pl-1 pr-0.5 hover:bg-muted/50">
              <button
                type="button"
                onClick={() => onReveal(o.path)}
                className="min-w-0 flex-1 truncate text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                title="Go to this field"
              >
                {subLabel(o.path, kindId.kind, kindId.id)}
              </button>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                {typeof o.value === "number" ? round2(o.value) : String(o.value).replace(/^#/, "")}
              </span>
              <button
                type="button"
                aria-label="Follow the style again"
                title="Follow the style again"
                onClick={() => onRevert(o.path)}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-primary group-hover/ovr:opacity-100 [&_svg]:size-3"
              >
                <RotateCcw />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={onRevertAll}
            className="mt-0.5 h-6 w-full rounded text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            Follow the style for everything
          </button>
        </div>
      )}
    </div>
  );
}

const round2 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** The entry a link bar is describing, so its rows can name themselves from the
 *  property registry without every caller threading two more props. */
const PaintPathContext = React.createContext<{ kind: PaintKind; id: string }>({ kind: "fill", id: "" });
