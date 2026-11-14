import { z } from "zod";

/**
 * Stored presets — the persisted half of the ONE preset library (see
 * ../presets/library). A preset is a NAMED PATCH for some kind of thing:
 * `effect:glass` carries glass fields, `effect:colorGrade` carries a look.
 * The payload is deliberately opaque (`unknown`): the library validates it
 * against the kind's own owner (the effect registry) at apply time, so a new
 * preset kind needs ZERO schema work here — the foundation is the point.
 *
 * `scope` is NOT stored: a preset's scope is WHERE it lives (this array =
 * project, localStorage = app, code = builtin). Storing it too would be a
 * second source of truth for one fact, and the two would drift the first time
 * a preset is copied between scopes.
 */
export const storedPresetSchema = z.object({
  id: z.string(),
  /** Namespace, e.g. `effect:glass`. Anything may claim one. */
  kind: z.string(),
  name: z.string(),
  /** The patch itself — shape owned by whoever registered the kind. */
  data: z.unknown(),
  /** Optional two-stop swatch the picker renders as the preset's chip. */
  chip: z.tuple([z.string(), z.string()]).nullable().default(null),
  /** Optional heading inside the picker ("Cinematic", "Apple", …). */
  group: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  createdAt: z.number().default(0),
});
export type StoredPreset = z.infer<typeof storedPresetSchema>;
