import type { MotionDocument } from "../schema";
import { compFps, frameStepMs } from "../timeline/fps";
import { moveBehaviorBlock, overrideBehavior } from "../behaviors/ops";
import type { PoseBlock } from "./character-lanes";
import { keyPose, movePoseKey, poseIn, poseSetOf, removePoseKey } from "./pose-ops";

/**
 * EDITING A LANE'S BLOCKS LIKE CLIPS (ADR-characters-3, "Blocks") — whatever
 * decided the block. Your keyed blocks and a behavior's generated ones (a
 * syllable, a blink, a cycle's step) take the same five verbs: change, split,
 * trim, roll and slide. Each says what it means in the block's own terms:
 *
 *   keyed     the key that starts the block moves (a lane of keys is
 *             contiguous: its start edge IS the edge it shares with the block
 *             before), a split adds a key, delete lets the block before run on.
 *   behavior  an OVERRIDE the behavior keeps when it regenerates: where the
 *             block was it stands aside, where it is now it shows the block's
 *             pose. A split makes two overrides — two blocks, each its own.
 *   base, driver  not a person's to retime (the resting pose fills whatever is
 *             left; a driver is baked first).
 *
 * TRIM vs ROLL. Pose lanes have no gaps — every instant shows some pose — so
 * the edge two blocks share moves for both by default (a roll: one grows as
 * the other shrinks). `roll: false` trims the block alone: what lies under it
 * (your keys, the resting pose) shows through where it shrank.
 *
 * All times here are COMP ms, the lane's own (`characterLanes`).
 */

/** Spans are comp ms, `toMs` exclusive. */
export interface BlockSpan {
  fromMs: number;
  toMs: number;
}

/** Can a person retime this block? Your keys and a behavior's blocks; not the base or a driver. */
export function blockEditable(b: PoseBlock): boolean {
  return b.behaviorId !== undefined || (b.source === "keyed" && b.keyMs !== undefined);
}

function stepOf(doc: MotionDocument, groupId: string, setId: string): { start: number; end: number; step: number } | null {
  const at = poseSetOf(doc, groupId, setId);
  if (!at) return null;
  return { start: at.group.startMs, end: at.group.startMs + at.group.durationMs, step: frameStepMs(compFps(doc, at.group.frameId)) };
}

/**
 * An instant ON THE FRAME GRID, as the lane samples it: the nearest frame,
 * floored to a thousandth of a ms — never a hair after the frame's own
 * instant (35 × 1000/30 = 1166.666…), which would read one frame late.
 */
export function blockGridTime(ms: number, stepMs: number): number {
  const raw = Math.round(ms / stepMs) * stepMs;
  return Math.abs(raw - Math.round(raw)) < 1e-6 ? Math.round(raw) : Math.floor(raw * 1000) / 1000;
}

/** A keyed block whose start edge is its own key (not the stretch before the first key). */
const keyedStart = (b: PoseBlock, start: number) => b.source === "keyed" && !b.behaviorId && b.keyMs !== undefined && Math.abs(start + b.keyMs - b.fromMs) < 0.5;

/** Put ONE block at `to`, in its own terms. Returns false when it has no handle for that. */
function placeBlock(doc: MotionDocument, groupId: string, setId: string, b: PoseBlock, to: BlockSpan, start: number): boolean {
  if (b.behaviorId) {
    return !!moveBehaviorBlock(doc, groupId, b.behaviorId, { fromMs: b.fromMs - start, toMs: b.toMs - start, pose: b.name }, { fromMs: to.fromMs - start, toMs: to.toMs - start });
  }
  // A keyed block's start is its key; its end belongs to the block after it.
  if (keyedStart(b, start) && Math.abs(to.fromMs - b.fromMs) > 1e-6) return movePoseKey(doc, groupId, setId, b.keyMs!, to.fromMs - start) !== null;
  return false;
}

/**
 * Before a resting-pose block is cut or changed, the set becomes KEYS: a key
 * at the character's start holding what rests there — so one more key changes
 * that stretch alone, never the rest everywhere (the base is every unkeyed
 * instant at once).
 */
