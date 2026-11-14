import * as THREE from "three";
import {
  edgeKey,
  meshEdges,
  selectedEdges,
  selectedFaces,
  selectedVerts,
  triangulateFace,
  type Mat4,
  type MeshData,
  type MeshSelection,
} from "@solomotion/core";

/**
 * EDIT MODE ON SCREEN — vertices as dots (a path's nodes as the pen's squares
 * and discs, its handles as rings), edges as lines, a path's true line traced,
 * selected faces tinted, Blender's colours (black / orange). Drawn a hair toward the camera
 * in clip space so they sit on the surface they belong to instead of fighting
 * it for depth, and through everything in X-ray.
 */

const SEL = new THREE.Color("#ff8a1c");

const FACE = new THREE.Color("#ff8a1c");

const biasVertex = /* glsl */ `
  attribute vec3 color;
  varying vec3 vColor;
  uniform float uSize;
  void main() {
    vColor = color;
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    clip.z -= 0.0008 * clip.w;
    gl_Position = clip;
    gl_PointSize = uSize;
  }
`;

/**
 * Points by GLYPH (see `edit-targets` GLYPH): a mesh vertex is a dot, a path's
 * corner node a square and its smooth node a disc — the flat pen's nodes —
 * and a handle a small ring, so a node and the arm that steers it never read
 * as the same thing.
 */
const glyphVertex = /* glsl */ `
  attribute vec3 color;
  attribute float glyph;
  uniform float uDpr;
  varying vec3 vColor;
  varying float vGlyph;
  void main() {
    vColor = color;
    vGlyph = glyph;
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    clip.z -= 0.0012 * clip.w;
    gl_Position = clip;
    // CSS px, so a node is the same size on a phone as on a desktop.
    gl_PointSize = (glyph < 0.5 ? 6.0 : glyph < 2.5 ? 9.0 : 7.0) * uDpr;
  }
`;

