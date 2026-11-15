"use client";

import * as React from "react";
import {
  EASING_PRESET_LABELS,
  CUT_MS,
  FREEZE_EPSILON,
  MAX_SPEED,
  MIN_SPEED,
  SPEED_PROPERTY,
  applyFreeze,
  applySpeedRamp,
  clearClipKeyframes,
  isRetimed,
  locateClip,
  setKeyframe,
  speedAt,
  mergeCoincidentKeyframes,
  findKeyframe,
  moveKeyframe,
  removeClipKeyframes,
  speedKeyBounds,
  setKeyframeEasing,
  speedSegments,
  type Clip,
  type EasingPresetName,
  type Keyframe,
  type SpeedSegment,
} from "@solomotion/core";
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
import { CirclePlus, Snowflake, Trash2, Waves } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { readMods } from "../state/drag-modifiers";
import { beginScrubDrag } from "./scrub";
import { pxToTime, timeToPx } from "./timeline-utils";
import { useClipChrome, type ClipDetail } from "./clip-chrome";
import { formatRate } from "./retime-format";

/**
 * THE RETIME BAND — a clip's speed, drawn where the speed is.
 *
 * A retimed clip used to look exactly like a clip running at 1×. The rate was
 * a number in a submenu, a ramp was invisible, and a freeze was indistinguishable
 * from footage that happened not to move. So every question a person has while
 * cutting — *is this the slow bit? where does it come back up? how long is the
 * hold?* — could only be answered by scrubbing.
 *
 * The band answers all three at a glance, and it is a DRAWING OF THE KEYS
 * rather than a second model: the polyline is `speedSegments`, which is derived
 * from `clip.keyframes` on every read, and the handles ARE the speed keyframes.
 * Drag one and the curve follows because it is the same object; open the curve
 * editor and you are editing the same track from the other side.
 *
 * Which is also why the generic keyframe lane hides `playback.speed`: two rows
 * of handles for one track is the classic two-records-of-one-fact bug, and the
 * diamond in the lane could not say what it meant. Here it can.
 *
 * Log-scaled, because speed is a RATIO. On a linear axis 2× and 0.5× — equal
 * and opposite edits — sit 1.5 units apart and 0.5 units apart, so a slow-motion
 * ramp is a crease at the bottom of the band and a speed-up runs off the top.
 */

/**
 * The band's vertical span. `micro` shows nothing; `compact` is a hairline
 * reading; `full` GROWS WITH THE LANE, because the height is not decoration
 * here — it is the resolution of the rate axis, and you drag handles up and
 * down it. Seventeen pixels made 40% and 60% the same pixel.
 */
const BAND_H = { micro: 0, compact: 7, full: 17 } as const;
function bandHeight(detail: ClipDetail, laneHeightPx: number): number {
  if (detail !== "full") return BAND_H[detail];
  return Math.round(Math.min(34, Math.max(20, laneHeightPx * 0.42)));
}

/**
 * How far the keyframe lane lifts when a band is present.
 *
 * The clip's bottom edge is shared real estate — the keyframe diamonds were
 * already there — so the band publishes its own height rather than letting the
 * lane guess it, which is what keeps them from drifting apart the next time a
 * tier changes. `full` is the only tier where both are drawn.
 */
export const RETIME_BAND_LIFT = BAND_H.full;
/** Display range. Beyond this the curve pins rather than leaving the band. */
const PLOT_MIN = 0.1;
const PLOT_MAX = 8;
/** A flat run narrower than this has no room for its own rate. */
const LABEL_MIN_PX = 30;

function plotY(rate: number, h: number): number {
  const r = Math.min(PLOT_MAX, Math.max(PLOT_MIN, Math.abs(rate)));
  const u = Math.log(r / PLOT_MIN) / Math.log(PLOT_MAX / PLOT_MIN);
  // 2px of padding so the line at the extremes is still a line, not an edge.
  return h - 2 - u * (h - 4);
}

