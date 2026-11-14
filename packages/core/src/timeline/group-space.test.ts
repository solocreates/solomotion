import { describe, it, expect } from "vitest";
import { createCarrierTrack, createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { groupClips, groupOfClip } from "./groups";
import { clipBox, locateClip, remapClipRefsAfterCopy, reissueClipIds } from "./ops";
import {
  groupChainMatrix,
  groupChainPlacement,
  groupDeltaMatrix,
  groupPivotLocal,
  groupPivotPlaced,
  holdStillShift,
  pivotModel,
  repivotClip,
  groupMatrixOf,
  positionOrigin,
  shiftToPin,
} from "./group-space";
import { sampleKeyframes } from "../animation/keyframes";
import { apply, IDENTITY } from "../navigation/matrix";
import type { MotionDocument, Clip, GroupClip, ShapeClip } from "../schema";

const frameIdOf = (d: MotionDocument) => d.frames[0]!.id;

/** Shapes at given centres, each on its own lane. */
function shapes(doc: MotionDocument, at: Array<{ x: number; y: number; w?: number; h?: number }>): ShapeClip[] {
  return at.map((p, i) => {
    const c = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0 }) as ShapeClip;
    c.width = p.w ?? 100;
    c.height = p.h ?? 100;
    c.transform.x = p.x;
    c.transform.y = p.y;
    c.durationMs = 1000;
    const lane = createTrack(`l${i}`);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  });
}

const groupOf = (d: MotionDocument, id: string) => locateClip(d, id)!.clip as GroupClip;
const at0 = () => 0;

describe("a group's pivot is a real point", () => {
  it("sits at the centre of what it holds, not at the comp's centre", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    // Two 100×100 squares centred at x=100 and x=300 → union centre x=200.
    const [a, b] = shapes(doc, [{ x: 100, y: 0 }, { x: 300, y: 0 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const group = groupOf(doc, gid);

    expect(clipBox(doc, group).cx).toBe(200);
    expect(groupPivotLocal(doc, group, 0)).toEqual({ x: 200, y: 0 });
    // Nothing has moved it yet, so the placed pivot is the same point.
    expect(groupPivotPlaced(doc, group, 0)).toEqual({ x: 200, y: 0 });
  });

  it("travels with the group's own translation, and only by that", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 100, y: 0 }, { x: 300, y: 0 }]);
    const group = groupOf(doc, groupClips(doc, [a!.id, b!.id])!);
    group.transform.x = 40;
    group.transform.y = -25;
    expect(groupPivotPlaced(doc, group, 0)).toEqual({ x: 240, y: -25 });
    // …and it stays the FIXED POINT of the group's own matrix, which is what
    // makes it the thing rotation and scale actually happen about.
    group.transform.rotation = 33;
    group.transform.scale = 2.4;
    const m = groupDeltaMatrix(doc, group, 0)!;
    const placed = groupPivotPlaced(doc, group, 0);
    const mapped = apply(m, { x: 200, y: 0 }); // the pivot before translation
    expect(mapped.x).toBeCloseTo(placed.x, 6);
    expect(mapped.y).toBeCloseTo(placed.y, 6);
  });

  it("a group with no transform contributes no matrix at all", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    const group = groupOf(doc, groupClips(doc, [a!.id, b!.id])!);
    expect(groupDeltaMatrix(doc, group, 0)).toBeNull();
    expect(groupChainMatrix(doc, a!.id, at0)).toEqual(IDENTITY);
  });
});

describe("the group chain places what is inside it", () => {
  it("carries a member's own position through every enclosing group", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 100, y: 0 }, { x: 300, y: 0 }]);
    const inner = groupOf(doc, groupClips(doc, [a!.id, b!.id])!);
    inner.transform.x = 10;
    const outer = groupOf(doc, groupClips(doc, [inner.id], "Outer")!);
    outer.transform.x = 5;

    const m = groupChainMatrix(doc, a!.id, at0);
    // Member sits at x=100; inner shifts +10, outer shifts +5.
    expect(apply(m, { x: 100, y: 0 }).x).toBeCloseTo(115, 6);
    // Scale composes multiplicatively, rotation additively.
    inner.transform.scale = 2;
    outer.transform.scale = 3;
    outer.transform.rotation = 10;
    inner.transform.rotation = 20;
    const p = groupChainPlacement(doc, a!.id, at0);
    expect(p.scaleX).toBeCloseTo(6, 6);
    expect(p.rotation).toBeCloseTo(30, 6);
  });

  it("a scaled group moves its members' handles, which is the misplacement", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    const group = groupOf(doc, groupClips(doc, [a!.id, b!.id])!);
    group.transform.scale = 2; // pivot is the union centre, x=100
    const m = groupChainMatrix(doc, a!.id, at0);
    // `a` is 100 left of the pivot; doubling puts it 200 left.
    expect(apply(m, { x: 0, y: 0 }).x).toBeCloseTo(-100, 6);
    // Without the chain a control would have drawn it at x=0 — 100 units off,
    // which is exactly the gap between the selection box and the handles.
  });
});

