"use client";

import * as React from "react";
import {
  type AnimationPresetDef,
  LAYER_ANIMATION_PRESETS,
  type PresetParamDef,
  getPreset,
  isVisualClip,
  layerPresetsFor,
  retargetLayerSpec,
  type LayerAnimationSpec,
  type VisualClip,
} from "@solomotion/core";
import { ArrowRightFromLine, ArrowRightToLine } from "lucide-react";
import { EasingBlock } from "@/components/ui/easing-editor";
import { NumberInput } from "@/components/ui/number-input";
import { Range } from "@/components/ui/range";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useDoc } from "../state/document-context";
import { Accordion, AccordionItem, AccordionMeta, PropRow } from "./controls";
import { AnimationStage } from "./preset-picker";
import { useClipUpdater } from "./use-clip-updater";
import { useLayerEdgeClipboard } from "./use-animation-clipboard";
import { mergeReads } from "./merge";
import { usePeers } from "./selection-scope";

/**
 * The universal Animate tab — whole-layer in/out animations for ANY visual
 * clip (shape, path, image, video, nested comp, waveform… and texts as a
 * layer-level motion on top of their glyph animations). Same preset library
 * as the text animator, same easing panel as everywhere else. Editing writes
 * `clip.animIn`/`animOut` (v27); the renderer composites, the timeline shades
 * the clip and grows drag handles, exports translate it.
 *
 * The tab is built around the ONE thing being chosen: each edge opens with a
 * stage playing its animation, tuned, at panel width. Before this it opened
 * with the animation's NAME in a combobox and its easing behind a second
 * popover — the two visual decisions in the panel were the two you could not
 * see, and every field under them was a number with nothing to check against.
 */
/**
 * The two whole-layer edges, as accordion items. The tab composes them — for a
 * text clip they sit under the two glyph-level phases in ONE accordion, which
 * is the only way "which of these four am I editing?" has an answer.
 */
export function LayerAnimateItems({
  clip,
  titles = ["Animate in", "Animate out"],
}: {
  clip: VisualClip;
  titles?: [string, string];
}) {
  const doc = useDoc();
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, isVisualClip);
  const set = React.useCallback(
    (edge: "animIn" | "animOut", spec: LayerAnimationSpec | null) =>
      update(edge === "animIn" ? "Change in animation" : "Change out animation", (c) => {
        if (c.kind === "audio") return;
        // Cloned per layer, so a selection never shares one spec object.
        c[edge] = spec ? structuredClone(spec) : null;
      }),
    [update],
  );
  // What EVERY one of these layers can do — a draw-on is offered only where
  // each of them has a line.
  const presets = React.useMemo(() => {
    const [first, ...rest] = peers.map((c) => layerPresetsFor(doc, c));
    return rest.reduce((acc, list) => acc.filter((p) => list.some((q) => q.id === p.id)), first ?? []);
  }, [doc, peers]);
  const sameSpec = (a: LayerAnimationSpec | null, b: LayerAnimationSpec | null) => JSON.stringify(a) === JSON.stringify(b);
  const inMixed = mergeReads(peers, (c) => c.animIn, sameSpec).mixed;
  const outMixed = mergeReads(peers, (c) => c.animOut, sameSpec).mixed;
  const setIn = React.useCallback((s: LayerAnimationSpec | null) => set("animIn", s), [set]);
  const setOut = React.useCallback((s: LayerAnimationSpec | null) => set("animOut", s), [set]);
  const inClipboard = useLayerEdgeClipboard(clip.animIn, presets, setIn);
  const outClipboard = useLayerEdgeClipboard(clip.animOut, presets, setOut);

  return (
    <>
      <AccordionItem
        id="layer-in"
        title={titles[0]}
        icon={<ArrowRightToLine />}
        meta={inMixed ? <AccordionMeta>Mixed</AccordionMeta> : <EdgeBadge spec={clip.animIn} />}
        clipboard={inClipboard}
      >
        <LayerAnimationEditor spec={clip.animIn} phase="in" presets={presets} onChange={(s) => set("animIn", s)} />
      </AccordionItem>
      <AccordionItem
        id="layer-out"
        title={titles[1]}
        icon={<ArrowRightFromLine />}
        meta={outMixed ? <AccordionMeta>Mixed</AccordionMeta> : <EdgeBadge spec={clip.animOut} />}
        clipboard={outClipboard}
      >
        <LayerAnimationEditor spec={clip.animOut} phase="out" presets={presets} onChange={(s) => set("animOut", s)} />
      </AccordionItem>
    </>
  );
}

