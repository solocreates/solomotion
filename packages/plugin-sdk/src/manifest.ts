import { z } from "zod";
import { CAPABILITIES } from "./capabilities";

/**
 * `<ns>.plugin.json` — the plugin manifest. This is the single source of
 * identity, permissions and presentation for every plugin, first-party or
 * third-party. The schema is versioned (`manifestVersion`) and every optional
 * field defaults, so a minimal manifest is valid and older bundles keep parsing
 * as the schema grows.
 *
 * Design notes for the future-proofing:
 *   • `id` is reverse-DNS (like a bundle identifier) and is the UNIQUENESS key —
 *     re-importing the same id replaces the installed copy.
 *   • `version` is semver, so the host can tell an update from a fresh install.
 *   • `publisherId` is reserved for signed-publisher identity (marketplace,
 *     verified authors) — parsed and stored today, enforced later. Adding it now
 *     means no migration when signing ships.
 *   • `engines.<ns>` gates host compatibility (the host reads its own key).
 */

export const MANIFEST_VERSION = 1;
/**
 * The manifest file: `<ns>.plugin.json` at the bundle root. A host writes its
 * own name and reads any, so a plugin made for one product on this engine
 * installs in another.
 */
export const manifestFileName = (ns: string): string => `${ns}.plugin.json`;
const MANIFEST_FILE = /^[a-z][a-z0-9]*\.plugin\.json$/;
export function isManifestFileName(path: string): boolean {
  return MANIFEST_FILE.test(path);
}

/** Reverse-DNS-style id: dot/underscore/hyphen-separated alphanumeric segments. */
export const PLUGIN_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;

const capabilityKeys = Object.keys(CAPABILITIES) as [keyof typeof CAPABILITIES, ...(keyof typeof CAPABILITIES)[]];

export const pluginAuthorSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  url: z.string().url().optional(),
});

export const pluginWindowSchema = z.object({
  width: z.number().int().positive().max(2400).default(360),
  height: z.number().int().positive().max(2400).default(560),
  minWidth: z.number().int().positive().optional(),
  minHeight: z.number().int().positive().optional(),
  resizable: z.boolean().default(true),
});

export const pluginManifestSchema = z.object({
  manifestVersion: z.literal(MANIFEST_VERSION),
  id: z.string().regex(PLUGIN_ID_RE, "id must be reverse-DNS style, e.g. com.acme.confetti"),
  name: z.string().min(1).max(60),
  version: z.string().regex(SEMVER_RE, "version must be semver, e.g. 1.0.0"),
  description: z.string().max(280).default(""),
  author: pluginAuthorSchema,
  /** Protocol major the plugin targets — checked against PLUGIN_PROTOCOL_VERSION. */
  api: z.number().int().positive(),
  /** Entry HTML inside the bundle — the document loaded into the sandbox iframe. */
  main: z.string().min(1).default("ui.html"),
  /** Icon path inside the bundle (png/svg/webp). Null → a generated glyph avatar. */
  icon: z.string().nullable().default(null),
  capabilities: z.array(z.enum(capabilityKeys)).default([]),
  categories: z.array(z.string()).default([]),
  window: pluginWindowSchema.default({}),
  /** Reserved: signed-publisher identity. Parsed + stored today, enforced later. */
  publisherId: z.string().nullable().default(null),
  /** Host compatibility (a semver range against the editor version). */
  engines: z.record(z.string(), z.string()).default({}),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginAuthor = z.infer<typeof pluginAuthorSchema>;
export type PluginWindowSpec = z.infer<typeof pluginWindowSchema>;

export type ManifestParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

/** Validate an unknown value (parsed JSON) into a manifest, with readable errors. */
export function parseManifest(input: unknown): ManifestParseResult {
  const res = pluginManifestSchema.safeParse(input);
  if (res.success) return { ok: true, manifest: res.data };
  return {
    ok: false,
    errors: res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}
