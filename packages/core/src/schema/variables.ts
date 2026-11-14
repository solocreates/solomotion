import { z } from "zod";
import { keyframeTrackSchema } from "./animation";
import { modulatorSchema } from "./modulators";
import { paintSchema, type Paint } from "./vector";
import { FX_TOKEN_PREFIX } from "./expressions";
import { EXPR_TOKEN_PREFIX } from "./nodes";

/**
 * Document variables — named, reusable, TYPED values. Any bindable slot in the
 * document may store the token `var:<id>` instead of a literal; renderers
 * resolve it through `doc.variables`, so editing a variable updates every
 * linked slot at once (Figma variables).
 *
 * The table is one typed union so a single manager, resolver and usage/rename/
 * delete engine serve every type. Adding a new variable type is one variant
 * here + one entry in the resolver/editor registries — nothing else.
 */

/** The universal reference token stored in a bound slot. */
export const VAR_TOKEN_PREFIX = "var:";

/** Matches a `var:<id>` token specifically. */
export const varTokenRegex = /^var:.+/;

// ── The token grammar ────────────────────────────────────────────────────────
//
// `var:<id>`, optionally `var:<id>/<alpha>` where alpha is 0..1.
//
// THE MODIFIER EXISTS BECAUSE OPACITY IS NOT A COLOUR.
//
// Figma's rule is that any edit to a bound slot detaches it, and for a colour
// that is right: "make this one shape bluer" must not restyle every layer that
// shares the reference. But alpha is not a property of the brand colour — it is
// how much of it this slot lets through, a compositing decision that belongs
// with blend mode, not with the swatch. Detaching on it meant that fading
// something out silently broke its link to the palette, and nothing on screen
// said so.
//
// So a bound slot carries its own alpha, and `parseVarToken` ignores it
// outright. That is the whole reason nothing else in the system had to learn
// this exists: usage counts, rename, delete-detach, the driver env and
// `parseSource` keep working on alpha-carrying tokens because to them the token
// is unchanged.
//
// Ids are `<prefix>_<nanoid>` over [0-9a-z], so `/` cannot occur in one and the
// split is unambiguous.

/** A reference token. `alpha` (0..1) is written only when it is not fully opaque. */
export function varToken(id: string, alpha?: number): string {
  const a = alpha === undefined ? 1 : Math.max(0, Math.min(1, alpha));
  const rounded = Math.round(a * 1000) / 1000;
  return rounded >= 1 ? `${VAR_TOKEN_PREFIX}${id}` : `${VAR_TOKEN_PREFIX}${id}/${rounded}`;
}

/** The variable id inside a token, or null when the value is a literal. */
export function parseVarToken(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(VAR_TOKEN_PREFIX)) return null;
  const body = value.slice(VAR_TOKEN_PREFIX.length);
  const slash = body.indexOf("/");
  const id = slash === -1 ? body : body.slice(0, slash);
  return id === "" ? null : id;
}

/**
 * The slot's own alpha (0..1), or null when the token carries none — which is
 * the difference between "this slot is fully opaque" and "this slot has nothing
 * to say about opacity", and a caller that is merging needs to know which.
 */
export function parseVarAlpha(value: unknown): number | null {
  if (typeof value !== "string" || !value.startsWith(VAR_TOKEN_PREFIX)) return null;
  const slash = value.indexOf("/", VAR_TOKEN_PREFIX.length);
  if (slash === -1) return null;
  const a = Number(value.slice(slash + 1));
  return Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : null;
}

/** The same reference at a different alpha. A literal passes through untouched,
 *  so a caller may hand this whatever the slot happens to hold. */
export function withVarAlpha(value: string, alpha: number): string {
  const id = parseVarToken(value);
  return id === null ? value : varToken(id, alpha);
}

/**
 * Every reference token a bindable slot may legally hold: a variable, a written
 * expression, or a node graph. ONE pattern governs all three because a slot does
 * not care which kind of reference it is holding — resolving that is the
 * resolver's job — it only has to accept the shape.
 *
 * Learned the hard way: while this pattern knew only about `var:`, zod happily
 * accepted an `fx:` token in memory and then REJECTED it on load, so a document
 * with an expression on a font size saved fine and refused to reopen. Any new
 * token scheme belongs here on the day it is invented.
 */
