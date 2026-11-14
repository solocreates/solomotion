import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip } from "../factories";
import {
  addVariable,
  addVariableFolder,
  deleteVariable,
  deleteVariableFolder,
  exportVariables,
  importVariables,
  moveVariableFolder,
  resolvePaint,
  setVariableClock,
  variableUsage,
} from ".";
import { PALETTE_LIBRARIES, importLibrary, libraryEntries } from "../colors/libraries";
import { buildPatternTile } from "../vector/pattern";
import { defaultPatternSpec, gradientPaint, solidPaint, variablePaint, type GradientPaint, type Paint } from "../schema/vector";
import { clearPaintOverride, isPaintOverridden, paintOverrides, setPaintProperty } from "../animation/paint";
import { createId } from "../ids";
import { parseDocument, serializeDocument } from "../io";
import type { MotionDocument, ShapeClip } from "../schema";

function docWithShape(): { doc: MotionDocument; shape: ShapeClip } {
  const doc = createEmptyDocument();
  const shape = createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0 });
  doc.tracks[0]!.clips.push(shape);
  return { doc, shape };
}

const ramp = (): Paint =>
  gradientPaint("linear", [
    { id: createId("stop"), offset: 0, color: "#FF0000" },
    { id: createId("stop"), offset: 1, color: "#0000FF" },
  ]);

describe("paint variables", () => {
  it("a fill bound to one draws the variable's look with the layer's compositing", () => {
    const { doc, shape } = docWithShape();
    const v = addVariable(doc, "paint", "Brand ramp", ramp());
    shape.fills = [{ ...variablePaint(v.id), opacity: 0.4, blendMode: "screen" }];

    const resolved = resolvePaint(doc, shape.fills[0]!);
    expect(resolved.type).toBe("linear");
    // The variable owns the LOOK; the entry owns how this layer lays it down,
    // which is what lets two layers share one gradient and fade separately.
    expect(resolved.opacity).toBe(0.4);
    expect(resolved.blendMode).toBe("screen");
    expect(resolved.id).toBe(shape.fills[0]!.id);
  });

  it("counts as a usage, and deleting it detaches instead of leaving a hole", () => {
    const { doc, shape } = docWithShape();
    const v = addVariable(doc, "paint", "Brand ramp", ramp());
    shape.fills = [{ ...variablePaint(v.id), opacity: 0.5 }];
    expect(variableUsage(doc).get(v.id)).toBe(1);

    deleteVariable(doc, v.id);
    expect(shape.fills[0]!.type).toBe("linear");
    expect(shape.fills[0]!.opacity).toBe(0.5);
    expect(resolvePaint(doc, shape.fills[0]!).type).toBe("linear");
  });

  it("a reference cycle costs a lookup, not the frame", () => {
    const doc = createEmptyDocument();
    const a = addVariable(doc, "paint", "A", solidPaint("#fff"));
    const b = addVariable(doc, "paint", "B", variablePaint(a.id));
    a.value = variablePaint(b.id);
    expect(resolvePaint(doc, variablePaint(a.id)).type).toBe("solid");
  });

  it("keyframes a gradient stop through the shared paint path engine", () => {
    const doc = createEmptyDocument();
    const v = addVariable(doc, "paint", "Ramp", ramp());
    const stopId = (v.value as GradientPaint).stops[0]!.id;
    v.keyframes = [
      {
        id: createId("track"),
        range: null,
        property: `value.stop.${stopId}.color`,
        keys: [
          { id: createId("k"), timeMs: 0, value: "#000000", easing: { kind: "linear" } },
          { id: createId("k"), timeMs: 1000, value: "#ffffff", easing: { kind: "linear" } },
        ],
      },
    ];
    setVariableClock(1000);
    const paint = resolvePaint(doc, variablePaint(v.id)) as GradientPaint;
    expect(paint.stops[0]!.color.toLowerCase()).toBe("#ffffff");
    setVariableClock(null);
  });

  it("survives a save/load round trip", () => {
    const { doc, shape } = docWithShape();
    const v = addVariable(doc, "paint", "Ramp", ramp());
    shape.fills = [variablePaint(v.id)];
    const back = parseDocument(serializeDocument(doc));
    expect(back.variables.find((x) => x.name === "Ramp")?.type).toBe("paint");
    const fill = (back.tracks[0]!.clips[0] as ShapeClip).fills[0]!;
    expect(fill.type).toBe("variable");
    expect(resolvePaint(back, fill).type).toBe("linear");
  });
});

