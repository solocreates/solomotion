"use client";

import * as React from "react";
import {
  BLEND_MODES,
  gradePath,
  layerEffectPath,
  type CorrectorNode,
  type GradeNode,
  type KeyframeValue,
  type PowerWindow,
  type TrackShape,
  type VisualClip,
} from "@solomotion/core";
import { Circle, Eye, EyeOff, PenTool, Pentagon, Square, Target, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/lib/toast";
import { beginEyedrop } from "@/lib/eyedropper";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { Range } from "@/components/ui/range";
import { useParkedPlayhead } from "../state/session";
import { EffectStackSection } from "../inspector/effect-stack/EffectStackSection";
import { Note, PanelSection, PropRow } from "../inspector/controls";
import { GroupKeyButton } from "../inspector/keyframe-controls";
import { useGradeNodeHost } from "./use-grade-node-host";
import { useColorStore, type CorrectorTab } from "./color-store";
import { GradeField, GradeSelect, GradeSwitch, useGradeCommit } from "./grade-field";
import { deletePowerWindow, keyWindowToTracker, patchDepthWindow, renameNode, toggleNode, trackPowerWindow, withGrade } from "./grade-actions";
import { beginWindowDraw } from "./window-draw";
import { useRegionDraw } from "../stage/region-draw";
import { ObjectField } from "../pick/ObjectField";
import { startTrack } from "../tracking/track-controller";

/**
 * THE CORRECTOR — everything about the selected node, in the app's own grammar.
 *
 *   Grade     what this node DOES. The real `EffectStackSection`.
 *   Key       WHICH PIXELS, by colour.
 *   Windows   which pixels, by shape — drawn with the real tools.
 *
 * EVERY FIELD ON THIS PAGE KEYFRAMES, and that is not a line on a feature list:
 * it is the difference between a colour page and a wall of sliders. A window
 * that cannot move is not a window; a qualifier that cannot open over four
 * frames is not a grade. Both were true of the first draft, because its
 * controls wrote raw values straight into the document.
 *
 * They all go through `GradeField` now — `ValueField` with a grade path — so
 * each row carries its own diamond, each SECTION carries the group diamond with
 * prev/next, record mode plants keys here exactly as it does in the sidebar,
 * and every one of these values shows up in the curve editor.
 */
export function Corrector({
  clip,
  cardId,
  node,
  hasKeyInput = false,
}: {
  clip: VisualClip;
  cardId: string;
  node: GradeNode | null;
  /** A key wire lands on this node — the only state in which `key.input` means
   *  anything, and therefore the only state in which it is worth showing. */
  hasKeyInput?: boolean;
}) {
  const tab = useColorStore((s) => s.tab);
  const setTab = useColorStore((s) => s.setTab);
  const store = useDocStore();

  if (!node) return <Hint>Pick a node on the board to correct it.</Hint>;

  if (node.kind === "mixer") {
    return (
      <div className="space-y-2 p-2">
        <NodeIdentity clip={clip} cardId={cardId} node={node} />
        <PropRow
          label="Combine"
          hint="Layer stacks the branches bottom to top, honouring each corrector's own blend. Parallel averages them — what you want when two keys overlap and neither should win."
        >
          <div className="flex w-full items-center gap-1">
            {(["layer", "parallel"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() =>
                  withGrade(store, clip.id, cardId, "Mixer mode", (g) => {
                    const n = g.nodes.find((x) => x.id === node.id);
                    if (n?.kind === "mixer") n.mix = m;
                  })
                }
                className={cn(
                  "h-7 flex-1 rounded text-[11px] capitalize transition-colors",
                  node.mix === m ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </PropRow>
      </div>
    );
  }

  if (node.kind !== "corrector") {
    return <Hint>{node.kind === "source" ? "The plate, as the stack handed it over." : "What gets drawn."}</Hint>;
  }

  const TABS: Array<{ id: CorrectorTab; label: string; badge?: number }> = [
    { id: "grade", label: "Grade", badge: node.effects.length || undefined },
    { id: "key", label: "Key", badge: node.key.qualifier.enabled ? 1 : undefined },
    { id: "windows", label: "Windows", badge: node.key.windows.length || undefined },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/60 px-2 py-1.5">
        <NodeIdentity clip={clip} cardId={cardId} node={node} />
      </div>

      <div className="flex shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5 py-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "flex h-7 items-center gap-1 rounded px-2.5 text-[11px] transition-colors",
              tab === t.id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t.label}
            {t.badge != null && <span className="rounded bg-foreground/10 px-1 text-[9px] tabular-nums">{t.badge}</span>}
          </button>
        ))}
      </div>

      {/* KEYED BY TAB, so switching lands at the top. One viewport shared
          across three panes kept its scroll position, which meant opening
          Windows after scrolling through Key started you 50px down — with the
          shape buttons above the fold, and the tab looking like it had none. */}
      <ScrollArea key={tab} className="min-h-0 flex-1">
        {tab === "grade" && <GradeTab clip={clip} cardId={cardId} node={node} />}
        {tab === "key" && <KeyTab clip={clip} cardId={cardId} node={node} hasKeyInput={hasKeyInput} />}
        {tab === "windows" && <WindowsTab clip={clip} cardId={cardId} node={node} />}
      </ScrollArea>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-[11px] text-muted-foreground">{children}</div>
  );
}

/**
 * The node's own effect stack — THE effect stack, hosted. Drag-sorting, the
 * floating editor, per-card presets and keyframes, all of it, because a
 * corrector's payload is an ordinary `LayerEffect[]`.
 */
function GradeTab({ clip, cardId, node }: { clip: VisualClip; cardId: string; node: CorrectorNode }) {
  const host = useGradeNodeHost(clip, cardId, node);
  return <EffectStackSection host={host} flush defaultOpen />;
}

// ── Key ──────────────────────────────────────────────────────────────────────

const BANDS: Array<{ key: "hue" | "sat" | "lum"; label: string; max: number; step: number; unit?: string }> = [
  { key: "hue", label: "Hue", max: 360, step: 1, unit: "°" },
  { key: "sat", label: "Saturation", max: 1, step: 0.01 },
  { key: "lum", label: "Luminance", max: 1, step: 0.01 },
];

const BAND_FIELDS = ["center", "width", "softLow", "softHigh"] as const;

const KEY_INPUT_OPTIONS = [
  { value: "replace", label: "Replace" },
  { value: "intersect", label: "Intersect" },
  { value: "union", label: "Union" },
  { value: "subtract", label: "Subtract" },
  { value: "ignore", label: "Ignore" },
] as const;

function KeyTab({
  clip,
  cardId,
  node,
  hasKeyInput,
}: {
  clip: VisualClip;
  cardId: string;
  node: CorrectorNode;
  hasKeyInput: boolean;
}) {
  const showMatte = useColorStore((s) => s.showMatte);
  const setShowMatte = useColorStore((s) => s.setShowMatte);
  const commit = useGradeCommit(clip, cardId);
  const key = node.key;

  const setQualifier = (on: boolean) => commit(`n.${node.id}.q.on`, on, "Qualifier");

  const bandPaths = BANDS.flatMap((b) =>
    BAND_FIELDS.map((f) => ({
      property: layerEffectPath(cardId, gradePath.qualifier(node.id, b.key, f)),
      currentValue: () => (key.qualifier[b.key] as unknown as Record<string, number>)[f] as KeyframeValue,
    })),
  );

  const mattePaths = (["blurPx", "shrinkPx"] as const).map((f) => ({
    property: layerEffectPath(cardId, gradePath.matte(node.id, f)),
    currentValue: () => key[f] as KeyframeValue,
  }));

  return (
    <div>
      {/* WHAT THE CANVAS SHOWS — a view toggle, not a property, so it reads as
          a pair of states rather than as a switch with a label that has to fit
          in a 56px column. (It did not: "Show matte" truncated to "Show m…",
          which is the panel telling you it does not know what this row is.) */}
      <div className="flex items-center gap-0.5 border-b border-border/50 px-1.5 py-1">
        {(
          [
            { on: false, label: "Picture" },
            { on: true, label: "Matte" },
          ] as const
        ).map((v) => (
          <button
            key={v.label}
            type="button"
            onClick={() => setShowMatte(v.on)}
            title={
              v.on
                ? "Paint the selection instead of the picture — a key you cannot see is a key you tune by guessing"
                : "Show the graded picture"
            }
            className={cn(
              "h-6 flex-1 rounded text-[11px] transition-colors",
              showMatte === v.on ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <PanelSection
        title="Colour"
        defaultOpen
        actions={
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={async () => {
                    const tid = toast.message("Click the colour you want to isolate", { duration: 60000 });
                    const hex = await beginEyedrop();
                    toast.dismiss(tid);
                    if (!hex) return;
                    const { h, s, l } = hexToHsl(hex);
                    // One labelled write per value, so every one lands on the
                    // keyframe path it owns rather than through a side door —
                    // which is also what makes an eyedrop recordable.
                    commit(gradePath.qualifier(node.id, "hue", "center"), h, "Pick colour");
                    commit(gradePath.qualifier(node.id, "hue", "width"), 30, "Pick colour");
                    commit(gradePath.qualifier(node.id, "sat", "center"), s, "Pick colour");
                    commit(gradePath.qualifier(node.id, "lum", "center"), l, "Pick colour");
                    setQualifier(true);
                    setShowMatte(true);
                  }}
                  title="Eyedrop a colour and key it"
                >
                  <Target className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Eyedrop a colour and key it</TooltipContent>
            </Tooltip>
            <GroupKeyButton clip={clip} properties={bandPaths} />
            <Switch checked={key.qualifier.enabled} onCheckedChange={setQualifier} />
          </div>
        }
      >
        {!key.qualifier.enabled ? (
          <Note>Off — this node grades every pixel it is handed.</Note>
        ) : (
          BANDS.map((b) => (
            <div key={b.key} className="border-b border-border/40 pb-1.5 last:border-0 last:pb-0">
              <div className="px-0.5 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {b.label}
              </div>
              <GradeField
                clip={clip}
                cardId={cardId}
                suffix={gradePath.qualifier(node.id, b.key, "center")}
                label="Centre"
                base={key.qualifier[b.key].center}
                min={0}
                max={b.max}
                step={b.step}
                unit={b.unit}
              />
              <GradeField
                clip={clip}
                cardId={cardId}
                suffix={gradePath.qualifier(node.id, b.key, "width")}
                label="Width"
                base={key.qualifier[b.key].width}
                min={0}
                max={b.max}
                step={b.step}
                unit={b.unit}
              />
              <GradeField
                clip={clip}
                cardId={cardId}
                suffix={gradePath.qualifier(node.id, b.key, "softLow")}
                label="Soft low"
                base={key.qualifier[b.key].softLow}
                min={0}
                max={b.max / 2}
                step={b.step}
                hint="How far below the band the selection fades out. The shoulders are what keep an edge from looking cut."
              />
              <GradeField
                clip={clip}
                cardId={cardId}
                suffix={gradePath.qualifier(node.id, b.key, "softHigh")}
                label="Soft high"
                base={key.qualifier[b.key].softHigh}
                min={0}
                max={b.max / 2}
                step={b.step}
              />
            </div>
          ))
        )}
      </PanelSection>

      <PanelSection title="Matte" defaultOpen actions={<GroupKeyButton clip={clip} properties={mattePaths} />}>
        <GradeField
          clip={clip}
          cardId={cardId}
          suffix={gradePath.matte(node.id, "blurPx")}
          label="Blur"
          base={key.blurPx}
          min={0}
          max={64}
          step={1}
          unit="px"
          hint="Softens the finished selection. Two or three pixels is usually the difference between a key and a crawling edge."
        />
        <GradeField
          clip={clip}
          cardId={cardId}
          suffix={gradePath.matte(node.id, "shrinkPx")}
          label="Shrink"
          base={key.shrinkPx}
          min={-32}
          max={32}
          step={1}
          unit="px"
          bipolar
          hint="Pulls the selection in, or grows it out."
        />
        <GradeSwitch
          clip={clip}
          cardId={cardId}
          suffix={`n.${node.id}.k.invert`}
          label="Invert"
          base={key.invert}
          hint="Grade everything the key did NOT take."
        />
        {hasKeyInput && (
          <GradeSelect
            clip={clip}
            cardId={cardId}
            suffix={`n.${node.id}.k.input`}
            label="Incoming key"
            base={key.input}
            options={KEY_INPUT_OPTIONS}
            hint="How the key wired into this node meets the selection it builds for itself. Replace, plus Invert, is the outside node."
          />
        )}
      </PanelSection>

      {/* TODO(depth): a near/far band keys nothing until a depth estimator is
          wired up — the schema, the band maths and the provider seam all exist
          (`schema/grade.ts`, `grade/key.ts`). Sliders that move and key nothing
          are worse than an absent section, so there is no UI here yet. */}
    </div>
  );
}

// ── Windows ──────────────────────────────────────────────────────────────────

const WINDOW_SHAPES: Array<{ shape: TrackShape; Icon: typeof Square; label: string }> = [
  { shape: "ellipse", Icon: Circle, label: "Circle — drag it out on the canvas" },
  { shape: "rect", Icon: Square, label: "Box — drag it out on the canvas" },
  { shape: "polygon", Icon: Pentagon, label: "Polygon — drag it out on the canvas" },
  { shape: "path", Icon: PenTool, label: "Pen — trace the outline on the canvas" },
];

const COMBINE_OPTIONS = [
  { value: "union", label: "Add" },
  { value: "intersect", label: "Intersect" },
  { value: "subtract", label: "Subtract" },
] as const;

function WindowsTab({ clip, cardId, node }: { clip: VisualClip; cardId: string; node: CorrectorNode }) {
  const store = useDocStore();
  const doc = useDoc();
  const playheadMs = useParkedPlayhead();
  const arming = useRegionDraw((s) => (s.target?.kind === "window" && s.target.nodeId === node.id ? s.target : null));

  return (
    <div>
      <div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
        {WINDOW_SHAPES.map(({ shape, Icon, label }) => (
          <Tooltip key={shape}>
            <TooltipTrigger asChild>
              <Button
                variant={arming?.shape === shape ? "secondary" : "outline"}
                size="icon"
                className="size-7"
                onClick={() => beginWindowDraw({ clipId: clip.id, cardId, nodeId: node.id, shape })}
              >
                <Icon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
        {arming && <span className="ml-1 truncate text-[10px] text-primary">Draw it on the canvas…</span>}
      </div>

      {node.key.windows.length === 0 && !arming && (
        <div className="px-2 py-1.5">
          <Note>Pick a shape and draw it on the canvas to limit this correction.</Note>
        </div>
      )}

      {node.key.windows.map((win, i) => (
        <WindowSection
          key={win.id}
          clip={clip}
          cardId={cardId}
          nodeId={node.id}
          win={win}
          index={i}
          trackerName={trackerNameFor(doc.trackers, win)}
          onDelete={() => deletePowerWindow(store, clip.id, cardId, node.id, win.id)}
          onTrack={() => {
            // Making the tracker IS asking for the track: it starts at once, both ways.
            const id = trackPowerWindow(store, clip.id, cardId, node.id, win.id, clip.id, Math.max(0, playheadMs - clip.startMs));
            if (id) void startTrack(store, id, { kind: "all" });
          }}
          onUseTracker={(trackerId) => keyWindowToTracker(store, clip.id, cardId, node.id, win.id, trackerId)}
          canTrack={clip.kind === "video" || clip.kind === "image"}
        />
      ))}
    </div>
  );
}

/** The tracker a window follows, by name — null when it is gone, undefined when
 *  the window was never tracked. Three states, because they read differently. */
function trackerNameFor(trackers: readonly { id: string; name: string }[], win: PowerWindow): string | null | undefined {
  const source = win.source;
  if (source.type !== "tracker" && source.type !== "depth") return undefined;
  return trackers.find((t) => t.id === source.trackerId)?.name ?? null;
}

/** A depth window's band — what depth it keeps (0 the nearest thing in the shot, 1 the farthest). */
function DepthBand({ clip, cardId, nodeId, win, band }: { clip: VisualClip; cardId: string; nodeId: string; win: PowerWindow; band: { near: number; far: number; softness: number } }) {
  const store = useDocStore();
  const set = (patch: Partial<{ near: number; far: number; softness: number }>) => patchDepthWindow(store, clip.id, cardId, nodeId, win.id, patch);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <>
      <PropRow label="From" hint="The nearest depth the window keeps — 0% is the nearest thing in the shot.">
        <Range value={band.near} min={0} max={1} step={0.005} format={pct} onChange={(near) => set({ near })} />
      </PropRow>
      <PropRow label="To" hint="The farthest depth it keeps — 100% is the farthest.">
        <Range value={band.far} min={0} max={1} step={0.005} format={pct} onChange={(far) => set({ far })} />
      </PropRow>
      <PropRow label="Soft" hint="How gently the band's edges roll off.">
        <Range value={band.softness} min={0} max={0.5} step={0.005} format={pct} onChange={(softness) => set({ softness })} />
      </PropRow>
    </>
  );
}

function WindowSection({
  clip,
  cardId,
  nodeId,
  win,
  index,
  trackerName,
  onDelete,
  onTrack,
  onUseTracker,
  canTrack,
}: {
  clip: VisualClip;
  cardId: string;
  nodeId: string;
  win: PowerWindow;
  index: number;
  /** Set when the window follows a tracker; null when that tracker is gone. */
  trackerName?: string | null;
  onDelete: () => void;
  onTrack: () => void;
  onUseTracker: (trackerId: string) => void;
  canTrack: boolean;
}) {
  const shaped = win.source.type === "shape" ? win.source : null;
  const p = (f: string) => gradePath.window(nodeId, win.id, f);

  const fields = shaped ? ["x", "y", "scale", "rotation", "feather", "expand"] : ["feather", "expand"];
  const paths = fields.map((f) => ({
    property: layerEffectPath(cardId, p(f)),
    currentValue: () =>
      (f === "feather"
        ? win.feather
        : f === "expand"
          ? win.expand
          : ((shaped?.transform as unknown as Record<string, number>)[f] ?? 0)) as KeyframeValue,
  }));

  return (
    <PanelSection
      title={win.name || `Window ${index + 1}`}
      defaultOpen={index === 0}
      actions={
        <div className="flex items-center gap-0.5">
          <GroupKeyButton clip={clip} properties={paths} />
          <button
            type="button"
            onClick={onDelete}
            className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
            title="Remove window"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      }
    >
      {(trackerName !== undefined || canTrack) && (
        <PropRow label="Tracker" hint="A tracked window rides the tracker's outline — every frame, every correction. Any tracker of this footage can be shared by many windows.">
          <ObjectField
            filter={{ kinds: ["tracker"], frameId: clip.frameId, ...(clip.kind === "video" || clip.kind === "image" ? { tags: [`asset:${clip.assetId}`] } : {}) }}
            value={win.source.type === "tracker" || win.source.type === "depth" ? `tracker:${win.source.trackerId}` : null}
            noun="tracker"
            placeholder="Not tracked"
            missing="Tracker deleted"
            onChange={(c) => onUseTracker(c.id)}
          />
        </PropRow>
      )}
      {win.source.type === "depth" && <DepthBand clip={clip} cardId={cardId} nodeId={nodeId} win={win} band={win.source} />}

      {shaped && (
        <>
          <GradeField clip={clip} cardId={cardId} suffix={p("x")} label="X" base={shaped.transform.x} step={1} bipolar />
          <GradeField clip={clip} cardId={cardId} suffix={p("y")} label="Y" base={shaped.transform.y} step={1} bipolar />
          <GradeField
            clip={clip}
            cardId={cardId}
            suffix={p("scale")}
            label="Size"
            base={shaped.transform.scale}
            min={0.02}
            max={8}
            step={0.01}
          />
          <GradeField
            clip={clip}
            cardId={cardId}
            suffix={p("rotation")}
            label="Rotate"
            base={shaped.transform.rotation}
            min={-180}
            max={180}
            step={1}
            unit="°"
            bipolar
          />
        </>
      )}

      <GradeField
        clip={clip}
        cardId={cardId}
        suffix={p("feather")}
        label="Feather"
        base={win.feather}
        min={0}
        max={400}
        step={1}
        unit="px"
      />
      <GradeField
        clip={clip}
        cardId={cardId}
        suffix={p("expand")}
        label="Expand"
        base={win.expand}
        min={-200}
        max={200}
        step={1}
        unit="px"
        bipolar
      />
      <GradeSwitch
        clip={clip}
        cardId={cardId}
        suffix={p("invert")}
        label="Invert"
        base={win.invert}
        hint="Correct the outside of this window instead."
      />
      <GradeSelect
        clip={clip}
        cardId={cardId}
        suffix={p("combine")}
        label="Combine"
        base={win.combine}
        options={COMBINE_OPTIONS}
        hint="How this window folds into the ones above it."
      />

      {shaped && canTrack && (
        <Button variant="outline" size="sm" className="mt-1 h-7 w-full text-[11px]" onClick={onTrack}>
          <Target className="mr-1 size-3" /> Track this window
        </Button>
      )}
    </PanelSection>
  );
}

// ── Node identity ────────────────────────────────────────────────────────────

const BLEND_OPTIONS = BLEND_MODES.map((m) => ({
  value: m,
  label: m === "normal" ? "Normal" : m.replace(/-/g, " "),
}));

/**
 * A node's NAME, its bypass, and how its result lands on its input.
 *
 * Resolve names nodes and people lean on it — "the skin node", "the sky node" —
 * so the field is first and always editable rather than hidden behind a rename
 * command. Blend and opacity sit beside it because they are the other half of
 * what a corrector IS: a correction, how much of it, composited how. Both
 * keyframe, which is how a look fades in.
 */
function NodeIdentity({ clip, cardId, node }: { clip: VisualClip; cardId: string; node: GradeNode }) {
  const store = useDocStore();
  const corrector = node.kind === "corrector" ? node : null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <input
          value={node.name}
          placeholder={node.kind === "mixer" ? "Mixer" : "Node"}
          onChange={(e) => renameNode(store, clip.id, cardId, node.id, e.target.value)}
          className="h-6 min-w-0 flex-1 rounded bg-transparent px-1 text-[11px] font-medium outline-none hover:bg-muted/50 focus:bg-muted/60"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => toggleNode(store, clip.id, cardId, node.id)}
              className={cn(
                "grid size-6 place-items-center rounded transition-colors hover:bg-muted",
                node.enabled ? "text-muted-foreground" : "text-primary",
              )}
            >
              {node.enabled ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{node.enabled ? "Bypass this node" : "Enable this node"}</TooltipContent>
        </Tooltip>
      </div>

      {corrector && (
        <>
          <GradeSelect
            clip={clip}
            cardId={cardId}
            suffix={`n.${node.id}.blend`}
            label="Blend"
            base={corrector.blend}
            options={BLEND_OPTIONS}
            hint="How this node's corrected pixels composite over the ones it was handed."
          />
          <GradeField
            clip={clip}
            cardId={cardId}
            suffix={gradePath.node(node.id, "opacity")}
            label="Mix"
            base={corrector.opacity}
            min={0}
            max={1}
            step={0.01}
            hint="How much of this node's correction lands. The per-node wet/dry."
          />
        </>
      )}
    </div>
  );
}

/** Hex → HSL in the qualifier's own units (degrees, 0..1, 0..1). */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const n = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const c = max - min;
  if (c === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? c / (2 - max - min) : c / (max + min);
  let h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
  h *= 60;
  return { h: h < 0 ? h + 360 : h, s, l };
}
