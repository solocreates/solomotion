"use client";

import * as React from "react";
import {
  LFX,
  gradePath,
  layerEffectPath,
  sharedList,
  type CorrectorNode,
  type KeyframeValue,
  type LayerEffect,
  type LayerEffectType,
  type VisualClip,
} from "@solomotion/core";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { commitProperty } from "../inspector/animatable";
import { ColorGradeBody } from "../inspector/ColorGradeCard";
import { effectIcon, useBuiltinPresetNames } from "../inspector/LayerEffectsSection";
import { ensureEffectPasses } from "../stage/render/passes/registry";
import type { EffectStackHost } from "../inspector/effect-stack/host";
import type { EffectMenuItem } from "../inspector/effect-add-menu";
import { withGrade } from "./grade-actions";

/**
 * A CORRECTOR NODE, AS AN EFFECT STACK HOST.
 *
 * The colour page's first draft rendered its own little list of cards with a
 * line of apology under each one — "dial this from the layer's effect stack for
 * now". That is the exact failure `EffectStackHost` exists to prevent: the
 * section, the cards, the drag-sort, the floating editor, the preset picker,
 * the copy/paste verbs and the keyboard are written ONCE against this handle,
 * and every surface that has a list of effects implements the handle rather
 * than a second, worse list.
 *
 * A corrector's list is a plain `LayerEffect[]` on a node inside a `grade` card
 * inside the clip's own stack. So the only things this has to answer are WHERE
 * the list lives and HOW a field write is addressed — everything else is the
 * same as a layer's. The path is the whole difference:
 *
 *   a layer's card     lfx.<effectId>.<field>
 *   a corrector's      lfx.<cardId>.n.<nodeId>.fx.<effectId>.<field>
 *
 * which is why the path grammar was built as a suffix under the card's own
 * namespace (see `grade/paths.ts`). Nothing here had to be registered.
 */
export function useGradeNodeHost(
  clip: VisualClip,
  cardId: string,
  node: CorrectorNode,
): EffectStackHost<LayerEffect> {
  const store = useDocStore();
  const presetNames = useBuiltinPresetNames(LFX);

  const path = React.useCallback(
    (effectId: string, field: string) => layerEffectPath(cardId, gradePath.effect(node.id, effectId, field)),
    [cardId, node.id],
  );

  const update = React.useCallback(
    (label: string, fn: (list: LayerEffect[]) => LayerEffect[], mergeKey?: string) => {
      withGrade(
        store,
        clip.id,
        cardId,
        label,
        (graph) => {
          const n = graph.nodes.find((x) => x.id === node.id);
          if (n?.kind === "corrector") n.effects = fn(n.effects);
        },
        mergeKey,
      );
    },
    [store, clip.id, cardId, node.id],
  );

  const commit = React.useCallback(
    (effect: LayerEffect, field: string, value: KeyframeValue, label: string, mergeKey?: string) => {
      // Straight through the clip's own keyframe machinery: a grade path IS a
      // clip path, so record mode, auto-key and the curve editor all apply with
      // nothing added.
      store.update(
        label,
        (d) => {
          for (const track of d.tracks) {
            for (const c of track.clips) {
              if (c.id !== clip.id || c.kind === "audio") continue;
              commitProperty(c, path(effect.id, field), value, useSession.getState().playheadMs);
            }
          }
        },
        mergeKey ? { mergeKey } : undefined,
      );
    },
    [store, clip.id, path],
  );

  const setToggle = React.useCallback(
    (effect: LayerEffect, key: string, value: boolean, label: string) => {
      update(label, (list) =>
        list.map((e) => (e.id === effect.id ? ({ ...e, [key]: value } as LayerEffect) : e)),
      );
    },
    [update],
  );

  const items: EffectMenuItem[] = React.useMemo(
    () =>
      LFX.types
        // A grade inside a grade is a recursion nobody asked for, and the card
        // that owns this list is already the grade.
        .filter((def) => def.type !== "grade")
        .map((def) => ({
          type: def.type,
          label: def.label,
          blurb: def.blurb,
          keywords: [...(def.tags ?? []), ...(presetNames.get(def.type) ?? [])],
          category: def.category,
          icon: effectIcon(def.type),
          // "Specific" is the palette's own promotion flag. On this page the
          // colour family is what belongs at the top; everything else stays one
          // search away rather than being hidden.
          specific: def.category === "color",
        })),
    [presetNames],
  );

  return {
    registry: LFX,
    domain: "layer",
    icon: (t) => effectIcon(t as LayerEffectType),
    // Scoped by node, so the section's list selection and the floating editor
    // do not follow you from one corrector to the next.
    key: `${clip.id}:${cardId}:${node.id}`,
    clip,
    canKey: true,
    effects: node.effects,
    shared: sharedList([node.effects]),
    palette: { items, heading: "Colour" },
    kinds: [clip.kind],
    update,
    commit,
    pathOf: path,
    setToggle,
    prepare: (type) => void ensureEffectPasses([type as LayerEffectType]).catch(() => {}),
    // No clipboard domain: copying "effects" from here would paste a node's
    // list onto a layer's stack, which is a different list with a different
    // meaning. Copying a whole grade is the preset, and that is the honest verb.
    customBody: (effect) =>
      effect.type === "colorGrade" ? (
        <ColorGradeBody clip={clip} effect={effect} pathFor={(field) => path(effect.id, field)} />
      ) : undefined,
    title: "Grade",
    sectionId: `grade-${node.id}`,
    addLabel: "Add correction",
    noun: "correction",
  };
}
