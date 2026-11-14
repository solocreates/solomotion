"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  clearVirtualMods,
  setVirtualMods,
  useMods,
  virtualMods,
  type Mods,
} from "./modifiers";
import { isApplePlatform } from "./pointer-env";
import { puckStore, usePuckState, usePuckVisible } from "./puck-store";
import { claimPointer } from "./pointer-gestures";
import { capturePointer } from "./capture-pointer";

/**
 * THE MODIFIER PUCK — ⇧ / ⌥ / ⌘ for a device that has no keys.
 *
 * Every precision gesture in this app is gated behind a modifier: ⇧ constrains
 * an axis and takes a slider into fine mode, ⌥ duplicates and switches the
 * cross-axis zoom, ⌘⌃ bypasses snapping and adds to a selection. On a tablet
 * none of them can be reached, so the app is not "harder" on touch — a third
 * of its behaviour is missing.
 *
 * It is a floating square you can park anywhere, and it works the way
 * AssistiveTouch does, because that is the one floating-button vocabulary iPad
 * users already have:
 *
 *   drag it            → it MOVES. Dragging a floating button to reposition it
 *                        is what everyone expects of one, and it has to be the
 *                        gesture you get without being told. (It was the other
 *                        way round at first — drag opened the radial and a long
 *                        press moved it — and the move was undiscoverable,
 *                        because nobody holds still on a button they intend to
 *                        drag.)
 *   press and hold     → the radial fans out: ⇧ left, ⌥ down, ⌘ right. Then
 *                        drag onto one; it engages the moment you cross into
 *                        its sector — live, so a drag your other hand already
 *                        started responds instantly rather than on release.
 *   lift on a sector   → it LATCHES. You cannot hold a key and drag with one
 *                        hand, so the useful default on touch is sticky.
 *   tap it             → clears everything. One gesture, always available,
 *                        which is what keeps a latch from ever being stuck.
 *
 * Sectors are additive: latch ⇧, then latch ⌥, and both are held. That falls
 * out of the model rather than being a feature — the store holds three
 * independent booleans, exactly like a keyboard.
 *
 * Nothing downstream knows this exists. It writes to `input/modifiers`, which
 * every gesture in the app already reads, so the entire modifier surface came
 * online at once instead of forty gestures each growing a touch branch.
 */

type Sector = keyof Mods | null;

/** Dead zone around the puck's centre — inside it, no sector is chosen. */
const DEAD_ZONE = 26;
/** Travel that means "you are dragging", not "you are tapping". */
const MOVE_SLOP = 8;
/** Held still this long and the radial opens. Short enough not to feel like a
 *  wait, long enough that the start of a deliberate drag never trips it. */
const HOLD_TO_ARM_MS = 300;
const PUCK_SIZE = 52;

/** Which sector a vector from the puck's centre lands in. */
function sectorFor(dx: number, dy: number): Sector {
  if (Math.hypot(dx, dy) < DEAD_ZONE) return null;
  // Dominant axis, so a sloppy diagonal still resolves to the nearer sector
  // rather than to nothing. Up is left unassigned on purpose: it is where the
  // labels would collide with the puck on a bottom-parked position, and three
  // modifiers is all a keyboard gives us.
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "shift" : "meta";
  return dy > 0 ? "alt" : null;
}

const GLYPH: Record<keyof Mods, string> = { shift: "⇧", alt: "⌥", meta: "⌘" };

function labelFor(which: keyof Mods): string {
  const mac = isApplePlatform();
  if (which === "shift") return "⇧";
  if (which === "alt") return mac ? "⌥" : "Alt";
  return mac ? "⌘" : "Ctrl";
}

export function ModifierPuck() {
  const visible = usePuckVisible();
  if (!visible) return null;
  return <Puck />;
}

