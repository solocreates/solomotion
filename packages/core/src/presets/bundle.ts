import { z } from "zod";
import { storedPresetSchema, type StoredPreset } from "../schema/presets";
import { stampedId } from "../identity";

/**
 * THE PRESET BUNDLE — presets as a file you can send someone.
 *
 * A preset already travels three ways: built into the app, saved to this
 * browser, or saved into a project. The one thing it could not do was LEAVE,
 * which is the difference between a feature and a thing people build a practice
 * around — a studio's look library, a pack somebody sells, the grade a
 * colourist hands back with the cut.
 *
 * The format is deliberately the least interesting part: plain JSON, one array,
 * the same `StoredPreset` shape the library already persists. No zip, no
 * binary, no second schema. A preset's payload is opaque data owned by whoever
 * registered its `kind` (see `schema/presets.ts`), so a bundle needs to know
 * nothing about effects, grades or text looks — and a kind invented next year
 * exports and imports with no work here at all.
 *
 * `format` and `formatVersion` follow `.motion`'s precedent for the same
 * reason: a stray JSON file must never be mistaken for a library, and the day
 * the container changes, old files have to keep loading.
 */

/** `<ns>-presets`: written by the exporting product, read for any (identity.ts). */
export const PRESET_BUNDLE_FORMAT = stampedId("", "-", "presets");
export const PRESET_BUNDLE_VERSION = 1;
/** Suggested extension, `.<ns>presets`. A plain `.json` also parses — the format field decides. */
export const presetBundleExt = (ns: string): string => `.${ns}presets`;

export const presetBundleSchema = z.object({
  format: z.string().refine((f) => PRESET_BUNDLE_FORMAT.matches(f)),
  formatVersion: z.number().int().positive(),
  /** Free-text provenance, for the import dialog's subtitle. */
  label: z.string().default(""),
  createdAt: z.number().default(0),
  /** The app version that wrote it — diagnostic only, never gating. */
  appVersion: z.string().default(""),
  presets: z.array(storedPresetSchema).default([]),
});
export type PresetBundle = z.infer<typeof presetBundleSchema>;

export class PresetBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetBundleError";
  }
}

/** Build a bundle from a chosen set of presets. */
export function makePresetBundle(
  presets: readonly StoredPreset[],
  meta: { ns: string; label?: string; appVersion?: string },
): PresetBundle {
  return {
    format: PRESET_BUNDLE_FORMAT.of(meta.ns),
    formatVersion: PRESET_BUNDLE_VERSION,
    label: meta.label ?? "",
    createdAt: Date.now(),
    appVersion: meta.appVersion ?? "",
    presets: [...presets],
  };
}

/**
 * Parse a file's text. Throws `PresetBundleError` with a sentence a person can
 * act on, rather than a zod issue list — the failure modes here are "wrong
 * file" and "corrupt file", and both want the same plain answer.
 */
export function parsePresetBundle(text: string): PresetBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PresetBundleError("That file is not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || !PRESET_BUNDLE_FORMAT.matches((raw as { format?: unknown }).format)) {
    throw new PresetBundleError("That is not a preset file.");
  }
  const parsed = presetBundleSchema.safeParse(raw);
  if (!parsed.success) throw new PresetBundleError("That preset file is damaged and could not be read.");
  if ((raw as PresetBundle).formatVersion > PRESET_BUNDLE_VERSION) {
    throw new PresetBundleError("That file was written by a newer version of the app.");
  }
  return parsed.data;
}

/** Looks like a preset bundle without fully parsing — for a drop target. */
export function isPresetBundleText(text: string): boolean {
  return /"format"\s*:\s*"[a-z][a-z0-9]*-presets"/.test(text);
}

/** One row of the pick list: a kind, how many it holds, and their names. */
export interface PresetBundleGroup {
  kind: string;
  count: number;
  names: string[];
}

/**
 * Group a bundle by kind, for the checklist both dialogs show.
 *
 * BY KIND rather than by name, because the decision a person actually makes is
 * "take the grades, leave the text looks" — a hundred individual checkboxes is
 * a list, not a choice. Names ride along for the tooltip so nothing is opaque.
 */
export function groupBundle(presets: readonly StoredPreset[]): PresetBundleGroup[] {
  const by = new Map<string, StoredPreset[]>();
  for (const p of presets) {
    const list = by.get(p.kind);
    if (list) list.push(p);
    else by.set(p.kind, [p]);
  }
  return [...by.entries()]
    .map(([kind, list]) => ({ kind, count: list.length, names: list.map((p) => p.name) }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * Named for its domain, not for what it does. `MergeResult` was already taken
 * by document merge (`io/merge`), and two same-named exports off one barrel is
 * an ambiguity the compiler refuses — correctly, since the two describe
 * different things.
 */
export interface PresetMergeResult {
  list: StoredPreset[];
  added: number;
  replaced: number;
  skipped: number;
}

/**
 * Fold a bundle's presets into an existing library.
 *
 * `kinds` narrows to what the user ticked. A preset whose id is already present
 * is REPLACED when `overwrite`, skipped otherwise — and the count of each comes
 * back so the result can be reported honestly instead of as "imported!".
 *
 * Ids are kept rather than reissued, deliberately: an id is what makes
 * re-importing an updated pack an update rather than a duplicate, and what lets
 * a document's `activePreset` keep recognising the look it was built from.
 */
export function mergePresetBundle(
  existing: readonly StoredPreset[],
  incoming: readonly StoredPreset[],
  opts: { kinds?: ReadonlySet<string>; overwrite?: boolean } = {},
): PresetMergeResult {
  const overwrite = opts.overwrite ?? true;
  const byId = new Map(existing.map((p) => [p.id, p]));
  let added = 0;
  let replaced = 0;
  let skipped = 0;

  for (const p of incoming) {
    if (opts.kinds && !opts.kinds.has(p.kind)) continue;
    if (byId.has(p.id)) {
      if (!overwrite) {
        skipped++;
        continue;
      }
      byId.set(p.id, p);
      replaced++;
    } else {
      byId.set(p.id, p);
      added++;
    }
  }
  return { list: [...byId.values()], added, replaced, skipped };
}
