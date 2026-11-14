import type { MotionDocument, Clip, Frame } from "../schema";

/**
 * ≅ — WHEN TWO PIECES OF A DOCUMENT ARE THE SAME THING.
 *
 * The round-trip law of reify is `run(reify(x)) ≅ x`. Equality cannot be `===`
 * on JSON: running a script mints new ids. So ≅ is defined precisely here, in
 * one place the bridge and its tests both use:
 *
 *   x ≅ y  ⇔  there is a renaming of the ids DEFINED inside the subject (clip
 *             ids, and every `id` of anything a clip holds — paints, effects,
 *             bones, ranges, joints, cues…) under which every clip's data is
 *             equal, field by field, AND
 *             • the group structure is the same (who holds whom),
 *             • every pair of subject layers that play at the same time are
 *               stacked in the same order,
 *             • every subject root sits in the same scope (comp or outside
 *               group) under the same outside layers it overlaps,
 *             • every `fx:` expression a clip binds has the same source and
 *               name (expressions live in a document table; they are compared
 *               by content, not by row id).
 *
 * EXCLUDED, on purpose:
 *   • lane identity and lane numbers — a lane only means z among clips that
 *     share an instant, which the stacking clause already compares;
 *   • keyframe-track and key ids, and the ORDER of keyframe tracks — nothing
 *     references them, and the order of tracks never changes a frame;
 *   • ids referenced from OUTSIDE the subject (assets, comps, variables, node
 *     graphs, trackers, sound buses) — they must be equal, literally;
 *   • the comp's own canvas position, page, playhead and plugin data (view
 *     state and bookkeeping, when a whole comp is the subject).
 */

export interface SubjectNode {
  clip: Clip;
  trackIndex: number;
  children: SubjectNode[];
}

/** The clips sitting directly in a group (its rows), with their lane index. */
function membersOf(doc: MotionDocument, groupId: string): Array<{ clip: Clip; trackIndex: number }> {
  const out: Array<{ clip: Clip; trackIndex: number }> = [];
  doc.tracks.forEach((t, i) => {
    if (t.groupId === groupId) for (const c of t.clips) out.push({ clip: c, trackIndex: i });
  });
  return out;
}

function trackIndexOf(doc: MotionDocument, clipId: string): number {
  return doc.tracks.findIndex((t) => t.clips.some((c) => c.id === clipId));
}

/** Deterministic sibling order that does not depend on lane identity. */
function siblingKey(a: { clip: Clip; trackIndex: number }, b: { clip: Clip; trackIndex: number }): number {
  const ca = a.clip;
  const cb = b.clip;
  return (
    ca.startMs - cb.startMs ||
    ca.durationMs - cb.durationMs ||
    (ca.kind < cb.kind ? -1 : ca.kind > cb.kind ? 1 : 0) ||
    (ca.name < cb.name ? -1 : ca.name > cb.name ? 1 : 0) ||
    // Identical twins: stacking decides, top first.
    a.trackIndex - b.trackIndex
  );
}

/** The subject as a tree — roots and everything groups among them hold — in the canonical order. */
export function subjectTree(doc: MotionDocument, roots: readonly string[]): SubjectNode[] {
  const build = (clip: Clip, trackIndex: number): SubjectNode => ({
    clip,
    trackIndex,
    children: clip.kind === "group" ? membersOf(doc, clip.id).sort(siblingKey).map((m) => build(m.clip, m.trackIndex)) : [],
  });
  const found = roots
    .map((id) => {
      const trackIndex = trackIndexOf(doc, id);
      const clip = doc.tracks[trackIndex]?.clips.find((c) => c.id === id);
      return clip ? { clip, trackIndex } : null;
    })
    .filter((x): x is { clip: Clip; trackIndex: number } => !!x);
  return found.sort(siblingKey).map((r) => build(r.clip, r.trackIndex));
}

