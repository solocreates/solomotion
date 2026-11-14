import { current, isDraft } from "immer";
import { setClipProperty } from "../animation/paths";
import { emptyOverlay, type OverlayAdditions, type ScopeOverlay } from "../schema/scope";
import { textStyleSchema } from "../schema/text-style";
import type {
  CaptionState,
  CaptionStateStyle,
  KeyframeValue,
  LayerEffect,
  Paint,
  PartialTextStyle,
  StrokeStyle,
  StyleRange,
  TextClip,
  TextEffect,
  TextStyle,
} from "../schema";

/**
 * The scope engine — resolution and introspection for `ScopeOverlay`.
 *
 * The schema says what an override IS (a sparse path→value map plus two
 * structural lists). This says what it MEANS: given a parent and an overlay,
 * what does the child look like, and — the half every inspector needs and
 * nobody had — which fields is it actually overriding right now.
 *
 * Both directions are pure functions of stored data. Nothing here caches an
 * "is overridden" flag, so the badge on a field, the count on a tab and the
 * value the renderer draws are three readings of one fact.
 */

// ── The address ──────────────────────────────────────────────────────────────

/**
 * WHICH style target the inspector is pointed at. `base` is the layer itself;
 * the other two are overlays over it. A range is addressed by SPAN, not by id,
 * because the span is what the user has selected — the range object under it
 * may not exist yet (styling a virgin selection creates one).
 */
export type ScopeAddress =
  | { kind: "base" }
  /**
   * ONE CAPTION STATE — the words being spoken, the ones already spoken, or
   * the ones still to come. Parameterised rather than three arms, because
   * they are three instances of one idea; a fourth state (a lead-in, say)
   * costs a string, not a branch in every consumer.
   */
  | { kind: "caption"; state: CaptionState }
  | { kind: "range"; start: number; end: number }
  /**
   * ONE CONTOUR of a vector layer — the piece selected in the pen tool. Same
   * idea as a text range and deliberately the same vocabulary: the sidebar is
   * pointed at something that is not the layer, so a write lands in an overlay
   * instead of on the clip. Addressed by ID rather than by index, because a
   * split, a join or a knife cut renumbers the list under a live selection.
   */
  | { kind: "contour"; contourId: string };

export const BASE_SCOPE: ScopeAddress = { kind: "base" };

export function scopeKey(scope: ScopeAddress): string {
  if (scope.kind === "range") return `range:${scope.start}:${scope.end}`;
  if (scope.kind === "contour") return `contour:${scope.contourId}`;
  if (scope.kind === "caption") return `caption:${scope.state}`;
  return scope.kind;
}

export function scopesEqual(a: ScopeAddress, b: ScopeAddress): boolean {
  return scopeKey(a) === scopeKey(b);
}

// ── Emptiness ────────────────────────────────────────────────────────────────

/**
 * "Identical to my parent". Every list counts — a range whose only override
 * is an added glow used to read as empty here, so `normalizeRanges` pruned it
 * the moment it was written, and the glow never reached a glyph.
 */
export function overlayIsEmpty(ov: ScopeOverlay | undefined): boolean {
  return overlayCount(ov) === 0;
}

/** How many distinct things this overlay changes — the badge every scope tab wears. */
export function overlayCount(ov: ScopeOverlay | undefined): number {
  if (!ov) return 0;
  return (
    Object.keys(ov.props).length +
    ov.removed.length +
    ov.added.effects.length +
    ov.added.fills.length +
    ov.added.strokes.length +
    (ov.added.textEffects?.length ?? 0)
  );
}

// ── The typographic view ─────────────────────────────────────────────────────

/**
 * The style keys that are ALSO property paths. Derived from the style schema
 * itself, so adding a typographic field makes it scopable with no second list
 * to remember. Two are excluded on purpose: `highlight` is an object, addressed
 * per-field as `highlight.<k>`; `textEffects` is a LIST, resolved structurally
 * through `added`/`removed`/`tfx.<id>.<field>` — a key merge would replace the
 * whole stack, so it must never be storable as one prop.
 */
const STYLE_KEYS = new Set(
  Object.keys(textStyleSchema.shape).filter((k) => k !== "highlight" && k !== "textEffects"),
) as ReadonlySet<keyof TextStyle>;

