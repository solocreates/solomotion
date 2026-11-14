import type { MeshClip, MeshData, MeshPart, ShapeKey } from "../schema";
import { solidPaint } from "../schema/vector";
import { meshDeltaBetween } from "../shape-keys/delta";
import { createMeshClip } from "./ops";
import type { V3 } from "./math";

/**
 * A TALKING HEAD, made in core — a stylised toy head with eyes, lids and a
 * mouth (lips, teeth, tongue, the dark inside) and shape keys for the eight
 * speaking visemes, a loudness `jawOpen` and a blink per eye. The template and
 * the tests get a face that talks with no external asset, through exactly
 * the path an imported avatar takes (keys → face presets → PoseMix).
 *
 * Built like a toy, not a scan: a big round cranium over a small tapered jaw,
 * eyes set low and wide, a button nose — the baby-schema proportions that
 * read as friendly. The mouth is layered ON the face (inside, then tongue,
 * then teeth, then lips, each a little further out along the surface
 * normal), so opening it is moving shells rather than cutting the head, and
 * every key is a smooth analytic change of a few parameters:
 *
 *   w      half width at the corners      top/bottom  how far each lip parts
 *   lift   corner lift (a smile)          pucker      lips forward + rounder
 *   tuck   lower lip under the teeth (F V) tongue     tongue tip up (L)
 *   jaw    the chin drops with the mouth  press       lips flattened (M B P)
 *
 * The base (no key) is the rest viseme X: closed, a hint of a smile.
 * Z up, the face looks down −Y (the front view), 1 unit = 1 cm.
 */

const R = 100;
const MOUTH_Z = -0.42 * R;
/** The mouth's size against the head: big enough to read a viseme across a room. */
const MOUTH_SCALE = 1.3;

interface MouthParams {
  w: number;
  top: number;
  bottom: number;
  lift: number;
  pucker: number;
  tuck: number;
  tongue: number;
  jaw: number;
  press: number;
}

const REST: MouthParams = { w: 11, top: 0.15, bottom: 0.15, lift: 0.7, pucker: 0, tuck: 0, tongue: 0, jaw: 0, press: 0 };

/** Each speaking viseme (and the loudness jaw) as mouth parameters. */
const MOUTH_KEYS: Array<[string, Partial<MouthParams>]> = [
  ["MBP", { w: 10.4, top: 0.02, bottom: 0.02, lift: 0.2, pucker: 0.15, press: 1 }],
  ["S", { w: 13.5, top: 1.1, bottom: 1.1, jaw: 0.5, lift: 1.3 }],
  ["E", { w: 14.5, top: 1.9, bottom: 2.8, jaw: 1.6, lift: 1.7 }],
  ["AI", { w: 12, top: 3.3, bottom: 7.5, jaw: 6, lift: 0.4 }],
  ["O", { w: 7.6, top: 4.2, bottom: 5.4, jaw: 3.6, pucker: 0.55, lift: -0.3 }],
  ["U", { w: 4.9, top: 1.5, bottom: 1.8, jaw: 1, pucker: 1, lift: -0.1 }],
  ["FV", { w: 11.5, top: 1.8, bottom: -0.7, tuck: 1, lift: 0.4 }],
  ["L", { w: 11, top: 2.7, bottom: 5, jaw: 3.6, tongue: 1, lift: 0.5 }],
  ["jawOpen", { w: 10.5, top: 0.9, bottom: 9, jaw: 9, lift: 0 }],
];

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const gauss = (d: V3, c: V3, sigma: number) => {
  const dd = (d[0] - c[0]) ** 2 + (d[1] - c[1]) ** 2 + (d[2] - c[2]) ** 2;
  return Math.exp(-dd / (2 * sigma * sigma));
};
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** The head's surface in direction `d` (unit) from its centre — the one shape everything sits on. */
function headPoint(d: V3): V3 {
  const [x, y, z] = d;
  const below = smooth(0, -1, z);
  // Round cranium, tapered jaw, a slightly flatter back.
  let px = x * 0.93 * (1 - 0.2 * below) * (1 + 0.04 * smooth(0, 1, z));
  let py = y * (y > 0 ? 0.9 : 0.97) * (1 - 0.1 * below);
  let pz = z * (z > 0 ? 1.02 : 0.9);
  // Chin forward a touch, cheeks full, a button nose.
  py -= 0.05 * below * smooth(-0.2, -0.9, y);
  const cheeks = 0.07 * (gauss(d, norm([0.5, -0.75, -0.38]), 0.22) + gauss(d, norm([-0.5, -0.75, -0.38]), 0.22));
  const nose = 0.085 * gauss(d, norm([0, -1, -0.2]), 0.075);
  const bump = 1 + cheeks + nose;
  px *= bump;
  py *= bump;
  pz *= bump;
  return [px * R, py * R, pz * R];
}