describe("moving a pivot never moves the art", () => {
  const poseOf = (c: Clip) => {
    const t = (c as ShapeClip).transform;
    return {
      x: t.x, y: t.y, scale: t.scale, scaleY: t.scaleY ?? t.scale,
      rotation: t.rotation, skewX: t.skewX, skewY: t.skewY, anchor: t.anchor,
    };
  };

  it("an unrotated, unscaled GROUP needs no correction at all", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    const group = groupOf(doc, groupClips(doc, [a!.id, b!.id])!);
    group.transform.x = 30;
    const model = pivotModel(doc, group, poseOf(group))!;
    // Drag the pivot to the box's left edge: the group must not budge.
    expect(model.holdStill({ x: 0, y: 0.5 })).toEqual({ x: 0, y: 0 });
    // The old leaf formula would have shifted it by the pivot's own travel —
    // which is the jump you see when you grab a group's crosshair.
  });

  it("a ROTATED group moves only by what its linear map does not absorb", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    const group = groupOf(doc, groupClips(doc, [a!.id, b!.id])!);
    group.transform.rotation = 90;
    const before = groupDeltaMatrix(doc, group, 0)!;
    const model = pivotModel(doc, group, poseOf(group))!;
    const next = { x: 0, y: 0.5 };
    const shift = model.holdStill(next);
    // Apply the correction and the picture is untouched: a corner of the art
    // maps to the same world point under the new pivot.
    group.transform.anchor = next;
    group.transform.x += shift.x;
    group.transform.y += shift.y;
    const after = groupDeltaMatrix(doc, group, 0)!;
    for (const q of [{ x: -50, y: -50 }, { x: 250, y: 50 }]) {
      expect(apply(after, q).x).toBeCloseTo(apply(before, q).x, 6);
      expect(apply(after, q).y).toBeCloseTo(apply(before, q).y, 6);
    }
  });

  it("a LEAF layer still moves its position with its pivot", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a] = shapes(doc, [{ x: 60, y: 20, w: 200, h: 100 }]);
    const model = pivotModel(doc, a!, poseOf(a!))!;
    // Pivot to the left edge: the position has to follow by half the width.
    expect(model.holdStill({ x: 0, y: 0.5 }).x).toBeCloseTo(-100, 6);
  });

  it("holdStillShift reads the correction straight off two matrices", () => {
    const before = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 4 };
    const after = { a: 2, b: 0, c: 0, d: 2, e: 25, f: -6 };
    expect(holdStillShift(before, after)).toEqual({ x: -15, y: 10 });
  });
});

describe("a pasted group keeps what was inside it", () => {
  /**
   * What a paste does before the remap: every copy rides a fresh carrier
   * scoped to the SOURCE clip's group, exactly as `placeClip` seats it.
   */
  const seat = (doc: MotionDocument, copies: Clip[], scopeOf: (copyId: string) => string | null) => {
    for (const c of copies) {
      const lane = createCarrierTrack(undefined, c.frameId);
      lane.groupId = scopeOf(c.id);
      lane.clips.push(c);
      doc.tracks.push(lane);
    }
  };

  it("membership survives the comp change when the group came along", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const source: Clip[] = [groupOf(doc, gid), locateClip(doc, a!.id)!.clip, locateClip(doc, b!.id)!.clip];
    const sourceScope = new Map(source.map((sc) => [sc.id, groupOfClip(doc, sc.id)]));

    // Paste into a different comp: every copy is re-framed.
    const idMap = new Map<string, string>();
    const copies = source.map((sc) => {
      const c = reissueClipIds(sc);
      c.frameId = "frame_elsewhere";
      idMap.set(sc.id, c.id);
      return c;
    });
    const back = new Map([...idMap].map(([from, to]) => [to, from]));
    seat(doc, copies, (id) => sourceScope.get(back.get(id)!) ?? null);
    remapClipRefsAfterCopy(doc, copies, idMap, new Set(copies.map((c) => c.id)));

    const newGroup = copies.find((c) => c.kind === "group")!;
    const members = copies.filter((c) => c.kind !== "group" && c.kind !== "audio");
    expect(members.length).toBe(2);
    for (const m of members) expect(groupOfClip(doc, m.id)).toBe(newGroup.id);
    expect(groupOfClip(doc, newGroup.id)).toBeNull();
  });

  it("but a membership the paste did NOT carry is dropped across comps", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    // Copy ONE member, leaving its group behind.
    const idMap = new Map<string, string>();
    const lone = reissueClipIds(locateClip(doc, a!.id)!.clip);
    lone.frameId = "frame_elsewhere";
    idMap.set(a!.id, lone.id);
    seat(doc, [lone], () => gid);
    remapClipRefsAfterCopy(doc, [lone], idMap, new Set([lone.id]));
    expect(groupOfClip(doc, lone.id)).toBeNull();
  });

  it("and a copy that stays put keeps its membership untouched", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const idMap = new Map<string, string>();
    const lone = reissueClipIds(locateClip(doc, a!.id)!.clip);
    idMap.set(a!.id, lone.id);
    seat(doc, [lone], () => gid);
    remapClipRefsAfterCopy(doc, [lone], idMap, new Set()); // same comp — not reframed
    expect(groupOfClip(doc, lone.id)).toBe(gid);
  });
});

