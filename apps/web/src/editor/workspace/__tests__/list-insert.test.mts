import { beforeEach, describe, expect, it } from "vitest";
import { fitTabs, solveListInsert } from "../list-insert";
import { applyDrop, dockBand, solveDrop, type DropList, type DropSolution } from "../drop-solver";
import { _resetIds, defaultWorkspace, findRegion, layoutRects, regionOf } from "../layout-tree";

beforeEach(() => _resetIds());

// Three 40px items with 4px gaps, along either axis.
const rowItems = [0, 44, 88].map((x) => ({ x, y: 0, width: 40, height: 28 }));
const colItems = [0, 44, 88].map((y) => ({ x: 0, y, width: 56, height: 40 }));

describe("solveListInsert", () => {
  it("both ends and the middle, on x", () => {
    expect(solveListInsert(rowItems, "x", { x: -30, y: 10 })).toBe(0);
    expect(solveListInsert(rowItems, "x", { x: 10, y: 10 })).toBe(0);
    expect(solveListInsert(rowItems, "x", { x: 30, y: 10 })).toBe(1);
    expect(solveListInsert(rowItems, "x", { x: 70, y: 10 })).toBe(2);
    expect(solveListInsert(rowItems, "x", { x: 500, y: 10 })).toBe(3);
  });

  it("the same on y (a vertical rail) — x is ignored", () => {
    expect(solveListInsert(colItems, "y", { x: 999, y: -5 })).toBe(0);
    expect(solveListInsert(colItems, "y", { x: 999, y: 50 })).toBe(1);
    expect(solveListInsert(colItems, "y", { x: 999, y: 400 })).toBe(3);
  });

  it("solves against the list AS DISPLAYED: items after the badge sit a badge further on", () => {
    // Badge at slot 0 pushes all three 44px down; aiming just above the
    // displayed item 2 (88+44 = 132) means slot 2, not 3.
    expect(solveListInsert(colItems, "y", { x: 0, y: 150 }, 0, 44)).toBe(2);
    // From slot 2, item 1 is back at 44..84: coming back needs crossing its
    // midpoint (64) by more than the hysteresis.
    expect(solveListInsert(colItems, "y", { x: 0, y: 70 }, 2, 44)).toBe(2);
    expect(solveListInsert(colItems, "y", { x: 0, y: 55 }, 2, 44)).toBe(1);
  });

  it("an empty list has one slot", () => {
    expect(solveListInsert([], "y", { x: 0, y: 100 })).toBe(0);
  });

  it("hysteresis: a pointer just past a midpoint keeps the previous slot", () => {
    // Midpoint of item 1 is 64. From slot 1, 4px past it stays; 10px past moves.
    expect(solveListInsert(rowItems, "x", { x: 68, y: 0 }, 1)).toBe(1);
    expect(solveListInsert(rowItems, "x", { x: 74, y: 0 }, 1)).toBe(2);
    // And back the other way.
    expect(solveListInsert(rowItems, "x", { x: 60, y: 0 }, 2)).toBe(2);
    expect(solveListInsert(rowItems, "x", { x: 50, y: 0 }, 2)).toBe(1);
  });
});

describe("fitTabs", () => {
  const full = [80, 90, 70, 100];
  const icon = [28, 28, 28, 28];

  it("names everywhere when there is room", () => {
    expect(fitTabs(full, icon, 1, 400, 2)).toEqual({ collapsed: [false, false, false, false], overflow: false });
  });

  it("inactive tabs fold from the END first", () => {
    // 340 + 6 gap = 346; folding #3 saves 72 → 274.
    expect(fitTabs(full, icon, 0, 300, 2).collapsed).toEqual([false, false, false, true]);
  });

  it("the active tab never folds, even when it is last", () => {
    const r = fitTabs(full, icon, 3, 250, 2);
    expect(r.collapsed[3]).toBe(false);
    expect(r.collapsed.slice(0, 3)).toEqual([false, true, true]);
  });

  it("overflow when even icons do not fit — the strip scrolls", () => {
    expect(fitTabs(full, icon, 3, 100, 2).overflow).toBe(true);
  });
});

