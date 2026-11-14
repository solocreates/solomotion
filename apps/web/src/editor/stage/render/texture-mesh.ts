/**
 * A PICTURE LAID THROUGH TRIANGLES on a 2D canvas — every engine, no WebGL:
 * each triangle is the picture under the affine map that carries its three
 * texture corners onto its three screen corners, clipped to the triangle.
 *
 * Two things keep it fast and seamless:
 *
 *  - Only the triangle's own texels are drawn (a source rect around it, plus a
 *    texel of margin) — never the whole picture per triangle.
 *  - Triangles are grown outward by a hair (`grow`, in screen px) so the
 *    antialiased clip edges of neighbours overlap instead of leaving a seam.
 *
 * And a REGION drawn whole: many cells that share ONE affine map (a part of a
 * bent picture that rides a single bone) are one clip of their rectangles and
 * one `drawImage` — not two triangles each.
 *
 * Shared by the flat comp's depth layers (perspective) and the rig's bent
 * pictures.
 */

export interface P2 {
  x: number;
  y: number;
}

/** The affine map taking three texture points onto three screen points, as canvas `transform` args. Null when degenerate. */
export function affineFromTriangle(t0: P2, t1: P2, t2: P2, p0: P2, p1: P2, p2: P2): [number, number, number, number, number, number] | null {
  const du1 = t1.x - t0.x, dv1 = t1.y - t0.y, du2 = t2.x - t0.x, dv2 = t2.y - t0.y;
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-9) return null;
  const dx1 = p1.x - p0.x, dy1 = p1.y - p0.y, dx2 = p2.x - p0.x, dy2 = p2.y - p0.y;
  const a = (dx1 * dv2 - dx2 * dv1) / det;
  const c = (dx2 * du1 - dx1 * du2) / det;
  const b = (dy1 * dv2 - dy2 * dv1) / det;
  const d = (dy2 * du1 - dy1 * du2) / det;
  return [a, b, c, d, p0.x - a * t0.x - c * t0.y, p0.y - b * t0.x - d * t0.y];
}

/** One textured triangle: `p*` on screen (the ctx's current space), `t*` in picture px. */
export function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { width: number; height: number },
  p0: P2, p1: P2, p2: P2,
  t0: P2, t1: P2, t2: P2,
  grow: number,
): void {
  const m = affineFromTriangle(t0, t1, t2, p0, p1, p2);
  if (!m) return;
  ctx.save();
  if (grow > 0) {
    const cx = (p0.x + p1.x + p2.x) / 3, cy = (p0.y + p1.y + p2.y) / 3;
    const out = (p: P2) => {
      const len = Math.hypot(p.x - cx, p.y - cy) || 1;
      return { x: p.x + ((p.x - cx) / len) * grow, y: p.y + ((p.y - cy) / len) * grow };
    };
    const q0 = out(p0), q1 = out(p1), q2 = out(p2);
    ctx.beginPath();
    ctx.moveTo(q0.x, q0.y);
    ctx.lineTo(q1.x, q1.y);
    ctx.lineTo(q2.x, q2.y);
    ctx.closePath();
    ctx.clip();
  }
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  if (grow <= 0) ctx.drawImage(img, 0, 0);
  else {
    // Only the triangle's own texels (plus one of margin).
    const u0 = Math.max(0, Math.floor(Math.min(t0.x, t1.x, t2.x)) - 1);
    const v0 = Math.max(0, Math.floor(Math.min(t0.y, t1.y, t2.y)) - 1);
    const u1 = Math.min(img.width, Math.ceil(Math.max(t0.x, t1.x, t2.x)) + 1);
    const v1 = Math.min(img.height, Math.ceil(Math.max(t0.y, t1.y, t2.y)) + 1);
    if (u1 > u0 && v1 > v0) ctx.drawImage(img, u0, v0, u1 - u0, v1 - v0, u0, v0, u1 - u0, v1 - v0);
  }
  ctx.restore();
}

/**
 * A REGION of the picture under one affine map (texture → screen): the union
 * of `rects` (texture px) clipped, the picture drawn once. `grow` widens each
 * rect by that many texels so the region overlaps the triangles around it.
 */
export function drawTexturedRegion(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { width: number; height: number },
  map: readonly [number, number, number, number, number, number],
  rects: ReadonlyArray<readonly [number, number, number, number]>,
  grow: number,
): void {
  if (!rects.length) return;
  ctx.save();
  ctx.transform(map[0], map[1], map[2], map[3], map[4], map[5]);
  ctx.beginPath();
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const [x, y, w, h] of rects) {
    ctx.rect(x - grow, y - grow, w + grow * 2, h + grow * 2);
    u0 = Math.min(u0, x - grow), v0 = Math.min(v0, y - grow), u1 = Math.max(u1, x + w + grow), v1 = Math.max(v1, y + h + grow);
  }
  ctx.clip();
  const a = Math.max(0, Math.floor(u0)), b = Math.max(0, Math.floor(v0));
  const c = Math.min(img.width, Math.ceil(u1)), d = Math.min(img.height, Math.ceil(v1));
  if (c > a && d > b) ctx.drawImage(img, a, b, c - a, d - b, a, b, c - a, d - b);
  ctx.restore();
}
