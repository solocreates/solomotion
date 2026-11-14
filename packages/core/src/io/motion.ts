import { z } from "zod";
import { assetKindSchema } from "../schema/assets";
import { DOCUMENT_VERSION, type MotionDocument } from "../schema";
import { stampedId } from "../identity";

/**
 * The `.motion` project bundle — the host-agnostic contract.
 *
 * A `.motion` file is a ZIP: `manifest.json` (this schema) + `document.json`
 * (the existing document schema, unchanged) + optional embedded media/font
 * bytes. The document already stores media as METADATA keyed by asset id; the
 * bytes live in a host blob store. A bundle serializes those bytes alongside
 * the document so a project is portable — self-contained when media is embedded,
 * or a lightweight references-only file when it is not.
 *
 * This module is pure: the manifest shape plus the two "what does this document
 * reference" collectors. The actual zip/unzip + blob store lives in the host
 * adapter (the web editor today), which reads by the same asset ids.
 */

/** Bumped only when the container layout (not the document schema) changes. */
export const MOTION_FORMAT_VERSION = 1;

/** In-archive paths. Media/fonts are addressed by id/family under these dirs. */
export const MOTION_PATHS = {
  manifest: "manifest.json",
  document: "document.json",
  mediaDir: "media/",
  fontsDir: "fonts/",
} as const;

/** One embedded asset's identity — mirrors the doc's Asset metadata (bytes elsewhere). */
export const motionAssetEntrySchema = z.object({
  id: z.string(),
  kind: assetKindSchema,
  name: z.string(),
  mime: z.string(),
  bytes: z.number().int().min(0),
});
export type MotionAssetEntry = z.infer<typeof motionAssetEntrySchema>;

/**
 * One embedded font FACE.
 *
 * `weight`/`italic` are optional because a bundle written before faces existed
 * has neither, and such a bundle's single blob per family WAS its regular — so
 * the reader's default is the honest migration, not a guess. New bundles always
 * write them, and a family with three faces is three entries.
 */
export const motionFontEntrySchema = z.object({
  family: z.string(),
  fileName: z.string(),
  weight: z.number().int().min(1).max(1000).optional(),
  italic: z.boolean().optional(),
});
export type MotionFontEntry = z.infer<typeof motionFontEntrySchema>;

/** `<ns>-motion`: written by the saving product, read for any (identity.ts). */
export const MOTION_FORMAT = stampedId("", "-", "motion");

export const motionManifestSchema = z.object({
  /** Format discriminator so a stray zip is never mistaken for a project. */
  format: z.string().refine((f) => MOTION_FORMAT.matches(f), "not a .motion manifest"),
  formatVersion: z.number().int().positive(),
  /** The document schema version inside `document.json` (still migrated on read). */
  documentVersion: z.number().int().positive(),
  savedAt: z.number().int().nonnegative(),
  project: z.object({
    id: z.string(),
    name: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  /** Whether media/font bytes are embedded (self-contained) or references-only. */
  mediaIncluded: z.boolean(),
  /** Inventory of embedded media — drives the missing-media / relink UI on read. */
  assets: z.array(motionAssetEntrySchema).default([]),
  fonts: z.array(motionFontEntrySchema).default([]),
  /** Sum of embedded media bytes (storage UI). */
  totalMediaBytes: z.number().int().nonnegative().default(0),
});
export type MotionManifest = z.infer<typeof motionManifestSchema>;

/**
 * Every asset id a document's bytes-bearing bits reference: registered media
 * (`doc.assets`) unioned with custom-sound blobs (`doc.customSounds[].assetId`,
 * which are stored in the same blob store but need not appear in `doc.assets`).
 * This is the exact set a self-contained bundle must embed.
 */
export function collectAssetIds(doc: MotionDocument): string[] {
  const ids = new Set<string>();
  for (const asset of doc.assets) ids.add(asset.id);
  for (const sound of doc.customSounds) ids.add(sound.assetId);
  return [...ids];
}

/** Build a manifest for a document (inventory filled by the host adapter). */
export function makeMotionManifest(
  doc: MotionDocument,
  input: {
    /** The saving product's namespace (`<ns>-motion`). */
    ns: string;
    mediaIncluded: boolean;
    assets?: MotionAssetEntry[];
    fonts?: MotionFontEntry[];
    savedAt?: number;
  },
): MotionManifest {
  const assets = input.assets ?? [];
  const frame = doc.frames[0];
  return {
    format: MOTION_FORMAT.of(input.ns),
    formatVersion: MOTION_FORMAT_VERSION,
    documentVersion: DOCUMENT_VERSION,
    savedAt: input.savedAt ?? Date.now(),
    project: {
      id: doc.id,
      name: doc.name,
      width: frame?.width ?? 1080,
      height: frame?.height ?? 1920,
    },
    mediaIncluded: input.mediaIncluded,
    assets,
    fonts: input.fonts ?? [],
    totalMediaBytes: assets.reduce((sum, a) => sum + a.bytes, 0),
  };
}