export function isStylePath(path: string): boolean {
  return STYLE_KEYS.has(path as keyof TextStyle) || path.startsWith("highlight.");
}

/**
 * The `PartialTextStyle` VIEW of an overlay — the subset of its props that are
 * typographic. Layout, measurement and the renderer speak this shape, so this
 * is the seam between "an override is a path" and "text is styled by a style".
 */
export function overlayStyle(ov: ScopeOverlay | undefined): PartialTextStyle {
  if (!ov) return {};
  const out: Record<string, unknown> = {};
  let highlight: Record<string, unknown> | undefined;
  for (const [path, value] of Object.entries(ov.props)) {
    if (path.startsWith("highlight.")) {
      highlight ??= {};
      highlight[path.slice("highlight.".length)] = value;
    } else if (STYLE_KEYS.has(path as keyof TextStyle)) {
      out[path] = value;
    }
  }
  // A partial highlight is meaningless to a renderer that needs all four
  // fields, so it only surfaces once the scope has said everything about it.
  if (highlight && ["color", "radius", "paddingX", "paddingY"].every((k) => k in highlight)) {
    out.highlight = highlight;
  }
  return out as PartialTextStyle;
}

/** Fold a `PartialTextStyle` patch INTO an overlay (the write side of the view). */
export function writeStyleToOverlay(ov: ScopeOverlay, patch: PartialTextStyle): void {
  for (const [k, v] of Object.entries(patch)) {
    // A LIST is structure, not a value at a path: `props` holds scalars only,
    // so `textEffects` on a range landed there and failed validation — the
    // "text.style refuses textEffects on a word range" its own help offered.
    // A scope's own effects are its ADDITIONS (`added.textEffects`), on top of
    // what it inherits; writing them replaces what this scope added before.
    if (k === "textEffects") {
      ov.added.textEffects = ((v ?? []) as TextEffect[]).map((e) => detach(e));
      continue;
    }
    if (k === "highlight") {
      if (v === null) {
        for (const p of Object.keys(ov.props)) if (p.startsWith("highlight.")) delete ov.props[p];
        ov.props["highlight.color"] = "";
        continue;
      }
      for (const [hk, hv] of Object.entries(v as Record<string, unknown>)) {
        ov.props[`highlight.${hk}`] = hv as KeyframeValue;
      }
      continue;
    }
    ov.props[k] = v as KeyframeValue;
  }
}

// ── Cloning ──────────────────────────────────────────────────────────────────

/**
 * A detached deep copy of a value that may be an Immer DRAFT.
 *
 * Everything that WRITES here runs inside `store.update`, where the clip — and
 * every overlay hanging off it — is a proxy, and `structuredClone` refuses to
 * clone a proxy. Unwrapping with `current` first is the one rule; it is a named
 * helper because forgetting it throws only on the path that has an override,
 * which is the path nobody tests by hand.
 */
export function detach<T>(value: T): T {
  return structuredClone(isDraft(value) ? (current(value) as T) : value) as T;
}

// ── Addressing entries ───────────────────────────────────────────────────────

/** The lists an overlay can address by entry id. */
export type ScopedList = "fill" | "stroke" | "lfx" | "tfx";

const ENTRY_PATH = /^(fill|stroke|lfx|tfx)\.([^.]+)(?:\.|$)/;

/**
 * Which list entry a path names, if any: `fill.<id>`, `fill.<id>.color`,
 * `stroke.<id>.width`, `lfx.<id>.radius`, `tfx.<id>.blur`. THE one parser for
 * "does this override touch an entry" — the resolver uses it to know what to
 * copy before patching, the write seam to know whether the entry is the
 * scope's own. A bare `fill.<id>` IS an address (it is the solid colour), which
 * is why the trailing dot is optional; requiring it was how a range's own fill
 * got patched in place on a frozen document.
 */
export function entryOfPath(path: string): { list: ScopedList; id: string } | null {
  const m = ENTRY_PATH.exec(path);
  return m ? { list: m[1] as ScopedList, id: m[2]! } : null;
}

const ADDED_LIST: Record<ScopedList, keyof OverlayAdditions> = {
  fill: "fills",
  stroke: "strokes",
  lfx: "effects",
  tfx: "textEffects",
};

