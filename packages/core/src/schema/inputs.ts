import { z } from "zod";

/**
 * COMPONENT INPUTS — a comp's public, keyable interface (Figma component
 * properties, Rive view-model inputs). See `docs/adr/characters/inputs.md`.
 *
 *   frame.inputs        the DEFINITIONS, on the comp that owns them
 *   clip.inputValues    an instance's OVERRIDES (sparse), keyed `input.<id>`
 *   frame.inputValues   a linked instance FRAME's overrides (static — a frame
 *                       has no keyframe tracks)
 *
 * Overrides are sparse on purpose: an input an instance never touched follows
 * the definition's default, so changing the default on the master reaches every
 * instance that did not say otherwise — the Figma rule.
 */

/**
 * `layer` holds a layer id or name in the comp the INSTANCE sits in — how a
 * character's `Voice` names the clip it speaks from (`resolveScopedLayer`).
 */
export const INPUT_TYPES = ["number", "bool", "enum", "text", "color", "trigger", "layer"] as const;
export const inputTypeSchema = z.enum(INPUT_TYPES);
export type InputType = z.infer<typeof inputTypeSchema>;

/** What an input holds. A trigger is a boolean that is true on the frame it fires. */
export const inputValueSchema = z.union([z.number(), z.boolean(), z.string()]);
export type InputValue = z.infer<typeof inputValueSchema>;

export const inputDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: inputTypeSchema,
  default: inputValueSchema,
  /** number: the slider's range. */
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  /** enum: the choices, by name, in order. */
  options: z.array(z.string()).optional(),
});
export type InputDef = z.infer<typeof inputDefSchema>;

/** An instance's overrides, by input id. */
export const inputValuesSchema = z.record(z.string(), inputValueSchema);
export type InputValues = z.infer<typeof inputValuesSchema>;

// ── The binding token ────────────────────────────────────────────────────────
//
// `input:<id>` in a clip's `drivers` map says "this field IS that input of the
// comp it lives in" — the `var:<id>` idea, scoped to the instance being drawn.
// Parsed only through `parseSource` (binding/source.ts) outside this file.

export const INPUT_TOKEN_PREFIX = "input:";

export function inputToken(id: string): string {
  return `${INPUT_TOKEN_PREFIX}${id}`;
}

export function parseInputToken(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(INPUT_TOKEN_PREFIX)) return null;
  const id = value.slice(INPUT_TOKEN_PREFIX.length);
  return id.length > 0 ? id : null;
}
