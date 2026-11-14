import type { Contour, PathPoint } from "../schema/vector";

/**
 * SVG path-data parser: the full `d` grammar (M/L/H/V/C/S/Q/T/A/Z, absolute
 * and relative) compiled into editor subpaths. Quadratics become their exact
 * cubic; arcs are flattened to cubic segments. Pure string → data, so it runs
 * anywhere (import UI, tests, future native adapters).
 */

export function parseSvgPathData(d: string): Contour[] {
  const tokens = tokenize(d);
  const subpaths: Contour[] = [];

  let current: Contour | null = null;
  let cx = 0; // current position
  let cy = 0;
  let sx = 0; // subpath start
  let sy = 0;
  let lastCmd = "";
  // Reflection state for S/T — an object so closure writes stay visible to CFA.
  const ref: { c2: { x: number; y: number } | null; q: { x: number; y: number } | null } = {
    c2: null,
    q: null,
  };

  let i = 0;
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || typeof t !== "number") throw new Error("Bad path data: expected number");
    return t;
  };
  const flag = () => {
    const v = num();
    return v !== 0;
  };

  const ensure = (): Contour => {
    if (!current) {
      current = { closed: false, points: [pt(cx, cy)] };
      subpaths.push(current);
    }
    return current;
  };
  const lastPoint = (): PathPoint => {
    const sub = ensure();
    return sub.points[sub.points.length - 1]!;
  };
  const lineTo = (x: number, y: number) => {
    ensure().points.push(pt(x, y));
    cx = x;
    cy = y;
  };
  const cubicTo = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    lastPoint().hOut = { x: x1, y: y1 };
    ensure().points.push({ x, y, hIn: { x: x2, y: y2 }, hOut: null });
    ref.c2 = { x: x2, y: y2 };
    cx = x;
    cy = y;
  };

  while (i < tokens.length) {
    const t = tokens[i];
    let cmd: string;
    if (typeof t === "string") {
      cmd = t;
      i++;
    } else {
      // Implicit repeat; M repeats as L per spec.
      cmd = lastCmd === "M" ? "L" : lastCmd === "m" ? "l" : lastCmd;
      if (!cmd) throw new Error("Bad path data: number before any command");
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    switch (C) {
      case "M": {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        cx = x;
        cy = y;
        sx = x;
        sy = y;
        current = { closed: false, points: [pt(x, y)] };
        subpaths.push(current);
        break;
      }
      case "L": {
        lineTo(num() + (rel ? cx : 0), num() + (rel ? cy : 0));
        break;
      }
      case "H": {
        lineTo(num() + (rel ? cx : 0), cy);
        break;
      }
      case "V": {
        lineTo(cx, num() + (rel ? cy : 0));
        break;
      }
      case "C": {
        const x1 = num() + (rel ? cx : 0);
        const y1 = num() + (rel ? cy : 0);
        const x2 = num() + (rel ? cx : 0);
        const y2 = num() + (rel ? cy : 0);
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        cubicTo(x1, y1, x2, y2, x, y);
        break;
      }
      case "S": {
        const x2 = num() + (rel ? cx : 0);
        const y2 = num() + (rel ? cy : 0);
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        const reflect =
          (lastCmd.toUpperCase() === "C" || lastCmd.toUpperCase() === "S") && ref.c2
            ? { x: 2 * cx - ref.c2.x, y: 2 * cy - ref.c2.y }
            : { x: cx, y: cy };
        cubicTo(reflect.x, reflect.y, x2, y2, x, y);
        break;
      }
      case "Q": {
        const qx = num() + (rel ? cx : 0);
        const qy = num() + (rel ? cy : 0);
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        quadTo(qx, qy, x, y);
        break;
      }
      case "T": {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        const q =
          (lastCmd.toUpperCase() === "Q" || lastCmd.toUpperCase() === "T") && ref.q
            ? { x: 2 * cx - ref.q.x, y: 2 * cy - ref.q.y }
            : { x: cx, y: cy };
        quadTo(q.x, q.y, x, y);
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const largeArc = flag();
        const sweep = flag();
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        for (const seg of arcToCubics(cx, cy, x, y, rx, ry, rot, largeArc, sweep)) {
          cubicTo(seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y);
        }
        cx = x;
        cy = y;
        break;
      }
      case "Z": {
        if (current) {
          const first = current.points[0]!;
          const last = current.points[current.points.length - 1]!;
          // A trailing point identical to the start folds into it (its hIn
          // becomes the closing segment's incoming handle).
          if (current.points.length > 1 && Math.hypot(last.x - first.x, last.y - first.y) < 0.01) {
            first.hIn = last.hIn;
            current.points.pop();
          }
          current.closed = true;
        }
        cx = sx;
        cy = sy;
        current = null;
        break;
      }
      default:
        throw new Error(`Bad path data: unknown command "${cmd}"`);
    }
    lastCmd = cmd;
    if (C !== "C" && C !== "S") ref.c2 = null;
    if (C !== "Q" && C !== "T") ref.q = null;
  }

  return subpaths.filter((s) => s.points.length > 1 || s.closed);

  function quadTo(qx: number, qy: number, x: number, y: number) {
    // Exact quadratic → cubic elevation.
    cubicTo(
      cx + (2 / 3) * (qx - cx),
      cy + (2 / 3) * (qy - cy),
      x + (2 / 3) * (qx - x),
      y + (2 / 3) * (qy - y),
      x,
      y,
    );
    ref.q = { x: qx, y: qy };
  }
}