/** Front-plane coordinates (x across, z up, cm) → the direction that lands there. */
const frontDir = (x: number, z: number): V3 => norm([x / R, -0.9, z / R]);

/**
 * A point layered `h` cm out from the face, landing at (x, z) cm as seen
 * from the front — solved, so a mouth 11 cm wide IS 11 cm wide on the round
 * face (a plain projection shrinks everything by the curvature).
 */
function onFace(x: number, z: number, h: number): V3 {
  let qx = x, qz = z;
  let p = headPoint(frontDir(qx, qz));
  for (let i = 0; i < 6; i++) {
    qx += x - p[0];
    qz += z - p[2];
    p = headPoint(frontDir(qx, qz));
  }
  const n = norm(p);
  return [p[0] + n[0] * h, p[1] + n[1] * h, p[2] + n[2] * h];
}

class Builder {
  positions: number[] = [];
  faces: number[][] = [];
  faceParts: string[] = [];
  v(p: V3): number {
    this.positions.push(p[0], p[1], p[2]);
    return this.positions.length / 3 - 1;
  }
  f(part: string, ...idx: number[]): void {
    this.faces.push(idx);
    this.faceParts.push(part);
  }
  /** Quads between rows (row-major grid of vertex ids), optionally closed around. */
  grid(part: string, rows: number[][], wrap: boolean, flip = false): void {
    for (let r = 0; r + 1 < rows.length; r++) {
      const a = rows[r]!, b = rows[r + 1]!;
      const n = wrap ? a.length : a.length - 1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % a.length;
        if (flip) this.f(part, a[i]!, b[i]!, b[j]!, a[j]!);
        else this.f(part, a[i]!, a[j]!, b[j]!, b[i]!);
      }
    }
  }
}

/**
 * Every vertex position for one set of mouth params and lid closures. The
 * TOPOLOGY never depends on the params — only positions — which is what lets
 * each key be a delta of the same mesh.
 */
