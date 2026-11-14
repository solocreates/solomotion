import { describe, expect, it } from "vitest";
import { layoutSpecSchema, type LayoutSpec } from "../schema";
import { setKeyframe } from "../animation/keyframes";
import { createEmptyDocument, createGroupClip, createShapeClip, createTrack } from "../factories";
import { clipNaturalSize } from "../timeline/ops";
import { moveClipsToScope } from "../timeline/groups";
import { layoutBoxOf, resolveLayoutInDocument, solveLayout, type LayoutMember } from "./layout";
import { resolveDocumentRelations } from "./resolve";
import * as ops from "./layout-ops";
import { bakeRelationsToKeys } from "./bake";
import { groupClips as groupClipsOp } from "../timeline/groups";
import { createTextClip } from "../factories";
import type { GroupClip, ShapeClip, TextClip } from "../schema";

const spec = (over: Partial<LayoutSpec> = {}): LayoutSpec =>
  layoutSpecSchema.parse({ gap: 10, lineGap: 10, padding: { top: 5, right: 5, bottom: 5, left: 5 }, ...over });

const m = (id: string, width: number, height: number, over: Partial<LayoutMember> = {}): LayoutMember => ({
  id, width, height, fillX: false, fillY: false, absolute: false, ...over,
});

const at = (r: ReturnType<typeof solveLayout>, id: string) => r.slots.find((s) => s.id === id)!;

describe("solveLayout — row", () => {
  it("hugs: width = items + gaps + padding, centred on x/y", () => {
    const r = solveLayout(spec({ x: 55, y: 35 }), [m("a", 30, 20), m("b", 40, 10)]);
    expect(r.width).toBe(30 + 10 + 40 + 10);
    expect(r.height).toBe(20 + 10);
    // Left edge = 55 + pad 5.
    expect(at(r, "a").x).toBe(60);
    expect(at(r, "b").x).toBe(60 + 30 + 10);
    // Cross-centred by default: the shorter item sits 5 lower.
    expect(at(r, "a").y).toBe(35 + 5);
    expect(at(r, "b").y).toBe(35 + 5 + 5);
  });

  it("cross alignment start / end", () => {
    const start = solveLayout(spec({ alignY: "start" }), [m("a", 30, 20), m("b", 40, 10)]);
    expect(at(start, "b").y).toBe(at(start, "a").y);
    const end = solveLayout(spec({ alignY: "end" }), [m("a", 30, 20), m("b", 40, 10)]);
    expect(at(end, "b").y).toBe(at(end, "a").y + 10);
  });

  it("fixed width aligns the packed line, or spreads it", () => {
    const packed = solveLayout(spec({ width: 200, alignX: "end" }), [m("a", 30, 20), m("b", 40, 10)]);
    // Right edge of b = right inner edge = 200 − 5.
    expect(at(packed, "b").x + 40).toBe(195);
    const spread = solveLayout(spec({ width: 200, spaceBetween: true }), [m("a", 30, 20), m("b", 40, 10)]);
    expect(at(spread, "a").x).toBe(5);
    expect(at(spread, "b").x + 40).toBe(195);
  });

  it("fill members share the room equally on a fixed axis, and hug where the box hugs", () => {
    const r = solveLayout(spec({ width: 200 }), [m("a", 30, 20, { fillX: true }), m("b", 40, 10, { fillX: true })]);
    // Figma's Fill: an equal share of what the fixed members and gaps leave,
    // whatever each one's own size — inner 190, one gap of 10 → 90 each.
    expect(at(r, "a").width).toBe(90);
    expect(at(r, "b").width).toBe(90);
    const hug = solveLayout(spec(), [m("a", 30, 20, { fillX: true })]);
    expect(at(hug, "a").width).toBe(30);
    // Cross fill takes the line height in a fixed cross axis.
    const cross = solveLayout(spec({ height: 100 }), [m("a", 30, 20, { fillY: true })]);
    expect(at(cross, "a").height).toBe(90);
  });

  it("a minimum holds a hugging axis open, and the slack is spent like a fixed one", () => {
    const r = solveLayout(spec({ minWidth: 200, alignX: "center" }), [m("a", 30, 20)]);
    expect(r.width).toBe(200);
    expect(at(r, "a").x).toBe(85);
    const filled = solveLayout(spec({ minWidth: 200 }), [m("a", 30, 20, { fillX: true, maxWidth: 100 })]);
    expect(at(filled, "a").width).toBe(100);
  });

  it("absolute members take no slot", () => {
    const r = solveLayout(spec(), [m("a", 30, 20), m("pin", 500, 500, { absolute: true })]);
    expect(r.width).toBe(40);
    expect(r.slots.map((s) => s.id)).toEqual(["a"]);
  });

  it("an empty container is just its padding", () => {
    const r = solveLayout(spec(), []);
    expect(r.width).toBe(10);
    expect(r.height).toBe(10);
  });
});

