/**
 * LOOKS ARE EFFECT GROUPS — the headless brain behind a parent card in a
 * layer's effect stack (D13).
 *
 * THE SHAPE IS FLAT ON PURPOSE. A group is one more card in the same list —
 * `{ type: "group", name, look?, mix }` — and its members are the cards after
 * it that name it in `group`. Nothing nests. That buys three things a tree
 * would have cost:
 *
 *   - keyframe paths do not move. A member is still `lfx.<id>.<field>`; dragging
 *     a card into or out of a look, or ungrouping it, rewrites no track. Ids
 *     are unique per document, so the path was already unique — a
 *     `lfx.<group>.<child>.<field>` spelling would have bought nothing and
 *     broken every `lfx.<id>.<field>` matcher in the app;
 *   - every walker that asks "does this stack read a backdrop / need a buffer
 *     / use grain?" still sees every real card, so none of them changed;
 *   - an old document is already a valid new one: no card names a group.
 *
 * The invariant `normalizeEffectGroups` keeps: members sit contiguously right
 * after their header, a member of a group that is gone becomes loose, and a
 * header is never itself a member. Every editing verb here returns a
 * normalized list, and the renderer reads `effectGroupPlan`, which tolerates
 * an un-normalized list anyway.
 */

export const EFFECT_GROUP_TYPE = "group";

export interface GroupableEffect {
  id: string;
  type: string;
  enabled: boolean;
  group?: string;
}

export interface EffectGroupCard extends GroupableEffect {
  type: typeof EFFECT_GROUP_TYPE;
  name: string;
  look?: string;
  mix: number;
}

export function isEffectGroup<E extends GroupableEffect>(e: E): e is E & EffectGroupCard {
  return e.type === EFFECT_GROUP_TYPE;
}

/** A group's members, in stack order. */
export function groupMembers<E extends GroupableEffect>(effects: readonly E[], groupId: string): E[] {
  return effects.filter((e) => e.group === groupId && !isEffectGroup(e));
}

/** The groups in a stack, in order. */
export function effectGroups<E extends GroupableEffect>(effects: readonly E[]): Array<E & EffectGroupCard> {
  return effects.filter(isEffectGroup);
}

function loose<E extends GroupableEffect>(e: E): E {
  if (e.group === undefined) return e;
  const { group: _g, ...rest } = e;
  return rest as E;
}

/**
 * Members right after their header; orphans loose; headers never members.
 * Returns the SAME array when it was already normal, so a caller can compare.
 */
export function normalizeEffectGroups<E extends GroupableEffect>(effects: readonly E[]): E[] {
  const headers = new Set(effects.filter(isEffectGroup).map((g) => g.id));
  const byGroup = new Map<string, E[]>();
  for (const e of effects) {
    if (isEffectGroup(e) || !e.group || !headers.has(e.group)) continue;
    (byGroup.get(e.group) ?? byGroup.set(e.group, []).get(e.group)!).push(e);
  }
  const out: E[] = [];
  for (const e of effects) {
    if (isEffectGroup(e)) {
      out.push(loose(e));
      out.push(...(byGroup.get(e.id) ?? []));
    } else if (!e.group || !headers.has(e.group)) {
      out.push(loose(e));
    }
  }
  const same = out.length === effects.length && out.every((e, i) => e === effects[i]);
  return same ? (effects as E[]) : out;
}

/**
 * WHAT THE RENDERER RUNS — the stack as segments. A segment at `mix: 1` is a
 * run of plain cards (loose ones, and the members of any look at full
 * strength, inlined); a segment below 1 is ONE look's members, to be run over
 * the arriving picture and crossfaded with it by `mix`. A look at 0 or
 * switched off contributes nothing at all.
 *
 * Inlining full looks is what makes "a look at mix 1 renders exactly like its
 * cards" a fact of construction instead of a hope about float compositing.
 */
export interface EffectGroupSegment<E> {
  effects: E[];
  mix: number;
  group: string | null;
}

