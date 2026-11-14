import { anchorLocal } from "../transform-map";
import type { AnchorPoint, RasterClip } from "../schema";

/**
 * A PIXEL LAYER THAT GROWS — the geometry half, headless.
 *
 * A raster layer is born the size of the comp, which is a sensible default and
 * a terrible ceiling: the moment a stroke reaches past the frame edge it was
 * silently cut off at the buffer, so drawing an arm that swings out of shot, or
 * roughing a pose larger than the crop, meant losing the part that left. The
 * frame still trims what it SHOWS — that is what a frame is for — but what the
 * layer HOLDS should be whatever you drew.
 *
 * ## Why this is arithmetic and not a schema change
 *
 * `width`/`height` were already the layer's own, independent of the comp; only
 * nothing ever changed them. What made growing look hard is that the box is
 * drawn CENTRED on the layer's origin, so making it bigger on one side alone
 * would slide every existing pixel sideways.
 *
 * It does not have to. A layer positions its box by its PIVOT, and the pivot is
 * stored NORMALISED — a fraction of the box. Re-normalising it to keep pointing
 * at the same pixel is exactly the compensation needed, and it falls out
 * algebraically rather than being tuned:
 *
 *     a  = (anchor - 0.5) · size          the pivot, in local units
 *     a' = a + (l−r)/2, (t−b)/2           where the same PIXEL now sits
 *     anchor' = 0.5 + a' / size'
 *
 * Every point's offset from the pivot is then unchanged, so `mapLinear` — and
 * therefore rotation, scale, skew, the hit rect and the gizmo — all land in
 * exactly the same place. `transform.x/y` is never touched. See the test: it
 * asserts a chosen pixel maps to the same parent-space point through a rotated,
 * scaled, skewed pose before and after growing.
 *
 * ## What refuses to grow, and why
 *
 * A CROPPED layer. A crop is a deliberate window in box pixels; growing the box
 * would either move the window off the content or hide the very paint that
 * asked for the room. "Paint outside my crop and also see it" is a
 * contradiction, so the honest answer is that the layer keeps its size.
 *
 * A RECORDED layer (one with capture snapshots). Every snapshot is its own
 * surface sized from this clip, and they are not all in memory to resize — a
 * silent mismatch there shifts frames of a recording against each other, which
 * is far worse than a stroke stopping at the edge.
 */

/** Extra room on each side, in surface pixels. All zero = no growth. */
export interface SurfacePad {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const NO_PAD: SurfacePad = { left: 0, top: 0, right: 0, bottom: 0 };

export function padIsEmpty(pad: SurfacePad): boolean {
  return pad.left === 0 && pad.top === 0 && pad.right === 0 && pad.bottom === 0;
}

/**
 * The largest a single surface may become. Browsers refuse canvases past
 * roughly this on a side and, more usefully, a layer this big is a mistake
 * rather than an intention — a stroke that would exceed it is clipped at the
 * edge exactly as it used to be everywhere.
 */
export const MAX_SURFACE_PX = 16384;

/**
 * Grow in BLOCKS rather than by the exact overflow.
 *
 * Every growth is an allocate-and-blit of the whole surface, and a stroke
 * travelling steadily outward would otherwise trigger one per frame. A block
 * makes it happen a handful of times per stroke instead, at the cost of some
 * slack — which the next stroke in that direction then uses for free.
 */
export const GROW_BLOCK_PX = 512;

/** A rectangle in surface pixels; `x1`/`y1` are exclusive. */
export interface PixelBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * How much room `bounds` needs beyond a `width`×`height` surface, rounded up to
 * whole blocks and clamped so neither side exceeds {@link MAX_SURFACE_PX}.
 * Returns null when it already fits.
 */
export function padFor(
  bounds: PixelBounds,
  width: number,
  height: number,
  block = GROW_BLOCK_PX,
): SurfacePad | null {
  const up = (v: number) => (v <= 0 ? 0 : Math.ceil(v / block) * block);
  let left = up(-Math.floor(bounds.x0));
  let top = up(-Math.floor(bounds.y0));
  let right = up(Math.ceil(bounds.x1) - width);
  let bottom = up(Math.ceil(bounds.y1) - height);

  // Clamp against the ceiling, spending what room is left on the side that
  // actually asked for it rather than splitting it evenly.
  const spareX = Math.max(0, MAX_SURFACE_PX - width);
  const spareY = Math.max(0, MAX_SURFACE_PX - height);
  if (left + right > spareX) {
    const scale = spareX / (left + right);
    left = Math.floor(left * scale);
    right = Math.floor(right * scale);
  }
  if (top + bottom > spareY) {
    const scale = spareY / (top + bottom);
    top = Math.floor(top * scale);
    bottom = Math.floor(bottom * scale);
  }
  const pad = { left, top, right, bottom };
  return padIsEmpty(pad) ? null : pad;
}

/**
 * May THIS WRITE grow the surface it paints? Decided ONCE, when the write opens,
 * and carried by it (`StrokeTx.grows`) to the commit — never asked again.
 *
 * It used to be asked twice: by the paint (may the canvas grow?) and again by
 * the box writer (may the box grow?). Between those two moments a recorded
 * stroke writes `captureRevs`, so the first answer was "yes" and the second
 * "no": the snapshot canvas grew, the box did not, and the renderer showed the
 * drawing squashed into a corner on release. One question, one answer.
 *
 * A write into a capture SNAPSHOT never grows — a recorded layer's frames are
 * all one box, and one frame cannot be bigger than its neighbours.
 */
export function canGrowRaster(
  clip: Pick<RasterClip, "crop" | "captureRevs">,
  into: "layer" | "snapshot" = "layer",
): boolean {
  if (into === "snapshot") return false;
  const c = clip.crop;
  if (c.left > 0 || c.right > 0 || c.top > 0 || c.bottom > 0) return false;
  return !clip.captureRevs || Object.keys(clip.captureRevs).length === 0;
}

export interface GrownRaster {
  width: number;
  height: number;
  /** Re-normalised so the pivot still points at the same pixel. */
  anchor: AnchorPoint;
}

/**
 * The layer's new geometry after growing by `pad`. Pure: the caller writes
 * these three fields (and nothing else — `transform.x/y` must NOT move).
 */
export function grownRaster(
  clip: Pick<RasterClip, "width" | "height"> & { transform: { anchor: AnchorPoint } },
  pad: SurfacePad,
): GrownRaster {
  const width = clip.width + pad.left + pad.right;
  const height = clip.height + pad.top + pad.bottom;
  const a = anchorLocal(clip.transform.anchor, { width: clip.width, height: clip.height, cx: 0, cy: 0 });
  const ax = a.x + (pad.left - pad.right) / 2;
  const ay = a.y + (pad.top - pad.bottom) / 2;
  return { width, height, anchor: { x: 0.5 + ax / width, y: 0.5 + ay / height } };
}

/**
 * Apply {@link grownRaster} to a clip in place — the one writer.
 *
 * UNCONDITIONAL on purpose. `pad` is what the surface already grew by; the box
 * follows its pixels. Refusing here cannot un-grow a canvas, it can only leave
 * the box smaller than the pixels — which is the squash this replaced.
 */
export function growRasterClip(clip: RasterClip, pad: SurfacePad): boolean {
  if (padIsEmpty(pad)) return false;
  const next = grownRaster(clip, pad);
  clip.width = next.width;
  clip.height = next.height;
  clip.transform = { ...clip.transform, anchor: next.anchor };
  return true;
}
