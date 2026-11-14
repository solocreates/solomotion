import { z } from "zod";
import { LIBRARY_KINDS } from "./item";
import { PRODUCT_NS_PATTERN } from "./scope";

/**
 * THE WIRE FORMAT of the online catalogue — a two-tier, generated, static
 * manifest served from object storage. No database, no API, no auth: content is
 * editorial, it changes when we decide it changes, and content that ships
 * belongs in version control where review, diff, blame and rollback are free.
 *
 *   v1/index.json            one row per PACK  (~10–20 KB, always fetched)
 *   v1/packs/<packId>.json   full entries      (fetched lazily, per pack)
 *   v1/blobs/<sha256>.<ext>  immutable bytes   (cached forever)
 *
 * `index.json` carries each pack's `terms` — every searchable token in it,
 * deduped. A query filters packs by `terms` WITHOUT downloading any of them,
 * then fetches only the packs that could match. That is a poor man's inverted
 * index and it is the correct amount of machinery here: it scales by adding
 * packs, not by growing one file, and it needs no server to run a query.
 *
 * Everything mechanical in a pack — duration, peaks, sha256, byte size, mime,
 * the detected hit point — is DERIVED at publish time and never hand-written.
 * The only hand-edited file in the content repo is `pack.json`, and it carries
 * editorial facts alone.
 */

/** Bumped only when a reader would misread an older file. */
export const LIBRARY_MANIFEST_VERSION = 1;

export const libraryKindSchema = z.enum(LIBRARY_KINDS);

/**
 * Which products see an item (scope.ts): product namespaces, or null for
 * every product. Absent in older catalogues, which were for everyone.
 */
export const productScopeSchema = z
  .array(z.string().regex(PRODUCT_NS_PATTERN, "a product namespace: lowercase letters and digits"))
  .min(1)
  .nullable()
  .default(null);

export const publisherRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const libraryBlobSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number().int().min(0),
  mime: z.string(),
});

/**
 * A published preview. `none` is legal and honest — a card falls back to its
 * kind's glyph rather than to a placeholder that pretends to be art.
 */
export const manifestPreviewSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("peaks"),
    peaks: z.array(z.number()),
    durationMs: z.number().min(0),
    hitMs: z.number().min(0),
    /**
     * Perceived loudness in dB (see `measureLoudnessDb`). Here, beside the
     * waveform, because this is the set of facts a card must know BEFORE the
     * bytes exist: the ear guard has to decide how far to duck a sound at the
     * moment it is first clicked, and by then it is far too late to measure.
     * Null for a pack published before it was derived.
     */
    loudnessDb: z.number().nullable().default(null),
  }),
  z.object({
    type: z.literal("image"),
    path: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("video"),
    path: z.string(),
    posterPath: z.string().nullable().default(null),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationMs: z.number().min(0),
  }),
]);
export type ManifestPreview = z.infer<typeof manifestPreviewSchema>;

/**
 * What the blob IS, and therefore what downloading it produces. One arm per
 * `LibraryAction` an online item can resolve to, so the download path is a
 * total function rather than a chain of guesses about the file extension.
 */
export const manifestPayloadSchema = z.discriminatedUnion("kind", [
  /** The blob is an audio file; `hitMs` is where it strikes. */
  z.object({
    kind: z.literal("sound"),
    hitMs: z.number().min(0),
    durationMs: z.number().min(0),
    loudnessDb: z.number().nullable().default(null),
  }),
  /** The blob is a `LibrarySnapshot` as JSON — clips, ready to instantiate. */
  z.object({ kind: z.literal("snapshot") }),
  /**
   * The blob is a whole project — a `.motion` bundle, the File menu's own
   * format — and using it makes a new project from it (`instantiateTemplate`).
   */
  z.object({ kind: z.literal("template") }),
  /** No blob: the entry names a preset that ships in the app. */
  z.object({
    kind: z.literal("preset"),
    domain: z.enum(["text", "animation", "transition"]),
    presetId: z.string(),
  }),
]);
export type ManifestPayload = z.infer<typeof manifestPayloadSchema>;

export const manifestEntrySchema = z.object({
  /** Slug, unique within its pack. Half of the item's stable global id. */
  id: z.string(),
  kind: libraryKindSchema,
  name: z.string(),
  tags: z.array(z.string()).default([]),
  blurb: z.string().nullable().default(null),
  /** Markdown, shown only in the detail sheet. Absent for most entries. */
  description: z.string().nullable().default(null),
  blob: libraryBlobSchema.nullable().default(null),
  preview: manifestPreviewSchema.default({ type: "none" }),
  payload: manifestPayloadSchema,
  createdAt: z.number().int().nullable().default(null),
  /** Shelf position from `pack.json` (low first); null = after, newest first. */
  order: z.number().int().nullable().default(null),
  /** Which products see it (scope.ts). */
  products: productScopeSchema,
});
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const packManifestSchema = z.object({
  version: z.number().int(),
  id: z.string(),
  title: z.string(),
  blurb: z.string().nullable().default(null),
  /** The shelf every entry in this pack sits on. Packs are homogeneous by
   *  design — a mixed pack is two packs wearing one name. */
  kind: libraryKindSchema,
  license: z.string().nullable().default(null),
  attribution: z.string().nullable().default(null),
  publisher: publisherRefSchema.nullable().default(null),
  coverPath: z.string().nullable().default(null),
  updatedAt: z.number().int(),
  entries: z.array(manifestEntrySchema),
});
export type PackManifest = z.infer<typeof packManifestSchema>;