describe("folders and libraries", () => {
  it("importing a library is a folder of ordinary variables, and is idempotent", () => {
    const doc = createEmptyDocument();
    const folder = importLibrary(doc, "atom")!;
    const count = doc.variables.length;
    expect(count).toBe(libraryEntries(PALETTE_LIBRARIES[0]!).length);
    expect(doc.variables.every((v) => v.type === "paint" && v.folderId === folder.id)).toBe(true);

    // Pressing import again updates in place — a palette you have tinted must
    // not fork the moment you press the button twice.
    importLibrary(doc, "atom");
    expect(doc.variables.length).toBe(count);
    expect(doc.variableFolders.length).toBe(1);
  });

  it("every shipped library builds a drawable tile for every pattern", () => {
    for (const lib of PALETTE_LIBRARIES) {
      for (const entry of libraryEntries(lib)) {
        if (entry.paint.type !== "pattern") continue;
        const tile = buildPatternTile(entry.paint.pattern, (c) => c);
        expect(tile.w).toBeGreaterThan(0);
        expect(tile.h).toBeGreaterThan(0);
        expect(tile.marks.length).toBeGreaterThan(0);
      }
    }
  });

  it("deleting a folder promotes its contents; withContents detaches them", () => {
    const { doc, shape } = docWithShape();
    const f = addVariableFolder(doc, "Palette");
    const v = addVariable(doc, "paint", "Ramp", ramp());
    v.folderId = f.id;
    shape.fills = [variablePaint(v.id)];

    deleteVariableFolder(doc, f.id);
    expect(doc.variableFolders).toHaveLength(0);
    expect(doc.variables.find((x) => x.id === v.id)?.folderId).toBeNull();

    const g = addVariableFolder(doc, "Again");
    doc.variables.find((x) => x.id === v.id)!.folderId = g.id;
    deleteVariableFolder(doc, g.id, { withContents: true });
    expect(doc.variables).toHaveLength(0);
    expect(shape.fills[0]!.type).toBe("linear");
  });

  it("refuses to drop a folder inside itself", () => {
    const doc = createEmptyDocument();
    const parent = addVariableFolder(doc, "Parent");
    const child = addVariableFolder(doc, "Child", parent.id);
    expect(moveVariableFolder(doc, parent.id, child.id)).toBe(false);
    expect(doc.variableFolders.find((f) => f.id === parent.id)?.parentId).toBeNull();
  });

  it("export/import round-trips a palette with fresh ids", () => {
    const doc = createEmptyDocument();
    const folder = importLibrary(doc, "nord")!;
    const file = exportVariables(doc, folder.id, "studio");
    expect(file.folders[0]!.parentId).toBeNull();

    const target = createEmptyDocument();
    const { variables } = importVariables(target, file);
    expect(variables).toHaveLength(file.variables.length);
    // Fresh ids throughout: two documents that each imported this palette must
    // never collide when one is pasted into the other.
    expect(variables.every((v) => !file.variables.some((o) => o.id === v.id))).toBe(true);
  });
});

describe("pattern engine", () => {
  it("scale multiplies every length, and the tile stays drawable", () => {
    const spec = { ...defaultPatternSpec("dots"), spacing: 20, thickness: 8, scale: 3 };
    const tile = buildPatternTile(spec, (c) => c);
    expect(tile.w).toBe(60);
    const dot = tile.marks.find((m) => m.kind === "circle");
    expect(dot && dot.kind === "circle" && dot.radius).toBe(12);
  });

  it("a transparent ground is a real answer, not a white one", () => {
    const tile = buildPatternTile({ ...defaultPatternSpec(), background: "#00000000" }, (c) => c);
    expect(tile.background).toBeNull();
  });

  it("resolves var: tokens inside a pattern like any other colour slot", () => {
    const tile = buildPatternTile({ ...defaultPatternSpec(), color: "var:x" }, (c) => (c === "var:x" ? "#ABCDEF" : c));
    expect(tile.marks.some((m) => "color" in m && m.color === "#ABCDEF")).toBe(true);
  });
});

