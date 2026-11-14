import type { MotionDocument, Clip, GroupClip, KeyframeTrack, KeyframeValue, LayoutSpec, VisualClip } from "../schema";
import { sampledScaleY } from "../animation/uniform-scale";
import { DEFAULT_LAYOUT_ITEM } from "../schema";
import { sampleKeyframes } from "../animation/keyframes";
import { MIN_SHAPE_EXTENT, setClipProperty } from "../animation/paths";
import type { LayerBox } from "../transform-map";
import { clipNaturalSize, memberCorners } from "../timeline/ops";

/**
 * AUTO LAYOUT — the engine, and the bake that puts its answer on the clips.
 *
 * `solveLayout` is pure: a spec and a list of members with sizes go in, a box
 * and a slot per member come out. Nothing in it knows what a clip is, which is
 * what makes it testable to the pixel and what will let a Figma-import, a
 * plugin or a template generator lay things out without a document in hand.
 *
 * `resolveLayoutInDocument` is the bake — the same shape as driver baking: the
 * solved positions are written into each member's own `transform.x/y` (and a
 * filled member's own width) in the resolved document, and the member's now
 * dead position keys are dropped, so no surface has to know a layout exists.
 * See `relations/resolve.ts` for why baking rather than reading through.
 *
 * ## The two spaces, stated once
 *
 * A member's stored position is COMP SPACE — the space every group's members
 * already live in (`group-space.ts`: a group's transform is a DELTA on top).
 * So the container box is a comp-space rectangle with its top-left at `layout.x/y`, the
 * solver hands out comp-space slots, and the group's own delta is applied by
 * the ordinary chain afterwards. Dragging, rotating or scaling a laid-out
 * group never touches the layout at all.
 *
 * A slot is the member's AXIS-ALIGNED BOX — what it occupies after its own
 * rotation and scale, translation removed (`memberFootprint`). Placing a member
 * means putting that box's top-left at the slot's top-left, which for a leaf
 * writes `x = slot.x − footprint.minX` and for a nested group writes exactly
 * the same expression into its delta. One line for both, because a footprint
 * is defined at zero translation for both.
 */

// ── The pure engine ──────────────────────────────────────────────────────────

/** One thing the container arranges. Sizes are the member's FOOTPRINT. */
export interface LayoutMember {
  id: string;
  width: number;
  height: number;
  fillX: boolean;
  fillY: boolean;
  /** Opted out: keeps its own coordinates, takes no slot. */
  absolute: boolean;
  /** Bounds a FILL slot is clamped to. Absent = unbounded. */
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
  /**
   * The size it cannot be squeezed below along each axis — its own size when
   * it does not fill; for a filled TEXT, the height its lines need at the
   * width it was given (words wrap, lines do not vanish). Absent: a filled
   * member's floor is its min (or nothing), a fixed one's is its size.
   */
  floorWidth?: number;
  floorHeight?: number;
}

/** What a member cannot be made smaller than, along an axis. */
function floorOf(m: LayoutMember, x: boolean): number {
  if (x) return m.floorWidth ?? (m.fillX ? (m.minWidth ?? 0) : m.width);
  return m.floorHeight ?? (m.fillY ? (m.minHeight ?? 0) : m.height);
}

function clampTo(v: number, min: number | null | undefined, max: number | null | undefined): number {
  if (min != null) v = Math.max(min, v);
  if (max != null) v = Math.min(max, v);
  return v;
}

/** A hugging axis, bounded: content size held between the spec's min and max. */
function hugged(content: number, pad: number, min: number | null, max: number | null): number {
  const outer = clampTo(content + pad, min, max);
  return Math.max(0, outer - pad);
}

/** Where a member's footprint goes: top-left and size, container space. */
export interface LayoutSlot {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  /** The container box, comp space, top-left at `spec.x/y`. */
  x: number;
  y: number;
  width: number;
  height: number;
  slots: LayoutSlot[];
}

/** Which axis flows. `wrap` is a row that breaks; `grid` is rows of columns. */
function mainIsX(flow: LayoutSpec["flow"]): boolean {
  return flow !== "column";
}

interface Line {
  items: LayoutMember[];
  /** Sum of item main sizes, no gaps. */
  main: number;
  /** Tallest item across. */
  cross: number;
}

