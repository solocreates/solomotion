"use client";

import { resizeCursor } from "@solomotion/ui/cursors";
import * as React from "react";
import { cn } from "@/lib/utils";
import { useFieldBinding } from "@/components/ui/field-binding";
import { FieldUnitSlot, useFieldUnit } from "@/components/ui/field-unit";
import { dragModifiers, stepFactor } from "./drag-modifiers";
import { beginHeldDrag, type HeldDrag } from "@/editor/input/hold-to-drag";
import { useLiveValue } from "./use-live-value";
import { DynamicGlyph, useAcceptTyped, useDynamicControl, type DynamicFieldState } from "@/editor/binding/dynamic-field";
import { useVariableSuggestions, VariableSuggestList, variableCssName } from "@/editor/binding/variable-suggest";
import { varToken } from "@solomotion/core";
import { capturePointer } from "../../editor/input/capture-pointer";

/**
 * Figma-style numeric input, used for every number in the app.
 *
 *  - drag horizontally anywhere on the field to scrub the value
 *  - click (without moving) to type; Enter/blur commits, Esc reverts
 *  - ↑/↓ steps, and the app-wide drag contract while scrubbing or nudging:
 *    ⇧ fine (×0.1) · ⌥ coarse (×10) · ⌃ snap onto the step. See
 *    `drag-modifiers` for why those three and not the other assignment — ⇧
 *    used to mean ×10 here and "fine" on every slider, which is the kind of
 *    disagreement nobody reports and everybody feels.
 *  - simple math on commit: "120+30", "1920/2"
 *
 * `onChange` fires live while scrubbing (pair it with an undo mergeKey);
 * `onCommit` fires once at the end of a scrub / on typed entry.
 */
export interface NumberInputProps {
  value: number | undefined;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  /** Change per pixel of drag and per arrow press. */
  step?: number;
  /** Decimal places shown (values are rounded to this on output). */
  precision?: number;
  /** Small leading label (icon slot): "X", "Y", "°", an icon element, … */
  label?: React.ReactNode;
  /** Trailing unit: "px", "%", "s", "°" */
  unit?: string;
  mixed?: boolean;
  /** What an EMPTY value reads as ("Auto") — where no value is a real setting, not a gap. */
  emptyLabel?: string;
  /** Typing the field EMPTY and committing sets it back to that empty setting. */
  onEmpty?: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  /**
   * The property this field edits, e.g. `fill.<id>.start.x`.
   *
   * Naming it is the whole opt-in: inside a `FieldBindingProvider` the field
   * gains the app's binding menu — variables, expressions, modulators,
   * keyframes — with nothing else written at the call site. Omit it and the
   * field behaves exactly as it always has, which is why every existing input
   * in the app was unaffected by this gaining a menu.
   */
  path?: string;
  /** Name shown in the menu heading and undo entries. Falls back to `path`. */
  fieldLabel?: string;
}

