import type { MotionDocument, Behavior, BehaviorOverride, BehaviorStep, GroupClip, KeyframeValue, PoseSet } from "../schema";
import { createId } from "../ids";
import { addMachine, addState } from "../machines/ops";
import { locateClip } from "../timeline/ops";
import { compFps, frameStepMs } from "../timeline/fps";
import { BEHAVIOR, behaviorDef, behaviorValue, type BehaviorType } from "./registry";
import { behaviorGeneratedAt, drivesSet, overrideAt, withOverride, withoutOverride, type BehaviorEnv } from "./evaluate";

/**
 * BEHAVIOR VERBS — what the stack UI, the timeline's blocks, the Face pad and
 * agents do to a character's behaviors. Every op MUTATES the document it is
 * given (call it inside one `store.update`) and refuses by returning null /
 * false, never by throwing: the API layer turns that into a message.
 */

function groupOf(doc: MotionDocument, groupId: string): GroupClip | null {
  const c = locateClip(doc, groupId)?.clip;
  return c?.kind === "group" ? c : null;
}

/** The set a set-behavior of `type` is FOR on this character: one of its vocabulary, else the first set. */
export function defaultSetFor(group: GroupClip, type: string): PoseSet | null {
  const def = behaviorDef(type);
  if (def?.drives !== "set" || type === "machine") return null;
  const sets = group.poses ?? [];
  if (def.wants) {
    const hit = sets.find((s) => s.vocabulary === def.wants) ?? sets.find((s) => new RegExp(def.wants === "visemes" ? "mouth|lip" : def.wants!.replace(/s$/, ""), "i").test(s.name));
    if (hit) return hit;
  }
  return type === "cycle" ? (sets[0] ?? null) : null;
}

/**
 * Add a behavior of `type` to a character — tailored to it: its set (by the
 * vocabulary the kind wants), its poses (a Blink shuts with the set's Closed,
 * passes through its Half), its bone. `fields` override any of that. Returns
 * the new behavior, or null for an unknown type or a missing group.
 */
export function addBehavior(doc: MotionDocument, groupId: string, type: string, fields: Record<string, string | number | boolean> = {}, opts: { index?: number; steps?: BehaviorStep[] } = {}): Behavior | null {
  const group = groupOf(doc, groupId);
  const def = behaviorDef(type);
  if (!group || !def) return null;
  const b = BEHAVIOR.create(type as BehaviorType);
  const set = fields.set !== undefined ? (group.poses ?? []).find((s) => s.id === fields.set || s.name === fields.set) ?? null : defaultSetFor(group, type);
  if (def.drives === "set" && set) b.set = set.id;
  if (type === "blink" && set) {
    const names = set.poses.map((p) => p.name);
    const closed = names.find((n) => /^(closed|shut|blink)$/i.test(n)) ?? names[names.length - 1];
    const half = names.find((n) => /^(half|halfway|squint|drowsy)$/i.test(n));
    if (closed) b.closed = closed;
    if (half) b.half = half;
  }
  if (type === "cycle" && set && !opts.steps) b.steps = set.poses.slice(0, 2).map((p, i) => ({ pose: p.name, ms: i === 0 ? 2400 : 160 }));
  if (opts.steps) b.steps = opts.steps;
  if (type === "machine" && fields.machine === undefined) b.machine = starterMachineFor(doc, group, set);
  for (const [k, v] of Object.entries(fields)) {
    if (k === "set" && set) continue;
    if (k === "id" || k === "type" || k === "overrides" || k === "steps") continue;
    if (k === "enabled") b.enabled = v !== false;
    else b[k] = v;
  }
  const list = [...(group.behaviors ?? [])];
  list.splice(opts.index ?? list.length, 0, b);
  group.behaviors = list;
  return b;
}

/**
 * A State machine behavior is never born empty. It runs the comp's machine no
 * other behavior of this character runs yet; failing that, a new one with a
 * state per pose of the set it drives (the first is the entry), so the card
 * opens on states that already DO something instead of a picker over nothing.
 * Returns the machine id ("" when the comp is gone).
 */
export function starterMachineFor(doc: MotionDocument, group: GroupClip, set: PoseSet | null): string {
  const frame = doc.frames.find((f) => f.id === group.frameId);
  if (!frame) return "";
  const taken = new Set((group.behaviors ?? []).filter((b) => b.type === "machine").map((b) => String(b.machine ?? "")));
  const free = (frame.machines ?? []).find((m) => !taken.has(m.id));
  if (free) return free.id;
  const m = addMachine(frame, group.name);
  const layer = m.layers[0]!;
  const poses = set?.poses.slice(0, 6) ?? [];
  if (!poses.length) addState(layer, { name: "Idle", x: 260, y: 80 });
  poses.forEach((p, i) => addState(layer, { name: p.name, x: 120 + i * 200, y: 80, output: { kind: "pose", set: set!.id, pose: p.name } }));
  return m.id;
}

