import { describe, expect, it } from "vitest";
import { createAdjustmentClip, createEmptyDocument, createTextClip, createTrack } from "../factories";
import type { AdjustmentClip, MotionDocument, Clip } from "../schema";
import { adjustmentSourceMatters, frameEffectClip, isFrameEffectClip, resolveAdjustmentTargets } from "./adjustment";
import { applyAnimationDrop, resolveAnimationDrop } from "./drop-targets";
import { moveClip, reconcileFillClips, setFrameDurationMs, trimClip } from "./ops";
import { parseDocument, serializeDocument } from "../io";
import { createLayerEffect, layerEffectCarves } from "../animation/layer-effects";

/**
 * The frame's own effect stack is DERIVED from the timeline, never stored. These
 * hold the derivation to its contract — the whole reason there is no
 * `frame.effects` field to keep in sync.
 */
function docWith(trackCount: number): { doc: MotionDocument; frameId: string } {
  const doc = createEmptyDocument();
  doc.tracks = Array.from({ length: trackCount }, (_, i) => ({ ...createTrack(`T${i}`), clips: [] as Clip[] }));
  return { doc, frameId: doc.frames[0]!.id };
}

const frameFx = (frameId: string): AdjustmentClip => {
  const c = createAdjustmentClip({ frameId, startMs: 0, name: "Frame effects" });
  c.scope = { reach: "all", filter: { mode: "all", targetIds: [] }, source: "replace" };
  return c;
};

describe("frameEffectClip", () => {
  it("is null until a frame effect exists", () => {
    const { doc, frameId } = docWith(1);
    doc.tracks[0]!.clips.push(createTextClip({ frameId, text: "hi", startMs: 0 }));
    expect(frameEffectClip(doc, frameId)).toBeNull();
  });

  it("finds a whole-reach adjustment as the frame's stack", () => {
    const { doc, frameId } = docWith(1);
    const fx = frameFx(frameId);
    doc.tracks[0]!.clips.push(fx);
    expect(frameEffectClip(doc, frameId)?.id).toBe(fx.id);
  });

  it("ignores an ordinary adjustment layer", () => {
    // Default reach is "below" — that grades what is under it, which is a
    // layer-stack tool, not the frame's own look.
    const { doc, frameId } = docWith(1);
    doc.tracks[0]!.clips.push(createAdjustmentClip({ frameId, startMs: 0 }));
    expect(frameEffectClip(doc, frameId)).toBeNull();
  });

  it("ignores a whole-reach adjustment that has been given a matte", () => {
    const { doc, frameId } = docWith(1);
    const scoped = frameFx(frameId);
    scoped.scope = { reach: "all", filter: { mode: "only", targetIds: ["clip_1"] }, source: "replace" };
    doc.tracks[0]!.clips.push(scoped);
    // Once it grades only SOME layers it is no longer the frame's look, and the
    // frame panel must offer to make a real one rather than adopt it.
    expect(isFrameEffectClip(scoped)).toBe(false);
    expect(frameEffectClip(doc, frameId)).toBeNull();
  });

  it("takes the TOPMOST when there are several — the order the renderer applies", () => {
    const { doc, frameId } = docWith(2);
    const lower = frameFx(frameId);
    const upper = frameFx(frameId);
    doc.tracks[0]!.clips.push(lower);
    doc.tracks[1]!.clips.push(upper);
    expect(frameEffectClip(doc, frameId)?.id).toBe(upper.id);
  });

  it("does not leak across frames", () => {
    const { doc, frameId } = docWith(1);
    doc.tracks[0]!.clips.push(frameFx(frameId));
    expect(frameEffectClip(doc, "frame_other")).toBeNull();
  });
});

/**
 * A GRADE IS AS LONG AS THE COMP — until someone says otherwise.
 *
 * The rule has three halves and every one of them was a real bug: a processor
 * is born tracking, a trim stops it tracking for good, and the comp's own
 * writer reconciles unconditionally (it used to reconcile on one of its three
 * branches, so growing an ordinary comp left its grades short).
 */
