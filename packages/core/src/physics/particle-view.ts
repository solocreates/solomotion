import type { EmitterSpec } from "../schema";
import type { FieldAt } from "./fields";
import { PARTICLE_STRIDE, type SimParticles } from "./solver";

/**
 * HOW A PLANE OF PARTICLES IS SEEN (v107) — a flat simulation looked at from
 * an angle, with its light bent by the gravity wells in it.
 *
 * The simulation stays planar (ADR-physics: one 2D solver). A disk orbits in
 * its plane; this only says where each particle's light lands on the screen:
 *
 *  - TILT: the plane leans away about the horizontal line through the
 *    emitter's origin. Up the screen is the far side. Screen y shrinks by
 *    cos(tilt), and a particle is `−y · sin(tilt)` BEHIND the origin.
 *  - LENSING: light from behind a well bends round it. A point lens at the
 *    well, a source `z` behind it, a distant camera: the Einstein radius is
 *    √(2·Rs·z), the horizon being Rs. Each source then has TWO images, one
 *    pushed out from the well, one flipped to the far side of it, dimmer by its
 *    magnification. That is the whole black-hole picture: the far side of a
 *    disk is lifted over the top of the shadow, its second image hangs under
 *    it, the rings join where the disk is level with the hole (no lens there,
 *    z = 0) and the near side crosses in front untouched. Nothing is cropped,
 *    so there is no seam to hide.
 *  - SHADOW: light that passes inside 2.6 Rs is captured (the photon sphere's
 *    reach, 3√3⁄2 Rs). A far particle whose image lands there is not drawn.
 *  - BEAMING: gas coming toward the camera is brighter and bluer, gas going
 *    away dimmer and redder — the lopsided disk every real image shows, by the
 *    real Doppler factor cubed (at full beaming `hot` is 0.45 c, which puts the
 *    two sides of an inner disk ~5× apart, as in the M87 image).
 *
 * Look-only: none of it changes the run, so the sim's key ignores these
 * fields and keying them never re-simulates.
 */

export type ParticleViewSpec = Pick<EmitterSpec, "tilt" | "lensing" | "beaming" | "hot">;

/** True when an emitter's particles are drawn other than where they are. */
export function viewsParticles(spec: Pick<EmitterSpec, "tilt" | "lensing" | "beaming">): boolean {
  return spec.tilt > 0 || spec.lensing > 0 || spec.beaming > 0;
}

/** The innermost stable circular orbit over the horizon (6 GM/c² = 3 Rs). */
export const ISCO_OVER_HORIZON = 3;

/** The photon sphere's capture radius over the horizon. */
export const SHADOW_OVER_HORIZON = (3 * Math.sqrt(3)) / 2;

/** Particles as seen: the same rows (images in place of positions), and per row how bright and how hot it reads. */
export interface ViewedParticles extends SimParticles {
  /** × its alpha: magnification and beaming. */
  gain: Float32Array;
  /** × where it sits on its colour ramp: beaming's blue/red shift. */
  heat: Float32Array;
  /** Its true speed in the plane — a row's velocity is its IMAGE's (the streak), which a tilt and a lens distort. */
  speed: Float32Array;
  /**
   * Per row its streak as SEEN, TRAIL_STEPS points (x, y) going back from the
   * head over the particle's own last TAIL_S, round its orbit and through the
   * lens — so a streak is the curve the light draws, never a chord across a
   * bend. Where the light went into the shadow the rest repeat the last point.
   */
  trail: Float32Array;
}

/** How fast `hot` is, × light, at full `beaming`: an inner accretion disk's speed. */
const BETA_AT_HOT = 0.45;

/** Seconds of motion a seen streak covers: its curve through the lens. */
export const TAIL_S = 0.1;
/** Points a seen streak is drawn through: short chords, so even a streak swinging round the ring stays on its arc. */
export const TRAIL_STEPS = 5;

/**
 * Every particle of `set` as seen through `view`, about `origin` (the
 * emitter's, comp units). `wells` are the comp's force fields at the instant;
 * only gravity with a horizon bends light. Rows keep `PARTICLE_STRIDE`; a
 * lensed particle may appear twice.
 */
