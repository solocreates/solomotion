"use client";

import * as React from "react";
import type { BrushPreset } from "@solomotion/core";
import { SlidersHorizontal } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { NumberInput } from "@/components/ui/number-input";
import { PopoverTrigger } from "@/components/ui/popover";
import { Range } from "@/components/ui/range";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSession } from "../state/session";
import { useHoldMenu } from "../state/use-hold-menu";
import { CHROME_CAPSULE, useChromeColumnHeight, useChromeFlyoutSide } from "../stage/StageChrome";
import { HANDLE_PAD, resolveHandleLayout, type HandleLayout } from "./handle-density";
import { PaintSettings, usePaintSettings } from "./PaintSettings";
import { OpacityPreview, SizePreview, SmoothingPreview } from "./paint-preview";
import {
  PAINT_DIAL_ORDER,
  dialFieldProps,
  useHandleCarriesDials,
  usePaintDials,
  type PaintDial,
  type PaintDials,
  type PaintMode,
} from "./paint-dials";
import { useShiftHeld } from "./smoothing-modifier";

/**
 * THE BRUSH HANDLE — Procreate's sidebar.
 *
 * Size and smoothing are the two numbers you change constantly while drawing,
 * and the only other way to them is a field at the top of the screen: stop,
 * look up, aim, lose the stroke you were in. A fader pinned to the canvas edge
 * is a different instrument — under your thumb, and workable while the other
 * hand keeps drawing.
 *
 * A stack of identical cells, then the switches, then the door:
 *
 *      fader     the gesture — coarse, fast, no aiming
 *      field     the exact number — scrub it or type it
 *      ────
 *      modes     the tool's everyday on/offs, two across
 *      settings  the tweak icon — everything else, once, at the foot
 *
 * ── THE CELLS ARE IDENTICAL, and that is the shape that changed. ──
 *
 * Smoothing used to carry a cap button of its own, directly above its fader,
 * because it is the one dial with an everyday on/off. So the column was ragged:
 * two bare faders and a third wearing a hat, with a second button at the foot,
 * and no way to tell from the layout which of the two buttons was a mode and
 * which was a door. Pen pressure — the other switch of the same kind — was
 * nowhere near it, sitting in the tool options bar at the top of the screen
 * beside a settings icon that opened the very same sheet as the handle's.
 *
 * The switches are a LIST now (`PaintMode`, in the dial registry), they sit
 * together in one row above the door, and the bar has stopped carrying them
 * while the handle is up. Smoothing and pressure are two answers to "how much
 * of this stroke is mine", so they belong side by side; a dial cell is a fader
 * and its number, every time.
 *
 * ── IT FITS THE STAGE IT IS GIVEN. ──
 *
 * It used to ask for a definite 356px and wear `max-h-full` over the top. On a
 * short stage that clamp does not remove anything — it shrinks whatever is
 * flexible, which is only ever the faders — so the handle kept every field,
 * every button and every hairline and reduced the three controls those numbers
 * belong to into slivers. `resolveHandleLayout` inverts it: the fixed parts
 * give way, a fader never goes below a thumb's worth of throw, and on a tall
 * stage the handle grows to a comfortable size and then stops.
 *
 * Everything it reads comes from `usePaintDials` — where a size is stored, what
 * a switch currently is, and what a held ⇧ makes of either, that last one
 * answered by the same core function the STROKE asks. None of that is a
 * coincidence: every earlier version of a control like this in this codebase
 * drifted from the thing it was reporting on.
 *
 * It sits at the stage's right MIDDLE. The tool rail is anchored to the top
 * because it is a list you read; this is a thing you hold, and it belongs where
 * a hand already is.
 */

/** How the faders share the throw. Size gets the longer one: it is a log range
 *  over three orders of magnitude, and it is the one being dragged. */
const FLEX: Record<string, number> = { size: 3, smoothing: 2, opacity: 2 };