describe("a processor tracks its comp", () => {
  const setup = () => {
    const doc = createEmptyDocument();
    doc.durationMs = 10_000;
    doc.tracks = [{ ...createTrack("T0"), clips: [] as Clip[] }];
    const frameId = doc.frames[0]!.id;
    const clip = createAdjustmentClip({ frameId, startMs: 0, durationMs: doc.durationMs });
    doc.tracks[0]!.clips.push(clip);
    return { doc, frameId, clip };
  };

  it("is born filling, unlike every other kind", () => {
    const { clip } = setup();
    expect(clip.fillDuration).toBe(true);
  });

  it("follows the comp when it grows AND when it shrinks", () => {
    const { doc, frameId, clip } = setup();
    setFrameDurationMs(doc, frameId, 25_000);
    expect(clip.durationMs).toBe(25_000);
    setFrameDurationMs(doc, frameId, 4_000);
    expect(clip.durationMs).toBe(4_000);
  });

  it("re-spans when it is MOVED — a move is not a length edit", () => {
    const { doc, frameId, clip } = setup();
    moveClip(doc, clip.id, 2_000);
    expect(clip.fillDuration).toBe(true);
    expect(clip.startMs + clip.durationMs).toBe(10_000);
    setFrameDurationMs(doc, frameId, 18_000);
    expect(clip.startMs + clip.durationMs).toBe(18_000);
  });

  it("stays where a trim left it — and comes back when Fill is switched on", () => {
    const { doc, frameId, clip } = setup();
    trimClip(doc, clip.id, "end", 3_000);
    expect(clip.fillDuration).toBe(false);
    setFrameDurationMs(doc, frameId, 30_000);
    expect(clip.durationMs).toBe(3_000);

    clip.fillDuration = true;
    reconcileFillClips(doc, frameId);
    expect(clip.durationMs).toBe(30_000);
  });
});

/**
 * A processor is a LAYER: the drop resolver has to offer it an in/out animation
 * like any other, because the renderer poses and mixes it like any other
 * (`renderAdjustment`'s `AdjustmentMix`). It used to be excluded here while the
 * Animate tab offered the same thing — the inspector said yes, the drag said no.
 */
describe("an animation lands on a processor", () => {
  it("claims the edge you aim at", () => {
    const doc = createEmptyDocument();
    doc.tracks = [{ ...createTrack("T0"), clips: [] as Clip[] }];
    const frameId = doc.frames[0]!.id;
    const clip = createAdjustmentClip({ frameId, startMs: 0, durationMs: 4_000 });
    doc.tracks[0]!.clips.push(clip);
    const track = doc.tracks[0]!;

    expect(resolveAnimationDrop(track, frameId, 500, "fade")?.edge).toBe("in");
    const target = resolveAnimationDrop(track, frameId, 3_500, "fade");
    expect(target?.edge).toBe("out");
    expect(applyAnimationDrop(doc, target!, "fade")).toBe(true);
    expect(clip.animOut?.preset).toBe("fade");
  });
});

/**
 * SOURCE — does the grade consume what it read?
 *
 * It used to be inferred from `filter`: replace when there was no matte, lay
 * over when there was. So scoping a grade to one layer silently made it
 * non-destructive, and a transformed grade left that layer sitting un-moved
 * under its own graded copy with nothing in the panel to say why.
 */
