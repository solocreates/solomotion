"use client";

import * as React from "react";
import { Check, Circle, Copy, Link2Off, Pipette, SlidersHorizontal, Square } from "lucide-react";
import { Popover, PopoverBody, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NumberInput } from "@/components/ui/number-input";
import { useSliderControl } from "@/components/ui/slider-base";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  hexToHsva,
  hsvaToHex,
  hsvaToRgba,
  parseColor,
  rgbaToHsva,
  toCss,
  type Hsva,
} from "@/lib/color";
import { beginEyedrop, hasEyedropSurface, useHasEyedropSurface } from "@/lib/eyedropper";
import { cn } from "@/lib/utils";
import { claimPointer, subscribePointerEnd } from "@/editor/input/pointer-gestures";
import { DRAG_SURFACE } from "@/editor/input/use-multi-touch";
import { DynamicGlyph, SOURCE_META, useDynamicControl } from "@/editor/binding/dynamic-field";

/**
 * The one color control for the whole app.
 *
 * THE ROW IS A BADGE, NOT A FORM.
 *
 * It used to be a swatch, a live hex `<input>` and a hand-rolled alpha scrub in
 * one box — three hit targets in 90px, two of which were permanently-mounted
 * text fields. On a tablet that is a trap: a pen aimed at the swatch lands in
 * the hex field, raises the on-screen keyboard, and types into a value nobody
 * came to type. Nobody enters hex in an inspector row anyway; they open the
 * picker, where entering an exact value is the point and the fields are behind
 * a deliberate press.
 *
 * So the row shows what the value IS — the swatch, and its name — and opening
 * the picker is the only thing pressing it does. Alpha keeps a control, because
 * it is the one number people genuinely drag from a row, but it is now the
 * app's own `NumberInput`: a span that becomes an input only after a clean,
 * un-abandoned click, routed through the gesture scope. A pen cannot fall into
 * one. That is the whole fix, and it is the reason there is no hand-rolled
 * field left in this file — the picker never used the app's, so it never got
 * any of the touch work the rest of the app has had for a year.
 *
 * The picker panel is headless-reusable — it only speaks `value / onChange /
 * onCommit` (onChange streams while dragging; callers pass an undo mergeKey) —
 * and offers three graphic modes (box, wheel, channel sliders), HEX/RGB/HSL/HSB
 * entry, alpha, copy, recents, and the app's canvas-accurate eyedropper (native
 * EyeDropper as fallback).
 *
 * Variables (Figma styles): pass `variables` + `linkedId` and the badge NAMES
 * the one it is linked to, tinted and glyphed exactly like every other bound
 * field in the app (`SOURCE_META.variable` — one vocabulary, so a linked colour
 * reads the same as a linked font size). Browsing and binding is the library
 * slot's job.
 */

export interface ColorVariableOption {
  id: string;
  name: string;
  value: string;
}

const CHECKER =
  "repeating-conic-gradient(#3a3a42 0% 25%, #26262c 0% 50%) 0 0 / 8px 8px";

const HUE_GRADIENT = "linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)";
const WHEEL_CONIC =
  "conic-gradient(from 90deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)";

const RECENTS_KEY = "tm-recent-colors";
const MODE_KEY = "tm-picker-mode";
const FORMAT_KEY = "tm-picker-format";

type PickerMode = "box" | "wheel" | "sliders";
type PickerFormat = "hex" | "rgb" | "hsl" | "hsb";

function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key) as T | null;
    return raw && allowed.includes(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // preferences are a nicety, not a requirement.
  }
}

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(arr) ? arr.filter((c) => typeof c === "string").slice(0, 16) : [];
  } catch {
    return [];
  }
}

function pushRecent(color: string) {
  try {
    const list = [color, ...loadRecents().filter((c) => c !== color)].slice(0, 16);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    // localStorage unavailable — recents are a nicety, not a requirement.
  }
}

// ── HSL bridge (lib/color speaks HSVA; the HSL format/wheel need these) ──────

function hsvaToHsl({ h, s, v }: Hsva): { h: number; s: number; l: number } {
  const l = v * (1 - s / 2);
  const sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return { h, s: sl, l };
}

function hslToHsva(h: number, s: number, l: number, a: number): Hsva {
  const v = l + s * Math.min(l, 1 - l);
  const sv = v === 0 ? 0 : 2 * (1 - l / v);
  return { h, s: sv, v, a };
}

/** Channel args → lib's rgbaToHsva (keeps the slider call sites terse). */
const rgbaToHsvaOf = (r: number, g: number, b: number, a: number): Hsva =>
  rgbaToHsva({ r, g, b, a });

/** The colour at full opacity, which is what a NAME refers to. */
const opaque = (c: string) => hsvaToHex({ ...((hexToHsva(c) ?? { h: 0, s: 0, v: 1, a: 1 }) as Hsva), a: 1 });

// ── The swatch ───────────────────────────────────────────────────────────────

/**
 * A colour, over a checker so translucency reads. The ONE swatch in this file:
 * the row wears it, the picker's preview wears a wide one, and neither gets to
 * invent its own corner radius or rim.
 */
function Swatch({
  color,
  mixed,
  className,
  children,
}: {
  color: string;
  mixed?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        // BLOCK, not the span's default inline: as a flex child in the row it
        // is blockified for free, but in the panel's block column an inline box
        // ignores width and height outright and the preview silently vanished.
        "relative block shrink-0 overflow-hidden shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]",
        className,
      )}
      style={{ background: CHECKER }}
    >
      {mixed ? (
        <span className="absolute inset-0 bg-[linear-gradient(135deg,#e5484d_0%,#f5b843_50%,#4cc3e0_100%)]" />
      ) : (
        <span className="absolute inset-0" style={{ backgroundColor: toCss(color) }} />
      )}
      {children}
    </span>
  );
}