/**
 * THE HANDLE'S GAUGE — and the reversal that fixed how it felt.
 *
 * It was 36px wide with a 16px fader running most of the stage's height: a
 * tall, thin ribbon inside a box more than twice its width, so the thing you
 * grab was the smallest part of the thing you see. Height is the wrong axis to
 * spend on a fader anyway — the throw is already fine over 90px, while the
 * WIDTH is the whole hit target and 16px of it is a miss on glass.
 *
 * So: shorter, and as wide as the capsule allows. The fader fills the padding
 * box edge to edge and nothing inside is narrower than anything else, which is
 * most of why the old one read as parts that arrived separately.
 *
 * 56 rather than 48 because the switches now share a row: two buttons across a
 * 46px padding box is 21px each, which is a real target for a mode you set
 * occasionally, where 17px would have been a dare.
 */
const HANDLE_W = 56;
/** One row of chrome — the mode switches and the settings door. Matches
 *  `--control-h` so the handle keeps step with density like everything else. */
const HANDLE_BUTTON = "flex h-7 shrink-0 items-center justify-center rounded-lg transition-colors";
const HANDLE_ARMED = "material-glass-raised text-primary";
const HANDLE_IDLE = "text-muted-foreground hover:bg-accent hover:text-foreground";

export function StageBrushHandle() {
  const on = useHandleCarriesDials();
  const dials = usePaintDials();
  if (!on || !dials) return null;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* `h-full` so the capsule has something definite to be a percentage
            of — against an auto height the browser resolves `min(…, 100%)` to
            `auto`, the faders inside it get no room to flex into, and the whole
            control collapses to the height of its own labels.

            `pointer-events-none` because that full-height box IS a full-height
            hit target: the slot hands its direct child pointer events, so the
            capsule takes them back and no stripe of dead canvas runs down the
            right edge. `items-center` is what puts the handle at the middle. */}
        <HandleSlot>
          <Capsule dials={dials} />
        </HandleSlot>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => useSession.getState().setBrushHandle(false)}>
          Hide brush handle
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The handle's box: exactly the room its edge leaves it (`SideItems`), so it
 * centres in that room and never runs over a neighbour on the same edge.
 */
const HandleSlot = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function HandleSlot({ children, ...rest }, ref) {
  const room = useChromeColumnHeight();
  return (
    <div ref={ref} {...rest} className="pointer-events-none relative flex min-h-0 items-center" style={{ height: room > 0 ? room : "100%" }}>
      {children}
    </div>
  );
});

function Capsule({ dials }: { dials: PaintDials }) {
  /** Which fader is being DRAGGED — the preview card follows it. Only a drag,
   *  not a hover: the card is the answer to "what am I setting it to", and a
   *  card that opens when the pointer merely passes by is in the way. */
  const [dragging, setDragging] = React.useState<string | null>(null);
  const settings = usePaintSettings();
  // How much column there is, measured by the layout that owns it — not by the
  // handle, which can only ever measure its own height back (see StageChrome).
  const room = useChromeColumnHeight();
  const layout = resolveHandleLayout(room, PAINT_DIAL_ORDER.length, dials.modes.length > 0);
  const shown = PAINT_DIAL_ORDER.slice(0, layout.dials);

  return (
    <div
      // A finger on a fader is a drag from the press — no hold, no steer. It is
      // derivable here (nothing over the canvas scrolls) but it is stated,
      // because the day this lands inside a scrolling surface the derivation
      // would quietly start asking for a 180ms hold before the size moved.
      data-gesture="grab"
      className={cn(CHROME_CAPSULE, "pointer-events-auto flex-col gap-1.5")}
      style={{ width: HANDLE_W, height: layout.height, padding: HANDLE_PAD }}
    >
      {shown.map((id, i) => (
        <React.Fragment key={id}>
          {i > 0 && <Rule />}
          <Fader
            dial={dials.dials[id]}
            dials={dials}
            layout={layout}
            dragging={dragging === id}
            onDragging={(d) => setDragging(d ? id : (c) => (c === id ? null : c))}
          />
        </React.Fragment>
      ))}
      {layout.modes && (
        <>
          <Rule />
          <div className="flex w-full shrink-0 gap-1">
            {dials.modes.map((mode) => (
              <ModeSwitch key={mode.id} mode={mode} settings={settings} />
            ))}
          </div>
        </>
      )}
      <Rule />
      {/* THE DOOR IS THE LAST THING, not the first. The top of a thumb-rest
          belongs to the control you came for — Procreate puts its sidebar's
          modify button at the foot for the same reason. With it up there the
          first thing under your thumb was a way OUT of the handle, and the size
          fader, which is the entire point of pinning this to the canvas,
          started a row and a hairline down from the top. */}
      <HandleSettings settings={settings} />
    </div>
  );
}

