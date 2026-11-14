import type { Contour, CornerRadius, PathPoint, ShapeKind, Subpath } from "../schema/vector";
import { mirrorTangent } from "../tangents";
import { lendIdentity, nodeKey } from "./contour-id";
import type { ShapeKey } from "../schema/shape-keys";
import { morphSubpaths } from "../shape-keys/mix";

/**
 * Vector geometry — pure, renderer-agnostic. Shapes and paths compile to a
 * flat command list (M/L/C/Z); the web renderer turns that into a Path2D, a
 * native adapter could turn it into Skia calls, and hit-testing/bounds run on
 * the same numbers. One geometry, every consumer.
 */

export type PathCommand =
  | { type: "M"; x: number; y: number }
  | { type: "L"; x: number; y: number }
  | { type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: "Z" };

/** Cubic-arc circle constant. */
const KAPPA = 0.5522847498307936;

export interface ShapeGeometryInput {
  shape: ShapeKind;
  width: number;
  height: number;
  cornerRadius: CornerRadius;
  radius: number;
  pointCount: number;
  innerRatio: number;
  /** Ellipse arc — omitted fields fall back to a full solid ellipse. */
  arcStartDeg?: number;
  arcSweepDeg?: number;
  arcRatio?: number;
  /** Per-corner nudges (rect/polygon/star); omitted/null = pure parametric. */
  cornerOffsets?: Array<{ x: number; y: number }> | null;
}

/**
 * Compile a parametric shape to commands in a centered local space:
 * x ∈ [-w/2, w/2], y ∈ [-h/2, h/2] — matching how every visual clip is
 * anchored at its transform.
 */
export function shapeCommands(s: ShapeGeometryInput): PathCommand[] {
  switch (s.shape) {
    case "rect":
      // With free corner offsets a rect is a rounded quad (per-corner radius);
      // without them the fast, Figma-clamped rounded rect.
      return hasCornerOffsets(s)
        ? roundedPolygonCommands(shapeCornerPoints(s), [
            s.cornerRadius.tl,
            s.cornerRadius.tr,
            s.cornerRadius.br,
            s.cornerRadius.bl,
          ])
        : roundedRectCommands(s.width, s.height, s.cornerRadius);
    case "ellipse":
      return ellipseCommands(
        s.width,
        s.height,
        s.arcStartDeg ?? 0,
        s.arcSweepDeg ?? 360,
        s.arcRatio ?? 0,
      );
    case "polygon":
    case "star":
      return roundedPolygonCommands(shapeCornerPoints(s), s.radius);
  }
}

function hasCornerOffsets(s: ShapeGeometryInput): boolean {
  return !!s.cornerOffsets && s.cornerOffsets.some((o) => o.x !== 0 || o.y !== 0);
}

/**
 * The uniform corner radius (pull-back distance) at which a shape is MAXIMALLY
 * rounded — every corner's tangent points reach an edge midpoint. For a regular
 * polygon this collapses it to its incircle (Figma's "max corner radius =
 * circle"); for a rect it's the classic half-min-side. Since the radius is a
 * pull-back, the cap is just the shortest half-edge across the corners. THE cap
 * the radius handle + drag clamp read, so dragging a triangle/pentagon/… to the
 * end lands exactly on a circle.
 */
export function maxCornerRadiusForShape(s: ShapeGeometryInput): number {
  if (s.shape === "ellipse") return 0;
  if (s.shape === "rect" && !hasCornerOffsets(s)) return Math.min(s.width, s.height) / 2;
  const verts = shapeCornerPoints(s);
  const n = verts.length;
  if (n < 3) return 0;
  let max = Infinity;
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n]!;
    const v = verts[i]!;
    const next = verts[(i + 1) % n]!;
    const inLen = Math.hypot(v.x - prev.x, v.y - prev.y);
    const outLen = Math.hypot(next.x - v.x, next.y - v.y);
    if (inLen < 1e-6 || outLen < 1e-6) continue;
    const half = Math.min(inLen, outLen) / 2;
    if (half < max) max = half;
  }
  return Number.isFinite(max) ? max : 0;
}

/**
 * The natural (pre-offset) corner control points a shape can be edited by, in
 * the order `cornerOffsets` maps to: rect = tl,tr,br,bl · polygon = n verts ·
 * star = 2n verts · ellipse = none. Local centered space.
 */
export function shapeCornerBasis(s: ShapeGeometryInput): Array<{ x: number; y: number }> {
  if (s.shape === "ellipse") return [];
  if (s.shape === "rect") {
    const x = s.width / 2;
    const y = s.height / 2;
    return [
      { x: -x, y: -y },
      { x, y: -y },
      { x, y },
      { x: -x, y },
    ];
  }
  return shapeVertices(s);
}

/** The final corner points = natural basis + per-corner offsets (the editor + geometry share this). */
export function shapeCornerPoints(s: ShapeGeometryInput): Array<{ x: number; y: number }> {
  const basis = shapeCornerBasis(s);
  const off = s.cornerOffsets;
  if (!off) return basis;
  return basis.map((p, i) => (off[i] ? { x: p.x + off[i]!.x, y: p.y + off[i]!.y } : p));
}

/**
 * Local (centered) bounds a shape actually occupies — its w×h frame, grown to
 * include any pushed-out corner. So the selection box hugs the frame at rest but
 * REACTS the moment a corner is dragged past it. Ellipse = its frame.
 */
export function shapeLocalBounds(s: ShapeGeometryInput): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const rx = s.width / 2;
  const ry = s.height / 2;
  const b = { minX: -rx, minY: -ry, maxX: rx, maxY: ry };
  if (s.shape === "ellipse") return b;
  for (const p of shapeCornerPoints(s)) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y > b.maxY) b.maxY = p.y;
  }
  return b;
}

/**
 * The raw vertices of a polygon/star inscribed in the shape's box (before
 * corner rounding) — the editor also uses these to place radius handles.
 */
