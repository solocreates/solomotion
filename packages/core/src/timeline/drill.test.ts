import { describe, it, expect } from "vitest";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { expandSelectionToGroups, groupClips, nextEnterGroup, openGroupChain, retreatEnteredGroup } from "./groups";
import { applyCompositeMode } from "./group-composite";
import { pressHoldsSelection, resolvePressSelection } from "./pick";
import { layerShowsAt } from "./visible-at";
import type { MotionDocument, ShapeClip } from "../schema";

const frameIdOf = (doc: MotionDocument) => doc.frames[0]!.id;

function shapes(doc: MotionDocument, n: number): ShapeClip[] {
  const out: ShapeClip[] = [];
  for (let i = 0; i < n; i++) {
    const clip = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0 }) as ShapeClip;
    clip.durationMs = 1000;
    const lane = createTrack(`lane${i}`);
    lane.clips.push(clip);
    doc.tracks.push(lane);
    out.push(clip);
  }
  return out;
}

/** top-level: [ G1: [ G2: [ G3: [a, b], c ], d ], e ] */
function nested() {
  const doc = createEmptyDocument();
  const [a, b, c, d, e] = shapes(doc, 5) as [ShapeClip, ShapeClip, ShapeClip, ShapeClip, ShapeClip];
  const g1 = groupClips(doc, [a.id, b.id, c.id, d.id])!;
  const g2 = groupClips(doc, [a.id, b.id, c.id])!;
  const g3 = groupClips(doc, [a.id, b.id])!;
  return { doc, a, b, c, d, e, g1, g2, g3 };
}

describe("the drill: open ancestry, gradual retreat", () => {
  it("a click resolves at the deepest OPEN level that holds the clip", () => {
    const { doc, a, c, d, e, g1, g2, g3 } = nested();
    expect(openGroupChain(doc, g3)).toEqual([g3, g2, g1]);
    // Entered three deep: a sibling one level up is picked directly, not its
    // outermost group — and so is a sibling two levels up.
    expect(expandSelectionToGroups(doc, [a.id], g3)).toEqual([a.id]);
    expect(expandSelectionToGroups(doc, [c.id], g3)).toEqual([c.id]);
    expect(expandSelectionToGroups(doc, [d.id], g3)).toEqual([d.id]);
    expect(expandSelectionToGroups(doc, [e.id], g3)).toEqual([e.id]);
    // Entered one deep: the clip three deep resolves to the child on its path.
    expect(expandSelectionToGroups(doc, [a.id], g1)).toEqual([g2]);
    expect(expandSelectionToGroups(doc, [a.id], null)).toEqual([g1]);
  });

  it("the next group to enter is one below the deepest open one", () => {
    const { doc, a, c, g1, g2, g3 } = nested();
    expect(nextEnterGroup(doc, a.id, null)).toBe(g1);
    expect(nextEnterGroup(doc, a.id, g1)).toBe(g2);
    expect(nextEnterGroup(doc, a.id, g2)).toBe(g3);
    expect(nextEnterGroup(doc, a.id, g3)).toBeNull();
    // c sits in g2, which is open while g3 is entered: nothing left to enter.
    expect(nextEnterGroup(doc, c.id, g3)).toBeNull();
  });

  it("retreats one level at a time as the selection moves sideways", () => {
    const { doc, a, c, d, e, g1, g2, g3 } = nested();
    expect(retreatEnteredGroup(doc, g3, [a.id])).toBe(g3);
    expect(retreatEnteredGroup(doc, g3, [c.id])).toBe(g2);
    expect(retreatEnteredGroup(doc, g3, [d.id])).toBe(g1);
    expect(retreatEnteredGroup(doc, g3, [e.id])).toBeNull();
    expect(retreatEnteredGroup(doc, g3, [])).toBeNull();
    // A group selected as a unit is held by itself and by its ancestors.
    expect(retreatEnteredGroup(doc, g3, [g3])).toBe(g3);
    expect(retreatEnteredGroup(doc, g3, [g2])).toBe(g2);
    // Mixed: the deepest open group holding BOTH.
    expect(retreatEnteredGroup(doc, g3, [a.id, d.id])).toBe(g1);
  });

  it("with nothing open, a leaf implies its parents: the context is its innermost common group", () => {
    const { doc, a, c, d, g1, g2, g3 } = nested();
    expect(retreatEnteredGroup(doc, null, [a.id])).toBe(g3);
    expect(retreatEnteredGroup(doc, null, [a.id, c.id])).toBe(g2);
    expect(retreatEnteredGroup(doc, null, [g2])).toBe(g1);
    expect(retreatEnteredGroup(doc, null, [g1])).toBeNull();
    expect(retreatEnteredGroup(doc, null, [d.id])).toBe(g1);
    // A dead entered group (ungrouped under you) falls through to the same rule.
    expect(retreatEnteredGroup(doc, "gone", [a.id])).toBe(g3);
  });
});

