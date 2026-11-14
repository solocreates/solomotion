import { describe, expect, it } from "vitest";
import {
  baseScope,
  clearOverlayDomain,
  emptyOverlay,
  overlayCount,
  overlayIsEmpty,
  overlayStyle,
  overriddenDomains,
  isOverridden,
  resolveOverlay,
  resolveScope,
  writeStyleToOverlay,
} from "./index";
import { createTextClip } from "../factories";
import { solidPaint } from "../schema";
import { createId } from "../ids";
import { applyRangePatch, styleAt } from "../text/ranges";
import type { TextEffect } from "../schema";
import {
  commitPaintFork,
  entryOfPath,
  overlayTouchesPaints,
  sharedOverlayIn,
  writeOverlayPath,
} from "./index";

const clip = () => {
  const c = createTextClip({ frameId: "f", text: "hello world", startMs: 0 });
  c.fills = [{ ...solidPaint("#ffffff"), id: "fill1" }];
  c.effects = [{ id: "lfx1", type: "blur", enabled: true, radius: 8 }];
  return c;
};

describe("the overlay", () => {
  it("is identity when empty — and hands back the parent's own arrays", () => {
    const c = clip();
    const parent = baseScope(c);
    const out = resolveOverlay(parent, emptyOverlay());
    expect(out).toBe(parent);
    expect(overlayIsEmpty(emptyOverlay())).toBe(true);
    expect(overlayCount(emptyOverlay())).toBe(0);
  });

  it("overrides ONE field of ONE effect and leaves the rest inherited", () => {
    const c = clip();
    const ov = { ...emptyOverlay(), props: { "lfx.lfx1.radius": 40 } };
    const out = resolveOverlay(baseScope(c), ov);
    expect(out.effects[0]).toMatchObject({ id: "lfx1", type: "blur", radius: 40, enabled: true });
    // The parent is untouched — this is the bug the whole model exists to kill.
    expect(c.effects[0]).toMatchObject({ radius: 8 });
  });

  it("adds and removes entries structurally", () => {
    const c = clip();
    const extra = { id: createId("lfx"), type: "shadow" as const, enabled: true, color: "#000", x: 0, y: 4, blur: 8 };
    const ov = { props: {}, removed: ["lfx1"], added: { effects: [extra], fills: [], strokes: [], textEffects: [] } };
    const out = resolveOverlay(baseScope(c), ov);
    expect(out.effects.map((e) => e.id)).toEqual([extra.id]);
    expect(c.effects.map((e) => e.id)).toEqual(["lfx1"]);
  });

  it("keeps a fill patch off the untouched fills", () => {
    const c = clip();
    c.fills.push({ ...solidPaint("#000000"), id: "fill2" });
    const out = resolveOverlay(baseScope(c), { ...emptyOverlay(), props: { "fill.fill1.color": "#ff0000" } });
    expect(out.fills[0]).not.toBe(c.fills[0]);
    // fill2 was not patched, so it is shared rather than copied.
    expect(out.fills[1]).toBe(c.fills[1]);
  });
});

describe("the typographic view", () => {
  it("round-trips a style patch through the flat prop map", () => {
    const ov = emptyOverlay();
    writeStyleToOverlay(ov, { color: "#f00", fontSize: 40 });
    expect(ov.props).toEqual({ color: "#f00", fontSize: 40 });
    expect(overlayStyle(ov)).toEqual({ color: "#f00", fontSize: 40 });
  });

  it("fans the highlight pill into four independent props", () => {
    const ov = emptyOverlay();
    writeStyleToOverlay(ov, { highlight: { color: "#0f0", radius: 8, paddingX: 4, paddingY: 2 } });
    expect(Object.keys(ov.props).sort()).toEqual([
      "highlight.color",
      "highlight.paddingX",
      "highlight.paddingY",
      "highlight.radius",
    ]);
    expect(overlayStyle(ov).highlight).toEqual({ color: "#0f0", radius: 8, paddingX: 4, paddingY: 2 });
  });

  it("hides a half-specified pill from the renderer's view", () => {
    const ov = { ...emptyOverlay(), props: { "highlight.radius": 8 } };
    expect(overlayStyle(ov).highlight).toBeUndefined();
  });

  it("ignores non-typographic props", () => {
    const ov = { ...emptyOverlay(), props: { color: "#f00", "lfx.a.radius": 2, "fill.b.color": "#0f0" } };
    expect(overlayStyle(ov)).toEqual({ color: "#f00" });
  });
});