function keysFromBase(doc: MotionDocument, groupId: string, setId: string, b: PoseBlock): void {
  const at = poseSetOf(doc, groupId, setId);
  if (!at || at.group.keyframes.some((k) => k.property === `pose.${setId}` && !k.range && k.keys.length)) return;
  keyPose(doc, groupId, setId, b.poseId, 0, { key: true });
}

/**
 * Show another pose for exactly this block: a keyed block's key changes; a
 * behavior's block is overridden over its span; a resting-pose block is keyed
 * over its span (the rest stays the rest everywhere else).
 */
export function changeBlockPose(doc: MotionDocument, groupId: string, setId: string, b: PoseBlock, poseRef: string): boolean {
  const at = poseSetOf(doc, groupId, setId);
  const pose = at && poseIn(at.set, poseRef);
  if (!at || !pose) return false;
  const start = at.group.startMs;
  if (b.behaviorId) return !!overrideBehavior(doc, groupId, b.behaviorId, { fromMs: b.fromMs - start, toMs: b.toMs - start, pose: pose.name });
  if (b.source === "keyed" && b.keyMs !== undefined) return keyPose(doc, groupId, setId, pose.id, b.keyMs, { key: true });
  if (b.source === "base") {
    // Exactly this stretch: a key where it starts, the rest back where it ends.
    keysFromBase(doc, groupId, setId, b);
    const end = start + at.group.durationMs;
    if (b.toMs < end - 0.5) keyPose(doc, groupId, setId, b.poseId, b.toMs - start, { key: true });
    return keyPose(doc, groupId, setId, pose.id, b.fromMs - start, { key: true });
  }
  return false;
}

/**
 * PICK A POSE — what a click in the Face pad (or a pose key, or an agent's
 * pick) means on a lane of blocks, in this order:
 *
 *   1. blocks are PICKED on this set: each one becomes the pose (one or many);
 *   2. recording: from the playhead to the end of the block under it becomes
 *      the pose — a cut where you are, like keying (at its very start: the
 *      whole block);
 *   3. otherwise: the block under the playhead, and only it.
 *
 * Never the whole lane: a resting pose picked over becomes keys over that
 * stretch alone. `blocks` is the set's lane over the character's span
 * (`characterLanes(…, only)`), read before the edit. Returns the spans it
 * changed — empty where no block could take it (a driver chooses there).
 */
export function pickPose(
  doc: MotionDocument,
  groupId: string,
  setId: string,
  poseRef: string,
  blocks: readonly PoseBlock[],
  opts: { atMs: number; record?: boolean; picked?: readonly number[] },
): BlockSpan[] {
  const at = poseSetOf(doc, groupId, setId);
  const pose = at && poseIn(at.set, poseRef);
  const g = stepOf(doc, groupId, setId);
  if (!at || !pose || !g) return [];
  const under = (t: number) => blocks.find((b) => b.fromMs <= t && t < b.toMs);
  const editable = (b: PoseBlock) => blockEditable(b) || b.source === "base";
  const picked = [...new Set((opts.picked ?? []).map(under).filter((b): b is PoseBlock => !!b && editable(b)))];
  if (picked.length) {
    for (const b of picked) changeBlockPose(doc, groupId, setId, b, pose.id);
    return picked.map((b) => ({ fromMs: b.fromMs, toMs: b.toMs }));
  }
  const b = under(opts.atMs);
  if (!b || !editable(b)) return [];
  const cut = blockGridTime(opts.atMs, g.step);
  if (opts.record && cut > b.fromMs + 1e-6 && cut < b.toMs - 1e-6) {
    // From here on: a behavior's block is overridden from the cut; keys (or the
    // rest, keyed first) get a key at the cut, and the rest returns where the block ends.
    if (b.behaviorId) {
      overrideBehavior(doc, groupId, b.behaviorId, { fromMs: cut - g.start, toMs: b.toMs - g.start, pose: pose.name });
    } else {
      keysFromBase(doc, groupId, setId, b);
      if (b.source === "base" && b.toMs < g.end - 0.5) keyPose(doc, groupId, setId, b.poseId, b.toMs - g.start, { key: true });
      keyPose(doc, groupId, setId, pose.id, cut - g.start, { key: true });
    }
    return [{ fromMs: cut, toMs: b.toMs }];
  }
  changeBlockPose(doc, groupId, setId, b, pose.id);
  return [{ fromMs: b.fromMs, toMs: b.toMs }];
}

