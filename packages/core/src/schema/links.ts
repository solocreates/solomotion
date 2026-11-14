import { z } from "zod";

/**
 * LINKS (v98) — something you can click that goes somewhere. See
 * `docs/adr/ADR-links.md` for the whole model; the short version:
 *
 *   url    leaves the app — https, http, mailto, tel (allow-listed; a
 *          `javascript:` href never parses, see `links/target.ts`)
 *   node   somewhere in THIS project, by the doc-index key (`page:<id>`,
 *          `frame:<id>`, `clip:<id>`) — stable ids, so a rename never breaks
 *          it and a delete is reportable instead of silent
 *   route  anywhere else in the app, as a path in the address grammar
 *          (`/project/<id>?at=…`, `/plugin/<id>?q=…`, `/`). A string so a new
 *          destination is a new route handler, never a schema change
 *
 * One link per source, like an `<a>`: a layer carries `clip.link`, a run of
 * text carries `StyleRange.link`.
 */

export const nodeKeySchema = z.string().regex(/^(page|frame|clip):[^\s,]+$/, "a node key — page:<id>, frame:<id> or clip:<id>");
export type NodeKey = z.infer<typeof nodeKeySchema>;

export const linkTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), href: z.string().min(1) }),
  z.object({
    kind: z.literal("node"),
    node: nodeKeySchema,
    /** A time on the target comp's own clock, ms. Null = wherever it stands. */
    t: z.number().min(0).nullable().default(null),
  }),
  z.object({ kind: z.literal("route"), path: z.string().startsWith("/") }),
]);
export type LinkTarget = z.infer<typeof linkTargetSchema>;

/**
 * How a followed link opens. `auto` is the right answer per target (external →
 * a new tab, in-project → here, a plugin → its window); `here` / `new` are the
 * author overriding it, which is what `_self` / `_blank` are.
 */
export const linkOpenSchema = z.enum(["auto", "here", "new"]);
export type LinkOpen = z.infer<typeof linkOpenSchema>;

export const linkSchema = z.object({
  target: linkTargetSchema,
  open: linkOpenSchema.default("auto"),
});
export type Link = z.infer<typeof linkSchema>;
