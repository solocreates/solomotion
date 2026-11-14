import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetIds,
  addToRegion,
  absentEditors,
  changeEditor,
  closeEditor,
  defaultWorkspace,
  findRegion,
  fitsMinSizes,
  floatEditor,
  hostOf,
  insertAtEdge,
  joinRegions,
  layoutRects,
  migrateFromLegacy,
  normalise,
  parseWorkspace,
  regionOf,
  regions,
  returnHome,
  serialise,
  setSizes,
  splitRegion,
  type Workspace,
} from "../layout-tree";

const RECT = { x: 0, y: 0, width: 1600, height: 1000 };

beforeEach(() => _resetIds());

const sumSizes = (ws: Workspace): boolean => {
  const ok = (n: Workspace["root"]): boolean =>
    n.kind === "region" ||
    (Math.abs(n.children.reduce((a, c) => a + c.size, 0) - 1) < 1e-9 && n.children.length > 1 && n.children.every((c) => ok(c.node)));
  return ok(ws.root);
};

describe("default layout = today's layout", () => {
  it("uses the old resizable ids so saved sizes restore", () => {
    const ws = defaultWorkspace();
    expect(ws.root.id).toBe("tm-vertical");
    expect(regions(ws.root).map((r) => r.id)).toEqual(["left", "stage", "inspector", "timeline"]);
  });

  it("lays out like the old 68/32 × 17/61/24 split (normalised)", () => {
    const rects = layoutRects(defaultWorkspace().root, RECT);
    expect(rects.get("timeline")!.height).toBeCloseTo(320);
    expect(rects.get("left")!.width).toBeCloseTo((1600 * 17) / 102);
    expect(rects.get("inspector")!.x + rects.get("inspector")!.width).toBeCloseTo(1600);
  });

  it("puts Layers first and active in the left region (D10)", () => {
    const left = findRegion(defaultWorkspace(), "left")!;
    expect(left.editors[0]).toBe("layers");
    expect(left.active).toBe("layers");
  });
});

describe("migration", () => {
  it("an existing user opens to the same left tab, sizes and floating panels", () => {
    const ws = migrateFromLegacy({
      leftTab: "media",
      vertical: [60, 40],
      horizontal: [20, 55, 25],
      floating: [{ panelId: "agents", x: 10, y: 20, width: 380, height: 600 }],
    });
    expect(findRegion(ws, "left")!.active).toBe("media");
    const rects = layoutRects(ws.root, RECT);
    expect(rects.get("timeline")!.height).toBeCloseTo(400);
    expect(rects.get("left")!.width).toBeCloseTo(320);
    expect(hostOf(ws, "agents")).toBe("floating");
    expect(ws.floating[0].home.regionId).toBe("left");
  });

  it("ignores a left tab that no longer exists", () => {
    expect(findRegion(migrateFromLegacy({ leftTab: "nope" }), "left")!.active).toBe("layers");
  });
});

describe("normalise", () => {
  it("drops empty regions and single-child splits, flattens same-axis splits", () => {
    const ws = normalise({
      version: 1,
      floating: [],
      windows: [],
      root: {
        kind: "split",
        id: "a",
        axis: "row",
        children: [
          { size: 1, node: { kind: "region", id: "x", editors: [], active: "layers", rail: null } },
          {
            size: 1,
            node: {
              kind: "split",
              id: "b",
              axis: "row",
              children: [
                { size: 1, node: { kind: "region", id: "s", editors: ["stage"], active: "stage", rail: null } },
                { size: 1, node: { kind: "region", id: "l", editors: ["layers"], active: "layers", rail: null } },
              ],
            },
          },
        ],
      },
    });
    expect(ws.root.kind).toBe("split");
    if (ws.root.kind !== "split") return;
    expect(ws.root.children.map((c) => c.node.id)).toEqual(["s", "l"]);
    expect(sumSizes(ws)).toBe(true);
  });

  it("dedupes editors and restores a lost stage", () => {
    const ws = normalise({
      version: 1,
      floating: [{ editor: "layers", bounds: { x: 0, y: 0, width: 1, height: 1 }, home: { regionId: "q", index: 0, edge: "left" } }],
      windows: [],
      root: { kind: "region", id: "q", editors: ["layers", "layers", "media"], active: "media", rail: null },
    });
    expect(regionOf(ws, "stage")).toBeTruthy();
    expect(ws.floating).toHaveLength(0); // layers is docked already
    expect(findRegion(ws, "q")!.editors).toEqual(["layers", "media"]);
  });

  it("is idempotent", () => {
    const ws = splitRegion(defaultWorkspace(), "stage", "right", "curves");
    expect(normalise(normalise(ws))).toEqual(normalise(ws));
  });
});