describe("solveLayout — column, wrap, grid", () => {
  it("column flows down", () => {
    const r = solveLayout(spec({ flow: "column" }), [m("a", 30, 20), m("b", 40, 10)]);
    expect(r.height).toBe(20 + 10 + 10 + 10);
    expect(r.width).toBe(50);
    expect(at(r, "b").y).toBe(at(r, "a").y + 20 + 10);
    expect(at(r, "b").x).toBe(at(r, "a").x - 5);
  });

  it("wrap breaks lines at the fixed width and stacks them by lineGap", () => {
    const r = solveLayout(spec({ flow: "wrap", width: 100, lineGap: 4, alignX: "start", alignY: "start" }), [
      m("a", 40, 10), m("b", 40, 10), m("c", 40, 10),
    ]);
    // inner 90: a + gap + b = 90 fits; c wraps.
    expect(at(r, "b").y).toBe(at(r, "a").y);
    expect(at(r, "c").y).toBe(at(r, "a").y + 10 + 4);
    expect(at(r, "c").x).toBe(at(r, "a").x);
    expect(r.height).toBe(10 + 4 + 10 + 10);
  });

  it("grid shares column widths and row heights", () => {
    const r = solveLayout(spec({ flow: "grid", columns: 2, alignX: "start", alignY: "start" }), [
      m("a", 10, 10), m("b", 50, 10), m("c", 30, 40), m("d", 10, 10),
    ]);
    // col 0 = 30, col 1 = 50; row 0 = 10, row 1 = 40.
    expect(r.width).toBe(30 + 10 + 50 + 10);
    expect(r.height).toBe(10 + 10 + 40 + 10);
    expect(at(r, "b").x).toBe(at(r, "a").x + 30 + 10);
    expect(at(r, "c").y).toBe(at(r, "a").y + 10 + 10);
    expect(at(r, "d").x).toBe(at(r, "b").x);
  });
});

