import type { MotionDocument } from "../schema";
import { groupAncestry, groupClipById, isGroupWithin } from "./groups";
import { modeUsesStencil } from "./group-composite";
import type { LayerUnit, RestackTarget } from "./ops";

/**
 * WHERE A DRAGGED LAYER LANDS — the whole answer, headless.
 *
 * A layers list is a FLAT list of rows drawn at different indents, and a drop
 * has to recover from that flatness three separate facts: which comp, which
 * group, and which z. Only the first is obvious from the row you pointed at.
 * The gap under the last child of a group is genuinely ambiguous — "last thing
 * inside", "next sibling after the group", "after the group's parent too" — and
 * the ONLY input that can disambiguate it is how far right the pointer is, the
 * way Figma does it.
 *
 * That arithmetic used to live in the panel, mixed into DOM measurement, which
 * is why it was wrong in the places nobody re-derived: dragging out of a
 * composite group, dropping between two comps, landing next to a mask stencil.
 * It is a pure function of a row list now — no DOM, no React, no store — so the
 * layers panel, the timeline's lane list and anything that grows a layers list
 * later all resolve a drop the same way, and it can be tested.
 *
 * ## The contract with the caller
 *
 * The caller measures (which gap is the pointer nearest, how far right is it)
 * and renders (the insertion line, the caption). This module decides what the
 * drop MEANS and hands back the exact `RestackTarget` to commit. Nothing here
 * mutates.
 *
 * ## Row order is z order
 *
 * Every rule below assumes the rows arrive in paint order, top first, and that
 * a group's descendants are the rows immediately beneath it. That is what
 * `frameLayerTree` produces and what the renderer composites, so a list built
 * from anything else — sorting a group's members into "stencil" and "content"
 * sections, say — breaks every index in this file and the drop lands somewhere
 * the user did not point at. A role is a BADGE on a row, never a reordering.
 *
 * Indices are `doc.tracks` indices, and a group's rows are z-ordered only
 * among THEMSELVES — so "into the group" is an index among its rows
 * (`interiorTop`) and "after the group" is the lane after its bar in the
 * parent scope. The two never interfere, whatever the array order.
 */

/** One row of a layers list, as far as dropping is concerned. */
export interface LayerDropRow {
  /** The caller's own row key — echoed back so it can find the row again. */
  key: string;
  kind: "frame" | "group" | "clip" | "audio-header";
  /** The comp this row's content lives in — an audio header's is the comp
   *  whose sound it lists. */
  frameId: string | null;
  /** The group holding this row's CONTENT. For a group row: its own parent. */
  parentGroupId: string | null;
  /** A group row's own id — what "into this row" means. */
  groupId: string | null;
  /** Indent as drawn, in levels. */
  depth: number;
  /** The row's lane (z). A group row: its own lane, in its parent's scope. */
  trackIndex: number;
  /**
   * A group row: where a new row is spliced to become the FIRST row of its
   * interior (`GroupLayerNode.interiorTop`). Its rows are z-ordered only among
   * themselves, so this is the one index a drop INTO it needs.
   */
  interiorTop: number;
  /** A shut container — a drop INTO it still lands at the top of its contents. */
  collapsed: boolean;
  /**
   * This row belongs to another comp's timeline and is only being PEEKED here.
   * It is never a drop subject, but it is a perfectly good drop DESTINATION —
   * see `crossComp`.
   */
  inert: boolean;
  /** An audio row: no z of its own in the visual stack and no groups — but
   *  a comp, like any layer: a frame's sound is listed under that frame. */
  audio: boolean;
}

/** A resolved drop: what to run, and what to tell the user it will do. */
export interface LayerDropPlan {
  /** The exact move — hand this straight to `restackUnits`. */
  target: RestackTarget;
  /** Indent the insertion line draws at. */
  depth: number;
  /** The group the units land in; null = the comp's top level. */
  groupId: string | null;
  /** The comp they land in; null when the drop does not change comps. */
  frameId: string | null;
}

