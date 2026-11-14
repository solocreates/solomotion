"use client";

import { cursors } from "@solomotion/ui/cursors";
import * as React from "react";
import {
  channelValueAt,
  isClipLocked,
  locateClip,
  performKeyFor,
  triggerSetsOf,
  type MotionDocument,
  type Clip,
  type TriggerSet,
} from "@solomotion/core";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { clipLocalClamped } from "../inspector/animatable";
import { clipSpace } from "../stage/edit-space";
import { capturePointer } from "../input/capture-pointer";
import { claimPointer, subscribePointerEnd } from "../input/pointer-gestures";
import { isTypingTarget } from "../input/typing-target";
import { cn } from "@/lib/utils";
import { attachRecorder, recorder } from "./recorder";
import { usePerform } from "./state";

/**
 * PERFORM — the stage surface and the pad. Loaded when the mode is entered.
 *
 * The surface sits UNDER the rig overlay, so a press on a bone or a control is
 * the rig's (its values reach the recorder through the tap); a press anywhere
 * else performs the selected layer — Motion Sketch: drag moves it, ⌥-drag
 * turns it about its position, ⇧-drag scales it. Tools are off in Perform.
 *
 * The pad lists the armed sets of the selected character (pose sets, switch
 * groups — core's trigger-set registry) as big buttons, thumb-sized, each with
 * its key. Keys follow the spec's rows (set 1 → 1…9 0, set 2 → Q W E T Y U…);
 * a key held is a held trigger. Esc leaves.
 */

interface Drag {
  pointerId: number;
  clipId: string;
  kind: "move" | "turn" | "scale";
  from: { x: number; y: number };
  base: Record<string, number>;
  /** Screen centre for turn / scale. */
  centre: { x: number; y: number };
}

/** The character a selection speaks for: the selected group and everything under it. */
function armedClips(doc: MotionDocument, ids: readonly string[]): Clip[] {
  const out: Clip[] = [];
  const groups = new Set<string>();
  for (const id of ids) {
    const c = locateClip(doc, id)?.clip;
    if (!c) continue;
    out.push(c);
    if (c.kind === "group") groups.add(c.id);
  }
  // Members of selected groups, any depth (a switch inside a head inside a body).
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of doc.tracks) {
      if (!t.groupId || !groups.has(t.groupId)) continue;
      for (const c of t.clips) {
        if (out.includes(c)) continue;
        out.push(c);
        if (c.kind === "group" && !groups.has(c.id)) {
          groups.add(c.id);
          grew = true;
        }
      }
    }
  }
  return out;
}

export default function PerformOverlay() {
  const doc = useDoc();
  const store = useDocStore();
  const selected = useSession((s) => s.selectedClipIds);
  const recording = useSession((s) => s.recording);
  const { latch, setIndex, takes } = usePerform();
  const drag = React.useRef<Drag | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => attachRecorder(store), [store]);

  const sets: TriggerSet[] = React.useMemo(() => triggerSetsOf(doc, armedClips(doc, selected)), [doc, selected]);
  const armed = sets[Math.min(setIndex, sets.length - 1)] ?? null;
  const title = React.useMemo(() => {
    const c = selected[0] ? locateClip(doc, selected[0])?.clip : null;
    return c?.name ?? null;
  }, [doc, selected]);

  // A lost pointer drops the take; it is never written.
  React.useEffect(
    () =>
      subscribePointerEnd((id, reason) => {
        if (reason === "up") return;
        if (drag.current && drag.current.pointerId !== id) return;
        // Ours, or a rig gesture the tap was feeding: either way, drop it.
        drag.current = null;
        recorder.abortHeld();
      }),
    [],
  );

  // Keys: Esc leaves; the rows' letters are the sets' triggers. Capture phase,
  // so while Perform is on these keys belong to it (tools are off) — R, Space
  // and the rest fall through to the app.
  React.useEffect(() => {
    const keyFor = (e: KeyboardEvent): { set: TriggerSet; value: string } | null => {
      const k = e.key.toLowerCase();
      for (let si = 0; si < sets.length; si++) {
        const set = sets[si]!;
        for (let i = 0; i < set.values.length; i++) if (performKeyFor(si, i) === k) return { set, value: set.values[i]! };
      }
      return null;
    };
    const down = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        usePerform.getState().exit();
        return;
      }
      const hit = keyFor(e);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) recorder.press(hit.set.clipId, hit.set.path, hit.value);
    };
    const up = (e: KeyboardEvent) => {
      const hit = keyFor(e);
      if (!hit) return;
      e.stopPropagation();
      recorder.release_trigger(hit.set.clipId, hit.set.path, hit.value);
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [sets]);

  // ── The surface: Motion Sketch on the selected layer ─────────────────────

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const d = store.getState();
    const id = selected.find((x) => {
      const at = locateClip(d, x);
      return !!at && at.clip.kind !== "audio" && !isClipLocked(at.track, at.clip);
    });
    if (!id) return;
    const clip = locateClip(d, id)!.clip;
    const space = clipSpace(id, d);
    const r = ref.current!.getBoundingClientRect();
    if (!space) return;
    e.preventDefault();
    e.stopPropagation();
    claimPointer(e.pointerId, "drag");
    capturePointer(e.currentTarget, e.pointerId);
    const local = clipLocalClamped(clip, useSession.getState().playheadMs);
    const num = (p: string, fb: number) => {
      const v = channelValueAt(clip, p, local);
      return typeof v === "number" ? v : fb;
    };
    const kind: Drag["kind"] = e.altKey ? "turn" : e.shiftKey ? "scale" : "move";
    const base: Record<string, number> =
      kind === "move" ? { x: num("x", 0), y: num("y", 0) } : kind === "turn" ? { rotation: num("rotation", 0) } : { scale: num("scale", 1) };
    const centre = space.toScreen({ x: num("x", 0), y: num("y", 0) });
    drag.current = { pointerId: e.pointerId, clipId: id, kind, from: { x: e.clientX - r.left, y: e.clientY - r.top }, base, centre };
    recorder.feed(id, base);
  };

  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const r = ref.current!.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    const space = clipSpace(g.clipId);
    if (!space) return;
    if (g.kind === "move") {
      const a = space.fromScreen(g.from), b = space.fromScreen(p);
      recorder.feed(g.clipId, { x: g.base.x! + (b.x - a.x), y: g.base.y! + (b.y - a.y) });
    } else if (g.kind === "turn") {
      const a0 = Math.atan2(g.from.y - g.centre.y, g.from.x - g.centre.x);
      const a1 = Math.atan2(p.y - g.centre.y, p.x - g.centre.x);
      let deg = ((a1 - a0) * 180) / Math.PI;
      deg -= Math.round(deg / 360) * 360;
      recorder.feed(g.clipId, { rotation: g.base.rotation! + deg });
    } else {
      const d0 = Math.hypot(g.from.x - g.centre.x, g.from.y - g.centre.y) || 1;
      const d1 = Math.hypot(p.x - g.centre.x, p.y - g.centre.y);
      recorder.feed(g.clipId, { scale: g.base.scale! * (d1 / d0) });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g || g.pointerId !== e.pointerId) return;
    drag.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    recorder.release();
  };

  return (
    <>
      <div
        ref={ref}
        data-perform-surface
        className="absolute inset-0 touch-none"
        style={{ cursor: selected.length ? cursors.grab : cursors.arrow }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <PerformPad title={title} sets={sets} armed={armed} recording={recording} latch={latch} takes={takes} onUndo={() => store.undo()} />
    </>
  );
}

