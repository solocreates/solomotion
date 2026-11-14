/**
 * The generation of every depth map the host holds — bumped when maps land,
 * change or go. Its own module (no imports) so the perception generation
 * (`evaluate/heard.ts`) can read it without pulling the tracking graph in.
 */
let generation = 0;

export function noteDepthChanged(): void {
  generation++;
}

export function depthGeneration(): number {
  return generation;
}