function buildHead(m: MouthParams, blinkL: number, blinkR: number, eyes = true): MeshData & { faceParts: string[] } {
  const b = new Builder();

  // ── The head: a lathe of directions, poles on Z ────────────────────────────
  const SEG = 48, RINGS = 36;
  const ringIds: number[][] = [];
  const top = b.v(headPoint([0, 0, 1]));
  for (let r = 1; r < RINGS; r++) {
    const phi = (r / RINGS) * Math.PI;
    const ring: number[] = [];
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2 - Math.PI / 2;
      const d: V3 = [Math.sin(phi) * Math.cos(a), Math.sin(phi) * Math.sin(a), Math.cos(phi)];
      const p = headPoint(d);
      // The jaw: skin below the mouth, at the front, swings down with it —
      // turned about the head's centre, so it slides ALONG the face and never
      // rises through the mouth layered on it.
      const wj = smooth(MOUTH_Z + 1, MOUTH_Z - 14, p[2]) * smooth(-0.2 * R, -0.6 * R, p[1]) * (1 - smooth(0.3 * R, 0.55 * R, Math.abs(p[0])));
      const th = ((m.jaw * MOUTH_SCALE) / (0.9 * R)) * wj;
      ring.push(b.v([p[0], p[1] * Math.cos(th) - p[2] * Math.sin(th), p[1] * Math.sin(th) + p[2] * Math.cos(th)]));
    }
    ringIds.push(ring);
  }
  const bottom = b.v(headPoint([0, 0, -1]));
  for (let s = 0; s < SEG; s++) {
    const s1 = (s + 1) % SEG;
    b.f("", top, ringIds[0]![s]!, ringIds[0]![s1]!);
    b.f("", bottom, ringIds[RINGS - 2]![s1]!, ringIds[RINGS - 2]![s]!);
  }
  b.grid("", ringIds, true, true);

  // ── The mouth: inside, tongue, teeth, lips — layered outward ───────────────
  const N = 32;
  const q: MouthParams = { ...m, w: m.w * MOUTH_SCALE, top: m.top * MOUTH_SCALE, bottom: m.bottom * MOUTH_SCALE, lift: m.lift * MOUTH_SCALE };
  const lipU = 4.4 * MOUTH_SCALE * (1 - 0.25 * q.press), lipL = 5.2 * MOUTH_SCALE * (1 - 0.25 * q.press);
  const outline = (th: number): [number, number] => {
    const c = Math.cos(th), s = Math.sin(th);
    const open = s >= 0 ? q.top : q.bottom;
    return [q.w * c, MOUTH_Z + open * s + q.lift * c * c];
  };
  const thetas = Array.from({ length: N }, (_, i) => (i / N) * Math.PI * 2);
  const inner = thetas.map(outline);
  const centre: [number, number] = [0, MOUTH_Z + (q.top - q.bottom) / 2];

  // The dark inside: rings squashed toward the mouth's mid-line (not toward a
  // centre point — a smiling mouth is a crescent, and a fan from its centre
  // folds over), the middle one polygon.
  const midZ = (x: number) => centre[1] + q.lift * (x / q.w) ** 2;
  const insideRings: number[][] = [];
  for (let k = 1; k <= 3; k++) {
    const f = k / 3;
    insideRings.push(inner.map(([x, z]) => b.v(onFace(x, midZ(x) + (z - midZ(x)) * f, 0.6))));
  }
  b.f("mouth", ...insideRings[0]!);
  b.grid("mouth", insideRings, true, true);

  // The tongue, lying low — or its tip up behind the teeth for L.
  const tw = Math.max(1.5, 0.5 * q.w);
  const tLow = MOUTH_Z - q.bottom * 0.6;
  const tCentreZ = tLow + q.tongue * (q.top * 0.9 + q.bottom * 0.45);
  const tH = Math.max(0.6, 0.32 * (q.bottom + q.top)) * (1 + 0.4 * q.tongue);
  const tongueRings: number[][] = [];
  const TN = 16;
  for (let k = 1; k <= 3; k++) {
    const f = k / 3;
    tongueRings.push(Array.from({ length: TN }, (_, i) => {
      const a = (i / TN) * Math.PI * 2;
      return b.v(onFace(Math.cos(a) * tw * f, tCentreZ + Math.sin(a) * tH * f, 0.9 + 0.25 * (1 - f)));
    }));
  }
  const tc = b.v(onFace(0, tCentreZ, 1.15));
  for (let i = 0; i < TN; i++) b.f("tongue", tc, tongueRings[0]![i]!, tongueRings[0]![(i + 1) % TN]!);
  b.grid("tongue", tongueRings, true, true);

  // Upper teeth: fixed to the skull, hidden behind the upper lip at rest.
  const teeth: number[][] = [];
  const W0 = REST.w * MOUTH_SCALE * 0.62;
  for (const tz of [2.2 * MOUTH_SCALE, 1.2 * MOUTH_SCALE, 0.4]) {
    teeth.push(Array.from({ length: 11 }, (_, i) => {
      const x = -W0 + (2 * W0 * i) / 10;
      return b.v(onFace(x, MOUTH_Z + tz + 0.5 * (x / W0) ** 2, 1.4));
    }));
  }
  b.grid("teeth", teeth, false, true);

  // Lips: a ring from the inner edge out to the skin, puffed in the middle.
  const J = 4;
  const lipRows: number[][] = [];
  for (let j = 0; j <= J; j++) {
    const f = j / J;
    lipRows.push(thetas.map((th, i) => {
      const s = Math.sin(th), c = Math.cos(th);
      const lower = s < 0;
      const corner = 0.3 + 0.7 * Math.abs(s) ** 0.7;
      const L = (lower ? lipL : lipU) * corner * (1 - 0.25 * q.pucker);
      const dir = norm([c, 0, s * 1.6]);
      const [x0, z0] = inner[i]!;
      const x = x0 + dir[0] * L * f;
      const z = z0 + dir[2] * L * f;
      const puff = (1 + 1.3 * q.pucker) * (1 - 0.35 * q.press) * (lower ? 1 - 0.75 * q.tuck : 1);
      const hIn = (lower ? 1 - 0.75 * q.tuck : 1) * 1.7 * (1 + 0.6 * q.pucker);
      const h = hIn * (1 - f) + 2.6 * puff * 4 * f * (1 - f);
      return b.v(onFace(x, z, h));
    }));
  }
  b.grid("lips", lipRows, true, true);

  // ── Eyes: eyeball, a catchlight, and two lids that close over it ───────────
  for (const side of eyes ? ([-1, 1] as const) : []) {
    const blink = side < 0 ? blinkR : blinkL; // the character's left is +X
    const ex = 33 * side, ez = -6;
    const surface = onFace(ex, ez, 0);
    const re = 15;
    const centreP: V3 = [surface[0], surface[1] + re * 0.42, surface[2]];
    const f: V3 = [0, -1, 0], r: V3 = [1, 0, 0], u: V3 = [0, 0, 1];
    const at = (dir: V3, rad: number): V3 => [centreP[0] + dir[0] * rad, centreP[1] + dir[1] * rad, centreP[2] + dir[2] * rad];
    // Eyeball: a lathe around its forward axis, iris at the front pole.
    const ES = 24, ER = 14;
    const front = b.v(at(f, re));
    const rings: number[][] = [];
    for (let k = 1; k < ER; k++) {
      const al = (k / ER) * Math.PI;
      rings.push(Array.from({ length: ES }, (_, i) => {
        const a = (i / ES) * Math.PI * 2;
        const d: V3 = [
          f[0] * Math.cos(al) + (r[0] * Math.cos(a) + u[0] * Math.sin(a)) * Math.sin(al),
          f[1] * Math.cos(al) + (r[1] * Math.cos(a) + u[1] * Math.sin(a)) * Math.sin(al),
          f[2] * Math.cos(al) + (r[2] * Math.cos(a) + u[2] * Math.sin(a)) * Math.sin(al),
        ];
        return b.v(at(d, re));
      }));
    }
    const back = b.v(at([-f[0], -f[1], -f[2]], re));
    const partOfRing = (k: number) => (k < 3 ? "iris" : "eye");
    for (let i = 0; i < ES; i++) b.f("iris", front, rings[0]![i]!, rings[0]![(i + 1) % ES]!);
    for (let k = 0; k + 1 < rings.length; k++) {
      const A = rings[k]!, B = rings[k + 1]!;
      for (let i = 0; i < ES; i++) {
        const j = (i + 1) % ES;
        b.f(partOfRing(k), A[i]!, B[i]!, B[j]!, A[j]!);
      }
    }
    for (let i = 0; i < ES; i++) b.f("eye", back, rings[ER - 2]![(i + 1) % ES]!, rings[ER - 2]![i]!);
    // Catchlight: a small disc up and toward the nose.
    const cl = norm([f[0] - 0.32 * side, f[1], f[2] + 0.42]);
    const ct = [1, 0, 0] as V3;
    const cu = norm([cl[1] * ct[2] - cl[2] * ct[1], cl[2] * ct[0] - cl[0] * ct[2], cl[0] * ct[1] - cl[1] * ct[0]]);
    const cc = b.v(at(cl, re * 1.02));
    const ring: number[] = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const o: V3 = [ct[0] * Math.cos(a) + cu[0] * Math.sin(a), ct[1] * Math.cos(a) + cu[1] * Math.sin(a), ct[2] * Math.cos(a) + cu[2] * Math.sin(a)];
      ring.push(b.v(at(norm([cl[0] + o[0] * 0.17, cl[1] + o[1] * 0.17, cl[2] + o[2] * 0.17]), re * 1.02)));
    }
    for (let i = 0; i < 10; i++) b.f("shine", cc, ring[i]!, ring[(i + 1) % 10]!);
    // Lids: bands of a sphere turned about the eye's horizontal axis. The
    // upper lid's edge sweeps from +24° (open, a gentle hood) to −24°;
    // the lower rises from −40° to −22°, tucked under the upper.
    const lid = (rad: number, from: number, to: number, rows: number, flip: boolean) => {
      const out: number[][] = [];
      for (let k = 0; k <= rows; k++) {
        const phi = ((from + ((to - from) * k) / rows) * Math.PI) / 180;
        out.push(Array.from({ length: 15 }, (_, i) => {
          const a = ((-80 + (160 * i) / 14) * Math.PI) / 180;
          const d: V3 = [
            r[0] * Math.sin(a) + Math.cos(a) * (f[0] * Math.cos(phi) + u[0] * Math.sin(phi)),
            r[1] * Math.sin(a) + Math.cos(a) * (f[1] * Math.cos(phi) + u[1] * Math.sin(phi)),
            r[2] * Math.sin(a) + Math.cos(a) * (f[2] * Math.cos(phi) + u[2] * Math.sin(phi)),
          ];
          return b.v(at(d, rad));
        }));
      }
      b.grid("", out, false, flip);
    };
    lid(re * 1.14, 24 - 48 * blink, 115, 6, false);
    lid(re * 1.1, -40 + 18 * blink, -115, 4, true);
  }
  return { positions: b.positions, faces: b.faces, faceParts: b.faceParts };
}

