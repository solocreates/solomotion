"use client";

import * as React from "react";
import {
  cloneValue,
  commitPaintFork,
  createId,
  detach,
  emptyOverlay,
  getCarrierPaintProperty,
  getClipProperty,
  locateClip,
  propagateListEdit,
  remapEntryPath,
  resolveContourStyle,
  setContourOverride,
  setCarrierPaintProperty,
  sharedList,
  type MotionDocument,
  type Clip,
  type DocumentStore,
  type Frame,
  type KeyframeTrack,
  type KeyframeValue,
  type Paint,
  type StrokeStyle,
} from "@solomotion/core";
import { useDocStore } from "../state/document-context";
import { commitProperty } from "./animatable";
import { useSession } from "../state/session";
import { useClipUpdater } from "./use-clip-updater";
import type { PaintableClip } from "./PaintPopover";
import type { ModulatorHost } from "./ModulatorControl";
import { useScope } from "./scope";
import { scopeKey } from "@solomotion/core";

/**
 * A headless handle onto ANY object that owns the unified fills/strokes lists —
 * a visual clip OR a frame (artboard). This is what lets one `PaintList` /
 * `PaintEditorBody` serve every surface: they talk to a `PaintHost`, never to a
 * clip directly. A clip host keyframes (writes go through the keyframe engine,
 * ◆ clusters show); a frame host just base-mutates. Nothing else differs.
 */
export interface PaintCarrierDraft {
  fills: Paint[];
  strokes: StrokeStyle[];
  keyframes?: KeyframeTrack[];
}

export interface PaintHost {
  /** Stable id for dnd + session (clip id / frame id). */
  key: string;
  fills: Paint[];
  strokes: StrokeStyle[];
  /** Structural/base edit of the lists (add/remove/reorder, stop edits). */
  update: (label: string, fn: (c: PaintCarrierDraft) => void, mergeKey?: string) => void;
  /** Write a paint property — keyframe-aware for clips, base for frames. */
  commit: (path: string, value: KeyframeValue, label: string, mergeKey?: string) => void;
  /** Current base value of a paint path (feeds ◆ + inline readouts). */
  read: (path: string) => KeyframeValue | undefined;
  /** Present only when the host keyframes — gates ◆ clusters + sampled display. */
  keyframeClip?: PaintableClip;
  /**
   * Where modulators on this paint live, when the owner is not a clip. A clip
   * host leaves it absent and every row falls back to the clip's own list; a
   * document variable's host supplies its own, which is what puts a wiggle on a
   * shared gradient's angle without the paint editors learning that variables
   * exist.
   */
  modulatorHost?: ModulatorHost;
  /**
   * Across a multi-selection: does the selection DISAGREE at this path, or
   * anywhere under it? `fill.<id>` asks about the whole paint; `fill.<id>.opacity`
   * about one number. Absent on a single host — nothing to disagree with.
   */
  mixed?: (path: string) => boolean;
  /** The selection's lists differ in shape; only the shared entries are shown. */
  uneven?: boolean;
}

/**
 * Several clips as ONE paint host.
 *
 * The lists shown are the entries every clip carries at the same index with
 * the same kind of paint (the primary's objects); a write is made against the
 * primary and replayed onto every sibling by `propagateListEdit` — add, remove,
 * reorder, a paint retyped, a gradient's third stop, a dash pattern — and a
 * keyframe write is re-addressed by index so `fill.<primaryId>` lands on each
 * sibling's own paint. The editors (`PaintList`, `StrokeStackEditor`, the
 * popover) are untouched: they never knew there was one clip, so they do not
 * have to learn there are five.
 */