function PerformPad({
  title,
  sets,
  armed,
  recording,
  latch,
  takes,
  onUndo,
}: {
  title: string | null;
  sets: TriggerSet[];
  armed: TriggerSet | null;
  recording: boolean;
  latch: boolean;
  takes: number;
  onUndo: () => void;
}) {
  const armedIndex = armed ? sets.indexOf(armed) : -1;
  return (
    <div
      data-stage-chrome
      className="pointer-events-auto absolute bottom-3 left-1/2 flex max-w-[min(640px,calc(100%-32px))] -translate-x-1/2 flex-col gap-2 rounded-2xl border border-border bg-popover/95 p-2 text-xs shadow-lg backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 px-1">
        <span className="min-w-0 truncate font-medium">{title ?? "Perform"}</span>
        {recording && <span className="text-red-500">● Rec</span>}
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            title="Touch: records only while held"
            onClick={() => usePerform.getState().setLatch(!latch)}
            className="rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {latch ? "Latch" : "Touch"}
          </button>
          {takes > 0 && (
            <button type="button" onClick={onUndo} className="rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              Undo take
            </button>
          )}
        </span>
      </div>
      {sets.length > 1 && (
        <div className="flex gap-1 overflow-x-auto px-1">
          {sets.map((s, i) => (
            <button
              key={`${s.clipId}:${s.path}`}
              type="button"
              onClick={() => usePerform.getState().setSetIndex(i)}
              className={cn("shrink-0 rounded-md px-2 py-1", i === armedIndex ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted")}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      {armed && (
        <div className="flex flex-wrap gap-1.5">
          {armed.values.map((v, i) => (
            <TriggerButton key={v} set={armed} value={v} keycap={performKeyFor(armedIndex, i)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A big, thumb-sized trigger: press keys it, release lets go (touch). */
function TriggerButton({ set, value, keycap }: { set: TriggerSet; value: string; keycap: string | null }) {
  const [down, setDown] = React.useState(false);
  const press = (e: React.PointerEvent) => {
    e.preventDefault();
    claimPointer(e.pointerId, "drag");
    capturePointer(e.currentTarget, e.pointerId);
    setDown(true);
    recorder.press(set.clipId, set.path, value);
  };
  const let_go = () => {
    if (!down) return;
    setDown(false);
    recorder.release_trigger(set.clipId, set.path, value);
  };
  return (
    <button
      type="button"
      data-no-activate
      onPointerDown={press}
      onPointerUp={let_go}
      onPointerCancel={let_go}
      className={cn(
        "flex h-11 min-w-14 touch-none select-none items-center justify-center gap-1.5 rounded-xl border border-border px-3 text-sm transition-colors",
        down ? "bg-primary text-primary-foreground" : "bg-muted/40 hover:bg-muted",
      )}
    >
      <span className="truncate">{value}</span>
      {keycap && <kbd className="rounded bg-background/60 px-1 text-[10px] uppercase text-muted-foreground">{keycap}</kbd>}
    </button>
  );
}