describe("the bake", () => {
  function scene() {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const a = createShapeClip({ frameId, shape: "rect", startMs: 0, x: 0, y: 0, width: 30, height: 20 }) as ShapeClip;
    const b = createShapeClip({ frameId, shape: "rect", startMs: 0, x: 0, y: 0, width: 40, height: 10 }) as ShapeClip;
    const group = createGroupClip({ frameId, startMs: 0, durationMs: 3000, layout: spec({ x: 55, y: 35 }) });
    const laneG = createTrack("group");
    laneG.clips.push(group);
    const laneA = createTrack("a");
    laneA.clips.push(a);
    const laneB = createTrack("b");
    laneB.clips.push(b);
    doc.tracks.push(laneG, laneB, laneA);
    moveClipsToScope(doc, [a.id, b.id], group.id);
    return { doc, group, a, b };
  }
  const find = (doc: ReturnType<typeof createEmptyDocument>, id: string) => doc.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;

  it("the container's natural box is the solved box", () => {
    const { doc, group } = scene();
    expect(layoutBoxOf(doc, group)).toEqual({ width: 90, height: 30, cx: 100, cy: 50 });
    expect(clipNaturalSize(doc, group)).toEqual({ width: 90, height: 30, cx: 100, cy: 50 });
  });

  it("members are placed by the row, bottom row first, and lose their position keys", () => {
    const { doc, group, a, b } = scene();
    setKeyframe(a.keyframes, "x", 0, 999);
    const resolved = resolveLayoutInDocument(doc, 0);
    const ra = find(resolved, a.id) as ShapeClip;
    const rb = find(resolved, b.id) as ShapeClip;
    // Row order: `a` was moved first so it sits on the LOWER row → first slot.
    // A rect is centred on its x, so its centre is slot.x + w/2.
    expect(ra.transform.x).toBeCloseTo(60 + 15);
    expect(rb.transform.x).toBeCloseTo(100 + 20);
    expect(ra.keyframes.find((k) => k.property === "x")).toBeUndefined();
    // Untouched: the group's own clip identity changes (its sample is baked) but
    // an unrelated lane survives by reference.
    expect(resolved.tracks[0]).toBe(doc.tracks[0]);
    expect(find(resolved, group.id)).not.toBe(group);
  });

  it("a keyframed gap reflows per instant", () => {
    const { doc, group, b } = scene();
    setKeyframe(group.keyframes, "layout.gap", 0, 10);
    setKeyframe(group.keyframes, "layout.gap", 1000, 50, { kind: "linear" });
    const x0 = (find(resolveDocumentRelations(doc, 0), b.id) as ShapeClip).transform.x;
    const x1 = (find(resolveDocumentRelations(doc, 1000), b.id) as ShapeClip).transform.x;
    // The box's corner stays; the second member moves by the whole gap change.
    expect(x1 - x0).toBeCloseTo(40);
  });

  it("a filled shape takes the slot's width", () => {
    const { doc, group, a } = scene();
    group.layout = spec({ x: -150, y: -20, width: 300 });
    a.layoutItem = { ...a.layoutItem, fillX: true };
    const ra = find(resolveLayoutInDocument(doc, 0), a.id) as ShapeClip;
    // inner 290, content 80 → slack 210 → a = 240.
    expect(ra.width).toBe(240);
  });

  it("a scaled member occupies its scaled footprint", () => {
    const { doc, a, b } = scene();
    a.transform.scale = 2;
    const rb = find(resolveLayoutInDocument(doc, 0), b.id) as ShapeClip;
    // a is 60 wide now: b's centre = left(55 + 5) + 60 + 10 + 20.
    expect(rb.transform.x).toBeCloseTo(55 + 5 + 60 + 10 + 20);
  });

  it("nests: an inner container hugs, the outer places it", () => {
    const { doc, group, a, b } = scene();
    const frameId = doc.frames[0]!.id;
    const inner = createGroupClip({ frameId, startMs: 0, durationMs: 3000, layout: spec({ x: -20, y: -5, padding: { top: 0, right: 0, bottom: 0, left: 0 }, gap: 0 }) });
    const lane = createTrack("inner");
    lane.clips.push(inner);
    doc.tracks.push(lane);
    moveClipsToScope(doc, [inner.id], group.id);
    moveClipsToScope(doc, [b.id], inner.id);
    // inner = b alone = 40×10, laid at group's second slot.
    expect(layoutBoxOf(doc, inner)!.width).toBe(40);
    const resolved = resolveLayoutInDocument(doc, 0);
    const ri = find(resolved, inner.id) as GroupClip;
    const rb = find(resolved, b.id) as ShapeClip;
    // Outer: a(30) gap b-container(40) → width 90, same as before.
    expect(layoutBoxOf(resolved, find(resolved, group.id) as GroupClip)!.width).toBe(90);
    // The inner container is placed by its DELTA: box top-left at (−20,−5) at
    // rest, slot top-left at (60 + 30 + 10, …): delta.x = 100 − (−20).
    expect(ri.transform.x).toBeCloseTo(120);
    // And b sits at the inner's declared centre; the chain adds the delta later.
    expect(rb.transform.x).toBeCloseTo(0);
    expect(a.id).toBeTruthy();
  });
});

