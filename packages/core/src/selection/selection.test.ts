import { describe, expect, it } from "vitest";
import { MIXED, diffPaths, mergeValues, propagateListEdit, remapEntryPath, sharedList } from "./index";

interface Entry {
  id: string;
  type: string;
  color?: string;
  x?: number;
  stops?: Array<{ id: string; color: string; at: number }>;
}

let n = 0;
const clone = (e: Entry): Entry => ({ ...structuredClone(e), id: `fresh${n++}` });

describe("mergeValues", () => {
  it("agrees, disagrees, tolerates float dust", () => {
    expect(mergeValues([1, 1, 1])).toBe(1);
    expect(mergeValues([1, 2])).toBe(MIXED);
    expect(mergeValues([0.1 + 0.2, 0.3])).toBe(0.1 + 0.2);
    expect(mergeValues([])).toBeUndefined();
  });
});

describe("diffPaths", () => {
  it("reports the deepest precise disagreement, never ids", () => {
    const a = { id: "a", stops: [{ id: "s1", color: "#000", at: 0 }, { id: "s2", color: "#fff", at: 1 }] };
    const b = { id: "b", stops: [{ id: "s3", color: "#000", at: 0 }, { id: "s4", color: "#f00", at: 1 }] };
    expect(diffPaths(a, b)).toEqual(["stops.1.color"]);
  });
  it("reports a whole array when lengths differ, and a missing key", () => {
    expect(diffPaths({ list: [1, 2] }, { list: [1] })).toEqual(["list"]);
    expect(diffPaths({ a: 1, b: 2 }, { a: 1 })).toEqual(["b"]);
  });
});

describe("sharedList", () => {
  it("pairs by index and kind, and knows what is mixed", () => {
    const shared = sharedList<Entry>([
      [{ id: "1", type: "shadow", x: 4 }, { id: "2", type: "glow", color: "#fff" }],
      [{ id: "3", type: "shadow", x: 9 }, { id: "4", type: "glow", color: "#fff" }],
    ]);
    expect(shared.uneven).toBe(false);
    expect(shared.entries.map((e) => e.primary.id)).toEqual(["1", "2"]);
    expect([...shared.entries[0]!.mixed]).toEqual(["x"]);
    expect(shared.entries[1]!.mixed.size).toBe(0);
  });
  it("drops entries whose kind differs and flags uneven shapes", () => {
    const shared = sharedList<Entry>([
      [{ id: "1", type: "shadow" }, { id: "2", type: "glow" }],
      [{ id: "3", type: "glow" }],
    ]);
    expect(shared.entries).toEqual([]);
    expect(shared.uneven).toBe(true);
  });
});

describe("remapEntryPath", () => {
  const from: Entry[] = [{ id: "a1", type: "shadow" }, { id: "a2", type: "glow" }];
  const to: Entry[] = [{ id: "b1", type: "shadow" }];
  it("swaps the id segment for the twin at the same index", () => {
    expect(remapEntryPath("lfx.a1.blur", from, to)).toBe("lfx.b1.blur");
    expect(remapEntryPath("fill.a1", from, to)).toBe("fill.b1");
  });
  it("is null when the sibling has no twin, and identity for unrelated paths", () => {
    expect(remapEntryPath("lfx.a2.radius", from, to)).toBeNull();
    expect(remapEntryPath("opacity", from, to)).toBe("opacity");
  });
});

describe("propagateListEdit", () => {
  const before: Entry[] = [
    { id: "p1", type: "shadow", x: 4, color: "#000" },
    { id: "p2", type: "glow", color: "#fff" },
  ];
  const sibling: Entry[] = [
    { id: "s1", type: "shadow", x: 12, color: "#000" },
    { id: "s2", type: "glow", color: "#0ff" },
  ];

  it("writes only the changed paths, keeping the twin's id and other values", () => {
    const after: Entry[] = [{ ...before[0]!, color: "#f00" }, before[1]!];
    const { list, removedIds } = propagateListEdit(before, after, sibling, clone);
    expect(list[0]).toEqual({ id: "s1", type: "shadow", x: 12, color: "#f00" });
    expect(list[1]).toBe(sibling[1]);
    expect(removedIds).toEqual([]);
  });

  it("reorders, removes and appends fresh copies", () => {
    const added: Entry = { id: "p3", type: "extrude", x: 1 };
    const after: Entry[] = [before[1]!, added];
    const { list, removedIds } = propagateListEdit(before, after, sibling, clone);
    expect(list.map((e) => e.type)).toEqual(["glow", "extrude"]);
    expect(list[0]!.id).toBe("s2");
    expect(list[1]!.id).not.toBe("p3");
    expect(removedIds).toEqual(["s1"]);
  });

  it("replaces the twin when the kind changes, and keeps a sibling's extras", () => {
    const longer: Entry[] = [...sibling, { id: "s3", type: "glow", color: "#123" }];
    const after: Entry[] = [{ id: "p1", type: "gradient", stops: [] }, before[1]!];
    const { list } = propagateListEdit(before, after, longer, clone);
    expect(list.map((e) => e.type)).toEqual(["gradient", "glow", "glow"]);
    expect(list[0]!.id).not.toBe("p1");
    expect(list[2]!.id).toBe("s3");
  });

  it("propagates a nested change without touching sibling-only nesting", () => {
    const b: Entry[] = [{ id: "g", type: "gradient", stops: [{ id: "a", color: "#000", at: 0 }, { id: "b", color: "#fff", at: 1 }] }];
    const t: Entry[] = [{ id: "h", type: "gradient", stops: [{ id: "c", color: "#000", at: 0 }, { id: "d", color: "#fff", at: 0.8 }] }];
    const a: Entry[] = [{ ...b[0]!, stops: [b[0]!.stops![0]!, { ...b[0]!.stops![1]!, color: "#f00" }] }];
    const { list } = propagateListEdit(b, a, t, clone);
    expect(list[0]!.stops).toEqual([{ id: "c", color: "#000", at: 0 }, { id: "d", color: "#f00", at: 0.8 }]);
  });
});