export function shapeVertices(s: ShapeGeometryInput): Array<{ x: number; y: number }> {
  const n = Math.max(3, Math.round(s.pointCount));
  const rx = s.width / 2;
  const ry = s.height / 2;
  const out: Array<{ x: number; y: number }> = [];
  if (s.shape === "star") {
    const inner = Math.max(0.01, Math.min(1, s.innerRatio));
    for (let i = 0; i < n * 2; i++) {
      const angle = -Math.PI / 2 + (i * Math.PI) / n;
      const k = i % 2 === 0 ? 1 : inner;
      out.push({ x: Math.cos(angle) * rx * k, y: Math.sin(angle) * ry * k });
    }
  } else {
    for (let i = 0; i < n; i++) {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      out.push({ x: Math.cos(angle) * rx, y: Math.sin(angle) * ry });
    }
  }
  return out;
}

function roundedRectCommands(w: number, h: number, r: CornerRadius): PathCommand[] {
  const x = -w / 2;
  const y = -h / 2;
  // Clamp Figma-style: shrink all radii by one factor so no edge overflows.
  let k = 1;
  const pairs: Array<[number, number, number]> = [
    [r.tl, r.tr, w],
    [r.tr, r.br, h],
    [r.br, r.bl, w],
    [r.bl, r.tl, h],
  ];
  for (const [a, b, edge] of pairs) {
    if (a + b > edge) k = Math.min(k, edge / (a + b));
  }
  const tl = r.tl * k;
  const tr = r.tr * k;
  const br = r.br * k;
  const bl = r.bl * k;
  if (tl <= 0 && tr <= 0 && br <= 0 && bl <= 0) {
    return [
      { type: "M", x, y },
      { type: "L", x: x + w, y },
      { type: "L", x: x + w, y: y + h },
      { type: "L", x, y: y + h },
      { type: "Z" },
    ];
  }
  const cmds: PathCommand[] = [{ type: "M", x: x + tl, y }];
  cmds.push({ type: "L", x: x + w - tr, y });
  if (tr > 0) {
    cmds.push({ type: "C", x1: x + w - tr + tr * KAPPA, y1: y, x2: x + w, y2: y + tr - tr * KAPPA, x: x + w, y: y + tr });
  }
  cmds.push({ type: "L", x: x + w, y: y + h - br });
  if (br > 0) {
    cmds.push({ type: "C", x1: x + w, y1: y + h - br + br * KAPPA, x2: x + w - br + br * KAPPA, y2: y + h, x: x + w - br, y: y + h });
  }
  cmds.push({ type: "L", x: x + bl, y: y + h });
  if (bl > 0) {
    cmds.push({ type: "C", x1: x + bl - bl * KAPPA, y1: y + h, x2: x, y2: y + h - bl + bl * KAPPA, x, y: y + h - bl });
  }
  cmds.push({ type: "L", x, y: y + tl });
  if (tl > 0) {
    cmds.push({ type: "C", x1: x, y1: y + tl - tl * KAPPA, x2: x + tl - tl * KAPPA, y2: y, x: x + tl, y });
  }
  cmds.push({ type: "Z" });
  return cmds;
}

/**
 * A closed full ellipse as four cubics. `reverse` winds the other way — used
 * for a donut's inner ring so a nonzero fill punches the hole.
 */
function fullEllipseCommands(rx: number, ry: number, reverse = false): PathCommand[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  if (!reverse) {
    return [
      { type: "M", x: 0, y: -ry },
      { type: "C", x1: kx, y1: -ry, x2: rx, y2: -ky, x: rx, y: 0 },
      { type: "C", x1: rx, y1: ky, x2: kx, y2: ry, x: 0, y: ry },
      { type: "C", x1: -kx, y1: ry, x2: -rx, y2: ky, x: -rx, y: 0 },
      { type: "C", x1: -rx, y1: -ky, x2: -kx, y2: -ry, x: 0, y: -ry },
      { type: "Z" },
    ];
  }
  return [
    { type: "M", x: 0, y: -ry },
    { type: "C", x1: -kx, y1: -ry, x2: -rx, y2: -ky, x: -rx, y: 0 },
    { type: "C", x1: -rx, y1: ky, x2: -kx, y2: ry, x: 0, y: ry },
    { type: "C", x1: kx, y1: ry, x2: rx, y2: ky, x: rx, y: 0 },
    { type: "C", x1: rx, y1: -ky, x2: kx, y2: -ry, x: 0, y: -ry },
    { type: "Z" },
  ];
}

/**
 * Append cubic segments tracing the elliptical arc from angle `a0` to `a1`
 * (radians; point (rx·cosθ, ry·sinθ)). The current point must already be at
 * a0. Splits into ≤90° chunks so the Bézier approximation stays tight.
 */
function appendEllipseArc(cmds: PathCommand[], rx: number, ry: number, a0: number, a1: number): void {
  const total = a1 - a0;
  const segs = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2)));
  const step = total / segs;
  const alpha = (4 / 3) * Math.tan(step / 4); // control-arm length (signed with direction)
  let ang = a0;
  for (let i = 0; i < segs; i++) {
    const next = ang + step;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    const cosB = Math.cos(next);
    const sinB = Math.sin(next);
    cmds.push({
      type: "C",
      x1: rx * (cosA - alpha * sinA),
      y1: ry * (sinA + alpha * cosA),
      x2: rx * (cosB + alpha * sinB),
      y2: ry * (sinB - alpha * cosB),
      x: rx * cosB,
      y: ry * sinB,
    });
    ang = next;
  }
}

/**
 * Ellipse, or — when `sweepDeg` < 360 or `ratio` > 0 — a Figma-style pie / arc /
 * donut. Angle 0 is 3 o'clock; sweep goes clockwise (screen y is down). A pie
 * closes to the center; a ratio hollows it into a ring (segment or full donut).
 */
