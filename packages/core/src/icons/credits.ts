import type { MotionDocument, Clip, ClipOrigin } from "../schema";
import { leafClipsUnderGroup } from "../timeline/groups";
import { locateClip } from "../timeline/ops";
import { licenseNeedsAttribution, parseIconId } from "./catalog";

/**
 * PROVENANCE, READ BACK — the two questions a document has to answer about
 * the artwork it did not draw itself: "where did THIS layer come from" and
 * "what does this project owe". Both are derived from `clip.origin` on the
 * leaves (`schema/provenance.ts`); nothing here is stored.
 */

/**
 * A clip's provenance: its own record, or — for a group — the one record its
 * leaves agree on. A group the app wrapped around an icon answers as the icon;
 * a group a person made out of two icons answers null, because it did not come
 * from anywhere. Derived, so ungrouping, regrouping and renaming cannot leave a
 * stale answer behind.
 */
export function clipProvenance(doc: MotionDocument, clip: Clip): ClipOrigin | null {
  if (clip.origin) return clip.origin;
  if (clip.kind !== "group") return null;
  let shared: ClipOrigin | null = null;
  for (const id of leafClipsUnderGroup(doc, clip.id)) {
    const leaf = locateClip(doc, id)?.clip;
    const origin = leaf?.origin ?? null;
    if (!origin) return null;
    if (shared === null) shared = origin;
    else if (shared.id !== origin.id) return null;
  }
  return shared;
}

/** One icon set's line in the credits: who, under what, and which icons. */
export interface IconCredit {
  /** The set's Iconify prefix — the key into the catalogue for its name and URL. */
  prefix: string;
  license: string | null;
  author: string;
  /** True for CC-BY: the credit is a condition, not a courtesy. */
  required: boolean;
  /** Icon names within the set, sorted, each once however many layers it became. */
  icons: string[];
}

/**
 * Every icon set the document uses, from the leaves up. Keyed by set because
 * that is the unit a licence applies to; an icon dropped twice, or split into
 * five paths, is listed once. Sorted so the same document always produces the
 * same list.
 */
export function iconCredits(doc: MotionDocument): IconCredit[] {
  const sets = new Map<string, { license: string | null; author: string; icons: Set<string> }>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const origin = clip.origin;
      if (!origin || origin.kind !== "icon") continue;
      const ref = parseIconId(origin.id);
      if (!ref) continue;
      let set = sets.get(ref.prefix);
      if (!set) sets.set(ref.prefix, (set = { license: origin.license, author: origin.author, icons: new Set() }));
      set.icons.add(ref.name);
    }
  }
  return [...sets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, s]) => ({
      prefix,
      license: s.license,
      author: s.author,
      required: licenseNeedsAttribution(s.license),
      icons: [...s.icons].sort(),
    }));
}

/**
 * The credits as text you can paste into a description or a README — one
 * line per set, the required ones first. Set names are looked up by the
 * caller when it has the catalogue (`names`); offline, the prefix stands in,
 * which is still the set's public identifier.
 */
export function creditsText(credits: IconCredit[], names: ReadonlyMap<string, string> = new Map()): string {
  return [...credits]
    .sort((a, b) => Number(b.required) - Number(a.required) || a.prefix.localeCompare(b.prefix))
    .map((c) => {
      const set = names.get(c.prefix) ?? c.prefix;
      const licence = c.license ?? "licence not recorded";
      return `Icons: ${set} by ${c.author} (${licence}) — ${c.icons.join(", ")}`;
    })
    .join("\n");
}
