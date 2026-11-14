"use client";

import * as React from "react";
import { getClipProperty, locateClip, propertyDef, type Clip, type KeyframeValue, type PickFilter, type TraceClip, type TraceSpec } from "@solomotion/core";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/segmented";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { LayerRefField } from "../pick/ObjectField";
import { commitProperty } from "./animatable";
import { PanelSection, PropRow } from "./controls";
import { ValueField } from "./value-field";
import { ofKind, usePeers } from "./selection-scope";

const isTrace = ofKind("trace");

/**
 * THE TRACE — what it follows, how much of the past it keeps, how the head
 * cools into the tail, and the strobe. Every look value is a `trace.*` path,
 * so it carries its keyframe diamond and binding menu through the one field
 * renderer (`ValueField`) with its label and range from the registry
 * (`core/trace/fields.ts`); the structural choices (source, whole history,
 * ghosts on, ghost style, caps) are plain edits.
 */
export function TraceInspector({ clip }: { clip: TraceClip }) {
  const store = useDocStore();
  const peers = usePeers(clip, isTrace);
  const t = clip.trace;
  const edit = (label: string, fn: (s: TraceSpec) => void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        for (const p of peers) {
          const c = locateClip(d, p.id)?.clip;
          if (c?.kind === "trace") fn(c.trace);
        }
      },
      mergeKey ? { mergeKey } : undefined,
    );
  const filter: PickFilter = { kinds: ["layer"], frameId: clip.frameId, tags: ["visual"], exclude: [clip.id] };
  const shown = (len: number | null) => (len == null ? 2000 : len);

  return (
    <>
      <PanelSection
        title="Trace"
        hint="Where a point has been over the whole shot, sampled from its source at every instant — nothing is recorded, so editing the source redraws it."
      >
        <PropRow label="Follows" hint="A layer's point (keyed, an expression, a physics body). None = a pen: the trace draws its own position.">
          <div className="min-w-0 flex-1">
            <LayerRefField
              filter={filter}
              value={t.source.clipId}
              none="Its own position (pen)"
              onChange={(id) => edit("Trace source", (s) => void (s.source = { ...s.source, clipId: id }))}
            />
          </div>
        </PropRow>
        <TraceField clips={peers} path="trace.point.x" unit="px" slider={false} hint="The traced point, from the source's centre; it turns with the source." />
        <TraceField clips={peers} path="trace.point.y" unit="px" slider={false} />
        <PropRow label="Whole shot" hint="Keep everything since the trace began. Off = only the last Length." toggle>
          <Switch
            checked={t.lengthMs == null}
            onCheckedChange={(all) => edit("Trace length", (s) => void (s.lengthMs = all ? null : shown(s.lengthMs)))}
          />
        </PropRow>
        {t.lengthMs != null && <TraceField clips={peers} path="trace.lengthMs" unit="ms" slider={false} />}
        <SpecNumber label="Samples / s" value={t.rate} min={1} max={2000} step={1} hint="How finely the past bends. The head is always exact." onChange={(v) => edit("Trace samples", (s) => void (s.rate = v), "trace-rate")} />
      </PanelSection>

      <PanelSection title="Cooling" hint="Each point cools from the head's look to the tail's by its age.">
        <TraceField clips={peers} path="trace.head.color" />
        <TraceField clips={peers} path="trace.head.width" unit="px" />
        <TraceField clips={peers} path="trace.head.opacity" />
        <TraceField clips={peers} path="trace.tail.color" />
        <TraceField clips={peers} path="trace.tail.width" unit="px" />
        <TraceField clips={peers} path="trace.tail.opacity" />
        <PropRow label="Over the trace" hint="Cool across whatever is visible, so the oldest point is always fully the tail. Off = a fixed cooling time." toggle>
          <Switch
            checked={t.coolMs == null}
            onCheckedChange={(span) => edit("Trace cooling", (s) => void (s.coolMs = span ? null : 1000))}
          />
        </PropRow>
        {t.coolMs != null && <TraceField clips={peers} path="trace.coolMs" unit="ms" slider={false} />}
        <TraceField clips={peers} path="trace.falloff" hint="1 = even. Above 1 the head holds its heat, below 1 it cools fast." />
        <PropRow label="Caps">
          <Segmented
            value={t.cap}
            onChange={(cap) => edit("Trace caps", (s) => void (s.cap = cap))}
            options={[
              { value: "round", label: "Round" },
              { value: "butt", label: "Flat" },
            ]}
            stretch
            aria-label="Caps"
          />
        </PropRow>
      </PanelSection>

      <PanelSection title="Ghosts" hint="A strobe: the source drawn again every Δt, on a grid fixed to the trace's start.">
        <PropRow label="Strobe" toggle>
          <Switch checked={t.ghosts.enabled} onCheckedChange={(on) => edit("Trace ghosts", (s) => void (s.ghosts.enabled = on))} />
        </PropRow>
        {t.ghosts.enabled && (
          <>
            <TraceField clips={peers} path="trace.ghosts.everyMs" unit="ms" slider={false} />
            <PropRow label="Draw as" hint="Copies of the source as it looked then, or dots in the trace's colour.">
              <Segmented
                value={t.ghosts.style}
                onChange={(style) => edit("Ghost style", (s) => void (s.ghosts.style = style))}
                options={[
                  { value: "source", label: "Copies" },
                  { value: "dot", label: "Dots" },
                ]}
                stretch
                aria-label="Draw as"
              />
            </PropRow>
            {t.ghosts.style === "dot" && <TraceField clips={peers} path="trace.ghosts.size" unit="px" />}
            <TraceField clips={peers} path="trace.ghosts.opacity" />
            <PropRow label="Cool with age" toggle>
              <Switch checked={t.ghosts.fade} onCheckedChange={(on) => edit("Ghosts fade", (s) => void (s.ghosts.fade = on))} />
            </PropRow>
            <SpecNumber
              label="Most"
              value={t.ghosts.count ?? 0}
              min={0}
              max={1000}
              step={1}
              hint="The newest N ghosts. 0 = every ghost in the visible trace."
              onChange={(v) => edit("Ghost count", (s) => void (s.ghosts.count = v > 0 ? Math.round(v) : null), "trace-ghost-count")}
            />
          </>
        )}
      </PanelSection>
    </>
  );
}

