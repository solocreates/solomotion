import { describe, expect, it } from "vitest";
import type { Contour, Subpath } from "../schema/vector";
import {
  anchorAtSite,
  penIntent,
  penMark,
  penIntentHint,
  pickPenLanding,
  weldRun,
  type PenLanding,
} from "./pen";
import { pruneWelds, weldGroup, weldIdAt, weldNodes } from "./edit-engine";

const pt = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });
let n = 0;
const open = (...xs: Array<[number, number]>): Subpath => ({
  id: `s${n++}`,
  closed: false,
  points: xs.map(([x, y]) => pt(x, y)),
});
const landing = (over: Partial<PenLanding> = {}): PenLanding => ({
  clipId: "c",
  site: { kind: "anchor", sub: 0, index: 0 },
  end: null,
  ...over,
});

describe("pickPenLanding", () => {
  it("prefers an anchor over a nearer segment — the node you can see is the one you meant", () => {
    const anchor = landing({ site: { kind: "anchor", sub: 0, index: 2 } });
    const seg = landing({ site: { kind: "segment", sub: 0, index: 0, t: 0.5 } });
    expect(pickPenLanding([{ landing: seg, dist: 0.2 }, { landing: anchor, dist: 5 }])).toBe(anchor);
  });

  it("falls back to the nearest within one class", () => {
    const a = landing({ site: { kind: "segment", sub: 0, index: 0, t: 0.1 } });
    const b = landing({ site: { kind: "segment", sub: 1, index: 0, t: 0.9 } });
    expect(pickPenLanding([{ landing: a, dist: 4 }, { landing: b, dist: 1 }])).toBe(b);
  });

  it("is null with no candidates", () => {
    expect(pickPenLanding([])).toBeNull();
  });
});

describe("penIntent", () => {
  it("closes ahead of everything else", () => {
    expect(penIntent({ drawing: true, closing: true, landing: landing() }).kind).toBe("close");
  });

  it("with no run in flight, a landing is somewhere to draw FROM", () => {
    expect(penIntent({ drawing: false, closing: false, landing: landing() }).kind).toBe("resume");
  });

  it("with a run in flight, an open end fuses and anything else attaches", () => {
    expect(penIntent({ drawing: true, closing: false, landing: landing({ end: "tail" }) }).kind).toBe("fuse");
    expect(penIntent({ drawing: true, closing: false, landing: landing() }).kind).toBe("attach");
  });

  it("says nothing over empty canvas", () => {
    expect(penIntentHint(penIntent({ drawing: true, closing: false, landing: null }))).toBe("");
    expect(penIntentHint(penIntent({ drawing: false, closing: false, landing: null }))).toBe("");
  });

  it("distinguishes continuing an end from branching off an interior node", () => {
    expect(penIntentHint(penIntent({ drawing: false, closing: false, landing: landing({ end: "head" }) }))).toBe(
      "Continue path",
    );
    expect(penIntentHint(penIntent({ drawing: false, closing: false, landing: landing() }))).toBe(
      "Branch from point",
    );
  });
});

describe("anchorAtSite", () => {
  it("returns an existing anchor untouched", () => {
    const subs = [open([0, 0], [10, 0], [20, 0])];
    expect(anchorAtSite(subs, { kind: "anchor", sub: 0, index: 1 })).toEqual({ sub: 0, index: 1 });
    expect(subs[0]!.points).toHaveLength(3);
  });

  it("splits a segment into a real anchor without moving the outline", () => {
    const subs = [open([0, 0], [10, 0])];
    const ref = anchorAtSite(subs, { kind: "segment", sub: 0, index: 0, t: 0.5 });
    expect(ref).toEqual({ sub: 0, index: 1 });
    expect(subs[0]!.points).toHaveLength(3);
    expect(subs[0]!.points[1]).toMatchObject({ x: 5, y: 0 });
  });

  it("refuses a segment index the run does not have", () => {
    expect(anchorAtSite([open([0, 0], [10, 0])], { kind: "segment", sub: 0, index: 3, t: 0.5 })).toBeNull();
  });
});

