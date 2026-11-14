import type { AABB } from "../snapping/viewport-snap";

/**
 * Headless 2D camera math — the pure brain behind "don't get lost" (leash) and
 * "focus on selection" (fit) on any pan/zoom surface (Stage today; a native
 * canvas adapter tomorrow). No DOM, no store: callers feed world-space bounds
 * and a viewport size, get back a camera, and decide whether to apply it.
 */

/** A 2D pan/zoom camera: world→screen is `screenPx = worldPx * scale + t`. */
export interface Camera {
  scale: number;
  tx: number;
  ty: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export function worldToScreenAABB(box: AABB, cam: Camera): AABB {
  return {
    minX: box.minX * cam.scale + cam.tx,
    minY: box.minY * cam.scale + cam.ty,
    maxX: box.maxX * cam.scale + cam.tx,
    maxY: box.maxY * cam.scale + cam.ty,
  };
}

export function screenToWorldAABB(box: AABB, cam: Camera): AABB {
  return {
    minX: (box.minX - cam.tx) / cam.scale,
    minY: (box.minY - cam.ty) / cam.scale,
    maxX: (box.maxX - cam.tx) / cam.scale,
    maxY: (box.maxY - cam.ty) / cam.scale,
  };
}

/** Do two axis-aligned boxes share any area (touching edges don't count)? */
export function aabbsIntersect(a: AABB, b: AABB): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

/** The world rect a viewport of this size currently shows, at this camera. */
export function visibleWorldRect(cam: Camera, viewport: ViewportSize): AABB {
  return screenToWorldAABB({ minX: 0, minY: 0, maxX: viewport.width, maxY: viewport.height }, cam);
}

/** Is any part of `bounds` currently on screen? The one predicate every
 *  "should I auto-focus" decision reduces to — visible at all, at whatever
 *  zoom/pan the user left it at, means leave the camera alone. */
export function isBoundsVisible(bounds: AABB, cam: Camera, viewport: ViewportSize): boolean {
  return aabbsIntersect(bounds, visibleWorldRect(cam, viewport));
}

/** Is ALL of `bounds` on screen? The navigation gate: going somewhere you can
 *  only half see still moves the camera; going where you already are does not. */
export function isBoundsFullyVisible(bounds: AABB, cam: Camera, viewport: ViewportSize): boolean {
  const view = visibleWorldRect(cam, viewport);
  return bounds.minX >= view.minX && bounds.maxX <= view.maxX && bounds.minY >= view.minY && bounds.maxY <= view.maxY;
}

export interface FitCameraOptions {
  /** Empty space kept around the bounds on every side, in screen px. */
  paddingPx?: number;
  minScale?: number;
  maxScale?: number;
}

const DEFAULT_FIT_PADDING = 72;

/** Frame `bounds` centered in the viewport with padding — Figma's "zoom to
 *  fit". Used both for the Stage's initial whole-document fit and for
 *  focus-on-selection; one formula, so they can never drift apart. */
export function fitCamera(bounds: AABB, viewport: ViewportSize, opts: FitCameraOptions = {}): Camera {
  const padding = opts.paddingPx ?? DEFAULT_FIT_PADDING;
  const w = Math.max(1e-6, bounds.maxX - bounds.minX);
  const h = Math.max(1e-6, bounds.maxY - bounds.minY);
  const raw = Math.min((viewport.width - padding * 2) / w, (viewport.height - padding * 2) / h);
  const scale = Math.min(Math.max(raw, opts.minScale ?? 0.02), opts.maxScale ?? 2);
  return {
    scale,
    tx: (viewport.width - w * scale) / 2 - bounds.minX * scale,
    ty: (viewport.height - h * scale) / 2 - bounds.minY * scale,
  };
}

export interface LeashOptions {
  /** How far past the content the camera may drift before being pulled back,
   *  in viewport-widths/heights (scale-independent — "one screen further"
   *  feels the same zoomed in or out). */
  slack?: number;
}

const DEFAULT_LEASH_SLACK = 1;

/**
 * "Don't allow us to go too far from the nearest frame." Pans (never zooms —
 * scale has its own min/max clamp at the call site) the camera back only once
 * the content has drifted entirely out of a generous slack margin around the
 * viewport. Near/inside content, this is a total no-op — it only catches the
 * "flung into empty space and lost" case.
 */
export function clampCameraToLeash(cam: Camera, contentBounds: AABB, viewport: ViewportSize, opts: LeashOptions = {}): Camera {
  const slack = opts.slack ?? DEFAULT_LEASH_SLACK;
  const marginX = viewport.width * slack;
  const marginY = viewport.height * slack;
  const content = worldToScreenAABB(contentBounds, cam);

  let dx = 0;
  let dy = 0;
  if (content.maxX < -marginX) dx = -marginX - content.maxX;
  else if (content.minX > viewport.width + marginX) dx = viewport.width + marginX - content.minX;
  if (content.maxY < -marginY) dy = -marginY - content.maxY;
  else if (content.minY > viewport.height + marginY) dy = viewport.height + marginY - content.minY;

  if (dx === 0 && dy === 0) return cam;
  return { scale: cam.scale, tx: cam.tx + dx, ty: cam.ty + dy };
}

/**
 * SMART FOCUS (D16) — reveal `bounds` without fighting the person.
 *
 * - ANY part of it on screen → the camera does not move. Not a nudge, nothing.
 * - Fully off screen → the SMALLEST pan that brings it in, `paddingPx` clear
 *   of the edge it came from. A target wider than the view lands its near edge
 *   at the padding, so you see where it starts rather than an arbitrary middle.
 * - Never a zoom. Scale changes only when asked (⇧2, double-click → fitCamera).
 *
 * Returns the SAME camera object when nothing should move, so a caller can
 * compare by identity and skip the store write.
 */
export function panToReveal(bounds: AABB, cam: Camera, viewport: ViewportSize, paddingPx = 48): Camera {
  if (!Number.isFinite(bounds.minX + bounds.maxX + bounds.minY + bounds.maxY)) return cam;
  if (isBoundsVisible(bounds, cam, viewport)) return cam;
  const s = worldToScreenAABB(bounds, cam);
  /** One axis: 0 while it overlaps the view; else the shift that brings it in. */
  const axis = (lo: number, hi: number, size: number): number => {
    const pad = Math.min(paddingPx, size / 4);
    const fits = hi - lo <= size - pad * 2;
    if (hi < 0) return pad - lo; // before the view: its start lands at the padding
    if (lo > size) return fits ? size - pad - hi : pad - lo; // after: its end lands at the padding, unless too big
    return 0;
  };
  const dx = axis(s.minX, s.maxX, viewport.width);
  const dy = axis(s.minY, s.maxY, viewport.height);
  if (dx === 0 && dy === 0) return cam;
  return { scale: cam.scale, tx: cam.tx + dx, ty: cam.ty + dy };
}