/** Is this entry one the scope ADDED (as opposed to inherited from its parent)? */
export function isOwnEntry(ov: ScopeOverlay, path: string): boolean {
  const e = entryOfPath(path);
  if (!e) return false;
  return (ov.added[ADDED_LIST[e.list]] as Array<{ id: string }>).some((x) => x.id === e.id);
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** The three lists every style target carries — a text layer, a contour, a scope. */
export interface ScopeLook {
  fills: Paint[];
  strokes: StrokeStyle[];
  effects: LayerEffect[];
}

/** A style target with every override applied — what the scope actually looks like. */
export interface ResolvedScope extends ScopeLook {
  /** Carries `textEffects` — the per-glyph passes, resolved like any list. */
  style: TextStyle;
}

/**
 * Resolve a parent's LISTS under an overlay: removals, then additions, then
 * the `fill.<id>.…` / `stroke.<id>.…` / `lfx.<id>.…` value patches. Generic
 * over the parent so a vector contour (no style) and a text scope (a style)
 * share the one implementation — the second copy of this is where the two
 * used to disagree.
 *
 * Only entries an overlay actually patches are copied, so a scope that nudges
 * one fill never deep-copies a stack of twelve effects per frame. NOTHING
 * handed in is ever mutated: a patched entry is detached first, whether it was
 * inherited or added by this very scope — the document behind it is frozen.
 *
 * The empty overlay returns the parent ITSELF. That is the fast path that
 * makes this safe to call per glyph-run per frame: a document where nothing is
 * scoped allocates nothing.
 */
export function resolveLook<T extends ScopeLook>(parent: T, ov: ScopeOverlay | undefined): T {
  if (overlayIsEmpty(ov)) return parent;
  const o = ov!;
  const drop = new Set(o.removed);
  const patched = new Set<string>();
  for (const path of Object.keys(o.props)) {
    const e = entryOfPath(path);
    if (e && e.list !== "tfx") patched.add(e.id);
  }
  const own = <E extends { id: string }>(inherited: E[], added: E[]): E[] =>
    inherited
      .filter((e) => !drop.has(e.id))
      .concat(added)
      .map((e) => (patched.has(e.id) ? detach(e) : e));

  const carrier = {
    ...parent,
    kind: "text" as const,
    fills: own(parent.fills, o.added.fills),
    strokes: own(parent.strokes, o.added.strokes),
    effects: own(parent.effects, o.added.effects),
  };
  if (patched.size > 0) {
    for (const [path, value] of Object.entries(o.props)) {
      const e = entryOfPath(path);
      if (e && e.list !== "tfx") setClipProperty(carrier as never, path, value);
    }
  }
  const { kind: _kind, ...out } = carrier;
  void _kind;
  return out as T;
}

/**
 * Resolve a TEXT STYLE under an overlay. THE per-glyph resolver: the layout,
 * the renderer, the edit overlay and the inspector all come through here,
 * which is why a range's colour, its font and its own glow show up in every
 * one of them from a single write.
 *
 * Two kinds of override, because a style holds two kinds of thing:
 *
 *   KEYS   (colour, size, italic…) merge — the overlay's props win per field.
 *   LISTS  (`textEffects`) resolve structurally — the scope drops inherited
 *          entries by id, appends its own, and patches fields of the ones it
 *          kept. A key merge would replace the whole list, so "the focused word
 *          glows brighter" would silently throw away the layer's shadow.
 */
export function resolveStyle(style: TextStyle, ov: ScopeOverlay | undefined): TextStyle {
  if (overlayIsEmpty(ov)) return style;
  const o = ov!;
  const merged = { ...style, ...overlayStyle(o) };
  return withScopedTextEffects(merged, o);
}

/** Apply a scope's per-glyph effect overrides: drop, add, then patch fields. */
function withScopedTextEffects(style: TextStyle, ov: ScopeOverlay): TextStyle {
  const added = ov.added.textEffects ?? [];
  const removed = ov.removed;
  const patches = Object.keys(ov.props).filter((p) => p.startsWith("tfx."));
  if (added.length === 0 && removed.length === 0 && patches.length === 0) return style;

  const drop = new Set(removed);
  let list = (style.textEffects ?? []).filter((e) => !drop.has(e.id)).concat(added);

  if (patches.length > 0) {
    // Only the entries actually patched are copied — a scope that nudges one
    // glow must not clone a stack of five every glyph, every frame.
    const touched = new Set(patches.map((p) => entryOfPath(p)?.id));
    list = list.map((e) => (touched.has(e.id) ? ({ ...e } as TextEffect) : e));
    for (const path of patches) {
      const [, id, field] = path.split(".");
      const target = list.find((e) => e.id === id);
      if (target && field) (target as unknown as Record<string, unknown>)[field] = ov.props[path];
    }
  }
  return { ...style, textEffects: list };
}

/**
 * Resolve a parent + overlay into the concrete look of the child: the lists
 * through `resolveLook`, the style through `resolveStyle`. The empty overlay
 * returns the parent by reference.
 */
export function resolveOverlay(parent: ResolvedScope, ov: ScopeOverlay | undefined): ResolvedScope {
  if (overlayIsEmpty(ov)) return parent;
  const look = resolveLook(parent, ov);
  return { ...look, style: resolveStyle(parent.style, ov) };
}

/**
 * Does this overlay change what the glyphs are PAINTED with — not their
 * typography, their fills and strokes? The renderer's fast path: a range that
 * only recolours through `color` never costs a paint resolution.
 */
export function overlayTouchesPaints(ov: ScopeOverlay | undefined): boolean {
  if (!ov) return false;
  if (ov.added.fills.length > 0 || ov.added.strokes.length > 0 || ov.removed.length > 0) return true;
  for (const path of Object.keys(ov.props)) {
    const e = entryOfPath(path);
    if (e && (e.list === "fill" || e.list === "stroke")) return true;
  }
  return false;
}

/** The layer itself, as a scope — the root every overlay resolves against. */
export function baseScope(clip: TextClip): ResolvedScope {
  return { style: clip.style, fills: clip.fills, strokes: clip.strokes, effects: clip.effects };
}

/**
 * The overlay a scope address points at, or undefined when it points at the base.
 *
 * A SPAN is not a range: it can cover several ranges, or half of one, or none.
 * So the range case reports what every grapheme in the span AGREES on — the
 * same "shared value or nothing" rule the multi-select inspector uses, and for
 * the same reason: a field that differs across your selection has no single
 * value to show, so showing the inherited one would be a lie you could
 * accidentally commit by touching a different field.
 */
export function overlayAt(clip: TextClip, scope: ScopeAddress): ScopeOverlay | undefined {
  if (scope.kind === "range") return sharedOverlayIn(clip.ranges, scope.start, scope.end);
  if (scope.kind === "caption") return clip.caption?.states[scope.state].overlay;
  // `base`, and `contour` — which addresses a VECTOR layer, so a text clip
  // pointed at one is looking at nothing and correctly falls back to itself.
  return undefined;
}

/**
 * The overlay shared by EVERY grapheme in [start, end). A prop survives only if
 * every covering range carries it with the same value AND the ranges leave no
 * gap — an uncovered grapheme inherits, which disagrees with any override.
 * The structural lists survive only when every covering range agrees on them
 * entry for entry.
 *
 * A READ-ONLY view. It is built fresh — nothing in it aliases the document —
 * but it is the shared picture of several ranges, and writing to a picture
 * changes nothing; range writes go through `applyRangePatch`, which visits
 * each covered range on its own.
 */
export function sharedOverlayIn(ranges: StyleRange[], start: number, end: number): ScopeOverlay | undefined {
  if (end <= start) return undefined;
  const covering = ranges
    .filter((r) => r.end > start && r.start < end)
    .sort((a, b) => a.start - b.start);
  if (covering.length === 0) return undefined;
  // Any hole in the span means "some of these characters override nothing".
  let cursor = start;
  for (const r of covering) {
    if (r.start > cursor) return undefined;
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < end) return undefined;

  const first = covering[0]!.overlay;
  const out: ScopeOverlay = {
    props: { ...first.props },
    removed: [...first.removed],
    added: cloneAdditions(first.added),
  };
  for (const r of covering.slice(1)) {
    for (const k of Object.keys(out.props)) {
      if (!Object.is(out.props[k], r.overlay.props[k])) delete out.props[k];
    }
    out.removed = out.removed.filter((id) => r.overlay.removed.includes(id));
    for (const list of Object.keys(out.added) as (keyof OverlayAdditions)[]) {
      if (!sameIds(out.added[list], r.overlay.added[list] ?? [])) out.added[list] = [];
    }
  }
  return out;
}

function cloneAdditions(a: OverlayAdditions): OverlayAdditions {
  return {
    effects: [...a.effects],
    fills: [...a.fills],
    strokes: [...a.strokes],
    textEffects: [...(a.textEffects ?? [])],
  };
}

/** Same entries, same order — the cheap "did this list move?" test. */
export function sameIds(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i]!.id);
}