describe("introspection", () => {
  it("reports the domains a scope touches, and clears one at a time", () => {
    const ov = {
      props: { color: "#f00", "lfx.lfx1.radius": 2, "stroke.s1.width": 3 },
      removed: [],
      added: { effects: [], fills: [], strokes: [], textEffects: [] },
    };
    expect([...overriddenDomains(ov)].sort()).toEqual(["effects", "stroke", "typography"]);
    expect(isOverridden(ov, "color")).toBe(true);
    expect(isOverridden(ov, "fontSize")).toBe(false);

    clearOverlayDomain(ov, "effects", baseScope(clip()));
    expect([...overriddenDomains(ov)].sort()).toEqual(["stroke", "typography"]);
  });
});

describe("scope addressing", () => {
  it("resolves base, focus and range through one call", () => {
    const c = clip();
    const st = () => ({ overlay: emptyOverlay(), animation: null, scale: 1 });
    c.caption = {
      cues: [],
      states: {
        unread: st(),
        focus: { overlay: { ...emptyOverlay(), props: { color: "#0ff" } }, animation: null, scale: 1 },
        read: st(),
      },
      motion: { durationMs: 0, easing: { kind: "linear" }, travel: false },
    };
    c.ranges = [
      { id: "r1", start: 0, end: 5, overlay: { ...emptyOverlay(), props: { fontSize: 99 } }, animation: null, sounds: {} },
    ];
    expect(resolveScope(c, { kind: "base" }).style.color).toBe(c.style.color);
    expect(resolveScope(c, { kind: "caption", state: "focus" }).style.color).toBe("#0ff");
    expect(resolveScope(c, { kind: "range", start: 0, end: 5 }).style.fontSize).toBe(99);
    // A span with no range under it inherits everything.
    expect(resolveScope(c, { kind: "range", start: 6, end: 9 }).style.fontSize).toBe(c.style.fontSize);
  });
});

describe("text effects", () => {
  const glow = (id: string, radius: number): TextEffect => ({
    id,
    type: "glow",
    enabled: true,
    source: "text",
    color: "#ffffff",
    opacity: 1,
    radius,
    intensity: 1,
  });

  it("inherits the layer's passes into a range that adds none", () => {
    const c = clip();
    c.style.textEffects = [glow("g1", 10)];
    c.ranges = [{ id: "r", start: 0, end: 5, overlay: emptyOverlay(), animation: null, sounds: {} }];
    expect(styleAt(c.style, c.ranges, 1).textEffects).toEqual([glow("g1", 10)]);
  });

  it("lets a scope ADD a pass without touching the layer's", () => {
    const c = clip();
    c.style.textEffects = [glow("g1", 10)];
    const ov = { ...emptyOverlay(), added: { effects: [], fills: [], strokes: [], textEffects: [glow("g2", 30)] } };
    c.ranges = [{ id: "r", start: 0, end: 5, overlay: ov, animation: null, sounds: {} }];
    expect(styleAt(c.style, c.ranges, 1).textEffects.map((e) => e.id)).toEqual(["g1", "g2"]);
    // Outside the span, only the layer's own.
    expect(styleAt(c.style, c.ranges, 7).textEffects.map((e) => e.id)).toEqual(["g1"]);
    expect(c.style.textEffects.map((e) => e.id)).toEqual(["g1"]);
  });

  it("patches ONE field of an inherited pass and inherits the rest", () => {
    const c = clip();
    c.style.textEffects = [glow("g1", 10)];
    const ov = { ...emptyOverlay(), props: { "tfx.g1.radius": 44 } };
    c.ranges = [{ id: "r", start: 0, end: 5, overlay: ov, animation: null, sounds: {} }];
    const inside = styleAt(c.style, c.ranges, 1).textEffects[0]!;
    expect(inside).toMatchObject({ id: "g1", radius: 44, intensity: 1 });
    // The layer is untouched, and so is every glyph outside the span.
    expect(c.style.textEffects[0]).toMatchObject({ radius: 10 });
    expect(styleAt(c.style, c.ranges, 7).textEffects[0]).toMatchObject({ radius: 10 });
  });

  it("lets a scope DROP an inherited pass", () => {
    const c = clip();
    c.style.textEffects = [glow("g1", 10)];
    const ov = { ...emptyOverlay(), removed: ["g1"] };
    c.ranges = [{ id: "r", start: 0, end: 5, overlay: ov, animation: null, sounds: {} }];
    expect(styleAt(c.style, c.ranges, 1).textEffects).toEqual([]);
    expect(styleAt(c.style, c.ranges, 7).textEffects.map((e) => e.id)).toEqual(["g1"]);
  });
});

