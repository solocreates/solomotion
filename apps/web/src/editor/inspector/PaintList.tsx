"use client";

import * as React from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  isGradientPaint,
  paintWithSampled,
  propertyDef,
  resolveColor,
  sampleKeyframes,
  solidPaint,
  strokeStyle,
  STROKE_SCALAR_PATHS,
  type Frame,
  type MediaPaint,
  type Paint,
} from "@solomotion/core";
import { Eye, EyeOff, GripVertical, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { PICKER_PLACEMENT, PICKER_WIDTH } from "@/components/ui/color-picker";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { AssetThumb } from "../assets/AssetThumb";
import { clipLocalClamped } from "./animatable";
import { MultiKeyControl } from "./keyframe-controls";
import { useRevealFlash } from "../state/inspector-nav";
import { DomainRevert } from "./scope";
import { PanelSection } from "./controls";
import { StrokeStackEditor } from "./StrokeStack";
import { strokeHostOf } from "./stroke-host";
import { PaintEditorBody, type PaintableClip } from "./PaintPopover";
import { PaintPreview } from "../paint/PaintPreview";
import { frameToPaintHost, useClipPaintHost, useMultiClipPaintHost, type PaintHost } from "./paint-host";

type PaintKind = "fill" | "stroke";

/** Checkerboard behind translucent swatches (alpha-aware preview). */
export const CHECKER =
  "repeating-conic-gradient(rgba(0,0,0,0.28) 0% 25%, transparent 0% 50%) 0 0 / 8px 8px";

/** Stable placeholder so the effective-paint hook never allocates a fresh id per render. */
const FALLBACK_PAINT = solidPaint("#000000");

/** The base Paint for one entry (a fill IS a paint; a stroke wraps one). */
function basePaint(host: PaintHost, kind: PaintKind, id: string): Paint | undefined {
  return kind === "fill"
    ? host.fills.find((f) => f.id === id)
    : host.strokes.find((s) => s.id === id)?.paint;
}

/**
 * A fill/stroke entry's effective paint at the playhead — base with its id-
 * scoped keyframes (colour / stops / gradient geometry) applied. Only clips
 * keyframe; a frame host returns the base unchanged.
 */
function useEffectivePaint(host: PaintHost, kind: PaintKind, id: string, base: Paint): Paint {
  const prefix = `${kind}.${id}`;
  const clip = host.keyframeClip;
  const subscribe = React.useCallback((cb: () => void) => useSession.subscribe(cb), []);
  const ref = React.useRef({ clip, base });
  ref.current = { clip, base };
  const snap = React.useSyncExternalStore(
    subscribe,
    () => {
      const { clip: c, base: b } = ref.current;
      if (!c) return "";
      const keyed = c.keyframes.some((t) => {
        if (t.property === prefix) return true; // solid fill colour
        if (!t.property.startsWith(prefix + ".")) return false;
        const rest = t.property.slice(prefix.length + 1);
        return rest !== "opacity" && rest !== "width" && rest !== "dashLength" && rest !== "dashGap";
      });
      if (!keyed) return "";
      const local = clipLocalClamped(c, useSession.getState().playheadMs);
      return JSON.stringify(paintWithSampled(b, prefix, sampleKeyframes(c.keyframes, local)));
    },
    () => "",
  );
  return React.useMemo(() => (snap ? (JSON.parse(snap) as Paint) : base), [snap, base]);
}

/** Every keyframable path of one paint entry — feeds its ◆ cluster. The stroke
 *  half comes from core's ONE scalar table, so a new pipeline field appears in
 *  the cluster without this file being touched. */
function paintKeyProperties(eff: Paint, kind: PaintKind, id: string): string[] {
  const prefix = `${kind}.${id}`;
  const props: string[] = [`${prefix}.opacity`];
  if (kind === "stroke") props.push(...STROKE_SCALAR_PATHS.filter((p) => p !== "opacity").map((p) => `${prefix}.${p}`));
  if (eff.type === "solid") {
    props.push(kind === "fill" ? `fill.${id}` : `stroke.${id}.color`);
  } else if (isGradientPaint(eff)) {
    for (const s of eff.stops) props.push(`${prefix}.stop.${s.id}.color`, `${prefix}.stop.${s.id}.offset`);
    props.push(`${prefix}.start.x`, `${prefix}.start.y`, `${prefix}.end.x`, `${prefix}.end.y`);
  }
  // media/pattern keyframe only their opacity for now.
  return props;
}

const KIND_LABEL: Record<PaintKind, { title: string; add: string }> = {
  fill: { title: "Fill", add: "Add fill" },
  stroke: { title: "Stroke", add: "Add stroke" },
};

/**
 * FILL and STROKE are two SECTIONS, not one "Paint" blob with two rows in it.
 *
 * They were one section because they share a data shape — an ordered list of
 * paints — and that shape hid how differently they behave. A fill is a colour;
 * a stroke is a colour plus a whole pipeline (width, ends, dash, trim, taper,
 * wave), and every one of those was buried inside the colour popover. Two
 * sections give the stroke somewhere to BE, and each carries its own
 * copy/paste-properties domain, which is what people actually reach for.
 *
 * Both are rendered from the same `PaintListView` and the same `PaintRow`, so
 * the shared half stays shared and only the stroke's extra controls differ.
 */
export function FillSection({ clips }: { clips: PaintableClip[] }) {
  // Two hosts, one COMPONENT per shape: a selection of one is the scope-aware
  // clip host, a selection of many is the fan-out host. They are separate
  // component types so React remounts when the selection crosses between one
  // and many — calling either hook here directly changed this component's hook
  // order the moment one selected layer became two, and the panel crashed.
  return clips.length === 1 ? <OneFill clips={clips} /> : <ManyFill clips={clips} />;
}
const OneFill = ({ clips }: { clips: PaintableClip[] }) => <FillSectionFor host={useClipPaintHost(clips[0]!)} clips={clips} />;
const ManyFill = ({ clips }: { clips: PaintableClip[] }) => <FillSectionFor host={useMultiClipPaintHost(clips)} clips={clips} />;

function FillSectionFor({ host, clips }: { host: PaintHost; clips: PaintableClip[] }) {
  return (
    <PanelSection
      id="fill"
      title="Fill"
      transfer={{ domains: ["fills"], clipId: clips[0]!.id }}
      count={host.fills.length}
      actions={
        <>
          {host.uneven && <UnevenChip noun="fills" />}
          <DomainRevert domain="fill" title="Fill" />
        </>
      }
    >
      <PaintListView host={host} kind="fill" />
    </PanelSection>
  );
}

export function StrokeSection({ clips }: { clips: PaintableClip[] }) {
  // Separate component types for one and many — see `FillSection`.
  return clips.length === 1 ? <OneStroke clips={clips} /> : <ManyStroke clips={clips} />;
}
const OneStroke = ({ clips }: { clips: PaintableClip[] }) => <StrokeSectionFor host={useClipPaintHost(clips[0]!)} clips={clips} />;
const ManyStroke = ({ clips }: { clips: PaintableClip[] }) => <StrokeSectionFor host={useMultiClipPaintHost(clips)} clips={clips} />;

function StrokeSectionFor({ host, clips }: { host: PaintHost; clips: PaintableClip[] }) {
  return (
    <PanelSection
      id="stroke"
      title="Stroke"
      transfer={{ domains: ["strokes"], clipId: clips[0]!.id }}
      count={host.strokes.length}
      actions={
        <>
          {host.uneven && <UnevenChip noun="strokes" />}
          <DomainRevert domain="stroke" title="Stroke" />
        </>
      }
    >
      <StrokeStackEditor
        host={strokeHostOf(host)}
        paintHost={host}
        paintOf={() => firstSolidColor(host.strokes) ?? "#1E1E1E"}
      />
    </PanelSection>
  );
}

/** The selection's lists differ; only what they share is listed. */
function UnevenChip({ noun }: { noun: string }) {
  return (
    <span
      title={`The selected layers carry different ${noun}. Only the ones they all share are shown; adding reaches every layer.`}
      className="flex h-5 items-center rounded bg-muted/60 px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
    >
      Differ
    </span>
  );
}

/** The colour a NEW line inherits — whatever the stack is already using, so
 *  adding a second stroke does not silently introduce a third colour. */
function firstSolidColor(strokes: readonly { paint: Paint }[]): string | null {
  for (const s of strokes) if (s.paint.type === "solid") return s.paint.color;
  return null;
}

/** The frame (artboard) pair — same sections, base edits, no keyframes. */
export function FramePaintSections({ frame }: { frame: Frame }) {
  const store = useDocStore();
  const host = frameToPaintHost(frame, store);
  return (
    <>
      <PanelSection title="Fill" count={frame.fills.length}>
        <FramePaintList frame={frame} kind="fill" />
      </PanelSection>
      <PanelSection title="Stroke" count={frame.strokes.length}>
        <StrokeStackEditor host={strokeHostOf(host)} paintHost={host} />
      </PanelSection>
    </>
  );
}

/** A clip's fills/strokes editor (keyframable). Builds a clip paint host. */
export function PaintList({ clip, kind }: { clip: PaintableClip; kind: PaintKind }) {
  return <PaintListView host={useClipPaintHost(clip)} kind={kind} />;
}

/** A frame's (artboard) fills/strokes editor — same UI, base edits, no keyframes. */
export function FramePaintList({ frame, kind }: { frame: Frame; kind: PaintKind }) {
  const store = useDocStore();
  return <PaintListView host={frameToPaintHost(frame, store)} kind={kind} />;
}

function PaintListView({ host, kind }: { host: PaintHost; kind: PaintKind }) {
  const entries = kind === "fill" ? host.fills : host.strokes;
  const ids = entries.map((e) => e.id);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const addPaint = () =>
    host.update(KIND_LABEL[kind].add, (c) => {
      if (kind === "fill") c.fills.push(solidPaint("#B0B4BB"));
      else c.strokes.push(strokeStyle(solidPaint("#1E1E1E"), { width: 2 }));
    });

  const removePaint = (id: string) =>
    host.update(kind === "fill" ? "Remove fill" : "Remove stroke", (c) => {
      if (kind === "fill") c.fills = c.fills.filter((f) => f.id !== id);
      else c.strokes = c.strokes.filter((s) => s.id !== id);
      // A removed entry's keyframe tracks die with it (clips only).
      if (c.keyframes) c.keyframes = c.keyframes.filter((t) => !t.property.startsWith(`${kind}.${id}`));
    });

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(active.id as string);
    const to = ids.indexOf(over.id as string);
    if (from < 0 || to < 0) return;
    host.update(kind === "fill" ? "Reorder fills" : "Reorder strokes", (c) => {
      if (kind === "fill") c.fills = arrayMove(c.fills, from, to);
      else c.strokes = arrayMove(c.strokes, from, to);
    });
  };

  return (
    // The stack IS the section body now, so it spans the full width instead of
    // hiding in a property row's control column.
    <div className="min-w-0 space-y-1">
        {entries.length === 0 ? (
          <button
            type="button"
            onClick={addPaint}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/80 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground [&_svg]:size-3.5"
          >
            <Plus /> {KIND_LABEL[kind].add}
          </button>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <div className="space-y-1">
                {entries.map((entry) => (
                  <PaintRow
                    key={entry.id}
                    host={host}
                    kind={kind}
                    id={entry.id}
                    sortable={entries.length > 1}
                    onRemove={() => removePaint(entry.id)}
                  />
                ))}
              </div>
            </SortableContext>
            <button
              type="button"
              onClick={addPaint}
              aria-label={KIND_LABEL[kind].add}
              className="flex h-6 w-full items-center justify-center gap-1 rounded-md text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3"
            >
              <Plus /> {KIND_LABEL[kind].add}
            </button>
          </DndContext>
      )}
    </div>
  );
}