function pointMaterial(xray: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uDpr: { value: Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1) } },
    vertexShader: glyphVertex,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vGlyph;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r2 = dot(c, c);
        if (vGlyph > 0.5 && vGlyph < 1.5) {
          // Corner node: a square with a dark rim, so it reads on any colour.
          float e = max(abs(c.x), abs(c.y));
          gl_FragColor = vec4(e > 0.36 ? vec3(0.08) : vColor, 1.0);
          return;
        }
        if (r2 > 0.25) discard;
        if (vGlyph > 2.5) {
          // Handle: a ring.
          if (r2 < 0.09) discard;
          gl_FragColor = vec4(vColor, 1.0);
          return;
        }
        gl_FragColor = vec4(vGlyph > 1.5 && r2 > 0.15 ? vec3(0.08) : vColor, 1.0);
      }
    `,
    depthTest: !xray,
    transparent: false,
  });
}

function lineMaterial(xray: boolean, opacity = 0.95): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uSize: { value: 1 }, uOpacity: { value: opacity } },
    vertexShader: biasVertex,
    fragmentShader: "uniform float uOpacity; varying vec3 vColor; void main(){ gl_FragColor = vec4(vColor, uOpacity); }",
    depthTest: !xray,
    transparent: true,
  });
}

/** What a target adds to its cage on screen (`EditTarget.shown`, `curves`, `EditCage.glyphs`). */
export interface CageDisplay {
  glyphs?: Uint8Array;
  /** Points on screen; absent = all. */
  shown?: ReadonlySet<number> | null;
  /** The real line through the nodes. */
  curves?: ReadonlyArray<{ a: number; b: number; points: ReadonlyArray<readonly [number, number, number]> }>;
}

export class EditOverlay {
  readonly group = new THREE.Group();
  private points: THREE.Points | null = null;
  private edges: THREE.LineSegments | null = null;
  private faces: THREE.Mesh | null = null;
  private curves: THREE.LineSegments | null = null;
  private key = "";
  /** Unselected points and edges: the theme's wire colour (see `WorldViewport.setTheme`). */
  private ink = new THREE.Color("#8a8a94");

  constructor() {
    this.group.renderOrder = 5;
    this.group.matrixAutoUpdate = false;
  }

  setInk(color: THREE.Color): void {
    if (this.ink.equals(color)) return;
    this.ink = color.clone();
    this.key = ""; // rebuild in the new colour on the next update
  }

  /**
   * Draw a cage: its faces' edges, its loose WIRES (a handle's arm), the real
   * line through a path's nodes, its points and its selected faces.
   */
  update(mesh: MeshData | null, wires: ReadonlyArray<readonly [number, number]>, sel: MeshSelection, matrix: Mat4 | null, xray: boolean, version: string, display: CageDisplay = {}): void {
    if (!mesh || !matrix) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.group.matrix.fromArray(matrix);
    this.group.matrixWorldNeedsUpdate = true;
    const key = `${version}|${sel.mode}|${xray}`;
    if (key === this.key) return;
    this.key = key;
    this.clear();
    const vs = selectedVerts(mesh, sel);
    const es = sel.mode === "edge" ? new Set(sel.edges) : selectedEdges(mesh, sel);
    const fs = selectedFaces(mesh, sel);
    const n = mesh.positions.length / 3;
    const shown = display.shown ?? null;
    const on = (v: number) => !shown || shown.has(v);

    // Edges: the faces' own, then the loose wires (selected when both ends are).
    const { list } = meshEdges(mesh);
    const all: Array<{ a: number; b: number; on: boolean }> = [
      ...list.map((e) => ({ a: e.a, b: e.b, on: es.has(edgeKey(e.a, e.b)) })),
      ...wires.filter(([a, b]) => on(a) && on(b)).map(([a, b]) => ({ a, b, on: vs.has(a) || vs.has(b) })),
    ];
    const ep = new Float32Array(all.length * 6);
    const ec = new Float32Array(all.length * 6);
    all.forEach((e, i) => {
      for (const [k, v] of [[0, e.a], [1, e.b]] as const) {
        ep.set([mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!], i * 6 + k * 3);
        const c = e.on ? SEL : this.ink;
        ec.set([c.r, c.g, c.b], i * 6 + k * 3);
      }
    });
    const eg = new THREE.BufferGeometry();
    eg.setAttribute("position", new THREE.BufferAttribute(ep, 3));
    eg.setAttribute("color", new THREE.BufferAttribute(ec, 3));
    this.edges = new THREE.LineSegments(eg, lineMaterial(xray));
    this.edges.frustumCulled = false;
    this.group.add(this.edges);

    // The real line through a path's nodes — what the stroke's own picture
    // shows, traced, so a line with no stroke (or a thin one) is still there
    // to aim at. Selected where both its nodes are.
    if (display.curves?.length) {
      const segs: number[] = [];
      const cols: number[] = [];
      for (const c of display.curves) {
        const col = vs.has(c.a) && vs.has(c.b) ? SEL : this.ink;
        for (let k = 0; k + 1 < c.points.length; k++) {
          segs.push(...c.points[k]!, ...c.points[k + 1]!);
          cols.push(col.r, col.g, col.b, col.r, col.g, col.b);
        }
      }
      const cg = new THREE.BufferGeometry();
      cg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segs), 3));
      cg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(cols), 3));
      this.curves = new THREE.LineSegments(cg, lineMaterial(xray, 0.7));
      this.curves.frustumCulled = false;
      this.group.add(this.curves);
    }

    // Vertices (vertex mode only, as in Blender) — the shown ones, by glyph.
    if (sel.mode === "vertex") {
      const idx: number[] = [];
      for (let i = 0; i < n; i++) if (on(i)) idx.push(i);
      const pp = new Float32Array(idx.length * 3);
      const pc = new Float32Array(idx.length * 3);
      const pg = new Float32Array(idx.length);
      idx.forEach((v, k) => {
        pp.set([mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!], k * 3);
        const c = vs.has(v) ? SEL : this.ink;
        pc.set([c.r, c.g, c.b], k * 3);
        pg[k] = display.glyphs?.[v] ?? 0;
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pp, 3));
      g.setAttribute("color", new THREE.BufferAttribute(pc, 3));
      g.setAttribute("glyph", new THREE.BufferAttribute(pg, 1));
      this.points = new THREE.Points(g, pointMaterial(xray));
      this.points.frustumCulled = false;
      this.points.renderOrder = 6;
      this.group.add(this.points);
    }

    // Selected faces, tinted.
    if (fs.size) {
      const tri: number[] = [];
      for (const f of fs) {
        const t = triangulateFace(mesh, mesh.faces[f]!);
        for (const v of t) tri.push(mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!);
      }
      const fg = new THREE.BufferGeometry();
      fg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tri), 3));
      this.faces = new THREE.Mesh(
        fg,
        new THREE.MeshBasicMaterial({ color: FACE, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      );
      this.faces.frustumCulled = false;
      this.group.add(this.faces);
    }
  }

  private clear(): void {
    for (const o of [this.points, this.edges, this.faces, this.curves]) {
      if (!o) continue;
      this.group.remove(o);
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.points = this.edges = this.faces = this.curves = null;
  }

  dispose(): void {
    this.clear();
  }
}