describe("weldRun", () => {
  it("fuses two open runs into ONE continuous path at an open end", () => {
    const subs = [open([0, 0], [10, 0])];
    const run = open([10, 40], [10, 0]); // drawn downward, landing on the tail
    expect(weldRun(subs, run, { kind: "anchor", sub: 0, index: 1 })).toBe(true);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 40],
    ]);
  });

  it("snaps the landing point exactly onto the anchor before fusing", () => {
    const subs = [open([0, 0], [10, 0])];
    const run = open([10, 40], [9.6, 0.3]); // landed a few sub-pixels off
    weldRun(subs, run, { kind: "anchor", sub: 0, index: 1 });
    expect(subs[0]!.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 40],
    ]);
  });

  it("leaves a coincident junction at an INTERIOR node — a third branch is not one run", () => {
    const subs = [open([0, 0], [10, 0], [20, 0])];
    const run = open([10, 40], [10, 0]);
    weldRun(subs, run, { kind: "anchor", sub: 0, index: 1 });
    expect(subs).toHaveLength(2);
    expect(subs[0]!.points).toHaveLength(3); // the trunk is untouched
    expect(subs[1]!.points[1]).toMatchObject({ x: 10, y: 0 }); // the branch meets it exactly
  });

  it("splits the curve first when the run lands mid-segment", () => {
    const subs = [open([0, 0], [20, 0])];
    const run = open([10, 40], [10, 2]);
    weldRun(subs, run, { kind: "segment", sub: 0, index: 0, t: 0.5 });
    expect(subs[0]!.points).toHaveLength(3);
    expect(subs[0]!.points[1]).toMatchObject({ x: 10, y: 0 });
    expect(subs[1]!.points[1]).toMatchObject({ x: 10, y: 0 });
  });

  it("carries the landing point's handle along when it snaps", () => {
    const subs = [open([0, 0], [10, 0])];
    const run: Contour = {
      closed: false,
      points: [pt(10, 40), { x: 8, y: 0, hIn: { x: 8, y: 20 }, hOut: null }],
    };
    weldRun(subs, run, { kind: "anchor", sub: 0, index: 1 });
    // The landing moved +2 in x; its arm has to travel with it, and survive the
    // fuse onto the shared anchor — otherwise the curve kinks at the join.
    expect(subs[0]!.points[1]).toMatchObject({ x: 10, y: 0, hOut: { x: 10, y: 20 } });
  });

  it("reports failure on a site the geometry no longer has", () => {
    expect(weldRun([open([0, 0], [10, 0])], open([0, 5], [10, 5]), { kind: "anchor", sub: 4, index: 0 })).toBe(false);
  });
});

describe("welds — node identity across runs", () => {
  it("makes a junction ONE node: welded points move as a unit", () => {
    const subs = [open([0, 0], [10, 0]), open([10, 0], [10, 10])];
    weldNodes(subs, [{ sub: 0, index: 1 }, { sub: 1, index: 0 }]);
    const group = weldGroup(subs, { sub: 1, index: 0 });
    expect(group).toHaveLength(2);
    expect(group).toContainEqual({ sub: 0, index: 1 });
  });

  it("is identity, not coincidence — anchors that merely share a pixel stay apart", () => {
    const subs = [open([0, 0], [10, 0]), open([10, 0], [10, 10])];
    expect(weldGroup(subs, { sub: 1, index: 0 })).toEqual([{ sub: 1, index: 0 }]);
  });

  it("pulls every member onto one place, so a junction cannot be born split", () => {
    const subs = [open([0, 0], [10, 0]), open([12, 3], [20, 20])];
    weldNodes(subs, [{ sub: 0, index: 1 }, { sub: 1, index: 0 }]);
    expect(subs[1]!.points[0]).toMatchObject({ x: 10, y: 0 });
  });

  it("carries a moved member's handle with it", () => {
    const subs = [open([0, 0], [10, 0]), open([12, 0], [20, 0])];
    subs[1]!.points[0]!.hOut = { x: 16, y: 4 };
    weldNodes(subs, [{ sub: 0, index: 1 }, { sub: 1, index: 0 }]);
    expect(subs[1]!.points[0]!.hOut).toEqual({ x: 14, y: 4 });
  });

  it("grows the existing junction instead of starting a rival one", () => {
    const subs = [open([0, 0], [10, 0]), open([10, 0], [10, 10]), open([10, 0], [20, 10])];
    weldNodes(subs, [{ sub: 0, index: 1 }, { sub: 1, index: 0 }]);
    weldNodes(subs, [{ sub: 1, index: 0 }, { sub: 2, index: 0 }]);
    expect(weldGroup(subs, { sub: 0, index: 1 })).toHaveLength(3);
  });

  it("refuses a group of one — a node welded to nothing is just a node", () => {
    const subs = [open([0, 0], [10, 0])];
    expect(weldNodes(subs, [{ sub: 0, index: 1 }])).toBeNull();
  });

  it("prunes a group back to an ordinary node when its last partner goes", () => {
    const subs = [open([0, 0], [10, 0]), open([10, 0], [10, 10])];
    weldNodes(subs, [{ sub: 0, index: 1 }, { sub: 1, index: 0 }]);
    subs.splice(1, 1);
    pruneWelds(subs);
    expect(subs[0]!.points[1]!.weldId).toBeUndefined();
  });

  it("welds — not merely stacks — when a stroke lands on a CLOSED shape", () => {
    const square: Subpath = { id: "sq", closed: true, points: [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => ({ x: x!, y: y!, hIn: null, hOut: null })) };
    const subs = [square];
    weldRun(subs, open([20, 20], [10, 0]), { kind: "anchor", sub: 0, index: 1 });
    // The square keeps its own shape, and the arrival is ONE node with it.
    expect(subs).toHaveLength(2);
    expect(weldGroup(subs, { sub: 0, index: 1 })).toHaveLength(2);
  });
})

