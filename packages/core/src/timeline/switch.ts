import type { MotionDocument, Clip, GroupClip, KeyframeValue, Track } from "../schema";
import { sampleKeyframes } from "../animation/keyframes";
import { clipRenderLocalTime } from "../animation/evaluate";
import { trackLocalTime } from "../drawing/flipbook";
import { isSettledDocument } from "./settled";

/**
 * SWITCH GROUPS (v91) — one member at a time: an eye open, half or shut; a
 * mouth's shapes; a hand's poses. Moho's switch layer, Spine's slot.
 *
 * The choice is ONE discrete property on the group, `switch`: a member's name
 * (any case) or its place counted from the top (0). Everything that moves a
 * value moves it — keys (a blink is two keys), an expression (`blink()`), a
 * driver off a control bone, an agent, lip sync writing a key per sound —
 * because drivers are baked into the document before anything reads it, and
 * this module only ever reads the group's own value.
 *
 * A member the switch does not show is not part of the picture at that
 * instant, exactly like a clip outside its span: it is not drawn, not hit, not
 * measured in its group's box. The renderer, the live box and a world's
 * evaluation all ask `hiddenBySwitch` at the gate where they ask "is it on
 * screen now?".
 *
 * A name no member has shows the TOP member, so a mouth set missing a shape
 * still has a mouth, and an empty switch shows its top member too.
 */

/** The members a switch chooses among, top first — the layers panel's order (`doc.tracks[0]` is the top). */
export function switchOptions(doc: MotionDocument, groupId: string): Clip[] {
  const out: Clip[] = [];
  for (const track of doc.tracks) {
    if (track.groupId !== groupId) continue;
    for (const clip of track.clips) if (clip.kind !== "audio") out.push(clip);
  }
  return out;
}

/** What the switch asks for at the group's local time: its keys sampled over its stored choice. */
export function switchValueAt(group: GroupClip, localMs: number): string | number {
  const base = group.switch?.show ?? "";
  const track = group.keyframes.find((k) => k.property === "switch" && !k.range);
  if (!track) return base;
  const v: KeyframeValue | undefined = sampleKeyframes([track], localMs)["switch"];
  if (typeof v === "boolean") return v ? 1 : 0;
  return typeof v === "string" || typeof v === "number" ? v : base;
}

/**
 * The member ids a value picks. A number counts from the top (rounded, held
 * to the ends); a name matches every member of that name (a lane cut into
 * several clips of one name is one choice); nothing matching picks the top.
 */
export function switchPick(options: readonly Clip[], value: string | number): Set<string> {
  if (!options.length) return new Set();
  if (typeof value === "number" && Number.isFinite(value)) {
    const i = Math.max(0, Math.min(options.length - 1, Math.round(value)));
    return new Set([options[i]!.id]);
  }
  const want = String(value).trim().toLowerCase();
  if (want) {
    const hit = options.filter((c) => c.name.trim().toLowerCase() === want);
    if (hit.length) return new Set(hit.map((c) => c.id));
    // A number written as text ("2") counts like a number.
    if (/^-?\d+(\.\d+)?$/.test(want)) return switchPick(options, Number(want));
  }
  return new Set([options[0]!.id]);
}

/** The member ids a switch shows at its own local time. */
export function switchShownIds(doc: MotionDocument, group: GroupClip, localMs: number): Set<string> {
  return switchPick(switchOptions(doc, group.id), switchValueAt(group, localMs));
}

// ── The gate ─────────────────────────────────────────────────────────────────

interface SwitchIndex {
  /** Switch group id → the group and the lane it sits on. */
  groups: Map<string, { group: GroupClip; track: Track }>;
  /** Picks remembered per (group, value) — a document's choices are few. */
  picks: Map<string, Set<string>>;
}

const indexMemo = new WeakMap<MotionDocument, SwitchIndex | null>();

function switchIndex(doc: MotionDocument): SwitchIndex | null {
  const settled = isSettledDocument(doc);
  if (settled && indexMemo.has(doc)) return indexMemo.get(doc)!;
  let out: SwitchIndex | null = null;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "group" || !clip.switch) continue;
      out ??= { groups: new Map(), picks: new Map() };
      out.groups.set(clip.id, { group: clip, track });
    }
  }
  if (settled) indexMemo.set(doc, out);
  return out;
}

/** Does any group in this document switch? The common project asks once and pays nothing more. */
export function documentHasSwitches(doc: MotionDocument): boolean {
  return switchIndex(doc) !== null;
}

/**
 * Is `clip` (on `track`) a member its switch does NOT show at comp time
 * `compMs`? Only the switch directly above a member decides; a member inside
 * an unshown option is gone with its option.
 */
export function hiddenBySwitch(doc: MotionDocument, track: Track, clip: Clip, compMs: number): boolean {
  if (!track.groupId) return false;
  const index = switchIndex(doc);
  const at = index?.groups.get(track.groupId);
  if (!at) return false;
  const { group, track: lane } = at;
  const local = clipRenderLocalTime(lane, group, trackLocalTime(lane, group.frameId, compMs))?.local ?? compMs - group.startMs;
  const value = switchValueAt(group, local);
  const key = `${group.id}|${typeof value}|${value}`;
  let pick = index!.picks.get(key);
  if (!pick) {
    pick = switchPick(switchOptions(doc, group.id), value);
    if (isSettledDocument(doc)) index!.picks.set(key, pick);
  }
  return !pick.has(clip.id);
}