describe("scope.source", () => {
  const adj = (source: "replace" | "over", mode: "all" | "only") => {
    const c = createAdjustmentClip({ frameId: "f1", startMs: 0 });
    c.scope = { reach: "below", filter: { mode, targetIds: [] }, source };
    return c;
  };

  it("is reported by the ONE resolver the renderer reads", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    for (const mode of ["all", "only"] as const) {
      const over = adj("over", mode);
      over.frameId = frameId;
      expect(resolveAdjustmentTargets(doc, frameId, over).replaces).toBe(false);
      const replace = adj("replace", mode);
      replace.frameId = frameId;
      expect(resolveAdjustmentTargets(doc, frameId, replace).replaces).toBe(true);
    }
  });

  it("is independent of the matte — the bug it replaces", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const scoped = adj("replace", "only");
    scoped.frameId = frameId;
    const t = resolveAdjustmentTargets(doc, frameId, scoped);
    // A scoped grade CAN replace now; before, `wholeReach` decided for it.
    expect(t.wholeReach).toBe(false);
    expect(t.replaces).toBe(true);
  });

  it("only means something when the grade RELOCATES its pixels", () => {
    const still = createAdjustmentClip({ frameId: "f1", startMs: 0 });
    expect(adjustmentSourceMatters(still)).toBe(false);

    const rotated = createAdjustmentClip({ frameId: "f1", startMs: 0 });
    rotated.transform.rotation = 12;
    expect(adjustmentSourceMatters(rotated)).toBe(true);

    // A pose that is identity NOW but keyed to move later still counts: the
    // switch has to be reachable before you scrub to the frame that needs it.
    const keyed = createAdjustmentClip({ frameId: "f1", startMs: 0 });
    keyed.keyframes = [
      {
        id: "track-scale",
        property: "scale",
        range: null,
        keys: [
          { id: "k1", timeMs: 0, value: 1, easing: { kind: "linear" } },
          { id: "k2", timeMs: 500, value: 2, easing: { kind: "linear" } },
        ],
      },
    ];
    expect(adjustmentSourceMatters(keyed)).toBe(true);
  });

  it("means something when a card CUTS HOLES, pose or not", () => {
    // An LED board on an adjustment layer: the gaps between its dots must show
    // the paper, not the photo the board was made from.
    const board = createAdjustmentClip({ frameId: "f1", startMs: 0 });
    board.effects = [createLayerEffect("pixelate")];
    expect(adjustmentSourceMatters(board)).toBe(true);
    expect(layerEffectCarves("halftone")).toBe(true);
    // A colour grade lands back on every pixel it read, whole.
    const graded = createAdjustmentClip({ frameId: "f1", startMs: 0 });
    graded.effects = [createLayerEffect("adjust")];
    expect(adjustmentSourceMatters(graded)).toBe(false);
  });
});

/**
 * The v65 migration's whole job: a document made before `source` existed opens
 * looking exactly the same. The old renderer replaced when there was no matte
 * and laid over when there was, so each clip is stamped with what it DID.
 */
describe("v64 → v65 migration", () => {
  const openAsV64 = (mutate: (clip: Record<string, unknown>) => void) => {
    const doc = createEmptyDocument("t");
    const frameId = doc.frames[0]!.id;
    const track = { ...createTrack("v", frameId), clips: [] as Clip[] };
    track.clips.push(createAdjustmentClip({ frameId, startMs: 0 }));
    doc.tracks.push(track);

    const raw = JSON.parse(serializeDocument(doc)) as {
      version: number;
      tracks: Array<{ clips: Array<Record<string, unknown>> }>;
    };
    raw.version = 64;
    for (const t of raw.tracks) {
      for (const c of t.clips) {
        if (c.kind !== "adjustment") continue;
        delete (c.scope as Record<string, unknown>).source;
        mutate(c);
      }
    }
    const loaded = parseDocument(JSON.stringify(raw));
    const clip = loaded.tracks.flatMap((t) => t.clips).find((c) => c.kind === "adjustment");
    if (!clip || clip.kind !== "adjustment") throw new Error("adjustment clip missing");
    return clip;
  };

  it("keeps an un-matted grade destructive — it always was", () => {
    expect(openAsV64(() => {}).scope.source).toBe("replace");
  });

  it("keeps a SCOPED grade non-destructive — it always was", () => {
    const clip = openAsV64((c) => {
      (c.scope as { filter: Record<string, unknown> }).filter = { mode: "only", targetIds: ["clip_x"] };
    });
    expect(clip.scope.source).toBe("over");
  });
});