describe("re-pivoting an ANIMATED layer keeps its whole motion", () => {
  const poseOfClip = (c: Clip) => (ms: number) => {
    const t = (c as ShapeClip).transform;
    const kf = Object.fromEntries(
      (c.keyframes ?? []).map((k) => [
        k.property,
        k.keys.reduce((acc, key) => (key.timeMs <= ms ? key.value : acc), k.keys[0]?.value),
      ]),
    ) as Record<string, number>;
    const n = (k: string, d: number) => (typeof kf[k] === "number" ? kf[k] : d);
    const scale = n("scale", t.scale);
    return {
      x: n("x", t.x), y: n("y", t.y), scale,
      scaleY: t.scaleY == null ? scale : n("scaleY", t.scaleY),
      rotation: n("rotation", t.rotation), skewX: t.skewX, skewY: t.skewY,
      anchor: { x: n("anchor.x", t.anchor.x), y: n("anchor.y", t.anchor.y) },
    };
  };

  it("moves EVERY position key, not just the base value", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a] = shapes(doc, [{ x: 0, y: 0, w: 200, h: 100 }]);
    const clip = a!;
    clip.transform.rotation = 0;
    // A motion path: x animates 0 → 400.
    clip.keyframes.push({
      property: "x" as const,
      keys: [
        { timeMs: 0, value: 0, easing: { kind: "linear" as const } },
        { timeMs: 500, value: 400, easing: { kind: "linear" as const } },
      ],
    } as never);

    const before = clip.keyframes[0]!.keys.map((k) => k.value);
    expect(repivotClip(doc, clip, { x: 0, y: 0.5 }, poseOfClip(clip), 0)).toBe(true);
    const after = clip.keyframes[0]!.keys.map((k) => k.value);

    // A leaf's position follows its pivot, so BOTH keys shift by half the width.
    expect(after[0]).toBeCloseTo((before[0] as number) - 100, 6);
    expect(after[1]).toBeCloseTo((before[1] as number) - 100, 6);
    // The path keeps its SHAPE — that is the whole promise. Leaving the keys
    // alone (the old behaviour) changed the travel from 400 to 300.
    expect((after[1] as number) - (after[0] as number)).toBeCloseTo(400, 6);
    expect(clip.transform.anchor).toEqual({ x: 0, y: 0.5 });
  });

  it("an unrotated GROUP's keys do not move at all", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    const group = groupOf(doc, groupClips(doc, [a!.id, b!.id])!);
    group.keyframes.push({
      property: "x" as const,
      keys: [
        { timeMs: 0, value: 0, easing: { kind: "linear" as const } },
        { timeMs: 500, value: 300, easing: { kind: "linear" as const } },
      ],
    } as never);
    repivotClip(doc, group, { x: 0, y: 0 }, poseOfClip(group), 0);
    expect(group.keyframes[0]!.keys.map((k) => k.value)).toEqual([0, 300]);
    expect(group.transform.x).toBe(0);
  });
});

