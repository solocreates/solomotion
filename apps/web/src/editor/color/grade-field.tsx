"use client";

import * as React from "react";
import {
  findVisualClip,
  layerEffectPath,
  type EffectFieldOption,
  type KeyframeValue,
  type VisualClip,
} from "@solomotion/core";
import { Switch } from "@/components/ui/switch";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { commitProperty } from "../inspector/animatable";
import { PropRow } from "../inspector/controls";
import { KeyControl } from "../inspector/keyframe-controls";
import { ValueField } from "../inspector/value-field";

/**
 * A FIELD INSIDE A GRADE, keyframable like everything else in the app.
 *
 * The Color page's first draft wired its own sliders straight into the
 * document. They worked, and nothing in them could be animated, recorded,
 * curved, driven or interpolated — which on a page whose entire job is
 * controlled change is most of the value gone.
 *
 * Nothing new was needed to fix it. The grade path grammar already addresses
 * every value inside a node (`grade/paths.ts`), `ValueField` is already the one
 * row behind every animatable value in the app, and `commitProperty` already
 * routes a write to a key or to the base depending on record mode. This is the
 * fifteen lines that connect them — and the reason it is fifteen lines is that
 * the grammar was built as a suffix under the card's own namespace on purpose.
 */

/** Write one grade value at the playhead, keyframe-aware. */
export function useGradeCommit(clip: VisualClip, cardId: string) {
  const store = useDocStore();
  return React.useCallback(
    (suffix: string, value: KeyframeValue, label: string) => {
      const path = layerEffectPath(cardId, suffix);
      store.update(
        label,
        (d) => {
          const c = findVisualClip(d, clip.id);
          if (c) commitProperty(c, path, value, useSession.getState().playheadMs);
        },
        { mergeKey: `grade-${clip.id}-${path}` },
      );
    },
    [store, clip.id, cardId],
  );
}

export interface GradeFieldProps {
  clip: VisualClip;
  cardId: string;
  /** The path suffix under the card (`gradePath.*` builds these). */
  suffix: string;
  label: string;
  base: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  bipolar?: boolean;
  slider?: boolean;
}

export function GradeField({ clip, cardId, suffix, label, base, ...rest }: GradeFieldProps) {
  const commit = useGradeCommit(clip, cardId);
  return (
    <ValueField
      clip={clip}
      canKey
      path={layerEffectPath(cardId, suffix)}
      kind="number"
      label={label}
      base={base}
      onChange={(v) => commit(suffix, v, label)}
      {...rest}
    />
  );
}

/** A choice inside a grade — blend mode, a combine rule. Discrete, so it holds. */
export function GradeSelect({
  clip,
  cardId,
  suffix,
  label,
  base,
  options,
  hint,
}: {
  clip: VisualClip;
  cardId: string;
  suffix: string;
  label: string;
  base: string;
  options: readonly EffectFieldOption[];
  hint?: string;
}) {
  const commit = useGradeCommit(clip, cardId);
  return (
    <ValueField
      clip={clip}
      canKey
      path={layerEffectPath(cardId, suffix)}
      kind="select"
      label={label}
      base={base}
      options={options}
      hint={hint}
      onChange={(v) => commit(suffix, v, label)}
    />
  );
}

/**
 * A switch inside a grade. `ValueField` has no boolean arm and should not grow
 * one — a two-state value is a switch, not a slider with two stops — so this is
 * the app's ordinary `PropRow` + `Switch` with the SAME diamond beside it, and
 * the write goes through the same keyframe-aware commit. A discrete property
 * holds between keys, which is what makes "this window is inverted from 00:04"
 * an ordinary animation.
 */
export function GradeSwitch({
  clip,
  cardId,
  suffix,
  label,
  base,
  hint,
}: {
  clip: VisualClip;
  cardId: string;
  suffix: string;
  label: string;
  base: boolean;
  hint?: string;
}) {
  const commit = useGradeCommit(clip, cardId);
  const path = layerEffectPath(cardId, suffix);
  return (
    <PropRow label={label} hint={hint}>
      <div className="flex w-full items-center gap-1">
        <Switch checked={base} onCheckedChange={(on) => commit(suffix, on, label)} />
        <div className="ml-auto">
          <KeyControl clip={clip} property={path} currentValue={() => base} label={label} />
        </div>
      </div>
    </PropRow>
  );
}