/** What the caller measured: the nearest gap, and how far right the pointer is. */
export interface LayerDropQuery {
  /** Index into `rows` of the row that would follow the insertion line. */
  gapIndex: number;
  /** Pointer indent in LEVELS (fractional is fine) — picks among candidates. */
  pointerDepth: number;
  /** The units in flight, so a drop into their own subtree can be refused. */
  units: readonly LayerUnit[];
  /** True when the drag is audio; audio and visual stacks never mix. */
  audio: boolean;
}

/* ─────────────────────────────────────────────────────────────── predicates */

/** The lane at the top of a comp's Audio section — where "into it" lands. */
function firstAudioLane(doc: MotionDocument, rows: readonly LayerDropRow[], frameId: string | null): number {
  const first = rows.find((r) => r.audio && r.frameId === frameId);
  return first?.trackIndex ?? doc.tracks.length;
}

/** Dropping into `groupId` while dragging that group (or an ancestor) cycles. */
function wouldCycle(
  doc: MotionDocument,
  units: readonly LayerUnit[],
  groupId: string | null,
): boolean {
  if (!groupId) return false;
  return units.some(
    (u) => u.kind === "group" && (groupId === u.id || isGroupWithin(doc, groupId, u.id)),
  );
}

/** Does this row sit inside `groupId`, at any depth? */
function rowWithin(doc: MotionDocument, row: LayerDropRow, groupId: string): boolean {
  const chain = row.parentGroupId;
  return !!chain && groupAncestry(doc, chain).includes(groupId);
}

/**
 * The COMPOSITE ROLE a layer takes when it lands in `groupId` beside `neighbour`.
 *
 * A composite group has two sides, and a layer arriving in one needs an answer
 * for which. The answer is "whichever side you dropped it next to" — the layer
 * above at the same level, failing that the one below, failing that content.
 *
 * That is the only rule that survives the list being in z-order, and it is also
 * the one people already expect: you drag a layer under the stencil and it
 * becomes part of the stencil, exactly as dragging under a mask layer does in
 * Figma. The alternative the panel used to run — two fixed sections you dropped
 * INTO — bought this answer by reordering the list, which cost every other
 * index its meaning.
 *
 * `null` for a group with no sides, so `undefined`/`null` leaves roles alone.
 */
function roleBeside(
  doc: MotionDocument,
  groupId: string | null,
  neighbourStencil: boolean | null,
): boolean | null {
  if (!groupId) return null;
  const group = groupClipById(doc, groupId);
  if (!group || !modeUsesStencil(group.mode)) return null;
  return neighbourStencil ?? false;
}

/** The stencil flag of the row, when it is a direct member of `groupId`. */
function stencilOf(
  doc: MotionDocument,
  rows: readonly LayerDropRow[],
  index: number,
  groupId: string | null,
  stencilFor: (key: string) => boolean | null,
): boolean | null {
  if (!groupId) return null;
  for (let i = Math.min(index, rows.length - 1); i >= 0; i--) {
    const row = rows[i]!;
    if (row.parentGroupId !== groupId) continue;
    const flag = stencilFor(row.key);
    if (flag !== null) return flag;
  }
  return null;
}

/* ───────────────────────────────────────────────────────────────── the gaps */

/**
 * Every placement one gap can mean, DEEPEST FIRST.
 *
 * The list is the whole product decision. A gap is a position between two rows
 * and nothing more; what the user meant by it is a function of how far right
 * they are holding the pointer, and the only honest way to offer that is to
 * enumerate the readings and let them aim. Each entry is a COMPLETE placement —
 * comp, group, role and exact z — so the preview and the commit are the same
 * object and can never describe different edits.
 */