function pt(x: number, y: number): PathPoint {
  return { x, y, hIn: null, hOut: null };
}

function tokenize(d: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) out.push(m[1]);
    else out.push(parseFloat(m[2]!));
  }
  return out;
}

interface CubicSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x: number;
  y: number;
}

/** Endpoint-parameterized elliptical arc → cubic segments (SVG F.6). */
function arcToCubics(
  x0: number,
  y0: number,
  x: number,
  y: number,
  rx: number,
  ry: number,
  rotDeg: number,
  largeArc: boolean,
  sweep: boolean,
): CubicSeg[] {
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) {
    return [{ x1: x0, y1: y0, x2: x, y2: y, x, y }];
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);

  // F.6.5: to center parameterization.
  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;

  let rxs = rx * rx;
  let rys = ry * ry;
  const lambda = (x1p * x1p) / rxs + (y1p * y1p) / rys;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    rxs = rx * rx;
    rys = ry * ry;
  }

  const sign = largeArc !== sweep ? 1 : -1;
  const sq = Math.max(0, (rxs * rys - rxs * y1p * y1p - rys * x1p * x1p) / (rxs * y1p * y1p + rys * x1p * x1p));
  const coef = sign * Math.sqrt(sq);
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1))));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  // Split into ≤90° segments.
  const segCount = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / segCount;
  const t = ((4 / 3) * Math.tan(delta / 4));

  const out: CubicSeg[] = [];
  let theta = theta1;
  let px = x0;
  let py = y0;
  for (let s = 0; s < segCount; s++) {
    const theta2 = theta + delta;
    const cos1 = Math.cos(theta);
    const sin1 = Math.sin(theta);
    const cos2 = Math.cos(theta2);
    const sin2 = Math.sin(theta2);
    const ex = cosP * rx * cos2 - sinP * ry * sin2 + cx;
    const ey = sinP * rx * cos2 + cosP * ry * sin2 + cy;
    const d1x = -rx * sin1 * t;
    const d1y = ry * cos1 * t;
    const d2x = rx * sin2 * t;
    const d2y = -ry * cos2 * t;
    out.push({
      x1: px + cosP * d1x - sinP * d1y,
      y1: py + sinP * d1x + cosP * d1y,
      x2: ex + cosP * d2x - sinP * d2y,
      y2: ey + sinP * d2x + cosP * d2y,
      x: ex,
      y: ey,
    });
    theta = theta2;
    px = ex;
    py = ey;
  }
  return out;
}