/** Split members into flow lines. */
function lines(spec: LayoutSpec, items: LayoutMember[], innerMain: number | null): Line[] {
  const mx = mainIsX(spec.flow);
  const mainOf = (m: LayoutMember) => (mx ? m.width : m.height);
  const crossOf = (m: LayoutMember) => (mx ? m.height : m.width);
  const out: Line[] = [];
  const push = (list: LayoutMember[]) => {
    let main = 0;
    let cross = 0;
    for (const m of list) {
      main += mainOf(m);
      cross = Math.max(cross, crossOf(m));
    }
    out.push({ items: list, main, cross });
  };
  if (spec.flow === "grid") {
    const n = Math.max(1, spec.columns);
    for (let i = 0; i < items.length; i += n) push(items.slice(i, i + n));
    if (items.length === 0) push([]);
    return out;
  }
  if (spec.flow === "wrap" && innerMain !== null) {
    let cur: LayoutMember[] = [];
    let used = 0;
    for (const m of items) {
      const w = mainOf(m);
      const next = cur.length === 0 ? w : used + spec.gap + w;
      if (cur.length > 0 && next > innerMain + 1e-6) {
        push(cur);
        cur = [m];
        used = w;
      } else {
        cur.push(m);
        used = next;
      }
    }
    push(cur);
    return out;
  }
  push(items);
  return out;
}

function alignOffset(align: LayoutSpec["alignX"], slack: number): number {
  return align === "start" ? 0 : align === "end" ? slack : slack / 2;
}

/**
 * THE SOLVE. Members are placed in order along the flow; a line that hugs is as
 * long as its items plus gaps, a fixed one aligns or spreads them; fill items
 * take the slack on a fixed axis and their natural size on a hugging one (a
 * fill inside a hug is a hug — Figma's rule, because there is nothing to fill).
 */