/** Depth-first, parents before children — the order labels are given in. */
export function flattenTree(nodes: readonly SubjectNode[]): SubjectNode[] {
  const out: SubjectNode[] = [];
  const walk = (n: SubjectNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every id DEFINED inside a clip (not the clip's own), with where it is defined. */
export function definedIds(clip: Clip): Array<{ id: string; path: string }> {
  const out: Array<{ id: string; path: string }> = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (path && typeof o.id === "string") out.push({ id: o.id, path });
      for (const [k, x] of Object.entries(o)) if (k !== "keyframes" || path) walk(x, path ? `${path}.${k}` : k);
    }
  };
  walk(clip, "");
  return out;
}

export interface CanonOptions {
  /** The label a clip id canonicalises to. */
  label: (clipId: string) => string;
  /** The comp the subject lives in, canonicalised to `@here`. */
  frameId?: string;
}

/**
 * Clips in canonical form: ids defined in the subject renamed to where they
 * are defined, expressions inlined, keyframe tracks sorted without their ids.
 * The result is plain JSON — compare with `JSON.stringify` or walk it.
 */
export function canonicalClips(doc: MotionDocument, clips: readonly Clip[], opts: CanonOptions): Map<string, unknown> {
  const rename = new Map<string, string>();
  if (opts.frameId) rename.set(opts.frameId, "@here");
  for (const c of clips) {
    const label = opts.label(c.id);
    rename.set(c.id, `@${label}`);
    for (const d of definedIds(c)) if (!rename.has(d.id)) rename.set(d.id, `@${label}:${d.path}`);
  }
  const ids = [...rename.keys()].sort((a, b) => b.length - a.length);
  const re = ids.length ? new RegExp(ids.map(escapeRe).join("|"), "g") : null;
  const expr = new Map(doc.expressions.map((e) => [e.id, e]));
  const str = (s: string): string => {
    if (s.startsWith("fx:")) {
      const e = expr.get(s.slice(3));
      if (e) return `fx(${e.source})⟨${e.name}⟩`;
    }
    return re ? s.replace(re, (m) => rename.get(m) ?? m) : s;
  };
  const canon = (v: unknown, key: string): unknown => {
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) {
      if (key === "keyframes") {
        return v
          .map((t) => {
            const { id: _id, keys, ...rest } = t as Record<string, unknown> & { keys?: Array<Record<string, unknown>> };
            void _id;
            return canon({ ...rest, keys: (keys ?? []).map(({ id: _k, ...k }) => (void _k, k)) }, "");
          })
          .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      }
      return v.map((x) => canon(x, ""));
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[str(k)] = canon(x, k);
      }
      return out;
    }
    return v;
  };
  return new Map(clips.map((c) => [c.id, canon(c, "")]));
}

/** The comp itself in canonical form (a whole-comp subject). */
export function canonicalFrame(frame: Frame): unknown {
  const { id: _id, x: _x, y: _y, pageId: _p, playheadMs: _ph, pluginData: _pd, ...rest } = frame;
  void [_id, _x, _y, _p, _ph, _pd];
  return JSON.parse(JSON.stringify(rest));
}

const overlaps = (a: Clip, b: Clip) => a.startMs < b.startMs + b.durationMs && b.startMs < a.startMs + a.durationMs;

/** The whole subject, canonical: clips, structure, stacking and outside neighbours. */
export function canonicalSubject(doc: MotionDocument, roots: readonly string[], frameId?: string): unknown {
  const tree = subjectTree(doc, roots);
  const flat = flattenTree(tree);
  const labels = new Map(flat.map((n, i) => [n.clip.id, `L${i}`]));
  const clips = canonicalClips(doc, flat.map((n) => n.clip), { label: (id) => labels.get(id) ?? id, frameId });
  const shape = (n: SubjectNode): unknown => ({ clip: clips.get(n.clip.id), children: n.children.map(shape) });

  // Stacking among the subject: siblings that share an instant.
  const stacking: string[] = [];
  const siblingsOf = (nodes: readonly SubjectNode[]) => {
    const visual = nodes.filter((n) => n.clip.kind !== "audio");
    for (let i = 0; i < visual.length; i++)
      for (let j = i + 1; j < visual.length; j++) {
        const a = visual[i]!;
        const b = visual[j]!;
        if (!overlaps(a.clip, b.clip)) continue;
        stacking.push(a.trackIndex < b.trackIndex ? `${labels.get(a.clip.id)}>${labels.get(b.clip.id)}` : `${labels.get(b.clip.id)}>${labels.get(a.clip.id)}`);
      }
    nodes.forEach((n) => siblingsOf(n.children));
  };
  siblingsOf(tree);

  // Each root's scope and the outside layers above it that it overlaps.
  const subject = new Set(flat.map((n) => n.clip.id));
  const outside = tree.map((root) => {
    const scope = doc.tracks[root.trackIndex]?.groupId ?? null;
    const above: string[] = [];
    if (root.clip.kind !== "audio") {
      doc.tracks.forEach((t, i) => {
        if (i >= root.trackIndex || (t.groupId ?? null) !== scope) return;
        for (const c of t.clips) if (!subject.has(c.id) && c.frameId === root.clip.frameId && c.kind !== "audio" && overlaps(c, root.clip)) above.push(c.id);
      });
    }
    return { scope, above: above.sort() };
  });
  return { tree: tree.map(shape), stacking: stacking.sort(), outside };
}

/** The first few places two canonical values differ, as readable paths. */
export function canonicalDiff(a: unknown, b: unknown, path = "", out: string[] = [], max = 12): string[] {
  if (out.length >= max) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => canonicalDiff(x, b[i], `${path}[${i}]`, out, max));
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) canonicalDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out, max);
    return out;
  }
  out.push(`${path || "(root)"}: ${short(a)} ≠ ${short(b)}`);
  return out;
}

function short(v: unknown): string {
  const s = JSON.stringify(v) ?? "undefined";
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

/** `x ≅ y` for two subjects in (possibly) two documents. */
export function reifyEqual(
  a: { doc: MotionDocument; roots: readonly string[]; frameId?: string },
  b: { doc: MotionDocument; roots: readonly string[]; frameId?: string },
): { equal: boolean; diffs: string[] } {
  const diffs = canonicalDiff(canonicalSubject(a.doc, a.roots, a.frameId), canonicalSubject(b.doc, b.roots, b.frameId));
  return { equal: diffs.length === 0, diffs };
}