function ellipseCommands(
  w: number,
  h: number,
  startDeg: number,
  sweepDeg: number,
  ratio: number,
): PathCommand[] {
  const rx = w / 2;
  const ry = h / 2;
  const sweep = Math.max(0, Math.min(360, sweepDeg));
  const full = sweep >= 359.999;
  const r = Math.max(0, Math.min(0.999, ratio));

  // Plain solid ellipse — the common case, byte-identical to before.
  if (full && r <= 0.0001) return fullEllipseCommands(rx, ry);

  // Full donut: outer ring + reversed inner ring (nonzero hole).
  if (full) {
    return [...fullEllipseCommands(rx, ry), ...fullEllipseCommands(rx * r, ry * r, true)];
  }

  const a0 = (startDeg * Math.PI) / 180;
  const a1 = a0 + (sweep * Math.PI) / 180;
  const cmds: PathCommand[] = [{ type: "M", x: rx * Math.cos(a0), y: ry * Math.sin(a0) }];
  appendEllipseArc(cmds, rx, ry, a0, a1);
  if (r <= 0.0001) {
    // Pie slice — straight sides through the center.
    cmds.push({ type: "L", x: 0, y: 0 });
  } else {
    // Ring segment — hop to the inner edge and trace back.
    cmds.push({ type: "L", x: rx * r * Math.cos(a1), y: ry * r * Math.sin(a1) });
    appendEllipseArc(cmds, rx * r, ry * r, a1, a0);
  }
  cmds.push({ type: "Z" });
  return cmds;
}

/**
 * Round a closed polygon's corners: each vertex is replaced by two points
 * pulled back along its edges plus a cubic through the original vertex —
 * the same visual as Figma's polygon/star corner radius. `radius` may be a
 * single value (uniform) or a per-vertex array (rect's per-corner radius).
 */
function roundedPolygonCommands(
  verts: Array<{ x: number; y: number }>,
  radius: number | number[],
): PathCommand[] {
  const n = verts.length;
  if (n < 3) return [];
  const radiusAt = (i: number) => (typeof radius === "number" ? radius : (radius[i] ?? 0));
  const maxRadius = typeof radius === "number" ? radius : Math.max(0, ...radius);
  if (maxRadius <= 0.01) {
    const cmds: PathCommand[] = [{ type: "M", x: verts[0]!.x, y: verts[0]!.y }];
    for (let i = 1; i < n; i++) cmds.push({ type: "L", x: verts[i]!.x, y: verts[i]!.y });
    cmds.push({ type: "Z" });
    return cmds;
  }
  // Each corner is a TRUE circular arc tangent to both edges — not a quadratic
  // through the vertex. `radius` is the pull-back distance (how far the tangent
  // points sit back from the corner, matching the handle dot + drag). The arc's
  // centre is where the two edge normals meet, and it is emitted as ≤90° cubic
  // segments (arcCubics) so even a wide 120° triangle corner stays truly round.
  // When every pull-back reaches its edge midpoint on a regular polygon the
  // straight edges vanish and the arcs collapse to the incircle — a PERFECT
  // circle, exactly like Figma. The normal-intersection centre needs no interior
  // angle, so convex and reflex (star) corners round with one uniform path.
  const corners = verts.map((v, i) => {
    const prev = verts[(i - 1 + n) % n]!;
    const next = verts[(i + 1) % n]!;
    const inX = v.x - prev.x;
    const inY = v.y - prev.y;
    const outX = next.x - v.x;
    const outY = next.y - v.y;
    const inLen = Math.hypot(inX, inY) || 1;
    const outLen = Math.hypot(outX, outY) || 1;
    const inDir = { x: inX / inLen, y: inY / inLen };
    const outDir = { x: outX / outLen, y: outY / outLen };
    const t = Math.min(radiusAt(i), inLen / 2, outLen / 2);
    const aIn = { x: v.x - inDir.x * t, y: v.y - inDir.y * t };
    const aOut = { x: v.x + outDir.x * t, y: v.y + outDir.y * t };
    // Centre = intersection of the edge-perpendiculars through the tangent points.
    const det = inDir.x * outDir.y - inDir.y * outDir.x;
    if (t <= 1e-6 || Math.abs(det) < 1e-9) return { aIn: v, aOut: v, center: null as Vec2 | null };
    const b1 = inDir.x * aIn.x + inDir.y * aIn.y;
    const b2 = outDir.x * aOut.x + outDir.y * aOut.y;
    const center = { x: (b1 * outDir.y - b2 * inDir.y) / det, y: (inDir.x * b2 - outDir.x * b1) / det };
    return { aIn, aOut, center };
  });
  const cmds: PathCommand[] = [{ type: "M", x: corners[0]!.aIn.x, y: corners[0]!.aIn.y }];
  for (let i = 0; i < n; i++) {
    const c = corners[i]!;
    if (c.center) for (const seg of arcCubics(c.center, c.aIn, c.aOut)) cmds.push(seg);
    // Straight edge to the next corner's pull-back start (the closing edge back
    // to corners[0].aIn is drawn here too; Z then adds no length).
    const next = corners[(i + 1) % n]!;
    cmds.push({ type: "L", x: next.aIn.x, y: next.aIn.y });
  }
  cmds.push({ type: "Z" });
  return cmds;
}

/**
 * A minor circular arc from `a0` to `a1` about `center`, as ≤90° cubic segments
 * (each the exact 4/3·tan(θ/4) Bézier). Splitting keeps the approximation tight
 * for wide corners (a triangle's 120° turn) so a maxed regular polygon is a true
 * circle, not a bulging blob.
 */