/** One pack's row in the root index — everything needed to decide whether to
 *  fetch it, and nothing that would make the index grow with pack CONTENT. */
export const indexPackSchema = z.object({
  id: z.string(),
  title: z.string(),
  blurb: z.string().nullable().default(null),
  kind: libraryKindSchema,
  publisher: publisherRefSchema.nullable().default(null),
  coverPath: z.string().nullable().default(null),
  manifestPath: z.string(),
  itemCount: z.number().int().min(0),
  bytes: z.number().int().min(0),
  /**
   * How many entries carry each tag.
   *
   * A WEIGHT, not a list, because "this pack contains one impact" and "this
   * pack is impacts" are different facts and only the second one is a shelf.
   * A list conflates them, and the conflation is invisible until the catalogue
   * is diverse: at a dozen curated packs a tag named the pack's subject, and at
   * two hundred general ones almost every pack contains at least one of
   * everything, so every category shelf asked for almost every manifest in the
   * catalogue. The tag list is `Object.keys` of this, so there is still exactly
   * one stored fact.
   */
  tagCounts: z.record(z.string(), z.number().int().min(0)).default({}),
  /**
   * Every searchable token in the pack, deduped and lowercased: names, tags,
   * blurbs. A query intersects against this to decide whether the pack can
   * possibly match, so most queries download nothing.
   */
  terms: z.array(z.string()).default([]),
  /** The union of its entries' scopes: which products see the pack at all (scope.ts). */
  products: productScopeSchema,
  updatedAt: z.number().int(),
});
export type IndexPack = z.infer<typeof indexPackSchema>;

export const libraryIndexSchema = z.object({
  version: z.number().int(),
  generatedAt: z.number().int(),
  packs: z.array(indexPackSchema),
});
export type LibraryIndex = z.infer<typeof libraryIndexSchema>;

/* -------------------------------------------------------------------------- */
/* Source shape — the ONE hand-edited file                                     */
/* -------------------------------------------------------------------------- */

/**
 * `pack.json` in the content repo. Editorial facts only: a field that can be
 * computed is never written by hand, which is the same rule the document schema
 * follows and the reason a published pack cannot disagree with its own bytes.
 */
export const packSourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  blurb: z.string().nullable().default(null),
  kind: libraryKindSchema,
  license: z.string().nullable().default(null),
  attribution: z.string().nullable().default(null),
  publisher: publisherRefSchema.nullable().default(null),
  /** Applied to every entry, on top of the entry's own tags. */
  tags: z.array(z.string()).default([]),
  /** Which products see this pack's entries, unless a file says otherwise (scope.ts). */
  products: productScopeSchema,
  files: z.array(
    z.object({
      /** Path relative to the pack directory. */
      file: z.string(),
      /**
       * The path this file had UPSTREAM, when it came from one.
       *
       * Ingest flattens a pack — `Battle/bow.wav` becomes `audio/bow.m4a` —
       * and the folders it drops are the richest input the taxonomy has. Keeping
       * the original path means a later improvement to naming or tagging can be
       * re-derived from the committed pack, instead of re-downloading several
       * hundred archives to recover an input the pipeline already had and threw
       * away. Absent on hand-authored packs, which never had one.
       */
      src: z.string().optional(),
      /** Defaults to a title-cased file stem. */
      name: z.string().optional(),
      tags: z.array(z.string()).default([]),
      blurb: z.string().nullable().default(null),
      description: z.string().nullable().default(null),
      /** Override the detected transient. Only ever needed when the detector
       *  is wrong, which is the point of detecting it. */
      hitMs: z.number().min(0).optional(),
      /** Preview media beside the file, for non-audio packs. */
      preview: z.string().optional(),
      poster: z.string().optional(),
      /** The preview's pixel size, so a card reserves its box before the image lands. */
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      /** Shelf position, low first. The one way to put something first — never a date trick. */
      order: z.number().int().optional(),
      /** Which products see this file; wins over the pack's (scope.ts). */
      products: productScopeSchema.optional(),
    }),
  ),
});
export type PackSource = z.infer<typeof packSourceSchema>;