export function useMultiClipPaintHost(clips: PaintableClip[]): PaintHost {
  const store = useDocStore();
  const primary = clips[0]!;
  const fills = React.useMemo(() => sharedList(clips.map((c) => c.fills)), [clips]);
  const strokes = React.useMemo(
    () => sharedList(clips.map((c) => c.strokes), (s) => s.paint.type),
    [clips],
  );
  const mixedPaths = React.useMemo(() => {
    const out = new Set<string>();
    for (const e of fills.entries) for (const p of e.mixed) out.add(`fill.${e.primary.id}.${p}`);
    for (const e of strokes.entries) for (const p of e.mixed) out.add(`stroke.${e.primary.id}.${p}`);
    return out;
  }, [fills, strokes]);

  const targets = (d: MotionDocument): PaintableClip[] =>
    clips.map((c) => locateClip(d, c.id)?.clip as PaintableClip | undefined).filter((c): c is PaintableClip => !!c);
  const dropTracks = (clip: Clip, kind: "fill" | "stroke", ids: readonly string[]) => {
    if (ids.length === 0) return;
    clip.keyframes = clip.keyframes.filter((t) => !ids.some((id) => t.property.startsWith(`${kind}.${id}`)));
  };

  return {
    key: clips.map((c) => c.id).join("+"),
    fills: fills.entries.map((e) => e.primary),
    strokes: strokes.entries.map((e) => e.primary),
    update: (label, fn, mk) =>
      store.update(
        label,
        (d) => {
          const all = targets(d);
          const first = all[0];
          if (!first) return;
          const before = { fills: cloneValue(first.fills), strokes: cloneValue(first.strokes) };
          // The editor mutates the PRIMARY directly (its own list, its own
          // tracks); the siblings get the same edit replayed.
          fn(first as unknown as PaintCarrierDraft);
          for (const sib of all.slice(1)) {
            const f = propagateListEdit(before.fills, first.fills, sib.fills, (p) => ({ ...cloneValue(p), id: createId("paint") }));
            const s = propagateListEdit(before.strokes, first.strokes, sib.strokes, (p) => ({ ...cloneValue(p), id: createId("stroke") }));
            sib.fills = f.list;
            sib.strokes = s.list;
            dropTracks(sib, "fill", f.removedIds);
            dropTracks(sib, "stroke", s.removedIds);
          }
        },
        mk ? { mergeKey: mk } : undefined,
      ),
    commit: (path, value, label, mk) =>
      store.update(
        label,
        (d) => {
          const all = targets(d);
          const first = all[0];
          if (!first) return;
          const playhead = useSession.getState().playheadMs;
          for (const c of all) {
            const remapped =
              c === first
                ? path
                : path.startsWith("fill.")
                  ? remapEntryPath(path, first.fills, c.fills)
                  : remapEntryPath(path, first.strokes, c.strokes);
            if (remapped) commitProperty(c, remapped, value, playhead);
          }
        },
        mk ? { mergeKey: mk } : undefined,
      ),
    read: (path) => getClipProperty(primary, path),
    keyframeClip: primary,
    mixed: (path) => {
      for (const p of mixedPaths) if (p === path || p.startsWith(`${path}.`)) return true;
      return false;
    },
    uneven: fills.uneven || strokes.uneven,
  };
}

/**
 * A clip as a paint host — and, when the sidebar is pointed at an OVERRIDE
 * SCOPE, that scope's paints instead.
 *
 * This is the whole reason a caption's focused word can carry its own stroke
 * without one stroke control learning that captions exist: `PaintList`,
 * `StrokeStack`, the popover and the brush studio all talk to a host, so
 * scoping them is one branch here rather than a `scope` prop threaded through
 * six components.
 *
 * The two writes behave differently on purpose:
 *
 *  • `commit` is a VALUE at a path, which is exactly what an overlay stores —
 *    so overriding the focus stroke's width leaves everything else inherited,
 *    and a later change to the layer's colour still flows through.
 *  • `update` is STRUCTURAL (add, delete, reorder, change a paint's type).
 *    None of that is expressible as a delta over the parent's list, so the
 *    first structural edit FORKS the list: the scope takes ownership of a copy
 *    and stops tracking the layer's. Figma detaches a nested override for the
 *    same reason, and the Overrides list says plainly that it happened.
 */
