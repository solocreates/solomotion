import * as THREE from "three";
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from "three-bvh-csg";

/**
 * BOOLEANS IN 3D — a group's composite mode, carried into space. The same
 * group that unions, subtracts or intersects flat shapes does it to solids:
 * the members marked as cutters (the stencil role the 2D booleans already
 * use — the topmost member by default) cut the rest. Live, like Blender's
 * Boolean modifier: move a cutter and the hole follows.
 */

const OPS = { union: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION } as const;
export type BooleanMode = keyof typeof OPS;
export const isBooleanMode = (m: string): m is BooleanMode => m in OPS;

const evaluator = new Evaluator();
evaluator.attributes = ["position", "normal"];
evaluator.useGroups = false;
/** A union that keeps each member's own look: the result carries one group per material. */
const grouped = new Evaluator();
grouped.attributes = ["position", "normal"];
grouped.useGroups = true;

export interface BooleanInput {
  geometry: THREE.BufferGeometry;
  /** The member's matrix in world units. */
  matrix: number[];
  /** Its own material — kept on its part of a union (skin stays skin, an eye's white stays white). */
  material?: THREE.Material;
}

function brush(m: BooleanInput): Brush {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", m.geometry.getAttribute("position"));
  g.setAttribute("normal", m.geometry.getAttribute("normal"));
  if (m.geometry.index) g.setIndex(m.geometry.index);
  const b = m.material ? new Brush(g, m.material) : new Brush(g);
  b.matrixAutoUpdate = false;
  b.matrix.fromArray(m.matrix);
  b.updateMatrixWorld(true);
  return b;
}

/**
 * A result's geometry in WORLD units. The solver leaves it in its first
 * brush's frame and hands that frame to the result brush; reading only the
 * geometry would drop the transform (a union whose base stands at z 120 drawn
 * at 0). Cloned, so a lone member's own buffers are never moved.
 */
function inWorld(b: Brush): THREE.BufferGeometry {
  b.updateMatrixWorld(true);
  const g = b.geometry.clone();
  g.applyMatrix4(b.matrixWorld);
  return g;
}

function combine(list: BooleanInput[]): Brush | null {
  let acc: Brush | null = null;
  for (const m of list) acc = acc ? evaluator.evaluate(acc, brush(m), ADDITION) : brush(m);
  return acc;
}

/**
 * A UNION THAT KEEPS ITS PARTS' LOOKS — the merged solid with one geometry
 * group per member material, and those materials in group order. Eyes set
 * into a head stay eyes (their own white, their own iris) while the surface
 * is one: no inner faces, and one outline around the whole.
 */
export function unionKeepingLooks(members: BooleanInput[]): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } | null {
  try {
    let acc: Brush | null = null;
    for (const m of members) acc = acc ? grouped.evaluate(acc, brush(m), ADDITION) : brush(m);
    if (!acc) return null;
    const mats = Array.isArray(acc.material) ? acc.material : [acc.material];
    return { geometry: inWorld(acc), materials: mats as THREE.Material[] };
  } catch {
    return null;
  }
}

/**
 * Weld a triangle soup by position into a mesh with faces that SHARE their
 * vertices — what line art needs to tell a silhouette or a crease from the
 * edge of every triangle. Positions within `eps` are one vertex.
 */
export function weldToMesh(geometry: THREE.BufferGeometry, eps = 1e-3): { positions: number[]; faces: number[][] } {
  const pos = geometry.getAttribute("position");
  const index = geometry.index;
  const map = new Map<string, number>();
  const positions: number[] = [];
  const idOf = (i: number) => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    let id = map.get(k);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(x, y, z);
      map.set(k, id);
    }
    return id;
  };
  const faces: number[][] = [];
  const n = index ? index.count : pos.count;
  for (let t = 0; t + 2 < n; t += 3) {
    const a = idOf(index ? index.getX(t) : t), b = idOf(index ? index.getX(t + 1) : t + 1), c = idOf(index ? index.getX(t + 2) : t + 2);
    if (a !== b && b !== c && a !== c) faces.push([a, b, c]);
  }
  return { positions, faces };
}

/**
 * The result, in world units: everything kept, with the cutters applied.
 * `union` merges all of them; `subtract` takes the cutters away from the
 * rest; `intersect` keeps only where the two overlap. Null when the inputs
 * cannot make one (a side is empty, or the solver gave up on a bad mesh).
 */
export function booleanGeometry(mode: BooleanMode, kept: BooleanInput[], cutters: BooleanInput[]): THREE.BufferGeometry | null {
  try {
    if (mode === "union") {
      const all = combine([...kept, ...cutters]);
      return all ? inWorld(all) : null;
    }
    const a = combine(kept);
    const b = combine(cutters);
    if (!a || !b) return a ? inWorld(a) : null;
    return inWorld(evaluator.evaluate(a, b, OPS[mode]));
  } catch {
    return null;
  }
}