describe("the ops", () => {
  const { addAutoLayout, removeAutoLayout, reorderLayoutMember, wrapTextInShape, inferLayout } = ops;
  function row() {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const a = createShapeClip({ frameId, shape: "rect", startMs: 0, x: -100, y: 0, width: 40, height: 40 }) as ShapeClip;
    const b = createShapeClip({ frameId, shape: "rect", startMs: 0, x: 0, y: 0, width: 40, height: 40 }) as ShapeClip;
    const c = createShapeClip({ frameId, shape: "rect", startMs: 0, x: 100, y: 0, width: 40, height: 40 }) as ShapeClip;
    // Deliberately out of spatial order in z: c, a, b (top → bottom).
    for (const clip of [c, a, b]) {
      const lane = createTrack(clip.id);
      lane.clips.push(clip);
      doc.tracks.push(lane);
    }
    const gid = groupClipsOp(doc, [a.id, b.id, c.id])!;
    return { doc, gid, a, b, c };
  }
  const find = (doc: ReturnType<typeof createEmptyDocument>, id: string) => doc.tracks.flatMap((t) => t.clips).find((cl) => cl.id === id)!;

  it("infers a row with the gap the members already have, centred where they are", () => {
    const { doc, gid } = row();
    const spec = inferLayout(doc, find(doc, gid) as GroupClip);
    expect(spec.flow).toBe("row");
    expect(spec.gap).toBe(60);
    expect(spec.x).toBe(-120);
    expect(spec.y).toBe(-20);
  });

  it("adding a layout puts the rows in spatial order and moves nothing", () => {
    const { doc, gid, a, b, c } = row();
    expect(addAutoLayout(doc, gid)).toBe(true);
    const resolved = resolveLayoutInDocument(doc, 0);
    expect((find(resolved, a.id) as ShapeClip).transform.x).toBeCloseTo(-100);
    expect((find(resolved, b.id) as ShapeClip).transform.x).toBeCloseTo(0);
    expect((find(resolved, c.id) as ShapeClip).transform.x).toBeCloseTo(100);
  });

  it("members that already agree on a size fill it, so resizing the box stretches them", () => {
    const { doc, gid, a } = row();
    addAutoLayout(doc, gid);
    expect(a.layoutItem.fillX && a.layoutItem.fillY).toBe(true);
    (find(doc, gid) as GroupClip).layout!.width = 400; // the box resized wider
    const wide = find(resolveLayoutInDocument(doc, 0), a.id) as ShapeClip;
    expect(wide.width).toBeCloseTo((400 - 2 * 60) / 3, 0);
  });

  it("members of different sizes keep them — adding a layout reshapes nothing", () => {
    const { doc, gid, a, b } = row();
    b.width = 80;
    addAutoLayout(doc, gid);
    expect(a.layoutItem.fillX).toBe(false);
    expect(a.layoutItem.fillY).toBe(true);
  });

  it("reordering a member re-seats its row; removing the layout bakes the places", () => {
    const { doc, gid, a, c } = row();
    addAutoLayout(doc, gid);
    expect(reorderLayoutMember(doc, gid, c.id, 0)).toBe(true);
    let resolved = resolveLayoutInDocument(doc, 0);
    expect((find(resolved, c.id) as ShapeClip).transform.x).toBeCloseTo(-100);
    expect((find(resolved, a.id) as ShapeClip).transform.x).toBeCloseTo(0);
    expect(removeAutoLayout(doc, gid, 0)).toBe(true);
    expect((find(doc, gid) as GroupClip).layout).toBeNull();
    expect(c.transform.x).toBeCloseTo(-100);
    resolved = resolveLayoutInDocument(doc, 0);
    expect(resolved).toBe(doc);
  });

  function textInRect(maxWidth: number | null) {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const rect = createShapeClip({ frameId, shape: "rect", startMs: 0, x: 50, y: 20, width: 300, height: 100 }) as ShapeClip;
    rect.cornerRadius = { tl: 12, tr: 12, br: 12, bl: 12 };
    const text = createTextClip({ frameId, text: "Buy", startMs: 0, x: 40, y: 10, presetId: null });
    text.maxWidth = maxWidth;
    text.style.fontSize = 24;
    for (const clip of [text, rect]) {
      const lane = createTrack(clip.id);
      lane.clips.push(clip);
      doc.tracks.push(lane);
    }
    return { doc, rect, text };
  }

  it("text in a rect: the paddings are where the text sits, the box lands on the rect, nothing moves", () => {
    const { doc, rect, text } = textInRect(null);
    const before = { x: text.transform.x, y: text.transform.y };
    const gid = wrapTextInShape(doc, text.id, rect.id)!;
    const group = find(doc, gid) as GroupClip;
    expect(group.borderRadius.tl).toBe(12);
    expect(group.fills).toEqual(rect.fills);
    expect(doc.tracks.flatMap((t) => t.clips).find((cl) => cl.id === rect.id)).toBeUndefined();
    // One line of text: the box hugs both ways, around the text plus its margins.
    expect(group.layout?.width).toBeNull();
    expect(group.layout?.height).toBeNull();
    const box = clipNaturalSize(doc, group)!;
    expect(box.width).toBeCloseTo(300, 0);
    expect(box.height).toBeCloseTo(100, 0);
    const laid = find(resolveLayoutInDocument(doc, 0), text.id) as TextClip;
    expect(laid.transform.x).toBeCloseTo(before.x, 0);
    expect(laid.transform.y).toBeCloseTo(before.y, 0);
  });

  it("a hugging box follows its text: more words, a bigger box", () => {
    const { doc, rect, text } = textInRect(null);
    const gid = wrapTextInShape(doc, text.id, rect.id)!;
    const w0 = clipNaturalSize(doc, find(doc, gid))!.width;
    (find(doc, text.id) as TextClip).text = "Buy it now";
    expect(clipNaturalSize(doc, find(doc, gid))!.width).toBeGreaterThan(w0);
  });

  it("a text BOX fills the rect's width and the box's height hugs the words", () => {
    const { doc, rect, text } = textInRect(120);
    const gid = wrapTextInShape(doc, text.id, rect.id)!;
    const group = find(doc, gid) as GroupClip;
    expect(group.layout?.width).toBe(300);
    expect(group.layout?.height).toBeNull();
    const t = find(doc, text.id) as TextClip;
    expect(t.layoutItem.fillX).toBe(true);
    expect(t.maxHeight).toBeNull();
  });

  it("the box drives its text: resize it or change its padding and the words re-wrap to fit", () => {
    const { doc, rect, text } = textInRect(120);
    const gid = wrapTextInShape(doc, text.id, rect.id)!;
    const group = find(doc, gid) as GroupClip;
    const inner = () => 300 - group.layout!.padding.left - group.layout!.padding.right;
    const wrapWidth = () => (find(resolveLayoutInDocument(doc, 0), text.id) as TextClip).maxWidth;
    expect(wrapWidth()).toBeCloseTo(inner(), 0);
    group.layout!.padding.left += 40;
    expect(wrapWidth()).toBeCloseTo(inner(), 0);
    group.layout!.width = 500;
    expect(wrapWidth()).toBeCloseTo(500 - group.layout!.padding.left - group.layout!.padding.right, 0);
  });

  it("a fixed height holds until the words need more — then the box grows to hold them", () => {
    const { doc, rect, text } = textInRect(120);
    const gid = wrapTextInShape(doc, text.id, rect.id)!;
    ops.setBoxSizing(doc, gid, "y", "fixed");
    const h0 = clipNaturalSize(doc, find(doc, gid))!.height;
    (find(doc, text.id) as TextClip).text = "Buy\nit\nnow\nplease\nsoon";
    expect(clipNaturalSize(doc, find(doc, gid))!.height).toBeGreaterThan(h0);
  });

  it("sizing a hugging button fills its label, so the label follows the button", () => {
    const { doc, rect, text } = textInRect(null);
    const gid = wrapTextInShape(doc, text.id, rect.id)!;
    expect(ops.memberSizing(find(doc, text.id) as TextClip, "x")).toBe("hug");
    ops.setBoxSizing(doc, gid, "x", "fixed");
    expect(ops.memberSizing(find(doc, text.id) as TextClip, "x")).toBe("fill");
  });

  it("removing the layout gives the rectangle back, behind the text", () => {
    const { doc, rect, text } = textInRect(null);
    const gid = wrapTextInShape(doc, text.id, rect.id)!;
    removeAutoLayout(doc, gid, 0);
    const group = find(doc, gid) as GroupClip;
    expect(group.layout).toBeNull();
    expect(group.fills).toHaveLength(0);
    const back = doc.tracks.flatMap((t) => t.clips).find((c) => c.kind === "shape") as ShapeClip;
    expect(back.fills).toEqual(rect.fills);
    expect(back.cornerRadius.tl).toBe(12);
    expect(back.width).toBeCloseTo(300, 0);
  });

  it("fill and hug keep Figma's rule from both sides", () => {
    const { doc, rect, text } = textInRect(120);
    const gid = wrapTextInShape(doc, text.id, rect.id)!;
    // Box to hug on x: the text can't fill a box sized by itself.
    ops.setBoxSizing(doc, gid, "x", "hug");
    expect(ops.memberSizing(find(doc, text.id) as TextClip, "x")).toBe("hug");
    // Text to fill on y while the box hugs y: the box fixes its height first.
    ops.setMemberSizing(doc, text.id, "y", "fill");
    expect((find(doc, gid) as GroupClip).layout?.height).not.toBeNull();
    expect(ops.memberSizing(find(doc, text.id) as TextClip, "y")).toBe("fill");
  });
});

