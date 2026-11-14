import { describe, expect, it } from "vitest";
import { createEmptyDocument, createFrame, createNestedClip, createShapeClip, createTrack } from "../factories";
import { flipbookRows } from "../drawing/flipbook";
import { setKeyframe } from "../animation/keyframes";
import { editPath, resolveEditContext } from "../navigation";
import { parseDocument, serializeDocument } from "../io";
import type { MotionDocument, Clip } from "../schema";
import { compRenderTimeMs, frameEvalTimeMs } from "./fps";
import { contentVariesInTime, setFrameMode, setStillMoment } from "./frame-mode";
import { placeClip } from "./place";

/** A 30fps, 4s root frame with two shapes on their own lanes. */
function scene(): { doc: MotionDocument; frameId: string; clips: Clip[] } {
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  frame.fps = 30;
  frame.durationMs = 4000;
  doc.durationMs = 4000;
  const a = createShapeClip({ frameId: frame.id, shape: "rect", startMs: 0, durationMs: 4000, x: -100 });
  const b = createShapeClip({ frameId: frame.id, shape: "ellipse", startMs: 1000, durationMs: 2000, x: 100 });
  setKeyframe(b.keyframes, "opacity", 0, 0);
  setKeyframe(b.keyframes, "opacity", 1000, 1);
  const ta = createTrack("a");
  ta.clips.push(a);
  const tb = createTrack("b");
  tb.clips.push(b);
  doc.tracks.unshift(ta, tb);
  return { doc, frameId: frame.id, clips: [a, b] };
}

const clipsOf = (doc: MotionDocument, frameId: string) =>
  doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === frameId);

describe("frame modes", () => {
  it("timeline ⇄ static is a pure flip: the still is where you stood, nothing else moves", () => {
    const { doc, frameId } = scene();
    const before = JSON.stringify(clipsOf(doc, frameId));
    expect(setFrameMode(doc, frameId, "static", { atMs: 1510 })).toBe(true);
    const frame = doc.frames[0]!;
    expect(frame.mode).toBe("static");
    // Floored onto the frame's own grid, like everything the render clock shows.
    expect(frame.stillMs).toBeCloseTo(1500, 3);
    // Whatever it is asked, a still shows its still.
    expect(frameEvalTimeMs(doc, frame, 3900)).toBeCloseTo(1500, 3);
    expect(compRenderTimeMs(doc, frameId, 0)).toBeCloseTo(1500, 3);

    expect(setFrameMode(doc, frameId, "timeline")).toBe(true);
    expect(frame.mode).toBe("timeline");
    expect(frame.stillMs).toBeUndefined();
    expect(frame.playheadMs).toBeCloseTo(1500, 3);
    expect(JSON.stringify(clipsOf(doc, frameId))).toBe(before);
  });

  it("timeline → flipbook wraps the whole timeline as frame 1, spanning it", () => {
    const { doc, frameId, clips } = scene();
    setFrameMode(doc, frameId, "flipbook");
    const rows = flipbookRows(doc, frameId);
    const cells = rows.flatMap((r) => r.cells);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.kind).toBe("nested");
    expect(cell.startMs).toBe(0);
    expect(cell.durationMs).toBeCloseTo(4000, 0);
    const source = doc.frames.find((f) => f.id === (cell as { sourceFrameId: string }).sourceFrameId)!;
    expect(source.mode).toBe("timeline");
    // Members keep their own times and places — frame 1 IS the old timeline.
    const moved = clipsOf(doc, source.id);
    expect(moved.map((c) => c.id).sort()).toEqual(clips.map((c) => c.id).sort());
    expect(moved.find((c) => c.id === clips[1]!.id)!.startMs).toBe(1000);
  });

  it("static → flipbook → static hands back the same layers, not a frame in a frame", () => {
    const { doc, frameId, clips } = scene();
    setFrameMode(doc, frameId, "static", { atMs: 2000 });
    setFrameMode(doc, frameId, "flipbook");
    const cells = flipbookRows(doc, frameId).flatMap((r) => r.cells);
    expect(cells).toHaveLength(1);
    // One frame of a looping sheet: the still shows forever.
    expect(cells[0]!.durationMs).toBeCloseTo(1000 / 30, 3);
    expect(doc.frames[0]!.loop).toBe("loop");

    setFrameMode(doc, frameId, "static");
    const frame = doc.frames[0]!;
    expect(frame.mode).toBe("static");
    expect(frame.stillMs).toBe(2000);
    expect(clipsOf(doc, frameId).map((c) => c.id).sort()).toEqual(clips.map((c) => c.id).sort());
    expect(doc.frames.filter((f) => f.id !== frameId)).toHaveLength(0);
  });

  it("an empty frame becomes a flipbook with one blank drawing, like a new one", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    setFrameMode(doc, frameId, "flipbook");
    const cells = flipbookRows(doc, frameId).flatMap((r) => r.cells);
    expect(cells).toHaveLength(1);
    const drawing = doc.frames.find((f) => f.id === (cells[0] as { sourceFrameId: string }).sourceFrameId)!;
    expect(drawing.mode).toBe("static");
  });

  it("a layer born in a still spans it", () => {
    const { doc, frameId } = scene();
    setFrameMode(doc, frameId, "static", { atMs: 1000 });
    const c = createShapeClip({ frameId, shape: "rect", startMs: 2500, durationMs: 300 });
    placeClip(doc, c);
    expect(c.startMs).toBe(0);
    expect(c.durationMs).toBe(4000);
    expect(c.fillDuration).toBe(true);
  });

  it("knows whether content can change over time", () => {
    const { doc, frameId, clips } = scene();
    expect(contentVariesInTime(doc, frameId)).toBe(true);
    clips[1]!.keyframes = [];
    clips[1]!.startMs = 0;
    clips[1]!.durationMs = 4000;
    expect(contentVariesInTime(doc, frameId)).toBe(false);
  });
});