// ── Row control ──────────────────────────────────────────────────────────────

export interface ColorInputProps {
  /** A literal color — callers resolve variable tokens before passing. */
  value: string | undefined;
  onChange: (color: string) => void;
  /** Fired when a gesture/entry finishes — good moment to store a recent. */
  onCommit?: (color: string) => void;
  mixed?: boolean;
  className?: string;
  /** Variables this slot may link to — the row uses them only to NAME the one
   *  it is linked to. Browsing and binding is the library slot's job. */
  variables?: ColorVariableOption[];
  /** Variable this slot is linked to, if any. */
  linkedId?: string | null;
  /** Detach (null) — the row's own unlink button. */
  onLinkVariable?: (id: string | null) => void;
  /** The fill library, rendered down the left of the picker. Omit for a plain
   *  picker with no document behind it. */
  library?: React.ReactNode;
  /**
   * `"field"` (default) — swatch, name and opacity in a bordered row. The
   * inspector's shape: it sits in a column of labelled rows and has the width
   * to say what it is.
   *
   * `"badge"` — the swatch alone, as a chip. For a TOOL BAR, where the row is
   * horizontal, space is the scarce resource, and the colour beside the word
   * "Fill" is already unambiguous. The hex was never read there — nobody
   * identifies a colour from `FF4E6A` at 11px over artwork — and it cost the
   * bar sixty pixels per slot, which is why the pen's three colours pushed its
   * actual verbs off the end of the strip.
   *
   * Same picker, same variable binding, same alpha (in the panel's own track).
   * The only thing dropped is the readout.
   */
  variant?: "field" | "badge";
}

/**
 * The picker's width, shared by every popover that hosts it (the row control,
 * the paint editor, gradient stops) so the panel reads as ONE component wherever
 * it opens. Wide enough for BOTH columns: a 148px library and a picker that
 * still has room for a pattern studio's two-up rows.
 */
export const PICKER_WIDTH = "w-[478px]";

/**
 * The picker's ceiling.
 *
 * Radix caps a popover at the space available, which on a tall window is most
 * of the screen — so a long palette or a deep pattern studio grew the panel
 * instead of scrolling inside it, and the two columns never got the chance to
 * scroll at all. Capping it makes the panel a fixed frame with two independent
 * scrollers, which is the same rule `PanelColumns` applies to a window with
 * sidebars.
 *
 * `min()` against the VIEWPORT, not against Radix's available-height custom
 * property. A `min()` containing an unresolved `var()` is an invalid value and
 * the whole declaration is dropped — so on the first render, before Radix has
 * measured and set that variable, the cap silently did not exist at all. A
 * ceiling that depends on someone else having already run is not a ceiling.
 */
export const PICKER_MAX_HEIGHT = "min(600px, calc(100vh - 24px))";

/** Without the library column there is nothing to be wide FOR — a bare picker
 *  in a 430px panel is a small graphic with 150px of empty popover beside it. */
export const PICKER_WIDTH_BARE = "w-[294px]";

/**
 * Where the picker opens. Colour swatches live in the RIGHT inspector, so
 * opening downward-and-rightward pushes the panel straight off the screen edge.
 * Opening to the side puts it beside the rail with its top on the swatch —
 * Figma's placement — and Radix still flips it on a trigger with no room there.
 */
export const PICKER_PLACEMENT = { side: "left", align: "start", sideOffset: 8 } as const;

/**
 * Where the picker opens from a BADGE. A tool bar badge lives across the TOP of
 * the stage, so the inspector's leftward placement would open the panel away
 * from the canvas and off the screen's left edge on a narrow window. Down and
 * start-aligned is the direction that has room — the same rule every stage
 * capsule follows (`flyoutSide`: open into the canvas).
 */
export const BADGE_PICKER_PLACEMENT = { side: "bottom", align: "start", sideOffset: 8 } as const;