describe("addressing entries", () => {
  it("reads the entry off every path shape, bare solid colour included", () => {
    expect(entryOfPath("fill.p1")).toEqual({ list: "fill", id: "p1" });
    expect(entryOfPath("fill.p1.color")).toEqual({ list: "fill", id: "p1" });
    expect(entryOfPath("stroke.s1.paint.stops.x.color")).toEqual({ list: "stroke", id: "s1" });
    expect(entryOfPath("tfx.g1.radius")).toEqual({ list: "tfx", id: "g1" });
    expect(entryOfPath("color")).toBeNull();
    expect(entryOfPath("highlight.color")).toBeNull();
  });
});

describe("resolving never mutates its inputs", () => {
  it("patches a fill the scope itself ADDED on a copy — the frozen-document bug", () => {
    const c = clip();
    const own = { ...solidPaint("#123456"), id: "own" };
    const ov = { ...emptyOverlay(), added: { effects: [], fills: [own], strokes: [], textEffects: [] } };
    // The bare `fill.<id>` path is the solid colour — the one shape the old
    // "touched" regex missed, so the scope's own fill was written in place.
    ov.props["fill.own"] = "#ff0000";
    Object.freeze(own);
    const out = resolveOverlay(baseScope(c), ov);
    expect(out.fills.map((f) => f.id)).toEqual(["fill1", "own"]);
    expect(out.fills[1]).toMatchObject({ color: "#ff0000" });
    expect(own).toMatchObject({ color: "#123456" });
  });

  it("resolves every typographic key, not just the keyframeable ones", () => {
    const c = clip();
    const ov = { ...emptyOverlay(), props: { decoration: "underline", textCase: "upper", color: "#0f0" } };
    const out = resolveOverlay(baseScope(c), ov);
    expect(out.style).toMatchObject({ decoration: "underline", textCase: "upper", color: "#0f0" });
    // And the per-glyph resolver says the same thing — they are one function.
    c.ranges = [{ id: "r", start: 0, end: 3, overlay: ov, animation: null, sounds: {} }];
    expect(styleAt(c.style, c.ranges, 1)).toEqual(out.style);
  });
});