/** Same entries, same VALUES — "did anything about this list change?". */
export function sameEntries(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/** Resolve any scope address on a text clip in one call. */
export function resolveScope(clip: TextClip, scope: ScopeAddress): ResolvedScope {
  return resolveOverlay(baseScope(clip), overlayAt(clip, scope));
}

// ── Introspection: what is this scope actually changing? ─────────────────────

export type OverrideKind = "prop" | "removed" | "added";

/** One thing a scope changes — the unit the "Overrides" list renders and clears. */
export interface OverrideEntry {
  kind: OverrideKind;
  /** Property path for `prop`; the entry id for `removed`/`added`. */
  id: string;
  /** Which panel section owns it, so the UI can group without a second table. */
  domain: OverrideDomain;
  value?: KeyframeValue;
}

export type OverrideDomain =
  | "typography"
  | "highlight"
  | "fill"
  | "stroke"
  | "effects"
  | "textEffects"
  | "layer";

export function domainOfPath(path: string): OverrideDomain {
  if (path.startsWith("highlight.")) return "highlight";
  if (path.startsWith("fill.")) return "fill";
  if (path.startsWith("stroke.")) return "stroke";
  if (path.startsWith("lfx.")) return "effects";
  if (path.startsWith("tfx.")) return "textEffects";
  if (STYLE_KEYS.has(path as keyof TextStyle)) return "typography";
  return "layer";
}

/** Every override in one flat, grouped-by-domain list. Derived, never stored. */
export function overrideEntries(ov: ScopeOverlay | undefined): OverrideEntry[] {
  if (!ov) return [];
  const out: OverrideEntry[] = [];
  for (const [path, value] of Object.entries(ov.props)) {
    out.push({ kind: "prop", id: path, domain: domainOfPath(path), value });
  }
  for (const id of ov.removed) out.push({ kind: "removed", id, domain: "layer" });
  for (const e of ov.added.effects) out.push({ kind: "added", id: e.id, domain: "effects" });
  for (const f of ov.added.fills) out.push({ kind: "added", id: f.id, domain: "fill" });
  for (const s of ov.added.strokes) out.push({ kind: "added", id: s.id, domain: "stroke" });
  for (const t of ov.added.textEffects) out.push({ kind: "added", id: t.id, domain: "textEffects" });
  return out;
}

/** The domains a scope touches — drives which sections show an override dot. */
export function overriddenDomains(ov: ScopeOverlay | undefined): Set<OverrideDomain> {
  return new Set(overrideEntries(ov).map((e) => e.domain));
}

/**
 * Does this prop path hold a COLOUR? The overlay is flat, so a colour slot is
 * identified by its path rather than by its position in a nested object —
 * which is what lets the document-wide retint sweep treat `color`,
 * `highlight.color`, `fill.<id>.color` and `lfx.<id>.color` as one case.
 */
export function isColorPath(path: string): boolean {
  return path === "color" || path.endsWith(".color") || path.endsWith(".background");
}

/** Is this exact path overridden here? THE question a field's link button asks. */
export function isOverridden(ov: ScopeOverlay | undefined, path: string): boolean {
  return !!ov && path in ov.props;
}

// ── Mutation (call inside a store update; these mutate drafts) ────────────────

/**
 * Write a value at a path in this scope — the "unlink from the parent" write.
 *
 * Two cases, and the seam decides: a path on an INHERITED entry (or a plain
 * style key) records an override in `props`, so the parent still supplies
 * everything else about it. A path on an entry this scope ADDED writes the
 * entry itself — the scope already owns every field of it, and an override
 * over one's own value is a second copy of one fact, which is the shape that
 * drifts. So `props` only ever describes differences from the parent, which is
 * what the Overrides list, the count badge and the revert dot all assume.
 */
export function writeOverlayPath(ov: ScopeOverlay, path: string, value: KeyframeValue): void {
  if (isOwnEntry(ov, path)) {
    const carrier = {
      kind: "text" as const,
      style: { textEffects: ov.added.textEffects },
      fills: ov.added.fills,
      strokes: ov.added.strokes,
      effects: ov.added.effects,
    };
    setClipProperty(carrier as never, path, value);
    return;
  }
  ov.props[path] = value;
}

/**
 * Drop an override — the "follow the parent again" write. This is the ONLY
 * way a field goes back to inherited, and it is a delete, so there is no stale
 * value left behind to resurrect later. The pill is four props; reverting any
 * of them reverts the pill, since a partial highlight is not a thing the
 * renderer can draw.
 */
export function clearOverlayProp(ov: ScopeOverlay, path: string): void {
  delete ov.props[path];
  if (path.startsWith("highlight.")) {
    for (const p of Object.keys(ov.props)) if (p.startsWith("highlight.")) delete ov.props[p];
  }
}

/**
 * Commit a STRUCTURAL paint edit to a scope: the person edited the resolved
 * fills/strokes as a list (added one, removed one, reordered, swapped a paint's
 * type) and this records the result.
 *
 * None of that is expressible as a delta over the parent's list, so a list
 * that changed is FORKED: the scope takes ownership of the whole list and drops
 * every inherited entry — Figma detaches a nested override for the same reason.
 * Only the list that actually moved forks; adding a stroke must not also
 * detach the fills. Props that addressed a now-dropped inherited entry are
 * pruned, because an override of something the scope no longer inherits is a
 * value with no subject.
 */
export function commitPaintFork(
  ov: ScopeOverlay,
  parent: { fills: readonly Paint[]; strokes: readonly StrokeStyle[] },
  before: { fills: readonly Paint[]; strokes: readonly StrokeStyle[] },
  after: { fills: Paint[]; strokes: StrokeStyle[] },
): void {
  const fork = (
    list: "fills" | "strokes",
    inherited: readonly { id: string }[],
    was: readonly { id: string }[],
    now: readonly { id: string }[],
  ) => {
    if (sameEntries(was, now)) return;
    if (list === "fills") ov.added.fills = (now as Paint[]).map((e) => detach(e));
    else ov.added.strokes = (now as StrokeStyle[]).map((e) => detach(e));
    const drop = new Set(ov.removed);
    for (const e of inherited) drop.add(e.id);
    ov.removed = [...drop];
    const prefix = list === "fills" ? "fill." : "stroke.";
    for (const path of Object.keys(ov.props)) {
      const e = entryOfPath(path);
      if (path.startsWith(prefix) && e && drop.has(e.id)) delete ov.props[path];
    }
  };
  fork("fills", parent.fills, before.fills, after.fills);
  fork("strokes", parent.strokes, before.strokes, after.strokes);
}

/**
 * Drop every override in one domain (the section-level "revert"). The parent
 * says which removed ids belong to the domain: a forked fill list has dropped
 * every inherited fill by id, and handing those back is the only way the
 * section is actually inherited again — clearing `added` alone would leave the
 * scope painting nothing.
 */
export function clearOverlayDomain(ov: ScopeOverlay, domain: OverrideDomain, parent: ResolvedScope): void {
  for (const path of Object.keys(ov.props)) {
    if (domainOfPath(path) === domain) delete ov.props[path];
  }
  const restore = (entries: readonly { id: string }[]) => {
    const ids = new Set(entries.map((e) => e.id));
    ov.removed = ov.removed.filter((id) => !ids.has(id));
  };
  if (domain === "effects") {
    ov.added.effects = [];
    restore(parent.effects);
  }
  if (domain === "fill") {
    ov.added.fills = [];
    restore(parent.fills);
  }
  if (domain === "stroke") {
    ov.added.strokes = [];
    restore(parent.strokes);
  }
  if (domain === "textEffects") {
    ov.added.textEffects = [];
    restore(parent.style.textEffects);
  }
}

export { emptyOverlay };
export type { ScopeOverlay };

/** The payload a fresh range/focus carries. */
export function emptyRangePayload(): Pick<StyleRange, "overlay" | "animation" | "sounds"> {
  return { overlay: emptyOverlay(), animation: null, sounds: {} };
}

/** A caption state with nothing overridden — what "Reset" restores. */
export function emptyCaptionState(): CaptionStateStyle {
  return { overlay: emptyOverlay(), animation: null, scale: 1 };
}