describe("solveDrop: rails, the side-dock band, regions", () => {
  const RECT = { x: 64, y: 0, width: 1500, height: 900 };
  const ws = defaultWorkspace();
  const rects = layoutRects(ws.root, RECT);
  // The left rail: 64px outside the workspace, its items Layers · Library · Media.
  const leftRegion = findRegion(ws, "left")!;
  const railItems = leftRegion.editors
    .filter((e) => e !== "agents")
    .map((editor, i) => ({ editor, regionId: "left", index: i, rect: { x: 4, y: 100 + i * 52, width: 56, height: 48 } }));
  const leftRail: DropList = {
    id: "rail:left",
    kind: "rail",
    axis: "y",
    band: { x: 0, y: 0, width: 64, height: 900 },
    edge: "left",
    regionId: null,
    items: railItems,
  };
  const opts = { lists: [leftRail] };

  it("over the rail inserts into the rail at the solved slot, with no rect", () => {
    const s = solveDrop(ws, RECT, "agents", { x: 30, y: 152 + 30 }, opts);
    expect(s.target).toMatchObject({ kind: "list", list: "rail:left", slot: 2, regionId: "left", index: 2 });
    expect(s.resultRect).toBeNull();
    const after = applyDrop(ws, "agents", s.target)!;
    expect(findRegion(after, "left")!.editors.indexOf("agents")).toBe(2);
    expect(findRegion(after, "left")!.active).toBe("agents");
  });

  it("the rail reaches 8px into the workspace, and no further", () => {
    expect(solveDrop(ws, RECT, "curves", { x: 64 + 7, y: 400 }, opts).target.kind).toBe("list");
    expect(solveDrop(ws, RECT, "curves", { x: 64 + 10, y: 400 }, opts).target).toMatchObject({ kind: "window-edge", edge: "left" });
  });

  it("past the reach is the side-dock band, previewed as its real rect", () => {
    const s = solveDrop(ws, RECT, "curves", { x: 64 + 60, y: 400 }, opts);
    expect(s.target).toMatchObject({ kind: "window-edge", edge: "left" });
    expect(s.resultRect!.x).toBe(64);
    expect(s.resultRect!.height).toBeCloseTo(900);
  });

  it("the dock band is 15% of the workspace, capped at 120px", () => {
    expect(dockBand(RECT, "left")).toBe(120);
    expect(dockBand({ x: 0, y: 0, width: 600, height: 400 }, "left")).toBe(90);
    expect(dockBand({ x: 0, y: 0, width: 600, height: 400 }, "bottom")).toBe(60);
    const band = dockBand(RECT, "left");
    // Just inside the band docks; just past it is the left region's own zones.
    expect(solveDrop(ws, RECT, "curves", { x: 64 + band - 2, y: 300 }, opts).target.kind).toBe("window-edge");
    expect(solveDrop(ws, RECT, "curves", { x: 64 + band + 2, y: 300 }, opts).target.kind).not.toBe("window-edge");
  });

  it("inside the dock band the answer is a dock or nothing — never a tab beneath it", () => {
    // A tiny workspace where no dock fits: the band shows nothing.
    const tiny = { x: 64, y: 0, width: 700, height: 500 };
    const s = solveDrop(ws, tiny, "scripts", { x: 64 + 20, y: 200 });
    expect(s.target.kind).toBe("none");
  });

  it("a dock opens wider than its default share when its editor's minimum needs it", () => {
    // 22% of 1332 is 293px; Curves needs 320 plus the gutter.
    const rect = { x: 64, y: 6, width: 1332, height: 858 };
    const s = solveDrop(ws, rect, "curves", { x: 1346, y: 400 }, { gutter: 6.5 });
    expect(s.target.kind).toBe("window-edge");
    expect(s.target.kind).toBe("window-edge");
    expect(s.resultRect!.width).toBeGreaterThanOrEqual(320 - 0.5);
  });

  it("the centre of a region adds a tab", () => {
    const insp = rects.get("inspector")!;
    expect(solveDrop(ws, RECT, "media", { x: insp.x + insp.width / 2, y: insp.y + insp.height / 2 }, opts).target).toEqual({
      kind: "center",
      regionId: "inspector",
    });
  });

  it("hysteresis between bands: rail → dock needs the extra 12px", () => {
    const a = solveDrop(ws, RECT, "curves", { x: 64 + 6, y: 400 }, opts);
    expect(a.target.kind).toBe("list");
    // 10px into the workspace is the dock band cold, but still the rail warm.
    const b = solveDrop(ws, RECT, "curves", { x: 64 + 10, y: 400 }, { ...opts, prev: a });
    expect(b.target.kind).toBe("list");
    const c = solveDrop(ws, RECT, "curves", { x: 64 + 40, y: 400 }, { ...opts, prev: b });
    expect(c.target).toMatchObject({ kind: "window-edge", edge: "left" });
    // And back: the dock band holds 12px past its own boundary into the rail.
    const d = solveDrop(ws, RECT, "curves", { x: 64 + 2, y: 400 }, { ...opts, prev: c });
    expect(d.target.kind).toBe("window-edge");
  });

  it("inside a list the list is kept and only the slot moves", () => {
    const a = solveDrop(ws, RECT, "agents", { x: 30, y: 105 }, opts) as DropSolution;
    expect(a.target).toMatchObject({ kind: "list", slot: 0 });
    const b = solveDrop(ws, RECT, "agents", { x: 30, y: 600 }, { ...opts, prev: a });
    expect(b.target).toMatchObject({ kind: "list", slot: 5, regionId: "left", index: 5 });
  });

  it("an empty rail makes a new region at its edge, switched by that rail", () => {
    const right: DropList = { id: "rail:right", kind: "rail", axis: "y", band: { x: 1564, y: 0, width: 44, height: 900 }, edge: "right", regionId: null, items: [] };
    const s = solveDrop(ws, RECT, "agents", { x: 1580, y: 300 }, { lists: [right] });
    expect(s.target).toMatchObject({ kind: "list", regionId: null, edge: "right" });
    const after = applyDrop(ws, "agents", s.target)!;
    expect(regionOf(after, "agents")!.rail).toBe("right");
  });
});