/**
 * What this edge is doing, readable with the item COLLAPSED. "Does this layer
 * animate in?" was a question you answered by opening two sections and reading
 * two comboboxes.
 */
export function EdgeBadge({ spec }: { spec: LayerAnimationSpec | null }) {
  const def = spec ? getPreset(spec.preset) : undefined;
  if (!spec || !def) return <AccordionMeta muted>None</AccordionMeta>;
  return (
    <>
      <AccordionMeta>{def.label}</AccordionMeta>
      <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/60">
        {spec.durationMs}
      </span>
    </>
  );
}

export function LayerAnimationEditor({
  spec,
  onChange,
  phase = "in",
  presets = LAYER_ANIMATION_PRESETS,
}: {
  spec: LayerAnimationSpec | null;
  onChange: (spec: LayerAnimationSpec | null) => void;
  phase?: "in" | "out";
  /** The gallery — scoped by the caller to what its layer can do. */
  presets?: AnimationPresetDef[];
}) {
  const def = spec ? getPreset(spec.preset) : undefined;
  return (
    <div className="grid min-w-0 gap-1.5">
      <AnimationStage
        presets={presets}
        value={spec?.preset ?? null}
        sample="layer"
        phase={phase}
        spec={spec}
        emptyLabel={phase === "in" ? "Add an entrance" : "Add an exit"}
        onSelect={(id) => onChange(id === null ? null : retargetLayerSpec(spec, id))}
      />

      {spec && (
        <>
          <PropRow label="Duration">
            <NumberInput
              value={spec.durationMs}
              min={0}
              max={10000}
              step={10}
              precision={0}
              unit="ms"
              onChange={(v) => onChange({ ...spec, durationMs: v })}
            />
          </PropRow>

          {/* Preset knobs are FEEL, not figures — a distance or a blur is judged
              against the stage above, so they get the bar you can sweep rather
              than a box you type into. Every one already declares its range; a
              CHOICE declares its options and gets the segmented row instead. */}
          {def?.params.map((p) =>
            paramShown(p, spec.params) ? (
              <ParamControl
                key={p.key}
                def={p}
                value={spec.params[p.key] ?? p.defaultValue}
                onChange={(v) => onChange({ ...spec, params: { ...spec.params, [p.key]: v } })}
              />
            ) : null,
          )}

          <EasingBlock
            value={spec.easing}
            onChange={(easing) => onChange({ ...spec, easing })}
          />
        </>
      )}
    </div>
  );
}

/**
 * The whole-layer in/out pair as a SECTION — one accordion, so the tab shows a
 * table of contents rather than two open editors stacked to 900px. Text reaches
 * these same items through its own accordion, which is why they are items and
 * this is only the frame around them.
 */
export function LayerAnimateSection({ clip }: { clip: VisualClip }) {
  return (
    <Accordion defaultOpen="layer-in">
      <LayerAnimateItems clip={clip} />
    </Accordion>
  );
}

/** A knob that only applies under another knob's setting says so itself. */
function paramShown(p: PresetParamDef, params: Record<string, number>): boolean {
  return p.when ? p.when(params) : true;
}

/** One preset knob, rendered from its declaration: a choice or a quantity. */
export function ParamControl({
  def: p,
  value,
  onChange,
}: {
  def: PresetParamDef;
  value: number;
  onChange: (v: number) => void;
}) {
  if (p.options) {
    return (
      <PropRow label={p.label} hint={p.hint}>
        <ToggleGroup
          type="single"
          size="sm"
          className="justify-start"
          value={String(Math.round(value))}
          onValueChange={(v) => v && onChange(Number(v))}
        >
          {p.options.map((o) => (
            <ToggleGroupItem key={o.value} value={String(o.value)} className="px-2 text-[11px]">
              {o.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PropRow>
    );
  }
  return (
    <PropRow label={p.hint ? p.label : undefined} hint={p.hint} wide={!p.hint}>
      <Range
        label={p.hint ? undefined : p.label}
        value={value}
        min={p.min}
        max={p.max}
        step={p.step}
        defaultValue={p.defaultValue}
        precision={p.step < 1 ? 2 : 0}
        unit={p.unit === "px" ? "px" : undefined}
        format={p.unit === "%" ? (v) => `${Math.round(v * 100)}%` : undefined}
        onChange={onChange}
      />
    </PropRow>
  );
}
