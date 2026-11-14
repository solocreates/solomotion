"use client";

import * as React from "react";
import {
  easingPoints,
  evaluateEasing,
  findKeyframe,
  locateClip,
  mergeCoincidentKeyframes,
  moveKeyframe,
  propertyDef,
  removeClipKeyframes,
  setKeyframeEasing,
  type MotionDocument,
  type Clip,
  type Keyframe,
  type KeyframeTrack,
  frameStepMs,
} from "@solomotion/core";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { EasingPicker } from "@/components/ui/easing-editor";
import { KeyframeMenuItems } from "./keyframe-menu";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { cn } from "@/lib/utils";
import { useSweepSelect, rectSweepAllowed } from "../state/use-sweep-select";
import { useEditingFps } from "../state/use-fps";
import { clipLocalClamped } from "../inspector/animatable";
import { timeToPx, pxToTime } from "./timeline-utils";
import { createKeyframeSnapper } from "./keyframe-snap";
import { KeyframeAnimBar } from "./KeyframeAnimBar";
import { colorFor, fullPropertyLabel } from "./property-groups";
import { capturePointer } from "../input/capture-pointer";

/**
 * The curve SURFACE — the eased-curves graph for one clip, rendered inside the
 * GraphPanel's scroll-synced viewport (the panel owns tabs, the property tree,
 * height, and scroll sync; this file owns only the graph and its gestures).
 *
 * Interactions (the pro set):
 *   click            select a point · ⇧click adds · marquee on empty space
 *   drag             move every selected point (time + value) — keys never
 *                    merge mid-drag; coincident keys collapse once on drop
 *   ⇧drag            time only — values stay locked
 *   ⌥drag            rotate the tangent: both bezier handles follow, mirrored
 *   handles          every selected point shows its in/out bezier handles, and
 *                    dragging one shapes the whole selection (so coincident
 *                    points stacked on the graph behave as the ONE point they
 *                    look like)
 *   ←→ / ↑↓          nudge selected points (time / value) · ⇧ = big steps
 *   ⌫                delete selected points · Esc clears the selection
 *   double-click     inline editor (exact time / value / easing)
 *   click a segment  easing editor for that span
 */

const PAD_Y = 16;
const SAMPLES = 28;
const LANE_H = 18;

type NumericKey = Keyframe & { value: number };

/**
 * Every curve/lane carries its home clip, so a multi-select view can render N
 * layers on ONE graph and route each edit back to the right clip. Numeric
 * tracks that share a property also share a value DOMAIN (min/max) across all
 * selected clips — so identical values land on identical pixels and coincident
 * points literally stack, which is what makes "one point" moves possible.
 */
interface ClipRef {
  clipId: string;
  clipStart: number;
  clipDuration: number;
}

/** A non-numeric track (color, weight, italic, text) shown as a dope-sheet lane. */
interface MarkerTrack extends ClipRef {
  id: string;
  property: string;
  keys: Keyframe[];
}

function markerTracks(clips: Clip[]): MarkerTrack[] {
  const out: MarkerTrack[] = [];
  for (const clip of clips) {
    for (const track of clip.keyframes) {
      if (track.range || track.keys.length === 0) continue;
      if (track.keys.some((k) => typeof k.value === "number")) continue; // numeric → curve
      out.push({
        id: track.id,
        clipId: clip.id,
        clipStart: clip.startMs,
        clipDuration: clip.durationMs,
        property: track.property,
        keys: [...track.keys].sort((a, b) => a.timeMs - b.timeMs),
      });
    }
  }
  return out;
}

interface NumericTrack extends ClipRef {
  id: string;
  property: string;
  keys: NumericKey[];
  /** Shared per-property domain (spans every selected clip's values). */
  min: number;
  max: number;
}

function numericTracks(clips: Clip[]): NumericTrack[] {
  const raw: Array<{ clip: Clip; track: KeyframeTrack; keys: NumericKey[] }> = [];
  const domains = new Map<string, { min: number; max: number }>();
  for (const clip of clips) {
    for (const track of clip.keyframes) {
      const keys = track.keys.filter((k): k is NumericKey => typeof k.value === "number");
      if (keys.length === 0) continue;
      raw.push({ clip, track, keys });
      let d = domains.get(track.property);
      if (!d) domains.set(track.property, (d = { min: Infinity, max: -Infinity }));
      for (const k of keys) {
        d.min = Math.min(d.min, k.value);
        d.max = Math.max(d.max, k.value);
      }
    }
  }
  // Pad each property's shared domain once, so every clip of that property
  // maps values through the exact same vertical scale.
  const padded = new Map<string, { min: number; max: number }>();
  for (const [property, d] of domains) {
    let { min, max } = d;
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.08;
    padded.set(property, { min: min - pad, max: max + pad });
  }
  return raw.map(({ clip, track, keys }) => {
    const dom = padded.get(track.property)!;
    return {
      id: track.id,
      clipId: clip.id,
      clipStart: clip.startMs,
      clipDuration: clip.durationMs,
      property: track.property,
      keys: [...keys].sort((a, b) => a.timeMs - b.timeMs),
      min: dom.min,
      max: dom.max,
    };
  });
}

