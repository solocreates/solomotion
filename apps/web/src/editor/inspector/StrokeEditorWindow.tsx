"use client";

import * as React from "react";
import {
  STROKE_PRESET_KIND,
  applyStrokeSet,
  isDefaultPipeline,
  strokeSetFrom,
  strokeSetPatch,
  strokeStyle,
  type Preset,
  type StrokeSet,
} from "@solomotion/core";
import { Spline } from "lucide-react";
import { EffectEditorWindow } from "./effect-editor/EffectEditorWindow";
import { useEffectEditor } from "./effect-editor/store";
import { StrokeFields } from "./StrokeFields";
import { StrokePreview } from "./StrokePreview";
import type { StrokeHost } from "./stroke-host";

/**
 * A stroke, in THE floating editor window.
 *
 * It is the effect editor — the same window, chrome, preset picker, pin,
 * reset, scroll and container-relative layout — handed a stroke instead of an
 * effect. That reuse is the point: a stroke has thirty knobs across five
 * stages, which is exactly the problem the effect window was built to solve,
 * and a bespoke stroke window would have re-earned resizing, remembered sizes,
 * outside-click rules and preset scopes by hand and then drifted from them.
 *
 * Only the two genuinely stroke-shaped things are supplied: the BODY is the
 * shared `StrokeFields` panel (also mounted, unchanged, inside the Brush
 * Studio), and the PREVIEW is the line itself rather than an A/B of the layer —
 * a before/after picture cannot show you a dash offset.
 */
export function StrokeEditorWindow({ host }: { host: StrokeHost }) {
  const openId = useEffectEditor((s) => s.openId);
  const stroke = host.strokes.find((s) => strokeWindowId(host.key, s.id) === openId);
  if (!stroke) return null;

  const set = strokeSetFrom(stroke);

  return (
    <EffectEditorWindow
      spec={{
        effectId: stroke.id,
        clip: host.keyframeClip ?? null,
        title: "Stroke",
        icon: Spline,
        enabled: stroke.enabled,
        canKey: !!host.keyframeClip,
        presetKind: STROKE_PRESET_KIND,
        fields: [],
        value: () => 0,
        defaults: {},
        toggleValue: () => false,
        pathFor: (key) => `stroke.${stroke.id}.${key}`,
        onCommit: () => {},
        onToggle: () => {},
        onEnable: (v) =>
          host.update(v ? "Show stroke" : "Hide stroke", (c) => {
            const s = c.strokes.find((x) => x.id === stroke.id);
            if (s) s.enabled = v;
          }),
        onRemove: () =>
          host.update("Remove stroke", (c) => {
            c.strokes = c.strokes.filter((s) => s.id !== stroke.id);
          }),
        onReset: () =>
          host.update("Reset stroke", (c) => {
            const s = c.strokes.find((x) => x.id === stroke.id);
            if (s) Object.assign(s, { ...strokeStyle(s.paint), id: s.id, width: s.width, enabled: s.enabled });
          }),
        capture: () => strokeSetPatch(set),
        onApplyPreset: (data: unknown, _preset: Preset) =>
          host.update("Apply stroke set", (c) => {
            const s = c.strokes.find((x) => x.id === stroke.id);
            if (s) Object.assign(s, applyStrokeSet(s, { ...(data as StrokeSet), id: s.id }));
          }),
        chip: () => (stroke.paint.type === "solid" ? [stroke.paint.color, stroke.paint.color] : null),
        presetName: isDefaultPipeline(stroke) ? "My line" : "My stroke",
        customPreview: (
          <div className="flex h-16 items-center justify-center rounded-md bg-[--panel] px-2">
            <StrokePreview stack={[set]} shape="wave" className="h-14 w-full text-foreground/85" />
          </div>
        ),
        customBody: <StrokeFields host={host} strokeId={stroke.id} />,
      }}
      key={stroke.id}
    />
  );
}

/** The window id for one stroke. Namespaced by host so two layers' strokes can
 *  never collide in the single-window store. */
export function strokeWindowId(hostKey: string, strokeId: string): string {
  return `stroke:${hostKey}:${strokeId}`;
}
