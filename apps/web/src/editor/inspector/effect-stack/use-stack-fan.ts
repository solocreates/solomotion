"use client";

import * as React from "react";
import {
  cloneValue,
  createId,
  locateClip,
  propagateListEdit,
  remapEntryPath,
  sharedList,
  type BaseEffect,
  type Clip,
  type EffectRegistry,
  type EffectTypeDefBase,
  type KeyframeValue,
  type SharedList,
} from "@solomotion/core";
import { commitProperty } from "../animatable";
import { useDocStore } from "../../state/document-context";
import { useSession } from "../../state/session";

/**
 * A stack that lives on N clips, edited as one.
 *
 * The section edits the PRIMARY's list and hands the result back; this
 * replays that edit onto every sibling through `propagateListEdit` — add,
 * remove, reorder, retype, any field however deep — and re-addresses a field
 * write by index so `lfx.<primaryId>.blur` lands on each sibling's own card.
 * A selection of one is the degenerate case with no siblings, which is why
 * there is no separate single-clip path to disagree with this one.
 *
 * Keyframe tracks follow the cards: a removed card's tracks go with it, on
 * every clip, so an orphaned `lfx.<id>.*` track never keeps a dead card's
 * animation alive in the curve editor.
 */
export function useStackFan<E extends BaseEffect>(opts: {
  clips: Clip[];
  registry: EffectRegistry<E, EffectTypeDefBase<E>>;
  read: (clip: Clip) => E[];
  write: (clip: Clip, list: E[]) => void;
}) {
  const store = useDocStore();
  const { clips, registry, read, write } = opts;
  const primary = clips[0]!;
  const effects = read(primary);
  const shared: SharedList<E> = React.useMemo(
    () => sharedList(clips.map(read)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clips.map((c) => read(c))],
  );

  const targets = (d: Parameters<Parameters<typeof store.update>[1]>[0]): Clip[] =>
    clips.map((c) => locateClip(d, c.id)?.clip).filter((c): c is Clip => c !== undefined);

  const clone = (e: E): E => ({ ...cloneValue(e), id: createId(registry.prefix) });
  const dropTracks = (clip: Clip, ids: readonly string[]) => {
    if (ids.length === 0) return;
    const gone = new Set(ids.map((id) => `${registry.prefix}.${id}.`));
    clip.keyframes = clip.keyframes.filter((t) => ![...gone].some((p) => t.property.startsWith(p)));
  };

  const update = (label: string, fn: (list: E[]) => E[], mergeKey?: string, each?: (clip: Clip) => void) =>
    store.update(
      label,
      (d) => {
        const all = targets(d);
        const first = all[0];
        if (!first) return;
        if (each) for (const c of all) each(c);
        const before = cloneValue(read(first));
        const after = fn([...read(first)]);
        write(first, after);
        const kept = new Set(after.map((e) => e.id));
        dropTracks(first, before.filter((e) => !kept.has(e.id)).map((e) => e.id));
        for (const sib of all.slice(1)) {
          const { list, removedIds } = propagateListEdit(before, after, read(sib), clone);
          write(sib, list);
          dropTracks(sib, removedIds);
        }
      },
      mergeKey ? { mergeKey } : undefined,
    );

  const commit = (effect: E, field: string, value: KeyframeValue, label: string, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        const all = targets(d);
        const first = all[0];
        if (!first) return;
        const path = registry.path(effect.id, field);
        const from = read(first);
        const playhead = useSession.getState().playheadMs;
        for (const c of all) {
          const to = c === first ? from : read(c);
          const remapped = c === first ? path : remapEntryPath(path, from, to);
          if (remapped) commitProperty(c, remapped, value, playhead);
        }
      },
      mergeKey ? { mergeKey } : undefined,
    );

  const setToggle = (effect: E, key: string, value: boolean, label: string) =>
    update(label, (list) => list.map((e) => (e.id === effect.id ? { ...e, [key]: value } : e)));

  return { effects, shared, update, commit, setToggle };
}