describe("a timeline inside a still", () => {
  /** Static root at 500ms holding a 3s timeline comp from 0. */
  function stillScene() {
    const doc = createEmptyDocument();
    const root = doc.frames[0]!;
    root.durationMs = 3000;
    const child = createFrame({ name: "Logo", pageId: "__internal__", durationMs: 3000 });
    doc.frames.push(child);
    const hop = createNestedClip({ frameId: root.id, sourceFrameId: child.id, startMs: 0, durationMs: 3000 });
    const t = createTrack("t");
    t.clips.push(hop);
    doc.tracks.unshift(t);
    setFrameMode(doc, root.id, "static", { atMs: 500 });
    return { doc, root, child, hop };
  }

  it("pins the child to the moment the still maps it to, and names the edit that moves it", () => {
    const { doc, root, hop } = stillScene();
    const path = editPath(root.id, [hop.id]);
    const ctx = resolveEditContext(doc, path, 2000)!;
    expect(ctx.targetTimeMs).toBeCloseTo(500, 0);
    expect(ctx.moment).toEqual({ clipId: hop.id, parentTimeMs: 500, childTimeMs: 2000 });

    expect(setStillMoment(doc, hop.id, 500, 2000)).toBe(true);
    expect(hop.trimInMs).toBeCloseTo(1500, 3);
    const after = resolveEditContext(doc, path, 2000)!;
    expect(after.targetTimeMs).toBeCloseTo(2000, 0);
    expect(after.moment).toBeNull();
  });

  it("slides instead of slipping when the moment is earlier than the in-point allows", () => {
    const { doc, hop } = stillScene();
    expect(setStillMoment(doc, hop.id, 500, 200)).toBe(true);
    expect(hop.trimInMs).toBe(0);
    expect(hop.startMs).toBeCloseTo(300, 3);
  });
});

describe("v88 migration", () => {
  function legacy(animated: boolean): string {
    const doc = createEmptyDocument();
    const sheet = createFrame({ name: "Sheet", pageId: "__internal__" });
    const drawing = createFrame({ name: "D", pageId: "__internal__" });
    const layer = createShapeClip({ frameId: drawing.id, shape: "rect", startMs: 0, durationMs: 1000 });
    layer.fillDuration = true;
    if (animated) {
      setKeyframe(layer.keyframes, "x", 0, 0);
      setKeyframe(layer.keyframes, "x", 500, 50);
    }
    const cell = createNestedClip({ frameId: sheet.id, sourceFrameId: drawing.id, startMs: 0, durationMs: 1000 });
    const t1 = createTrack("row");
    t1.clips.push(cell);
    const t2 = createTrack("layers");
    t2.clips.push(layer);
    doc.tracks.unshift(t1, t2);
    doc.frames.push(sheet, drawing);
    const raw = JSON.parse(serializeDocument(doc)) as { version: number; frames: Array<Record<string, unknown>> };
    raw.version = 87;
    for (const f of raw.frames) {
      const mode = f.mode;
      delete f.mode;
      delete f.stillMs;
      f.role = f.id === sheet.id ? "flipbook" : f.id === drawing.id ? "drawing" : mode === "timeline" ? "comp" : mode;
    }
    return JSON.stringify(raw);
  }

  it("a still drawing becomes static; a moving one becomes a timeline cell", () => {
    const still = parseDocument(legacy(false));
    expect(still.frames.map((f) => f.mode).sort()).toEqual(["flipbook", "static", "timeline"]);
    const moving = parseDocument(legacy(true));
    expect(moving.frames.map((f) => f.mode).sort()).toEqual(["flipbook", "timeline", "timeline"]);
    expect(moving.frames.every((f) => f.stillMs === undefined)).toBe(true);
  });
});

describe("export pages", () => {
  it("a still is one page; a timeline is one per frame; a sheet one per drawing", async () => {
    const { planExportPages, countEveryFramePages } = await import("../export/pages");
    const { doc, frameId } = scene();
    // Timeline: 4s at 30fps = 120 frames.
    expect(countEveryFramePages(doc, [frameId])).toBe(120);
    const cur = planExportPages(doc, [frameId], { sampling: "current", currentTimeOf: () => 1510 });
    expect(cur.pages).toHaveLength(1);
    expect(cur.pages[0]!.timeMs).toBeCloseTo(1500, 3);

    setFrameMode(doc, frameId, "static", { atMs: 2000 });
    const still = planExportPages(doc, [frameId], { sampling: "every", currentTimeOf: () => 0 });
    expect(still.pages.map((p) => p.timeMs)).toEqual([2000]);

    // A sheet whose one cell holds 30 frames (a looping 1-frame still wrapped) is ONE drawing.
    setFrameMode(doc, frameId, "flipbook");
    expect(countEveryFramePages(doc, [frameId])).toBe(1);
  });

  it("caps a huge plan and says so", async () => {
    const { planExportPages } = await import("../export/pages");
    const { doc, frameId } = scene();
    const plan = planExportPages(doc, [frameId], { sampling: "every", currentTimeOf: () => 0, maxPages: 10 });
    expect(plan.pages).toHaveLength(10);
    expect(plan.truncated).toBe(true);
  });
});
