import { z } from "zod";

/**
 * PROVENANCE (v75) — where a clip's artwork came from, carried BY the clip.
 *
 * An icon enters the document as ordinary path layers on purpose (there is no
 * icon layer kind, and there must not be one), which means that once it has
 * landed nothing in the geometry says "this was `lucide:rocket`, ISC, by the
 * Lucide contributors". A licence audit six months later has to be able to
 * answer that from the file alone — offline, after a rename, after an ungroup,
 * after a paste into another project — so the fact rides on the clip itself
 * rather than in a side table that every clip-transport path (snapshots, the
 * clipboard, bundles, plugins) would have to remember to carry along.
 *
 * It is stamped on the LEAVES the source produced, never on the group the app
 * wrapped them in: the paths are what came from the icon; the group is a
 * container. A group's provenance is DERIVED from its members
 * (`icons/credits.ts`), which is what keeps "this group holds two icons" an
 * honest answer instead of a stale field.
 *
 * Small by design — the two facts an audit needs (the SPDX id, who to credit)
 * plus the identity to look the rest up by. A set's name, licence text and
 * URL are properties of the SET and live in the catalogue; the prefix is the
 * key. One arm today; a dropped `.svg` file or a library pack is a second arm
 * of the same union, not a second field.
 */
export const iconOriginSchema = z.object({
  kind: z.literal("icon"),
  /** The Iconify id, `prefix:name` — `lucide:rocket`. The prefix names the set. */
  id: z.string().min(1),
  /** The set's SPDX licence id at the time of the drop; null = the catalogue had none. */
  license: z.string().nullable(),
  /** Who the set credits — the line a CC-BY licence needs in a credits list. */
  author: z.string(),
});
export type IconOrigin = z.infer<typeof iconOriginSchema>;

export const clipOriginSchema = z.discriminatedUnion("kind", [iconOriginSchema]);
export type ClipOrigin = z.infer<typeof clipOriginSchema>;

/**
 * GENERATED MEDIA (v81) — an asset a model made: which provider and model,
 * from what prompt, and — when it is an EDIT of another picture (background
 * removed, restyled, extended) — the asset it came from.
 *
 * On the ASSET rather than the clip, because the asset is what was generated:
 * every clip that shows it inherits the answer, and the original survives next
 * to the edit instead of being overwritten. `parentAssetId` links edits into a
 * history tree that is walked, never stored twice — the Media panel reads a
 * lineage by following parents. A dangling parent (deleted original) simply
 * ends the walk.
 */
export const generatedOriginSchema = z.object({
  kind: z.literal("generated"),
  /** What made it: `image`, `video`, `speech`, `edit`… */
  capability: z.string(),
  provider: z.string(),
  model: z.string(),
  prompt: z.string(),
  at: z.number(),
  parentAssetId: z.string().nullable().default(null),
});
export type GeneratedOrigin = z.infer<typeof generatedOriginSchema>;

export const assetOriginSchema = z.discriminatedUnion("kind", [generatedOriginSchema]);
export type AssetOrigin = z.infer<typeof assetOriginSchema>;