/**
 * Split a block at comp `atMs` (⌘B): two blocks showing its pose, either of
 * which you can then change. False when `atMs` is not at least a frame inside.
 */
export function splitBlock(doc: MotionDocument, groupId: string, setId: string, b: PoseBlock, atMs: number): boolean {
  const g = stepOf(doc, groupId, setId);
  if (!g || atMs < b.fromMs + g.step - 1e-6 || atMs > b.toMs - g.step + 1e-6) return false;
  // On the frame grid: a block starts on a frame, like every block the lane draws.
  const at = blockGridTime(atMs, g.step);
  if (at <= b.fromMs || at >= b.toMs) return false;
  if (b.behaviorId) {
    const a = overrideBehavior(doc, groupId, b.behaviorId, { fromMs: b.fromMs - g.start, toMs: at - g.start, pose: b.name });
    const c = overrideBehavior(doc, groupId, b.behaviorId, { fromMs: at - g.start, toMs: b.toMs - g.start, pose: b.name });
    return !!a && !!c;
  }
  if (b.source === "base") {
    keysFromBase(doc, groupId, setId, b);
    if (b.fromMs > g.start + 0.5) keyPose(doc, groupId, setId, b.poseId, b.fromMs - g.start, { key: true });
  }
  if (b.source === "keyed" || b.source === "base") return keyPose(doc, groupId, setId, b.poseId, at - g.start, { key: true });
  return false;
}

/** Delete a block: a key goes (the block before runs on); a behavior stands aside there. */
export function deleteBlock(doc: MotionDocument, groupId: string, setId: string, b: PoseBlock): boolean {
  const at = poseSetOf(doc, groupId, setId);
  if (!at) return false;
  const start = at.group.startMs;
  if (b.behaviorId) return !!overrideBehavior(doc, groupId, b.behaviorId, { fromMs: b.fromMs - start, toMs: b.toMs - start, pose: null });
  if (b.source === "keyed" && b.keyMs !== undefined) return removePoseKey(doc, groupId, setId, b.keyMs);
  return false;
}

/**
 * Where an edge drag may go: at least a frame of the block (and, rolling, of
 * its neighbour) is left, inside the character's span. Pure — what a drag
 * previews before anything is written.
 */
export function trimTarget(
  doc: MotionDocument,
  groupId: string,
  setId: string,
  blocks: readonly PoseBlock[],
  index: number,
  edge: "start" | "end",
  atMs: number,
  opts: { roll?: boolean } = {},
): { block: BlockSpan; neighbor: (BlockSpan & { index: number }) | null } | null {
  const g = stepOf(doc, groupId, setId);
  const b = blocks[index];
  if (!g || !b) return null;
  const roll = opts.roll !== false;
  const ni = edge === "start" ? index - 1 : index + 1;
  const n = blocks[ni];
  const touching = !!n && Math.abs((edge === "start" ? n.toMs : n.fromMs) - (edge === "start" ? b.fromMs : b.toMs)) < 0.5;
  const rolls = roll && touching;
  let lo: number, hi: number;
  if (edge === "start") {
    lo = rolls ? n!.fromMs + g.step : g.start;
    hi = b.toMs - g.step;
  } else {
    lo = b.fromMs + g.step;
    hi = rolls ? n!.toMs - g.step : g.end;
  }
  const at = Math.min(hi, Math.max(lo, blockGridTime(atMs, g.step)));
  const block = edge === "start" ? { fromMs: at, toMs: b.toMs } : { fromMs: b.fromMs, toMs: at };
  const neighbor = rolls ? { index: ni, ...(edge === "start" ? { fromMs: n!.fromMs, toMs: at } : { fromMs: at, toMs: n!.toMs }) } : null;
  return { block, neighbor };
}

/**
 * Trim a block's edge to comp `atMs` — rolling the edge it shares with its
 * neighbour unless `roll: false`. Returns the block's new span (null when
 * nothing could move).
 */
