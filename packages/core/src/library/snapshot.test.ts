import { describe, expect, it } from "vitest";
import { createEmptyDocument, createGroupClip, createPathClip, createTrack } from "../factories";
import { layerSpecFromPreset } from "../animation/layer-animation";
import { moveClipsToScope } from "../timeline/groups";
import {
  captureLibrarySnapshot,
  instantiateLibrarySnapshot,
  librarySnapshotName,
  normalizeSnapshot,
  snapshotSpanMs,
} from "./snapshot";

const pt = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });
const line = { closed: false, points: [pt(0, 0), pt(10, 0)] };

describe("a snapshot carries its group as the clip it is", () => {
  it("keeps what the group wears — its draw-on survives save and place", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const group = createGroupClip({ frameId, startMs: 1000, durationMs: 3000, name: "Icon" });
    group.animIn = layerSpecFromPreset("draw");
    const a = createPathClip({ frameId, subpaths: [line], startMs: 1000, durationMs: 3000 });
    const b = createPathClip({ frameId, subpaths: [line], startMs: 1500, durationMs: 2500 });
    for (const [i, c] of [group, a, b].entries()) {
      const lane = createTrack(`l${i}`);
      lane.clips.push(c);
      doc.tracks.push(lane);
    }
    moveClipsToScope(doc, [a.id, b.id], group.id);

    const snap = captureLibrarySnapshot(doc, [a.id, b.id])!;
    expect(snap.v).toBe(2);
    expect(snap.group?.animIn?.preset).toBe("draw");
    expect(snapshotSpanMs(snap)).toBe(3000);
    expect(librarySnapshotName(snap)).toBe("Icon");

    const out = instantiateLibrarySnapshot(snap, { frameId: "f2", startMs: 200, dx: 5 });
    expect(out.group?.kind).toBe("group");
    expect(out.group?.id).not.toBe(group.id);
    expect((out.group as typeof group).animIn?.preset).toBe("draw");
    expect(out.group?.startMs).toBe(200);
    expect(out.group?.durationMs).toBe(3000);
    expect(out.members).toHaveLength(2);
  });

  it("lifts a v1 file: a bare name and mode become a group spanning the members", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const a = createPathClip({ frameId, subpaths: [line], startMs: 0, durationMs: 1000 });
    const b = createPathClip({ frameId, subpaths: [line], startMs: 500, durationMs: 1000 });
    const v1 = { v: 1, clips: [a, b], grouped: true, groupName: "Logo", groupMode: "mask" };
    const snap = normalizeSnapshot(v1)!;
    expect(snap.v).toBe(2);
    expect(snap.group?.name).toBe("Logo");
    expect(snap.group?.mode).toBe("mask");
    expect(snap.group?.durationMs).toBe(1500);
    // An ungrouped v1 stays loose; garbage is null, not a throw.
    expect(normalizeSnapshot({ v: 1, clips: [a], grouped: false, groupName: null })!.group).toBeNull();
    expect(normalizeSnapshot({ v: 7 })).toBeNull();
    expect(normalizeSnapshot("nope")).toBeNull();
  });
});

describe("a drop offset moves the artwork once", () => {
  it("shifts the members and leaves the group's own delta alone", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const a = createPathClip({ frameId, subpaths: [line], startMs: 0, durationMs: 1000, x: 10, y: 0 });
    const b = createPathClip({ frameId, subpaths: [line], startMs: 0, durationMs: 1000, x: -10, y: 0 });
    const group = createGroupClip({ frameId, startMs: 0, durationMs: 1000, name: "G" });
    const snap = { v: 2 as const, clips: [a, b], group };
    const out = instantiateLibrarySnapshot(snap, { frameId, startMs: 0, dx: 100, dy: 50 });
    const xs = out.clips.flatMap((c) => (c.kind === "path" ? [c.transform.x] : []));
    expect(xs.sort((p, q) => p - q)).toEqual([90, 110]);
    expect(out.group && out.group.kind !== "audio" ? out.group.transform.x : null).toBe(0);
  });
});
