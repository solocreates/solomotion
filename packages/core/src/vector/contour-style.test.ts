import { describe, expect, it } from "vitest";
import { createEmptyDocument, createPathClip, createTrack } from "../factories";
import { editPathGeometry } from "../pivot";
import { solidPaint, strokeStyle } from "../schema";

/** A plain one-colour stroke, the shape a brush commit hands over. */
const solidStroke = (color: string) => strokeStyle(solidPaint(color));
import type { PathClip, Paint } from "../schema";

/** Test helper: these fixtures only ever build solid paints. */
const hex = (p: Paint | undefined) => (p && p.type === "solid" ? p.color : null);
import { locateClip } from "../timeline/ops";
import {
  bakeContourStyle,
  clearContourOverride,
  clearContourStyle,
  contourOverlay,
  hasContourOverrides,
  pruneContourStyles,
  resolveContourStyle,
  setContourOverride,
  setContourInk,
  clearContourInk,
} from "./contour-style";
import { extractContours, promotePathClip } from "./promote";

const pt = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });
const box = (x: number, y: number, w: number, h: number) => ({
  closed: true,
  points: [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)],
});

function clipWith(n = 2): { doc: ReturnType<typeof createEmptyDocument>; clip: PathClip } {
  const doc = createEmptyDocument();
  const subs = Array.from({ length: n }, (_, i) => box(i * 50, 0, 10, 10));
  const clip = createPathClip({
    frameId: doc.frames[0]!.id,
    subpaths: subs,
    startMs: 0,
    durationMs: 2000,
    name: "Logo",
    fill: solidPaint("#ff0000"),
    // Filled AND outlined: a fill alone no longer brings the default line.
    stroke: strokeStyle(solidPaint("#F4F2ED"), { width: 4 }),
  });
  const track = createTrack("t");
  track.clips.push(clip);
  doc.tracks.push(track);
  return { doc, clip };
}

describe("resolveContourStyle", () => {
  it("an untouched contour inherits — by REFERENCE, so nothing allocates", () => {
    // The fast path that makes this safe to call per contour per frame.
    const { clip } = clipWith();
    const r = resolveContourStyle(clip, clip.subpaths[0]!.id);
    expect(r.overridden).toBe(false);
    expect(r.fills).toBe(clip.fills);
    expect(r.strokes).toBe(clip.strokes);
    expect(r.effects).toBe(clip.effects);
  });

  it("an override changes ONE contour and leaves its siblings inheriting", () => {
    const { clip } = clipWith();
    const [a, b] = clip.subpaths;
    setContourOverride(clip, b!.id, `fill.${clip.fills[0]!.id}.color`, "#00ff00");
    expect(hex(resolveContourStyle(clip, a!.id).fills[0])).toBe("#ff0000");
    expect(hex(resolveContourStyle(clip, b!.id).fills[0])).toBe("#00ff00");
    // The LAYER is untouched — the override is a diff, never a write-through.
    expect(hex(clip.fills[0])).toBe("#ff0000");
  });

  it("editing the layer still reaches every contour that has not opted out", () => {
    // This is the whole reason it is inheritance and not a snapshot.
    const { clip } = clipWith(3);
    setContourOverride(clip, clip.subpaths[1]!.id, `fill.${clip.fills[0]!.id}.color`, "#00ff00");
    if (clip.fills[0]!.type === "solid") clip.fills[0]!.color = "#0000ff";
    expect(hex(resolveContourStyle(clip, clip.subpaths[0]!.id).fills[0])).toBe("#0000ff");
    expect(hex(resolveContourStyle(clip, clip.subpaths[2]!.id).fills[0])).toBe("#0000ff");
    expect(hex(resolveContourStyle(clip, clip.subpaths[1]!.id).fills[0])).toBe("#00ff00");
  });

  it("only the entries an overlay patches get cloned", () => {
    const { clip } = clipWith();
    clip.effects = [];
    setContourOverride(clip, clip.subpaths[0]!.id, "opacity", 0.5);
    const r = resolveContourStyle(clip, clip.subpaths[0]!.id);
    expect(r.opacity).toBe(0.5);
    // Nothing named a fill, so the fills came across untouched.
    expect(hex(r.fills[0])).toBe("#ff0000");
  });

  it("a scope can ADD a fill the layer does not have, and REMOVE one it does", () => {
    const { clip } = clipWith();
    const id = clip.subpaths[0]!.id;
    const extra = solidPaint("#123456");
    setContourOverride(clip, id, "opacity", 1);
    contourOverlay(clip, id)!.added.fills.push(extra);
    contourOverlay(clip, id)!.removed.push(clip.fills[0]!.id);
    const r = resolveContourStyle(clip, id);
    expect(r.fills.map(hex)).toEqual(["#123456"]);
    expect(hex(resolveContourStyle(clip, clip.subpaths[1]!.id).fills[0])).toBe("#ff0000");
  });
});

