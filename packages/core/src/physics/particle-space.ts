import * as CANNON from "cannon-es";

/**
 * WHERE PARTICLES MEET THINGS — a flat comp's colliders as 2D segments,
 * circles and walls in a uniform grid, rebuilt from the solver's bodies each
 * step that has particles.
 *
 * Not cannon's raycast: it tests every face of every body whose box holds the
 * ray, and a ring's box holds everything inside it — a ball pit of sparks in
 * an edge ring was 400 face tests per particle per step (five seconds for one
 * burst). Here a sweep visits the one or two cells it crosses and the handful
 * of segments in them. Same shapes as the bodies collide with (read off the
 * cannon shapes, so there is no second description to drift), comp units.
 *
 * One way, like every particle contact: only a surface a particle is ENTERING
 * counts (its outward normal against the motion), so one born inside a solid
 * leaves it instead of rattling about inside.
 */

const M = 0.01;
const CELL = 48;

export interface SpaceHit {
  /** 0..1 along the sweep. */
  t: number;
  x: number;
  y: number;
  nx: number;
  ny: number;
  body: CANNON.Body | null;
}

export class ParticleSpace {
  // Segments: ax, ay, bx, by, nx, ny (outward) — and their body.
  private seg: number[] = [];
  private segBody: (CANNON.Body | null)[] = [];
  // Circles: cx, cy, r.
  private circ: number[] = [];
  private circBody: CANNON.Body[] = [];
  // Walls: px, py, nx, ny (into the world).
  private walls: number[] = [];
  private wallBody: CANNON.Body[] = [];
  private grid = new Map<number, number[]>();
  private stamp = new Int32Array(0);
  private query = 0;

  /** Every body in the world where this step left it. */
  rebuild(world: CANNON.World): void {
    this.seg.length = this.segBody.length = this.circ.length = this.circBody.length = this.walls.length = this.wallBody.length = 0;
    this.grid.clear();
    for (const body of world.bodies) {
      const angle = 2 * Math.atan2(body.quaternion.z, body.quaternion.w);
      const c = Math.cos(angle), s = Math.sin(angle);
      const bx = body.position.x / M, by = body.position.y / M;
      const toWorld = (x: number, y: number): [number, number] => [bx + x * c - y * s, by + x * s + y * c];
      body.shapes.forEach((shape, i) => {
        const o = body.shapeOffsets[i]!;
        const ox = o.x / M, oy = o.y / M;
        if (shape instanceof CANNON.Plane) {
          const n = body.quaternion.vmult(new CANNON.Vec3(0, 0, 1));
          if (Math.abs(n.z) > 0.9) return;
          const l = Math.hypot(n.x, n.y);
          this.walls.push(bx, by, n.x / l, n.y / l);
          this.wallBody.push(body);
        } else if (shape instanceof CANNON.Sphere) {
          const [x, y] = toWorld(ox, oy);
          this.addCircle(x, y, shape.radius / M, body);
        } else if (shape instanceof CANNON.Box) {
          const h = shape.halfExtents;
          const hx = h.x / M, hy = h.y / M;
          this.addPolygon([toWorld(ox - hx, oy - hy), toWorld(ox + hx, oy - hy), toWorld(ox + hx, oy + hy), toWorld(ox - hx, oy + hy)], body);
        } else if (shape instanceof CANNON.ConvexPolyhedron) {
          // A planar prism: its first ring is the polygon (see the solver's `shapeOf`).
          const ring = shape.vertices.slice(0, shape.vertices.length / 2);
          this.addPolygon(ring.map((v) => toWorld(ox + v.x / M, oy + v.y / M)), body);
        }
      });
    }
    if (this.stamp.length < this.segBody.length + this.circBody.length) this.stamp = new Int32Array((this.segBody.length + this.circBody.length) * 2);
  }