/**
 * How much vertical travel DOUBLES the rate.
 *
 * Deliberately NOT the band's own geometry. The band is a readout and has to
 * stay out of the way — 24px tall over a range of 0.1× to 8× — so mapping the
 * drag through it made ten pixels take 50% to 450%: a control you cannot aim.
 * The plot's job is to be readable at a glance; the gesture's job is to be
 * steerable, and those want different scales. 90px per octave is a comfortable
 * mouse travel and, because the axis is logarithmic, "up to double" costs
 * exactly what "down to half" costs.
 */
const PX_PER_OCTAVE = 90;
/** The fine modifier divides the travel, the same way it does on every slider. */
const FINE_DIVISOR = 5;

export function RetimeBand({ clip, pxPerSec }: { clip: Clip; pxPerSec: number }) {
  const store = useDocStore();
  const { active, detail, laneHeightPx } = useClipChrome();
  // The clip-local time the context menu was opened at — every verb in it is
  // "…here", and "here" is where you right-clicked, not where the playhead is.
  // Declared before the early return, because hooks are.
  const atRef = React.useRef(0);
  const height = bandHeight(detail, laneHeightPx);
  if (height === 0 || !isRetimed(clip)) return null;

  const segments = speedSegments(clip);
  const width = Math.max(1, timeToPx(clip.durationMs, pxPerSec));
  const track = clip.keyframes.find((k) => k.property === SPEED_PROPERTY);
  const keys = track ? [...track.keys].sort((a, b) => a.timeMs - b.timeMs) : [];

  /**
   * The keys a freeze owns: its two ends and the cut key just outside each.
   * Derived here, once, so the block and the handle list cannot disagree about
   * which dots belong to which object.
   */
  const ownedByFreeze = new Set<string>();
  for (const seg of segments) {
    if (!seg.frozen) continue;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (Math.abs(k.timeMs - seg.startMs) < 1 || Math.abs(k.timeMs - seg.endMs) < 1) {
        ownedByFreeze.add(k.id);
        // Its cut partner — the key a couple of ms outside the hold that makes
        // the rate change instant. It moves with the edge, so it is not its own.
        const partner = Math.abs(k.timeMs - seg.startMs) < 1 ? keys[i - 1] : keys[i + 1];
        if (partner && Math.abs(partner.timeMs - k.timeMs) <= CUT_MS + 0.5) ownedByFreeze.add(partner.id);
      }
    }
  }

  // One polyline through every segment's two ends. A ramp draws as the straight
  // line between its rates rather than as its eased shape — deliberately: the
  // band is a READING of the timing, and at 17px an ease-in-out and a linear
  // ramp are the same three pixels. The curve editor is where a curve is shaped.
  const points: string[] = [];
  for (const seg of segments) {
    points.push(`${timeToPx(seg.startMs, pxPerSec)},${plotY(seg.fromRate, height)}`);
    points.push(`${timeToPx(seg.endMs, pxPerSec)},${plotY(seg.toRate, height)}`);
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={!active}>
    <div
      /* A SCRIM under the curve. The band sits over the poster strip, and a
         one-pixel amber line across a row of thumbnails is invisible exactly
         where the thumbnails are busiest — which is most of them. */
      className="absolute inset-x-0 bottom-0 overflow-hidden rounded-b-md bg-gradient-to-t from-background/80 to-background/35"
      style={{ height }}
      /* WHERE the menu was opened, because every verb in it is "…here". Read
         off the event rather than tracked as state: it is only ever needed for
         the one click that produced it. */
      onContextMenu={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        atRef.current = Math.max(
          0,
          Math.min(clip.durationMs, pxToTime(e.clientX - rect.left, pxPerSec)),
        );
      }}
    >
      {/* FREEZES first, under the line: they are a REGION, not a value — which
          is also why they are the thing you grab. */}
      {segments
        .filter((s) => s.frozen)
        .map((s) => (
          <FreezeBlock
            key={`f${s.startMs}`}
            clip={clip}
            seg={s}
            keys={keys}
            pxPerSec={pxPerSec}
            height={height}
            store={store}
            active={active}
          />
        ))}

      <svg
        className="pointer-events-none absolute inset-0"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden
      >
        {/* 1× — the line the curve is read AGAINST. Without it "above" and
            "below" have no meaning and the band is just a wiggle. */}
        <line
          x1={0}
          x2={width}
          y1={plotY(1, height)}
          y2={plotY(1, height)}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="2 3"
          className="text-foreground/25"
        />
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={detail === "full" ? 1.5 : 1}
          strokeLinejoin="round"
          className="text-(--kind-speed)"
        />
      </svg>

      {/* The RATE, written on the runs that hold one. A ramp says nothing: its
          two ends are already labelled by the runs either side of it, and a
          number in the middle of a change would be a number that is wrong
          everywhere except one instant. */}
      {detail === "full" &&
        segments.map((s) => {
          if (s.kind !== "hold") return null;
          const w = timeToPx(s.endMs - s.startMs, pxPerSec);
          if (w < LABEL_MIN_PX) return null;
          return (
            <span
              key={`l${s.startMs}`}
              /* CENTRED, not left-anchored. A long run that begins off the left
                 edge of the viewport had its only label scrolled away with it,
                 so the one stretch you could most easily read was the one that
                 said nothing. */
              className={cn(
                "pointer-events-none absolute top-0 flex items-center justify-center truncate px-1 font-mono text-[9px] font-medium leading-none",
                s.frozen ? "text-(--kind-frozen)" : "text-(--kind-speed)",
              )}
              style={{ left: timeToPx(s.startMs, pxPerSec), width: w, height: 11 }}
            >
              {s.frozen ? "freeze" : formatRate(s.fromRate)}
            </span>
          );
        })}

      {/* THE HANDLES — the speed keyframes themselves, on the curve they make.
          Minus the ones a FREEZE owns: those four express one object, the block
          is that object's handle, and drawing both put a key dot exactly on top
          of the block's edge grip. Dragging what looked like the end of a hold
          then moved only its cut partner and turned the cut into a ramp — the
          same "two sets of handles for one thing" mistake that keeps the speed
          track out of the generic keyframe lane, one level down. */}
      {active &&
        detail !== "micro" &&
        keys.filter((k) => !ownedByFreeze.has(k.id)).map((key) => (
          <SpeedHandle
            key={key.id}
            clip={clip}
            keyframe={key}
            pxPerSec={pxPerSec}
            height={height}
            store={store}
          />
        ))}
    </div>
      </ContextMenuTrigger>
      {/*
       * ADDING A SPEED CHANGE, where you are pointing.
       *
       * Everything that makes a curve had to be started from the inspector,
       * which put the verb on the opposite side of the screen from the thing
       * it acts on — and made it act at the PLAYHEAD rather than at the point
       * you were looking at. These three are the whole vocabulary, and the
       * wording says how many keys each one is, because that is the fact that
       * explains the list afterwards: a point is one, a ramp is two, a freeze
       * is a range.
       */}
      <ContextMenuContent className="w-60">
        <ContextMenuItem
          onClick={() =>
            store.update("Add speed point", (d) => {
              const c = locateClip(d, clip.id)?.clip;
              if (c) setKeyframe(c.keyframes, SPEED_PROPERTY, atRef.current, speedAt(c, atRef.current));
            })
          }
        >
          <CirclePlus /> Add a speed point here
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            store.update("Speed ramp", (d) => {
              const c = locateClip(d, clip.id)?.clip;
              if (c) applySpeedRamp(c, atRef.current, 500, (speedAt(c, atRef.current) || 1) / 2);
            })
          }
        >
          <Waves /> Ramp to half speed from here
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            store.update("Freeze frame", (d) => {
              const c = locateClip(d, clip.id)?.clip;
              if (c) applyFreeze(c, atRef.current, 1000);
            })
          }
        >
          <Snowflake /> Freeze a second here
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() =>
            store.update("Flatten speed", (d) => {
              const c = locateClip(d, clip.id)?.clip;
              if (c) clearClipKeyframes(c, [SPEED_PROPERTY], atRef.current);
            })
          }
        >
          <Trash2 /> Flatten to one speed
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * A HOLD, as an object you can move.
 *
 * The four keys that express a freeze (rate, 0, 0, rate — see `freezeKeys`) are
 * an implementation of one idea, and asking someone to drag four dots to move a
 * hold by ten frames is making them do the model's bookkeeping. The block IS
 * the hold: drag its middle to slip it, drag an edge to lengthen it, right-click
 * to take it away. Each of those still writes nothing but keyframes, so the
 * curve editor and the dope sheet see exactly what happened.
 *
 * Each boundary moves WITH ITS CUT PARTNER — the key a couple of milliseconds
 * outside it that makes the rate change instantaneous. Moving one without the
 * other is how a hard cut silently turns into a ramp, or inverts.
 */
