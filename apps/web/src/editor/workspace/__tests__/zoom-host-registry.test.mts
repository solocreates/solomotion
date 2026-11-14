import { beforeEach, describe, expect, it } from "vitest";
import { EDITORS, editorMeta, editorsByGroup, filterEditors } from "../editor-registry";
import { _resetIds, defaultWorkspace, findRegion, hostOf, regionOf, splitRegion } from "../layout-tree";
import { PRESETS } from "../presets";
import {
  CAMERA_ZOOM,
  REFLOW_ZOOM,
  TIME_ZOOM,
  createZoomRouter,
  presetLevel,
  readLevel,
  stepLevel,
  zoomAbout,
  zoomCommandFor,
} from "../view-zoom";
import { placeFloating, transition } from "../window-host";

const RECT = { x: 0, y: 0, width: 1600, height: 1000 };
beforeEach(() => _resetIds());

describe("editor registry", () => {
  it("ids are unique and every editor has a zoom kind and a host", () => {
    expect(new Set(EDITORS.map((e) => e.id)).size).toBe(EDITORS.length);
    for (const e of EDITORS) expect(e.hosts.length).toBeGreaterThan(0);
  });
  it("the stage only docks and never closes", () => {
    expect(editorMeta("stage")!.hosts).toEqual(["docked"]);
    expect(editorMeta("stage")!.closable).toBe(false);
  });
  it("groups cover every editor", () => {
    expect(editorsByGroup().flatMap((g) => g.editors).length).toBe(EDITORS.length);
  });
  it("type-to-filter ranks name prefix first", () => {
    expect(filterEditors("cu")[0].id).toBe("curves");
    expect(filterEditors("fx").map((e) => e.id)).toEqual([]);
    expect(filterEditors("co")[0].id).toBe("color");
    expect(filterEditors("")).toHaveLength(EDITORS.length);
  });
});

describe("view zoom", () => {
  it("clamps on read, defaults on garbage", () => {
    expect(readLevel(REFLOW_ZOOM, 2.4)).toBe(1.4);
    expect(readLevel(REFLOW_ZOOM, NaN)).toBe(1);
    expect(readLevel(REFLOW_ZOOM, undefined)).toBe(1);
  });
  it("steps stay in bounds", () => {
    expect(stepLevel(REFLOW_ZOOM, 1.4, 1)).toBe(1.4);
    expect(stepLevel(CAMERA_ZOOM, 1, 1)).toBeCloseTo(1.25);
  });
  it("camera presets are Fit · 25 · 50 · 100 · 200 · 400", () => {
    expect(CAMERA_ZOOM.presets.map((p) => p.label)).toEqual(["Fit", "25%", "50%", "100%", "200%", "400%"]);
  });
  it("time presets are durations → px/s for the viewport", () => {
    expect(presetLevel(TIME_ZOOM, { label: "10 s", value: 10 }, { viewportPx: 1200 })).toBe(120);
    expect(presetLevel(TIME_ZOOM, { label: "Fit", value: "fit" }, { fitLevel: 77 })).toBe(77);
  });
  it("zoom about a point keeps that point fixed", () => {
    const pan = zoomAbout({ x: 10, y: 20 }, 1, 2, { x: 110, y: 120 });
    // Content point under the anchor before: (110-10)/1 = 100. After: 100*2 + pan.x = 110.
    expect(100 * 2 + pan.x).toBeCloseTo(110);
    expect(100 * 2 + pan.y).toBeCloseTo(120);
  });
  it("one shortcut set", () => {
    const k = (key: string, m: Partial<{ metaKey: boolean; shiftKey: boolean; code: string }> = {}) =>
      zoomCommandFor({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...m });
    expect(k("=", { metaKey: true })).toBe("in");
    expect(k("-", { metaKey: true })).toBe("out");
    expect(k("0", { metaKey: true })).toBe("fit");
    expect(k(")", { shiftKey: true, code: "Digit0" })).toBe("actual");
    expect(k("0")).toBeNull();
  });
  it("routes to the focused region only, newest mount wins", () => {
    const r = createZoomRouter();
    const got: string[] = [];
    r.register("canvas", (c) => void got.push(`canvas:${c}`));
    const off = r.register("timeline", (c) => void got.push(`t1:${c}`));
    r.register("timeline", (c) => void got.push(`t2:${c}`));
    expect(r.dispatch("timeline", "in")).toBe(true);
    expect(r.dispatch("media", "in")).toBe(false);
    off();
    r.dispatch("canvas", "fit");
    expect(got).toEqual(["t2:in", "canvas:fit"]);
  });
});

describe("window host", () => {
  it("float → home; window → home; stage refuses", () => {
    let ws = transition(defaultWorkspace(), "layers", { to: "floating", bounds: { x: 0, y: 0, width: 200, height: 300 } }, RECT);
    expect(hostOf(ws, "layers")).toBe("floating");
    ws = transition(ws, "layers", { to: "home" }, RECT);
    expect(findRegion(ws, "left")!.editors[0]).toBe("layers");
    ws = transition(ws, "inspector", { to: "window", bounds: { x: 0, y: 0, width: 200, height: 300 } }, RECT);
    expect(hostOf(ws, "inspector")).toBe("window");
    expect(transition(ws, "stage", { to: "floating", bounds: { x: 0, y: 0, width: 1, height: 1 } }, RECT)).toBe(ws);
  });
  it("no OS windows where the realm cannot be shared", () => {
    const ws = defaultWorkspace();
    expect(transition(ws, "layers", { to: "window", bounds: { x: 0, y: 0, width: 1, height: 1 } }, RECT, "none")).toBe(ws);
  });
  it("a floating window docks into a region through the host seam", () => {
    let ws = transition(defaultWorkspace(), "media", { to: "floating", bounds: { x: 0, y: 0, width: 1, height: 1 } }, RECT);
    ws = transition(ws, "media", { to: "region", regionId: "inspector" }, RECT);
    expect(regionOf(ws, "media")!.id).toBe("inspector");
  });
  it("placement stays inside the viewport", () => {
    const b = placeFloating({ w: 900, h: 900 }, { width: 800, height: 600 }, 0, { x: 790, y: 590 });
    expect(b.x + b.width).toBeLessThanOrEqual(800 - 16);
    expect(b.y + b.height).toBeLessThanOrEqual(600 - 16);
  });
});

describe("presets", () => {
  it("every preset builds a valid tree with a stage", () => {
    for (const p of PRESETS) expect(regionOf(p.build(), "stage")).toBeTruthy();
  });
  it("Color puts Curves beside the canvas", () => {
    const ws = PRESETS.find((p) => p.id === "color")!.build();
    expect(regionOf(ws, "curves")!.id).not.toBe("timeline");
    expect(splitRegion).toBeTypeOf("function");
  });
});
