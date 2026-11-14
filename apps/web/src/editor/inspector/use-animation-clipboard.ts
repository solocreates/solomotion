"use client";

import * as React from "react";
import {
  captureLayerAnimation,
  captureTextAnimation,
  toLayerAnimation,
  toTextAnimation,
  type AnimationPresetDef,
  type AnimationSpec,
  type LayerAnimationSpec,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { copyAnimation, readAnimation } from "../state/clip-actions";
import type { AccordionClipboard } from "./controls";

/**
 * ONE clipboard for every animation section — a layer's entrance or exit, a
 * text layer's glyph phases, and whatever section next carries one preset.
 * Each returns the `AccordionClipboard` its header wants, built from the
 * same three verbs: capture what is here, convert what is on the clipboard
 * to what this section can hold, clear. The conversion is core's
 * (`animation-transfer`), so an edge that cannot take a preset says so
 * instead of silently taking a different one.
 */

/** A whole-layer edge: `animIn` or `animOut`. */
export function useLayerEdgeClipboard(
  spec: LayerAnimationSpec | null,
  presets: readonly AnimationPresetDef[],
  onChange: (spec: LayerAnimationSpec | null) => void,
): AccordionClipboard {
  return React.useMemo(
    () => ({
      noun: "animation",
      copy: spec
        ? () => {
            void copyAnimation(captureLayerAnimation(spec));
            toast("Animation copied");
          }
        : undefined,
      paste: () => {
        void readAnimation().then((cap) => {
          if (!cap) return toast("No animation on the clipboard");
          const next = toLayerAnimation(cap, presets);
          if (!next) return toast.error("That animation isn't offered on this layer");
          onChange(next);
        });
      },
      clear: spec ? () => onChange(null) : undefined,
    }),
    [spec, presets, onChange],
  );
}

/** A text layer's glyph phase: `animations.in` or `animations.out`. */
export function useTextPhaseClipboard(
  spec: AnimationSpec | null,
  onChange: (spec: AnimationSpec | null) => void,
): AccordionClipboard {
  return React.useMemo(
    () => ({
      noun: "animation",
      copy: spec
        ? () => {
            void copyAnimation(captureTextAnimation(spec));
            toast("Animation copied");
          }
        : undefined,
      paste: () => {
        void readAnimation().then((cap) => {
          if (!cap) return toast("No animation on the clipboard");
          const next = toTextAnimation(cap);
          if (!next) return toast.error("That animation moves whole layers, not letters");
          onChange(next);
        });
      },
      clear: spec ? () => onChange(null) : undefined,
    }),
    [spec, onChange],
  );
}