describe("style links inherit, and let you override", () => {
  it("takes the style's look and the entry's compositing", () => {
    const doc = createEmptyDocument();
    const v = addVariable(doc, "paint", "Ramp", ramp());
    const linked = { ...variablePaint(v.id), opacity: 0.5 };
    const out = resolvePaint(doc, linked) as GradientPaint;
    expect(out.type).toBe("linear");
    expect(out.opacity).toBe(0.5);
  });

  it("an override wins, and everything else still follows the style", () => {
    const doc = createEmptyDocument();
    const v = addVariable(doc, "paint", "Ramp", ramp());
    const stops = (v.value as GradientPaint).stops;
    const linked = variablePaint(v.id);
    setPaintProperty(linked, "start.x", 0.25);

    const before = resolvePaint(doc, linked) as GradientPaint;
    expect(before.start.x).toBe(0.25);
    expect(before.stops[0]!.color).toBe(stops[0]!.color);

    // Recolouring the STYLE must still reach a fill that only moved a handle —
    // that is the whole difference between a link and a copy.
    (v.value as GradientPaint).stops[0]!.color = "#123456";
    const after = resolvePaint(doc, linked) as GradientPaint;
    expect(after.stops[0]!.color).toBe("#123456");
    expect(after.start.x).toBe(0.25);
  });

  it("never writes back into the style", () => {
    const doc = createEmptyDocument();
    const v = addVariable(doc, "paint", "Ramp", ramp());
    const a = variablePaint(v.id);
    const b = variablePaint(v.id);
    setPaintProperty(a, "start.x", 0.9);
    expect((resolvePaint(doc, b) as GradientPaint).start.x).toBe((v.value as GradientPaint).start.x);
    expect((v.value as GradientPaint).start.x).not.toBe(0.9);
  });

  it("reverting one property leaves the rest, and reverting the last clears the map", () => {
    const linked = variablePaint("v1");
    setPaintProperty(linked, "start.x", 0.25);
    setPaintProperty(linked, "end.x", 0.75);
    expect(paintOverrides(linked).map((o) => o.path).sort()).toEqual(["end.x", "start.x"]);
    expect(isPaintOverridden(linked, "start.x")).toBe(true);

    clearPaintOverride(linked, "start.x");
    expect(isPaintOverridden(linked, "start.x")).toBe(false);
    expect(paintOverrides(linked)).toHaveLength(1);

    clearPaintOverride(linked, "end.x");
    // Absent, not empty: a link that overrides nothing carries nothing.
    expect((linked as Extract<Paint, { type: "variable" }>).overrides).toBeUndefined();
  });

  it("an override for a property the style no longer has simply stops applying", () => {
    const doc = createEmptyDocument();
    const v = addVariable(doc, "paint", "Style", ramp());
    const linked = variablePaint(v.id);
    setPaintProperty(linked, "start.x", 0.25);
    // The style becomes a solid — there is no `start` to move any more.
    v.value = solidPaint("#ff0000");
    const out = resolvePaint(doc, linked);
    expect(out.type).toBe("solid");
    expect(paintOverrides(linked)).toHaveLength(1); // kept, in case it comes back
  });

  it("survives a save/load round trip", () => {
    const { doc, shape } = docWithShape();
    const v = addVariable(doc, "paint", "Ramp", ramp());
    const linked = variablePaint(v.id);
    setPaintProperty(linked, "start.x", 0.25);
    shape.fills = [linked];
    const back = parseDocument(serializeDocument(doc));
    const fill = (back.tracks[0]!.clips[0] as ShapeClip).fills[0]!;
    expect(isPaintOverridden(fill, "start.x")).toBe(true);
    expect((resolvePaint(back, fill) as GradientPaint).start.x).toBe(0.25);
  });
});