describe("override lifecycle", () => {
  it("clearing the last override removes the entry — one representation of 'inherits'", () => {
    const { clip } = clipWith();
    const id = clip.subpaths[0]!.id;
    const path = `fill.${clip.fills[0]!.id}.color`;
    setContourOverride(clip, id, path, "#00ff00");
    expect(hasContourOverrides(clip)).toBe(true);
    clearContourOverride(clip, id, path);
    expect(clip.contourStyles[id]).toBeUndefined();
    expect(hasContourOverrides(clip)).toBe(false);
    expect(contourOverlay(clip, id)).toBeUndefined();
  });

  it("clearing one of two overrides keeps the other", () => {
    const { clip } = clipWith();
    const id = clip.subpaths[0]!.id;
    setContourOverride(clip, id, "opacity", 0.5);
    setContourOverride(clip, id, `fill.${clip.fills[0]!.id}.color`, "#00ff00");
    clearContourOverride(clip, id, "opacity");
    expect(hex(resolveContourStyle(clip, id).fills[0])).toBe("#00ff00");
    expect(resolveContourStyle(clip, id).opacity).toBe(clip.opacity);
  });

  it("clearContourStyle drops everything for one contour", () => {
    const { clip } = clipWith();
    setContourOverride(clip, clip.subpaths[0]!.id, "opacity", 0.5);
    clearContourStyle(clip, clip.subpaths[0]!.id);
    expect(hasContourOverrides(clip)).toBe(false);
  });
});

describe("pruning", () => {
  it("a deleted contour takes its override with it — at the ONE geometry seam", () => {
    // `editPathGeometry` is where every geometry write goes, so an orphaned
    // override is impossible rather than merely unlikely.
    const { clip } = clipWith();
    const gone = clip.subpaths[1]!.id;
    setContourOverride(clip, gone, "opacity", 0.5);
    editPathGeometry(clip, (subs) => {
      subs.splice(1, 1);
    });
    expect(clip.contourStyles[gone]).toBeUndefined();
  });

  it("pruning is idempotent and leaves live entries alone", () => {
    const { clip } = clipWith();
    const keep = clip.subpaths[0]!.id;
    setContourOverride(clip, keep, "opacity", 0.5);
    pruneContourStyles(clip);
    pruneContourStyles(clip);
    expect(clip.contourStyles[keep]).toBeDefined();
  });
});

describe("overrides survive separation", () => {
  it("promotion BAKES a piece's override into its own real fields", () => {
    // Paths and clip properties are one vocabulary, so nothing is translated:
    // an override made before the split is an override you have after it.
    const { doc, clip } = clipWith();
    const fillId = clip.fills[0]!.id;
    setContourOverride(clip, clip.subpaths[1]!.id, `fill.${fillId}.color`, "#00ff00");
    const res = promotePathClip(doc, clip.id)!;
    const colors = res.pieceIds.map((id) => {
      const c = locateClip(doc, id)!.clip;
      return c.kind === "path" ? hex(c.fills[0]) : null;
    });
    expect(colors.sort()).toEqual(["#00ff00", "#ff0000"]);
    // Baked, not still a diff: the piece IS green now.
    for (const id of res.pieceIds) {
      const c = locateClip(doc, id)!.clip;
      expect(c.kind === "path" && hasContourOverrides(c)).toBe(false);
    }
  });

  it("extraction bakes the same way", () => {
    const { doc, clip } = clipWith();
    const fillId = clip.fills[0]!.id;
    const takeId = clip.subpaths[1]!.id;
    setContourOverride(clip, takeId, `fill.${fillId}.color`, "#00ff00");
    const id = extractContours(doc, clip.id, [takeId])!;
    const piece = locateClip(doc, id)!.clip;
    expect(piece.kind === "path" ? hex(piece.fills[0]) : null).toBe("#00ff00");
    // …and the remainder forgot an override it no longer owns.
    const rest = locateClip(doc, clip.id)!.clip;
    expect(rest.kind === "path" && hasContourOverrides(rest)).toBe(false);
  });
});