/** Points that literally overlap on the graph — same property, instant, value.
 *  Dragging one drags the stack, so aligned keys across layers move as one. */
function stackSignature(t: NumericTrack, k: NumericKey): string {
  return `${t.property}|${Math.round(t.clipStart + k.timeMs)}|${k.value}`;
}

/** Grow a numeric selection to include every point stacked under a selected one. */
function expandStacked(seed: Set<string>, tracks: NumericTrack[]): Set<string> {
  const sigs = new Set<string>();
  for (const t of tracks) for (const k of t.keys) if (seed.has(k.id)) sigs.add(stackSignature(t, k));
  if (sigs.size === 0) return seed;
  const out = new Set(seed);
  for (const t of tracks) for (const k of t.keys) if (sigs.has(stackSignature(t, k))) out.add(k.id);
  return out;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function CurvesSurface({
  clip,
  clips,
  pxPerSec,
  height,
  valueZoom,
  hiddenProps,
}: {
  clip: Clip;
  /** Every selected clip — the group a selection-driven scale spans. */
  clips: Clip[];
  pxPerSec: number;
  height: number;
  /** Vertical zoom around the graph center (1 = fit; >1 taller curves). */
  valueZoom: number;
  hiddenProps: Set<string>;
}) {
  const doc = useDoc();
  const store = useDocStore();
  // Arrow-key nudges step by ONE FRAME of the comp being edited — a 12fps sheet
  // nudges by 83ms, not by the 33ms some project-wide rate would have implied.
  const fps = useEditingFps();
  // Node selection IS the global keyframe selection (shared with the timeline
  // lane), so ⌘C/⌘X/⌘V/⌫ route through the same keyframe-level clipboard — never
  // the whole clip — and selecting a node here highlights it in the timeline.
  const selectedKfIds = useSession((s) => s.selectedKeyframeIds);
  const selected = React.useMemo(() => new Set(selectedKfIds), [selectedKfIds]);
  const setSelected = React.useCallback(
    (next: Set<string>) => useSession.getState().setSelectedKeyframes([...next]),
    [],
  );
  const [editing, setEditing] = React.useState<{ trackId: string; keyId: string } | null>(null);
  const [marquee, setMarquee] = React.useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  const tracks = React.useMemo(() => numericTracks(clips), [clips]);
  const markers = React.useMemo(() => markerTracks(clips), [clips]);
  // Marker lanes are keyed by PROPERTY, so every selected clip's "color" keys
  // share one lane (and stack when they line up), just like the numeric curves.
  const markerLanes = React.useMemo(() => [...new Set(markers.map((t) => t.property))], [markers]);
  const graphH = height;
  const curveH = graphH - markerLanes.length * LANE_H;

  const clipOf = React.useCallback((clipId: string) => clips.find((c) => c.id === clipId), [clips]);

  // Whole-document mutation — every handler routes each key back to its home
  // clip by id, so one undo step can edit keys across the whole selection.
  const mutate = (label: string, fn: (d: MotionDocument) => void, mergeKey?: string) =>
    store.update(label, fn, mergeKey ? { mergeKey } : undefined);
  const kfOf = (d: MotionDocument, clipId: string) => locateClip(d, clipId)?.clip.keyframes;
  /** Single-clip convenience for edits that only ever touch one track (tangents, handles). */
  const mutateClip = (clipId: string, label: string, fn: (kf: KeyframeTrack[]) => void, mergeKey?: string) =>
    mutate(
      label,
      (d) => {
        const kf = kfOf(d, clipId);
        if (kf) fn(kf);
      },
      mergeKey,
    );

  // Value → y, zoomed around the graph's vertical center.
  const innerH = Math.max(curveH - PAD_Y * 2, 20);
  const yOf = (t: NumericTrack, v: number) => {
    const base = PAD_Y + (1 - (v - t.min) / (t.max - t.min)) * innerH;
    const center = curveH / 2;
    return center + (base - center) * valueZoom;
  };
  const laneY = (property: string) => curveH + markerLanes.indexOf(property) * LANE_H + LANE_H / 2;
  const xOf = (clipStart: number, timeMs: number) => timeToPx(clipStart + timeMs, pxPerSec);
  const visible = tracks.filter((t) => !hiddenProps.has(t.property));
  const visibleMarkers = markers.filter((t) => !hiddenProps.has(t.property));

  /** Group ids by clip, then collapse coincident keys ONCE per clip in one undo step. */
  const commitMerge = (byClip: Map<string, Set<string>>, mergeKey: string) =>
    mutate(
      "Move keyframes",
      (d) => {
        for (const [clipId, ids] of byClip) {
          const kf = kfOf(d, clipId);
          if (kf) mergeCoincidentKeyframes(kf, ids);
        }
      },
      mergeKey,
    );

  /** Bucket a drag's origin entries by their home clip (for commitMerge). */
  const groupByClip = (origins: Map<string, { clipId: string }>): Map<string, Set<string>> => {
    const byClip = new Map<string, Set<string>>();
    for (const [id, o] of origins) {
      let s = byClip.get(o.clipId);
      if (!s) byClip.set(o.clipId, (s = new Set()));
      s.add(id);
    }
    return byClip;
  };

  // ── Point dragging (move / ⇧ time-only / ⌥ tangent) ────────────────────────

  const dragPoint = (e: React.PointerEvent, track: NumericTrack, key: NumericKey) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    wrapRef.current?.focus();
    capturePointer((e.currentTarget as Element), e.pointerId);

    const additive = e.shiftKey && !e.altKey;
    let sel = selected;
    if (!selected.has(key.id)) {
      sel = additive ? new Set([...selected, key.id]) : new Set([key.id]);
    }

    const tangentMode = e.altKey;
    // Grabbing a point grabs every point stacked under it, so aligned keys
    // across the selected layers move as one (the "one point" sync).
    const drag = tangentMode ? sel : expandStacked(sel, tracks);
    if (drag.size !== selected.size || ![...drag].every((id) => selected.has(id))) setSelected(drag);

    const startX = e.clientX;
    const startY = e.clientY;
    const pxRange = innerH * valueZoom;
    const mergeKey = `curve-drag-${key.id}-${e.pointerId}`;
    const anchorAbsMs = track.clipStart + key.timeMs;

    // Freeze origins + domains — the doc mutates under us while dragging.
    interface Origin {
      clipId: string;
      clipStart: number;
      clipDuration: number;
      t: number;
      v: number;
      range: number;
      property: string;
      numeric: boolean;
    }
    const origins = new Map<string, Origin>();
    for (const t of tracks) {
      for (const k of t.keys) {
        if (drag.has(k.id)) {
          origins.set(k.id, {
            clipId: t.clipId,
            clipStart: t.clipStart,
            clipDuration: t.clipDuration,
            t: k.timeMs,
            v: k.value,
            range: t.max - t.min,
            property: t.property,
            numeric: true,
          });
        }
      }
    }
    // Marker (non-numeric) keys move in time along with the selection.
    for (const t of markers) {
      for (const k of t.keys) {
        if (drag.has(k.id))
          origins.set(k.id, {
            clipId: t.clipId,
            clipStart: t.clipStart,
            clipDuration: t.clipDuration,
            t: k.timeMs,
            v: 0,
            range: 1,
            property: t.property,
            numeric: false,
          });
      }
    }
    const anchor = origins.get(key.id)!;
    const snapper = createKeyframeSnapper(
      store,
      pxPerSec,
      [...origins.values()].map((o) => o.clipStart + o.t),
    );

    // Tangent mode needs the neighbors of the anchor key, frozen.
    const idx = track.keys.findIndex((k) => k.id === key.id);
    const prevKey = track.keys[idx - 1];
    const nextKey = track.keys[idx + 1];

    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dxPx = ev.clientX - startX;
      const dyPx = ev.clientY - startY;
      if (!moved && Math.hypot(dxPx, dyPx) < 3) return;
      moved = true;

      if (tangentMode) {
        // Rotate the tangent: pointer offset = out-handle direction, mirrored in.
        const dtOut = nextKey ? nextKey.timeMs - anchor.t : 0;
        const dvOut = nextKey ? nextKey.value - anchor.v : 0;
        const dtIn = prevKey ? anchor.t - prevKey.timeMs : 0;
        const dvIn = prevKey ? anchor.v - prevKey.value : 0;
        const dMs = pxToTime(dxPx, pxPerSec);
        const dVal = (-dyPx / pxRange) * anchor.range;
        mutateClip(
          track.clipId,
          "Adjust tangent",
          (kf) => {
            if (nextKey && dtOut > 0) {
              const f = findKeyframe(kf, key.id);
              if (f) {
                const [, , x2, y2] = easingPoints(f.key.easing);
                const x1 = clamp01(dMs / dtOut);
                const y1 = dvOut !== 0 ? dVal / dvOut : 0;
                f.key.easing = { kind: "bezier", values: [x1, y1, x2, y2] };
              }
            }
            if (prevKey && dtIn > 0) {
              const f = findKeyframe(kf, prevKey.id);
              if (f) {
                const [x1, y1] = easingPoints(f.key.easing);
                const x2 = clamp01(1 - dMs / dtIn);
                const y2 = dvIn !== 0 ? 1 - dVal / dvIn : 1;
                f.key.easing = { kind: "bezier", values: [x1, y1, x2, y2] };
              }
            }
          },
          mergeKey,
        );
        return;
      }

      const dMs = snapper.snapDelta(anchorAbsMs, pxToTime(dxPx, pxPerSec), ev.metaKey || ev.ctrlKey);
      const lockValue = ev.shiftKey;
      mutate(
        "Move keyframes",
        (d) => {
          for (const [id, o] of origins) {
            const kf = kfOf(d, o.clipId);
            if (!kf) continue;
            const def = propertyDef(o.property);
            // merge:false — passing over another key must not eat it mid-drag.
            moveKeyframe(kf, id, Math.max(0, Math.min(o.clipDuration, o.t + dMs)), { merge: false });
            if (!lockValue && o.numeric) {
              const f = findKeyframe(kf, id);
              if (f) {
                let v = o.v - (dyPx / pxRange) * o.range;
                if (def?.min !== undefined) v = Math.max(def.min, v);
                if (def?.max !== undefined) v = Math.min(def.max, v);
                f.key.value = v;
              }
            }
          }
        },
        mergeKey,
      );
    };
    const onUp = () => {
      snapper.end();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved && !tangentMode) commitMerge(groupByClip(origins), mergeKey);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── Marker (non-numeric) dragging — time only ──────────────────────────────

  const dragMarker = (e: React.PointerEvent, mtrack: MarkerTrack, key: Keyframe) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    wrapRef.current?.focus();
    capturePointer((e.currentTarget as Element), e.pointerId);
    let sel = selected;
    if (!selected.has(key.id)) {
      sel = e.shiftKey ? new Set([...selected, key.id]) : new Set([key.id]);
    }
    // A marker lane is shared per property, so stacked markers (same lane +
    // instant, from different layers) drag together too.
    const sig = (t: MarkerTrack, k: Keyframe) => `${t.property}|${Math.round(t.clipStart + k.timeMs)}`;
    const sigs = new Set<string>();
    for (const t of markers) for (const k of t.keys) if (sel.has(k.id)) sigs.add(sig(t, k));
    const drag = new Set(sel);
    for (const t of markers) for (const k of t.keys) if (sigs.has(sig(t, k))) drag.add(k.id);
    if (drag.size !== selected.size || ![...drag].every((id) => selected.has(id))) setSelected(drag);

    const startX = e.clientX;
    const origins = new Map<string, { clipId: string; clipStart: number; clipDuration: number; t: number }>();
    for (const t of tracks)
      for (const k of t.keys)
        if (drag.has(k.id))
          origins.set(k.id, { clipId: t.clipId, clipStart: t.clipStart, clipDuration: t.clipDuration, t: k.timeMs });
    for (const t of markers)
      for (const k of t.keys)
        if (drag.has(k.id))
          origins.set(k.id, { clipId: t.clipId, clipStart: t.clipStart, clipDuration: t.clipDuration, t: k.timeMs });
    const mergeKey = `curve-marker-${key.id}-${e.pointerId}`;
    const anchorAbsMs = mtrack.clipStart + key.timeMs;
    const snapper = createKeyframeSnapper(
      store,
      pxPerSec,
      [...origins.values()].map((o) => o.clipStart + o.t),
    );
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dxPx = ev.clientX - startX;
      if (!moved && Math.abs(dxPx) < 3) return;
      moved = true;
      const dMs = snapper.snapDelta(anchorAbsMs, pxToTime(dxPx, pxPerSec), ev.metaKey || ev.ctrlKey);
      mutate(
        "Move keyframes",
        (d) => {
          for (const [id, o] of origins) {
            const kf = kfOf(d, o.clipId);
            if (kf) moveKeyframe(kf, id, Math.max(0, Math.min(o.clipDuration, o.t + dMs)), { merge: false });
          }
        },
        mergeKey,
      );
    };
    const onUp = () => {
      snapper.end();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved) commitMerge(groupByClip(origins), mergeKey);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── Bezier handle dragging (the whole selection) ───────────────────────────

  /**
   * The easing control points one handle speaks for: the SAME side of the
   * segment on every selected point, across properties and layers.
   *
   * A bezier handle is a normalized (0..1) control point on the segment, not a
   * pixel — so the same [x,y] means the same curve shape whatever each key's
   * neighbours are. That is what makes stacked points (identical time+value on
   * several layers, all selected by one marquee or one click) behave as ONE
   * point: they were always one point on screen, now they are one point under
   * the mouse too.
   *
   * `out` edits the key's own easing (the segment leaving it); `in` edits the
   * PREVIOUS key's easing (the segment arriving) — per track, so each selected
   * point resolves its own neighbour.
   */
  const handleTargets = (which: "out" | "in"): Array<{ clipId: string; keyId: string }> => {
    const out: Array<{ clipId: string; keyId: string }> = [];
    for (const t of tracks) {
      if (propertyDef(t.property)?.kind === "discrete") continue; // holds — no curve
      t.keys.forEach((k, i) => {
        if (!selected.has(k.id)) return;
        const target = which === "out" ? k : t.keys[i - 1];
        const neighbour = which === "out" ? t.keys[i + 1] : t.keys[i - 1];
        if (!target || !neighbour) return; // no segment on that side
        out.push({ clipId: t.clipId, keyId: target.id });
      });
    }
    return out;
  };

  const dragHandle = (
    e: React.PointerEvent,
    track: NumericTrack,
    which: "out" | "in",
    key: NumericKey,
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    capturePointer((e.currentTarget as Element), e.pointerId);
    const idx = track.keys.findIndex((k) => k.id === key.id);
    const seg =
      which === "out"
        ? { from: key, to: track.keys[idx + 1], easingKeyId: key.id }
        : { from: track.keys[idx - 1], to: key, easingKeyId: track.keys[idx - 1]?.id };
    if (!seg.from || !seg.to || !seg.easingKeyId) return;
    const t0 = seg.from.timeMs;
    const v0 = seg.from.value;
    const dt = seg.to.timeMs - t0;
    const dv = seg.to.value - v0;
    if (dt <= 0) return;
    const pxRange = innerH * valueZoom;
    const range = track.max - track.min;
    const startX = e.clientX;
    const startY = e.clientY;
    const [ox1, oy1, ox2, oy2] = easingPoints(key.easing);
    const orig = which === "out" ? { x: ox1, y: oy1 } : { x: ox2, y: oy2 };
    const easingKeyId = seg.easingKeyId;
    const mergeKey = `curve-handle-${easingKeyId}-${which}-${e.pointerId}`;
    // Frozen at grab time: the pointer→normalized mapping comes from the segment
    // you actually grabbed, and the SAME normalized point lands on every other
    // selected key (plus the grabbed one, even if the selection lags behind).
    const targets = handleTargets(which);
    if (!targets.some((t) => t.keyId === easingKeyId)) {
      targets.push({ clipId: track.clipId, keyId: easingKeyId });
    }

    const onMove = (ev: PointerEvent) => {
      const dMs = pxToTime(ev.clientX - startX, pxPerSec);
      const dVal = (-(ev.clientY - startY) / pxRange) * range;
      const x = clamp01(orig.x + dMs / dt);
      const y = dv !== 0 ? orig.y + dVal / dv : orig.y;
      mutate(
        "Adjust easing handle",
        (d) => {
          for (const target of targets) {
            const kf = kfOf(d, target.clipId);
            if (!kf) continue;
            const f = findKeyframe(kf, target.keyId);
            if (!f) continue;
            const [x1, y1, x2, y2] = easingPoints(f.key.easing);
            f.key.easing =
              which === "out"
                ? { kind: "bezier", values: [x, y, x2, y2] }
                : { kind: "bezier", values: [x1, y1, x, y] };
          }
        },
        mergeKey,
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── Marquee on empty graph space ────────────────────────────────────────────

  const lassoBase = React.useRef<string[]>([]);
  const lasso = useSweepSelect(wrapRef, "data-kf-id", {
    onDragStart: (additive) => {
      lassoBase.current = additive ? [...selected] : [];
    },
    onSweep: (ids) => setSelected(new Set([...lassoBase.current, ...ids])),
    onClear: () => setSelected(new Set()),
  });

  const startMarquee = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // One predicate, shared with every other marquee in the app: a finger and a
    // pen scroll, and an armed lasso owns the pointer outright.
    if (!rectSweepAllowed(e)) return;
    wrapRef.current?.focus();
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    capturePointer(svg, e.pointerId);
    const start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const base = e.shiftKey ? new Set(selected) : new Set<string>();
    if (!e.shiftKey) setSelected(new Set());
    let dragged = false;

    const onMove = (ev: PointerEvent) => {
      const cur = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      if (!dragged && Math.hypot(cur.x - start.x, cur.y - start.y) < 4) return;
      dragged = true;
      const r = {
        x: Math.min(start.x, cur.x),
        y: Math.min(start.y, cur.y),
        w: Math.abs(start.x - cur.x),
        h: Math.abs(start.y - cur.y),
      };
      setMarquee(r);
      const hit = new Set(base);
      for (const t of visible) {
        for (const k of t.keys) {
          const px = xOf(t.clipStart, k.timeMs);
          const py = yOf(t, k.value);
          if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) hit.add(k.id);
        }
      }
      for (const t of visibleMarkers) {
        const py = laneY(t.property);
        for (const k of t.keys) {
          const px = xOf(t.clipStart, k.timeMs);
          if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) hit.add(k.id);
        }
      }
      setSelected(hit);
    };
    const onUp = () => {
      setMarquee(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── Keyboard: nudge / delete / escape ───────────────────────────────────────

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (selected.size === 0) return;
    if (e.key === "Escape") {
      setSelected(new Set());
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      e.stopPropagation();
      // Un-keying keeps the pose: each clip bakes its last-key values at ITS own
      // local playhead time, so nothing on stage moves as the curves disappear.
      const playheadMs = useSession.getState().playheadMs;
      mutate("Delete keyframes", (d) => {
        for (const c of clips) {
          const draft = locateClip(d, c.id)?.clip;
          if (draft) removeClipKeyframes(draft, selected, clipLocalClamped(draft, playheadMs));
        }
      });
      setSelected(new Set());
      return;
    }
    if (!e.key.startsWith("Arrow")) return;
    e.preventDefault();
    e.stopPropagation();

    const frameMs = frameStepMs(fps);
    const dt =
      e.key === "ArrowLeft"
        ? -(e.shiftKey ? frameMs * 10 : frameMs)
        : e.key === "ArrowRight"
          ? e.shiftKey
            ? frameMs * 10
            : frameMs
          : 0;
    const dir = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;

    mutate(
      "Nudge keyframes",
      (d) => {
        for (const t of tracks) {
          const kf = kfOf(d, t.clipId);
          if (!kf) continue;
          const def = propertyDef(t.property);
          const step = (def?.step ?? 1) * (e.shiftKey ? 10 : 1);
          for (const k of t.keys) {
            if (!selected.has(k.id)) continue;
            if (dt !== 0) {
              moveKeyframe(kf, k.id, Math.max(0, Math.min(t.clipDuration, k.timeMs + dt)));
            }
            if (dir !== 0) {
              const f = findKeyframe(kf, k.id);
              if (f && typeof f.key.value === "number") {
                let v = f.key.value + dir * step;
                if (def?.min !== undefined) v = Math.max(def.min, v);
                if (def?.max !== undefined) v = Math.min(def.max, v);
                f.key.value = v;
              }
            }
          }
        }
        // Marker keys nudge in time only.
        if (dt !== 0) {
          for (const t of markers) {
            const kf = kfOf(d, t.clipId);
            if (!kf) continue;
            for (const k of t.keys) {
              if (selected.has(k.id)) moveKeyframe(kf, k.id, Math.max(0, Math.min(t.clipDuration, k.timeMs + dt)));
            }
          }
        }
      },
      `curve-nudge-${e.key}-${e.shiftKey}`,
    );
  };

  const editingTrack = editing ? tracks.find((t) => t.id === editing.trackId) : undefined;
  const editingKey = editingTrack?.keys.find((k) => k.id === editing?.keyId);

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn("relative h-full outline-none", lasso.surfaceClassName)}
    >
      {/* The polygon lives in the HTML wrapper, not in the <svg> below — the
          shared overlay is a div/svg pair and an HTML div inside an SVG would
          not render at all. `wrapRef` is already `relative`, which is what it
          positions against. */}
      {lasso.marqueeNode}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <svg
            className="block select-none"
            style={{ height: graphH, width: "100%", overflow: "visible" }}
            aria-label="Keyframe curves"
            onPointerDown={(e) => {
              lasso.onPointerDown(e);
              startMarquee(e);
            }}
          >
            {/* Clip span guides — one pair per selected layer (they overlap when
                the layers share a span, which is the common aligned case). */}
            {clips.map((c) => (
              <React.Fragment key={c.id}>
                <line x1={xOf(c.startMs, 0)} x2={xOf(c.startMs, 0)} y1={0} y2={graphH} className="stroke-border" strokeDasharray="2 3" />
                <line x1={xOf(c.startMs, c.durationMs)} x2={xOf(c.startMs, c.durationMs)} y1={0} y2={graphH} className="stroke-border" strokeDasharray="2 3" />
              </React.Fragment>
            ))}

            {visible.map((t) => {
              // Discrete numeric properties (weight, point count, …) HOLD between
              // keys — drawn as steps, with no easing to click or handles to drag.
              const discrete = propertyDef(t.property)?.kind === "discrete";
              return (
                <g key={t.id}>
                  {t.keys.slice(0, -1).map((k0, i) => {
                    const k1 = t.keys[i + 1]!;
                    const pts: string[] = [];
                    if (discrete || k0.easing.kind === "hold") {
                      pts.push(
                        `${xOf(t.clipStart, k0.timeMs)},${yOf(t, k0.value)}`,
                        `${xOf(t.clipStart, k1.timeMs)},${yOf(t, k0.value)}`,
                        `${xOf(t.clipStart, k1.timeMs)},${yOf(t, k1.value)}`,
                      );
                    } else {
                      for (let s = 0; s <= SAMPLES; s++) {
                        const u = s / SAMPLES;
                        const v = k0.value + (k1.value - k0.value) * evaluateEasing(k0.easing, u);
                        const time = k0.timeMs + (k1.timeMs - k0.timeMs) * u;
                        pts.push(`${xOf(t.clipStart, time)},${yOf(t, v)}`);
                      }
                    }
                    return (
                      <g key={k0.id}>
                        <polyline
                          points={pts.join(" ")}
                          fill="none"
                          stroke={colorFor(t.property)}
                          strokeWidth={1.5}
                          opacity={0.9}
                          strokeDasharray={discrete ? "3 3" : undefined}
                        />
                        {!discrete && (
                          <polyline
                            points={pts.join(" ")}
                            fill="none"
                            stroke="transparent"
                            strokeWidth={10}
                            className="cursor-pointer"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => setEditing({ trackId: t.id, keyId: k0.id })}
                          />
                        )}
                      </g>
                    );
                  })}

                  {/* Bezier handles on EVERY selected point of this curve — so a
                      stack of coincident points shows (and drags) as one, and a
                      multi-select shapes its whole set at once. */}
                  {!discrete &&
                    t.keys.map((k) =>
                      selected.has(k.id) ? (
                        <HandlePair
                          key={`h-${k.id}`}
                          track={t}
                          pointKey={k}
                          xOf={(ms) => xOf(t.clipStart, ms)}
                          yOf={yOf}
                          onDrag={(e, which) => dragHandle(e, t, which, k)}
                        />
                      ) : null,
                    )}

                  {t.keys.map((k) => {
                    const isSel = selected.has(k.id);
                    return (
                      <circle
                        key={k.id}
                        // The lasso finds keyframes through the DOM like every
                        // other surface — this attribute is the whole
                        // integration, and it costs nothing when unused.
                        data-kf-id={k.id}
                        cx={xOf(t.clipStart, k.timeMs)}
                        cy={yOf(t, k.value)}
                        r={isSel ? 4.5 : 3.5}
                        fill={isSel ? colorFor(t.property) : "var(--color-panel, #1c1c22)"}
                        stroke={isSel ? "white" : colorFor(t.property)}
                        strokeWidth={1.5}
                        className="cursor-move"
                        onPointerDown={(e) => dragPoint(e, t, k)}
                        onContextMenu={() => {
                          if (!selected.has(k.id)) setSelected(new Set([k.id]));
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditing({ trackId: t.id, keyId: k.id });
                        }}
                      >
                        <title>
                          {fullPropertyLabel(clipOf(t.clipId) ?? clip, t.property) +
                            ` ${Math.round(k.value * 100) / 100} @ ${((t.clipStart + k.timeMs) / 1000).toFixed(2)}s`}
                        </title>
                      </circle>
                    );
                  })}
                </g>
              );
            })}

            {/* Dope-sheet lanes for non-numeric tracks (color, weight, italic, text). */}
            {visibleMarkers.map((t) => {
              const y = laneY(t.property);
              const color = colorFor(t.property);
              return (
                <g key={t.id}>
                  <line x1={xOf(t.clipStart, 0)} x2={xOf(t.clipStart, t.clipDuration)} y1={y} y2={y} stroke={color} strokeWidth={1} opacity={0.18} />
                  {t.keys.map((k) => {
                    const isSel = selected.has(k.id);
                    const px = xOf(t.clipStart, k.timeMs);
                    return (
                      <rect
                        key={k.id}
                        x={px - 4}
                        y={y - 4}
                        width={8}
                        height={8}
                        transform={`rotate(45 ${px} ${y})`}
                        fill={isSel ? color : "var(--color-panel, #1c1c22)"}
                        stroke={isSel ? "white" : color}
                        strokeWidth={1.5}
                        className="cursor-move"
                        onPointerDown={(e) => dragMarker(e, t, k)}
                        onContextMenu={() => {
                          if (!selected.has(k.id)) setSelected(new Set([k.id]));
                        }}
                      >
                        <title>{`${fullPropertyLabel(clipOf(t.clipId) ?? clip, t.property)} @ ${((t.clipStart + k.timeMs) / 1000).toFixed(2)}s`}</title>
                      </rect>
                    );
                  })}
                </g>
              );
            })}

            {marquee && (
              <rect
                x={marquee.x}
                y={marquee.y}
                width={marquee.w}
                height={marquee.h}
                className="fill-primary/10 stroke-primary/70"
              />
            )}
          </svg>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          {/* The one keyframe vocabulary — shared verbatim with the dope sheet. */}
          <KeyframeMenuItems store={store} />
        </ContextMenuContent>
      </ContextMenu>

      {/* Animation clip bar — slide / scale the whole animation, top strip. */}
      <KeyframeAnimBar clips={clips} clip={clip} pxPerSec={pxPerSec} top={1} height={11} />

      {editingKey && editingTrack && (
        <Popover open onOpenChange={(open) => !open && setEditing(null)}>
          <PopoverAnchor asChild>
            <div
              className="pointer-events-none absolute size-px"
              style={{ left: xOf(editingTrack.clipStart, editingKey.timeMs), top: yOf(editingTrack, editingKey.value) }}
            />
          </PopoverAnchor>
          <PopoverContent className="w-60 space-y-2 p-2.5" side="top" sideOffset={10}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold">
                {fullPropertyLabel(clipOf(editingTrack.clipId) ?? clip, editingTrack.property)}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete keyframe"
                className="size-5 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  const playheadMs = useSession.getState().playheadMs;
                  mutate("Delete keyframe", (d) => {
                    const draft = locateClip(d, editingTrack.clipId)?.clip;
                    if (draft) {
                      removeClipKeyframes(draft, [editingKey.id], clipLocalClamped(draft, playheadMs));
                    }
                  });
                  setEditing(null);
                }}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <NumberInput
                label="t"
                value={editingKey.timeMs / 1000}
                min={0}
                max={editingTrack.clipDuration / 1000}
                step={0.01}
                precision={2}
                unit="s"
                onChange={(v) =>
                  mutateClip(editingTrack.clipId, "Move keyframe", (kf) => void moveKeyframe(kf, editingKey.id, v * 1000), "curve-edit-time")
                }
              />
              <NumberInput
                label="v"
                value={editingKey.value}
                step={propertyDef(editingTrack.property)?.step ?? 1}
                precision={2}
                onChange={(v) =>
                  mutateClip(
                    editingTrack.clipId,
                    "Edit keyframe value",
                    (kf) => {
                      const f = findKeyframe(kf, editingKey.id);
                      if (f) f.key.value = v;
                    },
                    "curve-edit-value",
                  )
                }
              />
            </div>
            <EasingPicker
              value={editingKey.easing}
              onChange={(easing) =>
                mutateClip(editingTrack.clipId, "Set easing", (kf) => void setKeyframeEasing(kf, editingKey.id, easing), "curve-edit-easing")
              }
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

