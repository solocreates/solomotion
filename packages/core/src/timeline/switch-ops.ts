import type { MotionDocument, GroupClip } from "../schema";
import { writeChannel } from "../animation/channels";
import { componentSetId, createComponentInstanceClip, variantsOf } from "../components";
import { groupClips } from "./groups";
import { compDurationMs, locateClip } from "./ops";
import { placeClip } from "./place";
import { switchOptions } from "./switch";

/**
 * SWITCH EDITS — making, choosing, unmaking (the read side is `switch.ts`).
 * Every writer — the layers panel's radio, the inspector's chips, an agent,
 * lip sync — goes through these, so a choice is always a member's NAME (what
 * reads in a key and survives reordering) and keys where the switch is keyed.
 */

/**
 * Make a switch: a group of these layers that shows one at a time, or an
 * existing group made one (a single group id). Shows `show`, else the top
 * member. Returns the group's id, or null when there is nothing to switch
 * between (a switch is also never a rig or an auto layout — those place
 * members; a switch picks one).
 */
export function makeSwitch(doc: MotionDocument, ids: string[], opts: { name?: string; show?: string | number } = {}): string | null {
  if (!ids.length) return null;
  const only = ids.length === 1 ? locateClip(doc, ids[0]!)?.clip : null;
  const groupId = only?.kind === "group" ? only.id : groupClips(doc, ids, opts.name ?? "Switch");
  if (!groupId) return null;
  const g = locateClip(doc, groupId)?.clip;
  if (!g || g.kind !== "group" || g.layout || g.rig) return null;
  if (opts.name && only) g.name = opts.name;
  g.switch = { show: opts.show ?? switchOptions(doc, groupId)[0]?.name ?? "" };
  return groupId;
}

/** No longer a switch: every member shows again, and the choice's keys go. */
export function unmakeSwitch(doc: MotionDocument, groupId: string): boolean {
  const g = locateClip(doc, groupId)?.clip;
  if (!g || g.kind !== "group" || !g.switch) return false;
  g.switch = null;
  g.keyframes = g.keyframes.filter((k) => k.property !== "switch");
  return true;
}

/**
 * Show a member at the switch's local time `atMs`: named by its id, its name
 * or its place from the top. Written as the member's NAME, keyed where the
 * switch is already keyed or `key` (record mode), its resting choice
 * otherwise. False when the switch or the member is not there.
 */
export function setSwitch(doc: MotionDocument, groupId: string, show: string | number, atMs: number, opts: { key?: boolean } = {}): boolean {
  const g = locateClip(doc, groupId)?.clip;
  if (!g || g.kind !== "group" || !g.switch) return false;
  const options = switchOptions(doc, groupId);
  const byId = typeof show === "string" ? options.find((c) => c.id === show) : undefined;
  const byName = typeof show === "string" ? options.find((c) => c.name.trim().toLowerCase() === show.trim().toLowerCase()) : undefined;
  const byIndex = typeof show === "number" && Number.isFinite(show) ? options[Math.round(show)] : undefined;
  const member = byId ?? byName ?? byIndex;
  if (!member) return false;
  writeChannel(g, "switch", atMs, member.name, { forceKey: opts.key });
  return true;
}

/**
 * A SWITCH OF A COMPONENT'S VARIANTS — one instance of every variant in the
 * set, each named for its variant, stacked in one place, in a new switch. A
 * mouth set becomes a mouth that lip sync keys by sound; an eye set an eye
 * that blinks. Instances share their definitions, so redrawing a variant
 * redraws it in every character that uses it.
 *
 * Members are in the set's order with the main variant on top. Returns the
 * switch's id, or null when the frame is not a component.
 */
export function switchFromVariants(
  doc: MotionDocument,
  frameId: string,
  componentFrameId: string,
  opts: { x?: number; y?: number; startMs?: number; durationMs?: number; name?: string; show?: string } = {},
): string | null {
  const source = doc.frames.find((f) => f.id === componentFrameId);
  if (!source || !componentSetId(source)) return null;
  const setId = componentSetId(source)!;
  const variants = variantsOf(doc, source);
  // The main variant first: the one whose id is the set's.
  variants.sort((a, b) => (a.id === setId ? -1 : b.id === setId ? 1 : 0));
  const durationMs = opts.durationMs ?? Math.max(500, compDurationMs(doc, frameId));
  const ids: string[] = [];
  for (const v of variants) {
    const inst = createComponentInstanceClip(doc, v.id, { frameId, startMs: opts.startMs ?? 0, durationMs, x: opts.x ?? 0, y: opts.y ?? 0 });
    if (!inst) continue;
    inst.name = v.component?.variantName ?? v.name;
    placeClip(doc, inst, { landing: "surface" });
    ids.push(inst.id);
  }
  if (!ids.length) return null;
  const id = makeSwitch(doc, ids, { name: opts.name ?? source.name, show: opts.show });
  if (!id) return null;
  orderMembers(doc, id, ids);
  if (!opts.show) (locateClip(doc, id)!.clip as GroupClip).switch = { show: variants[0]!.component?.variantName ?? variants[0]!.name };
  return id;
}

/** Put a group's member lanes in this order, top first (lanes it does not name keep their places after). */
function orderMembers(doc: MotionDocument, groupId: string, clipIdsTopFirst: string[]): void {
  const slots: number[] = [];
  doc.tracks.forEach((t, i) => t.groupId === groupId && slots.push(i));
  const lanes = slots.map((i) => doc.tracks[i]!);
  const rank = (t: (typeof lanes)[number]) => {
    const r = t.clips.map((c) => clipIdsTopFirst.indexOf(c.id)).filter((x) => x >= 0);
    return r.length ? Math.min(...r) : clipIdsTopFirst.length;
  };
  const sorted = lanes.slice().sort((a, b) => rank(a) - rank(b));
  slots.forEach((slot, k) => (doc.tracks[slot] = sorted[k]!));
}
