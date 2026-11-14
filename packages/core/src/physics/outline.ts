import type { MotionDocument, Clip } from "../schema";
import type { PathCommand } from "../vector/geometry";

/**
 * Outlines core cannot see — a text's glyphs need its font, a picture's
 * silhouette its pixels. The app installs the one reader (the
 * `setTextBoxMeasurer` pattern); headless, such a body collides as its box.
 * Shared by flat comps and worlds so a layer collides the same in both.
 */
export type PhysicsOutlineProvider = (doc: MotionDocument, clip: Clip, localMs: number) => PathCommand[] | null;

let provider: PhysicsOutlineProvider | null = null;
let generation = 0;

/**
 * An outline the reader could not give yet has landed (a font loaded, a
 * picture decoded): simulations built without it must be built again. Every
 * memo of a built simulation keys on this.
 */
export function noteOutlinesChanged(): void {
  generation++;
}

export function outlineGeneration(): number {
  return generation;
}

export function setPhysicsOutlineProvider(fn: PhysicsOutlineProvider | null): void {
  provider = fn;
}

export function readPhysicsOutline(doc: MotionDocument, clip: Clip, localMs: number): PathCommand[] | null {
  return provider?.(doc, clip, localMs) ?? null;
}