export function trimBlock(
  doc: MotionDocument,
  groupId: string,
  setId: string,
  blocks: readonly PoseBlock[],
  index: number,
  edge: "start" | "end",
  atMs: number,
  opts: { roll?: boolean } = {},
): BlockSpan | null {
  const target = trimTarget(doc, groupId, setId, blocks, index, edge, atMs, opts);
  const g = stepOf(doc, groupId, setId);
  if (!target || !g) return null;
  const b = blocks[index]!;
  const edits: Array<[PoseBlock, BlockSpan]> = [[b, target.block]];
  if (target.neighbor) {
    const n = blocks[target.neighbor.index]!;
    // The one that shrinks first: where one behavior made both, the grower's
    // span must be the last word over the edge they trade.
    const grows = target.block.toMs - target.block.fromMs > b.toMs - b.fromMs;
    edits[grows ? "unshift" : "push"]([n, target.neighbor]);
  }
  let moved = false;
  for (const [x, to] of edits) moved = placeBlock(doc, groupId, setId, x, to, g.start) || moved;
  return moved ? target.block : null;
}

/**
 * Where a body drag may take a block: its length kept, inside the
 * character's span; a keyed block slides between the keys around it (the one
 * before grows or shrinks, the one after it too).
 */
export function slideTarget(doc: MotionDocument, groupId: string, setId: string, blocks: readonly PoseBlock[], index: number, deltaMs: number): BlockSpan | null {
  const g = stepOf(doc, groupId, setId);
  const b = blocks[index];
  if (!g || !b) return null;
  const round = (v: number) => blockGridTime(v, g.step);
  if (b.behaviorId) {
    const d = Math.min(g.end - b.toMs, Math.max(g.start - b.fromMs, deltaMs));
    return { fromMs: round(b.fromMs + d), toMs: round(b.toMs + d) };
  }
  if (!keyedStart(b, g.start)) return null;
  // A keyed block: its key moves between the block before and, when the block
  // after is keyed too, with that key — the length kept; else its end stays.
  const prev = blocks[index - 1];
  const next = blocks[index + 1];
  const withNext = !!next && keyedStart(next, g.start) && Math.abs(next.fromMs - b.toMs) < 0.5;
  const lo = (prev ? prev.fromMs + g.step : g.start) - b.fromMs;
  const hi = withNext ? next!.toMs - g.step - b.toMs : b.toMs - g.step - b.fromMs;
  const d = Math.min(hi, Math.max(lo, deltaMs));
  return { fromMs: round(b.fromMs + d), toMs: withNext ? round(b.toMs + d) : b.toMs };
}

/**
 * Move a whole block by `deltaMs`. A behavior's block moves as an override
 * (it lands over whatever is there, like a clip dropped on a track); a keyed
 * block slides — its key and the key after it move together.
 */
export function slideBlock(doc: MotionDocument, groupId: string, setId: string, blocks: readonly PoseBlock[], index: number, deltaMs: number): BlockSpan | null {
  const to = slideTarget(doc, groupId, setId, blocks, index, deltaMs);
  const g = stepOf(doc, groupId, setId);
  const b = blocks[index];
  if (!to || !g || !b || Math.abs(to.fromMs - b.fromMs) < 1e-6) return null;
  if (b.behaviorId) return placeBlock(doc, groupId, setId, b, to, g.start) ? to : null;
  if (!keyedStart(b, g.start)) return null;
  const next = blocks[index + 1];
  const nextKey = next && keyedStart(next, g.start) && Math.abs(next.fromMs - b.toMs) < 0.5 ? next.keyMs! : null;
  const d = to.fromMs - b.fromMs;
  // Move the far key first, so neither move is clamped by the other.
  if (d > 0 && nextKey !== null) movePoseKey(doc, groupId, setId, nextKey, nextKey + d);
  movePoseKey(doc, groupId, setId, b.keyMs!, b.keyMs! + d);
  if (d < 0 && nextKey !== null) movePoseKey(doc, groupId, setId, nextKey, nextKey + d);
  return to;
}