function arcCubics(center: Vec2, a0pt: Vec2, a1pt: Vec2): PathCommand[] {
  const r = Math.hypot(a0pt.x - center.x, a0pt.y - center.y);
  const start = Math.atan2(a0pt.y - center.y, a0pt.x - center.x);
  let sweep = Math.atan2(a1pt.y - center.y, a1pt.x - center.x) - start;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / segs;
  const k = (4 / 3) * Math.tan(step / 4); // signed control handle length (÷ r)
  const out: PathCommand[] = [];
  for (let i = 0; i < segs; i++) {
    const t0 = start + step * i;
    const t1 = start + step * (i + 1);
    const p0 = { x: center.x + r * Math.cos(t0), y: center.y + r * Math.sin(t0) };
    const p1 = { x: center.x + r * Math.cos(t1), y: center.y + r * Math.sin(t1) };
    out.push({
      type: "C",
      x1: p0.x - k * r * Math.sin(t0),
      y1: p0.y + k * r * Math.cos(t0),
      x2: p1.x + k * r * Math.sin(t1),
      y2: p1.y - k * r * Math.cos(t1),
      x: p1.x,
      y: p1.y,
    });
  }
  return out;
}

/** A point in a corner (positions only) — the fillet math never touches handles. */
type Vec2 = { x: number; y: number };

/**
 * A vertex's resolved corner rounding. `aIn`/`aOut` are where the incoming and
 * outgoing segments now END/START (pulled back along their edges); `arc`, when
 * present, is the cubic that rounds `aIn → aOut` through the corner. No rounding
 * ⇒ both collapse to the anchor and `arc` is null (the sharp corner is kept).
 */
interface CornerFillet {
  aIn: Vec2;
  aOut: Vec2;
  arc: { c1: Vec2; c2: Vec2 } | null;
}

/**
 * Resolve ONE vertex's circular corner fillet — the shared, headless brain for
 * Figma-style vector corner radius. Given the anchor `v` between straight edges
 * to `prev` and `next`, it inscribes a circle of radius `r` tangent to both
 * edges: the tangent points are the pull-back distance `r / tan(φ/2)` from the
 * corner (φ = interior angle), clamped to half of each edge so neighbouring
 * rounded corners never overrun. The arc is the exact 4/3·tan(sweep/4) cubic
 * (KAPPA at 90°, matching the rounded-rect), tangent-continuous with both edges.
 */
function resolveCornerFillet(prev: Vec2, v: Vec2, next: Vec2, r: number): CornerFillet {
  const none: CornerFillet = { aIn: { x: v.x, y: v.y }, aOut: { x: v.x, y: v.y }, arc: null };
  if (r <= 0) return none;
  const inX = v.x - prev.x;
  const inY = v.y - prev.y;
  const outX = next.x - v.x;
  const outY = next.y - v.y;
  const inLen = Math.hypot(inX, inY);
  const outLen = Math.hypot(outX, outY);
  if (inLen < 1e-6 || outLen < 1e-6) return none;
  const inDir = { x: inX / inLen, y: inY / inLen }; // prev → v
  const outDir = { x: outX / outLen, y: outY / outLen }; // v → next
  // Interior angle φ between the two edges as they leave v.
  const cosPhi = Math.max(-1, Math.min(1, -inDir.x * outDir.x - inDir.y * outDir.y));
  const phi = Math.acos(cosPhi);
  if (phi < 1e-3 || phi > Math.PI - 1e-3) return none; // straight/degenerate: nothing to round
  const half = phi / 2;
  const t = Math.min(r / Math.tan(half), inLen / 2, outLen / 2);
  const rEff = t * Math.tan(half);
  const aIn = { x: v.x - inDir.x * t, y: v.y - inDir.y * t };
  const aOut = { x: v.x + outDir.x * t, y: v.y + outDir.y * t };
  const k = rEff * (4 / 3) * Math.tan((Math.PI - phi) / 4); // arc sweep = π − φ
  return {
    aIn,
    aOut,
    arc: {
      c1: { x: aIn.x + inDir.x * k, y: aIn.y + inDir.y * k },
      c2: { x: aOut.x - outDir.x * k, y: aOut.y - outDir.y * k },
    },
  };
}

/**
 * RETAINED GEOMETRY. A layer's outline is document data, and document data is
 * frozen (the store's snapshots) — it cannot change under a cached answer. The
 * renderer asks for the same outline's commands and bounds on every draw of
 * every frame, so a 3 000-contour star field was re-compiled (and re-traced into
 * a Path2D) sixty times a second while nothing moved: a still board panned at
 * one frame a second. Frozen input → computed once per identity; anything
 * mutable (a pen draft, a tool's working copy) is simply recomputed. Cached
 * results are frozen too, so a caller that tried to edit one fails loudly
 * instead of corrupting every other reader.
 */
const commandsMemo = new WeakMap<ReadonlyArray<Contour>, PathCommand[]>();
const boundsMemo = new WeakMap<ReadonlyArray<Contour>, { b: Bounds | null }>();

/** Compile Bézier subpaths (pen tool / SVG import) to commands, applying each
 *  anchor's per-vertex corner radius. Retained per frozen outline. */
export function pathCommands(subpaths: ReadonlyArray<Contour>): PathCommand[] {
  if (!Object.isFrozen(subpaths)) return compilePathCommands(subpaths);
  let cmds = commandsMemo.get(subpaths);
  if (!cmds) {
    cmds = compilePathCommands(subpaths);
    for (const c of cmds) Object.freeze(c);
    Object.freeze(cmds);
    commandsMemo.set(subpaths, cmds);
  }
  return cmds;
}

