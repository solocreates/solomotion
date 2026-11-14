import { describe, expect, it } from "vitest";
import type { Contour, Subpath } from "../schema";
import { adoptContours, healContourIds, lendIdentity, nodeKey, parseNodeKey, resolveNode, toSubpath } from "./contour-id";

const pt = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });
const run = (id: string, x = 0): Subpath => ({
  id,
  closed: true,
  points: [pt(x, 0), pt(x + 10, 0), pt(x + 10, 10)],
});

describe("healContourIds", () => {
  it("re-mints DUPLICATE ids — the state every structural op produces", () => {
    // A split builds both halves by spreading the run it came from, so they
    // arrive wearing one id. This is the repair that lets ops stay unaware.
    const host = { subpaths: [run("dup"), run("dup", 20)] };
    healContourIds(host);
    expect(host.subpaths[0]!.id).not.toBe(host.subpaths[1]!.id);
  });

  it("mints for contours that arrive with none", () => {
    const host = { subpaths: [{ closed: true, points: [pt(0, 0)] } as unknown as Subpath] };
    healContourIds(host);
    expect(host.subpaths[0]!.id).toBeTruthy();
  });

  it("leaves a healthy layer exactly as it was", () => {
    const host = { subpaths: [run("a"), run("b", 20)] };
    const before = JSON.stringify(host);
    healContourIds(host);
    expect(JSON.stringify(host)).toBe(before);
  });
});

describe("lendIdentity", () => {
  it("hands a computed outline the identity of the one it replaces", () => {
    // A morph key, a bake and a refit all describe the same art at a different
    // moment, so identity carries positionally — the same correspondence the
    // morph itself requires.
    const declared = [run("a"), run("b", 20)];
    const computed: Contour[] = declared.map((s) => ({ closed: s.closed, points: s.points }));
    expect(lendIdentity(declared, computed).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("mints for contours past the end — those are genuinely new", () => {
    const lent = lendIdentity([run("a")], [
      { closed: true, points: [pt(0, 0)] },
      { closed: true, points: [pt(1, 1)] },
    ]);
    expect(lent[0]!.id).toBe("a");
    expect(lent[1]!.id).not.toBe("a");
  });
});

describe("adoptContours", () => {
  it("gives a freshly computed outline a home, with distinct ids", () => {
    const host = { subpaths: [] as Subpath[] };
    adoptContours(host, [
      { closed: true, points: [pt(0, 0)] },
      { closed: true, points: [pt(1, 1)] },
    ]);
    expect(new Set(host.subpaths.map((s) => s.id)).size).toBe(2);
  });
});

describe("toSubpath", () => {
  it("keeps the geometry and adds only identity", () => {
    const c: Contour = { closed: false, points: [pt(0, 0), pt(5, 5)] };
    const s = toSubpath(c);
    expect(s.points).toBe(c.points);
    expect(s.closed).toBe(false);
    expect(s.id).toBeTruthy();
  });
});

describe("node keys address geometry, not array positions", () => {
  const sub = (id: string, n: number) => ({
    id,
    closed: false,
    points: Array.from({ length: n }, (_, i) => ({ x: i, y: 0, hIn: null, hOut: null })),
  });

  it("survives the contour being renumbered by a structural edit", () => {
    const clip = { subpaths: [sub("sub_a", 3), sub("sub_b", 3)] };
    const key = nodeKey("sub_b", 1);
    expect(resolveNode(clip, key)!.subIndex).toBe(1);
    // A split inserts ahead of it; the key still names the same anchor.
    clip.subpaths.unshift(sub("sub_c", 2));
    expect(resolveNode(clip, key)!.subIndex).toBe(2);
    expect(resolveNode(clip, key)!.index).toBe(1);
  });

  it("is null once the contour or the point is gone", () => {
    const clip = { subpaths: [sub("sub_a", 3)] };
    expect(resolveNode(clip, nodeKey("sub_gone", 0))).toBeNull();
    expect(resolveNode(clip, nodeKey("sub_a", 9))).toBeNull();
    expect(parseNodeKey("nocolon")).toBeNull();
  });

  it("round-trips an id that itself contains a colon", () => {
    expect(parseNodeKey(nodeKey("we:ird", 4))).toEqual({ contourId: "we:ird", index: 4 });
  });
});
