"use client";

import * as React from "react";
import {
  VARIABLE_TRACK_KEY,
  paintProperty,
  sampleKeyframes,
  setKeyframe,
  setPaintProperty,
  type DocumentStore,
  type KeyframeValue,
  type Modulator,
  type Paint,
  type Variable,
} from "@solomotion/core";
import { useParkedPlayhead } from "../../state/session";
import type { PaintHost } from "../paint-host";
import type { ModulatorHost } from "../ModulatorControl";

/**
 * A PAINT VARIABLE as a paint host — so a shared gradient is edited in the
 * SAME editor as a layer's fill, not in a second one that would have to be
 * taught about stops, patterns and media all over again.
 *
 * The addressing is the only thing that differs. A layer's paint lives at
 * `fill.<id>.<sub>`; a variable's lives at `value.<sub>`, which is exactly the
 * key `variableValueAt` replays and `Variable.modulators` target. So a stop's
 * colour keyframes on a shared style through the same engine, the same curve
 * editor and the same dope sheet as everything else.
 *
 * `keyframeClip` is deliberately absent: a variable is not a clip, and the
 * diamond clusters that read one would have nothing to read. Keying a paint
 * variable happens through this host's `commit`, which writes a document-global
 * key at the playhead — the same rule the rest of the Variables window follows.
 */
export function useVariablePaintHost(store: DocumentStore, variable: Variable): PaintHost {
  const playheadMs = useParkedPlayhead();
  const paint = variable.type === "paint" ? variable.value : undefined;
  const modulatorHost = useVariableModulatorHost(store, variable);

  return React.useMemo<PaintHost>(() => {
    const editPaint = (label: string, fn: (p: Paint) => void, mergeKey?: string) =>
      store.update(
        label,
        (d) => {
          const v = d.variables.find((x) => x.id === variable.id);
          if (v?.type === "paint") fn(v.value);
        },
        mergeKey ? { mergeKey } : undefined,
      );

    return {
      key: `var:${variable.id}`,
      modulatorHost: { ...modulatorHost, target: variableModulatorPath },
      // The variable IS the one fill. A stroke list would be a lie — nothing in
      // the document asks a fill style to describe a line.
      fills: paint ? [paint] : [],
      strokes: [],
      update: (label, fn, mergeKey) =>
        store.update(
          label,
          (d) => {
            const v = d.variables.find((x) => x.id === variable.id);
            if (v?.type !== "paint") return;
            const draft = { fills: [v.value], strokes: [] };
            fn(draft);
            v.value = draft.fills[0]!;
          },
          mergeKey ? { mergeKey } : undefined,
        ),
      commit: (path, value, label, mergeKey) => {
        // `fill.<id>.<sub>` in, `value.<sub>` out — the host's whole job.
        const sub = path.replace(/^fill\.[^.]+\.?/, "");
        editPaint(
          label,
          (p) => {
            if (sub) setPaintProperty(p, sub, value);
            else if (p.type === "solid" && typeof value === "string") p.color = value;
          },
          mergeKey,
        );
        // Animated already? Then this edit is a KEY at the playhead, matching
        // record mode and the rest of this window. Not animated? It is a plain
        // edit, and nothing is created behind the user's back.
        const track = `${VARIABLE_TRACK_KEY}${sub ? `.${sub}` : ""}`;
        store.update(
          label,
          (d) => {
            const v = d.variables.find((x) => x.id === variable.id);
            if (v?.type !== "paint" || !v.keyframes?.some((t) => t.property === track)) return;
            setKeyframe(v.keyframes, track, playheadMs, value);
          },
          mergeKey ? { mergeKey } : undefined,
        );
      },
      read: (path) => {
        if (!paint) return undefined;
        const sub = path.replace(/^fill\.[^.]+\.?/, "");
        if (!sub) return paint.type === "solid" ? paint.color : undefined;
        const track = `${VARIABLE_TRACK_KEY}.${sub}`;
        const keyed = variable.keyframes?.some((t) => t.property === track)
          ? sampleKeyframes(variable.keyframes, playheadMs)[track]
          : undefined;
        return (keyed as KeyframeValue | undefined) ?? paintProperty(paint, sub);
      },
    };
  }, [store, variable, paint, playheadMs, modulatorHost]);
}

/**
 * A VARIABLE as a modulator host, so a shared gradient's angle can wiggle and a
 * shared accent can breathe.
 *
 * `clip` is absent, and that is the honest difference rather than a missing
 * feature: a clip's modulator can be scheduled against that clip's timeline,
 * and a document-level value has no clip to be scheduled against. The signal
 * still runs — it reads the document playhead, which is the same clock
 * `variableValueNow` resolves at — so the modulator's effect is live
 * everywhere the variable is used, all at once. That is what a shared value
 * breathing MEANS.
 */
export function useVariableModulatorHost(store: DocumentStore, variable: Variable): ModulatorHost {
  return React.useMemo(
    () => ({
      modulators: variable.modulators,
      timeSec: (playheadMs: number) => playheadMs / 1000,
      write: (label: string, fn: (list: Modulator[]) => void, mergeKey?: string) =>
        store.update(
          label,
          (d) => {
            const v = d.variables.find((x) => x.id === variable.id);
            if (!v) return;
            v.modulators ??= [];
            fn(v.modulators);
            // Never leave an empty array behind — `modulators` is optional so a
            // variable that was never modulated carries nothing into the file.
            if (v.modulators.length === 0) delete v.modulators;
          },
          mergeKey ? { mergeKey } : undefined,
        ),
    }),
    [store, variable],
  );
}

/**
 * A paint variable's modulator paths are `value.<sub>`, and its editor speaks
 * `fill.<id>.<sub>`. Translate once, here, next to the host that owns the same
 * translation for keyframes — two places doing this conversion is exactly how a
 * wiggle would end up targeting a path nothing reads.
 */
export function variableModulatorPath(path: string): string {
  const sub = path.replace(/^fill\.[^.]+\.?/, "");
  return sub ? `${VARIABLE_TRACK_KEY}.${sub}` : VARIABLE_TRACK_KEY;
}
