import type * as React from "react";
import type {
  BaseEffect,
  Clip,
  ClipKind,
  EffectDomain,
  EffectFieldDef,
  EffectFieldOption,
  EffectRegistry,
  EffectTypeDefBase,
  KeyframeValue,
  SharedList,
} from "@solomotion/core";
import type { LucideIcon } from "lucide-react";
import type { EffectMenuItem } from "../effect-add-menu";

/**
 * A headless handle onto ANY effect stack — the one thing `EffectStackSection`
 * talks to. A layer's `effects`, a text style's per-glyph `textEffects`, the
 * same list on a caption's focused word, and the same list across a
 * multi-selection are all a host each; the section, its cards, the floating
 * editor, the add palette, the looks picker, the clipboard verbs and the
 * keyboard are written once against this and never against a clip.
 *
 * The host owns three things the section must not know:
 *
 *   WHERE the list lives    a clip field, a style field, a scope overlay
 *   HOW a write fans        one clip, or every clip in the selection through
 *                           `propagateListEdit`, or an overlay's added/removed
 *   WHAT the selection      `shared` — the entries every target carries, and
 *   agrees on               per entry the fields it does not
 *
 * The section edits `effects` — the PRIMARY's list, or the resolved scope's —
 * and hands the result back through `update`. That is the whole write
 * contract for structure; `commit` is the keyframe-aware write for one field.
 */
export interface EffectStackHost<E extends BaseEffect = BaseEffect> {
  registry: EffectRegistry<E, EffectTypeDefBase<E>>;
  domain: EffectDomain;
  icon: (type: string) => LucideIcon;
  /** Stable identity for list selection and the editor (primary id + scope). */
  key: string;
  /** The primary clip — where keyframes live, what the preview frames. */
  clip: Clip;
  /** Fields key on this stack (false inside a text override scope). */
  canKey: boolean;
  /** The list the section renders and edits. */
  effects: E[];
  /** What the whole selection shares; a single target shares everything. */
  shared: SharedList<E>;
  /** The add palette's rows for this selection, and the promoted heading. */
  palette: { items: EffectMenuItem[]; heading: string };
  /**
   * The kinds of layer the selection is — what a fresh card is tailored to
   * (`registry.createFor`). Empty where the answer is not a layer at all.
   */
  kinds: readonly ClipKind[];
  /**
   * Structural edit: the section returns the next list; the host lands it
   * everywhere. `each` touches every target CLIP in the same undo step — what a
   * look with a rate (Stop motion) uses to set the layer's own `fps`. A host
   * whose list does not live on a clip may ignore it.
   */
  update: (label: string, fn: (list: E[]) => E[], mergeKey?: string, each?: (clip: Clip) => void) => void;
  /**
   * A card that brings something with it — a Lattice its fitted cage. When
   * present and it takes the type, it adds the card itself (one undo step,
   * whatever else it makes) and returns the new card's id; null leaves the
   * add to the section.
   */
  add?: (type: string) => string | null;
  /** One field, keyframe-aware, on every target. */
  commit: (effect: E, field: string, value: KeyframeValue, label: string, mergeKey?: string) => void;
  /**
   * The keyframe PATH for one of this stack's fields. Defaults to the
   * registry's own (`lfx.<id>.<field>`), which is right for a list that lives
   * directly on a clip and wrong for one that does not.
   *
   * It has to be the host's, because a path is not decoration: the diamond
   * writes a key at it, `useEffectiveValue` reads the sample back from it, and
   * `animWriteMode` decides whether the next edit goes to the base or to a key
   * by asking whether that path has keys. Hardcoding the registry's spelling
   * for a stack nested inside a grade node meant a single click of the diamond
   * planted a key nothing could read — after which every edit wrote to that
   * orphan key, the base never moved, and the field snapped back to a stale
   * sample. It looked like "effects do not work"; it was one wrong string.
   */
  pathOf?: (effectId: string, field: string) => string;
  /** A mode switch (never keyed), on every target. */
  setToggle: (effect: E, key: string, value: boolean, label: string) => void;
  /** Called the moment a kind is picked — lazy engines start fetching here. */
  prepare?: (type: string) => void;
  /** Clipboard wiring; absent where a copy would lie (an override scope). */
  transfer?: { domain: string; clipIds: string[] };
  /** A bespoke editor body for a kind (the grade card's wheels). */
  customBody?: (effect: E) => React.ReactNode | undefined;
  /** Above the generated rows — a state the rows depend on and cannot show (no depth for a depth card yet). */
  bodyLead?: (effect: E) => React.ReactNode | undefined;
  /** Appended under the generated rows — a kind's own view of what the rows set (a mouth map, a machine's states). */
  bodyExtra?: (effect: E) => React.ReactNode | undefined;
  /** The choices of a `ref` field on this card (a character's pose sets, poses, bones, voices). */
  refOptions?: (effect: E, field: EffectFieldDef) => readonly EffectFieldOption[];
  /**
   * A reference field drawn as a real picker (a voice, a part) instead of a
   * flat list of options — undefined keeps the list. Gets the field's value
   * and the commit, so the picker stays a pure control.
   */
  refField?: (effect: E, field: EffectFieldDef, value: string, set: (v: string) => void) => React.ReactNode | undefined;
  /** The stack as the Looks picker should match it (a look fitted to its comp is still that look); default: the stack itself. */
  lookOf?: (effects: E[]) => unknown;
  /** What one card is called, when its kind's label is not enough (a particle card named by its look). */
  cardLabel?: (effect: E) => string | undefined;
  /** Copy. */
  title: string;
  sectionId: string;
  addLabel: string;
  /** "effect" / "text effect" — the noun the menus conjugate. */
  noun: string;
  /** Extra header action (a scope's "inherit" control). */
  headerExtra?: React.ReactNode;
  /**
   * Verbs this stack's own kind adds to a card's menu, above the generic ones
   * (a modifier's Apply). Absent = none.
   */
  cardActions?: (effect: E) => ReadonlyArray<CardAction>;
}

/** One stack-specific verb on a card's menu. */
export interface CardAction {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Why it is unavailable, when it is. */
  disabledReason?: string;
  run: () => void;
}
