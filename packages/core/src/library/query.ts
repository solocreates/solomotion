import type { IndexPack } from "./manifest";
import type { LibraryItem, LibraryKind, LibrarySource } from "./item";

/**
 * ONE search over the library, wherever it is drawn.
 *
 * The browser, the sound picker's online section and any future surface ask the
 * same question of the same function, so a sound that is findable in one is
 * findable in all. Headless: no React, no fetch — it filters and ranks a list
 * that someone else assembled.
 *
 * Two things it deliberately does that a naive `includes()` does not:
 *
 *  • `#hashtag` is lifted OUT of the text and treated as a tag constraint, so
 *    "#ui click" means tag:ui AND text:click. Typing a hashtag is how people
 *    already narrow a search everywhere else; making it work costs one regex.
 *  • plain text still matches tags. A tag the user cannot find by typing its
 *    name is a tag that may as well not exist.
 */

export type LibrarySort = "relevance" | "name" | "newest" | "used";

export interface LibraryQuery {
  /** Raw text as typed, `#hashtags` and all. */
  text?: string;
  /** Empty = every shelf. */
  kinds?: LibraryKind[];
  /** Empty = every source. */
  sources?: LibrarySource[];
  /** ANDed with any `#hashtag` in `text`. */
  tags?: string[];
  sort?: LibrarySort;
  /** Restrict to a single pack — how "browse this pack" is expressed. */
  packId?: string;
  /**
   * How many times each item id is used in the current project — the ranking
   * signal behind `sort: "used"`.
   *
   * Passed IN rather than computed here because counting uses means reading a
   * document, and this module must stay pure enough to run in a worker and the
   * exporter. `libraryUsage` builds it; the browser hands it over. That keeps
   * one matcher for every surface while letting the ranking know something only
   * the editor can see.
   */
  usage?: ReadonlyMap<string, number>;
}

/** A query split into the parts the matchers actually use. */
export interface ParsedQuery {
  /** Lowercased words with hashtags removed. */
  terms: string[];
  /** Tags from `#hashtag` plus `query.tags`, lowercased. */
  tags: string[];
}

const HASHTAG = /#([\p{L}\p{N}_-]+)/gu;