describe("press vs. click", () => {
  it("a press on the selection holds it for a drag; a bare click retargets", () => {
    const r = resolvePressSelection(["big"], ["small"], false, true);
    expect(r.selection).toEqual(["big"]);
    expect(r.changed).toBe(false);
    expect(r.onClick).toEqual(["small"]);
  });
  it("a press elsewhere selects now", () => {
    const r = resolvePressSelection(["a"], ["b"], false, false);
    expect(r).toEqual({ selection: ["b"], changed: true, onClick: null });
  });
  it("a press on an already-selected unit changes nothing, click or drag", () => {
    expect(resolvePressSelection(["a", "b"], ["a"], false, true).onClick).toBeNull();
    // The air inside the selection box: nothing to retarget to.
    expect(resolvePressSelection(["a", "b"], [], false, true)).toEqual({ selection: ["a", "b"], changed: false, onClick: null });
  });
  it("⇧ never switches grab priority off: on the selection it holds, and the click toggles", () => {
    // ⇧ on a selected unit → click removes it, drag moves the set.
    expect(resolvePressSelection(["a", "b"], ["a"], true, true)).toEqual({ selection: ["a", "b"], changed: false, onClick: ["b"] });
    // ⇧ on the selection with an unselected layer on top → drag moves the
    // selection alone; only a click adds the top one.
    expect(resolvePressSelection(["big"], ["small"], true, true)).toEqual({ selection: ["big"], changed: false, onClick: ["big", "small"] });
    // ⇧ elsewhere → added now, so the drag carries it.
    expect(resolvePressSelection(["a"], ["c"], true, false)).toEqual({ selection: ["a", "c"], changed: true, onClick: null });
  });
  it("a selected group's members are the selection's pixels", () => {
    const { doc, a, e, g1 } = nested();
    expect(pressHoldsSelection(doc, [a.id], [g1])).toBe(true);
    expect(pressHoldsSelection(doc, [e.id], [g1])).toBe(false);
    expect(pressHoldsSelection(doc, [e.id, a.id], [g1])).toBe(true);
    expect(pressHoldsSelection(doc, [a.id], [])).toBe(false);
  });
});

describe("what a mask leaves showing", () => {
  it("content inside a mask shows only where the stencil is; the stencil is a matte", () => {
    const doc = createEmptyDocument();
    const [stencil, content, below] = shapes(doc, 3) as [ShapeClip, ShapeClip, ShapeClip];
    const gid = applyCompositeMode(doc, [stencil.id, content.id], "mask")!;
    expect(gid).toBeTruthy();
    const probe = (inside: boolean) => ({ painted: () => true, inside: () => inside });
    expect(layerShowsAt(doc, content.id, probe(true))).toEqual({ visible: true, matte: false });
    expect(layerShowsAt(doc, content.id, probe(false))).toEqual({ visible: false, matte: false });
    expect(layerShowsAt(doc, stencil.id, probe(true))).toEqual({ visible: false, matte: true });
    // Outside the group nothing is clipped.
    expect(layerShowsAt(doc, below.id, probe(false))).toEqual({ visible: true, matte: false });
  });
  it("subtract keeps the content OUTSIDE the stencil, and an unpainted stencil cuts nothing", () => {
    const doc = createEmptyDocument();
    const [stencil, content] = shapes(doc, 2) as [ShapeClip, ShapeClip];
    applyCompositeMode(doc, [stencil.id, content.id], "subtract");
    expect(layerShowsAt(doc, content.id, { painted: () => true, inside: () => true }).visible).toBe(false);
    expect(layerShowsAt(doc, content.id, { painted: () => true, inside: () => false }).visible).toBe(true);
    // The renderer paints content plain when its stencil is not on screen.
    expect(layerShowsAt(doc, content.id, { painted: (id) => id !== stencil.id, inside: () => true }).visible).toBe(true);
  });
  it("clips through nested groups: a member of a group that is itself masked", () => {
    const doc = createEmptyDocument();
    const [stencil, x, y] = shapes(doc, 3) as [ShapeClip, ShapeClip, ShapeClip];
    const inner = groupClips(doc, [x.id, y.id])!;
    applyCompositeMode(doc, [stencil.id, inner], "mask");
    expect(layerShowsAt(doc, x.id, { painted: () => true, inside: () => false }).visible).toBe(false);
    expect(layerShowsAt(doc, x.id, { painted: () => true, inside: () => true }).visible).toBe(true);
  });
});
