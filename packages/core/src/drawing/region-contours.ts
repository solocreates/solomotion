import type { Contour } from "../schema/vector";
import { pathBox } from "../pivot";
import { translateSubpaths } from "../vector/geometry";
import { traceRegion, type RegionMask } from "./area";
import { fitClosedContour } from "./path-fit";

/**
 * A flooded REGION becomes a piece of artwork: outline traced, fitted, and
 * placed — the whole of "the bucket poured, now where does the layer go".
 *
 * It lived as a closure inside the drawing overlay, which is the only reason
 * the two bugs below survived a rewrite each: neither is visible by reading,
 * both are obvious the moment you can run the thing.
 *
 * ## The centre must come from the GEOMETRY, not from the mask
 *
 * A path clip has no stored box. Its box is DERIVED (`pathBox`) and its pivot
 * is a fraction of that box, so `transform.x/y` positions the PIVOT — which
 * means the geometry handed in has to be expressed about the point the pivot
 * will land on. Centre the contours on one point and tell the clip another and
 * the artwork renders displaced by the difference, every time, until somebody
 * nudges the layer and the transform absorbs the error.
 *
 * That is exactly what the mask's pixel bounds were: a DIFFERENT centre. It was
 * chosen to stop a fill arriving hundreds of pixels wide — a real symptom, with
 * the wrong lever, because the width came from `pathBox` over an overshooting
 * fit and no choice of centre could shrink it. So the centre is the fitted
 * outline's own, the displacement is unrepresentable, and the overshoot that
 * prompted the workaround is gone anyway now the fit keeps corners instead of
 * throwing control points past them.
 *
 * ## Every loop, in order, never sliced
 *
 * A traced loop set is NESTED — outer contour, then the holes inside it — which
 * is the whole point of `evenodd`. Dropping the "longest few" cuts holes away
 * from the outlines they belong to and fills the windows back in. `traceRegion`
 * filters by AREA instead, which is nesting-safe by construction, and callers
 * must not filter again.
 */
export interface TracedRegion {
  /** Contours about the clip's own centre — ready to hand to `createPathClip`. */
  subpaths: Contour[];
  /** Where that centre sits, in frame-centre coordinates. */
  cx: number;
  cy: number;
}

export function traceRegionContours(
  mask: RegionMask,
  frame: { width: number; height: number },
  opts: {
    /** How far the traced staircase may be simplified before fitting, in px. */
    simplify: number;
    /** Fit tolerance, in frame px — also what counts as a straight edge. */
    fit: number;
    /** Smallest loop worth keeping, in px of AREA (see `traceRegion`). */
    minAreaPx: number;
  },
): TracedRegion | null {
  const loops = traceRegion(mask, opts.simplify, opts.minAreaPx);
  if (loops.length === 0) return null;
  const subpaths: Contour[] = [];
  for (const loop of loops) {
    // `fitClosedContour`, not `fitSubpath`: a region boundary has real corners,
    // and the freehand fitter is tangent-continuous by construction — it rounds
    // a poured triangle into a blob that spills past every edge.
    const fitted = fitClosedContour(loop, opts.fit);
    if (fitted) subpaths.push(fitted);
  }
  if (subpaths.length === 0) return null;
  // Region space (frame top-left px) → frame-centre coordinates…
  translateSubpaths(subpaths, -frame.width / 2, -frame.height / 2);
  // …then about the outline's own centre, which is where the pivot will be.
  const box = pathBox(subpaths);
  translateSubpaths(subpaths, -box.cx, -box.cy);
  return { subpaths, cx: box.cx, cy: box.cy };
}