  private addPolygon(pts: Array<[number, number]>, body: CANNON.Body): void {
    const n = pts.length;
    if (n < 2) return;
    let cx = 0, cy = 0;
    for (const p of pts) (cx += p[0] / n), (cy += p[1] / n);
    for (let i = 0; i < n; i++) {
      const a = pts[i]!, b = pts[(i + 1) % n]!;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dx, dy);
      if (l < 1e-9) continue;
      // Outward: away from the (convex) piece's centre.
      let nx = dy / l, ny = -dx / l;
      if ((a[0] - cx) * nx + (a[1] - cy) * ny < 0) (nx = -nx), (ny = -ny);
      const k = this.segBody.length;
      this.seg.push(a[0], a[1], b[0], b[1], nx, ny);
      this.segBody.push(body);
      this.insert(k, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
    }
  }

  private addCircle(x: number, y: number, r: number, body: CANNON.Body): void {
    const k = this.circBody.length;
    this.circ.push(x, y, r);
    this.circBody.push(body);
    // Circles share the grid with segments, past them in the index.
    this.insert(-(k + 1), x - r, y - r, x + r, y + r);
  }

  private insert(k: number, x0: number, y0: number, x1: number, y1: number): void {
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iy = Math.floor(y0 / CELL); iy <= Math.floor(y1 / CELL); iy++) {
        const key = cellKey(ix, iy);
        const list = this.grid.get(key);
        if (list) list.push(k);
        else this.grid.set(key, [k]);
      }
    }
  }

  /** The first surface a sweep from (x, y) by (dx, dy) enters, or null. */
  sweep(x: number, y: number, dx: number, dy: number): SpaceHit | null {
    let best: SpaceHit | null = null;
    const q = ++this.query;
    const nSeg = this.segBody.length;
    const x1 = x + dx, y1 = y + dy;
    for (let ix = Math.floor(Math.min(x, x1) / CELL); ix <= Math.floor(Math.max(x, x1) / CELL); ix++) {
      for (let iy = Math.floor(Math.min(y, y1) / CELL); iy <= Math.floor(Math.max(y, y1) / CELL); iy++) {
        const list = this.grid.get(cellKey(ix, iy));
        if (!list) continue;
        for (const k of list) {
          const slot = k >= 0 ? k : nSeg - k - 1;
          if (this.stamp[slot] === q) continue;
          this.stamp[slot] = q;
          const h = k >= 0 ? this.segHit(k, x, y, dx, dy) : this.circleHit(-k - 1, x, y, dx, dy);
          if (h && (!best || h.t < best.t)) best = h;
        }
      }
    }
    for (let w = 0; w < this.wallBody.length; w++) {
      const o = w * 4;
      const nx = this.walls[o + 2]!, ny = this.walls[o + 3]!;
      const along = dx * nx + dy * ny;
      if (along >= 0) continue;
      const d0 = (x - this.walls[o]!) * nx + (y - this.walls[o + 1]!) * ny;
      const t = -d0 / along;
      if (t < 0 || t > 1 || (best && t >= best.t)) continue;
      best = { t: Math.max(0, t), x: x + dx * t, y: y + dy * t, nx, ny, body: this.wallBody[w]! };
    }
    return best;
  }

  private segHit(k: number, x: number, y: number, dx: number, dy: number): SpaceHit | null {
    const o = k * 6;
    const ax = this.seg[o]!, ay = this.seg[o + 1]!, ex = this.seg[o + 2]! - ax, ey = this.seg[o + 3]! - ay;
    const nx = this.seg[o + 4]!, ny = this.seg[o + 5]!;
    if (dx * nx + dy * ny >= 0) return null;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) return null;
    const wx = ax - x, wy = ay - y;
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * dy - wy * dx) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { t, x: x + dx * t, y: y + dy * t, nx, ny, body: this.segBody[k]! };
  }

  private circleHit(k: number, x: number, y: number, dx: number, dy: number): SpaceHit | null {
    const o = k * 3;
    const cx = this.circ[o]!, cy = this.circ[o + 1]!, r = this.circ[o + 2]!;
    const fx = x - cx, fy = y - cy;
    const c = fx * fx + fy * fy - r * r;
    if (c < 0) return null; // inside: it is leaving
    const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy);
    if (b >= 0) return null;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0 || t > 1) return null;
    const hx = x + dx * t, hy = y + dy * t;
    return { t, x: hx, y: hy, nx: (hx - cx) / r, ny: (hy - cy) / r, body: this.circBody[k]! };
  }
}

const cellKey = (ix: number, iy: number) => (ix + 32768) * 65536 + (iy + 32768);
