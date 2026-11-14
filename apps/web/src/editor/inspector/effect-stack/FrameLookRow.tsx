"use client";

import * as React from "react";
import {
  applyLookAsGroup,
  ensureFrameEffectClipIn,
  frameEffectClip,
  type Frame,
  type LayerEffectType,
  type Preset,
} from "@solomotion/core";
import { useDoc, useDocStore } from "../../state/document-context";
import { useParkedPlayhead } from "../../state/session";
import { ensureEffectPasses } from "../../stage/render/passes/registry";
import { LookRow, type LookTarget } from "./LookGallery";

/**
 * A FRAME'S LOOK — the same row and gallery every layer has, inline (the
 * first six tiles in the panel), landing on the frame's own effects clip:
 * made on first use, the look inserted as a group (what the frame already
 * wears stays), a look with a rate holding the whole frame on it. One undo
 * step for all of it. This replaces the Texture chip grid, which REPLACED the
 * frame's stack and was the only place looks reached.
 */
export function FrameLookRow({ frame }: { frame: Frame }) {
  const doc = useDoc();
  const store = useDocStore();
  const playheadMs = useParkedPlayhead();
  const clip = frameEffectClip(doc, frame.id);

  const target: LookTarget = {
    effects: clip?.effects ?? [],
    subject: { doc, frame, clip: null, timeMs: playheadMs },
    apply: (preset: Preset, into) => {
      const types = (Array.isArray(preset.data) ? (preset.data as Array<{ type?: string }>) : []).map((e) => e.type as LayerEffectType);
      void ensureEffectPasses(types.filter(Boolean)).catch(() => {});
      store.update(`Apply ${preset.name}`, (d) => {
        const fx = ensureFrameEffectClipIn(d, frame.id);
        if (!fx) return;
        const out = applyLookAsGroup(fx.effects, { domain: "layer", preset }, into);
        const gone = out.removed.map((id) => `lfx.${id}.`);
        if (gone.length) fx.keyframes = fx.keyframes.filter((t) => !gone.some((p) => t.property.startsWith(p)));
        fx.effects = out.effects;
        if (preset.fps) fx.fps = preset.fps;
      });
    },
    remove: (gid) => {
      store.update("Remove look", (d) => {
        const fx = ensureFrameEffectClipIn(d, frame.id);
        if (!fx) return;
        const gone = new Set(fx.effects.filter((e) => e.id === gid || e.group === gid).map((e) => e.id));
        fx.keyframes = fx.keyframes.filter((t) => ![...gone].some((id) => t.property.startsWith(`lfx.${id}.`)));
        fx.effects = fx.effects.filter((e) => !gone.has(e.id));
      });
    },
  };
  return <LookRow target={target} inline />;
}