/** Find a behavior by id, or by type / label (the first). */
export function behaviorIn(group: GroupClip, ref: string): Behavior | null {
  const list = group.behaviors ?? [];
  return list.find((b) => b.id === ref) ?? list.find((b) => b.type === ref) ?? list.find((b) => (behaviorDef(b.type)?.label ?? "").toLowerCase() === ref.trim().toLowerCase()) ?? null;
}

/** Patch a behavior's fields (`enabled`, `steps` included). False when it is not there. */
export function updateBehavior(doc: MotionDocument, groupId: string, ref: string, patch: Record<string, string | number | boolean | BehaviorStep[] | null>): boolean {
  const group = groupOf(doc, groupId);
  const b = group ? behaviorIn(group, ref) : null;
  if (!group || !b) return false;
  group.behaviors = (group.behaviors ?? []).map((x) => {
    if (x.id !== b.id) return x;
    const next: Behavior = { ...x };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "type" || k === "overrides") continue;
      if (k === "steps") next.steps = Array.isArray(v) ? (v as BehaviorStep[]) : undefined;
      else if (k === "enabled") next.enabled = v !== false;
      else if (v === null) delete next[k];
      else next[k] = v as string | number | boolean;
    }
    return next;
  });
  return true;
}

/** Remove a behavior; its keyed fields go with it. */
export function removeBehavior(doc: MotionDocument, groupId: string, ref: string): boolean {
  const group = groupOf(doc, groupId);
  const b = group ? behaviorIn(group, ref) : null;
  if (!group || !b) return false;
  const list = (group.behaviors ?? []).filter((x) => x.id !== b.id);
  group.behaviors = list.length ? list : undefined;
  const prefix = `${BEHAVIOR.prefix}.${b.id}.`;
  group.keyframes = group.keyframes.filter((k) => !k.property.startsWith(prefix));
  if (group.drivers) {
    const rest = Object.fromEntries(Object.entries(group.drivers).filter(([p]) => !p.startsWith(prefix)));
    group.drivers = Object.keys(rest).length ? rest : undefined;
  }
  return true;
}

/** Move a behavior to `index` in the stack (priority: later wins). */
export function reorderBehavior(doc: MotionDocument, groupId: string, ref: string, index: number): boolean {
  const group = groupOf(doc, groupId);
  const b = group ? behaviorIn(group, ref) : null;
  if (!group || !b) return false;
  const list = (group.behaviors ?? []).filter((x) => x.id !== b.id);
  list.splice(Math.max(0, Math.min(list.length, index)), 0, b);
  group.behaviors = list;
  return true;
}

// ── Overrides ───────────────────────────────────────────────────────────────

/**
 * From group-local `fromMs` to `toMs` the behavior shows `pose` (null: stands
 * aside, your keys show). Cuts what it covers out of earlier overrides.
 */
export function overrideBehavior(doc: MotionDocument, groupId: string, ref: string, span: { fromMs: number; toMs: number; pose: string | null }): BehaviorOverride | null {
  const group = groupOf(doc, groupId);
  const b = group ? behaviorIn(group, ref) : null;
  if (!group || !b || !(span.toMs > span.fromMs)) return null;
  const o: BehaviorOverride = { id: createId("ovr"), fromMs: span.fromMs, toMs: span.toMs, pose: span.pose };
  setOverrides(group, b.id, withOverride(b.overrides, o));
  return o;
}

/** Back to automatic over a group-local range (all of it when absent). Returns how many spans were touched. */
export function resetBehaviorOverrides(doc: MotionDocument, groupId: string, ref: string, range?: { fromMs: number; toMs: number }): number {
  const group = groupOf(doc, groupId);
  const b = group ? behaviorIn(group, ref) : null;
  if (!group || !b?.overrides?.length) return 0;
  const before = b.overrides.length;
  const next = range ? withoutOverride(b.overrides, range.fromMs, range.toMs) : [];
  setOverrides(group, b.id, next);
  return range ? Math.max(1, before - next.length) : before;
}