export function layerGapCandidates(
  doc: MotionDocument,
  rows: readonly LayerDropRow[],
  query: LayerDropQuery,
  stencilFor: (key: string) => boolean | null = () => null,
): LayerDropPlan[] {
  const { gapIndex, units, audio } = query;

  // The two rows a gap sits between. PEEKED rows (`inert`) count as neighbours
  // and as destinations: a nested comp's layers carry that comp's own frame id
  // and real lanes, so a drop among them is an ordinary restack into another
  // comp — which is exactly what "drag it into the nested comp" should mean.
  const above: LayerDropRow | null = rows[gapIndex - 1] ?? null;
  const below: LayerDropRow | null = rows[gapIndex] ?? null;
  if (!above) return [];

  // Audio has no groups — one flat placement per gap, in the comp whose Audio
  // section the gap is in (so dragging a sound under another frame moves it
  // into that frame).
  if (audio) {
    if (below?.audio) return [flat(below.trackIndex, below.frameId)];
    if (above.audio) return [flat(above.trackIndex + 1, above.frameId)];
    if (above.kind === "audio-header") return [flat(firstAudioLane(doc, rows, above.frameId), above.frameId)];
    return [];
  }
  if (above.audio || above.kind === "audio-header") return [];

  const out: LayerDropPlan[] = [];
  const push = (plan: LayerDropPlan) => {
    if (!wouldCycle(doc, units, plan.groupId)) out.push(plan);
  };

  // ── The deepest reading: directly after the row above ──────────────────────
  if (above.kind === "frame") {
    // The gap under a frame header is the TOP of that comp.
    const first = rows.find((r) => r.kind === "clip" && r.frameId === above!.frameId && !r.audio);
    push({
      target: { trackIndex: first?.trackIndex ?? doc.tracks.length, frameId: above.frameId!, groupId: null },
      depth: above.depth + 1,
      groupId: null,
      frameId: above.frameId,
    });
  } else if (above.kind === "group" && above.groupId) {
    if (!above.collapsed) {
      // First slot INSIDE the group. A composite group has sides, and the top
      // slot is beside its topmost member — so a drop here joins whichever side
      // that member is on, which for a freshly made mask is the stencil.
      const role = roleBeside(doc, above.groupId, stencilOf(doc, rows, gapIndex, above.groupId, stencilFor));
      push({
        target: {
          trackIndex: above.interiorTop,
          frameId: above.frameId!,
          groupId: above.groupId,
          ...(role !== null ? { isStencil: role } : {}),
        },
        depth: above.depth + 1,
        groupId: above.groupId,
        frameId: above.frameId,
      });
    }
    // …or as the group's next sibling — its rows are its own, so "after the
    // group" is simply the lane after its bar in the parent scope.
    push({
      target: { trackIndex: above.trackIndex + 1, frameId: above.frameId!, groupId: above.parentGroupId },
      depth: above.depth,
      groupId: above.parentGroupId,
      frameId: above.frameId,
    });
  } else if (above.kind === "clip") {
    const role = roleBeside(doc, above.parentGroupId, stencilFor(above.key));
    push({
      target: {
        trackIndex: above.trackIndex + 1,
        ...(above.frameId ? { frameId: above.frameId } : {}),
        groupId: above.parentGroupId,
        ...(role !== null ? { isStencil: role } : {}),
      },
      depth: above.depth,
      groupId: above.parentGroupId,
      frameId: above.frameId,
    });
  }

  // ── The exits: every enclosing group that ENDS at this gap ─────────────────
  //
  // One candidate per level, each a step shallower, so a layer six groups deep
  // can be pulled out to any of the seven levels above it by sliding left —
  // without first dropping it somewhere else and dragging again.
  const innermost = above.parentGroupId;
  if (innermost) {
    const groupRow = new Map(rows.filter((r) => r.kind === "group" && !r.inert).map((r) => [r.groupId!, r]));
    for (const gid of groupAncestry(doc, innermost)) {
      if (below && rowWithin(doc, below, gid)) break; // the group continues below
      const row = groupRow.get(gid);
      if (!row) break;
      push({
        target: { trackIndex: row.trackIndex + 1, frameId: row.frameId!, groupId: row.parentGroupId },
        depth: row.depth,
        groupId: row.parentGroupId,
        frameId: row.frameId,
      });
    }
  }

  return out;

  function flat(trackIndex: number, frameId: string | null): LayerDropPlan {
    return {
      target: frameId ? { trackIndex, frameId } : { trackIndex },
      depth: above!.kind === "audio-header" ? above!.depth + 1 : above!.depth,
      groupId: null,
      frameId,
    };
  }
}