describe("a group's size is its ARTWORK's bounds", () => {
  it("does not change when a member's pivot moves", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 0, y: 0, w: 200, h: 100 }, { x: 400, y: 0, w: 200, h: 100 }]);
    const group = groupOf(doc, groupClips(doc, [a!.id, b!.id])!);
    const before = clipBox(doc, group);

    // Re-pivot a child to its own left edge. The art holds still, so the
    // group's box must be byte-for-byte what it was.
    const poseOf = (c: Clip) => () => {
      const t = (c as ShapeClip).transform;
      return { x: t.x, y: t.y, scale: t.scale, scaleY: t.scaleY ?? t.scale,
               rotation: t.rotation, skewX: t.skewX, skewY: t.skewY, anchor: t.anchor };
    };
    repivotClip(doc, a!, { x: 0, y: 0.5 }, poseOf(a!), 0);
    // The position DID move (a leaf's position follows its pivot)…
    expect(a!.transform.x).toBeCloseTo(-100, 6);
    // …and the group's box did NOT, because the artwork did not.
    const after = clipBox(doc, group);
    expect(after.cx).toBeCloseTo(before.cx, 6);
    expect(after.cy).toBeCloseTo(before.cy, 6);
    expect(after.width).toBeCloseTo(before.width, 6);
    expect(after.height).toBeCloseTo(before.height, 6);
  });

  it("grows to hold a ROTATED member's real extent", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a] = shapes(doc, [{ x: 0, y: 0, w: 200, h: 100 }]);
    const group = groupOf(doc, groupClips(doc, [a!.id], "G")!);
    expect(clipBox(doc, group).width).toBeCloseTo(200, 6);
    a!.transform.rotation = 90;
    // Turned on its side, a 200×100 rect occupies 100×200.
    const turned = clipBox(doc, group);
    expect(turned.width).toBeCloseTo(100, 6);
    expect(turned.height).toBeCloseTo(200, 6);
  });

  it("and to hold a SCALED member", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a] = shapes(doc, [{ x: 0, y: 0, w: 200, h: 100 }]);
    const group = groupOf(doc, groupClips(doc, [a!.id], "G")!);
    a!.transform.scale = 2;
    expect(clipBox(doc, group).width).toBeCloseTo(400, 6);
  });
});

describe("scaling a group pins what the drag is anchored on", () => {
  it("the opposite corner does not move", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    const group = groupOf(doc, groupClips(doc, [a!.id, b!.id])!);
    const box = clipBox(doc, group);
    const pivot = { x: box.cx, y: box.cy };
    const base = {
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0,
      anchor: group.transform.anchor,
    };
    // Drag the bottom-right handle: the TOP-LEFT corner is the anchor.
    const q = { x: box.cx - box.width / 2, y: box.cy - box.height / 2 };
    const before = groupMatrixOf(base, pivot);
    const after = groupMatrixOf({ ...base, scaleX: 2, scaleY: 2 }, pivot);
    const pin = shiftToPin(before, after, q);

    const pinned = groupMatrixOf({ ...base, x: pin.x, y: pin.y, scaleX: 2, scaleY: 2 }, pivot);
    expect(apply(pinned, q).x).toBeCloseTo(apply(before, q).x, 6);
    expect(apply(pinned, q).y).toBeCloseTo(apply(before, q).y, 6);
    // And it is genuinely a correction — a doubling about the centre moves that
    // corner by half the box, so doing nothing would NOT have pinned it.
    expect(Math.hypot(pin.x, pin.y)).toBeGreaterThan(1);
  });
});

describe("positionOrigin — what `transform.x/y` means, per placement model", () => {
  it("is nothing for a leaf: its position IS its pivot", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a] = shapes(doc, [{ x: 100, y: 40 }]);
    expect(positionOrigin(doc, a!, 0)).toEqual({ x: 0, y: 0 });
  });

  it("is the pivot for a group: its position is a DELTA about it", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 100, y: 0 }, { x: 300, y: 0 }]);
    const group = groupOf(doc, groupClips(doc, [a!.id, b!.id])!);
    group.transform.x = 40;
    group.transform.y = -25;
    // Position + origin IS the placed pivot — which is what every surface that
    // draws a point from a position channel has to add, and what the crosshair
    // and the motion path each had to be taught separately before this existed.
    const o = positionOrigin(doc, group, 0);
    const placed = groupPivotPlaced(doc, group, 0);
    expect({ x: group.transform.x + o.x, y: group.transform.y + o.y }).toEqual(placed);
  });
});