export function ColorInput({
  value,
  onChange,
  onCommit,
  mixed,
  className,
  variables,
  linkedId,
  onLinkVariable,
  library,
  variant = "field",
}: ColorInputProps) {
  const dynamic = useDynamicControl();
  const color = value ?? "#ffffff";
  const linked = linkedId ? variables?.find((v) => v.id === linkedId) : undefined;
  const rgba = parseColor(color);
  const alphaPct = rgba ? Math.round(rgba.a * 100) : 100;

  const commit = (c: string) => {
    pushRecent(c);
    onCommit?.(c);
  };

  /**
   * Alpha is emitted as an ordinary colour change, and that is deliberate: this
   * control lives in `components/ui` and stays document-agnostic. The binding
   * layer sees a value whose channels are unchanged and only its alpha moved,
   * and rides the variable reference rather than detaching from it — see
   * `useColorVariableBinding`. One rule, and it covers the panel's alpha track
   * and its A field for free.
   */
  const setAlpha = (pct: number) => {
    const base = (hexToHsva(color) ?? { h: 0, s: 0, v: 1, a: 1 }) as Hsva;
    return hsvaToHex({ ...base, a: Math.max(0, Math.min(100, pct)) / 100 });
  };

  // A computed colour opens the thing that computes it, exactly as a computed
  // number does. The swatch still shows the colour, because that IS the value.
  if (dynamic) {
    return (
      <div
        className={cn(
          "flex h-(--control-h) min-w-0 items-center gap-1.5 rounded-lg border bg-input/45 px-1.5 transition-colors",
          dynamic.className,
          className,
        )}
        style={dynamic.style}
        {...dynamic.props}
      >
        <Swatch color={dynamic.field.preview ?? color} className="size-4.5 rounded-md" />
        <DynamicGlyph field={dynamic.field} />
        <span className="w-full min-w-0 truncate font-mono text-xs uppercase tabular-nums">
          {(dynamic.field.preview ?? color).replace(/^#/, "")}
        </span>
      </div>
    );
  }

  // The picker panel itself, written once. Both shapes below open the SAME
  // popover — a badge in a tool bar and a field in the inspector are two
  // triggers for one control, not two colour controls.
  const panel = (
    <PopoverContent
      className={cn("p-0", library ? PICKER_WIDTH : PICKER_WIDTH_BARE)}
      style={{ maxHeight: PICKER_MAX_HEIGHT }}
      {...(variant === "badge" ? BADGE_PICKER_PLACEMENT : PICKER_PLACEMENT)}
      // A variable's right-click menu portals outside the popover; clicking
      // one of its items must not dismiss the picker underneath it.
      onInteractOutside={(e) => {
        const t = e.target as Element | null;
        if (t?.closest("[role='menu']")) e.preventDefault();
      }}
    >
      {/* The LIBRARY is a slot, not a prop bundle. This control lives in
          components/ui and must stay document-agnostic; the app passes the
          same browser the paint editor uses, so a colour row and a fill
          editor offer one library rather than two that drift. */}
      <div className="flex min-h-0 flex-1">
        {library}
        <PopoverBody className="min-w-0 flex-1">
          <PickerPanel value={color} onChange={onChange} onCommit={commit} />
        </PopoverBody>
      </div>
    </PopoverContent>
  );

  if (variant === "badge") {
    const name = linked ? linked.name : mixed ? "Mixed" : `#${opaque(color).replace(/^#/, "").toUpperCase()}`;
    return (
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={linked ? `Colour — linked to ${linked.name}` : `Colour — ${name}`}
                className={cn(
                  // A CHIP, not a miniature of the field: the swatch fills the
                  // control's whole height, so a row of them reads as colours
                  // rather than as three small boxes inside three larger ones.
                  // The rim is the same hairline every other control wears; a
                  // linked slot tints it, which is the one fact a badge still
                  // has to carry.
                  "relative flex h-(--control-h) w-7 shrink-0 items-center justify-center rounded-lg border p-[3px] transition-colors",
                  linked ? "border-(--tint)" : "border-transparent hover:border-border",
                  "outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                  className,
                )}
                style={linked ? ({ "--tint": SOURCE_META.variable.tint } as React.CSSProperties) : undefined}
              >
                <Swatch color={color} mixed={mixed} className="size-full rounded-[5px]" />
                {linked && (
                  <SOURCE_META.variable.Icon
                    className="absolute -bottom-px -right-px size-2.5 rounded-full bg-popover"
                    style={{ color: SOURCE_META.variable.tint }}
                  />
                )}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{name}</TooltipContent>
        </Tooltip>
        {panel}
      </Popover>
    );
  }

  return (
    /*
     * ONE field, two targets. The badge opens the picker and the alpha scrubs;
     * they cannot be the same rectangle, because a trigger fires on a press and
     * a scrub consumes one. The shared border is what makes them read as a
     * single control anyway.
     */
    <div
      className={cn(
        "group/color @container/color flex h-(--control-h) min-w-0 items-center rounded-lg border bg-input/45 transition-colors",
        linked
          ? "border-(--tint) hover:border-(--tint)"
          : "border-transparent hover:border-border focus-within:border-primary/60",
        className,
      )}
      style={linked ? ({ "--tint": SOURCE_META.variable.tint } as React.CSSProperties) : undefined}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={linked ? `Color — linked to ${linked.name}` : "Pick color"}
            title={linked ? `Linked to “${linked.name}”` : undefined}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <Swatch color={color} mixed={mixed} className="size-4.5 rounded-md" />
            {linked && (
              <SOURCE_META.variable.Icon
                className="size-2.5 shrink-0"
                style={{ color: SOURCE_META.variable.tint }}
              />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left text-xs",
                linked ? "text-foreground" : "font-mono uppercase tabular-nums text-muted-foreground",
              )}
            >
              {linked ? linked.name : mixed ? "Mixed" : opaque(color).replace(/^#/, "").toUpperCase()}
            </span>
          </button>
        </PopoverTrigger>
        {panel}
      </Popover>

      {linked && (
        <button
          type="button"
          aria-label="Detach from variable"
          title="Detach from variable"
          className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/color:opacity-100 [@media(pointer:coarse)]:opacity-100"
          onClick={() => onLinkVariable?.(null)}
        >
          <Link2Off className="size-3" />
        </button>
      )}

      {/*
       * WHEN THERE IS NOT ROOM FOR BOTH, THE BADGE WINS.
       *
       * Some slots are genuinely narrow — a colour sharing its row with a
       * toggle, a tool strip. The identity of this control is the swatch and
       * the name; opacity is the secondary number, and it is never the only way
       * to reach it (the picker has a full alpha track and an A field). Left to
       * flexbox the opposite happened: a fixed-width alpha refused to give, so
       * the swatch was crushed to 12px and the row read as broken.
       *
       * A CONTAINER query, not a breakpoint and not an `isMobile`: what matters
       * is how wide THIS control is, which is a fact about its slot and not
       * about the window.
       */}
      <span className="hidden h-3.5 w-px shrink-0 bg-border/70 @min-[7rem]/color:block" />
      <NumberInput
        value={alphaPct}
        min={0}
        max={100}
        precision={0}
        unit="%"
        title="Opacity"
        // Borderless INSIDE the group: the field is already in a box, and a
        // second one around it is the boxes-in-boxes signal the design system
        // exists to prevent.
        className="hidden h-full w-12 shrink-0 rounded-l-none border-transparent bg-transparent hover:border-transparent focus-within:bg-transparent @min-[7rem]/color:flex"
        onChange={(v) => onChange(setAlpha(v))}
        onCommit={(v) => commit(setAlpha(v))}
      />
    </div>
  );
}

/**
 * Window-tracked pointer drag, for the 2-D PADS only — the saturation box and
 * the wheel. Every one-dimensional track in this file rides `useSliderControl`
 * (the app's one slider brain) instead; a pad cannot, because it reads two axes
 * against its own rectangle and there is no scroll to arbitrate with.
 *
 * `setPointerCapture` inside a Radix popover is a trap: releasing the mouse
 * OUTSIDE the panel strands the gesture (the captured element never sees the
 * pointerup, so the drag sticks and re-grabs on the next hover), and the capture
 * nudges the dismissable layer into closing the popover mid-drag. Tracking on
 * the window instead makes every drag finish wherever the pointer ends up and
 * keeps the panel open until you actually click away. `onMove` fires once
 * immediately (the press itself), then per move, then once with `done`.
 */
function trackPointer(
  e: React.PointerEvent,
  onMove: (p: { clientX: number; clientY: number }, done: boolean) => void,
) {
  // PRIMARY BUTTON ONLY. A right-click is a request for a menu, not a request
  // to set the colour under the cursor — and `pointerdown` fires for every
  // button, so a drag surface that does not ask ends up committing a value the
  // user was trying to open a menu on. `e.button === 0` covers pen and touch,
  // which both report 0.
  if (e.button !== 0) return;
  e.preventDefault();
  // Stationary-first: you PUT a finger on the saturation box and then push, so
  // movement cannot be what claims this pointer. Claiming on the press refuses
  // the browser's scroll for the rest of the gesture and stands the long-press
  // menu down, which is why holding a swatch no longer opens a context menu on
  // top of the colour you are choosing.
  claimPointer(e.pointerId, "drag");
  const id = e.pointerId;
  onMove(e, false);
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    onMove(ev, false);
  };
  const finish = (p: { clientX: number; clientY: number } | null) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    unsubscribe();
    // A pointer that never came back never released, so there is nothing to
    // commit — the last streamed value stands and the gesture just stops.
    if (p) onMove(p, true);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    finish(ev);
  };
  // `pointercancel`, `blur`, a portalled layer eating the release, the second
  // finger of a pinch: every way a touch gesture ends WITHOUT a `pointerup`.
  // Listening for `pointerup` alone leaked a window `pointermove` for the rest
  // of the session, which is exactly the "the colour point keeps re-grabbing
  // and drifting" this picker showed on a tablet.
  const unsubscribe = subscribePointerEnd((endedId) => {
    if (endedId === id) finish(null);
  });
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ── Full picker panel ────────────────────────────────────────────────────────

interface EyeDropperApi {
  open: () => Promise<{ sRGBHex: string }>;
}

const MODES: Array<{ id: PickerMode; label: string; Icon: React.ElementType }> = [
  { id: "box", label: "Box", Icon: Square },
  { id: "wheel", label: "Wheel", Icon: Circle },
  { id: "sliders", label: "Sliders", Icon: SlidersHorizontal },
];

const FORMATS: PickerFormat[] = ["hex", "rgb", "hsl", "hsb"];

/**
 * The panel's ONE switcher — the graphic mode and the notation both pick one of
 * a short closed set, so they are one control, not two that drift. They were
 * two hand-rolled grids and had already disagreed about height, type size and
 * what "selected" looks like.
 *
 * Sized on `--hit-target`, which is the app's answer to touch: 28px under a
 * mouse, 36px under a coarse pointer, from one variable at the root. Growing
 * chrome for a finger is not this component's decision to make.
 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ id: T; label: string; Icon?: React.ElementType }>;
  onChange: (id: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="grid h-(--hit-target) gap-1 rounded-xl bg-secondary/50 p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))` }}
    >
      {options.map(({ id, label, Icon }) => {
        const on = value === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(id)}
            className={cn(
              "flex min-w-0 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium transition-colors [&_svg]:size-3 [&_svg]:shrink-0",
              // The app's ONE armed state: a brighter pane of the same surface,
              // never a saturated accent slab.
              on ? "material-chip text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon />}
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function PickerPanel({
  value,
  onChange,
  onCommit,
}: {
  value: string;
  onChange: (c: string) => void;
  onCommit: (c: string) => void;
}) {
  const eyedropSurface = useHasEyedropSurface();
  // Internal HSVA keeps hue/saturation stable while value/alpha hit extremes.
  const [hsva, setHsva] = React.useState<Hsva>(() => hexToHsva(value) ?? { h: 40, s: 0.7, v: 0.95, a: 1 });
  const externalHex = React.useRef(value);
  React.useEffect(() => {
    if (value !== externalHex.current) {
      const parsed = hexToHsva(value);
      if (parsed) setHsva(parsed);
      externalHex.current = value;
    }
  }, [value]);

  const [mode, setMode] = React.useState<PickerMode>(() => loadPref(MODE_KEY, ["box", "wheel", "sliders"], "box"));
  const [format, setFormat] = React.useState<PickerFormat>(() => loadPref(FORMAT_KEY, FORMATS, "hex"));
  const [copied, setCopied] = React.useState(false);

  const apply = (next: Hsva, commit = false) => {
    setHsva(next);
    const hex = hsvaToHex(next);
    externalHex.current = hex;
    onChange(hex);
    if (commit) onCommit(hex);
  };

  const rgba = hsvaToRgba(hsva);
  const hsl = hsvaToHsl(hsva);
  const hex = hsvaToHex({ ...hsva, a: 1 }).toUpperCase();
  const alphaPct = Math.round(hsva.a * 100);
  const solid = `rgb(${Math.round(rgba.r)},${Math.round(rgba.g)},${Math.round(rgba.b)})`;
  const hueColor = hsvaToHex({ h: hsva.h, s: 1, v: 1, a: 1 });
  const isLight = 0.299 * rgba.r + 0.587 * rgba.g + 0.114 * rgba.b > 150;

  const formatted =
    format === "hex"
      ? alphaPct < 100
        ? hsvaToHex(hsva).toUpperCase()
        : hex
      : format === "rgb"
        ? alphaPct < 100
          ? `rgba(${Math.round(rgba.r)}, ${Math.round(rgba.g)}, ${Math.round(rgba.b)}, ${(alphaPct / 100).toFixed(2)})`
          : solid.replace(/,/g, ", ")
        : format === "hsl"
          ? `hsl(${Math.round(hsl.h)}, ${Math.round(hsl.s * 100)}%, ${Math.round(hsl.l * 100)}%)`
          : `hsb(${Math.round(hsva.h)}, ${Math.round(hsva.s * 100)}%, ${Math.round(hsva.v * 100)}%)`;

  const eyeDropper =
    typeof window !== "undefined"
      ? (window as unknown as { EyeDropper?: new () => EyeDropperApi }).EyeDropper
      : undefined;

  const pickFromScreen = () => {
    // Stage loupe when mounted (pixel-exact against the live canvas, playback
    // and all); native EyeDropper everywhere else.
    const pick = hasEyedropSurface()
      ? beginEyedrop()
      : eyeDropper
        ? new eyeDropper().open().then(
            (r) => r.sRGBHex,
            () => null,
          )
        : Promise.resolve<string | null>(null);
    void pick.then((picked) => {
      const parsed = picked ? hexToHsva(picked) : null;
      if (parsed) apply({ ...parsed, a: hsva.a }, true);
    });
  };

  const copy = () => {
    void navigator.clipboard
      ?.writeText(formatted)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };

  return (
    // JUST the picker. The library that used to sit in a rail here is now the
    // paint editor's own left column, shared by every tab — a colour, a
    // gradient and a pattern are all fills, and giving colours a private
    // library was what made a perfected gradient unshareable. One browser, one
    // place; this component went back to being one thing.
    <div className="min-w-0 space-y-3 p-3">
      {/* Preview: the colour, big, with the two things you do TO it. The hex
          reads here and is entered below — a readout you can also type into is
          the permanently-focusable trap this panel just got rid of. */}
      <Swatch color={hsvaToHex(hsva)} className="h-12 w-full rounded-xl">
        <span
          className="absolute bottom-2 left-3 font-mono text-[11px] font-medium tabular-nums"
          style={{ color: isLight ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.92)" }}
        >
          {hex}
          {alphaPct < 100 ? ` · ${alphaPct}%` : ""}
        </span>
        <div className="absolute right-2 top-2 flex items-center gap-1.5">
          {(eyeDropper || eyedropSurface) && (
            <GlassIconButton label="Pick color from canvas" onClick={pickFromScreen} light={isLight}>
              <Pipette />
            </GlassIconButton>
          )}
          <GlassIconButton label="Copy color value" onClick={copy} light={isLight}>
            {copied ? <Check /> : <Copy />}
          </GlassIconButton>
        </div>
      </Swatch>

      <Segmented value={mode} options={MODES} onChange={(id) => { setMode(id); savePref(MODE_KEY, id); }} ariaLabel="Picker mode" />

      {/* Graphic area — a FIXED-height stage for all three modes. Switching mode
          (or notation, which re-shapes the slider set) must not resize the
          panel: a popover that changes height under you re-anchors, which is
          how this thing used to jump from below the swatch to above it. */}
      <div className="flex h-46 flex-col justify-center">
        {mode === "box" && (
          <div className="flex gap-2.5">
            <DragSurface
              className="relative h-46 min-w-0 flex-1 cursor-crosshair overflow-hidden rounded-xl"
              onDrag={(fx, fy, done) => apply({ ...hsva, s: fx, v: 1 - fy }, done)}
            >
              <div className="absolute inset-0" style={{ backgroundColor: hueColor }} />
              <div className="absolute inset-0 bg-linear-to-r from-white to-transparent" />
              <div className="absolute inset-0 bg-linear-to-t from-black to-transparent" />
              <Thumb x={hsva.s} y={1 - hsva.v} color={solid} />
            </DragSurface>
            <Track
              orientation="vertical"
              value={hsva.h / 360}
              background="linear-gradient(180deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)"
              thumbColor={hueColor}
              label="Hue"
              onValue={(f, done) => apply({ ...hsva, h: f * 360 }, done)}
            />
          </div>
        )}

        {mode === "wheel" && (
          <div className="space-y-4">
            <div className="flex justify-center">
              <DragSurface
                className="relative size-36 cursor-crosshair rounded-full"
                onDrag={(fx, fy, done) => {
                  const dx = fx - 0.5;
                  const dy = fy - 0.5;
                  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
                  if (angle < 0) angle += 360;
                  const dist = Math.min(Math.hypot(dx, dy) * 2, 1);
                  apply(hslToHsva(angle, dist, hsl.l, hsva.a), done);
                }}
              >
                <div className="absolute inset-0 rounded-full" style={{ background: WHEEL_CONIC }} />
                <div
                  className="pointer-events-none absolute inset-0 rounded-full"
                  style={{ background: "radial-gradient(circle, #fff 0%, rgba(255,255,255,0) 72%)" }}
                />
                <Thumb
                  x={0.5 + Math.cos((hsva.h * Math.PI) / 180) * hsl.s * 0.5}
                  y={0.5 + Math.sin((hsva.h * Math.PI) / 180) * hsl.s * 0.5}
                  color={solid}
                />
              </DragSurface>
            </div>
            <Track
              caption="L"
              value={hsl.l}
              background={`linear-gradient(90deg, #000, hsl(${hsva.h} 100% 50%), #fff)`}
              thumbColor={`hsl(${hsva.h} 100% ${hsl.l * 100}%)`}
              label="Lightness"
              onValue={(f, done) => apply(hslToHsva(hsl.h, hsl.s, f, hsva.a), done)}
            />
          </div>
        )}

        {/* Three labelled channels, spread across the stage. They used to be a
            tight stack floating in the middle of a box sized for the saturation
            pad — a void above and below that read as a broken layout. */}
        {mode === "sliders" && (
          <div className="flex h-full flex-col justify-evenly py-1">
            {format === "hex" || format === "hsb" ? (
              <>
                <Track caption="H" value={hsva.h / 360} background={HUE_GRADIENT} thumbColor={hueColor} label="Hue"
                  onValue={(f, done) => apply({ ...hsva, h: f * 360 }, done)} />
                <Track caption="S" value={hsva.s}
                  background={`linear-gradient(90deg, ${hsvaToHex({ ...hsva, s: 0, a: 1 })}, ${hsvaToHex({ ...hsva, s: 1, a: 1 })})`}
                  thumbColor={solid} label="Saturation"
                  onValue={(f, done) => apply({ ...hsva, s: f }, done)} />
                <Track caption="B" value={hsva.v}
                  background={`linear-gradient(90deg, #000, ${hsvaToHex({ ...hsva, v: 1, a: 1 })})`}
                  thumbColor={solid} label="Brightness"
                  onValue={(f, done) => apply({ ...hsva, v: f }, done)} />
              </>
            ) : format === "rgb" ? (
              (["r", "g", "b"] as const).map((ch) => (
                <Track
                  key={ch}
                  caption={ch.toUpperCase()}
                  value={rgba[ch] / 255}
                  background={`linear-gradient(90deg, rgb(${ch === "r" ? 0 : Math.round(rgba.r)},${ch === "g" ? 0 : Math.round(rgba.g)},${ch === "b" ? 0 : Math.round(rgba.b)}), rgb(${ch === "r" ? 255 : Math.round(rgba.r)},${ch === "g" ? 255 : Math.round(rgba.g)},${ch === "b" ? 255 : Math.round(rgba.b)}))`}
                  thumbColor={solid}
                  label={ch.toUpperCase()}
                  onValue={(f, done) => {
                    const next = { ...rgba, [ch]: f * 255 };
                    apply(rgbaToHsvaOf(next.r, next.g, next.b, hsva.a), done);
                  }}
                />
              ))
            ) : (
              <>
                <Track caption="H" value={hsl.h / 360} background={HUE_GRADIENT} thumbColor={hueColor} label="Hue"
                  onValue={(f, done) => apply(hslToHsva(f * 360, hsl.s, hsl.l, hsva.a), done)} />
                <Track caption="S" value={hsl.s}
                  background={`linear-gradient(90deg, hsl(${Math.round(hsl.h)} 0% ${Math.round(hsl.l * 100)}%), hsl(${Math.round(hsl.h)} 100% ${Math.round(hsl.l * 100)}%))`}
                  thumbColor={solid} label="Saturation"
                  onValue={(f, done) => apply(hslToHsva(hsl.h, f, hsl.l, hsva.a), done)} />
                <Track caption="L" value={hsl.l}
                  background={`linear-gradient(90deg, #000, hsl(${Math.round(hsl.h)} 100% 50%), #fff)`}
                  thumbColor={solid} label="Lightness"
                  onValue={(f, done) => apply(hslToHsva(hsl.h, hsl.s, f, hsva.a), done)} />
              </>
            )}
          </div>
        )}
      </div>

      {/* Alpha — one implementation, every mode. */}
      <Track
        caption="A"
        value={hsva.a}
        checker
        background={`linear-gradient(90deg, transparent, ${hsvaToHex({ ...hsva, a: 1 })})`}
        thumbColor={toCss(hsvaToHex(hsva))}
        label="Alpha"
        onValue={(f, done) => apply({ ...hsva, a: f }, done)}
      />

      {/* Notation + exact entry */}
      <div className="space-y-2">
        <Segmented
          value={format}
          options={FORMATS.map((f) => ({ id: f, label: f.toUpperCase() }))}
          onChange={(f) => { setFormat(f); savePref(FORMAT_KEY, f); }}
          ariaLabel="Color notation"
        />
        <NumericRow format={format} hsva={hsva} onApply={(next) => apply(next, true)} />
      </div>
    </div>
  );
}

function GlassIconButton({
  label,
  onClick,
  light,
  children,
}: {
  label: string;
  onClick: () => void;
  light: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-(--hit-target) items-center justify-center rounded-full backdrop-blur-sm transition-transform hover:scale-110 active:scale-95 [&_svg]:size-3.5"
      style={{
        backgroundColor: light ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.38)",
        color: light ? "#111" : "#fff",
      }}
    >
      {children}
    </button>
  );
}

