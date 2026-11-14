import { beforeEach, describe, expect, it } from "vitest";
import { applyDrop, resizeGutter, solveDrop } from "../drop-solver";
import { _resetIds, defaultWorkspace, layoutRects, regionOf } from "../layout-tree";

const RECT = { x: 0, y: 0, width: 1600, height: 1000 };
beforeEach(() => _resetIds());

describe("solveDrop", () => {
  const ws = defaultWorkspace();
  const rects = layoutRects(ws.root, RECT);
  const stage = rects.get("stage")!;
  const inspector = rects.get("inspector")!;

  it("preview == result: the result rect is the rect the applied drop lays out", () => {
    const p = { x: stage.x + stage.width - 10, y: stage.y + stage.height / 2 };
    const s = solveDrop(ws, RECT, "curves", p);
    expect(s.target).toEqual({ kind: "split", regionId: "stage", edge: "right" });
    const applied = applyDrop(ws, "curves", s.target)!;
    const real = layoutRects(applied.root, RECT).get(regionOf(applied, "curves")!.id)!;
    expect(s.resultRect).toEqual(real);
  });

  it("region centre adds to its rail", () => {
    const s = solveDrop(ws, RECT, "media", { x: inspector.x + inspector.width / 2, y: inspector.y + inspector.height / 2 });
    expect(s.target).toEqual({ kind: "center", regionId: "inspector" });
    expect(s.resultRect).toEqual(inspector);
  });

  it("the stage centre floats", () => {
    const s = solveDrop(ws, RECT, "media", { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 });
    expect(s.target.kind).toBe("float");
    expect(s.resultRect!.width).toBe(320);
  });

  it("window edges insert a full-length region", () => {
    const s = solveDrop(ws, RECT, "agents", { x: 5, y: 500 });
    expect(s.target).toMatchObject({ kind: "window-edge", edge: "left" });
    expect(s.resultRect!.height).toBeCloseTo(1000);
    expect(s.resultRect!.x).toBe(0);
  });

  it("outside the workspace floats", () => {
    expect(solveDrop(ws, RECT, "agents", { x: -40, y: 500 }).target.kind).toBe("float");
  });

  it("the stage itself cannot be dragged", () => {
    expect(solveDrop(ws, RECT, "stage", { x: 5, y: 500 }).target.kind).toBe("none");
  });

  it("refuses a split that breaks min sizes and falls back to the centre", () => {
    const tiny = { x: 0, y: 0, width: 900, height: 700 };
    const r = layoutRects(ws.root, tiny).get("inspector")!;
    // Inspector is ~212px wide; halving it leaves less than its 240px min.
    // (Its inner edge: the outer one is the window's dock band now.)
    const s = solveDrop(ws, tiny, "agents", { x: r.x + 8, y: r.y + r.height / 2 });
    expect(s.target).toEqual({ kind: "center", regionId: "inspector" });
  });

  it("hysteresis keeps the target near a boundary", () => {
    const edgeX = stage.x + stage.width - Math.min(stage.width * 0.28, 96);
    const a = solveDrop(ws, RECT, "curves", { x: edgeX + 4, y: 300 });
    expect(a.target.kind).toBe("split");
    // 6px past the band (inside hysteresis) — same answer.
    const b = solveDrop(ws, RECT, "curves", { x: edgeX - 6, y: 300 }, { prev: a });
    expect(b.target).toEqual(a.target);
    // Well past it — the centre (which floats on the stage).
    const c = solveDrop(ws, RECT, "curves", { x: edgeX - 60, y: 300 }, { prev: a });
    expect(c.target.kind).toBe("float");
  });

  it("dropping an editor on its own region's centre does nothing", () => {
    const left = rects.get("left")!;
    expect(solveDrop(ws, RECT, "media", { x: left.x + left.width / 2, y: left.y + left.height / 2 }).target.kind).toBe("none");
  });
});

describe("eat the neighbour", () => {
  it("clamps at the neighbour's minimum, then collapses it past half", () => {
    const sizes = [0.5, 0.5];
    const mins = [100, 200];
    const clamp = resizeGutter(sizes, mins, 0, 350, 1000); // b would be 150 < 200
    expect(clamp.collapsed).toBeNull();
    expect(clamp.sizes[1] * 1000).toBeCloseTo(200);
    const eat = resizeGutter(sizes, mins, 0, 450, 1000); // b would be 50 < 100
    expect(eat.collapsed).toBe(1);
    expect(eat.sizes[0]).toBeCloseTo(1);
  });
});