function FreezeBlock({
  clip,
  seg,
  keys,
  pxPerSec,
  height,
  store,
  active,
}: {
  clip: Clip;
  seg: SpeedSegment;
  keys: Keyframe[];
  pxPerSec: number;
  height: number;
  store: ReturnType<typeof useDocStore>;
  active: boolean;
}) {
  /** The keys this hold is made of: its two ends, plus the cuts either side. */
  const at = (ms: number) => keys.find((k) => Math.abs(k.timeMs - ms) < 1);
  const startKey = at(seg.startMs);
  const endKey = at(seg.endMs);
  const leadKey = [...keys].reverse().find((k) => k.timeMs < seg.startMs - 0.5);
  const tailKey = keys.find((k) => k.timeMs > seg.endMs + 0.5);

  const move = (which: "body" | "start" | "end") => (e: React.PointerEvent) => {
    if (!active || e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX;
    // Which keys travel, and from where. Captured up front so a drag that
    // crosses another key does not start chasing whatever is under it now.
    const group =
      which === "body"
        ? [leadKey, startKey, endKey, tailKey]
        : which === "start"
          ? [leadKey, startKey]
          : [endKey, tailKey];
    const origins = group
      .filter((k): k is Keyframe => !!k)
      .map((k) => ({ id: k.id, timeMs: k.timeMs }));
    if (origins.length === 0) return;
    const mergeKey = `freeze-${which}-${seg.startMs}-${e.pointerId}`;
    /*
     * The hold may not be dragged shorter than nothing, or through its own
     * cuts — and the group's OWN EXTENT is part of the limit. Clamping each key
     * separately let the trailing cut key pin against the clip's end while the
     * hold kept growing, which silently turned a hard cut back into a ramp: the
     * exact failure a group drag exists to prevent, arriving through the clamp
     * instead of through the drag.
     */
    const span = origins[origins.length - 1]!.timeMs - origins[0]!.timeMs;
    const floor = which === "end" ? seg.startMs + CUT_MS * 2 : 0;
    const ceil = (which === "start" ? seg.endMs - CUT_MS * 2 : clip.durationMs) - (which === "end" ? span : 0);

    beginScrubDrag(
      e,
      (clientX) => {
        const raw = pxToTime(clientX - startX, pxPerSec);
        // Clamp the GROUP, not each key: they keep their spacing, which is what
        // makes a cut stay a cut and a ramp keep its length.
        const anchor = which === "end" ? seg.endMs : seg.startMs;
        const delta = Math.max(floor - anchor, Math.min(ceil - anchor, raw));
        store.update(
          which === "body" ? "Move freeze" : "Freeze length",
          (d) => {
            const c = locateClip(d, clip.id)?.clip;
            if (!c) return;
            for (const o of origins) {
              moveKeyframe(c.keyframes, o.id, Math.max(0, Math.min(clip.durationMs, o.timeMs + delta)), {
                merge: false,
              });
            }
          },
          { mergeKey },
        );
      },
      () =>
        store.update(
          "Move freeze",
          (d) => {
            const c = locateClip(d, clip.id)?.clip;
            if (c) mergeCoincidentKeyframes(c.keyframes, new Set(origins.map((o) => o.id)));
          },
          { mergeKey },
        ),
    );
  };

  const remove = () =>
    store.update("Remove freeze", (d) => {
      const c = locateClip(d, clip.id)?.clip;
      if (!c) return;
      const ids = [leadKey, startKey, endKey, tailKey].filter((k): k is Keyframe => !!k).map((k) => k.id);
      removeClipKeyframes(
        c,
        ids,
        Math.max(0, Math.min(c.durationMs, useSession.getState().playheadMs - c.startMs)),
      );
    });

  const width = Math.max(2, timeToPx(seg.endMs - seg.startMs, pxPerSec));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          title={`Held for ${((seg.endMs - seg.startMs) / 1000).toFixed(2)}s — drag to move, drag an edge to change the hold`}
          onPointerDown={move("body")}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cn(
            "absolute inset-y-0 border-x border-(--kind-frozen)/60 touch-none",
            active ? "cursor-slip" : "cursor-default",
          )}
          style={{
            left: timeToPx(seg.startMs, pxPerSec),
            width,
            backgroundImage:
              "repeating-linear-gradient(-45deg, rgba(125,211,252,0.30) 0 3px, transparent 3px 7px)",
          }}
        >
          {active && width > 12 && (
            <>
              <span
                onPointerDown={move("start")}
                className="absolute inset-y-0 left-0 z-10 w-(--hit-grip) -translate-x-1/2 cursor-trim-start"
              />
              <span
                onPointerDown={move("end")}
                className="absolute inset-y-0 right-0 z-10 w-(--hit-grip) translate-x-1/2 cursor-trim-end"
              />
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onClick={remove}
        >
          Remove freeze
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function SpeedHandle({
  clip,
  keyframe,
  pxPerSec,
  height,
  store,
}: {
  clip: Clip;
  keyframe: Keyframe;
  pxPerSec: number;
  height: number;
  store: ReturnType<typeof useDocStore>;
}) {
  const rate = typeof keyframe.value === "number" ? keyframe.value : 1;
  const frozen = Math.abs(rate) < FREEZE_EPSILON;
  // The live rate, shown at the handle while it is being dragged. Without it a
  // vertical drag is guesswork: the curve moves, and you find out what you
  // chose by reading the panel afterwards.
  const [readout, setReadout] = React.useState<string | null>(null);

  /**
   * TWO AXES. Sideways moves the key in time; up and down changes the RATE.
   *
   * A curve editor where the value axis is unreachable is a chart, and that is
   * what this was: every rate change had to be typed into the panel while the
   * shape you were trying to make sat on the other side of the screen. The
   * The axis is logarithmic, so "up to double" and "down to half" cost the
   * same travel — and the travel is a fixed `PX_PER_OCTAVE` rather than the
   * band's own height, because a 24px readout is not a 24px control. ⌥ makes
   * it fine, like every other value drag in the app.
   *
   * Time is CLAMPED BETWEEN THE NEIGHBOURS (`speedKeyBounds`). Keys are allowed
   * to cross in the generic engine, and on a position track that is fine; here
   * the order IS the sequence of holds and ramps, so a crossing silently
   * inverts the shape under the cursor. ⇧ locks whichever axis the gesture
   * committed to first, the same constrain the rest of the app uses.
   */
  const drag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const originMs = keyframe.timeMs;
    const originRate = rate;
    const bounds = speedKeyBounds(clip, keyframe.id) ?? { lo: 0, hi: clip.durationMs };
    const mergeKey = `speed-key-${keyframe.id}-${e.pointerId}`;
    let axis: "x" | "y" | null = null;

    beginScrubDrag(
      e,
      (clientX, clientY) => {
        const dx = clientX - startX;
        const dy = clientY - startY;
        // The axis a ⇧-drag commits to is the one it moved along first — read
        // once, then held, so the gesture cannot flip mid-drag.
        if (axis === null && Math.hypot(dx, dy) > 4) axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        const mods = readMods(e);
        const locked = mods.shift ? axis : null;

        const t =
          locked === "y"
            ? originMs
            : Math.max(bounds.lo, Math.min(bounds.hi, originMs + pxToTime(dx, pxPerSec)));
        // Up is faster: a fixed travel per octave, so the feel does not change
        // with the lane's height and a doubling always costs the same drag.
        const travel = dy / (mods.alt ? PX_PER_OCTAVE / FINE_DIVISOR : PX_PER_OCTAVE);
        /*
         * A RATE OF ZERO MUST BE LEAVABLE.
         *
         * Two ways this used to be a one-way door, and both are here. The
         * handle refused to change a frozen key's rate at all — right for the
         * four keys a freeze BLOCK owns (they are excluded from this list
         * entirely), wrong for a lone key someone dragged down to zero, which
         * then sat there with no gesture able to lift it. And the maths could
         * not have lifted it anyway: the drag is multiplicative, so zero times
         * any factor is still zero. Dragging out of a standstill starts from
         * the floor of the plot instead.
         */
        const stopped = Math.abs(originRate) < FREEZE_EPSILON;
        const nextRate =
          locked === "x"
            ? originRate
            : stopped && dy >= 0
              ? 0 // already stopped, still dragging down — nothing below a stop
              : Math.min(
                  MAX_SPEED,
                  Math.max(0.01, (stopped ? PLOT_MIN : originRate) * Math.pow(2, -travel)),
                );

        setReadout(locked === "x" ? null : formatRate(nextRate));
        store.update(
          "Move speed key",
          (d) => {
            const c = locateClip(d, clip.id)?.clip;
            if (!c) return;
            // merge:false — a key shoved against its neighbour must survive the
            // drag; coincidences collapse once, on release, like the lane's.
            moveKeyframe(c.keyframes, keyframe.id, t, { merge: false });
            if (locked !== "x" && !frozen) {
              const found = findKeyframe(c.keyframes, keyframe.id);
              if (found) found.key.value = Math.round(nextRate * 1000) / 1000;
            }
          },
          { mergeKey },
        );
      },
      () => {
        setReadout(null);
        store.update(
          "Move speed key",
          (d) => {
            const c = locateClip(d, clip.id)?.clip;
            if (c) mergeCoincidentKeyframes(c.keyframes, new Set([keyframe.id]));
          },
          { mergeKey },
        );
      },
    );
  };

  const setEasing = (name: EasingPresetName) =>
    store.update("Set easing", (d) => {
      const c = locateClip(d, clip.id)?.clip;
      if (c) setKeyframeEasing(c.keyframes, keyframe.id, { kind: "preset", name });
    });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          title={`${formatRate(rate)} at ${(keyframe.timeMs / 1000).toFixed(2)}s — drag sideways to move it, up and down to change the rate (⇧ locks an axis)`}
          onPointerDown={drag}
          onDoubleClick={(e) => e.stopPropagation()}
          className="absolute z-10 w-(--hit-grip) -translate-x-1/2 cursor-grab touch-none active:cursor-grabbing"
          style={{ left: timeToPx(keyframe.timeMs, pxPerSec), top: 0, height }}
        >
          <span
            className={cn(
              "absolute left-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-background/80 shadow transition-transform",
              readout ? "scale-125" : "hover:scale-125",
              frozen ? "bg-(--kind-frozen)" : "bg-(--kind-speed)",
            )}
            style={{ top: plotY(rate, height) }}
          />
          {readout && (
            <span className="material-chip pointer-events-none absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-1 font-mono text-[9px] text-(--kind-speed)">
              {readout}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuSub>
          <ContextMenuSubTrigger>Ramp into this — easing</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ScrollArea className="max-h-72">
              {Object.entries(EASING_PRESET_LABELS).map(([name, label]) => (
                <ContextMenuItem key={name} onClick={() => setEasing(name as EasingPresetName)}>
                  {label}
                </ContextMenuItem>
              ))}
            </ScrollArea>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() =>
            store.update("Delete speed key", (d) => {
              const c = locateClip(d, clip.id)?.clip;
              if (c) {
                removeClipKeyframes(
                  c,
                  [keyframe.id],
                  Math.max(0, Math.min(c.durationMs, useSession.getState().playheadMs - c.startMs)),
                );
              }
            })
          }
        >
          Delete speed key
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export { MIN_SPEED, MAX_SPEED };
