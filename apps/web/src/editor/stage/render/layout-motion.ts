import type { Vec2 } from "@solomotion/core";

/**
 * LAYOUT MOTION — how members of an auto layout MOVE while you rearrange them.
 *
 * The arrangement itself is never animated data. A reorder is written to the
 * document the moment the target slot changes, and the one layout solver lays
 * the members out — rows, columns, wraps and grids alike, exactly as the drop
 * will. What moves smoothly is only the PICTURE: each member that changed place
 * is drawn offset from its new slot by where it was, and the offset eases to
 * nothing (FLIP). So the motion can never disagree with the result, and every
 * flow mode gets it without knowing it exists.
 *
 * Offsets are in the member's paint space (its container's interior), applied
 * by the renderer to that one layer (`paintLayerNode`), never in an export.
 * The member being carried is HELD at a fixed offset — under the pointer —
 * until it is let go, when it glides into its slot like the rest.
 */

const GLIDE_MS = 220;

interface Glide {
  from: Vec2;
  start: number;
}

const glides = new Map<string, Glide>();
const held = new Map<string, Vec2>();

/** easeOutCubic — quick to leave, soft to land, like a sortable list. */
function ease(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** The offset a member is drawn at right now, or null when it sits in its slot. */
export function layoutNudgeAt(id: string, now = performance.now()): Vec2 | null {
  const h = held.get(id);
  if (h) return h;
  const g = glides.get(id);
  if (!g) return null;
  const t = (now - g.start) / GLIDE_MS;
  if (t >= 1) {
    glides.delete(id);
    return null;
  }
  const k = 1 - ease(t);
  return { x: g.from.x * k, y: g.from.y * k };
}

/**
 * A member's slot just moved by `-delta` (it was at `slot + delta`): start
 * drawing it where it was and glide to where it is. A member already gliding
 * continues from where it is drawn, so rapid reorders never jump.
 */
export function glideFrom(id: string, delta: Vec2, now = performance.now()): void {
  if (Math.abs(delta.x) < 0.01 && Math.abs(delta.y) < 0.01) return;
  const cur = layoutNudgeAt(id, now) ?? { x: 0, y: 0 };
  glides.set(id, { from: { x: cur.x + delta.x, y: cur.y + delta.y }, start: now });
}

/** Draw a carried member at a fixed offset from its slot — under the pointer. */
export function holdAt(id: string, offset: Vec2): void {
  glides.delete(id);
  held.set(id, offset);
}

/** Let a carried member go: it glides from where it was held into its slot. */
export function releaseHold(id: string): void {
  const h = held.get(id);
  held.delete(id);
  if (h) glideFrom(id, h);
}

/** Anything still moving — the stage keeps drawing until this is false. */
export function layoutMotionActive(now = performance.now()): boolean {
  if (held.size > 0) return true;
  for (const [id, g] of glides) {
    if (now - g.start < GLIDE_MS) return true;
    glides.delete(id);
  }
  return false;
}