function setOverrides(group: GroupClip, id: string, list: BehaviorOverride[]): void {
  group.behaviors = (group.behaviors ?? []).map((x) => (x.id === id ? (list.length ? { ...x, overrides: list } : (({ overrides: _o, ...rest }) => rest as Behavior)(x)) : x));
}

/**
 * The BLOCK of a behavior under comp time `compMs` on a set: the run of frames
 * around it where that behavior asks for one pose (generated or overridden),
 * in group-local ms — what "override this block" covers. Null where it is
 * quiet. Looks at most `limitMs` either way (a cycle's long hold is still a block).
 */
export function behaviorBlockAt(
  doc: MotionDocument,
  group: GroupClip,
  set: PoseSet,
  ref: string,
  compMs: number,
  env: BehaviorEnv = {},
  limitMs = 10_000,
): { fromMs: number; toMs: number; pose: string } | null {
  const b = behaviorIn(group, ref);
  if (!b || !drivesSet(b, set, doc)) return null;
  const at = (t: number) => {
    const o = overrideAt(b, t - group.startMs);
    return o ? (o.pose ?? undefined) : behaviorGeneratedAt(doc, group, set, b, t, env);
  };
  const pose = at(compMs);
  if (pose === undefined) return null;
  const step = frameStepMs(compFps(doc, group.frameId));
  const k0 = Math.floor(compMs / step + 1e-6);
  const grid = (k: number) => {
    const g = k * step;
    return Math.abs(g - Math.round(g)) < 1e-6 ? Math.round(g) : g;
  };
  let lo = k0;
  while (grid(lo - 1) >= group.startMs && compMs - grid(lo - 1) <= limitMs && at(grid(lo - 1)) === pose) lo--;
  let hi = k0 + 1;
  while (grid(hi) < group.startMs + group.durationMs && grid(hi) - compMs <= limitMs && at(grid(hi)) === pose) hi++;
  return { fromMs: Math.max(group.startMs, grid(lo)) - group.startMs, toMs: Math.min(group.startMs + group.durationMs, grid(hi)) - group.startMs, pose };
}

/**
 * Move a behavior's block (group-local `[fromMs, toMs)`) by `deltaMs`: the
 * behavior stands aside where it was and shows the block's pose where it now
 * is — a blink you nudged later, a syllable you slid. `toFromMs`/`toToMs`
 * trim instead (an edge drag). Returns the new span.
 */
export function moveBehaviorBlock(
  doc: MotionDocument,
  groupId: string,
  ref: string,
  block: { fromMs: number; toMs: number; pose: string },
  to: { fromMs: number; toMs: number },
): { fromMs: number; toMs: number } | null {
  const group = groupOf(doc, groupId);
  const b = group ? behaviorIn(group, ref) : null;
  if (!group || !b || !(to.toMs > to.fromMs)) return null;
  let list = withOverride(b.overrides, { id: createId("ovr"), fromMs: block.fromMs, toMs: block.toMs, pose: null });
  list = withOverride(list, { id: createId("ovr"), fromMs: to.fromMs, toMs: to.toMs, pose: block.pose });
  setOverrides(group, b.id, list);
  return to;
}

/** A readable summary of one behavior: its kind, what it drives, its fields and overrides. */
export function describeBehavior(group: GroupClip, b: Behavior): Record<string, unknown> {
  const def = behaviorDef(b.type);
  const fields: Record<string, KeyframeValue | undefined> = {};
  for (const f of def?.fields ?? []) fields[f.key] = behaviorValue(b, f.key);
  for (const t of def?.toggles ?? []) fields[t.key] = behaviorValue(b, t.key);
  const setId = typeof b.set === "string" ? b.set : "";
  const set = (group.poses ?? []).find((s) => s.id === setId);
  return {
    id: b.id,
    type: b.type,
    label: def?.label ?? b.type,
    enabled: b.enabled !== false,
    ...(set ? { set: set.name } : {}),
    fields,
    ...(b.steps ? { steps: b.steps } : {}),
    overrides: (b.overrides ?? []).map((o) => ({ fromMs: o.fromMs, toMs: o.toMs, pose: o.pose })),
  };
}

/** Replace a behavior's overrides outright (a drag re-applies its edit to the list it started from). */
export function setBehaviorOverrides(doc: MotionDocument, groupId: string, ref: string, list: readonly BehaviorOverride[]): boolean {
  const group = groupOf(doc, groupId);
  const b = group ? behaviorIn(group, ref) : null;
  if (!group || !b) return false;
  setOverrides(group, b.id, [...list]);
  return true;
}