/** A hairline the full width of the stack — the old one was a 16px stub
 *  centred under 36px of capsule, which is a rule that looks like a mistake. */
function Rule() {
  return <span aria-hidden className="h-px w-full shrink-0 bg-border/70" />;
}

/**
 * ONE DOOR, at the foot, wearing the app's tweak icon.
 *
 * Both caps used to be doors. The smoothing wave is also a TOGGLE, so a click
 * on it had to mean one of two things; and the size cap was a plain dot whose
 * only job was to open a sheet — a readout's clothes on a door, directly above
 * a fader and a number already showing the value it pictured. Two anonymous
 * ways into one room, one of them disguised as a value.
 *
 * So the door is here, once, in the icon this app already uses for "the knobs
 * of this thing" — the same `SlidersHorizontal` the tool options bar's Settings
 * button wears, opening the same sheet. The mode switches above it keep their
 * click, and it now means exactly one thing.
 */
function HandleSettings({ settings }: { settings: ReturnType<typeof usePaintSettings> }) {
  const side = useChromeFlyoutSide();
  return (
    <PaintSettings {...settings.props} side={side} align="start">
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Brush settings"
              // A door that is OPEN wears the app's one armed state — the
              // raised pane of the same glass with the accent on the icon, the
              // same object the mode switches and every stage toggle wear.
              // Without it the sheet could be open with nothing on the canvas
              // saying which button opened it.
              aria-expanded={settings.open}
              className={cn(HANDLE_BUTTON, "w-full", settings.open ? HANDLE_ARMED : HANDLE_IDLE)}
            >
              <SlidersHorizontal className="size-4" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side={side}>Brush settings</TooltipContent>
      </Tooltip>
    </PaintSettings>
  );
}

/**
 * ONE SWITCH, from the registry's list — smoothing, pen pressure, and whatever
 * a fourth one turns out to be.
 *
 * Click toggles, hold opens the sheet on the tab that explains it. Both halves
 * come from the `PaintMode` rather than from a branch here, which is what lets
 * the row grow without this component learning anything new.
 *
 * Held ⇧ REVERSES smoothing (core `effectiveSmoothing`), so while it is held
 * that switch reports what the stroke will actually do and refuses the click —
 * it would only be fighting the key.
 */