/**
 * A gradient track with a thumb — the colour picker's own slider, and the one
 * place in the app that is NOT a `Range`. A Range paints a neutral fill up to
 * the value, which is exactly what a channel must not do: the whole point of a
 * hue strip is that you can see the colours you are choosing between, so the
 * gradient has to be the track and the position has to be a mark on it.
 *
 * The GESTURE is not its own, though. It rides `useSliderControl` like every
 * other slider in the app, so it inherits the gesture scope (a swipe past it
 * inside a scrolling panel scrolls; a deliberate drag scrubs), the pointer
 * claim, keyboard, detents, live-value pacing and the `pointercancel` teardown
 * — all of which this component used to hand-roll, badly, which is why a finger
 * on a colour track used to scroll the panel and then leave the thumb stuck to
 * the pointer for the rest of the session.
 */
function Track({
  caption,
  value,
  background,
  thumbColor,
  label,
  checker,
  orientation = "horizontal",
  onValue,
}: {
  /** One-letter channel mark in the leading gutter (H, S, B, A…). */
  caption?: string;
  value: number; // 0..1
  background: string;
  thumbColor: string;
  label: string;
  checker?: boolean;
  orientation?: "horizontal" | "vertical";
  onValue: (fraction: number, done: boolean) => void;
}) {
  const vertical = orientation === "vertical";
  /*
   * A vertical track here reads TOP → BOTTOM — it is the hue strip beside a
   * saturation pad, and every tool draws that one downward. The slider brain
   * reads bottom→top (up = more, the mixer convention every fader obeys). One
   * inversion, here, so neither the caller nor the brain has to bend.
   */
  const flip = (v: number) => (vertical ? 1 - v : v);
  const c = useSliderControl({
    value: flip(value),
    min: 0,
    max: 1,
    orientation,
    // A wheel over a channel is a wheel that was scrolling the panel. The one
    // place a value MUST not change is while you are trying to reach another.
    wheel: false,
    onChange: (f) => onValue(flip(f), false),
    onCommit: (f) => onValue(flip(f), true),
  });
  const pos = `${flip(c.fraction) * 100}%`;

  const bars = (
    <>
      {/* Both bars are anchored to the MIDDLE of the grab zone rather than left
          to their static position — the zone is bigger than the drawing, and an
          absolute box with no anchor lands wherever flow put it, which is a
          coincidence, not a layout. */}
      {checker && (
        <div
          className={cn(
            "absolute rounded-full",
            vertical ? "inset-y-0 left-1/2 w-3.5 -translate-x-1/2" : "inset-x-0 top-1/2 h-3.5 -translate-y-1/2",
          )}
          style={{ background: CHECKER }}
        />
      )}
      <div
        className={cn(
          "absolute rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25)]",
          vertical ? "inset-y-0 left-1/2 w-3.5 -translate-x-1/2" : "inset-x-0 top-1/2 h-3.5 -translate-y-1/2",
        )}
        style={{ background }}
      />
      {/* The mark, not a slab: a white ring showing the colour through its
          middle, so what you are aiming at is the value itself. It swells
          while dragging — the only feedback a thumb under a finger can give. */}
      <div
        className={cn(
          "pointer-events-none absolute rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.45),0_1px_3px_rgba(0,0,0,0.35)] transition-[width,height]",
          c.dragging ? "size-5.5" : "size-4.5",
          vertical ? "left-1/2 -translate-x-1/2 -translate-y-1/2" : "top-1/2 -translate-x-1/2 -translate-y-1/2",
        )}
        style={{ [vertical ? "top" : "left"]: pos, backgroundColor: thumbColor }}
      />
    </>
  );

  const track = (
    <div
      ref={c.trackRef}
      aria-label={label}
      className={cn(
        "relative outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        // The GRAB ZONE grows to a finger; the DRAWING stays 14px. A hit target
        // and the mark that shows where it is are two different numbers — see
        // `--hit-grip`, the same rule the timeline's trim grips obey. The
        // negative margin hands the extra back to the layout, so a row of
        // tracks is spaced exactly as if it were 14px thick.
        vertical
          ? "h-full w-3.5 cursor-ns-resize px-(--hit-grip) [box-sizing:content-box] [margin-inline:calc(var(--hit-grip)*-1)]"
          : "flex h-3.5 min-w-0 flex-1 cursor-ew-resize items-center py-(--hit-grip) [box-sizing:content-box] [margin-block:calc(var(--hit-grip)*-1)]",
      )}
      {...c.keyProps}
      {...c.trackProps}
    >
      {bars}
    </div>
  );

  if (vertical || !caption) return track;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-2.5 shrink-0 text-center font-mono text-[10px] font-medium uppercase text-muted-foreground/70">
        {caption}
      </span>
      {track}
    </div>
  );
}

