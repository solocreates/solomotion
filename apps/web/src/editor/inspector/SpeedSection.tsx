"use client";

import * as React from "react";
import {
  MAX_SPEED,
  MIN_SPEED,
  applyFreeze,
  applySpeedRamp,
  SPEED_PROPERTY,
  clipSourceAvailableMs,
  clipSourceSpanMs,
  clipPlaybackOf,
  findKeyframe,
  isRetimed,
  locateClip,
  moveKeyframe,
  removeClipKeyframes,
  resolveRetimeRipple,
  retimeClip,
  setKeyframe,
  setKeyframeEasing,
  speedSegments,
  type MotionDocument,
  type Clip,
  type SpeedSegment,
} from "@solomotion/core";
import { Minus, RotateCcw, Snowflake, Trash2, TrendingDown, TrendingUp, Waves } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { NumberInput } from "@/components/ui/number-input";
import { EasingPicker } from "@/components/ui/easing-editor";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { mergeReads } from "./merge";
import { usePeers } from "./selection-scope";
import { Disclosure, Note, Pair, PropRow } from "./controls";
import { KeyControl } from "./keyframe-controls";
import { formatRate, ratePercent } from "../timeline/retime-format";

/**
 * SPEED — the rate, and the list of everything that happens to it.
 *
 * The list is a PROJECTION of `clip.keyframes` (`speedSegments`), never a
 * stored parallel structure. That is the whole reason speed keys were the right
 * shape for this feature: a segment list living beside the keys would be a
 * second record of one fact, and the first drag of a handle on the clip — or in
 * the curve editor, or the dope sheet — would put the two out of agreement.
 * Editing a row writes a keyframe; the row redraws because the keyframe moved.
 *
 * Folded by default. A clip that runs at one speed has one number and no list,
 * which is the overwhelming majority of clips; a clip with four ramps has a
 * table you want open and reachable in one click. The disclosure carries the
 * count so the fold advertises its own weight.
 */
/** Admits a clip that has a playback (source-backed) — for `usePeers`. */
export const hasPlayback = (c: Clip): c is Clip => clipPlaybackOf(c) !== null;

/** A clip's rate at a clip-local instant — its segment's, else its base rate. */
function rateAt(clip: Clip, local: number): number {
  const seg = speedSegments(clip).find((s) => s.startMs <= local && s.endMs > local);
  return seg?.fromRate ?? clipPlaybackOf(clip)?.speed ?? 1;
}