export function viewParticles(set: SimParticles, view: ParticleViewSpec, origin: readonly [number, number], wells: readonly FieldAt[]): ViewedParticles {
  const tilt = (Math.max(0, Math.min(89, view.tilt)) * Math.PI) / 180;
  const cos = Math.cos(tilt), sin = Math.sin(tilt);
  const [ox, oy] = origin;
  const lensing = Math.max(0, Math.min(1, view.lensing));
  // The well that bends: the heaviest one with a horizon. Its own place on the plane is projected too.
  let well: { x: number; y: number; z: number; rs: number } | null = null;
  // What the gas orbits, on the plane: a streak follows that curve, not a chord.
  let hub: { x: number; y: number } | null = null;
  let mass = 0;
  for (const f of wells) {
    const s = f.spec;
    if (s.type !== "gravity" || !s.enabled || s.mass <= mass) continue;
    mass = s.mass;
    hub = { x: f.origin[0], y: f.origin[1] };
    const dy = f.origin[1] - oy;
    well = lensing > 0 && s.horizon > 0 ? { x: f.origin[0], y: oy + dy * cos, z: -dy * sin, rs: s.horizon } : null;
  }
  const S = PARTICLE_STRIDE, d = set.data, n = set.count;
  // Room for every particle twice.
  const out = new Float32Array(n * 2 * S);
  const gain = new Float32Array(n * 2), heat = new Float32Array(n * 2), speed = new Float32Array(n * 2);
  const trail = new Float32Array(n * 2 * TRAIL_STEPS * 2);
  const past = new Float64Array(TRAIL_STEPS * 6);
  const beam = Math.max(0, Math.min(1, view.beaming)), hot = Math.max(1, view.hot);
  const shadow = well ? well.rs * (1 + (SHADOW_OVER_HORIZON - 1) * lensing) : 0;
  const twoRs = well ? 2 * well.rs * lensing : 0;
  // A point's images: [x, y, magnification] for the primary, then the secondary (magnification 0 = none).
  const img = new Float64Array(6);
  const see = (px: number, py: number): void => {
    const dy = py - oy;
    const sx = px, sy = oy + dy * cos, z = -dy * sin;
    img[0] = sx;
    img[1] = sy;
    img[2] = 1;
    img[5] = 0;
    // No lens, or in front of the hole: seen where it is, over the shadow.
    const depth = well ? z - well.z : 0;
    if (!well || depth <= 0 || twoRs <= 0) return;
    const bx = sx - well.x, by = sy - well.y, b = Math.hypot(bx, by);
    const re2 = twoRs * depth;
    const root = Math.sqrt(b * b + 4 * re2);
    const ux = b > 1e-6 ? bx / b : 0, uy = b > 1e-6 ? by / b : -1;
    const plus = (b + root) / 2, minus = (root - b) / 2;
    // Point-lens magnifications, u = b/θE: (u² + 2) / (2u√(u² + 4)) ± ½.
    const u = b / Math.sqrt(re2);
    const core = u > 1e-4 ? (u * u + 2) / (2 * u * Math.sqrt(u * u + 4)) : 1e4;
    img[0] = well.x + ux * plus;
    img[1] = well.y + uy * plus;
    img[2] = plus > shadow ? Math.min(4, core + 0.5) : 0;
    if (minus > shadow) {
      img[3] = well.x - ux * minus;
      img[4] = well.y - uy * minus;
      img[5] = Math.min(4, Math.max(0, core - 0.5));
    }
  };
  let k = 0;
  for (let q = 0; q < n; q++) {
    const o = q * S;
    const x = d[o + 1]!, y = d[o + 2]!, vx = d[o + 3]!, vy = d[o + 4]!;
    // Toward the camera is down the plane (z falls as y rises), so its speed that way is vy·sin — against `hot`, the disk's light speed.
    // The real Doppler factor D = √(1 − β²) / (1 − β·n̂), with `hot` moving at
    // BETA_AT_HOT × light × `beaming` — the speed of a disk's inner edge.
    // Brightness goes as D³: a few times brighter toward you, not a blackout away.
    let shift = 1;
    if (beam > 0) {
      const c = hot / (BETA_AT_HOT * beam);
      const b = Math.min(0.9, Math.hypot(vx, vy) / c), bn = Math.max(-b, Math.min(b, (vy * sin) / c));
      shift = Math.sqrt(1 - b * b) / (1 - bn);
    }
    const beamGain = shift * shift * shift;
    // Inside the innermost stable orbit (3 Rs) nothing circles: gas plunges, thin and fast, and gives almost no light.
    let plunge = 1;
    if (well && hub) {
      const r = Math.hypot(x - hub.x, y - hub.y) / (ISCO_OVER_HORIZON * well.rs);
      if (r < 1) plunge = r * r * r * r;
    }
    // Where it was TAIL_S and TAIL_S/2 ago: back round its orbit about the hub (ω = r×v / r²), else back along v.
    const back = (t: number): [number, number] => {
      if (!hub) return [x - vx * t, y - vy * t];
      const dx = x - hub.x, dy = y - hub.y, r2 = dx * dx + dy * dy;
      if (r2 < 1e-6) return [x - vx * t, y - vy * t];
      const a = (-(dx * vy - dy * vx) / r2) * t, c = Math.cos(a), sn = Math.sin(a);
      // Turned back, and moved back along its radial drift.
      const vr = (dx * vx + dy * vy) / Math.sqrt(r2), k2 = 1 - (vr * t) / Math.sqrt(r2);
      return [hub.x + (dx * c - dy * sn) * k2, hub.y + (dx * sn + dy * c) * k2];
    };
    // The streak's light, TRAIL_STEPS points back along its path, each seen through the lens (both images).
    for (let j = 1; j <= TRAIL_STEPS; j++) {
      const [bx, by] = back((TAIL_S * j) / TRAIL_STEPS);
      see(bx, by);
      past.set(img, (j - 1) * 6);
    }
    see(x, y);
    for (let which = 0; which < 2; which++) {
      const mag = which ? img[5]! : img[2]!;
      if (mag <= 0.01) continue;
      const ix = which ? img[3]! : img[0]!, iy = which ? img[4]! : img[1]!;
      // Walk back from the head; stop where its light went into the shadow, onto the other image,
      // or jumped round the ring (passing straight behind the hole) — a streak never bridges the black.
      // Only light from BEHIND the hole can be swallowed on its way; the near side passes in front of it.
      const behind = !!well && -(y - oy) * sin - well.z > 0;
      const step = 3 * Math.hypot(vx, vy) * (TAIL_S / TRAIL_STEPS) * (1 + mag) + 12;
      let lx = ix, ly = iy, going = true;
      for (let j = 0; j < TRAIL_STEPS; j++) {
        if (going) {
          const o6 = j * 6 + (which ? 3 : 0), px = past[o6]!, py = past[o6 + 1]!;
          const lit = past[j * 6 + (which ? 5 : 2)]! > 0;
          const mid = !behind || Math.hypot((px + lx) / 2 - well!.x, (py + ly) / 2 - well!.y) > shadow;
          if (lit && mid && Math.hypot(px - lx, py - ly) <= step) (lx = px), (ly = py);
          else going = false;
        }
        trail[(k * TRAIL_STEPS + j) * 2] = lx;
        trail[(k * TRAIL_STEPS + j) * 2 + 1] = ly;
      }
      const px = lx, py = ly;
      const w = k * S;
      out.set(d.subarray(o, o + S), w);
      out[w + 1] = ix;
      out[w + 2] = iy;
      out[w + 3] = (ix - px) / TAIL_S;
      out[w + 4] = (iy - py) / TAIL_S;
      // Surface brightness is kept by a lens; a point's light is not — but a brighter primary only blows out, so only dimming counts.
      gain[k] = Math.min(1, mag) * Math.min(1.6, beamGain) * plunge;
      heat[k] = shift;
      speed[k] = Math.hypot(vx, vy);
      k++;
    }
  }
  return { layer: set.layer, index: set.index, data: out, count: k, gain, heat, speed, trail };
}