describe("ops", () => {
  it("split puts the editor on the requested edge and keeps neighbour sizes", () => {
    const before = layoutRects(defaultWorkspace().root, RECT);
    const ws = splitRegion(defaultWorkspace(), "stage", "right", "curves");
    const rects = layoutRects(ws.root, RECT);
    const curves = regionOf(ws, "curves")!;
    const stage = rects.get("stage")!;
    const c = rects.get(curves.id)!;
    expect(c.x).toBeCloseTo(stage.x + stage.width);
    expect(c.width).toBeCloseTo(stage.width);
    // Same axis as the parent → sibling; left and inspector untouched.
    expect(rects.get("left")!.width).toBeCloseTo(before.get("left")!.width);
    expect(rects.get("inspector")!.width).toBeCloseTo(before.get("inspector")!.width);
    expect(findRegion(ws, "timeline")!.editors).not.toContain("curves");
    expect(sumSizes(ws)).toBe(true);
  });

  it("split across the parent axis nests a new split", () => {
    const ws = splitRegion(defaultWorkspace(), "left", "bottom", "media");
    const rects = layoutRects(ws.root, RECT);
    const m = rects.get(regionOf(ws, "media")!.id)!;
    const l = rects.get("left")!;
    expect(m.x).toBeCloseTo(l.x);
    expect(m.y).toBeCloseTo(l.y + l.height);
  });

  it("moving the only editor out of a region removes the region", () => {
    let ws = splitRegion(defaultWorkspace(), "stage", "right", "curves");
    const id = regionOf(ws, "curves")!.id;
    ws = addToRegion(ws, "inspector", "curves");
    expect(findRegion(ws, id)).toBeUndefined();
    expect(findRegion(ws, "inspector")!.active).toBe("curves");
  });

  it("the stage is never closed", () => {
    const ws = closeEditor(defaultWorkspace(), "stage");
    expect(regionOf(ws, "stage")).toBeTruthy();
  });

  it("window-edge insert spans the full height", () => {
    const ws = insertAtEdge(defaultWorkspace(), "right", "agents");
    const r = layoutRects(ws.root, RECT).get(regionOf(ws, "agents")!.id)!;
    expect(r.height).toBeCloseTo(1000);
    expect(r.x + r.width).toBeCloseTo(1600);
  });

  it("join merges rails", () => {
    let ws = splitRegion(defaultWorkspace(), "stage", "right", "curves");
    ws = joinRegions(ws, "inspector", regionOf(ws, "curves")!.id);
    expect(findRegion(ws, "inspector")!.editors).toEqual(["inspector", "curves"]);
  });

  it("change editor replaces the active one in place; stage region gains instead", () => {
    let ws = changeEditor(defaultWorkspace(), "inspector", "agents");
    expect(findRegion(ws, "inspector")!.editors).toEqual(["agents"]);
    expect(absentEditors(ws)).toContain("inspector");
    ws = changeEditor(ws, "stage", "media");
    expect(findRegion(ws, "stage")!.editors).toContain("stage");
  });

  it("setSizes renormalises", () => {
    const ws = setSizes(defaultWorkspace(), "tm-vertical", [3, 1]);
    expect(layoutRects(ws.root, RECT).get("timeline")!.height).toBeCloseTo(250);
  });
});

describe("hosts + HOME memory", () => {
  it("float then return lands at the same index of the same region", () => {
    let ws = floatEditor(defaultWorkspace(), "media", { x: 0, y: 0, width: 300, height: 400 }, RECT);
    expect(findRegion(ws, "left")!.editors).not.toContain("media");
    ws = returnHome(ws, "media");
    expect(findRegion(ws, "left")!.editors.indexOf("media")).toBe(2);
    expect(hostOf(ws, "media")).toBe("docked");
  });

  it("returns to the remembered edge when the home region is gone", () => {
    let ws = splitRegion(defaultWorkspace(), "inspector", "right", "curves");
    ws = floatEditor(ws, "curves", { x: 0, y: 0, width: 300, height: 400 }, RECT);
    expect(ws.floating[0].home.edge).toBe("right");
    ws = returnHome(ws, "curves");
    const r = layoutRects(ws.root, RECT).get(regionOf(ws, "curves")!.id)!;
    expect(r.x + r.width).toBeCloseTo(1600);
  });
});

describe("serialise", () => {
  it("round-trips and rejects garbage", () => {
    const ws = splitRegion(defaultWorkspace(), "left", "bottom", "media");
    expect(parseWorkspace(serialise(ws))).toEqual(normalise(ws));
    expect(parseWorkspace("{bad")).toBeNull();
    expect(parseWorkspace(JSON.stringify({ version: 2, root: {} }))).toBeNull();
  });

  it("drops editors removed from the registry", () => {
    const raw = JSON.stringify({
      version: 1,
      root: { kind: "region", id: "s", editors: ["stage", "ghost"], active: "ghost", rail: null },
      floating: [],
      windows: [],
    });
    const ws = parseWorkspace(raw)!;
    expect(findRegion(ws, "s")!.editors).toEqual(["stage"]);
    expect(findRegion(ws, "s")!.active).toBe("stage");
  });
});

describe("min sizes", () => {
  it("default layout fits a 1280×800 window but not a 400px one", () => {
    expect(fitsMinSizes(defaultWorkspace().root, { x: 0, y: 0, width: 1280, height: 800 })).toBe(true);
    expect(fitsMinSizes(defaultWorkspace().root, { x: 0, y: 0, width: 400, height: 800 })).toBe(false);
  });
});