export function solveLayout(spec: LayoutSpec, members: readonly LayoutMember[]): LayoutResult {
  const items = members.filter((m) => !m.absolute);
  const mx = mainIsX(spec.flow);
  const pad = spec.padding;
  const padMain = mx ? pad.left + pad.right : pad.top + pad.bottom;
  const padCross = mx ? pad.top + pad.bottom : pad.left + pad.right;
  const fixedMain = mx ? spec.width : spec.height;
  const fixedCross = mx ? spec.height : spec.width;
  const innerMainFixed = fixedMain === null ? null : Math.max(0, fixedMain - padMain);
  const innerCrossFixed = fixedCross === null ? null : Math.max(0, fixedCross - padCross);

  const mainOf = (m: LayoutMember) => (mx ? m.width : m.height);
  const crossOf = (m: LayoutMember) => (mx ? m.height : m.width);
  const fillMain = (m: LayoutMember) => (mx ? m.fillX : m.fillY);
  const fillCross = (m: LayoutMember) => (mx ? m.fillY : m.fillX);

  const ls = lines(spec, items, innerMainFixed);
  const gap = spec.gap;

  // ── Grid: column widths and row heights are shared across the sheet. ──
  if (spec.flow === "grid") {
    const cols = Math.max(1, spec.columns);
    const colW = new Array<number>(cols).fill(0);
    const rowH = ls.map(() => 0);
    ls.forEach((line, r) => {
      line.items.forEach((m, c) => {
        colW[c] = Math.max(colW[c]!, m.width);
        rowH[r] = Math.max(rowH[r]!, m.height);
      });
    });
    const usedCols = Math.min(cols, Math.max(1, ...ls.map((l) => l.items.length)));
    const contentW = colW.slice(0, usedCols).reduce((a, b) => a + b, 0) + gap * (usedCols - 1);
    const contentH = rowH.reduce((a, b) => a + b, 0) + spec.lineGap * Math.max(0, ls.length - 1);
    // A box that does not clip is never smaller than what it holds — see below.
    const floorW = colW.slice(0, usedCols).map((_, c) => Math.max(0, ...ls.map((l) => (l.items[c] ? floorOf(l.items[c]!, true) : 0)))).reduce((a, b) => a + b, 0) + gap * (usedCols - 1);
    const floorH = ls.map((l) => Math.max(0, ...l.items.map((m) => floorOf(m, false)))).reduce((a, b) => a + b, 0) + spec.lineGap * Math.max(0, ls.length - 1);
    const grow = !spec.clipContent;
    const innerW = spec.width === null ? hugged(contentW, pad.left + pad.right, spec.minWidth, spec.maxWidth) : Math.max(0, spec.width - pad.left - pad.right, grow ? floorW : 0);
    const innerH = spec.height === null ? hugged(contentH, pad.top + pad.bottom, spec.minHeight, spec.maxHeight) : Math.max(0, spec.height - pad.top - pad.bottom, grow ? floorH : 0);
    // Slack on a fixed axis goes to the columns / rows evenly when any item in
    // them fills; otherwise the whole sheet is aligned as one block.
    const fillCols = colW.slice(0, usedCols).map((_, c) => ls.some((l) => l.items[c]?.fillX));
    const fillRows = rowH.map((_, r) => ls[r]!.items.some((m) => m.fillY));
    const nFillCols = fillCols.filter(Boolean).length;
    const nFillRows = fillRows.filter(Boolean).length;
    const extraW = nFillCols > 0 ? Math.max(0, innerW - contentW) / nFillCols : 0;
    const extraH = nFillRows > 0 ? Math.max(0, innerH - contentH) / nFillRows : 0;
    const cw = colW.slice(0, usedCols).map((w, c) => w + (fillCols[c] ? extraW : 0));
    const rh = rowH.map((h, r) => h + (fillRows[r] ? extraH : 0));
    const sheetW = cw.reduce((a, b) => a + b, 0) + gap * (usedCols - 1);
    const sheetH = rh.reduce((a, b) => a + b, 0) + spec.lineGap * Math.max(0, ls.length - 1);
    const width = innerW + pad.left + pad.right;
    const height = innerH + pad.top + pad.bottom;
    const left = spec.x + pad.left + alignOffset(spec.alignX, innerW - sheetW);
    const top = spec.y + pad.top + alignOffset(spec.alignY, innerH - sheetH);
    const slots: LayoutSlot[] = [];
    let y = top;
    ls.forEach((line, r) => {
      let x = left;
      line.items.forEach((m, c) => {
        const w = m.fillX ? clampTo(cw[c]!, m.minWidth, m.maxWidth) : m.width;
        const h = m.fillY ? clampTo(rh[r]!, m.minHeight, m.maxHeight) : m.height;
        slots.push({
          id: m.id,
          x: x + alignOffset(spec.alignX, cw[c]! - w),
          y: y + alignOffset(spec.alignY, rh[r]! - h),
          width: w,
          height: h,
        });
        x += cw[c]! + gap;
      });
      y += rh[r]! + spec.lineGap;
    });
    return { x: spec.x, y: spec.y, width, height, slots };
  }

  // ── Row / column / wrap ──
  const lineLen = (l: Line) => l.main + gap * Math.max(0, l.items.length - 1);
  const contentMain = Math.max(0, ...ls.map(lineLen));
  const contentCross = ls.reduce((a, l) => a + l.cross, 0) + spec.lineGap * Math.max(0, ls.length - 1);
  const minMain = mx ? spec.minWidth : spec.minHeight;
  const maxMain = mx ? spec.maxWidth : spec.maxHeight;
  const minCross = mx ? spec.minHeight : spec.minWidth;
  const maxCross = mx ? spec.maxHeight : spec.maxWidth;
  // A FIXED SIZE IS HONOURED UNTIL THE CONTENT NEEDS MORE. A box that does not
  // clip never lets what it holds spill out of it: type another line into a
  // fixed-height card and the card grows to hold it, the way the text itself
  // would have. Only what cannot shrink counts — a filled member can be made
  // as small as its minimum, a filled text as narrow as it likes (it wraps),
  // but never shorter than its lines. Clip content is how you ask for spill.
  const grow = !spec.clipContent;
  const floorMain = Math.max(0, ...ls.map((l) => l.items.reduce((a, m) => a + floorOf(m, mx), 0) + gap * Math.max(0, l.items.length - 1)));
  const floorCross = ls.reduce((a, l) => a + Math.max(0, ...l.items.map((m) => floorOf(m, !mx))), 0) + spec.lineGap * Math.max(0, ls.length - 1);
  const innerMain = innerMainFixed === null ? hugged(contentMain, padMain, minMain, maxMain) : grow ? Math.max(innerMainFixed, floorMain) : innerMainFixed;
  const innerCross = innerCrossFixed === null ? hugged(contentCross, padCross, minCross, maxCross) : grow ? Math.max(innerCrossFixed, floorCross) : innerCrossFixed;
  // A single line in a fixed cross axis fills that axis; wrapped lines keep
  // their own heights and the block aligns as a whole.
  const crossFixedSingle = innerCrossFixed !== null && ls.length === 1;

  const width = (mx ? innerMain : innerCross) + pad.left + pad.right;
  const height = (mx ? innerCross : innerMain) + pad.top + pad.bottom;
  const left = spec.x + pad.left;
  const top = spec.y + pad.top;
  const originMain = mx ? left : top;
  const originCross = mx ? top : left;
  const alignMain = mx ? spec.alignX : spec.alignY;
  const alignCross = mx ? spec.alignY : spec.alignX;

  const slots: LayoutSlot[] = [];
  let crossCursor = originCross + (crossFixedSingle ? 0 : alignOffset(alignCross, innerCross - contentCross));
  for (const line of ls) {
    const lineCross = crossFixedSingle ? innerCross : line.cross;
    // Main-axis fill: share the slack among fill items. A hugging axis has
    // slack only when a minimum held it open — then it is spent the same way.
    const slack = Math.max(0, innerMain - lineLen(line));
    const nFill = slack > 1e-6 ? line.items.filter(fillMain).length : 0;
    const fillExtra = nFill > 0 ? slack / nFill : 0;
    // On a FIXED axis a fill member's size is its SHARE of the room the others
    // leave — not its own size plus leftovers. A paragraph whose one line is
    // wider than the box must wrap to its share, never push the box open.
    const fills = line.items.filter(fillMain);
    const share =
      innerMainFixed !== null && fills.length > 0
        ? Math.max(0, innerMain - line.items.filter((m) => !fillMain(m)).reduce((a, m) => a + mainOf(m), 0) - gap * Math.max(0, line.items.length - 1)) / fills.length
        : null;
    const spread = spec.spaceBetween && nFill === 0 && line.items.length > 1 && slack > 1e-6;
    const stepGap = spread ? gap + slack / (line.items.length - 1) : gap;
    let cursor = originMain + (nFill > 0 || spread ? 0 : alignOffset(alignMain, slack));
    for (const m of line.items) {
      const main = fillMain(m)
        ? clampTo(share ?? mainOf(m) + fillExtra, mx ? m.minWidth : m.minHeight, mx ? m.maxWidth : m.maxHeight)
        : mainOf(m);
      const cross = fillCross(m)
        ? clampTo(lineCross, mx ? m.minHeight : m.minWidth, mx ? m.maxHeight : m.maxWidth)
        : crossOf(m);
      const crossPos = crossCursor + alignOffset(alignCross, lineCross - cross);
      slots.push(
        mx
          ? { id: m.id, x: cursor, y: crossPos, width: main, height: cross }
          : { id: m.id, x: crossPos, y: cursor, width: cross, height: main },
      );
      cursor += main + stepGap;
    }
    crossCursor += lineCross + spec.lineGap;
  }
  return { x: spec.x, y: spec.y, width, height, slots };
}

