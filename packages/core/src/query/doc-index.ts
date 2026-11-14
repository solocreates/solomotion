import type { MotionDocument, Clip, Frame } from "../schema";
import { isComponentFrame } from "../components";
import { INTERNAL_PAGE_ID, pageOfFrame } from "../pages";
import { mediaAssetOf } from "../speech/source";

/**
 * THE DOCUMENT INDEX — every addressable thing in a project (pages, frames,
 * 3D worlds, components, nested comps, layers) as one flat list of nodes, and
 * ONE declarative query over it.
 *
 * Every "pick something from the project" surface reads this: ⌘P's Navigator,
 * the link picker, and — through the pick registry (`pick.ts`), which projects
 * these nodes as its layer, frame and page candidates — every object field and
 * the pick mode. They used to each walk the document their own way, and three
 * walks answer "what can be picked here" three ways.
 *
 * Derived once per document snapshot (WeakMap), so typing into a picker over a
 * ten-thousand-layer project filters a list instead of re-walking a tree.
 */

export type DocNodeKind = "page" | "frame" | "world" | "component" | "comp" | "layer";

export interface DocNode {
  /** Unique across kinds: `page:<id>`, `frame:<id>`, `clip:<id>`. */
  key: string;
  kind: DocNodeKind;
  id: string;
  name: string;
  /** Where it lives — shown under the name, searched too. */
  where: string;
  /** The page it is on (null for pages). */
  pageId: string | null;
  /** The comp a LAYER lives in; a frame's own id for frame kinds. */
  frameId: string | null;
  /**
   * Facets a filter can require — a layer's clip kind, and its CAPABILITIES:
   * `visual` (paints pixels), `audible` (makes sound), `media` (plays a file),
   * `voice` (a recording a mouth can follow), `world` (a 3D object), `body`
   * (simulated). Strings, so a new facet is one line here and no new filter
   * field anywhere.
   */
  tags: readonly string[];
  clip?: Clip;
  frame?: Frame;
  /** Lower-cased `name where`, what search scores against. */
  hay: string;
}

const indexCache = new WeakMap<MotionDocument, DocNode[]>();

export function docIndex(doc: MotionDocument): DocNode[] {
  const hit = indexCache.get(doc);
  if (hit) return hit;
  const pageName = new Map(doc.pages.map((p) => [p.id, p.name]));
  const frameName = new Map(doc.frames.map((f) => [f.id, f.name || "Untitled"]));
  const pageOf = new Map(doc.frames.map((f) => [f.id, pageOfFrame(doc, f)]));
  const hosts = new Map<string, Clip>();
  for (const t of doc.tracks) for (const c of t.clips) if (c.kind === "nested") hosts.set(c.sourceFrameId, c);
  const out: DocNode[] = [];
  const push = (n: Omit<DocNode, "hay">) => out.push({ ...n, hay: `${n.name} ${n.where}`.toLowerCase() });

  for (const p of doc.pages) {
    if (p.id === INTERNAL_PAGE_ID) continue;
    push({ key: `page:${p.id}`, kind: "page", id: p.id, name: p.name, where: "Page", pageId: null, frameId: null, tags: [] });
  }
  for (const f of doc.frames) {
    const host = hosts.get(f.id);
    const page = pageOf.get(f.id) ?? null;
    const internal = page === INTERNAL_PAGE_ID;
    const where = host ? `in ${frameName.get(host.frameId) ?? "a comp"}` : internal ? "Nested" : (pageName.get(page ?? "") ?? "Page");
    const kind: DocNodeKind = f.world ? "world" : isComponentFrame(f) ? "component" : host || internal ? "comp" : "frame";
    push({ key: `frame:${f.id}`, kind, id: f.id, name: f.name || "Untitled", where, pageId: page, frameId: f.id, tags: internal ? ["internal"] : [], frame: f });
  }
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (c.kind === "audio" && !c.name) continue;
      const tags = clipTags(c);
      const page = pageOf.get(c.frameId) ?? null;
      if (page === INTERNAL_PAGE_ID) tags.push("internal");
      push({
        key: `clip:${c.id}`,
        kind: "layer",
        id: c.id,
        name: c.name || c.kind,
        where: frameName.get(c.frameId) ?? "",
        pageId: page,
        frameId: c.frameId,
        tags,
        clip: c,
      });
    }
  }
  indexCache.set(doc, out);
  return out;
}

/** A layer's facets: its kind, then what it can DO. */
function clipTags(c: Clip): string[] {
  const tags: string[] = [c.kind];
  if (c.kind !== "audio") tags.push("visual");
  if (c.kind === "audio" || c.kind === "video" || c.kind === "nested") tags.push("audible");
  if (mediaAssetOf(c)) tags.push("media", "voice");
  if (WORLD_KINDS.has(c.kind)) tags.push("world");
  if (c.kind !== "audio" && c.physics) tags.push("body");
  return tags;
}

const WORLD_KINDS: ReadonlySet<Clip["kind"]> = new Set(["mesh", "camera", "light", "empty"]);

/** Group membership by track, computed per snapshot for `within`. */
const groupsCache = new WeakMap<MotionDocument, Map<string, string | null>>();
function parentGroupOf(doc: MotionDocument): Map<string, string | null> {
  let hit = groupsCache.get(doc);
  if (hit) return hit;
  hit = new Map();
  for (const t of doc.tracks) for (const c of t.clips) hit.set(c.id, t.groupId ?? null);
  groupsCache.set(doc, hit);
  return hit;
}

/** Is this clip under that group, at any depth? Memoised per snapshot. */
export function isUnderGroup(doc: MotionDocument, clipId: string, groupId: string): boolean {
  const parents = parentGroupOf(doc);
  let at = parents.get(clipId) ?? null;
  for (let guard = 0; at && guard < 64; guard++) {
    if (at === groupId) return true;
    at = parents.get(at) ?? null;
  }
  return false;
}

/**
 * A subsequence score: every query character must appear in order. Starts of
 * words and runs of consecutive characters score higher; an exact prefix of
 * the name wins outright. −1 = no match. `query` is expected lower-cased.
 */
export function docNodeScore(query: string, node: { name: string; hay: string }): number {
  if (!query) return 0;
  const label = node.name.toLowerCase();
  if (label.startsWith(query)) return 1000 - label.length;
  const text = node.hay;
  let score = 0;
  let from = 0;
  let run = 0;
  for (const ch of query) {
    const at = text.indexOf(ch, from);
    if (at < 0) return -1;
    const wordStart = at === 0 || " ·-_/".includes(text[at - 1]!);
    run = at === from ? run + 1 : 0;
    score += 1 + (wordStart ? 8 : 0) + run * 3 - Math.min(at - from, 10) * 0.2;
    from = at + 1;
  }
  // A match inside the name beats one that needed the "where".
  return score + (label.includes(query) ? 40 : 0);
}

/** Nodes matching `text`, best first; the input order when `text` is empty. */
export function searchDocNodes<N extends { name: string; hay: string }>(nodes: readonly N[], text: string): N[] {
  const q = text.trim().toLowerCase();
  if (!q) return [...nodes];
  return nodes
    .map((n) => ({ n, s: docNodeScore(q, n) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.n);
}