describe("branch starts — the ⊕ adds a point the new line is attached to", () => {
  it("mints an identity on the node so a branch can share it", () => {
    const subs = [open([0, 0], [10, 0])];
    const id = weldIdAt(subs, { sub: 0, index: 1 });
    expect(id).toBeTruthy();
    expect(subs[0]!.points[1]!.weldId).toBe(id);
    // Asking twice names the SAME node, or a second branch would start a rival.
    expect(weldIdAt(subs, { sub: 0, index: 1 })).toBe(id);
  });

  it("makes the branch and its seed one node", () => {
    const subs = [open([0, 0], [10, 0])];
    const id = weldIdAt(subs, { sub: 0, index: 1 })!;
    subs.push({ id: "branch", closed: false, points: [{ x: 10, y: 0, hIn: null, hOut: null, weldId: id }, pt(10, 10)] });
    expect(weldGroup(subs, { sub: 1, index: 0 })).toHaveLength(2);
  });

  it("keeps identity through a copy — joining must not dissolve a junction", () => {
    const subs = [open([0, 0], [10, 0]), open([10, 0], [20, 0])];
    weldNodes(subs, [{ sub: 0, index: 1 }, { sub: 1, index: 0 }]);
    const id = subs[0]!.points[1]!.weldId;
    // weldRun copies the incoming run's points, and joining REORDERS the runs —
    // which is the whole reason identity is not an index. Both members must
    // still be findable afterwards, wherever the join left them.
    weldRun(subs, open([30, 30], [0, 0]), { kind: "anchor", sub: 0, index: 0 });
    const members = subs.flatMap((sub) => sub.points.filter((p) => p.weldId === id));
    expect(members).toHaveLength(2);
  });
})

describe("penMark — the cursor names the click before it happens", () => {
  const at = (end: "head" | "tail" | null, kind: "anchor" | "segment" = "anchor") => ({
    clipId: "c",
    site: kind === "anchor" ? { kind, sub: 0, index: 0 } : { kind, sub: 0, index: 0, t: 0.5 },
    end,
  } as const);
  it("an open end continues, an interior node joins, a curve adds", () => {
    expect(penMark(penIntent({ drawing: false, closing: false, landing: at("tail") }))).toBe("continue");
    expect(penMark(penIntent({ drawing: false, closing: false, landing: at(null) }))).toBe("join");
    expect(penMark(penIntent({ drawing: false, closing: false, landing: at(null, "segment") }))).toBe("add");
    expect(penMark(penIntent({ drawing: true, closing: true, landing: null }))).toBe("close");
  });
});