describe("bakeContourStyle", () => {
  it("does nothing for an empty or absent overlay", () => {
    const { clip } = clipWith();
    const before = JSON.stringify(clip.fills);
    bakeContourStyle(clip, undefined);
    expect(JSON.stringify(clip.fills)).toBe(before);
  });
});

/**
 * A drawn stroke's PRESSURE is an override like any other, and this is the
 * property that made the overlay carry its first non-scalar value. Pinned
 * because the alternative — a `widths` array on the contour itself — would have
 * to be resampled by every geometry op, and the reason it was rejected is only
 * defensible while this path actually works.
 */
describe("a contour carries the pressure it was drawn with", () => {
  it("resolves a measured width curve that its layer does not have", () => {
    const { clip } = clipWith(2);
    const line = clip.strokes[0]!;
    const drawn = clip.subpaths[0]!.id;
    const inherits = clip.subpaths[1]!.id;

    expect(resolveContourStyle(clip, drawn).strokes[0]!.profile.samples).toBeNull();
    setContourOverride(clip, drawn, `stroke.${line.id}.profile.samples`, [0.2, 1, 0.4]);

    expect(resolveContourStyle(clip, drawn).strokes[0]!.profile.samples).toEqual([0.2, 1, 0.4]);
    // The layer itself is untouched, so the contour beside it still inherits
    // plain ink — which is the whole point of an overlay over a snapshot.
    expect(clip.strokes[0]!.profile.samples).toBeNull();
    expect(resolveContourStyle(clip, inherits).strokes[0]!.profile.samples).toBeNull();
  });

  it("keeps the curve when the piece becomes its own layer", () => {
    const { doc, clip } = clipWith(2);
    const line = clip.strokes[0]!;
    setContourOverride(clip, clip.subpaths[0]!.id, `stroke.${line.id}.profile.samples`, [0, 1]);

    const target = createPathClip({ frameId: clip.frameId, subpaths: [], startMs: 0, name: "Piece" });
    target.strokes = clip.strokes.map((s) => ({ ...s, profile: { ...s.profile } }));
    bakeContourStyle(target, contourOverlay(clip, clip.subpaths[0]!.id));
    expect(target.strokes[0]!.profile.samples).toEqual([0, 1]);
    expect(doc).toBeTruthy();
  });

  it("an empty curve means 'no measurement', not an empty one", () => {
    const { clip } = clipWith(1);
    const line = clip.strokes[0]!;
    setContourOverride(clip, clip.subpaths[0]!.id, `stroke.${line.id}.profile.samples`, []);
    expect(resolveContourStyle(clip, clip.subpaths[0]!.id).strokes[0]!.profile.samples).toBeNull();
  });

  it("a curve naming a stroke the layer no longer has is inert, not corrupt", () => {
    const { clip } = clipWith(1);
    setContourOverride(clip, clip.subpaths[0]!.id, `stroke.gone.profile.samples`, [0.5, 1]);
    const style = resolveContourStyle(clip, clip.subpaths[0]!.id);
    expect(style.strokes[0]!.profile.samples).toBeNull();
  });
});

/**
 * A DRAWN stroke keeps the brush it was drawn with. The layer is the group it
 * lands in, not the source of its look — so the live preview and the committed
 * result are the same picture, and two colours can live in one drawing.
 */
