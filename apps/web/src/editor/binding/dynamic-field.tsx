"use client";

import * as React from "react";
import { Boxes, FunctionSquare, SlidersHorizontal, Smile, Waypoints } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BoundSourceKind, ValueSource } from "@solomotion/core";
import { cn } from "@/lib/utils";

/**
 * THE INPUT IS THE AFFORDANCE.
 *
 * A value's source belongs ON the value, not in a chip beside it. A driven field
 * shows its live resolved value — the number the canvas is actually drawing —
 * tinted by where that number comes from, and clicking it opens the thing that
 * computes it. Right-click still carries the full vocabulary; this is the
 * one-gesture path.
 *
 * It is a CONTEXT rather than a prop because the alternative was editing every
 * call site in the app. The two binding wrappers already sit around every
 * control there is — `PropertyBindingMenu` for path-addressed properties,
 * `BindingContextMenu` for slots that store their own value — so they provide,
 * the input primitives consume, and a field written next year inherits the whole
 * behaviour by being an ordinary field.
 *
 * The look is deliberately restrained: a tinted border and a small leading
 * glyph. A driven field must still read as a field you can look at and
 * understand, not as a badge that happens to contain a number.
 */

/** ONE word per source, and it is the word the UI says everywhere. "Driver",
 *  "binding" and "link" are implementation words and never reach a person. */
export const SOURCE_META: Record<FieldSourceKind, { word: string; tint: string; Icon: LucideIcon }> = {
  expression: { word: "Expression", tint: "var(--bind-expression)", Icon: FunctionSquare },
  graph: { word: "Nodes", tint: "var(--bind-graph)", Icon: Waypoints },
  variable: { word: "Variable", tint: "var(--bind-variable)", Icon: Boxes },
  pose: { word: "Pose", tint: "var(--bind-pose)", Icon: Smile },
  input: { word: "Input", tint: "var(--bind-input)", Icon: SlidersHorizontal },
};

/**
 * A field a POSE SET owns (Characters 2.0): not a token on the slot but a set
 * on an enclosing group that writes it every frame. Same affordance — tinted,
 * click opens the set on the Face pad — so a posed value never looks editable.
 */
export interface PoseFieldSource {
  kind: "pose";
  groupId: string;
  setId: string;
}

export type FieldSourceKind = BoundSourceKind | "pose";

export interface DynamicFieldState {
  source: (ValueSource & { kind: BoundSourceKind }) | PoseFieldSource;
  /** The source's own name, when it has one — a variable's, a graph's. */
  name: string | null;
  /** What the field shows: the live resolved value, already formatted. Null
   *  means "you already have it" — a path-bound property's control is handed the
   *  resolved value by the document itself. */
  preview: string | null;
  /**
   * Set when the source produced nothing and the field is showing the last value
   * that made sense. A broken expression must never read as zero: that silently
   * flings the layer to the origin, which is the worst failure this system has.
   */
  error: string | null;
  /**
   * The reference points at something that no longer exists (a deleted
   * variable). Drawn grey, dashed and struck rather than as an error: nothing
   * is computing wrongly, the link is simply dead until it is relinked.
   */
  dead?: boolean;
  /** Open the thing that computes this value, in place. */
  open: () => void;
  /** Drop the source, keeping the value that is on screen. */
  detach: () => void;
}

/**
 * Consume typed text as a source. Returns true when it took it — the control
 * must then abandon its own parse, because what the person typed was never a
 * value. See `useTypedSourceBinder`, and `readTypedValue` in core for the rule.
 */
export type AcceptTyped = (text: string) => boolean;

interface DynamicFieldContext {
  field: DynamicFieldState | null;
  accept: AcceptTyped | null;
}

const EMPTY: DynamicFieldContext = { field: null, accept: null };

const DynamicField = React.createContext<DynamicFieldContext>(EMPTY);

export function DynamicFieldProvider({
  state,
  accept,
  children,
}: {
  state?: DynamicFieldState | null;
  accept?: AcceptTyped | null;
  children: React.ReactNode;
}) {
  const value = React.useMemo(
    () => ({ field: state ?? null, accept: accept ?? null }),
    [state, accept],
  );
  return <DynamicField.Provider value={value}>{children}</DynamicField.Provider>;
}

/** What drives the field this control is inside, or null when it is free. */
export function useDynamicField(): DynamicFieldState | null {
  return React.useContext(DynamicField).field;
}

/**
 * The seam that lets ANY control accept an expression typed into it. A control
 * calls this once and, on commit, offers its raw text before parsing it:
 *
 *     if (acceptTyped?.(text)) return;   // it bound; nothing else to do
 *
 * Null when the field is not bindable, which is what a control that is handed
 * no binding wrapper sees — it keeps its old behaviour exactly.
 */
export function useAcceptTyped(): AcceptTyped | null {
  return React.useContext(DynamicField).accept;
}

/**
 * Everything an input primitive needs to become a dynamic field: the tint for
 * its own box, the glyph to lead with, and the gestures that replace its normal
 * ones. Null when nothing drives it, so a primitive spreads it and is done.
 *
 * A driven control does NOT keep its own editing behaviour. Scrubbing a number
 * whose value is computed would write into a slot the driver overwrites on the
 * next frame — a gesture that appears to work and cannot. Click opens the
 * source; ⌥-click detaches, keeping the value on screen, which is the same
 * muscle memory the binding rule already borrows from Figma.
 */
export function useDynamicControl(): {
  field: DynamicFieldState;
  style: React.CSSProperties;
  className: string;
  props: {
    title: string;
    onPointerDown: (e: React.PointerEvent) => void;
    onDoubleClick: (e: React.MouseEvent) => void;
  };
} | null {
  const field = useDynamicField();
  if (!field) return null;
  const meta = SOURCE_META[field.source.kind];
  return {
    field,
    style: field.dead
      ? { borderColor: "color-mix(in srgb, var(--foreground) 22%, transparent)", borderStyle: "dashed" }
      : { borderColor: field.error ? "var(--destructive)" : meta.tint },
    className: "cursor-pointer",
    props: {
      title: field.dead
        ? `${meta.word} · ${field.error ?? "missing"} · click to relink, ⌥-click to detach`
        : field.error
        ? `${meta.word} · ${field.error} — showing the last value that worked`
        : `${meta.word}${field.name ? ` · ${field.name}` : ""} · click to open, ⌥-click to detach`,
      onPointerDown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) field.detach();
        else field.open();
      },
      // A double-click would otherwise fall through to the control's own
      // type-to-edit and put a caret in a value you cannot type into.
      onDoubleClick: (e) => {
        e.preventDefault();
        e.stopPropagation();
      },
    },
  };
}

/** The leading mark on a dynamic field — the whole of the "which source" signal
 *  that isn't the border. Sized to sit in a control's affix slot. */
export function DynamicGlyph({ field, className }: { field: DynamicFieldState; className?: string }) {
  const meta = SOURCE_META[field.source.kind];
  const Icon = meta.Icon;
  return (
    <Icon
      className={cn("size-2.5 shrink-0", className)}
      style={{ color: field.dead ? "var(--fg-faint)" : field.error ? "var(--destructive)" : meta.tint }}
    />
  );
}