export function effectGroupPlan<E extends GroupableEffect>(
  effects: readonly E[],
  /** Is this card on right now (its keyframed eye)? */
  on: (e: E) => boolean,
  /** A group's mix at this instant (keyframes and modulators resolved). */
  mixOf: (group: E & EffectGroupCard) => number,
): EffectGroupSegment<E>[] {
  const headers = new Map<string, E & EffectGroupCard>();
  for (const e of effects) if (isEffectGroup(e)) headers.set(e.id, e);
  const out: EffectGroupSegment<E>[] = [];
  const full = (e: E) => {
    const last = out[out.length - 1];
    if (last && last.mix >= 1) last.effects.push(e);
    else out.push({ effects: [e], mix: 1, group: null });
  };
  const done = new Set<string>();
  for (const e of effects) {
    if (isEffectGroup(e)) {
      if (done.has(e.id)) continue;
      done.add(e.id);
      if (!on(e)) continue;
      const mix = Math.max(0, Math.min(1, mixOf(e)));
      if (mix <= 0) continue;
      const members = effects.filter((m) => m.group === e.id && !isEffectGroup(m) && on(m));
      if (!members.length) continue;
      if (mix >= 1) members.forEach(full);
      else out.push({ effects: members, mix, group: e.id });
      continue;
    }
    if (e.group && headers.has(e.group)) continue; // ran with its header
    if (on(e)) full(e);
  }
  return out;
}

// ── Editing verbs (pure; callers own undo and keyframe cleanup) ──────────────

/**
 * Append a look — `header` followed by `cards` as its members — to the stack.
 * Inserting is the point: applying a look used to REPLACE the whole stack,
 * which threw away whatever the layer already wore.
 */
export function insertEffectGroup<E extends GroupableEffect>(effects: readonly E[], header: E & EffectGroupCard, cards: readonly E[], at = effects.length): E[] {
  const members = cards.filter((c) => !isEffectGroup(c)).map((c) => ({ ...c, group: header.id }));
  const next = [...effects];
  next.splice(Math.max(0, Math.min(at, next.length)), 0, loose(header) as E, ...members);
  return normalizeEffectGroups(next);
}

/**
 * Put another look on an existing group: its members are replaced, its place,
 * mix and eye are kept. Returns the ids that left, for keyframe cleanup.
 */
export function swapGroupLook<E extends GroupableEffect>(
  effects: readonly E[],
  groupId: string,
  cards: readonly E[],
  look: { name: string; look?: string },
): { effects: E[]; removed: string[] } {
  const removed = groupMembers(effects, groupId).map((m) => m.id);
  const gone = new Set(removed);
  const next: E[] = [];
  for (const e of effects) {
    if (gone.has(e.id)) continue;
    if (e.id === groupId && isEffectGroup(e)) {
      const header = { ...e, name: look.name } as E & EffectGroupCard;
      if (look.look) header.look = look.look;
      else delete header.look;
      next.push(header, ...cards.filter((c) => !isEffectGroup(c)).map((c) => ({ ...c, group: groupId })));
    } else next.push(e);
  }
  return { effects: normalizeEffectGroups(next), removed };
}

/**
 * Wrap these cards into a new look, placed where the first of them sat. A
 * group in the selection brings its members and dissolves into the new one.
 */
export function groupEffects<E extends GroupableEffect>(effects: readonly E[], ids: readonly string[], header: E & EffectGroupCard): E[] {
  const pick = new Set(ids);
  for (const e of effects) if (isEffectGroup(e) && pick.has(e.id)) for (const m of groupMembers(effects, e.id)) pick.add(m.id);
  const first = effects.findIndex((e) => pick.has(e.id));
  if (first < 0) return [...effects];
  const members = effects.filter((e) => pick.has(e.id) && !isEffectGroup(e)).map((e) => ({ ...e, group: header.id }));
  const dissolved = new Set(effects.filter((e) => isEffectGroup(e) && pick.has(e.id)).map((e) => e.id));
  const rest = effects.filter((e) => !pick.has(e.id)).map((e) => (e.group && dissolved.has(e.group) ? loose(e) : e));
  const before = effects.slice(0, first).filter((e) => !pick.has(e.id)).length;
  rest.splice(before, 0, loose(header) as E, ...members);
  return normalizeEffectGroups(rest);
}

/** Flatten a look: its members stay where they are, loose; the header goes. */
export function ungroupEffects<E extends GroupableEffect>(effects: readonly E[], groupId: string): E[] {
  return normalizeEffectGroups(effects.filter((e) => e.id !== groupId).map((e) => (e.group === groupId ? loose(e) : e)));
}

/**
 * Move one card to `index` (in the list WITHOUT it) and give it a membership —
 * a group id, or null for loose. The drag in and out of a look. A header moved
 * this way carries its members with it.
 */
export function moveEffect<E extends GroupableEffect>(effects: readonly E[], id: string, index: number, group: string | null): E[] {
  const card = effects.find((e) => e.id === id);
  if (!card) return [...effects];
  const carried = isEffectGroup(card) ? [card, ...groupMembers(effects, id)] : [group ? ({ ...card, group } as E) : loose(card)];
  const carriedIds = new Set(carried.map((e) => e.id));
  const rest = effects.filter((e) => !carriedIds.has(e.id));
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, ...carried);
  return normalizeEffectGroups(rest);
}