function compilePathCommands(subpaths: ReadonlyArray<Contour>): PathCommand[] {
  const cmds: PathCommand[] = [];
  const straight = (a: PathPoint, b: PathPoint) => !a.hOut && !b.hIn;
  for (const sub of subpaths) {
    const pts = sub.points;
    const n = pts.length;
    if (n === 0) continue;

    // Resolve every vertex's fillet up front. A corner rounds only when it has a
    // radius AND both adjacent segments are straight AND it isn't an open
    // endpoint (nothing to round there) — otherwise it stays the sharp anchor.
    const fillets: CornerFillet[] = pts.map((p, i) => {
      const r = p.cornerRadius ?? 0;
      const endpoint = !sub.closed && (i === 0 || i === n - 1);
      if (r <= 0 || endpoint || n < 3) return { aIn: { x: p.x, y: p.y }, aOut: { x: p.x, y: p.y }, arc: null };
      const prev = pts[(i - 1 + n) % n]!;
      const next = pts[(i + 1) % n]!;
      if (!straight(prev, p) || !straight(p, next)) return { aIn: { x: p.x, y: p.y }, aOut: { x: p.x, y: p.y }, arc: null };
      return resolveCornerFillet(prev, p, next, r);
    });

    // Emit the segment between anchors j and (j+1): a line trims to the next
    // anchor's pulled-back start; a curve keeps its handles (its ends never round).
    const emitSegment = (j: number, i: number) => {
      const a = pts[j]!;
      const b = pts[i]!;
      if (straight(a, b)) {
        cmds.push({ type: "L", x: fillets[i]!.aIn.x, y: fillets[i]!.aIn.y });
      } else {
        const c1 = a.hOut ?? { x: a.x, y: a.y };
        const c2 = b.hIn ?? { x: b.x, y: b.y };
        cmds.push({ type: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: b.x, y: b.y });
      }
    };
    const emitArc = (i: number) => {
      const f = fillets[i]!;
      if (f.arc) cmds.push({ type: "C", x1: f.arc.c1.x, y1: f.arc.c1.y, x2: f.arc.c2.x, y2: f.arc.c2.y, x: f.aOut.x, y: f.aOut.y });
    };

    cmds.push({ type: "M", x: fillets[0]!.aOut.x, y: fillets[0]!.aOut.y });
    if (sub.closed) {
      for (let step = 1; step <= n; step++) {
        const i = step % n;
        emitSegment((i - 1 + n) % n, i);
        emitArc(i);
      }
      cmds.push({ type: "Z" });
    } else {
      for (let i = 1; i < n; i++) {
        emitSegment(i - 1, i);
        emitArc(i);
      }
    }
  }
  return cmds;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Conservative bounds of subpaths (anchors + handles; handles overestimate).
 *  Retained per frozen outline — see `pathCommands`. */
export function subpathBounds(subpaths: ReadonlyArray<Contour>): Bounds | null {
  if (!Object.isFrozen(subpaths)) return computeSubpathBounds(subpaths);
  let hit = boundsMemo.get(subpaths);
  if (!hit) {
    const b = computeSubpathBounds(subpaths);
    hit = { b: b ? Object.freeze(b) : null };
    boundsMemo.set(subpaths, hit);
  }
  return hit.b;
}

function computeSubpathBounds(subpaths: ReadonlyArray<Contour>): Bounds | null {
  let b: Bounds | null = null;
  const grow = (x: number, y: number) => {
    if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      b.minX = Math.min(b.minX, x);
      b.minY = Math.min(b.minY, y);
      b.maxX = Math.max(b.maxX, x);
      b.maxY = Math.max(b.maxY, y);
    }
  };
  for (const sub of subpaths) {
    for (const p of sub.points) {
      grow(p.x, p.y);
      if (p.hIn) grow(p.hIn.x, p.hIn.y);
      if (p.hOut) grow(p.hOut.x, p.hOut.y);
    }
  }
  return b;
}

/** Translate every point (and handle) of the subpaths in place. */
export function translateSubpaths(subpaths: ReadonlyArray<Contour>, dx: number, dy: number): void {
  for (const sub of subpaths) {
    for (const p of sub.points) {
      p.x += dx;
      p.y += dy;
      if (p.hIn) {
        p.hIn.x += dx;
        p.hIn.y += dy;
      }
      if (p.hOut) {
        p.hOut.x += dx;
        p.hOut.y += dy;
      }
    }
  }
}

/** A fresh corner point (no handles). */
export function cornerPoint(x: number, y: number): PathPoint {
  return { x, y, hIn: null, hOut: null };
}

/**
 * The vertices a corner radius can actually round: an interior corner (never an
 * open path's endpoint) whose BOTH adjacent segments are straight lines. This is
 * the exact eligibility `pathCommands` rounds by, lifted out so the inspector's
 * bulk control and any on-stage per-vertex handle round the SAME set — one brain,
 * no drift between what the UI offers and what the geometry honours.
 */
export function roundableVertices(subpaths: ReadonlyArray<Contour>): Array<{ sub: number; index: number }> {
  const out: Array<{ sub: number; index: number }> = [];
  subpaths.forEach((s, si) => {
    const n = s.points.length;
    if (n < 3) return;
    s.points.forEach((p, i) => {
      if (!s.closed && (i === 0 || i === n - 1)) return;
      const prev = s.points[(i - 1 + n) % n]!;
      const next = s.points[(i + 1) % n]!;
      // incoming (prev→p) and outgoing (p→next) both straight ⇒ a real corner.
      if (!prev.hOut && !p.hIn && !p.hOut && !next.hIn) out.push({ sub: si, index: i });
    });
  });
  return out;
}

/**
 * PER-NODE rounding, scoped by SELECTION.
 *
 * "Round these corners, not those" needs no new field and no new mode: the
 * radius already lives on the point (`PathPoint.cornerRadius`), and the nodes
 * you have selected on the canvas are the ones you mean. So the same control
 * rounds one corner or all of them depending on what is selected, which is the
 * behaviour people already expect from every other field in the panel.
 *
 * The awkward case answers itself. A vertex whose adjacent segments are CURVED
 * is not roundable — a radius has no meaning where there is no angle — and
 * `roundableVertices` has always known that, so a selection of five nodes of
 * which two are smooth simply rounds three. The inspector states that count
 * rather than silently doing less than you asked, which is the difference
 * between a rule and a mystery.
 *
 * `keys` are NODE KEYS (`"<contourId>:<pointIndex>"`) — the same addresses the
 * canvas overlay selects with. They used to be read here as
 * `"<subpathIndex>:<index>"`, which stopped matching the moment contours grew
 * ids: every scoped call quietly found nothing roundable, so selecting corners
 * and dragging the radius did nothing at all. Passing no keys means the whole
 * object (Figma's object-level rounding), which is what the control does with
 * nothing selected.
 */