export const referenceTokenRegex = new RegExp(
  `^(${VAR_TOKEN_PREFIX}|${FX_TOKEN_PREFIX}|${EXPR_TOKEN_PREFIX}).+`,
);

export const variableTypeSchema = z.enum([
  "color",
  "paint",
  "number",
  "fontFamily",
  "fontWeight",
  "string",
]);
export type VariableType = z.infer<typeof variableTypeSchema>;

const variableBase = {
  id: z.string(),
  name: z.string(),
  /**
   * Optional animation. A variable is a doc-level value, so — unlike a clip — its
   * track is global (times are the document playhead, no clip-start offset). The
   * ONE conventional property key `"value"` holds it, so every core keyframe
   * primitive (`sampleKeyframes`, `setKeyframe`, curves, …) works unchanged; the
   * value-based interpolation fallback means numbers lerp and colors blend with
   * no registry entry. Absent/empty = a plain static value (the common case).
   */
  keyframes: z.array(keyframeTrackSchema).optional(),
  /**
   * A node graph DRIVING this variable (`expr:<graphId>@<node>.<socket>`), set
   * by wiring the Variables node's INPUT socket — the write half of that node.
   *
   * Stored as a reference resolved at READ time, never as a value written during
   * evaluation. That is the whole design: a graph that wrote into
   * `doc.variables` while it evaluated would make the result depend on the order
   * graphs happened to run in, let two graphs fight over one variable, and mutate
   * the document from inside a render pass. A driver token has none of those
   * problems, and it makes the conflict question trivial — a variable has at most
   * ONE driver, so a second wire is a question to ask the user, not a race to
   * lose. Null = an ordinary value you edit by hand.
   */
  //
  // Optional for the same two reasons `clip.drivers` is: every existing document
  // migrates for free, and a variable that never met the node board does not
  // carry a null in every saved file.
  driver: z.string().nullable().optional(),
  /**
   * Signals shaping this variable's value — the same modulator objects a clip
   * property carries, targeting the same conventional key (`"value"`, or
   * `value.<sub>` on a paint).
   *
   * They live ON the variable rather than in a document-level list because a
   * modulator belongs to the thing it drives: deleting the variable takes its
   * wiggle with it, duplicating one duplicates its wiggle, and exporting a
   * library carries the motion along instead of leaving a dangling target path
   * in a table somewhere else. Optional, so a variable that was never
   * modulated does not carry an empty array in every saved file.
   */
  modulators: z.array(modulatorSchema).optional(),
  /**
   * The folder this variable is filed under (`doc.variableFolders`), or null
   * for the root. A folder is also what an imported LIBRARY becomes, so a
   * palette is not a second kind of container with its own rules — it is a
   * folder that remembers where it came from.
   */
  folderId: z.string().nullable().optional(),
  /**
   * Free-text note. Figma's style description: the one place to say "use this
   * for pressed states, not hover" without inventing a naming convention.
   */
  description: z.string().optional(),
};

/** The conventional property key a variable's single keyframe track animates. */
export const VARIABLE_TRACK_KEY = "value";

export const colorVariableSchema = z.object({
  ...variableBase,
  type: z.literal("color"),
  /** A literal color (hex/rgba string). */
  value: z.string(),
});
/**
 * A whole PAINT as a variable — a gradient, a pattern, an image fill, or a
 * solid, reusable everywhere a fill or a stroke can go.
 *
 * `color` stays its own type rather than being folded into this one. They are
 * genuinely different promises: a colour variable can be bound to any colour
 * SLOT in the document — a shadow, a stop inside somebody else's gradient, a
 * text highlight — and a paint cannot, because those slots want a hex, not a
 * pattern. Collapsing them would either make every colour slot swallow a
 * pattern it cannot draw, or make gradients unbindable. Two types, two honest
 * promises, one table.
 */