export function useClipPaintHost(clip: PaintableClip): PaintHost {
  const update = useClipUpdater(clip.id);
  const scope = useScope();
  const scoped = scope && !scope.isBase ? scope : null;
  const address = useSession((s) => s.scopeAddress);

  // A CONTOUR of a vector layer, selected in the pen tool. The same idea as a
  // text range, reaching the same three controls (`PaintList`, `StrokeStack`,
  // the popover) through the same handle — which is why overriding one petal's
  // colour needed no new paint UI at all.
  //
  // Its own branch rather than the text `ScopeTarget` above because that target
  // is built around `TextStyle`, and a path clip has none: the shared thing
  // here is the OVERLAY and the property-path vocabulary, not the text model.
  if (clip.kind === "path" && address?.kind === "contour") {
    const contourId = address.contourId;
    const resolved = resolveContourStyle(clip, contourId);
    return {
      key: `${clip.id}:${scopeKey(address)}`,
      fills: resolved.fills,
      strokes: resolved.strokes,
      // Structural edits FORK the list, exactly as a text scope's do: adding a
      // stroke to one contour cannot be expressed as a delta over the layer's,
      // so this piece takes ownership of a copy and stops tracking it.
      update: (label, fn, mk) =>
        update(
          label,
          (c) => {
            if (c.kind !== "path") return;
            const now = resolveContourStyle(c, contourId);
            const draft = editableCopy(now);
            fn(draft);
            commitPaintFork((c.contourStyles[contourId] ??= emptyOverlay()), c, now, draft);
          },
          mk,
        ),
      commit: (path, value, label, mk) =>
        update(
          label,
          (c) => {
            if (c.kind === "path") setContourOverride(c, contourId, path, value);
          },
          mk && `${scopeKey(address)}-${mk}`,
        ),
      // Resolved, not sampled: a contour has no timeline of its own, which is
      // also why no ◆ cluster is offered (`keyframeClip` stays absent).
      read: (path) => getCarrierPaintProperty(resolved, path),
    };
  }

  if (!scoped) {
    return {
      key: clip.id,
      fills: clip.fills,
      strokes: clip.strokes,
      update: (label, fn, mk) => update(label, (c) => fn(c as unknown as PaintCarrierDraft), mk),
      commit: (path, value, label, mk) =>
        update(label, (c) => commitProperty(c, path, value, useSession.getState().playheadMs), mk),
      read: (path) => getClipProperty(clip, path),
      keyframeClip: clip,
    };
  }

  return {
    key: `${clip.id}:${scopeKey(scoped.address)}`,
    fills: scoped.resolved.fills,
    strokes: scoped.resolved.strokes,
    update: (label, fn, mk) =>
      scoped.editOverlay(
        label,
        (ov, resolved, parent) => {
          const draft = editableCopy(resolved);
          fn(draft);
          commitPaintFork(ov, parent, resolved, draft);
        },
        mk,
      ),
    commit: (path, value, label, mk) => scoped.write(path, value, label, mk),
    // A scope has no timeline of its own, so the readout is the resolved value
    // rather than a sampled one — which is also why `keyframeClip` is absent
    // below: no ◆ cluster is offered for something that cannot be keyed.
    read: (path) => getCarrierPaintProperty(scoped.resolved, path),
  };
}

/**
 * What a structural editor is handed: a DETACHED copy of the resolved lists.
 * The resolved lists alias the document (an inherited fill IS the layer's
 * fill object), so a popover swapping a paint's type in place would have
 * edited the layer through a range, or thrown on the frozen object. The copy
 * is what gets compared against the original to decide whether to fork.
 */
function editableCopy(resolved: { fills: Paint[]; strokes: StrokeStyle[] }): PaintCarrierDraft {
  return { fills: resolved.fills.map((f) => detach(f)), strokes: resolved.strokes.map((s) => detach(s)) };
}

/** A frame as a paint host — plain base edits (frames don't keyframe). */
export function frameToPaintHost(frame: Frame, store: DocumentStore): PaintHost {
  const edit = (label: string, fn: (f: Frame) => void, mk?: string) =>
    store.update(
      label,
      (d: MotionDocument) => {
        const f = d.frames.find((x) => x.id === frame.id);
        if (f) fn(f);
      },
      mk ? { mergeKey: mk } : undefined,
    );
  return {
    key: frame.id,
    fills: frame.fills,
    strokes: frame.strokes,
    update: (label, fn, mk) => edit(label, (f) => fn(f as unknown as PaintCarrierDraft), mk),
    commit: (path, value, label, mk) => edit(label, (f) => setCarrierPaintProperty(f, path, value), mk),
    read: (path) => getCarrierPaintProperty(frame, path),
  };
}