export function roundableIn(
  subpaths: ReadonlyArray<Contour & { id?: string }>,
  keys?: ReadonlySet<string>,
): Array<{ sub: number; index: number }> {
  const all = roundableVertices(subpaths);
  if (!keys || keys.size === 0) return all;
  return all.filter((v) => {
    const id = subpaths[v.sub]?.id;
    return id != null && keys.has(nodeKey(id, v.index));
  });
}

/** The corner radius a bulk control DISPLAYS: the max across the roundable
 *  vertices in scope (0 when none are). Max, not min, so a mixed set still
 *  shows a non-zero value you can drag from. */
export function uniformCornerRadius(subpaths: ReadonlyArray<Contour & { id?: string }>, keys?: ReadonlySet<string>): number {
  let max = 0;
  for (const v of roundableIn(subpaths, keys)) max = Math.max(max, subpaths[v.sub]!.points[v.index]!.cornerRadius ?? 0);
  return max;
}

/** Set the corner radius on every roundable vertex IN SCOPE. Mutates in place;
 *  smooth or ineligible vertices are left untouched, and 0 clears the field so
 *  the point serialises clean. */
export function setUniformCornerRadius(subpaths: ReadonlyArray<Contour & { id?: string }>, radius: number, keys?: ReadonlySet<string>): void {
  for (const v of roundableIn(subpaths, keys)) {
    subpaths[v.sub]!.points[v.index]!.cornerRadius = radius > 0 ? radius : undefined;
  }
}

export interface PointHandleEditOptions {
  alt?: boolean;
}

/**
 * Pull handles out of an anchor — the pen's place-and-drag, and the ⌥-drag that
 * re-curves an existing node. The anchor itself does not move.
 *
 * `mirror` decides what the trailing side does: the default grows a balanced
 * pair (the classic pen drag), while `false` (⌥) leaves it exactly as it was —
 * which on a fresh point means it stays a corner, giving you a cusp.
 *
 * The old version grew the trailing handle whenever it was still missing, which
 * looked reasonable and was the source of a long-standing bug: on the FIRST
 * pointermove of a ⌥-drag the pointer is a pixel from the anchor and the side is
 * still null, so it planted a 1px stub — and from the second move on the side
 * was no longer null, so the stub never updated. You got one handle tracking the
 * pointer and a dead nub by the anchor. Whether a drag grows the trailing side
 * is a decision about the GESTURE, so it is made once by the caller, not
 * re-derived from geometry that the drag itself is changing.
 */
export function editPointHandlesFromAnchor(
  point: Pick<PathPoint, "x" | "y" | "hIn" | "hOut">,
  target: { x: number; y: number },
  mirror = true,
): void {
  point.hOut = { x: target.x, y: target.y };
  if (!mirror) return;
  const v = mirrorTangent({ x: target.x - point.x, y: target.y - point.y });
  point.hIn = { x: point.x + v.x, y: point.y + v.y };
}

/**
 * Drag a specific handle directly.
 *
 * `mirror` decides whether the partner arm comes along, balanced. The CALLER
 * works it out from the node's own state and ⌥ — see `shouldPairTangents` — so
 * that a balanced node keeps its balance on a plain drag and a broken one stays
 * broken, with ⌥ toggling either way.
 *
 * The old version always mirrored, and destructively: it forced the partner to
 * the DRAGGED arm's length, so an ordinary drag silently threw away a
 * deliberately lopsided tangent and there was no way to keep one.
 */
export function editPointHandlesFromHandle(
  point: Pick<PathPoint, "x" | "y" | "hIn" | "hOut">,
  side: "hIn" | "hOut",
  target: { x: number; y: number },
  mirror = false,
): void {
  const other = side === "hIn" ? "hOut" : "hIn";
  point[side] = { x: target.x, y: target.y };
  if (!mirror) return;
  // Handles are stored absolute; the mirror speaks in vectors from the anchor.
  const partner = mirrorTangent({ x: target.x - point.x, y: target.y - point.y });
  point[other] = { x: point.x + partner.x, y: point.y + partner.y };
}

/**
 * Figma-style auto-smooth handles for one anchor — the "make it flow" curve.
 * The tangent runs parallel to the neighbors' chord (Catmull-Rom), and each
 * side's handle length is PROPORTIONAL to the spacing of the neighbors, with NO
 * fixed clamp — so the curve stays smooth at any scale (a big shape gets big
 * handles, a tiny one gets tiny ones). This is the same math as the motion
 * path's `toggleMotionSmooth` ((next − prev)/6), lifted to path anchors.
 *
 * `prev`/`next` are the adjacent anchors (null at an OPEN path's endpoint). An
 * endpoint with a single neighbor gets a gentle mirrored handle a third of the
 * way toward it, so it still reads as smooth. Returns absolute handle positions
 * to assign onto the point; both null when the anchor is degenerate.
 */
