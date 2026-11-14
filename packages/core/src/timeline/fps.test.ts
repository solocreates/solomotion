import { describe, expect, it } from "vitest";
import {
  DEFAULT_FPS,
  compFps,
  durationInFrames,
  formatFps,
  frameFps,
  frameIndexToMs,
  frameStepMs,
  compRenderTimeMs,
  msToFrameIndex,
  normalizeFps,
  quantizeMsToFrame,
  snapMsToFrame,
} from "./fps";
import { createEmptyDocument, createFrame, createTextClip, createTrack } from "../factories";
import { clipLocalTime } from "../animation/evaluate";
import { parseDocument, serializeDocument } from "../io";
import { nestClips, retimeFlipbookCells, setFrameFps } from "./ops";
import { createDrawing, createFlipbook } from "../drawing/flipbook";
import type { MotionDocument } from "../schema";

describe("normalizeFps", () => {
  it("clamps to the legal range and survives garbage", () => {
    expect(normalizeFps(0)).toBe(1);
    expect(normalizeFps(-5)).toBe(1);
    expect(normalizeFps(10_000)).toBe(240);
    expect(normalizeFps(Number.NaN)).toBe(DEFAULT_FPS);
    expect(normalizeFps(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FPS);
  });

  it("keeps the broadcast rates intact instead of rounding them to integers", () => {
    expect(normalizeFps(23.976)).toBe(23.976);
    expect(normalizeFps(29.97)).toBe(29.97);
    // …but does not persist float noise from a drag gesture.
    expect(normalizeFps(29.970000000000002)).toBe(29.97);
  });
});

describe("the frame grid", () => {
  it("steps, indexes and snaps consistently at a non-integer step", () => {
    const fps = 12; // 83.333…ms — the step that used to land a ULP off
    expect(frameStepMs(fps)).toBeCloseTo(83.3333, 3);
    expect(msToFrameIndex(0, fps)).toBe(0);
    expect(msToFrameIndex(82.8, fps)).toBe(0);
    // Within half a millisecond of the line is the next frame: whole-ms rounding of 83.33.
    expect(msToFrameIndex(83, fps)).toBe(1);
    expect(msToFrameIndex(83.4, fps)).toBe(1);
    // A boundary reached by multiplication must index as its OWN frame, not the
    // one before it — the half-ULP class of bug this nudge exists to kill.
    for (let i = 0; i < 40; i++) {
      expect(msToFrameIndex(frameIndexToMs(i, fps), fps)).toBe(i);
    }
  });

  it("snaps to the nearest grid instant", () => {
    // 12fps: 40ms is nearer frame 0 (0ms) than frame 1 (83.33ms); 50ms is not.
    expect(snapMsToFrame(40, 12)).toBe(0);
    expect(snapMsToFrame(50, 12)).toBe(83.333);
    expect(snapMsToFrame(41, 24)).toBe(41.667);
    expect(snapMsToFrame(0, 30)).toBe(0);
  });

  it("counts holds as whole frames, never zero", () => {
    expect(durationInFrames(1000, 12)).toBe(12);
    expect(durationInFrames(83.333, 12)).toBe(1);
    expect(durationInFrames(1, 12)).toBe(1);
  });
});

describe("the render clock (quantizeMsToFrame)", () => {
  it("HOLDS a frame for its whole span, so a 2fps comp really plays on twos", () => {
    // Every instant inside the first 500ms frame renders as frame 0.
    expect(quantizeMsToFrame(0, 2)).toBe(0);
    expect(quantizeMsToFrame(1, 2)).toBe(0);
    expect(quantizeMsToFrame(499, 2)).toBe(0);
    // …and the next span is a clean step, not a blend.
    expect(quantizeMsToFrame(500, 2)).toBe(500);
    expect(quantizeMsToFrame(999, 2)).toBe(500);
    expect(quantizeMsToFrame(1000, 2)).toBe(1000);
  });

  it("floors rather than rounding — a frame is a span you are inside of", () => {
    // 60% into a frame still shows that frame; `snapMsToFrame` would jump ahead
    // to the next one, which is right for an edit and wrong for the picture.
    expect(quantizeMsToFrame(300, 2)).toBe(0);
    expect(snapMsToFrame(300, 2)).toBe(500);
  });

  it("is a no-op on exact frame times at a non-integer step", () => {
    for (let i = 0; i < 40; i++) {
      const t = frameIndexToMs(i, 12);
      expect(quantizeMsToFrame(t, 12)).toBeCloseTo(t, 6);
    }
  });

  it("holds a nested child on ITS rate while the parent moves on its own", () => {
    // The parent advances every ~16.7ms; the 12fps child holds ~83.3ms. Five
    // consecutive parent frames resolve to ONE child frame — the nesting rule,
    // stated as the render clock actually computes it.
    const seen = new Set<number>();
    for (let i = 0; i < 5; i++) {
      seen.add(Math.round(quantizeMsToFrame(frameIndexToMs(i, 60), 12) * 1000));
    }
    expect(seen.size).toBe(1);
  });

  it("never returns a negative time", () => {
    expect(quantizeMsToFrame(-50, 24)).toBe(0);
  });
});

describe("where a rate lives", () => {
  it("reads off the frame, and falls back only for an unknown id", () => {
    const doc = createEmptyDocument();
    doc.frames[0]!.fps = 24;
    expect(frameFps(doc, doc.frames[0]!)).toBe(24);
    expect(compFps(doc, doc.frames[0]!.id)).toBe(24);
    expect(compFps(doc, "frame_nope")).toBe(DEFAULT_FPS);
    expect(compFps(doc, null)).toBe(DEFAULT_FPS);
  });

  it("lets sibling comps hold different rates at once", () => {
    const doc = createEmptyDocument();
    const film = createFrame({ name: "Film", fps: 24 });
    const sheet = createFrame({ name: "Sheet", fps: 12 });
    doc.frames.push(film, sheet);
    expect(compFps(doc, film.id)).toBe(24);
    expect(compFps(doc, sheet.id)).toBe(12);
    expect(compFps(doc, doc.frames[0]!.id)).toBe(DEFAULT_FPS);
  });

  it("round-trips through serialize/parse", () => {
    const doc = createEmptyDocument();
    doc.frames[0]!.fps = 23.976;
    const back = parseDocument(serializeDocument(doc));
    expect(back.frames[0]!.fps).toBe(23.976);
    expect("fps" in back).toBe(false);
  });
});

describe("v48 migration", () => {
  /** A v47 document carrying the old document-global rate plus one override. */
  function v47(docFps: number, frameOverride: number | null) {
    const base = createEmptyDocument();
    const raw = JSON.parse(serializeDocument(base)) as Record<string, unknown>;
    raw.version = 47;
    raw.fps = docFps;
    const frames = raw.frames as Array<Record<string, unknown>>;
    frames[0]!.fps = frameOverride;
    frames.push({ ...frames[0]!, id: "frame_second", fps: null });
    return JSON.stringify(raw);
  }

  it("gives every frame the rate it EFFECTIVELY had", () => {
    const doc = parseDocument(v47(60, 12));
    // The frame that overrode keeps its own rate…
    expect(doc.frames[0]!.fps).toBe(12);
    // …and the one that inherited is seeded with what it was really running at.
    expect(doc.frames[1]!.fps).toBe(60);
  });

  it("drops the document rate entirely", () => {
    const doc = parseDocument(v47(24, null));
    expect("fps" in doc).toBe(false);
    expect(doc.frames.every((f) => f.fps === 24)).toBe(true);
  });
});

// ── The composition rule ────────────────────────────────────────────────────

/** A doc with a clip carrying keyframes, so we can assert times never move. */
function docWithKeyframedClip(fps: number): { doc: MotionDocument; clipId: string } {
  const doc = createEmptyDocument();
  doc.frames[0]!.fps = fps;
  const clip = createTextClip({ frameId: doc.frames[0]!.id, text: "Hi", startMs: 250 });
  clip.durationMs = 2000;
  clip.keyframes = [
    {
      id: "kt1",
      property: "x",
      range: null,
      keys: [
        { id: "k1", timeMs: 0, value: 0, easing: { kind: "linear" } },
        { id: "k2", timeMs: 1234, value: 400, easing: { kind: "linear" } },
      ],
    },
  ];
  doc.tracks[0]!.clips.push(clip);
  return { doc, clipId: clip.id };
}

describe("a rate is a grid, not a time", () => {
  it("changing a comp's rate moves no clip and no keyframe", () => {
    const { doc } = docWithKeyframedClip(30);
    const before = JSON.stringify(doc.tracks);
    doc.frames[0]!.fps = 12;
    expect(JSON.stringify(doc.tracks)).toBe(before);
    doc.frames[0]!.fps = 60;
    expect(JSON.stringify(doc.tracks)).toBe(before);
  });

  it("a 12fps child nested in a 60fps parent keeps its own cadence", () => {
    const doc = createEmptyDocument();
    const parent = doc.frames[0]!;
    parent.fps = 60;
    const { flipbook } = createFlipbook(doc, {
      parentFrameId: parent.id,
      startMs: 0,
      width: 200,
      height: 200,
      fps: 12,
    });
    // Each side keeps its own grid; neither is renegotiated by the other.
    expect(compFps(doc, parent.id)).toBe(60);
    expect(compFps(doc, flipbook.id)).toBe(12);
    // The parent samples ~5 times per child frame — the whole nesting rule.
    expect(frameStepMs(12) / frameStepMs(60)).toBeCloseTo(5, 6);
  });

  it("precompose seeds the new comp with the parent's grid", () => {
    const doc = createEmptyDocument();
    const parent = doc.frames[0]!;
    parent.fps = 24;
    const clip = createTextClip({ frameId: parent.id, text: "A", startMs: 0 });
    doc.tracks[0]!.clips.push(clip);
    nestClips(doc, [clip.id]);
    const source = doc.frames.find((f) => f.id !== parent.id);
    expect(source).toBeDefined();
    expect(source!.fps).toBe(24);
  });

  it("a drawing cell is born on its sheet's grid", () => {
    const doc = createEmptyDocument();
    const sheet = createFrame({ name: "Sheet", fps: 12 });
    doc.frames.push(sheet);
    doc.tracks.push(createTrack("Row", sheet.id));
    const { drawing } = createDrawing(doc, {
      parentFrameId: sheet.id,
      startMs: 0,
      durationMs: frameStepMs(12),
      width: 100,
      height: 100,
    });
    expect(drawing.fps).toBe(12);
  });
});

describe("retimeFlipbookCells", () => {
  it("preserves HOLD COUNTS rather than millisecond timings", () => {
    const doc = createEmptyDocument();
    const sheet = createFrame({ name: "Sheet", fps: 12 });
    doc.frames.push(sheet);
    const row = createTrack("Row", sheet.id);
    doc.tracks.push(row);
    // Two cells: a 1-frame hold then a 2-frame hold, on the 12fps grid.
    const step12 = frameStepMs(12);
    for (const [i, holds] of [1, 2].entries()) {
      const cell = createTextClip({ frameId: sheet.id, text: `c${i}`, startMs: 0 });
      cell.startMs = i === 0 ? 0 : step12;
      cell.durationMs = step12 * holds;
      row.clips.push(cell);
    }
    retimeFlipbookCells(doc, sheet.id, 12, 24);
    const step24 = frameStepMs(24);
    expect(row.clips[0]!.durationMs).toBeCloseTo(step24 * 1, 2);
    expect(row.clips[1]!.startMs).toBeCloseTo(step24 * 1, 2);
    expect(row.clips[1]!.durationMs).toBeCloseTo(step24 * 2, 2);
  });

  it("leaves clips belonging to other comps alone", () => {
    const doc = createEmptyDocument();
    const sheet = createFrame({ name: "Sheet", fps: 12 });
    doc.frames.push(sheet);
    const other = createTextClip({ frameId: doc.frames[0]!.id, text: "x", startMs: 500 });
    doc.tracks[0]!.clips.push(other);
    retimeFlipbookCells(doc, sheet.id, 12, 24);
    expect(other.startMs).toBe(500);
  });

  it("is a no-op when the rate did not actually change", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: doc.frames[0]!.id, text: "x", startMs: 500 });
    doc.tracks[0]!.clips.push(clip);
    retimeFlipbookCells(doc, doc.frames[0]!.id, 24, 24);
    expect(clip.startMs).toBe(500);
  });
});