describe("baking relations to keys", () => {
  it("writes per-frame position keys for a member whose gap animates, and drops the layout", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const a = createShapeClip({ frameId, shape: "rect", startMs: 0, x: 0, y: 0, width: 30, height: 20 }) as ShapeClip;
    const b = createShapeClip({ frameId, shape: "rect", startMs: 0, x: 0, y: 0, width: 40, height: 10 }) as ShapeClip;
    const group = createGroupClip({ frameId, startMs: 0, durationMs: 3000, layout: spec({ x: 0, y: 0 }) });
    for (const clip of [group, b, a]) {
      const lane = createTrack(clip.id);
      lane.clips.push(clip);
      doc.tracks.push(lane);
    }
    moveClipsToScope(doc, [a.id, b.id], group.id);
    setKeyframe(group.keyframes, "layout.gap", 0, 10);
    setKeyframe(group.keyframes, "layout.gap", 1000, 50, { kind: "linear" });
    const baked = bakeRelationsToKeys(doc, frameId, 10, 0, 1000);
    const rb = baked.tracks.flatMap((t) => t.clips).find((c) => c.id === b.id) as ShapeClip;
    const xs = rb.keyframes.find((k) => k.property === "x")!;
    expect(xs.keys.length).toBe(11);
    expect(xs.keys[10]!.value as number - (xs.keys[0]!.value as number)).toBeCloseTo(40);
    const rg = baked.tracks.flatMap((t) => t.clips).find((c) => c.id === group.id) as GroupClip;
    expect(rg.layout).toBeNull();
    // `a` never moves: its x is a plain value, no track.
    const ra = baked.tracks.flatMap((t) => t.clips).find((c) => c.id === a.id) as ShapeClip;
    expect(ra.keyframes.find((k) => k.property === "x")).toBeUndefined();
    expect(ra.transform.x).toBeCloseTo(5 + 15);
  });
});