export function parseQuery(query: LibraryQuery): ParsedQuery {
  const raw = (query.text ?? "").toLowerCase();
  const tags = new Set((query.tags ?? []).map((t) => t.toLowerCase()));
  for (const m of raw.matchAll(HASHTAG)) tags.add(m[1]!);
  const terms = raw
    .replace(HASHTAG, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return { terms, tags: [...tags] };
}

/** Everything about an item a search can look at, joined once per item. */
function haystack(item: LibraryItem): string {
  return `${item.name}\n${item.tags.join(" ")}\n${item.blurb ?? ""}`.toLowerCase();
}

/**
 * Relevance, high is better, 0 = no match.
 *
 * Ranking is name-first on purpose: someone typing "thock" wants the sound
 * called Thock above the twelve sounds tagged `thock`, and a scorer that treats
 * every field alike buries the exact hit under its own category.
 */
function score(item: LibraryItem, parsed: ParsedQuery): number {
  const name = item.name.toLowerCase();
  const tags = item.tags.map((t) => t.toLowerCase());

  for (const tag of parsed.tags) if (!tags.includes(tag)) return 0;
  if (!parsed.terms.length) return 1;

  const hay = haystack(item);
  let total = 0;
  for (const term of parsed.terms) {
    let best = 0;
    if (name === term) best = 100;
    else if (name.startsWith(term)) best = 60;
    else if (name.includes(term)) best = 40;
    else if (tags.some((t) => t === term)) best = 30;
    else if (tags.some((t) => t.includes(term))) best = 18;
    else if (hay.includes(term)) best = 8;
    if (best === 0) return 0; // every term must land somewhere — AND, not OR
    total += best;
  }
  return total;
}

/**
 * Which source wins a tie.
 *
 * Built-ins lead because they are the vocabulary — always there, always free.
 * Then this project's content, then your saved things, then the catalogue.
 *
 * The load-bearing part is that `downloaded` and `online` rank the SAME. A sort
 * key that changes when you acquire something makes the list jump under your
 * cursor mid-click, and no ordering is worth that. The card already says it is
 * yours, in place, without moving.
 */
const SOURCE_RANK: Record<LibrarySource, number> = {
  builtin: 0,
  project: 1,
  user: 2,
  // Downloaded ranks WITH online, not above it. Owning something must not move
  // it: the card upgrades in place (see `mergeLibrary`), and a list that
  // reshuffles under the cursor every time you click is unusable however
  // "correct" the new order is. Where a thing sits is part of what it is.
  online: 3,
  downloaded: 3,
};

export function searchLibrary(items: LibraryItem[], query: LibraryQuery = {}): LibraryItem[] {
  const parsed = parseQuery(query);
  const kinds = query.kinds?.length ? new Set(query.kinds) : null;
  const sources = query.sources?.length ? new Set(query.sources) : null;

  const scored: Array<{ item: LibraryItem; score: number }> = [];
  for (const item of items) {
    if (kinds && !kinds.has(item.kind)) continue;
    if (sources && !sources.has(item.source)) continue;
    if (query.packId && item.packId !== query.packId) continue;
    const s = score(item, parsed);
    if (s > 0) scored.push({ item, score: s });
  }

  const sort = query.sort ?? "relevance";
  const usage = query.usage;
  scored.sort((a, b) => {
    if (sort === "name") return a.item.name.localeCompare(b.item.name);
    if (sort === "newest") return (b.item.createdAt ?? 0) - (a.item.createdAt ?? 0);
    if (sort === "used") {
      // Unused items keep their relevance order below the used ones rather than
      // scrambling into an arbitrary tie — "most used" is a promotion of what
      // you reach for, not a reshuffle of everything else.
      const ua = usage?.get(a.item.id) ?? 0;
      const ub = usage?.get(b.item.id) ?? 0;
      if (ua !== ub) return ub - ua;
      return b.score - a.score || a.item.name.localeCompare(b.item.name);
    }
    return (
      b.score - a.score ||
      SOURCE_RANK[a.item.source] - SOURCE_RANK[b.item.source] ||
      a.item.name.localeCompare(b.item.name)
    );
  });
  return scored.map((s) => s.item);
}

/**
 * Could this pack contain a match? Read against the root index's `terms`, so a
 * query rejects most of the catalogue without downloading any of it. False
 * negatives are impossible (terms are generated from the same fields the item
 * matcher reads); false positives just cost one fetch.
 */
export function packCouldMatch(pack: IndexPack, query: LibraryQuery): boolean {
  if (query.packId && pack.id !== query.packId) return false;
  if (query.kinds?.length && !query.kinds.includes(pack.kind)) return false;
  const parsed = parseQuery(query);
  const terms = new Set(pack.terms);
  const tags = new Set(Object.keys(pack.tagCounts).map((t) => t.toLowerCase()));
  for (const tag of parsed.tags) if (!tags.has(tag)) return false;
  for (const term of parsed.terms) {
    let hit = false;
    for (const t of terms) {
      if (t.includes(term)) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }
  return true;
}

/** Every tag present, most common first — what the filter chips render. */
export function tagFacets(items: LibraryItem[], limit = 24): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) {
      const t = tag.toLowerCase();
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit);
}

/** Searchable tokens for one entry — the generator's half of `packCouldMatch`. */
export function termsFor(name: string, tags: string[], blurb: string | null): string[] {
  const out = new Set<string>();
  const push = (s: string) => {
    for (const w of s.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) if (w.length > 1) out.add(w);
  };
  push(name);
  for (const t of tags) push(t);
  if (blurb) push(blurb);
  return [...out];
}