/** Per-format exact entry: one hex field or three channel numbers, + alpha. */
function NumericRow({
  format,
  hsva,
  onApply,
}: {
  format: PickerFormat;
  hsva: Hsva;
  onApply: (next: Hsva, commit: boolean) => void;
}) {
  const rgba = hsvaToRgba(hsva);
  const hsl = hsvaToHsl(hsva);

  /*
   * `NumberInput`, not a private field. Every number in this panel is now the
   * app's number: drag to scrub, click to type, arrow keys, ⇧/⌥/⌃ precision,
   * and — the reason this change exists — an `<input>` that only exists while
   * you are actually typing in it, so a stylus cannot fall into one.
   */
  const channel = (
    label: string,
    value: number,
    max: number,
    write: (n: number, commit: boolean) => void,
  ) => (
    <NumberInput
      key={label}
      label={label}
      value={value}
      min={0}
      max={max}
      precision={0}
      className="min-w-0 flex-1"
      onChange={(n) => write(n, false)}
      onCommit={(n) => write(n, true)}
    />
  );

  const alphaField = channel("A", Math.round(hsva.a * 100), 100, (n, commit) =>
    onApply({ ...hsva, a: n / 100 }, commit),
  );

  if (format === "hex") {
    return (
      <div className="flex gap-2">
        <HexField hsva={hsva} onApply={(next) => onApply(next, true)} />
        <div className="w-16 shrink-0">{alphaField}</div>
      </div>
    );
  }

  const fields =
    format === "rgb"
      ? ([
          ["R", Math.round(rgba.r), 255, (n: number, c: boolean) => onApply(rgbaToHsvaOf(n, rgba.g, rgba.b, hsva.a), c)],
          ["G", Math.round(rgba.g), 255, (n: number, c: boolean) => onApply(rgbaToHsvaOf(rgba.r, n, rgba.b, hsva.a), c)],
          ["B", Math.round(rgba.b), 255, (n: number, c: boolean) => onApply(rgbaToHsvaOf(rgba.r, rgba.g, n, hsva.a), c)],
        ] as const)
      : format === "hsl"
        ? ([
            ["H", Math.round(hsl.h), 360, (n: number, c: boolean) => onApply(hslToHsva(n, hsl.s, hsl.l, hsva.a), c)],
            ["S", Math.round(hsl.s * 100), 100, (n: number, c: boolean) => onApply(hslToHsva(hsl.h, n / 100, hsl.l, hsva.a), c)],
            ["L", Math.round(hsl.l * 100), 100, (n: number, c: boolean) => onApply(hslToHsva(hsl.h, hsl.s, n / 100, hsva.a), c)],
          ] as const)
        : ([
            ["H", Math.round(hsva.h), 360, (n: number, c: boolean) => onApply({ ...hsva, h: n }, c)],
            ["S", Math.round(hsva.s * 100), 100, (n: number, c: boolean) => onApply({ ...hsva, s: n / 100 }, c)],
            ["B", Math.round(hsva.v * 100), 100, (n: number, c: boolean) => onApply({ ...hsva, v: n / 100 }, c)],
          ] as const);

  return (
    <div className="flex gap-2">
      {fields.map(([label, value, max, write]) => channel(label, value, max, write))}
      {alphaField}
    </div>
  );
}