// ── From clips to members and back ───────────────────────────────────────────

/** The layout spec with its keyframed numbers sampled at the group's local time. */
export function sampledLayout(group: GroupClip, localMs: number): LayoutSpec | null {
  const base = group.layout;
  if (!base) return null;
  const kf = sampleKeyframes(group.keyframes, localMs);
  return applyLayoutSample(base, kf);
}

/** `layout.<field>` / `layout.padding.<side>` values folded onto a spec. */
export function applyLayoutSample(base: LayoutSpec, kf: Record<string, KeyframeValue>): LayoutSpec {
  const n = (k: string, d: number) => (typeof kf[k] === "number" ? (kf[k] as number) : d);
  const size = (k: string, d: number | null) => (typeof kf[k] === "number" ? Math.max(1, kf[k] as number) : d);
  return {
    ...base,
    x: n("layout.x", base.x),
    y: n("layout.y", base.y),
    width: size("layout.width", base.width),
    height: size("layout.height", base.height),
    gap: Math.max(0, n("layout.gap", base.gap)),
    lineGap: Math.max(0, n("layout.lineGap", base.lineGap)),
    padding: {
      top: Math.max(0, n("layout.padding.top", base.padding.top)),
      right: Math.max(0, n("layout.padding.right", base.padding.right)),
      bottom: Math.max(0, n("layout.padding.bottom", base.padding.bottom)),
      left: Math.max(0, n("layout.padding.left", base.padding.left)),
    },
  };
}