export const TALKING_HEAD_PARTS: MeshPart[] = [
  { id: "lips", name: "Lips", fills: [solidPaint("#d86f6c")], material: { roughness: 0.4 } },
  { id: "mouth", name: "Mouth", fills: [solidPaint("#3b1520")], material: { roughness: 0.8 } },
  { id: "tongue", name: "Tongue", fills: [solidPaint("#e2747c")], material: { roughness: 0.45 } },
  { id: "teeth", name: "Teeth", fills: [solidPaint("#fbf6ee")], material: { roughness: 0.25 } },
  { id: "eye", name: "Eyes", fills: [solidPaint("#fbfaf6")], material: { roughness: 0.12, clearcoat: 1 } },
  { id: "iris", name: "Iris", fills: [solidPaint("#2a2034")], material: { roughness: 0.08, clearcoat: 1 } },
  { id: "shine", name: "Catchlight", fills: [solidPaint("#ffffff")], material: { emission: "#ffffff", emissionStrength: 1.5, roughness: 0 } },
];

export const TALKING_HEAD_SKIN = "#f3b896";

/** The head mesh and its keys (deterministic: same call, same numbers). */
export function buildTalkingHead(opts: { eyes?: boolean } = {}): { mesh: MeshData; keys: ShapeKey[] } {
  const eyes = opts.eyes !== false;
  const base = buildHead(REST, 0, 0, eyes);
  const keys: ShapeKey[] = MOUTH_KEYS.map(([name, p]) => ({
    id: name,
    name,
    source: { kind: "delta" as const, delta: meshDeltaBetween(base.positions, buildHead({ ...REST, ...p }, 0, 0, eyes).positions) },
  }));
  if (eyes)
    keys.push(
      { id: "eyeBlink_L", name: "eyeBlink_L", source: { kind: "delta", delta: meshDeltaBetween(base.positions, buildHead(REST, 1, 0).positions) } },
      { id: "eyeBlink_R", name: "eyeBlink_R", source: { kind: "delta", delta: meshDeltaBetween(base.positions, buildHead(REST, 0, 1).positions) } },
    );
  return { mesh: base, keys };
}