/**
 * THE placement a gap means, given where the pointer is horizontally.
 *
 * Nearest depth wins; ties go to the deeper candidate, because the deeper one
 * is what the user had to travel right to ask for and the shallower is what
 * they get by doing nothing.
 */
export function resolveLayerGap(
  doc: MotionDocument,
  rows: readonly LayerDropRow[],
  query: LayerDropQuery,
  stencilFor?: (key: string) => boolean | null,
): LayerDropPlan | null {
  const cands = layerGapCandidates(doc, rows, query, stencilFor);
  if (cands.length === 0) return null;
  let best = cands[0]!;
  let score = Infinity;
  for (const c of cands) {
    const s = Math.abs(c.depth - query.pointerDepth);
    if (s < score) {
      score = s;
      best = c;
    }
  }
  return best;
}

/**
 * A drop ON a container row — the middle band of a frame or a group. It always
 * means "inside, at the top", which is the one reading that needs no aiming and
 * is what every file manager does.
 */
export function resolveLayerInto(
  doc: MotionDocument,
  rows: readonly LayerDropRow[],
  rowKey: string,
  units: readonly LayerUnit[],
  audio: boolean,
): LayerDropPlan | null {
  const row = rows.find((r) => r.key === rowKey);
  if (!row || row.inert) return null;

  if (row.kind === "audio-header") {
    if (!audio) return null;
    const trackIndex = firstAudioLane(doc, rows, row.frameId);
    return {
      target: row.frameId ? { trackIndex, frameId: row.frameId } : { trackIndex },
      depth: row.depth + 1,
      groupId: null,
      frameId: row.frameId,
    };
  }
  if (audio) return null;

  if (row.kind === "frame") {
    const first = rows.find((r) => r.kind === "clip" && r.frameId === row.frameId && !r.audio);
    return {
      target: { trackIndex: first?.trackIndex ?? doc.tracks.length, frameId: row.frameId!, groupId: null },
      depth: row.depth + 1,
      groupId: null,
      frameId: row.frameId,
    };
  }
  if (row.kind === "group" && row.groupId) {
    if (wouldCycle(doc, units, row.groupId)) return null;
    // A composite group takes the drop as CONTENT — the thing being operated on
    // is what people mean by "put this in the mask", and aiming at a stencil
    // member's own gap is how you ask for the other side.
    const group = groupClipById(doc, row.groupId);
    const sides = !!group && modeUsesStencil(group.mode);
    return {
      target: {
        trackIndex: row.interiorTop,
        frameId: row.frameId!,
        groupId: row.groupId,
        ...(sides ? { isStencil: false } : {}),
      },
      depth: row.depth + 1,
      groupId: row.groupId,
      frameId: row.frameId,
    };
  }
  return null;
}

/**
 * What the drop is about to do, in words — the drag caption.
 *
 * Short and specific, because it is read at a glance while a pointer is moving:
 * the destination's name, and only the part of it the user cannot already see
 * from the insertion line. "Top level" rather than a sentence about z-order.
 */
export function describeLayerDrop(doc: MotionDocument, plan: LayerDropPlan): string {
  if (plan.groupId) {
    const group = groupClipById(doc, plan.groupId);
    const where = group?.name || "group";
    if (group && modeUsesStencil(group.mode)) {
      const side = plan.target.isStencil ? "stencil" : "content";
      return `${where} · ${side}`;
    }
    return where;
  }
  if (plan.frameId) {
    const frame = doc.frames.find((f) => f.id === plan.frameId);
    if (frame) return frame.name;
  }
  return "Top level";
}