function Puck() {
  const { fx, fy } = usePuckState();
  const mods = useMods();
  const [sector, setSector] = React.useState<Sector>(null);
  const [radial, setRadial] = React.useState(false);
  const [moving, setMoving] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  // Everything the live pointer handlers need, in a ref — a pinch-rate
  // setState per move would re-render the puck (and its three sector chips)
  // on every frame of a gesture whose whole job is to stay out of the way.
  const drag = React.useRef({
    id: -1,
    startX: 0,
    startY: 0,
    cx: 0,
    cy: 0,
    moved: false,
    holdTimer: 0 as number | ReturnType<typeof setTimeout>,
    mode: "idle" as "idle" | "radial" | "move",
    // The latch we entered this gesture with, so a sector ADDS to it rather
    // than replacing it — latching ⇧ then ⌥ has to leave both on.
    base: { shift: false, alt: false, meta: false } as Mods,
  });

  const left = `calc(${(fx * 100).toFixed(3)}% - ${PUCK_SIZE / 2}px)`;
  const top = `calc(${(fy * 100).toFixed(3)}% - ${PUCK_SIZE / 2}px)`;

  const endGesture = React.useCallback(() => {
    clearTimeout(drag.current.holdTimer);
    drag.current.id = -1;
    drag.current.mode = "idle";
    setRadial(false);
    setMoving(false);
    setSector(null);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (drag.current.id !== -1) return;
    e.preventDefault();
    e.stopPropagation();
    // Capture can be refused when the pointer was released between the browser
    // dispatching this event and React delivering it. That is a lost gesture,
    // not a crash — an uncaught NotFoundError here would take the whole puck
    // down and leave a latched modifier with nothing able to clear it.
    capturePointer(e.currentTarget, e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const d = drag.current;
    d.id = e.pointerId;
    d.startX = e.clientX;
    d.startY = e.clientY;
    d.cx = rect.left + rect.width / 2;
    d.cy = rect.top + rect.height / 2;
    d.moved = false;
    d.mode = "idle";
    d.base = { ...virtualMods() };
    // The puck's whole gesture is a HOLD, so it must claim the pointer or the
    // app-wide long-press would open a context menu on top of the radial. This
    // is the case movement-detection cannot catch, and the reason `claimPointer`
    // is exposed at all.
    claimPointer(e.pointerId, "hold");
    d.holdTimer = setTimeout(() => {
      // Held still → they want the modifiers, not to move the puck.
      if (drag.current.moved) return;
      drag.current.mode = "radial";
      setRadial(true);
      // A short buzz where the platform has one: the radial opening is the
      // only feedback that the hold registered, and on a device held in one
      // hand the puck is often under the thumb that cannot see it.
      navigator.vibrate?.(8);
    }, HOLD_TO_ARM_MS);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d.id !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;

    // Travel before the hold armed the radial = a reposition. Once the radial
    // is open the same travel picks a sector instead, which is why this reads
    // the mode rather than just the distance.
    if (d.mode === "idle" && Math.hypot(dx, dy) > MOVE_SLOP) {
      d.moved = true;
      clearTimeout(d.holdTimer);
      d.mode = "move";
      setMoving(true);
    }

    if (d.mode === "move") {
      puckStore.setPosition(
        Math.min(0.97, Math.max(0.03, e.clientX / window.innerWidth)),
        Math.min(0.97, Math.max(0.03, e.clientY / window.innerHeight)),
      );
      return;
    }

    if (d.mode !== "radial") return;

    const next = sectorFor(e.clientX - d.cx, e.clientY - d.cy);
    setSector((prev) => (prev === next ? prev : next));
    // ENGAGE LIVE. The whole reason `watchMods` exists is so the other hand's
    // in-flight drag re-applies the instant this crosses a sector boundary —
    // waiting for release would make the modifier useless for the gesture it
    // is meant to modify.
    setVirtualMods(next ? { ...d.base, [next]: true } : d.base);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d.id !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
    if (d.mode === "radial") {
      // Lifting inside a sector LATCHES it; lifting in the dead zone (or
      // outside any sector) restores what was latched before, which makes
      // "changed my mind" a real, discoverable escape rather than a commit.
      const final = sectorFor(e.clientX - d.cx, e.clientY - d.cy);
      setVirtualMods(final ? { ...d.base, [final]: true } : d.base);
    } else if (d.mode === "idle") {
      // A tap. The one gesture that always clears, so a latch can never be
      // stuck with no way out.
      clearVirtualMods();
    }
    endGesture();
  };

  React.useEffect(() => () => clearTimeout(drag.current.holdTimer), []);

  const latched = virtualMods();
  const anyLatched = latched.shift || latched.alt || latched.meta;

  return (
    <div
      ref={ref}
      // FIXED and above everything, including the floating windows — it is the
      // modifier for whatever is on top, so it cannot be under it. The app
      // shell is one stacking context (`isolate` in Editor.tsx), so this has to
      // live outside it to clear the windows portalled to the body.
      className="pointer-events-none fixed inset-0 z-[200]"
      aria-hidden={false}
    >
      <div className="absolute" style={{ left, top }}>
        {/* The radial. Rendered only while choosing, so it costs nothing at
            rest and cannot eat a tap meant for the canvas. */}
        {radial && (
          <>
            <Chip which="shift" at="left" armed={sector === "shift"} />
            <Chip which="meta" at="right" armed={sector === "meta"} />
            <Chip which="alt" at="down" armed={sector === "alt"} />
          </>
        )}

        <div
          role="button"
          tabIndex={0}
          aria-label="Modifier keys"
          aria-pressed={anyLatched}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={cn(
            "pointer-events-auto flex select-none items-center justify-center rounded-2xl",
            // `touch-none` is not optional here: without it the browser claims
            // the drag as a page pan and the radial never opens.
            "touch-none",
            "material-glass transition-[transform,box-shadow] duration-150",
            moving && "scale-110 shadow-2xl",
            anyLatched && "material-glass-raised",
          )}
          style={{ width: PUCK_SIZE, height: PUCK_SIZE, opacity: radial || moving ? 1 : 0.85 }}
        >
          {/* At rest the face shows what is LATCHED — the armed state has to be
              readable at a glance, because a modifier you forgot is on is the
              only way this control can hurt you. With nothing latched it shows
              the three glyphs greyed, which is also what tells you what it is
              the first time you see it: no label, no tooltip, no paragraph. */}
          <div className="flex items-center gap-0.5 text-xs leading-none">
            {(["shift", "alt", "meta"] as const).map((k) => (
              <span
                key={k}
                className={cn(
                  "transition-colors",
                  mods[k] ? "text-primary" : anyLatched ? "text-muted-foreground/40" : "text-muted-foreground",
                )}
              >
                {GLYPH[k]}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One sector of the radial — a glyph chip offset from the puck's centre. */
function Chip({
  which,
  at,
  armed,
}: {
  which: keyof Mods;
  at: "left" | "right" | "down";
  armed: boolean;
}) {
  const OFFSET = 52;
  const pos =
    at === "left"
      ? { left: -OFFSET, top: PUCK_SIZE / 2 - 16 }
      : at === "right"
        ? { left: PUCK_SIZE + OFFSET - 32, top: PUCK_SIZE / 2 - 16 }
        : { left: PUCK_SIZE / 2 - 16, top: PUCK_SIZE + OFFSET - 32 };
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute flex size-8 items-center justify-center rounded-lg text-xs font-medium",
        "transition-[transform,background-color] duration-100",
        armed ? "material-glass-raised scale-110 text-primary" : "material-chip text-muted-foreground",
      )}
      style={pos}
    >
      {labelFor(which)}
    </div>
  );
}