/**
 * Where the talking head's EYES sit — its object space, Z up, facing −Y: each
 * eyeball's centre and radius. What a head built without eyes (`eyes: false`)
 * hands to external organs: eyeballs, irises and lids as meshes of their own
 * (ADR-characters-3, "3D organs").
 */
export function talkingHeadEyes(): Array<{ side: "L" | "R"; centre: V3; radius: number }> {
  return ([1, -1] as const).map((side) => {
    const surface = onFace(33 * side, -6, 0);
    const re = 15;
    return { side: side > 0 ? ("L" as const) : ("R" as const), centre: [surface[0], surface[1] + re * 0.42, surface[2]] as V3, radius: re };
  });
}

let cached: { mesh: MeshData; keys: ShapeKey[] } | null = null;
let cachedNoEyes: { mesh: MeshData; keys: ShapeKey[] } | null = null;

/** A talking head as a mesh clip: skin fill, mouth and eye parts, smooth shading, shape keys. */
export function createTalkingHeadClip(input: { frameId: string; startMs: number; durationMs: number; position?: V3; rotation?: V3; name?: string; eyes?: boolean }): MeshClip {
  const built = input.eyes === false ? (cachedNoEyes ??= buildTalkingHead({ eyes: false })) : (cached ??= buildTalkingHead());
  const { eyes: _eyes, ...rest } = input;
  const clip = createMeshClip({
    ...rest,
    name: input.name ?? "Talking head",
    mesh: structuredClone(built.mesh),
    color: TALKING_HEAD_SKIN,
    material: { roughness: 0.55, sheen: 0.35, doubleSided: true },
  });
  clip.parts = structuredClone(TALKING_HEAD_PARTS);
  clip.shading = "smooth";
  clip.shapeKeys = structuredClone(built.keys);
  return clip;
}