describe("setFrameFps — the one writer", () => {
  it("changes an ordinary comp's rate without moving a single clip or key", () => {
    const { doc } = docWithKeyframedClip(30);
    const before = JSON.stringify(doc.tracks);
    setFrameFps(doc, doc.frames[0]!.id, 60);
    expect(doc.frames[0]!.fps).toBe(60);
    expect(JSON.stringify(doc.tracks)).toBe(before);
  });

  it("re-cuts a FLIPBOOK, because there a frame is a drawing", () => {
    const doc = createEmptyDocument();
    const sheet = createFrame({ name: "Sheet", mode: "flipbook", fps: 12 });
    doc.frames.push(sheet);
    const row = createTrack("Row", sheet.id);
    doc.tracks.push(row);
    const cell = createTextClip({ frameId: sheet.id, text: "c", startMs: 0 });
    cell.durationMs = frameStepMs(12) * 2; // a 2-frame hold
    row.clips.push(cell);

    setFrameFps(doc, sheet.id, 24);
    expect(sheet.fps).toBe(24);
    // Still a 2-frame hold — the sheet runs faster, the drawing is not dropped.
    expect(durationInFrames(cell.durationMs, 24)).toBe(2);
  });

  it("leaves a NESTED child's rate alone when the parent changes", () => {
    const doc = createEmptyDocument();
    const parent = doc.frames[0]!;
    parent.fps = 24;
    const child = createFrame({ name: "Child", fps: 12 });
    doc.frames.push(child);
    setFrameFps(doc, parent.id, 60);
    // The child owns its rate; nothing cascades. This is the nesting rule.
    expect(child.fps).toBe(12);
  });

  it("normalizes what it is given and ignores unknown frames", () => {
    const doc = createEmptyDocument();
    setFrameFps(doc, doc.frames[0]!.id, 10_000);
    expect(doc.frames[0]!.fps).toBe(240);
    expect(() => setFrameFps(doc, "frame_nope", 24)).not.toThrow();
  });

  it("survives a round trip back to the original rate without drifting", () => {
    const doc = createEmptyDocument();
    const sheet = createFrame({ name: "Sheet", mode: "flipbook", fps: 12 });
    doc.frames.push(sheet);
    const row = createTrack("Row", sheet.id);
    doc.tracks.push(row);
    const cell = createTextClip({ frameId: sheet.id, text: "c", startMs: 0 });
    cell.durationMs = frameStepMs(12) * 3;
    row.clips.push(cell);
    const originalHold = durationInFrames(cell.durationMs, 12);

    setFrameFps(doc, sheet.id, 24);
    setFrameFps(doc, sheet.id, 29.97);
    setFrameFps(doc, sheet.id, 12);
    expect(durationInFrames(cell.durationMs, 12)).toBe(originalHold);
  });
});

