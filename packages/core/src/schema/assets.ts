import { z } from "zod";
import { assetOriginSchema } from "./provenance";
import { assetSpeechSchema } from "./speech";

/**
 * Imported media assets — METADATA ONLY. The document stores what a renderer
 * needs to lay out and time a clip (dimensions, duration); the bytes live in
 * an app-level blob store keyed by asset id (OPFS/IndexedDB on the web, plain
 * files under Tauri later). That keeps project JSON small and portable while
 * the same document plays anywhere the blobs travel.
 */

/** `model` (v89): a 3D file (glTF, OBJ, STL, FBX, PLY) a mesh clip shows. */
export const assetKindSchema = z.enum(["image", "video", "audio", "model"]);
export type AssetKind = z.infer<typeof assetKindSchema>;

export const assetSchema = z.object({
  id: z.string(),
  kind: assetKindSchema,
  /** Original file name, shown in the UI. */
  name: z.string(),
  mime: z.string(),
  /** Byte size of the source file (storage UI, sanity checks). */
  bytes: z.number().int().min(0),
  /** Intrinsic pixel size — image and video. */
  width: z.number().positive().nullable(),
  height: z.number().positive().nullable(),
  /** Intrinsic duration — video, audio, and an image sequence. */
  durationMs: z.number().positive().nullable(),
  /**
   * Frames per second of time-based pictures (v80) — an IMAGE SEQUENCE's rate,
   * which is what turns frame N into an instant. Null where the media has no
   * rate of its own to state (stills, audio, footage we time by the decoder).
   */
  fps: z.number().positive().nullable().default(null),
  /** Media-library folder this asset lives in (null = library root). */
  folderId: z.string().nullable().default(null),
  /** Where the bytes came from when a model made them (v81). Null = imported. */
  origin: assetOriginSchema.nullable().default(null),
  /**
   * SHA-256 of the file as it was imported, hex. How an import of the same file
   * finds the asset whose bytes this device lost (`media/lost-bytes.ts`) when
   * size and name are not enough. Absent on assets imported before it (no
   * version bump: absent reads as "not known", which the rule handles).
   */
  sha256: z.string().optional(),
  /** Lip-sync choices for a recording (engine, known script) — see `schema/speech.ts`. */
  speech: assetSpeechSchema.optional(),
});
export type Asset = z.infer<typeof assetSchema>;

/**
 * A serializable reference to a real on-disk directory a linked folder tracks.
 * `id` is the key the platform stores the live handle under (a persisted
 * File System Access handle on the web; on native the `path` is enough). It's
 * intentionally host-agnostic: on a machine where neither resolves, sync simply
 * can't run and the folder behaves like any other (its already-imported assets
 * stay put) — so it's safe to travel in the project file.
 */
export const directoryRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Absolute OS path when the host is path-based (native shell). */
  path: z.string().nullable().default(null),
});
export type DirectoryRef = z.infer<typeof directoryRefSchema>;

/** One tracked file's fingerprint, so re-sync imports only what actually changed. */
export const linkedIndexEntrySchema = z.object({
  assetId: z.string(),
  mtimeMs: z.number(),
  size: z.number().int().min(0),
});
export type LinkedIndexEntry = z.infer<typeof linkedIndexEntrySchema>;

/**
 * The "this folder stays in sync with a real folder on disk" state carried by a
 * media folder. `index` maps a root-relative POSIX path → the asset it imported
 * to (+ mtime/size for change detection), which is what makes re-sync additive
 * and dedup-safe. Null on an ordinary (unlinked) media folder.
 */
export const linkedFolderSchema = z.object({
  ref: directoryRefSchema,
  index: z.record(z.string(), linkedIndexEntrySchema).default({}),
  /** ISO timestamp of the last successful sync (UI only). */
  syncedAt: z.string().nullable().default(null),
});
export type LinkedFolder = z.infer<typeof linkedFolderSchema>;

/**
 * A media-library folder — organisation only, lives in the document so it saves
 * and travels with the project. Assets reference it by id; folders nest via
 * `parentId` (null = root). Purely a UI grouping — no effect on render/export.
 * `linked` (additive, default null) turns it into a synced mirror of an on-disk
 * folder — see {@link linkedFolderSchema}.
 */
export const mediaFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable().default(null),
  linked: linkedFolderSchema.nullable().default(null),
});
export type MediaFolder = z.infer<typeof mediaFolderSchema>;