export function SpeedSection({ clip }: { clip: Clip }) {
  const doc = useDoc();
  const store = useDocStore();
  const playback = clipPlaybackOf(clip);
  const peers = usePeers(clip, hasPlayback);
  const rate = mergeReads(peers, (c) => clipPlaybackOf(c)?.speed ?? 1);
  const [open, setOpen] = React.useState(false);
  if (!playback) return null;

  const segments = speedSegments(clip);
  const keyed = clip.keyframes.some((t) => t.property === SPEED_PROPERTY && t.keys.length > 0);
  const retimed = isRetimed(clip);
  /*
   * AUDIO KEEPS A CONSTANT RATE, and this is the honest reason rather than an
   * oversight: a varying rate on a waveform is a time-stretch, which this app
   * does properly (WSOLA, baked) and cannot do per-sample from a curve without
   * the bake following it. Until that exists, offering a ramp here would
   * produce a clip whose picture and sound disagreed about where they are. The
   * rate field stays — a constant speed on audio works and always has.
   */
  const rampable = clip.kind !== "audio";

  /** Clip-local playhead, clamped — where every "…here" verb acts. */
  const localNow = () =>
    Math.max(0, Math.min(clip.durationMs, useSession.getState().playheadMs - clip.startMs));

  const write = (label: string, fn: (clip: Clip) => void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        const c = locateClip(d, clip.id)?.clip;
        if (c) fn(c);
      },
      mergeKey ? { mergeKey } : undefined,
    );

  /**
   * The rate and the "…here" verbs act on EVERY selected layer, each at its
   * OWN clip-local playhead (layers start at different times) and from its own
   * rate. The segment list below stays the primary's: it is a list of that
   * clip's keys, and two clips' keys are not one list.
   */
  const writeAll = (label: string, fn: (c: Clip, local: number, d: MotionDocument) => void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        const ph = useSession.getState().playheadMs;
        for (const p of peers) {
          const c = locateClip(d, p.id)?.clip;
          if (c) fn(c, Math.max(0, Math.min(c.durationMs, ph - c.startMs)), d);
        }
      },
      mergeKey ? { mergeKey } : undefined,
    );

  const rateNow = segments.find((s) => s.startMs <= localNow() && s.endMs > localNow())?.fromRate ?? playback.speed;
  const consumed = clipSourceSpanMs(clip);
  // Both numbers are in SOURCE ms, which is the only way they compare: how
  // much footage exists behind this clip, against how much these rates eat.
  const capacity = clipSourceAvailableMs(doc, clip);

  return (
    <>
      <PropRow
        label="Speed"
        /* The diamond is the standard one, on the standard path. Clicking it
           keys the rate at the playhead exactly as it does on every other
           property in the app — which is what makes a ramp two clicks and no
           new vocabulary. */
        keyControl={
          rampable ? (
            <KeyControl clip={clip} property={SPEED_PROPERTY} currentValue={() => playback.speed} label="Speed" />
          ) : undefined
        }
      >
        <Pair>
          <NumberInput
            value={ratePercent(keyed ? rateNow : rate.value)}
            mixed={!keyed && rate.mixed}
            min={MIN_SPEED * 100}
            max={MAX_SPEED * 100}
            step={5}
            precision={0}
            unit="%"
            title={
              keyed
                ? "The rate at the playhead — typing here moves the key it belongs to"
                : "Playback rate. Changing it here also re-times the clip's length."
            }
            onChange={(v) => {
              writeAll(
                "Clip speed",
                (c, local, d) => {
                  if (c.keyframes.some((t) => t.property === SPEED_PROPERTY && t.keys.length > 0)) {
                    // An animated property's value at the playhead IS a key, so
                    // typing writes one — the same rule `commitProperty` applies
                    // everywhere else. The clip's LENGTH is not touched: once a
                    // clip has ramps, its duration is a decision you made, and
                    // rescaling it under a curve would move every key you placed.
                    setKeyframe(c.keyframes, SPEED_PROPERTY, local, v / 100);
                    return;
                  }
                  // No keys: the classic NLE retime — the rate and the clip's
                  // footprint change together, rippling the lane if it should.
                  retimeClip(d, c.id, v / 100, { ripple: resolveRetimeRipple(d, c.id) });
                },
                "pb-speed",
              );
            }}
          />
          {rampable ? (
          <div className="flex items-center gap-1">
            <SpeedVerb
              icon={<Snowflake />}
              label="Freeze frame here"
              hint="Hold this frame for a second — drag the block on the clip to change how long"
              onClick={() => {
                writeAll("Freeze frame", (c, at) => applyFreeze(c, at, 1000));
                toast("Frozen — drag the hatched block on the clip to retime the hold");
              }}
            />
            <SpeedVerb
              icon={<Waves />}
              label="Ramp from here"
              hint="Ease down to half speed over half a second"
              onClick={() => {
                // THE core writer, so the rate carries forward instead of
                // ramping straight back up into a V nobody drew. Each layer
                // halves ITS rate at ITS playhead.
                writeAll("Speed ramp", (c, at) => applySpeedRamp(c, at, 500, (rateAt(c, at) || 1) / 2));
              }}
            />
          </div>
          ) : (
            <div />
          )}
        </Pair>
      </PropRow>

      {/* WHAT THE RATES COST, in the only currency that matters: footage. A
          ramp changes how much source a clip eats, and running out is the one
          mistake retiming makes that you cannot see on the canvas until you
          hit it — the picture simply stops moving. Amber when the clip asks
          for more than the media has. */}
      {retimed && capacity !== null && (
        <PropRow label="Footage" hint="How much of the source this clip plays through at these rates.">
          <Note tone={consumed > capacity + 1 ? "warn" : "muted"}>
            {(consumed / 1000).toFixed(2)}s used of {(capacity / 1000).toFixed(2)}s
            {consumed > capacity + 1 ? " — the tail holds one frame" : ""}
          </Note>
        </PropRow>
      )}

      {/*
        THE CURVE, AS A LIST — holds, with the ramps BETWEEN them.
        See `HoldRow` / `RampRow` for why this shape and not a flat table.
      */}
      {keyed && rampable && peers.length === 1 && (
        <>
          <Disclosure
            open={open}
            onToggle={() => setOpen(!open)}
            label="Speed changes"
            count={segments.filter((s) => s.kind === "hold").length}
          />
          {open && (
            <div className="grid gap-px rounded-md border border-border/50 bg-input/20 p-1">
              {segments.map((seg, i) =>
                seg.kind === "hold" ? (
                  <HoldRow
                    key={`h${seg.startMs}`}
                    clip={clip}
                    seg={seg}
                    index={holdIndex(segments, i)}
                    write={write}
                  />
                ) : (
                  <RampRow key={`r${seg.startMs}`} clip={clip} seg={seg} write={write} />
                ),
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Which hold this is, counting only holds — the number the row wears. */
function holdIndex(segments: SpeedSegment[], at: number): number {
  let n = 0;
  for (let i = 0; i <= at; i++) if (segments[i]!.kind === "hold") n++;
  return n;
}

function SpeedVerb({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} — ${hint}`}
      onClick={onClick}
      className="flex h-7 flex-1 items-center justify-center rounded-md border border-transparent bg-input/45 text-muted-foreground transition-colors hover:border-border hover:text-foreground [&_svg]:size-3.5"
    >
      {icon}
    </button>
  );
}

/** Seconds, as the list writes them: two decimals, no unit clutter per cell. */
const secs = (ms: number) => (ms / 1000).toFixed(2);

/**
 * A HOLD — a stretch of the clip that runs at one rate.
 *
 * The list used to alternate two DIFFERENT row shapes through the same columns:
 * one row's second cell was a rate and the next row's was a transition, one
 * row's third cell was seconds and the next row's was an easing name. Nothing
 * could be scanned down a column, and neither shape said what it was — so five
 * rows of numbers read as one undifferentiated block, and the `1 ×` field sat
 * directly above a `1× → 21%` label spelling the same quantity two ways.
 *
 * A speed curve is HOLDS CONNECTED BY RAMPS, so that is the list: a hold is a
 * row, a ramp is the connector drawn between two of them. Rates line up under
 * rates, lengths under lengths, and the transitions are visibly subordinate to
 * the things they join.
 */
function HoldRow({
  clip,
  seg,
  index,
  write,
}: {
  clip: Clip;
  seg: SpeedSegment;
  index: number;
  write: (label: string, fn: (clip: Clip) => void, mergeKey?: string) => void;
}) {
  const spanMs = seg.endMs - seg.startMs;

  /** A hold's rate is BOTH its keys — otherwise editing it makes a ramp. */
  const setRate = (pct: number) =>
    write(
      "Clip speed",
      (c) => {
        setKeyframe(c.keyframes, SPEED_PROPERTY, seg.startMs, pct / 100);
        if (seg.toKeyId) setKeyframe(c.keyframes, SPEED_PROPERTY, seg.endMs, pct / 100);
      },
      `hold-rate-${seg.startMs}`,
    );

  /** Its length is where the closing key sits — the row stores no duration. */
  const setSpan = (sec: number) =>
    write(
      "Hold length",
      (c) => {
        if (!seg.toKeyId) return;
        moveKeyframe(c.keyframes, seg.toKeyId, Math.max(seg.startMs + 2, seg.startMs + sec * 1000), {
          merge: false,
        });
      },
      `hold-span-${seg.startMs}`,
    );

  const jump = () => {
    const s = useSession.getState();
    s.setPlaying(false);
    s.setPlayhead(clip.startMs + seg.startMs);
  };

  const remove = () =>
    write("Remove speed change", (c) => {
      const found = seg.fromKeyId ? findKeyframe(c.keyframes, seg.fromKeyId) : null;
      if (found) removeClipKeyframes(c, [found.key.id], seg.startMs);
    });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div
      className={cn(
        "group/seg grid grid-cols-[1.5rem_1fr_1fr_1.25rem] items-center gap-1 rounded-[3px] px-1 py-0.5",
        seg.frozen ? "bg-[#7DD3FC]/12" : "bg-background/40",
      )}
    >
      <button
        type="button"
        onClick={jump}
        title={`${secs(seg.startMs)}s – ${secs(seg.endMs)}s · jump here`}
        className={cn(
          "flex items-center gap-0.5 text-left font-mono text-[9px] tabular-nums transition-colors",
          seg.frozen ? "text-[#7DD3FC]" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {seg.frozen ? <Snowflake className="size-2.5" /> : <span className="w-2.5 text-center">{index}</span>}
      </button>

      {/*
        A FREEZE IS A RATE OF ZERO, SO IT KEEPS THE RATE FIELD.

        This row used to swap the field for a static "Freeze" chip, and that
        made freezing a ONE-WAY DOOR: drag a handle down to 0 (or type it) and
        the one control that could have taken you back had just been replaced
        by a label — the state was reachable and unleavable, which is the worst
        kind there is. The freeze now reads from the ROW (snowflake, tint,
        tooltip) and 0 sits in the field where 100 goes to undo it.
      */}
      <NumberInput
        value={ratePercent(seg.fromRate)}
        min={MIN_SPEED * 100}
        max={MAX_SPEED * 100}
        step={5}
        precision={0}
        unit="%"
        className={cn("h-6", seg.frozen && "text-[#7DD3FC]")}
        title={
          seg.frozen
            ? `Frozen from ${secs(seg.startMs)}s to ${secs(seg.endMs)}s — type a rate to start it moving again`
            : `Runs at this rate from ${secs(seg.startMs)}s to ${secs(seg.endMs)}s`
        }
        onChange={setRate}
      />

      <NumberInput
        value={Number(secs(spanMs))}
        min={0.01}
        step={0.05}
        precision={2}
        unit="s"
        className="h-6"
        disabled={!seg.toKeyId}
        title={seg.toKeyId ? "How long this stretch lasts" : "Runs to the end of the clip"}
        onChange={setSpan}
      />

      <button
        type="button"
        aria-label="Remove this speed change"
        title="Remove this speed change"
        disabled={!seg.fromKeyId}
        onClick={remove}
        className="flex size-5 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-hover/seg:opacity-100 disabled:pointer-events-none [&_svg]:size-3"
      >
        <Trash2 />
      </button>
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={jump}>Jump to {secs(seg.startMs)}s</ContextMenuItem>
        <ContextMenuSeparator />
        {/* Freeze and unfreeze are ONE item, because they are one switch. An
            "unfreeze" that only appeared once you were stuck would be the
            same one-way door in a menu. */}
        <ContextMenuItem onClick={() => setRate(seg.frozen ? 100 : 0)}>
          <Snowflake /> {seg.frozen ? "Unfreeze — run at 100%" : "Freeze this stretch"}
        </ContextMenuItem>
        <ContextMenuItem disabled={Math.abs(seg.fromRate - 1) < 0.0005} onClick={() => setRate(100)}>
          <RotateCcw /> Reset to 100%
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!seg.fromKeyId}
          className="text-destructive focus:text-destructive"
          onClick={remove}
        >
          <Trash2 /> Remove this speed change
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * A RAMP — the transition BETWEEN two holds, drawn as a connector rather than
 * as a peer of them. Indented, half-height, with the rule line running through
 * it, so the eye reads "these two holds, joined like this" instead of "five
 * things in a list, two of which are strange".
 *
 * It owns exactly the two facts a transition has: how long it takes, and what
 * shape it takes. The rates at either end belong to the holds it joins, and
 * showing them here again is what made the old list feel repeated.
 */
function RampRow({
  clip,
  seg,
  write,
}: {
  clip: Clip;
  seg: SpeedSegment;
  write: (label: string, fn: (clip: Clip) => void, mergeKey?: string) => void;
}) {
  const spanMs = seg.endMs - seg.startMs;
  const faster = seg.toRate > seg.fromRate;

  /**
   * TURN THE RAMP AROUND, on purpose.
   *
   * "It's easy to become inverse" was a real complaint about a real accident,
   * and the fix for the accident is `applySpeedRamp` carrying its rate forward.
   * But inverting a ramp is also a thing people MEAN — the slow-down you built
   * wants to be the speed-up out of it — and there was no way to say it except
   * by retyping both holds. One item, and it swaps the two keys' values.
   */
  const reverse = () =>
    write("Reverse ramp", (c) => {
      if (!seg.fromKeyId || !seg.toKeyId) return;
      const a = findKeyframe(c.keyframes, seg.fromKeyId);
      const b = findKeyframe(c.keyframes, seg.toKeyId);
      if (!a || !b) return;
      a.key.value = seg.toRate;
      b.key.value = seg.fromRate;
    });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div className="grid grid-cols-[1.5rem_1fr_1fr_1.25rem] items-center gap-1 px-1">
      <span
        aria-hidden
        className="flex h-6 items-center justify-center text-muted-foreground/40"
        title={faster ? "Speeding up" : "Slowing down"}
      >
        {faster ? <TrendingUp className="size-2.5" /> : <TrendingDown className="size-2.5" />}
      </span>
      <EasingPicker
        className="h-6 bg-transparent"
        value={seg.easing ?? { kind: "linear" }}
        onChange={(easing) =>
          write("Set easing", (c) => {
            if (seg.fromKeyId) setKeyframeEasing(c.keyframes, seg.fromKeyId, easing);
          })
        }
      />
      <NumberInput
        value={Number(secs(spanMs))}
        min={0.01}
        step={0.05}
        precision={2}
        unit="s"
        className="h-6"
        title={`Takes this long to go from ${formatRate(seg.fromRate)} to ${formatRate(seg.toRate)}`}
        onChange={(sec) =>
          write(
            "Ramp length",
            (c) => {
              if (!seg.toKeyId) return;
              moveKeyframe(c.keyframes, seg.toKeyId, Math.max(seg.startMs + 2, seg.startMs + sec * 1000), {
                merge: false,
              });
            },
            `ramp-span-${seg.startMs}`,
          )
        }
      />
      <span />
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={reverse}>
          {faster ? <TrendingDown /> : <TrendingUp />} Reverse — {formatRate(seg.toRate)} →{" "}
          {formatRate(seg.fromRate)}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => write("Set easing", (c) => {
          if (seg.fromKeyId) setKeyframeEasing(c.keyframes, seg.fromKeyId, { kind: "linear" });
        })}>
          <Minus /> Make it linear
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* Removing a RAMP means removing the transition, not one of its ends:
            the two holds either side collapse into one. Deleting a single key
            would leave a ramp from the surviving end to whatever came next,
            which is never what "remove this ramp" means. */}
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() =>
            write("Remove ramp", (c) => {
              const ids = [seg.fromKeyId, seg.toKeyId].filter((id): id is string => !!id);
              removeClipKeyframes(c, ids, seg.startMs);
            })
          }
        >
          <Trash2 /> Remove this ramp
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