describe("a contour can carry its own ink", () => {
  const ink = (color: string, samples: number[] | null = null) => ({
    fills: [],
    strokes: [{
      ...solidStroke(color),
      profile: { startWidth: 1, endWidth: 1, startLength: 0.5, endLength: 0.5, ease: 0, samples },
    }],
  });

  it("stops inheriting the layer's stack entirely", () => {
    const { clip } = clipWith(2);
    const [drawn, other] = [clip.subpaths[0]!.id, clip.subpaths[1]!.id];
    setContourInk(clip, drawn, ink("#ff0000"));

    const mine = resolveContourStyle(clip, drawn);
    expect(mine.strokes).toHaveLength(1);
    expect(hex(mine.strokes[0]!.paint)).toBe("#ff0000");
    // The layer, and everything still listening to it, is untouched.
    expect(hex(resolveContourStyle(clip, other).strokes[0]!.paint)).toBe(hex(clip.strokes[0]!.paint));
  });

  it("ink that matches the layer's goes back to inheriting, so the common drawing has no overrides", () => {
    const { clip } = clipWith(2);
    const same = { fills: [...clip.fills], strokes: [...clip.strokes] };
    setContourInk(clip, clip.subpaths[0]!.id, same);
    expect(hasContourOverrides(clip)).toBe(false);

    // …and it is compared by what it PAINTS, not by identity: a stack rebuilt
    // from the same brush mints fresh ids every time.
    const reborn = {
      fills: clip.fills.map((f) => ({ ...f, id: "new_fill" })),
      strokes: clip.strokes.map((s) => ({ ...s, id: "new_stroke" })),
    };
    setContourInk(clip, clip.subpaths[0]!.id, reborn);
    expect(hasContourOverrides(clip)).toBe(false);
  });

  it("changing back to the layer's ink un-overrides the contour", () => {
    const { clip } = clipWith(1);
    const id = clip.subpaths[0]!.id;
    setContourInk(clip, id, ink("#00ff00"));
    expect(hasContourOverrides(clip)).toBe(true);
    setContourInk(clip, id, { fills: [...clip.fills], strokes: [...clip.strokes] });
    expect(hasContourOverrides(clip)).toBe(false);
  });

  it("carries its pressure and its colour together into its own layer", () => {
    const { clip } = clipWith(2);
    const id = clip.subpaths[0]!.id;
    setContourInk(clip, id, ink("#0000ff", [0, 1, 0.3]));

    const target = createPathClip({ frameId: clip.frameId, subpaths: [], startMs: 0, name: "Piece" });
    target.strokes = clip.strokes.map((st) => ({ ...st }));
    target.fills = clip.fills.map((f) => ({ ...f }));
    bakeContourStyle(target, contourOverlay(clip, id));
    expect(target.strokes).toHaveLength(1);
    expect(hex(target.strokes[0]!.paint)).toBe("#0000ff");
    expect(target.strokes[0]!.profile.samples).toEqual([0, 1, 0.3]);
  });

  it("keeps the ink of a contour that lives only in a geometry KEY", () => {
    // The bug that made "the width just vanishes" happen in one project and not
    // another. A morphing layer's outline is a keyframe VALUE, not
    // `clip.subpaths` — so pruning against the resting outline deleted the
    // style of every stroke drawn onto it, and the stroke silently fell back to
    // the layer's ink. Whether it bit you depended on whether that layer had
    // ever been keyed.
    const { clip } = clipWith(1);
    const keyed = { ...box(0, 0, 20, 20), id: "sub_keyed" };
    clip.keyframes.push({
      id: "k",
      property: "geometry",
      range: null,
      keys: [{ id: "k0", timeMs: 0, value: [keyed] as never, easing: "linear" as never }],
    });
    setContourInk(clip, keyed.id, ink("#00ff00"));
    pruneContourStyles(clip);
    expect(hex(resolveContourStyle(clip, keyed.id).strokes[0]!.paint)).toBe("#00ff00");
  });

  it("leaves a contour's other overrides alone when its ink goes back to the layer", () => {
    const { clip } = clipWith(1);
    const id = clip.subpaths[0]!.id;
    setContourOverride(clip, id, "opacity", 0.5);
    setContourInk(clip, id, ink("#ff0000"));
    clearContourInk(clip, id);
    expect(resolveContourStyle(clip, id).opacity).toBe(0.5);
    expect(hex(resolveContourStyle(clip, id).strokes[0]!.paint)).toBe(hex(clip.strokes[0]!.paint));
  });
});
