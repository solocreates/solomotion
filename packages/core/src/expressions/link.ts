import type { MotionDocument } from "../schema";
import { fxToken, parseFxToken } from "../schema";
import { locateClip } from "../timeline/ops";
import { addExpression, expressionById, setExpressionSource } from "./document";

/**
 * LINK ANYTHING TO ANYTHING — one property following another, written as an
 * ordinary expression (`layer("clip:<id>").rotation`), so there is no second
 * linking mechanism: it evaluates, checks, previews, bakes, exports and undoes
 * exactly like an expression typed by hand, on every path
 * `clipAnimatableProperties` lists — transform, paint, text, every effect
 * field (`lfx.<id>.<field>`), every grade slot, audio effects, bones, inputs.
 *
 * A picked reference names its layer by KEY, not by name. Names are labels: a
 * text layer renames itself as you type into it, and two layers may share
 * one — a link written as `layer("Title")` would silently retarget or break.
 * `layer()` takes either; a person typing writes the name, a pick writes the
 * key (the doc-index grammar ADR-links commits to), and renames cost nothing.
 */

/** The source text that names a layer: `layer("clip:<id>")`. */
export function layerReference(clipId: string): string {
  return `layer(${JSON.stringify(`clip:${clipId}`)})`;
}

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The source text that reads one of a layer's values. A path whose every
 * segment is a name reads as members (`.fill.f1.color`, which the checker
 * types); one that is not — an id starting with a digit — falls back to the
 * two-argument form, which reads the same value directly.
 */
export function propertyReadSource(clipId: string, path: string): string {
  return path.split(".").every((s) => SEGMENT.test(s))
    ? `${layerReference(clipId)}.${path}`
    : `layer(${JSON.stringify(`clip:${clipId}`)}, ${JSON.stringify(path)})`;
}

/**
 * Drive `clipId`'s `path` from `targetClipId`'s `targetPath`. Reuses the
 * expression already on that path when there is one (its id is what other
 * slots may share), else adds a row. Returns the expression id, or null when
 * either layer is missing. The caller owns the history entry.
 */
export function linkPropertyTo(
  doc: MotionDocument,
  clipId: string,
  path: string,
  targetClipId: string,
  targetPath: string,
): string | null {
  if (!locateClip(doc, targetClipId)) return null;
  return driveWith(doc, clipId, path, propertyReadSource(targetClipId, targetPath));
}

/**
 * Drive `clipId`'s `path` with an expression `source`: the one writer every
 * link goes through (a layer's value, a tracker's reading). Reuses the
 * expression already on that path when there is one (its id is what other
 * slots may share), else adds a row. Null when the layer is missing.
 */
export function driveWith(doc: MotionDocument, clipId: string, path: string, source: string): string | null {
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip) return null;
  const drivers = { ...(clip.drivers ?? {}) };
  const current = parseFxToken(drivers[path]);
  const existing = current ? expressionById(doc, current) : undefined;
  if (existing) setExpressionSource(doc, existing.id, source);
  const id = existing?.id ?? addExpression(doc, source, `${clip.name} · ${path}`).id;
  drivers[path] = fxToken(id);
  clip.drivers = drivers;
  return id;
}