export function autoSmoothHandles(
  cur: { x: number; y: number; z?: number },
  prev: { x: number; y: number; z?: number } | null,
  next: { x: number; y: number; z?: number } | null,
): { hIn: { x: number; y: number; z?: number } | null; hOut: { x: number; y: number; z?: number } | null } {
  // DEPTH rides the same rule as x and y — the tangent of a curve that leaves
  // its plane is a 3D tangent, so smoothing a node of a 3D stroke smooths its
  // depth too. A flat neighbourhood stays flat: no `z` is written where none
  // of the three points has one.
  const deep = cur.z !== undefined || prev?.z !== undefined || next?.z !== undefined;
  const cz = cur.z ?? 0;
  const at = (dx: number, dy: number, dz: number) => (deep ? { x: cur.x + dx, y: cur.y + dy, z: cz + dz } : { x: cur.x + dx, y: cur.y + dy });
  if (prev && next) {
    // Catmull-Rom mirror handles along the prev→next chord, length ∝ chord.
    const dx = (next.x - prev.x) / 6;
    const dy = (next.y - prev.y) / 6;
    const dz = ((next.z ?? 0) - (prev.z ?? 0)) / 6;
    if (dx === 0 && dy === 0 && dz === 0) return { hIn: null, hOut: null };
    return { hIn: at(-dx, -dy, -dz), hOut: at(dx, dy, dz) };
  }
  // Open endpoint: aim a mirrored handle a third of the way toward the lone
  // neighbor. hOut leads at the head (prev null), hIn leads at the tail.
  const n = next ?? prev;
  if (!n) return { hIn: null, hOut: null };
  const dx = (n.x - cur.x) / 3;
  const dy = (n.y - cur.y) / 3;
  const dz = ((n.z ?? 0) - cz) / 3;
  if (dx === 0 && dy === 0 && dz === 0) return { hIn: null, hOut: null };
  return next ? { hIn: at(-dx, -dy, -dz), hOut: at(dx, dy, dz) } : { hIn: at(dx, dy, dz), hOut: at(-dx, -dy, -dz) };
}

/**
 * Draft-safe deep copy of contours (structuredClone chokes on immer proxies).
 * Generic over the run type so a STORED contour copies as a stored contour —
 * `id` and `partId` ride along, which is what keeps an undo step, a morph key
 * or a duplicate pointing at the part it came from.
 */
export function copySubpaths<T extends Contour>(subpaths: ReadonlyArray<T>): T[] {
  return subpaths.map((sub) => ({
    ...sub,
    closed: sub.closed,
    points: sub.points.map(copyPathPoint),
  }));
}

/**
 * One point, deep — everything that IS the point travels: its depth, its
 * handles' depths, its corner radius, its node identity. A copy that drops
 * any of them quietly turns the point into a different one: a 3D stroke went
 * flat the first time a point was deleted from it, because this copy kept x
 * and y and nothing else.
 */
export function copyPathPoint(p: PathPoint): PathPoint {
  return {
    x: p.x,
    y: p.y,
    ...(p.z === undefined ? {} : { z: p.z }),
    hIn: copyHandle(p.hIn),
    hOut: copyHandle(p.hOut),
    ...(p.cornerRadius ? { cornerRadius: p.cornerRadius } : {}),
    ...(p.weldId == null ? {} : { weldId: p.weldId }),
  };
}

/** A handle, deep, depth included. */
export function copyHandle(h: PathPoint["hIn"] | undefined): PathPoint["hIn"] {
  return h ? { x: h.x, y: h.y, ...(h.z === undefined ? {} : { z: h.z }) } : null;
}

/**
 * THE DEPTH A HANDLE HAS — its own `z` when it carries one, else the depth a
 * STRAIGHT run would put it at: a third of the way from its anchor toward the
 * neighbour it faces. That default is what makes a curve with no handle depth
 * interpolate depth linearly between anchors (a cubic whose control values are
 * evenly spaced IS a line), exactly as paths did before handles had depth.
 */
export function handleDepth(anchor: { z?: number }, handle: { z?: number } | null | undefined, toward: { z?: number } | null | undefined): number {
  if (handle?.z !== undefined) return handle.z;
  const a = anchor.z ?? 0;
  return toward ? a + ((toward.z ?? 0) - a) / 3 : a;
}

/** Does anything in these contours leave the plane — an anchor or a handle with depth? */
export function contoursAreDeep(subpaths: ReadonlyArray<Contour>): boolean {
  return subpaths.some((c) => c.points.some((p) => !!p.z || !!p.hIn?.z || !!p.hOut?.z));
}

/**
 * Point-wise morph between two geometries — the heart of vector morphing.
 * Structures must match (same subpath count, closed flags and point counts);
 * a handle present on only one side collapses to its anchor, so corner↔smooth
 * transitions animate instead of popping. Returns null on structure mismatch
 * (the sampler holds the previous key).
 */
export function lerpSubpaths(a: ReadonlyArray<Contour>, b: ReadonlyArray<Contour>, t: number): Contour[] | null {
  if (a.length !== b.length) return null;
  const out: Contour[] = [];
  for (let s = 0; s < a.length; s++) {
    const sa = a[s]!;
    const sb = b[s]!;
    if (sa.closed !== sb.closed || sa.points.length !== sb.points.length) return null;
    const points: PathPoint[] = [];
    for (let i = 0; i < sa.points.length; i++) {
      const pa = sa.points[i]!;
      const pb = sb.points[i]!;
      const x = pa.x + (pb.x - pa.x) * t;
      const y = pa.y + (pb.y - pa.y) * t;
      const handle = (
        ha: { x: number; y: number; z?: number } | null,
        hb: { x: number; y: number; z?: number } | null,
        anchorA: { x: number; y: number; z?: number },
        anchorB: { x: number; y: number; z?: number },
      ) => {
        if (!ha && !hb) return null;
        const fa = ha ?? anchorA; // absent handle = collapsed onto its anchor
        const fb = hb ?? anchorB;
        const h: { x: number; y: number; z?: number } = { x: fa.x + (fb.x - fa.x) * t, y: fa.y + (fb.y - fa.y) * t };
        // Depth morphs only where a side has its own; elsewhere the default holds.
        if (ha?.z !== undefined || hb?.z !== undefined) {
          const za = fa.z ?? anchorA.z ?? 0;
          const zb = fb.z ?? anchorB.z ?? 0;
          h.z = za + (zb - za) * t;
        }
        return h;
      };
      // Corner radius animates like any scalar (absent == 0); so does depth.
      const cra = pa.cornerRadius ?? 0;
      const crb = pb.cornerRadius ?? 0;
      const cr = cra + (crb - cra) * t;
      const z = (pa.z ?? 0) + ((pb.z ?? 0) - (pa.z ?? 0)) * t;
      points.push({
        x,
        y,
        ...(pa.z !== undefined || pb.z !== undefined ? { z } : {}),
        hIn: handle(pa.hIn, pb.hIn, pa, pb),
        hOut: handle(pa.hOut, pb.hOut, pa, pb),
        ...(cr > 0 ? { cornerRadius: cr } : {}),
      });
    }
    out.push({ closed: sa.closed, points });
  }
  return out;
}