/** The clips on a group's rows, bottom row first — the layout order. */
export function layoutMembersOf(doc: MotionDocument, group: GroupClip): VisualClip[] {
  const out: VisualClip[] = [];
  for (let i = doc.tracks.length - 1; i >= 0; i--) {
    const track = doc.tracks[i]!;
    if (track.groupId !== group.id) continue;
    for (const clip of track.clips) {
      if (clip.kind === "audio" || clip.kind === "adjustment") continue;
      out.push(clip);
    }
  }
  return out;
}

/**
 * A member's FOOTPRINT: the axis-aligned box it occupies after its own
 * rotation, scale and shear, with its translation set to zero. `minX/minY` is
 * what a slot's top-left is matched against.
 */
export function memberFootprint(clip: VisualClip, box: LayerBox): { minX: number; minY: number; width: number; height: number } {
  const zero = { ...clip, transform: { ...clip.transform, x: 0, y: 0 } };
  const corners = memberCorners(zero, box);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x);
    maxY = Math.max(maxY, c.y);
  }
  return { minX, minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

/** Is this clip arranged by a layout right now? */
export function isLayoutMember(doc: MotionDocument, clipId: string): GroupClip | null {
  for (const track of doc.tracks) {
    if (!track.groupId || !track.clips.some((c) => c.id === clipId)) continue;
    const g = findGroup(doc, track.groupId);
    return g?.layout ? g : null;
  }
  return null;
}

function findGroup(doc: MotionDocument, id: string): GroupClip | null {
  for (const track of doc.tracks) for (const clip of track.clips) if (clip.id === id && clip.kind === "group") return clip;
  return null;
}

const layoutMemo = new WeakMap<MotionDocument, boolean>();

/** True when any group in the document carries a layout. Memoised per document. */
export function documentHasLayout(doc: MotionDocument): boolean {
  let hit = layoutMemo.get(doc);
  if (hit === undefined) {
    hit = doc.tracks.some((t) => t.clips.some((c) => c.kind === "group" && c.layout !== null));
    layoutMemo.set(doc, hit);
  }
  return hit;
}

/**
 * THE CONTAINER BOX at rest — what `clipNaturalSize` reports for a laid-out
 * group, and the box its fill paints and its pivot is a fraction of. Solved
 * from the members' rest boxes so the answer is a property of the document,
 * not of an instant; the resolved document's members carry their instant's
 * values in their base slots, so asking it the same question gives the
 * instant's box.
 */
export function layoutBoxOf(doc: MotionDocument, group: GroupClip, depth = 0): LayerBox | null {
  if (!group.layout || depth > 32) return null;
  const r = solveGroup(doc, group, group.layout, depth);
  return { width: Math.max(1, r.width), height: Math.max(1, r.height), cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}

/**
 * Solve one group from its members' current boxes.
 *
 * TWICE when a filled text is involved, because its height depends on the
 * width the layout gives it: the first solve decides the widths, each filled
 * text is re-measured wrapped at its slot's width, and the second solve sizes
 * the box around the lines that actually result. That is what lets a box
 * narrowed by its padding re-wrap its paragraph and grow taller to hold it.
 */
function solveGroup(doc: MotionDocument, group: GroupClip, spec: LayoutSpec, depth: number): LayoutResult {
  const clips = layoutMembersOf(doc, group);
  const first = solveLayout(spec, clips.map((c) => layoutMember(doc, c, depth, null)));
  const rewrap = new Map<string, number>();
  for (const c of clips) {
    if (c.kind !== "text" || !c.layoutItem?.fillX || c.path) continue;
    const slot = first.slots.find((s) => s.id === c.id);
    const sx = Math.abs(c.transform.scale) || 1;
    if (slot && Math.abs(slot.width / sx - (c.maxWidth ?? -1)) > 0.5) rewrap.set(c.id, Math.max(1, slot.width / sx));
  }
  if (rewrap.size === 0) return first;
  return solveLayout(spec, clips.map((c) => layoutMember(doc, c, depth, rewrap.get(c.id) ?? null)));
}

/** One clip as the solver sees it. `wrapAt` re-measures a filled text at that width. */
function layoutMember(doc: MotionDocument, clip: VisualClip, depth: number, wrapAt: number | null): LayoutMember {
  const item = clip.layoutItem ?? DEFAULT_LAYOUT_ITEM;
  // A text on a path has no box of its own; it rides its host, which IS laid out.
  const absent = clip.kind === "text" && clip.path !== null;
  // A text inside a layout is measured by its WORDS on any axis the layout
  // owns: wrapped at the width it is given, as tall as its lines.
  // Never the stored box: filling, a text's width is the layout's (or its
  // words', where the box hugs — a fill inside a hug is a hug), and its height
  // is its lines'.
  const measured =
    clip.kind === "text" && (item.fillX || item.fillY)
      ? { ...clip, maxWidth: item.fillX ? wrapAt : clip.maxWidth, maxHeight: null }
      : clip;
  const box = memberBox(doc, measured, depth);
  const fp = box ? memberFootprint(clip, box) : { minX: 0, minY: 0, width: 0, height: 0 };
  return {
    id: clip.id,
    width: fp.width,
    height: fp.height,
    fillX: item.fillX,
    fillY: item.fillY,
    absolute: item.absolute || absent || !box,
    minWidth: item.minWidth,
    maxWidth: item.maxWidth,
    minHeight: item.minHeight,
    maxHeight: item.maxHeight,
    ...(clip.kind === "text" && item.fillY ? { floorHeight: fp.height } : {}),
  };
}

/** A member's box: a nested container solves itself; everything else measures. */
function memberBox(doc: MotionDocument, clip: VisualClip, depth: number): LayerBox | null {
  if (clip.kind === "group" && clip.layout) return layoutBoxOf(doc, clip, depth + 1);
  return clipNaturalSize(doc, clip);
}

/**
 * THE BAKE. Every laid-out group in the comp is solved at `timeMs` and its
 * members' positions (and filled sizes) are written into the returned
 * document. Members are written by identity, so a member of two nested
 * containers is written once by the inner (its position inside) and the inner
 * container is written once by the outer (its delta) — the two compose through
 * the ordinary group chain.
 *
 * Two passes, because sizes flow UP (a hugging container is as big as its
 * members) and positions flow DOWN (a member is where its container says).
 * Sizes are read from the members' base slots of the WORKING document, which
 * already carry this instant's sampled values for anything an earlier bake
 * wrote — so a filled text's wrap width is what its container gave it before
 * its own height is measured.
 */
export function resolveLayoutInDocument(doc: MotionDocument, timeMs: number, frameId?: string | null): MotionDocument {
  const groups: GroupClip[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "group" && clip.layout && (!frameId || clip.frameId === frameId)) groups.push(clip);
    }
  }
  if (groups.length === 0) return doc;

  // Work on a shallow-cloned document whose touched clips are fresh objects;
  // a lane nothing in it changed goes back out by reference (`touched`).
  const clipOf = new Map<string, Clip>();
  const touched = new Set<number>();
  const tracks = doc.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => c) }));
  const work: MotionDocument = { ...doc, tracks };
  const replace = (id: string, next: Clip) => {
    for (let ti = 0; ti < work.tracks.length; ti++) {
      const t = work.tracks[ti]!;
      const i = t.clips.findIndex((c) => c.id === id);
      if (i >= 0) {
        t.clips[i] = next;
        clipOf.set(id, next);
        touched.add(ti);
        return;
      }
    }
  };
  const fresh = (clip: Clip): Clip => {
    const seen = clipOf.get(clip.id);
    if (seen) return seen;
    const copy = cloneClip(clip);
    replace(clip.id, copy);
    return copy;
  };

  // Outer containers first so a nested container's own sample (its declared
  // centre, keyed gap…) is in place before the outer reads its box.
  const ordered = groups.slice().sort((a, b) => nestDepth(work, a) - nestDepth(work, b));
  for (const raw of ordered) {
    const localMs = Math.max(0, Math.min(raw.durationMs - 1e-3, timeMs - raw.startMs));
    const spec = applyLayoutSample(raw.layout!, sampleKeyframes(raw.keyframes, localMs));
    const group = fresh(raw) as GroupClip;
    group.layout = spec;
    group.keyframes = group.keyframes.filter((t) => !t.property.startsWith("layout."));
  }

  // Solve deepest first so a nested container is sized before its parent
  // places it, and a filled width lands before the height that depends on it.
  const deepestFirst = ordered.slice().reverse();
  for (const raw of deepestFirst) {
    const group = clipOf.get(raw.id) as GroupClip;
    bakeGroup(work, group, fresh, timeMs);
  }
  return { ...doc, tracks: work.tracks.map((t, i) => (touched.has(i) ? t : doc.tracks[i]!)) };
}

