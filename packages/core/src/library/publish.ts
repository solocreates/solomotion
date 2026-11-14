import { z } from "zod";
import { libraryKindSchema, packSourceSchema, publisherRefSchema, type PackSource } from "./manifest";

/**
 * PUBLISHING — the contract between the editor and the content repo.
 *
 * The decision this encodes, stated once so it is not re-litigated:
 *
 *   **Publishing writes to the CONTENT REPO, not to R2.** The editor produces a
 *   commit's worth of files; a human reviews and pushes; `library:publish`
 *   syncs. Git stays the source of truth, which is what buys review, diff,
 *   blame, rollback and an atomic publish for free, and what keeps a bad upload
 *   from being the live catalogue.
 *
 * And the identity decision, which is the one that would be expensive to get
 * wrong:
 *
 *   **A publisher is a keypair, not an account.** No auth, no sessions, no
 *   password reset, no GDPR surface. `publisherId` is recorded on everything
 *   published, so "edit only your own" is enforceable from the first day — and
 *   when the queue eventually needs a database, the only thing that changes is
 *   where `verifyPublisher` looks. The client does not change at all.
 *
 * The DERIVED fields (`hitMs`, `durationMs`, `peaks`) are computed by the
 * EDITOR, with the same `analyzeAudio` the build script runs, because the
 * editor already has the decoded audio and the server has neither the bytes
 * decoded nor a reason to decode them twice.
 */

export const publisherCredentialsSchema = z.object({
  id: z.string().min(1),
  secret: z.string().min(1),
});
export type PublisherCredentials = z.infer<typeof publisherCredentialsSchema>;

/** The editorial half of a publish — everything a human typed into the form. */
export const publishEntrySchema = z.object({
  /** File name inside the pack, extension included. */
  fileName: z.string().min(1),
  name: z.string().min(1),
  tags: z.array(z.string()).default([]),
  blurb: z.string().nullable().default(null),
  /** Markdown. Only ever shown in the detail sheet. */
  description: z.string().nullable().default(null),
  /** Overrides the detector, when the author disagrees with it. */
  hitMs: z.number().min(0).optional(),
});
export type PublishEntry = z.infer<typeof publishEntrySchema>;

export const publishRequestSchema = z.object({
  publisher: publisherCredentialsSchema,
  pack: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase, digits and dashes"),
    title: z.string().min(1),
    blurb: z.string().nullable().default(null),
    kind: libraryKindSchema,
    license: z.string().nullable().default(null),
    attribution: z.string().nullable().default(null),
    tags: z.array(z.string()).default([]),
  }),
  entry: publishEntrySchema,
  /** The bytes, base64. Small by policy — see the build script's budget. */
  fileBase64: z.string().min(1),
  /**
   * The card's still, rendered by the editor at publish (a project's frame
   * under the playhead). One image per item, never a live render: a grid of
   * community projects must cost what a grid of pictures costs.
   */
  preview: z
    .object({
      base64: z.string().min(1),
      ext: z.enum([".webp", ".png", ".jpg"]),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .nullable()
    .default(null),
});
export type PublishRequest = z.infer<typeof publishRequestSchema>;

export const publishResponseSchema = z.object({
  ok: z.literal(true),
  packId: z.string(),
  entryId: z.string(),
  /** Repo-relative path the bytes landed at. */
  path: z.string(),
  /** True when the entry replaced one with the same file name. */
  replaced: z.boolean(),
});
export type PublishResponse = z.infer<typeof publishResponseSchema>;

/**
 * Fold one entry into a pack's source, creating the pack if it is new.
 *
 * Pure, so the route is thin and the merge rule is testable: an entry with the
 * same `file` REPLACES rather than duplicating, because republishing a fix is
 * the common case and a pack that accumulates three versions of one sound is
 * how a library rots. `publisher` is stamped from the verified credentials and
 * never taken from the request body.
 */
/** Where an entry's still lives in the pack: beside its file, `<stem>.poster<ext>`. */
export function previewPathFor(fileName: string, ext: string): string {
  return `${fileName.replace(/\.[^./]+$/, "")}.poster${ext}`;
}

export function upsertPackSource(
  existing: PackSource | null,
  request: PublishRequest,
  publisher: { id: string; name: string },
): { pack: PackSource; replaced: boolean } {
  const base: PackSource =
    existing ??
    packSourceSchema.parse({
      id: request.pack.id,
      title: request.pack.title,
      blurb: request.pack.blurb,
      kind: request.pack.kind,
      license: request.pack.license,
      attribution: request.pack.attribution,
      publisher,
      tags: request.pack.tags,
      files: [],
    });

  const file = {
    file: request.entry.fileName,
    name: request.entry.name,
    tags: request.entry.tags.map((t) => t.toLowerCase()),
    blurb: request.entry.blurb,
    description: request.entry.description,
    ...(request.entry.hitMs === undefined ? {} : { hitMs: request.entry.hitMs }),
    ...(request.preview
      ? {
          preview: previewPathFor(request.entry.fileName, request.preview.ext),
          width: request.preview.width,
          height: request.preview.height,
        }
      : {}),
  };

  const index = base.files.findIndex((f) => f.file === file.file);
  const files = [...base.files];
  // `order` is the curator's, not the publisher's: a republish keeps the shelf spot.
  const order = index >= 0 ? base.files[index]!.order : undefined;
  if (index >= 0) files[index] = order === undefined ? file : { ...file, order };
  else files.push(file);

  return {
    pack: { ...base, publisher, files },
    replaced: index >= 0,
  };
}

/**
 * Verify a publisher against a roster. The roster is a JSON array today and a
 * database table later; this signature is the seam between the two, and it is
 * the only thing that has to change.
 */
export const publisherRecordSchema = publisherRefSchema.extend({ secret: z.string().min(8) });
export type PublisherRecord = z.infer<typeof publisherRecordSchema>;

/**
 * Parse the roster from its env-var form. Lives here rather than in the route
 * so the server never has to import zod itself — and so the "roster" concept
 * has exactly one definition to move when it becomes a table.
 */
export function parsePublisherRoster(raw: string | undefined): PublisherRecord[] {
  if (!raw) return [];
  try {
    return z.array(publisherRecordSchema).parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function verifyPublisher(
  roster: PublisherRecord[],
  credentials: PublisherCredentials,
): { id: string; name: string } | null {
  const row = roster.find((p) => p.id === credentials.id);
  if (!row) return null;
  // Length-independent compare, so a wrong secret leaks nothing about the right
  // one. Not a hot path; correctness beats cleverness.
  if (!timingSafeEqual(row.secret, credentials.secret)) return null;
  return { id: row.id, name: row.name };
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