/**
 * The inverse of `pathCommands`: absolute M/L/C/Z back into editable subpaths.
 * This is "convert to path" — any parametric shape's outline becomes anchors
 * with handles the node editor and pen tool can take apart. A closed run whose
 * trailing point coincides with the first folds its incoming handle onto the
 * first point.
 */
export function commandsToSubpaths(cmds: PathCommand[]): Contour[] {
  const subpaths: Contour[] = [];
  let current: Contour | null = null;
  const finish = (closed: boolean) => {
    if (!current) return;
    current.closed = closed;
    if (closed && current.points.length >= 2) {
      const first = current.points[0]!;
      const last = current.points[current.points.length - 1]!;
      if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-6) {
        first.hIn = last.hIn;
        current.points.pop();
      }
    }
    if (current.points.length >= 2) subpaths.push(current);
    current = null;
  };
  for (const c of cmds) {
    if (c.type === "M") {
      finish(false);
      current = { closed: false, points: [{ x: c.x, y: c.y, hIn: null, hOut: null }] };
    } else if (c.type === "L") {
      current?.points.push({ x: c.x, y: c.y, hIn: null, hOut: null });
    } else if (c.type === "C") {
      if (!current) continue;
      const prev = current.points[current.points.length - 1]!;
      prev.hOut = { x: c.x1, y: c.y1 };
      current.points.push({ x: c.x, y: c.y, hIn: { x: c.x2, y: c.y2 }, hOut: null });
    } else {
      finish(true);
    }
  }
  finish(false);
  return subpaths;
}

/**
 * Insert an anchor at parameter `t` of the segment leaving `index` (toward the
 * next point), splitting the curve with de Casteljau so the outline doesn't
 * move — the pen tool's add-point-on-segment. Returns the new point's index.
 */
export function insertPointOnSegment(sub: Contour, index: number, t: number): number {
  const pts = sub.points;
  const a = pts[index]!;
  const b = pts[(index + 1) % pts.length]!;
  const insertAt = index + 1;
  // Depth is split with the same de Casteljau as x and y, so a point added to
  // a 3D curve lands ON it — and a flat segment writes no depth at all.
  const deep = a.z !== undefined || b.z !== undefined || a.hOut?.z !== undefined || b.hIn?.z !== undefined;
  if (!a.hOut && !b.hIn) {
    // Straight segment: a corner point on the line keeps it straight.
    const p = cornerPoint(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    if (deep) p.z = (a.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * t;
    pts.splice(insertAt, 0, p);
    return insertAt;
  }
  type P3 = { x: number; y: number; z: number };
  const p0: P3 = { x: a.x, y: a.y, z: a.z ?? 0 };
  const c1: P3 = { x: (a.hOut ?? a).x, y: (a.hOut ?? a).y, z: handleDepth(a, a.hOut, b) };
  const c2: P3 = { x: (b.hIn ?? b).x, y: (b.hIn ?? b).y, z: handleDepth(b, b.hIn, a) };
  const p1: P3 = { x: b.x, y: b.y, z: b.z ?? 0 };
  const lp = (m: P3, n: P3): P3 => ({ x: m.x + (n.x - m.x) * t, y: m.y + (n.y - m.y) * t, z: m.z + (n.z - m.z) * t });
  const q0 = lp(p0, c1);
  const q1 = lp(c1, c2);
  const q2 = lp(c2, p1);
  const r0 = lp(q0, q1);
  const r1 = lp(q1, q2);
  const s = lp(r0, r1);
  const flat = (q: P3) => (deep ? q : { x: q.x, y: q.y });
  a.hOut = flat(q0);
  b.hIn = flat(q2);
  pts.splice(insertAt, 0, { x: s.x, y: s.y, ...(deep ? { z: s.z } : {}), hIn: flat(r0), hOut: flat(r1) });
  return insertAt;
}


/**
 * THE outline a path clip shows at a clip-local time: a `geometry` morph key
 * when one owns it, otherwise the declared `subpaths`.
 *
 * One line, but it was written out at every site that needed it — the renderer,
 * the bounds pass, the node editor — and a site that forgot it edited or measured
 * an outline nobody was looking at.
 */
export function pathGeometryAt(
  clip: { subpaths: Subpath[]; shapeKeys?: ShapeKey[] },
  sampled: Record<string, unknown>,
): Subpath[] {
  // Shape keys mix on top of whatever the outline is now (declared or a morph
  // key) — BEFORE anything bends it (bones, `warpedVectorClip`), as Blender.
  // Same array back for the same weights, the base itself at none.
  return morphSubpaths(declaredOutlineAt(clip, sampled), clip.shapeKeys, sampled);
}

function declaredOutlineAt(clip: { subpaths: Subpath[] }, sampled: Record<string, unknown>): Subpath[] {
  const morph = sampled["geometry"];
  // A morph key stores contours WITHOUT identity (it is a shape at an instant,
  // not a layer), so the declared contours lend theirs positionally — which is
  // exactly the correspondence `lerpSubpaths` already requires to interpolate.
  // Without this a morphing layer's parts would all read as orphans mid-tween.
  if (!Array.isArray(morph)) return clip.subpaths;
  return lendIdentity(clip.subpaths, morph as Contour[]);
}