describe("repivotClip carries the motion path with the pivot", () => {
  /** A leaf that travels: three position keys along a diagonal. */
  function travelling(doc: MotionDocument): ShapeClip {
    const [c] = shapes(doc, [{ x: 0, y: 0 }]);
    const clip = c!;
    clip.keyframes.push(
      { id: "kx", property: "x" as const, range: null, keys: [
        { id: "a", timeMs: 0, value: 0, easing: { kind: "linear" as const } },
        { id: "b", timeMs: 500, value: 200, easing: { kind: "linear" as const } },
        { id: "c", timeMs: 1000, value: 400, easing: { kind: "linear" as const } },
      ] },
      { id: "ky", property: "y" as const, range: null, keys: [
        { id: "d", timeMs: 0, value: 0, easing: { kind: "linear" as const } },
        { id: "e", timeMs: 500, value: 100, easing: { kind: "linear" as const } },
        { id: "f", timeMs: 1000, value: 0, easing: { kind: "linear" as const } },
      ] },
    );
    return clip;
  }

  const poseOf = (clip: Clip) => (ms: number) => {
    const c = clip as ShapeClip;
    const s = sampleKeyframes(c.keyframes, ms);
    const n = (k: string, d: number) => (typeof s[k] === "number" ? (s[k] as number) : d);
    const scale = n("scale", c.transform.scale);
    return {
      x: n("x", c.transform.x),
      y: n("y", c.transform.y),
      scale,
      scaleY: c.transform.scaleY == null ? scale : n("scaleY", c.transform.scaleY),
      rotation: n("rotation", c.transform.rotation),
      skewX: n("skewX", c.transform.skewX),
      skewY: n("skewY", c.transform.skewY),
      anchor: { x: n("anchor.x", c.transform.anchor.x), y: n("anchor.y", c.transform.anchor.y) },
    };
  };

  const keysOf = (clip: ShapeClip, prop: string) =>
    clip.keyframes.find((t) => t.property === prop)!.keys.map((k) => k.value as number);

  /**
   * THE PROMISE: the path travels as ONE PIECE. Every key moves by the same
   * vector, so the curve you drew keeps its shape and simply follows the pivot —
   * which is what anyone watching means by "move the anchor point".
   */
  it("translates every key by the same vector when nothing shapes the map", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const clip = travelling(doc);
    const x0 = keysOf(clip, "x");
    const y0 = keysOf(clip, "y");

    repivotClip(doc, clip, { x: 0, y: 0 }, poseOf(clip), 0, clipBox(doc, clip));

    const dx = keysOf(clip, "x").map((v, i) => v - x0[i]!);
    const dy = keysOf(clip, "y").map((v, i) => v - y0[i]!);
    // A 100×100 box, pivot from the centre to the top-left: −50, −50.
    expect(dx).toEqual([-50, -50, -50]);
    expect(dy).toEqual([-50, -50, -50]);
    // …and the base moved with them, so an un-keyed frame agrees with a keyed one.
    expect(clip.transform.x).toBe(-50);
  });

  /**
   * …and when rotation IS animated the keys genuinely part company, because
   * holding the art still at every instant is the stronger promise. Stated as a
   * test so nobody "fixes" the fast path into applying everywhere.
   */
  it("corrects each key by its own amount once the linear map is animated", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const clip = travelling(doc);
    clip.keyframes.push({ id: "kr", property: "rotation" as const, range: null, keys: [
      { id: "g", timeMs: 0, value: 0, easing: { kind: "linear" as const } },
      { id: "h", timeMs: 1000, value: 90, easing: { kind: "linear" as const } },
    ] });
    const x0 = keysOf(clip, "x");

    repivotClip(doc, clip, { x: 0, y: 0 }, poseOf(clip), 0, clipBox(doc, clip));

    const dx = keysOf(clip, "x").map((v, i) => v - x0[i]!);
    expect(dx[0]).toBeCloseTo(-50, 6);
    // A quarter turn later the same local offset points the other way.
    expect(dx[2]).toBeCloseTo(50, 6);
  });

  it("holds a GROUP still while its pivot travels", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, [{ x: 100, y: 0 }, { x: 300, y: 0 }]);
    const group = groupOf(doc, groupClips(doc, [a!.id, b!.id])!);
    group.transform.rotation = 30;
    group.transform.scale = 1.5;
    const box = clipBox(doc, group);
    const before = groupDeltaMatrix(doc, group, 0)!;
    const probe = { x: 137, y: -64 };
    const was = apply(before, probe);

    repivotClip(doc, group, { x: 0.15, y: 0.9 }, poseOf(group), 0, box);

    const now = apply(groupDeltaMatrix(doc, group, 0)!, probe);
    expect(now.x).toBeCloseTo(was.x, 6);
    expect(now.y).toBeCloseTo(was.y, 6);
  });
});