function bakeGroup(work: MotionDocument, group: GroupClip, fresh: (c: Clip) => Clip, timeMs: number): void {
  const spec = group.layout!;
  const members = layoutMembersOf(work, group);
  // Sample each member's transform at its own time so a keyed scale changes
  // the footprint the solver sees.
  const at = new Map<string, VisualClip>();
  for (const raw of members) {
    const localMs = Math.max(0, Math.min(raw.durationMs - 1e-3, timeMs - raw.startMs));
    const kf = sampleKeyframes(raw.keyframes, localMs);
    const m = fresh(raw) as VisualClip;
    const n = (k: string, d: number) => (typeof kf[k] === "number" ? (kf[k] as number) : d);
    const t = m.transform;
    m.transform = {
      ...t,
      scale: n("scale", t.scale),
      scaleY: sampledScaleY(kf, t.scaleY),
      rotation: n("rotation", t.rotation),
      skewX: n("skewX", t.skewX),
      skewY: n("skewY", t.skewY),
      anchor: { x: n("anchor.x", t.anchor.x), y: n("anchor.y", t.anchor.y) },
    };
    if (m.kind === "shape") {
      m.width = Math.max(MIN_SHAPE_EXTENT, n("width", m.width));
      m.height = Math.max(MIN_SHAPE_EXTENT, n("height", m.height));
    }
    at.set(raw.id, m);
  }
  const result = solveGroup(work, group, spec, 0);
  for (const slot of result.slots) {
    const m = at.get(slot.id);
    if (!m) continue;
    const item = m.layoutItem ?? DEFAULT_LAYOUT_ITEM;
    // Fill: the member's own size becomes the slot's, then its footprint is
    // re-measured with that size so the placement below lands exactly.
    if (item.fillX || item.fillY) applyFill(m, slot, item);
    const box = memberBox(work, m, 0);
    if (!box) continue;
    const fp = memberFootprint(m, box);
    m.transform = { ...m.transform, x: slot.x - fp.minX, y: slot.y - fp.minY };
    // The container OWNS these now — a surviving key would overwrite the bake.
    const dead = new Set(["x", "y"]);
    if (item.fillX) dead.add("width").add("maxWidth");
    if (item.fillY) dead.add("height").add("maxHeight");
    m.keyframes = m.keyframes.filter((t) => t.range || !dead.has(t.property));
  }
  // Bake output is immutable, like the document it came from — so the
  // per-clip memos downstream (outlines, layouts) may remember it.
  for (const m of at.values()) Object.freeze(m);
}

