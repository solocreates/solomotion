import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createCommandApi, type CommandContext } from "../api";
import type { GroupClip, ShapeClip } from "../schema";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { locateClip } from "../timeline/ops";
import { writeChannel } from "../animation/channels";
import { addBehavior } from "../behaviors/ops";
import { poseEnvAt } from "../evaluate/resolved-doc";
import { createRig } from "./ops";
import { addPose, createPoseSet } from "./pose-ops";
import { characterLanes, type PoseBlock } from "./character-lanes";
import { changeBlockPose, deleteBlock, slideBlock, splitBlock, trimBlock, trimTarget } from "./block-edit";

const instant = { ms: 0, ease: { kind: "linear" as const } };

/** A character with Eyes (Open / Half / Closed / Angry), 30 fps, 10 s. */
function face() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  doc.frames[0]!.fps = 30;
  const rigId = createRig(doc, frameId, { name: "Pip", bones: [{ head: [0, 0], tail: [0, -100], name: "Torso" }] })!;
  const g = () => locateClip(doc, rigId)!.clip as GroupClip;
  g().durationMs = 10_000;
  const track = createTrack("Eye");
  track.groupId = rigId;
  const eye = createShapeClip({ frameId, shape: "ellipse", startMs: 0, durationMs: 10_000, x: 0, y: 0, width: 40, height: 20 }) as ShapeClip;
  track.clips.push(eye);
  doc.tracks.push(track);
  const eyes = createPoseSet(doc, rigId, { name: "Eyes", vocabulary: "eyes", blend: instant })!;
  for (const [name, v] of [["Open", 1], ["Half", 0.5], ["Closed", 0], ["Angry", 0.8]] as const) addPose(doc, rigId, eyes, { name, values: [{ clipId: eye.id, path: "opacity", value: v }] });
  const blocks = (): PoseBlock[] => characterLanes(doc, rigId, undefined, (t) => poseEnvAt(doc, t, frameId), eyes)[0]!.blocks;
  const at = (t: number) => blocks().find((b) => b.fromMs <= t && t < b.toMs)!;
  return { doc, rigId, g, eyes, blocks, at };
}

/** A cycle of Half 1 s / Angry 1 s — generated blocks with known edges. */
function cycling() {
  const f = face();
  addBehavior(f.doc, f.rigId, "cycle", {}, { steps: [{ pose: "Half", ms: 1000 }, { pose: "Angry", ms: 1000 }] });
  return f;
}

const spans = (bs: PoseBlock[], upTo = 4000) => bs.filter((b) => b.fromMs < upTo).map((b) => `${b.name} ${Math.round(b.fromMs)}-${Math.round(b.toMs)}${b.overridden ? "*" : ""}`);

