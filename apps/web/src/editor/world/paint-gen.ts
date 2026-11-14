/**
 * PIXELS PAINTED IN PLACE — a brush stroke changes a drawing layer's pixels
 * without a new document, so whatever caches a picture by the document (a
 * layer's plane in space, a comp worn as a mesh's texture) also keys on this
 * count, bumped as the stroke lands. No three.js here: the brush (main chunk)
 * and the engine (lazy chunk) both read it.
 */
const gens = new Map<string, number>();

export function paintGeneration(id: string): number {
  return gens.get(id) ?? 0;
}

export function repaint(id: string): void {
  gens.set(id, (gens.get(id) ?? 0) + 1);
}
