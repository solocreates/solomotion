"use client";

import * as React from "react";
import {
  clipLocalTime,
  epochAt,
  textTimelineOf,
  textUnitEvents,
  type AnimationSpec,
  type TextClip,
  type TextUnitEvent,
} from "@solomotion/core";
import { useSession } from "../state/session";
import { capturePointer } from "../input/capture-pointer";
import { beginHeldDrag, type HeldDrag } from "../input/hold-to-drag";

/**
 * The RHYTHM STRIP — the Animate panel's picture of *when* things happen.
 *
 * Duration / stagger / jitter are three numbers that describe a pattern in
 * time, and reading a pattern out of three numbers is a skill, not a design.
 * The strip draws the pattern instead: one tick per unit at the instant it
 * starts moving, a tail for how long it moves, and rows that follow the lines
 * of the text — so an uneven stagger, a jitter that has gone from "human" to
 * "drunk", or a cohort arriving at a content keyframe are all things you SEE
 * rather than compute.
 *
 * Every tick is read from `textUnitEvents` — the same schedule the renderer
 * animates from and the audio engine clicks on. The strip is a view of the
 * truth, never a second model of it, so it cannot show you a rhythm the
 * playback doesn't have.
 *
 * Dots are letters, bars are words, full-height rules are lines: the grain is
 * legible at a glance without a legend.
 *
 * Ticks are deliberately NOT draggable. A tick's position is a function of the
 * spec's shared fields, so dragging one can only solve back into `stagger` /
 * `delay` / `duration` — it silently retimes the entire animation, which is the
 * opposite of what grabbing a single letter looks like it will do. Reading is
 * the strip's job; the numbers beside it do the editing. Per-unit timing would
 * need per-unit data, and per-unit data keyed by letter index goes stale the
 * first time the text changes — so it isn't a smaller version of this, it's a
 * different feature with its own storage problem to solve first.
 */
export function AnimationRhythm({
  clip,
  phase,
  spec,
}: {
  clip: TextClip;
  phase: "in" | "out";
  spec: AnimationSpec;
}) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const playheadRef = React.useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = React.useState<TextUnitEvent | null>(null);

  // The epoch under the playhead: with keyframed content the strip should show
  // the cohort you are actually looking at on stage, not the clip's first draft.
  const epochIndex = useEpochAtPlayhead(clip);

  const { events, fromMs, toMs, rows } = React.useMemo(() => {
    const all = textUnitEvents(clip).filter((e) => e.phase === phase && e.epochIndex === epochIndex);
    let lo = Infinity;
    let hi = -Infinity;
    let maxLine = 0;
    for (const e of all) {
      lo = Math.min(lo, e.atMs);
      hi = Math.max(hi, e.atMs + Math.max(e.durationMs, 1));
      maxLine = Math.max(maxLine, e.lineIndex);
    }
    if (!Number.isFinite(lo)) return { events: all, fromMs: 0, toMs: 1, rows: 1 };
    // A hair of padding so a tick at either edge is still a whole tick.
    const pad = Math.max(12, (hi - lo) * 0.04);
    return { events: all, fromMs: lo - pad, toMs: hi + pad, rows: maxLine + 1 };
  }, [clip, phase, epochIndex]);

  const span = toMs - fromMs;
  const pct = (ms: number) => ((ms - fromMs) / span) * 100;

  // The playhead marker is moved by writing to the DOM, never by re-rendering:
  // this panel is mounted during playback and React has no business running 60
  // times a second to slide one line.
  React.useEffect(() => {
    const paint = () => {
      const el = playheadRef.current;
      if (!el) return;
      const local = clipLocalTime(clip, useSession.getState().playheadMs);
      const inside = local !== null && local >= fromMs && local <= toMs;
      el.style.opacity = inside ? "1" : "0";
      if (inside) el.style.left = `${pct(local)}%`;
    };
    paint();
    return useSession.subscribe(paint);
  }, [clip, fromMs, toMs]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Dragging a tick RETIMES THE PATTERN — it never records an exception for
   * that one letter.
   *
   * A unit's start is linear in the spec's own fields:
   *   in  → at = anchor + delay + order·stagger + jitter
   *   out → at = anchor − delay − ((n−1)·stagger + duration) + order·stagger − jitter
   * so a horizontal drag of `dms` inverts to a change in exactly one of them,
   * and the coefficient says which. `order` (entrances) or `order − (n−1)`
   * (exits) is the stagger coefficient; when it is zero — the first tick in, the
   * last tick out — the tick can only be moved by `delay`, which is precisely
   * the tick you would reach for to push the whole run later. ⌥ retimes the
   * duration instead.
   *
   * The result is that every drag lands in a field you can also type into, and
   * nothing is keyed to a letter — so editing the text can never orphan a
   * timing you set.
   */
  /*
   * The strip scrubs left-to-right inside a panel that scrolls up and down, so
   * direction settles it with no pause: across is the value, down is the panel.
   * The press itself used to scrub, which a finger cannot be allowed to do here
   * — a swipe past this strip would have moved the playhead on the way.
   */
  const scrubArm = React.useRef<HeldDrag | null>(null);

  const scrubTo = (clientX: number) => {
    const box = rootRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const t = fromMs + ((clientX - box.left) / box.width) * span;
    useSession.getState().setPlayhead(clip.startMs + Math.max(0, Math.min(clip.durationMs, t)));
  };

  if (events.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-2 py-3 text-center text-[10px] text-muted-foreground">
        No units to animate — this layer has no text yet.
      </div>
    );
  }

  const rowH = spec.unit === "line" ? 18 : 14;
  const readout = hovered
    ? `${hovered.label || "␣"} · ${Math.round(hovered.atMs)}ms`
    : `${events.length} ${unitNoun(spec.unit, events.length)} · ${Math.round(
        Math.max(...events.map((e) => e.atMs + e.durationMs)) - Math.min(...events.map((e) => e.atMs)),
      )}ms total`;

  return (
    <div className="space-y-1">
      <div
        ref={rootRef}
        role="group"
        aria-label={`${phase === "in" ? "Entrance" : "Exit"} rhythm — ${events.length} units`}
        className="relative cursor-ew-resize select-none overflow-hidden rounded-md border bg-muted/30"
        style={{ height: rows * rowH + 10 }}
        onPointerDown={(e) => {
          capturePointer(e.currentTarget, e.pointerId);
          const a = beginHeldDrag(e, { axis: "x" });
          scrubArm.current = a;
          // A mouse, a pen, or a panel with nothing to scroll: the press is
          // already unambiguous, so scrub at once. Otherwise it has to be
          // earned, and a tap covers the press that never moved.
          if (a.armed()) scrubTo(e.clientX);
        }}
        onPointerMove={(e) => {
          const a = scrubArm.current;
          if (!a || e.buttons !== 1) return;
          if (!a.update(e.clientX, e.clientY)) return;
          scrubTo(e.clientX);
        }}
        onPointerUp={(e) => {
          const a = scrubArm.current;
          scrubArm.current = null;
          if (!a) return;
          a.end();
          if (!a.armed() && !a.abandoned()) scrubTo(e.clientX);
        }}
        onPointerCancel={() => {
          scrubArm.current?.end();
          scrubArm.current = null;
        }}
      >
        {/* One baseline per line of text, so the rows read as the text reads. */}
        {Array.from({ length: rows }, (_, r) => (
          <div
            key={r}
            className="absolute inset-x-0 border-t border-border/40"
            style={{ top: 5 + r * rowH + rowH / 2 }}
          />
        ))}

        {events.map((e) => (
          <Tick
            // Phase and time too: a counting number emits many ticks from one
            // unit (`countTicks`), which share epoch, unit and grapheme.
            key={`${e.epochIndex}:${e.unitIndex}:${e.graphemeIndex}:${e.phase}:${Math.round(e.atMs)}`}
            event={e}
            left={pct(e.atMs)}
            width={Math.max(0, (Math.max(e.durationMs, 0) / span) * 100)}
            top={5 + e.lineIndex * rowH}
            height={rowH}
            onHover={setHovered}
          />
        ))}

        <div
          ref={playheadRef}
          className="pointer-events-none absolute inset-y-0 w-px bg-primary opacity-0 transition-opacity"
        />
      </div>
      <div className="flex items-center justify-between px-0.5 text-[10px] tabular-nums text-muted-foreground">
        <span className="truncate">{readout}</span>
        <span className="shrink-0 opacity-60">
          {spec.jitterMs > 0 ? `±${Math.round(spec.jitterMs)}ms` : "even"}
        </span>
      </div>
    </div>
  );
}