describe("writing to a scope", () => {
  it("records an override for an inherited entry, but edits its OWN entry in place", () => {
    const ov = emptyOverlay();
    ov.added.fills.push({ ...solidPaint("#000000"), id: "own" });
    writeOverlayPath(ov, "fill.fill1.color", "#ff0000");
    writeOverlayPath(ov, "fill.own.color", "#00ff00");
    writeOverlayPath(ov, "fill.own", "#0000ff");
    expect(ov.props).toEqual({ "fill.fill1.color": "#ff0000" });
    expect(ov.added.fills[0]).toMatchObject({ color: "#0000ff" });
  });

  it("forks only the list that moved, drops the inherited ids, and prunes their props", () => {
    const c = clip();
    const ov = { ...emptyOverlay(), props: { "fill.fill1.color": "#ff0000", "stroke.s1.width": 3 } };
    const before = resolveOverlay(baseScope(c), ov);
    const after = { fills: [...before.fills, { ...solidPaint("#abcdef"), id: "new" }], strokes: before.strokes };
    commitPaintFork(ov, baseScope(c), before, after);
    expect(ov.added.fills.map((f) => f.id)).toEqual(["fill1", "new"]);
    expect(ov.removed).toEqual(["fill1"]);
    expect(ov.props).toEqual({ "stroke.s1.width": 3 });
    expect(ov.added.strokes).toEqual([]);
    // The forked copy carries the colour the person was looking at.
    expect(ov.added.fills[0]).toMatchObject({ color: "#ff0000" });
    // Resolving shows the new list and nothing doubled.
    expect(resolveOverlay(baseScope(c), ov).fills.map((f) => f.id)).toEqual(["fill1", "new"]);
  });

  it("knows which overlays change the paint, so the renderer can skip the rest", () => {
    expect(overlayTouchesPaints({ ...emptyOverlay(), props: { color: "#f00", fontSize: 12 } })).toBe(false);
    expect(overlayTouchesPaints({ ...emptyOverlay(), props: { "fill.p.color": "#f00" } })).toBe(true);
    expect(overlayTouchesPaints({ ...emptyOverlay(), removed: ["fill1"] })).toBe(true);
  });
});

describe("a patch over a span", () => {
  const range = (id: string, start: number, end: number, ov: Partial<ReturnType<typeof emptyOverlay>>) => ({
    id,
    start,
    end,
    overlay: { ...emptyOverlay(), ...ov },
    animation: null,
    sounds: {},
  });

  it("visits each covered range on its own, keeping what they did not share", () => {
    const ranges = [range("a", 0, 3, { props: { color: "#f00" } }), range("b", 3, 6, { props: { fontSize: 40 } })];
    const out = applyRangePatch(ranges, 0, 6, { overlay: (ov) => void (ov.props.italic = true) });
    expect(out.map((r) => [r.start, r.end, r.overlay.props])).toEqual([
      [0, 3, { color: "#f00", italic: true }],
      [3, 6, { fontSize: 40, italic: true }],
    ]);
  });

  it("can REVERT — a delete reaches the stored range", () => {
    const ranges = [range("a", 0, 6, { props: { color: "#f00", italic: true } })];
    const out = applyRangePatch(ranges, 2, 4, { overlay: (ov) => void delete ov.props.color });
    expect(out.map((r) => [r.start, r.end, r.overlay.props])).toEqual([
      [0, 2, { color: "#f00", italic: true }],
      [2, 4, { italic: true }],
      [4, 6, { color: "#f00", italic: true }],
    ]);
    // Reverting the last override prunes the range entirely.
    const gone = applyRangePatch(out, 2, 4, { overlay: (ov) => void delete ov.props.italic });
    expect(gone.map((r) => [r.start, r.end])).toEqual([
      [0, 2],
      [4, 6],
    ]);
  });

  it("does not write through a frozen document", () => {
    const frozen = range("a", 0, 6, { props: { color: "#f00" } });
    Object.freeze(frozen.overlay.props);
    const out = applyRangePatch([frozen], 0, 6, { overlay: (ov) => void (ov.props.color = "#0f0") });
    expect(out[0]!.overlay.props.color).toBe("#0f0");
    expect(frozen.overlay.props.color).toBe("#f00");
  });

  it("shares only what every covered range agrees on", () => {
    const fill = { ...solidPaint("#000"), id: "own" };
    const ranges = [
      range("a", 0, 3, { props: { color: "#f00", italic: true }, added: { effects: [], fills: [fill], strokes: [], textEffects: [] } }),
      range("b", 3, 6, { props: { color: "#f00", italic: false } }),
    ];
    const shared = sharedOverlayIn(ranges, 0, 6)!;
    expect(shared.props).toEqual({ color: "#f00" });
    expect(shared.added.fills).toEqual([]);
    expect(sharedOverlayIn(ranges, 0, 3)!.added.fills).toEqual([fill]);
    // A gap means some glyph inherits everything: nothing is shared.
    expect(sharedOverlayIn(ranges, 0, 8)).toBeUndefined();
  });
});