function PaintRow({
  host,
  kind,
  id,
  sortable,
  onRemove,
}: {
  host: PaintHost;
  kind: PaintKind;
  id: string;
  sortable: boolean;
  onRemove: () => void;
}) {
  const doc = useDoc();
  const resolve = React.useCallback((c: string) => resolveColor(doc, c), [doc]);
  const base = basePaint(host, kind, id);
  const strokeEntry = kind === "stroke" ? host.strokes.find((s) => s.id === id) : undefined;
  const eff = useEffectivePaint(host, kind, id, base ?? FALLBACK_PAINT);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  // A reveal aimed at this paint (from an Overrides row) scrolls it in and
  // flashes it — same grain the effect cards already answer at.
  const flash = useRevealFlash(id);

  const effOpacity = useEffectiveNumber(host, `${kind}.${id}.opacity`, base?.opacity ?? 1);
  const effWidth = useEffectiveNumber(host, `stroke.${id}.width`, strokeEntry?.width ?? 0);

  if (!base) return null;

  const clip = host.keyframeClip;
  const keyProps = paintKeyProperties(eff, kind, id).map((property) => ({
    property,
    currentValue: () => host.read(property) ?? propertyDef(property)?.identity ?? 0,
  }));

  const label =
    eff.type === "solid"
      ? resolve(eff.color).replace(/^#/, "").slice(0, 6).toUpperCase()
      : eff.type === "pattern"
        ? eff.pattern.kind.charAt(0).toUpperCase() + eff.pattern.kind.slice(1)
        : eff.type === "media"
          ? mediaFillKind(eff, doc, host.keyframeClip) === "video"
            ? "Video"
            : "Image"
          : eff.type === "angular"
            ? "Angular"
            : eff.type === "radial"
              ? "Radial"
              : "Linear";

  const commit = (path: string, v: number, mergeKey: string) =>
    host.commit(path, v, kind === "fill" ? "Fill opacity" : "Stroke", mergeKey);
  // The PAINT differs across the selection (its colour, stops, source…) —
  // opacity and the eye have their own readouts and are not counted here.
  const paintMixed =
    !!host.mixed &&
    (kind === "fill" ? host.mixed(`fill.${id}.color`) || host.mixed(`fill.${id}.stops`) || host.mixed(`fill.${id}.type`) || host.mixed(`fill.${id}.source`)
      : host.mixed(`stroke.${id}.paint`));

  return (
    <div
      ref={setNodeRef}
      data-reveal-id={id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group/paint flex items-center gap-1.5 rounded-md transition-opacity",
        !base.enabled && "opacity-45",
        isDragging && "relative z-10 bg-background shadow-lg",
        flash && "ring-1 ring-primary/60",
      )}
    >
      {sortable && (
        <button
          type="button"
          aria-label="Reorder paint"
          className="-ml-1 flex size-4 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground group-hover/paint:opacity-100 active:cursor-grabbing [&_svg]:size-3.5"
          {...attributes}
          {...listeners}
        >
          <GripVertical />
        </button>
      )}
      <Popover
        onOpenChange={(open) => {
          // Opening a gradient on a CLIP reveals its on-stage handles (frames
          // have no stage handles, so only clip hosts drive activePaint).
          if (!clip) return;
          const s = useSession.getState();
          if (open) s.setActivePaint(isGradientPaint(eff) ? { clipId: clip.id, target: kind, id } : null);
          else if (s.activePaint?.clipId === clip.id && s.activePaint.id === id) s.setActivePaint(null);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Edit ${kind}`}
            className="relative size-6 shrink-0 overflow-hidden rounded-[7px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25),inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-transform hover:scale-105"
            style={{ background: CHECKER }}
          >
            {eff.type === "media" ? (
              <MediaSwatch eff={eff} clip={host.keyframeClip} />
            ) : (
              <span className="absolute inset-0">
                <PaintPreview paint={eff} checker={false} />
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent {...PICKER_PLACEMENT} className={cn("p-0", PICKER_WIDTH)}>
          <PaintEditorBody host={host} kind={kind} id={id} eff={eff} />
        </PopoverContent>
      </Popover>

      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums text-foreground/80",
          paintMixed && "font-sans text-muted-foreground/70",
        )}
      >
        {paintMixed ? "Mixed" : label}
      </span>

      <NumberInput
        value={Math.round(effOpacity * 100)}
        min={0}
        max={100}
        precision={0}
        unit="%"
        className="w-12"
        title="Opacity"
        mixed={host.mixed?.(`${kind}.${id}.opacity`)}
        onChange={(v) => commit(`${kind}.${id}.opacity`, v / 100, `pop-${id}`)}
      />
      {clip && <MultiKeyControl clip={clip} properties={keyProps} />}
      <button
        type="button"
        aria-label={base.enabled ? `Hide ${kind}` : `Show ${kind}`}
        title={base.enabled ? "Hide" : "Show"}
        onClick={() =>
          host.update(base.enabled ? `Hide ${kind}` : `Show ${kind}`, (c) => {
            const entry = kind === "fill" ? c.fills.find((f) => f.id === id) : c.strokes.find((s) => s.id === id);
            if (entry) entry.enabled = !entry.enabled;
          })
        }
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-all hover:text-foreground [&_svg]:size-3.5",
          // A HIDDEN entry keeps its control visible: the eye is the only thing
          // saying why the paint isn't drawing, so it must not need a hover.
          base.enabled ? "opacity-0 group-hover/paint:opacity-100" : "text-foreground/70 opacity-100",
        )}
      >
        {base.enabled ? <Eye /> : <EyeOff />}
      </button>
      <button
        type="button"
        aria-label={`Remove ${kind}`}
        onClick={onRemove}
        className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-all hover:text-destructive group-hover/paint:opacity-100 [&_svg]:size-3.5"
      >
        <Trash2 />
      </button>
    </div>
  );
}

/** Whether a media fill shows a video vs an image — an `asset` fill reads the
 *  asset's kind, a `self` fill the host clip's kind. Drives the row label + swatch. */
function mediaFillKind(eff: MediaPaint, doc: ReturnType<typeof useDoc>, clip: PaintableClip | undefined): "video" | "image" {
  if (eff.source.type === "asset") {
    const aid = eff.source.assetId;
    return doc.assets.find((a) => a.id === aid)?.kind === "video" ? "video" : "image";
  }
  return clip?.kind === "video" ? "video" : "image";
}

/** The fill-row swatch for a media paint: the asset thumbnail / video first-frame
 *  (a `self` fill shows the host clip's own footage), or a kind icon. */
function MediaSwatch({ eff, clip }: { eff: MediaPaint; clip: PaintableClip | undefined }) {
  const doc = useDoc();
  const assetId =
    eff.source.type === "asset"
      ? eff.source.assetId
      : clip && "assetId" in clip
        ? clip.assetId
        : null;
  const asset = assetId ? doc.assets.find((a) => a.id === assetId) : undefined;
  const kind = asset?.kind ?? (clip?.kind === "video" ? "video" : "image");
  return <AssetThumb assetId={assetId} kind={kind} mime={asset?.mime} className="absolute inset-0 size-full" />;
}

/** Sampled number at the playhead (base until keyed) — clips only; frames read base. */
function useEffectiveNumber(host: PaintHost, property: string, base: number): number {
  const clip = host.keyframeClip;
  const subscribe = React.useCallback((cb: () => void) => useSession.subscribe(cb), []);
  const ref = React.useRef({ clip, base });
  ref.current = { clip, base };
  return React.useSyncExternalStore(
    subscribe,
    () => {
      const { clip: c, base: b } = ref.current;
      if (!c || !c.keyframes.some((t) => t.property === property)) return b;
      const local = clipLocalClamped(c, useSession.getState().playheadMs);
      const v = sampleKeyframes(c.keyframes, local)[property];
      return typeof v === "number" ? v : b;
    },
    () => base,
  );
}