/**
 * Exact hex entry — and a SPAN until you press it.
 *
 * This was a live `<input>`, which is the thing the whole change is about: a
 * focusable text field sitting permanently in a panel is a trap for a stylus,
 * and it raises a soft keyboard over the colour you are looking at. It now
 * matches `NumberInput`'s contract exactly — press to edit, Enter/blur commits,
 * Esc reverts — so the two fields beside each other behave identically.
 */
function HexField({ hsva, onApply }: { hsva: Hsva; onApply: (next: Hsva) => void }) {
  const hex = hsvaToHex({ ...hsva, a: 1 }).replace(/^#/, "").toUpperCase();
  const [draft, setDraft] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const edit = () => {
    setDraft(hex);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const commit = () => {
    if (draft === null) return;
    const parsed = hexToHsva(draft.startsWith("#") ? draft : `#${draft}`);
    setDraft(null);
    if (parsed) onApply({ ...parsed, a: draft.replace(/^#/, "").length === 8 ? parsed.a : hsva.a });
  };

  return (
    <div
      // Activated by CLICK, not by pointerdown. A press is not yet a press ON
      // this field — a finger starting a swipe here would otherwise open a
      // keyboard over the panel it was scrolling — and the role is what lets
      // `startDirectActivation` give a pen and a finger a click at all.
      {...(draft === null
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-label": "Edit hex color",
            onClick: edit,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                edit();
              }
            },
          }
        : {})}
      className={cn(
        "flex h-(--control-h) min-w-0 flex-1 items-center rounded-lg border border-transparent bg-input/45 px-2 transition-colors outline-none",
        draft === null
          ? "cursor-text hover:border-border focus-visible:border-primary/60"
          : "border-primary/60 bg-input/70",
      )}
    >
      <span className="mr-1 shrink-0 font-mono text-[10px] text-muted-foreground/70">#</span>
      {draft === null ? (
        <span className="min-w-0 flex-1 truncate font-mono text-xs uppercase tabular-nums">{hex}</span>
      ) : (
        <input
          ref={inputRef}
          value={draft}
          spellCheck={false}
          aria-label="Hex color"
          inputMode="text"
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 8))}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs uppercase tabular-nums outline-none"
        />
      )}
    </div>
  );
}

/** Pointer surface reporting fractional (0..1) coordinates while dragging. */
function DragSurface({
  className,
  children,
  onDrag,
}: {
  className?: string;
  children: React.ReactNode;
  onDrag: (fx: number, fy: number, done: boolean) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);

  return (
    <div
      ref={ref}
      // The pad IS the surface: there is no scroll to hand a one-finger drag
      // to and no hit-target difference to read, so the browser must be told
      // outright. Without this it claimed the drag as a page scroll on the
      // first move, fired `pointercancel`, and the thumb let go mid-pick.
      className={cn(className, DRAG_SURFACE)}
      onPointerDown={(e) =>
        trackPointer(e, (p, done) => {
          const el = ref.current;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          const fx = Math.max(0, Math.min(1, (p.clientX - rect.left) / rect.width));
          const fy = Math.max(0, Math.min(1, (p.clientY - rect.top) / rect.height));
          onDrag(fx, fy, done);
        })
      }
    >
      {children}
    </div>
  );
}

function Thumb({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <div
      className="pointer-events-none absolute size-4.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.45),0_1px_3px_rgba(0,0,0,0.35)]"
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, backgroundColor: color }}
    />
  );
}