export const paintVariableSchema = z.object({
  ...variableBase,
  type: z.literal("paint"),
  value: paintSchema,
});
export const numberVariableSchema = z.object({
  ...variableBase,
  type: z.literal("number"),
  value: z.number(),
});
export const fontFamilyVariableSchema = z.object({
  ...variableBase,
  type: z.literal("fontFamily"),
  /** A font family name (as consumed by the font loader / picker). */
  value: z.string(),
});
export const fontWeightVariableSchema = z.object({
  ...variableBase,
  type: z.literal("fontWeight"),
  value: z.number().int().min(100).max(1000),
});
export const stringVariableSchema = z.object({
  ...variableBase,
  type: z.literal("string"),
  value: z.string(),
});

export const variableSchema = z.discriminatedUnion("type", [
  colorVariableSchema,
  paintVariableSchema,
  numberVariableSchema,
  fontFamilyVariableSchema,
  fontWeightVariableSchema,
  stringVariableSchema,
]);
// Explicitly annotated (not `z.infer`) for the same reason the paint leaves
// are: a paint variable pulls the whole paint union into the variable table,
// which rides the document, and the inferred type would push it past TS's
// serialization limit. Keep in sync when a variant changes.
type VariableCommon = {
  id: string;
  name: string;
  keyframes?: z.infer<typeof keyframeTrackSchema>[];
  driver?: string | null;
  modulators?: z.infer<typeof modulatorSchema>[];
  folderId?: string | null;
  description?: string;
};
export type Variable =
  | (VariableCommon & { type: "color"; value: string })
  | (VariableCommon & { type: "paint"; value: Paint })
  | (VariableCommon & { type: "number"; value: number })
  | (VariableCommon & { type: "fontFamily"; value: string })
  | (VariableCommon & { type: "fontWeight"; value: number })
  | (VariableCommon & { type: "string"; value: string });

/** The concrete JS value a variable of a given type stores. */
export type VariableValueOf<T extends VariableType> = Extract<Variable, { type: T }>["value"];

/**
 * A field that may hold a literal `T` OR a `var:<id>` reference token. The token
 * is just a string, so the union keeps `T`'s own type for literals — resolve it
 * through the type's resolver (`resolveNumber`, `resolveColor`, …) before use.
 */
export type VarToken = string & { readonly __varToken?: never };
export type Bindable<T> = T | VarToken;

/** Wrap an inner value schema so the slot also accepts a `var:<id>` token. */
export function Bindable<S extends z.ZodTypeAny>(inner: S) {
  return z.union([inner, z.string().regex(referenceTokenRegex)]);
}

/**
 * A folder in the variables table — and the ONE container the whole feature has.
 *
 * A palette, a theme, an imported library, a user's own grouping: all of them
 * are a named set of variables with a parent, so all of them are this. Giving
 * "libraries" their own type would have produced a second tree with its own
 * rename, its own drag rules, its own export format and its own bugs, and the
 * first time someone dragged a library colour into a personal folder the two
 * would have had to learn about each other anyway.
 *
 * `source` is the only thing an imported library adds: where it came from, so
 * an update can find it again and the UI can say a folder is not yours. A
 * folder without one is simply a folder you made.
 */
export const variableFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Parent folder, or null for a top-level one. Nesting is unrestricted. */
  parentId: z.string().nullable().default(null),
  /** Optional accent for the folder chip — a palette's own identity colour. */
  accent: z.string().optional(),
  description: z.string().optional(),
  /** Present when this folder came from a built-in or imported library. */
  source: z
    .object({ libraryId: z.string(), version: z.number().int().min(1).default(1) })
    .optional(),
});
export type VariableFolder = z.infer<typeof variableFolderSchema>;

/**
 * Back-compat alias: the pre-v35 color-only variable shape was `{id,name,value}`
 * with no `type`. Kept as a name so older code/tests referencing `ColorVariable`
 * still resolve to the color variant.
 */
export type ColorVariable = Extract<Variable, { type: "color" }>;
