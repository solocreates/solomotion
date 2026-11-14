/**
 * What the arrow keys move when you are INSIDE a layer.
 *
 * The rule the whole workspace follows: **the arrows move the smallest thing you
 * have selected.** Outside a layer that is the layer; inside an interior editor
 * it is the points that editor owns — vector nodes, a shape's corners — and the
 * layer must hold perfectly still around them, because you didn't select the
 * layer, you selected a point on it.
 *
 * Arrow gestures live in ONE headless dispatcher (`state/keyboard-nav.ts`), but
 * a point selection belongs to the surface that draws and hit-tests it. This is
 * the seam between them: each interior editor registers how to move ITS
 * selection, the dispatcher asks, and neither has to know the other exists. Same
 * pattern as `timeline-viewport.ts` — a headless handle instead of prop-drilling
 * a ref or lifting a Set of point keys into the session store so that a keyboard
 * handler can read it. A new interior editor (mesh points, gradient stops) joins
 * by registering here; the dispatcher never grows an arm for it.
 *
 * Deltas are WORLD units, because that is what the user is aiming: an arrow
 * moves a point the same direction on screen whatever the layer's rotation,
 * scale or shear. Each target folds that into its own space exactly the way its
 * pointer drag does, so the keyboard and the mouse cannot disagree.
 */
export interface NudgeTarget {
  /**
   * Move this editor's selection by a world delta. Return false when the editor
   * isn't open or has nothing selected, so the dispatcher can try the next one.
   */
  nudge(dxWorld: number, dyWorld: number): boolean;
}

let targets: NudgeTarget[] = [];

export const nudgeTargets = {
  /** Register in an effect; the returned fn unregisters. */
  register(target: NudgeTarget): () => void {
    targets = [...targets, target];
    return () => {
      targets = targets.filter((t) => t !== target);
    };
  },
  /**
   * Move the innermost selection. False = no interior editor is holding one, so
   * the caller decides what the arrows mean instead.
   */
  nudge(dxWorld: number, dyWorld: number): boolean {
    for (const t of targets) if (t.nudge(dxWorld, dyWorld)) return true;
    return false;
  },
};