describe("tab strips: sort, then tear out", () => {
  const RECT = { x: 0, y: 0, width: 1400, height: 900 };
  const ws = defaultWorkspace();
  // A strip at y 300..328 holding two tabs.
  const strip: DropList = {
    id: "strip:r",
    kind: "strip",
    axis: "x",
    band: { x: 400, y: 300, width: 300, height: 28 },
    edge: null,
    regionId: "inspector",
    items: [{ editor: "inspector", regionId: "inspector", index: 0, rect: { x: 404, y: 302, width: 90, height: 24 } }],
  };

  it("a sort wobbles 16px across the strip without tearing", () => {
    const source = { list: "strip:r", torn: false, span: 80 };
    expect(solveDrop(ws, RECT, "media", { x: 500, y: 300 - 14 }, { lists: [strip], source }).target.kind).toBe("list");
    expect(solveDrop(ws, RECT, "media", { x: 500, y: 328 + 14 }, { lists: [strip], source }).target.kind).toBe("list");
    // A quarter-tab past the end still sorts.
    expect(solveDrop(ws, RECT, "media", { x: 700 + 18, y: 310 }, { lists: [strip], source }).target.kind).toBe("list");
    // Past 16px perpendicular it tears out.
    expect(solveDrop(ws, RECT, "media", { x: 500, y: 328 + 20 }, { lists: [strip], source }).target.kind).not.toBe("list");
  });

  it("once torn, the strip is an ordinary band again", () => {
    const source = { list: "strip:r", torn: true, span: 80 };
    expect(solveDrop(ws, RECT, "media", { x: 500, y: 300 - 14 }, { lists: [strip], source }).target.kind).not.toBe("list");
    expect(solveDrop(ws, RECT, "media", { x: 500, y: 310 }, { lists: [strip], source }).target.kind).toBe("list");
  });
});

describe("docking takes its room from the stage", () => {
  it("a left dock keeps Layers' and Properties' widths; the stage shrinks", async () => {
    const { insertAtEdge } = await import("../layout-tree");
    const RECT = { x: 0, y: 0, width: 1500, height: 900 };
    const ws = defaultWorkspace();
    const before = layoutRects(ws.root, RECT);
    const after = insertAtEdge(ws, "left", "curves", 0.22);
    const now = layoutRects(after.root, RECT);
    expect(now.get("left")!.width).toBeCloseTo(before.get("left")!.width, 3);
    expect(now.get("inspector")!.width).toBeCloseTo(before.get("inspector")!.width, 3);
    expect(now.get("stage")!.width).toBeCloseTo(before.get("stage")!.width - 0.22 * 1500, 3);
  });

  it("a second dock on the same side axis still keeps the side columns", async () => {
    const { insertAtEdge } = await import("../layout-tree");
    const RECT = { x: 0, y: 0, width: 1800, height: 900 };
    const once = insertAtEdge(defaultWorkspace(), "right", "curves", 0.15);
    const before = layoutRects(once.root, RECT);
    const twice = insertAtEdge(once, "left", "agents", 0.15);
    const now = layoutRects(twice.root, RECT);
    expect(now.get("left")!.width).toBeCloseTo(before.get("left")!.width, 3);
    expect(now.get("inspector")!.width).toBeCloseTo(before.get("inspector")!.width, 3);
    expect(now.get("stage")!.width).toBeCloseTo(before.get("stage")!.width - 0.15 * 1800, 3);
  });
});