describe("formatFps", () => {
  it("shows integers bare and broadcast rates to their real decimals", () => {
    expect(formatFps(24)).toBe("24");
    expect(formatFps(29.97)).toBe("29.97");
    expect(formatFps(23.976)).toBe("23.976");
  });
});


// ── What you make is on the frame you can see ───────────────────────────────
//
// The render clock is a FLOOR onto the grid, so a clip that starts between two
// grid instants has a first sliver the picture never addresses: it appears one
// frame late, and if it is shorter than a frame it never appears at all. These
// pin the two ways that used to happen.

describe("the render clock can address what authoring writes", () => {
  it("recognises a grid instant that snapping rounded to 3dp", () => {
    // 12fps steps by 83.3333…, and `snapMsToFrame` stores 83.333. Flooring that
    // used to land in frame 0 — so the sheet's second cell was invisible on the
    // very frame it starts.
    for (const fps of [12, 23.976, 29.97, 240]) {
      for (let i = 1; i < 40; i++) {
        const stored = snapMsToFrame(frameIndexToMs(i, fps), fps);
        expect(msToFrameIndex(stored, fps)).toBe(i);
        // Bit-for-bit: the clock resolves to the very value the document stores.
        expect(quantizeMsToFrame(stored, fps)).toBe(stored);
      }
    }
  });

  it("starts a clip authored at any playhead on the frame being shown", () => {
    const doc = createEmptyDocument();
    const frame = doc.frames[0]!;
    frame.fps = 12;
    const step = frameStepMs(12);
    for (const playhead of [0, 1, 40, 83.333, 250.7, 999.999, 12_345.6]) {
      const startMs = compRenderTimeMs(doc, frame.id, playhead);
      // Sub-frame duration on purpose: the harshest case, one addressable instant.
      const clip = createTextClip({ frameId: frame.id, text: "x", startMs });
      clip.durationMs = step / 3;
      const shown = quantizeMsToFrame(playhead, 12);
      expect(clipLocalTime(clip, shown)).not.toBeNull();
    }
  });
});