/** Give a filled member the slot's size, per kind. Kinds with a fixed intrinsic
 *  box (media, a nested comp) keep it — fill on those is a no-op, stated. */
function applyFill(m: VisualClip, slot: LayoutSlot, item: { fillX: boolean; fillY: boolean }): void {
  const sx = Math.abs(m.transform.scale) || 1;
  const sy = Math.abs(m.transform.scaleY ?? m.transform.scale) || 1;
  if (m.kind === "shape" || m.kind === "raster") {
    if (item.fillX) setClipProperty(m, "width", Math.max(1, slot.width / sx));
    if (item.fillY) setClipProperty(m, "height", Math.max(1, slot.height / sy));
  } else if (m.kind === "text") {
    if (item.fillX) m.maxWidth = Math.max(1, slot.width / sx);
    if (item.fillY) m.maxHeight = Math.max(1, slot.height / sy);
  } else if (m.kind === "group" && m.layout) {
    if (item.fillX) m.layout = { ...m.layout, width: Math.max(1, slot.width / sx) };
    if (item.fillY) m.layout = { ...m.layout, height: Math.max(1, slot.height / sy) };
  }
}

function nestDepth(doc: MotionDocument, group: GroupClip): number {
  let depth = 0;
  let id: string | null = group.id;
  while (id) {
    const track = doc.tracks.find((t) => t.clips.some((c) => c.id === id));
    id = track?.groupId ?? null;
    if (id) depth++;
    if (depth > 64) break;
  }
  return depth;
}

function cloneClip<T extends Clip>(clip: T): T {
  return typeof structuredClone === "function" ? structuredClone(clip) : (JSON.parse(JSON.stringify(clip)) as T);
}