export function NumberInput({
  emptyLabel,
  onEmpty,
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  precision = 2,
  label,
  unit,
  mixed,
  disabled,
  className,
  title,
  path,
  fieldLabel,
}: NumberInputProps) {
  // Driven by an expression, a node graph or a variable? Then the field shows
  // that value and opens its source on click, instead of scrubbing a number the
  // driver would overwrite on the next frame.
  const dynamic = useDynamicControl();
  const unitNode = useFieldUnit(unit);
  // …and the way to CREATE one: type `#frame` or `#layer.rotation * 2` straight
  // into the field. Offered before the numeric parse, because what was typed was
  // never a number — see `readTypedValue`.
  const acceptTyped = useAcceptTyped();
  const bindRender = useFieldBinding();
  // A field with no path has nothing to bind TO, so it never decorates — the
  // default that kept every existing input in the app untouched.
  const bind = path ? bindRender : (a: { children: React.ReactNode }) => a.children;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState("");
  // `--` typed into a bindable field asks for the document's variables.
  const varQuery = editing && acceptTyped && /^\s*--/.test(text) ? text.trim() : null;
  const suggestions = useVariableSuggestions(varQuery, NUMBER_VARIABLES);
  const [pick, setPick] = React.useState(0);
  React.useEffect(() => setPick(0), [varQuery]);
  const linkVariable = (id: string) => {
    setEditing(false);
    acceptTyped?.(varToken(id));
  };
  const [scrubbing, setScrubbing] = React.useState(false);

  const clamp = React.useCallback(
    (v: number) => {
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      const f = Math.pow(10, precision);
      return Math.round(v * f) / f;
    },
    [min, max, precision],
  );

  /*
   * The scrub streams through the shared live-value seam — the same one behind
   * every Range and dial — so dragging a number over an expensive layer paints
   * at pointer rate and writes at whatever rate the app can absorb. See
   * `useLiveValue`; a field must never render its own `value` prop mid-gesture.
   */
  const streamed = useLiveValue<number>(value ?? 0, onChange);
  const shown = value === undefined ? undefined : streamed.value;
  const display = mixed ? "Mixed" : shown !== undefined ? trimZeros(shown, precision) : (emptyLabel ?? "–");

  // ── Scrub gesture (pointer capture; a click without movement enters edit mode)
  const gesture = React.useRef<{
    startX: number;
    startValue: number;
    moved: boolean;
    pointerId: number;
    arm: HeldDrag;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || editing || e.button !== 0) return;
    const startValue = value ?? 0;
    /*
     * A SCRUB IS NOT A SCROLL — and this field is the one that proved it.
     *
     * Put a number field in a horizontally scrollable bar (the brush tool's
     * options strip is a row of them) and dragging it did BOTH: the value moved
     * and the bar scrolled out from under the finger.
     *
     * The rule is not this field's to invent, so it does not: `beginHeldDrag`
     * reads the GESTURE SCOPE inherited from the DOM. Inside a scroller a quick
     * swipe scrolls and a brief hold scrubs; in a fixed inspector the scrub is
     * immediate; a mouse and a pen are never delayed. Arming claims the
     * pointer, and the arbiter then refuses the browser's scroll for the rest
     * of the gesture — so once you are scrubbing, nothing can take it away.
     */
    gesture.current = {
      startX: e.clientX,
      startValue,
      moved: false,
      pointerId: e.pointerId,
      arm: beginHeldDrag(e, { axis: "x" }),
    };
    capturePointer(e.currentTarget as HTMLElement, e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    if (!g.arm.update(e.clientX, e.clientY)) return;
    if (!g.moved) {
      g.moved = true;
      // Rebase: the travel spent EARNING the gesture is not also spent changing
      // the value, or a steered field lurches by its slop the moment it arms.
      g.startX = e.clientX;
      setScrubbing(true);
      document.body.style.cursor = resizeCursor(0);
    }
    const dx = e.clientX - g.startX;
    const m = dragModifiers(e);
    let next = g.startValue + dx * step * stepFactor(m);
    // ⌃ lands the scrub on the step lattice, so a drag can end on a round
    // number without you having to arrive there by hand.
    if (m.snap && step > 0) next = Math.round(next / step) * step;
    streamed.push(clamp(next));
  };

  const endGesture = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    g.arm.end();
    document.body.style.cursor = "";
    if (g.moved) {
      setScrubbing(false);
      // Flush first, then record: under commit pacing the prop can still be a
      // frame behind, so `streamed.value` is the value the scrub ended on.
      const final = streamed.value;
      streamed.end();
      if (value !== undefined) onCommit?.(final);
    } else if (e.type === "pointerup" && !g.arm.abandoned()) {
      // A clean click: enter typing mode. NOT after a swipe that the panel
      // took — putting a keyboard over the list you were scrolling is worse
      // than the scrub this field just declined to do.
      setText(mixed || shown === undefined ? "" : trimZeros(shown, precision));
      setEditing(true);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  };

  // ── Typing mode
  const commitText = () => {
    setEditing(false);
    if (onEmpty && text.trim() === "") {
      onEmpty();
      return;
    }
    if (acceptTyped?.(text)) return;
    const parsed = evalNumeric(text);
    if (parsed === null) return;
    const v = clamp(parsed);
    onChange(v);
    onCommit?.(v);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (varQuery !== null && suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = suggestions.length;
        setPick((p) => (p + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        linkVariable(suggestions[Math.min(pick, suggestions.length - 1)]!.id);
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      commitText();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const base = evalNumeric(text) ?? shown ?? 0;
      const v = clamp(base + (e.key === "ArrowUp" ? 1 : -1) * step * stepFactor(dragModifiers(e)));
      setText(trimZeros(v, precision));
      onChange(v);
      onCommit?.(v);
    }
  };

  const field = (
    <div
      className={cn(
        // The field's min-content is label + a few digits + the unit slot, and
        // it does NOT drop below that (no `min-w-0` here): a field squeezed
        // narrower than its own number used to let the value run under its
        // unit. A row too narrow for its fields must stack, not overlap.
        "group/num relative flex h-(--control-h) select-none items-center gap-1 px-1.5 text-body tabular-nums tracking-[-0.01em]",
        disabled ? "pointer-events-none opacity-40" : "cursor-ew-resize",
        dynamic?.className,
        className,
      )}
      data-part="field"
      data-scrubbing={scrubbing || undefined}
      style={dynamic?.style}
      {...(dynamic
        ? dynamic.props
        : {
            title,
            onPointerDown,
            onPointerMove,
            onPointerUp: endGesture,
            onPointerCancel: endGesture,
          })}
    >
      {dynamic && <DynamicGlyph field={dynamic.field} />}
      {label !== undefined && (
        <span className="flex shrink-0 items-center text-meta text-fg-faint">
          {label}
        </span>
      )}
      {dynamic ? (
        dynamic.field.source.kind === "variable" ? (
          <VariableToken field={dynamic.field} />
        ) : (
          <span className="min-w-[3ch] flex-1 truncate tabular-nums text-fg">{dynamic.field.preview ?? display}</span>
        )
      ) : editing ? (
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => e.stopPropagation()}
          data-num=""
          className="w-full min-w-[3ch] flex-1 cursor-text bg-transparent outline-none"
          inputMode="decimal"
          spellCheck={false}
        />
      ) : (
        <span
          data-num=""
          className={cn("min-w-[3ch] flex-1 truncate", mixed || value === undefined ? "text-fg-faint" : "text-fg")}
        >
          {display}
        </span>
      )}
      {unitNode !== null && <FieldUnitSlot>{unitNode}</FieldUnitSlot>}
      {varQuery !== null && (
        <VariableSuggestList items={suggestions} active={pick} query={varQuery} onPick={(s) => linkVariable(s.id)} />
      )}
    </div>
  );

  // Decorated when the caller named a path AND a provider is installed above;
  // otherwise returned exactly as built. See `field-binding`.
  return <>{bind({ path: path ?? "", label: fieldLabel ?? path ?? "", literal: value ?? 0, kind: "number", children: field })}</>;
}

function trimZeros(v: number, precision: number): string {
  return Number(v.toFixed(precision)).toString();
}

/** Parse "42", "-3.5", or simple math like "100+20", "1920/2", "3*8". */
function evalNumeric(raw: string): number | null {
  const text = raw.trim().replace(/,/g, ".");
  if (text === "") return null;
  const direct = Number(text);
  if (!Number.isNaN(direct)) return direct;
  const m = text.match(/^(-?\d*\.?\d+)\s*([+\-*/])\s*(-?\d*\.?\d+)$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  switch (m[2]) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? null : a / b;
    default:
      return null;
  }
}

/** Variables a number slot can take. */
const NUMBER_VARIABLES = ["number"] as const;

/**
 * A field linked to a variable shows the LINK: the variable's `--name` as a
 * token, in the variable tone when live and grey, dashed and struck when its
 * variable was deleted. The value is in the tooltip; a 70px X field has room
 * for the name or the number, and the name is the news.
 */
function VariableToken({ field }: { field: DynamicFieldState }) {
  return (
    <span
      data-part="var-token"
      data-status={field.dead ? "dead" : "live"}
      title={field.preview ?? undefined}
      className="min-w-0 max-w-full truncate"
    >
      {field.name ? variableCssName(field.name) : "--deleted"}
    </span>
  );
}