/** One unit: a duration tail with a start marker shaped by the unit's grain. */
function Tick({
  event,
  left,
  width,
  top,
  height,
  onHover,
}: {
  event: TextUnitEvent;
  left: number;
  width: number;
  top: number;
  height: number;
  onHover: (e: TextUnitEvent | null) => void;
}) {
  return (
    <div
      className="group absolute"
      style={{ left: `${left}%`, top, height, width: `${width}%`, minWidth: 8 }}
      title={`${event.label || "space"} — starts ${Math.round(event.atMs)}ms, runs ${Math.round(
        event.durationMs,
      )}ms`}
      onPointerEnter={() => onHover(event)}
      onPointerLeave={() => onHover(null)}
    >
      {/* Duration tail — how long this unit is in motion. */}
      <div
        className="absolute rounded-full bg-primary/25 group-hover:bg-primary/50"
        style={{ top: height / 2 - 1, height: 2, left: 0, right: 0 }}
      />
      {event.unit === "letter" ? (
        <div
          className="absolute -translate-x-1/2 rounded-full bg-primary ring-2 ring-background group-hover:scale-125"
          style={{ top: height / 2 - 2.5, width: 5, height: 5, transition: "transform 120ms" }}
        />
      ) : event.unit === "word" ? (
        <div
          className="absolute -translate-x-1/2 rounded-sm bg-primary group-hover:brightness-125"
          style={{ top: height / 2 - 5, width: 2.5, height: 10 }}
        />
      ) : (
        <div className="absolute -translate-x-1/2 rounded-sm bg-primary" style={{ top: 1, width: 2.5, height: height - 2 }} />
      )}
    </div>
  );
}

/** Index of the content epoch under the playhead — recomputed only when the
 *  playhead crosses a cut, so scrubbing inside one epoch is free. */
function useEpochAtPlayhead(clip: TextClip): number {
  const [index, setIndex] = React.useState(0);
  React.useEffect(() => {
    const read = () => {
      const local = clipLocalTime(clip, useSession.getState().playheadMs) ?? 0;
      const next = epochAt(textTimelineOf(clip), local).index;
      setIndex((prev) => (prev === next ? prev : next));
    };
    read();
    return useSession.subscribe(read);
  }, [clip]);
  return index;
}

function unitNoun(unit: AnimationSpec["unit"], n: number): string {
  const base = unit === "letter" ? "letter" : unit === "word" ? "word" : "line";
  return n === 1 ? base : `${base}s`;
}