/** The in/out bezier handles of ONE selected point, drawn on its own curve. */
function HandlePair({
  track,
  pointKey,
  xOf,
  yOf,
  onDrag,
}: {
  track: NumericTrack;
  pointKey: NumericKey;
  xOf: (t: number) => number;
  yOf: (t: NumericTrack, v: number) => number;
  onDrag: (e: React.PointerEvent, which: "out" | "in") => void;
}) {
  const idx = track.keys.findIndex((k) => k.id === pointKey.id);
  const prev = track.keys[idx - 1];
  const next = track.keys[idx + 1];
  const color = colorFor(track.property);
  const cx = xOf(pointKey.timeMs);
  const cy = yOf(track, pointKey.value);

  const handles: Array<{ which: "out" | "in"; hx: number; hy: number }> = [];
  // A hold segment is a step: it has no handle on either side.
  if (next && pointKey.easing.kind !== "hold") {
    const [x1, y1] = easingPoints(pointKey.easing);
    handles.push({
      which: "out",
      hx: xOf(pointKey.timeMs + (next.timeMs - pointKey.timeMs) * x1),
      hy: yOf(track, pointKey.value + (next.value - pointKey.value) * y1),
    });
  }
  if (prev && prev.easing.kind !== "hold") {
    const [, , x2, y2] = easingPoints(prev.easing);
    handles.push({
      which: "in",
      hx: xOf(prev.timeMs + (pointKey.timeMs - prev.timeMs) * x2),
      hy: yOf(track, prev.value + (pointKey.value - prev.value) * y2),
    });
  }

  return (
    <g>
      {handles.map((h) => (
        <g key={h.which}>
          <line x1={cx} y1={cy} x2={h.hx} y2={h.hy} stroke={color} strokeWidth={1} opacity={0.6} />
          <circle
            cx={h.hx}
            cy={h.hy}
            r={3.5}
            fill="white"
            stroke={color}
            strokeWidth={1.5}
            className="cursor-grab"
            onPointerDown={(e) => onDrag(e, h.which)}
          />
        </g>
      ))}
    </g>
  );
}
