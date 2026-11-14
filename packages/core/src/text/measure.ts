import type { MotionDocument, TextClip } from "../schema";
import type { LayerBox } from "../transform-map";

/**
 * How big is a text layer, really — the ONE answer, injected.
 *
 * Every other kind of layer declares its own box: a shape stores `width`/
 * `height`, an image reads its asset, a nested comp reads its frame. Text is the
 * one kind whose box can only be MEASURED — you have to lay the glyphs out in
 * the actual loaded font to know how wide the word is — and that measurement
 * needs a 2D context, which core (headless: no DOM, no `window`) cannot have.
 *
 * So `clipNaturalSize` used to GUESS: `longestLine * fontSize * 0.6`. The
 * renderer, meanwhile, used the real measured layout. That is two answers to one
 * question, and they disagree by however wrong the guess is — which is a lot,
 * because 0.6em per character is a different number for every string and every
 * face. Everything headless (hit rects, snapping, align/distribute, the resize
 * solver, the pivot crosshair and its drag) sat on the guess while the picture
 * sat on the measurement, so:
 *
 *  - dragging the pivot of a text layer MOVED THE TEXT, by the ratio between the
 *    guessed and measured widths — the pivot is stored as a fraction of the box,
 *    and the gesture was taking a fraction of a box nobody was drawing;
 *  - the same fraction painted the crosshair somewhere other than where the
 *    drag thought it was grabbing it.
 *
 * The fix is not to teach core about fonts, and it is certainly not to make the
 * guess cleverer. It is to let the surface that CAN measure hand its measurement
 * back, exactly like the platform ports do for the filesystem: one registration
 * at startup, and from then on every headless caller gets the real box, from the
 * same layout engine that paints it, with no caller changing at all.
 *
 * Nothing registers in a worker, a test or an export that runs before fonts are
 * up — those fall back to the approximation and keep working, which is why this
 * returns `null` rather than throwing.
 */
export type TextBoxMeasurer = (
  doc: MotionDocument,
  clip: TextClip,
) => LayerBox | null;

let measurer: TextBoxMeasurer | null = null;

/**
 * Install the app's text measurement. Called once, by the module that owns the
 * layout engine; passing `null` removes it (tests that want the fallback).
 */
export function setTextBoxMeasurer(fn: TextBoxMeasurer | null): void {
  measurer = fn;
}

/** The measured box for a text clip, or null when nothing can measure. */
export function measuredTextBox(doc: MotionDocument, clip: TextClip): LayerBox | null {
  return measurer ? measurer(doc, clip) : null;
}

/**
 * THE OTHER HALF OF MEASURING: the faces have to BE there. A canvas measures a
 * web font it has not loaded yet in its fallback, silently — so a script that
 * made a text layer and asked for its `box` straight away got the fallback's
 * width and laid a card out around it (the Playground's builds waited on a
 * render and an 800 ms sleep to dodge this). The surface that loads faces
 * registers how; a command that RETURNS a measured box awaits it first. Never
 * rejects: a face that fails to load measures in its fallback, as it renders.
 */
export type TextFaceLoader = (doc: MotionDocument, clips: readonly TextClip[]) => Promise<void>;

let faceLoader: TextFaceLoader | null = null;

/** Install the app's face loading. Passing `null` removes it. */
export function setTextFaceLoader(fn: TextFaceLoader | null): void {
  faceLoader = fn;
}

/** Resolves once these text layers' faces can be measured (at once, headless). */
export function textFacesReady(doc: MotionDocument, clips: readonly TextClip[]): Promise<void> {
  if (!faceLoader || clips.length === 0) return Promise.resolve();
  return faceLoader(doc, clips).catch(() => undefined);
}