function ModeSwitch({
  mode,
  settings,
}: {
  mode: PaintMode;
  settings: ReturnType<typeof usePaintSettings>;
}) {
  const shift = useShiftHeld((s) => s.held);
  const hold = useHoldMenu(() => settings.openAt(mode.tab));
  const side = useChromeFlyoutSide();
  const overridden = shift && !!mode.shifted;
  const armed = overridden && mode.shifted ? mode.shifted(mode.on) : mode.on;
  const Icon = mode.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${mode.label} — click to toggle, hold for settings`}
          aria-pressed={armed}
          {...hold.bind}
          onClick={() => {
            if (hold.guard()) return; // a hold opened the sheet — skip the click's job
            if (overridden) return; // ⇧ owns it right now; a click would fight the key
            mode.set(!mode.on);
          }}
          className={cn(HANDLE_BUTTON, "min-w-0 flex-1", armed ? HANDLE_ARMED : HANDLE_IDLE)}
        >
          <Icon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side}>
        {mode.label} · {mode.detail}
        {overridden && " · ⇧"}
      </TooltipContent>
    </Tooltip>
  );
}

/** One dial: a fader, and the number under it while there is room for one. */
function Fader({
  dial,
  dials,
  layout,
  dragging,
  onDragging,
}: {
  dial: PaintDial;
  dials: PaintDials;
  layout: HandleLayout;
  dragging: boolean;
  onDragging: (dragging: boolean) => void;
}) {
  const shift = useShiftHeld((s) => s.held);
  // ⇧ REVERSES smoothing, and it is momentary — so while it is held the fader
  // shows what the stroke will actually do and refuses edits, rather than
  // showing a stored number the canvas is currently ignoring. WHICH dials a
  // key can reverse is the registry's to say (`PaintDial.shifted`), answered
  // from the same core function the stroke reads.
  //
  // A dial at zero is NOT disabled any more. Smoothing's fader was, back when
  // its on/off cap sat directly above it — so the fader read as dead, and the
  // only way to wake it was a button. A fader whose bottom end means "off" is
  // the switch; the one in the mode row is a shortcut, not a gate.
  const overridden = shift && !!dial.shifted;
  const shown = overridden && dial.shifted ? dial.shifted(dial.value) : dial.value;

  return (
    <div
      // `relative` because the readout belongs to THIS dial. Anchored to the
      // capsule it opened level with the tool options bar and sat on it.
      className="relative flex min-h-0 w-full flex-col items-center gap-1"
      style={{ flex: `${FLEX[dial.id] ?? 2} 1 0%` }}
      // Events bubble out of the Range's captured target, so this sees the whole
      // gesture. `pointercancel` as well as `pointerup`: touch fires the former,
      // and a card that only listened for the latter would never close.
      onPointerDown={() => onDragging(true)}
      onPointerUp={() => onDragging(false)}
      onPointerCancel={() => onDragging(false)}
    >
      {dragging && <PreviewCard dial={dial} value={shown} brush={dials.brush} />}
      <Range
        orientation="vertical"
        length="100%"
        // Edge to edge of the padding box. A fader you hold with a thumb has no
        // business being narrower than the capsule around it.
        thickness="100%"
        value={shown}
        min={dial.min}
        max={dial.max}
        step={dial.step}
        scale={dial.scale}
        ticks={dial.ticks ? [...dial.ticks] : undefined}
        defaultValue={dial.defaultValue}
        disabled={overridden}
        aria-label={dial.label}
        onChange={dial.set}
        className="min-h-0 flex-1 rounded-lg"
      />
      {layout.fields && (
        <NumberInput
          {...dialFieldProps(dial, overridden ? shown : undefined)}
          precision={0}
          disabled={overridden}
          title={`${dial.label} — drag or type`}
          // `text-center` rather than `justify-center`: the value is a `w-full`
          // span inside the field, so centring the FLEX line moved nothing.
          // Text alignment inherits, which is the one property that reaches it.
          className="h-6 w-full shrink-0 border-transparent bg-transparent px-0 text-center text-2xs"
        />
      )}
    </div>
  );
}

// ── The preview card ────────────────────────────────────────────────────────

function PreviewCard({ dial, value, brush }: { dial: PaintDial; value: number; brush: BrushPreset | null }) {
  const side = useChromeFlyoutSide();
  return (
    // Opening INTO the canvas — the only direction with room in it — and centred
    // on the dial it belongs to. `max-w-none` undoes the capsule recipe's
    // `max-w-full`: full of WHAT is the question, and the answer here is a 56px
    // column.
    <div
      className={cn(
        CHROME_CAPSULE,
        "pointer-events-none absolute top-1/2 z-10 w-[136px] max-w-none -translate-y-1/2",
        // Toward the canvas, whichever edge the handle is docked to — the same
        // fact the settings sheet and every tooltip here read.
        side === "left" ? "right-full mr-2" : "left-full ml-2",
        "flex-col items-center gap-1.5 p-2",
      )}
    >
      <div className="flex h-[76px] w-full items-center justify-center">
        {dial.id === "size" ? (
          <SizePreview size={value} brush={brush} />
        ) : dial.id === "opacity" ? (
          <OpacityPreview value={value} brush={brush} />
        ) : (
          <SmoothingPreview value={value} />
        )}
      </div>
      <div className="flex w-full items-baseline justify-between px-0.5">
        <span className="text-2xs text-muted-foreground">{dial.label}</span>
        <span className="font-mono text-xs tabular-nums text-foreground">{dial.format(value)}</span>
      </div>
    </div>
  );
}