/** One `trace.*` value across the selection: keyable, bindable, its label and range the registry's. */
function TraceField({ clips, path, unit, hint, slider = true }: { clips: readonly Clip[]; path: string; unit?: string; hint?: string; slider?: boolean }) {
  const store = useDocStore();
  const clip = clips[0]!;
  const def = propertyDef(path);
  const base = getClipProperty(clip, path) ?? def?.identity ?? 0;
  const name = def?.label ?? path;
  return (
    <ValueField
      layout="inspector"
      clip={clip}
      canKey
      path={path}
      kind={def?.kind === "color" ? "color" : "number"}
      label={name}
      base={base}
      min={def?.min}
      max={slider ? def?.max : undefined}
      step={def?.step}
      unit={unit}
      hint={hint}
      mixed={clips.some((c) => getClipProperty(c, path) !== base)}
      defaultValue={def?.identity}
      onChange={(v) =>
        store.update(
          `Set ${name}`,
          (d) => {
            const at = useSession.getState().playheadMs;
            for (const c of clips) {
              const loc = locateClip(d, c.id);
              if (loc) commitProperty(loc.clip, path, v, at);
            }
          },
          { mergeKey: `trace-${path}` },
        )
      }
    />
  );
}

/** A structural number (never keyed), in the same row grammar. */
function SpecNumber(props: { label: string; value: number; min: number; max: number; step: number; hint?: string; onChange: (v: number) => void }) {
  return (
    <ValueField
      layout="inspector"
      clip={null}
      canKey={false}
      path=""
      kind="number"
      label={props.label}
      base={props.value}
      min={props.min}
      step={props.step}
      hint={props.hint}
      modulatable={false}
      onChange={(v: KeyframeValue) => props.onChange(Math.min(props.max, Math.max(props.min, Number(v))))}
    />
  );
}