describe("lane blocks edit like clips", () => {
  it("a lane row asks for its own set alone", () => {
    const f = face();
    createPoseSet(f.doc, f.rigId, { name: "Mouth", vocabulary: "visemes", blend: instant });
    expect(characterLanes(f.doc, f.rigId, undefined, undefined, f.eyes).map((l) => l.setId)).toEqual([f.eyes]);
  });

  it("⌘B splits a behavior's block into two of its pose — and either can then change", () => {
    const f = cycling();
    expect(spans(f.blocks(), 2000)).toEqual(["Half 0-1000", "Angry 1000-2000"]);
    expect(splitBlock(f.doc, f.rigId, f.eyes, f.at(1500), 1500)).toBe(true);
    expect(spans(f.blocks(), 2000)).toEqual(["Half 0-1000", "Angry 1000-1500*", "Angry 1500-2000*"]);
    // A different mouth shape for the second half alone.
    changeBlockPose(f.doc, f.rigId, f.eyes, f.at(1700), "Closed");
    expect(spans(f.blocks(), 2000)).toEqual(["Half 0-1000", "Angry 1000-1500*", "Closed 1500-2000*"]);
    // Not inside by a frame: no split.
    expect(splitBlock(f.doc, f.rigId, f.eyes, f.at(10), 10)).toBe(false);
  });

  it("the resting pose cut or changed becomes keys over that stretch alone — never the rest everywhere", () => {
    const f = cycling();
    // ⌥-trim opens a stretch of rest (Open) at 1000–1300.
    trimBlock(f.doc, f.rigId, f.eyes, f.blocks(), 1, "start", 1300, { roll: false });
    // 1150 is between frames: the cut lands on frame 35 (1166.7).
    expect(splitBlock(f.doc, f.rigId, f.eyes, f.at(1100), 1150)).toBe(true);
    changeBlockPose(f.doc, f.rigId, f.eyes, f.at(1200), "Closed");
    expect(spans(f.blocks(), 2000)).toEqual(["Half 0-1000", "Open 1000-1167", "Closed 1167-1300", "Angry 1300-2000*"]);
    // A pure resting lane: change its only block in the middle stretch.
    const g = face();
    splitBlock(g.doc, g.rigId, g.eyes, g.at(5000), 3000);
    splitBlock(g.doc, g.rigId, g.eyes, g.at(5000), 6000);
    changeBlockPose(g.doc, g.rigId, g.eyes, g.at(4000), "Angry");
    expect(spans(g.blocks(), 10_000)).toEqual(["Open 0-3000", "Angry 3000-6000", "Open 6000-10000"]);
  });

  it("an edge two blocks share ROLLS by default: one grows as the other shrinks", () => {
    const f = cycling();
    const bs = f.blocks();
    expect(trimBlock(f.doc, f.rigId, f.eyes, bs, 0, "end", 1400)).toEqual({ fromMs: 0, toMs: 1400 });
    expect(spans(f.blocks(), 2000)).toEqual(["Half 0-1400*", "Angry 1400-2000*"]);
  });

  it("⌥ trims the block alone: what lies underneath shows where it shrank", () => {
    const f = cycling();
    trimBlock(f.doc, f.rigId, f.eyes, f.blocks(), 1, "start", 1300, { roll: false });
    // The cycle stands aside over 1000–1300: the resting pose (Open) shows.
    expect(spans(f.blocks(), 2000)).toEqual(["Half 0-1000", "Open 1000-1300", "Angry 1300-2000*"]);
  });

  it("a trim always leaves a frame of each block it touches", () => {
    const f = cycling();
    const t = trimTarget(f.doc, f.rigId, f.eyes, f.blocks(), 0, "end", 5000)!;
    expect(t.block.toMs).toBeCloseTo(2000 - 1000 / 30, 3);
    expect(t.neighbor).toMatchObject({ index: 1, toMs: 2000 });
  });

  it("a behavior's block moves like a clip dropped on a track — it lands over what is there", () => {
    const f = cycling();
    slideBlock(f.doc, f.rigId, f.eyes, f.blocks(), 0, 500);
    expect(spans(f.blocks(), 2000)).toEqual(["Open 0-500", "Half 500-1500*", "Angry 1500-2000"]);
  });

  it("keyed blocks: a slide moves its key and the next one together; trims roll; delete lets the one before run on", () => {
    const f = face();
    for (const [ms, pose] of [[0, "Open"], [1000, "Half"], [2000, "Angry"], [3000, "Open"]] as const) writeChannel(f.g(), `pose.${f.eyes}`, ms, pose, { forceKey: true });
    expect(spans(f.blocks())).toEqual(["Open 0-1000", "Half 1000-2000", "Angry 2000-3000", "Open 3000-10000"]);
    slideBlock(f.doc, f.rigId, f.eyes, f.blocks(), 1, 300);
    expect(spans(f.blocks())).toEqual(["Open 0-1300", "Half 1300-2300", "Angry 2300-3000", "Open 3000-10000"]);
    trimBlock(f.doc, f.rigId, f.eyes, f.blocks(), 1, "end", 2600);
    expect(spans(f.blocks())).toEqual(["Open 0-1300", "Half 1300-2600", "Angry 2600-3000", "Open 3000-10000"]);
    splitBlock(f.doc, f.rigId, f.eyes, f.at(2000), 2000);
    changeBlockPose(f.doc, f.rigId, f.eyes, f.at(2100), "Closed");
    expect(spans(f.blocks())).toEqual(["Open 0-1300", "Half 1300-2000", "Closed 2000-2600", "Angry 2600-3000", "Open 3000-10000"]);
    deleteBlock(f.doc, f.rigId, f.eyes, f.at(2100));
    expect(spans(f.blocks())).toEqual(["Open 0-1300", "Half 1300-2600", "Angry 2600-3000", "Open 3000-10000"]);
  });

  it("a pick changes the picked blocks, else the block under the playhead — recording cuts there — never the lane", async () => {
    const f = face();
    const { pickPose } = await import("./block-edit");
    // A resting lane (no keys): a pick at 2 s changes that block — the only one there is — not "the rest" everywhere.
    for (const [ms, pose] of [[0, "Open"], [1000, "Half"], [2000, "Open"], [3000, "Half"]] as const) writeChannel(f.g(), `pose.${f.eyes}`, ms, pose, { forceKey: true });
    pickPose(f.doc, f.rigId, f.eyes, "Angry", f.blocks(), { atMs: 2500 });
    expect(spans(f.blocks())).toEqual(["Open 0-1000", "Half 1000-2000", "Angry 2000-3000", "Half 3000-10000"]);
    // Recording: from the playhead to the block's end.
    pickPose(f.doc, f.rigId, f.eyes, "Closed", f.blocks(), { atMs: 1500, record: true });
    expect(spans(f.blocks())).toEqual(["Open 0-1000", "Half 1000-1500", "Closed 1500-2000", "Angry 2000-3000", "Half 3000-10000"]);
    // Picked blocks win over the playhead — all of them.
    pickPose(f.doc, f.rigId, f.eyes, "Open", f.blocks(), { atMs: 2500, picked: [1200, 3500] });
    expect(spans(f.blocks())).toEqual(["Open 0-1000", "Open 1000-1500", "Closed 1500-2000", "Angry 2000-3000", "Open 3000-10000"]);
    // On a behavior's block, recording cuts it with an override.
    const c = cycling();
    pickPose(c.doc, c.rigId, c.eyes, "Closed", c.blocks(), { atMs: 1500, record: true });
    expect(spans(c.blocks(), 2000)).toEqual(["Half 0-1000", "Angry 1000-1500", "Closed 1500-2000*"]);
    // A resting lane with no keys at all: one block changes, the rest stays the rest.
    const r = face();
    pickPose(r.doc, r.rigId, r.eyes, "Angry", [{ ...r.blocks()[0]!, fromMs: 0, toMs: 10_000 }], { atMs: 4000, record: true });
    expect(spans(r.blocks(), 10_000)).toEqual(["Open 0-4000", "Angry 4000-10000"]);
  });

  it("agents edit blocks through poses.block — the same verbs, by an instant inside the block", async () => {
    const f = cycling();
    const store = createDocumentStore(f.doc);
    const api = createCommandApi();
    const ctx: CommandContext = { store, actor: "AI", historyKey: "t", historyLabel: "Blocks", session: { focusFrameId: () => f.doc.frames[0]!.id, playheadMs: () => 0, selection: () => [] } };
    const run = async (input: unknown) => {
      const res = await api.call("poses.block", input, ctx);
      if (!res.ok) throw new Error(res.error);
      return res.value as { blocks: Array<{ fromMs: number; toMs: number; pose: string }> };
    };
    await run({ groupId: f.rigId, set: "Eyes", atMs: 1500, action: "split", splitMs: 1500 });
    const out = await run({ groupId: f.rigId, set: "Eyes", atMs: 1700, action: "change", pose: "Closed" });
    expect(out.blocks.filter((b) => b.fromMs < 2000).map((b) => `${b.pose} ${b.fromMs}-${b.toMs}`)).toEqual(["Half 0-1000", "Angry 1000-1500", "Closed 1500-2000"]);
    const res = await api.call("poses.block", { groupId: f.rigId, set: "Eyes", atMs: 1700, action: "trim", edge: "end" }, ctx);
    expect(res.ok).toBe(false);
  });
});
